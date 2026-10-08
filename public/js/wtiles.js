// World detail tiles on the client (docs/WORLD-DETAIL-STREAMING.md §3.6.3, §3.7 — Lane B).
//
// WorldTileSet streams the server's SLWT tiles (/api/wt/:z/:x/:y) around the camera focus and the own ship, builds their
// meshes in a module worker (wtworker.js → wtmesh.js) and attaches them in the floating-origin frame:
//   D14 near  ≤ 1.2 km (phone 0.8): terrain LOD 256 (phone 128), quay walls, piers, breakwaters, bridges, all buildings,
//             cranes / tanks / lights instanced
//   D14 mid   ≤ 3.5 km (phone 2.2): terrain LOD 128 (64 beyond 2.5 km / phone 1.6 km), buildings < 6 m dropped there
//   C11       ≤ 30 km (phone 18), outside the L1 region window only (same precedence as the server's stack): terrain
//   L0/L1     beyond, and under everything until finer data is attached (terrain.js)
// Never a hole: the coarser layers are not modified; their fragments are discarded inside the footprint of an attached
// finer mesh (shader clip rectangles, CLIP below), and the clip rectangle is added in the same call that attaches the
// mesh, i.e. in the same frame. A new terrain mesh morphs from the coarse heights to its own over 0.6 s (uMorph),
// structures grow from the ground over 0.4 s. A tile the server cannot give (404 / X-WT: fallback) simply never
// replaces the coarse world. Harbour patches keep precedence: D14 fragments inside a patch footprint are discarded.
//
// Queries (same surface as HarborGeomSet where it matters): heightAt (D14), heightAtC11, maskAt, sdfAt, entryNear —
// terrain.js and collision.js fall through to them. Budgets (wtmesh.js BUDGET): desktop ≤ 150 MB geometry / 25 D14
// meshes / 2 worker builds at a time, phone ≤ 50 MB / 9 / 1; decoded tiles LRU 400 / 150; ≤ 4 fetches in flight.
import * as THREE from 'three';
import { WT, tileKey, tilesInRadius, cellOf, tileHeightAt, tileMaskAt, tileFToLatLon, decodeTile } from '/shared/wtformat.js';
import { LAYERS } from '/shared/constants.js';
import { fromLocal, toLocal } from '/shared/geo.js';
import { tileFrame, placement, boxPlacement, terrainIndex, tileSDF, buildTile, BUDGET, LOD, WT_TO_PATCH } from './wtmesh.js';
import { setWorldTiles } from './collision.js';
import { setShoreField } from './ocean2.js';

const MAX_FETCH = 4;
const MORPH_MS = 600, GROW_MS = 400;
const NO_D14_CAM_H = 2000;          // camera higher than this: no D14 detail (only the ship's own ring for physics)
const HYST = 1.3;                    // unload / downgrade at 1.3 × the ring radius
const SDF_KEEP = 16;
const COARSE_N = 16;                 // coarse samples per tile edge for the morph
const SHORE_ID = 'wt-detail';        // ocean2 shore field: surf on natural D14 shores, none along quay walls
const SHORE_MS = 2500;
const D2R = Math.PI / 180;

// ------------------------------------------------------------------------------------------------ clip rectangles
/**
 * A clip set: up to `max` sheared rectangles (see wtmesh placement()) in world x/z; fragments of a material using the
 * set are discarded inside any of them. A = (tx, tz, s, h), B = (wN, wS, inset, 0); box = union bounds (fast reject).
 */
function makeClipSet(max) {
  return {
    max,
    uClipN: { value: 0 },
    uClipA: { value: Array.from({ length: max }, () => new THREE.Vector4()) },
    uClipB: { value: Array.from({ length: max }, () => new THREE.Vector4()) },
    uClipBox: { value: new THREE.Vector4(1e9, 1e9, -1e9, -1e9) },
  };
}
/** d14: harbour patch footprints · c11: attached D14 + patches · coarse (L0 / L1): attached D14 + C11. */
export const CLIP = { d14: makeClipSet(16), c11: makeClipSet(48), coarse: makeClipSet(64) };

/**
 * Add the clip test to a material (keeps an existing onBeforeCompile, e.g. terrain.js's drape). `name` selects the set
 * and becomes part of the program cache key, so every material of a set shares one program.
 */
export function applyClip(mat, name) {
  const set = CLIP[name];
  const prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey && mat.hasOwnProperty('customProgramCacheKey') ? mat.customProgramCacheKey.bind(mat) : null;
  mat.onBeforeCompile = (sh, r) => {
    if (prev) prev.call(mat, sh, r);
    sh.uniforms.uClipN = set.uClipN; sh.uniforms.uClipA = set.uClipA; sh.uniforms.uClipB = set.uClipB; sh.uniforms.uClipBox = set.uClipBox;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vSlClip;')
      .replace('#include <project_vertex>', `#include <project_vertex>
  { vec4 slw = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    slw = instanceMatrix * slw;
  #endif
    vSlClip = (modelMatrix * slw).xz; }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec2 vSlClip; uniform int uClipN; uniform vec4 uClipA[${set.max}]; uniform vec4 uClipB[${set.max}]; uniform vec4 uClipBox;
bool slClipped(vec2 p) {
  if (uClipN == 0 || p.x < uClipBox.x || p.y < uClipBox.y || p.x > uClipBox.z || p.y > uClipBox.w) return false;
  for (int k = 0; k < ${set.max}; k++) {
    if (k >= uClipN) break;
    vec4 a = uClipA[k]; vec4 b = uClipB[k];
    float z = p.y - a.y;
    if (z < b.z || z > a.w - b.z) continue;
    float x = p.x - a.x - a.z * z, w = b.x + (b.y - b.x) * (z / a.w);
    if (x >= b.z && x <= w - b.z) return true;
  }
  return false;
}`)
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n  if (slClipped(vSlClip)) discard;');
  };
  const base = prevKey ? prevKey() : (prev ? String(prev) : '');
  mat.customProgramCacheKey = () => `${base}|slclip-${name}`;
  mat.needsUpdate = true;
  return mat;
}

