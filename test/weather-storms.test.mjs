// Sea state from real data and storms: game storm cells over real weather (the "Regina 69 %" report), the Douglas /
// Beaufort scales, real-storm detection from Open-Meteo data, and the Open-Meteo daily quota.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { overlayStorms, stormMaxWind, windSea, windProfile } from '../server/stormfield.js';
import { detectRealStorms, RealStorms, isSevere, seaAreaName } from '../server/realstorms.js';
import { WeatherService, CELL_COST } from '../server/weather.js';
import { douglas, seaStateWord, beaufort, seaForBeaufort } from '../shared/seastate.js';
import { destination } from '../shared/geo.js';
import { World } from '../server/world.js';
import { carvingsForWorld } from '../server/harbors.js';
import { Game } from '../server/game.js';

const FIX = JSON.parse(fs.readFileSync(new URL('./fixtures/weather/openmeteo-gale.json', import.meta.url), 'utf8'));
const NOW = 1_790_000_000;   // sim seconds
const realBase = () => ({ wind: { u: 7, v: 7, spd: Math.hypot(7, 7), dir: 225, gust: 13 }, sea: 0.3, storm: 0, rain: 0, waves: { height: 1.8, dir: 230, period: 6 }, swell: { height: 0.6, dir: 300, period: 9 }, visibility: 20000, pressure: 1012, temp: 12, cloud: 0.4, source: 'open-meteo' });
const regina = () => ({ id: 's1', name: 'Regina', lat: 57.8, lon: 3.5, radiusKm: 150, intensity: 0.69, driftDir: 60, driftMs: 8, born: NOW - 4 * 3600 });
const at = (st, brg, km) => destination(st.lat, st.lon, brg, km * 1000);

test('stormfield: inside a game storm over real data the wind, gusts and sea rise to a dangerous sea; pressure and visibility fall', () => {
  const st = regina(), base = realBase();
  const p = at(st, 30, 0.4 * st.radiusKm);   // near the radius of maximum wind
  const w = overlayStorms(base, [st], p.lat, p.lon, NOW);
  assert.ok(stormMaxWind(0.69) > 28.4 && stormMaxWind(0.69) < 30, 'Regina 69 % peaks at Bft 11');
  assert.ok(w.wind.spd >= 24.5, `wind ${w.wind.spd}`); assert.ok(beaufort(w.wind.spd) >= 10);
  assert.ok(w.wind.gust > w.wind.spd * 1.25);
  assert.ok(w.waves.height >= 6 && w.waves.height <= 14, `Hs ${w.waves.height}`); assert.equal(douglas(w.waves.height).word, 'high');
  assert.ok(w.waves.period > 10, 'storm sea is long-period');
  assert.ok(w.pressure < 990 && w.visibility < 3000 && w.rain > 0.5 && w.storm > 0.8 && w.cloud > 0.8);
  assert.equal(w.source, 'open-meteo'); assert.equal(w.stormName, 'Regina'); assert.equal(w.stormKind, 'game');
  assert.deepEqual(base, realBase(), 'the base sample is not mutated');
  // deterministic: same inputs → same weather (every player sees the same storm)
  assert.deepEqual(overlayStorms(realBase(), [regina()], p.lat, p.lon, NOW), w);
});

test('stormfield: outside the storm the real data is unchanged; swell runs out ahead of the track', () => {
  const st = regina(), base = realBase();
  const far = at(st, 200, 5 * st.radiusKm);
  assert.equal(overlayStorms(base, [st], far.lat, far.lon, NOW), base, 'beyond 4 R: the base itself');
  const ahead = at(st, st.driftDir, 2 * st.radiusKm), behind = at(st, st.driftDir + 180, 2 * st.radiusKm);
  const wa = overlayStorms(base, [st], ahead.lat, ahead.lon, NOW), wb = overlayStorms(base, [st], behind.lat, behind.lon, NOW);
  assert.ok(Math.abs(wa.wind.spd - base.wind.spd) < 1e-9 && wa.waves.height === base.waves.height, 'no storm wind / sea at 2 R');
  assert.ok(wa.swell.height > base.swell.height + 1 && wa.swell.period > 11, 'storm swell ahead');
  assert.ok(wa.swell.height > wb.swell.height, 'more swell ahead than behind');
  assert.equal(overlayStorms(base, [], 57, 3, NOW), base);
});

