// docs/BRIDGES-LOCKS-VHF-CONTRACT.md §10.3 — Rozenburgsesluis: levelling, fit, packing, cycle, paired bridges, zero lift, AIS, fees.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { unpackFis } from '../server/fis.js';
import { createWaterworks } from '../server/waterworks.js';
import { levelTime, levelAt, culvertMua, fitChamber, packChamber, queueOrder, lockFee, pairedPlan, lockSignals, chamberLevel } from '../shared/waterworks.js';
import { profileOf, airDraftNow } from '../shared/airdraft.js';

const near = (a, b, eps = 0.001) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const syn = JSON.parse(fs.readFileSync(new URL('./fixtures/ww/rozenburg-synthetic.json', import.meta.url), 'utf8'));
const rtm = unpackFis(JSON.parse(fs.readFileSync(new URL('./fixtures/ww/fis-rotterdam.json', import.meta.url), 'utf8')));
const CH = syn.lock.chambers[0];
const sh = (cls, id = cls, st = {}) => { const p = profileOf(cls), a = airDraftNow(cls, st); return { id, name: id, L: p.length, B: p.beam, T: a.T, need: a.need(0), kind: p.sail || p.length < 20 ? 'small' : 'commercial' }; };

test('1. levelling: A 7320, μa 12.81 → Δh 1.0: 258 s; Δh 0.25: 129 s; remaining head at t = 129 from 1.0: 0.25', () => {
  near(culvertMua(CH), 12.81); const A = CH.len * CH.wid; assert.equal(A, 7320);
  near(levelTime(A, 12.81, 1.0), 258, 1); near(levelTime(A, 12.81, 0.25), 129, 1);
  near(levelAt(A, 12.81, 1.0, 129), 0.25, 0.002);
  assert.equal(levelAt(A, 12.81, 1.0, 400), 0);
});

test('2. fit (synthetic sill 9.0): feeder1000 fits, subpmax2800 (beam) no, panamax4500 no, gc120 fits', () => {
  const T = (id) => profileOf(id).tDesign;
  const fit = (id) => fitChamber(CH, { L: profileOf(id).length, B: profileOf(id).beam, T: T(id) });
  assert.equal(fit('feeder1000').ok, true);
  assert.deepEqual(fit('subpmax2800'), { ok: false, why: 'beam' });
  assert.equal(fit('panamax4500').ok, false);
  assert.equal(fit('gc120').ok, true);
});

test('2b. real FIS chamber: 305 × 24 m, sill NAP −6.5 → a laden feeder1000 (7.6 m) does NOT fit, a coaster does', () => {
  const real = rtm.locks.find((l) => l.name === 'Rozenburgsesluis');
  const ch = real.chambers[0];
  assert.deepEqual([ch.len, ch.wid, ch.sillUp, ch.sillDn], [305, 24, 6.5, 6.5]);
  assert.equal(real.vhf, 22); assert.equal(real.operator, 'Port of Rotterdam'); assert.equal(real.doubleActing, true);
  assert.deepEqual(real.sides.map((s) => s.level.kind), ['tidal', 'damped']);
  assert.equal(fitChamber(ch, { L: 134, B: 22.5, T: 7.6 }).why, 'draught');
  assert.equal(fitChamber(ch, { L: 90, B: 14, T: 5.5 }).ok, true);
  assert.deepEqual(real.bridges.sort(), ['fis:57361', 'fis:7951']);
});

test('3. packing: 3 coasters + 2 sloops all in one cycle (sloops at the far end, the 2nd rafted); feeder + coaster, 2nd coaster waits', () => {
  const q = [sh('coaster', 'c1'), sh('coaster', 'c2'), sh('coaster', 'c3'), sh('sloop', 's1'), sh('sloop', 's2')];
  const r = packChamber(CH, q);
  assert.deepEqual(r.waiting, []); assert.equal(r.placed.length, 5);
  const P = Object.fromEntries(r.placed.map((p) => [p.id, p]));
  assert.deepEqual([P.c1.x, P.c2.x, P.c3.x], [0, 93, 186]);
  assert.equal(P.s1.x, 279); assert.equal(P.s2.x, 279); assert.equal(P.s1.y, 0); near(P.s2.y, 4.2);
  const r2 = packChamber(CH, [sh('feeder1000', 'f'), sh('coaster', 'c1'), sh('coaster', 'c2')]);
  assert.deepEqual(r2.placed.map((p) => [p.id, p.x]), [['f', 0], ['c1', 137]]);
  assert.deepEqual(r2.waiting, ['c2']);
  // small craft may back-fill, commercial ships may not overtake
  const r3 = packChamber(CH, [sh('feeder1000', 'f'), sh('coaster', 'c1'), sh('coaster', 'c2'), sh('sloop', 's1')]);
  assert.deepEqual(r3.waiting, ['c2']); assert.ok(r3.placed.some((p) => p.id === 's1'));
});

