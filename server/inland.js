// Inland waterway graph and route planner (docs/BRIDGES-LOCKS-VHF-CONTRACT.md §4.10).
//   buildGraph(data, opts)            FIS sections (+ bridges, locks) → { nodes, edges, adj, objs } (plain data: worker-safe)
//   planInland(graph, from, to, ship, t0, opts) → RouteV2-compatible { points, marks, warnings, eta, distM, via } | null
//   joinSeaGates(graph, gates)        attach sea-gate nodes (server/waterworks/seagates-nl.json)
//   planWithSea(seaPlan, graph, from, to, ship, t0, opts)  inland ↔ sea join via the 3 nearest sea gates
//   whyNot(graph, from, to, ship, t0) the objects / edges blocking a ship on the geometric shortest path
// ship = { L, B, T, need (air draught + margin, m), sail?, kn? (cruise speed), ukc?, kind? }
import { passVerdict, isMovable, spanTimes, scheduleOpen, fitChamber, levelTime, culvertMua, GATE_TIME, REACTION, CEMT_ORDER, posOf } from '../shared/waterworks.js';
import { datumOffset, m2At, poundAt } from '../shared/waterlevel.js';
import { tideAt, lowWaterAt } from '../shared/tide.js';

const D2R = Math.PI / 180;
const KMH = 1 / 3.6;
export const SNAP_M = 25, OBJ_JOIN_M = 60, END_SNAP_M = 5000;
export const SPEED = { big: 18 * KMH, small: 10 * KMH, unknown: 12 * KMH };
export const LOCK_QUEUE_FACTOR = 0.5, LOCK_TYPICAL_DH = 1.0;
export const STANDING_MAST_MIN = 3;

export function distM(a, b) { const dy = (a[0] - b[0]) * 110540, dx = (a[1] - b[1]) * 111320 * Math.cos(((a[0] + b[0]) / 2) * D2R); return Math.hypot(dx, dy); }
function polyLen(pts) { let s = 0; for (let i = 1; i < pts.length; i++) s += distM(pts[i - 1], pts[i]); return s; }
/** Nearest point on a polyline → { d, along, i } (metres). */
export function nearestOnLine(pts, p) {
  let best = { d: Infinity, along: 0, i: 0 }, acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], kx = 111320 * Math.cos(a[0] * D2R), ky = 110540;
    const bx = (b[1] - a[1]) * kx, by = (b[0] - a[0]) * ky, px = (p[1] - a[1]) * kx, py = (p[0] - a[0]) * ky;
    const L2 = bx * bx + by * by || 1, t = Math.max(0, Math.min(1, (px * bx + py * by) / L2));
    const d = Math.hypot(px - t * bx, py - t * by), seg = Math.sqrt(L2);
    if (d < best.d) best = { d, along: acc + t * seg, i };
    acc += seg;
  }
  return best;
}

// ------------------------------------------------------------------------------------------------ graph
/**
 * data = { sections: [{ id, pts, lim?: { L, B, T, H, cemt } , len? }], bridges: [Bridge], locks: [Lock] }
 * opts = { levels } (non-tidal pounds for the clearance datum checks)
 */
