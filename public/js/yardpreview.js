// Shipyard 3D preview (docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §4.7): a turntable of the design being configured or
// built, and card thumbnails, both drawn with the parametric generators (shipgen.js) — the four sail classes with
// SAILING's rigmesh.js (never duplicated here).
//
// One shared WebGLRenderer for the turntable (studio lighting, water disc, a building dock while she is on the slip);
// it renders on demand only: while dragging / zooming (desktop up to 60 fps, phone capped at 30 fps and 1× pixel
// ratio), never when idle or scrolled out of view. Build stages (§4.7): < 0.25 keel blocks, < 0.65 hull rising behind a
// local clipping plane, < 0.9 primer grey, ≥ 0.9 full livery. Thumbnails come from a second, offscreen renderer, one per
// animation frame, cached by (variant, livery, size, angle, stage).
import * as THREE from 'three';
import { MODELS, parseVariant, defaultLivery } from '../../shared/ships/index.js';
import { generalArrangement as gaStub } from './gastub.js';
import { buildFromGA, shipBounds, disposeShip } from './shipgen.js';

const VERSION = 'yv1';
const ANGLES = { quarter: [38, 16], side: [90, 7], stern: [148, 16], top: [55, 60], hero: [30, 8] };
const isTouch = () => typeof window !== 'undefined' && (('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0);
const liveryKey = (l) => (l ? [l.hull, l.boot, l.house, l.funnel, l.band ?? '-', l.mark ?? '-'].join('.') : 'd');

let rigmeshMod = null;   // loaded lazily: only when a sail class is shown
async function sailYacht(cls) {
  rigmeshMod ||= await import('./rigmesh.js');
  const trim = await import('../../shared/sail/trim.js');
  const y = rigmeshMod.buildYacht(cls, {});
  try { y.setRig(trim.autoTrimView(cls, 70, 8), { aws: 8 }); y.update(1 / 30, { camera: null, time: 0, own: true }); } catch { /* static rig is fine */ }
  return y.group;
}

function studioScene() {
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xdcecff, 0x223548, 1.2));
  const key = new THREE.DirectionalLight(0xfff0d8, 2.5); key.position.set(-120, 160, -60); scene.add(key);
  const rim = new THREE.DirectionalLight(0x9cc9ff, 1.1); rim.position.set(140, 60, 160); scene.add(rim);
  const water = new THREE.Mesh(new THREE.CircleGeometry(1, 64), new THREE.MeshStandardMaterial({ color: 0x3d7f8f, roughness: 0.3, metalness: 0.05, transparent: true, opacity: 0.74, depthWrite: false }));
  water.rotation.x = -Math.PI / 2; water.renderOrder = 5; scene.add(water);
  const dock = new THREE.Group();
  const floor = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x7c838a, roughness: 0.95 }));
  dock.add(floor);
  for (const s of [-1, 1]) { const wall = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x8e959b, roughness: 0.95 })); wall.userData.side = s; dock.add(wall); }
  dock.visible = false; scene.add(dock);
  return { scene, water, dock, floor };
}
/** place the water / building dock for a ship of bounds bb at build stage `stage` */
function setStage(st, bb, stage) {
  const size = new THREE.Vector3(); bb.getSize(size);
  const R = Math.max(size.x, size.z) * 3;
  st.water.scale.set(R, R, 1); st.water.visible = stage >= 0.65;
  st.dock.visible = stage < 0.65;
  if (st.dock.visible) {
    const L = size.z * 1.15, W = size.x * 1.5;
    st.floor.scale.set(W, 0.6, L); st.floor.position.set(0, bb.min.y - 1.2, (bb.min.z + bb.max.z) / 2);
    const wh = Math.max(2, -bb.min.y + 0.5);   // dock walls up to about the waterline
    for (const w of st.dock.children) if (w.userData.side) { w.scale.set(1.2, wh, L); w.position.set(w.userData.side * W / 2, bb.min.y - 1 + wh / 2, (bb.min.z + bb.max.z) / 2); }
  }
}
function frame(camera, bb, az, el, zoom = 1, aspect = 1.6) {
  const c = new THREE.Vector3(), size = new THREE.Vector3(); bb.getCenter(c); bb.getSize(size);
  const rad = Math.max(1, size.length() / 2);
  const fov = camera.fov * Math.PI / 180;
  const dist = rad / Math.sin(fov / 2) / Math.min(1, aspect) * 0.72 / zoom;
  const a = az * Math.PI / 180, e = el * Math.PI / 180;
  camera.position.set(c.x + Math.sin(a) * Math.cos(e) * dist, c.y + Math.sin(e) * dist, c.z - Math.cos(a) * Math.cos(e) * dist);
  camera.near = Math.max(0.1, dist / 200); camera.far = dist * 20; camera.updateProjectionMatrix();
  camera.lookAt(c);
}

