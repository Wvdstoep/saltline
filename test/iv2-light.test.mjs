// Interiors v2 — baked vertex light and the atlas (docs/INTERIORS-V2-CONTRACT.md §5, Lane R): practical / daylight /
// emergency / night channels per vertex, the mode table, determinism; the atlas tile set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bakeLight, lightTables, lightMode } from '../public/js/iv2light.js';
import { TILES, TILE_INDEX, GRID, tileOf, tileRect } from '../public/js/iv2atlas.js';
import { planFromGA } from '../public/js/gaplan.js';

const room = (id, x0, x1, z0, z1, extra = {}) => ({ id, x0, x1, z0, z1, y: 0, h: 2.2, ...extra });
const ROOMS = [
  room('cabin', 0, 3, 0, 3.5, { windows: [{ side: 'n', from: 1, to: 2, bottom: 1, top: 1.6 }] }),
  room('store', 3, 6, 0, 3.5),
  room('corr', 0, 6, 3.5, 4.7),
  room('bridge', 0, 10, 10, 14, { windows: [{ side: 'n', from: 0.5, to: 9.5, bottom: 1.1, top: 2.2 }] }),
];
const LIGHTS = [
  { id: 'l1', room: 'cabin', kind: 'panel', x: 1.5, y: 2.15, z: 1.7, lm: 900, em: false, night: 'dim' },
  { id: 'l2', room: 'store', kind: 'panel', x: 4.5, y: 2.15, z: 1.7, lm: 600, em: false, night: 'off' },
  { id: 'e1', room: 'corr', kind: 'bulkhead', x: 3, y: 2.1, z: 4.1, lm: 200, em: true, night: 'on' },
  { id: 'b1', room: 'bridge', kind: 'panel', x: 5, y: 2.15, z: 12, lm: 1200, em: false, night: 'off' },
  { id: 'b2', room: 'bridge', kind: 'red', x: 5, y: 2.15, z: 12.5, lm: 150, em: false, night: 'red' },
];
function bakeAt(pts) {
  const n = pts.length, pos = new Float32Array(3 * n), nrm = new Float32Array(3 * n), ri = new Int32Array(n);
  pts.forEach(([x, y, z, r], i) => { pos.set([x, y, z], 3 * i); nrm.set([0, 1, 0], 3 * i); ri[i] = ROOMS.findIndex((q) => q.id === r); });
  return bakeLight(pos, nrm, ri, ROOMS, LIGHTS, null, lightTables(ROOMS, LIGHTS));
}

test('light: lit cabin P > 0 with daylight, windowless store D = 0, emergency-only corridor E > 0 and P = 0', () => {
  const o = bakeAt([[1.5, 0, 1.0, 'cabin'], [4.5, 0, 2, 'store'], [3, 0, 4.1, 'corr']]);
  const ch = (v) => ({ P: o[4 * v], D: o[4 * v + 1], E: o[4 * v + 2], N: o[4 * v + 3] });
  const cab = ch(0), st = ch(1), co = ch(2);
  assert.ok(cab.P > 0.2, `cabin P ${cab.P}`); assert.ok(cab.D > 0, `cabin D ${cab.D}`);
  assert.equal(st.D, 0); assert.ok(st.P > 0);
  assert.ok(co.E > 0.1, `corridor E ${co.E}`); assert.ok(co.P < 0.2, `corridor P ${co.P} (only door bleed)`);
  // night: the cabin dims (positive, below its day P), the store goes dark
  assert.ok(cab.N > 0 && cab.N < cab.P, `cabin night ${cab.N}`);
  assert.ok(Math.abs(st.N) < 0.05, `store night ${st.N}`);
});

test('light: the bridge is red at night (negative N), daylight falls off away from the windows', () => {
  const o = bakeAt([[5, 0, 12.5, 'bridge'], [5, 0, 10.4, 'bridge'], [5, 0, 13.8, 'bridge']]);
  assert.ok(o[3] < 0, `bridge night ${o[3]}`);
  assert.ok(o[4 + 1] > o[8 + 1], `daylight near ${o[5]} > far ${o[9]}`);
});

test('light: no channel blows out, the bake is deterministic, outside vertices get daylight only', () => {
  const pts = []; for (let i = 0; i < 40; i++) pts.push([0.2 + (i % 8) * 0.7, (i % 3) * 1.0, 0.2 + Math.floor(i / 8) * 0.8, i % 2 ? 'cabin' : 'store']);
  const a = bakeAt(pts), b = bakeAt(pts);
  assert.deepEqual([...a], [...b]);
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i]) <= 1.2, `channel ${i % 4} = ${a[i]}`);
  const pos = new Float32Array([0, 0, 0]), nrm = new Float32Array([0, 1, 0]), out = bakeLight(pos, nrm, new Int32Array([-1]), ROOMS, LIGHTS);
  assert.equal(out[1], 1);
});

test('light: mode table — day / night / emergency (§5.1)', () => {
  const d = lightMode('day'), n = lightMode('night'), e = lightMode('emergency');
  assert.equal(d.uLights, 1); assert.equal(d.uNight, 0);
  assert.equal(n.uNight, 1); assert.ok(n.uScreen < d.uScreen);
  assert.equal(e.uLights, 0); assert.equal(e.uEmerg, 1); assert.ok(e.uAmb < d.uAmb);
  assert.ok(lightMode('day', { dayK: 0 }).uDay === 0 && lightMode('day', { dayK: 1, gloomK: 1 }).uDay < 1);
});

test('light: plan lights feed the bake (ultramax64 — every lit room gets P > 0 at its centre)', () => {
  const p = planFromGA('ultramax64');
  const rooms = p.rooms.filter((r) => !r.open && r.walk !== false && p.lights.some((l) => l.room === r.id && !l.em)).slice(0, 80);
  const pos = new Float32Array(rooms.length * 3), nrm = new Float32Array(rooms.length * 3), ri = new Int32Array(rooms.length);
  rooms.forEach((r, i) => { pos.set([(r.x0 + r.x1) / 2, r.y + 0.8, (r.z0 + r.z1) / 2], 3 * i); nrm.set([0, 1, 0], 3 * i); ri[i] = p.rooms.indexOf(r); });
  const o = bakeLight(pos, nrm, ri, p.rooms, p.lights, null, lightTables(p.rooms, p.lights, p.doors));
  for (let i = 0; i < rooms.length; i++) assert.ok(o[4 * i] > 0.05, `${rooms[i].id} P ${o[4 * i]}`);
});

test('atlas: ≥ 40 tiles in one 8 × 8 grid, unique ids, every tile has a rect', () => {
  assert.ok(TILES.length >= 40 && TILES.length <= GRID * GRID, `${TILES.length} tiles`);
  assert.equal(new Set(TILES.map((t) => t.id)).size, TILES.length);
  for (const t of TILES) { const [u, v, du, dv] = tileRect(t.id); assert.ok(u >= 0 && v >= 0 && u + du <= 1 && v + dv <= 1 && du > 0, t.id); }
  assert.equal(tileOf('no_such_tile'), TILE_INDEX.get('paint_grey'));
});
