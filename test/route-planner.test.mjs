// Route planner v2 (docs/V6-QUICK-CONTRACTS.md §4.9): v1 compatibility, the draught invariant at low water, the Dover
// TSS lanes, harbour patch ends (fairway exit / approach), user waypoints, lowWaterAt, the /api/route query parser,
// storm avoidance, the planner worker, and offline voyages that follow the planned route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { World } from '../server/world.js';
import { carvingsForWorld, harborById, HARBORS } from '../server/harbors.js';
import { buildGraph } from '../server/lanes.js';
import { planRoute, landOnLeg, parseRouteQuery, ROUTE, PLANNER_VERSION, depthLW } from '../server/searoute.js';
import { legViolates, laneOf, edgeAllowed } from '../server/tss.js';
import { RoutePlanner } from '../server/routeworker.js';
import { Game } from '../server/game.js';
import * as TP from '../server/tugpath.js';
import { lowWaterAt, tideAt } from '../shared/tide.js';
import { SHIP_CLASSES } from '../shared/constants.js';
import { haversine, destination } from '../shared/geo.js';

process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
const world = new World().load(carvingsForWorld(), () => {});
const graph = buildGraph(world);
const C = (cls) => SHIP_CLASSES[cls];
const shipOpts = (cls, extra = {}) => ({ draft: C(cls).draft, beam: C(cls).beam, length: C(cls).length, ...extra });
const ll = ([lat, lon]) => ({ lat, lon });
// Open North Sea, > 100 km from any harbour, deep synthetic bathymetry, 95 km apart (test/warp.test.mjs).
const OPEN_A = { lat: 55.0, lon: 3.5 };
const OPEN_B = { lat: 55.0, lon: 2.0 };

// ------------------------------------------------------------------------------------------------ v1 reference
// The v1 planner (server/searoute.js before v6), copied verbatim as the reference for the compatibility test.
function planRouteV1(from, to, { toHarbor = null } = {}) {
  const SLACK_M = 3000, MAX_LINKS = 4;
  const direct = haversine(from.lat, from.lon, to.lat, to.lon);
  if (landOnLeg(world, from, to, SLACK_M, SLACK_M) === 0) return { points: [[to.lat, to.lon]], distM: direct, via: 'direct' };
  const sea = [...graph.nodes.values()].filter((n) => n.kind !== 'harbor');
  const links = (p, slackAtP, harborId) => {
    const out = [];
    if (harborId && graph.nodes.has(harborId)) { const h = graph.nodes.get(harborId); out.push({ id: harborId, d: haversine(p.lat, p.lon, h.lat, h.lon) }); }
    const near = HARBORS.map((h) => ({ h, d: haversine(p.lat, p.lon, h.lat, h.lon) })).filter((x) => x.d < 12000 && x.h.id !== harborId).sort((a, b) => a.d - b.d)[0];
    if (near && graph.nodes.has(near.h.id)) out.push({ id: near.h.id, d: near.d });
    const cand = sea.map((n) => ({ n, d: haversine(p.lat, p.lon, n.lat, n.lon) })).sort((a, b) => a.d - b.d).slice(0, 24);
    for (const { n, d } of cand) { if (out.length >= MAX_LINKS + (harborId ? 1 : 0)) break; if (landOnLeg(world, p, n, slackAtP, 0) === 0) out.push({ id: n.id, d }); }
    return out;
  };
  const ins = links(from, SLACK_M, null), outs = links(to, SLACK_M, toHarbor);
  let best = null;
  for (const a of ins) for (const b of outs) {
    let p2; try { p2 = graph.route(a.id, b.id); } catch { p2 = null; }
    if (!p2 || !p2.length) continue;
    let len = a.d + b.d; for (let i = 1; i < p2.length; i++) len += haversine(p2[i - 1][0], p2[i - 1][1], p2[i][0], p2[i][1]);
    if (!best || len < best.len) best = { len, path: p2 };
  }
  if (!best) return null;
  const pts = [{ lat: from.lat, lon: from.lon }, ...best.path.map((p) => ({ lat: p[0], lon: p[1], canal: p[2] === 1 })), { lat: to.lat, lon: to.lon }];
  const out = []; let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    for (; j > i + 1; j--) { if (pts.slice(i, j).some((p) => p.canal)) continue; if (landOnLeg(world, pts[i], pts[j], i === 0 ? SLACK_M : 0, j === pts.length - 1 ? SLACK_M : 0) === 0) break; }
    out.push(pts[j]); i = j;
  }
  let distM = 0, prev = from; for (const p of out) { distM += haversine(prev.lat, prev.lon, p.lat, p.lon); prev = p; }
  return { points: out.map((p) => [Math.round(p.lat * 1e6) / 1e6, Math.round(p.lon * 1e6) / 1e6]), distM: Math.round(distM), via: 'lanes' };
}

