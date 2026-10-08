// Terrain tiles: fetches Uint8 height tiles from the server, builds vertex-coloured meshes in the floating-origin
// frame, provides bilinear height lookups (real metres) for grounding checks and the ocean depth texture.
// v0.3: high-resolution harbour patches (docs/V3-CONTRACTS.md §5) rendered as mask-coloured meshes; the coarse tiles
// are sunk under a patch footprint (same trick as the region cut-out) and `heightAt` consults patches first.
// v0.4 (docs/V4-CONTRACTS.md §4) — street level:
//  * every harbour patch gets a map drape: the z16 (desktop) / z15 (touch) OpenStreetMap tiles covering it are fetched
//    through the server's caching proxy (/api/maptile/osm/z/x/y.png), composited on one canvas per patch (centre
//    first) and used as the land colour (UV = Web Mercator of each vertex's lat/lon; 85 % tile / 15 % slope-shaded
//    vertex colour). Water cells keep the procedural seabed colour, and the map's own water colour is keyed out so a
//    synthetic coast never shows painted water on land. Region tiles (level 1) within 30 km get a z11/z12 drape the
//    same way, on land vertices only. Offline (or when the proxy has no tiles) the loader probes ONE tile, backs off
//    (90 s doubling to 15 min) and the meshes simply keep their vertex colours — no console noise.
//  * each patch publishes a shoreline foam field (signed distance to any obstacle, to natural shores, and an
//    exposure-to-the-sea term) that ocean.js turns into a soft wash line and surf rows (setShoreField).
//  * the coarse coast under and around a patch stays sunk / clamped under the 10 m patch surface, and the patch has a
//    skirt so no gap opens between the patch edge and the coarse tiles.
// World detail streaming (docs/WORLD-DETAIL-STREAMING.md §3.6.1, §3.7, Lane B): a WorldTileSet (wtiles.js) streams the
// server's D14 (z14, ≈ 6–10 m) and C11 (z11, ≈ 50–75 m) tiles around the camera focus and the ship. The coarse L0 / L1
// meshes are never rebuilt for it: their fragments are discarded (clip rectangles, wtiles.js CLIP) inside the footprint
// of an attached finer mesh, in the same frame the finer mesh is attached, so there is never a hole. Height lookups
// follow the server stack's order: harbour patch → D14 → L1 region → C11 (outside L1) → L0 global.
// `update(lat, lon, camera)` takes the camera (optional) for the focus point; `?wt=0` / localStorage saltline.wt=0 off.
// Scale reference (documented for main.js): ships are 1:1; the default chase camera is distance = max(60, 2.6 × ship
// length) at pitch 0.32 rad, which keeps quays, buildings and hull in proportion next to the 10 m patch coast.
import * as THREE from 'three';
import { TILE, LAYERS, PATCH, decodeHeight, decodePatchHeight, GEO } from '/shared/constants.js';
import { toLocal } from '/shared/geo.js';
import { patchHeightAt, computeSDF } from './harborgeom.js';
import { setShoreField } from './ocean2.js';
import { WorldTileSet, applyClip } from './wtiles.js';

export const VSCALE = 1; // the world is rendered 1:1 — real metres horizontally and vertically
/** Default chase camera for the 1:1 world (§4): main.js applies it. */
export const CHASE_CAMERA = { distance: (shipLength) => Math.max(60, 2.6 * (Number(shipLength) || 0)), pitch: 0.32 };

const N = TILE.CELLS + 1;
const SUNK_Y = -260;
const WATER_OFFSET = 2.5;     // patch water vertices sit this far under their real depth (keeps wave troughs off the bed)
const PATCH_SKIRT_M = 2;      // coarse vertices in the patch's outer ring are clamped this far under the patch surface
const SKIRT_DEPTH = 40;       // the patch's edge skirt reaches this far down (hides any seam with the coarse tiles)
const M = PATCH.MASK;
const D2R = Math.PI / 180;

// drape configuration
const DRAPE_TONE = 0.8;                         // map colours are designed for paper: tone them down under the sun
const PATCH_ZOOM = 16, PATCH_ZOOM_LOW = 15;
const REGION_ZOOM_NEAR = 12, REGION_ZOOM_FAR = 11, REGION_NEAR_M = 12000;
const REGION_DRAPE_M = 30000, REGION_DROP_M = 38000;
const MAX_CANVAS = 4096;
const UPLOAD_MIN_MS = 1500, UPLOAD_MAX_MS = 6000; // full-texture uploads while a drape fills in: at coverage milestones
const UPLOAD_STEPS = [0.25, 0.5, 0.75];          // (never closer than MIN apart) or after MAX with new tiles; always when complete
const TILE_URL = (z, x, y) => `/api/maptile/osm/${z}/${x}/${y}.png`;
const OSM_WATER = [170, 211, 223];              // openstreetmap-carto water (#aad3df), keyed out of the drape

// ------------------------------------------------------------------------------------------------ registries
/** Patch entries currently meshed (harbor.js reads ground heights / drape state from here). */
const PATCHES = new Map();
/** The HarborGeomSet entry of a meshed patch, or null. */
export function patchEntry(id) { return PATCHES.get(String(id))?.entry || null; }
/** Drape state of a patch: { state: 'none'|'loading'|'ready'|'offline', coverage 0..1, zoom }. */
export function drapeState(id) {
  const p = PATCHES.get(String(id));
  if (!p || !p.drape) return { state: 'none', coverage: 0, zoom: 0 };
  const d = p.drape;
  return { state: d.coverage >= 0.999 ? 'ready' : MapTiles.down() && d.loaded === 0 ? 'offline' : d.uploaded ? 'ready' : 'loading', coverage: d.coverage, zoom: d.z };
}

// ------------------------------------------------------------------------------------------------ Web Mercator
const lonToPx = (lon, z) => ((lon + 180) / 360) * 256 * 2 ** z;
const latToPx = (lat, z) => { const s = Math.sin(Math.max(-85.05, Math.min(85.05, lat)) * D2R); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * 2 ** z; };

// ------------------------------------------------------------------------------------------------ tile loader
/**
 * One shared, polite, offline-aware loader for map tiles. A probe (the first request) decides whether tiles are
 * available at all; while it is out nothing else is requested. When tiles cannot be loaded the loader stays quiet
 * for a back-off period (90 s, doubling to 15 min) and every waiting request resolves to `undefined` (not attempted)
 * — drapes keep their missing tiles and ask again later; a tile that was fetched and failed resolves to `null`.
 * Nothing is ever logged.
 */
