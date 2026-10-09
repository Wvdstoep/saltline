// Lane D's read-only view of a ship class: the catalogue of Lane A (shared/ships/index.js, frozen interface §7.2) when it
// is there, else today's 17 legacy rows with the §5.2 "legacy ⓛ" handling. Everything in shared/cargo.js and
// shared/jobs/* asks this module, never MODELS directly, so the jobs work before, during and after Lane A's merge.
// Plain ESM, browser-safe. Tests swap the source with setShipSource(stub).
import { SHIP_CLASSES } from '../constants.js';

let lib = null;
try { lib = await import('../ships/index.js'); } catch { lib = null; }   // Lane A not merged yet → legacy view only
let override = null;
const cache = new Map();

/** Replace the catalogue (tests, or the server once Lane A loads lazily). `null` restores the default. */
export function setShipSource(src) { override = src || null; cache.clear(); }
export function shipSource() { return override || lib; }

// §5.2 legacy rows: what today's 17 hulls offer (the coaster loses fuel cargo, Q5). `geared` = own cranes (Game rule for
// the starter coaster and the Handysize bulker, which the real classes have).
const LEGACY = {
  coaster: { type: 'general', handling: ['bulk', 'breakbulk', 'box'], units: { teu: 60, holds: 2 }, eq: ['cranes:2x25'], tags: ['geared'], crew: { min: 7, opt: 9 } },
  feeder: { type: 'container', handling: ['box'], units: { teu: 1100, plugs: 150 }, eq: [], crew: { min: 13, opt: 17 } },
  bulker: { type: 'bulk', handling: ['bulk', 'breakbulk'], units: { holds: 5 }, eq: ['cranes:4x30', 'grabs'], tags: ['geared'], crew: { min: 18, opt: 21 }, dwt: 35000 },
  tanker: { type: 'tanker', handling: ['liquid:clean', 'liquid:crude'], units: { segregations: 3 }, eq: [], crew: { min: 18, opt: 22 }, dwt: 37000 },
  boxship: { type: 'container', handling: ['box'], units: { teu: 6500, plugs: 500 }, eq: ['dg'], crew: { min: 20, opt: 24 }, dwt: 80000 },
  trawler: { type: 'fishing', handling: ['fish'], units: {}, eq: [], crew: { min: 6, opt: 10 } },
  tug: { type: 'tug', handling: [], units: {}, eq: ['towWinch', 'fifi'], crew: { min: 4, opt: 6 }, bp: 80 },
  psv: { type: 'offshore', handling: ['deck', 'liquid:clean'], units: { m3: 1000 }, eq: ['dp2'], crew: { min: 12, opt: 15 } },
  pilot: { type: 'pilot', handling: ['pax'], units: {}, eq: [], crew: { min: 2, opt: 3 } },
  ferry: { type: 'ferry', handling: ['pax', 'roro'], units: { lm: 900 }, eq: [], crew: { min: 25, opt: 35 } },
  cruiser: { type: 'motor_yacht', handling: ['pax'], units: {}, eq: [], crew: { min: 1, opt: 1 } },
  myacht: { type: 'motor_yacht', handling: ['pax'], units: {}, eq: ['tender'], crew: { min: 3, opt: 4 } },
  superyacht: { type: 'motor_yacht', handling: ['pax'], units: {}, eq: ['tender', 'pyc'], crew: { min: 18, opt: 22 } },
  sloop: { type: 'sail_yacht', handling: ['pax'], units: {}, eq: ['sail'], crew: { min: 1, opt: 1 } },
  ketch: { type: 'sail_yacht', handling: ['pax'], units: {}, eq: ['sail'], crew: { min: 1, opt: 2 } },
  catamaran: { type: 'sail_yacht', handling: ['pax'], units: {}, eq: ['sail'], crew: { min: 1, opt: 2 } },
  schooner: { type: 'sail_yacht', handling: ['pax'], units: {}, eq: ['sail', 'tender'], crew: { min: 3, opt: 5 } },
};
const CAT_TYPE = { cargo: 'general', working: 'workboat', passenger: 'ferry', 'motor yacht': 'motor_yacht', 'sailing yacht': 'sail_yacht' };

/** Split a variant id 'ultramax64~lng.i1c.esd' → { model, tokens }. */
export function splitVariant(cls) {
  const s = String(cls ?? '');
  const i = s.indexOf('~');
  return i < 0 ? { model: s, tokens: [] } : { model: s.slice(0, i), tokens: s.slice(i + 1).split('.').filter(Boolean) };
}

