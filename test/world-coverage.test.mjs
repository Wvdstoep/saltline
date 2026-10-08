// v7 step 0 — world coverage: harbours on every continent (on water, linked to the lanes), fishing grounds and offshore
// fields worldwide, a lane graph that reaches every harbour without crossing land, contracts with sensible distances,
// weather requested where people sail and AI traffic spread over the globe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { HARBORS, FISHING_GROUNDS, PLATFORMS, CHANNELS, carvingsForWorld, harborById } from '../server/harbors.js';
import { WORLD_HARBORS } from '../server/harbors-world.js';
import { buildGraph, landSamples, LANE_NODES, inDetailRegion } from '../server/lanes.js';
import { generateJob, groundsFor, platformsFor, pickDestination, distKm } from '../server/economy.js';
import { WeatherService } from '../server/weather.js';
import { Traffic } from '../server/traffic.js';
import { Game } from '../server/game.js';
import { findTrades, parseRoutesQuery, MARKET } from '../server/market.js';
import { haversine } from '../shared/geo.js';

process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
const world = new World().load(carvingsForWorld(), () => {});
const logs = [];
const graph = buildGraph(world, { log: (m) => logs.push(m) });
function seeded(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// Rough continent boxes (lat/lon) for the coverage counts.
const CONTINENT = (h) => {
  const { lat, lon } = h;
  if (lon < -25) return lat > 13 || (lat > 7 && lon < -77) ? 'north_america' : 'south_america';
  if (lat < -10 && lon > 110) return 'oceania';
  if (lon > 150 || lon < -140) return lat > 25 ? 'asia' : 'oceania';
  if (lat > 36 && lon < 45) return 'europe';
  if (lat > 30 && lon < 36 && lon > -10) return lat > 34.5 && lon > 25 ? 'europe' : 'africa';
  if (lon < 52 && lat < 30 && !(lon > 34 && lat > 12)) return 'africa';
  return 'asia';
};

test('harbours: 250–350 real ports, unique ids, the old ids kept, every continent covered', () => {
  assert.ok(HARBORS.length >= 250 && HARBORS.length <= 350, `${HARBORS.length} harbours`);
  const ids = new Set();
  for (const h of HARBORS) {
    assert.ok(!ids.has(h.id), `duplicate ${h.id}`); ids.add(h.id);
    assert.match(h.id, /^[a-z0-9_]+$/);
    assert.ok(['mega', 'major', 'regional', 'minor'].includes(h.size), `${h.id} size`);
    assert.match(h.country, /^[A-Z]{2}$/, `${h.id} country`);
    assert.ok(h.fuelMul > 0.6 && h.fuelMul < 1.3, `${h.id} fuelMul`);
    assert.ok(Math.abs(h.lat) < 75 && Math.abs(h.lon) <= 180, `${h.id} position`);
  }
  for (const id of ['rotterdam', 'hamburg', 'singapore', 'santos', 'shanghai', 'new_york', 'cape_town', 'sydney', 'murmansk', 'honolulu']) assert.ok(harborById(id), `kept ${id}`);
  const per = {};
  for (const h of HARBORS) per[CONTINENT(h)] = (per[CONTINENT(h)] || 0) + 1;
  for (const c of ['europe', 'africa', 'asia', 'oceania', 'north_america', 'south_america']) assert.ok(per[c] >= 20, `${c}: ${per[c] || 0} harbours`);
  // the big ones of every region are there
  for (const id of ['algeciras', 'tanger_med', 'jeddah', 'port_klang', 'ningbo', 'qingdao', 'kaohsiung', 'busan', 'kobe', 'durban', 'lagos', 'callao', 'cartagena_co', 'savannah', 'melbourne', 'valencia', 'mundra', 'fujairah']) assert.ok(harborById(id), id);
  assert.ok(HARBORS.filter((h) => !inDetailRegion(h.lat, h.lon)).length >= 250, 'most harbours lie outside the North Sea window');
});

test('every new harbour anchor is open water on the raster without its own basin carving', () => {
  const raw = new World().load(CHANNELS.map((ch) => ({ type: 'channel', pts: ch.pts, widthM: ch.widthM })), () => {});
  const bad = WORLD_HARBORS.filter((h) => !(raw.depthAt(h.lat, h.lon) >= 9)).map((h) => `${h.id} ${raw.depthAt(h.lat, h.lon).toFixed(1)} m`);
  assert.deepEqual(bad, []);
  for (const h of HARBORS) assert.ok(world.depthAt(h.lat, h.lon) >= 9, `${h.id} carved depth`);
});

test('lane graph: no edge over land, no forced harbour link, every harbour and lane node in one connected graph', () => {
  assert.equal(graph.dropped, 0, logs.filter((l) => /dropped/.test(l)).join('\n'));
  assert.deepEqual(logs.filter((l) => /forced/.test(l) && !/\(0 forced\)/.test(l)), []);
  for (const n of LANE_NODES) if (n.kind !== 'river' && !graph.adj.get(n.id)) assert.fail(`lane node ${n.id} has no edge`);
  const seen = new Set(['rotterdam']); const st = ['rotterdam'];
  while (st.length) { const u = st.pop(); for (const e of graph.adj.get(u) || []) if (!seen.has(e.to)) { seen.add(e.to); st.push(e.to); } }
  assert.deepEqual(HARBORS.filter((h) => !seen.has(h.id)).map((h) => h.id), []);
  assert.deepEqual(LANE_NODES.filter((n) => n.kind !== 'river' && !seen.has(n.id)).map((n) => n.id), []);
  for (const n of LANE_NODES) if (n.kind !== 'river' && !graph.adj.get(n.id).every((e) => e.canal)) assert.ok(world.isWater(n.lat, n.lon), `lane node ${n.id} on land`);
});

// A route is good when every non-canal leg is on water (the first/last 3 km of a harbour link may touch the estuary bank).
function badLegs(route) {
  const out = [];
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1], b = route[i];
    if (a[2] === 1) continue; // canal / unresolved strait
    const slack = i === 1 || i === route.length - 1 ? 3000 : 0;
    const n = landSamples(world, { lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] }, slack);
    if (n) out.push(`${i}: ${a[0].toFixed(2)},${a[1].toFixed(2)} → ${b[0].toFixed(2)},${b[1].toFixed(2)} (${n})`);
  }
  return out;
}