export function buildGraph(data, opts = {}) {
  const nodes = [], edges = [], cells = new Map();
  const cellKey = (p) => `${Math.round(p[0] * 4000)}:${Math.round(p[1] * 2500)}`;   // ≈ 28 × 44 m cells
  function nodeAt(p) {
    const [ci, cj] = cellKey(p).split(':').map(Number);
    let best = null;
    for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) for (const n of cells.get(`${i}:${j}`) || []) {
      const d = distM(p, [nodes[n].lat, nodes[n].lon]); if (d <= SNAP_M && (!best || d < best.d)) best = { n, d };
    }
    if (best) return best.n;
    const id = nodes.length; nodes.push({ id, lat: p[0], lon: p[1] });
    const k = cellKey(p); if (!cells.has(k)) cells.set(k, []); cells.get(k).push(id);
    return id;
  }
  const bySection = new Map();
  for (const s of data.sections || []) {
    if (!s.pts || s.pts.length < 2) continue;
    const a = nodeAt(s.pts[0]), b = nodeAt(s.pts[s.pts.length - 1]);
    if (a === b && s.pts.length < 3) continue;
    const lim = s.lim || null, ci = lim && lim.cemt ? CEMT_ORDER.indexOf(lim.cemt) : -1;
    const e = { id: edges.length, sec: s.id, a, b, pts: s.pts, len: Math.round(s.len || polyLen(s.pts)), lim, speed: ci < 0 ? SPEED.unknown : ci >= CEMT_ORDER.indexOf('IV') ? SPEED.big : SPEED.small, objs: [] };
    if (Number.isFinite(s.speed)) e.speed = s.speed;
    edges.push(e); bySection.set(s.id, e);
  }
  const objs = {};
  const attach = (o, kind) => {
    const p = posOf(o);
    let e = o.section != null ? bySection.get(o.section) : null;
    let near = e ? nearestOnLine(e.pts, p) : null;
    if (!e || near.d > 500) {
      e = null; near = null;
      for (const x of edges) { const n = nearestOnLine(x.pts, p); if (n.d <= OBJ_JOIN_M && (!near || n.d < near.d)) { e = x; near = n; } }
    }
    if (!e) return;
    objs[o.id] = o;
    e.objs.push({ kind, id: o.id, at: Math.round(near.along) });
  };
  for (const b of data.bridges || []) attach(b, 'bridge');
  for (const l of data.locks || []) attach(l, 'lock');
  for (const e of edges) e.objs.sort((x, y) => x.at - y.at);
  const adj = nodes.map(() => []);
  for (const e of edges) { adj[e.a].push(e.id); if (e.b !== e.a) adj[e.b].push(e.id); }
  return { v: 1, nodes, edges, adj, objs, levels: opts.levels || null, gates: [] };
}

/** Attach sea gates: each gate { id, name, sea: [lat, lon], inland: [lat, lon] } joins the nearest graph node to its inland point. */
export function joinSeaGates(graph, gates) {
  graph.gates = [];
  for (const g of gates || []) {
    const n = nearestNode(graph, g.inland, END_SNAP_M);
    if (n == null) continue;
    graph.gates.push({ ...g, node: n });
    graph.nodes[n].gate = g.id;
  }
  return graph;
}
export function nearestNode(graph, p, maxM = END_SNAP_M) {
  let best = null;
  for (const n of graph.nodes) { const d = distM(p, [n.lat, n.lon]); if (d <= maxM && (!best || d < best.d)) best = { n: n.id, d }; }
  return best ? best.n : null;
}

// ------------------------------------------------------------------------------------------------ rules per object
function hAt(graph, o, kind, t) {      // water height at the object for the clearance check
  const [la, lo] = posOf(o);
  const pd = poundAt(la, lo, graph.levels);
  if (pd) return { h: pd.h, tidal: false };
  if (o.datum === 'KP') return { h: datumOffset('KP', la, lo, o.kp), tidal: false };
  if (kind === 'mhws') return { h: 1.33 * m2At(la, lo), tidal: true };
  return { h: 0, tidal: true };
}
/** Lowest tide in [t0, t0 + 24 h] and the first window (10-min steps) where h ≤ hMax. */
export function tideWindow(lat, lon, t0, hMax) {
  let low = Infinity, from = null, to = null;
  for (let t = t0; t <= t0 + 86400; t += 600) {
    const h = tideAt(lat, lon, t).height; low = Math.min(low, h);
    if (h <= hMax) { if (from == null) from = t; to = t; } else if (from != null && to != null && t > to) break;
  }
  return { low, from, to: to != null ? to + 600 : null };
}
/**
 * Can the ship pass object `o` on the graph, and at what wait? pass 1 = conservative (MHWS), pass 2 = tide windows allowed.
 * → { ok, waitS, mark?, block? }
 */
