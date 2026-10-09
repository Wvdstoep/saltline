// Lane D's local copy of the lane A rules it consumes (docs/BRIDGES-LOCKS-VHF-CONTRACT.md §4.4 air draught, §4.10 CEMT,
// §9.5 frozen interfaces). Used ONLY while shared/airdraft.js / shared/waterworks.js are not merged: server/inlandlink.js
// prefers the real lane A modules and falls back to these. The numbers are the contract's, so swapping in lane A
// changes nothing the tests pin (test/inland-barges.test.mjs re-checks the §10.1 coaster examples here).
// Pure, plain ESM, browser-safe. Relative imports only.
import { modelOf, typeOf, rowOf } from './jobs/shipview.js';
import { BARGE_AD, BARGE_IDS } from './ships/barges.js';

export const AD_MARGIN = 0.30;
export const TEU_H = 2.59, LASHING = 0.1, TEU_T = 12;

/** CEMT classes (§4.10): max length, beam (b2 = the wide variant), draught; std = standard bridge clearance (lowest of the range). */
export const CEMT = Object.freeze({
  I: { L: 38.5, B: 5.05, T: 2.5, clr: 4.0, typical: 'spits' },
  II: { L: 55, B: 6.6, T: 2.5, clr: 4.0, typical: 'kempenaar' },
  III: { L: 80, B: 8.2, T: 2.5, clr: 4.0, typical: 'dortmunder' },
  IV: { L: 85, B: 9.5, T: 2.8, clr: 5.25, typical: 'Rhine–Herne' },
  Va: { L: 110, B: 11.4, T: 3.5, clr: 5.25, typical: 'large Rhine vessel' },
  Vb: { L: 185, B: 11.4, T: 4.0, clr: 5.25, typical: 'push convoy 2 long' },
  VIa: { L: 110, B: 22.8, T: 4.0, clr: 7.0, typical: '2 abreast' },
  VIb: { L: 195, B: 22.8, T: 4.0, clr: 7.0, typical: '4-barge push' },
  VIc: { L: 280, B: 22.8, b2: 34.2, T: 4.0, clr: 9.1, typical: '6-barge push' },
  VII: { L: 285, B: 34.2, T: 4.0, clr: 9.1, typical: '9-barge push' },
});
export const CEMT_ORDER = Object.freeze(['I', 'II', 'III', 'IV', 'Va', 'Vb', 'VIa', 'VIb', 'VIc', 'VII']);
/** Rank of a class (0 = I … 9 = VII); −1 when unknown. Accepts 'Va', 'va', 'V a', 5 (→ Va), 'VIb'. */
export function cemtRank(c) {
  if (c == null) return -1;
  if (typeof c === 'number') return c >= 0 && c <= 7 ? [-1, 0, 1, 2, 3, 4, 6, 9][c] : -1;
  const s = String(c).replace(/\s+/g, '').toUpperCase().replace(/^V([ABC])$/, 'V$1');
  const i = CEMT_ORDER.findIndex((k) => k.toUpperCase() === s);
  if (i >= 0) return i;
  if (s === 'V') return CEMT_ORDER.indexOf('Va');
  if (s === 'VI') return CEMT_ORDER.indexOf('VIa');
  if (s === '0') return -1;
  return -1;
}
/** Smallest class whose limits take a hull of L × B × T (null when it is bigger than VII). */
export function cemtOfDims(L, B, T) {
  for (const k of CEMT_ORDER) if (fitsCemt(k, L, B, T)) return k;
  return null;
}
/** Beam tolerance: the class beams are nominal (Va 11.4 m is built as 11.45 m). */
export const CEMT_BEAM_TOL = 0.05;
/** Does a hull fit a waterway of class `cls` (by its dimensions)? */
export function fitsCemt(cls, L, B, T) { const c = CEMT[cls]; return !!c && L <= c.L && B <= Math.max(c.B, c.b2 || 0) + CEMT_BEAM_TOL && T <= c.T; }

