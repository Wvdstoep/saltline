// Jobs, black market, commodity markets (supply/demand), fees and the ship market. Pure functions over
// harbour/world data + RNG; the Game owns the mutable per-harbour state ({ jobs, market, stock, target, used… }).
import { GOODS, SHIP_CLASSES, FEES } from '../shared/constants.js';
import { haversine, destination } from '../shared/geo.js';
import { HARBORS, FISHING_GROUNDS, PLATFORMS, harborById } from './harbors.js';
import { RATES } from '../shared/rates.js';
import { JOBTIME, refClassFor, budgetFor } from '../shared/jobtime.js'; // V6 item 5: contract hours rated for a reference ship
import { payOf, payInfoOf } from '../shared/jobs/types.js';   // YARD lane D: runner jobs carry pay as { cr, … }
import { shipValueCompat, modelOf } from '../shared/ships/index.js';   // SHIPYARD H8b

export const PAY_PER_T_KM = 0.08;
export const SMUGGLE_MULT = 5;
export const LEGAL_GOODS = ['grain', 'steel', 'machinery', 'containers'];
export const CONTRABAND = ['cigarettes', 'weapons', 'narcotics', 'antiquities'];
/** Goods that trade on harbour markets (everything that is not contraband). */
export const MARKET_GOODS = Object.keys(GOODS).filter((g) => !GOODS[g].contraband);
/** Supply/demand tuning (docs/V3-CONTRACTS.md §3): price = base × local × clamp(0.55, 1.9, sqrt(target / stock)). */
export const ECON = { PRICE_MIN: 0.55, PRICE_MAX: 1.9, DRIFT_PER_H: 0.05, USED_REFRESH_H: 6, TREND_BAND: 0.05, DEMAND_BONUS_MAX: 0.3 };

let jobSeq = 1;
export function setJobSeq(n) { jobSeq = Math.max(jobSeq, n); }
export function nextJobId() { return `j${(jobSeq++).toString(36)}`; }

const SIZE_JOBS = { mega: 24, major: 16, regional: 10, minor: 6 };   // YARD §5.7 board sizes (= server/jobsgen.js BOARD_SIZE)
const SIZE_MULT = { mega: 1.0, major: 1.0, regional: 1.05, minor: 1.15 };

export function distKm(a, b) { return haversine(a.lat, a.lon, b.lat, b.lon) / 1000; }

// Fishing grounds within 500 km (or 400 km of their edge) and platforms within 450 km get contracts from a harbour; a remote ground
// or field (Flemish Cap, Sea of Okhotsk, Sakhalin, Browse) is still served by its nearest harbour up to REMOTE_KM.
export const REMOTE_KM = 800;
const nearestHarbor = new Map();
export function nearestHarborId(p) {
  if (!nearestHarbor.has(p)) {
    let best = null, bd = Infinity;
    for (const h of HARBORS) { const d = distKm(p, h); if (d < bd) { bd = d; best = h.id; } }
    nearestHarbor.set(p, best);
  }
  return nearestHarbor.get(p);
}

// Destination mix by distance band (v7 world coverage): with ~340 harbours worldwide a plain per-harbour weight would
// send most contracts across an ocean, so a band is drawn first (short hop, coastal/regional, sea, ocean; empty bands
// are skipped) and then a harbour inside it, weighted by size.
// Board generation: offers posted by an older generator (before the world-wide destination bands) are withdrawn on start.
export const JOB_GEN = 8;   // YARD §8: gen-7 offers leave the boards at start; accepted gen-7 jobs finish on the legacy path
export const DEST_BANDS = [{ maxKm: 60, p: 0.06 }, { maxKm: 700, p: 0.6 }, { maxKm: 2500, p: 0.24 }, { maxKm: Infinity, p: 0.1 }];
/** Fishing grounds a harbour offers contracts on, nearest first ({g, d} with d in km); the board picks among the first 3. */
export function groundsFor(from) {
  return FISHING_GROUNDS.map((g) => ({ g, d: distKm(from, g) }))
    .filter((x) => x.d < 500 || x.d - x.g.radiusKm < 400 || (x.d < REMOTE_KM && nearestHarborId(x.g) === from.id)).sort((a, b) => a.d - b.d);
}
/** Offshore installations a harbour offers supply runs to, nearest first ({p, d}); the board picks among the first 3. */
export function platformsFor(from) {
  return PLATFORMS.map((p) => ({ p, d: distKm(from, p) }))
    .filter((x) => x.d < 450 || (x.d < REMOTE_KM && nearestHarborId(x.p) === from.id)).sort((a, b) => a.d - b.d);
}

