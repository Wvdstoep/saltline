// Ocean: a camera-following, centre-dense grid displaced by ten Gerstner components (8 wind-sea components whose
// directions cluster around the wave direction + 2 long swell components) in the vertex shader, plus a coarse far ring
// out to the fog. Component wavelengths sit on a fixed non-integer ladder; the sea state (significant wave height,
// peak period, directions, swell) only moves AMPLITUDES and DIRECTIONS, so a changing forecast never makes the wave
// field slide. The fragment shader adds two octaves of scrolling procedural normal detail, Schlick fresnel, a
// roughness-dependent sun lobe, sky reflection, crest subsurface, whitecaps above 8 m/s, shore foam from a CPU-built
// depth texture, rain ripples, night darkening and the usual three.js tone-mapping / fog tail. The CPU `heightAt` sums
// exactly the same component table (Gerstner vertical part) so ships, wakes and the camera ride the same water.
import * as THREE from 'three';

const G = 9.81;
const NW = 10;
/** fixed wavelength ladder (m): 8 wind-sea slots + 2 swell slots; ratios are non-integer so nothing tiles */
const LADDER = [350, 208, 124, 74, 44, 26.2, 15.6, 9.3, 310, 190];
/** direction offsets (deg) of each slot from the travel direction of its family; shorter waves spread more */
const DIR_OFF = [0, 17, -13, 29, -24, 9, -34, 21, 0, 11];

/** Live component table (shared with ship.js for wake surface tracking). dx/dz = travel direction, amp (m), k, w, q (steepness), ph (phase offset). */
export const WAVES = LADDER.map((len, i) => ({ dx: 0, dz: -1, amp: 0, len, k: (2 * Math.PI) / len, w: Math.sqrt((G * 2 * Math.PI) / len), q: 0, ph: i * 1.7, ang: 0 }));
/** Mirror of the ocean's time / tide level for modules that only know world xz (wakes). */
export const oceanState = { time: 0, level: 0, hs: 0.8, wind: 5, windDir: 240 };

/** Gerstner vertical part of the surface at world (x, z) — tide level NOT included (see Ocean.heightAt). */
export function waveHeight(x, z, t, windF = 1) {
  let h = 0;
  for (let i = 0; i < NW; i++) { const w = WAVES[i]; if (w.amp === 0) continue; h += w.amp * windF * Math.sin((w.dx * x + w.dz * z) * w.k - w.w * t + w.ph); }
  return h;
}
/** Surface height including the tide level, at the ocean's current time. */
export function surfaceHeightAt(x, z, t = oceanState.time) { return oceanState.level + waveHeight(x, z, t, 1); }

const VERT = /* glsl */`
#define NW 10
uniform float uTime; uniform float uFadeIn; uniform float uFadeOut; uniform float uCellK; uniform float uCell0;
uniform vec4 uWaveA[NW]; // dx, dz, amp, k
uniform vec4 uWaveB[NW]; // w, Q, phase, wavelength
varying vec3 vWorld; varying vec3 vNormal; varying float vHeight; varying float vCrest; varying float vFade;
#include <fog_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec2 p = wp.xz;
  float r = length(position.xz);
  float fade = 1.0 - smoothstep(uFadeIn, uFadeOut, r);
  // local grid cell size (the near grid is centre-dense): components shorter than ~2 cells are faded per vertex
  float cell = uCell0 + uCellK * r * r;
  vec3 disp = vec3(0.0); vec3 nrm = vec3(0.0, 1.0, 0.0); float crest = 0.0;
  for (int i = 0; i < NW; i++) {
    vec2 D = uWaveA[i].xy; float k = uWaveA[i].w;
    float A = uWaveA[i].z * fade * smoothstep(cell * 1.2, cell * 2.6, uWaveB[i].w);
    float Q = uWaveB[i].y;
    float th = dot(D, p) * k - uWaveB[i].x * uTime + uWaveB[i].z;
    float s = sin(th), c = cos(th);
    disp.xz += D * (Q * A * c);
    disp.y += A * s;
    float kA = k * A;
    nrm.x -= D.x * kA * c;
    nrm.z -= D.y * kA * c;
    nrm.y -= Q * kA * s;
    crest += Q * kA * s;
  }
  vNormal = normalize(nrm);
  vHeight = disp.y; vCrest = crest; vFade = fade;
  vec3 pos = vec3(wp.x + disp.x, wp.y + disp.y, wp.z + disp.z);
  vWorld = pos;
  vec4 mvPosition = viewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */`
