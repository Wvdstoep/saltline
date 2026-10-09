// Ship generators — three.js in node (public/js/shipgen.js): docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §9 test 7.
// For every motor model: bounding box length ±1 % of LOA and beam ±2 %, keel at −T ± 0.1, draw calls ≤ 24 (phone ≤ 16),
// LOD0 triangles within §6.6, same (variant, seed, livery) → same geometry hash, stage 0.3 has no superstructure,
// the livery hull colour is in the hull material; LOD levels at the §6.6 distances; build stages.
import test from 'node:test';
import * as THREE from 'three';
import assert from 'node:assert/strict';
import { MODELS, MODEL_IDS, defaultLivery } from '../shared/ships/index.js';
import { generalArrangement } from '../public/js/gastub.js';
import { buildFromGA, shipBounds, geometryHash, navLightSpots, SHIPGEN_GENS } from '../public/js/shipgen.js';
import { triBudget, DRAW_CALLS, lodDistances } from '../public/js/shipgeom.js';

const MOTOR = MODEL_IDS.filter((id) => MODELS[id].gen !== 'sail');
const SUPER = new Set(['house', 'glass', 'funnel', 'cargo', 'decals']);

test('every motor model builds to scale within the §6.6 budgets (desktop and phone)', () => {
  for (const id of MOTOR) {
    const ga = generalArrangement(id);
    const r = buildFromGA(ga);
    const b = shipBounds(r.lods[0]);
    const L = b.max.z - b.min.z, B = b.max.x - b.min.x;
    assert.ok(Math.abs(L - ga.L) / ga.L <= 0.01, `${id} length ${L.toFixed(2)} vs ${ga.L}`);
    assert.ok(Math.abs(B - ga.B) / ga.B <= 0.02, `${id} beam ${B.toFixed(2)} vs ${ga.B}`);
    assert.ok(Math.abs(b.min.y + ga.T) <= 0.1, `${id} keel ${b.min.y.toFixed(2)} vs −${ga.T}`);
    assert.ok(r.info.drawCalls[0] <= DRAW_CALLS.desktop, `${id} draw calls ${r.info.drawCalls[0]}`);
    assert.ok(r.info.tris[0] <= triBudget(ga.gen, ga.L), `${id} LOD0 tris ${r.info.tris[0]} > ${triBudget(ga.gen, ga.L)}`);
    assert.ok(r.info.tris[2] <= 1000 && r.info.tris[2] < r.info.tris[1] && r.info.tris[1] < r.info.tris[0], `${id} LOD chain ${r.info.tris.join('/')}`);
    const p = buildFromGA(ga, { phone: true, lod: 0 });
    assert.ok(p.info.drawCalls[0] <= DRAW_CALLS.phone, `${id} phone draw calls ${p.info.drawCalls[0]}`);
    assert.ok(p.info.tris[0] <= triBudget(ga.gen, ga.L, true), `${id} phone tris ${p.info.tris[0]}`);
    assert.ok(p.info.tris[0] < r.info.tris[0], `${id} phone lighter`);
  }
});

