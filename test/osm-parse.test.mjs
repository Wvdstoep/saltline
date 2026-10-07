// v0.3: OSM parsing / coastline closing (server/osm.js) and harbour patch invariants (server/harborgeom.js).
// v0.4: the street layer — Overpass query, road / area / rail / POI classification, caps, cache schema, and the
// ashore guarantees (six POIs with doors on land, synthetic road networks on land) for synthetic and OSM harbours.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseLength, parseHeight, landPolygonsFromCoastline, pointInRings, parseOverpass, buildOverpassQuery, classifyFeatures,
  roadKindOf, areaKindOf, poiKindOf, isOSMFresh, osmHasStreets, localFrame, fetchHarborOSM, configureOSM, loadCachedOSM,
  OSM_SCHEMA, ROAD_CAP, SHOP_CAP, ROAD_KINDS, AREA_KINDS, POI_KINDS,
} from '../server/osm.js';
import * as hg from '../server/harborgeom.js';
import { World, DATA_DIR } from '../server/world.js';
import { carvingsForWorld, harborById } from '../server/harbors.js';
import { PATCH } from '../shared/constants.js';

const REQUIRED = ['harbourmaster', 'shipyard', 'chandler', 'fuel', 'market', 'bar'];
const WALKABLE = new Set([PATCH.MASK.LAND, PATCH.MASK.QUAY, PATCH.MASK.PONTOON]);
let world = null;
const getWorld = () => (world ||= new World().load(carvingsForWorld(), () => {}));

test('parseLength / parseHeight handle metres, feet and levels', () => {
  assert.equal(parseLength('12'), 12);
  assert.equal(parseLength('12,5 m'), 12.5);
  assert.equal(parseLength('10 ft'), 3);
  assert.equal(parseLength('abc'), null);
  assert.equal(parseHeight({ 'building:levels': '3' }), 9.6);
  assert.equal(parseHeight({}), 8);
});

test('straight coastline: land on the left of the way', () => {
  const bbox = { latMin: 0, latMax: 1, lonMin: 0, lonMax: 1 };
  // way runs north along lon 0.5 → land on the left = west half
  const rings = landPolygonsFromCoastline([[[-0.1, 0.5], [1.1, 0.5]]], bbox);
  assert.ok(rings.length >= 1);
  assert.equal(pointInRings(0.5, 0.25, rings), true, 'west is land');
  assert.equal(pointInRings(0.5, 0.75, rings), false, 'east is water');
});

test('island ring (counter-clockwise) is land, surroundings water', () => {
  const bbox = { latMin: 0, latMax: 1, lonMin: 0, lonMax: 1 };
  const island = [[0.4, 0.4], [0.4, 0.6], [0.6, 0.6], [0.6, 0.4], [0.4, 0.4]]; // lat,lon; land on the left when walking it
  const rings = landPolygonsFromCoastline([island], bbox);
  const inside = pointInRings(0.5, 0.5, rings), outside = pointInRings(0.1, 0.1, rings);
  assert.notEqual(inside, outside, 'island interior and the open sea must differ');
});

test('two ways that join into one coastline close like a single way', () => {
  const bbox = { latMin: 0, latMax: 1, lonMin: 0, lonMax: 1 };
  const a = [[-0.1, 0.5], [0.5, 0.5]], b = [[0.5, 0.5], [1.1, 0.5]];
  const rings = landPolygonsFromCoastline([b, a], bbox);
  assert.equal(pointInRings(0.5, 0.25, rings), true);
  assert.equal(pointInRings(0.5, 0.75, rings), false);
});

test('Overpass parsing keeps tagged ways and the coastline', () => {
  const json = { elements: [
    { type: 'way', id: 1, tags: { natural: 'coastline' }, geometry: [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }] },
    { type: 'way', id: 2, tags: { man_made: 'pier' }, geometry: [{ lat: 0, lon: 0 }, { lat: 0.001, lon: 0 }] },
    { type: 'way', id: 3, tags: { building: 'yes' }, geometry: [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.001 }, { lat: 0.001, lon: 0.001 }, { lat: 0, lon: 0 }] },
  ] };
  const r = parseOverpass(json);
  assert.equal(r.coastline.length, 1);
  assert.ok(r.features.length >= 2);
  assert.match(buildOverpassQuery(52, 4), /coastline/);
});

