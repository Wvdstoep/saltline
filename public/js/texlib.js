// Shared texture library (docs/HD-ASSET-PLAN.md §2, §3): ~24 tileable CC0 materials from ambientCG, compressed as KTX2
// (albedo + ORM: ETC1S/BasisLZ, normal: UASTC + zstd), one set per material, loaded once and shared by everything.
//
//   initTexlib(renderer)            once, after the WebGLRenderer exists (main.js): KTX2 transcoder + device tier
//   getMaterialSet(name)            → set { name, info, albedo, normal, orm, loaded, ready (Promise), release() }
//                                    ref-counted: textures load on the first acquire and are disposed when the last
//                                    holder releases them
//   makeMaterial(name, opts)        → MeshStandardMaterial on those maps (plain mean colour until they arrive), with
//                                    metre-scaled repeats, or triplanar mapping for meshes without UVs
//   window.saltlineTex()            → live estimate of the library's GPU memory (MB) per set
//
// Files: /assets/lib/<material>/{albedo,orm,normal}.ktx2 (desktop tier) and *_512.ktx2 (phone tier: half size).
// Desktop tier is 1024² (512² for the small sets glass / brass / chrome); the phone tier is half of that.
// Sources and licence (CC0 1.0): public/assets/lib/SOURCES.md.
// Phone shader rules (Adreno 660 rejects the program otherwise): no runtime-indexed uniform arrays in loops, no inout
// parameters, no discard — foliage uses alpha-to-coverage, never alphaTest.
import * as THREE from 'three';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';

const HAS_DOM = typeof window !== 'undefined' && typeof document !== 'undefined';

// ------------------------------------------------------------------------------------------------ the library
/**
 * name → { id: ambientCG asset, tile: metres one texture repeat covers, maps, mean: average albedo (sRGB hex, the
 * fallback colour), rough / metal: mean roughness / metalness (the fallback factors), size: desktop px (width), aspect:
 * width / height of the maps (default 1; brick and the leaf atlas are 2:1, so one tile is `tile` × tile / 2 metres),
 * tint: albedo is neutral grey (multiply by a paint colour; mean linear value TINT_MEAN), alpha: albedo has a cut-out mask }
 */
