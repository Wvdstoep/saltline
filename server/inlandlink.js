// Lane D ↔ lane A link (docs/BRIDGES-LOCKS-VHF-CONTRACT.md §9.5 frozen interfaces). Lane D consumes:
//   shared/airdraft.js   AD_MARGIN, profileOf(cls), airDraftNow(cls, { cargo, fuelT, ballastT, fold }) → { ad, T, kTop, deckTiers, need(Hs) }
//   shared/waterworks.js CEMT, passVerdict(...)
//   server/inland.js     planInland(graph, from, to, ship, t0) → { points, marks, warnings, eta } | null
// loadLaneA() imports them when lane A is merged and falls back to lane D's local stand-ins otherwise
// (shared/inlandshim.js for the rules, the small Dijkstra planner below for routes on a synthetic graph). The fallbacks
// follow the contract's numbers, so the integration swap changes no pinned result.
import { haversine } from '../shared/geo.js';
import * as shim from '../shared/inlandshim.js';

const r1 = (v) => Math.round(v * 10) / 10;
const r3 = (v) => Math.round(v * 1000) / 1000;

/**
 * The lane A surface lane D uses, real when present. importer(spec) lets tests force the stub (`() => Promise.reject()`).
 * → { src: { air, cemt, plan }, AD_MARGIN, CEMT, profileOf, airDraftNow, bestAirDraft, planInland, buildGraph }
 */
export async function loadLaneA({ importer = (s) => import(s) } = {}) {
  const tryImp = async (s) => { try { return await importer(s); } catch { return null; } };
  const [ad, ww, inl] = await Promise.all([tryImp('../shared/airdraft.js'), tryImp('../shared/waterworks.js'), tryImp('./inland.js')]);
  const air = ad && typeof ad.airDraftNow === 'function' && typeof ad.profileOf === 'function' ? ad : null;
  const api = {
    src: { air: air ? 'laneA' : 'stub', cemt: ww?.CEMT ? 'laneA' : 'stub', plan: inl?.planInland ? 'laneA' : 'stub' },
    AD_MARGIN: air?.AD_MARGIN ?? shim.AD_MARGIN,
    CEMT: ww?.CEMT ? normCemt(ww.CEMT) : shim.CEMT,
    profileOf: air ? air.profileOf : shim.profileOf,
    airDraftNow: air ? air.airDraftNow : shim.airDraftNow,
    planInland: inl?.planInland || stubPlanInland,
    buildGraph: inl?.buildGraph || null,
    /** Why there is no route: the first blocking object / fairway → { name, why } | null (lane A whyNot, else the stand-in). */
    explain: inl?.whyNot ? (g, f, t, ship) => { try { const b = (inl.whyNot(g, f, t, ship) || [])[0]; return b ? { id: b.id ?? null, name: b.name || b.edge || 'fairway', why: b.why || '' } : null; } catch { return null; } } : explainBlock,
  };
  api.bestAirDraft = air ? (cls, o) => bestWith(api, cls, o) : shim.bestAirDraft;
  return api;
}
/** The lane D stand-in set, synchronously (tests, and the server before loadLaneA resolves). */
export function stubLaneA() {
  return { src: { air: 'stub', cemt: 'stub', plan: 'stub' }, AD_MARGIN: shim.AD_MARGIN, CEMT: shim.CEMT, profileOf: shim.profileOf, airDraftNow: shim.airDraftNow, bestAirDraft: shim.bestAirDraft, planInland: stubPlanInland, buildGraph: null, explain: explainBlock };
}
/** Lane A's CEMT table may use other key names; map what we read (L/B/T/clr) defensively. */
function normCemt(t) {
  const out = {};
  for (const [k, v] of Object.entries(t || {})) out[k] = { L: v.L ?? v.len ?? v.length, B: v.B ?? v.beam, b2: v.b2 ?? v.beam2 ?? null, T: v.T ?? v.draught ?? v.draft, clr: v.clr ?? v.H ?? v.clearance ?? (Array.isArray(v.bridge) ? Math.min(...v.bridge) : v.bridge) };
  for (const k of Object.keys(shim.CEMT)) if (!out[k] || !Number.isFinite(out[k].L)) out[k] = shim.CEMT[k];
  return out;
}
/** Lowest air draught with a cargo using lane A's airDraftNow: everything folded (when allowed) and ballast to the cap. */
function bestWith(api, cls, { cargo = [], fuelT = null } = {}) {
  const p = api.profileOf(cls) || {};
  const sp = shim.profileOf(cls);                         // capacity / fuel / stores come from the catalogue either way
  const list = typeof cargo === 'number' ? [{ good: 'grain', qty: cargo }] : cargo || [];
  const cargoT = list.reduce((s, c) => s + (Number(c.qty) || 0), 0), fuel = fuelT == null ? sp.fuelCap : fuelT;
  const ballastT = Math.min(Number(p.ballastMax) || 0, Math.max(0, sp.dwMax - cargoT - fuel - sp.stores));
  const fold = Object.fromEntries(Object.keys(p.up || {}).map((k) => [k, 1]));
  let a = api.airDraftNow(cls, { cargo: list, fuelT: fuel, ballastT, fold });
  const eye = (p.kTop ?? sp.kTop) - 1.5;
  if (a.stackTop && a.stackTop > eye + 1.0) a = api.airDraftNow(cls, { cargo: list, fuelT: fuel, ballastT, fold: null });
  return { ad: a.ad, need: typeof a.need === 'function' ? a.need(0) : r3(a.ad + api.AD_MARGIN), T: a.T, ballastT, fold, deckTiers: a.deckTiers ?? 0 };
}

