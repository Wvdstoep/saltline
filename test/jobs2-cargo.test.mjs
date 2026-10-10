// Lane D §9 test 12 (cargo-compat): handling classes, units and the market compatibility rule (§5.1–§5.3, §5.10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useStub, STUB_MODELS } from './jobs2-helpers.mjs';
import { CARGO, canLoad, toTonnes, fromTonnes, unitsOf, freeUnits, handlingOf, eqOf, craneSwlOf, makeStack, marketGoodOf, handlingText } from '../shared/cargo.js';
import { setShipSource, modelOf, iceOf, iceRank, bpOf } from '../shared/jobs/shipview.js';
import { healCargoStack } from '../shared/jobs/types.js';
import { GOODS } from '../shared/constants.js';

useStub();

test('canLoad: the §9 cargo-compat cases', () => {
  const g = canLoad('grain', 'boxship');
  assert.equal(g.ok, false); assert.equal(g.why.code, 'handling'); assert.equal(g.why.text, 'Needs bulk holds — e.g. Handysize, Ultramax, Capesize');
  assert.equal(canLoad('containers', 'boxship').ok, true);
  const c = canLoad('crude', 'mr50');
  assert.equal(c.ok, false); assert.equal(c.why.text, 'Needs crude tanks — e.g. Aframax, Suezmax, VLCC');
  assert.equal(canLoad('crude', 'aframax115').ok, true);
  assert.equal(canLoad('lng', 'vlgc86k').ok, false);
  assert.equal(canLoad('lng', 'lng174k').ok, true);
  assert.equal(canLoad('vehicles', 'pctc7000').ok, true);
  for (const id of Object.keys(STUB_MODELS)) assert.equal(canLoad('livestock', id).ok, id === 'livestock135', `livestock on ${id}`);
  assert.equal(canLoad('livestock', 'coaster').ok, false);
  assert.equal(canLoad('fuel', 'coaster').ok, false, 'Q5: the coaster loses fuel cargo');
  assert.equal(canLoad('fuel', 'tanker').ok, true);
  assert.equal(canLoad('crude', 'tanker').ok, true, 'legacy tanker: clean + crude');
});

test('units and tonnes', () => {
  assert.equal(toTonnes('lng', 174000), 78300);
  assert.equal(toTonnes('containers', 1000), 12000);
  assert.equal(toTonnes('reefer_box', 100), 1400);
  assert.equal(toTonnes('vehicles', 7000), 10500);
  assert.equal(toTonnes('trailers', 100), 220);
  assert.equal(toTonnes('livestock', 4000), 2000);
  assert.equal(toTonnes('lpg', 1000), 550);
  assert.equal(toTonnes('spoil', 5000), 8000);
  assert.equal(fromTonnes('lng', 78300), 174000);
  assert.deepEqual(['containers', 'reefer_box', 'dg_box'].map((g) => CARGO[g].unit), ['teu', 'teu', 'teu']);
  // every market good of today is in the taxonomy
  for (const g of Object.keys(GOODS)) assert.ok(CARGO[g], g);
  // world economy §9.1: every catalogue good trades on the markets; only job-only goods fall back (fruit → bananas)
  assert.equal(marketGoodOf('crude'), 'crude'); assert.equal(marketGoodOf('ore'), 'ore'); assert.equal(marketGoodOf('grain'), 'grain');
  assert.equal(marketGoodOf('fruit'), 'bananas'); assert.equal(marketGoodOf('reefer_box'), 'containers');
});

test('market compatibility (§5.10)', () => {
  const rows = [['fuel', 'mr50', true], ['containers', 'feeder1700', true], ['grain', 'ultramax64', true], ['steel', 'ultramax64', true],
    ['steel', 'coaster', true], ['machinery', 'feeder', true], ['machinery', 'bulker', true], ['fish', 'trawler', true], ['fish', 'coaster', true],
    ['supplies', 'psv', true], ['supplies', 'coaster', true], ['grain', 'tanker', false], ['containers', 'bulker', false], ['fish', 'boxship', false]];
  for (const [good, cls, ok] of rows) assert.equal(canLoad(good, cls).ok, ok, `${good} on ${cls}`);
});

test('legacy hulls without Lane A keep their §5.2 handling', () => {
  setShipSource({ MODELS: {}, modelOf: () => null });
  try {
    assert.deepEqual(handlingOf('coaster'), ['bulk', 'breakbulk', 'box']);
    assert.equal(unitsOf('coaster').teu, 60); assert.equal(unitsOf('coaster').t, 1200);
    assert.equal(unitsOf('boxship').teu, 6500); assert.equal(unitsOf('ferry').lm, 900); assert.equal(unitsOf('ferry').pax, 400);
    assert.ok(eqOf('coaster').includes('geared')); assert.ok(!eqOf('feeder').includes('geared'));
    assert.equal(modelOf('ultramax64'), null, 'unknown model without the catalogue');
    assert.equal(bpOf('tug'), 80);
  } finally { useStub(); }
});

test('equipment, options and ice classes', () => {
  assert.ok(eqOf('ultramax64').includes('geared'));
  assert.ok(!eqOf('ultramax64~gearless').includes('geared'), 'gearless option removes the cranes');
  assert.equal(craneSwlOf('mpp160'), 350);
  assert.equal(craneSwlOf('ultramax64~gearless'), 0);
  assert.equal(iceOf('ultramax64~lng.i1c.esd'), 'i1c');
  assert.equal(iceOf('icebreaker120'), 'pc3');
  assert.equal(iceOf('research75'), 'i1a');
  assert.ok(iceRank('expedition105') > iceRank('ultramax64~i1a'));
  assert.equal(bpOf('tug24'), 70);
});

test('freeUnits per unit; old stacks heal to tonnes', () => {
  const v = { ship: { cls: 'feeder1700' }, cargo: [makeStack('containers', 500, 'teu', 'j1'), { good: 'steel', qty: 300 }], jobs: [] };
  assert.equal(freeUnits(v, 'teu'), 1200);
  assert.equal(freeUnits(v, 't'), 19350 - 6000 - 300);
  const ferry = { ship: { cls: 'ferry' }, cargo: [], jobs: [{ pax: 120 }, { pax: 30 }] };
  assert.equal(freeUnits(ferry, 'pax'), 250);
  const old = healCargoStack({ good: 'grain', qty: 400, contraband: false, jobId: null });
  assert.equal(old.unit, 't'); assert.equal(old.units, 400);
  assert.equal(handlingText('liquid:crude'), 'Needs crude tanks — e.g. Aframax, Suezmax, VLCC');
});