test('routes exist between sampled harbour pairs worldwide and no leg crosses land', () => {
  const rnd = seeded(7);
  const pairs = [['rotterdam', 'singapore'], ['santos', 'shanghai'], ['new_york', 'los_angeles'], ['istanbul', 'odesa'], ['hamburg', 'gdynia'],
    ['jeddah', 'ras_tanura'], ['vancouver', 'anchorage'], ['buenos_aires', 'valparaiso'], ['melbourne', 'darwin'], ['kobe', 'vladivostok'],
    ['lagos', 'durban'], ['montevideo', 'ushuaia'], ['houston', 'galveston'], ['seattle', 'oakland'], ['baltimore', 'quebec'], ['lulea', 'piraeus'],
    ['murmansk', 'arkhangelsk'], ['trondheim', 'reykjavik'], ['cebu', 'surabaya'], ['papeete', 'auckland'], ['venice', 'haifa']].filter(([a, b]) => harborById(a) && harborById(b));
  for (let k = 0; k < 160; k++) {
    const a = HARBORS[Math.floor(rnd() * HARBORS.length)], b = HARBORS[Math.floor(rnd() * HARBORS.length)];
    if (a.id !== b.id) pairs.push([a.id, b.id]);
  }
  for (const [a, b] of pairs) {
    const r = graph.route(a, b);
    assert.ok(r && r.length >= 2, `route ${a} → ${b}`);
    assert.deepEqual(badLegs(r), [], `${a} → ${b}`);
  }
});

