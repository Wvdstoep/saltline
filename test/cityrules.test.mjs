// City rules (public/js/cityrules.js): building heights from OSM tags and from world-tile vectors, roof choice, facade
// styles, colours, LOD per ring and device, tree kinds, satellite canopy detection. Pure helpers, no three.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as CR from '../public/js/cityrules.js';

const { STYLE, ROOF } = CR;

test('parseLength: metres, feet, commas, junk', () => {
  assert.equal(CR.parseLength('12'), 12);
  assert.equal(CR.parseLength('12.5 m'), 12.5);
  assert.equal(CR.parseLength('12,5'), 12.5);
  assert.ok(Math.abs(CR.parseLength("40'") - 12.192) < 1e-6);
  assert.ok(Math.abs(CR.parseLength('100 ft') - 30.48) < 1e-6);
  assert.ok(Number.isNaN(CR.parseLength('tall')));
  assert.ok(Number.isNaN(CR.parseLength(undefined)));
});

test('buildingFromTags: height tag, then levels × 3.2 m, then the type default', () => {
  const a = CR.buildingFromTags({ building: 'apartments', height: '31' }, 600, 1);
  assert.equal(a.height, 31); assert.equal(a.style, STYLE.APARTMENT); assert.equal(a.tagged, true);
  const b = CR.buildingFromTags({ building: 'office', 'building:levels': '10' }, 900, 1);
  assert.ok(Math.abs(b.height - 32) < 1e-9, 'levels × 3.2'); assert.equal(b.style, STYLE.OFFICE);
  const h = CR.buildingFromTags({ building: 'house' }, 120, 5);
  assert.ok(h.height >= 6.3 && h.height <= 7.7, `house default ~7 m: ${h.height}`); assert.equal(h.roof, ROOF.GABLE); assert.equal(h.tagged, false);
  assert.ok(h.eave < h.height && h.roofH > 0.5, 'a gabled house: eave under the ridge');
  const w = CR.buildingFromTags({ building: 'warehouse' }, 5000, 2);
  assert.equal(w.style, STYLE.WAREHOUSE); assert.equal(w.roof, ROOF.FLAT); assert.ok(w.height >= 8 && w.height <= 10);
  const c = CR.buildingFromTags({ building: 'church' }, 800, 3);
  assert.equal(c.style, STYLE.CHURCH); assert.ok(c.height >= 18);
  const r = CR.buildingFromTags({ building: 'house', 'roof:shape': 'hipped' }, 150, 3);
  assert.equal(r.roof, ROOF.HIP);
  const tall = CR.buildingFromTags({ building: 'house', 'building:levels': '6' }, 150, 3);
  assert.equal(tall.style, STYLE.APARTMENT, 'a six-storey "house" is an apartment block');
  const mh = CR.buildingFromTags({ building: 'yes', height: '20', min_height: '8' }, 300, 3);
  assert.equal(mh.minHeight, 8);
  const shed = CR.buildingFromTags({ building: 'yes' }, 20, 9);
  assert.ok(shed.height <= 3.5, 'tiny untyped footprint = shed / garage');
});

test('buildingFromTile: tagged render heights kept, estimates replaced by type defaults', () => {
  const tagged = CR.buildingFromTile({ h: 42, mh: 0, k: 'commercial', e: 0 }, 900, 7, 52);
  assert.equal(tagged.height, 42); assert.equal(tagged.style, STYLE.OFFICE);
  const house = CR.buildingFromTile({ h: 9, mh: 0, k: 'residential', e: 1 }, 110, 7, 52);
  assert.equal(house.style, STYLE.HOUSE); assert.ok(house.height >= 6 && house.height <= 8.6, `${house.height}`);
  assert.ok(house.roof === ROOF.GABLE || house.roof === ROOF.HIP);
  const block = CR.buildingFromTile({ h: 9, mh: 0, k: 'residential', e: 1 }, 1200, 7, 52);
  assert.equal(block.style, STYLE.APARTMENT); assert.ok(block.height >= 12 && block.height <= 22, `${block.height}`);
  const shed = CR.buildingFromTile({ h: 12, mh: 0, k: 'shed', e: 1 }, 20000, 7, 52);
  assert.equal(shed.style, STYLE.WAREHOUSE); assert.ok(shed.height >= 6 && shed.height <= 24); assert.equal(shed.roof, ROOF.FLAT);
  // deterministic per footprint, varied across footprints
  assert.deepEqual(CR.buildingFromTile({ h: 9, k: 'residential', e: 1 }, 700, 99, 52), CR.buildingFromTile({ h: 9, k: 'residential', e: 1 }, 700, 99, 52));
  const hs = new Set(); for (let s = 0; s < 40; s++) hs.add(CR.buildingFromTile({ h: 9, k: 'residential', e: 1 }, 700, s * 7919, 52).height);
  assert.ok(hs.size >= 3, 'estimated blocks vary in height');
  // a tall building is never a gabled house
  const tower = CR.buildingFromTile({ h: 120, k: 'residential', e: 0 }, 150, 1, 52);
  assert.notEqual(tower.style, STYLE.HOUSE); assert.equal(tower.roof, ROOF.FLAT);
});

