// Parametric exterior generators (docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §6, Lane B): one GA record (§6.2) →
// a three.js ship at real scale (1 unit = 1 m) with three levels of detail and the §6.6 budgets.
//
//   buildFromGA(ga, opts) → { group, lods, info }
//     ga    the general arrangement (Lane C's shared/ships/ga.js, or the local stand-in public/js/gastub.js)
//     opts  { phone, lod: 'all'|0|1|2, cargo (draw cargo: containers, trailers), seed, name, decals, stage,
//             makeMat(kind, color, params) (ship.js passes its wear materials), rails, hd }
//     hd    (the player's own ship, docs/HD-ASSET-PLAN.md phase 1) LOD0 only: dense loft (90 stations, 13 + 10 rows;
//           45 stations on phones), superstructure tiers with a 0.1 m bevel, lathe-turned funnel with a lip and a
//           hollow top. Same material keys, so the draw calls do not change.
//
// Frame as ship.js: forward = −z, starboard = +x, y = 0 at the design waterline. Static parts are merged per material
// (one mesh per material, vertex colours for the painted bits), so a ship is 8–14 draw calls at LOD0 whatever its size.
// Repeated fittings (rail stanchions and bars, balcony dividers, lifeboats, davits, bollards, tyres, lattice bracing,
// whips) are instanced on desktop — one InstancedMesh per fitting type and material (Parts.imat) — and baked into
// the merged meshes on phones (their 16-call budget), at half the count.
// The hull is lofted (shipgeom.js) from L/B/T/depth/Cb; houses use a procedural facade texture (window rows, balconies,
// bridge glass), container stacks one textured box per stack. Sail classes are not built here (SAILING's rigmesh.js).
// Build stages for the yard preview (§4.7): stage < 0.25 keel blocks, < 0.65 hull only (clip plane set by the
// preview, userData.clipY), < 0.9 everything in primer, ≥ 0.9 full livery.
import * as THREE from 'three';
import { MODELS } from '../../shared/ships/index.js';
import { loftHull, hullForm, bayStacks, lodDistances, HD_STATIONS } from './shipgeom.js';
import { hashStr, rng } from './models.js';
import { cruiseProfile } from '../../shared/ships/cruiseprofile.js';
import { PRESETS, hullModeOf, deckModeOf } from './shipskinfmt.js';

const HAS_DOM = typeof document !== 'undefined' && typeof document.createElement === 'function';
const clamp = (lo, hi, v) => Math.max(lo, Math.min(hi, v));
const COL = {
  white: 0xf0f1ee, offwhite: 0xdfe2e0, dark: 0x22262b, steel: 0x8a9199, light: 0xc9cdd0, orange: 0xf26b1d, yellow: 0xf2b134, red: 0xb83224,
  grey: 0x9ea3a8, rubber: 0x17191c, blue: 0x2a6fb0, green: 0x2e6b4f, teak: 0xb08a5a, pool: 0x3fb7d9, helideck: 0x3f5a46, primer: 0x9aa0a6,
  redOxide: 0x7a3b2e, bronze: 0xb08d57, deckGreen: 0x4d6b55, deckRed: 0x7b3a33, hatchRed: 0x8c3b2f, hatchGrey: 0x6f757c, catwalk: 0xd8c23a,
};
/** a colour darkened (k < 1) or lightened (k > 1) */
function shade(hex, k) { const r = Math.min(255, ((hex >> 16) & 255) * k) | 0, g = Math.min(255, ((hex >> 8) & 255) * k) | 0, b = Math.min(255, (hex & 255) * k) | 0; return (r << 16) | (g << 8) | b; }
const CONTAINER_PALETTE = [0xb5372b, 0x2e6fa8, 0x2f8a55, 0xd99a2b, 0x7d4f9e, 0x8a8f94, 0xc8622a, 0x23867a, 0xe0e0dc, 0x1f3a5f, 0x9c2f45, 0x5a6b2f];

// ------------------------------------------------------------------------------------------------ shared textures (browser)
let CONTAINERS = null;
const FACADES = new Map();   // atlas size → texture
const BANDS = { cabins: 0, balcony: 1, glass: 2, blank: 3 };
/** metres of facade one atlas width covers, per band (cabins, balconies, glass band, blank wall) */
const BAND_TILE = [18, 8.4, 12, 10];
/**
 * 4-band facade atlas in metres: merchant cabins (framed windows at irregular spacing, a door, vent grilles, weep
 * streaks), cruise balconies, the big-window / bridge glass band with mullions, blank plated wall. The ALPHA channel
 * is a mask the skin shader reads: 1 wall, 0.75 glass, 0.5 glass that is lit at night (so windows reflect the sky by
 * day and glow by night without another texture). size: 1024 desktop, 512 phones.
 */
function facadeTexture(size = 1024) {
  if (!HAS_DOM) return null;
  if (FACADES.has(size)) return FACADES.get(size);
  const W = size, H = size, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'), bh = H / 4, r = rng(4242);
  const glass = [];   // [x, y, w, h, lit]
  const top = (k) => H - (k + 1) * bh;                        // canvas top of band k (flipY: band 0 at the bottom)
  // band-local coordinates: x in metres along the tile, f = height fraction of the tier (0 deck … 1 deckhead)
  const X = (k, m) => (m / BAND_TILE[k]) * W;
  const Y = (k, f) => top(k) + bh * (1 - (0.03 + 0.94 * f));
  const rect = (k, m0, f0, m1, f1) => [X(k, m0), Y(k, f1), X(k, m1) - X(k, m0), Y(k, f0) - Y(k, f1)];
  const rr = (x, y, w, h, rad) => { g.beginPath(); g.moveTo(x + rad, y); g.arcTo(x + w, y, x + w, y + h, rad); g.arcTo(x + w, y + h, x, y + h, rad); g.arcTo(x, y + h, x, y, rad); g.arcTo(x, y, x + w, y, rad); g.closePath(); };
  const tone = (hex, k) => { const v = parseInt(hex.slice(1), 16); const c = (sh) => Math.min(255, (((v >> sh) & 255) * k) | 0); return `rgb(${c(16)},${c(8)},${c(0)})`; };
  const wall = (k, base) => {
    const t = top(k); g.fillStyle = base; g.fillRect(0, t, W, bh);
    for (let m = 0; m < BAND_TILE[k]; m += 2.0) { g.fillStyle = `rgba(0,0,0,${(0.012 + r() * 0.03).toFixed(3)})`; g.fillRect(X(k, m), t, X(k, 2.0), bh); }   // plate-to-plate tonal variation
    g.fillStyle = 'rgba(0,0,0,0.10)'; g.fillRect(0, Y(k, 0.035), W, bh * 0.035);          // deck line / toe of the bulkhead
    g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(0, Y(k, 1.0), W, bh * 0.012);       // drip rail at the deckhead
    g.fillStyle = 'rgba(0,0,0,0.045)'; for (let m = 0; m < BAND_TILE[k]; m += 2.0) g.fillRect(X(k, m), t, Math.max(1, W / 900), bh);   // plate seams
    for (let i = 0; i < 40; i++) { g.fillStyle = `rgba(${100 + r() * 40 | 0},${90 + r() * 30 | 0},${80 + r() * 20 | 0},${0.02 + r() * 0.03})`; g.fillRect(r() * W, t + r() * bh, W * (0.01 + r() * 0.04), bh * (0.2 + r() * 0.6)); }   // grime
  };
  const window_ = (k, m0, f0, m1, f1, lit, frame = '#b9c0c5') => {
    const [x, y, w, h] = rect(k, m0, f0, m1, f1), fw = Math.max(2, W * 0.08 / BAND_TILE[k]);
    // every window a little different: frame tone, glass brightness, blind / curtain, so the row never reads as a stamp
    const ft = 0.86 + r() * 0.2, gt = 0.75 + r() * 0.5;
    g.fillStyle = 'rgba(0,0,0,0.42)'; rr(x - fw * 1.35, y - fw * 1.35 + 1, w + fw * 2.7, h + fw * 2.7, fw * 1.6); g.fill();   // dark outline: the frame reads from afar
    g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(x - fw * 1.3, y - fw * 1.3, w + fw * 2.6, fw * 1.1);                           // the recess' top shadow
    g.fillStyle = tone(frame, ft); rr(x - fw, y - fw, w + fw * 2, h + fw * 2, fw * 1.4); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(x - fw, y + h + fw * 0.3, w + fw * 2, fw * 0.5);                          // the sill catching the light
    const gr = g.createLinearGradient(0, y, 0, y + h); gr.addColorStop(0, tone('#3a5670', gt)); gr.addColorStop(0.45, tone('#1d3247', gt)); gr.addColorStop(1, tone('#0f1c29', gt));
    g.fillStyle = gr; g.fillRect(x, y, w, h);
    g.fillStyle = 'rgba(0,0,0,0.45)'; g.fillRect(x, y, w, Math.max(1, h * 0.08));                                                // glass in the frame's shadow
    const cur = r();
    if (cur < 0.3) { g.fillStyle = r() < 0.5 ? 'rgba(214,200,168,0.6)' : 'rgba(150,160,170,0.55)'; g.fillRect(x + w * (r() < 0.5 ? 0 : 0.6), y, w * 0.4, h); }        // curtains
    else if (cur < 0.5) { g.fillStyle = 'rgba(225,222,210,0.75)'; g.fillRect(x, y, w, h * (0.3 + r() * 0.5)); }                                                       // blind half down
    glass.push([x, y, w, h, lit]);
    // dirt and rust weeping from the sill and the lower corners (grey rain streaks, rust from the frame's bolts)
    const n = 1 + (r() * 3 | 0);
    for (let i = 0; i < n; i++) { const sx = x - fw + (w + fw * 2) * r(), sw = Math.max(1, fw * (0.4 + r() * 0.6)), sh = bh * (0.06 + r() * 0.22); const gs = g.createLinearGradient(0, y + h + fw, 0, y + h + fw + sh); gs.addColorStop(0, 'rgba(70,72,74,0.28)'); gs.addColorStop(1, 'rgba(70,72,74,0)'); g.fillStyle = gs; g.fillRect(sx, y + h + fw, sw, sh); }
    g.fillStyle = 'rgba(120,64,30,0.16)'; for (const sx of [x - fw, x + w + fw * 0.4]) if (r() < 0.6) g.fillRect(sx, y + h + fw, Math.max(1, fw * 0.6), bh * (0.08 + r() * 0.18));
  };
  // band 0: merchant cabins — windows ~0.95 × 0.85 m in pairs and singles, a steel door, vent grilles
  wall(0, '#f2f3f0');
  for (const m of [1.2, 2.5, 5.3, 6.6, 8.9, 12.0, 13.3, 15.6, 16.9]) window_(0, m - 0.47, 0.38, m + 0.47, 0.7, r() < 0.5);
  { const [x, y, w, h] = rect(0, 10.15, 0.04, 10.95, 0.78); g.fillStyle = '#d6dadc'; rr(x, y, w, h, w * 0.12); g.fill(); g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = Math.max(1, W / 700); g.stroke();
    g.fillStyle = '#9aa1a6'; g.fillRect(x + w * 0.78, y + h * 0.5, w * 0.1, h * 0.04); }
  for (const m of [3.9, 14.45]) { const [x, y, w, h] = rect(0, m - 0.25, 0.78, m + 0.25, 0.9); g.fillStyle = '#d0d4d6'; g.fillRect(x, y, w, h); g.fillStyle = 'rgba(0,0,0,0.4)'; for (let i = 1; i < 5; i++) g.fillRect(x + 2, y + h * i / 5, w - 4, Math.max(1, h * 0.06)); }
  // band 1: the cabin wall behind a balcony (the balcony itself — floor, glass balustrade, dividers — is geometry, see
  // balconyRow): a full-height sliding glass door in a dark frame with a mullion, a narrow wall pier between cabins
  wall(1, '#eceeeb');
  for (let i = 0; i < 3; i++) {
    const m = i * 2.8;
    window_(1, m + 0.3, 0.05, m + 1.38, 0.9, r() < 0.55, '#5d666d');
    window_(1, m + 1.42, 0.05, m + 2.5, 0.9, r() < 0.4, '#5d666d');
  }
  // band 2: continuous window band with mullions (bridge front, public rooms)
  wall(2, '#f2f3f0');
  for (let m = 0; m < BAND_TILE[2] - 0.01; m += 1.2) window_(2, m + 0.06, 0.28, m + 1.14, 0.86, r() < 0.75, '#b9c1c6');
  // band 3: blank wall with seams, a vent and a lamp
  wall(3, '#f3f4f1');
  { const [x, y, w, h] = rect(3, 6.0, 0.55, 6.6, 0.8); g.fillStyle = '#cfd3d5'; g.fillRect(x, y, w, h); g.fillStyle = 'rgba(0,0,0,0.35)'; for (let i = 1; i < 6; i++) g.fillRect(x + 2, y + h * i / 6, w - 4, Math.max(1, h * 0.05)); }
  // alpha mask: glass 0.75 (unlit) / 0.5 (lit at night)
  const img = g.getImageData(0, 0, W, H), d = img.data;
  for (const [x, y, w, h, lit] of glass) {
    const a = lit ? 128 : 191;
    for (let yy = Math.max(0, Math.ceil(y)); yy < Math.min(H, Math.floor(y + h)); yy++) for (let xx = Math.max(0, Math.ceil(x)); xx < Math.min(W, Math.floor(x + w)); xx++) d[(yy * W + xx) * 4 + 3] = a;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; t.premultiplyAlpha = false;
  t.userData.shared = true;
  FACADES.set(size, t);
  return t;
}
/** container stack atlas: 16 columns × 16 slots, random company colours, corrugated sides */
function containerTexture() {
  if (!HAS_DOM) return null;
  if (CONTAINERS) return CONTAINERS;
  const W = 512, H = 512, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'), r = rng(9187), cw = W / 16, chh = H / 16;
  for (let col = 0; col < 16; col++) for (let s = 0; s < 16; s++) {
    const hex = CONTAINER_PALETTE[Math.floor(r() * CONTAINER_PALETTE.length)];
    const x = col * cw, y = H - (s + 1) * chh;
    const rr = (hex >> 16) & 255, gg = (hex >> 8) & 255, bb = hex & 255, k = 0.85 + r() * 0.25;
    g.fillStyle = `rgb(${Math.min(255, rr * k) | 0},${Math.min(255, gg * k) | 0},${Math.min(255, bb * k) | 0})`; g.fillRect(x, y, cw, chh);
    g.fillStyle = 'rgba(0,0,0,0.18)'; for (let i = 3; i < cw; i += 4) g.fillRect(x + i, y + 2, 1, chh - 4);
    g.fillStyle = 'rgba(0,0,0,0.45)'; g.fillRect(x, y + chh - 2, cw, 2); g.fillRect(x, y, 1, chh);
    g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(x, y, cw, 2);
  }
  CONTAINERS = new THREE.CanvasTexture(c);
  CONTAINERS.wrapS = CONTAINERS.wrapT = THREE.ClampToEdgeWrapping; CONTAINERS.colorSpace = THREE.SRGBColorSpace; CONTAINERS.anisotropy = 4;
  CONTAINERS.userData.shared = true;
  return CONTAINERS;
}
/** name + company mark decal atlas for one ship (name: top half; mark disc: bottom-left quarter) */
function decalTexture(name, livery) {
  if (!HAS_DOM) return null;
  const W = 1024, H = 512, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.clearRect(0, 0, W, H);
  const hex = (v) => '#' + (v >>> 0).toString(16).padStart(6, '0');
  if (name) {
    g.fillStyle = hex(livery.nameColor ?? 0xffffff); g.textAlign = 'center'; g.textBaseline = 'middle';
    let fs = 150; g.font = `700 ${fs}px "Segoe UI", Arial, sans-serif`;
    while (g.measureText(name.toUpperCase()).width > W - 40 && fs > 40) { fs -= 8; g.font = `700 ${fs}px "Segoe UI", Arial, sans-serif`; }
    g.fillText(name.toUpperCase(), W / 2, H * 0.25);
  }
  if (livery.mark) {
    const cx = H * 0.25, cy = H * 0.75, rad = H * 0.22;
    g.fillStyle = hex(livery.band ?? 0xffffff); g.beginPath(); g.arc(cx, cy, rad, 0, Math.PI * 2); g.fill();
    g.fillStyle = hex(livery.funnel === (livery.band ?? 0xffffff) ? 0x1b1b1b : livery.funnel); g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `800 ${livery.mark.length > 1 ? 120 : 160}px "Segoe UI", Arial, sans-serif`;
    g.fillText(livery.mark.startsWith('icon:') ? '★' : livery.mark, cx, cy + 6);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

const MARKS = new Map();
/** company mark for the funnel only (disc in the funnel band colour, letters in the funnel colour), shared per livery */
function markTexture(livery) {
  if (!HAS_DOM || !livery.mark) return null;
  const disc = livery.funnelBand ?? livery.band ?? 0xffffff;
  const key = `${livery.mark}|${disc}|${livery.funnel}`;
  if (MARKS.has(key)) return MARKS.get(key);
  const S = 256, c = document.createElement('canvas'); c.width = S; c.height = S;
  const g = c.getContext('2d'), hex = (v) => '#' + (v >>> 0).toString(16).padStart(6, '0');
  g.fillStyle = hex(disc); g.beginPath(); g.arc(S / 2, S / 2, S * 0.46, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = S * 0.015; g.stroke();
  g.fillStyle = hex(livery.funnel === disc ? 0x1b1b1b : livery.funnel); g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `800 ${livery.mark.length > 1 ? 104 : 150}px "Segoe UI", Arial, sans-serif`;
  g.fillText(livery.mark.startsWith('icon:') ? '\u2605' : livery.mark, S / 2, S / 2 + 6);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; t.userData.shared = true;
  if (MARKS.size > 32) { for (const v of MARKS.values()) v.dispose(); MARKS.clear(); }
  MARKS.set(key, t);
  return t;
}

// ------------------------------------------------------------------------------------------------ geometry collector
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);
function xf(x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) { _p.set(x, y, z); _e.set(rx, ry, rz, 'YXZ'); _q.setFromEuler(_e); _s.set(sx, sy, sz); return _m.compose(_p, _q, _s); }
const _c = new THREE.Color();
/**
 * Unit geometries for the instanced fittings (one InstancedMesh per fitting type and material per ship): box 1 × 1 × 1,
 * cylinder Ø1 × 1 (axis y), lifeboat 1 m long (axis z, canopy up), tyre fender Ø1 (axis x). White vertex colours so the
 * vertex-coloured fittings materials take the instance colour as is.
 */
const UNIT = {
  box: () => new THREE.BoxGeometry(1, 1, 1),
  cyl: () => new THREE.CylinderGeometry(0.5, 0.5, 1, 8, 1),
  boat: () => {
    // enclosed lifeboat: a rounded hull (capsule, beam 0.36 L), a canopy of two thirds the length, a white sheer band
    const h = new THREE.CapsuleGeometry(0.18, 0.62, 3, 8); h.rotateX(Math.PI / 2); h.scale(1, 0.85, 1);
    const c = new THREE.CapsuleGeometry(0.14, 0.38, 2, 8); c.rotateX(Math.PI / 2); c.scale(1.05, 0.9, 1); c.translate(0, 0.12, 0.02);
    return mergeUnit([h, c]);
  },
  tyre: () => { const g = new THREE.TorusGeometry(0.38, 0.13, 5, 10); g.rotateY(Math.PI / 2); return g; },
  // a thin plate (divider, stanchion flat bar) as two back-to-back quads in the xy plane: 4 triangles instead of a box's 12
  fin: () => { const a = new THREE.PlaneGeometry(1, 1), b = new THREE.PlaneGeometry(1, 1); b.rotateY(Math.PI); return mergeUnit([a, b]); },
};
function mergeUnit(geos) { const g = merge(geos.map((x) => (x.index ? x.toNonIndexed() : x)), false); return g; }
function unitGeo(kind) {
  const g = UNIT[kind]();
  const n = g.attributes.position.count;
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  return g;
}
const _iq = new THREE.Quaternion(), _iv = new THREE.Vector3(), _iz = new THREE.Vector3(0, 0, 1);
/** Collects geometry per material key, with per-part vertex colours; build() emits one Mesh per key. */
class Parts {
  /**
   * seg: cylinder segments; instanced: fittings become InstancedMeshes (desktop) — false bakes them into the merged
   * buckets instead (phones: every extra draw call costs more than the triangles, and their budget is 16 calls)
   */
  constructor(seg = 14, instanced = true) { this.buckets = new Map(); this.seg = seg; this.tris = 0; this.inst = new Map(); this.instanced = instanced; }
  /** one instance of fitting `kind` ('box' | 'cyl' | 'boat' | 'tyre') with material `key`, from a matrix */
  imat(kind, key, matrix, color = 0xffffff) {
    if (!this.instanced) { const g = unitGeo(kind); g.deleteAttribute('color'); g.applyMatrix4(matrix); return this.put(key, g, color); }
    const id = kind + ':' + key;
    let b = this.inst.get(id); if (!b) { b = { kind, key, m: [], c: [] }; this.inst.set(id, b); }
    b.m.push(matrix.clone()); b.c.push(color);
    return this;
  }
  /** an instanced box w × h × d at (x, y, z), rotated (ry, rx, rz as box()) */
  ibox(key, w, h, d, x, y, z, color = 0xffffff, ry = 0, rx = 0, rz = 0) { return this.imat('box', key, xf(x, y, z, rx, ry, rz, Math.max(0.01, w), Math.max(0.01, h), Math.max(0.01, d)), color); }
  /** an instanced square-section bar from a to b (w across, h up) */
  ibeam(key, ax, ay, az, bx, by, bz, w, h, color = 0xffffff) {
    const dx = bx - ax, dy = by - ay, dz = bz - az, len = Math.hypot(dx, dy, dz); if (len < 1e-3) return this;
    _iv.set(dx / len, dy / len, dz / len);
    // keep the bar's "up" vertical for near-horizontal bars (rails lie flat), whatever the run's heading
    if (Math.abs(_iv.y) < 0.95) { _e.set(Math.asin(-_iv.y), Math.atan2(_iv.x, _iv.z), 0, 'YXZ'); _iq.setFromEuler(_e); } else _iq.setFromUnitVectors(_iz, _iv);
    return this.imat('box', key, _m.compose(_p.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2), _iq, _s.set(w, h, len)), color);
  }
  /** an instanced two-sided plate w wide (x) and h high, facing ±z before the turn ry */
  ifin(key, w, h, x, y, z, color = 0xffffff, ry = 0) { return this.imat('fin', key, xf(x, y, z, 0, ry, 0, Math.max(0.01, w), Math.max(0.01, h), 1), color); }
  /** an instanced cylinder (axis y unless rotated) of radius r and height h */
  icyl(key, r, h, x, y, z, color = 0xffffff, rx = 0, ry = 0, rz = 0) { return this.imat('cyl', key, xf(x, y, z, rx, ry, rz, r * 2, h, r * 2), color); }
  /** an instanced lifeboat len metres long and 2 r in beam, heading along z (ry turns it) */
  iboat(key, len, r, x, y, z, color, ry = 0) { const k = r / 0.18; return this.imat('boat', key, xf(x, y, z, 0, ry, 0, k, k, len), color); }
  /** an instanced tyre fender (diameter dia) hanging on a side, axis athwartships */
  ityre(key, dia, x, y, z, color = 0x17191c) { return this.imat('tyre', key, xf(x, y, z, 0, 0, 0, dia, dia, dia), color); }
  put(key, geo, color = null, tag = null) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    if (color != null) {
      _c.setHex(color); const n = g.attributes.position.count, a = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { a[i * 3] = _c.r; a[i * 3 + 1] = _c.g; a[i * 3 + 2] = _c.b; }
      g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    }
    let b = this.buckets.get(key); if (!b) { b = { geos: [], tags: new Set() }; this.buckets.set(key, b); }
    b.geos.push(g); if (tag) b.tags.add(tag);
    this.tris += g.attributes.position.count / 3;
    return this;
  }
  box(key, w, h, d, x, y, z, color = null, ry = 0, rx = 0, rz = 0, tag = null) { const g = new THREE.BoxGeometry(Math.max(0.01, w), Math.max(0.01, h), Math.max(0.01, d)); g.applyMatrix4(xf(x, y, z, rx, ry, rz)); return this.put(key, g, color, tag); }
  cyl(key, r, h, x, y, z, color = null, rt = r, seg = this.seg, rx = 0, ry = 0, rz = 0, open = false) { const g = new THREE.CylinderGeometry(Math.max(0.01, rt), Math.max(0.01, r), Math.max(0.01, h), seg, 1, open); g.applyMatrix4(xf(x, y, z, rx, ry, rz)); return this.put(key, g, color); }
  rod(key, ax, ay, az, bx, by, bz, r, color = null, seg = 6) {
    const dx = bx - ax, dy = by - ay, dz = bz - az, len = Math.hypot(dx, dy, dz); if (len < 1e-3) return this;
    const g = new THREE.CylinderGeometry(r, r, len, seg, 1, true);
    _q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx / len, dy / len, dz / len));
    g.applyMatrix4(_m.compose(_p.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2), _q, _s.set(1, 1, 1)));
    return this.put(key, g, color);
  }
  /** square-section beam from a to b (cheaper than a rod: 12 tris), w = width, h = height of the section */
  beam(key, ax, ay, az, bx, by, bz, w, h, color = null) {
    const dx = bx - ax, dy = by - ay, dz = bz - az, len = Math.hypot(dx, dy, dz); if (len < 1e-3) return this;
    const g = new THREE.BoxGeometry(w, h, len);
    const dir = new THREE.Vector3(dx / len, dy / len, dz / len);
    _q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    g.applyMatrix4(_m.compose(_p.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2), _q, _s.set(1, 1, 1)));
    return this.put(key, g, color);
  }
  ellipsoid(key, rx, ry, rz, x, y, z, color = null, seg = 12) { const g = new THREE.SphereGeometry(1, seg, Math.max(6, seg * 0.6 | 0)); g.applyMatrix4(xf(x, y, z, 0, 0, 0, rx, ry, rz)); return this.put(key, g, color); }
  capsule(key, r, len, x, y, z, color = null, rx = Math.PI / 2, ry = 0, rz = 0) { const g = new THREE.CapsuleGeometry(r, Math.max(0.01, len), 3, Math.max(6, this.seg - 4)); g.applyMatrix4(xf(x, y, z, rx, ry, rz)); return this.put(key, g, color); }
  /** a house block whose faces map the facade atlas: band per face (sides, ends), top blank */
  facade(key, w, h, d, x, y, z, band = 0, endBand = band, color = null) {
    const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z);
    const p = g.attributes.position, n = g.attributes.normal, uv = g.attributes.uv;
    const y0 = y - h / 2;
    for (let i = 0; i < p.count; i++) {
      const nx = n.getX(i), ny = n.getY(i), px = p.getX(i), py = p.getY(i), pz = p.getZ(i);
      let b = band, u;
      if (Math.abs(ny) > 0.5) { b = 3; u = px / BAND_TILE[3]; }
      else if (Math.abs(nx) > 0.5) u = pz / BAND_TILE[b];
      else { b = endBand; u = px / BAND_TILE[b]; }
      const vy = Math.abs(ny) > 0.5 ? 0.5 : (py - y0) / h;
      uv.setXY(i, u, (b + 0.03 + 0.94 * vy) / 4);
    }
    return this.put(key, g, color);
  }
  build(group, mats, cargoKeys = new Set()) {
    const out = [];
    for (const [key, b] of this.buckets) {
      if (!b.geos.length || !mats[key]) continue;
      const geo = merge(b.geos, !!mats[key].vertexColors);
      const mesh = new THREE.Mesh(geo, mats[key]);
      mesh.name = key; mesh.userData.parts = [...b.tags]; mesh.userData.matKey = key;
      if (cargoKeys.has(key)) mesh.userData.cargo = true;
      group.add(mesh); out.push(mesh);
    }
    this.buckets.clear();
    for (const [id, b] of this.inst) {
      const mat = mats[b.key]; if (!mat || !b.m.length) continue;
      const geo = unitGeo(b.kind);
      if (!mat.vertexColors) geo.deleteAttribute('color');
      const mesh = new THREE.InstancedMesh(geo, mat, b.m.length);
      for (let i = 0; i < b.m.length; i++) { mesh.setMatrixAt(i, b.m[i]); if (mat.vertexColors) mesh.setColorAt(i, _c.setHex(b.c[i])); }
      mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere(); mesh.computeBoundingBox();
      mesh.name = 'fit-' + id; mesh.userData.matKey = b.key; mesh.userData.parts = ['fittings']; mesh.userData.fitting = b.kind;
      group.add(mesh); out.push(mesh);
    }
    this.inst.clear();
    return out;
  }
}
function merge(geos, withColor) {
  let n = 0; for (const g of geos) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), uv = new Float32Array(n * 2), col = withColor ? new Float32Array(n * 3) : null;
  let o = 0;
  for (const g of geos) {
    const c = g.attributes.position.count;
    if (!g.attributes.normal) g.computeVertexNormals();
    pos.set(g.attributes.position.array.subarray(0, c * 3), o * 3);
    nrm.set(g.attributes.normal.array.subarray(0, c * 3), o * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array.subarray(0, c * 2), o * 2);
    if (col) { if (g.attributes.color) col.set(g.attributes.color.array.subarray(0, c * 3), o * 3); else col.fill(1, o * 3, (o + c) * 3); }
    o += c; g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere(); out.computeBoundingBox();
  return out;
}

