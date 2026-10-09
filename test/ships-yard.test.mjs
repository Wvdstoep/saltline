// docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §9 test 3: yard prices, times, payment plans, backlog, delays, politics R3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HARBORS } from '../server/harbors.js';
import {
  registerHarbors, yardPrice, stockPrice, resaleSlotPrice, deliveryHours, milestoneTimes, instalments, backlogMonths, productionMonths, yardsFor,
  financing, delayRoll, newOrder, canOrderAt, yardById, MODELS, YARD, seededRnd, ldFor, orderProgress, compactOrder,
} from '../shared/ships/index.js';

registerHarbors(HARBORS);
const H = (s) => s / 3600;

test('E1 Ultramax at Yangzijiang: 6,067,000 cr, tail schedule, 95.4 h with milestones 36.0 / 50.85 / 74.61 / 95.4', () => {
  const price = yardPrice('ultramax64', 'yzj');
  assert.equal(price, 6067000);
  assert.deepEqual(instalments(price, 'yzj', 'ultramax64').map((x) => x.cr), [606700, 606700, 606700, 606700, 3640200]);
  assert.deepEqual(instalments(price, 'yzj', 'ultramax64').map((x) => x.key), ['contract', 'steel', 'keel', 'launch', 'delivery']);
  assert.equal(deliveryHours('ultramax64', 'yzj'), 95.4);
  const t = milestoneTimes(0, 'ultramax64', 'yzj');
  assert.deepEqual([H(t.steel), H(t.keel), H(t.launch), H(t.delivery)], [36, 50.85, 74.61, 95.4]);
});

test('E2 Ultramax LNG / 1C / ESD at Imabari: 8,187,000 cr, 104.43 h', () => {
  assert.equal(yardPrice('ultramax64~lng.i1c.esd', 'imabari'), 8187000);
  assert.equal(deliveryHours('ultramax64~lng.i1c.esd', 'imabari'), 104.43);
  assert.deepEqual(instalments(8187000, 'imabari', 'ultramax64').map((x) => x.cr), [1637400, 1637400, 1637400, 1637400, 1637400], 'std5 in Japan');
});

test('E3 MR tanker: 12,400,000 cr / 138 h at Philly (Title XI) vs 6,014,000 cr / 124.8 h at Hyundai Mipo', () => {
  assert.equal(yardPrice('mr50', 'philly'), 12400000);
  assert.equal(deliveryHours('mr50', 'philly'), 138);
  assert.deepEqual(financing('philly', 12400000), { name: 'MARAD Title XI', ltv: 0.875, years: 25, max: 10850000, titleXI: true });
  assert.equal(yardPrice('mr50', 'hmd_ulsan'), 6014000);
  assert.equal(deliveryHours('mr50', 'hmd_ulsan'), 124.8);
  assert.deepEqual(financing('hmd_ulsan', 6014000), { name: 'KEXIM, K-SURE', ltv: 0.8, years: 12, max: 4811200, titleXI: false });
});

test('E4/E5 tugs: Eastern 497,000 vs Sanmar 261,000; stock at Damen Gorinchem 349,000; local US boatyard tug16 134,000', () => {
  assert.equal(yardPrice('tug24', 'eastern_sb'), 497000);
  assert.equal(yardPrice('tug24', 'sanmar'), 261000);
  assert.equal(stockPrice('tug24', 'damen_gorinchem'), 349000);
  assert.equal(yardPrice('tug16', 'local:new_york'), 134000);
  assert.equal(resaleSlotPrice('ultramax64', 'yzj'), Math.round(6067000 * 1.12 / 1000) * 1000);
  assert.equal(deliveryHours('ultramax64', 'yzj', 0, 0, 'resale'), 59.4, 'a resale slot skips the backlog');
  assert.deepEqual(instalments(134000, 'local:new_york', 'tug16').map((x) => [x.key, x.cr]), [['contract', 40200], ['delivery', 93800]], 'small schedule');
  assert.equal(yardById('local:rotterdam').name, 'Rotterdam boatyard');
  assert.equal(yardById('local:lowestoft'), null, 'minor harbours have no boatyard');
  assert.equal(canOrderAt('tug24', 'local:rotterdam').ok, false);
  assert.equal(canOrderAt('flybridge18', 'local:rotterdam').ok, true);
  assert.equal(canOrderAt('myacht', 'local:rotterdam').ok, true, '24 m yacht');
  assert.deepEqual(canOrderAt('vlcc300', 'yzj'), { ok: false, why: 'This yard does not build this type.' });
});

