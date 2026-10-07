// Harbour geometry (docs/V3-CONTRACTS.md §1): every harbour gets a 448×448 cell patch at 10 m (land / water /
// structure mask + heights), a signed distance field for collisions, berths, an anchor in open water, a fairway and
// vector features — derived from OpenStreetMap when reachable (buildFromOSM) and from a deterministic procedural
// generator anchored to the real coast otherwise (buildSynthetic). Patches are cached in memory and on disk under
// data/geom/<id>.{json,bin}. The query functions used by game.js on every state message (landPenetration,
// nearestBerth, harborAnchor, sdfAt) are allocation-free and never throw.
import fs from 'node:fs';
import path from 'node:path';
import { PATCH, GEO, encodePatchHeight, decodePatchHeight } from '../shared/constants.js';
import { HARBORS, harborById } from './harbors.js';
import { DATA_DIR } from './world.js';
import * as osm from './osm.js';

export const GEOM_VERSION = 5;          // v4/v5: street layer (features.roads / areas / rails / pois / places)
export const PATCH_N = PATCH.N;
export const PATCH_RES = PATCH.RES;
export const MASK = PATCH.MASK;
export const PATCH_HEADER_BYTES = 28;
export const PATCH_MAGIC = 'SLHP';

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const { WATER, LAND, QUAY, BREAKWATER, PONTOON, FAIRWAY, SHALLOW } = MASK;
const IS_WATER = new Uint8Array([1, 0, 0, 0, 0, 1, 1]);    // mask code → navigable water?
const IS_OBSTACLE = new Uint8Array([0, 1, 1, 1, 1, 0, 0]);
const ALLOW_ANY = new Uint8Array([1, 1, 1, 1, 1, 1, 1]);
const ALLOW_WATER = IS_WATER;
const ALLOW_LAND = new Uint8Array([0, 1, 0, 0, 0, 0, 0]);
const ALLOW_SOFT = new Uint8Array([1, 1, 0, 0, 0, 1, 1]);    // everything but hard structures
const ALLOW_WATER_OR_LAND = new Uint8Array([1, 1, 0, 0, 0, 1, 1]);
const OSM_BACKOFF_MS = 30 * 60e3, NET_DOWN_MS = 10 * 60e3;

// ---------------------------------------------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------------------------------------------
let world = null;
const entries = new Map();          // id → entry
let entryList = [];                 // same entries as an array (fast iteration in landPenetration)
const building = new Map();         // id → Promise<geom|null>
const osmFailedAt = new Map();      // id → Date.now() of the last failed / unusable OSM attempt
let netFailures = 0, netDownUntil = 0;
const cfg = {
  dataDir: DATA_DIR,
  offline: process.env.SALTLINE_OFFLINE === '1' || !!process.env.NODE_TEST_CONTEXT,
  fetchImpl: null,
  radiusM: osm.DEFAULT_RADIUS_M,
  timeoutMs: 15_000,
  preload: !process.env.NODE_TEST_CONTEXT,
  log: (...a) => console.log(new Date().toISOString(), ...a),
};

/** Test / CLI hook: `{dataDir, offline, fetchImpl, timeoutMs, radiusM, log, preload}`. Clears the in-memory cache when the data dir changes. */
export function configure(opts = {}) {
  if (opts.dataDir && opts.dataDir !== cfg.dataDir) { cfg.dataDir = opts.dataDir; osm.configureOSM({ dataDir: opts.dataDir }); resetCache(); }
  if (typeof opts.offline === 'boolean') cfg.offline = opts.offline;
  if ('fetchImpl' in opts) cfg.fetchImpl = opts.fetchImpl;
  if (Number.isFinite(opts.timeoutMs)) cfg.timeoutMs = opts.timeoutMs;
  if (Number.isFinite(opts.radiusM)) cfg.radiusM = opts.radiusM;
  if (typeof opts.log === 'function') cfg.log = opts.log;
  if (typeof opts.preload === 'boolean') cfg.preload = opts.preload;
  netFailures = 0; netDownUntil = 0; osmFailedAt.clear();
}
export function resetCache() { entries.clear(); entryList = []; building.clear(); osmFailedAt.clear(); }
const geomDir = () => path.join(cfg.dataDir, 'geom');

