// Dock anywhere (docs/DOCK-ANYWHERE-CONTRACT.md): berths on every real quay in the world, found in the D14 world tiles
// (shared/wtformat.js vectors: quays, piers, pontoons, bridges, locks, cranes, tanks, areas + the mask / height grid).
//
//   tile vectors ──► face segments (clipped to their own tile, global Mercator coords)          per tile, cached
//        3×3 tiles ──► chained polylines ──► straight runs (owned by the tile holding the midpoint)
//                      each run: water side, depth profile every 10 m at 6 offsets, class, cuts   per tile, cached
//   quay_query ────► runs within 1.5 km × this ship (length, depth at low water, width) − cuts − hulls lying there
//                    = free stretches → the slot nearest the ship, price, linked harbour + services   per call
//
// Pure: no game state, no network. Tiles come from an injected sync `getTile(z, x, y)` (server/worldtiles.js `get`), so
// it works offline from whatever the tile cache holds, and gives every player the same runs for the same tiles.
// Memory: two small count-capped caches (features ≤ 48 tiles, runs ≤ 64 tiles, a few KB each); a memguard at shed
// shrinks them, at critical no new tile is analysed (the call answers `busy`). Never throws to callers.
import { WT, WT_NAVIGABLE, tileF, tileFToLatLon, tileSizeM, tilesInRadius } from '../shared/wtformat.js';
import { lowWaterAt } from '../shared/tide.js';
import {
  QUAY, QUAY_CLASSES, SERVICE_TIERS, TIER_TABS, clsOf, neededLength, neededDepth, neededWidth, offsetsFor, serviceTier,
  linkHarbour, tugsAvailable, quayTugCost, quayFeePerDay, approachWhy, distM,
} from '../shared/quayrules.js';

const Z = WT.Z_DETAIL, D2R = Math.PI / 180, R2D = 180 / Math.PI;
const M_LAT = 111320, NO_WATER = -99;
export const CUT = { BRIDGE: 1, LOCK: 2, FAIRWAY: 4, HARBOUR: 8, FORBIDDEN: 16, SHALLOW_FACE: 32 };
const CUT_WHY = [[CUT.LOCK, 'in a lock'], [CUT.BRIDGE, 'under or next to a bridge'], [CUT.FAIRWAY, 'on the fairway'], [CUT.HARBOUR, 'a harbour berth (use Moor / Tugs there)'], [CUT.FORBIDDEN, 'a restricted area']];
const r1 = (v) => Math.round(v * 10) / 10;

// ------------------------------------------------------------------------------------------------ small LRU
function lru(max) {
  const m = new Map();
  return {
    get(k) { const v = m.get(k); if (v !== undefined) { m.delete(k); m.set(k, v); } return v; },
    set(k, v) { m.delete(k); m.set(k, v); while (m.size > this.max) m.delete(m.keys().next().value); },
    clear() { m.clear(); }, get size() { return m.size; }, max,
  };
}

// ------------------------------------------------------------------------------------------------ geometry helpers
/** Liang–Barsky clip of a segment to [0, S]² → [x0, z0, x1, z1] | null. */
export function clipSeg(x0, z0, x1, z1, S) {
  let t0 = 0, t1 = 1; const dx = x1 - x0, dz = z1 - z0;
  for (const [p, q] of [[-dx, x0], [dx, S - x0], [-dz, z0], [dz, S - z0]]) {
    if (p === 0) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  if (t1 - t0 < 1e-9) return null;
  return [x0 + t0 * dx, z0 + t0 * dz, x0 + t1 * dx, z0 + t1 * dz];
}
function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
  const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L2)) : 0;
  return Math.hypot(px - ax - t * dx, pz - az - t * dz);
}
function inRing(r, x, z) {
  let c = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], zi = r[i + 1], xj = r[j], zj = r[j + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}
/** Sync point sampler over the tile set: { mask, h } | null (tile not in memory). */
export function makeSampler(getTile) {
  return (lat, lon) => {
    const { fx, fy } = tileF(Z, lat, lon), x = Math.floor(fx), y = Math.floor(fy);
    let t = null; try { t = getTile(Z, x, y); } catch { t = null; }
    if (!t) return null;
    if (!t.mask) return { mask: t.flags & WT.FLAG.UNIFORM_LAND ? WT.MASK.LAND : WT.MASK.WATER, h: t.uniformH };
    const n = t.n, u = (fx - x) * n, v = (fy - y) * n;
    const i = Math.max(0, Math.min(n - 1, Math.floor(u))), j = Math.max(0, Math.min(n - 1, Math.floor(v)));
    const hv = t.height[j * n + i];
    const h = hv >= 32 && hv <= 224 ? (hv - 128) / 4 : hv < 32 ? -24 + (hv - 32) * 4 : 24 + (hv - 224) * 4;
    return { mask: t.mask[j * n + i], h };
  };
}

// ------------------------------------------------------------------------------------------------ per-tile features
/**
 * Compact features of one decoded D14 tile in GLOBAL z14 tile coordinates (fx, fy): face segments clipped to the tile's
 * own square (so neighbours never duplicate an overlay quay that spans several tiles), bridges, locks, cranes, tanks and
 * the land-use rings that classify a quay. Parses the (lazy) vectors once.
 */
