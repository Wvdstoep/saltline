// Cruise income and itineraries (docs/CRUISE-CONTRACT.md §3): real-style multi-port cruises on the step runner, ticket plus
// onboard spending scaled by the ship's venues, port restrictions through the existing limits/berth checks, and the penalties
// for late calls, rough seas and hull damage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harborById, HARBORS } from '../server/harbors.js';
import { JobsX, RUNNER } from '../server/jobsx.js';
import { generateFamilyJob } from '../server/jobsgen.js';
import { validJob, JOB_GEN } from '../shared/jobs/types.js';
import { ITINERARIES, itinerariesFrom, callsOf, CRUISE_FARE, CRUISE_RULES, cruiseIncome, fareOf } from '../shared/jobs/cruises.js';
import { payCruise } from '../shared/jobs/catalogue.js';
import { canDo } from '../shared/jobs/eligibility.js';
import { cruiseProfile, onboardIndex, CRUISE_CLASSES, venueList } from '../shared/ships/cruiseprofile.js';
import { MODELS } from '../shared/ships/catalogue.js';
import { tagsOf } from '../shared/jobs/ports.js';

const CRUISE_IDS = Object.keys(MODELS).filter((k) => MODELS[k].type === 'cruise');
const seeded = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const T0 = Date.UTC(2026, 6, 15, 12) / 1000;
const ctx = { harborById, simTime: T0 };

test('itineraries: every port exists, none is Russian, world legs are one-way and long', () => {
  for (const it of ITINERARIES) {
    for (const id of [...it.home, ...(it.calls || [])]) { const h = harborById(id); assert.ok(h, `${it.id}: ${id}`); assert.notEqual(h.country, 'RU', `${it.id}: ${id} is Russian`); }
    assert.ok(it.nights >= 7, it.id);
    if (it.id.startsWith('world_')) { assert.equal(it.oneWay, true); assert.ok(it.nights >= 18); }
    if (it.sites) for (const s of it.sites) assert.ok(Math.abs(s.lat) <= 85 && Math.abs(s.lon) <= 180);
  }
  for (const k of ['med_west', 'med_east', 'carib_east', 'carib_west', 'baltic', 'norway', 'alaska']) assert.ok(ITINERARIES.some((i) => i.id === k), k);
  assert.ok(itinerariesFrom('barcelona').some((i) => i.id === 'med_west'));
  assert.equal(callsOf(ITINERARIES[0], 'barcelona', () => false), null, 'no port fits → no cruise');
});

test('income: fare by class, onboard spending grows with the venues the ship really has', () => {
  assert.deepEqual(CRUISE_CLASSES.length, 8);
  for (const id of CRUISE_IDS) assert.ok(fareOf(id) > 0, id);
  const oi = (id) => onboardIndex(id);
  assert.ok(oi('cruise370') > oi('cruise362') && oi('cruise362') > oi('cruise330') && oi('cruise330') > oi('cruise285') && oi('cruise285') > oi('cruise230') && oi('cruise230') > oi('boutique125') && oi('boutique125') > oi('rivercruise110'), 'venue index follows the programme');
  const a = payCruise({ guests: 1000, hours: 100, cls: 'cruise230' }), b = payCruise({ guests: 1000, hours: 100, comfort: 1 });
  assert.equal(a, cruiseIncome({ guests: 1000, hours: 100, cls: 'cruise230' }).ticket + cruiseIncome({ guests: 1000, hours: 100, cls: 'cruise230' }).onboard);
  assert.equal(b, Math.round(1000 * 20 * 100 * 0.925), 'old flat rate without a class');
  for (const id of CRUISE_IDS) assert.ok(venueList(id).length >= 5, id);
  // fewer venues than guests: a casino ship earns more onboard per guest than a river ship
  assert.ok(oi('cruise362') / oi('rivercruise110') > 4);
  void CRUISE_FARE;
});

