// Contract §7 politics-engine: server/politics.js against a fake game (dice injected through game.rolls).
import test from 'node:test';
import assert from 'node:assert/strict';
import { dateToS } from '../shared/politics.js';
import { riskPolicyRefusal } from '../server/politics.js';
import { makePolitics, player, at, T0 } from './politics-helpers.mjs';

test('a closed port refuses entry and the refusal is recorded', () => {
  const { pol } = makePolitics(), p = player({ home: 'hc1' });
  const e = pol.entryCheck(p, 'hz');
  assert.equal(e.refuse, true);
  assert.equal(e.text, 'Zulu Port port control refuses entry: closed to merchant shipping — port operations suspended (JWC).');
  assert.equal(p.office.pol.records.at(-1).kind, 'refused');
  assert.equal(pol.entryCheck(p, 'hc1').refuse, false);
});
test('Cuba-style lockout: a trading call refuses the ship 10 h later, allows it after 180 h', () => {
  const { pol, game } = makePolitics(), p = player({ home: 'hc1', cargo: [{ good: 'grain', qty: 100, origin: 'XC' }] });
  pol.onDock(p, 'hf1');
  game.simTime = T0 + 10 * 3600;
  const e = pol.entryCheck(p, 'ha1');
  assert.equal(e.refuse, true); assert.match(e.text, /Rule 7: ships that traded in XF/);
  game.simTime = T0 + 648000; assert.equal(pol.entryCheck(p, 'ha1').refuse, true);
  game.simTime = T0 + 648001; assert.equal(pol.entryCheck(p, 'ha1').refuse, false);
});
test('a call without cargo or contracts does not lock the ship out', () => {
  const { pol, game } = makePolitics(), p = player({ home: 'hc1' });
  pol.onDock(p, 'hf1'); game.simTime = T0 + 3600;
  assert.equal(pol.entryCheck(p, 'ha1').refuse, false);
});
test('seizure on entry: cargo forfeited, fine = max(10,000, 2 × value), standing −20 per seizure', () => {
  const { pol } = makePolitics(), p = player({ home: 'hc1', cargo: [{ good: 'steel', qty: 100, origin: 'XE', jobId: null }, { good: 'steel', qty: 5, origin: 'XE', jobId: null }, { good: 'steel', qty: 50, origin: null, jobId: null }] });
  const r = pol.onDock(p, 'ha1');
  assert.deepEqual(r.seized.map((s) => [s.qty, s.value, s.fine]), [[100, 90000, 180000], [5, 4500, 10000]]);
  assert.equal(p.money, 1000000 - 180000 - 10000);
  assert.deepEqual(p.cargo, [{ good: 'steel', qty: 50, origin: null, jobId: null }]);
  assert.equal(p.office.pol.rep.XA, -40);
  assert.match(pol.game.events.find((e) => e.kind === 'law').text, /^Alpha Port customs seized 100 t of .* \(origin XE\): Act A Art\. 1: import of XE steel \(JWC, 01 Jan 2026\)\. Fine 180,000 cr\.$/);
});
test('seizure that the company cannot pay goes to the impound path', () => {
  const { pol, game } = makePolitics(), p = player({ home: 'hc1', money: 5000, cargo: [{ good: 'steel', qty: 5, origin: 'XE' }] });
  pol.onDock(p, 'ha1');
  assert.deepEqual(game.impounded, [{ by: 'Alpha Port customs', fine: 10000 }]);
});
test('PSC detention: fee, standing, and no undocking below 60 % or before the hold ends', () => {
  const { pol, game } = makePolitics(), p = player({ home: 'ha1', cond: 50 });
  game.rolls = [0.01, 0.01];                          // inspected (SRS 12 %), detained (hull 50 % → 15 %)
  const r = pol.onDock(p, 'hd1');
  assert.deepEqual([r.psc.profile, r.psc.pInspect, r.psc.pDetain, r.psc.inspected, r.psc.detained], ['SRS', 0.12, 0.15, true, true]);
  assert.equal(p.money, 1000000 - 1500);
  assert.deepEqual(p.office.pol.rep, { XD: -5, XA: -2, XB: -2, XC: -2 });
  assert.match(pol.canUndock(p), /repair the hull to 60 %/);
  p.cond = 65; assert.match(pol.canUndock(p), /hull OK \(65 %\), the inspector re-attends in 60 min of ship time/);
  game.simTime = T0 + 3601; assert.equal(pol.canUndock(p), null);
  pol.tick(p); assert.equal(p.held, null);
  assert.ok(game.events.at(-1).text.includes('Crew safe'));
});
test('PSC detention: the inspector\'s wait runs on the ship\'s clock, so time warp shortens it', () => {
  const { pol, game } = makePolitics(), p = player({ home: 'ha1', cond: 50 });
  p.shipTime = T0;
  game.rolls = [0.01, 0.01];
  pol.onDock(p, 'hd1');
  p.cond = 100;
  assert.match(pol.canUndock(p), /hull OK \(100 %\), the inspector re-attends in 60 min/);
  p.shipTime = T0 + 1800; game.simTime = T0 + 360;   // 5× warp for 6 real minutes: 30 min of ship time
  assert.match(pol.canUndock(p), /re-attends in 30 min/);
  p.shipTime = T0 + 3601; game.simTime = T0 + 720;   // the hour has passed on the ship's clock
  assert.equal(pol.canUndock(p), null);
  pol.tick(p); assert.equal(p.held, null);
});
test('war incident outcomes with injected dice: major, minor, total loss, detention', () => {
  const { pol, game } = makePolitics(), p = player({ cargo: [{ good: 'grain', qty: 100, jobId: null }, { good: 'steel', qty: 200, jobId: 'j9' }] });
  const war3 = pol.ds.areaById.war3;
  game.rolls = [0.8];
  const major = pol.incident(p, p, war3, 'projectile');
  assert.deepEqual([major.outcome, major.hull, p.cond, p.cargo[0].qty, p.cargo[1].qty], ['major', 30, 48, 75, 150]);
  assert.match(major.text, /was hit by an unidentified projectile .* Crew safe\. Hull −30 %\.$/);
  game.rolls = [0.5];
  assert.equal(pol.incident(p, p, war3, 'mine').outcome, 'minor'); assert.equal(p.cond, 40);
  game.rolls = [0.5];
  const det = pol.incident(p, p, war3, 'detention');
  assert.equal(det.hours, 15); assert.equal(p.held.until, T0 + 15 * 3600);
  game.rolls = [0.99];
  const loss = pol.incident(p, p, war3, 'mine');
  assert.equal(loss.outcome, 'loss');
  assert.equal(game.sunk.length, 1); assert.equal(game.sunk[0].reason, 'war_loss');
  assert.match(game.sunk[0].text, /evacuated safely/);
});
test('entering a listed area buys cover (coaster 78 % → 901 cr) and rolls the per-hour incident chance', () => {
  const { pol, game } = makePolitics(), p = at(player({ home: 'hc1' }), 44, 30);
  game.rolls = [0.0001, 0.2, 0.5];                    // pHour(0.006, 1 h) = 0.00025 → hit; mine; minor
  const r = pol.stepSea(p, 1);
  assert.deepEqual(r.entered, ['war4', 'fx-corr']);          // on the corridor line (within OFF_CORRIDOR_KM)
  assert.equal(r.incidents[0].kind, 'mine'); assert.equal(r.incidents[0].outcome, 'minor');
  assert.equal(p.money, 1000000 - 901); assert.equal(p.cond, 70);
  assert.ok(game.events.some((e) => e.text === 'War risk additional premium — Fixture listed area T4 (JWC): 901 cr.'));
  pol.stepSea(p, 1); assert.equal(p.money, 1000000 - 901);   // covered: no second charge
  game.simTime = T0 + 169 * 3600; pol.stepSea(p, 1);         // after 168 h: charged again
  assert.equal(p.money, 1000000 - 901 - 858);              // renewed at cond 70: hull value 85,800 × 1 % = 858
});
test('cover renewal uses the hull value at the time (cond 70 → 85,800 → 858 cr)', () => {
  const { pol, game } = makePolitics(), p = at(player({ home: 'hc1', cond: 70 }), 44, 30);
  pol.stepSea(p, 1); assert.equal(p.money, 1000000 - 858);
  game.simTime = T0 + 169 * 3600; pol.stepSea(p, 1); assert.equal(p.money, 1000000 - 2 * 858);
});
test('war premium refunded by the shipper on delivery', () => {
  const { pol } = makePolitics(), p = at(player({ home: 'hc1' }), 44, 30);
  const j = { id: 'j1', type: 'corridor', from: 'hd1', to: 'hr', good: 'grain', qty: 1000, pay: 100000, title: 'Grain corridor', pol: { tier: 4, acceptedAt: T0 - 10 } };
  p.jobs.push(j);
  pol.stepSea(p, 1); assert.equal(p.money, 1000000 - 901);
  const r = pol.onPaid(p, j, false, pol.harborById('hr'));
  assert.equal(r.refund, 901); assert.equal(p.money, 1000000);
  assert.deepEqual(r.rep, { XD: 1, XE: 1 });
  assert.equal(pol.onPaid(p, j, false).refund, 0);       // refunded once
});
test('warlike area: crew on double pay (coaster crewCost 40 → +40 cr per hour), accrued across small steps', () => {
  const { pol, game } = makePolitics(), p = at(player({ home: 'hc1' }), 44, 32);
  pol.stepSea(p, 0.5); pol.stepSea(p, 0.5);
  assert.equal(p.money, 1000000 - 40);
  assert.ok(game.events.some((e) => e.text.startsWith('IBF warlike operations area: crew on double basic pay')));
  pol.stepSea(p, 1, 0, { underway: false }); assert.equal(p.money, 1000000 - 40);
});
test('ECA: 2.0 t burned inside → 455 cr; scrubber exempt; future ECA not charged', () => {
  const { pol } = makePolitics(), p = player({ home: 'hc1' });
  pol.stepSea(p, 1, 2.0); assert.equal(p.money, 1000000 - 455);
  p.scrubber = true; pol.stepSea(p, 1, 2.0); assert.equal(p.money, 1000000 - 455);
  const q = at(player({ home: 'hc1' }), 39.5, 0); pol.stepSea(q, 1, 2.0); assert.equal(q.money, 1000000);
});
test('piracy: robbery takes min(5,000, 2 % of cash); hijack holds 12 h and costs 5 % of hull value', () => {
  const { pol, game } = makePolitics(), p = at(player({ home: 'hc1' }), 0, 10);
  game.rolls = [0.0001, 0.1];
  pol.stepSea(p, 1); assert.equal(p.money, 1000000 - 5000);
  const q = at(player({ home: 'hc1' }), 0, 10);
  game.rolls = [0.0001, 0.99];
  pol.stepSea(q, 1); assert.equal(q.money, 1000000 - 4506); assert.equal(q.held.until, T0 + 12 * 3600);
  assert.ok(game.events.at(-1).text.endsWith('Ship held; released after 12 h. Crew safe.'));
});
test('captain risk policy: avoid refuses a tier-4 job and corridor runs; cautious refuses tier ≥ 3; accept takes it', () => {
  const { pol } = makePolitics(), ds = pol.ds;
  const job = { type: 'freight', from: 'hd1', to: 'hr', good: 'grain', pol: { areas: ['war4'] } };
  assert.equal(riskPolicyRefusal(ds, job, 'avoid'), "Your risk policy is 'avoid': no captain sails into Fixture listed area T4.");
  assert.match(riskPolicyRefusal(ds, job, 'cautious'), /cautious/);
  assert.equal(riskPolicyRefusal(ds, job, 'accept'), null);
  assert.match(riskPolicyRefusal(ds, { type: 'corridor', pol: {} }, 'avoid'), /corridor/);
  assert.equal(riskPolicyRefusal(ds, { type: 'freight', pol: { areas: ['war1'] } }, 'cautious'), null);
  const p = player({ home: 'hc1' });
  assert.match(pol.captainCheck(p, { type: 'freight', from: 'hc1', to: 'hz', good: 'grain' }, 'accept'), /Zulu Port port control refuses entry/);
  assert.equal(pol.departureCheck(p, p, 'hr').fail, true);
  p.office.pol.riskPolicy = 'accept';
  const d = pol.departureCheck(p, p, 'hr'); assert.equal(d.wait, true); assert.equal(d.until, T0 + 7200);
});
test('clearance: issued after 2 h, valid 72 h, refused for a denied flag', () => {
  const { pol, game } = makePolitics(), p = player({ home: 'hc1' });
  assert.equal(pol.requestClearance(p, 'hr').ok, true);
  assert.equal(pol.entryCheck(p, 'hr').refuse, true);
  game.simTime = T0 + 7200; assert.deepEqual([pol.entryCheck(p, 'hr').refuse, pol.entryCheck(p, 'hr').needs], [false, 'corridor']);
  game.simTime = T0 + 7200 + 72 * 3600 + 1; assert.equal(pol.entryCheck(p, 'hr').refuse, true);
  const q = player({ home: 'hc1' }); q.flag = { cc: 'XH', registry: 'national:XH', since: 0 };
  assert.equal(pol.requestClearance(q, 'hr').ok, false);
});
test('secondary exposure → designation at that authority\'s ports (25 % roll), cargo seized, bank flags', () => {
  const { pol, game } = makePolitics(), p = player({ home: 'hc1' });
  assert.equal(pol.onTrade(p, 'he1', 'fuel', 'buy').block, false);
  assert.equal(p.office.pol.exposure.length, 1);
  p.cargo.push({ good: 'fuel', qty: 10, origin: 'XE', jobId: null });
  game.rolls = [0.1];
  const r = pol.onDock(p, 'ha1');
  assert.equal(r.designated, 'XA'); assert.equal(r.seized[0].fine, 13000);
  assert.equal(p.office.pol.designated.XA, T0 + 30 * 3600);
  assert.equal(pol.entryCheck(p, 'ha2').refuse, true);
  assert.deepEqual(pol.bankFlags(p.office), ['designated:XA', 'seizure_30d']);
  game.rolls = [0.1]; assert.equal(pol.onDock(p, 'ha2').designated, null);   // one roll per exposure
});
test('reconcile: wind-down to the measure start + 30 h, then cancellation with 25 % frustration pay', () => {
  const { pol, game } = makePolitics(), p = player({ home: 'ha1' });
  const j = { id: 'jg', type: 'freight', from: 'ha1', to: 'hd1', good: 'grain', qty: 100, pay: 100000, title: 'Freight 100 t of grain to Delta Port' };
  assert.equal(pol.onAccept(p, j).block, false); assert.equal(j.pol.acceptedAt, T0); assert.equal(j.pol.ver, '2099.01.1');
  p.jobs.push(j); p.cargo.push({ good: 'grain', qty: 100, jobId: 'jg' });
  game.simTime = Date.UTC(2026, 9, 10, 6) / 1000;
  const a = pol.reconcile(p);
  assert.deepEqual(a, [{ jobId: 'jg', action: 'wind_down', until: dateToS('2026-10-10') + 30 * 3600 }]);
  assert.equal(p.jobs.length, 1);
  game.simTime = dateToS('2026-10-10') + 30 * 3600 + 1;
  assert.deepEqual(pol.reconcile(p), [{ jobId: 'jg', action: 'cancelled', pay: 25000 }]);
  assert.deepEqual([p.jobs.length, p.cargo.length, p.money], [0, 0, 1025000]);
});
test('accepting a blocked contract is refused with the measure text', () => {
  const { pol } = makePolitics(), p = player({ home: 'ha1' });
  const r = pol.onAccept(p, { id: 'jm', type: 'freight', from: 'ha1', to: 'he1', good: 'machinery', qty: 10 });
  assert.equal(r.block, true);
  assert.equal(r.text, 'Not allowed for your company: Act A Art. 2: export of machinery to XE (JWC, 01 Jan 2026).');
});
test('mustAvoid breach halves the pay and costs standing with the shipper country', () => {
  const { pol } = makePolitics(), p = at(player({ home: 'hc1' }), 22, 2);
  const j = { id: 'ja', type: 'avoid', from: 'ha1', to: 'hh1', good: 'steel', qty: 100, pay: 50000, title: 'Freight — avoid T3', pol: { mustAvoid: ['war3'], acceptedAt: T0 } };
  p.jobs.push(j); pol.stepSea(p, 1);
  assert.equal(j.pol.breached, true);
  const r = pol.onPaid(p, j, false);
  assert.equal(r.payMul, 0.5); assert.equal(p.office.pol.rep.XA, -4);   // −5 breach, +1 delivery
});
test('express passage cannot end inside a tier ≥ 3 area; crossing one buys cover and rolls once', () => {
  const { pol, game } = makePolitics(), p = at(player({ home: 'hc1' }), 26, 2.5);
  assert.equal(pol.expressCheck(p, { points: [[22, 2.5]] }).refuse, true);
  const r = pol.expressCheck(p, { points: [[19, 2.5]] });
  assert.equal(r.refuse, false); assert.equal(r.incidents.length, 0);
  assert.equal(p.money, 1000000 - 631);
  game.rolls = [0.000001, 0.5, 0.5];
  const q = at(player({ home: 'hc1' }), 26, 2.5);
  assert.equal(pol.expressCheck(q, { points: [[19, 2.5]] }).incidents.length, 1);
});
test('views: harbour rules, you, office, client payload', () => {
  const { pol } = makePolitics(), p = player({ home: 'ha1', cargo: [{ good: 'steel', qty: 10, origin: 'XE' }] });
  const r = pol.harbourPayload(p, 'hr');
  assert.equal(r.status.value, 'restricted'); assert.equal(r.entry.needs, 'clearance');
  assert.equal(r.security[0].premium, 901); assert.equal(r.security[0].pCall, 0.015);
  assert.ok(r.you.blocked.some((b) => b.good === 'steel'));
  assert.equal(r.disclaimer, 'Simplified for the game — not legal, compliance or navigation advice.');
  assert.ok(pol.harbourPayload(p, 'ha1').you.seizable.some((s) => s.good === 'steel'));
  assert.equal(pol.harbourPayload(p, 'ha1').eca[0].surchargePerT, 228);
  const y = pol.youView(p);
  assert.deepEqual([y.ctx.home, y.ctx.flag, y.ctx.customs], ['XA', 'XA', 'xu']);
  assert.equal(pol.officeView(p).riskPolicy, 'avoid');
  const c = pol.clientPayload();
  assert.equal(c.etag, '"pol-2099.01.1"'); assert.ok(!('trade' in JSON.parse(c.json)));
});
test('daily tick: tonnage tax accrues, negative standing recovers 1 per day, expired holds are cleared', () => {
  const { pol, game } = makePolitics(), p = player({ home: 'ha1' });
  pol.ctxOf(p); p.flag = { cc: 'XL', registry: 'lr', since: 0 };
  p.office.pol.rep = { XD: -5, XA: 3 };
  pol.dailyTick(p);
  game.simTime = T0 + 3 * 86400; const r = pol.dailyTick(p);
  assert.equal(r.days, 3);
  assert.deepEqual(p.office.pol.rep, { XD: -2, XA: 3 });   // the first tick only starts the clock, then 3 days: −5 → −2
  // lr: 0.2 cr/t/year × 3,200 t = 1.7534 cr/day → 3 days accrued → 5 cr charged, remainder kept
  assert.equal(p.money, 1000000 - 5);
});