export function tileFeatures(t) {
  const out = { key: `${t.x}/${t.y}`, segs: [], bridges: [], locks: [], cranes: [], tanks: [], areas: [] };
  let v = null; try { v = t.vectors; } catch { v = null; }
  if (!v) return out;
  const lat = tileFToLatLon(Z, t.x + 0.5, t.y + 0.5).lat, S = tileSizeM(Z, lat);
  const g = (xd, zd) => [t.x + xd / 10 / S, t.y + zd / 10 / S];       // decimetres → global tile coords
  const pushSeg = (x0, z0, x1, z1, k, side) => {
    const c = clipSeg(x0 / 10, z0 / 10, x1 / 10, z1 / 10, S); if (!c) return;
    if (Math.hypot(c[2] - c[0], c[3] - c[1]) < 0.5) return;
    out.segs.push([t.x + c[0] / S, t.y + c[1] / S, t.x + c[2] / S, t.y + c[3] / S, k, side]);
  };
  const line = (p, k, side) => { for (let i = 2; i + 1 < (p?.length || 0); i += 2) pushSeg(p[i - 2], p[i - 1], p[i], p[i + 1], k, side); };
  const ring = (r, k) => { const n = r?.length || 0; for (let i = 0; i + 1 < n; i += 2) { const j = (i + 2) % n; pushSeg(r[i], r[i + 1], r[j], r[j + 1], k, 0); } };
  for (const q of v.quays || []) line(q.p, q.k === 'osm' ? 'osm' : 'derived', q.side === -1 ? -1 : 1);
  for (const p of v.piers || []) ring(p.r, 'pier');
  for (const p of v.pontoons || []) ring(p.r, 'pontoon');
  for (const b of v.bridges || []) { const p = b.p || []; const pts = []; for (let i = 0; i + 1 < p.length; i += 2) pts.push(...g(p[i], p[i + 1])); if (pts.length >= 4) out.bridges.push({ pts, w: Number(b.w) || 10 }); }
  for (const l of v.locks || []) { const r = l.r || []; const pts = []; for (let i = 0; i + 1 < r.length; i += 2) pts.push(...g(r[i], r[i + 1])); if (pts.length >= 6) out.locks.push(pts); }
  for (const c of v.cranes || []) out.cranes.push([...g(c.x, c.z), c.k === 'sts' ? 1 : 0]);
  for (const k of v.tanks || []) out.tanks.push(g(k.x, k.z));
  for (const a of v.areas || []) {
    if (!['port', 'industrial', 'residential', 'commercial'].includes(a.k)) continue;
    const r = a.r || []; const pts = []; for (let i = 0; i + 1 < r.length; i += 2) pts.push(...g(r[i], r[i + 1]));
    if (pts.length >= 6) out.areas.push({ k: a.k, pts });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ chaining + straight runs
/** Chain segments (metric frame) whose ends meet within QUAY.JOIN_M into polylines; deterministic order. */
export function chainSegments(segs) {
  const J = QUAY.JOIN_M, cell = (x) => Math.floor(x / J);
  const used = new Uint8Array(segs.length), grid = new Map();
  const add = (x, z, i, end) => { const k = cell(x) + ',' + cell(z); let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push([i, end]); };
  segs.forEach((s, i) => { add(s[0], s[1], i, 0); add(s[2], s[3], i, 1); });
  const find = (x, z, kind) => { // an unused segment of the same kind starting/ending at (x, z)
    let best = null, bd = J;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const [i, end] of grid.get((cell(x) + dx) + ',' + (cell(z) + dz)) || []) {
      if (used[i] || segs[i][4] !== kind) continue;
      const s = segs[i], d = Math.hypot(s[end * 2] - x, s[end * 2 + 1] - z);
      if (d < bd || (d === bd && best && i < best[0])) { bd = d; best = [i, end]; }
    }
    return best;
  };
  const lines = [];
  for (let i0 = 0; i0 < segs.length; i0++) {
    if (used[i0]) continue;
    used[i0] = 1; const s0 = segs[i0], kind = s0[4];
    const pts = [[s0[0], s0[1]], [s0[2], s0[3]]];
    for (let guard = 0; guard < 4000; guard++) { // forward
      const e = pts[pts.length - 1], f = find(e[0], e[1], kind); if (!f) break;
      used[f[0]] = 1; const s = segs[f[0]]; pts.push(f[1] === 0 ? [s[2], s[3]] : [s[0], s[1]]);
    }
    for (let guard = 0; guard < 4000; guard++) { // backward
      const e = pts[0], f = find(e[0], e[1], kind); if (!f) break;
      used[f[0]] = 1; const s = segs[f[0]]; pts.unshift(f[1] === 0 ? [s[2], s[3]] : [s[0], s[1]]);
    }
    lines.push({ pts, kind });
  }
  return lines;
}
/** Greedy maximal straight runs along a polyline: every vertex within STRAIGHT_TOL_M of the run line, every segment within STRAIGHT_TURN_DEG. */
export function straightRuns(pts, minLen = QUAY.MIN_RUN_M) {
  const out = [], n = pts.length, tol = QUAY.STRAIGHT_TOL_M, cosT = Math.cos(QUAY.STRAIGHT_TURN_DEG * D2R);
  let s = 0;
  while (s < n - 1) {
    let e = s + 1;
    while (e + 1 < n) {
      const c = e + 1, ax = pts[s][0], az = pts[s][1], dx = pts[c][0] - ax, dz = pts[c][1] - az, L = Math.hypot(dx, dz);
      if (L < 1e-6) { e = c; continue; }
      const ux = dx / L, uz = dz / L;
      let ok = true;
      for (let k = s + 1; k < c && ok; k++) if (Math.abs((pts[k][0] - ax) * uz - (pts[k][1] - az) * ux) > tol) ok = false;
      for (let k = s; k < c && ok; k++) {
        const sx = pts[k + 1][0] - pts[k][0], sz = pts[k + 1][1] - pts[k][1], sl = Math.hypot(sx, sz);
        if (sl > 1 && (sx * ux + sz * uz) / sl < cosT) ok = false;
      }
      if (!ok) break;
      e = c;
    }
    const L = Math.hypot(pts[e][0] - pts[s][0], pts[e][1] - pts[s][1]);
    if (L >= minLen) out.push([pts[s][0], pts[s][1], pts[e][0], pts[e][1]]);
    s = e;
  }
  return out;
}

/** Total-least-squares line through points [[x, z], …] → { cx, cz, ux, uz } (unit direction). */
function fitLine(pts) {
  let cx = 0, cz = 0; for (const p of pts) { cx += p[0]; cz += p[1]; } cx /= pts.length; cz /= pts.length;
  let sxx = 0, sxz = 0, szz = 0; for (const p of pts) { const dx = p[0] - cx, dz = p[1] - cz; sxx += dx * dx; sxz += dx * dz; szz += dz * dz; }
  const th = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  return { cx, cz, ux: Math.cos(th), uz: Math.sin(th) };
}
function orientLike(l, ref) { if (l.ux * ref.ux + l.uz * ref.uz < 0) { l.ux = -l.ux; l.uz = -l.uz; } return l; }
/**
 * Orient a straight piece so the water lies on its right (x east, z south: right of (ux, uz) is (−uz, ux)), sampling
 * 6 m off both sides at its quarter points. null when it is not a face (water or land on both sides, or not loaded).
 */
export function orientPiece(r, navM) {
  const L = Math.hypot(r[2] - r[0], r[3] - r[1]); if (L < 1e-6) return null;
  const ux = (r[2] - r[0]) / L, uz = (r[3] - r[1]) / L;
  let right = 0, left = 0, known = 0;
  for (const f of [0.25, 0.5, 0.75]) {
    const px = r[0] + (r[2] - r[0]) * f, pz = r[1] + (r[3] - r[1]) * f;
    const a = navM(px - uz * 6, pz + ux * 6), b = navM(px + uz * 6, pz - ux * 6);
    if (a == null || b == null) continue;
    known++; if (a) right++; if (b) left++;
  }
  if (known < 2) return null;
  if (right >= 2 && left <= known - 2) return r.slice();
  if (left >= 2 && right <= known - 2) return [r[2], r[3], r[0], r[1]];
  return null;
}
/**
 * Grow straight quay walls out of straight pieces: derived quay edges come as a staircase of short pieces with gaps
 * (the converter keeps straight runs ≥ 30 m of a raster boundary), an overlay quay may lie on top of a derived one, a
 * pier edge may double a quay edge. Starting from the longest piece, a wall takes every piece whose direction is within
 * MERGE_DEG of the wall's best-fit line, that keeps every sample point within MERGE_OFF_M of the refitted line and that
 * starts within MERGE_GAP_M of the wall's ends (or overlaps it). Pontoons only join pontoons. Deterministic.
 * pieces: [{ r: [x0, z0, x1, z1], kind }] (metric, oriented: water on the right) → [{ r, kind }] (r = the wall's extent on
 * its fitted line, same orientation).
 */
export function mergeCollinear(pieces) {
  const len = (r) => Math.hypot(r[2] - r[0], r[3] - r[1]);
  const P = pieces.filter((p) => len(p.r) > 1e-6).map((p) => ({ r: p.r, kind: p.kind, L: len(p.r) }))
    .sort((a, b) => b.L - a.L || a.r[0] - b.r[0] || a.r[1] - b.r[1] || a.r[2] - b.r[2] || a.r[3] - b.r[3]);
  const cosM = Math.cos(QUAY.MERGE_DEG * D2R), G = QUAY.MERGE_GAP_M, tol = QUAY.MERGE_OFF_M;
  const samples = (r) => { const n = Math.max(1, Math.ceil(len(r) / 10)), out = []; for (let i = 0; i <= n; i++) out.push([r[0] + ((r[2] - r[0]) * i) / n, r[1] + ((r[3] - r[1]) * i) / n]); return out; };
  // grid of piece midpoints for the neighbour search
  const CELL = 200, grid = new Map(), ck = (x, z) => Math.floor(x / CELL) + ',' + Math.floor(z / CELL);
  P.forEach((p, i) => { const k = ck((p.r[0] + p.r[2]) / 2, (p.r[1] + p.r[3]) / 2); let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(i); });
  const used = new Uint8Array(P.length), out = [];
  for (let i0 = 0; i0 < P.length; i0++) {
    if (used[i0]) continue;
    used[i0] = 1;
    const pont = P[i0].kind === 'pontoon';
    const r0 = P[i0].r;
    let pts = samples(r0), line = orientLike(fitLine(pts), { ux: (r0[2] - r0[0]) / P[i0].L, uz: (r0[3] - r0[1]) / P[i0].L }), lo = 0, hi = 0;
    const extent = () => { lo = Infinity; hi = -Infinity; for (const p of pts) { const s = (p[0] - line.cx) * line.ux + (p[1] - line.cz) * line.uz; if (s < lo) lo = s; if (s > hi) hi = s; } };
    extent();
    for (let grow = true, guard = 0; grow && guard < 400; guard++) {
      grow = false;
      const ex = [line.cx + line.ux * lo, line.cz + line.uz * lo], ey = [line.cx + line.ux * hi, line.cz + line.uz * hi];
      const cand = new Set();
      for (const e of [ex, ey, [line.cx, line.cz]]) {
        const gx = Math.floor(e[0] / CELL), gz = Math.floor(e[1] / CELL), rr = Math.ceil((hi - lo) / 2 / CELL) + 1;
        const R = e === ex || e === ey ? 2 : rr;
        for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) for (const j of grid.get((gx + dx) + ',' + (gz + dz)) || []) if (!used[j]) cand.add(j);
      }
      for (const j of [...cand].sort((a, b) => a - b)) {
        const B = P[j]; if ((B.kind === 'pontoon') !== pont) continue;
        const b = B.r, bx = (b[2] - b[0]) / B.L, bz = (b[3] - b[1]) / B.L;
        if (bx * line.ux + bz * line.uz < cosM) continue;                      // same water side only (pieces are oriented)
        const s0 = (b[0] - line.cx) * line.ux + (b[1] - line.cz) * line.uz, s1 = (b[2] - line.cx) * line.ux + (b[3] - line.cz) * line.uz;
        const o0 = (b[0] - line.cx) * -line.uz + (b[1] - line.cz) * line.ux, o1 = (b[2] - line.cx) * -line.uz + (b[3] - line.cz) * line.ux;
        if (Math.abs(o0) > tol * 2 || Math.abs(o1) > tol * 2) continue;
        if (Math.min(s0, s1) > hi + G || Math.max(s0, s1) < lo - G) continue;
        const np = pts.concat(samples(b)), nl = orientLike(fitLine(np), line);
        let ok = true; for (const p of np) if (Math.abs((p[0] - nl.cx) * -nl.uz + (p[1] - nl.cz) * nl.ux) > tol) { ok = false; break; }
        if (!ok) continue;
        used[j] = 1; pts = np; line = nl; extent(); grow = true;
      }
    }
    out.push({ r: [line.cx + line.ux * lo, line.cz + line.uz * lo, line.cx + line.ux * hi, line.cz + line.uz * hi], kind: P[i0].kind });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ the analyser
/**
 * createQuayFinder({ getTile, harbors, guard, featCap, runCap }) → finder
 *   getTile(z, x, y)  sync decoded tile | null (server/worldtiles.js `get`; tests: a Map of converted fixtures)
 *   harbors           the game harbours ({ id, name, lat, lon, size }) — the linked harbour is the nearest one
 *   guard             server/memguard.js guard (optional)
 */
export function createQuayFinder(opts = {}) {
  const getTile = opts.getTile || (() => null);
  const harbors = opts.harbors || [];
  const guard = opts.guard || null;
  const feats = lru(opts.featCap ?? 48), runsCache = lru(opts.runCap ?? 64);
  const sample = makeSampler(getTile);
  const st = { analysed: 0, cacheHits: 0, busy: 0, queries: 0, ms: 0 };
  const level = () => { try { return guard ? guard.level() : 0; } catch { return 0; } };
  if (guard && typeof guard.onShed === 'function') guard.onShed(() => { feats.clear(); runsCache.clear(); });

  const tileOf = (x, y) => { try { return getTile(Z, x, y); } catch { return null; } };
  function featuresOf(t) {
    const k = `${t.x}/${t.y}:${t.contentHash >>> 0}:${t.rev | 0}`;
    let f = feats.get(k); if (f) return f;
    f = tileFeatures(t); feats.max = level() >= 3 ? 8 : (opts.featCap ?? 48); feats.set(k, f);
    return f;
  }

  /** Runs owned by tile (ax, ay), from it and its 8 neighbours. null when the tile is not in memory or memory is critical. */
  function runsFor(ax, ay, budget = null) {
    const t0 = tileOf(ax, ay); if (!t0) return null;
    const sigParts = [];
    const nb = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const t = tileOf(ax + dx, ay + dy); nb.push(t); sigParts.push(t ? `${t.contentHash >>> 0}.${t.rev | 0}` : 'x'); }
    const sig = sigParts.join('|'), key = `${ax}/${ay}`;
    const c = runsCache.get(key);
    if (c && c.sig === sig) { st.cacheHits++; return c.runs; }
    if (level() >= 4) { st.busy++; return null; }
    if (budget) { if (budget.left <= 0) return undefined; budget.left--; }
    const runs = analyse(ax, ay, nb.filter(Boolean).map(featuresOf));
    st.analysed++;
    runsCache.max = level() >= 3 ? 16 : (opts.runCap ?? 64);
    runsCache.set(key, { sig, runs, complete: !sig.includes('x') });
    return runs;
  }

  function analyse(ax, ay, fl) {
    const lat0 = tileFToLatLon(Z, ax + 0.5, ay + 0.5).lat, S = tileSizeM(Z, lat0);
    const toM = (fx, fy) => [(fx - ax) * S, (fy - ay) * S];
    const toLL = (X, Zm) => tileFToLatLon(Z, ax + X / S, ay + Zm / S);
    // face segments → metric, by kind (quay walls chain with quay walls, pier edges with pier edges …)
    const segs = [];
    for (const f of fl) for (const s of f.segs) { const a = toM(s[0], s[1]), b = toM(s[2], s[3]); segs.push([a[0], a[1], b[0], b[1], s[4] === 'derived' || s[4] === 'osm' ? 'quay' : s[4], s[5]]); }
    segs.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2] || p[3] - q[3]);
    const lines = chainSegments(segs);
    const bridges = fl.flatMap((f) => f.bridges.map((b) => ({ w: b.w, pts: b.pts.map((v, i) => (i % 2 ? (v - ay) * S : (v - ax) * S)) })));
    const locks = fl.flatMap((f) => f.locks.map((r) => r.map((v, i) => (i % 2 ? (v - ay) * S : (v - ax) * S))));
    const cranes = fl.flatMap((f) => f.cranes.map((c) => [(c[0] - ax) * S, (c[1] - ay) * S, c[2]]));
    const tanks = fl.flatMap((f) => f.tanks.map((c) => [(c[0] - ax) * S, (c[1] - ay) * S]));
    const areas = fl.flatMap((f) => f.areas.map((a) => ({ k: a.k, pts: a.pts.map((v, i) => (i % 2 ? (v - ay) * S : (v - ax) * S)) })));
    const out = [];
    const pieces = [];
    const navM = (X, Zm) => { const ll = toLL(X, Zm); const sm = sample(ll.lat, ll.lon); return sm ? WT_NAVIGABLE[sm.mask] === 1 : null; };
    for (const ln of lines) for (const r of straightRuns(ln.pts, 8)) {
      const o = orientPiece(r, navM); if (o) pieces.push({ r: o, kind: ln.kind });
    }
    for (const { r: piece, kind } of mergeCollinear(pieces)) {
      // split very long runs into equal pieces (deterministic, by the run alone)
      const L0 = Math.hypot(piece[2] - piece[0], piece[3] - piece[1]); if (L0 < QUAY.MIN_RUN_M) continue;
      const parts = Math.max(1, Math.ceil(L0 / QUAY.MAX_RUN_M));
      for (let pi = 0; pi < parts; pi++) {
        const f0 = pi / parts, f1 = (pi + 1) / parts;
        const r = [piece[0] + (piece[2] - piece[0]) * f0, piece[1] + (piece[3] - piece[1]) * f0, piece[0] + (piece[2] - piece[0]) * f1, piece[1] + (piece[3] - piece[1]) * f1];
        const mx = (r[0] + r[2]) / 2, mz = (r[1] + r[3]) / 2;
        if (mx < 0 || mz < 0 || mx >= S || mz >= S) continue;               // owned by the tile holding its midpoint
        const run = buildRun(r, kind, { toLL, bridges, locks, cranes, tanks, areas });
        if (run) out.push(run);
      }
    }
    out.sort((p, q) => p.mLat - q.mLat || p.mLon - q.mLon || p.len - q.len);
    out.forEach((r, i) => { r.id = `q${ax}.${ay}.${i}`; });
    return out;
  }

  function buildRun(r, kind, ctx) {
    let [ax, az, bx, bz] = r;
    const L = Math.hypot(bx - ax, bz - az); if (L < QUAY.MIN_RUN_M) return null;
    let ux = (bx - ax) / L, uz = (bz - az) / L;
    // water side: sample 8 m off both sides at 3 points; the face needs water on one side and land on the other
    const navAt = (X, Zm) => { const ll = ctx.toLL(X, Zm); const s = sample(ll.lat, ll.lon); return s ? WT_NAVIGABLE[s.mask] === 1 : null; };
    let right = 0, left = 0, known = 0;
    for (const f of [0.25, 0.5, 0.75]) {
      const px = ax + (bx - ax) * f, pz = az + (bz - az) * f;
      const a = navAt(px - uz * 8, pz + ux * 8), b = navAt(px + uz * 8, pz - ux * 8);
      if (a != null && b != null) known++;
      if (a) right++; if (b) left++;
    }
    if (known < 2) return null;
    let side;
    if (right >= 2 && left <= 1) side = 1; else if (left >= 2 && right <= 1) side = -1; else return null;
    if (side === -1) { [ax, az, bx, bz] = [bx, bz, ax, az]; ux = -ux; uz = -uz; } // water always on the right of a → b
    // snap the line to the real wall: at every step find the land → water edge in the mask within ±REFINE_M of the line,
    // and refit through those edge points (derived quay vectors are a staircase that can sit ±8 m off a sloping wall)
    {
      const edge = [], nx0 = -uz, nz0 = ux, n = Math.max(2, Math.floor(L / QUAY.STEP_M));
      for (let k = 0; k < n; k++) {
        const s0 = ((k + 0.5) * L) / n, px = ax + ux * s0, pz = az + uz * s0;
        let prev = null;
        for (let o = -QUAY.REFINE_M; o <= QUAY.REFINE_M; o += 1) {
          const w = navAt(px + nx0 * o, pz + nz0 * o);
          if (w == null) { prev = null; continue; }
          if (prev === false && w === true) { edge.push([px + nx0 * (o - 0.5), pz + nz0 * (o - 0.5)]); break; }
          prev = w;
        }
      }
      if (edge.length >= Math.max(2, n * 0.5)) {
        const l = orientLike(fitLine(edge), { ux, uz });
        const proj = (x, z) => { const t = (x - l.cx) * l.ux + (z - l.cz) * l.uz; return [l.cx + l.ux * t, l.cz + l.uz * t]; };
        [ax, az] = proj(ax, az); [bx, bz] = proj(bx, bz); ux = l.ux; uz = l.uz;
      }
    }
    const nx = -uz, nz = ux;                                                         // water normal (x east, z south)
    const nSteps = Math.max(2, Math.floor(L / QUAY.STEP_M)), step = L / nSteps;
    const prof = [], cut = new Array(nSteps).fill(0), mid = ctx.toLL((ax + bx) / 2, (az + bz) / 2), lw = lowWaterAt(mid.lat, mid.lon);
    const O = QUAY.OFFSETS_M;
    for (let k = 0; k < nSteps; k++) {
      const s = (k + 0.5) * step, px = ax + ux * s, pz = az + uz * s;
      const row = [];
      for (let oi = 0; oi < O.length; oi++) {
        const X = px + nx * O[oi], Zm = pz + nz * O[oi], ll = ctx.toLL(X, Zm), sm = sample(ll.lat, ll.lon);
        let d = NO_WATER;
        if (sm && WT_NAVIGABLE[sm.mask] === 1) d = r1(-sm.h + lw);                  // depth at low water (game.depthAtLowWater)
        if (sm && sm.mask === WT.MASK.LOCK) cut[k] |= CUT.LOCK;
        if (sm && sm.mask === WT.MASK.FAIRWAY && O[oi] <= QUAY.FAIRWAY_OFFSET_M) cut[k] |= CUT.FAIRWAY;
        row.push(d);
        // locks by ring too (the mask may call a chamber DOCK)
        if (oi === 1) for (const lk of ctx.locks) if (inRing(lk, X, Zm)) cut[k] |= CUT.LOCK;
      }
      for (const b of ctx.bridges) {
        const lim = b.w / 2 + QUAY.BRIDGE_CLEAR_M;
        for (let i = 2; i + 1 < b.pts.length; i += 2) if (segDist(px + nx * 10, pz + nz * 10, b.pts[i - 2], b.pts[i - 1], b.pts[i], b.pts[i + 1]) < lim) { cut[k] |= CUT.BRIDGE; break; }
      }
      if (row[0] === NO_WATER) cut[k] |= CUT.SHALLOW_FACE;
      prof.push(row);
    }
    if (cut.every((c) => c & CUT.SHALLOW_FACE)) return null;
    // class (from what stands on the land side)
    const lx = (ax + bx) / 2 - nx * 30, lz = (az + bz) / 2 - nz * 30;
    const near = (pt, m) => segDist(pt[0], pt[1], ax - nx * 20, az - nz * 20, bx - nx * 20, bz - nz * 20) <= m;
    const sts = ctx.cranes.some((c) => c[2] === 1 && near(c, 80)), crane = sts || ctx.cranes.some((c) => near(c, 80));
    const tank = ctx.tanks.some((c) => near(c, 150));
    const area = ctx.areas.find((a) => inRing(a.pts, lx, lz))?.k || null;
    const maxDepth = Math.max(...prof.map((row) => row[0]));
    let cls;
    if (kind === 'pontoon') cls = 'marina';
    else if (sts) cls = 'terminal';
    else if (crane || area === 'port') cls = maxDepth >= 10 ? 'terminal' : 'industrial';
    else if (tank || area === 'industrial') cls = 'industrial';
    else if (area === 'residential' || area === 'commercial') cls = 'city';
    else cls = 'quay';
    const a = ctx.toLL(ax, az), b = ctx.toLL(bx, bz), m = ctx.toLL((ax + bx) / 2, (az + bz) / 2);
    const hdg = (Math.atan2(ux, -uz) * R2D + 360) % 360, wb = (Math.atan2(nx, -nz) * R2D + 360) % 360;
    const link = linkHarbour(harbors, m.lat, m.lon);
    return {
      id: '', kind, cls, len: Math.round(L * 10) / 10, step, hdg: r1(hdg), wb: r1(wb),
      aLat: a.lat, aLon: a.lon, bLat: b.lat, bLon: b.lon, mLat: m.lat, mLon: m.lon,
      prof, cut, harbor: link ? link.harbor.id : null, hdKm: link ? link.dKm : null, tier: link ? serviceTier(link.harbor, link.dKm) : 'none',
    };
  }

  /** Runs whose tiles are in memory within radiusM of a point. */
  // At most `maxNew` tiles are analysed per call (≈ 30 ms each), nearest first, so a query never blocks the tick for
  // long; the rest are `pending` and come with the next query (the client re-asks every 2 s while the card is open).
  function runsNear(lat, lon, radiusM = QUAY.QUERY_RADIUS_M, maxNew = QUAY.MAX_NEW_TILES) {
    const out = [], budget = { left: maxNew }; let missing = 0, pending = 0, busy = false;
    for (const t of tilesInRadius(Z, lat, lon, radiusM)) {
      const rs = runsFor(t.x, t.y, budget);
      if (rs === undefined) { pending++; continue; }
      if (rs == null) { if (level() >= 4) busy = true; else missing++; continue; }
      out.push(...rs);
    }
    return { runs: out, missing, pending, busy };
  }

  return { runsFor, runsNear, stats: () => ({ ...st, featTiles: feats.size, runTiles: runsCache.size }), clear() { feats.clear(); runsCache.clear(); } };
}

