// Damage smoke and fire over a ship (hostile.js ownSmoke): one THREE.Points draw call of soft smoke sprites with a
// procedural puff texture. Puffs are born low over the deck, rise, drift with the wind, grow and fade; dark grey, with
// an orange fire glow only on the youngest puffs near the deck while the hull burns. Sizes are in metres (sized by the
// ship), the sprite shader attenuates by distance and never writes depth, so the smoke sits over the water and the hull.
import * as THREE from 'three';

const MAX = 96;
let PUFF = null;
/** a soft, lumpy puff (alpha only): radial fall-off times a little value noise, 128 px */
function puffTexture() {
  if (PUFF) return PUFF;
  const S = 128, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d'), img = g.createImageData(S, S), d = img.data;
  const h = (x, y) => { const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; return v - Math.floor(v); };
  const n = (x, y) => { const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy); return (h(i, j) * (1 - sx) + h(i + 1, j) * sx) * (1 - sy) + (h(i, j + 1) * (1 - sx) + h(i + 1, j + 1) * sx) * sy; };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = (x + 0.5) / S - 0.5, dy = (y + 0.5) / S - 0.5, r = Math.hypot(dx, dy) * 2;
    const lump = 0.55 + 0.45 * (n(x / 18, y / 18) * 0.6 + n(x / 7, y / 7) * 0.4);
    const a = Math.max(0, 1 - r / (0.72 + 0.28 * lump));
    const v = a * a * (3 - 2 * a) * lump;
    const o = (y * S + x) * 4; d[o] = d[o + 1] = d[o + 2] = 255; d[o + 3] = Math.min(255, v * 255) | 0;
  }
  g.putImageData(img, 0, 0);
  PUFF = new THREE.CanvasTexture(c); PUFF.userData.shared = true;
  return PUFF;
}

const VERT = /* glsl */`
attribute float aSize; attribute float aAlpha; attribute float aFire; attribute float aSpin;
varying float vAlpha; varying float vFire; varying float vSpin;
void main() {
  vAlpha = aAlpha; vFire = aFire; vSpin = aSpin;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (900.0 / max(1.0, -mv.z));
  gl_Position = projectionMatrix * mv;
}`;
const FRAG = /* glsl */`
uniform sampler2D uTex; uniform vec3 uSmoke; uniform vec3 uFire; uniform float uDay;
varying float vAlpha; varying float vFire; varying float vSpin;
#include <fog_pars_fragment>
void main() {
  vec2 c = gl_PointCoord - 0.5; float cs = cos(vSpin), sn = sin(vSpin);
  vec2 uv = vec2(c.x * cs - c.y * sn, c.x * sn + c.y * cs) + 0.5;
  float a = texture2D(uTex, uv).a * vAlpha;
  if (a < 0.01) discard;
  // the lit top of a puff is a little paler than its shaded underside
  float shade = 0.75 + 0.35 * clamp(0.5 - c.y, 0.0, 1.0);
  vec3 col = uSmoke * shade * (0.35 + 0.65 * uDay);
  // fire glow at the base: additive orange on the youngest puffs, hottest at the centre
  float core = 1.0 - smoothstep(0.0, 0.35, length(c));
  col += uFire * vFire * (0.6 + 1.6 * core);
  gl_FragColor = vec4(col, a);
  #include <fog_fragment>
}`;

export class ShipSmoke {
  constructor(scene) {
    this.scene = scene;
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(MAX * 3); this.size = new Float32Array(MAX); this.alpha = new Float32Array(MAX); this.fire = new Float32Array(MAX); this.spin = new Float32Array(MAX);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aFire', new THREE.BufferAttribute(this.fire, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSpin', new THREE.BufferAttribute(this.spin, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTex: { value: null }, uSmoke: { value: new THREE.Color(0x2a2c30) }, uFire: { value: new THREE.Color(0xff6a14) }, uDay: { value: 1 } }]),
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, depthTest: true, fog: true, blending: THREE.NormalBlending,
    });
    this.mat.uniforms.uTex.value = puffTexture();
    this.points = new THREE.Points(geo, this.mat); this.points.frustumCulled = false; this.points.renderOrder = 6; this.points.name = 'ship-smoke';
    scene.add(this.points);
    this.live = [];        // { x, y, z, vx, vy, vz, t, life, s0, s1, fire, spin, dspin }
    this.emitT = 0;
  }
  /**
   * Per frame. src: { x, y, z (deck level, world), hdg (rad), L (m), wind: { u, v } m/s } · power 0..1 (damage, hit,
   * sinking) · fire: the hull burns (orange glow at the base) · day 0..1 (the sky's daylight, dims the smoke at night)
   */
  update(dt, src, power, fire, day = 1) {
    this.mat.uniforms.uDay.value = day;
    this.emitT += dt;
    const big = Math.max(1, src.L / 60);
    const gap = (0.22 - 0.16 * power) / Math.sqrt(big);
    while (power > 0.05 && this.emitT > gap && this.live.length < MAX) {
      this.emitT -= gap;
      const off = (Math.random() - 0.5) * src.L * 0.45, side = (Math.random() - 0.5) * src.L * 0.08;
      const sh = Math.sin(src.hdg), ch = Math.cos(src.hdg);
      const s0 = (1.2 + 1.6 * power) * Math.sqrt(big);
      this.live.push({ x: src.x + sh * off + ch * side, y: src.y + 0.5 + Math.random() * 1.5, z: src.z - ch * off + sh * side,
        vx: (Math.random() - 0.5) * 0.6, vy: 1.6 + 1.8 * power + Math.random() * 0.8, vz: (Math.random() - 0.5) * 0.6,
        t: 0, life: (4 + 4 * power) * (0.8 + Math.random() * 0.4), s0, s1: s0 * (4 + 3 * power), fire: fire ? 0.6 + 0.4 * Math.random() : 0, spin: Math.random() * 6.28, dspin: (Math.random() - 0.5) * 0.5 });
    }
    const wu = src.wind?.u ?? 0, wv = src.wind?.v ?? 0;
    let n = 0;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i]; p.t += dt;
      const u = p.t / p.life;
      if (u >= 1) { this.live.splice(i, 1); continue; }
      // rise (slowing as the puff cools), drift with the wind more the higher it gets, spin
      const lift = p.vy * (1 - 0.6 * u), wk = 0.25 + 0.55 * u;
      p.x += (p.vx + wu * wk) * dt; p.y += lift * dt; p.z += (p.vz - wv * wk) * dt; p.spin += p.dspin * dt;
      const o = n * 3; this.pos[o] = p.x; this.pos[o + 1] = p.y; this.pos[o + 2] = p.z;
      this.size[n] = p.s0 + (p.s1 - p.s0) * Math.sqrt(u);
      this.alpha[n] = (u < 0.12 ? u / 0.12 : 1) * (1 - u) * (1 - u) * 0.85;
      this.fire[n] = p.fire * Math.max(0, 1 - u * 3.5);                      // the glow dies in the first third of the life
      this.spin[n] = p.spin;
      n++;
    }
    const g = this.points.geometry;
    for (const k of ['position', 'aSize', 'aAlpha', 'aFire', 'aSpin']) g.attributes[k].needsUpdate = true;
    g.setDrawRange(0, n);
    this.points.visible = n > 0;
  }
  clear() { this.live.length = 0; this.points.geometry.setDrawRange(0, 0); this.points.visible = false; }
  dispose() { this.scene.remove(this.points); this.points.geometry.dispose(); this.mat.dispose(); }
}
