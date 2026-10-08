// v6 fleet (docs/V6-FLEET-CONTRACTS.md §3.2): per-ship state lives on Vessel records; people and captains see it through
// accessors. Wave 2's company.js imports this file instead of defining its own (§15.1).
export const VESSEL_KEYS = ['ship', 'cond', 'flooding', 'fuel', 'cargo', 'jobs', 'kits', 'docked', 'dockedAt', 'berth', 'assist',
  'serviceDue', 'voyage', 'towing', 'fishing', 'fishInfo', 'sailsUp', 'lastValid', 'guideBerth', 'lowFuelWarned', 'condWarned',
  'floodWarned', 'serviceWarned', 'fullWarned', 'shipTime', 'voyageEnd'];
/** obj.vessel must resolve to a Vessel; each VESSEL_KEY of obj reads and writes that vessel. Non-enumerable: {...p} and
 *  JSON.stringify(p) never copy them. */
export function bindVesselView(obj) {
  for (const k of VESSEL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) delete obj[k];
    Object.defineProperty(obj, k, { configurable: true, enumerable: false, get() { return this.vessel[k]; }, set(x) { this.vessel[k] = x; } });
  }
}
/** A person: `vessel` = the one they are aboard. */
export function bindPlayer(p, fleet) {
  Object.defineProperty(p, 'vessel', { configurable: true, enumerable: false, get() { return fleet.vessels.get(this.aboard) || null; } });
  bindVesselView(p);
}
/** Move today's per-ship fields off an old player record into a new object (the first vessel). */
export function takeVesselFields(rec) {
  const out = {};
  for (const k of VESSEL_KEYS) if (Object.prototype.hasOwnProperty.call(rec, k)) { out[k] = rec[k]; delete rec[k]; }
  return out;
}
/** The hired captain of vessel v: runs the game's own methods for her. Never in game.byId, never saved. */
export function makeActor(fleet, v) {
  const game = fleet.game;
  const a = { id: v.id, isActor: true, online: false, hail: null, convoyId: null, wanted: 0, wantedAt: 0, lastInspected: -1e9,
    warp: 1, warpRouted: false, warpGraceUntil: 0, warpGraceFactor: 1, warpRun: null, contactSeen: null, rescue: null, log: [],
    _cat: null };                                   // ledger category hint for the next money change (§3.6)
  Object.defineProperty(a, 'vessel', { enumerable: false, value: v });
  Object.defineProperty(a, 'owner', { enumerable: false, get: () => game.byId.get(v.ownerId) || null });
  Object.defineProperty(a, 'name', { enumerable: false, get: () => v.name, set() {} });
  Object.defineProperty(a, 'stats', { enumerable: false, get: () => v.stats, set(x) { v.stats = x; } });
  Object.defineProperty(a, 'money', { enumerable: false, get: () => a.owner?.money ?? 0, set: (x) => fleet.actorMoney(a, x) });
  bindVesselView(a);
  return a;
}
