// World detail tiles — pure mesh builders (docs/WORLD-DETAIL-STREAMING.md §3.7, Lane B). No three.js, no DOM: the module
// worker (wtworker.js) and the Node tests (test/wtmesh.test.mjs) import it directly; wtiles.js wraps the typed arrays
// into BufferGeometry. The import path is relative on purpose: '../../shared/wtformat.js' resolves to /shared/… in the
// browser (import maps do not apply inside workers) and to <repo>/shared/… under Node.
//
// Frame ("tile frame"): metres relative to the tile's NW corner, x east = (lon − lonW)·K_LON·cos(lat), z south =
// (latN − lat)·K_LAT, y up = height above the tile datum (the server's metres, mean low water). Every vertex uses its
// own latitude exactly like shared/geo.js toLocal, so wtiles.js places a mesh with translate(toLocal(NW)) plus one
// horizontal shear term (placement()) and the result matches toLocal to the millimetre over a tile.
import { WT, WT_OBSTACLE, WT_NAVIGABLE, decodeWTHeight, tileSizeM } from '../../shared/wtformat.js';

export const K_LAT = 110574, K_LON = 111320;          // = GEO.M_PER_DEG_LAT / M_PER_DEG_LON_EQ (shared/constants.js)
const D2R = Math.PI / 180;
export const WATER_OFFSET = 2.5;   // water vertices sit this far under their depth (same as the harbour patches)
export const SKIRT_M = 30;         // edge skirt depth: hides T-junction cracks between LODs and the coarse seam
export const LOD = { NEAR: 256, MID: 128, FAR: 64, UNIFORM: 16, C11: 128, C11_LOW: 64 };
/** Per-device budgets (§3.7). geomMB covers every D14 + C11 mesh the WorldTileSet keeps attached. */
export const BUDGET = {
  desktop: { geomMB: 150, d14Meshes: 25, c11Meshes: 40, buildings: 4000, structVerts: 420000, builds: 2, decoded: 400, rawMB: 48 },
  mobile: { geomMB: 50, d14Meshes: 9, c11Meshes: 16, buildings: 1500, structVerts: 140000, builds: 1, decoded: 150, rawMB: 16 },
};
/** WT mask code → harbour patch mask code (collision / pointBlocked read patch codes). */
export const WT_TO_PATCH = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 0, 0, 0, 1]);
const M = WT.MASK;
const H_LUT = new Float32Array(256);
for (let v = 0; v < 256; v++) H_LUT[v] = decodeWTHeight(v);

// ------------------------------------------------------------------------------------------------ tile frame
/** Geometry of tile (z, x, y): corner lat/lon, Web-Mercator size (m, at the centre; vector decimetres use it). */
export function tileFrame(z, x, y) {
  const n2 = 2 ** z;
  const lat = (fy) => Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + fy)) / n2))) / D2R;
  const latN = lat(0), latS = lat(1), lonW = (x / n2) * 360 - 180, lonE = ((x + 1) / n2) * 360 - 180;
  const dlon = lonE - lonW;
  return {
    z, x, y, n2, latN, latS, lonW, lonE, dlon,
    sizeM: tileSizeM(z, lat(0.5)),
    h: (latN - latS) * K_LAT, wN: dlon * K_LON * Math.cos(latN * D2R), wS: dlon * K_LON * Math.cos(latS * D2R),
  };
}
/** Latitude at a fractional row (0 = north edge, 1 = south edge) of a frame. */
export function frameLat(f, fy) { return Math.atan(Math.sinh(Math.PI * (1 - (2 * (f.y + fy)) / f.n2))) / D2R; }
/** Tile-frame metres of fractional tile coordinates (fx east, fy south, 0..1). */
export function frameXZ(f, fx, fy, out = [0, 0]) {
  const lat = frameLat(f, fy);
  out[0] = fx * f.dlon * K_LON * Math.cos(lat * D2R); out[1] = (f.latN - lat) * K_LAT;
  return out;
}
/**
 * Placement of a frame in the floating-origin frame of shared/geo.js toLocal: world = (tx + x + s·z, y, tz + z).
 * s is the first-order correction for toLocal's per-point cos(lat) away from the origin meridian.
 */
export function placement(f, origin) {
  let dl = f.lonW - origin.lon; dl = ((dl + 540) % 360) - 180;
  return {
    tx: dl * K_LON * Math.cos(f.latN * D2R), tz: -(f.latN - origin.lat) * K_LAT,
    s: (dl * K_LON * Math.sin(f.latN * D2R) * D2R) / K_LAT,
  };
}
/** Same placement for an arbitrary lat/lon box (harbour patch footprints): {tx, tz, s, h, wN, wS}. */
export function boxPlacement(latN, latS, lonW, lonE, origin) {
  const f = { latN, lonW };
  const p = placement(f, origin), dlon = lonE - lonW;
  return { ...p, h: (latN - latS) * K_LAT, wN: dlon * K_LON * Math.cos(latN * D2R), wS: dlon * K_LON * Math.cos(latS * D2R) };
}

