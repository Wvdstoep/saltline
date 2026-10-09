// Live AIS traffic layer (client). Real vessels reported over AIS (server `AisPublic` records) are drawn at their real
// size in the floating-origin scene: one buildShip() model per vessel, scaled to the reported length/beam, riding the
// same Gerstner water as every other hull, with the world-space foam wake, a readable label and an info card.
//
// Motion is smooth dead reckoning between reports, with the same rules as the server (server/ais/store.js deadReckon):
// along COG at SOG for at most MAX_DR_S after the report, turning at the reported ROT (deg/min, |ROT| ≥ 0.5, clamped to
// ±60) for at most ROT_HORIZON_S. Server records are already dead-reckoned to the snapshot time, so by default a
// record's lat/lon is taken as the position at `serverTimeMs` and `t` (the report time) only bounds the remaining DR;
// pass {raw: true} for lists whose positions are as reported at `t`. A new position is blended in over BLEND_MS (the
// displayed track converges from the old prediction to the new one, no teleporting) unless the error exceeds SNAP_M.
// The hull is drawn around its real centre: AIS positions are the GPS antenna, `off` = [m forward, m to starboard]
// from the antenna to the hull centre.
// Moored (nav 5) / anchored (nav 1) / aground (nav 6) vessels hold their reported position; anchored ones swing slowly.
//
// Levels of detail by distance to the camera: full model < FULL_M, a coloured hull box (two InstancedMeshes, two draw
// calls for every far vessel) up to BOX_M, hidden beyond (contacts() still lists everything for radar and chart).
// At most MAX_RENDER vessels are rendered (nearest first), of which at most MAX_FULL as full models; models are built
// a few per frame inside a time budget and reused through a bounded pool (≤ POOL_PER_CLS per class, ≤ POOL_MAX in all)
// across LOD and class changes and removals; models beyond the pool, labels and everything at dispose() are freed.
//
// Wiring (integrator): `app.aisLayer = new AisLayer(app)`; on every message carrying AIS records
// `aisLayer.ingest(list, serverTimeMs)`; in the render loop `aisLayer.update(dt, performance.now())` before rendering;
// `resolveShip(..., [...others, ...aisLayer.others()])`; radar/chart contacts `...aisLayer.contacts()`;
// on click `const v = aisLayer.pick(raycaster); if (v) <any HUD card>.innerHTML = aisLayer.info(v)` (escaped HTML).
import * as THREE from 'three';
import { GEO, SHIP_CLASSES } from '/shared/constants.js';
import { toLocal, wrapLon, normDeg, angleDiff, fmtDMS, bearing, haversine } from '/shared/geo.js';
import { buildShip, EXTRA_CLASSES } from './ship.js';

const D2R = Math.PI / 180;
const KN = GEO.KN_TO_MS;
const M_LAT = GEO.M_PER_DEG_LAT, M_LON = GEO.M_PER_DEG_LON_EQ;

/** Tunables (metres, milliseconds, seconds as named). */
export const AIS_LOD = {
  FULL_M: 4000,          // full model below this camera distance
  BOX_M: 15000,          // hull box up to this distance, hidden beyond
  LABEL_M: 3000,         // labels only within this distance …
  LABEL_MOORED_M: 1200,  // … and moored / anchored vessels only within this (ports would be a wall of text)
  HYST_M: 250,           // hysteresis on every LOD boundary (×2 on the outer one)
  MAX_RENDER: 250,       // rendered vessels (models + boxes), nearest first
  MAX_FULL: 64,          // of which full models
  MAX_LABELS: 30,
  BLEND_MS: 4000,        // convergence time from the old prediction to a new report
  SNAP_M: 2000,          // larger errors snap
  MAX_DR_S: 180,         // dead reckoning stops this long after the report (the vessel holds; = server DR_CAP_S)
  ROT_HORIZON_S: 60,     // a reported rate of turn is applied for at most this long after the report …
  ROT_MAX: 60, ROT_MIN: 0.5, // … clamped to ±60 deg/min, ignored below 0.5 deg/min (= server DR_ROT_*)
  ABSENT_MS: 30000,      // a vessel missing from full ingests this long is dropped
  STALE_MS: 20 * 60000,  // partial ingests: a vessel without a report this long is dropped
  POOL_PER_CLS: 3, POOL_MAX: 24,
  BUILD_BUDGET_MS: 6,    // per frame; at least one model is always built when one is waiting
  SELECT_MS: 250,        // LOD / cap / label re-selection period
};
const L_ = AIS_LOD;