test('generator: itineraries from real home ports, multi-port steps, ticket + onboard pay, sized for the ship', () => {
  const homes = ['barcelona', 'miami', 'kiel', 'southampton', 'seattle', 'singapore', 'sydney', 'piraeus', 'lisbon', 'buenos_aires'];
  let n = 0;
  for (const home of homes) {
    const rnd = seeded(11);
    for (let k = 0; k < 6; k++) {
      const j = generateFamilyJob(harborById(home), T0, rnd, 'cruise', {}, {});
      if (!j) continue;
      n++;
      assert.deepEqual(validJob(j), [], `${home}: ${validJob(j)}`);
      assert.equal(j.gen, JOB_GEN); assert.equal(j.type, 'cruise');
      assert.equal(j.steps[0].k, 'board'); assert.equal(j.steps.at(-1).k, 'land');
      assert.ok(j.steps.filter((s) => s.k === 'sail' && s.until).length >= 2, 'a call at every port');
      assert.ok(j.steps.some((s) => s.k === 'work' && s.chartered), 'guests ashore / sea days');
      assert.ok(j.pay.ticket > 0 && j.pay.onboardRate > 0 && j.pay.cr > j.pay.ticket);
      const prof = cruiseProfile(j.ref.cls);
      assert.ok(j.pax <= prof.guests && j.pax >= 0.7 * prof.guests, `${j.pax} of ${prof.guests}`);
      // every port passes the ref ship's own checks: length, draught and (over 250 m) a cruise terminal
      const L = MODELS[j.ref.cls].length;
      for (const id of j.legs) { const h = harborById(id); assert.ok(!(L > 250) || tagsOf(h).has('cruise'), `${j.ref.cls} at ${id}`); assert.ok(L <= 400 && (h.size !== 'minor' || L <= 140), id); }
      const me = canDo(j, { ship: { cls: j.ref.cls }, cargo: [], jobs: [] }, ctx);
      assert.equal(me.ok, true, `${home} ${j.ref.cls}: ${me.why?.text}`);
      assert.ok(j.itinerary.name && j.itinerary.nights >= 3);
    }
  }
  assert.ok(n >= 40, `${n} cruises generated`);
});

test('port restrictions: a 370 m ship needs cruise terminals; Bergen takes 250 m, so the big ships refuse it as a call', () => {
  const rnd = seeded(5);
  const j = generateFamilyJob(harborById('southampton'), T0, rnd, 'cruise', {}, {});
  assert.ok(j);
  const big = { ship: { cls: 'cruise370' }, cargo: [], jobs: [] };
  const mkCalls = (ids) => ({ ...j, legs: ids, to: 'southampton', pax: 500, needs: { ...j.needs, qty: 500 }, steps: [{ k: 'board', at: 'southampton' }, ...ids.map((id) => ({ k: 'sail', at: id, until: 1 })), { k: 'land', at: 'southampton' }] });
  const fake = mkCalls(['bergen', 'tromso']);
  const r = canDo(fake, big, ctx);
  assert.equal(r.ok, false);
  assert.ok(r.all.some((x) => x.code === 'loa' || x.code === 'facility'), JSON.stringify(r.all.map((x) => x.code)));
  const small = canDo(mkCalls(['bergen']), { ship: { cls: 'boutique125' }, cargo: [], jobs: [] }, ctx);
  assert.ok(!small.all.some((x) => x.code === 'loa' || x.code === 'facility'), 'a boutique ship fits Bergen');
  // a 285 m ship at a plain commercial quay: no cruise berth
  const plain = HARBORS.find((h) => h.size === 'major' && !tagsOf(h).has('cruise'));
  assert.ok(plain);
  const r2 = canDo(mkCalls([plain.id]), { ship: { cls: 'cruise285' }, cargo: [], jobs: [] }, ctx);
  assert.ok(r2.all.some((x) => x.code === 'facility'), `${plain.id}`);
});

// ------------------------------------------------------------------------------------------------ settlement
function rig() {
  const clock = { t: T0 }, paid = [], events = [], reps = [];
  const env = { now: () => clock.t, harborById, pay: (a, cr, j) => { paid.push(cr); a.money = (a.money || 0) + cr; }, event: (a, k, t) => events.push(t), rep: (a, d) => reps.push(d),
    seaHs: () => rig.hs, damage: (a, p) => { a.cond = Math.max(0, (a.cond ?? 100) - p); } };
  return { jx: new JobsX(env), env, clock, paid, events, reps };
}
rig.hs = 0;
function mkJob(cls = 'cruise230') {
  const rnd = seeded(3);
  let j = null;
  for (let i = 0; i < 20 && !j; i++) j = generateFamilyJob(harborById('barcelona'), T0, rnd, 'cruise', {}, { fit: { cls, vessel: {} } });
  j.hours = 1000;
  return j;
}
const actorOf = (cls, port) => { const h = harborById(port); return { id: 'p1', ship: { cls, lat: h.lat, lon: h.lon, spd: 0 }, docked: port, cargo: [], jobs: [], shipTime: 1_800_000_000, money: 0, cond: 100 }; };

test('settle: undamaged on-time cruise pays ticket + onboard + the perfect-cruise bonus', () => {
  const r = rig(), a = actorOf('cruise230', 'barcelona'), j = mkJob();
  const res = r.jx.accept(a, j); assert.equal(res.ok, true, res.why);
  const q = res.job, hrs = q.cruiseH || q.hours;
  q.prog.i = q.steps.length - 1;
  const s = r.jx.settleAmount(a, q);
  const base = q.pay.ticket + Math.round(q.pax * hrs * onboardIndex('cruise230'));
  assert.equal(s.cr, base + Math.round(base * CRUISE_RULES.PERFECT_BONUS));
  assert.ok(s.notes.includes('perfect cruise bonus'));
});

