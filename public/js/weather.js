// Weather effects around the camera: two wind-driven alpha-noise cloud layers (low cover + high cirrus), GPU-animated
// rain streaks (Points in a box that follows the camera, falling with the wind), lightning (sky/cloud flash + a
// hemisphere light pulse; random when storm > 0.6, or on demand via flash()) and a storm-darkening value main.js can
// fold into its lights. Fog distance itself is set by main.js from the visibility. Cheap on mobile: one cloud layer,
// fewer rain particles, fewer noise octaves.
// Heavy weather (scaled continuously by wind / Hs / storm): the low cloud deck sinks and darkens into scud, lightning
// draws a visible bolt (thunder follows after the light's distance / 343 m/s via onThunder), blown spray and spindrift
// sheets stream off the sea downwind around the ship, slams throw spray over the bow, green water runs aft over the
// foredeck, and drops of spray and rain hit the camera "lens" (a 2D overlay canvas at half resolution).
// Budgets: cheap devices (phones) get a third of the particles, no second cloud layer and a quarter-resolution lens.
import * as THREE from 'three';

const CLOUD_VERT = /* glsl */`
varying vec2 vUv; varying vec3 vWorld;
void main() { vUv = uv; vec4 wp = modelMatrix * vec4(position, 1.0); vWorld = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`;

const CLOUD_FRAG = /* glsl */`
uniform float uTime; uniform vec2 uOffset; uniform float uCover; uniform float uFlash; uniform float uStorm; uniform float uNight;
uniform vec3 uColor; uniform vec3 uShade; uniform float uScale; uniform float uSoft; uniform float uAlpha; uniform int uOct;
varying vec2 vUv; varying vec3 vWorld;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
float fbm(vec2 p) {
  float v = 0.0, a = 0.5; mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 4; i++) { if (i >= uOct) break; v += a * noise(p); p = m * p + 3.7; a *= 0.5; }
  return v;
}
void main() {
  vec2 p = (vWorld.xz + uOffset) * uScale;
  float n = fbm(p + 0.08 * uTime * vec2(0.3, 0.2));
  n = n * 0.6 + 0.4 * fbm(p * 2.3 - vec2(uTime * 0.05, 0.0)) * 0.6;
  float th = 1.0 - uCover;
  float a = smoothstep(th - uSoft * 0.5, th + uSoft, n);
  // fade with distance from the camera (the plane is huge; the far edge must dissolve)
  vec2 e = abs(vUv - 0.5) * 2.0;
  float edge = 1.0 - smoothstep(0.55, 0.98, max(e.x, e.y));
  // lit tops / shaded base: thicker (higher n) → darker, storm darkens everything
  float thick = smoothstep(th, th + 0.5, n);
  vec3 col = mix(uColor, uShade, thick * (0.55 + 0.4 * uStorm));
  col *= 1.0 - 0.62 * uStorm;                         // storm cloud: dark slate, nearly black at the base
  col += vec3(1.0, 0.97, 0.9) * uFlash * (0.6 + 0.6 * thick);
  gl_FragColor = vec4(col, a * edge * uAlpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const RAIN_VERT = /* glsl */`