test('stormfield: smooth edges — no jumps along a line through the storm', () => {
  const st = regina(), base = realBase();
  let prev = null, maxJ = { spd: 0, hs: 0, vis: 0, p: 0, rain: 0 };
  for (let km = -700; km <= 700; km += 2) {   // a chord 30 km off the centre (the centre itself is a vortex singularity)
    const q = destination(at(st, 30, 30).lat, at(st, 30, 30).lon, 120, km * 1000), w = overlayStorms(base, [st], q.lat, q.lon, NOW);
    if (prev) {
      maxJ.spd = Math.max(maxJ.spd, Math.abs(w.wind.spd - prev.wind.spd)); maxJ.hs = Math.max(maxJ.hs, Math.abs(w.waves.height - prev.waves.height));
      maxJ.vis = Math.max(maxJ.vis, Math.abs(w.visibility - prev.visibility)); maxJ.p = Math.max(maxJ.p, Math.abs(w.pressure - prev.pressure)); maxJ.rain = Math.max(maxJ.rain, Math.abs(w.rain - prev.rain));
    }
    prev = w;
  }
  assert.ok(maxJ.spd < 1.5 && maxJ.hs < 0.35 && maxJ.vis < 800 && maxJ.p < 1.5 && maxJ.rain < 0.06, JSON.stringify(maxJ));
  // the radial profile is continuous at the radius of maximum wind and reaches 0 at the edge
  assert.ok(Math.abs(windProfile(0.3499) - windProfile(0.3501)) < 1e-3 && windProfile(1.35) === 0 && windProfile(0.35) === 1);
});

test('stormfield: wind-sea growth respects fetch, duration and the fully developed limit', () => {
  const a = windSea(25, 50e3, 1e9), b = windSea(25, 500e3, 1e9), c = windSea(25, 5000e3, 3 * 3600), d = windSea(25, 1e9, 1e9);
  assert.ok(a.hs < b.hs && c.hs < d.hs, 'longer fetch / duration → bigger sea');
  assert.ok(Math.abs(d.hs - 0.0214 * 625) < 1e-6, 'fully developed Pierson-Moskowitz');
  assert.equal(windSea(0, 1e6, 1e6).hs, 0);
  assert.ok(windSea(40, 1e9, 1e9).hs <= 16);
});

test('Douglas sea-state scale by significant wave height, Beaufort by wind', () => {
  const cases = [[0, 'calm-glassy'], [0.07, 'calm-rippled'], [0.3, 'smooth'], [1, 'slight'], [2, 'moderate'], [3, 'rough'], [5, 'very rough'], [7.5, 'high'], [12, 'very high'], [15, 'phenomenal']];
  for (const [h, word] of cases) assert.equal(seaStateWord(h), word, `${h} m`);
  assert.deepEqual([0.1, 0.5, 1.25, 2.5, 4, 6, 9, 14].map((h) => douglas(h).code), [2, 3, 4, 5, 6, 7, 8, 9], 'band edges belong to the next code');
  assert.equal(douglas(NaN).code, 0); assert.equal(douglas(-1).code, 0);
  assert.deepEqual([0, 0.3, 3.3, 5.5, 13.8, 17.2, 20.8, 24.4, 28.5, 32.7, 50].map(beaufort), [0, 1, 2, 4, 6, 8, 9, 9, 11, 12, 12]);
  // the debug forcing produces a sea whose own labels match the force asked for
  for (let f = 0; f <= 12; f++) { const s = seaForBeaufort(f); assert.equal(beaufort(s.windSpd), f, `Bft ${f}`); }
  assert.equal(douglas(seaForBeaufort(0).waveH).word, 'calm-glassy'); assert.equal(douglas(seaForBeaufort(11).waveH).word, 'very high');
});

