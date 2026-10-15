// Weather effects around the camera (the clouds themselves live in sky.js / clouds.js):
//  - rain: thin, motion-blurred streaks (instanced quads expanded to ~1 px in screen space, so they never turn into
//    the old wide white bars), falling at 6-9 m/s and slanted by the wind; distant rain SHEETS on two cylinders
//    around the camera (streaky alpha that scrolls with the fall and drifts with gusts); splashes / rings on the sea
//    are drawn by the ocean shader (ocean.setRain);
//  - snow (temperature below ~1 C): small soft flakes that drift, sway and fall at ~1 m/s; sleet mixes both;
//  - lightning (storms): cloud-to-ground strokes with a branching bolt, intra-cloud flashes without one, 1-4 return
//    strokes per flash; the flash lights the clouds from inside (sky.js reads flashNow / flashPos), pulses a
//    hemisphere light, and thunder follows after distance / 343 m/s (onThunder -> sound.js);
//  - heavy weather (scaled by wind / Hs): blown spray and spindrift, slams over the bow, green water on deck and drops
//    on the camera "lens" (unchanged from v0.3).
// Budgets: cheap devices (phones) get about a third of the particles and one rain-sheet cylinder.
import * as THREE from 'three';

const RAIN_VERT = /* glsl */`
attribute vec2 corner; attribute vec3 aOffset; attribute float aSeed;
uniform float uTime; uniform vec3 uCam; uniform vec3 uBox; uniform vec2 uWind; uniform float uDensity; uniform float uFall;
uniform float uLen; uniform vec2 uViewport; uniform float uPx;
varying float vA; varying float vU;
void main() {
  float on = step(aSeed, uDensity);
  float big = fract(aSeed * 13.71);
  float sp = uFall * (0.7 + 0.55 * big);                       // bigger drops fall faster
  vec3 vel = vec3(uWind.x, -sp, uWind.y) * (0.92 + 0.16 * fract(aSeed * 7.13));
  vec3 rel = aOffset + vel * uTime - uCam;
  rel = mod(rel + uBox * 0.5, uBox) - uBox * 0.5;
  vec3 head = uCam + rel, tail = head - vel * uLen;
  vec4 ch = projectionMatrix * viewMatrix * vec4(head, 1.0);
  vec4 ct = projectionMatrix * viewMatrix * vec4(tail, 1.0);
  if (on < 0.5 || ch.w < 0.3 || ct.w < 0.3) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vA = 0.0; vU = 0.0; return; }
  vec4 c = mix(ch, ct, corner.y);
  vec2 sh = ch.xy / ch.w, st = ct.xy / ct.w;
  vec2 dd = (st - sh) * uViewport;
  vec2 dir = length(dd) > 1e-3 ? normalize(dd) : vec2(0.0, 1.0);
  vec2 perp = vec2(-dir.y, dir.x);
  float wpx = max(uPx * 1.1, (0.0022 + 0.002 * big) * uViewport.y / c.w);
  c.xy += perp * corner.x * (wpx / uViewport) * c.w;
  float dist = length(rel);
  vA = (1.0 - smoothstep(uBox.x * 0.28, uBox.x * 0.5, length(rel.xz))) * smoothstep(0.35, 1.5, dist) * (0.55 + 0.45 * big)
     * min(1.0, uPx * 1.1 / wpx * 2.0);                       // a streak thinner than a pixel is spread, not brighter
  vU = corner.x;
  gl_Position = c;
}`;
const RAIN_FRAG = /* glsl */`
varying float vA; varying float vU; uniform vec3 uCol; uniform float uOpacity;
void main() {
  float a = vA * uOpacity * (1.0 - 0.6 * vU * vU);
  if (a < 0.004) discard;
  gl_FragColor = vec4(uCol, a);
}`;