// ------------------------------------------------------------------------------------------------ value cleaning
const num = (v) => { if (v == null || v === '' || typeof v === 'boolean') return null; const n = +v; return Number.isFinite(n) ? n : null; };
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (u) => { const x = clamp(u, 0, 1); return x * x * (3 - 2 * x); };
/** AIS "not available" sentinels: SOG 102.3, COG 360, HDG 511, ROT -128 raw (±731 deg/min). */
const validSog = (s) => { s = num(s); return s == null || s < 0 || s >= 102.2 ? null : s; };
const validCog = (c) => { c = num(c); return c == null || c < 0 || c >= 360 ? null : c; };
const validHdg = (h) => { h = num(h); return h == null || h < 0 || h >= 360 ? null : h; };
const validRot = (r) => { r = num(r); return r == null || Math.abs(r) >= 700 ? null : r; };
const validLen = (l) => { l = num(l); return l != null && l >= 3 && l <= 520 ? l : null; };
const validBeam = (b) => { b = num(b); return b != null && b >= 1 && b <= 90 ? b : null; };
/** Epoch milliseconds from a number in seconds or milliseconds, or a date string. */
function toMs(t) {
  if (t == null || t === '') return null;
  if (typeof t === 'string' && !Number.isFinite(+t)) { const p = Date.parse(t); return Number.isFinite(p) ? p : null; }
  const n = num(t); if (n == null || n <= 0) return null;
  return n < 1e11 ? n * 1000 : n;
}
/** ETA as epoch ms: a timestamp, a date string, or the raw AIS {month, day, hour, minute} (UTC, next occurrence). */
function etaMs(eta, nowMs) {
  if (eta && typeof eta === 'object') {
    const mo = num(eta.month), dd = num(eta.day), hh = num(eta.hour) ?? 0, mi = num(eta.minute) ?? 0;
    if (!mo || !dd || mo > 12 || dd > 31 || hh > 23 || mi > 59) return null;
    const now = new Date(nowMs); let y = now.getUTCFullYear();
    let t = Date.UTC(y, mo - 1, dd, hh, mi);
    if (t < nowMs - 180 * 86400000) t = Date.UTC(y + 1, mo - 1, dd, hh, mi);
    return t;
  }
  return toMs(eta);
}
/** Navigational status as the AIS code (numbers pass, common words map), or null. */
function navCode(n) {
  const v = num(n); if (v != null) return v;
  if (typeof n !== 'string') return null;
  const s = n.toLowerCase();
  if (/moor/.test(s)) return 5; if (/anchor/.test(s)) return 1; if (/aground/.test(s)) return 6; if (/fishing/.test(s)) return 7;
  if (/sail/.test(s)) return 8; if (/not under command/.test(s)) return 2; if (/restricted/.test(s)) return 3; if (/engine|under ?way/.test(s)) return 0;
  return 15;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad2 = (n) => String(n).padStart(2, '0');
const cleanAisText = (s) => (typeof s === 'string' ? s.replace(/@+/g, ' ').replace(/\s+/g, ' ').trim() : '');

// ------------------------------------------------------------------------------------------------ AIS tables
const NAV_TEXT = ['Under way using engine', 'At anchor', 'Not under command', 'Restricted manoeuvrability', 'Constrained by her draught', 'Moored', 'Aground', 'Engaged in fishing', 'Under way sailing', 'Reserved (HSC)', 'Reserved (WIG)', 'Power-driven, towing astern', 'Pushing ahead / towing alongside', 'Reserved', 'AIS-SART / MOB / EPIRB active', 'Not defined'];
export function navStatusText(nav) {
  if (typeof nav === 'string' && !Number.isFinite(+nav)) return nav ? nav[0].toUpperCase() + nav.slice(1) : 'Not defined';
  const c = num(nav); return c != null && c >= 0 && c < NAV_TEXT.length ? NAV_TEXT[c] : 'Not defined';
}
const TYPE_TEXT = { 30: 'Fishing', 31: 'Towing', 32: 'Towing (over 200 m or 25 m wide)', 33: 'Dredging / underwater operations', 34: 'Diving operations', 35: 'Military operations', 36: 'Sailing', 37: 'Pleasure craft', 50: 'Pilot vessel', 51: 'Search and rescue', 52: 'Tug', 53: 'Port tender', 54: 'Anti-pollution', 55: 'Law enforcement', 56: 'Local vessel', 57: 'Local vessel', 58: 'Medical transport', 59: 'Non-combatant (RR 18)' };
const HAZ = ['', ', hazardous cat. A', ', hazardous cat. B', ', hazardous cat. C', ', hazardous cat. D'];
/** Human text for the AIS ship-and-cargo type code (0–99). */
export function aisTypeText(type) {
  const t = num(type); if (t == null || t <= 0) return 'Unknown type';
  if (TYPE_TEXT[t]) return TYPE_TEXT[t];
  const d = t % 10, h = d >= 1 && d <= 4 ? HAZ[d] : '';
  if (t >= 20 && t < 30) return 'Wing in ground' + h;
  if (t >= 40 && t < 50) return 'High-speed craft' + h;
  if (t >= 60 && t < 70) return 'Passenger' + h;
  if (t >= 70 && t < 80) return 'Cargo' + h;
  if (t >= 80 && t < 90) return 'Tanker' + h;
  if (t >= 90 && t < 100) return 'Other type' + h;
  return 'Reserved type';
}
/** Chart colour family (MarineTraffic-style conventions). */
function typeGroup(type, cls) {
  const t = num(type);
  if (t != null && t > 0) {
    if (t === 30) return 'fishing';
    if (t === 31 || t === 32 || t === 52) return 'tug';
    if (t === 36 || t === 37) return 'pleasure';
    if ((t >= 33 && t <= 35) || (t >= 50 && t <= 59)) return 'special';
    if (t >= 40 && t < 50) return 'hsc';
    if (t >= 60 && t < 70) return 'passenger';
    if (t >= 70 && t < 80) return 'cargo';
    if (t >= 80 && t < 90) return 'tanker';
    return 'other';
  }
  const C = SHIP_CLASSES[cls];
  if (cls === 'tanker') return 'tanker'; if (cls === 'trawler') return 'fishing'; if (cls === 'tug' || cls === 'psv') return 'tug';
  if (cls === 'pilot' || cls === 'cutter') return 'special'; if (cls === 'ferry') return 'passenger';
  if (C?.cat === 'cargo') return 'cargo'; if (C?.cat === 'motor yacht' || C?.cat === 'sailing yacht') return 'pleasure';
  return 'other';
}
const GROUP_COLOR = { cargo: '#6fcf7f', tanker: '#ef6b6b', passenger: '#5aa9f0', fishing: '#f4a261', tug: '#4dd0e1', special: '#4dd0e1', hsc: '#f7dc6f', pleasure: '#d17df5', other: '#aab4bd' };

// MMSI maritime identification digits → ISO 3166 alpha-2 (fallback when the server sends no flag).
const MID_TABLE = '201AL202AD203AT204PT205BE206BY207BG208VA209CY210CY211DE212CY213GE214MD215MT216AM218DE219DK220DK224ES225ES226FR227FR228FR229MT230FI231FO232GB233GB234GB235GB236GI237GR238HR239GR240GR241GR242MA243HU244NL245NL246NL247IT248MT249MT250IE251IS252LI253LU254MC255PT256MT257NO258NO259NO261PL262ME263PT264RO265SE266SE267SK268SM269CH270CZ271TR272UA273RU274MK275LV276EE277LT278SI279RS'
  + '301AI303US304AG305AG306CW307AW308BS309BS310BM311BS312BZ314BB316CA319KY321CR323CU325DM327DO329GP330GD331GL332GT334HN336HT338US339JM341KN343LC345MX347MQ348MS350NI351PA352PA353PA354PA355PA356PA357PA358PR359SV361PM362TT364TC366US367US368US369US370PA371PA372PA373PA374PA375VC376VC377VC378VG379VI'
  + '401AF403SA405BD408BH410BT412CN413CN414CN416TW417LK419IN422IR423AZ425IQ428IL431JP432JP434TM436KZ437UZ438JO440KR441KR443PS445KP447KW450LB451KG453MO455MV457MN459NP461OM463PK466QA468SY470AE471AE472TJ473YE475YE477HK478BA'
  + '501TF503AU506MM508BN510FM511PW512NZ514KH515KH516CX518CK520FJ523CC525ID529KI531LA533MY536MP538MH540NC542NU544NR546PF548PH550TL553PG555PN557SB559AS561WS563SG564SG565SG566SG567TH570TO572TV574VN576VU577VU578WF'
  + '601ZA603AO605DZ607TF608SH609BI610BJ611BW612CF613CM615CG616KM617CV618TF619CI620KM621DJ622EG624ET625ER626GA627GH629GM630GW631GQ632GN633BF634KE635TF636LR637LR638SS642LY644LS645MU647MG649ML650MZ654MR655MW656NE657NG659NA660RE661RW662SD663SN664SC665SH666SO667SL668ST669SZ670TD671TG672TN674TZ675UG676CD677TZ678ZM679ZW'
  + '701AR710BR720BO725CL730CO735EC740FK745GF750GY755PY760PE765SR770UY775VE';
let MID_MAP = null;
/** ISO alpha-2 country of an MMSI's MID (ships 2–7xx, craft 98, aids 99, coast 00, SAR aircraft 111), or null. */
export function midCountry(mmsi) {
  const s = String(mmsi ?? '').replace(/\D/g, '');
  if (s.length < 7) return null;
  if (!MID_MAP) { MID_MAP = new Map(); for (let i = 0; i + 5 <= MID_TABLE.length; i += 5) MID_MAP.set(MID_TABLE.slice(i, i + 3), MID_TABLE.slice(i + 3, i + 5)); }
  const mid = s.startsWith('111') ? s.slice(3, 6) : s.startsWith('98') || s.startsWith('99') || s.startsWith('00') ? s.slice(2, 5) : s[0] === '0' || s[0] === '8' ? s.slice(1, 4) : s.slice(0, 3);
  return MID_MAP.get(mid) || null;
}
const REGIONAL = /(?:\uD83C[\uDDE6-\uDDFF]){2}/;
/** ISO alpha-2 code from the flag field ('NL', '🇳🇱') or the MMSI. */
function flagCode(flag, mmsi) {
  if (typeof flag === 'string') {
    const f = flag.trim();
    if (/^[A-Za-z]{2}$/.test(f)) return f.toUpperCase();
    const m = f.match(REGIONAL);
    if (m) return [...m[0]].map((c) => String.fromCharCode(c.codePointAt(0) - 0x1f1e6 + 65)).join('');
  }
  return midCountry(mmsi);
}
/** Flag emoji (regional indicator pair) for the flag field / MMSI, or ''. */
export function flagEmoji(flag, mmsi) {
  const cc = flagCode(flag, mmsi);
  return cc ? String.fromCodePoint(0x1f1e6 + cc.charCodeAt(0) - 65, 0x1f1e6 + cc.charCodeAt(1) - 65) : '';
}

// ------------------------------------------------------------------------------------------------ model classes
const classDef = (c) => SHIP_CLASSES[c] || EXTRA_CLASSES[c] || null;
/** Game class for an AIS type code when the server sent none (or one this client does not know). */
function classForType(type, L, B) {
  const t = num(type) ?? 0, l = L || 0;
  if (t === 30) return 'trawler';
  if (t === 31 || t === 32 || t === 52) return l > 60 ? 'psv' : 'tug';
  if (t === 50) return 'pilot';
  if (t === 51 || t === 55) return l > 45 ? 'psv' : l && l < 22 ? 'pilot' : 'cutter';
  if ((t >= 33 && t <= 35) || (t >= 53 && t <= 59)) return l > 60 ? 'psv' : l > 25 ? 'tug' : 'pilot';
  if (t === 36) return B && l && B / l > 0.4 ? 'catamaran' : l && l < 13 ? 'sloop' : l && l < 26 ? 'ketch' : l ? 'schooner' : 'sloop';
  if (t === 37) return l && l < 16 ? 'cruiser' : l && l < 45 ? 'myacht' : l ? 'superyacht' : 'cruiser';
  if (t >= 40 && t < 50) return l && l < 30 ? 'pilot' : 'ferry';
  if (t >= 60 && t < 70) return l && l < 35 ? 'myacht' : 'ferry';
  if (t >= 80 && t < 90) return l && l < 120 ? 'coaster' : 'tanker';
  if (t >= 70 && t < 80) return !l || l < 120 ? 'coaster' : l < 175 ? 'feeder' : l < 250 ? 'bulker' : 'boxship';
  if (!l) return 'coaster';
  return l < 15 ? 'cruiser' : l < 30 ? 'pilot' : l < 60 ? 'tug' : l < 120 ? 'coaster' : l < 175 ? 'feeder' : l < 250 ? 'bulker' : 'boxship';
}
/** Model families: a vessel far from its class's own length is drawn with the nearest-sized model of the same family
 *  (keeps the scale near 1, so superstructures, deck gear and the wake stay believable). */
const FAM_CARGO = ['coaster', 'feeder', 'bulker', 'boxship'], FAM_MOTOR = ['cruiser', 'myacht', 'superyacht'], FAM_SAIL = ['sloop', 'ketch', 'schooner'];
const FAMILY = {
  coaster: FAM_CARGO, feeder: FAM_CARGO, bulker: FAM_CARGO, boxship: FAM_CARGO, tanker: ['coaster', 'tanker'],
  tug: ['pilot', 'tug', 'psv'], psv: ['tug', 'psv'], pilot: ['pilot', 'tug'], cutter: ['pilot', 'cutter', 'psv'],
  ferry: ['myacht', 'superyacht', 'ferry'], cruiser: FAM_MOTOR, myacht: FAM_MOTOR, superyacht: FAM_MOTOR,
  sloop: FAM_SAIL, ketch: FAM_SAIL, schooner: FAM_SAIL,
};
function pickModelClass(cls, L) {
  if (!L || !FAMILY[cls]) return cls;
  const r = (c) => Math.abs(Math.log(L / (classDef(c)?.length || L)));
  if (r(cls) <= Math.log(1.6)) return cls;
  let best = cls;
  for (const c of FAMILY[cls]) if (r(c) < r(best) - 0.05) best = c;
  return best;
}

// ------------------------------------------------------------------------------------------------ dead reckoning
/** Position / course / heading of a track at server time `srv` (ms): an arc while the reported turn lasts (turnS),
 *  then straight, holding after endS (both in seconds from the track's position time t). */
function trackAt(tr, srv, out) {
  let tau = (srv - tr.t) / 1000;
  if (!(tau > -10)) tau = -10;
  if (tau > tr.endS) tau = tr.endS;
  out.course = tr.cog; out.hdg = tr.hdg0; out.sog = tr.sog;
  if (!(tr.sog > 0)) { out.lat = tr.lat; out.lon = tr.lon; return out; }
  const v = tr.sog * KN, th0 = tr.cog * D2R;
  const tt = tau > 0 ? Math.min(tau, tr.turnS) : 0;
  let e, n;
  if (tt > 0 && Math.abs(tr.rotS) > 1e-4) {
    const w = tr.rotS * D2R, th1 = th0 + w * tt;
    e = (v / w) * (Math.cos(th0) - Math.cos(th1)) + v * (tau - tt) * Math.sin(th1);
    n = (v / w) * (Math.sin(th1) - Math.sin(th0)) + v * (tau - tt) * Math.cos(th1);
    out.course = normDeg(tr.cog + tr.rotS * tt); out.hdg = normDeg(tr.hdg0 + tr.rotS * tt);
  } else { e = v * tau * Math.sin(th0); n = v * tau * Math.cos(th0); }
  out.lat = tr.lat + n / M_LAT;
  out.lon = wrapLon(tr.lon + e / (M_LON * Math.max(0.01, Math.cos(tr.lat * D2R))));
  return out;
}
/** Planar distance in metres (interaction ranges, snap test). */
function flatDist(lat1, lon1, lat2, lon2) {
  const k = Math.cos(((lat1 + lat2) / 2) * D2R);
  return Math.hypot((lat2 - lat1) * M_LAT, wrapLon(lon2 - lon1) * M_LON * k);
}
const TA = {}, TB = {}, TC = {};

// ------------------------------------------------------------------------------------------------ far-LOD geometry
/** Unit hull prism: beam 1 (x), length 1 (z, bow at -0.5), y from -0.3 to 0.7 (waterline 0). */
function unitHullGeometry() {
  const s = new THREE.Shape();
  s.moveTo(-0.46, -0.5); s.lineTo(0.46, -0.5); s.lineTo(0.5, -0.42); s.lineTo(0.5, 0.2);
  s.quadraticCurveTo(0.45, 0.42, 0, 0.5); s.quadraticCurveTo(-0.45, 0.42, -0.5, 0.2); s.lineTo(-0.5, -0.42); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false, curveSegments: 4 });
  g.rotateX(-Math.PI / 2); // shape y (bow +0.5) → -z, extrusion → +y
  g.translate(0, -0.3, 0);
  g.computeVertexNormals();
  return g;
}
/** Unit deckhouse aft of midships, on top of the hull prism. */
function unitHouseGeometry() { const g = new THREE.BoxGeometry(0.72, 1.3, 0.2); g.translate(0, 0.7 + 0.65, 0.26); return g; }

