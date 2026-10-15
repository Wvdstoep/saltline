// The cruise-ship casino: procedural high-detail furniture with shared PBR materials (docs/CRUISE-CONTRACT.md §4, §7).
//
// Light by design (the old version put ~265 MB of textures, 176k-triangle GLTF plants and an HDR on the GPU at once):
//   - no GLTF and no HDR: every prop is built here (lathes, extrusions, rounded boxes, tubes), ≤ ~2k triangles each,
//     built once per quality (desktop / phone) and drawn with ONE InstancedMesh per part for the whole zone
//     (a casino of 20 tables and 60 slot machines is ~45 draw calls), no shadow casting;
//   - ~24 shared materials; textured ones use one shared, size-capped texture set (casinotex.js: ≤ 1024 px desktop,
//     ≤ 512 px phones, decoded off the main thread, maps that add little dropped: no metalness maps, AO only from the
//     walnut's packed arm map, flat normal maps never loaded). Plain colours that match each texture's average show
//     until the maps arrive, so entering never waits for a texture;
//   - no lights are added (a light-count change recompiles every material in the scene, and per-table spot lights blew
//     the phone uniform budget): the room is lit by a small warm PMREM of an abstract casino room (materials' own
//     envMap — scene.environment is never touched) plus emissive bulbs, coves and downlights;
//   - prepareCasino() starts it all in the background (Go-to opened, casino zone near), warmCasino() compiles the
//     zone's programs with renderer.compileAsync, releaseCasino() frees textures, env and part buffers when the casino
//     has been out of sight for a while.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { bindTex, loadGroup, releaseGroup, placeholder, setTexRenderer, noteBytes, texBytes, texPlan, logBudget } from './casinotex.js';

// ------------------------------------------------------------------------------------------------ state
let PHONE = false;
let state = 'cold';     // cold → ready (textures bound and loading) → cold (released)
let envRT = null;
let idle = 0;
const RELEASE_AFTER = 20;   // s out of sight before the casino's GPU memory is given back

// ------------------------------------------------------------------------------------------------ materials
const TX = '/assets/casino/textures/';
const FILES = {
  feltC: TX + 'CG_Fabric028/Fabric028_2K-JPG_Color.jpg', feltN: TX + 'CG_Fabric028/Fabric028_2K-JPG_NormalGL.jpg',
  leatherC: TX + 'CG_Leather034C/Leather034C_2K-JPG_Color.jpg', leatherN: TX + 'CG_Leather034C/Leather034C_2K-JPG_NormalGL.jpg',
  walnutC: TX + 'PH_black_walnut_veneer_01/Diffuse.jpg', walnutN: TX + 'PH_black_walnut_veneer_01/nor_gl.jpg', walnutA: TX + 'PH_black_walnut_veneer_01/arm.jpg',
  marbleC: TX + 'CG_Marble014/Marble014_2K-JPG_Color.jpg', carpetN: TX + 'CG_Carpet012/Carpet012_2K-JPG_NormalGL.jpg',
};
const AVG = { feltC: [115, 111, 94], leatherC: [42, 32, 30], walnutC: [173, 148, 126], marbleC: [209, 195, 177] };   // measured mean sRGB of each colour map
const TILE = { felt: 0.6, leather: 0.45, walnut: 1.1, marble: 0.9, carpet: 2.6, damask: 1.8 };   // metres per texture repeat
const CHIP_COLS = [0xc8202a, 0x1f56c0, 0x1d8f3c, 0x18181c, 0xf2ead2, 0x7a2a9a, 0xe0a020];

const MAT = new Map();
const TEXDEFS = [];     // [material, slot, file, kind, small, onLoad, onUnload, repeat]
const CANVAS = new Map();   // name → CanvasTexture (carpet, damask, atlas)

function std(o) { const m = new THREE.MeshStandardMaterial(o); m.userData.shared = true; return m; }
/** A textured material: a plain colour (`look`, the texture's average) until its maps land, then `look / average` × map. */
function texMat(name, { look, color, normal, arm, rough, roughTex = rough, ns = 1, env = 0.6, small = false, metal = 0 }) {
  const lookC = new THREE.Color(look);
  let tint = lookC.clone();
  if (color && AVG[color]) { const a = new THREE.Color().setRGB(AVG[color][0] / 255, AVG[color][1] / 255, AVG[color][2] / 255, THREE.SRGBColorSpace); tint = new THREE.Color(lookC.r / Math.max(a.r, 1e-3), lookC.g / Math.max(a.g, 1e-3), lookC.b / Math.max(a.b, 1e-3)); }
  const m = std({ color: lookC.clone(), roughness: rough, metalness: metal, envMapIntensity: env });
  m.name = 'casino:' + name;
  const onLoad = (mm) => { mm.color.copy(tint); mm.roughness = roughTex; };
  const onUnload = (mm) => { mm.color.copy(lookC); mm.roughness = rough; };
  if (color) { m.map = placeholder('color'); TEXDEFS.push([m, 'map', color, 'color', small, onLoad, onUnload]); }
  if (normal) { m.normalMap = placeholder('normal'); m.normalScale.set(ns, ns); TEXDEFS.push([m, 'normalMap', normal, 'normal', small, color ? null : onLoad, color ? null : onUnload, normal === 'carpetN' ? [3, 3] : [1, 1]]); }
  if (arm) { m.aoMap = placeholder('arm'); m.roughnessMap = m.aoMap; TEXDEFS.push([m, 'aoMap', arm, 'arm', small]); TEXDEFS.push([m, 'roughnessMap', arm, 'arm', small]); }
  return m;
}

