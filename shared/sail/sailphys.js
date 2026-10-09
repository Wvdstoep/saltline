// Saltline sailing — the time-domain step for sail classes (docs/SAILING-CONTRACT.md §2.2–§2.10, Appendix A `sim`).
// Called from shared/physics.js stepShip for `C.sail` after the actuators (rudder lag, engine telegraph) and the
// speed-penalty computation; it integrates surge, heel, leeway, helm, yaw and position and writes ship.rig.
// Full path: one aero evaluation per step (dt ≤ 0.25 s). Fast path: polar table (dt > 0.25 s, env.fast, warp > 20×).
// Pure and deterministic: no Math.random, no Date.now; gusts use env.simTime and a position hash.
import { GEO, SIM } from '../constants.js';
import { normDeg, angleDiff, wrapLon, clampLat } from '../geo.js';
import { THROTTLE_MIN, ASTERN_SPEED_FRAC } from '../telegraph.js';
import { rigOf, SAIL_TYPES, D2R, KN, clamp, sstep } from './rigs.js';
import { aero, apparent, chordOf, trimFor, autoTrimSail, windageCalm } from './aero.js';
import { hull, RM, RMmax, rcalm } from './hydro.js';
import { ensureRig, anyHoisted, applyPlan } from './state.js';
import { polarSpeed } from './polar.js';
import { autoTrimStep, HINT_ALPHA } from './trim.js';

export const SUBSTEP_S = 0.05;     // client prediction substep (≤ 20× warp)
export const FAST_DT = 0.25;       // steps longer than this use the fast path
export const FAST_WARP = 20;       // client warp above this uses the fast path (and the crew works instantly)
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Seconds a crew job takes (§3.2): hoist 6 + 0.22·A (lower: half), reef / shake out 15 + 0.25·A. */
export function jobSeconds(s, job) {
  if (job === 'hoist') return 6 + 0.22 * s.A;
  if (job === 'lower') return (6 + 0.22 * s.A) / 2;
  return 15 + 0.25 * s.A;
}
/** Sheet winch rate (fraction per s): clamp(0.35/√(A/30), 0.04, 0.6). */
export const sheetRate = (s) => clamp(0.35 / Math.sqrt(s.A / 30), 0.04, 0.6);
/** Roller furler rate (fraction per s): 1/(4 + 0.12·A). */
export const furlRate = (s) => 1 / (4 + 0.12 * s.A);

/** Condition points lost to a crash jibe (§2.8): min(3, (0.2 + 0.08·(aws − 6))·A_main/30); nothing below 6 m/s. */
export function crashJibeDamage(cls, aws) {
  const R = rigOf(cls); if (!R) return 0;
  const a = clamp(num(aws, 0), 0, 40); if (a < 6) return 0;
  const main = R.byId.main || R.sails.filter((s) => s.boom).sort((x, y) => y.A - x.A)[0];
  return Math.min(3, (0.2 + 0.08 * (a - 6)) * (main ? main.A : 30) / 30);
}

/** True wind over the water (§2.2.1): W = wind − current − tide stream → { u, v, tws (m/s), twd (deg from) }. */
export function windOverWater(env) {
  const w = (env && env.wind) || {}, c = (env && env.current) || {}, t = (env && env.tideStream) || {};
  const u = num(w.u) - num(c.u) - num(t.u), v = num(w.v) - num(c.v) - num(t.v);
  const tws = Math.hypot(u, v);
  return { u, v, tws, twd: tws > 1e-9 ? normDeg(Math.atan2(-u, -v) / D2R) : 0 };
}

