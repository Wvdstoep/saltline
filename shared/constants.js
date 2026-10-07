// Shared constants — imported by both the Node server and the browser client (plain ESM, no deps).

export const GEO = {
  EARTH_R: 6371000,
  SCALE: 1,               // 1 game unit = 1 real metre: the world is rendered 1:1
  M_PER_DEG_LAT: 110574,
  M_PER_DEG_LON_EQ: 111320,
  KN_TO_MS: 0.514444,
};

// Real time. A 14-knot coaster really takes ~13 hours from Rotterdam to Hull; the crew keeps sailing an
// autopilot route while the skipper is offline, and a paid "express passage" is the only way to skip ahead.
export const SIM = {
  MOTION_SCALE: 1,
  CLOCK_SCALE: 1,
  SNAPSHOT_HZ: 10,
  CLIENT_STATE_HZ: 10,
  SERVER_TICK_HZ: 10,
  ORIGIN_RESHIFT_UNITS: 20000,
  EXPRESS_CR_PER_NM: 80,
  AI_RANGE_U: 40000,
};

// Raster layers. Level 0 = GLOBAL (whole earth), level 1 = REGION (North Sea detail window).
export const LAYERS = [
  { level: 0, name: 'global', lonMin: -180, lonMax: 180, latMin: -90, latMax: 90, res: 0.05 },
  { level: 1, name: 'region', lonMin: -8, lonMax: 14, latMin: 48, latMax: 62.5, res: 0.005 },
];

export const TILE = {
  CELLS: 64,              // cells per tile edge; payload is (CELLS+1)^2 bytes with a 1-cell overlap
  H_OFFSET: 110,          // h_m = (v - H_OFFSET) * H_STEP
  H_STEP: 2,
};

