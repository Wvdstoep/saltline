// Ocean v2: a spectral Gerstner sea driven by the real sea state (drop-in replacement for ocean.js).
//
// Spectrum: the wind sea is a JONSWAP spectrum (γ 3.3) from (waveH, wavePeriod, waveDir) with Mitsuyasu cos^2s
// directional spreading; the swell is a narrow log-normal band from (swellH, swellPeriod, swellDir). Both are sampled
// by 20 Gerstner components on FIXED wavelengths in three cascades — long 55–650 m (5 wind-sea + 5 swell slots), mid
// 14–55 m, short 2.5–14 m — with fixed random phases. Spreading quantiles are stratified by energy rank (peak component
// on the mean direction, the next ones at ±½σ, ±σ, …) so the dominant crests are 2–3 wavelengths long (short-crested).
// A new forecast only moves amplitudes and directions (eased over ~20 s, directions ≤ 2.5°/s with the phase held at
// the view centre): the field never slides or pops. Amplitudes come from band-integrated spectral energy normalised so
// 4·√(Σa²/2) = Hs exactly. Crest sharpening (Gerstner Q) is budgeted per cascade so Σ Q·k·A ≤ 0.85: crests peak but the
// surface never loops.
//
// Geometry: a camera-centred clipmap of 7 nested square rings (2 m cells over ±128 m, doubling each ring out to ±8 km,
// T-junction-free stitching) snapped to 4 cells, biased toward where the camera looks (the chase camera's ship sits in
// the 2 m ring), plus a flat far ring to 30 km. Each component is faded out of the geometry where the local cell is too
// coarse for it (no aliasing). The vertices carry ONLY the displacement: every pixel re-evaluates all components (and
// 12 capillary/short-gravity ripple waves, 0.3–6 m, around the wind) at its rest point, so the grid's sampling never
// shows in the shading (interpolated vertex normals were what drew the calm sea as parallel stripes / moiré).
// Anti-aliasing is per component and anisotropic: a wave is kept while it spans ≥ 5 pixel footprints measured ALONG
// ITS OWN DIRECTION (the footprint stretches by 1/cos at grazing angles); what is filtered out goes, with its
// direction, into a slope covariance (LEAN mapping) that is the sun-glitter roughness. Light air: cat's-paws — a slow,
// drifting patch field modulates the ripple energy (glassy slicks between rippled patches).
//
// Shading: Schlick fresnel with sky reflection from setSun's colours (blurred where the surface is rough), anisotropic
// Beckmann glitter in slope space with Smith masking (Σ = Cox–Munk residual + unresolved slopes: sharp sparkles near
// the camera, a soft glitter path far away, never bands), depth colour plus Beer–Lambert transmission to a sunlit sea
// bed (turquoise over sand, deep blue offshore; caustics fade to their mean with distance), subsurface light through
// thin crests that grows with the sea, crest/trough shading that grows with Hs (a calm stays glassy), storm/overcast
// greying, night, rain rings, harbour shore fields (setShoreField, unchanged) and the three.js fog tail.
// Ship wakes: feedShip() each frame; an analytic Kelvin wake per ship (stationary phase: transverse + divergent
// systems inside the 19.47° wedge, cusp lines, Froude-scaled amplitude, a turbulent wash trail) for up to 4 ships, and
// on desktop-class GPUs a local dispersive wave simulation around the player's ship (wakesim.js: bow wave, hull-side
// trough, stern churn, foam that stays on the water, ripples settling after a stop) sampled for height, normal, foam.
// GPU tiers (mobile): full / lite / basic shaders on the same uniforms, each with leaner rungs (SEA_RUNGS); init(renderer)
// skips every rung whose estimated uniform / varying / sampler budget (glslbudget.js) does not fit the GPU's limits with
// 32 vectors to spare (phones with < 512 vectors start full at 'full-lean'), then self-tests rungs offscreen: the first
// that links AND draws a non-black sea is used, a failing rung steps to the next rung, then the next tier; basic is
// always tested too. The diagnostics panel (?diag=1) shows the rung per tier and its budget. Phones start at quality 0.6 (full shader, fewer ripples, no wake sim); the
// frame-rate governor's lowest step is the lite shader. Cost per pixel (full): 20 spectral + 12 ripple sin/cos, ≤ 4
// Kelvin wakes (only inside their wedge), 5 wake texture fetches (inside the sim domain) and the foam textures.
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
import { WakeSim, WAKE_MAX_SHIPS } from './wakesim.js';
import { glslBudget, budgetFits } from './glslbudget.js';

const G = 9.81, TAU = Math.PI * 2, D2R = Math.PI / 180;
const NL = 10, NM = 6, NS = 4, NLM = NL + NM, NW = NLM + NS;
const NWL = 5;                       // long-cascade slots carrying the wind sea; the other 8 carry the swell
const LEVELS = 7;                    // clipmap rings: L0 + 6 doublings
const FAR_OUT = 30000;               // far ring outer half-extent (m)
const FOAM_W = 2048;                 // foam accumulation window (m, world-anchored, toroidal)
const PAT_ANCHOR = 16384;            // foam / streak pattern coordinate period (m)
const SPRAY_R = 230;                 // spray box half-size around the camera (m)
const GRP_PERIOD = 42 * 4096;        // wrap of the wave-group field offset (m)
const BUDGET = [1.0, 0.55, 0.22];     // Σ Q·k·A per cascade at full chop: 0.85 in total → the Jacobian never reaches 0
const QMAX = [2.6, 1.7, 1.1];        // per-component Gerstner Q cap per cascade
const TIERS = [{ n: 64, s0: 4 }, { n: 96, s0: 8 / 3 }, { n: 128, s0: 2 }]; // all reach ±8192 m
const SHELTER_N = 128, SHELTER_SIZE = 4096;
// spreading quantiles by energy rank: the peak component on the mean direction, the next ones stratified to both sides
// (≈ ±0.5σ, ±σ, …) so the dominant crests are 2–3 wavelengths long (a short-crested wind sea, not corrugated sheet)
const RANK_U = [0.5, 0.22, 0.78, 0.35, 0.65, 0.12, 0.88, 0.26, 0.74, 0.06, 0.94, 0.18, 0.82, 0.42, 0.58, 0.03, 0.97, 0.29, 0.71, 0.15];

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
  band(NWL, 55, 650, 0, 0); band(NL - NWL, 70, 620, 0, 1); band(NM, 14, 55, 1, 0); band(NS, 2.5, 14, 2, 0);
  // stratified spreading quantiles (golden-ratio sequence per family): neighbours alternate sides of the mean direction
  let gw = 0.5, gs = 0.5;
  for (const c of out) {
    if (c.family === 0) { c.u = 0.06 + 0.88 * gw; gw = (gw + 0.6180339887) % 1; } else { c.u = 0.12 + 0.76 * gs; gs = (gs + 0.6180339887) % 1; }
  }
  return out;
})();

// capillary / short-gravity ripples (fragment-only slope waves, 0.3–6 m): log-spaced lengths, directions spread around
// the wind (fixed offsets + jitter), random phases, capillary-gravity dispersion ω² = g·k + (σ/ρ)·k³
const NDET = 12, MAXKEL = 4;
const MOON_GLINT = 0.35;              // moon glitter = its display colour × this (a dim second light, never a white disc)
const TRACK_HZ = 3, TRACK_S = 120;   // own-ship track: samples per second, seconds kept (curved wake / ring of foam)
const DET = (() => {
  const rnd = rng32(0xd37a11), out = [];
  const offs = [0.0, -0.55, 0.62, -1.15, 1.05, -0.28, 0.33, 1.5, -1.45, 0.8, -0.85, 0.15];
  for (let i = 0; i < NDET; i++) {
    const len = 0.3 * Math.pow(6 / 0.3, (i + 0.5 + (rnd() - 0.5) * 0.6) / NDET), k = TAU / len;
    out.push({ len, k, w: Math.sqrt(G * k + 7.4e-5 * k * k * k), off: offs[i] + (rnd() - 0.5) * 0.2, ph: rnd() * TAU });
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
  try { if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) return 0.6; } catch { /* no DOM */ }
  return 1;
}

// ------------------------------------------------------------------------------------------------ GLSL
// Shader VARIANTS ("rungs"): every tier is generated from one source with a few knobs, so a GPU that cannot link a
// tier gets a leaner build of the same tier before it is dropped a tier (init / failTier walk the rungs; the in-game
// diagnostics show which rung linked and the uniform budget it uses, glslbudget.js). Knobs:
//   nw     — spectral components on the GPU (20; 16 drops the short cascade; the arrays are declared with this size in
//            BOTH stages, a uniform must be declared identically in both or the program does not link)
//   ndet   — capillary ripple waves per pixel (full)        kel / trk — analytic Kelvin wakes / the own ship's curved track
//   cut    — lock-chamber cut-outs                          spots / env / moon — searchlight pools, IBL sky, moon glitter
//   pix    — lite: the 8 steepest-band waves per pixel (needs highp fragments)   unroll — lite: constant-index waves only
const GLSL_COMMON = /* glsl */`
#define NL 10
#define NLM 16
#define NW 20
#define NDET 12
#define MAXKEL 4
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
const NTRK = 16;                     // own-ship track polyline points on the GPU (x, z rel. uC, metres along, age s)

// Analytic Kelvin wakes (stationary phase) + turbulent wash trail, shared by the full and the lite sea shaders. With
// `trk`, Kelvin slot 0 (the own ship, KC.w = 1) is evaluated in TRACK coordinates: distance along the recorded track
// and signed distance from it, so a turning ship leaves a curved wake and a circle leaves a ring of foam.
function kelvinGLSL(trk) {
  return /* glsl */`
uniform vec4 uKelA[MAXKEL]; uniform vec4 uKelB[MAXKEL]; uniform vec4 uKelC[MAXKEL]; uniform float uKelN;
${trk ? `#define NTRK ${NTRK}
uniform vec4 uTrk[NTRK]; uniform float uTrkN;
// nearest point of the track polyline (newest first): x = metres along the track behind the ship, y = signed lateral
// distance, z = age (s) of the water there; fwd = the ship's heading when it passed there
vec3 trackCoord(vec2 p, out vec2 fwd) {
  float best = 1e12; vec3 res = vec3(-1e6, 0.0, 0.0); fwd = vec2(0.0, 1.0);
  for (int j = 0; j < NTRK - 1; j++) {
    if (float(j) < uTrkN - 1.0) {
      vec4 P0 = uTrk[j]; vec4 P1 = uTrk[j + 1];
      vec2 sg = P1.xy - P0.xy; float L = max(length(sg), 0.001); vec2 dir = sg / L;
      float t = dot(p - P0.xy, dir);
      t = clamp(t, j == 0 ? -1e6 : 0.0, float(j) < uTrkN - 2.0 ? L : 1e6);
      vec2 d = p - (P0.xy + dir * t);
      float dd = dot(d, d);
      if (dd < best) { best = dd; fwd = -dir; res = vec3(P0.z + t, dir.y * d.x - dir.x * d.y, mix(P0.w, P1.w, clamp(t / L, 0.0, 4.0))); }
    }
  }
  return res;
}
` : ''}
// A: ship x, z (rel. uC), forward dir   B: k0 = g/U², amplitude, length, reach   C: beam, wash foam, sim-covered, on track
void kelvinWakes(vec2 rel, float fp, float simIn, inout vec2 sl, inout float h, inout vec3 sig, inout float kf) {
  for (int i = 0; i < MAXKEL; i++) {
    if (float(i) < uKelN) {
      vec4 KA = uKelA[i]; vec4 KB = uKelB[i]; vec4 KC = uKelC[i];
      vec2 d = rel - KA.xy;
      float xb = KB.z * 0.5 - dot(d, KA.zw);                      // metres behind the bow
      float yl = KA.z * d.y - KA.w * d.x;                          // lateral (signed)
      vec2 fw = KA.zw; float age = -1.0;
${trk ? `      if (i == 0 && KC.w > 0.5) { vec2 f2; vec3 tc = trackCoord(rel, f2); xb = KB.z * 0.5 + tc.x; yl = tc.y; fw = f2; age = tc.z; }` : ''}
      float ay = abs(yl);
      if (xb > 0.5 && xb < KB.w && ay < 0.4 * xb + KC.x) {
        float cover = KC.z > 0.5 ? simIn : 0.0;                    // the simulation already draws this ship's near wake
        float coverW = cover * (1.0 - smoothstep(1.0 * KB.z, 2.5 * KB.z, xb));   // ... and fades it out 1-2.5 lengths back
        float wgt = (1.0 - coverW) * smoothstep(0.25 * KB.z, 1.1 * KB.z, xb) * (1.0 - smoothstep(0.6 * KB.w, KB.w, xb)) / sqrt(1.0 + xb / KB.z);
        // inside the 19.47 deg wedge two wave systems reach each point: transverse and divergent (stationary phase)
        float tt = ay / xb;
        float disc = 1.0 - 8.0 * tt * tt;
        if (disc > 0.0 && wgt > 0.001) {
          float sq = sqrt(disc);
          float cusp = 1.0 + 1.2 * exp(-disc * 10.0);                 // energy piles up along the cusp lines
          float edge = smoothstep(0.0, 0.04, disc);
          float sgn = yl < 0.0 ? -1.0 : 1.0;
          vec2 bw = -fw;
          vec2 lat = vec2(-fw.y, fw.x) * sgn;
          for (int r = 0; r < 2; r++) {
            float t = r == 0 ? 2.0 * tt / (1.0 + sq) : min((1.0 + sq) / (4.0 * max(tt, 1e-3)), 6.0);
            float sec = sqrt(1.0 + t * t);
            float k = KB.x * sec * sec;
            float phs = KB.x * sec * (xb + ay * t);
            float wl = smoothstep(2.0 * fp, 5.0 * fp, 6.2832 / k);
            float A = KB.y * wgt * cusp * edge * (r == 0 ? 0.55 : 1.0) / (sec * sec);   // cos²ψ: equal steepness k·A for both systems
            vec2 kv = (bw + lat * t) / sec;
            sl -= kv * (k * A * wl * sin(phs));
            h += A * wl * cos(phs);
            sig += 0.25 * (k * A) * (k * A) * (1.0 - wl * wl) * vec3(1.0, 1.0, 0.0);
          }
        }
        // turbulent wash: a widening white trail behind the stern; straight wakes fade over a few ship lengths, the
        // own ship's track wash fades with the age of the water (a full circle leaves a ring of foam)
        float xs = xb - KB.z;
        if (xs > 0.0 && KC.y > 0.0) {
          float w = KC.x * 0.55 + (age >= 0.0 ? min(xs, 300.0) * 0.04 : xs * 0.05);
          float fade = age >= 0.0 ? exp(-age / 45.0) : exp(-xs / (KB.z * 3.0 + 80.0));
          kf = max(kf, (1.0 - cover) * KC.y * (1.0 - smoothstep(0.45 * w, w, ay)) * fade * smoothstep(0.0, 6.0, xs));
        }
      }
    }
  }
}
`;
}
const CUT_GLSL = /* glsl */`uniform float uCutN; uniform vec4 uCutA[8]; uniform vec4 uCutB[8];
float cutSide(vec2 a, vec2 b, vec2 p) { return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x); }
bool inCut(vec2 p) {
  bool hit = false;
  for (int i = 0; i < 8; i++) {
    if (float(i) < uCutN) {
      vec2 a = uCutA[i].xy, b = uCutA[i].zw, c = uCutB[i].xy, d = uCutB[i].zw;
      float s0 = cutSide(a, b, p), s1 = cutSide(b, c, p), s2 = cutSide(c, d, p), s3 = cutSide(d, a, p);
      if ((s0 >= 0.0 && s1 >= 0.0 && s2 >= 0.0 && s3 >= 0.0) || (s0 <= 0.0 && s1 <= 0.0 && s2 <= 0.0 && s3 <= 0.0)) hit = true;
    }
  }
  return hit;
}
`;
const withCut = (frag, on) => (on ? frag.replace('void main() {', CUT_GLSL + 'void main() {\n  if (inCut(vWorld.xz)) discard;') : frag);

// isotropic Beckmann glint of one light (lite tier); sig = slope variance (xx, zz)
const LITE_GLINT = /* glsl */`
float liteGlint(vec3 L, vec3 N, vec3 V, float a2, float ndv) {
  vec3 Hv = normalize(L + V);
  float ndh = max(dot(N, Hv), 0.05); float ndh2 = ndh * ndh;
  float Dm = exp(-(1.0 - ndh2) / (ndh2 * a2)) / (3.14159 * a2 * ndh2 * ndh2);
  float ovh = clamp(1.0 - max(0.0, dot(V, Hv)), 0.0, 1.0); float ovh2 = ovh * ovh;
  float Fh = 0.02 + 0.98 * (ovh2 * ovh2 * ovh);
  float ndl = max(dot(N, L), 0.0);
  return Dm * Fh * smoothstep(0.0, 0.08, ndl) / (4.0 * max(ndv, 0.15));
}
`;

// ------------------------------------------------------------------------------------------------ lite tier
// Phones / weak GPUs / WebGL1 / no highp in fragment shaders, and the fallback when the full program fails to link or
// draws nothing: the spectrum's displacement is summed in the VERTEX shader. With `pix` (highp fragments) the 8 waves of
// the steepest band (mid cascade 14–55 m + the two longest short ones) are evaluated PER PIXEL for the normal (with the
// footprint filter turning what a pixel cannot resolve into glitter roughness), the vertices carry only the slopes of
// the long and short waves — no interpolated-normal stripes. Without `pix` (mediump) all normals come from the vertices.
const PP0 = NL, PP1 = NLM + 2;       // per-pixel lite waves: [PP0, PP1)
function liteVert(v) {
  const body = (I) => `
    { vec4 a = uWaveA[${I}]; vec4 b = uWaveB[${I}];
      float A = a.z * rim;
      if (A > 1e-5) {
        float g = smoothstep(1.7 * ceff, 2.5 * ceff, b.z);
        float nf = smoothstep(3.5 * ceff, 6.0 * ceff, b.z) * smoothstep(2.0 * fp, 5.0 * fp, b.z);
        float th = a.w * dot(a.xy, rel) + b.x;
        float s = sin(th), c = cos(th);
        float QA = b.y * A * g;
        disp += vec3(a.x * QA * c, A * g * s, a.y * QA * c);
        float vn = ${v.pix ? `(${I} >= ${PP0} && ${I} < ${PP1}) ? 0.0 : 1.0` : '1.0'};
        float kA = a.w * A * nf * vn, qs = b.y * kA * s;
        S += vec4(a.x * kA * c, a.y * kA * c, a.x * a.x * qs, a.y * a.y * qs);
        jxz += a.x * a.y * qs;
        float kF = a.w * A * vn;
        vr += 0.5 * kF * kF * (1.0 - nf * nf);
      }
    }`;
  const loop = v.unroll ? Array.from({ length: v.nw }, (_, i) => body(String(i))).join('') : `
  for (int i = 0; i < NW; i++) {${body('i')}
  }`;
  return /* glsl */`