test('settle: late calls, rough seas and hull damage each cut the fee; another ship earns by her own venues', () => {
  const r = rig(), a = actorOf('cruise230', 'barcelona'), j = mkJob();
  const q = r.jx.accept(a, j).job; q.prog.i = q.steps.length - 1;
  const clean = r.jx.settleAmount(a, q).cr;
  q.prog.late = 2; const late = r.jx.settleAmount(a, q);
  assert.ok(late.cr < clean * 0.9 && /2 late calls/.test(late.notes.join()), late.notes.join());
  q.prog.late = 99; assert.equal(Math.round((1 - r.jx.settleAmount(a, q).cr / (clean / (1 + CRUISE_RULES.PERFECT_BONUS))) * 100), 48, 'capped at −48 %');
  q.prog.late = 0; q.prog.cT = 1000; q.prog.cBad = 1000;
  const rough = r.jx.settleAmount(a, q); assert.ok(rough.cr < clean && /rough seas/.test(rough.notes.join()));
  q.prog.cBad = 0; a.cond = 90;
  const dmg = r.jx.settleAmount(a, q); assert.ok(/hull damage/.test(dmg.notes.join()) && dmg.cr < clean * 0.85, dmg.notes.join());
  assert.deepEqual(r.reps.length, 1, 'reputation hit');
  a.cond = 100; a.shipTime = q.dueShip + 3600;
  assert.ok(/overran/.test(r.jx.settleAmount(a, q).notes.join()));
  // the same cruise sailed by the 362 m ship's venue programme earns more onboard
  const b = actorOf('cruise362', 'barcelona'); b.shipTime = a.shipTime; q.dueShip = Infinity;
  a.shipTime = 1_800_000_000;
  assert.ok(r.jx.settleAmount(b, q).cr > r.jx.settleAmount(a, q).cr);
});

test('the runner: dock at every call in order → the cruise is paid once at the last landing', () => {
  const r = rig(), a = actorOf('cruise230', 'barcelona'), j = mkJob();
  const q = r.jx.accept(a, j).job;
  for (const s of q.steps) {
    if (s.k === 'sail' && typeof s.at === 'string') {
      const h = harborById(s.at); a.ship.lat = h.lat; a.ship.lon = h.lon; a.docked = s.at; r.jx.onDock(a, s.at);
      a.docked = null;
    } else if (s.k === 'work') for (let k = 0; k < Math.ceil(s.h) * 60; k++) { r.clock.t += 60; a.shipTime += 60; r.jx.onTick(a, 60); }
  }
  const last = q.steps.at(-1); const h = harborById(last.at); a.ship.lat = h.lat; a.ship.lon = h.lon; a.docked = last.at; r.jx.onDock(a, last.at);
  assert.equal(r.paid.length, 1, r.events.join(' | '));
  assert.ok(r.paid[0] > q.pay.ticket * 0.9);
  assert.equal(a.jobs.length, 0);
});

test('rough seas are tracked on sailing legs (comfort)', () => {
  const r = rig(), a = actorOf('cruise230', 'barcelona'), j = mkJob();
  const q = r.jx.accept(a, j).job;
  a.docked = null; rig.hs = 3;
  for (let k = 0; k < 30; k++) { r.clock.t += 60; a.shipTime += 60; r.jx.onTick(a, 60); }
  rig.hs = 0;
  assert.ok(q.prog.cT > 0 && q.prog.cBad === q.prog.cT, `${q.prog.cT}/${q.prog.cBad}`);
  void RUNNER;
});

test('settle: the guest rating (shared/ships/cruisesat.js) scales the ticket and the onboard spending; no rating, no change', () => {
  const q0 = (gs) => { const r = rig(); if (gs) r.jx.env.guest = () => gs; const a = actorOf('cruise230', 'barcelona'), q = r.jx.accept(a, mkJob()).job; q.prog.i = q.steps.length - 1; return r.jx.settleAmount(a, q); };
  const none = q0(null), hi = q0({ stars: 4.8, payMul: 1.1, spendMul: 1.1 }), lo = q0({ stars: 1.3, payMul: 0.8, spendMul: 0.75 });
  assert.ok(hi.cr > none.cr * 1.05 && lo.cr < none.cr * 0.88, `${lo.cr} ${none.cr} ${hi.cr}`);
  assert.ok(hi.notes.some((n) => /rated the ship 4.8/.test(n)));
});