/** D14 / C11 terrain material: vertex colours, morph from the coarse heights (uMorph), pushed back in depth so the
 *  structures standing on it never z-fight, clipped by `clip`. One program, one material per mesh (own uMorph). */
function makeTerrainMaterial(clip) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2 });
  const uMorph = { value: 1 };
  m.userData.uMorph = uMorph;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uMorph = uMorph;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float morphY; uniform float uMorph;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  transformed.y = mix(morphY, transformed.y, uMorph);');
  };
  m.customProgramCacheKey = () => 'saltline-wt-terrain-1';
  return applyClip(m, clip);
}

// ------------------------------------------------------------------------------------------------ shared instance geometry
function mergeBoxes(boxes) {
  // boxes: [w, h, d, x, y, z] → one BufferGeometry
  const geos = boxes.map(([w, h, d, x, y, z]) => new THREE.BoxGeometry(w, h, d).translate(x, y, z));
  let n = 0, ni = 0; for (const g of geos) { n += g.attributes.position.count; ni += g.index.count; }
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), idx = new Uint16Array(ni);
  let o = 0, oi = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, o * 3); nrm.set(g.attributes.normal.array, o * 3);
    for (let i = 0; i < g.index.count; i++) idx[oi + i] = g.index.array[i] + o;
    o += g.attributes.position.count; oi += g.index.count; g.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3)); g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}
let SHARED = null;
function shared() {
  if (SHARED) return SHARED;
  // ship-to-shore gantry for h = 1 (scaled by the crane height); the boom points along −z (north) at hdg 0
  const sts = mergeBoxes([
    [0.025, 0.66, 0.025, -0.2, 0.33, -0.12], [0.025, 0.66, 0.025, 0.2, 0.33, -0.12], [0.025, 0.66, 0.025, -0.2, 0.33, 0.12], [0.025, 0.66, 0.025, 0.2, 0.33, 0.12],
    [0.44, 0.03, 0.03, 0, 0.64, -0.12], [0.44, 0.03, 0.03, 0, 0.64, 0.12], [0.44, 0.02, 0.02, 0, 0.2, -0.12], [0.44, 0.02, 0.02, 0, 0.2, 0.12],
    [0.05, 0.035, 1.5, -0.08, 0.66, -0.4], [0.05, 0.035, 1.5, 0.08, 0.66, -0.4], [0.14, 0.02, 1.5, 0, 0.68, -0.4],
    [0.2, 0.07, 0.16, 0, 0.71, 0.12], [0.03, 0.3, 0.03, 0, 0.83, 0.05],
  ]);
  const tower = mergeBoxes([[0.06, 1, 0.06, 0, 0.5, 0], [0.04, 0.04, 0.8, 0, 0.97, -0.25], [0.12, 0.1, 0.12, 0, 0.9, 0.05]]);
  const tank = new THREE.CylinderGeometry(1, 1, 1, 20, 1).translate(0, 0.5, 0);
  const light = new THREE.CylinderGeometry(0.55, 1, 1, 10, 1).translate(0, 0.5, 0);
  const mat = applyClip(new THREE.MeshLambertMaterial({ color: 0xffffff }), 'd14');
  const structMat = applyClip(new THREE.MeshLambertMaterial({ vertexColors: true }), 'd14');
  SHARED = { sts, tower, tank, light, mat, structMat, index: new Map() };
  return SHARED;
}
function sharedIndex(lod) {
  const S = shared();
  let a = S.index.get(lod);
  if (!a) { a = new THREE.BufferAttribute(terrainIndex(lod), 1); S.index.set(lod, a); }
  return a;
}
const CRANE_COLOURS = [0x2f6db5, 0xc8392b, 0xe9e6dc, 0xf2b632, 0x2e8b57];
const LIGHT_COLOURS = [0xd03025, 0x25a040, 0xf0c020, 0xf2f2ee, 0x202020];

// ------------------------------------------------------------------------------------------------ WorldTileSet
export class WorldTileSet {
  /**
   * opts: { parent (Object3D), origin {lat, lon}, halfRes (phone budgets), coarseAt(lat, lon) → displayed coarse height
   * (morph source), fetch (injectable), worker: false (build inline), enabled }
   */
  constructor(opts = {}) {
    this.parent = opts.parent || null;
    this.group = new THREE.Group(); this.group.name = 'world-tiles';
    if (this.parent) this.parent.add(this.group);
    this.origin = opts.origin || { lat: 0, lon: 0 };
    this.mobile = !!opts.halfRes;
    this.B = this.mobile ? BUDGET.mobile : BUDGET.desktop;
    this.R = this.mobile
      ? { near: 800, mid: 2200, far: 1600, c11: 18000, lodNear: LOD.MID, lodMid: LOD.FAR, lodFar: LOD.FAR, lodC11: LOD.C11_LOW }
      : { near: 1200, mid: 3500, far: 2500, c11: 30000, lodNear: LOD.NEAR, lodMid: LOD.MID, lodFar: LOD.FAR, lodC11: LOD.C11 };
    this.coarseAt = opts.coarseAt || (() => null);
    this.shoreFn = opts.shoreField || null;      // (entry {n, res, mask}) → { tex } (terrain.js buildShoreField)
    this.shore = null; this.shoreDirty = false; this.shoreAt = 0;
    this.fetchFn = opts.fetch || ((u, o) => fetch(u, o));
    this.enabled = opts.enabled !== false;
    this.meta = null; this.metaState = 'none'; this.metaRetry = 0;
    this.entries = new Map();           // key → entry
    this.inflight = 0; this.building = 0; this.jobSeq = 0; this.jobs = new Map();
    this.version = 0;                    // bumps when tile data (heights) changes
    this.entriesV = 0; this.hit = {};    // lookup cache (invalidated whenever an entry is added / removed)
    this.listeners = [];
    this.patchBoxes = [];
    this.focus = null; this.ship = null; this.camH = 0;
    this.st = { fetched: 0, notModified: 0, missing: 0, errors: 0, built: 0, buildMs: 0, buildMsMax: 0, attachMsMax: 0, attached: 0, evicted: 0 };
    this.failStreak = 0; this.pauseUntil = 0;
    this.miss = { 11: 0, 14: 0 }; this.zPause = { 11: 0, 14: 0 }; this.okZ = {};   // a zoom the server keeps answering 404 for is paused
    this.workers = [];
    this.useWorker = opts.worker !== false && typeof Worker !== 'undefined';
    this.shown = false;
    setWorldTiles(this);
  }

