// Air draught model (docs/BRIDGES-LOCKS-VHF-CONTRACT.md §4.4). Pure, browser-safe, deterministic.
// Air draught = height of the ship's highest point above the water = kTop(state) − T(load).
// The ship catalogue is NOT edited: explicit rows below override it, every other model gets a derived profile that keeps
// the catalogue's airDraft stat meaningful (= air draught at summer draught, masts up).
//
// Fold state: `fold = { wheelhouse, mast, arch }`, a truthy value means LOWERED / folded; missing = raised (the save default).
import { MODELS } from './ships/catalogue.js';
import { parseVariant } from './ships/options.js';
import { classRow } from './ships/rows.js';
import { rigOf } from './sail/rigs.js';

export const AD_MARGIN = 0.30;                 // schrikhoogte (m)
export const TEU_T = 12;                       // game rule: t per loaded TEU
export const TIER_H = 2.59;                    // 8'6" box
export const LASHING = 0.1;
export const ANTENNA = 0.8;
export const FOLD_TIME = { wheelhouse: 120, mast: 60, arch: 60 };   // s, hydraulic
export const FOLD_MAX_KN = 8;
export const BOX_GOODS = new Set(['containers', 'reefer_box', 'dg_box']);

export const LIGHT = { bulk: 0.35, tanker: 0.38, gas: 0.45, container: 0.45, general: 0.45, roro: 0.7, ferry: 0.8, cruise: 0.85, offshore: 0.6, tug: 0.9,
  workboat: 0.75, pilot: 0.95, fishing: 0.75, special: 0.7, motor_yacht: 0.95, sail_yacht: 1.0 };
export const BALLAST = { bulk: 0.45, tanker: 0.40, gas: 0.40, container: 0.35, general: 0.50, roro: 0.25, offshore: 0.30, ferry: 0.10, cruise: 0.10, fishing: 0.15,
  special: 0.20, workboat: 0.20 };

/** Explicit rows (§4.4 table). kTop = keel → highest fixed point in the LOWERED state. */
export const AD_ROWS = {
  coaster: { tLight: 2.4, tDesign: 5.5, kTop: 11.6, up: { wheelhouse: 7.4 }, hatchTop: 8.8, holdTeu: 36, deckSlots: 12, ballastMax: 600, pumpTph: 150 },
  shortsea88: { tLight: 2.5, tDesign: 5.6, kTop: 11.8, up: { wheelhouse: 7.0 }, hatchTop: 9.0, holdTeu: 120, deckSlots: 40, ballastFrac: 0.5 },
  sloop: { tLight: 1.9, tDesign: 1.9, rig: true },
  ketch: { tLight: 2.3, tDesign: 2.3, rig: true },
  catamaran: { tLight: 1.3, tDesign: 1.3, rig: true },
  schooner: { tLight: 3.5, tDesign: 3.5, rig: true },
  cruiser: { tLight: 1.1, tDesign: 1.1, kTop: 4.0, up: { arch: 0.7 } },
  flybridge18: { tLight: 1.5, tDesign: 1.5, kTop: 5.9, up: { arch: 1.2 } },
  myacht: { tLight: 1.8, tDesign: 1.8, kTop: 7.8, up: { mast: 1.5 } },
  tug: { tLight: 4.6, tDesign: 5.0, kTop: 20.0, up: {} },
  pilot: { tLight: 1.8, tDesign: 1.8, kTop: 7.8, up: {} },
};
const rows = new Map();
/** Register extra explicit rows (e.g. shared/ships/barges.js, §7.6) without editing this file. */
export function registerProfiles(map) { for (const [k, v] of Object.entries(map || {})) { AD_ROWS[k] = v; rows.clear(); } }

const r3 = (v) => Math.round(v * 1000) / 1000;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
function modelFor(cls) { const pv = parseVariant(cls); return pv ? MODELS[pv.model] : MODELS[cls] || null; }
function rigTop(id) {
  const rig = rigOf(id); if (!rig) return null;
  let top = 0; for (const m of rig.spars.masts) top = Math.max(top, m.topmast ?? m.top);
  return top;
}

