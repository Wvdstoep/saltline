// Tug assist path planning (V5-PLAN item 4). Pure and synchronous: no game state, no I/O.
//
// Works on a harbour patch (server/harborgeom.js: 448 × 448 cells at 10 m, mask + heights, encoded as 'SLHP') in the
// patch's local metre frame (x east, z south, origin = patch centre). The planner:
//   1. builds a clearance field = distance (m) from every water cell to the nearest hard obstacle (land, quay,
//      breakwater, pontoon), the same definition as harborgeom's SDF that the client uses for hull collision;
//   2. marks a cell passable for a hull when clearance ≥ half beam + margin and the water (heights + tide) floats the
//      keel with a margin;
//   3. A* over passable cells (8-connected, no diagonal corner cutting, a mild cost for hugging the walls);
//   4. string-pulls the cell path (every kept segment is re-checked: clearance and depth sampled every few metres),
//      rounds the corners with checked Bézier arcs, and ends with a straight run parallel to the quay;
//   5. a final sideways leg from that approach point onto the berth (the tugs push her in).
// If a ship starts in water that is too narrow or too shallow (aground, close to a quay), the shortest way out through
// water cells is used first. No path → `{ ok: false, reason }` and the caller refuses the assist.
import { GEO } from '../shared/constants.js';

const OBST = new Uint8Array([0, 1, 1, 1, 1, 0, 0]);   // PATCH.MASK code → hard obstacle
const H_OFFSET = 128, H_STEP = 0.25;                   // PATCH height encoding (h_m = (v − 128) × 0.25)
const D2R = Math.PI / 180, R2D = 180 / Math.PI;

export const TUGPATH = {
  MARGIN_M: 10,         // clearance beyond half the beam (V5-PLAN item 4)
  DEPTH_MARGIN_M: 0.5,  // water under the keel kept by the planner
  WALL_PENALTY: 1.5,    // A* cost multiplier for running close to the walls (centre of the channel preferred)
  ESCAPE_M: 500,        // a ship in water too tight / shallow for her is first led out through water up to this far
  SAMPLE_M: 1.5,        // segment check spacing (1.5 m: the clearance is bilinear over 10 m cells — 3 m let 0.1 m dips through)
};

// ------------------------------------------------------------------------------------------------ patch → grid
/** Decode an 'SLHP' patch buffer (harborgeom.encodePatch) without importing the geometry module. */
export function decodePatchBuffer(buf) {
  if (!buf || buf.length < 28 || String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) !== 'SLHP') return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = dv.getUint16(6, true), res = dv.getFloat32(8, true), originLat = dv.getFloat64(12, true), originLon = dv.getFloat64(20, true);
  const N = n * n;
  if (buf.length !== 28 + 2 * N) return null;
  return { n, res, originLat, originLon, heights: new Uint8Array(buf.buffer, buf.byteOffset + 28, N), mask: new Uint8Array(buf.buffer, buf.byteOffset + 28 + N, N) };
}

// Exact Euclidean distance transform (Felzenszwalb & Huttenlocher), distances in cells to the nearest seed cell.
const INF = 1e20;
function edt1d(f, n, d, v, z) {
  let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
}
function distanceToObstacles(mask, n) {
  const g = new Float64Array(n * n);
  for (let i = 0; i < n * n; i++) g[i] = OBST[mask[i]] ? 0 : INF;
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < n; x++) { for (let y = 0; y < n; y++) f[y] = g[y * n + x]; edt1d(f, n, d, v, z); for (let y = 0; y < n; y++) g[y * n + x] = d[y]; }
  const out = new Float32Array(n * n);
  for (let y = 0; y < n; y++) { const o = y * n; for (let x = 0; x < n; x++) f[x] = g[o + x]; edt1d(f, n, d, v, z); for (let x = 0; x < n; x++) out[o + x] = Math.sqrt(d[x]); }
  return out;
}

const gridCache = new WeakMap(); // patch buffer → grid (the clearance transform costs ~30 ms; harbours rebuild rarely)
/**
 * Planning grid from a patch buffer or a decoded patch ({n, res, originLat, originLon, heights, mask}):
 * `clear` = metres to the nearest obstacle (−1 inside one), `h` = bed height in metres (negative = water depth).
 */
