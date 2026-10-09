// VHF range, reception, garbling, dual watch, channel plan, hours, timing (docs/BRIDGES-LOCKS-VHF-CONTRACT.md §6.1–6.2, §10.6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNELS, CH_LIST, horizonKm, rangeKm, reach, garble, hears, effectivePower, stepChannel, applySet, isVoice, replyDelayS,
  inHours, shipAntenna, dirWordOf, inPoly, bars, absMs, hhmm,
} from '../shared/vhf.js';
import { T0, NIGHT } from './vhf-helpers.mjs';

const near = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

test('§10.6.1 range: ship 15 m ↔ bridge 15 m = 31.91 km at 25 W, 11.17 km at 1 W', () => {
  near(rangeKm({ h1: 15, h2: 15, power: 'hi' }), 31.91);
  near(rangeKm({ h1: 15, h2: 15, power: 'lo' }), 11.17);
});
test('§10.6.1 range: sloop (17.0) ↔ coast station (60) = 48.90 km', () => {
  near(horizonKm(shipAntenna(17.0), 60), 48.90);
});
test('§10.6.1 range: two coasters (7.5) on ch 10 inland at 1 W = 7.90 km', () => {
  const p = effectivePower(10, 'hi', true);
  assert.equal(p, 'lo');
  near(rangeKm({ h1: 7.5, h2: 7.5, power: p }), 7.90);
});
test('antenna height is capped at 40 m; damaged antenna × 0.3', () => {
  assert.equal(shipAntenna(75), 40);
  near(rangeKm({ h1: 15, h2: 15, damaged: true }), 31.91 * 0.3, 0.02);
});
test('reach: q = 1 − d/range, q < 0.15 garbled, q ≤ 0 not heard', () => {
  const r = rangeKm({ h1: 15, h2: 15 });
  assert.deepEqual([reach({ dKm: r * 0.5, h1: 15, h2: 15 }).heard, reach({ dKm: r * 0.5, h1: 15, h2: 15 }).garbled], [true, false]);
  assert.equal(reach({ dKm: r * 0.9, h1: 15, h2: 15 }).garbled, true);
  assert.equal(reach({ dKm: r * 1.01, h1: 15, h2: 15 }).heard, false);
});

test('§10.6.2 garbling: q 0.1 → 30 % of letters replaced (deterministic); q 0.5 → clean', () => {
  const s = 'Saltwind, Rozenburgsesluis. Next opening in 5 minutes at 14:25, you are number 1.';
  const letters = [...s].filter((c) => /\p{L}|\p{N}/u.test(c)).length;
  const g = garble(s, 0.1, 'seed');
  assert.equal([...g].filter((c) => c === '·').length, Math.round(letters * 0.3));
  assert.equal(g, garble(s, 0.1, 'seed'));                // same seed → same holes on every client
  assert.notEqual(g, garble(s, 0.1, 'other'));
  assert.equal(garble(s, 0.5, 'seed'), s);
  assert.equal(garble(s, 0, 'seed'), '');
  assert.equal(g.length, s.length);                      // punctuation and spaces untouched
});

test('§10.6.5 dual watch: ch 18 + DW hears 16; without DW does not; tuned channel always', () => {
  assert.equal(hears({ on: true, ch: 18, dual: true }, 16), true);
  assert.equal(hears({ on: true, ch: 18, dual: false }, 16), false);
  assert.equal(hears({ on: true, ch: 18, dual: false }, 18), true);
  assert.equal(hears({ on: true, ch: 18, dual: true }, 13), false);
  assert.equal(hears({ on: false, ch: 16, dual: true }, 16), false);
});

test('channel plan: 16 distress, 70 DSC only (no voice), 13 bridge, 10 inland, 1–28 / 60–88 + NL 31', () => {
  assert.equal(CHANNELS[16].use, 'distress');
  assert.equal(CHANNELS[70].voice, false);
  assert.equal(isVoice(70), false);
  assert.equal(CHANNELS[13].use, 'bridge');
  assert.equal(CHANNELS[10].use, 'ship');
  assert.ok(CH_LIST.includes(1) && CH_LIST.includes(28) && CH_LIST.includes(60) && CH_LIST.includes(88) && CH_LIST.includes(31));
  assert.ok(!CH_LIST.includes(29) && !CH_LIST.includes(59) && !CH_LIST.includes(89));
  for (const ch of [1, 11, 14, 19, 62, 81]) assert.ok(isVoice(ch), `VTS ch ${ch}`);
  assert.equal(CHANNELS[16].duplex, false);
  assert.equal(CHANNELS[24].duplex, true);
});
test('RAINWAT: inland 1 W on ship / nautical-info channels, 16 keeps 25 W; Lo is always 1 W', () => {
  assert.equal(effectivePower(68, 'hi', true), 'lo');
  assert.equal(effectivePower(16, 'hi', true), 'hi');
  assert.equal(effectivePower(68, 'hi', false), 'hi');
  assert.equal(effectivePower(16, 'lo', false), 'lo');
});
test('knob: step skips 70, wraps; applySet refuses 70 and unknown channels', () => {
  assert.equal(stepChannel(69, 1), 71);
  assert.equal(stepChannel(71, -1), 69);
  assert.equal(stepChannel(88, 1), 1);
  assert.equal(stepChannel(1, -1), 88);
  assert.equal(stepChannel(28, 1), 31);
  assert.equal(applySet({ ch: 16 }, { ch: 70 }).ch, 16);
  assert.equal(applySet({ ch: 16 }, { ch: 99 }).ch, 16);
  assert.equal(applySet({ ch: 16 }, { ch: 68, dual: false, power: 'lo' }).ch, 68);
  assert.equal(applySet(null, {}).dual, true);
});
test('operator reply delay 3–8 s, seeded by id and minute', () => {
  for (let m = 0; m < 200; m++) { const d = replyDelayS('fis:rzs', m); assert.ok(d >= 3 && d <= 8, String(d)); }
  assert.equal(replyDelayS('a', 5), replyDelayS('a', 5));
});
test('operating hours in Europe/Amsterdam: 06:00–22:00 open at 14:20, closed at 23:00 with next 06:00', () => {
  const DAY = { tz: 'Europe/Amsterdam', week: Array.from({ length: 7 }, () => [['06:00', '22:00']]) };
  assert.equal(hhmm(T0), '14:20');
  assert.equal(inHours(DAY, T0).open, true);
  const n = inHours(DAY, NIGHT);
  assert.deepEqual([n.open, n.next], [false, '06:00']);
  assert.equal(inHours(null, NIGHT).open, true);
});
test('helpers: dirWord, inPoly, bars, absMs', () => {
  assert.deepEqual([0, 90, 180, 270, 350].map(dirWordOf), ['north', 'east', 'south', 'west', 'north']);
  assert.equal(inPoly([0.5, 0.5], [[0, 0], [0, 1], [1, 1], [1, 0]]), true);
  assert.equal(inPoly([1.5, 0.5], [[0, 0], [0, 1], [1, 1], [1, 0]]), false);
  assert.deepEqual([0, 0.1, 0.3, 0.6, 0.9].map(bars), [0, 1, 2, 3, 4]);
  assert.equal(absMs(60, 1e12), 1e12 + 60000);
  assert.equal(absMs(1.7e9, 0), 1.7e12);
  assert.equal(absMs(1.7e12, 0), 1.7e12);
});