uniform vec3 uDeep; uniform vec3 uShallow; uniform vec3 uSkyTop; uniform vec3 uSkyHorizon; uniform vec3 uSunDir; uniform vec3 uSunColor;
uniform sampler2D uDepth; uniform vec2 uDepthOrigin; uniform float uDepthSize; uniform float uTime; uniform float uWind; uniform vec2 uWindDir;
uniform float uNight; uniform float uRain; uniform float uStorm; uniform float uSteep; uniform float uAmpSum; uniform float uLevel; uniform float uDetail;
varying vec3 vWorld; varying vec3 vNormal; varying float vHeight; varying float vCrest; varying float vFade;
#include <fog_pars_fragment>
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
// value noise with its analytic gradient: x = value, yz = d/dx, d/dy
vec3 noised(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f*f*f*(f*(f*6.0-15.0)+10.0);
  vec2 du = 30.0*f*f*(f*(f-2.0)+1.0);
  float a = hash(i), b = hash(i+vec2(1,0)), c = hash(i+vec2(0,1)), d = hash(i+vec2(1,1));
  float k1 = b - a, k2 = c - a, k3 = a - b - c + d;
  return vec3(a + k1*u.x + k2*u.y + k3*u.x*u.y, du * (vec2(k1, k2) + k3 * u.yx));
}
void main() {
  vec2 duv = (vWorld.xz - uDepthOrigin) / uDepthSize;
  float depth = 255.0;
  if (duv.x > 0.0 && duv.x < 1.0 && duv.y > 0.0 && duv.y < 1.0) depth = texture2D(uDepth, duv).r * 255.0;
  depth = max(0.0, depth + uLevel);
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / max(dist, 0.001);
  vec2 dp = vWorld.xz;
  // --- normal: Gerstner geometry + two scrolling noise octaves (capillary ripples), fading with distance (anti-shimmer)
  float dfade = uDetail / (1.0 + dist * 0.004);
  float windK = clamp(uWind / 16.0, 0.0, 1.0);
  vec3 n1 = noised(dp * 0.33 + uWindDir * uTime * 0.55);
  vec3 n2 = noised(dp * 1.27 - uWindDir * uTime * 0.85 + 7.3);
  vec2 grad = (n1.yz * 0.33 * 0.7 + n2.yz * 1.27 * 0.3) * (0.07 + 0.11 * windK) * dfade;
  vec3 N = vec3(vNormal.x - grad.x, vNormal.y, vNormal.z - grad.y);
  if (uRain > 0.0) { // expanding rain rings on a jittered grid
    vec2 rp = dp * 0.8; vec2 ci = floor(rp); vec2 cf = fract(rp) - 0.5;
    float h = hash(ci);
    float ph = fract(uTime * 1.7 + h * 3.0);
    vec2 cc = cf + (vec2(hash(ci + 3.1), hash(ci + 7.7)) - 0.5) * 0.6;
    float r = length(cc);
    float ring = sin(r * 38.0 - ph * 22.0) * exp(-r * 6.0) * (1.0 - ph) * step(h, uRain * 0.9 + 0.05);
    N.xz += (cc / max(r, 0.02)) * ring * 0.22 * dfade;
  }
  N = normalize(N);
  float ndv = max(0.0, dot(N, V));
  float fresnel = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  float sunUp = clamp(uSunDir.y * 4.0, 0.0, 1.0) * (1.0 - uNight * 0.9);
  // --- water body
  float shallowMix = exp(-depth / 18.0);
  vec3 water = mix(uDeep, uShallow, shallowMix);
  water = mix(water, vec3(0.15, 0.19, 0.21), uStorm * 0.55);
  water *= 0.72 + 0.28 * max(0.0, dot(N, uSunDir));
  // subsurface: light through crests when looking toward the sun
  float crestH = clamp(vHeight / max(0.3, uAmpSum) * 0.6 + 0.4, 0.0, 1.0);
  float sss = pow(max(0.0, dot(V, -uSunDir) * 0.5 + 0.5), 3.0) * crestH * (1.0 - fresnel) * sunUp;
  water += vec3(0.08, 0.42, 0.38) * sss * (0.5 + 0.5 * shallowMix) * (1.0 - uStorm * 0.6);
  water *= 1.0 - 0.78 * uNight;
  // --- sky reflection
  vec3 R = reflect(-V, N);
  float ry = clamp(R.y, 0.0, 1.0);
  vec3 sky = mix(uSkyHorizon, uSkyTop, pow(ry, 0.6));
  sky += uSunColor * pow(max(0.0, dot(R, uSunDir)), 10.0) * 0.12 * sunUp;
  sky *= 1.0 - 0.3 * uStorm;
  vec3 col = mix(water, sky, fresnel);
  // --- sun specular: normalised Blinn-Phong, roughness from wind, broadened with distance (glitter path to the horizon)
  vec3 H = normalize(uSunDir + V);
  float ndh = max(0.0, dot(N, H));
  float rough = clamp(0.07 + uWind * 0.011, 0.07, 0.34);
  rough = mix(rough, 0.45, smoothstep(300.0, 4000.0, dist));
  float e1 = 2.0 / (rough * rough);
  float Fh = 0.02 + 0.98 * pow(1.0 - max(0.0, dot(V, H)), 5.0);
  float spec = pow(ndh, e1) * (e1 + 2.0) * 0.08 + pow(ndh, 14.0) * 0.03;
  col += uSunColor * spec * Fh * sunUp * 2.2;
  // --- foam: shore surf from the depth texture, whitecaps on folded crests above 8 m/s
  float n = noise(dp * 0.12 + uTime * 0.05) * 0.6 + noise(dp * 0.5 - uTime * 0.1) * 0.4;
  float surf = n + 0.12 * sin(uTime * 0.9 + depth * 1.6);
  float shore = smoothstep(5.5, 0.3, depth) * smoothstep(0.38, 0.72, surf);
  float crestN = vCrest / max(0.05, uSteep);
  float capK = clamp((uWind - 8.0) / 14.0, 0.0, 0.6);
  float caps = step(0.001, capK) * smoothstep(1.0 - capK, 1.06 - capK * 0.5, crestN) * smoothstep(0.28, 0.7, n) * vFade;
  float foam = clamp(shore + caps, 0.0, 1.0);
  vec3 foamCol = vec3(0.9, 0.94, 0.96) * (0.3 + 0.7 * sunUp) * (1.0 - 0.7 * uNight);
  col = mix(col, foamCol, foam * 0.85);
  col *= 1.0 - 0.2 * uNight;
  gl_FragColor = vec4(col, 1.0);
  // same tail as three's built-in materials: tone-map, encode linear → output colour space, then fog (fogColor is
  // already in the output space)
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

/** Model-space y of the far ring: the displacement is faded to zero at the near plane's rim, so the ring only needs to sit a hair below. */
const FAR_Y = -0.3;
const CENTRE_K = 0.14; // fraction of the uniform cell size at the centre of the near grid (cells grow cubically outwards)

export class Ocean {
  constructor(scene, size = 4400, segs = 176) {
    this.scene = scene; this.size = size; this.segs = segs;
    this.depthN = 160;
    this.depthData = new Uint8Array(this.depthN * this.depthN * 4).fill(255);
    this.depthTex = new THREE.DataTexture(this.depthData, this.depthN, this.depthN, THREE.RGBAFormat);
    this.depthTex.needsUpdate = true; this.depthTex.magFilter = THREE.LinearFilter; this.depthTex.minFilter = THREE.LinearFilter;
    this.depthCenter = { x: 1e9, z: 1e9 };
    this.depthSize = size * 1.15;
    this.level = 0; this.windF = 1; this.wind = 5; this.windDir = 240; this.rain = 0; this.storm = 0; this.hs = 0.8;
    this.seaSet = false; this.lastCam = null;
    this.target = WAVES.map((w) => ({ amp: w.amp, ang: w.ang }));
    const half = size / 2;
    this.snapQ = (2 * half * CENTRE_K) / segs;
    const waveA = WAVES.map((w) => new THREE.Vector4(w.dx, w.dz, w.amp, w.k));
    const waveB = WAVES.map((w) => new THREE.Vector4(w.w, w.q, w.ph, w.len));
    this.uniforms = {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uTime: { value: 0 }, uWind: { value: 5 }, uWindDir: { value: new THREE.Vector2(0.5, 0.866) }, uWaveA: { value: waveA }, uWaveB: { value: waveB },
      uFadeIn: { value: half * 0.6 }, uFadeOut: { value: half * 0.95 },
      uCell0: { value: this.snapQ }, uCellK: { value: (3 * (1 - CENTRE_K) * (2 * half / segs)) / (half * half) },
      uDeep: { value: new THREE.Color(0x03203a) }, uShallow: { value: new THREE.Color(0x1d7f86) },
      uSkyTop: { value: new THREE.Color(0x4a8fd6) }, uSkyHorizon: { value: new THREE.Color(0xbfd9ee) },
      uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.3).normalize() }, uSunColor: { value: new THREE.Color(0xfff2d0) },
      uDepth: { value: this.depthTex }, uDepthOrigin: { value: new THREE.Vector2(0, 0) }, uDepthSize: { value: this.depthSize }, uNight: { value: 0 },
      uRain: { value: 0 }, uStorm: { value: 0 }, uSteep: { value: 0.3 }, uAmpSum: { value: 0.4 }, uLevel: { value: 0 }, uDetail: { value: 1 },
    };
    const mat = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, fog: true });
    this.material = mat;
    // near grid: centre-dense (x = half·(c·u + (1−c)·u³)), ~3.5 m cells under the camera, ~70 m at the rim
    this.mesh = new THREE.Mesh(this.buildNearGrid(size, segs), mat);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 1;
    scene.add(this.mesh);
    // far, coarse ring so the horizon is water all the way into the fog; the triangles under the near plane are dropped
    const farGeo = new THREE.PlaneGeometry(size * 4, size * 4, 48, 48); farGeo.rotateX(-Math.PI / 2);
    const fp = farGeo.attributes.position, fi = farGeo.getIndex().array, keep = [], inner = size / 2 - 1;
    for (let t = 0; t < fi.length; t += 3) {
      const cx = (fp.getX(fi[t]) + fp.getX(fi[t + 1]) + fp.getX(fi[t + 2])) / 3, cz = (fp.getZ(fi[t]) + fp.getZ(fi[t + 1]) + fp.getZ(fi[t + 2])) / 3;
      if (Math.abs(cx) < inner && Math.abs(cz) < inner) continue;
      keep.push(fi[t], fi[t + 1], fi[t + 2]);
    }
    farGeo.setIndex(keep);
    this.far = new THREE.Mesh(farGeo, mat); this.far.position.y = FAR_Y; this.far.frustumCulled = false; this.far.renderOrder = 0; scene.add(this.far);
    this.setWind(5, 240);
    // start on the target state so the first frame is not a flat sea
    for (let i = 0; i < NW; i++) { WAVES[i].amp = this.target[i].amp; WAVES[i].ang = this.target[i].ang; }
    this.refreshTable();
  }
  buildNearGrid(size, segs) {
    const half = size / 2, N = segs + 1;
    const pos = new Float32Array(N * N * 3);
    const f = (u) => half * (CENTRE_K * u + (1 - CENTRE_K) * u * u * u);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = (j * N + i) * 3;
      pos[k] = f(-1 + (2 * i) / segs); pos[k + 1] = 0; pos[k + 2] = f(-1 + (2 * j) / segs);
    }
    const idx = new Uint32Array(segs * segs * 6); let q = 0;
    for (let j = 0; j < segs; j++) for (let i = 0; i < segs; i++) {
      const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
      idx[q++] = a; idx[q++] = c; idx[q++] = b; idx[q++] = b; idx[q++] = c; idx[q++] = d;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), half * 1.5);
    return geo;
  }
  /** Lower the fragment detail / segment budget on weak devices (main.js may call once). */
  setQuality(q) { this.uniforms.uDetail.value = THREE.MathUtils.clamp(q, 0, 1); }

  // ------------------------------------------------------------------ sea state
  /** Legacy / fallback input: wind speed (m/s) and optional FROM direction (deg). Derives a fetch-limited wind sea unless setSea() has spoken. */
  setWind(ms, dirDeg) {
    ms = Number.isFinite(ms) ? Math.max(0, ms) : 5;
    this.wind = ms; if (Number.isFinite(dirDeg)) this.windDir = dirDeg;
    this.windTarget = THREE.MathUtils.clamp(0.25 + ms / 12, 0.3, 2.2); // kept for callers that read windF
    if (this.seaSet) return;
    this.applySea({ windSpd: ms, windDir: this.windDir });
  }
  /** Full sea state. Accepts the flat contract shape OR game.weatherAt()'s nested shape (wind/waves/swell objects). */
  setSea(o) {
    if (!o) return;
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
  }
  /** Compute the target component table from a (possibly partial) sea description. Missing wave data is derived from the wind. */
  applySea(s) {
    const U = Math.max(0, s.windSpd);
    // fetch-limited wind sea from the wind alone: Hs ≈ 0.016·U² (1.6 m at 10 m/s, 5.8 m at 19 m/s), Tp ≈ 2.5 + 0.45·U
    let waveH = Number.isFinite(s.waveH) ? Math.max(0, s.waveH) : Math.min(9, 0.1 + 0.016 * U * U);
    const wavePeriod = Number.isFinite(s.wavePeriod) && s.wavePeriod > 1 ? s.wavePeriod : THREE.MathUtils.clamp(2.5 + 0.45 * U, 3, 12);
    const waveFrom = Number.isFinite(s.waveDir) ? s.waveDir : s.windDir;
    let swellH = Number.isFinite(s.swellH) ? Math.max(0, s.swellH) : 0;
    const swellPeriod = Number.isFinite(s.swellPeriod) && s.swellPeriod > 1 ? s.swellPeriod : 11;
    const swellFrom = Number.isFinite(s.swellDir) ? s.swellDir : waveFrom;
    if (!Number.isFinite(s.waveH) && !Number.isFinite(s.swellH)) swellH = Math.min(1.5, 0.15 + U * 0.04); // a little background swell
    // the significant height is the combined sea: when waveH is the TOTAL (Open-Meteo wave_height includes swell) split it
    if (Number.isFinite(s.waveH) && Number.isFinite(s.swellH) && swellH > 0) waveH = Math.sqrt(Math.max(0, waveH * waveH - swellH * swellH));
    this.hs = Math.sqrt(waveH * waveH + swellH * swellH);
    // wind sea: Pierson–Moskowitz-like weights on the ladder, amplitude per band ∝ (1/k)·exp(−0.625·(λ/λp)²)
    const lamP = THREE.MathUtils.clamp((G * wavePeriod * wavePeriod) / (2 * Math.PI), 8, 420);
    const weights = [];
    let sum = 0;
    for (let i = 0; i < 8; i++) { const lam = LADDER[i]; const r = lam / lamP; const w = lam * Math.exp(-0.625 * r * r); weights.push(w); sum += w; }
    const travel = waveFrom + 180;
    for (let i = 0; i < 8; i++) {
      let amp = sum > 0 ? (weights[i] / sum) * (waveH / 2) : 0;
      amp = Math.min(amp, 0.07 * LADDER[i]); // breaking limit (H/λ ≈ 1/7)
      this.target[i] = { amp, ang: travel + DIR_OFF[i] };
    }
    // swell: two long components, weight by closeness (in log λ) to the swell wavelength
    const lamS = THREE.MathUtils.clamp((G * swellPeriod * swellPeriod) / (2 * Math.PI), 60, 500);
    const sw = [8, 9].map((i) => Math.exp(-Math.pow(Math.log(LADDER[i] / lamS) / 0.7, 2)));
    const ssum = sw[0] + sw[1] || 1;
    const stravel = swellFrom + 180;
    for (let j = 0; j < 2; j++) this.target[8 + j] = { amp: Math.min((sw[j] / ssum) * (swellH / 2), 0.05 * LADDER[8 + j]), ang: stravel + DIR_OFF[8 + j] };
  }
  /** Tide: vertical offset of the whole surface (both meshes, heightAt, wakes). */
  setLevel(y) { this.level = Number.isFinite(y) ? y : 0; }
  setRain(r) { this.rain = THREE.MathUtils.clamp(Number.isFinite(r) ? r : 0, 0, 1); }
  setStorm(s) { this.storm = THREE.MathUtils.clamp(Number.isFinite(s) ? s : 0, 0, 1); }
  setSun(dir, color, night, skyTop, skyHorizon) {
    this.uniforms.uSunDir.value.copy(dir); this.uniforms.uSunColor.value.copy(color); this.uniforms.uNight.value = night;
    this.uniforms.uSkyTop.value.copy(skyTop); this.uniforms.uSkyHorizon.value.copy(skyHorizon);
  }

  /** Re-derive dx/dz and the amplitude-weighted steepness from the live (ang, amp) and push everything to the GPU. */
  refreshTable() {
    let ampSum = 0;
    for (let i = 0; i < NW; i++) ampSum += WAVES[i].amp;
    const S = 0.6; // total steepness budget: Σ Q_i k_i A_i = S (never loops)
    let steep = 0;
    const A = this.uniforms.uWaveA.value, B = this.uniforms.uWaveB.value;
    for (let i = 0; i < NW; i++) {
      const w = WAVES[i];
      const a = w.ang * (Math.PI / 180);
      w.dx = Math.sin(a); w.dz = -Math.cos(a);
      w.q = ampSum > 0 ? Math.min(1, S / (w.k * ampSum)) : 0;
      steep += w.q * w.k * w.amp;
      A[i].set(w.dx, w.dz, w.amp, w.k); B[i].set(w.w, w.q, w.ph, w.len);
    }
    this.uniforms.uSteep.value = Math.max(0.02, steep);
    this.uniforms.uAmpSum.value = Math.max(0.1, ampSum);
  }
  update(time, cx, cz, dt) {
    dt = Number.isFinite(dt) ? Math.min(0.25, Math.max(0, dt)) : 0.016;
    this.windF += ((this.windTarget ?? 1) - this.windF) * Math.min(1, dt * 0.2);
    // a floating-origin shift (or teleport) moves the camera by kilometres in one frame: re-phase every component so
    // the wave pattern does not jump along with the frame
    if (this.lastCam && Math.hypot(cx - this.lastCam.x, cz - this.lastCam.z) > 2500) {
      const sx = this.lastCam.x - cx, sz = this.lastCam.z - cz;
      for (const w of WAVES) w.ph += w.k * (w.dx * sx + w.dz * sz);
    }
    this.lastCam = { x: cx, z: cz };
    // ease the live table toward the target: amplitudes over ~8 s, directions ≤ 3°/s; keep the phase continuous at the camera
    const ka = Math.min(1, dt / 8);
    for (let i = 0; i < NW; i++) {
      const w = WAVES[i], t = this.target[i];
      w.amp += (t.amp - w.amp) * ka;
      let d = ((t.ang - w.ang + 540) % 360) - 180;
      if (Math.abs(d) > 0.01) {
        const step = Math.sign(d) * Math.min(Math.abs(d), 3 * dt);
        const a0 = w.ang * (Math.PI / 180), a1 = (w.ang + step) * (Math.PI / 180);
        const dx0 = Math.sin(a0), dz0 = -Math.cos(a0), dx1 = Math.sin(a1), dz1 = -Math.cos(a1);
        w.ph += w.k * ((dx0 - dx1) * cx + (dz0 - dz1) * cz);
        w.ang += step;
      }
      if (w.ph > 1e4 || w.ph < -1e4) w.ph %= Math.PI * 2;
    }
    this.refreshTable();
    const u = this.uniforms;
    u.uTime.value = time; u.uWind.value = this.wind; u.uRain.value = this.rain; u.uStorm.value = this.storm; u.uLevel.value = this.level;
    const wa = (this.windDir + 180) * (Math.PI / 180);
    u.uWindDir.value.set(Math.sin(wa), -Math.cos(wa));
    const q = this.snapQ;
    this.mesh.position.set(Math.round(cx / q) * q, this.level, Math.round(cz / q) * q);
    this.far.position.set(this.mesh.position.x, FAR_Y + this.level, this.mesh.position.z);
    oceanState.time = time; oceanState.level = this.level; oceanState.hs = this.hs; oceanState.wind = this.wind; oceanState.windDir = this.windDir;
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
  /** Surface height (tide level + Gerstner vertical part) at world (x, z); matches the GPU displacement near the camera. */
  heightAt(x, z, time) { return this.level + waveHeight(x, z, time, 1); }
  dispose() {
    this.scene.remove(this.mesh); this.scene.remove(this.far);
    this.mesh.geometry.dispose(); this.far.geometry.dispose(); this.material.dispose(); this.depthTex.dispose();
  }
}

function num(v, d) { return Number.isFinite(v) ? v : d; }