attribute vec3 aOffset; attribute float aSeed;
uniform float uTime; uniform vec3 uCam; uniform vec3 uBox; uniform vec2 uDrift; uniform float uDensity; uniform float uSize; uniform float uSpeed;
varying float vAlpha;
void main() {
  float on = step(aSeed, uDensity);
  float fall = uTime * uSpeed * (0.8 + 0.4 * fract(aSeed * 7.3));
  float dk = 0.9 + 0.2 * aSeed;
  // the particle field is periodic in world space (period = box) and wrapped around the camera, so moving the camera
  // never makes drops pop: they simply re-enter on the other side of the box
  vec3 rel = aOffset + vec3(uDrift.x * uTime * dk, -fall, uDrift.y * uTime * dk) - uCam;
  rel = mod(rel + uBox * 0.5, uBox) - uBox * 0.5;
  vec3 world = uCam + rel;
  vec4 mv = viewMatrix * vec4(world, 1.0);
  float dist = max(1.0, -mv.z);
  vAlpha = on * (1.0 - smoothstep(uBox.x * 0.3, uBox.x * 0.5, length(rel.xz))) * clamp(1.5 - dist / (uBox.x * 0.6), 0.2, 1.0);
  gl_PointSize = on * uSize * (300.0 / dist);
  gl_Position = projectionMatrix * mv;
}`;

const RAIN_FRAG = /* glsl */`
varying float vAlpha; uniform float uOpacity;
void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float streak = (1.0 - smoothstep(0.0, 0.09, abs(uv.x))) * (1.0 - smoothstep(0.3, 0.5, abs(uv.y)));
  float a = streak * vAlpha * uOpacity;
  if (a < 0.01) discard;
  gl_FragColor = vec4(0.78, 0.84, 0.92, a);
}`;

const SPRAY_VERT = /* glsl */`
attribute float aLife; attribute float aSize;
uniform float uScale;
varying float vA;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vA = clamp(aLife, 0.0, 1.0);
  gl_PointSize = aSize * uScale / max(1.0, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;
const SPRAY_FRAG = /* glsl */`
uniform vec3 uCol; varying float vA;
void main() {
  vec2 d = gl_PointCoord - 0.5; float r = dot(d, d) * 4.0;
  float a = (1.0 - smoothstep(0.0, 1.0, r)) * vA * 0.5;    // soft mist puffs, not snowballs
  if (a < 0.01) discard;
  gl_FragColor = vec4(uCol, a);
}`;

/** CPU particle pool for spray: bursts over the bow, green water on deck, spindrift sheets. One Points draw call. */
class SprayPool {
  constructor(group, n) {
    this.n = n; this.next = 0;
    this.pos = new Float32Array(n * 3); this.vel = new Float32Array(n * 3); this.life = new Float32Array(n); this.max = new Float32Array(n).fill(1); this.size = new Float32Array(n);
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3); this.aPos.setUsage(THREE.DynamicDrawUsage);
    this.aLife = new THREE.BufferAttribute(new Float32Array(n), 1); this.aLife.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos); g.setAttribute('aLife', this.aLife); g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    this.u = { uScale: { value: 600 }, uCol: { value: new THREE.Color(0.9, 0.93, 0.95) } };
    this.mesh = new THREE.Points(g, new THREE.ShaderMaterial({ uniforms: this.u, vertexShader: SPRAY_VERT, fragmentShader: SPRAY_FRAG, transparent: true, depthWrite: false, fog: false }));
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 4; this.mesh.visible = false;
    group.add(this.mesh);
    this.alive = 0;
  }
  /** Emit one particle at (x,y,z) with velocity (vx,vy,vz), lifetime life s, size m. */
  emit(x, y, z, vx, vy, vz, life, size) {
    const i = this.next; this.next = (i + 1) % this.n;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = life; this.max[i] = life; this.size[i] = size;
    this.mesh.geometry.attributes.aSize.needsUpdate = true;
  }
  update(dt, windX, windZ, seaY) {
    let alive = 0;
    const L = this.aLife.array, drag = Math.min(1, dt * 1.6), grav = 9.81 * dt;
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) { if (L[i] !== 0) L[i] = 0; continue; }
      alive++;
      const o = i * 3;
      this.vel[o] += (windX - this.vel[o]) * drag; this.vel[o + 2] += (windZ - this.vel[o + 2]) * drag; this.vel[o + 1] -= grav;
      this.pos[o] += this.vel[o] * dt; this.pos[o + 1] += this.vel[o + 1] * dt; this.pos[o + 2] += this.vel[o + 2] * dt;
      this.life[i] -= dt;
      if (this.pos[o + 1] < seaY - 1) this.life[i] = Math.min(this.life[i], 0.15);
      const f = this.life[i] / this.max[i];
      L[i] = Math.min(1, f * 2.2) * Math.min(1, (1 - f) * 8 + 0.2);
    }
    this.alive = alive;
    this.mesh.visible = alive > 0;
    if (alive) { this.aPos.needsUpdate = true; this.aLife.needsUpdate = true; }
  }
}

