// Lane A — sail aerodynamics (docs/SAILING-CONTRACT.md §2.2–§2.3, §6.4 A-2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RIGS, SAIL_TYPES, D2R } from '../shared/sail/rigs.js';
import { coeffs, aero, apparent, chordOf, trimFor, sheetFor, autoTrimSail, twistFor } from '../shared/sail/aero.js';
import { windOverWater, gustFactor } from '../shared/sail/sailphys.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} vs ${b} ±${tol}`);

test('coeffs: flogging at α ≤ 0, clmax at αs, flat plate at 90°', () => {
  for (const t of Object.keys(SAIL_TYPES)) {
    const T = SAIL_TYPES[t];
    for (const a of [0, -5, -40]) { const c = coeffs(t, a); assert.equal(c.cl, 0); assert.equal(c.st, 2); near(c.cd, 0.10 + T.cd0, 1e-12); }
    const s = coeffs(t, T.as); near(s.cl, T.clmax, 1e-12, t); assert.equal(s.st, 0);
    const l = coeffs(t, 3); assert.equal(l.st, 1); assert.ok(l.cl > 0 && l.cl < coeffs(t, 6).cl);
    const fp = coeffs(t, 90); near(fp.cd, 1.3 + T.cd0, 1e-9, t); near(fp.cl, 0, 1e-9, t); assert.equal(fp.st, 3);
  }
});

test('a sloop genoa sheeted to dmin at AWA 15° is luffing; at AWA 40° with the sheet hard in it stalls (telltales)', () => {
  const rig = RIGS.sloop, g = rig.byId.genoa;
  const c = chordOf(g, 0); assert.equal(c.delta, g.dmin);
  const ss = { genoa: { hoist: 1, furl: 0, reef: 0, delta: c.delta, twist: c.twist } };
  // a true wind giving AWA 15° at the mid band with the boat stopped and upright
  const lo = aero(rig, ss, 6, 15, 0, 0, 0).bands[0];
  assert.ok(lo.state === 1 || lo.state === 2, `not drawing: state ${lo.state}`);
  assert.equal((lo.tt >> 2) & 3, 1, 'middle telltale: windward lifting');
  const hi = aero(rig, ss, 6, 40, 0, 0, 0).bands[0];
  assert.equal((hi.tt >> 2) & 3, 2, 'middle telltale: leeward stalling'); assert.equal(hi.tt & 3, 2, 'bottom telltale stalling');
  assert.ok(hi.alpha > SAIL_TYPES.genoa.as);
  const opt = autoTrimSail(g, hi.be, 0.95 * SAIL_TYPES.genoa.as), tr = trimFor(g, opt.delta);
  const okd = chordOf(g, tr.sheet), good = aero(rig, { genoa: { hoist: 1, furl: 0, reef: 0, delta: okd.delta, twist: okd.twist } }, 6, 40, 0, 0, 0);
  assert.equal((good.bands[0].tt >> 2) & 3, 0, 'green tick → middle telltales streaming');
  assert.ok(good.Fx > aero(rig, ss, 6, 40, 0, 0, 0).Fx, 'easing to the tick drives harder');
});

test('apparent wind: TWS 10 m/s, TWA 90°, V 3 m/s → AWA 73.3°, AWS 10.44 m/s', () => {
  const a = apparent(10, 90, 3, 0, 10);
  near(a.awa, 73.3, 0.2); near(a.aws, 10.44, 0.05);
  // the gradient: higher is windier
  assert.ok(apparent(10, 90, 0, 0, 20).aws > 10 && apparent(10, 90, 0, 0, 3).aws < 10);
});

test('wind over the water: a 1 m/s stream running against the wind adds 1 m/s of true wind at TWA 0', () => {
  const w = windOverWater({ wind: { u: 0, v: -6 } });           // 6 m/s from the north
  near(w.tws, 6, 1e-9); near(w.twd, 0, 1e-9);
  const t = windOverWater({ wind: { u: 0, v: -6 }, current: { u: 0, v: 0.5 }, tideStream: { u: 0, v: 0.5 } });
  near(t.tws, 7, 1e-9, 'against the wind'); near(t.twd, 0, 1e-9);
  const w2 = windOverWater({ wind: { u: 0, v: -6 }, current: { u: 0, v: -1 } });
  near(w2.tws, 5, 1e-9, 'with the wind it takes 1 m/s away');
  const cross = windOverWater({ wind: { u: 0, v: -6 }, current: { u: 1, v: 0 } });
  assert.ok(cross.twd > 0 && cross.twd < 20, 'a cross current veers the wind over the water');
});

