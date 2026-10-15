// shared/astro.js - Real-time astronomy for the observer's sky: Sun, Moon, planets, sidereal time, stars.
// Sun: NOAA / Meeus ch. 25 (+ nutation). Moon: Meeus ch. 47 (main periodic terms of ELP-2000/82, ~0.01 deg),
// topocentric parallax (the Moon is up to 1 deg lower than its geocentric place), atmospheric refraction
// (Saemundsson). Planets: JPL Keplerian elements (Standish, valid 1800-2050, arcminute class). Stars: J2000,
// precessed to the date by a matrix the renderer applies to the whole star sphere. Pure functions, no deps; used
// by the client sky (public/js/celestial.js, sky.js) and the HUD, tested in test/astro.test.mjs.
//
// World frame used by Saltline: x = East, y = Up, -z = North. Azimuths are from North clockwise through East.

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const DELTA_T = 69.2;            // TT - UT (s), 2024-2027; the Moon moves 0.5"/s so this matters for eclipses only
const AU_KM = 149597870.7;

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function normDeg(d) { let r = d % 360; if (r < 0) r += 360; return r; }
function normRad(r) { let v = r % (2 * Math.PI); if (v < 0) v += 2 * Math.PI; return v; }
const sinD = (d) => Math.sin(d * D2R), cosD = (d) => Math.cos(d * D2R);

export const julianDay = (unixSeconds) => unixSeconds / 86400 + 2440587.5;
const centuriesTT = (unixSeconds) => (julianDay(unixSeconds + DELTA_T) - 2451545.0) / 36525;

/** Greenwich mean sidereal time (rad), IAU 1982. */
export function gmst(unixSeconds) {
  const jd = julianDay(unixSeconds), t = (jd - 2451545.0) / 36525;
  return normRad((280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * t * t - t * t * t / 38710000) * D2R);
}

/** Local (mean) sidereal time in radians for an observer at longitude lon (deg, East +). */
export function localSiderealTime(lon, unixSeconds) {
  return normRad(gmst(unixSeconds) + lon * D2R);
}

/** Nutation in longitude and obliquity (deg), low-precision (0.5"). */
function nutation(t) {
  const om = (125.04452 - 1934.136261 * t) * D2R;
  const ls = (280.4665 + 36000.7698 * t) * D2R, lm = (218.3165 + 481267.8813 * t) * D2R;
  const dpsi = (-17.20 * Math.sin(om) - 1.32 * Math.sin(2 * ls) - 0.23 * Math.sin(2 * lm) + 0.21 * Math.sin(2 * om)) / 3600;
  const deps = (9.20 * Math.cos(om) + 0.57 * Math.cos(2 * ls) + 0.10 * Math.cos(2 * lm) - 0.09 * Math.cos(2 * om)) / 3600;
  return { dpsi, deps };
}
/** Mean obliquity of the ecliptic (deg). */
function meanObliquity(t) { return 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60; }

/**
 * Atmospheric refraction (deg) to add to a TRUE altitude (deg) to get the apparent one (Saemundsson 1986,
 * 10 C / 1010 hPa). Fades out below -2 deg where there is nothing to see anyway.
 */
export function refraction(altDeg) {
  if (altDeg < -2) return 0;
  const h = Math.max(altDeg, -1.0);
  const r = 1.02 / Math.tan((h + 10.3 / (h + 5.11)) * D2R) / 60;
  return altDeg < -1 ? r * (altDeg + 2) : r;
}

/** RA/Dec (rad) -> horizontal for latitude lat (deg) and local sidereal time lst (rad). Azimuth from N through E. */
function toHorizontal(ra, dec, lat, lst) {
  const h = lst - ra, phi = lat * D2R;
  const sinAlt = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(h);
  const alt = Math.asin(clamp(sinAlt, -1, 1));
  const y = -Math.sin(h) * Math.cos(dec);
  const x = Math.cos(phi) * Math.sin(dec) - Math.sin(phi) * Math.cos(dec) * Math.cos(h);
  return { alt, az: normRad(Math.atan2(y, x)), hourAngle: h };
}
/** Unit direction in Saltline world coordinates (x East, y Up, -z North) from altitude/azimuth (rad). */
export function dirFromAltAz(alt, az) {
  const c = Math.cos(alt);
  return [Math.sin(az) * c, Math.sin(alt), -Math.cos(az) * c];
}
/** Public helper: J2000-or-date RA/Dec (rad) to { alt, az, dir } for an observer (true altitude, no refraction). */
export function equatorialToHorizontal(ra, dec, lat, lon, unixSeconds) {
  const hz = toHorizontal(ra, dec, lat, localSiderealTime(lon, unixSeconds));
  return { alt: hz.alt, az: hz.az, dir: dirFromAltAz(hz.alt, hz.az) };
}
/** Angle (rad) between two unit vectors given as [x,y,z]. */
export function angularSeparation(a, b) {
  return Math.acos(clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1));
}

/** Twilight phase name for a (true or apparent) solar elevation in degrees. */
export function twilightPhase(elevDeg) {
  if (elevDeg > -0.833) return 'day';
  if (elevDeg > -6) return 'civil';
  if (elevDeg > -12) return 'nautical';
  if (elevDeg > -18) return 'astronomical';
  return 'night';
}

