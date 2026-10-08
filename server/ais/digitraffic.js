// Digitraffic (Fintraffic) marine AIS source: open data (CC BY 4.0, "Source: Fintraffic / digitraffic.fi"), no key.
// The Finnish AIS network covers the Baltic Sea, the Gulf of Finland and Bothnia and the approaches.
//   GET /api/ais/v1/locations?from=<ms>  → GeoJSON FeatureCollection; properties {mmsi, sog, cog, navStat, rot, posAcc,
//                                          raim, heading, timestamp, timestampExternal}; geometry.coordinates [lon, lat]
//   GET /api/ais/v1/vessels?from=<ms>     → [{mmsi, name, callSign, imo, shipType, draught (dm), destination, eta (packed),
//                                          referencePointA/B/C/D, posType, timestamp}] — metadata CHANGED since `from`
//                                          (without `from` only the last day: ~860 records vs ~6 700 for a year, 2026-10).
//                                          The first poll asks for a year (2.2 MB), later ones only for what changed since.
// Required headers: 'Digitraffic-User' and 'Accept-Encoding: gzip'. The network tracks ~900 vessels at a time.
import { decodeRot, decodePackedEta, draughtFromDm, cleanText, cleanName } from './store.js';

export const DIGITRAFFIC_BASE = 'https://meri.digitraffic.fi/api/ais/v1';
export const DIGITRAFFIC_USER = 'Saltline/0.5';

const num = (x) => (x == null || x === '' ? null : Number.isFinite(Number(x)) ? Number(x) : null);

/** Locations FeatureCollection → position records for the store. */
export function parseLocations(fc, nowMs = Date.now()) {
  const out = [];
  const feats = fc && Array.isArray(fc.features) ? fc.features : Array.isArray(fc) ? fc : [];
  for (const f of feats) {
    const p = f && f.properties; const g = f && f.geometry;
    if (!p) continue;
    const mmsi = num(p.mmsi ?? f.mmsi);
    const c = g && Array.isArray(g.coordinates) ? g.coordinates : null;
    if (!mmsi || !c) continue;
    const t = num(p.timestampExternal) ?? nowMs;
    out.push({ kind: 'pos', mmsi, lat: num(c[1]), lon: num(c[0]), sog: num(p.sog), cog: num(p.cog), heading: num(p.heading),
      rot: decodeRot(p.rot), nav: num(p.navStat), t, src: 'digitraffic', classB: false });
  }
  return out;
}

/** Vessels metadata array → static records for the store. */
export function parseVessels(arr, nowMs = Date.now()) {
  const out = [];
  for (const v of Array.isArray(arr) ? arr : []) {
    const mmsi = num(v && v.mmsi);
    if (!mmsi) continue;
    out.push({ kind: 'static', mmsi, name: cleanName(v.name), callsign: cleanText(v.callSign), imo: num(v.imo), aisType: num(v.shipType),
      A: num(v.referencePointA), B: num(v.referencePointB), C: num(v.referencePointC), D: num(v.referencePointD),
      draught: draughtFromDm(v.draught), destination: cleanText(v.destination) ?? '', eta: decodePackedEta(v.eta, nowMs),
      t: num(v.timestamp) ?? nowMs, src: 'digitraffic' });
  }
  return out;
}

export class DigitrafficSource {
  /**
   * @param {{store, log?, fetchImpl?, now?, timers?, base?, locationsMs?, vesselsMs?, timeoutMs?, user?, firstWindowMs?, offline?}} o
   */
  constructor(o = {}) {
    this.store = o.store; this.log = o.log || (() => {});
    this.fetchImpl = o.fetchImpl || globalThis.fetch;
    this.now = o.now || (() => Date.now());
    this.timers = o.timers || globalThis;
    this.base = o.base || DIGITRAFFIC_BASE;
    this.locationsMs = o.locationsMs ?? 20000; this.vesselsMs = o.vesselsMs ?? 30 * 60e3; this.timeoutMs = o.timeoutMs ?? 30000;
    this.firstWindowMs = o.firstWindowMs ?? 2 * 3600e3; // first poll: 2 h of reports (moored vessels are kept that long)
    this.metadataWindowMs = o.metadataWindowMs ?? 365 * 86400e3; // metadata changed within a year ≈ every active vessel
    this.user = o.user || DIGITRAFFIC_USER;
    this.offline = o.offline ?? process.env.SALTLINE_OFFLINE === '1';
    this.enabled = false; this.running = false;
    this.locTimer = null; this.vesTimer = null;
    this.lastOkStart = 0; this.lastOk = 0; this.lastVesselsOk = 0; this.lastVesselsStart = 0; this.metaSeen = new Set();
    this.msgs = 0; this.lastMsg = 0; this.polls = 0; this.failures = 0; this.vesselFailures = 0; this.metaCount = 0; this.lastError = null;
    this.inflight = { loc: false, ves: false };
  }
  set(fn, ms) { const h = this.timers.setTimeout(fn, ms); if (h && h.unref) h.unref(); return h; }
  clear(h) { if (h) this.timers.clearTimeout(h); }