// ------------------------------------------------------------------------------------------------ materials
const DECK = { aft_house_tanker: COL.deckRed, lng: COL.deckGreen, aft_house_dry: 0x6d5a52, container: 0x5f656c, roro_pctc: 0x5f656c, offshore: 0x5c6167, tug: 0x5c6167,
  fishing: 0x6a6f74, small_fast: 0x50555a, motor_yacht: COL.teak, cruise: 0x8b96a0, ferry: 0x7f8a94, special: 0x5c6167 };
function defaultMakeMat(kind, color, p = {}) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: p.roughness ?? 0.6, metalness: p.metalness ?? 0.2, vertexColors: !!p.vertexColors, map: p.map || null,
    transparent: !!p.transparent, alphaTest: p.alphaTest ?? 0, side: p.side ?? THREE.FrontSide, emissive: p.emissive ?? 0x000000, emissiveIntensity: p.emissiveIntensity ?? 0,
    polygonOffset: !!p.polygonOffset, polygonOffsetFactor: p.polygonOffset ? -2 : 0, polygonOffsetUnits: p.polygonOffset ? -2 : 0 });
  m.name = kind;
  return m;
}
function makeMaterials(ga, opts, primer) {
  const lv = ga.livery, mk = opts.makeMat || defaultMakeMat;
  const P = primer ? { hull: COL.primer, boot: COL.redOxide, band: COL.primer, house: COL.primer, funnel: COL.primer, deck: 0x7d8186 } : null;
  const yacht = hullModeOf(ga.gen) === 1;
  // PBR presets (shipskinfmt.js): painted steel is a dielectric (metalness 0); yachts are gelcoat; decks non-slip / teak
  const hullP = primer ? { roughness: 0.7, metalness: 0 } : yacht ? PRESETS.gelcoat : PRESETS.paint;
  const mats = {
    hull: mk('hull', P ? P.hull : lv.hull, { ...hullP, preset: yacht ? 'gelcoat' : 'paint' }),
    boot: mk('boot', P ? P.boot : lv.boot, { roughness: 0.62, metalness: 0, preset: 'paint' }),
    band: mk('band', P ? P.band : lv.band ?? lv.hull, { ...hullP, preset: yacht ? 'gelcoat' : 'paint' }),
    hullX: null,
    deck: mk('deck', P ? P.deck : DECK[ga.gen] ?? 0x666b70, deckModeOf(ga.gen, DECK[ga.gen]) ? { ...PRESETS.teak, preset: 'teak' } : { ...PRESETS.deckPaint, preset: 'deckPaint' }),
    house: mk('house', P ? P.house : lv.house, { ...PRESETS.housePaint, map: primer ? null : facadeTexture(opts.phone ? 512 : 1024) }),
    glass: mk('glass', 0x16283a, { ...PRESETS.glass, emissive: 0xffd890, emissiveIntensity: 0 }),
    paint: mk('paint', primer ? COL.primer : 0xffffff, { ...PRESETS.fittings, vertexColors: !primer }),
    metal: mk('metal', primer ? COL.primer : 0xffffff, { roughness: 0.45, metalness: 0.35, vertexColors: !primer }),
    funnel: mk('funnel', P ? P.funnel : lv.funnel, { ...PRESETS.funnel }),
    cargo: mk('cargo', 0xffffff, { roughness: 0.75, metalness: 0.1, vertexColors: true, map: containerTexture() }),
    decal: null,
  };
  mats.hullX = mats.hull;
  return mats;
}

// ------------------------------------------------------------------------------------------------ build
/**
 * Build the exterior of a GA. Returns { group, lods: [g0, g1, g2], info } where group is a THREE.LOD (or a Group when
 * opts.lod is a single level) and info = { lights, labelY, crewSpots, tris: [..], drawCalls: [..], clipY, airDraft, mats }.
 */
