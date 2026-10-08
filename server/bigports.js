// Big multi-basin ports (V7 step 0 "big ports"): the real navigable water of Antwerp + the Westerschelde, Rotterdam,
// Hamburg + the Elbe, IJmuiden / Amsterdam, Bremerhaven, Le Havre, Zeebrugge, Gothenburg and Felixstowe from
// OpenStreetMap (scripts/fetch-port-water.mjs → server/bigports/<id>.json: coastline, water / dock / river / canal /
// lock areas with their holes, river / canal / fairway centrelines; Google polyline encoding, 1e-5°).
//
// Three users:
//  * world.js carves each port bbox into the 0.005° region raster from a fine (≈ 20 m) land/water model of the port
//    (overridePortCells): cells are water when ≥ 40 % of their area is OSM water or a fairway / river centreline crosses them, docks and
//    rivers are dredged, everything else in the bbox becomes land (no more Natural-Earth blobs or round basins).
//  * harborgeom.js gives every big port several 4.48 km harbour patches tiled around the harbour patch over the port's
//    core (subPatchesFor), and augments the OSM payload of any patch inside a port with these water polygons (the
//    runtime Overpass query has no river / water multipolygons) — offline it builds the patch from them alone.
//  * the tests: portWaterKind(port, lat, lon) samples the fine model.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GEO, PATCH } from '../shared/constants.js';
import { landPolygonsFromCoastline } from './osm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(__dirname, 'bigports');
const D2R = Math.PI / 180;

/** Fine-model cell kinds. */
export const KIND = { LAND: 0, SEA: 1, RIVER: 2, DOCK: 3, CANAL: 4, WATER: 5 };
const KIND_OF = { river: KIND.RIVER, dock: KIND.DOCK, harbour: KIND.DOCK, lock: KIND.DOCK, canal: KIND.CANAL, water: KIND.WATER };
/** Minimum depth (m) a raster cell of that kind is dredged to; fairway cells get FAIRWAY_DEPTH_M. */
export const KIND_DEPTH = [0, 0, 14, 15, 13, 8];
export const FAIRWAY_DEPTH_M = 16;

/**
 * Per port: `core` [s, w, n, e] = the terminals area tiled with harbour patches; `max` caps the number of extra patches.
 * The data bbox comes from the JSON (it also covers the approach: the Scheldt from Vlissingen, the Elbe from Cuxhaven).
 */
export const PORT_DEFS = {
  antwerp: { core: [51.215, 4.17, 51.375, 4.43], max: 16 },
  // Rotterdam: Maasvlakte / Europoort keep the 2026-10-07 waterway raster (server/harbors.js CHANNELS — the route and
  // tug tests are built on it); the city docks east of 4.25° E (Botlek, Eemhaven, Waalhaven, Nieuwe Maas) are carved.
  rotterdam: { core: [51.865, 3.98, 51.995, 4.50], max: 26, rasterBox: [51.84, 4.25, 52.01, 4.55] },
  hamburg: { core: [53.48, 9.80, 53.56, 10.06], max: 12 },
  amsterdam: { core: [52.38, 4.56, 52.48, 4.94], max: 18 },
  bremerhaven: { core: [53.52, 8.47, 53.63, 8.60], max: 6 },
  le_havre: { core: [49.43, 0.06, 49.50, 0.27], max: 8 },
  zeebrugge: { core: [51.31, 3.15, 51.37, 3.24], max: 4 },
  gothenburg: { core: [57.66, 11.78, 57.72, 11.97], max: 8 },
  felixstowe: { core: [51.93, 1.24, 51.98, 1.33], max: 4 },
};

