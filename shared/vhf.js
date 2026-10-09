// VHF radio: the channel plan, range and reception, garbling, dual watch, operating hours and timing
// (docs/BRIDGES-LOCKS-VHF-CONTRACT.md §6.1–6.4, lane B). Pure: the server (server/vhf.js), the client (public/js/vhf.js,
// vhffmt.js) and the tests share it. No imports, no DOM, no Node APIs.

// ------------------------------------------------------------------------------------------------ channel plan (§6.1)
// use: distress (16) · dsc (70, no voice) · ship (inter-ship) · bridge (13) · port (port operations) · nautinfo (VTS,
// bridges, locks) · public (coast stations, public correspondence) · marina. The game treats a channel number as one net.
// lo: RAINWAT — inland the set drops to 1 W automatically on ship-to-ship, nautical-information and port-operation channels.
const SIMPLEX = new Set([6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77]);
const USE = {
  16: 'distress', 70: 'dsc', 13: 'bridge', 10: 'ship', 6: 'ship', 8: 'ship', 72: 'ship', 77: 'ship', 9: 'calling', 31: 'marina',
  67: 'safety', 15: 'onboard', 17: 'onboard',
};
const NAMES = {
  16: 'Distress & calling', 70: 'DSC (no voice)', 13: 'Bridge-to-bridge', 10: 'Ship-to-ship (inland)', 6: 'Inter-ship', 8: 'Inter-ship',
  72: 'Inter-ship', 77: 'Inter-ship', 9: 'Calling, marinas', 31: 'Marinas NL (simulated)', 67: 'Coastguard working', 15: 'On board', 17: 'On board',
};
function buildChannels() {
  const out = {};
  const add = (ch) => {
    const use = USE[ch] || ([11, 12, 14, 18, 19, 20, 22, 60, 61, 62, 63, 64, 65, 66, 68, 69, 71, 73, 74, 79, 80, 81, 84].includes(ch) ? 'nautinfo' : 'public');
    out[ch] = { ch, duplex: !SIMPLEX.has(ch), use, voice: ch !== 70, name: NAMES[ch] || (use === 'nautinfo' ? 'Port operations' : 'Public correspondence'),
      lo: use === 'ship' || use === 'bridge' || use === 'nautinfo' || use === 'calling' || use === 'marina' };
  };
  for (let c = 1; c <= 28; c++) add(c);
  out[31] = { ch: 31, duplex: false, use: 'marina', voice: true, name: NAMES[31], lo: true, sim: true };   // NL "kanaal 31" (Q12)
  for (let c = 60; c <= 88; c++) add(c);
  return Object.freeze(out);
}
export const CHANNELS = buildChannels();
/** Voice channel numbers in knob order. */
export const CH_LIST = Object.freeze(Object.keys(CHANNELS).map(Number).sort((a, b) => a - b));
export const CH_DISTRESS = 16, CH_DSC = 70, CH_BRIDGE = 13, CH_INLAND = 10, CH_CG_WORK = 67;
export const PRESETS = Object.freeze([16, 13, 10, 9, 6, 72]);
export const POWER = Object.freeze({ hi: 25, lo: 1 });
export const POWER_FACTOR = Object.freeze({ hi: 1.0, lo: 0.35 });
export const ANTENNA = Object.freeze({ bridge: 15, lock: 15, harbour: 15, vts: 60, cg: 60, maxShip: 40, defaultShip: 10 });
export const ANTENNA_DAMAGE = 0.3;
export const GARBLE_Q = 0.15, GARBLE_FRAC = 0.3;
export const RATE = Object.freeze({ phraseMs: 2000, textMs: 4000, dscMs: 30000, textMax: 120 });
export const REPLY_S = Object.freeze({ min: 3, max: 8 });

export const isChannel = (ch) => Number.isInteger(ch) && !!CHANNELS[ch];
export const isVoice = (ch) => isChannel(ch) && CHANNELS[ch].voice;
export const chInfo = (ch) => CHANNELS[ch] || null;

/** The next voice channel in knob order (dir ±1), wrapping; 70 (DSC) is skipped. */
export function stepChannel(ch, dir) {
  const L = CH_LIST.filter((c) => CHANNELS[c].voice);
  let i = L.indexOf(ch);
  if (i < 0) { i = L.findIndex((c) => c > ch); if (i < 0) i = 0; if (dir > 0) return L[i]; i = (i - 1 + L.length) % L.length; return L[i]; }
  return L[(i + (dir > 0 ? 1 : -1) + L.length) % L.length];
}