export function gridFromPatch(src) {
  if (!src) return null;
  if (typeof src === 'object' && gridCache.has(src)) return gridCache.get(src);
  const dec = src.mask && src.heights ? src : decodePatchBuffer(src);
  if (!dec || !(dec.n > 2)) return null;
  const { n, res, originLat, originLon, mask } = dec;
  const N = n * n;
  const h = new Float32Array(N);
  for (let k = 0; k < N; k++) h[k] = (dec.heights[k] - H_OFFSET) * H_STEP;
  const dc = distanceToObstacles(mask, n);
  const clear = new Float32Array(N);
  for (let k = 0; k < N; k++) clear[k] = OBST[mask[k]] ? -1 : Math.max(0, (dc[k] - 0.5) * res);
  const grid = { n, res, originLat, originLon, kLon: GEO.M_PER_DEG_LON_EQ * Math.cos(originLat * D2R) || 1e-6, mask, h, clear, half: (n * res) / 2 };
  if (typeof src === 'object') gridCache.set(src, grid);
  return grid;
}

export function toXZ(grid, lat, lon) { return [(lon - grid.originLon) * grid.kLon, -(lat - grid.originLat) * GEO.M_PER_DEG_LAT]; }
export function toLL(grid, x, z) { return { lat: grid.originLat - z / GEO.M_PER_DEG_LAT, lon: grid.originLon + x / grid.kLon }; }
export function inGrid(grid, x, z, marginCells = 1) { const m = grid.half - marginCells * grid.res; return x > -m && x < m && z > -m && z < m; }
export function cellOf(grid, x, z) {
  const i = Math.floor(x / grid.res + grid.n / 2), j = Math.floor(z / grid.res + grid.n / 2);
  return i < 0 || j < 0 || i >= grid.n || j >= grid.n ? -1 : j * grid.n + i;
}
export function cellXZ(grid, k) { const i = k % grid.n, j = (k - i) / grid.n; return [(i + 0.5 - grid.n / 2) * grid.res, (j + 0.5 - grid.n / 2) * grid.res]; }
function bilinear(grid, arr, x, z) {
  const n = grid.n;
  const u = x / grid.res + n / 2 - 0.5, v = z / grid.res + n / 2 - 0.5;
  let i0 = Math.floor(u), j0 = Math.floor(v);
  if (i0 < 0) i0 = 0; else if (i0 > n - 2) i0 = n - 2;
  if (j0 < 0) j0 = 0; else if (j0 > n - 2) j0 = n - 2;
  let fx = u - i0, fy = v - j0;
  fx = fx < 0 ? 0 : fx > 1 ? 1 : fx; fy = fy < 0 ? 0 : fy > 1 ? 1 : fy;
  const o = j0 * n + i0;
  return (arr[o] * (1 - fx) + arr[o + 1] * fx) * (1 - fy) + (arr[o + n] * (1 - fx) + arr[o + n + 1] * fx) * fy;
}
/** Clearance (m) at a point: bilinear like harborgeom.sdfAt (≤ 0 on or inside an obstacle). */
export function clearanceAt(grid, x, z) { return bilinear(grid, grid.clear, x, z); }
export function bedAt(grid, x, z) { return bilinear(grid, grid.h, x, z); }

// ------------------------------------------------------------------------------------------------ hull rules
/**
 * Hull rule: centre clearance ≥ `need` metres and bed height ≤ `hMax` (= tide − draft − margin).
 * `hullRule({beam, draft, tide, margin})` → { need, hMax }.
 */
