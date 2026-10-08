// Ocean v2: a spectral Gerstner sea driven by the real sea state (drop-in replacement for ocean.js).
//
// Spectrum: the wind sea is a JONSWAP spectrum (γ 3.3) from (waveH, wavePeriod, waveDir) with Mitsuyasu cos^2s
// directional spreading; the swell is a narrow log-normal band from (swellH, swellPeriod, swellDir). Both are sampled
// by 48 Gerstner components on FIXED wavelengths in three cascades — long 55–650 m (8 wind-sea + 8 swell slots), mid
// 12–55 m, short 2–12 m — with fixed random phases. Spreading quantiles are stratified by energy rank (peak component
// on the mean direction, the next ones at ±½σ, ±σ, …) so the dominant crests are 2–3 wavelengths long (short-crested).
// A new forecast only moves amplitudes and directions (eased over ~20 s, directions ≤ 2.5°/s with the phase held at
// the view centre): the field never slides or pops. Amplitudes come from band-integrated spectral energy normalised so
// 4·√(Σa²/2) = Hs exactly. Crest sharpening (Gerstner Q) is budgeted per cascade so Σ Q·k·A ≤ 0.85: crests peak but the
// surface never loops.
//
// Geometry: a camera-centred clipmap of 7 nested square rings (2 m cells over ±128 m, doubling each ring out to ±8 km,
// T-junction-free stitching) snapped to 4 cells, biased toward where the camera looks (the chase camera's ship sits in
// the 2 m ring), plus a flat far ring to 30 km. Each component is faded out of the geometry where the local cell is too
// coarse for it (no aliasing); whatever the vertices cannot carry is added back per pixel as analytic normals, itself
// faded by the pixel footprint, and the unresolved slope variance goes into the sun-glitter roughness (Cox–Munk).
//
// Shading: analytic Gerstner normals + short-cascade/capillary detail, Schlick fresnel with sky reflection from setSun's
// colours, Beckmann sun glitter, subsurface light through thin crests, crest/trough shading that grows with Hs (a calm
// stays glassy), depth colour (rebuildDepth contract unchanged), storm/overcast greying, night, rain rings, harbour
// shore fields (setShoreField, unchanged) and the three.js fog tail.
// Foam: whitecaps where the Gerstner Jacobian folds below a wind-dependent threshold (Monahan coverage, Beaufort 4+),
// broken into short crests by a drifting wave-group field and accumulated with persistence in a world-anchored render
// target (decays over seconds; foam stays on the water it formed on while the crest runs on). Drawn as a bubbly,
// ragged-edged whitecap that crumbles into a mottled, holey residual film, stretched downwind as the wind rises, plus
// thin broken windrows above ~12 m/s. Every texture octave fades to its mean with the pixel footprint (no shimmer).
// Spray: GPU spindrift points blown off breaking crests near the camera above 14 m/s.
// CPU mirror: heightAt / displacementAt / normalAt sum the same long+mid components (Newton-inverted horizontal
// displacement, table sin/cos) so ships ride the drawn waves; setShelter(fn) damps the sea inside harbours on both sides;
// shiftOrigin(px, pz) keeps everything on the same water across a floating-origin shift.
import * as THREE from 'three';

const G = 9.81, TAU = Math.PI * 2, D2R = Math.PI / 180;
const NL = 16, NM = 16, NS = 16, NLM = NL + NM, NW = NLM + NS;
const NWL = 8;                       // long-cascade slots carrying the wind sea; the other 8 carry the swell
const LEVELS = 7;                    // clipmap rings: L0 + 6 doublings
const FAR_OUT = 30000;               // far ring outer half-extent (m)
const FOAM_W = 2048;                 // foam accumulation window (m, world-anchored, toroidal)
const PAT_ANCHOR = 16384;            // foam / streak pattern coordinate period (m)
const SPRAY_R = 230;                 // spray box half-size around the camera (m)
const GRP_PERIOD = 42 * 4096;        // wrap of the wave-group field offset (m)
const BUDGET = [0.5, 0.25, 0.1];     // Σ Q·k·A per cascade at full chop: 0.85 in total → the Jacobian never reaches 0
const QMAX = [2.5, 1.6, 1.0];        // per-component Gerstner Q cap per cascade
const TIERS = [{ n: 64, s0: 4 }, { n: 96, s0: 8 / 3 }, { n: 128, s0: 2 }]; // all reach ±8192 m
const SHELTER_N = 128, SHELTER_SIZE = 4096;
// spreading quantiles by energy rank: the peak component on the mean direction, the next ones stratified to both sides
// (≈ ±0.5σ, ±σ, …) so the dominant crests are 2–3 wavelengths long (a short-crested wind sea, not corrugated sheet)
const RANK_U = [0.5, 0.31, 0.69, 0.42, 0.58, 0.2, 0.8, 0.37, 0.63, 0.12, 0.88, 0.26, 0.74, 0.47, 0.53, 0.07, 0.93, 0.16, 0.84, 0.34, 0.66];

// ------------------------------------------------------------------------------------------------ component table
function rng32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const COMP = (() => {
  const rnd = rng32(0x5a171e), out = [];
  const band = (n, lo, hi, cascade, family) => {
    const r = Math.log(hi / lo) / n, lens = [];
    for (let i = 0; i < n; i++) lens.push(lo * Math.exp(r * (i + 0.5 + (rnd() - 0.5) * 0.7)));
    lens.sort((a, b) => b - a);
    for (const len of lens) out.push({ len, cascade, family, ph: rnd() * TAU, u: 0.5 });
  };
  band(NWL, 55, 650, 0, 0); band(NL - NWL, 70, 620, 0, 1); band(NM, 12, 55, 1, 0); band(NS, 2, 12, 2, 0);
  // stratified spreading quantiles (golden-ratio sequence per family): neighbours alternate sides of the mean direction
  let gw = 0.5, gs = 0.5;
  for (const c of out) {
    if (c.family === 0) { c.u = 0.06 + 0.88 * gw; gw = (gw + 0.6180339887) % 1; } else { c.u = 0.12 + 0.76 * gs; gs = (gs + 0.6180339887) % 1; }
  }
  return out;
})();

/** Live component table (one entry per Gerstner component; refreshed every frame). θ = k·(dx·x + dz·z) − w·t + ph; height = amp·sin θ; horizontal = q·amp·(dx, dz)·cos θ. */
export const WAVES = COMP.map((c) => ({ dx: 0, dz: -1, amp: 0, len: c.len, k: TAU / c.len, w: Math.sqrt((G * TAU) / c.len), q: 0, ph: c.ph, ang: 0, cascade: c.cascade, swell: c.family === 1 }));
/** Mirror of the ocean's time / tide level for modules that only know world xz (wakes, buoys). */
export const oceanState = { time: 0, level: 0, hs: 0.8, wind: 5, windDir: 240 };

/** Shoreline foam fields, one per harbour patch (written by terrain.js) — same contract as ocean.js. */
export const shoreFields = new Map();
/** Register / move (same id) or remove (field null) a harbour's shoreline foam field. */
export function setShoreField(id, field) {
  if (field && field.tex && Number.isFinite(field.x0) && Number.isFinite(field.z0) && field.size > 0) shoreFields.set(String(id), field);
  else shoreFields.delete(String(id));
}
let _noShore = null;
function noShoreTexture() {
  if (!_noShore) { _noShore = new THREE.DataTexture(new Uint8Array([255, 255, 0, 255]), 1, 1, THREE.RGBAFormat); _noShore.needsUpdate = true; }
  return _noShore;
}

let active = null; // the Ocean that module-level helpers read (the most recently constructed / updated one)
/** Gerstner vertical part of the surface at world (x, z) (long + mid cascades, horizontal displacement inverted) — tide level NOT included. */
export function waveHeight(x, z, t, windF = 1) { return active ? active._height(x, z, Number.isFinite(t) ? t : active.time) * windF : 0; }
/** Surface height including the tide level, at the ocean's current time. */
export function surfaceHeightAt(x, z, t = oceanState.time) { return oceanState.level + waveHeight(x, z, t, 1); }

// fast sin/cos for the CPU mirror: 4096-entry table + linear interpolation (|error| < 3e-7)
const SC_N = 4096, SC_MASK = SC_N - 1, SC_Q = SC_N / 4, SC_K = SC_N / TAU;
const SIN_T = new Float64Array(SC_N + 1);
for (let i = 0; i <= SC_N; i++) SIN_T[i] = Math.sin((i / SC_N) * TAU);
const PS = 11; // CPU pack stride: kdx, kdz, A, QAdx, QAdz, Akdx, Akdz, jxx, jzz, jxz, phase(t)

function wrapTau(a) { a %= TAU; return a < 0 ? a + TAU : a; }
function smooth01(e0, e1, x) { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }
function num(v, d) { return Number.isFinite(v) ? v : d; }
function jonswap(w, wp) {
  const sig = w <= wp ? 0.07 : 0.09, r = Math.exp(-((w - wp) * (w - wp)) / (2 * sig * sig * wp * wp));
  return Math.pow(w, -5) * Math.exp(-1.25 * Math.pow(wp / w, 4)) * Math.pow(3.3, r);
}
/** Inverse CDF of the Mitsuyasu spreading function D(θ) ∝ cos^2s(θ/2) on [−π, π]. */
const _cdf = new Float64Array(97);
function spreadAngle(u, s) {
  const n = 96; _cdf[0] = 0;
  let prev = 0;
  for (let i = 1; i <= n; i++) { const th = -Math.PI + (i / n) * TAU; const v = Math.pow(Math.max(0, Math.cos(th / 2)), 2 * s); _cdf[i] = _cdf[i - 1] + (prev + v) * 0.5; prev = v; }
  const target = u * _cdf[n];
  let i = 1; while (i < n && _cdf[i] < target) i++;
  const f = (target - _cdf[i - 1]) / Math.max(1e-12, _cdf[i] - _cdf[i - 1]);
  return -Math.PI + ((i - 1 + f) / n) * TAU;
}
/** Upper-tail standard normal quantile: z with P(Z > z) = p (Abramowitz–Stegun 26.2.23). */
function zTail(p) { p = Math.min(0.5, Math.max(1e-9, p)); const t = Math.sqrt(-2 * Math.log(p)); return t - (2.515517 + 0.802853 * t + 0.010328 * t * t) / (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t * t * t); }
function defaultQuality() {
  try { if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) return 0.5; } catch { /* no DOM */ }
  return 1;
}

// ------------------------------------------------------------------------------------------------ GLSL
const GLSL_COMMON = /* glsl */`
#define NL 16
#define NLM 32
#define NW 48
uniform vec4 uWaveA[NW]; // dx, dz, amp, k
uniform vec4 uWaveB[NW]; // phase (relative to uC, at uTime), Q, wavelength, omega
`;
const GLSL_VNOISE = /* glsl */`
float vnoise(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y); }
// wave groups / short crests (0..1): s = group scale (m), tied to the peak wavelength
float groupField(vec2 p, float s) { vec2 g = p / s; return vnoise(g) * 0.55 + vnoise(g * 2.7 + 7.1) * 0.3 + vnoise(g * 6.1 + 3.3) * 0.15; }
`;
const GLSL_NOISE = /* glsl */`
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
`;