export function pickDestination(from, rnd, maxKm = 1e9) {
  const bands = DEST_BANDS.map((b) => ({ ...b, cands: [], total: 0 }));
  for (const h of HARBORS) {
    if (h.id === from.id) continue;
    const d = distKm(from, h);
    if (d > maxKm) continue;
    const w = h.size === 'mega' ? 1.5 : h.size === 'minor' ? 0.7 : 1;
    const b = bands.find((x) => d < x.maxKm);
    b.cands.push({ h, w, d }); b.total += w;
  }
  const live = bands.filter((b) => b.cands.length);
  if (!live.length) return null;
  const pTotal = live.reduce((s, b) => s + b.p, 0);
  let r = rnd() * pTotal, band = live[live.length - 1];
  for (const b of live) { r -= b.p; if (r <= 0) { band = b; break; } }
  r = rnd() * band.total;
  for (const c of band.cands) { r -= c.w; if (r <= 0) return c; }
  return band.cands[band.cands.length - 1];
}

// V6 item 5 (docs/V6-QUICK-CONTRACTS.md §5.3–§5.4): a contract carries a budget of SHIP hours rated for a reference ship
// with 40–80 % margin (feasible by construction), the distances it was rated on, and stays on the board for 24 h.
const r1 = (v) => Math.round(v * 10) / 10;
function seaKmFor(env, from, to, gcKm) { let km = null; try { km = env && env.seaKm ? env.seaKm(from.id, to.id) : null; } catch { km = null; } return Number.isFinite(km) && km > 0 ? r1(km) : r1(gcKm * RATES.DETOUR); }
function rateJob(job, simTime, rnd) {
  const cls = refClassFor(job, rnd);
  const margin = JOBTIME.MARGIN_MIN + rnd() * (JOBTIME.MARGIN_MAX - JOBTIME.MARGIN_MIN);
  job.hours = budgetFor(job, cls, margin);
  job.ref = { cls, margin: Math.round(margin * 100) / 100 };
  job.postedAt = simTime; job.expiresAt = simTime + JOBTIME.BOARD_TTL_H * 3600;
  job.gen = JOB_GEN;
  return job;
}

