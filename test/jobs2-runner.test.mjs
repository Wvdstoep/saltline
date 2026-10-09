// Lane D §9 test 15 (jobs-runner): the single step engine driven by onTick / onDock / onAction, with exact payouts.
// The game hooks (H6) land in phase 2; here a fake env stands in for server/game.js and server/fleet.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useStub, actor, T0, seeded } from './jobs2-helpers.mjs';
import { harborById } from '../server/harbors.js';
import { destination } from '../shared/geo.js';
import { JobsX, RUNNER, tcfOf } from '../server/jobsx.js';
import { JOB_GEN, step } from '../shared/jobs/types.js';
import { toTonnes } from '../shared/cargo.js';
import { payCrewchange, payStandby, regattaPrize, payRopaxCrossing } from '../shared/jobs/catalogue.js';
import { generateFamilyJob } from '../server/jobsgen.js';

useStub();
function rig() {
  const clock = { t: T0 }, paid = [], events = [], reps = [];
  const env = { now: () => clock.t, harborById, pay: (a, cr, j) => { paid.push({ a: a.id, cr, job: j.id }); a.money = (a.money || 0) + cr; },
    event: (a, kind, text) => events.push({ kind, text }), rep: (a, d) => reps.push(d), charge: (a, cr) => { if ((a.money || 0) < cr) return false; a.money -= cr; return true; } };
  return { jx: new JobsX(env), env, clock, paid, events, reps };
}
let n = 0;
const J = (type, from, to, steps, extra = {}) => ({ id: `jr${n++}`, gen: JOB_GEN, type, family: type, title: `${type} test`, from, to, legs: null, cargo: null, pax: 0, needs: {},
  steps, window: { readyAt: T0, laycanTo: null, dueAt: T0 + 9e6 }, pay: { cr: 1000, model: 'lump' }, hours: 500, ref: null, postedAt: T0, expiresAt: T0 + 86400, ...extra });
/** Tick `a` for `h` hours in 60 s steps, advancing the clock and the ship clock. */
function run(r, a, h, dt = 60) { for (let s = 0; s < h * 3600; s += dt) { r.clock.t += dt; a.shipTime += dt; r.jx.onTick(a, dt); } }
const putAt = (a, p, spd = 0) => { a.docked = null; a.ship.lat = p.lat; a.ship.lon = p.lon; a.ship.spd = spd; };
const dock = (r, a, id) => { const h = harborById(id); a.ship.lat = h.lat; a.ship.lon = h.lon; a.ship.spd = 0; a.docked = id; r.jx.onDock(a, id); };

test('voyage: accept → load at the load port → sail → discharge → paid once', () => {
  const r = rig(), a = actor('handy38', 'hamburg');
  const job = J('voyage', 'rotterdam', 'hamburg', [step('load', 'rotterdam'), step('sail', 'hamburg', { km: 500 }), step('discharge', 'hamburg')],
    { cargo: { good: 'grain', unit: 't', qty: 30000, t: 30000 }, needs: { unit: 't', qty: 30000 }, pay: { cr: 1234567, model: 'lump' } });
  const res = r.jx.accept(a, job);
  assert.equal(res.ok, true);
  assert.equal(a.cargo.length, 0, 'not at the load port yet');
  dock(r, a, 'hamburg'); assert.equal(r.paid.length, 0, 'docking at the discharge port first does nothing');
  dock(r, a, 'rotterdam');
  assert.equal(a.cargo.length, 1); assert.equal(a.cargo[0].qty, 30000); assert.equal(a.cargo[0].jobId, res.job.id);
  a.docked = null; run(r, a, 2);
  dock(r, a, 'hamburg');
  assert.deepEqual(r.paid.map((p) => p.cr), [1234567]);
  assert.equal(a.cargo.length, 0); assert.equal(a.jobs.length, 0);
  dock(r, a, 'hamburg'); assert.equal(r.paid.length, 1, 'paid once');
});

test('late delivery pays half; short delivery pays pro rata', () => {
  const r = rig(), a = actor('handy38', 'rotterdam');
  const job = J('box', 'rotterdam', 'hamburg', [step('load', 'rotterdam'), step('sail', 'hamburg', { km: 500 }), step('discharge', 'hamburg')],
    { cargo: { good: 'containers', unit: 'teu', qty: 100, t: 1200 }, pay: { cr: 10000, model: 'lump' }, hours: 10 });
  const b = actor('feeder1700', 'rotterdam');
  r.jx.accept(b, job);
  b.cargo[0].units = 50; b.cargo[0].qty = 600;           // half the boxes lost
  b.shipTime += 11 * 3600;                                 // past the 10 h budget
  dock(r, b, 'hamburg');
  assert.equal(r.paid[0].cr, 2500);
  assert.equal(r.jx.accept(a, { ...job, id: 'jbox2' }).ok, false, 'a bulk carrier refuses containers');
});