// ---------------------------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------------------------
/** Google encoded polyline (precision 1e-5) → [[lat, lon], …]. */
export function decodePolyline(s) {
  const out = [];
  let i = 0, lat = 0, lon = 0;
  const next = () => { let r = 0, sh = 0, b; do { b = s.charCodeAt(i++) - 63; r |= (b & 0x1f) << sh; sh += 5; } while (b >= 0x20 && i < s.length + 1); return r & 1 ? ~(r >> 1) : r >> 1; };
  while (i < s.length) { lat += next(); lon += next(); out.push([lat / 1e5, lon / 1e5]); }
  return out;
}
function hashString(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); }
const distinct = (pts) => pts.filter((p, k) => k === 0 || p[0] !== pts[k - 1][0] || p[1] !== pts[k - 1][1]);

function loadPort(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const j = JSON.parse(raw);
  const [s, w, n, e] = j.bbox;
  const def = PORT_DEFS[j.id] || { core: j.bbox, max: 8 };
  return {
    id: j.id, harbor: j.harbor, name: j.name, hash: hashString(raw),
    bbox: { latMin: s, lonMin: w, latMax: n, lonMax: e },
    core: { latMin: def.core[0], lonMin: def.core[1], latMax: def.core[2], lonMax: def.core[3] }, maxPatches: def.max, raster: def.raster !== false,
    rasterBox: def.rasterBox ? { latMin: def.rasterBox[0], lonMin: def.rasterBox[1], latMax: def.rasterBox[2], lonMax: def.rasterBox[3] } : null,
    coast: j.coast.map(decodePolyline).map(distinct).filter((p) => p.length >= 2),
    water: j.water.map((x) => ({ k: x.k, rings: x.r.map(decodePolyline).map(distinct).filter((r) => r.length >= 3) })).filter((x) => x.rings.length),
    lines: j.lines.map((x) => ({ k: x.k, w: x.w || null, pts: distinct(decodePolyline(x.r)) })).filter((x) => x.pts.length >= 2),
    grid: null,
  };
}
function loadAll() {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort(); } catch { return out; }
  for (const f of files) {
    try { out.push(loadPort(path.join(DIR, f))); } catch (err) { console.warn('[bigports] bad file', f, err?.message || err); }
  }
  return out;
}
export const BIG_PORTS = loadAll();
export function bigPortById(id) { return BIG_PORTS.find((p) => p.id === id) || null; }
const inBox = (b, lat, lon) => lat >= b.latMin && lat <= b.latMax && lon >= b.lonMin && lon <= b.lonMax;
/** The big port whose data bbox contains lat/lon (null elsewhere). */
export function bigPortAt(lat, lon) { for (const p of BIG_PORTS) if (inBox(p.bbox, lat, lon)) return p; return null; }
/** World-raster carving entries (their hash makes the raster cache rebuild whenever a port file changes). */
/** Bump when the carving code changes (the raster cache key hashes the carvings). */
export const PORT_CARVE_VERSION = 7;
/** Stamp a harbour patch built with this port's data carries (harborgeom.js rebuilds caches without the current one). */
export const PORT_GEOM_VERSION = 1;
export function geomStamp(port) { return `${port.id}:${port.hash}:${PORT_GEOM_VERSION}`; }
export function portCarvings() { return BIG_PORTS.filter((p) => p.raster).map((p) => ({ type: 'port', id: p.id, hash: p.hash, v: PORT_CARVE_VERSION })); }

// ---------------------------------------------------------------------------------------------------------------
// Fine land/water model of a port (≈ 20 m cells over the data bbox, built lazily, kept in memory)
// ---------------------------------------------------------------------------------------------------------------
const FINE_DLAT = 0.0002;
/** Even-odd scanline fill of [[lat,lon]] rings into a grid (cell centres): the kind `value`, or (bit > 0) a flag bit
 *  in g.fair on water cells only (1 = fairway, 2 = river / canal centreline). */
