// V5 item 3 — engine order telegraph with astern: order ↔ throttle mapping, astern physics (top speed, rudder,
// propeller walk, engine reversal, stopping distance) and the server accepting the astern range.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ORDERS, STOP_INDEX, THROTTLE_MIN, THROTTLE_MAX, ASTERN_SPEED_FRAC, clampThrottle, orderIndex, orderFor, nearestOrderIndex,
  throttleFor, stepOrder, orderLabel, orderPosition, isAstern, rpmFraction,
} from '../shared/telegraph.js';
import { stepShip, newShipState, fuelBurnPerSimHour, wearPerSimHour, reversalSeconds, inertiaTau } from '../shared/physics.js';
import { SHIP_CLASSES } from '../shared/constants.js';
import { haversine } from '../shared/geo.js';

const DT = 0.1;
const run = (s, cmd, seconds, env = {}) => { for (let i = 0; i < Math.round(seconds / DT); i++) stepShip(s, cmd, env, DT); return s; };
const hdgDelta = (a, b) => ((b - a + 540) % 360) - 180;

// ------------------------------------------------------------------ order ↔ throttle mapping
test('telegraph: nine real orders from full astern to full ahead, astern power at most 60 %', () => {
  assert.deepEqual(ORDERS.map((o) => o.id), ['full_astern', 'half_astern', 'slow_astern', 'dead_slow_astern', 'stop', 'dead_slow_ahead', 'slow_ahead', 'half_ahead', 'full_ahead']);
  assert.deepEqual(ORDERS.map((o) => o.thr), [-0.6, -0.45, -0.3, -0.15, 0, 0.25, 0.45, 0.7, 1]);
  assert.equal(ORDERS[STOP_INDEX].thr, 0); assert.equal(THROTTLE_MIN, -0.6); assert.equal(THROTTLE_MAX, 1);
  for (let i = 1; i < ORDERS.length; i++) assert.ok(ORDERS[i].thr > ORDERS[i - 1].thr, 'strictly ordered');
  assert.ok(-THROTTLE_MIN <= 0.6 * THROTTLE_MAX);
  for (const [i, o] of ORDERS.entries()) {
    assert.equal(orderIndex(o.thr), i); assert.equal(orderFor(o.thr), o); assert.equal(throttleFor(o.id), o.thr); assert.equal(throttleFor(i), o.thr);
    assert.equal(nearestOrderIndex(o.thr + 0.01), i);
  }
  assert.equal(orderIndex(0.33), -1, 'between orders'); assert.equal(orderFor(0.33), null);
  assert.equal(clampThrottle(-5), -0.6); assert.equal(clampThrottle(3), 1); assert.equal(clampThrottle(NaN), 0); assert.equal(clampThrottle('x'), 0);
  assert.equal(isAstern(-0.15), true); assert.equal(isAstern(0), false); assert.equal(isAstern(0.25), false);
});

test('telegraph: W/S step one order at a time, through STOP into astern, and land on an order from fine settings', () => {
  // S from full ahead steps down every order to full astern, then stays there
  let t = 1; const down = [t];
  for (let i = 0; i < 10; i++) { t = stepOrder(t, -1); down.push(t); }
  assert.deepEqual(down.slice(0, 9), [1, 0.7, 0.45, 0.25, 0, -0.15, -0.3, -0.45, -0.6]);
  assert.equal(down.at(-1), -0.6, 'clamped at full astern');
  // W back up to full ahead
  for (let i = 0; i < 10; i++) t = stepOrder(t, 1);
  assert.equal(t, 1);
  assert.equal(stepOrder(0, -1), -0.15, 'one S from STOP is dead slow astern');
  assert.equal(stepOrder(0, 1), 0.25, 'one W from STOP is dead slow ahead');
  // fine control between orders: the next step lands on the next order in that direction
  assert.equal(stepOrder(0.33, 1), 0.45); assert.equal(stepOrder(0.33, -1), 0.25);
  assert.equal(stepOrder(-0.2, -1), -0.3); assert.equal(stepOrder(-0.2, 1), -0.15);
  assert.equal(stepOrder(0.05, -1), 0); assert.equal(stepOrder(-0.05, 1), 0);
});