// ------------------------------------------------------------------------------------------------ ship view for the planner
/**
 * The `ship` lane D hands to planInland: dimensions, live draught and the air draught to plan with.
 * dims = { cls, L, B, T, sail }, air = { ad, need, T } (bestAirDraft or airDraftNow). CEMT from the model when it has one.
 */
export function plannerShip(dims, air = null, { cemt = null } = {}) {
  const T = Number.isFinite(air?.T) ? air.T : dims.T;
  return { cls: dims.cls, L: dims.L, B: dims.B, T, Tdesign: dims.T, ad: air?.ad ?? null, need: air?.need ?? (Number.isFinite(air?.ad) ? r3(air.ad + shim.AD_MARGIN) : null), sail: !!dims.sail, cemt: cemt || dims.cemt || shim.cemtOfDims(dims.L, dims.B, dims.T) };
}

// ------------------------------------------------------------------------------------------------ stand-in planner
/**
 * A small inland graph (lane D's stand-in for lane A's buildGraph output):
 *   { nodes: { id: { lat, lon, name? } }, edges: [{ a, b, km?, cemt?, maxL?, maxB?, maxT?, kmh?, objects: [Obj] }] }
 *   Obj = { kind: 'bridge', id, name, mov: 'fixed'|'bascule'|'lift'|'swing'|…, clr, clrO?, w?, waitMin?, vhf? }
 *       | { kind: 'lock', id, name, len, wid, sill, waitMin?, vhf? }
 * Limits default from the edge's CEMT class (maxT then = the class's max vessel draught, no ukc; an explicit maxT is the
 * fairway depth and needs T + ukc); km from the node distance × 1.15 (winding) when not given.
 */
