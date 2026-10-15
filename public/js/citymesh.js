// City mesh builder — pure (no three.js, no DOM): the world-tile module worker (wtworker.js) and the Node tests
// (test/citymesh.test.mjs) import it. From ONE decoded D14 tile it builds, in the tile frame of wtmesh.js:
//   * buildings: every footprint of the tile (largest first, capped by the LOD), walls to the eave with a facade
//     coordinate per vertex (fac = metres along the wall, metres above the ground, wall height) and a style code
//     (sty = facade style, per-building seed) that the facade shader in cityscape.js turns into windows / doors / lit
//     windows at night; flat roofs triangulated, gabled / hipped roofs on compact footprints (cityrules.js decides).
//     One merged geometry per tile = one draw call for thousands of buildings.
//   * trees: instance records [x, y, z, height, kind, shade] scattered by land class (wood dense, parks / gardens sparse).
//   * containers: instance records [x, y, z, yaw, colour, 0] — 40' boxes stacked 1–5 high in blocks behind the tagged
//     ship-to-shore cranes, rows parallel to the quay.
// Footprints of a harbour patch's own buildings (opts.exclude) are skipped so the patch scenery never draws twice.
import { WT, decodeWTHeight } from '../../shared/wtformat.js';
import { tileFrame, frameXZ, frameLat, ringArea, triangulate, areaClassGrid, AREA_CLASS, K_LON } from './wtmesh.js';
import { STYLE, ROOF, buildingFromTile, buildingColours, cityLod, hash01, TREE_DENSITY, treeKind } from './cityrules.js';