// integer hash of the 0.1° cell → three phases (§2.2.2)
function cellPhases(lat, lon) {
  let h = (Math.imul(Math.round(num(lat) * 10) | 0, 73856093) ^ Math.imul(Math.round(num(lon) * 10) | 0, 19349663)) >>> 0;
  const out = [];
  for (let i = 0; i < 3; i++) { h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0; h = Math.imul(h ^ (h >>> 13), 3266489917) >>> 0; h = (h ^ (h >>> 16)) >>> 0; out.push((h / 4294967296) * 2 * Math.PI); }
  return out;
}
/** Gust factor g (§2.2.2) — game only: needs env.gusts === true, env.wind.gust and env.simTime. */
export function gustFactor(env, lat, lon) {
  if (!env || env.gusts !== true || !env.wind) return 1;
  const w = env.wind, spd = num(w.spd, Math.hypot(num(w.u), num(w.v))), gust = num(w.gust, 0);
  if (spd < 0.5 || gust <= spd) return 1;
  const G = clamp(0.5 * (gust / spd - 1), 0, 0.25), t = num(env.simTime, 0), [p1, p2, p3] = cellPhases(lat, lon);
  return 1 + G * (0.55 * Math.sin((2 * Math.PI * t) / 17 + p1) + 0.30 * Math.sin((2 * Math.PI * t) / 41 + p2) + 0.15 * Math.sin((2 * Math.PI * t) / 97 + p3));
}

const rmMaxCache = new Map();
const rmMax = (R) => { let v = rmMaxCache.get(R.cls); if (v === undefined) { v = RMmax(R); rmMaxCache.set(R.cls, v); } return v; };

// ---- crew work (§3.2): jobs in RIGS order (front to back) on `crew` slots, winches and furlers move continuously
function crewWork(R, rig, dt, instant, guard) {
  let busy = 0;
  for (const s of R.sails) if (rig.sails[s.id]?.job) busy++;
  for (const s of R.sails) {
    const t = rig.sails[s.id]; if (!t) continue;
    if (instant) {
      t.hoist = t.hoistCmd; t.reef = t.reefCmd; t.job = null; t.work = 0; t.sheet = t.sheetCmd; t.trav = t.travCmd;
      continue;
    }
    if (s.furl) { const r = furlRate(s) * dt; t.hoist = clamp(t.hoist + clamp(t.hoistCmd - t.hoist, -r, r), 0, 1); }
    if (t.job) {
      t.work -= dt;
      const T = jobSeconds(s, t.job);
      if (t.job === 'hoist') t.hoist = clamp(1 - t.work / T, 0, 1);
      else if (t.job === 'lower') t.hoist = clamp(t.work / T, 0, 1);
      if (t.work <= 0) {
        if (t.job === 'hoist') t.hoist = 1; else if (t.job === 'lower') t.hoist = 0;
        else if (t.job === 'reef') t.reef = Math.min(s.reefs.length, t.reef + 1); else if (t.job === 'shake') t.reef = Math.max(0, t.reef - 1);
        t.job = null; t.work = 0; busy--;
      }
    } else if (!s.furl && t.hoist !== t.hoistCmd) {
      if (busy < R.crew) { t.job = t.hoistCmd > t.hoist ? 'hoist' : 'lower'; t.work = jobSeconds(s, t.job); busy++; }
    } else if (t.reef !== t.reefCmd) {
      if (t.hoist <= 0.001) t.reef = t.reefCmd;           // tie in / shake out on a lowered sail: no hoisted cloth to fight
      else if (busy < R.crew) { t.job = t.reefCmd > t.reef ? 'reef' : 'shake'; t.work = jobSeconds(s, t.job); busy++; }
    }
    const sr = sheetRate(s) * (guard && s.boom ? 3 : 1) * dt;
    t.sheet = clamp(t.sheet + clamp(t.sheetCmd - t.sheet, -sr, sr), 0, 1);
    const tr = 0.5 * dt;
    t.trav = s.boom ? clamp(t.trav + clamp(t.travCmd - t.trav, -tr, tr), -1, 1) : 0;
  }
}