test('standby: 12 h inside 5 km pays 10,800; hours outside the radius do not count', () => {
  const r = rig(), a = actor('psv90', 'aberdeen');
  const plat = { lat: 57.6, lon: 1.0 };
  const job = J('standby', 'aberdeen', null, [step('sail', { ...plat, rM: 5000 }, { km: 150 }), step('work', { ...plat, rM: 5000 }, { h: 12 })], { pay: { cr: payStandby(12), model: 'lump' } });
  assert.equal(r.jx.accept(a, job).ok, true);
  putAt(a, destination(plat.lat, plat.lon, 90, 3000), 1);
  run(r, a, 6);
  assert.equal(a.jobs[0].prog.i, 1); assert.ok(Math.abs(a.jobs[0].prog.h - 6) < 0.02);
  putAt(a, destination(plat.lat, plat.lon, 90, 9000), 1);
  run(r, a, 3);
  assert.ok(Math.abs(a.jobs[0].prog.h - 6) < 0.02, 'outside the radius: no hours');
  putAt(a, destination(plat.lat, plat.lon, 0, 4000), 0.5);
  run(r, a, 6.1);
  assert.deepEqual(r.paid.map((p) => p.cr), [10800]);
});

test('crew change (CTV): drill transfers count only on the spot under 2 kn', () => {
  const r = rig(), a = actor('ctv26', 'esbjerg');
  const site = { lat: 55.48, lon: 7.84, rM: 6000 }, km = 30;
  const job = J('crewchange', 'esbjerg', 'esbjerg', [step('board', 'esbjerg'), step('sail', site, { km }), step('drill', site, { count: 3, maxKn: 2, action: 'transfer' }),
    step('sail', 'esbjerg', { km }), step('land', 'esbjerg')], { pax: 10, needs: { unit: 'pax', qty: 10 }, pay: { cr: payCrewchange({ techs: 10, km }), model: 'lump' } });
  assert.equal(r.jx.accept(a, job).ok, true);
  const id = a.jobs[0].id;
  assert.equal(r.jx.onAction(a, 'job_step', id), false, 'not at the site yet');
  putAt(a, site, 1); run(r, a, 0.1);
  a.ship.spd = 5; assert.equal(r.jx.onAction(a, 'job_step', id), false, 'too fast');
  a.ship.spd = 1;
  assert.equal(r.jx.onAction(a, 'job_step', id), true);
  r.jx.onAction(a, 'job_step', id); r.jx.onAction(a, 'job_step', id);
  assert.equal(a.jobs[0].prog.i, 3);
  dock(r, a, 'esbjerg');
  assert.deepEqual(r.paid.map((p) => p.cr), [10 * (60 + 0.8 * 30)]);
});

function lesson(students = 3) {
  return J('lesson', 'palma', 'palma', [step('board', 'palma'), step('drill', null, { stat: 'tacks', count: 3, optional: true, task: 'tack' }),
    step('drill', null, { stat: 'gybes', count: 2, optional: true, task: 'gybe' }), step('land', 'palma', { afterSea: true })],
  { pax: students, level: 2, needs: { sail: true, level: 2, maxWindKn: 18, unit: 'pax', qty: students + 1 }, pay: { cr: 2100, model: 'lump' } });
}
test('lesson: tasks counted from v.sail.stats; all tasks +20 % (L2 × 3 = 2,520)', () => {
  const r = rig(), a = actor('sloop', 'palma', { sail: { stats: { tacks: 5, gybes: 1, reefs: 0, maxHeel10s: 12 } } });
  assert.equal(r.jx.accept(a, lesson()).ok, true);
  putAt(a, destination(39.5, 2.6, 180, 2000), 5); run(r, a, 0.2);
  a.sail.stats.tacks = 7; run(r, a, 0.1); assert.equal(a.jobs[0].prog.i, 1, 'two tacks are not three');
  a.sail.stats.tacks = 8; a.sail.stats.gybes = 3; run(r, a, 0.1);
  assert.equal(a.jobs[0].prog.i, 3);
  dock(r, a, 'palma');
  assert.deepEqual(r.paid.map((p) => p.cr), [2520]);
});
test('lesson: back early skips the open tasks (no bonus); a safety failure refunds and costs reputation', () => {
  const r = rig(), a = actor('sloop', 'palma', { sail: { stats: { tacks: 0, gybes: 0 } } });
  r.jx.accept(a, lesson());
  dock(r, a, 'palma'); assert.equal(r.paid.length, 0, 'cannot land before going to sea');
  putAt(a, destination(39.5, 2.6, 180, 2000), 5); run(r, a, 0.2);
  a.sail.stats.tacks = 3; run(r, a, 0.1);
  dock(r, a, 'palma');
  assert.deepEqual(r.paid.map((p) => p.cr), [2100]);
  const b = actor('sloop', 'palma', { id: 'p2', sail: { stats: { tacks: 0, gybes: 0, maxHeel10s: 0 } } });
  r.jx.accept(b, lesson(2));
  putAt(b, destination(39.5, 2.6, 180, 2000), 5); run(r, b, 0.2);
  b.sail.stats.maxHeel10s = 34; run(r, b, 0.1);
  dock(r, b, 'palma');
  assert.equal(r.paid[1].cr, 0); assert.deepEqual(r.reps, [-5]);
});

