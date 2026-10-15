// FFT ocean for the desktop tier (ocean2.js uses it when the GPU has ≥ 512 uniform vectors per stage and float render
// targets; everything else keeps the Gerstner path).
//
// Spectrum: JONSWAP wind sea (γ 3.3, peak ωp = 2π/Tp) with Donelan–Banner sech² directional spreading (β from ω/ωp),
// plus a narrow swell band (Gaussian in ω, sech²(6θ) spread) — both normalised so the field's significant height equals
// the LIVE Gerstner sea's (the surface the ships ride, heightAt in ocean2.js). Deep-water capillary-gravity dispersion
// ω² = g·k + (σ/ρ)·k³. Three cascades on incommensurate patches (557 m / 61 m / 7.3 m, so they never tile in step),
// each owning an annulus of |k| (boundaries at 6 fundamental wavenumbers of the next patch). The short cascade's energy
// is scaled so the total mean-square slope matches Cox–Munk for the wind (sun glitter stays calibrated; light air is
// rippled, not glassy).
//
// GPU: one RGBA32F atlas (2·cascades·N × N): per cascade two segments of two complex spectra each, so 8 real fields come
// out of 4 complex inverse FFTs: A = (Dx, Dy, Dz, ∂Dx/∂z), B = (∂Dy/∂x, ∂Dy/∂z, ∂Dx/∂x, ∂Dz/∂z). Pass 1 (evolve) builds
// h̃(k, t) = h0(k)·e^{iωt} + conj(h0(−k))·e^{−iωt} directly (h0 from a hashed Gaussian and the spectrum — nothing is
// stored, wind changes are just eased uniforms), ω quantised to multiples of 2π/1000 s so the time can be passed as
// t mod 1000 s in float precision. Then log2 N horizontal + log2 N vertical Stockham radix-2 passes (natural order in,
// natural order out, no bit-reversal texture) ping-pong over the atlas. Assemble writes, per cascade (= array layer), RGBA16F repeat
// textures with mipmaps: D = (λDx, Dy, λDz) [vertex displacement, cascades 0–1], T1 = (∂y/∂x, ∂y/∂z, jxx, jzz),
// T2 = (jxz, y, (∂y/∂x)², (∂y/∂z)²) [cascades 0–1] and for the short cascade T1 = (∂y/∂x, ∂y/∂z, (∂y/∂x)², (∂y/∂z)²).
// Jacobian terms use ocean2's Gerstner sign convention (jxx = −λ·∂Dx/∂x0), so its normal / whitecap code is reused.
// The mip chain is the anti-aliasing: far away the mean slope goes to 0 and E[s²] − E[s]² (LEAN) becomes roughness.
//
// Cost (N = 256, 3 cascades): atlas 1536×256 → 1 evolve + 16 FFT passes ≈ 6.7 M fragments, 13 M RGBA32F fetches;
// assemble 7 × 65 k fragments + mip generation. ≈ 0.4–0.8 ms on a mid desktop dGPU, ~2 ms on a strong iGPU (which gets
// N = 128: a quarter of that). Memory: see FFTWaves.memoryBytes (N = 256: 12.6 MB atlas + 5.6 MB outputs).
import * as THREE from 'three';

export const G = 9.81;
export const ST = 7.4e-5;                       // surface tension / density (m³/s²)
export const FFT_L = [557, 61, 7.3];            // cascade patch sizes (m)
export const T_REP = 1000;                      // time repeat (s): ω quantised to 2π/T_REP
const TAU = Math.PI * 2;
const W0 = TAU / T_REP;