// ------------------------------------------------------------------------------------------------ run frame
/** Local frame of a run: along (m from a toward b) and off (m from the face into the water) of a point. */
export function runFrame(run, lat, lon) {
  const k = M_LAT * Math.cos(run.aLat * D2R);
  const E = (lon - run.aLon) * k, N = (lat - run.aLat) * M_LAT;
  const h = run.hdg * D2R, w = run.wb * D2R;
  return { along: E * Math.sin(h) + N * Math.cos(h), off: E * Math.sin(w) + N * Math.cos(w) };
}
/** lat/lon of (along, off) in a run's frame. */
export function runPoint(run, along, off) {
  const k = M_LAT * Math.cos(run.aLat * D2R), h = run.hdg * D2R, w = run.wb * D2R;
  const E = along * Math.sin(h) + off * Math.sin(w), N = along * Math.cos(h) + off * Math.cos(w);
  return { lat: run.aLat + N / M_LAT, lon: run.aLon + E / k };
}

// ------------------------------------------------------------------------------------------------ fit + occupancy
/** Intervals [s0, s1] (m along the run) of consecutive steps passing `ok(k)`. */
function stepIntervals(run, ok) {
  const out = []; let s0 = null;
  for (let k = 0; k <= run.cut.length; k++) {
    const pass = k < run.cut.length && ok(k);
    if (pass && s0 == null) s0 = k * run.step;
    if (!pass && s0 != null) { out.push([s0, k * run.step]); s0 = null; }
  }
  return out;
}
function subtract(intervals, blocks) {
  let cur = intervals.map((i) => i.slice());
  for (const [b0, b1] of blocks) {
    const nx = [];
    for (const [a0, a1] of cur) {
      if (b1 <= a0 || b0 >= a1) { nx.push([a0, a1]); continue; }
      if (b0 > a0) nx.push([a0, b0]);
      if (b1 < a1) nx.push([b1, a1]);
    }
    cur = nx;
  }
  return cur;
}
const longest = (iv) => iv.reduce((m, [a, b]) => Math.max(m, b - a), 0);