// ------------------------------------------------------------------------------------------------ small helpers
function hash2(a, b) { let h = (a * 374761393 + b * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
/** Growable typed buffers for the structure builder. */
class Buf {
  constructor(n = 4096) { this.pos = new Float32Array(n * 3); this.nrm = new Int8Array(n * 3); this.col = new Uint8Array(n * 3); this.idx = new Uint32Array(n * 2); this.v = 0; this.i = 0; }
  growV(k) {
    if (this.v + k <= this.pos.length / 3) return;
    const cap = Math.max(this.v + k, (this.pos.length / 3) * 2);
    const p = new Float32Array(cap * 3); p.set(this.pos); this.pos = p;
    const n = new Int8Array(cap * 3); n.set(this.nrm); this.nrm = n;
    const c = new Uint8Array(cap * 3); c.set(this.col); this.col = c;
  }
  growI(k) { if (this.i + k <= this.idx.length) return; const a = new Uint32Array(Math.max(this.i + k, this.idx.length * 2)); a.set(this.idx); this.idx = a; }
  vert(x, y, z, nx, ny, nz, r, g, b) {
    const k = this.v * 3;
    this.pos[k] = x; this.pos[k + 1] = y; this.pos[k + 2] = z;
    this.nrm[k] = Math.round(nx * 127); this.nrm[k + 1] = Math.round(ny * 127); this.nrm[k + 2] = Math.round(nz * 127);
    this.col[k] = clamp(Math.round(r * 255), 0, 255); this.col[k + 1] = clamp(Math.round(g * 255), 0, 255); this.col[k + 2] = clamp(Math.round(b * 255), 0, 255);
    return this.v++;
  }
  /** Triangle a, b, c wound so its geometric normal agrees with (nx, ny, nz) (front face towards the viewer). */
  tri(a, b, c, nx, ny, nz) {
    const P = this.pos, A = a * 3, B = b * 3, C = c * 3;
    const ux = P[B] - P[A], uy = P[B + 1] - P[A + 1], uz = P[B + 2] - P[A + 2], vx = P[C] - P[A], vy = P[C + 1] - P[A + 1], vz = P[C + 2] - P[A + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    this.growI(3);
    if (cx * nx + cy * ny + cz * nz >= 0) { this.idx[this.i++] = a; this.idx[this.i++] = b; this.idx[this.i++] = c; } else { this.idx[this.i++] = a; this.idx[this.i++] = c; this.idx[this.i++] = b; }
  }
  /** Flat quad a-b-c-d (in order around the rim) facing n, one colour per corner pair (top rgb, bottom rgb). */
  quad(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, nx, ny, nz, c0, c1 = c0) {
    this.growV(4);
    const a = this.vert(ax, ay, az, nx, ny, nz, c0[0], c0[1], c0[2]), b = this.vert(bx, by, bz, nx, ny, nz, c0[0], c0[1], c0[2]);
    const c = this.vert(cx, cy, cz, nx, ny, nz, c1[0], c1[1], c1[2]), d = this.vert(dx, dy, dz, nx, ny, nz, c1[0], c1[1], c1[2]);
    this.tri(a, b, c, nx, ny, nz); this.tri(a, c, d, nx, ny, nz);
  }
  out() {
    return { pos: this.pos.slice(0, this.v * 3), nrm: this.nrm.slice(0, this.v * 3), col: this.col.slice(0, this.v * 3), idx: this.idx.slice(0, this.i), verts: this.v, tris: this.i / 3 };
  }
}
const hex = (h, k = 1) => [((h >> 16) & 255) / 255 * k, ((h >> 8) & 255) / 255 * k, (h & 255) / 255 * k];
const mul = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

/** Even-odd area fill of flat rings [x0, z0, …] (cell units) into a class grid (n²). */
function fillRing(grid, n, ring, value) {
  const m = ring.length >> 1; if (m < 3) return;
  let zmin = Infinity, zmax = -Infinity;
  for (let i = 1; i < ring.length; i += 2) { if (ring[i] < zmin) zmin = ring[i]; if (ring[i] > zmax) zmax = ring[i]; }
  const j0 = Math.max(0, Math.floor(zmin)), j1 = Math.min(n - 1, Math.ceil(zmax));
  const xs = [];
  for (let j = j0; j <= j1; j++) {
    const zc = j + 0.5; xs.length = 0;
    for (let a = 0, b = m - 1; a < m; b = a++) {
      const za = ring[a * 2 + 1], zb = ring[b * 2 + 1];
      if ((za > zc) !== (zb > zc)) xs.push(ring[a * 2] + ((zc - za) / (zb - za)) * (ring[b * 2] - ring[a * 2]));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil(xs[k] - 0.5)), i1 = Math.min(n - 1, Math.floor(xs[k + 1] - 0.5));
      for (let i = i0; i <= i1; i++) grid[j * n + i] = value;
    }
  }
}

// ------------------------------------------------------------------------------------------------ land classes
/** Area kinds → class codes (vertex colours); later codes are painted over earlier ones. */
export const AREA_CLASS = { grass: 1, wood: 2, sand: 3, residential: 4, commercial: 5, parking: 6, industrial: 7, port: 8 };
const AREA_ORDER = ['grass', 'wood', 'sand', 'residential', 'commercial', 'parking', 'industrial', 'port'];
const CLASS_RGB = [
  [0.36, 0.47, 0.25],   // 0 plain land (grassy)
  [0.33, 0.50, 0.24],   // grass
  [0.22, 0.34, 0.16],   // wood
  [0.80, 0.74, 0.55],   // sand
  [0.63, 0.59, 0.52],   // residential
  [0.60, 0.58, 0.55],   // commercial
  [0.43, 0.43, 0.44],   // parking
  [0.52, 0.52, 0.50],   // industrial
  [0.56, 0.55, 0.52],   // port (concrete yard)
];
/** Class grid (n²) from the tile's `areas` vectors, or null. */
export function areaClassGrid(tile) {
  const areas = tile.vectors?.areas; if (!areas?.length || !tile.mask) return null;
  const n = tile.n, f = tileFrame(tile.z, tile.x, tile.y), k = n / (f.sizeM * 10);
  const grid = new Uint8Array(n * n);
  for (const kind of AREA_ORDER) {
    const code = AREA_CLASS[kind];
    for (const a of areas) {
      if (a.k !== kind || !a.r || a.r.length < 6) continue;
      const r = new Float32Array(a.r.length);
      for (let i = 0; i < r.length; i++) r[i] = a.r[i] * k;
      fillRing(grid, n, r, code);
    }
  }
  return grid;
}
/**
 * Quay runs that really stand on the coast of this tile's mask, in tile fractions: [{fr: Float64Array, side, top, k}].
 * A segment is kept when, within 1–3 cells of its midpoint, the water side is navigable and the land side an obstacle
 * (OSM quay lines that lie inland or in open water would draw floating walls); an OSM segment within 12 m of a derived
 * one is dropped (one wall per edge, never two coplanar faces). Cached on the tile object.
 */
export function quayRuns(tile) {
  if (tile._quayRuns) return tile._quayRuns;
  const runs = [], qs = tile.vectors?.quays;
  if (!qs?.length || !tile.mask) return (tile._quayRuns = runs);
  const n = tile.n, f = tileFrame(tile.z, tile.x, tile.y), sz10 = f.sizeM * 10, mask = tile.mask;
  const mAt = (fx, fy) => mask[clamp(Math.floor(fy * n), 0, n - 1) * n + clamp(Math.floor(fx * n), 0, n - 1)];
  const derived = [];
  for (const q of qs) if (q.k !== 'osm' && q.p) for (let i = 0; i + 3 < q.p.length; i += 2) derived.push(q.p[i], q.p[i + 1], q.p[i + 2], q.p[i + 3]);
  const nearDerived = (x, z) => {
    for (let i = 0; i < derived.length; i += 4) {
      const ax = derived[i], az = derived[i + 1], ex = derived[i + 2] - ax, ez = derived[i + 3] - az, L = ex * ex + ez * ez || 1;
      const t = clamp(((x - ax) * ex + (z - az) * ez) / L, 0, 1);
      if (Math.hypot(ax + t * ex - x, az + t * ez - z) < 120) return true;
    }
    return false;
  };
  for (const q of qs) {
    const p = q.p; if (!p || p.length < 4) continue;
    const side = q.side === -1 ? -1 : 1, top = Math.max(0.8, Number(q.top) || 3), osm = q.k === 'osm';
    let cur = null;
    const flush = () => { if (cur && cur.length >= 4) runs.push({ fr: Float64Array.from(cur), side, top, k: q.k || 'derived' }); cur = null; };
    for (let i = 0; i + 3 < p.length; i += 2) {
      const dx = p[i + 2] - p[i], dz = p[i + 3] - p[i + 1], l = Math.hypot(dx, dz);
      let ok = l > 1;
      if (ok) {
        const mx = (p[i] + p[i + 2]) / 2 / sz10, mz = (p[i + 1] + p[i + 3]) / 2 / sz10, nx = (-dz / l) * side, nz = (dx / l) * side;
        ok = false;
        for (let d = 1; d <= 3 && !ok; d++) {
          const e = d / n;
          if (WT_NAVIGABLE[mAt(mx + nx * e, mz + nz * e)] && WT_OBSTACLE[mAt(mx - nx * e, mz - nz * e)]) ok = true;
        }
        if (ok && osm && nearDerived((p[i] + p[i + 2]) / 2, (p[i + 1] + p[i + 3]) / 2)) ok = false;
      }
      if (!ok) { flush(); continue; }
      if (!cur) cur = [p[i] / sz10, p[i + 1] / sz10];
      cur.push(p[i + 2] / sz10, p[i + 3] / sz10);
    }
    flush();
  }
  return (tile._quayRuns = runs);
}
/** Cells (n²) within ~1 cell of a quay run: their land / water corners become walls, not beaches. */
export function quayGrid(tile) {
  const n = tile.n, g = new Uint8Array(n * n);
  for (const r of quayRuns(tile)) {
    const p = r.fr;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const ax = p[i] * n, az = p[i + 1] * n, bx = p[i + 2] * n, bz = p[i + 3] * n;
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) * 2));
      for (let s = 0; s <= steps; s++) {
        const x = ax + ((bx - ax) * s) / steps, z = az + ((bz - az) * s) / steps;
        const ci = Math.floor(x), cj = Math.floor(z);
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const i2 = ci + di, j2 = cj + dj;
          if (i2 >= 0 && j2 >= 0 && i2 < n && j2 < n) g[j2 * n + i2] = 1;
        }
      }
    }
  }
  return g;
}