// ------------------------------------------------------------------------------------------------ spectrum (pure)
export function omegaOf(k) { return Math.sqrt(G * k + ST * k * k * k); }
export function dOmegaDk(k) { return (G + 3 * ST * k * k) / (2 * omegaOf(k)); }
/** JONSWAP S(ω) with α = 1 (normalised later): g²ω⁻⁵·exp(−5/4·(ωp/ω)⁴)·γ^r. */
export function jonswapS(w, wp, gamma = 3.3) {
  if (!(w > 0) || !(wp > 0)) return 0;
  const sig = w <= wp ? 0.07 : 0.09, d = (w - wp) / (sig * wp);
  const x = wp / w, x2 = x * x;
  return G * G * Math.pow(w, -5) * Math.exp(-1.25 * x2 * x2) * Math.pow(gamma, Math.exp(-0.5 * d * d));
}
/** Swell band (α = 1): narrow Gaussian in ω around ωs. */
export function swellS(w, ws) { const d = (w - ws) / (0.07 * ws); return Math.exp(-0.5 * d * d); }
/** Donelan–Banner spreading parameter β(ω/ωp); D(θ) = β/2·sech²(βθ). */
export function donelanBeta(wr) {
  let b;
  if (wr < 0.95) b = 2.61 * Math.pow(wr, 1.3);
  else if (wr < 1.6) b = 2.28 * Math.pow(wr, -1.3);
  else b = Math.pow(10, -0.4 + 0.8393 * Math.exp(-0.567 * Math.log(wr * wr)));
  return Math.max(0.6, b);
}
export function sech2D(th, beta) { const c = Math.cosh(beta * th); return beta / (2 * c * c); }
/** Wavenumber bands [lo, hi) per cascade for n texels and nc cascades (the last one stops below its Nyquist). */
export function fftBands(n, nc, L = FFT_L) {
  const nyq = L.map((l) => (Math.PI * n) / l * 0.999), out = [];
  for (let c = 0; c < 3; c++) {
    const lo = c === 0 ? 0 : out[c - 1][1];
    const hi = c < nc - 1 ? Math.min(nyq[c], (6 * TAU) / L[c + 1]) : c < nc ? nyq[c] : lo;
    out.push([lo, Math.max(lo, hi)]);
  }
  return out;
}
/**
 * Directional energy density P(kx, kz) (m² per (rad/m)²) of one cascade, α = 1 for both systems: returns [wind, swell].
 * sp = { wpW, dxW, dzW, wpS, dxS, dzS }. Same maths as the evolve shader.
 */
export function specParts(kx, kz, sp) {
  const k = Math.hypot(kx, kz);
  if (k < 1e-9) return [0, 0];
  const w = omegaOf(k), jac = dOmegaDk(k) / k, ux = kx / k, uz = kz / k;
  const thW = Math.atan2(ux * sp.dzW - uz * sp.dxW, ux * sp.dxW + uz * sp.dzW);
  const eW = jonswapS(w, sp.wpW, 3.3) * sech2D(thW, donelanBeta(w / sp.wpW)) * jac;
  let eS = 0;
  if (sp.wpS > 0) { const thS = Math.atan2(ux * sp.dzS - uz * sp.dxS, ux * sp.dxS + uz * sp.dzS); eS = swellS(w, sp.wpS) * sech2D(thS, 6) * jac; }
  return [eW, eS];
}
/** ∫ over k ∈ [lo, hi) of S(ω(k))·dω/dk·k^p dk (directions integrated: D is normalised), α = 1: [wind, swell]. */
export function bandIntegral(lo, hi, sp, p = 0) {
  lo = Math.max(lo, 1e-4);
  if (!(hi > lo)) return [0, 0];
  const n = 160, a = Math.log(lo), b = Math.log(hi), h = (b - a) / n;
  let sw = 0, ss = 0;
  for (let i = 0; i <= n; i++) {
    const k = Math.exp(a + i * h), wgt = (i === 0 || i === n ? 1 : i % 2 ? 4 : 2) * k;   // dk = k·d(ln k)
    const w = omegaOf(k), f = dOmegaDk(k) * Math.pow(k, p) * wgt;
    sw += jonswapS(w, sp.wpW, 3.3) * f; if (sp.wpS > 0) ss += swellS(w, sp.wpS) * f;
  }
  return [sw * h / 3, ss * h / 3];
}
function smooth01(e0, e1, x) { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }
/** Travel direction (deg, ocean2 convention: (sin a, −cos a)) → unit xz. */
export function travelVec(deg) { const a = deg * Math.PI / 180; return [Math.sin(a), -Math.cos(a)]; }

/**
 * Normalise the spectrum for one sea state. p = { U, dirW (deg travel), tp, hsW, hsS, swellT, dirS }, n texels, nc
 * cascades. The long cascade is summed over its actual grid cells (the peak spans only a few cells there), the others
 * integrated. Returns the uniforms' numbers + statistics: aW, aS, boost (energy factor of the short cascade's wind sea),
 * chop per cascade, hs per cascade, mss per cascade, sigJ (std of the Jacobian of cascades 0+1), fetch (m, equivalent).
 */