/** Called once from server.js. Keeps the world for coast sampling and lazily loads the disk cache; never blocks. */
export function init(w) {
  world = w;
  if (cfg.preload) {
    let k = 0;
    const step = () => {
      try {
        while (k < HARBORS.length) {
          const h = HARBORS[k++];
          if (entries.has(h.id)) continue;
          const e = loadGeomCache(h.id);
          if (e) { setEntry(e); break; }
        }
      } catch (err) { cfg.log('[geom] preload error', err?.message || err); }
      if (k < HARBORS.length) setImmediate(step);
    };
    setImmediate(step);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Deterministic helpers
// ---------------------------------------------------------------------------------------------------------------
function hashString(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function mulberry32(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const round6 = (v) => Math.round(v * 1e6) / 1e6;
const round1 = (v) => Math.round(v * 10) / 10;
const bearingOf = (dx, dz) => ((Math.atan2(dx, -dz) * R2D) % 360 + 360) % 360;   // x east, z south → 0 = north, clockwise

// ---------------------------------------------------------------------------------------------------------------
// Build context: local frame (x east, z south, metres about the harbour point) + rasters
// ---------------------------------------------------------------------------------------------------------------
function newCtx(harbor, source) {
  const n = PATCH_N, res = PATCH_RES;
  const frame = osm.localFrame(harbor.lat, harbor.lon);
  return {
    harbor, source, n, res, half: (n * res) / 2, oLat: harbor.lat, oLon: harbor.lon, frame,
    mask: new Uint8Array(n * n), dredge: new Float32Array(n * n),
    features: { quays: [], piers: [], breakwaters: [], pontoons: [], buildings: [], cranes: [], lights: [], buoys: [], tanks: [] },
    faces: [],          // straight mooring faces in local metres: {ax, az, bx, bz, kind, side?: [sx, sz]}
    anchorPref: null,   // [x, z]
    fairwayHead: null,  // [[x, z], ...] forced first points (synthetic: anchor → entrance)
    fairwayHalf: 40, fairwayDepth: 14,
    hFloat: null, sdf: null, dObs: null, dWat: null, heights: null,
  };
}
const cellOf = (ctx, x, z) => [x / ctx.res + ctx.n / 2, z / ctx.res + ctx.n / 2];   // continuous cell coords
const idxOfXZ = (ctx, x, z) => { const i = Math.floor(x / ctx.res + ctx.n / 2), j = Math.floor(z / ctx.res + ctx.n / 2); return i < 0 || j < 0 || i >= ctx.n || j >= ctx.n ? -1 : j * ctx.n + i; };
const xzOfIdx = (ctx, idx) => [((idx % ctx.n) + 0.5 - ctx.n / 2) * ctx.res, (Math.floor(idx / ctx.n) + 0.5 - ctx.n / 2) * ctx.res];
const inPatch = (ctx, x, z) => x > -ctx.half && x < ctx.half && z > -ctx.half && z < ctx.half;
const maskAtXZ = (ctx, x, z) => { const k = idxOfXZ(ctx, x, z); return k < 0 ? -1 : ctx.mask[k]; };
const ringLLToCells = (ctx, pts) => pts.map((p) => { const [x, z] = ctx.frame.toXZ(p[0], p[1]); return cellOf(ctx, x, z); });
const ringXZToCells = (ctx, pts) => pts.map((p) => cellOf(ctx, p[0], p[1]));
const xzToLL = (ctx, x, z) => { const ll = ctx.frame.toLL(x, z); return [round6(ll[0]), round6(ll[1])]; };

/** Rotated rectangle (local metres): centre c, unit axes u/v, half extents. */
function rectXZ(cx, cz, ux, uz, hu, hv) {
  const vx = -uz, vz = ux;
  return [[cx + ux * hu + vx * hv, cz + uz * hu + vz * hv], [cx - ux * hu + vx * hv, cz - uz * hu + vz * hv],
    [cx - ux * hu - vx * hv, cz - uz * hu - vz * hv], [cx + ux * hu - vx * hv, cz + uz * hu - vz * hv]];
}

/**
 * Even-odd scanline fill of rings given in continuous cell coordinates into `target` (Uint8Array or Float32Array).
 * opts.allow: 7-entry table checked against opts.mask (defaults to the target when it is the mask); opts.max: only
 * raise values (for dredge depths).
 */
function fillRings(ctx, rings, target, value, opts = {}) {
  const n = ctx.n;
  const allow = opts.allow || null, src = opts.mask || ctx.mask, maxMode = !!opts.max;
  const rows = new Array(n);
  let jMin = n, jMax = -1;
  for (const ring of rings) {
    const m = ring.length; if (m < 3) continue;
    for (let i = 0; i < m; i++) {
      const a = ring[i], b = ring[(i + 1) % m];
      const ax = a[0], ay = a[1], bx = b[0], by = b[1];
      if (ay === by) continue;
      const yTop = ay < by ? ay : by, yBot = ay < by ? by : ay;
      let r0 = Math.ceil(yTop - 0.5), r1 = Math.ceil(yBot - 0.5) - 1;
      if (r1 < 0 || r0 >= n) continue;
      if (r0 < 0) r0 = 0; if (r1 > n - 1) r1 = n - 1;
      const dxdy = (bx - ax) / (by - ay);
      for (let r = r0; r <= r1; r++) { (rows[r] || (rows[r] = [])).push(ax + (r + 0.5 - ay) * dxdy); }
      if (r0 < jMin) jMin = r0; if (r1 > jMax) jMax = r1;
    }
  }
  for (let r = jMin; r <= jMax; r++) {
    const xs = rows[r]; if (!xs || xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      let c0 = Math.ceil(xs[k] - 0.5), c1 = Math.ceil(xs[k + 1] - 0.5) - 1;
      if (c1 < 0 || c0 >= n) continue;
      if (c0 < 0) c0 = 0; if (c1 > n - 1) c1 = n - 1;
      const o = r * n;
      if (!allow && !maxMode) { target.fill(value, o + c0, o + c1 + 1); continue; }
      for (let c = c0; c <= c1; c++) {
        const idx = o + c;
        if (allow && !allow[src[idx]]) continue;
        if (maxMode) { if (target[idx] < value) target[idx] = value; } else target[idx] = value;
      }
    }
  }
}
const fillRectXZ = (ctx, rect, target, value, opts) => fillRings(ctx, [ringXZToCells(ctx, rect)], target, value, opts);

/** Thick polyline (local metres) → cells; joints get a square cap so there are no gaps. */
function strokeXZ(ctx, pts, halfW, target, value, opts) {
  const rings = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz);
    if (L < 0.01) continue;
    const ux = dx / L, uz = dz / L;
    rings.push(ringXZToCells(ctx, rectXZ((ax + bx) / 2, (az + bz) / 2, ux, uz, L / 2 + halfW * 0.5, halfW)));
  }
  for (const r of rings) fillRings(ctx, [r], target, value, opts);
}

/** Mitred outline ring (local metres) of a polyline buffered by halfW; `shift` moves the line sideways first (left-normal units). */
function bufferPolylineXZ(pts, halfW, shift = 0) {
  const P = [];
  for (const p of pts) { const l = P[P.length - 1]; if (!l || Math.hypot(p[0] - l[0], p[1] - l[1]) > 0.05) P.push([p[0], p[1]]); }
  if (P.length < 2) return [];
  const m = P.length;
  const nrm = (i) => { const a = P[Math.max(0, i)], b = P[Math.min(m - 1, i + 1)]; const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1; return [dz / L, -dx / L]; }; // left normal (x east, z south)
  const left = [], right = [];
  for (let i = 0; i < m; i++) {
    const n0 = nrm(i === m - 1 ? i - 1 : i), n1 = nrm(i === 0 ? 0 : i - 1);
    let nx = n0[0] + n1[0], nz = n0[1] + n1[1];
    const L = Math.hypot(nx, nz);
    if (L < 1e-6) { nx = n0[0]; nz = n0[1]; } else { nx /= L; nz /= L; }
    const cosHalf = Math.max(0.35, nx * n0[0] + nz * n0[1]);           // miter limit
    const w = halfW / cosHalf;
    const cx = P[i][0] + nx * shift, cz = P[i][1] + nz * shift;
    left.push([cx + nx * w, cz + nz * w]); right.push([cx - nx * w, cz - nz * w]);
  }
  return left.concat(right.reverse());
}

/** Remove connected components of `value` smaller than minCells (4-connected), replacing them with `repl`. */
function removeSpecks(mask, n, value, repl, minCells) {
  const seen = new Uint8Array(n * n);
  const stack = new Int32Array(n * n);
  const comp = [];
  for (let s = 0; s < n * n; s++) {
    if (seen[s] || mask[s] !== value) continue;
    let top = 0, cnt = 0; stack[top++] = s; seen[s] = 1; comp.length = 0;
    while (top > 0) {
      const k = stack[--top]; comp.push(k); cnt++;
      const i = k % n, j = (k - i) / n;
      if (i > 0 && !seen[k - 1] && mask[k - 1] === value) { seen[k - 1] = 1; stack[top++] = k - 1; }
      if (i < n - 1 && !seen[k + 1] && mask[k + 1] === value) { seen[k + 1] = 1; stack[top++] = k + 1; }
      if (j > 0 && !seen[k - n] && mask[k - n] === value) { seen[k - n] = 1; stack[top++] = k - n; }
      if (j < n - 1 && !seen[k + n] && mask[k + n] === value) { seen[k + n] = 1; stack[top++] = k + n; }
    }
    if (cnt < minCells) for (const k of comp) mask[k] = repl;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Exact Euclidean distance transform (Felzenszwalb & Huttenlocher), distances in cells
// ---------------------------------------------------------------------------------------------------------------
const EDT_INF = 1e20;
function edt1d(f, n, d, v, z) {
  let k = 0; v[0] = 0; z[0] = -EDT_INF; z[1] = EDT_INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = EDT_INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
}
/** seedTest(maskValue) → true for zero-distance cells. Returns Float32Array distances (cells) to the nearest seed. */
function distanceTransform(mask, n, seedTable) {
  const g = new Float64Array(n * n);
  for (let i = 0; i < n * n; i++) g[i] = seedTable[mask[i]] ? 0 : EDT_INF;
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < n; x++) {              // columns
    for (let y = 0; y < n; y++) f[y] = g[y * n + x];
    edt1d(f, n, d, v, z);
    for (let y = 0; y < n; y++) g[y * n + x] = d[y];
  }
  const out = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {              // rows
    const o = y * n;
    for (let x = 0; x < n; x++) f[x] = g[o + x];
    edt1d(f, n, d, v, z);
    for (let x = 0; x < n; x++) out[o + x] = Math.sqrt(d[x]);
  }
  return out;
}
function computeDistances(ctx) {
  ctx.dObs = distanceTransform(ctx.mask, ctx.n, IS_OBSTACLE);   // for water cells: distance to the nearest obstacle
  ctx.dWat = distanceTransform(ctx.mask, ctx.n, IS_WATER);      // for obstacle cells: distance to the nearest water
}

/** Heights (contract §1) and the signed distance field (metres, negative inside obstacles) from the distances. */
function rasterHeights(ctx) {
  const { n, res, mask, dredge, dObs, dWat } = ctx;
  const N = n * n;
  const h = ctx.hFloat || (ctx.hFloat = new Float32Array(N));
  const sdf = ctx.sdf || (ctx.sdf = new Float32Array(N));
  const hu = ctx.heights || (ctx.heights = new Uint8Array(N));
  for (let i = 0; i < N; i++) {
    const m = mask[i];
    let v;
    if (IS_OBSTACLE[m]) {
      const d = (dWat[i] - 0.5) * res;
      sdf[i] = -(d < 0 ? 0 : d);
      v = m === LAND ? Math.min(12, 1.5 + 0.02 * (d < 0 ? 0 : d)) : m === QUAY ? 2.5 : m === BREAKWATER ? 3.5 : 0.6;
    } else {
      let d = (dObs[i] - 0.5) * res; if (d < 0) d = 0;
      sdf[i] = d;
      if (m === SHALLOW) v = -1;
      else {
        v = -(3 + 0.08 * d); if (v < -18) v = -18;
        if (m === FAIRWAY && v > -14) v = -14;
        const dr = dredge[i]; if (dr > 0 && v > -dr) v = -dr;
      }
    }
    h[i] = v;
    hu[i] = encodePatchHeight(v);
  }
}
function heightAtXZ(ctx, x, z) {   // bilinear on the float heights
  const n = ctx.n;
  const u = x / ctx.res + n / 2 - 0.5, v = z / ctx.res + n / 2 - 0.5;
  const i0 = clamp(Math.floor(u), 0, n - 2), j0 = clamp(Math.floor(v), 0, n - 2);
  const fx = clamp(u - i0, 0, 1), fy = clamp(v - j0, 0, 1);
  const h = ctx.hFloat, o = j0 * n + i0;
  return (h[o] * (1 - fx) + h[o + 1] * fx) * (1 - fy) + (h[o + n] * (1 - fx) + h[o + n + 1] * fx) * fy;
}
function sdfAtXZ(ctx, x, z) {
  const n = ctx.n;
  const u = x / ctx.res + n / 2 - 0.5, v = z / ctx.res + n / 2 - 0.5;
  const i0 = clamp(Math.floor(u), 0, n - 2), j0 = clamp(Math.floor(v), 0, n - 2);
  const fx = clamp(u - i0, 0, 1), fy = clamp(v - j0, 0, 1);
  const s = ctx.sdf, o = j0 * n + i0;
  return (s[o] * (1 - fx) + s[o + 1] * fx) * (1 - fy) + (s[o + n] * (1 - fx) + s[o + n + 1] * fx) * fy;
}

/** Water cells within ~2 cells of natural land become shallows (unless dredged). */
function markShallows(ctx) {
  const { n, mask, dredge } = ctx;
  const tmp = new Uint8Array(n * n);
  for (let pass = 0; pass < 2; pass++) {
    const near = pass === 0 ? (m) => m === LAND : (m) => m === LAND || m === SHALLOW;
    tmp.fill(0);
    for (let j = 1; j < n - 1; j++) {
      const o = j * n;
      for (let i = 1; i < n - 1; i++) {
        const k = o + i;
        if (mask[k] !== WATER || dredge[k] > 0) continue;
        if (near(mask[k - 1]) || near(mask[k + 1]) || near(mask[k - n]) || near(mask[k + n]) || near(mask[k - n - 1]) || near(mask[k - n + 1]) || near(mask[k + n - 1]) || near(mask[k + n + 1])) tmp[k] = 1;
      }
    }
    for (let k = 0; k < n * n; k++) if (tmp[k]) mask[k] = SHALLOW;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// World sampling (bilinear world.heightAt on a coarse grid, upsampled) — the synthetic coast
// ---------------------------------------------------------------------------------------------------------------
function sampleWorld(ctx, w, rnd) {
  const { n, res } = ctx;
  const step = 4, m = n / step + 1;
  const coarse = new Float32Array(m * m);
  for (let J = 0; J < m; J++) for (let I = 0; I < m; I++) {
    const x = (I * step - n / 2) * res, z = (J * step - n / 2) * res;
    const ll = ctx.frame.toLL(x, z);
    let h = w ? w.heightAt(ll[0], ll[1]) : -20;
    if (!Number.isFinite(h)) h = -20;
    coarse[J * m + I] = h;
  }
  // value noise lattice (120 m) for a less geometric shoreline
  const nl = Math.ceil((n * res) / 120) + 2, lat = new Float32Array(nl * nl);
  for (let i = 0; i < lat.length; i++) lat[i] = rnd() * 2 - 1;
  const out = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const v = (j + 0.5) / step, J0 = Math.min(m - 2, Math.floor(v)), fy = v - J0;
    const zn = (j + 0.5) * res / 120, Jn = Math.min(nl - 2, Math.floor(zn)), gy = zn - Jn;
    for (let i = 0; i < n; i++) {
      const u = (i + 0.5) / step, I0 = Math.min(m - 2, Math.floor(u)), fx = u - I0;
      const o = J0 * m + I0;
      const base = (coarse[o] * (1 - fx) + coarse[o + 1] * fx) * (1 - fy) + (coarse[o + m] * (1 - fx) + coarse[o + m + 1] * fx) * fy;
      const xn = (i + 0.5) * res / 120, In = Math.min(nl - 2, Math.floor(xn)), gx = xn - In;
      const q = Jn * nl + In;
      const noise = (lat[q] * (1 - gx) + lat[q + 1] * gx) * (1 - gy) + (lat[q + nl] * (1 - gx) + lat[q + nl + 1] * gx) * gy;
      out[j * n + i] = base + noise * 0.7;
    }
  }
  return out;
}

/** March from (x,z) along (dx,dz) until the predicate holds; returns the distance or -1 (left the patch / maxDist). */
function marchUntil(ctx, x, z, dx, dz, maxDist, pred, step = ctx.res) {
  for (let r = step; r <= maxDist; r += step) {
    const px = x + dx * r, pz = z + dz * r;
    if (!inPatch(ctx, px, pz)) return -1;
    if (pred(ctx.mask[idxOfXZ(ctx, px, pz)])) return r;
  }
  return -1;
}

/** Where is the nearest coast around a water point? → {cx, cz, tx, tz, nx, nz, dMin} (t along the coast, n seaward) or null. */
function analyseCoast(ctx, sx, sz, maxDist = 2300) {
  const hits = [];
  for (let b = 0; b < 360; b += 6) {
    const dx = Math.sin(b * D2R), dz = -Math.cos(b * D2R);
    const r = marchUntil(ctx, sx, sz, dx, dz, maxDist, (m) => m === LAND, 20);
    if (r > 0) hits.push({ b, r, x: sx + dx * r, z: sz + dz * r });
  }
  if (hits.length < 3) return null;
  let best = hits[0]; for (const h of hits) if (h.r < best.r) best = h;
  const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
  const near = hits.filter((h) => angDiff(h.b, best.b) <= 75);
  const close = hits.filter((h) => angDiff(h.b, best.b) <= 40);
  let cx = 0, cz = 0; for (const h of close) { cx += h.x; cz += h.z; } cx /= close.length; cz /= close.length;
  // PCA of the near hits → coast tangent
  let mx = 0, mz = 0; for (const h of near) { mx += h.x; mz += h.z; } mx /= near.length; mz /= near.length;
  let sxx = 0, sxz = 0, szz = 0;
  for (const h of near) { const ex = h.x - mx, ez = h.z - mz; sxx += ex * ex; sxz += ex * ez; szz += ez * ez; }
  let tx, tz;
  if (near.length < 3 || sxx + szz < 1) { tx = -(best.z - sz); tz = best.x - sx; }   // perpendicular to the nearest direction
  else { const theta = 0.5 * Math.atan2(2 * sxz, sxx - szz); tx = Math.cos(theta); tz = Math.sin(theta); }
  const L = Math.hypot(tx, tz) || 1; tx /= L; tz /= L;
  let nx = -tz, nz = tx;                                           // seaward normal: points from the coast toward the sample point
  if (nx * (sx - cx) + nz * (sz - cz) < 0) { nx = -nx; nz = -nz; }
  return { cx, cz, tx, tz, nx, nz, dMin: best.r };
}

/** Paint a reclaimed-land lobe at `dist` metres along (dx,dz) from (sx,sz) — used when no coast is close enough. */
function paintLandLobe(ctx, sx, sz, dx, dz, dist, rnd, halfW = 900) {
  const cx = sx + dx * dist, cz = sz + dz * dist;
  const ring = [];
  const ax = -dz, az = dx;                                           // long axis across the approach direction
  const p1 = rnd() * 6, p2 = rnd() * 6;
  for (let k = 0; k < 48; k++) {
    const a = (k / 48) * Math.PI * 2;
    const ru = halfW * (1 + 0.1 * Math.sin(a * 3 + p1)), rv = 520 * (1 + 0.1 * Math.cos(a * 2 + p2));
    const u = Math.cos(a) * ru, v = Math.sin(a) * rv;
    ring.push([cx + ax * u + dx * v, cz + az * u + dz * v]);
  }
  fillRings(ctx, [ringXZToCells(ctx, ring)], ctx.mask, LAND, { allow: ALLOW_WATER });
  // and everything further along the direction, so the lobe is a peninsula when the real land is behind it
  const far = 3200, wide = halfW + 600;
  fillRings(ctx, [ringXZToCells(ctx, [[cx + ax * wide, cz + az * wide], [cx + ax * wide + dx * far, cz + az * wide + dz * far],
    [cx - ax * wide + dx * far, cz - az * wide + dz * far], [cx - ax * wide, cz - az * wide]])], ctx.mask, LAND, { allow: ALLOW_WATER });
}

/** Direction toward the nearest world land from a point (ring search up to 25 km) or null. */
function directionToWorldLand(ctx, w, lat, lon) {
  if (!w) return null;
  const kLon = ctx.frame.kLon;
  for (const rKm of [2.5, 4, 6, 9, 13, 18, 25]) {
    for (let b = 0; b < 360; b += 15) {
      const dx = Math.sin(b * D2R), dz = -Math.cos(b * D2R);
      const la = lat - (dz * rKm * 1000) / GEO.M_PER_DEG_LAT, lo = lon + (dx * rKm * 1000) / kLon;
      if (Math.abs(la) < 89 && !w.isWater(la, lo)) return [dx, dz];
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Synthetic harbour
// ---------------------------------------------------------------------------------------------------------------
const SIZES = {
  mega: { quayLen: 380, nQuays: 4, docks: 2, dockLen: 800, dockW: 200, B: 600, leg2: 600, leg3: 450, entrance: 350, basinDepth: 14, berthDepth: 16, cranes: 5, tanks: 8, bwHalf: 10, fairHalf: 60, fairDepth: 16, fingers: 2 },
  major: { quayLen: 300, nQuays: 4, docks: 1, dockLen: 600, dockW: 180, B: 560, leg2: 450, leg3: 300, entrance: 300, basinDepth: 12, berthDepth: 13, cranes: 4, tanks: 5, bwHalf: 9, fairHalf: 50, fairDepth: 14, fingers: 3 },
  regional: { quayLen: 220, nQuays: 3, docks: 1, dockLen: 450, dockW: 150, B: 480, leg2: 330, leg3: 220, entrance: 250, basinDepth: 10, berthDepth: 10.5, cranes: 2, tanks: 2, bwHalf: 8, fairHalf: 45, fairDepth: 14, fingers: 3 },
  minor: { quayLen: 160, nQuays: 2, docks: 0, dockLen: 0, dockW: 0, B: 400, leg2: 240, leg3: 150, entrance: 180, basinDepth: 9, berthDepth: 8.5, cranes: 1, tanks: 0, bwHalf: 7, fairHalf: 40, fairDepth: 14, fingers: 3 },
};

/** Distance from (x,z) along the unit direction (dx,dz) to the patch boundary. */
function extentAlong(ctx, x, z, dx, dz) {
  let t = Infinity;
  if (dx > 1e-9) t = Math.min(t, (ctx.half - x) / dx); else if (dx < -1e-9) t = Math.min(t, (-ctx.half - x) / dx);
  if (dz > 1e-9) t = Math.min(t, (ctx.half - z) / dz); else if (dz < -1e-9) t = Math.min(t, (-ctx.half - z) / dz);
  return Math.max(0, t);
}

/**
 * Lay a stepped row of straight quays (cut into the land) with dredged water in front, reclaimed land behind,
 * warehouses, cranes and optional dock basins; records mooring faces and vector features. `lay` = {cx, cz, tx, tz,
 * nx, nz} coast frame (t along the coast, n seaward). Returns the u-extent used [uMin, uMax] (local to the frame).
 */
const ROOT_M = 100, ROOT_P = 230;   // breakwater roots beyond the row ends (−u side / +u marina side)
function placeQuayRow(ctx, lay, S, rnd, opts = {}) {
  const { tx, tz, nx, nz } = lay;
  let { cx, cz } = lay;
  const faceV = opts.faceV ?? -60, gap = 30;
  let nQuays = opts.nQuays ?? S.nQuays, quayLen = opts.quayLen ?? S.quayLen, docks = opts.docks ?? S.docks;
  let dockLen = S.dockLen, dockW = S.dockW;
  const eUp = extentAlong(ctx, cx, cz, tx, tz) - 60, eUm = extentAlong(ctx, cx, cz, -tx, -tz) - 60;
  const eIn = extentAlong(ctx, cx, cz, -nx, -nz) - 30;
  if (dockLen > eIn - 140) dockLen = eIn - 140;
  if (dockLen < 220) docks = 0;
  const need = () => nQuays * quayLen + (nQuays - 1) * gap;
  // room needed on each side of the row centre: roots, then dock basins outside the roots
  const needP = () => need() / 2 + ROOT_P + (docks >= 1 ? 90 + dockW + 60 : 60);
  const needM = () => need() / 2 + ROOT_M + (docks >= 2 ? 90 + dockW + 60 : 60);
  while (docks > 0 && needP() + needM() > eUp + eUm) docks--;
  while (nQuays > 2 && needP() + needM() > eUp + eUm) nQuays--;
  while (quayLen > 120 && needP() + needM() > eUp + eUm) quayLen -= 20;
  // slide the row along the coast so both sides fit (closest shift to zero within the feasible interval)
  const lo = needM() - eUm, hi = eUp - needP();
  const shift = lo <= hi ? clamp(0, lo, hi) : (lo + hi) / 2;
  cx += tx * shift; cz += tz * shift;
  const P = (u, v) => [cx + tx * u + nx * v, cz + tz * u + nz * v];
  const U = need();
  const berthDepth = opts.berthDepth ?? S.berthDepth, basinDepth = opts.basinDepth ?? S.basinDepth;
  const inland = Math.min(320, eIn);

  // reclaimed land behind the row, quay strip, water apron in front
  fillRings(ctx, [ringXZToCells(ctx, [P(-U / 2 - 40, faceV - inland), P(U / 2 + 40, faceV - inland), P(U / 2 + 40, faceV - 28), P(-U / 2 - 40, faceV - 28)])], ctx.mask, LAND, { allow: ALLOW_WATER });
  fillRings(ctx, [ringXZToCells(ctx, [P(-U / 2, faceV - 30), P(U / 2, faceV - 30), P(U / 2, faceV), P(-U / 2, faceV)])], ctx.mask, QUAY, { allow: ALLOW_SOFT });
  fillRings(ctx, [ringXZToCells(ctx, [P(-U / 2 - 30, faceV), P(U / 2 + 30, faceV), P(U / 2 + 30, faceV + 110), P(-U / 2 - 30, faceV + 110)])], ctx.mask, WATER, { allow: ALLOW_SOFT });
  fillRings(ctx, [ringXZToCells(ctx, [P(-U / 2 - 30, faceV), P(U / 2 + 30, faceV), P(U / 2 + 30, faceV + 110), P(-U / 2 - 30, faceV + 110)])], ctx.dredge, basinDepth, { max: true });

  const segs = [];
  let u = -U / 2, longest = null;
  for (let k = 0; k < nQuays; k++) {
    const off = k % 2 ? 15 : 0;
    const u0 = u, u1 = u + quayLen;
    if (off) {
      fillRings(ctx, [ringXZToCells(ctx, [P(u0, faceV - 30), P(u1, faceV - 30), P(u1, faceV + off), P(u0, faceV + off)])], ctx.mask, QUAY, { allow: ALLOW_SOFT });
    }
    const a = P(u0, faceV + off), b = P(u1, faceV + off);
    ctx.faces.push({ ax: a[0], az: a[1], bx: b[0], bz: b[1], kind: 'quay', side: [nx, nz] });
    ctx.features.quays.push({ pts: [P(u0, faceV - 30), P(u1, faceV - 30), P(u1, faceV + off), P(u0, faceV + off)].map((p) => xzToLL(ctx, p[0], p[1])) });
    // berth pocket
    fillRings(ctx, [ringXZToCells(ctx, [P(u0 - 10, faceV + off), P(u1 + 10, faceV + off), P(u1 + 10, faceV + off + 60), P(u0 - 10, faceV + off + 60)])], ctx.dredge, berthDepth, { max: true });
    segs.push({ u0, u1, off });
    if (!longest || quayLen > longest.len) longest = { u0, u1, off, len: quayLen };
    // warehouses behind the quay
    const nW = Math.max(1, Math.round(quayLen / 120));
    const slot = quayLen / nW;
    for (let w = 0; w < nW; w++) {
      const wl = Math.min(90, slot - 20) * (0.75 + rnd() * 0.25), wd = 24 + rnd() * 16;
      const uc = u0 + slot * (w + 0.5), vc = faceV - 46 - wd / 2;
      if (vc - wd / 2 < faceV - inland + 10) continue;
      const ring = [P(uc - wl / 2, vc - wd / 2), P(uc + wl / 2, vc - wd / 2), P(uc + wl / 2, vc + wd / 2), P(uc - wl / 2, vc + wd / 2)];
      if (ring.every((p) => inPatch(ctx, p[0], p[1]))) ctx.features.buildings.push({ pts: ring.map((p) => xzToLL(ctx, p[0], p[1])), height: round1(7 + rnd() * 7), kind: 'warehouse' });
    }
    u = u1 + gap;
  }
  // second row of industrial sheds and tanks for the bigger ports
  if ((S.tanks > 0 || S.nQuays >= 4) && inland > 200) {
    const nS = Math.max(1, Math.round(U / 260));
    for (let s = 0; s < nS; s++) {
      const uc = -U / 2 + (U / nS) * (s + 0.5), wl = Math.min(120, U / nS - 30), wd = 45 + rnd() * 15, vc = faceV - 140;
      const ring = [P(uc - wl / 2, vc - wd / 2), P(uc + wl / 2, vc - wd / 2), P(uc + wl / 2, vc + wd / 2), P(uc - wl / 2, vc + wd / 2)];
      if (ring.every((p) => inPatch(ctx, p[0], p[1]))) ctx.features.buildings.push({ pts: ring.map((p) => xzToLL(ctx, p[0], p[1])), height: round1(10 + rnd() * 6), kind: 'industrial' });
    }
    if (S.tanks > 0 && inland > 260) {
      const cols = Math.ceil(S.tanks / 2);
      for (let t = 0; t < S.tanks; t++) {
        const r = 14 + rnd() * 12, uc = -U / 2 + 40 + (t % cols) * 70 + r, vc = faceV - 210 - Math.floor(t / cols) * 65 - r;
        const p = P(uc, vc);
        if (inPatch(ctx, p[0], p[1]) && maskAtXZ(ctx, p[0], p[1]) === LAND) ctx.features.tanks.push({ lat: xzToLL(ctx, p[0], p[1])[0], lon: xzToLL(ctx, p[0], p[1])[1], radius: round1(r), height: round1(12 + rnd() * 6) });
      }
    }
  }
  // cranes along the longest quay
  if (longest && S.cranes > 0) {
    const hdg = Math.round(bearingOf(tx, tz));
    for (let c = 0; c < S.cranes; c++) {
      const uc = longest.u0 + ((c + 0.5) / S.cranes) * longest.len;
      const p = P(uc, faceV + longest.off - 12);
      const ll = xzToLL(ctx, p[0], p[1]);
      ctx.features.cranes.push({ lat: ll[0], lon: ll[1], hdg });
    }
  }
  // dock basins cut perpendicular into the land, outside the breakwater roots (both sides for two docks)
  const dockSides = docks >= 2 ? [1, -1] : docks === 1 ? [1] : [];
  let uMin = -U / 2, uMax = U / 2;
  for (const s of dockSides) {
    const uD = s * (U / 2 + (s > 0 ? ROOT_P : ROOT_M) + 90 + dockW / 2);
    const uL = uD - dockW / 2, uR = uD + dockW / 2, vHead = faceV - dockLen;
    fillRings(ctx, [ringXZToCells(ctx, [P(uL - 110, vHead - 130), P(uR + 110, vHead - 130), P(uR + 110, faceV - 28), P(uL - 110, faceV - 28)])], ctx.mask, LAND, { allow: ALLOW_WATER });
    fillRings(ctx, [ringXZToCells(ctx, [P(uL, vHead), P(uR, vHead), P(uR, faceV + 110), P(uL, faceV + 110)])], ctx.mask, WATER, { allow: ALLOW_SOFT });
    fillRings(ctx, [ringXZToCells(ctx, [P(uL - 30, vHead), P(uR + 30, vHead), P(uR + 30, faceV + 110), P(uL - 30, faceV + 110)])], ctx.dredge, berthDepth, { max: true });
    for (const [wa, wb, sideSign] of [[uL - 25, uL, 1], [uR, uR + 25, -1]]) {
      const ring = [P(wa, vHead - 25), P(wb, vHead - 25), P(wb, faceV), P(wa, faceV)];
      fillRings(ctx, [ringXZToCells(ctx, ring)], ctx.mask, QUAY, { allow: ALLOW_SOFT });
      ctx.features.quays.push({ pts: ring.map((p) => xzToLL(ctx, p[0], p[1])) });
      const faceU = sideSign > 0 ? uL : uR;
      const a = P(faceU, faceV - 5), b = P(faceU, vHead + 5);
      ctx.faces.push({ ax: a[0], az: a[1], bx: b[0], bz: b[1], kind: 'quay', side: [tx * sideSign, tz * sideSign] });
      // sheds along the dock
      const nW = Math.max(1, Math.round(dockLen / 150));
      for (let w = 0; w < nW; w++) {
        const vc = faceV - 40 - (dockLen - 60) * ((w + 0.5) / nW), wl = 30 + rnd() * 20, wd = Math.min(100, (dockLen - 60) / nW - 25);
        const uc = sideSign > 0 ? wa - 20 - wl / 2 : wb + 20 + wl / 2;
        const ring = [P(uc - wl / 2, vc - wd / 2), P(uc + wl / 2, vc - wd / 2), P(uc + wl / 2, vc + wd / 2), P(uc - wl / 2, vc + wd / 2)];
        if (ring.every((p) => inPatch(ctx, p[0], p[1]))) ctx.features.buildings.push({ pts: ring.map((p) => xzToLL(ctx, p[0], p[1])), height: round1(8 + rnd() * 6), kind: 'warehouse' });
      }
    }
    const head = [P(uL - 25, vHead - 25), P(uR + 25, vHead - 25), P(uR + 25, vHead), P(uL - 25, vHead)];
    fillRings(ctx, [ringXZToCells(ctx, head)], ctx.mask, QUAY, { allow: ALLOW_SOFT });
    ctx.features.quays.push({ pts: head.map((p) => xzToLL(ctx, p[0], p[1])) });
    if (s > 0) uMax = uR + 60; else uMin = uL - 60;
  }
  return { U, uMin, uMax, uA: -U / 2 - ROOT_M, uB: U / 2 + ROOT_P, faceV, segs, nQuays, quayLen, lay: { cx, cz, tx, tz, nx, nz } };
}

function entranceLights(ctx, heads, E, dEnter) {
  // dEnter: unit vector of travel when ENTERING; port hand = left of it
  const lx = dEnter[1], lz = -dEnter[0];
  const regionB = osm.ialaRegion(ctx.oLat, ctx.oLon) === 'B';
  for (const h of heads) {
    const port = (h[0] - E[0]) * lx + (h[1] - E[1]) * lz > 0;
    const red = port !== regionB;
    const ll = xzToLL(ctx, h[0], h[1]);
    ctx.features.lights.push({ lat: ll[0], lon: ll[1], height: h[2] ? 14 : 7, color: h[2] ? '#ffffff' : red ? osm.BUOY_COLORS.red : osm.BUOY_COLORS.green, period: h[2] ? 5 : 3 });
    if (h[2]) { ctx.features.lights.push({ lat: ll[0], lon: ll[1], height: 7, color: red ? osm.BUOY_COLORS.red : osm.BUOY_COLORS.green, period: 2.5 }); }
  }
}

/**
 * Deterministic procedural harbour anchored to the real coast (contract §1 buildSynthetic).
 * Returns {geom, heights, mask, sdf}.
 */
export function buildSynthetic(harbor, w = world) {
  const ctx = newCtx(harbor, 'synthetic');
  const rnd = mulberry32(hashString(harbor.id));
  const S = SIZES[harbor.size] || SIZES.regional;
  const { n, mask } = ctx;
  // 1. coast from the world raster
  const base = sampleWorld(ctx, w, rnd);
  for (let i = 0; i < n * n; i++) mask[i] = base[i] >= 0 ? LAND : WATER;
  removeSpecks(mask, n, LAND, WATER, 30);
  removeSpecks(mask, n, WATER, LAND, 30);
  // 2. the harbour point must be water (it may be up a river in the world raster): shift the anchor seed
  let sx = 0, sz = 0;
  if (mask[idxOfXZ(ctx, 0, 0)] !== WATER) {
    let found = false;
    if (w) {
      const nw = w.nearestWater(harbor.lat, harbor.lon, 40);
      const [x, z] = ctx.frame.toXZ(nw.lat, nw.lon);
      if (inPatch(ctx, x, z) && mask[idxOfXZ(ctx, x, z)] === WATER) { sx = x; sz = z; found = true; }
    }
    if (!found) {
      let best = -1, bd = Infinity;
      for (let k = 0; k < n * n; k++) if (mask[k] === WATER) { const [x, z] = xzOfIdx(ctx, k); const d = x * x + z * z; if (d < bd) { bd = d; best = k; } }
      if (best >= 0) { [sx, sz] = xzOfIdx(ctx, best); found = true; }
    }
    if (!found) { // the whole patch is land: dig a basin at the harbour point
      const ring = []; for (let k = 0; k < 24; k++) ring.push([Math.cos(k / 24 * Math.PI * 2) * 420, Math.sin(k / 24 * Math.PI * 2) * 420]);
      fillRings(ctx, [ringXZToCells(ctx, ring)], mask, WATER);
    }
  }
  // 3. coast frame; invent a reclaimed lobe when the real coast is too far, absent, or leaves no room in the patch
  let lay = analyseCoast(ctx, sx, sz);
  const roomOK = (l) => l && l.dMin <= 1450 && extentAlong(ctx, l.cx, l.cz, -l.nx, -l.nz) >= 420
    && extentAlong(ctx, l.cx, l.cz, l.tx, l.tz) + extentAlong(ctx, l.cx, l.cz, -l.tx, -l.tz) >= 900;
  if (!roomOK(lay)) {
    let dir = lay ? [(lay.cx - sx) / Math.hypot(lay.cx - sx, lay.cz - sz), (lay.cz - sz) / Math.hypot(lay.cx - sx, lay.cz - sz)] : directionToWorldLand(ctx, w, harbor.lat, harbor.lon);
    if (!dir) { const b = rnd() * Math.PI * 2; dir = [Math.sin(b), -Math.cos(b)]; }
    const halfW = Math.max(900, (S.nQuays * S.quayLen + 300) / 2 + 350);
    paintLandLobe(ctx, sx, sz, dir[0], dir[1], 1250, rnd, halfW);
    removeSpecks(mask, n, WATER, LAND, 30);
    lay = analyseCoast(ctx, sx, sz) || { cx: sx + dir[0] * 1250, cz: sz + dir[1] * 1250, tx: -dir[1], tz: dir[0], nx: -dir[0], nz: -dir[1], dMin: 1250 };
  }
  // 4. quays, docks, warehouses, cranes (the row may slide along the coast to fit the patch)
  const row = placeQuayRow(ctx, lay, S, rnd);
  const { cx, cz, tx, tz, nx, nz } = row.lay;
  const P = (u, v) => [cx + tx * u + nx * v, cz + tz * u + nz * v];
  const faceV = row.faceV;
  // 5. breakwaters (stroked over water only; the ring in the JSON starts at the shore)
  const seaExtent = extentAlong(ctx, cx, cz, nx, nz) - 80;
  const wWater = marchUntil(ctx, P(0, faceV + 120)[0], P(0, faceV + 120)[1], nx, nz, 2600, (m) => m === LAND, 20);
  let B = S.B * (0.92 + rnd() * 0.16);
  B = Math.min(B, seaExtent - 60, wWater > 0 ? wWater * 0.55 + 100 : Infinity);
  B = Math.max(200, B);
  const uA = row.uA, uB = row.uB;
  const span = uB - uA;
  const leg2 = Math.min(S.leg2, Math.max(80, (span - S.entrance) * 0.6)), leg3 = Math.min(S.leg3, Math.max(60, (span - S.entrance) * 0.4));
  const mainPts = [P(uA, faceV - 260), P(uA, faceV + B), P(uA + leg2, faceV + B)];
  const leePts = [P(uB, faceV - 260), P(uB, faceV + B * 0.6), P(uB - leg3, faceV + B * 0.6)];
  const addBreakwater = (pts) => {
    // trim the inland part so the ring starts on the shore
    const [a, b] = pts;
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let start = a;
    for (let r = 0; r <= L; r += ctx.res) { const px = a[0] + (b[0] - a[0]) * r / L, pz = a[1] + (b[1] - a[1]) * r / L; const m = maskAtXZ(ctx, px, pz); if (m >= 0 && IS_WATER[m]) { start = [px - (b[0] - a[0]) / L * 25, pz - (b[1] - a[1]) / L * 25]; break; } }
    const line = [start].concat(pts.slice(1));
    strokeXZ(ctx, line, S.bwHalf, mask, BREAKWATER, { allow: ALLOW_WATER });
    const ring = bufferPolylineXZ(line, S.bwHalf);
    if (ring.length >= 3) ctx.features.breakwaters.push({ pts: ring.map((p) => xzToLL(ctx, p[0], p[1])) });
  };
  addBreakwater(mainPts); addBreakwater(leePts);
  // 6. pontoon marina in the lee corner of the basin (a shallow cut-out of the shore; each finger moors on both edges)
  const marina = [P(row.U / 2 + 20, faceV), P(uB - 25, faceV), P(uB - 25, faceV + 125), P(row.U / 2 + 20, faceV + 125)];
  fillRings(ctx, [ringXZToCells(ctx, marina)], mask, WATER, { allow: ALLOW_SOFT });
  fillRings(ctx, [ringXZToCells(ctx, marina)], ctx.dredge, 3.5, { max: true });
  for (let f = 0; f < S.fingers; f++) {
    const u = row.U / 2 + 45 + f * 55;
    if (u + 20 > uB - 30) break;
    const a = P(u, faceV + 18), b = P(u, faceV + 98);
    strokeXZ(ctx, [a, b], 6, mask, PONTOON, { allow: ALLOW_WATER });
    ctx.features.pontoons.push({ pts: rectXZ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, nx, nz, 40, 4).map((p) => xzToLL(ctx, p[0], p[1])) });
    for (const s of [1, -1]) ctx.faces.push({ ax: a[0] + tx * 5 * s, az: a[1] + tz * 5 * s, bx: b[0] + tx * 5 * s, bz: b[1] + tz * 5 * s, kind: 'pontoon', side: [tx * s, tz * s] });
  }
  // 7. basin dredge, shallows elsewhere
  fillRings(ctx, [ringXZToCells(ctx, [P(uA + 25, faceV), P(uB - 25, faceV), P(uB - 25, faceV + B - 25), P(uA + 25, faceV + B - 25)])], ctx.dredge, S.basinDepth, { max: true, allow: ALLOW_WATER });
  // 8. anchor + fairway head through the entrance
  const H1 = mainPts[2], H2 = leePts[2];
  const E = [(H1[0] + H2[0]) / 2, (H1[1] + H2[1]) / 2];
  ctx.anchorPref = P(0, faceV + Math.min(B * 0.5, 260));
  ctx.fairwayHead = [E];
  ctx.fairwayHalf = S.fairHalf; ctx.fairwayDepth = S.fairDepth;
  ctx.entrance = { E, heads: [[H1[0], H1[1], true], [H2[0], H2[1], false]] };
  ctx.synthBuoys = true;
  return finishBuild(ctx, w);
}

// ---------------------------------------------------------------------------------------------------------------
// OSM harbour
// ---------------------------------------------------------------------------------------------------------------
function stripRing(ctx, ptsXZ, halfW, shift) { return bufferPolylineXZ(ptsXZ, halfW, shift); }

/** Which side (left normal units) of an open line is land in the current mask: +1 left, -1 right, 0 undecided. */
function landSide(ctx, ptsXZ, probe) {
  let left = 0, right = 0;
  for (let i = 0; i + 1 < ptsXZ.length; i++) {
    const [ax, az] = ptsXZ[i], [bx, bz] = ptsXZ[i + 1];
    const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz) || 1;
    const lx = dz / L, lz = -dx / L, mx = (ax + bx) / 2, mz = (az + bz) / 2;
    const ml = maskAtXZ(ctx, mx + lx * probe, mz + lz * probe), mr = maskAtXZ(ctx, mx - lx * probe, mz - lz * probe);
    if (ml === LAND) left++; if (mr === LAND) right++;
  }
  return left > right ? 1 : right > left ? -1 : 0;
}

/** True when the OSM payload has anything the rasteriser can use for this harbour. */
export function osmUsable(osmData, harbor) {
  if (!osmData || !Array.isArray(osmData.coastline) || !Array.isArray(osmData.features)) return false;
  const bbox = osm.bboxAround(harbor.lat, harbor.lon, (PATCH_N * PATCH_RES) / 2);
  const inBox = (p) => p[0] >= bbox.latMin && p[0] <= bbox.latMax && p[1] >= bbox.lonMin && p[1] <= bbox.lonMax;
  if (osmData.coastline.some((way) => way.some(inBox))) return true;
  return osmData.features.some((f) => f.type === 'way' && f.tags && (f.tags.man_made === 'quay' || f.tags.man_made === 'pier' || f.tags.man_made === 'breakwater' || f.tags.waterway === 'dock') && f.geometry?.some(inBox));
}

/** Raster + features from OpenStreetMap data (contract §1 buildFromOSM). Returns {geom, heights, mask, sdf}. */
export function buildFromOSM(harbor, osmData, w = world) {
  const ctx = newCtx(harbor, 'osm');
  const rnd = mulberry32(hashString(harbor.id) ^ 0x9e3779b9);
  const { n, mask } = ctx;
  const bbox = osm.bboxAround(harbor.lat, harbor.lon, ctx.half);
  const defaultLand = w ? !w.isWater(harbor.lat, harbor.lon) : false;
  const landPolys = osm.landPolygonsFromCoastline(osmData?.coastline || [], bbox, { defaultLand });
  fillRings(ctx, landPolys.map((r) => ringLLToCells(ctx, r)), mask, LAND);
  const cls = osm.classifyFeatures(osmData?.features || [], { lat: harbor.lat, lon: harbor.lon });
  ctx.street = { roads: cls.roads, areas: cls.areas, rails: cls.rails, pois: cls.pois, places: cls.places, hasStreets: osm.osmHasStreets(osmData) };
  for (const f of cls.landuse) fillRings(ctx, [ringLLToCells(ctx, f.pts)], mask, LAND, { allow: ALLOW_WATER });
  for (const f of cls.water || []) fillRings(ctx, [ringLLToCells(ctx, f.pts)], mask, WATER, { allow: ALLOW_LAND });
  for (const f of cls.marinas) fillRings(ctx, [ringLLToCells(ctx, f.pts)], mask, WATER, { allow: ALLOW_LAND });
  for (const f of cls.docks) { const r = [ringLLToCells(ctx, f.pts)]; fillRings(ctx, r, mask, FAIRWAY, { allow: ALLOW_WATER_OR_LAND }); fillRings(ctx, r, ctx.dredge, 10, { max: true }); }
  removeSpecks(mask, n, LAND, WATER, 4);
  const toXZ = (pts) => pts.map((p) => ctx.frame.toXZ(p[0], p[1]));
  const addFaces = (ringXZ, closed, kind, side) => {
    const m = ringXZ.length;
    for (let i = 0; i + (closed ? 0 : 1) < m; i++) {
      const a = ringXZ[i], b = ringXZ[(i + 1) % m];
      ctx.faces.push({ ax: a[0], az: a[1], bx: b[0], bz: b[1], kind, side });
    }
  };
  const structure = (list, code, kind, featKey, defaultW) => {
    for (const f of list) {
      const ptsXZ = toXZ(f.pts);
      if (f.closed) {
        fillRings(ctx, [ringXZToCells(ctx, ptsXZ)], mask, code, code === PONTOON ? { allow: ALLOW_WATER_OR_LAND } : undefined);
        ctx.features[featKey].push({ pts: osm.simplifyRing(f.pts, 3) });
        if (kind) addFaces(ptsXZ, true, kind, null);
      } else {
        const wdt = Math.max(defaultW, f.width || 0);
        const halfW = Math.max(6, wdt / 2);
        let shift = 0;
        if (code === QUAY) { const s = landSide(ctx, ptsXZ, halfW + 8); shift = s * halfW; }
        const ring = stripRing(ctx, ptsXZ, halfW, shift);
        if (ring.length < 3) continue;
        fillRings(ctx, [ringXZToCells(ctx, ring)], mask, code, code === PONTOON ? { allow: ALLOW_WATER_OR_LAND } : undefined);
        ctx.features[featKey].push({ pts: osm.simplifyRing(ring.map((p) => xzToLL(ctx, p[0], p[1])), 3) });
        if (kind) {
          if (code === QUAY && shift !== 0) addFaces(ptsXZ, false, kind, null);
          else addFaces(ring, true, kind, null);
        }
      }
    }
  };
  structure(cls.quays, QUAY, 'quay', 'quays', 10);
  structure(cls.piers, QUAY, 'quay', 'piers', 6);
  structure(cls.breakwaters, BREAKWATER, null, 'breakwaters', 14);
  structure(cls.pontoons, PONTOON, 'pontoon', 'pontoons', 4);
  // vector-only features
  for (const b of cls.buildings) ctx.features.buildings.push({ pts: osm.simplifyRing(b.pts, 3), height: b.height, kind: b.kind });
  for (const t of cls.tanks) ctx.features.tanks.push({ lat: t.lat, lon: t.lon, radius: t.radius, height: t.height });
  for (const l of cls.lights) ctx.features.lights.push(l);
  for (const b of cls.buoys) ctx.features.buoys.push({ lat: b.lat, lon: b.lon, kind: b.kind, color: b.color, color2: b.color2, shape: b.shape });
  ctx.osmCranes = cls.cranes;
  ctx.anchorPref = [0, 0];
  ctx.synthBuoys = ctx.features.buoys.length < 2;
  const S = SIZES[harbor.size] || SIZES.regional;
  ctx.fairwayHalf = S.fairHalf; ctx.fairwayDepth = S.fairDepth;
  ctx.rnd = rnd;
  return finishBuild(ctx, w);
}

// ---------------------------------------------------------------------------------------------------------------
// Common finishing: shallows, distances, heights, anchor, fairway, berths (with the ≥ 2 big berths guarantee),
// cranes, buoys, JSON + typed arrays
// ---------------------------------------------------------------------------------------------------------------
function findAnchor(ctx, pref) {
  const { n, mask, sdf, hFloat } = ctx;
  const px = pref ? pref[0] : 0, pz = pref ? pref[1] : 0;
  const k0 = idxOfXZ(ctx, px, pz);
  if (k0 >= 0 && IS_WATER[mask[k0]] && mask[k0] !== SHALLOW && sdf[k0] >= 45 && hFloat[k0] <= -5) return [px, pz];
  let best = -1, bs = Infinity, fallback = -1, fs = -Infinity;
  for (let k = 0; k < n * n; k++) {
    const m = mask[k];
    if (!IS_WATER[m]) continue;
    if (sdf[k] > fs) { fs = sdf[k]; fallback = k; }
    if (sdf[k] < 45) continue;
    const [x, z] = xzOfIdx(ctx, k);
    const dx = x - px, dz = z - pz;
    const score = dx * dx + dz * dz + (m === SHALLOW ? 4e6 : 0) + (hFloat[k] > -5 ? 1e6 : 0) + (sdf[k] < 70 ? 2e4 : 0);
    if (score < bs) { bs = score; best = k; }
  }
  if (best < 0) best = fallback;
  return best >= 0 ? xzOfIdx(ctx, best) : [px, pz];
}

/** Dijkstra over a 4× coarse grid from `start` (local metres) to the patch border, preferring wide water. */
function fairwayPath(ctx, start, w) {
  const { n, res, mask, sdf } = ctx;
  const S = 4, m = n / S;
  const pass = new Uint8Array(m * m), score = new Float32Array(m * m);
  for (let J = 0; J < m; J++) for (let I = 0; I < m; I++) {
    const k = (J * S + S / 2) * n + I * S + S / 2;
    const q = J * m + I;
    pass[q] = IS_WATER[mask[k]] && mask[k] !== SHALLOW && sdf[k] >= 12 ? 1 : 0;
    score[q] = sdf[k];
  }
  const coarseOf = (x, z) => [clamp(Math.floor((x / res + n / 2) / S), 0, m - 1), clamp(Math.floor((z / res + n / 2) / S), 0, m - 1)];
  let [I0, J0] = coarseOf(start[0], start[1]);
  if (!pass[J0 * m + I0]) {   // nearest passable node
    let bd = Infinity;
    for (let J = 0; J < m; J++) for (let I = 0; I < m; I++) if (pass[J * m + I]) { const d = (I - I0) ** 2 + (J - J0) ** 2; if (d < bd) { bd = d; var bI = I, bJ = J; } }
    if (!Number.isFinite(bd)) return null;
    I0 = bI; J0 = bJ;
  }
  const dist = new Float64Array(m * m).fill(Infinity), prev = new Int32Array(m * m).fill(-1), done = new Uint8Array(m * m);
  const heap = []; // simple binary heap of [cost, idx]
  const push = (c, i) => { heap.push([c, i]); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let s = k; if (l < heap.length && heap[l][0] < heap[s][0]) s = l; if (r < heap.length && heap[r][0] < heap[s][0]) s = r; if (s === k) break; [heap[s], heap[k]] = [heap[k], heap[s]]; k = s; } } return top; };
  const s0 = J0 * m + I0; dist[s0] = 0; push(0, s0);
  const stepM = S * res;
  while (heap.length) {
    const [c, q] = pop();
    if (done[q]) continue; done[q] = 1;
    const I = q % m, J = (q - I) / m;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const I2 = I + di, J2 = J + dj;
      if (I2 < 0 || J2 < 0 || I2 >= m || J2 >= m) continue;
      const q2 = J2 * m + I2;
      if (!pass[q2] || done[q2]) continue;
      const len = stepM * (di && dj ? Math.SQRT2 : 1);
      const nc = c + len * (1 + 250 / Math.max(8, score[q2]));
      if (nc < dist[q2]) { dist[q2] = nc; prev[q2] = q; push(nc, q2); }
    }
  }
  // best border node (reachable); prefer deep world water
  let best = -1, bc = Infinity;
  for (let q = 0; q < m * m; q++) {
    const I = q % m, J = (q - I) / m;
    if (I !== 0 && J !== 0 && I !== m - 1 && J !== m - 1) continue;
    if (!Number.isFinite(dist[q])) continue;
    let c = dist[q];
    if (w) { const ll = ctx.frame.toLL((I * S + S / 2 - n / 2) * res, (J * S + S / 2 - n / 2) * res); const d = -w.heightAt(ll[0], ll[1]); if (d < 10) c *= 1.6; if (d < 0) c *= 3; }
    if (c < bc) { bc = c; best = q; }
  }
  if (best < 0) {   // enclosed: head for the farthest reachable node
    let fd = -1; for (let q = 0; q < m * m; q++) if (Number.isFinite(dist[q])) { const I = q % m, J = (q - I) / m; const d = (I - I0) ** 2 + (J - J0) ** 2; if (d > fd) { fd = d; best = q; } }
    if (best < 0) return null;
  }
  const path = [];
  for (let q = best; q >= 0; q = prev[q]) { const I = q % m, J = (q - I) / m; path.push([(I * S + S / 2 - n / 2) * res, (J * S + S / 2 - n / 2) * res]); }
  path.reverse();
  path[0] = [start[0], start[1]];
  return rdp(path, 25);
}
function rdp(pts, tol) {
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0], pts[pts.length - 1]];
  let maxD = -1, idx = -1;
  const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1;
  for (let i = 1; i < pts.length - 1; i++) { const d = Math.abs((pts[i][0] - a[0]) * dz - (pts[i][1] - a[1]) * dx) / L; if (d > maxD) { maxD = d; idx = i; } }
  if (maxD > tol) return rdp(pts.slice(0, idx + 1), tol).slice(0, -1).concat(rdp(pts.slice(idx), tol));
  return [a, b];
}