// ---- side flips (§2.8): tacks, jibes (controlled / crash), headsails, topsails follow their gaff sail
function flips(R, rig, tack, awaA, guard) {
  let crash = false;
  const sideOf = {};
  for (const s of R.sails) {
    const t = rig.sails[s.id]; if (!t) continue;
    if (s.follows && sideOf[s.follows]) { t.side = sideOf[s.follows]; sideOf[s.id] = t.side; continue; }
    const up = t.hoist > 0.001;
    if (t.side === tack) {
      if (!up || s.head || awaA < 100) t.side = -tack;
      else if (180 - awaA > 8) {
        const d = chordOf(s, t.sheet, t.trav).delta;
        if (!(Math.abs(d) <= 25 || guard)) crash = true;
        t.side = -tack; rig.jibe = rig.clk;
      }
    }
    sideOf[s.id] = t.side;
  }
  return crash;
}

/** Jibe guard (§2.8): helper hint/full, |awa| > 150, turning through the stern (or Z jibe / already by the lee). */
function jibeGuard(R, rig, tack, awaA, autoLvl) {
  if (autoLvl === 'off' || awaA <= 150) return false;
  let byLee = false;
  for (const s of R.sails) { const t = rig.sails[s.id]; if (s.boom && t && t.hoist > 0.001 && t.side === tack) byLee = true; }
  const active = rig.man === 'jibe' || -tack * rig.yr > 1 || byLee;
  if (!active) return false;
  for (const s of R.sails) {
    const t = rig.sails[s.id]; if (!s.boom || !t) continue;
    const tr = trimFor(s, 15); t.sheetCmd = Math.min(t.sheetCmd, tr.sheet);   // centre the booms (chord ≈ 15°)
  }
  return true;
}

function legacyFallback(s, ut, maxKn, dt) { s.spd += (ut * maxKn - s.spd) * Math.min(1, dt / 25); }
const targetFracAstern = (thr) => (thr >= 0 ? thr : -ASTERN_SPEED_FRAC * Math.min(1, thr / THROTTLE_MIN));

/**
 * One sail step. s = ship state (mutated, s.rig created/repaired), env = stepShip env (+ simTime, gusts, fast, warp,
 * crewAuto), dt real seconds (≤ 1), ctx = { C, speedPenalty, steerPenalty, legacySurge(ut), yawExtra } from stepShip.
 * Integrates s.spd, s.hdg, s.lat, s.lon; writes rig.heel/leeway/helm/awa/aws/twa/tws and per-sail angle/state/tt.
 */
