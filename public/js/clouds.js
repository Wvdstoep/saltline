// public/js/clouds.js - raymarched volumetric cloud layer (desktop tier), rendered at reduced resolution (0.5 minimum)
// into two half-float targets (colour+transmittance, hit distance) with temporal accumulation, and composited by the
// sky dome (sky.js) behind everything opaque.
//  - shape: Perlin-Worley 3D noise eroded by Worley detail (skynoise.js), coverage from a histogram-equalised weather
//    map so the cloud fraction on screen follows the real cloud cover. Fair-weather cumulus: separate puffs with a
//    sharp coverage edge, FLAT bases and eroded, rounded tops. Stratus: a deck with a lumpy, darker base and a
//    brighter/darker patch texture (never a flat sheet). Cumulonimbus towers with anvils in convective cells.
//  - light: Beer-Lambert to the Sun/Moon (5-tap cone march), a softer multiple-scattering octave, dual-lobe
//    Henyey-Greenstein (silver lining + back glow), diffuse light transmitted through the deck (two-stream), sky
//    ambient from below/above, powder darkening; lightning lights the cloud from inside;
//  - rain shafts below the base; aerial perspective: distant cloud fades into the horizon haze.
//  - sampling: the step count follows the path length through the layer (24 .. uMaxSteps), empty columns are skipped
//    at 2.5 steps per step, the start is jittered per pixel with interleaved-gradient (blue-noise-like) noise that
//    rotates by the golden ratio every frame.
//  - temporal: each pixel's cloud HIT POINT (weighted hit distance) is reprojected with the previous frame's camera
//    rotation AND translation (the ship moves under the clouds), and the history is rejected where the stored hit
//    distance does not match (cloud edges, parallax) - no radial smearing when sailing.
import * as THREE from 'three';
import { shapeVolume, detailVolume } from './skynoise.js';

const VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const FRAG = /* glsl */`
precision highp float;
precision highp sampler3D;
varying vec2 vUv;
layout(location = 0) out highp vec4 oCol;
layout(location = 1) out highp vec4 oDist;
uniform sampler2D uWeather; uniform sampler3D uShape; uniform sampler3D uDetail;
uniform sampler2D uHistory; uniform sampler2D uHistDist;
uniform mat4 uInvProj; uniform mat4 uCamRot; uniform mat4 uPrevVP; uniform float uHistValid; uniform vec3 uCamDelta;
uniform vec2 uRes; uniform float uFrame; uniform float uTime;
uniform vec3 uCam;            // stable world x, altitude, stable world z (metres)
uniform vec2 uWindOff;        // drift of the low cloud field (metres)
uniform float uCover, uBase, uThick, uCbTop, uCb, uStratus, uDens, uRain;
uniform vec3 uLightDir; uniform vec3 uLightCol; uniform vec3 uDiffCol; uniform vec3 uAmbTop; uniform vec3 uAmbBot;
uniform float uHazeDist;
uniform vec3 uFlashPos; uniform float uFlash;
uniform int uMaxSteps;

#define RE 6360000.0
const float WMAP = 60000.0;   // weather map tile (m)
const float SHAPE = 7000.0;   // shape noise tile (m)
const float DETAIL = 1400.0;  // detail noise tile (m)
const float FAR = 30000.0;    // reprojection distance of a pixel with no cloud

float hg(float c, float g) { float g2 = g * g; return 0.0795775 * (1.0 - g2) / pow(max(1e-4, 1.0 + g2 - 2.0 * g * c), 1.5); }
float shell(float r0, float dy, float h, bool nearRoot) {
  float R = RE + h, b = r0 * dy, c = r0 * r0 - R * R, d = b * b - c;
  if (d < 0.0) return -1.0;
  float s = sqrt(d);
  return nearRoot ? -b - s : -b + s;
}
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

vec4 wsample(vec2 xz) { return texture(uWeather, (xz + uWindOff) / WMAP); }

// cloud envelope at a column: x = coverage 0..1, y = local top height (m), z = convective-cell weight, w = deck texture
vec4 column(vec4 wm) {
  float cell = smoothstep(0.55, 0.92, wm.g) * uCb;
  float cov = clamp(uCover + cell * 0.45, 0.0, 1.0);
  // cumulus: a sharp edge (separate puffs); stratus: a soft one
  float covered = smoothstep(1.0 - cov - 0.03, 1.0 - cov + mix(0.12, 0.24, uStratus), wm.r);
  covered = max(covered, cell * smoothstep(0.62, 0.9, wm.g));
  float top = mix(uBase + uThick, uCbTop, cell);
  return vec4(covered, top, cell, wm.b);
}
float profile(float hf, float cell) {
  float cu = smoothstep(0.0, 0.035, hf) * (1.0 - smoothstep(0.42, 1.0, hf));     // cumulus: flat base, rounded top
  float st = smoothstep(0.0, 0.18, hf) * (1.0 - smoothstep(0.65, 1.0, hf));      // stratus: slab
  float cb = smoothstep(0.0, 0.04, hf) * (1.0 - smoothstep(0.92, 1.0, hf));      // cumulonimbus: full height
  return mix(mix(cu, st, uStratus), cb, cell);
}
float density(vec3 p, float h, vec4 col, bool fine) {
  vec3 q = vec3(p.x, h * 1.6, p.z) + vec3(uWindOff.x, uTime * 0.6, uWindOff.y);
  // a stratus base is lumpy (+-110 m), a cumulus base flat
  float lump = uStratus > 0.01 ? (texture(uShape, vec3(p.x + uWindOff.x, 0.0, p.z + uWindOff.y) / (SHAPE * 0.6)).r - 0.5) * 220.0 * uStratus : 0.0;
  float hf = (h - uBase + lump) / max(col.y - uBase, 1.0);
  if (hf <= 0.0 || hf >= 1.0 || col.x < 0.01) return 0.0;
  float spread = mix(1.0 - 0.5 * hf, 1.0, uStratus);
  spread = mix(spread, 0.75 + 0.6 * smoothstep(0.78, 0.95, hf), col.z);
  float env = clamp(col.x * spread, 0.0, 1.0) * profile(hf, col.z);
  env *= mix(1.0, 0.6 + 0.8 * col.w, uStratus * (1.0 - col.z));               // thicker and thinner patches of the deck
  float s = texture(uShape, q / SHAPE).r;
  s = mix(s, 0.5 + 0.5 * s, uStratus * (1.0 - col.z));
  float d = clamp((s - (1.0 - env)) / max(env * mix(0.55, 1.0, uStratus), 0.06), 0.0, 1.0) * env;
  if (fine && d > 0.0) {
    float dn = texture(uDetail, (q + vec3(0.0, uTime * 2.0, 0.0)) / DETAIL).r;
    // erosion: wispy, cauliflower tops on cumulus, a softer texture on stratus
    d = clamp(d - dn * mix(0.42 * (0.25 + hf), 0.22, uStratus) * (1.0 - d), 0.0, 1.0);
  }
  return d;
}
float lightOD(vec3 p, float h) {
  float od = 0.0, st = 70.0;
  vec3 q = p; float hh = h;
  for (int i = 0; i < 5; i++) {
    q += uLightDir * st; hh += uLightDir.y * st;
    od += density(q, hh, column(wsample(q.xz)), false) * st;
    st *= 2.0;
  }
  return od;
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 vp = uInvProj * vec4(ndc, 1.0, 1.0);
  vec3 dir = normalize((uCamRot * vec4(normalize(vp.xyz / vp.w), 0.0)).xyz);
  float r0 = RE + uCam.y;
  vec3 Lsum = vec3(0.0); float T = 1.0;
  float jitter = fract(ign(gl_FragCoord.xy) + uFrame * 0.6180339);
  float hitT = 0.0, hitW = 0.0;

  // ---- rain shafts below the cloud base (curtains drifting with the cloud field)
  if (uRain > 0.01) {
    float tb = dir.y > 0.0 ? shell(r0, dir.y, uBase, false) : 22000.0;
    float tr = min(tb > 0.0 ? tb : 22000.0, 22000.0);
    float ds = tr / 8.0, Tr = 1.0; vec3 Lr = vec3(0.0);
    for (int i = 0; i < 8; i++) {
      float t = (float(i) + jitter) * ds;
      vec3 p = vec3(uCam.x, 0.0, uCam.z) + dir * t;
      float h = length(vec3(0.0, r0, 0.0) + dir * t) - RE;
      if (h < 0.0 || h > uBase) continue;
      vec4 col = column(wsample(p.xz));
      float rr = uRain * smoothstep(0.25, 0.7, col.x) * (0.45 + 0.55 * col.z + 0.3 * uStratus);
      float tt = exp(-rr * 2.2e-4 * ds);
      Lr += Tr * mix(uAmbBot, uAmbTop, 0.35) * 0.85 * (1.0 - tt); Tr *= tt;
    }
    Lsum += Lr; T *= Tr;
  }

  // ---- the cloud layer
  float top = max(uBase + uThick, uCb > 0.01 ? uCbTop : 0.0);
  float t0, t1;
  if (uCam.y < uBase) {
    if (dir.y <= -0.02) { t0 = -1.0; t1 = -1.0; }
    else { t0 = shell(r0, dir.y, uBase - 120.0, false); t1 = shell(r0, dir.y, top, false); }
  } else if (uCam.y < top) {
    t0 = 0.0; float tb = shell(r0, dir.y, uBase, true); t1 = tb > 0.0 ? tb : shell(r0, dir.y, top, false);
  } else {
    t0 = shell(r0, dir.y, top, true); t1 = shell(r0, dir.y, uBase, true); if (t1 < 0.0) t1 = shell(r0, dir.y, top, false);
  }
  if (t0 >= 0.0 && t1 > t0 && t0 < 80000.0 && T > 0.01) {
    t1 = min(t1, t0 + 30000.0);
    // more steps along long (horizon) paths, fewer straight up
    float nf = clamp(24.0 + (t1 - t0) / 220.0, 24.0, float(uMaxSteps));
    float ds = (t1 - t0) / nf;
    float cosT = dot(dir, uLightDir);
    float phase = mix(hg(cosT, 0.65), hg(cosT, -0.25), 0.3);
    float t = t0 + ds * jitter;
    for (int i = 0; i < 160; i++) {
      if (t > t1 || T < 0.015) break;
      vec3 p = vec3(uCam.x, 0.0, uCam.z) + dir * t;
      vec4 col = column(wsample(p.xz));
      if (col.x < 0.01) { t += ds * 2.5; continue; }                             // empty sky: skip ahead
      float h = length(vec3(0.0, r0, 0.0) + dir * t) - RE;
      float d = density(p, h, col, true);
      if (d > 0.002) {
        float sig = d * uDens;
        float od = lightOD(p, h) * uDens;
        float beer = exp(-od) + 0.35 * exp(-od * 0.22);
        float powder = mix(1.0, 1.0 - exp(-sig * 160.0), 0.5 * (1.0 - cosT) * 0.5 + 0.25);
        float hf = clamp((h - uBase) / max(col.y - uBase, 1.0), 0.0, 1.0);
        float tauUp = uDens * 1.2 * max(col.y - h, 0.0) * col.x;
        float occUp = 1.0 / (1.0 + 0.11 * tauUp);
        // the base: darker where the deck above is thicker (lumps), lit from below by the sea
        vec3 S = uLightCol * (phase * beer * powder) + uDiffCol * (0.159 * occUp * max(0.05, uLightDir.y + 0.1)) + mix(uAmbBot, uAmbTop * occUp, hf);
        if (uFlash > 0.0) S += vec3(0.85, 0.9, 1.0) * uFlash * 6.0 * exp(-length(vec3(p.x, h, p.z) - uFlashPos) / 1400.0);
        float Ts = exp(-sig * ds);
        Lsum += T * S * (1.0 - Ts);
        hitT += t * T * (1.0 - Ts); hitW += T * (1.0 - Ts);
        T *= Ts;
      }
      t += ds;
    }
    float dist = hitW > 0.0 ? hitT / hitW : t0;
    float f = exp(-dist / uHazeDist);
    Lsum *= f;
    T = 1.0 - (1.0 - T) * f;
  }
  float hit = hitW > 0.02 ? hitT / hitW : 0.0;                                   // 0 = no cloud in this pixel
  vec4 cur = vec4(Lsum, T);

  // ---- temporal: reproject this pixel's cloud point with the previous camera (rotation + translation)
  vec4 outc = cur; float outd = hit;
  if (uHistValid > 0.5) {
    vec3 rel = dir * (hit > 0.0 ? hit : FAR) + uCamDelta;                      // the point seen from the previous camera
    vec4 pc = uPrevVP * vec4(rel, 1.0);
    if (pc.w > 0.0) {
      vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
      if (puv.x > 0.0 && puv.x < 1.0 && puv.y > 0.0 && puv.y < 1.0) {
        vec4 hist = texture(uHistory, puv);
        float hd = texture(uHistDist, puv).r;
        float w = 0.9;
        if ((hd > 0.0) != (hit > 0.0)) w = 0.55;                                 // edge / noise: lean on the new sample
        else if (hit > 0.0 && abs(hd - hit) > 0.25 * max(hit, 600.0)) w = 0.15;  // a different cloud: reject
        outc = mix(cur, hist, w);
        outd = hit > 0.0 && hd > 0.0 ? mix(hit, hd, w) : hit;
      }
    }
  }
  oCol = outc;
  oDist = vec4(outd, 0.0, 0.0, 1.0);
}`;

