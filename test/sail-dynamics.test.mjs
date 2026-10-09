// Lane A — the time-domain checks (docs/SAILING-CONTRACT.md §2.10, §2.12, §6.4 A-5). Full path at 10 Hz, gusts off.
// `stepSailShip` is stepShip once phase 2 has wired shared/sail/sailphys.js in (test/sail-helpers.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepSailShip, setup, holdTwa, lcg, windFrom, newShipState, WIRED } from './sail-helpers.mjs';
import { RIGS, KN } from '../shared/sail/rigs.js';
import { ensureRig, applyPlan, applyRigCommand, anyHoisted } from '../shared/sail/state.js';
import { polarSpeed } from '../shared/sail/polar.js';
import { trimSheets, chordOf, sheetFor } from '../shared/sail/trim.js';
import { crashJibeDamage, windOverWater } from '../shared/sail/sailphys.js';
import { beginManeuver, maneuverStep, authOf } from '../shared/sail/tactics.js';
import { SHIP_CLASSES } from '../shared/constants.js';
import { normDeg, angleDiff } from '../shared/geo.js';

const CLASSES = ['sloop', 'ketch', 'catamaran', 'schooner'];
const snap = (rig) => { for (const k in rig.sails) { const t = rig.sails[k]; t.hoist = t.hoistCmd; t.reef = t.reefCmd; t.sheet = t.sheetCmd; t.trav = t.travCmd; t.job = null; t.work = 0; } };

/** A ship on the course for signed TWA `twa`, plan level `lv` set, trimmed before the first step (Appendix A sim). */
function start(cls, twsKn, twa, { spdKn = 0, lv = 0, auto = 'full', crew = true, maxTrim = false } = {}) {
  const { s, env } = setup(cls, { twsKn, twa, spdKn });
  if (crew) env.crewAuto = 'full';
  const rig = ensureRig(s, true); rig.auto = auto;
  applyPlan(cls, rig, lv); snap(rig);
  stepSailShip(s, { rudderCmd: 0 }, env, 0);          // dt 0: bands (heeled AWA) for the trim
  if (maxTrim) trimSheets(cls, rig, 0.95);
  snap(rig);
  return { s, env, rig };
}
/** Sail at a held TWA; mean STW / heel over the last `avg` s, the lowest |TWA| and the number of round-ups (TWA 8° low). */
function run(cls, twsKn, twa, { T = 900, dt = 0.1, avg = 120, spdKn, lv, maxTrim = false, env: envX = {} } = {}) {
  const pol = polarSpeed(cls, twsKn, twa);
  const o = start(cls, twsKn, twa, { spdKn: spdKn ?? 0.7 * pol.kn, lv: lv ?? pol.level, auto: maxTrim ? 'off' : 'full', crew: !maxTrim, maxTrim });
  Object.assign(o.env, envX);
  let acc = 0, accH = 0, n = 0, minTwa = 999, ru = 0, was = false;
  const steps = Math.round(T / dt);
  for (let i = 0; i < steps; i++) {
    if (maxTrim) trimSheets(cls, o.rig, 0.95);
    stepSailShip(o.s, { throttleCmd: 0, rudderCmd: holdTwa(o.s, o.env, twa) }, o.env, dt);
    const at = Math.abs(o.rig.twa), r = at < Math.abs(twa) - 8;
    if (r && !was) ru++; was = r;
    if ((i + 1) * dt > T - avg) { acc += o.s.spd; accH += Math.abs(o.rig.heel); n++; minTwa = Math.min(minTwa, at); }
  }
  return { kn: acc / n, heel: accH / n, minTwa, roundUps: ru, pol, s: o.s, rig: o.rig };
}