export function prepGraph(doc) {
  const nodes = new Map(Object.entries(doc?.nodes || {}).map(([id, n]) => [id, { id, lat: n.lat, lon: n.lon, name: n.name || id }]));
  const edges = [];
  for (const e of doc?.edges || []) {
    const A = nodes.get(e.a), B = nodes.get(e.b); if (!A || !B) continue;
    const c = shim.CEMT[e.cemt] || null;
    const km = Number.isFinite(e.km) ? e.km : r1((haversine(A.lat, A.lon, B.lat, B.lon) / 1000) * 1.15);
    edges.push({ ...e, km, maxL: e.maxL ?? c?.L ?? Infinity, maxB: e.maxB ?? (c ? Math.max(c.B, c.b2 || 0) + shim.CEMT_BEAM_TOL : Infinity), maxT: e.maxT ?? c?.T ?? Infinity, maxTvessel: e.maxT == null && !!c, kmh: e.kmh ?? (c && shim.cemtRank(e.cemt) <= 1 ? 10 : 18), objects: e.objects || [] });
  }
  const adj = new Map([...nodes.keys()].map((k) => [k, []]));
  edges.forEach((e, i) => { adj.get(e.a).push([i, e.b]); adj.get(e.b).push([i, e.a]); });
  return { nodes, edges, adj, prepared: true };
}
function snap(g, p) {
  if (typeof p === 'string') return g.nodes.has(p) ? p : null;
  if (p?.node && g.nodes.has(p.node)) return p.node;
  let best = null, bd = Infinity;
  for (const n of g.nodes.values()) { const d = haversine(p.lat, p.lon, n.lat, n.lon); if (d < bd) { bd = d; best = n.id; } }
  return bd <= 5000 ? best : null;
}
/** Why an edge refuses a ship (first reason) → { obj, why } | null; also the marks / waits it adds when it passes. */
export function edgeCheck(e, ship) {
  const T = ship.T, ukc = Math.max(0.3, 0.05 * T);
  if (ship.L > e.maxL) return { refuse: { name: e.name || `${e.a}–${e.b}`, why: `length ${r1(ship.L)} m > ${e.maxL} m (CEMT ${e.cemt || '?'})` } };
  if (ship.B > e.maxB) return { refuse: { name: e.name || `${e.a}–${e.b}`, why: `beam ${r1(ship.B)} m > ${r1(e.maxB)} m (CEMT ${e.cemt || '?'})` } };
  // a class default is the class's max VESSEL draught (CEMT); an explicit maxT is the fairway depth (needs the ukc)
  if (e.maxTvessel ? T > e.maxT + 1e-9 : T + ukc > e.maxT) return { refuse: { name: e.name || `${e.a}–${e.b}`, why: e.maxTvessel ? `draught ${r1(T)} m > ${e.maxT} m (CEMT ${e.cemt})` : `draught ${r1(T)} m + ${r1(ukc)} m > ${e.maxT} m` } };
  const marks = []; let waitMin = 0;
  for (const o of e.objects) {
    if (o.kind === 'bridge') {
      const v = shim.passVerdictLite(ship.need ?? 0, { clr: o.clr, clrO: o.mov === 'fixed' ? null : o.clrO ?? Infinity, w: o.w ?? null }, { beam: ship.B });
      if (v.verdict === 'never') return { refuse: { id: o.id, name: o.name, why: v.why === 'too wide' ? `opening ${o.w} m, beam ${r1(ship.B)} m` : o.mov === 'fixed' ? `fixed ${o.clr} m, you need ${r1(ship.need)} m` : `opens to ${o.clrO} m, you need ${r1(ship.need)} m` } };
      const opening = v.verdict === 'opening';
      if (opening) waitMin += Number(o.waitMin) || 12;
      marks.push({ kind: 'bridge', id: o.id, name: o.name, action: opening ? 'opening' : 'under', vhf: o.vhf ?? null, clr: o.clr, clrO: o.clrO ?? null, need: ship.need, waitMin: opening ? Number(o.waitMin) || 12 : 0 });
    } else if (o.kind === 'lock') {
      if (ship.L + 5 > o.len || ship.B + 1.0 > o.wid || T + Math.max(0.3, 0.05 * T) > o.sill) return { refuse: { id: o.id, name: o.name, why: `chamber ${o.len} × ${o.wid} m, sill ${o.sill} m` } };
      waitMin += Number(o.waitMin) || 20;
      marks.push({ kind: 'lock', id: o.id, name: o.name, action: 'lock', vhf: o.vhf ?? null, waitMin: Number(o.waitMin) || 20 });
    }
  }
  return { refuse: null, marks, waitMin };
}
/**
 * Stand-in for lane A's planInland (same signature and answer shape): Dijkstra on travel time over prepGraph(doc).
 * → { points, marks, warnings, eta, km, hours, cemtMin } | null (no route for this ship). The extra `blocked` export explains a null.
 */