/** Every 400 m sample of every leg (the planner's own spacing), outside `slackStart` / `slackEnd` of the route ends. */
function shallowestOnRoute(from, r, slackStart, slackEnd) {
  const pts = [from, ...r.points.map(ll)];
  const total = r.points.length;
  let min = Infinity, at = null;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], len = haversine(a.lat, a.lon, b.lat, b.lon), n = Math.max(1, Math.ceil(len / ROUTE.STEP_M));
    for (let k = 1; k <= n; k++) {
      const d = (k / n) * len;
      if ((i === 1 && d < slackStart) || (i === total && len - d < slackEnd)) continue;
      const lat = a.lat + (b.lat - a.lat) * (k / n), lon = a.lon + (b.lon - a.lon) * (k / n);
      const dep = depthLW(world, lat, lon);
      if (dep < min) { min = dep; at = { lat, lon, leg: i }; }
    }
  }
  return { min, at };
}

// ------------------------------------------------------------------------------------------------ 1. v1 compatibility
test('planner v2: with tss: false and no draught the three v1 "sea routes" cases are exactly v1', () => {
  for (const [a, b, h] of [['rotterdam', 'hamburg', 'hamburg'], ['oslo', 'rotterdam', 'rotterdam'], ['hamburg', null, null]]) {
    const from = harborById(a), to = b ? harborById(b) : { lat: 56.55, lon: 3.21 };
    const v1 = planRouteV1(from, to, { toHarbor: h }), v2 = planRoute(world, graph, from, to, { toHarbor: h, tss: false });
    assert.ok(v1 && v2, `${a}→${b}`);
    assert.equal(v2.planner, PLANNER_VERSION);
    assert.equal(v2.via, v1.via, `${a}→${b} via`);
    assert.deepEqual(v2.points, v1.points, `${a}→${b} points`);
    assert.equal(v2.distM, Math.round(v1.distM), `${a}→${b} distance`);
    assert.equal(v2.legs.length, 1); assert.equal(v2.draft, 0);
  }
  const direct = planRoute(world, graph, harborById('rotterdam'), { lat: 52.6, lon: 3.9 });
  assert.equal(direct.via, 'direct'); assert.equal(direct.points.length, 1);
});