export function fftNormalise(p, n, nc, cache = null) {
  const L = FFT_L, bands = fftBands(n, nc), U = Math.max(0, p.U || 0);
  const [dxW, dzW] = travelVec(p.dirW || 0), [dxS, dzS] = travelVec(p.dirS ?? p.dirW ?? 0);
  const wpW = TAU / Math.max(1.2, p.tp || 5), hsS = Math.max(0, p.hsS || 0);
  const sp = { wpW, dxW, dzW, wpS: hsS > 0.01 ? TAU / Math.max(2, p.swellT || 11) : 0, dxS, dzS };
  // cascade 0: discrete cells inside its band
  const dk = TAU / L[0], dk2 = dk * dk, half = n / 2, [lo0, hi0] = bands[0];
  let c0 = cache && cache.n === n && cache.hi0 === hi0 ? cache : null;
  if (!c0) {
    const cells = [], R = Math.ceil(hi0 / dk);
    for (let j = -Math.min(R, half - 1); j <= Math.min(R, half - 1); j++) for (let i = -Math.min(R, half - 1); i <= Math.min(R, half - 1); i++) {
      const k = Math.hypot(i, j) * dk;
      if (k > lo0 && k < hi0) cells.push(i * dk, j * dk);
    }
    c0 = { n, hi0, cells: Float64Array.from(cells) };
  }
  let w0 = 0, s0 = 0, mw0 = 0, ms0 = 0;
  const C = c0.cells;
  for (let i = 0; i < C.length; i += 2) {
    const [ew, es] = specParts(C[i], C[i + 1], sp), k2 = C[i] * C[i] + C[i + 1] * C[i + 1];
    w0 += ew; s0 += es; mw0 += ew * k2; ms0 += es * k2;
  }
  w0 *= dk2; s0 *= dk2; mw0 *= dk2; ms0 *= dk2;
  const I = [1, 2].map((c) => bandIntegral(bands[c][0], bands[c][1], sp, 0));
  const M = [1, 2].map((c) => bandIntegral(bands[c][0], bands[c][1], sp, 2));
  // the long cascade must hold the peak: if the grid misses it (impossible periods), fall back to the integral
  const i0 = bandIntegral(lo0 + dk, hi0, sp, 0);
  const totW = Math.max(w0, 0.3 * i0[0]) + I[0][0] + I[1][0], totS = Math.max(s0, 0.3 * i0[1]) + I[0][1] + I[1][1];
  const hsW = Math.max(0, p.hsW || 0);
  const aW = totW > 0 ? (hsW / 4) ** 2 / totW : 0, aS = totS > 0 && sp.wpS > 0 ? (hsS / 4) ** 2 / totS : 0;
  const m0 = [aW * w0 + aS * s0, aW * I[0][0] + aS * I[0][1], aW * I[1][0] + aS * I[1][1]];
  const mss = [aW * mw0 + aS * ms0, aW * M[0][0] + aS * M[0][1], aW * M[1][0] + aS * M[1][1]];
  // short cascade: Cox–Munk total slope variance minus what the longer cascades resolve (never below 30 %)
  const cm = 0.003 + 0.00512 * U;
  const boost = nc > 2 && mss[2] > 1e-9 ? Math.min(6, Math.max(0.25, Math.max(0.3 * cm, cm - mss[0] - mss[1]) / mss[2])) : 1;
  mss[2] *= boost; m0[2] *= boost;
  // choppiness per cascade: wanted 0.7 → 1.3 with the wind, capped so λ·σ_J ≤ 0.32 per cascade (rare folds = whitecaps)
  const want = 0.7 + 0.6 * smooth01(3, 15, U);
  const chop = [0, 1].map((c) => (mss[c] > 1e-12 ? Math.min(want, 0.32 / Math.sqrt(mss[c])) : want));
  const sigJ = Math.sqrt(chop[0] * chop[0] * mss[0] + chop[1] * chop[1] * (nc > 1 ? mss[1] : 0));
  const fetch = U > 0.5 ? (G * G) / (U * Math.pow(wpW / 22, 3)) : 0;
  return { p: { ...p }, aW, aS, boost, chop, sigJ, hs: m0.map((v) => 4 * Math.sqrt(Math.max(0, v))), mss, wpW, wpS: sp.wpS, dirW: [dxW, dzW], dirS: [dxS, dzS], bands, fetch, cache: c0 };
}