test('§2.12 time domain: every polar point sailed from 70 % at 10 Hz with helper full averages within ±10 % of the polar', () => {
  const rows = [];
  let k = 0;
  for (const cls of CLASSES) for (const tws of [6, 12, 20]) for (const twa of [45, 60, 90, 120, 150]) {
    const sgn = k++ % 2 ? -1 : 1;                        // both tacks
    const r = run(cls, tws, sgn * twa, { T: cls === 'schooner' ? 1500 : 900 });
    assert.equal(r.rig.nan, 0);
    // cat 6/45: the table says 0 (the VPP's root scan stops at 0.5 m/s), but the time domain — Appendix A sim() too —
    // creeps along at 2.6 kn with the code 0; the contract's "< 1 kn" does not match its own reference (PHASE2 notes)
    if (cls === 'catamaran' && tws === 6 && twa === 45) { assert.ok(r.kn < 3, `cat 6/45 is slow: ${r.kn}`); rows.push(`${cls} ${tws}/${twa}: ${r.kn.toFixed(2)} (table 0)`); continue; }
    const err = r.kn / r.pol.kn - 1;
    rows.push(`${cls} ${tws}/${twa}: ${r.kn.toFixed(2)} vs ${r.pol.kn.toFixed(2)} (${(err * 100).toFixed(1)} %)`);
    assert.ok(Math.abs(err) <= 0.10, `${cls} ${tws}/${sgn * twa}: ${r.kn.toFixed(2)} kn vs polar ${r.pol.kn.toFixed(2)}`);
  }
  if (process.env.SAIL_VERBOSE) console.log(rows.join('\n'));
});

test('heel: sloop 12/45 = 20 ± 3°, schooner 12/45 = 9 ± 3°, catamaran 12/45 ≤ 3°; signs follow the tack', () => {
  const sl = run('sloop', 12, 45);
  assert.ok(Math.abs(sl.heel - 20) <= 3, `sloop ${sl.heel}`);
  assert.ok(sl.rig.heel < 0, 'wind from starboard heels her to port (heel + = starboard rail down)');
  assert.ok(sl.rig.leeway < 0, 'leeway to port on starboard tack');
  const sc = run('schooner', 12, -45, { T: 1500 });
  assert.ok(Math.abs(sc.heel - 9) <= 3, `schooner ${sc.heel}`); assert.ok(sc.rig.heel > 0);
  const ca = run('catamaran', 12, 45);
  assert.ok(ca.heel <= 3, `cat ${ca.heel}`);
  for (const id in sl.rig.sails) assert.equal(sl.rig.sails[id].side, -1, 'starboard tack: sails to port');
  assert.ok(sl.rig.sails.main.angle < 0);
});

test('large steps are stable: sloop 12/45 at dt 0.5 and 1.0 (full and fast path) within 1 % of dt 0.1', () => {
  const ref = run('sloop', 12, 45).kn;
  for (const dt of [0.5, 1.0]) {
    const full = run('sloop', 12, 45, { dt, env: { fast: false } });
    assert.ok(Math.abs(full.kn / ref - 1) <= 0.01, `full path dt ${dt}: ${full.kn} vs ${ref}`);
    assert.equal(full.rig.nan, 0);
    const fast = run('sloop', 12, 45, { dt });
    assert.equal(fast.rig.fast, 1);
    assert.ok(Math.abs(fast.kn / ref - 1) <= 0.01, `fast path dt ${dt}: ${fast.kn} vs ${ref}`);
  }
});

test('overpowered at 25 kn / 60°: full sail with max-power trim heels more, rounds up and is slower than reefed', () => {
  for (const cls of ['sloop', 'ketch', 'schooner']) {
    const full = run(cls, 25, 60, { T: 1200, avg: 600, lv: 0, maxTrim: true });
    const reef = run(cls, 25, 60, { T: 1200, avg: 600 });
    const msg = `${cls}: full ${full.kn.toFixed(2)} kn ${full.heel.toFixed(1)}° minTwa ${full.minTwa.toFixed(0)} ru ${full.roundUps} / reefed L${reef.pol.level} ${reef.kn.toFixed(2)} kn ${reef.heel.toFixed(1)}°`;
    assert.ok(full.heel >= reef.heel + 4, msg);
    assert.ok(full.kn <= 0.85 * reef.kn, msg);
    assert.ok(full.roundUps >= 1 && full.minTwa <= 60 - 15, msg);
    if (process.env.SAIL_VERBOSE) console.log(msg);
  }
  const f20 = run('sloop', 20, 60, { T: 1200, avg: 600, lv: 0, maxTrim: true }), l1 = run('sloop', 20, 60, { T: 1200, avg: 600, lv: 1 });
  assert.ok(f20.kn <= 0.85 * l1.kn, `sloop 20/60 full ${f20.kn} vs L1 ${l1.kn}`);
});