/** `env.towSpot(lat, lon, draft)` (optional) says whether a disabled vessel can lie there: open, deep water away from land. */
export function generateJob(from, simTime, rnd, forceType, env = {}) {
  const roll = rnd();
  const type = forceType || (roll < 0.42 ? 'freight' : roll < 0.57 ? 'passengers' : roll < 0.7 ? 'fishing' : roll < 0.8 ? 'charter' : roll < 0.9 ? 'supply' : 'tow');
  if (type === 'fishing') {
    const grounds = groundsFor(from);
    if (!grounds.length) return generateJob(from, simTime, rnd, 'freight', env);
    const { g, d: gd } = grounds[Math.floor(rnd() * Math.min(3, grounds.length))];
    const qty = Math.round((20 + rnd() * 120) / 5) * 5;
    return rateJob({
      id: nextJobId(), type: 'fishing', from: from.id, to: from.id, ground: g.id, groundName: g.name, good: 'fish', qty,
      pay: Math.round(qty * 950 * SIZE_MULT[from.size]), contraband: false,
      groundKm: r1(Math.max(0, gd - g.radiusKm) * RATES.DETOUR), richness: g.richness,
      title: `Catch ${qty} t of fish on the ${g.name} and land it here`,
    }, simTime, rnd);
  }
  if (type === 'supply') {
    const plats = platformsFor(from);
    if (!plats.length) return generateJob(from, simTime, rnd, 'freight', env);
    const { p, d } = plats[Math.floor(rnd() * Math.min(3, plats.length))];
    const qty = [40, 80, 120, 200, 350][Math.floor(rnd() * 5)];
    const pay = Math.round((qty * d * PAY_PER_T_KM * 2.2 + 4000) * SIZE_MULT[from.size]);
    return rateJob({
      id: nextJobId(), type: 'supply', from: from.id, to: from.id, platform: p.id, platformName: p.name, at: { lat: p.lat, lon: p.lon }, good: 'supplies', qty, pay, distKm: Math.round(d),
      platformKm: r1(d * RATES.DETOUR), contraband: false, loaded: null,
      title: `Supply run: ${qty} t of offshore supplies to ${p.name}`,
    }, simTime, rnd);
  }
  if (type === 'tow') {
    const dest = pickDestination(from, rnd, 400) || pickDestination(from, rnd);
    if (!dest) return generateJob(from, simTime, rnd, 'freight', env);
    // A disabled vessel somewhere offshore within 30–120 km of this harbour, on open water deep enough to float her.
    const victim = ['trawler', 'coaster', 'sloop', 'myacht', 'ketch', 'cruiser'][Math.floor(rnd() * 6)];
    let at = null;
    for (let i = 0; i < 24 && !at; i++) {
      const cand = destination(from.lat, from.lon, rnd() * 360, 30000 + rnd() * 90000);
      if (!env.towSpot || env.towSpot(cand.lat, cand.lon, SHIP_CLASSES[victim].draft)) at = cand;
    }
    if (!at) return generateJob(from, simTime, rnd, 'freight', env);
    const dOut = distKm(from, at), dIn = distKm(at, dest.h), d = dOut + dIn;
    const pay = Math.round((d * 120 + 6000) * SIZE_MULT[from.size]);
    return rateJob({
      id: nextJobId(), type: 'tow', from: from.id, to: dest.h.id, at, victimCls: victim, pay, distKm: Math.round(d),
      towKm: { toCasualty: r1(dOut * RATES.DETOUR), toDest: r1(dIn * RATES.DETOUR) }, contraband: false,
      title: `Tow a disabled ${SHIP_CLASSES[victim].name.toLowerCase()} at ${at.lat.toFixed(2)}°, ${at.lon.toFixed(2)}° to ${dest.h.name}`,
    }, simTime, rnd);
  }
  const dest = pickDestination(from, rnd);
  if (!dest) return null;
  if (type === 'passengers') {
    const pax = Math.round(4 + rnd() * rnd() * 396);
    const pay = Math.round(pax * (25 + dest.d * 0.35) * SIZE_MULT[from.size]);
    return rateJob({
      id: nextJobId(), type: 'passengers', from: from.id, to: dest.h.id, pax, pay, distKm: Math.round(dest.d),
      seaKm: seaKmFor(env, from, dest.h, dest.d), contraband: false,
      title: `Ferry ${pax} passengers to ${dest.h.name}`,
    }, simTime, rnd);
  }
  if (type === 'charter') {
    const pax = 2 + Math.floor(rnd() * 10);
    const pay = Math.round((pax * (260 + dest.d * 1.6) + 1500) * SIZE_MULT[from.size]);
    return rateJob({
      id: nextJobId(), type: 'charter', from: from.id, to: dest.h.id, pax, pay, distKm: Math.round(dest.d), needsCat: ['motor yacht', 'sailing yacht', 'passenger'],
      seaKm: seaKmFor(env, from, dest.h, dest.d), contraband: false,
      title: `Private charter: ${pax} guests to ${dest.h.name} (yacht or ferry)`,
    }, simTime, rnd);
  }
  const good = LEGAL_GOODS[Math.floor(rnd() * LEGAL_GOODS.length)];
  const sizes = [120, 250, 400, 600, 900, 1100, 1800, 2500, 3600, 8000, 20000];
  const qty = sizes[Math.floor(rnd() * rnd() * sizes.length)];
  const pay = Math.round(qty * dest.d * PAY_PER_T_KM * (1 + 0.15 * rnd()) * SIZE_MULT[from.size] + 800);
  return rateJob({
    id: nextJobId(), type: 'freight', from: from.id, to: dest.h.id, good, qty, pay, distKm: Math.round(dest.d),
    seaKm: seaKmFor(env, from, dest.h, dest.d), contraband: false,
    title: `Freight ${qty} t of ${GOODS[good].name} to ${dest.h.name}`,
  }, simTime, rnd);
}