// ------------------------------------------------------------------------------------------------ 2. draught invariant
function scanWest(lat) {
  for (let lon = 5.2; lon > 2; lon -= 0.0001) { const d = world.depthAt(lat, lon); if (d >= 8 && d <= 10) return { lat, lon }; } // the synthetic shelf is steep: fine steps
  return null;
}
test('planner v2: draught at low water — pilot boat goes straight, a boxship gets deep water or a tidal-passage warning', () => {
  const A = scanWest(52.20), B = scanWest(52.80);
  assert.ok(A && B, 'two 8–10 m points off the Dutch coast');
  const pilot = planRoute(world, graph, A, B, shipOpts('pilot'));
  assert.equal(pilot.via, 'direct', JSON.stringify(pilot.warnings));
  const box = planRoute(world, graph, A, B, shipOpts('boxship'));
  assert.ok(box, 'a boxship route is always laid');
  const need = 14 + 2;
  const { min } = shallowestOnRoute(A, box, 0, 0);
  assert.ok(min >= need || box.warnings.some((w) => w.kind === 'no_draught_route'), `shallowest ${min.toFixed(1)} m`);
  const w = box.warnings.find((x) => x.kind === 'no_draught_route');
  if (w) { assert.equal(w.needM, need); assert.match(w.text, /Tidal passage: .* m at low water, you need 16\.0 m/); }
  // 5 North Sea harbour pairs × coaster
  const ns = HARBORS.filter((h) => h.lat > 51 && h.lat < 58.5 && h.lon > -2 && h.lon < 9);
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < 5; k++) {
    const a = ns[Math.floor(rnd() * ns.length)]; let b = ns[Math.floor(rnd() * ns.length)];
    if (b === a) b = ns[(ns.indexOf(a) + 3) % ns.length];
    const r = planRoute(world, graph, a, b, shipOpts('coaster', { toHarbor: b.id }));
    assert.ok(r, `${a.id}→${b.id}`);
    const s = shallowestOnRoute(a, r, ROUTE.SLACK_M, ROUTE.SLACK_M);
    assert.ok(s.min >= 5.5 + 2 || r.warnings.some((x) => x.kind === 'no_draught_route'), `${a.id}→${b.id}: ${s.min.toFixed(1)} m at ${JSON.stringify(s.at)}`);
    assert.ok(r.minDepthM == null || r.minDepthM >= 7.5 || r.warnings.some((x) => x.kind === 'no_draught_route'));
    assert.equal(r.approach.harbor, b.id); assert.ok(r.marks.some((m) => m.kind === 'approach'));
  }
});

// ------------------------------------------------------------------------------------------------ 3. TSS
function closestToNode(from, r, node) {
  const pts = [from, ...r.points.map(ll)];
  let min = Infinity;
  for (let i = 1; i < pts.length; i++) for (let k = 0; k <= 200; k++) { const t = k / 200; const d = haversine(pts[i - 1].lat + (pts[i].lat - pts[i - 1].lat) * t, pts[i - 1].lon + (pts[i].lon - pts[i - 1].lon) * t, node.lat, node.lon); if (d < min) min = d; }
  return min;
}
test('planner v2: the Dover Strait TSS — south-west-bound lane going west, north-east-bound lane going east', () => {
  const sw = graph.nodes.get('dover_tss_sw'), ne = graph.nodes.get('dover_tss_ne');
  assert.equal(laneOf('dover_tss_sw').flow, 225); assert.equal(laneOf('maas_appr'), null);
  assert.equal(edgeAllowed(graph, 'channel_e', 'dover_tss_sw'), false, 'north-east-bound traffic may not use the south-west lane');
  assert.equal(edgeAllowed(graph, 'dover_tss_sw', 'channel_e'), true);
  assert.equal(edgeAllowed(graph, 'dover_tss_ne', 'dover_tss_sw'), true, 'crossing is allowed');
  const rot = harborById('rotterdam'), ply = harborById('plymouth');
  const west = planRoute(world, graph, rot, ply, shipOpts('coaster', { toHarbor: 'plymouth' }));
  assert.ok(closestToNode(rot, west, sw) < 1000, 'westbound passes the south-west-bound lane');
  assert.ok(closestToNode(rot, west, ne) > 3000, 'and keeps clear of the north-east-bound lane');
  assert.ok(west.marks.some((m) => m.kind === 'tss' && m.flow === 225));
  const east = planRoute(world, graph, ply, rot, shipOpts('coaster', { toHarbor: 'rotterdam' }));
  assert.ok(closestToNode(ply, east, ne) < 1000, 'eastbound passes the north-east-bound lane');
  assert.ok(closestToNode(ply, east, sw) > 3000, 'and keeps clear of the south-west-bound lane');
  assert.ok(east.marks.some((m) => m.kind === 'tss' && m.flow === 45));
  for (const [from, r] of [[rot, west], [ply, east]]) {
    const pts = [from, ...r.points.map(ll)];
    for (let i = 1; i < pts.length; i++) assert.equal(legViolates(pts[i - 1], pts[i]), null, `leg ${i} runs against a lane`);
  }
  const free = planRoute(world, graph, rot, ply, { toHarbor: 'plymouth', tss: false });
  assert.ok(free && !free.marks.some((m) => m.kind === 'tss'), 'tss: false — no lane rule');
});