/** True if this renderer can render to half-float targets (WebGL2 + EXT_color_buffer_float/half_float). */
export function canRenderHalfFloat(renderer) {
  try {
    if (!renderer.capabilities.isWebGL2) return false;
    const ex = renderer.extensions;
    return ex.has('EXT_color_buffer_float') || ex.has('EXT_color_buffer_half_float');
  } catch { return false; }
}

const WRAP = 420000;

export class VolumeClouds {
  /** @param weatherTex the shared weather-map DataTexture (sky.js) */
  constructor(renderer, weatherTex, { scale = 0.5, steps = 96 } = {}) {
    this.renderer = renderer; this.scale = Math.max(0.5, scale); this.steps = steps;
    this.ready = false; this.frame = 0; this.histValid = false;
    const mk = () => {
      const rt = new THREE.WebGLMultipleRenderTargets(4, 4, 2, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false });
      for (const t of rt.texture) { t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.type = THREE.HalfFloatType; t.generateMipmaps = false; }
      rt.texture[1].minFilter = THREE.NearestFilter; rt.texture[1].magFilter = THREE.NearestFilter;
      return rt;
    };
    this.rts = [mk(), mk()];
    this.cur = 0;
    const blank = new THREE.Data3DTexture(new Uint8Array(8), 2, 2, 2); blank.format = THREE.RedFormat; blank.unpackAlignment = 1; blank.needsUpdate = true;
    this.u = {
      uWeather: { value: weatherTex }, uShape: { value: blank }, uDetail: { value: blank }, uHistory: { value: null }, uHistDist: { value: null },
      uInvProj: { value: new THREE.Matrix4() }, uCamRot: { value: new THREE.Matrix4() }, uPrevVP: { value: new THREE.Matrix4() }, uHistValid: { value: 0 }, uCamDelta: { value: new THREE.Vector3() },
      uRes: { value: new THREE.Vector2(4, 4) }, uFrame: { value: 0 }, uTime: { value: 0 },
      uCam: { value: new THREE.Vector3() }, uWindOff: { value: new THREE.Vector2() },
      uCover: { value: 0.3 }, uBase: { value: 1200 }, uThick: { value: 1500 }, uCbTop: { value: 9000 }, uCb: { value: 0 }, uStratus: { value: 0 }, uDens: { value: 0.035 }, uRain: { value: 0 },
      uLightDir: { value: new THREE.Vector3(0, 1, 0) }, uLightCol: { value: new THREE.Vector3(1, 1, 1) }, uDiffCol: { value: new THREE.Vector3(1, 1, 1) }, uAmbTop: { value: new THREE.Vector3(0.3, 0.35, 0.45) }, uAmbBot: { value: new THREE.Vector3(0.15, 0.17, 0.2) },
      uHazeDist: { value: 40000 }, uFlashPos: { value: new THREE.Vector3() }, uFlash: { value: 0 }, uMaxSteps: { value: steps },
    };
    this.mat = new THREE.ShaderMaterial({ uniforms: this.u, vertexShader: VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false, glslVersion: THREE.GLSL3 });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat); this.quad.frustumCulled = false;
    this.qScene = new THREE.Scene(); this.qScene.add(this.quad);
    this.qCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.prevVP = new THREE.Matrix4(); this.tmpM = new THREE.Matrix4(); this.rotOnly = new THREE.Matrix4();
    this.prevCam = null;
    // the 3D noise is built a few slices per frame (a few ms each) - until then the sky uses its 2D clouds
    this.gens = [{ gen: shapeVolume(64), N: 64, key: 'uShape' }, { gen: detailVolume(32), N: 32, key: 'uDetail' }];
  }
  /** Spend up to `budgetMs` building the noise volumes. Returns true once both exist. */
  build(budgetMs = 5) {
    if (this.ready) return true;
    const t0 = performance.now();
    while (this.gens.length && performance.now() - t0 < budgetMs) {
      const g = this.gens[0], r = g.gen.next();
      if (r.done) {
        const tex = new THREE.Data3DTexture(r.value, g.N, g.N, g.N);
        tex.format = THREE.RedFormat; tex.type = THREE.UnsignedByteType;
        tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
        tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping; tex.unpackAlignment = 1; tex.needsUpdate = true;
        this.u[g.key].value = tex;
        this.gens.shift();
      }
    }
    this.ready = this.gens.length === 0;
    return this.ready;
  }
  get texture() { return this.rts[this.cur].texture[0]; }
  resize(w, h) {
    const W = Math.max(64, Math.round(w * this.scale)), H = Math.max(36, Math.round(h * this.scale));
    if (this.rts[0].width !== W || this.rts[0].height !== H) {
      for (const rt of this.rts) rt.setSize(W, H);
      this.histValid = false; this.u.uRes.value.set(W, H);
    }
  }
  /** Resolution scale (desktop minimum 0.5: lower made the clouds read as low-resolution streaks). */
  setScale(s) { s = Math.max(0.5, s); if (s !== this.scale) { this.scale = s; this.histValid = false; } }
  /** Render this frame's clouds. p: parameters prepared by sky.js (uCam in wrapped stable metres). */
  render(camera, p) {
    if (!this.ready) return false;
    const r = this.renderer, size = r.getDrawingBufferSize(this._sz || (this._sz = new THREE.Vector2()));
    this.resize(size.x, size.y);
    const u = this.u;
    camera.updateMatrixWorld();
    u.uInvProj.value.copy(camera.projectionMatrixInverse);
    this.rotOnly.extractRotation(camera.matrixWorld);
    u.uCamRot.value.copy(this.rotOnly);
    // camera motion since the last frame, in stable metres (wrap-safe); a jump (teleport) drops the history
    const c = p.uCam;
    let hv = this.histValid;
    if (c && this.prevCam) {
      const wr = (d) => d - Math.round(d / WRAP) * WRAP;
      const dx = wr(c.x - this.prevCam.x), dy = c.y - this.prevCam.y, dz = wr(c.z - this.prevCam.z);
      if (Math.hypot(dx, dy, dz) > 2000) hv = false;
      u.uCamDelta.value.set(dx, dy, dz);
    } else { u.uCamDelta.value.set(0, 0, 0); hv = false; }
    if (c) this.prevCam = { x: c.x, y: c.y, z: c.z };
    u.uPrevVP.value.copy(this.prevVP); u.uHistValid.value = hv ? 1 : 0;
    // this frame's view-projection about the camera position (rotation only) for the next frame
    this.tmpM.copy(this.rotOnly).invert(); this.prevVP.multiplyMatrices(camera.projectionMatrix, this.tmpM);
    u.uFrame.value = (this.frame++ % 1024);
    u.uMaxSteps.value = this.steps;
    Object.entries(p).forEach(([k, v]) => {
      const uu = u[k]; if (!uu) return;
      if (uu.value && uu.value.copy && v && typeof v === 'object') uu.value.copy(v); else uu.value = v;
    });
    const src = this.rts[this.cur], dst = this.rts[1 - this.cur];
    u.uHistory.value = src.texture[0]; u.uHistDist.value = src.texture[1];
    const prevRT = r.getRenderTarget(), prevXr = r.xr.enabled;
    r.xr.enabled = false;
    r.setRenderTarget(dst); r.render(this.qScene, this.qCam); r.setRenderTarget(prevRT);
    r.xr.enabled = prevXr;
    this.cur = 1 - this.cur; this.histValid = true;
    return true;
  }
  dispose() { for (const rt of this.rts) rt.dispose(); this.mat.dispose(); this.quad.geometry.dispose(); }
}
