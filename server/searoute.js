// Sea route planner v2 (docs/V6-QUICK-CONTRACTS.md §4.2–4.3) for the skipper's Route button, the chart's "Sail route",
// fleet/trade plans and the route table. Pure and synchronous (server/routeworker.js runs it off the main thread).
//
// A route is planned leg by leg (ship → user waypoints → destination). Each leg is straight when the water allows,
// otherwise it enters the AI traffic's sea-lane graph (server/lanes.js) at the nearest node a checked straight leg
// reaches, runs a Dijkstra over the lanes, leaves at the node nearest the target, and is string-pulled so no point is
// kept that a checked straight leg can skip. v2 checks every leg and lane edge for the ship's DRAUGHT at LOW WATER
// (mean low water springs of shared/tide.js, keel margin max(2 m, 10 % draught)), uses the 10 m harbour patches at both
// ends (water-only A* out of the harbour along the fairway with server/tugpath.js; the route ends at the fairway's outer
// end, where berth guidance takes over), keeps to the right lane of the Dover Strait TSS (server/tss.js), sails round
// storm discs given by the client, and moves waypoints off land / shallows. With draft = 0, no geom and tss: false the
// result equals v1 (the ends' first/last 3 km unchecked, water only).
import { haversine, wrapLon, destination } from '../shared/geo.js';
import { SHIP_CLASSES } from '../shared/constants.js';
import { lowWaterAt, tideAt } from '../shared/tide.js';
import { HARBORS, harborById } from './harbors.js';
import { laneOf, edgeAllowed, legViolates } from './tss.js';
import * as TP from './tugpath.js';

export const PLANNER_VERSION = 2;
export const ROUTE = { STEP_M: 400, PATCH_STEP_M: 25, SLACK_M: 3000, EDGE_STEP_M: 1000, UKC_MIN_M: 2, UKC_FRAC: 0.1,
                       PATCH_MARGIN_M: 10, PATCH_MARGIN_MIN_M: 4, PATCH_CLEAR_M: 4, WP_SNAP_M: 2000, MAX_POINTS: 250,
                       AVOID_MAX: 8, AVOID_PAD: 1.25 };
const MAX_LINKS = 4;
const SUBDIVIDE_M = 250000;      // long lane legs are split (lanes.js does the same)
const HARBOR_PENALTY_M = 60000;  // routing through another harbour node (v1)
const HARBOR_LINK_SKIP_M = 3000; // harbour links: depth not sampled within this of the harbour node
const PATCH_NEAR_M = 3500;       // a built patch "is at" a point within this of its harbour
const HARBOR_END_M = 6000;       // a route end this close to a harbour without a patch gets the v1 end slack
const RING_N = 8, RING_K = 1.35, RING_LINK_M = 150000;
const EXIT_MAX_POINTS = 30;
const WP_RINGS_M = [100, 200, 350, 500, 750, 1000, 1300, 1650, 2000];

const lerp = (a, b, t) => ({ lat: a.lat + (b.lat - a.lat) * t, lon: wrapLon(a.lon + wrapLon(b.lon - a.lon) * t) });
const r6 = (v) => Math.round(v * 1e6) / 1e6;
const fin = (v) => typeof v === 'number' && Number.isFinite(v);

/** Number of land samples on the straight leg a→b, skipping `slackA` metres at a and `slackB` at b. (v1, unchanged) */
export function landOnLeg(world, a, b, slackA = 0, slackB = 0) {
  const len = haversine(a.lat, a.lon, b.lat, b.lon);
  const n = Math.max(1, Math.ceil(len / ROUTE.STEP_M));
  let bad = 0;
  for (let k = 1; k < n; k++) {
    const d = (k / n) * len;
    if (d < slackA || len - d < slackB) continue;
    const p = lerp(a, b, k / n);
    if (!world.isWater(p.lat, p.lon)) bad++;
  }
  return bad;
}

/** Water depth at mean low water springs (m; negative on land) from the world raster. */
export function depthLW(world, lat, lon) { return world.depthAt(lat, lon) + lowWaterAt(lat, lon); }

/** Keel margin the planner keeps for a draught (m). */
export function ukcFor(draft) { return Math.max(ROUTE.UKC_MIN_M, ROUTE.UKC_FRAC * (Number(draft) || 0)); }

// ------------------------------------------------------------------------------------------------ harbour patches
function patchEntry(geom, id) {
  if (!geom?.getHarborPatch || !id) return null;
  let buf = null; try { buf = geom.getHarborPatch(id); } catch { buf = null; }
  if (!buf) return null;
  const grid = TP.gridFromPatch(buf); if (!grid) return null;
  let g = null; try { g = geom.getHarborGeom?.(id) || null; } catch { g = null; }
  let anchor = null; try { anchor = geom.harborAnchor?.(id) || g?.anchor || null; } catch { anchor = g?.anchor || null; }
  const fw = Array.isArray(g?.fairway) && g.fairway.length ? g.fairway[g.fairway.length - 1] : null;
  const outer = fw ? { lat: Array.isArray(fw) ? fw[0] : fw.lat, lon: Array.isArray(fw) ? fw[1] : fw.lon } : anchor ? { lat: anchor.lat, lon: anchor.lon } : null;
  return { id, grid, outer: outer && fin(outer.lat) && fin(outer.lon) ? outer : null };
}
/** The built patch (nearest harbour within 3.5 km) that covers a point, or null. */
function patchAt(geom, lat, lon) {
  if (!geom?.getHarborPatch) return null;
  const near = HARBORS.map((h) => ({ h, d: haversine(lat, lon, h.lat, h.lon) })).filter((x) => x.d <= PATCH_NEAR_M).sort((a, b) => a.d - b.d);
  for (const { h } of near) {
    const e = patchEntry(geom, h.id); if (!e) continue;
    const [x, z] = TP.toXZ(e.grid, lat, lon);
    if (TP.inGrid(e.grid, x, z, 2)) return e;
  }
  return null;
}
const inPatch = (patches, lat, lon) => {
  for (const p of patches) { const [x, z] = TP.toXZ(p.grid, lat, lon); if (TP.inGrid(p.grid, x, z, 1)) return { p, x, z }; }
  return null;
};