/** Build a preview model of a variant: { obj, bb, sail } (async because sail classes load rigmesh.js on demand). */
export async function previewModel(variant, { livery = null, stage = 1, name = '', phone = false, gaFn = gaStub, cargo = true } = {}) {
  const pv = parseVariant(variant); if (!pv) return null;
  const m = MODELS[pv.model];
  if (m.gen === 'sail') { const g = await sailYacht(m.id); return { obj: g, bb: shipBounds(g), sail: true, clipY: null }; }
  const ga = gaFn(variant, { livery: livery || defaultLivery(variant), stage });
  if (!ga) return null;
  const r = buildFromGA(ga, { phone, lod: 0, name, stage, cargo: cargo && stage >= 1, decals: !!name || !!ga.livery.mark });
  // while she is being built, frame the finished ship's envelope (so blocks on the slip are seen at their real scale)
  const bb = stage < 0.65 ? new THREE.Box3(new THREE.Vector3(-ga.B / 2, -ga.T, -ga.L / 2), new THREE.Vector3(ga.B / 2, ga.deckY + ga.B * 0.15, ga.L / 2)) : shipBounds(r.group);
  if (r.info.clipY != null) r.group.traverse((o) => { if (o.isMesh) for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.side = THREE.DoubleSide; });   // see into the open hull on the slip
  return { obj: r.group, bb, sail: false, clipY: r.info.clipY, info: r.info, T: ga.T };
}