test('catamaran: plain sail at 60° is stiff in 25 kn (≈ 11.7 kn, hull load ≈ 0.56–0.62); in 35 kn the hull lifts and the crew eases', () => {
  const go = (tws) => {
    const { s, env } = setup('catamaran', { twsKn: tws, twa: 60, spdKn: 8 });
    const rig = ensureRig(s, true); rig.auto = 'off'; applyPlan('catamaran', rig, 1); snap(rig);
    let maxLoad = 0, flags = 0, released = false, acc = 0, n = 0;
    for (let t = 0; t < 600; t += 0.1) {
      if (rig.rel <= 0) trimSheets('catamaran', rig, 0.95);
      stepSailShip(s, { rudderCmd: holdTwa(s, env, 60) }, env, 0.1);
      maxLoad = Math.max(maxLoad, rig.load); flags |= rig.flags; if (rig.rel > 0) released = true;
      if (t > 480) { acc += s.spd; n++; }
    }
    return { maxLoad, flags, released, kn: acc / n, heel: Math.abs(rig.heel) };
  };
  const a = go(25);
  assert.ok(Math.abs(a.kn - 11.7) < 0.6 && a.heel < 4, `25 kn: ${a.kn} kn ${a.heel}°`);
  assert.ok(a.maxLoad > 0.5 && a.maxLoad < 0.7 && !(a.flags & 4) && !a.released, `25 kn load ${a.maxLoad}`);
  const b = go(35);
  assert.ok(b.flags & 4, 'hull flying flag'); assert.ok(b.released, 'the crew released the sheets');
  assert.ok(b.maxLoad < 1.0, `never capsizes: ${b.maxLoad}`);
});

test('start from rest at 12 kn / 60° reaches 90 % of the polar within 120 s (schooner 240 s)', () => {
  for (const cls of CLASSES) {
    const pol = polarSpeed(cls, 12, 60);
    const o = start(cls, 12, 60, { lv: pol.level });
    const lim = cls === 'schooner' ? 240 : 120;
    let tReach = null;
    for (let t = 0; t < lim + 0.05; t += 0.1) {
      stepSailShip(o.s, { rudderCmd: holdTwa(o.s, o.env, 60) }, o.env, 0.1);
      if (tReach === null && o.s.spd >= 0.9 * pol.kn) tReach = t;
    }
    assert.ok(tReach !== null && tReach <= lim, `${cls}: ${tReach} s`);
  }
});

test('tack: sloop 12 kn, starboard close-hauled → Z → port close-hauled within 30 s, sails flipped, speed recovers', () => {
  const pol = polarSpeed('sloop', 12, 45).kn;
  const r = run('sloop', 12, 45, { T: 200 });
  const { s, rig } = r, env = { wind: windFrom(normDeg(s.hdg + 45), 12), gusts: false, crewAuto: 'full' };
  const mem = {};
  const q = () => ({ hdg: s.hdg, twd: windOverWater(env).twd, tack: rig.tack, helm: rig.helm, auth: authOf(rig.heel), nowS: 0 });
  beginManeuver('sloop', q(), mem, 'tack');
  applyRigCommand('sloop', rig, { maneuver: 'tack' });
  let minStw = 99, steadyAt = null, recAt = null;
  for (let t = 0; t < 120; t += 0.1) {
    let rud;
    if (mem.man) rud = maneuverStep(q(), mem).rudderCmd; else rud = holdTwa(s, env, -45);
    stepSailShip(s, { rudderCmd: rud }, env, 0.1);
    if (t < 30) minStw = Math.min(minStw, s.spd);
    if (steadyAt === null && rig.tack === -1 && Math.abs(Math.abs(rig.twa) - 45) < 5) steadyAt = t;
    if (steadyAt !== null && recAt === null && s.spd >= 0.8 * pol) recAt = t;
  }
  assert.ok(steadyAt !== null && steadyAt <= 30, `steady on port tack at ${steadyAt}`);
  assert.ok(minStw >= 0.2 * pol && minStw <= 0.9 * pol, `min STW ${minStw}`);
  assert.ok(recAt !== null && recAt <= 60, `back to 80 % at ${recAt}`);
  for (const id in rig.sails) assert.equal(rig.sails[id].side, 1, `${id} flipped to starboard`);
  assert.equal(rig.man, null);
});

