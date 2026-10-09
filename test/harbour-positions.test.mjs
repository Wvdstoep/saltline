// Harbour position audit (scripts/audit-harbours.mjs → server/harbor-positions.js). Player report (Gdynia): the game
// harbour — berth guidance, the synthetic quay, the chart marker — lay ~4.6 km offshore in open water while the real
// port (detail tiles, AIS ships at the real quays) is to the west. Every harbour anchor must be berth-able water inside
// the real commercial port per the recorded evidence, with an approach, a roads point on open water and a port area;
// moved harbours rebuild their patches / OSM street layer / route table, and saved ships docked there move with them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { World } from '../server/world.js';
import { HARBORS, CHANNELS, carvingsForWorld, harborById, applyHarborPositions } from '../server/harbors.js';
import { HARBOR_POSITIONS } from '../server/harbor-positions.js';
import { BIG_PORTS } from '../server/bigports.js';
import { buildGraph } from '../server/lanes.js';
import { planRoute } from '../server/searoute.js';
import { routesKey } from '../server/routetable.js';
import { relocateDocked, shouldRelocate, HARBOUR_MOVE } from '../server/harbormove.js';
import * as osm from '../server/osm.js';
import * as hg from '../server/harborgeom.js';
import { Game } from '../server/game.js';
import { haversine, destination } from '../shared/geo.js';

process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
const world = new World().load(carvingsForWorld(), () => {});
const NEED_DEPTH = { mega: 14, major: 12, regional: 8, minor: 5 };
/** An anchor must lie within this of a real quay (OSM man_made=quay or a quay edge of the detail tiles). */
const QUAY_N_M = 800;
const audited = HARBORS.filter((h) => HARBOR_POSITIONS[h.id] && !HARBOR_POSITIONS[h.id].kept);

test('every harbour is audited: positioned from the evidence, or kept with a stated reason', () => {
  const missing = HARBORS.filter((h) => !HARBOR_POSITIONS[h.id]).map((h) => h.id);
  assert.deepEqual(missing, []);
  const big = new Set(BIG_PORTS.map((p) => p.harbor));
  for (const h of HARBORS) {
    const a = HARBOR_POSITIONS[h.id];
    if (a.kept) { assert.ok(typeof a.kept === 'string' && a.kept.length > 10, `${h.id}: reason`); assert.equal(h.prev, undefined, `${h.id}: kept harbours do not move`); continue; }
    assert.ok(!big.has(h.id), `${h.id}: big ports keep their anchor (sub-patch grid)`);
  }
  assert.ok(audited.length >= 300, `${audited.length} harbours positioned from the detail tiles`);
  const kept = HARBORS.filter((h) => HARBOR_POSITIONS[h.id].kept && !big.has(h.id)).map((h) => h.id);
  assert.ok(kept.length <= 12, `kept without being a big port: ${kept.join(', ')}`);
});

test('every audited anchor is berth-able dock water next to real quays (recorded evidence)', () => {
  for (const h of audited) {
    const a = HARBOR_POSITIONS[h.id], ev = a.ev;
    assert.ok(['high', 'medium'].includes(a.conf), `${h.id}: confidence ${a.conf}`);
    assert.ok(ev.nearestQuayM <= QUAY_N_M, `${h.id}: nearest real quay ${ev.nearestQuayM} m`);
    assert.ok(ev.quayM >= 150 || ev.dockHa >= 3, `${h.id}: ${ev.quayM} m of quays / ${ev.dockHa} ha of docks within 1 km`);
    assert.ok(ev.depthM >= 0.4 * NEED_DEPTH[h.size], `${h.id}: ${ev.depthM} m at the anchor (${h.size})`);
    assert.ok(ev.clearM >= 10, `${h.id}: ${ev.clearM} m clear of structures`);
    // the recorded move is the distance from the old position to the anchor in HARBORS
    assert.ok(Math.abs(haversine(a.prev[0], a.prev[1], h.lat, h.lon) - a.movedM) < 5, `${h.id}: movedM`);
    // the port area holds the anchor (bbox, 300 m margin)
    const [la0, lo0, la1, lo1] = a.area, m = 0.003 / Math.cos((h.lat * Math.PI) / 180);
    assert.ok(h.lat >= la0 - 0.003 && h.lat <= la1 + 0.003 && h.lon >= lo0 - m && h.lon <= lo1 + m, `${h.id}: anchor outside its port area`);
  }
  const deep = audited.filter((h) => HARBOR_POSITIONS[h.id].ev.depthM >= NEED_DEPTH[h.size]).length;
  assert.ok(deep / audited.length > 0.9, `${deep}/${audited.length} anchors deep enough for the harbour's ships`);
});

