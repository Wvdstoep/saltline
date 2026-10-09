// docs/BRIDGES-LOCKS-VHF-CONTRACT.md §10.2 — clearances, datums, verdicts, bridge operation, strikes, converter v2 helpers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { unpackFis } from '../server/fis.js';
import { createWaterworks } from '../server/waterworks.js';
import { clrNow, gauge, passVerdict, bestSpan, scheduleOpen, spanTimes, strikeOutcome, boardText, WW_KEEP_TAGS, seamarkBridge, bridgeVector, MOV_CODE, localTime } from '../shared/waterworks.js';
import { datumOffset } from '../shared/waterlevel.js';
import { airDraftNow, profileOf } from '../shared/airdraft.js';

const near = (a, b, eps = 0.001) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const rtm = unpackFis(JSON.parse(fs.readFileSync(new URL('./fixtures/ww/fis-rotterdam.json', import.meta.url), 'utf8')));
const syn = JSON.parse(fs.readFileSync(new URL('./fixtures/ww/rozenburg-synthetic.json', import.meta.url), 'utf8'));
const byName = (n) => rtm.bridges.find((b) => b.name === n) || rtm.locks.find((l) => l.name === n);
const BOTLEK = byName('Botlekbrug'), CALAND = byName('Calandbrug Rozenburg');
const ship = (cls, st = {}) => { const p = profileOf(cls), a = airDraftNow(cls, st); return { id: cls, name: cls, ...a, beam: p.beam, L: p.length, B: p.beam, kind: p.sail ? 'small' : 'commercial' }; };
const UP = {}, DOWN = { wheelhouse: 1 };
// Wed 2026-10-14, Europe/Amsterdam is UTC+2 (CEST)
const local = (hh, mm = 0) => Date.UTC(2026, 9, 14, hh - 2, mm) / 1000;

test('FIS fixture: Botlekbrug and Calandbrug real figures (probe 2026-10-09)', () => {
  assert.equal(BOTLEK.datum, 'NAP'); assert.equal(BOTLEK.vhf, 18); assert.equal(BOTLEK.spans.length, 2);
  assert.ok(BOTLEK.spans.every((s) => s.mov === 'lift' && Math.abs(s.clr - 14.0) < 0.1 && s.clrO === 45));
  near(BOTLEK.spans[0].w, 87.3); assert.deepEqual(BOTLEK.slots, { every: 30, at: 15 });
  assert.equal(CALAND.vhf, 22);
  const lift = CALAND.spans.find((s) => s.mov === 'lift');
  assert.ok(lift.clr >= 10.5 && lift.clr <= 13.0, String(lift.clr));       // §10.2.5: closed in [10.5, 13.0]
  assert.ok(lift.clrO >= 45, String(lift.clrO));                             // open ≥ 45 (FIS 49.7)
  assert.equal(boardText(lift), '11.7 / 49.7');
});

test('1. Botlekbrug clearance now: water +1.2 → 12.8, −0.8 → 14.8 (gauge rounds down to 0.1)', () => {
  near(clrNow(BOTLEK, 0, { h: 1.2 }), 12.84, 0.001); assert.equal(gauge(BOTLEK, 0, 1.2), 12.8);
  near(clrNow(BOTLEK, 0, { h: -0.8 }), 14.84, 0.001); assert.equal(gauge(BOTLEK, 0, -0.8), 14.8);
  near(clrNow(BOTLEK, 0, { h: 0, frac: 1 }), 45); near(clrNow(BOTLEK, 0, { h: 0, frac: 0.5 }), 29.52, 0.01);
});

test('2. coaster wheelhouse up in ballast at Botlekbrug → opening; wheelhouse down → under from −1.5 to +3.0', () => {
  const up = ship('coaster', { ballastT: 600, fold: UP });
  near(up.need(0), 15.224);
  assert.equal(bestSpan(up, BOTLEK, { h: 0 }).verdict, 'opening');
  const down = ship('coaster', { ballastT: 600, fold: DOWN });
  for (let h = -1.5; h <= 3.0; h += 0.5) assert.equal(bestSpan(down, BOTLEK, { h }).verdict, 'under', `h=${h}`);
});