export function stepSail(s, env, dt, ctx = {}) {
  env = env || {};
  const R = rigOf(s.cls); if (!R) return s;
  const rig = ensureRig(s, env.sailsUp);
  const C = ctx.C || {};
  const maxKn = num(C.maxKn, R.vmaxKn * 0.6), auxKn = num(C.auxKn, 5), turn = num(C.turnRate, R.turn);
  const sp = clamp(num(ctx.speedPenalty, 1), 0.1, 1), steer = num(ctx.steerPenalty, 1);
  const legacySurge = typeof ctx.legacySurge === 'function' ? ctx.legacySurge : (ut) => legacyFallback(s, ut, maxKn, dt);
  dt = clamp(num(dt, 0), 0, 1);
  const warp = num(env.warp, 1);
  const fast = env.fast === true || (env.fast !== false && (dt > FAST_DT || warp > FAST_WARP));   // env.fast false forces the full path (tests)
  const autoLvl = env.crewAuto === 'full' || fast ? 'full' : rig.auto;
  const sailsOn = env.sailsUp !== false;
  rig.clk += dt;
  rig.flags = 0;
  if (rig.ev.length > 8) rig.ev.splice(0, rig.ev.length - 8);

  // ---- wind over the water (§2.2)
  const ww = windOverWater(env), g = gustFactor(env, s.lat, s.lon), tws10 = ww.tws * g;
  const twa = ww.tws > 1e-6 ? angleDiff(s.hdg, ww.twd) : 0;
  const prevTack = rig.tack;
  const tack = twa > 0 ? 1 : twa < 0 ? -1 : prevTack;
  const atwa = Math.abs(twa);
  const V0 = num(s.spd) * KN, Vp = Math.max(0, V0);
  const astern = num(s.throttle) < 0 || num(s.spd) < -0.1;
  let lam = -tack * rig.leeway, phi = -tack * rig.heel;              // magnitudes relative to the current tack
  const app = apparent(tws10, atwa, Vp, lam, 10), awaA = Math.abs(app.awa);

  let V = V0, H = rig.helm, flags = 0;
  if (fast) {
    // ---- fast path (§2.10): the crew sets the table's plan level instantly; speed, heel and leeway from the table
    const pol = polarSpeed(s.cls, tws10 / KN, atwa);
    const set = sailsOn && anyHoisted(rig);
    if (set && rig.lv !== pol.level) applyPlan(s.cls, rig, pol.level);
    crewWork(R, rig, dt, true, false);
    const sideOf = {};
    for (const sd of R.sails) {
      const t = rig.sails[sd.id], up = sailsOn && t.hoist > 0.001;
      const { delta } = autoTrimSail(sd, awaA, HINT_ALPHA * SAIL_TYPES[sd.type].as);
      const tr = trimFor(sd, delta);
      t.sheet = t.sheetCmd = tr.sheet; t.trav = t.travCmd = tr.trav;
      t.side = sd.follows && sideOf[sd.follows] ? sideOf[sd.follows] : -tack; sideOf[sd.id] = t.side;
      t.angle = t.side * chordOf(sd, t.sheet, t.trav).delta;
      t.state = up ? (awaA < 20 ? 2 : awaA < 28 ? 1 : 0) : 5; t.tt = 0; t.be = awaA; t.al = undefined;
    }
    const Vs = set ? pol.kn * sp : 0;
    const Ve = num(s.throttle) > 0 ? s.throttle * auxKn * sp : 0;
    if (env.grounded) s.spd *= Math.max(0, 1 - 4 * dt);
    else if (astern) legacySurge(targetFracAstern(num(s.throttle)) * (auxKn / maxKn) * sp);
    else { const Vt = Math.cbrt(Vs ** 3 + Ve ** 3); s.spd = num(s.spd) + (Vt - num(s.spd)) * (1 - Math.exp(-dt / R.tauV)); }
    V = num(s.spd) * KN;
    phi = set ? Math.min(pol.heel, R.phiT) : 0; lam = set ? pol.leeway : 0; H = 0;
    rig.d = 0; rig.load = 0; rig.fast = 1;
  } else {
    rig.fast = 0;
    // ---- full path (§2.10 steps 3–7)
    const guard = jibeGuard(R, rig, tack, awaA, autoLvl);
    if (rig.rel > 0) { rig.rel = Math.max(0, rig.rel - dt); for (const sd of R.sails) { const t = rig.sails[sd.id]; t.sheet = t.sheetCmd = 1; } }
    crewWork(R, rig, dt, warp > FAST_WARP, guard);
    const ss = {};
    if (sailsOn) for (const sd of R.sails) {
      const t = rig.sails[sd.id];
      let h, furl = 0;
      if (sd.furl) { h = t.hoist > 0.001 ? 1 : 0; furl = 1 - t.hoist; } else h = t.hoist;
      if (!(h > 0)) continue;
      const c = chordOf(sd, t.sheet, t.trav);
      ss[sd.id] = { hoist: h, furl, reef: t.reef, delta: c.delta, twist: c.twist, mul: t.job === 'reef' || t.job === 'shake' ? 0.4 : 1 };
    }
    const phiA0 = Math.abs(phi);
    const a = aero(R, ss, tws10, atwa, Vp, lam, phiA0, { waveH: num(env.waveH, 0) });
    // heel: Newton on HM0·cos²φ'/cos²φ = RM(φ'), then the lag (§2.6)
    let pt = Math.max(0, phi);
    const hm0 = a.HM, c0 = Math.max(1e-6, Math.cos(phiA0 * D2R) ** 2);
    for (let k = 0; k < 4; k++) {
      const gg = (hm0 * Math.cos(pt * D2R) ** 2) / c0 - RM(R, pt), dg = ((hm0 * Math.cos((pt + 0.5) * D2R) ** 2) / c0 - RM(R, pt + 0.5) - gg) / 0.5;
      pt = clamp(pt - gg / Math.min(dg, -1), 0, 80);
    }
    phi += (pt - phi) * (1 - Math.exp(-dt / R.tauPhi));
    const phiA = Math.abs(phi);
    // CE height clamped to [0, highest masthead]: when the side force crosses zero (head to wind in a tack, dead downwind
    // in a jibe) HM (windage has its own lever) does not, and HM/Fn → ±∞ spiked the helm to thousands for one step
    // (docs/SAILING-LANEB-PHASE2.md §8). Steady states always have a large Fn, so the polars are unaffected.
    const zce = clamp(a.HM / Math.max(a.Fn, 1e-6) - R.zclr, 0, R.spars.masts.reduce((m, x) => Math.max(m, x.topmast || x.top), 0)), Fs = a.Fn * Math.cos(phiA * D2R);
    const h = hull(R, Vp, phiA, Fs, a.Mz, a.Fx, zce), h2 = hull(R, Vp + 0.05, phiA, Fs, a.Mz, a.Fx, zce);
    lam += (h.lam - lam) * Math.min(1, dt / 1.0);
    // surge, semi-implicit (§2.10 step 7); engine ahead (§2.9); the seaway as a resistance factor 1/sp²
    if (env.grounded) { s.spd = num(s.spd) * Math.max(0, 1 - 4 * dt); V = s.spd * KN; }
    else if (astern) { legacySurge(targetFracAstern(num(s.throttle)) * (auxKn / maxKn) * sp); V = num(s.spd) * KN; }
    else {
      const k = 1 / (sp * sp), m = R.disp * 1000 * 1.08;
      const Ve = (num(s.throttle) > 0 ? s.throttle : 0) * auxKn * sp * KN;
      const Fe = Ve > 0 ? (rcalm(R, Ve) * k + windageCalm(R, Ve)) * (1 + 0.4 * (1 - Math.min(1, Vp / Ve))) : 0;
      V = Math.max(0, Vp + (dt * (a.Fx + Fe - h.R * k)) / (m + dt * Math.max(0, ((h2.R - h.R) * k) / 0.05)));
    }
    H += (h.Hl - H) * Math.min(1, dt / 1.0);
    // auto-trim (helper full) for the next step, from this step's bands
    for (const b of a.bands) { const t = rig.sails[b.id]; t.be = b.be; t.al = b.alpha; t.tt = b.tt; t.state = b.state; }
    if (autoLvl === 'full' && !guard) autoTrimStep(s.cls, rig, { phi: phiA, dt, twsKn: tws10 / KN, twa: atwa });
    // catamaran hull load (§2.6)
    rig.load = R.cat ? Math.max(0, a.HM) / rmMax(R) : 0;
    if (R.cat) {
      if (rig.load >= 0.7) flags |= 4;
      if (rig.load >= 0.85 && rig.rel <= 0) {
        rig.rel = 5;
        if (autoLvl === 'full' && rig.lv < R.plans.length - 1) { applyPlan(s.cls, rig, rig.lv + 1); rig.lvAt = rig.clk; }
      }
      if (rig.load >= 1.0) { rig.over += dt; if (rig.over >= 2) { rig.over = 0; rig.rel = 5; rig.ev.push({ kind: 'strain' }); } } else rig.over = 0;
    }
    // side flips, jibes (§2.8)
    if (flips(R, rig, tack, awaA, guard)) {
      flags |= 16;
      s.hdg = normDeg(num(s.hdg) + tack * 10);
      phi += 8;
      rig.ev.push({ kind: 'crash_jibe', aws: Math.round(app.aws * 10) / 10 });
    }
    if (rig.man === 'jibe' && rig.jibe === rig.clk) rig.man = null;
    for (const sd of R.sails) {
      const t = rig.sails[sd.id], up = sailsOn && t.hoist > 0.001;
      t.angle = t.side * chordOf(sd, t.sheet, t.trav).delta;
      if (!up) { t.state = 5; t.tt = 0; } else if (t.job) t.state = 4;
      if (sd.boom && up && t.side === tack && awaA >= 100 && 180 - awaA >= 5) flags |= 1;
    }
  }

  // ---- guards (§2.10): any non-finite intermediate → keep the previous V (or 0), φ = λ = H = 0
  if (!Number.isFinite(V) || !Number.isFinite(phi) || !Number.isFinite(lam) || !Number.isFinite(H)) {
    rig.nan = (rig.nan || 0) + 1;
    V = Number.isFinite(V0) ? V0 : 0; phi = 0; lam = 0; H = 0;
  }
  s.spd = clamp(V / KN, -0.6 * auxKn, R.vmaxKn * 1.1);
  phi = clamp(phi, -80, 80);
  rig.heel = -tack * phi; rig.leeway = -tack * clamp(lam, -30, 30); rig.helm = H;

  // ---- in irons (§2.7): |awa| < 25° and STW < 1 kn for 3 s → the crew backs the headsail until |awa| > 40°
  if (awaA < 25 && s.spd < 1 && sailsOn && anyHoisted(rig)) { rig.irons += dt; if (rig.irons > 3 && !rig.bk) rig.bk = prevTack; }
  else if (awaA > 40 || s.spd >= 1.5) { rig.irons = 0; rig.bk = 0; }

  // ---- yaw (§2.7): legacy rudder term × authority, plus the weather-helm moment, plus backing in irons
  const phiA = Math.abs(phi);
  const auth = Math.cos(phiA * D2R) * (1 - 0.7 * sstep(30, 50, phiA));
  const way = Math.min(1, Math.abs(s.spd) / (0.5 * maxKn));
  const thr = num(s.throttle), wash = thr > 0 ? 0.35 * thr * (1 - way) : 0;
  let yr = turn * num(s.rudder) * Math.max(0.15, steer) * auth * ((s.spd >= 0 ? way : -0.5 * way) + wash);
  if (!fast) yr += tack * turn * way * clamp(H, -1.5, 1.5);
  if (rig.bk && rig.irons > 3) yr += -rig.bk * 0.12 * turn;
  yr += num(ctx.yawExtra, 0);
  if (tack * yr > 0 && tack * num(s.rudder) <= -0.8) flags |= 2;           // turning to windward against opposite helm
  if (!R.cat && (phiA > R.phiT + 8 || H > 1)) flags |= 8;
  rig.flags = flags;
  rig.yr = yr;
  s.hdg = normDeg(num(s.hdg) + yr * dt);

  // ---- diagnostics for the HUD and rv
  rig.tack = tack; rig.tws = tws10; rig.twa = tack * atwa || 0;
  rig.aws = app.aws; rig.awa = tack * awaA || 0;
  if (rig.man === 'tack' && tack !== prevTack) rig.man = null;
  if (rig.man) { rig.manT += dt; if (rig.manT > 60) { rig.man = null; rig.manT = 0; } }

  // ---- position: through the water along hdg + leeway, plus current and tide; no wind drift (leeway replaces it)
  const crs = (s.hdg + rig.leeway) * D2R, v = s.spd * GEO.KN_TO_MS;
  let ve = Math.sin(crs) * v, vn = Math.cos(crs) * v;
  if (env.current) { ve += num(env.current.u); vn += num(env.current.v); }
  if (env.tideStream) { ve += num(env.tideStream.u); vn += num(env.tideStream.v); }
  if (env.grounded) { ve = 0; vn = 0; }
  const dts = dt * SIM.MOTION_SCALE, kc = Math.cos(num(s.lat) * D2R) || 1e-6;
  s.lat = clampLat(num(s.lat) + (vn * dts) / GEO.M_PER_DEG_LAT);
  s.lon = wrapLon(num(s.lon) + (ve * dts) / (GEO.M_PER_DEG_LON_EQ * kc));
  return s;
}