// ------------------------------------------------------------------------------------------------ terrain
/** Index buffer of a terrain grid of `lod` quads per edge plus its edge skirt (same for every tile of that LOD). */
export function terrainIndex(lod) {
  const V = lod + 1, grid = V * V, ring = 4 * lod;
  const idx = (grid + ring) > 65535 ? new Uint32Array((lod * lod + ring) * 6) : new Uint16Array((lod * lod + ring) * 6);
  let q = 0;
  for (let j = 0; j < lod; j++) for (let i = 0; i < lod; i++) {
    const a = j * V + i, b = a + 1, c = a + V, d = c + 1;
    idx[q++] = a; idx[q++] = c; idx[q++] = b; idx[q++] = b; idx[q++] = c; idx[q++] = d;
  }
  const rim = skirtRing(lod);
  for (let s = 0; s < ring; s++) {
    const s1 = (s + 1) % ring, t0 = rim[s], t1 = rim[s1], b0 = grid + s, b1 = grid + s1;
    idx[q++] = t0; idx[q++] = t1; idx[q++] = b0; idx[q++] = t1; idx[q++] = b1; idx[q++] = b0;
  }
  return idx;
}
/** Grid vertex indices around the rim, clockwise seen from above (N edge W→E, E edge N→S, S edge E→W, W edge S→N). */
export function skirtRing(lod) {
  const V = lod + 1, r = [];
  for (let i = 0; i <= lod; i++) r.push(i);
  for (let j = 1; j <= lod; j++) r.push(j * V + lod);
  for (let i = lod - 1; i >= 0; i--) r.push(lod * V + i);
  for (let j = lod - 1; j >= 1; j--) r.push(j * V);
  return r;
}
/** Vertex count of a terrain mesh at a LOD (grid + skirt). */
export const terrainVerts = (lod) => (lod + 1) * (lod + 1) + 4 * lod;

/**
 * Terrain mesh of one decoded SLWT tile (D14 or C11).
 * opts: { lod (256|128|64; uniform tiles use 16), coarse: {n, h: Float32Array((n+1)²)} — the coarse world's heights over
 * the tile (fractions i/n, j/n) for the 0.6 s morph-in, waterOffset, skirt }.
 * Vertices sit on cell CORNERS (i·s, j·s cells), so neighbouring tiles share their edge vertices exactly. A corner is
 * land when its cells are all obstacles, water when all navigable; a mixed corner next to a quay (quay vector, QUAY or
 * PONTOON cells) drops to the water depth (the wall mesh stands there), a natural mixed corner sits at the waterline
 * (a beach / rubble slope).
 * Returns { lod, verts, pos: Float32Array, nrm: Int8Array, col: Uint8Array, morph: Float32Array, minY, maxY }.
 */
