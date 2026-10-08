// Deterministic ship kinematics shared by server (plausibility checks, AI boats) and client (simulation).
// Angles in degrees, speeds in knots, positions in lat/lon. dt is REAL seconds; position integration is scaled
// by SIM.MOTION_SCALE (world compression makes this look ~3x real speed).
import { GEO, SIM, SHIP_CLASSES } from './constants.js';
import { normDeg, wrapLon, clampLat } from './geo.js';
import { THROTTLE_MIN, ASTERN_SPEED_FRAC } from './telegraph.js';

const D2R = Math.PI / 180;

// ---- Longitudinal dynamics with astern (V5 item 3, engine order telegraph) ----------------------------------------
// u = speed / maxKn. Gathering way ahead keeps the v0.2 feel (first-order lag, 25 s). Everything else — slowing down,
// stopping, going astern, braking sternway — is thrust against hull resistance: mostly quadratic with a linear share at
// low speed; stern-first the hull is much less slippery, so 60 % astern thrust only holds half the ahead speed. The
// propeller thrust is "the force that holds the target speed", a little stronger at low speed (bollard pull), so the
// steady-state speed stays linear in the throttle exactly as before. Inertia (seconds) scales with displacement ·
// speed² / power (capped at 240 s): coaster 75 s, pilot boat 24 s, ferry 180 s. So a coaster losing way with the engine
// stopped drifts ~8 lengths; full astern from full ahead stops her in ~3.3 lengths and ~1.5 min. Reversing the engine
// needs the shaft stopped for a few seconds, and astern power builds up slowly while the propeller still windmills.
const LIN = 0.35;
const dragAhead = (u) => (1 - LIN) * u * u + LIN * u;
const K_ASTERN = -THROTTLE_MIN / dragAhead(ASTERN_SPEED_FRAC);
const hullDrag = (u) => (u >= 0 ? dragAhead(u) : -K_ASTERN * dragAhead(-u));
const BOLLARD = 0.4;
const bollard = (u) => 1 + BOLLARD * (1 - Math.min(1, Math.abs(u)));
const TAU_REF = 75, R_REF = (3200 * 14 * 14) / 0.9, TAU_ACCEL = 25;
const ASTERN_RATE = 0.12;             // throttle units/s while astern power builds up (ahead: 0.25)
const PROP_WALK = 0.08;               // yaw at full astern from rest, as a share of the full-rudder turn rate
const TWIN_SCREW = new Set(['ferry', 'psv', 'tug', 'pilot', 'cruiser', 'myacht', 'superyacht', 'catamaran']);
/** Seconds of inertia for a class (see above). */
export function inertiaTau(C) {
  const disp = Number(C?.displacement) || 3200, kn = Number(C?.maxKn) || 14, burn = Number(C?.burn) || 0.9;
  return Math.max(6, Math.min(240, (TAU_REF * (disp * kn * kn)) / burn / R_REF));
}
/** Seconds the shaft must stand still before the engine runs the other way (gearbox ~2 s … big two-stroke 12 s). */
export function reversalSeconds(C) { return Math.max(1.5, Math.min(12, (Number(C?.length) || 90) / 15)); }
/** Target speed as a fraction of maxKn for a throttle (astern: up to ASTERN_SPEED_FRAC at full astern). */
export function targetFrac(throttle) { return throttle >= 0 ? throttle : -ASTERN_SPEED_FRAC * Math.min(1, throttle / THROTTLE_MIN); }

export function newShipState(cls, lat, lon, hdg = 0) {
  return { cls, lat, lon, hdg, spd: 0, throttle: 0, rudder: 0, throttleCmd: 0, rudderCmd: 0 };
}

/**
 * @param s ship state (mutated)
 * @param input { throttleCmd (THROTTLE_MIN −0.6 … 1), rudderCmd (-1..1) }
 * @param env { cond (0..100), flooding (0..1), loadFrac (0..1), wind {u,v} m/s, current {u,v} m/s, fuelEmpty, grounded,
 *              sea (0..1), towing, sailsUp, tideStream {u,v} m/s (added to the current), waveH (m, significant wave height),
 *              waveDir (deg the waves come FROM; omitted = mixed seas) }
 * @param dt real seconds
 */
const num = (v, d) => (Number.isFinite(v) ? v : d);

/** Speed fraction lost to seas: up to 25 % at 6 m head seas, a third of that running before them. */
export function waveSpeedLoss(hdgDeg, waveH, waveDir) {
  const h = Math.max(0, num(waveH, 0));
  if (h <= 0) return 0;
  let headF = 0.7;                                   // direction unknown: mixed seas
  if (Number.isFinite(waveDir)) { const rel = Math.cos((hdgDeg - waveDir) * D2R); headF = 0.33 + 0.67 * (0.5 + 0.5 * rel); }
  return 0.25 * Math.min(1, h / 6) * headF;
}