export const LIB = {
  painted_steel: { id: 'Paint004', tile: 2, maps: ['albedo', 'normal', 'orm'], mean: 0xe0e0e0, rough: 0.56, metal: 0, size: 1024, tint: true },
  rusted_steel: { id: 'Rust009', tile: 1.5, maps: ['albedo', 'normal', 'orm'], mean: 0x8d4d29, rough: 0.78, metal: 0, size: 1024 },
  galvanised: { id: 'Metal037', tile: 1.5, maps: ['albedo', 'normal', 'orm'], mean: 0x737575, rough: 0.51, metal: 1, size: 1024 },
  nonslip: { id: 'Rubber004', tile: 1, maps: ['albedo', 'normal', 'orm'], mean: 0xdedede, rough: 0.59, metal: 0, size: 1024, tint: true },
  teak: { id: 'Wood049', tile: 1.2, maps: ['albedo', 'normal', 'orm'], mean: 0x7c644e, rough: 0.5, metal: 0, size: 1024 },
  wood_planks: { id: 'Planks023A', tile: 2, maps: ['albedo', 'normal', 'orm'], mean: 0x5a5046, rough: 0.85, metal: 0, size: 1024 },
  concrete: { id: 'Concrete042A', tile: 2.5, maps: ['albedo', 'normal', 'orm'], mean: 0x615d59, rough: 0.7, metal: 0, size: 1024 },
  asphalt: { id: 'Asphalt025A', tile: 3, maps: ['albedo', 'normal', 'orm'], mean: 0x484743, rough: 0.67, metal: 0, size: 1024 },
  paving: { id: 'PavingStones070', tile: 2, maps: ['albedo', 'normal', 'orm'], mean: 0x8f8d87, rough: 0.52, metal: 0, size: 1024 },
  brick: { id: 'Bricks085', tile: 2, aspect: 2, maps: ['albedo', 'normal', 'orm'], mean: 0x977b6a, rough: 0.58, metal: 0, size: 1024 },
  plaster: { id: 'Plaster001', tile: 2, maps: ['albedo', 'normal', 'orm'], mean: 0xd7d3d0, rough: 0.79, metal: 0, size: 1024 },
  corrugated: { id: 'CorrugatedSteel005', tile: 2, maps: ['albedo', 'normal', 'orm'], mean: 0x9a9b9e, rough: 0.41, metal: 0.98, size: 1024 },
  roof_tiles: { id: 'RoofingTiles006', tile: 2, maps: ['albedo', 'normal', 'orm'], mean: 0x76462f, rough: 0.7, metal: 0, size: 1024 },
  glass: { id: 'Fingerprints002', tile: 1, maps: ['orm'], mean: 0x1d3f5c, rough: 0.16, metal: 0, size: 512 },
  carpet: { id: 'Carpet012', tile: 1, maps: ['albedo', 'normal', 'orm'], mean: 0x3d424f, rough: 0.88, metal: 0, size: 1024 },
  fabric: { id: 'Fabric062', tile: 0.5, maps: ['albedo', 'normal', 'orm'], mean: 0xe0e0e0, rough: 0.82, metal: 0, size: 1024, tint: true },
  leather: { id: 'Leather037', tile: 0.6, maps: ['albedo', 'normal', 'orm'], mean: 0x643829, rough: 0.4, metal: 0, size: 1024 },
  brass: { id: 'Metal048A', tile: 0.5, maps: ['albedo', 'normal', 'orm'], mean: 0xffe39c, rough: 0.09, metal: 1, size: 512 },
  chrome: { id: 'Metal049A', tile: 0.5, maps: ['albedo', 'normal', 'orm'], mean: 0xfcfbf6, rough: 0.03, metal: 1, size: 512 },
  foliage: { id: 'LeafSet026', tile: 1, aspect: 2, maps: ['albedo', 'normal', 'orm'], mean: 0x567920, rough: 0.59, metal: 0, size: 1024, alpha: true },
  bark: { id: 'Bark012', tile: 1.5, maps: ['albedo', 'normal', 'orm'], mean: 0x8c7c55, rough: 0.67, metal: 0, size: 1024 },
  sand: { id: 'Ground054', tile: 2.5, maps: ['albedo', 'normal', 'orm'], mean: 0x9c8b6e, rough: 0.67, metal: 0, size: 1024 },
  rock: { id: 'Rock030', tile: 3, maps: ['albedo', 'normal', 'orm'], mean: 0x524f48, rough: 0.69, metal: 0, size: 1024 },
  grass: { id: 'Grass004', tile: 2, maps: ['albedo', 'normal', 'orm'], mean: 0x647034, rough: 0.26, metal: 0, size: 1024 },
};
/** linear mean of a tint material's grey albedo (sRGB 0.878): multiply a paint colour by 1 / TINT_MEAN to keep its value */
export const TINT_MEAN = 0.745;
export const BASE = '/assets/lib/';
export const TRANSCODER = '/vendor/three/addons/libs/basis/';

// ------------------------------------------------------------------------------------------------ pure helpers (tests)
/**
 * Texture tier for this device: 'phone' (the _512 files) on touch / coarse-pointer devices or when the GPU has fewer
 * than 512 fragment uniform vectors (low-end), else 'desktop'. A ?tex=phone|desktop|off override wins.
 */