  // ---------------------------------------------------------------- public surface
  /** Call every ~500 ms: focus {lat, lon} (camera look point), ship {lat, lon}, opts {camH}. */
  update(focus, ship, opts = {}) {
    if (!this.enabled) return;
    if (this.metaState !== 'ok') { this.loadMeta(); if (this.metaState !== 'ok') return; }
    this.focus = focus && Number.isFinite(focus.lat) ? focus : ship;
    this.ship = ship && Number.isFinite(ship.lat) ? ship : focus;
    if (!this.focus || !this.ship) return;
    this.camH = Number(opts.camH) || 0;
    this.plan();
    this.pumpFetch();
    this.pumpBuild();
    this.trim();
    this.updateShore(false);
  }
  setOrigin(origin) {
    this.origin = origin;
    for (const e of this.entries.values()) if (e.mesh) this.place(e);
    this.updateClips();
    this.updateShore(true);
  }
  /** Harbour patch footprints (lat/lon boxes): D14 detail is hidden inside them (patches keep precedence). */
  setPatchBoxes(boxes) { this.patchBoxes = (boxes || []).filter(Boolean); this.updateClips(); this.shoreDirty = true; }
  /** The server's `wt` push ({t:'wt', k:'14/x/y', rev}): refetch that tile (keeps the old mesh until the new one). */
  onPush(m) {
    const e = m && this.entries.get(String(m.k));
    if (!e) return;
    if (e.data && Number.isFinite(m.rev) && e.data.rev === m.rev && !e.raw) { /* same revision known: still revalidate */ }
    e.stale = true; e.retryAt = 0; e.raw = null;
    this.pumpFetch();
  }
  onReady(fn) { if (typeof fn === 'function') this.listeners.push(fn); return () => { const i = this.listeners.indexOf(fn); if (i >= 0) this.listeners.splice(i, 1); }; }
  get(z, x, y) { return this.entries.get(tileKey(z, x, y))?.data || null; }
  /** D14 height (m) at a point, null when that tile is not loaded. */
  heightAt(lat, lon) { return this.heightAtZ(WT.Z_DETAIL, lat, lon); }
  heightAtC11(lat, lon) { return this.heightAtZ(WT.Z_COAST, lat, lon); }
  heightAtZ(z, lat, lon) {
    if (!this.entries.size) return null;
    const c = cellOf(z, lat, lon);
    // the ocean depth texture asks 25 k points in a row: remember the last tile per zoom (no key string per call)
    let h = this.hit[z];
    if (!h || h.x !== c.x || h.y !== c.y || h.v !== this.entriesV) h = this.hit[z] = { x: c.x, y: c.y, v: this.entriesV, e: this.entries.get(tileKey(z, c.x, c.y)) || null };
    const e = h.e;
    if (!e || !e.data) return null;
    return tileHeightAt(e.data, c.u, c.v);
  }
  maskAt(lat, lon) {
    const c = cellOf(WT.Z_DETAIL, lat, lon), e = this.entries.get(tileKey(WT.Z_DETAIL, c.x, c.y));
    return e?.data ? tileMaskAt(e.data, c.u, c.v) : null;
  }
  /**
   * A loaded D14 entry that is not open sea under the point or within `marginM` of it (collision pre-check, like
   * HarborGeomSet.entryNear), else null.
   */
  entryNear(lat, lon, marginM = 0) {
    if (!this.entries.size) return null;
    const dLat = marginM / 110574, dLon = marginM / (111320 * Math.max(0.05, Math.cos(lat * D2R)));
    const pts = marginM > 0 ? [[lat, lon], [lat + dLat, lon], [lat - dLat, lon], [lat, lon + dLon], [lat, lon - dLon]] : [[lat, lon]];
    for (const [la, lo] of pts) {
      const c = cellOf(WT.Z_DETAIL, la, lo), e = this.entries.get(tileKey(WT.Z_DETAIL, c.x, c.y));
      if (!e?.data) continue;
      if (!e.data.mask && !(e.data.flags & WT.FLAG.UNIFORM_LAND)) continue;
      return e;
    }
    return null;
  }
  /** Signed distance (m, > 0 in water) with the outward unit gradient (x east, z south) — patchSdfAt's shape. */
  sdfAt(lat, lon) {
    const c = cellOf(WT.Z_DETAIL, lat, lon), e = this.entries.get(tileKey(WT.Z_DETAIL, c.x, c.y));
    if (!e?.data) return null;
    const t = e.data;
    if (!t.mask) return (t.flags & WT.FLAG.UNIFORM_LAND) ? { d: -50, gx: 0, gz: -1, mask: 1, wt: e.key } : null;
    if (!e.sdf) { e.sdf = tileSDF(t); this.sdfLru(e); }
    e.sdfUsed = performance.now();
    const n = t.n, s = e.sdf, res = e.frame.sizeM / n;
    const bil = (i, j) => {
      const u = Math.min(n - 1.0001, Math.max(0, i - 0.5)), v = Math.min(n - 1.0001, Math.max(0, j - 0.5));
      const i0 = Math.floor(u), j0 = Math.floor(v), fx = u - i0, fy = v - j0, i1 = Math.min(n - 1, i0 + 1), j1 = Math.min(n - 1, j0 + 1);
      return (s[j0 * n + i0] * (1 - fx) + s[j0 * n + i1] * fx) * (1 - fy) + (s[j1 * n + i0] * (1 - fx) + s[j1 * n + i1] * fx) * fy;
    };
    const d = bil(c.u, c.v);
    let gx = (bil(c.u + 1, c.v) - bil(c.u - 1, c.v)) / (2 * res), gz = (bil(c.u, c.v + 1) - bil(c.u, c.v - 1)) / (2 * res);
    const l = Math.hypot(gx, gz);
    if (l > 1e-6) { gx /= l; gz /= l; } else { gx = 0; gz = -1; }
    const m = t.mask[Math.min(n - 1, Math.floor(c.v)) * n + Math.min(n - 1, Math.floor(c.u))];
    return { d, gx, gz, mask: WT_TO_PATCH[m] ?? 1, wt: e.key };
  }
  /** Attribution line once detail has been shown (HUD credits), else null. */
  attribution() { return this.shown && this.meta ? this.meta.attribution : null; }
  /** Number of wanted D14 tiles near the focus that are not drawn yet (HUD "detail loading" dot). */
  loading() {
    let n = 0;
    for (const e of this.entries.values()) if (e.z === WT.Z_DETAIL && e.want && e.d <= this.R.near && !e.mesh && !e.missing) n++;
    return n;
  }
  stats() {
    let d14 = 0, c11 = 0, bytes = 0, data = 0, raw = 0, missing = 0, verts = 0, tris = 0;
    for (const e of this.entries.values()) {
      if (e.mesh) { if (e.z === WT.Z_DETAIL) d14++; else c11++; bytes += e.mesh.bytes; verts += e.mesh.verts; tris += e.mesh.tris; }
      if (e.data) data++; if (e.raw) raw += e.raw.byteLength; if (e.missing) missing++;
    }
    return { enabled: this.enabled, meta: this.metaState, d14, c11, geomMB: +(bytes / 1048576).toFixed(1), verts, tris, decoded: data, rawMB: +(raw / 1048576).toFixed(1), missing, inflight: this.inflight, building: this.building, loading: this.loading(), ...this.st, buildMsAvg: this.st.built ? +(this.st.buildMs / this.st.built).toFixed(1) : 0 };
  }
  dispose() {
    for (const e of this.entries.values()) { this.dropMesh(e); e.abort?.abort(); }
    this.entries.clear();
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.parent?.remove(this.group);
    if (this.shore) { setShoreField(SHORE_ID, null); this.shore.tex.dispose(); this.shore = null; }
    setWorldTiles(null);
  }

