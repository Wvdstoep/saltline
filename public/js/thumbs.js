// Ship images and harbour banners for the UI (docs/V4-CONTRACTS.md §2).
//
// shipThumb(cls, {w, h, angle, wear}) renders the real in-game model (`buildShip` from ship.js) with ONE shared
// offscreen WebGLRenderer (alpha + preserveDrawingBuffer), studio lighting and a soft gradient water disc, frames the
// camera to the hull's projected bounds, and returns a data URL. Results are cached in memory and in sessionStorage
// (webp where the browser can encode it, png otherwise). Renders are queued and done ONE per animation frame, so opening
// the shipyard never stalls the 3D view. Any failure (no WebGL, context lost) resolves to null and the UI keeps its
// icon placeholder.
//
// harborBanner(harbor) draws a stylised harbour skyline on a 2D canvas from the harbour's name / size / country (seeded,
// deterministic, no network) and returns a JPEG data URL.
import * as THREE from 'three';
import { buildShip } from './ship.js';

const VERSION = 'v5.0';   // SHIPYARD H9b: key includes variant + livery
const SS_PREFIX = 'saltline.thumb.';
const ANGLES = {
  // direction FROM the ship TO the camera, ship frame (forward = -z, starboard = +x, up = +y)
  quarter: { az: 38, el: 17 },  // bow quarter, starboard side: the classic brochure shot
  side: { az: 88, el: 9 },      // broadside
  hero: { az: 32, el: 7 },      // low and dramatic (welcome screen)
  stern: { az: 145, el: 16 },
  top: { az: 60, el: 62 },
};
const FOV = 28;

const mem = new Map();       // key -> dataURL
const pending = new Map();   // key -> job
const queue = [];
let raf = 0;
let R = null;                // { renderer, scene, camera, water, lights } (lazy)
let broken = false;          // WebGL unavailable: stop trying for this session

function keyOf(cls, w, h, angle, wear, scale, livery = null) { return `${VERSION}|${cls}|${w}x${h}@${scale}|${angle}|${wear.toFixed(1)}|${livery ? [livery.hull, livery.house, livery.funnel, livery.band ?? '-', livery.mark ?? '-'].join('.') : 'd'}`; }
function normOpts(opts = {}) {
  const w = Math.max(16, Math.min(1600, Math.round(Number(opts.w) || 320)));
  const h = Math.max(16, Math.min(1200, Math.round(Number(opts.h) || 200)));
  const angle = ANGLES[opts.angle] ? opts.angle : 'quarter';
  const wear = Math.max(0, Math.min(1, Math.round((Number(opts.wear) || 0) * 10) / 10));
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const scale = Math.max(1, Math.min(2, Math.round(dpr * 2) / 2));
  return { w, h, angle, wear, scale, livery: opts.livery || null };
}
function ssGet(key) { try { return sessionStorage.getItem(SS_PREFIX + key); } catch { return null; } }
function ssSet(key, url) {
  try { sessionStorage.setItem(SS_PREFIX + key, url); return; } catch { /* quota: drop older thumbs once and retry */ }
  try {
    const old = []; for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); if (k && k.startsWith(SS_PREFIX)) old.push(k); }
    for (const k of old.slice(0, Math.ceil(old.length / 2))) sessionStorage.removeItem(k);
    sessionStorage.setItem(SS_PREFIX + key, url);
  } catch { /* storage unavailable: memory cache only */ }
}

/** Synchronous cache lookup (memory, then sessionStorage); null when the thumb has not been rendered yet. */
export function cachedThumb(cls, opts = {}) {
  const o = normOpts(opts), key = keyOf(cls, o.w, o.h, o.angle, o.wear, o.scale, o.livery);
  let url = mem.get(key);
  if (!url) { url = ssGet(key); if (url) mem.set(key, url); }
  return url || null;
}

/**
 * Render (or fetch from cache) an image of a ship class.
 * @param {string} cls  SHIP_CLASSES id (or cutter / lifeboat / derelict)
 * @param {{w?: number, h?: number, angle?: 'quarter'|'side'|'hero'|'stern'|'top', wear?: number, priority?: boolean}} opts
 * @returns {Promise<string|null>} data URL
 */