/** Water on the camera lens: a pointer-transparent 2D canvas over the game, drawn only while there are drops. */
class LensDrops {
  constructor(scale) {
    this.scale = scale; this.drops = []; this.veil = 0; this.cv = null;
    try {
      const cv = document.createElement('canvas');
      cv.id = 'lensDrops';
      Object.assign(cv.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', pointerEvents: 'none' });
      const view = document.getElementById('view');   // right above the 3D view, below every HUD element
      if (view && view.parentNode) view.after(cv); else document.body.appendChild(cv);
      this.cv = cv; this.ctx = cv.getContext('2d');
    } catch { this.cv = null; }
  }
  /** n drops; big = spray sheet (bigger, runs) instead of rain specks. */
  hit(n, big = false) {
    if (!this.cv) return;
    for (let i = 0; i < n && this.drops.length < 140; i++) {
      const r = big ? 4 + Math.random() * 10 : 1.5 + Math.random() * 4;
      this.drops.push({ x: Math.random(), y: Math.random() * 0.9, r, life: big ? 2.5 + Math.random() * 3 : 1 + Math.random() * 2, run: big && Math.random() < 0.5 ? 0.02 + Math.random() * 0.06 : 0 });
      this.drops[this.drops.length - 1].max = this.drops[this.drops.length - 1].life;
    }
  }
  splash(k) { this.veil = Math.max(this.veil, Math.min(0.35, k * 0.7)); this.hit(Math.round(10 + 30 * k), true); }
  clear() { this.drops.length = 0; this.veil = 0; if (this.cv && this.drawn) { this.ctx.clearRect(0, 0, this.cv.width, this.cv.height); this.drawn = false; } }
  update(dt) {
    if (!this.cv) return;
    if (!this.drops.length && this.veil <= 0) { if (this.drawn) { this.ctx.clearRect(0, 0, this.cv.width, this.cv.height); this.drawn = false; } return; }
    const W = Math.max(64, Math.round(innerWidth * this.scale)), H = Math.max(64, Math.round(innerHeight * this.scale));
    if (this.cv.width !== W || this.cv.height !== H) { this.cv.width = W; this.cv.height = H; }
    const c = this.ctx; c.clearRect(0, 0, W, H); this.drawn = true;
    if (this.veil > 0) { c.fillStyle = `rgba(215,228,236,${this.veil})`; c.fillRect(0, 0, W, H); this.veil = Math.max(0, this.veil - dt * 0.5); }
    const k = this.scale;
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.life -= dt; if (d.life <= 0) { this.drops.splice(i, 1); continue; }
      if (d.run) d.y += d.run * dt;
      const a = Math.min(1, d.life / d.max * 2) * 0.5, x = d.x * W, y = d.y * H, r = d.r * k * 2;
      // a lens drop: clear body, a dark refracted rim below, a bright glint top-left
      const g = c.createRadialGradient(x, y, r * 0.55, x, y + r * 0.1, r);
      g.addColorStop(0, `rgba(200,215,225,${a * 0.08})`); g.addColorStop(0.75, `rgba(30,42,50,${a * 0.28})`); g.addColorStop(1, 'rgba(30,42,50,0)');
      c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
      c.fillStyle = `rgba(255,255,255,${a * 0.55})`; c.beginPath(); c.arc(x - r * 0.35, y - r * 0.4, Math.max(0.6, r * 0.16), 0, Math.PI * 2); c.fill();
      if (d.run) { c.strokeStyle = `rgba(200,215,225,${a * 0.35})`; c.lineWidth = Math.max(1, r * 0.35); c.beginPath(); c.moveTo(x, y - r * 4); c.lineTo(x, y); c.stroke(); }
    }
  }
}

function cheapDevice() {
  try {
    const touch = (window.matchMedia && matchMedia('(pointer: coarse)').matches) || navigator.maxTouchPoints > 1;
    return touch || (navigator.hardwareConcurrency || 8) <= 4;
  } catch { return false; }
}

