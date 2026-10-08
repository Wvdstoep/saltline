// Berth guidance (V5-PLAN item 2): the water-only leading-line planner (public/js/berthplan.js, pure) and the server's
// choice of the berth to guide to (server/berthguide.js + game.nearBerthFor).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as BP from '../public/js/berthplan.js';
import { pickGuideBerth, fittingBerthWithin, GUIDE } from '../server/berthguide.js';
import { destination, haversine } from '../shared/geo.js';
import { World } from '../server/world.js';
import { carvingsForWorld, harborById } from '../server/harbors.js';
import { Game } from '../server/game.js';

const M = BP.MASK;
const RES = 10;
/** A synthetic harbour: n×n water, land in the south, a basin cut into it, two breakwaters with a 120 m gap, a shoal. */
function harbour(n = 120) {
  const mask = new Uint8Array(n * n).fill(M.WATER), heights = new Uint8Array(n * n).fill(128 - 15 * 4); // 15 m deep
  const set = (i0, j0, i1, j1, code, depth) => { for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { mask[j * n + i] = code; if (depth != null) heights[j * n + i] = 128 - Math.round(depth * 4); } };
  set(0, 80, n - 1, n - 1, M.LAND, -5);              // the shore (land: negative depth)
  set(30, 80, 70, 104, M.WATER, 12);                  // the basin cut into the land
  set(32, 102, 68, 104, M.QUAY, -2);                  // the quay at its head (north face at j = 102)
  set(0, 60, 44, 62, M.BREAKWATER, -3);               // west breakwater …
  set(56, 60, n - 1, 62, M.BREAKWATER, -3);           // … east breakwater: the only way in is the gap i 45..55 (110 m)
  set(80, 30, 95, 45, M.SHALLOW, 2);                  // a shoal outside
  const sdf = BP.computeClearance(mask, n, RES);
  return { n, res: RES, mask, sdf, heights };
}
const blocked = (g, p) => BP.isObstacle(g.mask[Math.floor(p.j) * g.n + Math.floor(p.i)]);
function walk(g, pts, fn) { // call fn at every 0.25 cell along the polyline
  for (let k = 0; k + 1 < pts.length; k++) {
    const a = pts[k], b = pts[k + 1], L = Math.hypot(b.i - a.i, b.j - a.j), steps = Math.max(1, Math.ceil(L / 0.25));
    for (let s = 0; s <= steps; s++) fn({ i: a.i + ((b.i - a.i) * s) / steps, j: a.j + ((b.j - a.j) * s) / steps });
  }
}

test('clearance field: positive in water, negative inside obstacles, metres to the nearest obstacle', () => {
  const g = harbour();
  const k = (i, j) => j * g.n + i;
  assert.ok(g.sdf[k(50, 30)] > 250, 'open water far from everything');
  assert.ok(g.sdf[k(50, 61)] > 0 && g.sdf[k(50, 61)] < 60, 'in the breakwater gap: water, ~50 m to either head');
  assert.ok(g.sdf[k(20, 61)] < 0, 'inside the breakwater');
  assert.ok(Math.abs(g.sdf[k(50, 101)] - 5) < 1, 'the cell next to the quay face is half a cell (5 m) off it');
});