test('every style has a facade grid and the shader table stays in step', () => {
  for (const s of Object.values(STYLE)) {
    if (s === STYLE.NONE) continue;
    const f = CR.FACADE[s];
    assert.ok(f && f.bay > 0 && f.floor > 0 && f.wx[0] < f.wx[1] && f.wy[0] < f.wy[1] && f.lit >= 0 && f.lit <= 1, `style ${s}`);
  }
  assert.ok(Math.max(...Object.values(STYLE)) <= 8, 'cityscape.js styleTable covers styles 1..8');
});

test('colours: deterministic, regional, roofs differ from walls', () => {
  const a = CR.buildingColours(STYLE.HOUSE, ROOF.GABLE, 12345, 52), b = CR.buildingColours(STYLE.HOUSE, ROOF.GABLE, 12345, 52);
  assert.deepEqual(a, b);
  for (const c of [...a.wall, ...a.roof]) assert.ok(c >= 0 && c <= 1);
  assert.notDeepEqual(a.wall, a.roof);
  const south = CR.buildingColours(STYLE.HOUSE, ROOF.FLAT, 5, 41), north = CR.buildingColours(STYLE.HOUSE, ROOF.FLAT, 5, 53);
  const lum = (c) => c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11;
  assert.ok(lum(south.wall) > 0.5, 'southern render is pale');
  assert.ok(north.wall.every((v) => Number.isFinite(v)));
});

test('cityLod: rings and devices', () => {
  const n = CR.cityLod('near'), m = CR.cityLod('mid'), f = CR.cityLod('far');
  assert.ok(n.trees > m.trees && m.trees > f.trees && f.trees === 0);
  assert.ok(n.maxBuildings >= m.maxBuildings && m.maxBuildings >= f.maxBuildings);
  assert.ok(f.minH > 0 && n.minH === 0, 'far ring drops small buildings');
  assert.equal(f.roofs, false); assert.equal(n.roofs, true);
  for (const w of ['near', 'mid', 'far']) {
    const d = CR.cityLod(w), p = CR.cityLod(w, true);
    assert.ok(p.maxBuildings <= d.maxBuildings / 2 + 1 && p.trees <= d.trees && p.maxVerts < d.maxVerts, `phone halves ${w}`);
  }
  assert.deepEqual(CR.cityLod('nonsense'), CR.cityLod('far'));
  const x = CR.cityLod('near'); x.trees = 1; assert.notEqual(CR.cityLod('near').trees, 1, 'returns a copy');
});

test('tree kinds by latitude and land class', () => {
  assert.equal(CR.treeKind(-12.4, 'residential', 0.1), 2, 'Darwin gardens: palms');
  assert.notEqual(CR.treeKind(53, 'residential', 0.1), 2, 'no palms in Hamburg');
  let conifers = 0; for (let i = 0; i < 100; i++) conifers += CR.treeKind(60, 'wood', i / 100) === 1 ? 1 : 0;
  assert.ok(conifers > 40, 'boreal forest is mostly conifers');
  assert.equal(CR.TREE_DENSITY.port, 0); assert.ok(CR.TREE_DENSITY.wood > CR.TREE_DENSITY.grass);
});

test('canopyScore: dark green yes; grass, water, roofs, sand no', () => {
  assert.ok(CR.canopyScore(40, 70, 35) > 0.4, 'canopy');
  assert.equal(CR.canopyScore(120, 170, 90), 0, 'bright lawn');
  assert.equal(CR.canopyScore(30, 60, 90), 0, 'water');
  assert.equal(CR.canopyScore(90, 90, 92), 0, 'grey roof');
  assert.equal(CR.canopyScore(150, 70, 50), 0, 'tile roof');
  assert.equal(CR.canopyScore(210, 200, 170), 0, 'sand');
  assert.equal(CR.canopyScore(5, 8, 4), 0, 'no data');
});

test('worker-safe: no three.js and no import-map paths', () => {
  for (const f of ['cityrules.js', 'citymesh.js']) {
    const src = fs.readFileSync(new URL(`../public/js/${f}`, import.meta.url), 'utf8');
    assert.ok(!/from\s+['"]three['"]/.test(src) && !/from\s+['"]\/shared\//.test(src), f);
  }
});