test('queue order: passenger → commercial → small, then registration time', () => {
  const o = queueOrder([{ id: 'y', kind: 'small', at: 1 }, { id: 'c', kind: 'commercial', at: 5 }, { id: 'f', kind: 'passenger', at: 9 }]);
  assert.deepEqual(o.map((s) => s.id), ['f', 'c', 'y']);
});

test('4. cycle: admit → closing (mitre 120 s) → levelling (258 s at Δh 1.0) → opening 120 s → release; ships ride the level', () => {
  let T = 10_000;
  const lock = { ...syn.lock, bridges: [] };
  const ww = createWaterworks(null, { bridges: [], locks: [lock] }, { now: () => T });
  const ev = []; ww.onEvent((e) => ev.push(e.type));
  const r = ww.registerLock(lock.id, sh('coaster', 'c1'), 0);
  assert.equal(r.ok, true); assert.equal(r.chamber, 'A'); assert.equal(r.n, 1); assert.equal(r.fee, 0);
  ww.tick();
  let s = ww.state(lock.id).chambers[0];
  assert.equal(s.st, 'admit'); assert.deepEqual(s.sig, [['green'], ['red']]);
  assert.equal(ww.lockStay('c1').y, 0);
  assert.equal(ww.makeFast(lock.id, 'c1'), true);
  ww.tick(); s = ww.state(lock.id).chambers[0]; assert.equal(s.st, 'closing'); assert.equal(s.dur, 120);
  T += 120; ww.tick(); s = ww.state(lock.id).chambers[0]; assert.equal(s.st, 'levelling'); near(s.dur, 258, 1);
  assert.deepEqual(s.sig, [['red'], ['red']]);
  T += 129; ww.tick(); near(ww.lockStay('c1').y, 0.75, 0.01);           // half the time, three quarters of the lift
  T += 130; ww.tick(); s = ww.state(lock.id).chambers[0]; assert.equal(s.st, 'opening'); near(ww.lockStay('c1').y, 1.0, 0.001);
  T += 120; ww.tick(); s = ww.state(lock.id).chambers[0]; assert.equal(s.st, 'release'); assert.deepEqual(s.sig, [['red'], ['green']]);
  ww.leave(lock.id, 'c1'); ww.tick(); s = ww.state(lock.id).chambers[0];
  assert.equal(s.st, 'idle'); assert.equal(s.side, 1); assert.equal(ww.lockStay('c1'), null);
  assert.deepEqual(ev.filter((e) => ['admit', 'closing', 'levelling', 'opening', 'release', 'idle'].includes(e)), ['admit', 'closing', 'levelling', 'opening', 'release', 'idle']);
});

test('4b. a ship not made fast within 10 min loses its turn; empty turnaround after 5 min for the other side', () => {
  let T = 20_000;
  const lock = { ...syn.lock, bridges: [] };
  const ww = createWaterworks(null, { bridges: [], locks: [lock] }, { now: () => T });
  const ev = []; ww.onEvent((e) => ev.push(e));
  ww.registerLock(lock.id, sh('coaster', 'a'), 0); ww.registerLock(lock.id, sh('coaster', 'b'), 0);
  ww.tick(); ww.makeFast(lock.id, 'a');
  T += 600; ww.tick();
  assert.ok(ev.some((e) => e.type === 'lost_turn' && e.ship === 'b'));
  assert.equal(ww.lockStay('b'), null); assert.ok(ww.lockStay('a'));
  // other side waiting: idle at side 0 with a ship at side 1 → turnaround after 5 min
  const ww2 = createWaterworks(null, { bridges: [], locks: [lock] }, { now: () => T });
  const e2 = []; ww2.onEvent((e) => e2.push(e.type));
  ww2.registerLock(lock.id, sh('sloop', 'y'), 1); ww2.tick();
  assert.equal(ww2.state(lock.id).chambers[0].st, 'idle');
  T += 300; ww2.tick(); assert.ok(e2.includes('turnaround'));
});

