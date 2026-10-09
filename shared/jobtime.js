// Feasible contracts (V6-PLAN item 5, docs/V6-QUICK-CONTRACTS.md §5.4): how long a contract needs with a given ship,
// the time budget a generated contract gets (rated for a reference ship, with margin), why a ship can never take it,
// and the "with your ship: ~24 h fishing (≈ 1 h 12 m at 20×)" estimate on every contract card.
// Plain ESM, browser-safe (served at /shared), no DOM, no state.
import { SHIP_CLASSES } from './constants.js';
import { RATES, serviceKn, catchRate, kmHours, shipClass } from './rates.js';
// YARD lane D (H6c): JOB_GEN 8 checks and hours come from shared/jobs/eligibility.js jobtimeHooks(), registered at start-up
// by the server (server/game.js) and the client (main.js), so this module keeps no import cycle with the jobs modules.
let gen8 = null;
export function setGen8(hooks) { gen8 = hooks || null; }

export const JOBTIME = {
  MARGIN_MIN: 1.4, MARGIN_MAX: 1.8,     // budget = need(reference ship) × margin + fixed hours
  FIXED_H: { freight: 4, passengers: 3, charter: 3, supply: 3, tow: 4, smuggling: 4, fishing: 2 },
  PORT_H: 1,                             // casting off + coming alongside in every harbour-to-harbour need
  CRANE_H: 0.5, TOWLINE_H: 0.5,
  MIN_HOURS: 4, BOARD_TTL_H: 24,
  SHOW_WARP: 20,                         // the card's "(≈ … at 20×)" — WARP.MAX_NO_ROUTE, the highest level without a route
  FISH_REF: [['trawler', 0.55], ['coaster', 0.45]],
};

const fmtN = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—');
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : NaN);

/** The reference ship a generated contract's time budget is rated for. */
export function refClassFor(job, rnd = Math.random) {
  switch (job && job.type) {
    case 'fishing': {
      let r = rnd(), acc = 0;
      for (const [cls, w] of JOBTIME.FISH_REF) { acc += w; if (r < acc) return cls; }
      return JOBTIME.FISH_REF[JOBTIME.FISH_REF.length - 1][0];
    }
    case 'freight': case 'smuggling': { const q = num(job.qty) || 0; return q <= SHIP_CLASSES.coaster.capacity ? 'coaster' : q <= SHIP_CLASSES.feeder.capacity ? 'feeder' : 'bulker'; }
    case 'passengers': return (num(job.pax) || 0) <= SHIP_CLASSES.coaster.pax ? 'coaster' : 'ferry';
    case 'charter': return 'sloop';
    case 'supply': return 'psv';
    case 'tow': return 'tug';
    default: return 'coaster';
  }
}

/** Sea km of a harbour-to-harbour leg: the planned distance, else the great circle × DETOUR. */
function seaKmOf(job) { const s = num(job.seaKm); if (s >= 0) return s; const d = num(job.distKm); return d >= 0 ? d * RATES.DETOUR : 0; }

/** Hours a ship of class `cls` needs for `job`: { type, workH (fishing / crane / tow line), sailH, needH }. */
export function needFor(job, cls) {
  if (gen8) { const n = gen8.needFor(job, cls); if (n) return n; }
  const C = shipClass(cls), type = job && job.type;
  let workH = 0, sailH = 0, needH;
  if (type === 'fishing') {
    const rich = Number.isFinite(num(job.richness)) ? num(job.richness) : 1;
    const rate = catchRate(C.id, rich);
    const qty = num(job.qty) || 0;
    workH = rate > 0 ? qty / rate : Infinity;
    const g = num(job.groundKm);
    sailH = g > 0 ? (2 * g) / (serviceKn(C.id, (0.5 * qty) / C.capacity) * RATES.KMH_PER_KN) : 0;
    needH = workH + sailH;
  } else if (type === 'freight' || type === 'smuggling') {
    sailH = kmHours(seaKmOf(job), serviceKn(C.id, (num(job.qty) || 0) / C.capacity));
    needH = sailH + JOBTIME.PORT_H;
  } else if (type === 'passengers' || type === 'charter') {
    sailH = kmHours(seaKmOf(job), serviceKn(C.id, 0));
    needH = sailH + JOBTIME.PORT_H;
  } else if (type === 'supply') {
    workH = JOBTIME.CRANE_H;
    const p = num(job.platformKm);
    sailH = p >= 0 ? 2 * kmHours(p, serviceKn(C.id, 0.5)) : kmHours((num(job.distKm) || 0) * RATES.DETOUR, serviceKn(C.id, 0.5));
    needH = workH + sailH;
  } else if (type === 'tow') {
    workH = JOBTIME.TOWLINE_H;
    const t = job.towKm;
    if (t && num(t.toCasualty) >= 0 && num(t.toDest) >= 0) sailH = kmHours(num(t.toCasualty), serviceKn(C.id)) + kmHours(num(t.toDest), serviceKn(C.id) * (C.towPower ? 0.95 : 0.65));
    else sailH = kmHours((num(job.distKm) || 0) * RATES.DETOUR, serviceKn(C.id));
    needH = workH + sailH;
  } else {
    sailH = kmHours(seaKmOf(job || {}), serviceKn(C.id, 0));
    needH = sailH + JOBTIME.PORT_H;
  }
  return { type, workH, sailH, needH };
}

