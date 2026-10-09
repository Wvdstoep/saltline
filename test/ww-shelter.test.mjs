// docs/BRIDGES-LOCKS-VHF-CONTRACT.md §10.5 — sheltered water, fetch-limited sea state (the doc's shelter.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchLimited, castRays, fetchAt, shelterWeather, RAY_MAX } from '../shared/shelter.js';
import { createShelter } from '../server/shelter.js';

const near = (a, b, eps = 0.001) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const open = { windDir: 270, windSpd: 10, waveH: 2.1, wavePeriod: 6.5, swellH: 1.2, swellDir: 300, sea: 0.35, seaState: 4, seaWord: 'moderate' };
// a lock canal 60 m wide running north–south, 300 m of water upwind to the west... modelled as a mask: water within 300 m west
const canal = (lat0, lon0) => (lat, lon) => { const dx = (lon - lon0) * 111320 * Math.cos(lat0 * Math.PI / 180); return dx > -300 && dx < 30; };

test('1. F 300 m, U 10 m/s → Hs 0.0885 m "calm-rippled", Tp 0.90 s', () => {
  const f = fetchLimited(10, 300); near(f.Hs, 0.0885, 0.0005); near(f.Tp, 0.90, 0.01);
  const w = shelterWeather(open, { windRays: [300, 300, 300, 300, 300, 300, 300], swellRays: [0, 0, 0, 0, 0, 0, 0] });
  near(w.waveH, 0.0885, 0.001); assert.equal(w.seaWord, 'calm-rippled'); assert.equal(w.seaState, 1); assert.equal(w.swellH, 0);
  near(w.wavePeriod, 0.9, 0.01); assert.equal(w.windSpd, 10);
});

test('2. basin F 2 km, U 15 m/s → Hs 0.343 m "smooth"', () => {
  near(fetchLimited(15, 2000).Hs, 0.343, 0.001);
  const w = shelterWeather({ ...open, windSpd: 15 }, { windRays: Array(7).fill(2000) });
  assert.equal(w.seaWord, 'smooth');
});

test('3. open sea (median ray ≥ 20 km) → the open values are returned unchanged (same object)', () => {
  assert.equal(shelterWeather(open, { windRays: Array(7).fill(RAY_MAX) }), open);
  const sh = createShelter({ navigable: () => true });
  assert.equal(sh.apply(open, 52.5, 3.5), open);
});

test('4. LOCK cell → Hs ≤ 0.05, swell 0; DOCK caps the fetch to the dock length', () => {
  const w = shelterWeather({ ...open, windSpd: 25 }, { windRays: Array(7).fill(5000), swellRays: Array(7).fill(RAY_MAX), cell: 'lock' });
  assert.ok(w.waveH <= 0.05); assert.equal(w.swellH, 0);
  const d = shelterWeather({ ...open, windSpd: 15 }, { windRays: Array(7).fill(8000), cell: 'dock', dockLen: 400 });
  near(d.waveH, fetchLimited(15, 400).Hs, 0.001);
});

test('ray casting over a mask: 300 m of water upwind (west wind) → F ≈ 300 m; the server caches per 200 m cell / 10°', () => {
  const nav = canal(51.89, 4.2288);
  const r = castRays(nav, 51.89, 4.2288, 270);
  assert.equal(r.length, 7); assert.ok(r.every((x) => x <= 350 && x >= 275), r.join(','));
  const f = fetchAt(nav, 51.89, 4.2288, 270); assert.equal(f.exposed, false);
  let t = 0; const sh = createShelter({ navigable: nav, now: () => t });
  const w = sh.apply(open, 51.89, 4.2288);
  assert.ok(w.waveH < 0.1, String(w.waveH)); assert.equal(w.seaWord, 'calm-rippled');   // was "moderate 2.1 m"
  const m0 = sh.stats().misses;
  sh.apply(open, 51.89005, 4.22885); assert.equal(sh.stats().misses, m0); assert.ok(sh.stats().hits >= 1);
  t = 601; sh.apply(open, 51.89, 4.2288); assert.ok(sh.stats().misses > m0);
  const lk = createShelter({ navigable: nav, cellKind: () => 'lock' }).apply({ ...open, windSpd: 20 }, 51.89, 4.2288);
  assert.ok(lk.waveH <= 0.05); assert.equal(lk.swellH, 0);
});