export function objectCheck(graph, ref, ship, tEta, pass = 1) {
  const o = graph.objs[ref.id];
  if (ref.kind === 'bridge') {
    if (o.lockId) {                                  // lock-head bridge: fixed spans still bind; movable ones open with the lock
      const fixedOnly = !o.spans.some(isMovable);
      if (!fixedOnly) { const v = passVerdict(ship, o, o.spans.findIndex((s) => s.rec) >= 0 ? o.spans.findIndex((s) => s.rec) : 0, { h: hAt(graph, o, 'mhws').h }); return v.verdict === 'never' ? { ok: false, block: { id: o.id, name: o.name, why: v.why } } : { ok: true, waitS: 0 }; }
    }
    const { h, tidal } = hAt(graph, o, 'mhws');
    let best = null;
    o.spans.forEach((s, i) => { const v = passVerdict(ship, o, i, { h }); if (!best || rank(v.verdict) < rank(best.v.verdict) || (rank(v.verdict) === rank(best.v.verdict) && s.w > o.spans[best.i].w)) best = { i, v }; });
    if (!best) return { ok: false, block: { id: o.id, name: o.name, why: 'no span' } };
    const v = best.v;
    if (v.verdict === 'under' || v.verdict === 'tight') return { ok: true, waitS: 0, mark: { kind: 'bridge', id: o.id, name: o.name, action: 'under', vhf: o.vhf, clr: v.clrNow, need: v.need, waitMin: 0 } };
    if (v.verdict === 'opening') {
      const s = o.spans[best.i], { warn, move } = spanTimes(s);
      let wait = (o.slots && o.slots.every ? (o.slots.every * 60) / 2 : (o.reaction ?? (o.remote ? REACTION.remote : REACTION.manned))) + warn + move;
      const sch = scheduleOpen({ ...o, slots: null, blocks: o.blocks }, tEta, { kind: ship.kind === 'small' ? 'small' : 'commercial', reaction: 0 });
      if (!sch.ok && sch.tNext) wait += sch.tNext - tEta; else if (sch.ok) wait += Math.max(0, sch.tOpen - tEta);
      return { ok: true, waitS: wait, mark: { kind: 'bridge', id: o.id, name: o.name, action: 'opening', vhf: o.vhf, clr: v.clrNow, clrO: v.clrOpenNow, need: v.need, waitMin: Math.round(wait / 60), movable: true } };
    }
    // never at MHWS: a fixed span may still pass at low water (pass 2)
    if (pass === 2 && tidal && !o.spans.some(isMovable)) {
      const [la, lo] = posOf(o), s = o.spans[best.i];
      const hMax = s.clr + datumOffset(o.datum, la, lo, o.kp) - v.need;
      const w = tideWindow(la, lo, tEta, hMax);
      if (w.from != null && (!Number.isFinite(ship.beam) || ship.beam + 1 <= s.w)) {
        return { ok: true, waitS: Math.max(0, w.from - tEta), mark: { kind: 'bridge', id: o.id, name: o.name, action: 'under', tide: true, vhf: o.vhf, clr: s.clr, need: v.need, waitMin: Math.round(Math.max(0, w.from - tEta) / 60), windowFrom: w.from, windowTo: w.to } };
      }
    }
    return { ok: false, block: { id: o.id, name: o.name, why: v.why, clr: v.clrNow, clrO: v.clrOpenNow, need: v.need } };
  }
  // lock
  const lowSide = o.sides && o.sides.some((s) => s.level?.kind === 'tidal') ? lowWaterAt(...posOf(o)) : 0;
  const fit = o.chambers.map((ch) => ({ ch, f: fitChamber(ch, ship, { dLow: lowSide }) }));
  const okc = fit.find((x) => x.f.ok);
  if (!okc) return { ok: false, block: { id: o.id, name: o.name, why: fit[0] ? fit[0].f.why : 'no chamber' } };
  const ch = okc.ch, gate = GATE_TIME[ch.gates?.[0]?.type] || GATE_TIME.mitre;
  const cyc = (2 * gate + levelTime(ch.len * ch.wid, culvertMua(ch), LOCK_TYPICAL_DH) + 360) * (1 + LOCK_QUEUE_FACTOR);
  return { ok: true, waitS: cyc, mark: { kind: 'lock', id: o.id, name: o.name, action: 'lock', vhf: o.vhf, chamber: ch.id, waitMin: Math.round(cyc / 60) } };
}
const rank = (v) => ({ under: 0, tight: 1, opening: 2, closed: 3, never: 4 }[v] ?? 5);

function edgeOk(e, ship) {
  const l = e.lim; if (!l) return { ok: true };
  if (Number.isFinite(l.T) && ship.T + (ship.ukc || 0) > l.T) return { ok: false, why: 'draught', lim: l.T };
  if (Number.isFinite(l.B) && ship.B > l.B) return { ok: false, why: 'beam', lim: l.B };
  if (Number.isFinite(l.L) && ship.L > l.L) return { ok: false, why: 'length', lim: l.L };
  return { ok: true };
}