// ------------------------------------------------------------------------------------------------- Sun
/** Apparent geocentric ecliptic longitude (deg), distance (AU), true obliquity (deg), RA/Dec (rad) of the Sun. */
export function sunEquatorial(unixSeconds) {
  const t = centuriesTT(unixSeconds);
  const l0 = normDeg(280.46646 + t * (36000.76983 + 0.0003032 * t));
  const m = normDeg(357.52911 + t * (35999.05029 - 0.0001537 * t));
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const c = sinD(m) * (1.914602 - t * (0.004817 + 0.000014 * t)) + sinD(2 * m) * (0.019993 - 0.000101 * t) + sinD(3 * m) * 0.000289;
  const trueLon = l0 + c, v = m + c;
  const R = (1.000001018 * (1 - e * e)) / (1 + e * cosD(v));
  const { dpsi, deps } = nutation(t);
  const lambda = normDeg(trueLon - 0.00569 + dpsi);              // aberration + nutation
  const eps = meanObliquity(t) + deps;
  const ra = normRad(Math.atan2(cosD(eps) * sinD(lambda), cosD(lambda)));
  const dec = Math.asin(clamp(sinD(eps) * sinD(lambda), -1, 1));
  return { lambda, R, eps, ra, dec, t };
}

/**
 * Solar position for observer latitude/longitude (deg) and UTC unix seconds.
 * elev/elevDeg are APPARENT (refracted) - what the eye sees; trueElevDeg is geometric.
 * dir is the unit vector to the Sun in Saltline world coords. day 0..1 is the renderer's daylight factor
 * (0 below about -5.7 deg, 1 above about +12.6 deg), dusk peaks around sunrise/sunset, twilight names the phase.
 */
export function solarPosition(lat, lon, unixSeconds) {
  const s = sunEquatorial(unixSeconds);
  const lst = localSiderealTime(lon, unixSeconds);
  const hz = toHorizontal(s.ra, s.dec, lat, lst);
  const trueElevDeg = hz.alt * R2D;
  const elevDeg = trueElevDeg + refraction(trueElevDeg);
  const elevRad = elevDeg * D2R;
  const azRad = hz.az;
  const dir = dirFromAltAz(elevRad, azRad);
  const day = clamp((elevRad + 0.10) / 0.32, 0, 1);
  const smoothDay = day * day * (3 - 2 * day);
  const dusk = Math.exp(-Math.pow((elevRad - 0.02) / 0.12, 2));
  return {
    elev: elevRad, elevDeg, trueElevDeg, az: azRad, azDeg: azRad * R2D, dir,
    day: smoothDay, dusk, twilight: twilightPhase(trueElevDeg),
    dec: s.dec, ra: s.ra, hourAngle: hz.hourAngle, lambdaRad: s.lambda * D2R, distAU: s.R,
    angDiamDeg: 0.5332 / s.R,
  };
}

// ------------------------------------------------------------------------------------------------ Moon
// Meeus table 47.A: [D, M, M', F, sigmaL (1e-6 deg), sigmaR (1e-3 km)]
const MOON_LR = [
  [0, 0, 1, 0, 6288774, -20905355], [2, 0, -1, 0, 1274027, -3699111], [2, 0, 0, 0, 658314, -2955968],
  [0, 0, 2, 0, 213618, -569925], [0, 1, 0, 0, -185116, 48888], [0, 0, 0, 2, -114332, -3149],
  [2, 0, -2, 0, 58793, 246158], [2, -1, -1, 0, 57066, -152138], [2, 0, 1, 0, 53322, -170733],
  [2, -1, 0, 0, 45758, -204586], [0, 1, -1, 0, -40923, -129620], [1, 0, 0, 0, -34720, 108743],
  [0, 1, 1, 0, -30383, 104755], [2, 0, 0, -2, 15327, 10321], [0, 0, 1, 2, -12528, 0],
  [0, 0, 1, -2, 10980, 79661], [4, 0, -1, 0, 10675, -34782], [0, 0, 3, 0, 10034, -23210],
  [4, 0, -2, 0, 8548, -21636], [2, 1, -1, 0, -7888, 24208], [2, 1, 0, 0, -6766, 30824],
  [1, 0, -1, 0, -5163, -8379], [1, 1, 0, 0, 4987, -16675], [2, -1, 1, 0, 4036, -12831],
  [2, 0, 2, 0, 3994, -10445], [4, 0, 0, 0, 3861, -11650], [2, 0, -3, 0, 3665, 14403],
  [0, 1, -2, 0, -2689, -7003], [2, 0, -1, 2, -2602, 0], [2, -1, -2, 0, 2390, 10056],
  [1, 0, 1, 0, -2348, 6322], [2, -2, 0, 0, 2236, -9884], [0, 1, 2, 0, -2120, 5751],
  [0, 2, 0, 0, -2069, 0], [2, -2, -1, 0, 2048, -4950], [2, 0, 1, -2, -1773, 4130],
  [2, 0, 0, 2, -1595, 0], [4, -1, -1, 0, 1215, -3958], [0, 0, 2, 2, -1110, 0],
  [3, 0, -1, 0, -892, 3258], [2, 1, 1, 0, -810, 2616], [4, -1, -2, 0, 759, -1897],
  [0, 2, -1, 0, -713, -2117], [2, 2, -1, 0, -700, 2354], [2, 1, -2, 0, 691, 0],
  [2, -1, 0, -2, 596, 0], [4, 0, 1, 0, 549, -1423], [0, 0, 4, 0, 537, -1117],
  [4, -1, 0, 0, 520, -1571], [1, 0, -2, 0, -487, -1739], [2, 1, 0, -2, -399, 0],
  [0, 0, 2, -2, -381, -4421], [1, 1, 1, 0, 351, 0], [3, 0, -2, 0, -340, 0],
  [4, 0, -3, 0, 330, 0], [2, -1, 2, 0, 327, 0], [0, 2, 1, 0, -323, 1165],
  [1, 1, -1, 0, 299, 0], [2, 0, 3, 0, 294, 0], [2, 0, -1, -2, 0, 8752],
];
// Meeus table 47.B: [D, M, M', F, sigmaB (1e-6 deg)]
const MOON_B = [
  [0, 0, 0, 1, 5128122], [0, 0, 1, 1, 280602], [0, 0, 1, -1, 277693], [2, 0, 0, -1, 173237],
  [2, 0, -1, 1, 55413], [2, 0, -1, -1, 46271], [2, 0, 0, 1, 32573], [0, 0, 2, 1, 17198],
  [2, 0, 1, -1, 9266], [0, 0, 2, -1, 8822], [2, -1, 0, -1, 8216], [2, 0, -2, -1, 4324],
  [2, 0, 1, 1, 4200], [2, 1, 0, -1, -3359], [2, -1, -1, 1, 2463], [2, -1, 0, 1, 2211],
  [2, -1, -1, -1, 2065], [0, 1, -1, -1, -1870], [4, 0, -1, -1, 1828], [0, 1, 0, 1, -1794],
  [0, 0, 0, 3, -1749], [0, 1, -1, 1, -1565], [1, 0, 0, 1, -1491], [0, 1, 1, 1, -1475],
  [0, 1, 1, -1, -1410], [0, 1, 0, -1, -1344], [1, 0, 0, -1, -1335], [0, 0, 3, 1, 1107],
  [4, 0, 0, -1, 1021], [4, 0, -1, 1, 833],
];