test('the classic passages are used: Suez, Panama, Bosporus, Kiel Canal, Malacca, Cape Horn route', () => {
  const near = (r, lat, lon, km) => r.some(([la, lo]) => haversine(la, lo, lat, lon) < km * 1000);
  assert.ok(near(graph.route('rotterdam', 'singapore'), 30.5, 32.4, 150), 'Rotterdam → Singapore via Suez');
  assert.ok(near(graph.route('rotterdam', 'singapore'), 2.6, 101.0, 200), '… and the Malacca Strait');
  assert.ok(near(graph.route('new_york', 'los_angeles'), 9.1, -79.7, 120), 'New York → Los Angeles via Panama');
  assert.ok(near(graph.route('istanbul', 'odesa'), 41.2, 29.1, 60), 'Istanbul → Odesa via the Bosporus');
  assert.ok(near(graph.route('hamburg', 'gdynia'), 54.1, 9.7, 60), 'Hamburg → Gdynia via the Kiel Canal');
  assert.ok(near(graph.route('buenos_aires', 'valparaiso'), -54, -67, 400), 'Buenos Aires → Valparaíso round the Horn / Magellan');
});

test('fishing grounds and platforms worldwide: real grounds on water, each served by a harbour board', () => {
  assert.ok(FISHING_GROUNDS.length >= 40, `${FISHING_GROUNDS.length} grounds`);
  assert.ok(PLATFORMS.length >= 35, `${PLATFORMS.length} platforms`);
  for (const id of ['grand_banks', 'georges_bank', 'bering_sea', 'gulf_of_alaska', 'humboldt', 'patagonian_shelf', 'barents_sea', 'norwegian_sea', 'iceland_south', 'faroe_plateau', 'saharan_bank', 'benguela', 'arabian_sea_oman', 'bay_of_bengal', 'south_china_sea', 'yellow_sea', 'zhoushan', 'sea_of_okhotsk', 'gulf_of_thailand', 'chatham_rise', 'se_australia', 'gulf_of_mexico', 'caribbean', 'adriatic']) assert.ok(FISHING_GROUNDS.some((g) => g.id === id), `ground ${id}`);
  for (const id of ['thunder_horse', 'tupi', 'bonga', 'girassol', 'safaniya', 'north_rankin', 'ampa', 'penglai', 'molikpaq', 'heidrun', 'goliat']) assert.ok(PLATFORMS.some((p) => p.id === id), `platform ${id}`);
  const ids = new Set([...FISHING_GROUNDS, ...PLATFORMS].map((x) => x.id));
  assert.equal(ids.size, FISHING_GROUNDS.length + PLATFORMS.length, 'unique ids');
  const offered = new Set(), supplied = new Set();
  for (const h of HARBORS) { for (const { g } of groundsFor(h).slice(0, 3)) offered.add(g.id); for (const { p } of platformsFor(h).slice(0, 3)) supplied.add(p.id); }
  for (const g of FISHING_GROUNDS) {
    assert.ok(world.depthAt(g.lat, g.lon) >= 15, `${g.id} centre on water`);
    assert.ok(g.radiusKm >= 40 && g.radiusKm <= 400 && g.richness > 0.4 && g.richness <= 2, `${g.id} radius/richness`);
    assert.ok(offered.has(g.id), `${g.id} is offered by some harbour`);
  }
  for (const p of PLATFORMS) {
    assert.ok(world.depthAt(p.lat, p.lon) >= 10, `${p.id} on water`);
    assert.ok(supplied.has(p.id), `${p.id} is supplied from some harbour`);
  }
  // remote grounds/fields go to their nearest harbour only, never beyond 800 km
  for (const h of HARBORS) for (const { d } of [...groundsFor(h), ...platformsFor(h)]) assert.ok(d < 800, `${h.id} ${d}`);
});

