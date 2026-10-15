// Ship wake simulation: a ship-centred, dispersive (deep-water) wave field on a GPU render target, FluidNinja-style.
//
// Model: Tessendorf's iWave. The free surface h obeys  h_tt = −g·𝒢(h + P) − α·h_t,  where 𝒢 is the vertical-derivative
// operator (|k| in Fourier space, so every wavelength travels at its own deep-water speed: ω² = g·k — this dispersion
// is what turns a moving disturbance into a Kelvin wake with its 19.47° cusps, transverse and divergent waves) and P is
// the hull's pressure head: the waterline footprint of each ship pushed down by a fraction of its draft. A static
// ship settles into a hole of depth P (hidden by the hull; the ocean shader draws h + P, i.e. only the dynamic part),
// a moving ship radiates the bow wave, the hull-side trough and the Kelvin wake; a ship that stops leaves ripples that
// keep running and settle. 𝒢 is a 13×13 real-space kernel (radius 6 texels) fitted to k·exp(−σk²) by an inverse
// lattice transform, DC removed; it is baked into the GLSL as constants. Leapfrog in time at a fixed step (≤ 1/60 s,
// ≤ 3 steps per frame: time warp / hitches never feed a big dt into it), plus a touch of viscosity on texel-scale noise.
// A finite kernel follows |k| only for wavelengths of ~4–10 texels (it is calibrated there, K.cal); longer waves
// travel too slowly. So the sim is the NEAR field (bow wave, hull-side trough, transverse waves, stern churn, ripples
// of a stopped ship, ships' wakes crossing) and its waves are damped away beyond a ship length from every hull; the
// far Kelvin wake is analytic in the ocean shader (ocean2.js kelvinWakes), which takes over where the sim fades.
//
// Domain: N×N texels over L = 5 ship lengths (200–800 m), centred on the player's ship and scrolled by whole texels
// (the content is copied with the integer offset; the ship's pressure moves continuously), with a sponge rim.
// Channels: r = h(n+1), g = h(n), b = P(n+1), a = foam (turbulent wash behind the stern, hull-contact foam, breaking
// on steep wake crests), which persists for ~half a minute on the water where it formed and diffuses slowly.
//
// Needs a float/half-float colour render target (WebGL2 + EXT_color_buffer_(half_)float); `WakeSim.supported(renderer)`
// says whether it can run, and the caller simply does not create it otherwise (the ocean then draws only its analytic
// Kelvin wake). GPU cost: N² × ~140 texture fetches per step at 60 Hz (N = 384: ≈ 1.2 G fetches/s, ~0.3 ms on a desktop
// dGPU, ~1–1.5 ms on an integrated GPU); memory 2 × N² × 8 bytes (N = 384: 2.4 MB).
import * as THREE from 'three';

const G = 9.81;
export const WAKE_MAX_SHIPS = 4;

// ------------------------------------------------------------------------------------------------ pure helpers
/**
 * Real-space kernel of the vertical-derivative operator 𝒢 on a unit lattice: target response T(k) = k·exp(−σk²)
 * (k in rad/texel), truncated to radius R with a smooth window and with its DC response forced to 0.
 * Returns { R, sigma, taps: [{ i, j, w, n }] } with 0 ≤ j ≤ i, n = number of symmetric copies.
 */
