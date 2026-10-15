// public/js/sky.js - the whole sky and the light it casts: a physically based atmosphere dome (atmos.js: Rayleigh,
// Mie, ozone, Earth shadow, multiple-scattering term) lit by the real Sun and Moon (shared/astro.js), the celestial
// sphere behind it (celestial.js), clouds from the real weather (volumetric on desktop - clouds.js - 2D layers on
// phones), cirrus, a low fog/haze layer from the reported visibility, and from the same model: the sun/moon light
// (colour + intensity, dimmed when a cloud covers the Sun), the hemisphere light, the scene fog colour/distance, the
// ocean's sky uniforms and a PMREM scene.environment rebuilt when the sky changes.
//
// Compositing: the celestial objects are drawn first (additive, renderOrder -20..-18), then this dome (transparent,
// renderOrder -10, after all opaque geometry) with blending  out = sky + background * T  where T = transmittance of
// atmosphere x clouds x fog. Opaque things occlude the dome by depth, so the dome only shades empty sky.
//
// Units: radiance for a top-of-atmosphere Sun of 1, times the exposure K, then the renderer's ACES tone mapping.
// EXPOSURE is a fixed curve of the Sun's elevation (skywx.exposureCurve), calibrated once from the model itself so
// that an 18 % grey facing a high Sun displays as sRGB 0.45 (skywx.calibrateDayExposure): the sun disc is the only
// thing near white, a sunlit white hull lands around 0.85 and a shaded one around 0.35. SKY_GAIN lifts the
// single-scattering sky to the measured diffuse/direct ratio (~17 % on a clear day) so shade is never black.
// LIGHT BUDGET (no double counting): the Sun is one DirectionalLight with irradiance T_sun * K; the sky's
// irradiance pi * L_sky is shared between the HemisphereLight (every material) and the PMREM environment (standard
// materials only; three.js gives Lambert materials no IBL): hemisphere = (1 - ENV_SHARE), environment = ENV_SHARE.  Debug: ?sky=low|medium|high (cloud tier), ?wx=<preset> (skywx.WX_PRESETS),
// ?skyenv=0 (no environment map), window.saltlineSky(preset|object|null).
import * as THREE from 'three';
import { solarPosition, lunarPosition } from '/shared/astro.js';
import { ATMOS_GLSL, skyRadiance, skyAmbient, transmittance, mieForVisibility, luminance, MIE_G } from './atmos.js';
import { weatherMap, sampleMap } from './skynoise.js';
import { cloudParams, limitingMagnitude, moonPhaseLaw, twilightLuminance, acesTone, acesInputFor, exposureCurve, calibrateDayExposure, NIGHT_RATIO, FULL_MOON_E, WX_PRESETS } from './skywx.js';
import { VolumeClouds, canRenderHalfFloat } from './clouds.js';
import { CelestialSphere } from './celestial.js';

const D2R = Math.PI / 180;
const DOME_R = 39000;
const SKY_GAIN = 2.0;          // sky radiance relative to the single-scattering model (measured diffuse / direct ratio)
const ENV_SHARE = 0.5;         // the part of the sky irradiance the environment map carries (the hemisphere light the rest)
const HEMI_CAP = 3.0;          // cap on the sky irradiance fed to the hemisphere + environment (display units)
const MOON_SKY = 3.0;          // display radiance scale of the moonlit sky (scotopic look: the eye sees it, the exposure does not)
const MOON_LIGHT = 0.42;       // DirectionalLight irradiance of a high full Moon (display units)
const OVERCAST_GREY = 0.35;    // display value of a 0.18 grey at noon under a plain overcast (sRGB)
const STORM_GREY = 0.21;       // ... under a storm deck: dark and moody, still readable
const NIGHT_FLOOR = 0.035;     // starlight / airglow floor of the hemisphere light so ships never go black
const WRAP = 420000;           // stable-coordinate wrap: a common multiple of every cloud noise tile (m)
const WMAP = 60000;

const VERT = /* glsl */`
uniform vec3 uSunDir; uniform vec3 uMoonDir; uniform float uCamH; uniform float uMie;
varying vec3 vDir; varying vec3 vR1; varying vec3 vM1; varying vec3 vR2; varying vec3 vM2; varying vec3 vMs; varying vec3 vTv;
${ATMOS_GLSL}
void main() {
  vDir = normalize(position);
  atmosScatter(uCamH, vDir, uSunDir, uMoonDir, uMie, vR1, vM1, vR2, vM2, vMs, vTv);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */`
precision highp float;
uniform vec3 uSunDir; uniform vec3 uMoonDir; uniform float uCamH;
uniform vec3 uSunE; uniform vec3 uMoonE; uniform vec3 uAmb; uniform float uMieG;
uniform vec3 uSunDisc; uniform vec3 uAirglow; uniform vec3 uCityGlow; uniform vec3 uSeaCol; uniform vec3 uTwiZen; uniform vec3 uTwiGlow;
uniform sampler2D uWeather; uniform sampler2D uCloudTex; uniform int uCloudMode; uniform vec2 uViewport;
uniform vec2 uCamXZ; uniform vec2 uWindOff; uniform vec2 uWindOffHi; uniform float uHiAngle;
uniform float uCover; uniform float uHigh; uniform float uBase; uniform float uThick; uniform float uCbTop; uniform float uCb; uniform float uStratus; uniform float uDens; uniform float uHazeDist;
uniform vec3 uLightDir; uniform vec3 uLightCol; uniform vec3 uDiffCol; uniform vec3 uHiLightCol; uniform vec3 uAmbTop; uniform vec3 uAmbBot;
uniform vec3 uFogRad; uniform float uFogVis; uniform float uFogH; uniform vec3 uFogSun;
uniform float uFlash; uniform vec3 uFlashDir; uniform float uOut;
varying vec3 vDir; varying vec3 vR1; varying vec3 vM1; varying vec3 vR2; varying vec3 vM2; varying vec3 vMs; varying vec3 vTv;
#define A_RE 6360000.0
float a_phaseR(float mu) { return 0.0596831 * (1.0 + mu * mu); }
float a_phaseM(float mu, float g) { float g2 = g * g; return 0.1193662 * ((1.0 - g2) * (1.0 + mu * mu)) / ((2.0 + g2) * pow(max(1e-4, 1.0 + g2 - 2.0 * g * mu), 1.5)); }
float hg(float c, float g) { float g2 = g * g; return 0.0795775 * (1.0 - g2) / pow(max(1e-4, 1.0 + g2 - 2.0 * g * c), 1.5); }
float shellFar(float r0, float dy, float h) { float R = A_RE + h, b = r0 * dy, c = r0 * r0 - R * R; return -b + sqrt(max(0.0, b * b - c)); }

