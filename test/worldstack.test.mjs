// The physics merge (server/worldstack.js, docs/WORLD-DETAIL-STREAMING.md §3.6): layer precedence, isWater vs the tile
// mask, landPenetration through the geometry facade, the tile-swap grace rule, and — with the tiles offline — every
// existing world / geom answer unchanged (2 000-point snapshot against the real raster and a built harbour patch).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorldStack, geomFacade, handleTileSwap, guardGrounding, nearestDeep, shipsOf, SWAP_GRACE_MS } from '../server/worldstack.js';
import { createWorldTiles, inlineConverter, PRIO } from '../server/worldtiles.js';
import { createSources } from '../server/wtsource.js';
import { World } from '../server/world.js';
import { carvingsForWorld } from '../server/harbors.js';
import * as harborgeom from '../server/harborgeom.js';
import { WT, WT_NAVIGABLE, tileFToLatLon, cellLatLon, tileHeightAt } from '../shared/wtformat.js';
import { haversine } from '../shared/geo.js';
import { encodeMVT } from './fixtures/wt/mvtenc.mjs';

const silent = () => {};
const made = [];
const tmpDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'saltline-ws-')); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const sq = (x0, y0, x1, y1) => [x0, y0, x1, y0, x1, y1, x0, y1];
const coastAt = (u) => encodeMVT({ layers: { water: { extent: 4096, features: [{ type: 3, tags: { class: 'ocean' }, geom: [[sq(-64, -64, u, 4160)]] }] } } });
const T = { x: 8300, y: 5380 };     // North Sea coast tile: inside the L1 region raster, away from the big-port boxes

function res(status, body) { const b = Buffer.isBuffer(body) || body instanceof Uint8Array ? Buffer.from(body) : Buffer.from(JSON.stringify(body ?? '')); return { status, headers: { get: () => null }, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }; }
/** A tile service whose source serves a coast at x = coastU (tile units), changeable between builds. */
function tiles(opts = {}) {
  const state = { coastU: 2048 };
  const fetchImpl = async (url) => {
    if (url === 'https://tiles.openfreemap.org/planet') return res(200, { tiles: ['https://tiles.openfreemap.org/planet/A/{z}/{x}/{y}.pbf'] });
    if (url.includes('/planet/A/')) return res(200, coastAt(state.coastU));
    return res(404, null);
  };
  const dataDir = tmpDir();
  const wt = createWorldTiles({ dataDir, offline: false, log: silent, converter: inlineConverter(), sources: createSources({ fetchImpl, dataDir, offline: false, log: silent, ofmPerSec: 1000 }), ...opts });
  return { wt, state };
}

test('precedence: patch > D14 > L1 region > C11 > L0 global (heightAt, isWater, detailAt)', () => {
  const world = { layers: [{}, { contains: (lat) => lat > 50 }], charts: {}, layerFor: () => null, tile: () => null, chartPNG: () => null,
    heightAt: (lat) => (lat > 50 ? -50 : -100), nearestWater: (lat, lon) => ({ lat, lon }) };
  const loaded = { 14: false, 11: false };
  const wt = { heightAt: (lat, lon, { z }) => (loaded[z] ? (z === 14 ? -14 : -11) : null) };
  let patch = null;
  const geom = { patchHeightAt: () => patch, landPenetration: () => null };
  const s = createWorldStack(world, { geom, wt });
  assert.deepEqual([s.heightAt(55, 0), s.detailAt(55, 0)], [-50, 'region']);
  assert.deepEqual([s.heightAt(40, 0), s.detailAt(40, 0)], [-100, 'global']);
  loaded[11] = true;
  assert.deepEqual([s.heightAt(40, 0), s.detailAt(40, 0)], [-11, 'c11']);
  assert.deepEqual([s.heightAt(55, 0), s.detailAt(55, 0)], [-50, 'region'], 'L1 beats C11 inside the region');
  loaded[14] = true;
  assert.deepEqual([s.heightAt(55, 0), s.detailAt(55, 0)], [-14, 'd14']);
  assert.equal(s.depthAt(55, 0), 14); assert.equal(s.isWater(55, 0), true);
  patch = -3;
  assert.equal(s.detailAt(55, 0), 'patch');
  assert.equal(s.layers, world.layers);
});

