// Cruise ship programme (docs/CRUISE-CONTRACT.md §3–§5). Pure, deterministic, frozen, cached; browser-safe (no DOM).
// One record per cruise model says what the ship HAS: the deck stack, how many atria / theatres / restaurants / bars /
// pools / slides it carries, the extras of its class (ice rink, climbing wall …) and the cabin mix. Three consumers:
//   * ga.js GEN.cruise       the deck stack and the tower count (what the exterior and the walkable plan are built from),
//   * public/js/gacruise.js  the venues that fill the public decks, and the seed of every layout choice,
//   * shared/jobs            onboard spending is scaled by the venues the ship really has (onboardIndex).
// Quantities scale with the guest count (one specialty restaurant per ~700 guests, one bar per ~450 …) inside the
// class limits, so a 7,600-guest ship carries more of everything than a 1,250-guest one, and a 150-guest river ship has a
// panoramic lounge and nothing like a casino. Class differences (atrium count, deck stack, extras) are data rows below.
import { MODELS } from './catalogue.js';

export const CRUISE_CLASSES = ['river', 'boutique', 'expedition', 'mid', 'premium', 'large', 'mega', 'giga'];
const CLASS_OF = { rivercruise110: 'river', boutique125: 'boutique', expedition105: 'expedition', cruise230: 'mid', cruise285: 'premium', cruise330: 'large', cruise362: 'mega', cruise370: 'giga' };
/** The cruise class of a model id (unknown cruise-type models fall back by length). */
export function cruiseClassOf(id) {
  if (CLASS_OF[id]) return CLASS_OF[id];
  const m = MODELS[id];
  if (!m || m.type !== 'cruise') return null;
  return m.length < 115 ? 'river' : m.length < 200 ? 'boutique' : m.length < 255 ? 'mid' : m.length < 310 ? 'premium' : m.length < 350 ? 'large' : m.length < 366 ? 'mega' : 'giga';
}

