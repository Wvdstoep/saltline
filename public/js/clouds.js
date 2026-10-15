// public/js/clouds.js - raymarched volumetric cloud layer (desktop tier), rendered at reduced resolution into a
// half-float target with temporal accumulation, and composited by the sky dome (sky.js) behind everything opaque.
//  - shape: Perlin-Worley 3D noise eroded by Worley detail (skynoise.js), coverage from a histogram-equalised weather
//    map so the cloud fraction on screen follows the real cloud cover; cumulus / stratus / nimbostratus / cumulonimbus
//    (towers with anvils in convective cells) from the weather (sky.js derives the parameters);
//  - light: Beer-Lambert to the Sun/Moon (5-tap cone march), a second, softer octave for multiple scattering,
//    dual-lobe Henyey-Greenstein (silver lining + back glow), sky ambient from below/above, powder darkening;
//  - lightning: emission around the flash point inside the cloud;
//  - rain shafts: precipitation curtains below the base where it rains, drifting with the cloud field;
//  - aerial perspective: distant clouds fade into the horizon haze;
//  - temporal: one jittered sample per pixel per frame, reprojected by view direction (clouds are far away, so the
//    rotation dominates) and blended 88/12 with the history: ~8x the samples for the price of one.
import * as THREE from 'three';
import { shapeVolume, detailVolume } from './skynoise.js';

const VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const FRAG = /* glsl */`
precision highp float;
precision highp sampler3D;
varying vec2 vUv;
uniform sampler2D uWeather; uniform sampler3D uShape; uniform sampler3D uDetail; uniform sampler2D uHistory;
uniform mat4 uInvProj; uniform mat4 uCamRot; uniform mat4 uPrevVP; uniform float uHistValid;
uniform vec2 uRes; uniform float uFrame; uniform float uTime;
uniform vec3 uCam;            // stable world x, altitude, stable world z (metres)
uniform vec2 uWindOff;        // drift of the low cloud field (metres)
uniform float uCover, uBase, uThick, uCbTop, uCb, uStratus, uDens, uRain;
uniform vec3 uLightDir; uniform vec3 uLightCol; uniform vec3 uDiffCol; uniform vec3 uAmbTop; uniform vec3 uAmbBot;
uniform float uHazeDist;
uniform vec3 uFlashPos; uniform float uFlash;
uniform int uSteps;

#define RE 6360000.0
const float WMAP = 60000.0;   // weather map tile (m)
const float SHAPE = 7000.0;   // shape noise tile (m)
const float DETAIL = 1400.0;  // detail noise tile (m)

float hg(float c, float g) { float g2 = g * g; return 0.0795775 * (1.0 - g2) / pow(max(1e-4, 1.0 + g2 - 2.0 * g * c), 1.5); }
// distance along the ray to the sphere of radius RE + h (far root when inside), -1 if none
float shell(float r0, float dy, float h, bool nearRoot) {
  float R = RE + h, b = r0 * dy, c = r0 * r0 - R * R, d = b * b - c;
  if (d < 0.0) return -1.0;
  float s = sqrt(d);
  return nearRoot ? -b - s : -b + s;
}
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

vec4 wsample(vec2 xz) { return texture(uWeather, (xz + uWindOff) / WMAP); }

// cloud envelope at a column: x = coverage 0..1, y = local top height (m), z = convective-cell weight
vec3 column(vec4 wm) {
  float cell = smoothstep(0.55, 0.92, wm.g) * uCb;
  float cov = clamp(uCover + cell * 0.45, 0.0, 1.0);
  float covered = smoothstep(1.0 - cov - 0.06, 1.0 - cov + 0.22, wm.r);
  covered = max(covered, cell * smoothstep(0.62, 0.9, wm.g));
  float top = mix(uBase + uThick, uCbTop, cell);
  return vec3(covered, top, cell);
}
float profile(float hf, float cell) {
  float cu = smoothstep(0.0, 0.12, hf) * (1.0 - smoothstep(0.55, 1.0, hf));      // cumulus: rounded tops
  float st = smoothstep(0.0, 0.2, hf) * (1.0 - smoothstep(0.7, 1.0, hf));        // stratus: flat slab
  float cb = smoothstep(0.0, 0.05, hf) * (1.0 - smoothstep(0.92, 1.0, hf));      // cumulonimbus: full height
  return mix(mix(cu, st, uStratus), cb, cell);
}
float density(vec3 p, float h, bool fine) {
  vec3 col = column(wsample(p.xz));
  float hf = (h - uBase) / max(col.y - uBase, 1.0);
  if (hf <= 0.0 || hf >= 1.0 || col.x < 0.01) return 0.0;
  // cumulus narrow towards the top; a cumulonimbus is narrow in the middle and spreads into an anvil
  float spread = mix(1.0 - 0.45 * hf, 1.0, uStratus);
  spread = mix(spread, 0.75 + 0.6 * smoothstep(0.78, 0.95, hf), col.z);
  float env = clamp(col.x * spread, 0.0, 1.0) * profile(hf, col.z);
  vec3 q = vec3(p.x, h * 1.6, p.z) + vec3(uWindOff.x, uTime * 0.6, uWindOff.y);
  float s = texture(uShape, q / SHAPE).r;
  s = mix(s, 0.55 + 0.45 * s, uStratus * (1.0 - col.z));
  float d = clamp((s - (1.0 - env)) / max(env, 0.08), 0.0, 1.0) * env;
  if (fine && d > 0.0) {
    float dn = texture(uDetail, (q + vec3(0.0, uTime * 2.0, 0.0)) / DETAIL).r;
    d = clamp(d - dn * 0.32 * (1.0 - d) * (0.5 + hf), 0.0, 1.0);
  }
  return d;
}
float lightOD(vec3 p, float h) {
  float od = 0.0, st = 70.0;
  vec3 q = p; float hh = h;
  for (int i = 0; i < 5; i++) {
    q += uLightDir * st; hh += uLightDir.y * st;
    od += density(q, hh, false) * st;
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
      vec3 col = column(wsample(p.xz));
      float rr = uRain * smoothstep(0.25, 0.7, col.x) * (0.45 + 0.55 * col.z + 0.3 * uStratus);
      float sig = rr * 2.2e-4;
      float tt = exp(-sig * ds);
      vec3 S = mix(uAmbBot, uAmbTop, 0.35) * 0.85;
      Lr += Tr * S * (1.0 - tt); Tr *= tt;
    }
    Lsum += Lr; T *= Tr;
  }

  // ---- the cloud layer
  float top = max(uBase + uThick, uCb > 0.01 ? uCbTop : 0.0);
  float t0, t1;
  if (uCam.y < uBase) {
    if (dir.y <= -0.02) { t0 = -1.0; t1 = -1.0; }
    else { t0 = shell(r0, dir.y, uBase, false); t1 = shell(r0, dir.y, top, false); }
  } else if (uCam.y < top) {
    t0 = 0.0; float tb = shell(r0, dir.y, uBase, true); t1 = tb > 0.0 ? tb : shell(r0, dir.y, top, false);
  } else {
    t0 = shell(r0, dir.y, top, true); t1 = shell(r0, dir.y, uBase, true); if (t1 < 0.0) t1 = shell(r0, dir.y, top, false);
  }
  if (t0 >= 0.0 && t1 > t0 && t0 < 80000.0 && T > 0.01) {
    t1 = min(t1, t0 + 30000.0);
    int N = uSteps;
    float ds = (t1 - t0) / float(N);
    float cosT = dot(dir, uLightDir);
    float phase = mix(hg(cosT, 0.65), hg(cosT, -0.25), 0.3);
    float t = t0 + ds * jitter;
    for (int i = 0; i < 96; i++) {
      if (i >= N || T < 0.015) break;
      vec3 p = vec3(uCam.x, 0.0, uCam.z) + dir * t;
      float h = length(vec3(0.0, r0, 0.0) + dir * t) - RE;
      float d = density(p, h, true);
      if (d > 0.002) {
        float sig = d * uDens;
        float od = lightOD(p, h) * uDens;
        float beer = exp(-od) + 0.35 * exp(-od * 0.22);                         // + a multiple-scattering octave
        float powder = mix(1.0, 1.0 - exp(-sig * 160.0), 0.5 * (1.0 - cosT) * 0.5 + 0.25);
        vec3 col = column(wsample(p.xz));
        float hf = clamp((h - uBase) / max(col.y - uBase, 1.0), 0.0, 1.0);
        // diffuse light transmitted down through the cloud above (two-stream: 1 / (1 + 0.75 tau (1 - g)))
        float tauUp = uDens * 1.2 * max(col.y - h, 0.0) * col.x;
        float occUp = 1.0 / (1.0 + 0.11 * tauUp);                              // ... and hides the sky above
        vec3 S = uLightCol * (phase * beer * powder) + uDiffCol * (0.159 * occUp * max(0.05, uLightDir.y + 0.1)) + mix(uAmbBot, uAmbTop * occUp, hf);
        if (uFlash > 0.0) S += vec3(0.85, 0.9, 1.0) * uFlash * 6.0 * exp(-length(vec3(p.x, h, p.z) - uFlashPos) / 1400.0);
        float Ts = exp(-sig * ds);
        Lsum += T * S * (1.0 - Ts);
        hitT += t * T * (1.0 - Ts); hitW += T * (1.0 - Ts);
        T *= Ts;
      }
      t += ds;
    }
    // aerial perspective: distant cloud fades into the sky's own horizon haze behind it
    float dist = hitW > 0.0 ? hitT / hitW : t0;
    float f = exp(-dist / uHazeDist);
    Lsum *= f;
    T = 1.0 - (1.0 - T) * f;
  }
  vec4 cur = vec4(Lsum, T);

  // ---- temporal accumulation (reproject by direction)
  vec4 outc = cur;
  if (uHistValid > 0.5) {
    vec4 pc = uPrevVP * vec4(dir, 0.0);
    if (pc.w > 0.0) {
      vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
      if (puv.x > 0.0 && puv.x < 1.0 && puv.y > 0.0 && puv.y < 1.0) {
        vec4 hist = texture(uHistory, puv);
        outc = mix(cur, hist, 0.88);
      }
    }
  }
  gl_FragColor = outc;
}`;

