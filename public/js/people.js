// People (docs/V4-CONTRACTS.md §3, NOTES-people.md): ONE procedural human for every person in Saltline — the walking
// captain (interior.js, ashore.js), the cruise ship's guests and crew (iv2crowd.js), pedestrians ashore (avatar.js
// Crowd), deck crew on ships (ship.js) and boarders (hostile.js via makeBoarder).
//
//   body       lofted tubes per segment (torso, arms, legs, neck), an ellipsoid head with brow / nose / chin / ears, a
//              hair shell, hands with a thumb, shoes; LOD0 ≈ 1.8k triangles, LOD1 ≈ 0.5k, LOD2 ≈ 0.15k. Faces +z, feet at
//              y = 0, 1.76 m tall (instances scale it).
//   skeleton   19 bones (hips spine chest neck head, shoulder / upperArm / forearm / hand ×2, thigh / shin / foot ×2) plus
//              a crowd-only `prop` bone on the right hand (the waiter's tray; scaled to zero in every other clip).
//   poses      procedural functions of a phase 0…1 → Euler angles per bone: idle, walk, run, sit, clap, dance, lie,
//              swim, tray, wave, hold.
//   crowds     NOT skinned on the GPU: the clips are baked on the CPU into a vertex animation texture (VAT, RGBA half
//              float; row 2f = positions of frame f, row 2f+1 = normals; the last column is the head pivot) and ONE
//              InstancedMesh per LOD draws everyone (per instance: frames + blend, head turn, atlas tiles, colours).
//   captain    a real THREE.SkinnedMesh (LOD0) with gait blending, idle breathing and the head looking where the camera
//              looks (userData.look).
//   clothing   one 8 × 8 atlas (scripts/people-atlas.py on the VPS → /assets/lib/people/albedo{,_512}.ktx2 through
//              texlib.js): faces per skin tone, hair and hats, tops, uniforms, bottoms, shoes. "tint" tiles are neutral
//              grey and multiplied by a per-person colour; "true" tiles are drawn in colour. Until the atlas arrives an
//              8 × 8 texture of each tile's mean colour stands in (same UVs, so nothing else changes).
// Phone-safe GLSL (Adreno): no uniform arrays, no loops over uniforms, no inout / out parameters, no discard, no
// alphaTest — clothing is opaque.
import * as THREE from 'three';
import { loadKTX2Texture, currentTier } from './texlib.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const spow = (v, e) => Math.sign(v) * Math.pow(Math.abs(v), e);
const TAU = Math.PI * 2;

// ------------------------------------------------------------------------------------------------ skeleton
export const BONES = ['hips', 'spine', 'chest', 'neck', 'head', 'shoulderL', 'upperArmL', 'forearmL', 'handL', 'shoulderR', 'upperArmR', 'forearmR', 'handR',
  'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR', 'prop'];
export const BONE = Object.freeze(Object.fromEntries(BONES.map((n, i) => [n, i])));
/** bones of the real skeleton (the prop bone is crowd-only) */
export const SKELETON_BONES = 19;
export const PARENT = Object.freeze([-1, 0, 1, 2, 3, 2, 5, 6, 7, 2, 9, 10, 11, 0, 13, 14, 0, 16, 17, 12]);
/** rest joint positions (m) of a 1.76 m adult facing +z (its left is +x) */
const L_ = (x, y, z) => [[x, y, z], [-x, y, z]];
const [shL, shR] = L_(0.03, 1.43, -0.02), [uaL, uaR] = L_(0.175, 1.42, -0.03), [faL, faR] = L_(0.2, 1.135, -0.045), [haL, haR] = L_(0.215, 0.885, -0.03);
const [thL, thR] = L_(0.095, 0.92, 0), [snL, snR] = L_(0.1, 0.5, 0.005), [ftL, ftR] = L_(0.1, 0.085, -0.03);
export const REST = Object.freeze([[0, 0.97, 0], [0, 1.07, -0.01], [0, 1.25, -0.01], [0, 1.47, -0.02], [0, 1.56, 0], shL, uaL, faL, haL, shR, uaR, faR, haR, thL, snL, ftL, thR, snR, ftR, haR]);
export const HEIGHT = 1.76;

// ------------------------------------------------------------------------------------------------ the clothing atlas
export const ATLAS_GRID = 8;
/** [name, kind ('true' | 'tint'), mean colour (sRGB, measured by scripts/people-atlas.py) — the stand-in until the atlas loads] in atlas order (row-major, row 0 = top) */
export const TILES = Object.freeze([
  ['face_m0', 'true', 0xd5b192], ['face_m1', 'true', 0xc69f7f], ['face_m2', 'true', 0xaf7e58], ['face_m3', 'true', 0x895b39], ['face_m4', 'true', 0x623e25], ['face_m5', 'true', 0xd9bda6], ['face_m6', 'true', 0xc0936c], ['face_m7', 'true', 0x7b5034],
  ['face_f0', 'true', 0xd6b293], ['face_f1', 'true', 0xc7a07f], ['face_f2', 'true', 0xb07e58], ['face_f3', 'true', 0x895b39], ['face_f4', 'true', 0x623e25], ['face_f5', 'true', 0xdabea7], ['face_f6', 'true', 0xc1946d], ['face_f7', 'true', 0x7b5034],
  ['hair_short', 'tint', 0x9c9c9c], ['hair_side', 'tint', 0x9d9d9d], ['hair_curly', 'tint', 0x8f8f8f], ['hair_long', 'tint', 0x949494], ['hair_bun', 'tint', 0x9c9c9c],
  ['hat_hard_yellow', 'true', 0xa78c17], ['hat_hard_white', 'true', 0xabaaa6], ['hat_officer', 'true', 0x61646a], ['hat_bandana', 'true', 0xa9272f], ['hat_beanie', 'tint', 0xc5c5c5],
  ['top_tee', 'tint', 0xd7d7d7], ['top_polo', 'tint', 0xd9d9d9], ['top_shirt', 'tint', 0xdddddd], ['top_stripes', 'tint', 0xb6b6b6], ['top_floral', 'tint', 0xcdcdcd], ['top_tank', 'tint', 0xd6d6d6], ['top_blouse', 'tint', 0xe3e3e3], ['top_hoodie', 'tint', 0xd0d0d0],
  ['top_blazer', 'tint', 0xcacaca], ['uni_hivis_orange', 'true', 0xb46444], ['uni_hivis_yellow', 'true', 0xa2ab42], ['uni_officer', 'true', 0xcecfce], ['uni_captain', 'true', 0x202739], ['uni_waiter', 'true', 0x6a6a6b], ['uni_dealer', 'true', 0x986d76], ['uni_chef', 'true', 0xf0f0ec],
  ['uni_performer', 'true', 0xa68b31], ['uni_cleaner', 'true', 0x45729b], ['uni_coverall', 'true', 0xd46c32], ['uni_scrubs', 'true', 0x9ac4ce], ['uni_steward', 'true', 0xe1e2df], ['uni_host', 'true', 0x222a44], ['uni_pirate', 'true', 0x88725b], ['top_bare', 'tint', 0xdadada],
  ['top_swim', 'tint', 0xd5d5d5], ['bot_trousers', 'tint', 0xd3d3d3], ['bot_jeans', 'tint', 0xc2c2c2], ['bot_chinos', 'tint', 0xd7d7d7], ['bot_hivis', 'true', 0x323e5b], ['bot_coverall', 'true', 0xd36b32], ['bot_uniform', 'true', 0x1b2236], ['bot_swim', 'tint', 0xd2d2d2],
  ['shoe_sneaker', 'tint', 0xd7d7d7], ['shoe_leather', 'tint', 0x9d9d9d], ['shoe_boot', 'true', 0x26211c], ['shoe_bare', 'tint', 0xdedede], ['plain', 'true', 0xffffff], ['prop_tray', 'true', 0xb8bcc0],
]);
export const TILE = Object.freeze(Object.fromEntries(TILES.map((t, i) => [t[0], i])));
/** skin tones (sRGB) — the same eight as iv2crowdplan.js SKINS, so a planned look maps onto a face tile exactly */
export const SKIN_TONES = Object.freeze([0xf1c8a5, 0xe0b48f, 0xc68e63, 0x9a6640, 0x6e4529, 0xf5d6bc, 0xd9a67a, 0x8a5a3a]);
/** atlas UV of a tile-local (u, v) (v = 0 at the bottom of the garment; image rows run top-down, flipY is false for KTX2) */
export const TILE_PAD = 0.03;
export function atlasUV(tile, u, v) {
  const col = tile % ATLAS_GRID, row = Math.floor(tile / ATLAS_GRID), s = 1 - 2 * TILE_PAD;
  return [(col + TILE_PAD + u * s) / ATLAS_GRID, (row + TILE_PAD + (1 - v) * s) / ATLAS_GRID];
}
/** head / hair azimuth (rad, 0 = the face, +π/2 = the person's left) → tile u: the front half gets 75 % of the width */
export function headU(az) {
  const a = Math.abs(az), s = Math.sign(az) || 1;
  return a <= Math.PI / 2 ? 0.5 + (az / Math.PI) * 0.75 : 0.5 + s * (0.375 + ((a - Math.PI / 2) / (Math.PI / 2)) * 0.125);
}
export const ATLAS_URL = (tier) => `/assets/lib/people/albedo${tier === 'phone' ? '_512' : ''}.ktx2`;

// ------------------------------------------------------------------------------------------------ parts
/** vertex part ids (aPart): which of a person's tiles a vertex samples */
export const PART = Object.freeze({ FACE: 0, HAIR: 1, TORSO: 2, UARM: 3, LARM: 4, SKIN: 5, THIGH: 6, SHIN: 7, SHOE: 8, PROP: 9, CAP: 10 });