test('A*: reaches the berth through the breakwater gap, never crosses land, keeps clearance', () => {
  const g = harbour();
  const from = { i: 20.5, j: 20.5 }, berth = { i: 50.5, j: 100.6 }; // berth ~16 m off the quay face
  const halfBeam = 7, r = BP.planPath(g, from, berth, { halfBeam, clearance: halfBeam + 10, draft: 5.5 });
  assert.ok(r, 'a route exists');
  const P = r.points;
  assert.deepEqual(P[0], from); assert.deepEqual(P[P.length - 1], berth);
  let crossedGap = false, worst = Infinity;
  walk(g, P, (p) => {
    assert.ok(!blocked(g, p), `on land at ${p.i.toFixed(1)},${p.j.toFixed(1)}`);
    if (p.j >= 60 && p.j <= 63) { crossedGap = true; assert.ok(p.i > 45 && p.i < 56, `crosses the breakwater line in the gap (i=${p.i.toFixed(1)})`); }
    // clearance: outside the two free zones (40 m around the ends) the line keeps half the beam + 10 m — the gap is
    // 110 m wide so that is always possible
    const dEnd = Math.min(Math.hypot(p.i - from.i, p.j - from.j), Math.hypot(p.i - berth.i, p.j - berth.j)) * RES;
    if (dEnd > 60) worst = Math.min(worst, BP.sampleClearance(g, p.i, p.j));
  });
  assert.ok(crossedGap, 'goes through the entrance');
  assert.ok(worst >= halfBeam + 10 - 1.5, `clearance ${worst.toFixed(1)} m ≥ half beam + 10 m`);
  assert.ok(r.lengthM > 800 && r.lengthM < 1400, `sensible length ${r.lengthM.toFixed(0)} m`);
  assert.ok(P.length < 12, `string-pulled to a few legs (${P.length} points)`);
  assert.equal(r.shallow, false);
});

test('A*: a wide ship that does not fit the gap gets no route; blocked harbour → null', () => {
  const g = harbour();
  // 110 m gap: a 120 m beam hull cannot pass (a 90 m one can)
  const r = BP.planPath(g, { i: 20.5, j: 20.5 }, { i: 50.5, j: 100.6 }, { halfBeam: 60, clearance: 70, freeR: 40 });
  assert.equal(r, null);
  assert.ok(BP.planPath(g, { i: 20.5, j: 20.5 }, { i: 50.5, j: 92.5 }, { halfBeam: 45, clearance: 55, freeR: 40 }), 'a 90 m beam squeezes through');
  const closed = harbour();
  for (let i = 45; i <= 55; i++) for (let j = 60; j <= 62; j++) closed.mask[j * closed.n + i] = M.BREAKWATER;
  const shut = { ...closed, sdf: BP.computeClearance(closed.mask, closed.n, RES) };
  assert.equal(BP.planPath(shut, { i: 20.5, j: 20.5 }, { i: 50.5, j: 100.6 }, { halfBeam: 7 }), null, 'no way in');
});

test('A*: avoids water shallower than the draught when there is a way round, and prefers the fairway', () => {
  const g = harbour();
  // from north of the shoal to a point south of it: the straight line crosses the 2 m shoal
  const from = { i: 87.5, j: 20.5 }, to = { i: 87.5, j: 54.5 };
  const r = BP.planPath(g, from, to, { halfBeam: 5, draft: 5 });
  assert.ok(r && !r.shallow);
  walk(g, r.points, (p) => assert.ok(BP.depthAtCell(g, p.i, p.j) >= 5, `shallow at ${p.i.toFixed(1)},${p.j.toFixed(1)}`));
  const shallowBoat = BP.planPath(g, from, to, { halfBeam: 2, draft: 1 }); // a dinghy goes straight over
  assert.ok(shallowBoat.lengthM < r.lengthM - 50, 'a shallow-draught boat takes the short way');
  // a fairway strip along i = 75 pulls a long route onto it
  const fw = harbour();
  for (let j = 5; j < 58; j++) for (let i = 73; i <= 77; i++) if (fw.mask[j * fw.n + i] === M.WATER) fw.mask[j * fw.n + i] = M.FAIRWAY;
  const grid = { ...fw, sdf: BP.computeClearance(fw.mask, fw.n, RES) };
  const via = BP.planPath(grid, { i: 70.5, j: 6.5 }, { i: 70.5, j: 56.5 }, { halfBeam: 5, clearance: 8 });
  let onFw = 0, total = 0;
  walk(grid, via.points, (p) => { total++; if (grid.mask[Math.floor(p.j) * grid.n + Math.floor(p.i)] === M.FAIRWAY) onFw++; });
  assert.ok(onFw / total > 0.5, `mostly in the fairway (${Math.round((onFw / total) * 100)} %)`);
});

