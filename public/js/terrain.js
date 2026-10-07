// Terrain tiles: fetches Uint8 height tiles from the server, builds vertex-coloured meshes in the floating-origin
// frame, provides bilinear height lookups (real metres) for grounding checks and the ocean depth texture.
// v0.3: high-resolution harbour patches (docs/V3-CONTRACTS.md §5) rendered as mask-coloured meshes; the coarse tiles
// are sunk under a patch footprint (same trick as the region cut-out) and `heightAt` consults patches first.
import * as THREE from 'three';
import { GEO, TILE, LAYERS, PATCH, decodeHeight, decodePatchHeight } from '/shared/constants.js';
import { toLocal } from '/shared/geo.js';
import { patchHeightAt } from './harborgeom.js';

export const VSCALE = 1; // the world is rendered 1:1 — real metres horizontally and vertically

const N = TILE.CELLS + 1;
const SUNK_Y = -260;
const WATER_OFFSET = 2.5;     // patch water vertices sit this far under their real depth (keeps wave troughs off the bed)
const PATCH_SKIRT_M = 2;      // coarse vertices in the patch's outer ring are clamped this far under the patch surface
const M = PATCH.MASK;

export class Terrain {
  constructor(scene) {
    this.scene = scene;
    this.tiles = new Map(); // key -> { level, tx, ty, data, mesh, anchor }
    this.pending = new Set();
    this.patches = new Map(); // harbour id -> { id, entry, mesh, bbox }
    this.origin = { lat: 0, lon: 0 };
    this.group = new THREE.Group();
    scene.add(this.group);
    this.mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.patchMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.version = 0; // bumps when tiles / patches load (ocean depth texture refresh)
    this.halfRes = (navigator.hardwareConcurrency || 8) <= 4 || (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) || navigator.maxTouchPoints > 1;
  }
  setOrigin(origin) {
    this.origin = origin;
    for (const t of this.tiles.values()) if (t.mesh) this.buildMesh(t);
    for (const p of this.patches.values()) this.placePatch(p);
  }
  layerDef(level) { return LAYERS[level]; }
  tileOf(level, lat, lon) {
    const d = LAYERS[level];
    return { tx: Math.floor((lon - d.lonMin) / d.res / TILE.CELLS), ty: Math.floor((d.latMax - lat) / d.res / TILE.CELLS) };
  }
  inLayer(level, lat, lon, margin = 0) {
    const d = LAYERS[level];
    return lat >= d.latMin - margin && lat < d.latMax + margin && lon >= d.lonMin - margin && lon < d.lonMax + margin;
  }
  /** Ensure tiles around (lat, lon) are loaded; drop far ones. */
  update(lat, lon) {
    const want = new Set();
    const req = (level, tx, ty) => {
      const d = LAYERS[level];
      const maxX = Math.ceil((d.lonMax - d.lonMin) / d.res / TILE.CELLS), maxY = Math.ceil((d.latMax - d.latMin) / d.res / TILE.CELLS);
      if (tx < 0 || ty < 0 || tx >= maxX || ty >= maxY) return;
      const key = `${level}/${tx}/${ty}`;
      want.add(key);
      if (!this.tiles.has(key) && !this.pending.has(key)) this.fetch(level, tx, ty, key);
    };
    const g = this.tileOf(0, lat, lon);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) req(0, g.tx + dx, g.ty + dy);
    if (this.inLayer(1, lat, lon, 0.4)) {
      const r = this.tileOf(1, lat, lon);
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) req(1, r.tx + dx, r.ty + dy);
    }
    for (const [key, t] of this.tiles) {
      if (!want.has(key)) { if (t.mesh) { this.group.remove(t.mesh); t.mesh.geometry.dispose(); } this.tiles.delete(key); }
    }
  }
  async fetch(level, tx, ty, key) {
    this.pending.add(key);
    try {
      const r = await fetch(`/api/tile/${level}/${tx}/${ty}`);
      if (!r.ok) throw new Error(r.status);
      const data = new Uint8Array(await r.arrayBuffer());
      const t = { level, tx, ty, data, mesh: null };
      this.tiles.set(key, t);
      this.buildMesh(t);
      this.version++;
    } catch (e) { /* retried on next update */ }
    finally { this.pending.delete(key); }
  }
  /** lat/lon bounds of a tile's vertex grid (cell centres). */
  tileBounds(t) {
    const d = LAYERS[t.level];
    const lat0 = d.latMax - t.ty * TILE.CELLS * d.res, lon0 = d.lonMin + t.tx * TILE.CELLS * d.res;
    return { latMax: lat0, latMin: lat0 - N * d.res, lonMin: lon0, lonMax: lon0 + N * d.res, res: d.res };
  }
  /**
   * How a coarse vertex at lat/lon relates to the loaded patches: 'sink' when at least one coarse cell inside a
   * footprint (hidden under the patch mesh), a clamp height when in the outer ring or within one cell outside
   * (keeps the coarse surface just under the patch where the two disagree), or null.
   */
  patchSink(lat, lon, res) {
    let clamp = null;
    for (const p of this.patches.values()) {
      const b = p.bbox;
      const din = Math.min(lat - b.latMin, b.latMax - lat, lon - b.lonMin, b.lonMax - lon); // > 0 inside
      if (din >= res) return { sink: true };
      if (din < -res) continue;
      const e = p.entry;
      const cl = (la, lo) => patchHeightAt(e, Math.min(b.latMax - 1e-6, Math.max(b.latMin + 1e-6, la)), Math.min(b.lonMax - 1e-6, Math.max(b.lonMin + 1e-6, lo)));
      const hs = [cl(lat, lon), cl(lat + res / 2, lon), cl(lat - res / 2, lon), cl(lat, lon + res / 2), cl(lat, lon - res / 2)].filter((h) => h != null);
      if (!hs.length) continue;
      const hmin = Math.min(...hs) - PATCH_SKIRT_M;
      clamp = clamp == null ? hmin : Math.min(clamp, hmin);
    }
    return clamp == null ? null : { clamp };
  }
  buildMesh(t) {
    const d = LAYERS[t.level];
    const lat0 = d.latMax - t.ty * TILE.CELLS * d.res, lon0 = d.lonMin + t.tx * TILE.CELLS * d.res;
    const pos = new Float32Array(N * N * 3), col = new Float32Array(N * N * 3);
    // Region cut-out, in global cell indices (robust against float rounding of the vertex lon/lat). A global cell is
    // sunk only when it lies at least one full cell INSIDE the region window, so the drop-off slope to the sunk
    // vertices is always hidden under the fine region tiles instead of forming a trench along the boundary.
    const R = LAYERS[1];
    const bx0 = Math.round((R.lonMin - d.lonMin) / d.res), bx1 = Math.round((R.lonMax - d.lonMin) / d.res);
    const by0 = Math.round((d.latMax - R.latMax) / d.res), by1 = Math.round((d.latMax - R.latMin) / d.res);
    const inRegion = (gi, gj) => t.level === 0 && gi > bx0 && gi < bx1 - 1 && gj > by0 && gj < by1 - 1;
    // harbour patches: only tiles whose bounds touch a patch pay for the per-vertex test
    const tb = this.tileBounds(t);
    const patchesNear = [...this.patches.values()].some((p) => p.bbox.latMin - d.res < tb.latMax && p.bbox.latMax + d.res > tb.latMin && p.bbox.lonMin - d.res < tb.lonMax && p.bbox.lonMax + d.res > tb.lonMin);
    const c = new THREE.Color();
    for (let j = 0; j < N; j++) {
      const lat = lat0 - (j + 0.5) * d.res; // sample j is the CENTRE of raster cell ty*CELLS+j (same convention as the server)
      for (let i = 0; i < N; i++) {
        const lon = lon0 + (i + 0.5) * d.res;
        const p = toLocal(lat, lon, this.origin);
        let h = decodeHeight(t.data[j * N + i]);
        if (inRegion(t.tx * TILE.CELLS + i, t.ty * TILE.CELLS + j)) h = SUNK_Y; // the detail layer renders this area; sink the coarse one
        else if (patchesNear) { const s = this.patchSink(lat, lon, d.res); if (s) { if (s.sink) h = SUNK_Y; else h = Math.min(h, s.clamp); } }
        const k = (j * N + i) * 3;
        pos[k] = p.x; pos[k + 1] = h < 0 ? h * VSCALE - 4 : h * VSCALE; pos[k + 2] = p.z;
        const v = hash2(t.tx * 131 + i, t.ty * 173 + j) * 0.12 - 0.06;
        if (h < 0) c.setRGB(0.32 + v, 0.30 + v, 0.22).multiplyScalar(Math.max(0.35, 1 + h / 120));
        else if (h < 4) c.setRGB(0.78 + v, 0.72 + v, 0.52);
        else if (h < 45) { const s = (h - 4) / 41; c.setRGB(0.26 + 0.12 * s + v, 0.47 - 0.08 * s + v, 0.2 + 0.05 * s); }
        else if (h < 95) { const s = (h - 45) / 50; c.setRGB(0.4 + 0.1 * s + v, 0.38 + 0.08 * s + v, 0.33 + 0.1 * s); }
        else c.setRGB(0.72 + v, 0.72 + v, 0.74);
        col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b;
      }
    }
    let geo;
    if (t.mesh) { geo = t.mesh.geometry; geo.attributes.position.array.set(pos); geo.attributes.position.needsUpdate = true; geo.computeVertexNormals(); geo.computeBoundingSphere(); return; }
    geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const idx = new Uint32Array(TILE.CELLS * TILE.CELLS * 6);
    let q = 0;
    for (let j = 0; j < TILE.CELLS; j++) for (let i = 0; i < TILE.CELLS; i++) {
      const a = j * N + i, b = a + 1, c2 = a + N, dd = c2 + 1;
      idx[q++] = a; idx[q++] = c2; idx[q++] = b; idx[q++] = b; idx[q++] = c2; idx[q++] = dd;
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    t.mesh = new THREE.Mesh(geo, this.mat);
    t.mesh.frustumCulled = true;
    this.group.add(t.mesh);
  }

  // ------------------------------------------------------------------ harbour patches
  /** Add (or replace) the high-resolution mesh of a harbour patch entry (HarborGeomSet entry, §5). */
  addPatch(entry) {
    if (!entry || !entry.mask || !entry.heights) return null;
    if (this.patches.has(entry.id)) this.removePatch(entry.id, false);
    const n = entry.n, res = entry.res, step = this.halfRes ? 2 : 1;
    const m = Math.floor(n / step);                     // vertices per side
    const pos = new Float32Array(m * m * 3), col = new Float32Array(m * m * 3);
    const c = new THREE.Color();
    const prio = (code) => (code === M.BREAKWATER ? 5 : code === M.QUAY ? 4 : code === M.PONTOON ? 3 : code === M.LAND ? 2 : code === M.SHALLOW ? 1 : 0);
    for (let b = 0; b < m; b++) {
      for (let a = 0; a < m; a++) {
        const i = a * step, j = b * step;
        // sample the step×step block: structures win so thin piers survive half resolution
        let code = -1, bestP = -1, hStruct = -Infinity, hSum = 0, cnt = 0;
        for (let dj = 0; dj < step; dj++) for (let di = 0; di < step; di++) {
          const ii = Math.min(n - 1, i + di), jj = Math.min(n - 1, j + dj), k = jj * n + ii;
          const mk = entry.mask[k], hh = decodePatchHeight(entry.heights[k]), pr = prio(mk);
          if (pr > bestP) { bestP = pr; code = mk; hStruct = hh; } else if (pr === bestP) hStruct = Math.max(hStruct, hh);
          hSum += hh; cnt++;
        }
        const obstacle = code === M.LAND || code === M.QUAY || code === M.BREAKWATER || code === M.PONTOON;
        const h = obstacle ? hStruct : hSum / cnt;
        const x = (i + step / 2 - n / 2) * res, z = (j + step / 2 - n / 2) * res;
        const k = (b * m + a) * 3;
        pos[k] = x; pos[k + 1] = obstacle ? h * VSCALE : h * VSCALE - WATER_OFFSET; pos[k + 2] = z;
        const v = hash2(i * 7 + 1, j * 13 + 3) * 0.06 - 0.03;
        switch (code) {
          case M.QUAY: c.setHex(0x8e8b84); break;
          case M.BREAKWATER: c.setHex(0x5a5650); break;
          case M.PONTOON: c.setHex(0xb9b2a4); break;
          case M.LAND: { const s = Math.min(1, Math.max(0, (h - 2.5) / 9)); c.setRGB(0.78 + v, 0.72 + v, 0.52).lerp(new THREE.Color(0.30, 0.46, 0.22), s); break; }
          case M.SHALLOW: c.setRGB(0.62 + v, 0.58 + v, 0.42); break;
          case M.FAIRWAY: c.setRGB(0.25 + v, 0.26 + v, 0.22).multiplyScalar(0.55 + 0.45 * Math.max(0, 1 + h / 24)); break;
          default: c.setRGB(0.31 + v, 0.30 + v, 0.22).multiplyScalar(0.55 + 0.45 * Math.max(0, 1 + h / 24)); break;
        }
        if (code === M.QUAY || code === M.BREAKWATER || code === M.PONTOON) c.multiplyScalar(1 + v);
        col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const idx = new Uint32Array((m - 1) * (m - 1) * 6);
    let q = 0;
    for (let b = 0; b < m - 1; b++) for (let a = 0; a < m - 1; a++) {
      const p0 = b * m + a, p1 = p0 + 1, p2 = p0 + m, p3 = p2 + 1;
      idx[q++] = p0; idx[q++] = p2; idx[q++] = p1; idx[q++] = p1; idx[q++] = p2; idx[q++] = p3;
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, this.patchMat);
    mesh.frustumCulled = true;
    mesh.renderOrder = 0;
    const p = { id: entry.id, entry, mesh, bbox: entry.bbox };
    this.patches.set(entry.id, p);
    this.group.add(mesh);
    this.placePatch(p);
    this.rebuildAffectedTiles(entry.bbox);
    this.version++;
    return mesh;
  }
  removePatch(id, rebuild = true) {
    const p = this.patches.get(id); if (!p) return;
    this.group.remove(p.mesh); p.mesh.geometry.dispose();
    this.patches.delete(id);
    if (rebuild) { this.rebuildAffectedTiles(p.bbox); this.version++; }
  }
  hasPatch(id) { return this.patches.has(id); }
  placePatch(p) {
    const l = toLocal(p.entry.origin.lat, p.entry.origin.lon, this.origin);
    p.mesh.position.set(l.x, 0, l.z);
  }
  rebuildAffectedTiles(bbox) {
    for (const t of this.tiles.values()) {
      if (!t.mesh) continue;
      const d = LAYERS[t.level], tb = this.tileBounds(t);
      const m = 1.5 * d.res;
      if (bbox.latMin - m < tb.latMax && bbox.latMax + m > tb.latMin && bbox.lonMin - m < tb.lonMax && bbox.lonMax + m > tb.lonMin) this.buildMesh(t);
    }
  }

  /** Real-metre height at lat/lon: harbour patches first (bilinear over their 10 m heights), then the finest loaded tile. null if unknown. */
  heightAt(lat, lon) {
    for (const p of this.patches.values()) {
      const b = p.bbox;
      if (lat < b.latMin || lat > b.latMax || lon < b.lonMin || lon > b.lonMax) continue;
      const h = patchHeightAt(p.entry, lat, lon);
      if (h != null) return h;
    }
    for (let level = LAYERS.length - 1; level >= 0; level--) {
      if (!this.inLayer(level, lat, lon)) continue;
      const d = LAYERS[level];
      // Tile samples are cell CENTRES (server convention): shift by half a cell BEFORE choosing the tile so the
      // first half-cell of every tile interpolates with the previous tile's 65th (overlap) sample.
      const gx = (lon - d.lonMin) / d.res - 0.5, gy = (d.latMax - lat) / d.res - 0.5;
      const tx = Math.max(0, Math.floor(gx / TILE.CELLS)), ty = Math.max(0, Math.floor(gy / TILE.CELLS));
      const t = this.tiles.get(`${level}/${tx}/${ty}`);
      if (!t) continue;
      const fx = gx - tx * TILE.CELLS, fy = gy - ty * TILE.CELLS;
      const x0 = Math.min(TILE.CELLS - 1, Math.max(0, Math.floor(fx))), y0 = Math.min(TILE.CELLS - 1, Math.max(0, Math.floor(fy)));
      const sx = Math.min(1, Math.max(0, fx - x0)), sy = Math.min(1, Math.max(0, fy - y0)); // clamped like the server's edge samples
      const g = (x, y) => decodeHeight(t.data[y * N + x]);
      return (g(x0, y0) * (1 - sx) + g(x0 + 1, y0) * sx) * (1 - sy) + (g(x0, y0 + 1) * (1 - sx) + g(x0 + 1, y0 + 1) * sx) * sy;
    }
    return null;
  }
}

function hash2(a, b) { let h = (a * 374761393 + b * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
