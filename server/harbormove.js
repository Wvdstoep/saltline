// Saved ships at a harbour the position audit moved (scripts/audit-harbours.mjs, server/harbor-positions.js): a ship
// saved DOCKED there still lies at the old, synthetic harbour (up to ~12 km off the real port). On load it moves with
// the harbour — onto the new anchor (berth-able water in the real basin), docked, without a berth (the old berth ids
// belonged to the old patch). Ships moored at a real quay (dock anywhere, berth.quay) and ships already near the new
// anchor stay where they are. Pure: game.js / fleet.js call it with their records.
import { haversine } from '../shared/geo.js';

export const HARBOUR_MOVE = { NEAR_PREV_M: 6000, AT_NEW_M: 2500 };

/** Should a ship record { ship: {lat, lon}, docked, berth } docked at `h` move with the harbour? */
export function shouldRelocate(rec, h) {
  if (!rec || !rec.ship || !h || !h.prev || typeof rec.docked !== 'string' || rec.docked !== h.id) return false;
  if (rec.berth && rec.berth.quay) return false;
  const { lat, lon } = rec.ship;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  return haversine(lat, lon, h.lat, h.lon) > HARBOUR_MOVE.AT_NEW_M && haversine(lat, lon, h.prev.lat, h.prev.lon) <= HARBOUR_MOVE.NEAR_PREV_M;
}

/** Move every record docked at a moved harbour (see above). Returns the number moved. `harborById(id)` → harbour. */
export function relocateDocked(records, harborById, log = () => {}) {
  let n = 0;
  for (const rec of records) {
    const h = rec && typeof rec.docked === 'string' ? harborById(rec.docked) : null;
    if (!shouldRelocate(rec, h)) continue;
    const from = { lat: rec.ship.lat, lon: rec.ship.lon };
    rec.ship.lat = h.lat; rec.ship.lon = h.lon; rec.ship.spd = 0;
    if ('throttle' in rec.ship) rec.ship.throttle = 0;
    if (h.approach && Number.isFinite(h.approach.hdg)) rec.ship.hdg = h.approach.hdg;
    rec.berth = null;
    rec.lastValid = { lat: h.lat, lon: h.lon };
    n++;
    try { log(`[harbours] ${rec.id || rec.name || '?'} docked at ${h.id}: moved ${Math.round(haversine(from.lat, from.lon, h.lat, h.lon))} m with the harbour`); } catch { /* never */ }
  }
  return n;
}
