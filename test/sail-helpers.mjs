// Shared helpers for the Lane A sail tests (not a test file itself). Until phase 2 wires shared/sail/sailphys.js into
// shared/physics.js stepShip, `stepSailShip` runs a faithful copy of stepShip's preamble for sail classes (rudder lag,
// engine telegraph, speed penalty, astern longitudinal model) and then `stepSail`. Once stepShip creates `ship.rig`
// itself (phase 2 done), `stepSailShip` IS stepShip — the tests then exercise the real integration unchanged.
import { stepShip, newShipState, inertiaTau, reversalSeconds, targetFrac, waveSpeedLoss } from '../shared/physics.js';
import { SHIP_CLASSES } from '../shared/constants.js';
import { THROTTLE_MIN, ASTERN_SPEED_FRAC } from '../shared/telegraph.js';
import { stepSail, windOverWater } from '../shared/sail/sailphys.js';
import { angleDiff, normDeg } from '../shared/geo.js';
import { KN } from '../shared/sail/rigs.js';

export { newShipState };

export const WIRED = (() => {
  try { const s = newShipState('sloop', 50, -20, 0); stepShip(s, {}, { wind: { u: 0, v: -6 } }, 0.1); return !!s.rig; } catch { return false; }
})();

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, d) => (Number.isFinite(v) ? v : d);
const LIN = 0.35;
const dragAhead = (u) => (1 - LIN) * u * u + LIN * u;
const K_ASTERN = -THROTTLE_MIN / dragAhead(ASTERN_SPEED_FRAC);
const hullDrag = (u) => (u >= 0 ? dragAhead(u) : -K_ASTERN * dragAhead(-u));
const bollard = (u) => 1 + 0.4 * (1 - Math.min(1, Math.abs(u)));
const ASTERN_RATE = 0.12, TAU_ACCEL = 25, PROP_WALK = 0.08;

function preambleStep(s, input, env, dt) {
  const C = SHIP_CLASSES[s.cls];
  input = input || {}; env = env || {};
  dt = Math.max(0, Math.min(1, num(dt, 0)));
  for (const k of ['lat', 'lon', 'hdg', 'spd', 'throttle', 'rudder']) s[k] = num(s[k], 0);
  const cond = Math.max(0, Math.min(100, num(env.cond, 100))) / 100;
  const flooding = Math.max(0, Math.min(1, num(env.flooding, 0)));
  const loadFrac = Math.max(0, Math.min(1, num(env.loadFrac, 0)));
  const steerPenalty = 1 - 0.6 * (1 - cond) ** 1.5 - 0.5 * flooding;
  const rudderRate = 1 / (1.2 + 3 * (1 - Math.max(0.05, steerPenalty)));
  const rudderCmd = env.fuelEmpty ? 0 : Math.max(-1, Math.min(1, num(input.rudderCmd, 0)));
  const thrCmd = env.fuelEmpty ? 0 : Math.max(THROTTLE_MIN, Math.min(1, num(input.throttleCmd, 0)));
  s.rudder += clamp(rudderCmd - s.rudder, -rudderRate * dt, rudderRate * dt);
  s.engDir = num(s.engDir, 0); s.engStop = num(s.engStop, 0);
  const engDir = s.throttle > 1e-6 ? 1 : s.throttle < -1e-6 ? -1 : 0;
  if (engDir) { s.engDir = engDir; s.engStop = 0; } else s.engStop += dt;
  const thrRate = thrCmd < s.throttle && s.throttle <= 0 ? ASTERN_RATE * (1 - 0.7 * clamp(s.spd / C.maxKn, 0, 1)) : 0.25;
  let thrNext = s.throttle + clamp(thrCmd - s.throttle, -thrRate * dt, thrRate * dt);
  if (engDir && Math.sign(thrNext) === -engDir) thrNext = 0;
  else if (!engDir && thrNext !== 0 && Math.sign(thrNext) === -s.engDir && s.engStop < reversalSeconds(C)) thrNext = 0;
  s.throttle = thrNext; s.throttleCmd = thrCmd; s.rudderCmd = rudderCmd;
  const sea = Math.max(0, Math.min(1, num(env.sea, 0)));
  const waveLoss = waveSpeedLoss(s.hdg, env.waveH, env.waveDir);
  const speedPenalty = Math.max(0.1, 1 - 0.35 * (1 - cond) - 0.5 * flooding - 0.15 * loadFrac - 0.35 * sea * sea - waveLoss) * (env.towing ? (C.towPower ? 0.95 : 0.65) : 1);
  const legacySurge = (ut) => {
    const u0 = s.spd / C.maxKn;
    let u1;
    if (ut >= 0 && u0 >= 0 && u0 < ut) u1 = u0 + (ut - u0) * Math.min(1, dt / TAU_ACCEL);
    else u1 = u0 + (((hullDrag(ut) / bollard(ut)) * bollard(u0) - hullDrag(u0)) / inertiaTau(C)) * dt;
    s.spd = ((ut - u0) * (ut - u1) < 0 ? ut : u1) * C.maxKn;
  };
  const yawExtra = s.throttle < 0 && C.id !== 'catamaran' ? PROP_WALK * C.turnRate * Math.min(1, s.throttle / THROTTLE_MIN) * (1 - 0.5 * Math.min(1, Math.abs(s.spd / C.maxKn) / 0.3)) : 0;
  void targetFrac;
  return stepSail(s, env, dt, { C, speedPenalty, steerPenalty, legacySurge, yawExtra });
}

/** stepShip for a sail class (the real one once phase 2 is wired). */
export function stepSailShip(s, input, env, dt) { return WIRED ? stepShip(s, input, env, dt) : preambleStep(s, input, env, dt); }

/** A wind {u, v} (m/s, blowing TOWARDS) coming FROM `fromDeg` at `kn` knots. */
export function windFrom(fromDeg, kn) { const r = (fromDeg * Math.PI) / 180, ms = kn * KN; return { u: -Math.sin(r) * ms, v: -Math.cos(r) * ms }; }

/** Autopilot-style helm holding a signed TWA (+ = wind from starboard) with the helm feed-forward (§2.7, sign per §2.7 fix). */
export function holdTwa(s, env, twaSigned) {
  const ww = windOverWater(env);
  const want = normDeg(ww.twd - twaSigned);
  const rig = s.rig, tack = rig ? rig.tack : 1, H = rig ? rig.helm : 0;
  const p = Math.abs(rig ? rig.heel : 0), auth = Math.cos((p * Math.PI) / 180) * (1 - 0.7 * sst(30, 50, p));
  return clamp(angleDiff(s.hdg, want) / 25 - (tack * H) / Math.max(auth, 0.2), -1, 1);
}
function sst(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }

/** Seeded LCG in [0, 1). */
export function lcg(seed) { let x = seed >>> 0 || 1; return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; }; }

/** A sail-class ship at sea heading `hdg` with the wind making signed true wind angle `twa` (§2.1) at `twsKn`. */
export function setup(cls, { twsKn = 12, twa = 45, hdg = 0, spdKn = 0 } = {}) {
  const s = newShipState(cls, 50, -20, hdg); s.spd = spdKn;
  const env = { wind: windFrom(normDeg(hdg + twa), twsKn), current: { u: 0, v: 0 }, gusts: false, sailsUp: true };
  return { s, env };
}