// ------------------------------------------------------------------------------------------------ checks
// Closest approach (m) of the straight leg a→b to point c (local tangent plane at c).
function closestM(a, b, c) {
  const k = Math.cos((c.lat * Math.PI) / 180) * 111320, m = 110540;
  const ax = wrapLon(a.lon - c.lon) * k, ay = (a.lat - c.lat) * m, bx = wrapLon(b.lon - c.lon) * k, by = (b.lat - c.lat) * m;
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
  return Math.hypot(ax + dx * t, ay + dy * t);
}

/**
 * One planning context: the depth need (0 = water only), harbour patches, storm discs and the TSS switch. Holds the
 * caches of one planRoute call (filtered adjacency, ring nodes, Dijkstra trees).
 */
function makeCtx(world, graph, { need, clearNeed, patches, discs, tss }) {
  return { world, graph, need, clearNeed, patches, discs, tss, adj: new Map(), trees: new Map(), rings: null };
}
/** Sample check: { ok, depth } (depth = depthLW, or null when the sample is not on a depth model). */
function sample(ctx, lat, lon) {
  const hit = ctx.patches.length ? inPatch(ctx.patches, lat, lon) : null;
  if (hit) {
    const clr = TP.clearanceAt(hit.p.grid, hit.x, hit.z), depth = -TP.bedAt(hit.p.grid, hit.x, hit.z) + lowWaterAt(lat, lon);
    return { ok: ctx.need > 0 ? depth >= ctx.need && clr >= ctx.clearNeed : clr > 0.5, depth, patch: true };
  }
  if (ctx.need > 0) { const depth = depthLW(ctx.world, lat, lon); return { ok: depth >= ctx.need, depth }; }
  return { ok: ctx.world.isWater(lat, lon), depth: null };
}
/** Straight leg check (depth / water, discs, TSS). `stats` (optional) collects the shallowest sampled depth. */
function legOk(ctx, a, b, slackA = 0, slackB = 0, stats = null) {
  if (ctx.discs.length) for (const d of ctx.discs) if (closestM(a, b, d) < d.r) return false;
  if (ctx.tss && legViolates(a, b)) return false;
  return samplesOk(ctx, a, b, slackA, slackB, stats);
}
function samplesOk(ctx, a, b, slackA, slackB, stats) {
  const len = haversine(a.lat, a.lon, b.lat, b.lon);
  const n = Math.max(1, Math.ceil(len / ROUTE.STEP_M));
  const kMax = ctx.need > 0 ? n : n - 1; // v2 also checks the far end of a leg; water-only keeps v1's sampling exactly
  let prevPatch = ctx.patches.length ? !!inPatch(ctx.patches, a.lat, a.lon) : false;
  for (let k = 1; k <= kMax; k++) {
    const d = (k / n) * len;
    const p = lerp(a, b, k / n);
    const curPatch = ctx.patches.length ? !!inPatch(ctx.patches, p.lat, p.lon) : false;
    if (curPatch || prevPatch) { // inside a harbour patch: every 25 m (clearance + bed)
      const m = Math.max(1, Math.ceil(len / n / ROUTE.PATCH_STEP_M));
      for (let s = 1; s <= m; s++) {
        const t = (k - 1 + s / m) / n, dd = t * len;
        if (dd < slackA || len - dd < slackB) continue;
        const q = lerp(a, b, t), r = sample(ctx, q.lat, q.lon);
        if (stats && r.depth != null && r.depth < stats.min) stats.min = r.depth;
        if (!r.ok && !stats) return false;
        if (!r.ok) stats.bad++;
      }
    } else {
      if (d < slackA || len - d < slackB) { prevPatch = curPatch; continue; }
      const r = sample(ctx, p.lat, p.lon);
      if (stats && r.depth != null && r.depth < stats.min) stats.min = r.depth;
      if (!r.ok && !stats) return false;
      if (!r.ok) stats.bad++;
    }
    prevPatch = curPatch;
  }
  return stats ? stats.bad === 0 : true;
}