/** Profile of a class / model / variant id. Unknown ids read as the coaster. */
export function profileOf(cls) {
  if (rows.has(cls)) return rows.get(cls);
  const m = modelFor(cls) || MODELS.coaster;
  const row = classRow(cls) || classRow(m.id) || {};
  const capacity = row.capacity ?? m.capacity ?? 0, fuelCap = row.fuelCap ?? m.fuelCap ?? 0;
  const stores = Math.round(0.02 * (capacity + fuelCap));
  const type = m.type;
  const x = AD_ROWS[m.id];
  const tDesign = x?.tDesign ?? m.draft;
  let p;
  if (x && x.rig) {
    const top = rigTop(m.id) ?? 0;
    p = { tLight: x.tLight, tDesign, kTop: r3(tDesign + top + ANTENNA), up: {}, hatchTop: null, deckSlots: 0, holdTeu: 0, ballastMax: 0, pumpTph: 0, sail: true };
  } else if (x) {
    const ballastMax = x.ballastMax ?? (x.ballastFrac ? Math.round(x.ballastFrac * capacity) : 0);
    p = { tLight: x.tLight, tDesign, kTop: x.kTop, up: { ...(x.up || {}) }, hatchTop: x.hatchTop ?? null, deckSlots: x.deckSlots || 0, holdTeu: x.holdTeu || 0,
      ballastMax, pumpTph: x.pumpTph ?? (ballastMax > 0 ? Math.max(150, 0.25 * ballastMax) : 0), sail: false };
  } else if (type === 'sail_yacht' && rigTop(m.id) != null) {
    p = { tLight: tDesign, tDesign, kTop: r3(tDesign + rigTop(m.id) + ANTENNA), up: {}, hatchTop: null, deckSlots: 0, holdTeu: 0, ballastMax: 0, pumpTph: 0, sail: true };
  } else {
    const fr = BALLAST[type] ?? 0;
    const ballastMax = type === 'fishing' && m.length < 40 ? 0 : Math.round(capacity * fr);
    p = { tLight: r3(tDesign * (LIGHT[type] ?? 0.6)), tDesign, kTop: r3(tDesign + (m.airDraft ?? m.stats?.airDraft ?? 10)), up: {}, hatchTop: null, deckSlots: 0, holdTeu: 0,
      ballastMax, pumpTph: ballastMax > 0 ? Math.max(150, 0.25 * ballastMax) : 0, sail: type === 'sail_yacht' };
  }
  Object.assign(p, { id: m.id, type, capacity, fuelCap, stores, DWmax: capacity + fuelCap + stores, antenna: ANTENNA, length: m.length, beam: m.beam });
  rows.set(cls, Object.freeze(p));
  return p;
}

/** Cargo tonnes and container tonnes from a number (t), a {good: t} map or a [{good, qty}] list. */
export function cargoSplit(cargo) {
  let t = 0, box = 0;
  if (Number.isFinite(cargo)) return { t: cargo, box: 0 };
  if (Array.isArray(cargo)) for (const c of cargo) { const q = Number(c && (c.qty ?? c.t)) || 0; t += q; if (BOX_GOODS.has(c.good)) box += q; }
  else if (cargo && typeof cargo === 'object') for (const [g, q0] of Object.entries(cargo)) { const q = Number(q0) || 0; t += q; if (BOX_GOODS.has(g)) box += q; }
  return { t, box };
}

/** Live draught T (m). fuelT defaults to a full tank. */
export function draughtNow(cls, { cargoT = 0, fuelT, ballastT = 0 } = {}) {
  const p = profileOf(cls);
  const fuel = Number.isFinite(fuelT) ? fuelT : p.fuelCap;
  const DW = (Number(cargoT) || 0) + (Number(ballastT) || 0) + fuel + p.stores;
  return p.tLight + (p.tDesign - p.tLight) * clamp(DW / (p.DWmax || 1), 0, 1);
}

