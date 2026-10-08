// World-tile converter (docs/WORLD-DETAIL-STREAMING.md §3.4): one decoded OpenFreeMap tile (+ the optional Overpass
// overlay of its z12 square, + the Terrarium z9 depth grid) → a tile object for shared/wtformat.js encodeTile. Pure and
// deterministic: the same input gives byte-identical output (no clocks, no randomness, no I/O — `hints` carries
// everything from the outside world, including builtAt). Runs in server/wtconvert-thread.js.
//
// Pipeline (work grid = the 256² tile plus the 4-cell MVT buffer on every side):
//   1. rasterise water (2× supersampled, majority of 4), stroked river / canal lines, piers, overlay structures,
//      buildings and land use; classify water cells (WATER / RIVER / DOCK / LOCK / FAIRWAY)
//   2. fill ditch-sized water specks and drop untagged land specks
//   3. derive quay edges (marching squares → Douglas–Peucker → straight runs ≥ 30 m next to docks / port land / piers)
//   4. depth by the first rule that applies (§3.4.3) and land heights, through exact Euclidean distance transforms
//   5. vectors (§3.2.1) for the client: quays, piers, breakwaters, pontoons, buildings, tanks, cranes, bridges, locks,
//      lights, areas
//
// OpenFreeMap facts this code relies on (probed 2026-10-08, planet 20261004_113936_pt): extent 4096 with a 64-unit
// buffer; `water` classes ocean / lake / river / dock / pond / swimming_pool (Rotterdam's basins are `lake`, inside
// `landuse=industrial`); `transportation class=pier` as lines and polygons; `building` carries only render_height /
// render_min_height (5 / 0 is the OpenMapTiles default for an untagged building, so it is treated as an estimate).
import { WT, WT_NAVIGABLE, WT_OBSTACLE, encodeWTHeight, tileSizeM, tileF, tileFToLatLon, fnv1a } from '../shared/wtformat.js';
import { bigPortById, portWaterKind, portIsFairway, KIND as BP_KIND } from './bigports.js';

export const CONVERTER_VERSION = 1;
const M = WT.MASK;
const S = 2;                       // supersampling of the water raster
export const FAIRWAY_DEPTH = { mega: 17, major: 15, regional: 11, minor: 8, none: 12 };
export const DOCK_DEPTH = { mega: 16, major: 14, regional: 10, minor: 6, none: 8 };
export const RIVER_DEPTH = (widthM) => (widthM > 300 ? 12 : widthM > 120 ? 8 : 4.5);
/** Port water floor (spec decision, see docs/WORLD-STREAMING-WIRING.md): inside a harbour's port area, sea / lake /
 *  river water keeps deepening along the shore ramp (0.5 + 0.15·d) down to this depth — the dredged basins and channels
 *  that Terrarium (a land DEM in ports) and the generic 0.06·d ramp cannot see. */
export const PORT_FLOOR = { mega: 15, major: 13, regional: 9, minor: 5, none: 0 };
export const QUAY_TOP = (size) => (size === 'mega' || size === 'major' ? 4.0 : 3.0);
const CAPS = { buildings: 4000, areas: 600, lights: 400 };
const W_CLASS = { ocean: 1, lake: 2, river: 3, dock: 4 };      // water sample codes (0 = none)
const LU_PORT = 1, LU_RES = 2, LU_COM = 4, LU_SAND = 8, LU_GRASS = 16, LU_WOOD = 32;

/** srcHash of a tile (§5.4): source version + converter version + overlay date. */
export function srcHashOf(src, ov) { return fnv1a(new TextEncoder().encode(`${src || ''}|cv${CONVERTER_VERSION}|${ov || ''}`)); }

// ------------------------------------------------------------------------------------------------ raster helpers
/** Even-odd scanline fill of rings (flat [x, y, …] in grid units) at sample centres; calls set(index). */
function fillRings(rings, w, h, set) {
  const rows = new Map();
  let r0 = h, r1 = -1;
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0; i < n; i += 2) {
      const ax = ring[i], ay = ring[i + 1], j = (i + 2) % n, bx = ring[j], by = ring[j + 1];
      if (ay === by) continue;
      let ra = Math.ceil(Math.min(ay, by) - 0.5), rb = Math.ceil(Math.max(ay, by) - 0.5) - 1;
      if (rb < 0 || ra >= h) continue;
      ra = Math.max(0, ra); rb = Math.min(h - 1, rb);
      const k = (bx - ax) / (by - ay);
      for (let r = ra; r <= rb; r++) { let a = rows.get(r); if (!a) rows.set(r, (a = [])); a.push(ax + (r + 0.5 - ay) * k); }
      if (ra < r0) r0 = ra; if (rb > r1) r1 = rb;
    }
  }
  for (let r = r0; r <= r1; r++) {
    const xs = rows.get(r); if (!xs || xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      let c0 = Math.ceil(xs[k] - 0.5), c1 = Math.ceil(xs[k + 1] - 0.5) - 1;
      if (c1 < 0 || c0 >= w) continue;
      c0 = Math.max(0, c0); c1 = Math.min(w - 1, c1);
      for (let c = c0; c <= c1; c++) set(r * w + c);
    }
  }
}
/** A polyline buffered by halfW (grid units) as one quad per segment, each filled on its own. */
function strokeLine(pts, halfW, w, h, set) {
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const ax = pts[i], ay = pts[i + 1], bx = pts[i + 2], by = pts[i + 3], L = Math.hypot(bx - ax, by - ay);
    if (L < 1e-9) continue;
    const ex = ((bx - ax) / L) * halfW, ey = ((by - ay) / L) * halfW, nx = -ey, ny = ex;
    fillRings([[ax - ex + nx, ay - ey + ny, bx + ex + nx, by + ey + ny, bx + ex - nx, by + ey - ny, ax - ex - nx, ay - ey - ny]], w, h, set);
  }
}
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
/** Exact Euclidean distance (cells) to the nearest seed (seed[i] != 0); Infinity when there is no seed. */
export function edt(seed, w, h) {
  const g = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = seed[i] ? 0 : EDT_INF;
  const n = Math.max(w, h), f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) { for (let y = 0; y < h; y++) f[y] = g[y * w + x]; edt1d(f, h, d, v, z); for (let y = 0; y < h; y++) g[y * w + x] = d[y]; }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) { const o = y * w; for (let x = 0; x < w; x++) f[x] = g[o + x]; edt1d(f, w, d, v, z); for (let x = 0; x < w; x++) out[o + x] = d[x] >= 1e19 ? Infinity : Math.sqrt(d[x]); }
  return out;
}
/** Separable max filter (square window of radius r cells, only `valid` cells count) — the local river width
 *  estimate. Sliding-window maximum with a monotonic deque: O(n) per row / column whatever r. */
