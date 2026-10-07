// World generation: Natural Earth GeoJSON → land mask raster → distance transform → synthetic bathymetry /
// topography → cached Uint8 height layers → tiles + charts. Real GEBCO/SRTM data can replace heightFromDistance
// without touching the tile API.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAYERS, TILE, encodeHeight, decodeHeight } from '../shared/constants.js';
import { encodePNG } from './png.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.SALTLINE_DATA || path.join(__dirname, '..', 'data');
const CACHE_VERSION = 4;

const SOURCES = {
  global: ['ne_50m_land.geojson'],
  region: ['ne_10m_land.geojson', 'ne_10m_minor_islands.geojson'],
};

export class Layer {
  constructor(def) {
    this.def = def;
    this.level = def.level;
    this.res = def.res;
    this.w = Math.round((def.lonMax - def.lonMin) / def.res);
    this.h = Math.round((def.latMax - def.latMin) / def.res);
    this.hgt = null; // Uint8Array w*h, encoded heights, row 0 = north edge
  }
  contains(lat, lon) {
    const d = this.def;
    return lat >= d.latMin && lat < d.latMax && lon >= d.lonMin && lon < d.lonMax;
  }
  // Continuous cell coordinates (cx to the east, cy to the south).
  cellXY(lat, lon) {
    return { cx: (lon - this.def.lonMin) / this.res, cy: (this.def.latMax - lat) / this.res };
  }
  heightAt(lat, lon) { // real metres, bilinear
    const { cx, cy } = this.cellXY(lat, lon);
    const x = cx - 0.5, y = cy - 0.5;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const g = (xx, yy) => {
      xx = Math.max(0, Math.min(this.w - 1, xx)); yy = Math.max(0, Math.min(this.h - 1, yy));
      return decodeHeight(this.hgt[yy * this.w + xx]);
    };
    return (g(x0, y0) * (1 - fx) + g(x0 + 1, y0) * fx) * (1 - fy) + (g(x0, y0 + 1) * (1 - fx) + g(x0 + 1, y0 + 1) * fx) * fy;
  }
  tile(tx, ty) {
    const n = TILE.CELLS + 1;
    const out = new Uint8Array(n * n);
    const x0 = tx * TILE.CELLS, y0 = ty * TILE.CELLS;
    for (let j = 0; j < n; j++) {
      const yy = Math.min(this.h - 1, y0 + j);
      if (yy < 0) continue;
      for (let i = 0; i < n; i++) {
        const xx = Math.min(this.w - 1, x0 + i);
        if (xx < 0) continue;
        out[j * n + i] = this.hgt[yy * this.w + xx];
      }
    }
    return out;
  }
  tilesX() { return Math.ceil(this.w / TILE.CELLS); }
  tilesY() { return Math.ceil(this.h / TILE.CELLS); }
}

// ---------------------------------------------------------------------------------------------------------
// Rasterisation (scanline, even-odd across all rings of all polygons in the layer).
function rasterize(layer, rings) {
  const { w, h, res, def } = layer;
  const land = new Uint8Array(w * h);
  const rows = new Array(h);
  for (let r = 0; r < h; r++) rows[r] = [];
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % n];
      // cell coords
      const ax = (a[0] - def.lonMin) / res, ay = (def.latMax - a[1]) / res;
      const bx = (b[0] - def.lonMin) / res, by = (def.latMax - b[1]) / res;
      if (ay === by) continue;
      const yTop = Math.min(ay, by), yBot = Math.max(ay, by);
      // scanline centres yc = r + 0.5 with yTop <= yc < yBot
      let r0 = Math.ceil(yTop - 0.5), r1 = Math.ceil(yBot - 0.5) - 1;
      if (r1 < 0 || r0 >= h) continue;
      r0 = Math.max(0, r0); r1 = Math.min(h - 1, r1);
      const dxdy = (bx - ax) / (by - ay);
      for (let r = r0; r <= r1; r++) {
        const yc = r + 0.5;
        rows[r].push(ax + (yc - ay) * dxdy);
      }
    }
  }
  for (let r = 0; r < h; r++) {
    const xs = rows[r];
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      let c0 = Math.ceil(xs[i] - 0.5), c1 = Math.ceil(xs[i + 1] - 0.5) - 1;
      if (c1 < 0 || c0 >= w) continue;
      c0 = Math.max(0, c0); c1 = Math.min(w - 1, c1);
      land.fill(1, r * w + c0, r * w + c1 + 1);
    }
    rows[r] = null;
  }
  return land;
}