/**
 * Hulls lying along a run → blocked intervals with who lies there. occupants: [{ id, name, lat, lon, hdg, len, beam, kind }].
 * A hull blocks the stretch its length covers (+ 8 m each end) when its near side comes inside the strip this ship needs.
 */
export function occupiedIntervals(run, occupants, needW) {
  const out = [];
  for (const o of occupants || []) {
    if (!o || !Number.isFinite(o.lat) || !Number.isFinite(o.lon)) continue;
    const f = runFrame(run, o.lat, o.lon), len = Number(o.len) > 0 ? Number(o.len) : 100, beam = Number(o.beam) > 0 ? Number(o.beam) : Math.max(4, len / 7);
    const rel = Number.isFinite(o.hdg) ? Math.abs(Math.sin((o.hdg - run.hdg) * D2R)) : 1;   // 0 = parallel to the quay
    const halfAlong = Math.sqrt(1 - rel * rel) * len / 2 + rel * beam / 2, halfOff = rel * len / 2 + Math.sqrt(1 - rel * rel) * beam / 2;
    if (f.off + halfOff < -5 || f.off - halfOff > needW) continue;
    if (f.along + halfAlong < -20 || f.along - halfAlong > run.len + 20) continue;
    out.push({ s0: f.along - halfAlong - 8, s1: f.along + halfAlong + 8, who: o });
  }
  return out;
}