  /** Focus point of a camera: where its view ray meets the sea (≤ 4 km ahead), with the camera height. */
  static focusFromCamera(camera, origin) {
    if (!camera) return null;
    const p = camera.position, dir = new THREE.Vector3(); camera.getWorldDirection(dir);
    const camH = Math.max(0, p.y);
    let t = dir.y < -1e-3 ? -p.y / dir.y : Infinity;
    const hl = Math.hypot(dir.x, dir.z) || 1;
    const maxT = 4000 / hl;
    if (!(t < maxT)) t = maxT;
    const x = p.x + dir.x * t, z = p.z + dir.z * t;
    const ll = fromLocal(x, z, origin);
    return { lat: ll.lat, lon: ll.lon, camH };
  }

  // ---------------------------------------------------------------- planning
  loadMeta() {
    if (this.metaState === 'loading' || performance.now() < this.metaRetry) return;
    this.metaState = 'loading';
    this.fetchFn('/api/wt/meta', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).then((m) => {
      if (m && m.format === WT.FORMAT && !m.disabled) { this.meta = m; this.metaState = 'ok'; }
      else { this.metaState = m?.disabled ? 'off' : 'none'; this.metaRetry = performance.now() + (m?.disabled ? 600e3 : 60e3); }
    }).catch(() => { this.metaState = 'none'; this.metaRetry = performance.now() + 60e3; });
  }
  entry(z, x, y) {
    const key = tileKey(z, x, y);
    let e = this.entries.get(key);
    if (!e) { e = { key, z, x, y, frame: tileFrame(z, x, y), d: Infinity, want: null, data: null, raw: null, etag: null, mesh: null, used: 0, retryAt: 0, tries: 0 }; this.entries.set(key, e); this.entriesV++; }
    return e;
  }
  plan() {
    const R = this.R, f = this.focus, s = this.ship, now = performance.now();
    for (const e of this.entries.values()) { e.want = null; e.d = Infinity; }
    // D14: focus rings (camera low enough) and the ship's own near ring (physics + what is around the hull)
    const d14 = new Map();
    const add = (list, from) => { for (const t of list) { const k = tileKey(t.z, t.x, t.y), o = d14.get(k); if (!o || t.d < o.d) d14.set(k, { ...t, from }); } };
    if (this.camH <= NO_D14_CAM_H) add(tilesInRadius(WT.Z_DETAIL, f.lat, f.lon, R.mid * HYST), 'focus');
    add(tilesInRadius(WT.Z_DETAIL, s.lat, s.lon, R.near), 'ship');
    const list = [...d14.values()].sort((a, b) => a.d - b.d);
    let count = 0;
    for (const t of list) {
      const e = this.entry(t.z, t.x, t.y);
      e.d = t.d; e.used = now;
      const inRing = t.d <= R.mid;
      if (!inRing && !e.mesh) continue;                      // hysteresis band: keep what is attached, load nothing new
      if (count >= this.B.d14Meshes) continue;
      count++;
      e.want = t.d <= R.near ? 'near' : t.d <= R.far ? 'mid' : 'far';
      e.lod = e.want === 'near' ? R.lodNear : e.want === 'mid' ? R.lodMid : R.lodFar;
      // LOD hysteresis: keep a finer mesh until 1.3 × its ring
      if (e.mesh && e.mesh.lod > e.lod && t.d <= (e.mesh.lod >= R.lodNear ? R.near : R.far) * HYST) { e.lod = e.mesh.lod; e.want = e.mesh.mode; }
    }
    // C11: outside the L1 region window only (the server's precedence: L1 before C11)
    const L1 = LAYERS[1];
    const inL1 = (lat, lon, m = 0) => lat >= L1.latMin - m && lat < L1.latMax + m && lon >= L1.lonMin - m && lon < L1.lonMax + m;
    if (!inL1(f.lat, f.lon, -0.05)) {
      let c = 0;
      for (const t of tilesInRadius(WT.Z_COAST, f.lat, f.lon, R.c11 * HYST)) {
        const fr = tileFrame(t.z, t.x, t.y);
        if (fr.latS < L1.latMax && fr.latN > L1.latMin && fr.lonW < L1.lonMax && fr.lonE > L1.lonMin) continue;
        const e = this.entry(t.z, t.x, t.y);
        e.d = t.d; e.used = now;
        if (t.d > R.c11 && !e.mesh) continue;
        if (c >= this.B.c11Meshes) continue;
        c++;
        e.want = 'c11'; e.lod = R.lodC11;
      }
    }
    // unload meshes no longer wanted, abort their fetches
    let changed = false;
    for (const e of this.entries.values()) {
      if (e.want) continue;
      if (e.mesh) { this.dropMesh(e); changed = true; }
      if (e.abort) { e.abort.abort(); e.abort = null; }
    }
    if (changed) this.updateClips();
  }

