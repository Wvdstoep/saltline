// Interiors v2 — model parameters (docs/INTERIORS-V2-CONTRACT.md §4.7, Lane A): every model / variant its own
// numbers (era, crew, washrooms, cabin sizes, fuel, palette), deterministic, overrides applied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelParams, mlcArea, hashStr, rng, IV2_OVERRIDES } from '../shared/ships/gaparams.js';
import { MODELS } from '../shared/ships/catalogue.js';

const IDS = Object.keys(MODELS).filter((k) => MODELS[k].gen !== 'sail');

test('params: every non-sail model has frozen params; sail and unknown ids have none', () => {
  for (const id of IDS) {
    const p = modelParams(id);
    assert.ok(p, id);
    assert.ok(Object.isFrozen(p) && Object.isFrozen(p.crew), `${id} frozen`);
    assert.equal(modelParams(id), p, `${id} cached`);
    assert.ok(['classic', 'eco'].includes(p.era), `${id} era`);
    assert.ok(p.crew.officers + p.crew.ratings >= 1, `${id} crew`);
    assert.ok(p.cabin.rating >= p.cabin.mlcRating && p.cabin.officer >= p.cabin.mlcOfficer, `${id} cabins ≥ MLC`);
    assert.ok(['hfo', 'mgo', 'lng', 'meoh'].includes(p.fuel), `${id} fuel`);
  }
  const sail = Object.keys(MODELS).find((k) => MODELS[k].gen === 'sail');
  if (sail) assert.equal(modelParams(sail), null);
  assert.equal(modelParams('nonesuch'), null);
});

test('params: washrooms — classic with ≥ 12 crew share, everyone else en-suite', () => {
  let shared = 0, ensuite = 0;
  for (const id of IDS) {
    const p = modelParams(id), n = p.crew.officers + p.crew.ratings;
    const want = p.era === 'classic' && n >= 12 ? 'shared' : 'ensuite';
    assert.equal(p.crew.washrooms, want, id);
    if (want === 'shared') shared++; else ensuite++;
  }
  assert.ok(ensuite > 0, 'some en-suite');
  assert.ok(shared >= 0);
});

test('params: MLC minimum cabin areas by tonnage', () => {
  assert.equal(mlcArea(2500), 4.5); assert.equal(mlcArea(5000), 5.5); assert.equal(mlcArea(36000), 7.0);
  assert.equal(mlcArea(2500, true), 7.5); assert.equal(mlcArea(5000, true), 8.5); assert.equal(mlcArea(36000, true), 10.0);
});

test('params: variants — premium +10 % cabin area, LNG engine → LNG fuel, eco era', () => {
  const base = modelParams('ultramax64'), prem = modelParams('ultramax64~prem'), lng = modelParams('ultramax64~lng.i1c.esd');
  assert.ok(prem && prem.premium && !base.premium);
  assert.ok(Math.abs(prem.cabin.officer - Math.min(13, base.cabin.officer * 1.1)) < 1e-9, `${prem.cabin.officer}`);
  assert.equal(lng.fuel, 'lng');
  assert.equal(base.era, 'eco');
  assert.notEqual(base.seed, prem.seed, 'each variant its own seed');
});

test('params: overrides applied (giga100 cinema, icebreaker ice)', () => {
  for (const [id, ov] of Object.entries(IV2_OVERRIDES)) {
    const p = modelParams(id); if (!p) continue;
    for (const [k, v] of Object.entries(ov)) assert.deepEqual(p[k], v, `${id}.${k}`);
  }
  if (MODELS.giga100) assert.ok(modelParams('giga100').extras.includes('cinema'));
  if (MODELS.icebreaker120) assert.equal(modelParams('icebreaker120').ice, true);
});

test('params: hash and rng are deterministic', () => {
  assert.equal(hashStr('ultramax64'), hashStr('ultramax64'));
  assert.notEqual(hashStr('ultramax64'), hashStr('ultramax65'));
  const a = rng(42), b = rng(42);
  for (let i = 0; i < 5; i++) { const x = a(); assert.equal(x, b()); assert.ok(x >= 0 && x < 1); }
});
