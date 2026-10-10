// Interiors v2 — space planner (docs/INTERIORS-V2-CONTRACT.md §2, §4.1–4.2, Lane A). Pure, deterministic, no three.js.
//
// The GA (shared/ships/ga.js) stays frozen: its house tiers, corridors, stair core, casing and entrances are the
// envelope. v2 re-cuts every slot-sized GA room ("block": one door onto a corridor) into spaces of real scale (§2.1):
// rating / officer cabins (with a corridor-side lobby where a band is too deep), suites (day room + bedroom), messes
// with their pantry, galley with dry provisions and cold rooms, hospital, laundry + drying room, offices, the bridge
// deck's chart / radio / electronics / battery rooms — no "spare" rooms. Each block is solved by a small search over
// partitions (strips along the corridor, a front / back split, inner rooms reached through their host) scored against
// the SCALE table; results are cached per block geometry (the template cache of §3.3).
//
//   spacePlan(variantId, opts)  → SpacePlan (frozen, cached)  — the house re-cut + the GA's corridors/stairs/voids
//   scoreSpace(sp)              → { score, waste, voidUnjustified, deadEnds, unreachable, overCap, missingMust }
//   houseSpaces(ga, params)     → per GA room id: the spaces that replace it (gaplan2.js applies them to the plan)
import { generalArrangement, RULES } from './ga.js';
import { modelParams } from './gaparams.js';
import { cruiseDeck, deckFrame } from './cruiselayout.js';

export const IV2_VERSION = 1;
export const IV2_GENS = Object.freeze(['aft_house_dry', 'aft_house_tanker', 'container', 'lng', 'roro_pctc', 'offshore', 'special', 'tug', 'fishing', 'small_fast', 'ferry', 'cruise', 'motor_yacht']);
/** Generators planned by v2 (reviewer flips entries, §12). `?iv2=0` / globalThis.__iv2 = false forces v1 at runtime. */
export const IV2_READY = new Set(['aft_house_dry', 'aft_house_tanker', 'container', 'lng', 'cruise']);