// Per-graph cache of every lane edge's shallowest low-water depth (sampled every EDGE_STEP_M, once per graph).
const edgeDepthCache = new WeakMap();
function edgeMinDepth(ctx, u, v) {
  let cache = edgeDepthCache.get(ctx.graph);
  if (!cache) { cache = new Map(); edgeDepthCache.set(ctx.graph, cache); }
  const key = u < v ? `${u}|${v}` : `${v}|${u}`;
  if (cache.has(key)) return cache.get(key);
  const A = ctx.graph.nodes.get(u), B = ctx.graph.nodes.get(v);
  let min = Infinity;
  if (A && B) {
    const len = haversine(A.lat, A.lon, B.lat, B.lon), n = Math.max(1, Math.ceil(len / ROUTE.EDGE_STEP_M));
    const skipA = A.kind === 'harbor' ? HARBOR_LINK_SKIP_M : 0, skipB = B.kind === 'harbor' ? HARBOR_LINK_SKIP_M : 0;
    const harborLink = skipA || skipB;
    for (let k = 0; k <= n; k++) {
      const d = (k / n) * len;
      if (harborLink && (d < HARBOR_LINK_SKIP_M || len - d < HARBOR_LINK_SKIP_M)) continue; // harbour links: first/last 3 km
      const p = lerp(A, B, k / n), dep = depthLW(ctx.world, p.lat, p.lon);
      if (dep < min) min = dep;
    }
  }
  cache.set(key, min);
  return min;
}
const edgeNearPatch = (ctx, A, B) => { for (const p of ctx.patches) if (closestM(A, B, { lat: p.grid.originLat, lon: p.grid.originLon }) < PATCH_NEAR_M) return true; return false; };
const discHitEdge = (ctx, A, B) => { for (const d of ctx.discs) if (closestM(A, B, d) < d.r) return true; return false; };

// ------------------------------------------------------------------------------------------------ the graph
function nodeOf(ctx, id) { return ctx.graph.nodes.get(id) || ctx.rings?.nodes.get(id) || null; }
/** Adjacency of u after the depth, TSS and storm filters, plus the storm ring nodes' edges. */
function edgesOf(ctx, u) {
  if (ctx.adj.has(u)) return ctx.adj.get(u);
  const out = [];
  const U = nodeOf(ctx, u);
  for (const e of ctx.graph.adj.get(u) || []) {
    if (ctx.tss && !edgeAllowed(ctx.graph, u, e.to)) continue;
    if (!e.canal && ctx.need > 0 && edgeMinDepth(ctx, u, e.to) < ctx.need) continue;
    if (!e.canal && ctx.discs.length && discHitEdge(ctx, U, ctx.graph.nodes.get(e.to))) continue;
    // lane / river edges crossing a harbour patch of this plan are checked on the patch (the raster's carved channels
    // do not match the real basins)
    if (!e.canal && ctx.patches.length && edgeNearPatch(ctx, U, ctx.graph.nodes.get(e.to)) && !samplesOk(ctx, U, ctx.graph.nodes.get(e.to), 0, 0, null)) continue;
    out.push(e);
  }
  if (ctx.rings) for (const e of ctx.rings.adj.get(u) || []) out.push(e);
  ctx.adj.set(u, out);
  return out;
}
/** Temporary nodes round each storm disc (8 per disc at 1.35 × its inflated radius, on water), linked by checked legs. */
function buildRings(ctx) {
  if (ctx.rings) return ctx.rings;
  const nodes = new Map(), adj = new Map();
  ctx.rings = { nodes, adj, list: [] };
  if (!ctx.discs.length) return ctx.rings;
  const add = (a, b, w) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push({ to: b, w, canal: false }); };
  ctx.discs.forEach((d, di) => {
    let prev = null, first = null;
    for (let k = 0; k <= RING_N; k++) {
      const kk = k % RING_N, id = `ring:${di}:${kk}`;
      if (k < RING_N) {
        const p = destination(d.lat, d.lon, kk * (360 / RING_N), d.r * RING_K);
        if (!ctx.world.isWater(p.lat, p.lon)) { prev = null; continue; }
        const n = { id, name: `round ${d.name || 'the storm'}`, lat: p.lat, lon: p.lon, kind: 'ring' };
        nodes.set(id, n); ctx.rings.list.push(n);
        if (!first) first = n;
      }
      const n = nodes.get(id);
      if (n && prev && n !== prev) {
        const w = haversine(prev.lat, prev.lon, n.lat, n.lon);
        if (legOk(ctx, prev, n)) add(prev.id, n.id, w);
        if (legOk(ctx, n, prev)) add(n.id, prev.id, w);
      }
      prev = n || null;
    }
  });
  // ring ↔ lane nodes (and other discs' rings) within 150 km
  const lane = [...ctx.graph.nodes.values()].filter((n) => n.kind !== 'harbor');
  for (const r of ctx.rings.list) {
    for (const n of lane.concat(ctx.rings.list.filter((x) => x.id.split(':')[1] !== r.id.split(':')[1]))) {
      const w = haversine(r.lat, r.lon, n.lat, n.lon);
      if (w > RING_LINK_M) continue;
      if (legOk(ctx, r, n)) add(r.id, n.id, w);
      if (!nodes.has(n.id) && legOk(ctx, n, r)) add(n.id, r.id, w); // ring→ring pairs are added from both sides by the loop
    }
  }
  return ctx.rings;
}
// v1's Dijkstra (linear scan, harbour penalty), over the filtered adjacency.
function dijkstra(ctx, from) {
  if (ctx.trees.has(from)) return ctx.trees.get(from);
  const dist = new Map([[from, 0]]), prev = new Map(), done = new Set();
  const open = new Map([[from, 0]]);
  while (open.size) {
    let u = null, best = Infinity;
    for (const [k, d] of open) if (d < best) { best = d; u = k; }
    open.delete(u); done.add(u);
    for (const e of edgesOf(ctx, u)) {
      if (done.has(e.to)) continue;
      const tn = nodeOf(ctx, e.to), penalty = tn?.kind === 'harbor' || tn?.roads ? HARBOR_PENALTY_M : 0;
      const nd = best + e.w + penalty;
      if (nd < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, nd); prev.set(e.to, u); open.set(e.to, nd); }
    }
  }
  const t = { dist, prev };
  ctx.trees.set(from, t);
  return t;
}
/** Node path fromId → toId as points ({lat, lon, canal, lane, id, name}), long legs subdivided like lanes.js. */
function pathPoints(ctx, fromId, toId) {
  const nf = nodeOf(ctx, fromId), nt = nodeOf(ctx, toId);
  if (!nf || !nt) return null;
  const mk = (n, canal) => ({ lat: n.lat, lon: n.lon, canal: !!canal, lane: !!(ctx.tss && laneOf(n.id)), id: n.id, name: n.name, kind: n.kind });
  if (fromId === toId) return [mk(nf, false)];
  const { dist, prev } = dijkstra(ctx, fromId);
  if (!dist.has(toId)) return null;
  const ids = [];
  for (let u = toId; u !== undefined; u = prev.get(u)) ids.push(u);
  ids.reverse();
  const isCanal = (a, b) => { const e = (ctx.graph.adj.get(a) || []).find((x) => x.to === b); return !!(e && e.canal); };
  const pts = [];
  for (let i = 0; i < ids.length; i++) {
    const n = nodeOf(ctx, ids[i]);
    if (i > 0 && !isCanal(ids[i - 1], ids[i])) {
      const p = nodeOf(ctx, ids[i - 1]);
      const parts = Math.ceil(haversine(p.lat, p.lon, n.lat, n.lon) / SUBDIVIDE_M);
      for (let k = 1; k < parts; k++) { const q = lerp(p, n, k / parts); pts.push({ lat: q.lat, lon: q.lon, canal: false, lane: false }); }
    }
    pts.push(mk(n, i + 1 < ids.length && isCanal(ids[i], ids[i + 1])));
  }
  return pts;
}