test('contracts generate everywhere with sensible distances (Singapore, Santos, remote islands)', () => {
  const env = { towSpot: (lat, lon) => world.depthAt(lat, lon) > 20 };
  for (const id of ['singapore', 'santos', 'papeete', 'nuuk', 'mombasa', 'callao', 'tomakomai']) {
    const h = harborById(id), rnd = seeded(id.length * 97);
    const jobs = [];
    for (let k = 0; k < 300; k++) { const j = generateJob(h, 1.8e9, rnd, undefined, env); if (j) jobs.push(j); }
    assert.ok(jobs.length >= 290, `${id}: ${jobs.length} jobs`);
    const trips = jobs.filter((j) => ['freight', 'passengers', 'charter'].includes(j.type));
    for (const j of trips) { assert.ok(harborById(j.to), `${id}: destination ${j.to}`); assert.notEqual(j.to, id); }
    if (!['papeete', 'nuuk'].includes(id)) {
      const short = trips.filter((j) => j.distKm < 2500).length / trips.length;
      assert.ok(short >= 0.75, `${id}: ${(short * 100).toFixed(0)} % of trips under 2,500 km`);
    }
  }
  // Santos: local fishing on the South Brazil Bight and supply runs to the pre-salt fields
  const santos = harborById('santos'), rnd = seeded(5);
  const fish = new Set(), plats = new Set();
  for (let k = 0; k < 60; k++) { fish.add(generateJob(santos, 1.8e9, rnd, 'fishing').ground); plats.add(generateJob(santos, 1.8e9, rnd, 'supply').platform); }
  assert.ok(fish.has('south_brazil'), [...fish].join());
  assert.ok(plats.has('tupi') || plats.has('buzios'), [...plats].join());
  // Singapore: fishing in the region, not in the North Sea
  const sg = harborById('singapore');
  for (let k = 0; k < 20; k++) { const j = generateJob(sg, 1.8e9, rnd, 'fishing'); if (j.type === 'fishing') assert.ok(distKm(sg, FISHING_GROUNDS.find((g) => g.id === j.ground)) < 1200, j.ground); }
  // destination bands: a short-hop port still gets its neighbours most of the time
  const rot = harborById('rotterdam'), r2 = seeded(11); let near = 0;
  for (let k = 0; k < 400; k++) if (pickDestination(rot, r2).d < 700) near++;
  assert.ok(near > 400 * 0.55, `Rotterdam: ${near}/400 destinations within 700 km`);
});

test('weather: no fixed North Sea grid; ships first, then harbours near online players, within the rate limit', async () => {
  const calls = [];
  let t = 1e6;
  const fetchImpl = async (url) => { calls.push(url); return { ok: true, json: async () => ({ current: { wind_speed_10m: 7, wind_direction_10m: 200 } }) }; };
  const w = new WeatherService({ fetchImpl, now: () => t });
  w.forceOff = false;
  w.tick(); await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 0, 'an idle server asks for nothing (the old grid asked for the North Sea)');
  const ships = [{ lat: 1.2, lon: 103.9 }, { lat: -24.0, lon: -46.3 }];
  const n = w.requestAround(ships, HARBORS);
  assert.ok(n > 3 && n <= 40, `${n} harbour cells`);
  assert.deepEqual(new Set(w.queue.slice(0, 2)), new Set(ships.map((s) => w.key(s.lat, s.lon))), 'the ships go first');
  for (const k of w.queue) {
    const [lat, lon] = k.split('|').map(Number);
    assert.ok(ships.some((s) => haversine(s.lat, s.lon, lat, lon) < 450e3), `${k} is near a ship`);
  }
  // urgent request jumps the queue
  w.request(51.9, 4.1, true); assert.equal(w.queue[0], w.key(51.9, 4.1));
  // rate limit: at most 60 cells a minute, 2 at a time
  for (let k = 0; k < 120; k++) w.request(-60 + k, 10);
  for (let k = 0; k < 200; k++) { w.tick(); await new Promise((r) => setImmediate(r)); }
  assert.ok(w.window.length <= 60, `${w.window.length} cells in the last minute`);
  assert.ok(w.cells.size > 0 && w.cells.size <= 60);
});