// ---- real storms --------------------------------------------------------------------------------------------------
function fixtureFetch(calls) {
  return async (url) => {
    calls.push(url);
    const u = new URL(url), lats = u.searchParams.get('latitude').split(',').map(Number), lons = u.searchParams.get('longitude').split(',').map(Number);
    const src = url.includes('marine') ? FIX.marine : FIX.forecast;
    const pick = lats.map((la, i) => src.find((r) => Math.abs(r.latitude - la) < 0.01 && Math.abs(r.longitude - lons[i]) < 0.01) || { latitude: la, longitude: lons[i], current: url.includes('marine') ? {} : { wind_speed_10m: 5, wind_direction_10m: 200 } });
    return { ok: true, json: async () => (pick.length === 1 ? pick[0] : pick) };
  };
}

test('real storms: detection on an Open-Meteo fixture finds the North Sea gale and the Atlantic high-seas area', async () => {
  let t = Date.parse('2026-10-09T12:00:00Z');
  const ws = new WeatherService({ fetchImpl: fixtureFetch([]), now: () => t, dailyLimit: 9000 });
  ws.forceOff = false;
  const pts = FIX.forecast.map((r) => ({ lat: r.latitude, lon: r.longitude }));
  const samples = await ws.fetchBatch(pts, 'scan');
  assert.equal(samples.length, pts.length);
  assert.ok(samples.every((s) => s.marine && Number.isFinite(s.waves.height)), 'marine data parsed per location');
  assert.ok(ws.cells.size >= pts.length - 1, 'scan samples also warm the weather cache');
  const storms = detectRealStorms(samples, { gridDeg: 2, now: t });
  assert.equal(storms.length, 2, JSON.stringify(storms.map((s) => s.name)));
  const ns = storms.find((s) => s.area === 'North Sea'), atl = storms.find((s) => s.area === 'North Atlantic');
  assert.ok(ns && atl);
  assert.equal(ns.kind, 'real'); assert.ok(ns.bft >= 9 && ns.windMs >= 20.8 && ns.hs >= 6, JSON.stringify(ns));
  assert.ok(Math.abs(ns.lat - 58) < 1.2 && Math.abs(ns.lon - 2) < 1.5, 'centred on the gale');
  assert.ok(ns.radiusKm >= 90 && ns.radiusKm < 600);
  assert.match(ns.name, /gale|storm/i);
  assert.ok(atl.bft < 8 && atl.hs >= 4 && /high seas/i.test(atl.name), 'Hs ≥ 4 m alone makes a real storm area');
  assert.ok(!isSevere({ wind: { spd: 12 }, waves: { height: 9 }, marine: false }), 'a wave height synthesised from the wind does not count');
  assert.ok(isSevere({ wind: { spd: 17.2 }, waves: { height: 1 } }));
  // ids are stable across detections; stale data expires
  const again = detectRealStorms(samples, { gridDeg: 2, now: t + 60e3, prev: storms });
  assert.deepEqual(again.map((s) => s.id).sort(), storms.map((s) => s.id).sort());
  assert.equal(detectRealStorms(samples, { now: t + 4 * 3600e3 }).length, 0, 'older than 3 h: gone');
  assert.equal(seaAreaName(58, 2), 'North Sea'); assert.equal(seaAreaName(-60, 10), 'Southern Ocean');
});