const SNOW_VERT = /* glsl */`
attribute vec2 corner; attribute vec3 aOffset; attribute float aSeed;
uniform float uTime; uniform vec3 uCam; uniform vec3 uBox; uniform vec2 uWind; uniform float uDensity; uniform vec2 uViewport; uniform float uPx;
varying float vA; varying vec2 vC;
void main() {
  float on = step(aSeed, uDensity);
  float fall = 0.7 + 0.8 * fract(aSeed * 5.31);
  vec3 p = aOffset + vec3(uWind.x * uTime, -fall * uTime, uWind.y * uTime);
  p.x += sin(uTime * (0.9 + aSeed) + aSeed * 40.0) * 0.45;
  p.z += cos(uTime * (0.7 + aSeed * 0.8) + aSeed * 23.0) * 0.45;
  vec3 rel = mod(p - uCam + uBox * 0.5, uBox) - uBox * 0.5;
  vec4 mv = viewMatrix * vec4(uCam + rel, 1.0);
  float size = 0.006 + 0.008 * fract(aSeed * 17.3);
  vec4 c = projectionMatrix * mv;
  if (on < 0.5 || c.w < 0.25) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vA = 0.0; vC = vec2(0.0); return; }
  float px = max(size * uViewport.y / c.w, uPx * 1.3);
  c.xy += corner * (px / uViewport) * c.w;
  vA = (1.0 - smoothstep(uBox.x * 0.3, uBox.x * 0.5, length(rel.xz))) * smoothstep(0.3, 1.0, length(rel)) * min(1.0, size * uViewport.y / c.w / (uPx * 1.3) + 0.25);
  vC = corner;
  gl_Position = c;
}`;
const SNOW_FRAG = /* glsl */`
varying float vA; varying vec2 vC; uniform vec3 uCol; uniform float uOpacity;
void main() {
  float r = dot(vC, vC);
  float a = vA * uOpacity * (1.0 - smoothstep(0.25, 1.0, r));
  if (a < 0.004) discard;
  gl_FragColor = vec4(uCol, a);
}`;

const SHEET_VERT = /* glsl */`
varying vec3 vL; varying vec3 vW;
void main() { vL = position; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const SHEET_FRAG = /* glsl */`
varying vec3 vL; varying vec3 vW;
uniform float uTime; uniform float uI; uniform vec2 uWind; uniform float uFall; uniform vec3 uCol; uniform float uR;
float h(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
float n(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
void main() {
  float ang = atan(vL.z, vL.x);
  vec2 tang = vec2(-sin(ang), cos(ang));
  float along = ang * uR;                                   // metres around the cylinder
  float slant = dot(uWind, tang) / max(uFall, 0.5);         // wind across the line of sight slants the streaks
  float y = vL.y + uTime * uFall;
  float x = along + vL.y * slant;
  float streak = n(vec2(x * 0.9, y * 0.03)) * 0.6 + n(vec2(x * 2.3, y * 0.07)) * 0.4;
  streak = pow(streak, 2.5);
  float gust = 0.45 + 0.9 * n(vec2(along * 0.006 + uTime * 0.05, uTime * 0.07));
  float hgt = smoothstep(-6.0, 4.0, vL.y) * (1.0 - smoothstep(60.0, 180.0, vL.y));
  float a = uI * (0.08 + 0.55 * streak) * gust * hgt;
  if (a < 0.003) discard;
  gl_FragColor = vec4(uCol, min(a, 0.6));
}`;

const SPRAY_VERT = /* glsl */`
attribute float aLife; attribute float aSize;
uniform float uScale;
varying float vA;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vA = clamp(aLife, 0.0, 1.0);
  gl_PointSize = clamp(aSize * uScale / max(1.0, -mv.z), 1.0, 36.0);
  gl_Position = projectionMatrix * mv;
}`;
const SPRAY_FRAG = /* glsl */`
uniform vec3 uCol; varying float vA;
void main() {
  vec2 d = gl_PointCoord - 0.5; float r = dot(d, d) * 4.0;
  float a = (1.0 - smoothstep(0.0, 1.0, r)) * vA * 0.22;    // translucent fine mist, never an opaque wall
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
    for (let i = 0; i < n && this.drops.length < 90; i++) {
      const r = big ? 1.8 + Math.random() * 2.2 : 0.9 + Math.random() * 1.5;
      this.drops.push({ x: Math.random(), y: Math.random() * 0.9, r, life: big ? 1.8 + Math.random() * 2.0 : 0.8 + Math.random() * 1.4, run: big && Math.random() < 0.35 ? 0.02 + Math.random() * 0.04 : 0 });
      this.drops[this.drops.length - 1].max = this.drops[this.drops.length - 1].life;
    }
  }
  splash(k) { this.veil = Math.max(this.veil, Math.min(0.14, k * 0.25)); this.hit(Math.round(4 + 10 * k), true); }
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
      const a = Math.min(1, d.life / d.max * 2) * 0.35, x = d.x * W, y = d.y * H, r = d.r * k * 1.2;
      // a lens drop: subtle realistic water bead, delicate refraction
      const g = c.createRadialGradient(x, y, r * 0.5, x, y + r * 0.1, r);
      g.addColorStop(0, `rgba(200,215,225,${a * 0.04})`); g.addColorStop(0.8, `rgba(40,55,70,${a * 0.12})`); g.addColorStop(1, 'rgba(40,55,70,0)');
      c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
      c.fillStyle = `rgba(255,255,255,${a * 0.4})`; c.beginPath(); c.arc(x - r * 0.35, y - r * 0.4, Math.max(0.4, r * 0.12), 0, Math.PI * 2); c.fill();
      if (d.run) { c.strokeStyle = `rgba(200,215,225,${a * 0.2})`; c.lineWidth = Math.max(0.8, r * 0.25); c.beginPath(); c.moveTo(x, y - r * 3); c.lineTo(x, y); c.stroke(); }
    }
  }
}