export function buildFromGA(ga, opts = {}) {
  if (!ga) throw new Error('buildFromGA: no GA');
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const stage = clamp(0, 1, opts.stage ?? ga.stage ?? 1);
  const primer = stage < 0.9;
  const mats = makeMaterials(ga, opts, primer);
  const phone = !!opts.phone;
  const want = opts.lod === undefined || opts.lod === 'all' ? [0, 1, 2] : [opts.lod];
  const seed = (hashStr(String(ga.id)) ^ ((opts.seed ?? 1) * 2654435761)) >>> 0;
  const m = MODELS[ga.model] || MODELS[String(ga.id).split('~')[0]] || null;
  const hf = hullForm(ga);
  const lods = [], info = { tris: [], drawCalls: [], lights: null, labelY: ga.deckY + 6, crewSpots: [], clipY: null, stage, mats };
  let decalTex = null;
  for (const lod of want) {
    const g = new THREE.Group(); g.name = `ship-lod${lod}`;
    const P = new Parts(phone ? (lod === 0 ? 8 : 6) : lod === 0 ? 14 : lod === 1 ? 8 : 6, !phone && lod < 2);
    const ctx = { ga, m, hf, P, lod, phone, rnd: rng(seed), L: ga.L, B: ga.B, T: ga.T, deckY: ga.deckY, lv: ga.livery, info, stage, opts, hd: !!opts.hd && lod === 0,
      rails: lod === 0 && opts.rails !== false, cargo: opts.cargo !== false && stage >= 1, primer };
    let hullMesh = null;
    if (stage < 0.25) buildBlocks(ctx);
    else {
      hullMesh = buildHull(ctx, mats);
      if (hullMesh) g.add(hullMesh);
      if (stage >= 0.65) {
        buildHouse(ctx); buildFunnel(ctx); buildCargo(ctx); buildDeckGear(ctx);
        if (ctx.rails) buildRails(ctx);
      }
      if (stage < 0.65) info.clipY = -ga.T + ((stage - 0.25) / 0.4) * (ga.T + ga.deckY);
    }
    const meshes = P.build(g, mats, new Set(['cargo']));
    // name + company mark decals (browser, LOD0 only, full livery)
    if (lod === 0 && !primer && opts.decals === 'mark' && HAS_DOM && ga.livery.mark) {
      // the hull lettering is drawn by the skin shader (ship.js): only the funnel mark is a decal, its texture shared
      const t = markTexture(ga.livery);
      if (t) { const d = buildDecals(ctx, t, null, true); if (d) { g.add(d); meshes.push(d); } }
    } else if (lod === 0 && !primer && opts.decals !== false && opts.decals !== 'mark' && HAS_DOM && (opts.name || ga.livery.mark)) {
      decalTex = decalTex || decalTexture(opts.name || '', ga.livery);
      if (decalTex) { const d = buildDecals(ctx, decalTex, opts.name); if (d) { g.add(d); meshes.push(d); } }
    }
    let tris = 0, calls = 0, cargoTris = 0;
    g.traverse((o) => {
      if (!o.isMesh) return;
      const n = (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3 * (o.isInstancedMesh ? o.count : 1);
      const groups = o.geometry.groups?.length || 1;
      if (o.userData.cargo) cargoTris += n; else tris += n;
      calls += Array.isArray(o.material) ? groups : 1;
    });
    g.userData.tris = tris; g.userData.cargoTris = cargoTris; g.userData.drawCalls = calls;
    info.tris[lod] = tris; info.drawCalls[lod] = calls; info.cargoTris = info.cargoTris || []; info.cargoTris[lod] = cargoTris;
    lods[lod] = g;
  }
  let group;
  if (want.length > 1) {
    group = new THREE.LOD(); group.name = 'shipgen';
    const [d1, d2, d3] = lodDistances(ga.L);
    group.addLevel(lods[0], 0); group.addLevel(lods[1], d1); group.addLevel(lods[2], d2); group.addLevel(new THREE.Object3D(), d3);
  } else group = lods[want[0]];
  group.userData.ga = ga; group.userData.clipY = info.clipY; group.userData.stage = stage;
  info.lights = navLightSpots(ga);
  info.labelY = Math.max(ga.deckY + 4, (ga.bridge ? ga.bridge.y + ga.bridge.h + 5 : 0), ga.funnel && ga.funnel.kind !== 'none' ? ga.funnel.y + ga.funnel.h : 0);
  info.crewSpots = crewSpots(ga);
  info.ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  return { group, lods, info, mats };
}

// ------------------------------------------------------------------------------------------------ hull
function buildBlocks(ctx) {
  const { ga, P, hf, stage } = ctx;
  const N = Math.max(4, Math.round(ga.L / 14)), done = Math.max(1, Math.ceil((stage / 0.25) * N));
  const len = ga.L * 0.92 / N;
  for (let i = 0; i < Math.min(done, N); i++) {
    const z = -ga.L * 0.46 + len * (i + 0.5);
    const hb = Math.max(0.5, hf.halfBreadth(z, -ga.T * 0.5));
    for (const d of hf.demi) P.box('paint', hb * 1.9, ga.T * 0.55, len * 0.96, d.cx, -ga.T + ga.T * 0.275, z, COL.redOxide, 0, 0, 0, 'blocks');
  }
}
function buildHull(ctx, mats) {
  const { ga, lod, P, hf, phone } = ctx;
  const lv = ga.livery;
  const bandY = lv.band != null && !ctx.primer ? [ga.deckY * 0.78, ga.deckY * 0.9] : null;
  const stations = ctx.hd ? (phone ? HD_STATIONS.phone : HD_STATIONS.desktop) : phone && lod === 0 ? 30 : undefined;
  const loft = loftHull(ga, { lod, stations, band: bandY, hd: ctx.hd });
  ctx.loft = loft;
  // side + transom in one indexed geometry with material groups (smooth side normals, sharp transom)
  const sp = loft.side.pos, tp = loft.transom.pos;
  const nSide = sp.length / 3;
  const pos = new Float32Array(sp.length + tp.length); pos.set(sp, 0); pos.set(tp, sp.length);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  // transom triangles by material (boot below the boot top, hull above)
  const tr = { boot: [], hull: [], band: [] };
  const ti = loft.transom.idx;
  for (let i = 0; i < ti.length; i += 3) {
    const a = ti[i] + nSide, b = ti[i + 1] + nSide, c = ti[i + 2] + nSide;
    const ym = (pos[a * 3 + 1] + pos[b * 3 + 1] + pos[c * 3 + 1]) / 3;
    tr[ym < loft.bootH ? 'boot' : 'hull'].push(a, b, c);
  }
  const idx = [], groups = [];
  const matOrder = ['boot', 'hull', 'band'];
  const sideBy = { boot: [], hull: [], band: [] };
  for (const gr of loft.side.groups) sideBy[gr.mat].push(...loft.side.idx.slice(gr.start, gr.start + gr.count));
  for (const k of matOrder) { const list = sideBy[k].concat(tr[k]); if (!list.length) continue; groups.push({ start: idx.length, count: list.length, mat: k }); idx.push(...list); }
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // transom normals: flat, facing aft
  for (let i = nSide; i < pos.length / 3; i++) geo.attributes.normal.setXYZ(i, 0, 0, 1);
  const matArr = [];
  for (const gr of groups) { let mi = matArr.indexOf(mats[gr.mat]); if (mi < 0) { mi = matArr.length; matArr.push(mats[gr.mat]); } geo.addGroup(gr.start, gr.count, mi); }
  geo.computeBoundingSphere(); geo.computeBoundingBox();
  const mesh = new THREE.Mesh(geo, matArr.length === 1 ? matArr[0] : matArr);
  mesh.name = 'hull'; mesh.userData.parts = ['hull']; mesh.userData.matKey = 'hull';
  // deck plating
  const dg = new THREE.BufferGeometry();
  dg.setAttribute('position', new THREE.Float32BufferAttribute(loft.deck.pos, 3)); dg.setIndex(loft.deck.idx); dg.computeVertexNormals();
  P.put('deck', dg, null, 'hull');
  // bulbous bow, rudder, propeller, skeg / pods
  const H = ga.hull, L = ga.L, B = ga.B, T = ga.T;
  if (H.bow === 'bulb' && lod < 2) P.ellipsoid('boot', B * 0.075, T * 0.27, L * 0.03, 0, -T * 0.6, -L / 2 + L * 0.012 + L * 0.03, null, phone ? 10 : 14);
  if (lod < 2 && !hf.twin) {
    const pods = ['cruise', 'motor_yacht'].includes(ga.gen) && ga.L > 60 || ['tug', 'special'].includes(ga.gen) && ga.model !== 'tshd100' || ga.model === 'expedition105';
    const Th = hf.T;   // hull-body draught (azimuth tugs: shallower than T, the drives reach −T)
    const zr = hf.zAft(-T * 0.5);
    if (pods && ga.gen !== 'motor_yacht') {
      for (const s of [-1, 1]) { const x = s * B * (ga.gen === 'tug' ? 0.22 : 0.18), z = L / 2 - L * (ga.gen === 'tug' ? 0.16 : 0.07), pr = Math.min(T * 0.13, 1.6), py = -T + pr + 0.02, sl = Math.max(T * 0.3, -Th * 0.7 - py + 0.3); P.cyl('metal', Math.min(0.8, 0.18 * T * 0.25 + 0.15), sl, x, py + sl / 2, z, COL.steel); P.capsule('boot', pr, Math.min(T * 0.35, 5), x, py, z, null); P.cyl('metal', pr * 0.95, 0.12, x, py, z + Math.min(T * 0.35, 5) / 2 + pr + 0.1, COL.bronze, pr * 0.95, 10, Math.PI / 2); }
    } else {
      const twinScrew = ga.model === 'lng174k' || (m2(ctx) && m2(ctx).engine.n >= 2 && ga.gen !== 'aft_house_dry');
      const xs = twinScrew ? [-B * 0.2, B * 0.2] : [0];
      for (const x of xs) {
        P.box('boot', 0.35 + T * 0.03, T * 0.75, T * 0.45, x, -T * 0.5, zr + T * 0.05, null);
        P.cyl('metal', T * 0.3, 0.25 + T * 0.02, x, -T * 0.62, zr - T * 0.35, COL.bronze, T * 0.3, phone ? 6 : 10, Math.PI / 2);
      }
      if (ga.gen === 'motor_yacht' || ga.gen === 'small_fast') for (const x of [-B * 0.18, B * 0.18]) P.rod('metal', x, -T * 0.6, L * 0.1, x, -T * 0.85, L / 2 - L * 0.1, 0.05, COL.steel, 5);
    }
  }
  // forecastle / poop: raised decks following the hull outline
  if (H.fcsle && lod < 2) raisedDeck(ctx, -L / 2, -L / 2 + H.fcsle.len, H.fcsle.h);
  if (H.poop && lod < 2) raisedDeck(ctx, L / 2 - H.poop.len, L / 2, H.poop.h);
  if (H.bulwark && lod === 0) bulwark(ctx, H.bulwark);
  if (H.fender && lod < 2) fenders(ctx);
  const hawse = hawseSpot(ga, hf);
  ctx.hawse = hawse;
  if (hawse && lod < 2) anchors(ctx, hawse);
  if (lod === 0 || !ctx.info.skin) ctx.info.skin = skinInfo(ga, hf, loft, hawse);
  if (H.tube) ribTube(ctx);
  if (hf.twin && lod < 2) twinStructure(ctx);
  else if (ga.gen === 'ferry' && ga.model !== 'ferry50' && lod < 2) ferryStructure(ctx);
  if ((ga.gen === 'cruise' || (ga.gen === 'ferry' && ga.model !== 'ferry50' && !hf.twin)) && lod < 2 && ctx.stage >= 0.65) hullWindows(ctx);
  if (ga.deck.swimPlatform && lod < 2) { const pl = platformLen(ga); P.box('deck', B * 0.78, 0.25, pl, 0, 0.35, L / 2 - pl / 2, null); }
  return mesh;
}
/** where the hawse pipes leave the hull (both sides, mirrored): { x (half-breadth), y, z, r, a (anchor size) } or null */
export function hawseSpot(ga, hf) {
  if (ga.L < 30 || hf.twin || ['motor_yacht', 'small_fast'].includes(ga.gen) || ga.hull?.bow === 'planing') return null;
  const y = ga.deckY - clamp(1.2, 4.5, ga.deckY * 0.3);
  const a = Math.min(clamp(0.6, 3.6, ga.L * 0.012), y / 1.25);   // low-freeboard bulkers: the anchor still clears the waterline
  if (a < 0.5) return null;
  const z = hf.zFwd(y) + clamp(2, 14, ga.L * 0.045);
  const x = Math.max(hf.halfBreadth(z, y), hf.halfBreadth(z, y - a * 1.1));
  if (!(x > 0.6)) return null;
  return { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000, z: Math.round(z * 1000) / 1000, r: Math.round(a * 0.3 * 1000) / 1000, a };
}
/** stockless anchors housed in the hawse pockets at both bows (LOD0: ring, shank, crown, flukes; LOD1: shank only) */
function anchors(ctx, h) {
  const { P, lod } = ctx, a = h.a, dark = 0x2a2c2e;
  for (const s of [-1, 1]) {
    const x = s * (h.x + 0.14 * a), top = h.y - h.r;
    P.box('metal', 0.22 * a, a * 0.85, 0.18 * a, x, top - a * 0.42, h.z, dark);
    if (lod > 0) continue;
    P.cyl('metal', h.r * 1.3, 0.3, s * (h.x + 0.08), h.y, h.z, 0x1c1e20, h.r * 1.3, 12, 0, 0, Math.PI / 2);
    P.box('metal', 0.26 * a, 0.2 * a, 0.95 * a, x, top - a * 0.85, h.z, dark);
    for (const sz of [-1, 1]) P.box('metal', 0.24 * a, 0.55 * a, 0.26 * a, x, top - a * 0.62, h.z + sz * 0.42 * a, dark, 0, sz * 0.45);
  }
}
/** hull facts the skin shader needs (ship.js turns them into uniforms) */
function skinInfo(ga, hf, loft, hawse) {
  const L = ga.L, yS = ga.deckY * 0.55;
  return {
    hawse, bootH: loft.bootH, zStemAt: (y) => hf.zFwd(y), zAftAt: (y) => hf.zAft(y),
    zMid: [L / 2 - (hf.xif ?? 0.7) * L, L / 2 - (hf.xia ?? 0.3) * L],
    transomHalf: hf.twin ? 0 : hf.halfBreadth(hf.zAft(yS) - 0.3, yS),
  };
}
function m2(ctx) { return ctx.m; }
/** rows of cabin windows on the hull sides of passenger ships (crew decks), where the side is near vertical */
function hullWindows(ctx) {
  const { ga, P, hf } = ctx;
  const y0 = 2.6, top = ga.deckY - 0.8;
  if (top - y0 < 2) return;
  let za = null, zb = null;
  for (let i = 0; i <= 60; i++) { const z = -ga.L / 2 + ga.L * i / 60; const ok = hf.halfBreadth(z, y0) > ga.B / 2 - 0.25 && hf.halfBreadth(z, top) > ga.B / 2 - 0.25; if (ok) { if (za === null) za = z; zb = z; } }
  if (za === null || zb - za < 10) return;
  za += 3; zb -= 3;
  for (let y = y0; y + 2.4 <= top + 0.01; y += 2.8) for (const s of [-1, 1]) {
    const g = new THREE.BoxGeometry(0.06, 2.4, zb - za); g.translate(s * (ga.B / 2 + 0.02), y + 1.2, (za + zb) / 2);
    const uv = g.attributes.uv, p = g.attributes.position;
    for (let i = 0; i < p.count; i++) uv.setXY(i, p.getZ(i) / BAND_TILE[0], (0.03 + 0.94 * ((p.getY(i) - y) / 2.4)) / 4);
    P.put('house', g);
  }
}
/** swim platform length of a yacht (inside the LOA: the hull stops short of it) */
export function platformLen(ga) { return ga.deck?.swimPlatform ? Math.max(1.2, ga.L * 0.045) : 0; }
/** half-breadth at the deck edge at z (0 outside the hull) */
function hbDeck(ctx, z) { const y = ctx.hf.deckAt(z); return ctx.hf.halfBreadth(z, y); }
/** half-breadth of the whole ship at the deck at z: a twin hull's cross structure spans both demihulls (0 outside) */
function hbOuter(ctx, z) {
  const hb = hbDeck(ctx, z), t = ctx.hf.twin;
  if (!t) return hb;
  return hb > 0.05 ? Math.abs(ctx.hf.demi[0].cx) + hb : 0;
}
/** outline points (port→bow→starboard) of the deck between z0 and z1, inset by `inset` metres */
function outline(ctx, z0, z1, n, inset = 0, cx = 0) {
  const pts = [];
  for (let i = 0; i <= n; i++) { const z = z0 + (z1 - z0) * i / n; pts.push([Math.max(0, hbDeck(ctx, z) - inset), z]); }
  return pts.map(([hb, z]) => [cx + hb, z]);
}
function raisedDeck(ctx, z0, z1, h) {
  const { P, hf } = ctx;
  const n = ctx.lod === 0 ? 12 : 5;
  const zs = []; for (let i = 0; i <= n; i++) zs.push(z0 + (z1 - z0) * i / n);
  for (const d of hf.demi) {
    for (let i = 0; i < n; i++) {
      const za = zs[i], zb = zs[i + 1];
      const ha = hbDeck(ctx, za), hb = hbDeck(ctx, zb), ya = hf.deckAt(za), yb = hf.deckAt(zb);
      if (ha + hb < 0.05) continue;
      // two side walls + top slab, as thin quads (merged into the hull extras)
      for (const s of [-1, 1]) quad(P, 'hullX', [d.cx + s * ha, ya - 0.05, za], [d.cx + s * hb, yb - 0.05, zb], [d.cx + s * hb, yb + h, zb], [d.cx + s * ha, ya + h, za], [s, 0, 0]);
      quad(P, 'deck', [d.cx - ha, ya + h, za], [d.cx + ha, ya + h, za], [d.cx + hb, yb + h, zb], [d.cx - hb, yb + h, zb], [0, 1, 0]);
    }
    // the open end facing the main deck
    const ze = z0 <= -ctx.L / 2 + 0.01 ? z1 : z0, he = hbDeck(ctx, ze), ye = hf.deckAt(ze);
    quad(P, 'hullX', [d.cx - he, ye, ze], [d.cx + he, ye, ze], [d.cx + he, ye + h, ze], [d.cx - he, ye + h, ze], [0, 0, z0 <= -ctx.L / 2 + 0.01 ? 1 : -1]);
  }
}
/** a quad a-b-c-d facing `out` (a hint vector [x, y, z]: the winding is flipped when the quad would face away) */
function quad(P, key, a, b, c, d, out = [0, 1, 0], color = null) {
  const g = new THREE.BufferGeometry();
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const front = nx * out[0] + ny * out[1] + nz * out[2] >= 0;
  const v = front ? [...a, ...b, ...c, ...a, ...c, ...d] : [...a, ...c, ...b, ...a, ...d, ...c];
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 2));
  g.computeVertexNormals();
  P.put(key, g, color);
}
function bulwark(ctx, h) {
  const { P, hf, L, ga } = ctx;
  const zA = ga.hull.fcsle ? -L / 2 + ga.hull.fcsle.len : -L / 2 + 0.5;
  const zB = ga.gen === 'offshore' || ga.gen === 'tug' || ga.gen === 'fishing' ? L / 2 - 0.3 : ga.house ? ga.house.z0 : L / 2;
  const n = Math.max(6, Math.round((zB - zA) / 8));
  const pts = outline(ctx, zA, zB, n, 0.05);
  for (const d of hf.demi) for (const s of [-1, 1]) for (let i = 0; i < pts.length - 1; i++) {
    const [xa, za] = pts[i], [xb, zb] = pts[i + 1], ya = hf.deckAt(za), yb = hf.deckAt(zb);
    if (xa + xb < 0.1) continue;
    const off = ga.hull.fcsle ? ga.hull.fcsle.h : 0; void off;
    quad(P, 'hullX', [d.cx + s * xa, ya, za], [d.cx + s * xb, yb, zb], [d.cx + s * xb, yb + h, zb], [d.cx + s * xa, ya + h, za], [s, 0, 0]);
    quad(P, 'hullX', [d.cx + s * (xa - 0.12), ya, za], [d.cx + s * (xb - 0.12), yb, zb], [d.cx + s * (xb - 0.12), yb + h, zb], [d.cx + s * (xa - 0.12), ya + h, za], [-s, 0, 0]);
    quad(P, 'hullX', [d.cx + s * xa, ya + h, za], [d.cx + s * xb, yb + h, zb], [d.cx + s * (xb - 0.12), yb + h, zb], [d.cx + s * (xa - 0.12), ya + h, za], [0, 1, 0]);
  }
  // aft crash rails / bulwark across the stern on workboats: none (open stern for the roller); fishing: transom wall
  if (ga.gen === 'fishing' && ga.hull.stern !== 'ramp') { const z = L / 2 - 0.3, hb = hbDeck(ctx, z) - 0.05, y = hf.deckAt(z); quad(P, 'hullX', [-hb, y, z], [hb, y, z], [hb, y + h, z], [-hb, y + h, z], [0, 0, 1]); quad(P, 'hullX', [-hb, y, z - 0.1], [hb, y, z - 0.1], [hb, y + h, z - 0.1], [-hb, y + h, z - 0.1], [0, 0, -1]); }
}
/**
 * The bridging structure of a wave-piercing catamaran (hsc112): the wet deck between the demihulls, the centre bow
 * (a V wedge under the fore end of the cross deck that meets the waves the hulls pierce), and the enclosed vehicle
 * deck — hull plating from the deck up to the passenger deck over the length of the house, with the stern door.
 */
function twinStructure(ctx) {
  const { ga, P, hf, L } = ctx;
  const t = hf.twin, F = ga.deckY, cx = Math.abs(hf.demi[0].cx), gi = cx - hf.Bd / 2;   // inner edge of each demihull
  const wetY = t.wetY ?? F - 2.2;
  const zTip = hf.zFwd(F) + L * 0.035, zFull = -L / 2 + L * 0.2, zEnd = L / 2 - Math.max(1, L * 0.02);
  // wet deck: the underside of the cross structure between the hulls
  P.box('hullX', gi * 2 + 0.2, F - wetY, zEnd - zFull, 0, (F + wetY) / 2, (zFull + zEnd) / 2);
  // centre bow: keel line from under the tip back to the wet deck, sides out to the hulls' inner edges
  const tipTop = [0, F, zTip], tipBot = [0, F - 1.0, zTip], keel = [0, wetY - 1.1, zFull + 4];
  for (const s of [-1, 1]) {
    const aTop = [s * gi, F, zFull - 2], aWet = [s * gi, wetY, zFull - 2];
    tri(P, 'hullX', tipTop, aTop, aWet, [s, 0, -0.3]);
    tri(P, 'hullX', tipTop, aWet, tipBot, [s, 0, -0.3]);
    tri(P, 'hullX', tipBot, aWet, keel, [s * 0.4, -1, -0.3]);
    tri(P, 'hullX', keel, aWet, [s * gi, wetY, zFull + 4], [0, -1, 0]);
  }
  // the enclosed vehicle deck: plating up to the first passenger tier, closed at the stern (the door outlined dark)
  const h = ga.house, y1 = h && h.tiers.length ? h.tiers[0].y : F + 2;
  if (y1 - F > 0.4 && h) {
    tierSolid(ctx, h.z0 - 2, zEnd, ga.B, F - 0.05, y1 - F + 0.05, BANDS.blank, BANDS.blank, 0, 'hullX');
    if (ga.deck.sternDoor) P.box('paint', Math.min(10, ga.B * 0.32), (y1 - F) * 0.85, 0.12, 0, F + (y1 - F) * 0.45, zEnd + 0.06, shade(ga.livery.hull, 0.6));
  }
}
/**
 * A ro-ro / ro-pax ferry's hull above the main deck: the side plating rises over the upper vehicle deck to the first
 * passenger deck, with a row of vehicle-deck openings along each side; the bow visor's seams and the stern door
 * outlined on the transom (dark seams: what tells a ferry from a cargo ship at a glance).
 */
function ferryStructure(ctx) {
  const { ga, P, hf, L, lod } = ctx;
  const F = ga.deckY, h = ga.house, y1 = h && h.tiers.length ? h.tiers[0].y : F, dark = 0x1d2124;
  const zA = -L / 2 + L * 0.03, zB = L / 2 - 0.3;
  if (y1 - F > 0.4) {
    tierSolid(ctx, zA, zB, ga.B, F - 0.05, y1 - F + 0.05, BANDS.blank, BANDS.blank, 0, 'hullX');
    if (y1 - F > 2.5) {
      // vehicle-deck openings (ventilation / mooring ports): 4 × 1.8 m, every 7 m along the parallel middle body
      const oy = F + (y1 - F) * 0.55, step = ctx.phone ? 14 : 7;
      for (let z = -L * 0.3; z < L * 0.36; z += step) {
        const hw = Math.min(ga.B / 2, hbOuter(ctx, z) - 0.35); if (hw < ga.B * 0.4) continue;
        for (const s of [-1, 1]) P.ibox('paint', 0.1, Math.min(1.8, (y1 - F) * 0.4), 4, s * (hw + 0.03), oy, z, dark);
      }
    }
  }
  if (lod > 0) return;
  const seam = (pts) => { for (let i = 0; i < pts.length - 1; i++) P.beam('paint', ...pts[i], ...pts[i + 1], 0.09, 0.09, dark); };
  if (ga.deck.bowDoor) {
    // bow visor: the seam runs aft along both sides at the lower edge and up the visor's after edge
    const yv = F * 0.45, zs = hf.zFwd(yv), zv = zs + L * 0.06, ytop = Math.max(y1, F) - 0.3;
    for (const s of [-1, 1]) {
      const pts = []; for (let i = 0; i <= 4; i++) { const z = zs + 0.3 + (zv - zs - 0.3) * i / 4; pts.push([s * (hf.halfBreadth(z, yv) + 0.04), yv, z]); }
      seam(pts);
      const up = []; for (let i = 0; i <= 3; i++) { const y = yv + (ytop - yv) * i / 3; up.push([s * (Math.max(hf.halfBreadth(zv, y), hbOuter(ctx, zv) - 0.35) + 0.04), y, zv]); }
      seam(up);
    }
  }
  if (ga.deck.sternDoor) {
    // stern door / ramp: a framed panel on the transom from the lower vehicle deck up to the main deck
    const zt = hf.zAft(F * 0.6) + 0.08, w = Math.min(ga.B * 0.45, 16), yb = Math.max(0.9, F * 0.3), yt = F - 0.3;
    if (hf.halfBreadth(zt - 0.3, (yb + yt) / 2) > w / 2) {
      P.box('paint', w, yt - yb, 0.1, 0, (yb + yt) / 2, zt, shade(ga.livery.hull, 0.82));
      seam([[-w / 2, yb, zt + 0.06], [w / 2, yb, zt + 0.06], [w / 2, yt, zt + 0.06], [-w / 2, yt, zt + 0.06], [-w / 2, yb, zt + 0.06]]);
    }
  }
}
function tri(P, key, a, b, c, out) {
  const g = new THREE.BufferGeometry();
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const front = (uy * vz - uz * vy) * out[0] + (uz * vx - ux * vz) * out[1] + (ux * vy - uy * vx) * out[2] >= 0;
  g.setAttribute('position', new THREE.Float32BufferAttribute(front ? [...a, ...b, ...c] : [...a, ...c, ...b], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1], 2));
  g.computeVertexNormals();
  P.put(key, g);
}
function fenders(ctx) {
  const { P, hf, L, ga } = ctx;
  const n = ctx.lod === 0 ? 24 : 10, r = clamp(0.12, 0.45, ga.B * 0.03);
  const pts = outline(ctx, -L / 2 + r + 0.05, L / 2 - r - 0.05, n, r);
  for (const d of hf.demi) for (const s of [-1, 1]) for (let i = 0; i < pts.length - 1; i++) {
    const [xa, za] = pts[i], [xb, zb] = pts[i + 1];
    const ya = hf.deckAt(za) - r * 1.2, yb = hf.deckAt(zb) - r * 1.2;
    if (xa + xb < 0.05 && !hf.twin) { continue; }
    P.rod('paint', d.cx + s * xa, ya, za, d.cx + s * xb, yb, zb, r, COL.rubber, ctx.phone ? 5 : 7);
  }
  // heavy bow fender (tugs: cylindrical / W-fender), stern fender
  if (ga.gen === 'tug') {
    const zb = hf.zFwd(ga.deckY * 0.4);
    P.box('paint', ga.B * 0.42, ga.deckY * 0.9 + 0.6, 1.0, 0, ga.deckY * 0.45 - 0.2, zb + 0.4, COL.rubber);
    if (ga.hull.pushKnees) for (const s of [-1, 1]) P.box('paint', 0.6, ga.deckY + 2.0, 0.8, s * ga.B * 0.22, ga.deckY * 0.5 + 0.8, zb + 0.2, COL.rubber);
    const zs = L / 2 - 0.3;
    P.box('paint', ga.B * 0.5, 0.9, 0.7, 0, ga.deckY - 0.6, zs, COL.rubber);
  }
}
function ribTube(ctx) {
  const { P, L, ga } = ctx;
  const r = 0.27, pts = outline(ctx, -L / 2 + r + 0.1, L / 2 - r, 16, r);
  void ga;
  for (const s of [-1, 1]) for (let i = 0; i < pts.length - 1; i++) P.rod('paint', s * pts[i][0], ctx.hf.deckAt(pts[i][1]) - 0.05, pts[i][1], s * pts[i + 1][0], ctx.hf.deckAt(pts[i + 1][1]) - 0.05, pts[i + 1][1], r, 0x55595e, 8);
}