// ------------------------------------------------------------------------------------------------ planner
class Heap {
  constructor() { this.a = []; }
  push(x) { const a = this.a; a.push(x); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p].f <= a[i].f) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() { const a = this.a, top = a[0], last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l].f < a[m].f) m = l; if (r < a.length && a[r].f < a[m].f) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } } return top; }
  get size() { return this.a.length; }
}
function search(graph, s, goal, ship, t0, pass, ignoreObjs = false) {
  const vmax = Math.max(SPEED.big, ship.kn ? ship.kn * 0.5144 : 0);
  const gp = [graph.nodes[goal].lat, graph.nodes[goal].lon];
  const best = new Map([[s, 0]]), prev = new Map();
  const h = new Heap(); h.push({ n: s, g: 0, f: distM([graph.nodes[s].lat, graph.nodes[s].lon], gp) / vmax });
  const done = new Set();
  while (h.size) {
    const cur = h.pop();
    if (done.has(cur.n)) continue; done.add(cur.n);
    if (cur.n === goal) break;
    for (const ei of graph.adj[cur.n]) {
      const e = graph.edges[ei];
      if (!edgeOk(e, ship).ok) continue;
      const next = e.a === cur.n ? e.b : e.a;
      const fwd = e.a === cur.n;
      const v = Math.min(e.speed, ship.kn ? ship.kn * 0.5144 : e.speed);
      let g = cur.g, ok = true; const marks = [];
      const list = fwd ? e.objs : e.objs.slice().reverse();
      let posAlong = fwd ? 0 : e.len;
      for (const ref of list) {
        g += Math.abs(ref.at - posAlong) / v; posAlong = ref.at;
        if (ignoreObjs) continue;
        const c = objectCheck(graph, ref, ship, t0 + g, pass);
        if (!c.ok) { ok = false; break; }
        g += c.waitS; if (c.mark) marks.push({ ...c.mark, at: ref.at, edge: e.id });
      }
      if (!ok) continue;
      g += Math.abs((fwd ? e.len : 0) - posAlong) / v;
      if (g < (best.get(next) ?? Infinity)) {
        best.set(next, g); prev.set(next, { n: cur.n, e: e.id, fwd, marks });
        h.push({ n: next, g, f: g + distM([graph.nodes[next].lat, graph.nodes[next].lon], gp) / vmax });
      }
    }
  }
  if (!best.has(goal)) return null;
  const steps = []; let n = goal;
  while (n !== s) { const p = prev.get(n); steps.push(p); n = p.n; }
  steps.reverse();
  return { steps, time: best.get(goal) };
}

/** Plan on the inland graph between two positions ({ lat, lon } or [lat, lon]). */
export function planInland(graph, from, to, ship, t0 = Date.now() / 1000, opts = {}) {
  const F = Array.isArray(from) ? from : [from.lat, from.lon], T = Array.isArray(to) ? to : [to.lat, to.lon];
  const s = opts.fromNode ?? nearestNode(graph, F), g = opts.toNode ?? nearestNode(graph, T);
  if (s == null || g == null) return null;
  const shipN = { ...ship, need: typeof ship.need === 'function' ? ship.need(0) : ship.need, beam: ship.beam ?? ship.B };
  let r = search(graph, s, g, shipN, t0, 1), pass = 1;
  if (!r) { r = search(graph, s, g, shipN, t0, 2); pass = 2; }
  if (!r) return null;
  const points = [F], marks = [], warnings = [];
  let distAcc = distM(F, [graph.nodes[s].lat, graph.nodes[s].lon]);
  for (const st of r.steps) {
    const e = graph.edges[st.e], pts = st.fwd ? e.pts : e.pts.slice().reverse();
    const base = points.length;
    for (const p of pts) points.push(p);
    distAcc += e.len;
    for (const m of st.marks) {
      const along = st.fwd ? m.at : e.len - m.at;
      let acc = 0, idx = 0;
      for (let i = 1; i < pts.length; i++) { acc += distM(pts[i - 1], pts[i]); if (acc >= along) { idx = i; break; } idx = i; }
      const { at, edge, ...mm } = m;
      marks.push({ i: base + idx, ...mm });
    }
  }
  points.push(T);
  distAcc += distM(T, [graph.nodes[g].lat, graph.nodes[g].lon]);
  const movable = marks.filter((m) => m.kind === 'bridge' && m.action === 'opening').length;
  if (ship.sail && movable >= STANDING_MAST_MIN) warnings.push({ i: 0, kind: 'standing_mast', text: 'Staande-mastroute' });
  for (const m of marks) if (m.tide) warnings.push({ i: m.i, kind: 'tide_window', text: `Pass ${m.name} between ${hhmmUTC(m.windowFrom)} and ${hhmmUTC(m.windowTo)} (low water)` });
  return {
    planner: 'inland-1', via: 'inland', points: points.map(([a, b]) => [Math.round(a * 1e6) / 1e6, Math.round(b * 1e6) / 1e6]), distM: Math.round(distAcc),
    marks, warnings, eta: Math.round(t0 + r.time), timeS: Math.round(r.time), pass, label: warnings.some((w) => w.kind === 'standing_mast') ? 'Staande-mastroute' : null,
  };
}
const hhmmUTC = (t) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t * 1000));

