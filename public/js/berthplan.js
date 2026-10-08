// Berth guidance planner (V5-PLAN item 2) — the pure part: no DOM, no three, no imports, so it also runs under Node
// for the tests. Works in harbour-patch CELL coordinates (i east, j south; the centre of cell (i, j) is i + 0.5, j + 0.5;
// the patch frame of shared/constants.js PATCH / latLonToPatchCell) and real metres for clearances and depths.
//
//   computeClearance(mask, n, res)  signed distance to the nearest obstacle (m, negative inside), same 3-4 chamfer as
//                                   the client's harborgeom.computeSDF (the client passes entry.sdf instead)
//   coarseGrid(grid, f)             f×f blocks: conservative clearance (min), shallowest depth, fairway flag; cached
//   planPath(grid, from, to, opts)  A* over the coarse grid (8-connected, no corner cutting) that stays on water, prefers
//                                   the fairway, keeps clearance ≥ halfBeam + 10 m where the water allows it and avoids
//                                   water shallower than the draught; then string-pulled on the fine grid without ever
//                                   giving up clearance the raw path had.
//   polyline helpers                length, resample, projection (off-line distance / distance along), look-ahead point.

export const MASK = { WATER: 0, LAND: 1, QUAY: 2, BREAKWATER: 3, PONTOON: 4, FAIRWAY: 5, SHALLOW: 6 };
const OBST = new Uint8Array(256);
for (const c of [MASK.LAND, MASK.QUAY, MASK.BREAKWATER, MASK.PONTOON]) OBST[c] = 1;
/** True for mask codes a hull cannot enter. */
export function isObstacle(code) { return OBST[code & 255] === 1; }

const H_OFFSET = 128, H_STEP = 0.25; // PATCH.H_OFFSET / H_STEP (shared/constants.js): h_m = (v − 128) × 0.25
const SQ2 = Math.SQRT2;