function maxFilter(src, w, h, r, valid) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h), n = Math.max(w, h);
  const line = new Float32Array(n), res = new Float32Array(n), dq = new Int32Array(n);
  const pass = (len) => {
    let head = 0, tail = 0;
    for (let i = 0; i < len + r; i++) {
      if (i < len) { while (tail > head && line[dq[tail - 1]] <= line[i]) tail--; dq[tail++] = i; }
      const o = i - r;
      if (o >= 0) { while (dq[head] < o - r) head++; res[o] = line[dq[head]]; }
    }
  };
  for (let y = 0; y < h; y++) { for (let x = 0; x < w; x++) { const i = y * w + x, v = src[i]; line[x] = valid[i] && v !== Infinity ? v : 0; } pass(w); for (let x = 0; x < w; x++) tmp[y * w + x] = res[x]; }
  for (let x = 0; x < w; x++) { for (let y = 0; y < h; y++) line[y] = tmp[y * w + x]; pass(h); for (let y = 0; y < h; y++) out[y * w + x] = res[y]; }
  return out;
}
/** Douglas–Peucker on a flat [x, y, …] list (closed rings keep their first point). */
export function simplify(pts, tol) {
  const n = pts.length / 2;
  if (n <= 2) return pts.slice();
  const keep = new Uint8Array(n); keep[0] = 1; keep[n - 1] = 1;
  const stack = [[0, n - 1]], t2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = pts[2 * a], ay = pts[2 * a + 1], bx = pts[2 * b], by = pts[2 * b + 1], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let best = -1, bd = t2;
    for (let i = a + 1; i < b; i++) {
      const px = pts[2 * i] - ax, py = pts[2 * i + 1] - ay;
      let d2;
      if (L2 === 0) d2 = px * px + py * py;
      else { const t = Math.max(0, Math.min(1, (px * dx + py * dy) / L2)), qx = px - t * dx, qy = py - t * dy; d2 = qx * qx + qy * qy; }
      if (d2 > bd) { bd = d2; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[2 * i], pts[2 * i + 1]);
  return out;
}
function pointInRing(r, x, y) { let c = false; for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) { const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; }
function ringDistance(r, x, y) {
  let best = Infinity;
  for (let i = 0, n = r.length; i < n; i += 2) {
    const ax = r[i], ay = r[i + 1], bx = r[(i + 2) % n], by = r[(i + 3) % n], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
    best = Math.min(best, Math.hypot(ax + t * dx - x, ay + t * dy - y));
  }
  return best;
}
function ringAreaAbs(r) { let a = 0; for (let i = 0, n = r.length; i < n; i += 2) { const j = (i + 2) % n; a += r[i] * r[j + 1] - r[j] * r[i + 1]; } return Math.abs(a) / 2; }
function centroid(r) { let x = 0, y = 0; const n = r.length / 2; for (let i = 0; i < r.length; i += 2) { x += r[i]; y += r[i + 1]; } return [x / n, y / n]; }
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ------------------------------------------------------------------------------------------------ converter
/**
 * convertTile({ z, x, y, mvt, overlay, bathy, hints }) → { z, x, y, n, flags, rev, srcHash, builtAt, uniformH, mask,
 * height, vectors } (the input of encodeTile).
 *   mvt: decodeMVT() output (null / empty → everything is land unless the bathy says sea… callers do not convert
 *        without a base); overlay: compact overlay of the z12 square (server/wtsource.js compactOverlay) or null;
 *   bathy: { x9, y9, dm: Int16Array(256²) } (Terrarium decimetres) or null;
 *   hints: { src, size ('mega'|'major'|'regional'|'minor'|null = nearest harbour within 25 km), port (a harbour's port
 *            area reaches this tile), bigport (id), guard (default true), iala ('A'|'B'), builtAt (unix s) }.
 */
export function convertTile({ z, x, y, mvt, overlay = null, bathy = null, hints = {} }) {
  const N = WT.N, detail = z >= WT.Z_DETAIL;
  const latC = tileFToLatLon(z, x + 0.5, y + 0.5).lat, sizeM = tileSizeM(z, latC), cellM = sizeM / N;
  const layers = mvt?.layers || {};
  const extent = layers.water?.extent || layers.landuse?.extent || 4096;
  const B = 4;                                      // buffer cells kept on every side (64 / 4096 × 256)
  const W = N + 2 * B, WW = W * W, SW = W * S;
  const toG = (s) => (u) => u * (N * s) / extent + B * s;   // tile units → grid units at resolution s
  const g1 = toG(1), gS = toG(S);
  const mapRing = (ring, f) => { const o = new Array(ring.length); for (let i = 0; i < ring.length; i++) o[i] = f(ring[i]); return o; };
  const size = hints.size || null, sizeKey = size || 'none';
  const quayTop = QUAY_TOP(size);
  const mPerUnit = sizeM / extent;

  // ---------------------------------------------------------------- 1. water (supersampled)
  const ws = new Uint8Array(SW * SW);
  const waterFeats = (layers.water?.features || []).filter((f) => f.type === 3);
  const byClass = (c) => waterFeats.filter((f) => {
    const k = f.tags.class || 'lake';
    if (f.tags.brunnel === 'tunnel' || k === 'swimming_pool') return false;
    if (f.tags.intermittent === 1 || f.tags.intermittent === true) return false;
    const code = W_CLASS[k] ?? W_CLASS.lake;
    if (code !== c) return false;
    if (k === 'pond') { let a = 0; for (const p of f.geom) a += ringAreaAbs(p[0]) - p.slice(1).reduce((s, r) => s + ringAreaAbs(r), 0); if (a * mPerUnit * mPerUnit < 2000) return false; }
    return true;
  });
  for (const c of [W_CLASS.ocean, W_CLASS.lake, W_CLASS.river, W_CLASS.dock]) {
    for (const f of byClass(c)) for (const poly of f.geom) fillRings(poly.map((r) => mapRing(r, gS)), SW, SW, (i) => { ws[i] = c; });
  }
  if (detail) {     // river / canal lines without a polygon (streams, ditches and drains are ignored)
    for (const f of layers.waterway?.features || []) {
      if (f.type !== 2 || f.tags.brunnel === 'tunnel' || (f.tags.class !== 'river' && f.tags.class !== 'canal')) continue;
      const wM = Number(f.tags.width) > 0 ? Number(f.tags.width) : f.tags.class === 'river' ? 30 : 20;
      const half = (wM / 2 / cellM) * S;
      for (const l of f.geom) strokeLine(mapRing(l, gS), half, SW, SW, (i) => { if (!ws[i]) ws[i] = 5; });
    }
  }
  // piers (OpenFreeMap transportation class=pier) and overlay structures, supersampled like the water
  const ss = new Uint8Array(SW * SW);    // structure samples: QUAY / BREAKWATER / PONTOON codes + 1
  if (detail) {
    for (const f of layers.transportation?.features || []) {
      if (f.tags.class !== 'pier') continue;
      if (f.type === 3) for (const poly of f.geom) fillRings(poly.map((r) => mapRing(r, gS)), SW, SW, (i) => { ss[i] = M.QUAY + 1; });
      else if (f.type === 2) for (const l of f.geom) strokeLine(mapRing(l, gS), (4 / cellM) * S, SW, SW, (i) => { ss[i] = M.QUAY + 1; });
    }
  }
  // overlay geometry → tile units
  const ov = overlay && Array.isArray(overlay.f) ? overlay : null;
  const ovUnits = (g) => { const o = []; for (let i = 0; i + 1 < g.length; i += 2) { const t = tileF(z, g[i], g[i + 1]); o.push((t.fx - x) * extent, (t.fy - y) * extent); } return o; };
  const ovFeats = ov ? ov.f.map((f) => ({ ...f, u: ovUnits(f.g) })).filter((f) => f.u.some((v, i) => (i % 2 === 0 ? v > -extent * 0.1 && v < extent * 1.1 : v > -extent * 0.1 && v < extent * 1.1))) : [];
  const lockS = new Uint8Array(SW * SW), fairS = new Uint8Array(SW * SW), depthDm = new Int16Array(WW);
  if (detail) {
    for (const f of ovFeats) {
      const gpts = mapRing(f.u, gS);
      if (f.k === 'breakwater') { if (f.c) fillRings([gpts], SW, SW, (i) => { ss[i] = M.BREAKWATER + 1; }); else strokeLine(gpts, (6 / cellM) * S, SW, SW, (i) => { ss[i] = M.BREAKWATER + 1; }); }
      else if (f.k === 'pier') { if (f.c) fillRings([gpts], SW, SW, (i) => { ss[i] = M.QUAY + 1; }); else strokeLine(gpts, (4 / cellM) * S, SW, SW, (i) => { ss[i] = M.QUAY + 1; }); }
      else if (f.k === 'pontoon') { if (f.c) fillRings([gpts], SW, SW, (i) => { ss[i] = M.PONTOON + 1; }); else strokeLine(gpts, (2 / cellM) * S, SW, SW, (i) => { ss[i] = M.PONTOON + 1; }); }
      else if (f.k === 'lock') { if (f.c) fillRings([gpts], SW, SW, (i) => { lockS[i] = 1; }); else strokeLine(gpts, (12 / cellM) * S, SW, SW, (i) => { lockS[i] = 1; }); }
      else if ((f.k === 'fairway' || f.k === 'dredged') && f.c) {
        fillRings([gpts], SW, SW, (i) => { fairS[i] = 1; });
        const d = Number(f.t['seamark:dredged_area:minimum_depth'] ?? f.t['seamark:fairway:minimum_depth'] ?? f.t.depth ?? (Number(f.t.maxdraught) > 0 ? Number(f.t.maxdraught) + 1 : NaN));
        if (d > 0 && d < 40) fillRings([mapRing(f.u, g1)], W, W, (i) => { depthDm[i] = Math.max(depthDm[i], Math.round(d * 10)); });
      }
    }
  }

  // ---------------------------------------------------------------- cell reduction + classification
  const cls = new Uint8Array(WW);      // dominant water class per cell (W_CLASS; 5 = stroked line)
  const mask = reduceCells(ws, ss, lockS, fairS, W, SW, cls);
  // land use / land cover at cell centres
  const lu = new Uint8Array(WW);
  const LU_OF = { industrial: LU_PORT, railway: LU_PORT, commercial: LU_COM, retail: LU_COM, residential: LU_RES, military: 0 };
  for (const f of layers.landuse?.features || []) { const b = LU_OF[f.tags.class]; if (b && f.type === 3) for (const poly of f.geom) fillRings(poly.map((r) => mapRing(r, g1)), W, W, (i) => { lu[i] |= b; }); }
  const LC_OF = { sand: LU_SAND, grass: LU_GRASS, wood: LU_WOOD, forest: LU_WOOD };
  for (const f of layers.landcover?.features || []) { const b = LC_OF[f.tags.class] || (f.tags.subclass === 'beach' ? LU_SAND : 0); if (b && f.type === 3) for (const poly of f.geom) fillRings(poly.map((r) => mapRing(r, g1)), W, W, (i) => { lu[i] |= b; }); }
  // docks by context: lake / sea / river water inside port land (industrial) when a harbour's port area reaches the tile
  // docks by context: inside a port area, water inside port land (industrial) and lake-class basins within 300 m of
  // port land are docks (OpenFreeMap maps many harbour basins as `lake`); a lake away from the quays (the Brielse Meer)
  // stays a lake
  if (hints.port) {
    const portLand = new Uint8Array(WW); for (let c = 0; c < WW; c++) portLand[c] = lu[c] & LU_PORT && !WT_NAVIGABLE[mask[c]] ? 1 : 0;
    const dPort = edt(portLand, W, W), near = 300 / cellM;
    for (let c = 0; c < WW; c++) if ((mask[c] === M.WATER || mask[c] === M.RIVER) && (lu[c] & LU_PORT || (cls[c] === W_CLASS.lake && dPort[c] <= near))) mask[c] = M.DOCK;
  }
  // buildings: BUILDING on land, QUAY over water (a pier shed)
  const bldFeats = detail ? (layers.building?.features || []).filter((f) => f.type === 3) : [];
  for (const f of bldFeats) for (const poly of f.geom) fillRings([mapRing(poly[0], g1)], W, W, (i) => { mask[i] = WT_NAVIGABLE[mask[i]] ? M.QUAY : mask[i] === M.LAND ? M.BUILDING : mask[i]; });
  // big-port guard (§3.4.1-7): the hand-checked port water of server/bigports never closes
  const bp = hints.bigport && hints.guard !== false ? bigPortById(hints.bigport) : null;
  if (bp) {
    const lats = new Float64Array(W), lons = new Float64Array(W);    // Mercator: latitude depends on the row only
    for (let k = 0; k < W; k++) { lats[k] = tileFToLatLon(z, x, y + (k - B + 0.5) / N).lat; lons[k] = tileFToLatLon(z, x + (k - B + 0.5) / N, y).lon; }
    for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
      const c = j * W + i;
      const k = portWaterKind(bp, lats[j], lons[i]);
      if (k <= BP_KIND.LAND) continue;
      if (!WT_NAVIGABLE[mask[c]] && mask[c] !== M.QUAY && mask[c] !== M.BREAKWATER) mask[c] = k === BP_KIND.DOCK ? M.DOCK : k === BP_KIND.RIVER || k === BP_KIND.CANAL ? M.RIVER : M.WATER;
      else if (k === BP_KIND.DOCK && mask[c] === M.WATER) mask[c] = M.DOCK;
      if ((mask[c] === M.WATER || mask[c] === M.RIVER) && portIsFairway(bp, lats[j], lons[i])) mask[c] = M.FAIRWAY;
    }
  }

  // ---------------------------------------------------------------- 2. specks
  fillSpecks(mask, W);

  // ---------------------------------------------------------------- 3. derived quays
  const nav = new Uint8Array(WW); for (let c = 0; c < WW; c++) nav[c] = WT_NAVIGABLE[mask[c]];
  const structSeed = new Uint8Array(WW); for (let c = 0; c < WW; c++) structSeed[c] = mask[c] === M.QUAY || mask[c] === M.BUILDING || mask[c] === M.PONTOON ? 1 : 0;
  const dStruct = edt(structSeed, W, W);
  const vecQuays = [];
  const quaySeed = new Uint8Array(WW);
  const cellAt = (cx, cy) => { const i = Math.floor(cx), j = Math.floor(cy); return i >= 0 && j >= 0 && i < W && j < W ? j * W + i : -1; };
  if (detail) {
    for (const run of quayRuns(nav, W, cellM)) {
      // condition samples every ~10 m: dock water, port / commercial land, or a pier / building within 25 m
      const { p, nx, ny } = run;
      let ok = 0, tot = 0;
      for (let t = 0; t <= 1.0001; t += Math.min(1, 10 / run.len)) {
        const px = p[0] + (p[2] - p[0]) * t, py = p[1] + (p[3] - p[1]) * t, cw = cellAt(px + nx * 1.5, py + ny * 1.5), cl = cellAt(px - nx * 1.5, py - ny * 1.5);
        tot++;
        if ((cw >= 0 && (mask[cw] === M.DOCK || mask[cw] === M.LOCK)) || (cl >= 0 && (lu[cl] & (LU_PORT | LU_COM) || mask[cl] === M.QUAY)) || (cl >= 0 && dStruct[cl] * cellM <= 25)) ok++;
      }
      if (ok * 2 < tot) continue;
      for (let t = 0; t <= run.len / cellM; t += 0.5) {
        const f = t / (run.len / cellM), px = p[0] + (p[2] - p[0]) * f, py = p[1] + (p[3] - p[1]) * f;
        const cw = cellAt(px + nx * 0.7, py + ny * 0.7), cl = cellAt(px - nx * 0.7, py - ny * 0.7);
        if (cw >= 0 && nav[cw]) quaySeed[cw] = 1;
        if (cl >= 0 && mask[cl] === M.LAND) mask[cl] = M.QUAY;
      }
      const mid = [(p[0] + p[2]) / 2 - B, (p[1] + p[3]) / 2 - B];
      if (mid[0] >= 0 && mid[1] >= 0 && mid[0] < N && mid[1] < N) vecQuays.push({ p: p.map((v) => Math.round((v - B) * cellM * 10)), side: 1, k: 'derived', top: quayTop });
    }
  }
  // overlay quays: a 6 m band on the land side, the water next to them is a berth pocket
  const osmQuays = [];
  if (detail) for (const f of ovFeats) {
    if (f.k !== 'quay') continue;
    const gp = mapRing(f.u, g1);
    strokeLine(gp, 3 / cellM, W, W, (i) => { if (!WT_NAVIGABLE[mask[i]] && mask[i] !== M.BREAKWATER) mask[i] = M.QUAY; });
    strokeLine(gp, 3 / cellM + 1, W, W, (i) => { if (WT_NAVIGABLE[mask[i]]) quaySeed[i] = 1; });
    let side = 0;
    for (let i = 0; i + 3 < gp.length; i += 2) {
      const dx = gp[i + 2] - gp[i], dy = gp[i + 3] - gp[i + 1], L = Math.hypot(dx, dy); if (L < 1e-6) continue;
      const c = cellAt((gp[i] + gp[i + 2]) / 2 - (dy / L) * 2, (gp[i + 1] + gp[i + 3]) / 2 + (dx / L) * 2);
      if (c >= 0) side += WT_NAVIGABLE[mask[c]] ? 1 : -1;
    }
    osmQuays.push({ p: simplify(gp.map((v) => (v - B) * cellM), 1).map((v) => Math.round(v * 10)), side: side >= 0 ? 1 : -1, k: 'osm', top: quayTop });
  }
  // pier edges are berths too
  const berthy = (q) => mask[q] === M.QUAY || mask[q] === M.PONTOON;
  for (let c = 0; c < WW; c++) if (WT_NAVIGABLE[mask[c]]) {
    const i = c % W;
    if ((i > 0 && berthy(c - 1)) || (i < W - 1 && berthy(c + 1)) || (c >= W && berthy(c - W)) || (c < WW - W && berthy(c + W))) quaySeed[c] = 1;
  }

  // ---------------------------------------------------------------- 4. depth and heights
  for (let c = 0; c < WW; c++) nav[c] = WT_NAVIGABLE[mask[c]];
  const obst = new Uint8Array(WW); for (let c = 0; c < WW; c++) obst[c] = nav[c] ? 0 : 1;
  const dLand = edt(obst, W, W), dWater = edt(nav, W, W), dQuay = edt(quaySeed, W, W);
  let riverW = null;
  for (let c = 0; c < WW; c++) if (mask[c] === M.RIVER) { riverW = maxFilter(dLand, W, W, Math.max(1, Math.round(200 / cellM)), nav); break; }
  const hasBathy = !!(bathy && bathy.dm && bathy.dm.length === 65536);
  const bk = 2 ** (z - WT.Z_BATHY);
  const bathyAt = (i, j) => {
    if (!hasBathy) return null;
    const bx = ((x + (i - B + 0.5) / N) / bk - bathy.x9) * 256 - 0.5, by = ((y + (j - B + 0.5) / N) / bk - bathy.y9) * 256 - 0.5;
    const x0 = clamp(Math.floor(bx), 0, 254), y0 = clamp(Math.floor(by), 0, 254), fx = clamp(bx - x0, 0, 1), fy = clamp(by - y0, 0, 1);
    const g = (a, b) => bathy.dm[b * 256 + a] / 10;
    return (g(x0, y0) * (1 - fx) + g(x0 + 1, y0) * fx) * (1 - fy) + (g(x0, y0 + 1) * (1 - fx) + g(x0 + 1, y0 + 1) * fx) * fy;
  };
  const H = new Float32Array(WW);
  let nBathy = 0, nClass = 0;
  for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
    const c = j * W + i, m = mask[c];
    if (nav[c]) {
      const dL = dLand[c] === Infinity ? Infinity : Math.max(0, dLand[c] - 0.5) * cellM;
      let D, fromBathy = false;
      if (depthDm[c] > 0) D = depthDm[c] / 10;
      else if (m === M.FAIRWAY) D = FAIRWAY_DEPTH[sizeKey];
      else if (m === M.DOCK || m === M.LOCK) D = DOCK_DEPTH[sizeKey];
      else if (m === M.RIVER) D = RIVER_DEPTH(riverW ? 2 * riverW[c] * cellM : 0);
      else {
        const b = bathyAt(i, j);
        if (b != null && b <= -3) { D = -b; fromBathy = true; }
        else D = Math.max(1.5, Math.min(25, 1.5 + 0.06 * (dL === Infinity ? 1e6 : dL)));
      }
      if (hints.port && (m === M.WATER || m === M.RIVER) && cls[c] !== W_CLASS.lake && !(depthDm[c] > 0)) D = Math.max(D, Math.min(PORT_FLOOR[sizeKey], 0.5 + 0.15 * (dL === Infinity ? 1e6 : dL)));
      const natural = dLand[c] !== Infinity && dQuay[c] > dLand[c] + 1;
      if (natural && dL < 30) D = Math.min(D, 0.5 + 0.15 * dL);
      if (D < 0.5) D = 0.5;
      if (fromBathy) nBathy++; else nClass++;
      H[c] = -D;
    } else {
      const dW = dWater[c] === Infinity ? Infinity : Math.max(0, dWater[c] - 0.5) * cellM;
      let h;
      if (m === M.QUAY) h = quayTop;
      else if (m === M.BREAKWATER) h = 4;
      else if (m === M.PONTOON) h = 1;
      else if (lu[c] & LU_PORT && dW < 400) h = quayTop;
      else h = Math.min(20, 1 + 0.02 * (dW === Infinity ? 1e6 : dW));
      H[c] = Math.max(0.25, h);
    }
  }

  // ---------------------------------------------------------------- output grid (crop the buffer)
  const outMask = new Uint8Array(N * N), outH = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const c = (j + B) * W + i + B, o = j * N + i;
    outMask[o] = mask[c];
    let v = encodeWTHeight(H[c]);
    if (WT_NAVIGABLE[mask[c]] && v > 126) v = 126; else if (WT_OBSTACLE[mask[c]] && v < 129) v = 129;
    outH[o] = v;
  }

  // ---------------------------------------------------------------- 5. vectors
  let vectors = null;
  if (detail) {
    const toDm = (u) => Math.round(u * mPerUnit * 10);
    const ringDm = (r, tol) => simplify(r.map((u) => u * mPerUnit), tol).map((v) => Math.round(v * 10));
    const inTile = (cx, cy) => cx >= 0 && cy >= 0 && cx < extent && cy < extent;
    const luAtUnits = (ux, uy) => { const c = cellAt(g1(ux), g1(uy)); return c >= 0 ? lu[c] : 0; };
    // buildings (centroid inside the tile: no duplicates across neighbours), largest first
    const blds = [];
    for (const f of bldFeats) for (const poly of f.geom) {
      const r = poly[0], [cx, cy] = centroid(r);
      if (!inTile(cx, cy)) continue;
      const area = ringAreaAbs(r) * mPerUnit * mPerUnit;
      if (area < 4) continue;
      const l = luAtUnits(cx, cy);
      const k = l & LU_PORT ? (area > 2000 ? 'shed' : 'industrial') : l & LU_RES ? 'residential' : l & LU_COM ? 'commercial' : 'other';
      const rh = Number(f.tags.render_height), mh = Number(f.tags.render_min_height) || 0;
      const tagged = Number.isFinite(rh) && rh > 0 && !(rh === 5 && mh === 0);
      const est = k === 'shed' || k === 'industrial' ? clamp(6 + Math.sqrt(area) / 8, 8, 22) : k === 'residential' ? 9 : k === 'commercial' ? 14 : 8;
      blds.push({ area, b: { r: ringDm(r, 0.5), h: Math.round(Math.min(300, tagged ? rh : est) * 10) / 10, mh: Math.round(Math.min(300, mh) * 10) / 10, k, e: tagged ? 0 : 1 } });
    }
    blds.sort((a, b) => b.area - a.area || a.b.r[0] - b.b.r[0] || a.b.r[1] - b.b.r[1]);
    const piers = [];
    for (const f of layers.transportation?.features || []) {
      if (f.tags.class !== 'pier') continue;
      if (f.type === 3) for (const poly of f.geom) { const [cx, cy] = centroid(poly[0]); if (inTile(cx, cy)) piers.push({ r: ringDm(poly[0], 1), k: 'pier', top: 2.5 }); }
      else if (f.type === 2) for (const l of f.geom) { const [cx, cy] = centroid(l); if (inTile(cx, cy)) piers.push({ r: bufferRing(l.map((u) => u * mPerUnit), 4).map((v) => Math.round(v * 10)), k: f.tags.subclass === 'jetty' ? 'jetty' : 'pier', top: 2.5 }); }
    }
    const ovLocal = (f) => f.u.map((u) => u * mPerUnit);
    const insideU = (f) => { const [cx, cy] = f.c ? centroid(f.u) : [f.u[0], f.u[1]]; return inTile(cx, cy); };
    const breakwaters = [], pontoons = [], tanks = [], cranes = [], lights = [], locks = [], gates = [];
    for (const f of ovFeats) {
      if (!insideU(f)) continue;
      const pts = ovLocal(f);
      if (f.k === 'breakwater') breakwaters.push({ r: (f.c ? simplify(pts, 1) : bufferRing(pts, 6)).map((v) => Math.round(v * 10)), top: 4 });
      else if (f.k === 'pontoon') pontoons.push({ r: (f.c ? simplify(pts, 0.5) : bufferRing(pts, 2)).map((v) => Math.round(v * 10)) });
      else if (f.k === 'pier' && f.c) piers.push({ r: simplify(pts, 1).map((v) => Math.round(v * 10)), k: 'pier', top: 2.5 });
      else if (f.k === 'tank') {
        const [cx, cy] = f.c ? centroid(pts) : [pts[0], pts[1]];
        const dia = Number(f.t.diameter) > 0 ? Number(f.t.diameter) : f.c ? 2 * Math.sqrt(ringAreaAbs(pts) / Math.PI) : 20;
        tanks.push({ x: Math.round(cx * 10), z: Math.round(cy * 10), r: Math.round(dia * 5), h: Math.round((Number(f.t.height) > 0 ? Number(f.t.height) : clamp(0.8 * dia, 10, 30)) * 10) / 10 });
      } else if (f.k === 'crane') {
        const [cx, cy] = f.c ? centroid(pts) : [pts[0], pts[1]];
        const ct = String(f.t['crane:type'] || '');
        const k = /container_crane|gantry_crane/.test(ct) ? 'sts' : /portal/.test(ct) ? 'portal' : /mobile/.test(ct) ? 'mobile' : 'other';
        cranes.push({ x: Math.round(cx * 10), z: Math.round(cy * 10), k, hdg: Math.round(quayHeading(cx, cy, vecQuays.concat(osmQuays))), h: Number(f.t.height) > 0 ? Number(f.t.height) : k === 'sts' ? 70 : k === 'portal' ? 35 : k === 'mobile' ? 40 : 30 });
      } else if (f.k === 'lighthouse' || f.k === 'light' || f.k === 'beacon' || f.k === 'buoy') {
        const st = String(f.t['seamark:type'] || '');
        const k = f.k === 'lighthouse' || st === 'light_major' ? 'lighthouse' : f.k === 'buoy' || st === 'light_vessel' || st === 'light_float' ? 'buoy' : 'beacon';
        const kind = st || 'light';
        const col = f.t[`seamark:${kind}:colour`] || f.t['seamark:light:colour'] || null;
        const chr = f.t['seamark:light:character'] || f.t[`seamark:${kind}:character`] || null, per = f.t['seamark:light:period'] || null;
        const ch = chr ? `${chr}${col ? '.' + String(col).slice(0, 1).toUpperCase() : ''}${per ? '.' + per + 's' : ''}` : null;
        lights.push({ x: Math.round(pts[0] * 10), z: Math.round(pts[1] * 10), k, col, ch, h: Number(f.t.height) > 0 ? Number(f.t.height) : k === 'lighthouse' ? 20 : k === 'beacon' ? 5 : 2, iala: hints.iala || null });
      } else if (f.k === 'lock' && f.c) locks.push({ r: simplify(pts, 1).map((v) => Math.round(v * 10)), gates: [], name: f.t.name || null, pts });
      else if (f.k === 'lock_gate') gates.push(f.c || pts.length >= 4 ? [pts[0], pts[1], pts[pts.length - 2], pts[pts.length - 1]] : [pts[0] - 10, pts[1], pts[0] + 10, pts[1]]);
    }
    for (const g of gates) {     // a gate belongs to the lock chamber containing its middle, or the nearest one ≤ 50 m away
      const gx = (g[0] + g[2]) / 2, gy = (g[1] + g[3]) / 2;
      let best = null, bd = 50;
      for (const l of locks) { const d = pointInRing(l.pts, gx, gy) ? 0 : ringDistance(l.pts, gx, gy); if (d < bd || (d === 0 && bd > 0)) { bd = d; best = l; } }
      if (best) best.gates.push(g.map((v) => Math.round(v * 10)));
    }
    // bridges over water (OpenFreeMap brunnel=bridge), clearance estimated from the water width
    const bridges = [];
    for (const f of layers.transportation?.features || []) {
      if (f.type !== 2 || f.tags.brunnel !== 'bridge') continue;
      for (const l of f.geom) {
        const [cx, cy] = centroid(l); if (!inTile(cx, cy)) continue;
        let wet = 0, wmax = 0;
        for (let i = 0; i + 1 < l.length; i += 2) {
          const n = i + 3 < l.length ? 4 : 1;
          for (let t = 0; t < n; t++) {
            const ux = i + 3 < l.length ? l[i] + ((l[i + 2] - l[i]) * t) / n : l[i], uy = i + 3 < l.length ? l[i + 1] + ((l[i + 3] - l[i + 1]) * t) / n : l[i + 1];
            const c = cellAt(g1(ux), g1(uy));
            if (c >= 0 && nav[c]) { wet++; if (dLand[c] !== Infinity) wmax = Math.max(wmax, 2 * dLand[c] * cellM); }
          }
        }
        if (!wet) continue;
        const cls = String(f.tags.class || ''), k = /rail|transit/.test(cls) ? 'rail' : /path|track|footway|cycleway/.test(cls) ? 'foot' : 'road';
        const big = /motorway|trunk|rail/.test(cls);
        const clr = big && wmax > 300 ? 35 : big && wmax > 100 ? 15 : 6;
        const w = /motorway|trunk/.test(cls) ? 30 : /primary/.test(cls) ? 20 : /secondary/.test(cls) ? 14 : k === 'rail' ? 10 : k === 'foot' ? 4 : 8;
        bridges.push({ p: simplify(l.map((u) => u * mPerUnit), 1).map((v) => Math.round(v * 10)), w, deck: clr + 1.5, clr, mov: 0, k, e: 1 });
      }
    }
    // areas (land use / cover), largest first
    const areas = [];
    const AREA_K = { industrial: hints.port ? 'port' : 'industrial', railway: 'industrial', commercial: 'commercial', retail: 'commercial', residential: 'residential' };
    const addArea = (f, k) => { for (const poly of f.geom) { const [cx, cy] = centroid(poly[0]); if (!inTile(cx, cy)) continue; areas.push({ a: ringAreaAbs(poly[0]), v: { r: ringDm(poly[0], 2), k } }); } };
    for (const f of layers.landuse?.features || []) if (f.type === 3 && AREA_K[f.tags.class]) addArea(f, AREA_K[f.tags.class]);
    for (const f of layers.landcover?.features || []) { const k = f.tags.class === 'sand' || f.tags.subclass === 'beach' ? 'sand' : f.tags.class === 'grass' ? 'grass' : f.tags.class === 'wood' || f.tags.class === 'forest' ? 'wood' : null; if (k && f.type === 3) addArea(f, k); }
    for (const f of layers.transportation?.features || []) if (f.type === 3 && f.tags.class === 'parking') addArea(f, 'parking');
    areas.sort((a, b) => b.a - a.a || a.v.r[0] - b.v.r[0] || a.v.r[1] - b.v.r[1]);
    lights.sort((a, b) => a.x - b.x || a.z - b.z);
    vectors = {
      v: 1, src: hints.src || null, ov: ov ? `ovp:${ov.date}` : null,
      quays: osmQuays.concat(vecQuays), piers, breakwaters, pontoons,
      buildings: blds.slice(0, CAPS.buildings).map((b) => b.b), tanks, cranes, bridges,
      locks: locks.map(({ pts, ...l }) => l), lights: lights.slice(0, CAPS.lights), areas: areas.slice(0, CAPS.areas).map((a) => a.v),
      depthSrc: nBathy && nClass ? 'mixed' : nBathy ? 'bathy' : 'class',
    };
  }

  // ---------------------------------------------------------------- uniform tiles
  let flags = (ov ? WT.FLAG.OVERLAY : 0) | (detail ? 0 : WT.FLAG.NO_VECTORS);
  const first = outMask[0];
  let uniform = (first === M.WATER || first === M.LAND);
  for (let c = 0; uniform && c < WW; c++) if (mask[c] !== first) uniform = false;     // incl. the buffer: a coast just
  // across the edge shapes this tile's shore ramp, so the tile must keep its cells (seams)
  const emptyVec = !vectors || !(vectors.quays.length || vectors.piers.length || vectors.breakwaters.length || vectors.pontoons.length || vectors.buildings.length || vectors.tanks.length || vectors.cranes.length || vectors.bridges.length || vectors.locks.length || vectors.lights.length || vectors.areas.length);
  let uniformH = 0;
  if (uniform && emptyVec) {
    flags |= WT.FLAG.UNIFORM | (first === M.LAND ? WT.FLAG.UNIFORM_LAND : 0);
    let s = 0; for (let o = 0; o < outH.length; o++) s += H[(Math.floor(o / N) + B) * W + (o % N) + B];
    uniformH = Math.round((s / outH.length) * 10) / 10;
    if (first === M.WATER) uniformH = Math.min(-0.5, uniformH); else uniformH = Math.max(0.3, uniformH);
    vectors = null;
  }
  const srcHash = srcHashOf(hints.src, ov ? ov.date : '');
  return {
    z, x, y, n: N, flags, rev: ov ? 1 : 0, srcHash, builtAt: hints.builtAt >>> 0, uniformH,
    mask: flags & WT.FLAG.UNIFORM ? null : outMask, height: flags & WT.FLAG.UNIFORM ? null : outH, vectors,
  };
}

