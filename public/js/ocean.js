// Ocean: a camera-following plane with a sum-of-sines/Gerstner surface in the vertex shader, depth-aware colour
// (from a CPU-built depth texture of the surrounding terrain), shore and crest foam, fresnel sky reflection and
// sun specular. The CPU `waveHeight` matches the shader so ships ride the same waves.
import * as THREE from 'three';

export const WAVES = [
  { dx: 1.0, dz: 0.25, amp: 0.55, len: 46, speed: 7.0 },
  { dx: 0.6, dz: -0.8, amp: 0.35, len: 27, speed: 5.5 },
  { dx: -0.3, dz: 1.0, amp: 0.8, len: 90, speed: 9.5 },
  { dx: 0.9, dz: 0.9, amp: 0.18, len: 13, speed: 4.0 },
];
for (const w of WAVES) { const l = Math.hypot(w.dx, w.dz); w.dx /= l; w.dz /= l; w.k = (2 * Math.PI) / w.len; w.w = (w.speed * 2 * Math.PI) / w.len; }

export function waveHeight(x, z, t, windF) {
  let h = 0;
  for (const w of WAVES) h += w.amp * windF * Math.sin((w.dx * x + w.dz * z) * w.k - w.w * t);
  return h;
}

const VERT = /* glsl */`
uniform float uTime; uniform float uWind;
uniform vec4 uWaveA[4]; // dx, dz, amp, k
uniform vec2 uWaveB[4]; // w, steepness
varying vec3 vWorld; varying vec3 vNormal; varying float vHeight;
#include <fog_pars_vertex>
float hgt(vec2 p) {
  float h = 0.0;
  for (int i = 0; i < 4; i++) { h += uWaveA[i].z * uWind * sin(dot(uWaveA[i].xy, p) * uWaveA[i].w - uWaveB[i].x * uTime); }
  return h;
}
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec2 p = wp.xz;
  float h = hgt(p);
  // small Gerstner-style horizontal sharpening
  vec2 off = vec2(0.0);
  for (int i = 0; i < 4; i++) { off += uWaveA[i].xy * uWaveB[i].y * uWaveA[i].z * uWind * cos(dot(uWaveA[i].xy, p) * uWaveA[i].w - uWaveB[i].x * uTime); }
  float e = 1.5;
  float hx = hgt(p + vec2(e, 0.0)); float hz = hgt(p + vec2(0.0, e));
  vNormal = normalize(vec3(h - hx, e, h - hz));
  vHeight = h;
  // keep the mesh's own y (the far ring is translated below the near plane) and add the wave on top of it
  vec3 pos = vec3(wp.x + off.x, wp.y + h, wp.z + off.y);
  vWorld = pos;
  vec4 mvPosition = viewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */`