function collectRings(geojson, bbox) {
  const rings = [];
  const inBox = (ring) => {
    let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
    for (const p of ring) { if (p[0] < minx) minx = p[0]; if (p[0] > maxx) maxx = p[0]; if (p[1] < miny) miny = p[1]; if (p[1] > maxy) maxy = p[1]; }
    return !(maxx < bbox.lonMin || minx > bbox.lonMax || maxy < bbox.latMin || miny > bbox.latMax);
  };
  const addPoly = (poly) => { for (const ring of poly) if (ring.length >= 3 && inBox(ring)) rings.push(ring); };
  for (const f of geojson.features) {
    const g = f.geometry; if (!g) continue;
    if (g.type === 'Polygon') addPoly(g.coordinates);
    else if (g.type === 'MultiPolygon') for (const p of g.coordinates) addPoly(p);
  }
  return rings;
}

// Chamfer distance transform (3-4 weights, capped at 255) from `mask` cells to the nearest cell of the
// opposite value. Returns distance in cells*3 (Uint8).
function chamfer(mask, w, h, target) {
  const INF = 255;
  const d = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = mask[i] === target ? 0 : INF;
  const mn = (a, b) => (a < b ? a : b);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      let v = d[o + x]; if (v === 0) continue;
      if (x > 0) v = mn(v, d[o + x - 1] + 3);
      if (y > 0) { v = mn(v, d[o - w + x] + 3); if (x > 0) v = mn(v, d[o - w + x - 1] + 4); if (x < w - 1) v = mn(v, d[o - w + x + 1] + 4); }
      d[o + x] = v > INF ? INF : v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    const o = y * w;
    for (let x = w - 1; x >= 0; x--) {
      let v = d[o + x]; if (v === 0) continue;
      if (x < w - 1) v = mn(v, d[o + x + 1] + 3);
      if (y < h - 1) { v = mn(v, d[o + w + x] + 3); if (x > 0) v = mn(v, d[o + w + x - 1] + 4); if (x < w - 1) v = mn(v, d[o + w + x + 1] + 4); }
      d[o + x] = v > INF ? INF : v;
    }
  }
  return d;
}

// Synthetic topo/bathy from distance to coast (in cells). Swap for GEBCO here.
export function heightFromDistance(isLand, dCells) {
  if (isLand) return Math.min(120, 2 + 6 * dCells);
  return Math.max(-200, -(4 + 8 * dCells));
}

function carve(land, layer, carvings) {
  const { w, h } = layer;
  const setWater = (cx, cy, rCells) => {
    const r2 = rCells * rCells;
    for (let y = Math.floor(cy - rCells); y <= Math.ceil(cy + rCells); y++) {
      if (y < 0 || y >= h) continue;
      for (let x = Math.floor(cx - rCells); x <= Math.ceil(cx + rCells); x++) {
        if (x < 0 || x >= w) continue;
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= r2) land[y * w + x] = 0;
      }
    }
  };
  for (const c of carvings) {
    if (c.type === 'basin') {
      if (!layer.contains(c.lat, c.lon)) continue;
      const { cx, cy } = layer.cellXY(c.lat, c.lon);
      setWater(cx, cy, Math.max(1, c.radiusM / (layer.res * 110574)));
    } else if (c.type === 'channel') {
      const rc = Math.max(1, c.widthM / 2 / (layer.res * 110574));
      for (let i = 0; i + 1 < c.pts.length; i++) {
        const a = c.pts[i], b = c.pts[i + 1];
        if (!layer.contains(a[0], a[1]) && !layer.contains(b[0], b[1])) continue;
        const A = layer.cellXY(a[0], a[1]), B = layer.cellXY(b[0], b[1]);
        const n = Math.ceil(Math.hypot(B.cx - A.cx, B.cy - A.cy) / (rc * 0.5)) + 1;
        for (let k = 0; k <= n; k++) {
          const t = k / n;
          setWater(A.cx + (B.cx - A.cx) * t, A.cy + (B.cy - A.cy) * t, rc);
        }
      }
    }
  }
}