class GeoBuilder {
  constructor() { this.pos = []; this.uv = []; this.part = []; this.si = []; this.sw = []; this.idx = []; this.col = []; }
  get n() { return this.pos.length / 3; }
  /** w: [[bone, weight], …] (normalised, top 4 kept) */
  vert(x, y, z, u, v, part, w, col = null) {
    const ws = w.slice().sort((a, b) => b[1] - a[1]).slice(0, 4), sum = ws.reduce((s, q) => s + q[1], 0) || 1;
    for (let k = 0; k < 4; k++) { this.si.push(ws[k] ? ws[k][0] : 0); this.sw.push(ws[k] ? ws[k][1] / sum : 0); }
    this.pos.push(x, y, z); this.uv.push(u, v); this.part.push(part); this.col.push(col == null ? -1 : col);
    return this.n - 1;
  }
  tri(a, b, c) { this.idx.push(a, b, c); }
}
const P3 = (G, i) => [G.pos[i * 3], G.pos[i * 3 + 1], G.pos[i * 3 + 2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** add quads / fans with outward winding: `out(i)` gives an outward hint vector for vertex i */
function addQuad(G, a, b, c, d, outHint) {   // a b c d around the quad
  const n = cross(sub(P3(G, b), P3(G, a)), sub(P3(G, c), P3(G, a)));
  if (dot(n, outHint) >= 0) { G.tri(a, b, c); G.tri(a, c, d); } else { G.tri(a, c, b); G.tri(a, d, c); }
}
function addTri(G, a, b, c, outHint) {
  const n = cross(sub(P3(G, b), P3(G, a)), sub(P3(G, c), P3(G, a)));
  if (dot(n, outHint) >= 0) G.tri(a, b, c); else G.tri(a, c, b);
}

/**
 * A lofted tube. axis 'y': rings lie in the xz plane (vertex at angle a: x = cx + rx·sin a, z = cz + rz·cos a; a = 0 is
 * the front); axis 'z': rings in the xy plane (a = 0 is the top). ring: { c: [x, y, z], r: [rx, rz|ry], w, v, e, part }.
 * u around (0.5 = the front / top), v from the ring. uvMap(u, v, ring) → [u, v] maps into a tile region.
 * caps: { start: [x, y, z] | null, end: [x, y, z] | null } close the ends with a fan to that point.
 */
function tube(G, rings, sides, axis, uvMap, caps = {}) {
  const ids = [];
  for (const r of rings) {
    const row = [], e = 2 / (r.e || 2);
    for (let j = 0; j <= sides; j++) {
      const a = -Math.PI + (TAU * j) / sides, s = spow(Math.sin(a), e), c = spow(Math.cos(a), e);
      let x, y, z;
      if (axis === 'y') { x = r.c[0] + r.r[0] * s; y = r.c[1]; z = r.c[2] + r.r[1] * c; }
      else { x = r.c[0] + r.r[0] * s; y = Math.max(r.floor ?? -1e9, r.c[1] + r.r[1] * c); z = r.c[2]; }
      const [u, v] = uvMap(j / sides, r.v, r);
      row.push(G.vert(x, y, z, u, v, r.part, r.w));
    }
    ids.push(row);
  }
  for (let i = 0; i < rings.length - 1; i++) {
    if (rings[i].split) continue;   // a part boundary: the next ring repeats the position with the other part
    for (let j = 0; j < sides; j++) {
      const a = ids[i][j], b = ids[i][j + 1], c = ids[i + 1][j + 1], d = ids[i + 1][j];
      const pa = P3(G, a), ctr = rings[i].c;
      addQuad(G, a, b, c, d, axis === 'y' ? [pa[0] - ctr[0], 0, pa[2] - ctr[2]] : [pa[0] - ctr[0], pa[1] - ctr[1], 0]);
    }
  }
  const fan = (row, ring, tip, sign) => {
    if (!tip) return;
    const [u, v] = uvMap(0.5, ring.v + sign * 0.02, ring);
    const t = G.vert(tip[0], tip[1], tip[2], u, clamp(v, 0, 1), ring.part, ring.w);
    const out = sub(tip, ring.c);
    for (let j = 0; j < sides; j++) addTri(G, row[j], row[j + 1], t, out);
  };
  fan(ids[0], rings[0], caps.start, -1);
  fan(ids[ids.length - 1], rings[rings.length - 1], caps.end, 1);
  return ids;
}

const LODS = [
  { torso: 12, head: [16, 11], hair: [16, 4], arm: 10, leg: 10, hand: 6, shoe: 8, neck: 8, thumb: true, tray: 12 },
  { torso: 8, head: [8, 6], hair: [8, 2], arm: 5, leg: 5, hand: 4, shoe: 4, neck: 6, thumb: false, tray: 6 },
  { torso: 5, head: [6, 4], hair: null, arm: 4, leg: 4, hand: 0, shoe: 4, neck: 0, thumb: false, tray: 0 },
];
const W = (...pairs) => { const out = []; for (let i = 0; i < pairs.length; i += 2) out.push([pairs[i], pairs[i + 1]]); return out; };

// torso rings: [y, cz, half width, half depth, weights(side 0 L / 1 R → for the shoulder blend), lod (max lod that keeps it)]
const TORSO = [
  [0.875, -0.005, 0.15, 0.095, W(BONE.hips, 1), 2],
  [0.93, -0.01, 0.168, 0.106, W(BONE.hips, 1), 0],
  [1.0, -0.008, 0.162, 0.1, W(BONE.hips, 0.7, BONE.spine, 0.3), 0],
  [1.07, -0.005, 0.148, 0.095, W(BONE.spine, 0.7, BONE.hips, 0.3), 1],
  [1.14, 0.0, 0.146, 0.098, W(BONE.spine, 1), 0],
  [1.21, 0.005, 0.155, 0.105, W(BONE.spine, 0.6, BONE.chest, 0.4), 1],
  [1.28, 0.01, 0.165, 0.113, W(BONE.chest, 0.8, BONE.spine, 0.2), 0],
  [1.35, 0.008, 0.172, 0.112, W(BONE.chest, 1), 2],
  [1.41, -0.005, 0.175, 0.1, W(BONE.chest, 1), 0],
  [1.455, -0.015, 0.152, 0.082, W(BONE.chest, 1), 1],
  [1.49, -0.02, 0.07, 0.06, W(BONE.chest, 0.5, BONE.neck, 0.5), 2],
];
// leg rings (left; x mirrored for the right): [y, cx, cz, rx, rz, weights by side, lod, split]
const LEG = (s) => {
  const th = s ? BONE.thighR : BONE.thighL, sh = s ? BONE.shinR : BONE.shinL, ft = s ? BONE.footR : BONE.footL;
  return [
    [0.975, 0.088, 0, 0.085, 0.09, W(th, 0.85, BONE.hips, 0.15), 2],
    [0.9, 0.093, -0.005, 0.085, 0.092, W(th, 1), 0],
    [0.8, 0.095, 0.01, 0.075, 0.082, W(th, 1), 1],
    [0.68, 0.097, 0.012, 0.064, 0.07, W(th, 1), 0],
    [0.6, 0.098, 0.012, 0.056, 0.062, W(th, 1), 2, 'split'],
    [0.535, 0.099, 0.014, 0.05, 0.055, W(th, 0.75, sh, 0.25), 0],
    [0.5, 0.1, 0.016, 0.05, 0.052, W(th, 0.5, sh, 0.5), 1],
    [0.46, 0.1, 0.008, 0.048, 0.052, W(sh, 0.8, th, 0.2), 0],
    [0.38, 0.1, -0.008, 0.052, 0.058, W(sh, 1), 1],
    [0.28, 0.1, -0.004, 0.043, 0.046, W(sh, 1), 0],
    [0.18, 0.1, 0.0, 0.034, 0.036, W(sh, 1), 0],
    [0.11, 0.1, -0.012, 0.031, 0.035, W(sh, 0.7, ft, 0.3), 2],
  ];
};
// arm rings (left): [y, cx, cz, rx, rz, weights, lod, split]
const ARM = (s) => {
  const sh = s ? BONE.shoulderR : BONE.shoulderL, ua = s ? BONE.upperArmR : BONE.upperArmL, fa = s ? BONE.forearmR : BONE.forearmL, ha = s ? BONE.handR : BONE.handL;
  return [
    [1.455, 0.165, -0.03, 0.05, 0.055, W(sh, 0.6, ua, 0.4), 2],
    [1.41, 0.18, -0.03, 0.058, 0.058, W(ua, 0.8, sh, 0.2), 0],
    [1.34, 0.186, -0.033, 0.05, 0.052, W(ua, 1), 1],
    [1.27, 0.19, -0.036, 0.046, 0.05, W(ua, 1), 1, 'split'],
    [1.2, 0.195, -0.04, 0.042, 0.046, W(ua, 1), 0],
    [1.14, 0.2, -0.045, 0.039, 0.043, W(ua, 0.5, fa, 0.5), 2],
    [1.08, 0.203, -0.04, 0.043, 0.044, W(fa, 0.85, ua, 0.15), 0],
    [1.0, 0.208, -0.035, 0.04, 0.04, W(fa, 1), 0],
    [0.93, 0.212, -0.03, 0.032, 0.029, W(fa, 1), 0],
    [0.885, 0.215, -0.03, 0.027, 0.022, W(fa, 0.6, ha, 0.4), 2],
  ];
};
// hand rings (left): [y, dz (curl forward), half width (along z), half thickness (along x)]
const HAND = [[0.895, 0, 0.026, 0.02], [0.83, 0.004, 0.043, 0.02], [0.78, 0.008, 0.044, 0.017], [0.735, 0.014, 0.04, 0.014], [0.706, 0.02, 0.03, 0.011]];
// shoe rings (left, along +z from the heel): [z, cy, half width, half height]
const SHOE = [[-0.088, 0.045, 0.034, 0.045], [-0.06, 0.05, 0.043, 0.05], [0.0, 0.05, 0.046, 0.05], [0.06, 0.042, 0.047, 0.042], [0.11, 0.034, 0.042, 0.034], [0.15, 0.028, 0.034, 0.028], [0.172, 0.022, 0.022, 0.02]];
const SHOE_LOD = [[0, 1, 2, 3, 4, 5, 6], [0, 2, 6], [0, 2, 6]];
// the head: an ellipsoid with features (centre, radii)
const HEAD_C = [0, 1.645, 0.012], HEAD_R = [0.079, 0.112, 0.098];

function headPoint(az, th, scale = 1, hair = false) {
  const d = [Math.sin(th) * Math.sin(az), Math.cos(th), Math.sin(th) * Math.cos(az)];
  let rx = HEAD_R[0] * scale, ry = HEAD_R[1] * scale, rz = HEAD_R[2] * scale;
  if (hair) ry *= 1.03;
  let x = rx * d[0], y = ry * d[1], z = rz * d[2];
  if (!hair) {
    const front = Math.max(0, Math.cos(az)), side = Math.abs(Math.sin(az));
    // jaw: narrower and a little forward below the cheekbones
    const jaw = smooth(-0.15, -0.85, d[1]);
    x *= 1 - 0.2 * jaw; z *= 1 - 0.08 * jaw * (1 - front);
    // nose bridge and tip, brow, chin, eye sockets, cheeks, ears, back of the skull
    const g = (a, s) => Math.exp(-(a * a) / (s * s));
    const nose = g(az, 0.17) * (0.016 * g(d[1] + 0.17, 0.12) + 0.006 * g(d[1] - 0.02, 0.1));
    const brow = 0.007 * g(d[1] - 0.24, 0.08) * front * front;
    const chin = 0.011 * g(d[1] + 0.82, 0.14) * g(az, 0.45);
    const socket = -0.006 * g(d[1] - 0.1, 0.07) * g(Math.abs(az) - 0.36, 0.14);
    const lips = 0.004 * g(d[1] + 0.5, 0.06) * g(az, 0.3);
    const ear = 0.014 * g(d[1] - 0.0, 0.18) * g(Math.abs(az) - Math.PI / 2, 0.16);
    const occ = 0.006 * g(d[1] - 0.1, 0.35) * Math.max(0, -Math.cos(az));
    const push = nose + brow + chin + socket + lips + occ;
    z += push * front + occ * Math.cos(az); x += ear * Math.sign(d[0]) * side;
  }
  return [HEAD_C[0] + x, HEAD_C[1] + y, HEAD_C[2] + z];
}
function buildHead(G, lod) {
  const [segs, rings] = LODS[lod].head, w = W(BONE.head, 1);
  const ids = [];
  for (let i = 0; i <= rings; i++) {
    const th = (Math.PI * i) / rings, row = [];
    for (let j = 0; j <= segs; j++) {
      const az = -Math.PI + (TAU * j) / segs;
      const p = headPoint(az, th);
      row.push(G.vert(p[0], p[1], p[2], j === 0 ? 0 : j === segs ? 1 : headU(az), 1 - i / rings, PART.FACE, w));
    }
    ids.push(row);
  }
  for (let i = 0; i < rings; i++) for (let j = 0; j < segs; j++) {
    const a = ids[i][j], b = ids[i][j + 1], c = ids[i + 1][j + 1], d = ids[i + 1][j];
    const out = sub(P3(G, a), HEAD_C), q = sub(P3(G, d), HEAD_C);
    if (i === 0) addTri(G, a, c, d, q); else if (i === rings - 1) addTri(G, a, b, c, out); else addQuad(G, a, b, c, d, out);
  }
}
/** hairline: how far down (polar angle) the hair reaches at azimuth az — forehead, temples, nape */
export const hairline = (az) => (62 + 63 * Math.pow(Math.abs(az) / Math.PI, 1.3)) * Math.PI / 180;
function buildHair(G, lod) {
  const H = LODS[lod].hair; if (!H) return;
  const [segs, rings] = H, w = W(BONE.head, 1), ids = [];
  for (let i = 0; i <= rings; i++) {
    const row = [];
    for (let j = 0; j <= segs; j++) {
      const az = -Math.PI + (TAU * j) / segs, th = Math.max(0.0001, (hairline(az) * i) / rings);
      const p = headPoint(az, th, 1.065, true);
      row.push(G.vert(p[0], p[1], p[2], j === 0 ? 0 : j === segs ? 1 : headU(az), 1 - th / Math.PI, PART.HAIR, w));
    }
    ids.push(row);
  }
  for (let i = 0; i < rings; i++) for (let j = 0; j < segs; j++) {
    const a = ids[i][j], b = ids[i][j + 1], c = ids[i + 1][j + 1], d = ids[i + 1][j];
    const out = sub(P3(G, d), HEAD_C);
    if (i === 0) addTri(G, a, c, d, out); else addQuad(G, a, b, c, d, out);
  }
}
function buildTorso(G, lod) {
  const sides = LODS[lod].torso;
  const rings = TORSO.filter((r) => r[5] >= lod).map(([y, cz, hw, hd, w]) => ({ c: [0, y, cz], r: [hw, hd], w, v: (y - 0.875) / (1.49 - 0.875), e: 2.5, part: PART.TORSO }));
  const ids = tube(G, rings, sides, 'y', (u, v) => [u * 0.75, v], { start: [0, 0.869, -0.005], end: [0, 1.5, -0.02] });
  // shoulders: the outer vertices of the top rings follow the clavicles
  rings.forEach((r, i) => {
    if (r.c[1] < 1.38) return;
    const k = r.c[1] > 1.43 ? 0.55 : 0.3;
    for (const vi of ids[i]) {
      const x = G.pos[vi * 3], s = smooth(0.07, 0.15, Math.abs(x)) * k;
      if (s <= 0) continue;
      const bone = x > 0 ? BONE.shoulderL : BONE.shoulderR;
      // rewrite the weights: (1 - s) of the old ones, s to the clavicle
      const o = vi * 4, old = [];
      for (let q = 0; q < 4; q++) if (G.sw[o + q] > 0) old.push([G.si[o + q], G.sw[o + q] * (1 - s)]);
      old.push([bone, s]);
      old.sort((a, b) => b[1] - a[1]);
      for (let q = 0; q < 4; q++) { G.si[o + q] = old[q] ? old[q][0] : 0; G.sw[o + q] = old[q] ? old[q][1] : 0; }
    }
  });
}
function buildLimb(G, lod, spec, sides, partA, partB, uvMap, caps) {
  const rows = spec.filter((r) => r[6] >= lod);
  const rings = [];
  for (const [y, cx, cz, rx, rz, w, , split] of rows) {
    const base = { c: [cx, y, cz], r: [rx, rz], w, e: 2 };
    if (split) { rings.push({ ...base, part: partA, split: true }); rings.push({ ...base, part: partB }); }
    else rings.push({ ...base, part: rings.length && rings[rings.length - 1].part === partB ? partB : partA });
  }
  return tube(G, rings.map((r) => ({ ...r, v: uvMap.v(r.c[1]) })), sides, 'y', uvMap.f, caps);
}
function buildArms(G, lod) {
  for (const s of [0, 1]) {
    const sg = s ? -1 : 1;
    const spec = ARM(s).map((r) => [r[0], r[1] * sg, r[2], r[3], r[4], r[5], r[6], r[7]]);
    buildLimb(G, lod, spec, LODS[lod].arm, PART.UARM, PART.LARM, { v: (y) => (y - 0.885) / (1.455 - 0.885), f: (u, v) => [0.75 + u * 0.25, v] }, { start: [0.17 * sg, 1.478, -0.03] });
    buildHand(G, lod, s);
  }
}
function buildHand(G, lod, s) {
  const sides = LODS[lod].hand; if (!sides) return;
  const sg = s ? -1 : 1, hb = s ? BONE.handR : BONE.handL, fb = s ? BONE.forearmR : BONE.forearmL;
  const pick = lod === 0 ? HAND : [HAND[0], HAND[2], HAND[4]];
  // the width runs front-back (z), the thickness sideways (x): palms face the thighs
  const rings = pick.map(([y, dz, hw, ht], i) => ({ c: [0.215 * sg, y, -0.03 + dz], r: [ht, hw], w: i === 0 ? W(hb, 0.7, fb, 0.3) : W(hb, 1), v: 0.5, e: 2.2, part: PART.SKIN }));
  tube(G, rings, sides, 'y', () => [0.5, 0.5], { end: [0.215 * sg, 0.694, -0.03 + 0.022] });
  if (LODS[lod].thumb) {
    const tr = [[0.86, -0.008, 0.012, 0.014], [0.825, -0.014, 0.034, 0.011], [0.795, -0.016, 0.05, 0.009]].map(([y, dx, dz, r]) => ({ c: [(0.215 + dx) * sg, y, -0.03 + dz], r: [r, r], w: W(hb, 1), v: 0.5, e: 2, part: PART.SKIN }));
    tube(G, tr, 6, 'y', () => [0.5, 0.5], { end: [(0.215 - 0.017) * sg, 0.782, -0.03 + 0.056] });
  }
}
function buildLegs(G, lod) {
  for (const s of [0, 1]) {
    const sg = s ? -1 : 1;
    const spec = LEG(s).map((r) => [r[0], r[1] * sg, r[2], r[3], r[4], r[5], r[6], r[7]]);
    buildLimb(G, lod, spec, LODS[lod].leg, PART.THIGH, PART.SHIN, { v: (y) => (y - 0.11) / (0.975 - 0.11), f: (u, v) => [u, v] }, {});
    buildShoe(G, lod, s);
  }
}
function buildShoe(G, lod, s) {
  const sg = s ? -1 : 1, fb = s ? BONE.footR : BONE.footL, z0 = SHOE[0][0], z1 = SHOE[SHOE.length - 1][0];
  const rings = SHOE_LOD[lod].map((i) => SHOE[i]).map(([z, cy, hw, hh]) => ({ c: [0.1 * sg, cy, z + 0.005], r: [hw, hh], w: W(fb, 1), v: (z - z0) / (z1 - z0), e: 2.6, part: PART.SHOE, floor: 0.0 }));
  // z-tubes: u = 0.5 on top (the laces), the sole at the seam
  tube(G, rings, LODS[lod].shoe, 'z', (u, v) => [u, v], { start: [0.1 * sg, 0.045, z0 - 0.01], end: [0.1 * sg, 0.018, z1 + 0.012] });
}
function buildNeck(G, lod) {
  const sides = LODS[lod].neck; if (!sides) return;
  const rings = [[1.44, -0.02, 0.054, 0.05, W(BONE.chest, 0.6, BONE.neck, 0.4)], [1.52, -0.01, 0.049, 0.047, W(BONE.neck, 1)], [1.59, 0.0, 0.047, 0.046, W(BONE.neck, 0.5, BONE.head, 0.5)]]
    .filter((r, i) => lod === 0 || i !== 1).map(([y, cz, rx, rz, w]) => ({ c: [0, y, cz], r: [rx, rz], w, v: 0.5, e: 2, part: PART.SKIN }));
  tube(G, rings, sides, 'y', () => [0.5, 0.5]);
}
/** the captain's peaked cap: crown, gold band, white top, black visor (per-vertex colours on the plain tile) */
function buildCap(G) {
  const w = W(BONE.head, 1), navy = 0x1c2338, gold = 0xd9b04a, white = 0xf4f4f0, black = 0x0e0e10;
  const ring = (y, rx, rz, cz, col) => ({ c: [0, y, cz], r: [rx, rz], w, v: 0.5, e: 2, part: PART.CAP, col });
  const crown = [ring(1.712, 0.086, 0.102, 0.008, gold), ring(1.735, 0.088, 0.104, 0.008, gold), ring(1.736, 0.089, 0.105, 0.008, navy), ring(1.79, 0.104, 0.118, 0.0, navy), ring(1.792, 0.104, 0.118, 0.0, white)];
  const ids = [];
  for (const r of crown) {
    const row = [];
    for (let j = 0; j <= 16; j++) { const a = -Math.PI + (TAU * j) / 16; row.push(G.vert(r.c[0] + r.r[0] * Math.sin(a), r.c[1], r.c[2] + r.r[1] * Math.cos(a), 0.5, 0.5, PART.CAP, w, r.col)); }
    ids.push(row);
  }
  for (let i = 0; i < ids.length - 1; i++) for (let j = 0; j < 16; j++) { const a = ids[i][j], b = ids[i][j + 1], c = ids[i + 1][j + 1], d = ids[i + 1][j]; const pa = P3(G, a); addQuad(G, a, b, c, d, [pa[0], 0, pa[2] - crown[i].c[2]]); }
  const top = G.vert(0, 1.796, 0, 0.5, 0.5, PART.CAP, w, white), last = ids[ids.length - 1];
  for (let j = 0; j < 16; j++) addTri(G, last[j], last[j + 1], top, [0, 1, 0]);
  // badge
  const bz = 0.008 + 0.105 + 0.002, b0 = G.vert(-0.014, 1.745, bz, 0.5, 0.5, PART.CAP, w, gold), b1 = G.vert(0.014, 1.745, bz, 0.5, 0.5, PART.CAP, w, gold), b2 = G.vert(0.014, 1.775, bz - 0.004, 0.5, 0.5, PART.CAP, w, gold), b3 = G.vert(-0.014, 1.775, bz - 0.004, 0.5, 0.5, PART.CAP, w, gold);
  addQuad(G, b0, b1, b2, b3, [0, 0, 1]);
  // visor: a half ring in front, tilted down, with a top and an underside
  const vis = (dy, yAdd) => { const row = []; for (let j = 0; j <= 8; j++) { const a = -1.25 + (2.5 * j) / 8; for (const rr of [1, 1.55]) { const ry = 1.712 - (rr - 1) * 0.07 + yAdd; row.push(G.vert(0.086 * rr * Math.sin(a), ry + dy, 0.008 + 0.104 * rr * Math.cos(a), 0.5, 0.5, PART.CAP, w, black)); } } return row; };
  const vt = vis(0.004, 0), vb = vis(-0.002, 0);
  for (let j = 0; j < 8; j++) { addQuad(G, vt[j * 2], vt[j * 2 + 2], vt[j * 2 + 3], vt[j * 2 + 1], [0, 1, 0.3]); addQuad(G, vb[j * 2], vb[j * 2 + 2], vb[j * 2 + 3], vb[j * 2 + 1], [0, -1, -0.2]); }
}

/** smooth normals, welded by position (seams and part boundaries stay smooth) */
function weldedNormals(pos, idx) {
  const key = (i) => `${Math.round(pos[i * 3] * 1e4)},${Math.round(pos[i * 3 + 1] * 1e4)},${Math.round(pos[i * 3 + 2] * 1e4)}`;
  const n = pos.length / 3, group = new Int32Array(n), map = new Map();
  for (let i = 0; i < n; i++) { const k = key(i); let g = map.get(k); if (g === undefined) { g = map.size; map.set(k, g); } group[i] = g; }
  const acc = new Float32Array(map.size * 3);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const e1 = [pos[b * 3] - pos[a * 3], pos[b * 3 + 1] - pos[a * 3 + 1], pos[b * 3 + 2] - pos[a * 3 + 2]], e2 = [pos[c * 3] - pos[a * 3], pos[c * 3 + 1] - pos[a * 3 + 1], pos[c * 3 + 2] - pos[a * 3 + 2]];
    const fn = cross(e1, e2);
    for (const v of [a, b, c]) { const g = group[v] * 3; acc[g] += fn[0]; acc[g + 1] += fn[1]; acc[g + 2] += fn[2]; }
  }
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const g = group[i] * 3, l = Math.hypot(acc[g], acc[g + 1], acc[g + 2]) || 1; out[i * 3] = acc[g] / l; out[i * 3 + 1] = acc[g + 1] / l; out[i * 3 + 2] = acc[g + 2] / l; }
  return out;
}