// ------------------------------------------------------------------------------------------------ §2.1 SCALE
// S(min, target, max, [hLo, hHi], floor, wall, ceil, emptyR, [fillLo, fillHi], extra)
// floor / wall / ceil are atlas tile ids (public/js/iv2atlas.js); legacy = the v1 room kind kept for old code.
const S = (min, target, max, h, floor, wall, ceil, emptyR, fill, x = {}) => Object.freeze({ min, target, max, h, floor, wall, ceil, emptyR, fill, lined: ceil !== 'open', ...x });
export const SCALE = Object.freeze({
  cabin_rating: S(6.5, 8.5, 10.5, [2.15, 2.25], 'vinyl', 'laminate', 'panel', 0.9, [0.3, 0.55], { legacy: 'cabin', kit: 'cabin', wet: [1.6, 2.0], acoustic: 'cabin', name: 'Crew cabin', berth: 1 }),
  cabin_officer: S(8.5, 11, 13, [2.15, 2.25], 'vinyl', 'laminate', 'panel', 0.9, [0.3, 0.55], { legacy: 'cabin', kit: 'cabin', wet: [2.0, 2.4], acoustic: 'cabin', name: 'Officer\'s cabin', berth: 1, officer: true }),
  suite_bed: S(9.5, 11, 12.5, [2.2, 2.3], 'carpet', 'veneer', 'panel', 1.2, [0.25, 0.45], { legacy: 'cabin', kit: 'suite_bed', wet: [2.2, 2.8], acoustic: 'cabin', name: 'Bedroom', berth: 1, officer: true, inner: ['suite_day'] }),
  suite_day: S(13, 17, 22, [2.2, 2.3], 'carpet', 'veneer', 'panel', 1.2, [0.25, 0.45], { legacy: 'cabin', kit: 'suite_day', acoustic: 'cabin', name: 'Day room', officer: true }),
  cabin_pilot: S(7, 8.5, 10, [2.15, 2.25], 'vinyl', 'laminate', 'panel', 0.9, [0.3, 0.55], { legacy: 'cabin', kit: 'cabin', wet: [1.6, 2.0], acoustic: 'cabin', name: 'Pilot\'s cabin', berth: 1 }),
  cabin_super: S(7, 9.5, 13, [2.15, 2.25], 'vinyl', 'laminate', 'panel', 0.9, [0.3, 0.55], { legacy: 'cabin', kit: 'cabin', wet: [1.6, 2.2], acoustic: 'cabin', name: 'Supernumerary cabin', berth: 1 }),
  cabin_small: S(3.5, 5, 7, [1.95, 2.1], 'vinyl', 'laminate', 'panel', 0.7, [0.4, 0.65], { legacy: 'cabin', kit: 'cabin_small', acoustic: 'cabin', name: 'Cabin', berth: 2 }),
  cabin_ferry: S(6.5, 8.5, 10.5, [2.2, 2.2], 'carpet', 'laminate', 'panel', 0.9, [0.3, 0.55], { legacy: 'cabin', kit: 'cabin_pax', wet: [1.8, 2.2], acoustic: 'cabin', name: 'Passenger cabin', berth: 2 }),
  cabin_cruise_in: S(13, 14.5, 16, [2.35, 2.45], 'carpet', 'veneer', 'panel', 1.0, [0.3, 0.5], { legacy: 'cabin', kit: 'cabin_pax', acoustic: 'cabin', name: 'Inside stateroom', berth: 2 }),
  cabin_cruise_out: S(15, 17, 20, [2.35, 2.45], 'carpet', 'veneer', 'panel', 1.0, [0.3, 0.5], { legacy: 'cabin', kit: 'cabin_pax', acoustic: 'cabin', name: 'Ocean-view stateroom', berth: 2 }),
  cabin_cruise_bal: S(16, 18.5, 22, [2.35, 2.45], 'carpet', 'veneer', 'panel', 1.0, [0.3, 0.5], { legacy: 'cabin', kit: 'cabin_pax', acoustic: 'cabin', name: 'Balcony stateroom', berth: 2 }),
  cabin_crew_pax: S(7, 8.5, 10, [2.15, 2.15], 'vinyl', 'laminate', 'panel', 0.8, [0.35, 0.6], { legacy: 'cabin', kit: 'cabin', wet: [1.6, 2.0], acoustic: 'cabin', name: 'Crew cabin', berth: 2 }),
  cabin_yacht: S(8, 11, 15, [2.0, 2.15], 'wood', 'veneer', 'panel', 1.0, [0.3, 0.5], { legacy: 'cabin', kit: 'cabin_yacht', acoustic: 'cabin', name: 'Guest cabin', berth: 2 }),
  owner_yacht: S(14, 24, 45, [2.2, 2.4], 'wood', 'veneer', 'panel', 1.4, [0.3, 0.5], { legacy: 'cabin', kit: 'owner_yacht', acoustic: 'cabin', name: 'Owner\'s suite', berth: 2 }),
  vberth: S(3, 4.5, 7, [1.85, 2.0], 'wood', 'veneer', 'panel', 0.6, [0.45, 0.75], { legacy: 'cabin', kit: 'cabin_small', acoustic: 'cabin', name: 'V-berth' }),
  cabin_lobby: S(2.5, 4.5, 11.5, [2.15, 2.25], 'vinyl', 'laminate', 'panel', 0.9, [0.15, 0.6], { legacy: 'passage', kit: 'cabin_lobby', acoustic: 'passage', name: 'Cabin lobby', circulation: true }),
  corridor: S(0, 0, Infinity, [2.1, 2.1], 'vinyl', 'laminate', 'panel', 9, [0, 1], { legacy: 'passage', kit: 'corridor', acoustic: 'passage', name: 'Corridor', circulation: true, width: [1.0, 1.1, 1.2] }),
  corridor_pax: S(0, 0, Infinity, [2.25, 2.25], 'carpet_corr', 'veneer', 'panel', 9, [0, 1], { legacy: 'passage', kit: 'corridor', acoustic: 'passage', name: 'Corridor', circulation: true, width: [1.2, 1.3, 1.5] }),
  crew_alley: S(0, 0, Infinity, [2.3, 2.3], 'vinyl_heavy', 'paint_grey', 'open', 1.6, [0.1, 1], { legacy: 'passage', kit: 'crew_alley', acoustic: 'passage', name: 'Crew alley (I-95)', circulation: true, width: [2.4, 3.0, 3.6] }),
  corridor_yacht: S(0, 0, Infinity, [1.95, 2.1], 'wood', 'veneer', 'panel', 9, [0, 1], { legacy: 'passage', kit: 'corridor', acoustic: 'passage', name: 'Passage', circulation: true, width: [0.85, 0.95, 1.1] }),
  stair: S(0, 0, Infinity, [2.4, 3.0], 'vinyl', 'laminate', 'panel', 9, [0, 1], { legacy: 'stairs', kit: 'stair', acoustic: 'stair', name: 'Stairs', circulation: true }),
  entrance: S(0, 0, Infinity, [2.2, 2.3], 'vinyl', 'laminate', 'panel', 9, [0, 1], { legacy: 'passage', kit: 'entrance', acoustic: 'passage', name: 'Entrance', circulation: true }),
  mess: S(10, 22, 50, [2.25, 2.25], 'vinyl', 'laminate', 'panel', 1.2, [0.25, 0.45], { legacy: 'mess', kit: 'mess', acoustic: 'mess', name: 'Mess room', inner: ['mess'] }),
  galley: S(8, 18, 40, [2.25, 2.25], 'quarry', 'stainless', 'panel', 1.0, [0.35, 0.6], { legacy: 'mess', kit: 'galley', acoustic: 'galley', name: 'Galley' }),
  pantry: S(3, 8, 14, [2.2, 2.2], 'quarry', 'stainless', 'panel', 0.8, [0.4, 0.7], { legacy: 'store', kit: 'pantry', acoustic: 'galley', name: 'Pantry', inner: ['mess', 'galley', 'suite_day', 'lounge_crew'] }),
  provisions_dry: S(3, 8, 14, [2.2, 2.2], 'quarry', 'paint_white', 'panel', 0.8, [0.4, 0.7], { legacy: 'store', kit: 'provisions', acoustic: 'wet', name: 'Dry provisions', inner: ['galley', 'provisions_dry', 'cold_room'] }),
  cold_room: S(2, 4, 8, [2.1, 2.1], 'alu_chequer', 'insulated', 'panel', 0.6, [0.4, 0.7], { legacy: 'store', kit: 'cold_room', acoustic: 'wet', name: 'Cold room', inner: ['galley', 'provisions_dry', 'cold_room'] }),
  hospital: S(7, 9, 14, [2.25, 2.25], 'vinyl', 'laminate', 'panel', 0.9, [0.3, 0.55], { legacy: 'cabin', kit: 'hospital', wet: [0, 3.0], acoustic: 'cabin', name: 'Hospital', berth: 1 }),
  hospital_bath: S(2.5, 3.5, 7.5, [2.2, 2.2], 'tile_wet', 'tile_wet', 'panel', 0.8, [0.35, 0.6], { legacy: 'store', kit: 'washroom', acoustic: 'wet', name: 'Hospital bathroom', inner: ['hospital'] }),
  laundry: S(5, 8, 12, [2.2, 2.2], 'vinyl', 'laminate', 'panel', 0.8, [0.35, 0.6], { legacy: 'store', kit: 'laundry', acoustic: 'wet', name: 'Laundry' }),
  drying_room: S(3, 4, 6, [2.2, 2.2], 'vinyl', 'laminate', 'panel', 0.8, [0.35, 0.6], { legacy: 'store', kit: 'drying_room', acoustic: 'wet', name: 'Drying room', inner: ['laundry', 'changing_er'] }),
  gym: S(10, 16, 28, [2.25, 2.25], 'rubber', 'laminate', 'panel', 1.4, [0.25, 0.45], { legacy: 'mess', kit: 'gym', acoustic: 'mess', name: 'Gymnasium' }),
  recreation: S(10, 16, 28, [2.25, 2.25], 'carpet', 'laminate', 'panel', 1.4, [0.25, 0.45], { legacy: 'mess', kit: 'recreation', acoustic: 'mess', name: 'Recreation room' }),
  lounge_crew: S(10, 16, 28, [2.25, 2.25], 'carpet', 'laminate', 'panel', 1.4, [0.25, 0.45], { legacy: 'mess', kit: 'lounge_crew', acoustic: 'mess', name: 'Crew lounge', inner: ['mess', 'recreation', 'gym'] }),
  library: S(6, 12, 28, [2.25, 2.25], 'carpet', 'veneer', 'panel', 1.4, [0.25, 0.45], { legacy: 'mess', kit: 'library', acoustic: 'mess', name: 'Library' }),
  smoke_room: S(6, 10, 20, [2.25, 2.25], 'vinyl', 'laminate', 'panel', 1.2, [0.25, 0.45], { legacy: 'mess', kit: 'lounge_crew', acoustic: 'mess', name: 'Smoke room', inner: ['mess', 'lounge_crew', 'recreation'] }),
  conference: S(8, 14, 28, [2.25, 2.25], 'carpet', 'laminate', 'panel', 1.2, [0.25, 0.45], { legacy: 'mess', kit: 'conference', acoustic: 'mess', name: 'Conference room', inner: ['office', 'library', 'cargo_office'] }),
  changing_er: S(6, 9, 14, [2.2, 2.2], 'vinyl', 'laminate', 'panel', 0.8, [0.35, 0.6], { legacy: 'store', kit: 'changing_er', acoustic: 'wet', name: 'Engine changing room' }),
  office: S(6, 9, 14, [2.25, 2.25], 'vinyl', 'laminate', 'panel', 0.9, [0.3, 0.55], { legacy: 'store', kit: 'office', acoustic: 'cabin', name: 'Ship\'s office' }),
  cargo_office: S(6, 9, 14, [2.25, 2.25], 'vinyl', 'laminate', 'panel', 0.9, [0.3, 0.55], { legacy: 'store', kit: 'office', acoustic: 'cabin', name: 'Cargo office' }),
  ccr: S(12, 18, 30, [2.3, 2.3], 'vinyl', 'laminate', 'panel', 1.2, [0.25, 0.45], { legacy: 'store', kit: 'ccr', acoustic: 'ecr', name: 'Cargo control room' }),
  bridge: S(20, 120, 320, [2.4, 2.6], 'vinyl_dark', 'laminate', 'panel', 2.0, [0.15, 0.3], { legacy: 'bridge', kit: 'bridge', acoustic: 'bridge', name: 'Wheelhouse' }),
  chartroom: S(3, 6, 14, [2.3, 2.3], 'vinyl', 'laminate', 'panel', 0.9, [0.35, 0.6], { legacy: 'store', kit: 'chartroom', acoustic: 'bridge', name: 'Chart room' }),
  radio_room: S(3, 6, 14, [2.3, 2.3], 'vinyl', 'laminate', 'panel', 0.9, [0.35, 0.6], { legacy: 'store', kit: 'radio_room', acoustic: 'bridge', name: 'Radio room' }),
  electronics: S(3, 6, 14, [2.3, 2.3], 'vinyl', 'laminate', 'panel', 0.9, [0.35, 0.6], { legacy: 'store', kit: 'electronics', acoustic: 'bridge', name: 'Electronics room' }),
  battery: S(3, 5, 12, [2.3, 2.3], 'chequer', 'paint_grey', 'open', 0.9, [0.35, 0.6], { legacy: 'store', kit: 'battery', acoustic: 'workshop', name: 'Battery room', inner: ['electronics', 'radio_room', 'chartroom'] }),
  wc_room: S(2.5, 4, 14, [2.2, 2.2], 'tile_wet', 'tile_wet', 'panel', 0.8, [0.35, 0.6], { legacy: 'store', kit: 'washroom', acoustic: 'wet', name: 'Washroom' }),
  ecr: S(16, 26, 70, [2.4, 2.4], 'vinyl_dark', 'laminate', 'panel', 1.5, [0.2, 0.4], { legacy: 'engine', kit: 'ecr', acoustic: 'ecr', name: 'Engine control room' }),
  workshop: S(8, 18, 45, [3.0, 4.2], 'epoxy', 'paint_er', 'open', 1.0, [0.3, 0.6], { legacy: 'store', kit: 'workshop', acoustic: 'workshop', name: 'Workshop' }),
  spares: S(8, 18, 45, [3.0, 4.2], 'chequer', 'paint_grey', 'open', 1.0, [0.3, 0.6], { legacy: 'store', kit: 'spares', acoustic: 'workshop', name: 'Spares store' }),
  elec_store: S(6, 12, 30, [3.0, 4.2], 'chequer', 'paint_grey', 'open', 1.0, [0.3, 0.6], { legacy: 'store', kit: 'spares', acoustic: 'workshop', name: 'Electrical store' }),
  purifier_room: S(8, 14, 30, [3.0, 4.2], 'grating', 'paint_er', 'open', 1.0, [0.35, 0.6], { legacy: 'store', kit: 'purifier_room', acoustic: 'engine', name: 'Purifier room' }),
  er_platform: S(0, 0, Infinity, [2.0, 9], 'grating', 'paint_er', 'open', 1.6, [0, 1], { legacy: 'engine', kit: 'er_platform', acoustic: 'engine', name: 'Engine room', unlined: true }),
  er_walkway: S(0, 0, Infinity, [2.0, 9], 'grating', 'paint_er', 'open', 9, [0, 1], { legacy: 'engine', kit: 'er_platform', acoustic: 'engine', name: 'Engine room walkway', unlined: true, circulation: true }),
  steering_gear: S(8, 40, 400, [2.4, 6], 'chequer', 'paint_er', 'open', 1.4, [0.25, 0.5], { legacy: 'engine', kit: 'steering_gear', acoustic: 'steering', name: 'Steering gear room' }),
  pump_room: S(4, 12, 400, [2.4, 9], 'chequer', 'paint_er', 'open', 1.2, [0.3, 0.6], { legacy: 'store', kit: 'machinery_room', acoustic: 'engine', name: 'Pump room' }),
  compressor_house: S(4, 12, 200, [2.4, 4], 'chequer', 'paint_grey', 'open', 1.2, [0.3, 0.6], { legacy: 'store', kit: 'machinery_room', acoustic: 'engine', name: 'Compressor house' }),
  winch_room: S(4, 12, 200, [2.4, 4], 'chequer', 'paint_grey', 'open', 1.2, [0.3, 0.6], { legacy: 'store', kit: 'machinery_room', acoustic: 'workshop', name: 'Winch room' }),
  azimuth_room: S(4, 12, 80, [2.0, 4], 'chequer', 'paint_er', 'open', 1.2, [0.3, 0.6], { legacy: 'engine', kit: 'machinery_room', acoustic: 'engine', name: 'Thruster room' }),
  emerg_gen: S(4, 12, 40, [2.4, 4], 'chequer', 'paint_grey', 'open', 1.2, [0.3, 0.6], { legacy: 'store', kit: 'machinery_room', acoustic: 'engine', name: 'Emergency generator room' }),
  co2_room: S(4, 12, 40, [2.4, 4], 'chequer', 'paint_grey', 'open', 1.2, [0.3, 0.6], { legacy: 'store', kit: 'co2_room', acoustic: 'workshop', name: 'CO₂ room' }),
  fan_room: S(3, 8, 20, [2.2, 2.6], 'chequer', 'paint_grey', 'open', 1.2, [0.3, 0.6], { legacy: 'store', kit: 'fan_room', acoustic: 'workshop', name: 'Fan room' }),
  ac_room: S(3, 10, 24, [2.2, 2.6], 'chequer', 'paint_grey', 'open', 1.2, [0.3, 0.6], { legacy: 'store', kit: 'ac_room', acoustic: 'workshop', name: 'Air-conditioning plant' }),
  bosun_store: S(6, 15, 400, [2.0, 6], 'chequer', 'paint_grey', 'open', 1.2, [0.3, 0.6], { legacy: 'store', kit: 'bosun_store', acoustic: 'workshop', name: 'Bosun store' }),
  paint_locker: S(3, 8, 30, [2.0, 4], 'chequer', 'paint_grey', 'open', 1.2, [0.3, 0.6], { legacy: 'store', kit: 'bosun_store', acoustic: 'workshop', name: 'Paint locker' }),
  linen: S(2.5, 5, 12, [2.2, 2.2], 'vinyl', 'laminate', 'panel', 0.8, [0.35, 0.65], { legacy: 'store', kit: 'store', acoustic: 'wet', name: 'Linen locker', inner: ['laundry', 'cabin_lobby', 'linen', 'store_gen'] }),
  bonded_store: S(3, 6, 14, [2.2, 2.2], 'chequer', 'paint_grey', 'panel', 0.8, [0.35, 0.65], { legacy: 'store', kit: 'store', acoustic: 'wet', name: 'Bonded store' }),
  store_gen: S(3, 8, 18, [2.2, 2.2], 'chequer', 'paint_grey', 'panel', 0.8, [0.35, 0.65], { legacy: 'store', kit: 'store', acoustic: 'wet', name: 'Store', inner: ['*'] }),
  lobby_pax: S(20, 45, 120, [2.6, 3.0], 'carpet_pax', 'veneer', 'panel', 2.5, [0.12, 0.5], { legacy: 'stairs', kit: 'lobby_pax', acoustic: 'public', name: 'Lobby' }),
  atrium: S(40, 120, 1200, [2.6, 12], 'stone', 'veneer', 'feature', 4.0, [0.03, 0.5], { legacy: 'mess', kit: 'atrium', acoustic: 'public', name: 'Atrium' }),
  restaurant: S(40, 200, 450, [2.7, 3.0], 'carpet_pax', 'veneer', 'coffered', 1.8, [0.3, 0.5], { legacy: 'mess', kit: 'restaurant', acoustic: 'public', name: 'Restaurant' }),
  buffet: S(40, 200, 450, [2.7, 2.7], 'vinyl', 'laminate', 'panel', 1.8, [0.3, 0.5], { legacy: 'mess', kit: 'restaurant', acoustic: 'public', name: 'Buffet' }),
  cafeteria: S(30, 150, 450, [2.7, 2.7], 'vinyl', 'laminate', 'panel', 1.8, [0.3, 0.5], { legacy: 'mess', kit: 'restaurant', acoustic: 'public', name: 'Cafeteria' }),
  bar: S(25, 100, 350, [2.6, 3.0], 'carpet_pax', 'veneer', 'coffered', 2.0, [0.25, 0.45], { legacy: 'mess', kit: 'bar', acoustic: 'public', name: 'Bar' }),
  lounge_pax: S(25, 150, 350, [2.6, 3.0], 'carpet_pax', 'veneer', 'coffered', 2.0, [0.25, 0.45], { legacy: 'mess', kit: 'bar', acoustic: 'public', name: 'Lounge' }),
  casino: S(40, 150, 350, [2.6, 3.0], 'carpet_pax', 'veneer', 'coffered', 2.0, [0.25, 0.45], { legacy: 'mess', kit: 'casino', acoustic: 'public', name: 'Casino' }),
  nightclub: S(40, 150, 350, [2.6, 3.0], 'carpet_pax', 'veneer', 'coffered', 2.0, [0.25, 0.45], { legacy: 'mess', kit: 'bar', acoustic: 'public', name: 'Nightclub' }),
  theatre: S(80, 400, 900, [2.6, 9], 'carpet', 'veneer_dark', 'dark', 1.2, [0.55, 0.9], { legacy: 'mess', kit: 'theatre', acoustic: 'public', name: 'Theatre' }),
  shop: S(20, 60, 150, [2.7, 2.7], 'stone', 'laminate', 'panel', 1.4, [0.3, 0.55], { legacy: 'mess', kit: 'shop', acoustic: 'public', name: 'Shop' }),
  seats_lounge: S(30, 150, 400, [2.5, 2.5], 'carpet_pax', 'laminate', 'panel', 1.2, [0.45, 0.65], { legacy: 'mess', kit: 'seats_lounge', acoustic: 'public', name: 'Seating lounge' }),
  kids: S(30, 80, 200, [2.6, 2.6], 'rubber', 'laminate', 'panel', 1.6, [0.25, 0.5], { legacy: 'mess', kit: 'kids', acoustic: 'public', name: 'Kids club' }),
  spa: S(30, 80, 200, [2.6, 2.6], 'tile_wet', 'laminate', 'panel', 1.6, [0.25, 0.5], { legacy: 'mess', kit: 'spa', acoustic: 'public', name: 'Spa' }),
  medical_pax: S(20, 60, 200, [2.6, 2.6], 'vinyl', 'laminate', 'panel', 1.6, [0.25, 0.5], { legacy: 'cabin', kit: 'medical_pax', acoustic: 'cabin', name: 'Medical centre' }),
  wc_block: S(4, 10, 40, [2.3, 2.3], 'tile_wet', 'tile_wet', 'panel', 0.8, [0.35, 0.6], { legacy: 'store', kit: 'washroom', acoustic: 'wet', name: 'Toilets' }),
  saloon_yacht: S(12, 30, 70, [2.1, 2.4], 'wood', 'veneer', 'panel', 1.4, [0.3, 0.5], { legacy: 'mess', kit: 'saloon_yacht', acoustic: 'mess', name: 'Saloon' }),
  skylounge: S(12, 30, 70, [2.1, 2.4], 'carpet', 'veneer', 'panel', 1.4, [0.3, 0.5], { legacy: 'mess', kit: 'saloon_yacht', acoustic: 'mess', name: 'Sky lounge' }),
  galley_yacht: S(4, 8, 18, [2.0, 2.2], 'tile_wet', 'veneer', 'panel', 0.8, [0.4, 0.65], { legacy: 'mess', kit: 'galley', acoustic: 'galley', name: 'Galley' }),
  head: S(1.6, 2.4, 4, [2.0, 2.2], 'tile_wet', 'veneer', 'panel', 0.5, [0.4, 0.65], { legacy: 'store', kit: 'washroom', acoustic: 'wet', name: 'Head' }),
  wheelhouse_small: S(3, 10, 60, [2.0, 2.2], 'vinyl_dark', 'laminate', 'panel', 1.2, [0.25, 0.45], { legacy: 'bridge', kit: 'wheelhouse_small', acoustic: 'bridge', name: 'Wheelhouse' }),
  lab: S(8, 20, 60, [2.25, 2.25], 'vinyl', 'laminate', 'panel', 1.2, [0.3, 0.55], { legacy: 'store', kit: 'lab', acoustic: 'workshop', name: 'Laboratory' }),
  // ---- cruise ships (docs/CRUISE-CONTRACT.md §4): bigger staterooms, public street and decks, crew service spaces
  cabin_cruise_suite: S(28, 38, 64, [2.35, 2.5], 'carpet', 'veneer', 'panel', 1.4, [0.22, 0.42], { legacy: 'cabin', kit: 'cabin_pax', acoustic: 'cabin', name: 'Suite', berth: 2, suite: true }),
  cabin_cruise_acc: S(18, 22, 28, [2.35, 2.45], 'carpet', 'veneer', 'panel', 1.2, [0.25, 0.45], { legacy: 'cabin', kit: 'cabin_pax', acoustic: 'cabin', name: 'Accessible stateroom', berth: 2, access: true }),
  promenade: S(30, 200, 1600, [2.6, 3.4], 'stone', 'veneer', 'coffered', 3.6, [0.04, 0.35], { legacy: 'mess', kit: 'street', acoustic: 'public', name: 'Promenade', circulation: true }),
  atrium_gallery: S(15, 90, 420, [2.6, 3.4], 'stone', 'veneer', 'coffered', 3.2, [0.04, 0.35], { legacy: 'mess', kit: 'gallery', acoustic: 'public', name: 'Atrium gallery' }),
  theatre_balcony: S(50, 250, 650, [2.6, 6.8], 'carpet', 'veneer_dark', 'dark', 1.2, [0.5, 0.9], { legacy: 'mess', kit: 'theatre_balcony', acoustic: 'public', name: 'Theatre balcony' }),
  galley_pax: S(30, 200, 800, [2.4, 3.2], 'quarry', 'stainless', 'panel', 1.6, [0.32, 0.6], { legacy: 'mess', kit: 'galley_pax', acoustic: 'galley', name: 'Galley' }),
  guest_services: S(20, 70, 170, [2.6, 3.0], 'stone', 'veneer', 'coffered', 1.8, [0.08, 0.4], { legacy: 'mess', kit: 'guest_services', acoustic: 'public', name: 'Guest services' }),
  cafe: S(40, 100, 220, [2.6, 3.0], 'carpet_pax', 'veneer', 'coffered', 1.8, [0.25, 0.5], { legacy: 'mess', kit: 'cafe', acoustic: 'public', name: 'Café' }),
  art_gallery: S(40, 100, 200, [2.6, 3.0], 'stone', 'veneer', 'panel', 1.8, [0.1, 0.4], { legacy: 'mess', kit: 'art_gallery', acoustic: 'public', name: 'Art gallery' }),
  arcade: S(50, 130, 220, [2.6, 3.0], 'carpet_pax', 'veneer_dark', 'dark', 1.8, [0.3, 0.55], { legacy: 'mess', kit: 'arcade', acoustic: 'public', name: 'Arcade' }),
  card_room: S(30, 90, 160, [2.6, 3.0], 'carpet_pax', 'veneer', 'coffered', 1.6, [0.25, 0.5], { legacy: 'mess', kit: 'card_room', acoustic: 'public', name: 'Card room' }),
  library_pax: S(50, 130, 240, [2.6, 3.0], 'carpet_pax', 'veneer', 'coffered', 1.8, [0.25, 0.5], { legacy: 'mess', kit: 'library_pax', acoustic: 'public', name: 'Library' }),
  cinema: S(80, 210, 320, [2.6, 4.0], 'carpet', 'veneer_dark', 'dark', 1.4, [0.45, 0.8], { legacy: 'mess', kit: 'cinema', acoustic: 'public', name: 'Cinema' }),
  gym_pax: S(80, 330, 480, [2.6, 3.0], 'rubber', 'laminate', 'panel', 1.8, [0.25, 0.5], { legacy: 'mess', kit: 'gym_pax', acoustic: 'public', name: 'Fitness centre' }),
  ice_rink: S(150, 420, 520, [3.0, 7.0], 'tile_wet', 'laminate', 'panel', 6.5, [0.01, 0.2], { legacy: 'mess', kit: 'ice_rink', acoustic: 'public', name: 'Ice rink', exempt: true }),
  store_large: S(12, 60, 220, [2.3, 3.0], 'chequer', 'paint_grey', 'panel', 1.6, [0.3, 0.6], { legacy: 'store', kit: 'store_large', acoustic: 'workshop', name: 'Store' }),
  laundry_pax: S(40, 120, 300, [2.4, 3.0], 'vinyl', 'laminate', 'panel', 1.6, [0.3, 0.55], { legacy: 'store', kit: 'laundry_pax', acoustic: 'wet', name: 'Laundry' }),
  crew_mess: S(40, 180, 400, [2.4, 3.0], 'vinyl', 'laminate', 'panel', 1.8, [0.28, 0.5], { legacy: 'mess', kit: 'crew_mess', acoustic: 'mess', name: 'Crew mess' }),
  crew_bar: S(30, 100, 220, [2.4, 3.0], 'carpet', 'veneer', 'panel', 1.8, [0.25, 0.5], { legacy: 'mess', kit: 'crew_bar', acoustic: 'mess', name: 'Crew bar' }),
  conference_pax: S(40, 130, 260, [2.5, 3.2], 'carpet', 'laminate', 'panel', 1.6, [0.25, 0.5], { legacy: 'mess', kit: 'conference_pax', acoustic: 'mess', name: 'Conference room' }),
  medical_ward: S(40, 120, 220, [2.5, 3.0], 'vinyl', 'laminate', 'panel', 1.6, [0.25, 0.5], { legacy: 'cabin', kit: 'medical_pax', acoustic: 'cabin', name: 'Medical centre', berth: 1 }),
  workshop_pax: S(30, 160, 420, [2.8, 3.6], 'epoxy', 'paint_er', 'panel', 1.8, [0.25, 0.5], { legacy: 'store', kit: 'workshop_pax', acoustic: 'workshop', name: 'Workshop' }),
  plant_pax: S(30, 140, 400, [2.8, 3.6], 'chequer', 'paint_grey', 'panel', 1.8, [0.25, 0.5], { legacy: 'store', kit: 'plant_pax', acoustic: 'engine', name: 'Plant room' }),
  office_pax: S(30, 90, 220, [2.4, 3.0], 'vinyl', 'laminate', 'panel', 1.6, [0.25, 0.5], { legacy: 'store', kit: 'office_pax', acoustic: 'cabin', name: 'Office' }),
  pool_deck: S(0, 0, Infinity, [2.4, 2.4], 'teak', 'paint_white', 'open', Infinity, [0, 1], { legacy: 'deck', kit: 'pool_deck', openKit: true, exempt: true, acoustic: 'deck', name: 'Pool deck' }),
  water_deck: S(0, 0, Infinity, [2.4, 2.4], 'teak', 'paint_white', 'open', Infinity, [0, 1], { legacy: 'deck', kit: 'water_deck', openKit: true, exempt: true, acoustic: 'deck', name: 'Water park' }),
  sports_deck: S(0, 0, Infinity, [2.4, 2.4], 'teak', 'paint_white', 'open', Infinity, [0, 1], { legacy: 'deck', kit: 'sports_deck', openKit: true, exempt: true, acoustic: 'deck', name: 'Sports deck' }),
  sun_deck: S(0, 0, Infinity, [2.4, 2.4], 'teak', 'paint_white', 'open', Infinity, [0, 1], { legacy: 'deck', kit: 'sun_deck', openKit: true, exempt: true, acoustic: 'deck', name: 'Sun deck' }),
  cargo: S(0, 0, Infinity, [2, 30], 'steel', 'paint_grey', 'open', Infinity, [0, 1], { legacy: 'store', kit: null, acoustic: 'hold', name: 'Cargo space', exempt: true }),
  open_deck: S(0, 0, Infinity, [2.4, 2.4], 'deck', 'paint_white', 'open', Infinity, [0, 1], { legacy: 'deck', kit: null, acoustic: 'deck', name: 'Open deck', exempt: true }),
});
export const SPACE_KINDS = Object.freeze(Object.keys(SCALE));

