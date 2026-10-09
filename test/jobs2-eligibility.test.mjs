// Lane D §9 test 14 (jobs-eligibility): exact "why not" strings and the order of the checks (§5.8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useStub, ctxBase, T0, T_WINTER } from './jobs2-helpers.mjs';
import { canDo, reasonText, CHECK_ORDER, portsOf } from '../shared/jobs/eligibility.js';
import { JOB_GEN, step, validJob } from '../shared/jobs/types.js';
import { toTonnes } from '../shared/cargo.js';

useStub();
const ctx = ctxBase();
let seq = 0;
/** A minimal runner job: cargo from → to. */
function cargoJob(type, from, to, good, unit, qty, extra = {}) {
  return { id: `jt${seq++}`, gen: JOB_GEN, type, family: type, title: `${type} test`, from, to, legs: null,
    cargo: { good, unit, qty, t: toTonnes(good, qty), ...(extra.cargo || {}) }, pax: 0, needs: { unit, qty, ...(extra.needs || {}) },
    steps: [step('load', from), step('sail', to, { km: 500 }), step('discharge', to)], window: { readyAt: T0, laycanTo: null, dueAt: T0 + 3600 * 999 },
    pay: { cr: 1000, model: 'lump' }, hours: extra.hours ?? 999, ref: null, postedAt: T0, expiresAt: T0 + 86400 };
}
const ship = (cls, extra = {}) => ({ ship: { cls }, cargo: [], jobs: [], ...extra });

test('the test job shape is valid', () => assert.deepEqual(validJob(cargoJob('voyage', 'ras_tanura', 'rotterdam', 'crude', 't', 100000)), []));

test('handling: crude on an MR', () => {
  const r = canDo(cargoJob('voyage', 'ras_tanura', 'rotterdam', 'crude', 't', 100000), ship('mr50'), ctx);
  assert.equal(r.ok, false); assert.equal(r.why.code, 'handling');
  assert.equal(r.why.text, 'Needs crude tanks — e.g. Aframax, Suezmax, VLCC');
  assert.ok(r.why.text.length <= 60);
  assert.equal(canDo(cargoJob('voyage', 'ras_tanura', 'rotterdam', 'crude', 't', 100000), ship('aframax115'), ctx).ok, true);
});

test('plugs, capacity and the passenger certificate', () => {
  const reefer = cargoJob('box', 'rotterdam', 'hamburg', 'containers', 'teu', 600, { cargo: { reefer: 300 } });
  assert.equal(canDo(reefer, ship('mpp160'), ctx).why.text, 'Needs 300 reefer plugs (you have 0)');
  assert.equal(canDo(reefer, ship('feeder1700'), ctx).ok, true);
  const big = cargoJob('box', 'rotterdam', 'hamburg', 'containers', 'teu', 2400);
  const r = canDo(big, ship('feeder1700'), ctx);
  assert.equal(r.why.code, 'cap'); assert.equal(r.why.text, 'Needs 2,400 TEU (1,700 free)');
  // freight in tonnes on a ship with cargo aboard (legacy record)
  const fr = { id: 'jx', type: 'freight', from: 'rotterdam', to: 'hamburg', good: 'grain', qty: 40000, pay: 5000, hours: 999 };
  assert.equal(canDo(fr, ship('bulker'), ctx).why.text, 'Needs 40,000 t (35,000 free)');
  assert.equal(canDo(fr, ship('boxship'), ctx).why.text, 'Needs bulk holds — e.g. Handysize, Ultramax, Capesize');
  const pax = { id: 'jp', type: 'passengers', from: 'rotterdam', to: 'hamburg', pax: 40, pay: 5000, hours: 999 };
  const p = canDo(pax, ship('sov90'), ctx);
  assert.equal(p.why.code, 'paxcert'); assert.equal(p.why.text, 'More than 12 guests needs a passenger ship');
  assert.equal(canDo(pax, ship('ferry'), ctx).ok, true);
});

test('length and draught at the ports', () => {
  const lw = canDo(cargoJob('box', 'rotterdam', 'lowestoft', 'containers', 'teu', 500), ship('feeder1700'), ctx);
  assert.equal(lw.why.code, 'loa'); assert.equal(lw.why.text, 'Lowestoft takes up to 140 m; you are 172 m');
  assert.ok(lw.all.some((x) => x.code === 'facility'), 'the geared-ship rule is reported too');
  const hull = canDo(cargoJob('voyage', 'rotterdam', 'hull', 'grain', 't', 40000), ship('ultramax64'), ctx);
  assert.equal(hull.why.code, 'draft'); assert.equal(hull.why.text, 'Hull: 12.0 m at the berth, you draw 13.3 m');
  const water = canDo(cargoJob('voyage', 'rotterdam', 'hamburg', 'grain', 't', 40000), ship('ultramax64'), { ...ctx, berthWater: (id) => (id === 'hamburg' ? 11.5 : 20) });
  assert.equal(water.why.text, 'Hamburg: 11.5 m at the berth, you draw 13.3 m');
});