/** Effective power: 'lo' on request; inland, channels marked `lo` drop to 1 W automatically (RAINWAT). 16 and 70 keep the set's power. */
export function effectivePower(ch, power = 'hi', inland = false) {
  if (power === 'lo') return 'lo';
  if (inland && CHANNELS[ch]?.lo) return 'lo';
  return 'hi';
}

// ------------------------------------------------------------------------------------------------ range (§6.2)
/** Radio horizon (km) between two antennas h1, h2 metres above the water. */
export const horizonKm = (h1, h2) => 4.12 * (Math.sqrt(Math.max(0, h1)) + Math.sqrt(Math.max(0, h2)));
/** A ship's antenna height: its air draught (the whip is the top of the profile), capped at 40 m. */
export const shipAntenna = (ad) => Math.min(ANTENNA.maxShip, Math.max(1, Number.isFinite(ad) ? ad : ANTENNA.defaultShip));
/** Range (km) from the transmitter's power and damage and both antenna heights. */
export function rangeKm({ h1, h2, power = 'hi', damaged = false }) {
  return horizonKm(h1, h2) * (POWER_FACTOR[power] ?? 1) * (damaged ? ANTENNA_DAMAGE : 1);
}
/** Reception quality: q = 1 − d / range; q ≤ 0 → not heard. */
export const quality = (dKm, range) => (range > 0 ? 1 - dKm / range : -1);
/** One call: { range, q, heard, garbled }. */
export function reach({ dKm, h1, h2, power = 'hi', damaged = false }) {
  const range = rangeKm({ h1, h2, power, damaged });
  const q = quality(dKm, range);
  return { range, q, heard: q > 0, garbled: q > 0 && q < GARBLE_Q };
}
/** Great-circle distance in km (local copy so this file stays import-free). */
export function distKm(a, b) {
  const R = 6371.0088, rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
/** [lat, lon] from {lat, lon} | [lat, lon] | {pos} . */
export function ptOf(x) {
  if (!x) return null;
  if (Array.isArray(x)) return [x[0], x[1]];
  if (x.pos) return ptOf(x.pos);
  if (Number.isFinite(x.lat) && Number.isFinite(x.lon)) return [x.lat, x.lon];
  return null;
}

// ------------------------------------------------------------------------------------------------ garbling
/** 32-bit FNV-1a hash of a string. */
export function hash32(s) {
  let h = 0x811c9dc5;
  s = String(s);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
/** mulberry32 seeded RNG. */
export function rng(seed) {
  let a = (typeof seed === 'number' ? seed : hash32(seed)) >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const LETTER = /\p{L}|\p{N}/u;
/**
 * Garble a received line: q < 0.15 → exactly round(30 %) of the letters/digits become '·' (seeded, so every
 * client shows the same holes); otherwise the text is returned unchanged. q ≤ 0 returns '' (not heard).
 */
export function garble(text, q, seed = 0) {
  text = String(text ?? '');
  if (!(q > 0)) return '';
  if (q >= GARBLE_Q) return text;
  const chars = [...text], idx = [];
  chars.forEach((c, i) => { if (LETTER.test(c)) idx.push(i); });
  const n = Math.round(idx.length * GARBLE_FRAC), r = rng(hash32(String(seed)) ^ hash32(text));
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  for (let k = 0; k < n; k++) chars[idx[k]] = '·';
  return chars.join('');
}

// ------------------------------------------------------------------------------------------------ dual watch
/** Does a radio state hear channel `ch`? Tuned channel, plus 16 when dual watch is on. */
export function hears(radio, ch) {
  if (!radio || radio.on === false) return false;
  return radio.ch === ch || (!!radio.dual && ch === CH_DISTRESS);
}
export const DEFAULT_RADIO = Object.freeze({ on: true, ch: 16, dual: true, power: 'hi', lang: 'auto', vol: 0.8 });
/** Sanitise a vhf_set payload onto the current radio state. Ch 70 (DSC only) and unknown channels are refused (kept). */
export function applySet(cur, m = {}) {
  const r = { ...DEFAULT_RADIO, ...(cur || {}) };
  if (typeof m.on === 'boolean') r.on = m.on;
  const ch = Number(m.ch);
  if (m.ch != null && isVoice(ch)) r.ch = ch;
  if (typeof m.dual === 'boolean') r.dual = m.dual;
  if (m.power === 'hi' || m.power === 'lo') r.power = m.power;
  if (m.lang === 'en' || m.lang === 'nl' || m.lang === 'auto') r.lang = m.lang;
  if (Number.isFinite(+m.vol) && m.vol != null) r.vol = Math.max(0, Math.min(1, +m.vol));
  if (typeof m.open === 'boolean') r.open = m.open;
  return r;
}

// ------------------------------------------------------------------------------------------------ timing
/** Operator answer delay, 3–8 s, seeded by station id and minute so it sounds like a person (§6.4). */
export function replyDelayS(id, minute) {
  return REPLY_S.min + (hash32(`${id}:${minute}`) % 5001) / 1000;
}

// ------------------------------------------------------------------------------------------------ hours
const DAY_KEYS = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
const toMin = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
const fmtHM = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
/** Local {dow 0=Mon…6=Sun, min} of epoch ms in a time zone (Intl); falls back to UTC. */
export function localTime(ms, tz = 'Europe/Amsterdam') {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
    const g = (t) => parts.find((p) => p.type === t)?.value;
    return { dow: DAY_KEYS[g('weekday')] ?? 0, min: Number(g('hour')) * 60 + Number(g('minute')) };
  } catch { const d = new Date(ms); return { dow: (d.getUTCDay() + 6) % 7, min: d.getUTCHours() * 60 + d.getUTCMinutes() }; }
}
/** "HH:MM" of epoch ms in the station's time zone. */
export function hhmm(ms, tz = 'Europe/Amsterdam') { return fmtHM(localTime(ms, tz).min); }
/**
 * Is a station in service at `ms`? OpHours (§4.2) `{tz, week: [[["06:00","22:00"]], …7 days Mon…Sun]}`. null / missing → always.
 * → { open, next: "HH:MM" | null, text: "06:00–22:00" }
 */
export function inHours(hours, ms) {
  if (!hours || !Array.isArray(hours.week) || !hours.week.length) return { open: true, next: null, text: '24 h' };
  const { dow, min } = localTime(ms, hours.tz || 'Europe/Amsterdam');
  const day = hours.week[dow] || [];
  const text = day.length ? day.map(([a, b]) => `${a}–${b}`).join(', ') : 'closed today';
  for (const [a, b] of day) if (min >= toMin(a) && min < toMin(b)) return { open: true, next: null, text };
  // next opening: later today, else the first window of the following days
  for (const [a] of day) if (toMin(a) > min) return { open: false, next: a, text };
  for (let k = 1; k <= 7; k++) { const d = hours.week[(dow + k) % 7] || []; if (d.length) return { open: false, next: d[0][0], text }; }
  return { open: false, next: null, text };
}

// ------------------------------------------------------------------------------------------------ geometry helpers
/** Compass word from a heading (deg): 'north' | 'east' | 'south' | 'west'. */
export function dirWordOf(hdg) {
  const h = ((Number(hdg) || 0) % 360 + 360) % 360;
  return h >= 315 || h < 45 ? 'north' : h < 135 ? 'east' : h < 225 ? 'south' : 'west';
}
/** Ray-casting point-in-polygon on [[lat, lon]…]. */
export function inPoly(pt, poly) {
  if (!pt || !Array.isArray(poly) || poly.length < 3) return false;
  const [y, x] = pt;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i], [yj, xj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** Polygon centroid (vertex mean, good enough for station positions). */
export function centroid(poly) {
  let a = 0, b = 0;
  for (const [la, lo] of poly) { a += la; b += lo; }
  return [a / poly.length, b / poly.length];
}
/** Quality bars 0–4 for a q. */
export const bars = (q) => (q <= 0 ? 0 : q < GARBLE_Q ? 1 : q < 0.4 ? 2 : q < 0.7 ? 3 : 4);
/** Absolute epoch ms from a time that may be absolute ms, absolute s, or seconds from now. */
export function absMs(t, nowMs) {
  if (!Number.isFinite(t)) return null;
  if (t > 1e11) return t;
  if (t > 1e9) return t * 1000;
  return nowMs + t * 1000;
}