/** A polyline (metres) buffered by halfW into one closed ring (left side forward, right side back). */
function bufferRing(pts, halfW) {
  const n = pts.length / 2, L = [], R = [];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    const dx = pts[2 * b] - pts[2 * a], dy = pts[2 * b + 1] - pts[2 * a + 1], len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * halfW, ny = (dx / len) * halfW;
    L.push(pts[2 * i] + nx, pts[2 * i + 1] + ny); R.unshift(pts[2 * i] - nx, pts[2 * i + 1] - ny);
  }
  return L.concat(R);
}
/** Heading (deg, 0 = north / −z, clockwise) of the quay nearest to (x, z) metres; 0 when there is none. */
function quayHeading(x, zz, quays) {
  let best = null, bd = 150 * 150;
  for (const q of quays) for (let i = 0; i + 3 < q.p.length; i += 2) {
    const ax = q.p[i] / 10, ay = q.p[i + 1] / 10, bx = q.p[i + 2] / 10, by = q.p[i + 3] / 10, dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
    const t = clamp(((x - ax) * dx + (zz - ay) * dy) / L2, 0, 1), d2 = (ax + t * dx - x) ** 2 + (ay + t * dy - zz) ** 2;
    if (d2 < bd) { bd = d2; best = [dx, dy]; }
  }
  if (!best) return 0;
  return ((Math.atan2(best[0], -best[1]) * 180) / Math.PI + 360) % 360;
}