export const MapTiles = (() => {
  const queue = [];               // { key, z, x, y, prio, resolve, job }
  let active = 0, state = 'unknown', downUntil = 0, backoff = 90e3, fails = 0;
  const maxActive = 4;
  let urlFor = TILE_URL;
  const now = () => performance.now();
  function setDown() {
    state = 'down'; downUntil = now() + backoff; backoff = Math.min(15 * 60e3, backoff * 2); fails = 0;
    for (const q of queue.splice(0)) q.resolve(undefined);
  }
  async function decode(blob) {
    if (typeof createImageBitmap === 'function') { try { return await createImageBitmap(blob); } catch { /* fall back to <img> */ } }
    const url = URL.createObjectURL(blob);
    try {
      return await new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = url; });
    } finally { setTimeout(() => URL.revokeObjectURL(url), 0); }
  }
  async function run(item) {
    active++;
    let img = null;
    try {
      const r = await fetch(urlFor(item.z, item.x, item.y), { credentials: 'same-origin' });
      if (r.ok) { const blob = await r.blob(); if (blob.size > 0) img = await decode(blob); }
      else await r.arrayBuffer().catch(() => null); // drain the (tiny) error body so the request completes cleanly
    } catch { img = null; }
    active--;
    if (img) { state = 'ok'; fails = 0; backoff = 90e3; }
    else if (state !== 'ok' || ++fails >= 4) setDown();
    item.resolve(img);
    pump();
  }
  function pump() {
    if (state === 'down') { if (now() < downUntil) return; state = 'unknown'; }
    while (queue.length && active < (state === 'ok' ? maxActive : 1)) {
      // highest priority first (lowest number); cancelled jobs are dropped
      let bi = 0;
      for (let i = 1; i < queue.length; i++) if (queue[i].prio < queue[bi].prio) bi = i;
      const item = queue.splice(bi, 1)[0];
      if (item.job?.cancelled) { item.resolve(undefined); continue; }
      run(item);
      if (state !== 'ok') break; // a single probe while the availability is unknown
    }
  }
  return {
    /** Request a tile image (ImageBitmap | HTMLImageElement), null (fetched, failed) or undefined (not attempted:
     *  loader backing off / job cancelled); `job.cancelled` drops it from the queue. */
    request(z, x, y, prio, job) {
      if (state === 'down' && now() < downUntil) return Promise.resolve(undefined);
      return new Promise((resolve) => { queue.push({ z, x, y, prio, resolve, job }); pump(); });
    },
    /** true while tiles are known to be unavailable (back-off running) */
    down: () => state === 'down' && now() < downUntil,
    available: () => state === 'ok',
    /** ms until the next attempt when down, else 0 */
    retryIn: () => (state === 'down' ? Math.max(0, downUntil - now()) : 0),
    pump,
    /** testing / alternative sources: (z, x, y) → URL */
    setSource(fn) { urlFor = typeof fn === 'function' ? fn : TILE_URL; state = 'unknown'; downUntil = 0; backoff = 90e3; fails = 0; },
    stats: () => ({ state, queued: queue.length, active, retryIn: state === 'down' ? Math.max(0, Math.round(downUntil - now())) : 0 }),
  };
})();

// ------------------------------------------------------------------------------------------------ drape
let _keyCanvas = null;
function keyCanvas() {
  if (!_keyCanvas) { const c = document.createElement('canvas'); c.width = c.height = 256; _keyCanvas = { c, x: c.getContext('2d', { willReadFrequently: true }) }; }
  return _keyCanvas;
}
let _blankTex = null;
function blankTexture() {
  if (!_blankTex) { _blankTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat); _blankTex.needsUpdate = true; }
  return _blankTex;
}

/**
 * A map drape over a lat/lon box at one zoom: tiles x0..x0+cols-1, y0..y0+rows-1 composited on one canvas (map water
 * keyed out to transparent), loaded nearest-first around `focus`, uploaded to the GPU a handful of times while it fills
 * in (a 3 k canvas with mipmaps is a noticeable upload: first view, coverage milestones, then complete).
 */
