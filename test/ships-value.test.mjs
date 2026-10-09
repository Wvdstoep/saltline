// docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §9 test 4: ship value with age, build country, finish and the Jones premium.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHIP_CLASSES } from '../shared/constants.js';
import { shipValue } from '../server/economy.js';
import { marketValue, shipValueCompat, ageMul, jonesOk, noteFlagChange, healShipsVessel, listingPrice, basePrice, inspectFee, repaintCost } from '../shared/ships/index.js';

const NOW = Date.UTC(2026, 9, 9, 12) / 1000;
const built = (cls, builtIn, age, cond = 100, extra = {}) => ({ ship: { cls }, cond, hist: { v: 1, estimated: false, built: 2026 - age, builtIn, jonesLost: false, rebuiltAbroad: false, ...extra } });

test('migrated coaster at 78 % → 55,836 (the wave-2 D12 price basis 120,000)', () => {
  const v = healShipsVessel({ ship: { cls: 'coaster' }, cond: 78 }, NOW);
  assert.equal(v.hist.estimated, true); assert.equal(v.hist.builtIn, 'XX');
  assert.equal(marketValue(v, null, NOW), 55836);
  assert.equal(marketValue({ ship: { cls: 'coaster' }, cond: 78 }, 'US', NOW), 55836, 'unknown build: never Jones-eligible');
  // today's shipValue scraps the coaster for 0 until wave 2 sets her price; the compat wrapper keeps that rule
  assert.equal(shipValue('coaster', 78), 0);
  assert.equal(shipValueCompat('coaster', 78), 0);
  assert.equal(shipValueCompat('coaster', 78, { coaster: { ...SHIP_CLASSES.coaster, price: 120000 } }), 55836, 'after D12: 55,836');
});

test('every priced legacy ship keeps today\'s shipValue exactly (migrated: estimated hist, builtIn XX)', () => {
  for (const cls of Object.keys(SHIP_CLASSES)) {
    for (let cond = 0; cond <= 100; cond += 1) {
      const v = healShipsVessel({ ship: { cls }, cond }, NOW);
      if (SHIP_CLASSES[cls].price > 0) assert.equal(marketValue(v, null, NOW), shipValue(cls, cond), `${cls} ${cond}`);
      assert.equal(shipValueCompat(cls, cond), shipValue(cls, cond), `${cls} ${cond}`);
    }
  }
});

test('new MR tanker: KR-built 3,512,300 new; 2,114,405 at 10 years and 80 %; ageMul floors at 0.25', () => {
  assert.equal(marketValue(built('mr50', 'KR', 0), null, NOW), 3512300);
  assert.equal(marketValue(built('mr50', 'KR', 10, 80), null, NOW), 2114405);
  assert.equal(ageMul(25), 0.25); assert.equal(ageMul(40), 0.25); assert.equal(ageMul(10), 0.7);
  assert.equal(marketValue(built('mr50', 'KR', 30), null, NOW), Math.round(6200000 * 0.55 * 1 * 0.25 * 1.03));
  assert.equal(marketValue(built('mr50', 'CN', 0), null, NOW), Math.round(6200000 * 0.55 * 0.95));
  assert.equal(marketValue(built('mr50~prem', 'JP', 0), null, NOW), Math.round(basePrice('mr50~prem') * 0.55 * 1.05 * 1.05), 'finish resale × build country');
});

test('Jones premium: a US-built tug24 is worth 225,280 at New York and 140,800 at Rotterdam; a re-flag loses it for ever', () => {
  const v = built('tug24', 'US', 0);
  assert.equal(jonesOk(v), true);
  assert.equal(marketValue(v, 'US', NOW), 225280);
  assert.equal(marketValue(v, 'NL', NOW), 140800);
  assert.equal(noteFlagChange(v, 'US', 'PA'), true);
  assert.equal(noteFlagChange(v, 'PA', 'US'), false, 'back under the US flag');
  assert.equal(v.hist.jonesLost, true);
  assert.equal(jonesOk(v), false);
  assert.equal(marketValue(v, 'US', NOW), 140800);
  assert.equal(jonesOk(built('tug24', 'NL', 0)), false, 'foreign-built');
  assert.equal(jonesOk(built('tug24', 'US', 0, 100, { rebuiltAbroad: true })), false);
  assert.equal(jonesOk({ ship: { cls: 'tug' }, builtIn: 'US' }), true, 'politics field read when hist is missing');
});

test('listing price, inspection and repaint fees', () => {
  assert.equal(listingPrice('mr50', 100, 0, 'KR', 0.5), Math.round(6200000 * 0.85 * 1 * 1.03 * 1.0));
  assert.equal(listingPrice('mr50', 50, 10, 'CN', 0), Math.round(6200000 * 0.625 * 0.7 * 0.95 * 0.9));
  assert.equal(inspectFee(2000000), 4000); assert.equal(inspectFee(100000), 500);
  assert.equal(repaintCost('ultramax64'), Math.round(0.003 * 6950000)); assert.equal(repaintCost('rib8'), 2000);
});