uniform vec3 uDeep; uniform vec3 uShallow; uniform vec3 uSkyTop; uniform vec3 uSkyHorizon; uniform vec3 uSunDir; uniform vec3 uSunColor;
uniform sampler2D uDepth; uniform vec2 uDepthOrigin; uniform float uDepthSize; uniform float uTime; uniform float uWind; uniform float uNight;
varying vec3 vWorld; varying vec3 vNormal; varying float vHeight;
#include <fog_pars_fragment>
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
void main() {
  vec2 duv = (vWorld.xz - uDepthOrigin) / uDepthSize;
  float depth = 255.0;
  if (duv.x > 0.0 && duv.x < 1.0 && duv.y > 0.0 && duv.y < 1.0) depth = texture2D(uDepth, duv).r * 255.0;
  vec3 N = normalize(vNormal);
  vec3 V = normalize(cameraPosition - vWorld);
  float ndv = max(0.0, dot(N, V));
  float fresnel = pow(1.0 - ndv, 4.0) * 0.75 + 0.06;
  float shallowMix = exp(-depth / 22.0);
  vec3 water = mix(uDeep, uShallow, shallowMix);
  // subsurface brightening on wave crests facing the sun
  float crest = clamp(vHeight * 0.5 + 0.5, 0.0, 1.0);
  water += uShallow * 0.25 * crest * max(0.0, dot(N, uSunDir));
  vec3 sky = mix(uSkyHorizon, uSkyTop, pow(max(0.0, N.y), 2.0));
  vec3 col = mix(water, sky, fresnel);
  // sun specular
  vec3 H = normalize(uSunDir + V);
  float spec = pow(max(0.0, dot(N, H)), 220.0) * 1.8 + pow(max(0.0, dot(N, H)), 24.0) * 0.12;
  col += uSunColor * spec;
  // foam: shore + crests + wind streaks
  float n = noise(vWorld.xz * 0.12 + uTime * 0.05) * 0.6 + noise(vWorld.xz * 0.5 - uTime * 0.1) * 0.4;
  float shore = smoothstep(6.0, 0.5, depth) * smoothstep(0.35, 0.75, n);
  float crestFoam = smoothstep(0.9, 1.6, vHeight * (1.0 / max(0.3, uWind))) * smoothstep(0.45, 0.8, n) * uWind;
  float foam = clamp(shore + crestFoam * 0.8, 0.0, 1.0);
  col = mix(col, vec3(0.92, 0.95, 0.97), foam * 0.85);
  col *= 1.0 - 0.45 * uNight;
  gl_FragColor = vec4(col, 1.0);
  // same tail as three's built-in materials: tone-map, encode linear → output colour space, then fog (fogColor is
  // already in the output space)
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

/** Model-space y of the far ring: below the deepest trough (sum of amplitudes 1.88 × max wind factor 2.2 ≈ 4.1). */
const FAR_Y = -6;

export class Ocean {
  constructor(scene, size = 4400, segs = 176) {
    this.size = size; this.segs = segs;
    this.depthN = 128;
    this.depthData = new Uint8Array(this.depthN * this.depthN * 4).fill(255);
    this.depthTex = new THREE.DataTexture(this.depthData, this.depthN, this.depthN, THREE.RGBAFormat);
    this.depthTex.needsUpdate = true; this.depthTex.magFilter = THREE.LinearFilter; this.depthTex.minFilter = THREE.LinearFilter;
    this.depthCenter = { x: 1e9, z: 1e9 };
    this.depthSize = size * 1.15;
    const waveA = WAVES.map((w) => new THREE.Vector4(w.dx, w.dz, w.amp, w.k));
    const waveB = WAVES.map((w) => new THREE.Vector2(w.w, 0.35));
    this.uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTime: { value: 0 }, uWind: { value: 1 }, uWaveA: { value: waveA }, uWaveB: { value: waveB },
      uDeep: { value: new THREE.Color(0x03203a) }, uShallow: { value: new THREE.Color(0x1d7f86) },
      uSkyTop: { value: new THREE.Color(0x4a8fd6) }, uSkyHorizon: { value: new THREE.Color(0xbfd9ee) },
      uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.3).normalize() }, uSunColor: { value: new THREE.Color(0xfff2d0) },
      uDepth: { value: this.depthTex }, uDepthOrigin: { value: new THREE.Vector2(0, 0) }, uDepthSize: { value: this.depthSize }, uNight: { value: 0 },
    }]);
    // merge() clones; re-point texture + arrays
    this.uniforms.uDepth.value = this.depthTex; this.uniforms.uWaveA.value = waveA; this.uniforms.uWaveB.value = waveB;
    const mat = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, fog: true });
    const geo = new THREE.PlaneGeometry(size, size, segs, segs);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
    // far, coarse ring so the horizon is water all the way into the fog. Its 48×48 grid is 12 cells across the near
    // plane, so the triangles under the near mesh are dropped (the two surfaces never intersect) and it sits FAR_Y below.
    const farGeo = new THREE.PlaneGeometry(size * 4, size * 4, 48, 48); farGeo.rotateX(-Math.PI / 2);
    const fp = farGeo.attributes.position, fi = farGeo.getIndex().array, keep = [], inner = size / 2 - 1;
    for (let t = 0; t < fi.length; t += 3) {
      const cx = (fp.getX(fi[t]) + fp.getX(fi[t + 1]) + fp.getX(fi[t + 2])) / 3, cz = (fp.getZ(fi[t]) + fp.getZ(fi[t + 1]) + fp.getZ(fi[t + 2])) / 3;
      if (Math.abs(cx) < inner && Math.abs(cz) < inner) continue;
      keep.push(fi[t], fi[t + 1], fi[t + 2]);
    }
    farGeo.setIndex(keep);
    this.far = new THREE.Mesh(farGeo, mat); this.far.position.y = FAR_Y; this.far.frustumCulled = false; this.far.renderOrder = 0; scene.add(this.far);
    this.windF = 1;
  }
  /** windSpeed m/s → wave factor */
  setWind(ms) { this.windTarget = THREE.MathUtils.clamp(0.25 + ms / 12, 0.3, 2.2); }
  setSun(dir, color, night, skyTop, skyHorizon) {
    this.uniforms.uSunDir.value.copy(dir); this.uniforms.uSunColor.value.copy(color); this.uniforms.uNight.value = night;
    this.uniforms.uSkyTop.value.copy(skyTop); this.uniforms.uSkyHorizon.value.copy(skyHorizon);
  }
  update(time, cx, cz, dt) {
    this.windF += ((this.windTarget ?? 1) - this.windF) * Math.min(1, dt * 0.2);
    this.uniforms.uTime.value = time; this.uniforms.uWind.value = this.windF;
    const q = this.size / this.segs;
    this.mesh.position.set(Math.round(cx / q) * q, 0, Math.round(cz / q) * q);
    this.far.position.set(this.mesh.position.x, FAR_Y, this.mesh.position.z);
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
  heightAt(x, z, time) { return waveHeight(x, z, time, this.windF); }
}