const M = WT.MASK;
const H_LUT = new Float32Array(256);
for (let v = 0; v < 256; v++) H_LUT[v] = decodeWTHeight(v);
const CLASS_NAME = ['plain'];
for (const [k, c] of Object.entries(AREA_CLASS)) CLASS_NAME[c] = k;
export const CONTAINER = { L: 12.19, W: 2.44, H: 2.59 };
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Growable buffers: position, normal (int8), colour (uint8), facade coords (float ×3), style (uint8 ×2). */
class CBuf {
  constructor(n = 4096) { this.alloc(n); this.v = 0; this.i = 0; this.idx = new Uint32Array(n * 2); }
  alloc(n) {
    const o = this.pos ? { pos: this.pos, nrm: this.nrm, col: this.col, fac: this.fac, sty: this.sty } : null;
    this.pos = new Float32Array(n * 3); this.nrm = new Int8Array(n * 3); this.col = new Uint8Array(n * 3); this.fac = new Float32Array(n * 3); this.sty = new Uint8Array(n * 2);
    if (o) { this.pos.set(o.pos); this.nrm.set(o.nrm); this.col.set(o.col); this.fac.set(o.fac); this.sty.set(o.sty); }
  }
  growV(k) { if (this.v + k > this.pos.length / 3) this.alloc(Math.max(this.v + k, (this.pos.length / 3) * 2)); }
  growI(k) { if (this.i + k > this.idx.length) { const a = new Uint32Array(Math.max(this.i + k, this.idx.length * 2)); a.set(this.idx); this.idx = a; } }
  vert(x, y, z, n, c, fu, fv, fh, s0, s1) {
    const k = this.v * 3;
    this.pos[k] = x; this.pos[k + 1] = y; this.pos[k + 2] = z;
    this.nrm[k] = Math.round(n[0] * 127); this.nrm[k + 1] = Math.round(n[1] * 127); this.nrm[k + 2] = Math.round(n[2] * 127);
    this.col[k] = clamp(Math.round(c[0] * 255), 0, 255); this.col[k + 1] = clamp(Math.round(c[1] * 255), 0, 255); this.col[k + 2] = clamp(Math.round(c[2] * 255), 0, 255);
    this.fac[k] = fu; this.fac[k + 1] = fv; this.fac[k + 2] = fh;
    this.sty[this.v * 2] = s0; this.sty[this.v * 2 + 1] = s1;
    return this.v++;
  }
  /** triangle wound so its geometric normal agrees with n */
  tri(a, b, c, n) {
    const P = this.pos, A = a * 3, B = b * 3, C = c * 3;
    const ux = P[B] - P[A], uy = P[B + 1] - P[A + 1], uz = P[B + 2] - P[A + 2], vx = P[C] - P[A], vy = P[C + 1] - P[A + 1], vz = P[C + 2] - P[A + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    this.growI(3);
    if (cx * n[0] + cy * n[1] + cz * n[2] >= 0) { this.idx[this.i++] = a; this.idx[this.i++] = b; this.idx[this.i++] = c; } else { this.idx[this.i++] = a; this.idx[this.i++] = c; this.idx[this.i++] = b; }
  }
  out() {
    return { pos: this.pos.slice(0, this.v * 3), nrm: this.nrm.slice(0, this.v * 3), col: this.col.slice(0, this.v * 3), fac: this.fac.slice(0, this.v * 3), sty: this.sty.slice(0, this.v * 2), idx: this.idx.slice(0, this.i), verts: this.v, tris: this.i / 3 };
  }
}
/** unit normal of triangle (p, q, r), flipped to agree with the hint */
function faceNormal(p, q, r, hint) {
  const ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2], vx = r[0] - p[0], vy = r[1] - p[1], vz = r[2] - p[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
  if (nx * hint[0] + ny * hint[1] + nz * hint[2] < 0) { nx = -nx; ny = -ny; nz = -nz; }
  return [nx, ny, nz];
}

/**
 * Oriented bounding box of a ring (metres, flat [x, z, …]) along its longest edge: { cx, cz, lx, lz (unit, the long
 * axis), hl, hw (half sizes), fill (ring area / box area) }.
 */
export function orientedBox(P) {
  const m = P.length >> 1; if (m < 3) return null;
  let best = -1, dx = 1, dz = 0;
  for (let i = 0; i < m; i++) { const j = (i + 1) % m, ex = P[j * 2] - P[i * 2], ez = P[j * 2 + 1] - P[i * 2 + 1], l = Math.hypot(ex, ez); if (l > best) { best = l; dx = ex / l; dz = ez / l; } }
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (let i = 0; i < m; i++) { const x = P[i * 2], z = P[i * 2 + 1], a = x * dx + z * dz, b = -x * dz + z * dx; if (a < a0) a0 = a; if (a > a1) a1 = a; if (b < b0) b0 = b; if (b > b1) b1 = b; }
  let ca = (a0 + a1) / 2, cb = (b0 + b1) / 2, hl = (a1 - a0) / 2, hw = (b1 - b0) / 2, lx = dx, lz = dz;
  const cx = ca * dx - cb * dz, cz = ca * dz + cb * dx;
  if (hw > hl) { const t = hl; hl = hw; hw = t; lx = -dz; lz = dx; }
  const box = 4 * hl * hw;
  return { cx, cz, lx, lz, hl, hw, fill: box > 0 ? Math.abs(ringArea(P)) / box : 0 };
}

/** Packed exclusion rings ([count, m, x0, y0, …] in tile fractions) → [{ r, x0, x1, y0, y1, cx, cy }]. */
export function unpackExclude(flat) {
  const out = []; if (!flat || !flat.length) return out;
  let o = 1;
  for (let k = 0; k < flat[0] && o < flat.length; k++) {
    const m = flat[o++]; const r = new Float64Array(m * 2);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, cx = 0, cy = 0;
    for (let i = 0; i < m * 2; i += 2) { const x = flat[o + i], y = flat[o + i + 1]; r[i] = x; r[i + 1] = y; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; cx += x; cy += y; }
    o += m * 2;
    out.push({ r, x0, x1, y0, y1, cx: cx / m, cy: cy / m });
  }
  return out;
}
/** Pack rings of tile fractions (arrays of [fx, fy, …]) for unpackExclude (structured-clone friendly Float64Array). */
export function packExclude(rings) {
  let n = 1; for (const r of rings) n += 1 + r.length;
  const a = new Float64Array(n); a[0] = rings.length; let o = 1;
  for (const r of rings) { a[o++] = r.length >> 1; a.set(r, o); o += r.length; }
  return a;
}
function inRing(r, x, y) { let c = false; for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) { const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; }

/**
 * Buildings, trees and container stacks of a decoded D14 tile. opts: { frame, want ('near'|'mid'|'far'), mobile,
 * lod (cityLod override), exclude (packExclude rings, tile fractions) }.
 * Returns { pos, nrm, col, fac, sty, idx, verts, tris, counts, inst: { trees: Float32Array(6·k), boxes: Float32Array(6·k) } }.
 */
export function buildCity(tile, opts = {}) {
  const f = opts.frame || tileFrame(tile.z, tile.x, tile.y);
  const L = opts.lod || cityLod(opts.want || 'near', !!opts.mobile);
  const v = tile.vectors || {};
  const n = tile.n || WT.N, sz10 = f.sizeM * 10, cellM = f.sizeM / n;
  const latC = frameLat(f, 0.5);
  const B = new CBuf(8192);
  const counts = { buildings: 0, skipped: 0, excluded: 0, pitched: 0, trees: 0, containers: 0 };
  const tmp = [0, 0];
  const XZ = (fx, fy) => { frameXZ(f, fx, fy, tmp); return [tmp[0], tmp[1]]; };
  const cellIdx = (fx, fy) => clamp(Math.floor(fy * n), 0, n - 1) * n + clamp(Math.floor(fx * n), 0, n - 1);
  const hAt = (fx, fy) => (tile.mask ? H_LUT[tile.height[cellIdx(fx, fy)]] : tile.uniformH || 0);
  const mAt = (fx, fy) => (tile.mask ? tile.mask[cellIdx(fx, fy)] : (tile.flags & WT.FLAG.UNIFORM_LAND ? M.LAND : M.WATER));
  const own = (fx, fy) => fx >= 0 && fx < 1 && fy >= 0 && fy < 1;
  const ex = unpackExclude(opts.exclude);

  // ---------------------------------------------------------------- buildings
  const list = [];
  for (const b of v.buildings || []) { if (b?.r && b.r.length >= 6) list.push({ b, a: Math.abs(ringArea(b.r)) / 100 }); }
  list.sort((p, q) => q.a - p.a);
  const UP = [0, 1, 0];
  for (const { b, a } of list) {
    if (counts.buildings >= L.maxBuildings || B.v >= L.maxVerts) { counts.skipped++; continue; }
    const m = b.r.length >> 1;
    let cx = 0, cy = 0; for (let i = 0; i < b.r.length; i += 2) { cx += b.r[i]; cy += b.r[i + 1]; }
    cx /= m * sz10; cy /= m * sz10;
    if (!own(cx, cy) || a < 6) continue;
    const seed = (Math.round(b.r[0]) * 7 + Math.round(b.r[1]) * 13) | 0;
    const spec = buildingFromTile(b, a, seed, latC);
    if (spec.height < L.minH) { counts.skipped++; continue; }
    if (ex.length && excluded(ex, b.r, sz10, cx, cy)) { counts.excluded++; continue; }
    // footprint in metres (closing duplicate dropped)
    let P = [];
    for (let i = 0; i < m; i++) { const p = XZ(b.r[i * 2] / sz10, b.r[i * 2 + 1] / sz10); P.push(p[0], p[1]); }
    if (P.length >= 6 && Math.abs(P[0] - P[P.length - 2]) < 0.05 && Math.abs(P[1] - P[P.length - 1]) < 0.05) P = P.slice(0, -2);
    const k = P.length >> 1; if (k < 3) continue;
    const A = ringArea(P); if (Math.abs(A) < 4) continue;
    // ground: the lowest obstacle cell under the corners / centroid (walls run 5 m into the ground below it, so a
    // building also stands on a harbour patch whose ground differs a little from the tile's)
    let g = Infinity;
    for (let i = 0; i < b.r.length; i += 2) { const fx = b.r[i] / sz10, fy = b.r[i + 1] / sz10, mm = mAt(fx, fy); if (mm !== M.WATER && mm !== M.DOCK && mm !== M.RIVER && mm !== M.FAIRWAY) g = Math.min(g, hAt(fx, fy)); }
    if (!Number.isFinite(g)) g = Math.max(0.5, hAt(cx, cy));
    const base = g - 0.2;
    const eave = base + spec.eave, top = base + spec.height;
    const bot = spec.minHeight > 0.5 ? base + spec.minHeight : base - 5;
    const col = buildingColours(spec.style, spec.roof, seed, latC);
    const sty0 = L.facades ? spec.style : 0, sty1 = (seed >>> 3) & 255;
    const wallH = eave - base;
    const sgn = A > 0 ? 1 : -1;
    const wallTop = col.wall, wallBot = col.wall.map((c) => c * 0.82);
    // walls
    let u = 0;
    B.growV(k * 4);
    for (let i = 0; i < k; i++) {
      const j = (i + 1) % k, ax = P[i * 2], az = P[i * 2 + 1], bx = P[j * 2], bz = P[j * 2 + 1];
      const dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz); if (l < 0.05) continue;
      const nn = [(sgn * dz) / l, 0, (-sgn * dx) / l];
      const s1 = sty1;
      const v0 = B.vert(ax, eave, az, nn, wallTop, u, wallH, wallH, sty0, s1), v1 = B.vert(bx, eave, bz, nn, wallTop, u + l, wallH, wallH, sty0, s1);
      const v2 = B.vert(bx, bot, bz, nn, wallBot, u + l, bot - base, wallH, sty0, s1), v3 = B.vert(ax, bot, az, nn, wallBot, u, bot - base, wallH, sty0, s1);
      B.tri(v0, v1, v2, nn); B.tri(v0, v2, v3, nn);
      u += l;
    }
    // roof
    let pitched = false;
    if (spec.roof !== ROOF.FLAT && L.roofs && k <= 12 && spec.roofH > 0.5) {
      const ob = orientedBox(P);
      if (ob && ob.fill > 0.72 && ob.hw > 1.5) { pitched = addPitchedRoof(B, ob, eave, top, spec.roof, col, wallH); if (pitched) counts.pitched++; }
    }
    if (!pitched) {
      const tris = triangulate(P);
      B.growV(k);
      const base0 = B.v;
      for (let i = 0; i < k; i++) B.vert(P[i * 2], eave, P[i * 2 + 1], UP, col.roof, 0, 0, wallH, 0, sty1);
      for (let t = 0; t < tris.length; t += 3) B.tri(base0 + tris[t], base0 + tris[t + 1], base0 + tris[t + 2], UP);
      // parapet edge on tall flat roofs: a thin darker rim reads as a cornice from the sea
      if (wallH > 9 && k <= 24) {
        const rim = col.wall.map((c) => c * 0.7);
        for (let i = 0; i < k; i++) {
          const j = (i + 1) % k, ax = P[i * 2], az = P[i * 2 + 1], bx = P[j * 2], bz = P[j * 2 + 1];
          const dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz); if (l < 0.5) continue;
          const nn = [(sgn * dz) / l, 0, (-sgn * dx) / l];
          B.growV(4);
          const a0 = B.vert(ax, eave + 0.9, az, nn, rim, 0, 0, 0, 0, sty1), a1 = B.vert(bx, eave + 0.9, bz, nn, rim, 0, 0, 0, 0, sty1);
          const a2 = B.vert(bx, eave - 0.05, bz, nn, rim, 0, 0, 0, 0, sty1), a3 = B.vert(ax, eave - 0.05, az, nn, rim, 0, 0, 0, 0, sty1);
          B.tri(a0, a1, a2, nn); B.tri(a0, a2, a3, nn);
        }
      }
    }
    counts.buildings++;
  }
  const out = B.out();

  // ---------------------------------------------------------------- trees
  const trees = [];
  if (L.trees > 0 && tile.mask) {
    const cls = areaClassGrid(tile);
    const cellA = cellM * cellM;
    // expected count first: thin out evenly when over the cap
    let expected = 0;
    for (let c = 0; c < n * n; c++) if (tile.mask[c] === M.LAND) expected += (TREE_DENSITY[CLASS_NAME[cls ? cls[c] : 0]] || 0) * cellA / 100;
    const thin = expected > L.trees ? L.trees / expected : 1;
    const seed = (tile.x * 92821 + tile.y * 68917) | 0;
    for (let j = 1; j < n - 1 && trees.length / 6 < L.trees; j++) {
      for (let i = 1; i < n - 1; i++) {
        const c = j * n + i; if (tile.mask[c] !== M.LAND) continue;
        const name = CLASS_NAME[cls ? cls[c] : 0];
        const d = (TREE_DENSITY[name] || 0) * cellA / 100 * thin; if (d <= 0) continue;
        const r = hash01(seed + i * 7919, j * 104729 + 17);
        let cnt = Math.floor(d + r); if (!cnt) continue;
        // keep off buildings, quays and the water's edge (gardens and parks only touch them at a distance)
        let blocked = false;
        for (const o of [-1, 1, -n, n]) { const mm = tile.mask[c + o]; if (mm === M.BUILDING || mm === M.QUAY || (name !== 'wood' && mm !== M.LAND)) { blocked = true; break; } }
        if (blocked) continue;
        cnt = Math.min(cnt, 3);
        for (let t = 0; t < cnt && trees.length / 6 < L.trees; t++) {
          const r1 = hash01(seed + i * 31 + t * 7, j * 57 + t), r2 = hash01(seed + j * 29 + t * 3, i * 61 + t * 11), r3 = hash01(i * 13 + t, j * 17 + seed);
          const fx = (i + 0.15 + 0.7 * r1) / n, fy = (j + 0.15 + 0.7 * r2) / n;
          const p = XZ(fx, fy);
          const kind = treeKind(latC, name, r3);
          const h = kind === 2 ? 8 + r1 * 7 : name === 'wood' ? 11 + r2 * 12 : 6 + r2 * 9;
          trees.push(p[0], H_LUT[tile.height[c]] - 0.4, p[1], h, kind, r3);
        }
      }
    }
    counts.trees = trees.length / 6;
  }

  // ---------------------------------------------------------------- container stacks behind STS cranes
  const boxes = [];
  const sts = (v.cranes || []).filter((c) => c && c.k === 'sts' && own(c.x / sz10, c.z / sz10));
  if (L.containers > 0 && sts.length && tile.mask) {
    const cls = areaClassGrid(tile);
    const hasPort = !!cls && cls.some((c) => c === AREA_CLASS.port);
    // clusters of cranes along one quay (≤ 350 m apart, similar heading)
    const pts = sts.map((c) => { const p = XZ(c.x / sz10, c.z / sz10); return { x: p[0], z: p[1], h: (Number(c.hdg) || 0) * Math.PI / 180, used: false }; });
    const clusters = [];
    for (const c of pts) {
      if (c.used) continue;
      const cl = [c]; c.used = true;
      for (const o of pts) if (!o.used && Math.hypot(o.x - c.x, o.z - c.z) < 350 && Math.cos(o.h - c.h) > 0.8) { o.used = true; cl.push(o); }
      clusters.push(cl);
    }
    const toF = (x, z) => {
      // metres → tile fractions (inverse of frameXZ, one Newton-free step: z gives the row, the row's width gives x)
      const fy = clamp(z / f.h, 0, 0.99999); const lat = frameLat(f, fy);
      return [x / (f.dlon * K_LON * Math.cos(lat * Math.PI / 180)), fy];
    };
    const PAL = 8;
    for (const cl of clusters) {
      if (boxes.length / 6 >= L.containers) break;
      let sx = 0, sz = 0, hs = 0, hc = 0;
      for (const c of cl) { sx += c.x; sz += c.z; hs += Math.sin(c.h); hc += Math.cos(c.h); }
      const cx0 = sx / cl.length, cz0 = sz / cl.length, h = Math.atan2(hs, hc);
      const bx = Math.sin(h), bz = -Math.cos(h);        // boom: towards the water
      const qx = Math.cos(h), qz = Math.sin(h);         // along the quay
      let s0 = Infinity, s1 = -Infinity;
      for (const c of cl) { const s = (c.x - cx0) * qx + (c.z - cz0) * qz; if (s < s0) s0 = s; if (s > s1) s1 = s; }
      s0 -= 140; s1 += 140;
      const SLOT = 12.8, ROW = 2.9, BLOCK_S = 8, ROAD_S = 18, BLOCK_T = 7, LANE_T = 24;
      const full = () => boxes.length / 6 >= L.containers;
      for (let row = 0; !full(); row++) {
        const bt = Math.floor(row / BLOCK_T), t = 50 + bt * (BLOCK_T * ROW + LANE_T) + (row % BLOCK_T) * ROW;
        if (t >= 650) break;
        const blockSeed = bt * 131;
        for (let slot = 0; !full(); slot++) {
          const bs = Math.floor(slot / BLOCK_S), s = s0 + bs * (BLOCK_S * SLOT + ROAD_S) + (slot % BLOCK_S) * SLOT;
          if (s > s1) break;
          const x = cx0 + s * qx - t * bx, z = cz0 + s * qz - t * bz;
          // the slot and both ends must be dry yard (not a building, not water; port land when the tile has some)
          let ok = true, gy = -Infinity;
          for (const e of [-5.5, 0, 5.5]) {
            const ff = toF(x + e * qx, z + e * qz);
            if (!own(ff[0], ff[1])) { ok = false; break; }
            const mm = mAt(ff[0], ff[1]);
            if (mm !== M.LAND && mm !== M.QUAY) { ok = false; break; }
            if (hasPort && cls[cellIdx(ff[0], ff[1])] !== AREA_CLASS.port) { ok = false; break; }
            gy = Math.max(gy, hAt(ff[0], ff[1]));
          }
          if (!ok) continue;
          const r = hash01(blockSeed + slot * 17, row * 31 + 7);
          if (r < 0.07) continue;                                        // an empty slot here and there
          const tiers = clamp(1 + Math.floor(hash01(blockSeed, bs * 13) * 3) + Math.floor(r * 2.2), 1, 5);
          for (let k = 0; k < tiers && !full(); k++) {
            const cc = Math.floor(hash01(slot * 7 + k * 101 + row * 13, blockSeed + k) * PAL);
            boxes.push(x, gy + k * CONTAINER.H, z, h, cc, 0);
          }
        }
      }
    }
    counts.containers = boxes.length / 6;
  }
  return { ...out, counts, inst: { trees: Float32Array.from(trees), boxes: Float32Array.from(boxes) } };
}

