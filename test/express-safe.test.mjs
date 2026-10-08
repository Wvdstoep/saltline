// V7 step 0 "Fixes first": the express passage always arrives on safe open water (server/safespot.js + game.expressArrival).
// Player report: "express to a harbour sometimes places me in grounded mode". Every arrival must have water ≥ draught + 3 m at
// low water, a clear circle of max(length, 150 m) with ≥ draught + 1 m, no other ship within max(300 m, 2 lengths), lie
// 1.5–2 km out on a harbour's approach, survive 60 s of the server's grounding check, and refuse on land before charging.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { World } from '../server/world.js';
import { carvingsForWorld, harborById, HARBORS } from '../server/harbors.js';
import { Game } from '../server/game.js';
import * as hg from '../server/harborgeom.js';
import { findSafeSpot, spotProblem, harbourAim, clearRadius, separation, SAFE } from '../server/safespot.js';
import { SHIP_CLASSES } from '../shared/constants.js';
import { haversine, destination, bearing } from '../shared/geo.js';
import { tideAt, lowWaterAt } from '../shared/tide.js';

process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
const world = new World().load(carvingsForWorld(), () => {});
// real harbour maps (offline: the cached OSM builds of data/geom where present, else synthetic) in a scratch cache dir
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slexpress-'));
const srcGeom = new URL('../data/geom/', import.meta.url).pathname;
fs.mkdirSync(path.join(tmp, 'geom'), { recursive: true });
try { for (const f of fs.readdirSync(srcGeom)) fs.copyFileSync(path.join(srcGeom, f), path.join(tmp, 'geom', f)); } catch { /* none cached */ }
hg.configure({ dataDir: tmp, offline: true, preload: false, log: () => {} });
hg.init(world);