export function buildTerrain(tile, opts = {}) {
  const f = opts.frame || tileFrame(tile.z, tile.x, tile.y);
  const uniform = !tile.mask;
  const lod = uniform ? LOD.UNIFORM : Math.max(1, Math.min(tile.n, opts.lod || LOD.NEAR));
  const off = opts.waterOffset ?? WATER_OFFSET, skirt = opts.skirt ?? SKIRT_M;
  const V = lod + 1, nGrid = V * V, total = nGrid + 4 * lod;
  const pos = new Float32Array(total * 3), nrm = new Int8Array(total * 3), col = new Uint8Array(total * 3), morph = new Float32Array(total);
  const hv = new Float32Array(nGrid);
  const rgb = new Float32Array(nGrid * 3);
  // rows: latitude → z and the east-west scale (each row uses its own cos(lat), like toLocal)
  const rowZ = new Float64Array(V), rowW = new Float64Array(V);
  for (let j = 0; j < V; j++) { const lat = frameLat(f, j / lod); rowZ[j] = (f.latN - lat) * K_LAT; rowW[j] = f.dlon * K_LON * Math.cos(lat * D2R); }
  const seed = (tile.x * 7919 + tile.y * 104729) | 0;
  const setRGB = (v, c, k = 1) => { rgb[v * 3] = c[0] * k; rgb[v * 3 + 1] = c[1] * k; rgb[v * 3 + 2] = c[2] * k; };
  const water = (h) => { const k = 0.55 + 0.45 * Math.max(0, 1 + h / 24); return [0.31 * k, 0.30 * k, 0.22 * k]; };
  if (uniform) {
    const land = (tile.flags & WT.FLAG.UNIFORM_LAND) !== 0, h = tile.uniformH;
    for (let v = 0; v < nGrid; v++) { hv[v] = land ? h : h - off; setRGB(v, land ? CLASS_RGB[0] : water(h)); }
  } else {
    const n = tile.n, mask = tile.mask, hb = tile.height, s = n / lod, r = Math.max(1, s >> 1);
    const cls = opts.classGrid !== undefined ? opts.classGrid : areaClassGrid(tile);
    const qg = opts.quayGrid || quayGrid(tile);
    const QUAYC = hex(0x8e8b84), RUBBLE = hex(0x5a5650), PONT = hex(0xb9b2a4), WET_SAND = [0.60, 0.55, 0.42];
    for (let J = 0; J < V; J++) {
      const cj = J * s;
      for (let I = 0; I < V; I++) {
        const ci = I * s;
        let nO = 0, sO = 0, nW = 0, sW = 0, minW = Infinity, wall = false, rubble = 0, cr = 0, cg = 0, cb = 0;
        for (let j = Math.max(0, cj - r); j < Math.min(n, cj + r); j++) {
          for (let i = Math.max(0, ci - r); i < Math.min(n, ci + r); i++) {
            const k = j * n + i, m = mask[k], h = H_LUT[hb[k]];
            if (WT_OBSTACLE[m]) {
              nO++; sO += h;
              // land colour: the mean of the block's cell colours (smooth class borders instead of stair steps)
              const c = m === M.QUAY ? QUAYC : m === M.BREAKWATER ? RUBBLE : m === M.PONTOON ? PONT : CLASS_RGB[cls ? cls[k] : 0];
              const kb = m === M.BUILDING ? 0.9 : 1;
              cr += c[0] * kb; cg += c[1] * kb; cb += c[2] * kb;
              if (m === M.QUAY || m === M.PONTOON) wall = true; else if (m === M.BREAKWATER) rubble++;
            } else { nW++; sW += h; if (h < minW) minW = h; }
            if (qg[k]) wall = true;
          }
        }
        const v = J * V + I;
        const noise = 1 + (hash2(seed + I * 3, J * 5 + 11) - 0.5) * 0.07;
        if (nW === 0) {
          hv[v] = sO / nO;
          setRGB(v, [cr / nO, cg / nO, cb / nO], noise);
        } else if (nO === 0) {
          const h = sW / nW; hv[v] = h - off; setRGB(v, water(h), noise);
        } else if (wall) {
          hv[v] = minW - off; setRGB(v, water(minW), noise);       // under the quay wall mesh
        } else {
          const ho = sO / nO, hw = sW / nW;
          hv[v] = clamp((ho + hw) * 0.5, -1.5, 0.8);               // the waterline: a beach / rubble slope
          setRGB(v, rubble ? RUBBLE : WET_SAND, noise);
        }
      }
    }
  }
  // morph source: the coarse heights under the tile (bilinear over the (n+1)² sample grid)
  const cg = opts.coarse;
  let minY = Infinity, maxY = -Infinity;
  for (let J = 0; J < V; J++) for (let I = 0; I < V; I++) {
    const v = J * V + I, k = v * 3;
    pos[k] = (I / lod) * rowW[J]; pos[k + 1] = hv[v]; pos[k + 2] = rowZ[J];
    if (hv[v] < minY) minY = hv[v]; if (hv[v] > maxY) maxY = hv[v];
    let mh = hv[v];
    if (cg && cg.h && cg.n > 0) {
      const gx = (I / lod) * cg.n, gy = (J / lod) * cg.n, x0 = Math.min(cg.n - 1, Math.floor(gx)), y0 = Math.min(cg.n - 1, Math.floor(gy)), fx = gx - x0, fy = gy - y0, W2 = cg.n + 1;
      const a = cg.h[y0 * W2 + x0], b = cg.h[y0 * W2 + x0 + 1], c = cg.h[(y0 + 1) * W2 + x0], d = cg.h[(y0 + 1) * W2 + x0 + 1];
      const m2 = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
      if (Number.isFinite(m2)) mh = m2;
    }
    morph[v] = mh;
    col[k] = clamp(Math.round(rgb[k] * 255), 0, 255); col[k + 1] = clamp(Math.round(rgb[k + 1] * 255), 0, 255); col[k + 2] = clamp(Math.round(rgb[k + 2] * 255), 0, 255);
  }
  // normals from the final heights (central differences, one-sided at the rim)
  for (let J = 0; J < V; J++) for (let I = 0; I < V; I++) {
    const v = J * V + I;
    const il = Math.max(0, I - 1), ir = Math.min(lod, I + 1), jt = Math.max(0, J - 1), jb = Math.min(lod, J + 1);
    const a = (J * V + il) * 3, b = (J * V + ir) * 3, c = (jt * V + I) * 3, d = (jb * V + I) * 3;
    const dhx = (pos[b + 1] - pos[a + 1]) / (pos[b] - pos[a] || 1), dhz = (pos[d + 1] - pos[c + 1]) / (pos[d + 2] - pos[c + 2] || 1);
    const l = Math.hypot(dhx, 1, dhz);
    nrm[v * 3] = Math.round((-dhx / l) * 127); nrm[v * 3 + 1] = Math.round((1 / l) * 127); nrm[v * 3 + 2] = Math.round((-dhz / l) * 127);
  }
  // skirt: a copy of every rim vertex SKIRT m under the lower of its final / coarse height
  const rim = skirtRing(lod);
  for (let s2 = 0; s2 < rim.length; s2++) {
    const src = rim[s2], k = (nGrid + s2) * 3, ks = src * 3;
    pos[k] = pos[ks]; pos[k + 2] = pos[ks + 2];
    pos[k + 1] = Math.min(pos[ks + 1], morph[src]) - skirt;
    morph[nGrid + s2] = pos[k + 1];
    nrm[k] = nrm[ks]; nrm[k + 1] = nrm[ks + 1]; nrm[k + 2] = nrm[ks + 2];
    col[k] = col[ks] * 0.8; col[k + 1] = col[ks + 1] * 0.8; col[k + 2] = col[ks + 2] * 0.8;
  }
  return { lod, verts: total, pos, nrm, col, morph, minY, maxY };
}

