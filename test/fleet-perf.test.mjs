// v6 fleet: the stepping cadence and the cost of fleet.tick (docs/V6-FLEET-CONTRACTS.md §11.4, §14.1 fleet-perf).
// 300 captained ships sailing in the Atlantic, one online skipper at Rotterdam: at most ceil(300 / 10) + near ships are
// stepped per tick; the mean fleet.tick is printed and must stay under a lenient 15 ms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeGame } from './fleet-helpers.mjs';
import { setOrder } from '../server/captain.js';

const PHASE2 = {};

function fleetOf(g, p, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const lat = 30 + (i % 20) * 1.1, lon = -50 + Math.floor(i / 20) * 1.3;
    const v = g.addVessel(p, { cls: i % 3 ? 'coaster' : 'trawler', at: { lat, lon } });
    setOrder(g.fleet, v, { type: 'route', route: [[lat + 0.5, lon + 3], [lat - 0.5, lon + 6]], then: 'hold' });
    out.push(v);
  }
  return out;
}

test('300 far ships: ≤ ceil(300/10) stepped per tick; mean fleet.tick under 15 ms (FakeGame stepper)', () => {
  const g = new FakeGame(); const { p } = g.join('Ann'); const f = g.fleet;
  const vs = fleetOf(g, p, 300);
  const near = []; for (let i = 0; i < 5; i++) { const v = g.addVessel(p, { cls: 'pilot', at: { lat: 52.0 + i * 0.01, lon: 3.9 } }); setOrder(f, v, { type: 'hold' }); near.push(v); }
  let maxStepped = 0;
  for (let i = 0; i < 200; i++) { g.simTime += 0.1; f.tick(0.1); maxStepped = Math.max(maxStepped, f.perf.lastStepped); }
  const mean = f.perf.ms / f.perf.ticks;
  console.log(`[fleet-perf] FakeGame: ${vs.length} far + ${near.length} near ships, mean fleet.tick ${mean.toFixed(3)} ms, max stepped ${maxStepped}`);
  assert.ok(maxStepped <= Math.ceil(300 / 10) + near.length + 1, `stepped ${maxStepped}`);
  assert.ok(mean < 15, `mean ${mean} ms`);
  assert.ok(vs.every((v) => v.cap.phase === 'sailing'), 'all still under way');
  const st = f.stats();
  assert.equal(st.vessels, 306); assert.equal(st.captained, 305); assert.ok(st.meanTickMs >= 0);
});

test('real game: 300 captained ships in the Atlantic with the real offline-voyage stepper', PHASE2, async () => {
  const { Game } = await import('../server/game.js');
  const { World } = await import('../server/world.js');
  const { carvingsForWorld } = await import('../server/harbors.js');
  process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
  const g = new Game(new World().load(carvingsForWorld(), () => {}), () => {}, { stateFile: '/nonexistent/saltline-fleet-perf.json' }); g.saveState = () => {}; g.rnd = () => 0.5;
  const p = g.connect({ readyState: 1, sent: [], send() {}, close() {} }, null, 'Ann');
  const f = g.fleet;
  for (let i = 0; i < 300; i++) {
    const lat = 30 + (i % 20) * 1.1, lon = -50 + Math.floor(i / 20) * 1.3;
    const v = f.makeVessel(p.id, { ship: { cls: 'coaster', lat, lon, hdg: 0, spd: 0, throttle: 0, rudder: 0 } });
    v.docked = null; v.name = `Perf ${i}`; p.fleet.push(v); f.index(v);
    setOrder(f, v, { type: 'route', route: [[lat + 0.5, lon + 3], [lat - 0.5, lon + 6]], then: 'hold' });
  }
  let maxStepped = 0;
  for (let i = 0; i < 200; i++) { f.tick(0.1); maxStepped = Math.max(maxStepped, f.perf.lastStepped); }
  const mean = f.perf.ms / f.perf.ticks;
  console.log(`[fleet-perf] real game: 300 far ships, mean fleet.tick ${mean.toFixed(3)} ms, max stepped ${maxStepped}`);
  assert.ok(maxStepped <= 31); assert.ok(mean < 15);
});

test('real game: 1,000 far captained ships — 1 s far substeps + cached tide keep fleet.tick near the 4 ms budget', PHASE2, async () => {
  const { Game } = await import('../server/game.js');
  const { World } = await import('../server/world.js');
  const { carvingsForWorld } = await import('../server/harbors.js');
  process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
  const g = new Game(new World().load(carvingsForWorld(), () => {}), () => {}, { stateFile: '/nonexistent/saltline-fleet-perf1k.json' }); g.saveState = () => {}; g.rnd = () => 0.5;
  const p = g.connect({ readyState: 1, sent: [], send() {}, close() {} }, null, 'Ann');
  const f = g.fleet;
  for (let i = 0; i < 1000; i++) {
    const lat = 30 + (i % 20) * 1.1, lon = -50 + Math.floor(i / 20) * 0.4;
    const v = f.makeVessel(p.id, { ship: { cls: 'coaster', lat, lon, hdg: 0, spd: 0, throttle: 0, rudder: 0 } });
    v.docked = null; v.name = `Perf ${i}`; p.fleet.push(v); f.index(v);
    setOrder(f, v, { type: 'route', route: [[lat + 0.5, lon + 3], [lat - 0.5, lon + 6]], then: 'hold' });
  }
  for (let i = 0; i < 50; i++) f.tick(0.1);   // warm-up (JIT, plans, grid)
  f.perf.ms = 0; f.perf.ticks = 0;
  let maxStepped = 0;
  for (let i = 0; i < 200; i++) { f.tick(0.1); maxStepped = Math.max(maxStepped, f.perf.lastStepped); }
  const mean = f.perf.ms / f.perf.ticks;
  console.log(`[fleet-perf] real game: 1000 far ships, mean fleet.tick ${mean.toFixed(3)} ms (budget 4), max stepped ${maxStepped}`);
  assert.ok(maxStepped <= 101); assert.ok(mean < 15, `mean ${mean} ms`);   // lenient for loaded CI machines; ~2 ms on the dev box
  assert.ok([...f.vessels.values()].filter((v) => v.cap?.phase === 'sailing').length >= 1000);
});