// ------------------------------------------------------------------------------------------------ 4. harbour patch ends
const ROT_BIN = new URL('../data/geom/rotterdam.bin', import.meta.url).pathname, ROT_JSON = new URL('../data/geom/rotterdam.json', import.meta.url).pathname;
const haveRot = fs.existsSync(ROT_BIN) && fs.existsSync(ROT_JSON);
test('planner v2: out of Rotterdam along the fairway on the 10 m patch, into Rotterdam ending at the fairway', { skip: !haveRot && 'no cached Rotterdam geometry' }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'saltline-route-'));
  fs.mkdirSync(path.join(tmp, 'geom'));
  for (const f of ['rotterdam.json', 'rotterdam.bin']) fs.copyFileSync(path.join(path.dirname(ROT_BIN), f), path.join(tmp, 'geom', f));
  const hg = await import('../server/harborgeom.js');
  hg.configure({ dataDir: tmp, offline: true, preload: false, log: () => {} });
  hg.init(world);
  try {
    assert.ok(await hg.ensureHarbor('rotterdam'));
    const geo = hg.getHarborGeom('rotterdam'), grid = TP.gridFromPatch(hg.getHarborPatch('rotterdam'));
    const berth = geo.berths[0], simTime = 1.79e9;
    const r = planRoute(world, graph, { lat: berth.lat, lon: berth.lon }, harborById('hamburg'), shipOpts('coaster', { toHarbor: 'hamburg', geom: hg, simTime }));
    assert.ok(r, 'a route out of Rotterdam');
    const exit = r.marks.find((m) => m.kind === 'patch_exit');
    assert.ok(exit, 'patch_exit mark'); assert.equal(exit.harbor, 'rotterdam');
    const tide = tideAt(berth.lat, berth.lon, simTime).height;
    for (let i = 0; i <= exit.i; i++) {
      const [x, z] = TP.toXZ(grid, r.points[i][0], r.points[i][1]);
      assert.ok(TP.clearanceAt(grid, x, z) >= 7 + 4 - 0.01, `exit point ${i}: clearance ${TP.clearanceAt(grid, x, z).toFixed(1)}`);
      assert.ok(TP.bedAt(grid, x, z) <= tide - 5.5 + 0.01, `exit point ${i}: bed ${TP.bedAt(grid, x, z).toFixed(1)}`);
    }
    const outer = geo.fairway[geo.fairway.length - 1];
    assert.ok(haversine(r.points[exit.i][0], r.points[exit.i][1], outer[0], outer[1]) < 160, 'the exit ends at the fairway outer end');
    assert.ok(r.minDepthM >= 7.5, `beyond the patch the route keeps 7.5 m at low water (${r.minDepthM})`);
    // inbound from 30 km out: the open-water route ends at the approach point
    const out = destination(geo.anchor.lat, geo.anchor.lon, 300, 30000);
    const r2 = planRoute(world, graph, out, harborById('rotterdam'), shipOpts('coaster', { toHarbor: 'rotterdam', geom: hg, simTime }));
    const lastP = r2.points[r2.points.length - 1];
    assert.ok(haversine(lastP[0], lastP[1], outer[0], outer[1]) <= 1, 'last point = fairway outer end');
    assert.deepEqual(r2.approach, { harbor: 'rotterdam', lat: lastP[0], lon: lastP[1] });
    assert.ok(r2.marks.some((m) => m.kind === 'approach' && m.i === r2.points.length - 1));
  } finally { hg.resetCache(); }
});