/** Geocentric apparent ecliptic longitude/latitude (deg), distance (km) and RA/Dec (rad) of the Moon. */
export function moonEquatorial(unixSeconds) {
  const t = centuriesTT(unixSeconds), t2 = t * t, t3 = t2 * t, t4 = t3 * t;
  const Lp = normDeg(218.3164477 + 481267.88123421 * t - 0.0015786 * t2 + t3 / 538841 - t4 / 65194000);
  const D = normDeg(297.8501921 + 445267.1114034 * t - 0.0018819 * t2 + t3 / 545868 - t4 / 113065000);
  const M = normDeg(357.5291092 + 35999.0502909 * t - 0.0001536 * t2 + t3 / 24490000);
  const Mp = normDeg(134.9633964 + 477198.8675055 * t + 0.0087414 * t2 + t3 / 69699 - t4 / 14712000);
  const F = normDeg(93.2720950 + 483202.0175233 * t - 0.0036539 * t2 - t3 / 3526000 + t4 / 863310000);
  const A1 = 119.75 + 131.849 * t, A2 = 53.09 + 479264.290 * t, A3 = 313.45 + 481266.484 * t;
  const E = 1 - 0.002516 * t - 0.0000074 * t2;
  let sl = 0, sr = 0, sb = 0;
  for (const [d, m, mp, f, l, r] of MOON_LR) {
    const arg = (d * D + m * M + mp * Mp + f * F) * D2R, ef = m === 0 ? 1 : Math.abs(m) === 1 ? E : E * E;
    sl += l * ef * Math.sin(arg); sr += r * ef * Math.cos(arg);
  }
  for (const [d, m, mp, f, b] of MOON_B) {
    const arg = (d * D + m * M + mp * Mp + f * F) * D2R, ef = m === 0 ? 1 : Math.abs(m) === 1 ? E : E * E;
    sb += b * ef * Math.sin(arg);
  }
  sl += 3958 * sinD(A1) + 1962 * sinD(Lp - F) + 318 * sinD(A2);
  sb += -2235 * sinD(Lp) + 382 * sinD(A3) + 175 * sinD(A1 - F) + 175 * sinD(A1 + F) + 127 * sinD(Lp - Mp) - 115 * sinD(Lp + Mp);
  const { dpsi, deps } = nutation(t);
  const lambda = normDeg(Lp + sl / 1e6 + dpsi), beta = sb / 1e6, distKm = 385000.56 + sr / 1000;
  const eps = (meanObliquity(t) + deps) * D2R, lr = lambda * D2R, br = beta * D2R;
  const ra = normRad(Math.atan2(Math.sin(lr) * Math.cos(eps) - Math.tan(br) * Math.sin(eps), Math.cos(lr)));
  const dec = Math.asin(clamp(Math.sin(br) * Math.cos(eps) + Math.cos(br) * Math.sin(eps) * Math.sin(lr), -1, 1));
  return { lambda, beta, distKm, ra, dec };
}

function moonTopocentric(lat, lon, unixSeconds, mq) {
  const hz = toHorizontal(mq.ra, mq.dec, lat, localSiderealTime(lon, unixSeconds));
  const par = Math.asin(6378.14 / mq.distKm);                  // horizontal parallax (rad)
  const alt = hz.alt - par * Math.cos(hz.alt);                  // the observer sits 1 Earth radius off-centre
  return { alt, az: hz.az, hourAngle: hz.hourAngle, par };
}

/**
 * Moon for observer (lat, lon deg) at UTC unixSeconds: topocentric apparent position, phase and illumination.
 * phase: 0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter (from the elongation in ecliptic longitude).
 * illumination: illuminated fraction of the disc from the true Sun-Moon-Earth phase angle.
 * limbAngle: position angle of the bright limb (rad, from celestial North through East) - Meeus 48.5.
 */
