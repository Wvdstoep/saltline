// shared/astro.js - Real-time astronomical solar, lunar, and celestial sphere calculations
// NOAA solar calculator & Jean Meeus 'Astronomical Algorithms' standard.

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function normDeg(d) { let r = d % 360; if (r < 0) r += 360; return r; }
function normRad(r) { let v = r % (2 * Math.PI); if (v < 0) v += 2 * Math.PI; return v; }

/**
 * Solar position given observer latitude/longitude and UTC unix seconds.
 * Returns elevation, azimuth (from North clockwise through East),
 * and 3D direction vector in Saltline world coords (x = East, y = Up, -z = North).
 */
export function solarPosition(lat, lon, unixSeconds) {
  const jd = unixSeconds / 86400 + 2440587.5;
  const t = (jd - 2451545.0) / 36525; // Julian centuries from J2000

  // Geometric mean longitude of the Sun (deg)
  const l0 = normDeg(280.46646 + t * (36000.76983 + 0.0003032 * t));
  // Mean anomaly of the Sun (deg)
  const m = normDeg(357.52911 + t * (35999.05029 - 0.0001537 * t));
  const mRad = m * D2R;

  // Sun equation of center (deg)
  const c = Math.sin(mRad) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
            Math.sin(2 * mRad) * (0.019993 - 0.000101 * t) +
            Math.sin(3 * mRad) * 0.000289;

  // True longitude of the Sun (deg)
  const oL = l0 + c;
  // Apparent longitude of the Sun (deg)
  const lambda = oL - 0.00569 - 0.00478 * Math.sin((125.04 - 1934.136 * t) * D2R);
  const lambdaRad = lambda * D2R;

  // Mean obliquity of the ecliptic (deg)
  const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  // Corrected obliquity (deg)
  const eps = eps0 + 0.00256 * Math.cos((125.04 - 1934.136 * t) * D2R);
  const epsRad = eps * D2R;

  // Declination delta (rad)
  const sinDec = Math.sin(epsRad) * Math.sin(lambdaRad);
  const decRad = Math.asin(clamp(sinDec, -1, 1));
  const cosDec = Math.cos(decRad);

  // Equation of Time (minutes)
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const y = Math.tan(epsRad / 2) ** 2;
  const l0Rad = l0 * D2R;
  const eTime = 4 * R2D * (
    y * Math.sin(2 * l0Rad) -
    2 * e * Math.sin(mRad) +
    4 * e * y * Math.sin(mRad) * Math.cos(2 * l0Rad) -
    0.5 * y * y * Math.sin(4 * l0Rad) -
    1.25 * e * e * Math.sin(2 * mRad)
  );

  // True solar time in minutes
  const timeOffset = eTime + 4 * lon;
  const secOfDay = (unixSeconds % 86400 + 86400) % 86400;
  const trueSolarMinutes = normDeg((secOfDay / 60 + timeOffset) * (360 / 1440)) * 4;
  const hourAngleDeg = trueSolarMinutes / 4 - 180;
  const hRad = hourAngleDeg * D2R;

  // Solar zenith & elevation
  const latRad = lat * D2R;
  const sinLat = Math.sin(latRad), cosLat = Math.cos(latRad);
  const sinElev = sinLat * sinDec + cosLat * cosDec * Math.cos(hRad);
  const elevRad = Math.asin(clamp(sinElev, -1, 1));
  const elevDeg = elevRad * R2D;

  // Azimuth from North clockwise through East
  const yAz = -Math.sin(hRad) * cosDec;
  const xAz = cosLat * sinDec - sinLat * cosDec * Math.cos(hRad);
  const azDeg = (Math.atan2(yAz, xAz) * R2D + 360) % 360;
  const azRad = azDeg * D2R;

  // Direction vector in Saltline world coords: x = East, y = Up, -z = North
  const cosElev = Math.cos(elevRad);
  const dir = [
    Math.sin(azRad) * cosElev,
    Math.sin(elevRad),
    -Math.cos(azRad) * cosElev
  ];

  // Twilight and daylight factor:
  // -0.10 rad is nautical/civil twilight edge (~ -6° to -10°)
  // +0.20 rad is full early day (~ +12°)
  const day = clamp((elevRad - (-0.10)) / (0.22 - (-0.10)), 0, 1);
  const smoothDay = day * day * (3 - 2 * day);
  const dusk = Math.exp(-Math.pow((elevRad - 0.02) / 0.12, 2));

  return {
    elev: elevRad,
    elevDeg,
    az: azRad,
    azDeg,
    dir,
    day: smoothDay,
    dusk,
    dec: decRad,
    hourAngle: hRad,
    lambdaRad,
  };
}