test('Gdynia: the harbour lies in the real port (within 1 km of 54.53 N 18.55 E), not 4.6 km offshore', () => {
  const g = harborById('gdynia');
  assert.ok(haversine(g.lat, g.lon, 54.53, 18.55) < 1000, `${g.lat}, ${g.lon}`);
  assert.ok(haversine(g.prev.lat, g.prev.lon, 54.525, 18.625) < 1, 'the old position is recorded');
  assert.ok(haversine(g.lat, g.lon, g.prev.lat, g.prev.lon) > 4000);
  assert.ok(g.approach && Number.isFinite(g.approach.hdg) && g.roads && g.area?.bbox, 'approach, roads and port area');
  assert.ok(haversine(g.lat, g.lon, 54.53, 18.56) < 1500, 'next to the AIS gazetteer port PLGDY');
});

test('approach, entrance, roads and way: the roads is open water on the raw raster; the way joins anchor and roads', () => {
  const raw = new World().load(CHANNELS.map((ch) => ({ type: 'channel', pts: ch.pts, widthM: ch.widthM })), () => {});
  for (const h of audited) {
    // open water (≥ 12 m, water 600 m round) found from the way out; river ports whose old point was kept as the roads: water
    const need = /old position/.test(h.audit.roads) ? 2 : 11.5;   // 12 m before rounding to 1e-5°
    assert.ok(h.roads && raw.depthAt(h.roads.lat, h.roads.lon) >= need, `${h.id}: roads ${raw.depthAt(h.roads.lat, h.roads.lon).toFixed(1)} m (${h.audit.roads})`);
    assert.ok(h.approach && Number.isFinite(h.approach.hdg) && h.entrance, `${h.id}: approach / entrance`);
    assert.ok(Array.isArray(h.way) && h.way.length >= 1 && h.way.length <= 12, `${h.id}: way`);
    const last = h.way[h.way.length - 1];
    assert.ok(haversine(last.lat, last.lon, h.roads.lat, h.roads.lon) < 1, `${h.id}: the way ends at the roads`);
    let len = 0, p = h; for (const q of h.way) { len += haversine(p.lat, p.lon, q.lat, q.lon); p = q; }
    assert.ok(len < 40000, `${h.id}: way ${Math.round(len)} m`);
    assert.ok(world.depthAt(h.lat, h.lon) >= 9, `${h.id}: the anchor is carved into the raster`);
  }
});

test('lane graph: audited harbours reach the lanes along their way out to the roads', () => {
  const graph = buildGraph(world);
  for (const h of audited) {
    const n = h.way.length, roads = graph.nodes.get(`${h.id}~${n}`);
    assert.ok(roads && roads.roads, `${h.id}: roads node`);
    assert.ok((graph.adj.get(h.id) || []).some((e) => e.to === `${h.id}~1`), `${h.id}: harbour → way`);
    assert.ok((graph.adj.get(roads.id) || []).some((e) => !e.to.startsWith(h.id + '~')), `${h.id}: roads → lanes`);
  }
  const r = graph.route('hamburg', 'gdynia');
  assert.ok(r && r.length > 3);
  const g = harborById('gdynia');
  assert.ok(r.some(([la, lo]) => haversine(la, lo, g.roads.lat, g.roads.lon) < 1), 'via the Gdynia roads');
});

