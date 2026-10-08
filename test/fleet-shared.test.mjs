// v6 fleet: the frozen numbers and pure rules of shared/fleet.js (docs/V6-FLEET-CONTRACTS.md §4, §14.1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FLEET, storageFeePerDay, recommissionFee, transferFee, wageRateMcrH, accrueWage, defaultShipName, validShipName, homeAllowed,
  stateOf, dayKey, lastDays, totals, normalizeOrder, VESSEL_ID_RE, JOB_ID_RE, LEDGER_CATS,
} from '../shared/fleet.js';
import { harborById } from '../server/harbors.js';

const isH = (id) => !!harborById(id);

test('storage, recommission and transfer fees: the reference numbers', () => {
  assert.deepEqual(['coaster', 'trawler', 'feeder', 'bulker', 'boxship', 'sloop'].map(storageFeePerDay), [32, 25, 140, 400, 1100, 25]);
  assert.deepEqual(['coaster', 'trawler', 'pilot', 'boxship'].map(recommissionFee), [240, 360, 240, 50000]);
  assert.deepEqual([1500, 100000, 150000, 2375000, 6000000].map(transferFee), [0, 450, 550, 5000, 5000]);
  assert.equal(transferFee(2000), 0, 'within 2 km is free');
  assert.equal(transferFee(NaN), 0);
  assert.equal(storageFeePerDay('nonsense'), 32, 'unknown class reads as a coaster');
});

test('wage rates (cr/h = mcr/h ÷ 1000) under way, on duty and off', () => {
  const uw = (c, tow) => wageRateMcrH(c, 'underway', tow) / 1000;
  assert.deepEqual([uw('coaster'), uw('trawler'), uw('pilot'), uw('sloop'), uw('boxship'), uw('coaster', true)], [60, 55, 27, 12, 420, 68]);
  assert.equal(wageRateMcrH('coaster', 'duty') / 1000, 20);
  assert.equal(wageRateMcrH('sloop', 'duty') / 1000, 12);
  assert.equal(wageRateMcrH('coaster', 'off'), 0);
});

test('accrueWage is exact integer arithmetic with the remainder carried', () => {
  let pay = { rem: 0 }, cr = 0;
  for (let i = 0; i < 36000; i++) cr += accrueWage(pay, 60000, 100);
  assert.equal(cr, 60); assert.equal(pay.rem, 0);
  pay = { rem: 0 }; cr = 0;
  for (let i = 0; i < 3600; i++) cr += accrueWage(pay, 60000, 1000);
  assert.equal(cr, 60); assert.equal(pay.rem, 0);
  pay = { rem: 0 }; cr = 0;
  for (let i = 0; i < 599; i++) cr += accrueWage(pay, 60000, 100);
  assert.equal(cr, 0);
  assert.equal(accrueWage(pay, 60000, 100), 1, 'the 600th step pays the first credit');
  pay = { rem: 0 };
  for (let i = 0; i < 7; i++) accrueWage(pay, 60000, 100);
  assert.equal(pay.rem, 42000000);
  assert.ok(Number.isSafeInteger(pay.rem) && pay.rem < FLEET.DEN_WAGE);
  assert.equal(accrueWage({ rem: 0 }, 0, 1000), 0); assert.equal(accrueWage({ rem: 0 }, 60000, -5), 0);
});

test('names: defaults in order, validation trims and refuses', () => {
  assert.equal(defaultShipName([]), 'Sea Bee');
  assert.equal(defaultShipName(['Sea Bee']), 'Kittiwake');
  assert.equal(defaultShipName(['sea bee', 'KITTIWAKE']), 'North Star', 'case-insensitive');
  assert.equal(defaultShipName(FLEET.NAMES), 'Sea Bee 2');
  assert.equal(validShipName('  Grey   Gull '), 'Grey Gull');
  for (const bad of ['X', 'A'.repeat(25), '<b>', '', null, 'Ship;DROP']) assert.equal(validShipName(bad), null, String(bad));
  assert.equal(validShipName("St. Mary's-2"), "St. Mary's-2");
  assert.equal(validShipName('Ærø Fjord'), 'Ærø Fjord', 'letters beyond ASCII');
});

