import test from 'node:test';
import assert from 'node:assert/strict';
import {
  solarPosition, lunarPosition, localSiderealTime, BRIGHT_STARS, getMajorPlanets,
  sunRiseSet, moonRiseSet, gmst, twilightPhase, angularSeparation, equatorialToHorizontal, precessionMatrix, refraction,
} from '../shared/astro.js';

const U = (iso) => Date.parse(iso) / 1000;
const minutesOff = (a, b) => Math.abs(a - b) / 60;

test('solarPosition calculates day and night accurately', () => {
  // Netherlands (Rotterdam / Maassluis): lat 51.92, lon 4.25
  const lat = 51.92, lon = 4.25;
  const nightSun = solarPosition(lat, lon, U('2026-10-13T20:46:00Z'));
  assert.ok(nightSun.elevDeg < -20, `Sun elevation at 22:46 local should be well below horizon, got ${nightSun.elevDeg}`);
  assert.equal(nightSun.day, 0, `Daylight factor at night should be 0, got ${nightSun.day}`);
  assert.ok(Number.isFinite(nightSun.dir[0]) && Number.isFinite(nightSun.dir[1]) && Number.isFinite(nightSun.dir[2]));
  const noonSun = solarPosition(lat, lon, U('2026-10-13T11:45:00Z'));
  assert.ok(noonSun.elevDeg > 20, `Sun elevation at noon should be > 20 deg, got ${noonSun.elevDeg}`);
  assert.equal(noonSun.day, 1, `Daylight factor at noon should be 1, got ${noonSun.day}`);
  assert.ok(Math.abs(noonSun.azDeg - 180) < 25, `Solar azimuth at noon should be near 180, got ${noonSun.azDeg}`);
});

test('sun: solstice/equinox noon altitudes match geometry', () => {
  // On the June solstice the noon Sun stands at 90 - lat + 23.44 deg; at the equator on the March equinox ~90.
  let best = -90;
  for (let m = 0; m < 240; m++) best = Math.max(best, solarPosition(51.4769, 0, U('2024-06-20T10:00:00Z') + m * 60).trueElevDeg);
  assert.ok(Math.abs(best - (90 - 51.4769 + 23.44)) < 0.05, `June solstice noon altitude at Greenwich ${best}`);
  let eq = -90;
  for (let m = 0; m < 240; m++) eq = Math.max(eq, solarPosition(0, 0, U('2024-03-20T10:00:00Z') + m * 60).trueElevDeg);
  assert.ok(eq > 89.5, `equinox noon at 0/0 should be near zenith, got ${eq}`);
});

test('sunrise and sunset match published times (within 2 min)', () => {
  // timeanddate.com / USNO: London (Greenwich) 2024-06-21 sunrise 04:43 BST, sunset 21:21 BST
  const ldn = sunRiseSet(51.4769, -0.0005, U('2024-06-21T00:00:00Z'));
  assert.ok(minutesOff(ldn.rise, U('2024-06-21T03:43:00Z')) < 2, `London rise ${new Date(ldn.rise * 1000).toISOString()}`);
  assert.ok(minutesOff(ldn.set, U('2024-06-21T20:21:00Z')) < 2, `London set ${new Date(ldn.set * 1000).toISOString()}`);
  // New York 2024-12-21: sunrise 07:16 EST, sunset 16:32 EST
  const ny = sunRiseSet(40.7128, -74.006, U('2024-12-21T05:00:00Z'));
  assert.ok(minutesOff(ny.rise, U('2024-12-21T12:16:00Z')) < 2, `NY rise ${new Date(ny.rise * 1000).toISOString()}`);
  assert.ok(minutesOff(ny.set, U('2024-12-21T21:32:00Z')) < 2, `NY set ${new Date(ny.set * 1000).toISOString()}`);
  // Polar night: Tromsø (69.65 N) has no sunrise on 2024-12-21
  const tr = sunRiseSet(69.65, 18.96, U('2024-12-21T00:00:00Z'));
  assert.equal(tr.rise, null); assert.equal(tr.set, null);
});

test('twilight phases follow the solar depression angle', () => {
  assert.equal(twilightPhase(10), 'day');
  assert.equal(twilightPhase(-3), 'civil');
  assert.equal(twilightPhase(-9), 'nautical');
  assert.equal(twilightPhase(-15), 'astronomical');
  assert.equal(twilightPhase(-25), 'night');
  // Amsterdam, 2024-12-21: civil dusk ends ~17:15 local (16:15 UTC), astronomical ~18:35 local
  assert.equal(solarPosition(52.37, 4.9, U('2024-12-21T15:55:00Z')).twilight, 'civil');
  assert.equal(solarPosition(52.37, 4.9, U('2024-12-21T16:40:00Z')).twilight, 'nautical');
  assert.equal(solarPosition(52.37, 4.9, U('2024-12-21T19:30:00Z')).twilight, 'night');
  // refraction lifts the horizon Sun by ~0.57 deg
  assert.ok(Math.abs(refraction(0) - 0.48) < 0.12, `refraction at 0 deg ${refraction(0)}`);
});

