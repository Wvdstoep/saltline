// Overpass JSON → footprint conversion (scripts/fetch-osm.mjs). Pure functions only — no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildQuery, classify, parseLength, parseHeight, polygonAreaM2, elementToFootprints, convertOverpass,
  countKinds, parseArgs, DEFAULTS,
} from '../scripts/fetch-osm.mjs';

// Helpers to hand-write `out geom` ways. Axis-aligned boxes near Rotterdam (51.9 N, 4.5 E):
// 0.00018° lat ≈ 19.9 m, 0.00015° lon ≈ 10.3 m at this latitude.
const box = (lat, lon, dLat, dLon) => [
  { lat, lon }, { lat, lon: lon + dLon }, { lat: lat + dLat, lon: lon + dLon }, { lat: lat + dLat, lon }, { lat, lon },
];
const way = (id, tags, geometry) => ({ type: 'way', id, tags, geometry });

const WAREHOUSE = way(1001, { building: 'warehouse', height: '12 m', name: 'Loods 3' }, box(51.9, 4.5, 0.00018, 0.00015));
const OFFICE = way(1002, { building: 'yes', 'building:levels': '3' }, box(51.901, 4.5, 0.00009, 0.00009));
const SHED = way(1003, { building: 'yes' }, box(51.902, 4.5, 0.00005, 0.00005));
const YARD = way(1004, { landuse: 'industrial' }, box(51.903, 4.5, 0.0009, 0.0015));
const PIER_AREA = way(1005, { man_made: 'pier', area: 'yes', height: '2' }, box(51.904, 4.5, 0.00004, 0.0009));
const JETTY = way(1006, { man_made: 'pier', width: '4' }, [{ lat: 51.905, lon: 4.5 }, { lat: 51.905, lon: 4.5006 }]);
const FUEL_NODE = { type: 'node', id: 7, lat: 51.9, lon: 4.5, tags: { amenity: 'fuel' } };
const DEGENERATE = way(1007, { building: 'yes' }, [{ lat: 51.906, lon: 4.5 }, { lat: 51.906, lon: 4.5001 }]);
const ROAD = way(1008, { highway: 'service' }, box(51.907, 4.5, 0.0001, 0.0001));
const SLIVER = way(1009, { building: 'yes' }, box(51.908, 4.5, 0.000001, 0.000001)); // < 1 m²

const SAMPLE = {
  version: 0.6, generator: 'Overpass API 0.7.62',
  osm3s: { timestamp_osm_base: '2026-10-07T10:00:00Z', copyright: 'OpenStreetMap contributors, ODbL' },
  elements: [WAREHOUSE, OFFICE, SHED, YARD, PIER_AREA, JETTY, FUEL_NODE, DEGENERATE, ROAD, SLIVER],
};

test('closed building way → one footprint with explicit height, open ring, lat/lon pairs', () => {
  const fps = elementToFootprints(WAREHOUSE);
  assert.equal(fps.length, 1);
  const fp = fps[0];
  assert.equal(fp.id, 1001);
  assert.equal(fp.kind, 'building');
  assert.equal(fp.height, 12);
  assert.equal(fp.pts.length, 4, 'closing point is dropped');
  assert.deepEqual(fp.pts[0], [51.9, 4.5]);
  assert.deepEqual(fp.pts[2], [51.90018, 4.50015]);
  for (const p of fp.pts) {
    assert.equal(p.length, 2);
    assert.ok(p[0] > 51 && p[0] < 52, 'first element is latitude');
    assert.ok(p[1] > 4 && p[1] < 5, 'second element is longitude');
  }
  assert.ok(fp.area > 190 && fp.area < 220, `~205 m² expected, got ${fp.area}`);
});

test('height falls back to building:levels * 3.2, then 8 m', () => {
  assert.equal(elementToFootprints(OFFICE)[0].height, 9.6);
  assert.equal(elementToFootprints(SHED)[0].height, DEFAULTS.defaultHeight);
  assert.equal(parseHeight({ height: '7.5' }), 7.5);
  assert.equal(parseHeight({ height: '12,5 m' }), 12.5);
  assert.equal(parseHeight({ height: '40 ft' }), 12.2);
  assert.equal(parseHeight({ height: 'tall', 'building:levels': '2' }), 6.4, 'unparseable height → levels');
  assert.equal(parseHeight({ height: '-3', 'building:levels': '0' }), 8, 'non-positive values are ignored');
  assert.equal(parseLength("30'6\""), 9.3);
  assert.equal(parseLength(undefined), null);
});