export function stepShip(s, input, env, dt) {
  const C = SHIP_CLASSES[s.cls] || SHIP_CLASSES.coaster;
  input = input || {}; env = env || {};
  dt = Math.max(0, Math.min(1, num(dt, 0)));
  for (const k of ['lat', 'lon', 'hdg', 'spd', 'throttle', 'rudder']) s[k] = num(s[k], 0);
  const cond = Math.max(0, Math.min(100, num(env.cond, 100))) / 100;
  const flooding = Math.max(0, Math.min(1, num(env.flooding, 0)));
  const loadFrac = Math.max(0, Math.min(1, num(env.loadFrac, 0)));

  // Actuators follow commands with lag. Steering lag grows as the ship rots.
  const steerPenalty = 1 - 0.6 * (1 - cond) ** 1.5 - 0.5 * flooding; // 1 = crisp
  const rudderRate = 1 / (1.2 + 3 * (1 - Math.max(0.05, steerPenalty)));
  const rudderCmd = env.fuelEmpty ? 0 : Math.max(-1, Math.min(1, num(input.rudderCmd, 0)));
  const thrCmd = env.fuelEmpty ? 0 : Math.max(THROTTLE_MIN, Math.min(1, num(input.throttleCmd, 0)));
  s.rudder += clamp((rudderCmd - s.rudder), -rudderRate * dt, rudderRate * dt);
  // Engine: through zero it stops first; running the other way needs the shaft stopped for reversalSeconds.
  s.engDir = num(s.engDir, 0); s.engStop = num(s.engStop, 0);
  const engDir = s.throttle > 1e-6 ? 1 : s.throttle < -1e-6 ? -1 : 0;
  if (engDir) { s.engDir = engDir; s.engStop = 0; } else s.engStop += dt;
  const thrRate = thrCmd < s.throttle && s.throttle <= 0 ? ASTERN_RATE * (1 - 0.7 * clamp(s.spd / C.maxKn, 0, 1)) : 0.25;
  let thrNext = s.throttle + clamp((thrCmd - s.throttle), -thrRate * dt, thrRate * dt);
  if (engDir && Math.sign(thrNext) === -engDir) thrNext = 0;
  else if (!engDir && thrNext !== 0 && Math.sign(thrNext) === -s.engDir && s.engStop < reversalSeconds(C)) thrNext = 0;
  s.throttle = thrNext;
  s.throttleCmd = thrCmd; s.rudderCmd = rudderCmd;

  // Speed: propeller thrust against hull resistance (see the header of this file); steady state = the target speed.
  const sea = Math.max(0, Math.min(1, num(env.sea, 0)));           // 0 calm .. 1 storm
  const waveLoss = waveSpeedLoss(s.hdg, env.waveH, env.waveDir);
  const speedPenalty = Math.max(0.1, 1 - 0.35 * (1 - cond) - 0.5 * flooding - 0.15 * loadFrac - 0.35 * sea * sea - waveLoss) * (env.towing ? (C.towPower ? 0.95 : 0.65) : 1);
  let ut; // target speed as a fraction of maxKn (signed)
  if (C.sail) {
    // Sailing yacht: wind drives the hull through a simple polar; the auxiliary engine adds up to auxKn.
    const sailPower = env.sailsUp === false ? 0 : sailPolar(s.hdg, env.wind);
    const auxF = (C.auxKn || 5) / C.maxKn;
    ut = (s.throttle < 0 ? targetFrac(s.throttle) * auxF : Math.max(s.throttle * auxF, sailPower)) * speedPenalty;
  } else ut = targetFrac(s.throttle) * speedPenalty;
  if (env.grounded) ut = 0;
  const u0 = s.spd / C.maxKn;
  let u1;
  if (ut >= 0 && u0 >= 0 && u0 < ut) u1 = u0 + (ut - u0) * Math.min(1, dt / TAU_ACCEL);
  else u1 = u0 + (((hullDrag(ut) / bollard(ut)) * bollard(u0) - hullDrag(u0)) / inertiaTau(C)) * dt;
  s.spd = ((ut - u0) * (ut - u1) < 0 ? ut : u1) * C.maxKn;  // never overshoot the target in one step
  if (env.grounded) s.spd *= Math.max(0, 1 - 4 * dt);

  // Yaw: needs steerage way (proportional to speed up to ~half max speed) or propeller wash over the rudder (ahead
  // power at low speed: a "kick ahead"). Going astern the rudder is half as effective and the stern goes the way the
  // wheel is turned. Propeller walk: a right-handed single screw going astern walks the stern to port, so the bow
  // swings to starboard — strongest from rest, half of it once she gathers way (twin screws cancel it).
  const way = Math.min(1, Math.abs(s.spd) / (0.5 * C.maxKn));
  const wash = s.throttle > 0 ? 0.35 * s.throttle * (1 - way) : 0;
  let yawRate = C.turnRate * s.rudder * Math.max(0.15, steerPenalty) * ((s.spd >= 0 ? way : -0.5 * way) + wash);
  if (s.throttle < 0 && !TWIN_SCREW.has(C.id)) yawRate += PROP_WALK * C.turnRate * Math.min(1, s.throttle / THROTTLE_MIN) * (1 - 0.5 * Math.min(1, Math.abs(s.spd / C.maxKn) / 0.3));
  s.hdg = normDeg(s.hdg + yawRate * dt);

  // Velocity in real m/s (east, north).
  const h = s.hdg * D2R;
  const v = s.spd * GEO.KN_TO_MS;
  let ve = Math.sin(h) * v, vn = Math.cos(h) * v;
  if (env.current) { ve += num(env.current.u, 0); vn += num(env.current.v, 0); }
  if (env.tideStream) { ve += num(env.tideStream.u, 0); vn += num(env.tideStream.v, 0); }
  if (env.wind) { ve += 0.02 * num(env.wind.u, 0); vn += 0.02 * num(env.wind.v, 0); }
  if (env.grounded) { ve = 0; vn = 0; }

  const dts = dt * SIM.MOTION_SCALE;
  const k = Math.cos(s.lat * D2R) || 1e-6;
  s.lat = clampLat(s.lat + (vn * dts) / GEO.M_PER_DEG_LAT);
  s.lon = wrapLon(s.lon + (ve * dts) / (GEO.M_PER_DEG_LON_EQ * k));
  return s;
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// Fuel burn in tonnes per SIM hour.
export function fuelBurnPerSimHour(cls, throttle, loadFrac, headwind, cond) {
  const C = SHIP_CLASSES[cls] || SHIP_CLASSES.coaster;
  const t = Math.abs(throttle);
  return C.burn * (0.1 + 0.9 * t ** 3) * (1 + 0.4 * loadFrac) * (1 + 0.3 * Math.max(0, headwind)) *
    (1 + 0.25 * (1 - cond / 100)) * (C.sail && t < 0.05 ? 0 : 1);
}

// Condition loss in points per SIM hour while under way.
export function wearPerSimHour(throttle, windSpeed, wearMul = 1) {
  const t = Math.abs(throttle);
  return (0.15 + 0.6 * t * t + 0.3 * Math.min(2, windSpeed / 20) + (windSpeed > 17 ? 0.8 * Math.min(2, (windSpeed - 17) / 8) : 0)) * wearMul;
}

// Analytic surface current field (m/s, east/north). Coarse but recognisable.
export function currentAt(lat, lon, simTimeSec) {
  const tide = Math.sin(simTimeSec / (6.2 * 3600) * Math.PI * 2); // semi-diurnal tide, +-1
  let u = 0, v = 0;
  if (lat > 48 && lat < 62 && lon > -8 && lon < 14) {
    // North Sea: cyclonic (anticlockwise) gyre about (56N, 3E); Channel: eastward tidal stream; Norwegian coastal current northward.
    const dx = (lon - 3) * Math.cos(56 * D2R), dy = lat - 56;
    const r = Math.hypot(dx, dy) + 0.5;
    u += (-dy / r) * 0.25; v += (dx / r) * 0.25;
    if (lat < 51.5 && lon < 2.5) { u += 0.35 + 0.5 * tide; }
    if (lon > 4 && lat > 57.5) { v += 0.3; }
    u += 0.15 * tide; v += 0.1 * tide;
  } else if (lat > 25 && lat < 45 && lon > -80 && lon < -30) {
    u += 0.6; v += 0.25; // Gulf Stream, crude
  } else if (Math.abs(lat) < 15) {
    u -= 0.3; // equatorial currents westward
  } else if (lat < -40) {
    u += 0.4; // Antarctic circumpolar
  }
  return { u, v };
}

// Sail polar: fraction of hull speed as a function of the true wind angle and strength. No-go zone < 35°.
export function sailPolar(hdgDeg, wind) {
  if (!wind) return 0;
  const spd = Math.hypot(num(wind.u, 0), num(wind.v, 0));
  if (spd < 0.5) return 0;
  const fromDeg = (Math.atan2(-num(wind.u, 0), -num(wind.v, 0)) * 180) / Math.PI; // direction the wind blows FROM
  let a = Math.abs((((hdgDeg - fromDeg) % 360) + 540) % 360 - 180);           // 0 = head to wind, 180 = dead run
  let f;
  if (a < 35) f = 0; else if (a < 60) f = 0.45 + ((a - 35) / 25) * 0.4; else if (a <= 120) f = 0.85 + Math.sin(((a - 60) / 60) * Math.PI) * 0.15; else if (a <= 150) f = 0.85 - ((a - 120) / 30) * 0.1; else f = 0.75 - ((a - 150) / 30) * 0.15;
  const strength = Math.min(1.1, spd / 9) * (spd > 22 ? 0.6 : 1); // reef in a gale
  return f * strength;
}

export function headwindFactor(hdgDeg, wind) {
  // 1 when sailing straight into the wind at 20 m/s, 0 with the wind or in calm.
  const h = hdgDeg * D2R;
  const fe = Math.sin(h), fn = Math.cos(h);
  const spd = Math.hypot(wind.u, wind.v);
  if (spd < 0.01) return 0;
  const dot = (fe * wind.u + fn * wind.v) / spd; // +1 = wind from astern
  return Math.max(0, -dot) * Math.min(1, spd / 20);
}