test('real storms: the scanner samples sea points near players in multi-location batches and publishes the areas', async () => {
  let t = Date.parse('2026-10-09T12:00:00Z');
  const calls = [];
  const ws = new WeatherService({ fetchImpl: fixtureFetch(calls), now: () => t, dailyLimit: 9000 });
  ws.forceOff = false;
  const rs = new RealStorms(ws, { now: () => t, gridDeg: 2, nearKm: 600, batch: 40, isWater: (la, lo) => !(la > 50 && la < 52 && lo > 3 && lo < 8) });
  const cand = rs.candidates([{ lat: 57.5, lon: 3 }]);
  assert.ok(cand.length > 10 && cand.length < 80); assert.ok(cand[0].dk <= cand[cand.length - 1].dk, 'nearest first');
  assert.ok(cand.every((c) => !(c.lat > 50 && c.lat < 52 && c.lon > 3 && c.lon < 8)), 'land points skipped');
  rs.tick([{ lat: 57.5, lon: 3 }]);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, 2, 'one forecast + one marine request for the whole batch');
  assert.ok(calls[0].split('latitude=')[1].split('&')[0].split(',').length > 10, 'multi-location');
  assert.ok(rs.list.some((s) => s.area === 'North Sea' && s.bft >= 9));
  rs.tick([{ lat: 57.5, lon: 3 }]); await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, 2, 'no second batch inside minIntervalMs');
  const pub = rs.publicList(); assert.ok(pub.every((s) => s.kind === 'real' && Number.isFinite(s.radiusKm) && s.name));
});

test('real storms reach the chart (stormsPublic kind real) and over the synthetic fallback; game storms carry their Beaufort', () => {
  const world = new World().load(carvingsForWorld(), () => {});
  const list = [{ id: 'rx', kind: 'real', area: 'North Sea', name: 'Storm · North Sea', lat: 57, lon: 3, radiusKm: 200, intensity: 0.7, bft: 10, windMs: 26, gustMs: 34, hs: 8, windDir: 250, pressure: 975, cells: 3, updated: 1, driftDir: 0, driftMs: 0, born: 0, devH: 24 }];
  const fake = { cells: () => list, publicList: () => list.map((s) => ({ ...s })), tick() {} };
  const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-test-state.json', realStorms: fake }); g.saveState = () => {};
  g.storms.push({ id: 's1', name: 'Regina', lat: 50, lon: -20, radiusKm: 150, intensity: 0.69, driftDir: 60, driftMs: 8, born: g.simTime - 3600, dies: g.simTime + 3600 });
  const pub = g.stormsPublic();
  assert.deepEqual(pub.map((s) => s.kind), ['game', 'real']);
  assert.equal(pub[0].bft, 11); assert.ok(pub[0].windMs > 28);
  const w = g.weatherAt(57.3, 3.2);
  assert.equal(w.source, 'synthetic'); assert.ok(w.wind.spd > 20 && w.waves.height > 6 && w.stormKind === 'real', 'a real storm shows over the synthetic fallback');
  const wp = g.weatherPublic(57.3, 3.2);
  assert.equal(wp.seaWord, douglas(wp.waveH).word); assert.ok(wp.bft >= 9 && wp.stormName === 'Storm · North Sea');
});