export function hullRule({ beam = 14, draft = 5, tide = 0, margin = TUGPATH.MARGIN_M, depthMargin = TUGPATH.DEPTH_MARGIN_M } = {}) {
  return { need: beam / 2 + margin, hMax: tide - draft - depthMargin };
}
export function pointOk(grid, rule, x, z) {
  if (!inGrid(grid, x, z, 1)) return false;
  return clearanceAt(grid, x, z) >= rule.need && bedAt(grid, x, z) <= rule.hMax;
}
/** Passability per cell (centre clearance and the depth of the cell and its 4 neighbours, so bilinear depth holds). */
export function passMap(grid, rule) {
  const { n, clear, h, mask } = grid;
  const deep = new Uint8Array(n * n), pass = new Uint8Array(n * n);
  for (let k = 0; k < n * n; k++) deep[k] = !OBST[mask[k]] && h[k] <= rule.hMax ? 1 : 0;
  for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 1; i++) {
    const k = j * n + i;
    if (!deep[k] || clear[k] < rule.need) continue;
    if (!deep[k - 1] || !deep[k + 1] || !deep[k - n] || !deep[k + n]) continue;
    pass[k] = 1;
  }
  return pass;
}
/** Straight segment check: clearance and depth sampled every SAMPLE_M along a→b (and inside the patch). */
export function segmentOk(grid, rule, ax, az, bx, bz, step = TUGPATH.SAMPLE_M) {
  const L = Math.hypot(bx - ax, bz - az), m = Math.max(1, Math.ceil(L / step));
  for (let s = 0; s <= m; s++) { const f = s / m; if (!pointOk(grid, rule, ax + (bx - ax) * f, az + (bz - az) * f)) return false; }
  return true;
}
/** Water only (no clearance / depth rule): used for the escape leg and the final push onto the berth. */
export function segmentWet(grid, ax, az, bx, bz, minClear = 0.5, step = TUGPATH.SAMPLE_M) {
  const L = Math.hypot(bx - ax, bz - az), m = Math.max(1, Math.ceil(L / step));
  for (let s = 0; s <= m; s++) { const f = s / m; const x = ax + (bx - ax) * f, z = az + (bz - az) * f; if (!inGrid(grid, x, z, 0) || clearanceAt(grid, x, z) < minClear) return false; }
  return true;
}