function fillRings(g, rings, value, bit = 0) {
  const { w, h } = g;
  const rows = new Array(h);
  let r0all = h, r1all = -1;
  for (const ring of rings) {
    const m = ring.length;
    for (let i = 0; i < m; i++) {
      const a = ring[i], b = ring[(i + 1) % m];
      const ay = (g.latMax - a[0]) / g.dLat, by = (g.latMax - b[0]) / g.dLat;
      if (ay === by) continue;
      const ax = (a[1] - g.lonMin) / g.dLon, bx = (b[1] - g.lonMin) / g.dLon;
      let r0 = Math.ceil(Math.min(ay, by) - 0.5), r1 = Math.ceil(Math.max(ay, by) - 0.5) - 1;
      if (r1 < 0 || r0 >= h) continue;
      r0 = Math.max(0, r0); r1 = Math.min(h - 1, r1);
      const dxdy = (bx - ax) / (by - ay);
      for (let r = r0; r <= r1; r++) (rows[r] || (rows[r] = [])).push(ax + (r + 0.5 - ay) * dxdy);
      if (r0 < r0all) r0all = r0; if (r1 > r1all) r1all = r1;
    }
  }
  for (let r = r0all; r <= r1all; r++) {
    const xs = rows[r]; if (!xs || xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      let c0 = Math.ceil(xs[k] - 0.5), c1 = Math.ceil(xs[k + 1] - 0.5) - 1;
      if (c1 < 0 || c0 >= w) continue;
      c0 = Math.max(0, c0); c1 = Math.min(w - 1, c1);
      if (bit) { for (let c = c0; c <= c1; c++) if (g.kind[r * w + c] !== KIND.LAND) g.fair[r * w + c] |= bit; }
      else g.kind.fill(value, r * w + c0, r * w + c1 + 1);
    }
  }
}
/** A polyline buffered by halfW metres as one quad per segment (good enough for 20 m cells). */
function segmentQuads(pts, halfW) {
  const out = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const k = Math.cos(a[0] * D2R) * GEO.M_PER_DEG_LON_EQ;
    const dx = (b[1] - a[1]) * k, dy = (b[0] - a[0]) * GEO.M_PER_DEG_LAT, L = Math.hypot(dx, dy);
    if (L < 1) continue;
    const ex = (dx / L) * halfW, ey = (dy / L) * halfW;    // along (metres east, north), extends both ends by halfW
    const nx = -ey, ny = ex;                                // left normal
    const P = (p, mx, my) => [p[0] + my / GEO.M_PER_DEG_LAT, p[1] + mx / k];
    out.push([P(a, -ex + nx, -ey + ny), P(b, ex + nx, ey + ny), P(b, ex - nx, ey - ny), P(a, -ex - nx, -ey - ny)]);
  }
  return out;
}
export function portGrid(port) {
  if (port.grid) return port.grid;
  const t0 = Date.now();
  const b = port.bbox;
  const mid = ((b.latMin + b.latMax) / 2) * D2R;
  const dLat = FINE_DLAT, dLon = FINE_DLAT / Math.cos(mid);
  const w = Math.ceil((b.lonMax - b.lonMin) / dLon), h = Math.ceil((b.latMax - b.latMin) / dLat);
  const g = { latMin: b.latMin, latMax: b.latMax, lonMin: b.lonMin, lonMax: b.lonMin + w * dLon, dLat, dLon, w, h, kind: new Uint8Array(w * h).fill(KIND.SEA), fair: new Uint8Array(w * h) };
  g.latMin = g.latMax - h * dLat;
  // land from the OSM coastline (land on the left), closed against the bbox
  const land = landPolygonsFromCoastline(port.coast, { latMin: g.latMin, latMax: g.latMax, lonMin: g.lonMin, lonMax: g.lonMax }, { defaultLand: true });
  fillRings(g, land, KIND.LAND);
  // inland water: big areas first so docks / locks drawn over a river keep their kind
  const order = [KIND.WATER, KIND.RIVER, KIND.CANAL, KIND.DOCK];
  for (const kc of order) for (const wa of port.water) if (KIND_OF[wa.k] === kc) fillRings(g, wa.rings, kc);
  // fairway flags, then the centrelines of the rivers / canals that run in mapped water (navigable; a stream mapped
  // only as a line is not carved)
  for (const l of port.lines) if (l.k === 'fairway') for (const q of segmentQuads(l.pts, Math.max(60, (l.w || 250) / 2))) fillRings(g, [q], 0, 1);
  // centrelines: a raster cell a river / canal runs through stays water even when the river is narrower than the cell
  const wet = (p) => { const c = Math.floor((p[1] - g.lonMin) / g.dLon), r = Math.floor((g.latMax - p[0]) / g.dLat); return c >= 0 && r >= 0 && c < g.w && r < g.h && g.kind[r * g.w + c] !== KIND.LAND; };
  for (const l of port.lines) {
    if (l.k === 'fairway') continue;
    let n = 0, inW = 0;
    for (let i = 0; i + 1 < l.pts.length; i++) for (let t = 0; t < 1; t += 0.25) { n++; if (wet([l.pts[i][0] + (l.pts[i + 1][0] - l.pts[i][0]) * t, l.pts[i][1] + (l.pts[i + 1][1] - l.pts[i][1]) * t])) inW++; }
    l.navigable = n > 0 && inW >= 0.6 * n;
    if (l.navigable) for (const q of segmentQuads(l.pts, 12)) fillRings(g, [q], 0, 2);
  }
  g.buildMs = Date.now() - t0;
  port.grid = g;
  return g;
}
/** Fine-model kind at lat/lon (KIND.*), or -1 outside the port bbox. */
export function portWaterKind(port, lat, lon) {
  const g = portGrid(port);
  const c = Math.floor((lon - g.lonMin) / g.dLon), r = Math.floor((g.latMax - lat) / g.dLat);
  if (c < 0 || r < 0 || c >= g.w || r >= g.h) return -1;
  return g.kind[r * g.w + c];
}
export function portIsFairway(port, lat, lon) {
  const g = portGrid(port);
  const c = Math.floor((lon - g.lonMin) / g.dLon), r = Math.floor((g.latMax - lat) / g.dLat);
  if (c < 0 || r < 0 || c >= g.w || r >= g.h) return false;
  return (g.fair[r * g.w + c] & 1) === 1;
}
/** Distance (m) from lat/lon to the nearest fine cell of the other state (water ↔ land), searched up to maxM. */
export function distanceToEdgeM(port, lat, lon, maxM = 500) {
  const g = portGrid(port);
  const c0 = Math.floor((lon - g.lonMin) / g.dLon), r0 = Math.floor((g.latMax - lat) / g.dLat);
  if (c0 < 0 || r0 < 0 || c0 >= g.w || r0 >= g.h) return Infinity;
  const wet = g.kind[r0 * g.w + c0] !== KIND.LAND;
  const mLat = g.dLat * GEO.M_PER_DEG_LAT, mLon = g.dLon * GEO.M_PER_DEG_LON_EQ * Math.cos(lat * D2R);
  const R = Math.ceil(maxM / Math.min(mLat, mLon));
  let best = Infinity;
  for (let dr = -R; dr <= R; dr++) {
    const r = r0 + dr; if (r < 0 || r >= g.h) continue;
    for (let dc = -R; dc <= R; dc++) {
      const c = c0 + dc; if (c < 0 || c >= g.w) continue;
      if ((g.kind[r * g.w + c] !== KIND.LAND) === wet) continue;
      const d = Math.hypot(dr * mLat, dc * mLon);
      if (d < best) best = d;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------------------
// World raster (world.js)
// ---------------------------------------------------------------------------------------------------------------
/**
 * Replace the land mask of every raster cell whose centre lies inside the port bbox by the fine model. Returns
 * Map(cellIndex → minimum depth m) for the water cells to dredge, and the set of cells that were set to land.
 * layer: world.js Layer (def.latMax / lonMin, res, w, h). keep: [{lat, lon}] harbour points — the cells around them stay water,
 * dredged to HARBOUR_CELL_DEPTH_M (a harbour a few hundred metres off a quay would otherwise read as a shallow coast cell).
 */
export const HARBOUR_CELL_DEPTH_M = 12;
export function overridePortCells(land, layer, port, keep = [], chains = []) {
  const g = portGrid(port);
  const { w, h, res } = layer, d = layer.def;
  const dredge = new Map(), landed = new Set();
  // cells the navigable chains (server/harbors.js CHANNELS: curated lane-graph centrelines) run through stay water
  // where the fine model has some water there — a 300 m basin running diagonally through 556 × 345 m cells
  const onChain = new Set();
  for (const pts of chains) for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const n = Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) / (res * 0.25)) + 1;
    for (let k = 0; k <= n; k++) {
      const la = a[0] + ((b[0] - a[0]) * k) / n, lo = a[1] + ((b[1] - a[1]) * k) / n;
      const x = Math.floor((lo - d.lonMin) / res), y = Math.floor((d.latMax - la) / res);
      if (x >= 0 && y >= 0 && x < w && y < h) onChain.add(y * w + x);
    }
  }
  // …and their neighbours (a 400 m river spread over two rows of 556 m cells: the raster is read bilinearly, so the
  // cells beside the chain must be water too where the river reaches into them)
  const nearChain = new Set();
  for (const k of onChain) { const x = k % w, y = (k - x) / w; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = x + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < w && Y < h) nearChain.add(Y * w + X); } }
  const b = port.rasterBox || port.bbox;
  const x0 = Math.max(0, Math.ceil((b.lonMin - d.lonMin) / res - 0.5)), x1 = Math.min(w - 1, Math.floor((b.lonMax - d.lonMin) / res - 0.5));
  const y0 = Math.max(0, Math.ceil((d.latMax - b.latMax) / res - 0.5)), y1 = Math.min(h - 1, Math.floor((d.latMax - b.latMin) / res - 0.5));
  const counts = new Uint32Array(6);
  for (let y = y0; y <= y1; y++) {
    const latTop = d.latMax - y * res, latBot = latTop - res;
    const r0 = Math.max(0, Math.floor((g.latMax - latTop) / g.dLat)), r1 = Math.min(g.h - 1, Math.ceil((g.latMax - latBot) / g.dLat) - 1);
    for (let x = x0; x <= x1; x++) {
      const lonL = d.lonMin + x * res, lonR = lonL + res;
      const c0 = Math.max(0, Math.floor((lonL - g.lonMin) / g.dLon)), c1 = Math.min(g.w - 1, Math.ceil((lonR - g.lonMin) / g.dLon) - 1);
      if (r1 < r0 || c1 < c0) continue;
      counts.fill(0);
      let fair = 0, ctr = 0, tot = 0;
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { const k = r * g.w + c, f = g.fair[k]; counts[g.kind[k]]++; fair += f & 1; ctr += f >> 1; tot++; }
      const water = tot - counts[KIND.LAND];
      const idx = y * w + x;
      const chainCell = onChain.has(y * w + x), byChain = nearChain.has(y * w + x);
      const isWater = water >= 0.4 * tot || (fair >= 0.12 * tot && water >= 0.2 * tot) || (ctr >= 3 && water >= 0.1 * tot) || (byChain && water >= 0.03 * tot);
      if (!isWater) { land[idx] = 1; landed.add(idx); continue; }
      land[idx] = 0;
      let depth = fair >= 0.12 * tot || chainCell ? FAIRWAY_DEPTH_M : byChain ? 12 : 0;
      // the inland kind covering most of the cell sets the dredged depth (sea keeps the distance model)
      let bestK = -1, bestN = 0;
      for (let k = 2; k <= 5; k++) if (counts[k] > bestN) { bestN = counts[k]; bestK = k; }
      if (bestK > 0 && bestN >= 0.25 * tot) depth = Math.max(depth, KIND_DEPTH[bestK]);
      if (depth > 0) dredge.set(idx, depth);
    }
  }
  for (const k of keep) {
    if (!inBox(port.bbox, k.lat, k.lon)) continue;
    // the four cells the bilinear heightAt reads at the harbour point
    const bx = Math.floor((k.lon - d.lonMin) / res - 0.5), by = Math.floor((d.latMax - k.lat) / res - 0.5);
    for (let yy = by; yy <= by + 1; yy++) for (let x = bx; x <= bx + 1; x++) {
      if (x < 0 || yy < 0 || x >= w || yy >= h) continue;
      const idx = yy * w + x;
      land[idx] = 0; landed.delete(idx);
      dredge.set(idx, Math.max(HARBOUR_CELL_DEPTH_M, dredge.get(idx) || 0));
    }
  }
  return { dredge, landed };
}

