// Live AIS: real vessels from AISStream.io (global, API key) and Digitraffic (Baltic, open data) in one table.
//
//   const ais = new LiveAis({ log, harbors: HARBORS }); ais.start();
//   ais.setInterest(onlinePlayers.map((p) => ({ lat: p.ship.lat, lon: p.ship.lon })));   // every few seconds
//   ais.near(lat, lon, 40000)          → AisPublic[] (dead-reckoned to now, nearest first) — for snapshots
//   ais.bbox(latMin, lonMin, latMax, lonMax) → AisPublic[] (decimated over the limit) — for the chart
//   ais.get(mmsi)                      → AisPublic + {track, static, from, to, etaText} — for a ship info panel
//   ais.covers(lat, lon)               → true where live traffic is dense enough to switch synthetic AI traffic off
//   ais.stats()                        → {vessels, sources, coverage}
//
// Both sources are optional; with neither (no key, SALTLINE_OFFLINE=1, no network) the table simply stays empty.
import { AisStore } from './store.js';
import { createPortIndex } from './ports.js';
import { AisStreamSource } from './aisstream.js';
import { DigitrafficSource } from './digitraffic.js';

export { AisStore } from './store.js';

const COVER = { RANGE_M: 30000, FRESH_MS: 10 * 60e3, MIN_VESSELS: 3, CACHE_MS: 15000 };

export class LiveAis {
  /**
   * @param {{log?, harbors?, fetchImpl?, WebSocketImpl?, now?: () => number, timers?, apiKey?, keyFile?, env?,
   *          sources?: {aisstream?: boolean|object, digitraffic?: boolean|object}, offline?: boolean, pruneMs?: number}} o
   */
  constructor({ log, harbors, fetchImpl, WebSocketImpl, now, timers, apiKey, keyFile, env, sources = {}, offline, pruneMs = 30000 } = {}) {
    this.log = log || (() => {});
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.timers = timers || globalThis;
    this.offline = offline ?? (env || process.env).SALTLINE_OFFLINE === '1';
    this.ports = createPortIndex(harbors);
    this.store = new AisStore({ ports: this.ports, now: this.now });
    this.pruneMs = pruneMs; this.pruneTimer = null; this.started = false;
    this.coverCache = new Map();
    const common = { store: this.store, log: this.log, now: this.now, timers: this.timers, offline: this.offline };
    const opt = (x) => (x && typeof x === 'object' ? x : {});
    this.sources = {};
    if (sources.aisstream !== false) {
      this.sources.aisstream = new AisStreamSource({ ...common, WebSocketImpl, apiKey, keyFile, env, ...opt(sources.aisstream) });
    }
    if (sources.digitraffic !== false) {
      this.sources.digitraffic = new DigitrafficSource({ ...common, fetchImpl, ...opt(sources.digitraffic) });
    }
  }

  start() {
    if (this.started) return this;
    this.started = true;
    if (this.offline) { this.log('[ais] live AIS offline (SALTLINE_OFFLINE=1): no sources'); return this; }
    for (const s of Object.values(this.sources)) { try { s.start(); } catch (e) { this.log('[ais] source start failed', e.message); } }
    const tick = () => { try { this.store.prune(this.now()); } catch (e) { this.log('[ais] prune failed', e.message); } this.pruneTimer = this.set(tick, this.pruneMs); };
    this.pruneTimer = this.set(tick, this.pruneMs);
    return this;
  }
  stop() {
    this.started = false;
    if (this.pruneTimer) this.timers.clearTimeout(this.pruneTimer);
    this.pruneTimer = null;
    for (const s of Object.values(this.sources)) { try { s.stop(); } catch { /* ignore */ } }
  }
  set(fn, ms) { const h = this.timers.setTimeout(fn, ms); if (h && h.unref) h.unref(); return h; }

  /** Points of interest (online players): AISStream subscribes to the detail region plus a box around each. */
  setInterest(points) {
    const a = this.sources.aisstream;
    if (a) a.setInterest(Array.isArray(points) ? points : []);
  }

  near(lat, lon, rangeM, opts = {}) { return this.store.near(lat, lon, rangeM, { ...opts, now: this.now() }); }
  bbox(latMin, lonMin, latMax, lonMax, opts = {}) { return this.store.bbox(latMin, lonMin, latMax, lonMax, { ...opts, now: this.now() }); }
  get(mmsi) {
    const m = typeof mmsi === 'string' ? Number(mmsi.replace(/^ais/, '')) : Number(mmsi);
    return this.store.get(m, this.now());
  }

  /** True when a live source delivered ≥ 3 vessels within 30 km in the last 10 min (cached 15 s per 0.1° cell). */
  covers(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || this.store.size === 0) return false;
    const now = this.now();
    const k = Math.round(lat * 10) * 4000 + Math.round(lon * 10);
    const c = this.coverCache.get(k);
    if (c && now - c.t < COVER.CACHE_MS) return c.v;
    const v = this.store.countFresh(lat, lon, COVER.RANGE_M, now - COVER.FRESH_MS) >= COVER.MIN_VESSELS;
    if (this.coverCache.size > 50000) this.coverCache.clear();
    this.coverCache.set(k, { t: now, v });
    return v;
  }

  stats() {
    const now = this.now();
    const sources = {};
    for (const [k, s] of Object.entries(this.sources)) sources[k] = s.stats();
    if (!sources.aisstream) sources.aisstream = { enabled: false, connected: false, msgs: 0, lastMsg: null };
    if (!sources.digitraffic) sources.digitraffic = { enabled: false, connected: false, msgs: 0, lastMsg: null };
    const coverage = [];
    if (sources.aisstream.enabled && sources.aisstream.connected) {
      for (const [[latMin, lonMin], [latMax, lonMax]] of sources.aisstream.boxes || []) coverage.push({ src: 'aisstream', latMin, lonMin, latMax, lonMax, kind: 'subscribed' });
    }
    const subscribed = sources.aisstream.enabled && sources.aisstream.boxes ? { aisstream: sources.aisstream.boxes } : {};
    for (const b of this.store.coverage(now - COVER.FRESH_MS, subscribed)) coverage.push({ ...b, kind: 'data' });
    return { vessels: this.store.size, statics: this.store.statics.size, counters: { ...this.store.counters }, sources, coverage, offline: this.offline };
  }
}
