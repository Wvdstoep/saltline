// Radar map underlay + traffic / names toggles (public/js/radarmap.js): prefs persistence (storage may throw), traffic
// filtering, label selection / collision-free placement, the incremental map grid (budget, coastline, colours) and the
// rebuild policy (≤ 2 per second, only on movement / range / new data).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RadarMap, MapGrid, MASK, loadPrefs, savePrefs, nextMode, TRAFFIC_MODES, LABEL_MODES, DEFAULTS, filterContacts, trafficSource, placeLabels, cellColor, gridFits, toEN, TUNE } from '../public/js/radarmap.js';

const memStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; };
const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };

test('prefs: defaults, round trip, bad values and throwing storage', () => {
  assert.deepEqual(loadPrefs(null), { ...DEFAULTS });
  assert.deepEqual(loadPrefs(throwing), { ...DEFAULTS });
  assert.equal(savePrefs(throwing, DEFAULTS), false);
  const s = memStore();
  assert.equal(savePrefs(s, { map: false, traffic: 'ais', labels: 'off' }), true);
  assert.deepEqual(loadPrefs(s), { map: false, traffic: 'ais', labels: 'off' });
  s.setItem('saltline.radar', '{"map":"yes","traffic":"boats","labels":"all"}');
  assert.deepEqual(loadPrefs(s), { map: true, traffic: 'all', labels: 'all' });
  s.setItem('saltline.radar', 'not json');
  assert.deepEqual(loadPrefs(s), { ...DEFAULTS });
  assert.equal(DEFAULTS.labels, 'auto');
});

test('modes cycle through every value', () => {
  let t = 'all'; const seenT = [];
  for (let i = 0; i < TRAFFIC_MODES.length; i++) { seenT.push(t); t = nextMode(TRAFFIC_MODES, t); }
  assert.deepEqual(seenT, TRAFFIC_MODES); assert.equal(t, 'all');
  assert.equal(nextMode(LABEL_MODES, 'off'), 'auto');
});

test('traffic filter keeps harbours, jobs, berths and safety contacts in every mode', () => {
  const list = [
    { kind: 'ship', label: 'Player' }, { kind: 'ai', label: 'Sim AI' }, { kind: 'ai', mmsi: 244123456, label: 'Live AIS' },
    { kind: 'harbor', label: 'Rotterdam' }, { kind: 'berth', label: 'Berth' }, { kind: 'job' }, { kind: 'cutter' }, { kind: 'rescue' }, { kind: 'wp' },
  ];
  assert.equal(trafficSource(list[0]), 'player'); assert.equal(trafficSource(list[2]), 'ais'); assert.equal(trafficSource(list[3]), null);
  assert.equal(filterContacts(list, 'all'), list);
  const kinds = (m) => filterContacts(list, m).map((c) => c.label || c.kind);
  assert.deepEqual(kinds('off'), ['Rotterdam', 'Berth', 'job', 'cutter', 'rescue', 'wp']);
  assert.deepEqual(kinds('players'), ['Player', 'Rotterdam', 'Berth', 'job', 'cutter', 'rescue', 'wp']);
  assert.deepEqual(kinds('ais'), ['Sim AI', 'Live AIS', 'Rotterdam', 'Berth', 'job', 'cutter', 'rescue', 'wp']);
  assert.equal(filterContacts(list, 'bogus'), list);
});

// a Rotterdam-like cluster: 30 vessels within a few pixels of each other plus a harbour, the berth and a contract
function cluster() {
  const items = [];
  for (let i = 0; i < 30; i++) { const ax = 5 + (i % 6) * 8, ay = -30 + Math.floor(i / 6) * 8; items.push({ text: `VESSEL ${i}`, x: ax, y: ay - 8, w: 44, h: 11, ax, ay, kind: 'ai', d: 500 + i * 37 }); }
  items.push({ text: 'Rotterdam', x: -30, y: 21, w: 50, h: 12, ax: -30, ay: 30, kind: 'harbor', d: 3000 });
  items.push({ text: 'Berth 7', x: 25, y: 31, w: 36, h: 12, ax: 25, ay: 40, kind: 'berth', d: 900 });
  items.push({ text: 'Tow job', x: -40, y: -51, w: 36, h: 12, ax: -40, ay: -40, kind: 'job', d: 950 });
  return items;
}
const overlap = (a, b) => Math.abs(a.x - b.x) * 2 < a.w + b.w && Math.abs(a.y - b.y) * 2 < a.h + b.h;

