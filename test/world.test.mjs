import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { HARBORS, carvingsForWorld } from '../server/harbors.js';
import { encodeHeight, decodeHeight, TILE } from '../shared/constants.js';
import { toLocal, fromLocal, bearing, haversine } from '../shared/geo.js';
import { stepShip, newShipState, waveSpeedLoss } from '../shared/physics.js';

const world = new World().load(carvingsForWorld(), () => {});

test('height encode/decode round-trips within one step', () => {
  for (const h of [-200, -37, -4, 0, 2, 55, 120]) assert.ok(Math.abs(decodeHeight(encodeHeight(h)) - h) <= TILE.H_STEP / 2);
});
test('well-known points are land or water', () => {
  assert.ok(world.isWater(55.5, 3.0), 'North Sea');
  assert.ok(!world.isWater(48.86, 2.35), 'Paris');
  assert.ok(world.isWater(40, -30), 'Atlantic');
  assert.ok(!world.isWater(23, 10), 'Sahara');
  assert.ok(!world.isWater(-25, 134), 'Australia');
  assert.ok(world.isWater(0, -160), 'Pacific');
});
test('every harbour is navigable water deeper than 9 m', () => {
  for (const h of HARBORS) assert.ok(world.depthAt(h.lat, h.lon) >= 9, `${h.id} depth ${world.depthAt(h.lat, h.lon)}`);
});
test('tiles have the overlap size and out-of-range tiles are null', () => {
  const t = world.tile(1, 30, 20);
  assert.equal(t.length, (TILE.CELLS + 1) ** 2);
  assert.equal(world.tile(1, -1, 0), null);
  assert.equal(world.tile(5, 0, 0), null);
});
test('chart PNG has a valid signature and IHDR', () => {
  const png = world.chartPNG(1, 8);
  assert.equal(png.readUInt32BE(0), 0x89504e47);
  assert.equal(png.toString('ascii', 12, 16), 'IHDR');
});
test('toLocal/fromLocal are inverse and oriented x=east z=south', () => {
  const o = { lat: 52, lon: 4 };
  const p = toLocal(52.1, 4.2, o);
  assert.ok(p.x > 0 && p.z < 0);
  const b = fromLocal(p.x, p.z, o);
  assert.ok(Math.abs(b.lat - 52.1) < 1e-9 && Math.abs(b.lon - 4.2) < 1e-9);
});
test('bearing and haversine sanity', () => {
  assert.ok(Math.abs(bearing(52, 4, 53, 4)) < 0.01, 'north');
  assert.ok(Math.abs(bearing(52, 4, 52, 5) - 90) < 1, 'east');
  assert.ok(Math.abs(haversine(0, 0, 0, 1) - 111320) < 500);
});
test('stepShip accelerates, turns to starboard with positive rudder and never produces NaN', () => {
  const s = newShipState('coaster', 55, 3, 0);
  for (let i = 0; i < 600; i++) stepShip(s, { throttleCmd: 1, rudderCmd: 0 }, { cond: 100, flooding: 0, loadFrac: 0 }, 0.1);
  assert.ok(s.spd > 10 && s.spd <= 14.01, `speed ${s.spd}`);
  assert.ok(s.lat > 55, 'moved north');
  for (let i = 0; i < 100; i++) stepShip(s, { throttleCmd: 1, rudderCmd: 1 }, { cond: 100, flooding: 0, loadFrac: 0 }, 0.1);
  assert.ok(s.hdg > 5 && s.hdg < 180, `turned right: ${s.hdg}`);
  stepShip(s, { throttleCmd: 1, rudderCmd: 1 }, { cond: 100, flooding: 0, loadFrac: 0 }, 0);
  stepShip(s, { throttleCmd: NaN, rudderCmd: undefined }, {}, 0.1);
  for (const k of ['lat', 'lon', 'hdg', 'spd', 'throttle', 'rudder']) assert.ok(Number.isFinite(s[k]), k);
});
test('worn and flooded ships are slower and steer worse', () => {
  const a = newShipState('coaster', 55, 3, 0), b = newShipState('coaster', 55, 3, 0);
  for (let i = 0; i < 600; i++) { stepShip(a, { throttleCmd: 1, rudderCmd: 0 }, { cond: 100 }, 0.1); stepShip(b, { throttleCmd: 1, rudderCmd: 0 }, { cond: 10, flooding: 0.3 }, 0.1); }
  assert.ok(b.spd < a.spd * 0.7);
});
test('tidal stream sets the ship and head seas slow it by up to 25 %', () => {
  const a = newShipState('coaster', 55, 3, 90), b = newShipState('coaster', 55, 3, 90);
  for (let i = 0; i < 100; i++) { stepShip(a, { throttleCmd: 0 }, {}, 0.1); stepShip(b, { throttleCmd: 0 }, { tideStream: { u: 1, v: 0 } }, 0.1); }
  assert.ok(Math.abs(a.lon - 3) < 1e-9 && b.lon > 3, 'the stream sets the ship east');
  assert.ok(Math.abs(haversine(55, 3, b.lat, b.lon) - 10) < 0.5, 'about 10 m in 10 s at 1 m/s');
  const c = newShipState('coaster', 55, 3, 0), d = newShipState('coaster', 55, 3, 0), e = newShipState('coaster', 55, 3, 0), f = newShipState('coaster', 55, 3, 0);
  for (let i = 0; i < 1200; i++) {
    stepShip(c, { throttleCmd: 1 }, {}, 0.1); stepShip(d, { throttleCmd: 1 }, { waveH: 6, waveDir: 0 }, 0.1);
    stepShip(e, { throttleCmd: 1 }, { waveH: 6, waveDir: 180 }, 0.1); stepShip(f, { throttleCmd: 1 }, { waveH: 12, waveDir: 0 }, 0.1);
  }
  assert.ok(Math.abs(d.spd / c.spd - 0.75) < 0.01, `6 m head seas: ${(d.spd / c.spd).toFixed(3)} of calm speed`);
  assert.ok(e.spd > d.spd && e.spd < c.spd, 'following seas cost less than head seas');
  assert.ok(Math.abs(f.spd - d.spd) < 1e-9, 'the penalty caps at 6 m');
  assert.equal(waveSpeedLoss(0, 12, 0), 0.25); assert.equal(waveSpeedLoss(0, 0, 0), 0); assert.ok(waveSpeedLoss(0, 3, undefined) > 0 && waveSpeedLoss(0, 3, undefined) < 0.125);
  const n = newShipState('coaster', 55, 3, 0); stepShip(n, { throttleCmd: 1 }, { waveH: NaN, waveDir: 'x', tideStream: { u: NaN } }, 0.1);
  for (const k of ['lat', 'lon', 'hdg', 'spd']) assert.ok(Number.isFinite(n[k]), k);
});