function cheapDevice() {
  try {
    const touch = (window.matchMedia && matchMedia('(pointer: coarse)').matches) || navigator.maxTouchPoints > 1;
    return touch || (navigator.hardwareConcurrency || 8) <= 4;
  } catch { return false; }
}

/** Instanced quad geometry: n instances of a 4-vertex quad with per-instance random offsets in the box. */
function particleGeometry(n, box, corners) {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(12), 3));
  g.setAttribute('corner', new THREE.Float32BufferAttribute(corners, 2));
  g.setIndex([0, 1, 2, 2, 1, 3]);
  const off = new Float32Array(n * 3), seed = new Float32Array(n);
  for (let i = 0; i < n; i++) { off[i * 3] = Math.random() * box.x; off[i * 3 + 1] = Math.random() * box.y; off[i * 3 + 2] = Math.random() * box.z; seed[i] = Math.random(); }
  g.setAttribute('aOffset', new THREE.InstancedBufferAttribute(off, 3));
  g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 1));
  g.instanceCount = n;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  return g;
}

export class WeatherFX {
  constructor(scene, camera) {
    this.scene = scene; this.camera = camera;
    this.cheap = cheapDevice();
    this.state = { rain: 0, storm: 0, cloud: 0.3, visibility: 20000, windSpd: 5, windDir: 240, night: 0, temp: 12 };
    this.cur = { rain: 0, storm: 0, cloud: 0.3, snow: 0 };
    this.flashT = 0; this.flashLevel = 0; this.nextFlash = 2; this.strokes = []; this.flashPos = null; this.flashNear = 0;
    this.darkening = 0;
    this.group = new THREE.Group(); this.group.name = 'weatherFx'; scene.add(this.group);
    // lightning: one permanent hemisphere light (adding/removing lights would recompile every lit shader)
    this.flashLight = new THREE.HemisphereLight(0xdde8ff, 0x8899bb, 0); this.group.add(this.flashLight);
    this.clouds = [];                                  // the clouds moved to sky.js; kept for old callers
    this.skyCol = new THREE.Color(0.7, 0.75, 0.8);
    this.viewport = new THREE.Vector2(1, 1); this.px = 1;
    this.makeRain(this.cheap ? 3500 : 10000);
    this.makeSnow(this.cheap ? 2200 : 7000);
    this.makeSheets(this.cheap ? [140] : [110, 300]);
    // heavy weather
    this.heavyState = { hs: 0, gust: 0 };
    this.sprayPool = new SprayPool(this.group, this.cheap ? 260 : 900);
    this.lens = new LensDrops(this.cheap ? 0.25 : 0.5);
    this.bolt = this.makeBolt(); this.boltT = 0;
    this.onThunder = null;         // (k 0..1, delayS) -> main.js plays the thunder after the light
    this.driftAcc = 0; this.rainHitAcc = 0;
  }
  makeBolt() {
    const mat = new THREE.MeshBasicMaterial({ color: 0xeef3ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide, toneMapped: false });
    const m = new THREE.Mesh(new THREE.BufferGeometry(), mat); m.frustumCulled = false; m.visible = false; m.renderOrder = 3;
    this.group.add(m);
    return m;
  }
  /** A branching, jagged bolt from the cloud base (top, m) to the sea at (x, z), as camera-facing ribbons. */
  buildBolt(x, z, top, cam) {
    const toCam = new THREE.Vector3(cam.x - x, 0, cam.z - z).normalize(), side = new THREE.Vector3(-toCam.z, 0, toCam.x);
    const pos = [];
    const ribbon = (P, w0, w1) => {
      for (let i = 0; i < P.length - 1; i++) {
        const a = P[i], b = P[i + 1], wa = w0 + (w1 - w0) * (i / (P.length - 1)), wb = w0 + (w1 - w0) * ((i + 1) / (P.length - 1));
        pos.push(a[0] - side.x * wa, a[1], a[2] - side.z * wa, a[0] + side.x * wa, a[1], a[2] + side.z * wa, b[0] + side.x * wb, b[1], b[2] + side.z * wb,
          a[0] - side.x * wa, a[1], a[2] - side.z * wa, b[0] + side.x * wb, b[1], b[2] + side.z * wb, b[0] - side.x * wb, b[1], b[2] - side.z * wb);
      }
    };
    // midpoint-displacement main channel
    const walk = (p0, p1, depth, rough) => {
      let pts = [p0, p1];
      for (let d = 0; d < depth; d++) {
        const nx = [];
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i], b = pts[i + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
          nx.push(a, [(a[0] + b[0]) / 2 + (Math.random() - 0.5) * len * rough, (a[1] + b[1]) / 2 + (Math.random() - 0.5) * len * rough * 0.3, (a[2] + b[2]) / 2 + (Math.random() - 0.5) * len * rough]);
        }
        nx.push(pts[pts.length - 1]); pts = nx;
      }
      return pts;
    };
    const main = walk([0, top, 0], [(Math.random() - 0.5) * top * 0.25, 0, (Math.random() - 0.5) * top * 0.25], 6, 0.55);
    ribbon(main, top * 0.006, top * 0.004);
    ribbon(main, top * 0.03, top * 0.02);                   // glow around the channel
    const nb = 2 + Math.floor(Math.random() * 4);
    for (let k = 0; k < nb; k++) {
      const i = 6 + Math.floor(Math.random() * (main.length * 0.6)), a = main[Math.min(i, main.length - 2)];
      const ln = top * (0.12 + Math.random() * 0.25), ang = Math.random() * Math.PI * 2;
      const br = walk(a, [a[0] + Math.cos(ang) * ln * 0.6, a[1] - ln, a[2] + Math.sin(ang) * ln * 0.6], 4, 0.6);
      ribbon(br, top * 0.0035, top * 0.0008);
    }
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
    Object.assign(this.heavyState, h);
  }
  makeRain(n) {
    const box = new THREE.Vector3(44, 24, 44);
    const geo = particleGeometry(n, box, [-1, 0, 1, 0, -1, 1, 1, 1]);
    this.rainU = { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uBox: { value: box }, uWind: { value: new THREE.Vector2() }, uDensity: { value: 0 }, uFall: { value: 7.5 },
      uLen: { value: 0.035 }, uViewport: { value: this.viewport }, uPx: { value: 1 }, uCol: { value: new THREE.Color() }, uOpacity: { value: 0.3 } };
    const mat = new THREE.ShaderMaterial({ uniforms: this.rainU, vertexShader: RAIN_VERT, fragmentShader: RAIN_FRAG, transparent: true, depthWrite: false, fog: false });
    this.rain = new THREE.Mesh(geo, mat); this.rain.frustumCulled = false; this.rain.renderOrder = 5; this.rain.visible = false;
    this.group.add(this.rain);
  }
  makeSnow(n) {
    const box = new THREE.Vector3(36, 22, 36);
    const geo = particleGeometry(n, box, [-1, -1, 1, -1, -1, 1, 1, 1]);
    this.snowU = { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uBox: { value: box }, uWind: { value: new THREE.Vector2() }, uDensity: { value: 0 },
      uViewport: { value: this.viewport }, uPx: { value: 1 }, uCol: { value: new THREE.Color() }, uOpacity: { value: 0.85 } };
    const mat = new THREE.ShaderMaterial({ uniforms: this.snowU, vertexShader: SNOW_VERT, fragmentShader: SNOW_FRAG, transparent: true, depthWrite: false, fog: false });
    this.snow = new THREE.Mesh(geo, mat); this.snow.frustumCulled = false; this.snow.renderOrder = 5; this.snow.visible = false;
    this.group.add(this.snow);
  }
  makeSheets(radii) {
    this.sheets = radii.map((R) => {
      const u = { uTime: { value: 0 }, uI: { value: 0 }, uWind: { value: new THREE.Vector2() }, uFall: { value: 7 }, uCol: { value: new THREE.Color() }, uR: { value: R } };
      const geo = new THREE.CylinderGeometry(R, R, 200, 64, 1, true); geo.translate(0, 95, 0);
      const m = new THREE.Mesh(geo, new THREE.ShaderMaterial({ uniforms: u, vertexShader: SHEET_VERT, fragmentShader: SHEET_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false }));
      m.frustumCulled = false; m.renderOrder = 4; m.visible = false; m.userData.u = u;
      this.group.add(m);
      return m;
    });
  }
  /**
   * Weather inputs (all optional): rain 0..1, storm 0..1, cloud 0..1, visibility m, windSpd m/s, windDir FROM deg,
   * night 0..1, temp deg C. Also accepts game.weatherAt()'s nested shape.
   */
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
    if (Number.isFinite(wx.temp)) s.temp = wx.temp;
  }
  /** Sky light for the precipitation (sky.js state): hor = horizon radiance (THREE.Color, pre-tone-map). */
  setSkyLight(hor) {
    if (!hor) return;
    const t = (v) => v / (1 + v);
    this.skyCol.setRGB(t(hor.r * 1.6), t(hor.g * 1.6), t(hor.b * 1.6));
  }
  /** Trigger a lightning flash. main.js may call this on 'law' events too. opts.ground forces a visible bolt. */
  flash(opts = {}) {
    try {
      const cam = this.camera.position, dir = new THREE.Vector3(); this.camera.getWorldDirection(dir);
      const ahead = opts.ground || Math.random() < 0.6;
      const az = Math.atan2(dir.x, dir.z) + (ahead ? (Math.random() - 0.5) * 1.4 : Math.random() * Math.PI * 2);
      const d = opts.dist || 1500 + Math.random() * Math.random() * 13000;
      const x = cam.x + Math.sin(az) * d, z = cam.z + Math.cos(az) * d;
      const cg = opts.ground || Math.random() < 0.35;          // cloud-to-ground; the rest light the cloud from inside
      const base = this.cloudBase || 800;
      this.flashPos = new THREE.Vector3(x, base + 600, z);
      this.flashNear = Math.min(1, 3000 / d);
      // 1-4 return strokes in ~0.5 s
      const n = 1 + Math.floor(Math.random() * (cg ? 4 : 2));
      this.strokes = []; let t = 0;
      for (let i = 0; i < n; i++) { this.strokes.push({ t, k: i === 0 ? 1 : 0.5 + Math.random() * 0.5 }); t += 0.05 + Math.random() * 0.12; }
      this.flashClock = 0;
      if (cg) { this.buildBolt(x, z, Math.max(300, base), cam); this.boltT = t + 0.12; this.bolt.visible = true; }
      if (this.onThunder) this.onThunder(Math.min(1, 2500 / d), Math.min(30, d / 343));
    } catch { /* lightning is decoration */ }
  }
  update(dt, camPos, time) {
    dt = Number.isFinite(dt) ? Math.min(0.25, Math.max(0, dt)) : 0.016;
    const cam = camPos || this.camera.position;
    const s = this.state, c = this.cur;
    const k = Math.min(1, dt * 0.3);
    c.rain += (s.rain - c.rain) * k; c.storm += (s.storm - c.storm) * k; c.cloud += (s.cloud - c.cloud) * k;
    const snowT = s.rain > 0 ? THREE.MathUtils.clamp((2 - s.temp) / 2, 0, 1) : c.snow;
    c.snow += (snowT - c.snow) * k;
    this.darkening = THREE.MathUtils.clamp(c.storm * 0.55 + c.cloud * 0.15 + c.rain * 0.1, 0, 0.7);
    const wa = (s.windDir + 180) * (Math.PI / 180);
    const wx = Math.sin(wa), wz = -Math.cos(wa);
    // viewport for the screen-space particle widths
    if (typeof innerWidth === 'number') { this.px = Math.min(2, (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1)); this.viewport.set(innerWidth * this.px, innerHeight * this.px); }
    // ---- lightning: thunderstorms flash every few seconds to a minute
    if (c.storm > 0.45) {
      this.nextFlash -= dt;
      if (this.nextFlash <= 0) { this.flash(); const m = 4 + 40 * (1 - c.storm) ** 2; this.nextFlash = -Math.log(1 - Math.random() * 0.95) * m; }
    } else this.nextFlash = Math.max(this.nextFlash, 3);
    let f = 0;
    if (this.strokes.length) {
      this.flashClock += dt;
      for (const st of this.strokes) { const tt = this.flashClock - st.t; if (tt >= 0) f = Math.max(f, st.k * Math.exp(-tt / 0.045)); }
      if (this.flashClock > this.strokes[this.strokes.length - 1].t + 0.5) this.strokes = [];
    }
    this.flashT = f;
    this.flashLight.intensity = f * (0.6 + 2.4 * this.flashNear);
    // ---- precipitation
    const night = s.night, sky = this.skyCol;
    const rainAmt = c.rain * (1 - c.snow), snowAmt = c.rain * c.snow;
    const fl = 1 + f * 4 * this.flashNear;
    const drift = Math.min(18, s.windSpd * 0.9);
    const r = this.rainU;
    this.rain.visible = rainAmt > 0.01;
    if (this.rain.visible) {
      r.uTime.value = time % 1000; r.uCam.value.copy(cam);
      r.uDensity.value = THREE.MathUtils.clamp(0.15 + rainAmt * 0.95, 0, 1) * Math.min(1, rainAmt * 6);
      r.uWind.value.set(wx * drift, wz * drift);
      r.uFall.value = 7.5 + c.storm * 1.5;
      r.uPx.value = this.px;
      r.uCol.value.copy(sky).multiplyScalar(1.15 * fl);
      r.uOpacity.value = (0.22 + 0.18 * rainAmt) * (1 - 0.35 * night);
    }
    const sn = this.snowU;
    this.snow.visible = snowAmt > 0.01;
    if (this.snow.visible) {
      sn.uTime.value = time % 1000; sn.uCam.value.copy(cam);
      sn.uDensity.value = THREE.MathUtils.clamp(0.1 + snowAmt, 0, 1);
      sn.uWind.value.set(wx * drift * 0.8, wz * drift * 0.8);
      sn.uPx.value = this.px;
      sn.uCol.value.copy(sky).multiplyScalar(1.5 * fl).addScalar(0.08);
    }
    for (const m of this.sheets) {
      const u = m.userData.u, I = rainAmt * 0.55 + snowAmt * 0.4;
      m.visible = I > 0.03;
      if (!m.visible) continue;
      m.position.set(cam.x, 0, cam.z);
      u.uTime.value = time % 1000; u.uI.value = I * (0.6 + 0.4 * c.storm);
      u.uWind.value.set(wx * drift, wz * drift); u.uFall.value = snowAmt > rainAmt ? 1.2 : 7.5;
      u.uCol.value.copy(sky).multiplyScalar(0.95 * fl);
    }
    // lightning bolt fades with the strokes
    if (this.boltT > 0) {
      this.boltT -= dt;
      this.bolt.material.opacity = Math.min(1, f * 1.4 + 0.15) * (this.boltT > 0 ? 1 : 0);
      if (this.boltT <= 0) this.bolt.visible = false;
    }
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
  /** 0..1 flash brightness this frame — sky.js lights the clouds with it, main.js may add it to its lights. */
  get flashNow() { return this.flashT; }
  dispose() {
    this.scene.remove(this.group);
    for (const m of [this.rain, this.snow, ...this.sheets]) { m.geometry.dispose(); m.material.dispose(); }
  }
}
