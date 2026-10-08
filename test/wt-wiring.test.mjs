// World-tile wiring (docs/WORLD-STREAMING-WIRING.md): the disk cap (600 MB default, shrinks with the free space on the
// volume), the switched-off service (SALTLINE_WT=0), upstream base overrides (local stub / mirror), the raster cache
// prune (phase 1b, world.js) and harbour patches built from D14 tiles (phase 1b, harborgeom.js: buildFromTiles,
// GEOM_VERSION 6, old v5 patches served until the background rebuild replaces them, busy harbours left alone).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorldTiles, inlineConverter, disabledTiles, DEFAULT_CACHE_MB } from '../server/worldtiles.js';
import { createSources } from '../server/wtsource.js';
import { World, pruneRasterCache } from '../server/world.js';
import { carvingsForWorld } from '../server/harbors.js';
import * as harborgeom from '../server/harborgeom.js';
import { WT, WT_OBSTACLE, tilesInRadius, cellOf, tileMaskAt, tileHeightAt } from '../shared/wtformat.js';
import { PATCH, GEO } from '../shared/constants.js';
import { loadPortFixture, FIXTURE_DIR } from './fixtures/wt/lib.mjs';

const silent = () => {};
const made = [];
const tmpDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'saltline-wtw-')); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const MB = 1048576;

// ------------------------------------------------------------------------------------------------ disk cap
test('disk cap: 600 MB by default, never more than the volume can spare (free − reserve), floor 32 MB', () => {
  assert.equal(DEFAULT_CACHE_MB, 600);
  const big = createWorldTiles({ dataDir: tmpDir(), log: silent, converter: inlineConverter(), freeBytes: () => 100e9 });
  assert.equal(Math.round(big.capMB()), 600);
  assert.equal(big.stats().capMB, 600);
  big.close();
  const tight = createWorldTiles({ dataDir: tmpDir(), log: silent, converter: inlineConverter(), reserveMB: 400, freeBytes: () => 500 * MB });
  assert.equal(Math.round(tight.capMB()), 100, '500 MB free − 400 MB reserve');
  tight.close();
  const full = createWorldTiles({ dataDir: tmpDir(), log: silent, converter: inlineConverter(), reserveMB: 400, freeBytes: () => 10 * MB });
  assert.equal(Math.round(full.capMB()), 32, 'floor');
  full.close();
  const env = createWorldTiles({ dataDir: tmpDir(), log: silent, converter: inlineConverter(), cacheMB: 200, freeBytes: () => 100e9 });
  assert.equal(Math.round(env.capMB()), 200);
  env.close();
});

// ------------------------------------------------------------------------------------------------ SALTLINE_WT=0
test('switched off: no tile ever, /api/wt answers 404 fallback, health says disabled', async () => {
  const wt = disabledTiles();
  assert.equal(wt.enabled, false);
  assert.deepEqual(await wt.ensureAround(51.9, 4.1, 3000, 0, { timeoutMs: 10 }), { ready: 0, total: 0 });
  const a = await wt.serveTile(14, 8380, 5400);
  assert.equal(a.status, 404); assert.equal(a.headers['X-WT'], 'fallback'); assert.equal(a.body, null);
  assert.equal(await wt.request(14, 1, 1, 0), null);
  assert.equal(wt.heightAt(51.9, 4.1), null); assert.equal(wt.landPenetration(51.9, 4.1), null); assert.equal(wt.swappedAt(51.9, 4.1), 0);
  assert.equal(wt.meta().disabled, true); assert.equal(wt.meta().offline, true);
  assert.equal(wt.stats().disabled, true); assert.equal(wt.healthy(), false);
  assert.equal(typeof wt.onSwap(() => {}), 'function');
  wt.flushIndex(); wt.close();
});