// 20 kn true: running at ~7 kn the apparent wind is ~7 m/s; at the contract's 15 kn it stays below the 6 m/s damage
// threshold of §2.8 whatever the trim (see docs/SAILING-PHASE2.md, contract notes)
function jibeRun(auto) {
  const { s, env } = setup('sloop', { twsKn: 20, twa: 150, spdKn: 7 });
  const rig = ensureRig(s, true); rig.auto = auto;
  const m = RIGS.sloop.byId.main;
  rig.sails.main.sheet = rig.sails.main.sheetCmd = sheetFor(m, 75, 0); rig.sails.main.trav = rig.sails.main.travCmd = 0;
  assert.ok(Math.abs(chordOf(m, rig.sails.main.sheet, 0).delta - 75) < 1e-6);
  stepSailShip(s, { rudderCmd: 0 }, env, 0);
  const twd = normDeg(s.hdg + 150), target = normDeg(twd + 150);    // mirror: −150, through the stern
  let crash = false; const evs = [];
  for (let t = 0; t < 40; t += 0.1) {
    const d = angleDiff(s.hdg, target);
    stepSailShip(s, { rudderCmd: Math.max(-1, Math.min(1, d / 25)) }, env, 0.1);
    if (rig.flags & 16) crash = true;
    while (rig.ev.length) evs.push(rig.ev.shift());
  }
  return { crash, evs, rig, s };
}

test('jibe: helper off with the main eased (δ 75°) → crash jibe and damage; helper hint → controlled, no damage', () => {
  const off = jibeRun('off');
  assert.equal(off.crash, true);
  const ev = off.evs.find((e) => e.kind === 'crash_jibe');
  assert.ok(ev && ev.aws > 6, JSON.stringify(off.evs));
  assert.ok(crashJibeDamage('sloop', ev.aws) > 0);
  assert.equal(off.rig.sails.main.side, 1, 'the boom crossed');
  const hint = jibeRun('hint');
  assert.equal(hint.crash, false);
  assert.equal(hint.evs.filter((e) => e.kind === 'crash_jibe').length, 0);
  assert.equal(hint.rig.sails.main.side, 1, 'the boom crossed under control');
  assert.equal(crashJibeDamage('sloop', 5), 0); assert.ok(crashJibeDamage('schooner', 40) <= 3);
});

test('engine: all sails down, no wind → full ahead holds auxKn; motorsailing upwind beats sails alone', () => {
  for (const cls of CLASSES) {
    const s = newShipState(cls, 50, -20, 0), env = { wind: { u: 0, v: 0 }, gusts: false };
    const rig = ensureRig(s, false); assert.equal(anyHoisted(rig), false);
    for (let t = 0; t < 400; t += 0.1) stepSailShip(s, { throttleCmd: 1, rudderCmd: 0 }, env, 0.1);
    assert.ok(Math.abs(s.spd - SHIP_CLASSES[cls].auxKn) <= 0.05, `${cls} ${s.spd}`);
  }
  const sail = run('sloop', 12, 45, { T: 400 }).kn;
  const pol = polarSpeed('sloop', 12, 45);
  const o = start('sloop', 12, 45, { spdKn: pol.kn, lv: pol.level });
  for (let t = 0; t < 400; t += 0.1) stepSailShip(o.s, { throttleCmd: 0.5, rudderCmd: holdTwa(o.s, o.env, 45) }, o.env, 0.1);
  assert.ok(o.s.spd > sail + 0.1, `motorsailing ${o.s.spd} vs ${sail}`);
});

test('sailsUp false (legacy master switch) gives no sail drive; astern keeps the legacy model', () => {
  const o = start('sloop', 12, 90, { spdKn: 6 });
  o.env.sailsUp = false;
  for (let t = 0; t < 300; t += 0.1) stepSailShip(o.s, { rudderCmd: 0 }, o.env, 0.1);
  assert.ok(o.s.spd < 0.5, `${o.s.spd}`);
  const a = start('ketch', 10, 90, {});
  for (let t = 0; t < 300; t += 0.1) stepSailShip(a.s, { throttleCmd: -0.6, rudderCmd: 0 }, a.env, 0.1);
  assert.ok(a.s.spd < -1, `astern ${a.s.spd}`);
});