const GEO_CACHE = new Map();
/**
 * The rest-pose body for a LOD (0, 1, 2) as a BufferGeometry: position, normal, aUV (tile-local), aPart, skinIndex,
 * skinWeight, aCol (packed sRGB colour for fixed-colour parts such as the cap, else -1). opts: { cap (the captain's
 * peaked cap), prop (the crowd's tray on the prop bone) }. Cached and shared: userData.shared = true — clone before
 * changing it.
 */
export function bodyGeometry(lod = 0, opts = {}) {
  lod = clamp(lod | 0, 0, 2);
  const key = `${lod}|${opts.cap ? 1 : 0}|${opts.prop ? 1 : 0}`;
  if (GEO_CACHE.has(key)) return GEO_CACHE.get(key);
  const G = new GeoBuilder();
  buildTorso(G, lod); buildNeck(G, lod); buildHead(G, lod); buildHair(G, lod); buildArms(G, lod); buildLegs(G, lod);
  if (opts.cap) buildCap(G);
  if (opts.prop && LODS[lod].tray) buildTray(G, lod);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(G.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(weldedNormals(G.pos, G.idx), 3));
  g.setAttribute('aUV', new THREE.Float32BufferAttribute(G.uv, 2));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(G.part, 1));
  g.setAttribute('aCol', new THREE.Float32BufferAttribute(G.col, 1));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(G.si, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(G.sw, 4));
  g.setIndex(G.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(G.idx, 1) : new THREE.Uint16BufferAttribute(G.idx, 1));
  g.computeBoundingBox(); g.computeBoundingSphere();
  g.userData = { shared: true, lod, tris: G.idx.length / 3, verts: G.pos.length / 3 };
  GEO_CACHE.set(key, g);
  return g;
}
/** triangles of a person at a LOD (the crowd geometry carries the tray) */
export const personTris = (lod, prop = true) => bodyGeometry(lod, { prop }).userData.tris;