/**
 * Fit of one run for one ship → { fits, why, slot, depthLW, usable, longestM, occupiedBy }.
 *   ship: { lat, lon, hdg, cls }   opts: { occupants, harbourBerths: [{lat, lon, hdg, length}], forbidden(lat, lon) }
 * The slot is the stretch of `neededLength` nearest the ship inside the longest suitable free stretch, its centre on a
 * 5 m grid; the ship lies FENDER_M + beam / 2 off the face, heading along the quay the way she already points.
 */
export function fitRun(run, ship, opts = {}) {
  const C = clsOf(ship.cls), need = neededLength(ship.cls), dNeed = neededDepth(ship.cls), W = neededWidth(ship.cls);
  const offs = offsetsFor(ship.cls);
  const depthAt = (k) => Math.min(...offs.map((i) => run.prof[k][i]));
  // dynamic cuts: harbour-patch berths and restricted areas (not cached: patches load later than tiles)
  const dyn = new Array(run.cut.length).fill(0);
  if (opts.harbourBerths?.length || opts.forbidden) {
    for (let k = 0; k < run.cut.length; k++) {
      const s = (k + 0.5) * run.step, p = runPoint(run, s, 0);
      for (const b of opts.harbourBerths || []) {
        const f = runFrame(run, b.lat, b.lon), half = (Number(b.length) || 60) / 2;
        if (Math.abs(f.off) < QUAY.HARBOUR_BERTH_M + 15 && Math.abs(f.along - s) < half + QUAY.HARBOUR_BERTH_M) { dyn[k] |= CUT.HARBOUR; break; }
      }
      try { if (opts.forbidden && opts.forbidden(p.lat, p.lon)) dyn[k] |= CUT.FORBIDDEN; } catch { /* predicate errors never block */ }
    }
  }
  const cutAt = (k) => run.cut[k] | dyn[k];
  const BLOCK = CUT.BRIDGE | CUT.LOCK | CUT.FAIRWAY | CUT.HARBOUR | CUT.FORBIDDEN;
  const nK = run.cut.length, O = QUAY.OFFSETS_M;
  const res = { fits: false, why: null, slot: null, depthLW: null, usable: 0, longestM: 0, occupiedBy: null, need, dNeed, needW: W };
  if (run.cls === 'marina' && C.length > QUAY.SMALL_CRAFT_M) { res.why = `A pontoon for small craft; a ${C.name.toLowerCase()} needs a quay wall.`; res.depthLW = Math.max(...run.prof.map((r) => r[0])); return res; }
  const legalK = (k) => !(cutAt(k) & BLOCK);
  // per step: wide = no land / structure inside the needed width beyond the face band; deep = every needed offset deep enough
  const wideK = [], deepK = [];
  for (let k = 0; k < nK; k++) {
    wideK.push(offs.every((i) => O[i] <= QUAY.FACE_BAND_M || run.prof[k][i] > NO_WATER));
    deepK.push(depthAt(k) >= dNeed);
  }
  // notches: ≤ NOTCH_STEPS failing steps between passing ones, failing only in the face band (raster stairs along a
  // sloping wall, a shore-ramp cell at a corner), do not break a berth — the hull lies on fenders, not on the face cells
  const faceOnly = (k) => offs.every((i) => O[i] <= QUAY.FACE_BAND_M || run.prof[k][i] >= dNeed);
  const notch = new Array(nK).fill(false);
  for (let k = 0; k < nK;) {
    if (deepK[k]) { k++; continue; }
    let e = k; while (e < nK && !deepK[e]) e++;
    if (k > 0 && e < nK && e - k <= QUAY.NOTCH_STEPS) for (let j = k; j < e; j++) if (faceOnly(j) && wideK[j]) notch[j] = true;
    k = e;
  }
  const deepOK = (k) => deepK[k] || notch[k];
  const legal = stepIntervals(run, legalK);
  const wide = stepIntervals(run, (k) => legalK(k) && wideK[k]);
  const deep = stepIntervals(run, (k) => legalK(k) && wideK[k] && deepOK(k));
  const occ = occupiedIntervals(run, opts.occupants, W);
  const usable = subtract(deep, occ.map((o) => [o.s0, o.s1]));
  res.usable = Math.round(longest(usable)); res.longestM = Math.round(longest(legal));
  const ks = []; for (let k = 0; k < nK; k++) if (legalK(k) && !notch[k]) ks.push(k);
  res.depthLW = ks.length ? r1(Math.max(...ks.map(depthAt))) : null;
  if (res.depthLW != null && res.depthLW <= NO_WATER) res.depthLW = null;
  if (longest(usable) >= need) {
    const f = runFrame(run, ship.lat, ship.lon);
    // the free stretch nearest the ship among those long enough; the slot centre on a 5 m grid
    const cands = usable.filter(([a, b]) => b - a >= need).map(([a, b]) => {
      const lo = a + need / 2, hi = b - need / 2;
      let c = Math.round(Math.max(lo, Math.min(hi, f.along)) / 5) * 5;
      if (c < lo) c += 5; if (c > hi) c -= 5;
      if (c < lo || c > hi) c = Math.round(((lo + hi) / 2) * 10) / 10;
      return { a, b, c, d: Math.abs(c - f.along) };
    }).sort((p, q) => p.d - q.d || p.c - q.c);
    const best = cands[0];
    const k0 = Math.max(0, Math.floor((best.c - need / 2) / run.step)), k1 = Math.min(nK - 1, Math.floor((best.c + need / 2 - 1e-6) / run.step));
    let dmin = Infinity; for (let k = k0; k <= k1; k++) if (!notch[k]) dmin = Math.min(dmin, depthAt(k));
    const off = QUAY.FENDER_M + C.beam / 2, p = runPoint(run, best.c, off);
    const flip = Number.isFinite(ship.hdg) && Math.abs(((ship.hdg - run.hdg + 540) % 360) - 180) > 90;
    res.fits = true; res.depthLW = Number.isFinite(dmin) ? r1(dmin) : res.depthLW;
    res.slot = {
      id: `${run.id}@${best.c}`, s: best.c, len: need, lat: p.lat, lon: p.lon, off,
      hdg: r1(flip ? (run.hdg + 180) % 360 : run.hdg),
      a: runPoint(run, best.c - need / 2, 0), b: runPoint(run, best.c + need / 2, 0),          // the stretch of quay face
    };
    return res;
  }
  // why not, most fundamental first
  if (longest(legal) < need) {
    const blocked = run.cut.map((_, k) => cutAt(k) & BLOCK).filter(Boolean);
    const w = blocked.length ? CUT_WHY.find(([b]) => blocked.some((c) => c & b)) : null;
    if (w && longest(legal) < QUAY.MIN_RUN_M) { res.why = `No berth here: ${w[1]}.`; return res; }
    res.why = `Too short: ${Math.round(longest(legal))} m of quay${w ? ` clear of ${w[1].replace(/^(in|on|under or next to) (a |the )?/, '')}` : ''}; your ${C.length} m hull needs ${need} m.`; return res;
  }
  if (longest(wide) < need) { res.why = `Too narrow: land or a structure within ${Math.round(W)} m of the quay face; your ${C.beam} m beam needs ${Math.round(W)} m of clear water.`; return res; }
  if (longest(deep) < need) {
    res.why = res.depthLW != null && res.depthLW >= dNeed
      ? `Too shallow in places: only ${Math.round(longest(deep))} m of this quay has ${dNeed.toFixed(1)} m at low water; your hull needs ${need} m of it.`
      : `Too shallow: ${res.depthLW != null ? res.depthLW.toFixed(1) + ' m' : 'no water'} at low water alongside; you draw ${C.draft} m and need ${dNeed.toFixed(1)} m.`;
    return res;
  }
  const who = occ.map((o) => o.who).sort((a, b) => distM(ship.lat, ship.lon, a.lat, a.lon) - distM(ship.lat, ship.lon, b.lat, b.lon))[0] || null;
  res.occupiedBy = who ? { id: who.id ?? null, name: who.name || 'a ship', kind: who.kind || null } : null;
  res.why = `Occupied: ${who?.name || 'another ship'} lies here; ${Math.round(longest(usable))} m free, you need ${need} m.`;
  return res;
}