/** Straight mooring faces → berth candidates (centre 12 m off the face on the water side), validated against the mask. */
function berthsFromFaces(ctx, faces) {
  const out = [];
  const test = (x, z) => { const m = maskAtXZ(ctx, x, z); return m >= 0 && IS_WATER[m]; };
  const isObst = (x, z) => { const m = maskAtXZ(ctx, x, z); return m >= 0 && IS_OBSTACLE[m]; };
  for (const f of faces) {
    const dx = f.bx - f.ax, dz = f.bz - f.az, L = Math.hypot(dx, dz);
    const minLen = f.kind === 'pontoon' ? 15 : 40;
    if (L < minLen) continue;
    const tx = dx / L, tz = dz / L, lx = tz, lz = -tx;    // left normal
    const sides = f.side ? [f.side] : [[lx, lz], [-lx, -lz]];
    for (const [sx, sz] of sides) {
      let water = 0;
      for (const s of [0.25, 0.5, 0.75]) { if (test(f.ax + tx * L * s + sx * 12, f.az + tz * L * s + sz * 12)) water++; }
      if (water < 2) continue;
      if (!isObst(f.ax + tx * L * 0.5 - sx * 6, f.az + tz * L * 0.5 - sz * 6) && !isObst(f.ax + tx * L * 0.5 - sx * 12, f.az + tz * L * 0.5 - sz * 12)) continue;
      const pieces = f.kind === 'pontoon' ? 1 : Math.max(1, Math.round(L / 320));
      const len = L / pieces;
      for (let p = 0; p < pieces; p++) {
        const s0 = len * (p + 0.5);
        const x = f.ax + tx * s0 + sx * 12, z = f.az + tz * s0 + sz * 12;
        if (!inPatch(ctx, x, z) || !test(x, z)) continue;
        out.push({ x, z, hdg: Math.round(bearingOf(tx, tz)), length: Math.round(len), kind: f.kind, sx, sz, tx, tz, s0, face: f });
      }
    }
  }
  return out;
}
/** Axis-aligned runs of quay cells with water alongside (contract: "mask 2 adjacent to water"). */
function facesFromRaster(ctx) {
  const { n, res, mask } = ctx;
  const faces = [];
  const water = (k) => IS_WATER[mask[k]];
  for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const alongJ = di !== 0;   // run runs along j when the water is to the east/west
    for (let a = 0; a < n; a++) {
      let run = 0, start = 0;
      const flush = (end) => {
        if (run * res >= 60) {
          const sx = di, sz = dj;
          let ax, az, bx, bz;
          if (alongJ) { const xf = (a + (di > 0 ? 1 : 0) - n / 2) * res; ax = xf; bx = xf; az = (start - n / 2) * res; bz = (end - n / 2) * res; }
          else { const zf = (a + (dj > 0 ? 1 : 0) - n / 2) * res; az = zf; bz = zf; ax = (start - n / 2) * res; bx = (end - n / 2) * res; }
          faces.push({ ax, az, bx, bz, kind: 'quay', side: [sx, sz] });
        }
        run = 0;
      };
      for (let b = 0; b < n; b++) {
        const i = alongJ ? a : b, j = alongJ ? b : a;
        const k = j * n + i, i2 = i + di, j2 = j + dj;
        const ok = mask[k] === QUAY && i2 >= 0 && j2 >= 0 && i2 < n && j2 < n && water(j2 * n + i2);
        if (ok) { if (!run) start = b; run++; } else if (run) flush(b);
      }
      if (run) flush(n);
    }
  }
  return faces;
}
function generateBerths(ctx) {
  let cand = berthsFromFaces(ctx, ctx.faces).concat(berthsFromFaces(ctx, facesFromRaster(ctx)));
  for (const b of cand) b.depth = round1(-heightAtXZ(ctx, b.x, b.z));
  cand = cand.filter((b) => b.depth >= (b.kind === 'pontoon' ? 0.5 : 1.5));
  cand.sort((a, b) => b.length - a.length);
  const kept = [];
  for (const b of cand) {
    if (kept.some((k) => (k.x - b.x) ** 2 + (k.z - b.z) ** 2 < 20 * 20)) continue;
    kept.push(b);
  }
  const big = (b) => b.kind === 'quay' && b.length >= 120 && b.depth >= 8;
  kept.sort((a, b) => (big(b) - big(a)) || (b.length - a.length) || (b.depth - a.depth));
  return kept.slice(0, 30);
}
/** Dredge a 50 m band in front of a berth's face to `depth`. */
function dredgeBerth(ctx, b, depth) {
  const L = b.length;
  const cx = b.x + b.sx * 18, cz = b.z + b.sz * 18;
  fillRectXZ(ctx, rectXZ(cx, cz, b.tx, b.tz, L / 2 + 5, 32), ctx.dredge, depth, { max: true, allow: ALLOW_WATER });
  // and the mask: shallows in the band become water
  fillRectXZ(ctx, rectXZ(cx, cz, b.tx, b.tz, L / 2 + 5, 32), ctx.mask, WATER, { allow: new Uint8Array([0, 0, 0, 0, 0, 0, 1]) });
}
/** Last resort for the ≥ 2 big berths guarantee: a straight finger pier in open water near the anchor. */
function emergencyPier(ctx, anchor) {
  const sdf = ctx.sdf;
  // direction with the most room
  let bestD = -1, bx = 1, bz = 0;
  for (let b = 0; b < 360; b += 30) {
    const dx = Math.sin(b * D2R), dz = -Math.cos(b * D2R);
    const r = marchUntil(ctx, anchor[0], anchor[1], dx, dz, 600, (m) => !IS_WATER[m], 20);
    const d = r < 0 ? 600 : r;
    if (d > bestD) { bestD = d; bx = dx; bz = dz; }
  }
  void sdf;
  const cx = anchor[0] + bx * 150, cz = anchor[1] + bz * 150;
  const tx = -bz, tz = bx;
  const rect = rectXZ(cx, cz, tx, tz, 165, 15);
  fillRectXZ(ctx, rect, ctx.mask, QUAY);
  fillRectXZ(ctx, rectXZ(cx, cz, tx, tz, 175, 60), ctx.dredge, 9, { max: true, allow: ALLOW_WATER });
  ctx.features.piers.push({ pts: rect.map((p) => xzToLL(ctx, p[0], p[1])) });
  const a = [cx - tx * 165, cz - tz * 165], b = [cx + tx * 165, cz + tz * 165];
  ctx.faces.push({ ax: a[0] + (-tz) * 15, az: a[1] + tx * 15, bx: b[0] + (-tz) * 15, bz: b[1] + tx * 15, kind: 'quay', side: [-tz, tx] });
  ctx.faces.push({ ax: a[0] - (-tz) * 15, az: a[1] - tx * 15, bx: b[0] - (-tz) * 15, bz: b[1] - tx * 15, kind: 'quay', side: [tz, -tx] });
}