// ------------------------------------------------------------------------------------------------ search
class Heap { // binary min-heap of (key, value) pairs in parallel arrays
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const K = this.k, V = this.v; let i = K.length; K.push(key); V.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (K[p] <= key) break; K[i] = K[p]; V[i] = V[p]; i = p; }
    K[i] = key; V[i] = val;
  }
  pop() {
    const K = this.k, V = this.v, top = V[0], lk = K.pop(), lv = V.pop(), n = K.length;
    if (n) {
      let i = 0;
      for (;;) { const l = 2 * i + 1, r = l + 1; let s = -1, sk = lk; if (l < n && K[l] < sk) { s = l; sk = K[l]; } if (r < n && K[r] < sk) { s = r; sk = K[r]; } if (s < 0) break; K[i] = K[s]; V[i] = V[s]; i = s; }
      K[i] = lk; V[i] = lv;
    }
    return top;
  }
}
const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
/** A* from cell s to cell g over `pass`; returns the cell index list (s … g) and its cost, or null. */
export function astar(grid, pass, s, g, rule) {
  const { n, res, clear } = grid, N = n * n;
  if (s < 0 || g < 0 || !pass[s] || !pass[g]) return null;
  const gs = new Float64Array(N).fill(Infinity), par = new Int32Array(N).fill(-1), done = new Uint8Array(N);
  const gi = g % n, gj = (g - gi) / n;
  const pref = rule.need + 40;
  const hf = (k) => { const i = k % n, j = (k - i) / n; return Math.hypot(i - gi, j - gj) * res; };
  const heap = new Heap();
  gs[s] = 0; heap.push(hf(s), s);
  while (heap.size) {
    const k = heap.pop();
    if (done[k]) continue;
    if (k === g) break;
    done[k] = 1;
    const i = k % n, j = (k - i) / n;
    for (let d = 0; d < 8; d++) {
      const di = NB[d][0], dj = NB[d][1], i2 = i + di, j2 = j + dj;
      if (i2 < 0 || j2 < 0 || i2 >= n || j2 >= n) continue;
      const k2 = j2 * n + i2;
      if (!pass[k2] || done[k2]) continue;
      if (di && dj && (!pass[j * n + i2] || !pass[j2 * n + i])) continue; // no squeezing between two corners
      const c = clear[k2], w = 1 + TUGPATH.WALL_PENALTY * Math.max(0, 1 - c / pref);
      const ng = gs[k] + res * (di && dj ? Math.SQRT2 : 1) * w;
      if (ng < gs[k2]) { gs[k2] = ng; par[k2] = k; heap.push(ng + hf(k2), k2); }
    }
  }
  if (!Number.isFinite(gs[g])) return null;
  const cells = [];
  for (let k = g; k >= 0; k = par[k]) { cells.push(k); if (k === s) break; }
  cells.reverse();
  return cells[0] === s ? { cells, cost: gs[g] } : null;
}
/** Dijkstra from cell s (same costs as astar) until every reachable cell in `goals` is settled → Map(goal → {cells, cost}). */
export function dijkstraMulti(grid, pass, s, goals, rule) {
  const { n, res, clear } = grid, N = n * n;
  const out = new Map();
  if (s < 0 || !pass[s]) return out;
  const want = new Set(goals.filter((g) => g >= 0 && pass[g]));
  const gs = new Float64Array(N).fill(Infinity), par = new Int32Array(N).fill(-1), done = new Uint8Array(N);
  const pref = rule.need + 40;
  const heap = new Heap();
  gs[s] = 0; heap.push(0, s);
  let left = want.size;
  while (heap.size && left > 0) {
    const k = heap.pop();
    if (done[k]) continue;
    done[k] = 1;
    if (want.has(k)) left--;
    const i = k % n, j = (k - i) / n;
    for (let d = 0; d < 8; d++) {
      const di = NB[d][0], dj = NB[d][1], i2 = i + di, j2 = j + dj;
      if (i2 < 0 || j2 < 0 || i2 >= n || j2 >= n) continue;
      const k2 = j2 * n + i2;
      if (!pass[k2] || done[k2]) continue;
      if (di && dj && (!pass[j * n + i2] || !pass[j2 * n + i])) continue;
      const w = 1 + TUGPATH.WALL_PENALTY * Math.max(0, 1 - clear[k2] / pref);
      const ng = gs[k] + res * (di && dj ? Math.SQRT2 : 1) * w;
      if (ng < gs[k2]) { gs[k2] = ng; par[k2] = k; heap.push(ng, k2); }
    }
  }
  for (const g of want) {
    if (!done[g]) continue;
    const cells = []; for (let k = g; k >= 0; k = par[k]) { cells.push(k); if (k === s) break; }
    cells.reverse();
    if (cells[0] === s) out.set(g, { cells, cost: gs[g] });
  }
  return out;
}
/** Breadth-first through water cells (any depth, any clearance) from (x, z) to the nearest cell satisfying `goalOk`. */
export function escapeTo(grid, x, z, goalOk, maxM = TUGPATH.ESCAPE_M, throughObstacles = false) {
  const { n, res, mask } = grid;
  const s = cellOf(grid, x, z); if (s < 0) return null;
  if (goalOk(s)) return [s];
  const maxSteps = Math.ceil(maxM / res);
  const dist = new Map([[s, 0]]), par = new Map();
  let frontier = [s];
  for (let step = 0; step < maxSteps && frontier.length; step++) {
    const next = [];
    for (const k of frontier) {
      const i = k % n, j = (k - i) / n;
      for (const [di, dj] of NB) {
        const i2 = i + di, j2 = j + dj; if (i2 < 1 || j2 < 1 || i2 >= n - 1 || j2 >= n - 1) continue;
        const k2 = j2 * n + i2; if (dist.has(k2)) continue;
        if (!throughObstacles && OBST[mask[k2]]) continue;
        dist.set(k2, step + 1); par.set(k2, k);
        if (goalOk(k2)) { const out = [k2]; let c = k2; while (par.has(c)) { c = par.get(c); out.push(c); } return out.reverse(); }
        next.push(k2);
      }
    }
    frontier = next;
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ smoothing
/** Greedy string pulling: keep the farthest vertex reachable by a checked straight segment. */
export function stringPull(grid, rule, pts) {
  if (pts.length <= 2) return pts.slice();
  const out = [pts[0]];
  let i = 0;
  while (i < pts.length - 1) {
    let best = i + 1, misses = 0;
    for (let j = i + 2; j < pts.length; j++) {
      if (segmentOk(grid, rule, pts[i][0], pts[i][1], pts[j][0], pts[j][1])) { best = j; misses = 0; } else if (++misses > 12) break;
    }
    out.push(pts[best]); i = best;
  }
  return out;
}
/** Round each corner with a quadratic Bézier (turn radius ≈ `radius`), checked against the rule; the last leg stays straight. */
export function roundCorners(grid, rule, pts, radius) {
  if (pts.length < 3) return pts.slice();
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = out[out.length - 1], p1 = pts[i], p2 = pts[i + 1];
    const ax = p1[0] - p0[0], az = p1[1] - p0[1], bx = p2[0] - p1[0], bz = p2[1] - p1[1];
    const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
    if (la < 1 || lb < 1) { out.push(p1); continue; }
    const cos = (ax * bx + az * bz) / (la * lb), th = Math.acos(Math.max(-1, Math.min(1, cos)));
    if (th < 3 * D2R) { out.push(p1); continue; }
    const nextIsLast = i + 1 === pts.length - 1;
    let r = Math.min(radius * Math.tan(th / 2), la * 0.45, lb * (nextIsLast ? 0.45 : 0.45));
    let arc = null;
    for (let tries = 0; tries < 4 && r > 2; tries++, r *= 0.5) {
      const A = [p1[0] - (ax / la) * r, p1[1] - (az / la) * r], B = [p1[0] + (bx / lb) * r, p1[1] + (bz / lb) * r];
      const m = Math.max(3, Math.ceil((th * R2D) / 8));
      const cand = [];
      for (let s = 0; s <= m; s++) { const t = s / m, u = 1 - t; cand.push([u * u * A[0] + 2 * u * t * p1[0] + t * t * B[0], u * u * A[1] + 2 * u * t * p1[1] + t * t * B[1]]); }
      let ok = segmentOk(grid, rule, p0[0], p0[1], A[0], A[1]);
      for (let s = 1; ok && s < cand.length; s++) ok = segmentOk(grid, rule, cand[s - 1][0], cand[s - 1][1], cand[s][0], cand[s][1]);
      if (ok) { arc = cand; break; }
    }
    if (arc) out.push(...arc); else out.push(p1);
  }
  out.push(pts[pts.length - 1]);
  // drop near-duplicates
  const clean = [out[0]];
  for (let i = 1; i < out.length; i++) { const q = clean[clean.length - 1]; if (Math.hypot(out[i][0] - q[0], out[i][1] - q[1]) > 0.5 || i === out.length - 1) clean.push(out[i]); }
  return clean;
}
export function cumLengths(pts) { const c = [0]; for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])); return c; }
/** Point and unit tangent at arc length s along a polyline (clamped to its ends). */
export function sampleAt(pts, cum, s) {
  const L = cum[cum.length - 1];
  if (pts.length === 1) return { x: pts[0][0], z: pts[0][1], tx: 0, tz: -1 };
  s = s < 0 ? 0 : s > L ? L : s;
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
  const a = pts[lo], b = pts[hi], seg = cum[hi] - cum[lo] || 1, f = (s - cum[lo]) / seg;
  const tx = (b[0] - a[0]) / seg, tz = (b[1] - a[1]) / seg;
  return { x: a[0] + (b[0] - a[0]) * f, z: a[1] + (b[1] - a[1]) * f, tx, tz };
}
export const bearingXZ = (dx, dz) => ((Math.atan2(dx, -dz) * R2D) + 360) % 360;
const angleDiffDeg = (a, b) => ((((b - a) % 360) + 540) % 360) - 180;
export const dirOf = (brg) => [Math.sin(brg * D2R), -Math.cos(brg * D2R)];