test('shore facilities', () => {
  const ph = canDo(cargoJob('box', 'rotterdam', 'peterhead', 'containers', 'teu', 200), ship('feeder1000'), ctx);
  assert.equal(ph.why.code, 'facility'); assert.equal(ph.why.text, 'No shore cranes at Peterhead — needs a geared ship');
  assert.equal(canDo(cargoJob('box', 'rotterdam', 'peterhead', 'containers', 'teu', 50), ship('coaster'), ctx).ok, true, 'the geared coaster');
  assert.equal(canDo(cargoJob('voyage', 'rotterdam', 'aberdeen', 'crude', 't', 50000), ship('aframax115'), ctx).why.text, 'Aberdeen has no crude oil terminal');
  assert.equal(canDo(cargoJob('voyage', 'ras_laffan', 'hull', 'lng', 'm3', 150000), ship('lng174k'), ctx).why.text, 'Hull has no LNG terminal');
  assert.equal(canDo(cargoJob('voyage', 'port_hedland', 'hamburg', 'ore', 't', 150000), ship('capesize180'), ctx).ok, true);
  assert.equal(canDo(cargoJob('voyage', 'port_hedland', 'ras_tanura', 'ore', 't', 150000), ship('capesize180'), ctx).why.text, 'Ras Tanura has no Capesize bulk terminal');
  assert.equal(canDo(cargoJob('voyage', 'itaguai', 'hamburg', 'ore', 't', 300000), ship('vloc400'), ctx).why.text, 'Hamburg has no VLOC berth');
  assert.equal(canDo(cargoJob('voyage', 'itaguai', 'qingdao', 'ore', 't', 300000), ship('vloc400'), ctx).ok, true);
});

test('ice class in season', () => {
  const j = cargoJob('voyage', 'rotterdam', 'lulea', 'grain', 't', 30000);
  const w = canDo(j, ship('handy38'), ctxBase(T_WINTER));
  assert.equal(w.why.code, 'ice'); assert.equal(w.why.text, 'Ice class 1A needed at Luleå in season');
  assert.equal(canDo(j, ship('handy38~i1a'), ctxBase(T_WINTER)).ok, true);
  assert.equal(canDo(j, ship('handy38~i1c'), ctxBase(T_WINTER)).why.code, 'ice');
  assert.equal(canDo(j, ship('handy38'), ctxBase(T0)).ok, true, 'no ice in July');
  const hel = canDo(cargoJob('voyage', 'rotterdam', 'helsinki', 'grain', 't', 30000), ship('handy38'), ctxBase(T_WINTER));
  assert.equal(hel.why.text, 'Ice class 1C needed at Helsinki in season');
});

test('weather: lesson wind limit', () => {
  const lesson = { id: 'jl', gen: JOB_GEN, type: 'lesson', family: 'lesson', title: 'Sailing lesson, Level 2', from: 'palma', to: 'palma', legs: null, cargo: null, pax: 2, level: 2,
    needs: { sail: true, level: 2, maxWindKn: 18, unit: 'pax', qty: 3 }, steps: [step('board', 'palma'), step('drill', null, { stat: 'tacks', count: 3, optional: true }), step('land', 'palma', { afterSea: true })],
    window: { readyAt: T0, dueAt: T0 + 9e6 }, pay: { cr: 1400, model: 'lump' }, hours: 99, postedAt: T0, expiresAt: T0 + 86400 };
  const r = canDo(lesson, ship('sloop'), { ...ctx, weatherAt: () => ({ windKn: 22 }) });
  assert.equal(r.why.code, 'weather'); assert.equal(r.why.text, 'Wind 22 kn — limit 18 kn for Level 2 students');
  assert.equal(canDo(lesson, ship('sloop'), { ...ctx, weatherAt: () => ({ windKn: 15 }) }).ok, true);
  assert.equal(canDo(lesson, ship('tug'), ctx).why.text, 'Needs a sailing or motor yacht');
  assert.equal(canDo(lesson, ship('cruiser'), ctx).why.text, 'Needs a sailing yacht', 'this lesson is under sail');
  assert.equal(canDo({ ...lesson, pax: 4, needs: { ...lesson.needs, qty: 5 } }, ship('sloop'), ctx).why.text, 'Needs 5 berths (4 free)');
});

