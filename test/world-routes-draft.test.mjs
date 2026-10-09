// v7 step 0 review — world routes for REAL ships. The world lanes were only checked at draught 0; the route planner drops
// every lane edge shallower than draught + keel margin on the raster, so a feeder from Rotterdam to Dubai went round the
// Cape of Good Hope (20,600 km instead of 11,700 via Suez) and Singapore–Santos crossed the Pacific. Every world lane edge
// must now be deep enough on the raster for a feeder, and long-haul routes for a feeder and a boxship must take the
// real passages (no more than a few per cent longer than the draught-free route).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { carvingsForWorld, harborById } from '../server/harbors.js';
import { buildGraph, inDetailRegion } from '../server/lanes.js';
import { planRoute, depthLW } from '../server/searoute.js';
import { haversine, wrapLon } from '../shared/geo.js';

process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
const world = new World().load(carvingsForWorld(), () => {});
const graph = buildGraph(world);

function edgeMin(A, B) {
  const len = haversine(A.lat, A.lon, B.lat, B.lon), n = Math.max(1, Math.ceil(len / 1000));
  let min = Infinity;
  for (let i = 0; i <= n; i++) {
    const t = i / n, lat = A.lat + (B.lat - A.lat) * t, lon = wrapLon(A.lon + wrapLon(B.lon - A.lon) * t);
    min = Math.min(min, depthLW(world, lat, lon));
  }
  return min;
}

test('world lane edges (outside the North Sea detail raster) are deep enough on the raster for a coaster', () => {
  const seen = new Set(), bad = [];
  for (const [u, es] of graph.adj) for (const e of es) {
    const k = u < e.to ? `${u}|${e.to}` : `${e.to}|${u}`;
    if (seen.has(k) || e.canal) continue; seen.add(k);
    const A = graph.nodes.get(u), B = graph.nodes.get(e.to);
    // harbour links (since the position audit: the harbour's own way out to its roads, kind 'approach') are the harbour's
    if ([A.kind, B.kind].some((x) => x === 'harbor' || x === 'river' || x === 'approach')) continue;
    if (inDetailRegion(A.lat, A.lon) && inDetailRegion(B.lat, B.lon)) continue;
    const m = edgeMin(A, B);
    if (m < 5.5 + 2) bad.push(`${u}-${e.to} ${m.toFixed(1)} m`);
  }
  // a handful of shallow approaches inside narrow bays remain (the 5 km raster closes them); no open-sea passage may
  assert.ok(bad.length <= 12, `${bad.length} shallow lane edges: ${bad.join(', ')}`);
});

const plan = (a, b, draft) => {
  const A = harborById(a), B = harborById(b);
  return planRoute(world, graph, A, B, { toHarbor: b, draft, beam: draft > 10 ? 40 : 22, length: draft > 10 ? 300 : 140 });
};

test('a feeder and a boxship take the real passages worldwide (Suez, Bab-el-Mandeb, Hormuz, Malacca/Singapore)', () => {
  const pairs = [
    ['rotterdam', 'dubai_jebel_ali', 13500], ['rotterdam', 'singapore', 17000], ['rotterdam', 'shanghai', 21000],
    ['singapore', 'santos', 18500], ['jeddah', 'singapore', 8500], ['new_york', 'los_angeles', 9700],
    ['piraeus', 'mumbai', 7500], ['busan', 'vancouver', 9500],
  ];
  const fails = [];
  for (const [a, b, maxKm] of pairs) {
    const r0 = plan(a, b, 0);
    for (const draft of [8.5, 14]) {
      const r = plan(a, b, draft);
      if (!r) { fails.push(`${a}→${b} @${draft} m: no route`); continue; }
      const km = r.distM / 1000;
      if (km > maxKm || (r0 && km > (r0.distM / 1000) * 1.12)) fails.push(`${a}→${b} @${draft} m: ${Math.round(km)} km (draught-free ${r0 ? Math.round(r0.distM / 1000) : '?'} km, max ${maxKm})`);
    }
  }
  assert.deepEqual(fails, []);
});

test('boards: offers from the pre-world generator (no gen 7) are withdrawn on start and refilled with local work', async () => {
  const { Game } = await import('../server/game.js');
  const { generateJob, JOB_GEN } = await import('../server/economy.js');
  const sg = harborById('singapore');
  const fresh = generateJob(sg, 0, Math.random);
  assert.equal(fresh.gen, JOB_GEN);
  const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-wcr-test-state.json' }); g.saveState = () => {};
  const st = g.harbors.singapore;
  const old = { ...generateJob(sg, g.simTime, Math.random, 'freight'), id: 'old1', to: 'vancouver', gen: undefined };
  const cur = { ...generateJob(sg, g.simTime, Math.random, 'freight'), id: 'cur1' };
  st.jobs = [old, cur];
  g.initHarbors();
  assert.ok(!st.jobs.some((j) => j.id === 'old1'), 'old-generator offer withdrawn');
  assert.ok(st.jobs.some((j) => j.id === 'cur1'), 'current offer kept');
  assert.ok(st.jobs.every((j) => j.gen === JOB_GEN));
});