// ------------------------------------------------------------------------------------------------ one leg
/**
 * Entry / exit candidates of a point: (v1) the given harbour node, the nearest harbour within 12 km, the nearest lane
 * nodes a checked straight leg reaches; (v2) the extra nodes given (a patch harbour's neighbours) and the storm rings.
 * `reverse`: the leg runs node → p (TSS direction).
 */
function links(ctx, p, slackAtP, harborId, reverse, extra = []) {
  const out = [];
  const g = ctx.graph;
  const ok = (n) => (reverse ? legOk(ctx, n, p, 0, slackAtP) : legOk(ctx, p, n, slackAtP, 0));
  if (harborId && g.nodes.has(harborId)) { const h = g.nodes.get(harborId); out.push({ id: harborId, d: haversine(p.lat, p.lon, h.lat, h.lon) }); }
  const near = HARBORS.map((h) => ({ h, d: haversine(p.lat, p.lon, h.lat, h.lon) })).filter((x) => x.d < 12000 && x.h.id !== harborId).sort((a, b) => a.d - b.d)[0];
  if (near && g.nodes.has(near.h.id) && (ctx.need === 0 || ok(near.h))) out.push({ id: near.h.id, d: near.d });
  const sea = [...g.nodes.values()].filter((n) => n.kind !== 'harbor');
  const cand = sea.map((n) => ({ n, d: haversine(p.lat, p.lon, n.lat, n.lon) })).sort((a, b) => a.d - b.d).slice(0, 24);
  const cap = MAX_LINKS + (harborId ? 1 : 0);
  for (const { n, d } of cand) {
    if (out.length >= cap) break;
    if (ok(n)) out.push({ id: n.id, d });
  }
  for (const id of extra) {
    const n = g.nodes.get(id); if (!n || n.kind === 'harbor' || out.some((x) => x.id === id)) continue;
    if (ok(n)) out.push({ id, d: haversine(p.lat, p.lon, n.lat, n.lon) });
  }
  if (ctx.discs.length) for (const r of buildRings(ctx).list) {
    const d = haversine(p.lat, p.lon, r.lat, r.lon);
    if (d <= RING_LINK_M && ok(r)) out.push({ id: r.id, d });
  }
  return out;
}
/** One leg a→b: { pts (excluding a), via } or null. */
function planLeg(ctx, a, b, slackA, slackB, { toHarbor = null, fromExtra = [], toExtra = [] } = {}) {
  if (legOk(ctx, a, b, slackA, slackB)) return { pts: [{ lat: b.lat, lon: b.lon }], via: 'direct' };
  if (!ctx.graph) return null;
  const ins = links(ctx, a, slackA, null, false, fromExtra), outs = links(ctx, b, slackB, toHarbor, true, toExtra);
  const cands = [];
  for (const x of ins) for (const y of outs) {
    let path;
    try { path = pathPoints(ctx, x.id, y.id); } catch { path = null; }
    if (!path || !path.length) continue;
    let len = x.d + y.d;
    for (let i = 1; i < path.length; i++) len += haversine(path[i - 1].lat, path[i - 1].lon, path[i].lat, path[i].lon);
    cands.push({ len, path });
  }
  if (!cands.length) return null;
  cands.sort((p, q) => p.len - q.len); // stable: equal lengths keep v1's pair order
  // water-only (v1) takes the shortest as it is; with a draught every kept leg is verified at 400 m (lane edges were
  // checked every 1 km), trying the next-shortest entry/exit pair when one does not hold
  const tries = ctx.need > 0 ? Math.min(6, cands.length) : 1;
  for (let c = 0; c < tries; c++) {
    const out = stringPull(ctx, a, b, cands[c].path, slackA, slackB, ctx.need > 0);
    if (out) return { pts: out, via: 'lanes' };
  }
  return null;
}
/**
 * String-pull: from each kept point jump to the furthest later point a checked straight leg reaches; never across a
 * canal, never past a one-way TSS lane node. `verify`: a leg to the very next point must pass the check too (else null).
 */
