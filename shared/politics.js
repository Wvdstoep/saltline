// World politics: pure rules shared by the server (authority), the client (previews) and the tests.
// Contract: docs/WORLD-POLITICS-CONTRACT.md §8.1 (frozen interface). No I/O here: the dataset comes in through
// loadDataset(parts) — the server reads shared/politics/*.json with fs, the client fetches /api/politics.
// Every rule is a table row in the dataset; there are no per-country code paths (principle P3).
import { SHIP_CLASSES, GOODS } from './constants.js';
import { haversine } from './geo.js';

export const POL = {
  DAY_TO_H: 1,              // one real-world day of paperwork/waiting = one game hour (world clock)
  COVER_MAX_H: 168,         // one war-cover purchase covers one entry until exit, at most 7 days
  RISK_PAY: { 1: 0.10, 2: 0.40, 3: 1.20, 4: 2.00 },
  TIER_AP: { 1: 0.0005, 2: 0.002, 3: 0.007, 4: 0.010 },      // fallback fraction of hull value
  TIER_PDAY: { 1: 0.0002, 2: 0.001, 3: 0.004, 4: 0.006 },
  OUTCOME: { minor: [0.70, 8], major: [0.95, 30], loss: [1.00, 100] },   // cumulative share, hull points lost
  MAJOR_CARGO_LOSS: 0.25,
  DETENTION_H: [6, 24],
  PIRACY_MIT: { speedKn: 18, speedMul: 0.3, convoyMul: 0.5, guardsMul: 0.2, guardsCrPerDay: 2500, guardsMin: 1500 },
  HIJACK_H: 12, HIJACK_COST_FRAC: 0.05,
  ROBBERY_FRAC: 0.02, ROBBERY_MAX: 5000,
  PSC_POINTS_HRS: 4, PSC_DETAIN: [[80, 0.02], [60, 0.06], [40, 0.15], [0, 0.40]],
  PSC_RELEASE_COND: 60, PSC_MIN_HOLD_H: 1, PSC_FEE: 1500,
  ECA_ON: true,
  ECA_SURCHARGE: 0.35,      // × GOODS.fuel.base (650) = 227.5 cr per tonne burned inside an SOx ECA
  CUSTOMS_FEE: { none: 0, origin_proof: 50, mfn: 150 },
  SEIZE_FINE_MULT: 2, SEIZE_FINE_MIN: 10000,
  DESIGNATION_P: 0.25, DESIGNATION_DAYS: 30, EXPOSURE_DAYS: 365,
  REP: { min: -100, max: 100, deliver: 1, deliverCapDay: 2, humanitarian: 5, charter: 3, late: -1,
    detention: -5, detentionRegime: -2, seizure: -20, breach: -5, charterMin: 20, trusted: 40, watched: -30, banned: -60, banDays: 7 },
  WIND_DOWN_DAYS: 30, FRUSTRATION_PAY: 0.25,
  CLEARANCE_H: 2, CLEARANCE_VALID_H: 72,
  FORMATION_FEE: 5000, AGE_YEARS_PER_COND: 3.5,
  AGENT_CR_DAY: 50, FORMATION_DAYS_DEFAULT: 5,
  OFF_CORRIDOR_KM: 10, OFF_CORRIDOR_MINE_MUL: 3,
  DEST_WEIGHT_K: 6,
};

export const RISK_POLICIES = ['avoid', 'cautious', 'accept'];
export const DISCLAIMER = 'Simplified for the game — not legal, compliance or navigation advice.';
export const STATUS_REASONS = ['entry permit required', 'corridor route required', 'martial law in force', 'port operations suspended'];

// ---------------------------------------------------------------------------------------------- wording (§2.1)
export const TEMPLATES = {
  areaChip: 'Listed area — {areaName} ({srcShort}, {asOf})',
  conflict: 'Armed conflict affecting shipping in {areaName} (source: {srcShort}, {asOf}).',
  statusOpen: 'Open',
  statusRestricted: 'Restricted — {reason}',
  statusClosed: 'Closed to merchant shipping — {reason}',
  mine: '{ship} struck an underwater object believed to be a mine {where}. Crew safe. Hull −{n} %.',
  projectile: '{ship} was hit by an unidentified projectile {where}. Crew safe. Hull −{n} %.',
  detention: '{ship} was detained by coastal state authorities {where}. Crew safe. Expected release in {h} h.',
  loss: '{ship} was abandoned after damage {where}. All crew evacuated safely.',
  block: 'Not allowed for your company: {measureText} ({srcShort}, {asOf}).',
  refusal: '{harbour} port control refuses entry: {measureText} ({srcShort}).',
  warlike: 'IBF warlike operations area: crew on double basic pay (IBF/JNG list, {asOf}).',
  premium: 'War risk additional premium — {areaName} ({srcShort})',
  robbery: '{ship}: robbers boarded {where} and took stores and cash ({cr} cr). Crew safe.',
  repelled: '{ship}: an approach by a suspicious craft was repelled {where}. Crew safe. Hull −{n} %.',
  hijack: '{ship} was held {where}. Ship held; released after {h} h. Crew safe.',
  psc: '{ship} was detained by port state control at {harbour} ({regime}). Crew safe. Release after repairs to {cond} %.',
  seizure: '{harbour} customs seized {qty} t of {good} (origin {origin}): {measureText} ({srcShort}, {asOf}). Fine {fine} cr.',
  gnss: 'GNSS interference reported in this area ({srcShort}, {asOf}) — cross-check position by radar.',
};
export function fill(tpl, vars = {}) { return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? '' : String(vars[k]))); }

// ---------------------------------------------------------------------------------------------- dates and scaling
export const DAY_S = 86400;
export function dateOf(simTime) { return new Date(simTime * 1000).toISOString().slice(0, 10); }
export function dateToS(iso) { return Date.parse(iso + 'T00:00:00Z') / 1000; }
/** Real-world days of waiting → seconds of world clock (POL.DAY_TO_H game hours per day). */
export function scaledS(days) { return days * POL.DAY_TO_H * 3600; }
export function isActive(rec, simTime) {
  if (!rec) return false;
  if ('from' in rec && rec.from === null) return false;          // signed / adopted, not in force
  const d = dateOf(simTime);
  if (rec.from && rec.from > d) return false;
  if (rec.until && rec.until <= d) return false;
  return true;
}
export function isStale(rec, simTime) { return !!(rec && rec.reviewBy && rec.reviewBy < dateOf(simTime)); }

// ---------------------------------------------------------------------------------------------- dataset
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };

/**
 * parts: { meta, sources, countries, ports, registries, regimes, areas, agreements, tariffs, psc, trade?, harbors? }
 * harbors (optional): [{ id, name, country, lat, lon, size }] — the harbour table the checks resolve job ids against.
 */
export function loadDataset(parts) {
  const p = parts || {};
  const ds = {
    meta: p.meta || {}, sources: p.sources || {}, countries: p.countries || {}, ports: p.ports || {}, registries: p.registries || {},
    regimes: p.regimes || [], areas: (p.areas || []).map(prepArea), agreements: p.agreements || [], tariffs: p.tariffs || {},
    psc: p.psc || { regimes: {} }, trade: p.trade || null,
  };
  ds.authorities = ds.meta.authorities || {};
  ds.measures = [];
  for (const r of ds.regimes) for (const m of r.measures || []) ds.measures.push({ ...m, regimeId: r.id, authority: r.authority, target: r.target, src: m.src || r.src, asOf: m.asOf || r.asOf, from: m.from ?? r.from, until: m.until ?? r.until ?? null, regimeTitle: r.title });
  ds.areaById = {}; for (const a of ds.areas) ds.areaById[a.id] = a;
  ds.grid = new Map();
  for (const a of ds.areas) {
    const [w, s, e, n] = a.bbox;
    for (let la = Math.floor(s); la <= Math.floor(n); la++) for (let lo = Math.floor(w); lo <= Math.floor(e); lo++) {
      const k = la * 1000 + lo; let l = ds.grid.get(k); if (!l) ds.grid.set(k, l = []); l.push(a.id);
    }
  }
  const hs = p.harbors || [];
  ds.harbors = {}; for (const h of hs) ds.harbors[h.id] = { id: h.id, name: h.name, country: h.country, lat: h.lat, lon: h.lon, size: h.size };
  // Frozen except the grid (a Map) — rule data is read-only for every caller.
  for (const k of Object.keys(ds)) if (k !== 'grid') deepFreeze(ds[k]);
  return Object.freeze(ds);
}
export function harborOf(ds, id) { return typeof id === 'object' && id ? id : ds.harbors[id] || null; }
export function srcShort(ds, ids) {
  const id = Array.isArray(ids) ? ids[0] : ids, s = ds.sources[id];
  return s ? (s.short || s.publisher || id) : (id || 'source');
}
function srcAsOf(rec) { return rec && (rec.asOf || null); }
function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return `${String(d).padStart(2, '0')} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`;
}
export { fmtDate };