test('labels: auto shows the essentials plus the nearest few vessels, nothing overlaps', () => {
  const placed = placeLabels(cluster(), { mode: 'auto', rr: 100 });
  const names = placed.map((p) => p.text);
  assert.ok(names.includes('Berth 7') && names.includes('Tow job'), 'essentials always shown');
  const vessels = placed.filter((p) => p.kind === 'ai');
  assert.ok(vessels.length >= 1 && vessels.length <= TUNE.AUTO_TRAFFIC, `vessel labels ${vessels.length}`);
  // the nearest vessels win
  for (const v of vessels) assert.ok(v.d < 500 + 37 * 2 * TUNE.AUTO_TRAFFIC, `${v.text} is not among the nearest`);
  const nonEss = placed.filter((p) => p.kind !== 'berth' && p.kind !== 'job');
  for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
    if (nonEss.includes(placed[i]) || nonEss.includes(placed[j])) assert.ok(!overlap(placed[i], placed[j]), `${placed[i].text} overlaps ${placed[j].text}`);
  }
  // every non-essential label stays inside the radar circle
  for (const p of nonEss) assert.ok(Math.hypot(Math.abs(p.x) + p.w / 2, Math.abs(p.y) + p.h / 2) <= 100 + 2 + 1e-9, `${p.text} leaves the circle`);
  // and never over the own-ship marker
  for (const p of nonEss) assert.ok(!overlap(p, { x: 0, y: 0, w: 14, h: 14 }));
});

test('labels: all = uncapped but still collision-free; off = essentials only; small radar caps harder', () => {
  const all = placeLabels(cluster(), { mode: 'all', rr: 100 });
  const auto = placeLabels(cluster(), { mode: 'auto', rr: 100 });
  assert.ok(all.length >= auto.length);
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const ess = (p) => p.kind === 'berth' || p.kind === 'job';
    if (!(ess(all[i]) && ess(all[j]))) assert.ok(!overlap(all[i], all[j]), `${all[i].text} / ${all[j].text}`);
  }
  assert.deepEqual(placeLabels(cluster(), { mode: 'off', rr: 100 }).map((p) => p.text).sort(), ['Berth 7', 'Tow job']);
  const sm = placeLabels(cluster(), { mode: 'auto', rr: 100, small: true }).filter((p) => p.kind === 'ai');
  assert.ok(sm.length <= TUNE.AUTO_TRAFFIC_SMALL);
});

test('labels: a label that collides above its marker moves below / beside it', () => {
  const items = [
    { text: 'A', x: 40, y: -8, w: 30, h: 11, ax: 40, ay: 0, kind: 'ship', d: 100 },
    { text: 'B', x: 40, y: -6, w: 30, h: 11, ax: 40, ay: 2, kind: 'ship', d: 200 },
  ];
  const p = placeLabels(items, { mode: 'all', rr: 100 });
  assert.equal(p.length, 2);
  assert.ok(!overlap(p[0], p[1]));
  assert.equal(p[0].text, 'A'); assert.equal(p[0].y, -8, 'the nearest keeps its spot');
});

// ------------------------------------------------------------------------------------------------ grid
// a synthetic coast: land west of 4.0°E, water east of it, a fairway strip, a quay; heights deepen eastwards
function sampler(calls) {
  return (lat, lon) => {
    calls && calls.n++;
    if (lon < 4.0) return { m: MASK.LAND, h: 3 };
    if (lon > 4.01 && lon < 4.012) return { m: MASK.FAIRWAY, h: -16 };
    if (lat > 51.99 && lon < 4.002) return { m: MASK.QUAY, h: 2 };
    return { m: MASK.WATER, h: -(lon - 4) * 1000 };
  };
}
test('grid: colours, coastline, unknown is transparent', () => {
  assert.equal(cellColor(MASK.UNKNOWN, null)[3], 0);
  const shoal = cellColor(MASK.WATER, -1), deep = cellColor(MASK.WATER, -40);
  assert.ok(shoal[1] > deep[1] && shoal[2] > deep[2], 'shallow water is lighter than deep water');
  assert.notDeepEqual(cellColor(MASK.FAIRWAY, -15), cellColor(MASK.WATER, -15));
  assert.notDeepEqual(cellColor(MASK.LAND, 2), cellColor(MASK.WATER, -2));
  const g = new MapGrid(51.98, 4.0, 2500, 64, sampler());
  assert.equal(g.step(1e9), true);
  assert.equal(g.known, 64 * 64);
  const px = (i, j) => Array.from(g.rgba.slice((j * 64 + i) * 4, (j * 64 + i) * 4 + 4));
  assert.deepEqual(px(31, 40), [120, 205, 180, 255], 'land cell next to water is coastline');
  assert.deepEqual(px(5, 40), cellColor(MASK.LAND, 3), 'inland stays land');
  assert.ok(px(60, 40)[2] < px(34, 40)[2], 'water deepens away from the shore');
  const unk = new MapGrid(0, 0, 1000, 16, () => ({}));
  unk.step(1e9);
  assert.equal(unk.known, 0); assert.equal(unk.rgba[3], 0);
});

