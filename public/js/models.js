// Small modelling helpers shared by ship.js and harbor.js: deterministic random, a geometry merger (three/addons'
// BufferGeometryUtils is not served, so this is the tiny subset we need), a "part builder" that collects boxes /
// cylinders / arbitrary geometries per material and emits ONE merged mesh per material (draw-call friendly, and every
// merged mesh is a direct child of its group with an identity transform, which keeps the wear shader's shipPos bake
// trivial), canvas textures (tileable alpha noise for foam, text boards) and 2-D polygon utilities for harbour rings.
import * as THREE from 'three';

export function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
export function rng(seed) { let s = (seed >>> 0) || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(1, 1, 1), _e = new THREE.Euler(), _m = new THREE.Matrix4();

/** Compose a transform matrix from position + euler rotation (+ optional scale). */
export function xform(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _p.set(x, y, z); _e.set(rx, ry, rz, 'YXZ'); _q.setFromEuler(_e); _s.set(sx, sy, sz);
  return new THREE.Matrix4().compose(_p, _q, _s);
}

/** Merge non-indexed position/normal/uv of several geometries into one BufferGeometry. Input geometries are disposed. */
export function mergeGeometries(geos) {
  const parts = [];
  let count = 0;
  for (const g0 of geos) {
    if (!g0 || !g0.attributes.position) continue;
    const g = g0.index ? g0.toNonIndexed() : g0;
    if (!g.attributes.normal) g.computeVertexNormals();
    parts.push(g); count += g.attributes.position.count;
    if (g !== g0) g0.dispose();
  }
  const pos = new Float32Array(count * 3), nrm = new Float32Array(count * 3), uv = new Float32Array(count * 2);
  let o = 0;
  for (const g of parts) {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array.subarray(0, n * 3), o * 3);
    nrm.set(g.attributes.normal.array.subarray(0, n * 3), o * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array.subarray(0, n * 2), o * 2);
    o += n;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  return out;
}

/** Collects geometry per material; build(group) adds one merged Mesh per material as a direct child of the group. */
export class PartBuilder {
  constructor() { this.buckets = new Map(); this.extra = []; }
  geo(geometry, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
    geometry.applyMatrix4(xform(x, y, z, rx, ry, rz, sx, sy, sz));
    let list = this.buckets.get(mat); if (!list) { list = []; this.buckets.set(mat, list); }
    list.push(geometry);
    return this;
  }
  box(w, h, d, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) { return this.geo(new THREE.BoxGeometry(w, h, d), mat, x, y, z, rx, ry, rz); }
  /** vertical cylinder; rt = top radius (defaults to r) */
  cyl(r, h, mat, x = 0, y = 0, z = 0, rt = r, seg = 12, rx = 0, ry = 0, rz = 0) { return this.geo(new THREE.CylinderGeometry(rt, r, h, seg), mat, x, y, z, rx, ry, rz); }
  /** cylinder along an arbitrary segment a→b (masts, stays, braces, pipes) */
  rod(ax, ay, az, bx, by, bz, r, mat, seg = 6) {
    const dx = bx - ax, dy = by - ay, dz = bz - az, len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return this;
    const g = new THREE.CylinderGeometry(r, r, len, seg);
    const dir = new THREE.Vector3(dx, dy, dz).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2), q, new THREE.Vector3(1, 1, 1)));
    let list = this.buckets.get(mat); if (!list) { list = []; this.buckets.set(mat, list); }
    list.push(g);
    return this;
  }
  cone(r, h, mat, x = 0, y = 0, z = 0, seg = 10, rx = 0, ry = 0, rz = 0) { return this.geo(new THREE.ConeGeometry(r, h, seg), mat, x, y, z, rx, ry, rz); }
  sphere(r, mat, x = 0, y = 0, z = 0, seg = 8) { return this.geo(new THREE.SphereGeometry(r, seg, Math.max(4, seg - 2)), mat, x, y, z); }
  /** a mesh that must stay separate (animated / multi-material / needs its own identity) */
  add(mesh) { this.extra.push(mesh); return this; }
  /** emits the merged meshes into `group`; returns them (extras included) */
  build(group) {
    const out = [];
    for (const [mat, list] of this.buckets) {
      if (!list.length) continue;
      const m = new THREE.Mesh(mergeGeometries(list), mat);
      m.frustumCulled = true;
      group.add(m); out.push(m);
    }
    for (const m of this.extra) { group.add(m); out.push(m); }
    this.buckets.clear(); this.extra.length = 0;
    return out;
  }
}

/** Standalone helpers for parts that need their own Mesh. */
export function boxMesh(w, h, d, mat, x = 0, y = 0, z = 0) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); return m; }
export function cylMesh(r, h, mat, x = 0, y = 0, z = 0, rt = r, seg = 12) { const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, r, h, seg), mat); m.position.set(x, y, z); return m; }

