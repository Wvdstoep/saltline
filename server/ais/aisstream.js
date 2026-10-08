// AISStream.io source: global terrestrial AIS over a WebSocket (free, needs an API key).
// Protocol: open wss://stream.aisstream.io/v0/stream, send {APIKey, BoundingBoxes, FilterMessageTypes} within 3 s,
// then receive JSON messages {MessageType, MetaData: {MMSI, ShipName, latitude, longitude, time_utc}, Message: {<Type>: {...}}}.
// Sending a new subscription message on the open socket replaces the subscription.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeRot, decodeEta, cleanText, cleanName, draughtFromM } from './store.js';

export const AISSTREAM_URL = 'wss://stream.aisstream.io/v0/stream';
export const MESSAGE_TYPES = ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport', 'ShipStaticData', 'StaticDataReport'];
/** The game's detail region (shared/constants.js LAYERS[1]) — always subscribed. */
export const DETAIL_BOX = { latMin: 48, lonMin: -8, latMax: 62.5, lonMax: 14 };
export const MAX_BOXES = 10;
/** The whole world in one box: measured on the production server ~130 msg/s, ~8,400 vessels after 80 s, < 90 MB RSS. */
export const GLOBAL_BOXES = [[[-90, -180], [90, 180]]];
const DEFAULT_KEY_FILE = fileURLToPath(new URL('../../data/secrets/aisstream.key', import.meta.url));

/** 'YYYY-MM-DD HH:MM:SS.ffffff +0000 UTC' (AISStream MetaData.time_utc) → ms, or null. */
export function parseTimeUtc(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?\s*(?:([+-]\d{2}):?(\d{2}))?/);
  if (!m) { const t = Date.parse(s); return Number.isFinite(t) ? t : null; }
  const frac = m[3] ? m[3].slice(0, 4) : '';
  const tz = m[4] ? `${m[4]}:${m[5]}` : 'Z';
  const t = Date.parse(`${m[1]}T${m[2]}${frac}${tz}`);
  return Number.isFinite(t) ? t : null;
}

function toText(data) {
  if (typeof data === 'string') return data;
  if (data == null) return '';
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data.map((d) => Buffer.from(d))).toString('utf8');
  return String(data);
}

const num = (x) => (x == null || x === '' ? null : Number.isFinite(Number(x)) ? Number(x) : null);
function dims(d) { return d && typeof d === 'object' ? { A: num(d.A), B: num(d.B), C: num(d.C), D: num(d.D) } : {}; }

/**
 * One AISStream message (object, JSON text or Buffer) → normalized records for the store:
 * `{kind: 'pos', mmsi, lat, lon, sog, cog, heading, rot (deg/min), nav, t, src, name, classB}` and/or
 * `{kind: 'static', mmsi, name, callsign, imo, aisType, A, B, C, D, draught (m), destination, eta (ms), t, src}`.
 * `{kind: 'error', error}` for server errors. Unknown / invalid messages → [].
 */