// ------------------------------------------------------------------------------------------------ clearance field
function chamfer(mask, n, toObstacle) {
  const INF = 1 << 29, d = new Int32Array(n * n), want = toObstacle ? 1 : 0;
  for (let k = 0; k < n * n; k++) d[k] = OBST[mask[k]] === want ? 0 : INF;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i; let v = d[k]; if (v === 0) continue;
    if (i > 0) v = Math.min(v, d[k - 1] + 3);
    if (j > 0) { v = Math.min(v, d[k - n] + 3); if (i > 0) v = Math.min(v, d[k - n - 1] + 4); if (i < n - 1) v = Math.min(v, d[k - n + 1] + 4); }
    d[k] = v;
  }
  for (let j = n - 1; j >= 0; j--) for (let i = n - 1; i >= 0; i--) {
    const k = j * n + i; let v = d[k]; if (v === 0) continue;
    if (i < n - 1) v = Math.min(v, d[k + 1] + 3);
    if (j < n - 1) { v = Math.min(v, d[k + n] + 3); if (i < n - 1) v = Math.min(v, d[k + n + 1] + 4); if (i > 0) v = Math.min(v, d[k + n - 1] + 4); }
    d[k] = v;
  }
  return d;
}
/** Signed distance (m) at every cell centre: positive in water, negative inside land / quays / breakwaters / pontoons. */
export function computeClearance(mask, n, res) {
  const dObs = chamfer(mask, n, true), dWat = chamfer(mask, n, false), out = new Float32Array(n * n), cap = n * res;
  for (let k = 0; k < n * n; k++) {
    if (OBST[mask[k]]) out[k] = -Math.min(cap, (dWat[k] / 3 - 0.5) * res);
    else out[k] = Math.min(cap, (dObs[k] / 3 - 0.5) * res);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ sampling
/** Bilinear clearance (m) at continuous cell coordinates; outside the grid the edge value. */
export function sampleClearance(grid, ci, cj) {
  const n = grid.n, s = grid.sdf;
  const u = Math.min(n - 1.0001, Math.max(0, ci - 0.5)), v = Math.min(n - 1.0001, Math.max(0, cj - 0.5));
  const i0 = Math.floor(u), j0 = Math.floor(v), fx = u - i0, fy = v - j0, i1 = Math.min(n - 1, i0 + 1), j1 = Math.min(n - 1, j0 + 1);
  return (s[j0 * n + i0] * (1 - fx) + s[j0 * n + i1] * fx) * (1 - fy) + (s[j1 * n + i0] * (1 - fx) + s[j1 * n + i1] * fx) * fy;
}
/** Water depth (m, positive below datum) of the cell under continuous cell coordinates; Infinity without heights. */
export function depthAtCell(grid, ci, cj) {
  if (!grid.heights) return Infinity;
  const n = grid.n, i = Math.min(n - 1, Math.max(0, Math.floor(ci))), j = Math.min(n - 1, Math.max(0, Math.floor(cj)));
  return -((grid.heights[j * n + i] - (grid.hOffset ?? H_OFFSET)) * (grid.hStep ?? H_STEP));
}
export function inGrid(grid, ci, cj, margin = 0) { return ci >= margin && cj >= margin && ci < grid.n - margin && cj < grid.n - margin; }

// ------------------------------------------------------------------------------------------------ coarse grid
const COARSE = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
/**
 * f×f blocks of the fine grid: `clr` the smallest clearance in the block (conservative), `depth` the shallowest water,
 * `fair` 1 where any fine cell is fairway. Cached per grid object (the client passes its harbour entry).
 */
export function coarseGrid(grid, f = 2) {
  const key = grid.sdf || grid;
  const hit = COARSE && COARSE.get(key);
  if (hit && hit.f === f) return hit;
  const n = grid.n, nc = Math.ceil(n / f), N = nc * nc;
  const clr = new Float32Array(N).fill(Infinity), depth = new Float32Array(N).fill(Infinity), fair = new Uint8Array(N);
  const hasH = !!grid.heights, ho = grid.hOffset ?? H_OFFSET, hs = grid.hStep ?? H_STEP;
  for (let j = 0; j < n; j++) {
    const cj = (j / f) | 0;
    for (let i = 0; i < n; i++) {
      const k = j * n + i, c = cj * nc + ((i / f) | 0);
      const s = grid.sdf[k]; if (s < clr[c]) clr[c] = s;
      if (hasH) { const d = -((grid.heights[k] - ho) * hs); if (d < depth[c]) depth[c] = d; }
      if (grid.mask[k] === MASK.FAIRWAY) fair[c] = 1;
    }
  }
  const out = { f, nc, res: grid.res * f, clr, depth, fair, g: new Float32Array(N), par: new Int32Array(N), stamp: new Uint32Array(N), closed: new Uint32Array(N), run: 0 };
  if (COARSE) COARSE.set(key, out);
  return out;
}

// binary min-heap of (key, value) with lazy deletion
class Heap {
  constructor(cap = 4096) { this.k = new Float64Array(cap); this.v = new Int32Array(cap); this.n = 0; }
  push(key, val) {
    if (this.n === this.k.length) { const k2 = new Float64Array(this.n * 2), v2 = new Int32Array(this.n * 2); k2.set(this.k); v2.set(this.v); this.k = k2; this.v = v2; }
    let i = this.n++; const K = this.k, V = this.v;
    while (i > 0) { const p = (i - 1) >> 1; if (K[p] <= key) break; K[i] = K[p]; V[i] = V[p]; i = p; }
    K[i] = key; V[i] = val;
  }
  pop() { // returns the value; the key is left in this.top
    const K = this.k, V = this.v, top = V[0]; this.top = K[0];
    const n = --this.n; if (n === 0) return top;
    const key = K[n], val = V[n]; let i = 0;
    for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && K[c + 1] < K[c]) c++; if (K[c] >= key) break; K[i] = K[c]; V[i] = V[c]; i = c; }
    K[i] = key; V[i] = val; return top;
  }
}

/**
 * Plan a water-only line from `from` to `to` (continuous fine-cell coordinates {i, j}).
 * opts: halfBeam (m), clearance (m, default halfBeam + 10), draft (m), depthMargin (m, default 0.8), freeR (m: around
 * the two ends the hull may come as close as `freeMin` to obstacles — a berth lies a few metres off its quay; default
 * max(40, halfBeam × 4)), freeMin (m, default 1.5), coarse (factor, default 2), maxExpand.
 * Returns { points: [{i, j}] (fine-cell coords, from → to), lengthM, minClearM, shallow (true if it had to cross water
 * shallower than draft + margin), raw: number of coarse nodes } or null when no water route exists.
 */