// ------------------------------------------------------------------------------------------------ the turntable
export class YardPreview {
  constructor(opts = {}) {
    this.phone = opts.phone ?? (isTouch() && typeof window !== 'undefined' && window.innerWidth < 900);
    this.gaFn = opts.gaFn || gaStub;
    this.az = 38; this.el = 14; this.zoom = 1;
    this.key = null; this.model = null; this.renderer = null; this.host = null; this.visible = true;
    this.raf = 0; this.last = 0; this.dirty = false; this.pointers = new Map(); this.pinch0 = 0; this.token = 0;
    this.stats = { frames: 0, builds: 0, lastBuildMs: 0 };
  }
  ensure() {
    if (this.renderer) return true;
    try {
      const canvas = document.createElement('canvas'); canvas.className = 'yardTurnCanvas';
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !this.phone, alpha: true, preserveDrawingBuffer: true, powerPreference: 'low-power' });
    } catch (e) { console.warn('[yard] no WebGL for the preview', e); return false; }
    const r = this.renderer;
    r.setPixelRatio(this.phone ? 1 : Math.min(2, window.devicePixelRatio || 1));
    r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.06; r.outputColorSpace = THREE.SRGBColorSpace;
    r.localClippingEnabled = true; r.setClearColor(0x000000, 0);
    this.st = studioScene();
    this.camera = new THREE.PerspectiveCamera(30, 1.6, 0.1, 5000);
    this.clip = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
    const c = r.domElement;
    c.style.touchAction = 'none';
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) c.addEventListener(ev, (e) => this.onUp(e));
    c.addEventListener('wheel', (e) => { e.preventDefault(); this.zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12); }, { passive: false });
    if (typeof IntersectionObserver === 'function') this.io = new IntersectionObserver((es) => { this.visible = es.some((x) => x.isIntersecting); if (this.visible && this.dirty) this.kick(); });
    return true;
  }
  /** move the shared canvas into `host` (a placeholder element in the yard tab) */
  mount(host) {
    if (!host || !this.ensure()) return false;
    const c = this.renderer.domElement;
    if (c.parentElement !== host) { host.innerHTML = ''; host.appendChild(c); }
    if (this.io) { this.io.disconnect(); this.io.observe(host); }
    this.host = host;
    this.resize();
    this.kick();
    return true;
  }
  resize() {
    if (!this.host || !this.renderer) return;
    const w = Math.max(64, this.host.clientWidth || 320), h = Math.max(64, this.host.clientHeight || (this.phone ? 240 : 300));
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%'; this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h; this.dirty = true;
  }
  /** show a variant (rebuilds only when the variant, livery, stage or name changed) */
  async show(variant, opts = {}) {
    if (!this.ensure()) return;
    const stage = Math.max(0, Math.min(1, opts.stage ?? 1));
    const key = `${variant}|${liveryKey(opts.livery)}|${stage.toFixed(2)}|${opts.name || ''}`;
    if (key === this.key) { this.kick(); return; }
    this.key = key;
    const token = ++this.token, t0 = performance.now();
    const mod = await previewModel(variant, { ...opts, stage, phone: this.phone, gaFn: this.gaFn });
    if (token !== this.token || !mod) return;
    if (this.model) { this.st.scene.remove(this.model.obj); if (!this.model.sail) disposeShip(this.model.obj); }
    this.model = mod; this.st.scene.add(mod.obj);
    this.stats.builds++; this.stats.lastBuildMs = Math.round(performance.now() - t0);
    // hull rising behind the clip plane (stage 0.25–0.65)
    const clip = mod.clipY != null ? [this.clip] : null;
    if (clip) this.clip.constant = mod.clipY;
    mod.obj.traverse((o) => { if (!o.isMesh) return; for (const m of Array.isArray(o.material) ? o.material : [o.material]) { m.clippingPlanes = clip; m.needsUpdate = true; } });
    setStage(this.st, mod.bb, stage);
    this.dirty = true; this.kick();
  }
  rotate(deg) { this.az = (this.az + deg + 360) % 360; this.dirty = true; this.kick(); }
  zoomBy(f) { this.zoom = Math.max(0.6, Math.min(4, this.zoom * f)); this.dirty = true; this.kick(); }
  setView(name) { const a = ANGLES[name]; if (a) { [this.az, this.el] = a; this.zoom = 1; this.dirty = true; this.kick(); } }
  onDown(e) { this.renderer.domElement.setPointerCapture?.(e.pointerId); this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (this.pointers.size === 2) { const [a, b] = [...this.pointers.values()]; this.pinch0 = Math.hypot(a.x - b.x, a.y - b.y); } }
  onMove(e) {
    const p = this.pointers.get(e.pointerId); if (!p) return;
    if (this.pointers.size === 2) {
      p.x = e.clientX; p.y = e.clientY;
      const [a, b] = [...this.pointers.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinch0 > 0) { this.zoomBy(d / this.pinch0); this.pinch0 = d; }
      return;
    }
    const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
    this.az = (this.az - dx * 0.45 + 360) % 360; this.el = Math.max(2, Math.min(70, this.el + dy * 0.3));
    this.dirty = true; this.kick();
  }
  onUp(e) { this.pointers.delete(e.pointerId); if (this.pointers.size < 2) this.pinch0 = 0; }
  /** request one frame (phone: at most 30 per second) */
  kick() {
    if (this.raf || !this.renderer) return;
    this.raf = requestAnimationFrame((t) => {
      this.raf = 0;
      if (!this.visible || !this.host?.isConnected) return;
      if (this.phone && t - this.last < 33) { this.kick(); return; }
      this.last = t; this.renderNow();
    });
  }
  renderNow() {
    if (!this.renderer || !this.model) return;
    if (this.host && (this.host.clientWidth !== this.renderer.domElement.width / this.renderer.getPixelRatio())) this.resize();
    frame(this.camera, this.model.bb, this.az, this.el, this.zoom, this.camera.aspect);
    this.renderer.render(this.st.scene, this.camera);
    this.dirty = false; this.stats.frames++;
  }
  /** close the sheet: free the model and the GL context */
  dispose() {
    if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0;
    if (this.model && !this.model.sail) disposeShip(this.model.obj);
    this.model = null; this.key = null;
    this.io?.disconnect();
    if (this.renderer) { this.renderer.dispose(); this.renderer.forceContextLoss?.(); this.renderer.domElement.remove(); this.renderer = null; }
  }
}

