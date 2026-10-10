// Interiors v2 — the renderer (docs/INTERIORS-V2-CONTRACT.md §5–6, Lane R).
//
// buildInteriorV2(I, plan, root, { phone }) draws a Plan v2 into `root` and returns the zone groups interior.js streams
// (same contract as gaprops.js buildZoned: Map zoneId → Group). Everything is merged per zone into at most five
// materials sharing one procedural atlas (iv2atlas.js): opaque, metal, emissive (screens, diffusers, exit signs), glass
// and cutout (gratings). Light is baked per vertex (iv2light.js: practical / daylight / emergency / night) and mixed in
// the shader by mode uniforms. Each zone = a shell (rooms, stairs, decks, the machinery and gear of the v1 props) plus
// detail chunks (the kit items and runs; one per house tier / ER level / deck area) in two levels of detail; I.v2.frame()
// picks hi / lo per chunk around the walker (phones: the walker's chunk and its neighbour; desktop: within 15 m), shows the
// shells of the zones a room's windows look onto, animates door leaves (instanced), wipers and the light mode.
import * as THREE from 'three';
import { ITEMS } from './iv2items.js';
import { TILES, tileOf, tileRect, atlasCanvas } from './iv2atlas.js';
import { bakeLight, lightTables, lightMode } from './iv2light.js';
import { SYS_COLOR } from '../../shared/ships/gamach.js';
import { stairEnds } from './walker.js';

const r2 = (v) => Math.round(v * 100) / 100;
const KINDS = ['opaque', 'metal', 'emissive', 'cutout'];
const SYS_TILE = { fuel: 'paint_brown', lo: 'paint_yellow', fw: 'paint_blue', sw: 'paint_green', fire: 'paint_red', steam: 'metal_brushed', air: 'paint_lightblue', bilge: 'rubber_black', ballast: 'paint_green', gs: 'paint_green', elec: 'paint_grey', cargo: 'paint_brown' };

// ------------------------------------------------------------------------------------------------ geometry builder
/** Accumulates triangles per material kind with world-scaled UVs, the tile rect, and the room of every vertex. */
export class Geo {
  constructor(size = 1024) { this.size = size; this.buf = {}; for (const k of KINDS) this.buf[k] = { p: [], n: [], uv: [], t: [], room: [], i: [] }; this.room = -1; this.tris = 0; this.rect = new Map(); }
  tile(id) { const i = typeof id === 'number' ? id : tileOf(id); let r = this.rect.get(i); if (!r) { r = tileRect(i, this.size); this.rect.set(i, r); } return { i, r, kind: TILES[i].kind, scale: TILES[i].scale }; }
  /** Append a quad (4 corners, CCW seen from the front) with UVs in metres / tile scale. */
  quad(tileId, a, b, c, d, nrm, ua, va, ub, vb) {
    const t = this.tile(tileId), B = this.buf[t.kind], base = B.p.length / 3;
    for (const q of [a, b, c, d]) B.p.push(q[0], q[1], q[2]);
    for (let k = 0; k < 4; k++) { B.n.push(nrm[0], nrm[1], nrm[2]); B.t.push(t.r[0], t.r[1], t.r[2], t.r[3]); B.room.push(this.room); }
    const s = t.scale;
    B.uv.push(ua / s, va / s, ub / s, va / s, ub / s, vb / s, ua / s, vb / s);
    B.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
    this.tris += 2;
  }
  /** Raw triangles from a three.js BufferGeometry (already in world space) with one tile; UVs from the world xz/xy. */
  geometry(g, tileId) {
    const t = this.tile(tileId), B = this.buf[t.kind], base = B.p.length / 3;
    const pos = g.attributes.position, nrm = g.attributes.normal, n = pos.count;
    for (let k = 0; k < n; k++) {
      const x = pos.getX(k), y = pos.getY(k), z = pos.getZ(k), nx = nrm ? nrm.getX(k) : 0, ny = nrm ? nrm.getY(k) : 1, nz = nrm ? nrm.getZ(k) : 0;
      B.p.push(x, y, z); B.n.push(nx, ny, nz); B.t.push(t.r[0], t.r[1], t.r[2], t.r[3]); B.room.push(this.room);
      const ax = Math.abs(nx), ay = Math.abs(ny);
      const u = ay > 0.6 ? x : ax > 0.6 ? z : x, v = ay > 0.6 ? z : y;
      B.uv.push(u / t.scale, v / t.scale);
    }
    if (g.index) for (let k = 0; k < g.index.count; k++) B.i.push(base + g.index.getX(k)); else for (let k = 0; k < n; k++) B.i.push(base + k);
    this.tris += (g.index ? g.index.count : n) / 3;
  }
  /** Meshes for the accumulated buffers: opaque, metal and emissive surfaces share one mesh (per-vertex aKind 0 / 1 / 2,
   *  one draw call), cut-outs their own; bakes the light first. */
  build(mats, bake) {
    const out = [];
    const groupsK = [['solid', ['opaque', 'metal', 'emissive']], ['cutout', ['cutout']]];
    for (const [name, ks] of groupsK) {
      const parts = ks.map((k, ki) => [this.buf[k], ki]).filter(([B]) => B.i.length);
      if (!parts.length) continue;
      let nv = 0, ni = 0; for (const [B] of parts) { nv += B.p.length / 3; ni += B.i.length; }
      const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), tl = new Float32Array(nv * 4), kind = new Float32Array(nv), room = new Int32Array(nv);
      const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
      let ov = 0, oi = 0;
      for (const [B, ki] of parts) {
        const n = B.p.length / 3;
        pos.set(B.p, ov * 3); nrm.set(B.n, ov * 3); uv.set(B.uv, ov * 2); tl.set(B.t, ov * 4); room.set(B.room, ov);
        kind.fill(name === 'solid' ? ki : 0, ov, ov + n);
        for (let k = 0; k < B.i.length; k++) idx[oi + k] = B.i[k] + ov;
        ov += n; oi += B.i.length;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      g.setAttribute('aTile', new THREE.BufferAttribute(tl, 4));
      g.setAttribute('aKind', new THREE.BufferAttribute(kind, 1));
      const light = bake ? bake(pos, nrm, room) : new Float32Array(nv * 4).fill(0.6);
      g.setAttribute('aLight', new THREE.BufferAttribute(light, 4));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, mats[name]); m.name = `iv2:${name}`; m.frustumCulled = true; m.userData.tris = ni / 3;
      out.push(m);
    }
    return out;
  }
}