test('homes, states, day keys and ids', () => {
  assert.equal(homeAllowed(harborById('rotterdam')), true);
  assert.equal(homeAllowed(harborById('ostend')), false, 'minor');
  assert.equal(homeAllowed(null), false);
  assert.equal(stateOf({ status: 'laidup', docked: 'rotterdam' }), 'laid_up');
  assert.equal(stateOf({ status: 'active', docked: 'rotterdam' }), 'docked');
  assert.equal(stateOf({ status: 'active', docked: null, cap: { phase: 'anchored' } }), 'anchored');
  assert.equal(stateOf({ status: 'active', docked: null, cap: { phase: 'holding' } }), 'anchored');
  assert.equal(stateOf({ status: 'active', docked: null, cap: { phase: 'sailing' } }), 'at_sea');
  assert.equal(stateOf({ status: 'active', docked: null, cap: null }), 'at_sea');
  const t = Date.UTC(2026, 9, 8, 23, 59, 59) / 1000;
  assert.equal(dayKey(t), '2026-10-08'); assert.equal(dayKey(t + 1), '2026-10-09');
  assert.deepEqual(lastDays(t, 3), ['2026-10-06', '2026-10-07', '2026-10-08']);
  assert.ok(VESSEL_ID_RE.test('v3fa9c2d1') && VESSEL_ID_RE.test('vp1') && !VESSEL_ID_RE.test('3fa9') && !VESSEL_ID_RE.test('v' + 'a'.repeat(17)));
  assert.ok(JOB_ID_RE.test('jfr0') && !JOB_ID_RE.test('<script>'));
  assert.equal(LEDGER_CATS.length, 11);
});

test('totals: income and costs per vessel and in total, ships kept apart', () => {
  const days = {
    '2026-10-07': { va: { income: 9000, costs: -538, fuel: -1200 }, vb: { ships: -180000, wages: -60 } },
    '2026-10-08': { va: { income: 1000 }, vb: { ships: 99000, storage: -32 }, _: { arrears: -20 } },
  };
  const all = totals(days, ['2026-10-07', '2026-10-08']);
  assert.equal(all.income, 10000); assert.equal(all.costs, 538 + 1200 + 60 + 32 + 20); assert.equal(all.net, 10000 - 1850);
  assert.equal(all.ships, -81000);
  assert.equal(all.byCat.fuel, -1200); assert.equal(all.byCat.ships, -81000);
  const a = totals(days, ['2026-10-08'], 'va');
  assert.deepEqual([a.income, a.costs, a.net, a.ships], [1000, 0, 1000, 0]);
  const none = totals(undefined, ['2026-10-08']);
  assert.deepEqual([none.income, none.costs, none.net], [0, 0, 0]);
});

test('normalizeOrder: shapes and the refusal texts', () => {
  assert.deepEqual(normalizeOrder({ type: 'nope' }, isH), { ok: false, why: 'Unknown order.' });
  assert.deepEqual(normalizeOrder(null, isH), { ok: false, why: 'Unknown order.' });
  assert.deepEqual(normalizeOrder('x', isH), { ok: false, why: 'Unknown order.' });
  assert.deepEqual(normalizeOrder({ type: 'sail_to', harbor: 'atlantis' }, isH), { ok: false, why: 'Pick a harbour to sail to.' });
  assert.deepEqual(normalizeOrder({ type: 'sail_to', harbor: 'hamburg', then: 'party' }, isH), { ok: true, order: { type: 'sail_to', harbor: 'hamburg', then: 'moor' } });
  assert.deepEqual(normalizeOrder({ type: 'home', then: 'lay_up' }, isH), { ok: true, order: { type: 'home', then: 'lay_up' } });
  assert.deepEqual(normalizeOrder({ type: 'hold' }, isH), { ok: true, order: { type: 'hold' } });
  assert.deepEqual(normalizeOrder({ type: 'hold', lat: NaN, lon: 3 }, isH), { ok: false, why: 'That position is not on the chart.' });
  assert.deepEqual(normalizeOrder({ type: 'hold', lat: 54.123456789, lon: 3 }, isH), { ok: true, order: { type: 'hold', lat: 54.12346, lon: 3 } });
  assert.deepEqual(normalizeOrder({ type: 'route', route: [] }, isH), { ok: false, why: 'A route needs 1–250 waypoints.' });
  assert.deepEqual(normalizeOrder({ type: 'route', route: Array.from({ length: 251 }, () => [54, 3]) }, isH), { ok: false, why: 'A route needs 1–250 waypoints.' });
  assert.deepEqual(normalizeOrder({ type: 'route', route: [{ lat: 54, lon: 3 }, [54.5, 3.5]], harbor: 'ijmuiden' }, isH), { ok: true, order: { type: 'route', route: [[54, 3], [54.5, 3.5]], harbor: 'ijmuiden', then: 'moor' } });
  assert.deepEqual(normalizeOrder({ type: 'route', route: [[54, 3]] }, isH).order.then, 'hold');
  assert.deepEqual(normalizeOrder({ type: 'route', route: [[54, 'x']] }, isH), { ok: false, why: 'A waypoint is not on the chart.' });
  assert.deepEqual(normalizeOrder({ type: 'contract', jobId: '<script>' }, isH), { ok: false, why: 'Unknown contract.' });
  assert.deepEqual(normalizeOrder({ type: 'contract' }, isH), { ok: true, order: { type: 'contract', jobId: null, then: 'stay' } });
  assert.deepEqual(normalizeOrder({ type: 'stop', junk: 1 }, isH), { ok: true, order: { type: 'stop' } });
});