// ------------------------------------------------------------------------------------------------ upstream overrides
test('upstream base overrides: TileJSON, tiles and Terrarium come from the configured base (stub / mirror)', async () => {
  const calls = [];
  const body = (o) => { const b = Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)); return { status: 200, headers: { get: () => null }, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }; };
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === 'http://127.0.0.1:1/planet') return body({ tiles: ['http://127.0.0.1:1/planet/V1/{z}/{x}/{y}.pbf'] });
    if (url.startsWith('http://127.0.0.1:1/planet/V1/')) return body('x');
    return { status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  const src = createSources({ fetchImpl, dataDir: tmpDir(), offline: false, log: silent, ofmBase: 'http://127.0.0.1:1/planet/', terrariumBase: 'http://127.0.0.1:1/terrarium' });
  const r = await src.fetchBase(14, 10, 20);
  assert.equal(r.ok, true); assert.equal(r.src, 'ofm:V1');
  await src.fetchBathy(3, 4);
  assert.deepEqual(calls, ['http://127.0.0.1:1/planet', 'http://127.0.0.1:1/planet/V1/14/10/20.pbf', 'http://127.0.0.1:1/terrarium/9/3/4.png']);
});

// ------------------------------------------------------------------------------------------------ raster cache prune
test('pruneRasterCache keeps the files the World loaded, the route table in use and the newest one; drops the rest', () => {
  const dir = tmpDir();
  const w = (f, bytes = 1000, ageS = 0) => { const p = path.join(dir, f); fs.writeFileSync(p, Buffer.alloc(bytes)); const t = Date.now() / 1000 - ageS; fs.utimesSync(p, t, t); return p; };
  const g = w('global-0.05-v6-abc123.bin'), r = w('region-0.005-v6-abc123.bin');
  w('global-0.05-v6-01d0.bin', 2 * MB); w('region-0.005-v5-01d0.bin', MB); w('global-0.05-v4-1.bin');
  const inUse = w('sea-routes-v1-00000001.json', 10, 3000), newest = w('sea-routes-v1-00000002.json', 10, 10);
  w('sea-routes-v1-00000003.json', 10, 5000);
  w('market-history.json'); w('notes.txt');
  assert.deepEqual(pruneRasterCache({ cacheFiles: [] }, silent, { dir }), { removed: 0, freedMB: 0 }, 'never before a load');
  const logs = [];
  const out = pruneRasterCache({ cacheFiles: [g, r] }, (m) => logs.push(m), { dir, keep: [inUse] });
  assert.equal(out.removed, 4); assert.equal(out.freedMB, 3);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['global-0.05-v6-abc123.bin', 'market-history.json', 'notes.txt', 'region-0.005-v6-abc123.bin', path.basename(inUse), path.basename(newest)].sort());
  assert.match(logs[0], /pruned 4 stale cache files/);
  assert.deepEqual(pruneRasterCache({ cacheFiles: [g] }, silent, { dir: path.join(dir, 'missing') }), { removed: 0, freedMB: 0 }, 'no dir: no throw');
});

test('World.load records the cache files it used', () => {
  const world = new World().load(carvingsForWorld(), silent);
  assert.equal(world.cacheFiles.length, world.layers.length);
  for (const f of world.cacheFiles) assert.ok(fs.existsSync(f), f);
});

// ------------------------------------------------------------------------------------------------ patches from tiles
// Antwerp's recorded D14 tiles (16 of the 24 under the patch), the rest filled with uniform 12 m water: the patch must
// follow the tiles where they are real.
const HARBOR = { id: 'antwerp', name: 'Antwerp', lat: 51.2794, lon: 4.3266, size: 'mega' };
let fixture = null;
function antwerpTiles(harbor) {
  fixture ||= loadPortFixture(FIXTURE_DIR, { id: 'antwerp' });
  const tiles = new Map(), real = new Set();
  for (const t of tilesInRadius(14, harbor.lat, harbor.lon, harborgeom.PATCH_TILE_RADIUS_M)) {
    const k = `${t.x}/${t.y}`, f = fixture.tiles.get(k);
    if (f) { tiles.set(k, f); real.add(k); } else tiles.set(k, { z: 14, x: t.x, y: t.y, n: WT.N, flags: WT.FLAG.UNIFORM, uniformH: -12, mask: null, height: null, vectors: null, rev: 0 });
  }
  return { tiles, real };
}
let worldOnce = null;
const theWorld = () => (worldOnce ||= new World().load(carvingsForWorld(), silent));