// ------------------------------------------------------------------------------------------------ primitives (item frame)
// A frame F = { x, y, z, c, s } (rotation about y: c = cos, s = sin); local (lx, ly, lz) → world.
const frameOf = (x, y, z, rot = 0) => ({ x, y, z, c: Math.cos(rot), s: Math.sin(rot) });
const W = (F, lx, ly, lz) => [F.x + lx * F.c + lz * F.s, F.y + ly, F.z - lx * F.s + lz * F.c];
const WN = (F, nx, ny, nz) => [nx * F.c + nz * F.s, ny, -nx * F.s + nz * F.c];
/** Axis-aligned box in the frame: centre (cx, cy, cz), size (w, h, d); tile per face or one; tilt (rx) about local x. */
function box(G, F, tile, cx, cy, cz, w, h, d, o = {}) {
  const hw = w / 2, hh = h / 2, hd = d / 2, rx = o.rx || 0, cr = Math.cos(rx), sr = Math.sin(rx);
  const P = (x, y, z) => { const yy = y * cr - z * sr, zz = y * sr + z * cr; return W(F, cx + x, cy + yy, cz + zz); };
  const N = (x, y, z) => { const yy = y * cr - z * sr, zz = y * sr + z * cr; return WN(F, x, yy, zz); };
  const tf = (k) => (typeof tile === 'object' ? tile[k] ?? tile.all : tile);
  const faces = o.faces || 'tbnsew';
  // +y top, -y bottom, +z front (s), -z back (n), +x e, -x w
  if (faces.includes('t')) G.quad(tf('t'), P(-hw, hh, hd), P(hw, hh, hd), P(hw, hh, -hd), P(-hw, hh, -hd), N(0, 1, 0), cx - hw, cz + hd, cx + hw, cz - hd);
  if (faces.includes('b') && !o.noBottom) G.quad(tf('b'), P(-hw, -hh, -hd), P(hw, -hh, -hd), P(hw, -hh, hd), P(-hw, -hh, hd), N(0, -1, 0), 0, 0, w, d);
  if (faces.includes('s')) G.quad(tf('f'), P(-hw, -hh, hd), P(hw, -hh, hd), P(hw, hh, hd), P(-hw, hh, hd), N(0, 0, 1), 0, 0, w, h);
  if (faces.includes('n')) G.quad(tf('k'), P(hw, -hh, -hd), P(-hw, -hh, -hd), P(-hw, hh, -hd), P(hw, hh, -hd), N(0, 0, -1), 0, 0, w, h);
  if (faces.includes('e')) G.quad(tf('s'), P(hw, -hh, hd), P(hw, -hh, -hd), P(hw, hh, -hd), P(hw, hh, hd), N(1, 0, 0), 0, 0, d, h);
  if (faces.includes('w')) G.quad(tf('s'), P(-hw, -hh, -hd), P(-hw, -hh, hd), P(-hw, hh, hd), P(-hw, hh, -hd), N(-1, 0, 0), 0, 0, d, h);
}
/** A cylinder along local y (or x / z with axis), radius r, height h, seg sides; caps optional. */
function cyl(G, F, tile, cx, cy, cz, r, h, seg = 8, o = {}) {
  if (G.segCap && seg > G.segCap) seg = G.segCap;   // phones: coarser round parts
  const axis = o.axis || 'y', rt = o.rt ?? r;
  const P = (a, t, rad) => { const ca = Math.cos(a) * rad, sa = Math.sin(a) * rad; const L = axis === 'y' ? [cx + ca, cy + t, cz + sa] : axis === 'x' ? [cx + t, cy + ca, cz + sa] : [cx + ca, cy + sa, cz + t]; return W(F, L[0], L[1], L[2]); };
  const N = (a) => { const ca = Math.cos(a), sa = Math.sin(a); const L = axis === 'y' ? [ca, 0, sa] : axis === 'x' ? [0, ca, sa] : [ca, sa, 0]; return WN(F, L[0], L[1], L[2]); };
  const circ = 2 * Math.PI * Math.max(r, rt), flip = axis !== 'y';
  const Q = (t, a, b, c, d, n, ...uv) => (flip ? G.quad(t, b, a, d, c, n, ...uv) : G.quad(t, a, b, c, d, n, ...uv));
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2, am = (a0 + a1) / 2;
    Q(tile, P(a1, -h / 2, r), P(a0, -h / 2, r), P(a0, h / 2, rt), P(a1, h / 2, rt), N(am), (circ * (i + 1)) / seg, 0, (circ * i) / seg, h);
  }
  if (o.caps !== false) {
    const top = P(0, h / 2, 0), bot = P(0, -h / 2, 0), nT = axis === 'y' ? [0, 1, 0] : axis === 'x' ? [1, 0, 0] : [0, 0, 1];
    const nTw = WN(F, ...nT), nBw = WN(F, -nT[0], -nT[1], -nT[2]);
    for (let i = 0; i < seg; i += 2) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2, a2 = ((i + 2) / seg) * Math.PI * 2;
      Q(o.capTile || tile, top, P(a2, h / 2, rt), P(a1, h / 2, rt), P(a0, h / 2, rt), nTw, 0, 0, rt, rt);
      if (!o.noBottom) Q(o.capTile || tile, bot, P(a0, -h / 2, r), P(a1, -h / 2, r), P(a2, -h / 2, r), nBw, 0, 0, r, r);
    }
  }
}
/** A rod (cylinder) between two world points. */
function rod(G, tile, a, b, r, seg = 6) {
  if (G.segCap && seg > G.segCap) seg = Math.max(4, G.segCap - 2);
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], len = Math.hypot(dx, dy, dz); if (len < 1e-3) return;
  const d = [dx / len, dy / len, dz / len];
  const up = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm(cross(d, up)), v = cross(u, d);
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const off = (ang) => [u[0] * Math.cos(ang) * r + v[0] * Math.sin(ang) * r, u[1] * Math.cos(ang) * r + v[1] * Math.sin(ang) * r, u[2] * Math.cos(ang) * r + v[2] * Math.sin(ang) * r];
    const o0 = off(a0), o1 = off(a1), nm = norm(off((a0 + a1) / 2));
    G.quad(tile, [a[0] + o1[0], a[1] + o1[1], a[2] + o1[2]], [a[0] + o0[0], a[1] + o0[1], a[2] + o0[2]], [b[0] + o0[0], b[1] + o0[1], b[2] + o0[2]], [b[0] + o1[0], b[1] + o1[1], b[2] + o1[2]], nm, 0, 0, r * 6, len);
  }
}
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// ------------------------------------------------------------------------------------------------ item factories
// f(G, F, it, p, lod) draws one item in its frame: local x along the wall (width w), y up, z out of the wall (depth d,
// front at +d/2). lod 1 = a single box (shell / far chunks).
const FAC = {};
const T0 = (it, k, def) => (it.tiles && it.tiles[k]) || def;
FAC.cabinet = (G, F, it, p) => { const { w, d, h } = p; box(G, F, T0(it, 0, 'wood_furn'), 0, h / 2, 0, w, h, d, { noBottom: true }); box(G, F, 'rubber_black', 0, h / 2, d / 2 + 0.005, 0.01, h - 0.1, 0.01, { faces: 'ts' }); for (const sx of [-0.06, 0.06]) box(G, F, 'metal_brushed', sx, h * 0.55, d / 2 + 0.02, 0.02, 0.18, 0.03, { faces: 'tse' }); };
FAC.locker = (G, F, it, p) => { const { w, d, h } = p; box(G, F, T0(it, 0, 'paint_grey'), 0, h / 2, 0, w, h, d, { noBottom: true }); const n = Math.max(1, Math.round(w / 0.4)); for (let i = 1; i < n; i++) box(G, F, 'rubber_black', -w / 2 + (w * i) / n, h / 2, d / 2 + 0.004, 0.012, h - 0.06, 0.01, { faces: 's' }); for (let i = 0; i < n; i++) box(G, F, 'metal_brushed', -w / 2 + (w * (i + 0.8)) / n, h * 0.55, d / 2 + 0.015, 0.02, 0.12, 0.02, { faces: 'ts' }); };
FAC.drawers = (G, F, it, p) => { const { w, d, h } = p; box(G, F, T0(it, 0, 'wood_furn'), 0, h / 2, 0, w, h, d, { noBottom: true }); const n = Math.max(2, Math.round(h / 0.25)); for (let i = 1; i < n; i++) box(G, F, 'rubber_black', 0, (h * i) / n, d / 2 + 0.004, w - 0.04, 0.012, 0.01, { faces: 's' }); for (let i = 0; i < n; i++) box(G, F, 'metal_brushed', 0, (h * (i + 0.5)) / n, d / 2 + 0.015, 0.16, 0.02, 0.02, { faces: 'ts' }); };
FAC.shelves = (G, F, it, p, lod) => { const { w, d, h } = p; const fr = T0(it, 0, 'metal_brushed'); for (const sx of [-w / 2 + 0.03, w / 2 - 0.03]) box(G, F, fr, sx, h / 2, 0, 0.04, h, d, { noBottom: true }); const n = Math.max(3, Math.round(h / 0.45)); for (let i = 0; i < n; i++) { const y = 0.08 + (i * (h - 0.12)) / (n - 1); box(G, F, fr, 0, y, 0, w - 0.06, 0.03, d, { faces: 'tbs' }); if (i < n - 1 && lod === 0) { box(G, F, T0(it, 1, 'cardboard'), -w * 0.18, y + 0.15, 0, w * 0.55, 0.27, d * 0.8, { faces: 'tse' }); box(G, F, T0(it, 2, 'cardboard'), w * 0.3, y + 0.11, 0.02, w * 0.3, 0.2, d * 0.7, { faces: 'tsw' }); } } };
FAC.bookshelf = (G, F, it, p) => { const { w, d, h } = p; box(G, F, 'wood_furn', 0, h / 2, -0.01, w, h, d - 0.02, { faces: 'tnwe' }); box(G, F, 'books', 0, h / 2, d / 2 - 0.12, w - 0.06, h - 0.1, 0.2, { faces: 's' }); for (const sx of [-w / 2 + 0.02, w / 2 - 0.02]) box(G, F, 'wood_furn', sx, h / 2, 0.02, 0.03, h, d, { faces: 'se' }); };
FAC.bunk = (G, F, it, p, lod, tiers = 1) => {
  const { w, d } = p;
  for (let t = 0; t < tiers; t++) {
    const y0 = t * 1.0;
    box(G, F, 'wood_furn', 0, y0 + 0.2, 0, w, 0.4, d, { noBottom: true });                                           // drawer base
    if (lod === 0) for (let i = 0; i < 2; i++) box(G, F, 'rubber_black', -w / 4 + (i * w) / 2, y0 + 0.2, d / 2 + 0.004, w / 2 - 0.1, 0.012, 0.01, { faces: 's' });
    box(G, F, 'bedding', 0, y0 + 0.5, -0.02, w - 0.06, 0.2, d - 0.12, { faces: 'tsew' });                         // mattress + blanket
    box(G, F, 'fabric_grey', -w / 2 + 0.28, y0 + 0.64, -0.05, 0.4, 0.1, d - 0.3, { faces: 'tsew' });                // pillow
    box(G, F, 'wood_furn', 0, y0 + 0.62, d / 2 - 0.02, w - 0.2, 0.12, 0.03, { faces: 'tsn' });                      // lee board
    if (lod === 0) box(G, F, 'light', w / 2 - 0.25, y0 + 0.95, -d / 2 + 0.06, 0.18, 0.06, 0.06, { faces: 'ts' });   // reading light
  }
  if (tiers > 1) for (const sx of [-w / 2 + 0.03, w / 2 - 0.03]) box(G, F, 'wood_furn', sx, 1.0, d / 2 - 0.03, 0.05, 2.0, 0.05, { faces: 'sew' });
};
FAC.bunk2 = (G, F, it, p, lod) => FAC.bunk(G, F, it, p, lod, 2);
FAC.bed = (G, F, it, p, lod) => { const { w, d } = p; box(G, F, T0(it, 0, 'wood_furn'), 0, 0.18, 0, w, 0.36, d, { noBottom: true }); box(G, F, 'bedding', 0, 0.45, 0.05, w - 0.06, 0.18, d - 0.12, { faces: 'tsew' }); for (const sx of [-0.4, 0.4]) box(G, F, 'fabric_grey', sx * (d / 1.6), 0.58, -d / 2 + 0.3, Math.min(0.6, d * 0.35), 0.1, 0.32, { faces: 'tsew' }); box(G, F, T0(it, 0, 'wood_furn'), 0, 0.55, -d / 2 + 0.03, w, 1.1, 0.06, { faces: 'tsew' }); void lod; };
FAC.hospital_bed = (G, F, it, p) => { const { w, d } = p; box(G, F, 'metal_brushed', 0, 0.35, 0, w, 0.08, d, { faces: 'tsew' }); box(G, F, 'bedding', 0, 0.48, 0, w - 0.08, 0.16, d - 0.06, { faces: 'tsew' }); for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) box(G, F, 'metal_brushed', sx * (w / 2 - 0.05), 0.16, sz * (d / 2 - 0.05), 0.04, 0.32, 0.04, { faces: 'sewn' }); box(G, F, 'metal_brushed', -w / 2 + 0.02, 0.7, 0, 0.04, 0.5, d, { faces: 'sew' }); };
FAC.sofa = (G, F, it, p) => { const { w, d } = p; const t = T0(it, 0, 'fabric_blue'); box(G, F, t, 0, 0.22, 0.02, w, 0.44, d - 0.04, { noBottom: true }); box(G, F, t, 0, 0.6, -d / 2 + 0.1, w, 0.5, 0.2, { faces: 'tsew' }); for (const sx of [-w / 2 + 0.08, w / 2 - 0.08]) box(G, F, t, sx, 0.55, 0, 0.16, 0.25, d, { faces: 'tsew' }); };
FAC.sofa_L = (G, F, it, p) => { const { w, d } = p; const t = T0(it, 0, 'fabric_grey'); box(G, F, t, 0, 0.22, -d / 2 + 0.38, w, 0.44, 0.75, { noBottom: true }); box(G, F, t, -w / 2 + 0.38, 0.22, 0.2, 0.75, 0.44, d - 0.4, { noBottom: true }); box(G, F, t, 0, 0.62, -d / 2 + 0.08, w, 0.5, 0.16, { faces: 'tsew' }); box(G, F, t, -w / 2 + 0.08, 0.62, 0.1, 0.16, 0.5, d - 0.2, { faces: 'tsew' }); };
FAC.armchair = (G, F, it, p) => { const { w, d } = p; const t = T0(it, 0, 'fabric_red'); box(G, F, t, 0, 0.22, 0.03, w, 0.44, d - 0.06, { noBottom: true }); box(G, F, t, 0, 0.62, -d / 2 + 0.1, w, 0.5, 0.18, { faces: 'tsew' }); for (const sx of [-w / 2 + 0.07, w / 2 - 0.07]) box(G, F, t, sx, 0.55, 0.02, 0.14, 0.22, d - 0.1, { faces: 'tsew' }); };
FAC.chair = (G, F, it, p, lod) => { const t = T0(it, 1, 'fabric_blue'); box(G, F, t, 0, 0.46, 0.02, 0.44, 0.06, 0.42, { faces: 'tsew' }); box(G, F, t, 0, 0.75, -0.2, 0.42, 0.42, 0.05, { faces: 'tsn' }); if (lod === 0) for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) box(G, F, 'metal_brushed', sx * 0.19, 0.22, sz * 0.18, 0.03, 0.44, 0.03, { faces: 'sewn' }); };
FAC.office_chair = (G, F, it, p, lod) => { box(G, F, 'fabric_grey', 0, 0.48, 0.02, 0.5, 0.08, 0.48, { faces: 'tsew' }); box(G, F, 'fabric_grey', 0, 0.82, -0.22, 0.46, 0.55, 0.07, { faces: 'tsnew' }); if (lod === 0) { cyl(G, F, 'rubber_black', 0, 0.24, 0, 0.03, 0.44, 6, { caps: false }); box(G, F, 'rubber_black', 0, 0.04, 0, 0.56, 0.04, 0.06, { faces: 'tsew' }); box(G, F, 'rubber_black', 0, 0.04, 0, 0.06, 0.04, 0.56, { faces: 'tsew' }); } };
FAC.stool = (G, F, it, p) => { cyl(G, F, 'leather', 0, 0.72, 0, 0.18, 0.06, 8); cyl(G, F, 'metal_brushed', 0, 0.36, 0, 0.03, 0.7, 6, { caps: false }); };
FAC.pilot_chair = (G, F, it, p, lod) => { cyl(G, F, 'metal_brushed', 0, 0.3, 0, 0.08, 0.6, 8, { caps: false }); box(G, F, 'leather', 0, 0.68, 0.02, 0.62, 0.14, 0.58, { faces: 'tsew' }); box(G, F, 'leather', 0, 1.08, -0.26, 0.6, 0.72, 0.12, { faces: 'tsnew' }); for (const sx of [-0.34, 0.34]) { box(G, F, 'rubber_black', sx, 0.9, 0.04, 0.1, 0.08, 0.5, { faces: 'tsew' }); if (lod === 0) box(G, F, 'console', sx, 0.98, 0.22, 0.12, 0.1, 0.14, { faces: 'tse' }); } box(G, F, 'rubber_black', 0, 0.04, 0, 0.6, 0.06, 0.6, { faces: 'tsew' }); };
FAC.bench = (G, F, it, p) => { const { w, d } = p; box(G, F, T0(it, 0, 'fabric_red'), 0, 0.43, 0, w, 0.08, d, { faces: 'tsew' }); box(G, F, 'metal_brushed', 0, 0.2, 0, w - 0.2, 0.4, 0.06, { faces: 'sn' }); };
FAC.recliner = (G, F, it, p) => { const { w, d } = p; const t = T0(it, 0, 'fabric_blue'); box(G, F, t, 0, 0.42, 0.05, w - 0.06, 0.12, d * 0.55, { faces: 'tsew' }); box(G, F, t, 0, 0.75, -d * 0.25, w - 0.06, 0.7, 0.12, { faces: 'tsnew', rx: -0.25 }); box(G, F, 'rubber_black', 0, 0.18, 0, w * 0.4, 0.36, d * 0.3, { faces: 'sew' }); };
FAC.lounger = (G, F, it, p) => { const { w, d } = p; box(G, F, T0(it, 1, 'fabric_blue'), 0, 0.33, 0.15, w, 0.08, d * 0.75, { faces: 'tsew' }); box(G, F, T0(it, 1, 'fabric_blue'), 0, 0.5, -d / 2 + 0.25, w, 0.08, 0.5, { faces: 'tsew', rx: -0.6 }); box(G, F, 'paint_white', 0, 0.15, 0, w - 0.1, 0.3, d - 0.2, { faces: 'ew' }); };
FAC.desk = (G, F, it, p, lod) => {
  const { w, d } = p, top = T0(it, 0, 'wood_furn');
  box(G, F, top, 0, 0.74, 0, w, 0.04, d, { faces: 'tbsew' });
  box(G, F, top, w / 2 - 0.22, 0.36, 0, 0.4, 0.72, d - 0.04, { noBottom: true });                                   // drawer pedestal
  box(G, F, top, -w / 2 + 0.03, 0.36, 0, 0.04, 0.72, d - 0.04, { faces: 'sew' });
  box(G, F, top, 0, 0.45, -d / 2 + 0.03, w - 0.1, 0.5, 0.02, { faces: 's' });
  if (lod === 0) {
    box(G, F, 'rubber_black', -0.15, 0.95, -d / 2 + 0.12, 0.5, 0.32, 0.03, { faces: 'n' }); box(G, F, T0(it, 1, 'screen_ecdis'), -0.15, 0.95, -d / 2 + 0.135, 0.46, 0.28, 0.01, { faces: 's' });
    box(G, F, 'rubber_black', -0.15, 0.8, -d / 2 + 0.12, 0.06, 0.1, 0.04, { faces: 'sew' });
    box(G, F, 'rubber_black', -0.15, 0.765, 0.02, 0.42, 0.015, 0.14, { faces: 't' });                               // keyboard
    box(G, F, 'paint_white', w / 2 - 0.2, 0.79, -0.05, 0.22, 0.06, 0.3, { faces: 'tsew' });                           // papers
    cyl(G, F, 'metal_brushed', -w / 2 + 0.15, 0.95, -d / 2 + 0.15, 0.015, 0.4, 5, { caps: false }); box(G, F, 'light', -w / 2 + 0.22, 1.14, -d / 2 + 0.2, 0.16, 0.05, 0.1, { faces: 'tbs' });  // lamp
  }
};
FAC.table = (G, F, it, p, lod) => {
  const { w, h } = p, d = p.tableD ?? p.d, top = T0(it, 0, 'wood_furn');
  box(G, F, top, 0, h - 0.025, 0, w, 0.05, d, { faces: 'tbsewn' });
  if (lod === 0) box(G, F, top, 0, h - 0.05, d / 2 - 0.01, w, 0.04, 0.02, { faces: 'ts' });   // fiddle rail
  cyl(G, F, T0(it, 1, 'metal_brushed'), 0, (h - 0.05) / 2, 0, 0.05, h - 0.05, 6, { caps: false });
  box(G, F, T0(it, 1, 'metal_brushed'), 0, 0.02, 0, Math.min(0.6, w * 0.5), 0.04, Math.min(0.6, d * 0.7), { faces: 'tsew' });
  if (p.benches) for (const sz of [-1, 1]) { const bz = sz * (d / 2 + 0.08 + 0.225); box(G, F, 'fabric_red', 0, 0.43, bz, w - 0.1, 0.08, 0.45, { faces: 'tsew' }); box(G, F, 'fabric_red', 0, 0.72, bz + sz * 0.2, w - 0.1, 0.5, 0.06, { faces: 'tsewn' }); box(G, F, 'metal_brushed', 0, 0.2, bz, w - 0.3, 0.4, 0.05, { faces: 'sn' }); }
  if (lod === 0 && p.benches) { box(G, F, 'metal_brushed', 0, h + 0.06, 0, 0.25, 0.12, 0.12, { faces: 'tsewn' }); }   // condiment rack
};
FAC.table_round = (G, F, it, p) => { const { w, h } = p; cyl(G, F, T0(it, 0, 'wood_furn'), 0, h - 0.025, 0, w / 2, 0.05, 12); cyl(G, F, T0(it, 1, 'metal_brushed'), 0, (h - 0.05) / 2, 0, 0.05, h - 0.05, 6, { caps: false }); cyl(G, F, T0(it, 1, 'metal_brushed'), 0, 0.02, 0, w * 0.25, 0.04, 8); };
FAC.chart_table = (G, F, it, p, lod) => { const { w, d, h } = p; box(G, F, 'wood_furn', 0, h / 2 - 0.03, 0, w, h - 0.06, d, { noBottom: true }); box(G, F, 'chart', 0, h - 0.02, 0, w - 0.08, 0.04, d - 0.08, { faces: 't', rx: 0.0 }); for (let i = 1; i < 5; i++) box(G, F, 'rubber_black', 0, (h * i) / 5.5, d / 2 + 0.004, w - 0.1, 0.012, 0.01, { faces: 's' }); if (lod === 0) { cyl(G, F, 'metal_brushed', w / 2 - 0.12, h + 0.2, -d / 2 + 0.1, 0.012, 0.4, 5, { caps: false }); box(G, F, 'light', w / 2 - 0.2, h + 0.4, -d / 2 + 0.2, 0.2, 0.05, 0.12, { faces: 'tbs' }); box(G, F, 'rubber_black', 0, h + 0.4, -d / 2 + 0.03, w, 0.6, 0.04, { faces: 's' }); } };
FAC.workbench = (G, F, it, p, lod) => { const { w, d, h } = p; box(G, F, T0(it, 0, 'wood_furn'), 0, h - 0.03, 0, w, 0.06, d, { faces: 'tbsew' }); box(G, F, T0(it, 1, 'paint_er'), 0, (h - 0.06) / 2, -0.05, w - 0.1, h - 0.06, d - 0.15, { noBottom: true }); box(G, F, T0(it, 2, 'toolboard'), 0, h + 0.45, -d / 2 + 0.02, w, 0.8, 0.03, { faces: 's' }); if (lod === 0) { box(G, F, 'paint_blue', -w / 2 + 0.3, h + 0.08, 0.1, 0.2, 0.12, 0.25, { faces: 'tsew' }); box(G, F, 'metal_brushed', -w / 2 + 0.3, h + 0.16, 0.25, 0.25, 0.04, 0.05, { faces: 'tse' }); } };
FAC.counter = (G, F, it, p, lod) => { const { w, d, h } = p; box(G, F, T0(it, 0, 'stainless'), 0, h / 2, 0, w, h, d, { noBottom: true }); if (lod === 0) { box(G, F, 'rubber_black', 0, h * 0.55, d / 2 + 0.004, 0.01, h - 0.15, 0.01, { faces: 's' }); box(G, F, T0(it, 0, 'stainless'), 0, h + 0.02, d / 2 - 0.03, w, 0.04, 0.02, { faces: 'ts' }); box(G, F, 'metal_brushed', 0, h * 0.85, d / 2 + 0.02, w * 0.6, 0.02, 0.02, { faces: 'ts' }); } };
FAC.hatch_counter = (G, F, it, p) => { const { w, d, h } = p; box(G, F, 'stainless', 0, h / 2, 0, w, h, d, { noBottom: true }); box(G, F, 'stainless', 0, h + 0.5, 0, w, 0.04, d, { faces: 'tb' }); };
FAC.range = (G, F, it, p, lod) => { const { w, d, h } = p; box(G, F, 'stainless', 0, h / 2, 0, w, h, d, { noBottom: true }); box(G, F, 'rubber_black', 0, h + 0.005, 0, w - 0.08, 0.01, d - 0.1, { faces: 't' }); if (lod === 0) { for (let i = 0; i < 4; i++) cyl(G, F, 'rubber_black', -w / 2 + 0.25 + (i % 2) * 0.4 + Math.floor(i / 2) * (w - 0.9), h + 0.015, -0.12 + (i % 2) * 0.24, 0.1, 0.02, 8); box(G, F, 'rubber_black', 0, h * 0.45, d / 2 + 0.005, w * 0.8, h * 0.55, 0.01, { faces: 's' }); box(G, F, 'metal_brushed', 0, h + 0.06, d / 2 - 0.02, w, 0.03, 0.03, { faces: 'ts' }); } box(G, F, 'stainless', 0, 1.95, -0.05, w + 0.2, 0.35, d + 0.1, { faces: 'bsew', rx: 0 }); };
FAC.oven = (G, F, it, p, lod) => { const { w, d, h } = p; box(G, F, 'stainless', 0, h / 2, 0, w, h, d, { noBottom: true }); if (lod === 0) { box(G, F, 'screen_off', -0.05, h * 0.55, d / 2 + 0.005, w * 0.6, h * 0.45, 0.01, { faces: 's' }); box(G, F, 'screen_ams', w / 2 - 0.12, h * 0.8, d / 2 + 0.005, 0.12, 0.16, 0.01, { faces: 's' }); } };
FAC.fridge = (G, F, it, p, lod) => { const { w, d, h } = p; box(G, F, 'stainless', 0, h / 2, 0, w, h, d, { noBottom: true }); box(G, F, 'rubber_black', 0, h * 0.62, d / 2 + 0.004, w - 0.02, 0.012, 0.01, { faces: 's' }); if (lod === 0) for (const y of [h * 0.8, h * 0.4]) box(G, F, 'metal_brushed', w / 2 - 0.08, y, d / 2 + 0.03, 0.02, 0.3, 0.03, { faces: 'tse' }); };
FAC.dishwasher = (G, F, it, p) => { const { w, d, h } = p; box(G, F, 'stainless', 0, 0.45, 0, w, 0.9, d, { noBottom: true }); box(G, F, 'stainless', 0, h - 0.25, 0, w, 0.5, d, { faces: 'tbsew' }); for (const sx of [-w / 2 + 0.02, w / 2 - 0.02]) box(G, F, 'stainless', sx, h * 0.5 + 0.2, -d / 2 + 0.04, 0.03, h - 0.5, 0.04, { faces: 'sew' }); };
FAC.sink = (G, F, it, p, lod) => { const { w, d, h } = p; box(G, F, 'stainless', 0, h / 2, 0, w, h, d, { noBottom: true }); if (lod === 0) { for (const sx of [-w / 4, w / 4]) box(G, F, 'rubber_black', sx, h + 0.002, 0.02, w / 2 - 0.12, 0.004, d - 0.2, { faces: 't' }); rod(G, 'metal_brushed', W(F, 0, h, -d / 2 + 0.08), W(F, 0, h + 0.3, -d / 2 + 0.08), 0.015, 5); rod(G, 'metal_brushed', W(F, 0, h + 0.3, -d / 2 + 0.08), W(F, 0, h + 0.3, -0.05), 0.015, 5); } };
FAC.coffee = (G, F, it, p) => { const { w, d, h } = p; box(G, F, 'stainless', 0, h * 0.35, 0, w, h * 0.7, d, { noBottom: true }); box(G, F, 'rubber_black', 0, h * 0.85, -0.05, w, h * 0.3, d - 0.1, { faces: 'tsew' }); };
FAC.coffee_corner = (G, F, it, p, lod) => { FAC.counter(G, F, { tiles: ['laminate_cream'] }, p, lod); if (lod === 0) { box(G, F, 'stainless', -p.w / 2 + 0.25, p.h + 0.2, -0.05, 0.3, 0.4, 0.35, { faces: 'tsew' }); cyl(G, F, 'paint_white', 0.1, p.h + 0.05, 0, 0.04, 0.1, 6); cyl(G, F, 'paint_white', 0.25, p.h + 0.05, 0.05, 0.04, 0.1, 6); box(G, F, 'wood_furn', 0, p.h + 0.75, -p.d / 2 + 0.15, p.w, 0.03, 0.3, { faces: 'tbs' }); } };
FAC.washer = (G, F, it, p, lod) => { const { w, d, h } = p; box(G, F, 'paint_white', 0, h / 2, 0, w, h, d, { noBottom: true }); if (lod === 0) { cyl(G, F, 'metal_brushed', 0, h * 0.45, d / 2 + 0.01, 0.2, 0.03, 10, { axis: 'z' }); cyl(G, F, 'screen_off', 0, h * 0.45, d / 2 + 0.02, 0.15, 0.02, 10, { axis: 'z' }); box(G, F, 'metal_brushed', 0, h - 0.07, d / 2 + 0.005, w - 0.06, 0.1, 0.01, { faces: 's' }); } };
FAC.water_cooler = (G, F, it, p) => { box(G, F, 'paint_white', 0, 0.5, 0, 0.32, 1.0, 0.32, { noBottom: true }); cyl(G, F, 'paint_lightblue', 0, 1.18, 0, 0.13, 0.36, 8); };
FAC.wet_unit = (G, F, it, p, lod) => {
  const { w, d, h } = p;
  // the module: laminate walls, the door on the front face, a dark gap at the top; the ceiling of the module
  box(G, F, 'laminate', 0, h / 2, 0, w, h, d, { faces: 'tsewn' });
  box(G, F, 'laminate_cream', -w / 2 + 0.45, 1.0, d / 2 + 0.006, 0.66, 1.95, 0.012, { faces: 's' });
  box(G, F, 'metal_brushed', -w / 2 + 0.72, 1.0, d / 2 + 0.03, 0.03, 0.14, 0.04, { faces: 'tse' });
  if (lod === 0) box(G, F, 'rubber_black', w / 2 - 0.25, 1.85, d / 2 + 0.006, 0.25, 0.1, 0.01, { faces: 's' });   // vent grille
};
FAC.wc = (G, F, it, p) => { const { w, d, h } = p; box(G, F, 'paint_white', 0, 0.2, 0.05, w * 0.8, 0.4, d * 0.7, { noBottom: true }); box(G, F, 'paint_white', 0, Math.min(h, 0.8) - 0.2, -d / 2 + 0.08, w, 0.4, 0.16, { faces: 'tsew' }); };
FAC.basin = (G, F, it, p) => { const { w, d, h } = p; box(G, F, 'paint_white', 0, h - 0.08, 0, w, 0.16, d, { faces: 'tsewb' }); box(G, F, 'paint_white', 0, (h - 0.16) / 2, -d / 2 + 0.08, 0.14, h - 0.16, 0.12, { faces: 'sew' }); box(G, F, 'glass_tile', 0, h + 0.45, -d / 2 + 0.01, w, 0.6, 0.02, { faces: 's' }); };
FAC.shower = (G, F, it, p) => { const { w, d, h } = p; box(G, F, 'tile_wet', 0, 0.05, 0, w, 0.1, d, { faces: 'tsew' }); box(G, F, 'tile_wet', 0, h / 2, -d / 2 + 0.02, w, h, 0.04, { faces: 's' }); rod(G, 'metal_brushed', W(F, 0, h - 0.1, -d / 2 + 0.05), W(F, 0, h - 0.1, -d / 2 + 0.25), 0.015, 5); };
FAC.console = (G, F, it, p, lod) => {
  const { w, d, h } = p, scr = screenTile(p.screen || it.tiles?.[1]);
  box(G, F, 'console_body', 0, (h - 0.25) / 2, 0.05, w, h - 0.25, d - 0.1, { noBottom: true });
  box(G, F, { all: 'console_body', t: 'console' }, 0, h - 0.18, -0.02, w, 0.08, d - 0.05, { rx: -0.35, faces: 'tbsew' });   // sloped desk top
  box(G, F, 'console_body', 0, h + 0.25, -d / 2 + 0.12, w - 0.02, 0.62, 0.12, { faces: 'tsewn' });                        // screen housing
  box(G, F, 'rubber_black', 0, h - 0.27, d / 2 - 0.04, w, 0.04, 0.03, { faces: 'ts' });                                   // hand rail
  const n = w > 1.5 ? 2 : 1;
  for (let i = 0; i < n; i++) { const sx = -w / 2 + (w * (i + 0.5)) / n; box(G, F, scr, sx, h + 0.27, -d / 2 + 0.185, Math.min(0.62, w / n - 0.1), 0.46, 0.01, { faces: 's' }); }
  if (lod === 0) { box(G, F, 'rubber_black', 0, h - 0.12, 0.18, w * 0.7, 0.03, 0.18, { faces: 't', rx: -0.35 }); box(G, F, 'rubber_black', 0, 0.06, d / 2 - 0.02, w, 0.12, 0.02, { faces: 's' }); }
};
FAC.console_small = (G, F, it, p, lod) => { const { w, d, h } = p; box(G, F, { all: 'console_body', t: 'console' }, 0, h / 2, 0, w, h, d, { noBottom: true }); box(G, F, screenTile('conning'), 0, h + 0.15, -d / 2 + 0.1, w - 0.15, 0.25, 0.02, { faces: 's', rx: -0.3 }); if (lod === 0) { box(G, F, 'rubber_black', -0.15, h + 0.06, 0.1, 0.08, 0.12, 0.08, { faces: 'tsew' }); box(G, F, 'paint_red', 0.15, h + 0.04, 0.1, 0.06, 0.08, 0.06, { faces: 'tsew' }); } };
FAC.steer_stand = (G, F, it, p, lod) => { FAC.console(G, F, it, { ...p, screen: 'conning' }, lod); if (lod === 0) { cyl(G, F, 'rubber_black', 0, p.h - 0.05, 0.3, 0.18, 0.04, 12, { axis: 'z' }); box(G, F, 'paint_red', 0.4, p.h - 0.08, 0.25, 0.06, 0.1, 0.06, { faces: 'tsew' }); } };
FAC.gmdss = (G, F, it, p, lod) => { const { w, d, h } = p; box(G, F, { all: 'console_body', t: 'console' }, 0, 0.4, 0, w, 0.8, d, { noBottom: true }); box(G, F, 'console_body', 0, h - 0.05, -d / 2 + 0.2, w, h - 0.75, 0.4, { faces: 'tsew' }); for (let i = 0; i < 3; i++) box(G, F, ['screen_ecdis', 'screen_ams', 'screen_conning'][i], -w / 2 + 0.25 + i * 0.45, h - 0.05, -d / 2 + 0.405, 0.35, 0.22, 0.01, { faces: 's' }); if (lod === 0) { box(G, F, 'rubber_black', -w / 2 + 0.3, 0.86, 0.15, 0.2, 0.1, 0.12, { faces: 'tsew' }); box(G, F, 'paint_orange', w / 2 - 0.15, h + 0.25, -d / 2 + 0.1, 0.12, 0.3, 0.12, { faces: 'tsew' }); box(G, F, 'paint_white', w / 2 - 0.4, 0.86, 0.1, 0.25, 0.12, 0.2, { faces: 'tsew' }); } };
FAC.overhead_panel = (G, F, it, p, lod) => { const { w, d, h } = p; box(G, F, 'console_body', 0, 0, 0, w, h, d, { faces: 'bsewn', rx: 0.35 }); const n = Math.max(3, Math.round(w / 0.5)); for (let i = 0; i < n; i++) box(G, F, i % 3 === 1 ? 'screen_conning' : 'gauges', -w / 2 + (w * (i + 0.5)) / n, -0.02, d / 2 + 0.01, w / n - 0.08, h - 0.12, 0.01, { faces: 's', rx: 0.35 }); if (lod === 0) { rod(G, 'metal_brushed', W(F, -w / 2 + 0.2, h / 2, 0), W(F, -w / 2 + 0.2, h / 2 + 0.35, 0), 0.02, 5); rod(G, 'metal_brushed', W(F, w / 2 - 0.2, h / 2, 0), W(F, w / 2 - 0.2, h / 2 + 0.35, 0), 0.02, 5); } };
FAC.panel = (G, F, it, p, lod) => { const { w, d, h } = p; const b = T0(it, 0, 'console'); box(G, F, b === 'console' ? 'console_body' : b, 0, h / 2, 0, w, h, d, { noBottom: true }); box(G, F, T0(it, 1, 'gauges'), 0, h * 0.65, d / 2 + 0.005, w - 0.08, Math.min(0.8, h * 0.5), 0.01, { faces: 's' }); if (lod === 0) box(G, F, 'rubber_black', 0, h * 0.25, d / 2 + 0.005, w - 0.1, 0.02, 0.01, { faces: 's' }); };
FAC.panel_small = (G, F, it, p) => { const { w, d, h } = p; box(G, F, { all: 'console_body', f: T0(it, 0, 'console') }, 0, h / 2, 0, w, h, d, { faces: 'tbsew' }); };
FAC.switchboard = (G, F, it, p, lod) => { const { w, d, h } = p; box(G, F, 'paint_grey', 0, h / 2, 0, w, h, d, { noBottom: true }); const n = Math.max(1, Math.round(w / 0.8)); for (let i = 0; i < n; i++) { const sx = -w / 2 + (w * (i + 0.5)) / n; box(G, F, 'gauges', sx, h * 0.72, d / 2 + 0.005, w / n - 0.1, 0.55, 0.01, { faces: 's' }); if (lod === 0) { box(G, F, 'rubber_black', sx, h * 0.38, d / 2 + 0.005, 0.02, h * 0.5, 0.01, { faces: 's' }); box(G, F, 'metal_brushed', sx + 0.15, h * 0.38, d / 2 + 0.02, 0.03, 0.18, 0.03, { faces: 'tse' }); } } };
FAC.machine = (G, F, it, p, lod) => { const { w, d, h } = p; box(G, F, T0(it, 0, 'engine_grey'), 0, h / 2 + 0.05, 0, w, h - 0.1, d, { noBottom: true }); box(G, F, 'paint_grey', 0, 0.05, 0, w + 0.1, 0.1, d + 0.1, { faces: 'tsew' }); if (lod === 0) { box(G, F, 'gauges', w / 4, h * 0.7, d / 2 + 0.005, w * 0.35, 0.3, 0.01, { faces: 's' }); cyl(G, F, T0(it, 1, 'metal_brushed'), -w / 4, h + 0.15, 0, 0.08, 0.3, 6, { caps: false }); } };
FAC.compressor = (G, F, it, p, lod) => { const { w, d, h } = p; box(G, F, 'paint_grey', 0, 0.06, 0, w, 0.12, d, { faces: 'tsew' }); box(G, F, T0(it, 0, 'engine_grey'), -w * 0.18, 0.55, 0, w * 0.55, 0.8, d * 0.75, { faces: 'tsewn' }); cyl(G, F, T0(it, 1, 'paint_blue'), w * 0.3, 0.45, 0, d * 0.3, w * 0.38, 10, { axis: 'x' }); if (lod === 0) cyl(G, F, 'metal_brushed', -w * 0.18, 1.05, 0, 0.12, 0.2, 8); };
FAC.receiver = (G, F, it, p, lod) => { const { w, h } = p; cyl(G, F, T0(it, 0, 'paint_grey'), 0, h / 2 + 0.15, 0, w * 0.45, h - 0.3, lod ? 6 : 10); if (lod === 0) { cyl(G, F, 'metal_brushed', 0, h + 0.05, 0, 0.05, 0.25, 6); cyl(G, F, 'gauges', w * 0.3, h * 0.6, w * 0.3, 0.06, 0.04, 6, { axis: 'z' }); } box(G, F, 'paint_grey', 0, 0.075, 0, w * 0.8, 0.15, w * 0.8, { faces: 'sewn' }); };
FAC.pump_v = (G, F, it, p, lod) => { const { w, h } = p; cyl(G, F, T0(it, 1, 'engine_grey'), 0, 0.25, 0, w * 0.42, 0.5, lod ? 6 : 10); cyl(G, F, 'metal_brushed', 0, 0.62, 0, w * 0.18, 0.24, 6, { caps: false }); cyl(G, F, T0(it, 0, 'paint_blue'), 0, (h + 0.74) / 2, 0, w * 0.32, h - 0.74, lod ? 6 : 10); if (lod === 0) { cyl(G, F, sysTile(p.sys), w * 0.42, 0.25, 0, 0.09, w * 0.5, 6, { axis: 'x' }); cyl(G, F, sysTile(p.sys), 0, 0.25, w * 0.42, 0.09, w * 0.5, 6, { axis: 'z' }); } };
FAC.pump_h = (G, F, it, p, lod) => { const { w, d, h } = p; box(G, F, 'paint_grey', 0, 0.08, 0, w, 0.16, d, { faces: 'tsew' }); cyl(G, F, T0(it, 0, 'paint_blue'), -w * 0.18, 0.16 + d * 0.32, 0, d * 0.32, w * 0.5, lod ? 6 : 10, { axis: 'x' }); cyl(G, F, T0(it, 1, 'engine_grey'), w * 0.28, 0.16 + d * 0.32, 0, d * 0.36, w * 0.3, lod ? 6 : 10, { axis: 'x' }); if (lod === 0) cyl(G, F, sysTile(p.sys), w * 0.28, h - 0.05, 0, 0.08, 0.3, 6); };
FAC.cooler = (G, F, it, p, lod) => { const { w, d, h } = p; box(G, F, 'engine_grey', 0, h / 2, -d / 2 + 0.06, w, h, 0.12, { faces: 'tsewn' }); box(G, F, 'engine_grey', 0, h / 2, d / 2 - 0.06, w, h, 0.12, { faces: 'tsewn' }); box(G, F, 'metal_brushed', 0, h / 2, 0, w - 0.1, h - 0.15, d - 0.25, { faces: 'tsew' }); if (lod === 0) for (const [sy, t] of [[0.4, 'paint_blue'], [h - 0.4, 'paint_green']]) cyl(G, F, t, 0, sy, d / 2 + 0.1, 0.08, 0.2, 6, { axis: 'z' }); };
FAC.skid = (G, F, it, p, lod) => { const { w, d, h } = p; box(G, F, T0(it, 1, 'paint_er'), 0, 0.08, 0, w, 0.16, d, { faces: 'tsew' }); for (const sx of [-w / 2 + 0.05, w / 2 - 0.05]) box(G, F, 'paint_yellow', sx, h / 2, 0, 0.08, h, d, { faces: 'sewn' }); cyl(G, F, T0(it, 0, 'metal_brushed'), -w * 0.2, 0.16 + d * 0.32 + 0.1, 0, d * 0.32, w * 0.5, lod ? 6 : 10, { axis: 'x' }); cyl(G, F, 'engine_grey', w * 0.25, h * 0.45, 0, d * 0.25, h * 0.7, lod ? 6 : 8); if (lod === 0) rod(G, sysTile(p.sys), W(F, -w / 2, h - 0.2, 0), W(F, w / 2, h - 0.2, 0), 0.05, 6); };
FAC.tank_face = (G, F, it, p, lod) => { const { w, d, h } = p; box(G, F, 'paint_er', 0, h / 2, 0, w, h, d, { faces: 'tsew' }); if (lod === 0) { box(G, F, 'glass_tile', w / 2 - 0.25, h / 2, d / 2 + 0.03, 0.05, h * 0.7, 0.05, { faces: 'se' }); cyl(G, F, 'metal_brushed', -w / 4, h * 0.35, d / 2 + 0.03, 0.3, 0.05, 10, { axis: 'z' }); box(G, F, 'hazard', 0, 0.08, d / 2 + 0.005, w, 0.12, 0.01, { faces: 's' }); box(G, F, 'paint_white', w / 4, h * 0.75, d / 2 + 0.005, 0.5, 0.15, 0.01, { faces: 's' }); } };
FAC.tank_box = (G, F, it, p, lod) => { const { w, d, h } = p; box(G, F, T0(it, 0, 'paint_grey'), 0, h / 2, 0, w, h, d, { noBottom: true }); if (lod === 0) { cyl(G, F, 'metal_brushed', 0, h + 0.1, 0, 0.12, 0.2, 6); box(G, F, 'gauges', 0, h * 0.6, d / 2 + 0.005, 0.4, 0.3, 0.01, { faces: 's' }); } };
FAC.boiler = (G, F, it, p, lod) => { const { w, h } = p; cyl(G, F, T0(it, 0, 'paint_grey'), 0, h / 2, 0, w * 0.46, h, lod ? 8 : 14); if (lod === 0) { cyl(G, F, 'metal_brushed', 0, h + 0.4, 0, 0.18, 0.8, 8); box(G, F, 'gauges', 0, h * 0.5, w * 0.45, 0.5, 0.35, 0.05, { faces: 's' }); } };
FAC.incinerator = (G, F, it, p, lod) => { const { w, d, h } = p; box(G, F, 'paint_grey', 0, h * 0.4, 0, w, h * 0.8, d, { noBottom: true }); cyl(G, F, 'metal_brushed', 0, h * 0.9, 0, w * 0.2, h * 0.2, 8); if (lod === 0) box(G, F, 'paint_red', 0, h * 0.35, d / 2 + 0.01, w * 0.4, w * 0.4, 0.02, { faces: 's' }); };
FAC.purifier = (G, F, it, p, lod) => { const { w, d, h } = p; box(G, F, 'engine_grey', 0, 0.3, 0, w, 0.6, d, { noBottom: true }); cyl(G, F, 'metal_brushed', 0, 0.6 + (h - 0.6) / 2, 0, w * 0.33, h - 0.6, lod ? 6 : 10, { rt: w * 0.25 }); if (lod === 0) { cyl(G, F, 'paint_brown', w * 0.38, 0.9, 0, 0.05, 0.6, 6, { axis: 'x' }); box(G, F, 'gauges', 0, 0.35, d / 2 + 0.005, w * 0.6, 0.3, 0.01, { faces: 's' }); } };
FAC.lathe = (G, F, it, p, lod) => { const { w, d, h } = p; box(G, F, T0(it, 0, 'engine_green'), 0, 0.4, 0, w, 0.8, d * 0.7, { noBottom: true }); box(G, F, 'metal_brushed', 0, 0.85, 0, w, 0.1, d * 0.5, { faces: 'tsew' }); box(G, F, T0(it, 0, 'engine_green'), -w / 2 + 0.3, 1.05, 0, 0.55, 0.45, d * 0.6, { faces: 'tsew' }); if (lod === 0) { cyl(G, F, 'metal_brushed', -w / 2 + 0.65, 1.05, 0, 0.12, 0.1, 10, { axis: 'x' }); box(G, F, T0(it, 0, 'engine_green'), w / 2 - 0.25, 1.0, 0, 0.3, 0.3, 0.3, { faces: 'tsew' }); } };
FAC.drill = (G, F, it, p) => { const { w, d, h } = p; box(G, F, 'engine_green', 0, 0.45, 0, w, 0.9, d, { noBottom: true }); cyl(G, F, 'metal_brushed', 0, h - 0.4, -d / 4, 0.05, 0.8, 6, { caps: false }); box(G, F, 'engine_green', 0, h - 0.15, 0, 0.3, 0.3, d * 0.8, { faces: 'tsew' }); };
FAC.steering = (G, F, it, p, lod) => { const { w, d, h } = p; box(G, F, 'paint_grey', 0, 0.1, 0, w, 0.2, d, { faces: 'tsew' }); cyl(G, F, 'engine_green', 0, 0.2 + (h - 0.2) / 2, 0, Math.min(w, d) * 0.3, h - 0.2, lod ? 8 : 14); cyl(G, F, 'metal_brushed', 0, h + 0.2, 0, 0.25, 0.4, 10); for (const sx of [-1, 1]) { box(G, F, 'engine_green', sx * (w / 2 - 0.4), 0.6, -d / 2 + 0.35, 0.7, 0.8, 0.6, { faces: 'tsew' }); if (lod === 0) cyl(G, F, 'paint_yellow', sx * (w / 2 - 0.4), 1.1, -d / 2 + 0.35, 0.18, 0.25, 8); } };
FAC.winch = (G, F, it, p, lod) => { const { w, d, h } = p; box(G, F, 'paint_grey', 0, 0.2, 0, w, 0.4, d, { faces: 'tsew' }); cyl(G, F, T0(it, 0, 'paint_yellow'), 0, h * 0.55, 0, d * 0.35, w * 0.7, lod ? 8 : 14, { axis: 'x' }); if (lod === 0) cyl(G, F, 'rope', 0, h * 0.55, 0, d * 0.38, w * 0.5, 14, { axis: 'x', caps: false }); for (const sx of [-1, 1]) box(G, F, T0(it, 0, 'paint_yellow'), sx * (w / 2 - 0.1), h * 0.5, 0, 0.2, h * 0.9, d * 0.8, { faces: 'tsewn' }); };
FAC.windlass = (G, F, it, p, lod) => { const { w, d, h } = p; box(G, F, 'paint_grey', 0, 0.15, 0, w, 0.3, d, { faces: 'tsew' }); cyl(G, F, 'paint_green', 0, h * 0.6, 0, d * 0.32, w * 0.55, lod ? 8 : 14, { axis: 'x' }); cyl(G, F, 'metal_brushed', w * 0.4, h * 0.6, 0, d * 0.4, 0.2, lod ? 8 : 14, { axis: 'x' }); box(G, F, 'paint_green', -w * 0.38, h * 0.45, 0, 0.4, h * 0.9, d * 0.6, { faces: 'tsewn' }); };
FAC.mooring_winch = (G, F, it, p, lod) => FAC.winch(G, F, { tiles: ['paint_yellow'] }, p, lod);
FAC.capstan = (G, F, it, p) => { cyl(G, F, 'paint_grey', 0, p.h / 2, 0, p.w * 0.4, p.h, 10, { rt: p.w * 0.3 }); };
FAC.bitt = (G, F, it, p) => { const { w, d, h } = p; box(G, F, 'paint_grey', 0, 0.05, 0, w, 0.1, d, { faces: 'tsew' }); for (const sx of [-w / 4, w / 4]) cyl(G, F, 'paint_white', sx, h / 2, 0, d * 0.4, h, 8, { capTile: 'paint_grey' }); };
FAC.fairlead = (G, F, it, p) => { const { w, d, h } = p; box(G, F, 'paint_grey', 0, h / 2, 0, w, h, d, { faces: 'tsew' }); };
FAC.rope_coil = (G, F, it, p) => { cyl(G, F, 'rope', 0, p.h / 2, 0, p.w / 2, p.h, 10); };
FAC.vent = (G, F, it, p) => { const { w, h } = p; cyl(G, F, 'paint_white', 0, h * 0.4, 0, w * 0.25, h * 0.8, 8, { caps: false }); cyl(G, F, 'paint_white', 0, h * 0.85, 0, w * 0.5, h * 0.25, 8, { rt: w * 0.1 }); };
FAC.post = (G, F, it, p) => cyl(G, F, 'metal_brushed', 0, p.h / 2, 0, p.w / 2, p.h, 6);
FAC.lifebuoy = (G, F, it, p) => { cyl(G, F, 'paint_orange', 0, p.h / 2, 0, p.w / 2, 0.1, 10, { axis: 'z' }); };
FAC.fire_box = (G, F, it, p) => { const { w, d, h } = p; box(G, F, 'paint_red', 0, h / 2, 0, w, h, d, { faces: 'tsewb' }); box(G, F, 'paint_white', 0, h * 0.7, d / 2 + 0.005, w * 0.6, h * 0.15, 0.01, { faces: 's' }); };
FAC.extinguisher = (G, F, it, p) => { cyl(G, F, 'paint_red', 0, 0.75, 0.05, 0.08, 0.5, 6); box(G, F, 'rubber_black', 0, 1.05, 0.05, 0.06, 0.1, 0.06, { faces: 'tsew' }); box(G, F, 'metal_brushed', 0, 0.75, -0.05, 0.12, 0.08, 0.04, { faces: 'ts' }); };
FAC.hatch = (G, F, it, p) => { const { w, d, h } = p; box(G, F, 'paint_grey', 0, h / 2, 0, w, h, d, { faces: 'tsew' }); };
FAC.lamp_box = (G, F, it, p) => { const { w, d, h } = p; box(G, F, T0(it, 0, 'paint_grey'), 0, h / 2, 0, w, h, d, { faces: 'tsewb' }); box(G, F, 'light', 0, h / 2, d / 2 + 0.005, w * 0.7, h * 0.6, 0.01, { faces: 's' }); };
FAC.chest = (G, F, it, p) => { const { w, d, h } = p; box(G, F, T0(it, 0, 'paint_orange'), 0, h / 2, 0, w, h, d, { noBottom: true }); box(G, F, 'paint_white', 0, h * 0.6, d / 2 + 0.005, w * 0.7, h * 0.3, 0.01, { faces: 's' }); };
FAC.plant = (G, F, it, p) => { const { w, h } = p; cyl(G, F, T0(it, 1, 'paint_white'), 0, 0.22, 0, w * 0.32, 0.44, 8, { rt: w * 0.38 }); box(G, F, 'leaf', 0, h * 0.62, 0, w * 0.9, h * 0.6, w * 0.9, { faces: 'tsewn' }); box(G, F, 'leaf', 0, h * 0.7, 0, w * 0.7, h * 0.5, w * 1.0, { faces: 'tsewn', rx: 0.5 }); };
FAC.visor = (G, F, it, p) => box(G, F, 'rubber_black', 0, 0, 0, p.w, p.h, 0.02, { faces: 'sn', rx: 0.25 });
FAC.wiper = (G, F, it, p) => { box(G, F, 'rubber_black', 0, 0.45, 0, 0.03, 0.9, 0.03, { faces: 'sewn' }); };
FAC.artwork = (G, F, it, p) => { const { w, h } = p; box(G, F, T0(it, 0, 'art'), 0, 0, 0, w, h, 0.03, { faces: 'sewtb' }); };
FAC.sign_box = (G, F, it, p) => { const { w, h } = p; box(G, F, T0(it, 0, 'sign_exit'), 0, 0, 0, w, h, 0.04, { faces: 'sewtb' }); };
FAC.tv = (G, F, it, p) => { const { w, h } = p; box(G, F, 'rubber_black', 0, 0, 0, w, h, 0.06, { faces: 'tbsew' }); box(G, F, 'screen_off', 0, 0, 0.031, w - 0.06, h - 0.06, 0.005, { faces: 's' }); };
FAC.curtain = (G, F, it, p) => { const { w, h } = p; box(G, F, T0(it, 0, 'fabric_blue'), 0, h / 2, 0.03, w, h, 0.04, { faces: 'tsnew' }); };
FAC.mat = (G, F, it, p) => { const { w, d } = p; box(G, F, T0(it, 0, 'rubber'), 0, 0.01, 0, w, 0.02, d, { faces: 't' }); };
FAC.treadmill = (G, F, it, p) => { const { w, d } = p; box(G, F, 'rubber_black', 0, 0.12, 0.1, w, 0.24, d - 0.2, { faces: 'tsew' }); for (const sx of [-w / 2 + 0.05, w / 2 - 0.05]) box(G, F, 'metal_brushed', sx, 0.6, -d / 2 + 0.2, 0.05, 1.1, 0.05, { faces: 'sewn' }); box(G, F, 'console', 0, 1.2, -d / 2 + 0.2, w, 0.2, 0.15, { faces: 'tsew' }); };
FAC.bike = (G, F, it, p) => { const { d } = p; box(G, F, 'rubber_black', 0, 0.3, 0, 0.12, 0.5, d * 0.8, { faces: 'tsew' }); box(G, F, 'leather', 0, 0.85, d * 0.15, 0.2, 0.06, 0.28, { faces: 'tsew' }); box(G, F, 'console', 0, 1.1, -d * 0.35, 0.4, 0.06, 0.15, { faces: 'tsew' }); box(G, F, 'rubber_black', 0, 0.04, 0, 0.5, 0.06, d, { faces: 'tsew' }); };
FAC.weights = (G, F, it, p) => { const { w, d } = p; box(G, F, 'metal_brushed', 0, 0.45, 0, 0.05, 0.9, d, { faces: 'sewn' }); box(G, F, 'metal_brushed', 0, 0.9, 0, w, 0.05, 0.05, { faces: 'tsb' }); for (const sx of [-w / 2 + 0.1, w / 2 - 0.1]) cyl(G, F, 'rubber_black', sx, 0.9, 0, 0.22, 0.06, 10, { axis: 'x' }); box(G, F, 'rubber_black', 0, 0.2, 0.1, w * 0.8, 0.12, 0.35, { faces: 'tsew' }); };
FAC.cabinet_glass = (G, F, it, p) => { const { w, d, h } = p; box(G, F, 'paint_white', 0, h / 2, 0, w, h, d, { noBottom: true }); box(G, F, 'glass_tile', 0, h * 0.65, d / 2 + 0.005, w - 0.08, h * 0.55, 0.01, { faces: 's' }); };
FAC.cage = (G, F, it, p) => { const { w, d, h } = p; box(G, F, 'cardboard', 0, h * 0.35, 0, w - 0.1, h * 0.7, d - 0.1, { faces: 'tsew' }); box(G, F, 'metal_brushed', 0, h / 2, d / 2, w, h, 0.02, { faces: 's' }); };
FAC.reel = (G, F, it, p) => { cyl(G, F, 'rope', 0, p.h / 2, 0, p.w * 0.38, p.w * 0.6, 10, { axis: 'x', caps: false }); for (const sx of [-1, 1]) cyl(G, F, 'paint_grey', sx * p.w * 0.32, p.h / 2, 0, p.w / 2, 0.05, 10, { axis: 'x' }); };
FAC.drums = (G, F, it, p) => { const { w, d, h } = p; const n = Math.max(1, Math.floor(w / 0.6)); for (let i = 0; i < n; i++) cyl(G, F, i % 2 ? T0(it, 1, 'paint_red') : T0(it, 0, 'paint_blue'), -w / 2 + (w * (i + 0.5)) / n, h / 2, 0, Math.min(0.29, d / 2), h, 8); };
FAC.crates = (G, F, it, p) => { const { w, d, h } = p; box(G, F, 'wood_furn', -w / 4, h * 0.3, 0, w / 2 - 0.02, h * 0.6, d, { noBottom: true }); box(G, F, 'cardboard', w / 4, h * 0.25, 0, w / 2 - 0.02, h * 0.5, d - 0.1, { noBottom: true }); box(G, F, 'cardboard', -w / 4 + 0.05, h * 0.8, 0, w / 2 - 0.15, h * 0.4, d - 0.2, { faces: 'tsew' }); };
FAC.sacks = (G, F, it, p) => { const { w, d, h } = p; for (let i = 0; i < 3; i++) box(G, F, 'canvas', 0, h * (0.17 + i * 0.32), 0, w - i * 0.1, h * 0.3, d - i * 0.05, { faces: 'tsew' }); };
FAC.stage = (G, F, it, p) => { const { w, d, h } = p; box(G, F, 'veneer_dark', 0, h / 2, 0, w, h, d, { faces: 'tsew' }); box(G, F, 'fabric_red', 0, 2.2, -d / 2 + 0.05, w, 3.2, 0.1, { faces: 's' }); };
FAC.bar = (G, F, it, p) => { const { w, d, h } = p; box(G, F, T0(it, 0, 'veneer_dark'), 0, h / 2, 0, w, h, d, { noBottom: true }); box(G, F, T0(it, 1, 'stone'), 0, h + 0.02, 0, w + 0.06, 0.04, d + 0.1, { faces: 'tsewn' }); };
FAC.slots = (G, F, it, p) => { const { w, d, h } = p; const n = Math.max(1, Math.round(w / 0.7)); for (let i = 0; i < n; i++) { const sx = -w / 2 + (w * (i + 0.5)) / n; box(G, F, 'console_body', sx, h / 2, 0, w / n - 0.06, h, d, { noBottom: true }); box(G, F, 'screen_ecdis', sx, h * 0.65, d / 2 + 0.005, w / n - 0.2, 0.4, 0.01, { faces: 's' }); } };
FAC.play = (G, F, it, p) => { const { w, d, h } = p; box(G, F, 'paint_yellow', 0, h / 2, 0, w, h, d, { faces: 'tsew' }); box(G, F, 'paint_blue', 0, h + 0.2, 0, w * 0.5, 0.4, d * 0.5, { faces: 'tsew' }); };
FAC.pelorus = (G, F, it, p) => { cyl(G, F, 'metal_brushed', 0, 0.6, 0, 0.06, 1.2, 6, { caps: false }); cyl(G, F, 'paint_white', 0, 1.25, 0, 0.18, 0.1, 10); };
FAC.chain_block = (G, F, it, p) => { rod(G, 'paint_yellow', W(F, 0, 0, 0), W(F, 0, -0.8, 0), 0.02, 4); box(G, F, 'paint_yellow', 0, -0.4, 0, 0.2, 0.25, 0.15, { faces: 'tsew' }); };
/** Slow-speed two-stroke main engine (v1 prop me2s) with the cylinder count and turbochargers of meDetail (§4.6). */
function drawME2s(G, p, me, lod) {
  const { x, y, z, len, w, h } = p, n = me?.cyl || Math.max(5, Math.min(12, Math.round(len / 1.6))), tc = me?.tc || 1;
  const F = frameOf(x, y, z, 0);
  const pitch = len / n, z0 = -len / 2;
  box(G, F, 'engine_grey', 0, 0.6, 0, w + 0.7, 1.2, len + 0.5, { noBottom: true });                                   // bedplate
  const fh = h * 0.42, by = 1.2 + fh, bh = h * 0.28;
  box(G, F, 'engine_green', 0, 1.2 + fh / 2, 0, w, fh, len, { faces: 'tsnew' });                                        // frame box
  for (let i = 0; i <= n; i++) for (const sx of [-1, 1]) box(G, F, 'engine_green', sx * (w / 2 + 0.06), 1.2 + fh / 2, z0 + i * pitch, 0.14, fh, 0.22, { faces: sx > 0 ? 'tsne' : 'tsnw' });   // A-frames
  if (lod === 0) for (let i = 0; i < n; i++) for (const sx of [-1, 1]) { const cz = z0 + (i + 0.5) * pitch; box(G, F, 'engine_grey', sx * (w / 2 + 0.015), 1.2 + fh * 0.32, cz, 0.03, 0.75, pitch * 0.55, { faces: sx > 0 ? 'e' : 'w' }); box(G, F, 'paint_yellow', sx * (w / 2 + 0.03), 1.2 + fh * 0.32 + 0.3, cz, 0.02, 0.06, 0.12, { faces: sx > 0 ? 'e' : 'w' }); }   // crankcase doors
  box(G, F, 'engine_green', 0, by + bh / 2, 0, w * 0.82, bh, len * 0.97, { faces: 'tsnew' });                          // cylinder block
  const topY = by + bh;
  for (let i = 0; i < n; i++) {
    const cz = z0 + (i + 0.5) * pitch;
    cyl(G, F, 'engine_grey', 0, topY + 0.22, cz, Math.min(w * 0.3, pitch * 0.42), 0.44, lod ? 6 : 10);                // cylinder cover
    cyl(G, F, 'metal_brushed', 0, topY + 0.62, cz, 0.13, 0.36, 6);                                                     // exhaust valve actuator
    if (lod === 0) { box(G, F, 'paint_blue', -w * 0.48, by + bh * 0.5, cz, 0.36, 0.6, pitch * 0.55, { faces: 'tsnew' }); rod(G, 'metal_brushed', W(F, 0.1, topY + 0.3, cz), W(F, w * 0.55, h * 0.93, cz), 0.12, 6); }   // HCU, exhaust pipe
  }
  cyl(G, F, 'metal_brushed', w * 0.6, h * 0.93, 0, w * 0.26, len * 0.95, lod ? 6 : 12, { axis: 'z' });                // exhaust receiver
  box(G, F, 'engine_green', -w * 0.62, by - 0.2, 0, w * 0.35, 1.2, len * 0.9, { faces: 'tsnew' });                    // scavenge air receiver
  for (let k = 0; k < tc; k++) {
    const tz = z0 - 0.4 - (tc > 1 ? (k - (tc - 1) / 2) * 0 : 0), tx = (tc === 1 ? 0 : (k - (tc - 1) / 2) * w * 0.55) + w * 0.35;
    const zz = tc === 1 ? z0 - 1.0 : z0 + len * (0.2 + 0.6 * (k / Math.max(1, tc - 1)));
    const xx = tc === 1 ? w * 0.25 : w * 0.95;
    cyl(G, F, 'engine_grey', xx, h * 0.9, zz, 0.75, 1.0, lod ? 8 : 14, { axis: 'x' });                                  // turbine casing
    cyl(G, F, 'metal_brushed', xx - 0.95, h * 0.9, zz, 0.85, 0.9, lod ? 8 : 14, { axis: 'x' });                        // compressor + silencer
    if (lod === 0) cyl(G, F, 'rubber_black', xx - 1.45, h * 0.9, zz, 0.8, 0.1, 14, { axis: 'x' });
    void tz; void tx;
  }
  box(G, F, 'engine_grey', -w * 0.45, h * 0.62, z0 - 0.9, w * 0.9, 1.6, 1.0, { faces: 'tsnew' });                     // scavenge air cooler
  if (lod === 0) { box(G, F, 'engine_grey', 0, 1.0, len / 2 + 0.55, w * 0.8, 1.4, 0.7, { faces: 'tsnew' }); cyl(G, F, 'paint_yellow', 0, 1.0, len / 2 + 1.0, 0.45, 0.2, 12, { axis: 'z' }); }   // chain drive end, turning gear
}
/** Medium-speed four-stroke (v1 prop engine): inline or V, heads with rocker covers, turbo at the free end, flywheel. */
function drawME4s(G, p, me, lod) {
  const { x, y, z, len, w, h } = p, V = me?.layout === 'V', cylN = me?.cyl || 6, perBank = V ? cylN / 2 : cylN;
  const F = frameOf(x, y, z, 0), pitch = (len * 0.82) / perBank, z0 = -len / 2 + len * 0.05;
  box(G, F, 'engine_grey', 0, 0.12, 0, w + 0.3, 0.24, len + 0.2, { noBottom: true });
  box(G, F, 'engine_green', 0, 0.24 + h * 0.3, 0, w * 0.85, h * 0.6, len * 0.85, { faces: 'tsnew' });
  const banks = V ? [-1, 1] : [0];
  for (const b of banks) for (let i = 0; i < perBank; i++) {
    const cz = z0 + (i + 0.5) * pitch, bx = b * w * 0.22;
    box(G, F, 'engine_green', bx, 0.24 + h * 0.66, cz, V ? w * 0.36 : w * 0.6, h * 0.14, pitch * 0.9, { faces: 'tsnew' });
    if (lod === 0) box(G, F, 'metal_brushed', bx, 0.24 + h * 0.76, cz, V ? w * 0.26 : w * 0.42, h * 0.07, pitch * 0.7, { faces: 'tsnew' });   // rocker cover
  }
  cyl(G, F, 'metal_brushed', 0, h * 0.85, -len / 2 - 0.1, Math.min(0.5, w * 0.35), 0.6, lod ? 6 : 10, { axis: 'z' });   // turbo
  cyl(G, F, 'engine_grey', 0, h * 0.45, len / 2 - 0.05, Math.min(h * 0.42, w * 0.6), 0.18, lod ? 8 : 14, { axis: 'z' });   // flywheel
  if (lod === 0) rod(G, 'metal_brushed', W(F, w * 0.3, h * 0.9, z0), W(F, w * 0.3, h * 0.9, -z0), 0.09, 6);              // exhaust manifold
}
/** Generator set (v1 prop generator): engine on a bedframe, alternator at the end, local panel. */
function drawGenset(G, p, lod) {
  const { x, y, z, len, w, h } = p, F = frameOf(x, y, z, 0);
  box(G, F, 'paint_grey', 0, 0.1, 0, w + 0.1, 0.2, len, { noBottom: true });
  box(G, F, 'engine_grey', 0, 0.2 + h * 0.32, -len * 0.18, w * 0.8, h * 0.62, len * 0.6, { faces: 'tsnew' });
  for (let i = 0; i < 6 && lod === 0; i++) box(G, F, 'metal_brushed', 0, 0.2 + h * 0.67, -len * 0.45 + i * len * 0.09, w * 0.5, h * 0.08, len * 0.07, { faces: 'tsnew' });
  cyl(G, F, 'paint_blue', 0, 0.2 + h * 0.36, len * 0.3, Math.min(w * 0.45, h * 0.36), len * 0.36, lod ? 8 : 12, { axis: 'z' });
  cyl(G, F, 'metal_brushed', 0, h * 0.82, -len * 0.5, 0.2, 0.3, 6, { axis: 'z' });
  if (lod === 0) box(G, F, 'gauges', w * 0.42, h * 0.6, len * 0.42, 0.04, 0.4, 0.5, { faces: 'e' });
}
/** Guard rails round the floor openings (cuts) of an engine-room platform. */
function cutRails(G, r) {
  for (const c of r.cuts || []) {
    const y = r.y, pts = [[c.x0, c.z0], [c.x1, c.z0], [c.x1, c.z1], [c.x0, c.z1], [c.x0, c.z0]];
    for (let i = 0; i < 4; i++) { const [ax, az] = pts[i], [bx, bz] = pts[i + 1]; rod(G, 'paint_yellow', [ax, y + 1.0, az], [bx, y + 1.0, bz], 0.025, 5); rod(G, 'paint_yellow', [ax, y + 0.5, az], [bx, y + 0.5, bz], 0.018, 4); const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(L / 1.5)); for (let k = 0; k < n; k++) { const t = k / n; rod(G, 'paint_yellow', [ax + (bx - ax) * t, y, az + (bz - az) * t], [ax + (bx - ax) * t, y + 1.0, az + (bz - az) * t], 0.02, 4); } }
    const F = frameOf((c.x0 + c.x1) / 2, 0, c.z0 - 0.0, 0); box(G, F, 'hazard', 0, y + 0.06, 0, c.x1 - c.x0, 0.12, 0.02, { faces: 'sn' });
  }
}
function screenTile(kind) { return kind === 'radarX' || kind === 'radarS' || kind === 'radar' ? 'screen_radar' : kind === 'ecdis' ? 'screen_ecdis' : kind === 'alarm' || kind === 'ams' || kind === 'dp' ? 'screen_ams' : kind === 'conning' || kind === 'autopilot' || kind === 'thruster' ? 'screen_conning' : kind && TILES[tileOf(kind)]?.kind === 'emissive' ? kind : 'screen_ecdis'; }
function sysTile(sys) { const s = Array.isArray(sys) ? sys[0] : sys; return SYS_TILE[s] || 'paint_grey'; }