// ------------------------------------------------------------------------------------------------ poses
// A pose is a Float32Array(64): Euler XYZ (rad) per bone (20 × 3), the hips translation (60…62) and the prop scale (63).
// Conventions (body facing +z): +x on a limb hanging down swings it BACK, −x forward; +x on the spine / head leans
// forward / looks down; +z on a left limb lifts it outward (mirrored for the right: x, −y, −z).
const POSE_N = 64;
const blank = () => new Float32Array(POSE_N);
const set = (p, b, x = 0, y = 0, z = 0) => { p[b * 3] = x; p[b * 3 + 1] = y; p[b * 3 + 2] = z; };
const add = (p, b, x = 0, y = 0, z = 0) => { p[b * 3] += x; p[b * 3 + 1] += y; p[b * 3 + 2] += z; };
const sym = (p, bL, bR, x = 0, y = 0, z = 0) => { set(p, bL, x, y, z); set(p, bR, x, -y, -z); };
const hipsAt = (p, x, y, z) => { p[60] = x; p[61] = y; p[62] = z; };
const _gp = new THREE.Vector3();
/** standing clips: move the hips up / down so the lowest heel or toe touches y = 0 (no sinking, no hovering) */
function ground(p) {
  const W0 = boneWorld(p);
  let lo = Infinity;
  for (const b of [BONE.footL, BONE.footR]) for (const o of [[0, -0.083, -0.065], [0, -0.068, 0.2]]) lo = Math.min(lo, _gp.set(o[0], o[1], o[2]).applyMatrix4(W0[b]).y);
  p[61] -= lo;
  return p;
}

function idlePose(f) {
  const p = blank(), s = Math.sin(TAU * f);
  set(p, BONE.spine, 0.02 * s); set(p, BONE.chest, -0.012 * s + 0.01); set(p, BONE.neck, 0.02); set(p, BONE.head, 0.03, 0, 0.01 * s);
  sym(p, BONE.upperArmL, BONE.upperArmR, 0.03 + 0.012 * s, 0, 0.07); sym(p, BONE.forearmL, BONE.forearmR, -0.14); sym(p, BONE.handL, BONE.handR, 0.05);
  set(p, BONE.hips, 0, 0, 0.018 * s); sym(p, BONE.thighL, BONE.thighR, 0, 0, 0.03); set(p, BONE.thighL, 0, 0, 0.03 - 0.018 * s); set(p, BONE.thighR, 0, 0, -0.03 - 0.018 * s);
  return p;
}
function walkPose(f, run = false) {
  const p = blank(), a = TAU * f, s = Math.sin(a), c = Math.cos(a);
  const amp = run ? 0.62 : 0.38, kneeSw = run ? 1.55 : 0.68, armA = run ? 0.55 : 0.33;
  // legs: L forward-most at a = π/2; the swing (knee up) peaks at a = 0 for L, a = π for R
  const leg = (side, ph) => {
    const ss = Math.sin(ph), cc = Math.cos(ph);
    const th = -amp * ss - (run ? 0.18 : 0.02);
    const knee = 0.08 + kneeSw * Math.pow(Math.max(0, cc), 1.5) + (run ? 0.25 : 0.05) * Math.max(0, -ss);
    const foot = -0.25 * Math.max(0, cc) + 0.18 * Math.max(0, -ss) * (run ? 1.4 : 1) - 0.06 * Math.max(0, ss);
    set(p, side ? BONE.thighR : BONE.thighL, th, 0, side ? -0.02 : 0.02);
    set(p, side ? BONE.shinR : BONE.shinL, knee);
    set(p, side ? BONE.footR : BONE.footL, foot);
  };
  leg(0, a); leg(1, a + Math.PI);
  // arms swing against the legs
  set(p, BONE.upperArmL, armA * s, 0, 0.07); set(p, BONE.upperArmR, -armA * s, 0, -0.07);
  set(p, BONE.forearmL, (run ? -1.35 : -0.22) - 0.18 * Math.max(0, -s)); set(p, BONE.forearmR, (run ? -1.35 : -0.22) - 0.18 * Math.max(0, s));
  sym(p, BONE.handL, BONE.handR, 0.08);
  set(p, BONE.hips, 0, -0.07 * s, 0.03 * c); set(p, BONE.spine, run ? 0.14 : 0.035, 0.09 * s, 0); set(p, BONE.chest, run ? 0.05 : 0.0, 0.04 * s, 0);
  set(p, BONE.neck, run ? -0.1 : 0.0, -0.06 * s); set(p, BONE.head, run ? -0.05 : 0.03, -0.04 * s);
  hipsAt(p, 0.012 * c, run ? -0.07 + 0.05 * Math.abs(Math.cos(a)) : -0.032 * s * s, 0);
  return p;
}
function sitPose(f, arms = 'lap') {
  const p = blank(), s = Math.sin(TAU * f);
  hipsAt(p, 0, -0.4, -0.02);   // hip joint 0.57 m: thighs on a ~0.45 m seat, soles on the floor
  sym(p, BONE.thighL, BONE.thighR, -1.5, 0, 0.06); sym(p, BONE.shinL, BONE.shinR, 1.3); sym(p, BONE.footL, BONE.footR, 0.2);
  set(p, BONE.spine, -0.04 + 0.015 * s); set(p, BONE.chest, 0.03); set(p, BONE.neck, 0.04); set(p, BONE.head, 0.05);
  if (arms === 'lap') { sym(p, BONE.upperArmL, BONE.upperArmR, -0.38, 0, 0.12); sym(p, BONE.forearmL, BONE.forearmR, -1.05, 0.3, 0); sym(p, BONE.handL, BONE.handR, 0.25); }
  return p;
}
function clapPose(f) {
  const p = sitPose(0, 'none'), t = f < 0.5 ? 0 : 1;
  sym(p, BONE.upperArmL, BONE.upperArmR, -0.78, 0, -0.18 - 0.14 * t); sym(p, BONE.forearmL, BONE.forearmR, -1.25, 0.55, -0.1 - 0.12 * t); sym(p, BONE.handL, BONE.handR, 0, -0.5, 0);
  set(p, BONE.head, -0.05);
  return p;
}
function dancePose(f) {
  const p = blank(), a = TAU * f, s = Math.sin(a), s2 = Math.sin(2 * a);
  hipsAt(p, 0.03 * s, -0.05 - 0.035 * Math.abs(s2), 0);
  set(p, BONE.hips, 0, 0.18 * s, 0.1 * s); set(p, BONE.spine, 0.04, -0.12 * s, -0.06 * s); set(p, BONE.chest, 0, -0.08 * s, -0.05 * s);
  set(p, BONE.thighL, -0.22 - 0.12 * Math.max(0, s), 0, 0.06); set(p, BONE.thighR, -0.22 - 0.12 * Math.max(0, -s), 0, -0.06);
  sym(p, BONE.shinL, BONE.shinR, 0.36 + 0.1 * Math.abs(s2));
  set(p, BONE.shinL, 0.36 + 0.25 * Math.max(0, s)); set(p, BONE.shinR, 0.36 + 0.25 * Math.max(0, -s));
  sym(p, BONE.footL, BONE.footR, -0.12);
  set(p, BONE.shoulderL, 0, 0, 0.18); set(p, BONE.shoulderR, 0, 0, -0.18);
  set(p, BONE.upperArmL, -0.3 + 0.25 * s, 0, 2.3 + 0.2 * s2); set(p, BONE.upperArmR, -0.3 - 0.25 * s, 0, -2.3 + 0.2 * s2);
  sym(p, BONE.forearmL, BONE.forearmR, -0.55 - 0.25 * Math.abs(s));
  set(p, BONE.head, -0.08 + 0.06 * s2, 0.25 * s);
  return p;
}
function liePose(f) {
  const p = blank(), s = Math.sin(TAU * f);
  hipsAt(p, 0, -0.44, 0.1);
  set(p, BONE.hips, -Math.PI / 2 + 0.1);
  set(p, BONE.spine, 0.004 * s); set(p, BONE.chest, -0.06); set(p, BONE.neck, -0.12); set(p, BONE.head, -0.28);
  sym(p, BONE.thighL, BONE.thighR, -0.12, 0, 0.05); sym(p, BONE.shinL, BONE.shinR, 0.2); sym(p, BONE.footL, BONE.footR, 0.35);
  sym(p, BONE.upperArmL, BONE.upperArmR, 0.05, 0, 0.16); sym(p, BONE.forearmL, BONE.forearmR, -0.25);
  return p;
}
function swimPose(f) {
  const p = blank(), a = TAU * f, s = Math.sin(a), k = Math.sin(a + 1.1);
  hipsAt(p, 0, -0.97, -0.32);
  set(p, BONE.hips, Math.PI / 2 - 0.25);
  set(p, BONE.spine, -0.12); set(p, BONE.chest, -0.1); set(p, BONE.neck, -0.35); set(p, BONE.head, -0.45);
  // breaststroke: reach forward, sweep out and back
  sym(p, BONE.upperArmL, BONE.upperArmR, -2.75 + 0.45 * Math.max(0, s), 0, 0.15 + 0.85 * Math.max(0, s));
  sym(p, BONE.forearmL, BONE.forearmR, -0.15 - 0.9 * Math.max(0, s));
  // frog kick
  sym(p, BONE.thighL, BONE.thighR, -0.45 * Math.max(0, k), 0, 0.12 + 0.3 * Math.max(0, k));
  sym(p, BONE.shinL, BONE.shinR, 0.15 + 1.25 * Math.max(0, k)); sym(p, BONE.footL, BONE.footR, 0.6);
  return p;
}
const TRAY_ARM = (p) => { set(p, BONE.upperArmR, -0.3, 0.15, -0.28); set(p, BONE.forearmR, -1.32, -0.25, 0.1); set(p, BONE.handR, 0.05, 1.45, 0); };
function trayPose(f) { const p = walkPose(f); TRAY_ARM(p); set(p, BONE.spine, 0.02, 0.03 * Math.sin(TAU * f)); p[63] = 1; return p; }
function wavePose(f) {
  const p = idlePose(f), s = Math.sin(TAU * f);
  set(p, BONE.shoulderR, 0, 0, -0.2); set(p, BONE.upperArmR, -0.25, 0, -2.4); set(p, BONE.forearmR, -0.15, 0, -0.35 + 0.45 * s); set(p, BONE.handR, 0, 0, -0.1 + 0.2 * s);
  set(p, BONE.head, -0.06, -0.1);
  return p;
}
function holdPose(f) {
  const p = blank(), s = Math.sin(TAU * f);
  hipsAt(p, 0, -0.06, 0);
  set(p, BONE.spine, 0.12 + 0.015 * s); set(p, BONE.chest, 0.04); set(p, BONE.neck, -0.05); set(p, BONE.head, -0.06);
  sym(p, BONE.thighL, BONE.thighR, -0.28, 0, 0.1); sym(p, BONE.shinL, BONE.shinR, 0.5); sym(p, BONE.footL, BONE.footR, -0.2);
  set(p, BONE.upperArmL, -0.95, 0, -0.12); set(p, BONE.upperArmR, -0.7, 0, 0.18);
  set(p, BONE.forearmL, -0.8, 0.4); set(p, BONE.forearmR, -1.2, -0.3);
  return p;
}
/** clip → [frames, pose(phase)]: baked in this order into the VAT */
const walkG = (f) => ground(walkPose(f)), runG = (f) => ground(walkPose(f, true));
export const CLIPS = Object.freeze({
  idle: [4, (f) => ground(idlePose(f))], walk: [8, walkG], run: [8, runG], sit: [2, (f) => sitPose(f)], clap: [2, clapPose], dance: [8, (f) => ground(dancePose(f))],
  lie: [2, liePose], swim: [8, swimPose], tray: [8, (f) => ground(trayPose(f))], wave: [4, (f) => ground(wavePose(f))], hold: [2, (f) => ground(holdPose(f))],
});
export const CLIP_NAMES = Object.freeze(Object.keys(CLIPS));
/** first frame of each clip and the total */
export const CLIP_START = Object.freeze((() => { const o = {}; let n = 0; for (const k of CLIP_NAMES) { o[k] = n; n += CLIPS[k][0]; } o._total = n; return o; })());
/** the pose of a clip at phase 0…1 (unknown clips stand idle) */
export function poseOf(clip, phase = 0) { const c = CLIPS[clip] || CLIPS.idle; return c[1](((phase % 1) + 1) % 1); }
/** blend two poses (a + (b − a)·t, angles and translation) into `out` */
export function blendPose(a, b, t, out = blank()) { for (let i = 0; i < POSE_N; i++) out[i] = a[i] + (b[i] - a[i]) * t; return out; }
/** [frameA, frameB, blend] of a clip at phase (loops) */
export function frameOf(clip, phase) {
  const c = CLIPS[clip] || CLIPS.idle, n = c[0], s = CLIP_START[CLIPS[clip] ? clip : 'idle'];
  if (n === 1) return [s, s, 0];
  const f = (((phase % 1) + 1) % 1) * n, i0 = Math.floor(f) % n;
  return [s + i0, s + ((i0 + 1) % n), f - Math.floor(f)];
}

