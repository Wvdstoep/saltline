// Shared helpers for test/hostile-*.test.mjs (not a test file itself): a Game on the real world raster, a skipper put at sea,
// an RNG queue and a manual clock (the hostile module runs on game.simTime and the tick dt, never on Date.now).
import { World } from '../server/world.js';
import { carvingsForWorld } from '../server/harbors.js';
import { Game } from '../server/game.js';
import { destination } from '../shared/geo.js';
import { GEO } from '../shared/constants.js';

process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
export const world = new World().load(carvingsForWorld(), () => {});
export function fakeSocket() { return { readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); }, close() {} }; }
export function mkGame(opts = {}) {
  const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-hostile-state.json', ...opts });
  g.saveState = () => {};
  g.simTime = Date.UTC(2026, 9, 10, 10, 0, 0) / 1000;          // 10:00 UTC; at lon 0..50 it is day
  return g;
}
/** Known open-water spots inside the dataset's areas (checked by test/hostile-risk). */
export const SPOTS = {
  gog: { lat: 2, lon: 5 }, somali: { lat: 0, lon: 52 }, sgstrait: { lat: 1.2, lon: 104 }, redsea: { lat: 18, lon: 40 }, blacksea: { lat: 44.9, lon: 31.7 },
  open: { lat: 52.5, lon: 3.2 },           // North Sea: no piracy / war area
};
/** A skipper at sea at `pos`, speed `kn` on heading `hdg`, risk mode as given. */
export function atSea(g, name, pos, { kn = 10, hdg = 90, cls = 'coaster', risk = true, cargo = null } = {}) {
  const ws = fakeSocket(); const p = g.connect(ws, null, name);
  p.docked = null; p.berth = null; p.dockedAt = 0;
  p.ship.cls = cls; p.money = 1e7; p.fuel = 1e6; p.cond = 100; p.flooding = 0;
  Object.assign(p.ship, { lat: pos.lat, lon: pos.lon, hdg, spd: kn, throttle: kn > 0 ? 0.7 : 0, rudder: 0 });
  p.lastValid = { lat: pos.lat, lon: pos.lon };
  if (cargo) p.cargo = cargo;
  p.risk = { on: risk, day: '', n: 0, last: 0, lastEnc: 0 };
  return { p, ws };
}
/** RNG that returns the queued values first, then `rest`. */
export function rig(g, queue = [], rest = 0.5) { const q = [...queue]; g.rnd = () => (q.length ? q.shift() : rest); return g.rnd; }
/** Advance the sim clock and the hostile module by `seconds`; the player's ship sails along its heading at its speed. */
export function run(g, seconds, { dt = 0.5, sail = true, until = null } = {}) {
  for (let t = 0; t < seconds; t += dt) {
    g.simTime += dt;
    if (sail) for (const p of g.byId.values()) if (p.online && !p.docked && !p.rescue && Math.abs(p.ship.spd) > 0.01 && !(p.voyage && false)) {
      const q = destination(p.ship.lat, p.ship.lon, p.ship.hdg, p.ship.spd * GEO.KN_TO_MS * dt); p.ship.lat = q.lat; p.ship.lon = q.lon;
    }
    g.hostiles.tick(dt);
    if (until && until()) return true;
  }
  return until ? until() : false;
}
export const events = (ws) => ws.sent.filter((m) => m.t === 'event').map((m) => m.text);
export const lastYou = (ws) => [...ws.sent].reverse().find((m) => m.t === 'you')?.you;
/**
 * Force a spawn check for one skipper right now. The queue feeds the rolls in order: spawn roll, group size, distance, bearing,
 * (pirates) the 'patrol already there' roll; everything after is 0.5.
 */
export function forceSpawn(g, p, { group = 0.1, queue = null } = {}) { rig(g, queue || [0.0001, group, 0.5, 0.5, 0.9], 0.5); return g.hostiles.trySpawn(p); }
