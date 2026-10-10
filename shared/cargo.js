// Cargo taxonomy (docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §5.1–§5.3, §5.10): every good gets a handling class and a
// unit, every hull the handling it offers (model fields `handling`, `units`, `eq`, read through shared/jobs/shipview.js).
// Pure and deterministic; plain ESM, browser-safe.
import { modelOf, rowOf, splitVariant } from './jobs/shipview.js';
import { CATALOGUE } from './econ/catalogue.js';   // world economy §9.1: every catalogue good is a market cargo

/** Handling classes a hull can offer, with the words the "why not" chips use. */
export const HANDLING = {
  box: 'container cells', bulk: 'bulk holds', breakbulk: 'general-cargo holds', heavy: 'heavy-lift cranes',
  'liquid:clean': 'coated product tanks', 'liquid:crude': 'crude tanks', 'liquid:chem': 'chemical tanks',
  'gas:lpg': 'LPG tanks', 'gas:lng': 'LNG tanks', roro: 'a ro-ro vehicle deck', reefer: 'refrigerated holds',
  livestock: 'livestock pens', fish: 'a fish hold', deck: 'an offshore cargo deck', hopper: 'a dredging hopper', pax: 'passenger berths',
};
/** Ships to suggest for a handling (the §5.8 "e.g." list; size names from §2.1). */
export const SUGGEST = {
  box: ['Feeder', 'Panamax', 'Neo-Panamax'], bulk: ['Handysize', 'Ultramax', 'Capesize'], breakbulk: ['Coaster', 'General cargo', 'MPP'],
  heavy: ['MPP heavy-lift'], 'liquid:clean': ['MR', 'LR1', 'Product tanker'], 'liquid:crude': ['Aframax', 'Suezmax', 'VLCC'],
  'liquid:chem': ['Chemical tanker', 'MR'], 'gas:lpg': ['LPG carrier', 'VLGC'], 'gas:lng': ['LNG carrier', 'LNG bunker vessel'],
  roro: ['PCTC', 'Ro-ro', 'Ro-pax'], reefer: ['Reefer ship'], livestock: ['Livestock carrier'], fish: ['Trawler', 'Seiner'],
  deck: ['PSV', 'AHTS'], hopper: ['Hopper dredger'], pax: ['Ferry', 'Yacht'],
};
/** Units: label (singular, plural) and the free-capacity key in `unitsOf`. */
export const UNITS = {
  t: { label: 't', plural: 't' }, teu: { label: 'TEU', plural: 'TEU' }, ceu: { label: 'CEU', plural: 'CEU' },
  lm: { label: 'lane m', plural: 'lane m' }, m3: { label: 'm³', plural: 'm³' }, head: { label: 'head', plural: 'head' },
  pax: { label: 'passenger', plural: 'passengers' }, plugs: { label: 'reefer plug', plural: 'reefer plugs' },
};