// Class rows. stack: decks bottom → top as [crew, public, cabin, lido, sun]; atria: [{ name, decks }] (a multi-deck void
// through the public decks); theatre: decks high; per1000: how a venue count grows with the guests; extras: class features.
//   main = main dining rooms, spec = specialty restaurants, bars = bars & pubs, clubs = nightclubs / dance venues
const ROWS = {
  river:      { stack: [1, 1, 2, 0, 1], towers: 2, atria: [], theatre: 0, main: 1, spec: 0, buffet: 0, court: 0, bars: 1, lounges: 1, clubs: 0, casino: 0, spa: 1, gym: 1, kids: 0, teens: 0, shops: 1, pools: 1, slides: 0,
                extras: ['library', 'panorama_lounge', 'bike_store'], mix: { in: 0, out: 0.62, bal: 0.34, suite: 0.04, acc: 0.04 }, theme: 'wood' },
  boutique:   { stack: [2, 1, 3, 1, 1], towers: 2, atria: [{ name: 'Salon stair', decks: 2 }], theatre: 1, main: 1, spec: 1, buffet: 0, court: 0, bars: 2, lounges: 1, clubs: 0, casino: 0, spa: 1, gym: 1, kids: 0, teens: 0, shops: 1, pools: 2, slides: 0,
                extras: ['library', 'marina_platform', 'observation'], mix: { in: 0, out: 0.1, bal: 0.5, suite: 0.4, acc: 0.03 }, theme: 'yacht' },
  expedition: { stack: [2, 1, 2, 1, 1], towers: 2, atria: [], theatre: 1, main: 1, spec: 0, buffet: 0, court: 0, bars: 2, lounges: 1, clubs: 0, casino: 0, spa: 1, gym: 1, kids: 0, teens: 0, shops: 1, pools: 1, slides: 0,
                extras: ['lecture_hall', 'mud_room', 'zodiac_station', 'observation', 'library', 'science_lab'], mix: { in: 0, out: 0.35, bal: 0.5, suite: 0.15, acc: 0.03 }, theme: 'expedition' },
  mid:        { stack: [3, 2, 3, 1, 1], towers: 3, atria: [{ name: 'Atrium', decks: 3 }], theatre: 2, main: 1, spec: 2, buffet: 1, court: 0, bars: 4, lounges: 2, clubs: 1, casino: 1, spa: 1, gym: 1, kids: 1, teens: 0, shops: 3, pools: 2, slides: 1,
                extras: ['library', 'card_room', 'art_gallery', 'photo_gallery'], mix: { in: 0.18, out: 0.22, bal: 0.52, suite: 0.08, acc: 0.02 }, theme: 'classic' },
  premium:    { stack: [3, 3, 6, 1, 1], towers: 4, atria: [{ name: 'Grand Atrium', decks: 3 }, { name: 'Winter Garden', decks: 3 }], theatre: 2, main: 2, spec: 3, buffet: 1, court: 0, bars: 5, lounges: 3, clubs: 1, casino: 1, spa: 1, gym: 1, kids: 1, teens: 1, shops: 5, pools: 3, slides: 2,
                extras: ['library', 'card_room', 'art_gallery', 'cinema', 'mini_golf', 'sports_court', 'arcade'], mix: { in: 0.17, out: 0.16, bal: 0.56, suite: 0.09, acc: 0.02 }, theme: 'premium' },
  large:      { stack: [3, 3, 7, 1, 1], towers: 5, atria: [{ name: 'Atrium', decks: 3 }, { name: 'Promenade', decks: 3 }], theatre: 2, main: 3, spec: 5, buffet: 1, court: 1, bars: 7, lounges: 3, clubs: 2, casino: 1, spa: 1, gym: 1, kids: 1, teens: 1, shops: 8, pools: 3, slides: 4,
                extras: ['library', 'card_room', 'art_gallery', 'cinema', 'mini_golf', 'sports_court', 'arcade', 'climbing_wall', 'ice_rink'], mix: { in: 0.16, out: 0.12, bal: 0.6, suite: 0.1, acc: 0.02 }, theme: 'resort' },
  mega:       { stack: [3, 3, 10, 1, 1], towers: 5, atria: [{ name: 'Royal Promenade', decks: 3 }, { name: 'Grand Atrium', decks: 3 }, { name: 'Central Park', decks: 3 }], theatre: 2, main: 3, spec: 7, buffet: 1, court: 2, bars: 9, lounges: 4, clubs: 2, casino: 1, spa: 1, gym: 1, kids: 1, teens: 1, shops: 12, pools: 4, slides: 6,
                extras: ['library', 'card_room', 'art_gallery', 'cinema', 'mini_golf', 'sports_court', 'arcade', 'climbing_wall', 'ice_rink', 'rope_course', 'aqua_theatre', 'zip_line'], mix: { in: 0.14, out: 0.1, bal: 0.62, suite: 0.12, acc: 0.02 }, theme: 'neighbourhoods' },
  giga:       { stack: [3, 3, 11, 2, 1], towers: 5, atria: [{ name: 'Grand Atrium', decks: 3 }, { name: 'Boardwalk', decks: 3 }, { name: 'Central Park', decks: 3 }], theatre: 2, main: 3, spec: 8, buffet: 1, court: 2, bars: 10, lounges: 4, clubs: 3, casino: 1, spa: 1, gym: 1, kids: 1, teens: 1, shops: 12, pools: 6, slides: 9,
                extras: ['library', 'card_room', 'art_gallery', 'cinema', 'mini_golf', 'sports_court', 'arcade', 'climbing_wall', 'ice_rink', 'rope_course', 'aqua_theatre', 'surf_simulator', 'water_park'], mix: { in: 0.13, out: 0.09, bal: 0.63, suite: 0.13, acc: 0.02 }, theme: 'waterpark' },
};

// Net onboard spending, cr per guest-hour, per venue (after the cost of goods; Game rule): the more the ship has to spend
// money on, the more the charter earns. shared/jobs/catalogue.js payCruise multiplies by the guests and the hours.
export const VENUE_SPEND = { casino: 0.9, bar: 0.17, lounge: 0.1, club: 0.25, spec: 0.2, spa: 0.6, shop: 0.1, art_gallery: 0.15, photo_gallery: 0.05, arcade: 0.08, ice_rink: 0.08, climbing_wall: 0.04,
  slide: 0.04, aqua_theatre: 0.05, surf_simulator: 0.1, cinema: 0.03, mini_golf: 0.03, zip_line: 0.05, rope_course: 0.03, card_room: 0.04, marina_platform: 0.3, observation: 0.05, panorama_lounge: 0.12, lecture_hall: 0.02 };