test('grid: builds incrementally within the budget', () => {
  let t = 0; const clock = () => t;
  const calls = { n: 0 };
  const slow = sampler(calls);
  const g = new MapGrid(51.98, 4.0, 2500, 100, (la, lo) => { t += 0.01; return slow(la, lo); }); // 1 ms per row
  let steps = 0;
  while (!g.step(5, clock)) { steps++; assert.ok(steps < 100); }
  assert.ok(steps >= 15, `${steps} frames for 100 rows at 5 ms`);
  assert.equal(calls.n, 100 * 100);
});

test('gridFits: rebuild after 18 % of the range or a range change', () => {
  const g = { lat: 51.98, lon: 4.0, half: 2000 * TUNE.MARGIN };
  assert.ok(gridFits(g, 51.98, 4.0, 2000));
  assert.ok(gridFits(g, 51.98 + 300 / 110574, 4.0, 2000));
  assert.ok(!gridFits(g, 51.98 + 400 / 110574, 4.0, 2000));
  assert.ok(!gridFits(g, 51.98, 4.0, 5000));
  assert.ok(!gridFits(null, 0, 0, 1));
  const d = toEN(51.98, 4.0, 51.98, 4.0 + 1000 / (111320 * Math.cos(51.98 * Math.PI / 180)));
  assert.ok(Math.abs(d.e - 1000) < 1e-6 && Math.abs(d.n) < 1e-9);
});

test('RadarMap: samples harbour patch > world tile > height raster; rebuilds at most twice a second', () => {
  const app = {
    geoms: { size: 1, coverAt: (la, lo) => (lo > 4.02 ? {} : null), maskAt: () => MASK.QUAY, heightAt: () => 2 },
    terrain: { version: 1, heightAt: (la, lo) => (lo < 4 ? 1 : -12), wtiles: { maskAt: (la, lo) => (lo > 4.01 && lo <= 4.02 ? MASK.DOCK : null) } },
  };
  const rm = new RadarMap(app, { storage: memStore(), ui: false });
  assert.deepEqual(rm.sample(51.98, 4.03), { m: MASK.QUAY, h: 2 });
  assert.deepEqual(rm.sample(51.98, 4.015), { m: MASK.DOCK, h: -12 });
  assert.deepEqual(rm.sample(51.98, 4.005), { m: MASK.WATER, h: -12 });
  assert.deepEqual(rm.sample(51.98, 3.99), { m: MASK.LAND, h: 1 });
  app.terrain.heightAt = () => null;
  assert.equal(rm.sample(51.98, 3.99).m, MASK.UNKNOWN);
  app.terrain.heightAt = () => { throw new Error('swap'); };
  assert.equal(rm.sample(51.98, 3.99).m, MASK.UNKNOWN);
  app.terrain.heightAt = (la, lo) => (lo < 4 ? 1 : -12);

  // rebuild policy (paintCanvas needs a DOM: count finished grids instead)
  let built = 0; rm.paintCanvas = () => { built++; };
  const me = { lat: 51.98, lon: 4.0 };
  let starts = 0;
  let now = 0;
  for (; now <= 10000; now += 100) { const n0 = rm.starts || 0; rm.update(me, 2000, 200, now); starts += (rm.starts || 0) - n0; }
  assert.equal(starts, 1, 'a still ship and unchanged data: one build');
  assert.ok(built >= 1 && rm.grid);
  // moving fast across the map: rebuilds, but never more than 2 per second
  starts = 0;
  const t0 = now;
  for (let i = 0; i < 50; i++, now += 100) { me.lat += 1000 / 110574; const n0 = rm.starts || 0; rm.update(me, 2000, 200, now); starts += (rm.starts || 0) - n0; }
  assert.ok(starts >= 2 && starts <= Math.ceil(((now - t0) / 1000) * 2) + 1, `starts ${starts}`);
  // new data streaming in: rebuild, rate-limited
  me.lat = 51.98; for (let i = 0; i < 30; i++, now += 100) rm.update(me, 2000, 200, now);
  starts = 0;
  for (let i = 0; i < 100; i++, now += 100) { app.terrain.version++; const n0 = rm.starts || 0; rm.update(me, 2000, 200, now); starts += (rm.starts || 0) - n0; }
  assert.ok(starts >= 2 && starts <= 10 / (TUNE.DATA_BUILD_MS / 1000) + 1, `data rebuilds ${starts}`);
});

test('RadarMap: map toggle skips drawing, prefs persist through setPref', () => {
  const store = memStore();
  const rm = new RadarMap({}, { storage: store, ui: false });
  rm.setPref('map', false); rm.setPref('traffic', 'players'); rm.setPref('labels', 'all');
  assert.deepEqual(new RadarMap({}, { storage: store, ui: false }).prefs, { map: false, traffic: 'players', labels: 'all' });
  let drew = false; const ctx = new Proxy({}, { get: () => () => { drew = true; } });
  rm.drawUnderlay(ctx, { lat: 1, lon: 1 }, 2000, 100, 0, 0, 200);
  assert.equal(drew, false);
  assert.equal(rm.filterContacts([{ kind: 'ai' }, { kind: 'ship' }]).length, 1);
});
