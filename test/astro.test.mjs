import test from 'node:test';
import assert from 'node:assert/strict';
import { solarPosition, lunarPosition, localSiderealTime, BRIGHT_STARS, getMajorPlanets } from '../shared/astro.js';

test('solarPosition calculates day and night accurately', () => {
  // Netherlands (Rotterdam / Maassluis): lat 51.92, lon 4.25
  const lat = 51.92, lon = 4.25;

  // 2026-10-13 20:46:00 UTC (22:46 local time, nighttime)
  const nightUnix = Date.parse('2026-10-13T20:46:00Z') / 1000;
  const nightSun = solarPosition(lat, lon, nightUnix);

  assert.ok(nightSun.elevDeg < -20, `Sun elevation at 22:46 local should be well below horizon, got ${nightSun.elevDeg}`);
  assert.equal(nightSun.day, 0, `Daylight factor at night should be 0, got ${nightSun.day}`);
  assert.ok(Number.isFinite(nightSun.dir[0]) && Number.isFinite(nightSun.dir[1]) && Number.isFinite(nightSun.dir[2]));

  // 2026-10-13 11:45:00 UTC (13:45 CEST, solar noon approximate)
  const noonUnix = Date.parse('2026-10-13T11:45:00Z') / 1000;
  const noonSun = solarPosition(lat, lon, noonUnix);

  assert.ok(noonSun.elevDeg > 20, `Sun elevation at noon should be > 20 deg, got ${noonSun.elevDeg}`);
  assert.equal(noonSun.day, 1, `Daylight factor at noon should be 1, got ${noonSun.day}`);
  // Near solar noon in northern hemisphere, sun should be roughly to the South (azimuth ~ 180 deg)
  assert.ok(Math.abs(noonSun.azDeg - 180) < 25, `Solar azimuth at noon should be near 180, got ${noonSun.azDeg}`);
});

test('lunarPosition returns valid lunar coordinates and phase', () => {
  const lat = 51.92, lon = 4.25;
  const unix = Date.parse('2026-10-13T20:46:00Z') / 1000;
  const moon = lunarPosition(lat, lon, unix);

  assert.ok(moon.phase >= 0 && moon.phase <= 1, `Phase should be in [0, 1], got ${moon.phase}`);
  assert.ok(moon.illumination >= 0 && moon.illumination <= 1, `Illumination should be in [0, 1], got ${moon.illumination}`);
  assert.ok(typeof moon.phaseName === 'string' && moon.phaseName.length > 0);
  assert.ok(moon.dir.length === 3);
  const len = Math.hypot(moon.dir[0], moon.dir[1], moon.dir[2]);
  assert.ok(Math.abs(len - 1.0) < 1e-4, 'Moon direction vector must be normalized');
});

test('localSiderealTime returns valid sidereal angle', () => {
  const unix = Date.parse('2026-10-13T20:46:00Z') / 1000;
  const lst = localSiderealTime(4.25, unix);
  assert.ok(lst >= 0 && lst <= 2 * Math.PI, `LST must be in [0, 2*PI], got ${lst}`);
});

test('BRIGHT_STARS catalog has valid coordinates', () => {
  assert.ok(BRIGHT_STARS.length >= 30, 'Should have rich star catalog');
  const polaris = BRIGHT_STARS.find((s) => s.name === 'Polaris');
  assert.ok(polaris, 'Polaris must be in catalog');
  assert.ok(polaris.dec > 88, 'Polaris declination must be near 89 deg');
  for (const s of BRIGHT_STARS) {
    assert.ok(s.ra >= 0 && s.ra <= 360, `Star ${s.name} invalid RA`);
    assert.ok(s.dec >= -90 && s.dec <= 90, `Star ${s.name} invalid Dec`);
  }
});

test('getMajorPlanets returns 4 naked-eye planets', () => {
  const unix = Date.parse('2026-10-13T20:46:00Z') / 1000;
  const planets = getMajorPlanets(unix);
  assert.equal(planets.length, 4);
  const names = planets.map((p) => p.name);
  assert.ok(names.includes('Venus') && names.includes('Jupiter') && names.includes('Mars') && names.includes('Saturn'));
  for (const p of planets) {
    assert.ok(Number.isFinite(p.ra) && Number.isFinite(p.dec));
  }
});
