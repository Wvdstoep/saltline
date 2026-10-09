// Bridges & locks 3D / HUD — pure formatting and state helpers (docs/BRIDGES-LOCKS-VHF-CONTRACT.md §4.3, §4.8, §4.9,
// §5.2, §5.5, §10.2, §10.7.5, lane C): public/js/wwfmt.js + the overlay / ahead queries of wwgeom.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boardText, widthText, gaugeReading, spanFrac, bridgeLights, lampsFor, lockHeadLights, chamberLevel, chamberPhase, levelTimeLocal, levelAtLocal,
  clrNowLocal, verdictLocal, fmtAir, fmtStrip, hoursToday, datumNote, sideViewSvg, lockPlanSvg, normLights, absMs, durS, kindText } from '../public/js/wwfmt.js';
import { overlayStrip, bridgesAhead, buildBridge, undersideAt, anchorOf, llToLocal, LOD3D } from '../public/js/wwgeom.js';

const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;

test('board strings (§10.7.5)', () => {
  assert.equal(boardText({ mov: 'lift', clr: 3.6, clrO: 24 }), '3.6 / 24.0');
  assert.equal(boardText({ mov: 'fixed', clr: 14 }), '14.0');
  assert.equal(boardText({ mov: 'bascule', clr: 3.6, clrO: null }), '3.6 / –');
  assert.equal(boardText({ mov: 'swing', clr: 3.6, clrO: Infinity }), '3.6 / –');
  assert.equal(boardText({ mov: 'fixed', clr: 2.5 }, 2), '≈ 2.5');
  assert.equal(widthText(24), '↔ 24.0');
});

test('gauge reads clrNow rounded down to 0.1 m (§4.3); Botlekbrug 12.8 / 14.8 (§10.2.1)', () => {
  const botlek = { datum: 'NAP', spans: [{ mov: 'lift', clr: 14.0, clrO: 45.0, w: 87 }] };
  assert.ok(near(clrNowLocal(botlek, 0, { h: 1.2 }), 12.8));
  assert.ok(near(clrNowLocal(botlek, 0, { h: -0.8 }), 14.8));
  assert.equal(gaugeReading(12.89), 12.8);
  assert.equal(gaugeReading(12.8), 12.8);
  assert.ok(near(clrNowLocal(botlek, 0, { h: 0, frac: 0.5 }), 29.5), 'lift moves continuously');
  assert.equal(clrNowLocal({ spans: [{ mov: 'bascule', clr: 3.6, clrO: null }] }, 0, { h: 0, frac: 1 }), Infinity);
  assert.ok(near(clrNowLocal({ spans: [{ mov: 'bascule', clr: 3.6, clrO: null }] }, 0, { h: 0, frac: 0.9 }), 3.6), 'bascule = closed until fully open');
});

test('verdicts: coaster at Botlekbrug, sloop and schooner at the Rozenburgsesluis bridge (§10.2.2–4)', () => {
  const botlek = { spans: [{ mov: 'lift', clr: 14.0, clrO: 45.0, w: 87 }] };
  assert.equal(verdictLocal({ ad: 14.924, need: 15.224 }, botlek, 0, { h: 0 }).verdict, 'opening');
  for (const h of [-1.5, 0, 3.0]) assert.equal(verdictLocal({ ad: 7.524, need: 7.824 }, botlek, 0, { h }).verdict, 'under');
  const rzb = { spans: [{ mov: 'lift', clr: 3.6, clrO: 24.0, w: 24 }] };
  assert.equal(verdictLocal({ ad: 17.0 }, rzb, 0, { h: 0 }).verdict, 'opening');
  assert.equal(verdictLocal({ ad: 34.0 }, rzb, 0, { h: 0 }).verdict, 'never');
  assert.equal(verdictLocal({ ad: 34.0 }, { spans: [{ mov: 'lift', clr: 11.7, clrO: 49.7, w: 46 }] }, 0, { h: 0 }).verdict, 'opening');
  const tight = verdictLocal({ ad: 7.524, need: 7.824 }, { spans: [{ mov: 'fixed', clr: 8.5, w: 20 }] }, 0, { h: 0 });
  assert.equal(tight.verdict, 'tight');
  assert.equal(verdictLocal({ ad: 3, B: 24 }, rzb, 0, { h: 0 }).why, 'too wide');
  assert.equal(verdictLocal({ ad: 17.0 }, rzb, 0, { h: 0, frac: 1 }).open, true);
});