export function generateSmugglingJob(from, simTime, rnd, env = {}) {
  const dest = pickDestination(from, rnd);
  if (!dest) return null;
  const good = CONTRABAND[Math.floor(rnd() * CONTRABAND.length)];
  const qty = [40, 80, 150, 250, 400][Math.floor(rnd() * 5)];
  const pay = Math.round(qty * dest.d * PAY_PER_T_KM * SMUGGLE_MULT * (1 + 0.3 * rnd()) + 15000);
  return rateJob({
    id: nextJobId(), type: 'smuggling', from: from.id, to: dest.h.id, good, qty, pay, distKm: Math.round(dest.d),
    seaKm: seaKmFor(env, from, dest.h, dest.d), contraband: true,
    title: `Run ${qty} t of ${GOODS[good].name} to ${dest.h.name}. No questions.`,
  }, simTime, rnd);
}

export function jobCountFor(harbor) { return SIZE_JOBS[harbor.size] || 3; }

/** Public view of a job for the chart's job boards (GET /api/jobs): the §5.3 board fields (ship-hour budget, posting
 *  window, reference ship, the distances it was rated on) so every client can estimate it for its own ship. */
export function publicJob(j) {
  const to = harborById(j.to);
  const perUnit = j.qty > 0 ? j.qty : j.pax > 0 ? j.pax : 0;
  return {
    id: j.id, type: j.type, title: j.title, from: j.from, to: j.to, toName: to ? to.name : j.to, pay: payOf(j), payInfo: payInfoOf(j),
    payPerT: perUnit ? Math.round(payOf(j) / perUnit) : null, distKm: j.distKm ?? null, needsCat: j.needsCat || null,
    gen: j.gen ?? null, family: j.family || j.type, cargo: j.cargo || null, needs: j.needs || null, steps: j.steps || null, legs: j.legs || null,
    timetable: j.timetable || null, level: j.level ?? null, crossings: j.crossings ?? null, entries: j.entries ?? null, band: j.band || null,
    hours: j.hours ?? null, postedAt: j.postedAt ?? null, expiresAt: j.expiresAt ?? null, ref: j.ref || null,
    seaKm: j.seaKm ?? null, groundKm: j.groundKm ?? null, richness: j.richness ?? null, platformKm: j.platformKm ?? null, towKm: j.towKm || null,
    good: j.good || null, qty: j.qty || null, pax: j.pax || null, at: j.at || null, platformName: j.platformName || null, groundName: j.groundName || null,
  };
}