function fakeSocket() { return { readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); }, close() {} }; }
function mkGame(opts = {}) { const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-express-state.json', harborgeom: hg, ...opts }); g.saveState = () => {}; return g; }
const lastEvent = (ws) => ws.sent.filter((m) => m.t === 'event').at(-1)?.text || '';
function atSea(g, name, pos, cls = 'coaster') {
  const ws = fakeSocket(); const p = g.connect(ws, null, name);
  g.onAction(p, { action: 'undock' });
  p.ship.cls = cls; p.money = 1e9; p.fuel = 1e6;
  Object.assign(p.ship, { lat: pos.lat, lon: pos.lon, hdg: 0, spd: 0, throttle: 0, rudder: 0 });
  p.lastValid = { lat: pos.lat, lon: pos.lon };
  return { p, ws };
}
// What the client's keel check reads (harbour map first, else the world raster), at low water.
const depthLW = (lat, lon) => {
  const pen = hg.landPenetration(lat, lon);
  if (pen != null && pen > 0) return -1;
  const h = pen != null ? hg.patchHeightAt(lat, lon) : null;
  return (h != null ? -h : world.depthAt(lat, lon)) + lowWaterAt(lat, lon);
};
// Independent check of an arrival: depth, clear circle (finer than the finder samples), no structure underneath.
function assertSafe(p, label) {
  const C = SHIP_CLASSES[p.ship.cls], { lat, lon } = p.ship;
  assert.ok(depthLW(lat, lon) >= C.draft + 3 - 1e-6, `${label}: ${depthLW(lat, lon).toFixed(1)} m at low water under a ${C.draft} m keel`);
  const R = clearRadius(C.length);
  for (const r of [R, R * 0.75, R / 2, R / 4]) for (let a = 0; a < 360; a += 10) {
    const q = destination(lat, lon, a, r);
    assert.ok(depthLW(q.lat, q.lon) >= C.draft + 0.5, `${label}: shoal ${depthLW(q.lat, q.lon).toFixed(1)} m at ${r.toFixed(0)} m / ${a}°`);
  }
}
// 60 s of state uploads at 10 Hz from the arrival position (Date.now stubbed): the server's grounding check must never fire.
function assertNoGrounding(g, p, ws, label) {
  const at = { lat: p.ship.lat, lon: p.ship.lon }, realNow = Date.now;
  let t = realNow();
  try {
    Date.now = () => t;
    for (let i = 0; i < 600; i++) {
      t += 100;
      g.onState(p, { lat: at.lat, lon: at.lon, hdg: p.ship.hdg, spd: 0, throttle: 0, rudder: 0 });
      if (i % 10 === 0) g.tick(1);
    }
  } finally { Date.now = realNow; }
  assert.ok(!ws.sent.some((m) => m.t === 'event' && /Aground|rejected/.test(m.text)), `${label}: grounded / rejected after express`);
  assert.ok(haversine(p.ship.lat, p.ship.lon, at.lat, at.lon) < 1, `${label}: the server moved the ship`);
  assert.equal(p.shallowSince, 0);
  const pen = hg.landPenetration(at.lat, at.lon);
  assert.ok(pen == null || pen === 0, `${label}: inside a harbour structure`);
  const depthNow = (pen != null ? -hg.patchHeightAt(at.lat, at.lon) : world.depthAt(at.lat, at.lon)) + tideAt(at.lat, at.lon, g.simTime).height;
  assert.ok(depthNow >= SHIP_CLASSES[p.ship.cls].draft, `${label}: the client keel check would ground (${depthNow.toFixed(1)} m)`);
}

// ------------------------------------------------------------------------------------------------ pure finder
test('safespot: rejects shoal, cramped and crowded spots; finds the nearest safe one', () => {
  // a round island of radius 3 km around (54, 3) with 20 m of water right up to its steep shore
  const C0 = { lat: 54, lon: 3 };
  const dep = (lat, lon) => { const d = haversine(lat, lon, C0.lat, C0.lon); return d < 3000 ? -5 : 20; };
  const o = { draft: 5.5, length: 90, depthLW: dep, others: [] };
  assert.equal(spotProblem(C0.lat, C0.lon, o), 'depth');
  const edge = destination(C0.lat, C0.lon, 90, 3100);
  assert.equal(spotProblem(edge.lat, edge.lon, o), 'room', 'deep enough but the clear circle touches the beach');
  const far = destination(C0.lat, C0.lon, 90, 6000);
  assert.equal(spotProblem(far.lat, far.lon, o), null);
  assert.equal(spotProblem(far.lat, far.lon, { ...o, others: [{ ...destination(far.lat, far.lon, 0, 250), len: 0 }] }), 'traffic');
  assert.equal(spotProblem(far.lat, far.lon, { ...o, others: [{ ...destination(far.lat, far.lon, 0, 350), len: 0 }] }), null);
  const spot = findSafeSpot(C0, { ...o, maxRadiusM: 6000 });
  assert.ok(spot, 'found');
  const d = haversine(spot.lat, spot.lon, C0.lat, C0.lon);
  assert.ok(d >= 3000 + clearRadius(90) - 5 && d <= 3000 + clearRadius(90) + 110, `nearest safe ring (${d.toFixed(0)} m)`);
  assert.equal(findSafeSpot(C0, { ...o, maxRadiusM: 2000 }), null, 'none within a small radius');
  assert.equal(clearRadius(90), 150); assert.equal(clearRadius(300), 300);
  assert.equal(separation(90), 300); assert.equal(separation(190), 380);
});
test('safespot: harbourAim walks the fairway out, else picks the open bearing', () => {
  const a = { lat: 52, lon: 4 };
  const west = (lat, lon) => (lon < 3.99 ? 25 : -3);            // sea to the west only
  const fw = [a, destination(a.lat, a.lon, 270, 800), destination(a.lat, a.lon, 250, 2200)];
  const aim = harbourAim({ anchor: a, fairway: fw, depthLW: west });
  assert.ok(Math.abs(haversine(a.lat, a.lon, aim.lat, aim.lon) - SAFE.APPROACH_M) < 120);
  assert.ok(Math.abs(bearing(aim.lat, aim.lon, a.lat, a.lon) - aim.hdg) < 1e-6);
  const open = harbourAim({ anchor: a, depthLW: west });
  assert.ok(open.brg > 225 && open.brg < 315, `open water bearing ${open.brg}`);
  assert.ok(Math.abs(haversine(a.lat, a.lon, open.lat, open.lon) - SAFE.APPROACH_M) < 5);
});

// ------------------------------------------------------------------------------------------------ every harbour
test('express to every harbour arrives 1.5–2 km out on safe water and never grounds (coaster)', async () => {
  const g = mkGame();
  for (const h of HARBORS) {
    const start = destination(h.lat, h.lon, 0, 60000);
    const { p, ws } = atSea(g, `X${h.id}`.slice(0, 15), start);
    p.shallowSince = Date.now() - 3000; p.lastValid = { lat: 0, lon: 0 }; // stale grounding state from before the passage
    const money = p.money;
    await g.expressPassage(p, h.lat, h.lon);
    assert.match(lastEvent(ws), /Express passage/, `${h.id}: ${lastEvent(ws)}`);
    assert.ok(p.money < money);
    assert.equal(p.shallowSince, 0); assert.deepEqual(p.lastValid, { lat: p.ship.lat, lon: p.ship.lon });
    const a = g.harborAnchor(h), off = haversine(a.lat, a.lon, p.ship.lat, p.ship.lon);
    assert.ok(off >= 900 && off <= 3500, `${h.id}: ${off.toFixed(0)} m off the anchor`);
    const toward = Math.abs(((bearing(p.ship.lat, p.ship.lon, a.lat, a.lon) - p.ship.hdg + 540) % 360) - 180);
    assert.ok(toward < 1, `${h.id}: heading for the entrance`);
    assertSafe(p, h.id);
    assertNoGrounding(g, p, ws, h.id);
    g.disconnect(p); g.players.delete(p.id);
  }
});
test('express with deep hulls: a bulk carrier and a container ship still arrive safe (or are refused uncharged)', async () => {
  const g = mkGame();
  for (const cls of ['bulker', 'boxship']) {
    for (const id of ['rotterdam', 'ijmuiden', 'antwerp', 'hamburg', 'felixstowe', 'le_havre', 'bergen', 'singapore', 'new_york', 'murmansk']) {
      const h = harborById(id);
      const { p, ws } = atSea(g, `${cls}${id}`.slice(0, 15), destination(h.lat, h.lon, 0, 80000), cls);
      const money = p.money, fuel = p.fuel, at = { lat: p.ship.lat, lon: p.ship.lon };
      await g.expressPassage(p, h.lat, h.lon);
      if (/Express passage/.test(lastEvent(ws))) { assertSafe(p, `${cls}→${id}`); assertNoGrounding(g, p, ws, `${cls}→${id}`); }
      else {
        assert.match(lastEvent(ws), /No safe water/, `${cls}→${id}`);
        assert.equal(p.money, money); assert.equal(p.fuel, fuel); assert.deepEqual({ lat: p.ship.lat, lon: p.ship.lon }, at);
        assert.ok(id === 'murmansk', `${cls} refused at ${id}`);
      }
      g.disconnect(p); g.players.delete(p.id);
    }
  }
});

// ------------------------------------------------------------------------------------------------ open sea
test('express to random open-sea points arrives safe and stays afloat', async () => {
  const g = mkGame();
  let seed = 12345; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  let n = 0;
  for (let k = 0; k < 400 && n < 25; k++) {
    const lat = 49 + rnd() * 12, lon = -6 + rnd() * 18;
    if (!(world.depthAt(lat, lon) > 2)) continue;
    n++;
    const { p, ws } = atSea(g, `S${n}`, destination(lat, lon, 90, 40000), n % 3 ? 'coaster' : 'bulker');
    await g.expressPassage(p, lat, lon);
    const ev = lastEvent(ws);
    if (!/Express passage/.test(ev)) { assert.match(ev, /No safe water|on land|Too close/, ev); g.disconnect(p); g.players.delete(p.id); continue; }
    assertSafe(p, `sea ${lat.toFixed(2)},${lon.toFixed(2)}`);
    assertNoGrounding(g, p, ws, `sea ${lat.toFixed(2)},${lon.toFixed(2)}`);
    g.disconnect(p); g.players.delete(p.id);
  }
  assert.ok(n >= 20);
});
test('express keeps clear of other skippers, AI traffic and cutters', async () => {
  const target = { lat: 55.0, lon: 2.0 };
  const ai = [{ id: 'ai1', cls: 'boxship', ...destination(target.lat, target.lon, 90, 100) }, { id: 'ai2', cls: 'coaster', ...destination(target.lat, target.lon, 200, 300) }];
  const g = mkGame({ traffic: { near: (lat, lon, r) => ai.filter((s) => haversine(lat, lon, s.lat, s.lon) <= r), all: () => ai, tick() {} } });
  const other = atSea(g, 'Sitter', target);
  g.cutters.push({ id: 'cx', lat: destination(target.lat, target.lon, 0, 200).lat, lon: target.lon, state: 'patrol' });
  const { p, ws } = atSea(g, 'Mover', { lat: 55.0, lon: 3.5 });
  await g.expressPassage(p, target.lat, target.lon);
  assert.match(lastEvent(ws), /Express passage/);
  const sep = separation(SHIP_CLASSES.coaster.length);
  for (const o of [other.p.ship, ...ai, g.cutters.at(-1)]) assert.ok(haversine(p.ship.lat, p.ship.lon, o.lat, o.lon) >= sep, 'clear of every other hull');
  assert.ok(haversine(p.ship.lat, p.ship.lon, target.lat, target.lon) < 2000, 'still near the requested point');
});
test('express onto land is refused before anything is charged', async () => {
  const g = mkGame();
  const { p, ws } = atSea(g, 'Lander', { lat: 52.3, lon: 3.5 });
  const money = p.money, fuel = p.fuel, clock = p.shipTime, at = { lat: p.ship.lat, lon: p.ship.lon };
  for (const dest of [{ lat: 52.09, lon: 5.12 }, { lat: 51.0, lon: 10.0 }]) { // Utrecht; central Germany
    await g.expressPassage(p, dest.lat, dest.lon);
    assert.match(lastEvent(ws), /on land/);
    assert.equal(p.money, money); assert.equal(p.fuel, fuel); assert.equal(p.shipTime, clock);
    assert.deepEqual({ lat: p.ship.lat, lon: p.ship.lon }, at);
  }
});

// ------------------------------------------------------------------------------------------------ big ports (review)
// Inside a big port the arrival can sit on one of the port's extra harbour patches (server/bigports.js). Those must be
// built before the safe-spot check, or it judges a dock from 550 m raster cells and the client then loads real quays
// around the ship.
test('express into a big port builds the extra harbour patches first and arrives clear of their quays', async () => {
  const g = mkGame();
  for (const [name, dest] of [['Waalhaven', { lat: 51.885, lon: 4.435 }], ['Antwerp docks', { lat: 51.30, lon: 4.32 }], ['Hamburg', { lat: 53.535, lon: 9.95 }]]) {
    const { p, ws } = atSea(g, `BP${name}`.slice(0, 15), destination(dest.lat, dest.lon, 270, 70000));
    await g.expressPassage(p, dest.lat, dest.lon);
    const ev = lastEvent(ws);
    if (!/Express passage/.test(ev)) { assert.match(ev, /No safe water/, `${name}: ${ev}`); g.disconnect(p); g.players.delete(p.id); continue; }
    const sub = [...hg.patchList()].filter((s) => s.sub && haversine(s.lat, s.lon, p.ship.lat, p.ship.lon) < 3200);
    for (const s of sub) if (hg.getHarborGeom(s.id) == null) {
      // a tile with no data never builds (null); every other tile the arrival lies on must be built
      const half = 2240, dy = Math.abs(s.lat - p.ship.lat) * 111000, dx = Math.abs(s.lon - p.ship.lon) * 111000 * Math.cos(s.lat * Math.PI / 180);
      assert.ok(!(dy < half && dx < half && await hg.ensureHarbor(s.id)), `${name}: patch ${s.id} under the arrival was not built before the check`);
    }
    assertSafe(p, name);
    assertNoGrounding(g, p, ws, name);
    g.disconnect(p); g.players.delete(p.id);
  }
});