function stringPull(ctx, a, b, path, slackA, slackB, verify) {
  const pts = [{ lat: a.lat, lon: a.lon }, ...path, { lat: b.lat, lon: b.lon }];
  const out = [];
  let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1, ok = false;
    for (; j > i + 1; j--) {
      if (pts.slice(i, j).some((p) => p.canal)) continue;
      if (pts.slice(i + 1, j).some((p) => p.lane)) continue;
      const sA = i === 0 ? slackA : 0, sB = j === pts.length - 1 ? slackB : 0;
      if (legOk(ctx, pts[i], pts[j], sA, sB)) { ok = true; break; }
    }
    if (!ok && verify && !pts[i].canal && !legOk(ctx, pts[i], pts[j], i === 0 ? slackA : 0, j === pts.length - 1 ? slackB : 0)) return null;
    out.push(pts[j]); i = j;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ harbour exit
function simplifyXZ(grid, rule, pts, tol) {
  const n = pts.length; if (n <= 2) return pts.slice();
  const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
  const segOk = (a, b) => {
    const A = pts[a], B = pts[b];
    if (TP.segmentOk(grid, rule, A[0], A[1], B[0], B[1])) return true;
    const minClear = Math.min(TP.clearanceAt(grid, A[0], A[1]), TP.clearanceAt(grid, B[0], B[1]), rule.need) - 0.5;
    return minClear > 0 && TP.segmentWet(grid, A[0], A[1], B[0], B[1], minClear);
  };
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const A = pts[a], B = pts[b], dx = B[0] - A[0], dz = B[1] - A[1], L = Math.hypot(dx, dz) || 1e-9;
    let kMax = -1, dMax = -1;
    for (let k = a + 1; k < b; k++) { const d = Math.abs((pts[k][0] - A[0]) * dz - (pts[k][1] - A[1]) * dx) / L; if (d > dMax) { dMax = d; kMax = k; } }
    if (dMax > tol || !segOk(a, b)) { keep[kMax] = 1; stack.push([a, kMax], [kMax, b]); }
  }
  return pts.filter((_, k) => keep[k]);
}
/** Water-only A* from the ship out to the patch's fairway end. → { pts: [{lat, lon}] (excluding the start), ok } */
function harbourExit(patch, from, { beam, draft, length, simTime }) {
  const grid = patch.grid, exit = patch.outer;
  if (!exit) return null;
  const tide = tideAt(from.lat, from.lon, simTime).height;
  const s = TP.toXZ(grid, from.lat, from.lon), e = TP.toXZ(grid, exit.lat, exit.lon);
  let r = null, rule = null;
  // keel margin 1.5 m first (the client's live depth check wants draught + 1 m at the tide now), then the tugs' 0.5 m
  for (const [margin, depthMargin] of [[ROUTE.PATCH_MARGIN_M, 1.5], [ROUTE.PATCH_MARGIN_MIN_M, 1.5], [ROUTE.PATCH_MARGIN_MIN_M, 0.5]]) {
    rule = TP.hullRule({ beam, draft, tide, margin, depthMargin });
    try { r = TP.route(grid, rule, s, e, { radius: Math.max(40, 0.9 * (length || 0)) }); } catch { r = null; }
    if (r && r.pts?.length >= 2) break;
    r = null;
  }
  if (!r) return { pts: [{ lat: exit.lat, lon: exit.lon }], ok: false };
  let pts = r.pts;
  for (const tol of [5, 10, 20, 40, 80, 160]) { pts = simplifyXZ(grid, rule, r.pts, tol); if (pts.length <= EXIT_MAX_POINTS + 1) break; }
  if (pts.length > EXIT_MAX_POINTS + 1) pts = [pts[0], ...pts.slice(1, -1).filter((_, i, arr) => i % Math.ceil(arr.length / (EXIT_MAX_POINTS - 1)) === 0), pts[pts.length - 1]];
  return { pts: pts.slice(1).map(([x, z]) => TP.toLL(grid, x, z)), ok: true };
}