/** Draw a k2 prop. lod 0 = the full item; 1 = its bounding box with the main tile. */
export function drawItem(G, p, lod = 0) {
  const it = ITEMS[p.item] || {};
  const F = frameOf(p.x, p.y, p.z, p.rotY || 0);
  const q = { w: p.w ?? it.w, d: p.d ?? it.d, h: p.h ?? it.h, screen: p.screen, sys: p.sys, benches: p.benches, tableD: p.tableD };
  if (lod === 1) { const tile = it.tiles?.[0] || 'paint_grey'; const hb = it.over ? 0 : q.h / 2; if (it.over || it.mount) box(G, F, TILES[tileOf(tile)].kind === 'emissive' ? 'console' : tile, 0, 0, 0, q.w, q.h, q.d, { faces: 'tbsewn' }); else box(G, F, TILES[tileOf(tile)].kind === 'emissive' ? 'console' : tile, 0, hb, 0, q.w, q.h, q.d, { noBottom: true }); return; }
  const f = FAC[p.item] || FAC[it.shape] || null;
  if (f) f(G, F, it, q, lod); else box(G, F, it.tiles?.[0] || 'paint_grey', 0, q.h / 2, 0, q.w, q.h, q.d, { noBottom: true });
}
/** A run (pipe / tray / duct / frame). */
export function drawRun(G, p, room, lod = 0) {
  if (p.kind === 'pipe') { const a = p.pts[0], b = p.pts[p.pts.length - 1]; rod(G, SYS_TILE[p.sys] || 'paint_grey', a, b, p.r || 0.05, lod ? 4 : 8); if (lod === 0) { const len = Math.hypot(b[0] - a[0], b[2] - a[2]); const n = Math.floor(len / 2); for (let i = 1; i <= n; i++) { const t = i / (n + 1), x = a[0] + (b[0] - a[0]) * t, z = a[2] + (b[2] - a[2]) * t; G.quad('metal_brushed', [x - 0.02, a[1], z], [x + 0.02, a[1], z], [x + 0.02, (room ? room.y + room.h : a[1] + 0.3), z], [x - 0.02, (room ? room.y + room.h : a[1] + 0.3), z], [0, 0, 1], 0, 0, 0.04, 0.3); } } return; }
  if (p.kind === 'tray') { const a = p.pts[0], b = p.pts[1], F = frameOf((a[0] + b[0]) / 2, a[1], (a[2] + b[2]) / 2, Math.abs(b[0] - a[0]) > Math.abs(b[2] - a[2]) ? 0 : Math.PI / 2); const len = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[2] - a[2])); box(G, F, 'metal_brushed', 0, 0, 0, len, 0.02, p.w || 0.4, { faces: 'tb' }); if (lod === 0) { box(G, F, 'rubber_black', 0, 0.03, 0, len, 0.04, (p.w || 0.4) * 0.7, { faces: 't' }); for (const sz of [-1, 1]) box(G, F, 'metal_brushed', 0, 0.04, sz * (p.w || 0.4) / 2, len, 0.08, 0.01, { faces: 'sn' }); } return; }
  if (p.kind === 'frame' && room) drawFrames(G, room, p, lod);
}
/** Transverse frames (flat bar + flange) on the long walls of an unlined room, deck girders under the deckhead. */
function drawFrames(G, r, p, lod) {
  const s = p.s || 0.7, top = r.y + r.h, web = p.web || 4 * s;
  const alongX = r.x1 - r.x0 > r.z1 - r.z0;
  const sides = [];
  if (r.walls?.w !== false) sides.push(['w', r.x0 + 0.06]); if (r.walls?.e !== false) sides.push(['e', r.x1 - 0.06]);
  const step = lod ? s * 2 : s;
  for (let z = Math.ceil((r.z0 + 0.2) / step) * step; z < r.z1 - 0.2; z += step) {
    const isWeb = Math.abs(z / web - Math.round(z / web)) < 0.06, depth = isWeb ? 0.32 : 0.14;
    for (const [side, x] of sides) {
      const dir = side === 'w' ? 1 : -1, cx = x + (dir * depth) / 2;
      const F = frameOf(cx, 0, z, 0);
      box(G, F, 'paint_er', 0, (r.y + top) / 2, 0, depth, r.h - 0.05, 0.02, { faces: 'sne' });
      if (lod === 0) box(G, F, 'paint_er', dir * depth / 2, (r.y + top) / 2, 0, 0.02, r.h - 0.05, 0.1, { faces: dir > 0 ? 'e' : 'w' });
    }
    if (isWeb && lod === 0) { const F = frameOf((r.x0 + r.x1) / 2, 0, z, 0); box(G, F, 'paint_er', 0, top - 0.18, 0, r.x1 - r.x0, 0.36, 0.02, { faces: 'sbn' }); }
  }
  if (!alongX && lod === 0) for (let x = r.x0 + 1.2; x < r.x1 - 0.6; x += 2.4) { const F = frameOf(x, 0, (r.z0 + r.z1) / 2, 0); box(G, F, 'paint_er', 0, top - 0.12, 0, 0.02, 0.24, r.z1 - r.z0, { faces: 'bew' }); }
}