export function planPath(grid, from, to, opts = {}) {
  const C = coarseGrid(grid, opts.coarse || 2), nc = C.nc, f = C.f, res = grid.res, cres = C.res;
  const halfBeam = Math.max(1, opts.halfBeam ?? 7), need = opts.clearance ?? halfBeam + 10;
  const draft = opts.draft ?? 0, dNeed = draft > 0 ? draft + (opts.depthMargin ?? 0.8) : -Infinity;
  // coarse clearance is the block minimum (≈ 0.7 fine cell under the block centre): below this the hull would touch
  const hardMin = Math.max(res * 0.5, halfBeam - res * 0.7);
  const freeMin = opts.freeMin ?? 1.5, freeR = opts.freeR ?? Math.max(40, halfBeam * 4);
  const clampC = (v) => Math.max(0, Math.min(nc - 1, Math.floor(v / f)));
  const si = clampC(from.i), sj = clampC(from.j), gi = clampC(to.i), gj = clampC(to.j);
  const S = sj * nc + si, G = gj * nc + gi;
  const freeC2 = (freeR / cres) ** 2;
  const run = ++C.run; const g = C.g, par = C.par, stamp = C.stamp, closed = C.closed;
  const cost = (k, ci, cj) => {
    if (k === S || k === G) return 1;
    const s = C.clr[k];
    const free = (ci - si) ** 2 + (cj - sj) ** 2 <= freeC2 || (ci - gi) ** 2 + (cj - gj) ** 2 <= freeC2;
    if (s < (free ? freeMin : hardMin)) return Infinity;
    let c = C.fair[k] ? 0.75 : 1;
    if (s < need) { const u = (need - s) / need; c *= 1 + 8 * u * u; }
    if (C.depth[k] < dNeed) c *= 15;
    return c;
  };
  const H = (ci, cj) => { const dx = Math.abs(ci - gi), dz = Math.abs(cj - gj); return 0.75 * (Math.max(dx, dz) + (SQ2 - 1) * Math.min(dx, dz)); };
  const heap = new Heap(4096);
  g[S] = 0; stamp[S] = run; par[S] = -1; heap.push(H(si, sj), S);
  const maxExpand = opts.maxExpand ?? nc * nc;
  let expanded = 0, found = false;
  const DI = [1, -1, 0, 0, 1, 1, -1, -1], DJ = [0, 0, 1, -1, 1, -1, 1, -1];
  while (heap.n > 0) {
    const k = heap.pop();
    if (closed[k] === run) continue;
    closed[k] = run;
    if (k === G) { found = true; break; }
    if (++expanded > maxExpand) break;
    const ci = k % nc, cj = (k / nc) | 0, gk = g[k];
    for (let d = 0; d < 8; d++) {
      const ni = ci + DI[d], nj = cj + DJ[d];
      if (ni < 0 || nj < 0 || ni >= nc || nj >= nc) continue;
      const nk = nj * nc + ni;
      if (closed[nk] === run) continue;
      const c = cost(nk, ni, nj); if (c === Infinity) continue;
      if (d >= 4 && (cost(cj * nc + ni, ni, cj) === Infinity || cost(nj * nc + ci, ci, nj) === Infinity)) continue; // no corner cutting
      const ng = gk + c * (d >= 4 ? SQ2 : 1);
      if (stamp[nk] === run && ng >= g[nk]) continue;
      stamp[nk] = run; g[nk] = ng; par[nk] = k;
      heap.push(ng + H(ni, nj), nk);
    }
  }
  if (!found) return null;
  const cells = [];
  for (let k = G; k !== -1; k = par[k]) cells.push(k);
  cells.reverse();
  const raw = cells.map((k) => ({ i: (k % nc) * f + f / 2, j: ((k / nc) | 0) * f + f / 2 }));
  raw[0] = { i: from.i, j: from.j }; raw[raw.length - 1] = { i: to.i, j: to.j };
  if (raw.length === 1) raw.push({ i: to.i, j: to.j });
  let shallow = false;
  for (const k of cells) if (C.depth[k] < dNeed && k !== S && k !== G) { shallow = true; break; }
  const points = smoothPath(grid, raw, { need, dNeed });
  return { points, lengthM: polyLength(points) * res, minClearM: minClearance(grid, points), shallow, raw: raw.length };
}