test('game: the weather sweep follows the players (Singapore), not the North Sea', () => {
  const w = new WeatherService({ fetchImpl: async () => ({ ok: false }), now: () => 1e6 });
  w.forceOff = false;
  const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-wc-test-state.json', weather: w }); g.saveState = () => {};
  const ws = { readyState: 1, send() {}, close() {} };
  const p = g.connect(ws, null, 'Wen');
  g.onAction(p, { action: 'undock' });
  Object.assign(p.ship, { lat: 1.15, lon: 103.9 }); p.lastValid = { lat: 1.15, lon: 103.9 };
  g.lastWxRequest = 0; g.lastWxHarbors = 0; w.queue = []; w.queued.clear(); // (joining asked for the spawn harbour's cell)
  g.requestWeather();
  assert.equal(w.queue[0], w.key(1.15, 103.9), 'the ship first');
  assert.ok(w.queue.length >= 4, `${w.queue.length} cells`);
  for (const k of w.queue) { const [lat, lon] = k.split('|').map(Number); assert.ok(haversine(lat, lon, 1.15, 103.9) < 450e3, `${k} near Singapore`); }
});

test('AI traffic spreads over the world and sails the lanes', () => {
  const tr = new Traffic(world, HARBORS, { rnd: seeded(3) });
  assert.ok(tr.ships.length >= 140, `${tr.ships.length} ships`);
  const outside = tr.ships.filter((s) => !inDetailRegion(s.lat, s.lon));
  assert.ok(outside.length >= tr.ships.length * 0.45, `${outside.length}/${tr.ships.length} outside the North Sea`);
  const areas = new Set(tr.ships.map((s) => CONTINENT(s)));
  assert.ok(areas.size >= 5, [...areas].join());
  // canal legs (Kiel, Suez, Panama, Bosporus…) are the only legs allowed over raster land
  const canalAt = new Set();
  for (const [id, es] of tr.graph.adj) for (const e of es) if (e.canal) { const n = tr.graph.nodes.get(id); canalAt.add(`${n.lat},${n.lon}`); }
  const onCanal = (s) => s.path && s.wp > 0 && canalAt.has(`${s.path[s.wp - 1][0]},${s.path[s.wp - 1][1]}`) && canalAt.has(`${s.path[s.wp][0]},${s.path[s.wp][1]}`);
  for (const s of tr.ships) assert.ok(world.isWater(s.lat, s.lon) || onCanal(s) || haversine(s.lat, s.lon, tr.byId.get(s.at || s.dest).lat, tr.byId.get(s.at || s.dest).lon) < 6000, `${s.id} on water`);
  for (let i = 0; i < 600; i++) tr.tick(5);
  assert.ok(tr.ships.filter((s) => s.state === 'underway').length > 30);
});

test('world market: the all-harbour trade finder stays fast with ~340 harbours and keeps one best row per origin', () => {
  const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-wc-test-state.json' }); g.saveState = () => {};
  const q = parseRoutesQuery({ from: 'all', cls: 'coaster', limit: '50' }).q;
  const t0 = Date.now();
  const r = findTrades(g, null, q);
  assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0} ms`);
  assert.ok(r.trades.length > 10);
  assert.equal(new Set(r.trades.map((t) => t.from)).size, r.trades.length, 'one row per origin');
  for (const t of r.trades) {
    const A = harborById(t.from);
    const rank = HARBORS.filter((h) => h.id !== A.id).map((h) => haversine(A.lat, A.lon, h.lat, h.lon)).sort((a, b) => a - b);
    assert.ok(haversine(A.lat, A.lon, t.toLat, t.toLon) <= rank[MARKET.ALL_NEAREST - 1] + 1, `${t.from} → ${t.to} is among the ${MARKET.ALL_NEAREST} nearest`);
    // the single-origin search finds the same best trade (it scans every destination)
    const one = findTrades(g, null, { ...q, from: t.from, limit: 1 });
    assert.ok(one.trades[0].perTkm >= t.perTkm, `${t.from}`);
  }
});