// ------------------------------------------------------------------------------------------------ block programmes
/** Space kinds preferred for a GA block of this use on a tier with this role (first = primary). */
function prefsFor(use, kind, role) {
  switch (use) {
    case 'cabin': return role === 'ratings' ? ['cabin_rating', 'cabin_officer', 'cabin_super', 'store_gen', 'linen'] : role === 'seniors' ? ['cabin_officer', 'suite_day', 'suite_bed', 'cabin_super', 'store_gen'] : ['cabin_officer', 'cabin_super', 'cabin_rating', 'suite_day', 'suite_bed', 'store_gen'];
    case 'dayroom': case 'owner': return ['suite_day', 'suite_bed', 'cabin_officer', 'pantry', 'store_gen'];
    case 'spare':
      if (role === 'nav') return ['chartroom', 'radio_room', 'cabin_pilot', 'office', 'battery', 'pantry', 'store_gen'];
      if (kind === 'mess') return ['recreation', 'library', 'lounge_crew', 'conference', 'gym'];
      if (kind === 'store') return role === 'service' ? ['ac_room', 'fan_room', 'co2_room', 'bonded_store', 'linen', 'paint_locker', 'smoke_room', 'conference', 'store_gen'] : ['bonded_store', 'linen', 'store_gen', 'ac_room', 'fan_room', 'office', 'conference'];
      return role === 'ratings' ? ['cabin_rating', 'cabin_super', 'linen', 'library', 'store_gen'] : ['cabin_officer', 'cabin_super', 'cabin_pilot', 'office', 'library', 'conference', 'suite_day', 'suite_bed', 'linen', 'store_gen'];
    case 'mess': case 'dining': return ['mess', 'pantry', 'lounge_crew', 'smoke_room', 'store_gen'];
    case 'galley': return ['galley', 'provisions_dry', 'cold_room', 'pantry'];
    case 'provisions': return ['provisions_dry', 'cold_room', 'store_gen'];
    case 'cold': return ['cold_room', 'provisions_dry'];
    case 'changing': return ['changing_er', 'drying_room', 'laundry', 'store_gen'];
    case 'office': return ['office', 'cargo_office', 'conference', 'store_gen'];
    case 'laundry': return ['laundry', 'drying_room', 'linen', ...(role === 'ratings' ? ['cabin_rating'] : role === 'service' ? [] : ['cabin_officer']), 'store_gen'];
    case 'hospital': return ['hospital', 'hospital_bath', 'office', 'linen', 'store_gen'];
    case 'gym': return ['gym', 'recreation', 'changing_er', 'store_gen'];
    case 'recreation': case 'lounge': case 'saloon': return ['recreation', 'lounge_crew', 'library', 'smoke_room', 'conference', 'store_gen'];
    case 'electronics': return role === 'nav' ? ['electronics', 'battery', 'radio_room', 'chartroom', 'cabin_pilot', 'office', 'wc_room', 'pantry', 'store_gen'] : ['electronics', 'battery', 'radio_room', 'store_gen'];
    case 'wc': return role === 'nav' ? ['wc_room', 'pantry', 'battery', 'cabin_pilot', 'store_gen'] : ['wc_room', 'linen', 'store_gen'];
    case 'store': return role === 'nav' ? ['store_gen', 'chartroom', 'cabin_pilot', 'office', 'pantry', 'battery'] : ['store_gen', 'linen', 'bonded_store', 'paint_locker', 'ac_room'];
    case 'ccr': return ['ccr', 'cargo_office', 'office'];
    default: return null;
  }
}
const KEEP = new Set(['corridor', 'entrance', 'stairs', 'casing', 'er_entrance', 'bridge', 'aftbridge', 'winch', 'lab']);
const WMIN = { cabin_rating: 2.35, cabin_officer: 2.55, cabin_super: 2.45, cabin_pilot: 2.35, suite_bed: 2.7, suite_day: 2.9, mess: 2.8, galley: 2.4, gym: 2.8, recreation: 2.8, lounge_crew: 2.8, library: 2.2, conference: 2.6, office: 2.2, cargo_office: 2.2, ccr: 3.0, hospital: 2.6 };
const wmin = (k) => WMIN[k] ?? 1.6;
/** the shorter side a space needs (a bunk is 2.0 long, a mess table needs its benches) */
const dmin = (k) => (SCALE[k].berth ? 2.3 : ['mess', 'suite_day', 'gym', 'recreation', 'lounge_crew', 'conference', 'ccr', 'galley'].includes(k) ? 2.5 : k === 'cabin_lobby' ? 1.2 : 1.5);
const DEPTH_MIN = 1.6;