// §4.4 explicit rows (the catalogue file is not edited; these override its heuristic air draught).
const EXPLICIT = {
  coaster: { tLight: 2.4, tDesign: 5.5, kTop: 11.6, up: { wheelhouse: 7.4 }, hatchTop: 8.8, holdTeu: 36, deckSlots: 12, ballastMax: 600, pumpTph: 150 },
  shortsea88: { tLight: 2.5, tDesign: 5.6, kTop: 11.8, up: { wheelhouse: 7.0 }, hatchTop: 9.0, holdTeu: 120, deckSlots: 40, ballastMax: 'half' },
  sloop: { tLight: 1.9, tDesign: 1.9, kTop: 18.9, up: {}, ballastMax: 0 },
  ketch: { tLight: 2.3, tDesign: 2.3, kTop: 21.95, up: {}, ballastMax: 0 },
  catamaran: { tLight: 1.3, tDesign: 1.3, kTop: 24.3, up: {}, ballastMax: 0 },
  schooner: { tLight: 3.5, tDesign: 3.5, kTop: 37.5, up: {}, ballastMax: 0 },
  cruiser: { tLight: 1.1, tDesign: 1.1, kTop: 4.0, up: { arch: 0.7 }, ballastMax: 0 },
  flybridge18: { tLight: 1.5, tDesign: 1.5, kTop: 5.9, up: { arch: 1.2 }, ballastMax: 0 },
  myacht: { tLight: 1.8, tDesign: 1.8, kTop: 7.8, up: { mast: 1.5 }, ballastMax: 0 },
  tug: { tLight: 4.6, tDesign: 5.0, kTop: 20.0, up: {}, ballastMax: 0 },
  pilot: { tLight: 1.8, tDesign: 1.8, kTop: 7.8, up: {}, ballastMax: 0 },
};
const LIGHT = { bulk: 0.35, tanker: 0.38, gas: 0.45, container: 0.45, general: 0.45, roro: 0.7, ferry: 0.8, cruise: 0.85, offshore: 0.6, tug: 0.9, workboat: 0.75, pilot: 0.95, fishing: 0.75, special: 0.7, motor_yacht: 0.95, sail_yacht: 1.0 };
const BALLAST = { bulk: 0.45, tanker: 0.40, gas: 0.40, container: 0.35, general: 0.50, roro: 0.25, offshore: 0.30, ferry: 0.10, cruise: 0.10, fishing: 0.15, special: 0.20, workboat: 0.20 };
const r3 = (v) => Math.round(v * 1000) / 1000;
const baseId = (cls) => String(cls ?? '').split('~')[0];

/** Profile of a class (§4.4): explicit row, barge row, else derived from the catalogue. */
export function profileOf(cls) {
  const id = baseId(cls), m = modelOf(cls), row = rowOf(cls) || {};
  const capacity = Number(m?.capacity ?? row.capacity) || 0, fuelCap = Number(m?.fuelCap ?? row.fuelCap) || 0;
  const tDesign = Number(m?.draft ?? row.draft) || 2;
  let p = EXPLICIT[id] || BARGE_AD[id] || null;
  if (p) p = { ...p, up: { ...(p.up || {}) } };
  else {
    const type = typeOf(cls) || 'general';
    const ad = Number(m?.airDraft ?? m?.stats?.airDraft) || (row.length < 30 ? row.length * 0.3 + 2 : Math.min(75, 12 + (row.length || 50) * 0.17));
    const ballastMax = (type === 'fishing' && (row.length || 0) < 40) ? 0 : Math.round(capacity * (BALLAST[type] || 0));
    p = { tLight: r3(tDesign * (LIGHT[type] ?? 0.6)), tDesign, kTop: r3(tDesign + ad), up: {}, ballastMax, pumpTph: ballastMax > 0 ? Math.max(150, 0.25 * ballastMax) : 0, derived: true };
  }
  if (p.ballastMax === 'half') p.ballastMax = Math.round(0.5 * capacity);
  p.capacity = capacity; p.fuelCap = fuelCap;
  p.stores = Math.round(0.02 * (capacity + fuelCap));
  p.dwMax = capacity + fuelCap + p.stores;
  p.hatchTop = p.hatchTop ?? null; p.deckSlots = p.deckSlots ?? 0; p.holdTeu = p.holdTeu ?? 0;
  p.pumpTph = p.pumpTph ?? (p.ballastMax > 0 ? Math.max(150, 0.25 * p.ballastMax) : 0);
  p.antenna = 0.8;
  p.barge = BARGE_IDS.includes(id);
  return p;
}
/** Draught (m) for a load state: cargoT, fuelT (default full), ballastT. */
export function draughtNow(cls, { cargoT = 0, fuelT = null, ballastT = 0 } = {}) {
  const p = profileOf(cls);
  const fuel = fuelT == null ? p.fuelCap : fuelT;
  const dw = Math.max(0, cargoT) + Math.max(0, ballastT) + Math.max(0, fuel) + p.stores;
  const f = p.dwMax > 0 ? Math.max(0, Math.min(1, dw / p.dwMax)) : 1;
  return r3(p.tLight + (p.tDesign - p.tLight) * f);
}
/** Container tiers on deck for `containersT` tonnes of boxes (12 t per TEU; the hold fills first). */
export function deckTiers(cls, containersT) {
  const p = profileOf(cls);
  if (!(p.deckSlots > 0) || !(containersT > 0)) return 0;
  const teu = Math.ceil(containersT / TEU_T);
  return Math.ceil(Math.max(0, teu - p.holdTeu) / p.deckSlots);
}
/** Is part `k` raised? fold = { wheelhouse: 0|1, mast, arch } with 1 = folded down (save default: all up). */
const raised = (fold, k) => !(fold && (fold[k] === 1 || fold[k] === true));
/**
 * Air draught now (§4.4): { ad, T, kTop, deckTiers, stackTop, need(Hs) }.
 * cargo: [{ good, qty }] (qty in t) or a number of tonnes; containers are the `containers`/`reefer_box`/`dg_box` goods.
 */