// ---------------------------------------------------------------------------------------------------------------
// Street layer (v0.4, docs/V4-CONTRACTS.md §3): roads, areas, rails, the six game POIs with doors on land, and
// decorative street signs. OSM data is used when the payload has it (query schema ≥ 2); otherwise — synthetic harbours
// and old OSM caches — a road network is generated on the raster: quay roads behind the berths, links between them,
// a grid of streets behind the warehouses and connector roads (Dijkstra over the land cells, buildings blocked) to
// the patch edge. Everything runs in the local metre frame and is emitted in lat/lon.
// ---------------------------------------------------------------------------------------------------------------
const WALK = new Uint8Array([0, 1, 1, 0, 1, 0, 0]);         // LAND, QUAY, PONTOON are walkable; breakwaters are rubble
const STREET_GRID_M = 50;
const POI_ORDER = ['harbourmaster', 'market', 'shipyard', 'chandler', 'bar', 'fuel', 'police', 'cafe'];
const REQUIRED_POIS = ['harbourmaster', 'shipyard', 'chandler', 'fuel', 'market', 'bar'];
const BAR_NAMES = ['The Anchor', 'The Salty Dog', "The Mariner's Rest", 'The Lantern', 'The Rusty Hook', 'The Old Bollard', 'The Fog Bell', 'The Bosun', 'The Tide Inn', 'The Crow\'s Nest', 'The Harbour Light', 'The Last Ferry'];
const CAFE_NAMES = ['Quayside Café', 'Harbour Café', 'The Galley', 'Dock Coffee', 'The Tea Shed'];

/** Binary min-heap on typed arrays (Dijkstra over ~200 k cells without per-push allocations). */
class MinHeap {
  constructor(cap = 4096) { this.k = new Float64Array(cap); this.v = new Int32Array(cap); this.n = 0; this.topKey = 0; }
  push(key, val) {
    if (this.n === this.k.length) { const k2 = new Float64Array(this.n * 2), v2 = new Int32Array(this.n * 2); k2.set(this.k); v2.set(this.v); this.k = k2; this.v = v2; }
    let i = this.n++;
    while (i > 0) { const p = (i - 1) >> 1; if (this.k[p] <= key) break; this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p; }
    this.k[i] = key; this.v[i] = val;
  }
  pop() {
    const top = this.v[0]; this.topKey = this.k[0];
    const n = --this.n;
    if (n > 0) {
      const key = this.k[n], val = this.v[n];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1; if (l >= n) break;
        const r = l + 1, c = r < n && this.k[r] < this.k[l] ? r : l;
        if (this.k[c] >= key) break;
        this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c;
      }
      this.k[i] = key; this.v[i] = val;
    }
    return top;
  }
}