/** Area misfit of a leaf kind: 0 inside [min, max] near the target; grows outside. Cabins measure without the wet unit. */
export function wetRange(kind) { const w = SCALE[kind]?.wet; return w ? (Array.isArray(w) ? w : [w, w]) : [0, 0]; }
/** Net floor (without the en-suite wet unit, sized within its range to fit) and whether it is inside [min, max]. */
export function netArea(kind, area) {
  const s = SCALE[kind], [wl, wh] = wetRange(kind);
  const hi = area - wl, lo = area - wh;
  const net = clamp(s.target, lo, hi);
  return { net, ok: hi >= s.min * 0.97 - 0.01 && lo <= s.max * 1.03 + 0.01 };
}
function misfit(kind, area) {
  const s = SCALE[kind], [wl, wh] = wetRange(kind);
  const hi = area - wl, lo = area - wh;
  if (hi < s.min * 0.97) return 6 + (s.min - hi) * 3;
  if (lo > s.max * 1.03) return 6 + (lo - s.max) * 2;
  return Math.abs(clamp(s.target, lo, hi) - s.target) / Math.max(1, s.target);
}
const UNIQUE = { galley: 1, hospital: 1, gym: 1, ccr: 1, laundry: 1, changing_er: 1, mess: 2, suite_day: 1, suite_bed: 1, hospital_bath: 1, drying_room: 1, pantry: 1, recreation: 1, electronics: 1, battery: 1, radio_room: 1, chartroom: 1, library: 1, conference: 1, office: 1, cabin_pilot: 1, wc_room: 1, ac_room: 1, fan_room: 1, co2_room: 1, bonded_store: 1, paint_locker: 1, smoke_room: 1, linen: 2, cold_room: 3, provisions_dry: 2 };

