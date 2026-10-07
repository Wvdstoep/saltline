// Deterministic ship kinematics shared by server (plausibility checks, AI boats) and client (simulation).
// Angles in degrees, speeds in knots, positions in lat/lon. dt is REAL seconds; position integration is scaled
// by SIM.MOTION_SCALE (world compression makes this look ~3x real speed).
import { GEO, SIM, SHIP_CLASSES } from './constants.js';
import { normDeg, wrapLon, clampLat } from './geo.js';

const D2R = Math.PI / 180;

export function newShipState(cls, lat, lon, hdg = 0) {
  return { cls, lat, lon, hdg, spd: 0, throttle: 0, rudder: 0, throttleCmd: 0, rudderCmd: 0 };
}

/**
 * @param s ship state (mutated)
 * @param input { throttleCmd (-0.3..1), rudderCmd (-1..1) }
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
  const thrCmd = env.fuelEmpty ? 0 : Math.max(-0.3, Math.min(1, num(input.throttleCmd, 0)));
  s.rudder += clamp((rudderCmd - s.rudder), -rudderRate * dt, rudderRate * dt);
  s.throttle += clamp((thrCmd - s.throttle), -0.25 * dt, 0.25 * dt);
  s.throttleCmd = thrCmd; s.rudderCmd = rudderCmd;

  // Speed follows a first-order lag towards the target.
  const sea = Math.max(0, Math.min(1, num(env.sea, 0)));           // 0 calm .. 1 storm
  const waveLoss = waveSpeedLoss(s.hdg, env.waveH, env.waveDir);
  const speedPenalty = Math.max(0.1, 1 - 0.35 * (1 - cond) - 0.5 * flooding - 0.15 * loadFrac - 0.35 * sea * sea - waveLoss) * (env.towing ? (C.towPower ? 0.95 : 0.65) : 1);
  let target;
  if (C.sail) {
    // Sailing yacht: wind drives the hull through a simple polar; the auxiliary engine adds up to auxKn.
    const sailPower = env.sailsUp === false ? 0 : sailPolar(s.hdg, env.wind);
    const aux = Math.max(-0.3, Math.min(1, s.throttle)) * (C.auxKn || 5);
    target = Math.max(aux, C.maxKn * sailPower) * speedPenalty;
    if (s.throttle < 0) target = aux * speedPenalty;
  } else target = C.maxKn * s.throttle * speedPenalty;
  if (env.grounded) target = 0;
  const tau = Math.abs(target) > Math.abs(s.spd) ? 25 : 45;
  s.spd += (target - s.spd) * Math.min(1, dt / tau);
  if (env.grounded) s.spd *= Math.max(0, 1 - 4 * dt);

  // Yaw: needs steerage way; proportional to speed up to ~half max speed.
  const way = Math.min(1, Math.abs(s.spd) / (0.5 * C.maxKn));
  const yawRate = C.turnRate * s.rudder * way * Math.max(0.15, steerPenalty) * Math.sign(s.spd || 1);
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