// ------------------------------------------------------------------------------------------------ waypoints
function snapWaypoint(ctx, p) {
  if (sample(ctx, p.lat, p.lon).ok) return { p, moved: 0 };
  const cand = [];
  const nw = ctx.world.nearestWater(p.lat, p.lon, 6);
  if (nw && (nw.lat !== p.lat || nw.lon !== p.lon)) cand.push(nw);
  for (const r of WP_RINGS_M) for (let k = 0; k < 16; k++) cand.push(destination(p.lat, p.lon, k * 22.5, r));
  let best = null;
  for (const q of cand) {
    const d = haversine(p.lat, p.lon, q.lat, q.lon);
    if (d > ROUTE.WP_SNAP_M || (best && d >= best.moved)) continue;
    if (sample(ctx, q.lat, q.lon).ok) best = { p: { lat: q.lat, lon: q.lon }, moved: d };
  }
  return best;
}

// ------------------------------------------------------------------------------------------------ planRoute
const harbourEndNear = (p, patches, maxM) => {
  let best = null;
  for (const h of HARBORS) { const d = haversine(p.lat, p.lon, h.lat, h.lon); if (d <= maxM && (!best || d < best.d)) best = { h, d }; }
  return best && !patches.some((x) => x.id === best.h.id) ? best.h : null;
};

/**
 * @param world  World (isWater, depthAt, nearestWater)
 * @param graph  buildGraph() result ({ nodes, adj }) or null
 * @param from, to { lat, lon }
 * @param opts   { toHarbor, draft, beam, length, ukc, tss, wp, avoid, simTime, geom } (docs/V6-QUICK-CONTRACTS.md §4.3)
 * @returns RouteV2 or null
 */