// ------------------------------------------------------------------------------------------------ bone matrices + CPU skinning
const _e = new THREE.Euler(), _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _s = new THREE.Vector3(), _ml = new THREE.Matrix4();
/** world matrices of every bone for a pose (array of THREE.Matrix4, 20) */
export function boneWorld(pose) {
  const out = [];
  for (let b = 0; b < BONES.length; b++) {
    const par = PARENT[b];
    if (par < 0) _v.set(REST[b][0] + pose[60], REST[b][1] + pose[61], REST[b][2] + pose[62]);
    else _v.set(REST[b][0] - REST[par][0], REST[b][1] - REST[par][1], REST[b][2] - REST[par][2]);
    _q.setFromEuler(_e.set(pose[b * 3], pose[b * 3 + 1], pose[b * 3 + 2], 'XYZ'));
    const sc = b === BONE.prop ? pose[63] : 1;
    _ml.compose(_v, _q, _s.set(sc, sc, sc));
    out.push(par < 0 ? _ml.clone() : out[par].clone().multiply(_ml));
  }
  return out;
}
/** skinning matrices (world × inverse rest) for a pose */
export function skinMatrices(pose) {
  const W0 = boneWorld(pose);
  return W0.map((m, b) => m.multiply(_ml.makeTranslation(-REST[b][0], -REST[b][1], -REST[b][2])));
}
/** posed positions + normals of a geometry (linear blend skinning on the CPU) */
export function skinGeometry(geo, pose) {
  const M = skinMatrices(pose), P = geo.attributes.position.array, N = geo.attributes.normal.array, SI = geo.attributes.skinIndex.array, SW = geo.attributes.skinWeight.array;
  const n = P.length / 3, op = new Float32Array(n * 3), on = new Float32Array(n * 3), e = M.map((m) => m.elements);
  for (let i = 0; i < n; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2], nx = N[i * 3], ny = N[i * 3 + 1], nz = N[i * 3 + 2];
    let px = 0, py = 0, pz = 0, qx = 0, qy = 0, qz = 0;
    for (let k = 0; k < 4; k++) {
      const w = SW[i * 4 + k]; if (!w) continue;
      const m = e[SI[i * 4 + k]];
      px += w * (m[0] * x + m[4] * y + m[8] * z + m[12]); py += w * (m[1] * x + m[5] * y + m[9] * z + m[13]); pz += w * (m[2] * x + m[6] * y + m[10] * z + m[14]);
      qx += w * (m[0] * nx + m[4] * ny + m[8] * nz); qy += w * (m[1] * nx + m[5] * ny + m[9] * nz); qz += w * (m[2] * nx + m[6] * ny + m[10] * nz);
    }
    const l = Math.hypot(qx, qy, qz) || 1;
    op[i * 3] = px; op[i * 3 + 1] = py; op[i * 3 + 2] = pz; on[i * 3] = qx / l; on[i * 3 + 1] = qy / l; on[i * 3 + 2] = qz / l;
  }
  return { position: op, normal: on };
}
/** the waiter's tray: a disc built where the right hand is in the tray pose, mapped back to the prop bone's rest frame */
function buildTray(G, lod) {
  const sides = LODS[lod].tray, M = skinMatrices(trayPose(0))[BONE.prop], inv = M.clone().invert();
  const hand = new THREE.Vector3(...REST[BONE.prop]).applyMatrix4(M);
  const c = new THREE.Vector3(hand.x + 0.02, hand.y + 0.05, hand.z + 0.06), w = W(BONE.prop, 1), v = new THREE.Vector3();
  const ring = (dy, r) => { const row = []; for (let j = 0; j <= sides; j++) { const a = (TAU * j) / sides; v.set(c.x + r * Math.sin(a), c.y + dy, c.z + r * Math.cos(a)).applyMatrix4(inv); row.push(G.vert(v.x, v.y, v.z, 0.5, 0.5, PART.PROP, w)); } return row; };
  const top = ring(0.012, 0.17), bot = ring(-0.004, 0.17);
  v.set(c.x, c.y + 0.012, c.z).applyMatrix4(inv); const ct = G.vert(v.x, v.y, v.z, 0.5, 0.5, PART.PROP, w);
  v.set(c.x, c.y - 0.004, c.z).applyMatrix4(inv); const cb = G.vert(v.x, v.y, v.z, 0.5, 0.5, PART.PROP, w);
  const up = new THREE.Vector3(0, 1, 0).transformDirection(inv), U = [up.x, up.y, up.z];
  for (let j = 0; j < sides; j++) {
    addTri(G, top[j], top[j + 1], ct, U); addTri(G, bot[j], bot[j + 1], cb, [-U[0], -U[1], -U[2]]);
    const pa = P3(G, top[j]), pc = P3(G, ct); addQuad(G, bot[j], bot[j + 1], top[j + 1], top[j], sub(pa, pc));
  }
}

