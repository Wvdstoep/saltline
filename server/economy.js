// Jobs, black market, commodity markets and the used-ship market. Pure functions over harbour/world data + RNG.
import { GOODS, SHIP_CLASSES } from '../shared/constants.js';
import { haversine, destination } from '../shared/geo.js';
import { HARBORS, FISHING_GROUNDS, PLATFORMS } from './harbors.js';

export const PAY_PER_T_KM = 0.08;
export const SMUGGLE_MULT = 5;
export const LEGAL_GOODS = ['grain', 'steel', 'machinery', 'containers'];
export const CONTRABAND = ['cigarettes', 'weapons', 'narcotics', 'antiquities'];

let jobSeq = 1;
export function setJobSeq(n) { jobSeq = Math.max(jobSeq, n); }
export function nextJobId() { return `j${(jobSeq++).toString(36)}`; }

const SIZE_JOBS = { mega: 8, major: 6, regional: 5, minor: 3 };
const SIZE_MULT = { mega: 1.0, major: 1.0, regional: 1.05, minor: 1.15 };

export function distKm(a, b) { return haversine(a.lat, a.lon, b.lat, b.lon) / 1000; }

function pickDestination(from, rnd, maxKm = 1e9) {
  const cands = [];
  for (const h of HARBORS) {
    if (h.id === from.id) continue;
    const d = distKm(from, h);
    if (d > maxKm) continue;
    let w = d < 60 ? 0.3 : d < 700 ? 1.0 : d < 2500 ? 0.25 : 0.06;
    if (h.size === 'mega') w *= 1.5; else if (h.size === 'minor') w *= 0.7;
    cands.push({ h, w, d });
  }
  if (!cands.length) return null;
  const total = cands.reduce((s, c) => s + c.w, 0);
  let r = rnd() * total;
  for (const c of cands) { r -= c.w; if (r <= 0) return c; }
  return cands[cands.length - 1];
}

// Jobs are in real time now: deadlines are generous multiples of the sailing time at 12 knots.
function hoursFor(km, rnd) { return Math.max(4, km / 22 + 6 + rnd() * 12); }

export function generateJob(from, simTime, rnd, forceType) {
  const roll = rnd();
  const type = forceType || (roll < 0.42 ? 'freight' : roll < 0.57 ? 'passengers' : roll < 0.7 ? 'fishing' : roll < 0.8 ? 'charter' : roll < 0.9 ? 'supply' : 'tow');
  if (type === 'fishing') {
    const grounds = FISHING_GROUNDS.map((g) => ({ g, d: distKm(from, g) })).filter((x) => x.d < 500).sort((a, b) => a.d - b.d);
    if (!grounds.length) return generateJob(from, simTime, rnd, 'freight');
    const g = grounds[Math.floor(rnd() * Math.min(3, grounds.length))].g;
    const qty = Math.round((20 + rnd() * 120) / 5) * 5;
    return {
      id: nextJobId(), type: 'fishing', from: from.id, to: from.id, ground: g.id, groundName: g.name, good: 'fish', qty,
      pay: Math.round(qty * 950 * SIZE_MULT[from.size]), deadline: simTime + 3600 * (18 + rnd() * 30), contraband: false,
      title: `Catch ${qty} t of fish on the ${g.name} and land it here`,
    };
  }
  if (type === 'supply') {
    const plats = PLATFORMS.map((p) => ({ p, d: distKm(from, p) })).filter((x) => x.d < 450).sort((a, b) => a.d - b.d);
    if (!plats.length) return generateJob(from, simTime, rnd, 'freight');
    const { p, d } = plats[Math.floor(rnd() * Math.min(3, plats.length))];
    const qty = [40, 80, 120, 200, 350][Math.floor(rnd() * 5)];
    const pay = Math.round((qty * d * PAY_PER_T_KM * 2.2 + 4000) * SIZE_MULT[from.size]);
    return {
      id: nextJobId(), type: 'supply', from: from.id, to: from.id, platform: p.id, platformName: p.name, at: { lat: p.lat, lon: p.lon }, good: 'supplies', qty, pay, distKm: Math.round(d),
      deadline: simTime + 3600 * hoursFor(d, rnd), contraband: false, loaded: null,
      title: `Supply run: ${qty} t of offshore supplies to ${p.name}`,
    };
  }
  if (type === 'tow') {
    const dest = pickDestination(from, rnd, 400) || pickDestination(from, rnd);
    if (!dest) return generateJob(from, simTime, rnd, 'freight');
    // A disabled vessel somewhere offshore within 30–120 km of this harbour.
    let at = null;
    for (let i = 0; i < 12 && !at; i++) {
      const cand = destination(from.lat, from.lon, rnd() * 360, 30000 + rnd() * 90000);
      at = cand;
    }
    const d = distKm(from, at) + distKm(at, dest.h);
    const victim = ['trawler', 'coaster', 'sloop', 'myacht', 'ketch', 'cruiser'][Math.floor(rnd() * 6)];
    const pay = Math.round((d * 120 + 6000) * SIZE_MULT[from.size]);
    return {
      id: nextJobId(), type: 'tow', from: from.id, to: dest.h.id, at, victimCls: victim, pay, distKm: Math.round(d),
      deadline: simTime + 3600 * hoursFor(d, rnd), contraband: false,
      title: `Tow a disabled ${SHIP_CLASSES[victim].name.toLowerCase()} at ${at.lat.toFixed(2)}°, ${at.lon.toFixed(2)}° to ${dest.h.name}`,
    };
  }
  const dest = pickDestination(from, rnd);
  if (!dest) return null;
  if (type === 'passengers') {
    const pax = Math.round(4 + rnd() * rnd() * 396);
    const pay = Math.round(pax * (25 + dest.d * 0.35) * SIZE_MULT[from.size]);
    return {
      id: nextJobId(), type: 'passengers', from: from.id, to: dest.h.id, pax, pay, distKm: Math.round(dest.d),
      deadline: simTime + 3600 * hoursFor(dest.d, rnd), contraband: false,
      title: `Ferry ${pax} passengers to ${dest.h.name}`,
    };
  }
  if (type === 'charter') {
    const pax = 2 + Math.floor(rnd() * 10);
    const pay = Math.round((pax * (260 + dest.d * 1.6) + 1500) * SIZE_MULT[from.size]);
    return {
      id: nextJobId(), type: 'charter', from: from.id, to: dest.h.id, pax, pay, distKm: Math.round(dest.d), needsCat: ['motor yacht', 'sailing yacht', 'passenger'],
      deadline: simTime + 3600 * hoursFor(dest.d, rnd) * 1.5, contraband: false,
      title: `Private charter: ${pax} guests to ${dest.h.name} (yacht or ferry)`,
    };
  }
  const good = LEGAL_GOODS[Math.floor(rnd() * LEGAL_GOODS.length)];
  const sizes = [120, 250, 400, 600, 900, 1100, 1800, 2500, 3600, 8000, 20000];
  const qty = sizes[Math.floor(rnd() * rnd() * sizes.length)];
  const pay = Math.round(qty * dest.d * PAY_PER_T_KM * (1 + 0.15 * rnd()) * SIZE_MULT[from.size] + 800);
  return {
    id: nextJobId(), type: 'freight', from: from.id, to: dest.h.id, good, qty, pay, distKm: Math.round(dest.d),
    deadline: simTime + 3600 * hoursFor(dest.d, rnd), contraband: false,
    title: `Freight ${qty} t of ${GOODS[good].name} to ${dest.h.name}`,
  };
}