export function tierFor({ touch = false, coarse = false, maxFragmentUniforms = 1024, override = null } = {}) {
  if (override === 'phone' || override === 'desktop' || override === 'off') return override;
  if (touch || coarse) return 'phone';
  if (Number.isFinite(maxFragmentUniforms) && maxFragmentUniforms < 512) return 'phone';
  return 'desktop';
}
/** URL of one map of a material for a tier */
export function texPath(name, map, tier) { return `${BASE}${name}/${map}${tier === 'phone' ? '_512' : ''}.ktx2`; }
/** pixel width of a material's maps on a tier */
export function texSize(name, tier) { const e = LIB[name]; if (!e) return 0; return tier === 'phone' ? e.size / 2 : e.size; }
/** [width, height] in pixels of a material's maps on a tier */
export function texDims(name, tier) { const w = texSize(name, tier), a = LIB[name]?.aspect || 1; return [w, Math.max(1, Math.round(w / a))]; }
/** texture repeats over a surface of `metres`, for a material whose one tile covers `tile` metres (never 0) */
export function repeatFor(metres, tile) { const t = Number(tile) > 0 ? Number(tile) : 1; return Math.max(1e-3, Math.abs(Number(metres) || 0) / t); }
/** tiles per metre (the triplanar scale) of a material, or of an explicit tile size */
export function tilesPerMetre(name, tile) { const t = Number(tile) > 0 ? Number(tile) : (LIB[name]?.tile || 1); return 1 / t; }
/** [repeatU, repeatV] for a UV-mapped face of w × h metres (uv 0..1 across it); a 2:1 map's tile is half as tall */
export function repeatForSize(name, w, h, tile) { const t = Number(tile) > 0 ? Number(tile) : (LIB[name]?.tile || 1), a = LIB[name]?.aspect || 1; return [repeatFor(w, t), repeatFor(h, t / a)]; }
/** [u, v] tiles per metre for triplanar mapping (v is denser on 2:1 maps, so bricks keep their shape) */
export function triScale(name, tile) { const t = Number(tile) > 0 ? Number(tile) : (LIB[name]?.tile || 1), a = LIB[name]?.aspect || 1; return [1 / t, a / t]; }
/**
 * GPU bytes per pixel of a map once transcoded. ETC1S → ETC1 (0.5) on phones with ETC2, BC7 (1) on desktops (three's
 * KTX2Loader prefers BC7 over BC1 there); UASTC → ASTC 4×4 / BC7 (1). Alpha ETC1S → ETC2 RGBA / BC7 (1).
 */
export function bytesPerPixel(map, gpu = 'desktop', alpha = false) {
  if (map === 'normal') return 1;
  if (gpu === 'phone' && !alpha) return 0.5;
  return 1;
}
/** bytes of a w × h compressed map with a full mip chain (4×4 blocks: no level smaller than one block) */
export function mapBytes(w, h, bpp, mips = true) {
  let total = 0, x = w, y = h;
  for (;;) {
    total += Math.max(4, Math.ceil(x / 4) * 4) * Math.max(4, Math.ceil(y / 4) * 4) * bpp;
    if (!mips || (x <= 1 && y <= 1)) break;
    x = Math.max(1, x >> 1); y = Math.max(1, y >> 1);
  }
  return total;
}
/** estimated GPU bytes of one material set on a tier ('desktop' | 'phone'; gpu defaults to the tier) */
export function setBytes(name, tier, gpu = tier) {
  const e = LIB[name]; if (!e) return 0;
  const [w, h] = texDims(name, tier);
  let b = 0;
  for (const m of e.maps) b += mapBytes(w, h, bytesPerPixel(m, gpu, !!e.alpha && m === 'albedo'));
  return b;
}
/** estimated GPU MB of a list of sets (the whole library when names is omitted) */
export function budgetMB(names = Object.keys(LIB), tier = 'desktop', gpu = tier) {
  let b = 0; for (const n of names) b += setBytes(n, tier, gpu);
  return Math.round((b / 1048576) * 100) / 100;
}

/**
 * Reference-counted cache (pure: the loader and disposer are injected). acquire(key) creates the entry on first use
 * (create(key)), release(key) disposes it (destroy(entry)) when the count reaches zero.
 */
export class RefCache {
  constructor(create, destroy) { this.create = create; this.destroy = destroy; this.map = new Map(); }
  acquire(key) {
    let e = this.map.get(key);
    if (!e) { e = { key, refs: 0, value: this.create(key) }; this.map.set(key, e); }
    e.refs++;
    return e.value;
  }
  release(key) {
    const e = this.map.get(key);
    if (!e) return false;
    if (--e.refs > 0) return false;
    this.map.delete(key);
    this.destroy(e.value);
    return true;
  }
  refs(key) { return this.map.get(key)?.refs || 0; }
  get size() { return this.map.size; }
  values() { return [...this.map.values()].map((e) => e.value); }
}