test('3. sloop 17 m at the lock-head bridge (synthetic lift 3.6 / 24.0): opening; red → red+green (120 s) → green (262 s)', () => {
  let T = 1_000_000;
  const ww = createWaterworks(null, { bridges: syn.bridges, locks: [] }, { now: () => T, water: () => 0 });
  const id = 'syn:rbz-out', s = ship('sloop');
  assert.equal(passVerdict(s, ww.get(id), 0, { h: 0 }).verdict, 'opening');
  assert.equal(spanTimes(ww.get(id).spans[0]).move, 82);
  const r = ww.request(id, s, 60);
  assert.equal(r.ok, true); assert.equal(r.verdict, 'opening'); assert.equal(r.tOpen, T + 120); assert.equal(r.n, 1);
  const t0 = T, light = (dt) => { T = t0 + dt; ww.tick(); return ww.state(id).sig[0].lights.join('+'); };
  assert.equal(light(119), 'red');
  assert.equal(light(120), 'red+green');
  assert.equal(light(261), 'red+green');
  assert.equal(light(262), 'green');
  assert.equal(ww.state(id).spans[0].st, 'open');
  ww.passed(id, 'sloop'); assert.equal(light(263), 'red'); assert.equal(ww.state(id).spans[0].st, 'closing');
});

test('3b. real head bridges are bascules 3.6 / ∞, 24 m wide: the sloop gets green at 120 + 60 + 70 = 250 s', () => {
  const real = byName('Brug over buitenhoofd Rozenburgsesluis');
  assert.equal(real.spans[0].mov, 'bascule'); assert.equal(real.spans[0].clr, 3.6); assert.equal(real.spans[0].clrO, Infinity); assert.equal(real.spans[0].w, 24);
  assert.equal(real.lockId, 'fis:4199'); assert.equal(real.pairedWith, 'fis:7951');
  let T = 2_000_000;
  const ww = createWaterworks(null, { bridges: [{ ...real, lockId: null }], locks: [] }, { now: () => T, water: () => 0 });
  const r = ww.request(real.id, ship('sloop'), 60); assert.equal(r.tOpen, T + 120);
  T += 249; ww.tick(); assert.notEqual(ww.state(real.id).spans[0].st, 'open');
  T += 1; ww.tick(); assert.equal(ww.state(real.id).spans[0].st, 'open');
});

test('4. schooner (need 34.3): never at the synthetic 24.0 lift; opening at the Calandbrug (49.7)', () => {
  const s = ship('schooner');
  const v = passVerdict(s, syn.bridges[0], 0, { h: 0 });
  assert.equal(v.verdict, 'never'); near(v.need, 34.3);
  assert.equal(bestSpan(s, CALAND, { h: 0 }).verdict, 'opening');
  const ww = createWaterworks(null, { bridges: syn.bridges, locks: [] }, { now: () => 0, water: () => 0 });
  assert.deepEqual([ww.request('syn:rbz-out', s, 60).reason], ['never']);
});

test('6. MHWS datum: UK bridge clr 10.0 MHWS, region M2 1.5 → offset +1.995, clearance now at h = 0: 11.995', () => {
  const uk = { id: 'uk', p: [57.15, -2.1], datum: 'MHWS', spans: [{ id: 0, a: 0, b: 30, mov: 'fixed', clr: 10.0, clrO: null, w: 30 }] };
  near(datumOffset('MHWS', 57.15, -2.1), 1.995);
  near(clrNow(uk, 0, { h: 0 }), 11.995);
  near(datumOffset('KP', 52, 5, -0.4), -0.4); near(datumOffset('NAP', 52, 5), 0);
});