test('span motion and BPR lights: red → red+green (t=120) → green (t=262) (§10.2.3, §4.9)', () => {
  const T0 = 1_760_000_000_000;
  const at = (t) => (t < 120 ? { st: 'closed' } : t < 180 ? { st: 'warn', t0: T0 + 120e3, dur: 60 } : t < 262 ? { st: 'opening', t0: T0 + 180e3, dur: 82 } : { st: 'open' });
  const seq = [0, 150, 200, 262].map((t) => bridgeLights({ spanState: at(t), face: 0 }).join('+'));
  assert.deepEqual(seq, ['r', 'r+g', 'r+g', 'g']);
  assert.ok(near(spanFrac({ st: 'opening', t0: T0, dur: 82 }, T0 + 41e3), 0.5));
  assert.equal(spanFrac({ st: 'open' }, T0), 1);
  assert.ok(near(spanFrac({ st: 'closing', t0: T0, dur: 82e3 }, T0 + 20.5e3), 0.75), 'ms durations are accepted');
  assert.deepEqual(bridgeLights({ spanState: { st: 'closed' }, objState: { out: { why: 'strike' } }, face: 0 }), ['rv']);
  assert.deepEqual(bridgeLights({ fixed: true, face: 0 }), ['y']);
  assert.deepEqual(bridgeLights({ fixed: true, narrow: true, face: 0 }), ['y', 'y']);
  assert.deepEqual(bridgeLights({ spanState: { st: 'closed' }, sig: [{ face: 0, lights: ['red', 'green'] }], face: 0 }), ['r', 'g'], 'server sig wins');
  assert.deepEqual(lampsFor(['rv']).map((l) => l.slot), ['L', 'B'], 'out of service: two reds one above the other');
  assert.deepEqual(lampsFor(['r', 'g']), [{ slot: 'L', col: 'r' }, { slot: 'R', col: 'g' }]);
  assert.deepEqual(normLights('rg'), ['r', 'g']);
  assert.equal(absMs(1_760_000_000), 1_760_000_000_000); assert.equal(durS(120000), 120);
});

test('lock: levelling time and level curve (§4.8.4, §10.3.1), head lights (§4.8.3)', () => {
  const A = 7320, mua = 0.7 * A / 400;
  assert.ok(near(levelTimeLocal(A, mua, 1.0), 258, 1));
  assert.ok(near(levelTimeLocal(A, mua, 0.25), 129, 1));
  assert.ok(near(levelAtLocal(A, mua, 1.0, 129), 0.25, 0.01));
  const ch = { st: 'levelling', side: 0, t0: 0, level0: -1.2, level1: 0.6 };
  assert.ok(near(chamberLevel(ch, 0, { A }), -1.2));
  const T = levelTimeLocal(A, mua, 1.8);
  assert.ok(near(chamberLevel(ch, T * 1000, { A }), 0.6));
  assert.ok(near(chamberLevel(ch, (T / 2) * 1000, { A }), 0.6 - 1.8 * 0.25), 'remaining head (1 − ½)²');
  assert.ok(near(chamberLevel({ ...ch, dur: 300 }, 150e3), 0.6 - 1.8 * 0.25), 'server dur wins');
  assert.equal(chamberLevel({ st: 'release', side: 1, level0: -1.2, level1: 0.6 }, 0), 0.6);
  assert.deepEqual(chamberPhase({ st: 'admit:1' }), { st: 'admit', side: 1 });
  assert.deepEqual(lockHeadLights({ st: 'admit', side: 0 }, 0, 'out'), ['g']);
  assert.deepEqual(lockHeadLights({ st: 'admit', side: 0 }, 1, 'out'), ['r']);
  assert.deepEqual(lockHeadLights({ st: 'levelling', side: 0 }, 0, 'out'), ['r']);
  assert.deepEqual(lockHeadLights({ st: 'opening', side: 1 }, 1, 'in'), ['r', 'g']);
  assert.deepEqual(lockHeadLights({ st: 'release', side: 1 }, 1, 'in'), ['g']);
  assert.deepEqual(lockHeadLights({ st: 'standsOpen' }, 0, 'out'), ['g']);
  assert.deepEqual(lockHeadLights({ st: 'idle' }, 0, 'out', true), ['rv']);
});