  // ---------------------------------------------------------------- fetching
  pumpFetch() {
    const now = performance.now();
    if (now < this.pauseUntil) return;
    const cands = [];
    for (const e of this.entries.values()) {
      if (!e.want || e.abort || e.building || e.retryAt > now || this.zPause[e.z] > now) continue;
      const needRaw = (!e.data || e.stale) || (!e.raw && this.needsBuild(e));
      if (needRaw) cands.push(e);
    }
    cands.sort((a, b) => a.d - b.d);
    for (const e of cands) { if (this.inflight >= MAX_FETCH) break; this.fetchTile(e); }
  }
  async fetchTile(e) {
    const ac = new AbortController();
    e.abort = ac; this.inflight++;
    const url = `/api/wt/${e.z}/${e.x}/${e.y}`;
    try {
      // cache: 'no-cache' → the browser revalidates with the ETag it holds (304 → its cached bytes): no re-download
      const r = await this.fetchFn(url, { signal: ac.signal, cache: 'no-cache', credentials: 'same-origin' });
      if (r.status === 200) {
        const buf = await r.arrayBuffer();
        const etag = r.headers?.get?.('ETag') || null;
        this.failStreak = 0; e.tries = 0; e.missing = false; this.miss[e.z] = 0; this.okZ[e.z] = true;
        if (etag && etag === e.etag && e.data && !this.needsBuild(e)) { this.st.notModified++; e.stale = false; e.raw = buf; }
        else { e.raw = buf; e.etag = etag; e.dirty = true; e.stale = false; this.st.fetched++; }
      } else if (r.status === 304) { e.stale = false; this.st.notModified++; }
      else if (r.status === 503) { const ra = Number(r.headers?.get?.('Retry-After')) || 2; e.retryAt = performance.now() + ra * 1000; }
      else { // 404 + X-WT: fallback (source down, nothing cached) / 400: keep the coarse world, ask again later
        e.missing = true; e.retryAt = performance.now() + (r.status === 400 ? 3600e3 : 120e3); e.stale = false; this.st.missing++;
        // the browser logs every 404: after 4 in a row at a zoom (e.g. no C11 source) only one probe per 5 min
        // (only a zoom that never answered 200 this session: a gap in coverage must not stall the tiles that exist)
        if (++this.miss[e.z] >= 4 && !this.okZ[e.z]) { this.zPause[e.z] = performance.now() + 300e3; this.miss[e.z] = 3; }
      }
    } catch (err) {
      if (err?.name !== 'AbortError') {
        this.st.errors++; e.tries++; e.retryAt = performance.now() + Math.min(60e3, 2000 * 2 ** e.tries);
        if (++this.failStreak >= 6) { this.pauseUntil = performance.now() + 30e3; this.failStreak = 0; }
      }
    } finally {
      if (e.abort === ac) e.abort = null;
      this.inflight--;
    }
    this.pumpBuild();
    this.pumpFetch();
  }