// ------------------------------------------------------------------------------------------------ routes
/**
 * Water-only route between two points for a hull obeying `rule` (escape legs at both ends when the start or the goal
 * lies in water too tight or shallow for the rule). Returns {pts, cum, length, cost} or null.
 */
export function route(grid, rule, from, to, opts = {}) {
  return routeMulti(grid, rule, from, [to], { ...opts, single: true })[0];
}
/**
 * Routes from one start to several goals (one search). Returns an array aligned with `goals`: {pts, cum, length, cost,
 * escapeM} or null for a goal that cannot be reached.
 */
export function routeMulti(grid, rule, from, goals, opts = {}) {
  const pass = opts.pass || passMap(grid, rule);
  const okCell = (k) => pass[k] === 1;
  const head = escapeTo(grid, from[0], from[1], okCell, opts.escapeM ?? TUGPATH.ESCAPE_M, !!opts.throughObstacles);
  if (!head) return goals.map(() => null);
  const s = head[head.length - 1];
  const tails = goals.map((to) => escapeTo(grid, to[0], to[1], okCell, opts.goalEscapeM ?? 150, false));
  let found;
  if (opts.single) { const g = tails[0] ? tails[0][tails[0].length - 1] : -1; found = new Map(); if (g >= 0) { const a = s === g ? { cells: [s], cost: 0 } : astar(grid, pass, s, g, rule); if (a) found.set(g, a); } }
  else found = dijkstraMulti(grid, pass, s, tails.filter(Boolean).map((t) => t[t.length - 1]), rule);
  return goals.map((to, gi) => {
    const tail = tails[gi]; if (!tail) return null;
    const a = found.get(tail[tail.length - 1]); if (!a) return null;
    // raw polyline: exact start, the escape cells, the search cells, the goal escape cells reversed, exact goal
    const raw = [[from[0], from[1]]];
    for (let i = 1; i < head.length - 1; i++) raw.push(cellXZ(grid, head[i]));
    for (const k of a.cells) raw.push(cellXZ(grid, k));
    for (let i = tail.length - 2; i >= 1; i--) raw.push(cellXZ(grid, tail[i]));
    raw.push([to[0], to[1]]);
    // string-pull (and round) only the part that obeys the rule; the escape legs keep their water cells
    const startFree = head.length === 1, goalFree = tail.length === 1;
    const iS = head.length - 1, iG = iS + a.cells.length - 1;          // raw indices of the first / last search cell
    const coreFrom = startFree ? 0 : iS, coreTo = goalFree ? raw.length - 1 : iG;
    const core = raw.slice(coreFrom, coreTo + 1).concat(opts.extend && goalFree ? opts.extend[gi] || [] : []);
    let pulled = stringPull(grid, rule, core.slice(0, coreTo - coreFrom + 1));
    pulled = pulled.concat(core.slice(coreTo - coreFrom + 1));
    if (opts.radius > 0) pulled = roundCorners(grid, rule, pulled, opts.radius);
    let pts = raw.slice(0, coreFrom).concat(pulled, opts.extend && goalFree ? [] : raw.slice(coreTo + 1));
    pts = pts.filter((p, i, arr) => i === 0 || Math.hypot(p[0] - arr[i - 1][0], p[1] - arr[i - 1][1]) > 0.01);
    const cum = cumLengths(pts);
    return { pts, cum, length: cum[cum.length - 1], cost: a.cost, escapeM: startFree ? 0 : cumLengths(raw.slice(0, iS + 1))[iS], goalFree };
  });
}