test('captain runs a voyage offline (fleet vessel; nextTarget drives the captain)', () => {
  const r = rig(), v = { id: 'v1', ship: { cls: 'ultramax64', lat: 0, lon: 0, spd: 0 }, docked: 'santos', cargo: [], jobs: [], shipTime: T0 };
  const job = generateFamilyJob(harborById('santos'), T0, seeded(4), 'voyage', {}, { good: 'grain' });
  assert.ok(job && job.cargo.qty <= 73800);
  const fit = generateFamilyJob(harborById('santos'), T0, seeded(4), 'voyage', {}, { good: 'grain', fit: { cls: 'ultramax64', vessel: v }, fitGoods: ['grain'] });
  assert.equal(r.jx.accept(v, fit).ok, true);
  assert.equal(v.cargo.length, 1, 'loaded at Santos on accept');
  const tgt = r.jx.nextTarget(v, v.jobs[0]);
  assert.deepEqual([tgt.kind, tgt.harbor], ['harbor', fit.to]);
  v.docked = null; run(r, v, 1);
  dock(r, v, fit.to);
  assert.deepEqual(r.paid.map((p) => [p.a, p.cr]), [['v1', fit.pay.cr]]);
});

test('towing: overspeed parts the line (back to the meet); survey lines restart outside 4–6 kn', () => {
  const r = rig(), a = actor('oceantug60', 'rotterdam');
  const pick = { lat: 52.05, lon: 3.9 }, end = harborById('hamburg');
  const job = J('ocean_tow', 'rotterdam', 'hamburg', [step('meet', { ...pick, rM: 300 }, { maxKn: 3, km: 10 }), step('tow', { lat: end.lat, lon: end.lon, rM: 4000 }, { maxKn: 7, km: 500 })]);
  r.jx.accept(a, job);
  putAt(a, pick, 2); run(r, a, 0.02);
  assert.equal(a.jobs[0].prog.i, 1);
  putAt(a, { lat: 52.5, lon: 5 }, 9); run(r, a, 0.02, 10);
  assert.equal(a.jobs[0].prog.i, 0, 'line parted');
  assert.ok(r.events.some((e) => /tow line parted/.test(e.text)));
  const s = actor('research75', 'esbjerg');
  const p0 = { lat: 55.6, lon: 7.0 }, p1 = destination(55.6, 7.0, 90, 10000);
  r.jx.accept(s, J('survey', 'esbjerg', 'esbjerg', [step('meet', { ...p0, rM: 200 }, { maxKn: 6 }), step('sail', { lat: p1.lat, lon: p1.lon, rM: 200 }, { minKn: 4, maxKn: 6, resetTo: 0, km: 10 }), step('sail', 'esbjerg')]));
  putAt(s, p0, 5); run(r, s, 0.01, 10);
  assert.equal(s.jobs[0].prog.i, 1);
  putAt(s, destination(55.6, 7.0, 90, 3000), 8); run(r, s, (RUNNER.BAND_GRACE_S + 20) / 3600, 10);
  assert.equal(s.jobs[0].prog.i, 0, 'line restarts');
});

test('ferry timetable: on-time departures earn +15 %, a late one loses it', () => {
  const mk = () => {
    const dep1 = T0 + 3600, dep2 = T0 + 6 * 3600, per = payRopaxCrossing({ pax: 100, lm: 0, km: 40 });
    return J('ropax_route', 'dover', 'calais', [step('board', 'dover', { until: dep1, depart: dep1 }), step('sail', 'calais', { km: 40 }), step('land', 'calais'),
      step('board', 'calais', { until: dep2, depart: dep2 }), step('sail', 'dover', { km: 40 }), step('land', 'dover')],
    { pax: 100, pay: { cr: per * 2, bonus: { kind: 'ontime', cr: Math.round(per * 2 * 0.15) }, model: 'lump' } });
  };
  for (const [delayS, expect] of [[600, 1.15], [1800, 1]]) {
    const r = rig(), a = actor('ferry', 'dover'), j = mk();
    r.jx.accept(a, j);
    r.clock.t = T0 + 3600 + delayS; a.docked = null; run(r, a, 0.5);
    dock(r, a, 'calais');
    r.clock.t = T0 + 6 * 3600 + 300; a.docked = null; run(r, a, 0.5);
    dock(r, a, 'dover');
    assert.equal(r.paid[0].cr, Math.round(j.pay.cr * (expect > 1 ? 1 : 1)) + (expect > 1 ? j.pay.bonus.cr : 0), `departure +${delayS}s`);
  }
});