/** CPU reference of the shader's Stockham pass sequence (inverse DFT, unnormalised): complex [re, im] arrays of length N. */
export function fftStockhamCPU(re, im) {
  const N = re.length;
  let a = Array.from(re, (r, i) => [r, im[i]]);
  for (let S = 2; S <= N; S *= 2) {
    const b = new Array(N), h = S / 2;
    for (let idx = 0; idx < N; idx++) {
      const ev = Math.floor(idx / S) * h + (idx % h), od = ev + N / 2;
      const ang = (TAU * (idx % S)) / S, c = Math.cos(ang), s = Math.sin(ang), [orr, oi] = a[od];
      b[idx] = [a[ev][0] + c * orr - s * oi, a[ev][1] + c * oi + s * orr];
    }
    a = b;
  }
  return { re: a.map((v) => v[0]), im: a.map((v) => v[1]) };
}

/** Render-target memory (bytes) of the FFT for n texels and nc cascades: atlas ping-pong + mipmapped outputs. */
export function fftMemoryBytes(n, nc) {
  const atlas = 2 * (2 * nc * n) * n * 16;
  const outs = 7;                                // array layers: d 2 + t1 3 + t2 2 (allocated whatever nc)
  return atlas + Math.round(outs * n * n * 8 * 4 / 3);
}