/**
 * Lunar position, phase, and illumination fraction for observer at (lat, lon) and unixSeconds.
 */
export function lunarPosition(lat, lon, unixSeconds, sunLambdaRad = null) {
  const jd = unixSeconds / 86400 + 2440587.5;
  const t = (jd - 2451545.0) / 36525;

  // Moon's mean longitude
  const lp = normDeg(218.3164477 + 481267.88128 * t);
  // Moon's mean elongation
  const d = normDeg(297.8501921 + 445267.1142 * t);
  // Sun's mean anomaly
  const m = normDeg(357.5291092 + 35999.05029 * t);
  // Moon's mean anomaly
  const mp = normDeg(134.9633964 + 477198.8675 * t);
  // Moon's argument of latitude
  const f = normDeg(93.2720950 + 483202.0175 * t);

  const dRad = d * D2R, mRad = m * D2R, mpRad = mp * D2R, fRad = f * D2R;

  // Perturbations in ecliptic longitude (Meeus Ch. 47)
  const sigmaL = 6.288774 * Math.sin(mpRad) +
                 1.274027 * Math.sin(2 * dRad - mpRad) +
                 0.658314 * Math.sin(2 * dRad) +
                 0.213618 * Math.sin(2 * mpRad) -
                 0.185116 * Math.sin(mRad) -
                 0.114332 * Math.sin(2 * fRad) +
                 0.058793 * Math.sin(2 * dRad - 2 * mpRad) +
                 0.057066 * Math.sin(2 * dRad - mRad - mpRad);
  const moonLonDeg = normDeg(lp + sigmaL);
  const moonLonRad = moonLonDeg * D2R;

  // Perturbations in ecliptic latitude
  const sigmaB = 5.128122 * Math.sin(fRad) +
                 0.280602 * Math.sin(mpRad + fRad) +
                 0.277693 * Math.sin(mpRad - fRad) +
                 0.173237 * Math.sin(2 * dRad - fRad) +
                 0.055413 * Math.sin(2 * dRad - mpRad + fRad) +
                 0.046271 * Math.sin(2 * dRad - mpRad - fRad);
  const moonLatRad = sigmaB * D2R;

  // Obliquity of ecliptic
  const eps = (23.439291 - 0.0130042 * t) * D2R;

  // Equatorial coordinates (Right Ascension raRad, Declination decRad)
  const sinDelta = Math.sin(moonLatRad) * Math.cos(eps) + Math.cos(moonLatRad) * Math.sin(eps) * Math.sin(moonLonRad);
  const decRad = Math.asin(clamp(sinDelta, -1, 1));
  const cosDelta = Math.cos(decRad);

  const yAlpha = Math.sin(moonLonRad) * Math.cos(eps) - Math.tan(moonLatRad) * Math.sin(eps);
  const xAlpha = Math.cos(moonLonRad);
  const raRad = normRad(Math.atan2(yAlpha, xAlpha));

  // Greenwich Mean Sidereal Time (deg)
  const gmstDeg = normDeg(280.46061837 + 360.98564736629 * (jd - 2451545.0));
  const lstDeg = normDeg(gmstDeg + lon);
  const lstRad = lstDeg * D2R;

  // Moon Hour Angle (rad)
  const hRad = lstRad - raRad;

  // Local horizontal coordinates (Elevation & Azimuth)
  const latRad = lat * D2R;
  const sinLat = Math.sin(latRad), cosLat = Math.cos(latRad);
  const sinElev = sinLat * sinDelta + cosLat * cosDelta * Math.cos(hRad);
  const elevRad = Math.asin(clamp(sinElev, -1, 1));
  const elevDeg = elevRad * R2D;

  const yAz = -Math.sin(hRad) * cosDelta;
  const xAz = cosLat * sinDelta - sinLat * cosDelta * Math.cos(hRad);
  const azDeg = (Math.atan2(yAz, xAz) * R2D + 360) % 360;
  const azRad = azDeg * D2R;

  const cosElev = Math.cos(elevRad);
  const dir = [
    Math.sin(azRad) * cosElev,
    Math.sin(elevRad),
    -Math.cos(azRad) * cosElev
  ];

  // Lunar Phase: elongation from Sun
  const sunLon = sunLambdaRad !== null ? sunLambdaRad : normRad((280.46646 + t * 36000.76983) * D2R);
  const elongRad = normRad(moonLonRad - sunLon);
  const phaseFrac = elongRad / (2 * Math.PI); // 0 = New, 0.25 = First Quarter, 0.5 = Full, 0.75 = Last Quarter
  const illum = (1 - Math.cos(elongRad)) / 2;

  let phaseName = 'New Moon';
  if (phaseFrac < 0.04 || phaseFrac > 0.96) phaseName = 'New Moon';
  else if (phaseFrac < 0.21) phaseName = 'Waxing Crescent';
  else if (phaseFrac < 0.29) phaseName = 'First Quarter';
  else if (phaseFrac < 0.46) phaseName = 'Waxing Gibbous';
  else if (phaseFrac < 0.54) phaseName = 'Full Moon';
  else if (phaseFrac < 0.71) phaseName = 'Waning Gibbous';
  else if (phaseFrac < 0.79) phaseName = 'Last Quarter';
  else phaseName = 'Waning Crescent';

  // Bright limb rotation angle (position angle of the bright crescent)
  // Approximate limb tilt in observer sky:
  const limbAngle = normRad(elongRad + Math.PI / 2);

  return {
    elev: elevRad,
    elevDeg,
    az: azRad,
    azDeg,
    dir,
    phase: phaseFrac,
    illumination: illum,
    phaseName,
    limbAngle,
    ra: raRad,
    dec: decRad,
  };
}