test('A*: starting tight against a quay (a berth) still finds the way out', () => {
  const g = harbour();
  const atBerth = { i: 40.5, j: 101.3 }; // 8 m off the quay face: inside the clearance a moving ship would keep
  const r = BP.planPath(g, atBerth, { i: 50.5, j: 20.5 }, { halfBeam: 7, clearance: 17 });
  assert.ok(r, 'route out');
  walk(g, r.points, (p) => assert.ok(!blocked(g, p)));
});

test('pre-berth point: one ship length astern along the quay, on the side with water', () => {
  const g = harbour();
  const berth = { i: 50.5, j: 100.6 };
  // quay runs east-west (hdg 90): candidates 9 cells east or west, both in the basin
  const p = BP.preBerthPoint(g, berth, 90, 90, 7, { i: 30.5, j: 90.5 });
  assert.ok(p && Math.abs(p.j - berth.j) < 0.01 && Math.abs(Math.abs(p.i - berth.i) - 9) < 0.01);
  assert.equal(p.sign, 1, 'from the west: the ship lies heading 090 (approaches eastward)');
  assert.ok(p.i < berth.i);
  const q = BP.preBerthPoint(g, berth, 90, 90, 7, { i: 69.5, j: 90.5 });
  assert.equal(q.sign, -1, 'from the east: heading 270');
  assert.equal(BP.preBerthPoint(g, { i: 50.5, j: 103.5 }, 90, 90, 7, null), null, 'inside the quay: no room either side');
});

test('entry from outside the patch: the nearest open border water', () => {
  const g = harbour();
  const e = BP.entryFromOutside(g, { i: 50, j: -40 }, 20);
  assert.ok(e && e.j < 4 && Math.abs(e.i - 50) < 3, JSON.stringify(e));
  const w = BP.entryFromOutside(g, { i: -30, j: 90 }, 20); // west of the land: the nearest open edge water is up the west edge
  assert.ok(w && w.i < 4 && w.j < 80);
});

test('polyline helpers: length, densify keeps corners, projection, look-ahead, bearings, speed advice', () => {
  const L = [{ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 100, z: 50 }];
  assert.equal(BP.polyLength(L), 150);
  const d = BP.densify(L, 30);
  assert.ok(d.some((p) => p.x === 100 && p.z === 0), 'corner kept'); assert.equal(d[d.length - 1].s, 150);
  assert.ok(d.every((p, k) => k === 0 || Math.hypot(p.x - d[k - 1].x, p.z - d[k - 1].z) <= 30 + 1e-9));
  const r = BP.resample(L, 40); assert.deepEqual(r.map((p) => p.s), [0, 40, 80, 120, 150]);
  const pr = BP.projectOnPolyline(L, { x: 60, z: 10 }); assert.equal(pr.dist, 10); assert.equal(pr.along, 60);
  assert.deepEqual(BP.pointAlong(L, 125), { x: 100, z: 25 }); assert.deepEqual(BP.pointAlong(L, 999), { x: 100, z: 50 });
  assert.equal(BP.bearingXZ(0, -1), 0); assert.equal(BP.bearingXZ(1, 0), 90); assert.equal(BP.bearingXZ(0, 1), 180); assert.equal(BP.bearingXZ(-1, 0), 270);
  assert.equal(BP.speedAdvice(250).maxKn, 2); assert.match(BP.speedAdvice(250).text, /below 2 kn within 300 m/);
  assert.ok(BP.speedAdvice(5000).maxKn > BP.speedAdvice(800).maxKn);
});