// ------------------------------------------------------------------------------------------------ polygons
/** Signed area of flat [x, z, …] (x east, z south): > 0 = counter-clockwise in (x, z) maths axes. */
export function ringArea(r) { let a = 0; const m = r.length >> 1; for (let i = 0, j = m - 1; i < m; j = i++) a += r[j * 2] * r[i * 2 + 1] - r[i * 2] * r[j * 2 + 1]; return a / 2; }
/**
 * Ear-clipping triangulation of a simple polygon (flat [x, z, …], no holes). Returns triangle vertex indices into the
 * ring. Falls back to a fan when the polygon is degenerate / self-intersecting (never loops forever).
 */
export function triangulate(r) {
  const m = r.length >> 1; if (m < 3) return [];
  const ccw = ringArea(r) > 0;
  const V = []; for (let i = 0; i < m; i++) V.push(ccw ? i : m - 1 - i);
  const out = [];
  const X = (i) => r[i * 2], Z = (i) => r[i * 2 + 1];
  const cross = (a, b, c) => (X(b) - X(a)) * (Z(c) - Z(a)) - (Z(b) - Z(a)) * (X(c) - X(a));
  const inside = (p, a, b, c) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  let guard = m * m + 8, i = 0;
  while (V.length > 3 && guard-- > 0) {
    const n = V.length, a = V[(i + n - 1) % n], b = V[i % n], c = V[(i + 1) % n];
    let ear = cross(a, b, c) > 1e-9;
    if (ear) for (let k = 0; k < n; k++) { const p = V[k]; if (p === a || p === b || p === c) continue; if (inside(p, a, b, c)) { ear = false; break; } }
    if (ear) { out.push(a, b, c); V.splice(i % n, 1); i = Math.max(0, (i % n) - 1); } else i = (i + 1) % n;
  }
  if (V.length === 3) out.push(V[0], V[1], V[2]);
  else if (V.length > 3) for (let k = 1; k + 1 < V.length; k++) out.push(V[0], V[k], V[k + 1]); // degenerate leftovers
  return out;
}
/** Liang–Barsky: clip segment (a→b) in fraction space to the unit square; null when outside. */
function clipSeg(ax, az, bx, bz) {
  let t0 = 0, t1 = 1; const dx = bx - ax, dz = bz - az;
  const p = [-dx, dx, -dz, dz], q = [ax, 1 - ax, az, 1 - az];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return null; continue; }
    const t = q[i] / p[i];
    if (p[i] < 0) { if (t > t1) return null; if (t > t0) t0 = t; } else { if (t < t0) return null; if (t < t1) t1 = t; }
  }
  return [ax + t0 * dx, az + t0 * dz, ax + t1 * dx, az + t1 * dz, t0 > 0, t1 < 1];
}
/** Polyline (fractions) clipped to the tile square → list of polylines (fractions). */
function clipPolyline(fr) {
  const out = []; let cur = null;
  for (let i = 0; i + 3 < fr.length; i += 2) {
    const c = clipSeg(fr[i], fr[i + 1], fr[i + 2], fr[i + 3]);
    if (!c) { if (cur) { out.push(cur); cur = null; } continue; }
    if (!cur || c[4]) { if (cur) out.push(cur); cur = [c[0], c[1]]; }
    cur.push(c[2], c[3]);
    if (c[5]) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out.filter((p) => p.length >= 4);
}

// ------------------------------------------------------------------------------------------------ structures
const KIND_RGB = {
  residential: [0xb0, 0x9a, 0x84], commercial: [0xa8, 0xa2, 0x98], office: [0x8e, 0x9a, 0xa6], industrial: [0x9c, 0xa2, 0xa6],
  shed: [0xa6, 0xa8, 0xa4], other: [0xa4, 0x9c, 0x90],
};
const ROOF_RGB = { residential: [0x8a, 0x5a, 0x48], commercial: [0x70, 0x70, 0x70], office: [0x5c, 0x62, 0x6a], industrial: [0x7c, 0x84, 0x8a], shed: [0x86, 0x8c, 0x90], other: [0x78, 0x72, 0x6a] };
const rgb255 = (a, k = 1) => [(a[0] / 255) * k, (a[1] / 255) * k, (a[2] / 255) * k];

/**
 * Structures of one decoded D14 tile: quay walls (front face down to the berth depth, a top slab reaching ≈ 1.5 cells
 * inland, a back face and end caps), piers / jetties and pontoons (extruded rings), breakwaters (rubble blocks),
 * bridges (deck slabs), buildings (flat-roofed extrusions, largest first, capped) — one merged, vertex-coloured mesh in
 * the tile frame — plus instance lists for cranes, tanks and lights. Vectors in the tile's buffer are drawn by the tile
 * that owns them (polylines clipped to the square, rings by their centroid), so neighbours never draw a part twice.
 * opts: { frame, lod (wall width follows the terrain LOD), maxBuildings, minBuildingH, maxVerts, debug (adds `walls`) }.
 * Returns { pos, nrm, col, idx, verts, tris, counts, inst: { cranes, tanks, lights } } (Float32Array per instance kind:
 * cranes [x, y, z, hdg°, h, kind], tanks [x, y, z, r, h, 0], lights [x, y, z, kind, colour, h]).
 */
export function buildStructures(tile, opts = {}) {
  const f = opts.frame || tileFrame(tile.z, tile.x, tile.y);
  const v = tile.vectors || {};
  const B = new Buf(8192);
  const counts = { quays: 0, wallSegs: 0, piers: 0, pontoons: 0, breakwaters: 0, bridges: 0, buildings: 0, buildingsSkipped: 0, cranes: 0, tanks: 0, lights: 0 };
  const n = tile.n || WT.N, sz10 = f.sizeM * 10;
  const cellM = f.sizeM / n, lodS = n / (opts.lod || LOD.NEAR);
  const maxVerts = opts.maxVerts ?? BUDGET.desktop.structVerts;
  const walls = opts.debug ? [] : null;      // tests: the wall lines (frame metres) with their water normals
  const tmp = [0, 0];
  const XZ = (fx, fy) => { frameXZ(f, fx, fy, tmp); return [tmp[0], tmp[1]]; };
  const hAt = (fx, fy) => (tile.mask ? H_LUT[tile.height[cellIdx(fx, fy)]] : tile.uniformH);
  const mAt = (fx, fy) => (tile.mask ? tile.mask[cellIdx(fx, fy)] : (tile.flags & WT.FLAG.UNIFORM_LAND ? M.LAND : M.WATER));
  function cellIdx(fx, fy) { const i = clamp(Math.floor(fx * n), 0, n - 1), j = clamp(Math.floor(fy * n), 0, n - 1); return j * n + i; }
  const own = (fx, fy) => fx >= 0 && fx < 1 && fy >= 0 && fy < 1;
  const frac = (flat) => { const o = new Float64Array(flat.length); for (let i = 0; i < flat.length; i++) o[i] = flat[i] / sz10; return o; };
  const centroid = (fr) => { let x = 0, z = 0; const m = fr.length >> 1; for (let i = 0; i < fr.length; i += 2) { x += fr[i]; z += fr[i + 1]; } return [x / m, z / m]; };
  /** max ground (obstacle cells) and min water under a fraction ring (vertices + centroid) */
  const groundOf = (fr) => {
    let gmin = Infinity, gmax = -Infinity, wmin = Infinity;
    const probe = (fx, fy) => { const m = mAt(fx, fy), h = hAt(fx, fy); if (WT_OBSTACLE[m]) { if (h < gmin) gmin = h; if (h > gmax) gmax = h; } else if (h < wmin) wmin = h; };
    for (let i = 0; i < fr.length; i += 2) probe(fr[i], fr[i + 1]);
    const c = centroid(fr); probe(c[0], c[1]);
    return { gmin, gmax, wmin };
  };

  // --- quay walls -------------------------------------------------------------------------------------------
  const W = Math.max(6, 1.6 * cellM * lodS);   // slab reaches past the dipped terrain corner(s)
  const TOP = hex(0xa39e94), FACE = hex(0x7a766e), WET = hex(0x3e3c37), BACK = hex(0x86827a);
  for (const q of quayRuns(tile)) {
    const side = q.side, top = q.top;
    for (const fr of clipPolyline(q.fr)) {
      const m = fr.length >> 1;
      const P = []; for (let i = 0; i < m; i++) P.push(XZ(fr[i * 2], fr[i * 2 + 1]));
      // per-segment water normals (side 1 = water on the right of the direction of travel; x east, z south)
      const Nn = [];
      for (let i = 0; i + 1 < m; i++) { const dx = P[i + 1][0] - P[i][0], dz = P[i + 1][1] - P[i][1], l = Math.hypot(dx, dz) || 1; Nn.push([(-dz / l) * side, (dx / l) * side]); }
      if (!Nn.length) continue;
      // mitred vertex normals
      const VN = [];
      for (let i = 0; i < m; i++) {
        const a = Nn[Math.max(0, i - 1)], b = Nn[Math.min(Nn.length - 1, i)];
        let nx = a[0] + b[0], nz = a[1] + b[1]; const l = Math.hypot(nx, nz) || 1; nx /= l; nz /= l;
        const cosh = Math.max(0.5, nx * b[0] + nz * b[1]);
        VN.push([nx / cosh, nz / cosh]);
      }
      // berth depth along the wall: the water 1.5 and 3 cells out, never above −1 m
      const bot = [], backBot = [];
      for (let i = 0; i < m; i++) {
        let w = Infinity;
        for (const d of [1.5, 3]) {
          const fx = fr[i * 2] + (VN[i][0] * d * cellM) / f.sizeM, fy = fr[i * 2 + 1] + (VN[i][1] * d * cellM) / f.sizeM;
          const hh = hAt(clamp(fx, 0, 0.9999), clamp(fy, 0, 0.9999)); if (hh < w) w = hh;
        }
        bot.push(clamp(Number.isFinite(w) ? w - 1 : -6, -30, -1.5));
        const bx = clamp(fr[i * 2] - (VN[i][0] * (W + cellM)) / f.sizeM, 0, 0.9999), bz = clamp(fr[i * 2 + 1] - (VN[i][1] * (W + cellM)) / f.sizeM, 0, 0.9999);
        backBot.push(Math.min(top, hAt(bx, bz)) - 1.5);
      }
      const L = P.map((p, i) => [p[0] - VN[i][0] * W, p[1] - VN[i][1] * W]);
      for (let i = 0; i + 1 < m; i++) {
        const a = P[i], b = P[i + 1], la = L[i], lb = L[i + 1], nn = Nn[i];
        // front (water) face, wet at the bottom
        B.quad(a[0], top, a[1], b[0], top, b[1], b[0], bot[i + 1], b[1], a[0], bot[i], a[1], nn[0], 0, nn[1], FACE, WET);
        // top slab
        B.quad(a[0], top, a[1], b[0], top, b[1], lb[0], top, lb[1], la[0], top, la[1], 0, 1, 0, TOP);
        // back face (only matters where the land behind is lower than the quay top)
        B.quad(la[0], top, la[1], lb[0], top, lb[1], lb[0], backBot[i + 1], lb[1], la[0], backBot[i], la[1], -nn[0], 0, -nn[1], BACK, mul(BACK, 0.7));
        counts.wallSegs++;
        if (walls) walls.push({ ax: a[0], az: a[1], bx: b[0], bz: b[1], nx: nn[0], nz: nn[1], top, bottom: Math.min(bot[i], bot[i + 1]) });
      }
      // end caps
      for (const [i, sgn] of [[0, -1], [m - 1, 1]]) {
        const a = P[i], la = L[i], s0 = Nn[Math.min(Nn.length - 1, Math.max(0, i - (sgn > 0 ? 1 : 0)))];
        const tx = s0[1] * side * sgn, tz = -s0[0] * side * sgn;  // along the wall, pointing out of the end
        B.quad(a[0], top, a[1], la[0], top, la[1], la[0], backBot[i], la[1], a[0], bot[i], a[1], tx, 0, tz, FACE, WET);
      }
      counts.quays++;
    }
  }

  // --- extruded rings: piers, pontoons, breakwaters -------------------------------------------------------------
  const extrude = (fr, top, bot, cTop, cSide, roof = true, jitter = 0) => {
    const m = fr.length >> 1; if (m < 3) return false;
    const P = new Float64Array(m * 2);
    for (let i = 0; i < m; i++) { const p = XZ(fr[i * 2], fr[i * 2 + 1]); P[i * 2] = p[0]; P[i * 2 + 1] = p[1]; }
    const A = ringArea(P); if (Math.abs(A) < 0.5) return false;
    const sgn = A > 0 ? 1 : -1;
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m, ax = P[i * 2], az = P[i * 2 + 1], bx = P[j * 2], bz = P[j * 2 + 1];
      const dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz); if (l < 0.05) continue;
      const nx = (sgn * dz) / l, nz = (-sgn * dx) / l;
      const k = jitter ? 1 + (hash2(i * 31 + m, Math.round(ax)) - 0.5) * jitter : 1;
      B.quad(ax, top, az, bx, top, bz, bx, bot, bz, ax, bot, az, nx, 0, nz, mul(cSide, k), mul(cSide, 0.72 * k));
    }
    if (roof) {
      const tris = triangulate(P);
      B.growV(m);
      const base = B.v;
      for (let i = 0; i < m; i++) { const k = jitter ? 1 + (hash2(i * 17, m) - 0.5) * jitter : 1; B.vert(P[i * 2], top, P[i * 2 + 1], 0, 1, 0, cTop[0] * k, cTop[1] * k, cTop[2] * k); }
      for (let t = 0; t < tris.length; t += 3) B.tri(base + tris[t], base + tris[t + 1], base + tris[t + 2], 0, 1, 0);
    }
    return true;
  };
  for (const p of v.piers || []) {
    if (!p.r || p.r.length < 6) continue;
    const fr = frac(p.r), c = centroid(fr); if (!own(c[0], c[1])) continue;
    const g = groundOf(fr), top = Math.max(Number(p.top) || 2.5, Number.isFinite(g.gmax) ? g.gmax : -Infinity) + 0.05;
    const jetty = p.k === 'jetty';
    if (extrude(fr, top, Math.min(-3, (Number.isFinite(g.wmin) ? g.wmin : -3) * 0.5), jetty ? hex(0x8a7a62) : hex(0x9d988e), jetty ? hex(0x5e5446) : hex(0x6f6b64))) counts.piers++;
  }
  for (const p of v.pontoons || []) {
    if (!p.r || p.r.length < 6) continue;
    const fr = frac(p.r), c = centroid(fr); if (!own(c[0], c[1])) continue;
    if (extrude(fr, 0.7, -0.6, hex(0xb9b2a4), hex(0x55524c))) counts.pontoons++;
  }
  for (const b of v.breakwaters || []) {
    if (!b.r || b.r.length < 6) continue;
    const fr = frac(b.r), c = centroid(fr); if (!own(c[0], c[1])) continue;
    const g = groundOf(fr), top = Math.max(Number(b.top) || 4, Number.isFinite(g.gmax) ? g.gmax : -Infinity) + 0.05;
    if (extrude(fr, top, -4, hex(0x6a665f), hex(0x57534d), true, 0.25)) counts.breakwaters++;
  }

  // --- bridges: deck slabs along the clipped centre line ----------------------------------------------------------
  const DECK = hex(0x8c8a86), DECK_SIDE = hex(0x6a6864);
  for (const br of v.bridges || []) {
    if (!br.p || br.p.length < 4) continue;
    if (br.id != null && opts.skipIds && (opts.skipIds.has ? opts.skipIds.has(br.id) : opts.skipIds.includes(br.id))) continue;   // drawn by wwmesh
    const w = clamp(Number(br.w) || 6, 2, 40) / 2, deck = Math.max(1.5, Number(br.deck) || Number(br.clr) + 1.5 || 8);
    for (const fr of clipPolyline(frac(br.p))) {
      const m = fr.length >> 1;
      for (let i = 0; i + 1 < m; i++) {
        const a = XZ(fr[i * 2], fr[i * 2 + 1]), b = XZ(fr[i * 2 + 2], fr[i * 2 + 3]);
        const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz); if (l < 0.1) continue;
        const nx = -dz / l, nz = dx / l;
        const p0 = [a[0] + nx * w, a[1] + nz * w], p1 = [b[0] + nx * w, b[1] + nz * w], q0 = [a[0] - nx * w, a[1] - nz * w], q1 = [b[0] - nx * w, b[1] - nz * w];
        B.quad(p0[0], deck, p0[1], p1[0], deck, p1[1], q1[0], deck, q1[1], q0[0], deck, q0[1], 0, 1, 0, DECK);
        B.quad(q0[0], deck - 1.2, q0[1], q1[0], deck - 1.2, q1[1], p1[0], deck - 1.2, p1[1], p0[0], deck - 1.2, p0[1], 0, -1, 0, DECK_SIDE);
        B.quad(p0[0], deck, p0[1], p1[0], deck, p1[1], p1[0], deck - 1.2, p1[1], p0[0], deck - 1.2, p0[1], nx, 0, nz, DECK_SIDE);
        B.quad(q0[0], deck, q0[1], q1[0], deck, q1[1], q1[0], deck - 1.2, q1[1], q0[0], deck - 1.2, q0[1], -nx, 0, -nz, DECK_SIDE);
      }
      counts.bridges++;
    }
  }

  // --- buildings: largest first, capped by count and by the vertex budget ----------------------------------------
  const maxB = opts.maxBuildings ?? BUDGET.desktop.buildings, minH = opts.minBuildingH || 0;
  const list = [];
  for (const b of v.buildings || []) {
    if (!b.r || b.r.length < 6 || !(b.h >= minH)) { if (b && b.r) counts.buildingsSkipped++; continue; }
    list.push({ b, a: Math.abs(ringArea(b.r)) });
  }
  list.sort((p, q) => q.a - p.a);
  for (const { b } of list) {
    if (counts.buildings >= maxB || B.v >= maxVerts) { counts.buildingsSkipped++; continue; }
    const fr = frac(b.r), c = centroid(fr);
    if (!own(c[0], c[1])) continue;
    const g = groundOf(fr);
    const base = (Number.isFinite(g.gmin) ? g.gmin : Math.max(0.5, hAt(c[0], c[1]))) - 0.4;
    const top = base + 0.4 + Math.max(2.5, Math.min(300, Number(b.h) || 8)), bot = base + Math.max(0, Number(b.mh) || 0);
    const kind = KIND_RGB[b.k] ? b.k : 'other';
    const vary = 0.88 + hash2(Math.round(b.r[0]), Math.round(b.r[1])) * 0.22;
    if (extrude(fr, top, bot, rgb255(ROOF_RGB[kind], vary), rgb255(KIND_RGB[kind], vary))) counts.buildings++;
  }

  // --- instances: cranes, tanks, lights (point features owned by this tile) ----------------------------------------
  const cr = [], tk = [], li = [];
  const CRANE_KIND = { sts: 0, portal: 1, mobile: 2, other: 3 }, LIGHT_KIND = { lighthouse: 0, beacon: 1, buoy: 2 };
  const COLOUR = { red: 0, green: 1, yellow: 2, white: 3, black: 4 };
  for (const c of v.cranes || []) {
    const fx = c.x / sz10, fy = c.z / sz10; if (!own(fx, fy)) continue;
    const p = XZ(fx, fy); cr.push(p[0], Math.max(0, hAt(fx, fy)), p[1], Number(c.hdg) || 0, clamp(Number(c.h) || 40, 10, 140), CRANE_KIND[c.k] ?? 3);
  }
  for (const t of v.tanks || []) {
    const fx = t.x / sz10, fy = t.z / sz10; if (!own(fx, fy)) continue;
    const p = XZ(fx, fy); tk.push(p[0], Math.max(0, hAt(fx, fy)), p[1], clamp((Number(t.r) || 100) / 10, 2, 60), clamp(Number(t.h) || 15, 3, 60), 0);
  }
  for (const l of v.lights || []) {
    const fx = l.x / sz10, fy = l.z / sz10; if (!own(fx, fy)) continue;
    const p = XZ(fx, fy), kind = LIGHT_KIND[l.k] ?? 1;
    li.push(p[0], kind === 2 ? 0 : Math.max(0, hAt(fx, fy)), p[1], kind, COLOUR[String(l.col || '').split(/[;,]/)[0]] ?? 3, clamp(Number(l.h) || (kind === 0 ? 20 : 5), 1, 80));
  }
  counts.cranes = cr.length / 6; counts.tanks = tk.length / 6; counts.lights = li.length / 6;
  const o = B.out();
  const out = { ...o, counts, inst: { cranes: Float32Array.from(cr), tanks: Float32Array.from(tk), lights: Float32Array.from(li) } };
  if (walls) out.walls = walls;
  return out;
}

