// Parametric exterior generators (docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §6, Lane B): one GA record (§6.2) →
// a three.js ship at real scale (1 unit = 1 m) with three levels of detail and the §6.6 budgets.
//
//   buildFromGA(ga, opts) → { group, lods, info }
//     ga    the general arrangement (Lane C's shared/ships/ga.js, or the local stand-in public/js/gastub.js)
//     opts  { phone, lod: 'all'|0|1|2, cargo (draw cargo: containers, trailers), seed, name, decals, stage,
//             makeMat(kind, color, params) (ship.js passes its wear materials), rails }
//
// Frame as ship.js: forward = −z, starboard = +x, y = 0 at the design waterline. Static parts are merged per material
// (one mesh per material, vertex colours for the painted bits), so a ship is 8–14 draw calls at LOD0 whatever its size.
// The hull is lofted (shipgeom.js) from L/B/T/depth/Cb; houses use a procedural facade texture (window rows, balconies,
// bridge glass), container stacks one textured box per stack. Sail classes are not built here (SAILING's rigmesh.js).
// Build stages for the yard preview (§4.7): stage < 0.25 keel blocks, < 0.65 hull only (clip plane set by the
// preview, userData.clipY), < 0.9 everything in primer, ≥ 0.9 full livery.
import * as THREE from 'three';
import { MODELS } from '../../shared/ships/index.js';
import { loftHull, hullForm, bayStacks, lodDistances } from './shipgeom.js';
import { hashStr, rng } from './models.js';

const HAS_DOM = typeof document !== 'undefined' && typeof document.createElement === 'function';
const clamp = (lo, hi, v) => Math.max(lo, Math.min(hi, v));
const COL = {
  white: 0xf0f1ee, offwhite: 0xdfe2e0, dark: 0x22262b, steel: 0x8a9199, light: 0xc9cdd0, orange: 0xf26b1d, yellow: 0xf2b134, red: 0xb83224,
  grey: 0x9ea3a8, rubber: 0x17191c, blue: 0x2a6fb0, green: 0x2e6b4f, teak: 0xb08a5a, pool: 0x3fb7d9, helideck: 0x3f5a46, primer: 0x9aa0a6,
  redOxide: 0x7a3b2e, bronze: 0xb08d57, deckGreen: 0x4d6b55, deckRed: 0x7b3a33, hatchRed: 0x8c3b2f, hatchGrey: 0x6f757c, catwalk: 0xd8c23a,
};
const CONTAINER_PALETTE = [0xb5372b, 0x2e6fa8, 0x2f8a55, 0xd99a2b, 0x7d4f9e, 0x8a8f94, 0xc8622a, 0x23867a, 0xe0e0dc, 0x1f3a5f, 0x9c2f45, 0x5a6b2f];