export async function shipThumb(cls, opts = {}) {
  if (!cls || typeof document === 'undefined') return null;
  const o = normOpts(opts), key = keyOf(cls, o.w, o.h, o.angle, o.wear, o.scale, o.livery);
  const hit = cachedThumb(cls, opts); if (hit) return hit;
  if (broken) return null;
  let job = pending.get(key);
  if (!job) {
    job = { key, cls, ...o };
    job.promise = new Promise((res) => { job.resolve = res; });
    pending.set(key, job);
    if (opts.priority) queue.unshift(job); else queue.push(job);
    schedule();
  } else if (opts.priority) { const i = queue.indexOf(job); if (i > 0) { queue.splice(i, 1); queue.unshift(job); } }
  return job.promise;
}

function schedule() {
  if (raf || !queue.length) return;
  const run = () => { raf = 0; pump(); };
  // requestAnimationFrame pauses in background tabs; a timer fallback keeps the queue draining there
  raf = typeof requestAnimationFrame === 'function' && !document.hidden ? requestAnimationFrame(run) : setTimeout(run, 50);
}
function pump() {
  const job = queue.shift(); if (!job) return;
  let url = null;
  try { url = renderShip(job); } catch (e) { console.warn('[thumbs] render failed', job.cls, e); }
  if (url) { mem.set(job.key, url); ssSet(job.key, url); }
  pending.delete(job.key);
  job.resolve(url);
  if (broken) { for (const j of queue.splice(0)) { pending.delete(j.key); j.resolve(null); } return; }
  schedule();
}