// ------------------------------------------------------------------------------------------ supply / demand
// Each harbour holds a stock (t) of every market good and drifts 5 %/h toward a target. Prices follow
// base × local × clamp(sqrt(target / stock)): a port short of a good pays up to 1.9×, a glutted one 0.55×.
// `local` is the harbour's trade profile (what the country exports is cheap and plentiful there).
const SIZE_STOCK = { mega: 1, major: 0.5, regional: 0.22, minor: 0.08 };
const BASE_TARGET = { fish: 2500, grain: 30000, steel: 15000, machinery: 4000, containers: 25000, fuel: 20000, supplies: 3000 };
const INDUSTRIAL = new Set(['steel', 'machinery', 'containers', 'fuel']);
// < 1 = exports it (cheap, deep stock), > 1 = imports it (dear, thin stock).
const COUNTRY_PROFILE = {
  NL: { containers: 0.9, machinery: 0.92, grain: 0.95, fuel: 0.9 }, BE: { containers: 0.92, steel: 0.9, machinery: 0.95 },
  DE: { steel: 0.86, machinery: 0.88, containers: 0.95, grain: 1.05 }, GB: { fish: 0.92, fuel: 0.95, machinery: 1.05, steel: 1.06 },
  FR: { grain: 0.88, machinery: 0.97, fish: 0.96 }, IE: { fish: 0.9, grain: 1.08, steel: 1.12 }, DK: { fish: 0.86, grain: 0.9, fuel: 1.04 },
  NO: { fish: 0.8, fuel: 0.85, supplies: 0.9, grain: 1.12, steel: 1.08 }, SE: { steel: 0.9, machinery: 0.95, grain: 1.04 },
  FI: { machinery: 0.95, steel: 0.96, grain: 1.06 }, PL: { steel: 0.9, grain: 0.92, containers: 1.08 },
  RU: { fuel: 0.82, steel: 0.9, grain: 0.9, machinery: 1.15, containers: 1.1 }, IS: { fish: 0.75, grain: 1.2, steel: 1.2, machinery: 1.15, fuel: 1.1 },
  PT: { fish: 0.9, machinery: 1.06 }, ES: { fish: 0.92, fuel: 1.02 }, GI: { fuel: 0.9 }, IT: { machinery: 0.9, steel: 0.95, grain: 1.08 },
  GR: { containers: 0.95, grain: 1.08 }, TR: { steel: 0.9, machinery: 1.02 }, EG: { grain: 1.15, fuel: 0.95 },
  AE: { fuel: 0.7, grain: 1.15, machinery: 1.08 }, IN: { steel: 0.88, grain: 0.95, machinery: 1.05 }, LK: { containers: 0.95, grain: 1.1 },
  SG: { fuel: 0.82, containers: 0.85, machinery: 0.95, grain: 1.12 }, ID: { fuel: 0.9, fish: 0.9, machinery: 1.12 },
  PH: { fish: 0.88, machinery: 1.12, steel: 1.1 }, HK: { containers: 0.85, machinery: 0.9, grain: 1.15 },
  CN: { containers: 0.8, steel: 0.82, machinery: 0.85, grain: 1.1 }, KR: { steel: 0.85, machinery: 0.88, containers: 0.9 },
  JP: { machinery: 0.85, steel: 0.9, fish: 0.95, grain: 1.15, fuel: 1.1 }, AU: { grain: 0.82, fuel: 1.04, machinery: 1.1 },
  NZ: { fish: 0.9, grain: 1.05, machinery: 1.12 }, ZA: { steel: 0.92, grain: 1.05 }, KE: { machinery: 1.15, steel: 1.12, fuel: 1.08 },
  SN: { fish: 0.85, machinery: 1.15 }, BR: { grain: 0.8, steel: 0.9, machinery: 1.08 }, AR: { grain: 0.78, fish: 0.95, machinery: 1.1 },
  CL: { fish: 0.85, machinery: 1.1 }, PA: { containers: 0.92, fuel: 0.95 }, US: { grain: 0.85, fuel: 0.85, machinery: 0.95 },
  CA: { grain: 0.86, fish: 0.92, fuel: 0.92 },
};