const MAKE = {
  felt: () => texMat('felt', { look: 0x15552b, color: 'feltC', normal: 'feltN', rough: 0.95, ns: 0.9, env: 0.9 }),
  feltRed: () => texMat('feltRed', { look: 0x6e1520, color: 'feltC', normal: 'feltN', rough: 0.95, ns: 0.9, env: 0.9 }),
  leather: () => texMat('leather', { look: 0x5c2a1a, color: 'leatherC', normal: 'leatherN', rough: 0.5, ns: 1.1, env: 0.9 }),
  leatherDark: () => texMat('leatherDark', { look: 0x26150f, color: 'leatherC', normal: 'leatherN', rough: 0.45, ns: 1.1, env: 0.9 }),
  walnut: () => texMat('walnut', { look: 0x7a4a2c, color: 'walnutC', normal: 'walnutN', arm: 'walnutA', rough: 0.55, roughTex: 0.95, ns: 0.8, env: 0.9 }),
  marble: () => texMat('marble', { look: 0xd1c3b1, color: 'marbleC', rough: 0.2, env: 1.0, small: true }),
  brass: () => std({ name: 'casino:brass', color: 0xd8b05a, metalness: 1, roughness: 0.3, envMapIntensity: 1.1 }),
  carpet: () => { const m = texMat('carpet', { look: 0xffffff, normal: 'carpetN', rough: 0.92, ns: 0.6, env: 0.9, small: true }); m.map = canvasTex('carpet'); return m; },
  damask: () => std({ name: 'casino:damask', map: canvasTex('damask'), roughness: 0.85, envMapIntensity: 0.9 }),
  coffer: () => std({ name: 'casino:coffer', color: 0xd9c9a6, emissive: 0x4a3420, emissiveIntensity: 1, roughness: 0.8, envMapIntensity: 0.9 }),   // up-lit by the coves
  light: () => std({ name: 'casino:light', color: 0xfff4e0, emissive: 0xffd9a0, emissiveIntensity: 2.2, roughness: 0.4 }),
  glow: () => std({ name: 'casino:glow', color: 0x2a2014, emissive: 0xffb45e, emissiveIntensity: 1.5, roughness: 0.9 }),
  crystal: () => std({ name: 'casino:crystal', color: 0xffffff, emissive: 0x3a3022, roughness: 0.05, metalness: 0.1, envMapIntensity: 2.4, flatShading: true }),
  cabinet: () => std({ name: 'casino:cabinet', color: 0x121216, metalness: 0.7, roughness: 0.22, envMapIntensity: 1.0 }),
  screen: () => std({ name: 'casino:screen', map: canvasTex('atlas'), emissiveMap: canvasTex('atlas'), emissive: 0xffffff, emissiveIntensity: 0.85, roughness: 0.3 }),
  print: () => std({ name: 'casino:print', map: canvasTex('atlas'), transparent: true, depthWrite: false, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  wheel: () => std({ name: 'casino:wheel', map: canvasTex('atlas'), roughness: 0.35, envMapIntensity: 0.9 }),
  chip: () => std({ name: 'casino:chip', color: 0xffffff, roughness: 0.35, envMapIntensity: 0.9 }),
  btn: () => std({ name: 'casino:btn', color: 0x332200, emissive: 0xffc040, emissiveIntensity: 1.4, roughness: 0.4 }),
  shade: () => std({ name: 'casino:shade', color: 0xf0dcb0, emissive: 0xffc27a, emissiveIntensity: 0.9, roughness: 0.9, side: THREE.DoubleSide }),
  leaf: () => std({ name: 'casino:leaf', color: 0x2e6a2a, roughness: 0.6, side: THREE.DoubleSide }),
  pot: () => std({ name: 'casino:pot', color: 0x1e1a17, roughness: 0.35, metalness: 0.1 }),
  bark: () => std({ name: 'casino:bark', color: 0x5a4330, roughness: 0.92 }),
};
/** The shared material `key` (created on first use). */
export function casinoMat(key) {
  let m = MAT.get(key);
  if (!m) { const f = MAKE[key]; if (!f) throw new Error('no casino material ' + key); m = f(); MAT.set(key, m); if (envRT && m.envMapIntensity !== undefined) m.envMap = envRT.texture; }
  return m;
}
export const CASINO_MATERIALS = Object.keys(MAKE);

// ------------------------------------------------------------------------------------------------ canvas textures
function canvasTex(name) {
  if (CANVAS.has(name)) return CANVAS.get(name);
  const S = name === 'damask' ? (PHONE ? 256 : 512) : (PHONE ? 512 : 1024);
  let c = null;
  try { c = document.createElement('canvas'); c.width = S; c.height = S; } catch { c = null; }
  const g = c?.getContext?.('2d');
  let t;
  if (g && c.width === S) {
    try { (name === 'carpet' ? drawCarpet : name === 'damask' ? drawDamask : drawAtlas)(g, S); } catch (e) { console.warn('[casino] canvas', name, e); }
    t = new THREE.CanvasTexture(c);
  } else t = new THREE.DataTexture(new Uint8Array(name === 'atlas' ? [0, 0, 0, 0] : name === 'carpet' ? [110, 20, 32, 255] : [80, 12, 22, 255]), 1, 1);
  t.colorSpace = THREE.SRGBColorSpace;
  if (name !== 'atlas') t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = PHONE ? 2 : 4; t.needsUpdate = true; t.userData.shared = true;
  CANVAS.set(name, t);
  noteBytes('canvas:' + name, texBytes(t.image?.width || 1, t.image?.height || 1));
  return t;
}

function drawCarpet(g, S) {   // royal ruby carpet: gold diamond lattice and medallions (the pile comes from the Carpet012 normal map)
  const k = S / 1024;
  g.fillStyle = '#3a0812'; g.fillRect(0, 0, S, S);
  try {   // fine two-tone weave in one pass instead of 60 000 fillRects
    const im = g.getImageData(0, 0, S, S), d = im.data; let seed = 7;
    for (let i = 0; i < d.length; i += 4) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; const v = (seed >> 16) & 31; d[i] = 50 + v; d[i + 1] = 8 + (v >> 2); d[i + 2] = 16 + (v >> 1); d[i + 3] = 255; }
    g.putImageData(im, 0, 0);
  } catch { /* no pixel access: the flat base stays */ }
  g.save(); g.scale(k, k);
  const step = 256;
  for (let x = 0; x <= 1024; x += step) for (let y = 0; y <= 1024; y += step) {
    g.beginPath(); g.moveTo(x, y - step / 2); g.lineTo(x + step / 2, y); g.lineTo(x, y + step / 2); g.lineTo(x - step / 2, y); g.closePath();
    g.strokeStyle = '#997a23'; g.lineWidth = 5; g.stroke(); g.strokeStyle = '#d4af37'; g.lineWidth = 2; g.stroke();
    g.save(); g.translate(x, y);
    g.fillStyle = 'rgba(212,175,55,0.85)'; g.beginPath(); g.arc(0, 0, 34, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#2a050d'; g.beginPath(); g.arc(0, 0, 24, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#d4af37'; for (let p = 0; p < 8; p++) { const a = (p / 8) * Math.PI * 2; g.beginPath(); g.arc(Math.cos(a) * 17, Math.sin(a) * 17, 6, 0, Math.PI * 2); g.fill(); }
    g.fillStyle = '#0f4c81'; g.beginPath(); g.arc(0, 0, 8, 0, Math.PI * 2); g.fill();
    g.restore();
    // small fleurons on the lattice midpoints
    g.save(); g.translate(x + step / 2, y); g.fillStyle = 'rgba(212,175,55,0.7)';
    for (let p = 0; p < 4; p++) { const a = (p / 4) * Math.PI * 2 + Math.PI / 4; g.beginPath(); g.ellipse(Math.cos(a) * 10, Math.sin(a) * 10, 9, 4, a, 0, Math.PI * 2); g.fill(); }
    g.restore();
  }
  g.restore();
}

function drawDamask(g, S) {
  const k = S / 512;
  g.fillStyle = '#32060e'; g.fillRect(0, 0, S, S);
  g.save(); g.scale(k, k);
  for (let x = 0; x <= 512; x += 128) for (let y = 0; y <= 512; y += 128) {
    const ox = (y / 128) % 2 ? 64 : 0;
    g.save(); g.translate(x + ox, y);
    g.strokeStyle = '#c69c3a'; g.lineWidth = 3;
    g.beginPath(); g.ellipse(0, 0, 26, 40, 0, 0, Math.PI * 2); g.stroke();
    g.fillStyle = 'rgba(198,156,58,0.45)';
    g.beginPath(); g.moveTo(0, -30); g.quadraticCurveTo(18, 0, 0, 30); g.quadraticCurveTo(-18, 0, 0, -30); g.fill();
    for (const s of [-1, 1]) { g.beginPath(); g.ellipse(s * 34, 0, 10, 4, s * 0.6, 0, Math.PI * 2); g.fill(); }
    g.restore();
  }
  g.restore();
}

// The print atlas (1024 units square; phones draw it at half size): every table layout, the slot reels and marquee and
// the roulette wheel face in ONE texture, used by three materials (print decals, lit screens, the wheel).
const REG = { roul: [0, 0, 1024, 512], bj: [0, 512, 512, 256], bac: [512, 512, 512, 256], wheel: [0, 768, 256, 256], marquee: [256, 768, 512, 128], logo: [256, 896, 512, 128], reel: [768, 768, 256, 256] };
function region(g, key, dw, dh, draw) { const [x, y, w, h] = REG[key]; g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip(); g.translate(x, y); g.scale(w / dw, h / dh); draw(g); g.restore(); }
const RED_NUMS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const WHEEL_ORDER = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
function drawAtlas(g, S) {
  g.clearRect(0, 0, S, S);
  g.save(); g.scale(S / 1024, S / 1024);
  region(g, 'roul', 1024, 512, (c) => {
    c.strokeStyle = '#f0d070'; c.lineWidth = 3; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = '#1e7b34'; c.fillRect(40, 100, 70, 240); c.strokeRect(40, 100, 70, 240);
    c.fillStyle = '#fff'; c.font = 'bold 44px Arial, sans-serif'; c.fillText('0', 75, 220);
    const colW = 68, rowH = 80;
    for (let col = 0; col < 12; col++) for (let r = 0; r < 3; r++) {
      const n = col * 3 + (3 - r), x = 110 + col * colW, y = 100 + r * rowH;
      c.fillStyle = RED_NUMS.has(n) ? '#b22222' : '#1a1a1a'; c.fillRect(x, y, colW, rowH); c.strokeRect(x, y, colW, rowH);
      c.fillStyle = '#fff'; c.font = 'bold 34px Arial, sans-serif'; c.fillText(String(n), x + colW / 2, y + rowH / 2);
    }
    ['1st 12', '2nd 12', '3rd 12'].forEach((t, d) => { const x = 110 + d * colW * 4; c.fillStyle = 'rgba(20,60,30,0.6)'; c.fillRect(x, 340, colW * 4, 50); c.strokeRect(x, 340, colW * 4, 50); c.fillStyle = '#f0d070'; c.font = 'bold 26px Georgia, serif'; c.fillText(t, x + colW * 2, 365); });
    const outs = ['1 to 18', 'EVEN', 'RED', 'BLACK', 'ODD', '19 to 36'], ow = (colW * 12) / 6;
    outs.forEach((t, o) => { const x = 110 + o * ow; c.fillStyle = o === 2 ? '#b22222' : o === 3 ? '#1a1a1a' : 'rgba(20,60,30,0.6)'; c.fillRect(x, 390, ow, 45); c.strokeRect(x, 390, ow, 45); c.fillStyle = '#fff'; c.font = 'bold 22px Arial, sans-serif'; c.fillText(t, x + ow / 2, 412); });
  });
  const layout = (bac) => (c) => {
    c.strokeStyle = 'rgba(216,180,106,0.7)'; c.fillStyle = 'rgba(216,180,106,0.8)'; c.lineWidth = 4; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = 'bold 38px Georgia, serif'; c.fillText(bac ? 'BACCARAT — PUNTO BANCO' : 'BLACKJACK PAYS 3 TO 2', 512, 170);
    c.font = '24px Georgia, serif'; c.fillText(bac ? 'BANKER 1 TO 1 (5% COMM) • PLAYER 1 TO 1 • TIE 8 TO 1' : 'Dealer must draw to 16 and stand on all 17s', 512, 220);
    c.font = 'bold 26px Georgia, serif'; c.fillText(bac ? 'SALTLINE HIGH LIMIT' : 'INSURANCE PAYS 2 TO 1', 512, 262);
    for (let i = 0; i < 5; i++) { const bx = 200 + i * 156, by = 380; c.strokeRect(bx - 50, by - 35, 100, 70); c.beginPath(); c.arc(bx, by, 22, 0, Math.PI * 2); c.stroke(); }
  };
  region(g, 'bj', 1024, 512, layout(false));
  region(g, 'bac', 1024, 512, layout(true));
  region(g, 'wheel', 256, 256, (c) => {
    const cx = 128, cy = 128, R0 = 126, R1 = 100, R2 = 74, n = 37;
    c.fillStyle = '#3a1f12'; c.beginPath(); c.arc(cx, cy, 128, 0, Math.PI * 2); c.fill();
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2 - Math.PI / 2, a1 = ((i + 1) / n) * Math.PI * 2 - Math.PI / 2, num = WHEEL_ORDER[i];
      c.fillStyle = num === 0 ? '#1e7b34' : RED_NUMS.has(num) ? '#b0161e' : '#141414';
      c.beginPath(); c.arc(cx, cy, R0, a0, a1); c.arc(cx, cy, R2, a1, a0, true); c.closePath(); c.fill();
      c.strokeStyle = '#d8b25a'; c.lineWidth = 1.2; c.stroke();
      const am = (a0 + a1) / 2; c.save(); c.translate(cx + Math.cos(am) * (R0 + R1) / 2, cy + Math.sin(am) * (R0 + R1) / 2); c.rotate(am + Math.PI / 2);
      c.fillStyle = '#fff'; c.font = 'bold 11px Arial, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(String(num), 0, 0); c.restore();
    }
    c.strokeStyle = '#e6c46e'; c.lineWidth = 2; c.beginPath(); c.arc(cx, cy, R1 - 4, 0, Math.PI * 2); c.stroke();
    const grd = c.createRadialGradient(cx, cy, 4, cx, cy, R2); grd.addColorStop(0, '#8a5a32'); grd.addColorStop(1, '#4a2a16');
    c.fillStyle = grd; c.beginPath(); c.arc(cx, cy, R2 - 1, 0, Math.PI * 2); c.fill();
  });
  region(g, 'marquee', 512, 128, (c) => {
    c.fillStyle = '#100508'; c.fillRect(0, 0, 512, 128);
    c.strokeStyle = '#ffd700'; c.lineWidth = 6; c.strokeRect(6, 6, 500, 116);
    for (let i = 0; i < 24; i++) { c.fillStyle = i % 2 ? '#fff2b0' : '#ffb020'; c.beginPath(); c.arc(16 + i * 20.8, 14, 3, 0, Math.PI * 2); c.fill(); c.beginPath(); c.arc(16 + i * 20.8, 114, 3, 0, Math.PI * 2); c.fill(); }
    c.fillStyle = '#ffe040'; c.font = 'bold 38px Georgia, serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('★ ROYAL CASINO ★', 256, 46);
    c.fillStyle = '#00ffcc'; c.font = 'bold 28px "Courier New", monospace'; c.fillText('JACKPOT $2,485,910', 256, 88);
  });
  region(g, 'logo', 1024, 256, (c) => { c.fillStyle = 'rgba(216,180,106,0.55)'; c.font = '600 86px Georgia, serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('SALTLINE CASINO', 512, 128); });
  region(g, 'reel', 512, 256, (c) => {
    const grd = c.createLinearGradient(0, 0, 0, 256); grd.addColorStop(0, '#d8d4c8'); grd.addColorStop(0.5, '#fbfaf4'); grd.addColorStop(1, '#d8d4c8');
    c.fillStyle = grd; c.fillRect(0, 0, 512, 256);
    c.strokeStyle = '#222'; c.lineWidth = 3; c.textAlign = 'center'; c.textBaseline = 'middle';
    const sym = [['7', '#ff1122'], ['BAR', '#111'], ['🍒', '#c00'], ['7', '#ff1122'], ['BAR', '#111'], ['★', '#e0a000']];
    for (let i = 0; i < 3; i++) {
      const rx = 30 + i * 155; c.strokeRect(rx, 14, 140, 228);
      for (let j = 0; j < 3; j++) { const [s, col] = sym[(i * 2 + j) % sym.length]; c.fillStyle = col; c.font = s === 'BAR' ? 'bold 34px Arial, sans-serif' : 'bold 62px Arial, sans-serif'; c.fillText(s, rx + 70, 52 + j * 76); }
    }
    c.strokeStyle = 'rgba(220,30,30,0.85)'; c.lineWidth = 4; c.beginPath(); c.moveTo(18, 128); c.lineTo(494, 128); c.stroke();
  });
  g.restore();
}
/** UV rectangle [u0, v0, u1, v1] of an atlas region (canvas textures are flipped: canvas top = v 1). */
function regUV(key) { const [x, y, w, h] = REG[key]; return [x / 1024, 1 - (y + h) / 1024, (x + w) / 1024, 1 - y / 1024]; }
function remapUV(g, key) { const [u0, v0, u1, v1] = regUV(key), uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0)); uv.needsUpdate = true; return g; }

// ------------------------------------------------------------------------------------------------ geometry helpers
const Q = () => (PHONE ? { seg: 28, tube: 40, rad: 6, lat: 10, rb: 1, crystals: 32, fronds: 8 } : { seg: 48, tube: 56, rad: 8, lat: 16, rb: 2, crystals: 48, fronds: 12 });
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
/** Matrix: translate (x, y, z), rotate (rx, ry, rz) [XYZ], scale (sx, sy, sz). */
function M4(x = 0, y = 0, z = 0, ry = 0, sx = 1, sy = sx, sz = sx, rx = 0, rz = 0) { return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz)); }
function T(g, x = 0, y = 0, z = 0, ry = 0, sx = 1, sy = sx, sz = sx, rx = 0, rz = 0) { _m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(sx, sy, sz)); g.applyMatrix4(_m); return g; }
const ni = (g) => { const r = g.index ? g.toNonIndexed() : g; for (const k of Object.keys(r.attributes)) if (!['position', 'normal', 'uv'].includes(k)) r.deleteAttribute(k); if (!r.attributes.uv) r.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(r.attributes.position.count * 2), 2)); if (!r.attributes.normal) r.computeVertexNormals(); return r; };
function merge(gs) { const list = gs.filter(Boolean).map(ni); const out = list.length === 1 ? list[0] : mergeGeometries(list, false); for (const g of gs) if (g && g !== out) g.dispose(); return out; }
function scaleUV(g, su, sv = su) { const uv = g.attributes.uv; if (!uv) return g; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv); uv.needsUpdate = true; return g; }
/** UVs in metres / tile on the six faces of a (rounded) box: right, left, top, bottom, front, back. */
function boxUV(g, w, h, d, tile) {
  const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]], uv = g.attributes.uv;
  const ranges = [];
  if (g.index && g.groups.length === 6) { const ix = g.index.array; for (const gr of g.groups) { let lo = Infinity, hi = -1; for (let i = gr.start; i < gr.start + gr.count; i++) { lo = Math.min(lo, ix[i]); hi = Math.max(hi, ix[i]); } ranges.push([lo, hi + 1]); } }
  else { const n = uv.count / 6; for (let f = 0; f < 6; f++) ranges.push([f * n, (f + 1) * n]); }
  ranges.forEach(([a, b], f) => { for (let i = a; i < b; i++) uv.setXY(i, uv.getX(i) * dims[f][0] / tile, uv.getY(i) * dims[f][1] / tile); });
  uv.needsUpdate = true; return g;
}
/** A rounded box (`seg` 1 = one chamfer band, 2 = round); phones and seg 0 get a plain box (12 triangles). */
function rbox(w, h, d, r, tile = 1, seg = Q().rb) { if (PHONE || !seg) return box(w, h, d, tile); const g = new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2, h / 2, d / 2)); return boxUV(g, w, h, d, tile); }
function box(w, h, d, tile = 1) { return boxUV(new THREE.BoxGeometry(w, h, d), w, h, d, tile); }
/** A lathe of [[r, y], …] (r > 0 keeps the poles closed), UVs scaled to ~metres / tile. */
function lathe(pts, seg = Q().lat, tile = 0) {
  if (pts[0][1] > pts[pts.length - 1][1]) pts = pts.slice().reverse();   // bottom → top keeps the faces outward
  const g = new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(Math.max(r, 1e-4), y)), seg);
  if (tile) { let len = 0; for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); const rMax = Math.max(...pts.map((p) => p[0])); scaleUV(g, (2 * Math.PI * rMax) / tile, len / tile); }
  return g;
}
function ellipseShape(a, b, seg = Q().seg, hole = null) {
  const s = new THREE.Shape();
  for (let i = 0; i <= seg; i++) { const t = (i / seg) * Math.PI * 2; if (i) s.lineTo(a * Math.cos(t), b * Math.sin(t)); else s.moveTo(a * Math.cos(t), b * Math.sin(t)); }
  if (hole) { const h = new THREE.Path(); for (let i = 0; i <= seg; i++) { const t = -(i / seg) * Math.PI * 2; if (i) h.lineTo(hole[0] * Math.cos(t), hole[1] * Math.sin(t)); else h.moveTo(hole[0] * Math.cos(t), hole[1] * Math.sin(t)); } s.holes.push(h); }
  return s;
}
function roundRectPts(hw, hd, r, n = 6) {
  const pts = [], c = [[hw - r, hd - r, 0], [-hw + r, hd - r, Math.PI / 2], [-hw + r, -hd + r, Math.PI], [hw - r, -hd + r, Math.PI * 1.5]];
  for (const [cx, cy, a0] of c) for (let i = 0; i <= n; i++) { const a = a0 + (i / n) * Math.PI / 2; pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return pts;
}
function shapeOf(pts) { const s = new THREE.Shape(); pts.forEach(([x, y], i) => (i ? s.lineTo(x, y) : s.moveTo(x, y))); s.closePath(); return s; }
/** A flat top (shape in plan, +y up) at height y, plan UVs / tile. Shape y is world −z. */
function flat(shape, y, tile) { const g = new THREE.ShapeGeometry(shape, 1); g.rotateX(-Math.PI / 2); g.translate(0, y, 0); return scaleUV(g, 1 / tile); }
/** An apron: the shape extruded `h` up from y with a soft bevel. */
function apron(shape, y, h, tile) {
  const g = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: true, bevelThickness: 0.018, bevelSize: 0.022, bevelSegments: PHONE ? 1 : 2, curveSegments: 1 });
  g.rotateX(-Math.PI / 2); g.translate(0, y, 0); return scaleUV(g, 1 / tile);
}
class EllipseCurve3 extends THREE.Curve { constructor(a, b) { super(); this.a = a; this.b = b; } getPoint(t, o = new THREE.Vector3()) { const th = t * Math.PI * 2; return o.set(this.a * Math.cos(th), 0, this.b * Math.sin(th)); } }
/** A padded rail: a tube along `curve`, squashed to `sy`, at height y; UVs in metres / tile. */
function railTube(curve, r, y, closed, len, sy = 0.82, tile = TILE.leather) {
  const q = Q(); const g = new THREE.TubeGeometry(curve, q.tube, r, q.rad, closed);
  g.scale(1, sy, 1); g.translate(0, y, 0); return scaleUV(g, len / tile, (2 * Math.PI * r) / tile);
}
const ringFlat = (a0, b0, a1, b1, y) => flat(ellipseShape(a1, b1, Q().seg, [a0, b0]), y, 1);