// ------------------------------------------------------------------------------------------------ block recut search
/**
 * Re-cut one block. Local frame: u along the door wall (0..W), v away from it (0..D, v = 0 is the corridor wall).
 * front = [f0, f1] the stretch of the door wall that opens onto circulation. prefs: kinds in order of preference.
 * Returns leaves [{ u0, u1, v0, v1, kind, door: { wall: 'front' | leafIndex, at } }] or null.
 */
function recut(W, D, f0, f1, prefs, maxLeaves = 6) {
  const primary = prefs[0];
  const isBerth = (k) => !!SCALE[k].berth && k !== 'hospital';
  const berthy = isBerth(primary);
  const FREE_DOOR = new Set(['battery', 'pantry', 'linen', 'store_gen', 'provisions_dry', 'cold_room', 'bonded_store', 'drying_room', 'office', 'library', 'conference']);
  const doorKinds = prefs.filter((k, i) => i === 0 || !SCALE[k].inner || FREE_DOOR.has(k));
  if (prefs.some(isBerth)) doorKinds.push('cabin_lobby');
  /** cost of one leaf: area misfit + preference rank + repeats of unique spaces + berths replaced by stores */
  const cost = (k, a, used) => {
    let c = misfit(k, a) + (k === primary ? 0 : k === 'cabin_lobby' ? 0.45 : 0.6 + Math.max(0, prefs.indexOf(k)) * 0.15);
    if (berthy && !isBerth(k) && k !== 'cabin_lobby') c += 2.5;
    if (UNIQUE[k] && (used[k] || 0) >= UNIQUE[k]) c += 3;
    return c;
  };
  const pickDoor = (a, w, d, used) => { let bk = null, bs = Infinity; for (const k of doorKinds) { if (w < (k === 'cabin_lobby' ? 1.2 : wmin(k)) || d < Math.max(DEPTH_MIN, dmin(k)) || Math.min(w, d) < dmin(k)) continue; const c = cost(k, a, used); if (c < bs) { bs = c; bk = k; } } return bk ? { k: bk, c: bs } : null; };
  const pickInner = (host, a, w, d, used) => {
    let bk = null, bs = Infinity;
    const cands = host === 'cabin_lobby' ? prefs.filter(isBerth).concat(prefs.filter((k) => !isBerth(k))) : prefs;
    for (const k of cands) {
      const inn = SCALE[k].inner;
      if (!(host === 'cabin_lobby' && isBerth(k)) && !(inn && (inn.includes(host) || inn.includes('*')))) continue;
      if (w < Math.min(1.6, wmin(k)) || d < DEPTH_MIN || Math.min(w, d) < dmin(k)) continue;
      const c = cost(k, a, used); if (c < bs) { bs = c; bk = k; }
    }
    return bk ? { k: bk, c: bs } : null;
  };
  const best = { score: Infinity, leaves: null };
  const consider = (leaves) => {
    let sc = 0; const used = {};
    for (const l of leaves) { sc += cost(l.kind, (l.u1 - l.u0) * (l.v1 - l.v0), used); used[l.kind] = (used[l.kind] || 0) + 1; }
    if (!leaves.some((l) => l.kind === primary)) sc += 4;
    if (used.cabin_lobby && !leaves.some((l) => l.door.wall !== 'front' && isBerth(l.kind))) sc += 5;   // a lobby serves cabins
    if ((used.suite_day || 0) > (used.suite_bed || 0) && primary !== 'suite_day') sc += 2;                // a day room comes with its bedroom
    if (used.suite_bed && !used.suite_day) sc += 5;
    sc += leaves.length * 0.05 + leaves.filter((l) => l.v0 > 0).length * 0.2;
    if (sc < best.score - 1e-9) { best.score = sc; best.leaves = leaves; }
  };
  const front = (u0, u1) => Math.min(u1, f1) - Math.max(u0, f0);
  const cutsFor = (n) => {
    const out = [];
    const even = []; for (let i = 0; i <= n; i++) even.push((W * i) / n); out.push(even);
    if (n >= 2) for (const c of [f0, f1]) if (c > 1.0 && c < W - 1.0) {
      if (n === 2) out.push([0, c, W]);
      else { const rest = n - 1; const a = [0, c]; for (let i = 1; i <= rest; i++) a.push(c + ((W - c) * i) / rest); out.push(a); const b = []; for (let i = 0; i < rest; i++) b.push((c * i) / rest); b.push(c, W); out.push(b); }
    }
    if (n === 3 && f1 - f0 >= 1.2 && f1 - f0 <= 2.8 && f0 > 2.2 && W - f1 > 2.2) out.push([0, f0, f1, W]);   // a lobby strip in the middle
    return out;
  };
  for (let n = 1; n <= maxLeaves; n++) {
    if (W / n < 1.2) break;
    for (const cuts of cutsFor(n)) {
      const strips = []; for (let i = 0; i < n; i++) strips.push({ u0: cuts[i], u1: cuts[i + 1] });
      if (strips.some((q) => q.u1 - q.u0 < 1.2)) continue;
      const hasFront = strips.map((q) => front(q.u0, q.u1) >= 1.0);
      if (!hasFront.some(Boolean)) continue;
      for (const deep of [false, true]) {
        if (deep && D < 2 * DEPTH_MIN + 0.4) continue;
        const used = {}; const leaves = []; let ok = true;
        for (let i = 0; i < n && ok; i++) {
          const q = strips[i], w = q.u1 - q.u0;
          if (!hasFront[i]) { leaves.push(null); continue; }
          let opt = null;
          const full = pickDoor(w * D, w, D, used);
          if (full) opt = { c: full.c, ls: [{ ...q, v0: 0, v1: D, kind: full.k, door: { wall: 'front' } }] };
          if (deep) for (const dv of [1.6, 1.9, 2.2, 2.6, D * 0.4, D * 0.5, D - 3.6, D - 3.0, D - 2.4]) {
            if (dv < DEPTH_MIN - 1e-6 || D - dv < DEPTH_MIN) continue;
            for (const fk of doorKinds) {
              if (w < (fk === 'cabin_lobby' ? 1.2 : wmin(fk)) || Math.min(w, dv) < dmin(fk)) continue;
              const fc = cost(fk, w * dv, used); if (!Number.isFinite(fc)) continue;
              const u2 = { ...used, [fk]: (used[fk] || 0) + 1 };
              const bk = pickInner(fk, w * (D - dv), w, D - dv, u2); if (!bk) continue;
              const c = fc + bk.c + 0.2;
              if (!opt || c < opt.c) opt = { c, ls: [{ ...q, v0: 0, v1: dv, kind: fk, door: { wall: 'front' } }, { ...q, v0: dv, v1: D, kind: bk.k, door: { wall: 'back' } }] };
            }
          }
          if (!opt) { ok = false; break; }
          for (const l of opt.ls) used[l.kind] = (used[l.kind] || 0) + 1;
          leaves.push(opt.ls);
        }
        if (!ok) continue;
        // strips without frontage: inner rooms of a neighbour's full-depth (or front) leaf, through the side wall
        for (let i = 0; i < n && ok; i++) {
          if (leaves[i]) continue;
          const q = strips[i], w = q.u1 - q.u0;
          let pick = null;
          for (const hi of [i - 1, i + 1]) {
            if (hi < 0 || hi >= n || !leaves[hi]) continue;
            const host = leaves[hi][0];
            if (host.v1 < D - 0.01 && D - host.v1 > 0.01 && leaves[hi].length > 1 && host.kind !== 'cabin_lobby') continue;
            const bk = pickInner(host.kind, w * D, w, D, used); if (!bk) continue;
            if (!pick || bk.c < pick.c) pick = { ...bk, hi };
          }
          if (!pick) { ok = false; break; }
          used[pick.k] = (used[pick.k] || 0) + 1;
          leaves[i] = [{ ...q, v0: 0, v1: D, kind: pick.k, door: { wall: 'side', hostStrip: pick.hi } }];
        }
        if (!ok) continue;
        // flatten with host indices
        const flat = [], first = [];
        leaves.forEach((ls) => { first.push(flat.length); for (const l of ls) flat.push({ ...l }); });
        leaves.forEach((ls, i) => { ls.forEach((l, j) => { const f = flat[first[i] + j]; if (l.door.wall === 'back') f.door = { wall: 'back', host: first[i] }; else if (l.door.wall === 'side') f.door = { wall: first[l.door.hostStrip] }; }); });
        consider(flat);
      }
    }
  }
  return best.leaves;
}
// cabin lobbies serving two cabins: a corridor-side lobby across the block, two inner cabins behind it
function recutLobbyPair(W, D, prefs) {
  const out = [];
  for (const dv of [1.6, 1.9, 2.2]) {
    if (D - dv < 2.6 || W < 2 * 2.35) continue;
    for (const k of ['cabin_rating', 'cabin_officer']) {
      if (!prefs.includes(k)) continue;
      const a = (W / 2) * (D - dv);
      out.push({ s: misfit(k, a) * 2 + misfit('cabin_lobby', W * dv) * 0.5 + 0.3, leaves: [{ u0: 0, u1: W, v0: 0, v1: dv, kind: 'cabin_lobby', door: { wall: 'front' } }, { u0: 0, u1: W / 2, v0: dv, v1: D, kind: k, door: { wall: 'back', host: 0 } }, { u0: W / 2, u1: W, v0: dv, v1: D, kind: k, door: { wall: 'back', host: 0 } }] });
    }
  }
  out.sort((a, b) => a.s - b.s);
  return out[0] || null;
}