// ------------------------------------------------------------------------------------------------ the query
/**
 * Candidate berths near a ship (the `quay_query` answer).
 *   finder         createQuayFinder(…)
 *   ship           { lat, lon, hdg, spd (kn), cls }
 *   opts           { occupants, harbourBerths(lat, lon, rangeM) → berths, forbidden, home (harbour id), harborById(id), radiusM }
 * → { at, ship, list: [Candidate], missing, busy }  (Candidate in docs/DOCK-ANYWHERE-CONTRACT.md §4.1)
 */
export function queryQuays(finder, ship, opts = {}) {
  const t0 = Date.now();
  const R = opts.radiusM ?? QUAY.QUERY_RADIUS_M;
  const { runs, missing, pending = 0, busy } = finder.runsNear(ship.lat, ship.lon, R + 200, opts.maxNew);
  const hb = typeof opts.harbourBerths === 'function' ? (() => { try { return opts.harbourBerths(ship.lat, ship.lon, R + 1500) || []; } catch { return []; } })() : opts.harbourBerths || [];
  const hById = opts.harborById || ((id) => (opts.harbors || []).find((h) => h.id === id) || null);
  const rows = [];
  for (const run of runs) {
    const f = runFrame(run, ship.lat, ship.lon);
    const along = Math.max(0, Math.min(run.len, f.along)), p = runPoint(run, along, 0);
    const d = distM(ship.lat, ship.lon, p.lat, p.lon);
    if (d > R) continue;
    rows.push({ run, d });
  }
  rows.sort((a, b) => a.d - b.d || (a.run.id < b.run.id ? -1 : 1));
  const list = [];
  for (const { run, d } of rows.slice(0, QUAY.MAX_CANDIDATES * 2)) {
    const fit = fitRun(run, ship, { occupants: opts.occupants, harbourBerths: hb, forbidden: opts.forbidden });
    if (!fit.fits && /^No berth here/.test(fit.why || '') && list.length >= QUAY.MAX_CANDIDATES / 2) continue; // keep the list useful
    list.push(candidate(run, fit, ship, d, hById, opts.home));
    if (list.length >= QUAY.MAX_CANDIDATES) break;
  }
  // fitting berths first (nearest first), then the rest (nearest first)
  list.sort((a, b) => (b.fits - a.fits) || a.distM - b.distM);
  return { at: Date.now(), ship: { lat: ship.lat, lon: ship.lon, cls: ship.cls }, list, missing, pending, busy, ms: Date.now() - t0 };
}