test('real harbour patches: Rotterdam and IJmuiden routes from outside to every berth stay on water, fast', () => {
  for (const id of ['rotterdam', 'ijmuiden']) {
    const file = new URL(`../data/geom/${id}.bin`, import.meta.url), jf = new URL(`../data/geom/${id}.json`, import.meta.url);
    if (!fs.existsSync(file) || !fs.existsSync(jf)) continue;
    const buf = fs.readFileSync(file), n = buf.readUInt16LE(6), res = buf.readFloatLE(8);
    const heights = new Uint8Array(buf.buffer, buf.byteOffset + 28, n * n), mask = new Uint8Array(buf.buffer, buf.byteOffset + 28 + n * n, n * n);
    const grid = { n, res, mask, heights, sdf: BP.computeClearance(mask, n, res) };
    const geom = JSON.parse(fs.readFileSync(jf, 'utf8')).geom;
    const cell = (lat, lon) => ({ i: ((lon - geom.origin.lon) * 111320 * Math.cos((geom.origin.lat * Math.PI) / 180)) / res + n / 2, j: (-(lat - geom.origin.lat) * 110574) / res + n / 2 });
    const fw = geom.fairway[geom.fairway.length - 1], start = cell(fw[0], fw[1]);
    let worstMs = 0, routed = 0;
    for (const b of geom.berths) {
      const goal = cell(b.lat, b.lon);
      const t0 = performance.now();
      const r = BP.planPath(grid, start, goal, { halfBeam: 7, clearance: 17, draft: 5.5, freeR: 74 });
      worstMs = Math.max(worstMs, performance.now() - t0);
      if (!r) continue;
      routed++;
      walk(grid, r.points, (p) => assert.ok(!BP.isObstacle(mask[Math.floor(p.j) * n + Math.floor(p.i)]), `${id} ${b.id}: on land`));
    }
    assert.ok(routed >= geom.berths.length * 0.8, `${id}: ${routed}/${geom.berths.length} berths reachable`);
    assert.ok(worstMs < 250, `${id}: worst plan ${worstMs.toFixed(0)} ms`);
  }
});

test('leaving harbour: quiet about its berths until heading back in, cleared by another harbour or a contract', () => {
  let d = BP.departureStep(null, { prevDocked: undefined, docked: null, nbHarbor: 'rotterdam', remaining: 900 });
  assert.equal(d, null, 'state not known yet (page load at sea): guide');
  d = BP.departureStep(null, { prevDocked: 'rotterdam', docked: null, nbHarbor: 'rotterdam', remaining: 20 });
  assert.deepEqual(d, { harbor: 'rotterdam', max: 20 }, 'just cast off');
  for (const r of [200, 800, 1500]) d = BP.departureStep(d, { prevDocked: null, docked: null, nbHarbor: 'rotterdam', remaining: r });
  assert.equal(d.max, 1500, 'sailing out');
  d = BP.departureStep(d, { prevDocked: null, docked: null, nbHarbor: 'rotterdam', remaining: 1400 });
  assert.ok(d, 'a 100 m wobble is not heading in');
  assert.equal(BP.departureStep(d, { prevDocked: null, docked: null, nbHarbor: 'rotterdam', remaining: 1340 }), null, 'turned back: guide again');
  assert.equal(BP.departureStep(d, { prevDocked: null, docked: null, nbHarbor: 'ijmuiden', remaining: 5000 }), null, 'another harbour');
  assert.equal(BP.departureStep(d, { prevDocked: null, docked: null, nbHarbor: 'rotterdam', contract: true, remaining: 1500 }), null, 'a contract here');
  assert.equal(BP.departureStep(d, { prevDocked: null, docked: 'rotterdam', nbHarbor: null }), null, 'moored again');
});

// ------------------------------------------------------------------------------------------------ server: target berth
const ROT = harborById('rotterdam');
const mkB = (id, brg, dist, extra = {}) => ({ id, name: id, ...destination(ROT.lat, ROT.lon, brg, dist), hdg: 90, length: 200, depth: 12, kind: 'quay', maxLength: 190, ...extra });