// ------------------------------------------------------------------------------------------------ superstructure
const USE_BAND = { mess: 'cabins', cabins: 'cabins', officers: 'cabins', senior: 'cabins', pilot: 'cabins', ccr: 'cabins', crew: 'cabins', labs: 'cabins',
  balcony: 'balcony', public: 'glass', lounge: 'glass', lido: 'glass', saloon: 'glass', owner: 'glass', sundeck: 'glass', bridge: 'glass', windscreen: 'glass' };
function buildHouse(ctx) {
  const { ga, P, lod } = ctx;
  const h = ga.house; if (!h) return;
  const cruise = ga.gen === 'cruise', yacht = ga.gen === 'motor_yacht', ferry = ga.gen === 'ferry';
  const n = h.tiers.length;
  const bi = h.tiers.findIndex((t) => t.use === 'bridge');
  const nLido = h.tiers.filter((t) => t.use === 'lido').length;
  let prevBalc = null;
  for (let i = 0; i < n; i++) {
    const t = h.tiers[i];
    let z0 = t.z0 ?? h.z0, z1 = t.z1 ?? h.z1, w = t.w ?? h.w;
    if (cruise) {
      // the top decks step back a little forward; the aft end is terraced (classic cruise-ship stern)
      if (i >= n - 2) z0 += (i - (n - 3)) * 3.0;
      if (i > n * 0.5) z1 -= (i - n * 0.5) * Math.max(2.5, ga.L * 0.012);
      // above the bridge the front steps back deck by deck, and the top cabin decks and the lido step inward going up
      // (the silhouette of a real cruise ship is a stepped wedge, never one box)
      if (bi >= 0 && i > bi && t.use !== 'bridge') z0 += (i - bi) * Math.max(1.2, ga.L * 0.006);
      const fromTop = n - nLido - 1 - i;   // 0 = the highest cabin deck
      if (t.use !== 'lido' && fromTop >= 0 && fromTop < 3 && n > 6) w -= 2 * (3 - fromTop) * Math.max(0.6, ga.B * 0.02);
      if (t.use === 'lido') w -= 2 * 4 * Math.max(0.6, ga.B * 0.02);
    } else if (ferry && n > 2) {
      if (i >= n - 2) z1 -= (i - (n - 3)) * ga.L * 0.05;
    }
    if (cruise && t.use === 'lido') { buildLido(ctx, t, z0, z1, w, n); continue; }
    if ((cruise || (ferry && !ctx.hf.twin)) && ga.deck.boats.some((b) => b.deck === t.id && b.kind === 'davit')) { const rb = Math.min(9, clamp(6, 9, ga.L * 0.05) * 0.19); w = Math.min(w, 2 * (hbDeck(ctx, (z0 + z1) / 2) - 2 * rb - 0.5)); }   // the house of the boat deck stands back from the hull: the boats hang in the recess   // the open pool deck (docs/CRUISE-CONTRACT.md §5)
    if (lod === 2) continue;
    const band = BANDS[USE_BAND[t.use] || 'cabins'];
    const endBand = cruise || yacht || ferry ? BANDS.glass : band;
    // yachts: a tapered nose; the fast catamaran: a rounded front to the passenger cabin
    const nose = yacht ? Math.min((z1 - z0) * 0.35, w * 1.1) : ferry && ctx.hf.twin ? Math.min((z1 - z0) * 0.12, w * 0.3) * (1 - i / Math.max(1, n)) : 0;
    (ctx.tierBoxes ||= []).push({ z0, z1, w, y: t.y, h: t.h, use: t.use });
    if (t.use === 'balcony' && (cruise || ferry) && w > 12) {
      // a balcony deck: the cabin wall stands back by the balcony's depth; the floor slab, glass balustrades and the
      // dividers between cabins stand out at the ship's side — rows of real balconies, not a painted grid
      const dB = clamp(1.2, 2.0, w * 0.035);
      tierSolid(ctx, z0, z1, w - 2 * dB, t.y, t.h, band, endBand, 0);
      balconyRow(ctx, z0, z1, w, t.y, t.h, dB, !(prevBalc && prevBalc.w >= w - 0.01 && prevBalc.z0 <= z0 + 0.01 && prevBalc.z1 >= z1 - 0.01));
      prevBalc = { w, z0, z1 };
    } else {
      tierSolid(ctx, z0, z1, w, t.y, t.h, band, endBand, nose);
      prevBalc = null;
    }
    // deck edge lips (yachts, ferries, cruise): a white slab slightly proud of the tier below
    if ((cruise || ferry || yacht) && lod === 0) tierSolid(ctx, z0 - 0.15, z1 + 0.15, w + 0.5, t.y + t.h - 0.12, 0.24, BANDS.blank, BANDS.blank, nose, 'paint', ctx.primer ? COL.primer : 0xf4f4f2);
  }
  if (lod === 2) { // silhouette: one block
    const top = n ? h.tiers[n - 1].y + h.tiers[n - 1].h : ga.deckY + 3;
    if (n) P.box('house', h.w, top - h.tiers[0].y, h.z1 - h.z0, 0, (top + h.tiers[0].y) / 2, (h.z0 + h.z1) / 2);
  }
  if (lod < 2 && h.pos === 'aft' && ga.gen !== 'motor_yacht' && n) {
    // engine casing behind the house up to the funnel base
    const c = ga.casing; if (c && c.z1 > h.z1 - 1) { const top = h.tiers[Math.min(n - 1, 1)].y + 2.8; P.facade('house', c.w, top - ga.deckY, Math.max(1, c.z1 - h.z1 + 1), 0, (top + ga.deckY) / 2, (h.z1 - 1 + c.z1) / 2, BANDS.blank, BANDS.blank); }
  }
  buildBridge(ctx);
  // pool and lido (cruise)
  if (ga.deck.pool && lod < 2 && !cruise) { const p = ga.deck.pool; P.box('paint', ga.B * 0.32, 0.4, p.z1 - p.z0, 0, p.y + 0.15, (p.z0 + p.z1) / 2, COL.pool); P.box('paint', ga.B * 0.5, 0.2, p.z1 - p.z0 + 8, 0, p.y + 0.02, (p.z0 + p.z1) / 2, COL.teak); }
  if (ga.deck.flybridge && lod < 2) { const f = ga.deck.flybridge; const w = ga.B * 0.6; P.box('paint', w, 1.0, (f.z1 - f.z0) * 0.6, 0, f.y + 0.5, f.z0 + (f.z1 - f.z0) * 0.35, COL.white); P.box('paint', w * 1.05, 0.12, (f.z1 - f.z0) * 0.8, 0, f.y + 2.4, f.z0 + (f.z1 - f.z0) * 0.45, COL.white); for (const s of [-1, 1]) P.rod('metal', s * w * 0.45, f.y + 1, f.z0 + (f.z1 - f.z0) * 0.8, s * w * 0.45, f.y + 2.4, f.z0 + (f.z1 - f.z0) * 0.8, 0.05, COL.light, 5); }
}
/**
 * The open lido (pool) deck of a cruise ship: a teak slab with glass windscreens, the pool and hot tubs, rows of loungers (as many as
 * the guest list suggests), the pool bar, slides and the class's sports kit (court, mini-golf, climbing wall, rope course, aqua
 * theatre), a lounge on the sun deck aft and a crow's nest forward. Detail at LOD0 only; ~6k triangles on the biggest ships.
 */
function buildLido(ctx, t, z0, z1, w, nTiers) {
  const { ga, P, lod } = ctx, B = ga.B, prof = cruiseProfile(ga.model), pool = ga.deck.pool;
  const ex = new Set(prof?.extras || []), guests = prof?.guests || 800;
  const y = t.y, top = y + 0.3, white = ctx.primer ? COL.primer : COL.white;
  tierSolid(ctx, z0, z1, w, y - 0.1, 0.4, BANDS.blank, BANDS.blank, 0, 'paint', ctx.primer ? COL.primer : 0xb7966a);
  if (lod === 2) { P.box('house', w * 0.5, 3, Math.max(4, (z1 - z0) * 0.25), 0, top + 1.5, z1 - (z1 - z0) * 0.2); return; }
  const hwAt = (z) => Math.min(w / 2, hbOuter(ctx, clamp(-ctx.L / 2, ctx.L / 2, z)) - 0.35);
  for (const s of [-1, 1]) for (let z = z0 + 2; z < z1 - 2; z += 18) { const zb = Math.min(z1 - 2, z + 18); P.box('glass', 0.05, 1.25, zb - z - 0.3, s * (hwAt((z + zb) / 2) - 0.1), top + 0.65, (z + zb) / 2); }
  const pz = pool ? (pool.z0 + pool.z1) / 2 : (z0 + z1) / 2, plen = Math.min(34, pool ? pool.z1 - pool.z0 : 20), pw = Math.min(B * 0.3, 13);
  // pool, coaming, two hot tubs
  P.box('paint', pw + 1.2, 0.8, plen + 1.2, 0, top + 0.25, pz, COL.white);
  P.box('paint', pw, 0.8, plen, 0, top + 0.27, pz, COL.pool);
  if (guests > 900) for (const s of [-1, 1]) { const hx = s * (pw / 2 + 4.2); P.cyl('paint', 1.7, 0.9, hx, top + 0.45, pz - plen / 2 + 2, COL.white, 1.7, 14); P.cyl('paint', 1.45, 0.1, hx, top + 0.92, pz - plen / 2 + 2, COL.pool, 1.45, 14); }
  // loungers in rows either side of the pool (blue towels on every third)
  let left = clamp(guests / 24, 16, 300);
  const reach = Math.min(w / 2 - 1.2, pw / 2 + 11);
  for (let z = pz - plen / 2 - 8; z < pz + plen / 2 + 12 && left > 0; z += 1.15) {
    for (const s of [-1, 1]) for (let x = pw / 2 + 1.6; x < reach && left > 0; x += 1.5) {
      if (x > pw / 2 + 2.6 && x < pw / 2 + 5.8 && Math.abs(z - (pz - plen / 2 + 2)) < 2.8) continue;   // hot tub
      P.box('paint', 0.7, 0.34, 1.9, s * x, top + 0.17, z, left % 3 ? white : COL.blue); left--;
    }
  }
  // pool bar: a roofed pavilion at the aft end, and the forward windbreak
  const bz = pz + plen / 2 + 5;
  P.box('paint', 7, 1.1, 2.6, 0, top + 0.55, bz, 0x6d4a2c); P.box('paint', 8, 0.25, 4.2, 0, top + 3.3, bz - 0.6, white);
  for (const sx of [-3.4, 3.4]) P.rod('metal', sx, top, bz - 2.4, sx, top + 3.3, bz - 2.4, 0.1, COL.light, 5);
  // slides: a tower with three spiral tubes beside the pool
  if ((prof?.venues.slide || ex.has('water_park')) && hwAt(pz - plen / 2 - 6) > 7) {
    const sz = pz - plen / 2 - 6, sx = Math.min(pw / 2 + 6.5, hwAt(sz) - 5.2), H = 11;   // the spiral (radius up to 4 m + the tube) stays inside the hull's beam
    P.cyl('paint', 1.4, H, sx, top + H / 2, sz, COL.white, 1.4, 10);
    P.box('paint', 3.2, 0.3, 3.2, sx, top + H, sz, COL.white);
    const tubes = [COL.red, COL.yellow, COL.blue];
    for (let k = 0; k < 3; k++) {
      let prev = null;
      for (let i = 0; i <= 18; i++) {
        const a = (i / 18) * Math.PI * 3.2 + k * 2.1, r = 2.6 + (i / 18) * 1.4, q = [sx + Math.cos(a) * r, top + H - 0.6 - (i / 18) * (H - 1.4) - k * 0.15, sz + Math.sin(a) * r];
        if (prev) P.rod('paint', prev[0], prev[1], prev[2], q[0], q[1], q[2], 0.5, tubes[k], 6);
        prev = q;
      }
    }
  }
  // the class's sports kit forward of the pool: court, mini-golf, rope course, climbing wall at the funnel, aqua theatre aft
  let fz = pz - plen / 2 - 22;
  if (ex.has('sports_court') && fz - 20 > z0 + 4) { P.box('paint', 11, 0.12, 20, 0, top + 0.06, fz - 10, COL.blue); for (const dz of [-9.5, 9.5]) for (const sx of [-1.4, 1.4]) P.rod('metal', sx, top, fz - 10 + dz, sx, top + 3, fz - 10 + dz, 0.08, COL.light, 5); fz -= 24; }
  if (ex.has('mini_golf') && fz - 14 > z0 + 4) { P.box('paint', 9, 0.14, 14, 0, top + 0.07, fz - 7, COL.green); for (let i = 0; i < 4; i++) P.cyl('paint', 0.6, 0.35, (i % 2 ? 2.5 : -2.5), top + 0.3, fz - 2 - i * 3, COL.white, 0.6, 8); fz -= 17; }
  if (ex.has('rope_course') && fz - 14 > z0 + 4) { for (const [px, qz] of [[-5, 0], [5, 0], [-5, -12], [5, -12]]) P.rod('metal', px, top, fz + qz - 2, px, top + 9, fz + qz - 2, 0.15, COL.light, 6); for (const sx of [-5, 5]) P.beam('metal', sx, top + 9, fz - 2, sx, top + 9, fz - 14, 0.2, 0.2, COL.red); }
  const fun = ga.funnel;
  if (ex.has('climbing_wall') && fun && fun.z - 18 > pz + plen) { P.box('paint', 7, 9, 1.1, 0, top + 4.5, fun.z - 14, COL.grey); for (let i = 0; i < 8; i++) P.box('paint', 0.5, 0.4, 0.3, ((i * 37) % 7) - 3, top + 1 + (i % 4) * 2, fun.z - 14.7, i % 2 ? COL.orange : COL.yellow); }
  if (ex.has('aqua_theatre') && z1 - 16 > pz + plen + 8) { P.cyl('paint', 7.5, 0.7, 0, top + 0.35, z1 - 10, COL.pool, 7.5, 18); P.cyl('paint', 8.2, 0.4, 0, top + 0.2, z1 - 10, COL.white, 8.2, 18); for (const a of [0.5, 1.2, 1.9, 2.6]) P.box('paint', 5, 0.3, 1.2, Math.cos(a * 2) * 0.2, top + 1.2 + a, z1 - 19 - a * 1.4, COL.white); }
  // sun-deck lounge aft of the pool (under the funnel) and a crow's nest forward
  const lw = Math.min(w * 0.5, 22);
  if (fun && fun.z - 8 > pz + plen / 2 + 22) tierSolid(ctx, pz + plen / 2 + 20, fun.z - 8, lw, t.y + t.h, 2.7, BANDS.glass, BANDS.glass, 0);
  if (guests > 1500 && z1 - z0 > 120) tierSolid(ctx, z0 + 6, z0 + 24, Math.min(w * 0.45, 18), t.y + t.h, 2.7, BANDS.glass, BANDS.glass, 0);
  void nTiers;
}
/**
 * The outer part of a balcony deck (both sides): the floor slab (unless the deck-edge lip of the deck below already is
 * one), a glass balustrade with its top rail along the ship's side and a divider every cabin (2.8 m; 5.6 m on phones,
 * LOD0 only). The cabin wall itself is the tier, set back by dB.
 */
function balconyRow(ctx, z0, z1, w, y, h, dB, floor) {
  const { P, lod } = ctx;
  const white = ctx.primer ? COL.primer : 0xf4f4f2;
  const hwAt = (z) => Math.min(w / 2, hbOuter(ctx, clamp(-ctx.L / 2, ctx.L / 2, z)) - 0.35);
  if (floor) tierSolid(ctx, z0 - 0.15, z1 + 0.15, w + 0.5, y - 0.12, 0.24, BANDS.blank, BANDS.blank, 0, 'paint', white);
  const cab = (ctx.hd ? 2.8 : 5.6) * (ctx.phone ? 2 : 1);   // own ship: every cabin; traffic: every second (half the instances)
  for (const s of [-1, 1]) {
    const pts = sideLine(z0 + 0.4, z1 - 0.4, hwAt, s, lod === 0 ? 10 : 5, dB + 0.6);
    for (let i = 0; i < pts.length - 1; i++) {
      const [xa, za] = pts[i], [xb, zb] = pts[i + 1], ia = xa - s * 0.12, ib = xb - s * 0.12;
      P.beam('glass', ia, y + 0.62, za, ib, y + 0.62, zb, 0.03, 0.95);                       // the glass panels
      P.beam('paint', ia, y + 1.12, za, ib, y + 1.12, zb, 0.12, 0.07, ctx.primer ? COL.primer : 0xc9cdd0);   // handrail
      if (lod > 0) continue;
      const len = Math.hypot(xb - xa, zb - za), nd = Math.max(1, Math.round(len / cab));
      for (let k = 0; k <= nd; k++) {
        const f = k / nd, x = xa + (xb - xa) * f, z = za + (zb - za) * f;
        P.ifin('paint', dB, h - 0.24, x - s * dB / 2, y + h / 2 - 0.06, z, white);           // divider between cabins
      }
    }
  }
}
/**
 * One superstructure tier as a solid that follows the deck outline (so a forward house never hangs over the bow flare):
 * half-width(z) = min(w / 2, deck half-breadth − 0.35 m), tapered to a point over `nose` metres (yachts).
 * Faces map the facade atlas: sides → `band`, ends → `endBand`, top blank.
 */