export function parseAisStreamMessage(msg, nowMs = Date.now()) {
  let m = msg;
  if (typeof m !== 'object' || m == null || Buffer.isBuffer(m) || ArrayBuffer.isView(m) || m instanceof ArrayBuffer) {
    try { m = JSON.parse(toText(msg)); } catch { return []; }
  }
  if (!m || typeof m !== 'object') return [];
  if (m.error || m.Error) return [{ kind: 'error', error: String(m.error || m.Error) }];
  const type = m.MessageType;
  const body = m.Message && type ? m.Message[type] : null;
  const meta = m.MetaData || {};
  if (!body || typeof body !== 'object') return [];
  if (body.Valid === false) return [];
  const mmsi = num(body.UserID) ?? num(meta.MMSI);
  if (!mmsi) return [];
  const t = parseTimeUtc(meta.time_utc) ?? nowMs;
  const src = 'aisstream';
  const hint = cleanName(meta.ShipName);
  const out = [];
  const pos = (extra) => {
    const lat = num(body.Latitude) ?? num(meta.latitude), lon = num(body.Longitude) ?? num(meta.longitude);
    out.push({ kind: 'pos', mmsi, lat, lon, sog: num(body.Sog), cog: num(body.Cog), heading: num(body.TrueHeading), t, src, name: hint, ...extra });
  };
  switch (type) {
    case 'PositionReport':
      pos({ rot: decodeRot(body.RateOfTurn), nav: num(body.NavigationalStatus), classB: false });
      break;
    case 'StandardClassBPositionReport':
      pos({ rot: null, nav: null, classB: true });
      break;
    case 'ExtendedClassBPositionReport':
      pos({ rot: null, nav: null, classB: true });
      out.push({ kind: 'static', mmsi, name: cleanName(body.Name) || hint, aisType: num(body.Type), ...dims(body.Dimension), t, src });
      break;
    case 'ShipStaticData': {
      const e = body.Eta || {};
      out.push({ kind: 'static', mmsi, name: cleanName(body.Name) || hint, callsign: cleanText(body.CallSign), imo: num(body.ImoNumber),
        aisType: num(body.Type), ...dims(body.Dimension), draught: draughtFromM(body.MaximumStaticDraught), destination: cleanText(body.Destination) ?? '',
        eta: decodeEta(e.Month, e.Day, e.Hour, e.Minute, t), t, src });
      break;
    }
    case 'StaticDataReport': {
      const a = body.ReportA, b = body.ReportB;
      const part = body.PartNumber; // false / 0 = part A (name), true / 1 = part B (type, call sign, dimensions)
      const rec = { kind: 'static', mmsi, t, src };
      if (a && a.Valid !== false && (part == null || !part) && cleanName(a.Name)) rec.name = cleanName(a.Name);
      if (b && b.Valid !== false && (part == null || part)) {
        if (num(b.ShipType)) rec.aisType = num(b.ShipType);
        if (cleanText(b.CallSign)) rec.callsign = cleanText(b.CallSign);
        Object.assign(rec, dims(b.Dimension));
      }
      if (!rec.name && hint) rec.name = hint;
      out.push(rec);
      break;
    }
    default: break;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ boxes
const boxArea = (b) => (b.latMax - b.latMin) * (b.lonMax - b.lonMin);
const overlaps = (a, b) => a.latMin <= b.latMax && b.latMin <= a.latMax && a.lonMin <= b.lonMax && b.lonMin <= a.lonMax;
const union = (a, b) => ({ latMin: Math.min(a.latMin, b.latMin), lonMin: Math.min(a.lonMin, b.lonMin), latMax: Math.max(a.latMax, b.latMax), lonMax: Math.max(a.lonMax, b.lonMax) });
const inBox = (b, lat, lon) => lat >= b.latMin && lat <= b.latMax && lon >= b.lonMin && lon <= b.lonMax;
const rnd = (x) => Math.round(x * 100) / 100;

/**
 * Subscription boxes for the wanted area: the detail region plus a 1.5° box (±0.75° of latitude, the same distance in
 * longitude, max ±3°) around every point outside it; overlapping boxes are merged and the cheapest pairs merged
 * until at most `max` remain. Returns AISStream format [[[latMin, lonMin], [latMax, lonMax]], …].
 */
export function boxesFor(points = [], { max = MAX_BOXES, detail = DETAIL_BOX, halfDeg = 0.75 } = {}) {
  let boxes = [];
  for (const p of points || []) {
    const lat = Number(p && p.lat), lon = Number(p && p.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    if (detail && inBox(detail, lat, lon)) continue;
    const hl = Math.min(3, halfDeg / Math.max(0.25, Math.cos(lat * Math.PI / 180)));
    const b = { latMin: Math.max(-90, lat - halfDeg), latMax: Math.min(90, lat + halfDeg), lonMin: lon - hl, lonMax: lon + hl };
    if (b.lonMin < -180) { boxes.push({ ...b, lonMin: b.lonMin + 360, lonMax: 180 }); b.lonMin = -180; }
    if (b.lonMax > 180) { boxes.push({ ...b, lonMin: -180, lonMax: b.lonMax - 360 }); b.lonMax = 180; }
    boxes.push(b);
  }
  if (detail) boxes.unshift({ ...detail });
  // merge overlaps until stable
  for (let changed = true; changed;) {
    changed = false;
    outer: for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      if (overlaps(boxes[i], boxes[j])) { boxes[i] = union(boxes[i], boxes[j]); boxes.splice(j, 1); changed = true; break outer; }
    }
  }
  // cap: merge the pair whose union adds the least area
  while (boxes.length > max) {
    let bi = 0, bj = 1, best = Infinity;
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const u = union(boxes[i], boxes[j]);
      const cost = boxArea(u) - boxArea(boxes[i]) - boxArea(boxes[j]);
      if (cost < best) { best = cost; bi = i; bj = j; }
    }
    boxes[bi] = union(boxes[bi], boxes[bj]); boxes.splice(bj, 1);
  }
  return boxes.map((b) => [[rnd(b.latMin), rnd(b.lonMin)], [rnd(b.latMax), rnd(b.lonMax)]]);
}

/** API key from AISSTREAM_API_KEY or the key file (trimmed); null when neither exists. */
export function readApiKey({ env = process.env, keyFile = DEFAULT_KEY_FILE } = {}) {
  const e = env && env.AISSTREAM_API_KEY ? String(env.AISSTREAM_API_KEY).trim() : '';
  if (e) return e;
  try { const k = fs.readFileSync(keyFile, 'utf8').trim(); return k || null; } catch { return null; }
}

// ------------------------------------------------------------------------------------------------ source
export class AisStreamSource {
  /**
   * @param {{store, log?, WebSocketImpl?, apiKey?, keyFile?, env?, now?, timers?, url?, backoffMinMs?, backoffMaxMs?,
   *          resubMinMs?, idleMs?, connectTimeoutMs?, offline?}} o
   */
  constructor(o = {}) {
    this.store = o.store; this.log = o.log || (() => {});
    this.WebSocketImpl = o.WebSocketImpl || null;
    this.apiKey = o.apiKey !== undefined ? o.apiKey : readApiKey({ env: o.env || process.env, keyFile: o.keyFile || DEFAULT_KEY_FILE });
    this.now = o.now || (() => Date.now());
    this.timers = o.timers || globalThis;
    this.url = o.url || AISSTREAM_URL;
    this.backoffMinMs = o.backoffMinMs ?? 5000; this.backoffMaxMs = o.backoffMaxMs ?? 300000;
    this.resubMinMs = o.resubMinMs ?? 60000; this.idleMs = o.idleMs ?? 180000; this.connectTimeoutMs = o.connectTimeoutMs ?? 20000;
    this.offline = o.offline ?? process.env.SALTLINE_OFFLINE === '1';
    // worldwide by default (every live ship on the world chart); AIS_GLOBAL=0 falls back to region + boxes round players
    this.global = o.global ?? (o.env || process.env).AIS_GLOBAL !== '0';
    this.enabled = false; this.running = false; this.connected = false;
    this.ws = null; this.backoff = this.backoffMinMs; this.reconnectTimer = null; this.resubTimer = null; this.watchTimer = null; this.openTimer = null;
    this.wanted = this.global ? GLOBAL_BOXES : boxesFor([]); this.subscribedKey = null; this.lastSubAt = 0; this.subscriptions = 0;
    this.msgs = 0; this.lastMsg = 0; this.connects = 0; this.reconnects = 0; this.lastError = null; this.gotFirst = false; this.openAt = 0;
    this.errorsLogged = new Set();
  }
  set(fn, ms) { const h = this.timers.setTimeout(fn, ms); if (h && h.unref) h.unref(); return h; }
  clear(h) { if (h) this.timers.clearTimeout(h); }

  start() {
    if (this.running) return this;
    if (this.offline) { this.enabled = false; this.log('[ais] AISStream disabled (SALTLINE_OFFLINE=1)'); return this; }
    if (!this.apiKey) { this.enabled = false; this.log('[ais] AISStream disabled: no API key (set AISSTREAM_API_KEY or data/secrets/aisstream.key)'); return this; }
    this.enabled = true; this.running = true;
    this.connect();
    const watch = () => { this.watchdog(); if (this.running) this.watchTimer = this.set(watch, 30000); };
    this.watchTimer = this.set(watch, 30000);
    return this;
  }
  stop() {
    this.running = false; this.connected = false;
    for (const k of ['reconnectTimer', 'resubTimer', 'watchTimer', 'openTimer']) { this.clear(this[k]); this[k] = null; }
    const ws = this.ws; this.ws = null;
    if (ws) { ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null; try { ws.close(); } catch { /* ignore */ } }
  }

  async connect() {
    if (!this.running) return;
    this.reconnectTimer = null;
    let WS = this.WebSocketImpl;
    if (!WS) {
      try { const mod = await import('ws'); WS = this.WebSocketImpl = mod.default || mod.WebSocket; } catch (e) { WS = globalThis.WebSocket; }
      if (!WS) { this.enabled = false; this.running = false; this.log('[ais] AISStream disabled: no WebSocket implementation'); return; }
      if (!this.running) return;
    }
    let ws;
    try { ws = new WS(this.url); } catch (e) { this.lastError = e.message; this.scheduleReconnect(); return; }
    this.ws = ws; this.connects++; this.gotFirst = false;
    this.openTimer = this.set(() => { if (this.ws === ws && !this.connected) { this.lastError = 'connect timeout'; this.drop(ws); } }, this.connectTimeoutMs);
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.clear(this.openTimer); this.openTimer = null;
      this.connected = true; this.openAt = this.now();
      this.subscribe(true);
    };
    ws.onmessage = (ev) => { if (this.ws === ws) this.onData(ev && ev.data !== undefined ? ev.data : ev); };
    ws.onerror = (ev) => { if (this.ws === ws) this.lastError = (ev && (ev.message || (ev.error && ev.error.message))) || 'socket error'; };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null; this.connected = false;
      this.clear(this.openTimer); this.openTimer = null;
      if (ev && ev.code && ev.code !== 1000 && !this.lastError) this.lastError = `closed ${ev.code}${ev.reason ? ' ' + ev.reason : ''}`;
      this.scheduleReconnect();
    };
  }
  /** Close a socket and go through the reconnect path (also when the implementation never fires onclose). */
  drop(ws) {
    if (this.ws !== ws) return;
    this.ws = null; this.connected = false;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try { if (ws.terminate) ws.terminate(); else ws.close(); } catch { /* ignore */ }
    this.scheduleReconnect();
  }
  scheduleReconnect() {
    if (!this.running || this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoffMaxMs, this.backoff * 2);
    this.reconnects++;
    this.reconnectTimer = this.set(() => this.connect(), delay);
    if (this.reconnects === 1 || this.reconnects % 10 === 0) this.log(`[ais] AISStream reconnect in ${Math.round(delay / 1000)} s${this.lastError ? ' (' + this.lastError + ')' : ''}`);
  }
  watchdog() {
    if (!this.connected || !this.ws) return;
    const last = Math.max(this.lastMsg, this.openAt);
    if (this.now() - last > this.idleMs) { this.lastError = 'idle'; this.drop(this.ws); }
  }

  onData(data) {
    const now = this.now();
    const recs = parseAisStreamMessage(data, now);
    if (!recs.length) return;
    if (recs[0].kind === 'error') {
      this.lastError = recs[0].error;
      if (!this.errorsLogged.has(recs[0].error)) { this.errorsLogged.add(recs[0].error); this.log('[ais] AISStream error:', recs[0].error); }
      return;
    }
    if (!this.gotFirst) { this.gotFirst = true; this.backoff = this.backoffMinMs; this.lastError = null; }
    this.msgs++; this.lastMsg = now;
    for (const r of recs) {
      if (r.kind === 'pos') this.store.upsertPosition(r.mmsi, r, now);
      else if (r.kind === 'static') this.store.upsertStatic(r.mmsi, r, now);
    }
  }

  /** Wanted area from the online players' positions; resubscribes at most every `resubMinMs`. */
  setInterest(points) {
    if (this.global) return; // already subscribed to everything
    this.wanted = boxesFor(points);
    this.trySubscribe();
  }
  trySubscribe() {
    const key = JSON.stringify(this.wanted);
    if (key === this.subscribedKey) { this.clear(this.resubTimer); this.resubTimer = null; return; }
    if (!this.connected) return; // sent on open
    const wait = this.lastSubAt + this.resubMinMs - this.now();
    if (wait <= 0) { this.subscribe(false); return; }
    if (!this.resubTimer) this.resubTimer = this.set(() => { this.resubTimer = null; this.trySubscribe(); }, wait);
  }
  subscribe() {
    if (!this.ws || !this.connected) return false;
    const msg = { APIKey: this.apiKey, BoundingBoxes: this.wanted, FilterMessageTypes: MESSAGE_TYPES };
    try { this.ws.send(JSON.stringify(msg)); } catch (e) { this.lastError = e.message; return false; }
    this.subscribedKey = JSON.stringify(this.wanted); this.lastSubAt = this.now(); this.subscriptions++;
    return true;
  }

  stats() {
    return { enabled: this.enabled, connected: this.connected, msgs: this.msgs, lastMsg: this.lastMsg || null, connects: this.connects,
      reconnects: this.reconnects, backoffMs: this.backoff, subscriptions: this.subscriptions, boxes: this.wanted, lastError: this.lastError };
  }
}