test('buildFromTiles: the patch mask is the D14 mask, never shallower than the tile, berths on the tile quays', () => {
  const world = theWorld();
  const h = harborgeom.geomHarbor('antwerp') || HARBOR;
  const { tiles, real } = antwerpTiles(h);
  assert.ok(real.size >= 10, `recorded tiles under the patch: ${real.size}`);
  const b = harborgeom.buildFromTiles(h, tiles, null, world);
  assert.ok(b, 'built');
  assert.equal(b.geom.source, 'tiles'); assert.equal(b.geom.version, 6); assert.equal(harborgeom.GEOM_VERSION, 6);
  assert.ok(b.geom.berths.length >= 2, `berths ${b.geom.berths.length}`);
  assert.ok(b.geom.features.quays.length > 0, 'quays from the tile vectors');
  assert.ok(Array.isArray(b.geom.features.pois) && b.geom.features.pois.length > 0, 'street layer synthesized without OSM');
  // agreement obstacle / water on the real tiles (the fairway, synthetic quays and shallows may differ a little)
  const n = b.geom.n, res = b.geom.res, M = PATCH.MASK;
  const kLon = GEO.M_PER_DEG_LON_EQ * Math.cos(h.lat * Math.PI / 180);
  let same = 0, total = 0, shallower = 0, water = 0;
  for (let j = 2; j < n; j += 4) for (let i = 2; i < n; i += 4) {
    const lat = h.lat - ((j + 0.5 - n / 2) * res) / GEO.M_PER_DEG_LAT, lon = h.lon + ((i + 0.5 - n / 2) * res) / kLon;
    const c = cellOf(14, lat, lon), key = `${c.x}/${c.y}`;
    if (!real.has(key)) continue;
    const t = tiles.get(key), m = tileMaskAt(t, c.u, c.v), pm = b.mask[j * n + i];
    const pObs = pm === M.LAND || pm === M.QUAY || pm === M.BREAKWATER || pm === M.PONTOON;
    total++; if (pObs === !!WT_OBSTACLE[m]) same++;
    const th = tileHeightAt(t, c.u, c.v);
    if (!pObs && !WT_OBSTACLE[m] && th < -1 && pm !== M.SHALLOW) { water++; if (harborgeom.decodePatchHeight(b.heights[j * n + i]) > Math.max(th, -32) + 0.3) shallower++; }   // patch heights stop at −32 m
  }
  assert.ok(total > 500, `sampled ${total}`);
  assert.ok(same / total >= 0.9, `mask agreement ${(100 * same / total).toFixed(1)} %`);
  assert.ok(water > 100 && shallower / water < 0.02, `patch shallower than the tile in ${shallower}/${water} water cells`);
  // a missing tile → null (the caller falls back to the old patch / OSM / synthetic)
  const holed = new Map(tiles); holed.delete([...real][0]);
  assert.equal(harborgeom.buildFromTiles(h, holed, null, world), null);
});