/** Objects or edges that block the ship on the shortest path ignoring them (for "you will not pass, advise route via"). */
export function whyNot(graph, from, to, ship, t0 = Date.now() / 1000) {
  const F = Array.isArray(from) ? from : [from.lat, from.lon], T = Array.isArray(to) ? to : [to.lat, to.lon];
  const s = nearestNode(graph, F), g = nearestNode(graph, T); if (s == null || g == null) return [];
  const shipN = { ...ship, need: typeof ship.need === 'function' ? ship.need(0) : ship.need, beam: ship.beam ?? ship.B };
  const r = search(graph, s, g, { ...shipN, T: 0, B: 0, L: 0 }, t0, 1, true); if (!r) return [{ why: 'not connected' }];
  const out = [];
  for (const st of r.steps) {
    const e = graph.edges[st.e];
    const eo = edgeOk(e, shipN); if (!eo.ok) out.push({ edge: e.sec, why: eo.why, lim: eo.lim });
    for (const ref of e.objs) { const c = objectCheck(graph, ref, shipN, t0, 2); if (!c.ok) out.push(c.block); }
  }
  return out;
}

/**
 * Join with the sea planner (§4.10). seaPlan(from, to) → RouteV2 | null (the existing searoute.planRoute bound to world/graph).
 * opts.fromInland / opts.toInland say which ends are inland (D14 mask RIVER/LOCK/DOCK or inside a pound). Tries the 3 nearest
 * sea gates per inland end and keeps the fastest (by inland time + sea distance / sea speed).
 */
export function planWithSea(seaPlan, graph, from, to, ship, t0 = Date.now() / 1000, opts = {}) {
  const F = Array.isArray(from) ? from : [from.lat, from.lon], T = Array.isArray(to) ? to : [to.lat, to.lon];
  const fi = !!opts.fromInland, ti = !!opts.toInland;
  if (fi && ti) return planInland(graph, F, T, ship, t0, opts);
  if (!fi && !ti) return seaPlan ? seaPlan({ lat: F[0], lon: F[1] }, { lat: T[0], lon: T[1] }) : null;
  const inlandEnd = fi ? F : T, seaEnd = fi ? T : F;
  const seaV = (ship.kn || 10) * 0.5144;
  const gates = (graph.gates || []).slice().sort((a, b) => distM(a.inland, inlandEnd) - distM(b.inland, inlandEnd)).slice(0, opts.gates ?? 3);
  let best = null;
  for (const gt of gates) {
    const inl = fi ? planInland(graph, inlandEnd, gt.inland, ship, t0, { toNode: gt.node }) : planInland(graph, gt.inland, inlandEnd, ship, t0, { fromNode: gt.node });
    if (!inl) continue;
    const sea = seaPlan ? seaPlan(fi ? { lat: gt.sea[0], lon: gt.sea[1] } : { lat: seaEnd[0], lon: seaEnd[1] }, fi ? { lat: seaEnd[0], lon: seaEnd[1] } : { lat: gt.sea[0], lon: gt.sea[1] })
      : { points: fi ? [gt.sea, seaEnd] : [seaEnd, gt.sea], distM: Math.round(distM(gt.sea, seaEnd)), marks: [], warnings: [] };
    if (!sea) continue;
    const cost = inl.timeS + sea.distM / seaV;
    if (!best || cost < best.cost) best = { cost, gate: gt, inl, sea };
  }
  if (!best) return null;
  const { inl, sea, gate } = best;
  const first = fi ? inl : sea, second = fi ? sea : inl;
  const off = first.points.length;
  const points = first.points.concat(second.points);
  const shift = (arr, k) => (arr || []).map((m) => ({ ...m, i: (m.i ?? 0) + k }));
  const marks = shift(first.marks, 0).concat([{ i: off - 1, kind: 'sea_gate', id: gate.id, name: gate.name }], shift(second.marks, off));
  return { planner: 'inland+sea-1', via: 'mixed', points, distM: (inl.distM || 0) + (sea.distM || 0), marks, warnings: shift(first.warnings, 0).concat(shift(second.warnings, off)),
    eta: Math.round(t0 + best.cost), gate: gate.id, label: inl.label || null };
}
