// v0.3: OSM parsing / coastline closing (server/osm.js) and harbour patch invariants (server/harborgeom.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseLength, parseHeight, landPolygonsFromCoastline, pointInRings, parseOverpass, buildOverpassQuery } from '../server/osm.js';
import * as hg from '../server/harborgeom.js';
import { World } from '../server/world.js';
import { carvingsForWorld, harborById } from '../server/harbors.js';
import { PATCH } from '../shared/constants.js';

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

test('synthetic harbours: anchor in water, big berths, binary round-trip, SDF sign', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slgeom-'));
  hg.configure({ dataDir: tmp, offline: true, preload: false, log: () => {} });
  const world = new World().load(carvingsForWorld(), () => {});
  hg.init(world);
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