// ------------------------------------------------------------------------------------------------ shared textures (browser)
let FACADE = null, CONTAINERS = null;
const BANDS = { cabins: 0, balcony: 1, glass: 2, blank: 3 };
const BAND_TILE = [6, 8.4, 6, 10];
/** 4-band facade atlas: merchant cabins, cruise balconies, big windows / bridge glass, blank wall */
function facadeTexture() {
  if (!HAS_DOM) return null;
  if (FACADE) return FACADE;
  const W = 512, H = 512, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const band = (k) => H - (k + 1) * (H / 4);           // canvas top of band k (flipY: band 0 at the bottom)
  const bh = H / 4;
  // band 0: wall with three square windows
  let y0 = band(0); g.fillStyle = '#f4f5f2'; g.fillRect(0, y0, W, bh);
  g.fillStyle = '#d9dcda'; g.fillRect(0, y0 + bh - 6, W, 6);
  for (let i = 0; i < 2; i++) { const x = 64 + i * (W / 2); g.fillStyle = '#b8bec2'; g.fillRect(x - 4, y0 + 36, 84, 50); g.fillStyle = '#1e3449'; g.fillRect(x, y0 + 40, 76, 42); g.fillStyle = 'rgba(160,200,230,0.35)'; g.fillRect(x + 4, y0 + 42, 28, 12); }
  // band 1: balconies (glass doors, dividers, rail)
  y0 = band(1); g.fillStyle = '#f2f3f0'; g.fillRect(0, y0, W, bh);
  g.fillStyle = '#26394c'; g.fillRect(0, y0 + 18, W, bh - 30);
  for (let i = 0; i < 3; i++) { const x = i * (W / 3); g.fillStyle = '#e9ebe8'; g.fillRect(x, y0 + 12, 10, bh - 18); g.fillStyle = 'rgba(150,190,220,0.25)'; g.fillRect(x + 20, y0 + 24, 60, 30); }
  g.fillStyle = '#cfd5d8'; g.fillRect(0, y0 + bh * 0.62, W, 5); g.fillStyle = 'rgba(220,230,235,0.5)'; g.fillRect(0, y0 + bh * 0.62, W, bh * 0.3);
  // band 2: continuous glass band with mullions
  y0 = band(2); g.fillStyle = '#f2f3f0'; g.fillRect(0, y0, W, bh);
  g.fillStyle = '#1b2f42'; g.fillRect(0, y0 + 24, W, bh - 52);
  g.fillStyle = '#b7c0c6'; for (let x = 0; x < W; x += 64) g.fillRect(x, y0 + 24, 5, bh - 52);
  g.fillStyle = 'rgba(170,210,240,0.22)'; g.fillRect(0, y0 + 28, W, 18);
  // band 3: blank wall with faint seams
  y0 = band(3); g.fillStyle = '#f3f4f1'; g.fillRect(0, y0, W, bh);
  g.fillStyle = 'rgba(0,0,0,0.06)'; for (let x = 0; x < W; x += 128) g.fillRect(x, y0, 2, bh);
  FACADE = new THREE.CanvasTexture(c);
  FACADE.wrapS = THREE.RepeatWrapping; FACADE.wrapT = THREE.ClampToEdgeWrapping; FACADE.colorSpace = THREE.SRGBColorSpace; FACADE.anisotropy = 4;
  FACADE.userData.shared = true;
  return FACADE;
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

// ------------------------------------------------------------------------------------------------ geometry collector
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);
function xf(x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) { _p.set(x, y, z); _e.set(rx, ry, rz, 'YXZ'); _q.setFromEuler(_e); _s.set(sx, sy, sz); return _m.compose(_p, _q, _s); }
const _c = new THREE.Color();
/** Collects geometry per material key, with per-part vertex colours; build() emits one Mesh per key. */
class Parts {
  constructor(seg = 14) { this.buckets = new Map(); this.seg = seg; this.tris = 0; }
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
  const mats = {
    hull: mk('hull', P ? P.hull : lv.hull, { roughness: 0.5, metalness: 0.25 }),
    boot: mk('boot', P ? P.boot : lv.boot, { roughness: 0.6, metalness: 0.15 }),
    band: mk('band', P ? P.band : lv.band ?? lv.hull, { roughness: 0.5, metalness: 0.2 }),
    hullX: null,
    deck: mk('deck', P ? P.deck : DECK[ga.gen] ?? 0x666b70, { roughness: 0.85, metalness: 0.1 }),
    house: mk('house', P ? P.house : lv.house, { roughness: 0.62, metalness: 0.1, map: primer ? null : facadeTexture() }),
    glass: mk('glass', 0x1b3148, { roughness: 0.18, metalness: 0.65, emissive: 0xffd890, emissiveIntensity: 0 }),
    paint: mk('paint', primer ? COL.primer : 0xffffff, { roughness: 0.65, metalness: 0.15, vertexColors: !primer }),
    metal: mk('metal', primer ? COL.primer : 0xffffff, { roughness: 0.4, metalness: 0.6, vertexColors: !primer }),
    funnel: mk('funnel', P ? P.funnel : lv.funnel, { roughness: 0.55, metalness: 0.2 }),
    cargo: mk('cargo', 0xffffff, { roughness: 0.75, metalness: 0.15, vertexColors: true, map: containerTexture() }),
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
    const P = new Parts(phone ? (lod === 0 ? 8 : 6) : lod === 0 ? 14 : lod === 1 ? 8 : 6);
    const ctx = { ga, m, hf, P, lod, phone, rnd: rng(seed), L: ga.L, B: ga.B, T: ga.T, deckY: ga.deckY, lv: ga.livery, info, stage, opts,
      rails: lod === 0 && !phone && opts.rails !== false, cargo: opts.cargo !== false && stage >= 1, primer };
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
    if (lod === 0 && !primer && opts.decals !== false && HAS_DOM && (opts.name || ga.livery.mark)) {
      decalTex = decalTex || decalTexture(opts.name || '', ga.livery);
      if (decalTex) { const d = buildDecals(ctx, decalTex, opts.name); if (d) { g.add(d); meshes.push(d); } }
    }
    let tris = 0, calls = 0, cargoTris = 0;
    g.traverse((o) => {
      if (!o.isMesh) return;
      const n = (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
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
  const loft = loftHull(ga, { lod, stations: phone && lod === 0 ? 30 : undefined, band: bandY });
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
  if (H.tube) ribTube(ctx);
  if ((ga.gen === 'cruise' || (ga.gen === 'ferry' && ga.model !== 'ferry50' && !hf.twin)) && lod < 2 && ctx.stage >= 0.65) hullWindows(ctx);
  if (ga.deck.swimPlatform && lod < 2) { const pl = platformLen(ga); P.box('deck', B * 0.78, 0.25, pl, 0, 0.35, L / 2 - pl / 2, null); }
  return mesh;
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
  for (let i = 0; i < n; i++) {
    const t = h.tiers[i];
    let z0 = t.z0 ?? h.z0, z1 = t.z1 ?? h.z1, w = t.w ?? h.w;
    if (cruise) {
      // the top decks step back a little forward; the aft end is terraced (classic cruise-ship stern)
      if (i >= n - 2) z0 += (i - (n - 3)) * 3.0;
      if (i > n * 0.5) z1 -= (i - n * 0.5) * Math.max(2.5, ga.L * 0.012);
    } else if (ferry && n > 2) {
      if (i >= n - 2) z1 -= (i - (n - 3)) * ga.L * 0.05;
    }
    if (lod === 2) continue;
    const band = BANDS[USE_BAND[t.use] || 'cabins'];
    const endBand = cruise || yacht || ferry ? BANDS.glass : band;
    const nose = yacht ? Math.min((z1 - z0) * 0.35, w * 1.1) : 0;
    tierSolid(ctx, z0, z1, w, t.y, t.h, band, endBand, nose);
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
  if (ga.deck.pool && lod < 2) { const p = ga.deck.pool; P.box('paint', ga.B * 0.32, 0.4, p.z1 - p.z0, 0, p.y + 0.15, (p.z0 + p.z1) / 2, COL.pool); P.box('paint', ga.B * 0.5, 0.2, p.z1 - p.z0 + 8, 0, p.y + 0.02, (p.z0 + p.z1) / 2, COL.teak); }
  if (ga.deck.flybridge && lod < 2) { const f = ga.deck.flybridge; const w = ga.B * 0.6; P.box('paint', w, 1.0, (f.z1 - f.z0) * 0.6, 0, f.y + 0.5, f.z0 + (f.z1 - f.z0) * 0.35, COL.white); P.box('paint', w * 1.05, 0.12, (f.z1 - f.z0) * 0.8, 0, f.y + 2.4, f.z0 + (f.z1 - f.z0) * 0.45, COL.white); for (const s of [-1, 1]) P.rod('metal', s * w * 0.45, f.y + 1, f.z0 + (f.z1 - f.z0) * 0.8, s * w * 0.45, f.y + 2.4, f.z0 + (f.z1 - f.z0) * 0.8, 0.05, COL.light, 5); }
}
/**
 * One superstructure tier as a solid that follows the deck outline (so a forward house never hangs over the bow flare):
 * half-width(z) = min(w / 2, deck half-breadth − 0.35 m), tapered to a point over `nose` metres (yachts).
 * Faces map the facade atlas: sides → `band`, ends → `endBand`, top blank.
 */
function tierSolid(ctx, z0, z1, w, y, h, band, endBand, nose = 0, key = 'house', color = null) {
  const { P } = ctx;
  const hwAt = (z) => {
    let hw = Math.min(w / 2, hbDeck(ctx, clamp(-ctx.L / 2, ctx.L / 2, z)) - 0.35);
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
  const g = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments: 1 });
  g.rotateX(-Math.PI / 2); g.translate(0, y, 0);
  const p = g.attributes.position, uv = g.attributes.uv, nn = g.attributes.normal;
  for (let i = 0; i < p.count; i++) {
    const nx = nn.getX(i), ny = nn.getY(i), nz = nn.getZ(i);
    let b, u;
    if (Math.abs(ny) > 0.5) { b = 3; u = p.getX(i) / BAND_TILE[3]; }
    else if (Math.abs(nx) >= Math.abs(nz)) { b = band; u = p.getZ(i) / BAND_TILE[b]; }
    else { b = endBand; u = p.getX(i) / BAND_TILE[b]; }
    const vy = Math.abs(ny) > 0.5 ? 0.5 : (p.getY(i) - y) / h;
    uv.setXY(i, u, (b + 0.03 + 0.94 * vy) / 4);
  }
  P.put(key, g, color);
}
function buildBridge(ctx) {
  const { ga, P, lod } = ctx;
  const b = ga.bridge, h = ga.house; if (!b || lod === 2) return;
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
    P.rod('metal', 0, topY, mz, 0, topY + mh, mz, 0.12 + ga.L * 0.0008, COL.light, ctx.phone ? 5 : 7);
    P.beam('metal', -Math.min(3.5, w * 0.3), topY + mh * 0.7, mz, Math.min(3.5, w * 0.3), topY + mh * 0.7, mz, 0.18, 0.18, COL.light);
    P.box('paint', Math.min(3.2, 1 + ga.L * 0.01), 0.18, 0.35, 0, topY + mh * 0.45, mz - 0.6, COL.dark);
    P.box('paint', Math.min(2.4, 0.8 + ga.L * 0.008), 0.15, 0.3, 0, topY + mh + 0.2, mz, COL.dark);
    if (lod === 0) for (const s of [-1, 1]) { P.cyl('paint', 0.35, 0.5, s * w * 0.3, topY + 0.25, b.z1 - 1, COL.white, 0.35, 8); P.ellipsoid('paint', 0.45, 0.45, 0.45, s * w * 0.3, topY + 0.6, b.z1 - 1, COL.white, 8); }
  } else {
    P.rod('metal', 0, topY, mz, 0, topY + 1.6, mz, 0.06, COL.light, 5); P.box('paint', 0.9, 0.12, 0.25, 0, topY + 1.0, mz, COL.dark);
  }
}

// ------------------------------------------------------------------------------------------------ funnel
function supportY(ctx, z) {
  const h = ctx.ga.house; let y = ctx.hf.deckAt(z);
  if (h) for (const t of h.tiers) { const z0 = t.z0 ?? h.z0, z1 = t.z1 ?? h.z1; if (z >= z0 - 0.5 && z <= z1 + 0.5) y = Math.max(y, t.y + t.h); }
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
  const r = f.kind === 'twin' && xs.length === 2 ? f.r * 0.85 : f.r;
  for (const x of xs) {
    if (lod === 2) { P.box('funnel', r * 2, top - base, r * 3, x, (top + base) / 2, f.z); continue; }
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
    if (ga.livery.band != null && !ctx.primer && lod === 0) P.box('paint', a * 2.02, hh * 0.12, b * 2.02, x, base + hh * 0.66, f.z + hh * 0.08, ga.livery.band);
  }
  if (ga.gen === 'lng' || ga.gen === 'special') { /* twin uptakes inside one wide casing */ }
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
        const nPipes = lod === 0 ? 5 : 2;
        for (let k = 0; k < nPipes; k++) P.rod('metal', -B * 0.08 + k * 0.6, dy + 1.3, za, -B * 0.08 + k * 0.6, dy + 1.3, zb, 0.18 + ga.L * 0.0006, COL.light, 6);
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
    if (heavy) { for (const s of [-1, 1]) P.beam('paint', bx + s * 1.2, by, bz, tx + s * 0.4, ty, tz, 0.9, 1.2, col); }
    else if (knuckle) {   // knuckle boom folded: main boom up, outer boom folded back down
      const k1 = c.boom * 0.5, kx = bx, ky = by + Math.sin(1.0) * k1, kz = bz + dir * Math.cos(1.0) * k1;
      P.beam('paint', bx, by, bz, kx, ky, kz, 0.55, 0.65, col);
      P.beam('paint', kx, ky, kz, kx, by + 0.6, kz + dir * c.boom * 0.42, 0.45, 0.5, col);
      continue;
    } else P.beam('paint', bx, by, bz, tx, ty, tz, clamp(0.9, 1.6, c.swl / 25), clamp(1.1, 1.9, c.swl / 20), col);
    if (!knuckle && !heavy && lod === 0) { P.box('paint', 1.2, 0.4, 1.2, tx, yAt(tz) + ty - yAt(tz) - 0.4, tz, COL.dark); P.box('paint', 0.5, ty - yAt(tz) - 0.3, 0.5, tx, yAt(tz) + (ty - yAt(tz)) / 2 - 0.4, tz, col); }
    if (lod === 0) P.rod('metal', tx, ty, tz, tx, ty - Math.min(4, c.boom * 0.15), tz, 0.04, COL.dark, 4);
  }
  for (const h of d.hoseCranes || []) { const y = dy; P.cyl('paint', 0.45, 3, h.x, y + 1.5, h.z, COL.yellow, 0.4, 8); if (lod < 2) P.beam('paint', h.x, y + 3.2, h.z, h.x, y + 6, h.z + 9, 0.4, 0.5, COL.yellow); }
  if (d.manifold && lod < 2) { const z = d.manifold.z; P.box('paint', B * 0.9, 1.0, 2.2, 0, dy + 0.9, z, 0x8d9296); if (lod === 0) for (let k = -3; k <= 3; k++) for (const s of [-1, 1]) P.rod('metal', s * B * 0.3, dy + 1.2, z + k * 0.6, s * (B / 2 - 0.6), dy + 1.2, z + k * 0.6, 0.2, k % 2 ? 0xc0392b : COL.light, 6); }
  if (d.catwalk && lod < 2) { const c = d.catwalk; P.box('paint', 1.0, 0.15, c.z1 - c.z0, c.x, dy + c.h, (c.z0 + c.z1) / 2, COL.catwalk); if (lod === 0) for (let z = c.z0; z <= c.z1; z += 8) P.box('paint', 0.15, c.h, 0.15, c.x, dy + c.h / 2, z, COL.light); }
  if (d.compressor && lod < 2) { const c = d.compressor, y = c.onTrunk ? dy + 3.6 : dy; P.facade('house', c.w, 4.2, c.z1 - c.z0, 0, y + 2.1, (c.z0 + c.z1) / 2, BANDS.blank, BANDS.blank); }
  // mooring: windlasses forward, winches aft (drums), bollards
  if (lod < 2 && ga.L >= 30 && ga.gen !== 'motor_yacht') for (const mo of d.mooring) {
    const y = mo.y ?? yAt(mo.z), s = clamp(0.5, 2.2, B * 0.04);
    for (const sx of [-1, 1]) { P.box('paint', s * 1.4, s * 0.9, s * 1.4, sx * B * 0.18, y + s * 0.45, mo.z, mo.kind === 'windlass' ? COL.dark : 0x3d5266); if (lod === 0) P.cyl('paint', s * 0.45, s * 1.4, sx * B * 0.18 + sx * s, y + s * 0.6, mo.z, COL.red, s * 0.45, 10, 0, 0, Math.PI / 2); }
  }
  // foremast + yacht/other masts
  for (const mm of d.masts) {
    if (mm.arch) continue;
    if (mm.z > (ga.bridge?.z0 ?? 0) - 1 && mm.z < (ga.bridge?.z1 ?? 0) + 1 && mm.y >= (ga.bridge?.y ?? 0)) continue;  // bridge-top masts drawn with the bridge
    const y = mm.y ?? yAt(mm.z);
    P.rod('metal', 0, y, mm.z, 0, y + mm.h, mm.z, 0.12 + mm.h * 0.012, COL.light, ctx.phone ? 5 : 8);
    if (lod === 0) P.beam('metal', -1.2, y + mm.h * 0.75, mm.z, 1.2, y + mm.h * 0.75, mm.z, 0.12, 0.12, COL.light);
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
  if (d.heli) { const h = d.heli; P.cyl('paint', h.r, 0.4, 0, h.y + 0.2, h.z, COL.helideck, h.r, ctx.phone ? 12 : 24); if (lod < 2) { P.cyl('paint', h.r * 0.75, 0.05, 0, h.y + 0.42, h.z, 0xf2f2ee, h.r * 0.75, ctx.phone ? 12 : 24, 0, 0, 0, true); P.box('paint', h.r * 0.12, 0.05, h.r * 0.5, -h.r * 0.15, h.y + 0.43, h.z, 0xf2f2ee); P.box('paint', h.r * 0.12, 0.05, h.r * 0.5, h.r * 0.15, h.y + 0.43, h.z, 0xf2f2ee); P.box('paint', h.r * 0.3, 0.05, h.r * 0.1, 0, h.y + 0.43, h.z, 0xf2f2ee); } if (h.hangar) P.facade('house', ga.B * 0.5, h.y - dy + 0.2, 12, 0, (h.y + dy) / 2, h.hangar.z0 + 6, BANDS.blank, BANDS.blank); }
  if (ga.deck.bowDoor && lod === 0 && ga.gen === 'ferry' && ga.hull.bow !== 'wavepiercer') { const z = hf.zFwd(ga.deckY * 0.6); P.box('paint', ga.B * 0.18, 0.08, 0.1, 0, ga.deckY * 0.6, z + 0.6, COL.dark); }
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
    const x = Math.sign(b.x || 0) * Math.min(Math.abs(b.x), ga.B / 2 - r * 1.1 - 0.15), z = clamp(-ga.L / 2 + len, ga.L / 2 - len / 2 - 0.3, b.z);
    P.capsule('paint', r, len - 2 * r, x, b.y, z, col, Math.PI / 2);
    if (b.kind !== 'rescue') P.box('paint', r * 1.4, r * 0.7, len * 0.6, x, b.y + r * 0.9, z, col);
    if (lod === 0 && b.kind !== 'tender' && x) for (const dz of [-len * 0.35, len * 0.35]) P.beam('metal', x - Math.sign(x) * 1.0, b.y - r, z + dz, x, b.y + r * 2.2, z + dz, 0.25, 0.25, COL.light);
  } else if (b.kind === 'raft') {
    const x = Math.sign(b.x || 0) * Math.min(Math.abs(b.x), ga.B / 2 - 0.75);
    for (let i = 0; i < 2; i++) P.capsule('paint', 0.3, 0.6, x, b.y + 0.35, b.z + i * 0.9, 0xf2f2ee, 0, 0, Math.PI / 2);
  }
}

// ------------------------------------------------------------------------------------------------ handrails (LOD0, desktop)
function buildRails(ctx) {
  const { ga, P, hf, L } = ctx;
  const col = ctx.primer ? COL.primer : 0xdfe3e3;
  const rail = (pts, yFn, h = 1.1) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const [xa, za] = pts[i], [xb, zb] = pts[i + 1], ya = yFn(za), yb = yFn(zb);
      const len = Math.hypot(xb - xa, zb - za); if (len < 0.2) continue;
      P.beam('metal', xa, ya + h, za, xb, yb + h, zb, 0.06, 0.06, col);
      if (h > 0.8) P.beam('metal', xa, ya + h * 0.5, za, xb, yb + h * 0.5, zb, 0.04, 0.04, col);
      const n = Math.max(1, Math.round(len / 2.4));
      for (let k = i === 0 ? 0 : 1; k <= n; k++) { const t = k / n; P.box('metal', 0.05, h, 0.05, xa + (xb - xa) * t, ya + (yb - ya) * t + h / 2, za + (zb - za) * t, col); }
    }
  };
  // main deck edge where there is no bulwark
  if (!ga.hull.bulwark && ga.L >= 12 && !ga.hull.tube) {
    const z0 = ga.hull.fcsle ? -L / 2 + ga.hull.fcsle.len : -L / 2 + L * 0.05, z1 = L / 2 - 0.5;
    const n = Math.max(6, Math.round((z1 - z0) / 10));
    for (const d of hf.demi) for (const s of [-1, 1]) rail(outline(ctx, z0, z1, n, 0.25).map(([x, z]) => [d.cx + s * x, z]), (z) => hf.deckAt(z));
  }
  // forecastle edge
  if (ga.hull.fcsle) { const f = ga.hull.fcsle, n = 8; const pts = outline(ctx, -L / 2 + 0.3, -L / 2 + f.len, n, 0.3); for (const s of [-1, 1]) rail(pts.map(([x, z]) => [s * x, z]), (z) => hf.deckAt(z) + f.h); }
  // compass deck
  const b = ga.bridge;
  if (b && !b.embedded && b.h > 2 && ga.L > 20) { const w = (b.w ?? ga.house.w) / 2; rail([[-w, b.z0], [w, b.z0], [w, b.z1], [-w, b.z1], [-w, b.z0]], () => b.y + b.h + 0.3, 1.0); }
}