function seededRnd(seed) { // mulberry32 over a string hash: deterministic per harbour
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  let a = h >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const profileCache = new Map();
/** Per-harbour price multipliers {good: 0.7..1.3}: country trade table × size × seeded noise. Deterministic. */
export function localProfile(harbor) {
  let prof = profileCache.get(harbor.id);
  if (prof) return prof;
  const rnd = seededRnd(harbor.id);
  const country = COUNTRY_PROFILE[harbor.country] || {};
  prof = {};
  for (const g of MARKET_GOODS) {
    let m = country[g] ?? 1;
    if (INDUSTRIAL.has(g)) m *= harbor.size === 'mega' ? 0.95 : harbor.size === 'minor' ? 1.08 : harbor.size === 'regional' ? 1.03 : 1;
    if (g === 'fish' && harbor.size === 'minor') m *= 0.94; // fishing harbours land fish
    m *= 0.94 + rnd() * 0.12;
    prof[g] = Math.round(m * 1000) / 1000;
  }
  profileCache.set(harbor.id, prof);
  return prof;
}

/** Target stock (t) per good for a harbour: size-scaled, bigger for the goods it exports. */
export function targetStock(harbor) {
  const prof = localProfile(harbor), out = {};
  for (const g of MARKET_GOODS) out[g] = Math.max(20, Math.round(BASE_TARGET[g] * (SIZE_STOCK[harbor.size] || 0.2) * (prof[g] < 1 ? 1 + (1 - prof[g]) * 2.5 : 1 - (prof[g] - 1) * 1.2)));
  return out;
}

/** Fresh stock/target for a harbour (stock 60–140 % of target → prices ±30 % around local). */
export function initEconomy(harbor, rnd) {
  const target = targetStock(harbor), stock = {};
  for (const g of MARKET_GOODS) stock[g] = Math.round(target[g] * (0.6 + rnd() * 0.8));
  return { stock, target };
}

export function priceOf(harbor, g, stock, target) {
  const ratio = Math.sqrt(Math.max(1, target) / Math.max(1, stock));
  return Math.max(1, Math.round(GOODS[g].base * localProfile(harbor)[g] * Math.min(ECON.PRICE_MAX, Math.max(ECON.PRICE_MIN, ratio))));
}

/** Recompute st.market (cr/t) from st.stock/st.target. Adds missing goods, drops unknown ones. */
export function refreshPrices(harbor, st) {
  if (!st.stock || !st.target) Object.assign(st, initEconomy(harbor, Math.random));
  const m = st.market || (st.market = {});
  for (const g of Object.keys(m)) if (!GOODS[g] || GOODS[g].contraband) delete m[g];
  for (const g of MARKET_GOODS) {
    if (!(st.target[g] > 0)) st.target[g] = targetStock(harbor)[g];
    if (!(st.stock[g] >= 0)) st.stock[g] = st.target[g];
    m[g] = priceOf(harbor, g, st.stock[g], st.target[g]);
  }
  return m;
}

/** Stock drifts 5 %/h toward target with a little noise so prices keep moving. */
export function driftEconomy(st, hours, rnd) {
  if (!st.stock || !st.target || !(hours > 0)) return;
  const k = 1 - Math.pow(1 - ECON.DRIFT_PER_H, hours);
  for (const g of MARKET_GOODS) {
    const t = st.target[g] || 1, s = st.stock[g] ?? t;
    st.stock[g] = Math.max(0, Math.round(s + (t - s) * k + (rnd() - 0.5) * 0.02 * t * Math.min(24, hours)));
  }
}

/** Expected PRICE direction per good: stock below target refills → price falls (−1); glut clears → price rises (+1). */
export function marketTrend(st) {
  const out = {};
  if (!st.stock || !st.target) return out;
  for (const g of MARKET_GOODS) {
    const t = st.target[g] || 1, d = (t - (st.stock[g] ?? t)) / t;
    out[g] = d > ECON.TREND_BAND ? -1 : d < -ECON.TREND_BAND ? 1 : 0;
  }
  return out;
}

/** Contract pay bonus (0..0.3) when the destination is short of the delivered good. */
export function demandBonus(st, good) {
  if (!st || !st.stock || !st.target || !good || !(st.target[good] > 0)) return 0;
  const short = 1 - (st.stock[good] ?? st.target[good]) / st.target[good];
  return Math.round(Math.min(ECON.DEMAND_BONUS_MAX, Math.max(0, short * 0.5)) * 100) / 100;
}

/** Legacy: a flat price table with no supply model (kept for old callers; the Game uses initEconomy/refreshPrices). */
export function initMarket(harbor, rnd) {
  const m = {};
  for (const [g, def] of Object.entries(GOODS)) {
    if (def.contraband) continue;
    m[g] = Math.round(def.base * (0.78 + rnd() * 0.44) * (harbor.fuelMul && g === 'fuel' ? harbor.fuelMul : 1));
  }
  return m;
}

/** Legacy price drift for a flat market table (kept for old callers). */
export function driftMarket(market, rnd) {
  for (const g of Object.keys(market)) {
    if (!GOODS[g]) { delete market[g]; continue; }
    const base = GOODS[g].base;
    const target = base * (0.78 + rnd() * 0.44);
    market[g] = Math.round(market[g] + (target - market[g]) * 0.08);
  }
  for (const [g, def] of Object.entries(GOODS)) if (!def.contraband && market[g] == null) market[g] = Math.round(def.base * (0.78 + rnd() * 0.44));
}

// ------------------------------------------------------------------------------------------ ship market
// Used-ship listings: 1–4 second-hand hulls per harbour, priced by condition; bigger ports see bigger ships.
let listingSeq = 1;
export function generateUsedShips(harbor, rnd) {
  const n = harbor.size === 'mega' ? 4 : harbor.size === 'major' ? 3 : harbor.size === 'minor' ? 1 : 2;
  const pool = Object.values(SHIP_CLASSES).filter((c) => c.price > 0 && (harbor.size === 'mega' || c.price < 5e6) && (harbor.size !== 'minor' || c.price < 1e6));
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = pool[Math.floor(rnd() * pool.length)];
    const cond = Math.round(35 + rnd() * 55);
    const price = Math.round(c.price * (0.4 + 0.45 * (cond / 100)) * (0.9 + rnd() * 0.2));
    out.push({ id: `u${(listingSeq++).toString(36)}${Math.floor(rnd() * 1e4).toString(36)}`, cls: c.id, cond, price, name: c.name, specs: shipSpecs(c.id) });
  }
  return out;
}