let _noiseTex = null;
/** Tileable soft-blob alpha noise (white, alpha varies) used by wakes, foam strips and harbour spray. Shared. */
export function noiseTexture() {
  if (_noiseTex) return _noiseTex;
  const S = 256, c = document.createElement('canvas'); c.width = S; c.height = S;
  const x = c.getContext('2d');
  x.fillStyle = 'rgba(255,255,255,0)'; x.clearRect(0, 0, S, S);
  const r = rng(1234567);
  for (let i = 0; i < 420; i++) {
    const px = r() * S, py = r() * S, rad = 6 + r() * 26, a = 0.18 + r() * 0.5;
    for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) { // wrap copies → seamless tiling
      const g = x.createRadialGradient(px + ox, py + oy, 0, px + ox, py + oy, rad);
      g.addColorStop(0, `rgba(255,255,255,${a})`); g.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = g; x.fillRect(px + ox - rad, py + oy - rad, rad * 2, rad * 2);
    }
  }
  // fine speckle
  const img = x.getImageData(0, 0, S, S), d = img.data;
  for (let i = 0; i < d.length; i += 4) { d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; d[i + 3] = Math.min(255, d[i + 3] * 0.85 + r() * 40); }
  x.putImageData(img, 0, 0);
  _noiseTex = new THREE.CanvasTexture(c);
  _noiseTex.wrapS = _noiseTex.wrapT = THREE.RepeatWrapping;
  _noiseTex.userData.shared = true;
  return _noiseTex;
}

/** Small text board texture (berth numbers, platform names). Caller disposes. */
export function textTexture(text, { w = 256, h = 128, bg = '#10243f', fg = '#ffffff', font = '700 72px Segoe UI, system-ui, sans-serif', sub = null } = {}) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  x.fillStyle = bg; x.fillRect(0, 0, w, h);
  x.strokeStyle = fg; x.lineWidth = 6; x.strokeRect(6, 6, w - 12, h - 12);
  x.fillStyle = fg; x.textAlign = 'center'; x.textBaseline = 'middle'; x.font = font;
  if (sub) { x.fillText(text, w / 2, h * 0.38); x.font = '600 28px Segoe UI, system-ui, sans-serif'; x.fillText(sub, w / 2, h * 0.78); }
  else x.fillText(text, w / 2, h / 2);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

// ----------------------------------------------------------------------------------------------- 2-D polygon utils
/** signed area (x, z) — positive when the ring is counter-clockwise in the x-east / z-south frame as seen from above */
export function ringArea(pts) { let a = 0; for (let i = 0, n = pts.length; i < n; i++) { const p = pts[i], q = pts[(i + 1) % n]; a += p.x * q.z - q.x * p.z; } return a / 2; }
/** drops consecutive duplicates (< 0.3 m apart), the repeated closing point and rings with < 3 points or ~zero area → null */
export function cleanRing(pts, minArea = 4) {
  if (!Array.isArray(pts) || pts.length < 3) return null;
  const out = [];
  for (const p of pts) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
    const l = out[out.length - 1];
    if (l && Math.hypot(l.x - p.x, l.z - p.z) < 0.3) continue;
    out.push({ x: p.x, z: p.z });
  }
  while (out.length > 1 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].z - out[out.length - 1].z) < 0.3) out.pop();
  if (out.length < 3 || Math.abs(ringArea(out)) < minArea) return null;
  return out;
}
export function pointInRing(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}
export function ringCentroid(ring) { let x = 0, z = 0; for (const p of ring) { x += p.x; z += p.z; } return { x: x / ring.length, z: z / ring.length }; }
export function ringBBox(ring) { let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity; for (const p of ring) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); } return { x0, x1, z0, z1 }; }

/** Extrude a ring (x, z metres) into a solid from y0 to y1 with a flat top. Geometry has identity transform in group space.
 *  Material groups: 0 = top/bottom caps, 1 = side walls. Returns null when the ring cannot be triangulated. */
export function extrudeRing(ring, y0, y1, { jitter = 0 } = {}) {
  const shape = new THREE.Shape();
  // Shape lives in XY; after rotateX(-90°) shape Y maps to -Z, so feed -z as the shape's y.
  shape.moveTo(ring[0].x, -ring[0].z);
  for (let i = 1; i < ring.length; i++) shape.lineTo(ring[i].x, -ring[i].z);
  shape.closePath();
  let geo;
  try { geo = new THREE.ExtrudeGeometry(shape, { depth: y1 - y0, bevelEnabled: false, steps: 1 }); } catch { return null; }
  if (!geo.attributes.position || geo.attributes.position.count < 3) { geo.dispose(); return null; }
  geo.rotateX(-Math.PI / 2); geo.translate(0, y0, 0);
  if (jitter > 0) {
    const p = geo.attributes.position; const r = rng(ring.length * 7919 + 17);
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      p.setXYZ(i, p.getX(i) + (r() - 0.5) * jitter, y > y0 + 0.01 ? y + (r() - 0.5) * jitter * 0.6 : y, p.getZ(i) + (r() - 0.5) * jitter);
    }
    geo.computeVertexNormals();
  }
  return geo;
}

/** Split a non-indexed geometry with material groups into one geometry per group (so each can go into its own merge bucket). */
export function splitGroups(geo) {
  const out = [];
  const src = geo.index ? geo.toNonIndexed() : geo;
  const groups = src.groups && src.groups.length ? src.groups : [{ start: 0, count: src.attributes.position.count, materialIndex: 0 }];
  for (const gr of groups) {
    const g = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'uv']) {
      const a = src.attributes[name]; if (!a) continue;
      const n = a.itemSize;
      g.setAttribute(name, new THREE.BufferAttribute(a.array.slice(gr.start * n, (gr.start + gr.count) * n), n));
    }
    out[gr.materialIndex] = out[gr.materialIndex] ? mergeGeometries([out[gr.materialIndex], g]) : g;
  }
  if (src !== geo) src.dispose();
  geo.dispose();
  return out;
}