function pointInRingXZ(x, z, ring) {
  let inside = false;
  for (let i = 0, m = ring.length, j = m - 1; i < m; j = i++) {
    const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function segDist2(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
  let t = L2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / L2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t - px, qz = az + dz * t - pz;
  return qx * qx + qz * qz;
}
function ringAreaXZ(ring) { let a = 0; for (let i = 0, m = ring.length; i < m; i++) { const p = ring[i], q = ring[(i + 1) % m]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; }
function polyLenXZ(pts) { let s = 0; for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return s; }

/** Clip an open polyline (local metres) to the square |x|,|z| ≤ h; returns the pieces inside. */
function clipPolylineXZ(pts, h) {
  const out = []; let cur = null;
  const inside = (p) => p[0] >= -h && p[0] <= h && p[1] >= -h && p[1] <= h;
  const clipSeg = (a, b) => {
    let t0 = 0, t1 = 1; const dx = b[0] - a[0], dz = b[1] - a[1];
    for (const [p, q] of [[-dx, a[0] + h], [dx, h - a[0]], [-dz, a[1] + h], [dz, h - a[1]]]) {
      if (p === 0) { if (q < 0) return null; continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
    }
    return t0 <= t1 ? [t0, t1] : null;
  };
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const t = clipSeg(a, b);
    if (!t) { if (cur) { out.push(cur); cur = null; } continue; }
    const p0 = [a[0] + (b[0] - a[0]) * t[0], a[1] + (b[1] - a[1]) * t[0]], p1 = [a[0] + (b[0] - a[0]) * t[1], a[1] + (b[1] - a[1]) * t[1]];
    if (!cur) cur = [p0];
    cur.push(p1);
    if (!inside(b)) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out.filter((p) => p.length >= 2);
}
/** Sutherland–Hodgman clip of a ring (local metres) against the square |x|,|z| ≤ h. */
function clipRingXZ(ring, h) {
  let poly = ring;
  const planes = [[(p) => p[0] >= -h, (a, b) => { const t = (-h - a[0]) / (b[0] - a[0]); return [-h, a[1] + (b[1] - a[1]) * t]; }],
    [(p) => p[0] <= h, (a, b) => { const t = (h - a[0]) / (b[0] - a[0]); return [h, a[1] + (b[1] - a[1]) * t]; }],
    [(p) => p[1] >= -h, (a, b) => { const t = (-h - a[1]) / (b[1] - a[1]); return [a[0] + (b[0] - a[0]) * t, -h]; }],
    [(p) => p[1] <= h, (a, b) => { const t = (h - a[1]) / (b[1] - a[1]); return [a[0] + (b[0] - a[0]) * t, h]; }]];
  for (const [ins, cut] of planes) {
    if (poly.length < 3) return [];
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const ia = ins(a), ib = ins(b);
      if (ia) out.push(a);
      if (ia !== ib) out.push(cut(a, b));
    }
    poly = out;
  }
  return poly;
}
/** Points every `step` metres along a polyline (ends included), each with the unit left normal of its segment. */
function resampleXZ(pts, step) {
  const out = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
    if (L < 1e-6) continue;
    const nx = dz / L, nz = -dx / L;
    const k = Math.max(1, Math.ceil(L / step));
    for (let s = i === 0 ? 0 : 1; s <= k; s++) out.push([a[0] + (dx * s) / k, a[1] + (dz * s) / k, nx, nz]);
  }
  return out;
}

/** Spatial index of building footprints / tanks / roads plus the walkable-cell queries the street builder needs. */
function streetIndex(ctx) {
  const { n, half } = ctx;
  const gN = Math.ceil((2 * half) / STREET_GRID_M);
  const S = { ctx, gN, blds: [], bGrid: new Array(gN * gN), bmask: new Uint8Array(n * n), tanks: [], roads: [], segGrid: new Array(gN * gN), mark: new Int32Array(64), qid: 0, comp: null };
  for (let i = 0; i < gN * gN; i++) { S.bGrid[i] = []; S.segGrid[i] = []; }
  ctx.features.buildings.forEach((b, idx) => addBuildingXZ(S, idx, b.pts.map((p) => ctx.frame.toXZ(p[0], p[1])), b));
  for (const t of ctx.features.tanks) { const [x, z] = ctx.frame.toXZ(t.lat, t.lon); S.tanks.push({ x, z, r: t.radius || 10 }); fillRings(ctx, [ringXZToCells(ctx, rectXZ(x, z, 1, 0, t.radius || 10, t.radius || 10))], S.bmask, 1); }
  return S;
}
const gCell = (S, v) => clamp(Math.floor((v + S.ctx.half) / STREET_GRID_M), 0, S.gN - 1);
function addBuildingXZ(S, idx, ring, meta) {
  if (!ring || ring.length < 3) { S.blds[idx] = null; return; }
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, cx = 0, cz = 0;
  for (const p of ring) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); cx += p[0]; cz += p[1]; }
  const b = { idx, ring, x0, x1, z0, z1, cx: cx / ring.length, cz: cz / ring.length, area: Math.abs(ringAreaXZ(ring)), kind: meta?.kind || 'building', height: meta?.height || 8 };
  S.blds[idx] = b;
  if (S.mark.length <= idx) { const m2 = new Int32Array(Math.max(idx + 1, S.mark.length * 2)); m2.set(S.mark); S.mark = m2; }
  for (let j = gCell(S, z0); j <= gCell(S, z1); j++) for (let i = gCell(S, x0); i <= gCell(S, x1); i++) S.bGrid[j * S.gN + i].push(b);
  fillRings(S.ctx, [ringXZToCells(S.ctx, ring)], S.bmask, 1);
}
/** Inside a building footprint / tank, or closer than `margin` metres to one. `skip` = a building index to ignore. */
function nearBuilding(S, x, z, margin = 0, skip = -1) {
  const q = ++S.qid, m2 = margin * margin;
  for (let j = gCell(S, z - margin); j <= gCell(S, z + margin); j++) for (let i = gCell(S, x - margin); i <= gCell(S, x + margin); i++) {
    for (const b of S.bGrid[j * S.gN + i]) {
      if (S.mark[b.idx] === q) continue; S.mark[b.idx] = q;
      if (b.idx === skip || x < b.x0 - margin || x > b.x1 + margin || z < b.z0 - margin || z > b.z1 + margin) continue;
      if (pointInRingXZ(x, z, b.ring)) return true;
      if (margin > 0) { const r = b.ring; for (let k = 0, m = r.length; k < m; k++) { const a = r[k], c = r[(k + 1) % m]; if (segDist2(x, z, a[0], a[1], c[0], c[1]) < m2) return true; } }
    }
  }
  for (const t of S.tanks) { const d = Math.hypot(x - t.x, z - t.z); if (d < t.r + margin) return true; }
  return false;
}
function isWalkXZ(S, x, z) { const c = S.ctx; if (x < -c.half + 3 || x > c.half - 3 || z < -c.half + 3 || z > c.half - 3) return false; const k = idxOfXZ(c, x, z); return k >= 0 && WALK[c.mask[k]] === 1; }
function freeXZ(S, x, z, margin = 0, skip = -1) { return isWalkXZ(S, x, z) && !nearBuilding(S, x, z, margin, skip); }
function addRoadXZ(S, road) {
  if (!road.pts || road.pts.length < 2) return;
  const ri = S.roads.length; S.roads.push(road);
  const hw = road.width / 2;
  for (let s = 0; s + 1 < road.pts.length; s++) {
    const a = road.pts[s], b = road.pts[s + 1];
    for (let j = gCell(S, Math.min(a[1], b[1]) - hw); j <= gCell(S, Math.max(a[1], b[1]) + hw); j++) for (let i = gCell(S, Math.min(a[0], b[0]) - hw); i <= gCell(S, Math.max(a[0], b[0]) + hw); i++) S.segGrid[j * S.gN + i].push(ri, s);
  }
}
/** Distance (m) from a point to the nearest road EDGE (≤ 0 = on the carriageway), searching up to maxR metres. */
function roadEdgeDist(S, x, z, maxR = 250) {
  let best = Infinity;
  const gi = gCell(S, x), gj = gCell(S, z), R = Math.ceil(maxR / STREET_GRID_M);
  for (let r = 0; r <= R; r++) {
    for (let j = gj - r; j <= gj + r; j++) for (let i = gi - r; i <= gi + r; i++) {
      if (i < 0 || j < 0 || i >= S.gN || j >= S.gN || (Math.abs(i - gi) !== r && Math.abs(j - gj) !== r)) continue;
      const L = S.segGrid[j * S.gN + i];
      for (let k = 0; k < L.length; k += 2) {
        const road = S.roads[L[k]], a = road.pts[L[k + 1]], b = road.pts[L[k + 1] + 1];
        const d = Math.sqrt(segDist2(x, z, a[0], a[1], b[0], b[1])) - road.width / 2;
        if (d < best) best = d;
      }
    }
    if (best < r * STREET_GRID_M) break;
  }
  return best;
}

/**
 * Keep the parts of a candidate road (local metres) that run over walkable land, clear of buildings by `margin`
 * beyond the half width; pieces shorter than minLen are dropped. Returns polylines.
 */
function carveXZ(S, pts, halfW, { minLen = 30, margin = 1, step = 3, sides = true, avoidRoads = false } = {}) {
  const smp = resampleXZ(pts, step);
  const ok = smp.map(([x, z, nx, nz]) => freeXZ(S, x, z, halfW + margin)
    && (!sides || (isWalkXZ(S, x + nx * halfW, z + nz * halfW) && isWalkXZ(S, x - nx * halfW, z - nz * halfW)))
    && (!avoidRoads || roadEdgeDist(S, x, z, 60) > halfW + 2));
  const out = [];
  let run = [];
  const flush = () => { if (run.length >= 2 && polyLenXZ(run) >= minLen) out.push(rdp(run, 0.5)); run = []; };
  for (let i = 0; i < smp.length; i++) { if (ok[i]) run.push([smp[i][0], smp[i][1]]); else flush(); }
  flush();
  return out;
}

/** Land Dijkstra from target cells (multi-source); returns {dist, next} for tracing a path from any cell to a target. */
function landDijkstra(S, targets) {
  const { n, mask } = S.ctx, N = n * n;
  const dist = new Float32Array(N).fill(Infinity), next = new Int32Array(N).fill(-1);
  const pass = (k) => WALK[mask[k]] === 1 && S.bmask[k] === 0;
  const pen = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    if (!pass(k)) continue;
    const i = k % n, j = (k - i) / n;
    let p = mask[k] === QUAY ? 1 : mask[k] === PONTOON ? 12 : 0;
    if (i > 0 && i < n - 1 && j > 0 && j < n - 1 && (S.bmask[k - 1] || S.bmask[k + 1] || S.bmask[k - n] || S.bmask[k + n])) p += 6;
    if (i > 0 && i < n - 1 && j > 0 && j < n - 1 && (!WALK[mask[k - 1]] || !WALK[mask[k + 1]] || !WALK[mask[k - n]] || !WALK[mask[k + n]])) p += 8;   // keep off the water's edge
    pen[k] = p;
  }
  const heap = new MinHeap(targets.length + 1024);
  for (const k of targets) if (pass(k)) { dist[k] = 0; heap.push(0, k); }
  while (heap.n) {
    const k = heap.pop(), d = heap.topKey;
    if (d > dist[k]) continue;
    const i = k % n, j = (k - i) / n;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const i2 = i + di, j2 = j + dj;
      if (i2 < 0 || j2 < 0 || i2 >= n || j2 >= n) continue;
      const k2 = j2 * n + i2;
      if (!pass(k2)) continue;
      if (di && dj && (!pass(j * n + i2) || !pass(j2 * n + i))) continue;   // no corner cutting
      const nd = d + (di && dj ? 14 : 10) + pen[k2];
      if (nd < dist[k2]) { dist[k2] = nd; next[k2] = k; heap.push(nd, k2); }
    }
  }
  return { dist, next };
}
/** Follow `next` from the cell nearest (x, z) to a target or to a cell another path already used. */
function tracePath(S, D, x, z, used) {
  const { n } = S.ctx;
  let k0 = idxOfXZ(S.ctx, x, z);
  if (k0 < 0) return null;
  if (!Number.isFinite(D.dist[k0])) {
    let best = -1, bd = Infinity;
    const i0 = k0 % n, j0 = (k0 - i0) / n;
    for (let dj = -4; dj <= 4; dj++) for (let di = -4; di <= 4; di++) {
      const i = i0 + di, j = j0 + dj; if (i < 0 || j < 0 || i >= n || j >= n) continue;
      const k = j * n + i; if (Number.isFinite(D.dist[k]) && di * di + dj * dj < bd) { bd = di * di + dj * dj; best = k; }
    }
    if (best < 0) return null;
    k0 = best;
  }
  const cells = [];
  for (let k = k0, guard = 0; k >= 0 && guard < n * 4; k = D.next[k], guard++) {
    cells.push(k);
    if (used[k] && cells.length > 1) break;
  }
  for (const k of cells) used[k] = 1;
  return cells.map((k) => xzOfIdx(S.ctx, k));
}

/** Quay road candidates behind the quay berths: the first offset (26–85 m behind the face) that is mostly clear. */
function quayRoadLines(S, berths, maxBerths = 24) {
  const lines = [];
  for (const b of berths.filter((q) => q.kind === 'quay').slice(0, maxBerths)) {
    const Fx = b.x - b.sx * 12, Fz = b.z - b.sz * 12, Lx = -b.sx, Lz = -b.sz, ext = b.length / 2 + 25;
    for (const o of [24, 33, 40, 48, 58, 70, 85]) {
      let good = 0, tot = 0;
      for (let s = -ext; s <= ext; s += 5) { tot++; if (freeXZ(S, Fx + Lx * o + b.tx * s, Fz + Lz * o + b.tz * s, 5)) good++; }
      // the carriageway must not straddle the back edge of the quay apron (quay ↔ land): kerbs and bollards stand there
      let same = 0;
      for (const s of [-b.length / 3, 0, b.length / 3]) { const m0 = maskAtXZ(S.ctx, Fx + Lx * (o - 5.5) + b.tx * s, Fz + Lz * (o - 5.5) + b.tz * s), m1 = maskAtXZ(S.ctx, Fx + Lx * (o + 5.5) + b.tx * s, Fz + Lz * (o + 5.5) + b.tz * s); if (m0 === m1) same++; }
      if (same < 2) continue;
      if (good / tot >= 0.7) { lines.push({ ax: Fx + Lx * o - b.tx * ext, az: Fz + Lz * o - b.tz * ext, bx: Fx + Lx * o + b.tx * ext, bz: Fz + Lz * o + b.tz * ext, tx: b.tx, tz: b.tz, o, berth: b }); break; }
    }
  }
  // merge collinear overlapping lines (long faces are split into several berths)
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    const A = lines[i], B = lines[j];
    if (!A || !B || Math.abs(A.tx * B.tx + A.tz * B.tz) < 0.995) continue;
    const perp = Math.abs((B.ax - A.ax) * -A.tz + (B.az - A.az) * A.tx);
    if (perp > 4) continue;
    const proj = (x, z) => (x - A.ax) * A.tx + (z - A.az) * A.tz;
    const a0 = 0, a1 = proj(A.bx, A.bz), b0 = Math.min(proj(B.ax, B.az), proj(B.bx, B.bz)), b1 = Math.max(proj(B.ax, B.az), proj(B.bx, B.bz));
    if (b0 > a1 + 30 || b1 < a0 - 30) continue;
    const s0 = Math.min(a0, b0), s1 = Math.max(a1, b1), ox = A.ax, oz = A.az;
    A.ax = ox + A.tx * s0; A.az = oz + A.tz * s0; A.bx = ox + A.tx * s1; A.bz = oz + A.tz * s1;
    lines[j] = null;
  }
  return lines.filter(Boolean);
}