export function airDraftNow(cls, { cargo = [], fuelT = null, ballastT = 0, fold = null } = {}) {
  const p = profileOf(cls);
  const list = typeof cargo === 'number' ? [{ good: 'grain', qty: cargo }] : (cargo || []);
  const cargoT = list.reduce((s, c) => s + (Number(c.qty) || 0), 0);
  const boxT = list.filter((c) => /containers|_box$/.test(String(c.good))).reduce((s, c) => s + (Number(c.qty) || 0), 0);
  const T = draughtNow(cls, { cargoT, fuelT, ballastT });
  let top = p.kTop;
  for (const [k, v] of Object.entries(p.up || {})) if (raised(fold, k)) top = Math.max(top, p.kTop + v);
  const tiers = p.hatchTop != null ? deckTiers(cls, boxT) : 0;
  const stackTop = tiers > 0 ? r3(p.hatchTop + tiers * TEU_H + LASHING) : null;
  if (stackTop != null) top = Math.max(top, stackTop);
  const ad = r3(top - T);
  return { ad, T, kTop: p.kTop, deckTiers: tiers, stackTop, need: (Hs = 0) => r3(ad + AD_MARGIN + 0.5 * Math.max(0, Hs || 0)) };
}
/** May the folding parts go down with this stack? (§4.4: not while the stack top is > 1.0 m above the lowered eye, kTop − 1.5). */
export function foldAllowed(cls, stackTop) { const p = profileOf(cls); return stackTop == null || stackTop <= p.kTop - 1.5 + 1.0; }
/**
 * The lowest air draught the ship can reach with a given cargo (route planning for a contract): everything that folds
 * folded (when the stack allows it) and ballast filled up to DWmax. → { ad, need, T, ballastT, fold, deckTiers }.
 */
export function bestAirDraft(cls, { cargo = [], fuelT = null } = {}) {
  const p = profileOf(cls);
  const list = typeof cargo === 'number' ? [{ good: 'grain', qty: cargo }] : (cargo || []);
  const cargoT = list.reduce((s, c) => s + (Number(c.qty) || 0), 0);
  const fuel = fuelT == null ? p.fuelCap : fuelT;
  const room = Math.max(0, p.dwMax - cargoT - fuel - p.stores);
  const ballastT = Math.min(p.ballastMax || 0, room);
  const probe = airDraftNow(cls, { cargo: list, fuelT: fuel, ballastT, fold: null });
  const canFold = foldAllowed(cls, probe.stackTop);
  const fold = canFold ? Object.fromEntries(Object.keys(p.up || {}).map((k) => [k, 1])) : null;
  const a = airDraftNow(cls, { cargo: list, fuelT: fuel, ballastT, fold });
  return { ad: a.ad, need: a.need(0), T: a.T, ballastT, fold: fold || {}, deckTiers: a.deckTiers, stackTop: a.stackTop };
}

/** §4.5 verdict for one span, reduced to what lane D needs (fixed / movable, closed / open clearance at the datum, h = water). */
export function passVerdictLite(need, { clr, clrO = null, w = null }, { beam = 0, h = 0 } = {}) {
  const now = clr - h, open = clrO == null ? null : (clrO === Infinity ? Infinity : clrO - h);
  if (Number.isFinite(w) && beam + 1.0 > w) return { verdict: 'never', need, clrNow: now, clrOpenNow: open, why: 'too wide' };
  if (need <= now) return { verdict: need > now - 1.0 ? 'tight' : 'under', need, clrNow: now, clrOpenNow: open, why: null };
  if (open != null && need <= open) return { verdict: 'opening', need, clrNow: now, clrOpenNow: open, why: null };
  return { verdict: 'never', need, clrNow: now, clrOpenNow: open, why: 'too high' };
}