test('kinds: building wins over pier and landuse; landuse regex matches industrial|port|harbour', () => {
  assert.equal(classify({ building: 'yes', man_made: 'pier' }), 'building');
  assert.equal(classify({ building: 'no', man_made: 'pier' }), 'pier');
  assert.equal(classify({ landuse: 'industrial;retail' }), 'industrial');
  assert.equal(classify({ landuse: 'harbour' }), 'industrial');
  assert.equal(classify({ landuse: 'port' }), 'industrial');
  assert.equal(classify({ landuse: 'residential' }), null);
  assert.equal(classify({}), null);
  assert.equal(elementToFootprints(YARD)[0].kind, 'industrial');
  assert.equal(elementToFootprints(PIER_AREA)[0].kind, 'pier');
  assert.equal(elementToFootprints(PIER_AREA)[0].height, 2);
});

test('linear pier is buffered into one rectangle per segment, width from tags', () => {
  const fps = elementToFootprints(JETTY);
  assert.equal(fps.length, 1);
  assert.equal(fps[0].kind, 'pier');
  assert.equal(fps[0].pts.length, 4);
  // 0.0006° lon ≈ 41 m long × 4 m wide ≈ 165 m²
  assert.ok(fps[0].area > 150 && fps[0].area < 180, `~165 m² expected, got ${fps[0].area}`);
  assert.ok(polygonAreaM2(fps[0].pts) > 0);
});

test('nodes, relations, degenerate ways, untagged ways and slivers are skipped', () => {
  assert.deepEqual(elementToFootprints(FUEL_NODE), []);
  assert.deepEqual(elementToFootprints({ type: 'relation', id: 9, tags: { building: 'yes' }, members: [] }), []);
  assert.deepEqual(elementToFootprints(DEGENERATE), []);
  assert.deepEqual(elementToFootprints(ROAD), []);
  assert.deepEqual(elementToFootprints(SLIVER), []);
  assert.deepEqual(elementToFootprints(null), []);
  assert.deepEqual(elementToFootprints({ type: 'way', id: 1, tags: { building: 'yes' } }), [], 'no geometry (not out geom)');
});

test('convertOverpass sorts largest first, caps per harbour and reports the pre-cap total', () => {
  const full = convertOverpass(SAMPLE);
  assert.equal(full.total, 6, 'warehouse, office, shed, yard, pier area, jetty');
  assert.equal(full.footprints.length, 6);
  assert.equal(full.footprints[0].id, 1004, 'the industrial yard is the largest');
  for (let i = 1; i < full.footprints.length; i++) assert.ok(full.footprints[i - 1].area >= full.footprints[i].area);
  for (const fp of full.footprints) {
    assert.ok(['building', 'industrial', 'pier'].includes(fp.kind));
    assert.equal(typeof fp.height, 'number');
    assert.ok(Array.isArray(fp.pts) && fp.pts.length >= 3);
  }
  assert.deepEqual(countKinds(full.footprints), { building: 3, industrial: 1, pier: 2 });

  // yard ≈ 10 250 m², pier area ≈ 4.4 × 62 m ≈ 272 m², warehouse ≈ 205 m², jetty ≈ 165 m², office ≈ 62 m², shed ≈ 19 m²
  const capped = convertOverpass(SAMPLE, { cap: 2 });
  assert.equal(capped.footprints.length, 2);
  assert.equal(capped.total, 6);
  assert.deepEqual(capped.footprints.map(f => f.id), [1004, 1005]);
  assert.deepEqual(full.footprints.map(f => f.id), [1004, 1005, 1001, 1006, 1002, 1003]);

  assert.deepEqual(convertOverpass({ elements: [] }), { footprints: [], total: 0 });
  assert.deepEqual(convertOverpass(null), { footprints: [], total: 0 });
});

test('buildQuery asks for all three selectors around the harbour with out geom', () => {
  const q = buildQuery(51.9, 4.5);
  assert.match(q, /^\[out:json\]\[timeout:60\];/);
  assert.ok(q.includes('way["building"](around:1500,51.900000,4.500000);'));
  assert.ok(q.includes('way["landuse"~"industrial|port|harbour"](around:1500,51.900000,4.500000);'));
  assert.ok(q.includes('way["man_made"="pier"](around:1500,51.900000,4.500000);'));
  assert.ok(q.trimEnd().endsWith('out geom;'));
  assert.ok(buildQuery(-33.9, 151.2, 800).includes('around:800,-33.900000,151.200000'));
});

test('parseArgs handles --only, --limit and --resume', () => {
  const a = parseArgs(['--only', 'rotterdam,hull', '--limit', '5', '--resume', '--cap=100']);
  assert.deepEqual([...a.only], ['rotterdam', 'hull']);
  assert.equal(a.limit, 5);
  assert.equal(a.resume, true);
  assert.equal(a.cap, 100);
  assert.equal(parseArgs([]).only, null);
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
  assert.throws(() => parseArgs(['--limit', 'x']), /needs a number/);
});