export function lunarPosition(lat, lon, unixSeconds, _sunLambdaRad = null) {
  const mq = moonEquatorial(unixSeconds);
  const sq = sunEquatorial(unixSeconds);
  const top = moonTopocentric(lat, lon, unixSeconds, mq);
  const trueElevDeg = top.alt * R2D;
  const elevDeg = trueElevDeg + refraction(trueElevDeg);
  const elevRad = elevDeg * D2R;
  const dir = dirFromAltAz(elevRad, top.az);
  // phase angle i: Sun-Moon-Earth (Meeus 48.2/48.3)
  const cosPsi = Math.cos(mq.beta * D2R) * cosD(mq.lambda - sq.lambda);
  const psi = Math.acos(clamp(cosPsi, -1, 1));
  const Rkm = sq.R * AU_KM;
  const i = Math.atan2(Rkm * Math.sin(psi), mq.distKm - Rkm * Math.cos(psi));
  const illum = (1 + Math.cos(i)) / 2;
  const elong = normDeg(mq.lambda - sq.lambda);
  const phaseFrac = elong / 360;
  let phaseName;
  if (phaseFrac < 0.0339 || phaseFrac > 0.9661) phaseName = 'New Moon';
  else if (phaseFrac < 0.2161) phaseName = 'Waxing Crescent';
  else if (phaseFrac < 0.2839) phaseName = 'First Quarter';
  else if (phaseFrac < 0.4661) phaseName = 'Waxing Gibbous';
  else if (phaseFrac < 0.5339) phaseName = 'Full Moon';
  else if (phaseFrac < 0.7161) phaseName = 'Waning Gibbous';
  else if (phaseFrac < 0.7839) phaseName = 'Last Quarter';
  else phaseName = 'Waning Crescent';
  const dra = sq.ra - mq.ra;
  const limbAngle = normRad(Math.atan2(Math.cos(sq.dec) * Math.sin(dra),
    Math.sin(sq.dec) * Math.cos(mq.dec) - Math.cos(sq.dec) * Math.sin(mq.dec) * Math.cos(dra)));
  return {
    elev: elevRad, elevDeg, trueElevDeg, az: top.az, azDeg: top.az * R2D, dir,
    phase: phaseFrac, illumination: illum, phaseAngle: i, phaseName, limbAngle,
    ra: mq.ra, dec: mq.dec, distKm: mq.distKm,
    angDiamDeg: 2 * Math.asin(1737.4 / mq.distKm) * R2D,
  };
}

// --------------------------------------------------------------------------------------- rise and set
function sunTrueAlt(lat, lon, u) { const s = sunEquatorial(u); return toHorizontal(s.ra, s.dec, lat, localSiderealTime(lon, u)).alt * R2D; }
function moonTrueAlt(lat, lon, u) { const m = moonEquatorial(u); return moonTopocentric(lat, lon, u, m).alt * R2D; }

function crossings(f, h0, t0, hours) {
  const out = { rise: null, set: null };
  const step = 600;
  let ta = t0, fa = f(ta) - h0;
  for (let k = 1; k <= (hours * 3600) / step; k++) {
    const tb = t0 + k * step, fb = f(tb) - h0;
    if ((fa < 0) !== (fb < 0)) {
      let lo = ta, hi = tb, flo = fa;
      for (let j = 0; j < 30 && hi - lo > 1; j++) {
        const mid = (lo + hi) / 2, fm = f(mid) - h0;
        if ((fm < 0) === (flo < 0)) { lo = mid; flo = fm; } else hi = mid;
      }
      const tc = (lo + hi) / 2;
      if (fa < 0 && out.rise === null) out.rise = tc;
      if (fa >= 0 && out.set === null) out.set = tc;
    }
    ta = tb; fa = fb;
  }
  return out;
}
/** First sunrise and sunset (unix s) in the 24 h after t0 (null = none: polar day/night). Upper limb + refraction. */
export function sunRiseSet(lat, lon, t0) { return crossings((u) => sunTrueAlt(lat, lon, u), -0.833, t0, 24); }
/** First moonrise and moonset (unix s) in the 24 h after t0 (topocentric upper limb + refraction). */
export function moonRiseSet(lat, lon, t0) { return crossings((u) => moonTrueAlt(lat, lon, u), -0.5667 - 0.259, t0, 24); }

// ---------------------------------------------------------------------------------------------- stars
/**
 * Bright stars, J2000 RA/Dec (deg), visual magnitude, colour tint (from B-V). Navigation stars + the stars that
 * draw the well-known constellations. The renderer fills the rest of the sky procedurally down to mag 6.5.
 */