// ------------------------------------------------------------------------------------------------ runtime state
const S = { renderer: null, loader: null, tier: 'desktop', gpu: 'desktop', off: false, queue: [], active: 0, maxActive: 3, anisotropy: 4 };

function urlOverride() {
  try { const v = new URLSearchParams(window.location.search).get('tex'); return v || null; } catch { return null; }
}
/** the tier this device would use (before initTexlib it guesses from the pointer / touch points) */
export function deviceTier(renderer = S.renderer) {
  if (!HAS_DOM) return 'desktop';
  let coarse = false, touch = false;
  try { coarse = !!window.matchMedia?.('(pointer: coarse)').matches; } catch { /* old browsers */ }
  try { touch = ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0; } catch { /* idem */ }
  // touch laptops have a fine primary pointer: only count touch when the primary pointer is coarse or the screen is small
  if (touch && !coarse && window.innerWidth >= 900) touch = false;
  return tierFor({ touch, coarse, maxFragmentUniforms: renderer?.capabilities?.maxFragmentUniforms ?? 1024, override: urlOverride() });
}
/** Set up the KTX2 transcoder for this renderer and pick the tier. Safe to call more than once. */
export function initTexlib(renderer, opts = {}) {
  if (!renderer || S.renderer === renderer) return texInfo();
  S.renderer = renderer;
  S.tier = opts.tier || deviceTier(renderer);
  S.off = S.tier === 'off';
  if (S.off) S.tier = 'desktop';
  S.gpu = S.tier;
  S.anisotropy = Math.min(S.tier === 'phone' ? 4 : 8, renderer.capabilities?.getMaxAnisotropy?.() || 1);
  try {
    S.loader = new KTX2Loader().setTranscoderPath(TRANSCODER).detectSupport(renderer);
    // the byte estimate follows the formats this GPU really gets (set from the first albedo that arrives): ETC1 / ETC2 /
    // BC1 at 0.5 B/px ('phone' class), BC7 / ASTC at 1 B/px ('desktop' class)
  } catch (e) { console.warn('[texlib] KTX2 unavailable, plain colours only', e); S.loader = null; S.off = true; }
  if (HAS_DOM) window.saltlineTex = texStats;
  pump();
  return texInfo();
}
export function texInfo() { return { tier: S.tier, gpu: S.gpu, off: S.off, ready: !!S.loader }; }
/** the active tier ('desktop' | 'phone') */
export function currentTier() { return S.tier; }

function pump() {
  while (S.loader && S.active < S.maxActive && S.queue.length) {
    const job = S.queue.shift();
    if (job.cancelled) continue;
    S.active++;
    S.loader.loadAsync(job.url).then((t) => { S.active--; job.resolve(t); pump(); }, (e) => { S.active--; job.reject(e); pump(); });
  }
}
function loadKTX2(url) {
  return new Promise((resolve, reject) => {
    if (S.off || !HAS_DOM) { reject(new Error('texlib off')); return; }
    S.queue.push({ url, resolve, reject });
    pump();
  });
}

const SETS = new RefCache((name) => createSet(name), (set) => destroySet(set));
function createSet(name) {
  const info = LIB[name];
  const set = { name, info, tier: S.tier, albedo: null, normal: null, orm: null, loaded: false, failed: false, disposed: false, ready: null, release: () => releaseMaterialSet(name) };
  if (!info) { set.failed = true; set.ready = Promise.resolve(set); return set; }
  set.ready = Promise.all(info.maps.map((m) => loadKTX2(texPath(name, m, S.tier)).then((t) => {
    if (set.disposed) { t.dispose(); return; }
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = S.anisotropy;
    if (m === 'albedo') t.colorSpace = THREE.SRGBColorSpace; else t.colorSpace = THREE.NoColorSpace;
    if (m === 'albedo' && !info.alpha) S.gpu = [THREE.RGB_ETC1_Format, THREE.RGB_ETC2_Format, THREE.RGB_S3TC_DXT1_Format].includes(t.format) ? 'phone' : 'desktop';
    t.userData.shared = true; t.userData.texlib = name;
    t.name = `${name}/${m}`;
    t.needsUpdate = true;
    set[m] = t;
  }))).then(() => { set.loaded = !set.disposed; return set; }, (e) => {
    set.failed = true;
    if (HAS_DOM && !S.off) console.warn('[texlib]', name, 'failed, keeping plain colour', e?.message || e);
    return set;
  });
  return set;
}
function destroySet(set) {
  set.disposed = true; set.loaded = false;
  for (const m of ['albedo', 'normal', 'orm']) { if (set[m]) { set[m].dispose(); set[m] = null; } }
}
/** Acquire a material set (ref-counted; call set.release() when done). Unknown names give an empty, failed set. */
export function getMaterialSet(name) { return SETS.acquire(name); }
export function releaseMaterialSet(name) { return SETS.release(name); }
export function setRefs(name) { return SETS.refs(name); }