// ---------------------------------------------------------------------------------------------------------------
// Harbour patches (harborgeom.js)
// ---------------------------------------------------------------------------------------------------------------
const PATCH_M = PATCH.N * PATCH.RES;
const subCache = new Map();   // harbour id → [sub-patch harbour-like objects]
const subById = new Map();
/** Port whose data belongs to a harbour id (the port's own harbour) or that contains lat/lon. */
export function portForHarbor(h) {
  if (!h) return null;
  if (h.port) return bigPortById(h.port);
  return BIG_PORTS.find((p) => p.harbor === h.id) || bigPortAt(h.lat, h.lon);
}
/**
 * Extra harbour patches of a big port, tiled edge to edge around the harbour patch (same 4.48 km squares) over the
 * port's core: tiles with ≥ 0.1 km² of docks / basins / canals, or with a real shoreline (8–92 % water). Nearest first,
 * capped. Each is a harbour-like object {id, name, lat, lon, size, sub: true, parent, port} for harborgeom.
 */
export function subPatchesFor(h) {
  if (!h) return [];
  if (subCache.has(h.id)) return subCache.get(h.id);
  const port = BIG_PORTS.find((p) => p.harbor === h.id);
  const out = [];
  if (port) {
    const g = portGrid(port);
    const cellM2 = g.dLat * GEO.M_PER_DEG_LAT * g.dLon * GEO.M_PER_DEG_LON_EQ * Math.cos(h.lat * D2R);
    const c = port.core, cand = [];
    for (let r = -8; r <= 8; r++) {
      const lat = h.lat - (r * PATCH_M) / GEO.M_PER_DEG_LAT;
      const kLon = GEO.M_PER_DEG_LON_EQ * Math.cos(lat * D2R);
      for (let col = -12; col <= 12; col++) {
        if (r === 0 && col === 0) continue;
        const lon = h.lon + (col * PATCH_M) / kLon;
        const hl = PATCH_M / 2 / GEO.M_PER_DEG_LAT, hn = PATCH_M / 2 / kLon;
        if (lat + hl < c.latMin || lat - hl > c.latMax || lon + hn < c.lonMin || lon - hn > c.lonMax) continue;
        // score the tile on the fine model
        let water = 0, dock = 0, tot = 0;
        const rr0 = Math.max(0, Math.floor((g.latMax - (lat + hl)) / g.dLat)), rr1 = Math.min(g.h - 1, Math.floor((g.latMax - (lat - hl)) / g.dLat));
        const cc0 = Math.max(0, Math.floor((lon - hn - g.lonMin) / g.dLon)), cc1 = Math.min(g.w - 1, Math.floor((lon + hn - g.lonMin) / g.dLon));
        for (let rr = rr0; rr <= rr1; rr += 2) for (let cc = cc0; cc <= cc1; cc += 2) {
          const k = g.kind[rr * g.w + cc]; tot++;
          if (k !== KIND.LAND) water++;
          if (k === KIND.DOCK || k === KIND.CANAL) dock++;
        }
        if (!tot) continue;
        const wf = water / tot, dockM2 = dock * 4 * cellM2;
        if (dockM2 < 1e5 && !(wf >= 0.08 && wf <= 0.92)) continue;
        cand.push({ r, col, lat, lon, d: Math.hypot(r, col), score: dockM2 });
      }
    }
    cand.sort((a, b) => a.d - b.d || b.score - a.score);
    for (const t of cand.slice(0, port.maxPatches)) {
      const id = `${h.id}_t${String(t.r + 50).padStart(2, '0')}${String(t.col + 50).padStart(2, '0')}`;
      const sp = { id, name: `${h.name} (${t.r <= 0 ? 'N' : 'S'}${Math.abs(t.r)} ${t.col >= 0 ? 'E' : 'W'}${Math.abs(t.col)})`, country: h.country, lat: Math.round(t.lat * 1e6) / 1e6, lon: Math.round(t.lon * 1e6) / 1e6, size: 'regional', sub: true, parent: h.id, port: port.id };
      out.push(sp);
      subById.set(id, sp);
    }
  }
  subCache.set(h.id, out);
  return out;
}
/** All extra patches for a harbour list (the wire list the client tiles from). */
export function allSubPatches(harbors) {
  const out = [];
  for (const h of harbors) for (const s of subPatchesFor(h)) out.push({ id: s.id, lat: s.lat, lon: s.lon, parent: s.parent });
  return out;
}
export function subPatchById(id, harbors) {
  if (subById.has(id)) return subById.get(id);
  if (harbors && /_t\d{4}$/.test(id)) { const parent = harbors.find((h) => id.startsWith(h.id + '_t')); if (parent) subPatchesFor(parent); }
  return subById.get(id) || null;
}