/** Generated road network (synthetic harbours, OSM payloads without streets, or OSM streets missing at the quays). */
function synthesizeRoads(S, berths, { grid = true, connectToExisting = false, rails = false } = {}) {
  const ctx = S.ctx, rails_out = [];
  const firstNew = S.roads.length;
  // 1. quay roads
  const qLines = quayRoadLines(S, berths, connectToExisting ? 3 : 24);
  const quayPieces = [];
  for (const L of qLines) {
    for (const pts of carveXZ(S, [[L.ax, L.az], [L.bx, L.bz]], 4, { minLen: 40, margin: 1 })) {
      const road = { pts, kind: 'service', width: 8, name: 'Quay road', synth: true };
      addRoadXZ(S, road); quayPieces.push({ road, line: L });
    }
  }
  // 2. links between neighbouring quay roads (stepped quays, dock sides)
  for (let i = 0; i < quayPieces.length; i++) for (let j = i + 1; j < quayPieces.length; j++) {
    const A = quayPieces[i].road.pts, B = quayPieces[j].road.pts;
    let best = null, bd = Infinity;
    for (const p of [A[0], A[A.length - 1]]) for (const q of [B[0], B[B.length - 1]]) { const d = Math.hypot(p[0] - q[0], p[1] - q[1]); if (d < bd) { bd = d; best = [p, q]; } }
    if (!best || bd < 4 || bd > 90) continue;
    const pieces = carveXZ(S, best, 3, { minLen: 2, margin: 0.5, step: 2 });
    if (pieces.length === 1 && polyLenXZ(pieces[0]) >= bd * 0.85) addRoadXZ(S, { pts: best, kind: 'service', width: 6, name: '', synth: true });
  }
  // 3. a grid of streets behind the warehouses, aligned with the main quay
  const main = qLines[0];
  if (grid && main) {
    const b = main.berth, tx = main.tx, tz = main.tz, Lx = -b.sx, Lz = -b.sz;
    const Fx = (main.ax + main.bx) / 2 - Lx * main.o, Fz = (main.az + main.bz) / 2 - Lz * main.o;
    const P = (u, v) => [Fx + tx * u + Lx * v, Fz + tz * u + Lz * v];
    const frac = (pts) => { const s = resampleXZ(pts, 10); let g = 0; for (const [x, z] of s) if (freeXZ(S, x, z, 4)) g++; return s.length ? g / s.length : 0; };
    [110, 200, 290, 380].forEach((target, k) => {
      let bestO = target, bf = -1;
      for (let o = target - 25; o <= target + 25; o += 5) { const f = frac([P(-650, o), P(650, o)]); if (f > bf) { bf = f; bestO = o; } }
      if (bf < 0.2) return;
      const w = k === 0 ? 7.5 : 6.5;
      for (const pts of carveXZ(S, [P(-650, bestO), P(650, bestO)], w / 2, { minLen: 50, margin: 1.5, avoidRoads: false })) addRoadXZ(S, { pts, kind: k === 0 ? 'tertiary' : 'residential', width: w, name: '', synth: true });
    });
    for (const u0 of [-520, -390, -260, -130, 0, 130, 260, 390, 520]) {
      let bestU = u0, bf = -1;
      for (let u = u0 - 30; u <= u0 + 30; u += 5) { const f = frac([P(u, main.o), P(u, 420)]); if (f > bf) { bf = f; bestU = u; } }
      if (bf < 0.25) continue;
      for (const pts of carveXZ(S, [P(bestU, main.o), P(bestU, 420)], 3.25, { minLen: 50, margin: 1.5 })) addRoadXZ(S, { pts, kind: 'residential', width: 6.5, name: '', synth: true });
    }
    // 4. a rail spur along the main quay (major ports)
    // (on the apron 24 m behind the face: clear of the crane legs, in front of the quay road)
    if (rails) { const k = 24 - main.o; for (const pts of carveXZ(S, [[main.ax + Lx * k, main.az + Lz * k], [main.bx + Lx * k, main.bz + Lz * k]], 2, { minLen: 60, margin: 1, avoidRoads: true })) rails_out.push({ pts }); }
  }
  // 5. connector roads to the patch edge (and to the existing network): Dijkstra from the targets over land
  const { n } = ctx;
  const targets = [];
  for (let a = 0; a < n; a++) for (const k of [a, (n - 1) * n + a, a * n, a * n + n - 1]) if (WALK[ctx.mask[k]] && !S.bmask[k]) targets.push(k);
  if (connectToExisting) {
    const seen = new Uint8Array(n * n);
    for (let r = 0; r < firstNew; r++) for (const [x, z] of resampleXZ(S.roads[r].pts, 5)) { const k = idxOfXZ(ctx, x, z); if (k >= 0 && !seen[k]) { seen[k] = 1; targets.push(k); } }
  }
  if (targets.length) {
    const D = landDijkstra(S, targets);
    const used = new Uint8Array(n * n);
    const starts = quayPieces.map((q) => q.road.pts[Math.floor(q.road.pts.length / 2)]);
    if (!starts.length && S.roads.length > firstNew) starts.push(S.roads[firstNew].pts[0]);
    let first = true;
    for (const st of starts) {
      const cells = tracePath(S, D, st[0], st[1], used);
      if (!cells || cells.length < 3) continue;
      const simp = rdp(cells, 7);
      const w = first ? 9 : 7.5;
      for (const pts of carveXZ(S, simp, w / 2, { minLen: 15, margin: 0, sides: false })) addRoadXZ(S, { pts, kind: first ? 'secondary' : 'tertiary', width: w, name: '', synth: true });
      first = false;
    }
  }
  return { rails: rails_out };
}

/** Main walkable component (4-connected land/quay/pontoon cells outside buildings) seeded behind the main berth. */
function walkComponent(S, seedX, seedZ) {
  const { n, mask } = S.ctx, N = n * n;
  const comp = new Uint8Array(N);
  const pass = (k) => WALK[mask[k]] === 1 && !S.bmask[k];
  let s = idxOfXZ(S.ctx, seedX, seedZ);
  if (s < 0 || !pass(s)) {
    let best = -1, bd = Infinity; const i0 = s >= 0 ? s % n : n / 2, j0 = s >= 0 ? (s - i0) / n : n / 2;
    for (let dj = -8; dj <= 8; dj++) for (let di = -8; di <= 8; di++) { const i = i0 + di, j = j0 + dj; if (i < 0 || j < 0 || i >= n || j >= n) continue; const k = j * n + i; if (pass(k) && di * di + dj * dj < bd) { bd = di * di + dj * dj; best = k; } }
    s = best;
  }
  if (s < 0) return null;
  const stack = new Int32Array(N); let top = 0, count = 0;
  stack[top++] = s; comp[s] = 1;
  while (top) {
    const k = stack[--top]; count++;
    const i = k % n, j = (k - i) / n;
    if (i > 0 && !comp[k - 1] && pass(k - 1)) { comp[k - 1] = 1; stack[top++] = k - 1; }
    if (i < n - 1 && !comp[k + 1] && pass(k + 1)) { comp[k + 1] = 1; stack[top++] = k + 1; }
    if (j > 0 && !comp[k - n] && pass(k - n)) { comp[k - n] = 1; stack[top++] = k - n; }
    if (j < n - 1 && !comp[k + n] && pass(k + n)) { comp[k + n] = 1; stack[top++] = k + n; }
  }
  return count >= 20 ? comp : null;
}
const inComp = (S, x, z) => { if (!S.comp) return true; const k = idxOfXZ(S.ctx, x, z); return k >= 0 && S.comp[k] === 1; };

/** Door of a building: on the edge facing the nearest road (or quay), 1.2 m outside, on walkable land. */
function doorForBuilding(S, b, fallback) {
  let best = null, bs = Infinity;
  const r = b.ring, m = r.length;
  for (let k = 0; k < m; k++) {
    const a = r[k], c = r[(k + 1) % m];
    const dx = c[0] - a[0], dz = c[1] - a[1], L = Math.hypot(dx, dz);
    if (L < 2.5) continue;
    let nx = dz / L, nz = -dx / L;
    const mx = (a[0] + c[0]) / 2, mz = (a[1] + c[1]) / 2;
    if (pointInRingXZ(mx + nx * 0.6, mz + nz * 0.6, r)) { nx = -nx; nz = -nz; }
    const x = mx + nx * 1.2, z = mz + nz * 1.2;
    if (!freeXZ(S, x, z, 0.4, b.idx) || pointInRingXZ(x, z, r)) continue;
    let score = S.roads.length ? Math.max(0, roadEdgeDist(S, x, z, 300)) : Math.hypot(x - fallback[0], z - fallback[1]);
    if (!Number.isFinite(score)) score = Math.hypot(x - fallback[0], z - fallback[1]);
    if (!inComp(S, x, z)) score += 1e4;
    if (!freeXZ(S, mx + nx * 4, mz + nz * 4, 0.5, b.idx)) score += 25;   // no room to approach
    score -= Math.min(L, 30) * 0.15;
    if (score < bs) { bs = score; best = { x, z, inComp: inComp(S, x, z) }; }
  }
  return best;
}
/** Nearest walkable, building-free point of the main component within `radius` metres (cell centres), or null. */
function nearestFreePoint(S, x, z, radius = 60) {
  const res = S.ctx.res;
  if (freeXZ(S, x, z, 0.5) && inComp(S, x, z)) return { x, z };
  let best = null, bd = Infinity;
  const R = Math.ceil(radius / res);
  for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
    const px = x + di * res, pz = z + dj * res, d = di * di + dj * dj;
    if (d >= bd || d > R * R) continue;
    if (freeXZ(S, px, pz, 1) && inComp(S, px, pz)) { bd = d; best = { x: px, z: pz }; }
  }
  return best;
}

/** Find room for a small building (POI with nothing suitable nearby) behind the quay berths; returns its ring or null. */
function placeSmallBuilding(S, berths, w = 16, d = 11) {
  for (const b of berths.filter((q) => q.kind === 'quay').slice(0, 6).concat(berths.slice(0, 2))) {
    const Fx = b.x - b.sx * 12, Fz = b.z - b.sz * 12, Lx = -b.sx, Lz = -b.sz;
    for (const o of [48, 60, 75, 95, 120, 150, 190]) for (const u of [0, 25, -25, 50, -50, 80, -80, 115, -115, 150, -150]) {
      const cx = Fx + Lx * o + b.tx * u, cz = Fz + Lz * o + b.tz * u;
      const ring = rectXZ(cx, cz, b.tx, b.tz, w / 2, d / 2);
      const probes = ring.concat([[cx, cz]], ring.map((p, i) => [(p[0] + ring[(i + 1) % 4][0]) / 2, (p[1] + ring[(i + 1) % 4][1]) / 2]));
      if (!probes.every(([x, z]) => freeXZ(S, x, z, 3) && inComp(S, x, z))) continue;
      if (S.roads.length && roadEdgeDist(S, cx, cz, 60) < Math.max(w, d) / 2 + 3) continue;
      return ring;
    }
  }
  return null;
}

/** The six game POIs (+ police / café when there is a building for them), OSM amenities first. */
function placePois(S, berths, harbor, rnd) {
  const ctx = S.ctx;
  const quays = berths.filter((b) => b.kind === 'quay');
  const mb = berths.find((b) => b.kind === 'quay' && b.length >= 120 && b.depth >= 8) || quays[0] || berths[0];
  const focus = (mb ? [mb] : []).concat(quays.filter((b) => b !== mb).slice(0, 1)).map((b) => [b.x - b.sx * 12, b.z - b.sz * 12]);
  if (!focus.length) focus.push([0, 0]);
  const distFocus = (x, z) => { let d = Infinity; for (const f of focus) d = Math.min(d, Math.hypot(x - f[0], z - f[1])); return d; };
  const used = new Set();
  const pois = [];
  const short = String(harbor.name || harbor.id).split(' (')[0].split(' / ')[0];
  const defaults = { harbourmaster: `Harbourmaster ${short}`, shipyard: `${short} Shipyard`, chandler: 'Ship Chandler', fuel: 'Fuel Dock', market: `${short} Market Hall`, bar: BAR_NAMES[hashString(`${harbor.id}:bar`) % BAR_NAMES.length], police: 'Harbour Police', cafe: CAFE_NAMES[hashString(`${harbor.id}:cafe`) % CAFE_NAMES.length] };
  const add = (kind, name, at, door, building) => pois.push({ kind, name: name || defaults[kind], x: at[0], z: at[1], door, building });
  const osmCands = (ctx.street?.pois || []).map((p) => ({ ...p, xz: ctx.frame.toXZ(p.lat, p.lon), ringXZ: p.ring ? p.ring.map((q) => ctx.frame.toXZ(q[0], q[1])) : null }))
    .filter((p) => inPatch(ctx, p.xz[0], p.xz[1]));
  const buildingAt = (p) => {
    // OSM building that holds the amenity: contains the node / ring centroid, else the nearest within 20 m
    let best = -1, bd = 20;
    for (const b of S.blds) {
      if (!b || b.synthPoi) continue;
      if (p.xz[0] < b.x0 - 20 || p.xz[0] > b.x1 + 20 || p.xz[1] < b.z0 - 20 || p.xz[1] > b.z1 + 20) continue;
      if (pointInRingXZ(p.xz[0], p.xz[1], b.ring)) return b.idx;
      for (let k = 0; k < b.ring.length; k++) { const a = b.ring[k], c = b.ring[(k + 1) % b.ring.length]; const d = Math.sqrt(segDist2(p.xz[0], p.xz[1], a[0], a[1], c[0], c[1])); if (d < bd) { bd = d; best = b.idx; } }
    }
    return best;
  };
  const fromOSM = (kind) => {
    const list = osmCands.filter((p) => p.kind === kind).sort((a, b) => distFocus(a.xz[0], a.xz[1]) - distFocus(b.xz[0], b.xz[1]));
    for (const p of list.slice(0, 8)) {
      if (kind === 'fuel') {   // a fuel DOCK: only amenities at the water's edge qualify
        const k = idxOfXZ(ctx, p.xz[0], p.xz[1]);
        if (k < 0 || !(ctx.dWat && (IS_WATER[ctx.mask[k]] || ctx.dWat[k] * ctx.res <= 80))) continue;
      }
      const bi = buildingAt(p);
      if (bi >= 0 && S.blds[bi]) {
        const door = doorForBuilding(S, S.blds[bi], focus[0]);
        if (door && door.inComp) { used.add(bi); add(kind, p.name, [S.blds[bi].cx, S.blds[bi].cz], door, bi); return true; }
      }
      const pt = nearestFreePoint(S, p.xz[0], p.xz[1], 60);
      if (pt) { add(kind, p.name, p.xz, pt, -1); return true; }
    }
    return false;
  };
  const prefer = {
    harbourmaster: (b) => (b.kind === 'building' ? 0 : b.area < 3000 ? 60 : 160),
    market: (b) => (b.kind === 'warehouse' ? 0 : b.kind === 'industrial' ? 40 : 120) - Math.min(60, b.area / 100),
    shipyard: (b) => (b.kind === 'industrial' ? 0 : b.kind === 'warehouse' ? 20 : 120),
    chandler: (b) => (b.area < 1600 ? 0 : 60) + (b.kind === 'warehouse' ? 20 : 0),
    bar: (b) => (b.kind === 'building' ? 0 : 90) + (b.area > 2500 ? 60 : 0),
    police: (b) => (b.kind === 'building' ? 0 : 100),
    cafe: (b) => (b.kind === 'building' ? 0 : 100),
  };
  const fromBuildings = (kind, maxDist) => {
    let best = null, bs = Infinity;
    for (const b of S.blds) {
      if (!b || used.has(b.idx) || b.area < 40) continue;
      const d = distFocus(b.cx, b.cz);
      if (d > maxDist) continue;
      let s = d + prefer[kind](b);
      if (kind === 'bar' || kind === 'cafe') { const hm = pois.find((p) => p.kind === 'harbourmaster'); if (hm && Math.hypot(b.cx - hm.x, b.cz - hm.z) < 40) s += 80; }
      if (s >= bs) continue;
      const door = doorForBuilding(S, b, focus[0]);
      if (!door || !door.inComp) continue;
      bs = s; best = { b, door };
    }
    if (!best) return false;
    used.add(best.b.idx);
    add(kind, null, [best.b.cx, best.b.cz], best.door, best.b.idx);
    return true;
  };
  const synthBuilding = (kind) => {
    const ring = placeSmallBuilding(S, berths, kind === 'market' ? 30 : 16, kind === 'market' ? 18 : 11);
    if (!ring) return false;
    const idx = ctx.features.buildings.length;
    const height = round1(kind === 'market' ? 9 : 6.5 + rnd() * 3);
    ctx.features.buildings.push({ pts: ring.map((p) => xzToLL(ctx, p[0], p[1])), height, kind: kind === 'market' ? 'warehouse' : 'building' });
    addBuildingXZ(S, idx, ring, { kind: 'building', height });
    S.blds[idx].synthPoi = true;
    const door = doorForBuilding(S, S.blds[idx], focus[0]);
    if (!door) return false;
    used.add(idx);
    add(kind, null, [S.blds[idx].cx, S.blds[idx].cz], door, idx);
    return true;
  };
  const fuelDock = () => {
    // a short quay berth (bunkering alongside), then the main quay, then the marina pontoons; the pump stands on the
    // quay a little off the berth centre so the berth itself is the place to lie alongside and fill up
    const cand = quays.slice(1, 6).sort((a, b) => a.length - b.length).concat(quays.slice(0, 1), berths.filter((b) => b.kind === 'pontoon').slice(0, 2));
    for (const b of cand) {
      const Fx = b.x - b.sx * 12, Fz = b.z - b.sz * 12;
      for (const e of [1, -1, 0.5, -0.5, 0]) {
        const s = e * Math.max(0, Math.min(b.length / 2 - 12, 45));
        const x = Fx + b.tx * s - b.sx * 6, z = Fz + b.tz * s - b.sz * 6;
        if (freeXZ(S, x, z, 1.5) && inComp(S, x, z)) { add('fuel', null, [x, z], { x, z, inComp: true }, -1); return true; }
      }
    }
    return false;
  };
  for (const kind of POI_ORDER) {
    const required = REQUIRED_POIS.includes(kind);
    if (fromOSM(kind)) continue;
    if (kind === 'fuel') { if (fuelDock()) continue; }
    else if (fromBuildings(kind, required ? 900 : 600)) continue;
    else if (required && synthBuilding(kind)) continue;
    if (required) {   // last resort: a kiosk spot on the quay behind the main berth
      const f = focus[0];
      const pt = mb ? nearestFreePoint(S, f[0] - mb.sx * (10 + 8 * pois.length), f[1] - mb.sz * (10 + 8 * pois.length), 200) : null;
      const at = pt || { x: f[0], z: f[1] };
      add(kind, null, [at.x, at.z], { x: at.x, z: at.z }, -1);
    }
  }
  return pois;
}

