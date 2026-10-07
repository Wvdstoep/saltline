// Terrain tiles: fetches Uint8 height tiles from the server, builds vertex-coloured meshes in the floating-origin
// frame, provides bilinear height lookups (real metres) for grounding checks and the ocean depth texture.
import * as THREE from 'three';
import { GEO, TILE, LAYERS, decodeHeight } from '/shared/constants.js';
import { toLocal } from '/shared/geo.js';

export const VSCALE = 1; // the world is rendered 1:1 — real metres horizontally and vertically

const N = TILE.CELLS + 1;

export class Terrain {
  constructor(scene) {
    this.scene = scene;
    this.tiles = new Map(); // key -> { level, tx, ty, data, mesh, anchor }
    this.pending = new Set();
    this.origin = { lat: 0, lon: 0 };
    this.group = new THREE.Group();
    scene.add(this.group);
    this.mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.version = 0; // bumps when tiles load (ocean depth texture refresh)
  }
  setOrigin(origin) {
    this.origin = origin;
    for (const t of this.tiles.values()) if (t.mesh) this.buildMesh(t);
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
    const c = new THREE.Color();
    for (let j = 0; j < N; j++) {
      const lat = lat0 - (j + 0.5) * d.res; // sample j is the CENTRE of raster cell ty*CELLS+j (same convention as the server)
      for (let i = 0; i < N; i++) {
        const lon = lon0 + (i + 0.5) * d.res;
        const p = toLocal(lat, lon, this.origin);
        let h = decodeHeight(t.data[j * N + i]);
        if (inRegion(t.tx * TILE.CELLS + i, t.ty * TILE.CELLS + j)) h = -260; // the detail layer renders this area; sink the coarse one
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
  /** Real-metre height at lat/lon from the finest loaded tile, bilinear. null if not loaded. */
  heightAt(lat, lon) {
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