class Drape {
  constructor(bbox, z, focus, prioBase) {
    // drop a zoom level until the canvas fits MAX_CANVAS
    for (;;) {
      this.x0 = Math.floor(lonToPx(bbox.lonMin, z) / 256); this.x1 = Math.floor(lonToPx(bbox.lonMax, z) / 256);
      this.y0 = Math.floor(latToPx(bbox.latMax, z) / 256); this.y1 = Math.floor(latToPx(bbox.latMin, z) / 256);
      if (((this.x1 - this.x0 + 1) * 256 <= MAX_CANVAS && (this.y1 - this.y0 + 1) * 256 <= MAX_CANVAS) || z <= 2) break;
      z--;
    }
    this.z = z; this.cols = this.x1 - this.x0 + 1; this.rows = this.y1 - this.y0 + 1;
    this.canvas = document.createElement('canvas'); this.canvas.width = this.cols * 256; this.canvas.height = this.rows * 256;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace; this.texture.anisotropy = 8;
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter; this.texture.magFilter = THREE.LinearFilter;
    this.texture.premultiplyAlpha = true; // keyed (transparent) water must not bleed black into the coast when filtered
    this.texture.needsUpdate = false;
    const fx = lonToPx(focus.lon, z) / 256, fy = latToPx(focus.lat, z) / 256;
    this.tiles = [];
    for (let y = this.y0; y <= this.y1; y++) for (let x = this.x0; x <= this.x1; x++) this.tiles.push({ x, y, st: 0, d: Math.hypot(x + 0.5 - fx, y + 0.5 - fy), next: 0, wait: 20e3 });
    this.tiles.sort((a, b) => a.d - b.d);
    this.prioBase = prioBase; this.loaded = 0; this.dirty = false; this.uploaded = false; this.lastUpload = 0; this.uploadedCoverage = 0; this.job = { cancelled: false };
    this.onUpload = null;
  }
  get coverage() { return this.tiles.length ? this.loaded / this.tiles.length : 1; }
  /** canvas UV of a lat/lon (CanvasTexture flipY: v = 1 at the top row) */
  u(lon) { return (lonToPx(lon, this.z) - this.x0 * 256) / (this.cols * 256); }
  v(lat) { return 1 - (latToPx(lat, this.z) - this.y0 * 256) / (this.rows * 256); }
  /** request every tile that is still missing (the loader queues and prioritises them) */
  pump() {
    if (this.job.cancelled || MapTiles.down()) return;
    const now = performance.now();
    for (const t of this.tiles) {
      if (t.st !== 0 || t.next > now) continue;
      t.st = 1;
      MapTiles.request(this.z, t.x, t.y, this.prioBase + t.d, this.job).then((img) => {
        if (this.job.cancelled) { closeImage(img); return; }
        if (img === undefined) { t.st = 0; return; } // never attempted (loader backing off): asked again by a later pump()
        // fetched but unavailable: retried later, each tile backing off on its own (20 s doubling to 10 min)
        if (!img) { t.st = 0; t.next = performance.now() + t.wait; t.wait = Math.min(600e3, t.wait * 2); return; }
        try { this.draw(t, img); t.st = 2; this.loaded++; this.dirty = true; } catch { t.st = 0; }
        closeImage(img);
      });
    }
  }
  draw(t, img) {
    const K = keyCanvas();
    K.x.clearRect(0, 0, 256, 256);
    K.x.drawImage(img, 0, 0, 256, 256);
    const id = K.x.getImageData(0, 0, 256, 256), d = id.data;
    const [wr, wg, wb] = OSM_WATER;
    for (let i = 0; i < d.length; i += 4) {
      const m = Math.max(Math.abs(d[i] - wr), Math.abs(d[i + 1] - wg), Math.abs(d[i + 2] - wb));
      if (m <= 10) d[i + 3] = 0;
      else if (m < 26) d[i + 3] = Math.min(d[i + 3], Math.round(((m - 10) / 16) * 255)); // anti-aliased coast
    }
    this.ctx.putImageData(id, (t.x - this.x0) * 256, (t.y - this.y0) * 256);
  }
  /** push the canvas to the GPU when enough changed; returns true on an upload */
  flush(force = false) {
    if (!this.dirty || this.job.cancelled) return false;
    const t = performance.now(), done = this.loaded === this.tiles.length, cov = this.coverage;
    if (!force && !done) {
      if (!this.uploaded) { if (cov < 0.08 && this.loaded < 4) return false; } // first view once the centre is in
      else {
        const since = t - this.lastUpload;
        const milestone = UPLOAD_STEPS.some((m) => cov >= m && this.uploadedCoverage < m);
        if (since < UPLOAD_MIN_MS || (!milestone && since < UPLOAD_MAX_MS)) return false;
      }
    }
    this.texture.needsUpdate = true; this.dirty = false; this.lastUpload = t; this.uploadedCoverage = cov;
    const first = !this.uploaded; this.uploaded = true;
    if (first) this.onUpload?.(this);
    return true;
  }
  dispose() {
    this.job.cancelled = true;
    this.texture.dispose();
    this.canvas.width = this.canvas.height = 0; // free the backing store now, not at GC
  }
}
function closeImage(img) { try { img?.close?.(); } catch { /* HTMLImageElement */ } }

// ------------------------------------------------------------------------------------------------ materials
/**
 * Lambert + vertex colours + an optional map drape: attributes `drapeUv` (vec2) and `drapeW` (0 water … 1 land);
 * uniforms uDrape (sampler), uDrapeOn (0/1), uDrapeTone. Final albedo = mix(vertex, 0.85·tile + 0.15·shaded vertex,
 * drapeW · tile alpha). All drape materials share one program (customProgramCacheKey).
 */
function makeDrapeMaterial(clip = null) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  const uniforms = { uDrape: { value: blankTexture() }, uDrapeOn: { value: 0 }, uDrapeTone: { value: DRAPE_TONE } };
  m.userData.uniforms = uniforms;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 drapeUv; attribute float drapeW; varying vec2 vDrapeUv; varying float vDrapeW; varying vec3 vDrapeN;')
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n vDrapeUv = drapeUv; vDrapeW = drapeW; vDrapeN = objectNormal;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uDrape; uniform float uDrapeOn; uniform float uDrapeTone; varying vec2 vDrapeUv; varying float vDrapeW; varying vec3 vDrapeN;')
      .replace('#include <color_fragment>', `#include <color_fragment>
  if (uDrapeOn > 0.5 && vDrapeW > 0.002) {
    vec4 dTex = texture2D(uDrape, vDrapeUv);              // premultiplied alpha (see Drape)
    float dW = clamp(vDrapeW, 0.0, 1.0) * dTex.a;
    vec3 tile = dTex.rgb / max(dTex.a, 0.004);
    float shade = clamp(0.55 + 0.6 * dot(normalize(vDrapeN), normalize(vec3(-0.45, 0.8, -0.4))), 0.3, 1.15);
    diffuseColor.rgb = mix(diffuseColor.rgb, tile * uDrapeTone * 0.85 + diffuseColor.rgb * shade * 0.15, dW);
  }`);
  };
  m.customProgramCacheKey = () => 'saltline-drape-1';
  return clip ? applyClip(m, clip) : m;
}