// ------------------------------------------------------------------------------------------------ decals
function buildDecals(ctx, tex, name) {
  const { ga, hf } = ctx;
  const mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, alphaTest: 0.25, roughness: 0.6, metalness: 0.1, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, depthWrite: false });
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
    for (const x of xs) for (const sd of [-1, 1]) addPlane(s, s, x + sd * (r * (1 - 0.08 * 0.62) + 0.08), y, f.z + f.h * 0.62 * 0.12, sd * Math.PI / 2, 0, 0, 0.5, 0.5);
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
  obj.traverse((o) => { if (!o.isMesh || !o.geometry) return; if (!o.geometry.boundingBox) o.geometry.computeBoundingBox(); tmp.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld); box.union(tmp); });
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
    o.geometry?.dispose();
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) { if (!m || seen.has(m)) continue; seen.add(m); if (m.map && !m.map.userData.shared) m.map.dispose(); m.dispose(); }
  });
}
export { BANDS, COL as SHIP_COLORS };
/** the §6.1 generators implemented here ('sail' stays with SAILING's rigmesh.js / yachtlooks.js) */
export const SHIPGEN_GENS = ['aft_house_dry', 'aft_house_tanker', 'lng', 'container', 'roro_pctc', 'ferry', 'cruise', 'offshore', 'tug', 'fishing', 'small_fast', 'motor_yacht', 'special'];