/** A tile building (ring in decimetres) is one of the patch's own buildings: centroid inside one, or one inside it. */
function excluded(ex, rdm, sz10, cx, cy) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < rdm.length; i += 2) { const x = rdm[i] / sz10, y = rdm[i + 1] / sz10; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  let fr = null;
  for (const e of ex) {
    if (e.x1 < x0 || e.x0 > x1 || e.y1 < y0 || e.y0 > y1) continue;
    if (cx >= e.x0 && cx <= e.x1 && cy >= e.y0 && cy <= e.y1 && inRing(e.r, cx, cy)) return true;
    if (e.cx >= x0 && e.cx <= x1 && e.cy >= y0 && e.cy <= y1) {
      if (!fr) { fr = new Float64Array(rdm.length); for (let i = 0; i < rdm.length; i++) fr[i] = rdm[i] / sz10; }
      if (inRing(fr, e.cx, e.cy)) return true;
    }
  }
  return false;
}

/** Gabled / hipped / pyramid roof over an oriented box (0.35 m eaves overhang). Returns true when built. */
function addPitchedRoof(B, ob, eave, top, roof, col, wallH) {
  const o = 0.35, hl = ob.hl + o, hw = ob.hw + o, rise = top - eave;
  if (rise <= 0.3) return false;
  const lx = ob.lx, lz = ob.lz, wx = -lz, wz = lx;
  const C = (sl, sw) => [ob.cx + sl * hl * lx + sw * hw * wx, eave, ob.cz + sl * hl * lz + sw * hw * wz];
  const hip = roof === ROOF.HIP || roof === ROOF.PYRAMID;
  const inset = roof === ROOF.PYRAMID ? hl : hip ? Math.min(hw, hl * 0.9) : 0;
  const R = (sl) => [ob.cx + sl * (hl - inset) * lx, top, ob.cz + sl * (hl - inset) * lz];
  const a = C(-1, -1), b = C(1, -1), c = C(1, 1), d = C(-1, 1), r0 = R(-1), r1 = R(1);
  const rc = col.roof, rcD = col.roof.map((x) => x * 0.86);
  B.growV(14);
  const add = (pts, hint, colour, wall) => {
    const nn = faceNormal(pts[0], pts[1], pts[2], hint);
    const ids = pts.map((p) => B.vert(p[0], p[1], p[2], nn, colour, 0, wall ? p[1] - eave + wallH : 0, wallH, 0, 0));
    for (let i = 1; i + 1 < ids.length; i++) B.tri(ids[0], ids[i], ids[i + 1], nn);
  };
  // the two long slopes (a darker one: sun-side contrast without a texture)
  add([a, b, r1, r0], [-wx, 1, -wz], rc, false);
  add([d, c, r1, r0], [wx, 1, wz], rcD, false);
  // the ends: hips (roof) or gables (wall)
  if (hip) { add([a, d, r0], [-lx, 1, -lz], rc, false); add([b, c, r1], [lx, 1, lz], rcD, false); }
  else { add([a, d, r0], [-lx, 0, -lz], col.wall, true); add([b, c, r1], [lx, 0, lz], col.wall, true); }
  return true;
}