/** The model record (Lane A) or a legacy-derived stand-in with the same fields Lane D reads. */
export function modelOf(cls) {
  const key = String(cls ?? '');
  if (cache.has(key)) return cache.get(key);
  const src = shipSource();
  const { model: mid } = splitVariant(key);
  let m = null;
  try { m = src?.modelOf?.(key) ?? src?.MODELS?.[mid] ?? null; } catch { m = null; }
  if (!m) {
    // Only the table's own (legacy) rows: SHIP_CLASSES also resolves catalogue model ids through its variant prototype
    // (ships/classes.js), and a stand-in built from such a row would have no handling/units — unknown here means null.
    const row = Object.prototype.hasOwnProperty.call(SHIP_CLASSES, mid) ? SHIP_CLASSES[mid] : null;
    if (row) {
      const L = LEGACY[mid] || { type: CAT_TYPE[row.cat] || 'general', handling: [], units: {}, eq: [] };
      m = { ...row, id: mid, base: mid, era: 'classic', type: L.type, handling: L.handling, units: { t: row.capacity, pax: row.pax, ...L.units },
        eq: L.eq, tags: L.tags || [], crew: L.crew || { min: 1, opt: 1 }, dwt: L.dwt ?? row.capacity, bp: L.bp ?? (row.towPower ? row.towPower * 70 : 0), stats: {} };
    }
  } else if (LEGACY[m.id] && !Array.isArray(m.handling)) {
    m = { ...m, handling: LEGACY[m.id].handling, units: { t: m.capacity, pax: m.pax, ...LEGACY[m.id].units, ...(m.units || {}) }, eq: m.eq || LEGACY[m.id].eq };
  }
  cache.set(key, m);
  return m;
}

/** The SHIP_CLASSES-shaped game row (variant deltas applied by Lane A's classRow when present). */
export function rowOf(cls) {
  const src = shipSource();
  let r = null;
  try { r = src?.classRow?.(cls) ?? null; } catch { r = null; }
  return r || SHIP_CLASSES[cls] || SHIP_CLASSES[splitVariant(cls).model] || modelOf(cls) || null;
}

export function typeOf(cls) { return modelOf(cls)?.type ?? null; }
export function isKnown(cls) { return !!modelOf(cls); }
export function loaOf(cls) { const m = modelOf(cls); return m?.length ?? rowOf(cls)?.length ?? 0; }
export function draftOf(cls) { const m = modelOf(cls); return m?.draft ?? rowOf(cls)?.draft ?? 0; }
export function nameOf(cls) { const m = modelOf(cls); return m?.short || m?.name || rowOf(cls)?.name || String(cls); }
export function isSail(cls) { return !!rowOf(cls)?.sail || typeOf(cls) === 'sail_yacht'; }
export function isYacht(cls) { const t = typeOf(cls); return t === 'sail_yacht' || t === 'motor_yacht'; }
/** Bollard pull (t): model `bp`, else towPower × 70 (§2.4 towPower = BP / 70). */
export function bpOf(cls) { const m = modelOf(cls); if (Number.isFinite(m?.bp) && m.bp > 0) return m.bp; const tp = rowOf(cls)?.towPower || m?.towPower || 0; return Math.round(tp * 70); }
/** KR-reference price with options (§4.5 basePrice), else the game row price. */
export function basePriceOf(cls) {
  const src = shipSource();
  try { const p = src?.basePrice?.(cls); if (Number.isFinite(p)) return p; } catch { /* fall through */ }
  return rowOf(cls)?.price || 0;
}
/** Service speed (kn), same rule as shared/rates.js serviceKn, read from this view's row. */
export function serviceKnOf(cls, loadFrac = 0) {
  const C = rowOf(cls);
  if (!C) return 10;
  const kn = C.sail ? Math.max(C.auxKn || 5, 0.6 * C.maxKn) : C.maxKn * 0.8;
  return kn * (1 - 0.15 * Math.max(0, Math.min(1, loadFrac)));
}
/** Comfort points (wave-2 stats.comfort; 1 when unknown) and crew numbers. */
export function comfortOf(cls) { const c = modelOf(cls)?.stats?.comfort; return Number.isFinite(c) ? c : 1; }
export function crewOf(cls) { return modelOf(cls)?.crew || { min: 1, opt: 1 }; }

// Ice class ranks (§2.5 tokens): none < 1C < 1B < 1A < 1A Super < PC6 < PC4 < PC3.
export const ICE_RANK = { none: 0, i1c: 1, i1b: 2, i1a: 3, i1as: 4, pc6: 5, pc4: 6, pc3: 7 };
export const ICE_LABEL = { i1c: '1C', i1b: '1B', i1a: '1A', i1as: '1A Super', pc6: 'PC6', pc4: 'PC4', pc3: 'PC3' };
function iceToken(v) {
  const s = String(v ?? '').toLowerCase().replace(/[\s_-]/g, '');
  if (!s) return null;
  if (s === '1asuper' || s === '1as' || s === 'i1as') return 'i1as';
  for (const k of ['pc3', 'pc4', 'pc6', 'i1a', 'i1b', 'i1c']) if (s === k || 'i' + s === k) return k;
  return null;
}
/** Highest ice class token of a class/variant (variant token, else the model's stats.ice), or null. */
export function iceOf(cls) {
  const { tokens } = splitVariant(cls);
  let best = iceToken(modelOf(cls)?.stats?.ice) || iceToken(modelOf(cls)?.ice);
  for (const t of tokens) { const k = iceToken(t); if (k && (!best || ICE_RANK[k] > ICE_RANK[best])) best = k; }
  return best;
}
export function iceRank(cls) { return ICE_RANK[iceOf(cls) || 'none']; }