test('LOD object, determinism, livery, lights', () => {
  const ga = generalArrangement('ultramax64');
  const a = buildFromGA(ga, { seed: 7 }), b = buildFromGA(generalArrangement('ultramax64'), { seed: 7 });
  assert.equal(geometryHash(a.lods[0]), geometryHash(b.lods[0]), 'same inputs → same geometry');
  assert.equal(a.group.isLOD, true);
  const d = lodDistances(ga.L);
  assert.deepEqual(a.group.levels.map((l) => l.distance), [0, d[0], d[1], d[2]]);
  // container ships: the seed changes the stack pattern, not the hull
  const c1 = buildFromGA(generalArrangement('feeder1700'), { seed: 1, lod: 0 }), c2 = buildFromGA(generalArrangement('feeder1700'), { seed: 2, lod: 0 });
  assert.notEqual(geometryHash(c1.group), geometryHash(c2.group));
  // livery hull colour → hull material (and the boot-top material)
  const lv = { ...defaultLivery('tug24'), hull: 0x123456, boot: 0x654321, funnel: 0xabcdef };
  const t = buildFromGA(generalArrangement('tug24', { livery: lv }), { lod: 0 });
  const hull = t.group.children.find((m) => m.name === 'hull');
  const mats = Array.isArray(hull.material) ? hull.material : [hull.material];
  assert.ok(mats.some((m) => m.color.getHex() === 0x123456), 'hull colour');
  assert.ok(mats.some((m) => m.color.getHex() === 0x654321), 'boot-top colour');
  assert.equal(t.mats.funnel.color.getHex(), 0xabcdef, 'funnel colour');
  // navigation lights in ship.js' ctx.lights shape
  const L = navLightSpots(ga);
  for (const k of ['x', 'y', 'z', 'mastY', 'mastZ']) assert.ok(Number.isFinite(L[k]), k);
  assert.ok(L.x <= ga.B / 2 && L.mastY > ga.bridge.y);
});

test('build stages: blocks, hull behind the clip plane, primer, full livery', () => {
  for (const id of ['ultramax64', 'cruise330', 'tug24', 'psv90']) {
    const ga = generalArrangement(id);
    const s0 = buildFromGA(ga, { stage: 0.1, lod: 0 });
    assert.ok(s0.group.children.every((m) => m.name === 'paint'), `${id} stage 0.1: keel blocks only`);
    const s3 = buildFromGA(ga, { stage: 0.3, lod: 0 });
    assert.ok(!s3.group.children.some((m) => SUPER.has(m.name)), `${id} stage 0.3: no superstructure (${s3.group.children.map((m) => m.name)})`);
    assert.ok(Number.isFinite(s3.info.clipY) && s3.info.clipY > -ga.T && s3.info.clipY < ga.deckY, `${id} clip plane`);
    const s7 = buildFromGA(ga, { stage: 0.7, lod: 0 });
    assert.ok(s7.group.children.some((m) => m.name === 'house'), `${id} stage 0.7: superstructure`);
    assert.equal(s7.mats.house.color.getHex(), 0x9aa0a6, `${id} primer grey`);
    const s9 = buildFromGA(ga, { stage: 1, lod: 0 });
    assert.equal(s9.mats.hull.color.getHex(), ga.livery.hull, `${id} full livery`);
  }
  // cargo only on a finished ship
  assert.ok(buildFromGA(generalArrangement('feeder1700'), { lod: 0 }).group.children.some((m) => m.name === 'cargo'));
  assert.ok(!buildFromGA(generalArrangement('feeder1700'), { lod: 0, stage: 0.95 }).group.children.some((m) => m.name === 'cargo'));
  assert.ok(!buildFromGA(generalArrangement('feeder1700'), { lod: 0, cargo: false }).group.children.some((m) => m.userData.cargo));
});

test('makeMat hook (ship.js wear materials) and the generator list', () => {
  const made = [];
  const r = buildFromGA(generalArrangement('mr50'), { lod: 0, makeMat: (kind, color, p) => { made.push(kind); const m = new THREE.MeshStandardMaterial({ color, vertexColors: !!p.vertexColors }); m.userData.kind = kind; return m; } });
  assert.ok(['hull', 'boot', 'deck', 'house', 'paint', 'funnel'].every((k) => made.includes(k)), made.join());
  assert.equal(r.mats.hull.userData.kind, 'hull');
  assert.ok(r.group.children.find((m) => m.name === 'hull'));
  // every generator of §6.1 except 'sail' (SAILING's rigmesh.js) is implemented
  for (const g of ['aft_house_dry', 'aft_house_tanker', 'lng', 'container', 'roro_pctc', 'ferry', 'cruise', 'offshore', 'tug', 'fishing', 'small_fast', 'motor_yacht', 'special']) assert.ok(SHIPGEN_GENS.includes(g), g);
  assert.ok(!SHIPGEN_GENS.includes('sail'));
});