test('salvage: first to connect wins; regatta places by corrected time', () => {
  const r = rig(), claims = new Set();
  r.env.claim = (id, a) => { if (claims.has(id)) return false; claims.add(id); return true; };
  const cas = { lat: 57.3, lon: -1.2 };
  const mk = () => J('salvage', 'aberdeen', 'aberdeen', [step('meet', { ...cas, rM: 300 }, { maxKn: 2, claim: 'c1' }), step('tow', 'aberdeen', { maxKn: 6 })],
    { pay: { cr: 200000, pct: 0.1, value: 2000000, model: 'award' } });
  const a = actor('oceantug60', 'aberdeen', { id: 'a' }), b = actor('ahts85', 'aberdeen', { id: 'b' });
  r.jx.accept(a, mk()); r.jx.accept(b, mk());
  putAt(a, cas, 1); run(r, a, 0.01);
  putAt(b, cas, 1); run(r, b, 0.01);
  assert.equal(b.jobs.length, 0); assert.ok(r.events.some((e) => /another salvor/.test(e.text)));
  a.ship.lat = harborById('aberdeen').lat; a.ship.lon = harborById('aberdeen').lon; run(r, a, 0.01);
  assert.deepEqual(r.paid.map((p) => p.cr), [200000]);
  // regatta: elapsed 1.5 h, sloop TCF = 7.2 / 8 = 0.9 → corrected 1.35 h; field 1.2 h, 1.4 h, 1.6 h → 2nd of 4
  const g = rig(), s = actor('sloop', 'palma', { money: 1000 });
  const start = { lat: 39.5, lon: 2.6 }, mark = destination(39.5, 2.6, 0, 3700);
  const reg = J('regatta', 'palma', 'palma', [step('meet', { ...start, rM: 500 }), step('race', null, { startAt: T0 + 600, marks: [{ lat: mark.lat, lon: mark.lon, rM: 100 }, { ...start, rM: 150 }] })],
    { entries: 4, field: [1.2 * 3600, 1.4 * 3600, 1.6 * 3600], pay: { cr: 3500, entry: 500, purse: 7000, model: 'award' } });
  assert.equal(tcfOf('sloop'), 0.9);
  assert.equal(g.jx.accept(s, reg).ok, true); assert.equal(s.money, 500, 'entry fee charged');
  putAt(s, start, 4); run(g, s, 0.01);
  g.clock.t = T0 + 600 + 1800; putAt(s, mark, 6); run(g, s, 0.001, 1);
  g.clock.t = T0 + 600 + 5400; putAt(s, start, 6); g.jx.onTick(s, 1);
  assert.deepEqual(g.paid.map((p) => p.cr), [regattaPrize(4, 2)]);
  assert.equal(regattaPrize(4, 2), 2100);
});

test('bareboat and day charter settle with their rules; time charter pays hire for her own price', () => {
  const r = rig(), a = actor('ultramax64', 'rotterdam');
  const tc = J('tc', 'rotterdam', 'hamburg', [step('sail', 'rotterdam'), step('work', null, { h: 24, hire: true }), step('sail', 'hamburg', { km: 500 })],
    { pay: { cr: 0, perH: 0, rate: 0.0025, hireH: 24, model: 'hire' } });
  r.jx.accept(a, tc);
  assert.equal(a.jobs[0].pay.perH, 17375);
  a.docked = null; run(r, a, 24.05);
  dock(r, a, 'hamburg');
  assert.deepEqual(r.paid.map((p) => p.cr), [17375 * 24]);
  const d = rig(), y = actor('myacht', 'palma');
  r.env.heelDeg = () => 0;
  d.env.seaHs = () => 0.5;
  d.jx.accept(y, J('daycharter', 'palma', 'palma', [step('board', 'palma'), step('work', null, { h: 2, atSea: true, comfort: true }), step('land', 'palma', { afterSea: true })],
    { pax: 4, pay: { cr: 1200, rate: 300, model: 'lump' } }));
  putAt(y, destination(39.5, 2.6, 180, 3000), 6); run(d, y, 2.05);
  dock(d, y, 'palma');
  assert.deepEqual(d.paid.map((p) => p.cr), [1500], 'full comfort: 25 % tip');
});