export function buildWaveKernel(R = 6, sigma = 0.2, M = 64) {
  const T = (k) => k * Math.exp(-sigma * k * k);
  const taps = [];
  const cosT = [];
  for (let n = 0; n < M; n++) cosT.push((2 * Math.PI * (n - M / 2)) / M);
  for (let i = 0; i <= R; i++) for (let j = 0; j <= i; j++) {
    const r = Math.hypot(i, j);
    if (r > R + 0.5) continue;
    let w = 0;
    for (let a = 0; a < M; a++) for (let b = 0; b < M; b++) {
      const kx = cosT[a], kz = cosT[b];
      w += T(Math.hypot(kx, kz)) * Math.cos(kx * i) * Math.cos(kz * j);
    }
    w /= M * M;
    const r0 = R - 2, win = r <= r0 ? 1 : 0.5 * (1 + Math.cos((Math.PI * (r - r0)) / (R + 0.5 - r0)));
    const n = i === 0 && j === 0 ? 1 : j === 0 || i === j ? 4 : 8;
    taps.push({ i, j, w: w * win, n });
  }
  let s = 0;
  for (const t of taps) if (t.i || t.j) s += t.w * t.n;
  taps[0].w = -s; // Σ G = 0: a uniform raise of the water is not a wave
  const K = { R, sigma, taps, cal: 1 };
  // a finite kernel cannot follow |k| at long wavelengths (the operator is non-local: its 1/r³ tail is cut), so the
  // sim is run where it is good — wavelengths of ~4–10 texels — and calibrated there: cal·R(k) ≈ k on that band
  let acc = 0, cnt = 0;
  for (let k = 0.6; k <= 1.6001; k += 0.1) { acc += kernelResponse(K, k, 0) / k; cnt++; }
  K.cal = cnt / acc;
  return K;
}
/** The kernel's actual response to the plane wave e^{i k·x} (k in rad/texel). */
export function kernelResponse(K, kx, kz) {
  let r = 0;
  for (const t of K.taps) {
    const { i, j, w } = t;
    if (!i && !j) { r += w; continue; }
    const offs = symOffsets(i, j);
    for (const [a, b] of offs) r += w * Math.cos(kx * a + kz * b);
  }
  return r;
}
function symOffsets(i, j) {
  const set = new Map();
  for (const [a, b] of [[i, j], [j, i]]) for (const sa of [1, -1]) for (const sb of [1, -1]) set.set(`${sa * a},${sb * b}`, [sa * a, sb * b]);
  return [...set.values()];
}
/** Largest response of the kernel over the Brillouin zone (sets the stable time step). */
export function kernelMaxResponse(K, steps = 48) {
  let m = 0;
  for (let a = 0; a <= steps; a++) for (let b = 0; b <= a; b++) m = Math.max(m, kernelResponse(K, (Math.PI * a) / steps, (Math.PI * b) / steps));
  return m;
}
/** Leapfrog coefficients for one step of dt seconds on texels of dx metres with damping alpha (1/s). */
export function stepCoefficients(dt, dx, alpha = 0.04, cal = 1) {
  const d = 1 + alpha * dt;
  return { c1: (2 - alpha * dt) / d, c2: 1 / d, c3: ((G * cal / dx) * dt * dt) / d };
}
/** Per-step pull of the water under a hull toward the hull bottom (the hull is an obstacle, not a pressure that sloshes). */
export const HULL_RELAX = 0.15;
/** Per-step damping factor far from every hull (rate 0.5/s). */
export function farDamp(dt) { return 1 - Math.exp(-0.5 * dt); }
/** Largest stable step (s) for texels of dx metres (ω_max·dt ≤ 1.4, well inside the leapfrog limit of 2). */
export function maxStableDt(K, dx) { return 1.4 / Math.sqrt(((G * (K.cal || 1)) / dx) * kernelMaxResponse(K)); }

/** Hull waterline footprint 0..1 at hull-local (a, c) in units of half length / half beam (a = +1 bow). */
export function hullShape(a, c) {
  const taper = 1 - 0.55 * Math.max(a, 0) ** 2 - 0.25 * Math.max(-a, 0) ** 2;
  const cc = c / Math.max(taper, 0.2);
  const s = Math.max(0, 1 - a * a) * Math.max(0, 1 - cc * cc);
  return s * s;
}
/** Pressure head (m) a hull of this draft presses into the sim: a fraction of the draft, capped (it is a surface patch, not a 3-D hull). */
export function hullHead(draft, beam) { return Math.min(0.5 * Math.max(0.3, draft || 2), 0.35 * Math.max(2, beam || 6), 5); }

/**
 * CPU reference of one GPU step (same scheme; used by the tests to check stability, dispersion and the wake shape).
 * state = { n, dx, h, hp, P } (Float64Array n²); ships = [{ x, z, fx, fz, hl, hb, head }] in metres from the domain corner.
 */
