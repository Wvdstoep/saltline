// Contract §7 politics-home: moving home (§4.14) and re-flagging (§4.13).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makePolitics, player, T0 } from './politics-helpers.mjs';

function setup() {
  const { pol, game } = makePolitics(), p = player({ home: 'ha1' });
  pol.migrate(p);                                   // flag XA, national:XA register, built 2020 (cond 78)
  return { pol, game, p };
}
test('move plan XA → XC: follows before/after, customs, compulsory re-flag to the cheapest open register (lr 3,600)', () => {
  const { pol, p } = setup();
  const plan = pol.homeMovePlan(p, pol.harborById('hc1'), { baseCost: 25000 });
  assert.deepEqual([plan.followsBefore, plan.followsAfter], [['XA', 'UN'], ['UN']]);
  assert.deepEqual([plan.customsBefore, plan.customsAfter], ['xu', 'XC']);
  assert.deepEqual(plan.reflag, [{ vesselId: 'p1', name: 'Sea Lark', from: 'national:XA', to: 'lr', cost: 3600, hours: 1 }]);
  assert.deepEqual(plan.costParts, { move: 25000, formation: 5000, reflag: 3600 });
  assert.equal(plan.cost, 33600); assert.equal(plan.formationH, 5); assert.equal(plan.allowed, true);
  const opts = pol.reflagOptions(p, p, 'XC');
  assert.deepEqual(opts.map((o) => [o.id, o.ok, o.cost]), [['lr', true, 3600], ['pa', true, 4100], ['national:XC', true, 5560], ['xus', false, 8200]]);
});
test('contracts the new country would not allow block the move until finished', () => {
  const { pol, p } = setup();
  p.builtIn = 'XA';
  p.jobs.push({ id: 'jd', type: 'freight', from: 'ha1', to: 'ha2', good: 'grain', qty: 10, title: 'Domestic grain', pol: { acceptedAt: T0 } });
  const plan = pol.homeMovePlan(p, pol.harborById('hc1'));
  assert.equal(plan.blocking.length, 1); assert.equal(plan.blocking[0].jobId, 'jd');
  assert.match(plan.blocking[0].reason, /needs a company based in XA/);
  assert.match(plan.allowed, /Finish or abandon/);
});
test('start → pending; cancel refunds 2,500; restart completes at readyAt with the re-flag', () => {
  const { pol, game, p } = setup();
  const h = pol.harborById('hc1');
  const r = pol.homeStart(p, h, { baseCost: 25000 });
  assert.equal(r.ok, true); assert.equal(p.money, 1000000 - 33600);
  assert.deepEqual(p.office.pol.pending, { harbor: 'hc1', readyAt: T0 + 5 * 3600, fee: 5000, startedAt: T0 });
  assert.equal(pol.homeCancel(p).refund, 2500); assert.equal(p.money, 1000000 - 33600 + 2500);
  assert.equal(p.reflag, null);
  pol.homeStart(p, h);
  game.simTime = T0 + 5 * 3600 - 1; pol.tick(p); assert.equal(p.office.home, 'ha1');
  game.simTime = T0 + 5 * 3600; pol.tick(p);
  assert.equal(p.office.home, 'hc1'); assert.equal(p.office.homeMoves, 1); assert.equal(p.office.pol.pending, null);
  assert.ok(game.events.some((e) => e.text.includes('Measures followed: UN.')));
  game.simTime = T0 + 6 * 3600; pol.tick(p);
  assert.deepEqual([p.flag.cc, p.flag.registry], ['XL', 'lr']);
  assert.deepEqual(p.flagWas.map((f) => f.cc), ['XA']);
});
test('a closed target port refuses the move; designated companies cannot re-flag; age limits apply', () => {
  const { pol, p } = setup();
  assert.match(pol.homeMovePlan(p, pol.harborById('hz')).allowed, /closed to merchant shipping/);
  p.ship.spd = 0; p.office.pol.designated = { XA: T0 + 10 };
  assert.match(pol.reflagStart(p, p, 'lr').text, /designated/);
  p.office.pol.designated = {};
  p.built = 1990;                                    // 36 years: over the 25-year limit of 'pa', survey above 20 years
  const o = pol.reflagOptions(p, p, 'XA');
  assert.equal(o.find((x) => x.id === 'pa').ok, false);
  assert.equal(o.find((x) => x.id === 'lr').cost, 3600 + 1200);
});
test('re-flag: the old flag goes to flag history (EU Art. 3ea style predicates see it)', () => {
  const { pol, game, p } = setup();
  p.flag = { cc: 'XE', registry: 'national:XE', since: 0 };
  p.ship.spd = 0;
  assert.equal(pol.reflagStart(p, p, 'lr').ok, true);
  game.simTime = T0 + 3600; pol.tick(p);
  assert.equal(p.flag.cc, 'XL');
  assert.equal(pol.entryCheck(p, 'ha1').refuse, true);   // flew XE after 2022-02-24
  assert.equal(pol.entryCheck(p, 'hc1').refuse, false);
});