/**
 * Hull ends along a path: the smallest clearance of points ±0.3 L (need ≥ half beam) and ±0.47 L (need ≥ 2 m) from the
 * centre along the local heading (tangent over ±0.1 L). Returns {ok, worst (m short of the need), at}.
 */
export function hullSweep(grid, pts, cum, L, B, fromS = 0, step = 4) {
  const total = cum[cum.length - 1];
  let worst = Infinity, at = null;
  for (let s = fromS; s <= total + 1e-6; s += step) {
    const p = sampleAt(pts, cum, s), a = sampleAt(pts, cum, s - 0.1 * L), b = sampleAt(pts, cum, s + 0.1 * L);
    let tx = b.x - a.x, tz = b.z - a.z; const d = Math.hypot(tx, tz);
    if (d < 1e-6) { tx = p.tx; tz = p.tz; } else { tx /= d; tz /= d; }
    for (const [k, need] of [[0.3, B / 2], [0.47, 2], [-0.3, B / 2], [-0.47, 2]]) {
      if (k < 0 && s < fromS + L / 2) continue; // the stern is still where she started
      const x = p.x + tx * k * L, z = p.z + tz * k * L;
      const c = inGrid(grid, x, z, 0) ? clearanceAt(grid, x, z) : need;
      if (c - need < worst) { worst = c - need; at = [x, z]; }
    }
  }
  return { ok: worst >= 0, worst, at };
}

// ------------------------------------------------------------------------------------------------ berthing
/**
 * Where the tugs line the ship up for a berth: the approach point on the berth's water-side normal where the hull
 * rule first holds, and for both directions along the quay a line-up point up to 1.2 ship lengths before it.
 * berth = {x, z, hdg (along the quay)}. Returns {approach, side, cands: [{lineup, approach, hdg, quaySide}]} or null.
 */