export function stepCPU(state, K, ships, dt, alpha = 0.04) {
  const { n, dx } = state, h = state.h, hp = state.hp, P = state.P;
  const { c1, c2, c3 } = stepCoefficients(dt, dx, alpha, K.cal), fd = farDamp(dt);
  const hn = new Float64Array(n * n), Pn = new Float64Array(n * n), hpN = new Float64Array(n * n), S = new Float64Array(n * n);
  for (let o = 0; o < n * n; o++) S[o] = h[o] + P[o];
  const oa = [], ob = [], ow = [];
  for (const t of K.taps) for (const [a, b] of (!t.i && !t.j ? [[0, 0]] : symOffsets(t.i, t.j))) { oa.push(a); ob.push(b); ow.push(t.w); }
  const nt = ow.length;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    let conv = 0;
    for (let t = 0; t < nt; t++) {
      let ii = i + oa[t], jj = j + ob[t];
      ii = ii < 0 ? 0 : ii >= n ? n - 1 : ii; jj = jj < 0 ? 0 : jj >= n ? n - 1 : jj;
      conv += ow[t] * S[jj * n + ii];
    }
    const o = j * n + i;
    let h1 = h[o] * c1 - hp[o] * c2 - c3 * conv;
    const nb = (ii, jj) => S[Math.min(n - 1, Math.max(0, jj)) * n + Math.min(n - 1, Math.max(0, ii))];
    h1 += 0.012 * (0.25 * (nb(i + 1, j) + nb(i - 1, j) + nb(i, j + 1) + nb(i, j - 1)) - S[o]);
    const e = Math.min(i + 0.5, j + 0.5, n - i - 0.5, n - j - 0.5) / n;
    const damp = 0.92 + 0.08 * smooth(0, 0.07, e);
    hn[o] = h1 * damp; hpN[o] = h[o] * damp;
    const px = (i + 0.5) * dx, pz = (j + 0.5) * dx;
    let p = 0, near = 99, hull = 0;
    for (const s of ships) {
      const ddx = px - s.x, ddz = pz - s.z, sh = hullShape((ddx * s.fx + ddz * s.fz) / s.hl, (s.fx * ddz - s.fz * ddx) / s.hb);
      p += s.head * sh; hull = Math.max(hull, sh);
      near = Math.min(near, Math.hypot(ddx, ddz) / s.hl);
    }
    Pn[o] = p;
    hn[o] += HULL_RELAX * hull * (-p - hn[o]);
    const far = 1 - fd * smooth(2, 5, near);
    hn[o] *= far; hpN[o] *= far;
  }
  state.h = hn; state.hp = hpN; state.P = Pn;
  return state;
}
function smooth(e0, e1, x) { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }

// ------------------------------------------------------------------------------------------------ GLSL
function fmt(v) { const s = v.toPrecision(9); return /[.eE]/.test(s) ? s : `${s}.0`; }
/** The convolution as unrolled GLSL (symmetric taps summed first, one multiply per distinct weight). */
export function convolutionGLSL(K) {
  const lines = [];
  for (const t of K.taps) {
    const o = !t.i && !t.j ? [[0, 0]] : symOffsets(t.i, t.j);
    const terms = o.map(([a, b]) => (a || b ? `HP(src + vec2(${fmt(a)}, ${fmt(b)}) * uTexel)` : 'HP(src)'));
    lines.push(`  conv += ${fmt(t.w)} * (${terms.join(' + ')});`);
  }
  return lines.join('\n');
}