  start() {
    if (this.running) return this;
    if (this.offline) { this.enabled = false; this.log('[ais] Digitraffic disabled (SALTLINE_OFFLINE=1)'); return this; }
    if (typeof this.fetchImpl !== 'function') { this.enabled = false; this.log('[ais] Digitraffic disabled: no fetch'); return this; }
    this.enabled = true; this.running = true;
    this.pollVessels();
    this.pollLocations();
    return this;
  }
  stop() {
    this.running = false;
    this.clear(this.locTimer); this.clear(this.vesTimer); this.locTimer = this.vesTimer = null;
  }

  async getJson(path) {
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const to = ac ? this.set(() => ac.abort(), this.timeoutMs) : null;
    try {
      const res = await this.fetchImpl(this.base + path, {
        headers: { 'Digitraffic-User': this.user, 'Accept-Encoding': 'gzip', Accept: 'application/json' },
        signal: ac ? ac.signal : undefined,
      });
      if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : '?'}`);
      return await res.json();
    } finally { this.clear(to); }
  }

  async pollLocations() {
    this.locTimer = null;
    if (!this.running || this.inflight.loc) return;
    this.inflight.loc = true;
    const start = this.now();
    const from = this.lastOkStart ? Math.max(this.lastOkStart - 5000, start - this.firstWindowMs) : start - this.firstWindowMs;
    let next = this.locationsMs;
    try {
      const fc = await this.getJson(`/locations?from=${Math.round(from)}`);
      const now = this.now();
      const recs = parseLocations(fc, now);
      let n = 0;
      for (const r of recs) if (this.store.upsertPosition(r.mmsi, r, now)) n++;
      this.msgs += recs.length; this.polls++;
      if (recs.length) this.lastMsg = now;
      this.lastOkStart = start; this.lastOk = now;
      if (this.failures >= 3) this.log(`[ais] Digitraffic recovered after ${this.failures} failures`);
      this.failures = 0; this.lastError = null;
      if (this.polls === 1) this.log(`[ais] Digitraffic: ${recs.length} positions (${n} accepted) in the first poll`);
    } catch (e) {
      this.failures++; this.lastError = e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || String(e);
      next = Math.min(300000, this.locationsMs * 2 ** Math.min(this.failures, 4));
      if (this.failures === 1 || this.failures % 10 === 0) this.log(`[ais] Digitraffic locations failed (${this.lastError}); retry in ${Math.round(next / 1000)} s`);
    } finally {
      this.inflight.loc = false;
      if (this.running) this.locTimer = this.set(() => this.pollLocations(), next);
    }
  }

  async pollVessels() {
    this.vesTimer = null;
    if (!this.running || this.inflight.ves) return;
    this.inflight.ves = true;
    let next = this.vesselsMs;
    const start = this.now();
    // first poll: every vessel whose metadata changed within a year; then only the changes since the last good poll
    const from = this.lastVesselsStart ? this.lastVesselsStart - 60e3 : start - this.metadataWindowMs;
    try {
      const arr = await this.getJson(`/vessels?from=${Math.round(from)}`);
      const now = this.now();
      const recs = parseVessels(arr, now);
      for (const r of recs) { this.store.upsertStatic(r.mmsi, r, now); this.metaSeen.add(r.mmsi); }
      this.metaCount = this.metaSeen.size; this.lastVesselsOk = now; this.lastVesselsStart = start; this.vesselFailures = 0;
    } catch (e) {
      this.vesselFailures++;
      next = Math.min(this.vesselsMs, 60000 * 2 ** Math.min(this.vesselFailures, 5));
      if (this.vesselFailures === 1 || this.vesselFailures % 10 === 0) this.log(`[ais] Digitraffic vessels failed (${(e && e.message) || e}); retry in ${Math.round(next / 1000)} s`);
    } finally {
      this.inflight.ves = false;
      if (this.running) this.vesTimer = this.set(() => this.pollVessels(), next);
    }
  }

  stats() {
    const now = this.now();
    return { enabled: this.enabled, connected: this.enabled && this.lastOk > 0 && now - this.lastOk < this.locationsMs * 3 + this.timeoutMs,
      msgs: this.msgs, lastMsg: this.lastMsg || null, polls: this.polls, failures: this.failures, metadata: this.metaCount,
      lastMetadata: this.lastVesselsOk || null, lastError: this.lastError, attribution: 'Fintraffic / digitraffic.fi, CC BY 4.0' };
  }
}