export const BRIGHT_STARS = [
  { name: 'Polaris', ra: 37.95, dec: 89.26, mag: 1.98, col: 0xfff2dd },
  { name: 'Sirius', ra: 101.29, dec: -16.72, mag: -1.46, col: 0xd8e6ff },
  { name: 'Canopus', ra: 95.99, dec: -52.70, mag: -0.74, col: 0xf6f4ee },
  { name: 'Alpha Centauri', ra: 219.90, dec: -60.83, mag: -0.27, col: 0xfff0d4 },
  { name: 'Arcturus', ra: 213.92, dec: 19.18, mag: -0.05, col: 0xffcf96 },
  { name: 'Vega', ra: 279.23, dec: 38.78, mag: 0.03, col: 0xe2ebff },
  { name: 'Capella', ra: 79.17, dec: 46.00, mag: 0.08, col: 0xfff0c8 },
  { name: 'Rigel', ra: 78.63, dec: -8.20, mag: 0.13, col: 0xd2e0ff },
  { name: 'Procyon', ra: 114.83, dec: 5.22, mag: 0.34, col: 0xfff6e8 },
  { name: 'Achernar', ra: 24.43, dec: -57.24, mag: 0.46, col: 0xd0deff },
  { name: 'Betelgeuse', ra: 88.79, dec: 7.41, mag: 0.50, col: 0xffb27a },
  { name: 'Hadar', ra: 210.96, dec: -60.37, mag: 0.61, col: 0xd4e2ff },
  { name: 'Altair', ra: 297.70, dec: 8.87, mag: 0.76, col: 0xf2f4ff },
  { name: 'Acrux', ra: 186.65, dec: -63.10, mag: 0.77, col: 0xd2e0ff },
  { name: 'Aldebaran', ra: 68.98, dec: 16.51, mag: 0.85, col: 0xffbe86 },
  { name: 'Antares', ra: 247.35, dec: -26.43, mag: 0.96, col: 0xffa874 },
  { name: 'Spica', ra: 201.30, dec: -11.16, mag: 0.98, col: 0xd2e0ff },
  { name: 'Pollux', ra: 116.33, dec: 28.03, mag: 1.14, col: 0xffdcae },
  { name: 'Fomalhaut', ra: 344.41, dec: -29.62, mag: 1.16, col: 0xeef2ff },
  { name: 'Deneb', ra: 310.36, dec: 45.28, mag: 1.25, col: 0xeef2ff },
  { name: 'Mimosa', ra: 191.93, dec: -59.69, mag: 1.25, col: 0xd2e0ff },
  { name: 'Regulus', ra: 152.09, dec: 11.97, mag: 1.35, col: 0xdce6ff },
  { name: 'Adhara', ra: 104.66, dec: -28.97, mag: 1.50, col: 0xd6e2ff },
  { name: 'Castor', ra: 113.65, dec: 31.89, mag: 1.58, col: 0xeef2ff },
  { name: 'Shaula', ra: 263.40, dec: -37.10, mag: 1.62, col: 0xd6e2ff },
  { name: 'Gacrux', ra: 187.79, dec: -57.11, mag: 1.63, col: 0xffb27a },
  { name: 'Bellatrix', ra: 81.28, dec: 6.35, mag: 1.64, col: 0xd6e2ff },
  { name: 'Elnath', ra: 81.57, dec: 28.61, mag: 1.65, col: 0xdce6ff },
  { name: 'Miaplacidus', ra: 138.30, dec: -69.72, mag: 1.68, col: 0xf2f4ff },
  { name: 'Alnilam', ra: 84.05, dec: -1.20, mag: 1.69, col: 0xd2e0ff },
  { name: 'Alnair', ra: 332.06, dec: -46.96, mag: 1.74, col: 0xd6e2ff },
  { name: 'Alnitak', ra: 85.19, dec: -1.94, mag: 1.77, col: 0xd2e0ff },
  { name: 'Alioth', ra: 193.51, dec: 55.96, mag: 1.77, col: 0xeef2ff },
  { name: 'Dubhe', ra: 165.93, dec: 61.75, mag: 1.79, col: 0xffd29a },
  { name: 'Mirfak', ra: 51.08, dec: 49.86, mag: 1.79, col: 0xfff4e0 },
  { name: 'Wezen', ra: 107.10, dec: -26.39, mag: 1.83, col: 0xfff4e0 },
  { name: 'Kaus Australis', ra: 276.04, dec: -34.38, mag: 1.85, col: 0xdce6ff },
  { name: 'Avior', ra: 125.63, dec: -59.51, mag: 1.86, col: 0xffd29a },
  { name: 'Alkaid', ra: 206.89, dec: 49.31, mag: 1.86, col: 0xd6e2ff },
  { name: 'Sargas', ra: 264.33, dec: -43.00, mag: 1.87, col: 0xfff4e0 },
  { name: 'Menkalinan', ra: 89.88, dec: 44.95, mag: 1.90, col: 0xeef2ff },
  { name: 'Atria', ra: 252.17, dec: -69.03, mag: 1.91, col: 0xffc08a },
  { name: 'Alhena', ra: 99.43, dec: 16.40, mag: 1.93, col: 0xeef2ff },
  { name: 'Peacock', ra: 306.41, dec: -56.74, mag: 1.94, col: 0xd6e2ff },
  { name: 'Mirzam', ra: 95.67, dec: -17.96, mag: 1.98, col: 0xd6e2ff },
  { name: 'Alphard', ra: 141.90, dec: -8.66, mag: 1.98, col: 0xffc08a },
  { name: 'Hamal', ra: 31.79, dec: 23.46, mag: 2.00, col: 0xffcc96 },
  { name: 'Diphda', ra: 10.90, dec: -17.99, mag: 2.04, col: 0xffd29a },
  { name: 'Nunki', ra: 283.82, dec: -26.30, mag: 2.05, col: 0xdce6ff },
  { name: 'Menkent', ra: 211.67, dec: -36.37, mag: 2.06, col: 0xffd29a },
  { name: 'Alpheratz', ra: 2.10, dec: 29.09, mag: 2.06, col: 0xdce6ff },
  { name: 'Mirach', ra: 17.43, dec: 35.62, mag: 2.06, col: 0xffb27a },
  { name: 'Saiph', ra: 86.94, dec: -9.67, mag: 2.07, col: 0xd2e0ff },
  { name: 'Kochab', ra: 222.68, dec: 74.16, mag: 2.08, col: 0xffc08a },
  { name: 'Rasalhague', ra: 263.73, dec: 12.56, mag: 2.08, col: 0xf2f4ff },
  { name: 'Algol', ra: 47.04, dec: 40.96, mag: 2.12, col: 0xdce6ff },
  { name: 'Almach', ra: 30.97, dec: 42.33, mag: 2.10, col: 0xffc896 },
  { name: 'Denebola', ra: 177.26, dec: 14.57, mag: 2.13, col: 0xf2f4ff },
  { name: 'Gamma Cas', ra: 14.18, dec: 60.72, mag: 2.15, col: 0xd6e2ff },
  { name: 'Muhlifain', ra: 190.38, dec: -48.96, mag: 2.20, col: 0xeef2ff },
  { name: 'Naos', ra: 120.90, dec: -40.00, mag: 2.21, col: 0xc8d8ff },
  { name: 'Aspidiske', ra: 139.27, dec: -59.28, mag: 2.21, col: 0xf2f4ff },
  { name: 'Alphecca', ra: 233.67, dec: 26.71, mag: 2.22, col: 0xeef2ff },
  { name: 'Suhail', ra: 136.99, dec: -43.43, mag: 2.21, col: 0xffc08a },
  { name: 'Mizar', ra: 200.98, dec: 54.93, mag: 2.23, col: 0xeef2ff },
  { name: 'Sadr', ra: 305.56, dec: 40.26, mag: 2.23, col: 0xfff4e0 },
  { name: 'Schedar', ra: 10.13, dec: 56.54, mag: 2.24, col: 0xffcc96 },
  { name: 'Eltanin', ra: 269.15, dec: 51.49, mag: 2.24, col: 0xffc08a },
  { name: 'Mintaka', ra: 83.00, dec: -0.30, mag: 2.25, col: 0xd2e0ff },
  { name: 'Caph', ra: 2.29, dec: 59.15, mag: 2.28, col: 0xfff4e0 },
  { name: 'Dschubba', ra: 240.08, dec: -22.62, mag: 2.29, col: 0xd2e0ff },
  { name: 'Merak', ra: 165.46, dec: 56.38, mag: 2.37, col: 0xeef2ff },
  { name: 'Izar', ra: 221.25, dec: 27.07, mag: 2.37, col: 0xffcc96 },
  { name: 'Enif', ra: 326.05, dec: 9.88, mag: 2.39, col: 0xffc08a },
  { name: 'Ankaa', ra: 6.57, dec: -42.31, mag: 2.40, col: 0xffcc96 },
  { name: 'Phecda', ra: 178.46, dec: 53.69, mag: 2.44, col: 0xeef2ff },
  { name: 'Sabik', ra: 257.59, dec: -15.72, mag: 2.43, col: 0xf2f4ff },
  { name: 'Scheat', ra: 345.94, dec: 28.08, mag: 2.42, col: 0xffb27a },
  { name: 'Alderamin', ra: 319.64, dec: 62.59, mag: 2.45, col: 0xf2f4ff },
  { name: 'Aludra', ra: 111.02, dec: -29.30, mag: 2.45, col: 0xd6e2ff },
  { name: 'Markab', ra: 346.19, dec: 15.21, mag: 2.49, col: 0xdce6ff },
  { name: 'Menkar', ra: 45.57, dec: 4.09, mag: 2.54, col: 0xffb27a },
  { name: 'Zosma', ra: 168.53, dec: 20.52, mag: 2.56, col: 0xf2f4ff },
  { name: 'Acrab', ra: 241.36, dec: -19.81, mag: 2.62, col: 0xd6e2ff },
  { name: 'Arneb', ra: 83.18, dec: -17.82, mag: 2.58, col: 0xfff4e0 },
  { name: 'Ruchbah', ra: 21.45, dec: 60.24, mag: 2.68, col: 0xf2f4ff },
  { name: 'Algieba', ra: 154.99, dec: 19.84, mag: 2.08, col: 0xffcc96 },
  { name: 'Tarazed', ra: 296.56, dec: 10.61, mag: 2.72, col: 0xffc08a },
  { name: 'Albireo', ra: 292.68, dec: 27.96, mag: 3.05, col: 0xffcc96 },
  { name: 'Gienah Cygni', ra: 311.55, dec: 33.97, mag: 2.48, col: 0xffd29a },
  { name: 'Delta Cygni', ra: 296.24, dec: 45.13, mag: 2.87, col: 0xeef2ff },
  { name: 'Sheliak', ra: 282.52, dec: 33.36, mag: 3.52, col: 0xdce6ff },
  { name: 'Sulafat', ra: 284.74, dec: 32.69, mag: 3.25, col: 0xdce6ff },
  { name: 'Megrez', ra: 183.86, dec: 57.03, mag: 3.31, col: 0xf2f4ff },
  { name: 'Segin', ra: 28.60, dec: 63.67, mag: 3.37, col: 0xd6e2ff },
  { name: 'Delta Crucis', ra: 183.79, dec: -58.75, mag: 2.80, col: 0xd6e2ff },
  { name: 'Algenib', ra: 3.31, dec: 15.18, mag: 2.83, col: 0xd6e2ff },
  { name: 'Hassaleh', ra: 74.25, dec: 33.17, mag: 2.69, col: 0xffc08a },
  { name: 'Tejat', ra: 95.74, dec: 22.51, mag: 2.88, col: 0xffb27a },
  { name: 'Alcyone', ra: 56.87, dec: 24.11, mag: 2.87, col: 0xdce6ff },
  { name: 'Atlas', ra: 57.29, dec: 24.05, mag: 3.62, col: 0xdce6ff },
  { name: 'Electra', ra: 56.22, dec: 24.11, mag: 3.70, col: 0xdce6ff },
  { name: 'Maia', ra: 56.46, dec: 24.37, mag: 3.87, col: 0xdce6ff },
  { name: 'Merope', ra: 56.58, dec: 23.95, mag: 4.18, col: 0xdce6ff },
  { name: 'Taygeta', ra: 56.30, dec: 24.47, mag: 4.30, col: 0xdce6ff },
  { name: 'Ain', ra: 67.15, dec: 19.18, mag: 3.53, col: 0xffcc96 },
  { name: 'Lesath', ra: 262.69, dec: -37.30, mag: 2.70, col: 0xd6e2ff },
  { name: 'Larawag', ra: 252.54, dec: -34.29, mag: 2.29, col: 0xffcc96 },
  { name: 'Kaus Media', ra: 275.25, dec: -29.83, mag: 2.70, col: 0xffc896 },
  { name: 'Kaus Borealis', ra: 276.99, dec: -25.42, mag: 2.81, col: 0xffcc96 },
  { name: 'Ascella', ra: 285.65, dec: -29.88, mag: 2.60, col: 0xeef2ff },
  { name: 'Alnasl', ra: 271.45, dec: -30.42, mag: 2.98, col: 0xffcc96 },
  { name: 'Vindemiatrix', ra: 195.54, dec: 10.96, mag: 2.83, col: 0xffd29a },
  { name: 'Porrima', ra: 190.42, dec: -1.45, mag: 2.74, col: 0xf6f4ee },
  { name: 'Unukalhai', ra: 236.07, dec: 6.43, mag: 2.63, col: 0xffcc96 },
  { name: 'Zubeneschamali', ra: 229.25, dec: -9.38, mag: 2.61, col: 0xdce6ff },
  { name: 'Zubenelgenubi', ra: 222.72, dec: -16.04, mag: 2.75, col: 0xf6f4ee },
  { name: 'Cor Caroli', ra: 194.01, dec: 38.32, mag: 2.89, col: 0xeef2ff },
  { name: 'Muphrid', ra: 208.67, dec: 18.40, mag: 2.68, col: 0xfff4e0 },
  { name: 'Seginus', ra: 218.02, dec: 38.31, mag: 3.03, col: 0xf2f4ff },
  { name: 'Rastaban', ra: 262.61, dec: 52.30, mag: 2.79, col: 0xfff4e0 },
  { name: 'Thuban', ra: 211.10, dec: 64.38, mag: 3.65, col: 0xf2f4ff },
  { name: 'Pherkad', ra: 230.18, dec: 71.83, mag: 3.05, col: 0xf2f4ff },
  { name: 'Yildun', ra: 263.05, dec: 86.59, mag: 4.36, col: 0xf2f4ff },
  { name: 'Alrai', ra: 354.84, dec: 77.63, mag: 3.21, col: 0xffcc96 },
  { name: 'Mirphak Beta Per', ra: 47.27, dec: 44.86, mag: 2.93, col: 0xffd29a },
  { name: 'Sheratan', ra: 28.66, dec: 20.81, mag: 2.64, col: 0xf2f4ff },
  { name: 'Deneb Kaitos', ra: 10.90, dec: -17.99, mag: 2.04, col: 0xffd29a },
  { name: 'Alnath Gem', ra: 100.98, dec: 25.13, mag: 2.98, col: 0xfff4e0 },
  { name: 'Wasat', ra: 110.03, dec: 21.98, mag: 3.53, col: 0xf2f4ff },
  { name: 'Algorab', ra: 187.47, dec: -16.52, mag: 2.94, col: 0xf2f4ff },
  { name: 'Gienah Corvi', ra: 183.95, dec: -17.54, mag: 2.58, col: 0xdce6ff },
  { name: 'Kraz', ra: 188.60, dec: -23.40, mag: 2.65, col: 0xffd29a },
  { name: 'Minkar', ra: 182.53, dec: -22.62, mag: 3.02, col: 0xffc08a },
  { name: 'Theta Sco', ra: 264.33, dec: -43.00, mag: 1.87, col: 0xfff4e0 },
  { name: 'Epsilon Sco', ra: 252.54, dec: -34.29, mag: 2.29, col: 0xffcc96 },
  { name: 'Tau Sco', ra: 248.97, dec: -28.22, mag: 2.82, col: 0xd2e0ff },
  { name: 'Mu Sco', ra: 252.97, dec: -38.05, mag: 3.04, col: 0xd2e0ff },
  { name: 'Zeta Sco', ra: 253.65, dec: -42.36, mag: 3.62, col: 0xffcc96 },
  { name: 'Eta Sco', ra: 258.04, dec: -43.24, mag: 3.33, col: 0xf6f4ee },
  { name: 'Iota Sco', ra: 266.89, dec: -40.13, mag: 3.03, col: 0xfff4e0 },
  { name: 'Kappa Sco', ra: 265.62, dec: -39.03, mag: 2.39, col: 0xd2e0ff },
  { name: 'Epsilon Cen', ra: 204.97, dec: -53.47, mag: 2.30, col: 0xd2e0ff },
  { name: 'Eta Cen', ra: 218.88, dec: -42.16, mag: 2.31, col: 0xd2e0ff },
  { name: 'Gamma Cen', ra: 190.38, dec: -48.96, mag: 2.17, col: 0xeef2ff },
  { name: 'Alpha Lupi', ra: 220.48, dec: -47.39, mag: 2.30, col: 0xd2e0ff },
  { name: 'Beta Ceti', ra: 10.90, dec: -17.99, mag: 2.04, col: 0xffd29a },
  { name: 'Alpha Pav', ra: 306.41, dec: -56.74, mag: 1.94, col: 0xd6e2ff },
  { name: 'Alpha Tri Aust', ra: 252.17, dec: -69.03, mag: 1.91, col: 0xffc08a },
  { name: 'Beta Hyi', ra: 6.44, dec: -77.25, mag: 2.80, col: 0xfff4e0 },
  { name: 'Alpha Hyi', ra: 29.69, dec: -61.57, mag: 2.86, col: 0xf6f4ee },
  { name: 'Sigma Oct', ra: 317.20, dec: -88.96, mag: 5.42, col: 0xf6f4ee },
];