// ------------------------------------------------------------------------------------------------ parts
// Every part is one shared geometry + one shared material; a prop is a list of [part, local matrix, colour?].
const PARTS = {
  // ---- tables
  'poker.apron': ['walnut', () => apron(ellipseShape(1.12, 0.72), 0.62, 0.1, TILE.walnut)],
  'poker.felt': ['felt', () => flat(ellipseShape(1.0, 0.6), 0.756, TILE.felt)],
  'poker.track': ['walnut', () => flat(ellipseShape(1.1, 0.7, Q().seg, [1.01, 0.61]), 0.762, TILE.walnut)],
  'poker.inlay': ['brass', () => ringFlat(1.0, 0.6, 1.012, 0.612, 0.7625)],
  'poker.rail': ['leatherDark', () => railTube(new EllipseCurve3(1.14, 0.74), 0.072, 0.79, true, 5.9)],
  'ped': ['walnut', () => lathe([[0.001, 0.035], [0.28, 0.035], [0.27, 0.06], [0.2, 0.085], [0.12, 0.11], [0.095, 0.16], [0.08, 0.3], [0.088, 0.42], [0.105, 0.46], [0.085, 0.5], [0.075, 0.56], [0.13, 0.6], [0.15, 0.645], [0.001, 0.645]], PHONE ? 8 : 12, TILE.walnut)],
  'ped.foot': ['brass', () => lathe([[0.001, 0], [0.3, 0], [0.31, 0.012], [0.3, 0.035], [0.001, 0.035]], Q().lat)],
  'print.poker': ['print', () => { const g = remapUV(new THREE.PlaneGeometry(0.86, 0.215), 'logo'); g.rotateX(-Math.PI / 2); return g; }],
  'bj.apron': ['walnut', () => apron(shapeOf(horseshoe(1.16, 0.8, -0.36)), 0.62, 0.1, TILE.walnut)],
  'bj.felt': ['felt', () => flat(shapeOf(horseshoe(1.06, 0.7, -0.27)), 0.756, TILE.felt)],
  'bac.felt': ['feltRed', () => flat(shapeOf(horseshoe(1.06, 0.7, -0.27)), 0.756, TILE.felt)],
  'bj.rail': ['leatherDark', () => railTube(new THREE.CatmullRomCurve3(horseshoeRail(1.12, 0.76, -0.36).map(([x, z]) => new THREE.Vector3(x, 0, z)), false, 'centripetal'), 0.07, 0.79, false, 4.8)],
  'bj.pad': ['leatherDark', () => rbox(2.3, 0.075, 0.14, 0.035, TILE.leather)],
  'print.bj': ['print', () => { const g = remapUV(new THREE.PlaneGeometry(1.6, 0.8), 'bj'); g.rotateX(-Math.PI / 2); return g; }],
  'print.bac': ['print', () => { const g = remapUV(new THREE.PlaneGeometry(1.6, 0.8), 'bac'); g.rotateX(-Math.PI / 2); return g; }],
  'roul.apron': ['walnut', () => apron(shapeOf(roundRectPts(1.28, 0.78, 0.26)), 0.62, 0.1, TILE.walnut)],
  'roul.felt': ['felt', () => flat(shapeOf(roundRectPts(1.18, 0.68, 0.2)), 0.756, TILE.felt)],
  'roul.rail': ['leatherDark', () => railTube(new THREE.CatmullRomCurve3(roundRectPts(1.24, 0.74, 0.24, 6).map(([x, y]) => new THREE.Vector3(x, 0, -y)), true, 'centripetal'), 0.065, 0.79, true, 7.6)],
  'print.roul': ['print', () => { const g = remapUV(new THREE.PlaneGeometry(1.45, 0.82), 'roul'); g.rotateX(-Math.PI / 2); return g; }],
  'wheel.bowl': ['walnut', () => lathe([[0.001, 0.75], [0.44, 0.75], [0.47, 0.78], [0.475, 0.83], [0.465, 0.88], [0.445, 0.89], [0.41, 0.885], [0.36, 0.862], [0.34, 0.852], [0.001, 0.852]], PHONE ? 20 : 36, TILE.walnut)],
  'wheel.trim': ['brass', () => lathe([[0.468, 0.876], [0.478, 0.884], [0.47, 0.892], [0.448, 0.892]], Q().seg)],
  'wheel.head': ['wheel', () => { const g = remapUV(new THREE.CircleGeometry(0.335, PHONE ? 37 : 74), 'wheel'); g.rotateX(-Math.PI / 2); g.translate(0, 0.856, 0); return g; }],
  'wheel.turret': ['brass', () => merge([lathe([[0.001, 0.856], [0.07, 0.856], [0.05, 0.875], [0.025, 0.89], [0.02, 0.93], [0.032, 0.945], [0.012, 0.965], [0.001, 0.97]], 12),
    ...[0, 1, 2, 3].map((a) => T(new THREE.CylinderGeometry(0.006, 0.006, 0.16, 6), 0, 0.93, 0, (a * Math.PI) / 2, 1, 1, 1, 0, Math.PI / 2)),
    ...[0, 1, 2, 3].map((a) => T(new THREE.SphereGeometry(0.012, 8, 6), Math.cos((a * Math.PI) / 2) * 0.08, 0.93, Math.sin((a * Math.PI) / 2) * 0.08))])],
  'ball': ['chip', () => new THREE.SphereGeometry(0.011, 10, 8)],
  'dolly': ['brass', () => lathe([[0.001, 0.757], [0.03, 0.757], [0.022, 0.78], [0.012, 0.8], [0.02, 0.82], [0.001, 0.83]], 10)],
  'chip': ['chip', () => new THREE.CylinderGeometry(0.02, 0.02, 1, PHONE ? 10 : 16)],
  'tray': ['brass', () => merge([box(0.5, 0.025, 0.16), T(box(0.46, 0.02, 0.12), 0, 0.012, 0)])],
  'shoe': ['cabinet', () => T(rbox(0.13, 0.08, 0.24, 0.02, 1, 1), 0, 0, 0, 0, 1, 1, 1, -0.12)],
  'pend.shade': ['brass', () => merge([lathe([[0.36, 0], [0.37, 0.01], [0.3, 0.09], [0.16, 0.15], [0.06, 0.18], [0.03, 0.2], [0.001, 0.205]], Q().lat), T(new THREE.CylinderGeometry(0.007, 0.007, 1.2, 6), 0, 0.8, 0)])],
  'pend.glow': ['light', () => { const g = new THREE.CircleGeometry(0.34, Q().lat); g.rotateX(Math.PI / 2); g.translate(0, 0.012, 0); return g; }],
  // ---- seating
  'chair.lea': ['leather', () => merge([T(rbox(0.6, 0.18, 0.54, 0.05, TILE.leather, 1), 0, 0.29, 0.02), T(rbox(0.52, 0.11, 0.46, 0.05, TILE.leather), 0, 0.43, 0.05), chairBack(), ...[-1, 1].map((s) => T(rbox(0.1, 0.24, 0.5, 0.045, TILE.leather, 1), s * 0.3, 0.5, 0.0))])],
  'chair.leg': ['walnut', () => merge([-1, 1].flatMap((sx) => [-1, 1].map((sz) => T(new THREE.CylinderGeometry(0.022, 0.015, 0.22, 6), sx * 0.25, 0.11, sz * 0.2, 0, 1, 1, 1, sz * 0.08, -sx * 0.08))))],
  'stool.metal': ['brass', () => merge([lathe([[0.001, 0], [0.22, 0], [0.225, 0.015], [0.18, 0.03], [0.05, 0.05], [0.035, 0.08], [0.03, 0.5], [0.06, 0.52], [0.001, 0.53]], PHONE ? 6 : 12), T(new THREE.TorusGeometry(0.15, 0.012, PHONE ? 3 : 4, PHONE ? 6 : 14), 0, 0.22, 0, 0, 1, 1, 1, Math.PI / 2)])],
  'stool.seat': ['leatherDark', () => merge([lathe([[0.001, 0.52], [0.17, 0.52], [0.2, 0.55], [0.205, 0.58], [0.19, 0.61], [0.12, 0.625], [0.001, 0.628]], PHONE ? 8 : 12, TILE.leather), T(rbox(0.34, 0.22, 0.06, 0.025, TILE.leather, 1), 0, 0.76, -0.17, 0, 1, 1, 1, -0.12)])],
  // ---- slot machines (one machine; faces +z)
  'slot.cab': ['cabinet', () => merge([T(rbox(0.78, 0.72, 0.56, 0.04, 1, 1), 0, 0.42, 0), T(rbox(0.8, 0.5, 0.46, 0.04, 1, 1), 0, 1.03, -0.05), T(rbox(0.78, 0.32, 0.4, 0.04, 1, 1), 0, 1.44, -0.07), T(rbox(0.78, 0.08, 0.3, 0.025, 1, 1), 0, 0.81, 0.2, 0, 1, 1, 1, 0.22)])],
  'slot.trim': ['brass', () => merge([T(box(0.84, 0.05, 0.6), 0, 0.085, 0), T(box(0.76, 0.03, 0.04), 0, 1.225, 0.24), T(box(0.76, 0.03, 0.04), 0, 0.835, 0.24), ...[-1, 1].map((s) => T(box(0.03, 0.42, 0.04), s * 0.385, 1.03, 0.19)),
    canopy(), T(rbox(0.5, 0.06, 0.14, 0.02, 1, 1), 0, 0.5, 0.32), T(new THREE.CylinderGeometry(0.026, 0.026, 0.05, 8), 0.43, 0.9, 0.05, 0, 1, 1, 1, 0, Math.PI / 2), T(new THREE.CylinderGeometry(0.011, 0.011, 0.26, 5), 0.47, 1.0, 0.08, 0, 1, 1, 1, 0.25)])],
  'slot.screen': ['screen', () => { const g = remapUV(new THREE.CylinderGeometry(0.9, 0.9, 0.36, PHONE ? 6 : 10, 1, true, -0.37, 0.74), 'reel'); g.translate(0, 1.03, -0.9 + 0.246); return g; }],
  'slot.marquee': ['screen', () => { const g = remapUV(new THREE.PlaneGeometry(0.72, 0.22), 'marquee'); g.translate(0, 1.45, 0.135); return g; }],
  'slot.btn': ['btn', () => merge([T(new THREE.CylinderGeometry(0.045, 0.045, 0.02, PHONE ? 6 : 10), 0.24, 0.86, 0.22, 0, 1, 1, 1, 0.22), ...[0, 1, 2, 3].map((b) => T(new THREE.CylinderGeometry(0.022, 0.022, 0.015, PHONE ? 4 : 6), -0.26 + b * 0.09, 0.855, 0.22, 0, 1, 1, 1, 0.22))])],
  'slot.knob': ['chip', () => T(new THREE.SphereGeometry(0.036, PHONE ? 6 : 8, PHONE ? 4 : 6), 0.47, 1.13, 0.115)],
  'slot.plinth': ['walnut', () => rbox(3.6, 0.06, 1.55, 0.025, TILE.walnut, 1)],
  // ---- room dressing
  'col.shaft': ['marble', () => scaleUV(new THREE.CylinderGeometry(0.22, 0.22, 1, PHONE ? 16 : 28, 1, true), 1.4 / TILE.marble, 3.5 / TILE.marble)],
  'col.base': ['brass', () => lathe([[0.001, 0], [0.34, 0], [0.34, 0.06], [0.31, 0.08], [0.3, 0.11], [0.26, 0.14], [0.24, 0.16], [0.22, 0.17], [0.001, 0.17]], PHONE ? 16 : 28)],
  'col.cap': ['brass', () => lathe([[0.001, 0], [0.22, 0], [0.24, 0.02], [0.26, 0.05], [0.3, 0.1], [0.36, 0.14], [0.37, 0.2], [0.001, 0.2]], PHONE ? 16 : 28)],
  'ch.frame': ['brass', () => chandelierFrame()],
  'ch.bulb': ['light', () => T(new THREE.IcosahedronGeometry(0.034, 0), 0, 0, 0, 0, 1, 1.45, 1)],
  'ch.crystal': ['crystal', () => T(new THREE.OctahedronGeometry(0.024, 0), 0, 0, 0, 0, 1, 2.1, 1)],
  'sc.metal': ['brass', () => merge([T(lathe([[0.001, 0], [0.065, 0], [0.07, 0.01], [0.05, 0.02], [0.001, 0.022]], 12), 0, 0, 0, 0, 1, 1.5, 1, Math.PI / 2),
    new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(new THREE.Vector3(0, 0, 0.02), new THREE.Vector3(0, -0.02, 0.15), new THREE.Vector3(0, 0.1, 0.17)), 8, 0.009, 5, false),
    T(lathe([[0.001, 0], [0.03, 0], [0.035, 0.02], [0.02, 0.03], [0.001, 0.03]], 10), 0, 0.09, 0.17)])],
  'sc.glass': ['shade', () => T(lathe([[0.022, 0], [0.05, 0.03], [0.066, 0.09], [0.062, 0.12]], 12), 0, 0.11, 0.17)],
  'dl.trim': ['brass', () => { const g = new THREE.RingGeometry(0.055, 0.085, PHONE ? 10 : 16); g.rotateX(Math.PI / 2); return g; }],
  'dl.glow': ['light', () => { const g = new THREE.CircleGeometry(0.056, PHONE ? 10 : 16); g.rotateX(Math.PI / 2); g.translate(0, -0.004, 0); return g; }],
  'lamp.base': ['brass', () => lathe([[0.001, 0], [0.09, 0], [0.095, 0.012], [0.05, 0.03], [0.035, 0.06], [0.06, 0.13], [0.035, 0.2], [0.014, 0.23], [0.012, 0.36], [0.001, 0.37]], 12)],
  'lamp.shade': ['shade', () => lathe([[0.17, 0.26], [0.15, 0.32], [0.09, 0.42], [0.075, 0.43]], 16)],
  // ---- plants (every deck: plain materials only)
  'palm.pot': ['pot', () => lathe([[0.001, 0], [0.26, 0], [0.3, 0.05], [0.36, 0.42], [0.39, 0.46], [0.39, 0.52], [0.35, 0.52], [0.34, 0.47], [0.001, 0.47]], PHONE ? 12 : 20)],
  'palm.band': ['brass', () => lathe([[0.393, 0.43], [0.402, 0.44], [0.402, 0.47], [0.393, 0.48]], PHONE ? 12 : 20)],
  'palm.trunk': ['bark', () => { const pts = [[0.001, 0.47], [0.33, 0.47]]; for (let i = 0; i <= 12; i++) { const y = 0.47 + i * 0.16, r = 0.11 - i * 0.0035; pts.push([r + (i % 2 ? 0.012 : 0), y]); } pts.push([0.001, 0.47 + 12 * 0.16 + 0.02]); return lathe(pts, PHONE ? 7 : 10); }],
  'palm.leaf': ['leaf', () => frond()],
};
export const CASINO_PARTS = Object.keys(PARTS);