/**
 * String pulling: from each kept point jump to the farthest later point in plain sight, but only when the shortcut costs no
 * more than the raw stretch it replaces under the planner's own cost (fairway cheaper, little clearance and shallow water
 * dearer) — so the line still follows the fairway and keeps off the quays instead of cutting every corner. A shortcut must
 * also keep at least the clearance the raw path had over that stretch (capped at `need`) and its depth (capped at `dNeed`).
 */
export function smoothPath(grid, pts, { need = 17, dNeed = -Infinity } = {}) {
  if (pts.length <= 2) return pts.slice();
  const last = pts.length - 1;
  const nodeClr = pts.map((p) => sampleClearance(grid, p.i, p.j)), nodeDep = pts.map((p) => depthAtCell(grid, p.i, p.j));
  // the two ends (the ship, the berth) may sit close to a quay: near them the requirement ramps up 0.5 m per metre
  const ends = [0, last].map((k) => ({ p: pts[k], c: nodeClr[k] }));
  const relax = (ci, cj) => { let r = Infinity; for (const e of ends) r = Math.min(r, e.c - 0.5 + 0.5 * Math.hypot(ci - e.p.i, cj - e.p.j) * grid.res); return r; };
  const n = grid.n;
  const costAt = (ci, cj) => {
    const i = Math.min(n - 1, Math.max(0, Math.floor(ci))), j = Math.min(n - 1, Math.max(0, Math.floor(cj)));
    let c = grid.mask[j * n + i] === MASK.FAIRWAY ? 0.75 : 1;
    const sc = sampleClearance(grid, ci, cj);
    if (sc < need) { const u = Math.min(1, (need - sc) / need); c *= 1 + 8 * u * u; }
    if (dNeed > -Infinity && depthAtCell(grid, ci, cj) < dNeed) c *= 15;
    return c;
  };
  const segCost = (a, b) => {
    const L = Math.hypot(b.i - a.i, b.j - a.j), steps = Math.max(1, Math.ceil(L / 0.5)); let c = 0;
    for (let s = 0; s < steps; s++) { const t = (s + 0.5) / steps; c += costAt(a.i + (b.i - a.i) * t, a.j + (b.j - a.j) * t); }
    return (c * L) / steps;
  };
  const cum = [0]; for (let k = 1; k <= last; k++) cum.push(cum[k - 1] + segCost(pts[k - 1], pts[k]));
  const out = [pts[0]];
  let i = 0;
  while (i < last) {
    let best = i + 1, runC = i > 0 ? nodeClr[i] : Infinity, runD = i > 0 ? nodeDep[i] : Infinity;
    for (let j = i + 2; j <= last; j++) {
      runC = Math.min(runC, nodeClr[j - 1]); runD = Math.min(runD, nodeDep[j - 1]);
      const cj = j < last ? Math.min(runC, nodeClr[j]) : runC, dj = j < last ? Math.min(runD, nodeDep[j]) : runD;
      if (sightClear(grid, pts[i], pts[j], Math.min(need, cj) - 0.5, Math.min(dNeed, dj) - 0.05, relax) && segCost(pts[i], pts[j]) <= (cum[j] - cum[i]) * 1.01 + 0.3) best = j;
      else if (j - best > 8) break;
    }
    out.push(pts[best]); i = best;
  }
  return out;
}
/** Every sample along a → b (every 0.4 cell) has clearance ≥ minClr (or ≥ relax(i, j) where that is lower) and depth ≥ minDepth. */
export function sightClear(grid, a, b, minClr, minDepth = -Infinity, relax = null) {
  const L = Math.hypot(b.i - a.i, b.j - a.j), steps = Math.max(1, Math.ceil(L / 0.4));
  for (let s = 1; s < steps; s++) {
    const t = s / steps, ci = a.i + (b.i - a.i) * t, cj = a.j + (b.j - a.j) * t;
    const req = relax ? Math.min(minClr, relax(ci, cj)) : minClr;
    if (sampleClearance(grid, ci, cj) < req) return false;
    if (minDepth > -Infinity && depthAtCell(grid, ci, cj) < minDepth) return false;
  }
  return true;
}
/** Smallest clearance (m) sampled along a polyline (cell coords). */
export function minClearance(grid, pts) {
  let m = Infinity;
  for (let k = 0; k + 1 < pts.length; k++) {
    const a = pts[k], b = pts[k + 1], L = Math.hypot(b.i - a.i, b.j - a.j), steps = Math.max(1, Math.ceil(L / 0.5));
    for (let s = 0; s <= steps; s++) { const t = s / steps; m = Math.min(m, sampleClearance(grid, a.i + (b.i - a.i) * t, a.j + (b.j - a.j) * t)); }
  }
  return m;
}

