// Live AIS vessel table keyed by MMSI: decoded dynamic + static data, derived class / flag / origin / destination,
// a short track, dead reckoning to "now", stale removal and a 0.25° spatial grid for near() / bbox() queries.
// Units: lat/lon degrees (WGS84), speeds in knots, angles in degrees true, times in ms since the Unix epoch.
import { GEO, SHIP_CLASSES } from '../../shared/constants.js';
import { flagOf, isVesselMmsi } from './mid.js';
import { createPortIndex } from './ports.js';

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const KN = GEO.KN_TO_MS;
const CELL = 0.25, COLS = 1440, ROWS = 720;

export const LIMITS = {
  STALE_MS: 20 * 60e3,            // drop a vessel without a position report for 20 min …
  STALE_MOORED_MS: 2 * 3600e3,    // … or 2 h when moored / at anchor (they report every 3–6 min, often with gaps)
  STATIC_TTL_MS: 24 * 3600e3,     // static records without a position are kept a day
  TRACK_MAX: 60, TRACK_MIN_DT_MS: 30e3,
  MAX_IMPLIED_KN: 50, JUMP_MIN_M: 200,
  DR_CAP_S: 180, DR_ROT_S: 60, DR_ROT_MAX: 60,  // dead reckoning: ≤ 3 min, rate of turn applied for ≤ 60 s, ≤ 60°/min
  STAY_KN: 0.5, STAY_MIN_MS: 10 * 60e3, STAY_DRIFT_M: 1500, DEPART_KN: 2, DEPART_M: 400,
};

export const NAV_TEXT = ['under way using engine', 'at anchor', 'not under command', 'restricted manoeuvrability', 'constrained by her draught',
  'moored', 'aground', 'engaged in fishing', 'under way sailing', 'reserved (HSC)', 'reserved (WIG)', 'towing astern',
  'pushing ahead / towing alongside', 'reserved', 'AIS-SART active', 'undefined'];

// ------------------------------------------------------------------------------------------------ decoders
/** AIS ROT field (ROT_AIS, −128…127) → degrees per minute (+ = starboard); null when not available. */
export function decodeRot(raw) {
  if (raw == null || raw === '') return null;
  const r = Number(raw);
  if (!Number.isFinite(r) || r === -128 || r < -128 || r > 127) return null;
  if (r === 0) return 0;
  if (r === 127 || r === -127) return Math.sign(r) * 10; // "turning at more than 5° per 30 s", no turn indicator
  const v = (r / 4.733) ** 2;
  return Math.round(Math.sign(r) * Math.min(708, v) * 10) / 10;
}
/** Speed over ground in knots; 102.3 (1023) = not available, 102.2 = "102.2 kn or more" (no usable value either). */
export function cleanSog(v) {
  const n = Number(v);
  if (v == null || !Number.isFinite(n) || n < 0 || n > 102.15) return null;
  return n;
}
/** Course over ground in degrees; 360 (3600) = not available. */
export function cleanCog(v) {
  const n = Number(v);
  if (v == null || !Number.isFinite(n) || n < 0 || n >= 360) return null;
  return n;
}
/** True heading in degrees; 511 = not available. */
export function cleanHeading(v) {
  const n = Number(v);
  if (v == null || !Number.isFinite(n) || n < 0 || n >= 360) return null;
  return n;
}
/** Position validity: 91 / 181 = not available; 0,0 is the classic uninitialised GPS. */
export function validPos(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
}
/** Ship dimensions to the reference point (A bow, B stern, C port, D starboard) → length / beam in metres. */
export function dimsFrom(A, B, C, D) {
  const a = Number(A) || 0, b = Number(B) || 0, c = Number(C) || 0, d = Number(D) || 0;
  const L = a + b, Bm = c + d;
  const length = L >= 3 && L <= 470 ? L : null;
  let beam = Bm >= 1 && Bm <= 80 ? Bm : null;
  if (length && beam && beam > length * 0.8) beam = null; // C+D typed into A+B or a beam wider than the hull is long
  return { length, beam };
}
/** Draught from decimetres (Digitraffic / raw AIS) → metres; 0 = not available, 255 (25.5 m "or more") = a placeholder. */
export function draughtFromDm(dm) {
  const n = Number(dm);
  return Number.isFinite(n) && n > 0 && n < 255 ? Math.round(n) / 10 : null;
}
/** Draught in metres (AISStream MaximumStaticDraught); 0 = n/a, ≥ 25.5 = the "25.5 m or more" placeholder. */
export function draughtFromM(m) {
  const n = Number(m);
  if (m == null || m === '' || !Number.isFinite(n) || n <= 0) return null;
  const v = n > 30 ? n / 10 : n; // a value over 30 can only be decimetres
  return v < 25.5 ? Math.round(v * 10) / 10 : null;
}
/**
 * AIS ETA fields (UTC, no year) → ms. The year puts the ETA between 9 months before and 3 months after `nowMs`: crews
 * leave old ETAs in for months (an 'April' ETA seen in October is last April's), but no voyage is planned further ahead.
 */