// ------------------------------------------------------------------------------------------------ GLSL (GLSL ES 3.0)
const PASS_VERT = /* glsl */`
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const HEAD = /* glsl */`
precision highp float; precision highp int; precision highp sampler2D; precision highp sampler2DArray;
out vec4 oc;
vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
`;
const EVOLVE_FRAG = HEAD + /* glsl */`
uniform int uN;
uniform vec3 uL; uniform vec3 uLo; uniform vec3 uHi; uniform vec3 uBoost;
uniform vec4 uWindS;   // aW, ωp, travel x, z
uniform vec4 uSwellS;  // aS, ωs, travel x, z
uniform float uT;      // time mod T_REP
uint pcg(uint v) { uint s = v * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
vec2 gauss2(ivec2 m, int c) {
  uint h = pcg(uint(m.x + 8192) ^ pcg(uint(m.y + 8192) ^ pcg(uint(c) + 17u)));
  float u1 = (float(h >> 8u) + 0.5) / 16777216.0, u2 = (float(pcg(h) >> 8u) + 0.5) / 16777216.0;
  return sqrt(-2.0 * log(u1)) * vec2(cos(6.2831853 * u2), sin(6.2831853 * u2));
}
float jonswap(float w, float wp) {
  float sig = w <= wp ? 0.07 : 0.09; float d = (w - wp) / (sig * wp);
  float x = wp / w; float x2 = x * x;
  return 96.2361 * pow(w, -5.0) * exp(-1.25 * x2 * x2) * pow(3.3, exp(-0.5 * d * d));
}
float donelan(float wr) {
  float b = wr < 0.95 ? 2.61 * pow(wr, 1.3) : wr < 1.6 ? 2.28 * pow(wr, -1.3) : pow(10.0, -0.4 + 0.8393 * exp(-0.567 * log(wr * wr)));
  return max(0.6, b);
}
float sech2(float th, float b) { float c = cosh(b * th); return b / (2.0 * c * c); }
float spec(vec2 k, int c) {
  float kk = length(k);
  if (kk < 1e-6 || kk <= uLo[c] || kk >= uHi[c]) return 0.0;
  float w = sqrt(9.81 * kk + 7.4e-5 * kk * kk * kk);
  float jac = (9.81 + 3.0 * 7.4e-5 * kk * kk) / (2.0 * w) / kk;
  vec2 u = k / kk;
  float e = 0.0;
  if (uWindS.x > 0.0) {
    float th = atan(u.x * uWindS.w - u.y * uWindS.z, u.x * uWindS.z + u.y * uWindS.w);
    e += uWindS.x * uBoost[c] * jonswap(w, uWindS.y) * sech2(th, donelan(w / uWindS.y));
  }
  if (uSwellS.x > 0.0) {
    float th = atan(u.x * uSwellS.w - u.y * uSwellS.z, u.x * uSwellS.z + u.y * uSwellS.w);
    float d = (w - uSwellS.y) / (0.07 * uSwellS.y);
    e += uSwellS.x * exp(-0.5 * d * d) * sech2(th, 6.0);
  }
  return e * jac;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int seg = p.x / uN; int c = seg / 2; int which = seg - 2 * c;
  int ix = p.x - seg * uN; int iy = p.y;
  int mx = ix < uN / 2 ? ix : ix - uN; int mz = iy < uN / 2 ? iy : iy - uN;
  float dk = 6.2831853 / uL[c];
  vec2 k = dk * vec2(float(mx), float(mz));
  float kk = length(k);
  if (kk < 1e-6 || mx == -uN / 2 || mz == -uN / 2) { oc = vec4(0.0); return; }
  float sc = dk * 0.5;                                   // sqrt(Δk²/4)
  vec2 a = gauss2(ivec2(mx, mz), c) * sqrt(spec(k, c)) * sc;
  vec2 b = gauss2(ivec2(-mx, -mz), c) * sqrt(spec(-k, c)) * sc;
  float w = sqrt(9.81 * kk + 7.4e-5 * kk * kk * kk);
  float ph = floor(w / ${W0.toFixed(10)}) * ${W0.toFixed(10)} * uT;
  vec2 e = vec2(cos(ph), sin(ph));
  vec2 h = cmul(a, e) + cmul(vec2(b.x, -b.y), vec2(e.x, -e.y));
  vec2 ih = vec2(-h.y, h.x);
  if (which == 0) oc = vec4(ih * (k.x / kk) + ih, ih * (k.y / kk) - ih * (k.x * k.y / kk));        // Dx + iDy, Dz + i∂Dx/∂z
  else oc = vec4(ih * k.x - h * k.y, -h * (k.x * k.x / kk) - ih * (k.y * k.y / kk));                // ∂y/∂x + i∂y/∂z, ∂Dx/∂x + i∂Dz/∂z
}`;
const FFT_FRAG = HEAD + /* glsl */`
uniform sampler2D uSrc; uniform int uN; uniform int uS; uniform int uVert;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int idx = uVert == 1 ? p.y : p.x - (p.x / uN) * uN;
  int h = uS / 2;
  int ev = (idx / uS) * h + (idx - (idx / h) * h);
  int od = ev + uN / 2;
  ivec2 pe; ivec2 po;
  if (uVert == 1) { pe = ivec2(p.x, ev); po = ivec2(p.x, od); }
  else { int base = p.x - idx; pe = ivec2(base + ev, p.y); po = ivec2(base + od, p.y); }
  vec4 E = texelFetch(uSrc, pe, 0); vec4 O = texelFetch(uSrc, po, 0);
  float ang = 6.283185307 * float(idx - (idx / uS) * uS) / float(uS);
  vec2 tw = vec2(cos(ang), sin(ang));
  oc = vec4(E.xy + cmul(tw, O.xy), E.zw + cmul(tw, O.zw));
}`;
const ASSEMBLE_FRAG = HEAD + /* glsl */`
uniform sampler2D uSrc; uniform int uN; uniform int uC; uniform int uMode; uniform float uChop;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 A = texelFetch(uSrc, ivec2(uC * 2 * uN + p.x, p.y), 0);        // Dx, Dy, Dz, dDx/dz
  vec4 B = texelFetch(uSrc, ivec2(uC * 2 * uN + uN + p.x, p.y), 0);   // dy/dx, dy/dz, dDx/dx, dDz/dz
  float l = uChop;
  if (uMode == 0) oc = vec4(l * A.x, A.y, l * A.z, 1.0);
  else if (uMode == 1) oc = vec4(B.x, B.y, -l * B.z, -l * B.w);
  else if (uMode == 2) oc = vec4(-l * A.w, A.y, B.x * B.x, B.y * B.y);
  else oc = vec4(B.x, B.y, B.x * B.x, B.y * B.y);
}`;
// self-test probe: every output finite and bounded; g carries the height so the CPU can see the field is not flat
const PROBE_FRAG = HEAD + /* glsl */`
uniform sampler2DArray uD; uniform sampler2DArray uT1; uniform sampler2DArray uT2; uniform int uN; uniform int uLast; uniform float uHs;
bool bad(vec4 v) { return any(isnan(v)) || any(isinf(v)) || any(greaterThan(abs(v), vec4(1e4))) || !(v.x == v.x && v.y == v.y && v.z == v.z && v.w == v.w); }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 q = ivec2(p.x * (uN / 4) + uN / 9, p.y * (uN / 4) + uN / 7);
  vec4 d = texelFetch(uD, ivec3(q, 0), 0), a = texelFetch(uT1, ivec3(q, 0), 0), b = texelFetch(uT2, ivec3(q, 0), 0), s = texelFetch(uT1, ivec3(q, uLast), 0);
  bool ok = !(bad(d) || bad(a) || bad(b) || bad(s));
  oc = vec4(ok ? 1.0 : 0.0, clamp(0.5 + d.y / max(0.05, 3.0 * uHs), 0.0, 1.0), ok ? 1.0 : 0.0, 1.0);
}`;
export const FFT_SHADERS = { vert: PASS_VERT, evolve: EVOLVE_FRAG, fft: FFT_FRAG, assemble: ASSEMBLE_FRAG, probe: PROBE_FRAG };

// ------------------------------------------------------------------------------------------------ GPU
export class FFTWaves {
  /** WebGL2, highp, renderable 32-bit float colour, enough texture units for the sea + the cascades. */
  static supported(renderer) {
    try {
      const c = renderer?.capabilities, ext = renderer?.extensions;
      if (!c || !c.isWebGL2 || c.precision !== 'highp' || !ext || !ext.has('EXT_color_buffer_float')) return false;
      return (c.maxTextures || 0) >= 16 && (c.maxVertexTextures || 0) >= 4 && (c.maxTextureSize || 0) >= 2048;
    } catch { return false; }
  }
  /** Weak desktop GPUs (integrated / software) start at N = 128. */
  static weakGPU(renderer) {
    try {
      const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
      const s = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) || '');
      return /intel|uhd|iris|swiftshader|llvmpipe|software|microsoft basic|mali|adreno|powervr|apple gpu/i.test(s);
    } catch { return false; }
  }
  constructor(renderer, { n = 256, cascades = 3 } = {}) {
    this.r = renderer; this.n = 0; this.nc = 0; this.ok = false; this.frames = 0;
    this.target = { U: 5, dirW: 0, tp: 5, hsW: 0.5, hsS: 0, swellT: 11, dirS: 0 };
    this.cur = null; this.norm = null; this.normAt = -1; this.normKey = null; this.cache = null; this.t = 0;
    const mk = (frag, uniforms) => new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: PASS_VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false });
    this.evolveU = { uN: { value: n }, uL: { value: new THREE.Vector3(...FFT_L) }, uLo: { value: new THREE.Vector3() }, uHi: { value: new THREE.Vector3() }, uBoost: { value: new THREE.Vector3(1, 1, 1) }, uWindS: { value: new THREE.Vector4() }, uSwellS: { value: new THREE.Vector4() }, uT: { value: 0 } };
    this.fftU = { uSrc: { value: null }, uN: { value: n }, uS: { value: 2 }, uVert: { value: 0 } };
    this.asmU = { uSrc: { value: null }, uN: { value: n }, uC: { value: 0 }, uMode: { value: 0 }, uChop: { value: 1 } };
    this.probeU = { uD: { value: null }, uT1: { value: null }, uT2: { value: null }, uLast: { value: 0 }, uN: { value: n }, uHs: { value: 1 } };
    this.mats = { evolve: mk(EVOLVE_FRAG, this.evolveU), fft: mk(FFT_FRAG, this.fftU), asm: mk(ASSEMBLE_FRAG, this.asmU), probe: mk(PROBE_FRAG, this.probeU) };
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.quad = new THREE.Mesh(tri, this.mats.evolve); this.quad.frustumCulled = false;
    this.scene = new THREE.Scene(); this.scene.add(this.quad);
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.atlas = null; this.out = null;
    this.setSize(n, cascades);
  }
  /** Change the FFT size / cascade count (governor); reallocates only on a change. */
  setSize(n, nc) {
    n = n >= 256 ? 256 : 128; nc = Math.max(1, Math.min(3, nc | 0));
    if (n === this.n && nc === this.nc) return false;
    this.disposeTargets();
    this.n = n; this.nc = nc; this.cache = null; this.normKey = null;
    const fl = { depthBuffer: false, stencilBuffer: false, type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false };
    this.atlas = [new THREE.WebGLRenderTarget(2 * nc * n, n, fl), new THREE.WebGLRenderTarget(2 * nc * n, n, fl)];
    let aniso = 1; try { aniso = Math.min(8, this.r.capabilities.getMaxAnisotropy()); } catch { /* none */ }
    const ho = { depthBuffer: false, stencilBuffer: false, type: THREE.HalfFloatType, format: THREE.RGBAFormat, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false, anisotropy: aniso };
    // the cascades are LAYERS of three array textures (one sampler each in the sea shader: a program's texture units
    // are shared by both stages and the sun-shadow chunk, 16 on many GPUs): d = vertex displacement [c0, c1],
    // t1 = slopes + Jacobian [c0, c1] / slopes + second moments [c2], t2 = jxz, height, second moments [c0, c1].
    // Mipmaps are generated by hand (three r160 only mips 2D / cube render targets).
    // (three r160's WebGLArrayRenderTarget ignores the texture options: its DataArrayTexture is 8-bit, nearest, clamped
    // unless they are set on the texture itself)
    const mkA = (layers) => {
      const t = new THREE.WebGLArrayRenderTarget(n, n, layers, ho), x = t.texture;
      x.type = THREE.HalfFloatType; x.format = THREE.RGBAFormat; x.wrapS = x.wrapT = THREE.RepeatWrapping; x.wrapR = THREE.ClampToEdgeWrapping;
      x.minFilter = THREE.LinearMipmapLinearFilter; x.magFilter = THREE.LinearFilter; x.anisotropy = aniso; x.generateMipmaps = false;
      return t;
    };
    this.out = { d: mkA(2), t1: mkA(3), t2: mkA(2) };
    for (const u of [this.evolveU, this.fftU, this.asmU, this.probeU]) u.uN.value = n;
    this.frames = 0;
    return true;
  }
  /** Bytes of render targets currently allocated. */
  get memoryBytes() { return fftMemoryBytes(this.n, this.nc); }
  /** Target sea (eased toward over a few seconds): { U, dirW (deg travel), tp, hsW, hsS, swellT, dirS }. */
  setSea(p) { Object.assign(this.target, p); if (!this.cur) this.cur = { ...this.target }; }
  /** Jump to the target sea at once (first contact, teleport): no easing, renormalised on the next step. */
  snap() { this.cur = null; this.norm = null; }
  /** Patch size (m) of cascade c and its texel size. */
  L(c) { return FFT_L[c]; }
  texel(c) { return FFT_L[c] / this.n; }
  /** Ease the live parameters toward the target and renormalise (≤ 2 Hz, only when they moved; ~4 ms of CPU each). */
  ease(dt) {
    const T = this.target;
    if (!this.cur) this.cur = { ...T };
    const C = this.cur, k = 1 - Math.exp(-Math.max(0, dt) / 2.5);
    for (const key of ['U', 'tp', 'hsW', 'hsS', 'swellT']) C[key] += ((T[key] ?? C[key]) - C[key]) * k;
    for (const key of ['dirW', 'dirS']) { const d = ((((T[key] ?? C[key]) - C[key]) % 360) + 540) % 360 - 180; C[key] += d * k; }
    const key = [C.U, C.tp, C.hsW, C.hsS, C.swellT, C.dirW, C.dirS];
    const moved = !this.normKey || key.some((v, i) => Math.abs(v - this.normKey[i]) > (i >= 5 ? 0.2 : 0.003 * Math.max(0.1, Math.abs(this.normKey[i]))));
    this.normAt += dt;
    if (!this.norm || (moved && this.normAt >= 0.5)) {
      this.norm = fftNormalise(C, this.n, this.nc, this.cache);
      this.cache = this.norm.cache; this.normKey = key; this.normAt = 0;
    }
    return this.norm;
  }
  /** One frame: evolve the spectra to time t, inverse FFT, assemble the cascade textures. */
  step(dt, time) {
    const r = this.r, N = this.norm && this.cur ? this.ease(dt) : this.ease(0);
    const n = this.n, nc = this.nc, eu = this.evolveU, B = N.bands;
    eu.uLo.value.set(B[0][0], B[1][0], B[2][0]); eu.uHi.value.set(B[0][1], B[1][1], B[2][1]);
    eu.uBoost.value.set(1, 1, N.boost);
    // between renormalisations (2 Hz) the eased heights / period / directions still move every frame: the energy scales
    // with Hs² exactly, the shape normalisation lags by < 0.5 s (no stepping while the sea builds or the wind veers)
    const C = this.cur, P = N.p, kW = P.hsW > 1e-6 ? (C.hsW / P.hsW) ** 2 : 0, kS = P.hsS > 1e-6 ? (C.hsS / P.hsS) ** 2 : 0;
    const [dxW, dzW] = travelVec(C.dirW), [dxS, dzS] = travelVec(C.dirS ?? C.dirW);
    eu.uWindS.value.set(N.aW * kW, TAU / Math.max(1.2, C.tp || 5), dxW, dzW);
    eu.uSwellS.value.set(N.wpS > 0 ? N.aS * kS : 0, N.wpS > 0 ? TAU / Math.max(2, C.swellT || 11) : 1, dxS, dzS);
    this.t = ((time % T_REP) + T_REP) % T_REP; eu.uT.value = this.t;
    const prevRT = r.getRenderTarget(), ac = r.autoClear, xr = r.xr ? r.xr.enabled : false;
    try {
      if (r.xr) r.xr.enabled = false;
      r.autoClear = false;
      let src = 0;
      this.pass(this.mats.evolve, this.atlas[0]);
      for (const vert of [0, 1]) for (let S = 2; S <= n; S *= 2) {
        this.fftU.uSrc.value = this.atlas[src].texture; this.fftU.uS.value = S; this.fftU.uVert.value = vert;
        this.pass(this.mats.fft, this.atlas[1 - src]); src = 1 - src;
      }
      const au = this.asmU; au.uSrc.value = this.atlas[src].texture;
      for (let c = 0; c < nc; c++) {
        au.uC.value = c; au.uChop.value = c < 2 ? N.chop[c] : 0;
        const o = this.out;
        if (c < 2) { au.uMode.value = 0; this.pass(this.mats.asm, o.d, c); au.uMode.value = 1; this.pass(this.mats.asm, o.t1, c); au.uMode.value = 2; this.pass(this.mats.asm, o.t2, c); }
        else { au.uMode.value = 3; this.pass(this.mats.asm, o.t1, c); }
      }
    } finally {
      r.setRenderTarget(prevRT); r.autoClear = ac; if (r.xr) r.xr.enabled = xr;
    }
    for (const t of Object.values(this.out)) this.mips(t);
    this.frames++;
    return N;
  }
  pass(mat, rt, layer = 0) { this.quad.material = mat; this.r.setRenderTarget(rt, layer); this.r.render(this.scene, this.cam); }
  /** Mip chain of an array render target (all layers). */
  mips(rt) {
    const r = this.r, gl = r.getContext(), tex = r.properties.get(rt.texture).__webglTexture;
    if (!tex) return;
    r.state.bindTexture(gl.TEXTURE_2D_ARRAY, tex); gl.generateMipmap(gl.TEXTURE_2D_ARRAY); r.state.unbindTexture();
  }
  /** Self-test after a step: all outputs finite and bounded, the height field not flat (when there is a sea). */
  probe(hsExpect = 1) {
    const r = this.r;
    if (!this.out || !this.frames) return { ok: false, why: 'no FFT frame yet' };
    const p = this.probeU;
    p.uD.value = this.out.d.texture; p.uT1.value = this.out.t1.texture; p.uT2.value = this.out.t2.texture; p.uLast.value = this.nc - 1; p.uHs.value = Math.max(0.05, hsExpect);
    if (!this.probeRT) this.probeRT = new THREE.WebGLRenderTarget(4, 4, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false, generateMipmaps: false });
    const px = new Uint8Array(64), prevRT = r.getRenderTarget();
    try { this.pass(this.mats.probe, this.probeRT); r.readRenderTargetPixels(this.probeRT, 0, 0, 4, 4, px); } finally { r.setRenderTarget(prevRT); }
    for (const m of ['evolve', 'fft', 'asm', 'probe']) {
      const prog = r.properties.get(this.mats[m])?.currentProgram;
      if (prog && prog.diagnostics && prog.diagnostics.runnable === false) return { ok: false, why: `${m} pass failed to link: ` + String(prog.diagnostics.programLog || prog.diagnostics.fragmentShader?.log || '').slice(0, 300) };
    }
    let bad = 0, lo = 255, hi = 0;
    for (let i = 0; i < 16; i++) { if (px[i * 4] < 200 || px[i * 4 + 2] < 200) bad++; lo = Math.min(lo, px[i * 4 + 1]); hi = Math.max(hi, px[i * 4 + 1]); }
    if (bad) return { ok: false, why: `${bad}/16 probe texels NaN / out of range` };
    // a real sea has crests AND troughs: an 8-bit / clamped target (no negative values) or a flat field fails here
    if (hsExpect > 0.1 && (hi - lo < 3 || lo > 125 || hi < 131)) return { ok: false, why: `height field flat or one-signed (probe ${lo}..${hi})` };
    return { ok: true, why: '' };
  }
  disposeTargets() {
    if (this.atlas) this.atlas.forEach((t) => t.dispose());
    if (this.out) for (const t of Object.values(this.out)) t.dispose();
    this.atlas = null; this.out = null;
  }
  dispose() {
    this.disposeTargets();
    if (this.probeRT) this.probeRT.dispose();
    Object.values(this.mats).forEach((m) => m.dispose());
    this.quad.geometry.dispose();
  }
}