/**
 * Where the leading line should end: one ship length astern of the berth along the quay, on the side the ship can come
 * in from (enough clearance there), nearest the `from` point. Returns { i, j, sign } (sign +1: the ship lies on the
 * berth heading, −1: on the reciprocal) — or null when neither side has room (then plan straight to the berth).
 */
export function preBerthPoint(grid, berth, hdgDeg, lengthM, halfBeam, from) {
  const a = (hdgDeg * Math.PI) / 180, ux = Math.sin(a), uz = -Math.cos(a); // heading unit vector (i east, j south)
  const back = Math.max(20, lengthM) / grid.res;
  const cands = [1, -1].map((sign) => {
    const p = { i: berth.i - sign * ux * back, j: berth.j - sign * uz * back, sign };
    const clr = inGrid(grid, p.i, p.j) ? sampleClearance(grid, p.i, p.j) : -1;
    return { ...p, clr, d: from ? Math.hypot(p.i - from.i, p.j - from.j) : 0 };
  }).filter((c) => c.clr >= Math.max(2, halfBeam * 0.8));
  if (!cands.length) return null;
  cands.sort((x, y) => x.d - y.d);
  return { i: cands[0].i, j: cands[0].j, sign: cands[0].sign };
}

/** A border cell (`inset` cells inside the edge) with clearance ≥ minClr, nearest to the point (which may lie outside). */
export function entryFromOutside(grid, p, minClr = 20, inset = 2) {
  const n = grid.n; let best = null, bd = Infinity;
  const test = (ci, cj) => {
    if (sampleClearance(grid, ci, cj) < minClr) return;
    const d = (ci - p.i) ** 2 + (cj - p.j) ** 2; if (d < bd) { bd = d; best = { i: ci, j: cj }; }
  };
  for (let k = inset; k < n - inset; k += 2) { test(k + 0.5, inset + 0.5); test(k + 0.5, n - inset - 0.5); test(inset + 0.5, k + 0.5); test(n - inset - 0.5, k + 0.5); }
  return best;
}