test('7. hours: 23:00 to a 06:00–22:00 bridge → hours / next 06:00; rush-hour block 07:00–09:00 → tOpen 09:00', () => {
  const base = { ...syn.bridges[0], id: 'h', spans: [{ ...syn.bridges[0].spans[0], mov: 'bascule', clrO: Infinity }],
    hours: { tz: 'Europe/Amsterdam', week: Array.from({ length: 7 }, () => [['06:00', '22:00']]), holidays: 'sunday', onRequestNight: null } };
  assert.equal(localTime(local(23)).min, 23 * 60);
  const r = scheduleOpen(base, local(23));
  assert.deepEqual({ ok: r.ok, reason: r.reason, next: r.next }, { ok: false, reason: 'hours', next: '06:00' });
  assert.equal(r.tNext, local(30));                                            // 06:00 next morning
  const ww = createWaterworks(null, { bridges: [base], locks: [] }, { now: () => local(23), water: () => 0 });
  const q = ww.request('h', ship('sloop'), 60);
  assert.equal(q.ok, false); assert.equal(q.reason, 'hours'); assert.equal(q.next, '06:00');
  const blocked = { ...base, blocks: [{ days: [1, 2, 3, 4, 5], from: '07:00', to: '09:00', why: 'rush hour' }] };
  const b = scheduleOpen(blocked, local(7, 30));
  assert.equal(b.ok, true); assert.equal(b.tOpen, local(9)); assert.equal(b.why, 'block');
  // night on request: accepted with notice
  const night = { ...base, hours: { ...base.hours, onRequestNight: { from: '22:00', to: '06:00', noticeMin: 60 } } };
  const n = scheduleOpen(night, local(23)); assert.equal(n.ok, true); assert.equal(n.tOpen, local(24)); assert.equal(n.why, 'notice');
});

test('slots: Botlekbrug opens at :15 / :45 only; small craft blocked 06:30–09:30 on weekdays (FIS BERP)', () => {
  const c = scheduleOpen(BOTLEK, local(10, 0));          // remote → 300 s reaction → 10:05 → next slot 10:15
  assert.equal(c.tOpen, local(10, 15));
  const s = scheduleOpen(BOTLEK, local(7, 0), { kind: 'small' });
  assert.equal(s.tOpen, local(9, 45));                   // block to 09:30, next slot 09:45
  assert.equal(scheduleOpen(BOTLEK, local(7, 0), { kind: 'commercial' }).tOpen, local(7, 15));
});

test('8. bundling: ETAs 2 and 5 min ride one opening; a third at 15 min gets the next one', () => {
  let T = 5_000_000;
  const br = { ...syn.bridges[0], id: 'bnd', spans: [{ ...syn.bridges[0].spans[0], mov: 'bascule', clrO: Infinity }] };
  const ww = createWaterworks(null, { bridges: [br], locks: [] }, { now: () => T, water: () => 0 });
  const a = ww.request('bnd', { ...ship('sloop'), id: 'a' }, 120), b = ww.request('bnd', { ...ship('sloop'), id: 'b' }, 300);
  const c = ww.request('bnd', { ...ship('sloop'), id: 'c' }, 900);
  assert.equal(a.tOpen, b.tOpen); assert.deepEqual([a.n, b.n], [1, 2]);
  assert.ok(c.tOpen > a.tOpen); assert.equal(c.n, 3);
  assert.equal(ww._debug.bstate.get('bnd').plans[0].length, 2);
  // a ship that fits under is told so and never queued
  const fit = ww.request('bnd', { ...ship('cruiser', { fold: { arch: 1 } }), id: 'd' }, 60);
  assert.ok(['under', 'tight'].includes(fit.verdict)); assert.equal(fit.n, 0); assert.equal(fit.ok, true);
});

test('9. strikes: sloop under a 12 m fixed bridge → dismast; coaster 2 tiers under 9.0 m at 3 kn → 12 TEU overboard, out 21.6 min, 43 140 cr', () => {
  const sl = strikeOutcome({ cls: 'sloop', sogKn: 4 }, { kind: 'road' }, 12.0);
  assert.equal(sl.dismast, true); assert.equal(sl.part, 'rig'); assert.equal(sl.antennaMul, 0.3);
  const soft = strikeOutcome({ cls: 'sloop', sogKn: 1 }, { kind: 'road' }, 16.8);
  assert.equal(soft.dismast, false); assert.equal(soft.part, 'antenna');
  const co = strikeOutcome({ cls: 'coaster', cargo: [{ good: 'containers', qty: 720 }], fold: DOWN, sogKn: 3 }, { kind: 'road' }, 9.0);
  near(co.overlap, 0.719); assert.equal(co.teuLost, 12); assert.equal(co.cargoLostT, 144); assert.equal(co.pollutionFine, 24000);
  assert.equal(co.part, 'containers'); assert.equal(co.stop, false); assert.ok(co.after.ad < 9.0 && Math.abs(co.after.ad - 7.581) < 0.01);
  assert.equal(co.outMin, 21.6); assert.equal(co.fee, 43140);
  assert.equal(strikeOutcome({ cls: 'coaster', fold: DOWN, ballastT: 600 }, {}, 9.0), null);
});