test('harbour patches from tiles: ensureHarbor builds from tiles; a v5 patch serves until rebuildFromTiles replaces it; busy harbours wait', async () => {
  const world = theWorld();
  const h = harborgeom.geomHarbor('antwerp');
  assert.ok(h, 'antwerp is a game harbour');
  const { tiles } = antwerpTiles(h);
  const asked = [];
  const fakeWt = {
    enabled: true, offline: false, healthy: () => true, queued: () => 0,
    ensureAround: async (lat, lon, r, prio) => { asked.push(prio); const list = tilesInRadius(14, lat, lon, r); return { ready: list.filter((t) => tiles.has(`${t.x}/${t.y}`)).length, total: list.length }; },
    get: (z, x, y) => tiles.get(`${x}/${y}`) || null,
  };
  const dataDir = tmpDir();
  const noNet = async () => { throw new Error('no network in tests'); };
  harborgeom.configure({ dataDir, offline: false, preload: false, fetchImpl: noNet, log: silent, wt: fakeWt });
  harborgeom.init(world);
  try {
    const g = await harborgeom.ensureHarbor('antwerp');
    assert.ok(g); assert.equal(g.source, 'tiles'); assert.equal(asked[0], 0, 'P0 for a harbour someone needs now');
    const jf = path.join(dataDir, 'geom', 'antwerp.json');
    const saved = JSON.parse(fs.readFileSync(jf, 'utf8'));
    assert.equal(saved.version, 6); assert.equal(saved.source, 'tiles');
    // reload from disk (v6 tiles patch accepted)
    harborgeom.resetCache();
    assert.equal((await harborgeom.ensureHarbor('antwerp')).source, 'tiles');
    // an old v5 OSM patch: served as it is (no rebuild on demand), marked stale
    fs.writeFileSync(jf, JSON.stringify({ ...saved, version: 5, source: 'osm', geom: { ...saved.geom, source: 'osm', version: 5 } }));
    harborgeom.resetCache();
    const old = await harborgeom.ensureHarbor('antwerp');
    assert.equal(old.version, 5); assert.equal(harborgeom.stats().stale, 1);
    // busy (a ship under way nearby) → left alone
    let st = await harborgeom.rebuildFromTiles({ only: ['antwerp'], delayMs: 0, passDelayMs: 0, maxPasses: 1, busy: () => true, log: silent });
    assert.equal(st.rebuilt, 0); assert.equal(st.busy, 1);
    assert.equal(JSON.parse(fs.readFileSync(jf, 'utf8')).version, 5);
    // idle → rebuilt at P4, saved as v6
    asked.length = 0;
    st = await harborgeom.rebuildFromTiles({ only: ['antwerp'], delayMs: 0, passDelayMs: 0, maxPasses: 1, log: silent });
    assert.equal(st.rebuilt, 1); assert.equal(asked[0], 4, 'background rebuild asks at P4');
    assert.equal(harborgeom.getHarborGeom('antwerp').version, 6); assert.equal(harborgeom.stats().stale, 0);
    assert.equal(JSON.parse(fs.readFileSync(jf, 'utf8')).version, 6);
    // a second run has nothing to do
    st = await harborgeom.rebuildFromTiles({ only: ['antwerp'], delayMs: 0, passDelayMs: 0, maxPasses: 1, log: silent });
    assert.equal(st.rebuilt, 0); assert.equal(st.done, 1);
    // tiles missing (source down): ensureHarbor falls back to the old builders (here: synthetic, no OSM)
    harborgeom.resetCache();
    fs.rmSync(path.join(dataDir, 'geom'), { recursive: true, force: true });
    tiles.clear();
    const fb = await harborgeom.ensureHarbor('antwerp');
    assert.ok(fb); assert.notEqual(fb.source, 'tiles');
  } finally {
    harborgeom.configure({ wt: null, offline: true, fetchImpl: null });
  }
});

test('offline (or without a tile service) the harbour builders are unchanged: no tile is asked for', async () => {
  const asked = [];
  const fakeWt = { enabled: true, healthy: () => true, queued: () => 0, ensureAround: async () => { asked.push(1); return { ready: 0, total: 1 }; }, get: () => null };
  harborgeom.configure({ dataDir: tmpDir(), offline: true, preload: false, log: silent, wt: fakeWt });
  harborgeom.init(theWorld());
  try {
    const g = await harborgeom.ensureHarbor('ijmuiden');
    assert.ok(g); assert.notEqual(g.source, 'tiles');
    assert.equal(asked.length, 0);
    const st = await harborgeom.rebuildFromTiles({ only: ['ijmuiden'], delayMs: 0, passDelayMs: 0, maxPasses: 1, log: silent });
    assert.equal(st.rebuilt, 0); assert.equal(asked.length, 0);
  } finally { harborgeom.configure({ wt: null }); }
});