// The table holds a few aliases of the same star under a second name; keep each position once.
{
  const seen = new Set();
  for (let i = BRIGHT_STARS.length - 1; i >= 0; i--) {
    const k = `${BRIGHT_STARS[i].ra.toFixed(1)}|${BRIGHT_STARS[i].dec.toFixed(1)}`;
    if (seen.has(k)) BRIGHT_STARS.splice(i, 1); else seen.add(k);
  }
}

/**
 * Precession matrix (row-major 3x3) from J2000 equatorial to mean equator/equinox of date (Meeus 21.2, IAU 1976),
 * in the standard (x toward RA 0, y toward RA 90, z toward the north pole) frame.
 */
export function precessionMatrix(unixSeconds) {
  const t = centuriesTT(unixSeconds);
  const as = D2R / 3600;
  const zeta = (2306.2181 * t + 0.30188 * t * t + 0.017998 * t * t * t) * as;
  const z = (2306.2181 * t + 1.09468 * t * t + 0.018203 * t * t * t) * as;
  const th = (2004.3109 * t - 0.42665 * t * t - 0.041833 * t * t * t) * as;
  const cz = Math.cos(zeta), sz = Math.sin(zeta), cZ = Math.cos(z), sZ = Math.sin(z), ct = Math.cos(th), st = Math.sin(th);
  return [
    cZ * ct * cz - sZ * sz, -cZ * ct * sz - sZ * cz, -cZ * st,
    sZ * ct * cz + cZ * sz, -sZ * ct * sz + cZ * cz, -sZ * st,
    st * cz, -st * sz, ct,
  ];
}