const VERT = /* glsl */`
${GLSL_COMMON}
uniform vec2 uC; uniform vec2 uVrel; uniform float uS0; uniform float uR0; uniform float uSnap; uniform float uRmax; uniform float uLevel; uniform float uVertShort;
uniform sampler2D uShelterTex; uniform vec4 uShelterRect;
varying vec3 vWorld; varying vec2 vRel; varying vec4 vSum; varying float vJxz; varying float vHeight; varying float vCeff; varying vec3 vMult;
#include <fog_pars_vertex>
void gerst(vec4 a, vec4 b, float A, vec2 p, inout vec3 disp, inout vec4 S, inout float jxz) {
  float th = a.w * dot(a.xy, p) + b.x;
  float s = sin(th), c = cos(th);
  float QA = b.y * A, kA = a.w * A, qs = QA * a.w * s;
  disp += vec3(a.x * QA * c, A * s, a.y * QA * c);
  S += vec4(a.x * kA * c, a.y * kA * c, a.x * a.x * qs, a.y * a.y * qs);
  jxz += a.x * a.y * qs;
}
void main() {
  vec2 rel = position.xz;                                   // metres from the snapped grid origin uC
  float cheb = max(abs(rel.x), abs(rel.y));
  float rim = 1.0 - smoothstep(uRmax * 0.55, uRmax * 0.985, cheb);
  // conservative local cell size: continuous in the distance to the (unsnapped) view centre, never below the real cell
  float ceff = uS0 * max(1.0, 2.0 * (length(rel - uVrel) + 0.5 * uSnap) / uR0);
  float sh = 0.0;
  if (uShelterRect.w > 0.5) {
    vec2 suv = (rel - uShelterRect.xy) / uShelterRect.z;
    if (suv.x > 0.0 && suv.y > 0.0 && suv.x < 1.0 && suv.y < 1.0) sh = texture2D(uShelterTex, suv).r;
  }
  vec3 m = vec3(1.0 - sh, 1.0 - 0.9 * sh, 1.0 - 0.6 * sh) * rim;
  vec3 disp = vec3(0.0); vec4 S = vec4(0.0); float jxz = 0.0;
  if (rim > 0.0) {
    for (int i = 0; i < NLM; i++) {
      vec4 a = uWaveA[i]; vec4 b = uWaveB[i];
      float A = a.z * (i < NL ? m.x : m.y) * smoothstep(1.7 * ceff, 2.5 * ceff, b.z);
      if (A < 1e-4) continue;
      gerst(a, b, A, rel, disp, S, jxz);
    }
    if (uVertShort > 0.5 && ceff < 6.0) {
      for (int i = NLM; i < NW; i++) {
        vec4 a = uWaveA[i]; vec4 b = uWaveB[i];
        float A = a.z * m.z * smoothstep(1.7 * ceff, 2.5 * ceff, b.z);
        if (A < 1e-4) continue;
        gerst(a, b, A, rel, disp, S, jxz);
      }
    }
  }
  vRel = rel; vSum = S; vJxz = jxz; vHeight = disp.y; vCeff = ceff; vMult = m;
  vec3 pos = vec3(uC.x + rel.x + disp.x, uLevel + disp.y, uC.y + rel.y + disp.z);
  vWorld = pos;
  vec4 mvPosition = viewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */`
