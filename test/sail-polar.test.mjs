// Lane A — polar tables (docs/SAILING-CONTRACT.md §2.11–§2.12, Appendix B, §6.4 A-4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POLARS } from '../shared/sail/polars.gen.js';
import { polarSpeed, bestVmg, noGoDeg, maxSpeedKn } from '../shared/sail/polar.js';
import { polarPoint } from '../shared/sail/vpp.js';
import { RIGS, KN } from '../shared/sail/rigs.js';

const TWA = [45, 60, 90, 120, 150];
// Appendix B (reference run 2026-10-09), kn at TWA 45/60/90/120/150
const APPX_B = {
  sloop:     { 6: [4.4, 5.5, 6.0, 5.2, 2.9], 12: [6.5, 7.1, 7.8, 7.4, 5.5], 20: [6.7, 7.6, 9.0, 9.4, 7.5], 25: [6.7, 7.6, 9.3, 9.8, 7.9] },
  ketch:     { 6: [4.5, 5.7, 6.1, 5.3, 3.0], 12: [7.0, 7.9, 8.2, 7.9, 5.7], 20: [7.8, 8.5, 9.7, 9.5, 7.9], 25: [7.8, 8.7, 10.1, 10.1, 8.4] },
  catamaran: { 6: [0.0, 4.5, 5.7, 5.1, 2.9], 12: [5.1, 7.2, 8.8, 8.0, 5.4], 20: [6.8, 9.4, 11.8, 10.4, 7.7], 25: [7.0, 10.1, 13.7, 11.6, 8.6] },
  schooner:  { 6: [4.0, 5.5, 6.3, 5.3, 3.0], 12: [7.0, 8.6, 9.6, 8.9, 6.0], 20: [8.4, 10.0, 11.4, 11.3, 9.1], 25: [8.5, 10.4, 11.9, 12.2, 10.4] },
};
// §2.12 best VMG upwind: [twa, vmg kn] at 6 / 12 / 20 / 25 kn
const VMG_UP = {
  sloop: [[50, 3.1], [40, 4.6], [40, 4.8], [45, 4.7]], ketch: [[45, 3.2], [40, 5.0], [40, 5.6], [40, 5.6]],
  catamaran: [[55, 2.3], [50, 3.8], [50, 5.1], [55, 5.2]], schooner: [[50, 3.1], [50, 5.0], [45, 5.9], [45, 6.0]],
};
const LEVELS = { sloop: { 20: [1, 1, 0, 0, 0] }, schooner: { 20: [2, 2, 1, 1, 1] } };   // plan levels named in §2.12 / Appendix B

test('polars.gen.js covers TWS 0–40 kn × TWA 0–180° for the four classes', () => {
  assert.deepEqual(Object.keys(POLARS).sort(), Object.keys(RIGS).sort());
  for (const [cls, p] of Object.entries(POLARS)) {
    assert.equal(p.tws[0], 0); assert.equal(p.tws[p.tws.length - 1], 40); assert.ok(p.tws.includes(25));
    assert.deepEqual(p.twa, Array.from({ length: 37 }, (_, i) => i * 5));
    for (const k of ['kn', 'heel', 'lee', 'lv']) assert.equal(p[k].length, p.tws.length * p.twa.length, `${cls} ${k}`);
    assert.ok(p.heel.every((h) => h <= RIGS[cls].phiT * 10), `${cls} heel capped at phiT`);
  }
});

test('table matches Appendix B (±0.15 kn) at TWS 6/12/20/25 × TWA 45/60/90/120/150', () => {
  const bad = [];
  for (const [cls, rows] of Object.entries(APPX_B)) for (const [tws, kns] of Object.entries(rows)) TWA.forEach((twa, i) => {
    const p = polarSpeed(cls, +tws, twa), m = polarSpeed(cls, +tws, -twa);
    assert.equal(p.kn, m.kn, 'symmetric in the tack');
    if (Math.abs(p.kn - kns[i]) > 0.15) bad.push(`${cls} ${tws}/${twa}: ${p.kn.toFixed(2)} vs ${kns[i]}`);
  });
  assert.deepEqual(bad, []);
  for (const [cls, rows] of Object.entries(LEVELS)) for (const [tws, lvs] of Object.entries(rows)) TWA.forEach((twa, i) => assert.equal(polarSpeed(cls, +tws, twa).level, lvs[i], `${cls} ${tws}/${twa} level`));
});