export class WeatherFX {
  constructor(scene, camera) {
    this.scene = scene; this.camera = camera;
    this.cheap = cheapDevice();
    this.state = { rain: 0, storm: 0, cloud: 0.3, visibility: 20000, windSpd: 5, windDir: 240, night: 0 };
    this.cur = { rain: 0, storm: 0, cloud: 0.3 };
    this.flashT = 0; this.flashLevel = 0; this.nextFlash = 0; this.flickerAt = 0;
    this.darkening = 0;
    this.offset = new THREE.Vector2(0, 0); this.offsetHi = new THREE.Vector2(0, 0);
    this.group = new THREE.Group(); this.group.name = 'weatherFx'; scene.add(this.group);
    // lightning: one permanent hemisphere light (adding/removing lights would recompile every lit shader)
    this.flashLight = new THREE.HemisphereLight(0xdde8ff, 0x8899bb, 0); this.group.add(this.flashLight);
    this.clouds = [];
    this.clouds.push(this.makeCloud(1500, 26000, 1 / 2600, 0.35, 0.92, this.cheap ? 3 : 4));
    if (!this.cheap) this.clouds.push(this.makeCloud(4200, 44000, 1 / 9000, 0.55, 0.35, 3));
    this.makeRain(this.cheap ? 600 : 1800);
    // heavy weather
    this.heavyState = { hs: 0, gust: 0 };
    this.sprayPool = new SprayPool(this.group, this.cheap ? 260 : 900);
    this.lens = new LensDrops(this.cheap ? 0.25 : 0.5);
    this.bolt = this.makeBolt(); this.boltT = 0;
    this.onThunder = null;         // (k 0..1, delayS) → main.js plays the thunder after the light
    this.driftAcc = 0; this.rainHitAcc = 0;
  }
  makeBolt() {
    const mat = new THREE.MeshBasicMaterial({ color: 0xe8efff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide });
    const m = new THREE.Mesh(new THREE.BufferGeometry(), mat); m.frustumCulled = false; m.visible = false; m.renderOrder = -1;
    this.group.add(m);
    return m;
  }
  /** A jagged ribbon from the cloud base to the sea at (x, z), facing the camera (plus one branch). */
  buildBolt(x, z, top, cam) {
    const pts = [];
    let px = 0, pz = 0;
    const n = 16;
    for (let i = 0; i <= n; i++) { pts.push([px, top * (1 - i / n), pz]); px += (Math.random() - 0.5) * top * 0.09; pz += (Math.random() - 0.5) * top * 0.09; }
    const br = [], s = 4 + Math.floor(Math.random() * 6);
    let bx = pts[s][0], bz = pts[s][2], by = pts[s][1];
    for (let i = 0; i < 7; i++) { br.push([bx, by, bz]); bx += (Math.random() * 0.8 + 0.2) * top * 0.06 * (Math.random() < 0.5 ? -1 : 1); by -= top * 0.05; bz += (Math.random() - 0.5) * top * 0.05; }
    const toCam = new THREE.Vector3(cam.x - x, 0, cam.z - z).normalize(), side = new THREE.Vector3(-toCam.z, 0, toCam.x);
    const pos = [];
    const ribbon = (P, w) => { for (let i = 0; i < P.length - 1; i++) {
      const a = P[i], b = P[i + 1], wa = w * (1 - i / P.length * 0.6), wb = w * (1 - (i + 1) / P.length * 0.6);
      const A0 = [a[0] - side.x * wa, a[1], a[2] - side.z * wa], A1 = [a[0] + side.x * wa, a[1], a[2] + side.z * wa], B0 = [b[0] - side.x * wb, b[1], b[2] - side.z * wb], B1 = [b[0] + side.x * wb, b[1], b[2] + side.z * wb];
      pos.push(...A0, ...A1, ...B1, ...A0, ...B1, ...B0);
    } };
    ribbon(pts, top * 0.012); ribbon(br, top * 0.006);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.bolt.geometry.dispose(); this.bolt.geometry = g;
    this.bolt.position.set(x, 0, z);
  }
  /**
   * Heavy-weather inputs per frame from main.js: hs (m), bow {x,y,z} world, fwd {x,z} unit, shipSpd m/s, slam 0..1,
   * green 0..1, camNear (the camera is on / close to the ship and outdoors), seaY (water level near the ship).
   */
  heavy(h) {
    if (!h) return;
    const st = this.heavyState;
    Object.assign(st, h);
  }
  makeCloud(height, size, scale, soft, alpha, oct) {
    const uniforms = {
      uTime: { value: 0 }, uOffset: { value: new THREE.Vector2() }, uCover: { value: 0.3 }, uFlash: { value: 0 }, uStorm: { value: 0 }, uNight: { value: 0 },
      uColor: { value: new THREE.Color(0xf4f6f8) }, uShade: { value: new THREE.Color(0x6b7684) }, uScale: { value: scale }, uSoft: { value: soft }, uAlpha: { value: alpha }, uOct: { value: oct },
    };
    const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: CLOUD_VERT, fragmentShader: CLOUD_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false });
    const geo = new THREE.PlaneGeometry(size, size, 1, 1); geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; m.renderOrder = -1; m.position.y = height;
    m.userData.height = height; m.userData.size = size;
    this.group.add(m);
    return m;
  }
  makeRain(n) {
    const box = new THREE.Vector3(70, 36, 70);
    const off = new Float32Array(n * 3), seed = new Float32Array(n);
    for (let i = 0; i < n; i++) { off[i * 3] = Math.random() * box.x; off[i * 3 + 1] = Math.random() * box.y; off[i * 3 + 2] = Math.random() * box.z; seed[i] = Math.random(); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3)); // unused but required by Points
    geo.setAttribute('aOffset', new THREE.BufferAttribute(off, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.rainU = { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uBox: { value: box }, uDrift: { value: new THREE.Vector2() }, uDensity: { value: 0 }, uSize: { value: 2.2 }, uSpeed: { value: 9 }, uOpacity: { value: 0.55 } };
    const mat = new THREE.ShaderMaterial({ uniforms: this.rainU, vertexShader: RAIN_VERT, fragmentShader: RAIN_FRAG, transparent: true, depthWrite: false, fog: false });
    this.rain = new THREE.Points(geo, mat); this.rain.frustumCulled = false; this.rain.renderOrder = 5; this.rain.visible = false;
    this.group.add(this.rain);
  }
  /** Weather inputs (all optional): rain 0..1, storm 0..1, cloud 0..1, visibility m, windSpd m/s, windDir FROM deg, night 0..1. Also accepts game.weatherAt()'s nested shape. */
  set(wx) {
    if (!wx) return;
    const s = this.state;
    if (Number.isFinite(wx.rain)) s.rain = THREE.MathUtils.clamp(wx.rain, 0, 1);
    if (Number.isFinite(wx.storm)) s.storm = THREE.MathUtils.clamp(wx.storm, 0, 1);
    if (Number.isFinite(wx.cloud)) s.cloud = THREE.MathUtils.clamp(wx.cloud, 0, 1);
    else if (Number.isFinite(wx.storm) || Number.isFinite(wx.rain)) s.cloud = THREE.MathUtils.clamp(0.3 + s.storm * 0.7 + s.rain * 0.5, 0, 1);
    if (Number.isFinite(wx.visibility)) s.visibility = wx.visibility;
    const ws = Number.isFinite(wx.windSpd) ? wx.windSpd : wx.wind?.spd; if (Number.isFinite(ws)) s.windSpd = ws;
    const wd = Number.isFinite(wx.windDir) ? wx.windDir : wx.wind?.dir; if (Number.isFinite(wd)) s.windDir = wd;
    if (Number.isFinite(wx.night)) s.night = THREE.MathUtils.clamp(wx.night, 0, 1);
  }
  /** Trigger a lightning flash (sky/cloud brightening + hemisphere pulse, with a second flicker). main.js calls this on 'law' events too. */
  flash() {
    this.flashT = 1; this.flashLevel = 1; this.flickerAt = 0.08 + Math.random() * 0.12;
    // a visible bolt somewhere ahead-ish of the camera, 2–9 km off, from the low cloud base; thunder follows
    try {
      const cam = this.camera.position, dir = new THREE.Vector3(); this.camera.getWorldDirection(dir);
      const az = Math.atan2(dir.x, dir.z) + (Math.random() - 0.5) * 1.6, d = 2000 + Math.random() * 7000;
      const x = cam.x + Math.sin(az) * d, z = cam.z + Math.cos(az) * d;
      this.buildBolt(x, z, Math.max(500, this.clouds[0].userData.height * 0.9), cam);
      this.boltT = 0.22; this.bolt.visible = true;
      if (this.onThunder) this.onThunder(Math.min(1, 2500 / d), Math.min(9, d / 343));
    } catch { /* bolt is decoration */ }
  }
  update(dt, camPos, time) {
    dt = Number.isFinite(dt) ? Math.min(0.25, Math.max(0, dt)) : 0.016;
    const cam = camPos || this.camera.position;
    const s = this.state, c = this.cur;
    const k = Math.min(1, dt * 0.5);
    c.rain += (s.rain - c.rain) * k; c.storm += (s.storm - c.storm) * k; c.cloud += (s.cloud - c.cloud) * k;
    this.darkening = THREE.MathUtils.clamp(c.storm * 0.55 + c.cloud * 0.15 + c.rain * 0.1, 0, 0.7);
    // wind-driven drift of the cloud noise (clouds move at ~60 % of the surface wind at the low layer)
    const wa = (s.windDir + 180) * (Math.PI / 180);
    const wx = Math.sin(wa), wz = -Math.cos(wa);
    this.offset.x -= wx * s.windSpd * 0.6 * dt; this.offset.y -= wz * s.windSpd * 0.6 * dt;
    this.offsetHi.x -= wx * s.windSpd * 1.1 * dt; this.offsetHi.y -= wz * s.windSpd * 1.1 * dt;
    // lightning timing
    if (this.flashT > 0) {
      this.flashT = Math.max(0, this.flashT - dt * 4.5);
      if (this.flickerAt > 0) { this.flickerAt -= dt; if (this.flickerAt <= 0) { this.flashT = Math.max(this.flashT, 0.7); this.flickerAt = 0; } }
    }
    if (c.storm > 0.6) {
      this.nextFlash -= dt;
      if (this.nextFlash <= 0) { this.flash(); this.nextFlash = 3 + Math.random() * 14 / Math.max(0.2, c.storm - 0.5); }
    } else this.nextFlash = Math.max(this.nextFlash, 2);
    const flash = this.flashT * this.flashT;
    this.flashLight.intensity = flash * 2.4;
    const night = s.night;
    for (let i = 0; i < this.clouds.length; i++) {
      const m = this.clouds[i], u = m.material.uniforms;
      // the low deck sinks into dark, fast scud as the storm builds (1500 m → ~350 m)
      const hgt = i === 0 ? m.userData.height * (1 - 0.77 * c.storm) : m.userData.height;
      m.position.set(cam.x, cam.y + hgt, cam.z);
      u.uTime.value = time; u.uOffset.value.copy(i === 0 ? this.offset : this.offsetHi);
      u.uCover.value = i === 0 ? c.cloud : Math.min(0.75, c.cloud * 0.6 + 0.15);
      u.uStorm.value = c.storm; u.uFlash.value = flash; u.uNight.value = night;
      const day = 1 - night;
      const dk = 1 - 0.35 * c.storm;                     // storm: the lit tops go dull grey too
      u.uColor.value.setRGB(0.95 * day * dk + 0.08, 0.96 * day * dk + 0.09, 0.97 * day * dk + 0.12);
      u.uShade.value.setRGB(0.42 * day + 0.03, 0.46 * day + 0.035, 0.52 * day + 0.05);
      m.visible = u.uCover.value > 0.02;
    }
    const r = this.rainU;
    this.rain.visible = c.rain > 0.02;
    if (this.rain.visible) {
      r.uTime.value = time; r.uCam.value.copy(cam);
      r.uDensity.value = THREE.MathUtils.clamp(c.rain * 1.1, 0, 1);
      const drift = Math.min(12, s.windSpd * 0.6);
      r.uDrift.value.set(wx * drift, wz * drift);
      r.uSpeed.value = 8 + c.storm * 4; r.uOpacity.value = 0.35 + 0.35 * c.rain;
    }
    // lightning bolt fades with the flash
    if (this.boltT > 0) { this.boltT -= dt; this.bolt.material.opacity = Math.max(0, Math.min(1, this.boltT / 0.12)) * (this.flashT > 0.3 ? 1 : 0.6); if (this.boltT <= 0) this.bolt.visible = false; }
    this.updateHeavy(dt, wx, wz);
  }
  updateHeavy(dt, wx, wz) {
    const h = this.heavyState, s = this.state, U = s.windSpd, hs = h.hs || 0;
    const windX = wx * U * 0.85, windZ = wz * U * 0.85;            // spray moves downwind (wx,wz = the TO direction)
    const pool = this.sprayPool, rnd = Math.random;
    const bow = h.bow, seaY = Number.isFinite(h.seaY) ? h.seaY : 0;
    // slam: a sheet of spray thrown up and out over the bow
    if (bow && h.slam > 0.45 && (this.lastSlam || 0) < h.slam - 0.2) {
      const n = Math.round((this.cheap ? 50 : 140) * h.slam), fx = h.fwd?.x || 0, fz = h.fwd?.z || 0;
      for (let i = 0; i < n; i++) {
        const sd = (rnd() - 0.5) * 2, up = 6 + rnd() * 10 * h.slam;
        pool.emit(bow.x + (rnd() - 0.5) * 4, bow.y - 1 + rnd() * 2, bow.z + (rnd() - 0.5) * 4, fx * (h.shipSpd || 0) * 0.6 - fz * sd * 7, up, fz * (h.shipSpd || 0) * 0.6 + fx * sd * 7, 1.2 + rnd() * 1.6, 0.8 + rnd() * 2.2);
      }
      if (h.camNear) this.lens.splash(0.2 + 0.5 * h.slam * (h.camBow ? 1 : 0.45));
    }
    this.lastSlam = h.slam || 0;
    // green water: solid water and foam running aft over the foredeck
    if (bow && h.green > 0.05) {
      const n = Math.round((this.cheap ? 6 : 16) * h.green), fx = h.fwd?.x || 0, fz = h.fwd?.z || 0;
      for (let i = 0; i < n; i++) {
        const sd = (rnd() - 0.5) * (h.beam || 10) * 0.8, back = rnd() * (h.length || 60) * 0.18;
        pool.emit(bow.x - fx * back - fz * sd, bow.y + 0.3 + rnd(), bow.z - fz * back + fx * sd, -fx * (4 + rnd() * 5), 1 + rnd() * 2, -fz * (4 + rnd() * 5), 0.8 + rnd(), 1.5 + rnd() * 2.5);
      }
      if (h.camNear && h.camBow && rnd() < h.green * dt * 6) this.lens.splash(0.35 * h.green);
    }
    // spindrift: from ~Bft 8 sheets of spray blow off the crests and stream downwind around the ship, close to the water
    const drift = Math.max(0, Math.min(1, (U - 15) / 15)) * Math.min(1, hs / 3);
    if (drift > 0 && h.center) {
      this.driftAcc += dt * drift * (this.cheap ? 70 : 220);
      const R = 90 + 6 * U;
      while (this.driftAcc >= 1) {
        this.driftAcc -= 1;
        const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * R;
        const x = h.center.x + Math.cos(a) * r, z = h.center.z + Math.sin(a) * r;
        pool.emit(x, seaY + 0.3 + rnd() * hs * 0.3, z, windX * (0.6 + rnd() * 0.5), 0.3 + rnd() * 1.2, windZ * (0.6 + rnd() * 0.5), 1 + rnd() * 1.4, 0.8 + rnd() * 2 * drift);
      }
    }
    pool.u.uCol.value.setRGB(0.88, 0.92, 0.95).multiplyScalar(1 - 0.55 * s.night);
    pool.update(dt, windX, windZ, seaY);
    // rain and blown spray on the lens when the camera is outdoors (more when it faces the wind)
    if (h.camNear !== undefined && h.outdoors) {
      const face = Math.max(0, h.faceWind ?? 0.5);
      this.rainHitAcc += dt * (this.cur.rain * 6 * (0.3 + face) + drift * 10 * face);
      while (this.rainHitAcc >= 1) { this.rainHitAcc -= 1; this.lens.hit(1, drift > 0.5 && rnd() < 0.3); }
    } else if (h.outdoors === false) this.lens.clear();
    this.lens.update(dt);
  }
  /** 0..1 flash brightness this frame — main.js may add it to its sky / fog colours. */
  get flashNow() { return this.flashT * this.flashT; }
  dispose() {
    this.scene.remove(this.group);
    for (const m of this.clouds) { m.geometry.dispose(); m.material.dispose(); }
    this.rain.geometry.dispose(); this.rain.material.dispose();
    this.clouds.length = 0;
  }
}