export function planRoute(world, graph, from, to, opts = {}) {
  if (![from?.lat, from?.lon, to?.lat, to?.lon].every(Number.isFinite)) return null;
  const draft = Math.max(0, Number(opts.draft) || 0), beam = Math.max(0, Number(opts.beam) || 0), length = Math.max(0, Number(opts.length) || 0);
  const ukc = draft > 0 ? (Number.isFinite(opts.ukc) ? Math.max(0, opts.ukc) : ukcFor(draft)) : 0;
  const need = draft > 0 ? draft + ukc : 0;
  const tss = opts.tss !== false;
  const simTime = Number.isFinite(opts.simTime) ? opts.simTime : Date.now() / 1000;
  const geom = opts.geom || null;
  const toHarbor = typeof opts.toHarbor === 'string' && opts.toHarbor ? opts.toHarbor : null;
  const warnings = [], marks = [];
  const points = []; // { lat, lon }
  // --- ends: harbour patches
  const fromPatch = geom ? patchAt(geom, from.lat, from.lon) : null;
  const toPatch = geom && toHarbor ? patchEntry(geom, toHarbor) : null;
  const patches = [fromPatch, toPatch].filter((x, i, arr) => x && arr.findIndex((y) => y && y.id === x.id) === i);
  let start = { lat: from.lat, lon: from.lon };
  let exitUsed = false;
  if (fromPatch && fromPatch.outer && !(toPatch && toPatch.id === fromPatch.id && haversine(from.lat, from.lon, to.lat, to.lon) < 5000)) {
    const ex = harbourExit(fromPatch, from, { beam, draft, length, simTime });
    if (ex) {
      for (const p of ex.pts) points.push({ lat: p.lat, lon: p.lon });
      if (!ex.ok) warnings.push({ i: points.length - 1, kind: 'harbour_exit_unplanned', text: 'No water-only way out of the harbour found for your hull — the first leg is a straight line. Steer it yourself.' });
      marks.push({ i: points.length - 1, kind: 'patch_exit', harbor: fromPatch.id, name: harborById(fromPatch.id)?.name || fromPatch.id });
      start = { ...points[points.length - 1] };
      exitUsed = true;
    }
  }
  let end = { lat: to.lat, lon: to.lon }, approach = null;
  if (toPatch && toPatch.outer) end = { lat: toPatch.outer.lat, lon: toPatch.outer.lon };
  // v1 end slack: only at harbour ends without a built patch (always in water-only mode)
  const fromHarbourEnd = !exitUsed && !fromPatch && !!harbourEndNear(from, patches, HARBOR_END_M);
  const toHarbourEnd = !toPatch && (!!toHarbor || !!harbourEndNear(to, patches, ROUTE.SLACK_M));
  // --- storm discs: inflated; a disc holding the start or the destination cannot be avoided
  const discs = [];
  for (const d of (Array.isArray(opts.avoid) ? opts.avoid : []).slice(0, ROUTE.AVOID_MAX)) {
    if (!d || !fin(d.lat) || !fin(d.lon) || !(d.radiusM > 0)) continue;
    const disc = { lat: d.lat, lon: d.lon, r: d.radiusM * ROUTE.AVOID_PAD, name: typeof d.name === 'string' ? d.name : '' };
    if (haversine(from.lat, from.lon, disc.lat, disc.lon) < disc.r || haversine(end.lat, end.lon, disc.lat, disc.lon) < disc.r) {
      warnings.push({ i: -1, kind: 'storm_unavoidable', text: `No way round storm ${disc.name || ''}`.trim(), storm: disc.name });
      continue;
    }
    discs.push(disc);
  }
  const clearNeed = beam / 2 + ROUTE.PATCH_CLEAR_M;
  const ctxs = new Map();
  const ctxFor = (n, withDiscs) => {
    const key = `${n}|${withDiscs ? 1 : 0}`;
    if (!ctxs.has(key)) ctxs.set(key, makeCtx(world, graph, { need: n, clearNeed: n > 0 ? clearNeed : 0, patches, discs: withDiscs ? discs : [], tss }));
    return ctxs.get(key);
  };
  const main = ctxFor(need, true);
  // --- user waypoints: off land / shallows within 2 km
  const wps = (Array.isArray(opts.wp) ? opts.wp : []).map((p) => (Array.isArray(p) ? { lat: p[0], lon: p[1] } : p)).filter((p) => p && fin(p.lat) && fin(p.lon)).slice(0, 50);
  const targets = [];
  wps.forEach((p, k) => {
    const s = snapWaypoint(main, p);
    if (!s) targets.push({ ...p, wpIndex: k, unsnapped: true });
    else { targets.push({ ...s.p, wpIndex: k, moved: s.moved }); }
  });
  targets.push({ ...end, final: true });
  // --- legs
  const legs = [];
  const extraOf = (id) => (graph && id ? (graph.adj.get(id) || []).map((e) => e.to) : []);
  let a = start;
  for (let li = 0; li < targets.length; li++) {
    const b = targets[li], last = li === targets.length - 1, firstLeg = li === 0;
    const sA = firstLeg && fromHarbourEnd ? ROUTE.SLACK_M : 0, sB = last && toHarbourEnd ? ROUTE.SLACK_M : 0;
    const legOpts = { toHarbor: last && !toPatch ? toHarbor : null, fromExtra: firstLeg && fromPatch ? extraOf(fromPatch.id) : [], toExtra: last && toPatch ? extraOf(toPatch.id) : [] };
    const tryPlan = (ctx, slackA, slackB) => { try { return planLeg(ctx, a, b, slackA, slackB, legOpts); } catch { return null; } };
    let r = null;
    if (need > 0 && b.unsnapped) r = null; else r = tryPlan(main, sA, sB);
    if (!r && discs.length) {
      r = tryPlan(ctxFor(need, false), sA, sB);
      if (r || need === 0) for (const d of discs) if (!warnings.some((w) => w.kind === 'storm_unavoidable' && w.storm === d.name)) warnings.push({ i: -1, kind: 'storm_unavoidable', text: `No way round storm ${d.name || ''}`.trim(), storm: d.name });
    }
    let shallow = false;
    if (!r && need > 0) { r = tryPlan(ctxFor(0, false), ROUTE.SLACK_M, ROUTE.SLACK_M); shallow = !!r; }
    if (!r) return null;
    const from0 = points.length - 1;
    for (const p of r.pts) points.push({ lat: p.lat, lon: p.lon, lane: p.lane ? p.id : null, canal: !!p.canal, name: p.name });
    const toIdx = points.length - 1;
    // leg distance and shallowest low-water depth outside the slack
    let distM = 0, prev = firstLeg ? from : points[from0];
    for (let k = firstLeg ? 0 : from0 + 1; k <= toIdx; k++) { distM += haversine(prev.lat, prev.lon, points[k].lat, points[k].lon); prev = points[k]; }
    const st = { min: Infinity, bad: 0 };
    const depthCtx = makeCtx(world, null, { need: Math.max(need, 0.001), clearNeed, patches, discs: [], tss: false });
    let q = a;
    for (let k = from0 + 1; k <= toIdx; k++) { samplesOk(depthCtx, q, points[k], k === from0 + 1 ? (shallow ? ROUTE.SLACK_M : sA) : 0, k === toIdx ? (shallow ? ROUTE.SLACK_M : sB) : 0, st); q = points[k]; }
    legs.push({ from: firstLeg ? -1 : from0, to: toIdx, distM: Math.round(distM), via: r.via, minDepthM: Number.isFinite(st.min) ? Math.round(st.min * 10) / 10 : null });
    if (shallow) {
      const depthM = Number.isFinite(st.min) ? Math.round(st.min * 10) / 10 : null;
      warnings.push({ i: toIdx, kind: 'no_draught_route', depthM, needM: Math.round(need * 10) / 10,
        text: depthM != null ? `Tidal passage: ${Math.max(0, depthM).toFixed(1)} m at low water, you need ${need.toFixed(1)} m` : `Tidal passage: not deep enough at low water for your ${draft} m draught` });
    }
    if (b.moved > 0) warnings.push({ i: toIdx, kind: 'wp_moved', text: `Waypoint ${b.wpIndex + 1} moved ${Math.round(b.moved)} m to deep enough water` });
    a = points[toIdx];
  }
  // --- marks: TSS lanes, canals, the approach
  points.forEach((p, i) => {
    if (p.lane) { const l = laneOf(p.lane); if (l) marks.push({ i, kind: 'tss', name: l.name, place: l.place, flow: l.flow }); }
    if (p.canal) marks.push({ i, kind: 'canal', name: p.name || 'canal' });
  });
  if (toHarbor) {
    const i = points.length - 1, P = points[i];
    approach = { harbor: toHarbor, lat: r6(P.lat), lon: r6(P.lon) };
    marks.push({ i, kind: 'approach', harbor: toHarbor, name: harborById(toHarbor)?.name || toHarbor, patch: !!toPatch });
  }
  marks.sort((x, y) => x.i - y.i);
  // --- size limit (keeps the ends; drops evenly from the middle)
  let pts = points;
  if (pts.length > ROUTE.MAX_POINTS) {
    const keep = new Set([0, pts.length - 1, ...marks.map((m) => m.i), ...warnings.map((w) => w.i), ...legs.map((l) => l.to)]);
    const step = Math.ceil(pts.length / (ROUTE.MAX_POINTS - keep.size));
    const idx = pts.map((_, i) => i).filter((i) => keep.has(i) || i % step === 0).slice(0, ROUTE.MAX_POINTS);
    if (idx[idx.length - 1] !== pts.length - 1) idx[idx.length - 1] = pts.length - 1;
    const remap = (i) => (i < 0 ? i : Math.max(0, idx.findIndex((j) => j >= i)));
    for (const m of marks) m.i = remap(m.i);
    for (const w of warnings) w.i = remap(w.i);
    for (const l of legs) { l.from = remap(l.from); l.to = remap(l.to); }
    pts = idx.map((i) => pts[i]);
  }
  let distM = 0, prev = from;
  for (const p of pts) { distM += haversine(prev.lat, prev.lon, p.lat, p.lon); prev = p; }
  const vias = new Set(legs.map((l) => l.via));
  const via = exitUsed ? (vias.size === 1 && vias.has('direct') ? 'harbour' : 'mixed') : vias.size === 1 ? [...vias][0] : 'mixed';
  const depths = legs.map((l) => l.minDepthM).filter((v) => v != null);
  return {
    planner: PLANNER_VERSION,
    points: pts.map((p) => [r6(p.lat), r6(p.lon)]),
    distM: Math.round(distM), via, legs, marks, approach,
    draft, ukcM: Math.round(ukc * 100) / 100, minDepthM: depths.length ? Math.min(...depths) : null,
    warnings: warnings.map((w) => ({ ...w, i: w.i < 0 ? 0 : w.i })),
  };
}