function horseshoe(rx, rz, dBack, seg = Q().seg) {   // plan points (x, z): flat dealer side at z = dBack, arc towards +z
  const p = [[-rx, dBack], [rx, dBack], [rx, 0]];
  for (let i = 1; i < seg; i++) { const t = (i / seg) * Math.PI; p.push([rx * Math.cos(t), rz * Math.sin(t)]); }
  p.push([-rx, 0]);
  return p.map(([x, z]) => [x, -z]);   // shape y = −world z
}
function horseshoeRail(rx, rz, dBack) {
  const p = [[rx, dBack], [rx, dBack / 2]];
  for (let i = 0; i <= 24; i++) { const t = (i / 24) * Math.PI; p.push([rx * Math.cos(t), rz * Math.sin(t) + 0]); }
  p.push([-rx, dBack / 2], [-rx, dBack]);
  return p;
}
function chairBack() {   // a curved wing back: an arc band in plan extruded upward with soft edges
  const s = new THREE.Shape(), R1 = 0.34, R0 = 0.27, a0 = 0.35, a1 = Math.PI - 0.35, n = PHONE ? 6 : 10;
  for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * (i / n); i ? s.lineTo(R1 * Math.cos(a), R1 * Math.sin(a)) : s.moveTo(R1 * Math.cos(a), R1 * Math.sin(a)); }
  for (let i = n; i >= 0; i--) { const a = a0 + (a1 - a0) * (i / n); s.lineTo(R0 * Math.cos(a), R0 * Math.sin(a)); }
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.42, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.025, bevelSegments: PHONE ? 1 : 2, curveSegments: 1 });
  g.rotateX(-Math.PI / 2); g.translate(0, 0.5, 0.06);   // shape +y (the back) → world −z
  return scaleUV(g, 1 / TILE.leather);
}
function canopy() {   // the gold barrel hood over the marquee
  const g = new THREE.CylinderGeometry(0.42, 0.42, 0.48, PHONE ? 10 : 18, 1, true, -Math.PI / 2, Math.PI);
  g.rotateX(-Math.PI / 2); g.scale(1, 0.42, 1); g.translate(0, 1.6, -0.06);
  const lip = T(new THREE.TorusGeometry(0.42, 0.014, 4, PHONE ? 8 : 12, Math.PI), 0, 1.6, 0.18, 0, 1, 0.42, 1);
  return merge([g, lip]);
}
function chandelierFrame() {
  const q = Q(), seg = PHONE ? 8 : 12;
  const stem = lathe([[0.001, 1.0], [0.012, 1.0], [0.012, 0.62], [0.04, 0.58], [0.05, 0.52], [0.02, 0.48], [0.016, 0.3], [0.05, 0.25], [0.06, 0.2], [0.03, 0.16], [0.02, 0.05], [0.07, 0.0], [0.09, -0.06], [0.06, -0.14], [0.02, -0.2], [0.001, -0.26]], seg);
  const ringA = T(new THREE.TorusGeometry(0.46, 0.012, 4, PHONE ? 20 : 32), 0, -0.02, 0, 0, 1, 1, 1, Math.PI / 2);
  const ringB = T(new THREE.TorusGeometry(0.28, 0.01, 4, PHONE ? 16 : 24), 0, 0.22, 0, 0, 1, 1, 1, Math.PI / 2);
  const arms = [], cups = [];
  const arm = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0.06, -0.02, 0), new THREE.Vector3(0.36, -0.2, 0), new THREE.Vector3(0.46, 0.04, 0));
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    arms.push(T(new THREE.TubeGeometry(arm, PHONE ? 6 : 8, 0.011, 4, false), 0, 0, 0, a));
    cups.push(T(lathe([[0.001, 0], [0.028, 0], [0.04, 0.035], [0.001, 0.035]], 6), Math.cos(a) * 0.46, 0.04, -Math.sin(a) * 0.46));
  }
  void q;
  return merge([stem, ringA, ringB, ...arms, ...cups]);
}
function frond() {   // one arching palm frond along +x: a V-folded strip that widens then tapers, 8 segments
  const n = PHONE ? 6 : 8, L = 1.55, pos = [], idx = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, x = L * t, y = 0.42 * t - 0.75 * t * t, w = 0.3 * Math.sin(Math.PI * Math.min(1, t * 1.05)) * (1 - 0.35 * t) + 0.01;
    pos.push(x, y - w * 0.12, -w, x, y + w * 0.18, 0, x, y - w * 0.12, w);
  }
  for (let i = 0; i < n; i++) { const a = i * 3; idx.push(a, a + 3, a + 1, a + 1, a + 3, a + 4, a + 1, a + 4, a + 2, a + 2, a + 4, a + 5); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((n + 1) * 6), 2));
  return g;
}