/** The ship-hour budget for `job` rated for class `cls` with `margin` (integer ≥ MIN_HOURS). */
export function budgetFor(job, cls, margin) {
  const need = needFor(job, cls).needH;
  const fixed = JOBTIME.FIXED_H[job.type] ?? 3;
  if (!Number.isFinite(need)) return JOBTIME.MIN_HOURS;
  return Math.max(JOBTIME.MIN_HOURS, Math.ceil(need * margin + fixed));
}

/** Why `ship` ({ cls, holdFreeT, paxFree }) can never take `job`, or null. Same texts as the harbour sheet always showed. */
export function hardReason(job, ship) {
  if (gen8) { const r = gen8.hardReason(job, ship); if (r !== undefined) return r; }
  const C = shipClass(ship && ship.cls);
  if (job.needsCat && !job.needsCat.includes(C.cat)) return `needs ${job.needsCat.includes('passenger') ? 'a yacht or ferry' : 'a yacht'}`;
  if (job.type === 'passengers' || job.type === 'charter') {
    const free = Number.isFinite(ship.paxFree) || ship.paxFree === Infinity ? ship.paxFree : C.pax;
    if ((job.pax || 0) > free) return `needs ${job.pax} berths (${Math.max(0, free)} free)`;
    return null;
  }
  if (job.type === 'fishing') {
    if (!(C.fishRate > 0)) return 'this hull cannot fish';
    if (job.qty > C.capacity) return `hold too small for ${job.qty} t`;
    return null;
  }
  if (job.type === 'tow') return null;
  const free = Number.isFinite(ship.holdFreeT) || ship.holdFreeT === Infinity ? ship.holdFreeT : C.capacity;
  if (job.qty && job.qty > free) return `needs ${fmtN(job.qty)} t of hold (${fmtN(Math.max(0, free))} t free)`;
  return null;
}

/** '30 min', '3.5 h', '4 h', '24 h'. */
export function fmtShipH(h) {
  if (!Number.isFinite(h)) return '—';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 10) { const s = h.toFixed(1); return `${s.endsWith('.0') ? s.slice(0, -2) : s} h`; }
  return `${Math.round(h)} h`;
}
/** The number of hours fmtShipH(h) shows (so the real-time figure adds up with what the card reads). */
export function dispH(h) {
  if (!Number.isFinite(h)) return h;
  if (h < 1) return Math.max(1, Math.round(h * 60)) / 60;
  if (h < 10) return Number(h.toFixed(1));
  return Math.round(h);
}
/** Real time: '33 m', '1 h 12 m'. */
export function fmtRealHM(h) {
  if (!Number.isFinite(h)) return '—';
  const m = Math.round(h * 60);
  return m < 60 ? `${m} m` : `${Math.floor(m / 60)} h ${m % 60} m`;
}
/** 'with your ship: ~24 h fishing + 2 h sailing (≈ 1 h 18 m at 20×)'; '' when the need is unknown or infinite. */
export function jobLabel(need, warp = JOBTIME.SHOW_WARP) {
  if (!need || !Number.isFinite(need.needH)) return '';
  const w = warp > 0 ? warp : 1;
  if (need.type === 'fishing') {
    const sail = need.sailH >= 0.5;
    return `with your ship: ~${fmtShipH(need.workH)} fishing${sail ? ` + ${fmtShipH(need.sailH)} sailing` : ''} (≈ ${fmtRealHM((dispH(need.workH) + (sail ? dispH(need.sailH) : 0)) / w)} at ${w}×)`;
  }
  return `with your ship: ~${fmtShipH(need.needH)} ${need.type === 'tow' ? 'towing' : 'sailing'} (≈ ${fmtRealHM(dispH(need.needH) / w)} at ${w}×)`;
}
const fmtBudget = (h) => (Number.isInteger(h) ? String(h) : h >= 10 ? String(Math.round(h)) : String(Math.max(0, Math.round(h * 10) / 10)));

/**
 * The card estimate for `job` with `ship` = { cls, holdFreeT, paxFree, budgetH? (default job.hours), warp? (SHOW_WARP) }:
 * { ok, hard, why, workH, sailH, needH, budgetH, slackH, warp, label }.
 */
export function estimateJob(job, ship = {}) {
  const cls = shipClass(ship.cls).id;
  const hard = hardReason(job, { ...ship, cls });
  const need = needFor(job, cls);
  const budgetH = Number.isFinite(ship.budgetH) ? ship.budgetH : Number.isFinite(num(job.hours)) ? num(job.hours) : Infinity;
  const warp = ship.warp > 0 ? ship.warp : JOBTIME.SHOW_WARP;
  const ok = !hard && need.needH <= budgetH;
  const why = hard || (!ok ? `too slow for your ship: needs ~${fmtShipH(need.needH)}, the contract allows ${fmtBudget(budgetH)} h` : null);
  return { ok, hard, why, workH: need.workH, sailH: need.sailH, needH: need.needH, budgetH, slackH: budgetH - need.needH, warp, label: jobLabel(need, warp) };
}