test('5. paired head bridges: never both open; the plan needing both at once defers the second ship', () => {
  const d = pairedPlan([{ ship: 'a', bridge: 'out', from: 0, to: 300 }, { ship: 'b', bridge: 'in', from: 100, to: 400 }, { ship: 'c', bridge: 'in', from: 300, to: 500 }], { out: 'in', in: 'out' });
  assert.deepEqual(d.deferred, ['b']); assert.deepEqual(d.ok.map((n) => n.ship), ['a', 'c']);
  // full server cycle with the synthetic lift bridges on both heads, a sloop needing them
  let T = 30_000;
  const bridges = syn.bridges.map((b) => ({ ...b, lockId: syn.lock.id }));
  const ww = createWaterworks(null, { bridges, locks: [syn.lock] }, { now: () => T });
  ww.registerLock(syn.lock.id, sh('sloop', 's'), 0); ww.tick();
  const openNow = () => bridges.filter((b) => ww.state(b.id).spans[0].st !== 'closed').map((b) => b.id);
  let sawOut = false, sawIn = false;
  for (let k = 0; k < 1500; k++) {
    if (k === 1) ww.makeFast(syn.lock.id, 's');
    const st = ww.state(syn.lock.id).chambers[0].st;
    if (st === 'release') ww.leave(syn.lock.id, 's');
    const o = openNow(); assert.ok(o.length <= 1, `both open at ${k}: ${o}`);
    if (o.includes('syn:rbz-out')) sawOut = true; if (o.includes('syn:rbz-in')) sawIn = true;
    T += 1; ww.tick();
  }
  assert.ok(sawOut && sawIn, 'each head bridge opened for the sloop');
  // a ship that fits under the closed head bridge does not trigger it
  let T2 = 40_000;
  const ww2 = createWaterworks(null, { bridges, locks: [syn.lock] }, { now: () => T2 });
  ww2.registerLock(syn.lock.id, { ...sh('cruiser', 'cr', { fold: { arch: 1 } }), need: 3.2 }, 0); ww2.tick();
  assert.equal(ww2.state('syn:rbz-out').spans[0].st, 'closed');
});

test('6. zero lift (|Δh| < 0.05) → the lock stands open: both heads green, no cycle', () => {
  const flat = { ...syn.lock, id: 'flat', bridges: [], sides: [{ name: 'a', level: { kind: 'kp', h: 0 } }, { name: 'b', level: { kind: 'kp', h: 0.03 } }] };
  const ww = createWaterworks(null, { bridges: [], locks: [flat] }, { now: () => 1 });
  ww.tick();
  const s = ww.state('flat').chambers[0];
  assert.equal(s.st, 'standsopen'); assert.deepEqual(s.sig, [['green'], ['green']]);
  const r = ww.registerLock('flat', sh('coaster'), 0);
  assert.equal(r.standsOpen, true); assert.equal(r.tCycle, 0);
  assert.deepEqual(lockSignals({ st: 'standsopen' }), [['green'], ['green']]);
});

test('7. AIS occupant (barge 110 × 11.4 at the head end): feeder1000 cannot lie beside it, goes behind: 113 + 137 = 250 ≤ 300', () => {
  const occupants = [{ id: 'ais:244000001', x: 0, y: 0, l: 113, w: 12.0, kind: 'commercial' }];
  const r = packChamber(CH, [sh('feeder1000', 'f')], { occupants });
  assert.deepEqual(r.placed.map((p) => [p.id, p.x, p.y]), [['f', 113, 0]]); assert.deepEqual(r.waiting, []);
  // the server asks for occupants per chamber
  const ww = createWaterworks(null, { bridges: [], locks: [{ ...syn.lock, bridges: [] }] }, { now: () => 1, aisIn: () => occupants });
  ww.registerLock(syn.lock.id, sh('feeder1000', 'f'), 0); ww.tick();
  assert.equal(ww.state(syn.lock.id).chambers[0].plan[0].x, 113);
});

test('8. fees: RWS / Port of Rotterdam locks free; municipal small-craft lock without data 6 cr; commercial 0.5 cr/m', () => {
  assert.equal(lockFee({ operator: 'RWS' }, { L: 90, kind: 'commercial' }), 0);
  assert.equal(lockFee({ operator: 'Port of Rotterdam' }, { L: 11, kind: 'small' }), 0);
  assert.equal(lockFee({ operator: 'Municipality' }, { L: 11, kind: 'small' }), 6);
  assert.equal(lockFee({ operator: 'Municipality' }, { L: 90, kind: 'commercial' }), 45);
  assert.equal(lockFee({ operator: 'Province', fee: { small: 4.5, commercial: 0 } }, { L: 11, kind: 'small' }), 4.5);
  const ww = createWaterworks(null, { bridges: [], locks: [{ ...syn.lock, id: 'muni', operator: 'Municipality', bridges: [] }] }, { now: () => 1 });
  assert.equal(ww.registerLock('muni', sh('sloop'), 0).fee, 6);
});

test('chamber level helper follows the orifice curve', () => {
  const cs = { st: 'levelling', side: 0, t0: 0, dur: 258, level0: 0, level1: 1 };
  near(chamberLevel(CH, cs, 129, [0, 1]), 0.75, 0.01);
  near(chamberLevel(CH, { ...cs, level0: 1, level1: 0, side: 1 }, 129, [0, 1]), 0.25, 0.01);
});