/** live GPU estimate: exact bytes of the loaded compressed mip chains (window.saltlineTex()) */
export function texStats() {
  const sets = [];
  let total = 0;
  for (const set of SETS.values()) {
    let b = 0;
    for (const m of ['albedo', 'normal', 'orm']) {
      const t = set[m]; if (!t) continue;
      if (t.mipmaps && t.mipmaps.length) for (const mm of t.mipmaps) b += mm.data?.byteLength || 0;
      else if (t.image) b += (t.image.width || 0) * (t.image.height || 0) * 4 * 1.33;
    }
    total += b;
    sets.push({ name: set.name, refs: SETS.refs(set.name), loaded: set.loaded, MB: Math.round(b / 10485.76) / 100 });
  }
  return { tier: S.tier, gpu: S.gpu, MB: Math.round(total / 10485.76) / 100, estimateLibraryMB: budgetMB(Object.keys(LIB), S.tier, S.gpu), sets };
}

// ------------------------------------------------------------------------------------------------ materials
/** triplanar shader patch (meshes without UVs): position + normal in the object or world frame, maps from uniforms */
const TRI_VERT_PARS = /* glsl */`varying vec3 vTriPos; varying vec3 vTriNrm;`;
const TRI_VERT = /* glsl */`
#ifdef TRI_WORLD
  vTriPos = (modelMatrix * vec4(transformed, 1.0)).xyz; vTriNrm = normalize(mat3(modelMatrix) * objectNormal);
#else
  vTriPos = transformed; vTriNrm = objectNormal;
#endif
`;
const TRI_FRAG_PARS = /* glsl */`
varying vec3 vTriPos; varying vec3 vTriNrm;
uniform vec2 uTriScale; uniform float uTriNormal;
#ifdef TRI_ALBEDO
uniform sampler2D uTriA;
#endif
#ifdef TRI_NORMAL
uniform sampler2D uTriN;
#endif
#ifdef TRI_ORM
uniform sampler2D uTriO;
#endif
vec3 triWeights(vec3 n) { vec3 w = n * n; w = w * w; return w / max(w.x + w.y + w.z, 1e-5); }
/** a vector in the frame of P (object or world) → view space, from the screen derivatives (exact for rigid frames) */
vec3 triToView(vec3 v, vec3 P, vec3 V) {
  vec3 a = dFdx(P), b = dFdy(P), a2 = dFdx(V), b2 = dFdy(V);
  float la = max(length(a), 1e-8), lb = max(length(b), 1e-8);
  a /= la; a2 /= la; b /= lb; b2 /= lb;
  vec3 c = cross(a, b), c2 = cross(a2, b2);
  float det = dot(c, c);
  vec3 k = vec3(dot(v, cross(b, c)), dot(v, cross(c, a)), dot(v, c)) / max(det, 1e-6);
  return k.x * a2 + k.y * b2 + k.z * c2;
}
`;
// per-axis projections with a right-handed tangent frame (T × B = N): X → (−sx·z, y), Y → (x, −sy·z), Z → (sz·x, y)
const TRI_FRAG_MAIN = /* glsl */`
vec3 triN = normalize(vTriNrm + vec3(1e-5));
vec3 triW = triWeights(triN);
#ifdef TRI_LITE
  { float wx = step(max(triW.y, triW.z), triW.x); float wy = (1.0 - wx) * step(triW.z, triW.y); triW = vec3(wx, wy, 1.0 - wx - wy); }
#endif
vec3 triS = vec3(triN.x < 0.0 ? -1.0 : 1.0, triN.y < 0.0 ? -1.0 : 1.0, triN.z < 0.0 ? -1.0 : 1.0);
vec3 triP = vTriPos;
vec2 triUX = vec2(-triS.x * triP.z, triP.y) * uTriScale, triUY = vec2(triP.x, -triS.y * triP.z) * uTriScale, triUZ = vec2(triS.z * triP.x, triP.y) * uTriScale;
`;
const triSample = (s) => /* glsl */`(texture2D(${s}, triUX) * triW.x + texture2D(${s}, triUY) * triW.y + texture2D(${s}, triUZ) * triW.z)`;
const TRI_MAP = /* glsl */`
#ifdef TRI_ALBEDO
  { vec4 ta = ${triSample('uTriA')}; diffuseColor *= ta; }
#endif
`;
const TRI_ROUGH = /* glsl */`
#ifdef TRI_ORM
  vec4 triOrm = ${triSample('uTriO')};
  roughnessFactor *= triOrm.g;
#endif
`;
const TRI_METAL = /* glsl */`
#ifdef TRI_ORM
  metalnessFactor *= triOrm.b;
#endif
`;
const TRI_NORMAL_CHUNK = /* glsl */`
#ifdef TRI_NORMAL
{
  vec3 tx = texture2D(uTriN, triUX).xyz * 2.0 - 1.0, ty = texture2D(uTriN, triUY).xyz * 2.0 - 1.0, tz = texture2D(uTriN, triUZ).xyz * 2.0 - 1.0;
  tx.xy *= uTriNormal; ty.xy *= uTriNormal; tz.xy *= uTriNormal;
  vec3 nx = vec3(0.0, 0.0, -triS.x) * tx.x + vec3(0.0, 1.0, 0.0) * tx.y + vec3(triS.x, 0.0, 0.0) * tx.z;
  vec3 ny = vec3(1.0, 0.0, 0.0) * ty.x + vec3(0.0, 0.0, -triS.y) * ty.y + vec3(0.0, triS.y, 0.0) * ty.z;
  vec3 nz = vec3(triS.z, 0.0, 0.0) * tz.x + vec3(0.0, 1.0, 0.0) * tz.y + vec3(0.0, 0.0, triS.z) * tz.z;
  vec3 nF = normalize(nx * triW.x + ny * triW.y + nz * triW.z + triN * 0.001);
  vec3 nV = triToView(nF, vTriPos, -vViewPosition);
  if (dot(nV, nV) > 1e-6) normal = normalize(nV) * faceDirection;
}
#endif
`;
const TRI_AO = /* glsl */`
#ifdef TRI_ORM
  reflectedLight.indirectDiffuse *= mix(1.0, triOrm.r, 0.8);
#endif
`;