export function shipValue(cls, cond) { return shipValueCompat(cls, cond, SHIP_CLASSES); }   // SHIPYARD H8b: same numbers for every legacy id
/** The starter coaster is maintained like a 120k hull; everything else by its price. */
export function hullBasis(cls) { return Math.max(120000, (SHIP_CLASSES[cls] || SHIP_CLASSES.coaster).price); }
export function repairCostFor(cls, cond) {
  return Math.round((100 - cond) / 100 * hullBasis(cls) * 0.06 + (100 - cond) * 40);
}
/** Yard service: 1 % of the hull price, resets the 30-day maintenance clock. */
export function serviceCostFor(cls) { return Math.round(hullBasis(cls) * FEES.SERVICE_FRAC); }
/** Wear multiplier from overdue maintenance: +2 %/day overdue up to +60 %. */
export function serviceWearMul(serviceDue, simTime) {
  if (!(serviceDue > 0)) return 1;
  const overdueDays = Math.max(0, (simTime - serviceDue) / 86400);
  return 1 + Math.min(FEES.SERVICE_WEAR_MAX, overdueDays * FEES.SERVICE_WEAR_PER_DAY);
}
/** Spec sheet shown in the shipyard and used by the chart's job boards. */
export function shipSpecs(cls) {
  const C = SHIP_CLASSES[cls]; if (!C) return null;
  const m = modelOf(cls);
  return { length: C.length, beam: C.beam, draft: C.draft, maxKn: C.maxKn, capacity: C.capacity, pax: C.pax, fuelCap: C.fuelCap, burn: C.burn, crewCost: C.crewCost, price: C.price, displacement: C.displacement, sail: !!C.sail, towPower: C.towPower || 0,
    ...(m ? { model: m.id, type: m.type, era: m.era, refName: m.refName, dwt: m.dwt, gt: m.gt, depth: m.depth, draftHull: m.draftHull ?? null, airDraft: C.airDraft ?? m.airDraft, kW: m.kW, engine: m.engine.label, svcKn: m.svcKn,
      crew: m.crew, usdM: m.usdM, units: m.units, handling: m.handling, eq: m.eq, eco: C.eco ?? m.stats.eco, verify: m.verify } : {}) };   // SHIPYARD §4.7 spec sheet
}