function buildLayer(layer, carvings, log) {
  const t0 = Date.now();
  const rings = [];
  for (const file of SOURCES[layer.def.name]) {
    const p = path.join(DATA_DIR, file);
    if (!fs.existsSync(p)) { log(`[world] missing ${p} — layer ${layer.def.name} will be all water`); continue; }
    const gj = JSON.parse(fs.readFileSync(p, 'utf8'));
    rings.push(...collectRings(gj, layer.def));
  }
  log(`[world] ${layer.def.name}: ${rings.length} rings, grid ${layer.w}x${layer.h}`);
  const land = rasterize(layer, rings);
  carve(land, layer, carvings);
  const dLand = chamfer(land, layer.w, layer.h, 0);   // for land cells: distance to water
  const dWater = chamfer(land, layer.w, layer.h, 1);  // for water cells: distance to land
  const hgt = new Uint8Array(layer.w * layer.h);
  for (let i = 0; i < hgt.length; i++) {
    const isLand = land[i] === 1;
    const d = (isLand ? dLand[i] : dWater[i]) / 3;
    hgt[i] = encodeHeight(heightFromDistance(isLand, d));
  }
  layer.hgt = hgt;
  log(`[world] ${layer.def.name} built in ${Date.now() - t0} ms`);
}

export class World {
  constructor() {
    this.layers = LAYERS.map((d) => new Layer(d));
    this.charts = {};
  }

  /** carvings: [{type:'basin', lat, lon, radiusM} | {type:'channel', pts:[[lat,lon],...], widthM}] */
  load(carvings, log = console.log) {
    const cacheDir = path.join(DATA_DIR, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    const carveHash = hashString(JSON.stringify(carvings));
    for (const layer of this.layers) {
      const cacheFile = path.join(cacheDir, `${layer.def.name}-${layer.res}-v${CACHE_VERSION}-${carveHash}.bin`);
      if (fs.existsSync(cacheFile)) {
        const buf = fs.readFileSync(cacheFile);
        if (buf.length === layer.w * layer.h) {
          layer.hgt = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
          log(`[world] ${layer.def.name}: loaded cache ${path.basename(cacheFile)}`);
          continue;
        }
      }
      buildLayer(layer, carvings, log);
      fs.writeFileSync(cacheFile, layer.hgt);
    }
    return this;
  }

  layerFor(lat, lon) {
    for (let i = this.layers.length - 1; i >= 0; i--) if (this.layers[i].contains(lat, lon)) return this.layers[i];
    return this.layers[0];
  }
  heightAt(lat, lon) { return this.layerFor(lat, lon).heightAt(lat, lon); }
  depthAt(lat, lon) { return -this.heightAt(lat, lon); } // positive = water depth in metres
  isWater(lat, lon) { return this.heightAt(lat, lon) < 0; }

  tile(level, tx, ty) {
    const layer = this.layers[level];
    if (!layer || tx < 0 || ty < 0 || tx >= layer.tilesX() || ty >= layer.tilesY()) return null;
    return layer.tile(tx, ty);
  }

  // Simple RGB chart of a layer, downsampled by `step`.
  chartPNG(level, step) {
    const key = `${level}-${step}`;
    if (this.charts[key]) return this.charts[key];
    const layer = this.layers[level];
    const w = Math.floor(layer.w / step), h = Math.floor(layer.h / step);
    const px = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const hm = decodeHeight(layer.hgt[(y * step) * layer.w + x * step]);
        const o = (y * w + x) * 3;
        if (hm >= 0) {
          const t = Math.min(1, hm / 120);
          px[o] = 200 - 70 * t; px[o + 1] = 190 - 60 * t; px[o + 2] = 150 - 50 * t;
        } else {
          const t = Math.min(1, -hm / 120);
          px[o] = 120 - 90 * t; px[o + 1] = 170 - 100 * t; px[o + 2] = 210 - 90 * t;
        }
      }
    }
    this.charts[key] = encodePNG(w, h, px, 3);
    return this.charts[key];
  }

  // Find nearest water cell (in the finest layer containing the point) within maxCells; used to place spawns.
  nearestWater(lat, lon, maxCells = 20) {
    const layer = this.layerFor(lat, lon);
    const { cx, cy } = layer.cellXY(lat, lon);
    const x0 = Math.floor(cx), y0 = Math.floor(cy);
    for (let r = 0; r <= maxCells; r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = x0 + dx, y = y0 + dy;
        if (x < 0 || y < 0 || x >= layer.w || y >= layer.h) continue;
        if (decodeHeight(layer.hgt[y * layer.w + x]) < -6) {
          return { lat: layer.def.latMax - (y + 0.5) * layer.res, lon: layer.def.lonMin + (x + 0.5) * layer.res };
        }
      }
    }
    return { lat, lon };
  }
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}