// ------------------------------------------------------------------------------------------------ query parsing
const LL = (s) => {
  const v = String(s ?? '').split(',').map((x) => (x.trim() === '' ? NaN : Number(x)));
  return v.length === 2 && v.every(Number.isFinite) && Math.abs(v[0]) <= 90 && Math.abs(v[1]) <= 180 ? { lat: v[0], lon: v[1] } : null;
};
/** `/api/route` query → { ok: true, from, to, toHarbor, cls, wp, avoid } | { ok: false, error } (docs §4.5). */
export function parseRouteQuery(query = {}) {
  const q = query || {};
  const from = LL(q.from), to = LL(q.to);
  if (!from || !to) return { ok: false, error: 'from=lat,lon&to=lat,lon' };
  let toHarbor = null;
  if (q.harbor != null && q.harbor !== '') {
    if (typeof q.harbor !== 'string' || !harborById(q.harbor)) return { ok: false, error: 'unknown harbour' };
    toHarbor = q.harbor;
  }
  let cls = null;
  if (q.cls != null && q.cls !== '') {
    if (typeof q.cls !== 'string' || q.cls.length > 64 || typeof SHIP_CLASSES[q.cls] !== 'object' || !(SHIP_CLASSES[q.cls]?.length > 0)) return { ok: false, error: 'unknown ship class' };   // SHIPYARD: catalogue model / variant ids resolve through H1 (not own keys)
    cls = q.cls;
  }
  const wp = [];
  if (q.wp != null && q.wp !== '') {
    if (typeof q.wp !== 'string') return { ok: false, error: 'wp=lat,lon;lat,lon' };
    const parts = q.wp.split(';').filter((x) => x.trim() !== '');
    if (parts.length > 50) return { ok: false, error: 'at most 50 waypoints' };
    for (const s of parts) { const p = LL(s); if (!p) return { ok: false, error: 'wp=lat,lon;lat,lon' }; wp.push(p); }
  }
  const avoid = [];
  if (q.avoid != null && q.avoid !== '') {
    if (typeof q.avoid !== 'string') return { ok: false, error: 'avoid=lat,lon,radiusKm;…' };
    const parts = q.avoid.split(';').filter((x) => x.trim() !== '');
    if (parts.length > ROUTE.AVOID_MAX) return { ok: false, error: `at most ${ROUTE.AVOID_MAX} avoid discs` };
    for (const s of parts) {
      const v = s.split(',');
      const lat = Number(v[0]), lon = Number(v[1]), rKm = Number(v[2]);
      if (v.length < 3 || v.length > 4 || ![lat, lon, rKm].every(Number.isFinite) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return { ok: false, error: 'avoid=lat,lon,radiusKm;…' };
      if (rKm < 1 || rKm > 600) return { ok: false, error: 'avoid radius must be 1–600 km' };
      const name = v[3] ? String(v[3]).replace(/[^\p{L}\p{N} .'-]/gu, '').slice(0, 40) : '';
      avoid.push({ lat, lon, radiusM: rKm * 1000, ...(name ? { name } : {}) });
    }
  }
  return { ok: true, from, to, toHarbor, cls, wp, avoid };
}