/** Public candidate (what the client card and the outline need). */
export function candidate(run, fit, ship, d, hById, homeId) {
  const h = run.harbor ? hById(run.harbor) : null;
  const tier = run.tier || 'none';
  const perDay = quayFeePerDay(ship.cls, run.cls, { size: h?.size, tier, home: !!homeId && homeId === run.harbor });
  const C = clsOf(ship.cls);
  return {
    id: run.id, slotId: fit.slot?.id || null, name: quayName(run, h), cls: run.cls, clsName: QUAY_CLASSES[run.cls]?.name || 'Quay',
    lenM: Math.round(run.len), usableM: fit.usable, needM: fit.need, depthLW: fit.depthLW, needDepth: fit.dNeed,
    fits: fit.fits, why: fit.why, occupiedBy: fit.occupiedBy, distM: Math.round(d),
    face: { a: { lat: r6(run.aLat), lon: r6(run.aLon) }, b: { lat: r6(run.bLat), lon: r6(run.bLon) }, hdg: run.hdg, wb: run.wb },
    slot: fit.slot ? { lat: r6(fit.slot.lat), lon: r6(fit.slot.lon), hdg: fit.slot.hdg, len: fit.slot.len, beam: C.beam, a: ll6(fit.slot.a), b: ll6(fit.slot.b) } : null,
    perDay, harbor: h ? { id: h.id, name: h.name, size: h.size, distKm: run.hdKm } : null, tier, services: SERVICE_TIERS[tier], tabs: TIER_TABS[tier],
    tugs: tugsAvailable(tier, h), tugCost: quayTugCost(ship.cls, tier),
  };
}
const r6 = (v) => Math.round(v * 1e6) / 1e6;
const ll6 = (p) => ({ lat: r6(p.lat), lon: r6(p.lon) });
/** A stable, readable berth name: '<class> <code> · <harbour>'; the code comes from the run's position (same for everyone). */
export function quayName(run, h) {
  const code = (Math.abs(Math.round(run.mLat * 2000)) * 7919 + Math.abs(Math.round(run.mLon * 2000)) * 104729) % 1296;
  const tag = code.toString(36).toUpperCase().padStart(2, '0');
  const short = QUAY_CLASSES[run.cls]?.short || 'Quay';
  return h ? `${short} ${tag} · ${h.name.replace(/\s*\(.*\)\s*$/, '')}` : `${short} ${tag}`;
}

// ------------------------------------------------------------------------------------------------ docking checks
/**
 * Can this ship make fast at this candidate now? (quay_dock) → { ok, why, slot }. The run is re-analysed and the slot
 * re-fitted from the server's own data; the client's id only says which quay.
 */