const SHIP_ONCE = { co2_room: 1, ac_room: 1, fan_room: 2, bonded_store: 1, paint_locker: 1, smoke_room: 1, conference: 1, library: 1, chartroom: 1, radio_room: 1, electronics: 1, battery: 1, wc_room: 3, cabin_pilot: 2, gym: 1, recreation: 2, hospital_bath: 1, drying_room: 2, laundry: 2, office: 3, cargo_office: 1, lounge_crew: 2 };
const TIER_ONCE = { pantry: 1, linen: 1 };
const blockCache = new Map();
/** Solve a block (cached by its geometry and programme — §3.3 template cache). */
export function solveBlock(W, D, f0, f1, prefs) {
  const key = `${W.toFixed(2)}|${D.toFixed(2)}|${f0.toFixed(2)}|${f1.toFixed(2)}|${prefs.join(',')}`;
  if (blockCache.has(key)) return blockCache.get(key);
  let leaves = recut(W, D, f0, f1, prefs);
  const score = (ls) => ls ? ls.reduce((s, l) => s + misfit(l.kind, (l.u1 - l.u0) * (l.v1 - l.v0)) + (SCALE[prefs[0]].berth && !SCALE[l.kind].berth && l.kind !== 'cabin_lobby' ? 2.5 : 0), 0) + ls.length * 0.05 + (ls.some((l) => l.kind === prefs[0]) ? 0 : 4) : Infinity;
  const lp = f1 - f0 >= 1.0 ? recutLobbyPair(W, D, prefs) : null;
  if (lp && score(lp.leaves) + 0.3 < score(leaves)) leaves = lp.leaves;
  const out = leaves ? Object.freeze(leaves.map((l) => Object.freeze({ ...l, door: Object.freeze({ ...l.door }) }))) : null;
  blockCache.set(key, out);
  return out;
}

// ------------------------------------------------------------------------------------------------ the house
const r2 = (v) => Math.round(v * 100) / 100;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const OPP = { n: 's', s: 'n', e: 'w', w: 'e' };

/** Role of each house tier: service (galley / messes), ratings, officers, seniors (day rooms), nav (bridge deck). */
export function tierRoles(ga) {
  const tiers = ga.house?.tiers || [];
  const ratings = ga.crew?.ratings ?? 0;
  let count = 0;
  return tiers.map((t) => {
    if (t.id === 'nav' || t.rooms.some((r) => r.kind === 'bridge')) return 'nav';
    const uses = new Set(t.rooms.map((r) => r.use));
    if (uses.has('dayroom') || uses.has('owner')) return 'seniors';
    if (uses.has('galley')) { for (const r of t.rooms) if (r.use === 'cabin') count += r.berth || 1; return 'service'; }
    const cab = t.rooms.filter((r) => r.use === 'cabin');
    const before = count; for (const r of cab) count += r.berth || 1;
    return cab.length && before < ratings ? 'ratings' : 'officers';
  });
}

/**
 * The spaces that replace each re-cut GA room of the house: Map(gaRoomId → { block, leaves: [Space-like rects with
 * kind, door { to: gaCorridorId | leafId, side, at, w }, windows }]). Pure; cached per variant.
 */