/** True if this renderer can render to half-float targets (WebGL2 + EXT_color_buffer_float/half_float). */
export function canRenderHalfFloat(renderer) {
  try {
    if (!renderer.capabilities.isWebGL2) return false;
    const ex = renderer.extensions;
    return ex.has('EXT_color_buffer_float') || ex.has('EXT_color_buffer_half_float');
  } catch { return false; }
}

export class VolumeClouds {
  /** @param weatherTex the shared weather-map DataTexture (sky.js) */
  constructor(renderer, weatherTex, { scale = 0.5, steps = 40 } = {}) {
    this.renderer = renderer; this.scale = scale; this.steps = steps;
    this.ready = false; this.frame = 0; this.histValid = false;
    this.rts = [0, 1].map(() => new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false }));
    this.cur = 0;
    const blank = new THREE.Data3DTexture(new Uint8Array(8), 2, 2, 2); blank.format = THREE.RedFormat; blank.unpackAlignment = 1; blank.needsUpdate = true;
    this.u = {
      uWeather: { value: weatherTex }, uShape: { value: blank }, uDetail: { value: blank }, uHistory: { value: null },
      uInvProj: { value: new THREE.Matrix4() }, uCamRot: { value: new THREE.Matrix4() }, uPrevVP: { value: new THREE.Matrix4() }, uHistValid: { value: 0 },
      uRes: { value: new THREE.Vector2(4, 4) }, uFrame: { value: 0 }, uTime: { value: 0 },
      uCam: { value: new THREE.Vector3() }, uWindOff: { value: new THREE.Vector2() },
      uCover: { value: 0.3 }, uBase: { value: 1200 }, uThick: { value: 1500 }, uCbTop: { value: 9000 }, uCb: { value: 0 }, uStratus: { value: 0 }, uDens: { value: 0.035 }, uRain: { value: 0 },
      uLightDir: { value: new THREE.Vector3(0, 1, 0) }, uLightCol: { value: new THREE.Vector3(1, 1, 1) }, uDiffCol: { value: new THREE.Vector3(1, 1, 1) }, uAmbTop: { value: new THREE.Vector3(0.3, 0.35, 0.45) }, uAmbBot: { value: new THREE.Vector3(0.15, 0.17, 0.2) },
      uHazeDist: { value: 40000 }, uFlashPos: { value: new THREE.Vector3() }, uFlash: { value: 0 }, uSteps: { value: steps },
    };
    this.mat = new THREE.ShaderMaterial({ uniforms: this.u, vertexShader: VERT, fragmentShader: FRAG, depthTest: false, depthWrite: false });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat); this.quad.frustumCulled = false;
    this.qScene = new THREE.Scene(); this.qScene.add(this.quad);
    this.qCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.prevVP = new THREE.Matrix4(); this.tmpM = new THREE.Matrix4(); this.rotOnly = new THREE.Matrix4();
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
  get texture() { return this.rts[this.cur].texture; }
  resize(w, h) {
    const W = Math.max(64, Math.round(w * this.scale)), H = Math.max(36, Math.round(h * this.scale));
    if (this.rts[0].width !== W || this.rts[0].height !== H) {
      for (const rt of this.rts) rt.setSize(W, H);
      this.histValid = false; this.u.uRes.value.set(W, H);
    }
  }
  setScale(s) { if (s !== this.scale) { this.scale = s; this.histValid = false; } }
  /** Render this frame's clouds. p: parameters prepared by sky.js. */
  render(camera, p) {
    if (!this.ready) return false;
    const r = this.renderer, size = r.getDrawingBufferSize(this._sz || (this._sz = new THREE.Vector2()));
    this.resize(size.x, size.y);
    const u = this.u;
    camera.updateMatrixWorld();
    u.uInvProj.value.copy(camera.projectionMatrixInverse);
    this.rotOnly.extractRotation(camera.matrixWorld);
    u.uCamRot.value.copy(this.rotOnly);
    u.uPrevVP.value.copy(this.prevVP); u.uHistValid.value = this.histValid ? 1 : 0;
    // this frame's view-projection (rotation only) for the next frame's reprojection
    this.tmpM.copy(this.rotOnly).invert(); this.prevVP.multiplyMatrices(camera.projectionMatrix, this.tmpM);
    u.uFrame.value = (this.frame++ % 1024);
    u.uSteps.value = this.steps;
    Object.entries(p).forEach(([k, v]) => {
      const uu = u[k]; if (!uu) return;
      if (uu.value && uu.value.copy && v && typeof v === 'object') uu.value.copy(v); else uu.value = v;
    });
    const src = this.rts[this.cur], dst = this.rts[1 - this.cur];
    u.uHistory.value = src.texture;
    const prevRT = r.getRenderTarget(), prevXr = r.xr.enabled;
    r.xr.enabled = false;
    r.setRenderTarget(dst); r.render(this.qScene, this.qCam); r.setRenderTarget(prevRT);
    r.xr.enabled = prevXr;
    this.cur = 1 - this.cur; this.histValid = true;
    return true;
  }
  dispose() { for (const rt of this.rts) rt.dispose(); this.mat.dispose(); this.quad.geometry.dispose(); }
}