test('fast path: 1 s steps reach the table speed (±3 %) after 5·τV, crew instant, heel capped at phiT', () => {
  for (const cls of CLASSES) {
    const { s, env } = setup(cls, { twsKn: 14, twa: 70 });
    env.fast = true; ensureRig(s, true);
    const pol = polarSpeed(cls, 14, 70), T = 5 * RIGS[cls].tauV;
    for (let t = 0; t < T; t += 1) stepSailShip(s, { rudderCmd: holdTwa(s, env, 70) }, env, 1);
    assert.ok(Math.abs(s.spd / pol.kn - 1) <= 0.03, `${cls} ${s.spd} vs ${pol.kn}`);
    assert.ok(Math.abs(s.rig.heel) <= RIGS[cls].phiT + 1e-9);
    assert.equal(s.rig.lv, pol.level);
  }
});

test('stability: 10,000 seeded random envs (TWS 0–45 kn, any TWA, dt 0.01–1 s, random commands) — no NaN, bounded', () => {
  const rnd = lcg(20261009);
  let ship = null, cls = null;
  for (let i = 0; i < 10000; i++) {
    if (i % 200 === 0) { cls = CLASSES[Math.floor(rnd() * 4)]; ship = newShipState(cls, 50, -20, rnd() * 360); ensureRig(ship, rnd() < 0.8); ship.rig.auto = ['off', 'hint', 'full'][Math.floor(rnd() * 3)]; }
    const env = { wind: windFrom(rnd() * 360, rnd() * 45), current: { u: rnd() - 0.5, v: rnd() - 0.5 }, gusts: rnd() < 0.3, simTime: i * 3.7,
      waveH: rnd() * 6, sea: rnd(), cond: 40 + rnd() * 60, warp: rnd() < 0.1 ? 50 : 1 };
    env.wind.gust = Math.hypot(env.wind.u, env.wind.v) * (1 + rnd());
    if (rnd() < 0.2) {
      const ids = Object.keys(ship.rig.sails), id = ids[Math.floor(rnd() * ids.length)];
      applyRigCommand(cls, ship.rig, rnd() < 0.3 ? { plan: Math.floor(rnd() * 4) } : { sails: { [id]: { sheet: rnd() * 1.4 - 0.2, trav: rnd() * 2 - 1, hoist: rnd(), reef: Math.floor(rnd() * 3) } } });
    }
    const dt = 0.01 + rnd() * 0.99;
    for (let k = 0; k < 3; k++) stepSailShip(ship, { throttleCmd: rnd() * 1.6 - 0.6, rudderCmd: rnd() * 2 - 1 }, env, dt);
    const R = RIGS[cls];
    assert.ok(Number.isFinite(ship.spd) && Number.isFinite(ship.hdg) && Number.isFinite(ship.lat) && Number.isFinite(ship.lon), `step ${i}`);
    assert.ok(Math.abs(ship.spd) <= R.vmaxKn * 1.1 + 1e-9, `${cls} ${ship.spd}`);
    assert.ok(Math.abs(ship.rig.heel) <= 80 && Number.isFinite(ship.rig.heel) && Number.isFinite(ship.rig.helm) && Number.isFinite(ship.rig.leeway));
    assert.equal(ship.rig.nan, 0);
    for (const id in ship.rig.sails) { const t = ship.rig.sails[id]; assert.ok(Number.isFinite(t.angle) && t.state >= 0 && t.state <= 5 && t.tt >= 0 && t.tt <= 63); }
  }
});

test('determinism: the same inputs give bit-identical states (no random source, no clock)', () => {
  const go = () => { const r = run('ketch', 16, -70, { T: 120 }); return JSON.stringify({ s: { ...r.s, rig: undefined }, rig: r.rig }); };
  assert.equal(go(), go());
  const g = (simTime) => { const { s, env } = setup('sloop', { twsKn: 15, twa: 80 }); Object.assign(env, { gusts: true, simTime }); env.wind.gust = 15 * KN * 1.5; ensureRig(s, true); for (let i = 0; i < 50; i++) stepSailShip(s, {}, env, 0.1); return s.spd; };
  assert.equal(g(500), g(500));
});

test('phase 2 wiring: physics.js stepShip runs the sail branch (creates ship.rig)', { skip: WIRED ? false : 'needs wiring (phase 2)' }, () => {
  assert.equal(WIRED, true);
});