test('lunarPosition returns valid lunar coordinates and phase', () => {
  const moon = lunarPosition(51.92, 4.25, U('2026-10-13T20:46:00Z'));
  assert.ok(moon.phase >= 0 && moon.phase <= 1);
  assert.ok(moon.illumination >= 0 && moon.illumination <= 1);
  assert.ok(typeof moon.phaseName === 'string' && moon.phaseName.length > 0);
  const len = Math.hypot(moon.dir[0], moon.dir[1], moon.dir[2]);
  assert.ok(Math.abs(len - 1.0) < 1e-4, 'Moon direction vector must be normalized');
  assert.ok(moon.angDiamDeg > 0.48 && moon.angDiamDeg < 0.57, `apparent diameter ${moon.angDiamDeg}`);
});

test('moon phases match published new/full/quarter instants', () => {
  // USNO: full moon 2024-01-25 17:54 UTC, new moon 2024-04-08 18:21 UTC, first quarter 2024-01-18 03:53 UTC,
  // last quarter 2024-02-02 23:18 UTC
  const full = lunarPosition(0, 0, U('2024-01-25T17:54:00Z'));
  assert.ok(full.illumination > 0.995 && full.phaseName === 'Full Moon', `full ${full.illumination} ${full.phaseName}`);
  assert.ok(Math.abs(full.phase - 0.5) < 0.003, `full moon phase ${full.phase}`);
  const nw = lunarPosition(0, 0, U('2024-04-08T18:21:00Z'));
  assert.ok(nw.illumination < 0.005 && nw.phaseName === 'New Moon', `new ${nw.illumination}`);
  const fq = lunarPosition(0, 0, U('2024-01-18T03:53:00Z'));
  assert.ok(Math.abs(fq.phase - 0.25) < 0.003 && Math.abs(fq.illumination - 0.5) < 0.02, `first quarter ${fq.phase} ${fq.illumination}`);
  const lq = lunarPosition(0, 0, U('2024-02-02T23:18:00Z'));
  assert.ok(Math.abs(lq.phase - 0.75) < 0.003, `last quarter ${lq.phase}`);
  // October 2026 (the game's present): full moon 2026-10-26 04:12 UTC, new moon 2026-10-10 15:50 UTC
  assert.ok(lunarPosition(52, 4, U('2026-10-26T04:12:00Z')).illumination > 0.995);
  assert.ok(lunarPosition(52, 4, U('2026-10-10T15:50:00Z')).illumination < 0.005);
});

test('total solar eclipse 2024-04-08: Sun and Moon coincide over Dallas (topocentric moon)', () => {
  const lat = 32.78, lon = -96.80, t = U('2024-04-08T18:42:30Z');
  const s = solarPosition(lat, lon, t), m = lunarPosition(lat, lon, t);
  const sep = angularSeparation(s.dir, m.dir) * 180 / Math.PI;
  assert.ok(sep < 0.1, `Sun-Moon separation at Dallas totality ${sep} deg`);
  // ...while from London (no eclipse: the discs do not touch, sum of radii ~0.53 deg) and Cape Town they are apart
  const s2 = solarPosition(51.5, 0, t), m2 = lunarPosition(51.5, 0, t);
  assert.ok(angularSeparation(s2.dir, m2.dir) * 180 / Math.PI > 0.54);
  const s3 = solarPosition(-34, 18.4, t), m3 = lunarPosition(-34, 18.4, t);
  assert.ok(angularSeparation(s3.dir, m3.dir) * 180 / Math.PI > 1.0);
});

test('total lunar eclipse 2025-03-14 06:59 UTC: Moon opposite the Sun', () => {
  const t = U('2025-03-14T06:59:00Z');
  const s = solarPosition(-30, -90, t), m = lunarPosition(-30, -90, t);
  const sep = angularSeparation(s.dir, m.dir) * 180 / Math.PI;
  assert.ok(sep > 178.5, `Sun-Moon separation ${sep}`);
});

test('moon rises near sunset at full moon and is up all night', () => {
  // Rotterdam 2026-10-26 (full moon): moonrise within ~1.5 h of sunset, moon above the horizon at local midnight
  const lat = 51.92, lon = 4.25, t0 = U('2026-10-26T00:00:00Z');
  const sun = sunRiseSet(lat, lon, t0), moon = moonRiseSet(lat, lon, t0);
  assert.ok(sun.set && moon.rise, 'both events exist');
  assert.ok(Math.abs(moon.rise - sun.set) < 1.5 * 3600, `moonrise ${new Date(moon.rise * 1000).toISOString()} sunset ${new Date(sun.set * 1000).toISOString()}`);
  assert.ok(lunarPosition(lat, lon, U('2026-10-26T23:00:00Z')).elevDeg > 20);
});