// ------------------------------------------------------------------------------------------------ SDF
/**
 * Signed distance (m) at every cell centre of a decoded tile: > 0 in navigable water (distance to the nearest
 * obstacle), < 0 inside obstacles (WT_OBSTACLE: land, quay, breakwater, pontoon, building). 3-4 chamfer, two passes,
 * the zero crossing on the shared cell edge (same convention as public/js/harborgeom.js computeSDF). Uniform → null.
 */
export function tileSDF(tile) {
  if (!tile.mask) return null;
  const n = tile.n, mask = tile.mask, f = tileFrame(tile.z, tile.x, tile.y), res = f.sizeM / n;
  const dObs = chamfer(mask, n, true), dWat = chamfer(mask, n, false), sdf = new Float32Array(n * n), cap = n * res;
  for (let k = 0; k < n * n; k++) {
    if (WT_OBSTACLE[mask[k]]) sdf[k] = -Math.min(cap, (dWat[k] / 3 - 0.5) * res);
    else sdf[k] = Math.min(cap, (dObs[k] / 3 - 0.5) * res);
  }
  return sdf;
}
function chamfer(mask, n, toObstacle) {
  const INF = 1 << 28, d = new Int32Array(n * n);
  for (let k = 0; k < n * n; k++) d[k] = (WT_OBSTACLE[mask[k]] === 1) === toObstacle ? 0 : INF;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i; let v = d[k]; if (v === 0) continue;
    if (i > 0 && d[k - 1] + 3 < v) v = d[k - 1] + 3;
    if (j > 0) { if (d[k - n] + 3 < v) v = d[k - n] + 3; if (i > 0 && d[k - n - 1] + 4 < v) v = d[k - n - 1] + 4; if (i < n - 1 && d[k - n + 1] + 4 < v) v = d[k - n + 1] + 4; }
    d[k] = v;
  }
  for (let j = n - 1; j >= 0; j--) for (let i = n - 1; i >= 0; i--) {
    const k = j * n + i; let v = d[k]; if (v === 0) continue;
    if (i < n - 1 && d[k + 1] + 3 < v) v = d[k + 1] + 3;
    if (j < n - 1) { if (d[k + n] + 3 < v) v = d[k + n] + 3; if (i < n - 1 && d[k + n + 1] + 4 < v) v = d[k + n + 1] + 4; if (i > 0 && d[k + n - 1] + 4 < v) v = d[k + n - 1] + 4; }
    d[k] = v;
  }
  return d;
}

/** Bytes a built tile occupies on the GPU / in JS typed arrays (terrain without its shared index + structures). */
export function meshBytes(terrain, structures) {
  let b = 0;
  if (terrain) b += terrain.pos.byteLength + terrain.nrm.byteLength + terrain.col.byteLength + terrain.morph.byteLength;
  if (structures) b += structures.pos.byteLength + structures.nrm.byteLength + structures.col.byteLength + structures.idx.byteLength;
  return b;
}

/**
 * The whole worker job (also run inline when Workers are unavailable / in tests): decoded tile + options → terrain,
 * structures (D14 only, when opts.structures !== false) and the timing.
 */
export function buildTile(tile, opts = {}) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const frame = tileFrame(tile.z, tile.x, tile.y);
  const qg = tile.mask ? quayGrid(tile) : null;
  const terrain = buildTerrain(tile, { ...opts, frame, quayGrid: qg || undefined });
  const structures = tile.z === WT.Z_DETAIL && tile.mask && opts.structures !== false ? buildStructures(tile, { ...opts, frame }) : null;
  const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  return { terrain, structures, ms, bytes: meshBytes(terrain, structures) };
}