${GLSL_COMMON}
uniform vec3 uDeep; uniform vec3 uShallow; uniform vec3 uSkyTop; uniform vec3 uSkyHorizon; uniform vec3 uSunDir; uniform vec3 uSunColor; uniform vec3 uSssCol;
uniform sampler2D uDepth; uniform vec2 uDepthOrigin; uniform float uDepthSize; uniform float uTime; uniform float uWind; uniform vec2 uWindDir;
uniform float uNight; uniform float uRain; uniform float uStorm; uniform float uLevel; uniform float uDetail; uniform float uHs;
uniform sampler2D uShoreA; uniform sampler2D uShoreB; uniform vec4 uShoreRectA; uniform vec4 uShoreRectB;
uniform float uPixAng; uniform float uVertShort; uniform float uNShortFrag; uniform float uMssSub;
uniform float uSigLM; uniform float uFoamA; uniform float uFoamSoft; uniform float uFoamK; uniform float uStreak; uniform float uOldMean;
uniform vec2 uGrpOff; uniform float uGrpK; uniform float uSigB;
uniform sampler2D uFoamTex; uniform vec2 uFoamOff; uniform vec2 uFoamShift; uniform float uFoamW; uniform float uFoamOn; uniform vec2 uPatOff;
varying vec3 vWorld; varying vec2 vRel; varying vec4 vSum; varying float vJxz; varying float vHeight; varying float vCeff; varying vec3 vMult;
#include <fog_pars_fragment>
${GLSL_NOISE}
${GLSL_VNOISE}
vec3 noised(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  float a = hash12(i), b = hash12(i + vec2(1.0, 0.0)), c = hash12(i + vec2(0.0, 1.0)), d = hash12(i + vec2(1.0, 1.0));
  float k1 = b - a, k2 = c - a, k3 = a - b - c + d;
  return vec3(a + k1 * u.x + k2 * u.y + k3 * u.x * u.y, du * (vec2(k1, k2) + k3 * u.yx));
}
const mat2 ROT1 = mat2(0.8, -0.6, 0.6, 0.8), ROT2 = mat2(0.28, 0.96, -0.96, 0.28);
// Foam textures. Every octave is replaced by its mean once the pixel footprint fp (m) is too coarse for it, so the
// patterns fade to their average brightness with distance instead of shimmering.
// bubbly body of a whitecap (0..1, contrast-stretched fbm of the warped coordinate p)
float foamBody(vec2 p, float fp) {
  float k0 = 1.0 - smoothstep(3.5, 10.0, fp), k1 = 1.0 - smoothstep(1.2, 4.0, fp), k2 = 1.0 - smoothstep(0.35, 1.3, fp), k3 = 1.0 - smoothstep(0.1, 0.45, fp);
  float n = 0.5 * mix(0.5, vnoise(p * 0.19), k0);
  n += 0.28 * mix(0.5, vnoise(ROT1 * p * 0.57 + 3.1), k1);
  n += 0.14 * mix(0.5, vnoise(ROT2 * p * 1.7 + 7.7), k2);
  n += 0.08 * mix(0.5, vnoise(ROT1 * p * 4.9 + 1.3), k3);
  return clamp((n - 0.5) * 1.8 + 0.5, 0.0, 1.0);
}
// residual foam: a mottled, semi-transparent film with ragged edges at metre scale and, near the camera, a bubbly
// interior with dark holes where the water shows through; q = warped, wind-stretched coordinates, a = amount 0..1
float foamFilm(vec2 q, float fp, float a) {
  float k0 = 1.0 - smoothstep(3.0, 9.0, fp), k1 = 1.0 - smoothstep(1.0, 3.5, fp), k2 = 1.0 - smoothstep(0.3, 1.1, fp), k3 = 1.0 - smoothstep(0.12, 0.5, fp);
  float n = 0.5 * mix(0.5, vnoise(q * 0.21), k0) + 0.3 * mix(0.5, vnoise(ROT1 * q * 0.63 + 3.0), k1) + 0.2 * mix(0.5, vnoise(ROT2 * q * 1.9 + 7.0), k2);
  n = (n - 0.5) * 2.0 + 0.5;
  float soft = 0.3 + 0.3 * smoothstep(0.5, 4.0, fp);
  float c = smoothstep(1.0 - 1.2 * a, 1.0 - 1.2 * a + soft, n);
  float h = vnoise(ROT1 * q * 1.3 + 4.0) * 0.6 + vnoise(ROT2 * q * 3.7 + 9.0) * 0.4;
  float holes = smoothstep(0.36, 0.6, h);
  return c * (0.4 + 0.6 * mix(0.55, holes, k3));
}
// wind-aligned foam streaks (windrows): long, thin, broken, slightly meandering lines; 0..1
float foamStreaks(vec2 p, float fp) {
  vec2 q = vec2(dot(p, uWindDir), dot(p, vec2(-uWindDir.y, uWindDir.x)));
  q.y += 9.0 * vnoise(vec2(q.x * 0.013, q.y * 0.03));                                  // meander
  float n = vnoise(vec2(q.x * 0.009, q.y * 0.1)) * 0.72 + vnoise(vec2(q.x * 0.023, q.y * 0.27) + 13.0) * 0.28;
  float w = 0.016 + 0.02 * smoothstep(0.4, 2.0, fp);                                  // a line never thinner than a pixel
  float line = 1.0 - smoothstep(w * 0.25, w, abs(n - 0.5));
  float broken = smoothstep(0.4, 0.85, vnoise(vec2(q.x * 0.05, q.y * 0.45) + 5.0));
  return mix(line * broken, 0.02, smoothstep(1.5, 6.0, fp));
}
float shoreFoam(sampler2D tex, vec4 rect, vec2 p, float n, float t, out float inside) {
  inside = 0.0;
  if (rect.w < 0.5) return 0.0;
  vec2 uv = (p - rect.xy) / rect.z;
  if (uv.x <= 0.0 || uv.y <= 0.0 || uv.x >= 1.0 || uv.y >= 1.0) return 0.0;
  vec2 e = min(uv, 1.0 - uv);
  inside = smoothstep(0.0, 0.012, min(e.x, e.y));
  vec4 s = texture2D(tex, uv);
  float dAny = s.r * 63.75 - 8.0, dNat = s.g * 63.75 - 8.0, expo = s.b;
  float wash = smoothstep(3.2, 0.0, dAny) * smoothstep(-1.5, 0.0, dAny) * (0.5 + 0.45 * n);
  float width = (3.0 + 8.0 * uHs) * (0.3 + 0.7 * expo);
  float zone = smoothstep(width, 0.0, dNat) * smoothstep(-1.0, 0.5, dNat);
  float rows = 0.5 + 0.5 * sin(dNat * (0.9 - 0.4 * expo) + t * 1.4 + n * 5.0);
  float surf = zone * smoothstep(0.42, 0.9, rows * 0.75 + n * 0.45) * (0.2 + 0.8 * expo) * clamp(0.25 + uHs * 0.6, 0.0, 1.0);
  return clamp(max(wash, surf), 0.0, 1.0) * inside;
}
void fgerst(vec4 a, vec4 b, float A, vec2 p, inout vec4 S, inout float jxz, inout float h) {
  float th = a.w * dot(a.xy, p) + b.x;
  float s = sin(th), c = cos(th);
  float kA = a.w * A, qs = b.y * kA * s;
  h += A * s;
  S += vec4(a.x * kA * c, a.y * kA * c, a.x * a.x * qs, a.y * a.y * qs);
  jxz += a.x * a.y * qs;
}
void main() {
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / max(dist, 0.001);
  vec2 rel = vRel; float ceff = vCeff; vec3 m = vMult;
  // pixel footprint on the water (m): grows with distance and at grazing angles
  float fp = dist * uPixAng / pow(max(abs(V.y), 0.04), 0.6);
  vec4 S = vSum; float jxz = vJxz; float h = vHeight;
  float varU = 0.0, varJ = 0.0;
  // --- long + mid: add back per pixel what the vertices could not carry (LOD complement), filtered by the footprint
  for (int i = 0; i < NLM; i++) {
    vec4 a = uWaveA[i]; vec4 b = uWaveB[i];
    float A0 = a.z * (i < NL ? m.x : m.y);
    if (A0 < 1e-4) continue;
    float wf = 1.0 - smoothstep(1.7 * ceff, 2.5 * ceff, b.z);
    if (wf < 0.002) continue;
    float wl = smoothstep(2.0 * fp, 5.0 * fp, b.z);
    float kA = a.w * A0 * wf;
    varU += 0.5 * kA * kA * (1.0 - wl);
    float A = A0 * wf * wl;
    if (A < 1e-4) continue;
    fgerst(a, b, A, rel, S, jxz, h);
  }
  // --- short cascade: geometry near the camera (vertex), per-pixel normals elsewhere, faded by the footprint
  float vs = (uVertShort > 0.5 && ceff < 6.0) ? 1.0 : 0.0;
  for (int i = NLM; i < NW; i++) {
    vec4 a = uWaveA[i]; vec4 b = uWaveB[i];
    float A0 = a.z * m.z;
    if (A0 < 1e-4) continue;
    float wf = 1.0 - vs * smoothstep(1.7 * ceff, 2.5 * ceff, b.z);
    float wl = float(i - NLM) < uNShortFrag ? smoothstep(2.0 * fp, 5.0 * fp, b.z) : 0.0;
    float kA = a.w * A0;
    float pres = (1.0 - wf) + wf * wl;
    varU += 0.5 * kA * kA * wf * (1.0 - wl);
    varJ += 0.5 * (b.y * kA * pres) * (b.y * kA * pres);
    float A = A0 * wf * wl;
    if (A < 1e-4) continue;
    fgerst(a, b, A, rel, S, jxz, h);
  }
  vec2 pp = rel + uPatOff;                 // pattern coordinates (stable world frame, metres)
  // --- capillary detail (< 2 m) near the camera: two octaves of wind-scrolled noise slope
  float capK = uDetail * (1.0 - smoothstep(0.12, 0.5, fp)) * (0.2 + 0.8 * clamp(uWind / 12.0, 0.0, 1.0)) * m.z;
  if (capK > 0.001) {
    vec3 n1 = noised(pp * 0.9 + uWindDir * uTime * 0.55);
    vec3 n2 = noised(pp * 2.3 - uWindDir * uTime * 0.85 + 7.3);
    S.xy += (n1.yz * 0.9 * 0.6 + n2.yz * 2.3 * 0.4) * 0.035 * capK;
  }
  if (uRain > 0.0) { // expanding rain rings on a jittered grid
    vec2 rp = pp * 0.8; vec2 ci = floor(rp); vec2 cf = fract(rp) - 0.5;
    float hh = hash12(ci);
    float ph = fract(uTime * 1.7 + hh * 3.0);
    vec2 cc = cf + (vec2(hash12(ci + 3.1), hash12(ci + 7.7)) - 0.5) * 0.6;
    float r = length(cc);
    float ring = sin(r * 38.0 - ph * 22.0) * exp(-r * 6.0) * (1.0 - ph) * step(hh, uRain * 0.9 + 0.05);
    S.xy -= (cc / max(r, 0.02)) * ring * 0.22 * (1.0 - smoothstep(0.1, 0.6, fp));
  }
  // --- normal + Jacobian of the displaced surface
  float jxx = S.z, jzz = S.w;
  vec3 N = vec3(S.y * (-jxz) - (1.0 - jzz) * S.x, (1.0 - jzz) * (1.0 - jxx) - jxz * jxz, -jxz * S.x - S.y * (1.0 - jxx));
  float J = N.y;
  N.y = max(N.y, 0.05);
  N = normalize(N);
  // grazing: never shade a facet seen from behind (pull the normal toward the viewer)
  float nv = dot(N, V);
  if (nv < 0.02) N = normalize(N + V * (0.02 - nv));
  float ndv = max(0.0, dot(N, V));
  float sunUp = clamp(uSunDir.y * 4.0, 0.0, 1.0) * (1.0 - uNight * 0.9);
  float fresnel = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  // --- depth
  vec2 dp = vWorld.xz;
  vec2 duv = (dp - uDepthOrigin) / uDepthSize;
  float depth = 255.0;
  if (duv.x > 0.0 && duv.x < 1.0 && duv.y > 0.0 && duv.y < 1.0) depth = texture2D(uDepth, duv).r * 255.0;
  depth = max(0.0, depth + uLevel);
  // --- water body: depth colour, storm grey, diffuse light, subsurface through thin crests
  float shallowMix = exp(-depth / 9.0);
  vec3 water = mix(uDeep, uShallow, shallowMix);
  water = mix(water, vec3(0.085, 0.115, 0.125), uStorm * 0.6);
  water *= 0.62 + 0.38 * max(0.0, dot(N, uSunDir)) * (0.4 + 0.6 * sunUp);
  float crest = clamp(h / max(0.25, uHs) * 0.95 + 0.3, 0.0, 1.0);
  float crestK = 0.3 + 0.7 * smoothstep(0.6, 2.5, uHs);             // a glassy calm has no dark troughs / bright crests
  water *= 1.0 + crestK * (0.75 * crest - 0.4);                     // deep troughs read darker, thin crests lighter
  vec3 Ls = normalize(uSunDir + N * 0.55);
  float back = pow(clamp(dot(V, -Ls), 0.0, 1.0), 3.5);
  float sss = (back * 1.1 + 0.22 * ndv + 0.08) * crest * crest * (0.25 + 0.75 * sunUp) * (1.0 - fresnel);
  water += uSssCol * sss * (0.6 + 0.4 * shallowMix) * (1.0 - 0.55 * uStorm);
  water *= 1.0 - 0.78 * uNight;
  // --- sky reflection (below-horizon reflections see other waves: darker)
  vec3 R = reflect(-V, N);
  float ry = R.y;
  vec3 sky = mix(uSkyHorizon, uSkyTop, pow(clamp(ry, 0.0, 1.0), 0.55));
  sky = mix(sky, mix(uSkyHorizon, uDeep, 0.55), smoothstep(0.0, -0.25, ry));
  sky += uSunColor * pow(max(0.0, dot(R, uSunDir)), 12.0) * 0.1 * sunUp;
  sky *= 1.0 - 0.28 * uStorm;
  vec3 col = mix(water, sky, fresnel);
  // --- sun glitter: Beckmann lobe, roughness = sub-grid capillaries (Cox–Munk) + unresolved spectral slopes
  vec3 Hv = normalize(uSunDir + V);
  float ndh = max(dot(N, Hv), 1e-3);
  float a2 = clamp(uMssSub * (1.0 - 0.5 * capK) + varU, 0.0012, 0.6);
  float ndh2 = ndh * ndh;
  float Dm = exp(-(1.0 - ndh2) / (ndh2 * a2)) / (3.14159 * a2 * ndh2 * ndh2);
  float Fh = 0.02 + 0.98 * pow(1.0 - max(0.0, dot(V, Hv)), 5.0);
  float ndl = max(dot(N, uSunDir), 0.0);
  float spec = Dm * Fh * smoothstep(0.0, 0.08, ndl) / (4.0 * max(ndv, 0.12));
  col += uSunColor * min(spec, 60.0) * sunUp * 2.6 * (1.0 - 0.7 * uStorm);
  // --- foam: shore surf + harbour shore fields
  float n = vnoise(pp * 0.12 + uTime * 0.05) * 0.6 + vnoise(pp * 0.5 - uTime * 0.1) * 0.4;
  float surf = n + 0.12 * sin(uTime * 0.9 + depth * 1.6);
  float shore = smoothstep(5.5, 0.3, depth) * smoothstep(0.38, 0.72, surf);
  float inA, inB;
  float fA = shoreFoam(uShoreA, uShoreRectA, dp, n, uTime, inA);
  float fB = shoreFoam(uShoreB, uShoreRectB, dp, n, uTime, inB);
  shore = mix(shore, max(fA, fB), max(inA, inB));
  // --- whitecaps: Jacobian folding (instantaneous) + accumulated persistent foam (render target). A fresh whitecap is
  //     dense, bubbly and ragged-edged; as it decays it crumbles into blobs, then marbled veins that the wind stretches
  //     into streaks; windrows (long thin lines along the wind) above ~12 m/s.
  float foam = 0.0, foamLit = 1.0;
  if (uFoamK > 0.0) {
    vec2 fr = rel + uFoamShift;                                               // rel. the foam window centre
    float grp = groupField(fr + uGrpOff, 42.0);
    float sig = sqrt(uSigLM * uSigLM + varJ);
    float thr = 1.0 - uFoamA * sig + (grp - 0.5) * uGrpK * sig / max(1e-4, uSigB);
    float inst = smoothstep(thr, thr - uFoamSoft * sig, J);                 // crest folding right now (all scales)
    float win = 1.0 - smoothstep(0.36 * uFoamW, 0.47 * uFoamW, max(abs(fr.x), abs(fr.y)));
    vec2 acc = uFoamOn > 0.5 ? texture2D(uFoamTex, (rel + uFoamOff) / uFoamW).rg * win : vec2(0.0);
    // inside the window the accumulated dominant-crest foam leads and the instantaneous term adds crest-tip detail;
    // beyond it: instantaneous breaking + the statistical mean of the residual foam
    float act = max(acc.x, inst * mix(0.9, 0.55, win)) * uFoamK;
    float old = mix(uOldMean, acc.y, win) * uFoamK * m.y;
    float strK = uStreak * m.y;
    if (act + old > 0.004) {
      // large-scale domain warp: nothing repeats or lines up. pp is the water's rest position, so the foam rides the
      // orbital motion and stays on the water it formed on while the crest runs on ahead of it.
      vec2 wv = vec2(vnoise(pp * 0.035), vnoise(pp * 0.035 + 31.7)) - 0.5;
      float body = 0.6, cA = 0.0, cR = 0.0, cS = 0.0;
      if (act > 0.004) {
        body = foamBody(pp + wv * 22.0, fp);
        cA = smoothstep(0.0, 1.0, (act * 0.92 - (1.0 - body) * 0.9) / 0.6);
      }
      if (old > 0.004) {
        float st = 1.0 + 2.0 * uStreak;
        vec2 pf = pp + wv * 22.0 * (1.0 - 0.7 * uStreak);                      // strong wind: straighter streaks
        vec2 qm = vec2(dot(pf, uWindDir) / st, dot(pf, vec2(-uWindDir.y, uWindDir.x)));
        cR = foamFilm(qm, fp, old) * (0.28 + 0.5 * old);
        float sk = strK * smoothstep(0.03, 0.4, old);
        if (sk > 0.001) cS = foamStreaks(pp, fp) * sk * 0.45;
      }
      foam = 1.0 - (1.0 - cA) * (1.0 - clamp(cR, 0.0, 1.0)) * (1.0 - 0.85 * cS);
      foamLit = 0.74 + 0.26 * body;
    }
  }
  foam = clamp(max(foam, shore), 0.0, 1.0);
  vec3 foamCol = vec3(0.9, 0.94, 0.96) * (0.28 + 0.62 * sunUp * (0.55 + 0.45 * ndl) + 0.1 * (1.0 - uStorm)) * (1.0 - 0.7 * uNight) * foamLit;
  foamCol = mix(foamCol, foamCol * vec3(0.8, 0.92, 0.95), (1.0 - foam) * 0.5);
  col = mix(col, foamCol, foam * 0.94);
  col *= 1.0 - 0.2 * uNight;
  gl_FragColor = vec4(col, 1.0);
  // same tail as three's built-in materials: tone-map, encode linear → output colour space, then fog (fogColor is
  // already in the output space)
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

// foam accumulation pass (full-screen triangle into a world-anchored toroidal render target)
const FOAM_VERT = /* glsl */`varying vec2 vUv; void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const FOAM_FRAG = /* glsl */`
#define NL 16
#define NLM 32
uniform vec4 uWaveA[NLM]; uniform vec4 uWaveB[NLM]; uniform float uBw[NLM];
uniform sampler2D uPrev; uniform vec2 uCfF; uniform vec2 uCfFPrev; uniform vec2 uPrevShift; uniform float uW;
uniform float uDecMul; uniform float uDecSub; uniform float uDecMul2; uniform float uDecSub2; uniform float uOldK;
uniform float uThr; uniform float uSoft; uniform float uK; uniform float uSeed; uniform vec2 uGrpOff; uniform float uGrpK;
uniform sampler2D uShelterTex; uniform vec4 uShelterRect;
varying vec2 vUv;
${GLSL_NOISE}
${GLSL_VNOISE}
void main() {
  vec2 rel = uW * (fract(vUv - uCfF + 0.5) - 0.5);                          // this texel's water, rel. the foam centre
  vec2 relPrev = uW * (fract(vUv - uCfFPrev + 0.5) - 0.5) + uPrevShift;     // the water it held at the last update
  vec2 prev = texture2D(uPrev, vUv).rg;
  vec2 dd = relPrev - rel;
  if (dot(dd, dd) > 1.0) prev = vec2(0.0);                                   // wrapped around the window: stale
  float sh = 0.0;
  if (uShelterRect.w > 0.5) {
    vec2 suv = (rel - uShelterRect.xy) / uShelterRect.z;
    if (suv.x > 0.0 && suv.y > 0.0 && suv.x < 1.0 && suv.y < 1.0) sh = texture2D(uShelterTex, suv).r;
  }
  float mL = 1.0 - sh, mM = 1.0 - 0.9 * sh;
  // Jacobian of the dominant waves (components weighted toward the spectral peak): whitecaps form on the big crests
  float jxx = 0.0, jzz = 0.0, jxz = 0.0;
  for (int i = 0; i < NLM; i++) {
    vec4 a = uWaveA[i]; vec4 b = uWaveB[i];
    float A = a.z * (i < NL ? mL : mM) * uBw[i];
    if (A < 1e-4) continue;
    float qs = b.y * a.w * A * sin(a.w * dot(a.xy, rel) + b.x);
    jxx += a.x * a.x * qs; jzz += a.y * a.y * qs; jxz += a.x * a.y * qs;
  }
  float J = (1.0 - jxx) * (1.0 - jzz) - jxz * jxz;
  // wave groups / short crests: a slowly drifting field (at the group velocity) decides where along a crest it breaks
  float grp = groupField(rel + uGrpOff, 42.0);
  float thr = uThr + (grp - 0.5) * uGrpK;
  float brk = smoothstep(thr + 0.3 * uSoft, thr - 0.7 * uSoft, J) * uK;
  // 8-bit storage: dither the decay so small values still fade at the right average rate
  float dth = (fract(sin(dot(vUv * 1371.0 + uSeed, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
  float act = max(prev.x * uDecMul - uDecSub + dth, brk);                    // active whitecap foam (seconds)
  float old = max(prev.y * uDecMul2 - uDecSub2 + dth, act * uOldK);          // residual foam / streak source (tens of s)
  gl_FragColor = vec4(clamp(act, 0.0, 1.0), clamp(old, 0.0, 1.0), 0.0, 1.0);
}`;

// spindrift: stateless GPU points, world-fixed in a toroidal box around the camera, born on breaking crests
const SPRAY_VERT = /* glsl */`
${GLSL_COMMON}
uniform vec2 uC; uniform vec2 uCamRel; uniform vec2 uCamInv; uniform float uR; uniform float uTime; uniform float uFrac;
uniform float uThr; uniform float uSoft; uniform vec3 uWindV; uniform float uLevel; uniform float uPx;
attribute vec4 aSeed;
varying float vA;
#include <fog_pars_vertex>
${GLSL_NOISE}
float jacAt(vec2 p, float age) {
  float jxx = 0.0, jzz = 0.0, jxz = 0.0;
  for (int i = 0; i < NLM; i++) {
    vec4 a = uWaveA[i]; vec4 b = uWaveB[i];
    if (a.z < 1e-3) continue;
    float qs = b.y * a.w * a.z * sin(a.w * dot(a.xy, p) + b.x + b.w * age);
    jxx += a.x * a.x * qs; jzz += a.y * a.y * qs; jxz += a.x * a.y * qs;
  }
  return (1.0 - jxx) * (1.0 - jzz) - jxz * jxz;
}
vec3 dispAt(vec2 p, float age) {
  vec3 d = vec3(0.0);
  for (int i = 0; i < NLM; i++) {
    vec4 a = uWaveA[i]; vec4 b = uWaveB[i];
    if (a.z < 1e-3) continue;
    float th = a.w * dot(a.xy, p) + b.x + b.w * age;
    float c = cos(th);
    d += vec3(a.x * b.y * a.z * c, a.z * sin(th), a.y * b.y * a.z * c);
  }
  return d;
}
void main() {
  vA = 0.0;
  float T = 1.3 + 1.7 * aSeed.y;
  float tt = uTime / T + aSeed.z * 13.0;
  float cyc = floor(tt), age = (tt - cyc) * T;
  vec2 hs = hash22(vec2(aSeed.x * 0.371 + 1.3, mod(cyc, 4093.0) * 0.731 + 0.17));
  vec2 d = mod(hs * 2.0 * uR - uCamInv + uR, 2.0 * uR) - uR;   // rel. camera, wrapped into the box (world-fixed)
  float J = 9.0; vec2 sp = uCamRel + d;
  if (aSeed.w < uFrac) {
    for (int c = 0; c < 4; c++) {
      vec2 p = uCamRel + d + (hash22(hs * 31.7 + float(c) * 4.1) - 0.5) * 22.0;
      float j = jacAt(p, age);
      if (j < J) { J = j; sp = p; }
    }
  }
  if (J > uThr) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  vec3 dsp = dispAt(sp, age);
  float r1 = hash12(hs * 17.3), r2 = hash12(hs * 7.9 + 1.1);
  vec3 p0 = vec3(uC.x + sp.x + dsp.x, uLevel + dsp.y + 0.3, uC.y + sp.y + dsp.z);
  vec3 vel = uWindV * (0.25 + 0.4 * r1) + vec3(0.0, 1.2 + 3.2 * r2, 0.0);
  vec3 pos = p0 + vel * age + vec3(0.0, -3.2 * age * age, 0.0);
  float strength = clamp((uThr - J) / uSoft * 2.0 + 0.35, 0.0, 1.0);
  vA = strength * smoothstep(0.0, 0.15, age) * (1.0 - smoothstep(0.4 * T, T, age)) * (1.0 - smoothstep(0.65 * uR, uR, length(d)));
  vec4 mvPosition = viewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  float size = (0.6 + 1.6 * r1) * (1.0 + 2.0 * age / T);
  gl_PointSize = clamp(size * uPx / max(1.0, -mvPosition.z), 0.0, 40.0);
  #include <fog_vertex>
}`;
const SPRAY_FRAG = /* glsl */`
uniform vec3 uCol; varying float vA;
#include <fog_pars_fragment>
void main() {
  float r = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.12, r) * vA;
  if (a < 0.01) discard;
  gl_FragColor = vec4(uCol, a * 0.8);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

// ------------------------------------------------------------------------------------------------ geometry
/** Clipmap near grid: L0 = n×n cells of s0 metres, each further ring doubles the cell and the extent; ring cells on
 *  the inner boundary are fanned from the finer ring's mid-edge vertex, so there are no T-junction cracks. */
function buildClipGrid(n, s0, levels) {
  const half = n / 2, verts = new Map(), pos = [], idx = [];
  const vid = (i, j) => {
    const key = (i + 1048576) * 2097152 + (j + 1048576);
    let v = verts.get(key);
    if (v === undefined) { v = pos.length / 3; verts.set(key, v); pos.push(i * s0, 0, j * s0); }
    return v;
  };
  const tri = (a, b, c) => {
    const ax = pos[a * 3], az = pos[a * 3 + 2];
    const cr = (pos[b * 3 + 2] - az) * (pos[c * 3] - ax) - (pos[b * 3] - ax) * (pos[c * 3 + 2] - az);
    if (cr > 0) idx.push(a, b, c); else idx.push(a, c, b); // upward-facing (front) winding
  };
  for (let k = 0; k < levels; k++) {
    const st = 1 << k, H = half * st, Hin = k ? (half * st) / 2 : 0;
    for (let cj = -H; cj < H; cj += st) for (let ci = -H; ci < H; ci += st) {
      if (k && ci >= -Hin && ci + st <= Hin && cj >= -Hin && cj + st <= Hin) continue;
      const inX = ci >= -Hin && ci + st <= Hin, inZ = cj >= -Hin && cj + st <= Hin;
      const P = [[ci, cj]];
      if (k && inX && cj === Hin) P.push([ci + st / 2, cj]);
      P.push([ci + st, cj]);
      if (k && inZ && ci + st === -Hin) P.push([ci + st, cj + st / 2]);
      P.push([ci + st, cj + st]);
      if (k && inX && cj + st === -Hin) P.push([ci + st / 2, cj + st]);
      P.push([ci, cj + st]);
      if (k && inZ && ci === Hin) P.push([ci, cj + st / 2]);
      const ids = P.map(([i, j]) => vid(i, j));
      if (ids.length === 4) {
        if (((ci / st) + (cj / st)) & 1) { tri(ids[0], ids[1], ids[2]); tri(ids[0], ids[2], ids[3]); } else { tri(ids[0], ids[1], ids[3]); tri(ids[1], ids[2], ids[3]); }
      } else {
        const mi = P.findIndex(([i, j]) => (i - ci) % st !== 0 || (j - cj) % st !== 0);
        for (let t = 1; t < ids.length - 1; t++) tri(ids[mi], ids[(mi + t) % ids.length], ids[(mi + t + 1) % ids.length]);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setIndex(new THREE.BufferAttribute(pos.length / 3 > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), half * s0 * (1 << (levels - 1)) * 1.5);
  return geo;
}
/** Flat far ring from the clipmap rim (same rim vertices, no cracks) out to ±FAR_OUT. */
function buildFarRing(n, s0, levels) {
  const R = (n / 2) * s0 * (1 << (levels - 1)), seg = n, rim = [];
  for (let i = 0; i < seg; i++) rim.push([-R + (2 * R * i) / seg, -R]);
  for (let i = 0; i < seg; i++) rim.push([R, -R + (2 * R * i) / seg]);
  for (let i = 0; i < seg; i++) rim.push([R - (2 * R * i) / seg, R]);
  for (let i = 0; i < seg; i++) rim.push([-R, R - (2 * R * i) / seg]);
  const pos = [], idx = [], m = rim.length, f = FAR_OUT / R;
  for (const [x, z] of rim) pos.push(x, 0, z);
  for (const [x, z] of rim) pos.push(x * f, 0, z * f);
  const tri = (a, b, c) => { const ax = pos[a * 3], az = pos[a * 3 + 2]; const cr = (pos[b * 3 + 2] - az) * (pos[c * 3] - ax) - (pos[b * 3] - ax) * (pos[c * 3 + 2] - az); if (cr > 0) idx.push(a, b, c); else idx.push(a, c, b); };
  for (let i = 0; i < m; i++) { const j = (i + 1) % m; tri(i, j, m + j); tri(i, m + j, m + i); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setIndex(idx);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), FAR_OUT * 1.5);
  return geo;
}

// ------------------------------------------------------------------------------------------------ Ocean
export class Ocean {
  constructor(scene, size = 4400, segs = 176) {
    this.scene = scene; this.size = size; this.segs = segs;
    // depth texture: same contract as ocean.js (160² texels over size·1.15 m around the ship, R = depth in metres)
    this.depthN = 160;
    this.depthData = new Uint8Array(this.depthN * this.depthN * 4).fill(255);
    this.depthTex = new THREE.DataTexture(this.depthData, this.depthN, this.depthN, THREE.RGBAFormat);
    this.depthTex.needsUpdate = true; this.depthTex.magFilter = THREE.LinearFilter; this.depthTex.minFilter = THREE.LinearFilter;
    this.depthCenter = { x: 1e9, z: 1e9 };
    this.depthSize = size * 1.15;
    this.level = 0; this.windF = 1; this.wind = 5; this.windDir = 240; this.rain = 0; this.storm = 0; this.hs = 0.8;
    this.windTarget = 1; this.seaSet = false; this.lastCam = null; this.time = 0;
    this.view = { x: 0, z: 0, ok: false };      // where the camera looks (grid centre before snapping)
    this.frameF = { x: 0, z: 0 };               // accumulated floating-origin shift (invariant world = local + frameF)
    this.grp = { x: 0, z: 0 };                  // wave-group field drift (m, invariant frame)
    this.stats = { hsWind: 0, hsSwell: 0, sigLM: 0, steep: 0, foamThr: 1, tp: 0, swellT: 0 };
    // per-component state (double precision on the CPU)
    const nW = NW;
    this.len = Float64Array.from(COMP, (c) => c.len);
    this.k = this.len.map((l) => TAU / l);
    this.w = this.k.map((k) => Math.sqrt(G * k));
    this.ph = Float64Array.from(COMP, (c) => c.ph);
    this.cas = Int8Array.from(COMP, (c) => c.cascade);
    this.fam = Int8Array.from(COMP, (c) => c.family);
    this.u = Float64Array.from(COMP, (c) => c.u);
    this.amp = new Float64Array(nW); this.amp1 = new Float64Array(nW); this.ang = new Float64Array(nW).fill(60);
    this.tAmp = new Float64Array(nW); this.tAng = new Float64Array(nW).fill(60);
    this.dx = new Float64Array(nW); this.dz = new Float64Array(nW); this.q = new Float64Array(nW); this.tph = new Float64Array(nW);
    this.pack = new Float64Array(NLM * PS); this.packPh = new Float64Array(NLM); this.packW = new Float64Array(NLM);
    this.packN = 0; this.packNL = 0; this.packT = NaN;
    this._E = new Float64Array(8);
    // shelter (harbour SDF → amplitude damping), sampled on a camera-following grid shared by CPU and GPU
    this.shelterFn = null; this.shelterOn = false;
    this.shelterData = new Float32Array(SHELTER_N * SHELTER_N); this.shelterPend = null; this.shelterRow = 0;
    this.shelterOrigin = { x: 0, z: 0 }; this.shelterPendOrigin = { x: 0, z: 0 };
    this.shelterBytes = new Uint8Array(SHELTER_N * SHELTER_N * 4);
    this.shelterTex = new THREE.DataTexture(this.shelterBytes, SHELTER_N, SHELTER_N, THREE.RGBAFormat);
    this.shelterTex.magFilter = THREE.LinearFilter; this.shelterTex.minFilter = THREE.LinearFilter; this.shelterTex.needsUpdate = true;
    // uniforms
    const waveA = COMP.map(() => new THREE.Vector4()), waveB = COMP.map(() => new THREE.Vector4());
    this.uniforms = {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uTime: { value: 0 }, uWind: { value: 5 }, uWindDir: { value: new THREE.Vector2(0.5, 0.866) }, uWaveA: { value: waveA }, uWaveB: { value: waveB },
      uC: { value: new THREE.Vector2() }, uVrel: { value: new THREE.Vector2() }, uS0: { value: 2 }, uR0: { value: 128 }, uSnap: { value: 8 }, uRmax: { value: 8192 },
      uVertShort: { value: 1 }, uNShortFrag: { value: 16 },
      uShelterTex: { value: this.shelterTex }, uShelterRect: { value: new THREE.Vector4(0, 0, 1, 0) },
      uDeep: { value: new THREE.Color(0x03203a) }, uShallow: { value: new THREE.Color(0x1d7f86) }, uSssCol: { value: new THREE.Color(0.05, 0.36, 0.32) },
      uSkyTop: { value: new THREE.Color(0x4a8fd6) }, uSkyHorizon: { value: new THREE.Color(0xbfd9ee) },
      uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.3).normalize() }, uSunColor: { value: new THREE.Color(0xfff2d0) },
      uDepth: { value: this.depthTex }, uDepthOrigin: { value: new THREE.Vector2(0, 0) }, uDepthSize: { value: this.depthSize }, uNight: { value: 0 },
      uRain: { value: 0 }, uStorm: { value: 0 }, uLevel: { value: 0 }, uDetail: { value: 1 }, uHs: { value: 0.8 },
      uShoreA: { value: noShoreTexture() }, uShoreB: { value: noShoreTexture() }, uShoreRectA: { value: new THREE.Vector4(0, 0, 1, 0) }, uShoreRectB: { value: new THREE.Vector4(0, 0, 1, 0) },
      uPixAng: { value: 0.0016 }, uMssSub: { value: 0.02 }, uSigLM: { value: 0.05 }, uFoamA: { value: 3 }, uFoamSoft: { value: 0.9 }, uFoamK: { value: 0 }, uStreak: { value: 0 }, uOldMean: { value: 0 }, uGrpOff: { value: new THREE.Vector2() }, uGrpK: { value: 0 }, uSigB: { value: 0.05 },
      uFoamTex: { value: noShoreTexture() }, uFoamOff: { value: new THREE.Vector2() }, uFoamShift: { value: new THREE.Vector2() }, uFoamW: { value: FOAM_W }, uFoamOn: { value: 0 },
      uPatOff: { value: new THREE.Vector2() },
    };
    this.material = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, fog: true });
    const prep = (renderer, scene2, camera) => this.prepare(renderer, camera);
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 1; this.mesh.onBeforeRender = prep;
    this.far = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.far.frustumCulled = false; this.far.renderOrder = 0; this.far.onBeforeRender = prep;
    scene.add(this.far); scene.add(this.mesh);
    // foam accumulation (ping-pong render targets, created on the first update with a renderer)
    this.foamN = 512; this.foamRT = null; this.foamIdx = 0; this.foamAcc = 0; this.foamPrev = null; this.foamX = { x: 0, z: 0 };
    this.foamUniforms = {
      uWaveA: { value: waveA.slice(0, NLM) }, uWaveB: { value: COMP.slice(0, NLM).map(() => new THREE.Vector4()) },
      uPrev: { value: null }, uCfF: { value: new THREE.Vector2() }, uCfFPrev: { value: new THREE.Vector2() }, uPrevShift: { value: new THREE.Vector2() }, uW: { value: FOAM_W },
      uDecMul: { value: 1 }, uDecSub: { value: 0 }, uDecMul2: { value: 1 }, uDecSub2: { value: 0 }, uOldK: { value: 0.7 }, uThr: { value: 0 }, uSoft: { value: 0.05 }, uK: { value: 0 }, uSeed: { value: 0 }, uGrpOff: { value: new THREE.Vector2() }, uGrpK: { value: 0 },
      uBw: { value: new Array(NLM).fill(1) },
      uShelterTex: { value: this.shelterTex }, uShelterRect: { value: new THREE.Vector4(0, 0, 1, 0) },
    };
    this.foamScene = new THREE.Scene();
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    const fq = new THREE.Mesh(tri, new THREE.ShaderMaterial({ uniforms: this.foamUniforms, vertexShader: FOAM_VERT, fragmentShader: FOAM_FRAG, depthTest: false, depthWrite: false }));
    fq.frustumCulled = false; this.foamScene.add(fq);
    this.foamCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    // spindrift
    this.sprayUniforms = {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uWaveA: { value: waveA }, uWaveB: { value: waveB }, uC: this.uniforms.uC, uCamRel: { value: new THREE.Vector2() }, uCamInv: { value: new THREE.Vector2() },
      uR: { value: SPRAY_R }, uTime: { value: 0 }, uFrac: { value: 0 }, uThr: { value: 0 }, uSoft: { value: 0.05 }, uWindV: { value: new THREE.Vector3() },
      uLevel: this.uniforms.uLevel, uPx: { value: 600 }, uCol: { value: new THREE.Color(1, 1, 1) },
    };
    this.sprayMat = new THREE.ShaderMaterial({ uniforms: this.sprayUniforms, vertexShader: SPRAY_VERT, fragmentShader: SPRAY_FRAG, transparent: true, depthWrite: false, fog: true });
    this.spray = new THREE.Points(new THREE.BufferGeometry(), this.sprayMat);
    this.spray.frustumCulled = false; this.spray.renderOrder = 3; this.spray.visible = false;
    this.spray.onBeforeRender = prep;
    scene.add(this.spray);
    this._v2 = new THREE.Vector2();
    this.tier = -1;
    this.setQuality(defaultQuality());
    this.setWind(5, 240);
    this.snapSea();
    this.refreshTable(0);
    active = this;
  }

  // ------------------------------------------------------------------ quality
  /** 0..1: grid density (64/96/128 cells per ring), short-cascade components per pixel, foam target size, spray count. */
  setQuality(q) {
    q = THREE.MathUtils.clamp(Number.isFinite(q) ? q : 1, 0, 1);
    this.quality = q;
    const u = this.uniforms;
    u.uDetail.value = q;
    u.uNShortFrag.value = Math.round(6 + 10 * q);
    u.uVertShort.value = q >= 0.4 ? 1 : 0;
    const tier = q >= 0.75 ? 2 : q >= 0.4 ? 1 : 0;
    if (tier === this.tier) return;
    this.tier = tier;
    const { n, s0 } = TIERS[tier];
    this.gridN = n; this.s0 = s0; this.snapQ = 4 * s0;
    this.mesh.geometry.dispose(); this.mesh.geometry = this.buildNearGrid(n, s0);
    this.far.geometry.dispose(); this.far.geometry = buildFarRing(n, s0, LEVELS);
    u.uS0.value = s0; u.uR0.value = (n / 2) * s0; u.uSnap.value = this.snapQ; u.uRmax.value = (n / 2) * s0 * (1 << (LEVELS - 1));
    // foam target + spray budget
    const fN = tier === 2 ? 512 : 256;
    if (this.foamRT && this.foamRT[0].width !== fN) { this.foamRT.forEach((r) => r.dispose()); this.foamRT = null; }
    this.foamN = fN;
    const nSpray = tier === 2 ? 4000 : tier === 1 ? 2000 : 800;
    const seeds = new Float32Array(nSpray * 4), rnd = rng32(0x5b7a9);
    for (let i = 0; i < nSpray; i++) { seeds[i * 4] = i; seeds[i * 4 + 1] = rnd(); seeds[i * 4 + 2] = rnd(); seeds[i * 4 + 3] = rnd(); }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nSpray * 3), 3));
    sg.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    this.spray.geometry.dispose(); this.spray.geometry = sg;
  }
  /** Build the near (clipmap) grid — kept under ocean.js's method name; `size`/`segs` here are cells-per-ring and cell size. */
  buildNearGrid(n = this.gridN, s0 = this.s0) { return buildClipGrid(n, s0, LEVELS); }

  // ------------------------------------------------------------------ sea state
  /** Legacy / fallback input: wind speed (m/s) and optional FROM direction (deg). Derives a fetch-limited wind sea unless setSea() has spoken. */
  setWind(ms, dirDeg) {
    ms = Number.isFinite(ms) ? Math.max(0, ms) : 5;
    this.wind = ms; if (Number.isFinite(dirDeg)) this.windDir = dirDeg;
    this.windTarget = THREE.MathUtils.clamp(0.25 + ms / 12, 0.3, 2.2); // kept for callers that read windF
    if (this.seaSet) return;
    this.applySea({ windSpd: ms, windDir: this.windDir });
  }
  /** Full sea state. Accepts the flat contract shape OR game.weatherAt()'s nested shape (wind/waves/swell objects). The first call snaps; later ones crossfade (~20 s). */
  setSea(o) {
    if (!o) return;
    const first = !this.seaSet;
    this.seaSet = true;
    const windSpd = num(o.windSpd, num(o.wind?.spd, this.wind));
    const windDir = num(o.windDir, num(o.wind?.dir, this.windDir));
    this.wind = windSpd; this.windDir = windDir;
    this.windTarget = THREE.MathUtils.clamp(0.25 + windSpd / 12, 0.3, 2.2);
    if (Number.isFinite(o.storm)) this.storm = THREE.MathUtils.clamp(o.storm, 0, 1);
    if (Number.isFinite(o.rain)) this.rain = THREE.MathUtils.clamp(o.rain, 0, 1);
    this.applySea({
      windSpd, windDir,
      waveH: num(o.waveH, num(o.waves?.height, NaN)), waveDir: num(o.waveDir, num(o.waves?.dir, NaN)), wavePeriod: num(o.wavePeriod, num(o.waves?.period, NaN)),
      swellH: num(o.swellH, num(o.swell?.height, NaN)), swellDir: num(o.swellDir, num(o.swell?.dir, NaN)), swellPeriod: num(o.swellPeriod, num(o.swell?.period, NaN)),
    });
    if (first) this.snapSea();
  }
  /** ocean.js compatibility: the target component table as [{ amp, ang }] (a snapshot; set the sea with setSea). */
  get target() { return Array.from(this.tAmp, (amp, i) => ({ amp, ang: this.tAng[i] })); }
  /** Jump the live sea to the current target at once (no crossfade) — first contact, teleports, tests. */
  snapSea() { this.amp.set(this.tAmp); this.amp1.set(this.tAmp); this.ang.set(this.tAng); this.refreshTable(this.time); }
  /** Compute the target component table from a (possibly partial) sea description. Missing wave data is derived from the wind. */
  applySea(s) {
    const U = Math.max(0, num(s.windSpd, 5));
    let waveH = Number.isFinite(s.waveH) ? Math.max(0, s.waveH) : Math.min(9, 0.1 + 0.016 * U * U);
    let Tp = Number.isFinite(s.wavePeriod) && s.wavePeriod > 1 ? s.wavePeriod : THREE.MathUtils.clamp(2.5 + 0.45 * U, 3, 12);
    const waveFrom = Number.isFinite(s.waveDir) ? s.waveDir : num(s.windDir, this.windDir);
    let swellH = Number.isFinite(s.swellH) ? Math.max(0, s.swellH) : 0;
    const swellT = Number.isFinite(s.swellPeriod) && s.swellPeriod > 1 ? s.swellPeriod : 11;
    const swellFrom = Number.isFinite(s.swellDir) ? s.swellDir : waveFrom;
    if (!Number.isFinite(s.waveH) && !Number.isFinite(s.swellH)) swellH = Math.min(1.5, 0.15 + U * 0.04); // a little background swell
    // Open-Meteo wave_height is the combined sea: split the wind sea off when the swell is given too
    let Hw = waveH;
    if (Number.isFinite(s.waveH) && Number.isFinite(s.swellH) && swellH > 0) Hw = Math.sqrt(Math.max(0, waveH * waveH - swellH * swellH));
    // a wind sea cannot be steeper than Hs/λp ≈ 1/16: lengthen implausibly short periods
    Tp = Math.max(Tp, Math.sqrt((TAU * 16 * Hw) / G), 1.6);
    this.hs = Math.sqrt(Hw * Hw + swellH * swellH);
    this.stats.hsWind = Hw; this.stats.hsSwell = swellH; this.stats.tp = Tp; this.stats.swellT = swellT;
    // ---- wind sea: JONSWAP energy integrated over each component's band (bands = geometric midpoints in ω)
    const wp = TAU / Tp, ids = [];
    for (let i = 0; i < NW; i++) if (this.fam[i] === 0) ids.push(i);
    ids.sort((a, b) => this.w[a] - this.w[b]);
    const E = new Float64Array(NW);
    let sumE = 0;
    for (let j = 0; j < ids.length; j++) {
      const wi = this.w[ids[j]];
      const lo = j > 0 ? Math.sqrt(this.w[ids[j - 1]] * wi) : wi * Math.sqrt(wi / this.w[ids[j + 1]]);
      const hi = j < ids.length - 1 ? Math.sqrt(this.w[ids[j + 1]] * wi) : wi * Math.sqrt(wi / this.w[ids[j - 1]]);
      let e = 0; const nInt = 8, dw = (hi - lo) / nInt;
      for (let q = 0; q <= nInt; q++) e += jonswap(lo + q * dw, wp) * (q === 0 || q === nInt ? 1 : q % 2 ? 4 : 2);
      e *= dw / 3;
      E[ids[j]] = e; sumE += e;
    }
    // directional spreading (Mitsuyasu cos^2s(θ/2), s_max bounded like Goda's 7…20): s peaks at the spectral peak and
    // broadens away from it. With ~1 component per band, the spreading quantile a component samples is assigned by
    // energy rank — the dominant components sit near the mean direction (long-crested swells you can follow), the
    // weak ones carry the tails (short-crested chop) — plus a fixed per-component jitter.
    const cp = G / wp, sp = THREE.MathUtils.clamp(11.5 * Math.pow(Math.max(0.3, (U + 0.5) / cp), -2.5), 7, 20);
    const travel = waveFrom + 180;
    this.seaTravel = travel;
    for (const i of ids) {
      const a = sumE > 0 && Hw > 0 ? Math.sqrt(2 * E[i] / sumE) * (Hw / 4) : 0; // Σ a²/2 = (Hw/4)²
      this.tAmp[i] = Math.min(a, 0.06 * this.len[i]);
    }
    const rankU = (r, i) => (r < RANK_U.length ? RANK_U[r] : 0.03 + 0.94 * ((0.5 + r * 0.6180339887) % 1)) + (this.u[i] - 0.5) * 0.04;
    [...ids].sort((a, b) => this.tAmp[b] - this.tAmp[a]).forEach((i, r) => {
      const rw = this.w[i] / wp, sI = THREE.MathUtils.clamp(rw < 1 ? sp * Math.pow(rw, 5) : sp * Math.pow(rw, -2.5), 1, 25);
      this.tAng[i] = travel + spreadAngle(THREE.MathUtils.clamp(rankU(r, i), 0.03, 0.97), sI) / D2R;
    });
    // ---- swell: narrow log-normal band around the swell frequency (≥ two slots share it → wave groups / sets)
    const ws = TAU / swellT, sw = [];
    let sumS = 0;
    for (let i = 0; i < NW; i++) if (this.fam[i] === 1) { const x = Math.log(this.w[i] / ws); const e = Math.exp(-(x * x) / (2 * 0.085 * 0.085)) * this.w[i]; sw.push([i, e]); sumS += e; }
    const stravel = swellFrom + 180;
    for (const [i, e] of sw) this.tAmp[i] = sumS > 0 ? Math.min(Math.sqrt(2 * e / sumS) * (swellH / 4), 0.035 * this.len[i]) : 0;
    sw.map(([i]) => i).sort((a, b) => this.tAmp[b] - this.tAmp[a]).forEach((i, r) => { this.tAng[i] = stravel + spreadAngle(THREE.MathUtils.clamp(rankU(r, i), 0.05, 0.95), 45) / D2R; });
    // keep target angles within ±180° of the live ones so easing takes the short way round
    for (let i = 0; i < NW; i++) this.tAng[i] = this.ang[i] + (((this.tAng[i] - this.ang[i]) % 360) + 540) % 360 - 180;
  }
  /** Tide: vertical offset of the whole surface (both meshes, heightAt, wakes). */
  setLevel(y) { this.level = Number.isFinite(y) ? y : 0; oceanState.level = this.level; }
  setRain(r) { this.rain = THREE.MathUtils.clamp(Number.isFinite(r) ? r : 0, 0, 1); }
  setStorm(s) { this.storm = THREE.MathUtils.clamp(Number.isFinite(s) ? s : 0, 0, 1); }
  setSun(dir, color, night, skyTop, skyHorizon) {
    this.uniforms.uSunDir.value.copy(dir); this.uniforms.uSunColor.value.copy(color); this.uniforms.uNight.value = night;
    this.uniforms.uSkyTop.value.copy(skyTop); this.uniforms.uSkyHorizon.value.copy(skyHorizon);
  }
  /**
   * Sheltered water: fn(x, z) → 0..1 in the current floating-origin frame (1 = fully sheltered, e.g. inside the
   * breakwaters; null removes it). It is sampled on a 128² grid over 4 km around the view (32 m cells, blurred so the
   * damping fades over ~150 m), rebuilt incrementally as the camera moves; the GPU and heightAt share the same grid.
   */
  setShelter(fn) {
    this.shelterFn = typeof fn === 'function' ? fn : null;
    this.shelterPend = null;
    if (!this.shelterFn) { this.shelterOn = false; this.uniforms.uShelterRect.value.w = 0; this.foamUniforms.uShelterRect.value.w = 0; return; }
    const v = this.view.ok ? this.view : (this.lastCam || { x: 0, z: 0 });
    this.startShelter(v.x, v.z);
    while (this.shelterPend) this.stepShelter(SHELTER_N);
  }
  startShelter(cx, cz) {
    const cell = SHELTER_SIZE / SHELTER_N;
    this.shelterPend = new Float32Array(SHELTER_N * SHELTER_N); this.shelterRow = 0;
    this.shelterPendOrigin.x = Math.round(cx / cell) * cell - SHELTER_SIZE / 2; this.shelterPendOrigin.z = Math.round(cz / cell) * cell - SHELTER_SIZE / 2;
  }
  stepShelter(rows) {
    const fn = this.shelterFn, P = this.shelterPend, n = SHELTER_N, cell = SHELTER_SIZE / n, o = this.shelterPendOrigin;
    if (!fn || !P) return;
    const end = Math.min(n, this.shelterRow + rows);
    for (let j = this.shelterRow; j < end; j++) for (let i = 0; i < n; i++) {
      let v = 0; try { v = +fn(o.x + (i + 0.5) * cell, o.z + (j + 0.5) * cell); } catch { v = 0; }
      P[j * n + i] = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
    }
    this.shelterRow = end;
    if (end < n) return;
    // separable box blur, radius 2 cells (≈ 150 m transition), then publish
    const tmp = new Float32Array(n * n), r = 2;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { let s = 0, c = 0; for (let d = -r; d <= r; d++) { const ii = i + d; if (ii >= 0 && ii < n) { s += P[j * n + ii]; c++; } } tmp[j * n + i] = s / c; }
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { let s = 0, c = 0; for (let d = -r; d <= r; d++) { const jj = j + d; if (jj >= 0 && jj < n) { s += tmp[jj * n + i]; c++; } } P[j * n + i] = s / c; }
    let any = false;
    for (let t = 0; t < n * n; t++) { const b = Math.round(P[t] * 255); this.shelterBytes[t * 4] = b; this.shelterBytes[t * 4 + 3] = 255; if (b) any = true; }
    this.shelterData = P; this.shelterPend = null;
    this.shelterOrigin.x = o.x; this.shelterOrigin.z = o.z;
    this.shelterTex.needsUpdate = true;
    this.shelterOn = any;
  }
  _shelterAt(x, z) {
    const n = SHELTER_N, cell = SHELTER_SIZE / n;
    const fx = (x - this.shelterOrigin.x) / cell - 0.5, fz = (z - this.shelterOrigin.z) / cell - 0.5;
    if (!(fx >= 0 && fz >= 0 && fx < n - 1 && fz < n - 1)) return 0;
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j, D = this.shelterData, o = j * n + i;
    return (D[o] * (1 - tx) + D[o + 1] * tx) * (1 - tz) + (D[o + n] * (1 - tx) + D[o + n + 1] * tx) * tz;
  }

  /** Re-derive directions, steepness, statistics, the GPU tables and the CPU pack from the live (amp, ang). */
  refreshTable(time = this.time) {
    const U = this.wind;
    const chop = THREE.MathUtils.clamp(0.3 + (0.7 * (U - 2)) / 12, 0.3, 1);
    const skA = [0, 0, 0];
    for (let i = 0; i < NW; i++) skA[this.cas[i]] += this.k[i] * this.amp[i];
    // Q may exceed 1 (sharper than linear theory, like Tessendorf's choppiness) as long as the cascade budget holds
    const Qc = skA.map((s, c) => (s > 1e-9 ? Math.min(QMAX[c], (BUDGET[c] * chop) / s) : 0));
    let sigLM = 0, sigS = 0, mss = 0, steep = 0;
    const A = this.uniforms.uWaveA.value, B = this.uniforms.uWaveB.value;
    for (let i = 0; i < NW; i++) {
      const a = this.ang[i] * D2R, amp = this.amp[i], k = this.k[i];
      this.dx[i] = Math.sin(a); this.dz[i] = -Math.cos(a);
      const q = Qc[this.cas[i]]; this.q[i] = q;
      this.tph[i] = wrapTau(this.ph[i] - this.w[i] * time);
      const qka = q * k * amp;
      if (i < NLM) sigLM += 0.5 * qka * qka; else sigS += 0.5 * qka * qka;
      mss += 0.5 * k * k * amp * amp; steep += qka;
      A[i].set(this.dx[i], this.dz[i], amp, k); B[i].y = q; B[i].z = this.len[i]; B[i].w = this.w[i];
      const W = WAVES[i]; W.dx = this.dx[i]; W.dz = this.dz[i]; W.amp = amp; W.q = q; W.ph = this.ph[i]; W.ang = this.ang[i];
    }
    this.stats.sigLM = Math.sqrt(sigLM); this.stats.steep = steep;
    // breaking weights: whitecaps belong to the dominant waves (λ ≥ ~0.4 λp at full weight, swell partly)
    const lp = Math.max(8, (G * this.stats.tp * this.stats.tp) / TAU), bw = this.foamUniforms.uBw.value;
    let sigB = 0;
    for (let i = 0; i < NLM; i++) {
      const w = this.fam[i] === 1 ? 0.7 : 0.2 + 0.8 * smooth01(0.12, 0.45, this.len[i] / lp);
      bw[i] = w; const v = w * this.q[i] * this.k[i] * this.amp[i]; sigB += 0.5 * v * v;
    }
    this.stats.sigB = Math.sqrt(sigB);
    // CPU pack: long + mid components with non-negligible amplitude
    let n = 0, nL = 0;
    const P = this.pack;
    for (let i = 0; i < NLM; i++) {
      const amp = this.amp[i];
      if (amp < 2e-4) continue;
      const k = this.k[i], dx = this.dx[i], dz = this.dz[i], qa = this.q[i] * amp, o = n * PS;
      P[o] = k * dx; P[o + 1] = k * dz; P[o + 2] = amp; P[o + 3] = qa * dx; P[o + 4] = qa * dz; P[o + 5] = amp * k * dx; P[o + 6] = amp * k * dz;
      P[o + 7] = qa * dx * k * dx; P[o + 8] = qa * dz * k * dz; P[o + 9] = qa * dx * k * dz; P[o + 10] = this.tph[i];
      this.packPh[n] = this.ph[i]; this.packW[n] = this.w[i];
      n++; if (i < NL) nL++;
    }
    this.packN = n; this.packNL = nL; this.packT = time;
    // whitecaps: Monahan coverage → fraction of the sea actively breaking → Jacobian threshold in σ units
    const u = this.uniforms;
    const W = Math.min(0.25, 0.45 * 3.84e-6 * Math.pow(Math.max(U, 0.1), 3.41)); // ~45 % of Monahan's total coverage is active breaking
    u.uFoamA.value = zTail(Math.max(W, 1e-6));
    u.uFoamK.value = smooth01(4.5, 8, U) * Math.min(1, this.hs / 0.4);
    u.uSigLM.value = this.stats.sigLM;
    u.uStreak.value = smooth01(12, 22, U);
    u.uOldMean.value = 0.35 * smooth01(8, 26, U);
    this.stats.foamThr = 1 - u.uFoamA.value * this.stats.sigLM;
    // glitter roughness: Cox–Munk total slope variance minus what the spectrum resolves (never below 35 %)
    const cm = 0.003 + 0.00512 * U;
    u.uMssSub.value = Math.max(0.35 * cm, cm - mss);
  }
  /** Phase table of the CPU pack for time t (cached per t). */
  _phaseFor(t) {
    if (t === this.packT) return;
    const P = this.pack, n = this.packN;
    for (let j = 0; j < n; j++) P[j * PS + 10] = wrapTau(this.packPh[j] - this.packW[j] * t);
    this.packT = t;
  }
  /** Sum the long + mid components at the rest point (px, pz): E = [y, ox, oz, ∂y/∂x, ∂y/∂z, jxx, jzz, jxz]. */
  _evalLM(px, pz, mL, mM) {
    const P = this.pack, n = this.packN, nL = this.packNL;
    let y = 0, ox = 0, oz = 0, sx = 0, sz = 0, jxx = 0, jzz = 0, jxz = 0;
    for (let j = 0; j < n; j++) {
      const o = j * PS, m = j < nL ? mL : mM;
      const fi = (P[o] * px + P[o + 1] * pz + P[o + 10]) * SC_K, fl = Math.floor(fi), f = fi - fl;
      const i0 = fl & SC_MASK, i1 = (i0 + SC_Q) & SC_MASK;
      const a0 = SIN_T[i0], b0 = SIN_T[i1];
      const s = (a0 + (SIN_T[i0 + 1] - a0) * f) * m, c = (b0 + (SIN_T[i1 + 1] - b0) * f) * m;
      y += P[o + 2] * s; ox += P[o + 3] * c; oz += P[o + 4] * c; sx += P[o + 5] * c; sz += P[o + 6] * c;
      jxx += P[o + 7] * s; jzz += P[o + 8] * s; jxz += P[o + 9] * s;
    }
    const E = this._E;
    E[0] = y; E[1] = ox; E[2] = oz; E[3] = sx; E[4] = sz; E[5] = jxx; E[6] = jzz; E[7] = jxz;
  }
  /** Find the rest point whose displaced position is (x, z) (Newton, ≤ 2 evaluations); leaves E at that point; returns the final correction step in _dp. */
  _invert(x, z, t) {
    this._phaseFor(Number.isFinite(t) ? t : this.time);
    let mL = 1, mM = 1;
    if (this.shelterOn) { const s = this._shelterAt(x, z); mL = 1 - s; mM = 1 - 0.9 * s; }
    const E = this._E;
    let px = x, pz = z, ddx = 0, ddz = 0;
    for (let it = 0; it < 2; it++) {
      this._evalLM(px, pz, mL, mM);
      const Fx = px + E[1] - x, Fz = pz + E[2] - z;
      if (Fx * Fx + Fz * Fz < 1e-6) { ddx = 0; ddz = 0; break; }
      const a11 = 1 - E[5], a22 = 1 - E[6], a12 = -E[7], det = a11 * a22 - a12 * a12 || 1e-6;
      ddx = -(a22 * Fx - a12 * Fz) / det; ddz = -(a11 * Fz - a12 * Fx) / det;
      px += ddx; pz += ddz;
    }
    this._dpx = ddx; this._dpz = ddz; this._px = px; this._pz = pz;
  }
  /** Vertical wave displacement (no tide) of the surface point above world (x, z). */
  _height(x, z, t) {
    this._invert(x, z, t);
    const E = this._E;
    return E[0] + E[3] * this._dpx + E[4] * this._dpz; // first-order finish of the last Newton step
  }
  /** Surface height (tide level + waves) at world (x, z); matches the drawn long + mid cascades (short ripples ignored). */
  heightAt(x, z, time) { return this.level + this._height(x, z, Number.isFinite(time) ? time : this.time); }
  /** Lagrangian displacement {x, y, z} of the water particle whose rest position is (x, z) (no tide; long + mid). */
  displacementAt(x, z, time, out = { x: 0, y: 0, z: 0 }) {
    this._phaseFor(Number.isFinite(time) ? time : this.time);
    let mL = 1, mM = 1;
    if (this.shelterOn) { const s = this._shelterAt(x, z); mL = 1 - s; mM = 1 - 0.9 * s; }
    this._evalLM(x, z, mL, mM);
    out.x = this._E[1]; out.y = this._E[0]; out.z = this._E[2];
    return out;
  }
  /** Unit surface normal {x, y, z} of the surface above world (x, z) (long + mid). */
  normalAt(x, z, time, out = { x: 0, y: 1, z: 0 }) {
    this._invert(x, z, Number.isFinite(time) ? time : this.time);
    const E = this._E, sx = E[3], sz = E[4], jxx = E[5], jzz = E[6], jxz = E[7];
    const nx = sz * -jxz - (1 - jzz) * sx, ny = (1 - jzz) * (1 - jxx) - jxz * jxz, nz = -jxz * sx - sz * (1 - jxx);
    const l = Math.hypot(nx, ny, nz) || 1;
    out.x = nx / l; out.y = ny / l; out.z = nz / l;
    return out;
  }

  // ------------------------------------------------------------------ per frame
  /**
   * The floating origin moved: (px, pz) is the NEW origin expressed in the OLD frame (main.js recentre's `p`), so every
   * old coordinate becomes (x − px, z − pz). Waves, foam, shelter grid and depth texture stay on the same water. Calling
   * this from recentre() is exact for any shift; without it update() still detects jumps over 1 km.
   */
  shiftOrigin(px, pz) {
    if (!Number.isFinite(px) || !Number.isFinite(pz) || (px === 0 && pz === 0)) return;
    for (let i = 0; i < NW; i++) this.ph[i] += this.k[i] * (this.dx[i] * px + this.dz[i] * pz);
    this.frameF.x += px; this.frameF.z += pz;
    this.view.x -= px; this.view.z -= pz;
    if (this.lastCam) { this.lastCam.x -= px; this.lastCam.z -= pz; }
    if (this.foamPrev) { this.foamPrev.x -= px; this.foamPrev.z -= pz; }
    this.shelterOrigin.x -= px; this.shelterOrigin.z -= pz;
    if (this.shelterPend) { this.shelterPendOrigin.x -= px; this.shelterPendOrigin.z -= pz; }
    this.depthCenter.x -= px; this.depthCenter.z -= pz; this.uniforms.uDepthOrigin.value.x -= px; this.uniforms.uDepthOrigin.value.y -= pz;
    this.refreshTable(this.time);
  }
  update(time, cx, cz, dt) {
    dt = Number.isFinite(dt) ? Math.min(0.25, Math.max(0, dt)) : 0.016;
    time = Number.isFinite(time) ? time : this.time + dt;
    this.time = time;
    this.windF += ((this.windTarget ?? 1) - this.windF) * Math.min(1, dt * 0.2);
    // a camera jump no ship can make in one frame (even at 400× warp ≤ 750 m) is a floating-origin shift or a teleport
    // that main.js did not announce through shiftOrigin(): keep the wave pattern on the same water
    if (this.lastCam && Math.hypot(cx - this.lastCam.x, cz - this.lastCam.z) > 1000) this.shiftOrigin(this.lastCam.x - cx, this.lastCam.z - cz);
    if (!this.lastCam) this.lastCam = { x: cx, z: cz }; else { this.lastCam.x = cx; this.lastCam.z = cz; }
    if (!this.view.ok) { this.view.x = cx; this.view.z = cz; }
    // ease the live table toward the target: amplitudes through two cascaded τ = 5 s stages (S-shaped crossfade, 60 %
    // after 10 s, 90 % after 20 s), directions ≤ 2.5°/s with the phase held at the view centre
    const ka = 1 - Math.exp(-dt / 5), px = this.view.x, pz = this.view.z;
    for (let i = 0; i < NW; i++) {
      this.amp1[i] += (this.tAmp[i] - this.amp1[i]) * ka;
      this.amp[i] += (this.amp1[i] - this.amp[i]) * ka;
      const d = this.tAng[i] - this.ang[i];
      if (Math.abs(d) > 0.001) {
        const step = Math.sign(d) * Math.min(Math.abs(d), 2.5 * dt);
        const a0 = this.ang[i] * D2R, a1 = (this.ang[i] + step) * D2R;
        this.ph[i] += this.k[i] * ((Math.sin(a0) - Math.sin(a1)) * px + (-Math.cos(a0) + Math.cos(a1)) * pz);
        this.ang[i] += step;
      }
      if (this.ph[i] > 1e4 || this.ph[i] < -1e4) this.ph[i] %= TAU;
    }
    this.refreshTable(time);
    // wave-group field drifts with the dominant waves at the group velocity g·Tp/4π
    const cg = (G * this.stats.tp) / (4 * Math.PI), ta = (this.seaTravel ?? this.windDir + 180) * D2R;
    this.grp.x = posMod(this.grp.x + Math.sin(ta) * cg * dt, GRP_PERIOD); this.grp.z = posMod(this.grp.z - Math.cos(ta) * cg * dt, GRP_PERIOD);
    const u = this.uniforms;
    u.uTime.value = time; u.uWind.value = this.wind; u.uRain.value = this.rain; u.uLevel.value = this.level; u.uHs.value = this.hs;
    u.uStorm.value = Math.max(this.storm, 0.65 * smooth01(15, 30, this.wind));
    this.bindShoreFields(cx, cz);
    const wa = (this.windDir + 180) * D2R;
    u.uWindDir.value.set(Math.sin(wa), -Math.cos(wa));
    // shelter grid follows the view (incremental rebuild, 16 rows per frame)
    if (this.shelterFn) {
      if (!this.shelterPend && Math.max(Math.abs(this.view.x - (this.shelterOrigin.x + SHELTER_SIZE / 2)), Math.abs(this.view.z - (this.shelterOrigin.z + SHELTER_SIZE / 2))) > SHELTER_SIZE / 4) this.startShelter(this.view.x, this.view.z);
      if (this.shelterPend) this.stepShelter(16);
    }
    // foam accumulation at a fixed 20 Hz (needs the renderer, captured on the first draw)
    this.foamAcc += dt;
    if (this._renderer && u.uFoamK.value > 0 && this.foamAcc >= 0.05) { this.runFoam(this._renderer, Math.min(this.foamAcc, 0.25)); this.foamAcc = 0; }
    else if (u.uFoamK.value <= 0) { u.uFoamOn.value = 0; this.foamPrev = null; }
    // spindrift
    const sprayK = smooth01(14, 24, this.wind) * Math.min(1, this.hs / 1.5);
    this.spray.visible = sprayK > 0.01;
    const su = this.sprayUniforms;
    su.uTime.value = time; su.uFrac.value = sprayK * 0.9;
    su.uThr.value = 1 - (u.uFoamA.value + 0.1) * this.stats.sigLM; su.uSoft.value = 0.6 * this.stats.sigLM + 1e-4;
    su.uWindV.value.set(Math.sin(wa) * this.wind, 0, -Math.cos(wa) * this.wind);
    const sunUp = THREE.MathUtils.clamp(u.uSunDir.value.y * 4, 0, 1) * (1 - u.uNight.value * 0.9);
    su.uCol.value.setRGB(0.92, 0.95, 0.97).multiplyScalar((0.3 + 0.7 * sunUp) * (1 - 0.7 * u.uNight.value));
    oceanState.time = time; oceanState.level = this.level; oceanState.hs = this.hs; oceanState.wind = this.wind; oceanState.windDir = this.windDir;
    active = this;
  }
  /** Per draw (onBeforeRender of the meshes): centre the grid where the camera looks, snap it, re-reference the phases. */
  prepare(renderer, camera) {
    if (renderer) this._renderer = renderer;
    if (!camera || !camera.matrixWorld) return;
    const e = camera.matrixWorld.elements, cx = e[12], cy = e[13], cz = e[14];
    const fx = -e[8], fz = -e[10], hl = Math.hypot(fx, fz);
    const off = Math.min(180, 2 * Math.max(2, cy - this.level)) * smooth01(0.08, 0.4, hl);
    const vx = cx + (hl > 1e-6 ? (fx / hl) * off : 0), vz = cz + (hl > 1e-6 ? (fz / hl) * off : 0);
    this.view.x = vx; this.view.z = vz; this.view.ok = true;
    const sn = this.snapQ, Cx = Math.round(vx / sn) * sn, Cz = Math.round(vz / sn) * sn;
    const u = this.uniforms;
    u.uC.value.set(Cx, Cz); u.uVrel.value.set(vx - Cx, vz - Cz);
    const B = u.uWaveB.value;
    for (let i = 0; i < NW; i++) B[i].x = wrapTau(this.tph[i] + this.k[i] * (this.dx[i] * Cx + this.dz[i] * Cz));
    if (camera.isPerspectiveCamera && renderer) {
      renderer.getDrawingBufferSize(this._v2);
      const t2 = 2 * Math.tan((camera.fov * D2R) / 2) / Math.max(1, camera.zoom || 1);
      u.uPixAng.value = t2 / Math.max(1, this._v2.y);
      this.sprayUniforms.uPx.value = Math.max(1, this._v2.y) / t2;
    }
    // shelter / foam / pattern frames relative to the grid origin
    u.uShelterRect.value.set(this.shelterOrigin.x - Cx, this.shelterOrigin.z - Cz, SHELTER_SIZE, this.shelterOn ? 1 : 0);
    const Fx = this.frameF.x, Fz = this.frameF.z;
    u.uFoamOff.value.set(posMod(Cx + Fx, FOAM_W), posMod(Cz + Fz, FOAM_W));
    u.uFoamShift.value.set(Cx - (this.foamX.x - Fx), Cz - (this.foamX.z - Fz));
    u.uPatOff.value.set(posMod(Cx + Fx, PAT_ANCHOR), posMod(Cz + Fz, PAT_ANCHOR));
    const su = this.sprayUniforms;
    su.uCamRel.value.set(cx - Cx, cz - Cz);
    su.uCamInv.value.set(posMod(cx + Fx, 2 * SPRAY_R), posMod(cz + Fz, 2 * SPRAY_R));
  }
  /** One foam accumulation step: breaking (Jacobian below threshold) is max-ed into the decaying previous state. */
  runFoam(renderer, dtU) {
    const n = this.foamN;
    if (!this.foamRT) {
      const opt = { depthBuffer: false, stencilBuffer: false, type: THREE.UnsignedByteType, format: THREE.RGBAFormat, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter, generateMipmaps: false };
      this.foamRT = [new THREE.WebGLRenderTarget(n, n, opt), new THREE.WebGLRenderTarget(n, n, opt)];
      this.foamPrev = null;
    }
    const W = FOAM_W, tex = W / n, Fx = this.frameF.x, Fz = this.frameF.z;
    const cfx = Math.round(this.view.x / tex) * tex, cfz = Math.round(this.view.z / tex) * tex;
    const X = cfx + Fx, Z = cfz + Fz; // invariant foam centre
    const fu = this.foamUniforms;
    fu.uCfF.value.set(posMod(X, W) / W, posMod(Z, W) / W);
    if (this.foamPrev) { fu.uCfFPrev.value.set(posMod(this.foamPrev.x + Fx, W) / W, posMod(this.foamPrev.z + Fz, W) / W); fu.uPrevShift.value.set(this.foamPrev.x - cfx, this.foamPrev.z - cfz); }
    else { fu.uCfFPrev.value.copy(fu.uCfF.value); fu.uPrevShift.value.set(0, 0); }
    const Bf = fu.uWaveB.value;
    for (let i = 0; i < NLM; i++) Bf[i].set(wrapTau(this.tph[i] + this.k[i] * (this.dx[i] * cfx + this.dz[i] * cfz)), this.q[i], this.len[i], this.w[i]);
    const u = this.uniforms, sig = this.stats.sigB;
    fu.uThr.value = 1 - u.uFoamA.value * sig; fu.uSoft.value = u.uFoamSoft.value * sig + 1e-4; fu.uK.value = 1;
    const life = 2.2 + 2.5 * smooth01(8, 24, this.wind), life2 = 5 + 25 * smooth01(8, 24, this.wind);
    fu.uDecMul.value = Math.exp(-dtU / life); fu.uDecSub.value = dtU / (life * 2.5);
    fu.uDecMul2.value = Math.exp(-dtU / life2); fu.uDecSub2.value = dtU / (life2 * 3); fu.uOldK.value = 0.75;
    fu.uSeed.value = (fu.uSeed.value + 17.31) % 1000;
    fu.uGrpOff.value.set(posMod(X - this.grp.x, GRP_PERIOD), posMod(Z - this.grp.z, GRP_PERIOD)); fu.uGrpK.value = 3.6 * sig;
    u.uGrpOff.value.copy(fu.uGrpOff.value); u.uGrpK.value = 3.6 * sig; u.uSigB.value = Math.max(1e-4, sig);
    fu.uShelterRect.value.set(this.shelterOrigin.x - cfx, this.shelterOrigin.z - cfz, SHELTER_SIZE, this.shelterOn ? 1 : 0);
    fu.uPrev.value = this.foamRT[this.foamIdx].texture;
    const dst = this.foamRT[1 - this.foamIdx];
    const prevRT = renderer.getRenderTarget(), xr = renderer.xr ? renderer.xr.enabled : false;
    if (renderer.xr) renderer.xr.enabled = false;
    renderer.setRenderTarget(dst);
    renderer.render(this.foamScene, this.foamCam);
    renderer.setRenderTarget(prevRT);
    if (renderer.xr) renderer.xr.enabled = xr;
    this.foamIdx = 1 - this.foamIdx;
    this.foamPrev = { x: cfx, z: cfz };
    this.foamX.x = X; this.foamX.z = Z;
    u.uFoamTex.value = dst.texture; u.uFoamOn.value = 1;
  }
  /** Bind the (up to) two shoreline foam fields whose footprint is nearest to the camera. */
  bindShoreFields(cx, cz) {
    const u = this.uniforms;
    let a = null, b = null, da = Infinity, db = Infinity;
    for (const f of shoreFields.values()) {
      const dx = Math.max(f.x0 - cx, 0, cx - (f.x0 + f.size)), dz = Math.max(f.z0 - cz, 0, cz - (f.z0 + f.size));
      const d = dx * dx + dz * dz;
      if (d < da) { b = a; db = da; a = f; da = d; } else if (d < db) { b = f; db = d; }
    }
    const bind = (f, tex, rect) => { if (f) { tex.value = f.tex; rect.value.set(f.x0, f.z0, f.size, 1); } else { tex.value = noShoreTexture(); rect.value.set(0, 0, 1, 0); } };
    bind(a, u.uShoreA, u.uShoreRectA); bind(b, u.uShoreB, u.uShoreRectB);
  }
  /** Rebuild the depth texture around (cx,cz) using sampler(x,z) → real metres height (null = unknown). */
  rebuildDepth(cx, cz, sampler, force) {
    if (!force && Math.hypot(cx - this.depthCenter.x, cz - this.depthCenter.z) < this.depthSize * 0.12) return;
    this.depthCenter = { x: cx, z: cz };
    const n = this.depthN, s = this.depthSize, ox = cx - s / 2, oz = cz - s / 2;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const h = sampler(ox + (i + 0.5) * (s / n), oz + (j + 0.5) * (s / n));
      const d = h == null ? 200 : Math.max(0, -h);
      const o = (j * n + i) * 4;
      this.depthData[o] = Math.min(255, Math.round(d)); this.depthData[o + 3] = 255;
    }
    this.depthTex.needsUpdate = true;
    this.uniforms.uDepthOrigin.value.set(ox, oz);
  }
  dispose() {
    this.scene.remove(this.mesh); this.scene.remove(this.far); this.scene.remove(this.spray);
    this.mesh.geometry.dispose(); this.far.geometry.dispose(); this.spray.geometry.dispose();
    this.material.dispose(); this.sprayMat.dispose(); this.depthTex.dispose(); this.shelterTex.dispose();
    this.foamScene.children[0].geometry.dispose(); this.foamScene.children[0].material.dispose();
    if (this.foamRT) this.foamRT.forEach((r) => r.dispose());
    if (active === this) active = null;
  }
}

function posMod(a, m) { a %= m; return a < 0 ? a + m : a; }