// -------------------------------------------------------------------------------------------- planets
// JPL "Approximate Positions of the Planets" (E M Standish), table 1, 1800-2050: elements at J2000 and per-century
// rates: a (AU), e, I, L, long. perihelion, long. ascending node (deg). Ecliptic & equinox J2000.
const PLANET_EL = {
  Mercury: [[0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593], [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081]],
  Venus: [[0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255], [0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418]],
  EMB: [[1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0], [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0]],
  Mars: [[1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891], [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343]],
  Jupiter: [[5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909], [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106]],
  Saturn: [[9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448], [-0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794]],
};
function heliocentric(name, t) {
  const [e0, r] = PLANET_EL[name];
  const a = e0[0] + r[0] * t, e = e0[1] + r[1] * t, I = (e0[2] + r[2] * t) * D2R;
  const L = e0[3] + r[3] * t, w = e0[4] + r[4] * t, O = e0[5] + r[5] * t;
  const om = (w - O) * D2R, Om = O * D2R;
  let M = normDeg(L - w); if (M > 180) M -= 360;
  const Mr = M * D2R;
  let E = Mr + e * Math.sin(Mr);
  for (let k = 0; k < 8; k++) E -= (E - e * Math.sin(E) - Mr) / (1 - e * Math.cos(E));
  const xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const co = Math.cos(om), so = Math.sin(om), cO = Math.cos(Om), sO = Math.sin(Om), cI = Math.cos(I), sI = Math.sin(I);
  return [
    (co * cO - so * sO * cI) * xp + (-so * cO - co * sO * cI) * yp,
    (co * sO + so * cO * cI) * xp + (-so * sO + co * cO * cI) * yp,
    (so * sI) * xp + (co * sI) * yp,
  ];
}
const PLANET_LOOK = {
  Venus: { col: 0xfffbf0, size: 2.4 }, Mars: { col: 0xffb08a, size: 1.8 },
  Jupiter: { col: 0xfff1d8, size: 2.5 }, Saturn: { col: 0xffe6b8, size: 2.0 },
};
function planetMag(name, r, d, iDeg) {
  const k = 5 * Math.log10(r * d);
  switch (name) {
    case 'Venus': return -4.40 + k + 0.0009 * iDeg + 0.000239 * iDeg * iDeg - 0.00000065 * iDeg ** 3;
    case 'Mars': return -1.52 + k + 0.016 * iDeg;
    case 'Jupiter': return -9.40 + k + 0.005 * iDeg;
    case 'Saturn': return -8.88 + k + 0.044 * iDeg;
    default: return -0.42 + k + 0.0380 * iDeg - 0.000273 * iDeg * iDeg + 0.000002 * iDeg ** 3;
  }
}