function tierSolid(ctx, z0, z1, w, y, h, band, endBand, nose = 0, key = 'house', color = null) {
  const { P } = ctx;
  const hwAt = (z) => {
    let hw = Math.min(w / 2, hbOuter(ctx, clamp(-ctx.L / 2, ctx.L / 2, z)) - 0.35);
    if (nose > 0 && z < z0 + nose) hw *= 0.32 + 0.68 * Math.sqrt(Math.max(0, (z - z0) / nose));
    return hw;
  };
  const n = ctx.lod === 0 ? 10 : 5;
  const zs = [];
  for (let i = 0; i <= n; i++) zs.push(z0 + (z1 - z0) * i / n);
  // drop the samples where the hull is too narrow for the house (bow), keep the rest
  const pts = zs.map((z) => [hwAt(z), z]).filter(([hw]) => hw > 0.4);
  if (pts.length < 2) return;
  // a straight-sided tier needs only its corners
  const flat = pts.every(([hw]) => Math.abs(hw - pts[0][0]) < 0.02);
  const use = flat ? [pts[0], pts[pts.length - 1]] : pts;
  const shape = new THREE.Shape();
  shape.moveTo(use[0][0], -use[0][1]);
  for (let i = 1; i < use.length; i++) shape.lineTo(use[i][0], -use[i][1]);
  for (let i = use.length - 1; i >= 0; i--) shape.lineTo(-use[i][0], -use[i][1]);
  shape.closePath();
  // HD (own ship): a 0.1 m bevel on the house tiers so the edges catch the light; the outline stays where it was
  // (bevelOffset −bev) and the height too (depth h − 2 bev, lifted by bev)
  const bev = ctx.hd && key === 'house' && h > 0.8 ? Math.min(0.1, h * 0.04) : 0;
  const g = new THREE.ExtrudeGeometry(shape, bev ? { depth: h - 2 * bev, bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelOffset: -bev, bevelSegments: 2, curveSegments: 1 }
    : { depth: h, bevelEnabled: false, curveSegments: 1 });
  g.rotateX(-Math.PI / 2); g.translate(0, y + bev, 0);
  const p = g.attributes.position, uv = g.attributes.uv, nn = g.attributes.normal;
  for (let i = 0; i < p.count; i++) {
    const nx = nn.getX(i), ny = nn.getY(i), nz = nn.getZ(i);
    let b, u;
    if (Math.abs(ny) > 0.5) { b = 3; u = p.getX(i) / BAND_TILE[3]; }
    else if (Math.abs(nx) >= Math.abs(nz)) { b = band; u = p.getZ(i) / BAND_TILE[b]; }
    else { b = endBand; u = p.getX(i) / BAND_TILE[b]; }
    const vy = Math.abs(ny) > 0.5 ? 0.5 : clamp(0, 1, (p.getY(i) - y) / h);
    uv.setXY(i, u, (b + 0.03 + 0.94 * vy) / 4);
  }
  P.put(key, g, color);
}
function buildBridge(ctx) {
  const { ga, P, lod } = ctx;
  const b0 = ga.bridge, h = ga.house; if (!b0 || lod === 2) return;
  // an 'embedded' bridge needs a tier that holds it; without one (hsc112) it is a wheelhouse of its own on the top deck
  const held = !b0.embedded || (h && h.tiers.some((t) => t.y <= b0.y + 0.1 && t.y + t.h >= b0.y + b0.h - 0.3 && (t.z0 ?? h.z0) <= b0.z0 + 0.5));
  const b = held ? b0 : { ...b0, embedded: false, w: Math.min(b0.w ?? h.w, ga.B * 0.62) };
  const cx = 0, zc = (b.z0 + b.z1) / 2, len = b.z1 - b.z0, w = b.w ?? h.w;
  if (b.console) { // RIB: centre console with windscreen
    P.box('paint', 0.9, 1.0, 1.0, 0, b.y + 0.5, zc, COL.white); P.box('glass', 0.85, 0.45, 0.05, 0, b.y + 1.2, b.z0 + 0.1, null, 0, -0.5); return;
  }
  if (!b.embedded) {
    // the wheelhouse: a glass band all round on small craft / tugs, forward + sides on merchant ships
    P.facade('house', w, b.h, len, cx, b.y + b.h / 2, zc, BANDS.blank, BANDS.blank);
    const gy = b.y + b.h * 0.62, gh = b.h * 0.42;
    P.box('glass', w * 0.98, gh, 0.12, cx, gy, b.z0 - 0.04, null, 0, -0.12);
    P.box('glass', 0.12, gh, len * 0.85, cx - w / 2 - 0.04, gy, zc); P.box('glass', 0.12, gh, len * 0.85, cx + w / 2 + 0.04, gy, zc);
    if (b.allRound || b.aftConsole) P.box('glass', w * 0.9, gh, 0.12, cx, gy, b.z1 + 0.04);
    if (lod === 0 && !ctx.primer) {
      // window frames: mullions across the raked front and along the sides, a sun visor over the front
      const hc = ga.livery.house;
      for (let x = -w / 2 + 1.25; x < w / 2 - 0.3; x += 1.25) P.box('paint', 0.1, gh * 1.02, 0.2, cx + x, gy, b.z0 - 0.06, hc, 0, -0.12);
      for (const sx of [-1, 1]) for (let z = b.z0 + 1.2; z < b.z0 + len * 0.9; z += 1.25) P.box('paint', 0.2, gh * 1.02, 0.1, cx + sx * (w / 2 + 0.06), gy, z, hc);
      P.box('paint', w, 0.08, 0.7, cx, gy + gh / 2 + 0.14, b.z0 - 0.3, hc);
    }
    // roof (compass deck) overhang + sun visor
    P.box('paint', w + 0.6, 0.3, len + 0.8, cx, b.y + b.h + 0.15, zc - 0.2, ctx.primer ? COL.primer : (ga.livery.house));
  } else {
    // embedded bridge (cruise, yachts): the tier's own facade is the glass band (tier use 'bridge')
  }
  // wings to the ship's side (§6.3): open platforms or enclosed cabs
  if (b.wings !== 'none' && b.wingTo > w / 2 + 0.3) {
    const ww = b.wingTo - w / 2, wl = Math.min(len * 0.7, 4.5), wz = b.z0 + wl / 2 + 0.2;
    for (const s of [-1, 1]) {
      const x = s * (w / 2 + ww / 2);
      if (b.wings === 'enclosed') { P.facade('house', ww, b.h, wl, x, b.y + b.h / 2, wz, BANDS.blank, BANDS.blank); P.box('glass', ww, b.h * 0.42, 0.12, x, b.y + b.h * 0.62, wz - wl / 2 - 0.04); P.box('glass', 0.12, b.h * 0.42, wl * 0.8, s * b.wingTo + s * 0.04, b.y + b.h * 0.62, wz); }
      else { P.box('paint', ww, 0.25, wl, x, b.y + 0.12, wz, ctx.primer ? COL.primer : ga.livery.house); P.box('paint', ww, 1.1, 0.12, x, b.y + 0.65, wz - wl / 2, ctx.primer ? COL.primer : ga.livery.house); P.box('paint', 1.2, 1.2, 1.0, s * (b.wingTo - 0.7), b.y + 0.85, wz - wl / 2 + 0.8, COL.dark); }
      // wing supports on big ships
      if (!b.embedded && ww > 3 && ga.L > 80) P.rod('metal', s * (b.wingTo - 0.6), b.y, wz, s * (w / 2 + 0.2), b.y - Math.min(6, ww * 0.8), wz, 0.12, COL.light, 5);
    }
  }
  // radar mast / arch on the compass deck: two scanners, masthead light, antennas
  const topY = b.embedded ? (h.tiers[h.tiers.length - 1].y + h.tiers[h.tiers.length - 1].h) : b.y + b.h + 0.3;
  const mz = b.embedded ? (ga.gen === 'cruise' ? b.z0 + 12 : b.z0 + 3) : zc;
  const mh = clamp(2.2, 9, ga.L * 0.035 + 2);
  const mast = ga.deck.masts.find((x) => x.arch);
  if (mast) { // yacht radar arch
    for (const s of [-1, 1]) P.beam('paint', s * w * 0.32, topY, mz + 1, s * w * 0.22, topY + mast.h, mz - 0.3, 0.35, 0.25, COL.white);
    P.beam('paint', -w * 0.24, topY + mast.h, mz - 0.3, w * 0.24, topY + mast.h, mz - 0.3, 0.35, 0.3, COL.white);
    P.box('paint', 1.6, 0.18, 0.4, 0, topY + mast.h + 0.35, mz - 0.3, COL.white);
  } else if (ga.gen !== 'small_fast' && b.y > 0) {
    radarMast(ctx, topY, mz, mh, w, b.z1);
  } else {
    P.rod('metal', 0, topY, mz, 0, topY + 1.6, mz, 0.06, COL.light, 5); P.box('paint', 0.9, 0.12, 0.25, 0, topY + 1.0, mz, COL.dark);
  }
}
/**
 * The radar mast on the compass deck (every ship with a wheelhouse): a pole braced by two raked legs, two platforms
 * with the X-band and S-band scanners on pedestals (the S-band the longer, higher one), the yardarm, whip antennas
 * at the deck corners and the satcom domes aft. Cruise ships carry a white, heavier mast with bigger domes.
 */
function radarMast(ctx, topY, mz, mh, w, zAft) {
  const { ga, P, lod } = ctx;
  const cruise = ga.gen === 'cruise' || ga.gen === 'ferry';
  const mc = ctx.primer ? COL.primer : cruise ? 0xf0f1ee : COL.light, dark = COL.dark;
  const pr = 0.12 + ga.L * 0.0008;
  P.rod(cruise ? 'paint' : 'metal', 0, topY, mz, 0, topY + mh, mz, pr * (cruise ? 1.6 : 1), mc, ctx.phone ? 5 : 7);
  if (lod === 0) for (const s of [-1, 1]) P.rod(cruise ? 'paint' : 'metal', s * Math.min(1.6, w * 0.12), topY, mz + Math.min(2.2, mh * 0.3), 0, topY + mh * 0.62, mz, pr * 0.6, mc, 5);
  // yardarm with the masthead / all-round lights
  P.beam('metal', -Math.min(3.5, w * 0.3), topY + mh * 0.82, mz, Math.min(3.5, w * 0.3), topY + mh * 0.82, mz, 0.18, 0.18, mc);
  // scanners: X-band on the lower platform forward, S-band on top
  const sx = Math.min(3.2, 1 + ga.L * 0.01), ss = Math.min(4.2, 1.2 + ga.L * 0.012);
  const yA = topY + mh * 0.48, yB = topY + mh;
  P.box('paint', Math.min(2.6, sx * 0.8), 0.12, 1.4, 0, yA, mz - 0.5, mc);                          // platform (grating)
  P.box('paint', 0.35, 0.45, 0.35, 0, yA + 0.28, mz - 0.6, dark);                                   // turning unit
  P.box('paint', sx, 0.2, 0.32, 0, yA + 0.6, mz - 0.6, dark);                                        // X-band antenna
  P.box('paint', Math.min(2.2, ss * 0.6), 0.12, 1.2, 0, yB, mz, mc);
  P.box('paint', 0.4, 0.5, 0.4, 0, yB + 0.3, mz, dark);
  P.box('paint', ss, 0.26, 0.34, 0, yB + 0.68, mz, dark);                                            // S-band antenna
  if (lod > 0) return;
  // satcom domes on pedestals aft on the compass deck (bigger on passenger ships)
  const dr = cruise ? clamp(0.6, 2.2, ga.B * 0.04) : 0.45;
  for (const s of [-1, 1]) { P.cyl('paint', dr * 0.6, dr * 1.4, s * w * 0.3, topY + dr * 0.7, zAft - 1 - dr, mc, dr * 0.6, 8); P.ellipsoid('paint', dr, dr, dr, s * w * 0.3, topY + dr * 1.4 + dr * 0.8, zAft - 1 - dr, COL.white, 10); }
  // whip antennas: deck corners and the yardarm ends
  const wh = clamp(2.5, 6, ga.L * 0.025);
  for (const s of [-1, 1]) {
    P.icyl('metal', 0.04, wh, s * (w / 2 - 0.4), topY + wh / 2, zAft - 0.5, COL.light);
    P.icyl('metal', 0.035, wh * 0.6, s * Math.min(3.4, w * 0.29), topY + mh * 0.82 + wh * 0.3, mz, COL.light);
  }
  P.icyl('metal', 0.035, wh * 0.7, 0, yB + 1 + wh * 0.35, mz + 0.4, COL.light);
}

// ------------------------------------------------------------------------------------------------ funnel
function supportY(ctx, z) {
  const h = ctx.ga.house; let y = ctx.hf.deckAt(z);
  if (h) for (const t of h.tiers) { const z0 = t.z0 ?? h.z0, z1 = t.z1 ?? h.z1; if (z >= z0 - 0.5 && z <= z1 + 0.5) y = Math.max(y, t.use === 'lido' && ctx.ga.gen === 'cruise' ? t.y + 0.3 : t.y + t.h); }
  return y;
}
function buildFunnel(ctx) {
  const { ga, P, lod } = ctx;
  const f = ga.funnel; if (!f || f.kind === 'none' || !(f.h > 0)) return;
  const top = f.y + f.h;
  if (f.kind === 'side' || f.kind === 'mast') {
    // offshore / tugs: exhaust stacks either side of the house (or in the mast)
    const h = ga.house, xs = f.kind === 'mast' ? [0.35] : [-(h.w / 2 - Math.max(0.5, f.r * 1.2)), h.w / 2 - Math.max(0.5, f.r * 1.2)];
    for (const x of xs) {
      const base = f.kind === 'mast' ? supportY(ctx, f.z) : f.y;
      if (f.kind === 'side' && ga.gen === 'offshore') {
        // tall casing trunks rising along the house sides
        P.box('funnel', f.r * 1.6, top - base, f.r * 2.4, x, (top + base) / 2, f.z, null);
        P.box('paint', f.r * 1.7, 0.4, f.r * 2.5, x, top + 0.2, f.z, COL.dark);
      } else {
        P.cyl('funnel', f.r, top - base, x, (top + base) / 2, f.z, null, f.r, lod === 0 ? 10 : 6);
        P.cyl('paint', f.r * 1.05, 0.25, x, top, f.z, COL.dark, f.r * 1.05, lod === 0 ? 10 : 6);
      }
    }
    return;
  }
  const base = Math.min(f.y, supportY(ctx, f.z));
  const xs = f.kind === 'twin' && ga.gen !== 'lng' && ga.gen !== 'special' ? [-f.r * 1.15, f.r * 1.15] : [0];
  if (ga.gen === 'cruise' && lod < 2 && f.h > 3) {
    // a modern cruise funnel: a wide streamlined casing (white, the livery's colour at the top) wraps the uptakes; the
    // exhaust stacks rise from it, with a wind-deflecting fin round its top edge
    const a = Math.max(f.r * 2.4, ga.B * 0.12), bb = a * 1.7, ch = (f.y + f.h - base) * 0.62;
    const sh = new THREE.Shape(), rc = a * 0.9;
    sh.moveTo(-a + rc, -bb); sh.lineTo(a - rc, -bb); sh.quadraticCurveTo(a, -bb, a, -bb + rc); sh.lineTo(a * 0.75, bb - rc * 0.4); sh.quadraticCurveTo(a * 0.6, bb, 0, bb); sh.quadraticCurveTo(-a * 0.6, bb, -a * 0.75, bb - rc * 0.4); sh.lineTo(-a, -bb + rc); sh.quadraticCurveTo(-a, -bb, -a + rc, -bb);
    const g = new THREE.ExtrudeGeometry(sh, { depth: ch, bevelEnabled: false, curveSegments: lod === 0 ? 4 : 2 });
    g.rotateX(-Math.PI / 2);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) { const yy = p.getY(i), k = yy / ch; p.setXYZ(i, p.getX(i) * (1 - 0.12 * k), yy, p.getZ(i) * (1 - 0.1 * k) + yy * 0.18); }
    g.computeVertexNormals(); g.translate(0, base, f.z);
    P.put('paint', g, ctx.primer ? COL.primer : ga.livery.house);
    const ty = base + ch;
    P.box('funnel', a * 1.85, Math.min(1.4, ch * 0.12), bb * 1.7, 0, ty - Math.min(0.7, ch * 0.06), f.z + ch * 0.18, null);   // livery band at the casing top
    if (lod === 0) P.box('paint', a * 2.1, 0.25, bb * 0.8, 0, ty + 0.4, f.z + ch * 0.18 + bb * 0.75, COL.dark);              // the fin aft
  }
  const r = f.kind === 'twin' && xs.length === 2 ? f.r * 0.85 : f.r;
  for (const x of xs) {
    if (lod === 2) { P.box('funnel', r * 2, top - base, r * 3, x, (top + base) / 2, f.z); continue; }
    if (ctx.hd) { latheFunnel(ctx, x, base, top, r); continue; }
    const shape = new THREE.Shape(), a = r, b = r * (ga.gen === 'cruise' ? 1.9 : 1.45), rc = r * 0.6;
    shape.moveTo(-a + rc, -b); shape.lineTo(a - rc, -b); shape.quadraticCurveTo(a, -b, a, -b + rc); shape.lineTo(a, b - rc); shape.quadraticCurveTo(a, b, a - rc, b); shape.lineTo(-a + rc, b); shape.quadraticCurveTo(-a, b, -a, b - rc); shape.lineTo(-a, -b + rc); shape.quadraticCurveTo(-a, -b, -a + rc, -b);
    const hh = top - base;
    const g = new THREE.ExtrudeGeometry(shape, { depth: hh, bevelEnabled: false, curveSegments: lod === 0 && !ctx.phone ? 4 : 2 });
    g.rotateX(-Math.PI / 2);
    // rake aft and slight taper towards the top
    const p = g.attributes.position;
    const rake = hh > 20 ? 0.04 : 0.12;   // tall twin-island casings stand nearly upright
    for (let i = 0; i < p.count; i++) { const yy = p.getY(i), k = yy / hh; p.setXYZ(i, p.getX(i) * (1 - 0.08 * k), yy, p.getZ(i) * (1 - 0.05 * k) + yy * rake); }
    g.computeVertexNormals();
    g.translate(x, base, f.z);
    P.put('funnel', g);
    // black top and exhaust pipes
    P.box('paint', a * 1.9, Math.min(1.6, hh * 0.1), b * 1.9, x, top - Math.min(0.8, hh * 0.05), f.z + hh * 0.12 - 0.1, COL.dark);
    if (lod === 0) for (const dx of [-a * 0.35, a * 0.35]) P.cyl('metal', a * 0.18, 1.6, x + dx, top + 0.6, f.z + hh * 0.12, COL.steel, a * 0.18, 8);
    const fb = ga.livery.funnelBand ?? ga.livery.band;
    if (fb != null && !ctx.primer && lod === 0) {
      // the company band; with a mark it is as tall as the mark's disc and centred on it (decal at f.y + 0.62 h)
      const my = f.y + f.h * 0.62, bh = ga.livery.mark ? Math.max(hh * 0.12, clamp(0.8, 9, f.r * 1.6) * 1.12) : hh * 0.12, by = ga.livery.mark ? my : base + hh * 0.66;
      const k = 1 - 0.08 * ((by - base) / hh), rk = 1 - 0.05 * ((by - base) / hh);
      P.box('paint', a * 2.02 * k, bh, b * 2.02 * rk, x, by, f.z + (by - base) * rake, fb);
    }
  }
  if (ga.gen === 'lng' || ga.gen === 'special') { /* twin uptakes inside one wide casing */ }
}

/**
 * HD funnel (own ship, LOD0): lathe-turned casing in a rounded-rectangle section (superellipse, exponent 4, half-width
 * r, half-length r · 1.45 / 1.9 cruise), raked and tapered like the extruded one, with a black top that flares into a
 * lip, an inner wall and a floor (the top reads hollow from the bridge wings), the company band as a proud ring.
 * Every piece is its own 2-point lathe so the corners stay sharp; same material keys as the plain funnel.
 */