test('backlog: +1 month per open order at the yard', () => {
  assert.equal(backlogMonths('yzj', 0), 6);
  assert.equal(backlogMonths('yzj', 3), 9);
  const orders = [{ yard: 'yzj', state: 'building' }, { yard: 'yzj', state: 'delivered' }, { yard: 'imabari', state: 'ordered' }, { yard: 'yzj', state: 'ready' }];
  assert.equal(backlogMonths('yzj', orders), 8);
  assert.equal(deliveryHours('ultramax64', 'yzj', 2), Math.round((8 + 9.9) * 6 * 100) / 100);
  assert.equal(productionMonths(MODELS.ultramax64, 'yzj'), 11 * 0.9);
});

test('delay roll over 10,000 seeded ids: 70 / 20 / 10 % within ±2 %; liquidated damages', () => {
  const c = { 0: 0, 0.1: 0, 0.25: 0 };
  const R = seededRnd('ids');
  for (let i = 0; i < 10000; i++) c[delayRoll('o' + Math.floor(R() * 2 ** 40).toString(36))]++;
  assert.ok(Math.abs(c[0] / 10000 - 0.7) < 0.02, `${c[0]}`);
  assert.ok(Math.abs(c[0.1] / 10000 - 0.2) < 0.02, `${c[0.1]}`);
  assert.ok(Math.abs(c[0.25] / 10000 - 0.1) < 0.02, `${c[0.25]}`);
  assert.equal(delayRoll('oabc'), delayRoll('oabc'), 'deterministic');
  assert.equal(ldFor(6067000, 9.9, 0.25), Math.round(0.005 * 6067000 * 9.9 * 0.25));
  const o = newOrder({ id: 'otest', ownerId: 'p', variant: 'ultramax64', yard: 'yzj', createdAt: 1000, delayFrac: 0.1 });
  assert.equal(H(o.deliverAt - 1000), Math.round((6 + 9.9 * 1.1) * 6 * 3600) / 3600);
  assert.equal(H(o.plannedDeliverAt - 1000), 95.4);
  assert.equal(o.schedule.reduce((s, x) => s + x.cr, 0), o.price);
  assert.equal(o.schedule[0].dueAt, 1000); assert.equal(o.schedule[1].dueAt, o.steelAt);
  assert.equal(orderProgress(o, o.steelAt), 0); assert.equal(compactOrder(o, 1000).next.cr, 606700);
});

test('politics R3: a yardCheck blocking RU marks the Russian yard blocked with the reason text', () => {
  const block = { text: 'Not allowed for your company: EU Reg. 833/2014 (import of vessels from Russia)' };
  const list = yardsFor('vlcc300', { yardCheck: (cc) => (cc === 'RU' ? { ok: false, block } : { ok: true }) });
  const ru = list.find((y) => y.yardId === 'ru_far_east');
  assert.ok(ru); assert.deepEqual(ru.blockedBy, block);
  assert.ok(list.filter((y) => y.yardId !== 'ru_far_east').every((y) => !y.blockedBy));
  for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].price <= list[i].price, 'sorted by price');
  assert.ok(yardsFor('vlcc300').every((y) => !y.blockedBy), 'without politics every yard is allowed');
  // local boatyard appears with ctx.harbor
  assert.ok(yardsFor('rib8', { harbor: 'rotterdam' }).some((y) => y.yardId === 'local:rotterdam'));
});

test('instalments sum exactly to the price for 1,000 random prices; every buildable model has a yard', () => {
  const R = seededRnd('prices');
  const plans = [['yzj', 'ultramax64'], ['imabari', 'ultramax64'], ['local:rotterdam', 'rib8'], ['hallberg_rassy', 'ketch']];
  for (let i = 0; i < 1000; i++) {
    const price = Math.round(R() * 5e7) + 1, [y, m] = plans[i % plans.length];
    const parts = instalments(price, y, m);
    assert.equal(parts.reduce((s, x) => s + x.cr, 0), price);
    assert.ok(parts.every((x) => Number.isInteger(x.cr) && x.cr >= 0));
  }
  for (const m of Object.values(MODELS)) assert.ok(yardsFor(m.id).length >= 1, m.id);
  assert.equal(YARD.MONTH_H, 6);
});