const GEO = new Map();   // part@quality → geometry
function partGeo(key) {
  const k = key + (PHONE ? '@p' : '@d');
  let g = GEO.get(k);
  if (!g) { g = PARTS[key][1](); g.userData.shared = true; g.computeBoundingSphere(); GEO.set(k, g); }
  return g;
}
/** Triangles of one part (tests and budgets). */
export function partTris(key, phone = PHONE) { const was = PHONE; PHONE = phone; const g = partGeo(key); PHONE = was; return (g.index ? g.index.count : g.attributes.position.count) / 3; }

// ------------------------------------------------------------------------------------------------ props (lists of parts)
const chipStack = (out, x, y, z, n, col) => out.push(['chip', M4(x, y + n * 0.0018, z, 0, 1, n * 0.0036, 1), col]);
function chipsAround(out, pts, y, seed) { let s = seed; for (const [x, z] of pts) for (let k = 0; k < 2; k++) { s = (s * 9301 + 49297) % 233280; chipStack(out, x + k * 0.045, y, z, 4 + (s % 9), CHIP_COLS[(s >> 3) % CHIP_COLS.length]); } }
function pedestals(out, xs, z = 0) { for (const x of xs) out.push(['ped', M4(x, 0, z)], ['ped.foot', M4(x, 0, z)]); }
const pendant = (out, x, z) => out.push(['pend.shade', M4(x, 2.0, z)], ['pend.glow', M4(x, 2.0, z)]);