function latheFunnel(ctx, x, base, top, r) {
  const { ga, P, phone } = ctx, f = ga.funnel;
  const a = r, b = r * (ga.gen === 'cruise' ? 1.9 : 1.45), hh = top - base;
  const rake = hh > 20 ? 0.04 : 0.12, seg = phone ? 20 : 32;
  const tb = Math.min(1.6, hh * 0.1), lipOut = Math.min(0.06, 0.25 / Math.max(a, 0.5)), lipH = Math.min(0.35, tb * 0.3);
  const ring = (key, r0, y0, r1, y1, color) => {
    const g = new THREE.LatheGeometry([new THREE.Vector2(r0, y0), new THREE.Vector2(r1, y1)], seg);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const px = p.getX(i), py = p.getY(i), pz = p.getZ(i), rr = Math.hypot(px, pz);
      // superellipse section: |x/a|^4 + |z/b|^4 = 1 along each ray (rounded rectangle, flat sides for the mark)
      let sx = 0, sz = 0;
      if (rr > 1e-6) { const c = px / rr, s = pz / rr, k = Math.pow(Math.pow(Math.abs(c), 4) + Math.pow(Math.abs(s), 4), -0.25); sx = c * k * rr * a; sz = s * k * rr * b; }
      const t = py / hh;
      p.setXYZ(i, x + sx * (1 - 0.08 * t), base + py, f.z + sz * (1 - 0.05 * t) + py * rake);
    }
    g.computeVertexNormals();
    P.put(key, g, color);
  };
  const dark = COL.dark;
  ring('funnel', 1, 0, 1, hh - tb);                                    // casing
  ring('paint', 1, hh - tb, 1, hh - lipH, dark);                       // black top
  ring('paint', 1, hh - lipH, 1 + lipOut, hh - lipH * 0.4, dark);      // the lip flares out
  ring('paint', 1 + lipOut, hh - lipH * 0.4, 1 + lipOut, hh, dark);
  ring('paint', 1 + lipOut, hh, 0.9, hh, dark);                        // rim
  ring('paint', 0.9, hh, 0.9, hh - tb * 0.8, dark);                    // inner wall (faces the axis)
  ring('paint', 0.9, hh - tb * 0.8, 0, hh - tb * 0.8, dark);           // floor of the casing top
  for (const dx of [-a * 0.35, a * 0.35]) P.cyl('metal', a * 0.18, 1.6 + tb * 0.8, x + dx, top - tb * 0.4 + 0.8, f.z + hh * 0.12, COL.steel, a * 0.18, phone ? 8 : 12);
  const fb = ga.livery.funnelBand ?? ga.livery.band;
  if (fb != null && !ctx.primer) {
    const my = f.y + f.h * 0.62, bh = ga.livery.mark ? Math.max(hh * 0.12, clamp(0.8, 9, f.r * 1.6) * 1.12) : hh * 0.12, by = ga.livery.mark ? my : base + hh * 0.66;
    const y0 = clamp(0, hh - tb - 0.05, by - base - bh / 2), y1 = clamp(0, hh - tb, by - base + bh / 2), out = 1 + Math.min(0.012, 0.04 / Math.max(a, 0.5));
    if (y1 - y0 > 0.05) { ring('paint', 1, y0, out, y0, fb); ring('paint', out, y0, out, y1, fb); ring('paint', out, y1, 1, y1, fb); }
  }
}

// ------------------------------------------------------------------------------------------------ cargo spaces
function buildCargo(ctx) {
  const { ga, P, lod } = ctx;
  const c = ga.cargo; if (!c) return;
  const dy = ga.deckY;
  switch (c.kind) {
    case 'holds': {
      const hatch = ga.gen === 'aft_house_dry' && ['coaster', 'shortsea88', 'gc120', 'mpp160'].includes(ga.model) ? COL.hatchGrey : ctx.rnd() < 0.5 ? COL.hatchRed : COL.hatchGrey;
      for (const z of c.zones) {
        const zl = z.z1 - z.z0, zc = (z.z0 + z.z1) / 2, y0 = ctx.hf.deckAt(zc);
        P.box('paint', z.w + 0.4, z.coaming, zl + 0.4, 0, y0 + z.coaming / 2, zc, 0x5d6268);
        if (lod === 2) continue;
        // side-rolling / folding covers: two panels with a ridge
        for (const s of [-1, 1]) P.box('paint', z.w / 2, 0.7, zl, s * z.w / 4, y0 + z.coaming + 0.35, zc, hatch, 0, 0, s * -0.06);
        if (lod === 0 && zl > 10) for (let k = 1; k < 4; k++) P.box('paint', z.w + 0.1, 0.18, 0.35, 0, y0 + z.coaming + 0.72, z.z0 + zl * k / 4, 0x4a4f55);
        if (lod === 0) {
          // cover top: transverse stiffener ribs (~1.7 m), edge girders and the centre ridge; coaming top bar + cleats
          const rib = shade(hatch, 0.82), n = Math.max(3, Math.round(zl / 1.7)), ty = y0 + z.coaming + 0.7;
          for (const s of [-1, 1]) {
            const cx = s * z.w / 4, tilt = s * -0.06;
            for (let k = 1; k < n; k++) P.box('paint', z.w / 2 - 0.3, 0.2, 0.22, cx, ty + 0.09, z.z0 + zl * k / n, rib, 0, 0, tilt);
            P.box('paint', 0.28, 0.32, zl - 0.2, s * (z.w / 2 - 0.12), ty - 0.02 - z.w / 4 * 0.06, zc, rib);
          }
          P.box('paint', 0.3, 0.16, zl, 0, ty + z.w / 4 * 0.06 + 0.04, zc, rib);
          P.box('paint', z.w + 0.6, 0.12, 0.3, 0, y0 + z.coaming + 0.06, z.z0 - 0.05, 0x7a8086); P.box('paint', z.w + 0.6, 0.12, 0.3, 0, y0 + z.coaming + 0.06, z.z1 + 0.05, 0x7a8086);
          for (const s of [-1, 1]) P.box('paint', 0.3, 0.12, zl + 0.6, s * (z.w / 2 + 0.15), y0 + z.coaming + 0.06, zc, 0x7a8086);
          // coaming stays: bracket plates every ~2.4 m along the sides (instanced; half as many on phones)
          const nst = Math.max(2, Math.round(zl / (ctx.phone ? 4.8 : 2.4)));
          for (let k = 0; k <= nst; k++) for (const s of [-1, 1]) P.ifin('paint', 0.7, z.coaming * 0.9, s * (z.w / 2 + 0.55), y0 + z.coaming * 0.45, z.z0 + zl * k / nst, 0x5d6268, Math.PI / 2);
        }
      }
      break;
    }
    case 'pens': {
      const z = c.zones[0], zl = z.z1 - z.z0, zc = (z.z0 + z.z1) / 2;
      for (let k = 0; k < z.tiers; k++) {
        const y = dy + k * z.h;
        P.box('paint', z.w, 0.25, zl, 0, y + z.h, zc, ctx.primer ? COL.primer : ga.livery.house);
        if (lod < 2) for (let i = 0; i <= Math.floor(zl / 6); i++) for (const s of [-1, 1]) P.box('paint', 0.2, z.h, 0.2, s * (z.w / 2 - 0.1), y + z.h / 2, z.z0 + i * 6, COL.light);
      }
      P.facade('house', z.w - 1.5, z.tiers * z.h, zl - 1, 0, dy + z.tiers * z.h / 2, zc, BANDS.blank, BANDS.blank);
      if (lod < 2) for (let k = 0; k < z.tiers; k++) for (const s of [-1, 1]) P.box('paint', 0.1, z.h * 0.45, zl, s * (z.w / 2), dy + k * z.h + z.h * 0.75, zc, 0x6d7276);
      break;
    }
    case 'bays': {
      const y0 = c.hatchY ?? dy + 1.6;
      const fwdN = c.zones.filter((z) => z.z1 <= (ga.house?.z0 ?? 0)).length;
      c.zones.forEach((z, i) => {
        const zc = (z.z0 + z.z1) / 2, wHatch = z.rows * 2.55 + 0.4;
        const ydk = ctx.hf.deckAt(zc);
        P.box('paint', wHatch, y0 - ydk, 12.6, 0, (y0 + ydk) / 2, zc, 0x5d6268);
        if (lod === 0 && i > 0) { // lashing bridge (3 tiers) between bays
          const lb = Math.min(3, z.tiersDeck) * 2.59;
          P.box('paint', wHatch, 0.3, 0.8, 0, y0 + lb, z.z0 - 0.4, 0xd9b44a); for (const s of [-1, 1]) P.box('paint', 0.3, lb, 0.6, s * wHatch / 2, y0 + lb / 2, z.z0 - 0.4, 0xd9b44a);
        }
        if (!ctx.cargo) return;
        if (lod === 2) { P.put('cargo', stackBox(wHatch - 0.4, z.tiersDeck * 2.59, 12.2, 0, y0, zc, 5, z.tiersDeck), null); return; }
        if (lod === 1) { P.put('cargo', stackBox(wHatch - 0.4, z.tiersDeck * 2.59, 12.2, 0, y0, zc, (i * 7) % 16, z.tiersDeck, z.rows), 0xffffff); return; }
        const stacks = bayStacks(z.rows, z.tiersDeck, { fwd: i < 2 && i < fwdN, rnd: ctx.rnd });
        for (const s of stacks) {
          if (s.tiers <= 0) continue;
          const col = Math.floor(ctx.rnd() * 16);
          P.put('cargo', stackBox(2.44, s.tiers * 2.59, 12.19, s.x, y0, zc, col, s.tiers), CONTAINERS ? 0xffffff : CONTAINER_PALETTE[col % CONTAINER_PALETTE.length]);
        }
      });
      if (ga.deck.breakwater && lod < 2) { // V-shaped breakwater at the fore end of the stacks
        const b = ga.deck.breakwater, hw = c.rows * 1.28 + 0.6;
        for (const s of [-1, 1]) P.beam('hullX', 0, dy + b.h / 2, b.z - 3, s * hw, dy + b.h / 2, b.z, 0.3, b.h);
      }
      break;
    }
    case 'tanks': {
      const zs = c.zones;
      if (zs[0]?.shape) { // LPG / LNG type C cylinders on deck
        for (const z of zs) {
          const len = z.z1 - z.z0, zc = (z.z0 + z.z1) / 2;
          const col = ctx.primer ? COL.primer : 0xe8eaea;
          if (z.shape === 'bilobe') for (const s of [-1, 1]) P.capsule('paint', z.r * 0.55, len - z.r * 1.1, s * z.r * 0.5, z.cy, zc, col);
          else P.capsule('paint', z.r, Math.max(0.1, len - 2 * z.r), 0, z.cy, zc, col);
          P.cyl('paint', 0.8, 1.6, 0, z.cy + z.r + 0.6, zc, 0xd0d4d6, 0.8, 8);
          for (const s of [-1, 1]) P.box('paint', z.r * 1.4, z.r * 0.8, 1.2, 0, dy + 0.4, zc + s * len * 0.3, 0x5d6268);
        }
      } else if (lod < 2) {
        // tank deck: pipe rack, expansion trunks / gas domes, deck pipes
        const za = zs[0].z0, zb = zs[zs.length - 1].z1, B = ga.B;
        // pipe rack on stools: cargo lines (largest), stripping / vapour lines, the red fire main and foam line along the side
        const sc = 0.18 + ga.L * 0.0006, py = dy + 1.3;
        const pipes = lod === 0 ? [[-B * 0.08, sc * 1.5, COL.light], [-B * 0.08 + 0.75 * sc / 0.25, sc * 1.5, COL.light], [-B * 0.08 + 1.5 * sc / 0.25, sc * 1.3, COL.light], [-B * 0.08 + 2.15 * sc / 0.25, sc * 0.8, 0xbfc4c6], [-B * 0.08 + 2.65 * sc / 0.25, sc * 0.6, 0x8d9296]] : [[-B * 0.04, sc * 1.5, COL.light], [B * 0.04, sc * 1.2, COL.light]];
        for (const [x, r, c] of pipes) P.rod('metal', x, py, za, x, py, zb, r, c, 6);
        if (lod === 0) {
          const x0 = pipes[0][0] - sc * 2, x1 = pipes[pipes.length - 1][0] + sc * 2;
          for (let z = za + 2; z < zb; z += 6) { P.box('paint', x1 - x0, 0.18, 0.3, (x0 + x1) / 2, py - sc * 1.6, z, 0x6d7276); P.box('paint', 0.25, py - sc * 1.6 - dy, 0.25, x0 + 0.2, (py - sc * 1.6 + dy) / 2, z, 0x6d7276); P.box('paint', 0.25, py - sc * 1.6 - dy, 0.25, x1 - 0.2, (py - sc * 1.6 + dy) / 2, z, 0x6d7276); }
          for (const s of [-1, 1]) { const x = s * (B / 2 - 2.7); P.rod('metal', x, dy + 0.55, za, x, dy + 0.55, zb, 0.09 + ga.L * 0.0002, COL.red, 6); for (let z = za + 3; z < zb; z += 9) P.box('paint', 0.2, 0.45, 0.2, x, dy + 0.22, z, 0x6d7276); }
        }
        for (const z of zs) {
          const zc = (z.z0 + z.z1) / 2;
          if (z.domes) { P.cyl('paint', B * 0.08, 2.4, 0, dy + 1.2, zc, 0xd8dadb, B * 0.08, 12); P.cyl('paint', 0.6, 1.5, B * 0.15, dy + 0.75, zc, COL.light, 0.6, 8); }
          else if (lod === 0) for (const s of [-1, 1]) { P.box('paint', 1.6, 0.9, 1.6, s * B * 0.25, dy + 0.45, zc, 0xc9cdd0); P.cyl('metal', 0.25, 2.5, s * B * 0.25, dy + 1.9, zc, COL.light, 0.25, 6); }
        }
      }
      break;
    }
    case 'membrane': {
      // trunk deck over each tank, domes, catwalk along it
      for (const z of c.zones) {
        const zc = (z.z0 + z.z1) / 2, len = z.z1 - z.z0;
        P.box('hullX', z.w, z.trunkH, len, 0, dy + z.trunkH / 2, zc);
        P.box('deck', z.w - 0.2, 0.05, len - 0.2, 0, dy + z.trunkH + 0.03, zc);
        if (lod < 2) { P.cyl('paint', 2.2, 2.2, 0, dy + z.trunkH + 1.1, zc - len * 0.2, 0xd8dadb, 2.2, 12); P.cyl('paint', 1.6, 2.0, 0, dy + z.trunkH + 1.0, zc + len * 0.2, 0xd8dadb, 1.6, 10); }
      }
      break;
    }
    case 'cardecks': {
      const z = c.zones[0];
      if (c.open && lod < 2 && ctx.cargo) { // open car deck of a double-ended ferry: a few cars and trucks
        for (let i = 0; i < 10; i++) { const x = ((i % 4) - 1.5) * 2.6, zz = -ga.L * 0.3 + Math.floor(i / 4) * 6 + ctx.rnd() * 2; P.box('paint', 1.8, 1.45, 4.4, x, z.topY - 5 + 0.75, zz, CONTAINER_PALETTE[i % CONTAINER_PALETTE.length]); }
      }
      if (c.trailers && ctx.cargo && lod < 2) { const t = c.trailers; for (let r = -1; r <= 1; r++) for (let z2 = t.z0; z2 < t.z1 - 14; z2 += 15) if (ctx.rnd() < 0.8) P.box('paint', 2.55, 3.6, 13.6, r * 3.4, t.y + 1.8 + 0.6, z2 + 7, CONTAINER_PALETTE[Math.floor(ctx.rnd() * CONTAINER_PALETTE.length)]); }
      if (c.slab && lod < 2) { // PCTC: the topmost deck is a flat weather deck with a raised casing edge
        P.box('hullX', ga.B * 0.98, 1.2, ga.L * 0.86, 0, dy + 0.6, ga.L * 0.03);
        P.box('deck', ga.B * 0.96, 0.05, ga.L * 0.85, 0, dy + 1.22, ga.L * 0.03);
      }
      break;
    }
    case 'deck': {
      for (const z of c.zones) {
        const zc = (z.z0 + z.z1) / 2, len = z.z1 - z.z0;
        P.box('paint', z.w, 0.15, len, 0, ctx.hf.deckAt(zc) + 0.08, zc, 0x8a6d47);  // timber deck sheathing
        if (ga.gen === 'offshore' && lod < 2) for (const s of [-1, 1]) { // crash rails along the cargo deck
          for (let zz = z.z0; zz <= z.z1; zz += 3) P.box('paint', 0.25, 2.6, 0.25, s * (z.w / 2 + 0.1), ctx.hf.deckAt(zz) + 1.3, zz, 0xf2b134);
          P.box('paint', 0.3, 0.3, len, s * (z.w / 2 + 0.1), ctx.hf.deckAt(zc) + 2.6, zc, 0xf2b134);
        }
        if (ctx.cargo && ga.gen === 'offshore' && lod < 2) for (let i = 0; i < 6; i++) { const zz = z.z0 + 4 + i * (len - 8) / 6; P.box('paint', 2.4, 2.6, 6, (i % 2 ? 1 : -1) * z.w * 0.2, ctx.hf.deckAt(zz) + 1.45, zz, CONTAINER_PALETTE[i % CONTAINER_PALETTE.length]); if (i % 3 === 0) for (let k = 0; k < 3; k++) P.cyl('paint', 0.35, z.w * 0.5, 0, ctx.hf.deckAt(zz) + 0.5 + k * 0.7, zz + 4, 0x7d8186, 0.35, 8, 0, 0, Math.PI / 2); }
      }
      break;
    }
    case 'fishhold': {
      const z = c.zones[0], zc = (z.z0 + z.z1) / 2;
      P.box('paint', z.w * 0.4, 0.6, Math.min(3, (z.z1 - z.z0) * 0.3), 0, ctx.hf.deckAt(zc) + 0.3, zc, COL.hatchGrey);
      break;
    }
    case 'hopper': {
      const z = c.zones[0], zc = (z.z0 + z.z1) / 2, len = z.z1 - z.z0;
      // hopper well: coaming walls (open top), dark spoil inside
      for (const s of [-1, 1]) P.box('hullX', 0.5, 2.4, len, s * z.w / 2, dy + 1.2, zc);
      P.box('hullX', z.w, 2.4, 0.5, 0, dy + 1.2, z.z0); P.box('hullX', z.w, 2.4, 0.5, 0, dy + 1.2, z.z1);
      P.box('paint', z.w - 0.4, 0.1, len - 0.4, 0, dy - 0.6, zc, 0x5a4a35);
      break;
    }
    default: break;
  }
}
/** one container stack (or bay block): a box whose faces map one column of the container atlas, `tiers` slots high */
function stackBox(w, h, d, x, y0, z, col, tiers, rows = 1) {
  const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y0 + h / 2, z);
  const uv = g.attributes.uv, n = g.attributes.normal, p = g.attributes.position;
  const u0 = col / 16, u1 = (col + 1) / 16, v1 = Math.min(1, tiers / 16);
  for (let i = 0; i < uv.count; i++) {
    const ny = n.getY(i), nx = n.getX(i);
    const fy = (p.getY(i) - y0) / h;
    if (Math.abs(ny) > 0.5) { uv.setXY(i, u0 + (u1 - u0) * (uv.getX(i)), v1 - 0.5 / 16 + 0.4 / 16 * uv.getY(i)); continue; }
    const uu = Math.abs(nx) > 0.5 ? uv.getX(i) : uv.getX(i) * rows;
    uv.setXY(i, Math.abs(nx) > 0.5 ? u0 + (u1 - u0) * uu : (u0 + (u1 - u0) * (uu % 1 || (uu ? 1 : 0))), fy * v1);
  }
  return g;
}