const houseCache = new Map();
export function houseSpaces(ga) {
  if (!ga?.house) return new Map();
  if (houseCache.has(ga.id)) return houseCache.get(ga.id);
  const out = new Map(), roles = tierRoles(ga), H = ga.house;
  const shipUsed = {};
  H.tiers.forEach((t, ti) => {
    const role = roles[ti];
    const tierUsed = {};
    const byId = new Map(t.rooms.map((r) => [r.id, r]));
    for (const q of t.rooms) {
      if (KEEP.has(q.use) || q.walk === false || q.kind === 'passage' || q.kind === 'stairs' || q.kind === 'bridge') continue;
      const base = prefsFor(q.use, q.kind, role); if (!base) continue;
      // one-off spaces (CO₂ room, AC plant, chart room, gym …) once per ship / per tier; the block's own use stays first
      const keep0 = q.use !== 'spare' && q.use !== 'store';
      const prefs = base.filter((k, i) => (i === 0 && keep0) || !((SHIP_ONCE[k] && (shipUsed[k] || 0) >= SHIP_ONCE[k]) || (TIER_ONCE[k] && (tierUsed[k] || 0) >= TIER_ONCE[k])));
      if (!q.doors || q.doors.length !== 1) continue;
      const d0 = q.doors[0], corr = byId.get(d0.to); if (!corr) continue;
      const side = d0.side, ns = side === 'n' || side === 's';
      // local frame: u along the door wall (west → east for n/s, north → south for e/w), v from the door wall inward
      const W = ns ? q.x1 - q.x0 : q.z1 - q.z0, D = ns ? q.z1 - q.z0 : q.x1 - q.x0;
      const a0 = ns ? q.x0 : q.z0;
      const c0 = ns ? corr.x0 : corr.z0, c1 = ns ? corr.x1 : corr.z1;
      // frontage: where the corridor meets this wall (and any other passage of the tier on the same wall)
      let f0 = Math.max(0, c0 - a0), f1 = Math.min(W, c1 - a0);
      const segs = [{ g0: f0, g1: f1, id: corr.id }];
      const wallC = { n: q.z0, s: q.z1, w: q.x0, e: q.x1 }[side];
      for (const o of t.rooms) {
        if (o === corr || o.kind !== 'passage') continue;
        const oc = { n: o.z1, s: o.z0, w: o.x1, e: o.x0 }[side];
        if (Math.abs(oc - wallC) > 0.02) continue;
        const g0 = Math.max(0, (ns ? o.x0 : o.z0) - a0), g1 = Math.min(W, (ns ? o.x1 : o.z1) - a0);
        if (g1 - g0 > 0.5 && (Math.abs(g0 - f1) < 0.05 || Math.abs(g1 - f0) < 0.05)) { f0 = Math.min(f0, g0); f1 = Math.max(f1, g1); segs.push({ g0, g1, id: o.id }); }
      }
      if (f1 - f0 < 1.0) continue;
      if (!prefs.includes('store_gen')) prefs.push('store_gen');
      const leaves = solveBlock(r2(W), r2(D), r2(f0), r2(f1), prefs);
      if (!leaves) continue;
      for (const l of leaves) { shipUsed[l.kind] = (shipUsed[l.kind] || 0) + 1; tierUsed[l.kind] = (tierUsed[l.kind] || 0) + 1; }
      // back to ship coordinates
      const toRect = (l) => {
        if (side === 'n') return { x0: q.x0 + l.u0, x1: q.x0 + l.u1, z0: q.z0 + l.v0, z1: q.z0 + l.v1 };
        if (side === 's') return { x0: q.x0 + l.u0, x1: q.x0 + l.u1, z0: q.z1 - l.v1, z1: q.z1 - l.v0 };
        if (side === 'w') return { x0: q.x0 + l.v0, x1: q.x0 + l.v1, z0: q.z0 + l.u0, z1: q.z0 + l.u1 };
        return { x0: q.x1 - l.v1, x1: q.x1 - l.v0, z0: q.z0 + l.u0, z1: q.z0 + l.u1 };
      };
      const spaces = leaves.map((l, i) => {
        const rc = toRect(l); for (const k of ['x0', 'x1', 'z0', 'z1']) rc[k] = r2(rc[k]);
        return { id: i === 0 ? q.id : `${q.id}.${i}`, kind: l.kind, ...rc, l, gaUse: q.use, tier: t.id, role };
      });
      // doors: front leaves onto the corridor within the frontage (cabins: near the end of the strip, wet unit beside it)
      spaces.forEach((s) => {
        const l = s.l, k = SCALE[s.kind];
        const dw = k.berth ? 0.8 : ['mess', 'galley', 'hospital', 'office', 'cargo_office', 'ccr', 'gym', 'recreation', 'lounge_crew', 'conference', 'library'].includes(s.kind) ? 0.9 : 0.8;
        if (l.door.wall === 'front') {
          // the corridor segment that gives this leaf the most frontage
          let seg = segs[0], best = -1;
          for (const g of segs) { const ov = Math.min(l.u1, g.g1) - Math.max(l.u0, g.g0); if (ov > best) { best = ov; seg = g; } }
          const lo = Math.max(l.u0, seg.g0) + dw / 2 + 0.12, hi = Math.min(l.u1, seg.g1) - dw / 2 - 0.12;
          const mid = (l.u0 + l.u1) / 2;
          let at = k.berth || s.kind === 'cabin_lobby' ? (Math.abs(lo - l.u0) < Math.abs(l.u1 - hi) ? lo : hi) : clamp(mid, lo, hi);
          if (hi < lo) at = (Math.max(l.u0, seg.g0) + Math.min(l.u1, seg.g1)) / 2;
          s.door = { to: seg.id, side, at: r2(a0 + at), w: dw, kind: 'door' };
        } else {
          const host = typeof l.door.wall === 'number' ? spaces[l.door.wall] : spaces[l.door.host];
          s.host = host.id;
          if (l.door.wall === 'back') { // through the host's back wall (v = l.v0)
            const lo = l.u0 + dw / 2 + 0.15, hi = l.u1 - dw / 2 - 0.15;
            const hostAt = host.door ? host.door.at - a0 : (host.l.u0 + host.l.u1) / 2;
            const at = clamp(hostAt + ((l.u0 + l.u1) / 2 >= hostAt ? 1.0 : -1.0), lo, hi);
            const dside = { n: 'n', s: 's', w: 'w', e: 'e' }[side];   // the inner room's wall that faces the corridor side
            s.door = { to: host.id, side: dside, at: r2(a0 + at), w: dw, kind: 'door' };
          } else { // through the shared side wall (u = l.u0 or l.u1)
            const shared = host.l.u1 <= l.u0 + 0.01 ? 'lo' : 'hi';
            const dside = ns ? (shared === 'lo' ? 'w' : 'e') : (shared === 'lo' ? 'n' : 's');
            const vlo = l.v0 + dw / 2 + 0.25, vhi = l.v1 - dw / 2 - 0.15;
            const v = clamp(Math.min(vlo + 0.2, vhi), vlo, vhi);
            const at = ns ? (side === 'n' ? q.z0 + v : q.z1 - v) : (side === 'w' ? q.x0 + v : q.x1 - v);
            s.door = { to: host.id, side: dside, at: r2(at), w: dw, kind: 'door' };
          }
        }
        // windows: one per module on the house's outer walls the block had windows on
        s.win = [];
        for (const ws of q.win || []) {
          const onOuter = { n: Math.abs(s.z0 - H.z0) < 0.02, s: Math.abs(s.z1 - H.z1) < 0.02, w: Math.abs(s.x0 - H.x0) < 0.02, e: Math.abs(s.x1 - H.x1) < 0.02 }[ws];
          const onBlock = { n: Math.abs(s.z0 - q.z0) < 0.02, s: Math.abs(s.z1 - q.z1) < 0.02, w: Math.abs(s.x0 - q.x0) < 0.02, e: Math.abs(s.x1 - q.x1) < 0.02 }[ws];
          if (!onOuter || !onBlock) continue;
          const len = ws === 'n' || ws === 's' ? s.x1 - s.x0 : s.z1 - s.z0, from = ws === 'n' || ws === 's' ? s.x0 : s.z0;
          const pub = ['mess', 'recreation', 'lounge_crew', 'gym', 'library', 'conference', 'suite_day', 'ccr'].includes(s.kind);
          const ww = pub ? 1.1 : 1.0, n = pub ? Math.max(1, Math.floor((len - 0.6) / 2.2)) : 1;
          for (let i = 0; i < n; i++) { const c = from + (len * (i + 0.5)) / n; if (len < ww + 0.5) continue; s.win.push({ side: ws, from: r2(c - ww / 2), to: r2(c + ww / 2), bottom: 1.0, top: 1.95, kind: 'window' }); }
        }
      });
      for (const s of spaces) delete s.l;
      out.set(q.id, { block: q, tier: t.id, role, spaces });
    }
  });
  houseCache.set(ga.id, out);
  return out;
}