export function dockCheck(finder, ship, runId, opts = {}) {
  const run = findRun(finder, ship.lat, ship.lon, runId);
  if (!run) return { ok: false, missing: true, why: 'That quay is not in range any more. Ask for quays again (Q).' };
  const fit = fitRun(run, ship, opts);
  if (!fit.fits) return { ok: false, why: fit.why, run, fit };
  const f = runFrame(run, ship.lat, ship.lon);
  const why = approachWhy({ lateralM: f.off - fit.slot.off, alongM: fit.slot.s - f.along, hdgDiffDeg: (ship.hdg ?? 0) - run.hdg, spdKn: ship.spd ?? 0, cls: ship.cls });
  if (why) return { ok: false, why, run, fit };
  return { ok: true, why: null, run, fit };
}
/** Tug check: in range, slow enough, the harbour has tugs for this quay, and a clear straight water path (sampled every 10 m). */
export function tugCheck(finder, ship, runId, opts = {}) {
  const run = findRun(finder, ship.lat, ship.lon, runId, QUAY.TUG_RANGE_M);
  if (!run) return { ok: false, why: 'That quay is not in range any more.' };
  const fit = fitRun(run, ship, opts);
  if (!fit.fits) return { ok: false, why: fit.why };
  const h = run.harbor && opts.harborById ? opts.harborById(run.harbor) : null;
  if (!tugsAvailable(run.tier, h)) return { ok: false, why: run.tier === 'near' ? `${h?.name || 'The harbour'} sends no tugs this far out. Come alongside yourself.` : 'No tugs out here. Come alongside yourself.' };
  if (Math.abs(ship.spd ?? 0) > QUAY.TUG_MAX_KN) return { ok: false, why: `Slow below ${QUAY.TUG_MAX_KN} kn so the tugs can make fast.` };
  const d = distM(ship.lat, ship.lon, fit.slot.lat, fit.slot.lon);
  if (d > QUAY.TUG_RANGE_M) return { ok: false, why: `Come within ${QUAY.TUG_RANGE_M / 1000} km of the quay for tugs.` };
  if (opts.sample && !straightWater(opts.sample, ship, fit.slot, clsOf(ship.cls).beam / 2)) return { ok: false, why: 'The tugs see no clear water from here to the quay. Come closer, in line with the berth.' };
  return { ok: true, run, fit, cost: quayTugCost(ship.cls, run.tier), harbor: h };
}
/** Every 10 m on the straight line (and ± halfBeam beside it) is navigable water in the loaded tiles. */
export function straightWater(sample, from, to, halfBeam = 0) {
  const d = distM(from.lat, from.lon, to.lat, to.lon), n = Math.max(2, Math.ceil(d / 10));
  const k = M_LAT * Math.cos(from.lat * D2R);
  const dE = (to.lon - from.lon) * k, dN = (to.lat - from.lat) * M_LAT, L = Math.hypot(dE, dN) || 1, pE = -dN / L, pN = dE / L;
  for (let i = 1; i < n; i++) {
    const f = i / n;
    for (const o of halfBeam > 0 ? [-halfBeam, 0, halfBeam] : [0]) {
      const E = dE * f + pE * o, N = dN * f + pN * o, s = sample(from.lat + N / M_LAT, from.lon + E / k);
      if (!s) return false;
      if (WT_NAVIGABLE[s.mask] !== 1) return false;
    }
  }
  return true;
}
function findRun(finder, lat, lon, runId, radiusM = QUAY.QUERY_RADIUS_M) {
  const m = /^q(\d+)\.(\d+)\.(\d+)$/.exec(String(runId || '').split('@')[0]);
  if (!m) return null;
  const runs = finder.runsFor(+m[1], +m[2]);
  const run = runs ? runs.find((r) => r.id === `q${m[1]}.${m[2]}.${m[3]}`) : null;
  if (!run) return null;
  const f = runFrame(run, lat, lon), p = runPoint(run, Math.max(0, Math.min(run.len, f.along)), 0);
  return distM(lat, lon, p.lat, p.lon) <= radiusM ? run : null;
}

/** The saved berth (p.berth) for a quay mooring. `paid` = what was charged when the lines went ashore (day 1). */
export function quayBerth(run, fit, ship, { perDay, harbor, simTime, paid }) {
  const s = fit.slot;
  return {
    quay: true, v: QUAY.VERSION, id: s.id, run: run.id, name: quayName(run, harbor), cls: run.cls,
    harbor: harbor ? harbor.id : null, tier: run.tier, hdKm: run.hdKm, lat: s.lat, lon: s.lon, hdg: s.hdg, wb: run.wb, off: s.off,
    depth: fit.depthLW, length: Math.round(run.len), slotLen: s.len, perDay, paid: paid || 0, since: simTime,
    a: s.a, b: s.b,
  };
}
/** Where a ship casting off from a quay berth starts: 20 m further out on the water side, same heading. */
export function quayUndockPoint(berth) {
  const k = M_LAT * Math.cos(berth.lat * D2R), w = (berth.wb ?? 0) * D2R, dist = 20;
  return { lat: berth.lat + (dist * Math.cos(w)) / M_LAT, lon: berth.lon + (dist * Math.sin(w)) / k, hdg: berth.hdg };
}

/**
 * Everything lying near a point that can occupy a quay, from a game (server/game.js) — players' ships (online or not,
 * moored or not), fleet vessels, AI traffic and live AIS vessels that are moored or stopped. except = the asking player.
 * → [{ id, name, lat, lon, hdg, len, beam, kind }]
 */
export function collectOccupants(game, lat, lon, rangeM, except = null) {
  const out = [], seen = new Set();
  const near = (o) => o && Number.isFinite(o.lat) && Number.isFinite(o.lon) && Math.abs(o.lat - lat) < rangeM / 100000 + 0.01 && distM(lat, lon, o.lat, o.lon) <= rangeM;
  const push = (s, o) => { if (!near(s) || seen.has(s)) return; seen.add(s); out.push(o); };
  try {
    for (const q of game.byId?.values?.() || []) {
      if (q === except || !q.ship) continue;
      const C = clsOf(q.ship.cls);
      push(q.ship, { id: q.id, name: q.name, lat: q.ship.lat, lon: q.ship.lon, hdg: q.ship.hdg, len: C.length, beam: C.beam, kind: 'player' });
    }
  } catch { /* none */ }
  try {
    const vs = game.fleet?.vesselsNear ? game.fleet.vesselsNear(lat, lon, rangeM, except?.vessel ?? null) : [];
    for (const v of vs || []) {
      if (!v?.ship || (except && (v === except.vessel || v.ship === except.ship))) continue;
      const C = clsOf(v.ship.cls);
      push(v.ship, { id: v.id ?? null, name: v.name || 'a fleet ship', lat: v.ship.lat, lon: v.ship.lon, hdg: v.ship.hdg, len: C.length, beam: C.beam, kind: 'fleet' });
    }
  } catch { /* none */ }
  const still = (a) => a && (a.state === 'moored' || a.state === 'stopped' || a.state === 'anchored' || (Number(a.spd ?? a.sog) || 0) < 0.5);
  try { for (const a of game.traffic?.near?.(lat, lon, rangeM) || []) if (still(a)) { const C = clsOf(a.cls); push(a, { id: a.id, name: a.name, lat: a.lat, lon: a.lon, hdg: a.hdg, len: C.length, beam: C.beam, kind: 'ai' }); } } catch { /* none */ }
  try { for (const a of game.liveAis?.near?.(lat, lon, rangeM, { limit: 400 }) || []) if (still(a)) { const C = clsOf(a.cls); push(a, { id: a.id, name: a.name, lat: a.lat, lon: a.lon, hdg: a.hdg, len: Number(a.length) || C.length, beam: Number(a.beam) || C.beam, kind: 'ais' }); } } catch { /* AIS down */ }
  return out;
}