// §5.1. `opts` = alternative ways to carry it: { h: handling, plugs?: true (one reefer plug per unit), dg?: true }.
// tPer = tonnes per unit (Game rule). market = trades on harbour markets today; fallback = good used by market/politics.
const G = (name, opts, unit, tPer, extra = {}) => ({ name, opts, unit, tPer, market: false, fallback: null, ...extra });
export const CARGO = {
  containers: G('Containers', [{ h: 'box' }], 'teu', 12, { market: true }),
  reefer_box: G('Reefer containers', [{ h: 'box', plugs: true }], 'teu', 14, { fallback: 'containers' }),
  dg_box: G('Dangerous-goods containers', [{ h: 'box', dg: true }], 'teu', 12, { fallback: 'containers' }),
  grain: G('Grain', [{ h: 'bulk' }], 't', 1, { market: true }),
  ore: G('Iron ore', [{ h: 'bulk' }], 't', 1, { fallback: 'steel', dense: true }),
  coal: G('Coal', [{ h: 'bulk' }], 't', 1, { fallback: 'fuel' }),
  steel: G('Steel coils', [{ h: 'breakbulk' }, { h: 'bulk' }], 't', 1, { market: true }),
  machinery: G('Machinery', [{ h: 'breakbulk' }, { h: 'box' }], 't', 1, { market: true }),
  project: G('Project cargo', [{ h: 'heavy' }], 't', 1, { fallback: 'machinery' }),
  crude: G('Crude oil', [{ h: 'liquid:crude' }], 't', 1, { fallback: 'fuel' }),
  fuel: G('Refined products', [{ h: 'liquid:clean' }], 't', 1, { market: true }),
  chemicals: G('Chemicals', [{ h: 'liquid:chem' }], 't', 1, { fallback: 'fuel' }),
  lpg: G('LPG', [{ h: 'gas:lpg' }], 'm3', 0.55, { fallback: 'fuel' }),
  lng: G('LNG', [{ h: 'gas:lng' }], 'm3', 0.45, { fallback: 'fuel' }),
  vehicles: G('New cars', [{ h: 'roro' }], 'ceu', 1.5, { fallback: 'machinery' }),
  trailers: G('Trucks and trailers', [{ h: 'roro' }], 'lm', 2.2, { fallback: 'machinery' }),
  livestock: G('Livestock', [{ h: 'livestock' }], 'head', 0.5, { fallback: 'grain' }),
  fruit: G('Fruit and chilled food', [{ h: 'reefer' }, { h: 'box', plugs: true }], 't', 1, { fallback: 'grain' }),
  fish: G('Fish', [{ h: 'fish' }, { h: 'reefer' }, { h: 'breakbulk' }], 't', 1, { market: true }),   // §5.10 adds breakbulk
  supplies: G('Offshore supplies', [{ h: 'deck' }, { h: 'breakbulk' }], 't', 1, { market: true }),
  spoil: G('Dredged material', [{ h: 'hopper' }], 'm3', 1.6),
  cigarettes: G('Untaxed cigarettes', [{ h: 'box' }, { h: 'breakbulk' }], 't', 1, { contraband: true }),
  weapons: G('Crated weapons', [{ h: 'box' }, { h: 'breakbulk' }], 't', 1, { contraband: true }),
  narcotics: G('Narcotics', [{ h: 'box' }, { h: 'breakbulk' }], 't', 1, { contraband: true }),
  antiquities: G('Looted antiquities', [{ h: 'box' }, { h: 'breakbulk' }], 't', 1, { contraband: true }),
};

// World economy §9.1 (docs/WORLD-ECONOMY-CONTRACT.md): a row for every catalogue good, `market: true` on all 80; the
// job-only goods (reefer_box, dg_box, fruit, spoil) keep a fallback; fruit now falls back to bananas.
for (const r of CATALOGUE) {
  if (CARGO[r.id]) { CARGO[r.id].market = true; CARGO[r.id].fallback = null; continue; }
  CARGO[r.id] = G(r.name, r.opts.map((o) => ({ ...o })), r.unit, r.tPer, { market: true, ...(r.id === 'ore' ? { dense: true } : {}) });
}
CARGO.fruit.fallback = 'bananas';

const n0 = (v) => (Number.isFinite(v) ? v : 0);

/** Equipment tokens of a class/variant: the model's `eq` plus 'geared' when she has her own cranes (option-aware). */
export function eqOf(cls) {
  const m = modelOf(cls); if (!m) return [];
  const { tokens } = splitVariant(cls);
  const eq = new Set(m.eq || []);
  for (const e of m.eq || []) { const i = e.indexOf(':'); if (i > 0) eq.add(e.slice(0, i)); }   // 'hoseCranes:1' also counts as 'hoseCranes'
  let geared = (m.tags || []).includes('geared') || m.defaults?.gear === 'geared' || [...eq].some((e) => e.startsWith('cranes:'));
  if (tokens.includes('gearless')) { geared = false; for (const e of [...eq]) if (e === 'cranes' || e.startsWith('cranes:')) eq.delete(e); }
  if (tokens.includes('geared')) geared = true;
  if (geared) eq.add('geared');
  return [...eq];
}
/** Safe working load (t) of the biggest ship's crane ('cranes:2x350' → 350), 0 without cranes. */
export function craneSwlOf(cls) {
  let swl = 0;
  for (const e of eqOf(cls)) { const m = /^cranes:(\d+)x(\d+)/.exec(e); if (m) swl = Math.max(swl, +m[2]); }
  return swl;
}
/** Handling classes a class/variant offers (§5.2). */
export function handlingOf(cls) { return [...(modelOf(cls)?.handling || [])]; }
/** Capacity per unit (§5.2): { t, teu, plugs, ceu, lm, m3, head, pax, segregations, holds }. */
export function unitsOf(cls) {
  const m = modelOf(cls), row = rowOf(cls);
  const u = { t: 0, teu: 0, plugs: 0, ceu: 0, lm: 0, m3: 0, head: 0, pax: 0, segregations: 0, holds: 0, ...(m?.units || {}) };
  if (!(u.t > 0)) u.t = n0(row?.capacity);
  if (!(u.pax > 0)) u.pax = n0(row?.pax);
  if (!(u.segregations > 0) && (m?.handling || []).some((h) => h.startsWith('liquid:'))) u.segregations = 1;
  return u;
}
/** Tonnes of `qty` units of `good` (§5.1 t per unit). toTonnes('lng', 174000) = 78,300. */
export function toTonnes(good, qty) { const g = CARGO[good]; return Math.round(n0(qty) * (g ? g.tPer : 1) * 1000) / 1000; }
/** Units of `good` in `t` tonnes. */
export function fromTonnes(good, t) { const g = CARGO[good]; return n0(t) / (g ? g.tPer : 1); }