/** Synthetic areas: port aprons behind the quays, an industrial zone, parking by the busy doors, a park or two. */
function synthAreas(S, berths, pois, harbor) {
  const out = [];
  const quays = berths.filter((b) => b.kind === 'quay').slice(0, 6);
  for (const b of quays) {
    const Fx = b.x - b.sx * 12, Fz = b.z - b.sz * 12, Lx = -b.sx, Lz = -b.sz, h = b.length / 2 + 20;
    const P = (u, v) => [Fx + b.tx * u + Lx * v, Fz + b.tz * u + Lz * v];
    out.push({ kind: 'port', ring: [P(-h, 2), P(h, 2), P(h, 135), P(-h, 135)] });
  }
  const big = harbor.size === 'mega' || harbor.size === 'major';
  if (big && quays[0]) {
    const b = quays[0], Fx = b.x - b.sx * 12, Fz = b.z - b.sz * 12, Lx = -b.sx, Lz = -b.sz, h = b.length / 2 + 120;
    const P = (u, v) => [Fx + b.tx * u + Lx * v, Fz + b.tz * u + Lz * v];
    out.push({ kind: 'industrial', ring: [P(-h, 135), P(h, 135), P(h, 300), P(-h, 300)] });
  }
  const rectFree = (ring, margin) => {
    const c = [(ring[0][0] + ring[2][0]) / 2, (ring[0][1] + ring[2][1]) / 2];
    const probes = ring.concat([c], ring.map((p, i) => [(p[0] + ring[(i + 1) % 4][0]) / 2, (p[1] + ring[(i + 1) % 4][1]) / 2]));
    return probes.every(([x, z]) => freeXZ(S, x, z, margin)) && (!S.roads.length || probes.every(([x, z]) => roadEdgeDist(S, x, z, 60) > 1));
  };
  // parking next to the harbour office, the market hall and the bar
  for (const p of pois.filter((q) => q.kind === 'harbourmaster' || q.kind === 'market' || q.kind === 'bar')) {
    let placed = false;
    for (const r of [22, 30, 40, 52] ) {
      for (let a = 0; a < 12 && !placed; a++) {
        const ang = (a / 12) * Math.PI * 2, cx = p.door.x + Math.cos(ang) * r, cz = p.door.z + Math.sin(ang) * r;
        const ux = Math.cos(ang + Math.PI / 2), uz = Math.sin(ang + Math.PI / 2);
        const ring = rectXZ(cx, cz, ux, uz, 14, 9);
        if (rectFree(ring, 1.5)) { out.push({ kind: 'parking', ring }); placed = true; }
      }
      if (placed) break;
    }
  }
  // a park and some grass on free land within a kilometre of the main berth
  const mb = quays[0] || berths[0];
  if (mb) {
    const Fx = mb.x - mb.sx * 12, Fz = mb.z - mb.sz * 12, Lx = -mb.sx, Lz = -mb.sz;
    let made = 0;
    for (let v = 160; v <= 900 && made < 3; v += 60) for (let u = -600; u <= 600 && made < 3; u += 60) {
      const cx = Fx + mb.tx * u + Lx * v, cz = Fz + mb.tz * u + Lz * v;
      const ring = rectXZ(cx, cz, mb.tx, mb.tz, 40, 28);
      if (out.some((a) => a.kind !== 'port' && a.kind !== 'industrial' && Math.hypot(a.ring[0][0] - cx, a.ring[0][1] - cz) < 140)) continue;
      if (!rectFree(ring, 4)) continue;
      out.push({ kind: made === 0 ? 'park' : 'grass', ring }); made++;
    }
  }
  return out;
}

/** Fallback when the street builder fails: the six POIs as kiosks on the quay behind the main berth. */
function minimalPois(ctx, berths, harbor) {
  const mb = berths.find((b) => b.kind === 'quay') || berths[0];
  const out = [];
  REQUIRED_POIS.forEach((kind, i) => {
    let x = 0, z = 0;
    if (mb) {
      const Fx = mb.x - mb.sx * 12, Fz = mb.z - mb.sz * 12;
      x = Fx - mb.sx * 10 + mb.tx * (i - 2.5) * 14; z = Fz - mb.sz * 10 + mb.tz * (i - 2.5) * 14;
      if (!WALK[maskAtXZ(ctx, x, z)] ) { x = Fx - mb.sx * 3; z = Fz - mb.sz * 3; }
    }
    out.push({ kind, name: { harbourmaster: 'Harbourmaster', shipyard: `${String(harbor.name || '').split(' (')[0]} Shipyard`, chandler: 'Ship Chandler', fuel: 'Fuel Dock', market: 'Market Hall', bar: BAR_NAMES[0] }[kind], x, z, door: { x, z }, building: -1 });
  });
  return out;
}

/** Build the whole street layer; returns the JSON parts in lat/lon. Mutates ctx.features.buildings (POI buildings). */
function buildStreetLayer(ctx, berths, rnd) {
  const { harbor, half } = ctx;
  const S = streetIndex(ctx);
  const st = ctx.street || null;
  let rails = [], areasXZ = [];
  // ---- roads: OSM when the payload has them (and they reach the land), else generated
  if (st && st.hasStreets) {
    for (const r of st.roads || []) {
      const xz = r.pts.map((p) => ctx.frame.toXZ(p[0], p[1]));
      for (const piece of clipPolylineXZ(xz, half - 2)) {
        const pts = rdp(piece, 0.7);
        if (polyLenXZ(pts) >= 6) addRoadXZ(S, { pts, kind: r.kind, width: r.width, name: r.name || '', bridge: !!r.bridge });
      }
    }
    for (const r of st.rails || []) for (const piece of clipPolylineXZ(r.pts.map((p) => ctx.frame.toXZ(p[0], p[1])), half - 2)) { const pts = rdp(piece, 1); if (polyLenXZ(pts) >= 20) rails.push({ pts }); }
    for (const a of st.areas || []) {
      const ring = clipRingXZ(a.pts.map((p) => ctx.frame.toXZ(p[0], p[1])), half - 1);
      if (ring.length >= 3 && Math.abs(ringAreaXZ(ring)) >= 60) areasXZ.push({ kind: a.kind, ring });
    }
  }
  const onLand = S.roads.filter((r) => r.kind !== 'footway' && resampleXZ(r.pts, 20).some(([x, z]) => isWalkXZ(S, x, z))).length;
  const big = harbor.size === 'mega' || harbor.size === 'major';
  if (!st || !st.hasStreets || onLand < 3) {
    const extra = synthesizeRoads(S, berths, { grid: true, connectToExisting: S.roads.length > 0, rails: big && rails.length === 0 });
    rails = rails.concat(extra.rails);
  } else {
    const mb = berths.find((b) => b.kind === 'quay');
    if (mb && roadEdgeDist(S, mb.x - mb.sx * 40, mb.z - mb.sz * 40, 150) > 120) synthesizeRoads(S, berths, { grid: false, connectToExisting: true, rails: false });
  }
  // ---- POIs (after the roads: doors face the nearest road) inside the main walkable component
  const mb = berths.find((b) => b.kind === 'quay' && b.length >= 120 && b.depth >= 8) || berths.find((b) => b.kind === 'quay') || berths[0];
  S.comp = mb ? walkComponent(S, mb.x - mb.sx * 20, mb.z - mb.sz * 20) : null;
  const pois = placePois(S, berths, harbor, rnd);
  if (areasXZ.length < 3) areasXZ = areasXZ.concat(synthAreas(S, berths, pois, harbor));
  // ---- JSON (lat/lon, 6 decimals)
  const ll = (p) => xzToLL(ctx, p[0], p[1]);
  const roads = S.roads.map((r) => ({ pts: r.pts.map(ll), kind: r.kind, width: r.width, name: r.name || '', ...(r.bridge ? { bridge: true } : {}) }));
  const areas = areasXZ.map((a) => ({ pts: osm.simplifyRing(a.ring.map(ll), 2), kind: a.kind })).filter((a) => a.pts.length >= 3);
  const poisJSON = pois.map((p) => {
    const at = ll([p.x, p.z]), door = ll([p.door.x, p.door.z]);
    return { id: `${harbor.id}-${p.kind}`, kind: p.kind, name: p.name, lat: at[0], lon: at[1], door: { lat: door[0], lon: door[1] }, building: p.building };
  });
  const places = [];
  for (const p of st?.places || []) { const [x, z] = ctx.frame.toXZ(p.lat, p.lon); if (inPatch(ctx, x, z)) places.push({ kind: p.kind, sub: p.sub, name: p.name, lat: p.lat, lon: p.lon }); }
  return { roads, areas, rails: rails.map((r) => ({ pts: r.pts.map(ll) })), pois: poisJSON, places };
}

function finishBuild(ctx, w) {
  const { n, res, mask, harbor } = ctx;
  const rnd = ctx.rnd || mulberry32(hashString(harbor.id) ^ 0x51ed270b);
  markShallows(ctx);
  computeDistances(ctx);
  rasterHeights(ctx);
  // anchor (guaranteed water ≥ 40 m from any obstacle)
  let anchor = findAnchor(ctx, ctx.anchorPref || [0, 0]);
  // fairway: forced head (synthetic entrance) + the widest-water path to the patch edge
  let fairway = [anchor].concat(ctx.fairwayHead || []);
  const tail = fairwayPath(ctx, fairway[fairway.length - 1], w);
  if (tail && tail.length >= 2) fairway = fairway.concat(tail.slice(1));
  if (ctx.entrance && w) {   // synthetic: stop once the world is deeper than 15 m (≥ 750 m beyond the entrance) or 3 km out
    const E = ctx.entrance.E;
    const out = [fairway[0], fairway[1]];
    let acc = 0, cut = false;
    for (let i = 2; i < fairway.length && !cut; i++) {
      const a = fairway[i - 1], b = fairway[i];
      const segL = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const steps = Math.max(1, Math.ceil(segL / 125));
      for (let s = 1; s <= steps; s++) {
        const t = s / steps, px = a[0] + (b[0] - a[0]) * t, pz = a[1] + (b[1] - a[1]) * t;
        acc = Math.hypot(px - E[0], pz - E[1]);
        const ll = ctx.frame.toLL(px, pz);
        const fromAnchor = Math.hypot(px - anchor[0], pz - anchor[1]);
        if ((acc >= 750 && -w.heightAt(ll[0], ll[1]) > 15) || fromAnchor >= 3000) { out.push([px, pz]); cut = true; break; }
      }
      if (!cut) out.push(b);
    }
    fairway = out;
  }
  if (fairway.length < 2) { const d = ctx.entrance ? ctx.entrance.E : [anchor[0], anchor[1] - 300]; fairway.push(d); }
  for (let i = 0; i + 1 < fairway.length; i++) {
    strokeXZ(ctx, [fairway[i], fairway[i + 1]], ctx.fairwayHalf, mask, FAIRWAY, { allow: new Uint8Array([1, 0, 0, 0, 0, 0, 1]) });
    strokeXZ(ctx, [fairway[i], fairway[i + 1]], ctx.fairwayHalf, ctx.dredge, ctx.fairwayDepth, { max: true, allow: ALLOW_WATER });
  }
  rasterHeights(ctx);
  // berths + guarantee
  let berths = generateBerths(ctx);
  const big = () => berths.filter((b) => b.kind === 'quay' && b.length >= 120 && b.depth >= 8);
  if (big().length < 2) {
    // 1. dredge the longest quay faces
    const longQuays = berths.filter((b) => b.kind === 'quay' && b.length >= 120 && b.depth < 8).slice(0, 4);
    for (const b of longQuays) dredgeBerth(ctx, b, Math.max(9, b.depth));
    if (longQuays.length) { rasterHeights(ctx); berths = generateBerths(ctx); }
  }
  if (big().length < 2) {
    // 2. cut synthetic quays into the nearest coast (or a finger pier when there is no coast at all)
    const lay = analyseCoast(ctx, anchor[0], anchor[1], 1800);
    if (lay) placeQuayRow(ctx, lay, SIZES[harbor.size] || SIZES.regional, rnd, { nQuays: 2, docks: 0, berthDepth: Math.max(9, (SIZES[harbor.size] || SIZES.regional).berthDepth) });
    else emergencyPier(ctx, anchor);
    markShallows(ctx);
    computeDistances(ctx); rasterHeights(ctx);
    anchor = findAnchor(ctx, anchor);
    berths = generateBerths(ctx);
  }
  if (big().length < 2) { emergencyPier(ctx, anchor); computeDistances(ctx); rasterHeights(ctx); anchor = findAnchor(ctx, anchor); berths = generateBerths(ctx); }
  // cranes: OSM cranes (heading from the nearest berth) or 1–5 synthetic ones along the longest quay
  const S = SIZES[harbor.size] || SIZES.regional;
  if (ctx.osmCranes && ctx.osmCranes.length) {
    for (const c of ctx.osmCranes) {
      const [x, z] = ctx.frame.toXZ(c.lat, c.lon);
      let hdg = c.hdg, bd = Infinity;
      for (const b of berths) { const d = (b.x - x) ** 2 + (b.z - z) ** 2; if (d < bd) { bd = d; hdg = b.hdg; } }
      ctx.features.cranes.push({ lat: c.lat, lon: c.lon, hdg });
    }
  } else if (!ctx.features.cranes.length) {
    const q = berths.find((b) => b.kind === 'quay');
    if (q) {
      const cnt = S.cranes;
      for (let c = 0; c < cnt; c++) {
        const s = (c + 0.5) / cnt - 0.5;
        const x = q.x - q.sx * 24 + q.tx * q.length * s, z = q.z - q.sz * 24 + q.tz * q.length * s;
        const ll = xzToLL(ctx, x, z);
        ctx.features.cranes.push({ lat: ll[0], lon: ll[1], hdg: q.hdg });
      }
    }
  }
  // entrance lights (synthetic) and lateral buoys along the fairway (synthetic, or OSM without seamarks)
  if (ctx.entrance) {
    const E = ctx.entrance.E, next = fairway.length > 2 ? fairway[2] : [E[0] + (E[0] - anchor[0]), E[1] + (E[1] - anchor[1])];
    const dx = E[0] - next[0], dz = E[1] - next[1], L = Math.hypot(dx, dz) || 1;
    entranceLights(ctx, ctx.entrance.heads, E, [dx / L, dz / L]);
  }
  if (ctx.synthBuoys) {
    const startIdx = ctx.entrance ? 1 : 0;
    const regionB = osm.ialaRegion(ctx.oLat, ctx.oLon) === 'B';
    const wBuoy = ctx.fairwayHalf + 10;
    let acc = 0, nextAt = 250;
    for (let i = startIdx; i + 1 < fairway.length; i++) {
      const a = fairway[i], b = fairway[i + 1];
      const segL = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const ux = (b[0] - a[0]) / (segL || 1), uz = (b[1] - a[1]) / (segL || 1);
      while (nextAt <= acc + segL) {
        const s = nextAt - acc, px = a[0] + ux * s, pz = a[1] + uz * s;
        // entering = toward the harbour = -u; port hand = left of entering = (dz, -dx) of (-u)
        const ex = -ux, ez = -uz, lx = ez, lz = -ex;
        const portRed = !regionB;
        const pp = [px + lx * wBuoy, pz + lz * wBuoy], sp = [px - lx * wBuoy, pz - lz * wBuoy];
        if (inPatch(ctx, pp[0], pp[1]) && IS_WATER[maskAtXZ(ctx, pp[0], pp[1])]) { const ll = xzToLL(ctx, pp[0], pp[1]); ctx.features.buoys.push({ lat: ll[0], lon: ll[1], kind: 'lateral_port', color: portRed ? osm.BUOY_COLORS.red : osm.BUOY_COLORS.green, shape: 'can' }); }
        if (inPatch(ctx, sp[0], sp[1]) && IS_WATER[maskAtXZ(ctx, sp[0], sp[1])]) { const ll = xzToLL(ctx, sp[0], sp[1]); ctx.features.buoys.push({ lat: ll[0], lon: ll[1], kind: 'lateral_starboard', color: portRed ? osm.BUOY_COLORS.green : osm.BUOY_COLORS.red, shape: 'cone' }); }
        nextAt += 250;
      }
      acc += segL;
    }
    const end = fairway[fairway.length - 1];
    if (inPatch(ctx, end[0], end[1])) { const ll = xzToLL(ctx, end[0], end[1]); ctx.features.buoys.push({ lat: ll[0], lon: ll[1], kind: 'safe_water', color: osm.BUOY_COLORS.red, color2: osm.BUOY_COLORS.white, shape: 'sphere' }); }
  }
  // ---- street layer (v0.4): roads, areas, rails, POIs with doors. Building indices refer to the final list, so the
  // cap is applied first; POI buildings the street builder adds are appended after it.
  const feats = ctx.features;
  if (feats.buildings.length > osm.BUILDING_CAP) { feats.buildings.sort((a, b) => osm.ringAreaM2(b.pts) - osm.ringAreaM2(a.pts)); feats.buildings.length = osm.BUILDING_CAP; }
  let street;
  try { street = buildStreetLayer(ctx, berths, mulberry32(hashString(harbor.id) ^ 0x2545f491)); }
  catch (err) {
    cfg.log('[geom] street layer failed for', harbor.id, err?.stack || err);
    street = { roads: [], areas: [], rails: [], places: [], pois: minimalPois(ctx, berths, harbor).map((p) => { const at = xzToLL(ctx, p.x, p.z); return { id: `${harbor.id}-${p.kind}`, kind: p.kind, name: p.name, lat: at[0], lon: at[1], door: { lat: at[0], lon: at[1] }, building: -1 }; }) };
  }
  // ---- JSON
  const anchorLL = xzToLL(ctx, anchor[0], anchor[1]);
  const berthsJSON = berths.map((b, k) => {
    const ll = xzToLL(ctx, b.x, b.z);
    return { id: `${harbor.id}-b${k + 1}`, name: `Berth ${k + 1}`, lat: ll[0], lon: ll[1], hdg: b.hdg, length: b.length, depth: b.depth, kind: b.kind, maxLength: Math.max(10, b.length - (b.kind === 'pontoon' ? 0 : 10)) };
  });
  const geom = {
    id: harbor.id, name: harbor.name, source: ctx.source, version: GEOM_VERSION,
    origin: { lat: harbor.lat, lon: harbor.lon }, anchor: { lat: anchorLL[0], lon: anchorLL[1] },
    n, res, radiusM: Math.round((n * res) / 2 * Math.SQRT2),
    berths: berthsJSON,
    fairway: fairway.map((p) => xzToLL(ctx, p[0], p[1])),
    features: {
      quays: feats.quays, piers: feats.piers, breakwaters: feats.breakwaters, pontoons: feats.pontoons,
      buildings: feats.buildings, cranes: feats.cranes, lights: feats.lights, buoys: feats.buoys, tanks: feats.tanks,
      roads: street.roads, areas: street.areas, rails: street.rails, pois: street.pois, places: street.places,
    },
  };
  return { geom, heights: ctx.heights, mask: ctx.mask, sdf: ctx.sdf, berthsXZ: berths.map((b) => [b.x, b.z]) };
}