vec4 clouds2D(vec3 d) {
  if (d.y < 0.0 || (uCover < 0.004 && uCb < 0.01)) return vec4(0.0, 0.0, 0.0, 1.0);
  float r0 = A_RE + uCamH;
  float hb = uBase + 0.3 * uThick;
  if (uCamH > hb) return vec4(0.0, 0.0, 0.0, 1.0);
  float t = shellFar(r0, d.y, hb);
  vec2 P = uCamXZ + d.xz * t;
  vec4 wm = texture2D(uWeather, (P + uWindOff) / 60000.0);
  float cell = smoothstep(0.55, 0.92, wm.g) * uCb;
  float cov = clamp(uCover + cell * 0.45, 0.0, 1.0);
  float covered = smoothstep(1.0 - cov - 0.03, 1.0 - cov + mix(0.12, 0.24, uStratus), wm.r);
  covered = max(covered, cell * smoothstep(0.62, 0.9, wm.g));
  if (covered < 0.003) return vec4(0.0, 0.0, 0.0, 1.0);
  // near the horizon a plane projection stretches any fine texture into radial bands: there only the
  // large-scale cover is used (the billows fade out between 9 and 2 deg elevation)
  float hz = smoothstep(0.035, 0.16, d.y);
  float b1 = texture2D(uWeather, (P + uWindOff) / 7000.0).r;
  float b2 = texture2D(uWeather, (P + uWindOff) / 1400.0 + 0.5).b;
  float bill = mix(0.55, b1 * 0.7 + b2 * 0.3, hz);
  float dens = clamp((bill - (1.0 - covered)) / max(covered * 0.6, 0.06), 0.0, 1.0) * covered;
  // a stratus deck: thicker and thinner patches (weather map B) and lumps, never a flat sheet
  dens = mix(dens, covered * (0.5 + 0.25 * bill + 0.35 * wm.b), uStratus * (1.0 - cell));
  float colH = mix(uThick, uCbTop - uBase, cell);
  float sig = uDens * 0.35;
  float tauV = sig * colH * dens * min(1.0 / max(d.y, 0.06), 7.0) * 0.5 * mix(0.6, 1.0, hz);
  float T = exp(-tauV);
  // light: the column towards the light, and diffuse transmission through the whole column
  vec2 P2 = P + uLightDir.xz / max(uLightDir.y, 0.12) * colH * 0.5;
  float c2 = smoothstep(1.0 - cov - 0.06, 1.0 - cov + 0.22, texture2D(uWeather, (P2 + uWindOff) / 60000.0).r);
  float d2 = c2 * texture2D(uWeather, (P2 + uWindOff) / 7000.0).r;
  float tauL = sig * colH * mix(dens, d2, 0.6) / max(uLightDir.y, 0.12) * 0.6;
  float tauC = sig * colH * dens;
  float mu = dot(d, uLightDir);
  float phase = mix(hg(mu, 0.65), hg(mu, -0.25), 0.3);
  float occUp = 1.0 / (1.0 + 0.37 * tauC);
  vec3 S = uLightCol * phase * (exp(-tauL) + 0.35 * exp(-tauL * 0.22)) + uDiffCol * 0.159 * occUp * max(0.05, uLightDir.y + 0.1) + mix(uAmbBot, uAmbTop * occUp, 0.35);
  vec3 L = S * (1.0 - T);
  if (uFlash > 0.0) L += vec3(0.85, 0.9, 1.0) * uFlash * 4.0 * (1.0 - T) * exp(-length(d - uFlashDir) * 6.0);
  float f = exp(-t / uHazeDist);
  return vec4(L * f, 1.0 - (1.0 - T) * f);
}
vec4 cirrus(vec3 d) {
  if (uHigh < 0.01 || d.y < 0.0) return vec4(0.0, 0.0, 0.0, 1.0);
  float r0 = A_RE + uCamH;
  float t = shellFar(r0, d.y, 9000.0);
  vec2 P = uCamXZ + d.xz * t + uWindOffHi;
  float ca = cos(uHiAngle), sa = sin(uHiAngle);
  vec2 Q = vec2(ca * P.x + sa * P.y, -sa * P.x + ca * P.y);
  float b = texture2D(uWeather, Q / vec2(90000.0, 30000.0)).b;
  float s = texture2D(uWeather, Q / vec2(16000.0, 1500.0) + 0.3).b;
  float c = smoothstep(1.0 - uHigh, 1.0 - uHigh + 0.3, b) * (0.3 + 0.7 * s);
  float a = clamp(c * 0.55, 0.0, 0.8);
  float mu = dot(d, uLightDir);
  vec3 S = uHiLightCol * (hg(mu, 0.6) * 0.8 + 0.1) + uAmbTop;
  float f = exp(-t / (uHazeDist * 1.6));
  return vec4(S * a * f, 1.0 - a * f);
}