test('Kerwin heeled sail plane: AWA 30°, φ 30° → β 26.6°', () => {
  const rig = RIGS.sloop, m = rig.byId.main, c = chordOf(m, 0.2, 0);
  const tws = 8, twa = 30;     // V = 0, no leeway: AWA at each band = TWA = 30°
  const b = aero(rig, { main: { hoist: 1, furl: 0, reef: 0, delta: c.delta, twist: c.twist } }, tws, twa, 0, 0, 30).bands[0];
  near(b.awa, 30, 1e-9); near(b.be, 26.6, 0.05);
  // heel loses drive and heeling force (≈ cos²φ)
  const up = aero(rig, { main: { hoist: 1, furl: 0, reef: 0, delta: c.delta, twist: c.twist } }, tws, 60, 0, 0, 0);
  const h30 = aero(rig, { main: { hoist: 1, furl: 0, reef: 0, delta: c.delta, twist: c.twist } }, tws, 60, 0, 0, 30);
  assert.ok(h30.HM < up.HM);
});

test('sheet / traveller ↔ chord angle round-trips; the traveller drops first; twist opens as the sheet eases', () => {
  for (const cls of Object.keys(RIGS)) for (const s of RIGS[cls].sails) {
    for (const d of [s.dmin, (s.dmin + s.dmax) / 2, s.dmax, 18]) {
      const dd = Math.max(s.dmin, Math.min(s.dmax, d));
      const tr = trimFor(s, dd), c = chordOf(s, tr.sheet, tr.trav);
      near(c.delta, dd, 1e-9, `${cls} ${s.id} δ`);
      near(c.twist, twistFor(s, dd), 1e-9, `${cls} ${s.id} twist = reference twistFor`);
      near(sheetFor(s, dd, tr.trav), tr.sheet, 1e-9);
    }
    if (s.boom) {
      assert.equal(trimFor(s, s.travMax).sheet, 0, `${s.id}: up to travMax the car does it`);
      assert.ok(chordOf(s, 0.8, 0).twist > chordOf(s, 0.2, 0).twist);
      near(chordOf(s, 0, 1).twist, SAIL_TYPES[s.type].tw0, 1e-9, 'moving the car does not open the leech');
    }
  }
});

test('aero: sails down → windage only; furled, reefed and half-hoisted sails drive less', () => {
  const rig = RIGS.sloop;
  const none = aero(rig, {}, 6, 60, 3, 0, 0);
  assert.ok(none.Fx < 0 && none.bands.length === 0);
  const base = (o) => ({ main: { hoist: 1, furl: 0, reef: 0, delta: 20, twist: 8, ...o } });
  const full = aero(rig, base({}), 6, 60, 3, 0, 0).Fx;
  assert.ok(aero(rig, base({ reef: 2 }), 6, 60, 3, 0, 0).Fx < full);
  assert.ok(aero(rig, base({ hoist: 0.5 }), 6, 60, 3, 0, 0).Fx < full);
  assert.ok(aero(rig, base({ mul: 0.4 }), 6, 60, 3, 0, 0).Fx < full, 'crew working on it: drive × 0.4');
  // slatting in light air and a sea
  const calm = aero(rig, base({}), 2.5, 60, 0.5, 0, 0), slat = aero(rig, base({}), 2.5, 60, 0.5, 0, 0, { waveH: 1.2 });
  assert.ok(slat.Fx < calm.Fx && slat.bands[0].state === 1);
});

test('gusts are deterministic, off unless asked, within ±25 % and need a gust ratio', () => {
  const env = { gusts: true, simTime: 1234, wind: { u: 0, v: -10, spd: 10, gust: 16 } };
  const g1 = gustFactor(env, 50.1, -4.2), g2 = gustFactor(env, 50.1, -4.2);
  assert.equal(g1, g2);
  assert.equal(gustFactor({ ...env, gusts: false }, 50, -4), 1);
  assert.equal(gustFactor({ ...env, gusts: undefined }, 50, -4), 1);
  assert.equal(gustFactor({ ...env, wind: { u: 0, v: -10, spd: 10, gust: 9 } }, 50, -4), 1);
  let lo = 2, hi = 0;
  for (let t = 0; t < 600; t += 0.7) { const g = gustFactor({ ...env, simTime: t }, 50, -4); lo = Math.min(lo, g); hi = Math.max(hi, g); }
  assert.ok(lo >= 0.75 && hi <= 1.25 && hi - lo > 0.2, `${lo}…${hi}`);
  void D2R;
});