export function decodeHeight(v) { return (v - TILE.H_OFFSET) * TILE.H_STEP; }
export function encodeHeight(h) {
  const v = Math.round(h / TILE.H_STEP) + TILE.H_OFFSET;
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

// Ship classes. Lengths in metres; speeds in knots; masses in tonnes; burn in t of fuel per hour at 100 % throttle;
// price in credits; wearMul scales hull wear; crewCost in credits per hour under way; cat = market category.
// sail: true → wind-driven (polar in shared/physics.js) with a small auxiliary engine (auxKn).
export const SHIP_CLASSES = {
  // --- cargo ---
  coaster: { id: 'coaster', cat: 'cargo', name: 'Coastal freighter', length: 90, beam: 14, draft: 5.5, maxKn: 14, turnRate: 5.5, displacement: 3200, capacity: 1200, pax: 12, fuelCap: 80, burn: 0.9, price: 0, hullColor: 0x2d4a6b, fishRate: 0.6, wearMul: 1, crewCost: 40, desc: 'Cheap, slow, sturdy. The starter ship.' },
  feeder: { id: 'feeder', cat: 'cargo', name: 'Container feeder', length: 150, beam: 24, draft: 8.5, maxKn: 20, turnRate: 4, displacement: 14000, capacity: 4000, pax: 8, fuelCap: 300, burn: 3.2, price: 950000, hullColor: 0x2d6b4a, fishRate: 0.2, wearMul: 1, crewCost: 120, desc: 'Fast, deep, hungry. Makes money on long container runs.' },
  bulker: { id: 'bulker', cat: 'cargo', name: 'Handysize bulk carrier', length: 190, beam: 30, draft: 10.5, maxKn: 14, turnRate: 3, displacement: 40000, capacity: 35000, pax: 10, fuelCap: 900, burn: 2.8, price: 4500000, hullColor: 0x7a2e2e, fishRate: 0.1, wearMul: 1.1, crewCost: 180, desc: 'Grain, ore, steel by the tens of thousands of tonnes.' },
  tanker: { id: 'tanker', cat: 'cargo', name: 'Product tanker', length: 180, beam: 32, draft: 11, maxKn: 15, turnRate: 3, displacement: 45000, capacity: 30000, pax: 10, fuelCap: 800, burn: 2.6, price: 4200000, hullColor: 0x1f2f3f, fishRate: 0, wearMul: 1.1, crewCost: 180, desc: 'Fuel and chemicals. Harbour authorities watch tankers closely.' },
  boxship: { id: 'boxship', cat: 'cargo', name: 'Container ship', length: 300, beam: 43, draft: 14, maxKn: 22, turnRate: 2.2, displacement: 110000, capacity: 90000, pax: 12, fuelCap: 4000, burn: 9, price: 25000000, hullColor: 0x16324f, fishRate: 0, wearMul: 1.2, crewCost: 400, desc: 'The big league. Only mega ports can handle her.' },
  // --- working ships ---
  trawler: { id: 'trawler', cat: 'working', name: 'Stern trawler', length: 45, beam: 10, draft: 4.2, maxKn: 12, turnRate: 8, displacement: 900, capacity: 300, pax: 4, fuelCap: 40, burn: 0.5, price: 180000, hullColor: 0x6b3a2d, fishRate: 3.0, wearMul: 1.2, crewCost: 35, desc: 'Small and nimble; pulls fish out of the banks five times faster than anything else.' },
  tug: { id: 'tug', cat: 'working', name: 'Harbour tug', length: 32, beam: 11, draft: 5, maxKn: 13, turnRate: 12, displacement: 700, capacity: 50, pax: 6, fuelCap: 60, burn: 0.45, price: 320000, hullColor: 0x1b1b1b, fishRate: 0.1, wearMul: 0.9, crewCost: 45, towPower: 1, desc: 'Built to tow. Towing contracts pay double and cost her no speed.' },
  psv: { id: 'psv', cat: 'working', name: 'Platform supply vessel', length: 85, beam: 20, draft: 6.5, maxKn: 14, turnRate: 6, displacement: 4500, capacity: 2500, pax: 20, fuelCap: 400, burn: 1.1, price: 1200000, hullColor: 0xd9531e, fishRate: 0.2, wearMul: 0.9, crewCost: 90, desc: 'Offshore supply runs to the platforms; the only hull that is at home in a storm.' },
  pilot: { id: 'pilot', cat: 'working', name: 'Pilot boat', length: 18, beam: 5.5, draft: 1.8, maxKn: 26, turnRate: 20, displacement: 40, capacity: 2, pax: 8, fuelCap: 6, burn: 0.12, price: 90000, hullColor: 0xe8a317, fishRate: 0.1, wearMul: 1.3, crewCost: 15, desc: 'Fast runabout for short charters and reaching things in a hurry.' },
  // --- passenger ---
  ferry: { id: 'ferry', cat: 'passenger', name: 'RoPax ferry', length: 120, beam: 22, draft: 6, maxKn: 22, turnRate: 5, displacement: 9000, capacity: 500, pax: 400, fuelCap: 200, burn: 2.6, price: 700000, hullColor: 0xe8e8e8, fishRate: 0.1, wearMul: 1, crewCost: 150, desc: 'Passenger ferry: 400 berths, 22 knots, thirsty.' },
  // --- motor yachts ---
  cruiser: { id: 'cruiser', cat: 'motor yacht', name: 'Sports cruiser 12 m', length: 12, beam: 3.8, draft: 1.1, maxKn: 30, turnRate: 25, displacement: 9, capacity: 1, pax: 6, fuelCap: 1.2, burn: 0.09, price: 150000, hullColor: 0xf4f4f4, fishRate: 0.05, wearMul: 1.4, crewCost: 0, desc: 'Weekend toy. Fast, fragile, no cargo.' },
  myacht: { id: 'myacht', cat: 'motor yacht', name: 'Motor yacht 24 m', length: 24, beam: 6, draft: 1.8, maxKn: 26, turnRate: 16, displacement: 70, capacity: 3, pax: 10, fuelCap: 8, burn: 0.25, price: 900000, hullColor: 0x1d1d1d, fishRate: 0.05, wearMul: 1.2, crewCost: 20, desc: 'Charter guests pay well for her. Keep her polished.' },
  superyacht: { id: 'superyacht', cat: 'motor yacht', name: 'Superyacht 70 m', length: 70, beam: 12, draft: 3.6, maxKn: 18, turnRate: 7, displacement: 1500, capacity: 20, pax: 24, fuelCap: 150, burn: 0.9, price: 12000000, hullColor: 0xeaeaea, fishRate: 0, wearMul: 1.1, crewCost: 220, desc: 'The most expensive way to carry 24 people. Charter rates to match.' },
  // --- sailing yachts ---
  sloop: { id: 'sloop', cat: 'sailing yacht', name: 'Sloop 11 m', length: 11, beam: 3.6, draft: 1.9, maxKn: 7.2, auxKn: 5, sail: true, turnRate: 22, displacement: 6, capacity: 0.5, pax: 4, fuelCap: 0.2, burn: 0.012, price: 60000, hullColor: 0x1e3f73, fishRate: 0.05, wearMul: 1.3, crewCost: 0, desc: 'Wind is free. Beating to windward is not fast.' },
  ketch: { id: 'ketch', cat: 'sailing yacht', name: 'Ketch 16 m', length: 16, beam: 4.6, draft: 2.3, maxKn: 8.6, auxKn: 6, sail: true, turnRate: 16, displacement: 18, capacity: 1.5, pax: 6, fuelCap: 0.6, burn: 0.02, price: 220000, hullColor: 0x7a2e2e, fishRate: 0.05, wearMul: 1.2, crewCost: 0, desc: 'Blue-water cruiser; two masts, an ocean of patience.' },
  catamaran: { id: 'catamaran', cat: 'sailing yacht', name: 'Catamaran 14 m', length: 14, beam: 7.5, draft: 1.3, maxKn: 10.5, auxKn: 7, sail: true, turnRate: 18, displacement: 12, capacity: 1.2, pax: 8, fuelCap: 0.5, burn: 0.02, price: 300000, hullColor: 0xf0f0f0, fishRate: 0.05, wearMul: 1.2, crewCost: 0, desc: 'Fast off the wind and shallow enough for most anchorages.' },
  schooner: { id: 'schooner', cat: 'sailing yacht', name: 'Classic schooner 35 m', length: 35, beam: 7.5, draft: 3.5, maxKn: 10, auxKn: 7, sail: true, turnRate: 9, displacement: 180, capacity: 8, pax: 12, fuelCap: 3, burn: 0.06, price: 1400000, hullColor: 0x3b2a1a, fishRate: 0.1, wearMul: 1.4, crewCost: 60, desc: 'Wood and brass; charter guests love her, the maintenance bill does not.' },
};

export const GOODS = {
  fish: { name: 'Fish', base: 700, contraband: false },
  grain: { name: 'Grain', base: 260, contraband: false },
  steel: { name: 'Steel coils', base: 900, contraband: false },
  machinery: { name: 'Machinery', base: 3200, contraband: false },
  containers: { name: 'Containers', base: 2100, contraband: false },
  fuel: { name: 'Bunker fuel', base: 650, contraband: false },
  supplies: { name: 'Offshore supplies', base: 1800, contraband: false },
  cigarettes: { name: 'Untaxed cigarettes', base: 9000, contraband: true },
  weapons: { name: 'Crated weapons', base: 24000, contraband: true },
  narcotics: { name: 'Narcotics', base: 42000, contraband: true },
  antiquities: { name: 'Looted antiquities', base: 18000, contraband: true },
};

// Interaction ranges in metres (1 unit = 1 m).
export const INTERACT = {
  DOCK_RADIUS_U: 450,
  TRADE_RANGE_U: 300,
  BOARD_RANGE_U: 150,
  SALVAGE_RANGE_U: 150,
  CONVOY_ESCORT_U: 1500,
  FISH_RADIUS_U: 1200,
  PLATFORM_RANGE_U: 400,
  TOW_RANGE_U: 150,
  BERTH_RANGE_U: 60,
  TUG_RANGE_U: 1500,
};

export const LAW = {
  HAIL_RANGE_U: 3000,
  HAIL_SECONDS: 30,
  HEAVE_TO_KN: 2,
  INSPECT_CHANCE: [0.15, 0.6, 0.85, 1.0],  // by wanted level
  PORT_INSPECT_CHANCE: 0.12,
  PORT_INSPECT_CHANCE_WANTED: 0.25,
  FINE_FLAT: 5000,
  FINE_MULT: 2,
  PURSUIT_KN: 30,
  PURSUIT_SECONDS: 600,
  WANTED_DECAY_SIM_HOURS: 24,
  INSPECT_COOLDOWN_SEC: 3600,
  IMPOUND_RESET_WANTED: 2,
};

// v0.3: harbour fees and maintenance (credits per tonne of displacement unless stated). Shown by the HUD, charged by the server.
export const FEES = {
  DUES_PER_T: 0.12,            // port dues on docking, × harbour class
  BERTH_PER_T_DAY: 0.02,       // berth fee per started 24 h alongside, charged on undock
  PILOTAGE_PER_T: 0.05,        // compulsory pilotage at mega/major ports for ships over PILOTAGE_MIN_LENGTH_M
  PILOTAGE_MIN_LENGTH_M: 90,
  TUG_PER_T: 0.35, TUG_MIN: 400,   // tug assist into a berth
  TUG_SECONDS: 45,
  SERVICE_FRAC: 0.01,          // yard service costs 1 % of the hull price
  SERVICE_INTERVAL_DAYS: 30,   // after which wear climbs SERVICE_WEAR_PER_DAY per day, up to SERVICE_WEAR_MAX
  SERVICE_WEAR_PER_DAY: 0.02, SERVICE_WEAR_MAX: 0.6,
  COLLISION_MIN_KN: 0.4,       // slower contacts are the fenders doing their job
};

// v0.3: high-resolution harbour patches (see docs/V3-CONTRACTS.md §1). Cell (i east, j south) ↔ lat/lon helpers are the
// single definition both the server rasteriser and the client use.
export const PATCH = {
  N: 448, RES: 10, H_OFFSET: 128, H_STEP: 0.25,
  MASK: { WATER: 0, LAND: 1, QUAY: 2, BREAKWATER: 3, PONTOON: 4, FAIRWAY: 5, SHALLOW: 6 },
};
export function encodePatchHeight(h) { const v = Math.round(h / PATCH.H_STEP) + PATCH.H_OFFSET; return v < 0 ? 0 : v > 255 ? 255 : v; }
export function decodePatchHeight(v) { return (v - PATCH.H_OFFSET) * PATCH.H_STEP; }
export function patchCellToLatLon(i, j, n, res, originLat, originLon) {
  const x = (i + 0.5 - n / 2) * res, z = (j + 0.5 - n / 2) * res;
  return { lat: originLat - z / GEO.M_PER_DEG_LAT, lon: originLon + x / (GEO.M_PER_DEG_LON_EQ * Math.cos((originLat * Math.PI) / 180)) };
}
/** Continuous (un-rounded) cell coordinates; the cell centre of (i, j) is at i + 0.5, j + 0.5. */
export function latLonToPatchCell(lat, lon, n, res, originLat, originLon) {
  const x = (lon - originLon) * GEO.M_PER_DEG_LON_EQ * Math.cos((originLat * Math.PI) / 180), z = -(lat - originLat) * GEO.M_PER_DEG_LAT;
  return { i: x / res + n / 2, j: z / res + n / 2 };
}