// ------------------------------------------------------------------------------------------------ SpacePlan
const spCache = new Map();
/** SpacePlan (§9.3) of a variant: the house (corridors, stairs, re-cut spaces, voids) — frozen, cached. */
export function spacePlan(variantId, opts = {}) {
  const key = `${variantId}|${opts.deck ?? ''}`;
  if (spCache.has(key)) return spCache.get(key);
  const ga = generalArrangement(variantId);
  if (!ga || ga.gen === 'sail') { spCache.set(key, null); return null; }
  const params = modelParams(variantId);
  const hs = houseSpaces(ga), H = ga.house;
  const levels = [], rooms = [], doors = [], stairs = [], voids = [];
  if (H) {
    const roles = tierRoles(ga);
    H.tiers.forEach((t, ti) => {
      levels.push({ id: t.id, y: t.y, deckH: t.h, name: t.name, use: roles[ti] });
      for (const q of t.rooms) {
        const rep = hs.get(q.id);
        if (rep) { for (const s of rep.spaces) { rooms.push(spaceOf(s, t, ti)); doors.push({ a: s.id, b: s.door.to, side: s.door.side, at: s.door.at, w: s.door.w, h: 2.0, kind: 'door', leaf: 'swing', sill: SCALE[s.kind].wet ? 0.05 : 0.05, fire: null, auto: true }); } continue; }
        const kind = q.use === 'casing' ? null : q.kind === 'passage' ? (q.use === 'entrance' ? 'entrance' : 'corridor') : q.kind === 'stairs' ? 'stair' : q.kind === 'bridge' ? 'bridge' : q.use === 'er_entrance' ? 'changing_er' : null;
        if (!kind) { voids.push({ id: q.id, level: t.id, x0: q.x0, x1: q.x1, z0: q.z0, z1: q.z1, why: q.use === 'casing' ? 'casing' : 'duct' }); continue; }
        rooms.push(spaceOf({ id: q.id, kind, x0: q.x0, x1: q.x1, z0: q.z0, z1: q.z1, win: (q.win || []).map((side) => ({ side, kind: kind === 'bridge' ? 'bridge' : 'window' })) }, t, ti));
        for (const d of q.doors || []) doors.push({ a: q.id, b: d.to, side: d.side, at: d.at, w: d.w || 0.9, h: 2.0, kind: d.kind || 'door', leaf: d.kind === 'open' ? 'none' : 'swing', sill: 0.05, fire: null, auto: true });
      }
    });
    const C = H.core;
    for (let k = 0; k < H.tiers.length - 1; k++) { const a = H.tiers[k], b = H.tiers[k + 1]; stairs.push({ id: `flight-${a.id}`, x0: C.fx0, x1: C.fx1, z0: C.runZ0, z1: C.runZ1, yLow: a.y, yHigh: b.y, up: 'n', foot: `${a.id}-stairs`, head: `${b.id}-stairs` }); }
  }
  if (ga.pax && ga.type === 'cruise') cruiseSpaces(ga, levels, rooms, doors, stairs, voids);
  const nodes = rooms.map((r) => r.id), ids = new Set(nodes);
  const edges = doors.map((d, i) => [d.a, d.b, i]).filter(([a, b]) => ids.has(a) && ids.has(b));
  const sp = deepFreeze({ v: 1, id: variantId, gen: ga.gen, params, levels, rooms, doors, stairs, links: [], voids, graph: { nodes, edges }, goto: (ga.goto || []).map((g) => ({ ...g })) });
  spCache.set(key, sp);
  return sp;
}
/** Cruise ships: every deck of the layout except the cabin decks that repeat (only the bridge deck's is kept: ~330 rooms). */
function cruiseSpaces(ga, levels, rooms, doors, stairs, voids) {
  const X = ga.pax, keepCabin = X.decks[X.bridgeDeck - 1].id;
  for (const d of X.decks) {
    if (d.use === 'cabin' && d.id !== keepCabin) continue;
    const spec = cruiseDeck(ga, d.id); if (!spec) continue;
    levels.push({ id: d.id, y: d.y, deckH: d.h, name: d.name, use: d.use });
    const F = deckFrame(ga, d.id);
    for (const t of F.towers) {
      const id = `${d.id}-${t.id}`;
      rooms.push(spaceOf({ id, kind: 'stair', x0: t.x0, x1: t.x1, z0: t.z0, z1: t.z1 }, { id: d.id, y: d.y, h: d.h }, 0));
    }
    for (const r of spec.rooms) {
      if (r.walk === false) continue;
      const k = SCALE[r.space]; if (!k) continue;
      const o = spaceOf({ id: r.id, kind: r.space, x0: r.x0, x1: r.x1, z0: r.z0, z1: r.z1, win: r.win }, { id: d.id, y: d.y, h: d.h }, 0);
      rooms.push({ ...o, name: r.name, zone: `deck:${d.id}`, h: r.h ?? o.h });
    }
    for (const dd of spec.doors) if (dd.b) doors.push({ a: dd.a, b: dd.b, side: dd.side, at: dd.at, w: dd.w, h: dd.h || 2.0, kind: dd.kind, leaf: dd.kind === 'open' ? 'none' : 'swing', sill: 0.05, fire: false });
    for (const l of spec.links) doors.push({ a: l.room, b: `${d.id}-${l.tower}`, side: l.end, at: 0, w: 1.4, h: 2.0, kind: 'open', leaf: 'none', sill: 0, fire: false });
    for (const v of spec.voids) voids.push({ id: v.id, level: d.id, x0: v.x0, x1: v.x1, z0: v.z0, z1: v.z1, why: v.why });
  }
  for (let k = 0; k < levels.length - 1; k++) {
    const a = levels[k], b = levels[k + 1];
    stairs.push({ id: `flight-${a.id}`, x0: -1, x1: 1, z0: 0, z1: 1, yLow: a.y, yHigh: b.y, foot: a.id, head: b.id });
  }
}
function spaceOf(s, t, ti) {
  const k = SCALE[s.kind];
  const h = r2(Math.min(t.h - 0.12, k.h[1]));
  return { id: s.id, level: t.id, kind: k.legacy, space: s.kind, name: k.name, x0: s.x0, x1: s.x1, z0: s.z0, z1: s.z1, y: t.y, h, deckH: t.h, lined: k.lined, floor: k.floor, wall: k.wall, ceil: k.ceil, acoustic: k.acoustic, zone: ti === 0 ? 'house' : `house:${ti}`, win: s.win || [], kit: k.kit, kitOpts: {}, role: s.role || null, berth: k.berth || 0, officer: !!k.officer, exempt: [], tags: s.host ? [`host:${s.host}`] : [] };
}
function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; }

/** Score of a SpacePlan (§4.1): lower is better; unreachable / missingMust must be 0. */
export function scoreSpace(sp) {
  const res = { score: 0, waste: 0, voidUnjustified: 0, deadEnds: 0, unreachable: 0, overCap: 0, missingMust: 0, adjacencyMisses: 0, areaMisfit: 0 };
  if (!sp) return res;
  // reachability over the door graph from every level's stairs
  const adj = new Map(sp.rooms.map((r) => [r.id, []]));
  for (const [a, b] of sp.graph.edges) { adj.get(a)?.push(b); adj.get(b)?.push(a); }
  const seen = new Set(), q = sp.rooms.filter((r) => r.space === 'stair').map((r) => r.id);
  for (const id of q) seen.add(id);
  while (q.length) { const id = q.pop(); for (const n of adj.get(id) || []) if (!seen.has(n)) { seen.add(n); q.push(n); } }
  for (const r of sp.rooms) if (!seen.has(r.id) && r.space !== 'bridge') res.unreachable++;
  for (const r of sp.rooms) {
    const k = SCALE[r.space]; if (!k || k.circulation) continue;
    const a = (r.x1 - r.x0) * (r.z1 - r.z0) - wetRange(r.space)[1];
    if (a > k.max + 0.05) res.overCap += a - k.max;
    res.areaMisfit += k.target ? Math.abs(a - k.target) / k.target : 0;
  }
  // waste per level: floor of the house box not in any space, stair or justified void
  for (const lv of sp.levels) {
    const rs = sp.rooms.filter((r) => r.level === lv.id), vs = sp.voids.filter((v) => v.level === lv.id);
    let used = 0; for (const r of rs) used += (r.x1 - r.x0) * (r.z1 - r.z0); for (const v of vs) used += (v.x1 - v.x0) * (v.z1 - v.z0);
    void used;
  }
  const galley = sp.rooms.filter((r) => r.space === 'galley');
  for (const g of galley) if (!sp.rooms.some((r) => (r.space === 'mess' || r.space === 'pantry') && r.level === g.level && touches(r, g))) res.adjacencyMisses++;
  res.score = 100 * res.unreachable + 50 * res.deadEnds + 40 * res.missingMust + 10 * res.voidUnjustified + 5 * res.overCap + 3 * res.waste + 2 * res.areaMisfit + res.adjacencyMisses;
  return res;
}
function touches(a, b) {
  const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), oz = Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0);
  return (ox > 0.5 && Math.abs(oz) < 0.05) || (oz > 0.5 && Math.abs(ox) < 0.05);
}
export const _gaspace = { recut, misfit, prefsFor, RULES };