test('order of checks: first failure wins, all failures listed in contract order', () => {
  // too big for her AND too long for Lowestoft AND no cranes there: capacity comes first
  const r = canDo(cargoJob('box', 'rotterdam', 'lowestoft', 'containers', 'teu', 2400), ship('feeder1700'), ctx);
  assert.deepEqual(r.all.map((x) => x.code), ['cap', 'loa', 'facility']);
  assert.equal(r.why.code, 'cap');
  const idx = (c) => CHECK_ORDER.indexOf(c);
  for (let k = 1; k < r.all.length; k++) assert.ok(idx(r.all[k - 1].code) <= idx(r.all[k].code));
});

test('hooks: licence, crew, politics, Jones Act, time', () => {
  const j = cargoJob('voyage', 'rotterdam', 'hamburg', 'grain', 't', 30000, { needs: { licence: 'Master unlimited' } });
  assert.equal(canDo(j, ship('handy38'), { ...ctx, licenceOk: () => false }).why.text, 'Needs a Master unlimited licence');
  assert.equal(canDo(j, ship('handy38'), { ...ctx, crewOk: () => ({ ok: false, n: 18, m: 12 }) }).why.text, 'Needs 18 crew (12 aboard)');
  const pol = canDo(j, ship('handy38'), { ...ctx, politics: { ds: {}, ctx: {}, jobCheck: () => ({ ok: false, block: { code: 'sanction', text: 'Blocked: EU measure (test)' } }) } });
  assert.equal(pol.why.code, 'politics'); assert.equal(pol.why.text, 'Blocked: EU measure (test)');
  const dredge = { ...cargoJob('dredge', 'new_orleans', 'new_orleans', 'spoil', 'm3', 5000), cargo: null, needs: { handling: ['hopper'], jones: true } };
  assert.equal(canDo(dredge, ship('tshd100'), ctx).ok, true, 'Jones Act rule off until politics R4');
  assert.equal(canDo(dredge, ship('tshd100'), { ...ctx, jonesActive: true }).why.text, 'Jones Act: needs a US-built, US-flag ship');
  assert.equal(canDo(dredge, ship('tshd100', { builtIn: 'US' }), { ...ctx, jonesActive: true }).ok, true);
  const slow = cargoJob('voyage', 'rotterdam', 'hamburg', 'grain', 't', 30000, { hours: 4 });
  slow.steps[1].km = 5000;
  const t = canDo(slow, ship('handy38'), ctx);
  assert.equal(t.why.code, 'time'); assert.match(t.why.text, /^too slow for your ship: needs ~\d+ h, the contract allows 4 h$/);
});

test('reasonText templates and ports', () => {
  assert.equal(reasonText({ code: 'cap', qty: 2400, unit: 'teu', free: 1700 }), 'Needs 2,400 TEU (1,700 free)');
  assert.equal(reasonText({ code: 'loa', port: 'Lowestoft', n: 140, L: 172 }), 'Lowestoft takes up to 140 m; you are 172 m');
  assert.equal(reasonText({ code: 'draft', port: 'Hull', water: 12, T: 14.5 }), 'Hull: 12.0 m at the berth, you draw 14.5 m');
  assert.equal(reasonText({ code: 'ice', cls: 'i1as', port: 'Luleå' }), 'Ice class 1A Super needed at Luleå in season');
  assert.equal(reasonText({ code: 'facility', facility: 'roro', port: 'Hull' }), 'Hull has no ro-ro ramp');
  assert.deepEqual(portsOf(cargoJob('box', 'rotterdam', 'hamburg', 'containers', 'teu', 10)), ['rotterdam', 'hamburg']);
  assert.deepEqual(portsOf({ type: 'fishing', from: 'peterhead', to: 'peterhead' }), ['peterhead']);
});

test('jobtime hooks (H6c): gen-8 hard reasons and runner hours; legacy falls through', async () => {
  const { jobtimeHooks } = await import('../shared/jobs/eligibility.js');
  const hk = jobtimeHooks(() => ctx);
  const crude = cargoJob('voyage', 'ras_tanura', 'rotterdam', 'crude', 't', 100000, { hours: 1 });
  assert.equal(hk.hardReason(crude, { cls: 'mr50', holdFreeT: 45000 }), 'Needs crude tanks — e.g. Aframax, Suezmax, VLCC');
  assert.equal(hk.hardReason(crude, { cls: 'aframax115', holdFreeT: 103500 }), null, 'the time check is left to estimateJob');
  assert.equal(hk.hardReason({ type: 'freight', gen: 7, qty: 10 }, { cls: 'coaster' }), undefined);
  const n = hk.needFor(crude, 'aframax115');
  assert.equal(n.type, 'voyage'); assert.ok(n.needH > 0 && n.sailH > 0 && n.workH === 0);
  assert.equal(hk.needFor({ type: 'freight', qty: 10 }, 'coaster'), null);
});
