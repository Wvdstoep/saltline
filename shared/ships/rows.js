// SHIP_CLASSES-shaped rows for model and variant ids (docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §7.2). No constants
// import: shared/constants.js imports this module after H1. `classRow(id)` is cached; legacy ids without options return
// today's row object unchanged.
import { MODELS, LEGACY_ROWS, SAIL_IDS } from './catalogue.js';
import { OPTIONS, parseVariant, priceMul, burnMul, specOf, ecoGrade } from './options.js';

/** The 13 non-sail legacy rows (H1 replaces the literal rows in constants.js with these). */
export const legacyRows = Object.fromEntries(Object.entries(LEGACY_ROWS).filter(([k]) => !SAIL_IDS.includes(k)).map(([k, v]) => [k, { ...v }]));

/** Own legacy row of the live table (never through its prototype: that is the variant proxy itself). */
const own = (base, k) => (base && Object.prototype.hasOwnProperty.call(base, k) ? base[k] : undefined);
const r3 = (v) => Math.round(v * 1000) / 1000;
const round1000 = (v) => Math.round(v / 1000) * 1000;
const GAME_KEYS = ['id', 'cat', 'name', 'length', 'beam', 'draft', 'maxKn', 'auxKn', 'sail', 'turnRate', 'displacement', 'capacity', 'pax', 'fuelCap',
  'burn', 'price', 'hullColor', 'fishRate', 'wearMul', 'crewCost', 'towPower', 'desc'];

/** The game row of a model with no options (legacy rows: taken from `base` when given, i.e. the live SHIP_CLASSES). */
function modelRow(m, base) {
  const src = own(base, m.id) || LEGACY_ROWS[m.id] || m;
  const row = {};
  for (const k of GAME_KEYS) if (src[k] !== undefined) row[k] = src[k];
  return row;
}

/** Price basis of a model: its game price, or for the starter coaster (price 0) the wave-2 D12 price 120,000. */
export function priceBasis(m, base) { const p = (own(base, m.id) || LEGACY_ROWS[m.id] || m).price; return p > 0 ? p : (m.basis || 0); }

function derive(id, base) {
  const pv = parseVariant(id);
  if (!pv) return null;
  const m = MODELS[pv.model];
  if (!pv.tokens.length && LEGACY_ROWS[m.id]) return own(base, m.id) || LEGACY_ROWS[m.id];
  const row = modelRow(m, base), t = pv.tokens, spec = specOf(t);
  const engine = OPTIONS[pv.opts.engine] || null;
  row.id = id;
  if (t.length) {
    const p = priceBasis(m, base);
    row.price = p > 0 ? round1000(p * priceMul(t)) : 0;
    row.burn = r3(row.burn * burnMul(t));
    let fc = row.fuelCap;
    for (const k of t) if (OPTIONS[k].fuelCapMul) fc *= OPTIONS[k].fuelCapMul;
    row.fuelCap = fc >= 10 ? Math.round(fc) : Math.round(fc * 10) / 10;
    for (const k of t) if (OPTIONS[k].capMul) row.capacity = Math.round(row.capacity * OPTIONS[k].capMul);
    if (spec) row.wearMul = r3(row.wearMul * spec.wearMul);
  }
  const iceTok = pv.opts.ice || m.ice;
  Object.assign(row, {
    model: m.id, variant: id, type: m.type, gen: m.gen, base: m.base, era: m.era, opts: pv.opts, tokens: t,
    fuelCostMul: engine && t.includes(pv.opts.engine) ? engine.fuelCost : 1,
    ecaExempt: !!(engine && t.includes(pv.opts.engine) && engine.ecaExempt) || m.defaults.engine === 'lng',
    lngBunkers: !!(engine && t.includes(pv.opts.engine) && engine.lngBunkers) || m.defaults.engine === 'lng',
    partLoad: (engine && t.includes(pv.opts.engine) && engine.partLoad) || null,
    ice: iceTok || null, iceWear: OPTIONS[pv.opts.ice]?.iceWear ?? (m.ice === 'pc3' ? 0.1 : m.ice === 'pc6' ? 0.25 : m.ice === 'i1a' ? 0.4 : 1),
    eco: ecoGrade(m.stats.eco, t), airDraft: m.stats.airDraft + (t.includes('rot') ? OPTIONS.rot.airDraftAdd : 0),
    rotor: t.includes('rot'), geared: pv.opts.gear === 'geared',
    reliability: r3(m.stats.reliability * (spec?.reliability ?? 1)), comfort: Math.max(0, m.stats.comfort + (spec && ['ferry', 'cruise', 'motor_yacht', 'sail_yacht'].includes(m.type) ? spec.comfort : 0)),
    resale: spec?.resale ?? 1,
  });
  return Object.freeze(row);
}

const DEFAULT = {}, caches = new WeakMap();
/** SHIP_CLASSES-shaped row for a model or variant id, or null. `base` = the live SHIP_CLASSES legacy rows (optional);
 *  results are cached per base object (rows are frozen; negative results are cached too, bounded). */
export function classRow(id, base = null) {
  if (typeof id !== 'string') return null;
  const key = base || DEFAULT;
  let c = caches.get(key);
  if (!c) { c = { hit: new Map(), miss: new Set() }; caches.set(key, c); }
  if (c.hit.has(id)) return c.hit.get(id);
  if (c.miss.has(id)) return null;
  const row = derive(id, base);
  if (row) c.hit.set(id, row);
  else { if (c.miss.size > 512) c.miss.clear(); c.miss.add(id); }
  return row;
}