test('9b. server strikeCheck: hull under the deck → strike, bridge out for everyone (two reds), outage saved', () => {
  let T = 7_000_000;
  const br = { id: 'fx9', name: 'Test bridge', kind: 'road', p: [52.0, 5.0], line: [[52.0, 4.9995], [52.0, 5.0005]], deckW: 12, datum: 'KP', kp: 0,
    spans: [{ id: 0, a: 10, b: 58, mov: 'fixed', clr: 9.0, clrO: null, w: 48, rec: 1 }], vhf: null, call: 'none', blocks: [], hours: null };
  const mov = { ...br, id: 'mv', p: [52.01, 5.0], line: [[52.01, 4.9995], [52.01, 5.0005]], spans: [{ ...br.spans[0], mov: 'bascule', clrO: Infinity }] };
  const ww = createWaterworks(null, { bridges: [br, mov], locks: [] }, { now: () => T, water: () => 0 });
  const events = []; ww.onEvent((e) => events.push(e.type));
  const p = { id: 'p1', ship: { cls: 'coaster', lat: 52.0, lon: 5.0, hdg: 0, spd: 3, fold: DOWN }, cargo: [{ good: 'containers', qty: 720 }], fuel: 80 };
  const s = ww.strikeCheck(p);
  assert.equal(s.id, 'fx9'); assert.equal(s.part, 'containers'); assert.equal(s.fee, 43140);
  assert.equal(ww.state('fx9').out.why, 'bridge strike'); assert.ok(events.includes('strike') && events.includes('out'));
  assert.deepEqual(Object.keys(ww.toSave().outages), ['fx9']);
  // a movable span is out too: requests get "out"
  ww.setOut('mv', T + 600, 'test');
  assert.deepEqual(ww.state('mv').sig[0].lights, ['red', 'red']);
  assert.equal(ww.request('mv', ship('sloop'), 60).reason, 'out');
  T += 601; ww.tick(); assert.equal(ww.state('mv').out, undefined);
  // pier: outside every span along the line
  const pier = ww.strikeCheck({ id: 'p2', ship: { cls: 'sloop', lat: 52.0, lon: 4.99955, hdg: 0, spd: 3 } });
  assert.equal(pier.part, 'pier');
});

test('10. converter v2 helpers: seamark lifting node → {3.6, 24.0, wO 24, mov 2, e 1}; no node → e 2, small canal 2.5; KEEP_TAGS', () => {
  const node = { 'seamark:type': 'bridge', 'seamark:bridge:category': 'lifting', 'seamark:bridge:clearance_height_closed': '3.6', 'seamark:bridge:clearance_height_open': '24.0', 'seamark:bridge:clearance_width': '24.0' };
  const v = bridgeVector({ p: [0, 0, 100, 0], w: 8, k: 'road', cls: 'secondary' }, node);
  assert.deepEqual({ clr: v.clr, clrO: v.clrO, wO: v.wO, mov: v.mov, e: v.e }, { clr: 3.6, clrO: 24.0, wO: 24, mov: MOV_CODE.lift, e: 1 });
  const f = bridgeVector({ p: [0, 0, 100, 0], w: 8, k: 'road', cls: 'secondary' }, null, { waterW: 20 });
  assert.equal(f.e, 2); assert.equal(f.clr, 2.5);
  assert.equal(bridgeVector({ cls: 'motorway' }, null, { waterW: 400 }).clr, 25);
  assert.equal(bridgeVector({ cls: 'motorway' }, null, { waterW: 400, cemt: 'IV' }).clr, 5.25);
  for (const k of ['seamark:bridge:clearance_height_closed', 'seamark:bridge:clearance_height_open', 'seamark:bridge:clearance_width', 'seamark:bridge:category']) assert.ok(WW_KEEP_TAGS.test(k), k);
  assert.equal(seamarkBridge({ maxheight: '4.2', highway: 'primary' }), null);                // road maxheight is not water clearance
  assert.equal(seamarkBridge({ maxheight: '4.2' }, { onWaterway: true }).clr, 4.2);
});
