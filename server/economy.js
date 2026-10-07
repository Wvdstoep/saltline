// Jobs, black market and commodity markets. Pure functions over harbour/world data + a seeded RNG.
import { GOODS, SHIP_CLASSES } from '../shared/constants.js';
import { haversine } from '../shared/geo.js';
import { HARBORS, FISHING_GROUNDS } from './harbors.js';

export const PAY_PER_T_KM = 0.08;
export const SMUGGLE_MULT = 5;
export const LEGAL_GOODS = ['grain', 'steel', 'machinery', 'containers'];
export const CONTRABAND = ['cigarettes', 'weapons', 'narcotics', 'antiquities'];

let jobSeq = 1;
export function setJobSeq(n) { jobSeq = Math.max(jobSeq, n); }
export function nextJobId() { return `j${(jobSeq++).toString(36)}`; }

const SIZE_JOBS = { mega: 7, major: 5, regional: 4, minor: 3 };
const SIZE_MULT = { mega: 1.0, major: 1.0, regional: 1.05, minor: 1.15 };

export function distKm(a, b) { return haversine(a.lat, a.lon, b.lat, b.lon) / 1000; }

function pickDestination(from, rnd) {
  // Weight other harbours by a distance preference band (short hops common, long hauls rarer but present).
  const cands = [];
  for (const h of HARBORS) {
    if (h.id === from.id) continue;
    const d = distKm(from, h);
    let w = d < 60 ? 0.3 : d < 700 ? 1.0 : d < 2500 ? 0.25 : 0.06;
    if (h.size === 'mega') w *= 1.5; else if (h.size === 'minor') w *= 0.7;
    cands.push({ h, w, d });
  }
  let total = cands.reduce((s, c) => s + c.w, 0);
  let r = rnd() * total;
  for (const c of cands) { r -= c.w; if (r <= 0) return c; }
  return cands[cands.length - 1];
}

export function generateJob(from, simTime, rnd, forceType) {
  const roll = rnd();
  const type = forceType || (roll < 0.6 ? 'freight' : roll < 0.8 ? 'passengers' : 'fishing');
  if (type === 'fishing') {
    const grounds = FISHING_GROUNDS.map((g) => ({ g, d: distKm(from, g) })).filter((x) => x.d < 500).sort((a, b) => a.d - b.d);
    if (!grounds.length) return generateJob(from, simTime, rnd, 'freight');
    const g = grounds[Math.floor(rnd() * Math.min(3, grounds.length))].g;
    const qty = Math.round((20 + rnd() * 120) / 5) * 5;
    return {
      id: nextJobId(), type: 'fishing', from: from.id, to: from.id, ground: g.id, good: 'fish', qty,
      pay: Math.round(qty * 950 * SIZE_MULT[from.size]), deadline: simTime + 3600 * (18 + rnd() * 24), contraband: false,
      title: `Catch ${qty} t of fish on the ${g.name} and land it here`,
    };
  }
  const dest = pickDestination(from, rnd);
  if (type === 'passengers') {
    const pax = Math.round(4 + rnd() * rnd() * 396);
    const pay = Math.round(pax * (25 + dest.d * 0.35) * SIZE_MULT[from.size]);
    return {
      id: nextJobId(), type: 'passengers', from: from.id, to: dest.h.id, pax, pay, distKm: Math.round(dest.d),
      deadline: simTime + 3600 * Math.max(6, dest.d / 25 + 6 + rnd() * 6), contraband: false,
      title: `Ferry ${pax} passengers to ${dest.h.name}`,
    };
  }
  const good = LEGAL_GOODS[Math.floor(rnd() * LEGAL_GOODS.length)];
  const sizes = [120, 250, 400, 600, 900, 1100, 1800, 2500, 3600];
  const qty = sizes[Math.floor(rnd() * rnd() * sizes.length)];
  const pay = Math.round(qty * dest.d * PAY_PER_T_KM * (1 + 0.15 * rnd()) * SIZE_MULT[from.size] + 800);
  return {
    id: nextJobId(), type: 'freight', from: from.id, to: dest.h.id, good, qty, pay, distKm: Math.round(dest.d),
    deadline: simTime + 3600 * Math.max(12, dest.d / 15 + 12 + rnd() * 24), contraband: false,
    title: `Freight ${qty} t of ${GOODS[good].name} to ${dest.h.name}`,
  };
}

export function generateSmugglingJob(from, simTime, rnd) {
  const dest = pickDestination(from, rnd);
  const good = CONTRABAND[Math.floor(rnd() * CONTRABAND.length)];
  const qty = [40, 80, 150, 250, 400][Math.floor(rnd() * 5)];
  const pay = Math.round(qty * dest.d * PAY_PER_T_KM * SMUGGLE_MULT * (1 + 0.3 * rnd()) + 15000);
  return {
    id: nextJobId(), type: 'smuggling', from: from.id, to: dest.h.id, good, qty, pay, distKm: Math.round(dest.d),
    deadline: simTime + 3600 * Math.max(10, dest.d / 18 + 8 + rnd() * 10), contraband: true,
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
    const base = GOODS[g].base;
    const target = base * (0.78 + rnd() * 0.44);
    market[g] = Math.round(market[g] + (target - market[g]) * 0.08);
  }
}

export function cargoMass(cargo) { return cargo.reduce((s, c) => s + c.qty, 0); }
export function cargoValue(cargo, filter) {
  return cargo.filter(filter || (() => true)).reduce((s, c) => s + c.qty * GOODS[c.good].base, 0);
}
export function shipCapacity(cls) { return (SHIP_CLASSES[cls] || SHIP_CLASSES.coaster).capacity; }