// ------------------------------------------------------------------------------------------------ shells
function rectMinus(r, holes) {
  let rects = [r];
  for (const h of holes || []) {
    const next = [];
    for (const q of rects) {
      const ix0 = Math.max(q.x0, h.x0), ix1 = Math.min(q.x1, h.x1), iz0 = Math.max(q.z0, h.z0), iz1 = Math.min(q.z1, h.z1);
      if (ix1 - ix0 <= 0.01 || iz1 - iz0 <= 0.01) { next.push(q); continue; }
      if (ix0 - q.x0 > 0.01) next.push({ x0: q.x0, x1: ix0, z0: q.z0, z1: q.z1 });
      if (q.x1 - ix1 > 0.01) next.push({ x0: ix1, x1: q.x1, z0: q.z0, z1: q.z1 });
      if (iz0 - q.z0 > 0.01) next.push({ x0: ix0, x1: ix1, z0: q.z0, z1: iz0 });
      if (q.z1 - iz1 > 0.01) next.push({ x0: ix0, x1: ix1, z0: iz1, z1: q.z1 });
    }
    rects = next;
  }
  return rects;
}
/** One wall face (inside of room r) along `side`, with openings. */
function wallFace(G, r, side, c, from, to, y0, h, ops, tile, skirt) {
  const ns = side === 'n' || side === 's';
  const inward = { n: 1, s: -1, w: 1, e: -1 }[side];
  const nrm = ns ? [0, 0, inward] : [inward, 0, 0];
  const seg = (a, b, bot, top, t = tile) => {
    if (b - a < 0.01 || top - bot < 0.01) return;
    const P = (u, y) => (ns ? [u, y0 + y, c] : [c, y0 + y, u]);
    if ((!ns && inward > 0) || (ns && inward < 0)) G.quad(t, P(b, bot), P(a, bot), P(a, top), P(b, top), nrm, b, bot, a, top);
    else G.quad(t, P(a, bot), P(b, bot), P(b, top), P(a, top), nrm, a, bot, b, top);
  };
  const list = (ops || []).filter((o) => o.to > o.from).sort((a, b) => a.from - b.from);
  let cur = from;
  for (const o of list) {
    const a = Math.max(from, o.from), b = Math.min(to, o.to);
    if (b <= cur) continue;
    const a2 = Math.max(a, cur);
    if (a2 > cur) seg(cur, a2, 0, h);
    const bot = Math.max(0, o.bottom ?? 0), top = Math.min(h, o.top ?? h);
    if (bot > 0) seg(a2, b, 0, bot);
    if (top < h) seg(a2, b, top, h);
    cur = Math.max(cur, b);
  }
  if (cur < to) seg(cur, to, 0, h);
  if (skirt) { // a skirting board 0.08 high (not across door openings)
    const rot = { n: 0, s: Math.PI, w: Math.PI / 2, e: -Math.PI / 2 }[side];
    const piece = (a, b) => { if (b - a < 0.05) return; const m = (a + b) / 2; const F = ns ? frameOf(m, 0, c + inward * 0.008, rot) : frameOf(c + inward * 0.008, 0, m, rot); box(G, F, skirt, 0, y0 + 0.04, 0, b - a, 0.08, 0.012, { faces: 'ts' }); };
    let c2 = from;
    for (const o of list) { if (o.bottom > 0.05) continue; piece(c2, Math.max(from, o.from)); c2 = Math.max(c2, Math.min(to, o.to)); }
    piece(c2, to);
  }
}