/**
 * Straight runs (≥ 30 m) of the water / land boundary: marching squares over the cell centres (water = 1), chained
 * with water on the right, simplified (DP max(2 m, 0.6 cell)), split where the direction turns > 12°.
 * Returns [{ p: [x0, y0, x1, y1] (work-grid cell units), nx, ny (unit normal towards the water), len (m) }].
 */
export function quayRuns(nav, W, cellM) {
  const segs = new Map();      // start key → [end key, …]
  const key = (x2, y2) => x2 * 8192 + y2;    // doubled coordinates (cell centres at odd numbers)
  const add = (ax, ay, bx, by) => {
    // orient so that water lies on the right of a → b (right normal in x east / y south = (-dy, dx))
    const mx = (ax + bx) / 4, my = (ay + by) / 4, dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
    const px = mx + (-dy / L) * 0.3, py = my + (dx / L) * 0.3;
    if (sampleNav(nav, W, px, py) < 0.5) { const t = ax; ax = bx; bx = t; const u = ay; ay = by; by = u; }
    const k = key(ax, ay); let a = segs.get(k); if (!a) segs.set(k, (a = [])); a.push(key(bx, by));
  };
  for (let j = 0; j + 1 < W; j++) for (let i = 0; i + 1 < W; i++) {
    const a = nav[j * W + i], b = nav[j * W + i + 1], c = nav[(j + 1) * W + i + 1], d = nav[(j + 1) * W + i];
    const code = a | (b << 1) | (c << 2) | (d << 3);
    if (code === 0 || code === 15) continue;
    // edge midpoints in doubled coordinates of the cell-centre lattice (centre of cell i at 2i+1)
    const T = [2 * i + 2, 2 * j + 1], R = [2 * i + 3, 2 * j + 2], Bt = [2 * i + 2, 2 * j + 3], L = [2 * i + 1, 2 * j + 2];
    const E = { 1: [[L, T]], 2: [[T, R]], 3: [[L, R]], 4: [[R, Bt]], 5: [[L, T], [R, Bt]], 6: [[T, Bt]], 7: [[L, Bt]], 8: [[Bt, L]], 9: [[Bt, T]], 10: [[T, R], [Bt, L]], 11: [[Bt, R]], 12: [[R, L]], 13: [[R, T]], 14: [[T, L]] }[code];
    for (const [p, q] of E) add(p[0], p[1], q[0], q[1]);
  }
  // chain
  const used = new Set(), lines = [];
  const indeg = new Map();
  for (const [, ends] of segs) for (const e of ends) indeg.set(e, (indeg.get(e) || 0) + 1);
  const starts = [...segs.keys()].sort((p, q) => (indeg.get(p) || 0) - (indeg.get(q) || 0) || p - q);
  for (const s of starts) {
    const ends = segs.get(s);
    for (let e = 0; e < ends.length; e++) {
      const id = s + ':' + e; if (used.has(id)) continue;
      used.add(id);
      const pts = [Math.floor(s / 8192) / 2, (s % 8192) / 2];
      let cur = ends[e];
      for (let guard = 0; guard < 200000; guard++) {
        pts.push(Math.floor(cur / 8192) / 2, (cur % 8192) / 2);
        const nx = segs.get(cur); if (!nx) break;
        let k = -1; for (let t = 0; t < nx.length; t++) if (!used.has(cur + ':' + t)) { k = t; break; }
        if (k < 0) break;
        used.add(cur + ':' + k); cur = nx[k];
      }
      lines.push(pts);
    }
  }
  const tol = Math.max(2, 0.6 * cellM) / cellM, out = [];
  for (const l of lines) {
    const p = simplify(l, tol);
    let i = 0;
    while (i + 3 < p.length) {
      const dx0 = p[i + 2] - p[i], dy0 = p[i + 3] - p[i + 1], a0 = Math.atan2(dy0, dx0);
      let k = i + 2;
      while (k + 3 < p.length) { const a = Math.atan2(p[k + 3] - p[k + 1], p[k + 2] - p[k]); let da = Math.abs(a - a0); if (da > Math.PI) da = 2 * Math.PI - da; if (da > (12 * Math.PI) / 180) break; k += 2; }
      const x0 = p[i], y0 = p[i + 1], x1 = p[k], y1 = p[k + 1], len = Math.hypot(x1 - x0, y1 - y0) * cellM;
      if (len >= 30) { const L = Math.hypot(x1 - x0, y1 - y0); out.push({ p: [x0, y0, x1, y1], nx: -(y1 - y0) / L, ny: (x1 - x0) / L, len }); }
      i = k;
    }
  }
  return out;
}
/** Bilinear navigability over cell centres at continuous cell coords (centre of cell i at i + 0.5). */
function sampleNav(nav, W, x, y) {
  const u = x - 0.5, v = y - 0.5, i = Math.floor(u), j = Math.floor(v), fx = u - i, fy = v - j;
  const g = (a, b) => (a < 0 || b < 0 || a >= W || b >= W ? 0 : nav[b * W + a]);
  return (g(i, j) * (1 - fx) + g(i + 1, j) * fx) * (1 - fy) + (g(i, j + 1) * (1 - fx) + g(i + 1, j + 1) * fx) * fy;
}