/**
 * Local Sidereal Time in radians for observer at longitude (deg) and unixSeconds.
 */
export function localSiderealTime(lon, unixSeconds) {
  const jd = unixSeconds / 86400 + 2440587.5;
  const gmstDeg = normDeg(280.46061837 + 360.98564736629 * (jd - 2451545.0));
  return normRad((gmstDeg + lon) * D2R);
}

/**
 * Key navigational stars and asterisms (J2000 Right Ascension & Declination in degrees).
 * Mag: apparent visual magnitude (lower/negative = brighter).
 * Col: RGB hex tint.
 */
export const BRIGHT_STARS = [
  // Polaris (North Star)
  { name: 'Polaris', ra: 37.95, dec: 89.26, mag: 1.98, col: 0xfff8ee },
  // Brightest night stars
  { name: 'Sirius', ra: 101.29, dec: -16.72, mag: -1.46, col: 0xddeeff },
  { name: 'Vega', ra: 279.23, dec: 38.78, mag: 0.03, col: 0xe8f0ff },
  { name: 'Arcturus', ra: 213.92, dec: 19.18, mag: -0.05, col: 0xffcc88 },
  { name: 'Rigel', ra: 78.63, dec: -8.20, mag: 0.13, col: 0xcce0ff },
  { name: 'Capella', ra: 81.70, dec: 45.99, mag: 0.08, col: 0xffe899 },
  { name: 'Betelgeuse', ra: 88.79, dec: 7.41, mag: 0.50, col: 0xff7744 },
  { name: 'Aldebaran', ra: 68.98, dec: 16.51, mag: 0.85, col: 0xff9944 },
  { name: 'Altair', ra: 297.70, dec: 8.87, mag: 0.76, col: 0xf5f8ff },
  { name: 'Deneb', ra: 310.36, dec: 45.28, mag: 1.25, col: 0xeef4ff },
  { name: 'Spica', ra: 201.30, dec: -11.16, mag: 0.98, col: 0xdde8ff },
  { name: 'Antares', ra: 247.35, dec: -26.43, mag: 1.06, col: 0xff5533 },
  { name: 'Pollux', ra: 116.33, dec: 28.03, mag: 1.14, col: 0xffddaa },
  { name: 'Castor', ra: 113.65, dec: 31.89, mag: 1.58, col: 0xf0f5ff },
  { name: 'Procyon', ra: 114.83, dec: 5.22, mag: 0.34, col: 0xfff4e0 },
  { name: 'Fomalhaut', ra: 344.41, dec: -29.62, mag: 1.17, col: 0xeef5ff },
  { name: 'Achernar', ra: 24.43, dec: -57.24, mag: 0.46, col: 0xd8eeff },
  { name: 'Canopus', ra: 95.99, dec: -52.70, mag: -0.74, col: 0xfffaee },
  { name: 'Alpha Centauri', ra: 219.90, dec: -60.83, mag: -0.27, col: 0xffeedd },
  { name: 'Hadar', ra: 210.96, dec: -60.37, mag: 0.61, col: 0xd8e8ff },

  // Ursa Major (Big Dipper)
  { name: 'Dubhe', ra: 165.93, dec: 61.75, mag: 1.79, col: 0xffddaa },
  { name: 'Merak', ra: 165.46, dec: 56.38, mag: 2.37, col: 0xf0f5ff },
  { name: 'Phecda', ra: 178.46, dec: 53.69, mag: 2.44, col: 0xf0f5ff },
  { name: 'Megrez', ra: 183.86, dec: 57.03, mag: 3.31, col: 0xf0f5ff },
  { name: 'Alioth', ra: 193.51, dec: 55.96, mag: 1.77, col: 0xf0f5ff },
  { name: 'Mizar', ra: 200.98, dec: 54.92, mag: 2.23, col: 0xf0f5ff },
  { name: 'Alkaid', ra: 206.89, dec: 49.31, mag: 1.86, col: 0xddeeff },

  // Cassiopeia
  { name: 'Schedar', ra: 10.13, dec: 56.54, mag: 2.23, col: 0xffc877 },
  { name: 'Caph', ra: 2.29, dec: 59.15, mag: 2.27, col: 0xfff0dd },
  { name: 'Gamma Cas', ra: 14.18, dec: 60.72, mag: 2.15, col: 0xd8e8ff },
  { name: 'Ruchbah', ra: 19.52, dec: 60.23, mag: 2.68, col: 0xf0f5ff },
  { name: 'Segin', ra: 26.60, dec: 63.67, mag: 3.35, col: 0xd8e8ff },

  // Orion belt & shoulders
  { name: 'Bellatrix', ra: 81.28, dec: 6.35, mag: 1.64, col: 0xddeeff },
  { name: 'Alnitak', ra: 85.19, dec: -1.94, mag: 1.77, col: 0xddeeff },
  { name: 'Alnilam', ra: 84.05, dec: -1.20, mag: 1.69, col: 0xddeeff },
  { name: 'Mintaka', ra: 83.00, dec: -0.30, mag: 2.23, col: 0xddeeff },
  { name: 'Saiph', ra: 86.94, dec: -9.67, mag: 2.06, col: 0xddeeff },

  // Southern Cross (Crux)
  { name: 'Acrux', ra: 186.65, dec: -63.10, mag: 0.77, col: 0xddeeff },
  { name: 'Mimosa', ra: 191.93, dec: -59.69, mag: 1.25, col: 0xddeeff },
  { name: 'Gacrux', ra: 187.79, dec: -57.11, mag: 1.63, col: 0xff8855 },
  { name: 'Delta Crucis', ra: 183.79, dec: -58.75, mag: 2.80, col: 0xddeeff },
];