const RECIPES = {
  poker: () => { const o = [['poker.apron', M4()], ['poker.felt', M4()], ['poker.track', M4()], ['poker.inlay', M4()], ['poker.rail', M4()], ['print.poker', M4(0, 0.7585, -0.24)], ['tray', M4(0, 0.77, -0.47)]]; pedestals(o, [-0.55, 0.55]); pendant(o, 0, 0); chipsAround(o, [[-0.62, 0.3], [0.62, 0.3], [-0.82, -0.12], [0.82, -0.12]], 0.757, 3); chipsAround(o, [[-0.16, -0.47], [0.06, -0.47]], 0.783, 11); return o; },
  blackjack: (bac) => { const o = [['bj.apron', M4()], [bac ? 'bac.felt' : 'bj.felt', M4()], ['bj.rail', M4()], ['bj.pad', M4(0, 0.79, -0.36)], [bac ? 'print.bac' : 'print.bj', M4(0, 0.7585, 0.25)], ['tray', M4(0, 0.77, -0.2)], ['shoe', M4(0.45, 0.8, -0.2)]]; pedestals(o, [-0.6, 0.6], 0.15); pendant(o, 0, 0.2); chipsAround(o, [[-0.5, 0.42], [0, 0.55], [0.5, 0.42]], 0.757, bac ? 5 : 7); chipsAround(o, [[-0.18, -0.2], [0.02, -0.2]], 0.783, 13); return o; },
  roulette: () => { const wx = -0.73, o = [['roul.apron', M4()], ['roul.felt', M4()], ['roul.rail', M4()], ['print.roul', M4(0.42, 0.7585, 0)], ['wheel.bowl', M4(wx, 0, 0)], ['wheel.trim', M4(wx, 0, 0)], ['wheel.head', M4(wx, 0, 0)], ['wheel.turret', M4(wx, 0, 0)], ['ball', M4(wx + 0.27, 0.866, 0.1), 0xf8f8f0], ['dolly', M4(0.45, 0, 0.08)]]; pedestals(o, [-0.73, 0.73]); pendant(o, 0.2, 0); chipsAround(o, [[-0.1, -0.5], [0.15, -0.5], [0.4, -0.5]], 0.757, 17); return o; },
  slots: () => {
    const o = [['slot.plinth', M4(0, 0.03, 0)]];
    for (const dir of [1, -1]) for (const sx of [-1.1, 0, 1.1]) {
      const ry = dir === 1 ? 0 : Math.PI, z = dir * 0.45, base = M4(sx, 0.06, z, ry);
      for (const k of ['slot.cab', 'slot.trim', 'slot.screen', 'slot.marquee', 'slot.btn']) o.push([k, base]);
      o.push(['slot.knob', base, 0xd02028]);
      const st = M4(sx, 0, dir * 1.15, ry + Math.PI);   // the stool's back away from the machine
      o.push(['stool.metal', st], ['stool.seat', st]);
    }
    return o;
  },
  chair: () => [['chair.lea', M4()], ['chair.leg', M4()]],
  stool: () => [['stool.metal', M4()], ['stool.seat', M4()]],
  palm: () => {
    const q = Q(), o = [['palm.pot', M4()], ['palm.band', M4()], ['palm.trunk', M4()]], top = 0.47 + 12 * 0.16;
    for (let i = 0; i < q.fronds; i++) { const a = (i / q.fronds) * Math.PI * 2 + (i % 2) * 0.2, pitch = 0.15 + (i % 3) * 0.12; o.push(['palm.leaf', M4(0, top, 0, a, 1, 1, 1, 0, pitch)]); }
    for (let i = 0; i < 3; i++) o.push(['palm.leaf', M4(0, top + 0.02, 0, i * 2.1 + 0.5, 0.6, 0.6, 0.6, 0, 0.75)]);
    return o;
  },
  chandelier: () => {
    const q = Q(), o = [['ch.frame', M4()]];
    for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; o.push(['ch.bulb', M4(Math.cos(a) * 0.46, 0.1, -Math.sin(a) * 0.46)]); }
    for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2 + 0.4; o.push(['ch.bulb', M4(Math.cos(a) * 0.12, 0.62, -Math.sin(a) * 0.12, 0, 0.8)]); }
    const nA = Math.round(q.crystals * 0.5), nB = Math.round(q.crystals * 0.33), nC = q.crystals - nA - nB;
    for (let i = 0; i < nA; i++) { const a = (i / nA) * Math.PI * 2, d = i % 2 ? 0.07 : 0.11; o.push(['ch.crystal', M4(Math.cos(a) * 0.46, -0.02 - d, -Math.sin(a) * 0.46, a)]); }
    for (let i = 0; i < nB; i++) { const a = (i / nB) * Math.PI * 2 + 0.2; o.push(['ch.crystal', M4(Math.cos(a) * 0.28, 0.16, -Math.sin(a) * 0.28, a)]); }
    for (let i = 0; i < nC; i++) { const a = (i / nC) * Math.PI * 2, r = 0.06 + (i % 3) * 0.03; o.push(['ch.crystal', M4(Math.cos(a) * r, -0.3 - (i % 3) * 0.06, -Math.sin(a) * r, a, 1.2)]); }
    return o;
  },
  sconce: () => [['sc.metal', M4()], ['sc.glass', M4()]],
  lamp: () => [['lamp.base', M4()], ['lamp.shade', M4()]],
  column: () => [],   // built per height in dressCasinoRoom
};
const REC = new Map();
function recipe(name, arg) { const k = name + ':' + (arg ? 1 : 0) + (PHONE ? 'p' : 'd'); let r = REC.get(k); if (!r) { r = RECIPES[name](arg); REC.set(k, r); } return r; }
/** Triangles of a whole prop (tests). */
export function propTris(name, arg, phone = false) { const was = PHONE; PHONE = phone; let t = 0; for (const [key] of recipe(name, arg)) t += partTris(key, phone); PHONE = was; return t; }

// ------------------------------------------------------------------------------------------------ the zone batch
/**
 * One per zone: props go in as instances of shared parts, room shells (floors, walls, ceilings) as merged statics.
 * finish(group) adds ≤ 1 InstancedMesh per part and ≤ 1 Mesh per static material.
 */
export function casinoBatch(phone = false) {
  PHONE = !!phone;
  const inst = new Map(), stat = new Map(), base = new THREE.Matrix4(), w = new THREE.Matrix4();
  const put = (key, m, col) => { let p = inst.get(key); if (!p) { p = { ms: [], cs: [] }; inst.set(key, p); } p.ms.push(m.clone()); p.cs.push(col ?? null); };
  const B = {
    phone: PHONE, casino: false,
    /** Add a prop recipe at (x, y, z) turned ry (and scaled s). */
    prop(name, x, y, z, ry = 0, s = 1, arg) { base.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(0, ry, 0)), _s.set(s, s, s)); for (const [key, local, col] of recipe(name, arg)) put(key, w.multiplyMatrices(base, local), col); return B; },
    part(key, m, col) { put(key, m, col); return B; },
    static(matKey, geo) { let l = stat.get(matKey); if (!l) { l = []; stat.set(matKey, l); } l.push(geo); return B; },
    finish(group) {
      const out = [];
      for (const [key, p] of inst) {
        const mesh = new THREE.InstancedMesh(partGeo(key), casinoMat(PARTS[key][0]), p.ms.length);
        p.ms.forEach((m, i) => mesh.setMatrixAt(i, m));
        if (p.cs.some((c) => c != null)) { const c = new THREE.Color(); p.cs.forEach((v, i) => mesh.setColorAt(i, c.set(v ?? 0xffffff))); }
        mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere?.();
        mesh.castShadow = false; mesh.receiveShadow = false; mesh.matrixAutoUpdate = false; mesh.name = 'casino:' + key; mesh.userData.casinoPart = key;
        group.add(mesh); out.push(mesh);
      }
      for (const [matKey, list] of stat) {
        const g = merge(list); g.computeBoundingSphere();
        const mesh = new THREE.Mesh(g, casinoMat(matKey)); mesh.matrixAutoUpdate = false; mesh.name = 'casino:static:' + matKey; mesh.userData.casinoStatic = matKey;
        group.add(mesh); out.push(mesh);
      }
      inst.clear(); stat.clear();
      return out;
    },
  };
  return B;
}