export function stubPlanInland(graph, from, to, ship, t0 = 0) {
  const g = graph?.prepared ? graph : prepGraph(graph);
  const s = snap(g, from), t = snap(g, to);
  if (!s || !t) return null;
  const run = (relaxed) => {
    const dist = new Map([[s, 0]]), prev = new Map(), done = new Set();
    for (;;) {
      let u = null, du = Infinity;
      for (const [k, v] of dist) if (!done.has(k) && (v < du || (v === du && u !== null && k < u))) { u = k; du = v; }
      if (u == null || u === t) break;
      done.add(u);
      for (const [ei, w] of g.adj.get(u)) {
        const e = g.edges[ei], c = edgeCheck(e, ship);
        if (c.refuse && !relaxed) continue;
        const h = e.km / e.kmh + (c.refuse ? 0 : c.waitMin / 60);
        const nd = du + h;
        if (nd < (dist.get(w) ?? Infinity) - 1e-12) { dist.set(w, nd); prev.set(w, [u, ei]); }
      }
    }
    if (!dist.has(t)) return null;
    const path = []; let k = t;
    while (k !== s) { const [p, ei] = prev.get(k); path.unshift({ from: p, to: k, e: g.edges[ei] }); k = p; }
    return { path, hours: dist.get(t) };
  };
  const ok = run(false);
  if (!ok) return null;
  const points = [[g.nodes.get(s).lat, g.nodes.get(s).lon]], marks = [], warnings = [];
  let km = 0, cemtMin = null;
  for (const st of ok.path) {
    const n = g.nodes.get(st.to); points.push([n.lat, n.lon]); km += st.e.km;
    if (st.e.cemt && (cemtMin == null || shim.cemtRank(st.e.cemt) < shim.cemtRank(cemtMin))) cemtMin = st.e.cemt;
    const c = edgeCheck(st.e, ship); marks.push(...c.marks);
  }
  const movable = marks.filter((m) => m.kind === 'bridge' && m.action === 'opening').length;
  if (ship.sail && movable >= 3) warnings.push('Staande-mastroute');
  return { points, marks, warnings, eta: t0 + Math.round(ok.hours * 3600), km: r1(km), hours: r3(ok.hours), cemtMin };
}
/** Why the stand-in planner finds no route: the first refusing object on the shortest unconstrained path. → { id?, name, why } | null */
export function explainBlock(graph, from, to, ship) {
  const g = graph?.prepared ? graph : prepGraph(graph);
  const s = snap(g, from), t = snap(g, to);
  if (!s || !t) return { name: 'off the inland network', why: 'no waterway near' };
  // unconstrained shortest path by km
  const dist = new Map([[s, 0]]), prev = new Map(), done = new Set();
  for (;;) {
    let u = null, du = Infinity;
    for (const [k, v] of dist) if (!done.has(k) && v < du) { u = k; du = v; }
    if (u == null || u === t) break;
    done.add(u);
    for (const [ei, w] of g.adj.get(u)) { const nd = du + g.edges[ei].km; if (nd < (dist.get(w) ?? Infinity)) { dist.set(w, nd); prev.set(w, [u, ei]); } }
  }
  if (!dist.has(t)) return { name: 'not connected', why: 'no waterway between' };
  const path = []; let k = t;
  while (k !== s) { const [p, ei] = prev.get(k); path.unshift(g.edges[ei]); k = p; }
  for (const e of path) { const c = edgeCheck(e, ship); if (c.refuse) return c.refuse; }
  return null;
}
/** Route hours from a planInland answer (hours, or eta − t0, or km at 14 km/h). */
export function routeHours(route, t0 = 0) {
  if (!route) return null;
  if (Number.isFinite(route.hours)) return route.hours;
  if (Number.isFinite(route.timeS)) return r3(route.timeS / 3600);           // lane A planInland
  if (Number.isFinite(route.eta) && route.eta > t0 && t0 > 0) return (route.eta - t0) / 3600;
  return routeKm(route) / 14;
}
/** Route km from the points (or `km` when given). */
export function routeKm(route) {
  if (!route) return 0;
  if (Number.isFinite(route.km)) return route.km;
  if (Number.isFinite(route.distM)) return r1(route.distM / 1000);           // lane A planInland
  let km = 0; const p = route.points || [];
  for (let i = 1; i < p.length; i++) km += haversine(p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]) / 1000;
  return r1(km);
}
