// Traffic separation schemes for the route planner (docs/V6-QUICK-CONTRACTS.md §4.2). Data only + three pure checks.
// Only the Dover Strait pair has real one-way lanes in server/lanes.js; the other `tss`-kind lane nodes are single
// junctions without a direction. More schemes are data-only additions here (lane node id + flow direction).
import { haversine, bearing, angleDiff } from '../shared/geo.js';
import { LANE_NODES } from './lanes.js';

export const TSS = [
  { id: 'dover', name: 'Dover Strait TSS', place: 'the Dover Strait', lanes: [
    { node: 'dover_tss_ne', flow: 45, name: 'north-east-bound lane' },
    { node: 'dover_tss_sw', flow: 225, name: 'south-west-bound lane' } ] },
];
export const TSS_RULE = { AGAINST_DEG: 120, RADIUS_M: 5000 };

const LANES = new Map();
for (const s of TSS) for (const l of s.lanes) LANES.set(l.node, { ...l, scheme: s.id, schemeName: s.name, place: s.place || s.name });
// lane node positions (from lanes.js; the graph's own nodes refresh them)
const POS = new Map();
for (const n of LANE_NODES) if (LANES.has(n.id)) POS.set(n.id, { lat: n.lat, lon: n.lon });

/** The one-way lane a lane-graph node belongs to, or null. */
export function laneOf(nodeId) { return LANES.get(nodeId) || null; }

/** Lane graph edge a→b may be sailed in this direction (false when a or b is a lane node and the leg runs against its flow). */
export function edgeAllowed(graph, aId, bId) {
  const la = LANES.get(aId), lb = LANES.get(bId);
  if (!la && !lb) return true;
  const a = graph?.nodes?.get(aId), b = graph?.nodes?.get(bId);
  if (!a || !b) return true;
  if (la) POS.set(aId, { lat: a.lat, lon: a.lon });
  if (lb) POS.set(bId, { lat: b.lat, lon: b.lon });
  const brg = bearing(a.lat, a.lon, b.lat, b.lon);
  for (const l of [la, lb]) if (l && Math.abs(angleDiff(brg, l.flow)) > TSS_RULE.AGAINST_DEG) return false;
  return true;
}

/** Register lane node positions (planner calls this once per graph; tests may call it with LANE_NODES). */
export function registerLaneNodes(nodes) {
  for (const n of nodes || []) if (LANES.has(n.id) && Number.isFinite(n.lat)) POS.set(n.id, { lat: n.lat, lon: n.lon });
}

// Closest approach (m) of the straight leg a→b to point p, on a local tangent plane at p (fine for legs of a few hundred km).
function closestM(a, b, p) {
  const k = Math.cos((p.lat * Math.PI) / 180) * 111320, m = 110540;
  const ax = (a.lon - p.lon) * k, ay = (a.lat - p.lat) * m, bx = (b.lon - p.lon) * k, by = (b.lat - p.lat) * m;
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
  return Math.hypot(ax + dx * t, ay + dy * t);
}

/** A straight leg a→b passing within TSS_RULE.RADIUS_M of a lane node against its flow → that lane (else null). */
export function legViolates(a, b) {
  if (!a || !b) return null;
  if (haversine(a.lat, a.lon, b.lat, b.lon) < 1) return null;
  const brg = bearing(a.lat, a.lon, b.lat, b.lon);
  for (const [id, l] of LANES) {
    const p = POS.get(id); if (!p) continue;
    if (Math.abs(angleDiff(brg, l.flow)) <= TSS_RULE.AGAINST_DEG) continue;
    if (closestM(a, b, p) < TSS_RULE.RADIUS_M) return l;
  }
  return null;
}