// ------------------------------------------------------------------------------------------------ the VAT
const VAT_CACHE = new Map();
/** Bake every clip of a LOD's crowd body into a half-float RGBA texture (width = verts + 1, height = 2 × frames). */
export function vatFor(lod = 1) {
  if (VAT_CACHE.has(lod)) return VAT_CACHE.get(lod);
  const geo = bodyGeometry(lod, { prop: true }), nv = geo.attributes.position.count, w = nv + 1, frames = CLIP_START._total, h = frames * 2;
  const data = new Uint16Array(w * h * 4), toH = THREE.DataUtils.toHalfFloat;
  let f = 0;
  for (const name of CLIP_NAMES) {
    const [n, fn] = CLIPS[name];
    for (let k = 0; k < n; k++, f++) {
      const pose = fn(k / n), sk = skinGeometry(geo, pose), head = new THREE.Vector3(...REST[BONE.head]).applyMatrix4(skinMatrices(pose)[BONE.head]);
      const rp = f * 2 * w * 4, rn = (f * 2 + 1) * w * 4;
      for (let i = 0; i < nv; i++) {
        data[rp + i * 4] = toH(sk.position[i * 3]); data[rp + i * 4 + 1] = toH(sk.position[i * 3 + 1]); data[rp + i * 4 + 2] = toH(sk.position[i * 3 + 2]); data[rp + i * 4 + 3] = toH(1);
        data[rn + i * 4] = toH(sk.normal[i * 3]); data[rn + i * 4 + 1] = toH(sk.normal[i * 3 + 1]); data[rn + i * 4 + 2] = toH(sk.normal[i * 3 + 2]); data[rn + i * 4 + 3] = toH(0);
      }
      data[rp + nv * 4] = toH(head.x); data[rp + nv * 4 + 1] = toH(head.y); data[rp + nv * 4 + 2] = toH(head.z); data[rp + nv * 4 + 3] = toH(1);
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter; tex.generateMipmaps = false; tex.needsUpdate = true; tex.userData.shared = true; tex.name = `people-vat-${lod}`;
  const vat = { texture: tex, width: w, height: h, frames, verts: nv, bytes: data.byteLength };
  VAT_CACHE.set(lod, vat);
  return vat;
}

// ------------------------------------------------------------------------------------------------ atlas texture
let ATLAS = null;
const ATLAS_USERS = new Set();   // materials whose .map is the atlas (swapped when the KTX2 arrives)
const ATLAS_U = { value: null };
/** 8 × 8 texture of the tiles' mean colours: the stand-in until the KTX2 atlas has loaded (same UVs) */
export function meanAtlas() {
  const d = new Uint8Array(ATLAS_GRID * ATLAS_GRID * 4);
  TILES.forEach(([, , mean], i) => { d[i * 4] = (mean >> 16) & 255; d[i * 4 + 1] = (mean >> 8) & 255; d[i * 4 + 2] = mean & 255; d[i * 4 + 3] = 255; });
  const t = new THREE.DataTexture(d, ATLAS_GRID, ATLAS_GRID, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace; t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true; t.userData.shared = true; t.name = 'people-atlas-mean';
  return t;
}
/** the shared atlas { texture, loaded, ready }: starts on the mean stand-in and loads the KTX2 for this device's tier */
export function peopleAtlas() {
  if (ATLAS) return ATLAS;
  ATLAS = { texture: meanAtlas(), loaded: false, ready: null };
  ATLAS_U.value = ATLAS.texture;
  ATLAS.ready = loadKTX2Texture(ATLAS_URL(currentTier())).then((t) => {
    t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.anisotropy = 4; t.userData.shared = true; t.name = 'people-atlas'; t.needsUpdate = true;
    ATLAS.texture = t; ATLAS.loaded = true; ATLAS_U.value = t;
    for (const m of ATLAS_USERS) { m.map = t; m.needsUpdate = true; }
    return ATLAS;
  }, () => ATLAS);
  return ATLAS;
}
function useAtlas(m) { m.map = peopleAtlas().texture; ATLAS_USERS.add(m); m.addEventListener('dispose', () => ATLAS_USERS.delete(m)); return m; }

// ------------------------------------------------------------------------------------------------ looks
const rng = (seed) => { let a = (seed >>> 0) || 1; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const pick = (r, a) => a[Math.floor(r() * a.length) % a.length];
const HAIR_COLS = [0x151210, 0x2a1d14, 0x4a3320, 0x8a6a3a, 0xc8a85a, 0x9a9a9a, 0xe0e0e0, 0x8a3a1a];
const STREET_TOPS = [0x2f4a7a, 0x7a2f3a, 0x3a6a3a, 0x8a8a8a, 0x1d1d1d, 0xc9a227, 0x5a3a7a, 0x2a7a8a, 0xb85c1e, 0xe8e8e8, 0x4b5d23, 0x6b4a2b];
const STREET_BOTS = [0x1f2a3a, 0x2a2a2a, 0x3b3f46, 0x4a3a2a, 0x23395b, 0x5a5a5a, 0x6b7a8f, 0xb7a98a];
const SHOE_COLS = [0xf0f0f0, 0x1a1a1a, 0x5a3a22, 0x2a3a5a, 0x8a8a8a, 0xb0472e];
/** nearest skin tone index of an sRGB colour */
export function toneOf(hex) {
  let best = 0, bd = Infinity;
  SKIN_TONES.forEach((t, i) => { const d = (((t >> 16) & 255) - ((hex >> 16) & 255)) ** 2 + (((t >> 8) & 255) - ((hex >> 8) & 255)) ** 2 + ((t & 255) - (hex & 255)) ** 2; if (d < bd) { bd = d; best = i; } });
  return best;
}
/**
 * A person's look: { face, hair, top, bottom, shoe (tile indices), skin, hairCol, topCol, botCol, shoeCol (sRGB), shorts, bareArms,
 * h (height scale), w (width scale), cap (the captain's peaked cap) }. kind: 'guest' | 'street' | 'deckcrew' | 'officer' | 'captain' |
 * 'pirate' | a cruise UNIFORMS role ('waiter', 'barman', 'cook', 'cleaner', 'engineer', 'host', 'steward', 'dealer', 'performer',
 * 'nurse', 'crew') | 'swim' | 'kid'.
 */
export function lookFor(kind = 'street', seed = 1, opts = {}) {
  const r = rng((seed ^ 0x9e3779b9) >>> 0);
  const tone = opts.tone ?? Math.floor(r() * SKIN_TONES.length), fem = opts.fem ?? r() < 0.5, old = r() < 0.18;
  const L = { face: tone + (fem ? 8 : 0), skin: SKIN_TONES[tone], hair: TILE.hair_short, hairCol: old ? pick(r, [0x9a9a9a, 0xd8d8d8]) : pick(r, HAIR_COLS),
    top: TILE.top_tee, topCol: 0xffffff, bottom: TILE.bot_trousers, botCol: pick(r, STREET_BOTS), shoe: TILE.shoe_sneaker, shoeCol: pick(r, SHOE_COLS),
    shorts: false, bareArms: false, h: 0.95 + r() * 0.1 - (fem ? 0.04 : 0), w: 0.92 + r() * 0.2 - (fem ? 0.06 : 0), cap: false };
  L.hair = fem ? pick(r, [TILE.hair_long, TILE.hair_bun, TILE.hair_long, TILE.hair_side, TILE.hair_curly]) : pick(r, [TILE.hair_short, TILE.hair_side, TILE.hair_short, TILE.hair_curly]);
  const uni = (top, bot, shoe = TILE.shoe_leather, shoeCol = 0x151515, botCol = 0xffffff) => { L.top = top; L.topCol = 0xffffff; L.bottom = bot; L.botCol = botCol; L.shoe = shoe; L.shoeCol = shoeCol; };
  switch (kind) {
    case 'captain': L.face = opts.tone ?? 1; L.skin = SKIN_TONES[L.face]; L.hair = TILE.hair_short; L.hairCol = opts.hairCol ?? 0x5a5550; uni(TILE.uni_captain, TILE.bot_uniform); L.cap = true; L.h = 1; L.w = 1; break;
    case 'officer': uni(TILE.uni_officer, TILE.bot_uniform); if (r() < 0.5) { L.hair = TILE.hat_officer; L.hairCol = 0xffffff; } break;
    case 'deckcrew': uni(r() < 0.6 ? TILE.uni_hivis_orange : TILE.uni_hivis_yellow, TILE.bot_hivis, TILE.shoe_boot, 0xffffff); L.hair = r() < 0.7 ? (r() < 0.5 ? TILE.hat_hard_white : TILE.hat_hard_yellow) : TILE.hat_beanie; if (L.hair !== TILE.hat_beanie) L.hairCol = 0xffffff; else L.hairCol = pick(r, [0x1d2a44, 0x8a1d1d, 0x2a2a2a]); break;
    case 'engineer': uni(TILE.uni_coverall, TILE.bot_coverall, TILE.shoe_boot, 0xffffff); break;
    case 'waiter': case 'barman': uni(TILE.uni_waiter, TILE.bot_trousers, TILE.shoe_leather, 0x111111, 0x1a1a1f); break;
    case 'dealer': uni(TILE.uni_dealer, TILE.bot_trousers, TILE.shoe_leather, 0x111111, 0x15151a); break;
    case 'cook': uni(TILE.uni_chef, TILE.bot_trousers, TILE.shoe_sneaker, 0x222222, 0x3b3b44); break;
    case 'performer': uni(TILE.uni_performer, TILE.bot_trousers, TILE.shoe_leather, 0x111111, 0x15151a); break;
    case 'cleaner': case 'crew': uni(TILE.uni_cleaner, TILE.bot_trousers, TILE.shoe_sneaker, 0x222222, 0x23395b); break;
    case 'nurse': uni(TILE.uni_scrubs, TILE.bot_trousers, TILE.shoe_sneaker, 0xf0f0f0, 0x9cc6d0); break;
    case 'steward': uni(TILE.uni_steward, TILE.bot_trousers, TILE.shoe_leather, 0x111111, 0x14213d); break;
    case 'host': uni(TILE.uni_host, TILE.bot_trousers, TILE.shoe_leather, 0x111111, 0x14213d); break;
    case 'pirate': uni(TILE.uni_pirate, TILE.bot_chinos, TILE.shoe_boot, 0xffffff, pick(r, [0x3a3328, 0x23282e, 0x4a3a2a])); L.hair = r() < 0.6 ? TILE.hat_bandana : TILE.hat_beanie; L.hairCol = L.hair === TILE.hat_bandana ? 0xffffff : 0x22252a; L.bareArms = r() < 0.4; L.fem = false; L.face = tone; break;
    case 'swim': L.shorts = true; L.bareArms = true; L.top = fem ? TILE.top_swim : TILE.top_bare; L.topCol = fem ? pick(r, [0xe53935, 0x1e88e5, 0xfdd835, 0x43a047, 0x8e24aa, 0x00acc1]) : L.skin; L.bottom = TILE.bot_swim; L.botCol = pick(r, [0xe53935, 0x1e88e5, 0xfdd835, 0x43a047, 0xff7043, 0x8e24aa, 0x00acc1, 0xf06292]); L.shoe = TILE.shoe_bare; L.shoeCol = L.skin; break;
    default: { // guests, kids, pedestrians: holiday or street clothes
      const warm = kind === 'guest' || kind === 'kid';
      L.top = fem ? pick(r, [TILE.top_tee, TILE.top_blouse, TILE.top_tank, TILE.top_stripes, TILE.top_floral, TILE.top_shirt]) : pick(r, warm ? [TILE.top_tee, TILE.top_polo, TILE.top_shirt, TILE.top_stripes, TILE.top_floral] : [TILE.top_tee, TILE.top_polo, TILE.top_shirt, TILE.top_hoodie, TILE.top_blazer, TILE.top_stripes]);
      L.topCol = pick(r, STREET_TOPS);
      L.bottom = pick(r, [TILE.bot_trousers, TILE.bot_jeans, TILE.bot_chinos]); if (L.bottom === TILE.bot_jeans) L.botCol = pick(r, [0x3a5a8a, 0x2a3f66, 0x55657a, 0x1f2a3a]);
      L.shorts = warm && r() < 0.4; L.bareArms = L.top === TILE.top_tank || (warm && r() < 0.5) || (L.top === TILE.top_tee && r() < 0.6);
      if (L.shorts && r() < 0.5) { L.shoe = TILE.shoe_bare; L.shoeCol = L.skin; }
      if (kind === 'kid') { L.h = 0.62 + r() * 0.16; L.w = 0.8 + r() * 0.1; }
    }
  }
  if (opts.evening && (kind === 'guest')) { L.top = fem ? TILE.top_blouse : pick(r, [TILE.top_shirt, TILE.top_blazer]); L.shorts = false; L.bareArms = false; L.shoe = TILE.shoe_leather; L.shoeCol = 0x151515; }
  return L;
}
/** Map a planned look (iv2crowdplan.js lookOf: { skin, hair, top, bottom, shorts, sleeves, h, w, kid }) and role onto tiles. */
export function lookFromPlan(pl, role, seed = 1) {
  const kind = role === 'swim' ? 'swim' : role === 'kid' ? 'kid' : role === 'guest' ? 'guest' : role;
  const L = lookFor(kind, seed, { tone: toneOf(pl.skin) });
  L.skin = SKIN_TONES[toneOf(pl.skin)];
  if (L.hair < TILE.hat_hard_yellow || L.hair === TILE.hat_beanie) L.hairCol = pl.hair;
  if (kind === 'guest' || kind === 'kid') { L.topCol = pl.top; L.botCol = pl.bottom; L.shorts = !!pl.shorts; L.bareArms = !!pl.sleeves || L.top === TILE.top_tank; }
  if (kind === 'swim') { L.botCol = pl.bottom; if (pl.top !== pl.skin) { L.top = TILE.top_swim; L.topCol = pl.top; } else { L.top = TILE.top_bare; L.topCol = L.skin; } L.shoeCol = L.skin; }
  if (L.top === TILE.top_bare) L.topCol = L.skin;
  if (L.shoe === TILE.shoe_bare) L.shoeCol = L.skin;
  L.h = pl.h ?? L.h; L.w = pl.w ?? L.w;
  return L;
}

// ------------------------------------------------------------------------------------------------ crowd material (VAT)
const CROWD_VERT_PARS = /* glsl */`
uniform highp sampler2D uVAT;
uniform float uVATCol;
attribute float aPart;
attribute vec2 aUV;
attribute vec4 iA;
attribute vec4 iT;
attribute vec4 iU;
attribute vec4 iC;
varying vec2 vAtlasUV;
varying vec3 vTint;
vec3 pplRGB(float v) {
  float r = floor(v / 65536.0); float g = floor((v - r * 65536.0) / 256.0); float b = v - r * 65536.0 - g * 256.0;
  vec3 c = vec3(r, g, b) / 255.0;
  return pow(c, vec3(2.2));
}
vec3 pplFetch(float frame, float odd) { return texelFetch(uVAT, ivec2(gl_VertexID, int(frame) * 2 + int(odd)), 0).xyz; }
vec3 pplPivot() { int c = int(uVATCol); return mix(texelFetch(uVAT, ivec2(c, int(iA.x) * 2), 0).xyz, texelFetch(uVAT, ivec2(c, int(iA.y) * 2), 0).xyz, iA.z); }
vec3 pplTurn(vec3 v) { float c = cos(iA.w), s = sin(iA.w); return vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z); }
vec3 pplPos() {
  vec3 p = mix(pplFetch(iA.x, 0.0), pplFetch(iA.y, 0.0), iA.z);
  if (aPart < 1.5) { vec3 pv = pplPivot(); p = pv + pplTurn(p - pv); }
  return p;
}
vec3 pplNrm() {
  vec3 n = normalize(mix(pplFetch(iA.x, 1.0), pplFetch(iA.y, 1.0), iA.z) + vec3(0.0, 1e-4, 0.0));
  if (aPart < 1.5) n = pplTurn(n);
  return n;
}
`;
// tile + tint per vertex (no arrays: a chain of comparisons on aPart)
const CROWD_VERT_TILE = /* glsl */`
{
  float tile = 62.0; vec3 tint = pplRGB(iC.x);
  float shorts = mod(iU.y, 2.0), bare = mod(floor(iU.y / 2.0), 2.0);
  if (aPart < 0.5) { tile = iT.x; tint = vec3(1.0); }
  else if (aPart < 1.5) { tile = iT.y; tint = pplRGB(iC.y); }
  else if (aPart < 3.5) { tile = iT.z; tint = pplRGB(iC.z); }
  else if (aPart < 4.5) { if (bare < 0.5) { tile = iT.z; tint = pplRGB(iC.z); } }
  else if (aPart < 5.5) { tile = 62.0; }
  else if (aPart < 6.5) { tile = iT.w; tint = pplRGB(iC.w); }
  else if (aPart < 7.5) { if (shorts < 0.5) { tile = iT.w; tint = pplRGB(iC.w); } }
  else if (aPart < 8.5) { tile = iU.x; tint = pplRGB(iU.w); }
  else { tile = 63.0; tint = vec3(1.0); }
  float col = mod(tile, 8.0), row = floor(tile / 8.0);
  vAtlasUV = (vec2(col, row) + ${TILE_PAD.toFixed(3)} + vec2(aUV.x, 1.0 - aUV.y) * ${(1 - 2 * TILE_PAD).toFixed(3)}) / 8.0;
  vTint = tint;
}
`;
const MATS = new Map();
export const PEOPLE_U = { uLit: { value: 1 } };
/**
 * The shared crowd material of a LOD: 'basic' (interiors: unlit, a fixed key light × uLit, like the v2 rooms) or
 * 'standard' (outdoors: scene lights). Shared (userData.shared), never disposed by callers.
 */
export function crowdMaterial(lod = 1, lit = 'basic') {
  const key = `${lod}|${lit}`;
  if (MATS.has(key)) return MATS.get(key);
  const vat = vatFor(lod), atlas = peopleAtlas();
  const m = lit === 'standard' ? new THREE.MeshStandardMaterial({ roughness: 0.78, metalness: 0 }) : new THREE.MeshBasicMaterial();
  const U = { uVAT: { value: vat.texture }, uVATCol: { value: vat.width - 1 }, uAtlas: ATLAS_U, uLit: PEOPLE_U.uLit };
  void atlas;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    let vs = sh.vertexShader.replace('#include <common>', '#include <common>\n' + CROWD_VERT_PARS + (lit === 'basic' ? 'varying float vShade; uniform float uLit;\n' : ''));
    if (lit === 'basic') {
      vs = vs.replace('#include <begin_vertex>', `vec3 transformed = pplPos();
        { vec3 wn = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * pplNrm());
          vShade = (0.5 + 0.34 * max(wn.y, 0.0) + 0.16 * max(dot(wn, normalize(vec3(0.45, 0.35, 0.82))), 0.0) + 0.1 * abs(wn.x)) * iU.z * uLit; }
        ${CROWD_VERT_TILE}`);
    } else {
      vs = vs.replace('#include <beginnormal_vertex>', 'vec3 objectNormal = pplNrm();\n#ifdef USE_TANGENT\nvec3 objectTangent = vec3(1.0, 0.0, 0.0);\n#endif')
        .replace('#include <begin_vertex>', `vec3 transformed = pplPos();\n${CROWD_VERT_TILE}`);
    }
    sh.vertexShader = vs;
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>\nuniform sampler2D uAtlas; varying vec2 vAtlasUV; varying vec3 vTint;${lit === 'basic' ? ' varying float vShade;' : ''}`)
      .replace('#include <map_fragment>', `diffuseColor.rgb *= texture2D(uAtlas, vAtlasUV).rgb * vTint${lit === 'basic' ? ' * vShade' : ''};`);
  };
  m.customProgramCacheKey = () => `people-crowd-${lit}`;
  m.userData.shared = true; m.userData.peopleU = U; m.name = `people:crowd:${lod}:${lit}`;
  MATS.set(key, m);
  return m;
}

// ------------------------------------------------------------------------------------------------ PeopleCrowd
const _m4 = new THREE.Matrix4(), _p = new THREE.Vector3(), _sc = new THREE.Vector3(), _qq = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0);
const _iA = [0, 0, 0, 0];
/**
 * An instanced crowd: one draw call for up to `capacity` people of one LOD (0 near, 1 far). set(k, …) poses slot k,
 * commit(n) uploads the first n. opts: { lod, lit ('basic' | 'standard'), name }.
 */
export class PeopleCrowd {
  constructor(capacity, opts = {}) {
    this.capacity = Math.max(1, capacity | 0); this.lod = opts.lod ?? 1; this.lit = opts.lit || 'basic';
    const base = bodyGeometry(this.lod, { prop: true });
    const g = new THREE.BufferGeometry();
    for (const n of ['position', 'aUV', 'aPart']) g.setAttribute(n, base.attributes[n]);
    g.setIndex(base.index);
    const cap = this.capacity;
    this.iA = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4); this.iT = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    this.iU = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4); this.iC = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    for (const a of [this.iA, this.iT, this.iU, this.iC]) a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iA', this.iA); g.setAttribute('iT', this.iT); g.setAttribute('iU', this.iU); g.setAttribute('iC', this.iC);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 1.3); g.boundingBox = base.boundingBox.clone();
    g.userData.tris = base.userData.tris;
    this.mesh = new THREE.InstancedMesh(g, crowdMaterial(this.lod, this.lit), cap);
    this.mesh.name = opts.name || `people:crowd:lod${this.lod}`; this.mesh.count = 0; this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.userData.tris = base.userData.tris; this.mesh.userData.people = this;
    this.count = 0;
  }
  get tris() { return this.mesh.userData.tris; }
  /**
   * Pose slot k: feet at (x, y, z), facing yaw (rad, 0 = +z), scale [sx, sy, sz] (or one number), look (lookFor /
   * lookFromPlan), clip + phase (0…1, loops), headYaw (rad, + = to the person's left), lit (0…1 brightness, basic only).
   */
  set(k, x, y, z, yaw, scale, look, clip, phase, headYaw = 0, lit = 1) {
    if (k < 0 || k >= this.capacity) return;
    const s = typeof scale === 'number' ? [scale, scale, scale] : scale;
    _qq.setFromAxisAngle(_up, yaw); _m4.compose(_p.set(x, y, z), _qq, _sc.set(s[0], s[1], s[2]));
    this.mesh.setMatrixAt(k, _m4);
    const f = frameOf(clip, phase);
    this.iA.array.set([f[0], f[1], f[2], headYaw], k * 4);
    this.setLook(k, look, lit);
  }
  setLook(k, L, lit = 1) {
    const o = k * 4, T = this.iT.array, U = this.iU.array, C = this.iC.array;
    T[o] = L.face; T[o + 1] = L.hair; T[o + 2] = L.top; T[o + 3] = L.bottom;
    U[o] = L.shoe; U[o + 1] = (L.shorts ? 1 : 0) + (L.bareArms ? 2 : 0); U[o + 2] = lit; U[o + 3] = L.shoeCol;
    C[o] = L.skin; C[o + 1] = L.hairCol; C[o + 2] = L.topCol; C[o + 3] = L.botCol;
  }
  /** draw the first n slots (uploads what changed) */
  commit(n) {
    this.count = this.mesh.count = clamp(n | 0, 0, this.capacity);
    this.mesh.visible = this.count > 0;
    if (!this.count) return;
    this.mesh.instanceMatrix.needsUpdate = true;
    for (const a of [this.iA, this.iT, this.iU, this.iC]) { a.needsUpdate = true; a.addUpdateRange?.(0, this.count * 4); }
  }
  dispose() { this.mesh.parent?.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh.dispose?.(); }
}
void _iA;

// ------------------------------------------------------------------------------------------------ static (baked) people
/** atlas UV + linear colour of one vertex of a look */
function vertexLook(L, part, u, v, packed) {
  let tile = TILE.plain, col = L.skin;
  switch (part) {
    case PART.FACE: tile = L.face; col = 0xffffff; break;
    case PART.HAIR: tile = L.hair; col = L.hairCol; break;
    case PART.TORSO: case PART.UARM: tile = L.top; col = L.topCol; break;
    case PART.LARM: if (!L.bareArms) { tile = L.top; col = L.topCol; } break;
    case PART.THIGH: tile = L.bottom; col = L.botCol; break;
    case PART.SHIN: if (!L.shorts) { tile = L.bottom; col = L.botCol; } break;
    case PART.SHOE: tile = L.shoe; col = L.shoeCol; break;
    case PART.PROP: tile = TILE.prop_tray; col = 0xffffff; break;
    case PART.CAP: tile = TILE.plain; col = packed >= 0 ? packed : 0x1c2338; break;
    default: break;
  }
  return [atlasUV(tile, u, v), col];
}
const _c = new THREE.Color();
/** bake a look into a geometry's `uv` (atlas) and `color` (linear tint) attributes */
function applyLook(g, L) {
  const part = g.attributes.aPart.array, luv = g.attributes.aUV.array, pc = g.attributes.aCol.array, n = part.length;
  const uv = new Float32Array(n * 2), col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const [a, hex] = vertexLook(L, part[i], luv[i * 2], luv[i * 2 + 1], pc[i]);
    uv[i * 2] = a[0]; uv[i * 2 + 1] = a[1];
    _c.setHex(hex); col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}
let STATIC_MAT = null;
/** the shared material of baked / skinned people: the atlas × vertex colour (shared: never disposed by a ship) */
export function staticMaterial() {
  if (STATIC_MAT) return STATIC_MAT;
  STATIC_MAT = useAtlas(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0 }));
  STATIC_MAT.userData.shared = true; STATIC_MAT.name = 'people:static';
  return STATIC_MAT;
}
/**
 * Baked, unanimated people merged into one mesh (ship deck crew, a scale reference): figures = [{ x, y, z, yaw (rad, 0 =
 * +z), look, clip, phase, scale }]. One draw call; disposable geometry, shared material. opts: { lod (default 1) }.
 */
export function makeFigures(figures, opts = {}) {
  const lod = opts.lod ?? 1, base = bodyGeometry(lod, {}), nv = base.attributes.position.count, idx = base.index.array;
  const P = new Float32Array(nv * 3 * figures.length), N = new Float32Array(nv * 3 * figures.length), UV = new Float32Array(nv * 2 * figures.length), C = new Float32Array(nv * 3 * figures.length);
  const I = new (nv * figures.length > 65535 ? Uint32Array : Uint16Array)(idx.length * figures.length);
  const tmp = new THREE.BufferGeometry(); for (const n of ['aPart', 'aUV', 'aCol']) tmp.setAttribute(n, base.attributes[n]);
  figures.forEach((f, k) => {
    const sk = skinGeometry(base, poseOf(f.clip || 'idle', f.phase || 0)), L = f.look || lookFor('deckcrew', k + 1), s = f.scale ?? L.h ?? 1;
    applyLook(tmp, L);
    const c = Math.cos(f.yaw || 0), sn = Math.sin(f.yaw || 0), w = (L.w ?? 1) * s;
    for (let i = 0; i < nv; i++) {
      const x = sk.position[i * 3] * w, y = sk.position[i * 3 + 1] * s, z = sk.position[i * 3 + 2] * w, o = (k * nv + i) * 3;
      P[o] = f.x + c * x + sn * z; P[o + 1] = f.y + y; P[o + 2] = f.z - sn * x + c * z;
      const nx = sk.normal[i * 3], nz = sk.normal[i * 3 + 2];
      N[o] = c * nx + sn * nz; N[o + 1] = sk.normal[i * 3 + 1]; N[o + 2] = -sn * nx + c * nz;
    }
    UV.set(tmp.attributes.uv.array, k * nv * 2); C.set(tmp.attributes.color.array, k * nv * 3);
    for (let t = 0; t < idx.length; t++) I[k * idx.length + t] = idx[t] + k * nv;
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3)); g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(UV, 2)); g.setAttribute('color', new THREE.BufferAttribute(C, 3));
  g.setIndex(new THREE.BufferAttribute(I, 1)); g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, staticMaterial());
  mesh.name = 'people:figures'; mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.userData.tris = (idx.length / 3) * figures.length;
  return mesh;
}

/**
 * Deck crew on a ship (ship.js, the human scale reference): spots [[x, y, z, ry?, kind?, clip?]…] in the ship frame
 * (forward = −z; ry as ship.js turns things: 0 faces forward) → a THREE.LOD holding one merged figure mesh near by
 * (≤ `far` m, default 260) and nothing beyond. Without a kind the first spot is the officer on the bridge wing and the
 * others deck crew in hi-vis, turned a little at random; seed varies them.
 */
export function crewFigures(spots, seed = 1, opts = {}) {
  const figs = spots.map(([x, y, z, ry, kind, clip], i) => ({ x, y, z, yaw: Math.PI - (ry ?? 0) + (kind ? 0 : (((seed + i * 13) % 7) - 3) * 0.25),
    look: lookFor(kind || (i === 0 && opts.officerFirst !== false ? 'officer' : 'deckcrew'), (seed * 97 + i * 31) >>> 0), clip: clip || 'idle', phase: ((seed + i) % 5) / 5 }));
  const lod = new THREE.LOD(); lod.name = 'people:crew';
  if (figs.length) lod.addLevel(makeFigures(figs, { lod: 1 }), 0);
  lod.addLevel(new THREE.Object3D(), opts.far ?? 260);
  return lod;
}

// ------------------------------------------------------------------------------------------------ the skinned person (captain, boarders)
/**
 * A skinned person (THREE.SkinnedMesh, LOD0 by default) inside a group that faces −z at rotation.y = 0 (the walk-mode
 * convention), feet at y = 0. opts: { look (lookFor), kind ('captain'), seed, lod, scale, clip (the idle clip: 'idle' |
 * 'hold' | 'wave' …) }. userData: animate(dt, moving, running) → 0 (the gait's bob is in the pose), look(yawRel, pitch)
 * (head turn: yawRel = camera yaw − body yaw, + = to the right as the walk modes count yaw), setClip(name), dispose().
 */
export function makePerson(opts = {}) {
  const look = opts.look || lookFor(opts.kind || 'captain', opts.seed ?? 1);
  const lod = opts.lod ?? 0;
  const g = applyLook(bodyGeometry(lod, { cap: !!look.cap }).clone(), look);
  g.deleteAttribute('aUV'); g.deleteAttribute('aPart'); g.deleteAttribute('aCol');
  g.userData = { tris: g.index.count / 3 };
  const bones = BONES.slice(0, SKELETON_BONES).map((n) => { const b = new THREE.Bone(); b.name = n; return b; });
  bones.forEach((b, i) => { const par = PARENT[i]; if (par >= 0) { bones[par].add(b); b.position.set(REST[i][0] - REST[par][0], REST[i][1] - REST[par][1], REST[i][2] - REST[par][2]); } else b.position.set(...REST[i]); });
  const mat = useAtlas(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0 }));
  const mesh = new THREE.SkinnedMesh(g, mat);
  mesh.name = 'person'; mesh.add(bones[0]); mesh.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones));
  mesh.castShadow = true; mesh.receiveShadow = true; mesh.frustumCulled = false;
  const inner = new THREE.Group(); inner.name = 'body'; inner.rotation.y = Math.PI; inner.add(mesh);
  const outer = new THREE.Group(); outer.name = opts.name || 'person'; outer.add(inner);
  const sc = (opts.scale ?? 1) * (look.h ?? 1); inner.scale.set(sc * (look.w ?? 1), sc, sc * (look.w ?? 1));
  // state: gait phase, blend weights, idle clock, head look
  const st = { ph: 0, walk: 0, run: 0, t: Math.random() * 10, yaw: 0, pitch: 0, wantYaw: 0, wantPitch: 0, clip: opts.clip || 'idle' };
  const pose = blank(), tmp = blank();
  const apply = () => {
    for (let b = 0; b < SKELETON_BONES; b++) bones[b].rotation.set(pose[b * 3], pose[b * 3 + 1], pose[b * 3 + 2], 'XYZ');
    bones[0].position.set(REST[0][0] + pose[60], REST[0][1] + pose[61], REST[0][2] + pose[62]);
    // the head and neck share the look (yaw about the body's up, pitch about its side)
    bones[BONE.neck].rotation.y += st.yaw * 0.4; bones[BONE.head].rotation.y += st.yaw * 0.6;
    bones[BONE.neck].rotation.x += st.pitch * 0.35; bones[BONE.head].rotation.x += st.pitch * 0.5;
  };
  const step = (dt, moving = false, running = false) => {
    dt = clamp(Number(dt) || 0, 0, 0.25);
    st.t += dt;
    const k = Math.min(1, dt * 6);
    st.walk += ((moving ? 1 : 0) - st.walk) * k; st.run += ((moving && running ? 1 : 0) - st.run) * k;
    st.ph = (st.ph + dt * (moving ? (running ? 1.45 : 0.95) : 0.3 * st.walk)) % 1;
    const idle = poseOf(st.clip, (st.t * 0.22) % 1);
    if (st.walk > 0.001) {
      blendPose(walkG(st.ph), runG(st.ph), st.run, tmp);
      blendPose(idle, tmp, st.walk, pose);
    } else pose.set(idle);
    const hk = Math.min(1, dt * 8);
    st.yaw += (st.wantYaw - st.yaw) * hk; st.pitch += (st.wantPitch - st.pitch) * hk;
    apply();
    return 0;
  };
  step(0);
  outer.userData = {
    mesh, bones, look, body: inner,
    animate: step,
    /** head look: yawRel (rad, + = right, like the walk modes' yaw), pitch (rad, + = up) */
    look(yawRel = 0, pitch = 0) {
      const y = Math.atan2(Math.sin(yawRel), Math.cos(yawRel));
      st.wantYaw = clamp(-y, -1.1, 1.1); st.wantPitch = clamp(-pitch * 0.7, -0.6, 0.5);
    },
    setClip(name) { if (CLIPS[name]) st.clip = name; },
    dispose() { g.dispose(); mat.dispose(); mesh.skeleton?.dispose?.(); outer.parent?.remove(outer); },
  };
  return outer;
}
/** the captain / player crew member: navy double-breasted uniform, peaked cap, epaulettes (walk mode, ashore) */
export function makeCaptain(opts = {}) { return makePerson({ ...opts, look: opts.look || lookFor('captain', opts.seed ?? 1), name: 'captain' }); }
/**
 * A boarder for hostile.js: a skinned pirate in the 'hold' stance (children[0] is the body group, so the existing sway on
 * children[0].rotation.z keeps working). seed varies the looks. userData.animate(dt, moving, running).
 */
export function makeBoarder(seed = 1, opts = {}) {
  const p = makePerson({ look: lookFor('pirate', 1000 + seed), clip: opts.clip || 'hold', lod: opts.lod ?? 1, name: 'boarder' });
  p.userData.animate(0.1 + (seed % 7) * 0.13);
  return p;
}

// ------------------------------------------------------------------------------------------------ numbers (tests, diagnostics)
/** GPU bytes of the people system: VATs of the LODs in use + the atlas (desktop BC7 1 B/px, phone ETC1 0.5 B/px, full mips) */
export function peopleBytes(tier = 'desktop', lods = [0, 1]) {
  const atlasPx = tier === 'phone' ? 512 : 1024, bpp = tier === 'phone' ? 0.5 : 1;
  let atlas = 0; for (let s = atlasPx; s >= 1; s >>= 1) atlas += Math.max(4, s) * Math.max(4, s) * bpp;
  let vat = 0; for (const l of lods) vat += vatFor(l).bytes;
  return { atlas: Math.round(atlas), vat, total: Math.round(atlas) + vat };
}