test('sidereal time: Meeus example 12.a and Polaris altitude equals latitude', () => {
  // Meeus ex. 12.a: 1987-04-10 0h UT, GMST = 13h10m46.3668s
  const g = gmst(U('1987-04-10T00:00:00Z')) * 12 / Math.PI;
  assert.ok(Math.abs(g - (13 + 10 / 60 + 46.3668 / 3600)) < 1 / 3600, `GMST ${g}`);
  const lst = localSiderealTime(4.25, U('2026-10-13T20:46:00Z'));
  assert.ok(lst >= 0 && lst <= 2 * Math.PI);
  const pol = BRIGHT_STARS.find((s) => s.name === 'Polaris');
  for (const lat of [10, 35, 52, 70]) {
    const h = equatorialToHorizontal(pol.ra * Math.PI / 180, pol.dec * Math.PI / 180, lat, 4, U('2026-10-13T20:46:00Z'));
    assert.ok(Math.abs(h.alt * 180 / Math.PI - lat) < 0.8, `Polaris alt at lat ${lat}: ${h.alt * 180 / Math.PI}`);
  }
});

test('precession matrix is a rotation of ~0.36 deg for 2026', () => {
  const P = precessionMatrix(U('2026-01-01T00:00:00Z'));
  const det = P[0] * (P[4] * P[8] - P[5] * P[7]) - P[1] * (P[3] * P[8] - P[5] * P[6]) + P[2] * (P[3] * P[7] - P[4] * P[6]);
  assert.ok(Math.abs(det - 1) < 1e-9);
  const ang = Math.acos((P[0] + P[4] + P[8] - 1) / 2) * 180 / Math.PI;
  assert.ok(ang > 0.3 && ang < 0.42, `precession angle ${ang}`);
});

test('BRIGHT_STARS catalog has valid coordinates', () => {
  assert.ok(BRIGHT_STARS.length >= 120, 'Should have rich star catalog');
  const polaris = BRIGHT_STARS.find((s) => s.name === 'Polaris');
  assert.ok(polaris && polaris.dec > 88);
  for (const s of BRIGHT_STARS) {
    assert.ok(s.ra >= 0 && s.ra <= 360, `Star ${s.name} invalid RA`);
    assert.ok(s.dec >= -90 && s.dec <= 90, `Star ${s.name} invalid Dec`);
    assert.ok(Number.isFinite(s.mag));
  }
});

test('getMajorPlanets returns 4 naked-eye planets at their real places', () => {
  const planets = getMajorPlanets(U('2026-10-13T20:46:00Z'));
  assert.equal(planets.length, 4);
  const names = planets.map((p) => p.name);
  assert.ok(names.includes('Venus') && names.includes('Jupiter') && names.includes('Mars') && names.includes('Saturn'));
  for (const p of planets) assert.ok(Number.isFinite(p.ra) && Number.isFinite(p.dec) && Number.isFinite(p.mag));
  const at = (iso, n) => getMajorPlanets(U(iso)).find((p) => p.name === n);
  // Venus greatest eastern elongation 2025-01-10: 47.2 deg, magnitude about -4.6
  const v = at('2025-01-10T00:00:00Z', 'Venus');
  assert.ok(Math.abs(v.elongDeg - 47.2) < 0.6, `Venus elongation ${v.elongDeg}`);
  assert.ok(v.mag < -4.3 && v.mag > -4.9, `Venus mag ${v.mag}`);
  // oppositions: Jupiter 2024-12-07, Mars 2025-01-16, Saturn 2024-09-08
  assert.ok(at('2024-12-07T12:00:00Z', 'Jupiter').elongDeg > 176, 'Jupiter opposition');
  assert.ok(at('2025-01-16T02:00:00Z', 'Mars').elongDeg > 172, 'Mars opposition');
  assert.ok(at('2024-09-08T04:00:00Z', 'Saturn').elongDeg > 175, 'Saturn opposition');
  // Venus-Saturn conjunction 2025-01-18/19: about 2.2 deg apart
  const t = U('2025-01-18T20:00:00Z'), ps = getMajorPlanets(t);
  const vv = ps.find((p) => p.name === 'Venus'), ss = ps.find((p) => p.name === 'Saturn');
  const vec = (p) => [Math.cos(p.dec) * Math.cos(p.ra), Math.cos(p.dec) * Math.sin(p.ra), Math.sin(p.dec)];
  const sep = angularSeparation(vec(vv), vec(ss)) * 180 / Math.PI;
  assert.ok(sep > 1.5 && sep < 3.0, `Venus-Saturn separation ${sep}`);
  // Jupiter near opposition is about -2.8
  assert.ok(Math.abs(at('2024-12-07T12:00:00Z', 'Jupiter').mag + 2.8) < 0.3);
});