/** Container tiers on deck for `containersT` tonnes of boxes (hold fills first). */
export function deckTiers(cls, containersT) {
  const p = profileOf(cls);
  if (!p.deckSlots || !(containersT > 0)) return 0;
  const teu = Math.ceil(containersT / TEU_T - 1e-9);
  return Math.ceil(Math.max(0, teu - p.holdTeu) / p.deckSlots);
}
export function stackTop(p, tiers) { return tiers > 0 && p.hatchTop != null ? p.hatchTop + tiers * TIER_H + LASHING : 0; }
/** Raised parts add on top of the lowered kTop: kTopUp = kTop + max(raised parts). */
export function kTopRaised(p, fold = {}) {
  let add = 0;
  for (const [part, h] of Object.entries(p.up || {})) if (!(fold && fold[part])) add = Math.max(add, h);
  return p.kTop + add;
}

/** → { ad, T, kTop, deckTiers, stackTop, need(Hs) }. cargo: number | {good: t} | [{good, qty}]. */
export function airDraftNow(cls, { cargo = 0, fuelT, ballastT = 0, fold = {} } = {}) {
  const p = profileOf(cls);
  const { t, box } = cargoSplit(cargo);
  const T = draughtNow(cls, { cargoT: t, fuelT, ballastT });
  const tiers = deckTiers(cls, box);
  const st = stackTop(p, tiers);
  const kTop = Math.max(kTopRaised(p, fold), st);
  const ad = kTop - T;
  return { ad: r3(ad), T: r3(T), kTop: r3(kTop), deckTiers: tiers, stackTop: r3(st), need: (Hs = 0) => r3(ad + AD_MARGIN + 0.5 * Math.max(0, Hs || 0)) };
}

/** Max ballast so DW ≤ DWmax. */
export function ballastCap(cls, { cargoT = 0, fuelT } = {}) {
  const p = profileOf(cls);
  const fuel = Number.isFinite(fuelT) ? fuelT : p.fuelCap;
  return Math.max(0, Math.min(p.ballastMax, p.DWmax - p.stores - fuel - (Number(cargoT) || 0)));
}
/** Pump ballast toward `target` for dtSim seconds of ship time (time warp is already in dtSim). → new ballast t. */
export function ballastStep(cls, ballastT, target, dtSim, load = {}) {
  const p = profileOf(cls);
  if (!(p.ballastMax > 0)) return 0;
  const goal = clamp(Number(target) || 0, 0, ballastCap(cls, load));
  const step = (p.pumpTph / 3600) * Math.max(0, dtSim);
  const b = Number(ballastT) || 0;
  return goal > b ? Math.min(goal, b + step) : Math.max(goal, b - step);
}
/** Seconds to pump from `from` to `to` t. */
export function ballastTime(cls, from, to) { const p = profileOf(cls); return p.pumpTph > 0 ? (Math.abs(to - from) / p.pumpTph) * 3600 : Infinity; }

/** May this part be lowered / raised now? → { ok, why?, time } */
export function canFold(cls, part, down, { cargo = 0, sogKn = 0 } = {}) {
  const p = profileOf(cls);
  if (p.sail && part === 'mast') return { ok: false, why: 'A sailing mast cannot be lowered underway (unstepping is a yard service).' };
  if (!p.up || !(part in p.up)) return { ok: false, why: 'This ship has nothing to fold.' };
  if (sogKn > FOLD_MAX_KN) return { ok: false, why: `Slow down below ${FOLD_MAX_KN} kn to fold.` };
  if (down && part === 'wheelhouse') {
    const st = stackTop(p, deckTiers(cls, cargoSplit(cargo).box));
    if (st > p.kTop - 1.5 + 1.0) return { ok: false, why: 'Raise the wheelhouse to see over the containers.' };
  }
  return { ok: true, time: FOLD_TIME[part] || 60 };
}

/** The `you.air` wire block (§4.4). */
export function airPublic(cls, state = {}, Hs = 0) {
  const a = airDraftNow(cls, state), p = profileOf(cls);
  return { ad: a.ad, T: a.T, kTop: a.kTop, ballastT: Math.round(state.ballastT || 0), ballastTarget: state.ballastTarget ?? null, ballastMax: p.ballastMax,
    fold: { ...(state.fold || {}) }, foldable: Object.keys(p.up || {}), deckTiers: a.deckTiers, need: a.need(Hs) };
}
