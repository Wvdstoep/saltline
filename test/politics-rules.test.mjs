// Contract §7 politics-rules: exact numbers from docs/WORLD-POLITICS-CONTRACT.md (§4.5, §4.6, §4.8, §4.9, §4.11).
import test from 'node:test';
import assert from 'node:assert/strict';
import { hullValue, warPremium, riskPay, transitChance, piracyChance, ecaCost, ecaPerT, dutyFor, tradeCheck, tradeProfileMul, destWeightFor, POL } from '../shared/politics.js';
import { fixtureDs, ctxFor, makePolitics } from './politics-helpers.mjs';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test('hull value: coaster 78 %, feeder 100 %, tanker 100 %', () => {
  assert.equal(hullValue('coaster', 78), 90120);
  assert.equal(hullValue('feeder', 100), 807500);
  assert.equal(hullValue('tanker', 100), 3570000);
});
test('war premium: sourced rates and the tier-1 fallback', () => {
  assert.equal(warPremium({ apPct: 1.0 }, 'coaster', 78), 901);
  assert.equal(warPremium({ apPct: 0.7 }, 'feeder', 100), 5653);
  assert.equal(warPremium({ apPct: 0.7 }, 'tanker', 100), 24990);
  assert.equal(warPremium({ tier: 1, apPct: null }, 'feeder', 100), 404);
  assert.equal(warPremium({ tier: 1 }, 'feeder', 100), 404);
});
test('risk pay by tier', () => {
  assert.equal(riskPay(100000, 4), 300000);
  assert.equal(riskPay(100000, 3), 220000);
  assert.equal(riskPay(100000, 2), 140000);
  assert.equal(riskPay(100000, 1), 110000);
  assert.equal(riskPay(100000, 0), 100000);
});
test('transit incident chance: 1,100 km at 18 kn through pDay 0.004 (and a ×3 profile)', () => {
  near(transitChance(0.004, 1100, 18), 0.005495);
  near(transitChance(0.004, 1100, 18, 3), 0.016461);
  assert.equal(transitChance(0.004, 0, 18), 0);
});
test('piracy chance: 600 km at p100 0.004, and at ≥ 18 kn', () => {
  near(piracyChance(0.004, 600, {}), 0.023761);
  near(piracyChance(0.004, 600, { speedKn: 18 }), 0.007178);
  near(piracyChance(0.004, 600, { speedKn: 10, convoy: true, guards: true }), 1 - Math.pow(1 - 0.004 * 0.1, 6), 1e-12);
});
test('ECA surcharge: 2.0 t burned inside → 455 cr', () => {
  assert.equal(ecaPerT(), 227.5);
  assert.equal(ecaCost(2.0), 455);
});
test('duty: MFN 5 % on 1,000 t steel at 900 cr/t → 45,000 + 150 fee (net 854,850)', () => {
  const ds = fixtureDs(), ctx = ctxFor(ds, { home: 'XC' });
  const d = dutyFor(ds, ctx, { harbor: 'hd1', good: 'steel', origin: 'XC', value: 900000 });
  assert.deepEqual([d.rate, d.duty, d.fee, d.via], [0.05, 45000, 150, 'mfn']);
  assert.equal(900000 - d.duty - d.fee, 854850);
});
test('duty: inside a customs union → 0 + 0; FTA → 0 + 50; signed-not-in-force FTA is ignored', () => {
  const ds = fixtureDs(), ctx = ctxFor(ds, { home: 'XC' });
  const cu = dutyFor(ds, ctx, { harbor: 'ha1', good: 'steel', origin: 'XB', value: 900000 });
  assert.deepEqual([cu.duty, cu.fee, cu.via], [0, 0, 'xu']);
  const fta = dutyFor(ds, ctx, { harbor: 'ha1', good: 'steel', origin: 'XC', value: 900000 });
  assert.deepEqual([fta.rate, fta.duty, fta.fee, fta.via], [0, 0, 50, 'xfta']);
  const sig = dutyFor(ds, ctx, { harbor: 'hd1', good: 'grain', origin: 'XC', value: 100000 });
  assert.deepEqual([sig.duty, sig.fee, sig.via], [10000, 150, 'mfn']);
});
test('duty: an additional duty stacks on MFN; unknown origin pays MFN; no tariff row → not modelled, 0', () => {
  const ds = fixtureDs(), ctx = ctxFor(ds, { home: 'XC' });
  const add = dutyFor(ds, ctx, { harbor: 'hd1', good: 'steel', origin: 'XE', value: 900000 });
  assert.equal(add.rate, 0.3); assert.equal(add.duty, 270000); assert.equal(add.fee, 150);
  const unk = dutyFor(ds, ctx, { harbor: 'hd1', good: 'steel', origin: null, value: 900000 });
  assert.deepEqual([unk.duty, unk.fee], [45000, 150]);
  const none = dutyFor(ds, ctx, { harbor: 'hc1', good: 'steel', origin: 'XD', value: 900000 });
  assert.deepEqual([none.rate, none.duty, none.modelled], [0, 0, false]);
});
test('trusted operator (standing ≥ 40) pays no customs fee', () => {
  const ds = fixtureDs(), ctx = ctxFor(ds, { home: 'XC', rep: { XD: 40 } });
  assert.equal(dutyFor(ds, ctx, { harbor: 'hd1', good: 'steel', origin: 'XC', value: 900000 }).fee, 0);
});
test('sell check returns the duty', () => {
  const ds = fixtureDs(), r = tradeCheck(ds, ctxFor(ds, { home: 'XC' }), { harbor: 'hd1', good: 'steel', side: 'sell', origin: 'XC', value: 900000 });
  assert.equal(r.ok, true); assert.equal(r.duty.duty, 45000);
});
test('trade profile: exp 900 / imp 100 → 0.80; exp 0 / imp 500 → 1.25; no data → null', () => {
  assert.equal(tradeProfileMul({ exp: 900, imp: 100 }), 0.8);
  assert.equal(tradeProfileMul({ exp: 0, imp: 500 }), 1.25);
  assert.equal(tradeProfileMul(null), null);
  const { pol } = makePolitics();
  assert.equal(pol.tradeProfile('XA', 'grain'), 0.8);
  assert.equal(pol.tradeProfile('XB', 'fish'), 1.25);
  assert.equal(pol.tradeProfile('XC', 'grain'), null);
});
test('destination weight: share 0.3 → 2.8; closed port → 0; no flow → 1', () => {
  assert.equal(destWeightFor(0.3), 2.8);
  const { pol } = makePolitics();
  assert.equal(pol.destWeight('ha1', 'hd1', 'grain'), 2.8);
  assert.equal(pol.destWeight('ha1', 'hc1', 'grain'), 2.2);
  assert.equal(pol.destWeight('ha1', 'hz', 'grain'), 0);
  assert.equal(pol.destWeight('ha1', 'hb1', 'grain'), 1);
});
test('risk tags and pay multiplier per harbour pair', () => {
  const { pol } = makePolitics();
  assert.deepEqual(pol.riskOf('hd1', 'hr'), { tier: 4, areas: ['war4'] });
  assert.equal(pol.riskOf('ha1', 'hh1').tier, 3);
  assert.equal(pol.riskOf('ha1', 'hb1').tier, 0);
  assert.equal(pol.jobEnvHooks().payMul('hd1', 'hr'), 3);
  const j = pol.tagJob({ id: 'j1', from: 'ha1', to: 'ha2' });
  assert.deepEqual(j.pol, { tier: 0, areas: [], cab: 'XA', ver: '2099.01.1' });
});