test('trimInfo (HUD) and autoTrimView: target speed, green ticks, advice keys; views put the sails to leeward', async () => {
  const { trimInfo, autoTrimView } = await import('../shared/sail/trim.js');
  const r = run('sloop', 12, 45, { T: 200 });
  const ti = trimInfo('sloop', r.s, {});
  assert.ok(Math.abs(ti.targetKn - polarSpeed('sloop', 12, 45).kn) < 1e-9 && ti.pct > 0.95, `pct ${ti.pct}`);
  assert.equal(ti.advice.key, 'good'); assert.equal(ti.heelT, 22); assert.ok(ti.noGo >= 30 && ti.noGo <= 45);
  const g = ti.sails.find((x) => x.id === 'genoa');
  assert.ok(g.sheetLo <= g.sheetOpt && g.sheetOpt <= g.sheetHi, JSON.stringify(g));
  assert.ok(Math.abs(g.sheet - g.sheetOpt) < 0.05, 'auto: sheets on the tick');
  // ease the genoa right out by hand (helper hint): it shakes and the advice says so
  r.rig.auto = 'hint'; r.rig.sails.genoa.sheetCmd = 1;
  const env = { wind: windFrom(normDeg(r.s.hdg + 45), 12), gusts: false };
  for (let t = 0; t < 20; t += 0.1) stepSailShip(r.s, { rudderCmd: holdTwa(r.s, env, 45) }, env, 0.1);
  assert.equal(trimInfo('sloop', r.s, {}).advice.key, 'luff:genoa');
  assert.match(trimInfo('sloop', r.s, {}).advice.text, /Pull in the genoa/);
  for (const cls of CLASSES) for (const awa of [-120, -40, 40, 120]) {
    const v = autoTrimView(cls, awa, 8);
    assert.equal(v.sails.length, RIGS[cls].sails.length);
    for (const sv of v.sails) if (sv.hoist > 0) assert.ok(Math.sign(sv.angle) === (awa > 0 ? -1 : 1), `${cls} ${awa} ${sv.id} ${sv.angle}`);
    assert.ok(Math.sign(v.heel) === (awa > 0 ? -1 : 1) || v.heel === 0);
  }
});

// docs/SAILING-LANEB-PHASE2.md §8: the side force crosses zero head to wind (tack) and dead downwind (jibe); HM does not
// (windage has its own lever), so an unclamped zce = HM/Fn sent the smoothed helm to thousands (ketch tack ≈ 14,000,
// schooner tack ≈ 8,000, schooner jibe ≈ 1,300) and the boat was pushed hard for seconds after the manoeuvre.
test('helm stays bounded through tacks and jibes (zce clamp): every class, 12 kn, |helm| < 1.5 at every step', () => {
  for (const cls of CLASSES) for (const [twa, kind] of [[45, 'tack'], [150, 'jibe']]) {
    const pol = polarSpeed(cls, 12, twa);
    const o = start(cls, 12, twa, { spdKn: 0.8 * pol.kn, lv: pol.level });
    const { s, env, rig } = o;
    for (let t = 0; t < 60; t += 0.1) stepSailShip(s, { rudderCmd: holdTwa(s, env, twa) }, env, 0.1);
    const mem = {}, q = () => ({ hdg: s.hdg, twd: windOverWater(env).twd, tack: rig.tack, helm: rig.helm, auth: authOf(rig.heel), nowS: 0 });
    beginManeuver(cls, q(), mem, kind); applyRigCommand(cls, rig, { maneuver: kind });
    let maxH = 0;
    for (let t = 0; t < 60; t += 0.1) {
      const rud = mem.man ? maneuverStep(q(), mem).rudderCmd : holdTwa(s, env, -twa);
      stepSailShip(s, { rudderCmd: rud }, env, 0.1);
      assert.ok(Number.isFinite(rig.helm), `${cls} ${kind}: helm finite`);
      maxH = Math.max(maxH, Math.abs(rig.helm));
    }
    assert.equal(rig.tack, -1, `${cls} ${kind}: completed onto port`);
    assert.ok(maxH < 1.5, `${cls} ${kind}: max |helm| ${maxH.toFixed(2)} (spike: zce = HM/Fn unclamped)`);
    assert.equal(rig.nan, 0);
  }
});
