// Point-to-point sea routes for the skipper's "Route" button: straight when the water allows, otherwise along the
// AI traffic's sea-lane graph (server/lanes.js) — enter at the nearest lane node (or harbour) that a straight leg
// reaches over water, Dijkstra across the lanes, leave at the node nearest the target — then string-pulled so no
// waypoint is kept that a straight water leg can skip. Ends of a route may cross a little "land" inside a harbour
// (the coarse raster fills basins and estuaries), so the first and last SLACK_M are not checked.
import { haversine, wrapLon } from '../shared/geo.js';
import { HARBORS } from './harbors.js';

const STEP_M = 400;          // water check spacing along a leg (the regional raster is ~550 m)
const SLACK_M = 3000;        // unchecked distance at the route's two ends (harbour basins, estuaries)
const MAX_LINKS = 4;

const lerp = (a, b, t) => ({ lat: a.lat + (b.lat - a.lat) * t, lon: wrapLon(a.lon + wrapLon(b.lon - a.lon) * t) });

/** Number of land samples on the straight leg a→b, skipping `slackA` metres at a and `slackB` at b. */
export function landOnLeg(world, a, b, slackA = 0, slackB = 0) {
  const len = haversine(a.lat, a.lon, b.lat, b.lon);
  const n = Math.max(1, Math.ceil(len / STEP_M));
  let bad = 0;
  for (let k = 1; k < n; k++) {
    const d = (k / n) * len;
    if (d < slackA || len - d < slackB) continue;
    const p = lerp(a, b, k / n);
    if (!world.isWater(p.lat, p.lon)) bad++;
  }
  return bad;
}

/**
 * @param world  World (isWater)
 * @param graph  buildGraph() result ({ nodes, route(fromId, toId) }) or null
 * @param from   { lat, lon }
 * @param to     { lat, lon }; `toHarbor` (id) lets the route end through that harbour's own lane links
 * @returns { points: [[lat, lon], …] (excluding the start), distM, via: 'direct' | 'lanes' } or null
 */
export function planRoute(world, graph, from, to, { toHarbor = null } = {}) {
  if (![from?.lat, from?.lon, to?.lat, to?.lon].every(Number.isFinite)) return null;
  const direct = haversine(from.lat, from.lon, to.lat, to.lon);
  if (landOnLeg(world, from, to, SLACK_M, SLACK_M) === 0) return { points: [[to.lat, to.lon]], distM: direct, via: 'direct' };
  if (!graph) return null;
  const nodes = [...graph.nodes.values()];
  const sea = nodes.filter((n) => n.kind !== 'harbor');
  // entry / exit candidates: nearest lane nodes a straight water leg reaches, plus a harbour right next to the point
  const links = (p, slackAtP, harborId) => {
    const out = [];
    if (harborId && graph.nodes.has(harborId)) { const h = graph.nodes.get(harborId); out.push({ id: harborId, d: haversine(p.lat, p.lon, h.lat, h.lon) }); }
    const near = HARBORS.map((h) => ({ h, d: haversine(p.lat, p.lon, h.lat, h.lon) })).filter((x) => x.d < 12000 && x.h.id !== harborId).sort((a, b) => a.d - b.d)[0];
    if (near && graph.nodes.has(near.h.id)) out.push({ id: near.h.id, d: near.d });
    const cand = sea.map((n) => ({ n, d: haversine(p.lat, p.lon, n.lat, n.lon) })).sort((a, b) => a.d - b.d).slice(0, 24);
    for (const { n, d } of cand) {
      if (out.length >= MAX_LINKS + (harborId ? 1 : 0)) break;
      if (landOnLeg(world, p, n, slackAtP, 0) === 0) out.push({ id: n.id, d });
    }
    return out;
  };
  const ins = links(from, SLACK_M, null), outs = links(to, SLACK_M, toHarbor);
  let best = null;
  for (const a of ins) for (const b of outs) {
    let path;
    try { path = graph.route(a.id, b.id); } catch { path = null; }
    if (!path || !path.length) continue;
    let len = a.d + b.d;
    for (let i = 1; i < path.length; i++) len += haversine(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
    if (!best || len < best.len) best = { len, path };
  }
  if (!best) return null;
  // string-pull: from each kept point jump to the furthest later point a straight water leg reaches
  const pts = [{ lat: from.lat, lon: from.lon }, ...best.path.map((p) => ({ lat: p[0], lon: p[1], canal: p[2] === 1 })), { lat: to.lat, lon: to.lon }];
  const out = [];
  let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    for (; j > i + 1; j--) {
      if (pts.slice(i, j).some((p) => p.canal)) continue; // never shortcut a canal
      const slackA = i === 0 ? SLACK_M : 0, slackB = j === pts.length - 1 ? SLACK_M : 0;
      if (landOnLeg(world, pts[i], pts[j], slackA, slackB) === 0) break;
    }
    out.push(pts[j]); i = j;
  }
  let distM = 0, prev = from;
  for (const p of out) { distM += haversine(prev.lat, prev.lon, p.lat, p.lon); prev = p; }
  return { points: out.map((p) => [Math.round(p.lat * 1e6) / 1e6, Math.round(p.lon * 1e6) / 1e6]), distM: Math.round(distM), via: 'lanes' };
}