/**
 * The bright naked-eye planets (Venus, Mars, Jupiter, Saturn) for UTC unixSeconds: J2000 geocentric RA/Dec
 * (rad + deg), apparent magnitude, elongation from the Sun (deg), distance (AU). Light time is applied.
 */
export function getMajorPlanets(unixSeconds) {
  const t = centuriesTT(unixSeconds);
  const earth = heliocentric('EMB', t);
  const epsJ = 23.43928 * D2R, ce = Math.cos(epsJ), se = Math.sin(epsJ);
  const sunGeo = [-earth[0], -earth[1], -earth[2]];
  const sunDist = Math.hypot(...sunGeo);
  return ['Venus', 'Mars', 'Jupiter', 'Saturn'].map((name) => {
    let p = heliocentric(name, t), g = [p[0] - earth[0], p[1] - earth[1], p[2] - earth[2]];
    const lt = Math.hypot(...g) * 0.0057755183 / 36525;                // light time (centuries)
    p = heliocentric(name, t - lt); g = [p[0] - earth[0], p[1] - earth[1], p[2] - earth[2]];
    const dist = Math.hypot(...g), r = Math.hypot(...p);
    // ecliptic -> equatorial (J2000)
    const xq = g[0], yq = g[1] * ce - g[2] * se, zq = g[1] * se + g[2] * ce;
    const ra = normRad(Math.atan2(yq, xq)), dec = Math.asin(clamp(zq / dist, -1, 1));
    const cosI = (r * r + dist * dist - sunDist * sunDist) / (2 * r * dist);
    const iDeg = Math.acos(clamp(cosI, -1, 1)) * R2D;
    const cosEl = (g[0] * sunGeo[0] + g[1] * sunGeo[1] + g[2] * sunGeo[2]) / (dist * sunDist);
    const mag = planetMag(name, r, dist, iDeg);
    return { name, col: PLANET_LOOK[name].col, size: PLANET_LOOK[name].size, mag, raDeg: ra * R2D, decDeg: dec * R2D, ra, dec,
      elongDeg: Math.acos(clamp(cosEl, -1, 1)) * R2D, distAU: dist, phaseAngleDeg: iDeg };
  });
}