// ------------------------------------------------------------------------------------------------ deck machinery and gear
function buildDeckGear(ctx) {
  const { ga, P, lod, hf } = ctx;
  const d = ga.deck, B = ga.B, L = ga.L, dy = ga.deckY;
  const yAt = (z) => hf.deckAt(z) + (ga.hull.fcsle && z < -L / 2 + ga.hull.fcsle.len ? ga.hull.fcsle.h : 0) + (ga.hull.poop && z > L / 2 - ga.hull.poop.len ? ga.hull.poop.h : 0);
  // cranes (pedestal + jib stowed fore-and-aft; heavy-lift pair stowed aft along the port side)
  for (const c of d.cranes) {
    const y = yAt(c.z), heavy = c.swl >= 200, knuckle = ['offshore', 'tug', 'motor_yacht', 'special'].includes(ga.gen);
    const col = heavy ? 0xe7e9ea : ga.gen === 'aft_house_dry' ? (ga.model === 'reefer150' ? 0xf2f2ee : 0xd5d9dc) : COL.yellow;
    const pr = heavy ? 2.4 : knuckle ? 0.5 : clamp(0.8, 1.6, c.swl / 30);
    P.cyl('paint', pr, c.h, c.x, y + c.h / 2, c.z, col, pr * 0.9, lod === 0 ? 12 : 8);
    if (lod === 2) continue;
    const hw = heavy ? 6 : knuckle ? 1.4 : 3.2;
    P.box('paint', hw, heavy ? 5 : knuckle ? 1.2 : 3, hw * 1.2, c.x, y + c.h + (heavy ? 2.5 : 1.4), c.z, col);
    const dir = heavy || (knuckle && c.z < 0) ? 1 : -1, ang = heavy ? 0.18 : knuckle ? 0.5 : 0.25;
    const bx = c.x, by = y + c.h + (heavy ? 3 : 1.8), bz = c.z + dir * hw * 0.5;
    const tx = bx, ty = by + Math.sin(ang) * c.boom, tz = bz + dir * Math.cos(ang) * c.boom;
    if (heavy) { for (const s of [-1, 1]) latticeJib(ctx, bx + s * 1.2, by, bz, tx + s * 0.4, ty, tz, 1.4, 1.8, col); }
    else if (knuckle) {   // knuckle boom folded: main boom up, outer boom folded back down
      const k1 = c.boom * 0.5, kx = bx, ky = by + Math.sin(1.0) * k1, kz = bz + dir * Math.cos(1.0) * k1;
      P.beam('paint', bx, by, bz, kx, ky, kz, 0.55, 0.65, col);
      P.beam('paint', kx, ky, kz, kx, by + 0.6, kz + dir * c.boom * 0.42, 0.45, 0.5, col);
      continue;
    } else if (lod === 0) latticeJib(ctx, bx, by, bz, tx, ty, tz, clamp(0.9, 1.8, c.swl / 22), clamp(1.1, 2.1, c.swl / 18), col);
    else P.beam('paint', bx, by, bz, tx, ty, tz, clamp(0.9, 1.6, c.swl / 25), clamp(1.1, 1.9, c.swl / 20), col);
    if (!knuckle && !heavy && lod === 0) { P.box('paint', 1.2, 0.4, 1.2, tx, yAt(tz) + ty - yAt(tz) - 0.4, tz, COL.dark); P.box('paint', 0.5, ty - yAt(tz) - 0.3, 0.5, tx, yAt(tz) + (ty - yAt(tz)) / 2 - 0.4, tz, col); }
    if (lod === 0) P.rod('metal', tx, ty, tz, tx, ty - Math.min(4, c.boom * 0.15), tz, 0.04, COL.dark, 4);
  }
  for (const h of d.hoseCranes || []) { const y = dy; P.cyl('paint', 0.45, 3, h.x, y + 1.5, h.z, COL.yellow, 0.4, 8); if (lod < 2) P.beam('paint', h.x, y + 3.2, h.z, h.x, y + 6, h.z + 9, 0.4, 0.5, COL.yellow); }
  if (d.manifold && lod < 2) { const z = d.manifold.z; P.box('paint', B * 0.9, 1.0, 2.2, 0, dy + 0.9, z, 0x8d9296); if (lod === 0) for (let k = -3; k <= 3; k++) for (const s of [-1, 1]) P.rod('metal', s * B * 0.3, dy + 1.2, z + k * 0.6, s * (B / 2 - 0.6), dy + 1.2, z + k * 0.6, 0.2, k % 2 ? 0xc0392b : COL.light, 6); }
  if (d.catwalk && lod < 2) {
    const c = d.catwalk; P.box('paint', 1.0, 0.15, c.z1 - c.z0, c.x, dy + c.h, (c.z0 + c.z1) / 2, COL.catwalk);
    if (lod === 0) {
      for (let z = c.z0; z <= c.z1; z += 6) for (const s of [-1, 1]) P.ibox('paint', 0.15, c.h, 0.15, c.x + s * 0.4, dy + c.h / 2, z, COL.catwalk);
      for (const s of [-1, 1]) railRun(ctx, [[c.x + s * 0.5, c.z0], [c.x + s * 0.5, c.z1]], () => dy + c.h + 0.07, 0.9, COL.catwalk);
    }
  }
  if (d.compressor && lod < 2) { const c = d.compressor, y = c.onTrunk ? dy + 3.6 : dy; P.facade('house', c.w, 4.2, c.z1 - c.z0, 0, y + 2.1, (c.z0 + c.z1) / 2, BANDS.blank, BANDS.blank); }
  // mooring: windlasses forward, winches aft (drums), bollards
  if (lod < 2 && ga.L >= 30 && ga.gen !== 'motor_yacht') for (const mo of d.mooring) {
    const y = mo.y ?? yAt(mo.z), s = clamp(0.5, 2.2, B * 0.04);
    for (const sx of [-1, 1]) { P.box('paint', s * 1.4, s * 0.9, s * 1.4, sx * B * 0.18, y + s * 0.45, mo.z, mo.kind === 'windlass' ? COL.dark : 0x3d5266); if (lod === 0) P.cyl('paint', s * 0.45, s * 1.4, sx * B * 0.18 + sx * s, y + s * 0.6, mo.z, COL.red, s * 0.45, 10, 0, 0, Math.PI / 2); }
    if (lod > 0) continue;
    // warping drums outboard of the winch, bollards at the deck edge; the anchor chain runs from the gypsy to the hawse pipe
    for (const sx of [-1, 1]) P.icyl('paint', s * 0.35, s * 0.9, sx * (B * 0.18 + s * 1.6), y + s * 0.5, mo.z, 0x8a9199, 0, 0, Math.PI / 2);
    bollards(ctx, mo.z + (mo.z < 0 ? 4 : -4), y, ga.L > 120 ? 2 : 1);
    const hw = ctx.hawse;
    if (mo.kind === 'windlass' && hw) for (const sx of [-1, 1]) P.ibeam('metal', sx * B * 0.18, y + s * 0.5, mo.z, sx * Math.max(1, hw.x - 1.2), y + 0.15, hw.z, 0.22, 0.12, 0x2a2c2e);
  }
  // spring-line bollards amidships on big ships (not between container bays or on passenger ships)
  if (lod === 0 && ga.L >= 60 && !['motor_yacht', 'cruise', 'ferry'].includes(ga.gen)) for (const z of [-L * 0.22, L * 0.18]) bollards(ctx, z, yAt(z), 1);
  // foremast + yacht/other masts
  for (const mm of d.masts) {
    if (mm.arch) continue;
    if (mm.z > (ga.bridge?.z0 ?? 0) - 1 && mm.z < (ga.bridge?.z1 ?? 0) + 1 && mm.y >= (ga.bridge?.y ?? 0)) continue;  // bridge-top masts drawn with the bridge
    const y = mm.y ?? yAt(mm.z);
    P.rod('metal', 0, y, mm.z, 0, y + mm.h, mm.z, 0.12 + mm.h * 0.012, COL.light, ctx.phone ? 5 : 8);
    if (lod === 0) {
      P.beam('metal', -1.2, y + mm.h * 0.75, mm.z, 1.2, y + mm.h * 0.75, mm.z, 0.12, 0.12, COL.light);
      // lookout / light platform with its rail, a ladder up the mast and a whip on top
      const py = y + mm.h * 0.6; P.box('paint', 1.6, 0.1, 1.6, 0, py, mm.z, COL.light);
      railRun(ctx, [[-0.75, mm.z - 0.75], [0.75, mm.z - 0.75], [0.75, mm.z + 0.75], [-0.75, mm.z + 0.75], [-0.75, mm.z - 0.75]], () => py, 0.9, COL.light, true);
      for (const sx of [-0.25, 0.25]) P.ibeam('metal', sx, y, mm.z + 0.35, sx, py, mm.z + 0.35, 0.05, 0.05, COL.light);
      P.icyl('metal', 0.03, 3, 0, y + mm.h + 1.5, mm.z, COL.light);
    }
  }
  // Flettner rotors (option rot): tall cylinders with end discs
  for (const r of d.rotors) { const y = yAt(r.z); P.cyl('paint', r.r, r.h, r.x, y + r.h / 2 + 1.5, r.z, 0xf3f3f0, r.r, 16); P.cyl('paint', r.r * 1.5, 0.3, r.x, y + r.h + 1.6, r.z, 0x2a6fb0, r.r * 1.5, 16); P.cyl('paint', r.r * 1.1, 1.5, r.x, y + 0.75, r.z, 0x5d6268, r.r * 1.1, 12); }
  // lifesaving appliances
  for (const b of d.boats) boat(ctx, b);
  // workboat / offshore gear
  if (d.sternRoller) P.cyl('paint', 1.0, d.sternRoller.w, 0, dy - 0.2, Math.min(d.sternRoller.z, L / 2 - 1.05), COL.dark, 1.0, 12, 0, 0, Math.PI / 2);
  if (d.sternRoller && lod === 0 && ga.gen === 'offshore') for (const s of [-1, 1]) { P.box('paint', 0.5, 1.6, 0.8, s * 1.4, dy + 0.8, L / 2 - 4, 0xd9531e); P.box('paint', 0.35, 1.8, 0.35, s * 3.2, dy + 0.9, L / 2 - 5.5, 0xf2b134); }
  if (d.towWinch) { const z = d.towWinch.z, y = yAt(z); P.box('paint', d.towWinch.w, 1.8, 2.4, 0, y + 0.9, z, 0x3d5266); P.cyl('paint', 1.0, d.towWinch.w * 0.8, 0, y + 1.4, z + (d.towWinch.fwd ? -1.4 : 1.4), COL.red, 1.0, 12, 0, 0, Math.PI / 2); }
  if (d.staple && lod < 2) { const s = d.staple, y = yAt(s.z); for (const sx of [-1, 1]) P.rod('metal', sx * s.w / 2, y, s.z, sx * s.w / 2, y + 2.8, s.z, 0.18, 0xd9531e, 8); P.rod('metal', -s.w / 2, y + 2.8, s.z, s.w / 2, y + 2.8, s.z, 0.18, 0xd9531e, 8); }
  if (d.fifi && lod < 2) for (const s of [-1, 1]) { P.cyl('paint', 0.25, 0.9, s * 1.2, d.fifi.y, d.fifi.z, COL.red, 0.2, 8); P.rod('paint', s * 1.2, d.fifi.y + 0.4, d.fifi.z, s * 1.2, d.fifi.y + 0.6, d.fifi.z - 1.0, 0.12, COL.red, 6); }
  if (d.gangway) { const g = d.gangway, y = yAt(g.z); P.box('paint', 3.2, g.h, 3.2, g.x, y + g.h / 2, g.z, COL.white); if (lod < 2) { P.beam('paint', g.x, y + g.h, g.z, g.x, y + g.h + 0.6, g.z + g.len * 0.75, 1.6, 1.2, 0xe8e8e8); P.box('paint', 2.4, 3, 2.4, -B * 0.28, y + 1.5, g.z + 6, COL.white); } }
  if (d.aframe) { // stern A-frame / trawl gantry
    const a = d.aframe, y = yAt(a.z);
    for (const s of [-1, 1]) P.beam('paint', s * a.w / 2, y, a.z, s * a.w / 2.4, y + a.h, a.z + (a.kind === 'gantry' ? 0 : 0.8), 0.6, 0.6, a.kind === 'gantry' ? 0xd9a520 : 0xd9531e);
    P.beam('paint', -a.w / 2.4, y + a.h, a.z, a.w / 2.4, y + a.h, a.z, 0.7, 0.7, a.kind === 'gantry' ? 0xd9a520 : 0xd9531e);
    if (a.kind === 'gantry' && lod < 2) for (const s of [-1, 1]) P.cyl('paint', 1.1, B * 0.3, s * B * 0.17, y + 1.3, a.z - 6, 0x2f6b8a, 1.1, 10, 0, 0, Math.PI / 2);
  }
  if (ga.hull.stern === 'ramp' && lod < 2) P.box('paint', B * 0.32, 0.3, 6, 0, dy - 0.8, L / 2 - 3.3, COL.dark, 0, -0.35);
  if (d.derricks && lod < 2) { const dz = d.derricks.z, y = yAt(dz); P.rod('metal', 0, y, dz, 0, y + 12, dz, 0.25, COL.light, 8); for (const s of [-1, 1]) P.beam('paint', s * 0.6, y + 1.5, dz, s * Math.min(B / 2 - 0.4, d.derricks.len * 0.35), y + 1.5 + d.derricks.len * 0.92, dz, 0.35, 0.35, COL.yellow); }
  if (d.powerBlock && lod < 2) { const p = d.powerBlock, y = yAt(p.z); P.beam('paint', B * 0.25, y, p.z - 3, 0, y + p.h, p.z, 0.4, 0.4, COL.yellow); P.cyl('paint', 0.7, 0.6, 0, y + p.h, p.z, COL.dark, 0.7, 10, 0, 0, Math.PI / 2); }
  if (d.netBin && lod < 2) { const n = d.netBin; P.box('paint', B * 0.6, 0.6, n.z1 - n.z0, 0, dy + 0.3, (n.z0 + n.z1) / 2, 0x3a3f3a); }
  if (d.haulingPort && lod < 2) P.box('paint', 0.3, 1.4, 1.6, hbDeck(ctx, d.haulingPort.z) - 0.1, dy - 0.4, d.haulingPort.z, COL.dark);
  if (d.potHauler && lod < 2) { const z = d.potHauler.z, y = yAt(z); P.rod('metal', B * 0.35, y, z, B * 0.42, y + 1.8, z, 0.06, COL.yellow, 5); for (let i = 0; i < 6; i++) P.box('paint', 0.9, 0.5, 0.6, -B * 0.2 + (i % 2) * 0.95, y + 0.25 + Math.floor(i / 2) * 0.5, z + 2.5, 0x2f3b45); }
  if (d.bowFender && lod < 2) { const z = -L / 2 + 0.6; P.box('paint', d.bowFender.w, 1.2, 1.2, 0, dy - 0.2, z, COL.rubber); }
  if (d.dragArm && lod < 2) { const a = d.dragArm, x = B / 2 - 0.7, y = yAt(a.z0); P.rod('metal', x, y + 0.8, a.z0, x, y + 0.8, a.z1, 0.6, 0x4c5157, 8); P.box('paint', 2.5, 5, 2.5, B / 2 - 1.5, y + 2.5, a.z0, COL.yellow); P.box('paint', 2.5, 5, 2.5, B / 2 - 1.5, y + 2.5, a.z1, COL.yellow); }
  if (d.sternRamp && lod < 2) { const r = d.sternRamp; if (r.side === 'quarter') { const x = B / 2 - r.w * 0.45, hh = Math.min(r.len, ga.deckY * 0.8); P.box('paint', r.w, hh, 0.6, x, hh / 2 + 0.6, L / 2 - 1.2, 0x5d6268, -0.6); } else P.box('paint', r.w, ga.deckY * 0.8, 0.6, 0, ga.deckY * 0.45, L / 2 - 0.31, 0x5d6268); }
  if (d.sideRamp && lod < 2) P.box('paint', 0.4, 6, 12, B / 2 - 0.05, ga.deckY * 0.45, d.sideRamp.z, 0x5d6268);
  if (lod === 0) workGear(ctx, yAt);
  if (d.heli) { const h = d.heli; P.cyl('paint', h.r, 0.4, 0, h.y + 0.2, h.z, COL.helideck, h.r, ctx.phone ? 12 : 24); if (lod < 2) { P.cyl('paint', h.r * 0.75, 0.05, 0, h.y + 0.42, h.z, 0xf2f2ee, h.r * 0.75, ctx.phone ? 12 : 24, 0, 0, 0, true); P.box('paint', h.r * 0.12, 0.05, h.r * 0.5, -h.r * 0.15, h.y + 0.43, h.z, 0xf2f2ee); P.box('paint', h.r * 0.12, 0.05, h.r * 0.5, h.r * 0.15, h.y + 0.43, h.z, 0xf2f2ee); P.box('paint', h.r * 0.3, 0.05, h.r * 0.1, 0, h.y + 0.43, h.z, 0xf2f2ee); } if (h.hangar) P.facade('house', ga.B * 0.5, h.y - dy + 0.2, 12, 0, (h.y + dy) / 2, h.hangar.z0 + 6, BANDS.blank, BANDS.blank); }
}
/** deck height under a boat: the tier it is stowed on (cruise / ferry boat decks), else the weather deck */
function deckUnder(ctx, z, b) {
  const h = ctx.ga.house, t = b.deck && h ? h.tiers.find((x) => x.id === b.deck) : null;
  return t ? t.y : Math.min(b.y, ctx.hf.deckAt(z) + (ctx.ga.hull.poop && z > ctx.L / 2 - ctx.ga.hull.poop.len ? ctx.ga.hull.poop.h : 0));
}
/**
 * A lattice crane jib from a to b: four chords tapering towards the head and zig-zag bracing on the sides and the top
 * (instanced bars) - light shows through it, which is what makes a crane read as a crane and not a plank.
 */
function latticeJib(ctx, ax, ay, az, bx, by, bz, w, h, col) {
  const { P } = ctx;
  const len = Math.hypot(bx - ax, by - ay, bz - az); if (len < 1) return;
  const d = [(bx - ax) / len, (by - ay) / len, (bz - az) / len];
  // the jib's frame: u across (horizontal), v = u x d (up, perpendicular to the jib)
  let ux = d[2], uz = -d[0]; const ul = Math.hypot(ux, uz) || 1; ux /= ul; uz /= ul;
  const v = [-(d[1] * uz), uz * d[0] - ux * d[2], ux * d[1]];
  if (v[1] < 0) { v[0] = -v[0]; v[1] = -v[1]; v[2] = -v[2]; }
  const pt = (t, su, sv) => { const k = 1 - 0.55 * t; return [ax + d[0] * len * t + (ux * su * w / 2 + v[0] * sv * h / 2) * k, ay + d[1] * len * t + v[1] * sv * h / 2 * k, az + d[2] * len * t + (uz * su * w / 2 + v[2] * sv * h / 2) * k]; };
  const bar = Math.max(0.1, Math.min(w, h) * 0.12), br = bar * 0.6;
  for (const [su, sv] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) P.ibeam('paint', ...pt(0, su, sv), ...pt(1, su, sv), bar, bar, col);
  const n = Math.max(3, Math.round(len / Math.max(1.6, h * 1.1)));
  for (let i = 0; i < n; i++) {
    const t0 = i / n, t1 = (i + 1) / n, f = i % 2 ? 1 : -1;
    for (const su of [-1, 1]) P.ibeam('paint', ...pt(t0, su, -f), ...pt(t1, su, f), br, br, col);   // side bracing
    P.ibeam('paint', ...pt(t0, -f, 1), ...pt(t1, f, 1), br, br, col);                                // top bracing
  }
}
/**
 * Working-boat detail at LOD0 (instanced where it repeats): tugs get tyre fenders along the sheer and across the stern,
 * flanged tow-winch drums with the hawser led to the bow, towing pins aft; trawlers trawl doors on the gantry legs and
 * the warps; beam trawlers the beams with their shoes at the derrick heads; pilot / crew boats a roof rail, a
 * searchlight and whips; motor yachts a tender on the aft deck and a bow rail.
 */