/**
 * A MeshStandardMaterial on a library set. opts: { color (tint; a tint material's grey is normalised so the colour keeps
 * its value), repeat: [u, v] or size: [w, h] metres of a 0..1 UV face, tile (metres per repeat, default the library's),
 * triplanar: true | 'world' (meshes without UVs; scale = 1 / tile), lite (phones: one projection), normalScale,
 * roughness / metalness (multiplied with the ORM map), side, envMapIntensity, noNormal }.
 * The material starts as the plain mean colour and switches to the maps when they arrive (one recompile).
 * Disposing the material releases its hold on the set.
 */
export function makeMaterial(name, opts = {}) {
  const info = LIB[name] || { mean: 0x808080, rough: 0.7, metal: 0, maps: [], tile: 1 };
  const tint = opts.color != null ? new THREE.Color(opts.color) : null;
  const m = new THREE.MeshStandardMaterial({
    color: tint ? tint.clone() : new THREE.Color(info.mean),
    roughness: opts.roughness ?? info.rough, metalness: opts.metalness ?? info.metal,
    side: opts.side ?? THREE.FrontSide, envMapIntensity: opts.envMapIntensity ?? 1,
  });
  m.name = `lib:${name}`;
  m.userData.texlib = name;
  if (info.alpha) { m.alphaToCoverage = true; m.side = opts.side ?? THREE.DoubleSide; }
  const tri = !!opts.triplanar;
  const tile = Number(opts.tile) > 0 ? Number(opts.tile) : info.tile;
  const set = getMaterialSet(name);
  let released = false;
  m.addEventListener('dispose', () => { if (!released) { released = true; set.release(); } });
  const apply = () => {
    if (released || !set.loaded) return;
    // ORM: roughness (g) and metalness (b) multiply the factors, so the factors become the map's scale
    const rough = opts.roughness != null ? opts.roughness / Math.max(0.05, info.rough) : 1, metal = opts.metalness != null ? opts.metalness : (info.metal > 0.5 ? 1 : 0);
    m.roughness = Math.min(1, rough); m.metalness = metal;
    if (info.tint && tint) m.color.copy(tint).multiplyScalar(1 / TINT_MEAN);
    else if (!tint) m.color.setRGB(1, 1, 1);
    if (tri) {
      const ts = triScale(name, tile);
      const u = { uTriScale: { value: new THREE.Vector2(ts[0], ts[1]) }, uTriNormal: { value: opts.normalScale ?? 1 }, uTriA: { value: set.albedo }, uTriN: { value: set.normal }, uTriO: { value: set.orm } };
      m.userData.triUniforms = u;
      m.defines = { ...(m.defines || {}), ...(set.albedo ? { TRI_ALBEDO: '' } : {}), ...(set.normal && !opts.noNormal ? { TRI_NORMAL: '' } : {}), ...(set.orm ? { TRI_ORM: '' } : {}),
        ...(opts.triplanar === 'world' ? { TRI_WORLD: '' } : {}), ...(opts.lite ? { TRI_LITE: '' } : {}) };
      m.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, u);
        shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\n' + TRI_VERT_PARS)
          .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n' + TRI_VERT);
        shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + TRI_FRAG_PARS)
          .replace('#include <map_fragment>', '#include <map_fragment>\n' + TRI_FRAG_MAIN + TRI_MAP)
          .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + TRI_ROUGH)
          .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n' + TRI_METAL)
          .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + TRI_NORMAL_CHUNK)
          .replace('#include <aomap_fragment>', '#include <aomap_fragment>\n' + TRI_AO);
      };
      m.customProgramCacheKey = () => `texlib-tri${opts.triplanar === 'world' ? 'W' : ''}${opts.lite ? 'L' : ''}${set.albedo ? 'A' : ''}${set.normal && !opts.noNormal ? 'N' : ''}${set.orm ? 'O' : ''}`;
    } else {
      const rep = opts.repeat || (opts.size ? repeatForSize(name, opts.size[0], opts.size[1], tile) : [1, 1]);
      const own = (t) => { if (!t) return null; const c = t.clone(); c.repeat.set(rep[0], rep[1]); c.userData = { texlibClone: true }; c.needsUpdate = true; return c; };   // clones share the GPU upload (same Source)
      m.map = own(set.albedo);
      if (!opts.noNormal) { m.normalMap = own(set.normal); if (opts.normalScale != null) m.normalScale.set(opts.normalScale, opts.normalScale); }
      const orm = own(set.orm);
      m.roughnessMap = orm; m.metalnessMap = orm; m.aoMap = orm;
      m.aoMapIntensity = 0.8;
      m.addEventListener('dispose', () => { for (const t of [m.map, m.normalMap, orm]) if (t) t.dispose(); });
    }
    m.needsUpdate = true;
  };
  m.userData.texReady = set.ready.then(() => { apply(); return m; });
  return m;
}
/** a material's mean (fallback) colour as a hex number */
export function meanColor(name) { return LIB[name]?.mean ?? 0x808080; }
/** linear mean albedo of a material (sRGB → linear), for shaders that use the photo as a detail map */
export function meanLinear(name) {
  const c = new THREE.Color(meanColor(name));   // THREE.Color stores linear components (ColorManagement on)
  return [c.r, c.g, c.b];
}