// ------------------------------------------------------------------------------------------------ materials
let shared = null;
/** The five v2 materials and their mode uniforms (shared by every zone and every ship this session). */
export function v2Materials(phone = false) {
  if (shared && shared.phone === phone) return shared;
  const size = phone ? 512 : 1024;
  const canvas = atlasCanvas(size);
  let tex;
  if (canvas && canvas.getContext && typeof canvas.width === 'number' && canvas.width === size) { tex = new THREE.CanvasTexture(canvas); tex.anisotropy = 4; tex.colorSpace = THREE.SRGBColorSpace; }
  else { tex = new THREE.DataTexture(new Uint8Array([200, 200, 200, 255]), 1, 1); }
  tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter; tex.needsUpdate = true;
  const U = { uLights: { value: 1 }, uNight: { value: 0 }, uDay: { value: 0.8 }, uEmerg: { value: 0.1 }, uAmb: { value: 0.06 }, uDirect: { value: 0.12 }, uScreen: { value: 1 } };
  const patch = (m) => {
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 aTile;\nattribute vec4 aLight;\nattribute float aKind;\nvarying vec4 vTile;\nvarying vec4 vBake;\nvarying float vKind;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvTile = aTile;\nvBake = aLight;\nvKind = aKind;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec4 vTile;\nvarying vec4 vBake;\nvarying float vKind;\nuniform float uLights, uNight, uDay, uEmerg, uAmb, uDirect, uScreen;')
        .replace('#include <map_fragment>', `
          vec2 tuv = vTile.xy + fract(vMapUv) * vTile.zw;
          vec4 texelColor = textureGrad(map, tuv, dFdx(vMapUv) * vTile.zw, dFdy(vMapUv) * vTile.zw);
          diffuseColor *= texelColor;
          float isMetal = step(0.5, vKind) * step(vKind, 1.5);`)
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix(roughness, 0.45, isMetal);')
        .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = mix(metalness, 0.35, isMetal);')
        .replace('#include <opaque_fragment>', `
          float Pn = abs(vBake.w); vec3 nightCol = vBake.w < 0.0 ? vec3(1.0, 0.18, 0.12) * Pn : vec3(Pn);
          vec3 prac = mix(vec3(vBake.x), nightCol, uNight) * uLights;
          vec3 bake = vec3(uAmb) + prac * vec3(1.0, 0.96, 0.9) + vec3(0.85, 0.92, 1.0) * uDay * vBake.y + vec3(0.75, 0.9, 0.8) * uEmerg * vBake.z;
          outgoingLight = vKind > 1.5 ? diffuseColor.rgb * (uScreen * 1.15 + 0.05) : outgoingLight * uDirect + diffuseColor.rgb * bake;
          #include <opaque_fragment>`);
    };
    m.customProgramCacheKey = () => `iv2k-${m.alphaTest > 0 ? 'c' : 'o'}`;
    return m;
  };
  const solid = patch(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.82, metalness: 0.02 }));
  const cutout = patch(new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, metalness: 0.3, alphaTest: 0.5, side: THREE.DoubleSide }));
  const glass = new THREE.MeshStandardMaterial({ color: 0x9fc8e8, transparent: true, opacity: 0.18, roughness: 0.05, metalness: 0.4, side: THREE.DoubleSide, depthWrite: false });
  // opaque / metal / emissive are the solid material's per-vertex kinds (aKind 0 / 1 / 2): one draw call per chunk
  const opaque = solid, metal = solid, emissive = solid;
  shared = { phone, tex, U, mats: { solid, cutout, glass, opaque, metal, emissive } };
  return shared;
}