/**
 * The OSM payload of a patch inside a big port, with the port's water added: `portWater` (areas with holes, filled
 * after land use), dock / basin / ship-canal outlines `portEdges` (quay walls where they part land from water), the port coastline when the payload has none, and
 * `defaultLand` (the background when no coastline crosses the patch) from the fine model. Works with osmData = null
 * (offline: the patch is built from the port data alone).
 */
export function augmentOSM(osmData, h, port = portForHarbor(h)) {
  if (!port) return osmData;
  const half = (PATCH.N * PATCH.RES) / 2 + 200;
  const dLat = half / GEO.M_PER_DEG_LAT, dLon = half / (GEO.M_PER_DEG_LON_EQ * Math.cos(h.lat * D2R));
  const box = { latMin: h.lat - dLat, latMax: h.lat + dLat, lonMin: h.lon - dLon, lonMax: h.lon + dLon };
  const touches = (pts) => { let a = 90, b = -90, c = 180, d = -180; for (const p of pts) { if (p[0] < a) a = p[0]; if (p[0] > b) b = p[0]; if (p[1] < c) c = p[1]; if (p[1] > d) d = p[1]; } return !(b < box.latMin || a > box.latMax || d < box.lonMin || c > box.lonMax); };
  const portWater = [], portEdges = [];
  for (const wa of port.water) {
    if (!touches(wa.rings[0])) continue;
    portWater.push({ k: wa.k, rings: wa.rings });
    if (wa.k === 'dock' || wa.k === 'harbour' || wa.k === 'canal') for (const r of wa.rings) portEdges.push(r.concat([r[0]]));
  }
  const base = osmData && Array.isArray(osmData.features) ? osmData : { coastline: [], features: [] };
  const hasCoast = Array.isArray(base.coastline) && base.coastline.length > 0;
  const coastline = hasCoast ? base.coastline : port.coast.filter(touches);
  // background: land unless most of the patch is open sea in the fine model
  const g = portGrid(port);
  let sea = 0, tot = 0;
  for (let la = box.latMin; la <= box.latMax; la += dLat / 10) for (let lo = box.lonMin; lo <= box.lonMax; lo += dLon / 10) {
    const c = Math.floor((lo - g.lonMin) / g.dLon), r = Math.floor((g.latMax - la) / g.dLat);
    if (c < 0 || r < 0 || c >= g.w || r >= g.h) continue;
    tot++; if (g.kind[r * g.w + c] === KIND.SEA) sea++;
  }
  return { ...base, coastline, portWater, portEdges, defaultLand: tot ? sea < 0.5 * tot : undefined, bigport: port.id };
}