export function decodeEta(month, day, hour, minute, nowMs = Date.now()) {
  const mo = Number(month), d = Number(day);
  if (!(mo >= 1 && mo <= 12) || !(d >= 1 && d <= 31)) return null;
  let h = Number(hour), mi = Number(minute);
  if (!(h >= 0 && h <= 23)) h = 0;
  if (!(mi >= 0 && mi <= 59)) mi = 0;
  const y = new Date(nowMs).getUTCFullYear();
  let t = Date.UTC(y, mo - 1, d, h, mi);
  if (new Date(t).getUTCMonth() !== mo - 1) return null; // 31 April etc.
  if (t - nowMs > 92 * 86400e3) t = Date.UTC(y - 1, mo - 1, d, h, mi);
  else if (t - nowMs < -273 * 86400e3) t = Date.UTC(y + 1, mo - 1, d, h, mi);
  return new Date(t).getUTCMonth() === mo - 1 ? t : null; // 29 February of a common year
}
/** Packed AIS ETA (bits 19–16 month, 15–11 day, 10–6 hour, 5–0 minute; Digitraffic `eta`) → ms. */
export function decodePackedEta(packed, nowMs = Date.now()) {
  const p = Number(packed);
  if (!Number.isInteger(p) || p <= 0) return null;
  return decodeEta((p >> 16) & 0xf, (p >> 11) & 0x1f, (p >> 6) & 0x1f, p & 0x3f, nowMs);
}
/** AIS text field → trimmed text ('@' padding and junk at either end removed), or null. */
export function cleanText(s) {
  if (s == null) return null;
  const t = String(s).replace(/@+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ')
    .replace(/^[\s_^\\[\]*.,:;=<>?!-]+|[\s_^\\[\]*,:;=<>?!-]+$/g, '').trim();
  return t || null;
}
/**
 * Ship name: a cleaned text field with '_' read as a space ('SCORPIO_2'), or null when it is mostly line noise from a
 * corrupted reception (seen live: `H HE&H.'_(WS!C?" !L`, 'R???M').
 */
export function cleanName(s) {
  const t = cleanText(s == null ? s : String(s).replace(/_/g, ' '));
  if (!t) return null;
  const junk = (t.match(/[^A-Z0-9 .,'&()/+-]/gi) || []).length;
  return junk >= 3 || junk > t.length * 0.25 || !/[A-Z0-9]/i.test(t) ? null : t;
}
export function fmtEta(ms) {
  if (!ms) return null;
  const d = new Date(ms);
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return `${String(d.getUTCDate()).padStart(2, '0')} ${M} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

// ------------------------------------------------------------------------------------------------ classes
const BULK_HINT = /\b(BULK|BULKER|ORE|CEMENT|COAL|GRAIN|MINERALS?|CAPE|PANAMAX|SUPRAMAX|ULTRAMAX|KAMSARMAX|HANDYSIZE|HANDYMAX)\b/;
/**
 * AIS ship type + dimensions → a SHIP_CLASSES id (shared/constants.js) so the client can render a matching model; the
 * client scales it to the real `length` / `beam` and swaps to the nearest-sized model of the same family.
 * Authorities (35 military, 51 SAR, 55 law enforcement) have no hull of their own: 'pilot' (< 30 m) or 'psv'.
 */
export function classFor({ aisType, length, beam, name, classB } = {}) {
  const t = Number(aisType) || 0;
  const L = Number(length) > 0 ? Number(length) : null;
  const B = Number(beam) > 0 ? Number(beam) : null;
  const nm = (name || '').toUpperCase();
  if (t >= 70 && t <= 79) {
    if (L == null) return 'feeder';
    if (L < 110) return 'coaster';
    if (BULK_HINT.test(nm)) return 'bulker';
    return L < 200 ? 'feeder' : 'boxship';
  }
  if (t >= 80 && t <= 89) return 'tanker';
  if (t >= 60 && t <= 69) return L != null && L < 20 ? 'cruiser' : 'ferry'; // passenger: water taxis, then ferries of any size
  if (t >= 40 && t <= 49) return L != null && L >= 40 ? 'ferry' : 'pilot';
  switch (t) {
    case 30: return 'trawler';
    case 31: case 32: case 52: return 'tug';
    case 33: case 34: case 54: return 'psv';
    case 50: case 53: case 58: return 'pilot';
    case 35: case 51: case 55: return L == null || L < 30 ? 'pilot' : 'psv';
    case 36:
      if (L != null && B != null && L < 25 && B / L > 0.38) return 'catamaran';
      return L == null || L < 14 ? 'sloop' : L < 25 ? 'ketch' : 'schooner';
    case 37: return L == null || L < 15 ? 'cruiser' : L < 40 ? 'myacht' : 'superyacht';
    default: break;
  }
  if (L == null) return classB ? 'cruiser' : 'coaster';
  if (L < 15) return 'cruiser';
  if (L < 25) return 'pilot';
  if (L < 60) return 'trawler';
  if (L < 110) return 'coaster';
  if (L < 200) return 'feeder';
  return 'boxship';
}

// ------------------------------------------------------------------------------------------------ geometry
function distM(lat1, lon1, lat2, lon2) {
  const dp = (lat2 - lat1) * D2R, dl = (lon2 - lon1) * D2R;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dl / 2) ** 2;
  return 2 * GEO.EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}
function wrapLon(lon) { return lon > 180 ? lon - 360 : lon < -180 ? lon + 360 : lon; }
const isMoored = (v) => (v.nav === 1 || v.nav === 5 || v.nav === 6) && (v.sog == null || v.sog < 3);

/**
 * Dead-reckon a vessel to `nowMs`: advance along COG by SOG × age (age capped at DR_CAP_S), turning at the reported
 * rate of turn for at most DR_ROT_S seconds. Moored / anchored / aground vessels and vessels under 0.3 kn stay put.
 * Returns `{lat, lon, cog, hdg}`.
 */
export function deadReckon(v, nowMs, out = {}) {
  const hdg0 = v.hdg != null ? v.hdg : v.cog != null ? v.cog : 0;
  out.lat = v.lat; out.lon = v.lon; out.cog = v.cog; out.hdg = hdg0;
  const sog = v.sog;
  if (sog == null || sog < 0.3 || isMoored(v)) return out;
  const c0 = v.cog != null ? v.cog : v.hdg;
  if (c0 == null) return out;
  let age = (nowMs - v.t) / 1000;
  if (!(age > 0)) return out;
  if (age > LIMITS.DR_CAP_S) age = LIMITS.DR_CAP_S;
  const sp = sog * KN;
  let rot = v.rot;
  if (rot == null || !Number.isFinite(rot) || Math.abs(rot) < 0.5) rot = 0;
  rot = Math.max(-LIMITS.DR_ROT_MAX, Math.min(LIMITS.DR_ROT_MAX, rot));
  let e = 0, n = 0, c = c0 * D2R;
  const tt = rot ? Math.min(age, LIMITS.DR_ROT_S) : 0;
  if (tt > 0) {
    const w = (rot / 60) * D2R; // rad/s
    const c1 = c + w * tt;
    e += (sp / w) * (Math.cos(c) - Math.cos(c1));
    n += (sp / w) * (Math.sin(c1) - Math.sin(c));
    c = c1;
  }
  const ts = age - tt;
  if (ts > 0) { e += sp * Math.sin(c) * ts; n += sp * Math.cos(c) * ts; }
  const lat = v.lat + n / GEO.M_PER_DEG_LAT;
  const lon = wrapLon(v.lon + e / (GEO.M_PER_DEG_LON_EQ * Math.max(0.01, Math.cos(v.lat * D2R))));
  const turned = (rot / 60) * tt;
  out.lat = lat; out.lon = lon;
  out.cog = ((c * R2D) % 360 + 360) % 360;
  out.hdg = ((hdg0 + turned) % 360 + 360) % 360;
  return out;
}

// ------------------------------------------------------------------------------------------------ grid
function cellRow(lat) { let r = Math.floor((lat + 90) / CELL); return r < 0 ? 0 : r >= ROWS ? ROWS - 1 : r; }
function cellCol(lon) { let c = Math.floor((lon + 180) / CELL); c %= COLS; return c < 0 ? c + COLS : c; }
function cellKey(lat, lon) { return cellRow(lat) * COLS + cellCol(lon); }

const r6 = (x) => Math.round(x * 1e6) / 1e6;
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

// ------------------------------------------------------------------------------------------------ store
export class AisStore {
  /** @param {{ports?: ReturnType<typeof createPortIndex>, harbors?: any[], now?: () => number}} opts */
  constructor({ ports, harbors, now } = {}) {
    this.ports = ports || createPortIndex(harbors);
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.vessels = new Map();   // mmsi → vessel
    this.statics = new Map();   // mmsi → static record (may exist before any position)
    this.grid = new Map();      // cell key → Set<vessel>
    this.counters = { positions: 0, statics: 0, rejected: 0, stale: 0, jumps: 0, pruned: 0 };
  }
  get size() { return this.vessels.size; }

  // ---------------------------------------------------------------- ingest
  /**
   * Merge a static record (all fields optional): `{name, callsign, imo, aisType, A, B, C, D, length, beam, draught (m),
   * destination, eta (ms|null), t, src}`. Partial updates (AIS message 24 parts A/B) merge field by field.
   */
  upsertStatic(mmsi, s, nowMs = this.now()) {
    mmsi = Number(mmsi);
    if (!isVesselMmsi(mmsi) || !s) return false;
    let st = this.statics.get(mmsi);
    if (!st) { st = { name: null, callsign: null, imo: null, aisType: null, A: null, B: null, C: null, D: null, length: null, beam: null, draught: null, destination: null, eta: null, t: 0, seen: 0, src: null }; this.statics.set(mmsi, st); }
    const name = cleanName(s.name); if (name) st.name = name;
    const cs = cleanText(s.callsign); if (cs) st.callsign = cs;
    const imo = Number(s.imo); if (Number.isInteger(imo) && imo >= 1000000 && imo <= 9999999) st.imo = imo;
    const ty = Number(s.aisType); if (Number.isInteger(ty) && ty > 0 && ty < 100) st.aisType = ty;
    if (s.A != null || s.B != null || s.C != null || s.D != null) {
      const { length, beam } = dimsFrom(s.A, s.B, s.C, s.D);
      if (length) { st.length = length; st.A = Number(s.A) || 0; st.B = Number(s.B) || 0; }
      if (beam) { st.beam = beam; st.C = Number(s.C) || 0; st.D = Number(s.D) || 0; }
    }
    if (Number(s.length) > 0 && !st.length) st.length = Number(s.length);
    if (Number(s.beam) > 0 && !st.beam) st.beam = Number(s.beam);
    if (s.draught != null && Number(s.draught) > 0 && Number(s.draught) < 25.5) st.draught = Math.round(Number(s.draught) * 10) / 10;
    if (s.destination !== undefined) st.destination = cleanText(s.destination);
    if (s.eta !== undefined) st.eta = s.eta || null;
    st.t = Math.max(st.t, Number(s.t) || nowMs); st.seen = nowMs;
    if (s.src) st.src = s.src;
    const v = this.vessels.get(mmsi);
    if (v) { v.st = st; v.cls = null; }
    this.counters.statics++;
    return true;
  }

  /**
   * Add a position report: `{lat, lon, sog (kn), cog, heading, rot (deg/min, decoded), nav (0–15 | null), t (ms), src,
   * name? (envelope name hint), classB?}`. Returns true when accepted. Rejects unavailable positions, reports already
   * stale (the prune limits), out-of-order reports and jumps implying > 50 kn (unless two consecutive reports agree).
   */
  upsertPosition(mmsi, p, nowMs = this.now()) {
    mmsi = Number(mmsi);
    if (!isVesselMmsi(mmsi) || !p) { this.counters.rejected++; return false; }
    const lat = Number(p.lat), lon = Number(p.lon);
    if (!validPos(lat, lon)) { this.counters.rejected++; return false; }
    let t = Number(p.t);
    if (!Number.isFinite(t) || t <= 0 || t > nowMs + 60e3) t = nowMs;
    if (nowMs - t > (isMoored({ nav: p.nav == null ? null : Number(p.nav), sog: cleanSog(p.sog) }) ? LIMITS.STALE_MOORED_MS : LIMITS.STALE_MS)) {
      this.counters.stale++; return false; // e.g. the first Digitraffic poll's 2 h window: prune() would drop it at once
    }
    let v = this.vessels.get(mmsi);
    if (v) {
      if (t < v.t - 1000) { this.counters.rejected++; return false; } // older than what we have
      const d = distM(v.lat, v.lon, lat, lon);
      if (d > LIMITS.JUMP_MIN_M) {
        const dt = Math.max(1, (t - v.t) / 1000);
        if (d / dt / KN > LIMITS.MAX_IMPLIED_KN) {
          // a jump: accept only when a second report confirms the new place (the old fix may have been the bad one)
          const pd = v.pend;
          const ok = pd && t > pd.t && distM(pd.lat, pd.lon, lat, lon) / Math.max(1, (t - pd.t) / 1000) / KN <= LIMITS.MAX_IMPLIED_KN;
          if (!ok) { v.pend = { lat, lon, t }; this.counters.jumps++; return false; }
          v.track.length = 0; v.stay = null;
        }
      }
      v.pend = null;
    } else {
      v = { mmsi, lat, lon, sog: null, cog: null, hdg: null, rot: null, nav: null, t, src: null, cell: -1, track: [],
        st: this.statics.get(mmsi) || null, classB: false, cls: null, hint: null, from: null, stay: null, pend: null, first: t };
      this.vessels.set(mmsi, v);
    }
    v.lat = lat; v.lon = lon; v.t = t;
    v.sog = cleanSog(p.sog); v.cog = cleanCog(p.cog); v.hdg = cleanHeading(p.heading);
    v.rot = p.rot == null || !Number.isFinite(Number(p.rot)) ? null : Number(p.rot);
    const nav = Number(p.nav);
    v.nav = p.nav == null || !Number.isInteger(nav) || nav < 0 || nav > 15 ? (p.classB ? null : v.nav) : nav;
    if (p.classB) { v.classB = true; v.cls = v.st ? v.cls : null; }
    if (p.src) v.src = p.src;
    const hint = cleanName(p.name); if (hint) v.hint = hint;
    // grid
    const key = cellKey(lat, lon);
    if (key !== v.cell) {
      if (v.cell >= 0) { const s = this.grid.get(v.cell); if (s) { s.delete(v); if (!s.size) this.grid.delete(v.cell); } }
      let s = this.grid.get(key); if (!s) { s = new Set(); this.grid.set(key, s); }
      s.add(v); v.cell = key;
    }
    // track: ≥ 30 s apart, last 60
    const tr = v.track, n = tr.length;
    if (n === 0 || t - tr[n - 1] * 1000 >= LIMITS.TRACK_MIN_DT_MS) {
      tr.push(r6(lat), r6(lon), Math.round(t / 1000));
      if (tr.length > LIMITS.TRACK_MAX * 3) tr.splice(0, tr.length - LIMITS.TRACK_MAX * 3);
    }
    this.updateStay(v, t);
    this.counters.positions++;
    return true;
  }

  /**
   * Origin inference: a vessel reporting 'moored' at < 0.5 kn inside a known port is lying in that port (at once); any
   * other stay (anchored / < 0.5 kn) inside a port counts after 10 min. That port becomes `from` and stays so after the
   * vessel leaves (`from.left` = departure time) until it lies in another port.
   */
  updateStay(v, t) {
    const sog = v.sog;
    const stationary = (sog != null && sog < LIMITS.STAY_KN) || ((v.nav === 1 || v.nav === 5) && (sog == null || sog < LIMITS.DEPART_KN));
    let s = v.stay;
    if (stationary) {
      if (!s || distM(s.lat, s.lon, v.lat, v.lon) > LIMITS.STAY_DRIFT_M) s = v.stay = { lat: v.lat, lon: v.lon, t0: t, t1: t, port: undefined };
      else s.t1 = t;
      const mooredHere = v.nav === 5 && (sog == null || sog < LIMITS.STAY_KN);
      if (s.port === undefined && (mooredHere || s.t1 - s.t0 >= LIMITS.STAY_MIN_MS)) {
        s.port = this.ports.nearestPort(s.lat, s.lon) || null;
        const f = v.from;
        if (s.port && f && f.id === s.port.id) f.left = null; // back in the same port (shifted berth): keep the arrival
        else if (s.port) v.from = { ...s.port, arrived: s.t0, left: null };
      }
      return;
    }
    if (!s) return;
    const moved = distM(s.lat, s.lon, v.lat, v.lon);
    if ((sog != null && sog >= LIMITS.DEPART_KN) || moved > LIMITS.DEPART_M) {
      if (s.port && v.from && v.from.id === s.port.id && v.from.left == null) v.from.left = t;
      v.stay = null;
    }
  }

  /** Remove vessels without a position for 20 min (2 h when moored / anchored) and old static-only records. */
  prune(nowMs = this.now()) {
    let n = 0;
    for (const v of this.vessels.values()) {
      const lim = isMoored(v) ? LIMITS.STALE_MOORED_MS : LIMITS.STALE_MS;
      if (nowMs - v.t > lim) { this.remove(v.mmsi); n++; }
    }
    for (const [mmsi, st] of this.statics) if (!this.vessels.has(mmsi) && nowMs - st.seen > LIMITS.STATIC_TTL_MS) this.statics.delete(mmsi);
    this.counters.pruned += n;
    return n;
  }
  remove(mmsi) {
    const v = this.vessels.get(Number(mmsi));
    if (!v) return false;
    const s = this.grid.get(v.cell);
    if (s) { s.delete(v); if (!s.size) this.grid.delete(v.cell); }
    this.vessels.delete(v.mmsi);
    return true;
  }

  // ---------------------------------------------------------------- derived
  classOf(v) {
    if (!v.cls) {
      const st = v.st;
      const c = classFor({ aisType: st && st.aisType, length: st && st.length, beam: st && st.beam, name: (st && st.name) || v.hint, classB: v.classB });
      v.cls = SHIP_CLASSES[c] ? c : 'coaster';
    }
    return v.cls;
  }
  /** Public, dead-reckoned view of a vessel (AisPublic). */
  pub(v, nowMs, pos = deadReckon(v, nowMs)) {
    const st = v.st;
    const dest = st && st.destination ? this.ports.resolveDestination(st.destination, v.lat, v.lon) : null;
    const from = v.from;
    const moored = isMoored(v);
    const off = st && st.length && st.A != null ? [r1((st.A - st.B) / 2), st.beam && st.C != null ? r1((st.D - st.C) / 2) : 0] : null;
    return {
      id: 'ais' + v.mmsi, mmsi: v.mmsi,
      name: (st && st.name) || v.hint || `MMSI ${v.mmsi}`,
      cls: this.classOf(v), aisType: (st && st.aisType) || null, flag: flagOf(v.mmsi),
      lat: r6(pos.lat), lon: r6(pos.lon),
      sog: v.sog == null ? 0 : r1(v.sog), cog: pos.cog == null ? null : r1(pos.cog), hdg: r1(pos.hdg), rot: v.rot,
      nav: v.nav == null ? (v.classB ? 'class B' : 'undefined') : NAV_TEXT[v.nav], navStatus: v.nav,
      length: (st && st.length) || null, beam: (st && st.beam) || null, draught: (st && st.draught) || null, off,
      dest: dest ? dest.id : null, destName: dest ? dest.name : null, destRaw: (st && st.destination) || null,
      from: from ? from.id : null, fromName: from ? from.name : null,
      eta: st && st.eta ? Math.round(st.eta / 1000) : null,
      t: v.t, src: v.src,
      // AiPublic-compatible aliases so the existing AI ship pipeline can render live vessels unchanged
      spd: v.sog == null ? 0 : r1(v.sog),
      state: moored ? (v.nav === 1 ? 'anchored' : 'moored') : (v.sog != null && v.sog < 0.3 ? 'stopped' : 'underway'),
      live: true,
    };
  }

  // ---------------------------------------------------------------- queries
  /** Vessels within `rangeM` of (lat, lon), dead-reckoned to now, nearest first. */
  near(lat, lon, rangeM, { limit = 250, now } = {}) {
    const nowMs = now ?? this.now();
    const out = [];
    if (!validPos(lat, lon) || !(rangeM > 0)) return out;
    const pad = 5000; // a vessel may dead-reckon up to ~4.6 km (50 kn × 180 s) out of its cell
    const R = rangeM + pad;
    const dLat = R / GEO.M_PER_DEG_LAT;
    const cosLat = Math.max(0.02, Math.cos(lat * D2R));
    const dLon = Math.min(180, R / (GEO.M_PER_DEG_LON_EQ * cosLat));
    const r0 = cellRow(lat - dLat), r1_ = cellRow(lat + dLat);
    const nCols = dLon >= 180 ? COLS : Math.min(COLS, Math.floor((lon + dLon + 180) / CELL) - Math.floor((lon - dLon + 180) / CELL) + 1);
    const c0 = cellCol(lon - dLon);
    const kLat = GEO.M_PER_DEG_LAT, kLon = GEO.M_PER_DEG_LON_EQ * cosLat;
    const R2 = R * R;
    // Hot loop: mid-latitude equirectangular distance on the sphere (≤ ~2 m off haversine within 60 km); haversine only
    // in a narrow band around the range edge; dead reckoning only for vessels that actually move.
    const K = GEO.EARTH_R * D2R, band = Math.max(30, rangeM * 1e-4);
    const ds = [], vs = [], p = {};
    for (let r = r0; r <= r1_; r++) {
      for (let i = 0; i < nCols; i++) {
        const s = this.grid.get(r * COLS + ((c0 + i) % COLS));
        if (!s) continue;
        for (const v of s) {
          let dl = v.lon - lon; if (dl > 180) dl -= 360; else if (dl < -180) dl += 360;
          const dy = (v.lat - lat) * kLat, dx = dl * kLon;
          if (dx * dx + dy * dy > R2) continue;
          let plat = v.lat;
          if (v.sog != null && v.sog >= 0.3 && nowMs > v.t && !isMoored(v)) {
            deadReckon(v, nowMs, p);
            plat = p.lat; dl = p.lon - lon; if (dl > 180) dl -= 360; else if (dl < -180) dl += 360;
          }
          const ey = (plat - lat) * K, ex = dl * K * Math.cos((plat + lat) * 0.5 * D2R);
          let d = Math.sqrt(ex * ex + ey * ey);
          if (d > rangeM - band && d < rangeM + band) d = distM(lat, lon, plat, lon + dl);
          if (d <= rangeM) { ds.push(d); vs.push(v); }
        }
      }
    }
    // keep the `limit` nearest: threshold from a native numeric sort (no comparator), then exact distances for those
    let thr = Infinity;
    if (ds.length > limit) { const f = Float64Array.from(ds); f.sort(); thr = f[limit - 1]; }
    for (let i = 0; i < ds.length && out.length < limit; i++) {
      if (ds[i] > thr) continue;
      const v = vs[i]; const pos = deadReckon(v, nowMs);
      out.push({ d: distM(lat, lon, pos.lat, pos.lon), v, pos });
    }
    out.sort((a, b) => a.d - b.d); // exact order for what is returned
    return out.map((o) => this.pub(o.v, nowMs, o.pos));
  }

  /**
   * Vessels inside a lat/lon box (lonMin > lonMax crosses the antimeridian). Over `limit`, the result is decimated on a
   * coarse grid (largest vessel per coarse cell) so a chart at any zoom gets an even spread.
   */
  bbox(latMin, lonMin, latMax, lonMax, { limit = 2000, now } = {}) {
    const nowMs = now ?? this.now();
    if (![latMin, lonMin, latMax, lonMax].every(Number.isFinite)) return [];
    if (latMin > latMax) [latMin, latMax] = [latMax, latMin];
    latMin = Math.max(-90, latMin); latMax = Math.min(90, latMax);
    const wraps = lonMin > lonMax;
    const inLon = wraps ? (x) => x >= lonMin || x <= lonMax : (x) => x >= lonMin && x <= lonMax;
    const lonSpan = wraps ? 360 - lonMin + lonMax : lonMax - lonMin;
    const rows = cellRow(latMax) - cellRow(latMin) + 1, cols = Math.min(COLS, Math.ceil(lonSpan / CELL) + 1);
    const hits = [];
    const take = (s) => { for (const v of s) if (v.lat >= latMin && v.lat <= latMax && inLon(v.lon)) hits.push(v); };
    if (rows * cols > this.grid.size) {
      for (const [k, s] of this.grid) {
        const r = Math.floor(k / COLS), c = k % COLS;
        const la0 = r * CELL - 90, lo0 = c * CELL - 180;
        if (la0 + CELL < latMin || la0 > latMax) continue;
        if (!wraps && (lo0 + CELL < lonMin || lo0 > lonMax)) continue;
        take(s);
      }
    } else {
      const c0 = cellCol(lonMin);
      for (let r = cellRow(latMin); r <= cellRow(latMax); r++) for (let i = 0; i < cols; i++) {
        const s = this.grid.get(r * COLS + ((c0 + i) % COLS)); if (s) take(s);
      }
    }
    let sel = hits;
    if (hits.length > limit) {
      // coarsen until at most `limit` coarse cells are occupied; keep the largest vessel in each
      const latSpan = Math.max(1e-6, latMax - latMin);
      let size = Math.sqrt((latSpan * Math.max(1e-6, lonSpan)) / limit);
      for (let iter = 0; iter < 12; iter++, size *= 1.4) {
        const pick = new Map();
        for (const v of hits) {
          let dl = v.lon - lonMin; if (dl < 0) dl += 360;
          const k = Math.floor((v.lat - latMin) / size) * 1e8 + Math.floor(dl / size);
          const cur = pick.get(k);
          if (!cur || ((v.st && v.st.length) || 0) > ((cur.st && cur.st.length) || 0)) pick.set(k, v);
        }
        if (pick.size <= limit) { sel = [...pick.values()]; break; }
        if (iter === 11) sel = [...pick.values()].slice(0, limit);
      }
    }
    return sel.map((v) => this.pub(v, nowMs));
  }

  /** Full record for one vessel: AisPublic + track, static data, origin / destination details, ETA text. */
  get(mmsi, nowMs = this.now()) {
    const v = this.vessels.get(Number(mmsi));
    if (!v) return null;
    const p = this.pub(v, nowMs);
    const st = v.st;
    const track = [];
    for (let i = 0; i < v.track.length; i += 3) track.push([v.track[i], v.track[i + 1], v.track[i + 2] * 1000]);
    const to = st && st.destination ? this.ports.resolveDestination(st.destination, v.lat, v.lon) : null;
    return {
      ...p, track,
      static: st ? { name: st.name, callsign: st.callsign, imo: st.imo, aisType: st.aisType, length: st.length, beam: st.beam, draught: st.draught,
        A: st.A, B: st.B, C: st.C, D: st.D, destination: st.destination, eta: st.eta, t: st.t, src: st.src } : null,
      from: v.from ? { ...v.from } : null, to, etaText: st && st.eta ? fmtEta(st.eta) : null,
      raw: { lat: v.lat, lon: v.lon, sog: v.sog, cog: v.cog, heading: v.hdg, rot: v.rot, nav: v.nav, t: v.t },
    };
  }

  /** Number of vessels reported since `sinceMs` within `rangeM` of (lat, lon) (raw positions; optional source filter). */
  countFresh(lat, lon, rangeM, sinceMs, src = null) {
    if (!validPos(lat, lon)) return 0;
    const dLat = rangeM / GEO.M_PER_DEG_LAT;
    const cosLat = Math.max(0.02, Math.cos(lat * D2R));
    const dLon = Math.min(180, rangeM / (GEO.M_PER_DEG_LON_EQ * cosLat));
    const nCols = Math.min(COLS, Math.floor((lon + dLon + 180) / CELL) - Math.floor((lon - dLon + 180) / CELL) + 1);
    const c0 = cellCol(lon - dLon);
    let n = 0;
    for (let r = cellRow(lat - dLat); r <= cellRow(lat + dLat); r++) for (let i = 0; i < nCols; i++) {
      const s = this.grid.get(r * COLS + ((c0 + i) % COLS)); if (!s) continue;
      for (const v of s) if (v.t >= sinceMs && (!src || v.src === src) && distM(lat, lon, v.lat, v.lon) <= rangeM) n++;
    }
    return n;
  }

  /**
   * Bounding boxes and counts of the vessels reported since `sinceMs`, per source — and per subscription box for sources
   * listed in `boxesBySrc` ({aisstream: [[[latMin, lonMin], [latMax, lonMax]], …]}), so that a North Sea and a New York
   * box are two areas, not one box across the Atlantic.
   */
  coverage(sinceMs, boxesBySrc = {}) {
    const by = new Map();
    for (const v of this.vessels.values()) {
      if (v.t < sinceMs) continue;
      const src = v.src || 'unknown';
      let k = src;
      const boxes = boxesBySrc[src];
      if (boxes && boxes.length) {
        const i = boxes.findIndex(([[a, b], [c, d]]) => v.lat >= a && v.lat <= c && v.lon >= b && v.lon <= d);
        k = `${src}#${i}`;
      }
      let b = by.get(k);
      if (!b) by.set(k, (b = { src, vessels: 0, latMin: 90, lonMin: 180, latMax: -90, lonMax: -180 }));
      b.vessels++;
      if (v.lat < b.latMin) b.latMin = v.lat; if (v.lat > b.latMax) b.latMax = v.lat;
      if (v.lon < b.lonMin) b.lonMin = v.lon; if (v.lon > b.lonMax) b.lonMax = v.lon;
    }
    return [...by.values()].map((b) => ({ ...b, latMin: r1(b.latMin), lonMin: r1(b.lonMin), latMax: r1(b.latMax), lonMax: r1(b.lonMax) }));
  }
}
