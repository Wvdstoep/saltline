// Lane A — hull hydrodynamics and stability (docs/SAILING-CONTRACT.md §2.5–§2.6, §6.4 A-3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RIGS, KN } from '../shared/sail/rigs.js';
import { RM, RMmax, hull, rcalm, froude } from '../shared/sail/hydro.js';

const rel = (a, b, f, msg) => assert.ok(Math.abs(a - b) <= Math.abs(b) * f, `${msg || ''} ${a} vs ${b} ±${f * 100}%`);

test('calm-water resistance upright, no side force (§6.4 A-3)', () => {
  rel(rcalm(RIGS.sloop, 6 * KN), 620, 0.10, 'sloop 6 kn');
  rel(rcalm(RIGS.sloop, 5 * KN), 380, 0.10, 'sloop 5 kn');
  rel(rcalm(RIGS.ketch, 6 * KN), 1030, 0.10, 'ketch 6 kn');
  rel(rcalm(RIGS.schooner, 10 * KN), 16300, 0.10, 'schooner 10 kn');
  // resistance grows with speed for every class (the surge integrator relies on it)
  for (const r of Object.values(RIGS)) { let prev = 0; for (let v = 0.5; v < 20; v += 0.5) { const R = rcalm(r, v * KN); assert.ok(R > prev, `${r.cls} ${v} kn`); prev = R; } }
});

test('Froude 0.40 at 7.57 kn for the sloop (hull speed)', () => {
  assert.ok(Math.abs(froude(RIGS.sloop, 7.57 * KN) - 0.40) < 0.002);
});

test('righting moment: sloop 20° = 6000·9.81·0.502 N·m ±2 %; catamaran max at 5° = 12000·9.81·2.99 ±1 %', () => {
  rel(RM(RIGS.sloop, 20), 6000 * 9.81 * 0.502, 0.02);
  rel(RM(RIGS.catamaran, 5), 12000 * 9.81 * 2.99, 0.01);
  rel(RMmax(RIGS.catamaran), 12000 * 9.81 * 2.99, 0.01);
  assert.ok(RM(RIGS.catamaran, 10) < RM(RIGS.catamaran, 5), 'the cat loses stability once a hull flies');
  for (const c of ['sloop', 'ketch', 'schooner']) { assert.equal(RM(RIGS[c], 0), 0); assert.ok(RM(RIGS[c], 60) > RM(RIGS[c], 20)); assert.ok(RM(RIGS[c], RIGS[c].AVS + 5) < 0); }
});

test('keel stall: leeway ≤ 30° for any side force; more side force → more leeway and induced drag', () => {
  for (const r of Object.values(RIGS)) {
    let prevLam = -1;
    for (const Fs of [0, 100, 1e3, 1e4, 1e5, 1e6, 1e8]) for (const v of [0, 0.5, 3, 6]) {
      const h = hull(r, v, 10, Fs, 0, 0, 5);
      assert.ok(h.lam <= 30 + 1e-9 && h.lam >= 0, `${r.cls} Fs ${Fs} V ${v}: ${h.lam}`);
      assert.ok(Number.isFinite(h.R));
      if (v === 3) { assert.ok(h.lam >= prevLam); prevLam = h.lam; }
    }
    assert.ok(hull(r, 3, 10, 5000, 0, 0, 5).Ri > hull(r, 3, 10, 1000, 0, 0, 5).Ri);
  }
});

test('heel drag and helm: heeling costs speed; heel and drive offset make weather helm', () => {
  const r = RIGS.sloop, V = 3;
  assert.ok(hull(r, V, 30, 0, 0, 0, 5).R > hull(r, V, 0, 0, 0, 0, 5).R * 1.4);
  const upright = hull(r, V, 0, 2000, 0, 1500, 6), heeled = hull(r, V, 25, 2000, 0, 1500, 6);
  assert.equal(upright.Hl, 0); assert.ok(heeled.Hl > 0.2, `H ${heeled.Hl}`);
});