// ------------------------------------------------------------------------------------------------ the offscreen studio
function studio() {
  if (R) return R;
  if (broken) return null;
  let renderer;
  try {
    const canvas = document.createElement('canvas');
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true, powerPreference: 'low-power' });
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); R = null; });
  } catch (e) { console.warn('[thumbs] no WebGL for ship images', e); broken = true; return null; }
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.08;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1.6, 0.1, 5000);
  scene.add(new THREE.HemisphereLight(0xdcecff, 0x223548, 1.25));
  const key = new THREE.DirectionalLight(0xfff0d8, 2.6); scene.add(key); scene.add(key.target);
  const rim = new THREE.DirectionalLight(0x9cc9ff, 1.4); scene.add(rim); scene.add(rim.target);
  const fill = new THREE.DirectionalLight(0xffffff, 0.45); scene.add(fill); scene.add(fill.target);
  // gradient water disc: opaque teal under the hull, fading to transparent at the rim, with a soft highlight band
  const water = new THREE.Mesh(new THREE.CircleGeometry(1, 64), new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uDeep: { value: new THREE.Color(0x0b3a58) }, uShallow: { value: new THREE.Color(0x2a7fa8) }, uHi: { value: new THREE.Color(0xbfe6ff) } },
    vertexShader: 'varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 uDeep; uniform vec3 uShallow; uniform vec3 uHi; varying vec2 vP;
      void main(){
        float r = length(vP);
        vec3 c = mix(uShallow, uDeep, smoothstep(0.0, 0.9, r));
        float ripple = 0.5 + 0.5 * sin(vP.y * 90.0 + sin(vP.x * 23.0) * 2.0);
        c = mix(c, uHi, 0.10 * ripple * (1.0 - smoothstep(0.1, 0.8, r)));
        float a = (1.0 - smoothstep(0.38, 1.0, r)) * 0.94;
        gl_FragColor = vec4(c, a);
        #include <colorspace_fragment>
      }`,
  }));
  water.rotation.x = -Math.PI / 2; water.renderOrder = 1;
  scene.add(water);
  R = { renderer, scene, camera, water, key, rim, fill };
  return R;
}

const _box = new THREE.Box3(), _bb = new THREE.Box3(), _v = new THREE.Vector3();
/** World-space bounds of the visible meshes above (roughly) the waterline. Sprites (labels) and wake strips excluded. */
function shipBounds(g) {
  _box.makeEmpty();
  g.updateMatrixWorld(true);
  g.traverse((o) => {
    if (!o.isMesh || !o.geometry || o.isSprite) return;
    let p = o, vis = true; while (p) { if (!p.visible) { vis = false; break; } p = p.parent; }
    if (!vis) return;
    const m = o.material; if (m && (m.isShaderMaterial || m.transparent && m.opacity < 0.3)) return; // foam strips etc.
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    _bb.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
    _box.union(_bb);
  });
  if (_box.isEmpty()) _box.set(new THREE.Vector3(-5, 0, -20), new THREE.Vector3(5, 10, 20));
  _box.min.y = Math.max(_box.min.y, -0.4);
  return _box.clone();
}

function renderShip(job) {
  const S = studio(); if (!S) return null;
  const { renderer, scene, camera, water, key, rim, fill } = S;
  const pw = Math.round(job.w * job.scale), ph = Math.round(job.h * job.scale);
  renderer.setSize(pw, ph, false);
  camera.aspect = job.w / job.h;
  let ship;
  try { ship = buildShip(job.cls, null, 7, { livery: job.livery }); } catch (e) { console.warn('[thumbs] buildShip failed', job.cls, e); return null; }
  try {
    ship.userData.setWear?.(job.wear);
    ship.userData.setWaterY?.(0);
    ship.userData.setLights?.(0);
    ship.userData.setWake?.(0);
    if (ship.userData.isSail) ship.userData.setSails?.(true, 62); // close reach: sails drawn in, seen broad from the quarter
    scene.add(ship);
    const box = shipBounds(ship);
    const size = box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.z, size.y, 4);
    water.scale.setScalar(span * 1.25);
    water.position.set((box.min.x + box.max.x) / 2, 0.02, (box.min.z + box.max.z) / 2);
    // camera direction from the angle preset
    const A = ANGLES[job.angle] || ANGLES.quarter;
    // tall rigs (masts higher than ~0.8 × the hull length) are turned towards broadside so the hull is not a sliver
    const tall = size.y > 0.8 * Math.max(size.z, size.x);
    const azDeg = tall && (job.angle === 'quarter' || job.angle === 'hero') ? Math.max(A.az, 66) : A.az;
    const az = (azDeg * Math.PI) / 180, el = (A.el * Math.PI) / 180;
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
    const target = box.getCenter(new THREE.Vector3());
    let d = span * 2.2;
    const corners = [];
    for (let i = 0; i < 8; i++) corners.push(new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z));
    const right = new THREE.Vector3(), up = new THREE.Vector3();
    const tanH = Math.tan(((FOV / 2) * Math.PI) / 180);
    const FILL_X = 0.86, FILL_Y = 0.78;
    // fit: project the bounding box, recentre on its projection and scale the distance
    for (let pass = 0; pass < 8; pass++) {
      camera.position.copy(target).addScaledVector(dir, d);
      camera.near = Math.max(0.05, d / 200); camera.far = d * 20;
      camera.lookAt(target); camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const c of corners) { _v.copy(c).project(camera); x0 = Math.min(x0, _v.x); x1 = Math.max(x1, _v.x); y0 = Math.min(y0, _v.y); y1 = Math.max(y1, _v.y); }
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, ex = (x1 - x0) / 2, ey = (y1 - y0) / 2;
      right.setFromMatrixColumn(camera.matrixWorld, 0); up.setFromMatrixColumn(camera.matrixWorld, 1);
      target.addScaledVector(right, cx * d * tanH * camera.aspect).addScaledVector(up, cy * d * tanH);
      const k = Math.max(ex / FILL_X, ey / FILL_Y, 0.05);
      d *= pass < 6 ? 0.15 + 0.85 * k : k; // lightly damped: perspective makes the relation slightly non-linear
    }
    camera.position.copy(target).addScaledVector(dir, d);
    camera.lookAt(target); camera.updateMatrixWorld(true);
    // lights follow the camera: key from upper left-front, rim from behind, fill from the right
    const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
    key.position.copy(target).addScaledVector(dir, span).addScaledVector(side, span * 0.9).add(new THREE.Vector3(0, span * 1.2, 0)); key.target.position.copy(target);
    rim.position.copy(target).addScaledVector(dir, -span * 1.5).add(new THREE.Vector3(0, span * 0.8, 0)); rim.target.position.copy(target);
    fill.position.copy(target).addScaledVector(side, -span).add(new THREE.Vector3(0, span * 0.3, 0)); fill.target.position.copy(target);
    renderer.render(scene, camera);
    let url = renderer.domElement.toDataURL('image/webp', 0.9);
    if (!url.startsWith('data:image/webp')) url = renderer.domElement.toDataURL('image/png');
    return url;
  } finally {
    scene.remove(ship);
    try { ship.userData.dispose?.(); } catch { /* already gone */ }
  }
}

/** Warm the cache for a list of classes (low priority, still one per frame). */
export function prefetchThumbs(classes, opts = {}) { for (const c of classes || []) if (!cachedThumb(c, opts)) shipThumb(c, opts); }

// ------------------------------------------------------------------------------------------------ harbour banner
const banners = new Map();
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) { let s = (seed >>> 0) || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
const PALETTES = [
  { name: 'dusk', sky: ['#132743', '#3d4a7a', '#c0607a', '#f2a65a'], sun: '#ffd28a', sea: ['#1b2f4d', '#0a1626'], hills: '#2a3354', glow: 'rgba(255,170,100,0.55)', lit: 0.65 },
  { name: 'day', sky: ['#2c6eb5', '#5b9ad6', '#9cc6ea', '#d6e9f6'], sun: '#fff6d8', sea: ['#2a6a94', '#0d3354'], hills: '#5a7c8f', glow: 'rgba(255,255,230,0.35)', lit: 0.05 },
  { name: 'morning', sky: ['#3b5f8c', '#7f9cc4', '#e9b9a0', '#f7dcb0'], sun: '#fff0c8', sea: ['#3a5f80', '#122a44'], hills: '#56647e', glow: 'rgba(255,220,170,0.45)', lit: 0.25 },
  { name: 'night', sky: ['#050b18', '#0b1830', '#1b2c4c', '#2b3f60'], sun: '#e8eefc', sea: ['#0b1a2e', '#03080f'], hills: '#0f1a2c', glow: 'rgba(160,190,255,0.25)', lit: 0.95 },
  { name: 'overcast', sky: ['#4b5a6a', '#6d7c8b', '#97a3ad', '#c3cbd1'], sun: '#f4f4f0', sea: ['#3f5363', '#1a2834'], hills: '#5b6670', glow: 'rgba(255,255,255,0.15)', lit: 0.2 },
];
const FLAT = new Set(['NL', 'BE', 'DK', 'DE', 'PL']);
const WINDY = new Set(['NL', 'DK', 'DE', 'GB', 'BE']);
const HILLY = new Set(['NO', 'IS', 'FO', 'HR', 'IT', 'GR', 'ES', 'PT', 'FR', 'TR', 'JP', 'CL', 'ZA', 'AU', 'NZ', 'CA']);

/**
 * Stylised banner for a harbour (skyline silhouette, cranes by port size, lighthouse, a ship at the quay).
 * @param {{id?: string, name?: string, size?: string, country?: string}} harbor
 * @param {{w?: number, h?: number}} opts
 * @returns {string|null} JPEG data URL
 */
export function harborBanner(harbor, opts = {}) {
  if (!harbor || typeof document === 'undefined') return null;
  const W = Math.max(320, Math.min(2000, Math.round(opts.w || 1200))), H = Math.max(120, Math.min(800, Math.round(opts.h || 340)));
  const key = `${harbor.id || harbor.name}|${harbor.size}|${W}x${H}`;
  if (banners.has(key)) return banners.get(key);
  let url = null;
  try { url = drawBanner(harbor, W, H); } catch (e) { console.warn('[thumbs] banner failed', e); }
  banners.set(key, url);
  return url;
}

function drawBanner(h, W, H) {
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d'); if (!g) return null;
  const seed = hashStr(String(h.id || h.name || 'harbour'));
  const r = rng(seed);
  const pal = PALETTES[seed % PALETTES.length];
  const size = h.size || 'regional';
  const sizeK = size === 'mega' ? 1 : size === 'major' ? 0.75 : size === 'regional' ? 0.5 : 0.3;
  const hy = Math.round(H * 0.64); // horizon / quay line
  // sky
  const sky = g.createLinearGradient(0, 0, 0, hy);
  pal.sky.forEach((c, i) => sky.addColorStop(i / (pal.sky.length - 1), c));
  g.fillStyle = sky; g.fillRect(0, 0, W, hy);
  // stars at night
  if (pal.name === 'night') { g.fillStyle = 'rgba(255,255,255,0.8)'; for (let i = 0; i < 90; i++) { const x = r() * W, y = r() * hy * 0.7, s = r() < 0.1 ? 1.6 : 0.9; g.fillRect(x, y, s, s); } }
  // sun / moon with glow
  const sx = W * (0.15 + r() * 0.7), sy = hy * (pal.name === 'day' ? 0.25 : 0.62);
  const glow = g.createRadialGradient(sx, sy, 0, sx, sy, H * 0.9);
  glow.addColorStop(0, pal.glow); glow.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = glow; g.fillRect(0, 0, W, hy);
  g.fillStyle = pal.sun; g.beginPath(); g.arc(sx, sy, H * 0.05, 0, Math.PI * 2); g.fill();
  // soft clouds
  g.globalAlpha = pal.name === 'overcast' ? 0.35 : 0.18; g.fillStyle = '#ffffff';
  for (let i = 0; i < 7; i++) { const cx = r() * W, cy = hy * (0.15 + r() * 0.45), cw = W * (0.1 + r() * 0.2); g.beginPath(); g.ellipse(cx, cy, cw, cw * 0.12, 0, 0, Math.PI * 2); g.fill(); }
  g.globalAlpha = 1;
  // distant hills
  const country = String(h.country || '').toUpperCase();
  const hillAmp = FLAT.has(country) ? 0.02 : HILLY.has(country) ? 0.2 : 0.08;
  g.fillStyle = pal.hills; g.beginPath(); g.moveTo(0, hy);
  const ph1 = r() * 6, ph2 = r() * 6;
  for (let x = 0; x <= W; x += 8) g.lineTo(x, hy - H * 0.06 - H * hillAmp * (0.5 + 0.5 * Math.sin(x / W * 5 + ph1) * Math.sin(x / W * 2.3 + ph2)));
  g.lineTo(W, hy); g.closePath(); g.fill();
  // wind turbines on flat North Sea coasts
  if (WINDY.has(country)) {
    g.strokeStyle = 'rgba(230,236,242,0.55)'; g.lineWidth = Math.max(1, H / 260);
    for (let i = 0; i < 6; i++) {
      const x = W * (0.55 + r() * 0.42), base = hy - H * 0.06, top = base - H * (0.14 + r() * 0.05), bl = H * 0.07, a = r() * Math.PI;
      g.beginPath(); g.moveTo(x, base); g.lineTo(x, top); for (let k = 0; k < 3; k++) { const aa = a + (k * Math.PI * 2) / 3; g.moveTo(x, top); g.lineTo(x + Math.cos(aa) * bl, top + Math.sin(aa) * bl); } g.stroke();
    }
  }
  // skyline: city blocks behind, port buildings in front
  const dark = '#0b1622', mid = '#13212f';
  const lit = pal.lit;
  const blocks = (x0, x1, minH, maxH, color, windows) => {
    let x = x0;
    while (x < x1) {
      const bw = W * (0.015 + r() * 0.035), bh = H * (minH + r() * (maxH - minH));
      g.fillStyle = color; g.fillRect(x, hy - bh, bw, bh);
      if (windows && lit > 0.1) {
        g.fillStyle = `rgba(255,214,140,${0.35 + 0.5 * lit})`;
        for (let wy = hy - bh + 4; wy < hy - 6; wy += Math.max(5, H / 55)) for (let wx = x + 3; wx < x + bw - 3; wx += Math.max(5, W / 280)) if (r() < 0.35 * lit + 0.05) g.fillRect(wx, wy, Math.max(1.5, W / 700), Math.max(1.5, H / 220));
      }
      x += bw + W * 0.002;
    }
  };
  const cityX0 = W * (0.05 + r() * 0.15), cityX1 = cityX0 + W * (0.2 + 0.25 * sizeK);
  blocks(cityX0, cityX1, 0.06, 0.12 + 0.2 * sizeK, mid, true);
  // church spire / tower for smaller towns
  if (sizeK <= 0.5) { const x = cityX0 + (cityX1 - cityX0) * 0.4; g.fillStyle = mid; g.fillRect(x, hy - H * 0.2, W * 0.01, H * 0.2); g.beginPath(); g.moveTo(x - W * 0.002, hy - H * 0.2); g.lineTo(x + W * 0.005, hy - H * 0.3); g.lineTo(x + W * 0.012, hy - H * 0.2); g.fill(); }
  // warehouses + tanks
  const portX0 = W * 0.3, portX1 = W * 0.95;
  let x = portX0;
  while (x < portX1) {
    const kind = r();
    if (kind < 0.3 && sizeK >= 0.5) { // storage tanks
      const n = 2 + Math.floor(r() * 3), rad = H * 0.035;
      for (let i = 0; i < n; i++) { const cx = x + rad + i * rad * 2.3; g.fillStyle = '#1a2a38'; g.fillRect(cx - rad, hy - rad * 1.6, rad * 2, rad * 1.6); g.beginPath(); g.ellipse(cx, hy - rad * 1.6, rad, rad * 0.3, 0, 0, Math.PI * 2); g.fill(); }
      x += n * rad * 2.3 + W * 0.01;
    } else {
      const bw = W * (0.04 + r() * 0.07), bh = H * (0.05 + r() * 0.06);
      g.fillStyle = dark; g.fillRect(x, hy - bh, bw, bh);
      g.beginPath(); g.moveTo(x, hy - bh); g.lineTo(x + bw / 2, hy - bh - H * 0.015); g.lineTo(x + bw, hy - bh); g.fill();
      if (lit > 0.3) { g.fillStyle = `rgba(255,200,120,${0.5 * lit})`; g.fillRect(x + bw * 0.1, hy - bh * 0.55, bw * 0.8, Math.max(1.5, H / 200)); }
      x += bw + W * 0.006;
    }
  }
  // ship-to-shore gantry cranes
  const nCranes = size === 'mega' ? 7 : size === 'major' ? 5 : size === 'regional' ? 3 : 1;
  const craneCol = ['#c0392b', '#2b6cb0', '#d68910', '#566573'][seed % 4];
  for (let i = 0; i < nCranes; i++) {
    const cx = W * (0.36 + (0.55 * (i + 0.5)) / nCranes) + (r() - 0.5) * W * 0.02;
    const ch = H * (0.26 + 0.08 * sizeK), leg = W * 0.012, boom = W * (0.05 + 0.03 * sizeK);
    g.strokeStyle = craneCol; g.lineWidth = Math.max(2, W / 500); g.lineCap = 'square';
    g.beginPath();
    g.moveTo(cx - leg, hy); g.lineTo(cx - leg, hy - ch * 0.75); g.moveTo(cx + leg, hy); g.lineTo(cx + leg, hy - ch * 0.75);
    g.moveTo(cx - leg, hy - ch * 0.4); g.lineTo(cx + leg, hy - ch * 0.4);
    g.moveTo(cx - leg * 2.2, hy - ch * 0.75); g.lineTo(cx + boom, hy - ch * 0.75); // boom over the water side
    g.moveTo(cx, hy - ch * 0.75); g.lineTo(cx, hy - ch); g.lineTo(cx + boom * 0.7, hy - ch * 0.75); g.moveTo(cx, hy - ch); g.lineTo(cx - leg * 2, hy - ch * 0.75);
    g.stroke();
    if (lit > 0.3) { g.fillStyle = '#ff4040'; g.fillRect(cx - 1.5, hy - ch - 3, 3, 3); }
  }
  // lighthouse on the breakwater head
  const lx = W * (r() < 0.5 ? 0.06 : 0.92), lh = H * 0.2;
  g.fillStyle = '#222c36'; g.fillRect(lx - W * 0.04, hy - H * 0.012, W * 0.08, H * 0.012);
  for (let i = 0; i < 4; i++) { g.fillStyle = i % 2 ? '#e8e8e8' : '#c62828'; const y0 = hy - H * 0.012 - (lh * (i + 1)) / 4; g.beginPath(); const tw0 = W * 0.009 * (1 - i * 0.12), tw1 = W * 0.009 * (1 - (i + 1) * 0.12); g.moveTo(lx - tw0, y0 + lh / 4); g.lineTo(lx + tw0, y0 + lh / 4); g.lineTo(lx + tw1, y0); g.lineTo(lx - tw1, y0); g.fill(); }
  g.fillStyle = pal.lit > 0.3 ? '#fff4c0' : '#9fb3c4'; g.fillRect(lx - W * 0.006, hy - H * 0.012 - lh - H * 0.03, W * 0.012, H * 0.03);
  if (pal.lit > 0.3) { const bg = g.createRadialGradient(lx, hy - lh - H * 0.03, 0, lx, hy - lh - H * 0.03, H * 0.25); bg.addColorStop(0, 'rgba(255,240,180,0.6)'); bg.addColorStop(1, 'rgba(255,240,180,0)'); g.fillStyle = bg; g.fillRect(lx - H * 0.25, hy - lh - H * 0.28, H * 0.5, H * 0.5); }
  // quay edge
  g.fillStyle = '#0a121b'; g.fillRect(0, hy - 2, W, H * 0.02);
  // sea with reflection
  const sea = g.createLinearGradient(0, hy, 0, H);
  sea.addColorStop(0, pal.sea[0]); sea.addColorStop(1, pal.sea[1]);
  g.fillStyle = sea; g.fillRect(0, hy + H * 0.018, W, H - hy);
  g.save(); g.globalAlpha = 0.22; g.translate(0, 2 * hy + H * 0.036); g.scale(1, -0.55); g.drawImage(cv, 0, 0, W, hy, 0, 0, W, hy); g.restore();
  // shimmer lines (the sun's glitter path + general ripples)
  for (let i = 0; i < 160; i++) {
    const y = hy + H * 0.03 + Math.pow(r(), 1.6) * (H - hy), near = (y - hy) / (H - hy);
    const sxx = r() < 0.55 ? sx + (r() - 0.5) * W * 0.12 * (0.3 + near) : r() * W;
    g.fillStyle = `rgba(255,255,255,${0.05 + 0.18 * (1 - near) * (r() < 0.55 ? 1.6 : 0.6)})`;
    g.fillRect(sxx, y, W * (0.01 + r() * 0.03) * (0.5 + near), Math.max(1, H / 300));
  }
  // a ship at the quay: container feeder for big ports, coaster otherwise
  const shipX = W * (0.42 + r() * 0.2), shipL = W * (0.16 + 0.12 * sizeK), shipH = H * 0.05, shipY = hy + H * 0.035;
  g.fillStyle = '#16212c';
  g.beginPath(); g.moveTo(shipX, shipY - shipH); g.lineTo(shipX + shipL, shipY - shipH); g.lineTo(shipX + shipL * 0.97, shipY); g.lineTo(shipX + shipL * 0.05, shipY); g.closePath(); g.fill();
  g.fillStyle = '#7a2a22'; g.fillRect(shipX + shipL * 0.04, shipY - shipH * 0.25, shipL * 0.92, shipH * 0.25);
  g.fillStyle = '#e8ecef'; g.fillRect(shipX + shipL * 0.04, shipY - shipH * 2.3, shipL * 0.12, shipH * 1.3);
  if (sizeK >= 0.5) {
    const cols = ['#c0392b', '#2980b9', '#27ae60', '#f39c12', '#8e44ad', '#7f8c8d'];
    const cw = shipL * 0.045;
    for (let cx = shipX + shipL * 0.2; cx < shipX + shipL * 0.9; cx += cw * 1.05) { const n = 1 + Math.floor(r() * 3); for (let k = 0; k < n; k++) { g.fillStyle = cols[Math.floor(r() * cols.length)]; g.fillRect(cx, shipY - shipH - (k + 1) * shipH * 0.45, cw, shipH * 0.43); } }
  } else { g.fillStyle = '#5c6168'; g.fillRect(shipX + shipL * 0.25, shipY - shipH * 1.35, shipL * 0.6, shipH * 0.35); }
  // vignette + bottom fade for overlaid text
  const vg = g.createLinearGradient(0, H * 0.45, 0, H);
  vg.addColorStop(0, 'rgba(4,10,18,0)'); vg.addColorStop(1, 'rgba(4,10,18,0.78)');
  g.fillStyle = vg; g.fillRect(0, 0, W, H);
  const side = g.createLinearGradient(0, 0, W, 0);
  side.addColorStop(0, 'rgba(4,10,18,0.45)'); side.addColorStop(0.35, 'rgba(4,10,18,0)'); side.addColorStop(1, 'rgba(4,10,18,0.25)');
  g.fillStyle = side; g.fillRect(0, 0, W, H);
  return cv.toDataURL('image/jpeg', 0.86);
}