// ------------------------------------------------------------------------------------------ harbour fees
const SIZE_DUES = { mega: 1.4, major: 1.2, regional: 1, minor: 0.6 };
export function portDues(cls, harbor) { return Math.round((SHIP_CLASSES[cls] || SHIP_CLASSES.coaster).displacement * FEES.DUES_PER_T * (SIZE_DUES[harbor.size] || 1)); }
export function berthFeePerDay(cls) { return Math.round((SHIP_CLASSES[cls] || SHIP_CLASSES.coaster).displacement * FEES.BERTH_PER_T_DAY); }
/** Pilotage is compulsory for ships over 90 m at mega/major ports. */
export function pilotageFee(cls, harbor) {
  const C = SHIP_CLASSES[cls] || SHIP_CLASSES.coaster;
  if (C.length <= FEES.PILOTAGE_MIN_LENGTH_M || (harbor.size !== 'mega' && harbor.size !== 'major')) return 0;
  return Math.round(C.displacement * FEES.PILOTAGE_PER_T);
}
export function tugCostFor(cls) { return Math.max(FEES.TUG_MIN, Math.round((SHIP_CLASSES[cls] || SHIP_CLASSES.coaster).displacement * FEES.TUG_PER_T)); }

export function cargoMass(cargo) { return cargo.reduce((s, c) => s + c.qty, 0); }
export function cargoValue(cargo, filter) {
  return cargo.filter(filter || (() => true)).reduce((s, c) => s + c.qty * GOODS[c.good].base, 0);
}
export function shipCapacity(cls) { return (SHIP_CLASSES[cls] || SHIP_CLASSES.coaster).capacity; }

// ------------------------------------------------------------------------------------------ trade quotes
// docs/V6-QUICK-CONTRACTS.md §3.3: what a trade of `qty` t costs or pays. Defaults = the v0.4 rule (one price per good,
// the whole action at the pre-trade price). Wave 2 sets SPREAD 0.01 and IMPACT true (docs/V5-WAVE2-DESIGN.md §3.10).
export const TRADE = { SPREAD: 0.02, IMPACT: true, STEPS: 8 };
/** side 'buy' | 'sell'. Returns { unit (integer cr/t), total (integer cr) }. With IMPACT the unit price is the mean of the
 *  price at STEPS points spread over the stock change the trade causes (buying lowers the stock, selling raises it). */
export function tradeQuote(harbor, st, good, qty, side) {
  const q = Math.max(0, Number(qty) || 0), s0 = st.stock?.[good] ?? 0, t = st.target?.[good] ?? 1, dir = side === 'buy' ? -1 : 1;
  let mid = priceOf(harbor, good, s0, t);
  if (TRADE.IMPACT && q > 0) {
    let sum = 0;
    for (let k = 0; k < TRADE.STEPS; k++) sum += priceOf(harbor, good, Math.max(0, s0 + dir * q * (k + 0.5) / TRADE.STEPS), t);
    mid = sum / TRADE.STEPS;
  }
  const unit = Math.max(1, Math.round(mid * (side === 'buy' ? 1 + TRADE.SPREAD : 1 - TRADE.SPREAD)));
  return { unit, total: Math.round(unit * q) };
}