/**
 * Approximate positions of naked-eye visible planets (Venus, Mars, Jupiter, Saturn)
 * for a given UTC unix seconds.
 */
export function getMajorPlanets(unixSeconds) {
  const jd = unixSeconds / 86400 + 2440587.5;
  const d = jd - 2451545.0; // days since J2000.0

  // Keplerian mean orbital elements (approximate for visible display)
  const planets = [
    { name: 'Venus', col: 0xffffff, size: 2.4, a: 0.7233, period: 224.70, l0: 181.98, mag: -4.2 },
    { name: 'Mars', col: 0xff7744, size: 1.8, a: 1.5237, period: 686.98, l0: 355.43, mag: -0.5 },
    { name: 'Jupiter', col: 0xffeebb, size: 2.5, a: 5.2026, period: 4332.59, l0: 34.35, mag: -2.4 },
    { name: 'Saturn', col: 0xffe4aa, size: 2.0, a: 9.5549, period: 10759.22, l0: 50.08, mag: 0.4 },
  ];

  // Earth's heliocentric position
  const earthL = normDeg(100.46 + (360 / 365.256) * d) * D2R;
  const earthX = Math.cos(earthL), earthY = Math.sin(earthL);

  const eps = 23.439291 * D2R; // obliquity

  return planets.map((p) => {
    // Planet heliocentric longitude
    const planL = normDeg(p.l0 + (360 / p.period) * d) * D2R;
    const px = p.a * Math.cos(planL), py = p.a * Math.sin(planL);

    // Geocentric vector in ecliptic plane
    const gx = px - earthX, gy = py - earthY;
    const geoLon = normRad(Math.atan2(gy, gx));

    // Convert to Equatorial coordinates (approx zero ecliptic latitude)
    const sinDec = Math.sin(eps) * Math.sin(geoLon);
    const dec = Math.asin(clamp(sinDec, -1, 1));
    const ra = normRad(Math.atan2(Math.cos(eps) * Math.sin(geoLon), Math.cos(geoLon)));

    return {
      name: p.name,
      col: p.col,
      size: p.size,
      mag: p.mag,
      raDeg: ra * R2D,
      decDeg: dec * R2D,
      ra,
      dec,
    };
  });
}