// ------------------------------------------------------------------------------------------------ labels
const LABEL_CH = 64, LABEL_PX = 30;
const LABEL_FONT = (px) => `600 ${px}px system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
let measureCtx = null;
function measureText(text, px) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = LABEL_FONT(px); return measureCtx.measureText(text).width;
}
function pillPath(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arc(x + w - r, y + r, r, -Math.PI / 2, 0); ctx.lineTo(x + w, y + h - r);
  ctx.arc(x + w - r, y + h - r, r, 0, Math.PI / 2); ctx.lineTo(x + r, y + h); ctx.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI); ctx.lineTo(x, y + r); ctx.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5); ctx.closePath();
}

function fmtDur(sec) {
  const s = Math.abs(Math.round(sec));
  if (s < 60) return `${s} s`;
  const tm = Math.round(s / 60);
  if (tm < 60) return `${tm} min`;
  if (tm < 1440) { const h = Math.floor(tm / 60), m = tm % 60; return m ? `${h} h ${pad2(m)} min` : `${h} h`; }
  const th = Math.round(s / 3600), d = Math.floor(th / 24), h = th % 24; return h ? `${d} d ${h} h` : `${d} d`;
}
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtUtc(ms) { const d = new Date(ms); return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`; }
function fmtLocal(ms) {
  try { return new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }); }
  catch { const d = new Date(ms); return `${WD[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
}
function sourceAttribution(src) {
  const s = String(src || '');
  if (/aisstream/i.test(s)) return 'AIS data: <a href="https://aisstream.io" target="_blank" rel="noopener noreferrer">aisstream.io</a>';
  if (/digitraffic|fintraffic/i.test(s)) return 'AIS data: <a href="https://www.digitraffic.fi/en/marine-traffic/" target="_blank" rel="noopener noreferrer">Fintraffic / digitraffic.fi</a>, <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC BY 4.0</a>';
  return s ? `AIS data: ${esc(s)}` : 'AIS data';
}
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

// ================================================================================================ AisLayer
export class AisLayer {
  /** @param app the client App (scene, camera, origin, ocean, time, night, wind/localWind, ship, renderer) */
  constructor(app) {
    this.app = app;
    this.vessels = new Map();           // id -> internal record (see _create)
    this.visible = true; this.disposed = false;
    this.offset = null;                 // server epoch ms − the caller's clock (see _perf)
    this.group = new THREE.Group(); this.group.name = 'ais';
    this.labelGroup = new THREE.Group(); this.labelGroup.name = 'ais-labels'; this.group.add(this.labelGroup);
    this._rendered = []; this._lastSel = -1e12; this._dirty = true;
    this._pool = new Map(); this._poolCount = 0;
    this._origin = null; this._lightsOn = null;
    this._srv = null;                   // server time of the last update(): what is on screen now
    this._boxVessel = [];
    this._stats = { builds: 0, reused: 0, disposed: 0, snaps: 0, blends: 0 };
    this._m4 = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._p3 = new THREE.Vector3(); this._s3 = new THREE.Vector3(); this._up = new THREE.Vector3(0, 1, 0);
    this._wp = new THREE.Vector3();
    this._hullMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75, metalness: 0.1 });
    this._houseMat = new THREE.MeshStandardMaterial({ color: 0xe9ebe6, roughness: 0.8, metalness: 0.05 });
    this.boxHull = new THREE.InstancedMesh(unitHullGeometry(), this._hullMat, L_.MAX_RENDER);
    this.boxHouse = new THREE.InstancedMesh(unitHouseGeometry(), this._houseMat, L_.MAX_RENDER);
    this.boxHull.setColorAt(0, new THREE.Color(1, 1, 1)); // allocate instanceColor before the first compile
    this.boxHull.instanceColor.setUsage(THREE.DynamicDrawUsage);
    for (const m of [this.boxHull, this.boxHouse]) { m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.frustumCulled = false; m.count = 0; m.name = 'ais-far'; this.group.add(m); }
    app?.scene?.add(this.group);
  }

  // ---------------------------------------------------------------------------------------------- clock
  /** The caller's clock (update()'s nowMs base): explicit nowMs, else performance.now() shifted by the skew seen in
   *  the last update(), so ingests and queries between frames agree with the frames whatever clock the caller uses. */
  _perf(nowMs) { return Number.isFinite(nowMs) && nowMs < 1e12 ? nowMs : performance.now() + (this._skew || 0); }
  _srvAt(perf) { return perf + (this.offset ?? Date.now() - this._perf()); }

  // ---------------------------------------------------------------------------------------------- ingest
  /**
   * Feed AIS records. By default the list is the CURRENT set around the player (snapshot semantics): vessels missing
   * from it for ABSENT_MS are dropped. Pass `{ partial: true }` for delta lists (then only STALE_MS report age drops).
   * @param list AisPublic[] {id, mmsi, name, cls, aisType, flag, lat, lon, sog, cog, hdg, rot, nav, length, beam,
   *             draught, dest, destName, destRaw, from, fromName, eta, t, src}
   * @param serverTimeMs server epoch ms when the list was produced (s or ms accepted; defaults to Date.now())
   * @param opts {partial?: boolean, raw?: boolean, nowMs?: number} raw: lat/lon are as reported at `t`, not
   *             dead-reckoned to serverTimeMs; nowMs: the client clock now, same base as update()'s (default performance.now())
   */
  ingest(list, serverTimeMs, opts = {}) {
    if (this.disposed) return;
    const perf = this._perf(opts.nowMs);
    const st = toMs(serverTimeMs) ?? Date.now();
    const off = st - perf;
    if (this.offset == null || Math.abs(off - this.offset) > 5000) this.offset = off;
    else this.offset += (off - this.offset) * 0.1;
    const srv = this._srvAt(perf);
    const arr = Array.isArray(list) ? list : list && typeof list === 'object' ? Object.values(list) : [];
    for (const d of arr) { try { this._ingestOne(d, srv, st, !!opts.raw); } catch (e) { console.warn('[ais] bad record', d?.id ?? d?.mmsi, e); } }
    const keep = opts.partial ? L_.STALE_MS : L_.ABSENT_MS;
    for (const v of [...this.vessels.values()]) if (srv - v.lastSeen > keep) this._remove(v);
    this._dirty = true;
  }
  _ingestOne(d, srv, st, raw) {
    if (!d || typeof d !== 'object') return;
    const rawId = d.id ?? d.mmsi; if (rawId == null || rawId === '') return;
    const id = String(rawId);
    const lat = num(d.lat), lon = num(d.lon);
    const hasPos = lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
    const tRep = toMs(d.t);
    let v = this.vessels.get(id);
    if (!v) { if (hasPos) this._create(id, d, raw ? tRep ?? st : st, tRep, srv); return; }
    v.lastSeen = srv;
    const prevMode = v.mode, prevNav = v.nav;
    const merged = { ...v.data };
    for (const k in d) if (d[k] !== undefined && d[k] !== null) merged[k] = d[k];
    for (const k of ['dest', 'destName', 'destRaw', 'eta', 'from', 'fromName', 'rot', 'hdg']) if (k in d && d[k] === null) merged[k] = null;
    v.data = merged;
    this._refreshStatic(v);
    if (!hasPos) return;
    const tb = v.tb, sog = validSog(d.sog), cog = validCog(d.cog);
    const samePos = lat === tb.rawLat && lon === tb.rawLon && sog === tb.rawSog && cog === tb.rawCog;
    const t = raw ? tRep ?? (samePos ? tb.t : st) : st;              // time the position refers to
    if (t < tb.t - 500) return;                                      // older than what we have: static data only
    if (samePos && v.mode === prevMode && v.nav === prevNav) return; // the same position again (or a re-stamped one)
    this._newTrack(v, this._makeTrack(v, v.data, t, tRep), srv);
  }
  _create(id, d, t, tRep, srv) {
    const v = {
      id, data: { ...d }, apos: { lat: +d.lat, lon: +d.lon }, pos: { lat: +d.lat, lon: +d.lon }, off: null, ta: null, tb: null, blendT0: 0,
      hdg: 0, hdgT: 0, hdgInit: false, course: 0, sogNow: 0, spd: 0, turnRate: 0, mode: 'underway', nav: null, aisType: null,
      cls: 'coaster', modelCls: null, len: 90, beam: 14, dimsKnown: false, color: GROUP_COLOR.other, color3: new THREE.Color(),
      seed: hashStr(id) % 97 + 1, wear: 0.05 + ((hashStr(id) >>> 8) % 1000) / 1000 * 0.35, swingPh: ((hashStr(id) >>> 4) % 628) / 100, swingT: 240 + (hashStr(id) % 180),
      lod: 0, want: 0, model: null, noModel: null, root: null, label: null, labelText: '', labelDirty: true, labelSel: false, labelA: 0,
      vis: { heave: 0, pitch: 0, roll: 0 }, dist: Infinity, lastSeen: srv, removed: false, sailT: 0, wakeReset: false,
    };
    this._refreshStatic(v);
    v.tb = this._makeTrack(v, v.data, t, tRep);
    this.vessels.set(id, v);
    this._state(v, srv);
    v.hdg = v.hdgT;
  }
  /** Class, model class, dimensions, mode, colours from the merged record; swaps / rescales the model when needed. */
  _refreshStatic(v) {
    const d = v.data;
    v.nav = navCode(d.navStatus ?? d.nav);
    const sog = validSog(d.sog) ?? 0;
    v.mode = (v.nav === 5 || v.nav === 6) && sog < 1.5 ? 'moored' : v.nav === 1 && sog < 1.5 ? 'anchored' : sog < 0.3 ? 'drifting' : 'underway';
    v.aisType = num(d.aisType);
    const rawL = validLen(d.length); let rawB = validBeam(d.beam);
    if (rawL && rawB && rawB > rawL * 0.75) rawB = null; // A+B / C+D mix-ups
    const cls = typeof d.cls === 'string' && classDef(d.cls) ? d.cls : classForType(v.aisType, rawL, rawB);
    v.cls = cls;
    const mc = pickModelClass(cls, rawL);
    const C = classDef(mc) || SHIP_CLASSES.coaster;
    let L = rawL, B = rawB;
    if (L && !B) B = (L * C.beam) / C.length;
    else if (B && !L) L = (B * C.length) / C.beam;
    else if (!L) { L = C.length; B = C.beam; }
    const dimsChanged = Math.abs(L - v.len) > 0.01 || Math.abs(B - v.beam) > 0.01;
    v.len = L; v.beam = B; v.dimsKnown = !!(rawL || rawB);
    v.boxH = clamp(L * 0.075, 1.2, 24);
    // antenna → hull centre offset [m forward, m to starboard] (server: off = [(A − B) / 2, (D − C) / 2])
    const o = Array.isArray(d.off) ? d.off : null;
    v.off = o && Number.isFinite(+o[0]) && Number.isFinite(+o[1]) && Math.abs(o[0]) <= L / 2 + 5 && Math.abs(o[1]) <= B / 2 + 3 && (o[0] || o[1]) ? [+o[0], +o[1]] : null;
    v.color = GROUP_COLOR[typeGroup(v.aisType, cls)];
    v.color3.set(C.hullColor ?? 0x556677).lerp(new THREE.Color(0xb8c2cc), 0.3);
    if (mc !== v.modelCls) {
      v.modelCls = mc;
      if (v.model) { this._releaseModel(v); this._dirty = true; } // the per-frame pass re-acquires (pooled models first)
    } else if (dimsChanged && v.model) this._applyScale(v);
    const text = this._labelText(v);
    if (text !== v.labelText) { v.labelText = text; v.labelDirty = true; }
  }
  /** Track from a record whose position refers to time t (ms); tRep = report time (bounds the DR and turn windows). */
  _makeTrack(v, d, t, tRep) {
    const sog = validSog(d.sog) ?? 0, cog = validCog(d.cog), hdg = validHdg(d.hdg), rot = validRot(d.rot);
    const moving = v.mode === 'underway';
    const course = cog ?? hdg ?? (v.tb ? v.course : null) ?? 0;
    const head = hdg ?? (moving || !v.tb ? course : v.hdgT);
    const age = tRep != null && tRep <= t ? (t - tRep) / 1000 : 0;   // DR the server already applied
    const rotDm = moving && rot != null && Math.abs(rot) >= L_.ROT_MIN ? clamp(rot, -L_.ROT_MAX, L_.ROT_MAX) : 0;
    return {
      lat: +d.lat, lon: +d.lon, t, sog: moving ? sog : 0, cog: course, hdg0: head, rotS: rotDm / 60,
      turnS: rotDm ? Math.max(0, L_.ROT_HORIZON_S - age) : 0, endS: Math.max(0, L_.MAX_DR_S - age),
      rawLat: num(d.lat), rawLon: num(d.lon), rawSog: validSog(d.sog), rawCog: validCog(d.cog),
    };
  }
  /** Converge from the displayed track to a new one over BLEND_MS (or snap when the error is huge / nobody sees it).
   *  The blend is anchored at the last rendered frame's time, so it starts exactly from what is on screen whatever
   *  clock the caller passes to update(). */
  _newTrack(v, nb, srvNow) {
    if (v.lod === 0 || this._srv == null) { v.ta = null; v.tb = nb; this._state(v, srvNow); v.hdgInit = false; return; }
    const srv = this._srv;
    this._state(v, srv);
    const b = trackAt(nb, srv, TB);
    const err = flatDist(v.apos.lat, v.apos.lon, b.lat, b.lon);
    if (err > L_.SNAP_M) {
      v.ta = null; v.tb = nb; v.hdgInit = false; v.wakeReset = true; this._stats.snaps++;
      this._state(v, srv);
      return;
    }
    // the same prediction again (a server snapshot re-dead-reckoning an unchanged report): swap it in and let any
    // running blend finish undisturbed — restarting it every snapshot would never let it converge
    const c = trackAt(v.tb, srv, TC);
    if (flatDist(c.lat, c.lon, b.lat, b.lon) < 1 && Math.abs(angleDiff(c.course, b.course)) < 2 && Math.abs(c.sog - b.sog) < 0.5 && Math.abs(angleDiff(c.hdg, b.hdg)) < 3) { v.tb = nb; return; }
    // mid-blend: freeze what is on screen into a straight track and converge from there
    v.ta = v.ta ? { lat: v.apos.lat, lon: v.apos.lon, t: srv, sog: v.sogNow, cog: v.course, hdg0: v.hdgT, rotS: 0, turnS: 0, endS: L_.BLEND_MS / 1000 } : v.tb;
    v.tb = nb; v.blendT0 = srv; this._stats.blends++;
  }
  /** Blended dead-reckoned state at server time srv → v.pos, v.hdgT (target heading), v.course, v.sogNow. */
  _state(v, srv) {
    const b = trackAt(v.tb, srv, TB);
    let lat = b.lat, lon = b.lon, hdg = b.hdg, course = b.course, sog = b.sog;
    if (v.ta) {
      const u = (srv - v.blendT0) / L_.BLEND_MS;
      if (u >= 1) v.ta = null;
      else {
        const a = trackAt(v.ta, srv, TA), s = smooth(u);
        lat = a.lat + (b.lat - a.lat) * s; lon = wrapLon(a.lon + wrapLon(b.lon - a.lon) * s);
        hdg = normDeg(a.hdg + angleDiff(a.hdg, b.hdg) * s); course = normDeg(a.course + angleDiff(a.course, b.course) * s); sog = a.sog + (b.sog - a.sog) * s;
      }
    }
    v.apos.lat = lat; v.apos.lon = lon; v.course = course; v.sogNow = sog;
    if (v.mode === 'anchored') {
      // swing slowly around the anchor: reported heading (it follows wind and stream) or the wind, ± a slow yaw
      const base = validHdg(v.data.hdg) ?? this._windFrom() ?? hdg;
      v.hdgT = normDeg(base + 7 * Math.sin((srv / 1000) * (2 * Math.PI / v.swingT) + v.swingPh));
    } else v.hdgT = hdg;
    this._centre(v, v.lod > 0 && v.hdgInit ? v.hdg : v.hdgT);
  }
  /** Hull centre (v.pos) from the antenna position (v.apos), the heading and the antenna offset. */
  _centre(v, hdgDeg) {
    const o = v.off;
    if (!o) { v.pos.lat = v.apos.lat; v.pos.lon = v.apos.lon; return; }
    const h = hdgDeg * D2R, sh = Math.sin(h), ch = Math.cos(h);
    const e = sh * o[0] + ch * o[1], n = ch * o[0] - sh * o[1]; // forward (sin h, cos h), starboard (cos h, −sin h)
    v.pos.lat = v.apos.lat + n / M_LAT;
    v.pos.lon = wrapLon(v.apos.lon + e / (M_LON * Math.max(0.01, Math.cos(v.apos.lat * D2R))));
  }
  _windFrom() {
    const w = this.app?.localWind || this.app?.wind; if (!w) return null;
    if (Number.isFinite(w.dir)) return w.dir;
    if (Number.isFinite(w.u) && Number.isFinite(w.v) && (w.u || w.v)) return normDeg(Math.atan2(-w.u, -w.v) / D2R);
    return null;
  }

  /** Drop one vessel by id (e.g. a server 'ais_gone' event). */
  remove(id) { const v = this.vessels.get(String(id)); if (v) this._remove(v); }
  /** Drop every vessel (feed switched off). */
  clear() { for (const v of [...this.vessels.values()]) this._remove(v); }
  _remove(v) {
    v.removed = true; this._releaseModel(v); this._dropLabel(v);
    if (v.root?.parent) v.root.parent.remove(v.root);
    this.vessels.delete(v.id); this._dirty = true;
  }

  // ---------------------------------------------------------------------------------------------- per frame
  /** Advance every vessel and its visuals. Call once per frame before rendering. nowMs: performance.now() (default). */
  update(dt, nowMs) {
    if (this.disposed) return;
    const app = this.app; if (!app?.origin || !app.camera) return;
    dt = clamp(Number(dt) || 0, 0, 0.25);
    const perf = this._perf(nowMs), srv = this._srvAt(perf); this._srv = srv;
    this._skew = Number.isFinite(nowMs) && nowMs < 1e12 ? nowMs - performance.now() : 0;
    this._checkOrigin();
    const lightsOn = (app.night ?? 0) > 0.5;
    if (lightsOn !== this._lightsOn) { this._lightsOn = lightsOn; for (const v of this.vessels.values()) v.model?.userData.setLights?.(lightsOn ? 1 : 0); }
    if (this._dirty || perf - this._lastSel > L_.SELECT_MS) { this._lastSel = perf; this._dirty = false; this._select(srv); }
    if (!this.visible) { this.boxHull.count = 0; this.boxHouse.count = 0; return; }
    const cam = app.camera.position, t = Number.isFinite(app.time) ? app.time : perf / 1000;
    const level = app.ocean?.level ?? 0;
    const el = app.renderer?.domElement;
    const vw = el?.clientWidth || (typeof innerWidth === 'number' ? innerWidth : 1280), vh = el?.clientHeight || (typeof innerHeight === 'number' ? innerHeight : 800);
    const pxK = (2 * Math.tan(((app.camera.fov || 60) * D2R) / 2)) / Math.max(200, vh);
    this._ui = clamp(vw / 1280, 0.7, 1); // narrower screens get smaller labels
    const t0 = performance.now(); let built = 0, nBox = 0;
    for (const v of this._rendered) {
      if (v.removed || v.lod === 0) continue;
      this._state(v, srv);
      // heading eases toward the predicted / reported heading; spd toward SOG (wake, heel)
      if (!v.hdgInit) { v.hdg = v.hdgT; v.hdgInit = true; v.turnRate = 0; }
      else {
        const slow = v.mode === 'anchored';
        const maxRate = slow ? 0.6 : Math.max(2, 400 / Math.max(10, v.len));
        const step = clamp(angleDiff(v.hdg, v.hdgT) * Math.min(1, dt * (slow ? 0.08 : 1.2)), -maxRate * dt, maxRate * dt);
        v.hdg = normDeg(v.hdg + step);
        if (dt > 0) v.turnRate += (step / dt - v.turnRate) * Math.min(1, dt * 2);
      }
      v.spd += (v.sogNow - v.spd) * Math.min(1, dt * 0.8);
      if (v.off) this._centre(v, v.hdg);
      const p = toLocal(v.pos.lat, v.pos.lon, app.origin);
      v.dist = Math.hypot(p.x - cam.x, p.z - cam.z);
      // models: pooled ones are free, fresh builds inside the frame budget (nearest first: _rendered is sorted)
      if (v.lod === 2 && !v.model && (this._pool.get(v.modelCls)?.length || built === 0 || performance.now() - t0 < L_.BUILD_BUDGET_MS)) {
        if (this._acquireModel(v)) built += v.model?.userData.aisFresh ? 1 : 0;
      }
      let topY;
      if (v.lod === 2 && v.model) topY = this._placeFull(v, p, dt, t);
      else {
        if (nBox >= L_.MAX_RENDER) continue;
        const h = v.hdg * D2R;
        this._q.setFromAxisAngle(this._up, -h);
        this._m4.compose(this._p3.set(p.x, level, p.z), this._q, this._s3.set(v.beam, v.boxH, v.len));
        this.boxHull.setMatrixAt(nBox, this._m4); this.boxHouse.setMatrixAt(nBox, this._m4); this.boxHull.setColorAt(nBox, v.color3);
        this._boxVessel[nBox++] = v;
        topY = level + v.boxH * 2;
      }
      if (v.labelSel) this._placeLabel(v, p, topY, cam, pxK);
    }
    this._boxVessel.length = nBox;
    for (const m of [this.boxHull, this.boxHouse]) { m.count = nBox; m.instanceMatrix.needsUpdate = true; }
    if (this.boxHull.instanceColor) this.boxHull.instanceColor.needsUpdate = true;
    this._declutter(dt, vw, vh);
  }
  /** Screen-space declutter: nearest labels win, overlapped ones fade out (and back in when clear). */
  _declutter(dt, vw, vh) {
    const cam = this.app.camera, p = this._p3, placed = [], k = Math.min(1, dt * 6);
    const items = [];
    for (const v of this._rendered) if (v.labelSel && v.label && !v.removed && v.lod > 0) items.push(v);
    items.sort((a, b) => a.dist - b.dist);
    for (const v of items) {
      const s = v.label, u = s.userData;
      p.copy(s.position).project(cam);
      let show = p.z > -1 && p.z < 1 && Math.abs(p.x) < 1.3 && Math.abs(p.y) < 1.3;
      if (show) {
        const sx = (p.x * 0.5 + 0.5) * vw, sy = (0.5 - p.y * 0.5) * vh, h = u.hPx, w = (u.need * h) / LABEL_CH;
        const r = { x0: sx - w / 2 - 3, x1: sx + w / 2 + 3, y0: sy - (h * 57) / LABEL_CH - 1, y1: sy - (h * 7) / LABEL_CH + 1 };
        for (const q of placed) if (r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0) { show = false; break; }
        if (show) placed.push(r);
      }
      v.labelA += ((show ? 1 : 0) - v.labelA) * k;
      s.material.opacity = v.labelA * u.fade;
      s.visible = s.material.opacity > 0.02;
    }
  }
  /** Floating-origin moves: positions follow by themselves (they are recomputed from lat/lon every frame); a wake
   *  shifts its own trail only on jumps > 2.5 km, so short anchor-origin moves reset the trails instead. */
  _checkOrigin() {
    const o = this.app.origin;
    if (!this._origin) { this._origin = { lat: o.lat, lon: o.lon }; return; }
    if (o.lat === this._origin.lat && o.lon === this._origin.lon) return;
    const p = toLocal(o.lat, o.lon, this._origin);
    this._origin = { lat: o.lat, lon: o.lon };
    if (Math.hypot(p.x, p.z) < 2600) for (const v of this.vessels.values()) v.model?.userData.resetWake?.();
    this._dirty = true;
  }
  /** LOD, render cap, model cap and label choice for every vessel (every SELECT_MS or when something changed). */
  _select(srv) {
    const app = this.app, cam = app.camera.position;
    const cand = [];
    for (const v of this.vessels.values()) {
      this._state(v, srv);
      const p = toLocal(v.pos.lat, v.pos.lon, app.origin);
      const d = Math.hypot(p.x - cam.x, p.z - cam.z); v.dist = d;
      const fullIn = L_.FULL_M + (v.lod === 2 ? L_.HYST_M : 0), showIn = L_.BOX_M + (v.lod > 0 ? L_.HYST_M * 2 : 0);
      v.want = !this.visible ? 0 : d < fullIn ? 2 : d < showIn ? 1 : 0;
      if (v.want > 0) cand.push(v);
    }
    cand.sort((a, b) => a.dist - b.dist);
    let nFull = 0, nLab = 0;
    const rendered = [];
    for (let i = 0; i < cand.length; i++) {
      const v = cand[i];
      if (i >= L_.MAX_RENDER) { v.want = 0; continue; }
      if (v.want === 2) { if (nFull < L_.MAX_FULL && v.noModel !== v.modelCls) nFull++; else v.want = 1; }
      rendered.push(v);
    }
    for (const v of this.vessels.values()) {
      if (v.want !== v.lod) {
        if (v.want < 2 && v.model) this._releaseModel(v);
        if (v.lod === 0) v.hdgInit = false;
        v.lod = v.want;
      }
      if (v.lod === 0 && (v.labelSel || v.label)) { v.labelSel = false; this._dropLabel(v); }
    }
    // labels: the nearest rendered vessels within range (tighter for moored / anchored ones)
    for (const v of rendered) {
      let lab = false;
      if (nLab < L_.MAX_LABELS) {
        const lim = (v.mode === 'moored' || v.mode === 'anchored' ? L_.LABEL_MOORED_M : L_.LABEL_M) + (v.labelSel ? 150 : 0);
        lab = v.dist < lim;
      }
      if (lab) nLab++;
      if (lab && !v.labelSel) v.labelA = 0; // newly labelled: fade in
      if (!lab && v.label) this._dropLabel(v);
      v.labelSel = lab;
    }
    this._rendered = rendered;
  }

  // ---------------------------------------------------------------------------------------------- models
  _acquireModel(v) {
    const cls = v.modelCls; let m = null;
    const arr = this._pool.get(cls);
    if (arr?.length) { m = arr.pop(); this._poolCount--; this._stats.reused++; m.userData.aisFresh = false; }
    else {
      try { m = buildShip(cls, '', v.seed); } catch (e) { console.warn('[ais] buildShip failed', cls, e); v.noModel = cls; v.lod = 1; v.want = 1; return false; }
      const box = new THREE.Box3().setFromObject(m);
      m.userData.aisTop = Number.isFinite(box.max.y) ? box.max.y : (m.userData.freeboard || 4) + 10;
      m.userData.aisCls = cls; m.userData.aisFresh = true; this._stats.builds++;
    }
    const ud = m.userData;
    ud.resetWake?.();
    if (!v.root) { v.root = new THREE.Group(); v.root.name = 'ais-vessel'; v.root.userData.aisId = v.id; }
    v.model = m; v.root.add(m);
    if (!v.root.parent) this.group.add(v.root);
    this._applyScale(v);
    ud.setWear?.(v.wear); ud.setLights?.(this._lightsOn ? 1 : 0);
    if (ud.wakeGroup) { ud.wakeGroup.visible = this.visible; if (!ud.wakeGroup.parent) this.app.scene.add(ud.wakeGroup); }
    v.vis.heave = this.app.ocean?.level ?? 0; v.vis.pitch = 0; v.vis.roll = 0; v.sailT = 0;
    return true;
  }
  /** Scale the class model to the real AIS size: x by beam, z by length, y by a freeboard factor that grows slower
   *  than the plan (air draft scales roughly with length^0.75). Unknown dimensions keep the model's own proportions. */
  _applyScale(v) {
    const ud = v.model.userData, Lm = ud.length || v.len, Bm = ud.beam || v.beam;
    const sx = v.beam / Bm, sz = v.len / Lm;
    const sy = clamp(Math.pow(sx * sz, 0.375), 0.35, 3.5);
    v.model.scale.set(sx, sy, sz); v.sy = sy; v.Lm = Lm;
  }
  _releaseModel(v) {
    const m = v.model; if (!m) return;
    v.model = null;
    m.parent?.remove(m);
    if (v.root?.parent) v.root.parent.remove(v.root);
    const ud = m.userData;
    if (ud.wakeGroup?.parent) ud.wakeGroup.parent.remove(ud.wakeGroup);
    ud.resetWake?.(); m.scale.set(1, 1, 1);
    const cls = ud.aisCls; let arr = this._pool.get(cls);
    if (!this.disposed && (!arr || arr.length < L_.POOL_PER_CLS) && this._poolCount < L_.POOL_MAX) {
      if (!arr) this._pool.set(cls, (arr = []));
      arr.push(m); this._poolCount++;
    } else { ud.dispose?.(); this._stats.disposed++; }
  }
  /** Full model: real-size wave sampling (bow / stern / both beams, more points on long hulls), heel in turns, wake. */
  _placeFull(v, p, dt, t) {
    const app = this.app, root = v.root, ud = v.model.userData, vis = v.vis;
    const L = v.len, B = v.beam, h = v.hdg * D2R, fx = Math.sin(h), fz = -Math.cos(h);
    const oc = app.ocean, level = oc?.level ?? 0;
    const wave = oc?.heightAt ? (x, z) => oc.heightAt(x, z, t) : () => level;
    const hb = wave(p.x + fx * L * 0.4, p.z + fz * L * 0.4), hs = wave(p.x - fx * L * 0.4, p.z - fz * L * 0.4);
    const hp = wave(p.x - fz * B * 0.5, p.z + fx * B * 0.5), hst = wave(p.x + fz * B * 0.5, p.z - fx * B * 0.5);
    let mean = (hb + hs + hp + hst) / 4;
    if (L > 120) mean = (hb + hs + hp + hst + wave(p.x + fx * L * 0.2, p.z + fz * L * 0.2) + wave(p.x - fx * L * 0.2, p.z - fz * L * 0.2)) / 6;
    const damp = v.mode === 'moored' ? 0.3 : 1;
    const k = Math.min(1, dt * 2.5 * clamp(Math.sqrt(80 / L), 0.4, 1.4)); // long hulls answer the sea more slowly
    const heel = clamp(0.004 * v.spd * KN * v.turnRate, -0.06, 0.06);  // outward heel in a turn
    vis.heave += (level + (mean - level) * damp - vis.heave) * k;
    vis.pitch += (Math.atan2(hb - hs, L * 0.8) * damp - vis.pitch) * k;
    vis.roll += (Math.atan2(hp - hst, B) * damp + heel - vis.roll) * k;
    root.position.set(p.x, vis.heave, p.z);
    root.rotation.set(vis.pitch, -h, vis.roll, 'YXZ');
    ud.setWaterY?.(vis.heave);
    if (ud.updateWake) {
      if (ud.wakeGroup && !ud.wakeGroup.parent) app.scene.add(ud.wakeGroup);
      if (v.wakeReset) { ud.resetWake?.(); v.wakeReset = false; }
      // the wake knows the MODEL length: shift its reference point so the Kelvin V starts at the real bow (upscaled
      // hulls: the ribbon then starts under the hull) or, for slightly downscaled hulls, the ribbon at the real stern
      const Lm = v.Lm || L, sternExact = 0.47 * (Lm - L), bowExact = 0.42 * (L - Lm);
      const s = L >= Lm || 0.89 * (Lm - L) > Math.max(2, 0.06 * L) ? bowExact : sternExact;
      ud.updateWake(dt, this._wp.set(p.x + fx * s, vis.heave, p.z + fz * s), h, v.mode === 'moored' || v.mode === 'anchored' ? 0 : v.spd);
    }
    if (ud.isSail && ud.setSails && (v.sailT -= dt) <= 0) {
      v.sailT = 0.5;
      const sailing = v.mode === 'underway' && (v.nav === 8 || (v.nav !== 0 && v.spd > 3));
      const wf = this._windFrom();
      ud.setSails(sailing, wf == null ? 90 : angleDiff(v.hdg, wf));          // signed relative wind (+ = from starboard): sails to leeward
    }
    return vis.heave + (ud.aisTop || 10) * (v.sy || 1);
  }

  // ---------------------------------------------------------------------------------------------- labels
  _labelText(v) {
    const d = v.data;
    const name = cleanAisText(d.name) || `MMSI ${d.mmsi ?? v.id}`;
    const flag = flagEmoji(d.flag, d.mmsi);
    const dest = cleanAisText(d.destName) || cleanAisText(d.dest) || cleanAisText(d.destRaw);
    const sog = validSog(d.sog) ?? 0;
    const tail = v.mode === 'moored' ? (v.nav === 6 ? 'aground' : 'moored') : v.mode === 'anchored' ? 'at anchor' : `${sog.toFixed(1)} kn`;
    return `${name}${flag ? ' ' + flag : ''}${dest ? ' → ' + dest : ''} · ${tail}`;
  }
  _drawLabel(v) {
    const text = v.labelText;
    let px = LABEL_PX, w = measureText(text, px);
    if (w > 1024 - 70) { px = Math.max(16, Math.floor((px * (1024 - 70)) / w)); w = measureText(text, px); }
    const need = Math.ceil(w + 62), cw = clamp(Math.ceil(need / 128) * 128, 256, 1024);
    let s = v.label;
    if (!s || s.userData.cw !== cw) {
      if (s) this._dropLabel(v);
      const c = document.createElement('canvas'); c.width = cw; c.height = LABEL_CH;
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 2;
      s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, fog: false }));
      s.center.set(0.5, 0); s.renderOrder = 20; s.name = 'ais-label';
      s.userData = { cw, aspect: cw / LABEL_CH, ctx: c.getContext('2d'), tex, aisId: v.id };
      s.material.opacity = v.labelA; s.visible = v.labelA > 0.02; // a re-sized label keeps its fade state
      v.label = s; this.labelGroup.add(s);
    }
    const ctx = s.userData.ctx, x0 = (cw - need) / 2;
    s.userData.need = need;
    ctx.clearRect(0, 0, cw, LABEL_CH);
    pillPath(ctx, x0 + 1, 7, need - 2, 50, 18);
    ctx.fillStyle = 'rgba(5,14,24,0.74)'; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.stroke();
    ctx.beginPath(); ctx.arc(x0 + 23, 32, 7, 0, Math.PI * 2); ctx.fillStyle = v.color; ctx.fill();
    ctx.font = LABEL_FONT(px); ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#ffffff';
    ctx.fillText(text, x0 + 40, 33);
    s.userData.tex.needsUpdate = true;
    v.labelDirty = false;
  }
  /** Constant on-screen size (≈ 40 px tall close by, 28 px at the label range, × 0.7–1 by screen width), anchored
   *  above the masthead; opacity is set by _declutter. */
  _placeLabel(v, p, topY, cam, pxK) {
    if (!v.label || v.labelDirty) this._drawLabel(v);
    const s = v.label, y = topY + 3;
    const d3 = Math.hypot(p.x - cam.x, y - cam.y, p.z - cam.z);
    const lim = v.mode === 'moored' || v.mode === 'anchored' ? L_.LABEL_MOORED_M : L_.LABEL_M;
    const f = clamp(v.dist / lim, 0, 1);
    const hPx = (40 - 12 * f) * (this._ui || 1), hW = Math.max(0.5, d3 * pxK * hPx);
    s.position.set(p.x, y, p.z);
    s.scale.set(hW * s.userData.aspect, hW, 1);
    s.userData.hPx = hPx; s.userData.fade = 1 - smooth((f - 0.85) / 0.15);
  }
  _dropLabel(v) {
    const s = v.label; if (!s) return;
    v.label = null; v.labelDirty = true;
    s.parent?.remove(s); s.userData.tex?.dispose(); s.material.dispose();
  }

  // ---------------------------------------------------------------------------------------------- queries
  /** Bring positions up to date for a query: hidden vessels always, all of them when no frame ran for 100 ms. */
  _fresh() {
    const srv = this._srvAt(this._perf()), all = this._srv == null || Math.abs(srv - this._srv) > 100;
    for (const v of this.vessels.values()) if (all || v.lod === 0) this._state(v, srv);
    return srv;
  }
  /**
   * Hulls for collision.resolveShip: [{id, lat, lon, hdg, spd (kn), length, beam}] (real AIS size).
   * Moored vessels are left out by default (real ships lie at the berths the game snaps players to); only vessels
   * within rangeM of the player's ship (default 1500 m; 0 = all).
   */
  others(opts = {}) {
    this._fresh();
    const ship = this.app?.ship, range = opts.rangeM ?? 1500, out = [];
    for (const v of this.vessels.values()) {
      if (v.mode === 'moored' && !opts.includeMoored) continue;
      if (ship && range > 0 && Number.isFinite(ship.lat) && flatDist(ship.lat, ship.lon, v.pos.lat, v.pos.lon) > range + v.len) continue;
      out.push({ id: v.id, lat: v.pos.lat, lon: v.pos.lon, hdg: v.lod > 0 ? v.hdg : v.hdgT, spd: v.mode === 'underway' ? v.sogNow : 0, length: v.len, beam: v.beam });
    }
    return out;
  }
  /** Radar / chart contacts for every known vessel (rendered or not). */
  contacts() {
    this._fresh();
    const out = [];
    for (const v of this.vessels.values()) {
      const d = v.data;
      out.push({
        kind: 'ais', id: v.id, mmsi: d.mmsi ?? null, lat: v.pos.lat, lon: v.pos.lon, hdg: v.lod > 0 ? v.hdg : v.hdgT, color: v.color,
        label: cleanAisText(d.name) || `MMSI ${d.mmsi ?? v.id}`, cls: v.cls, length: v.len,
        beam: v.beam, spd: validSog(d.sog) ?? 0, cog: v.course, dest: cleanAisText(d.destName) || cleanAisText(d.dest) || null, nav: v.nav, state: v.mode, flag: flagEmoji(d.flag, d.mmsi),
      });
    }
    return out;
  }
  /** The vessel under a THREE.Raycaster (models, far boxes, labels; generous fallback for small distant hulls), or null. */
  pick(raycaster) {
    if (!raycaster?.ray || !this.visible || this.disposed) return null;
    const ray = raycaster.ray, sphere = new THREE.Sphere();
    const roots = [];
    for (const v of this._rendered) if (v.model && v.root?.parent && !v.removed) { sphere.set(v.root.position, v.len * 0.6 + 10); if (ray.intersectsSphere(sphere)) { v.root.updateMatrixWorld(true); roots.push(v.root); } }
    let best = null, bestD = Infinity;
    const consider = (v, d) => { if (v && !v.removed && d < bestD) { bestD = d; best = v; } };
    for (const hit of raycaster.intersectObjects(roots, true)) { let o = hit.object; while (o && o.userData.aisId == null) o = o.parent; if (o) consider(this.vessels.get(o.userData.aisId), hit.distance); }
    if (this.boxHull.count > 0) {
      this.boxHull.computeBoundingSphere();
      for (const hit of raycaster.intersectObject(this.boxHull, false)) consider(this._boxVessel[hit.instanceId], hit.distance);
    }
    const labels = this.labelGroup.children.filter((s) => s.visible);
    if (labels.length) {
      const hadCam = raycaster.camera; if (!hadCam) raycaster.camera = this.app.camera;
      try { for (const hit of raycaster.intersectObjects(labels, false)) consider(this.vessels.get(hit.object.userData.aisId), hit.distance); }
      finally { if (!hadCam) raycaster.camera = hadCam; }
    }
    if (!best) { // near miss: the closest rendered vessel whose (distance-inflated) bounding sphere the ray passes
      const c = new THREE.Vector3(), cam = this.app.camera.position;
      for (const v of this._rendered) {
        if (v.removed || v.lod === 0) continue;
        const p = toLocal(v.pos.lat, v.pos.lon, this.app.origin); c.set(p.x, v.root?.parent ? v.root.position.y : 0, p.z);
        const d = c.distanceTo(cam);
        if (ray.distanceToPoint(c) < Math.max(v.len * 0.6, d * 0.015)) consider(v, d);
      }
    }
    return best ? best.data : null;
  }
  _find(x) {
    if (x == null) return null;
    if (typeof x === 'string' || typeof x === 'number') return this.vessels.get(String(x)) || null;
    if (x.data && x.tb) return x;
    const id = x.id ?? x.mmsi; return id != null ? this.vessels.get(String(id)) || null : null;
  }
  /** HTML info card for a vessel (an AisPublic from pick(), an id, or a contact). All AIS text is escaped. */
  info(vessel) {
    const v = this._find(vessel);
    const d = v ? v.data : vessel && typeof vessel === 'object' ? vessel : null;
    if (!d) return '';
    const srv = this._fresh();
    if (v) this._state(v, srv);
    const name = cleanAisText(d.name) || `MMSI ${d.mmsi ?? d.id}`;
    const cc = flagCode(d.flag, d.mmsi), fe = flagEmoji(d.flag, d.mmsi);
    const flagTxt = cc ? `${fe} ${cc}` : typeof d.flag === 'string' && d.flag.trim() ? esc(d.flag) : '—';
    const type = num(d.aisType), cls = v?.cls || d.cls;
    const typeTxt = type ? `${esc(aisTypeText(type))} <span style="opacity:.6">(AIS ${type})</span>` : esc(SHIP_CLASSES[cls]?.name || 'Unknown type');
    const L = validLen(d.length), B = validBeam(d.beam), dr = num(d.draught);
    const sizeTxt = (L || B ? `${L ? Math.round(L) : '?'} × ${B ? Math.round(B) : '?'} m` : `unknown${v ? ` <span style="opacity:.6">(shown as ${Math.round(v.len)} × ${Math.round(v.beam)} m)</span>` : ''}`) + (dr && dr > 0 ? ` · draught ${dr.toFixed(1)} m` : '');
    const sog = validSog(d.sog), cog = validCog(d.cog), hdg = validHdg(d.hdg), rot = validRot(d.rot);
    const motion = [`${sog != null ? sog.toFixed(1) : '—'} kn`, `COG ${cog != null ? String(Math.round(cog)).padStart(3, '0') + '°' : '—'}`, `HDG ${hdg != null ? String(Math.round(hdg)).padStart(3, '0') + '°' : '—'}`];
    if (rot != null && Math.abs(rot) >= 0.5) motion.push(`ROT ${rot > 0 ? '+' : ''}${Math.round(rot)}°/min`);
    const from = cleanAisText(d.fromName) || cleanAisText(d.from), to = cleanAisText(d.destName) || cleanAisText(d.dest), raw = cleanAisText(d.destRaw);
    const toTxt = (to ? esc(to) : raw ? esc(raw) : '—') + (raw && to && raw.toUpperCase() !== to.toUpperCase() ? ` <span style="opacity:.6">(AIS: ${esc(raw)})</span>` : '');
    const eta = etaMs(d.eta, srv);
    const etaTxt = eta ? `${esc(fmtLocal(eta))} · ${fmtUtc(eta)} <span style="opacity:.6">(${eta >= srv ? 'in ' + fmtDur((eta - srv) / 1000) : fmtDur((srv - eta) / 1000) + ' ago'})</span>` : '—';
    const t = toMs(d.t), age = t ? `${fmtDur(Math.max(0, srv - t) / 1000)} ago` : '—';
    const lat = v ? v.apos.lat : num(d.lat), lon = v ? v.apos.lon : num(d.lon);
    const rows = [
      ['MMSI', esc(d.mmsi ?? '—')], ['IMO', num(d.imo) > 0 ? esc(d.imo) : '—'], ['Flag', flagTxt], ['Type', typeTxt], ['Size', sizeTxt],
      ['Speed / course', esc(motion.join(' · '))], ['Status', esc(navStatusText(d.navStatus ?? d.nav))],
      ['From', from ? esc(from) : '—'], ['To', toTxt], ['ETA', etaTxt],
    ];
    if (Number.isFinite(lat) && Number.isFinite(lon)) rows.push(['Position', `${fmtDMS(lat, true)} ${fmtDMS(lon, false)}`]);
    const own = this.app?.ship;
    if (own && Number.isFinite(own.lat) && Number.isFinite(lat)) {
      const rng = haversine(own.lat, own.lon, lat, lon), brg = bearing(own.lat, own.lon, lat, lon);
      let txt = `${(rng / 1852).toFixed(rng < 18520 ? 2 : 1)} nm · ${String(Math.round(brg)).padStart(3, '0')}°`;
      const cpa = this._cpa(own, v, lat, lon, sog, cog ?? hdg);
      if (cpa) txt += cpa.tcpa > 0 ? ` · CPA ${(cpa.cpa / 1852).toFixed(2)} nm in ${fmtDur(cpa.tcpa)}` : ' · opening';
      rows.push(['Range', txt]);
    }
    rows.push(['Last report', age]);
    const head = `<div class="aisHead" style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap">${fe ? `<span class="aisFlag" style="font-size:1.3em">${fe}</span>` : ''}<b class="aisName" style="font-size:1.1em">${esc(name)}</b><span class="aisSub" style="opacity:.7">${esc(aisTypeText(type) !== 'Unknown type' ? aisTypeText(type) : SHIP_CLASSES[cls]?.name || 'Vessel')}</span></div>`;
    const route = `<div class="aisRoute" style="margin:4px 0 2px">${from ? esc(from) : '—'} → ${to ? esc(to) : raw ? esc(raw) : '—'}${sog != null && v?.mode === 'underway' ? ` · ${sog.toFixed(1)} kn` : ''}</div>`;
    const grid = `<dl class="aisGrid" style="display:grid;grid-template-columns:max-content 1fr;gap:3px 12px;margin:6px 0;font-variant-numeric:tabular-nums">${rows.map(([k, val]) => `<dt style="opacity:.65">${k}</dt><dd style="margin:0">${val}</dd>`).join('')}</dl>`;
    return `<div class="aisCard" data-ais-id="${esc(v?.id ?? d.id ?? d.mmsi)}">${head}${route}${grid}<div class="aisSrc" style="opacity:.6;font-size:.85em">${sourceAttribution(d.src)}</div></div>`;
  }
  /** Closest point of approach between the player's ship and a vessel, {cpa (m), tcpa (s)} or null. */
  _cpa(own, v, lat, lon, sog, course) {
    const k = Math.cos(own.lat * D2R);
    const rx = wrapLon(lon - own.lon) * M_LON * k, ry = (lat - own.lat) * M_LAT;
    const oh = (own.hdg || 0) * D2R, os = (Number(own.spd) || 0) * KN;
    const ts = (v ? (v.mode === 'underway' ? v.sogNow : 0) : sog || 0) * KN, tc = ((v ? v.course : course) || 0) * D2R;
    const vx = Math.sin(tc) * ts - Math.sin(oh) * os, vy = Math.cos(tc) * ts - Math.cos(oh) * os;
    const v2 = vx * vx + vy * vy; if (v2 < 1e-6) return null;
    const tcpa = -(rx * vx + ry * vy) / v2;
    return { tcpa, cpa: tcpa > 0 ? Math.hypot(rx + vx * tcpa, ry + vy * tcpa) : Math.hypot(rx, ry) };
  }

  // ---------------------------------------------------------------------------------------------- lifecycle
  /** Show / hide every AIS visual (models, boxes, wakes, labels). Tracking, contacts() and others() continue. */
  setVisible(on) {
    this.visible = !!on; this.group.visible = this.visible;
    for (const v of this.vessels.values()) { const wg = v.model?.userData.wakeGroup; if (wg) wg.visible = this.visible; }
    this._dirty = true;
  }
  /** Counters for debugging / tests. */
  stats() {
    let full = 0, box = 0, labels = 0;
    for (const v of this._rendered) { if (v.removed) continue; if (v.lod === 2 && v.model) full++; else if (v.lod > 0) box++; if (v.label) labels++; }
    return { vessels: this.vessels.size, rendered: full + box, full, box, labels, pooled: this._poolCount, ...this._stats };
  }
  /** Remove everything from the scene and free all GPU resources (models, pooled models, wakes, boxes, labels). */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const v of [...this.vessels.values()]) this._remove(v);
    for (const arr of this._pool.values()) for (const m of arr) { m.userData.dispose?.(); this._stats.disposed++; }
    this._pool.clear(); this._poolCount = 0;
    this.group.parent?.remove(this.group);
    for (const m of [this.boxHull, this.boxHouse]) { m.geometry.dispose(); m.dispose?.(); }
    this._hullMat.dispose(); this._houseMat.dispose();
    this._rendered = []; this._boxVessel = [];
  }
}