// ------------------------------------------------------------------------------------------------ polylines ({x, z} or {i, j})
const X = (p) => (p.x ?? p.i), Z = (p) => (p.z ?? p.j);
export function polyLength(pts) { let L = 0; for (let k = 0; k + 1 < pts.length; k++) L += Math.hypot(X(pts[k + 1]) - X(pts[k]), Z(pts[k + 1]) - Z(pts[k])); return L; }
/** Points every `step` along the polyline (the last point always included). Returns [{x, z, s}] with s = distance along. */
export function resample(pts, step) {
  const out = []; if (!pts.length) return out;
  out.push({ x: X(pts[0]), z: Z(pts[0]), s: 0 });
  let acc = 0, next = step;
  for (let k = 0; k + 1 < pts.length; k++) {
    const ax = X(pts[k]), az = Z(pts[k]), bx = X(pts[k + 1]), bz = Z(pts[k + 1]), L = Math.hypot(bx - ax, bz - az);
    while (next <= acc + L && L > 0) { const t = (next - acc) / L; out.push({ x: ax + (bx - ax) * t, z: az + (bz - az) * t, s: next }); next += step; }
    acc += L;
  }
  const last = pts[pts.length - 1];
  if (acc - out[out.length - 1].s > 1e-6) out.push({ x: X(last), z: Z(last), s: acc });
  return out;
}
/** The polyline with extra points so no gap exceeds `step` (its own vertices kept). Returns [{x, z, s}]. */
export function densify(pts, step) {
  const out = []; if (!pts.length) return out;
  let acc = 0;
  out.push({ x: X(pts[0]), z: Z(pts[0]), s: 0 });
  for (let k = 0; k + 1 < pts.length; k++) {
    const ax = X(pts[k]), az = Z(pts[k]), bx = X(pts[k + 1]), bz = Z(pts[k + 1]), L = Math.hypot(bx - ax, bz - az);
    const m = Math.max(1, Math.ceil(L / step));
    for (let q = 1; q <= m; q++) { const t = q / m; out.push({ x: ax + (bx - ax) * t, z: az + (bz - az) * t, s: acc + L * t }); }
    acc += L;
  }
  return out;
}
/** Nearest point of the polyline to p: { dist (off the line), along (distance from the start), seg, x, z }. */
export function projectOnPolyline(pts, p) {
  let best = { dist: Infinity, along: 0, seg: 0, x: X(pts[0] || p), z: Z(pts[0] || p) }, acc = 0;
  const px = X(p), pz = Z(p);
  if (pts.length === 1) return { dist: Math.hypot(px - X(pts[0]), pz - Z(pts[0])), along: 0, seg: 0, x: X(pts[0]), z: Z(pts[0]) };
  for (let k = 0; k + 1 < pts.length; k++) {
    const ax = X(pts[k]), az = Z(pts[k]), bx = X(pts[k + 1]), bz = Z(pts[k + 1]), dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz, L = Math.sqrt(L2);
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L2)) : 0;
    const qx = ax + dx * t, qz = az + dz * t, d = Math.hypot(px - qx, pz - qz);
    if (d < best.dist) best = { dist: d, along: acc + L * t, seg: k, x: qx, z: qz };
    acc += L;
  }
  return best;
}
/** The point `s` along the polyline (clamped to its ends). */
export function pointAlong(pts, s) {
  if (!pts.length) return null;
  if (s <= 0) return { x: X(pts[0]), z: Z(pts[0]) };
  let acc = 0;
  for (let k = 0; k + 1 < pts.length; k++) {
    const ax = X(pts[k]), az = Z(pts[k]), bx = X(pts[k + 1]), bz = Z(pts[k + 1]), L = Math.hypot(bx - ax, bz - az);
    if (acc + L >= s && L > 0) { const t = (s - acc) / L; return { x: ax + (bx - ax) * t, z: az + (bz - az) * t }; }
    acc += L;
  }
  const last = pts[pts.length - 1]; return { x: X(last), z: Z(last) };
}
/** Compass bearing (deg, 0 = north, clockwise) of the vector (dx east, dz south). */
export function bearingXZ(dx, dz) { return ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360; }

/**
 * Speed advice for the approach (knots): what a pilot would tell you at this distance from the berth.
 * Returns { maxKn, text } — under 300 m it is "slow below 2 kn" (the mooring speed).
 */
export function speedAdvice(distM) {
  if (distM <= 60) return { maxKn: 2, text: 'Alongside: under 2 kn and moor' };
  if (distM <= 300) return { maxKn: 2, text: 'Slow below 2 kn within 300 m' };
  if (distM <= 1000) return { maxKn: 4, text: 'Slow to 4 kn inside the harbour' };
  if (distM <= 2500) return { maxKn: 6, text: 'Harbour speed: 6 kn' };
  return { maxKn: 10, text: 'Approach under 10 kn' };
}

/**
 * Leaving harbour: after casting off from harbour H the guide stays quiet about H's berths (no line pointing back) until
 * the ship is `resumeM` closer to the berth than the furthest it has been since. state: null | { harbor, max }.
 * input: prevDocked (harbour id, null at sea, undefined = not known yet), docked, nbHarbor, contract, remaining (m).
 */
export function departureStep(state, { prevDocked, docked, nbHarbor, contract = false, remaining }, resumeM = 150) {
  if (docked) return null;
  let d = state;
  if (prevDocked && !docked) d = { harbor: prevDocked, max: 0 };
  if (!d) return null;
  if (!nbHarbor || nbHarbor !== d.harbor || contract) return null;
  if (!Number.isFinite(remaining)) return d;
  const max = Math.max(d.max, remaining);
  return remaining < max - resumeM ? null : { harbor: d.harbor, max };
}