test('telegraph: labels, dial positions and engine rpm', () => {
  assert.equal(orderLabel(-0.45), 'Half astern'); assert.equal(orderLabel(0), 'Stop'); assert.equal(orderLabel(1), 'Full ahead');
  assert.equal(orderLabel(-0.6, { short: true }), 'FULL AST'); assert.equal(orderLabel(0.25, { short: true }), 'D.SLOW AHD');
  assert.equal(orderLabel(0.35), '35 % ahead'); assert.equal(orderLabel(-0.36), '60 % astern', 'astern % is of full astern power');
  assert.equal(orderLabel(0.35, { short: true }), '35% AHD');
  assert.equal(orderPosition(-0.6), 0); assert.equal(orderPosition(0), STOP_INDEX); assert.equal(orderPosition(1), 8);
  assert.ok(Math.abs(orderPosition(0.35) - 5.5) < 1e-9, 'half way between dead slow and slow ahead');
  let prev = -1; for (let t = -0.6; t <= 1.0001; t += 0.01) { const p = orderPosition(t); assert.ok(p >= prev - 1e-9); prev = p; }
  assert.equal(rpmFraction(1), 1); assert.equal(rpmFraction(0), 0); assert.ok(Math.abs(rpmFraction(-0.6) - 0.8) < 1e-9);
  assert.ok(rpmFraction(-0.3) > 0 && rpmFraction(-0.3) < rpmFraction(-0.6));
});

// ------------------------------------------------------------------ physics
test('astern: top speed is about half the ahead speed and never more than 60 % of it, for every class', () => {
  for (const cls of Object.keys(SHIP_CLASSES)) {
    const C = SHIP_CLASSES[cls], env = { sailsUp: false };
    const a = run(newShipState(cls, 55, 3, 0), { throttleCmd: 1 }, 900, env).spd;
    const b = run(newShipState(cls, 55, 3, 0), { throttleCmd: -0.6 }, 1500, env).spd;
    assert.ok(a > 0 && b < 0, `${cls}: ${a} / ${b}`);
    assert.ok(-b <= 0.6 * a, `${cls}: astern ${b.toFixed(2)} kn vs ahead ${a.toFixed(2)} kn`);
    assert.ok(Math.abs(-b / a - ASTERN_SPEED_FRAC) < 0.03, `${cls}: astern/ahead ${(-b / a).toFixed(3)}`);
    // the throttle never goes past full astern, whatever is asked
    const c = run(newShipState(cls, 55, 3, 0), { throttleCmd: -5 }, 60, env);
    assert.ok(c.throttle >= -0.6 - 1e-9, `${cls}: throttle ${c.throttle}`);
    assert.ok(inertiaTau(C) >= 6 && inertiaTau(C) <= 240);
  }
  // steady state ahead is unchanged: half ahead holds 70 % of max speed
  const h = run(newShipState('coaster', 55, 3, 0), { throttleCmd: 0.7 }, 900);
  assert.ok(Math.abs(h.spd - 0.7 * 14) < 0.05, `half ahead ${h.spd}`);
  // the ship really goes backwards: heading north, sternway takes her south
  const s = run(newShipState('coaster', 55, 3, 0), { throttleCmd: -0.45 }, 120);
  assert.ok(s.spd < -2 && s.lat < 55, `sternway ${s.spd} kn, lat ${s.lat}`);
});