test('pickGuideBerth: nearest fitting, free berths first, sticky, alongside wins, fallback names the reason', () => {
  const a = mkB('a', 90, 300), b = mkB('b', 90, 900), c = mkB('c', 270, 200, { kind: 'pontoon' });
  const why = (x) => (x.kind === 'pontoon' ? 'pontoon' : null);
  const at = (brg, d) => destination(ROT.lat, ROT.lon, brg, d);
  let p = at(0, 0);
  let g = pickGuideBerth({ berths: [a, b, c], ...p, why });
  assert.equal(g.berth.id, 'a', 'the pontoon is nearer but does not fit'); assert.equal(g.fits, true);
  g = pickGuideBerth({ berths: [a, b, c], ...p, why, occupied: new Set(['a']) });
  assert.equal(g.berth.id, 'b', 'a is taken: 900 m free beats 300 m × 3');
  // sticky: moving toward b keeps b even when a is a bit nearer …
  p = at(90, 520); g = pickGuideBerth({ berths: [a, b, c], ...p, why, prevId: 'b' });
  assert.equal(g.berth.id, 'b');
  // … but coming alongside a (within 150 m) switches to it
  p = at(90, 380); g = pickGuideBerth({ berths: [a, b, c], ...p, why, prevId: 'b' });
  assert.equal(g.berth.id, 'a');
  assert.ok(GUIDE.ALONGSIDE_M >= 100 && GUIDE.RANGE_M >= 5000);
  // nothing fits: nearest, with the reason
  g = pickGuideBerth({ berths: [c], ...at(0, 0), why });
  assert.equal(g.fits, false); assert.equal(g.why, 'pontoon'); assert.equal(g.berth.id, 'c');
  assert.equal(pickGuideBerth({ berths: [], lat: 52, lon: 4 }), null);
  assert.equal(fittingBerthWithin([a, c], ...Object.values(at(270, 200)), 60, why), null, 'only the pontoon within 60 m');
  assert.equal(fittingBerthWithin([a, c], ...Object.values(at(90, 300)), 60, why).id, 'a');
});

test('game: you.nearBerth leads to a berth that fits from ~6 km out, with water depth and the contract flag', () => {
  process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
  const world = new World().load(carvingsForWorld(), () => {});
  const deep = mkB('rotterdam-b1', 90, 600, { depth: 16 }), shallow = mkB('rotterdam-b2', 90, 300, { depth: 3 }), pont = mkB('rotterdam-b3', 90, 200, { kind: 'pontoon', length: 30 });
  const berths = [shallow, pont, deep];
  const geom = { id: 'rotterdam', name: ROT.name, origin: { lat: ROT.lat, lon: ROT.lon }, anchor: { lat: ROT.lat, lon: ROT.lon }, n: 448, res: 10, berths, fairway: [], features: {} };
  const fake = {
    getHarborGeom: (id) => (id === 'rotterdam' ? geom : null), getHarborPatch: () => null,
    harborAnchor: (id) => { const h = harborById(id); return h ? (id === 'rotterdam' ? geom.anchor : { lat: h.lat, lon: h.lon }) : null; },
    nearestBerth(id, lat, lon) { let best = null; for (const b of berths) { const d = haversine(lat, lon, b.lat, b.lon); if (!best || d < best.distM) best = { berth: b, distM: d, brg: 0 }; } return best; },
    landPenetration: () => null, sdfAt: () => null,
  };
  const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-bg-state.json', harborgeom: fake }); g.saveState = () => {};
  const ws = { readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); }, close() {} };
  const p = g.connect(ws, null, 'Guide');
  g.onAction(p, { action: 'undock' });
  const you = () => [...ws.sent].reverse().find((m) => m.t === 'you').you;
  // 5.5 km west of the harbour: reported (was 2.5 km before), and the deep quay is the target (the others do not fit)
  const far = destination(deep.lat, deep.lon, 270, 5500); p.ship.lat = far.lat; p.ship.lon = far.lon; g.sendYou(p);
  let nb = you().nearBerth;
  assert.ok(nb, 'reported from 5.5 km'); assert.equal(nb.id, 'rotterdam-b1'); assert.equal(nb.fits, true); assert.equal(nb.why, null);
  assert.ok(Math.abs(nb.distM - 5500) < 30); assert.ok(Number.isFinite(nb.water) && nb.water > 13 && nb.water < 19, `water ${nb.water}`);
  assert.equal(nb.contract, false);
  p.jobs.push({ id: 'jx', type: 'freight', to: 'rotterdam', from: 'ijmuiden', qty: 10, good: 'grain', pay: 1, deadline: g.simTime + 1e5 });
  g.sendYou(p); assert.equal(you().nearBerth.contract, true, 'contract to this harbour');
  // too far: nothing
  const tooFar = destination(deep.lat, deep.lon, 270, 7000); p.ship.lat = tooFar.lat; p.ship.lon = tooFar.lon; g.sendYou(p);
  assert.equal(you().nearBerth, null);
  // a feeder (8.5 m draught, 150 m) does not fit the 3 m berth or the pontoon either: same target
  p.ship.cls = 'feeder'; p.ship.lat = shallow.lat; p.ship.lon = shallow.lon + 0.002; g.sendYou(p);
  nb = you().nearBerth; assert.equal(nb.id, 'rotterdam-b1', 'skips the shallow berth it is next to');
});

