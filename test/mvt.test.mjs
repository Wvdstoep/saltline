// Mapbox Vector Tile decoder (server/mvt.js, docs/WORLD-DETAIL-STREAMING.md §3.3): tiles built by the tiny encoder in
// test/fixtures/wt/mvtenc.mjs plus one recorded OpenFreeMap tile. Varints, zigzag, commands, multipolygons with holes,
// every value type, unknown fields skipped, gzip, truncated / garbage input → empty result without throwing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { decodeMVT, ringArea, summarizeMVT } from '../server/mvt.js';
import { encodeMVT } from './fixtures/wt/mvtenc.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'wt');
const square = (x0, y0, x1, y1) => [x0, y0, x1, y0, x1, y1, x0, y1];             // clockwise with y down (exterior)
const squareCCW = (x0, y0, x1, y1) => [x0, y0, x0, y1, x1, y1, x1, y0];          // anticlockwise (hole)

test('polygons: exterior + hole grouped, multipolygon split by winding, coordinates exact incl. the buffer', () => {
  const tile = { layers: { water: { extent: 4096, features: [
    { type: 3, tags: { class: 'dock' }, geom: [[square(-64, -64, 2000, 2000), squareCCW(100, 100, 300, 300)], [square(3000, 3000, 4160, 4160)]] },
  ] } } };
  const d = decodeMVT(encodeMVT(tile));
  const f = d.layers.water.features[0];
  assert.equal(d.layers.water.extent, 4096);
  assert.equal(f.type, 3);
  assert.equal(f.geom.length, 2, 'two polygons');
  assert.equal(f.geom[0].length, 2, 'exterior + one hole');
  assert.deepEqual(f.geom[0][0], square(-64, -64, 2000, 2000));
  assert.deepEqual(f.geom[0][1], squareCCW(100, 100, 300, 300));
  assert.ok(ringArea(f.geom[0][0]) > 0 && ringArea(f.geom[0][1]) < 0);
  assert.deepEqual(f.geom[1][0], square(3000, 3000, 4160, 4160));
});

test('lines and points: MoveTo / LineTo with a cursor that carries across parts, zigzag negatives', () => {
  const tile = { layers: { waterway: { extent: 4096, features: [
    { type: 2, tags: { class: 'river' }, geom: [[10, 10, 5, 4000, -30, 20], [4000, 0, 0, 4096]] },
    { type: 1, tags: { class: 'buoy' }, geom: [[1, 2, 4095, 4095, -3, -7]] },
  ] } } };
  const d = decodeMVT(encodeMVT(tile)), [line, pts] = d.layers.waterway.features;
  assert.deepEqual(line.geom, [[10, 10, 5, 4000, -30, 20], [4000, 0, 0, 4096]]);
  assert.deepEqual(pts.geom, [[1, 2, 4095, 4095, -3, -7]]);
});

test('every Value type: string, float, double, int, uint, sint, bool; ids', () => {
  const tile = { layers: { t: { extent: 512, features: [{ id: 123456789012, type: 1, geom: [[1, 1]], tags: { s: 'Ölhafen', f: { float: 1.5 }, d: 2.25, u: 4000000000, n: -77, b: false, t: true } }] } } };
  const f = decodeMVT(encodeMVT(tile)).layers.t.features[0];
  assert.equal(f.id, 123456789012);
  assert.deepEqual(f.tags, { s: 'Ölhafen', f: 1.5, d: 2.25, u: 4000000000, n: -77, b: false, t: true });
  assert.equal(decodeMVT(encodeMVT(tile)).layers.t.extent, 512);
});

test('unknown fields at tile, layer and feature level are skipped; gzip input is inflated', () => {
  const tile = { layers: { water: { extent: 4096, features: [{ type: 3, tags: { class: 'ocean' }, geom: [[square(0, 0, 4096, 4096)]] }] } } };
  // field 9 varint, field 10 fixed64, field 11 bytes, field 12 fixed32 (all unknown)
  const junk = [9 << 3, 150, 1, (10 << 3) | 1, 1, 2, 3, 4, 5, 6, 7, 8, (11 << 3) | 2, 3, 65, 66, 67, (12 << 3) | 5, 1, 2, 3, 4];
  const raw = encodeMVT(tile, { raw: { tile: junk, layer: junk, feature: junk } });
  const d = decodeMVT(raw);
  assert.equal(d.error, undefined);
  assert.deepEqual(d.layers.water.features[0].geom[0][0], square(0, 0, 4096, 4096));
  assert.deepEqual(decodeMVT(zlib.gzipSync(raw)), d);
});

test('truncated or garbage buffers decode to an empty result, never throw', () => {
  const raw = encodeMVT({ layers: { water: { extent: 4096, features: [{ type: 3, tags: { class: 'lake' }, geom: [[square(0, 0, 100, 100)]] }] } } });
  for (let cut = 1; cut < raw.length; cut++) {
    const d = decodeMVT(raw.subarray(0, cut));
    assert.deepEqual(d.layers, {}, `cut at ${cut}`);
  }
  assert.deepEqual(decodeMVT(new Uint8Array([0xff, 0xff, 0xff])).layers, {});
  assert.deepEqual(decodeMVT(new Uint8Array(0)).layers, {});
  assert.deepEqual(decodeMVT(Uint8Array.from([0x1f, 0x8b, 1, 2])).layers, {});
  // a geometry command list that runs out of parameters
  const bad = encodeMVT({ layers: { x: { extent: 4096, features: [{ type: 2, tags: {}, geom: [[0, 0, 5, 5]] }] } } });
  assert.doesNotThrow(() => decodeMVT(bad.subarray(0, bad.length - 3)));
});

test('a recorded OpenFreeMap z14 tile (Rotterdam, OpenMapTiles schema) decodes with its layers and classes', () => {
  const file = path.join(FIX, 'rotterdam', '14-8381-5418.mvt.gz');
  const d = decodeMVT(fs.readFileSync(file));
  assert.equal(d.error, undefined);
  const s = summarizeMVT(d);
  for (const l of ['water', 'landuse', 'transportation', 'building']) assert.ok(s[l]?.n > 0, `layer ${l}`);
  assert.equal(s.water.extent, 4096);
  assert.ok(s.water.classes.lake > 0, 'Rotterdam basins are class lake in OpenFreeMap');
  assert.ok(s.transportation.classes.pier > 0);
  for (const f of d.layers.water.features) for (const poly of f.geom) assert.ok(ringArea(poly[0]) > 0, 'exterior rings first');
});