test('astern: the engine stops before it reverses, and astern power builds up gradually', () => {
  const s = run(newShipState('coaster', 55, 3, 0), { throttleCmd: 0.25 }, 60);
  const C = SHIP_CLASSES.coaster, rev = reversalSeconds(C);
  assert.ok(rev >= 3 && rev <= 12, `coaster reversal ${rev} s`);
  let t = 0, firstAstern = null, zeroAt = null;
  while (t < 60) { stepShip(s, { throttleCmd: -0.6 }, {}, DT); t += DT; if (zeroAt == null && s.throttle === 0) zeroAt = t; if (firstAstern == null && s.throttle < 0) firstAstern = t; }
  assert.ok(zeroAt != null && firstAstern != null);
  assert.ok(firstAstern - zeroAt >= rev - 0.2, `shaft stopped ${(firstAstern - zeroAt).toFixed(1)} s before running astern`);
  assert.ok(s.throttle < -0.59, 'full astern reached');
  // a fresh engine (never run) starts either way at once
  const f = newShipState('coaster', 55, 3, 0); stepShip(f, { throttleCmd: -0.6 }, {}, 0.5); assert.ok(f.throttle < 0);
});

test('astern: stopping a coaster from full ahead with full astern takes several ship lengths (and less than drifting)', () => {
  const C = SHIP_CLASSES.coaster;
  const s = run(newShipState('coaster', 55, 3, 0), { throttleCmd: 1 }, 900);
  assert.ok(s.spd > 13.9);
  const p0 = { lat: s.lat, lon: s.lon }; let t = 0;
  while (s.spd > 0 && t < 900) { stepShip(s, { throttleCmd: -0.6 }, {}, DT); t += DT; }
  const crash = haversine(p0.lat, p0.lon, s.lat, s.lon);
  assert.ok(crash >= 2.5 * C.length && crash <= 6 * C.length, `crash stop ${crash.toFixed(0)} m = ${(crash / C.length).toFixed(1)} ship lengths`);
  assert.ok(t >= 50 && t <= 180, `crash stop takes ${t.toFixed(0)} s`);
  // engines stopped (no astern): she carries her way much further
  const d = run(newShipState('coaster', 55, 3, 0), { throttleCmd: 1 }, 900);
  const q0 = { lat: d.lat, lon: d.lon }; let td = 0;
  while (d.spd > 0.5 && td < 3000) { stepShip(d, { throttleCmd: 0 }, {}, DT); td += DT; }
  const drift = haversine(q0.lat, q0.lon, d.lat, d.lon);
  assert.ok(drift > 1.8 * crash, `drifting to 0.5 kn ${drift.toFixed(0)} m vs crash stop ${crash.toFixed(0)} m`);
  // and astern holds her afterwards: she gathers sternway
  run(s, { throttleCmd: -0.6 }, 60); assert.ok(s.spd < -1);
});

test('astern: propeller walk swings the bow to starboard (right-handed screw), twin screws do not walk', () => {
  // from rest, full astern, rudder amidships: the stern walks to port, the heading increases
  const s = run(newShipState('coaster', 55, 3, 0), { throttleCmd: -0.6, rudderCmd: 0 }, 30);
  const walk = hdgDelta(0, s.hdg);
  assert.ok(walk > 2 && walk < 25, `coaster walk ${walk.toFixed(1)}° in 30 s`);
  const t = run(newShipState('ferry', 55, 3, 0), { throttleCmd: -0.6, rudderCmd: 0 }, 30);
  assert.ok(Math.abs(hdgDelta(0, t.hdg)) < 1e-6, 'twin-screw ferry backs straight');
  // ahead there is no walk
  const a = run(newShipState('coaster', 55, 3, 0), { throttleCmd: 0.45, rudderCmd: 0 }, 30);
  assert.ok(Math.abs(hdgDelta(0, a.hdg)) < 1e-6);
});