const STEP_VERT = /* glsl */`varying vec2 vUv; void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const stepFrag = (K) => /* glsl */`
uniform sampler2D uPrev; uniform vec2 uShift; uniform float uTexel; uniform float uL; uniform float uDx;
uniform float uC1; uniform float uC2; uniform float uC3; uniform float uFarDamp; uniform float uDt; uniform float uSeed; uniform float uFoamDecay;
uniform vec4 uShA[${WAKE_MAX_SHIPS}]; uniform vec4 uShB[${WAKE_MAX_SHIPS}]; uniform vec4 uShC[${WAKE_MAX_SHIPS}]; uniform float uShN;
varying vec2 vUv;
float HP(vec2 uv) { vec4 t = texture2D(uPrev, uv); return t.r + t.b; }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y); }
void main() {
  vec2 src = vUv + uShift;                                         // where this water was in the previous frame
  float inside = step(0.0, src.x) * step(src.x, 1.0) * step(0.0, src.y) * step(src.y, 1.0);
  vec4 c = texture2D(uPrev, src) * inside;
  float conv = 0.0;
${convolutionGLSL(K)}
  conv *= inside;
  float h1 = c.r * uC1 - c.g * uC2 - uC3 * conv;
  vec2 tx = vec2(uTexel, 0.0), tz = vec2(0.0, uTexel);
  float hx1 = HP(src + tx), hx0 = HP(src - tx), hz1 = HP(src + tz), hz0 = HP(src - tz);
  h1 += 0.012 * (0.25 * (hx1 + hx0 + hz1 + hz0) - (c.r + c.b)) * inside;   // a little viscosity: texel-scale noise dies out
  vec2 ed = min(vUv, 1.0 - vUv);
  float damp = 0.92 + 0.08 * smoothstep(0.0, 0.07, min(ed.x, ed.y));  // sponge rim: outgoing waves are absorbed
  h1 *= damp;
  float hn = c.r * damp;
  vec2 p = vUv * uL;                                                // metres from the domain corner
  float P = 0.0, fsrc = 0.0, kick = 0.0, near = 99.0, hull = 0.0;
  for (int i = 0; i < ${WAKE_MAX_SHIPS}; i++) {
    if (float(i) < uShN) {
      vec4 A = uShA[i]; vec4 B = uShB[i]; vec4 C = uShC[i];       // A: x, z, fwd.x, fwd.z  B: half length, half beam, head, prop wash  C: speed foam
      vec2 d = p - A.xy;
      float a = dot(d, A.zw) / B.x;                                 // +1 bow … −1 stern
      float cs = (A.z * d.y - A.w * d.x) / B.y;                     // ±1 at the sides
      float ap = max(a, 0.0), am = max(-a, 0.0);
      float cc = cs / max(1.0 - 0.55 * ap * ap - 0.25 * am * am, 0.2);
      float hs = clamp(1.0 - a * a, 0.0, 1.0) * clamp(1.0 - cc * cc, 0.0, 1.0);
      P += B.z * hs * hs;
      hull = max(hull, hs * hs);
      near = min(near, length(d) / B.x);
      // hull-contact foam along the sides, strongest at the bow shoulders
      float side = smoothstep(0.7, 1.0, abs(cc)) * (1.0 - smoothstep(1.05, 1.7, abs(cc))) * (1.0 - smoothstep(0.95, 1.15, abs(a)));
      fsrc += C.x * side * (0.35 + 0.65 * smoothstep(-0.3, 0.8, a));
      // stern wash / propeller race: a turbulent, widening band right behind the stern
      float xs = max(0.0, (-a - 1.0) * B.x);                        // metres behind the stern
      float behind = 1.0 - smoothstep(-1.08, -0.92, a);
      float w = B.y * 0.85 + xs * 0.1;
      float band = behind * (1.0 - smoothstep(0.55 * w, w, abs(cs) * B.y)) * exp(-xs / (4.0 * B.y + 25.0));
      fsrc += B.w * band;
      kick += B.w * band * (vnoise(p * 0.3 + uSeed * 13.7) - 0.5) * 0.04 * exp(-xs / (2.0 * B.y + 8.0));   // churn: smooth, metre-scale
    }
  }
  h1 = mix(h1, -P, ${HULL_RELAX} * hull);                          // the water under a hull follows the hull bottom
  h1 += kick;
  // the near field is the sim's job; further than a ship length from every hull its waves are damped away (the
  // ocean shader's analytic Kelvin wake takes over there)
  float far = 1.0 - uFarDamp * smoothstep(2.0, 5.0, near);
  h1 *= far; hn *= far;
  // foam: decays, diffuses a little, born from the ships and from steep (breaking) wake crests
  float fa = 0.25 * (texture2D(uPrev, src + tx).a + texture2D(uPrev, src - tx).a + texture2D(uPrev, src + tz).a + texture2D(uPrev, src - tz).a);
  float f = mix(c.a, fa * inside, 0.18) * uFoamDecay;
  vec2 g = vec2(hx1 - hx0, hz1 - hz0) / (2.0 * uDx);
  f += smoothstep(0.3, 0.65, length(g)) * uDt * 2.5;
  f += fsrc * uDt * 1.6;
  f = clamp(f, 0.0, 1.0) * smoothstep(0.0, 0.03, min(ed.x, ed.y));
  gl_FragColor = vec4(clamp(h1, -8.0, 8.0), clamp(hn, -8.0, 8.0), P, f);
}`;

// ------------------------------------------------------------------------------------------------ GPU sim
export class WakeSim {
  /** Can this renderer run the simulation (float colour targets that are framebuffer-complete)? */
  static supported(renderer) {
    try {
      const caps = renderer?.capabilities;
      if (!caps || !caps.isWebGL2 || caps.precision !== 'highp') return false;
      const ext = renderer.extensions;
      return !!(ext && (ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float')));
    } catch { return false; }
  }
  /** n = texels per side; the domain size follows the ship (setShipLength). */
  constructor(renderer, n = 384) {
    this.renderer = renderer; this.n = n; this.ok = false;
    this.K = buildWaveKernel(6, 0.2);
    this.L = 250; this.dx = this.L / n;
    this.origin = null;            // domain corner in texels (invariant frame)
    this.acc = 0; this.ramp = 0; this.time = 0; this.seed = 0;
    const opt = { depthBuffer: false, stencilBuffer: false, type: THREE.HalfFloatType, format: THREE.RGBAFormat, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter, generateMipmaps: false };
    this.rt = [new THREE.WebGLRenderTarget(n, n, opt), new THREE.WebGLRenderTarget(n, n, opt)];
    this.idx = 0;
    const sh = () => Array.from({ length: WAKE_MAX_SHIPS }, () => new THREE.Vector4());
    this.uniforms = {
      uPrev: { value: null }, uShift: { value: new THREE.Vector2() }, uTexel: { value: 1 / n }, uL: { value: this.L }, uDx: { value: this.dx },
      uC1: { value: 2 }, uC2: { value: 1 }, uC3: { value: 0 }, uFarDamp: { value: 0 }, uDt: { value: 1 / 60 }, uSeed: { value: 0 }, uFoamDecay: { value: 1 },
      uShA: { value: sh() }, uShB: { value: sh() }, uShC: { value: sh() }, uShN: { value: 0 },
    };
    this.scene = new THREE.Scene();
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.mat = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: STEP_VERT, fragmentShader: stepFrag(this.K), depthTest: false, depthWrite: false });
    const q = new THREE.Mesh(tri, this.mat); q.frustumCulled = false; this.scene.add(q);
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.maxDtFor = (dx) => maxStableDt(this.K, dx);
    // framebuffer completeness + a first clear: a target the driver cannot render into turns the sim off
    try {
      const gl = renderer.getContext();
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(this.rt[0]);
      const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      renderer.setRenderTarget(prev);
      this.ok = st === gl.FRAMEBUFFER_COMPLETE;
      if (!this.ok) console.warn('[ocean] wake simulation off: float render target incomplete', st);
    } catch (e) { this.ok = false; console.warn('[ocean] wake simulation off', e); }
    if (this.ok) this.clear();
  }
  get texture() { return this.rt[this.idx].texture; }
  /** Domain size for a player ship of this length (m): 5 lengths, 200–800 m. Changing it restarts the field. */
  setShipLength(len) {
    const L = Math.min(800, Math.max(200, 5 * (Number(len) || 40)));
    if (Math.abs(L - this.L) < 1) return;
    this.L = L; this.dx = L / this.n; this.origin = null;
    this.uniforms.uL.value = L; this.uniforms.uDx.value = this.dx;
  }
  clear() {
    const r = this.renderer, prev = r.getRenderTarget(), cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    for (const t of this.rt) { r.setRenderTarget(t); r.clear(true, false, false); }
    r.setRenderTarget(prev); r.setClearColor(cc, ca);
    this.ramp = 0; this.acc = 0;
  }
  /**
   * Advance by dt seconds (real time). centre = the player's ship {x, z} (invariant metres); ships = up to
   * WAKE_MAX_SHIPS { x, z, fx, fz, len, beam, draft, spd (m/s), wash 0..1, x0, z0 (position at the start of dt) }.
   * Returns false when the field was reset (teleport / time warp: the ship jumped further than the domain can follow).
   */
  step(dt, centre, ships) {
    if (!this.ok || !centre) return false;
    const n = this.n, dx = this.dx;
    const ox = Math.round(centre.x / dx) - n / 2, oz = Math.round(centre.z / dx) - n / 2;
    if (!this.origin || Math.abs(ox - this.origin.x) > n / 3 || Math.abs(oz - this.origin.z) > n / 3 || dt > 0.5) {
      if (this.origin) this.clear();
      this.origin = { x: ox, z: oz }; this.acc = 0; this._lastCentre = { x: centre.x, z: centre.z };
      return false;
    }
    const sdt = Math.min(1 / 60, this.maxDtFor(dx));
    this.acc += Math.min(dt, 0.1);
    let steps = Math.floor(this.acc / sdt);
    if (steps > 3) { steps = 3; this.acc = 0; } else this.acc -= steps * sdt;
    if (!steps) return true;
    const u = this.uniforms, { c1, c2, c3 } = stepCoefficients(sdt, dx, 0.04, this.K.cal);
    u.uC1.value = c1; u.uC2.value = c2; u.uC3.value = c3; u.uFarDamp.value = farDamp(sdt); u.uDt.value = sdt; u.uTexel.value = 1 / n;
    u.uFoamDecay.value = Math.exp(-sdt / 32);
    const r = this.renderer, prevRT = r.getRenderTarget(), xr = r.xr ? r.xr.enabled : false;
    if (r.xr) r.xr.enabled = false;
    for (let s = 1; s <= steps; s++) {
      const f = s / steps;
      // per substep: the domain follows the interpolated ship by whole texels
      const cx = (this._lastCentre ? this._lastCentre.x + (centre.x - this._lastCentre.x) * f : centre.x);
      const cz = (this._lastCentre ? this._lastCentre.z + (centre.z - this._lastCentre.z) * f : centre.z);
      const nx = Math.round(cx / dx) - n / 2, nz = Math.round(cz / dx) - n / 2;
      u.uShift.value.set((nx - this.origin.x) / n, (nz - this.origin.z) / n);
      this.origin.x = nx; this.origin.z = nz;
      this.ramp = Math.min(1, this.ramp + sdt / 3);       // a hull that appears does not slam a ring wave out
      const X0 = this.origin.x * dx, Z0 = this.origin.z * dx;
      let k = 0;
      for (const sh of ships) {
        if (k >= WAKE_MAX_SHIPS) break;
        const px = sh.x0 + (sh.x - sh.x0) * f - X0, pz = sh.z0 + (sh.z - sh.z0) * f - Z0;
        const hl = Math.max(2, sh.len / 2), hb = Math.max(1, sh.beam / 2);
        if (px < -hl || pz < -hl || px > this.L + hl || pz > this.L + hl) continue;
        u.uShA.value[k].set(px, pz, sh.fx, sh.fz);
        u.uShB.value[k].set(hl, hb, hullHead(sh.draft, sh.beam) * this.ramp, Math.min(1, sh.wash || 0));
        u.uShC.value[k].set(smooth(1.5, 7, Math.abs(sh.spd || 0)), 0, 0, 0);
        k++;
      }
      u.uShN.value = k;
      this.seed = (this.seed + 7.13) % 997; u.uSeed.value = this.seed;
      u.uPrev.value = this.rt[this.idx].texture;
      r.setRenderTarget(this.rt[1 - this.idx]);
      r.render(this.scene, this.cam);
      this.idx = 1 - this.idx;
    }
    r.setRenderTarget(prevRT);
    if (r.xr) r.xr.enabled = xr;
    this._lastCentre = { x: centre.x, z: centre.z };
    return true;
  }
  /** Domain corner (invariant metres) and size, for the ocean shader. */
  rect() { return this.origin ? { x: this.origin.x * this.dx, z: this.origin.z * this.dx, L: this.L } : null; }
  dispose() { this.rt.forEach((t) => t.dispose()); this.mat.dispose(); this.scene.children[0].geometry.dispose(); }
}