#define NW ${v.nw}
uniform vec4 uWaveA[NW]; uniform vec4 uWaveB[NW];
uniform vec2 uC; uniform vec2 uVrel; uniform float uS0; uniform float uR0; uniform float uSnap; uniform float uRmax; uniform float uLevel; uniform float uPixAng;
varying vec3 vWorld; varying vec4 vS; varying vec2 vRel; varying vec3 vMisc;
#include <fog_pars_vertex>
void main() {
  vec2 rel = position.xz;
  float cheb = max(abs(rel.x), abs(rel.y));
  float rim = 1.0 - smoothstep(uRmax * 0.55, uRmax * 0.985, cheb);
  float ceff = uS0 * max(1.0, 2.0 * (length(rel - uVrel) + 0.5 * uSnap) / uR0);
  vec3 w0 = vec3(uC.x + rel.x, uLevel, uC.y + rel.y);
  float dist = length(cameraPosition - w0);
  float cv = max(abs(cameraPosition.y - uLevel) / max(dist, 1.0), 0.03);
  float fp = dist * uPixAng / cv;
  vec3 disp = vec3(0.0); vec4 S = vec4(0.0); float jxz = 0.0; float vr = 0.0;${loop}
  vS = S; vRel = rel; vMisc = vec3(disp.y, jxz, vr);
  vec3 pos = vec3(uC.x + rel.x + disp.x, uLevel + disp.y, uC.y + rel.y + disp.z);
  vWorld = pos;
  vec4 mvPosition = viewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
}
function liteFrag(v) {
  const frag = /* glsl */`
#define MAXKEL 4
${v.pix ? `#define NW ${v.nw}
uniform vec4 uWaveA[NW]; uniform vec4 uWaveB[NW];` : ''}
uniform vec3 uDeep; uniform vec3 uShallow; uniform vec3 uSkyTop; uniform vec3 uSkyHorizon; uniform vec3 uSunDir; uniform vec3 uSunColor; uniform vec3 uSssCol;
${v.moon ? 'uniform vec3 uMoonDir; uniform vec3 uMoonCol;' : ''}
uniform sampler2D uDepth; uniform vec2 uDepthOrigin; uniform float uDepthSize; uniform float uPixAng;
uniform float uNight; uniform float uStorm; uniform float uLevel; uniform float uHs; uniform vec3 uSig0; uniform float uFoamK; uniform float uLiteThr; uniform float uLiteSoft;
varying vec3 vWorld; varying vec4 vS; varying vec2 vRel; varying vec3 vMisc;
#include <fog_pars_fragment>
${v.kel ? kelvinGLSL(v.trk) : ''}
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y); }
${LITE_GLINT}
void main() {
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / max(dist, 0.001);
  float cv = max(abs(V.y), 0.03);
  float fp = dist * uPixAng / sqrt(cv);
  vec3 sig = uSig0 + vec3(0.5 * vMisc.z + 0.0005, 0.5 * vMisc.z + 0.0005, 0.0);
  vec4 S = vS; float jxz = vMisc.y; float h = vMisc.x;
${v.pix ? `  // the steepest band per pixel: exact normals near the camera, roughness where a pixel cannot resolve the wave
  float fpL = dist * uPixAng / cv;
  for (int i = ${PP0}; i < ${PP1}; i++) {
    vec4 a = uWaveA[i]; vec4 b = uWaveB[i];
    if (a.z > 1e-5) {
      float wl = smoothstep(2.0 * fpL, 5.0 * fpL, b.z);
      float kA = a.w * a.z;
      sig += 0.5 * kA * kA * (1.0 - wl * wl) * vec3(a.x * a.x, a.y * a.y, 0.0);
      if (wl > 0.002) {
        float th = a.w * dot(a.xy, vRel) + b.x;
        float s = sin(th), c = cos(th);
        float k2 = kA * wl, qs = b.y * k2 * s;
        S += vec4(a.x * k2 * c, a.y * k2 * c, a.x * a.x * qs, a.y * a.y * qs);
        jxz += a.x * a.y * qs;
      }
    }
  }` : ''}
  vec2 sl = vec2(0.0); float kf = 0.0;
${v.kel ? '  kelvinWakes(vRel, fp, 0.0, sl, h, sig, kf);' : ''}
  float jxx = S.z, jzz = S.w;
  vec3 N = vec3(S.y * (-jxz) - (1.0 - jzz) * S.x, (1.0 - jzz) * (1.0 - jxx) - jxz * jxz, -jxz * S.x - S.y * (1.0 - jxx));
  float J = N.y;
  N.xz -= sl * N.y; N.y = max(N.y, 0.05); N = normalize(N);
  float nv = dot(N, V);
  if (nv < 0.02) N = normalize(N + V * (0.02 - nv));
  float ndv = max(0.0, dot(N, V));
  float sunUp = clamp(uSunDir.y * 4.0, 0.0, 1.0) * (1.0 - uNight * 0.9);
  float om = clamp(1.0 - ndv, 0.0, 1.0); float om2 = om * om;
  float fresnel = 0.02 + 0.98 * (om2 * om2 * om);
  vec2 duv = (vWorld.xz - uDepthOrigin) / uDepthSize;
  float depth = 255.0;
  if (duv.x > 0.0 && duv.x < 1.0 && duv.y > 0.0 && duv.y < 1.0) depth = texture2D(uDepth, duv).r * 255.0;
  depth = max(0.0, depth + uLevel);
  vec3 water = mix(uDeep, mix(uDeep, uShallow, 0.55), clamp(exp(-depth / 18.0), 0.0, 1.0));
  water = mix(water, uShallow, clamp(exp(-depth / 6.5), 0.0, 1.0));
  float lit = 0.65 + 0.35 * max(0.0, dot(N, uSunDir)) * (0.35 + 0.65 * sunUp);
  water *= lit;
  if (depth < 14.0) {
    vec3 Tr = exp(-vec3(0.46, 0.085, 0.06) * depth * (1.0 + 1.0 / max(cv, 0.25)));
    vec3 bed = vec3(0.6, 0.55, 0.41) * (0.18 + 0.82 * sunUp * clamp(uSunDir.y * 1.5, 0.0, 1.0)) * (1.0 - 0.6 * uStorm);
    water = water * (1.0 - Tr) + bed * Tr * 0.85;
  }
  water = mix(water, vec3(0.08, 0.11, 0.13) * lit, uStorm * 0.65);
  float crest = clamp(h / max(0.25, uHs) * 0.95 + 0.35, 0.0, 1.0);
  float crestK = (0.1 + 0.9 * smoothstep(0.9, 3.0, uHs)) * (1.0 + 0.55 * smoothstep(3.0, 9.0, uHs));
  water *= 1.0 + crestK * (0.75 * crest - 0.35);
  water += uSssCol * 0.18 * kf * (0.3 + 0.7 * sunUp);
  water *= 1.0 - 0.78 * uNight;
  vec3 R = reflect(-V, N);
  vec3 sky = mix(uSkyHorizon, uSkyTop, sqrt(max(0.0, R.y)));
  sky = mix(sky, mix(uSkyHorizon, uDeep * 0.6, 0.65), 1.0 - smoothstep(-0.22, 0.0, R.y));
  sky = mix(sky, mix(uSkyHorizon, uSkyTop, 0.35), smoothstep(0.03, 0.3, sig.x + sig.y) * 0.5);
  sky *= 1.0 - 0.28 * uStorm;
  vec3 col = mix(water, sky, fresnel);
  // isotropic Beckmann glitter with the unresolved slope variance as roughness (sun, and the moon as a dim second light)
  float a2 = clamp(sig.x + sig.y, 0.001, 0.8);
  float ndl = max(dot(N, uSunDir), 0.0);
  col += uSunColor * min(liteGlint(uSunDir, N, V, a2, ndv), 8.0) * sunUp * (1.0 - 0.7 * uStorm);
${v.moon ? '  col += uMoonCol * min(liteGlint(uMoonDir, N, V, a2, ndv), 8.0) * clamp(uMoonDir.y * 4.0, 0.0, 1.0) * (1.0 - 0.7 * uStorm);' : ''}
  // whitecaps from the Jacobian, broken up by noise; wake wash
  vec2 pq = vRel * 0.21;
  float nz = vnoise(pq) * 0.6 + vnoise(pq * 2.7 + 5.0) * 0.4;
  float foam = (1.0 - smoothstep(uLiteThr - uLiteSoft, uLiteThr, J)) * uFoamK;
  foam = clamp((foam * 1.2 - (1.0 - nz) * 0.7) / 0.5, 0.0, 1.0);
  foam = max(foam, clamp((kf * 1.3 - (1.0 - nz) * 0.85) / 0.45, 0.0, 1.0));
  foam *= 1.0 - smoothstep(30.0, 200.0, fp) * 0.5;
  vec3 foamCol = vec3(0.9, 0.94, 0.96) * (0.28 + 0.62 * sunUp * (0.55 + 0.45 * ndl)) * (1.0 - 0.7 * uNight);
  col = mix(col, foamCol, foam * 0.9);
  col *= 1.0 - 0.2 * uNight;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;
  return withCut(frag, v.cut);
}
// Last resort: no uniform arrays, no loops, no textures, nothing that depends on precision (the varyings are small
// numbers; the sines fade out beyond 2 km). Three gentle waves, fresnel between the sea colour and the sky colour.
// Never a black / missing sea.
const BASIC_VERT = /* glsl */`
uniform vec2 uC; uniform float uLevel; uniform float uTime; uniform vec2 uWindDir; uniform float uHs;
varying float vUp; varying float vH;
#include <fog_pars_vertex>
void main() {
  vec2 rel = position.xz;
  float a = min(uHs, 2.0) * 0.25 * (1.0 - smoothstep(1500.0, 4000.0, max(abs(rel.x), abs(rel.y))));
  vec2 wx = vec2(-uWindDir.y, uWindDir.x);
  float p1 = dot(rel, uWindDir) * 0.11 - uTime * 1.0;
  float p2 = dot(rel, uWindDir * 0.7 + wx * 0.7) * 0.19 - uTime * 1.3;
  float p3 = dot(rel, uWindDir * 0.3 - wx) * 0.05 - uTime * 0.6;
  float hgt = a * (0.5 * sin(p1) + 0.3 * sin(p2) + 0.4 * sin(p3));
  vec3 pos = vec3(uC.x + rel.x, uLevel + hgt, uC.y + rel.y);
  vec3 toCam = cameraPosition - pos;
  vUp = toCam.y / max(length(toCam), 1.0);
  vH = hgt / max(a, 0.01);
  vec4 mvPosition = viewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const BASIC_FRAG = /* glsl */`
uniform vec3 uDeep; uniform vec3 uSkyHorizon; uniform vec3 uSkyTop; uniform float uNight;
varying float vUp; varying float vH;
#include <fog_pars_fragment>
void main() {
  float up = clamp(vUp, 0.0, 1.0);
  float om = 1.0 - up; float om2 = om * om;
  float f = 0.02 + 0.98 * om2 * om2 * om;
  vec3 sky = mix(min(uSkyHorizon, vec3(1.5)), min(uSkyTop, vec3(1.5)), up * 0.6);
  vec3 water = uDeep * (1.15 + 0.25 * vH);
  vec3 col = mix(water, sky, f) * (1.0 - 0.8 * uNight);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

function fullVert(v) {
  return /* glsl */`
#define NL 10
#define NLM 16
#define NW ${v.nw}
uniform vec4 uWaveA[NW]; uniform vec4 uWaveB[NW];
uniform vec2 uC; uniform vec2 uVrel; uniform float uS0; uniform float uR0; uniform float uSnap; uniform float uRmax; uniform float uLevel; uniform float uVertShort; uniform float uLean;
uniform sampler2D uWakeTex; uniform vec4 uWakeRect;
varying vec3 vWorld; varying vec2 vRel; varying float vCeff;
#include <fog_pars_vertex>
void gerst(vec4 a, vec4 b, float A, vec2 p, inout vec3 disp) {
  float th = a.w * dot(a.xy, p) + b.x;
  float QA = b.y * A;
  float s = sin(th), c = cos(th);
  // storm crests lean forward (rolling over): the top of a steep crest is pushed ahead along the wave's travel
  float s2 = max(s, 0.0); s2 *= s2; s2 *= s2;
  disp += vec3(a.x * (QA * c + uLean * A * s2 * s2), A * s, a.y * (QA * c + uLean * A * s2 * s2));
}
void main() {
  vec2 rel = position.xz;                                   // metres from the snapped grid origin uC
  float cheb = max(abs(rel.x), abs(rel.y));
  float rim = 1.0 - smoothstep(uRmax * 0.55, uRmax * 0.985, cheb);
  float ceff = uS0 * max(1.0, 2.0 * (length(rel - uVrel) + 0.5 * uSnap) / uR0);
  vec3 disp = vec3(0.0);
  if (rim > 0.0) {
    for (int i = 0; i < NLM; i++) {
      vec4 a = uWaveA[i]; vec4 b = uWaveB[i];
      float A = a.z * rim * smoothstep(1.7 * ceff, 2.5 * ceff, b.z);
      if (A >= 1e-4) gerst(a, b, A, rel, disp);
    }
${v.nw > NLM ? `    if (uVertShort > 0.5 && ceff < 6.0) {
      for (int i = NLM; i < NW; i++) {
        vec4 a = uWaveA[i]; vec4 b = uWaveB[i];
        float A = a.z * rim * smoothstep(1.7 * ceff, 2.5 * ceff, b.z);
        if (A >= 1e-4) gerst(a, b, A, rel, disp);
      }
    }` : ''}
  }
  // ship wake simulation (dynamic height h + P), where the grid is fine enough to carry it
  if (uWakeRect.w > 0.5 && ceff < 8.0) {
    vec2 wuv = (rel - uWakeRect.xy) / uWakeRect.z;
    vec2 ed = min(wuv, 1.0 - wuv);
    float wf = smoothstep(0.0, 0.08, min(ed.x, ed.y)) * (1.0 - smoothstep(4.0, 8.0, ceff));
    if (wf > 0.0) { vec4 w = texture2D(uWakeTex, wuv); disp.y += (w.r + w.b) * wf; }
  }
  vRel = rel; vCeff = ceff;
  vec3 pos = vec3(uC.x + rel.x + disp.x, uLevel + disp.y, uC.y + rel.y + disp.z);
  vWorld = pos;
  vec4 mvPosition = viewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
}

function fullFrag(v) {
  const frag = /* glsl */`
#define NL 10
#define NLM 16
#define NW ${v.nw}
#define NDET ${v.ndet}
#define MAXKEL 4
uniform vec4 uWaveA[NW]; uniform vec4 uWaveB[NW];
uniform vec3 uDeep; uniform vec3 uShallow; uniform vec3 uSkyTop; uniform vec3 uSkyHorizon; uniform vec3 uSunDir; uniform vec3 uSunColor; uniform vec3 uSssCol;
uniform vec3 uMoonDir; uniform vec3 uMoonCol;
uniform sampler2D uDepth; uniform vec2 uDepthOrigin; uniform float uDepthSize; uniform float uTime; uniform float uWind; uniform vec2 uWindDir;
uniform float uNight; uniform float uRain; uniform float uStorm; uniform float uLevel; uniform float uDetail; uniform float uHs;
uniform sampler2D uShoreA; uniform sampler2D uShoreB; uniform vec4 uShoreRectA; uniform vec4 uShoreRectB; uniform sampler2D uShelterTex; uniform vec4 uShelterRect;
uniform float uPixAng; uniform float uNShortFrag; uniform vec3 uSig0; uniform vec4 uDet[NDET]; uniform float uNDet; uniform vec2 uPawOff; uniform float uPawC;
uniform sampler2D uWakeTex; uniform vec4 uWakeRect; uniform float uWakeTexel;
uniform float uSigLM; uniform float uFoamA; uniform float uFoamSoft; uniform float uFoamK; uniform float uStreak; uniform float uOldMean;
uniform vec2 uGrpOff; uniform float uGrpK; uniform float uSigB; uniform vec2 uBrk; uniform vec2 uFoamDrift;
uniform sampler2D uFoamTex; uniform vec2 uFoamOff; uniform vec2 uFoamShift; uniform float uFoamW; uniform float uFoamOn; uniform vec2 uPatOff;
${v.spots ? 'uniform vec4 uSpot[6]; uniform float uSpotN;' : ''}
${v.env ? `#ifdef ENVMAP_TYPE_CUBE_UV
uniform sampler2D envMap; uniform float uEnvK;
#include <cube_uv_reflection_fragment>
#endif` : ''}
varying vec3 vWorld; varying vec2 vRel; varying float vCeff;
#include <fog_pars_fragment>
${GLSL_NOISE}
${GLSL_VNOISE}
${v.kel ? kelvinGLSL(v.trk) : ''}
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
  float wash = (1.0 - smoothstep(0.0, 3.2, dAny)) * smoothstep(-1.5, 0.0, dAny) * (0.5 + 0.45 * n);
  float width = (3.0 + 8.0 * uHs) * (0.3 + 0.7 * expo);
  float zone = (1.0 - smoothstep(0.0, width, dNat)) * smoothstep(-1.0, 0.5, dNat);
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
// anisotropic Beckmann glint of a directional light L in slope space, Smith masking; sig = (xx, zz, xz) slope covariance
float glint(vec3 L, vec3 N, vec3 V, vec3 sig, vec2 vh, float ndv) {
  vec3 Hv = normalize(L + V);
  vec2 sH = -Hv.xz / max(Hv.y, 0.02);
  vec2 sN = -N.xz / max(N.y, 0.05);
  vec2 dd = sH - sN;
  float sxx = sig.x + 1e-4, szz = sig.y + 1e-4, sxz = sig.z;
  float det = max(sxx * szz - sxz * sxz, 1e-8);
  float qf = (szz * dd.x * dd.x - 2.0 * sxz * dd.x * dd.y + sxx * dd.y * dd.y) / det;
  float hy2 = Hv.y * Hv.y;
  float Dm = exp(-0.5 * min(qf, 60.0)) / (6.2832 * sqrt(det) * max(hy2 * hy2, 1e-4));
  float oneMinusVh = clamp(1.0 - max(0.0, dot(V, Hv)), 0.0, 1.0); float vh2 = oneMinusVh * oneMinusVh;
  float Fh = 0.02 + 0.98 * (vh2 * vh2 * oneMinusVh);
  vec2 lh = L.xz; float ll = length(lh); lh = ll > 1e-4 ? lh / ll : vec2(1.0, 0.0);
  float sv = sqrt(max(1e-5, sxx * vh.x * vh.x + 2.0 * sxz * vh.x * vh.y + szz * vh.y * vh.y));
  float sl = sqrt(max(1e-5, sxx * lh.x * lh.x + 2.0 * sxz * lh.x * lh.y + szz * lh.y * lh.y));
  float av = abs(V.y) / max(1e-3, sqrt(max(0.0, 1.0 - V.y * V.y)) * sv);
  float al = max(L.y, 1e-3) / max(1e-3, sqrt(max(0.0, 1.0 - L.y * L.y)) * sl);
  float Lv = av < 1.6 ? (1.0 - 1.259 * av + 0.396 * av * av) / (3.535 * av + 2.181 * av * av) : 0.0;
  float Ll = al < 1.6 ? (1.0 - 1.259 * al + 0.396 * al * al) / (3.535 * al + 2.181 * al * al) : 0.0;
  float Gs = 1.0 / (1.0 + Lv + Ll);
  float ndl = max(dot(N, L), 0.0);
  return Dm * Fh * Gs * smoothstep(0.0, 0.08, ndl) / (4.0 * max(ndv, 0.1));
}
void main() {
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / max(dist, 0.001);
  vec2 rel = vRel;
  float sh = 0.0;
  if (uShelterRect.w > 0.5) {
    vec2 suv = (rel - uShelterRect.xy) / uShelterRect.z;
    if (suv.x > 0.0 && suv.y > 0.0 && suv.x < 1.0 && suv.y < 1.0) sh = texture2D(uShelterTex, suv).r;
  }
  vec3 m = vec3(max(0.26, 1.0 - sh), max(0.35, 1.0 - 0.85 * sh), max(0.48, 1.0 - 0.55 * sh));
  // --- pixel footprint (m), anisotropic: pa across the view, fpL along it (stretched by the grazing angle). A wave is
  //     resolved by the footprint measured along ITS direction; what a pixel cannot resolve becomes slope variance
  //     (LEAN mapping) in the glitter roughness instead of aliasing into stripes / moire.
  float pa = dist * uPixAng;
  float cv = max(abs(V.y), 0.03);
  vec2 vh = V.xz; float vl = length(vh); vh = vl > 1e-4 ? vh / vl : vec2(0.0, 1.0);
  float fpL = pa / cv;
  float fp = pa / sqrt(cv);                                  // isotropic footprint for textures (foam, patterns)
  vec4 S = vec4(0.0); float jxz = 0.0; float h = 0.0;
  vec3 sig = vec3(0.0);                                      // unresolved slope covariance (xx, zz, xz)
  float varJ = 0.0;
  float brk = 0.0;                                           // breaking front faces (0..1)
  // --- spectral components, all evaluated per pixel at the rest point (exact normals; the vertices carry only the
  //     displacement, so the grid's sampling never shows in the shading)
  for (int i = 0; i < NW; i++) {
    vec4 a = uWaveA[i]; vec4 b = uWaveB[i];
    float A0 = a.z * (i < NL ? m.x : (i < NLM ? m.y : m.z));
    if (A0 > 1e-5) {
      float on = (i < NLM || float(i - NLM) < uNShortFrag) ? 1.0 : 0.0;
      float fd = length(vec2(dot(a.xy, vh) * fpL, (a.x * vh.y - a.y * vh.x) * pa));
      float wl = smoothstep(2.0 * fd, 5.0 * fd, b.z) * on;
      float kA = a.w * A0;
      sig += 0.5 * kA * kA * (1.0 - wl * wl) * vec3(a.x * a.x, a.y * a.y, a.x * a.y);
      if (i >= NLM) { float qj = b.y * kA * wl; varJ += 0.5 * qj * qj; }
      if (wl > 0.002) fgerst(a, b, A0 * wl, rel, S, jxz, h);
      // a steep crest breaks: white water born at the crest and spread down the FRONT face, travelling with the wave
      // (phase past the crest psi: 0 at the crest, growing down the face ahead of it)
      float stp = b.y * kA;
      if (i < NLM && uBrk.x > 0.0 && stp > 0.6 * uBrk.y) {
        float psi = mod(a.w * dot(a.xy, rel) + b.x - 1.5708, 6.2832);
        brk = max(brk, smoothstep(0.6 * uBrk.y, uBrk.y, stp) * smoothstep(0.0, 0.12, psi) * exp(-psi * 1.1));
      }
    }
  }
  vec2 pp = rel + uPatOff;                 // pattern coordinates (stable world frame, metres)
  // --- cat's-paws: wind touches the water in patches; between them the surface stays glassy (strong in light air,
  //     uniform once the sea is wind-driven). The mean of pawK^2 is ~1, so the average roughness is unchanged.
  float pawN = uPawC > 0.001 ? mix(0.5, groupField(pp + uPawOff, 60.0), 1.0 - smoothstep(30.0, 120.0, fp)) : 0.5;
  float pawK = mix(1.0, 0.18 + 1.64 * smoothstep(0.22, 0.78, pawN), uPawC) * m.z;
  // --- capillary / short-gravity ripples (0.3-6 m): analytic slope waves around the wind, energy from Cox-Munk minus
  //     what the spectrum resolves; filtered per direction like the spectrum, the rest goes to the roughness
  for (int i = 0; i < NDET; i++) {
    vec4 d = uDet[i];                                         // k*dir (rad/m), phase, slope amplitude
    float kk = max(length(d.xy), 1e-4);
    vec2 dir = d.xy / kk;
    float fd = length(vec2(dot(dir, vh) * fpL, (dir.x * vh.y - dir.y * vh.x) * pa));
    float wl = smoothstep(2.0 * fd, 5.0 * fd, 6.2832 / kk) * (float(i) < uNDet ? 1.0 : 0.0);
    float ka = d.w * pawK;
    sig += 0.5 * ka * ka * (1.0 - wl * wl) * vec3(dir.x * dir.x, dir.y * dir.y, dir.x * dir.y);
    if (wl > 0.002) S.xy += dir * (ka * wl * cos(dot(d.xy, rel) + d.z));
  }
  sig += uSig0 * (pawK * pawK) + vec3(0.0004, 0.0004, 0.0);   // sub-ripple residual (never a perfect mirror)
  if (uRain > 0.0) { // expanding rain rings on a jittered grid
    vec2 rp = pp * 0.8; vec2 ci = floor(rp); vec2 cf = fract(rp) - 0.5;
    float hh = hash12(ci);
    float ph = fract(uTime * 1.7 + hh * 3.0);
    vec2 cc = cf + (vec2(hash12(ci + 3.1), hash12(ci + 7.7)) - 0.5) * 0.6;
    float r = length(cc);
    float ring = sin(r * 38.0 - ph * 22.0) * exp(-r * 6.0) * (1.0 - ph) * step(hh, uRain * 0.9 + 0.05);
    float rk = 1.0 - smoothstep(0.1, 0.6, fp);
    S.xy -= (cc / max(r, 0.02)) * ring * 0.22 * rk;
    sig += vec3(0.004, 0.004, 0.0) * uRain * (1.0 - rk);
  }
  // --- ship wakes: the local simulation near the player's ship, analytic Kelvin wakes beyond it and for other ships
  float wFoam = 0.0, simIn = 0.0;
  if (uWakeRect.w > 0.5) {
    vec2 wuv = (rel - uWakeRect.xy) / uWakeRect.z;
    vec2 ed = min(wuv, 1.0 - wuv);
    simIn = smoothstep(0.0, 0.08, min(ed.x, ed.y));
    if (simIn > 0.0) {
      vec2 e = vec2(uWakeTexel, 0.0);
      vec4 c0 = texture2D(uWakeTex, wuv);
      vec4 cx1 = texture2D(uWakeTex, wuv + e.xy); vec4 cx0 = texture2D(uWakeTex, wuv - e.xy);
      vec4 cz1 = texture2D(uWakeTex, wuv + e.yx); vec4 cz0 = texture2D(uWakeTex, wuv - e.yx);
      float dxw = uWakeTexel * uWakeRect.z;
      vec2 g = vec2((cx1.r + cx1.b) - (cx0.r + cx0.b), (cz1.r + cz1.b) - (cz0.r + cz0.b)) / (2.0 * dxw);
      float wk = 1.0 / (1.0 + (fp * fp) / (4.0 * dxw * dxw));   // a texel smaller than the pixel: slope -> roughness
      S.xy += g * simIn * wk;
      sig += 0.25 * dot(g, g) * (1.0 - wk * wk) * simIn * vec3(1.0, 1.0, 0.0);
      h += (c0.r + c0.b) * simIn;
      wFoam = c0.a * simIn;
    }
  }
  float kFoam = 0.0;
  vec2 kSl = vec2(0.0);
${v.kel ? '  kelvinWakes(rel, fp, simIn, kSl, h, sig, kFoam);' : ''}
  S.xy += kSl;
  wFoam = max(wFoam, kFoam);
  if (wFoam > 0.02) {                                          // aerated, turbulent water roughens the surface
    vec3 tn = noised(pp * 0.65 + uTime * vec2(0.13, -0.11));
    float tk = 1.0 - smoothstep(0.5, 4.0, fp);
    S.xy += tn.yz * 0.07 * wFoam * tk;
    sig += vec3(0.01, 0.01, 0.0) * wFoam * (1.0 - tk);
  }
  // --- normal + Jacobian of the displaced surface
  float jxx = S.z, jzz = S.w;
  vec3 N = vec3(S.y * (-jxz) - (1.0 - jzz) * S.x, (1.0 - jzz) * (1.0 - jxx) - jxz * jxz, -jxz * S.x - S.y * (1.0 - jxx));
  float J = N.y;
  N.y = max(N.y, 0.05);
  N = normalize(N);
  float nv = dot(N, V);
  if (nv < 0.02) N = normalize(N + V * (0.02 - nv));          // never shade a facet seen from behind
  float ndv = max(0.0, dot(N, V));
  float sunUp = clamp(uSunDir.y * 4.0, 0.0, 1.0) * (1.0 - uNight * 0.9);
  float om = clamp(1.0 - ndv, 0.0, 1.0); float om2 = om * om;
  float fresnel = 0.02 + 0.98 * (om2 * om2 * om);
  float rough = sig.x + sig.y;
  // --- depth
  vec2 dp = vWorld.xz;
  vec2 duv = (dp - uDepthOrigin) / uDepthSize;
  float depth = 255.0;
  if (duv.x > 0.0 && duv.x < 1.0 && duv.y > 0.0 && duv.y < 1.0) depth = texture2D(uDepth, duv).r * 255.0;
  depth = max(0.0, depth + uLevel);
  // --- water body: depth colour (scattering), then Beer-Lambert transmission to a sunlit sea bed (red dies first:
  //     turquoise over sand, deep blue offshore), caustics on the bed, storm grey
  float shallowMix = clamp(exp(-depth / 6.5), 0.0, 1.0);
  float midMix = clamp(exp(-depth / 18.0), 0.0, 1.0);
  vec3 midCol = mix(uDeep, uShallow, 0.55);
  vec3 water = mix(uDeep, midCol, midMix);
  water = mix(water, uShallow, shallowMix);
  float lit = 0.65 + 0.35 * max(0.0, dot(N, uSunDir)) * (0.35 + 0.65 * sunUp);
  water *= lit;
  if (depth < 14.0) {
    vec3 Tr = exp(-vec3(0.46, 0.085, 0.06) * depth * (1.0 + 1.0 / max(cv, 0.25)));
    vec3 bed = vec3(0.6, 0.55, 0.41) * (0.18 + 0.82 * sunUp * clamp(uSunDir.y * 1.5, 0.0, 1.0)) * (1.0 - 0.6 * uStorm);
    vec2 cP = vWorld.xz * 0.35 + uWindDir * (uTime * 0.28);
    vec2 cP2 = vWorld.xz * 0.52 - vec2(-uWindDir.y, uWindDir.x) * (uTime * 0.22);
    float c1 = sin(cP.x + cos(cP.y * 1.5)) * cos(cP.y + sin(cP.x * 1.5));
    float c2 = sin(cP2.x * 1.4 - cos(cP2.y * 1.2)) * cos(cP2.y * 1.3 + sin(cP2.x * 1.1));
    float cVal = max(0.0, (c1 + c2 + 0.85) * 0.52);
    float caustic = mix(cVal * cVal * cVal, 0.18, smoothstep(0.6, 3.0, fp));   // fades to its mean: no far tiling
    bed *= 1.0 + caustic * 1.4 * sunUp * (1.0 - smoothstep(1.0, 9.0, depth));
    water = water * (1.0 - Tr) + bed * Tr * 0.85;
  }
  water = mix(water, vec3(0.08, 0.11, 0.13) * lit, uStorm * 0.65);
  // crest / trough shading grows with the sea: a glassy calm has no dark troughs or bright crests (those read as
  // painted stripes on a swell), a storm sea has black troughs
  float crest = clamp(h / max(0.25, uHs) * 0.95 + 0.35, 0.0, 1.0);
  float crestK = (0.1 + 0.9 * smoothstep(0.9, 3.0, uHs)) * (1.0 + 0.55 * smoothstep(3.0, 9.0, uHs));
  water *= 1.0 + crestK * (0.75 * crest - 0.35);
  // subsurface light through thin crests, only with the sun behind the wave, energy taken from the reflected part
  vec3 Ls = normalize(uSunDir + N * 0.45);
  float dotBack = max(0.0, dot(V, -Ls));
  float back = dotBack * dotBack * dotBack * dotBack;
  float dotSide = max(0.0, 1.0 - abs(dot(V, N)));
  float side = dotSide * dotSide * dotSide * max(0.0, dot(-N, uSunDir));
  float crestPow = crest * crest * crest;
  float sss = (back * 2.2 + side) * crestPow * (0.35 + 0.65 * sunUp) * (1.0 - fresnel) * smoothstep(0.4, 2.5, uHs);
  vec3 sssColor = mix(uSssCol, vec3(0.08, 0.92, 0.78), 0.35);
  water += sssColor * sss * (0.75 + 0.5 * shallowMix) * (1.0 - 0.55 * uStorm);
  water += uSssCol * 0.18 * wFoam * (0.3 + 0.7 * sunUp);       // aerated wake water glows turquoise
  water *= 1.0 - 0.78 * uNight;
  // --- sky reflection; a rough (far) surface reflects a blurred sky (the scene's environment map where it has one)
  vec3 R = reflect(-V, N);
  float ry = max(0.0, R.y);
  vec3 sky = mix(uSkyHorizon, uSkyTop, sqrt(ry));
${v.env ? `#ifdef ENVMAP_TYPE_CUBE_UV
  if (uEnvK > 0.0) sky = mix(sky, textureCubeUV(envMap, normalize(vec3(R.x, max(R.y, 0.02), R.z)), clamp(0.25 + 1.5 * sqrt(rough), 0.0, 1.0)).rgb, uEnvK);
#endif` : ''}
  sky = mix(sky, mix(uSkyHorizon, uDeep * 0.6, 0.65), 1.0 - smoothstep(-0.22, 0.0, R.y));
  sky = mix(sky, mix(uSkyHorizon, uSkyTop, 0.35), smoothstep(0.03, 0.3, rough) * 0.5);
  float gA = max(0.0, dot(R, uSunDir)); float gA2 = gA * gA; float gA4 = gA2 * gA2;
  sky += uSunColor * (gA4 * gA4) * 0.08 * sunUp;              // the bright sky around the sun (aureole)
  sky *= 1.0 - 0.28 * uStorm;
  vec3 col = mix(water, sky, fresnel);
  // --- sun glitter: anisotropic Beckmann in slope space. Sigma = sub-ripple Cox-Munk residual + every slope the pixel
  //     could not resolve (LEAN): sharp sparkles close by, a soft glitter path towards the sun far away, never bands.
  //     Capped and scaled so a daylight sea never shows white blotches; the moon is a dim second light.
  float ndl = max(dot(N, uSunDir), 0.0);
  col += uSunColor * min(glint(uSunDir, N, V, sig, vh, ndv), 8.0) * sunUp * (1.0 - 0.7 * uStorm);
  float moonUp = clamp(uMoonDir.y * 4.0, 0.0, 1.0);
  if (moonUp > 0.0 && dot(uMoonCol, uMoonCol) > 1e-6) col += uMoonCol * min(glint(uMoonDir, N, V, sig, vh, ndv), 8.0) * moonUp * (1.0 - 0.7 * uStorm);
  // --- foam: shore surf + harbour shore fields
  float n = vnoise(pp * 0.12 + uTime * 0.05) * 0.6 + vnoise(pp * 0.5 - uTime * 0.1) * 0.4;
  float surf = n + 0.12 * sin(uTime * 0.9 + depth * 1.6);
  float shore = (1.0 - smoothstep(0.3, 5.5, depth)) * smoothstep(0.38, 0.72, surf);
  float inA, inB;
  float fA = shoreFoam(uShoreA, uShoreRectA, dp, n, uTime, inA);
  float fB = shoreFoam(uShoreB, uShoreRectB, dp, n, uTime, inB);
  shore = mix(shore, max(fA, fB), max(inA, inB));
  // --- whitecaps: Jacobian folding (instantaneous) + steep breaking front faces + accumulated persistent foam (render
  //     target). A fresh whitecap is dense, bubbly and ragged-edged; as it decays it crumbles into blobs, then marbled
  //     veins that drift and are stretched downwind into streaks; windrows (long thin lines along the wind) above ~12 m/s.
  float foam = 0.0, foamLit = 1.0;
  if (uFoamK > 0.0) {
    vec2 fr = rel + uFoamShift;                                               // rel. the foam window centre
    float grp = groupField(fr + uGrpOff, 42.0);
    float sigJ = sqrt(uSigLM * uSigLM + varJ);
    float thr = 1.0 - uFoamA * sigJ + (grp - 0.5) * uGrpK * sigJ / max(1e-4, uSigB);
    float inst = 1.0 - smoothstep(thr - uFoamSoft * sigJ, thr, J);         // crest folding right now (all scales)
    float win = 1.0 - smoothstep(0.36 * uFoamW, 0.47 * uFoamW, max(abs(fr.x), abs(fr.y)));
    vec2 acc = uFoamOn > 0.5 ? texture2D(uFoamTex, (rel + uFoamOff) / uFoamW).rg * win : vec2(0.0);
    float face = brk * uBrk.x * smoothstep(0.3, 0.7, grp) * m.y;            // breaking crests ride on their wave
    float act = max(max(acc.x, inst * mix(0.9, 0.55, win)) * uFoamK, face);
    float old = mix(uOldMean, acc.y, win) * uFoamK * m.y;
    float strK = uStreak * m.y;
    if (act + old > 0.004) {
      // large-scale domain warp: nothing repeats or lines up; pp is the water's rest position, so the foam rides the
      // orbital motion and stays on the water it formed on while the crest runs on ahead of it; old foam drifts
      vec2 wv = vec2(vnoise(pp * 0.035), vnoise(pp * 0.035 + 31.7)) - 0.5;
      float body = 0.6, cA = 0.0, cR = 0.0, cS = 0.0;
      if (act > 0.004) {
        body = foamBody(pp + wv * 22.0, fp);
        cA = smoothstep(0.0, 1.0, (act * 0.92 - (1.0 - body) * 0.9) / 0.6);
      }
      if (old > 0.004) {
        vec2 pd = pp - uFoamDrift;
        float st = 1.0 + 2.0 * uStreak;
        vec2 pf = pd + wv * 22.0 * (1.0 - 0.7 * uStreak);
        vec2 qm = vec2(dot(pf, uWindDir) / st, dot(pf, vec2(-uWindDir.y, uWindDir.x)));
        cR = foamFilm(qm, fp, old) * (0.28 + 0.5 * old);
        float sk = strK * smoothstep(0.03, 0.4, old);
        if (sk > 0.001) cS = foamStreaks(pd, fp) * sk * (0.45 + 0.5 * smoothstep(16.0, 28.0, uWind));
      }
      foam = 1.0 - (1.0 - cA) * (1.0 - clamp(cR, 0.0, 1.0)) * (1.0 - 0.85 * cS);
      foamLit = 0.74 + 0.26 * body;
    }
  }
  // --- wake foam: churned white water breaking up into a marbled trail
  if (wFoam > 0.01) {
    float wb = foamBody(pp * 1.4 + 17.0, fp);
    float cW = clamp((wFoam * 1.3 - (1.0 - wb) * 0.85) / 0.45, 0.0, 1.0);
    foam = 1.0 - (1.0 - foam) * (1.0 - cW);
  }
  foam = clamp(max(foam, shore), 0.0, 1.0);
  vec3 foamCol = vec3(0.9, 0.94, 0.96) * (0.28 + 0.62 * sunUp * (0.55 + 0.45 * ndl) + 0.1 * (1.0 - uStorm)) * (1.0 - 0.7 * uNight) * foamLit;
  foamCol = mix(foamCol, foamCol * vec3(0.8, 0.92, 0.95), (1.0 - foam) * 0.5);
  col = mix(col, foamCol, foam * 0.94);
${v.spots ? `  // --- searchlights / deck floods: lit pools on the water (diffuse on the water body and foam + a tight glint)
  for (int i = 0; i < 2; i++) {
    if (float(i) < uSpotN) {
      vec4 P = uSpot[i * 3]; vec4 D = uSpot[i * 3 + 1]; vec4 C = uSpot[i * 3 + 2];
      vec3 Lw = vWorld - P.xyz; float dl = max(length(Lw), 0.01); vec3 l = Lw / dl;
      float cone = smoothstep(D.w, D.w + (1.0 - D.w) * 0.35, dot(l, D.xyz));
      float att = cone * (1.0 - smoothstep(0.6 * P.w, P.w, dl)) / (1.0 + dl * dl * 0.0015);
      if (att > 0.0) {
        vec3 toL = -l; float nl = max(dot(N, toL), 0.0);
        vec3 Hs = normalize(toL + V); float g = max(dot(N, Hs), 0.0); g *= g; g *= g; g *= g; g *= g; g *= g;   // ^32
        col += C.rgb * att * (nl * mix(0.05, 0.75, foam) + g * 0.6);
      }
    }
  }` : ''}
  col *= 1.0 - 0.2 * uNight;
  gl_FragColor = vec4(col, 1.0);
  // same tail as three's built-in materials: tone-map, encode linear -> output colour space, then fog (fogColor is
  // already in the output space)
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;
  return withCut(frag, v.cut);
}

// Shader rungs per tier, tried in order (init / failTier). The first full rung is the desktop look; GPUs with fewer
// than 512 uniform vectors per stage (phones: 256) start at 'full-lean'. Every rung must also fit the GPU's limits with
// a 32-vector margin by the estimate (glslbudget.js) before it is even compiled.
export const SEA_RUNGS = [
  [{ name: 'basic' }],
  [
    { name: 'lite', nw: NW, pix: 1, kel: 1, cut: 1, trk: 1, moon: 1, highp: 1 },
    { name: 'lite-lean', nw: NW, pix: 1, kel: 0, cut: 0, trk: 0, moon: 1, highp: 1 },
    { name: 'lite-vertex', nw: NW, pix: 0, kel: 1, cut: 1, trk: 0, moon: 0 },
    { name: 'lite-min', nw: NL, pix: 0, kel: 0, cut: 0, trk: 0, moon: 0, unroll: 1 },
  ],
  [
    { name: 'full', nw: NW, ndet: NDET, kel: 1, cut: 1, trk: 1, spots: 1, env: 1 },
    { name: 'full-lean', nw: NLM, ndet: 8, kel: 1, cut: 1, trk: 1, spots: 0, env: 0, lowLimit: 1 },
    { name: 'full-min', nw: NLM, ndet: 8, kel: 0, cut: 0, trk: 0, spots: 0, env: 0, lowLimit: 1 },
  ],
];
/** GLSL of one rung of tier lvl (0 basic, 1 lite, 2 full). */
export function seaShader(lvl, rung) {
  if (lvl === 0) return { vert: BASIC_VERT, frag: BASIC_FRAG };
  if (lvl === 1) return { vert: liteVert(rung), frag: liteFrag(rung) };
  return { vert: fullVert(rung), frag: fullFrag(rung) };
}
/** Estimated GPU resources of one rung (three.js prefix + fog + tone mapping included; env counted as on). */
export function seaBudget(lvl, rung) {
  const s = seaShader(lvl, rung);
  return glslBudget(s.vert, s.frag, { defines: rung.env ? { ENVMAP_TYPE_CUBE_UV: 1 } : {} });
}
/** The sea's shader sources per tier, first rung (read by the tests: uniform budgets, loop / smoothstep hygiene). */
export const OCEAN_SHADERS = {
  full: seaShader(2, SEA_RUNGS[2][0]), lite: seaShader(1, SEA_RUNGS[1][0]), basic: seaShader(0, SEA_RUNGS[0][0]),
};


// foam accumulation pass (full-screen triangle into a world-anchored toroidal render target)
const FOAM_VERT = /* glsl */`varying vec2 vUv; void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const FOAM_FRAG = /* glsl */`
#define NL 10
#define NLM 16
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
    if (A >= 1e-4) {
      float qs = b.y * a.w * A * sin(a.w * dot(a.xy, rel) + b.x);
      jxx += a.x * a.x * qs; jzz += a.y * a.y * qs; jxz += a.x * a.y * qs;
    }
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
    if (a.z >= 1e-3) {
      float qs = b.y * a.w * a.z * sin(a.w * dot(a.xy, p) + b.x + b.w * age);
      jxx += a.x * a.x * qs; jzz += a.y * a.y * qs; jxz += a.x * a.y * qs;
    }
  }
  return (1.0 - jxx) * (1.0 - jzz) - jxz * jxz;
}
vec3 dispAt(vec2 p, float age) {
  vec3 d = vec3(0.0);
  for (int i = 0; i < NLM; i++) {
    vec4 a = uWaveA[i]; vec4 b = uWaveB[i];
    if (a.z >= 1e-3) {
      float th = a.w * dot(a.xy, p) + b.x + b.w * age;
      float c = cos(th);
      d += vec3(a.x * b.y * a.z * c, a.z * sin(th), a.y * b.y * a.z * c);
    }
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
  gl_PointSize = clamp(size * uPx / max(1.0, -mvPosition.z), 0.0, 28.0);
  #include <fog_vertex>
}`;
const SPRAY_FRAG = /* glsl */`
uniform vec3 uCol; varying float vA;
#include <fog_pars_fragment>
void main() {
  float r = length(gl_PointCoord - 0.5);
  float sR = smoothstep(0.5, 0.0, r); float a = sR * sqrt(max(0.0, sR)) * vA;   // soft spray puffs (a hard disc reads as snow)
  if (a < 0.01) discard;
  gl_FragColor = vec4(uCol, a * 0.55);
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
      uDeep: { value: new THREE.Color(0x08182b) }, uShallow: { value: new THREE.Color(0x124e58) }, uSssCol: { value: new THREE.Color(0x18a88c) },
      uSkyTop: { value: new THREE.Color(0x4a8fd6) }, uSkyHorizon: { value: new THREE.Color(0xbfd9ee) },
      uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.3).normalize() }, uSunColor: { value: new THREE.Color(0xfff2d0) },
      uDepth: { value: this.depthTex }, uDepthOrigin: { value: new THREE.Vector2(0, 0) }, uDepthSize: { value: this.depthSize }, uNight: { value: 0 },
      uRain: { value: 0 }, uStorm: { value: 0 }, uLevel: { value: 0 }, uDetail: { value: 1 }, uHs: { value: 0.8 },
      uShoreA: { value: noShoreTexture() }, uShoreB: { value: noShoreTexture() }, uShoreRectA: { value: new THREE.Vector4(0, 0, 1, 0) }, uShoreRectB: { value: new THREE.Vector4(0, 0, 1, 0) },
      uPixAng: { value: 0.0016 }, uSigLM: { value: 0.05 }, uFoamA: { value: 3 }, uFoamSoft: { value: 0.9 }, uFoamK: { value: 0 }, uStreak: { value: 0 }, uOldMean: { value: 0 }, uGrpOff: { value: new THREE.Vector2() }, uGrpK: { value: 0 }, uSigB: { value: 0.05 },
      uFoamTex: { value: noShoreTexture() }, uFoamOff: { value: new THREE.Vector2() }, uFoamShift: { value: new THREE.Vector2() }, uFoamW: { value: FOAM_W }, uFoamOn: { value: 0 },
      uPatOff: { value: new THREE.Vector2() },
      // glitter roughness / ripples / cat's-paws
      uSig0: { value: new THREE.Vector3(0.004, 0.004, 0) }, uDet: { value: DET.map(() => new THREE.Vector4()) }, uNDet: { value: NDET },
      uPawOff: { value: new THREE.Vector2() }, uPawC: { value: 0 },
      // ship wakes: local simulation + analytic Kelvin wakes
      uWakeTex: { value: noShoreTexture() }, uWakeRect: { value: new THREE.Vector4(0, 0, 1, 0) }, uWakeTexel: { value: 1 / 256 },
      uKelA: { value: Array.from({ length: MAXKEL }, () => new THREE.Vector4()) }, uKelB: { value: Array.from({ length: MAXKEL }, () => new THREE.Vector4(0, 0, 1, 1)) },
      uKelC: { value: Array.from({ length: MAXKEL }, () => new THREE.Vector4()) }, uKelN: { value: 0 },
      uLiteThr: { value: 0 }, uLiteSoft: { value: 0.05 },
    };
    this.uniforms.uCutN = { value: 0.0 };                                   // lock chambers (wwmesh.cutouts): up to 8 quads, world xz
    this.uniforms.uCutA = { value: Array.from({ length: 8 }, () => new THREE.Vector4()) };   // p0.xz, p1.xz
    this.uniforms.uCutB = { value: Array.from({ length: 8 }, () => new THREE.Vector4()) };   // p2.xz, p3.xz
    // moon glitter, searchlight pools, own-ship track (curved wake), breaking crests, foam drift, environment sky
    Object.assign(this.uniforms, {
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) }, uMoonCol: { value: new THREE.Color(0, 0, 0) },
      uSpot: { value: Array.from({ length: 6 }, () => new THREE.Vector4()) }, uSpotN: { value: 0 },
      uTrk: { value: Array.from({ length: NTRK }, () => new THREE.Vector4()) }, uTrkN: { value: 0 },
      uLean: { value: 0 }, uBrk: { value: new THREE.Vector2(0, 0.3) }, uFoamDrift: { value: new THREE.Vector2() },
      envMap: { value: null }, uEnvK: { value: 0 },
    });
    this.track = [];                              // own ship: { x, z (invariant frame), t } at ~3 Hz, last 120 s
    this.trackAcc = 0; this.trackPts = [];
    this.foamDrift = { x: 0, z: 0 };
    // three shader tiers on the SAME uniforms: 2 = full (per-pixel spectrum, LEAN glitter, foam, wake sim),
    // 1 = lite (vertex spectrum + the steepest band per pixel), 0 = basic (flat lit colour). Each tier has leaner
    // variants (SEA_RUNGS); the highest tier + rung this GPU compiles, links and actually draws with is used (see init /
    // selfTest / failTier); a slow GPU drops to lite through setQuality.
    this.rung = [0, 0, 0];
    this.mats = [0, 1, 2].map((lvl) => this.makeMat(lvl, 0));
    this.matCap = 2; this.matLevel = 2; this.matOk = [null, null, null]; this.matWatch = 0; this.tierLog = []; this.matSince = 0; this.matChecks = 0;
    this.budget = {}; this.limits = null;
    // phones start on the lite tier (always drawn) and move to full only after the full shader passed the offscreen self-test
    this.safeStart = defaultQuality() < 1; this.bornAt = nowMs(); this.sceneAt = 0; this.gov = { ema: 1 / 60, last: 0, slowSince: 0, lastDrop: 0, lastChange: 0, pr0: 0 };
    this.material = this.mats[2];
    // ships fed by the game each frame (feedShip) → analytic Kelvin wakes + the local wake simulation
    this.ships = new Map(); this.kel = []; this.wake = null; this.wakeWant = false; this.simShips = [];
    this.detAng = 0; this.detPh = Float64Array.from(DET, (d) => d.ph); this.detKa = 0.02; this.paw = { x: 0, z: 0 };
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
    this._renderer = null; this._inited = false;
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
    u.uNShortFrag.value = Math.round(2 + 4 * q);
    u.uVertShort.value = q >= 0.4 ? 1 : 0;
    u.uNDet.value = q >= 0.75 ? NDET : q >= 0.4 ? 8 : 4;
    const tier = q >= 0.75 ? 2 : q >= 0.4 ? 1 : 0;
    this.wakeWant = q >= 0.75;                     // the local wake simulation: desktop-class GPUs only
    this.applyMaterial(tier);
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
    let waveH = Number.isFinite(s.waveH) ? Math.max(0.22, s.waveH) : Math.min(9, 0.22 + 0.016 * U * U);
    let Tp = Number.isFinite(s.wavePeriod) && s.wavePeriod > 1 ? s.wavePeriod : THREE.MathUtils.clamp(2.5 + 0.45 * U, 3, 12);
    const waveFrom = Number.isFinite(s.waveDir) ? s.waveDir : num(s.windDir, this.windDir);
    let swellH = Number.isFinite(s.swellH) ? Math.max(0, s.swellH) : 0;
    const swellT = Number.isFinite(s.swellPeriod) && s.swellPeriod > 1 ? s.swellPeriod : 11;
    const swellFrom = Number.isFinite(s.swellDir) ? s.swellDir : waveFrom;
    if (!Number.isFinite(s.waveH) && !Number.isFinite(s.swellH)) swellH = Math.min(1.5, 0.35 + U * 0.04);
    swellH = Math.max(0.35, swellH); // guaranteed baseline swell
    // Open-Meteo wave_height is the combined sea: split the wind sea off when the swell is given too
    let Hw = waveH;
    if (Number.isFinite(s.waveH) && Number.isFinite(s.swellH) && swellH > 0) Hw = Math.sqrt(Math.max(0, waveH * waveH - swellH * swellH));
    // Realistic wind-sea baseline: in open water wind of U m/s generates natural rolling sea
    Hw = Math.max(Hw, 0.016 * U * U * 0.7 + 0.45);
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
    const cp = G / wp, sp = THREE.MathUtils.clamp(3.8 * Math.pow(Math.max(0.3, (U + 0.5) / cp), -1.2), 2.2, 5.5);
    const travel = waveFrom + 180;
    this.seaTravel = travel;
    for (const i of ids) {
      const a = sumE > 0 && Hw > 0 ? Math.sqrt(2 * E[i] / sumE) * (Hw / 2.35) : 0; // scaled for true visual peak-to-trough height
      this.tAmp[i] = Math.min(a, 0.06 * this.len[i]);
    }
    const rankU = (r, i) => (r < RANK_U.length ? RANK_U[r] : 0.03 + 0.94 * ((0.5 + r * 0.6180339887) % 1)) + (this.u[i] - 0.5) * 0.04;
    [...ids].sort((a, b) => this.tAmp[b] - this.tAmp[a]).forEach((i, r) => {
      const rw = this.w[i] / wp, sI = THREE.MathUtils.clamp(rw < 1 ? sp * Math.pow(rw, 2.0) : sp * Math.pow(rw, -1.2), 1.8, 5.5);
      this.tAng[i] = travel + spreadAngle(THREE.MathUtils.clamp(rankU(r, i), 0.03, 0.97), sI) / D2R;
    });
    // ---- swell: narrow log-normal band around the swell frequency (≥ two slots share it → wave groups / sets)
    const ws = TAU / swellT, sw = [];
    let sumS = 0;
    for (let i = 0; i < NW; i++) if (this.fam[i] === 1) { const x = Math.log(this.w[i] / ws); const e = Math.exp(-(x * x) / (2 * 0.085 * 0.085)) * this.w[i]; sw.push([i, e]); sumS += e; }
    const stravel = swellFrom + 180;
    for (const [i, e] of sw) this.tAmp[i] = sumS > 0 ? Math.min(Math.sqrt(2 * e / sumS) * (swellH / 2.35), 0.045 * this.len[i]) : 0;
    sw.map(([i]) => i).sort((a, b) => this.tAmp[b] - this.tAmp[a]).forEach((i, r) => { this.tAng[i] = stravel + spreadAngle(THREE.MathUtils.clamp(rankU(r, i), 0.05, 0.95), 45) / D2R; });
    // keep target angles within ±180° of the live ones so easing takes the short way round
    for (let i = 0; i < NW; i++) this.tAng[i] = this.ang[i] + (((this.tAng[i] - this.ang[i]) % 360) + 540) % 360 - 180;
  }
  /** Tide: vertical offset of the whole surface (both meshes, heightAt, wakes). */
  /** Lock chamber footprints in world xz (4 points each): the ocean is not drawn there (the chamber water mesh is). */
  setCutouts(quads = []) {
    const u = this.uniforms; if (!u.uCutN) return;
    const q8 = quads.filter((q) => q && q.length >= 4).slice(0, u.uCutA.value.length); u.uCutN.value = q8.length;
    q8.forEach((q, i) => { u.uCutA.value[i].set(q[0][0], q[0][1], q[1][0], q[1][1]); u.uCutB.value[i].set(q[2][0], q[2][1], q[3][0], q[3][1]); });
  }
  setLevel(y) { this.level = Number.isFinite(y) ? y : 0; oceanState.level = this.level; }
  setRain(r) { this.rain = THREE.MathUtils.clamp(Number.isFinite(r) ? r : 0, 0, 1); }
  setStorm(s) { this.storm = THREE.MathUtils.clamp(Number.isFinite(s) ? s : 0, 0, 1); }
  setSun(dir, color, night, skyTop, skyHorizon) {
    this.uniforms.uSunDir.value.copy(dir); this.uniforms.uSunColor.value.copy(color); this.uniforms.uNight.value = night;
    this.uniforms.uSkyTop.value.copy(skyTop); this.uniforms.uSkyHorizon.value.copy(skyHorizon);
  }
  /** The Moon as a dim second glitter light (dir = towards the moon, colour = its display colour; null = none). */
  setMoon(dir, color) {
    const u = this.uniforms;
    const ok = dir && color && Number.isFinite(dir.x) && Number.isFinite(dir.y) && Number.isFinite(dir.z);
    if (!ok) { u.uMoonCol.value.setRGB(0, 0, 0); return; }
    u.uMoonDir.value.set(dir.x, dir.y, dir.z).normalize();
    const r = color.r ?? color.x ?? 0, g = color.g ?? color.y ?? 0, b = color.b ?? color.z ?? 0;
    u.uMoonCol.value.setRGB(r, g, b).multiplyScalar(MOON_GLINT);
  }
  /**
   * Searchlights / deck floods lighting the water: [{ pos, dir, color, cone (cos of the half angle), range }] in the
   * scene's (floating-origin) frame, at most 2; [] = off. Drawn by the full tier's desktop rung only.
   */
  setSpotLights(list) {
    const u = this.uniforms, S = u.uSpot.value;
    let n = 0;
    for (const s of Array.isArray(list) ? list : []) {
      if (n >= 2) break;
      const p = s?.pos, d = s?.dir, c = s?.color;
      if (!p || !d || !c || !Number.isFinite(p.x + p.y + p.z + d.x + d.y + d.z)) continue;
      const dl = Math.hypot(d.x, d.y, d.z) || 1;
      S[n * 3].set(p.x, p.y, p.z, Number.isFinite(s.range) && s.range > 0 ? s.range : 300);
      S[n * 3 + 1].set(d.x / dl, d.y / dl, d.z / dl, Number.isFinite(s.cone) ? THREE.MathUtils.clamp(s.cone, -0.99, 0.999) : 0.9);
      S[n * 3 + 2].set(c.r ?? c.x ?? 0, c.g ?? c.y ?? 0, c.b ?? c.z ?? 0, 0);
      n++;
    }
    u.uSpotN.value = n;
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
    // ~45 % of Monahan's total coverage is active breaking; from a strong gale up the crests tumble over everywhere
    const W = Math.min(0.32, 0.45 * 3.84e-6 * Math.pow(Math.max(U, 0.1), 3.41) + 0.1 * smooth01(18, 30, U));
    u.uFoamA.value = zTail(Math.max(W, 1e-6));
    u.uFoamK.value = smooth01(4.5, 8, U) * Math.min(1, this.hs / 0.4);
    u.uSigLM.value = this.stats.sigLM;
    u.uStreak.value = smooth01(12, 22, U);
    u.uOldMean.value = 0.35 * smooth01(8, 26, U) + 0.2 * smooth01(20, 32, U);   // Bft 10+: the sea takes a white appearance
    this.stats.foamThr = 1 - u.uFoamA.value * this.stats.sigLM;
    // glitter roughness: Cox–Munk total slope variance minus what the spectrum resolves (never below 35 %); 70 % of it is
    // carried by the ripple waves (sharp sparkles near the camera, roughness where unresolved), 30 % stays sub-ripple
    // residual, split upwind / crosswind like Cox–Munk (σu² = 0.00316·U, σc² = 0.003 + 0.00192·U)
    const cm = 0.003 + 0.00512 * U;
    const D = Math.max(0.35 * cm, cm - mss);
    this.detKa = Math.sqrt((2 * 0.7 * D) / NDET);
    const su = 0.3 * D * (0.00316 * U + 0.0005) / cm, sc = 0.3 * D * (0.003 + 0.00192 * U - 0.0005) / cm;
    const tw = (this.windDir + 180) * D2R, wx = Math.sin(tw), wz = -Math.cos(tw);
    u.uSig0.value.set(su * wx * wx + sc * wz * wz, su * wz * wz + sc * wx * wx, (su - sc) * wx * wz);
    // cat's-paws: patchy ripples in light air, uniform once the wind drives the sea
    u.uPawC.value = 1 - smooth01(3.5, 9, U);
    // lite tier whitecaps: the vertex Jacobian against the same Monahan threshold
    u.uLiteThr.value = 1 - u.uFoamA.value * this.stats.sigLM; u.uLiteSoft.value = 0.9 * this.stats.sigLM + 1e-4;
    // breaking crests: a component whose steepness Q·k·A passes the threshold (lower in stronger wind) whitens its front
    // face; storm crests lean forward as they tumble (vertex)
    u.uBrk.value.set(u.uFoamK.value * smooth01(6, 12, U), 0.3 - 0.12 * smooth01(10, 24, U));
    u.uLean.value = 0.3 * smooth01(16, 28, U);
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
    this.sceneAt = nowMs();
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
    if (this._renderer) this.checkTier();
    // ripple directions follow the wind travel direction (≤ 0.25 rad/s), phases held at the view centre
    {
      const tgt = (this.windDir + 180) * D2R;
      if (!this.detInit) { this.detAng = tgt; this.detInit = true; }
      let d = tgt - this.detAng; d = Math.atan2(Math.sin(d), Math.cos(d));
      if (Math.abs(d) > 1e-4) {
        const step = Math.sign(d) * Math.min(Math.abs(d), 0.25 * dt), vx = this.view.x + this.frameF.x, vz = this.view.z + this.frameF.z;
        for (let i = 0; i < NDET; i++) {
          const a0 = this.detAng + DET[i].off, a1 = a0 + step;
          this.detPh[i] += DET[i].k * ((Math.sin(a0) - Math.sin(a1)) * vx + (-Math.cos(a0) + Math.cos(a1)) * vz);
          if (this.detPh[i] > 1e4 || this.detPh[i] < -1e4) this.detPh[i] %= TAU;
        }
        this.detAng += step;
      }
      // cat's-paw patches drift downwind
      const sp = 0.5 * this.wind * dt;
      // residual foam drifts downwind (~3.5 % of the wind speed)
      const fd = 0.035 * this.wind * dt;
      this.foamDrift.x = posMod(this.foamDrift.x + Math.sin(tgt) * fd, PAT_ANCHOR); this.foamDrift.z = posMod(this.foamDrift.z - Math.cos(tgt) * fd, PAT_ANCHOR);
      this.uniforms.uFoamDrift.value.set(this.foamDrift.x, this.foamDrift.z);
      this.paw.x = posMod(this.paw.x + Math.sin(tgt) * sp, GRP_PERIOD); this.paw.z = posMod(this.paw.z - Math.cos(tgt) * sp, GRP_PERIOD);
    }
    this.updateWakes(dt);
    // wave-group field drifts with the dominant waves at the group velocity g·Tp/4π
    const cg = (G * this.stats.tp) / (4 * Math.PI), ta = (this.seaTravel ?? this.windDir + 180) * D2R;
    this.grp.x = posMod(this.grp.x + Math.sin(ta) * cg * dt, GRP_PERIOD); this.grp.z = posMod(this.grp.z - Math.cos(ta) * cg * dt, GRP_PERIOD);
    const u = this.uniforms;
    u.uTime.value = time; u.uWind.value = this.wind; u.uRain.value = this.rain; u.uLevel.value = this.level; u.uHs.value = this.hs;
    u.uStorm.value = Math.max(this.storm, 0.9 * smooth01(10, 24, this.wind));   // a gale sea is slate-grey under the overcast
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
    if (this._renderer && this.matLevel === 2 && u.uFoamK.value > 0 && this.foamAcc >= 0.05) { this.runFoam(this._renderer, Math.min(this.foamAcc, 0.25)); this.foamAcc = 0; }
    else if (u.uFoamK.value <= 0) { u.uFoamOn.value = 0; this.foamPrev = null; }
    // spindrift
    const sprayK = Math.max(smooth01(12, 22, this.wind), 0.6 * this.storm * smooth01(9, 14, this.wind)) * Math.min(1, this.hs / 1.5);   // spray off the crests in strong wind
    this.spray.visible = sprayK > 0.01 && this.matLevel === 2;
    const su = this.sprayUniforms;
    su.uTime.value = time; su.uFrac.value = sprayK * 0.9;
    su.uThr.value = 1 - (u.uFoamA.value + 0.1) * this.stats.sigLM; su.uSoft.value = 0.6 * this.stats.sigLM + 1e-4;
    su.uWindV.value.set(Math.sin(wa) * this.wind, 0, -Math.cos(wa) * this.wind);
    const sunUp = THREE.MathUtils.clamp(u.uSunDir.value.y * 4, 0, 1) * (1 - u.uNight.value * 0.9);
    su.uCol.value.setRGB(0.92, 0.95, 0.97).multiplyScalar((0.3 + 0.7 * sunUp) * (1 - 0.7 * u.uNight.value));
    oceanState.time = time; oceanState.level = this.level; oceanState.hs = this.hs; oceanState.wind = this.wind; oceanState.windDir = this.windDir;
    active = this;
  }
  // ------------------------------------------------------------------ GPU tiers (mobile-safe fallback chain)
  /**
   * Bind the renderer (main.js calls this once after creating the ocean; otherwise the first draw does). Picks the
   * highest shader tier the GPU's limits allow, then the first update() self-tests it: the program must link AND draw
   * a non-black sea into a corner of the canvas, else the next tier down is tried (full → lite → basic) with a
   * console.error naming the cause. A black / missing sea is never the result of a shader problem.
   */
  init(renderer) {
    if (!renderer || this._inited) return;
    this._renderer = renderer; this._inited = true;
    const c = renderer.capabilities || {};
    const info = { webgl2: !!c.isWebGL2, precision: c.precision, maxFragmentUniforms: c.maxFragmentUniforms, maxVertexUniforms: c.maxVertexUniforms, maxVaryings: c.maxVaryings, maxTextures: c.maxTextures, maxVertexTextures: c.maxVertexTextures };
    this.gpu = info;
    // full needs WebGL2 + highp fragments (per-pixel phases |k·x| up to 10⁴ rad) + a vertex texture; the uniform /
    // varying / sampler budget of every rung is checked against the GPU's own limits (32 vectors to spare) in pickRung
    let cap = 2;
    if (!c.isWebGL2 || c.precision !== 'highp' || (c.maxTextures || 0) < 8 || (c.maxVertexTextures || 0) < 1) cap = 1;
    // phones (256 vectors per stage, Adreno / Mali through ANGLE) start the full tier at its lean rung
    this.lowLimits = Math.min(c.maxFragmentUniforms || 0, c.maxVertexUniforms || 0) < 512;
    if (cap < 2) { const why = `GPU limits: ${JSON.stringify(info)}`; this.tierLog.push(`lite cap: ${why}`); console.warn('[ocean] GPU limits → lite sea shader', info); }
    this.matCap = cap;
    // offscreen self-tests (8x8 RGBA8 target, always readable) before anything is drawn: the highest tier that has a
    // rung which links AND draws, walking its rungs, then the tiers below; basic is always proven too (last resort)
    let top = -1;
    for (let lvl = cap; lvl >= 0; lvl--) {
      if (this.pickRung(lvl, 0)) { top = lvl; break; }
      if (lvl > 0) console.error(`[ocean] no ${['basic', 'lite', 'full'][lvl]} sea shader works on this GPU — falling back to ${['basic', 'lite'][lvl - 1]}`, info);
    }
    if (top > 0) this.pickRung(0, 0);
    this.matCap = Math.max(0, top);
    this.applyMaterial(this.tier < 0 ? 2 : this.tier);
  }
  /** A ShaderMaterial for rung i of tier lvl (all tiers share this.uniforms). */
  makeMat(lvl, i) {
    const r = SEA_RUNGS[lvl][i], s = seaShader(lvl, r);
    const m = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: s.vert, fragmentShader: s.frag, fog: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
    m.name = `ocean-${r.name}`; m.userData.rung = r; m.userData.envH = 0;
    return m;
  }
  /** Switch tier lvl to rung i (rebuilds its material; the meshes follow when that tier is the one drawn). */
  setRung(lvl, i) {
    if (this.rung[lvl] === i && this.mats[lvl]) return;
    const old = this.mats[lvl];
    this.mats[lvl] = this.makeMat(lvl, i); this.rung[lvl] = i;
    if (this.matLevel === lvl) {
      this.material = this.mats[lvl]; this.mesh.material = this.material; this.far.material = this.material;
      this.matWatch = 0; this.matSince = nowMs(); this.matChecks = 0;
    }
    if (old && old !== this.mats[lvl]) old.dispose();
  }
  /** Estimated budget of a rung as a short string (diagnostics panel). */
  budgetText(lvl, r, b = seaBudget(lvl, r)) {
    return `${r.name} V${b.vertex.uniforms}/F${b.fragment.uniforms} vec4, ${b.varyings} varyings, ${b.vertex.samplers}+${b.fragment.samplers} tex`;
  }
  /**
   * Walk the rungs of tier lvl from `from`: skip what this GPU cannot run by its limits (precision, the estimated
   * uniform / varying / sampler budget with 32 vectors to spare, full rungs meant for ≥ 512-vector GPUs on a phone),
   * self-test the rest in order; the first that links and draws stays. Returns whether one did.
   */
  pickRung(lvl, from) {
    const rungs = SEA_RUNGS[lvl], g = this.gpu || {}, tier = ['basic', 'lite', 'full'][lvl];
    for (let i = from; i < rungs.length; i++) {
      const r = rungs[i], b = seaBudget(lvl, r);
      if (r.highp && g.precision && g.precision !== 'highp') { this.tierLog.push(`${r.name}: skipped (needs highp)`); continue; }
      if (lvl === 2 && this.lowLimits && !r.lowLimit) { this.tierLog.push(`${r.name}: skipped (GPU has < 512 uniform vectors)`); continue; }
      if (g.maxFragmentUniforms && !budgetFits(b, g, 32)) { this.tierLog.push(`${r.name}: skipped (budget ${this.budgetText(lvl, r, b)} > limits − 32)`); continue; }
      this.setRung(lvl, i);
      this.budget[tier] = this.budgetText(lvl, r, b);
      let t;
      try { t = this.selfTest(lvl); } catch (e) { t = { ok: true, why: 'self-test threw: ' + e }; this.tierLog.push(`${r.name}: ${t.why}`); }
      if (t.ok) { this.matOk[lvl] = true; this.tierLog.push(`${r.name}: self-test ok (${this.budget[tier]})`); return true; }
      this.tierLog.push(`${r.name}: FAILED ${t.why}`);
      console.error(`[ocean] sea shader ${r.name} cannot be used on this GPU (${t.why})`, g);
    }
    this.matOk[lvl] = false;
    return false;
  }
  /** Diagnostics for the in-game panel (diag.js). */
  diag() {
    const names = ['basic', 'lite', 'full'];
    return {
      shader: names[this.matLevel], cap: names[this.matCap], selfTests: this.matOk.map((v, i) => `${names[i]}=${v === null ? 'untested' : v ? 'ok' : 'FAILED'}`).join(' '),
      safeStart: this.safeStart, quality: this.quality, grid: this.gridN, ripples: this.uniforms.uNDet.value, foamRT: !!this.foamRT, wakeSim: this.wake ? (this.wake.ok ? 'on' : 'broken') : (this.wakeOk === false ? 'unsupported' : 'off'),
      ships: this.ships.size, kelvin: this.kel.length, track: this.trackPts.length, spots: this.uniforms.uSpotN.value, env: this.uniforms.uEnvK.value > 0, frames: this.matChecks, upSec: Math.round((nowMs() - this.bornAt) / 1000),
      governor: { fps: Math.round(1 / Math.max(1e-3, this.gov.ema)), lastDrop: this.gov.lastDrop ? Math.round((nowMs() - this.gov.lastDrop) / 1000) + 's ago' : 'never', lastChange: this.gov.lastChange ? Math.round((nowMs() - this.gov.lastChange) / 1000) + 's ago' : 'never' },
      rungs: this.rung.map((i, l) => SEA_RUNGS[l][i].name).join(' '),
      budget: { ...this.budget, limit: this.gpu ? `V${this.gpu.maxVertexUniforms}/F${this.gpu.maxFragmentUniforms} vec4, ${this.gpu.maxVaryings} varyings (rungs must fit with 32 to spare)` : 'no renderer yet' },
      gpu: this.gpu || null, tierLog: this.tierLog.slice(-16),
      sea: { wind: this.wind, hs: +this.hs.toFixed(2), level: this.level, storm: this.storm },
      meshes: { near: this.mesh.visible, far: this.far.visible, material: this.material?.name, nearTris: this.mesh.geometry?.index ? this.mesh.geometry.index.count / 3 : 0 },
    };
  }
  /**
   * Frame-rate governor (main.js calls this each frame instead of its own): resolution and ripple count go first, the
   * shader tier last, with hysteresis — nothing changes in the first 30 s after load or within 20 s of a scene change
   * (origin shift / teleport); a drop needs 8 s of sustained slow frames; a step back up never comes within 2 minutes
   * of the last drop. This is what stops the sea flipping between the two looks while tiles load.
   */
  govern(now, renderer) {
    const g = this.gov;
    if (!g.last) { g.last = now; g.pr0 = renderer ? renderer.getPixelRatio() : 1; return; }
    const dt = (now - g.last) / 1000; g.last = now;
    if (dt <= 0 || dt > 3 || (typeof document !== 'undefined' && document.hidden)) { g.slowSince = 0; return; }   // tab switch / hitch
    g.ema += (dt - g.ema) * 0.05;
    if (now - this.bornAt < 30000 || now - this.sceneAt < 20000) { g.slowSince = 0; return; }
    const slow = g.ema > 1 / 24, fast = g.ema < 1 / 55;
    if (slow) { if (!g.slowSince) g.slowSince = now; } else g.slowSince = 0;
    const q = this.quality, pr = renderer ? renderer.getPixelRatio() : 1;
    if (slow && now - g.slowSince > 8000 && now - g.lastChange > 8000) {
      // ladder: fewer ripples (q 0.75, same shader) → fewer pixels → coarser grid, no wake sim (q 0.5, same shader) → lite shader (q 0.2)
      if (q > 0.75) this.setQuality(0.75);
      else if (renderer && pr > 0.6) renderer.setPixelRatio(Math.max(0.6, pr - 0.25));
      else if (q > 0.5) this.setQuality(0.5);
      else if (q > 0.2) this.setQuality(0.2);
      else return;
      g.lastDrop = now; g.lastChange = now; g.slowSince = 0; g.ema = 1 / 40;
      this.tierLog.push(`governor: slow (${Math.round(1 / g.ema)} fps) → quality ${this.quality}, pixel ratio ${renderer ? renderer.getPixelRatio() : pr}`);
    } else if (fast && now - g.lastDrop > 120000 && now - g.lastChange > 30000) {
      if (q < 0.5) this.setQuality(0.5);
      else if (q < 0.75) this.setQuality(0.75);
      else if (renderer && pr < g.pr0) renderer.setPixelRatio(Math.min(g.pr0, pr + 0.25));
      else if (q < 1 && !this.safeStart) this.setQuality(1);
      else return;
      g.lastChange = now; g.ema = 1 / 45;
    }
  }
  /** Material for a quality tier, capped by what the GPU proved it can run. */
  applyMaterial(tier) {
    let lvl = Math.min(this.matCap, tier === 0 ? 1 : 2);
    if (this.safeStart && this.matOk[2] !== true) lvl = Math.min(lvl, 1);
    if (lvl === this.matLevel && this.material === this.mats[lvl]) return;
    this.matLevel = lvl; this.material = this.mats[lvl];
    this.mesh.material = this.material; this.far.material = this.material;
    this.matWatch = 0; this.matSince = nowMs(); this.matChecks = 0;
    this.tierLog.push(`shader → ${['basic', 'lite', 'full'][lvl]}`);
    if (lvl < 2) { this.uniforms.uFoamOn.value = 0; this.foamPrev = null; }
  }
  /** Self-test / link check of the active tier; on failure step down and say why. */
  checkTier() {
    const r = this._renderer, lvl = this.matLevel;
    if (!r) return;
    const age = nowMs() - this.matSince, due = [2000, 5000, 10000, 20000, 30000][this.matChecks] ?? (30000 + 20000 * (this.matChecks - 4));
    if (this.matOk[lvl] === null || age > due) {
      this.matChecks++;
      let ok = true, why = '';
      try { const t = this.selfTest(lvl); ok = t.ok; why = t.why; } catch (e) { ok = true; console.warn('[ocean] sea self-test skipped', e); }
      if (!ok) { this.matOk[lvl] = false; return this.failTier(lvl, why); }
      if (this.matOk[lvl] === null) this.matOk[lvl] = true;
      // phones: lite was drawn first; the full shader passed its offscreen test → use it (once, after 3 s of frames)
      if (this.safeStart && lvl < 2 && this.matCap >= 2 && this.matOk[2] === true && age > 3000) { this.safeStart = false; this.tierLog.push('safe start done: full shader passed'); this.applyMaterial(this.tier); }
    }
    // the screen variant of the program (fog / tone mapping) is a separate link: watch it for a few seconds
    if (this.matWatch < 600) {
      this.matWatch++;
      const p = r.properties.get(this.material)?.currentProgram;
      if (p && p.diagnostics && p.diagnostics.runnable === false) this.failTier(lvl, 'program failed to link: ' + (p.diagnostics.programLog || p.diagnostics.fragmentShader?.log || p.diagnostics.vertexShader?.log || '').slice(0, 400));
    }
  }
  failTier(lvl, why) {
    const name = ['basic', 'lite', 'full'][lvl];
    // a leaner rung of the same tier first (the screen variant of a program can fail where the offscreen test passed)
    if (lvl > 0 && this.rung[lvl] + 1 < SEA_RUNGS[lvl].length) {
      this.tierLog.push(`${SEA_RUNGS[lvl][this.rung[lvl]].name}: FAILED ${why}`);
      if (this.pickRung(lvl, this.rung[lvl] + 1)) return;
    }
    if (lvl === 0) { console.error(`[ocean] even the basic sea shader failed (${why}); nothing left to fall back to`, this.gpu); this.matOk[0] = true; return; }
    console.error(`[ocean] the ${name} sea shader cannot be used on this GPU (${why}) — falling back to ${['basic', 'lite'][lvl - 1]}`, this.gpu);
    this.tierLog.push(`${name}: FAILED ${why}`);
    this.matOk[lvl] = false;
    this.matCap = lvl - 1;
    this.applyMaterial(this.tier);
    if (this.wake) { this.wake.dispose(); this.wake = null; }
  }
  /** Draw the sea with tier `lvl` into an offscreen 8x8 RGBA8 render target (readable on every GPU) and read it back. */
  selfTest(lvl) {
    const r = this._renderer;
    if (!this._test) {
      const g = new THREE.PlaneGeometry(400, 400, 8, 8); g.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(g, this.mats[lvl]); mesh.frustumCulled = false;
      const scene = new THREE.Scene(); scene.add(mesh);
      const rt = new THREE.WebGLRenderTarget(8, 8, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: true, stencilBuffer: false, generateMipmaps: false });
      this._test = { scene, mesh, cam: new THREE.PerspectiveCamera(50, 1, 0.5, 3000), rt };
    }
    const T = this._test, u = this.uniforms;
    T.mesh.material = this.mats[lvl];
    T.scene.fog = this.scene.fog || null;
    const saved = { c: u.uC.value.clone(), cut: u.uCutN.value, night: u.uNight.value, wake: u.uWakeRect.value.w, kel: u.uKelN.value, spot: u.uSpotN.value, trk: u.uTrkN.value };
    u.uC.value.set(0, 0); u.uCutN.value = 0; u.uNight.value = 0; u.uWakeRect.value.w = 0; u.uKelN.value = 0; u.uSpotN.value = 0; u.uTrkN.value = 0;
    T.cam.position.set(0, this.level + 35, 45); T.cam.lookAt(0, this.level, 0); T.cam.updateMatrixWorld();
    const prevRT = r.getRenderTarget(), cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha(), ac = r.autoClear, xr = r.xr ? r.xr.enabled : false;
    const px = new Uint8Array(8 * 8 * 4);
    let why = '';
    try {
      if (r.xr) r.xr.enabled = false;
      r.setRenderTarget(T.rt);
      r.setClearColor(0xff00ff, 1); r.autoClear = true;
      r.render(T.scene, T.cam);
      r.readRenderTargetPixels(T.rt, 0, 0, 8, 8, px);
    } finally {
      r.setRenderTarget(prevRT); r.setClearColor(cc, ca); r.autoClear = ac; if (r.xr) r.xr.enabled = xr;
      u.uC.value.copy(saved.c); u.uCutN.value = saved.cut; u.uNight.value = saved.night; u.uWakeRect.value.w = saved.wake; u.uKelN.value = saved.kel; u.uSpotN.value = saved.spot; u.uTrkN.value = saved.trk;
    }
    const prog = r.properties.get(this.mats[lvl])?.currentProgram;
    if (prog && prog.diagnostics && prog.diagnostics.runnable === false) return { ok: false, why: 'program failed to link: ' + (prog.diagnostics.programLog || prog.diagnostics.fragmentShader?.log || '').slice(0, 400) };
    let good = 0, magenta = 0, black = 0;
    for (let i = 0; i < 64; i++) {
      const R = px[i * 4], Gc = px[i * 4 + 1], B = px[i * 4 + 2];
      if (R > 235 && Gc < 25 && B > 235) magenta++; else if (R + Gc + B < 6) black++; else good++;
    }
    if (good >= 32) return { ok: true, why: '' };
    why = magenta > black ? `drew nothing (${magenta}/64 pixels untouched)` : `drew black / NaN (${black}/64 pixels)`;
    return { ok: false, why };
  }

  // ------------------------------------------------------------------ ship wakes
  /**
   * Report a ship for this frame (main.js shipVisual): key = any stable object (the mesh); s = { x, z (local frame),
   * hdg (rad, compass), spd (kn, signed), length, beam, draft, throttle (−1..1), own }. Ships not reported for a second
   * are forgotten. The player's ship drives the local simulation; it and the nearest others get analytic Kelvin wakes.
   */
  feedShip(key, s) {
    if (!key || !s || !Number.isFinite(s.x) || !Number.isFinite(s.z)) return;
    const X = s.x + this.frameF.x, Z = s.z + this.frameF.z;
    let e = this.ships.get(key);
    if (!e) { e = { px: X, pz: Z }; this.ships.set(key, e); }
    else if (e.t !== this.time) { e.px = e.x; e.pz = e.z; }
    e.x = X; e.z = Z; e.t = this.time;
    const h = Number(s.hdg) || 0;
    e.fx = Math.sin(h); e.fz = -Math.cos(h);
    e.spd = (Number(s.spd) || 0) * 0.514444; e.len = Math.max(4, Number(s.length) || 30); e.beam = Math.max(1.5, Number(s.beam) || e.len / 6);
    e.draft = Math.max(0.3, Number(s.draft) || e.len / 18); e.throttle = Number(s.throttle) || 0; e.own = !!s.own;
  }
  updateWakes(dt) {
    // forget ships that were not reported recently (sunk, out of range, despawned)
    for (const [k, e] of this.ships) if (this.time - e.t > 1.0 || this.time < e.t) this.ships.delete(k);
    const cx = (this.lastCam ? this.lastCam.x : 0) + this.frameF.x, cz = (this.lastCam ? this.lastCam.z : 0) + this.frameF.z;
    const list = [...this.ships.values()].sort((a, b) => (b.own - a.own) || (Math.hypot(a.x - cx, a.z - cz) - Math.hypot(b.x - cx, b.z - cz))).slice(0, Math.min(MAXKEL, WAKE_MAX_SHIPS));
    const own = list.find((e) => e.own) || null;
    // local simulation (desktop-class GPUs, full tier)
    if (this.wakeWant && this.matLevel === 2 && this._renderer && !this.wake && this.wakeOk !== false) {
      this.wakeOk = WakeSim.supported(this._renderer);
      if (this.wakeOk) { this.wake = new WakeSim(this._renderer, 384); if (!this.wake.ok) { this.wake.dispose(); this.wake = null; this.wakeOk = false; } }
    }
    if (this.wake && (!this.wakeWant || this.matLevel < 2)) { this.wake.dispose(); this.wake = null; }
    this.wakeLive = false;
    const inSim = new Set();
    if (this.wake && own) {
      this.wake.setShipLength(own.len);
      const sim = [];
      for (const e of list) {
        const U = Math.abs(e.spd);
        sim.push({ x: e.x, z: e.z, x0: e.px, z0: e.pz, fx: e.fx, fz: e.fz, len: e.len, beam: e.beam, draft: e.draft, spd: U, wash: (U > 0.3 || Math.abs(e.throttle) > 0.05) ? Math.min(1, Math.abs(e.throttle) * 0.7 + U / 10) : 0 });
      }
      this.wakeLive = this.wake.step(dt, { x: own.x, z: own.z }, sim) || !!this.wake.rect();
      const r = this.wake.rect();
      // the simulation draws the near wake of every ship whose hull is inside its domain
      if (r) for (const e of list) if (e.x > r.x + e.len && e.z > r.z + e.len && e.x < r.x + r.L - e.len && e.z < r.z + r.L - e.len) inSim.add(e);
    }
    this.recordTrack(own, dt);
    // analytic Kelvin wakes (all tiers): k0 = g/U², amplitude from the hull's Froude number; the own ship's wake and
    // wash follow its recorded track (curved when it turns)
    this.kel = [];
    for (const e of list) {
      const U = Math.abs(e.spd);
      if (U < 0.8) continue;
      const Fr = U / Math.sqrt(G * e.len), sgn = e.spd < 0 ? -1 : 1;
      this.kel.push({
        x: e.x, z: e.z, fx: e.fx * sgn, fz: e.fz * sgn, k0: G / (U * U), len: e.len, beam: e.beam,
        amp: Math.min(0.8, 0.022 * e.beam * smooth01(0.06, 0.3, Fr)) * (sgn < 0 ? 0.4 : 1),
        reach: Math.min(4000, 30 * e.len + 400), foam: smooth01(1.5, 7, U) * (0.55 + 0.45 * Math.min(1, Math.abs(e.throttle))),
        sim: this.wakeLive && inSim.has(e) ? 1 : 0, trk: e === own && this.trackPts.length >= 2 ? 1 : 0,
      });
    }
  }

  /**
   * Own-ship track: a sample every 1/TRACK_HZ s for the last TRACK_S s (invariant frame), resampled each frame into
   * NTRK points evenly spaced along the path (newest = the ship): x, z, metres behind the ship, age (s).
   */
  recordTrack(own, dt) {
    const T = this.track;
    if (!own) { T.length = 0; this.trackPts = []; return; }
    const last = T[T.length - 1];
    if (last && (this.time < last.t || Math.hypot(own.x - last.x, own.z - last.z) > 400)) T.length = 0;   // teleport / time jump
    this.trackAcc += dt;
    if (!T.length || this.trackAcc >= 1 / TRACK_HZ) { this.trackAcc = 0; T.push({ x: own.x, z: own.z, t: this.time }); }
    while (T.length > 2 && this.time - T[0].t > TRACK_S) T.shift();
    // newest first, starting at the ship's current position; arc length along the path
    const P = [{ x: own.x, z: own.z, t: this.time, s: 0 }];
    for (let i = T.length - 1; i >= 0; i--) {
      const p = P[P.length - 1], q = T[i], d = Math.hypot(q.x - p.x, q.z - p.z);
      if (d < 0.05) continue;
      P.push({ x: q.x, z: q.z, t: q.t, s: p.s + d });
    }
    const L = Math.min(P[P.length - 1].s, Math.min(4000, 30 * own.len + 400));
    if (P.length < 2 || L < 2) { this.trackPts = []; return; }
    const out = [];
    let j = 0;
    for (let k = 0; k < NTRK; k++) {
      const s = (L * k) / (NTRK - 1);
      while (j < P.length - 2 && P[j + 1].s < s) j++;
      const a = P[j], b = P[j + 1], f = b.s > a.s ? Math.min(1, Math.max(0, (s - a.s) / (b.s - a.s))) : 0;
      out.push({ x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, s, age: this.time - (a.t + (b.t - a.t) * f) });
    }
    this.trackPts = out;
  }
  /** Per draw (onBeforeRender of the meshes): centre the grid where the camera looks, snap it, re-reference the phases. */
  prepare(renderer, camera) {
    if (renderer && !this._inited) this.init(renderer);
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
    // ripples: phase referenced to the grid origin (invariant frame, double precision on the CPU)
    const Fx0 = this.frameF.x, Fz0 = this.frameF.z, Dt = u.uDet.value, t = this.time;
    for (let i = 0; i < NDET; i++) {
      const d = DET[i], a = this.detAng + d.off, ddx = Math.sin(a), ddz = -Math.cos(a);
      Dt[i].set(d.k * ddx, d.k * ddz, wrapTau(this.detPh[i] - d.w * t + d.k * (ddx * (Cx + Fx0) + ddz * (Cz + Fz0))), this.detKa);
    }
    u.uPawOff.value.set(-this.paw.x, -this.paw.z);
    // analytic Kelvin wakes, relative to the grid origin
    const KA = u.uKelA.value, KB = u.uKelB.value, KC = u.uKelC.value;
    let nk = 0;
    for (const k of this.kel) {
      if (nk >= MAXKEL) break;
      KA[nk].set(k.x - Fx0 - Cx, k.z - Fz0 - Cz, k.fx, k.fz); KB[nk].set(k.k0, k.amp, k.len, k.reach); KC[nk].set(k.beam, k.foam, k.sim, nk === 0 ? k.trk : 0);
      if (nk === 0 && k.trk) {
        const Tk = u.uTrk.value, tp = this.trackPts;
        for (let j = 0; j < tp.length; j++) Tk[j].set(tp[j].x - Fx0 - Cx, tp[j].z - Fz0 - Cz, tp[j].s, tp[j].age);
        u.uTrkN.value = tp.length;
      }
      nk++;
    }
    u.uKelN.value = nk;
    if (!nk || !this.kel[0].trk) u.uTrkN.value = 0;
    this.bindEnvironment();
    const wr = this.wake && this.wake.ok ? this.wake.rect() : null;
    if (wr && this.wakeLive) { u.uWakeRect.value.set(wr.x - Fx0 - Cx, wr.z - Fz0 - Cz, wr.L, 1); u.uWakeTexel.value = 1 / this.wake.n; u.uWakeTex.value = this.wake.texture; }
    else { u.uWakeRect.value.w = 0; u.uWakeTex.value = noShoreTexture(); }
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
  /** The scene's PMREM environment as the full tier's sky reflection (desktop rung only; recompiles on a size change). */
  bindEnvironment() {
    const u = this.uniforms, m = this.mats[2], env = this.scene && this.scene.environment;
    const h = m && m.userData.rung && m.userData.rung.env && env && env.mapping === THREE.CubeUVReflectionMapping && env.image && env.image.height ? env.image.height : 0;
    if (m && m.userData.rung && m.userData.rung.env && m.userData.envH !== h) {
      m.userData.envH = h;
      if (h) {
        const maxMip = Math.log2(h) - 2;
        m.defines = { ENVMAP_TYPE_CUBE_UV: '', CUBEUV_TEXEL_WIDTH: 1 / (3 * Math.max(Math.pow(2, maxMip), 7 * 16)), CUBEUV_TEXEL_HEIGHT: 1 / h, CUBEUV_MAX_MIP: maxMip.toFixed(1) };
      } else m.defines = {};
      m.needsUpdate = true;
      if (this.matLevel === 2) { this.matWatch = 0; this.matSince = nowMs(); }
      this.tierLog.push(`environment sky ${h ? `on (${h} px PMREM)` : 'off'}`);
    }
    u.envMap.value = h ? env : null; u.uEnvK.value = h ? 1 : 0;
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
    this.mats.forEach((m) => m.dispose()); this.sprayMat.dispose();
    if (this.wake) this.wake.dispose();
    if (this._test) { this._test.mesh.geometry.dispose(); this._test.rt.dispose(); } this.depthTex.dispose(); this.shelterTex.dispose();
    this.foamScene.children[0].geometry.dispose(); this.foamScene.children[0].material.dispose();
    if (this.foamRT) this.foamRT.forEach((r) => r.dispose());
    if (active === this) active = null;
  }
}

function posMod(a, m) { a %= m; return a < 0 ? a + m : a; }
function nowMs() { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); }