// ------------------------------------------------------------------------------------------------ Terrain
export class Terrain {
  constructor(scene) {
    this.scene = scene;
    this.tiles = new Map(); // key -> { level, tx, ty, data, mesh, mat?, drape?, drapeNext? }
    this.pending = new Set();
    this.patches = new Map(); // harbour id -> { id, entry, mesh, mat, bbox, drape, shore }
    this.origin = { lat: 0, lon: 0 };
    this.group = new THREE.Group();
    scene.add(this.group);
    this.mat = applyClip(new THREE.MeshLambertMaterial({ vertexColors: true }), 'coarse'); // hidden under attached detail tiles
    this.version = 0; // bumps when tiles / patches load (ocean depth texture refresh)
    this.halfRes = (navigator.hardwareConcurrency || 8) <= 4 || (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) || navigator.maxTouchPoints > 1;
    this.lowPower = this.halfRes;
    let pref = null; try { pref = localStorage.getItem('saltline.drape'); } catch { /* storage blocked */ }
    this.drapeEnabled = pref !== '0';
    this.shipPos = null;
    // world detail tiles (D14 / C11): on unless ?wt=0 or localStorage saltline.wt = '0'
    let wtOn = true;
    try { wtOn = localStorage.getItem('saltline.wt') !== '0' && !/[?&]wt=0\b/.test(location.search); } catch { /* storage blocked */ }
    this.wtiles = new WorldTileSet({ parent: this.group, origin: this.origin, halfRes: this.halfRes, enabled: wtOn, coarseAt: (lat, lon, z) => this.coarseHeightAt(lat, lon, z), shoreField: (e) => buildShoreField(e) });
    this.wtVersion = 0;
  }
  setOrigin(origin) {
    this.origin = origin;
    for (const t of this.tiles.values()) if (t.mesh) this.buildMesh(t);
    for (const p of this.patches.values()) this.placePatch(p);
    this.wtiles?.setOrigin(origin);
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
  /**
   * Ensure tiles around (lat, lon) are loaded; drop far ones; drive the map drapes and the world detail tiles.
   * `camera` (optional): its look point on the sea is the detail focus (else the ship) and its height gates D14.
   */
  update(lat, lon, camera = null) {
    this.shipPos = { lat, lon };
    if (this.wtiles) {
      const f = camera ? WorldTileSet.focusFromCamera(camera, this.origin) : null;
      this.wtiles.update(f || { lat, lon }, { lat, lon }, { camH: f?.camH ?? 0 });
      if (this.wtiles.version !== this.wtVersion) { this.wtVersion = this.wtiles.version; this.version++; } // ocean depth refresh, ≤ 1 per tick
    }
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
      if (!want.has(key)) this.dropTile(key, t);
    }
    this.updateDrapes();
  }
  dropTile(key, t) {
    if (t.mesh) { this.group.remove(t.mesh); t.mesh.geometry.dispose(); }
    t.mat?.dispose(); t.drape?.dispose(); t.drapeNext?.dispose();
    this.tiles.delete(key);
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
  /** lat/lon bounds of a tile's vertex grid (cell centres). */
  tileBounds(t) {
    const d = LAYERS[t.level];
    const lat0 = d.latMax - t.ty * TILE.CELLS * d.res, lon0 = d.lonMin + t.tx * TILE.CELLS * d.res;
    return { latMax: lat0, latMin: lat0 - N * d.res, lonMin: lon0, lonMax: lon0 + N * d.res, res: d.res };
  }
  /**
   * How a coarse vertex at lat/lon relates to the loaded patches: 'sink' when at least one coarse cell inside a
   * footprint (hidden under the patch mesh); a clamp height when in the inner ring (keeps the coarse surface just under
   * the patch); for region tiles (`match`) a vertex in the outer ring (within one cell outside) takes the patch's own
   * edge height (`set`), so the 550 m coarse coast fades into the 10 m patch coast over one coarse cell instead of
   * leaving a moat or a cliff along the patch edge; or null.
   */
  patchSink(lat, lon, res, match = false) {
    let clamp = null, set = null, setW = 0;
    for (const p of this.patches.values()) {
      const b = p.bbox;
      const din = Math.min(lat - b.latMin, b.latMax - lat, lon - b.lonMin, b.lonMax - lon); // > 0 inside
      if (din >= res) return { sink: true };
      if (din < -res) continue;
      const e = p.entry;
      const cl = (la, lo) => patchHeightAt(e, Math.min(b.latMax - 1e-6, Math.max(b.latMin + 1e-6, la)), Math.min(b.lonMax - 1e-6, Math.max(b.lonMin + 1e-6, lo)));
      const hs = [cl(lat, lon), cl(lat + res / 2, lon), cl(lat - res / 2, lon), cl(lat, lon + res / 2), cl(lat, lon - res / 2)].filter((h) => h != null);
      if (!hs.length) continue;
      if (match && din < 0) {
        // outer ring: the patch height at the nearest edge point (a hair under it), the closest patch wins
        const w = 1 + din / res;
        const hEdge = cl(lat, lon);
        if (hEdge != null && w > setW) { setW = w; set = hEdge - 0.4; }
        continue;
      }
      const hmin = Math.min(...hs) - PATCH_SKIRT_M;
      clamp = clamp == null ? hmin : Math.min(clamp, hmin);
    }
    if (clamp != null) return { clamp, force: match };
    return set == null ? null : { set };
  }
  buildMesh(t) {
    const d = LAYERS[t.level];
    const lat0 = d.latMax - t.ty * TILE.CELLS * d.res, lon0 = d.lonMin + t.tx * TILE.CELLS * d.res;
    const pos = new Float32Array(N * N * 3), col = new Float32Array(N * N * 3);
    const drapable = t.level === 1;
    const w = drapable ? new Float32Array(N * N) : null;
    // Region cut-out, in global cell indices (robust against float rounding of the vertex lon/lat). A global cell is
    // sunk only when it lies at least one full cell INSIDE the region window, so the drop-off slope to the sunk
    // vertices is always hidden under the fine region tiles instead of forming a trench along the boundary.
    const R = LAYERS[1];
    const bx0 = Math.round((R.lonMin - d.lonMin) / d.res), bx1 = Math.round((R.lonMax - d.lonMin) / d.res);
    const by0 = Math.round((d.latMax - R.latMax) / d.res), by1 = Math.round((d.latMax - R.latMin) / d.res);
    const inRegion = (gi, gj) => t.level === 0 && gi > bx0 && gi < bx1 - 1 && gj > by0 && gj < by1 - 1;
    // harbour patches: only tiles whose bounds touch a patch pay for the per-vertex test
    const tb = this.tileBounds(t);
    const patchesNear = [...this.patches.values()].some((p) => p.bbox.latMin - d.res < tb.latMax && p.bbox.latMax + d.res > tb.latMin && p.bbox.lonMin - d.res < tb.lonMax && p.bbox.lonMax + d.res > tb.lonMin);
    const c = new THREE.Color();
    for (let j = 0; j < N; j++) {
      const lat = lat0 - (j + 0.5) * d.res; // sample j is the CENTRE of raster cell ty*CELLS+j (same convention as the server)
      for (let i = 0; i < N; i++) {
        const lon = lon0 + (i + 0.5) * d.res;
        const p = toLocal(lat, lon, this.origin);
        const h0 = decodeHeight(t.data[j * N + i]);
        let h = h0, sunk = false;
        if (inRegion(t.tx * TILE.CELLS + i, t.ty * TILE.CELLS + j)) { h = SUNK_Y; sunk = true; } // the detail layer renders this area; sink the coarse one
        else if (patchesNear) {
          const s = this.patchSink(lat, lon, d.res, t.level === 1);
          if (s) { if (s.sink) { h = SUNK_Y; sunk = true; } else if (s.set != null) h = s.set; else h = s.force ? s.clamp : Math.min(h, s.clamp); }
        }
        const k = (j * N + i) * 3;
        // (patch-matched ring vertices keep their exact height; plain coarse water gets the usual 4 m under-sink)
        pos[k] = p.x; pos[k + 1] = h < 0 && !(patchesNear && h !== h0) ? h * VSCALE - 4 : h * VSCALE; pos[k + 2] = p.z;
        if (w) w[j * N + i] = !sunk && h >= 0 ? 1 : 0; // drape on land vertices only
        const v = hash2(t.tx * 131 + i, t.ty * 173 + j) * 0.12 - 0.06;
        const hc = sunk ? h0 : h;
        if (hc < 0) c.setRGB(0.32 + v, 0.30 + v, 0.22).multiplyScalar(Math.max(0.35, 1 + hc / 120));
        else if (hc < 4) c.setRGB(0.78 + v, 0.72 + v, 0.52);
        else if (hc < 45) { const s = (hc - 4) / 41; c.setRGB(0.26 + 0.12 * s + v, 0.47 - 0.08 * s + v, 0.2 + 0.05 * s); }
        else if (hc < 95) { const s = (hc - 45) / 50; c.setRGB(0.4 + 0.1 * s + v, 0.38 + 0.08 * s + v, 0.33 + 0.1 * s); }
        else c.setRGB(0.72 + v, 0.72 + v, 0.74);
        col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b;
      }
    }
    let geo;
    if (t.mesh) {
      geo = t.mesh.geometry;
      geo.attributes.position.array.set(pos); geo.attributes.position.needsUpdate = true;
      geo.attributes.color.array.set(col); geo.attributes.color.needsUpdate = true;
      if (w && geo.attributes.drapeW) { geo.attributes.drapeW.array.set(w); geo.attributes.drapeW.needsUpdate = true; }
      geo.computeVertexNormals(); geo.computeBoundingSphere();
      return;
    }
    geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (drapable) {
      geo.setAttribute('drapeW', new THREE.BufferAttribute(w, 1));
      geo.setAttribute('drapeUv', new THREE.BufferAttribute(new Float32Array(N * N * 2), 2));
    }
    const idx = new Uint32Array(TILE.CELLS * TILE.CELLS * 6);
    let q = 0;
    for (let j = 0; j < TILE.CELLS; j++) for (let i = 0; i < TILE.CELLS; i++) {
      const a = j * N + i, b = a + 1, c2 = a + N, dd = c2 + 1;
      idx[q++] = a; idx[q++] = c2; idx[q++] = b; idx[q++] = b; idx[q++] = c2; idx[q++] = dd;
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    if (drapable) t.mat = makeDrapeMaterial('coarse');
    t.mesh = new THREE.Mesh(geo, drapable ? t.mat : this.mat);
    t.mesh.frustumCulled = true;
    this.group.add(t.mesh);
  }

  // ------------------------------------------------------------------ map drapes
  /** Enable / disable the street-level map drape (persisted per browser). */
  setDrape(on) {
    this.drapeEnabled = !!on;
    try { localStorage.setItem('saltline.drape', on ? '1' : '0'); } catch { /* storage blocked */ }
    for (const p of this.patches.values()) {
      if (on) { this.ensurePatchDrape(p); continue; }
      p.drape?.dispose(); p.drape = null;
      p.mat.userData.uniforms.uDrapeOn.value = 0; p.mat.userData.uniforms.uDrape.value = blankTexture(); // never sample a disposed canvas
    }
    if (!on) for (const t of this.tiles.values()) this.dropRegionDrape(t);
    else this.updateDrapes();
  }
  drapeStats() {
    const list = [];
    for (const p of this.patches.values()) if (p.drape) list.push({ kind: 'patch', id: p.id, z: p.drape.z, tiles: p.drape.tiles.length, loaded: p.drape.loaded, on: p.mat.userData.uniforms.uDrapeOn.value });
    for (const [key, t] of this.tiles) if (t.drape) list.push({ kind: 'region', id: key, z: t.drape.z, tiles: t.drape.tiles.length, loaded: t.drape.loaded, on: t.mat?.userData.uniforms.uDrapeOn.value });
    return { enabled: this.drapeEnabled, loader: MapTiles.stats(), drapes: list };
  }
  /** called from update(): request missing tiles, upload finished canvases, manage region drapes by distance */
  updateDrapes() {
    if (!this.drapeEnabled) return;
    for (const p of this.patches.values()) { this.ensurePatchDrape(p); p.drape?.pump(); p.drape?.flush(); }
    const s = this.shipPos;
    for (const t of this.tiles.values()) {
      if (t.level !== 1 || !t.mesh) continue;
      if (!s) continue;
      const dist = distToBox(s.lat, s.lon, this.tileBounds(t));
      if (dist > REGION_DROP_M) { this.dropRegionDrape(t); continue; }
      if (dist <= REGION_DRAPE_M) {
        const z = !this.lowPower && dist < REGION_NEAR_M ? REGION_ZOOM_NEAR : REGION_ZOOM_FAR;
        if (!t.drape && !t.drapeNext) this.startRegionDrape(t, z, s);
        else if (t.drape && t.drape.z < z && !t.drapeNext) this.startRegionDrape(t, z, s); // sharper map as we close in
      }
      for (const d of [t.drape, t.drapeNext]) { d?.pump(); d?.flush(); }
    }
    MapTiles.pump();
  }
  ensurePatchDrape(p) {
    if (p.drape || !this.drapeEnabled) return;
    const e = p.entry;
    const z = this.lowPower ? PATCH_ZOOM_LOW : PATCH_ZOOM;
    const d = new Drape(e.bbox, z, e.origin, 0);
    p.drape = d;
    // UVs: patch lat depends on the row only and lon on the column only (patch frame) → per-row / per-column tables
    const geo = p.mesh.geometry, uv = geo.attributes.drapeUv.array;
    const { m, step } = p.grid, n = e.n, res = e.res;
    const us = new Float32Array(m + 2), vs = new Float32Array(m + 2);
    const cosO = Math.cos(e.origin.lat * D2R);
    const lonOf = (x) => e.origin.lon + x / (GEO.M_PER_DEG_LON_EQ * cosO), latOf = (z2) => e.origin.lat - z2 / GEO.M_PER_DEG_LAT;
    for (let a = 0; a < m; a++) us[a] = d.u(lonOf((a * step + step / 2 - n / 2) * res));
    for (let b = 0; b < m; b++) vs[b] = d.v(latOf((b * step + step / 2 - n / 2) * res));
    for (let b = 0; b < m; b++) for (let a = 0; a < m; a++) { const k = (b * m + a) * 2; uv[k] = us[a]; uv[k + 1] = vs[b]; }
    // skirt vertices (appended after the grid) copy the UV of the edge vertex they hang from
    const sk = p.grid.skirt;
    for (let s = 0; s < sk.length; s++) { const src = sk[s], k = (m * m + s) * 2; uv[k] = uv[src * 2]; uv[k + 1] = uv[src * 2 + 1]; }
    geo.attributes.drapeUv.needsUpdate = true;
    d.onUpload = () => { if (p.drape === d) { p.mat.userData.uniforms.uDrape.value = d.texture; p.mat.userData.uniforms.uDrapeOn.value = 1; } };
    d.pump();
  }
  startRegionDrape(t, z, ship) {
    const tb = this.tileBounds(t);
    const box = { latMin: tb.latMin, latMax: tb.latMax, lonMin: tb.lonMin, lonMax: tb.lonMax };
    const focus = { lat: Math.min(box.latMax, Math.max(box.latMin, ship.lat)), lon: Math.min(box.lonMax, Math.max(box.lonMin, ship.lon)) };
    const d = new Drape(box, z, focus, 1000 + distToBox(ship.lat, ship.lon, tb) / 100);
    if (!t.drape) t.drape = d; else t.drapeNext = d;
    d.onUpload = () => {
      // swap in: UVs for this drape, then the texture (an upgrade replaces the coarser drape once it has content)
      const geo = t.mesh?.geometry; if (!geo || !t.mat) return;
      const dd = LAYERS[t.level], lat0 = dd.latMax - t.ty * TILE.CELLS * dd.res, lon0 = dd.lonMin + t.tx * TILE.CELLS * dd.res;
      const uv = geo.attributes.drapeUv.array;
      const us = new Float32Array(N), vs = new Float32Array(N);
      for (let i = 0; i < N; i++) us[i] = d.u(lon0 + (i + 0.5) * dd.res);
      for (let j = 0; j < N; j++) vs[j] = d.v(lat0 - (j + 0.5) * dd.res);
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const k = (j * N + i) * 2; uv[k] = us[i]; uv[k + 1] = vs[j]; }
      geo.attributes.drapeUv.needsUpdate = true;
      t.mat.userData.uniforms.uDrape.value = d.texture; t.mat.userData.uniforms.uDrapeOn.value = 1;
      if (t.drapeNext === d) { t.drape?.dispose(); t.drape = d; t.drapeNext = null; }
    };
    d.pump();
  }
  dropRegionDrape(t) {
    if (!t.drape && !t.drapeNext) return;
    t.drape?.dispose(); t.drapeNext?.dispose(); t.drape = t.drapeNext = null;
    if (t.mat) { t.mat.userData.uniforms.uDrapeOn.value = 0; t.mat.userData.uniforms.uDrape.value = blankTexture(); }
  }

  // ------------------------------------------------------------------ harbour patches
  /** Add (or replace) the high-resolution mesh of a harbour patch entry (HarborGeomSet entry, §5). */
  addPatch(entry) {
    if (!entry || !entry.mask || !entry.heights) return null;
    if (this.patches.has(entry.id)) this.removePatch(entry.id, false);
    const n = entry.n, res = entry.res, step = this.halfRes ? 2 : 1;
    const m = Math.floor(n / step);                     // vertices per side
    // grid vertices + a skirt hanging from every edge vertex (seals the patch edge against the coarse tiles)
    const skirt = [];
    for (let a = 0; a < m; a++) skirt.push(a);                         // north edge, west → east
    for (let b = 1; b < m; b++) skirt.push(b * m + m - 1);             // east edge, north → south
    for (let a = m - 2; a >= 0; a--) skirt.push((m - 1) * m + a);      // south edge, east → west
    for (let b = m - 2; b >= 1; b--) skirt.push(b * m);                // west edge, south → north
    const total = m * m + skirt.length;
    const pos = new Float32Array(total * 3), col = new Float32Array(total * 3), w = new Float32Array(total);
    const c = new THREE.Color(), grass = new THREE.Color(0.30, 0.46, 0.22);
    const prio = (code) => (code === M.BREAKWATER ? 5 : code === M.QUAY ? 4 : code === M.PONTOON ? 3 : code === M.LAND ? 2 : code === M.SHALLOW ? 1 : 0);
    for (let b = 0; b < m; b++) {
      for (let a = 0; a < m; a++) {
        const i = a * step, j = b * step;
        // sample the step×step block: structures win so thin piers survive half resolution
        let code = -1, bestP = -1, hStruct = -Infinity, hSum = 0, cnt = 0;
        for (let dj = 0; dj < step; dj++) for (let di = 0; di < step; di++) {
          const ii = Math.min(n - 1, i + di), jj = Math.min(n - 1, j + dj), k = jj * n + ii;
          const mk = entry.mask[k], hh = decodePatchHeight(entry.heights[k]), pr = prio(mk);
          if (pr > bestP) { bestP = pr; code = mk; hStruct = hh; } else if (pr === bestP) hStruct = Math.max(hStruct, hh);
          hSum += hh; cnt++;
        }
        const obstacle = code === M.LAND || code === M.QUAY || code === M.BREAKWATER || code === M.PONTOON;
        const h = obstacle ? hStruct : hSum / cnt;
        const x = (i + step / 2 - n / 2) * res, z = (j + step / 2 - n / 2) * res;
        const vi = b * m + a, k = vi * 3;
        pos[k] = x; pos[k + 1] = obstacle ? h * VSCALE : h * VSCALE - WATER_OFFSET; pos[k + 2] = z;
        w[vi] = obstacle ? 1 : 0;
        const v = hash2(i * 7 + 1, j * 13 + 3) * 0.06 - 0.03;
        switch (code) {
          case M.QUAY: c.setHex(0x8e8b84); break;
          case M.BREAKWATER: c.setHex(0x5a5650); break;
          case M.PONTOON: c.setHex(0xb9b2a4); break;
          case M.LAND: { const s = Math.min(1, Math.max(0, (h - 2.5) / 9)); c.setRGB(0.78 + v, 0.72 + v, 0.52).lerp(grass, s); break; }
          case M.SHALLOW: c.setRGB(0.62 + v, 0.58 + v, 0.42); break;
          case M.FAIRWAY: c.setRGB(0.25 + v, 0.26 + v, 0.22).multiplyScalar(0.55 + 0.45 * Math.max(0, 1 + h / 24)); break;
          default: c.setRGB(0.31 + v, 0.30 + v, 0.22).multiplyScalar(0.55 + 0.45 * Math.max(0, 1 + h / 24)); break;
        }
        if (code === M.QUAY || code === M.BREAKWATER || code === M.PONTOON) c.multiplyScalar(1 + v);
        col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b;
      }
    }
    // skirt vertices: straight below their edge vertex, same colour, no drape
    for (let s = 0; s < skirt.length; s++) {
      const src = skirt[s] * 3, k = (m * m + s) * 3;
      pos[k] = pos[src]; pos[k + 1] = Math.min(pos[src + 1], 0) - SKIRT_DEPTH; pos[k + 2] = pos[src + 2];
      col[k] = col[src] * 0.8; col[k + 1] = col[src + 1] * 0.8; col[k + 2] = col[src + 2] * 0.8;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('drapeW', new THREE.BufferAttribute(w, 1));
    geo.setAttribute('drapeUv', new THREE.BufferAttribute(new Float32Array(total * 2), 2));
    const quads = (m - 1) * (m - 1) + skirt.length;
    const idx = new Uint32Array(quads * 6);
    let q = 0;
    for (let b = 0; b < m - 1; b++) for (let a = 0; a < m - 1; a++) {
      const p0 = b * m + a, p1 = p0 + 1, p2 = p0 + m, p3 = p2 + 1;
      idx[q++] = p0; idx[q++] = p2; idx[q++] = p1; idx[q++] = p1; idx[q++] = p2; idx[q++] = p3;
    }
    // skirt quads, wound so they face outwards (the ring runs clockwise seen from above: N → E → S → W)
    for (let s = 0; s < skirt.length; s++) {
      const s1 = (s + 1) % skirt.length;
      const t0 = skirt[s], t1 = skirt[s1], b0 = m * m + s, b1 = m * m + s1;
      idx[q++] = t0; idx[q++] = t1; idx[q++] = b0; idx[q++] = t1; idx[q++] = b1; idx[q++] = b0;
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    const mat = makeDrapeMaterial();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = true;
    mesh.renderOrder = 0;
    const p = { id: entry.id, entry, mesh, mat, bbox: entry.bbox, grid: { m, step, skirt }, drape: null, shore: null };
    this.patches.set(entry.id, p);
    PATCHES.set(String(entry.id), p);
    this.group.add(mesh);
    try { p.shore = buildShoreField(entry); } catch { p.shore = null; }
    this.placePatch(p);
    this.rebuildAffectedTiles(entry.bbox);
    this.wtiles?.setPatchBoxes([...this.patches.values()].map((q) => q.bbox));
    if (this.drapeEnabled) { this.ensurePatchDrape(p); MapTiles.pump(); }
    this.version++;
    return mesh;
  }
  removePatch(id, rebuild = true) {
    const p = this.patches.get(id); if (!p) return;
    this.group.remove(p.mesh); p.mesh.geometry.dispose(); p.mat.dispose();
    p.drape?.dispose();
    if (p.shore) { setShoreField(p.id, null); p.shore.tex.dispose(); }
    this.patches.delete(id);
    if (PATCHES.get(String(id)) === p) PATCHES.delete(String(id));
    if (rebuild) { this.rebuildAffectedTiles(p.bbox); this.version++; }
    this.wtiles?.setPatchBoxes([...this.patches.values()].map((q) => q.bbox));
  }
  hasPatch(id) { return this.patches.has(id); }
  placePatch(p) {
    const l = toLocal(p.entry.origin.lat, p.entry.origin.lon, this.origin);
    p.mesh.position.set(l.x, 0, l.z);
    if (p.shore) {
      const half = (p.entry.n * p.entry.res) / 2;
      setShoreField(p.id, { tex: p.shore.tex, x0: l.x - half, z0: l.z - half, size: p.entry.n * p.entry.res });
    }
  }
  rebuildAffectedTiles(bbox) {
    for (const t of this.tiles.values()) {
      if (!t.mesh) continue;
      const d = LAYERS[t.level], tb = this.tileBounds(t);
      const m = 1.5 * d.res;
      if (bbox.latMin - m < tb.latMax && bbox.latMax + m > tb.latMin && bbox.lonMin - m < tb.lonMax && bbox.lonMax + m > tb.lonMin) this.buildMesh(t);
    }
  }

  /**
   * Real-metre height at lat/lon, the server stack's order (§3.6.1): harbour patch (bilinear over its 10 m heights) →
   * D14 detail tile → L1 region tile → C11 coast tile (outside L1) → L0 global tile. null if nothing is loaded.
   */
  heightAt(lat, lon) {
    for (const p of this.patches.values()) {
      const b = p.bbox;
      if (lat < b.latMin || lat > b.latMax || lon < b.lonMin || lon > b.lonMax) continue;
      const h = patchHeightAt(p.entry, lat, lon);
      if (h != null) return h;
    }
    const d = this.wtiles?.heightAt(lat, lon);
    if (d != null) return d;
    return this.layerHeightAt(lat, lon, true);
  }
  /** Raster layers only (finest first): L1, then C11 (outside L1, when `c11`), then L0. */
  layerHeightAt(lat, lon, c11 = true) {
    for (let level = LAYERS.length - 1; level >= 0; level--) {
      if (level === 0 && c11 && this.wtiles) { const c = this.wtiles.heightAtC11(lat, lon); if (c != null) return c; }
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
  /**
   * The height the coarse world SHOWS at a point (the morph source of a detail tile): C11 for a D14 tile when one is
   * attached there (its water offset), else the L1 / L0 mesh height (coarse water sits 4 m under its depth).
   */
  coarseHeightAt(lat, lon, z = 14) {
    if (z === 14 && this.wtiles && !this.inLayer(1, lat, lon)) { const c = this.wtiles.heightAtC11(lat, lon); if (c != null) return c < 0 ? c - 2.5 : c; }
    const h = this.layerHeightAt(lat, lon, false);
    return h == null ? null : h < 0 ? h - 4 : h;
  }
  dispose() {
    this.wtiles?.dispose();
    for (const id of [...this.patches.keys()]) this.removePatch(id, false);
    for (const [key, t] of [...this.tiles]) this.dropTile(key, t);
    this.scene.remove(this.group); this.mat.dispose();
  }
}

// ------------------------------------------------------------------------------------------------ shoreline field
/**
 * RGBA field over the patch for the ocean's shoreline foam: R = signed distance to any obstacle, G = signed distance
 * to a NATURAL shore (land / breakwater rubble — quays and pontoons excluded: deep-water walls do not break waves),
 * both as clamp((d + 8) × 4) bytes; B = exposure: how open the water within ~300 m is (a max filter of the water-side
 * distance), so sheltered basins get a faint wash and the open coast gets surf.
 */
function buildShoreField(entry) {
  const n = entry.n, res = entry.res, mask = entry.mask;
  const sdf = entry.sdf && entry.sdf.length === n * n ? entry.sdf : computeSDF(mask, n, res);
  const natural = (code) => code === M.LAND || code === M.BREAKWATER;
  const dNat = chamferTo(mask, n, natural);                       // cells ×3 to the nearest natural-shore cell
  // exposure: dilate the (clamped) water-side distance with a ~300 m square window
  const open = new Float32Array(n * n);
  for (let k = 0; k < n * n; k++) open[k] = Math.min(400, Math.max(0, sdf[k]));
  const r = Math.max(1, Math.round(300 / res));
  const tmp = new Float32Array(n * n), dil = new Float32Array(n * n);
  dilateRows(open, tmp, n, r); dilateCols(tmp, dil, n, r);
  const data = new Uint8Array(n * n * 4);
  const enc = (d) => Math.max(0, Math.min(255, Math.round((d + 8) * 4)));
  for (let k = 0; k < n * n; k++) {
    const o = k * 4, code = mask[k];
    data[o] = enc(sdf[k]);
    let dn;
    if (natural(code)) dn = sdf[k];                                  // inside land / rubble: depth into it (negative)
    else if (code === M.QUAY || code === M.PONTOON) dn = 60;         // walls: no surf
    else dn = dNat[k] >= 1 << 28 ? 60 : (dNat[k] / 3 - 0.5) * res;   // water: distance to the nearest natural shore
    data[o + 1] = enc(dn);
    const e = Math.max(0, Math.min(1, (dil[k] - 40) / 220));
    data[o + 2] = Math.round(e * e * (3 - 2 * e) * 255);
    data[o + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping; tex.flipY = false;
  tex.needsUpdate = true;
  return { tex };
}
/** 3-4 chamfer distance (cells × 3) from every cell to the nearest cell for which `isTarget(mask)` holds. */
function chamferTo(mask, n, isTarget) {
  const INF = 1 << 29, d = new Int32Array(n * n);
  for (let k = 0; k < n * n; k++) d[k] = isTarget(mask[k]) ? 0 : INF;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i; let v = d[k]; if (v === 0) continue;
    if (i > 0 && d[k - 1] + 3 < v) v = d[k - 1] + 3;
    if (j > 0) { if (d[k - n] + 3 < v) v = d[k - n] + 3; if (i > 0 && d[k - n - 1] + 4 < v) v = d[k - n - 1] + 4; if (i < n - 1 && d[k - n + 1] + 4 < v) v = d[k - n + 1] + 4; }
    d[k] = v;
  }
  for (let j = n - 1; j >= 0; j--) for (let i = n - 1; i >= 0; i--) {
    const k = j * n + i; let v = d[k]; if (v === 0) continue;
    if (i < n - 1 && d[k + 1] + 3 < v) v = d[k + 1] + 3;
    if (j < n - 1) { if (d[k + n] + 3 < v) v = d[k + n] + 3; if (i < n - 1 && d[k + n + 1] + 4 < v) v = d[k + n + 1] + 4; if (i > 0 && d[k + n - 1] + 4 < v) v = d[k + n - 1] + 4; }
    d[k] = v;
  }
  return d;
}
/** running max over a window of ±r cells (van Herk / Gil-Werman: O(n) per line whatever r) */
function dilateLine(src, dst, len, r, at, put, g, h) {
  const w = 2 * r + 1;
  for (let i = 0; i < len; i++) g[i] = i % w === 0 ? at(src, i) : Math.max(g[i - 1], at(src, i));
  for (let i = len - 1; i >= 0; i--) h[i] = i === len - 1 || i % w === w - 1 ? at(src, i) : Math.max(h[i + 1], at(src, i));
  for (let i = 0; i < len; i++) put(dst, i, Math.max(h[Math.max(0, i - r)], g[Math.min(len - 1, i + r)]));
}
function dilateRows(src, dst, n, r) {
  const g = new Float32Array(n), h = new Float32Array(n);
  for (let j = 0; j < n; j++) { const o = j * n; dilateLine(src, dst, n, r, (a, i) => a[o + i], (a, i, v) => { a[o + i] = v; }, g, h); }
}
function dilateCols(src, dst, n, r) {
  const g = new Float32Array(n), h = new Float32Array(n);
  for (let i0 = 0; i0 < n; i0++) dilateLine(src, dst, n, r, (a, j) => a[j * n + i0], (a, j, v) => { a[j * n + i0] = v; }, g, h);
}
/** metres from (lat, lon) to the nearest point of a lat/lon box (0 inside) */
function distToBox(lat, lon, b) {
  const la = Math.min(b.latMax, Math.max(b.latMin, lat)), lo = Math.min(b.lonMax, Math.max(b.lonMin, lon));
  const dy = (lat - la) * GEO.M_PER_DEG_LAT, dx = (lon - lo) * GEO.M_PER_DEG_LON_EQ * Math.cos(lat * D2R);
  return Math.hypot(dx, dy);
}
function hash2(a, b) { let h = (a * 374761393 + b * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