export function berthApproach(grid, rule, berth, length) {
  const t = dirOf(berth.hdg), n1 = [Math.cos(berth.hdg * D2R), Math.sin(berth.hdg * D2R)]; // n1 = bearing hdg + 90
  const probe = (s) => { let best = -Infinity; for (const d of [20, 35, 50]) { const x = berth.x + n1[0] * s * d, z = berth.z + n1[1] * s * d; if (inGrid(grid, x, z, 1)) best = Math.max(best, clearanceAt(grid, x, z)); } return best; };
  const sgn = probe(1) >= probe(-1) ? 1 : -1;
  const side = [n1[0] * sgn, n1[1] * sgn]; // unit normal from the quay to open water
  let off = -1;
  for (let d = 0; d <= 300; d += 4) {
    const x = berth.x + side[0] * d, z = berth.z + side[1] * d;
    if (!inGrid(grid, x, z, 1) || clearanceAt(grid, x, z) <= 0) break; // ran into the other side
    if (pointOk(grid, rule, x, z)) { off = d; break; }
  }
  if (off < 0) return null;
  // For each direction along the quay: the line-up run (up to 1.2 ship lengths, parallel to the quay) ending at an
  // approach point abeam the berth. A slightly wider stand-off is accepted when it buys a proper parallel run
  // (a rasterised quay is a staircase, so a run hugging it at the minimum stand-off often fails the check).
  const cands = [];
  const FACT = [1.2, 0.9, 0.6, 0.35, 0.15];
  for (const s of [1, -1]) {
    const dir = [t[0] * s, t[1] * s], hdg = bearingXZ(dir[0], dir[1]);
    let best = null;
    for (let extra = 0; extra <= 40; extra += 4) {
      const d = off + 2 + extra;
      const ap = [berth.x + side[0] * d, berth.z + side[1] * d];
      if (!pointOk(grid, rule, ap[0], ap[1])) continue;
      let Lu = 0, lineup = ap;
      for (const f of FACT) {
        const L = Math.max(30, length * f);
        const q = [ap[0] - dir[0] * L, ap[1] - dir[1] * L];
        if (pointOk(grid, rule, q[0], q[1]) && segmentOk(grid, rule, q[0], q[1], ap[0], ap[1])) { Lu = L; lineup = q; break; }
      }
      const score = Lu - 1.5 * extra;
      if (!best || score > best.score) best = { score, approach: ap, lineup, offset: d, Lu };
      if (Lu >= Math.max(30, length * FACT[0]) - 1e-6) break; // a full run: no need to stand off further
    }
    if (!best) continue;
    // starboard of the ship = bearing hdg + 90; the quay lies on −side
    const stbd = [Math.cos(hdg * D2R), Math.sin(hdg * D2R)];
    const quaySide = stbd[0] * -side[0] + stbd[1] * -side[1] > 0 ? 1 : -1; // +1: quay to starboard
    cands.push({ lineup: best.lineup, approach: best.approach, hdg, quaySide, offset: best.offset, run: best.Lu });
  }
  if (!cands.length) return null;
  return { side, offset: Math.min(...cands.map((c) => c.offset)), cands };
}

/**
 * The whole assist path for a ship at `start` (local metres) to a berth.
 * opts: {beam, length, draft, tide, margin, hdg (her heading now)}. Returns
 *   { ok: true, pts, cum, length, approach, berth: [x, z], hdg, quaySide, rule, escapeM }  or  { ok: false, reason }.
 * reason: 'outside' (start not on the patch), 'boxed' (no way out of tight water), 'berth' (no room off the berth),
 * 'nopath' (no channel wide and deep enough).
 */