/** The handling option of `good` this hull can use, or null. */
export function loadOption(good, cls) {
  const g = CARGO[good]; if (!g) return null;
  const hs = new Set(handlingOf(cls)), eq = new Set(eqOf(cls)), u = unitsOf(cls);
  for (const o of g.opts) {
    if (!hs.has(o.h)) continue;
    if (o.plugs && !(u.plugs > 0)) continue;
    if (o.dg && !eq.has('dg')) continue;
    return o;
  }
  return null;
}
/** Can this hull carry `good` at all? { ok, why? } — why = { code: 'handling', handling, suggest, text }. */
export function canLoad(good, cls) {
  const g = CARGO[good];
  if (!g) return { ok: false, why: { code: 'handling', handling: null, suggest: [], text: 'Unknown cargo' } };
  if (loadOption(good, cls)) return { ok: true };
  const o = g.opts[0];
  const why = { code: 'handling', handling: o.h, suggest: SUGGEST[o.h] || [] };
  if (handlingOf(cls).includes(o.h) && o.plugs) why.code = 'eq', why.eq = 'plugs', why.text = `Needs reefer plugs (you have 0)`;
  else if (handlingOf(cls).includes(o.h) && o.dg) why.code = 'eq', why.eq = 'dg', why.text = 'Needs a dangerous-goods certificate (IMDG)';
  else why.text = handlingText(o.h);
  return { ok: false, why };
}
/** "Needs crude tanks — e.g. Aframax, Suezmax, VLCC" */
export function handlingText(h) {
  const s = SUGGEST[h] || [];
  return `Needs ${HANDLING[h] || h}${s.length ? ` — e.g. ${s.join(', ')}` : ''}`;
}

/** Units a cargo stack occupies in `unit` (stacks carry `unit`/`units` from JOB_GEN 8; older ones are tonnes). */
function stackUnits(c, unit) {
  const u = c.unit || 't';
  if (unit === 't') return n0(c.qty);
  if (unit === 'plugs') return n0(c.plugs);
  return u === unit ? n0(c.units ?? c.qty) : 0;
}
/**
 * Free capacity of `vessel` ({ ship: { cls }, cargo, jobs } or a player) in `unit`. Tonnes: capacity − cargo mass;
 * pax: berths − passengers of accepted jobs; other units: the model's units − stacks in that unit.
 */
export function freeUnits(vessel, unit) {
  const cls = vessel?.ship?.cls ?? vessel?.cls;
  const u = unitsOf(cls);
  if (unit === 'pax') return n0(u.pax) - (vessel?.jobs || []).reduce((s, j) => s + n0(j?.pax), 0);
  const cap = unit === 't' ? n0(rowOf(cls)?.capacity ?? u.t) : n0(u[unit]);
  return cap - (vessel?.cargo || []).reduce((s, c) => s + stackUnits(c, unit), 0);
}
/** A cargo stack for a job lot (qty stays tonnes so every legacy mass sum keeps working). */
export function makeStack(good, units, unit, jobId, extra = {}) {
  return { good, qty: toTonnes(good, units), unit: unit || CARGO[good]?.unit || 't', units, contraband: !!CARGO[good]?.contraband, jobId: jobId ?? null, ...extra };
}
/** The good a market or politics list uses for `good` until it lists the new goods (§5.1 fallback column). */
export function marketGoodOf(good) { const g = CARGO[good]; return g && !g.market && g.fallback ? g.fallback : good; }