test('HUD strings: AIR field, strip, hours, datum note', () => {
  assert.equal(fmtAir({ ad: 8.62, T: 4.08 }), 'AIR 8.62 m · draught 4.08 m');
  assert.equal(fmtAir(null), 'AIR —');
  const s = fmtStrip([{ id: 'a', name: 'Brug over de Oude Maas', verdict: 'under', clrNow: 12.8, need: 7.8, dist: 800 },
    { id: 'b', name: 'X', verdict: 'tight', clrNow: 8.5, need: 7.8, dist: 1500 }, { id: 'c', name: 'Botlekbrug', verdict: 'opening', vhf: 18, dist: 3000 }, { id: 'd', name: 'Y', verdict: 'never' }]);
  assert.equal(s.length, 3);
  assert.deepEqual(s.map((c) => c.cls), ['ok', 'tight', 'red']);
  assert.equal(s[0].name, 'Oude Maas'); assert.equal(s[0].text, '12.8 m'); assert.equal(s[2].text, 'opening · ch 18'); assert.equal(s[1].sub, '1.5 km');
  assert.equal(fmtStrip([{ id: 'o', name: 'Z', verdict: 'opening', open: true }])[0].cls, 'ok');
  const wk = { tz: 'Europe/Amsterdam', week: [[['06:00', '22:00']], [['06:00', '22:00']], [['06:00', '22:00']], [['06:00', '22:00']], [['06:00', '22:00']], [['00:00', '24:00']], [['00:00', '24:00']]], onRequestNight: { noticeMin: 60 } };
  assert.equal(hoursToday(wk, Date.UTC(2026, 9, 9, 12)), '06:00–22:00; else on request (60 min notice)');   // Friday
  assert.equal(hoursToday(wk, Date.UTC(2026, 9, 10, 12)), '24 h');                                       // Saturday
  assert.equal(datumNote({ datum: 'NAP' }, { clr: 14.0 }, 1.2, 12.8), '14.0 m above NAP; water +1.2 → 12.8 m');
  assert.equal(kindText({ kind: 'rail', spans: [{ mov: 'lift' }, { mov: 'fixed' }] }), 'lift rail bridge');
});

test('side view and plan SVG are to scale and flag a red need line', () => {
  const red = sideViewSvg({ clrNow: 13.6, clrOpenNow: 44.6, th: 3.5, deckW: 16, mov: 'lift', ship: { ad: 14.92, need: 15.22, L: 90, kind: 'cargo' } });
  assert.match(red, /need 15\.2 m/); assert.match(red, /#ff6b6b/); assert.match(red, /open 44\.6/);
  const green = sideViewSvg({ clrNow: 13.6, th: 3.5, deckW: 16, mov: 'fixed', ship: { ad: 7.52, need: 7.82, L: 90 } });
  assert.match(green, /#4fd18b/); assert.doesNotMatch(green, /#ff6b6b/);
  const plan = lockPlanSvg({ len: 305, wid: 24 }, [{ ship: 'me', x: 40, y: 0.5, L: 11, B: 3.6 }], 'me');
  assert.match(plan, /#f2b134/);
});

test('air-draught overlay: red exactly where the band meets the deck (§5.2)', () => {
  const D2R = Math.PI / 180;
  const line = [[51.9, 4.2], [51.9, 4.2 + 120 / (111320 * Math.cos(51.9 * D2R))]];   // east–west deck line
  const o = { id: 'b', kind: 'road', line, deckW: 12, datum: 'NAP', spans: [{ a: 40, b: 80, mov: 'fixed', clr: 9.0, w: 40, rec: 1 }] };
  const r = buildBridge(o, { lod: LOD3D.MID });
  const an = anchorOf(o), under = (x, z) => undersideAt(r.query, x, z);
  // ship 100 m south of the deck heading north (0°): 200 m band
  const ship = { x: 0, z: 100, hdg: 0, beam: 8, water: 0 };
  const lo = overlayStrip({ ...ship, need: 7.824 }, under, 200, 4);
  const hi = overlayStrip({ ...ship, need: 10.019 }, under, 200, 4);
  assert.equal(lo.red, 0, 'coaster in ballast passes under 9.0');
  assert.ok(hi.red > 0 && near(hi.firstRed, 100 - 6, 4.01), `laden coaster: red from the deck edge (${hi.firstRed})`);
  const ahead = bridgesAhead([o], an.lat - 100 / 110574, an.lon, 0, 5000);
  assert.equal(ahead.length, 1); assert.ok(near(ahead[0].dist, 100, 1)); assert.equal(ahead[0].span, 0);
  assert.equal(bridgesAhead([o], an.lat - 100 / 110574, an.lon, 180, 5000).length, 0, 'not ahead when heading away');
  void llToLocal;
});