test('isWater agrees with the D14 mask at every cell centre; nearestWater uses the tile when loaded', async () => {
  const { wt } = tiles();
  const world = new World().load(carvingsForWorld(), silent);
  const s = createWorldStack(world, { geom: harborgeom, wt });
  const t = await wt.request(14, T.x, T.y, PRIO.P0);
  assert.ok(t.mask);
  for (let j = 0; j < 256; j += 5) for (let i = 0; i < 256; i += 3) {
    const ll = cellLatLon(14, T.x, T.y, i, j);
    assert.equal(s.isWater(ll.lat, ll.lon), WT_NAVIGABLE[t.mask[j * 256 + i]] === 1, `cell ${i},${j}`);
  }
  const land = cellLatLon(14, T.x, T.y, 140, 128);
  const w = s.nearestWater(land.lat, land.lon, 20);
  assert.ok(s.depthAt(w.lat, w.lon) > 6);
  assert.ok(haversine(land.lat, land.lon, w.lat, w.lon) < 200, 'found within the D14 tile, not a 5 km raster cell away');
  assert.equal(s.detailAt(land.lat, land.lon), 'd14');
  wt.close();
});

test('landPenetration through the facade: the patch answers inside it, the D14 obstacle outside, null in water / unloaded / grace', async () => {
  let now = 1e12;
  const { wt, state } = tiles({ now: () => now });
  let patchPen = null;
  const geom = { landPenetration: () => patchPen, ensureHarbor: async () => ({ ok: 1 }), geomHarbor: () => ({ lat: 52, lon: 4 }) };
  const f = geomFacade(geom, wt, { now: () => now, ensureTimeoutMs: 100 });
  const land = cellLatLon(14, T.x, T.y, 200, 128), sea = cellLatLon(14, T.x, T.y, 40, 128);
  assert.equal(f.landPenetration(land.lat, land.lon), null, 'tile not loaded');
  await wt.request(14, T.x, T.y, PRIO.P0);
  assert.ok(f.landPenetration(land.lat, land.lon) > 300);
  assert.equal(f.landPenetration(sea.lat, sea.lon), null, 'open D14 water is left to the depth check');
  patchPen = 0;
  assert.equal(f.landPenetration(land.lat, land.lon), 0, 'a built patch keeps precedence');
  patchPen = null;
  // the coast moves east under the ship: grace window after the swap
  state.coastU = 3000;
  await wt.request(14, T.x, T.y, PRIO.P0, { force: true });
  const moved = cellLatLon(14, T.x, T.y, 160, 128);       // land before, water now
  assert.equal(f.landPenetration(moved.lat, moved.lon), null, 'grace after a swap');
  assert.ok(wt.swappedAt(moved.lat, moved.lon) === now);
  now += SWAP_GRACE_MS + 1;
  assert.equal(f.landPenetration(moved.lat, moved.lon), null, 'now water');
  const stillLand = cellLatLon(14, T.x, T.y, 230, 128);
  assert.ok(f.landPenetration(stillLand.lat, stillLand.lon) > 0);
  assert.deepEqual(await f.ensureHarbor('x'), { ok: 1 });
  wt.close();
});