export function generateSmugglingJob(from, simTime, rnd) {
  const dest = pickDestination(from, rnd);
  if (!dest) return null;
  const good = CONTRABAND[Math.floor(rnd() * CONTRABAND.length)];
  const qty = [40, 80, 150, 250, 400][Math.floor(rnd() * 5)];
  const pay = Math.round(qty * dest.d * PAY_PER_T_KM * SMUGGLE_MULT * (1 + 0.3 * rnd()) + 15000);
  return {
    id: nextJobId(), type: 'smuggling', from: from.id, to: dest.h.id, good, qty, pay, distKm: Math.round(dest.d),
    deadline: simTime + 3600 * hoursFor(dest.d, rnd), contraband: true,
    title: `Run ${qty} t of ${GOODS[good].name} to ${dest.h.name}. No questions.`,
  };
}

export function jobCountFor(harbor) { return SIZE_JOBS[harbor.size] || 3; }

export function initMarket(harbor, rnd) {
  const m = {};
  for (const [g, def] of Object.entries(GOODS)) {
    if (def.contraband) continue;
    m[g] = Math.round(def.base * (0.78 + rnd() * 0.44) * (harbor.fuelMul && g === 'fuel' ? harbor.fuelMul : 1));
  }
  return m;
}

export function driftMarket(market, rnd) {
  for (const g of Object.keys(market)) {
    if (!GOODS[g]) { delete market[g]; continue; }
    const base = GOODS[g].base;
    const target = base * (0.78 + rnd() * 0.44);
    market[g] = Math.round(market[g] + (target - market[g]) * 0.08);
  }
  for (const [g, def] of Object.entries(GOODS)) if (!def.contraband && market[g] == null) market[g] = Math.round(def.base * (0.78 + rnd() * 0.44));
}

// Used-ship listings: a few second-hand hulls per harbour, priced by condition; bigger ports see bigger ships.
let listingSeq = 1;
export function generateUsedShips(harbor, rnd) {
  const n = harbor.size === 'mega' ? 4 : harbor.size === 'major' ? 3 : harbor.size === 'minor' ? 1 : 2;
  const pool = Object.values(SHIP_CLASSES).filter((c) => c.price > 0 && (harbor.size === 'mega' || c.price < 5e6) && (harbor.size !== 'minor' || c.price < 1e6));
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = pool[Math.floor(rnd() * pool.length)];
    const cond = Math.round(35 + rnd() * 55);
    const price = Math.round(c.price * (0.4 + 0.45 * (cond / 100)) * (0.9 + rnd() * 0.2));
    out.push({ id: `u${(listingSeq++).toString(36)}${Math.floor(rnd() * 1e4).toString(36)}`, cls: c.id, cond, price, name: c.name });
  }
  return out;
}

export function shipValue(cls, cond) { return Math.round((SHIP_CLASSES[cls]?.price || 0) * 0.55 * (0.3 + 0.7 * (cond / 100))); }
export function repairCostFor(cls, cond) {
  const C = SHIP_CLASSES[cls] || SHIP_CLASSES.coaster;
  const basis = Math.max(120000, C.price); // the starter ship is maintained like a 120k hull
  return Math.round((100 - cond) / 100 * basis * 0.06 + (100 - cond) * 40);
}

export function cargoMass(cargo) { return cargo.reduce((s, c) => s + c.qty, 0); }
export function cargoValue(cargo, filter) {
  return cargo.filter(filter || (() => true)).reduce((s, c) => s + c.qty * GOODS[c.good].base, 0);
}
export function shipCapacity(cls) { return (SHIP_CLASSES[cls] || SHIP_CLASSES.coaster).capacity; }