/** Cells from the supersampled rasters: water when ≥ half of the samples are water (dominant class; ties dock > line >
 *  river > lake > ocean), LOCK / FAIRWAY overlay areas on water, structures (QUAY / BREAKWATER / PONTOON) on top. */
function reduceCells(ws, ss, lockS, fairS, W, SW, cls) {
  const mask = new Uint8Array(W * W).fill(M.LAND), cnt = new Int32Array(6), half = (S * S) / 2;
  for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
    let nW = 0, nS = 0, nL = 0, nF = 0, st = 0;
    cnt[1] = cnt[2] = cnt[3] = cnt[4] = cnt[5] = 0;
    for (let b = 0; b < S; b++) {
      const row = (j * S + b) * SW + i * S;
      for (let a = 0; a < S; a++) {
        const k = row + a, v = ws[k];
        if (v) { nW++; cnt[v]++; }
        if (ss[k]) { nS++; st = ss[k] - 1; }
        if (lockS[k]) nL++;
        if (fairS[k]) nF++;
      }
    }
    const c = j * W + i;
    if (nW >= half) {
      let best = 4, bc = cnt[4];
      if (cnt[5] > bc) { best = 5; bc = cnt[5]; }
      if (cnt[3] > bc) { best = 3; bc = cnt[3]; }
      if (cnt[2] > bc) { best = 2; bc = cnt[2]; }
      if (cnt[1] > bc) { best = 1; bc = cnt[1]; }
      cls[c] = best;
      let m = best === W_CLASS.dock ? M.DOCK : best === W_CLASS.river || best === 5 ? M.RIVER : M.WATER;
      if (nL >= half) m = M.LOCK;
      else if (nF >= half && m !== M.DOCK) m = M.FAIRWAY;
      mask[c] = m;
    }
    if (nS >= half) mask[c] = st === M.PONTOON && !WT_NAVIGABLE[mask[c]] ? M.LAND : st;
  }
  return mask;
}
/** §3.4.1-6: water bodies < 6 cells away from the edge and not dock / lock are filled (ditches); untagged land specks
 *  < 3 cells in water become water (tagged ones — structures, buildings — are kept). */