// ------------------------------------------------------------------------------------------------ legacy props through the atlas
/** A PartBuilder look-alike for interior.js / gaprops.js prop drawing: every part lands in the Geo with a tile. */
function legacyAdapter(G, M) {
  const tileOfMat = new Map();
  const set = (k, t) => { if (M[k]) tileOfMat.set(M[k], t); };
  for (const [k, t] of Object.entries({ wall: 'laminate', wallDark: 'paint_er', wallWood: 'veneer', wallSteel: 'paint_grey', ceil: 'ceil_panel', lino: 'lino_grey', carpet: 'carpet', woodFloor: 'veneer', grating: 'grating', steelFloor: 'chequer', deck: 'deck', teak: 'teak', steel: 'metal_brushed', dark: 'rubber_black', console: 'console_body', wood: 'wood_furn', fabric: 'fabric_blue', fabric2: 'fabric_red', blanket: 'fabric_blue', pillow: 'bedding', engine: 'engine_green', yellow: 'paint_yellow', red: 'paint_red', white: 'paint_white', rail: 'metal_brushed', hatch: 'paint_green', orange: 'paint_orange', green: 'screen_radar', light: 'light', glass: 'glass_tile' })) set(k, t);
  let gaIndexed = false;
  const indexGA = () => { const X = M._ga; if (!X || gaIndexed) return; gaIndexed = true; for (const [k, t] of Object.entries({ screen: 'screen_ecdis', radarScr: 'screen_radar', lifeboat: 'paint_orange', water: 'paint_blue', green2: 'paint_green', blue: 'paint_blue', heli: 'rubber_black', cream: 'paint_white', mud: 'cardboard' })) if (X[k]) tileOfMat.set(X[k], t); };
  (M.boxes || []).forEach((m, i) => tileOfMat.set(m, ['paint_red', 'paint_blue', 'paint_green', 'paint_yellow', 'paint_orange', 'paint_brown', 'paint_grey', 'paint_white'][i % 8]));
  const tmpM = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  const tileFor = (mat) => { if (!tileOfMat.has(mat)) indexGA(); return tileOfMat.get(mat) || (mat?.color ? nearestPaint(mat.color.getHex()) : 'paint_grey'); };
  const add = (geo, mat) => { if (!geo.attributes.normal) geo.computeVertexNormals(); G.geometry(geo, tileFor(mat)); geo.dispose?.(); };
  return {
    geo(geometry, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) { tmpM.compose(v.set(x, y, z), q.setFromEuler(e.set(rx, ry, rz)), new THREE.Vector3(sx, sy, sz)); geometry.applyMatrix4(tmpM); add(geometry, mat); return this; },
    box(w, h, d, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) { return this.geo(new THREE.BoxGeometry(w, h, d), mat, x, y, z, rx, ry, rz); },
    cyl(r, h, mat, x = 0, y = 0, z = 0, rt = r, seg = 12, rx = 0, ry = 0, rz = 0) { return this.geo(new THREE.CylinderGeometry(rt, r, h, Math.min(seg, 10)), mat, x, y, z, rx, ry, rz); },
    rod(ax, ay, az, bx, by, bz, r, mat, seg = 6) { rod(G, tileFor(mat), [ax, ay, az], [bx, by, bz], r, Math.min(seg, 6)); return this; },
    cone(r, h, mat, x = 0, y = 0, z = 0, seg = 10, rx = 0, ry = 0, rz = 0) { return this.geo(new THREE.ConeGeometry(r, h, Math.min(seg, 8)), mat, x, y, z, rx, ry, rz); },
    sphere(r, mat, x = 0, y = 0, z = 0, seg = 8) { return this.geo(new THREE.SphereGeometry(r, Math.min(seg, 8), 6), mat, x, y, z); },
    add(mesh) { this.extra.push(mesh); return this; }, extra: [],
    build() { return []; },
  };
  void one;
}
function nearestPaint(hex) {
  const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  if (r > 200 && g > 200 && b > 200) return 'paint_white';
  if (r > 180 && g > 120 && b < 80) return 'paint_yellow';
  if (r > 160 && g < 110 && b < 90) return r > 200 && g > 80 ? 'paint_orange' : 'paint_red';
  if (b > r + 30 && b > g) return 'paint_blue';
  if (g > r + 20 && g >= b) return 'paint_green';
  if (r + g + b < 160) return 'rubber_black';
  return 'paint_grey';
}