// ------------------------------------------------------------------------------------------------ 5. waypoints
test('planner v2: a waypoint on land is moved to deep enough water within 2 km; one leg per requested leg', () => {
  // the first land sample east of the open sea at 52.25 N, then 250 m further inland
  let land = null;
  for (let lon = 3.8; lon < 5; lon += 0.001) if (!world.isWater(52.25, lon)) { land = destination(52.25, lon, 90, 250); break; }
  assert.ok(land && !world.isWater(land.lat, land.lon), 'a point on the Dutch coast');
  const from = { lat: 52.1, lon: 3.2 }, to = { lat: 52.6, lon: 3.6 };
  const r = planRoute(world, graph, from, to, shipOpts('coaster', { wp: [land] }));
  assert.ok(r);
  const w = r.warnings.find((x) => x.kind === 'wp_moved');
  assert.ok(w, JSON.stringify(r.warnings)); assert.match(w.text, /Waypoint 1 moved \d+ m/);
  assert.equal(r.legs.length, 2);
  const moved = r.points[r.legs[0].to];
  assert.ok(haversine(moved[0], moved[1], land.lat, land.lon) <= ROUTE.WP_SNAP_M + 1);
  assert.ok(depthLW(world, moved[0], moved[1]) >= 7.5, 'deep enough for a coaster at low water');
  assert.equal(r.legs[0].from, -1); assert.equal(r.legs[1].to, r.points.length - 1);
});

// ------------------------------------------------------------------------------------------------ 6. low water
test('lowWaterAt: mean low water springs from the tide regions, never above sea level', () => {
  assert.ok(Math.abs(lowWaterAt(53.5, 0.3) - -3.06) < 0.01, 'Humber');
  assert.ok(Math.abs(lowWaterAt(55, 15) - -0.07) < 0.01, 'Baltic');
  assert.ok(Math.abs(lowWaterAt(52, 3) - -1.06) < 0.01, 'Southern North Sea');
  assert.ok(Math.abs(lowWaterAt(0, -30) - -1.06) < 0.01, 'open ocean');
  for (let lat = -60; lat <= 70; lat += 5) for (let lon = -180; lon < 180; lon += 10) assert.ok(lowWaterAt(lat, lon) <= 0);
});