void main() {
  vec3 d = normalize(vDir);
  float mu1 = dot(d, uSunDir), mu2 = dot(d, uMoonDir);
  vec3 col = (vR1 * a_phaseR(mu1) + vM1 * a_phaseM(mu1, uMieG)) * uSunE
           + (vR2 * a_phaseR(mu2) + vM2 * a_phaseM(mu2, uMieG)) * uMoonE
           + vMs * uAmb;
  float up = max(d.y, 0.0);
  col += (uAirglow * (0.5 + 0.5 * (1.0 - up)) + uCityGlow * pow(1.0 - up, 10.0)) * vTv;
  // deep twilight (multiple scattering): a blue dome and the glow over the Sun's azimuth
  vec2 hz = normalize(d.xz + vec2(1e-5, 0.0)), sz = normalize(uSunDir.xz + vec2(1e-5, 0.0));
  col += uTwiZen * (0.7 + 0.3 * up) + uTwiGlow * pow(max(0.0, dot(hz, sz)), 3.0) * exp(-up * 7.0);
  // the Sun: 0.533 deg disc with limb darkening, plus a little eye glare
  float ang = 2.0 * asin(clamp(length(d - uSunDir) * 0.5, 0.0, 1.0));
  const float SUN_R = 0.004654;
  if (ang < SUN_R) { float x = ang / SUN_R; col += uSunDisc * vTv * (1.0 - 0.6 * (1.0 - sqrt(1.0 - x * x))); }
  col += uSunDisc * vTv * 0.0006 * exp(-ang / 0.02);
  float Tatm = dot(vTv, vec3(0.2126, 0.7152, 0.0722));
  if (d.y < 0.0) { float k = smoothstep(0.0, -0.03, d.y); col = mix(col, uSeaCol, k); Tatm = 0.0; }
  // clouds: cirrus behind the low layer
  vec4 ci = cirrus(d);
  col = col * ci.a + ci.rgb;
  float T = Tatm * ci.a;
  vec4 cl = vec4(0.0, 0.0, 0.0, 1.0);
  if (uCloudMode == 2) cl = texture2D(uCloudTex, gl_FragCoord.xy / uViewport);
  else if (uCloudMode == 1) cl = clouds2D(d);
  col = col * cl.a + cl.rgb; T *= cl.a;
  // the hazy / foggy surface layer (visibility from the weather): the horizon dissolves into it
  float path = d.y > 0.0005 ? min(uFogH / d.y, 80000.0) : 80000.0;
  float tf = exp(-3.912 * path / max(uFogVis, 30.0));
  col = mix(uFogRad + uFogSun * hg(mu1, 0.7) * (1.0 - tf), col, tf); T *= tf;
  gl_FragColor = vec4(col * uOut, T);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** Sky dome with rings packed towards the horizon (where the sky changes fastest). */
function domeGeometry(radius, nAz = 72, rings = 30) {
  const els = [-Math.PI / 2, -0.5, -0.2, -0.08, -0.03, -0.01];
  for (let i = 0; i <= rings; i++) { const t = i / rings; els.push(t * t * (Math.PI / 2 - 0.0005)); }
  const pos = [], idx = [];
  for (const e of els) for (let a = 0; a <= nAz; a++) {
    const az = (a / nAz) * Math.PI * 2, c = Math.cos(e);
    pos.push(Math.sin(az) * c * radius, Math.sin(e) * radius, Math.cos(az) * c * radius);
  }
  const top = pos.length / 3; pos.push(0, radius, 0);
  const W = nAz + 1;
  for (let r = 0; r < els.length - 1; r++) for (let a = 0; a < nAz; a++) {
    const i0 = r * W + a, i1 = i0 + 1, j0 = i0 + W, j1 = j0 + 1;
    idx.push(i0, j0, i1, i1, j0, j1);
  }
  const lr = (els.length - 1) * W;
  for (let a = 0; a < nAz; a++) idx.push(lr + a, top, lr + a + 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const add3 = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const mul3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const wrap = (v) => v - Math.floor(v / WRAP) * WRAP;

function urlParam(k) { try { return new URLSearchParams(location.search).get(k); } catch { return null; } }

export class SkySystem {
  /**
   * @param o { scene, camera, renderer, sun (DirectionalLight), hemi (HemisphereLight), phone (bool), weatherFx }
   */
  constructor(o) {
    this.scene = o.scene; this.camera = o.camera; this.renderer = o.renderer; this.phone = !!o.phone;
    this.sunLight = o.sun; this.hemi = o.hemi; this.weatherFx = o.weatherFx || null;
    this.moonLight = new THREE.DirectionalLight(0x9fb4d8, 0); this.moonLight.name = 'moonLight';
    this.scene.add(this.moonLight); this.scene.add(this.moonLight.target);
    // weather map (shared by the dome's 2D clouds, the volumetric pass and the CPU sun-occlusion test)
    this.wmN = this.phone ? 128 : 256;
    this.wmData = weatherMap(this.wmN);
    const wt = new THREE.DataTexture(this.wmData, this.wmN, this.wmN, THREE.RGBAFormat, THREE.UnsignedByteType);
    wt.wrapS = wt.wrapT = THREE.RepeatWrapping; wt.magFilter = THREE.LinearFilter; wt.minFilter = THREE.LinearMipmapLinearFilter;
    wt.generateMipmaps = true; wt.needsUpdate = true;
    this.weatherTex = wt;
    const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); blank.needsUpdate = true;
    const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
    this.u = {
      uSunDir: { value: V3(0, 1, 0) }, uMoonDir: { value: V3(0, -1, 0) }, uCamH: { value: 10 }, uMie: { value: mieForVisibility(30000) },
      uSunE: { value: V3(14, 14, 14) }, uMoonE: { value: V3() }, uAmb: { value: V3() }, uMieG: { value: MIE_G },
      uSunDisc: { value: V3() }, uAirglow: { value: V3() }, uCityGlow: { value: V3() }, uSeaCol: { value: V3() }, uTwiZen: { value: V3() }, uTwiGlow: { value: V3() },
      uWeather: { value: wt }, uCloudTex: { value: blank }, uCloudMode: { value: 1 }, uViewport: { value: new THREE.Vector2(1, 1) },
      uCamXZ: { value: new THREE.Vector2() }, uWindOff: { value: new THREE.Vector2() }, uWindOffHi: { value: new THREE.Vector2() }, uHiAngle: { value: 0 },
      uCover: { value: 0.3 }, uHigh: { value: 0.1 }, uBase: { value: 1200 }, uThick: { value: 1500 }, uCbTop: { value: 9000 }, uCb: { value: 0 }, uStratus: { value: 0 }, uDens: { value: 0.03 }, uHazeDist: { value: 40000 },
      uLightDir: { value: V3(0, 1, 0) }, uLightCol: { value: V3(10, 10, 10) }, uDiffCol: { value: V3(10, 10, 10) }, uHiLightCol: { value: V3(10, 10, 10) }, uAmbTop: { value: V3(0.3, 0.35, 0.4) }, uAmbBot: { value: V3(0.1, 0.11, 0.12) },
      uFogRad: { value: V3(0.5, 0.55, 0.6) }, uFogVis: { value: 30000 }, uFogH: { value: 250 }, uFogSun: { value: V3() },
      uFlash: { value: 0 }, uFlashDir: { value: V3(0, 1, 0) }, uOut: { value: 1 },
    };
    this.mat = new THREE.ShaderMaterial({
      uniforms: this.u, vertexShader: VERT, fragmentShader: FRAG, side: THREE.DoubleSide, depthWrite: false, depthTest: true, fog: false,
      transparent: true, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.SrcAlphaFactor,
    });
    this.dome = new THREE.Mesh(this.phone ? domeGeometry(DOME_R, 48, 22) : domeGeometry(DOME_R), this.mat);
    this.dome.frustumCulled = false; this.dome.renderOrder = -10; this.dome.name = 'skyDome';
    this.scene.add(this.dome);
    // environment: the same sky (2D clouds) on a tiny dome in its own scene, prefiltered by PMREM
    this.envOn = urlParam('skyenv') !== '0';
    this.envMat = new THREE.ShaderMaterial({ uniforms: this.u, vertexShader: VERT, fragmentShader: FRAG, side: THREE.DoubleSide, depthWrite: false, depthTest: false, fog: false });
    this.envScene = new THREE.Scene();
    const ed = new THREE.Mesh(domeGeometry(50, 48), this.envMat); ed.frustumCulled = false; this.envScene.add(ed);
    this.pmrem = null; this.envRT = null; this.envAt = -1e9; this.envKey = null; this.foreignEnv = null;
    // celestial sphere (stars, planets, Milky Way, Moon)
    this.celestial = new CelestialSphere(this.scene, this.camera, { phone: this.phone });
    // cloud tier: high / medium = volumetric, low = 2D
    const want = this.forcedTier = urlParam('sky');
    this.volOK = !this.phone && canRenderHalfFloat(this.renderer);
    this.tier = want === 'low' || want === 'medium' || want === 'high' ? want : (this.volOK ? 'high' : 'low');
    if (!this.volOK && this.tier !== 'low') this.tier = 'low';
    this.vol = this.tier !== 'low' ? new VolumeClouds(this.renderer, wt, this.tierOpts(this.tier)) : null;
    this.perf = { ema: 1 / 60, since: performance.now(), last: performance.now() };
    // smoothed weather, debug override
    this.cur = null; this.override = null;
    const pre = urlParam('wx'); if (pre && WX_PRESETS[pre]) this.override = { ...WX_PRESETS[pre] };
    this.windOff = new THREE.Vector2(); this.windOffHi = new THREE.Vector2();
    this.lat0 = null; this.slow = null; this.slowAt = -1e9; this.sunVis = 1; this.moonVis = 1;
    this.buildExposure(); this.K = this.kCurve(60);
    this.fogNear = 3000; this.fogFar = 15000;
    this.state = {};
  }
  /**
   * The exposure curve, from the model itself: zenith luminance of a clear standard sky (30 km visibility) per
   * elevation, and the daytime exposure that puts a sunlit 18 % grey at display 0.45 under a 60 deg Sun.
   */
  buildExposure() {
    const mieRef = mieForVisibility(30000);
    const el = (e) => { const r = e * D2R; return [0, Math.sin(r), -Math.cos(r)]; };
    const sky = (e, dir) => { const L = el(e); return skyRadiance(10, dir, L, mieRef, skyAmbient(10, L, mieRef), 12); };
    const tab = [];
    for (let e = -24; e <= 90; e += 3) tab.push(luminance(sky(e, [0, 1, 0])));
    const lzenAt = (e) => {
      const x = Math.max(0, Math.min(tab.length - 1.001, (e + 24) / 3)), i = Math.floor(x), f = x - i;
      return tab[i] * (1 - f) + tab[i + 1] * f;
    };
    const zen60 = sky(60, [0, 1, 0]), hor60 = sky(60, [0, 0.035, 0.9994]);
    const avg60 = lerp3(zen60, hor60, 0.55);                                   // the mean the hemisphere light gets
    const eSun = luminance(transmittance(10, Math.sin(60 * D2R), mieRef));
    const eSky = Math.PI * luminance(avg60) * SKY_GAIN;
    this.kDay = calibrateDayExposure(eSun, eSky, 0.45);
    this.kCurve = exposureCurve(this.kDay, lzenAt(60), lzenAt, twilightLuminance);
    this.exposureInfo = { kDay: this.kDay, eSun, eSky, kNight: this.kDay * NIGHT_RATIO };
    // irradiance under a deck, relative to a clear sky at the same Sun: chosen so an 18 % grey reads
    // OVERCAST_GREY (0.37) under a plain overcast and STORM_GREY (0.21) under a storm at noon (a clear noon reads 0.45)
    const xNoon = acesInputFor(0.45);
    this.deckRatio = { over: acesInputFor(OVERCAST_GREY) / xNoon, storm: acesInputFor(STORM_GREY) / xNoon };
    this.exposureInfo.deckRatio = this.deckRatio;
  }
  tierOpts(t) { return t === 'high' ? { scale: 0.5, steps: 96 } : { scale: 0.5, steps: 48 }; }   // resolution 0.5 minimum (lower read as streaks)
  setTier(t) {
    if (t === this.tier) return;
    this.tier = t;
    if (t === 'low') { this.vol?.dispose(); this.vol = null; }
    else if (this.volOK) {
      if (!this.vol) this.vol = new VolumeClouds(this.renderer, this.weatherTex, this.tierOpts(t));
      else { const o = this.tierOpts(t); this.vol.setScale(o.scale); this.vol.steps = o.steps; }
    }
  }
  /** Debug: override the weather the sky shows (preset name, partial weather object, or null for the real one). */
  setOverride(x) {
    if (x === null || x === undefined || x === '') this.override = null;
    else if (typeof x === 'string') this.override = WX_PRESETS[x] ? { ...WX_PRESETS[x] } : this.override;
    else if (typeof x === 'object') this.override = { ...(this.override || {}), ...x };
    if (this.cur) { this.snap = true; this.fogInit = false; }
    return this.override;
  }
  /** The weather the visuals use: the real sample with the debug override on top. */
  effective(wx) { return this.override ? { ...(wx || {}), ...this.override } : (wx || {}); }

  smoothWeather(w, dt) {
    const keys = ['cloud', 'cloudLow', 'cloudHigh', 'rain', 'storm', 'temp', 'windSpd'];
    const tgt = {};
    for (const k of keys) tgt[k] = Number.isFinite(w[k]) ? w[k] : undefined;
    tgt.cloud ??= 0.3; tgt.rain ??= 0; tgt.storm ??= 0; tgt.temp ??= 12; tgt.windSpd ??= 5;
    const lv = Math.log(Math.max(50, Number.isFinite(w.visibility) ? w.visibility : 20000));
    if (!this.cur || this.snap) {
      this.cur = { ...tgt, lvis: lv, windDir: Number.isFinite(w.windDir) ? w.windDir : 240 };
      this.snap = false;
    } else {
      const k = 1 - Math.exp(-dt / 15);              // weather changes blend over ~15-30 s
      const c = this.cur;
      for (const key of keys) {
        if (tgt[key] === undefined) { c[key] = undefined; continue; }
        c[key] = Number.isFinite(c[key]) ? c[key] + (tgt[key] - c[key]) * k : tgt[key];
      }
      c.lvis += (lv - c.lvis) * k;
      if (Number.isFinite(w.windDir)) { let dd = ((w.windDir - c.windDir + 540) % 360) - 180; c.windDir = (c.windDir + dd * k + 360) % 360; }
    }
    return { ...this.cur, visibility: Math.exp(this.cur.lvis) };
  }

  /** Cloud cover at stable (x, z) for the CPU (sun occlusion), same formula as the shaders. */
  coverAt(x, z, P) {
    const u = (x + this.windOff.x) / WMAP, v = (z + this.windOff.y) / WMAP;
    const r = sampleMap(this.wmData, this.wmN, u, v, 0), g = sampleMap(this.wmData, this.wmN, u, v, 1);
    const cell = sstep(0.55, 0.92, g) * P.cb;
    const cov = Math.min(1, P.cover + cell * 0.45);
    const covered = Math.max(sstep(1 - cov - 0.03, 1 - cov + 0.12 + 0.12 * P.stratus, r), cell * sstep(0.62, 0.9, g));   // = the shaders' edge
    return { covered, cell };
  }

  /**
   * Per frame, before rendering. c: { dt, lat, lon, unix, wx (weather, public shape), anchor: {x, z} the local
   * position of (lat, lon), indoors (bool), flash (0..1), flashPos (local Vector3 or null) }.
   * Returns { sunDir, lightDir, lightCol (ocean), top, hor (sky radiance for the ocean), day, night, gloom, sun, moon }.
   */
  update(c) {
    const dt = Math.min(0.25, Math.max(0, c.dt || 0.016));
    const cam = this.camera.position;
    const sun = solarPosition(c.lat, c.lon, c.unix), moon = lunarPosition(c.lat, c.lon, c.unix);
    const snapped = !this.cur || !!this.snap;
    const w = this.smoothWeather(this.effective(c.wx), dt);
    const P = cloudParams(w);
    this.params = P; this.weather = w;
    // stable coordinates (metres, wrapped) so clouds stay put when the floating origin moves
    if (this.lat0 === null) this.lat0 = c.lat;
    const sx = wrap(c.lon * 111320 * Math.cos(this.lat0 * D2R) + (cam.x - (c.anchor?.x || 0)));
    const sz = wrap(-c.lat * 110574 + (cam.z - (c.anchor?.z || 0)));
    // wind drift: the cloud level moves ~1.6x the surface wind, veered 20 deg; cirrus faster, from further west
    const wd = (w.windDir + 20) * D2R, ws = Math.min(40, (w.windSpd || 5) * 1.6 + 2);
    this.windOff.x = wrap(this.windOff.x + Math.sin(wd) * ws * dt); this.windOff.y = wrap(this.windOff.y - Math.cos(wd) * ws * dt);
    const hiDir = wd + 0.35;
    this.windOffHi.x = wrap(this.windOffHi.x + Math.sin(hiDir) * 25 * dt); this.windOffHi.y = wrap(this.windOffHi.y - Math.cos(hiDir) * 25 * dt);

    const camH = THREE.MathUtils.clamp(cam.y, 2, 3000);
    const sunDir = sun.dir, moonDir = moon.dir;
    const mie = mieForVisibility(w.visibility);
    // ---- the expensive CPU atmosphere, ~5 Hz or at once when something moved
    const now = performance.now();
    const key = `${Math.round(sun.elevDeg * 4)}|${Math.round(sun.azDeg)}|${Math.round(moon.elevDeg * 2)}|${Math.round(mie * 2e6)}`;
    const jump = !this.slow || Math.abs(sun.elevDeg - this.slowSunEl) > 1.5 || Math.abs(moon.elevDeg - this.slowMoonEl) > 3;   // time warp / debug time
    if (jump || now - this.slowAt > 200 && key !== this.slowKey || now - this.slowAt > 2000) {
      this.slowAt = now; this.slowKey = key; this.slowSunEl = sun.elevDeg; this.slowMoonEl = moon.elevDeg;
      const ambS = skyAmbient(camH, sunDir, mie);
      const moonE = FULL_MOON_E * moonPhaseLaw((moon.phaseAngle || 0) / D2R);
      const ambM = moon.elevDeg > -12 ? skyAmbient(camH, moonDir, mie) : [0, 0, 0];
      const zenS = skyRadiance(camH, [0, 1, 0], sunDir, mie, ambS);
      const zenM = moon.elevDeg > -12 ? skyRadiance(camH, [0, 1, 0], moonDir, mie, ambM) : [0, 0, 0];
      const horS = [], horM = [];
      for (let a = 0; a < 8; a++) {
        const az = (a / 8) * Math.PI * 2, d = [Math.sin(az) * 0.9994, 0.035, -Math.cos(az) * 0.9994];
        horS.push(skyRadiance(camH, d, sunDir, mie, ambS, 12));
        horM.push(moon.elevDeg > -12 ? skyRadiance(camH, d, moonDir, mie, ambM, 12) : [0, 0, 0]);
      }
      const hCloud = P.base + P.thick * 0.5;
      this.slow = {
        ambS, ambM, zenS, zenM, horS, horM, moonE,
        Tsun: transmittance(camH, sunDir[1], mie), TsunCloud: transmittance(hCloud, sunDir[1], mie), TsunHi: transmittance(9000, sunDir[1], mie),
        Tmoon: transmittance(camH, moonDir[1], mie), TmoonCloud: transmittance(hCloud, moonDir[1], mie),
        lzenSun: luminance(zenS), lzenMoonPhys: luminance(zenM) * moonE,
      };
    }
    const S = this.slow;
    // ---- exposure: a fixed curve of the Sun's elevation (never of the weather, never drifting)
    const Ltw = twilightLuminance(sun.trueElevDeg ?? sun.elevDeg);
    this.K = this.kCurve(sun.trueElevDeg ?? sun.elevDeg);
    if ((jump || snapped) && this.vol) this.vol.histValid = false;   // no ghost of the old sky after a time jump / debug weather
    const K = this.K, Ks = K * SKY_GAIN;
    // the moonlit sky in display units (physical moonlight is 1/400000 of the Sun: no exposure shows it, the eye does)
    const moonUp = sstep(-0.05, 0.05, moon.elev);
    const mB = (MOON_SKY * moonPhaseLaw((moon.phaseAngle || 0) / D2R) * moonUp) / Ks;
    // ---- clouds: what the sky dome and the volumetric pass need
    const lightIsSun = sun.elevDeg > -4 || luminance(S.TsunCloud) * K > luminance(S.TmoonCloud) * Ks * mB;
    const lightDir = lightIsSun ? sunDir : moonDir;
    const sunC = mul3(S.TsunCloud, K), moonC = mul3(S.TmoonCloud, Ks * mB * 0.35);   // moonlit cloud: light grey, not daylight
    const lightCol = lightIsSun ? add3(sunC, moonC, 0.0) : moonC;
    const ambClear = add3(mul3(S.ambS, Ks), S.ambM, Ks * mB);
    const ambTop = mul3(ambClear, 1.9);
    // diffuse light through clouds is whiter than the direct beam (skylight mixed in)
    const lLum = luminance(lightCol), diffCol = [0.5 * lightCol[0] + 0.5 * lLum * 0.93, 0.5 * lightCol[1] + 0.5 * lLum, 0.5 * lightCol[2] + 0.5 * lLum * 1.1];
    const night = 1 - sun.day;
    // ---- sun / moon occlusion by the clouds at the point where their ray crosses the cloud layer
    const occl = (dir) => {
      if (dir[1] <= 0.02) return 1;
      const tt = Math.min(30000, (P.base + P.thick * 0.4 - camH) / dir[1]);
      const cv = this.coverAt(sx + dir[0] * tt, sz + dir[2] * tt, P);
      const colH = P.thick + cv.cell * (P.cbTop - P.base - P.thick);
      const tau = P.dens * 0.35 * colH * cv.covered * (0.55 + 0.45 * P.stratus) / Math.max(dir[1], 0.15);
      return Math.exp(-tau * 0.6);
    };
    const kv = (jump || snapped) ? 1 : 1 - Math.exp(-dt / 0.7);
    this.sunVis += (occl(sunDir) - this.sunVis) * kv; this.moonVis += (occl(moonDir) - this.moonVis) * kv;
    // ---- sky colours for the ocean, fog and hemisphere (display radiance), with the cloud deck mixed in
    const cover = P.cover;
    const tauCol = P.dens * 1.2 * (P.thick + P.cb * (P.cbTop - P.base - P.thick) * 0.6);   // optical depth of the deck (stratus ~30)
    let deckDiff = mul3(diffCol, (0.159 / (1 + 0.11 * tauCol)) * Math.max(0.05, lightDir[1] + 0.1));
    // light from below: the sky- and sun-lit sea when clear, the dim sea under a deck when overcast
    let ambBot = lerp3(add3(mul3(ambClear, 0.55), mul3(lightCol, 0.03 * Math.max(0, lightDir[1]))), mul3(deckDiff, 0.35), Math.min(1, P.cover));
    let base = add3(deckDiff, ambBot, 1.0);
    // calibration: the two-stream deck alone left a storm at noon nearly black (0.18 grey -> 0.06). The light under a
    // deck is the cloud-transmitted DIFFUSE light: its irradiance = the clear-sky irradiance at this Sun x a ratio
    // between "overcast" and "storm" (deckRatio, from the calibrated display values). The deck radiance seen from
    // below is that irradiance / pi; the cloud shaders get the same lift (uDiffCol, uAmbBot) so sky and scene agree.
    let deckLift = 1;
    {
      const eClearNow = luminance(S.Tsun) * K * sstep(-0.01, 0.03, sunDir[1]) + Math.PI * luminance(lerp3(add3(mul3(S.zenS, Ks), S.zenM, Ks * mB), add3(mul3(S.horS[0], Ks), S.horM[0], Ks * mB), 0.55));
      const storminess = Math.min(1, Math.max(P.cb, P.rain * 0.7));
      const ratio = this.deckRatio.over + (this.deckRatio.storm - this.deckRatio.over) * storminess;
      const want = (eClearNow * ratio) / Math.PI, have = Math.max(1e-6, luminance(base));
      if (want > have && P.cover > 0.05) {
        deckLift = Math.min(40, want / have);
        deckDiff = mul3(deckDiff, deckLift); ambBot = mul3(ambBot, deckLift); base = mul3(base, deckLift);
      }
    }
    this.deckLift = deckLift;
    const twZ = [0.45 / 0.611 * Ltw * Ks, 0.62 / 0.611 * Ltw * Ks, 1.0 / 0.611 * Ltw * Ks];
    const twG = [1.0 / 0.69 * Ltw * Ks * 2.5, 0.62 / 0.69 * Ltw * Ks * 2.5, 0.35 / 0.69 * Ltw * Ks * 2.5];
    const zenClear = add3(add3(mul3(S.zenS, Ks), S.zenM, Ks * mB), twZ);
    let horClear = mul3(add3(twZ, twG, 0.3), 1);
    for (let a = 0; a < 8; a++) horClear = add3(horClear, add3(mul3(S.horS[a], Ks), S.horM[a], Ks * mB), 1 / 8);
    const airglow = [0.0022, 0.0030, 0.0058];
    const top = lerp3(add3(zenClear, airglow), base, Math.min(1, cover * 1.05));
    // CIE overcast sky: the horizon is darker than the zenith (L ~ 1 + 2 sin(elevation)); broken cloud crowds the horizon
    const coverH = Math.pow(Math.min(1, cover), 0.7);
    // under a deck the horizon is a LIGHTER band (the air between the sea and the far cloud base scatters light)
    const hor = lerp3(add3(horClear, airglow, 1.3), mul3(base, 1.12), coverH);
    // fog colour: the horizon in the camera's azimuth, under the deck
    const fwd = new THREE.Vector3(); this.camera.getWorldDirection(fwd);
    const fa = ((Math.atan2(fwd.x, -fwd.z) / (Math.PI * 2)) * 8 + 8) % 8, i0 = Math.floor(fa) % 8, i1 = (i0 + 1) % 8, ft = fa - Math.floor(fa);
    const horAz0 = lerp3(add3(mul3(S.horS[i0], Ks), S.horM[i0], Ks * mB), add3(mul3(S.horS[i1], Ks), S.horM[i1], Ks * mB), ft);
    const sunAz = Math.atan2(sunDir[0], -sunDir[2]), camAz = Math.atan2(fwd.x, -fwd.z);
    const horAz = add3(add3(horAz0, twZ), twG, Math.pow(Math.max(0, Math.cos(camAz - sunAz)), 3));
    let fogRad = lerp3(add3(horAz, airglow, 1.3), mul3(base, 1.12), coverH);
    // rain and storms grey the air further
    fogRad = lerp3(fogRad, mul3(base, 1.0), Math.min(0.6, P.rain * 0.5 + P.cb * 0.3));
    // ---- the uniforms
    const u = this.u;
    u.uSunDir.value.set(...sunDir); u.uMoonDir.value.set(...moonDir); u.uCamH.value = camH; u.uMie.value = mie;
    u.uSunE.value.set(Ks, Ks, Ks);
    u.uMoonE.value.set(Ks * mB, Ks * mB * 0.97, Ks * mB * 0.92);
    u.uAmb.value.set(ambClear[0], ambClear[1], ambClear[2]);
    const disc = mul3(S.Tsun, 14700 * K), dm = Math.max(disc[0], disc[1], disc[2], 1e-6), ds = Math.min(1, 7 / dm);
    u.uSunDisc.value.set(disc[0] * ds, disc[1] * ds, disc[2] * ds);
    u.uAirglow.value.set(...airglow); u.uTwiZen.value.set(...twZ); u.uTwiGlow.value.set(...twG);
    const city = 0.006 * night;
    u.uCityGlow.value.set(city * 1.0, city * 0.72, city * 0.45);
    u.uSeaCol.value.set(...mul3(hor, 0.3));
    u.uCamXZ.value.set(sx, sz); u.uWindOff.value.copy(this.windOff); u.uWindOffHi.value.copy(this.windOffHi); u.uHiAngle.value = hiDir;
    u.uCover.value = cover; u.uHigh.value = P.high; u.uBase.value = P.base; u.uThick.value = P.thick; u.uCbTop.value = P.cbTop; u.uCb.value = P.cb; u.uStratus.value = P.stratus; u.uDens.value = P.dens;
    u.uHazeDist.value = THREE.MathUtils.clamp(w.visibility * 2.2, 3000, 90000);
    u.uLightDir.value.set(...lightDir); u.uLightCol.value.set(...lightCol); u.uDiffCol.value.set(...mul3(diffCol, deckLift));
    const hi = lightIsSun ? mul3(S.TsunHi, K) : moonC;
    u.uHiLightCol.value.set(...hi);
    u.uAmbTop.value.set(...ambTop); u.uAmbBot.value.set(...ambBot);
    const fogLayer = w.visibility < 1500 ? 140 : 260;
    u.uFogRad.value.set(...fogRad); u.uFogVis.value = w.visibility; u.uFogH.value = fogLayer;
    const fogSun = mul3(S.TsunCloud, K * 0.25 * this.sunVis * sstep(-0.02, 0.05, sunDir[1]) * (1 - sstep(4000, 20000, w.visibility)));
    u.uFogSun.value.set(...fogSun);
    // lightning (WeatherFX): the flash lights the clouds from inside around its position
    const fx = this.weatherFx;
    const flash = Number.isFinite(c.flash) ? c.flash : fx ? fx.flashNow * (0.35 + 0.65 * (fx.flashNear || 0)) : 0;
    if (!c.flashPos && fx?.flashPos) c = { ...c, flashPos: fx.flashPos };
    if (fx) { fx.cloudBase = P.base; }
    u.uFlash.value = flash;
    if (c.flashPos) { const fd = new THREE.Vector3().subVectors(c.flashPos, cam); fd.y = Math.max(fd.y, P.base - camH); u.uFlashDir.value.copy(fd.normalize()); }
    // ---- clouds: volumetric pass (desktop) or the dome's 2D layer
    this.governTier(now);
    let mode = 1;
    if (this.vol && this.vol.build(this.phone ? 2 : 4)) {
      const fp = c.flashPos ? new THREE.Vector3(wrap(sx + (c.flashPos.x - cam.x)), P.base + 900, wrap(sz + (c.flashPos.z - cam.z))) : new THREE.Vector3(1e9, 0, 0);
      const ok = this.vol.render(this.camera, {
        uCam: new THREE.Vector3(sx, camH, sz), uWindOff: this.windOff, uTime: (now / 1000) % 10000,
        uCover: cover, uBase: P.base, uThick: P.thick, uCbTop: P.cbTop, uCb: P.cb, uStratus: P.stratus, uDens: P.dens, uRain: P.rain * (1 - 0.5 * P.snow),
        uLightDir: new THREE.Vector3(...lightDir), uLightCol: new THREE.Vector3(...lightCol), uDiffCol: new THREE.Vector3(...mul3(diffCol, deckLift)),
        uAmbTop: new THREE.Vector3(...ambTop), uAmbBot: new THREE.Vector3(...ambBot),
        uHazeDist: u.uHazeDist.value, uFlashPos: fp, uFlash: flash,
      });
      if (ok) { mode = 2; u.uCloudTex.value = this.vol.texture; const s = this.renderer.getDrawingBufferSize(new THREE.Vector2()); u.uViewport.value.copy(s); }
    }
    u.uCloudMode.value = mode;
    this.dome.position.copy(cam);

    // ---- lights
    const sunUp = sstep(-0.01, 0.03, sunDir[1]);
    const Ts = S.Tsun, tsMax = Math.max(Ts[0], Ts[1], Ts[2], 1e-6);
    // dense fog / mist (visibility < 5 km) also dims the beam on its slant path through the fog layer
    const fogT = (dir) => { const V = w.visibility; if (V >= 5000) return 1; const t = Math.exp(-3.912 * Math.min((V < 1500 ? 140 : 260) / Math.max(dir[1], 0.03), 20000) / V); return 1 - (1 - t) * sstep(5000, 1500, V); };
    // the Sun: irradiance = transmittance x exposure, nothing else (three.js physical lights: radiance = albedo E cos / pi)
    const sunI = tsMax * K * sunUp * this.sunVis * fogT(sunDir);
    const mT = S.Tmoon, mtMax = Math.max(mT[0], mT[1], mT[2], 1e-6);
    const moonI = MOON_LIGHT * moonPhaseLaw((moon.phaseAngle || 0) / D2R) * mtMax * sstep(0, 0.12, moonDir[1]) * this.moonVis * (1 - sunUp) * fogT(moonDir);
    this.sunLight.color.setRGB(Ts[0] / tsMax, Ts[1] / tsMax, Ts[2] / tsMax);
    this.sunLight.intensity = sunI;
    this.sunLight.position.set(sunDir[0], Math.max(0.02, sunDir[1]), sunDir[2]).multiplyScalar(3000).add(cam); this.sunLight.target.position.copy(cam);
    this.moonLight.color.setRGB(0.62 * mT[0] / mtMax, 0.72 * mT[1] / mtMax, 0.95 * mT[2] / mtMax);
    this.moonLight.intensity = moonI;
    this.moonLight.position.set(moonDir[0], Math.max(0.02, moonDir[1]), moonDir[2]).multiplyScalar(3000).add(cam); this.moonLight.target.position.copy(cam);
    // sky irradiance on an upward face = pi x the mean sky radiance (clouds mixed in), capped, with a starlight floor;
    // the hemisphere light carries (1 - ENV_SHARE) of it (all of it indoors / without an environment map), the
    // environment map the rest (standard materials only, see updateEnv)
    const envActive = this.envOn && !c.indoors;
    const skyAvg = lerp3(lerp3(zenClear, horClear, 0.55), base, Math.min(1, cover));
    const hs = [Math.max(skyAvg[0], NIGHT_FLOOR * 0.75), Math.max(skyAvg[1], NIGHT_FLOOR * 0.9), Math.max(skyAvg[2], NIGHT_FLOOR * 1.4)];
    const hsMax = Math.max(hs[0], hs[1], hs[2]);
    this.hemi.color.setRGB(hs[0] / hsMax, hs[1] / hsMax, hs[2] / hsMax);
    const seaIrr = add3(mul3(hs, 0.25), [sunI * 0.04, sunI * 0.045, sunI * 0.05]);
    const sgm = Math.max(seaIrr[0], seaIrr[1], seaIrr[2], 1e-6);
    this.hemi.groundColor.setRGB(seaIrr[0] / sgm * 0.6, seaIrr[1] / sgm * 0.65, seaIrr[2] / sgm * 0.7);
    const eSky = Math.min(HEMI_CAP, Math.PI * hsMax);
    this.hemi.intensity = eSky * (envActive ? 1 - ENV_SHARE : 1);
    this.envShare = envActive ? Math.min(ENV_SHARE, HEMI_CAP / Math.max(1e-6, Math.PI * hsMax) * ENV_SHARE) : 0;
    // ---- fog: the scene fog is mixed in display space after tone mapping, so give it the tone-mapped colour
    const fogDisp = acesTone(fogRad, this.renderer.toneMappingExposure || 1);
    if (this.scene.fog) {
      const fog = this.scene.fog;
      fog.color.setRGB(fogDisp[0], fogDisp[1], fogDisp[2]);
      const V = w.visibility;
      const far = THREE.MathUtils.clamp(V * (1.0 + 0.6 * sstep(8000, 24000, V)), 220, 38000);
      const near = far * (V < 2000 ? 0.0 : 0.04);
      const kf = 1 - Math.exp(-dt / 2);
      if (!this.fogInit) { this.fogInit = true; fog.near = near; fog.far = far; }
      fog.near += (near - fog.near) * kf; fog.far += (far - fog.far) * kf;
    }
    // ---- celestial sphere
    const lsky = S.lzenSun + Ltw + S.lzenMoonPhys + 3e-9;
    const limit = limitingMagnitude(lsky);
    const moonBright = 1.6;                                                    // the disc itself (display): bright, never clipped
    const T = S.Tmoon, tm = Math.max(T[0], T[1], T[2], 1e-6);
    this.celestial.update({
      lat: c.lat, lon: c.lon, unix: c.unix, sun, moon, limitMag: limit, extK: 0.2 + mie * 1500,
      starGain: 1, moonBright, earthshine: 0.045 * Math.pow(1 - moon.illumination, 1.5) * (moonBright / 1.8),
      moonTint: [T[0] / tm, T[1] / tm, T[2] / tm], milkyWay: 0.05 * sstep(5.2, 6.3, limit),
      pixelRatio: this.renderer.getPixelRatio(), clearSky: 1 - cover,
    });
    // ---- environment map
    this.updateEnv(now, c.indoors, { sun: sunDir, K, cover, mode });

    // the ocean: the Sun through setSun (its glitter path; fades out with the Sun), the Moon as a SEPARATE light
    // (ocean.setMoon, water builder) - never the Moon through the Sun's path, whose glitter saturates to a white disc
    const oceanDir = new THREE.Vector3(sunDir[0], Math.max(-0.2, sunDir[1]), sunDir[2]).normalize();
    const oceanCol = new THREE.Color(Ts[0] / tsMax, Ts[1] / tsMax, Ts[2] / tsMax).multiplyScalar(Math.min(1.2, tsMax * 1.15 * this.sunVis * fogT(sunDir) * Math.max(sunUp, 0.02)));
    const moonCol = new THREE.Color(0.62 * mT[0] / mtMax, 0.72 * mT[1] / mtMax, 0.95 * mT[2] / mtMax).multiplyScalar(0.25 * moonPhaseLaw((moon.phaseAngle || 0) / D2R) * this.moonVis * moonUp * (1 - sunUp));
    const moonDirV = new THREE.Vector3(...moonDir);
    const gloom = THREE.MathUtils.clamp(cover * 0.45 + P.rain * 0.2 + P.cb * 0.3, 0, 0.88);
    this.state = {
      sun, moon, day: sun.day, night, gloom, K, limit, sunVis: this.sunVis, cover, params: P, weather: w,
      top: new THREE.Color(top[0], top[1], top[2]), hor: new THREE.Color(hor[0], hor[1], hor[2]),
      oceanDir, oceanCol, moonDir: moonDirV, moonCol, sunI, moonI, eSky, tier: this.tier, cloudMode: mode, deck: base, lightCol, exposure: this.exposureInfo,
    };
    if (fx) { fx.setSkyLight?.(this.state.hor); fx.set?.({ ...w, night }); }
    return this.state;
  }

  updateEnv(now, indoors, k) {
    const sc = this.scene;
    if (!this.envOn) return;
    if (indoors) { if (this.envRT && sc.environment === this.envRT.texture) sc.environment = this.foreignEnv || null; return; }
    if (sc.environment && (!this.envRT || sc.environment !== this.envRT.texture)) this.foreignEnv = sc.environment;
    const minGap = this.phone ? 6000 : 1500;
    const ek = this.envKey;
    const moved = !ek || Math.acos(Math.min(1, ek.sun[0] * k.sun[0] + ek.sun[1] * k.sun[1] + ek.sun[2] * k.sun[2])) > D2R
      || Math.abs(Math.log(k.K / ek.K)) > 0.1 || Math.abs(k.cover - ek.cover) > 0.05 || now - this.envAt > 60000;
    if (!moved || now - this.envAt < minGap) { if (this.envRT && sc.environment !== this.envRT.texture) sc.environment = this.envRT.texture; return; }
    try {
      if (!this.pmrem) this.pmrem = new THREE.PMREMGenerator(this.renderer);
      const prevMode = this.u.uCloudMode.value; this.u.uCloudMode.value = 1; this.u.uOut.value = this.envShare || ENV_SHARE;
      const rt = this.pmrem.fromScene(this.envScene, 0, 0.1, 200);
      this.u.uCloudMode.value = prevMode; this.u.uOut.value = 1;
      const old = this.envRT; this.envRT = rt;
      sc.environment = rt.texture;
      if (old) old.dispose();
      this.envAt = now; this.envKey = { sun: [...k.sun], K: k.K, cover: k.cover };
    } catch (e) { console.warn('[sky] environment map failed', e); this.envOn = false; }
  }

  /** Frame-time governor: volumetric high -> medium -> 2D when the frame rate drops (60 fps desktop target). */
  governTier(now) {
    const g = this.perf, dt = (now - g.last) / 1000; g.last = now;
    if (dt <= 0 || dt > 1 || (typeof document !== 'undefined' && document.hidden)) { g.since = now; return; }
    g.ema += (dt - g.ema) * 0.05;
    if (this.forcedTier) return;                                   // forced tier (?sky=): never change it
    if (now - g.since < 3000) return;
    if (g.ema > 1 / 42 && this.tier !== 'low') { this.setTier(this.tier === 'high' ? 'medium' : 'low'); g.since = now; g.ema = 1 / 50; }
    else if (g.ema < 1 / 58 && this.tier === 'medium' && now - g.since > 30000 && this.volOK) { this.setTier('high'); g.since = now; }
  }
}