// ------------------------------------------------------------------------------------------------ build
const DOOR_TILE = { door: 'wood_furn', watertight: 'paint_grey', ext: 'paint_white', open: null };
/**
 * Build a v2 plan. Returns Map(zoneId → Group) and sets I.v2 (the per-frame controller).
 * opts.phone: phone LOD / atlas size; opts.only: Set of zone ids to build (tests).
 */
export function buildInteriorV2(I, plan, root, opts = {}) {
  const phone = !!opts.phone;
  const S = v2Materials(phone), mats = S.mats;
  const size = phone ? 512 : 1024;
  const byId = new Map(plan.rooms.map((r, i) => [r.id, r]));
  const roomIndex = new Map(plan.rooms.map((r, i) => [r.id, i]));
  const tables = lightTables(plan.rooms, plan.lights || [], plan.doors);
  const bake = (pos, nrm, room) => bakeLight(pos, nrm, room, plan.rooms, plan.lights || [], null, tables);
  const zones = plan.zones?.length ? plan.zones.map((z) => z.id) : ['deck'];
  const zoneOf = (o) => o.zone || 'deck';
  const groups = new Map();
  const ctrl = { plan, zones: new Map(), mats, U: S.U, phone, doors: [], wipers: [], chunkOfRoom: new Map(), views: new Map((plan.views || []).map((v) => [v.room, v.zones])), stats: { tris: 0, calls: 0 } };
  for (const c of plan.chunks || []) for (const rid of c.rooms) ctrl.chunkOfRoom.set(rid, c.id);
  // legacy props: the room they stand in (for the bake) and their chunk
  const roomAtPt = (x, z, y) => { let best = -1, ba = Infinity; for (let i = 0; i < plan.rooms.length; i++) { const r = plan.rooms[i]; if (Math.abs(r.y - y) > 0.4 || x < r.x0 - 0.05 || x > r.x1 + 0.05 || z < r.z0 - 0.05 || z > r.z1 + 0.05) continue; const a = (r.x1 - r.x0) * (r.z1 - r.z0); if (a < ba) { ba = a; best = i; } } return best; };
  for (const zid of zones) {
    if (opts.only && !opts.only.has(zid)) continue;
    const zg = new THREE.Group(); zg.name = `zone:${zid}`;
    const shell = new Geo(size); if (phone) shell.segCap = 8;
    const chunkGeo = new Map(), chunkLo = new Map(), zoneLo = new Geo(size);
    const chunkOf = (cid) => { if (!chunkGeo.has(cid)) { const g = new Geo(size); if (phone) g.segCap = 6; chunkGeo.set(cid, g); chunkLo.set(cid, new Geo(size)); } return [chunkGeo.get(cid), chunkLo.get(cid)]; };
    const rooms = plan.rooms.filter((r) => zoneOf(r) === zid);
    // ---- rooms: floors, ceilings / deckheads, walls with openings, lights
    const ops = new Map();
    const push = (id, side, o) => { const k = id + ':' + side; let l = ops.get(k); if (!l) { l = []; ops.set(k, l); } l.push(o); };
    const edge = (r, side) => ({ n: r.z0, s: r.z1, w: r.x0, e: r.x1 })[side];
    for (const d of plan.doors) {
      const a = byId.get(d.a), b = d.b ? byId.get(d.b) : null; if (!a) continue;
      const inA = zoneOf(a) === zid, opp = { n: 's', s: 'n', e: 'w', w: 'e' }[d.side];
      if (inA) push(a.id, d.side, { from: d.at - d.w / 2, to: d.at + d.w / 2, bottom: 0, top: d.h });
      if (b && zoneOf(b) === zid && !b.open && Math.abs(edge(a, d.side) - edge(b, opp)) < 0.06) push(b.id, opp, { from: d.at - d.w / 2, to: d.at + d.w / 2, bottom: 0, top: d.h });
      if (inA && d.kind !== 'open') { shell.room = roomIndex.get(a.id); doorFrame(shell, a, d); ctrl.doors.push({ d, a, zone: zid, open: 0, t: 0 }); }
    }
    for (const r of rooms) {
      shell.room = roomIndex.get(r.id);
      const mat = r.mat || { floor: 'lino_grey', wall: 'laminate', ceil: 'ceil_panel' };
      for (const w of r.windows || []) push(r.id, w.side, { from: w.from, to: w.to, bottom: w.bottom, top: w.top, glass: true });
      if (r.drawFloor !== false && !(r.open && !r.drawFloor)) for (const q of rectMinus({ x0: r.x0, x1: r.x1, z0: r.z0, z1: r.z1 }, r.floorHoles)) shell.quad(mat.floor, [q.x0, r.y, q.z1], [q.x1, r.y, q.z1], [q.x1, r.y, q.z0], [q.x0, r.y, q.z0], [0, 1, 0], q.x0, q.z1, q.x1, q.z0);
      if (r.open) continue;
      const wallTop = r.lined && r.deckH ? Math.max(r.h, r.deckH - 0.12) : r.h;
      if (r.ceiling !== false) {
        for (const q of rectMinus({ x0: r.x0, x1: r.x1, z0: r.z0, z1: r.z1 }, r.ceilHoles)) shell.quad(mat.ceil, [q.x0, r.y + r.h, q.z0], [q.x1, r.y + r.h, q.z0], [q.x1, r.y + r.h, q.z1], [q.x0, r.y + r.h, q.z1], [0, -1, 0], q.x0, q.z0, q.x1, q.z1);
      }
      const sides = { n: [r.z0 + 0.05, r.x0, r.x1], s: [r.z1 - 0.05, r.x0, r.x1], w: [r.x0 + 0.05, r.z0, r.z1], e: [r.x1 - 0.05, r.z0, r.z1] };
      for (const [side, [c, from, to]] of Object.entries(sides)) {
        if (!r.walls[side]) continue;
        wallFace(shell, r, side, c, from, to, r.y, wallTop + 0.06, ops.get(r.id + ':' + side), mat.wall, r.lined ? 'rubber_black' : null);
      }
      // window frames and glass; rails round floor openings
      for (const w of r.windows || []) windowFrame(shell, r, w);
      if (r.cuts?.length) cutRails(shell, r);
      // light fittings (emissive diffusers) of this room
      for (const l of (plan.lights || []).filter((q) => q.room === r.id)) lightFitting(shell, r, l);
    }
    // ---- stairs, deck surface, rails
    for (const s of plan.stairs) if (zoneOf(s) === zid) { shell.room = roomIndex.get(s.head) ?? -1; drawStair(shell, s, plan.style); }
    if (zid === 'deck' || zones.length === 1) for (const poly of plan.deck?.polys || []) { shell.room = -1; deckPoly(shell, poly, plan.deck, plan.deck.y); }
    for (const rl of plan.rails) if (zoneOf(rl) === zid) { shell.room = -1; drawRailV2(shell, rl.pts, rl.y); }
    // ---- legacy props (machinery, consoles, deck gear) through the adapter; k2 items and runs into chunks
    const adapter = legacyAdapter(shell, I.mats);
    const lctx = { g: zg, M: I.mats, pb: adapter, plan: { ...plan, rooms } };
    for (const p of plan.props) {
      if (zoneOf(p) !== zid) continue;
      if (p.t === 'k2' || p.t === 'run') {
        const cid = p.chunk || (p.room && ctrl.chunkOfRoom.get(p.room)) || `z:${zid}`;
        const [hi, lo] = chunkOf(cid);
        const ri = p.room ? roomIndex.get(p.room) ?? -1 : -1;
        hi.room = ri; lo.room = ri; zoneLo.room = ri;
        if (p.t === 'k2') { drawItem(hi, p, 0); const it = ITEMS[p.item]; if (it && (p.h ?? it.h) >= (phone ? 1.0 : 0.7) && !it.over) { drawItem(lo, p, 1); if ((p.h ?? it.h) >= 1.2) drawItem(zoneLo, p, 1); } }
        else { const room = byId.get(p.room); drawRun(hi, p, room, 0); drawRun(lo, p, room, 1); if (p.kind !== 'frame') drawRun(zoneLo, p, room, 1); }
        if (p.anim === 'wiper') ctrl.wipers.push(p);
        continue;
      }
      if (p.t === 'pipes') continue;   // v1 placeholder runs: v2 draws real ones
      if (p.t === 'me2s' || p.t === 'engine' || p.t === 'generator') {
        shell.room = roomAtPt(p.x, p.z, p.y);
        if (p.t === 'me2s') drawME2s(shell, p, plan.iv2?.me, 0); else if (p.t === 'engine') drawME4s(shell, p, plan.iv2?.me, 0); else drawGenset(shell, p, 0);
        continue;
      }
      const c = { x: p.x ?? (p.x0 + p.x1) / 2, z: p.z ?? (p.z0 + p.z1) / 2, y: p.y ?? p.y0 ?? 0 };
      shell.room = Number.isFinite(c.x) ? roomAtPt(c.x, c.z, c.y) : -1;
      try { I.drawProp(lctx, p); } catch (e) { console.warn('[iv2] prop', p.t, e); }
    }
    // ---- meshes
    for (const m of shell.build(mats, bake)) { m.userData.part = 'shell'; zg.add(m); }
    for (const m of adapter.extra) zg.add(m);
    const chunks = new Map();
    for (const [cid, hi] of chunkGeo) {
      const gh = new THREE.Group(); gh.name = `chunk:${cid}:hi`; for (const m of hi.build(mats, bake)) gh.add(m);
      const gl = new THREE.Group(); gl.name = `chunk:${cid}:lo`; for (const m of chunkLo.get(cid).build(mats, bake)) gl.add(m);
      gl.visible = false; zg.add(gh); zg.add(gl);
      chunks.set(cid, { hi: gh, lo: gl, center: chunkCenter(plan, cid) });
    }
    // the zone's LOD1 in one mesh: what a neighbouring zone shows of it (stairwells, window views)
    const far = new THREE.Group(); far.name = `zone:${zid}:far`; for (const m of zoneLo.build(mats, bake)) far.add(m); far.visible = false; zg.add(far);
    // glass panes of the zone (one transparent mesh)
    const glass = glassMesh(plan, rooms, mats.glass); if (glass) zg.add(glass);
    root.add(zg); groups.set(zid, zg);
    ctrl.zones.set(zid, { group: zg, chunks, far });
  }
  // door leaves: one instanced mesh per zone (animated by iv2interact.js through ctrl.setDoor)
  buildDoorLeaves(ctrl, mats, size);
  ctrl.frame = (II, dt) => frameV2(ctrl, II, dt);
  ctrl.setDoor = setDoor;
  ctrl.engNear = null;
  I.v2 = ctrl;
  return groups;
}
function chunkCenter(plan, cid) {
  const c = (plan.chunks || []).find((q) => q.id === cid); if (!c) return null;
  if (c.center) return c.center;
  let x = 0, y = 0, z = 0, n = 0;
  for (const rid of c.rooms) { const r = plan.rooms.find((q) => q.id === rid); if (!r) continue; x += (r.x0 + r.x1) / 2; y += r.y; z += (r.z0 + r.z1) / 2; n++; }
  return n ? { x: x / n, y: y / n, z: z / n } : null;
}
function doorFrame(G, a, d) {
  const ns = d.side === 'n' || d.side === 's', c = { n: a.z0, s: a.z1, w: a.x0, e: a.x1 }[d.side], y = a.y, h = d.h;
  const t = DOOR_TILE[d.kind] || 'wood_furn', fr = d.kind === 'watertight' ? 'paint_grey' : d.kind === 'ext' ? 'paint_white' : 'laminate';
  const F = ns ? frameOf(d.at, 0, c, 0) : frameOf(c, 0, d.at, Math.PI / 2);
  for (const sx of [-d.w / 2 - 0.035, d.w / 2 + 0.035]) box(G, F, fr, sx, y + h / 2, 0, 0.07, h, 0.16, { faces: 'tsnew' });
  box(G, F, fr, 0, y + h + 0.035, 0, d.w + 0.14, 0.07, 0.16, { faces: 'tbsn' });
  const sill = d.kind === 'watertight' ? 0.2 : d.kind === 'ext' ? 0.12 : 0.03;
  box(G, F, d.kind === 'watertight' ? 'hazard' : fr, 0, y + sill / 2, 0, d.w + 0.1, sill, 0.16, { faces: 'tsn' });
  void t;
}
function windowFrame(G, r, w) {
  const ns = w.side === 'n' || w.side === 's', c = { n: r.z0 + 0.05, s: r.z1 - 0.05, w: r.x0 + 0.05, e: r.x1 - 0.05 }[w.side];
  const F = ns ? frameOf((w.from + w.to) / 2, 0, c, 0) : frameOf(c, 0, (w.from + w.to) / 2, Math.PI / 2);
  const L = w.to - w.from, bot = r.y + w.bottom, top = r.y + w.top, fr = r.space === 'bridge' ? 'rubber_black' : 'metal_brushed';
  box(G, F, fr, 0, bot - 0.03, 0, L + 0.06, 0.06, 0.18, { faces: 'tsn' }); box(G, F, fr, 0, top + 0.03, 0, L + 0.06, 0.06, 0.14, { faces: 'bsn' });
  for (const sx of [-L / 2 - 0.02, L / 2 + 0.02]) box(G, F, fr, sx, (bot + top) / 2, 0, 0.04, top - bot, 0.14, { faces: 'snew' });
  if (r.space === 'bridge') { const n = Math.max(1, Math.round(L / 1.4)); for (let i = 1; i < n; i++) box(G, F, fr, -L / 2 + (L * i) / n, (bot + top) / 2, 0, 0.06, top - bot, 0.12, { faces: 'snew' }); }
}
function lightFitting(G, r, l) {
  const y = l.y ?? r.y + r.h - 0.02;
  if (l.kind === 'panel') G.quad('light', [l.x - 0.3, y - 0.01, l.z - 0.3], [l.x + 0.3, y - 0.01, l.z - 0.3], [l.x + 0.3, y - 0.01, l.z + 0.3], [l.x - 0.3, y - 0.01, l.z + 0.3], [0, -1, 0], 0, 0, 0.6, 0.6);
  else if (l.kind === 'strip') { const ax = l.axis === 'z' ? 0 : 1, len = l.len || 1.2; const F = frameOf(l.x, 0, l.z, ax ? 0 : Math.PI / 2); box(G, F, 'paint_white', 0, y - 0.05, 0, len, 0.08, 0.14, { faces: 'sn' }); box(G, F, 'light', 0, y - 0.095, 0, len - 0.08, 0.01, 0.08, { faces: 'b' }); }
  else if (l.kind === 'bulkhead' || l.kind === 'red') { const F = frameOf(l.x, 0, l.z, 0); box(G, F, l.kind === 'red' ? 'paint_red' : 'light', 0, (l.y ?? y) - 0.05, 0, 0.22, 0.1, 0.12, { faces: 'tbsnew' }); }
  else if (l.kind === 'flood') { const F = frameOf(l.x, 0, l.z, 0); box(G, F, 'light', 0, (l.y ?? y), 0, 0.3, 0.18, 0.18, { faces: 'tbsnew' }); }
}
function drawStair(G, s, style) {
  const { footZ, headZ, upDir, cx } = stairEnds(s);
  const rise = s.yHigh - s.yLow, run = s.z1 - s.z0, w = s.x1 - s.x0;
  const steel = s.kind === 'steep' || s.kind === 'outdoor' || style !== 'yacht';
  const n = Math.max(3, Math.round(rise / 0.2)), dz = (headZ - footZ) / n;
  for (let i = 0; i < n; i++) {
    const z = footZ + dz * (i + 0.5), y = s.yLow + (rise * (i + 1)) / n;
    const F = frameOf(cx, 0, z, 0);
    box(G, F, steel ? 'chequer' : 'wood', 0, y - 0.025, 0, w - 0.08, 0.05, Math.abs(dz) + 0.04, { faces: 'tbsn' });
    box(G, F, 'hazard', 0, y - 0.004, -Math.sign(dz) * (Math.abs(dz) / 2 - 0.02), w - 0.1, 0.012, 0.04, { faces: 't' });
    if (!steel) box(G, F, 'wood', 0, y - rise / n / 2, -Math.sign(dz) * Math.abs(dz) / 2, w - 0.08, rise / n, 0.02, { faces: 'sn' });
  }
  const len = Math.hypot(rise, run), ang = Math.atan2(rise, Math.abs(run)) * (s.up === 'n' ? 1 : -1);
  for (const x of [s.x0 + 0.025, s.x1 - 0.025]) { const F = frameOf(x, 0, (s.z0 + s.z1) / 2, 0); box(G, F, 'paint_grey', 0, (s.yLow + s.yHigh) / 2 - 0.06, 0, 0.05, 0.3, len, { rx: ang, faces: 'tbew' }); }
  for (const x of [s.x0 + 0.04, s.x1 - 0.04]) { rod(G, 'metal_brushed', [x, s.yLow + 0.95, footZ - upDir * 0.05], [x, s.yHigh + 0.95, headZ + upDir * 0.05], 0.022, 6); rod(G, 'metal_brushed', [x, s.yLow, footZ], [x, s.yLow + 0.95, footZ], 0.025, 5); rod(G, 'metal_brushed', [x, s.yHigh, headZ], [x, s.yHigh + 0.95, headZ], 0.025, 5); }
  // guard rail round the opening on the upper deck
  const y = s.yHigh;
  for (const x of [s.x0 - 0.02, s.x1 + 0.02]) rod(G, 'metal_brushed', [x, y + 1.0, headZ], [x, y + 1.0, footZ], 0.022, 6);
  rod(G, 'metal_brushed', [s.x0 - 0.02, y + 1.0, footZ], [s.x1 + 0.02, y + 1.0, footZ], 0.022, 6);
  for (const [x, z] of [[s.x0 - 0.02, footZ], [s.x1 + 0.02, footZ]]) rod(G, 'metal_brushed', [x, y, z], [x, y + 1.0, z], 0.02, 5);
}
function deckPoly(G, poly, deck, y) {
  const shape = new THREE.Shape(poly.map(([x, z]) => new THREE.Vector2(x, -z)));
  for (const h of deck.holes || []) { const p = new THREE.Path(); p.moveTo(h.x0, -h.z0); p.lineTo(h.x0, -h.z1); p.lineTo(h.x1, -h.z1); p.lineTo(h.x1, -h.z0); p.lineTo(h.x0, -h.z0); shape.holes.push(p); }
  const geo = new THREE.ShapeGeometry(shape, 6); geo.rotateX(-Math.PI / 2); geo.translate(0, y - 0.06, 0);
  G.geometry(geo, 'deck'); geo.dispose();
}
function drawRailV2(G, pts, y) {
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, z0] = pts[i], [x1, z1] = pts[i + 1], len = Math.hypot(x1 - x0, z1 - z0); if (len < 0.05) continue;
    rod(G, 'metal_brushed', [x0, y + 1.0, z0], [x1, y + 1.0, z1], 0.025, 5); rod(G, 'metal_brushed', [x0, y + 0.5, z0], [x1, y + 0.5, z1], 0.018, 4);
    const n = Math.max(1, Math.ceil(len / 1.5));
    for (let k = i === 0 ? 0 : 1; k <= n; k++) { const t = k / n; rod(G, 'metal_brushed', [x0 + (x1 - x0) * t, y, z0 + (z1 - z0) * t], [x0 + (x1 - x0) * t, y + 1.0, z0 + (z1 - z0) * t], 0.022, 4); }
  }
}
function glassMesh(plan, rooms, mat) {
  const pos = [];
  for (const r of rooms) for (const w of r.windows || []) {
    const ns = w.side === 'n' || w.side === 's', c = { n: r.z0 + 0.05, s: r.z1 - 0.05, w: r.x0 + 0.05, e: r.x1 - 0.05 }[w.side], b = r.y + w.bottom, t = r.y + w.top;
    const P = (u, y) => (ns ? [u, y, c] : [c, y, u]);
    for (const q of [P(w.from, b), P(w.to, b), P(w.to, t), P(w.from, b), P(w.to, t), P(w.from, t)]) pos.push(...q);
  }
  if (!pos.length) return null;
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3)); g.computeVertexNormals();
  const m = new THREE.Mesh(g, mat); m.name = 'iv2:glass'; m.renderOrder = 2; m.userData.tris = pos.length / 9; return m;
}
function buildDoorLeaves(ctrl, mats, size) {
  const byZone = new Map();
  for (const dd of ctrl.doors) { if (!byZone.has(dd.zone)) byZone.set(dd.zone, []); byZone.get(dd.zone).push(dd); }
  for (const [zid, list] of byZone) {
    const z = ctrl.zones.get(zid); if (!z) continue;
    const g = new THREE.BoxGeometry(1, 1, 1);
    const tile = new Float32Array(24 * 4), light = new Float32Array(24 * 4);
    const t = tileRect(tileOf('wood_furn'), size);
    for (let k = 0; k < 24; k++) { tile.set(t, k * 4); light.set([0.75, 0.3, 0.2, 0.5], k * 4); }
    g.setAttribute('aTile', new THREE.BufferAttribute(tile, 4)); g.setAttribute('aLight', new THREE.BufferAttribute(light, 4)); g.setAttribute('aKind', new THREE.BufferAttribute(new Float32Array(24), 1));
    const im = new THREE.InstancedMesh(g, mats.solid, list.length); im.name = 'iv2:doors'; im.userData.tris = 12 * list.length;
    list.forEach((dd, i) => { dd.mesh = im; dd.i = i; setDoor(dd, 0); });
    im.instanceMatrix.needsUpdate = true;
    z.group.add(im);
  }
}
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _s = new THREE.Vector3(), _e = new THREE.Euler();
/** Door leaf state t ∈ [0, 1] (0 closed in the frame, 1 swung 90° into room a). */
export function setDoor(dd, t) {
  const { d, a } = dd, ns = d.side === 'n' || d.side === 's', c = { n: a.z0, s: a.z1, w: a.x0, e: a.x1 }[d.side], inward = { n: 1, s: -1, w: 1, e: -1 }[d.side];
  const lw = d.w - 0.06, h = d.h - 0.05, ang = t * Math.PI / 2 * (d.kind === 'watertight' ? 0 : 1);
  if (d.kind === 'watertight') { // sliding: moves along the wall
    const off = t * lw;
    if (ns) { _v.set(d.at + off, a.y + h / 2, c); _s.set(lw, h, 0.06); } else { _v.set(c, a.y + h / 2, d.at + off); _s.set(0.06, h, lw); }
    _m.compose(_v, _q.identity(), _s);
  } else {
    // hinge at the "from" jamb; the leaf's centre swings round it
    const hx = ns ? d.at - d.w / 2 : c, hz = ns ? c : d.at - d.w / 2;
    const dirClosed = ns ? [1, 0] : [0, 1], dirOpen = ns ? [0, inward] : [inward, 0];
    const ux = dirClosed[0] * Math.cos(ang) + dirOpen[0] * Math.sin(ang), uz = dirClosed[1] * Math.cos(ang) + dirOpen[1] * Math.sin(ang);
    _v.set(hx + ux * lw / 2, a.y + h / 2, hz + uz * lw / 2);
    _q.setFromEuler(_e.set(0, Math.atan2(-uz, ux), 0));
    _m.compose(_v, _q, _s.set(lw, h, 0.05));
  }
  dd.mesh.setMatrixAt(dd.i, _m); dd.t = t; dd.mesh.instanceMatrix.needsUpdate = true;
}

