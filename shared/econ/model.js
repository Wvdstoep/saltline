// World economy — the frozen pure interface (docs/WORLD-ECONOMY-CONTRACT.md §16.1). Price, flow, season, request and
// chain formulas shared by the server (authority) and the client (previews). Browser-safe, no I/O (rule E7).
import { CATALOGUE, CATS, CAT_INDEX, LEGACY_GOODS, catalogueOf as catRow } from './catalogue.js';

export const ECON2 = {
  R: 0.03, COVER_H: 120, EQ_K: 0.8, EXPORT_DISC: 0.10, LAND_MAX: 0.8, FREIGHT_TKM: 0.06,
  SIG_LO: -0.8, SIG_HI: 1.5, REQ_R: 0.6, REQ_PREM_MIN: 0.15, REQ_PREM_K: 0.25, REQ_PREM_MAX: 0.40, REQ_KN: 13,
  REQ_MIN_H: 24, REQ_MAX_H: 720, REQ_BONUS: 0.05, DUMP_FRAC: 0.45, DUMP_CAP_T: 500, MAX_LISTED: 32,
  RESERVE: { P: 0.2, L: 0.6, I: 1.0 }, ROLE_STOCK: { P: 1.5, L: 1.0, I: 0.7 }, CHAIN_K0: 0.25, CHAIN_FILL: 0.5, INPUT_EQ: 0.36,
  HIST_HOURLY: 168, HIST_6H: 120, INLAND_CAP_T: 200 /* per player per inland harbour per 24 h */, STRIKE_P: { mega: 0.002, major: 0.0015, regional: 0.001, minor: 0 },
};
/** More game rules from the contract text (§6.1–§7.2), kept beside ECON2 so the frozen object stays as specified. */
export const ECON2X = {
  SIZE: { mega: 1, major: 0.5, regional: 0.22, minor: 0.08 },
  TIER_B_P: { 1: 1.0, 2: 0.75, 3: 0.5 }, TIER_B_I: { 1: -0.6, 2: -0.45, 3: -0.3 }, SITE_B: -0.45, HUB_STOCK: 1.5,
  REQ_MAX: { mega: 6, major: 4, regional: 3, minor: 1 }, REQ_QMAX: { mega: 20000, major: 8000, regional: 3000, minor: 800 },
  REQ_CLOSE_R: 0.9, PLATFORM_KM: 450, TREND_BAND: 0.05, NOISE: 0.01, DETOUR: 1.25,
  STAPLES: ['fuel', 'containers', 'machinery', 'steel', 'grain', 'fish'],
  MINOR_P: ['fish', 'salmon', 'shrimp', 'tuna', 'bananas'],
  TERMINAL: ['ore', 'coal', 'cokingcoal', 'bauxite', 'alumina', 'copperconc', 'nickelore', 'manganese', 'clinker', 'salt', 'potash', 'phosphate', 'crude', 'lng', 'lpg', 'ammonia'],
  HEMI_SHIFT: 183,   // half a year; the §17 example puts a southern-hemisphere 1 Aug peak on 31 Jan
  // Landed ceiling (§10 "gross landed ceiling", game): no harbour's price exceeds the cheapest of its CEIL_N nearest
  // sellers (P or L listings) plus CEIL_TKM × fmul per sea km — the import parity that keeps short hops from paying more
  // than freight. CEIL_TKM is the contract's FREIGHT_TKM.
  CEIL_TKM: 0.075, CEIL_N: 8, CEIL_PASSES: 6,
};
/** Landed ceiling of a row: min over sellers of (seller price + CEIL_TKM × fmul × km). */
export function landedCeiling(fmul, sellers) { let c = Infinity; for (const { price, km } of sellers) { const v = price + ECON2X.CEIL_TKM * fmul * km; if (v < c) c = v; } return c; }
export { CATS, LEGACY_GOODS };

/** Catalogue row or null. */
export function catalogueOf(id) { return catRow(id); }