// ---- quota ----------------------------------------------------------------------------------------------------------
test('quota: ship cells may use the whole day, the harbour sweep 60 %, the storm scan 30 %; nothing exceeds the daily limit', async () => {
  let t = Date.parse('2026-10-09T23:00:00Z');   // late in the UTC day: pacing allows the full shares
  const calls = [];
  const ws = new WeatherService({ fetchImpl: fixtureFetch(calls), now: () => t, dailyLimit: 100, maxConcurrent: 1000 });
  ws.forceOff = false;
  assert.equal(CELL_COST, 2.2, 'forecast (8 vars) + marine (12 vars → 1.2)');
  assert.equal(ws.batchCost(40), 88);
  // scan: 30 units max → one batch of 10 (22 units), a second one refused
  assert.equal((await ws.fetchBatch(FIX.forecast.slice(0, 10).map((r) => ({ lat: r.latitude, lon: r.longitude })), 'scan')).length, 10);
  assert.equal((await ws.fetchBatch(FIX.forecast.slice(0, 10).map((r) => ({ lat: r.latitude, lon: r.longitude })), 'scan')).length, 0, 'scan share spent');
  assert.equal(calls.length, 2);
  // background cells stop at 60 %, urgent ones go on to the limit and no further
  for (let i = 0; i < 60; i++) ws.request(10 + i, -40);
  for (let i = 0; i < 60; i++) ws.request(-10 - i, -60, true);
  for (let k = 0; k < 200; k++) { ws.window = []; ws.tick(); await new Promise((r) => setImmediate(r)); }
  assert.ok(ws.usage.used <= 100, `used ${ws.usage.used}`); assert.ok(ws.usage.used > 100 - CELL_COST - 1e-9, 'urgent cells use the rest');
  const http = calls.length;
  assert.ok(http <= Math.floor(100 / 1.1) + 2, `http ${http}`);
  ws.request(1, 1, true); for (let k = 0; k < 5; k++) { ws.window = []; ws.tick(); }
  assert.equal(calls.length, http, 'quota spent: no more calls today');
  // background never passed 60 % of the limit
  const bg = new WeatherService({ fetchImpl: fixtureFetch([]), now: () => t, dailyLimit: 100, maxConcurrent: 1000 }); bg.forceOff = false;
  for (let i = 0; i < 60; i++) bg.request(10 + i, -40);
  for (let k = 0; k < 100; k++) { bg.window = []; bg.tick(); await new Promise((r) => setImmediate(r)); }
  assert.ok(bg.usage.used <= 60 && bg.usage.used > 55, `background ${bg.usage.used}`);
  // a new UTC day resets the counters
  t += 2 * 3600e3; assert.equal(ws.stats().quota.used, 0); assert.ok(ws.canSpend(CELL_COST, 'urgent'));
  // pacing: early in the day the scan and background get only their share of the hours gone (+15 %)
  const early = new WeatherService({ fetchImpl: fixtureFetch([]), now: () => Date.parse('2026-10-09T00:30:00Z'), dailyLimit: 1000 }); early.forceOff = false;
  assert.ok(early.canSpend(100, 'scan') && !early.canSpend(200, 'scan') && early.canSpend(900, 'urgent'));
});

test('HUD sea field follows the sea: real moderate data reads "moderate", inside Regina it reads high; debug_sea forces a Beaufort sea only with SALTLINE_DEBUG=1', () => {
  const world = new World().load(carvingsForWorld(), () => {});
  const sample = { wind: { spd: 11, dir: 235, gust: 15 }, waves: { height: 1.8, dir: 240, period: 6 }, swell: { height: 0.7, dir: 290, period: 10 }, pressure: 1009, temp: 12, precip: 0, visibility: 18000, cloud: 0.5, fetchedAt: Date.now(), source: 'open-meteo', marine: true };
  const weather = { sample: () => sample, request() {}, tick() {}, stats: () => ({}) };
  const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-test-state.json', weather, realStorms: null }); g.saveState = () => {};
  assert.equal(g.weatherPublic(57.8, 3.5).seaWord, 'moderate', 'the player\'s report: real North Sea data alone');
  g.storms.push({ id: 's1', name: 'Regina', lat: 57.4, lon: 3.2, radiusKm: 150, intensity: 0.69, driftDir: 60, driftMs: 8, born: g.simTime - 3 * 3600, dies: g.simTime + 3600 });
  const w = g.weatherPublic(57.8, 3.5);
  assert.ok(['high', 'very high'].includes(w.seaWord) && w.bft >= 10 && w.stormName === 'Regina' && w.source === 'open-meteo', JSON.stringify(w));
  const ws = { readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); }, close() {} };
  const p = g.connect(ws, null, 'Dbg');
  const prev = process.env.SALTLINE_DEBUG;
  try {
    delete process.env.SALTLINE_DEBUG;
    g.onAction(p, { action: 'debug_sea', bft: 11 }); assert.equal(p.debugBft, undefined, 'refused without SALTLINE_DEBUG');
    process.env.SALTLINE_DEBUG = '1';
    g.onAction(p, { action: 'debug_sea', bft: 11 });
    const you = [...ws.sent].reverse().find((m) => m.t === 'you').you;
    assert.equal(you.weather.forced, true); assert.equal(you.weather.bft, 11); assert.equal(you.weather.seaWord, 'very high');
    g.onAction(p, { action: 'debug_sea', bft: null }); assert.equal(p.debugBft, null);
    assert.ok(!g.privateState(p).weather.forced);
  } finally { if (prev === undefined) delete process.env.SALTLINE_DEBUG; else process.env.SALTLINE_DEBUG = prev; }
});
