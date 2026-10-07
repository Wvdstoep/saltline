// Weather effects around the camera: two wind-driven alpha-noise cloud layers (low cover + high cirrus), GPU-animated
// rain streaks (Points in a box that follows the camera, falling with the wind), lightning (sky/cloud flash + a
// hemisphere light pulse; random when storm > 0.6, or on demand via flash()) and a storm-darkening value main.js can
// fold into its lights. Fog distance itself is set by main.js from the visibility. Cheap on mobile: one cloud layer,
// fewer rain particles, fewer noise octaves.
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
  col = mix(col, col * 0.55, uStorm * 0.5);
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
  flash() { this.flashT = 1; this.flashLevel = 1; this.flickerAt = 0.08 + Math.random() * 0.12; }
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
      m.position.set(cam.x, cam.y + m.userData.height, cam.z);
      u.uTime.value = time; u.uOffset.value.copy(i === 0 ? this.offset : this.offsetHi);
      u.uCover.value = i === 0 ? c.cloud : Math.min(0.75, c.cloud * 0.6 + 0.15);
      u.uStorm.value = c.storm; u.uFlash.value = flash; u.uNight.value = night;
      const day = 1 - night;
      u.uColor.value.setRGB(0.95 * day + 0.08, 0.96 * day + 0.09, 0.97 * day + 0.12);
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