// ------------------------------------------------------------------------------------------------- v0.4 street layer
test('Overpass query asks for the street layer (roads, land use, parks, nature, amenities, shops, tourism, rail)', () => {
  const q = buildOverpassQuery(51.95, 4.14, 3200, 60);
  for (const re of [/way\["highway"~/, /way\["landuse"\]\(around/, /way\["leisure"~"\^\(park\|garden\)\$"\]/, /way\["natural"~"[^"]*wood[^"]*beach[^"]*"\]/,
    /nwr\["amenity"~"[^"]*bar\|pub[^"]*harbourmaster[^"]*"\]/, /node\["shop"\]/, /node\["tourism"\]/, /way\["railway"="rail"\]/, /nwr\["industrial"="shipyard"\]/]) {
    assert.match(q, re, `query contains ${re}`);
  }
  assert.match(q, /out geom;/);
});

test('road / area / POI tag classification', () => {
  assert.deepEqual(roadKindOf({ highway: 'trunk' }), { kind: 'motorway', width: 20 });
  assert.equal(roadKindOf({ highway: 'primary' }).kind, 'primary');
  assert.equal(roadKindOf({ highway: 'primary', lanes: '4' }).width, 14.2);
  assert.equal(roadKindOf({ highway: 'unclassified' }).kind, 'tertiary');
  assert.equal(roadKindOf({ highway: 'living_street' }).kind, 'residential');
  assert.equal(roadKindOf({ highway: 'service', width: '5 m' }).width, 5);
  assert.equal(roadKindOf({ highway: 'cycleway' }).kind, 'footway');
  assert.equal(roadKindOf({ highway: 'track' }).kind, 'track');
  assert.equal(roadKindOf({ highway: 'proposed' }), null);
  for (const hw of ['motorway', 'primary', 'secondary', 'tertiary', 'residential', 'service', 'footway', 'track']) assert.ok(ROAD_KINDS.includes(roadKindOf({ highway: hw }).kind));
  assert.equal(areaKindOf({ leisure: 'park' }), 'park');
  assert.equal(areaKindOf({ natural: 'beach' }), 'sand');
  assert.equal(areaKindOf({ natural: 'scrub' }), 'wood');
  assert.equal(areaKindOf({ landuse: 'grass' }), 'grass');
  assert.equal(areaKindOf({ landuse: 'port' }), 'port');
  assert.equal(areaKindOf({ landuse: 'industrial' }), 'industrial');
  assert.equal(areaKindOf({ landuse: 'residential' }), 'residential');
  assert.equal(areaKindOf({ amenity: 'parking' }), 'parking');
  assert.equal(areaKindOf({ landuse: 'basin' }), null);
  assert.equal(poiKindOf({ amenity: 'pub' }), 'bar');
  assert.equal(poiKindOf({ amenity: 'harbourmaster' }), 'harbourmaster');
  assert.equal(poiKindOf({ building: 'yes', name: 'Havenmeester Scheveningen' }), 'harbourmaster');
  assert.equal(poiKindOf({ shop: 'boat' }), 'chandler');
  assert.equal(poiKindOf({ industrial: 'shipyard' }), 'shipyard');
  assert.equal(poiKindOf({ waterway: 'fuel' }), 'fuel');
  assert.equal(poiKindOf({ amenity: 'restaurant' }), 'cafe');
  assert.equal(poiKindOf({ amenity: 'police' }), 'police');
  assert.equal(poiKindOf({ shop: 'bakery' }), null);
  assert.deepEqual([...POI_KINDS].sort(), ['bar', 'cafe', 'chandler', 'fuel', 'harbourmaster', 'market', 'police', 'shipyard']);
  assert.equal(AREA_KINDS.length, 8);
});

test('parseOverpass caps roads (major classes first, then nearest) and shop nodes', () => {
  const elements = [];
  for (let i = 0; i < ROAD_CAP + 120; i++) elements.push({ type: 'way', id: 1000 + i, tags: { highway: 'footway' }, geometry: [{ lat: 52 + i * 1e-5, lon: 4 }, { lat: 52 + i * 1e-5, lon: 4.001 }] });
  elements.push({ type: 'way', id: 1, tags: { highway: 'motorway', name: 'A15' }, geometry: [{ lat: 52.03, lon: 4 }, { lat: 52.03, lon: 4.01 }] });
  elements.push({ type: 'way', id: 2, tags: { highway: 'construction' }, geometry: [{ lat: 52, lon: 4 }, { lat: 52.001, lon: 4 }] });
  for (let i = 0; i < SHOP_CAP + 50; i++) elements.push({ type: 'node', id: 5000 + i, lat: 52 + i * 1e-5, lon: 4, tags: { shop: 'clothes', name: `Shop ${i}` } });
  elements.push({ type: 'node', id: 9, lat: 52.02, lon: 4.02, tags: { shop: 'boat', name: 'Far Marine' } });
  const r = parseOverpass({ elements }, { origin: { lat: 52, lon: 4 } });
  const highways = r.features.filter((f) => f.tags?.highway);
  assert.equal(highways.length, ROAD_CAP);
  assert.ok(highways.some((f) => f.tags.highway === 'motorway'), 'the motorway survives the cap');
  assert.ok(!highways.some((f) => f.tags.highway === 'construction'));
  assert.ok(!highways.some((f) => f.id === 1000 + ROAD_CAP + 119), 'the farthest footway is dropped');
  const shops = r.features.filter((f) => f.type === 'node' && f.tags.shop === 'clothes');
  assert.equal(shops.length, SHOP_CAP);
  assert.ok(r.features.some((f) => f.tags?.shop === 'boat'), 'a chandler shop is a game POI and not capped');
});

test('OSM cache schema: caches without the street layer are stale but still a fallback', async () => {
  const now = Date.now();
  assert.equal(isOSMFresh({ fetchedAt: now, coastline: [[[0, 0], [1, 1]]], features: [] }), false, 'v0.3 cache (no schema) is refetched');
  assert.equal(isOSMFresh({ schema: OSM_SCHEMA, fetchedAt: now, coastline: [[[0, 0], [1, 1]]], features: [] }), true);
  assert.equal(osmHasStreets({ schema: 1 }), false);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slosm-'));
  configureOSM({ dataDir: tmp });
  fs.mkdirSync(path.join(tmp, 'osm'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'osm', 'dover.json'), JSON.stringify({ id: 'dover', fetchedAt: now, radiusM: 3200, coastline: [[[51.1, 1.3], [51.2, 1.3]]], features: [] }));
  let calls = 0;
  const failing = async () => { calls++; throw new Error('offline'); };
  const r1 = await fetchHarborOSM({ id: 'dover', lat: 51.12, lon: 1.33 }, { fetchImpl: failing, endpoints: ['https://a.invalid/api'] });
  assert.equal(calls, 1, 'an old-schema cache triggers a refetch');
  assert.ok(r1 && r1.coastline.length === 1, 'the stale cache is the fallback when the refetch fails');
  const ok = async () => ({ ok: true, json: async () => ({ elements: [{ type: 'way', id: 7, tags: { highway: 'residential', name: 'Dock Street' }, geometry: [{ lat: 51.12, lon: 1.33 }, { lat: 51.121, lon: 1.33 }] }] }) });
  const r2 = await fetchHarborOSM({ id: 'dover', lat: 51.12, lon: 1.33 }, { fetchImpl: ok, endpoints: ['https://a.invalid/api'] });
  assert.equal(r2.schema, OSM_SCHEMA);
  assert.equal(loadCachedOSM('dover').schema, OSM_SCHEMA, 'the refreshed payload is cached with the new schema');
  assert.equal(classifyFeatures(r2.features).roads[0].name, 'Dock Street');
  configureOSM({ dataDir: DATA_DIR });
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A small OSM harbour in the local frame of a real harbour: coast to the west, quay, roads, rail, park, POIs. */
function osmFixture(harbor) {
  const f = localFrame(harbor.lat, harbor.lon);
  const ll = (x, z) => { const p = f.toLL(x, z); return { lat: p[0], lon: p[1] }; };
  const way = (id, tags, xz, closed = false) => ({ type: 'way', id, tags, geometry: (closed ? xz.concat([xz[0]]) : xz).map(([x, z]) => ll(x, z)) });
  const node = (id, tags, x, z) => ({ type: 'node', id, tags, ...ll(x, z) });
  const rect = (x0, z0, x1, z1) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
  const elements = [
    way(1, { natural: 'coastline' }, [[150, -3000], [150, 3000]]),                        // heading south: land on the left = east
    way(2, { man_made: 'quay', name: 'Main Quay' }, [[150, -350], [150, 350]]),
    way(10, { building: 'warehouse' }, rect(200, -300, 260, -230), true),
    way(11, { building: 'warehouse' }, rect(200, -200, 260, -130), true),
    way(12, { building: 'yes', amenity: 'pub', name: 'The Lighthouse Tavern' }, rect(200, 120, 225, 140), true),
    way(13, { building: 'industrial' }, rect(200, 180, 280, 260), true),
    way(14, { building: 'yes' }, rect(205, -60, 225, -40), true),
    way(15, { building: 'yes' }, rect(205, 20, 230, 45), true),
    way(16, { building: 'yes' }, rect(320, -60, 350, -30), true),
    way(20, { highway: 'primary', name: 'Harbour Road' }, [[300, -3500], [300, 0], [310, 3500]]),
    way(21, { highway: 'residential', name: 'Quay Street' }, [[160, -100], [900, -100]]),
    way(22, { highway: 'residential', name: 'Market Street' }, [[160, 90], [900, 90]]),
    way(23, { highway: 'footway' }, [[185, -330], [185, 330]]),
    way(24, { highway: 'service', tunnel: 'yes' }, [[400, 0], [500, 0]]),
    way(25, { highway: 'pedestrian', area: 'yes', name: 'Fish Square' }, rect(400, 150, 440, 190), true),
    way(30, { railway: 'rail' }, [[700, -3000], [700, 3000]]),
    way(31, { leisure: 'park', name: 'Harbour Park' }, rect(400, 300, 600, 450), true),
    way(32, { amenity: 'parking' }, rect(400, -250, 460, -200), true),
    way(33, { landuse: 'industrial' }, rect(160, -350, 290, 300), true),
    node(40, { shop: 'boat', name: 'Harbour Marine' }, 212, -50),
    node(41, { amenity: 'fuel', name: 'Shell' }, 1500, 600),
    node(42, { amenity: 'harbourmaster', name: 'Port Office' }, 217, 32),
    node(43, { shop: 'bakery', name: 'Bakker Bart' }, 340, -45),
  ];
  return { id: harbor.id, schema: OSM_SCHEMA, fetchedAt: Date.now(), radiusM: 3200, ...parseOverpass({ elements }, { origin: harbor }) };
}

test('OSM harbour: roads, areas, rails, places and real amenities become the street layer', () => {
  const harbor = harborById('dover');
  const osmData = osmFixture(harbor);
  const { geom, mask } = hg.buildFromOSM(harbor, osmData, getWorld());
  const F = geom.features, f = localFrame(harbor.lat, harbor.lon), n = geom.n, res = geom.res;
  const maskLL = (lat, lon) => { const [x, z] = f.toXZ(lat, lon); const i = Math.floor(x / res + n / 2), j = Math.floor(z / res + n / 2); return i < 0 || j < 0 || i >= n || j >= n ? -1 : mask[j * n + i]; };
  assert.equal(geom.version, hg.GEOM_VERSION);
  assert.ok(hg.GEOM_VERSION >= 4);
  // roads parse from the fixture, the tunnel is dropped, everything is clipped to the patch
  const names = new Set(F.roads.map((r) => r.name));
  for (const nm of ['Harbour Road', 'Quay Street', 'Market Street']) assert.ok(names.has(nm), `road ${nm}`);
  assert.ok(F.roads.some((r) => r.kind === 'primary' && r.width === 12));
  assert.ok(F.roads.some((r) => r.kind === 'footway'));
  assert.ok(!F.roads.some((r) => r.kind === 'service' && r.pts.length === 2 && Math.abs(f.toXZ(r.pts[0][0], r.pts[0][1])[0] - 400) < 1), 'tunnel dropped');
  const half = (n * res) / 2;
  for (const r of F.roads) for (const p of r.pts) { const [x, z] = f.toXZ(p[0], p[1]); assert.ok(Math.abs(x) <= half + 1 && Math.abs(z) <= half + 1, 'road clipped to the patch'); }
  assert.ok(F.rails.length >= 1, 'rail');
  const kinds = new Set(F.areas.map((a) => a.kind));
  for (const k of ['park', 'parking', 'industrial']) assert.ok(kinds.has(k), `area ${k}`);
  assert.ok(F.places.some((p) => p.name === 'Bakker Bart'), 'named shop becomes a street sign');
  // the six POIs, real amenities where they qualify
  for (const k of REQUIRED) assert.equal(F.pois.filter((p) => p.kind === k).length, 1, `one ${k}`);
  const bar = F.pois.find((p) => p.kind === 'bar');
  assert.equal(bar.name, 'The Lighthouse Tavern');
  assert.ok(bar.building >= 0 && F.buildings[bar.building], 'the pub keeps its building');
  const [bx, bz] = f.toXZ(F.buildings[bar.building].pts[0][0], F.buildings[bar.building].pts[0][1]);
  assert.ok(bx > 190 && bx < 235 && bz > 110 && bz < 150, 'it is the pub building');
  assert.equal(F.pois.find((p) => p.kind === 'chandler').name, 'Harbour Marine');
  assert.equal(F.pois.find((p) => p.kind === 'harbourmaster').name, 'Port Office');
  assert.notEqual(F.pois.find((p) => p.kind === 'fuel').name, 'Shell', 'a filling station 1.5 km inland is no fuel dock');
  for (const p of F.pois) {
    assert.ok(WALKABLE.has(maskLL(p.door.lat, p.door.lon)), `${p.kind} door on land`);
    assert.ok(p.building >= -1 && p.building < F.buildings.length);
    assert.ok(typeof p.id === 'string' && p.id.startsWith('dover-'));
  }
});

test('synthetic harbours: anchor in water, big berths, binary round-trip, SDF sign', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slgeom-'));
  hg.configure({ dataDir: tmp, offline: true, preload: false, log: () => {} });
  hg.init(getWorld());
  for (const id of ['rotterdam', 'bergen', 'dover']) {
    const geom = await hg.ensureHarbor(id);
    assert.ok(geom, `${id} built`);
    assert.equal(geom.n, PATCH.N);
    const big = geom.berths.filter((b) => b.length >= 120 && b.depth >= 8);
    assert.ok(big.length >= 2, `${id} has ≥ 2 big berths (got ${big.length})`);
    assert.ok(Array.isArray(geom.fairway) && geom.fairway.length >= 2, `${id} fairway`);
    assert.equal(hg.landPenetration(geom.anchor.lat, geom.anchor.lon), 0, `${id} anchor is water`);
    const sd = hg.sdfAt(id, geom.anchor.lat, geom.anchor.lon);
    assert.ok(sd == null || sd > 0, `${id} anchor sdf positive`);
    const buf = hg.getHarborPatch(id);
    const dec = hg.decodePatch(buf);
    assert.equal(dec.n, geom.n);
    assert.equal(dec.mask.length, geom.n * geom.n);
    const nb = hg.nearestBerth(id, geom.anchor.lat, geom.anchor.lon);
    assert.ok(nb && nb.berth && nb.distM >= 0, `${id} nearestBerth`);
    // the berth point itself is water
    assert.equal(hg.landPenetration(nb.berth.lat, nb.berth.lon), 0, `${id} berth point is water`);
  }
  assert.ok(harborById('rotterdam'));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('synthetic harbours are walkable: six POIs with doors on land, a road network on land, areas', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slstreet-'));
  hg.configure({ dataDir: tmp, offline: true, preload: false, log: () => {} });
  hg.init(getWorld());
  for (const id of ['rotterdam', 'bergen', 'dover', 'lerwick', 'singapore']) {
    const geom = await hg.ensureHarbor(id);
    assert.ok(geom, `${id} built`);
    const F = geom.features;
    // POIs: each required kind exactly once, unique ids, doors on walkable land and outside every footprint
    for (const k of REQUIRED) assert.equal(F.pois.filter((p) => p.kind === k).length, 1, `${id}: one ${k}`);
    assert.equal(new Set(F.pois.map((p) => p.id)).size, F.pois.length, `${id}: unique POI ids`);
    const f = localFrame(geom.origin.lat, geom.origin.lon);
    const rings = F.buildings.map((b) => b.pts.map((p) => f.toXZ(p[0], p[1])));
    const inside = (x, z, r) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { if ((r[i][1] > z) !== (r[j][1] > z) && x < ((r[j][0] - r[i][0]) * (z - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) c = !c; } return c; };
    for (const p of F.pois) {
      assert.ok(WALKABLE.has(hg.maskAt(id, p.door.lat, p.door.lon)), `${id} ${p.kind} door on land (mask ${hg.maskAt(id, p.door.lat, p.door.lon)})`);
      const [x, z] = f.toXZ(p.door.lat, p.door.lon);
      assert.ok(!rings.some((r) => inside(x, z, r)), `${id} ${p.kind} door outside the buildings`);
      assert.ok(p.building >= -1 && p.building < F.buildings.length, `${id} ${p.kind} building index`);
      if (p.kind !== 'fuel') assert.ok(p.building >= 0, `${id} ${p.kind} has a building`);
      if (p.building >= 0) {
        const [bx, bz] = rings[p.building].reduce((a, q) => [a[0] + q[0] / rings[p.building].length, a[1] + q[1] / rings[p.building].length], [0, 0]);
        assert.ok(Math.hypot(bx - x, bz - z) < 150, `${id} ${p.kind} door belongs to its building`);
      }
    }
    // the fuel dock is on the quay next to a berth
    const fuel = F.pois.find((p) => p.kind === 'fuel');
    const nb = hg.nearestBerth(id, fuel.door.lat, fuel.door.lon);
    assert.ok(nb && nb.distM < 80, `${id} fuel dock next to a berth (${nb?.distM} m)`);
    // roads: a network with quay roads and connectors, essentially all of it on walkable land
    assert.ok(F.roads.length >= 3, `${id}: ${F.roads.length} roads`);
    let total = 0, onLand = 0, len = 0;
    for (const r of F.roads) {
      assert.ok(ROAD_KINDS.includes(r.kind) && r.width > 0, `${id} road kind/width`);
      for (let i = 0; i + 1 < r.pts.length; i++) {
        const [ax, az] = f.toXZ(r.pts[i][0], r.pts[i][1]), [bx, bz] = f.toXZ(r.pts[i + 1][0], r.pts[i + 1][1]);
        const L = Math.hypot(bx - ax, bz - az); len += L;
        for (let s = 0; s <= L; s += 5) { const t = L ? s / L : 0; const p = f.toLL(ax + (bx - ax) * t, az + (bz - az) * t); total++; if (WALKABLE.has(hg.maskAt(id, p[0], p[1]))) onLand++; }
      }
    }
    assert.ok(len > 500, `${id}: road length ${Math.round(len)} m`);
    assert.ok(onLand / total > 0.97, `${id}: ${Math.round((onLand / total) * 100)} % of the road samples on land`);
    assert.ok(F.roads.some((r) => r.name === 'Quay road'), `${id}: a quay road`);
    assert.ok(F.areas.length >= 2 && F.areas.every((a) => AREA_KINDS.includes(a.kind) && a.pts.length >= 3), `${id}: areas`);
    assert.ok(Array.isArray(F.rails) && Array.isArray(F.places));
  }
  // geometry is served under the bumped version and the JSON stays compact
  const g = hg.getHarborGeom('rotterdam');
  assert.equal(g.version, hg.GEOM_VERSION);
  assert.ok(JSON.stringify(g).length < 400 * 1024);
  fs.rmSync(tmp, { recursive: true, force: true });
});