test('tile swap under ships: the stranded one is moved ≤ 300 m to water deep enough, told why, never damaged; docked ships untouched', async () => {
  let now = 1e12;
  const { wt, state } = tiles({ now: () => now });
  const world = new World().load(carvingsForWorld(), silent);
  const stack = createWorldStack(world, { geom: harborgeom, wt });
  state.coastU = 3000;
  await wt.request(14, T.x, T.y, PRIO.P0);
  const at = cellLatLon(14, T.x, T.y, 145, 128), dockedAt = cellLatLon(14, T.x, T.y, 150, 100);   // ≈ 100 m inland of the real coast
  const sent = [], events = [];
  let grounded = 0;
  const players = [
    { id: 'p1', online: true, ship: { lat: at.lat, lon: at.lon, cls: 'coaster', spd: 6, hdg: 90 }, lastValid: null },
    { id: 'p2', online: true, docked: 'somewhere', ship: { lat: dockedAt.lat, lon: dockedAt.lon, cls: 'coaster', spd: 0 } },
  ];
  const vessel = { id: 'v9', ship: { lat: at.lat, lon: at.lon - 0.0003, cls: 'tug', spd: 4 }, docked: null };
  const game = { byId: new Map(players.map((p) => [p.id, p])), fleet: { vessels: new Map([['v9', vessel]]) },
    sendYou: (p, x) => sent.push([p.id, x]), event: (p, k, text) => events.push([p.id, k, text]), grounding: () => { grounded++; } };
  assert.equal(shipsOf(game).length, 3);
  const swaps = [];
  wt.onSwap((ev) => swaps.push(handleTileSwap(game, stack, wt, ev)));
  guardGrounding(game, wt, { now: () => now });
  state.coastU = 2048;      // the real coast is further west: the ships now sit on land
  await wt.request(14, T.x, T.y, PRIO.P0, { force: true });
  assert.equal(swaps.length, 1);
  const moved = swaps[0];
  assert.deepEqual(moved.map((m) => m.id).sort(), ['p1', 'v9']);
  for (const m of moved) assert.ok(m.movedM <= 300, `moved ${m.movedM} m`);
  const p1 = players[0];
  assert.ok(stack.depthAt(p1.ship.lat, p1.ship.lon) >= 5.5 + 1, 'depth ≥ draught + 1');
  assert.equal(p1.ship.spd, 0);
  assert.deepEqual(p1.lastValid, { lat: p1.ship.lat, lon: p1.ship.lon });
  assert.deepEqual(sent, [['p1', { correction: true }]]);
  assert.equal(events.length, 1); assert.match(events[0][2], /^Chart corrected: your position was moved \d+ m to open water\.$/);
  assert.deepEqual([players[1].ship.lat, players[1].ship.lon], [dockedAt.lat, dockedAt.lon], 'docked ship untouched');
  assert.ok(stack.depthAt(vessel.ship.lat, vessel.ship.lon) >= 5 + 1);
  game.grounding(p1);
  assert.equal(grounded, 0, 'no grounding within the grace window');
  now += SWAP_GRACE_MS + 1;
  game.grounding(p1);
  assert.equal(grounded, 1);
  assert.equal(nearestDeep(wt, at.lat, at.lon, 1000, 300), null, 'nothing that deep');
  wt.close();
});

test('with the tiles offline every existing world / geom answer is unchanged (2 000 random points + a built patch)', async () => {
  const world = new World().load(carvingsForWorld(), silent);
  const dataDir = tmpDir();
  const wt = createWorldTiles({ dataDir, log: silent, converter: inlineConverter() });     // NODE_TEST_CONTEXT → offline
  assert.equal(wt.offline, true);
  const stack = createWorldStack(world, { geom: harborgeom, wt });
  const facade = geomFacade(harborgeom, wt);
  harborgeom.configure({ dataDir: tmpDir(), offline: true, preload: false });   // build into a temp dir, never into data/
  harborgeom.init(world);
  const g = await harborgeom.ensureHarbor('ijmuiden');
  assert.ok(g, 'a harbour patch is built (offline: from cache or synthetic)');
  await facade.ensureHarbor('ijmuiden');
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pts = [];
  for (let k = 0; k < 1500; k++) pts.push([-80 + rnd() * 160, -180 + rnd() * 360]);
  for (let k = 0; k < 400; k++) pts.push([48 + rnd() * 14, -8 + rnd() * 22]);                       // the L1 window
  for (let k = 0; k < 100; k++) pts.push([52.465 + (rnd() - 0.5) * 0.05, 4.555 + (rnd() - 0.5) * 0.08]);   // the patch
  for (const [lat, lon] of pts) {
    assert.equal(stack.heightAt(lat, lon), world.heightAt(lat, lon));
    assert.equal(stack.depthAt(lat, lon), world.depthAt(lat, lon));
    assert.equal(stack.isWater(lat, lon), world.isWater(lat, lon));
    assert.equal(facade.landPenetration(lat, lon), harborgeom.landPenetration(lat, lon));
  }
  for (const [lat, lon] of pts.slice(0, 200)) assert.deepEqual(stack.nearestWater(lat, lon, 10), world.nearestWater(lat, lon, 10));
  assert.ok(pts.slice(1900).some(([lat, lon]) => harborgeom.landPenetration(lat, lon) != null), 'some points inside the patch');
  assert.equal(stack.tile(0, 3, 4)?.length, world.tile(0, 3, 4)?.length);
  wt.close();
});