test('astern: the rudder is weaker going astern and the stern goes the way the wheel is turned', () => {
  // twin-screw ferry (no walk) making 5 kn astern vs 5 kn ahead, full starboard rudder for 10 s
  const astern = run(newShipState('ferry', 55, 3, 0), { throttleCmd: -0.6 }, 400);
  const ahead = run(newShipState('ferry', 55, 3, 0), { throttleCmd: 0.25 }, 400);
  assert.ok(astern.spd < -5 && ahead.spd > 5);
  astern.spd = -5; ahead.spd = 5; astern.hdg = 0; ahead.hdg = 0;
  run(astern, { throttleCmd: -0.6 * 5 / 11, rudderCmd: 1 }, 10); run(ahead, { throttleCmd: 5 / 22, rudderCmd: 1 }, 10);
  const dA = hdgDelta(0, astern.hdg), dH = hdgDelta(0, ahead.hdg);
  assert.ok(dH > 0, 'ahead: starboard rudder turns the bow to starboard');
  assert.ok(dA < 0, 'astern: starboard rudder swings the stern to starboard, the bow to port');
  assert.ok(Math.abs(dA) < 0.7 * dH, `astern yaw ${dA.toFixed(2)}° vs ahead ${dH.toFixed(2)}°`);
});

test('astern: fuel burn and wear use the size of the throttle, not its sign', () => {
  assert.equal(fuelBurnPerSimHour('coaster', -0.6, 0, 0, 100), fuelBurnPerSimHour('coaster', 0.6, 0, 0, 100));
  assert.ok(fuelBurnPerSimHour('coaster', -0.6, 0, 0, 100) > fuelBurnPerSimHour('coaster', 0, 0, 0, 100));
  assert.equal(wearPerSimHour(-0.45, 5), wearPerSimHour(0.45, 5));
  const s = newShipState('coaster', 55, 3, 0); stepShip(s, { throttleCmd: NaN }, { fuelEmpty: true }, 0.1);
  for (const k of ['lat', 'lon', 'hdg', 'spd', 'throttle', 'rudder', 'engDir', 'engStop']) assert.ok(Number.isFinite(s[k]), k);
  // an empty tank stops the engine, also astern
  const e = run(newShipState('coaster', 55, 3, 0), { throttleCmd: -0.6 }, 30);
  run(e, { throttleCmd: -0.6 }, 10, { fuelEmpty: true }); assert.equal(e.throttle, 0);
});

// ------------------------------------------------------------------ server
test('server: accepts the astern range from the client (−0.6) and clamps beyond it', async () => {
  process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
  const { World } = await import('../server/world.js');
  const { carvingsForWorld } = await import('../server/harbors.js');
  const { Game } = await import('../server/game.js');
  const world = new World().load(carvingsForWorld(), () => {});
  const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-telegraph-test-state.json' }); g.saveState = () => {}; g.rnd = () => 0.5;
  const ws = { readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); }, close() {} };
  const p = g.connect(ws, null, 'Astern');
  g.onAction(p, { action: 'undock' });
  assert.ok(!p.docked);
  const at = { lat: p.ship.lat, lon: p.ship.lon };
  g.onState(p, { lat: at.lat, lon: at.lon, hdg: 90, spd: -6.5, throttle: -0.6, rudder: 0 });
  assert.equal(p.ship.throttle, -0.6, 'full astern accepted');
  assert.equal(p.ship.spd, -6.5, 'sternway accepted');
  g.onState(p, { lat: at.lat, lon: at.lon, hdg: 90, spd: -50, throttle: -3, rudder: 0 });
  assert.equal(p.ship.throttle, -0.6, 'clamped to full astern');
  assert.ok(p.ship.spd >= -0.6 * SHIP_CLASSES.coaster.maxKn && p.ship.spd < -5, `sternway clamped: ${p.ship.spd}`);
  g.onState(p, { lat: at.lat, lon: at.lon, hdg: 90, spd: -2, throttle: -0.45, rudder: 0 });
  assert.equal(p.ship.throttle, -0.45);
  // under way astern the server burns fuel like ahead
  p.ship.throttle = -0.6; p.ship.spd = -5; const fuel0 = p.fuel; g.tick(1);
  assert.ok(p.fuel < fuel0, 'astern burns fuel');
});