function workGear(ctx, yAt) {
  const { ga, P, hf, L, B } = ctx;
  const d = ga.deck, dy = ga.deckY, rub = COL.rubber, gen = ga.gen;
  if (gen === 'tug' && ga.hull.fender) {
    const step = ctx.phone ? 3.2 : 1.6, dia = clamp(0.7, 1.3, B * 0.09);
    for (let z = -L * 0.28; z < L * 0.36; z += step) {
      const hb = hbDeck(ctx, z), y = hf.deckAt(z) - dia * 0.75;
      if (hb < B * 0.3) continue;
      for (const s of [-1, 1]) P.ityre('paint', dia, s * (hf.halfBreadth(z, y) - dia * 0.08), y, z, rub);
    }
    const zs = L / 2 - 0.2, hs = hbDeck(ctx, zs - 0.5);
    for (let x = -hs * 0.7; x <= hs * 0.7 + 0.01; x += Math.max(0.9, hs * 0.35)) P.imat('tyre', 'paint', xf(x, dy - dia * 0.7, zs + dia * 0.15, 0, Math.PI / 2, 0, dia, dia, dia), rub);
  }
  if (d.towWinch) {
    const tw = d.towWinch, y = yAt(tw.z), zc = tw.z + (tw.fwd ? -1.4 : 1.4);
    for (const s of [-1, 1]) P.icyl('paint', 1.35, 0.12, s * tw.w * 0.42, y + 1.4, zc, 0x2b2e31, 0, 0, Math.PI / 2);   // drum flanges
    // the hawser: from the drum over the bow fairlead (forward winch) or over the stern (aft winch)
    const zEnd = tw.fwd ? hf.zFwd(dy) + 1.2 : L / 2 - 0.6, yEnd = (tw.fwd ? yAt(zEnd) : dy) + 0.9;
    P.ibeam('metal', 0, y + 2.3, zc, 0, yEnd, zEnd, 0.09, 0.09, 0x3a3d40);
    if (!tw.fwd || gen === 'offshore') for (const s of [-1, 1]) P.icyl('paint', 0.22, 1.1, s * 0.9, dy + 0.55, L / 2 - 2.2, COL.yellow);   // towing pins
  }
  if (d.aframe && d.aframe.kind === 'gantry') {
    const a = d.aframe, y = yAt(a.z);
    for (const s of [-1, 1]) {
      P.ibox('paint', 0.25, 1.7, 2.6, s * (a.w / 2 + 0.2), y + a.h * 0.55, a.z + 0.3, 0xc8512a, 0, 0, s * 0.12);   // trawl doors
      P.ibeam('metal', s * a.w / 2.4, y + a.h, a.z, s * a.w / 3, dy - 0.6, L / 2 - 0.3, 0.05, 0.05, 0x3a3d40);       // warps over the ramp
    }
  }
  if (d.derricks) {
    const dz = d.derricks.z, y = yAt(dz), len = d.derricks.len;
    for (const s of [-1, 1]) {
      const tx = s * Math.min(B / 2 - 0.4, len * 0.35), ty = y + 1.5 + len * 0.92, bl = Math.min(12, L * 0.3);
      P.ibeam('paint', tx, ty - 1.2, dz - bl / 2, tx, ty - 1.2, dz + bl / 2, 0.35, 0.35, 0x6a6f74);                // the beam
      for (const e of [-1, 1]) P.ibox('paint', 0.3, 1.4, 1.0, tx, ty - 1.6, dz + e * bl / 2, 0x2b2e31);               // trawl heads (shoes)
      P.ifin('paint', bl * 0.9, 2.2, tx + s * 0.2, ty - 2.9, dz, 0x30443a, Math.PI / 2);                            // the net hanging from it
    }
  }
  if (gen === 'small_fast' && ga.house && ga.house.tiers.length && !ga.hull.tube) {
    const t = ga.house.tiers[ga.house.tiers.length - 1], b = ga.bridge, top = b && !b.console ? b.y + b.h + 0.3 : t.y + t.h;
    const z0 = b && !b.console ? b.z0 : ga.house.z0, z1 = b && !b.console ? b.z1 : ga.house.z1, hw = Math.min((b?.w ?? ga.house.w) / 2, B / 2 - 0.4) - 0.15;
    if (hw > 0.5) railRun(ctx, [[-hw, z0 + 0.2], [hw, z0 + 0.2], [hw, z1 - 0.2], [-hw, z1 - 0.2], [-hw, z0 + 0.2]], () => top, 0.35, COL.light, true);
    P.icyl('paint', 0.18, 0.3, 0, top + 0.15, z0 + 0.6, COL.dark);
    for (const s of [-1, 1]) P.icyl('metal', 0.025, 2.4, s * hw * 0.7, top + 1.2, z1 - 0.3, COL.light);
  }
  if (gen === 'motor_yacht' && L >= 14 && !d.boats.some((b) => b.kind === 'tender')) {
    const tl = clamp(3, 6.5, L * 0.13), zMax = L / 2 - platformLen(ga) - tl * 0.55, zt = Math.max((ga.house?.z1 ?? 0) + tl * 0.6, zMax - tl);
    if (zt <= zMax) P.iboat('paint', tl, tl * 0.2, 0, yAt(zt) + tl * 0.17, zt, 0xf2f2ee);
  }
}
/** mooring bollards (double bitts on a base plate, instanced) on both sides of a mooring station */
function bollards(ctx, z, y, n = 2) {
  const { ga, P } = ctx;
  const r = clamp(0.12, 0.42, ga.B * 0.009), col = ctx.primer ? COL.primer : 0x2b2e31;
  for (const s of [-1, 1]) {
    for (let k = 0; k < n; k++) {
      const zz = z + (k - (n - 1) / 2) * r * 9, hb = hbOuter(ctx, zz);
      if (hb < r * 7) continue;
      const x = s * (hb - r * 4.5);
      P.ibox('paint', r * 2.2, r * 0.5, r * 6, x, y + r * 0.25, zz, col);
      for (const dz of [-r * 1.6, r * 1.6]) P.icyl('paint', r, r * 2.6, x, y + r * 1.3, zz + dz, col);
    }
  }
}
function boat(ctx, b) {
  const { P, ga, lod } = ctx;
  if (lod === 2) return;
  const orange = ctx.primer ? COL.primer : COL.orange;
  if (b.kind === 'freefall') {
    // free-fall lifeboat on its launching ramp at the stern, bow down at ~35° (SOLAS III/31)
    const len = clamp(5.5, 10, ga.L * 0.04), r = len * 0.17, a = 0.6;
    const y = b.y + len * 0.3, z = Math.min(b.z + len * 0.35, ga.L / 2 - 0.4 - len * 0.6);
    for (const s of [-1, 1]) P.beam('paint', s * r * 1.3, y - r - 0.3, z - Math.cos(a) * len * 0.6, s * r * 1.3, y - r - 0.3 - Math.sin(a) * len * 0.5 + Math.sin(a) * len, z + Math.cos(a) * len * 0.6, 0.25, 0.4, COL.light);
    P.capsule('paint', r, len - 2 * r, 0, y, z, orange, Math.PI / 2 - a);
    P.box('paint', r * 1.3, r * 0.6, len * 0.35, 0, y + r * 0.9, z - len * 0.05, orange, 0, -a);
  } else if (b.kind === 'davit' || b.kind === 'tender' || b.kind === 'rescue') {
    const len = b.kind === 'rescue' ? 5 : b.big ? clamp(9, 16, ga.L * 0.045) : b.kind === 'tender' ? clamp(4, 10, ga.L * 0.08) : clamp(6, 9, ga.L * 0.05);
    const r = Math.min(b.big ? 1.8 : 9, len * (b.kind === 'rescue' ? 0.2 : 0.19)), col = b.kind === 'tender' ? (ga.gen === 'motor_yacht' ? 0xf2f2ee : 0xf2f2ee) : orange;
    if (b.garage) return;   // yacht tender garage: closed hatch only
    const out = (ga.gen === 'cruise' || (ga.gen === 'ferry' && !ctx.hf.twin && b.deck)) && b.kind !== 'rescue' && b.x;   // cruise lifeboats and tenders hang in their davits at the hull's side, in the recess of the boat deck's house (buildHouse)
    const z = clamp(-ga.L / 2 + len, ga.L / 2 - len / 2 - 0.3, b.z);
    const sx = Math.sign(b.x || 0);
    const x = sx * (out ? Math.min(ga.B / 2, hbDeck(ctx, z)) - r - 0.1 : Math.min(Math.abs(b.x), ga.B / 2 - r * 1.1 - 0.15));
    // enclosed lifeboat (instanced): rounded hull + canopy; open rescue boats are a low capsule with a console
    if (b.kind === 'rescue') { P.capsule('paint', r, len - 2 * r, x, b.y + r, z, col, Math.PI / 2); P.box('paint', 0.6, 0.7, 0.6, x, b.y + r * 1.6, z + len * 0.1, COL.white); }
    else if (lod === 0) P.iboat('paint', len, r, x, b.y, z, col);
    else P.ibox('paint', r * 2, r * 1.9, len, x, b.y + r * 0.3, z, col);
    if (b.kind === 'tender' || !x) return;
    // davits: a post on the deck inboard of the boat and an arm reaching out over it (gravity davits, both ends), falls
    // down to the boat's hooks; the cruise boats hang in the recess under the overhanging balcony decks
    const yDeck = deckUnder(ctx, z, b), white = ctx.primer ? COL.primer : 0xe9ebea;
    const top = b.y + r * 2.6, xi = x - sx * (r + 0.7), post = Math.max(0.25, r * 0.16);
    for (const dz of [-len * 0.32, len * 0.32]) {
      P.ibox('paint', post, top - yDeck, post * 1.4, xi, (top + yDeck) / 2, z + dz, white);
      P.ibeam('paint', xi, top, z + dz, x + sx * 0.2, top + 0.15, z + dz, post * 0.9, post * 1.2, white);
      if (lod === 0) P.ibeam('metal', x, top, z + dz, x, b.y + r * 1.1, z + dz, 0.05, 0.05, COL.dark);
    }
  } else if (b.kind === 'raft') {
    const x = Math.sign(b.x || 0) * Math.min(Math.abs(b.x), ga.B / 2 - 0.75);
    for (let i = 0; i < 2; i++) P.capsule('paint', 0.3, 0.6, x, b.y + 0.35, b.z + i * 0.9, 0xf2f2ee, 0, 0, Math.PI / 2);
  }
}

// ------------------------------------------------------------------------------------------------ handrails (LOD0, desktop)
/**
 * A guard rail along a polyline of [x, z] points at deck height yFn(z) (instanced): a flat-bar top rail, one or two
 * knee rails and flat-bar stanchions every ~1.5 m (3 m on phones). Real rails are thin; what reads from afar is the
 * rhythm of the stanchions and the top rail catching the light, so the bars are slightly oversized (top 0.08 m).
 */
function railRun(ctx, pts, yFn, h = 1.1, col = null, closed = false) {
  const { P } = ctx;
  const c = col ?? (ctx.primer ? COL.primer : 0xdfe3e3);
  const step = ctx.phone ? 3.0 : 1.5, knees = ctx.phone || h < 0.8 ? 1 : 2;
  for (let i = 0; i < pts.length - 1; i++) {
    const [xa, za] = pts[i], [xb, zb] = pts[i + 1], ya = yFn(za), yb = yFn(zb);
    const len = Math.hypot(xb - xa, zb - za); if (len < 0.2) continue;
    P.ibeam('metal', xa, ya + h, za, xb, yb + h, zb, 0.08, 0.05, c);
    for (let k = 1; k <= knees; k++) { const f = k / (knees + 1); P.ibeam('metal', xa, ya + h * f, za, xb, yb + h * f, zb, 0.035, 0.035, c); }
    const n = Math.max(1, Math.round(len / step));
    for (let k = i === 0 && !closed ? 0 : 1; k <= n; k++) { const t = k / n; P.ifin('metal', 0.06, h, xa + (xb - xa) * t, ya + (yb - ya) * t + h / 2, za + (zb - za) * t, c, Math.atan2(xb - xa, zb - za) + Math.PI / 2); }
  }
}
/** the [x, z] polyline of one side (s = ±1) of an outline hw(z) between z0 and z1 (straight runs collapse to their ends) */
function sideLine(z0, z1, hwFn, s, n = 10, minHw = 0.4) {
  const pts = [];
  for (let i = 0; i <= n; i++) { const z = z0 + (z1 - z0) * i / n, hw = hwFn(z); if (hw > minHw) pts.push([s * hw, z]); }
  if (pts.length > 2 && pts.every(([x]) => Math.abs(x - pts[0][0]) < 0.02)) return [pts[0], pts[pts.length - 1]];
  return pts;
}
function buildRails(ctx) {
  const { ga, hf, L } = ctx;
  const rail = (pts, yFn, h = 1.1) => railRun(ctx, pts, yFn, h);
  // main deck edge where there is no bulwark
  if (!ga.hull.bulwark && ga.L >= 12 && !ga.hull.tube) {
    const z0 = ga.hull.fcsle ? -L / 2 + ga.hull.fcsle.len : -L / 2 + L * 0.05, z1 = L / 2 - 0.5;
    const n = Math.max(6, Math.round((z1 - z0) / 10));
    for (const d of hf.demi) for (const s of [-1, 1]) if (!hf.twin || s === Math.sign(d.cx)) rail(outline(ctx, z0, z1, n, 0.25).map(([x, z]) => [d.cx + s * x, z]), (z) => hf.deckAt(z));
  }
  // forecastle edge
  if (ga.hull.fcsle) { const f = ga.hull.fcsle, n = 8; const pts = outline(ctx, -L / 2 + 0.3, -L / 2 + f.len, n, 0.3); for (const s of [-1, 1]) rail(pts.map(([x, z]) => [s * x, z]), (z) => hf.deckAt(z) + f.h); }
  // exposed tops of the house tiers: wherever the deck above stands back (or there is none), a rail along that edge
  const T = ctx.tierBoxes || [];
  if (ga.gen !== 'cruise') for (const t of T) {
    const top = t.y + t.h, hwAt = (z) => Math.min(t.w / 2, hbOuter(ctx, clamp(-L / 2, L / 2, z)) - 0.45);
    const above = T.filter((u) => Math.abs(u.y - top) < 0.3 && u.z1 > t.z0 && u.z0 < t.z1);
    const br = ga.bridge && Math.abs(ga.bridge.y - top) < 0.3 ? ga.bridge : null;
    const cover = (z) => above.some((u) => z >= u.z0 - 0.3 && z <= u.z1 + 0.3 && u.w >= t.w - 1.5) || (br && z >= br.z0 - 0.3 && z <= br.z1 + 0.3 && (br.w ?? t.w) >= t.w - 1.5);
    // sample the edge, keep the runs that are not covered by the deck above
    const n = Math.max(4, Math.round((t.z1 - t.z0) / 3)), zs = [];
    for (let i = 0; i <= n; i++) zs.push(t.z0 + 0.3 + (t.z1 - t.z0 - 0.6) * i / n);
    for (const s of [-1, 1]) {
      let run = [];
      const flush = () => { if (run.length > 1) rail(run, () => top, 1.0); run = []; };
      for (const z of zs) { const hw = hwAt(z); if (hw > 0.6 && !cover(z)) run.push([s * hw, z]); else flush(); }
      flush();
    }
    // the after end of a tier whose deck above stops short of it (merchant house tops, stepped ferry / yacht decks)
    const zEnd = t.z1 - 0.3, hwE = hwAt(zEnd);
    if (hwE > 0.8 && !cover(zEnd) && t.use !== 'lido') rail([[-hwE, zEnd], [hwE, zEnd]], () => top, 1.0);
  }
  // compass deck
  const b = ga.bridge;
  if (b && !b.embedded && b.h > 2 && ga.L > 20) { const w = (b.w ?? ga.house.w) / 2; rail([[-w, b.z0], [w, b.z0], [w, b.z1], [-w, b.z1], [-w, b.z0]], () => b.y + b.h + 0.3, 1.0); }
}

// ------------------------------------------------------------------------------------------------ decals
function buildDecals(ctx, tex, name, markOnly = false) {
  const { ga, hf } = ctx;
  const mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, alphaTest: 0.25, roughness: 0.55, metalness: 0, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, depthWrite: false });
  mat.name = 'decal';
  const geos = [];
  const addPlane = (w, h, x, y, z, ry, u0, v0, u1, v1) => {
    const g = new THREE.PlaneGeometry(w, h);
    const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + (u1 - u0) * uv.getX(i), v0 + (v1 - v0) * uv.getY(i));
    g.applyMatrix4(xf(x, y, z, 0, ry, 0)); geos.push(g);
  };
  if (name) {
    const lh = clamp(0.35, 3.2, ga.deckY * 0.16 + ga.L * 0.004), lw = lh * 4.2;
    const z = -ga.L / 2 + ga.L * 0.07 + lw / 2, y = Math.max(lh * 0.8, ga.deckY * 0.62);
    const hb = hf.halfBreadth(z, y);
    if (hb > 0.2) { addPlane(lw, lh * 1.5, hb + 0.06, y, z, Math.PI / 2, 0, 0.5, 1, 1); addPlane(lw, lh * 1.5, -hb - 0.06, y, z, -Math.PI / 2, 0, 0.5, 1, 1); }
    const zs = hf.zAft(y * 0.8) + 0.06, yt = Math.max(lh, ga.deckY * 0.5);
    if (hf.halfBreadth(hf.zAft(yt) - 0.2, yt) > lw * 0.3) addPlane(lw * 0.9, lh * 1.35, hf.demi[0].cx === 0 ? 0 : 0, yt, zs, 0, 0, 0.5, 1, 1);
  }
  const f = ga.funnel;
  if (ga.livery.mark && f && f.kind !== 'none' && f.kind !== 'side' && f.kind !== 'mast' && f.h > 2) {
    const s = clamp(0.8, 9, f.r * 1.6), y = f.y + f.h * 0.62, xs = f.kind === 'twin' && ga.gen !== 'lng' ? [-f.r * 1.15, f.r * 1.15] : [0];
    const r = f.kind === 'twin' && xs.length === 2 ? f.r * 0.85 : f.r;
    for (const x of xs) for (const sd of [-1, 1]) addPlane(s, s, x + sd * (r * (1 - 0.08 * 0.62) + 0.08), y, f.z + f.h * 0.62 * 0.12, sd * Math.PI / 2, 0, 0, markOnly ? 1 : 0.5, markOnly ? 1 : 0.5);
  }
  if (!geos.length) return null;
  const mesh = new THREE.Mesh(merge(geos, false), mat); mesh.name = 'decals'; mesh.userData.matKey = 'decal'; mesh.renderOrder = 2;
  return mesh;
}

// ------------------------------------------------------------------------------------------------ lights, crew, helpers
/** COLREGS light positions in the ship.js `ctx.lights` shape. */
export function navLightSpots(ga) {
  const b = ga.bridge, f = ga.funnel;
  const x = b ? Math.max(0.6, Math.min(ga.B / 2 - 0.2, (b.wings !== 'none' ? b.wingTo : (b.w ?? 2) / 2) - 0.1)) : ga.B / 2 - 0.2;
  const y = b ? b.y + b.h * 0.9 : ga.deckY + 1.5, z = b ? b.z0 + 1.2 : -ga.L * 0.1;
  const topY = b ? b.y + b.h + 0.3 + (ga.L > 30 ? Math.min(9, ga.L * 0.035 + 2) : 1.6) + 0.4 : ga.deckY + 4;
  const fore = ga.deck.masts.find((m) => m.z < (b ? b.z0 : 0) - 5 && !m.arch);
  return { x, y, z, mastY: topY, mastZ: b ? (b.z0 + b.z1) / 2 : 0, fore: fore ? { y: (fore.y ?? ga.deckY) + fore.h, z: fore.z } : null, stern: { y: ga.deckY + (ga.hull.poop?.h || 0) + 1.6, z: ga.L / 2 - 0.6 }, funnelTop: f && f.kind !== 'none' ? f.y + f.h : null };
}
function crewSpots(ga) {
  const out = [];
  const b = ga.bridge;
  if (b && b.wings !== 'none' && b.wingTo > 1) out.push([b.wingTo - 0.8, b.y, b.z0 + 1.2]);
  if (ga.hull.fcsle) out.push([ga.B * 0.15, ga.deckY + ga.hull.fcsle.h, -ga.L / 2 + ga.hull.fcsle.len * 0.5]);
  out.push([ga.B * 0.3, ga.deckY, ga.L / 2 - Math.max(1.5, ga.L * 0.04)]);
  return out;
}

/** Bounding box of a built group (ignores sprites / labels). */
export function shipBounds(obj) {
  const box = new THREE.Box3(), tmp = new THREE.Box3();
  obj.updateMatrixWorld(true);
  obj.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    if (o.isInstancedMesh) { if (!o.boundingBox) o.computeBoundingBox(); tmp.copy(o.boundingBox); }
    else { if (!o.geometry.boundingBox) o.geometry.computeBoundingBox(); tmp.copy(o.geometry.boundingBox); }
    tmp.applyMatrix4(o.matrixWorld); box.union(tmp);
  });
  return box;
}
/** Deterministic hash of every vertex position in a group (tests: same inputs → same geometry). */
export function geometryHash(obj) {
  let h = 2166136261 >>> 0;
  obj.traverse((o) => {
    if (!o.isMesh) return;
    const a = o.geometry.attributes.position.array;
    for (let i = 0; i < a.length; i += 7) { h ^= Math.round(a[i] * 100) | 0; h = Math.imul(h, 16777619) >>> 0; }
    h ^= a.length; h = Math.imul(h, 16777619) >>> 0;
  });
  return h >>> 0;
}
/** Free GPU resources of a built ship (shared atlas textures are kept). */
export function disposeShip(obj) {
  const seen = new Set();
  obj.traverse((o) => {
    if (!o.isMesh) return;
    if (o.isInstancedMesh) o.dispose();   // per-instance buffers (fittings)
    o.geometry?.dispose();
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) { if (!m || seen.has(m)) continue; seen.add(m); if (m.map && !m.map.userData.shared) m.map.dispose(); m.dispose(); }
  });
}
export { BANDS, COL as SHIP_COLORS };
/** the §6.1 generators implemented here ('sail' stays with SAILING's rigmesh.js / yachtlooks.js) */
export const SHIPGEN_GENS = ['aft_house_dry', 'aft_house_tanker', 'lng', 'container', 'roro_pctc', 'ferry', 'cruise', 'offshore', 'tug', 'fishing', 'small_fast', 'motor_yacht', 'special'];