test('route planner (water only, no patches) reaches every harbour from its neighbour', { timeout: 240000 }, () => {
  const graph = buildGraph(world);
  const bad = [];
  for (const h of HARBORS) {
    const from = HARBORS.filter((o) => o.id !== h.id).sort((a, b) => haversine(h.lat, h.lon, a.lat, a.lon) - haversine(h.lat, h.lon, b.lat, b.lon))[0];
    const r = planRoute(world, graph, { lat: from.lat, lon: from.lon }, { lat: h.lat, lon: h.lon }, { toHarbor: h.id, tss: false });
    if (!r || !r.points?.length) { bad.push(`${from.id} → ${h.id}`); continue; }
    const end = r.points[r.points.length - 1];
    if (haversine(end.lat, end.lon, h.lat, h.lon) > 50) bad.push(`${from.id} → ${h.id}: ends ${Math.round(haversine(end.lat, end.lon, h.lat, h.lon))} m off`);
  }
  assert.deepEqual(bad, []);
});

test('caches: a moved harbour gets a new route-table key, its old patch and old OSM street cache are not used', () => {
  // route table key covers the roads / way
  const k0 = routesKey();
  const g = harborById('gdynia'), keep = g.roads;
  g.roads = { lat: keep.lat + 0.01, lon: keep.lon };
  try { assert.notEqual(routesKey(), k0); } finally { g.roads = keep; }
  // OSM cache without a centre: not used for a moved harbour, used for one that did not move
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slhpos-'));
  try {
    osm.configureOSM({ dataDir: dir });
    const payload = { id: 'gdynia', schema: osm.OSM_SCHEMA, fetchedAt: Date.now(), radiusM: 3200, coastline: [], features: [] };
    fs.mkdirSync(path.join(dir, 'osm'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'osm', 'gdynia.json'), JSON.stringify(payload));
    assert.ok(osm.loadCachedOSM('gdynia'), 'readable');
    assert.equal(osm.loadCachedOSM('gdynia', g), null, 'fetched round the old spot');
    assert.ok(osm.loadCachedOSM('gdynia', { lat: g.lat, lon: g.lon }), 'unmoved harbour keeps its cache');
    fs.writeFileSync(path.join(dir, 'osm', 'gdynia.json'), JSON.stringify({ ...payload, center: { lat: g.lat, lon: g.lon } }));
    assert.ok(osm.loadCachedOSM('gdynia', g), 'fetched round the new anchor');
  } finally { osm.configureOSM({ dataDir: process.env.SALTLINE_DATA }); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('harbour patches: a cached patch built round the old position is not loaded for a moved harbour', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slhgeom-'));
  const g = harborById('gdynia');
  try {
    hg.configure({ dataDir: dir, offline: true, preload: false, log: () => {} });
    hg.init(world);
    const old = { ...g, lat: g.prev.lat, lon: g.prev.lon };
    const b = hg.buildSynthetic(old, world);
    assert.ok(b && b.geom, 'synthetic build');
    fs.mkdirSync(path.join(dir, 'geom'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'geom', 'gdynia.json'), JSON.stringify({ version: hg.GEOM_VERSION, builtAt: Date.now(), source: 'tiles', geom: b.geom }));
    fs.writeFileSync(path.join(dir, 'geom', 'gdynia.bin'), hg.encodePatch({ n: b.geom.n, res: b.geom.res, originLat: old.lat, originLon: old.lon, synthetic: false, heights: b.heights, mask: b.mask }));
    hg.resetCache();
    assert.equal(hg.getHarborGeom('gdynia'), null, 'the old patch is stale');
    const a = hg.harborAnchor('gdynia');
    assert.ok(haversine(a.lat, a.lon, g.lat, g.lon) < 1, 'the anchor answers the new position until rebuilt');
  } finally { hg.configure({ dataDir: process.env.SALTLINE_DATA }); hg.resetCache(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('saved ships: docked at a moved harbour they move with it; dock-anywhere quays and other ships stay', () => {
  const g = harborById('gdynia');
  const recs = [
    { id: 'a', docked: 'gdynia', ship: { lat: g.prev.lat + 0.002, lon: g.prev.lon, hdg: 10, spd: 0 }, berth: { id: 'gdynia-b3', lat: g.prev.lat, lon: g.prev.lon } },
    { id: 'q', docked: 'gdynia', ship: { lat: g.prev.lat, lon: g.prev.lon }, berth: { id: 'quay', quay: true } },
    { id: 'n', docked: 'gdynia', ship: { lat: g.lat + 0.001, lon: g.lon } },
    { id: 's', docked: null, ship: { lat: g.prev.lat, lon: g.prev.lon } },
    { id: 'r', docked: 'rotterdam', ship: { lat: 51.98, lon: 4.03 } },
  ];
  assert.equal(relocateDocked(recs, harborById), 1);
  assert.ok(haversine(recs[0].ship.lat, recs[0].ship.lon, g.lat, g.lon) < 1 && recs[0].berth === null && recs[0].docked === 'gdynia');
  assert.deepEqual(recs[0].lastValid, { lat: g.lat, lon: g.lon });
  assert.equal(recs[1].ship.lat, g.prev.lat); assert.equal(recs[3].ship.lat, g.prev.lat); assert.equal(recs[4].ship.lat, 51.98);
  assert.equal(shouldRelocate({ docked: 'gdynia', ship: destination(g.prev.lat, g.prev.lon, 90, HARBOUR_MOVE.NEAR_PREV_M + 500) }, g), false, 'far from both: left alone');
});

test('saved state: a player and a fleet ship docked at old Gdynia load docked at the new anchor', () => {
  const g = harborById('gdynia');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slhstate-'));
  const stateFile = path.join(dir, 'state.json');
  try {
    // a state saved by the old server: create it with a game, then move the ships to the old harbour position
    const g0 = new Game(world, () => {}, { stateFile: path.join(dir, 'none.json') });
    const ws = { readyState: 1, send() {}, close() {} };
    const p = g0.connect(ws, null, 'Kapitan');
    const hold = { lat: g.prev.lat + 0.001, lon: g.prev.lon - 0.001 };
    p.docked = 'gdynia'; p.berth = { id: 'gdynia-b1', lat: hold.lat, lon: hold.lon, hdg: 90 }; Object.assign(p.ship, hold);
    g0.stateFile = stateFile; g0.saveState();
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const rec = s.players.find((x) => x.name === 'Kapitan');
    for (const v of rec.fleet || []) { v.docked = 'gdynia'; v.berth = { id: 'gdynia-b1', lat: hold.lat, lon: hold.lon, hdg: 90 }; Object.assign(v.ship, hold); }
    if (rec.fleet) rec.fleet.push({ ...JSON.parse(JSON.stringify(rec.fleet[0])), id: 'vfleet2', name: 'Second' });
    fs.writeFileSync(stateFile, JSON.stringify(s));
    const g1 = new Game(world, () => {}, { stateFile });
    g1.saveState = () => {};
    const q = [...g1.players.values()].find((x) => x.name === 'Kapitan');
    assert.equal(q.docked, 'gdynia');
    assert.ok(haversine(q.ship.lat, q.ship.lon, g.lat, g.lon) < 1, `player at ${q.ship.lat}, ${q.ship.lon}`);
    assert.equal(q.berth, null);
    const fleet = [...g1.fleet.vessels.values()].filter((v) => v.ownerId === q.id);
    assert.ok(fleet.length >= 2);
    for (const v of fleet) { assert.equal(v.docked, 'gdynia'); assert.ok(haversine(v.ship.lat, v.ship.lon, g.lat, g.lon) < 1, `${v.id} moved`); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('applyHarborPositions: merges the audited fields, leaves kept harbours untouched', () => {
  const list = [{ id: 'x', lat: 1, lon: 2 }, { id: 'y', lat: 3, lon: 4 }];
  applyHarborPositions(list, { x: { prev: [1.1, 2.1], approach: [1.01, 2.01, 270], entrance: [1.005, 2.005], roads: [1.02, 2.03], way: [[1.005, 2.005], [1.02, 2.03]], area: [0.9, 1.9, 1.1, 2.1], hull: [[0.9, 1.9]], conf: 'high', movedM: 15000 }, y: { kept: 'reason' } });
  assert.deepEqual(list[0].approach, { lat: 1.01, lon: 2.01, hdg: 270 });
  assert.deepEqual(list[0].roads, { lat: 1.02, lon: 2.03 });
  assert.equal(list[0].way.length, 2); assert.deepEqual(list[0].prev, { lat: 1.1, lon: 2.1 });
  assert.deepEqual(list[0].area.bbox, [0.9, 1.9, 1.1, 2.1]);
  assert.equal(list[1].roads, undefined); assert.equal(list[1].prev, undefined);
});
