// Shared constants — imported by both the Node server and the browser client (plain ESM, no deps).

export const GEO = {
  EARTH_R: 6371000,
  SCALE: 13,              // 1 game unit = 13 real metres (world compression); ships render at real size
  M_PER_DEG_LAT: 110574,
  M_PER_DEG_LON_EQ: 111320,
  KN_TO_MS: 0.514444,
};

export const SIM = {
  MOTION_SCALE: 39,       // sim seconds of kinematics per real second (looks like ~3x on a 1:13 world)
  CLOCK_SCALE: 39,        // sim seconds per real second for fuel/wear/economy clocks
  SNAPSHOT_HZ: 10,
  CLIENT_STATE_HZ: 10,
  SERVER_TICK_HZ: 10,
  ORIGIN_RESHIFT_UNITS: 20000,
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

// Ship classes. Lengths in real metres; speeds in knots; masses in tonnes; burn in t per sim-hour at 100% throttle.
export const SHIP_CLASSES = {
  coaster: {
    id: 'coaster', name: 'Coastal freighter', length: 90, beam: 14, draft: 5.5, maxKn: 14, turnRate: 5.5,
    displacement: 3200, capacity: 1200, pax: 12, fuelCap: 80, burn: 0.9, price: 0, hullColor: 0x2d4a6b,
    fishRate: 0.6, desc: 'Cheap, slow, sturdy. The starter ship.',
  },
  trawler: {
    id: 'trawler', name: 'Stern trawler', length: 45, beam: 10, draft: 4.2, maxKn: 12, turnRate: 8,
    displacement: 900, capacity: 300, pax: 4, fuelCap: 40, burn: 0.5, price: 180000, hullColor: 0x6b3a2d,
    fishRate: 3.0, desc: 'Small and nimble; pulls fish out of the banks five times faster than anything else.',
  },
  feeder: {
    id: 'feeder', name: 'Container feeder', length: 150, beam: 24, draft: 8.5, maxKn: 20, turnRate: 4,
    displacement: 14000, capacity: 4000, pax: 8, fuelCap: 300, burn: 3.2, price: 950000, hullColor: 0x2d6b4a,
    fishRate: 0.2, desc: 'Fast, deep, hungry. Makes money on long container runs.',
  },
  ferry: {
    id: 'ferry', name: 'RoPax ferry', length: 120, beam: 22, draft: 6, maxKn: 22, turnRate: 5,
    displacement: 9000, capacity: 500, pax: 400, fuelCap: 200, burn: 2.6, price: 700000, hullColor: 0xe8e8e8,
    fishRate: 0.1, desc: 'Passenger ferry: 400 berths, 22 knots, thirsty.',
  },
};

export const GOODS = {
  fish: { name: 'Fish', base: 700, contraband: false },
  grain: { name: 'Grain', base: 260, contraband: false },
  steel: { name: 'Steel coils', base: 900, contraband: false },
  machinery: { name: 'Machinery', base: 3200, contraband: false },
  containers: { name: 'Containers', base: 2100, contraband: false },
  fuel: { name: 'Bunker fuel', base: 650, contraband: false },
  cigarettes: { name: 'Untaxed cigarettes', base: 9000, contraband: true },
  weapons: { name: 'Crated weapons', base: 24000, contraband: true },
  narcotics: { name: 'Narcotics', base: 42000, contraband: true },
  antiquities: { name: 'Looted antiquities', base: 18000, contraband: true },
};

export const INTERACT = {
  DOCK_RADIUS_U: 220,      // game units from the harbour point to be able to dock
  TRADE_RANGE_U: 150,
  BOARD_RANGE_U: 120,
  SALVAGE_RANGE_U: 100,
  CONVOY_ESCORT_U: 400,
  FISH_RADIUS_U: 1200,
};

export const LAW = {
  HAIL_RANGE_U: 500,
  HAIL_SECONDS: 30,
  HEAVE_TO_KN: 2,
  INSPECT_CHANCE: [0.15, 0.6, 0.85, 1.0],  // by wanted level
  PORT_INSPECT_CHANCE: 0.12,
  PORT_INSPECT_CHANCE_WANTED: 0.25,
  FINE_FLAT: 5000,
  FINE_MULT: 2,
  PURSUIT_KN: 30,
  PURSUIT_SECONDS: 120,
  WANTED_DECAY_SIM_HOURS: 24,
  IMPOUND_RESET_WANTED: 2,
};