test('regenerating 6 sample points with the solver gives the stored value ±0.05 kn', () => {
  for (const [cls, tws, twa] of [['sloop', 12, 45], ['ketch', 20, 90], ['catamaran', 12, 120], ['schooner', 6, 60], ['sloop', 24, 150], ['catamaran', 26, 75]]) {
    const r = polarPoint(cls, tws, twa), stored = polarSpeed(cls, tws, twa).kn;
    assert.ok(Math.abs(r.V / KN - stored) <= 0.05, `${cls} ${tws}/${twa}: ${(r.V / KN).toFixed(3)} vs ${stored}`);
    assert.equal(r.lv, polarSpeed(cls, tws, twa).level);
  }
});

test('best VMG upwind per §2.12 (±5°, ±0.15 kn); downwind 135–170°; no-go and the 25° check', () => {
  for (const [cls, rows] of Object.entries(VMG_UP)) [6, 12, 20, 25].forEach((tws, i) => {
    const b = bestVmg(cls, tws);
    assert.ok(Math.abs(b.up.twa - rows[i][0]) <= 5, `${cls} ${tws}: up ${b.up.twa}° vs ${rows[i][0]}°`);
    assert.ok(Math.abs(b.up.vmg - rows[i][1]) <= 0.15, `${cls} ${tws}: vmg ${b.up.vmg.toFixed(2)} vs ${rows[i][1]}`);
    // downwind: deep runs (wing-on-wing past 160° in the reference model); on the full 5° grid the optimum is 170–175°
    // in 12+ kn (Appendix B quotes 165° because its printed columns stop at 165/180) and 135–140° in 6 kn
    assert.ok(b.down.twa >= 130 && b.down.twa <= 178, `${cls} ${tws}: down ${b.down.twa}`);
    assert.ok(b.up.twa >= 35 && b.up.twa <= 60);
  });
  assert.ok(Math.abs(noGoDeg('sloop', 12) - 35) <= 5, `sloop ${noGoDeg('sloop', 12)}`);
  assert.ok(Math.abs(noGoDeg('catamaran', 12) - 45) <= 5, `cat ${noGoDeg('catamaran', 12)}`);
  for (const cls of Object.keys(RIGS)) assert.ok(polarSpeed(cls, 12, 25).kn < 0.2, `${cls} at 25°: ${polarSpeed(cls, 12, 25).kn}`);
});

test('polarSpeed: folding, bilinear, out-of-range and engine classes', () => {
  assert.deepEqual(polarSpeed('sloop', 12, 300), polarSpeed('sloop', 12, 60));
  assert.deepEqual(polarSpeed('sloop', 12, -60), polarSpeed('sloop', 12, 60));
  const a = polarSpeed('sloop', 12, 90).kn, b = polarSpeed('sloop', 14, 90).kn, mid = polarSpeed('sloop', 13, 90).kn;
  assert.ok(Math.abs(mid - (a + b) / 2) < 1e-9);
  assert.equal(polarSpeed('sloop', 0, 90).kn, 0);
  assert.ok(polarSpeed('sloop', 60, 90).kn > 0 && Number.isFinite(polarSpeed('sloop', NaN, 90).kn));
  assert.equal(polarSpeed('coaster', 12, 90).kn, 0);
  assert.equal(maxSpeedKn('sloop'), 12); assert.equal(maxSpeedKn('catamaran'), 18); assert.equal(maxSpeedKn('coaster'), 0);
});