// ------------------------------------------------------------------------------------------------ k2 items
const ITEM_RECIPE = { poker_table: ['poker'], blackjack: ['blackjack', false], baccarat_table: ['blackjack', true], roulette: ['roulette'], slot_island: ['slots'] };
/** Draw a casino / palm k2 item into the batch. Returns false when the item is not one of ours (drawn by the atlas). */
export function casinoItem(B, p, it) {
  const ry = p.rotY || 0;
  if (p.item === 'palm') { const h = p.h ?? it?.h ?? 3.4; B.prop('palm', p.x, p.y, p.z, ry, h / 3.4); return true; }
  if (p.item === 'bar_counter' || p.item === 'bar_island') { barProp(B, p, it); return true; }
  const r = ITEM_RECIPE[p.item]; if (!r) return false;
  B.casino = true;
  B.prop(r[0], p.x, p.y, p.z, ry, 1, r[1]);
  const c = Math.cos(ry), s = Math.sin(ry);
  if (it?.spots && p.item !== 'slot_island') for (const sp of it.spots) {
    if (!(sp[0] === 'sit' || (p.item === 'roulette' && sp[0] === 'stand'))) continue;
    const lx = sp[1], lz = sp[2];
    B.prop('chair', p.x + lx * c + lz * s, p.y, p.z - lx * s + lz * c, ry + Math.atan2(-lx, -lz), 0.95);
  }
  return true;
}
const BAR = new Map();
function barProp(B, p, it) {   // bars outside the casino do not pull the casino textures in: they keep the plain colours
  const w = +(p.w ?? it?.w ?? 4).toFixed(2), d = +(p.d ?? it?.d ?? 0.7).toFixed(2), h = +(p.h ?? it?.h ?? 1.1).toFixed(2), two = p.item === 'bar_island';
  const key = `bar:${w}:${d}:${h}:${two ? 2 : 1}:${PHONE ? 'p' : 'd'}`;
  if (!BAR.has(key)) {
    BAR.set(key, 1);
    PARTS[key + ':body'] = ['walnut', () => barBody(w, d, h, two)];
    PARTS[key + ':top'] = ['marble', () => barTop(w, d, h, two)];
    PARTS[key + ':brass'] = ['brass', () => barBrass(w, d, h, two)];
    PARTS[key + ':glow'] = ['light', () => merge((two ? [1, -1] : [1]).map((sd) => T(new THREE.BoxGeometry(w - 0.1, 0.012, 0.02), 0, h - 0.08, sd * (d / 2 + 0.045))))];
  }
  const ry = p.rotY || 0, base = M4(p.x, p.y, p.z, ry);
  for (const part of ['body', 'top', 'brass', 'glow']) B.part(`${key}:${part}`, base);
  const lamps = w > 4.4 ? [-w / 3, 0, w / 3] : [-w / 4, w / 4], lz = two ? 0 : -d / 4;
  for (const lx of lamps) B.part('lamp.base', base.clone().multiply(M4(lx, h, lz))).part('lamp.shade', base.clone().multiply(M4(lx, h, lz)));
  for (const sp of it?.spots || []) if (sp[0] === 'bar') { const m = base.clone().multiply(M4(sp[1], 0, sp[2], sp[3] || 0)); B.part('stool.metal', m).part('stool.seat', m); }
}
function barProfile(d, h, two) {   // cross-section (z, y): toe kick, a rolled front, the top's underside
  const s = new THREE.Shape(), f = d / 2;
  const front = (sd) => { const z = sd * f; return [[sd * (f - 0.07), 0], [sd * (f - 0.07), 0.1], [z, 0.13], [z + sd * 0.035, (h - 0.06) * 0.55], [z + sd * 0.01, h - 0.1], [z - sd * 0.01, h - 0.06]]; };
  const fr = front(1);
  const pts = two ? [...fr, ...front(-1).reverse()] : [[-f + 0.02, 0], ...fr, [-f + 0.02, h - 0.06]];
  pts.forEach(([z, y], i) => (i ? s.lineTo(z, y) : s.moveTo(z, y))); s.closePath();
  return s;
}
function alongX(shape, w, tile) {
  const g = new THREE.ExtrudeGeometry(shape, { depth: w, bevelEnabled: false, curveSegments: PHONE ? 4 : 8 });
  g.rotateY(-Math.PI / 2); g.translate(w / 2, 0, 0); return scaleUV(g, 1 / tile);
}
const barBody = (w, d, h, two) => alongX(barProfile(d, h, two), w, TILE.walnut);
function barTop(w, d, h, two) {
  const s = new THREE.Shape(), f = d / 2, y0 = h - 0.06, y1 = h;
  const nose = (sd) => [[sd * (f + 0.04), y0], [sd * (f + 0.075), y0 + 0.012], [sd * (f + 0.085), (y0 + y1) / 2], [sd * (f + 0.075), y1 - 0.01], [sd * (f + 0.04), y1]];
  const pts = [...nose(1), ...(two ? nose(-1).reverse() : [[-f - 0.02, y1], [-f - 0.02, y0]])];
  pts.forEach(([z, y], i) => (i ? s.lineTo(z, y) : s.moveTo(z, y))); s.closePath();
  return alongX(s, w + 0.1, TILE.marble);
}
function barBrass(w, d, h, two) {
  const gs = [];
  for (const sd of two ? [1, -1] : [1]) {
    const z = sd * (d / 2 + 0.13);
    gs.push(T(new THREE.CylinderGeometry(0.026, 0.026, w - 0.2, PHONE ? 8 : 12), 0, 0.2, z, 0, 1, 1, 1, 0, Math.PI / 2));
    const n = Math.max(2, Math.round(w / 1.2));
    for (let i = 0; i <= n; i++) { const x = -(w - 0.3) / 2 + (i * (w - 0.3)) / n; gs.push(T(new THREE.CylinderGeometry(0.012, 0.012, 0.12, 6), x, 0.2, sd * (d / 2 + 0.07), 0, 1, 1, 1, Math.PI / 2)); }
    gs.push(T(new THREE.BoxGeometry(w, 0.012, 0.012), 0, h - 0.065, sd * (d / 2 + 0.045)));
  }
  return merge(gs);
}

// ------------------------------------------------------------------------------------------------ the room
/** Floor, coffered ceiling with downlights, marble columns and chandeliers of a casino room. */
export function dressCasinoRoom(B, r, floorRects) {
  B.casino = true;
  const W = r.x1 - r.x0, D = r.z1 - r.z0, cy = r.y + r.h;
  for (const q of floorRects || [r]) {   // carpet, 1 repeat per 2.6 m
    const fw = q.x1 - q.x0, fd = q.z1 - q.z0; if (fw < 0.05 || fd < 0.05) continue;
    const g = new THREE.PlaneGeometry(fw, fd); g.rotateX(-Math.PI / 2); scaleUV(g, fw / TILE.carpet, fd / TILE.carpet); g.translate((q.x0 + q.x1) / 2, r.y + 0.003, (q.z0 + q.z1) / 2);
    B.static('carpet', g);
  }
  if (r.ceiling !== false) coffered(B, r, cy);
  // marble columns with brass base and capital
  const ch = r.h - 0.2 - 0.17 - 0.2;
  const cols = [[r.x0 + 1.2, r.z0 + 1.2], [r.x1 - 1.2, r.z0 + 1.2], [r.x0 + 1.2, r.z1 - 1.2], [r.x1 - 1.2, r.z1 - 1.2], [(r.x0 + r.x1) / 2, r.z0 + 1.2], [(r.x0 + r.x1) / 2, r.z1 - 1.2]];
  if (W > 5 && D > 5) for (const [x, z] of cols) { B.part('col.base', M4(x, r.y, z)).part('col.shaft', M4(x, r.y + 0.17 + ch / 2, z, 0, 1, ch, 1)).part('col.cap', M4(x, r.y + 0.17 + ch, z)); }
}
function coffered(B, r, cy) {
  const W = r.x1 - r.x0, D = r.z1 - r.z0, bw = 0.22, bd = 0.2;
  const nx = Math.max(2, Math.round(W / 3.2)), nz = Math.max(2, Math.round(D / 3.2)), cw = W / nx, cd = D / nz;
  // the panels (one plane: the recess) and the beam grid in walnut, brass beading, a warm cove glow along each beam
  const pl = new THREE.PlaneGeometry(W, D); pl.rotateX(Math.PI / 2); pl.translate((r.x0 + r.x1) / 2, cy, (r.z0 + r.z1) / 2); B.static('coffer', pl);
  const wal = [], brass = [], glow = [];
  for (let i = 0; i <= nx; i++) {
    const x = r.x0 + i * cw, edge = i === 0 || i === nx, bwi = edge ? bw * 1.6 : bw, xc = i === 0 ? x + bwi / 2 : i === nx ? x - bwi / 2 : x;
    wal.push(T(box(bwi, bd, D, TILE.walnut), xc, cy - bd / 2, (r.z0 + r.z1) / 2));
    for (const sd of [-1, 1]) { if ((i === 0 && sd < 0) || (i === nx && sd > 0)) continue; brass.push(T(new THREE.BoxGeometry(0.025, 0.025, D), xc + sd * (bwi / 2 + 0.01), cy - bd + 0.012, (r.z0 + r.z1) / 2)); glow.push(T(new THREE.BoxGeometry(0.012, 0.03, D - 0.1), xc + sd * (bwi / 2 + 0.006), cy - 0.035, (r.z0 + r.z1) / 2)); }
  }
  for (let j = 0; j <= nz; j++) {
    const z = r.z0 + j * cd, edge = j === 0 || j === nz, bwj = edge ? bw * 1.6 : bw, zc = j === 0 ? z + bwj / 2 : j === nz ? z - bwj / 2 : z;
    wal.push(T(box(W, bd - 0.01, bwj, TILE.walnut), (r.x0 + r.x1) / 2, cy - bd / 2 + 0.005, zc));
    for (const sd of [-1, 1]) { if ((j === 0 && sd < 0) || (j === nz && sd > 0)) continue; brass.push(T(new THREE.BoxGeometry(W, 0.025, 0.025), (r.x0 + r.x1) / 2, cy - bd + 0.014, zc + sd * (bwj / 2 + 0.01))); glow.push(T(new THREE.BoxGeometry(W - 0.1, 0.03, 0.012), (r.x0 + r.x1) / 2, cy - 0.036, zc + sd * (bwj / 2 + 0.006))); }
  }
  B.static('walnut', merge(wal)); B.static('brass', merge(brass)); B.static('glow', merge(glow));
  // downlights at each coffer's quarter points; chandeliers in every other coffer (the centre one at least)
  const hang = Math.min(1.0, Math.max(0.55, r.h - 2.6));
  let chandeliers = 0;
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
    const x0 = r.x0 + i * cw, z0 = r.z0 + j * cd;
    for (const fx of [0.3, 0.7]) for (const fz of [0.3, 0.7]) { const m = M4(x0 + cw * fx, cy - 0.003, z0 + cd * fz); B.part('dl.trim', m).part('dl.glow', m); }
    if (i % 2 === 1 && j % 2 === 1 && i < nx && j < nz) { B.prop('chandelier', x0 + cw / 2, cy - hang, z0 + cd / 2); chandeliers++; }
  }
  if (!chandeliers) B.prop('chandelier', (r.x0 + r.x1) / 2, cy - hang, (r.z0 + r.z1) / 2);
}

/**
 * One wall of a casino room: walnut wainscot with raised panels and brass beading, a brass chair rail, damask above,
 * brass crown, sconces. `ops` are the wall's openings (doors, windows: {from, to, bottom, top} along the wall's axis),
 * which stay open.
 */