// ------------------------------------------------------------------------------------------------ thumbnails
const mem = new Map(), pending = new Map(), queue = [];
let TR = null, broken = false, raf = 0;
function thumbStudio() {
  if (TR || broken) return TR;
  try {
    const canvas = document.createElement('canvas');
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true, powerPreference: 'low-power' });
    renderer.setPixelRatio(1); renderer.setClearColor(0x000000, 0); renderer.localClippingEnabled = true;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.06; renderer.outputColorSpace = THREE.SRGBColorSpace;
    TR = { renderer, st: studioScene(), camera: new THREE.PerspectiveCamera(26, 1.6, 0.1, 5000) };
  } catch (e) { console.warn('[yard] no WebGL for thumbnails', e); broken = true; }
  return TR;
}
export function thumbKey(variant, o = {}) { return `${VERSION}|${variant}|${liveryKey(o.livery)}|${o.w || 320}x${o.h || 200}|${o.angle || 'quarter'}|${(o.stage ?? 1).toFixed(2)}`; }
export function cachedYardThumb(variant, o = {}) { return mem.get(thumbKey(variant, o)) || null; }
/** → Promise<dataURL|null>; one render per animation frame */
export function yardThumb(variant, o = {}) {
  if (typeof document === 'undefined') return Promise.resolve(null);
  const key = thumbKey(variant, o);
  if (mem.has(key)) return Promise.resolve(mem.get(key));
  if (pending.has(key)) return pending.get(key).promise;
  const job = { key, variant, o }; job.promise = new Promise((res) => { job.resolve = res; });
  pending.set(key, job); if (o.priority) queue.unshift(job); else queue.push(job);
  pump();
  return job.promise;
}
function pump() {
  if (raf || !queue.length) return;
  raf = requestAnimationFrame(async () => {
    raf = 0;
    const job = queue.shift(); if (!job) return;
    let url = null;
    try { url = await renderThumb(job); } catch (e) { console.warn('[yard] thumb failed', job.variant, e); }
    if (url) mem.set(job.key, url);
    pending.delete(job.key); job.resolve(url);
    pump();
  });
}
async function renderThumb({ variant, o }) {
  const S = thumbStudio(); if (!S) return null;
  const w = Math.max(32, Math.min(800, o.w || 320)), h = Math.max(32, Math.min(600, o.h || 200));
  const stage = o.stage ?? 1;
  const mod = await previewModel(variant, { livery: o.livery, stage, name: o.name || '', cargo: o.cargo !== false });
  if (!mod) return null;
  S.st.scene.add(mod.obj); setStage(S.st, mod.bb, stage);
  const clip = mod.clipY != null ? [new THREE.Plane(new THREE.Vector3(0, -1, 0), mod.clipY)] : null;
  if (clip) mod.obj.traverse((m) => { if (m.isMesh) for (const mm of Array.isArray(m.material) ? m.material : [m.material]) mm.clippingPlanes = clip; });
  S.renderer.setSize(w, h, false); S.camera.aspect = w / h;
  const [az, el] = ANGLES[o.angle] || ANGLES.quarter;
  frame(S.camera, mod.bb, az, el, o.zoom || 1.05, w / h);
  S.renderer.render(S.st.scene, S.camera);
  const url = S.renderer.domElement.toDataURL('image/png');
  S.st.scene.remove(mod.obj); if (!mod.sail) disposeShip(mod.obj);
  return url;
}
export const PREVIEW_ANGLES = ANGLES;