  // ---------------------------------------------------------------- building
  needsBuild(e) {
    if (!e.want) return false;
    if (e.dirty) return true;
    if (!e.mesh) return true;
    return e.mesh.lod !== e.lod || e.mesh.mode !== e.want;
  }
  pumpBuild() {
    if (this.building >= this.B.builds) return;
    const cands = [];
    for (const e of this.entries.values()) if (e.want && e.raw && !e.building && this.needsBuild(e)) cands.push(e);
    cands.sort((a, b) => a.d - b.d);
    for (const e of cands) { if (this.building >= this.B.builds) break; this.startBuild(e); }
  }
  buildOpts(e) {
    const far = e.want === 'far';
    const o = { lod: e.lod, structures: e.z === WT.Z_DETAIL, maxBuildings: this.B.buildings, maxVerts: this.B.structVerts, minBuildingH: far ? 6 : 0 };
    // coarse heights over the tile for the morph (what the coarse world shows there now)
    const n = COARSE_N, h = new Float32Array((n + 1) * (n + 1));
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
      const ll = tileFToLatLon(e.z, e.x + i / n, e.y + j / n);
      const v = this.coarseAt(ll.lat, ll.lon, e.z);
      h[j * (n + 1) + i] = Number.isFinite(v) ? v : NaN;
    }
    o.coarse = { n, h };
    return o;
  }
  startBuild(e) {
    const id = ++this.jobSeq, opts = this.buildOpts(e);
    e.building = id; e.dirty = false; this.building++;
    const job = { id, e, lod: e.lod, mode: e.want, t0: performance.now() };
    this.jobs.set(id, job);
    if (this.useWorker) {
      const w = this.worker(id);
      if (w) { w.postMessage({ id, buf: e.raw, opts }); return; }
    }
    // inline fallback (no Worker): one tile per macrotask
    setTimeout(() => {
      try {
        const t = decodeTile(new Uint8Array(e.raw));
        const r = buildTile(t, opts);
        this.onBuilt({ id, ok: true, tile: { z: t.z, x: t.x, y: t.y, flags: t.flags, n: t.n, rev: t.rev, uniformH: t.uniformH, srcHash: t.srcHash, contentHash: t.contentHash, mask: t.mask, height: t.height, src: t.vectors?.src ?? null, ov: t.vectors?.ov ?? null }, terrain: r.terrain, structures: r.structures, bytes: r.bytes, ms: r.ms });
      } catch (err) { this.onBuilt({ id, ok: false, error: String(err?.message || err) }); }
    }, 0);
  }
  worker(id) {
    try {
      const k = id % this.B.builds;
      if (!this.workers[k]) {
        const w = new Worker(new URL('./wtworker.js', import.meta.url), { type: 'module' });
        w.onmessage = (ev) => this.onBuilt(ev.data);
        w.onerror = () => { this.useWorker = false; for (const j of [...this.jobs.values()]) if (j.e.building === j.id) { this.jobs.delete(j.id); j.e.building = 0; j.e.dirty = true; this.building = Math.max(0, this.building - 1); } };
        this.workers[k] = w;
      }
      return this.workers[k];
    } catch { this.useWorker = false; return null; }
  }
  onBuilt(msg) {
    const job = this.jobs.get(msg?.id);
    if (!job) return;
    this.jobs.delete(msg.id);
    this.building = Math.max(0, this.building - 1);
    const e = job.e;
    if (e.building === msg.id) e.building = 0;
    if (!msg.ok) { e.missing = true; e.retryAt = performance.now() + 120e3; e.raw = null; this.st.errors++; this.pumpBuild(); return; }
    this.st.built++; this.st.buildMs += msg.ms || 0; this.st.buildMsMax = Math.max(this.st.buildMsMax, msg.ms || 0);
    const prevRev = e.data ? `${e.data.rev}/${e.data.contentHash}` : null;
    e.data = msg.tile; e.sdf = null;
    if (prevRev !== `${msg.tile.rev}/${msg.tile.contentHash}`) { this.version++; for (const fn of this.listeners) { try { fn(e.key, e.data); } catch { /* listener */ } } }
    if (e.want && msg.terrain) {
      const t0 = performance.now();
      this.attach(e, msg, job);
      this.st.attachMsMax = Math.max(this.st.attachMsMax, performance.now() - t0);
    }
    this.pumpBuild();
    this.pumpFetch();
  }

  // ---------------------------------------------------------------- meshes
  attach(e, msg, job) {
    const S = shared(), first = !e.mesh, now = performance.now();
    const tr = msg.terrain;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(tr.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(tr.nrm, 3, true));
    g.setAttribute('color', new THREE.BufferAttribute(tr.col, 3, true));
    g.setAttribute('morphY', new THREE.BufferAttribute(tr.morph, 1));
    g.setIndex(sharedIndex(tr.lod));
    for (const a of Object.values(g.attributes)) a.onUpload(freeArray);   // the GPU holds them: free the JS heap
    g.boundingSphere = sphereOf(tr.pos, tr.morph);
    const mat = makeTerrainMaterial(e.z === WT.Z_DETAIL ? 'd14' : 'c11');
    const terrain = new THREE.Mesh(g, mat);
    terrain.matrixAutoUpdate = false; terrain.name = `wt-${e.key}`;
    const m = { terrain, structures: null, inst: [], lod: job.lod, mode: job.mode, bytes: msg.bytes || 0, verts: tr.verts, tris: tr.lod * tr.lod * 2, t0: now, morph: first, base: new THREE.Matrix4() };
    mat.userData.uMorph.value = first ? 0 : 1;
    terrain.onBeforeRender = () => {
      if (mat.userData.uMorph.value < 1) { const k = Math.min(1, (performance.now() - m.t0) / MORPH_MS); mat.userData.uMorph.value = k * k * (3 - 2 * k); }
    };
    const st = msg.structures;
    if (st && st.verts) {
      const sg = new THREE.BufferGeometry();
      sg.setAttribute('position', new THREE.BufferAttribute(st.pos, 3));
      sg.setAttribute('normal', new THREE.BufferAttribute(st.nrm, 3, true));
      sg.setAttribute('color', new THREE.BufferAttribute(st.col, 3, true));
      sg.setIndex(new THREE.BufferAttribute(st.verts < 65536 ? Uint16Array.from(st.idx) : st.idx, 1));
      sg.computeBoundingSphere();
      for (const a of Object.values(sg.attributes)) a.onUpload(freeArray);
      sg.index.onUpload(freeArray);
      const sm = new THREE.Mesh(sg, S.structMat);
      sm.matrixAutoUpdate = false; sm.name = `wt-${e.key}-structures`;
      m.structures = sm; m.tris += st.tris; m.verts += st.verts;
    }
    if (st?.inst) {
      const mk = (geo, arr, fill) => {
        const k = arr.length / 6; if (!k) return null;
        const im = new THREE.InstancedMesh(geo, S.mat, k);
        const M4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), c = new THREE.Color(), Y = new THREE.Vector3(0, 1, 0);
        for (let i = 0; i < k; i++) { fill(arr, i * 6, p, q, sc, c, Y); M4.compose(p, q, sc); im.setMatrixAt(i, M4); im.setColorAt(i, c); }
        im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true;
        im.matrixAutoUpdate = false; im.computeBoundingSphere?.();
        return im;
      };
      const cranes = st.inst.cranes, sts = [], other = [];
      for (let i = 0; i < cranes.length; i += 6) (cranes[i + 5] === 0 ? sts : other).push(...cranes.subarray(i, i + 6));
      const fillCrane = (a, o, p, q, sc, c, Y) => { p.set(a[o], a[o + 1], a[o + 2]); q.setFromAxisAngle(Y, -a[o + 3] * D2R); sc.setScalar(a[o + 4]); c.setHex(CRANE_COLOURS[Math.abs(Math.round(a[o] * 7 + a[o + 2] * 3)) % CRANE_COLOURS.length]); };
      for (const im of [
        mk(S.sts, Float32Array.from(sts), fillCrane),
        mk(S.tower, Float32Array.from(other), fillCrane),
        mk(S.tank, st.inst.tanks, (a, o, p, q, sc, c) => { p.set(a[o], a[o + 1] - 0.3, a[o + 2]); q.identity(); sc.set(a[o + 3], a[o + 4], a[o + 3]); c.setHex(0xd8d6d0); }),
        mk(S.light, st.inst.lights, (a, o, p, q, sc, c) => {
          const kind = a[o + 3], h = a[o + 5]; p.set(a[o], a[o + 1], a[o + 2]); q.identity();
          if (kind === 0) { sc.set(2.6, h, 2.6); c.setHex(LIGHT_COLOURS[a[o + 4]] === 0x202020 ? 0xf2f2ee : LIGHT_COLOURS[a[o + 4]] ?? 0xf2f2ee); }
          else if (kind === 2) { p.y = -0.6; sc.set(1.1, 2.6, 1.1); c.setHex(LIGHT_COLOURS[a[o + 4]] ?? 0xf0c020); }
          else { sc.set(0.5, Math.max(3, h), 0.5); c.setHex(LIGHT_COLOURS[a[o + 4]] ?? 0xf2f2ee); }
        }),
      ]) if (im) { im.name = `wt-${e.key}-inst`; m.inst.push(im); }
    }
    // grow-in for structures (scale y about the tile datum) — only on a tile's first appearance
    const grow = first ? now : -1e9;
    for (const o of [m.structures, ...m.inst]) {
      if (!o) continue;
      o.onBeforeRender = () => {
        const k = Math.min(1, (performance.now() - grow) / GROW_MS);
        o.matrix.copy(m.base); if (k < 1) o.matrix.multiply(_scaleY.makeScale(1, Math.max(0.001, k * k * (3 - 2 * k)), 1));
        o.matrixWorld.multiplyMatrices(this.group.matrixWorld, o.matrix);
      };
    }
    // swap atomically: the new meshes and the clip rectangle land in this same call (= the same frame)
    const old = e.mesh;
    e.mesh = m;
    this.place(e);
    this.group.add(terrain); if (m.structures) this.group.add(m.structures); for (const im of m.inst) this.group.add(im);
    if (old) this.disposeMesh(old);
    this.updateClips();
    this.shoreDirty = true;
    this.st.attached++;
    this.shown = true;
    // raw bytes are only kept for a later LOD change; drop them for the far rings when over the raw budget (trim)
  }
  place(e) {
    const m = e.mesh; if (!m) return;
    const p = placement(e.frame, this.origin);
    m.base.set(1, 0, p.s, p.tx, 0, 1, 0, 0, 0, 0, 1, p.tz, 0, 0, 0, 1);
    for (const o of [m.terrain, m.structures, ...m.inst]) {
      if (!o) continue;
      o.matrix.copy(m.base); o.matrixWorldNeedsUpdate = true;
    }
  }
  dropMesh(e) {
    if (!e.mesh) return;
    this.disposeMesh(e.mesh);
    e.mesh = null;
    this.st.evicted++;
  }
  disposeMesh(m) {
    this.group.remove(m.terrain); m.terrain.material.dispose();
    m.terrain.geometry.index = null; m.terrain.geometry.dispose();       // the index is shared per LOD: never disposed
    if (m.structures) { this.group.remove(m.structures); m.structures.geometry.dispose(); }
    for (const im of m.inst) { this.group.remove(im); im.dispose?.(); }
  }
  /** Clip rectangles: patches → D14, D14 (+ patches) → C11, D14 + C11 → coarse. */
  updateClips() {
    const o = this.origin;
    const d14 = [], c11 = [];
    for (const e of this.entries.values()) if (e.mesh) (e.z === WT.Z_DETAIL ? d14 : c11).push(e);
    d14.sort((a, b) => a.d - b.d); c11.sort((a, b) => a.d - b.d);
    const rectOf = (e, inset) => { const p = placement(e.frame, o); return { tx: p.tx, tz: p.tz, s: p.s, h: e.frame.h, wN: e.frame.wN, wS: e.frame.wS, inset }; };
    const patches = this.patchBoxes.map((b) => ({ ...boxPlacement(b.latMax, b.latMin, b.lonMin, b.lonMax, o), inset: 3 }));
    fillSet(CLIP.d14, patches);
    fillSet(CLIP.c11, d14.map((e) => rectOf(e, 1)).concat(patches));
    fillSet(CLIP.coarse, d14.map((e) => rectOf(e, 1)).concat(c11.map((e) => rectOf(e, 1))));
  }
  /**
   * One shoreline foam field (ocean2.setShoreField) over ≈ 3 km around the focus from the attached D14 masks: surf on
   * natural shores, a faint wash along walls, nothing in open water. Texels inside a harbour patch (its own field) or
   * where no D14 tile is loaded are neutral (no foam). Rebuilt ≤ every 2.5 s when tiles changed or the focus moved.
   */
  updateShore(force) {
    if (!this.shoreFn || !this.focus) return;
    const now = performance.now();
    const N = this.mobile ? 160 : 320, res = 16, size = N * res;   // ≈ the ocean's 5 km depth window (desktop)
    const c = toLocal(this.focus.lat, this.focus.lon, this.origin);
    const cx = Math.round(c.x / (res * 4)) * res * 4, cz = Math.round(c.z / (res * 4)) * res * 4;
    const moved = !this.shore || Math.hypot(cx - this.shore.cx, cz - this.shore.cz) > size * 0.22;
    if (!force && ((!this.shoreDirty && !moved) || now - this.shoreAt < SHORE_MS)) return;
    this.shoreAt = now; this.shoreDirty = false;
    let any = false;
    for (const e of this.entries.values()) if (e.mesh && e.z === WT.Z_DETAIL && e.data?.mask) { any = true; break; }
    if (!any) { if (this.shore) { setShoreField(SHORE_ID, null); this.shore.tex.dispose(); this.shore = null; } return; }
    const t0 = performance.now();
    const x0 = cx - size / 2, z0 = cz - size / 2;
    const mask = new Uint8Array(N * N), neutral = new Uint8Array(N * N);
    const pb = this.patchBoxes;
    let last = null;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i, ll = fromLocal(x0 + (i + 0.5) * res, z0 + (j + 0.5) * res, this.origin);
      let inPatch = false;
      for (const b of pb) if (ll.lat >= b.latMin && ll.lat <= b.latMax && ll.lon >= b.lonMin && ll.lon <= b.lonMax) { inPatch = true; break; }
      const cc = cellOf(WT.Z_DETAIL, ll.lat, ll.lon);
      const e = last && last.x === cc.x && last.y === cc.y ? last : this.entries.get(tileKey(WT.Z_DETAIL, cc.x, cc.y));
      last = e || null;
      if (!e?.data || !e.mesh) { neutral[k] = 1; continue; }
      mask[k] = WT_TO_PATCH[tileMaskAt(e.data, cc.u, cc.v)] ?? 1;
      if (inPatch) neutral[k] = 1;
    }
    let f = null;
    try { f = this.shoreFn({ n: N, res, mask }); } catch { f = null; }
    if (!f?.tex) return;
    const d = f.tex.image.data;
    for (let k = 0; k < N * N; k++) if (neutral[k]) { d[k * 4] = 255; d[k * 4 + 1] = 255; d[k * 4 + 2] = 0; }
    f.tex.needsUpdate = true;
    const old = this.shore;
    this.shore = { tex: f.tex, cx, cz };
    setShoreField(SHORE_ID, { tex: f.tex, x0, z0, size });
    old?.tex.dispose();
    this.st.shoreMs = Math.round(performance.now() - t0); this.st.shoreMsMax = Math.max(this.st.shoreMsMax || 0, this.st.shoreMs);
  }
  sdfLru(e) {
    const withSdf = [...this.entries.values()].filter((x) => x.sdf && x !== e).sort((a, b) => (a.sdfUsed || 0) - (b.sdfUsed || 0));
    while (withSdf.length >= SDF_KEEP) withSdf.shift().sdf = null;
  }
  /** Budgets: geometry MB (farthest meshes go first, never the near ring), decoded LRU, raw bytes. */
  trim() {
    const all = [...this.entries.values()];
    let bytes = 0; for (const e of all) if (e.mesh) bytes += e.mesh.bytes;
    const cap = this.B.geomMB * 1048576;
    if (bytes > cap) {
      const ms = all.filter((e) => e.mesh && e.want !== 'near').sort((a, b) => b.d - a.d);
      let changed = false;
      for (const e of ms) { if (bytes <= cap) break; bytes -= e.mesh.bytes; this.dropMesh(e); e.want = null; changed = true; }
      if (changed) this.updateClips();
    }
    // raw bytes: keep the nearest
    let raw = 0; const rawCap = this.B.rawMB * 1048576;
    const withRaw = all.filter((e) => e.raw).sort((a, b) => a.d - b.d);
    for (const e of withRaw) { raw += e.raw.byteLength; if (raw > rawCap && !e.building) e.raw = null; }
    // decoded data LRU (tiles without a mesh, least recently used first)
    const dec = all.filter((e) => e.data);
    if (dec.length > this.B.decoded) {
      const drop = dec.filter((e) => !e.mesh && !e.want && !e.building).sort((a, b) => a.used - b.used);
      for (let i = 0; i < dec.length - this.B.decoded && i < drop.length; i++) { const e = drop[i]; e.data = null; e.sdf = null; e.raw = null; this.version++; }
    }
    // forget entries that hold nothing
    const now = performance.now();
    for (const e of all) if (!e.want && !e.data && !e.mesh && !e.abort && !e.building && (!e.missing || e.retryAt < now)) { this.entries.delete(e.key); this.entriesV++; }
  }
}
const _scaleY = new THREE.Matrix4();
function freeArray() { this.array = null; }

function fillSet(set, rects) {
  const n = Math.min(set.max, rects.length);
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const r = rects[i];
    set.uClipA.value[i].set(r.tx, r.tz, r.s, r.h);
    set.uClipB.value[i].set(r.wN, r.wS, r.inset || 0, 0);
    for (const [x, z] of [[r.tx, r.tz], [r.tx + r.wN, r.tz], [r.tx + r.s * r.h, r.tz + r.h], [r.tx + r.wS + r.s * r.h, r.tz + r.h]]) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
  }
  set.uClipN.value = n;
  if (n) set.uClipBox.value.set(x0 - 1, z0 - 1, x1 + 1, z1 + 1); else set.uClipBox.value.set(1e9, 1e9, -1e9, -1e9);
}
function sphereOf(pos, morph) {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  for (let i = 0; i < morph.length; i++) { const y = morph[i]; if (Number.isFinite(y)) { if (y < y0) y0 = y; if (y > y1) y1 = y; } }
  const c = new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return new THREE.Sphere(c, Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2 + 1);
}