export function dressCasinoWall(B, r, side, c, from, to, wallTop, ops = []) {
  B.casino = true;
  const wh = wallTop - r.y, wainH = Math.min(1.1, wh * 0.4), mid = (from + to) / 2, len = Math.abs(to - from);
  const sgn = { n: 1, s: -1, w: -1, e: 1 }[side], ry = { n: 0, s: Math.PI, w: Math.PI / 2, e: -Math.PI / 2 }[side];
  const off = side === 'n' || side === 'w' ? 0.01 : -0.01;
  const wm = side === 'n' || side === 's' ? M4(mid, 0, c + off, ry) : M4(c + off, 0, mid, ry);
  const holes = (ops || []).map((o) => { const a = sgn * (o.from - mid), b = sgn * (o.to - mid); return { a: Math.min(a, b) - 0.05, b: Math.max(a, b) + 0.05, bot: o.bottom ?? 0, top: o.top ?? wh }; }).sort((p, q) => p.a - q.a);
  // free intervals along the wall
  const free = []; let x = -len / 2;
  for (const h of holes) { if (h.a > x) free.push([x, Math.min(h.a, len / 2)]); x = Math.max(x, h.b); }
  if (x < len / 2) free.push([x, len / 2]);
  const wal = [], brass = [], dam = [];
  const plane = (x0, x1, y0, y1, tile, list) => { const w = x1 - x0, h = y1 - y0; if (w < 0.02 || h < 0.02) return; const g = new THREE.PlaneGeometry(w, h); scaleUV(g, w / tile, h / tile); g.translate((x0 + x1) / 2, r.y + (y0 + y1) / 2, 0); list.push(g); };
  for (const [a, b] of free) {
    plane(a, b, 0, wainH, TILE.walnut, wal);
    plane(a, b, wainH, wh, TILE.damask, dam);
    const n = Math.max(1, Math.floor((b - a) / 1.6)), pw = (b - a) / n;
    for (let i = 0; i < n; i++) {   // raised panels, brass beading
      const cx = a + (i + 0.5) * pw, w = pw - 0.26, h = wainH - 0.3; if (w < 0.2) continue;
      wal.push(T(box(w, h, 0.02, TILE.walnut), cx, r.y + 0.12 + h / 2 + 0.03, 0.012));
      for (const [bx, by, bw, bh] of [[cx, r.y + 0.15, w + 0.03, 0.014], [cx, r.y + 0.15 + h, w + 0.03, 0.014], [cx - w / 2 - 0.008, r.y + 0.15 + h / 2, 0.014, h], [cx + w / 2 + 0.008, r.y + 0.15 + h / 2, 0.014, h]]) brass.push(T(new THREE.BoxGeometry(bw, bh, 0.018), bx, by, 0.02));
    }
    brass.push(T(new THREE.BoxGeometry(b - a, 0.06, 0.05), (a + b) / 2, r.y + wainH, 0.022));   // chair rail
    brass.push(T(new THREE.BoxGeometry(b - a, 0.07, 0.06), (a + b) / 2, r.y + wh - 0.035, 0.028));   // crown
    wal.push(T(box(b - a, 0.12, 0.03, TILE.walnut), (a + b) / 2, r.y + 0.06, 0.015));   // skirting
    const ns = Math.max(0, Math.floor((b - a) / 4.2));
    for (let s = 0; s < ns; s++) { const sx = a + (s + 0.5) * ((b - a) / ns); const m = wm.clone().multiply(M4(sx, r.y + wainH + 0.6, 0.02)); B.part('sc.metal', m).part('sc.glass', m); }
  }
  for (const h of holes) {   // above (and below a window) each opening
    plane(h.a, h.b, Math.max(h.top, wainH), wh, TILE.damask, dam);
    if (h.top < wainH) plane(h.a, h.b, h.top, wainH, TILE.walnut, wal);
    if (h.bot > 0.05) { plane(h.a, h.b, 0, Math.min(h.bot, wainH), TILE.walnut, wal); if (h.bot > wainH) plane(h.a, h.b, wainH, h.bot, TILE.damask, dam); }
    brass.push(T(new THREE.BoxGeometry(h.b - h.a, 0.07, 0.06), (h.a + h.b) / 2, r.y + wh - 0.035, 0.028));
  }
  for (const [list, key] of [[wal, 'walnut'], [dam, 'damask'], [brass, 'brass']]) if (list.length) { const g = merge(list); g.applyMatrix4(wm); B.static(key, g); }
}

// ------------------------------------------------------------------------------------------------ lifecycle
/** A warm abstract casino room rendered into a small PMREM (cube 256): the casino materials' reflections and ambient. */
function buildEnv(renderer) {
  const scene = new THREE.Scene();
  const bm = (c, k = 1) => { const m = new THREE.MeshBasicMaterial({ side: THREE.BackSide }); m.color.set(c).multiplyScalar(k); return m; };
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const room = new THREE.Mesh(geo, bm(0x2a0c0a, 0.9)); room.scale.set(24, 4.4, 24); room.position.y = 1.0; scene.add(room);
  const floor = new THREE.Mesh(geo, bm(0x3a0810, 0.8)); floor.scale.set(23.8, 0.05, 23.8); floor.position.y = -1.15; scene.add(floor);
  const panelM = new THREE.MeshBasicMaterial(); panelM.color.set(0xffd9a8).multiplyScalar(9);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) { const p = new THREE.Mesh(geo, panelM); p.scale.set(2.2, 0.05, 2.2); p.position.set(i * 6, 3.15, j * 6); scene.add(p); }
  const wallM = new THREE.MeshBasicMaterial(); wallM.color.set(0xffb070).multiplyScalar(2.5);
  for (let k = 0; k < 4; k++) { const s = new THREE.Mesh(geo, wallM); const a = (k * Math.PI) / 2; s.scale.set(k % 2 ? 0.05 : 14, 0.3, k % 2 ? 14 : 0.05); s.position.set(Math.sin(a) * 11.9, 1.0, Math.cos(a) * 11.9); scene.add(s); }
  const goldM = new THREE.MeshBasicMaterial(); goldM.color.set(0xc89a40).multiplyScalar(0.6);
  for (let k = 0; k < 6; k++) { const g = new THREE.Mesh(geo, goldM); g.scale.set(1.6, 1.6, 1.0); g.position.set(-8 + k * 3.2, -0.2, (k % 2 ? 1 : -1) * 7); scene.add(g); }
  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromScene(scene, 0.035, 0.1, 40);
  pm.dispose();
  scene.traverse((o) => { if (o.material) o.material.dispose(); }); geo.dispose();
  return rt;
}
function setEnv(rt) { envRT = rt; for (const m of MAT.values()) if (m.envMapIntensity !== undefined) m.envMap = rt ? rt.texture : null; }

/**
 * Get the casino ready without blocking: textures start decoding in the background (shown as they land), the room's
 * environment is rendered (one small PMREM). Safe to call often; cheap after the first call. opts: { renderer, phone }.
 */
export function prepareCasino(opts = {}) {
  idle = 0;
  if (opts.phone !== undefined) PHONE = !!opts.phone;
  if (opts.renderer) setTexRenderer(opts.renderer);
  if (state === 'ready') { if (!envRT && opts.renderer) tryEnv(opts.renderer); return false; }
  state = 'ready';
  for (const k of ['felt', 'feltRed', 'leather', 'leatherDark', 'walnut', 'marble', 'carpet']) casinoMat(k);
  const full = PHONE ? 512 : 1024;
  for (const [m, slot, file, kind, small, onLoad, onUnload, rep] of TEXDEFS) bindTex('casino', m, slot, FILES[file], { size: small ? full / 2 : full, srgb: kind === 'color', kind, repeat: rep, aniso: PHONE ? 2 : 4, onLoad, onUnload });
  for (const n of CANVAS.keys()) { const t = CANVAS.get(n); noteBytes('canvas:' + n, texBytes(t.image?.width || 1, t.image?.height || 1)); }
  if (opts.renderer) tryEnv(opts.renderer);
  loadGroup('casino');
  const p = texPlan('casino');
  if (typeof window !== 'undefined') console.info(`[casino] textures ${p.n}, ~${p.mb.toFixed(1)} MB planned (${PHONE ? 'phone' : 'desktop'}; loading in the background)`);
  return true;
}
function tryEnv(renderer) {
  if (envRT || !renderer?.capabilities) return;
  try { const rt = buildEnv(renderer); setEnv(rt); noteBytes('env', rt.width * rt.height * (rt.texture.type === THREE.HalfFloatType ? 8 : 4)); } catch (e) { console.warn('[casino] env', e); }
}

/** Compile the zone's casino programs off the critical path (renderer.compileAsync, three r158+). */
export function warmCasino(app, group) {
  const R = app?.renderer, cam = app?.camera;
  if (!R?.compileAsync || !cam || !group) return null;
  try { return R.compileAsync(group, cam, app.scene || null).catch(() => null); } catch { return null; }
}

/** Give the casino's GPU memory back: textures, canvases, environment, part buffers. Materials stay (plain colours). */
export function releaseCasino() {
  if (state !== 'ready') return false;
  state = 'cold';
  const freed = releaseGroup('casino');
  for (const [n, t] of CANVAS) { t.dispose(); noteBytes('canvas:' + n, null); }
  if (envRT) { envRT.dispose(); setEnv(null); noteBytes('env', null); }
  for (const [k, g] of GEO) if (!k.startsWith('palm.')) g.dispose();
  if (typeof window !== 'undefined') console.info(`[casino] released (${freed} textures freed)`);
  return true;
}
/** Per frame: the casino is in sight (prepare) or has been away for RELEASE_AFTER s (release). */
export function casinoTick(visible, dt, app, phone) {
  if (visible) { idle = 0; if (state !== 'ready' || !envRT) prepareCasino({ renderer: app?.renderer, phone }); return; }
  if (state !== 'ready') return;
  idle += dt;
  if (idle > RELEASE_AFTER) releaseCasino();
}
export function casinoState() { return { state, env: !!envRT, phone: PHONE, materials: MAT.size, parts: GEO.size }; }
/** GPU bytes of the room environment (PMREM of a 256 cube: 768 × 1024 half-float RGBA). */
export const CASINO_ENV_BYTES = 3 * 256 * 4 * 256 * 8;
/** Tests: forget every cached material, canvas, part and recipe (e.g. to build the phone quality after the desktop one). */
export function _casinoReset() {
  releaseCasino();
  for (const m of MAT.values()) m.dispose(); MAT.clear(); TEXDEFS.length = 0;
  for (const [n, t] of CANVAS) { t.dispose(); noteBytes('canvas:' + n, null); } CANVAS.clear();
  for (const g of GEO.values()) g.dispose(); GEO.clear(); REC.clear();
  state = 'cold'; idle = 0;
}
export { logBudget as casinoBudgetLog };