function fillSpecks(mask, W) {
  const WW = W * W, seen = new Uint8Array(WW), queue = new Int32Array(WW);
  for (let s0 = 0; s0 < WW; s0++) {
    if (seen[s0]) continue;
    const wet = WT_NAVIGABLE[mask[s0]];
    let head = 0, tail = 0, edge = false, keep = false;
    seen[s0] = 1; queue[tail++] = s0;
    while (head < tail) {
      const c = queue[head++], ci = c % W, cj = (c - ci) / W;
      if (ci === 0 || cj === 0 || ci === W - 1 || cj === W - 1) edge = true;
      if (wet ? mask[c] === M.DOCK || mask[c] === M.LOCK : mask[c] !== M.LAND) keep = true;
      if (ci > 0 && !seen[c - 1] && WT_NAVIGABLE[mask[c - 1]] === wet) { seen[c - 1] = 1; queue[tail++] = c - 1; }
      if (ci < W - 1 && !seen[c + 1] && WT_NAVIGABLE[mask[c + 1]] === wet) { seen[c + 1] = 1; queue[tail++] = c + 1; }
      if (cj > 0 && !seen[c - W] && WT_NAVIGABLE[mask[c - W]] === wet) { seen[c - W] = 1; queue[tail++] = c - W; }
      if (cj < W - 1 && !seen[c + W] && WT_NAVIGABLE[mask[c + W]] === wet) { seen[c + W] = 1; queue[tail++] = c + W; }
    }
    if (edge || keep) continue;
    if (wet && tail < 6) for (let q = 0; q < tail; q++) mask[queue[q]] = M.LAND;
    else if (!wet && tail < 3) for (let q = 0; q < tail; q++) mask[queue[q]] = M.WATER;
  }
}
