// Realistic rates shared by contracts (shared/jobtime.js), the world market (server/market.js) and the autopilot.
// docs/V6-QUICK-CONTRACTS.md §1.5. Plain ESM, browser-safe, no DOM, no state.
import { SHIP_CLASSES } from './constants.js';
import { fuelBurnPerSimHour, wearPerSimHour } from './physics.js';

export const RATES = {
  SERVICE_THROTTLE: 0.8,  // service speed = 80 % throttle (the express passage already uses 0.8)
  FISH_T_PER_H: 10,       // nets: t/h = class fishRate × ground richness × this (was server/game.js FISH_RATE_T_PER_H)
  DETOUR: 1.25,           // sea km ≈ great-circle km × this when no planned distance is known
  KMH_PER_KN: 1.852,
  NOMINAL_WIND_MS: 8,     // wind used for wear estimates
};
const clamp01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0);
export function shipClass(cls) { return SHIP_CLASSES[cls] || SHIP_CLASSES.coaster; }
/** Service speed (kn): 80 % of max for engine ships, 60 % of hull speed for sailing yachts (at least the engine's auxKn);
 *  15 % less fully laden (the load term of shared/physics.js speedPenalty). */
export function serviceKn(cls, loadFrac = 0) {
  const C = shipClass(cls);
  const kn = C.sail ? Math.max(C.auxKn || 5, 0.6 * C.maxKn) : C.maxKn * RATES.SERVICE_THROTTLE;
  return kn * (1 - 0.15 * clamp01(loadFrac));
}
/** Nets: tonnes per hour of trawling for a class on a ground of `richness` (storm factor applied by the caller). */
export function catchRate(cls, richness = 1) { const C = SHIP_CLASSES[cls]; return C ? (C.fishRate || 0) * (Number(richness) || 0) * RATES.FISH_T_PER_H : 0; }
/** Hours to cover `km` at `kn`. */
export function kmHours(km, kn) { return kn > 0 && km >= 0 ? km / (kn * RATES.KMH_PER_KN) : Infinity; }
/** Fuel (t/h) at service throttle; sailing yachts sail (0). */
export function serviceBurnTph(cls, loadFrac = 0) { const C = shipClass(cls); return C.sail ? 0 : fuelBurnPerSimHour(C.id, RATES.SERVICE_THROTTLE, clamp01(loadFrac), 0, 100); }
/** Hull condition points lost per hour at service throttle in a nominal breeze. */
export function serviceWearPerH(cls) { return wearPerSimHour(RATES.SERVICE_THROTTLE, RATES.NOMINAL_WIND_MS, shipClass(cls).wearMul); }