// ------------------------------------------------------------------------------------------------ 7. query parsing
test('parseRouteQuery: /api/route options and their errors', () => {
  const ok = parseRouteQuery({ from: '52.1,3.2', to: '53.5,8.6', harbor: 'hamburg', cls: 'coaster', wp: '52.5,3.5;53,4', avoid: '54,4,50,Babet;55,3,1' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.from, { lat: 52.1, lon: 3.2 }); assert.equal(ok.toHarbor, 'hamburg'); assert.equal(ok.cls, 'coaster');
  assert.equal(ok.wp.length, 2); assert.deepEqual(ok.avoid[0], { lat: 54, lon: 4, radiusM: 50000, name: 'Babet' });
  const bare = parseRouteQuery({ from: '52.1,3.2', to: '53.5,8.6' });
  assert.equal(bare.ok, true); assert.equal(bare.cls, null); assert.equal(bare.toHarbor, null); assert.deepEqual(bare.wp, []); assert.deepEqual(bare.avoid, []);
  const bad = (q) => { const r = parseRouteQuery(q); assert.equal(r.ok, false, JSON.stringify(q)); assert.ok(r.error); };
  bad({ from: '52.1,x', to: '53,4' }); bad({ from: '52.1', to: '53,4' }); bad({ from: '95,3', to: '53,4' }); bad({});
  bad({ from: '52,3', to: '53,4', wp: Array.from({ length: 51 }, () => '52,3').join(';') });
  bad({ from: '52,3', to: '53,4', wp: '52,3;nope' });
  bad({ from: '52,3', to: '53,4', avoid: Array.from({ length: 9 }, () => '54,4,50').join(';') });
  bad({ from: '52,3', to: '53,4', avoid: '54,4,0.5' }); bad({ from: '52,3', to: '53,4', avoid: '54,4,601' });
  bad({ from: '52,3', to: '53,4', cls: 'battleship' }); bad({ from: '52,3', to: '53,4', harbor: 'atlantis' });
  assert.equal(parseRouteQuery({ from: '52,3', to: '53,4', wp: Array.from({ length: 50 }, () => '52,3').join(';') }).ok, true);
});

// ------------------------------------------------------------------------------------------------ 7a. storms
test('planner v2: sails round a storm disc, keeps the direct line when the storm covers both ends', () => {
  const mid = { lat: 55.0, lon: 2.75 };
  const plain = planRoute(world, graph, OPEN_A, OPEN_B, shipOpts('coaster'));
  assert.equal(plain.via, 'direct');
  const round = planRoute(world, graph, OPEN_A, OPEN_B, shipOpts('coaster', { avoid: [{ ...mid, radiusM: 30000, name: 'Babet' }] }));
  assert.ok(round && round.points.length >= 2, 'a detour');
  assert.ok(round.distM > plain.distM, 'longer than the straight line');
  assert.ok(!round.warnings.some((w) => w.kind === 'storm_unavoidable'));
  const pts = [OPEN_A, ...round.points.map(ll)];
  for (let i = 1; i < pts.length; i++) for (let k = 0; k <= 400; k++) {
    const t = k / 400, d = haversine(pts[i - 1].lat + (pts[i].lat - pts[i - 1].lat) * t, pts[i - 1].lon + (pts[i].lon - pts[i - 1].lon) * t, mid.lat, mid.lon);
    assert.ok(d >= 37500 - 50, `leg ${i} comes within ${(d / 1000).toFixed(1)} km of the storm centre`);
  }
  const big = planRoute(world, graph, OPEN_A, OPEN_B, shipOpts('coaster', { avoid: [{ ...mid, radiusM: 400000, name: 'Big' }] }));
  assert.equal(big.via, 'direct'); assert.equal(big.points.length, 1);
  assert.ok(big.warnings.some((w) => w.kind === 'storm_unavoidable' && /No way round storm Big/.test(w.text)));
  assert.deepEqual(planRoute(world, graph, OPEN_A, OPEN_B, shipOpts('coaster', { avoid: [] })), plain);
});

// ------------------------------------------------------------------------------------------------ 8. the worker
test('RoutePlanner: the worker answers like inline planning, skippers first, timeouts restart it, the queue is bounded', { timeout: 30000 }, async () => {
  const inline = new RoutePlanner({ world, graph, inline: true });
  const P = new RoutePlanner({ world, graph });
  try {
    const order = [];
    const lows = [0, 1, 2, 3, 4].map((i) => P.plan(harborById('oslo'), harborById('rotterdam'), { toHarbor: 'rotterdam' }, { priority: 'low' }).then(() => order.push(`low${i}`)));
    const high = P.plan(harborById('rotterdam'), harborById('hamburg'), { toHarbor: 'hamburg' }).then((r) => { order.push('high'); return r; });
    const rw = await high; await Promise.all(lows);
    assert.equal(order[0], 'high', order.join(','));
    const ri = await inline.plan(harborById('rotterdam'), harborById('hamburg'), { toHarbor: 'hamburg' });
    assert.equal(rw.distM, ri.distM, 'rotterdam→hamburg');
    const [w2, i2] = await Promise.all([P.plan(harborById('oslo'), harborById('rotterdam'), shipOpts('coaster', { toHarbor: 'rotterdam' })), inline.plan(harborById('oslo'), harborById('rotterdam'), shipOpts('coaster', { toHarbor: 'rotterdam' }))]);
    assert.equal(w2.distM, i2.distM, 'oslo→rotterdam');
    const st = P.stats();
    assert.ok(st.done >= 7 && st.failed === 0 && st.queued === 0 && st.inFlight === 0, JSON.stringify(st));
  } finally { P.close(); }
  const T = new RoutePlanner({ world, graph, timeoutMs: 1 });
  try {
    assert.equal(await T.plan(harborById('rotterdam'), harborById('hamburg'), shipOpts('coaster', { toHarbor: 'hamburg' })), null);
    assert.ok(T.stats().restarts >= 1 && T.stats().failed >= 1);
  } finally { T.close(); }
  const Q = new RoutePlanner({ world, graph, maxQueue: 1 });
  try {
    const a = Q.plan(harborById('rotterdam'), harborById('hamburg'), {}), b = Q.plan(harborById('rotterdam'), harborById('hamburg'), {});
    assert.equal(Q.full(), true);
    assert.equal(await b, null, 'the overflow is refused');
    assert.ok((await a)?.distM > 0);
    assert.equal(Q.stats().failed, 1);
  } finally { Q.close(); }
});

// ------------------------------------------------------------------------------------------------ offline voyages
function fakeSocket() { return { readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); }, close() {} }; }
function mkGame() { const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-route-planner-state.json' }); g.saveState = () => {}; g.rnd = () => 0.5; return g; }
function atSea(g, name, pos) {
  const ws = fakeSocket(); const p = g.connect(ws, null, name);
  g.onAction(p, { action: 'undock' });
  Object.assign(p.ship, { lat: pos.lat, lon: pos.lon, hdg: 0, spd: 0, throttle: 0, rudder: 0 });
  p.lastValid = { lat: pos.lat, lon: pos.lon };
  return { p, ws };
}
test('offline voyage: the crew sails a planned route round the Hook of Holland waypoint by waypoint', () => {
  const from = { lat: 51.86, lon: 3.85 }, to = { lat: 52.16, lon: 4.2 };
  const r = planRoute(world, graph, from, to, shipOpts('coaster', { wp: [{ lat: 52.0, lon: 3.92 }] }));
  assert.ok(r && r.points.length >= 2 && r.points.length <= 6, JSON.stringify(r?.points));
  const g = mkGame(); const { p, ws } = atSea(g, 'Crew', from);
  g.onAction(p, { action: 'set_voyage', route: r.points, throttle: 0.8 });
  assert.equal(p.voyage.route.length, r.points.length); assert.equal(p.voyage.i, 0);
  assert.match(ws.sent.filter((m) => m.t === 'event').at(-1).text, /Course laid in: \d+ waypoints?, \d+ nm/);
  g.disconnect(p);
  let steps = 0;
  while (p.voyage && steps < 20000) { g.simulateOffline(p, 1); steps++; }
  assert.equal(p.voyage, null, 'the voyage ended');
  const logText = (p.log || []).map((l) => l.text).join(' | ');
  assert.doesNotMatch(logText, /shoal water/);
  assert.match(logText, /reached the waypoint and stopped engines/);
  assert.ok(haversine(p.ship.lat, p.ship.lon, to.lat, to.lon) < 400, 'at the last point');
});
test('offline voyage: a legacy { lat, lon } voyage still works; harbour approaches are sailed at harbour speed', () => {
  const g = mkGame();
  const { p } = atSea(g, 'Old', OPEN_A);
  p.voyage = { lat: OPEN_A.lat + 0.02, lon: OPEN_A.lon, throttle: 0.7, setAt: Date.now() }; // saved by v0.5
  g.disconnect(p);
  g.simulateOffline(p, 1);
  assert.deepEqual(p.voyage.route, [[OPEN_A.lat + 0.02, OPEN_A.lon]]); assert.equal(p.voyage.i, 0);
  let n = 0; while (p.voyage && n < 5000) { g.simulateOffline(p, 1); n++; }
  assert.equal(p.voyage, null); assert.ok(haversine(p.ship.lat, p.ship.lon, OPEN_A.lat + 0.02, OPEN_A.lon) < 400);
  g.onAction(p, { action: 'set_voyage', lat: 55.1, lon: 3.5, throttle: 0.7 });
  assert.deepEqual(p.voyage.route, [[55.1, 3.5]]);
  // 2 km off the Rotterdam harbour point: at most 6 kn of telegraph however hard the crew was told to go
  const rot = harborById('rotterdam');
  const g2 = mkGame(); const s = atSea(g2, 'Slow', destination(rot.lat, rot.lon, 270, 2000));
  Object.assign(s.p.ship, { throttle: 1, spd: 12, hdg: 270 });
  g2.onAction(s.p, { action: 'set_voyage', route: [[rot.lat, rot.lon - 0.2]], throttle: 1, harbor: 'rotterdam' });
  assert.equal(s.p.voyage.harbor, 'rotterdam');
  g2.disconnect(s.p);
  g2.simulateOffline(s.p, 1);
  assert.ok(s.p.ship.throttleCmd <= 6 / 14 + 1e-9, `throttle ${s.p.ship.throttleCmd}`);
  // a refused route
  g2.onAction(s.p, { action: 'set_voyage', route: [[999, 3]] });
  assert.equal(s.p.voyage.harbor, 'rotterdam', 'a bad route leaves the voyage as it was');
});