// ---------------------------------------------------------------------------------------------------------------
// Binary patch
// ---------------------------------------------------------------------------------------------------------------
/** 'SLHP' · u8 version=1 · u8 flags (bit0 synthetic) · u16 n · f32 res · f64 originLat · f64 originLon · u8 heights[n²] · u8 mask[n²] (LE). */
export function encodePatch({ n, res, originLat, originLon, synthetic, heights, mask }) {
  const N = n * n;
  const buf = Buffer.alloc(PATCH_HEADER_BYTES + 2 * N);
  buf.write(PATCH_MAGIC, 0, 'ascii');
  buf[4] = 1; buf[5] = synthetic ? 1 : 0;
  buf.writeUInt16LE(n, 6); buf.writeFloatLE(res, 8); buf.writeDoubleLE(originLat, 12); buf.writeDoubleLE(originLon, 20);
  buf.set(heights.subarray(0, N), PATCH_HEADER_BYTES);
  buf.set(mask.subarray(0, N), PATCH_HEADER_BYTES + N);
  return buf;
}
export function decodePatch(buf) {
  if (!buf || buf.length < PATCH_HEADER_BYTES || buf.toString('ascii', 0, 4) !== PATCH_MAGIC) return null;
  const version = buf[4], flags = buf[5], n = buf.readUInt16LE(6), res = buf.readFloatLE(8), originLat = buf.readDoubleLE(12), originLon = buf.readDoubleLE(20);
  const N = n * n;
  if (buf.length !== PATCH_HEADER_BYTES + 2 * N) return null;
  const heights = new Uint8Array(buf.buffer, buf.byteOffset + PATCH_HEADER_BYTES, N);
  const mask = new Uint8Array(buf.buffer, buf.byteOffset + PATCH_HEADER_BYTES + N, N);
  return { version, flags, synthetic: !!(flags & 1), n, res, originLat, originLon, heights, mask };
}

// ---------------------------------------------------------------------------------------------------------------
// Entries (memory) + disk cache
// ---------------------------------------------------------------------------------------------------------------
function sdfToInt16(sdf) { const out = new Int16Array(sdf.length); for (let i = 0; i < sdf.length; i++) out[i] = clamp(Math.round(sdf[i] * 4), -32000, 32000); return out; }
function sdfFromMask(mask, n, res) {
  const dObs = distanceTransform(mask, n, IS_OBSTACLE), dWat = distanceTransform(mask, n, IS_WATER);
  const out = new Int16Array(n * n);
  for (let i = 0; i < n * n; i++) { const d = ((IS_OBSTACLE[mask[i]] ? dWat[i] : dObs[i]) - 0.5) * res; const s = IS_OBSTACLE[mask[i]] ? -(d < 0 ? 0 : d) : d < 0 ? 0 : d; out[i] = clamp(Math.round(s * 4), -32000, 32000); }
  return out;
}
function makeEntry(harbor, build, source, builtAt = Date.now()) {
  const n = build.geom.n, res = build.geom.res;
  const buffer = encodePatch({ n, res, originLat: harbor.lat, originLon: harbor.lon, synthetic: source === 'synthetic', heights: build.heights, mask: build.mask });
  const dec = decodePatch(buffer);
  const frame = osm.localFrame(harbor.lat, harbor.lon);
  const berthsXZ = build.berthsXZ || build.geom.berths.map((b) => frame.toXZ(b.lat, b.lon));
  return {
    id: harbor.id, geom: build.geom, n, res, originLat: harbor.lat, originLon: harbor.lon, kLon: frame.kLon,
    halfLat: (n * res) / 2 / GEO.M_PER_DEG_LAT, halfLon: (n * res) / 2 / frame.kLon,
    buffer, heights: dec.heights, mask: dec.mask,
    sdf: build.sdf instanceof Float32Array ? sdfToInt16(build.sdf) : build.sdf, berthsXZ, source, builtAt,
  };
}
function setEntry(e) { entries.set(e.id, e); entryList = [...entries.values()]; }
function saveGeomCache(e) {
  try {
    const dir = geomDir();
    fs.mkdirSync(dir, { recursive: true });
    const j = path.join(dir, `${e.id}.json`), b = path.join(dir, `${e.id}.bin`);
    fs.writeFileSync(`${j}.tmp`, JSON.stringify({ version: GEOM_VERSION, builtAt: e.builtAt, source: e.source, geom: e.geom }));
    fs.writeFileSync(`${b}.tmp`, e.buffer);
    fs.renameSync(`${b}.tmp`, b); fs.renameSync(`${j}.tmp`, j);
    return true;
  } catch (err) { cfg.log('[geom] cache write failed', e.id, err?.message || err); return false; }
}
function loadGeomCache(id) {
  try {
    const dir = geomDir();
    const j = path.join(dir, `${id}.json`), b = path.join(dir, `${id}.bin`);
    if (!fs.existsSync(j) || !fs.existsSync(b)) return null;
    const meta = JSON.parse(fs.readFileSync(j, 'utf8'));
    if (!meta || meta.version !== GEOM_VERSION || !meta.geom || !Array.isArray(meta.geom.berths)) return null;
    if (!Array.isArray(meta.geom.features?.pois) || !meta.geom.features.pois.length || !Array.isArray(meta.geom.features.roads)) return null;   // v4 needs the street layer
    const harbor = harborById(id); if (!harbor) return null;
    const buf = fs.readFileSync(b);
    const dec = decodePatch(buf);
    if (!dec || dec.n !== PATCH_N || Math.abs(dec.originLat - harbor.lat) > 1e-9 || Math.abs(dec.originLon - harbor.lon) > 1e-9) return null;
    const sdf = sdfFromMask(dec.mask, dec.n, dec.res);
    return makeEntry(harbor, { geom: meta.geom, heights: dec.heights, mask: dec.mask, sdf }, meta.source === 'osm' ? 'osm' : 'synthetic', meta.builtAt || Date.now());
  } catch { return null; }
}

// ---------------------------------------------------------------------------------------------------------------
// Public queries (sync, fast, never throw)
// ---------------------------------------------------------------------------------------------------------------
export function getHarborGeom(id) { const e = entries.get(id); return e ? e.geom : null; }
export function getHarborPatch(id) { const e = entries.get(id); return e ? e.buffer : null; }
export function harborAnchor(id) {
  const e = entries.get(id);
  if (e) return { lat: e.geom.anchor.lat, lon: e.geom.anchor.lon };
  const h = harborById(id);
  return h ? { lat: h.lat, lon: h.lon } : null;
}
function sampleEntrySdf(e, lat, lon) {
  const n = e.n;
  const u = ((lon - e.originLon) * e.kLon) / e.res + n / 2 - 0.5, v = (-(lat - e.originLat) * GEO.M_PER_DEG_LAT) / e.res + n / 2 - 0.5;
  let i0 = Math.floor(u), j0 = Math.floor(v);
  if (i0 < 0) i0 = 0; else if (i0 > n - 2) i0 = n - 2;
  if (j0 < 0) j0 = 0; else if (j0 > n - 2) j0 = n - 2;
  let fx = u - i0, fy = v - j0;
  if (fx < 0) fx = 0; else if (fx > 1) fx = 1;
  if (fy < 0) fy = 0; else if (fy > 1) fy = 1;
  const s = e.sdf, o = j0 * n + i0;
  return ((s[o] * (1 - fx) + s[o + 1] * fx) * (1 - fy) + (s[o + n] * (1 - fx) + s[o + n + 1] * fx) * fy) * 0.25;
}
const covers = (e, lat, lon) => { const dl = lat - e.originLat, dn = lon - e.originLon; return dl < e.halfLat && dl > -e.halfLat && dn < e.halfLon && dn > -e.halfLon; };
/** Metres inside an obstacle (mask 1–4) for the covering patch(es); 0 in water; null when no built patch covers the point. */
export function landPenetration(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  let found = false, best = 0;
  for (let k = 0; k < entryList.length; k++) {
    const e = entryList[k];
    if (!covers(e, lat, lon)) continue;
    found = true;
    const d = sampleEntrySdf(e, lat, lon);
    if (d < 0 && -d > best) best = -d;
  }
  return found ? best : null;
}
/** Mask code (PATCH.MASK) of a built harbour patch at lat/lon, or null outside it / when not built. */
export function maskAt(id, lat, lon) {
  const e = entries.get(id);
  if (!e || !Number.isFinite(lat) || !Number.isFinite(lon) || !covers(e, lat, lon)) return null;
  const i = Math.floor(((lon - e.originLon) * e.kLon) / e.res + e.n / 2), j = Math.floor((-(lat - e.originLat) * GEO.M_PER_DEG_LAT) / e.res + e.n / 2);
  if (i < 0 || j < 0 || i >= e.n || j >= e.n) return null;
  return e.mask[j * e.n + i];
}
export function sdfAt(id, lat, lon) {
  const e = entries.get(id);
  if (!e || !Number.isFinite(lat) || !Number.isFinite(lon) || !covers(e, lat, lon)) return null;
  return sampleEntrySdf(e, lat, lon);
}
export function nearestBerth(harborId, lat, lon) {
  const e = entries.get(harborId);
  if (!e || !e.berthsXZ.length || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const x = (lon - e.originLon) * e.kLon, z = -(lat - e.originLat) * GEO.M_PER_DEG_LAT;
  let best = -1, bd = Infinity;
  for (let k = 0; k < e.berthsXZ.length; k++) { const b = e.berthsXZ[k]; const d = (b[0] - x) ** 2 + (b[1] - z) ** 2; if (d < bd) { bd = d; best = k; } }
  const b = e.berthsXZ[best];
  return { berth: e.geom.berths[best], distM: Math.round(Math.sqrt(bd) * 10) / 10, brg: Math.round(bearingOf(b[0] - x, b[1] - z)) };
}

// ---------------------------------------------------------------------------------------------------------------
// Building / caching orchestration
// ---------------------------------------------------------------------------------------------------------------
function networkAllowed() { return !cfg.offline && Date.now() >= netDownUntil; }
function osmWorthTrying(id) { const t = osmFailedAt.get(id); return networkAllowed() && (!t || Date.now() - t > OSM_BACKOFF_MS); }
async function fetchOSMFor(h, opts = {}) {
  const t0 = Date.now();
  const data = await osm.fetchHarborOSM(h, { radiusM: cfg.radiusM, timeoutMs: opts.timeoutMs ?? cfg.timeoutMs, fetchImpl: opts.fetchImpl || cfg.fetchImpl || undefined, force: !!opts.force, log: cfg.log });
  if (!data) { netFailures++; if (netFailures >= 3) { netDownUntil = Date.now() + NET_DOWN_MS; cfg.log('[geom] Overpass unreachable, pausing OSM fetches for 10 min'); } }
  else netFailures = 0;
  return { data, ms: Date.now() - t0, fromNetwork: !!data && Date.now() - data.fetchedAt < 60e3 };
}
function buildEntry(h, osmData) {
  const t0 = Date.now();
  let build = null, source = 'synthetic';
  if (osmData && osmUsable(osmData, h)) {
    try { build = buildFromOSM(h, osmData, world); source = 'osm'; } catch (err) { cfg.log('[geom] OSM build failed for', h.id, err?.message || err); build = null; }
  }
  if (!build) { build = buildSynthetic(h, world); source = 'synthetic'; }
  const e = makeEntry(h, build, source);
  e.buildMs = Date.now() - t0;
  return e;
}
function describe(e) { const g = e.geom, f = g.features; return `${e.source} ${e.buildMs ?? '?'} ms · ${g.berths.length} berths · ${f.buildings.length} bld · ${f.buoys.length} buoys · ${f.roads?.length ?? 0} roads · ${f.pois?.length ?? 0} POIs`; }

async function buildHarbor(h, opts) {
  const disk = entries.get(h.id) || loadGeomCache(h.id);
  if (disk && !entries.has(h.id)) setEntry(disk);
  if (disk && disk.source === 'osm') return disk.geom;
  // an OSM attempt (bounded by the fetch timeout) when the network is allowed; else the cached OSM file if any
  let osmData = null;
  if (osmWorthTrying(h.id) || opts.fetchImpl) {
    const r = await fetchOSMFor(h, opts);
    osmData = r.data;
    if (!osmData || !osmUsable(osmData, h)) osmFailedAt.set(h.id, Date.now());
  } else {
    osmData = osm.loadCachedOSM(h.id);
  }
  if (disk && !(osmData && osmUsable(osmData, h))) return disk.geom;
  await new Promise((r) => setImmediate(r));
  const e = buildEntry(h, osmData);
  setEntry(e);
  saveGeomCache(e);
  cfg.log(`[geom] ${h.id}: built ${describe(e)}`);
  return e.geom;
}
async function tryUpgrade(h, opts = {}) {
  try {
    const r = await fetchOSMFor(h, opts);
    if (!r.data || !osmUsable(r.data, h)) { osmFailedAt.set(h.id, Date.now()); return false; }
    await new Promise((res) => setImmediate(res));
    const e = buildEntry(h, r.data);
    if (e.source !== 'osm') { osmFailedAt.set(h.id, Date.now()); return false; }
    setEntry(e); saveGeomCache(e);
    cfg.log(`[geom] ${h.id}: replaced synthetic with OSM build (${describe(e)})`);
    return true;
  } catch (err) { cfg.log('[geom] upgrade failed', h.id, err?.message || err); return false; }
}

/**
 * Build (fetching OSM when allowed) and cache a harbour; resolves its geometry JSON or null. A synthetic harbour
 * that is already in memory is returned at once while an OSM upgrade runs in the background when worth trying.
 */
export async function ensureHarbor(id, opts = {}) {
  try {
    const h = harborById(id);
    if (!h) return null;
    const cur = entries.get(id);
    if (cur) {
      if (cur.source === 'synthetic' && osmWorthTrying(id) && !building.has(id)) {
        const p = tryUpgrade(h, opts).finally(() => building.delete(id));
        building.set(id, p.then(() => (entries.get(id) || cur).geom));
      }
      return cur.geom;
    }
    if (building.has(id)) return await building.get(id);
    const p = buildHarbor(h, opts).catch((err) => { cfg.log('[geom] build failed', id, err?.stack || err); return null; }).finally(() => building.delete(id));
    building.set(id, p);
    return await p;
  } catch { return null; }
}

/**
 * Build every harbour sequentially (CLI + optional startup prefetch). Never throws.
 * opts: delayMs (between Overpass requests), only (array/Set of ids), force, syntheticOnly, fetchImpl, timeoutMs, log
 */
export async function prefetchAll(opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : cfg.log;
  const delayMs = Number.isFinite(opts.delayMs) ? opts.delayMs : 1500;
  const only = opts.only ? new Set(opts.only) : null;
  const list = HARBORS.filter((h) => !only || only.has(h.id));
  const stats = { built: 0, failed: 0, skipped: 0, osm: 0, synthetic: 0, total: list.length };
  let lastNetworkAt = 0;
  for (let k = 0; k < list.length; k++) {
    const h = list[k];
    const tag = `[geom] ${k + 1}/${list.length} ${h.id}`;
    try {
      const cur = entries.get(h.id) || loadGeomCache(h.id);
      if (cur && !entries.has(h.id)) setEntry(cur);
      if (cur && cur.source === 'osm' && !opts.force) { stats.skipped++; log(`${tag}: cached (osm)`); continue; }
      let osmData = null;
      if (!opts.syntheticOnly) {
        if (cur && !opts.force && !osmWorthTrying(h.id) && !opts.fetchImpl) { stats.skipped++; log(`${tag}: cached (synthetic, OSM not available)`); continue; }
        const wait = delayMs - (Date.now() - lastNetworkAt);
        if (wait > 0 && lastNetworkAt) await new Promise((r) => setTimeout(r, wait));
        const r = await fetchOSMFor(h, { force: !!opts.force, fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });
        if (r.fromNetwork) lastNetworkAt = Date.now();
        osmData = r.data;
        if (!osmData || !osmUsable(osmData, h)) osmFailedAt.set(h.id, Date.now());
        if (cur && !opts.force && !(osmData && osmUsable(osmData, h))) { stats.skipped++; log(`${tag}: kept synthetic (OSM ${osmData ? 'unusable' : 'unavailable'})`); continue; }
      } else if (cur && !opts.force) { stats.skipped++; log(`${tag}: cached (${cur.source})`); continue; }
      await new Promise((r) => setImmediate(r));
      const e = buildEntry(h, osmData);
      setEntry(e); saveGeomCache(e);
      stats.built++; if (e.source === 'osm') stats.osm++; else stats.synthetic++;
      log(`${tag}: ${describe(e)}`);
    } catch (err) {
      stats.failed++;
      log(`${tag}: FAILED ${err?.message || err}`);
    }
  }
  log(`[geom] prefetch done: ${stats.built} built (${stats.osm} osm, ${stats.synthetic} synthetic), ${stats.skipped} skipped, ${stats.failed} failed`);
  return stats;
}

/** Introspection for tests / the CLI. */
export function stats() { return { built: entries.size, building: building.size, offline: cfg.offline, netDownUntil, entries: [...entries.values()].map((e) => ({ id: e.id, source: e.source, builtAt: e.builtAt })) }; }
export { decodePatchHeight };