// ------------------------------------------------------------------------------------------------ per frame
function frameV2(ctrl, I, dt) {
  const pos = I.pos, y = I.y, room = I.map?.roomAt(pos.x, pos.z, y);
  const cur = room ? ctrl.chunkOfRoom.get(room.id) : null;
  const zid = room?.zone || null;
  // detail chunks: the walker's and the ones close by (phones: ≤ 2 hi; desktop: ≤ 10 within 15 m)
  const maxHi = ctrl.phone ? 1 : 10, range = ctrl.phone ? 8 : 15;
  for (const [id, z] of ctrl.zones) {
    if (!z.group.visible) continue;
    if (id !== zid) {   // a neighbouring zone: its LOD1 in one draw call (desktop), shell only on phones
      for (const c of z.chunks.values()) { c.hi.visible = false; c.lo.visible = false; }
      if (z.far) z.far.visible = !ctrl.phone;
      continue;
    }
    if (z.far) z.far.visible = false;
    const list = [];
    for (const [cid, c] of z.chunks) { const d = c.center ? Math.hypot(c.center.x - pos.x, (c.center.y - y) * 4, c.center.z - pos.z) : 999; list.push([cid, c, cid === cur ? -1 : d]); }
    list.sort((a, b) => a[2] - b[2]);
    let n = 0;
    for (const [cid, c, d] of list) { const hi = cid === cur || (d < range && n < maxHi); if (hi) n++; c.hi.visible = hi; c.lo.visible = !hi && d < range * 2; }
  }
  // window views: the zones the room looks onto show their shell (and LOD1 on desktop)
  const views = room ? ctrl.views.get(room.id) : null;
  if (views) for (const v of views) { const z = ctrl.zones.get(v); if (z && !z.group.visible) { z.group.visible = true; for (const c of z.chunks.values()) { c.hi.visible = false; c.lo.visible = false; } if (z.far) z.far.visible = !ctrl.phone; } }
  // light mode
  const app = I.app || {};
  const you = app.you || {};
  const blackout = (you.cond != null && you.cond < 10) || (you.fuelEmpty && !you.docked) || you.sinking || you.rescue;
  const dayK = app.dayK ?? 1, gloomK = app.gloomK ?? 0;
  const mode = blackout || ctrl.drill ? 'emergency' : dayK < 0.25 ? 'night' : 'day';
  const m = lightMode(mode, { dayK, gloomK });
  const U = ctrl.U, k = Math.min(1, dt * 3);
  for (const key of ['uLights', 'uNight', 'uDay', 'uEmerg', 'uAmb', 'uScreen']) U[key].value += (m[key] - U[key].value) * k;
  ctrl.mode = mode;
  // wipers (rain)
  const rain = Number(app.wx?.rain) || 0;
  if (rain > 0.05 && ctrl.wipers.length) ctrl.wiperT = (ctrl.wiperT || 0) + dt;
}
export const _iv2draw = { FAC, box, cyl, rod, frameOf, wallFace, legacyAdapter };