export function planAssistPath(grid, start, berth, opts = {}) {
  const rule = hullRule({ beam: opts.beam, draft: opts.draft, tide: opts.tide, margin: opts.margin });
  if (!inGrid(grid, start[0], start[1], 1)) return { ok: false, reason: 'outside' };
  const pass = passMap(grid, rule);
  const L = opts.length || 60, B = opts.beam || 14, radius = Math.max(40, L * 0.9);
  const ba = berthApproach(grid, rule, berth, L);
  if (!ba) return { ok: false, reason: 'berth', rule };
  const startInside = clearanceAt(grid, start[0], start[1]) <= 0;
  // Already lying off the berth, roughly parallel to the quay: the tugs just walk her across to the approach point
  // (no loop out into the basin and back).
  if (Number.isFinite(opts.hdg) && !startInside) {
    for (const c of ba.cands) {
      if (Math.abs(angleDiffDeg(opts.hdg, c.hdg)) > 35) continue;
      const d = Math.hypot(c.approach[0] - start[0], c.approach[1] - start[1]);
      if (d > Math.max(60, 1.2 * L) || !segmentWet(grid, start[0], start[1], c.approach[0], c.approach[1], B / 2 + 2)) continue;
      const pts = d > 0.5 ? [[start[0], start[1]], c.approach] : [[start[0], start[1]], [c.approach[0] + 0.01, c.approach[1]]];
      const cum = cumLengths(pts);
      return { ok: true, pts, cum, length: cum[cum.length - 1], approach: c.approach, berth: [berth.x, berth.z], hdg: c.hdg, quaySide: c.quaySide, rule, escapeM: 0, offset: c.offset, run: 0, crab: true, sweep: { ok: true, worst: 0 } };
    }
  }
  // tails: the parallel run (line-up → approach), entered from a point further out (she swings round in open water
  // and comes in at a shallow angle) or straight at the line-up point
  const tails = [];
  for (const c of ba.cands) {
    const dir = dirOf(c.hdg);
    for (const k of [0.6, 0.35, 0]) {
      if (k === 0) { tails.push({ c, goal: c.lineup, extend: [c.approach] }); continue; }
      const pre = [c.lineup[0] - dir[0] * 0.8 * L + ba.side[0] * k * L, c.lineup[1] - dir[1] * 0.8 * L + ba.side[1] * k * L];
      if (pointOk(grid, rule, pre[0], pre[1]) && segmentOk(grid, rule, pre[0], pre[1], c.lineup[0], c.lineup[1])) tails.push({ c, goal: pre, extend: [c.lineup, c.approach] });
    }
  }
  const routes = routeMulti(grid, rule, start, tails.map((t) => t.goal), { pass, radius, throughObstacles: startInside, extend: tails.map((t) => t.extend) });
  let best = null, reachable = false;
  routes.forEach((r, i) => {
    if (!r) return;
    reachable = true;
    const t = tails[i];
    let pts = r.pts;
    if (!r.goalFree) pts = pts.concat(t.extend); // the goal needed an escape leg: append the run unrounded
    pts = pts.filter((p, q, arr) => q === 0 || Math.hypot(p[0] - arr[q - 1][0], p[1] - arr[q - 1][1]) > 0.01);
    const cum = cumLengths(pts);
    const sweep = hullSweep(grid, pts, cum, L, B, r.escapeM);
    // prefer: the hull ends clear of everything, a real parallel run, then the shorter / more central route
    const score = r.cost + (cum[cum.length - 1] - r.length) - 2 * (t.c.run || 0) + (sweep.ok ? 0 : 5000 - 50 * Math.max(-40, sweep.worst));
    if (!best || score < best.score) best = { score, pts, cum, r, c: t.c, sweep };
  });
  if (!best) return { ok: false, reason: reachable ? 'nopath' : 'nopath', rule };
  const { pts, cum, r, c, sweep } = best;
  return { ok: true, pts, cum, length: cum[cum.length - 1], approach: c.approach, berth: [berth.x, berth.z], hdg: c.hdg, quaySide: c.quaySide, rule, escapeM: r.escapeM, offset: c.offset, run: c.run, sweep };
}

/**
 * Smallest clearance (m) and bed height along a polyline, sampled every `step` metres from `fromS` on — for tests and
 * diagnostics.
 */
export function pathStats(grid, pts, step = 2, fromS = 0) {
  const cum = cumLengths(pts), L = cum[cum.length - 1];
  let minClear = Infinity, maxBed = -Infinity, at = null;
  for (let s = fromS; s <= L + 1e-6; s += step) {
    const p = sampleAt(pts, cum, s), c = clearanceAt(grid, p.x, p.z), h = bedAt(grid, p.x, p.z);
    if (c < minClear) { minClear = c; at = [p.x, p.z]; }
    if (h > maxBed) maxBed = h;
  }
  return { minClear, maxBed, at, length: L };
}

/**
 * Tug station for a harbour: water the tugs can lie in, ~250 m from the anchor towards the berths (inside the harbour).
 * `berths` = [[x, z], …]. Returns [x, z].
 */
export function tugBase(grid, anchorXZ, berths, tugRule) {
  let tx = anchorXZ[0], tz = anchorXZ[1];
  if (berths && berths.length) {
    let cx = 0, cz = 0; for (const b of berths) { cx += b[0]; cz += b[1]; } cx /= berths.length; cz /= berths.length;
    const dx = cx - anchorXZ[0], dz = cz - anchorXZ[1], d = Math.hypot(dx, dz);
    if (d > 1) { const k = Math.min(250, d * 0.5) / d; tx += dx * k; tz += dz * k; }
  }
  const pass = passMap(grid, tugRule);
  const path = escapeTo(grid, tx, tz, (k) => pass[k] === 1, 1500, true);
  if (path) return cellXZ(grid, path[path.length - 1]);
  return [anchorXZ[0], anchorXZ[1]];
}