// ------------------------------------------------------------------------------------------------ helpers
const clamp = (lo, hi, v) => (v < lo ? lo : v > hi ? hi : v);
/** mulberry32 over a string hash (the economy's historic seededRnd): deterministic per key. */
export function seededRnd(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  let a = h >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Seeded local price factor 0.97 … 1.03 per (harbour, good). */
export function localOf(hId, good) { return Math.round((0.97 + seededRnd(`${hId}:${good}`)() * 0.06) * 1000) / 1000; }
function gcKm(a, b) {
  const R = 6371, d2r = Math.PI / 180, dLat = (b.lat - a.lat) * d2r, dLon = (b.lon - a.lon) * d2r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * d2r) * Math.cos(b.lat * d2r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}
export { gcKm };

// ------------------------------------------------------------------------------------------------ dataset
/**
 * { catalogue, countries, seasons, chains, sites, meta, platforms?, tags?, today? } → EconDs (frozen, indexed).
 * `platforms` = [{ lat, lon }] (offshore supplies), `tags` = { ice: [harbour ids] }, `today` = 'YYYY-MM-DD' for `until`.
 */
export function loadEcon(parts = {}) {
  const catalogue = parts.catalogue || CATALOGUE;
  const countries = {}, templates = (parts.countries && parts.countries._templates) || {};
  for (const [cc, row] of Object.entries(parts.countries || {})) if (cc !== '_templates') countries[cc] = row;
  const sitesFile = parts.sites || {};
  const sites = Array.isArray(sitesFile) ? sitesFile : sitesFile.sites || [];
  const exportVia = new Map(Object.entries(sitesFile.exportVia || {}).map(([g, ids]) => [g, new Set(ids)]));
  const siteByHarbor = new Map();
  for (const s of sites) { if (!siteByHarbor.has(s.harbor)) siteByHarbor.set(s.harbor, []); siteByHarbor.get(s.harbor).push(s); }
  const ds = {
    v: parts.meta?.econVersion || '0', meta: parts.meta || {}, catalogue, byGood: new Map(catalogue.map((r) => [r.id, r])),
    countries, templates, seasons: parts.seasons || [], chains: parts.chains || {}, sites, siteByHarbor, exportVia,
    platforms: parts.platforms || [], ice: new Set(parts.tags?.ice || []), today: parts.today || new Date().toISOString().slice(0, 10),
    goods: catalogue.map((r) => r.id),
  };
  Object.defineProperty(ds, '_roles', { value: new Map(), enumerable: false });   // per-harbour role cache (derived)
  return Object.freeze(ds);
}

/** A country's effective profile: its row merged with its region template and the staples (§5.4). */
export function profileOf(eds, cc) {
  const row = eds.countries[cc] || { region: null, make: {}, need: {} };
  const tpl = eds.templates[row.region] || {};
  const make = {}, need = {}, hub = new Set(row.hub || []), filled = new Set();
  for (const [g, t] of Object.entries(row.make || {})) { const u = row.until?.[g]; if (!u || eds.today < u) make[g] = t; }
  for (const [g, t] of Object.entries(row.need || {})) if (!(g in make)) need[g] = t;
  for (const [g, t] of Object.entries(tpl.make || {})) if (!(g in make) && !(g in need) && !hub.has(g)) { make[g] = t; filled.add(g); }
  for (const [g, t] of Object.entries(tpl.need || {})) if (!(g in make) && !(g in need) && !hub.has(g)) { need[g] = t; filled.add(g); }
  for (const g of ECON2X.STAPLES) if (!(g in make) && !(g in need) && !hub.has(g)) { need[g] = 3; filled.add(g); }
  return { cc, region: row.region || null, make, need, hub, filled, row };
}

const SIZE_RANK = { minor: 0, regional: 1, major: 2, mega: 3 };
/** Does this harbour ship `g` for its country (§6.2)? */
function exportsHere(eds, h, g) {
  if (ECON2X.TERMINAL.includes(g)) return !!eds.exportVia.get(g)?.has(h.id);
  if ((SIZE_RANK[h.size] ?? 0) >= 1) return true;
  return ECON2X.MINOR_P.includes(g);
}

/** Every role of a harbour: Map good → { role, tier, b, site?, hub?, chainIn?: [{ site, chain, ratio }], chainOut?: [site ids] }. */
export function rolesOf(eds, h) {
  if (!h) return new Map();
  const hit = eds._roles.get(h.id);
  if (hit) return hit;
  const prof = profileOf(eds, h.country);
  const out = new Map();
  for (const [g, tier] of Object.entries(prof.make)) {
    if (!eds.byGood.has(g)) continue;
    out.set(g, exportsHere(eds, h, g) ? { role: 'P', tier, b: ECON2X.TIER_B_P[tier] } : { role: 'L', tier: null, b: 0 });
  }
  for (const s of eds.siteByHarbor.get(h.id) || []) {
    const c = eds.chains[s.chain]; if (!c) continue;
    for (const g of [c.main, ...Object.keys(c.co || {})]) {
      const prev = out.get(g), tier = prev?.role === 'P' ? Math.min(prev.tier, s.cap) : s.cap;
      out.set(g, { ...(prev || {}), role: 'P', tier, b: ECON2X.TIER_B_P[tier], site: prev?.site || s.chain, chainOut: [...(prev?.chainOut || []), s.id] });
    }
  }
  for (const s of eds.siteByHarbor.get(h.id) || []) {
    const c = eds.chains[s.chain]; if (!c) continue;
    for (const [g, ratio] of Object.entries(c.inputs)) {
      const prev = out.get(g), link = { site: s.id, chain: s.chain, ratio };
      if (prev && prev.role === 'P') { prev.chainIn = [...(prev.chainIn || []), link]; continue; }
      out.set(g, { role: 'I', tier: null, b: ECON2X.SITE_B, site: s.chain, chainIn: [...(prev?.chainIn || []), link] });
    }
  }
  for (const [g, tier] of Object.entries(prof.need)) if (eds.byGood.has(g) && !out.has(g)) out.set(g, { role: 'I', tier, b: ECON2X.TIER_B_I[tier], ...(prof.filled.has(g) ? { filled: true } : {}) });
  for (const g of prof.hub) if (eds.byGood.has(g) && !out.has(g)) out.set(g, { role: 'L', tier: null, b: 0, hub: true });
  if (!out.has('supplies') && eds.platforms.some((p) => gcKm(h, p) < ECON2X.PLATFORM_KM)) out.set('supplies', { role: 'L', tier: null, b: 0 });
  // listing cap (§6.1): drop the smallest |b| × base first — region-template and staple fill-ins before the country's
  // own rows (so Qingdao keeps its ore); legacy and chain goods stay
  const ids = [...out.keys()];
  if (ids.length > ECON2.MAX_LISTED) {
    const keep = (g) => LEGACY_GOODS.includes(g) || out.get(g).chainIn || out.get(g).chainOut;
    const w = (g) => Math.abs(out.get(g).b) * eds.byGood.get(g).base;
    const drop = ids.filter((g) => !keep(g)).sort((a, b) => ((out.get(b).filled ? 1 : 0) - (out.get(a).filled ? 1 : 0)) || (w(a) - w(b)) || (a < b ? -1 : 1));
    for (const g of drop.slice(0, ids.length - ECON2.MAX_LISTED)) out.delete(g);
  }
  const sorted = new Map([...out.entries()].sort(([a], [b]) => (CAT_INDEX[eds.byGood.get(a).cat] - CAT_INDEX[eds.byGood.get(b).cat]) || (a < b ? -1 : a > b ? 1 : 0)));
  eds._roles.set(h.id, sorted);
  return sorted;
}
/** { role: 'P'|'L'|'I'|null, tier, b, site? } */
export function roleOf(eds, harbor, good) {
  const r = rolesOf(eds, harbor).get(good);
  return r ? { role: r.role, tier: r.tier ?? null, b: r.b, ...(r.site ? { site: r.site } : {}), ...(r.hub ? { hub: true } : {}) } : { role: null, tier: null, b: 0 };
}
/** Listed good ids, ≤ 32, stable order (category, then id). */
export function listingOf(eds, harbor) { return [...rolesOf(eds, harbor).keys()]; }

/** §6.3 BASE_N (t, mega harbour). */
export function baseNormal(good) {
  const LEG = { fish: 2500, grain: 30000, steel: 15000, machinery: 4000, containers: 25000, fuel: 20000, supplies: 3000 };
  if (good in LEG) return LEG[good];
  const r = catRow(good); if (!r) return 1000;
  switch (good) {
    case 'ore': return 400000; case 'coal': case 'cokingcoal': return 250000; case 'bauxite': return 200000;
    case 'crude': return 300000; case 'flowers': return 800; case 'electronics': case 'pharma': return 1500;
    case 'copper': case 'aluminium': return 6000; case 'project': return 800;
    default: break;
  }
  return { grains: 30000, fert: 30000, ores: 60000, energy: 20000, gas: 60000, reefer: 3000, box: 4000, breakbulk: 15000, vehicles: 6000, animals: 1500, offshore: 3000 }[r.cat] ?? 3000;
}
/** Flows at multipliers 1 for a normal stock n and balance b (§6.4): { P, C, sEq } in t/h. */
export function flowsFor(n, b, role) {
  const { EQ_K, R, COVER_H } = ECON2;
  if (role === 'I') { const C = -EQ_K * b * R * n; return { P: 0, C, sEq: n + (0 - C) / R }; }
  const C = n / COVER_H, P = C + EQ_K * b * R * n;
  return { P, C, sEq: n + (P - C) / R };
}
/** Normal stock n (t) of a listed good at a harbour (§6.3, §8.3); 0 when not listed. */
export function normalOf(eds, harbor, good) {
  const r = rolesOf(eds, harbor).get(good); if (!r) return 0;
  if (r.role === 'I' && r.chainIn) {
    let n = 0;
    for (const l of r.chainIn) { const main = eds.chains[l.chain].main; n += chainNormalInput(l.ratio, flowsOf(eds, harbor, main).P); }
    return Math.max(20, Math.round(n));
  }
  const stockMul = ECON2.ROLE_STOCK[r.role] * (r.hub ? ECON2X.HUB_STOCK : 1);
  return Math.max(20, Math.round(baseNormal(good) * (ECON2X.SIZE[harbor.size] ?? 0.22) * stockMul));
}
/** { P, C, sEq, n, b, role } at multipliers 1 (unrounded t/h). */
export function flowsOf(eds, harbor, good) {
  const r = rolesOf(eds, harbor).get(good); if (!r) return { P: 0, C: 0, sEq: 0, n: 0, b: 0, role: null };
  if (r.role === 'P' || r.role === 'L') {
    const stockMul = ECON2.ROLE_STOCK[r.role] * (r.hub ? ECON2X.HUB_STOCK : 1);
    const n = Math.max(20, Math.round(baseNormal(good) * (ECON2X.SIZE[harbor.size] ?? 0.22) * stockMul));
    return { ...flowsFor(n, r.b, r.role), n, b: r.b, role: r.role };
  }
  const n = normalOf(eds, harbor, good);
  return { ...flowsFor(n, r.b, 'I'), n, b: r.b, role: 'I' };
}

// ------------------------------------------------------------------------------------------------ seasons
const MDAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
/** 'MM-DD' → 0-based day of a 365-day year. */
export function mmddDoy(s) { const [m, d] = String(s).split('-').map(Number); let doy = 0; for (let i = 0; i < m - 1; i++) doy += MDAYS[i]; return doy + Math.min(d, MDAYS[m - 1]) - 1; }
/** Day of year (0-based, 365-day year; 29 Feb counts as 28 Feb) of a sim time in seconds. */
export function doyOf(simTime) { const d = new Date(simTime * 1000); return mmddDoy(`${d.getUTCMonth() + 1}-${d.getUTCDate()}`); }
/** The §6.5 multiplier: f = max(0.2, (1 − A·m) + A·bump), m = 4W / (365π), bump = cos(π d / 2W) inside the window. */
export function bump(A, W, peakDoy, doy) {
  const m = (4 * W) / (365 * Math.PI);
  let d = Math.abs(doy - peakDoy) % 365; if (d > 182.5) d = 365 - d;
  const b = d < W ? Math.cos((Math.PI * d) / (2 * W)) : 0;
  return Math.max(0.2, 1 - A * m + A * b);
}
function seasonRows(eds, harbor, good, side, role) {
  const rows = eds.seasons.filter((r) => r.good === good && r.side === side);
  const own = rows.filter((r) => r.cc && r.cc.includes(harbor.country));
  const use = own.length ? own : rows.filter((r) => !r.cc);
  return use.filter((r) => !(r.latMin && Math.abs(harbor.lat) < r.latMin) && !(r.importers && role !== 'I'));
}
/** Season multiplier f for a side ('P' production, 'C' consumption) at a sim time (s). Ice applies to P. */
export function seasonMul(eds, harbor, good, side, simTime) {
  const role = rolesOf(eds, harbor).get(good)?.role || null;
  const doy = doyOf(simTime);
  let f = 1;
  for (const r of seasonRows(eds, harbor, good, side, role)) {
    let peak = mmddDoy(r.peak); if (r.hemi && harbor.lat < 0) peak = (peak + ECON2X.HEMI_SHIFT) % 365;
    f *= bump(r.A, r.W, peak, doy);
  }
  if (side === 'P' && iceOn(eds, harbor, simTime)) f *= 0.6;
  return f;
}
/** The strongest season driver right now: { why, f } or null (|f − 1| ≥ 0.25 shows a chip, §6.10). */
export function seasonWhy(eds, harbor, good, simTime) {
  const role = rolesOf(eds, harbor).get(good)?.role || null, doy = doyOf(simTime);
  let best = null;
  for (const side of role === 'P' ? ['P', 'C'] : ['C']) for (const r of seasonRows(eds, harbor, good, side, role)) {
    let peak = mmddDoy(r.peak); if (r.hemi && harbor.lat < 0) peak = (peak + ECON2X.HEMI_SHIFT) % 365;
    const f = bump(r.A, r.W, peak, doy);
    if (!best || Math.abs(f - 1) > Math.abs(best.f - 1)) best = { why: r.why, f, side, peak };
  }
  return best;
}
/** Ice season at an `ice`-tagged harbour (01-01 … 03-31). */
export function iceOn(eds, harbor, simTime) { return eds.ice.has(harbor.id) && doyOf(simTime) <= mmddDoy('03-31'); }

// ------------------------------------------------------------------------------------------------ stock and price
/** Closed-form step (§6.4): exact for constant multipliers; s floored at 0; rMul 0 = port shut. */
export function stepStock(s, { n, P, C, R = ECON2.R }, { fP = 1, fC = 1, rMul = 1 } = {}, hours) {
  const h = Math.max(0, Number(hours) || 0), net = P * fP - C * fC, Rp = R * rMul;
  if (!(Rp > 0)) return Math.max(0, s + h * net);
  const sEq = n + net / Rp;
  return Math.max(0, sEq + (s - sEq) * Math.pow(1 - Rp, h));
}
/** Equilibrium stock under multipliers (Infinity-safe for rMul 0). */
export function stockEq({ n, P, C, R = ECON2.R }, { fP = 1, fC = 1, rMul = 1 } = {}) { const Rp = R * rMul; return Rp > 0 ? Math.max(0, n + (P * fP - C * fC) / Rp) : null; }
/** σ = S × clamp(−0.8, 1.5, ln(n / s)), n and s floored at 1. */
export function sigma(S, n, s) { return S * clamp(ECON2.SIG_LO, ECON2.SIG_HI, Math.log(Math.max(1, n) / Math.max(1, s))); }
/** Landed fraction (§6.6): P −0.10, L 0, I min(LAND_MAX, 0.06 × fmul × seaKm / base + duty). */
export function landFrac({ role, base, fmul, seaKm, dutyRate = 0, landMax = ECON2.LAND_MAX }) {
  if (role === 'P') return -ECON2.EXPORT_DISC;
  if (role !== 'I') return 0;
  const km = Number.isFinite(seaKm) ? seaKm : 0;
  return Math.min(landMax ?? ECON2.LAND_MAX, (ECON2.FREIGHT_TKM * fmul * km) / base + (dutyRate || 0));
}
/** price = max(1, round(base × local × (1 + land + σ))) cr/t. */
export function unitPrice({ base, local = 1, role, S, land, n, s }) {
  const l = role === 'P' ? -ECON2.EXPORT_DISC : role === 'I' ? (land ?? 0) : 0;
  return Math.max(1, Math.round(base * local * (1 + l + sigma(S, n, s))));
}
/** Buyable tonnes above the reserve (§6.8); unlisted → 0. */
export function buyable(role, s, n) { const k = ECON2.RESERVE[role]; return k == null ? 0 : Math.max(0, Math.floor(s - k * n)); }
/** The general traders' price for an unlisted good (§6.9). */
export function dumpPrice(base) { return Math.round(ECON2.DUMP_FRAC * base); }
/** Trend (§6.10): expected price direction from s vs s_eq (stock refilling → price falls, −1). */
export function trendOf(s, sEq) { if (!(sEq > 0)) return 0; const d = (sEq - s) / sEq; return d > ECON2X.TREND_BAND ? -1 : d < -ECON2X.TREND_BAND ? 1 : 0; }

// ------------------------------------------------------------------------------------------------ requests
/** Lot size in tonnes (§7.2): bulk/liquid/gas 100, box 12, reefer 14, cars 1 CEU, animals 1 head, other 10. */
export function lotOf(good) {
  const r = catRow(good); if (!r) return 10;
  switch (r.cat) {
    case 'grains': case 'fert': case 'ores': case 'energy': case 'gas': return 100;
    case 'box': return 12; case 'reefer': return 14; case 'vehicles': case 'animals': return r.tPer;
    default: return 10;
  }
}
/** Rounds down to whole lots; 0 when below one lot. */
export function roundLot(t, good) { const lot = lotOf(good); const k = Math.floor((t + 1e-9) / lot); return k >= 1 ? Math.round(k * lot * 1000) / 1000 : 0; }
/** Request premium for stock ratio r (§7.2). */
export function requestPremium(r) { return Math.min(ECON2.REQ_PREM_MAX, ECON2.REQ_PREM_MIN + ECON2.REQ_PREM_K * (1 - r / ECON2.REQ_R)); }
/** Deadline (h) from the sea distance to the nearest maker at the 13 kn reference ship. */
export function requestDeadlineH(seaKm) { return clamp(ECON2.REQ_MIN_H, ECON2.REQ_MAX_H, Math.round((1.5 * (Number(seaKm) || 0)) / (ECON2.REQ_KN * 1.852) + 24)); }
/** { premium, unit, qty, deadlineH } | null (r ≥ 0.6 or below one lot). */
export function requestTerms({ r, price, seaKm, size, n, s, good }) {
  if (!(r < ECON2.REQ_R)) return null;
  const premium = Math.round(requestPremium(Math.max(0, r)) * 1e4) / 1e4;
  const qty = roundLot(Math.min(Math.max(0, n - s), ECON2X.REQ_QMAX[size] ?? ECON2X.REQ_QMAX.regional), good);
  if (!(qty > 0)) return null;
  return { premium, unit: Math.round(price * (1 + premium)), qty, deadlineH: requestDeadlineH(seaKm) };
}

// ------------------------------------------------------------------------------------------------ chains
/** k = 0.25 + 0.75 × min fill (fills are s / (0.5 n), capped at 1). */
export function chainK(fills) { const f = fills.length ? Math.min(1, ...fills.map((x) => Math.max(0, x))) : 1; return ECON2.CHAIN_K0 + (1 - ECON2.CHAIN_K0) * f; }
/** Normal input stock: ratio × P_out / (0.36 × R). */
export function chainNormalInput(ratio, Pout) { return Math.round((ratio * Pout) / (ECON2.INPUT_EQ * ECON2.R)); }
/** fill_i = min(1, s / (0.5 n)). */
export function chainFill(s, n) { return Math.min(1, Math.max(0, s) / (ECON2.CHAIN_FILL * Math.max(1, n))); }

// ------------------------------------------------------------------------------------------------ history and migration
/** 16-bit price index: round(price / base × 10,000), capped at 65,535; 0 means "no sample". */
export function histEncode(price, base) { if (!(price > 0) || !(base > 0)) return 0; return Math.min(65535, Math.max(1, Math.round((price / base) * 10000))); }
export function histDecode(idx, base) { return idx > 0 ? Math.round((idx * base) / 10000) : null; }
/** Old save → new normal stock, keeping how short or long the harbour was. */
export function migrateStock(sOld, tOld, nNew) { if (!(tOld > 0) || !Number.isFinite(sOld)) return Math.round(nNew); return Math.max(0, Math.round((sOld / tOld) * nNew)); }

/** The trade quote (server/economy.js tradeQuote with TRADE { SPREAD 0.02, IMPACT, STEPS 8 }) on a pure row:
 *  the unit price is the mean price at 8 points across the stock change the trade causes, ± the spread. */
export function quote(row, qty, side, { spread = 0.02, impact = true, steps = 8 } = {}) {
  const q = Math.max(0, Number(qty) || 0), s0 = row.s, dir = side === 'buy' ? -1 : 1;
  let mid = unitPrice(row);
  if (impact && q > 0) { let sum = 0; for (let k = 0; k < steps; k++) sum += unitPrice({ ...row, s: Math.max(0, s0 + dir * q * (k + 0.5) / steps) }); mid = sum / steps; }
  const unit = Math.max(1, Math.round(mid * (side === 'buy' ? 1 + spread : 1 - spread)));
  return { unit, total: Math.round(unit * q) };
}