const SPEND_K = 0.5;   // onboard spending is about 40 % of the ticket on a mainstream ship (Game rule)
const cache = new Map();
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };
const sc = (n, guests, per, lo = 0) => Math.max(lo, Math.round((guests / 1000) * per));

/**
 * The programme of a cruise model (null for other ships). Counts grow with the guests inside the class row:
 * a bigger guest list than the row's design point adds bars, shops and specialty restaurants (max +50 %).
 */
export function cruiseProfile(modelId) {
  if (cache.has(modelId)) return cache.get(modelId);
  const m = MODELS[modelId], cls = cruiseClassOf(modelId);
  if (!m || !cls) { cache.set(modelId, null); return null; }
  const R = ROWS[cls], guests = m.units?.pax || m.pax || 100, crew = m.crew?.opt || 50;
  const design = { river: 150, boutique: 280, expedition: 200, mid: 1250, premium: 2900, large: 4000, mega: 6700, giga: 7600 }[cls];
  const k = Math.min(1.5, Math.max(0.67, guests / design));
  const n = (v) => Math.max(v > 0 ? 1 : 0, Math.round(v * k));
  const [crewN, pubN, cabN, lidoN, sunN] = R.stack;
  const cabins = Math.ceil(guests / 2.3);
  const mix = R.mix;
  const cabinCounts = { in: Math.round(cabins * mix.in), out: Math.round(cabins * mix.out), suite: Math.max(1, Math.round(cabins * mix.suite)), acc: Math.max(2, Math.round(cabins * mix.acc)) };
  cabinCounts.bal = cabins - cabinCounts.in - cabinCounts.out - cabinCounts.suite - cabinCounts.acc;
  const dining = { main: R.main, spec: n(R.spec), buffet: R.buffet, court: R.court };
  const venues = {
    theatre: R.theatre ? 1 : 0, main: dining.main, spec: dining.spec, buffet: dining.buffet, court: dining.court,
    bar: n(R.bars), lounge: R.lounges, club: R.clubs, casino: R.casino, spa: R.spa, gym: R.gym, kids: R.kids, teens: R.teens, shop: n(R.shops),
    pool: R.pools, slide: R.slides ? Math.max(1, Math.round(R.slides * (k < 1 ? 1 : 1))) : 0,
  };
  const spend = Object.entries(venues).reduce((s, [v, q]) => s + (VENUE_SPEND[v === 'main' ? 'x' : v] || 0) * q, 0)
    + R.extras.reduce((s, e) => s + (VENUE_SPEND[e] || 0), 0);
  const p = deepFreeze({
    id: modelId, cls, guests, crew, theme: R.theme, seed: hash(modelId),
    stack: { crew: crewN, public: pubN, cabin: cabN, lido: lidoN, sun: sunN, total: crewN + pubN + cabN + lidoN + sunN },
    towers: R.towers, atria: R.atria.map((a) => ({ ...a })), theatre: { decks: R.theatre, seats: R.theatre ? Math.round(Math.min(1500, Math.max(120, guests * 0.2)) / 10) * 10 : 0 },
    dining, venues, extras: R.extras.slice(), cabins: { total: cabins, ...cabinCounts },
    onboard: Math.round(spend * SPEND_K * 100) / 100,
  });
  cache.set(modelId, p);
  return p;
}
/** Net onboard spending, cr per guest-hour, of a model's venues (0 for other ships). */
export function onboardIndex(modelId) { return cruiseProfile(modelId)?.onboard ?? 0; }
/** Every venue of the ship as a flat list (a kind per entry; 'bar' ×9 …) for summaries and tests. */
export function venueList(modelId) {
  const p = cruiseProfile(modelId); if (!p) return [];
  const out = [];
  for (const [k, q] of Object.entries(p.venues)) for (let i = 0; i < q; i++) out.push(k);
  for (const e of p.extras) out.push(e);
  for (let i = 0; i < p.atria.length; i++) out.push('atrium');
  return out;
}
function hash(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