// ---------------------------------------------------------------------------------------------- geometry
function prepArea(a) {
  const rings = (a.poly || []).filter((r) => Array.isArray(r) && r.length >= 4);
  let bbox = a.bbox;
  if (!bbox) {
    let w = 180, s = 90, e = -180, n = -90;
    for (const [lo, la] of [...rings.flat(), ...(a.line || [])]) { w = Math.min(w, lo); e = Math.max(e, lo); s = Math.min(s, la); n = Math.max(n, la); }
    bbox = [w, s, e, n];
  }
  const discs = a.discs && a.discs.length ? a.discs : areaDiscs({ poly: rings });
  return { ...a, poly: rings, bbox, discs };
}
export function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function pointInArea(area, lat, lon) {
  const [w, s, e, n] = area.bbox;
  if (lon < w || lon > e || lat < s || lat > n) return false;
  return area.poly.some((r) => pointInRing(lon, lat, r));
}
export function areasAt(ds, lat, lon, kinds = null, simTime = null) {
  const ids = ds.grid.get(Math.floor(lat) * 1000 + Math.floor(lon));
  if (!ids) return [];
  const out = [];
  for (const id of ids) {
    const a = ds.areaById[id];
    if (kinds && !kinds.includes(a.kind)) continue;
    if (simTime != null && !isActive(a, simTime)) continue;
    if (pointInArea(a, lat, lon)) out.push(a);
  }
  return out;
}
/** Signed area (shoelace, lon/lat plane): > 0 = counter-clockwise. */
export function ringArea(ring) { let s = 0; for (let i = 0; i < ring.length - 1; i++) s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]; return s / 2; }
export function ringSelfIntersects(ring) {
  const n = ring.length - 1;
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const segX = (p1, p2, p3, p4) => { const d1 = cross(p3, p4, p1), d2 = cross(p3, p4, p2), d3 = cross(p1, p2, p3), d4 = cross(p1, p2, p4); return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0)) && d1 !== 0 && d2 !== 0 && d3 !== 0 && d4 !== 0; };
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (j === i + 1 || (i === 0 && j === n - 1)) continue;
    if (segX(ring[i], ring[i + 1], ring[j], ring[j + 1])) return true;
  }
  return false;
}
// Covering discs for the route planner's avoid list (≤ 4, rKm ≤ 600 where the split depth allows).
const KM_LAT = 110.574;
function mec(pts) {   // minimum enclosing circle, Welzl (iterative, n ≤ ~80)
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const c2 = (a, b) => ({ x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, r: d(a, b) / 2 });
  const c3 = (a, b, c) => {
    const ax = a[0], ay = a[1], bx = b[0], by = b[1], cx = c[0], cy = c[1];
    const D = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(D) < 1e-12) { const cs = [c2(a, b), c2(a, c), c2(b, c)]; return cs.sort((p, q) => q.r - p.r)[0]; }
    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / D;
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / D;
    return { x: ux, y: uy, r: d([ux, uy], a) };
  };
  const inC = (c, p) => c && Math.hypot(p[0] - c.x, p[1] - c.y) <= c.r * (1 + 1e-9) + 1e-9;
  let c = null;
  for (let i = 0; i < pts.length; i++) if (!inC(c, pts[i])) {
    c = { x: pts[i][0], y: pts[i][1], r: 0 };
    for (let j = 0; j < i; j++) if (!inC(c, pts[j])) {
      c = c2(pts[i], pts[j]);
      for (let k = 0; k < j; k++) if (!inC(c, pts[k])) c = c3(pts[i], pts[j], pts[k]);
    }
  }
  return c;
}
function clipRect(ring, w, s, e, n) {   // Sutherland–Hodgman against an axis-aligned box
  let out = ring.slice(0, -1);
  const edges = [[(p) => p[0] >= w, (a, b) => [w, a[1] + (b[1] - a[1]) * (w - a[0]) / (b[0] - a[0])]],
    [(p) => p[0] <= e, (a, b) => [e, a[1] + (b[1] - a[1]) * (e - a[0]) / (b[0] - a[0])]],
    [(p) => p[1] >= s, (a, b) => [a[0] + (b[0] - a[0]) * (s - a[1]) / (b[1] - a[1]), s]],
    [(p) => p[1] <= n, (a, b) => [a[0] + (b[0] - a[0]) * (n - a[1]) / (b[1] - a[1]), n]]];
  for (const [inside, cut] of edges) {
    const inp = out; out = [];
    for (let i = 0; i < inp.length; i++) {
      const cur = inp[i], prev = inp[(i + inp.length - 1) % inp.length];
      if (inside(cur)) { if (!inside(prev)) out.push(cut(prev, cur)); out.push(cur); } else if (inside(prev)) out.push(cut(prev, cur));
    }
    if (!out.length) return [];
  }
  return out;
}
function discOf(pts) {
  if (!pts.length) return null;
  const lat0 = pts.reduce((s, q) => s + q[1], 0) / pts.length, kx = 111.32 * Math.cos(lat0 * Math.PI / 180);
  const c = mec(pts.map((q) => [q[0] * kx, q[1] * KM_LAT]));
  return { lat: Math.round((c.y / KM_LAT) * 100) / 100, lon: Math.round((c.x / kx) * 100) / 100, rKm: Math.ceil(c.r + 1) };
}
export function areaDiscs(area, maxKm = 600, depth = 2) {
  const out = [];
  for (const ring of area.poly || []) {
    const go = (pts, w, s, e, n, d) => {
      const disc = discOf(pts); if (!disc) return;
      if (disc.rKm <= maxKm || d >= depth) { out.push(disc); return; }
      const wide = (e - w) * Math.cos(((s + n) / 2) * Math.PI / 180) >= (n - s);
      const halves = wide ? [[w, s, (w + e) / 2, n], [(w + e) / 2, s, e, n]] : [[w, s, e, (s + n) / 2], [w, (s + n) / 2, e, n]];
      for (const [a, b, c, dd] of halves) { const sub = clipRect([...pts, pts[0]], a, b, c, dd); if (sub.length >= 3) go(sub, a, b, c, dd, d + 1); }
    };
    let w = 180, s = 90, e = -180, n = -90;
    for (const [lo, la] of ring) { w = Math.min(w, lo); e = Math.max(e, lo); s = Math.min(s, la); n = Math.max(n, la); }
    go(ring.slice(0, -1), w, s, e, n, 0);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- territory, customs
function customsOf(ds, cc) { return ds.countries[cc]?.customs ?? cc ?? null; }
/** Does harbour/country `cc` match a port selector { customs: [...], cc: [...] } (null = nowhere)? */
export function inSelector(ds, sel, cc) {
  if (!sel || !cc) return false;
  if (Array.isArray(sel.cc) && sel.cc.includes(cc)) return true;
  if (Array.isArray(sel.customs) && sel.customs.includes(customsOf(ds, cc))) return true;
  return false;
}
export function inTerritory(ds, authority, cc) { return inSelector(ds, ds.authorities[authority]?.territory, cc); }

// ---------------------------------------------------------------------------------------------- context and predicates
export function makeCtx(ds, o = {}) {
  const home = o.homeHarbor ? harborOf(ds, o.homeHarbor)?.country ?? o.homeHarbor.country ?? null : o.home ?? null;
  const flag = o.flag ?? home;
  const homeFollows = new Set(ds.countries[home]?.follows || ['UN']);
  const flagFollows = new Set(ds.countries[flag]?.follows || ['UN']);
  return {
    home, flag, flagWas: Array.isArray(o.flagWas) ? o.flagWas : [],
    homeFollows, flagFollows, follows: new Set([...homeFollows, ...flagFollows]),
    customs: customsOf(ds, home),
    rep: o.rep || {}, designated: o.designated || {}, exposure: o.exposure || [], lockouts: o.lockouts || [],
    calls: o.calls || [], clearance: o.clearance || {}, licences: o.licences || {}, cargo: o.cargo || [],
    simTime: o.simTime ?? 0,
  };
}
export function matches(when, ctx) {
  if (!when) return true;
  if (when.all) return when.all.every((w) => matches(w, ctx));
  if (when.any) return when.any.some((w) => matches(w, ctx));
  if (when.not) return !matches(when.not, ctx);
  if (when.home) return when.home.includes(ctx.home);
  if (when.follows) return when.follows.some((a) => ctx.follows.has(a));
  if (when.flag) return when.flag.includes(ctx.flag);
  if (when.flagWas) {
    const sinceS = dateToS(when.flagWas.since);
    if (when.flagWas.cc.includes(ctx.flag)) return true;
    return ctx.flagWas.some((f) => when.flagWas.cc.includes(f.cc) && (f.until == null || f.until >= sinceS));
  }
  if (when.calledIn) {
    const c = when.calledIn, after = ctx.simTime - scaledS(c.days);
    return ctx.calls.some((k) => c.cc.includes(k.cc) && k.at >= after && (!c.trade || k.trade));
  }
  if (when.cargoOrigin) {
    const c = when.cargoOrigin;
    return ctx.cargo.some((s) => c.cc.includes(s.origin) && (!c.goods || c.goods.includes(s.good)));
  }
  if (when.designated) return when.designated.some((a) => (ctx.designated[a] || 0) > ctx.simTime);
  return false;
}
/** Does a measure bind this company/ship personally (home follows ∪ flag-state follows; UN binds everyone)? */
export function bindsPersonally(m, ctx) { return m.authority === 'UN' || ctx.follows.has(m.authority); }

// ---------------------------------------------------------------------------------------------- money rules
export function hullBasis(cls) { return Math.max(120000, (SHIP_CLASSES[cls] || SHIP_CLASSES.coaster).price); }
export function hullValue(cls, cond) { return Math.round(hullBasis(cls) * (0.4 + 0.45 * Math.max(0, Math.min(100, cond)) / 100)); }
export function apPctOf(area) { return Number.isFinite(area?.apPct) ? area.apPct : (POL.TIER_AP[area?.tier] || 0) * 100; }
export function warPremium(area, cls, cond) { return Math.round((hullValue(cls, cond) * apPctOf(area)) / 100); }
export function riskPay(pay, tier) { return Math.round(pay * (1 + (POL.RISK_PAY[tier] || 0))); }
export function pDayOf(area) { return Number.isFinite(area?.pDay) ? area.pDay : POL.TIER_PDAY[area?.tier] || 0; }
export function transitChance(pDay, km, speedKn, mul = 1) {
  if (!(km > 0) || !(speedKn > 0)) return 0;
  const days = km / (speedKn * 1.852) / 24;
  return 1 - Math.pow(1 - Math.min(1, pDay * mul), days);
}
export function piracyMitigation({ speedKn = 0, convoy = false, guards = false } = {}) {
  const M = POL.PIRACY_MIT;
  return (speedKn >= M.speedKn ? M.speedMul : 1) * (convoy ? M.convoyMul : 1) * (guards ? M.guardsMul : 1);
}
export function piracyChance(p100, km, mit = {}) {
  if (!(km > 0)) return 0;
  return 1 - Math.pow(1 - Math.min(1, p100 * piracyMitigation(mit)), km / 100);
}
export function guardsCost(daysInArea) { return Math.max(POL.PIRACY_MIT.guardsMin, Math.round(POL.PIRACY_MIT.guardsCrPerDay * daysInArea)); }
/** Extra cost per tonne burned inside an SOx ECA (rounded to cents: 0.35 × 650 = 227.5). */
export function ecaPerT() { return Math.round(POL.ECA_SURCHARGE * GOODS.fuel.base * 100) / 100; }
export function ecaCost(tonnes) { return Math.round(tonnes * ecaPerT()); }
/** Incident outcome for a uniform draw r: 'minor' | 'major' | 'loss'. */
export function incidentOutcome(r) { const O = POL.OUTCOME; return r < O.minor[0] ? 'minor' : r < O.major[0] ? 'major' : 'loss'; }
export function pickShare(mix, r) {
  let acc = 0; const keys = Object.keys(mix || {});
  for (const k of keys) { acc += mix[k]; if (r < acc) return k; }
  return keys[keys.length - 1] || null;
}
/** §4.11 price profile multiplier from a trade flow { exp, imp }; null when the flow has no data. */
export function tradeProfileMul(flow) {
  if (!flow || !(flow.exp + flow.imp > 0)) return null;
  const b = (flow.exp - flow.imp) / (flow.exp + flow.imp);
  return Math.round(Math.max(0.75, Math.min(1.25, 1 - 0.25 * b)) * 1000) / 1000;
}
export function destWeightFor(share) { return Math.round((1 + POL.DEST_WEIGHT_K * Math.max(0, share || 0)) * 1000) / 1000; }
export function tradeShare(ds, fromCc, toCc, good) {
  const t = ds.trade?.flows?.[fromCc]?.[good]?.top; if (!t) return 0;
  const row = t.find((x) => x[0] === toCc); return row ? row[1] : 0;
}

// ---------------------------------------------------------------------------------------------- reasons
function reason(ds, code, rec, extra = {}) {
  const src = rec?.src ? (Array.isArray(rec.src) ? rec.src : [rec.src]) : [];
  const r = { code, src, asOf: srcAsOf(rec), srcShort: srcShort(ds, src), ...extra };
  r.text = reasonText(r);
  return r;
}
export function reasonText(r) {
  if (!r) return '';
  if (r.text) return r.text;
  const v = { measureText: r.measureText || '', srcShort: r.srcShort || '', asOf: fmtDate(r.asOf), harbour: r.harbour || 'The', areaName: r.areaName || '' };
  switch (r.code) {
    case 'sanction': case 'arms_embargo': return fill(TEMPLATES.block, v);
    case 'port_ban': case 'lockout': case 'closed': case 'designated': case 'clearance': case 'denied': case 'rep_ban': return fill(TEMPLATES.refusal, v);
    case 'war_risk': return fill(TEMPLATES.areaChip, v);
    default: return v.measureText;
  }
}
function measureText(m) { return m.text || `${m.regimeTitle || m.regimeId}${m.art ? ', ' + m.art : ''}`; }

// ---------------------------------------------------------------------------------------------- trade / duty
function goodsMatch(m, good) { return !m.goods || m.goods.includes(good); }
function measureFor(ds, simTime, filter) { return ds.measures.filter((m) => isActive(m, simTime) && filter(m)); }

export function dutyFor(ds, ctx, { harbor, good, origin, value }) {
  const h = harborOf(ds, harbor), d = h?.country;
  const none = (via = 'none') => ({ rate: 0, duty: 0, fee: 0, basis: 'source', via, src: [], asOf: null });
  if (!d || good === 'supplies' || GOODS[good]?.contraband) return none();
  const t = ctx.simTime;
  const trusted = (ctx.rep?.[d] ?? 0) >= POL.REP.trusted;
  const fee = (k) => (trusted ? 0 : POL.CUSTOMS_FEE[k]);
  if (origin) {
    if (customsOf(ds, origin) === customsOf(ds, d) && customsOf(ds, d)) {
      const ag = ds.agreements.find((a) => a.id === customsOf(ds, d));
      return { ...none(ag ? ag.id : 'none'), src: ag?.src || [], asOf: ag?.asOf || null };
    }
    for (const a of ds.agreements) {
      if (!isActive(a, t) || !(a.members || []).includes(origin) || !(a.members || []).includes(d)) continue;
      const partialO = (a.partial || []).find((x) => x.cc === origin), partialD = (a.partial || []).find((x) => x.cc === d);
      if ((partialO && !partialO.goods.includes(good)) || (partialD && !partialD.goods.includes(good))) continue;
      if (a.goods && a.goods !== 'all' && !a.goods.includes(good)) continue;
      if (a.kind === 'customs_union') return { rate: 0, duty: 0, fee: 0, basis: 'source', via: a.id, src: a.src || [], asOf: a.asOf || null };
      if (a.kind === 'fta' && Number.isFinite(a.prefRate)) {
        return { rate: a.prefRate, duty: Math.round(value * a.prefRate), fee: fee(a.paperwork || 'origin_proof'), basis: 'source', via: a.id, src: a.src || [], asOf: a.asOf || null };
      }
    }
  }
  const row = ds.tariffs[d]?.[good];
  let rate = row && Number.isFinite(row.rate) ? row.rate : 0;
  const src = row?.src ? [...row.src] : [];
  if (origin) for (const m of measureFor(ds, t, (m) => m.kind === 'tariff_add' && goodsMatch(m, good) && (!m.origin || m.origin.includes(origin)) && inTerritory(ds, m.authority, d))) { rate += m.rate || 0; src.push(...(m.src || [])); }
  return { rate, duty: Math.round(value * rate), fee: fee('mfn'), basis: row ? row.basis || 'source' : 'none', via: row || rate ? 'mfn' : 'none', src, asOf: row?.asOf || null, modelled: !!row };
}

export function tradeCheck(ds, ctx, { harbor, good, side, origin, value = 0 }) {
  const h = harborOf(ds, harbor), here = h?.country, t = ctx.simTime;
  const warn = [];
  const block = (m) => ({ ok: false, block: reason(ds, 'sanction', m, { measureId: m.id, measureText: measureText(m) }), warn });
  if (side === 'buy') {
    const o = here;
    for (const m of measureFor(ds, t, (m) => (m.kind === 'import_ban' || m.kind === 'service_ban') && goodsMatch(m, good) && m.origin?.includes(o))) {
      if (m.scope?.includes('personal') && bindsPersonally(m, ctx) && !(m.kind === 'service_ban' && m.carriage?.allowedUnder)) return block(m);
    }
    // Warn: ports that would seize this cargo by origin (territorial import bans elsewhere).
    for (const m of measureFor(ds, t, (m) => m.kind === 'import_ban' && m.scope?.includes('territorial') && goodsMatch(m, good) && m.origin?.includes(o)))
      warn.push(reason(ds, 'seizable', m, { measureId: m.id, measureText: `${measureText(m)} — ${m.authority} ports seize this cargo` }));
    for (const m of measureFor(ds, t, (m) => m.kind === 'secondary' && goodsMatch(m, good) && m.origin?.includes(o)))
      warn.push(reason(ds, 'secondary', m, { measureId: m.id, measureText: `${measureText(m)} — exposure at ${m.authority} ports` }));
    return { ok: true, warn };
  }
  // sell: landing here
  for (const m of measureFor(ds, t, (m) => m.kind === 'import_ban' && goodsMatch(m, good) && origin && m.origin?.includes(origin))) {
    if ((m.scope?.includes('territorial') && inTerritory(ds, m.authority, here)) || (m.scope?.includes('personal') && bindsPersonally(m, ctx))) return block(m);
  }
  for (const m of measureFor(ds, t, (m) => m.kind === 'export_ban' && goodsMatch(m, good) && m.to?.includes(here))) {
    if (m.scope?.includes('personal') && bindsPersonally(m, ctx)) return block(m);
  }
  const duty = dutyFor(ds, ctx, { harbor: h, good, origin, value });
  return { ok: true, warn, duty };
}

// ---------------------------------------------------------------------------------------------- port entry
export function portStatus(ds, harbor) {
  const h = harborOf(ds, harbor), po = h && ds.ports[h.id];
  return po?.status || { value: 'open', reasons: [] };
}
export function entryCheck(ds, ctx, harbor, vessel = null, opts = {}) {
  const h = harborOf(ds, harbor); if (!h) return { ok: true };
  const t = ctx.simTime, cc = h.country, po = ds.ports[h.id];
  const refuse = (code, rec, txt, extra = {}) => ({ ok: false, refuse: reason(ds, code, rec, { harbour: h.name, measureText: txt, ...extra }) });
  const st = portStatus(ds, h);
  if (st.value === 'closed') return refuse('closed', st, `closed to merchant shipping — ${(st.reasons || []).join(', ')}`);
  for (const m of measureFor(ds, t, (m) => m.kind === 'port_ban' || m.kind === 'entry_lockout')) {
    const sel = m.ports || ds.authorities[m.authority]?.territory;
    if (!inSelector(ds, sel, cc)) continue;
    if (matches(m.when, ctx)) return refuse(m.kind === 'port_ban' ? 'port_ban' : 'lockout', m, measureText(m), { measureId: m.id });
  }
  for (const l of ctx.lockouts || []) if (l.until > t && inSelector(ds, l.ports, cc)) return refuse('lockout', l, l.text || 'entry lockout in force');
  for (const [auth, until] of Object.entries(ctx.designated || {})) if (until > t && inTerritory(ds, auth, cc)) return refuse('designated', { src: [], asOf: null }, `company designated by ${auth} until ${new Date(until * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`);
  if ((ctx.rep?.[cc] ?? 0) <= POL.REP.banned) return refuse('rep_ban', { src: [] }, `standing with ${ds.countries[cc]?.name || cc} port authorities too low`);
  const e = po?.entry;
  if (e) {
    if (e.deniedWhen && matches(e.deniedWhen, ctx)) return refuse('denied', e, 'entry denied for this vessel');
    if (e.clearance && !opts.ignoreClearance && !((ctx.clearance?.[h.id] || 0) > t)) return { ...refuse('clearance', e, 'entry clearance required — request clearance first'), needs: 'clearance' };
    if (e.corridor) return { ok: true, needs: 'corridor', corridor: e.corridor };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------- cabotage
export function cabotageOf(ds, fromCc, toCc) {
  for (const cc of [fromCc]) {
    const cb = ds.countries[cc]?.cabotage; if (!cb) continue;
    if (cb.rule === 'bloc') {
      const ag = ds.agreements.find((a) => a.id === cb.bloc || a.bloc === cb.bloc);
      if (fromCc === toCc) return { cc, ...cb, members: ag?.members || [] };
      continue;
    }
    const terr = cb.territory || [cc];
    if (terr.includes(fromCc) && terr.includes(toCc)) return { cc, ...cb };
  }
  return null;
}
export function cabotageCheck(ds, ctx, fromCc, toCc, vessel = null) {
  const cb = cabotageOf(ds, fromCc, toCc);
  if (!cb || cb.rule === 'open' || cb.rule === 'nodata') return { ok: true, cab: cb ? cb.cc : null };
  const fail = (txt) => ({ ok: false, cab: cb.cc, reason: reason(ds, 'cabotage', cb, { measureText: txt }) });
  const name = ds.countries[cb.cc]?.name || cb.cc;
  if (cb.rule === 'national') {
    if (ctx.flag !== cb.cc && !(cb.territory || []).includes(ctx.flag)) return fail(`domestic trade in ${name} is reserved to ${cb.cc}-flag ships`);
    if (cb.builtIn && (vessel?.builtIn || 'XX') !== cb.builtIn) return fail(`domestic trade in ${name} needs a ${cb.builtIn}-built ship`);
    if (cb.ownerHome && !cb.ownerHome.includes(ctx.home)) return fail(`domestic trade in ${name} needs a company based in ${cb.ownerHome.join('/')}`);
    return { ok: true, cab: cb.cc };
  }
  if (cb.rule === 'bloc') {
    if (!cb.members.includes(ctx.flag)) return fail(`domestic trade in ${name} is open to ${cb.bloc} member-state flags only`);
    return { ok: true, cab: cb.cc };
  }
  if (cb.rule === 'licence') {
    if (ctx.flag === cb.cc) return { ok: true, cab: cb.cc };
    if ((ctx.licences?.[cb.cc] || 0) > ctx.simTime) return { ok: true, cab: cb.cc };
    return fail(`domestic trade in ${name} needs a ${cb.cc} flag or a coastal trading licence`);
  }
  return { ok: true, cab: cb.cc };
}

// ---------------------------------------------------------------------------------------------- contracts
export function jobCheck(ds, ctx, job, vessel = null) {
  const warn = [], t = ctx.simTime;
  const from = harborOf(ds, job.from), to = harborOf(ds, job.to);
  const fc = from?.country, tc = to?.country;
  const tags = { tier: job.pol?.tier || 0, areas: job.pol?.areas || [], cab: null, mustAvoid: job.pol?.mustAvoid || null };
  const block = (r) => ({ ok: false, block: r, warn, tags });
  if (to && to.id !== from?.id) {
    const e = entryCheck(ds, ctx, to, vessel, { ignoreClearance: true });
    if (!e.ok) return block(e.refuse);
    if (e.needs === 'corridor') warn.push(reason(ds, 'corridor', ds.areaById[e.corridor] || {}, { measureText: `corridor route required (${ds.areaById[e.corridor]?.name || e.corridor})` }));
    if (ds.ports[to.id]?.entry?.clearance) warn.push(reason(ds, 'clearance', ds.ports[to.id].entry, { measureText: 'entry clearance required at the destination' }));
  }
  const good = job.good, origin = job.origin || fc;
  if (good) {
    for (const m of measureFor(ds, t, (m) => goodsMatch(m, good))) {
      const sanction = (rr) => block(reason(ds, 'sanction', m, { measureId: m.id, measureText: measureText(m), ...rr }));
      if (m.kind === 'arms_embargo') {
        if (job.contraband && good === 'weapons' && (m.target === fc || m.target === tc) && bindsPersonally(m, ctx)) return sanction({ code: 'arms_embargo' });
        continue;
      }
      if (job.contraband) continue;
      if (m.kind === 'import_ban' && m.origin?.includes(origin)) {
        if (m.scope?.includes('territorial') && inTerritory(ds, m.authority, tc)) return sanction();
        if (m.scope?.includes('personal') && bindsPersonally(m, ctx)) return sanction();
      }
      if (m.kind === 'export_ban' && m.to?.includes(tc)) {
        if (m.scope?.includes('personal') && bindsPersonally(m, ctx)) return sanction();
        if (m.scope?.includes('territorial') && inTerritory(ds, m.authority, fc)) return sanction();
      }
      if (m.kind === 'service_ban' && m.origin?.includes(origin) && bindsPersonally(m, ctx)) {
        if (m.carriage?.allowedUnder) warn.push(reason(ds, 'carriage', m, { measureId: m.id, measureText: `${measureText(m)} — ${m.carriage.note || 'carriage only under ' + m.carriage.allowedUnder}` }));
        else return sanction();
      }
    }
  }
  if (fc && tc && from.id !== to.id) {
    const cb = cabotageCheck(ds, ctx, fc, tc, vessel);
    tags.cab = cb.cab;
    if (!cb.ok) return block(cb.reason);
  }
  const needs = job.pol?.needs;
  if (needs?.rep && (ctx.rep?.[needs.rep.cc] ?? 0) < needs.rep.min) return block(reason(ds, 'needs', null, { measureText: `needs standing ${needs.rep.min} with ${ds.countries[needs.rep.cc]?.name || needs.rep.cc} port authorities` }));
  if (needs?.flag && !needs.flag.includes(ctx.flag)) return block(reason(ds, 'needs', null, { measureText: `needs a ${needs.flag.join('/')} flag` }));
  for (const id of tags.areas) {
    const a = ds.areaById[id]; if (!a || !isActive(a, t)) continue;
    if (a.kind === 'war_risk') warn.push(reason(ds, 'war_risk', a, { areaId: id, areaName: a.name, measureText: `listed area ${a.name} (tier ${a.tier})` }));
    else if (a.kind === 'piracy') warn.push(reason(ds, 'piracy', a, { areaId: id, areaName: a.name, measureText: `piracy area ${a.name}` }));
  }
  return { ok: true, warn, tags };
}

// ---------------------------------------------------------------------------------------------- PSC
export function pscRegimeOf(ds, harbor) { const h = harborOf(ds, harbor); if (!h) return null; return ds.ports[h.id]?.psc ?? ds.countries[h.country]?.psc ?? null; }
export function vesselAge(vessel, simTime) { const y = new Date(simTime * 1000).getUTCFullYear(); return Math.max(0, y - (Number.isFinite(vessel?.built) ? vessel.built : y)); }
export function flagListing(reg, cc) {
  const L = reg?.lists; if (!L || !(L.white || L.grey || L.black)) return null;
  if ((L.black || []).includes(cc)) return 'black';
  if ((L.grey || []).includes(cc)) return 'grey';
  if ((L.white || []).includes(cc)) return 'white';
  return 'unlisted';
}
export function pscProfile(ds, regimeId, vessel, ctx) {
  const reg = ds.psc.regimes?.[regimeId], pts = [];
  const age = vesselAge(vessel, ctx.simTime), cls = vessel?.cls || vessel?.ship?.cls;
  if (age > 12) pts.push({ why: `ship age ${age} years (over 12)`, n: 1 });
  if (age > 12 && ['tanker', 'bulker', 'ferry'].includes(cls)) pts.push({ why: 'tanker, bulk carrier or ferry over 12 years', n: 1 });
  const lst = flagListing(reg, ctx.flag);
  if (lst === 'black') pts.push({ why: `flag ${ctx.flag} on the ${reg.name} black list`, n: 2 });
  else if (lst === 'grey') pts.push({ why: `flag ${ctx.flag} on the ${reg.name} grey list`, n: 1 });
  else if (lst === 'unlisted') pts.push({ why: `flag ${ctx.flag} not on the ${reg.name} lists`, n: 1 });
  const cond = vessel?.cond ?? 100;
  if (cond < 60) pts.push({ why: `hull condition ${Math.round(cond)} % (under 60)`, n: 1 });
  const since = ctx.simTime - 30 * 86400;
  const det = (vessel?.pscDetentions || ctx.pscDetentions || []).filter((d) => d.regime === regimeId && d.at >= since).length;
  if (det >= 3) pts.push({ why: `${det} detentions in this regime in 30 days`, n: 2 });
  else if (det >= 1) pts.push({ why: `${det} detention${det > 1 ? 's' : ''} in this regime in 30 days`, n: 1 });
  const total = pts.reduce((s, q) => s + q.n, 0);
  const ever = (vessel?.pscDetentions || ctx.pscDetentions || []).length > 0;
  const profile = total >= POL.PSC_POINTS_HRS ? 'HRS' : total === 0 && lst === 'white' && !ever ? 'LRS' : 'SRS';
  return { profile, points: pts, total };
}
export function pDetainFor(cond) { for (const [min, p] of POL.PSC_DETAIN) if (cond >= min) return p; return POL.PSC_DETAIN[POL.PSC_DETAIN.length - 1][1]; }
export function pscChance(ds, regimeId, vessel, ctx, simTime = ctx.simTime, portCc = null) {
  const reg = ds.psc.regimes?.[regimeId];
  if (!reg) return { pInspect: 0, pDetain: 0, profile: null };
  const { profile } = pscProfile(ds, regimeId, vessel, { ...ctx, simTime });
  const last = vessel?.psc?.last?.[regimeId];
  const winH = reg.windowsH?.[profile] ?? 0;
  let pInspect = Number.isFinite(last) && simTime - last < winH * 3600 ? 0 : reg.pInspect?.[profile] ?? 0;
  if (portCc && (ctx.rep?.[portCc] ?? 0) <= POL.REP.watched) pInspect = Math.min(1, pInspect * 1.5);
  return { pInspect, pDetain: pDetainFor(vessel?.cond ?? 100), profile };
}

// ---------------------------------------------------------------------------------------------- routes
/** pts: [[lat, lon], …] (planner format). Samples every ≤ 5 km. */
export function routeExposure(ds, from, pts, speedKn, simTime = null) {
  const path = [[from.lat, from.lon], ...(pts || [])];
  const acc = new Map(); let ecaKm = 0, piracyKm = 0, warlikeKm = 0;
  for (let i = 1; i < path.length; i++) {
    const [la1, lo1] = path[i - 1], [la2, lo2] = path[i];
    const km = haversine(la1, lo1, la2, lo2) / 1000; if (!(km > 0)) continue;
    const n = Math.max(1, Math.ceil(km / 5)), step = km / n;
    for (let k = 0; k < n; k++) {
      const f = (k + 0.5) / n, la = la1 + (la2 - la1) * f, lo = lo1 + (lo2 - lo1) * f;
      for (const a of areasAt(ds, la, lo, null, simTime)) {
        acc.set(a.id, (acc.get(a.id) || 0) + step);
        if (a.kind === 'eca') ecaKm += step; else if (a.kind === 'piracy') piracyKm += step; else if (a.kind === 'warlike') warlikeKm += step;
      }
    }
  }
  const kmh = speedKn > 0 ? speedKn * 1.852 : null;
  const areas = [...acc.entries()].map(([id, km]) => { const a = ds.areaById[id]; return { id, kind: a.kind, tier: a.tier || 0, km: Math.round(km * 10) / 10, h: kmh ? Math.round((km / kmh) * 10) / 10 : null }; });
  return { areas, ecaKm: Math.round(ecaKm * 10) / 10, piracyKm: Math.round(piracyKm * 10) / 10, warlikeH: kmh ? Math.round((warlikeKm / kmh) * 10) / 10 : null };
}
export function avoidDiscs(ds, policy, from, to, max = 8) {
  if (policy === 'accept' || !from || !to) return [];
  const pad = 2, w = Math.min(from.lon, to.lon) - pad, e = Math.max(from.lon, to.lon) + pad, s = Math.min(from.lat, to.lat) - pad, n = Math.max(from.lat, to.lat) + pad;
  const out = [];
  for (const a of ds.areas) {
    const want = policy === 'cautious' ? a.kind === 'war_risk' && a.tier >= 3 : a.kind === 'war_risk' || a.kind === 'piracy';
    if (!want) continue;
    const [aw, as, ae, an] = a.bbox; if (ae < w || aw > e || an < s || as > n) continue;
    for (const d of a.discs) out.push({ lat: d.lat, lon: d.lon, radiusM: d.rKm * 1000, name: a.name, areaId: a.id, dist: haversine(from.lat, from.lon, d.lat, d.lon) });
  }
  return out.sort((p, q) => p.dist - q.dist).slice(0, Math.max(0, max)).map(({ dist, ...d }) => d);
}

// ---------------------------------------------------------------------------------------------- views
function srcList(ds, ids, simTime) {
  const seen = new Set(), out = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue; seen.add(id);
    const s = ds.sources[id]; if (!s) continue;
    out.push({ id, title: s.title, publisher: s.publisher, published: s.published, url: s.url, stale: isStale(s, simTime) });
  }
  return out;
}
export function harbourRules(ds, ctx, harbor, vessel = null) {
  const h = harborOf(ds, harbor), t = ctx.simTime, srcIds = [];
  const use = (rec) => { for (const s of rec?.src || []) srcIds.push(s); return rec; };
  const st = use(portStatus(ds, h)), po = ds.ports[h.id];
  const entry = entryCheck(ds, ctx, h, vessel);
  const blocked = [];
  for (const good of Object.keys(GOODS).filter((g) => !GOODS[g].contraband)) {
    const b = tradeCheck(ds, ctx, { harbor: h, good, side: 'buy' });
    if (!b.ok) { blocked.push({ side: 'buy', good, reason: b.block }); use(b.block); }
  }
  const seizable = [];
  for (const c of ctx.cargo || []) {
    if (!c.origin || c.jobId) continue;
    const m = ds.measures.find((m) => isActive(m, t) && m.kind === 'import_ban' && m.scope?.includes('territorial') && goodsMatch(m, c.good) && m.origin?.includes(c.origin) && inTerritory(ds, m.authority, h.country));
    if (m) seizable.push({ good: c.good, origin: c.origin, reason: reason(ds, 'seizable', m, { measureId: m.id, measureText: measureText(m) }) });
  }
  const rows = (ctx.cargo || []).filter((c) => !c.jobId).map((c) => { const d = dutyFor(ds, ctx, { harbor: h, good: c.good, origin: c.origin, value: 0 }); srcIds.push(...(d.src || [])); return { good: c.good, origin: c.origin ?? null, rate: d.rate, fee: d.fee, basis: d.basis, via: d.via, src: d.src }; });
  const regId = pscRegimeOf(ds, h), reg = ds.psc.regimes?.[regId];
  const pp = reg && vessel ? pscProfile(ds, regId, vessel, ctx) : null, pc = reg && vessel ? pscChance(ds, regId, vessel, ctx, t, h.country) : null;
  if (reg) use(reg);
  const here = areasAt(ds, h.lat, h.lon, null, t);
  const near = (kind) => here.filter((a) => a.kind === kind).map((a) => use(a));
  const security = near('war_risk').map((a) => ({ id: a.id, name: a.name, tier: a.tier, premium: vessel ? warPremium(a, vessel.cls || vessel.ship?.cls, vessel.cond ?? 100) : null, apPct: apPctOf(a), pDay: pDayOf(a), pCall: po?.portIncident?.pCall ?? null, warlike: here.some((w) => w.kind === 'warlike') }));
  const eca = near('eca').map((a) => ({ id: a.id, name: a.name, sulphurPct: a.sulphurPct, nox: a.nox || null, noxFrom: a.noxBuiltFrom || null, from: a.from, inForce: isActive(a, t), surchargePerT: ecaCost(1) }));
  const cb = ds.countries[h.country]?.cabotage; if (cb) use(cb);
  return {
    harbor: h.id, country: h.country, countryName: ds.countries[h.country]?.name || h.country,
    status: { value: st.value, reasons: st.reasons || [], src: st.src || [], asOf: st.asOf || null },
    entry: { ok: entry.ok, needs: entry.needs || null, refuse: entry.refuse || null, corridor: po?.entry?.corridor || null },
    clearance: (ctx.clearance?.[h.id] || 0) > t ? ctx.clearance[h.id] : null,
    you: { home: ctx.home, follows: [...ctx.follows], flag: ctx.flag, blocked, seizable },
    customs: { territory: customsOf(ds, h.country), agreement: ctx.customs === customsOf(ds, h.country) ? ctx.customs : null, rows },
    psc: reg ? { regime: regId, name: reg.name, profile: pp?.profile ?? null, points: pp?.points ?? [], pInspect: pc?.pInspect ?? null, pDetain: pc?.pDetain ?? null, last: vessel?.psc?.last?.[regId] ?? null } : null,
    eca, security, piracy: near('piracy').map((a) => ({ id: a.id, name: a.name, p100: a.p100 })),
    warnings: near('warning').slice(0, 3).map((a) => ({ id: a.id, name: a.name, text: fill(TEMPLATES.gnss, { srcShort: srcShort(ds, a.src), asOf: fmtDate(a.asOf) }) })),
    cabotage: cb ? { rule: cb.rule, note: cb.note || null, src: cb.src || [] } : { rule: 'nodata' },
    conflict: ds.countries[h.country]?.conflict || null,
    sources: srcList(ds, srcIds, t), version: ds.meta.version, validAsOf: ds.meta.validAsOf, disclaimer: DISCLAIMER,
  };
}
export function riskCheck(ds, ctx, { route, speedKn, cls, cond, job, toHarbor, vessel }) {
  const t = ctx.simTime, from = route?.from || (route?.points?.[0] ? { lat: route.points[0][0], lon: route.points[0][1] } : null);
  const pts = route?.points || [];
  const ex = from ? routeExposure(ds, from, pts, speedKn, t) : { areas: [], ecaKm: 0, piracyKm: 0, warlikeH: 0 };
  const C = SHIP_CLASSES[cls] || SHIP_CLASSES.coaster;
  const lines = [], blockers = [];
  let premiumTotal = 0;
  for (const x of ex.areas) {
    const a = ds.areaById[x.id];
    if (a.kind === 'war_risk') {
      const prem = warPremium(a, cls, cond); premiumTotal += prem;
      lines.push({ kind: 'war_risk', id: a.id, name: a.name, tier: a.tier, km: x.km, h: x.h, premium: prem, pSea: Math.round(transitChance(pDayOf(a), x.km, speedKn) * 1e4) / 1e4, src: a.src, asOf: a.asOf });
    } else if (a.kind === 'warlike') lines.push({ kind: 'warlike', id: a.id, name: a.name, h: x.h, crewExtra: Math.round((C.crewCost || 0) * ((a.crewPayMul || 2) - 1) * (x.h || 0)) });
    else if (a.kind === 'eca') lines.push({ kind: 'eca', id: a.id, name: a.name, km: x.km, inForce: isActive(a, t) });
    else if (a.kind === 'piracy') lines.push({ kind: 'piracy', id: a.id, name: a.name, km: x.km, p: Math.round(piracyChance(a.p100 || 0, x.km, { speedKn }) * 1e4) / 1e4 });
    else if (a.kind === 'corridor') lines.push({ kind: 'corridor', id: a.id, name: a.name, km: x.km });
    else if (a.kind === 'warning') lines.push({ kind: 'warning', id: a.id, name: a.name });
  }
  const to = toHarbor ? harborOf(ds, toHarbor) : null;
  let dest = null;
  if (to) {
    const e = entryCheck(ds, ctx, to, vessel);
    dest = { harbor: to.id, status: portStatus(ds, to), entry: e, pCall: ds.ports[to.id]?.portIncident?.pCall ?? null };
    if (!e.ok && e.needs !== 'clearance') blockers.push(e.refuse);
    const regId = pscRegimeOf(ds, to);
    if (regId && vessel) dest.psc = { regime: regId, ...pscChance(ds, regId, vessel, ctx, t, to.country) };
  }
  if (job) { const jc = jobCheck(ds, ctx, job, vessel); if (!jc.ok && !blockers.some((b) => b.text === jc.block.text)) blockers.push(jc.block); }
  return { version: ds.meta.version, validAsOf: ds.meta.validAsOf, exposure: ex, lines, premiumTotal, dest, blockers, ok: blockers.length === 0, disclaimer: DISCLAIMER };
}

// ---------------------------------------------------------------------------------------------- registries
export function registryOwnerOk(ds, reg, homeCc) {
  const o = reg?.owner || { rule: 'any' };
  if (o.rule === 'any' || o.rule === 'any_with_agent') return true;
  if (o.rule === 'home_in') return (o.cc || []).includes(homeCc);
  if (o.rule === 'home_in_bloc') { const ag = ds.agreements.find((a) => a.id === o.bloc || a.bloc === o.bloc); return !!ag && ag.members.includes(homeCc); }
  return false;
}
/** The registry that a 'national:<cc>' id resolves to (national template + the country's row). */
export function registryOf(ds, id, homeCc = null) {
  if (ds.registries[id]) return { id, ...ds.registries[id] };
  const m = /^national:([A-Z]{2})$/.exec(id || '');
  if (!m) return null;
  const cc = m[1], tpl = ds.registries.national || {}, inEu = ds.agreements.find((a) => a.id === 'eu-cu')?.members?.includes(cc);
  return { id, ...tpl, name: `${ds.countries[cc]?.name || cc} (national register)`, flag: cc, kind: 'national', owner: inEu ? { rule: 'home_in_bloc', bloc: 'eu-cu' } : { rule: 'home_in', cc: [cc] } };
}
export function reflagCost(reg, cls) {
  const d = (SHIP_CLASSES[cls] || SHIP_CLASSES.coaster).displacement, f = reg?.fees || {};
  return Math.round((f.initialCr || 0) + (f.perTCr || 0) * d);
}
