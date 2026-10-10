// Interiors v2 — model parameters (docs/INTERIORS-V2-CONTRACT.md §4.7, Lane A). Pure, deterministic, frozen, cached.
// modelParams(variantId) → ModelParams: what makes a 1990s coaster differ from an eco Ultramax inside (era, comfort,
// palette, crew and cabin sizes from MLC 2006 by GT, topology, lift/gym/hospital, main engine detail, fuel, venues).
// Derived from the catalogue model + its general arrangement; per-model overrides in IV2_OVERRIDES (data lane edits).
import { generalArrangement } from './ga.js';
import { MODELS } from './catalogue.js';
import { parseVariant } from './options.js';

/** FNV-1a 32-bit hash (same as public/js/models.js hashStr) — the seed of every v2 choice for a variant. */
export function hashStr(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
/** Deterministic PRNG (mulberry32) from a seed. */
export function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** MLC 2006 Standard A3.1 9 minimum sleeping-room floor areas (m², single berth) by gross tonnage (Source S20). */
export function mlcArea(gt, officer = false) {
  if (officer) return gt < 3000 ? 7.5 : gt < 10000 ? 8.5 : 10.0;
  return gt < 3000 ? 4.5 : gt < 10000 ? 5.5 : 7.0;
}

/** Per-model overrides (data lane). Shallow-merged over the derived record. */
export const IV2_OVERRIDES = Object.freeze({
  giga100: Object.freeze({ extras: ['cinema', 'spa', 'gym'], style: 'yacht' }),
  research75: Object.freeze({ extras: ['wet_lab', 'dry_lab', 'ctd_hangar', 'conference'] }),
  icebreaker120: Object.freeze({ extras: ['aft_bridge', 'hangar', 'mission_room'], ice: true }),
  ferry50: Object.freeze({ doubleEnded: true }),
  factory80: Object.freeze({ factoryLine: 34 }),
});

const STYLE = { aft_house_dry: 'merchant', aft_house_tanker: 'merchant', container: 'merchant', lng: 'merchant', roro_pctc: 'merchant', offshore: 'offshore', special: 'offshore', fishing: 'fishing', tug: 'small', small_fast: 'small', ferry: 'pax', cruise: 'pax', motor_yacht: 'yacht' };
const VENUES = {
  ferry: ['info_desk', 'cafeteria', 'seats_lounge', 'bar', 'shop', 'kids', 'restaurant', 'pet_area', 'drivers_lounge'],
  cruise: ['main_dining', 'buffet', 'theatre', 'bar', 'bar', 'bar', 'casino', 'shop', 'shop', 'shop', 'shop', 'library', 'card_room', 'spa', 'kids', 'art_gallery', 'specialty', 'specialty', 'lounge_pax'],
};
const cache = new Map();

/** ModelParams of a model / variant id (null when it has no general arrangement). Frozen and cached. */
export function modelParams(variantId) {
  if (cache.has(variantId)) return cache.get(variantId);
  const pv = parseVariant(variantId);
  const ga = pv ? generalArrangement(variantId) : null;
  if (!pv || !ga || ga.gen === 'sail') { cache.set(variantId, null); return null; }
  const m = MODELS[pv.model], o = pv.opts, seed = hashStr(variantId);
  const r = rng(seed);
  const era = m.era === 'eco' || o.spec === 'eco' ? 'eco' : 'classic';
  const premium = o.spec === 'prem';
  const comfort = Number(m.stats?.comfort ?? 1);
  const style = IV2_OVERRIDES[pv.model]?.style || (ga.yacht ? 'yacht' : STYLE[ga.gen] || 'merchant');
  const gt = ga.gt || m.gt || 1000;
  const crew = ga.crew || { berths: m.crew?.opt || 8, officers: Math.ceil((m.crew?.opt || 8) * 0.4), ratings: Math.floor((m.crew?.opt || 8) * 0.6) };
  const officers = crew.officers ?? Math.ceil((crew.berths || 8) * 0.4), ratings = crew.ratings ?? Math.max(0, (crew.berths || 8) - officers);
  const shared = era === 'classic' && (officers + ratings) >= 12;
  const palette = style === 'yacht' ? (r() < 0.5 ? 'yacht_oak' : 'yacht_walnut') : style === 'pax' ? (r() < 0.5 ? 'pax_warm' : 'pax_cool') : era === 'eco' ? (r() < 0.5 ? 'eco_grey' : 'eco_blue') : (r() < 0.5 ? 'classic_beige' : 'classic_green');
  const area = (off) => { const mlc = mlcArea(gt, off); const t = off ? Math.max(mlc, 11) : Math.max(mlc, 8.5); return Math.min(off ? 13 : 10.5, t * (premium ? 1.1 : 1)); };
  const W = ga.house ? ga.house.x1 - ga.house.x0 : ga.B * 0.6;
  const tiers = ga.house?.tiers?.length || 1;
  const fuel = o.engine === 'lng' ? 'lng' : o.engine === 'meoh' ? 'meoh' : (m.engine?.fuel === 'mgo' || gt < 3000) ? 'mgo' : 'hfo';
  const kind = ga.er?.me?.kind || m.engine?.kind || '4s';
  const p = {
    id: variantId, model: pv.model, gen: ga.gen, seed, style, era, comfort, premium, palette,
    gt, L: ga.L, B: ga.B,
    crew: { officers, ratings, berths: crew.berths ?? officers + ratings, seniors: officers >= 4 ? ['master', 'chief_engineer', ...(gt >= 3000 ? ['chief_officer'] : []), ...(tiers >= 5 ? ['owner'] : [])] : ['master'], messes: (officers + ratings) >= 10 ? 2 : 1, washrooms: shared ? 'shared' : 'ensuite' },
    cabin: { rating: area(false), officer: area(true), mlcRating: mlcArea(gt, false), mlcOfficer: mlcArea(gt, true), moduleW: W < 9 ? 2.6 : W < 16 ? 2.9 : 3.1 },
    topology: ga.house?.core?.kind === 'ring' ? 'ring' : W < 9 ? 'spine' : 'double',
    lift: tiers >= 6, gym: gt >= 10000 || crew.gym === true, hospital: (officers + ratings) >= 15 || crew.hospital === true, pool: ga.gen === 'cruise',
    me: { kind, n: ga.er?.me?.n || 1 }, fuel, scrubber: o.engine === 'scr', ice: !!o.ice || !!IV2_OVERRIDES[pv.model]?.ice,
    venues: VENUES[ga.gen] ? VENUES[ga.gen].slice() : [], seatsPerCover: ga.gen === 'cruise' ? 0.55 : 0.4, berthsPerCrewCabin: ga.gen === 'cruise' || ga.gen === 'ferry' ? 2 : style === 'small' || style === 'fishing' ? 2 : 1,
    fillers: ['linen', 'ac_room', 'fan_room', 'bonded_store', ...(comfort > 1 ? ['lounge_crew'] : []), 'smoke_room', 'cadet_study', 'conference', 'library'],
    extras: [],
  };
  const ov = IV2_OVERRIDES[pv.model];
  const out = deepFreeze({ ...p, ...(ov || {}) });
  cache.set(variantId, out);
  return out;
}
function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; }