test('game: tugs take you to the guided berth; Moor picks the fitting berth when a pontoon lies nearer', () => {
  process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
  const world = new World().load(carvingsForWorld(), () => {});
  const near = mkB('rotterdam-b1', 90, 400), far = mkB('rotterdam-b2', 90, 900), pont = mkB('rotterdam-b3', 0, 300, { kind: 'pontoon', length: 30 });
  const quayBy = { ...mkB('rotterdam-b4', 0, 340), name: 'Quay by the pontoon' };
  const berths = [near, far, pont, quayBy];
  const geom = { id: 'rotterdam', name: ROT.name, origin: { lat: ROT.lat, lon: ROT.lon }, anchor: { lat: ROT.lat, lon: ROT.lon }, n: 448, res: 10, berths, fairway: [], features: {} };
  const fake = {
    getHarborGeom: (id) => (id === 'rotterdam' ? geom : null), getHarborPatch: () => null,
    harborAnchor: (id) => { const h = harborById(id); return h ? (id === 'rotterdam' ? geom.anchor : { lat: h.lat, lon: h.lon }) : null; },
    nearestBerth(id, lat, lon) { let best = null; for (const b of berths) { const d = haversine(lat, lon, b.lat, b.lon); if (!best || d < best.distM) best = { berth: b, distM: d, brg: 0 }; } return best; },
    landPenetration: () => null, sdfAt: () => null,
  };
  const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-bg-state2.json', harborgeom: fake }); g.saveState = () => {};
  const ws = { readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); }, close() {} };
  const p = g.connect(ws, null, 'Tugga'); p.money = 1e6;
  g.onAction(p, { action: 'undock' });
  // guidance has settled on b2 (sticky) although b1 is nearer now
  p.guideBerth = { harbor: 'rotterdam', id: 'rotterdam-b2' };
  const at = destination(ROT.lat, ROT.lon, 90, 100); p.ship.lat = at.lat; p.ship.lon = at.lon; p.ship.spd = 0;
  g.sendYou(p);
  assert.equal(p.guideBerth.id, 'rotterdam-b2', 'sticky');
  g.onAction(p, { action: 'tug_assist' });
  assert.equal(p.assist?.berthId, 'rotterdam-b2', 'the tugs go where the card points');
  // Moor next to a pontoon: the pontoon is nearest but does not take a coaster; the quay 40 m on is within 60 m
  const g2 = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-bg-state3.json', harborgeom: fake }); g2.saveState = () => {};
  const ws2 = { readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); }, close() {} };
  const q = g2.connect(ws2, null, 'Moory');
  g2.onAction(q, { action: 'undock' });
  const by = destination(ROT.lat, ROT.lon, 0, 315); q.ship.lat = by.lat; q.ship.lon = by.lon; q.ship.spd = 0.5;
  g2.onAction(q, { action: 'dock' });
  assert.equal(q.docked, 'rotterdam'); assert.equal(q.berth?.id, 'rotterdam-b4');
});

