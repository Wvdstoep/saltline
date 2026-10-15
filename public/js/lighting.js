// Saltline lighting pipeline (docs: NOTES-light.md): cascaded sun / moon shadows, the post chain (RenderPass ->
// GTAO -> UnrealBloom -> OutputPass with the sky's ACES + exposure), and a quality ladder for the frame-rate governor.
//
// SHADOWS. N shadow-casting DirectionalLights ("cascades") carry the KEY light: the Sun, or the Moon when it is the
// brighter of the two (sky.js keeps computing both; during render() the key light's own intensity is lent to the
// cascades and given back afterwards, so nothing is counted twice and nothing outside the render sees a change).
// Every lit three.js material (Standard / Physical / Lambert / Phong / Toon) picks its cascade by a GLOBAL patch of
// ShaderChunk.lights_fragment_begin made when this module is evaluated (before any program compiles; it must be
// imported by main.js before the first render): the first shadowed directional light whose shadow coordinate lies
// inside its map lights the fragment, the last one is the fallback (unshadowed beyond its range). All indices are
// constants after three's loop unrolling - no runtime-indexed uniform arrays, no inout, no discard (Adreno 660 safe).
// RULE: no other code may create a castShadow DirectionalLight (it would be taken for a cascade).
// Cascade 0 is a "focus" sphere around the own ship (the chase camera sits 60-230 m away, a 0-60 m slice would miss
// it), cascade 1 the view frustum to 400 m, cascade 2 to 2500 m; each a fixed-radius sphere, texel-snapped (stable).
//
// OCEAN HOOK (ocean2.js is not edited here): `app.lighting.shadowUniforms()` returns uniform objects (same instances
// every call, values kept current) and `app.lighting.shadowGLSL` a GLSL chunk declaring them plus
// `float saltlineShadow( vec3 worldPos )` (1 = lit, 0 = shadow). Check `app.lighting.oceanShadowOk` first.
//
// Debug: ?light=off|low|medium|high (forces a level, governor off), window.saltlineLight(level|q|null).
import * as THREE from 'three';

// ---------------------------------------------------------------------------------------------- shader patches
const LFB_DECL = 'DirectionalLightShadow directionalLightShadow;';
const LFB_SHADOW = 'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;';
const LFB_CSM = `{
		vec3 slP = vDirectionalShadowCoord[ i ].xyz / vDirectionalShadowCoord[ i ].w;
		float slM = 2.0 / directionalLightShadow.shadowMapSize.x;
		bool slIn = slP.x > slM && slP.x < 1.0 - slM && slP.y > slM && slP.y < 1.0 - slM && slP.z < 1.0;
		#if ( UNROLLED_LOOP_INDEX == NUM_DIR_LIGHT_SHADOWS - 1 )
		slIn = true;
		#endif
		float slW = ( slIn && slCsmTaken < 0.5 ) ? 1.0 : 0.0;
		slCsmTaken = max( slCsmTaken, slW );
		directLight.color *= slW;
		if ( slW > 0.5 && directLight.visible && receiveShadow ) directLight.color *= getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] );
		}`;

/** Pure: the CSM version of three's lights_fragment_begin chunk, or null when the r160 text is not found. */
export function patchLightsChunk(src) {
  if (typeof src !== 'string' || src.includes('slCsmTaken')) return src.includes?.('slCsmTaken') ? src : null;
  if (src.split(LFB_DECL).length !== 2 || src.split(LFB_SHADOW).length !== 2) return null;
  return src.replace(LFB_DECL, LFB_DECL + '\n\tfloat slCsmTaken = 0.0;').replace(LFB_SHADOW, LFB_CSM);
}

const ORIGINAL_LFB = THREE.ShaderChunk.lights_fragment_begin;
let CHUNK_STATE = 'unpatched';
{
  const p = patchLightsChunk(ORIGINAL_LFB);
  if (p) { THREE.ShaderChunk.lights_fragment_begin = p; CHUNK_STATE = 'patched'; }
  else { CHUNK_STATE = 'chunk text not found (three version?)'; console.error('[lighting] lights_fragment_begin not recognised: cascaded shadows off'); }
}
function restoreChunk() { THREE.ShaderChunk.lights_fragment_begin = ORIGINAL_LFB; }

// inverse of OutputPass (sRGB + ACES) for ShaderMaterials that write display values (no colorspace_fragment):
// in composer mode they must output the scene value that tone-maps back to what they wrote, so they look the same
const glslMat3 = (cols) => { const m = new THREE.Matrix3().fromArray(cols).invert(); return 'mat3(' + m.elements.map((v) => v.toFixed(7)).join(', ') + ')'; };
const ACES_IN_INV = glslMat3([0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777]);
const ACES_OUT_INV = glslMat3([1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602]);
const INV_DECL = `
uniform float slPostInv;
uniform float slExposure;
vec3 slDisplayToScene( vec3 d ) {
	d = clamp( d, 0.0, 1.0 );
	vec3 l = mix( d / 12.92, pow( ( d + 0.055 ) / 1.055, vec3( 2.4 ) ), step( vec3( 0.04045 ), d ) );
	vec3 c = clamp( ${ACES_OUT_INV} * min( l, vec3( 0.985 ) ), 0.0, 0.985 );
	vec3 a = 0.983729 * c - 1.0;
	vec3 b = 0.4329510 * c - 0.0245786;
	vec3 k = 0.238081 * c + 0.000090537;
	vec3 v = ( - b - sqrt( max( b * b - 4.0 * a * k, vec3( 0.0 ) ) ) ) / ( 2.0 * a );
	return max( ${ACES_IN_INV} * v, vec3( 0.0 ) ) * ( 0.6 / max( slExposure, 1e-4 ) );
}
`;
/** Pure: inject the gated display->scene inverse at the end of main(); null if the shader does not qualify. */
export function injectDisplayInverse(frag) {
  if (typeof frag !== 'string' || frag.includes('slDisplayToScene')) return null;
  if (/colorspace_fragment|tonemapping_fragment|linearToOutputTexel/.test(frag) || !frag.includes('gl_FragColor')) return null;
  const mi = frag.search(/void\s+main\s*\(/), end = frag.lastIndexOf('}');
  if (mi < 0 || end < mi || frag.slice(end + 1).trim() !== '') return null;
  return frag.slice(0, mi) + INV_DECL + frag.slice(mi, end) + '\tif ( slPostInv > 0.5 ) gl_FragColor.rgb = slDisplayToScene( gl_FragColor.rgb );\n}\n';
}
/** JS twin of the GLSL inverse (tests): display value d (0..1) -> scene value x with acesTone-then-sRGB(x) = d. */
export function displayToScene(d, exposure = 1) {
  const inv = (cols) => new THREE.Matrix3().fromArray(cols).invert().elements;
  const mo = inv([1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602]);
  const mi = inv([0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777]);
  const mul = (e, x) => [0, 1, 2].map((r) => e[r] * x[0] + e[3 + r] * x[1] + e[6 + r] * x[2]);
  const l = d.map((v) => { v = Math.min(1, Math.max(0, v)); return Math.min(0.985, v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)); });
  const c = mul(mo, l).map((v) => Math.min(0.985, Math.max(0, v)));
  const vv = c.map((ci) => { const a = 0.983729 * ci - 1, b = 0.432951 * ci - 0.0245786, k = 0.238081 * ci + 0.000090537; return (-b - Math.sqrt(Math.max(0, b * b - 4 * a * k))) / (2 * a); });
  return mul(mi, vv).map((v) => Math.max(0, v) * 0.6 / exposure);
}

// ---------------------------------------------------------------------------------------------- pure geometry
/** Bounding sphere of the view-frustum slice [n, f] (distance along the view axis, radius): fixed for a fixed slice. */
export function sliceSphere(n, f, fovDeg, aspect) {
  const t = Math.tan((fovDeg * Math.PI) / 360), k2 = t * t * (1 + aspect * aspect);
  let zc = 0.5 * (n + f) * (1 + k2);
  if (zc >= f) return { z: f, r: f * Math.sqrt(k2) };
  return { z: zc, r: Math.sqrt((f - zc) * (f - zc) + f * f * k2) };
}
/** Light-space basis of three's Object3D.lookAt for a camera at target + L (up = +y): x, y, z (= L). */
export function lightBasis(L) {
  const z = new THREE.Vector3(L.x, L.y, L.z).normalize();
  let x = new THREE.Vector3(0, 1, 0).cross(z);
  if (x.lengthSq() < 1e-8) x = new THREE.Vector3(0, 0, 1).cross(z);
  x.normalize();
  return { x, y: new THREE.Vector3().crossVectors(z, x), z };
}
/** Snap a world centre to the shadow texel grid of a cascade (texel = 2r / size) in the light's basis. */
export function snapCenter(c, basis, texel) {
  const cx = c.dot(basis.x), cy = c.dot(basis.y);
  const sx = Math.round(cx / texel) * texel, sy = Math.round(cy / texel) * texel;
  return c.clone().addScaledVector(basis.x, sx - cx).addScaledVector(basis.y, sy - cy);
}

// ---------------------------------------------------------------------------------------------- quality
export const PRESETS = {
  off: { shadows: false, cascades: 0, size: 1024, soft: false, bloom: 0, ao: false, msaa: 0 },
  low: { shadows: true, cascades: 1, size: 1024, soft: false, bloom: 0, ao: false, msaa: 0 },
  medium: { shadows: true, cascades: 2, size: 2048, soft: true, bloom: 0.5, ao: false, msaa: 2 },
  high: { shadows: true, cascades: 3, size: 2048, soft: true, bloom: 1, ao: true, msaa: 4 },
  phone: { shadows: true, cascades: 1, size: 1024, soft: false, bloom: 0.35, ao: false, msaa: 2 },
};
/** Pure: what quality q (0..1) allows under a preset. Order of loss: bloom resolution, AO, cascades, bloom. */
export function qualityLadder(q, P) {
  const s = { cascades: P.cascades, bloom: P.bloom, ao: P.ao };
  if (q < 0.85) s.bloom = Math.min(s.bloom, 0.5);
  if (q < 0.7) s.ao = false;
  if (q < 0.55) s.cascades = Math.max(Math.min(1, P.cascades), P.cascades - 1);
  if (q < 0.4) { s.cascades = Math.min(1, P.cascades); s.bloom = Math.min(s.bloom, 0.35); }
  if (q < 0.25) s.bloom = 0;
  return s;
}

// ---------------------------------------------------------------------------------------------- ocean chunk
export const SHADOW_GLSL = `
uniform sampler2D slShadowMap0;
uniform sampler2D slShadowMap1;
uniform sampler2D slShadowMap2;
uniform mat4 slShadowMatrix0;
uniform mat4 slShadowMatrix1;
uniform mat4 slShadowMatrix2;
uniform vec3 slShadowBias;
uniform vec3 slShadowTexel;
uniform float slShadowN;
float slUnpackDepth( vec4 v ) { return dot( v, vec4( 255.0 / 256.0 ) / vec4( 16777216.0, 65536.0, 256.0, 1.0 ) ); }
float slShadowTap( sampler2D m, vec2 uv, float z ) { return step( z, slUnpackDepth( texture2D( m, uv ) ) ); }
float slShadowPCF( sampler2D m, vec3 p, float t ) {
	return 0.25 * ( slShadowTap( m, p.xy + vec2( -0.5, -0.5 ) * t, p.z ) + slShadowTap( m, p.xy + vec2( 0.5, -0.5 ) * t, p.z )
		+ slShadowTap( m, p.xy + vec2( -0.5, 0.5 ) * t, p.z ) + slShadowTap( m, p.xy + vec2( 0.5, 0.5 ) * t, p.z ) );
}
float slInside( vec3 p, float t ) { return ( p.x > 2.0 * t && p.x < 1.0 - 2.0 * t && p.y > 2.0 * t && p.y < 1.0 - 2.0 * t && p.z < 1.0 ) ? 1.0 : 0.0; }
float saltlineShadow( vec3 worldPos ) {
	if ( slShadowN < 0.5 ) return 1.0;
	vec4 q0 = slShadowMatrix0 * vec4( worldPos, 1.0 );
	vec3 p0 = q0.xyz / q0.w; p0.z += slShadowBias.x;
	if ( slInside( p0, slShadowTexel.x ) > 0.5 ) return slShadowPCF( slShadowMap0, p0, slShadowTexel.x );
	if ( slShadowN > 1.5 ) {
		vec4 q1 = slShadowMatrix1 * vec4( worldPos, 1.0 );
		vec3 p1 = q1.xyz / q1.w; p1.z += slShadowBias.y;
		if ( slInside( p1, slShadowTexel.y ) > 0.5 ) return slShadowPCF( slShadowMap1, p1, slShadowTexel.y );
	}
	if ( slShadowN > 2.5 ) {
		vec4 q2 = slShadowMatrix2 * vec4( worldPos, 1.0 );
		vec3 p2 = q2.xyz / q2.w; p2.z += slShadowBias.z;
		if ( slInside( p2, slShadowTexel.z ) > 0.5 ) return slShadowPCF( slShadowMap2, p2, slShadowTexel.z );
	}
	return 1.0;
}
`;

const LIT = (m) => !!m && (m.isMeshStandardMaterial || m.isMeshLambertMaterial || m.isMeshPhongMaterial || m.isMeshToonMaterial);
const qs = (k) => { try { return new URLSearchParams(location.search).get(k); } catch { return null; } };
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------------------------------------- the pipeline
export class Lighting {
  /** app: { renderer, scene, camera, sun (DirectionalLight), skySys? (moonLight, hdrFog, state), myMesh?, ashore?, interior? } */
  constructor(app, opts = {}) {
    this.app = app; this.renderer = app.renderer; this.scene = app.scene; this.camera = app.camera;
    this.phone = !!opts.phone;
    const forced = (opts.level || qs('light') || '').toLowerCase();
    this.forced = PRESETS[forced] ? forced : null;
    this.presetName = this.forced || (this.phone ? 'phone' : 'high');
    this.P = { ...PRESETS[this.presetName] };
    if (this.phone && !this.forced) this.P.size = Math.min(this.P.size, 1024);
    this.q = 1; this.S = qualityLadder(1, this.P);
    this.gov = { ema: 1 / 60, last: performance.now(), since: performance.now() };
    this.frame = 0; this.lastSweep = -1e9;
    this.log = []; this.why = '';
    this.state = { chunk: CHUNK_STATE, shadows: 'off', post: 'off', ao: 'off', selfTest: 'not run', oceanHook: 'not tested' };
    this.dummy = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); this.dummy.needsUpdate = true;
    this.shadowU = {
      slShadowMap0: { value: this.dummy }, slShadowMap1: { value: this.dummy }, slShadowMap2: { value: this.dummy },
      slShadowMatrix0: { value: new THREE.Matrix4() }, slShadowMatrix1: { value: new THREE.Matrix4() }, slShadowMatrix2: { value: new THREE.Matrix4() },
      slShadowBias: { value: new THREE.Vector3() }, slShadowTexel: { value: new THREE.Vector3(1 / 1024, 1 / 1024, 1 / 1024) }, slShadowN: { value: 0 },
    };
    this.shadowGLSL = SHADOW_GLSL;
    this.oceanShadowOk = false;
    this.invU = { slPostInv: { value: 0 }, slExposure: { value: 1 } };
    this.cascades = [];
    this.shadowsOk = false;
    this.postActive = false; this.composer = null; this.post = null; this.postFailed = false;
    this._v = new THREE.Vector3(); this._f = new THREE.Vector3(); this._L = new THREE.Vector3();
    this.focusR = 60; this.focusOf = null;
    this.initShadows();
    if (this.P.bloom > 0 || this.P.ao) this.initPost();
    window.saltlineLight = (x) => this.debugSet(x);
  }

  // ------------------------------------------------------------------ shadows
  initShadows() {
    const r = this.renderer;
    if (!this.P.shadows || CHUNK_STATE !== 'patched') { this.state.shadows = this.P.shadows ? 'off: ' + CHUNK_STATE : 'off (level)'; return; }
    r.shadowMap.enabled = true;
    r.shadowMap.type = this.P.soft ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    r.shadowMap.autoUpdate = false;
    for (let i = 0; i < 3; i++) {
      const l = new THREE.DirectionalLight(0xffffff, 0);
      l.name = 'csmCascade' + i; l.castShadow = true;
      l.shadow.autoUpdate = false;
      l.shadow.camera.near = 0.5;
      this.scene.add(l); this.scene.add(l.target);
      this.cascades.push({ light: l, r: 0, texel: 1, ext: [180, 350, 700][i], every: 1 });
      this.shadowU['slShadowMatrix' + i].value = l.shadow.matrix;   // the very matrix three fills when it renders the map
    }
    const t = this.selfTest();
    this.state.selfTest = t.ok ? 'ok' : 'FAILED: ' + t.why;
    this.oceanShadowOk = t.oceanOk; this.state.oceanHook = t.oceanOk ? 'ok' : 'FAILED: ' + t.oceanWhy;
    if (!t.ok) {
      console.error('[lighting] shadow self-test failed, shadows off: ' + t.why);
      this.disableShadows('self-test failed: ' + t.why);
      return;
    }
    if (!t.oceanOk) console.error('[lighting] ocean shadow chunk self-test failed (ocean must not inject shadowGLSL): ' + t.oceanWhy);
    this.shadowsOk = true;
    this.applyCascades();
  }
  disableShadows(why) {
    const r = this.renderer;
    r.shadowMap.enabled = false;
    for (const c of this.cascades) { c.light.castShadow = false; c.light.visible = false; c.light.shadow.map?.dispose(); c.light.shadow.map = null; }
    restoreChunk(); CHUNK_STATE = 'restored'; this.shadowsOk = false; this.oceanShadowOk = false;
    this.shadowU.slShadowN.value = 0;
    this.state.shadows = 'off: ' + why;
  }
  /** cascade count / map size from the current settings (count changes recompile the lit programs once) */
  applyCascades() {
    if (!this.shadowsOk) return;
    const n = Math.max(1, Math.min(3, this.S.cascades)), size = this.P.size;
    this.cascades.forEach((c, i) => {
      const on = i < n, l = c.light;
      l.visible = on; l.castShadow = on;
      if (l.shadow.mapSize.x !== size) { l.shadow.mapSize.set(size, size); if (l.shadow.map) { l.shadow.map.dispose(); l.shadow.map = null; } }
    });
    this.nCasc = n;
    this.state.shadows = `${n} cascade${n > 1 ? 's' : ''} @ ${size}px ${this.P.soft ? 'PCF soft' : 'PCF'}`;
  }
  /** Render an 8x8 target with the patched lit materials (and the ocean chunk), read it back: the program must link and draw. */
  selfTest() {
    const r = this.renderer, n = Math.max(1, this.P.cascades);
    const res = { ok: true, why: '', oceanOk: true, oceanWhy: '' };
    const scene = new THREE.Scene(), objs = [];
    for (let i = 0; i < n; i++) { const l = new THREE.DirectionalLight(0xffffff, 1); l.castShadow = true; l.shadow.mapSize.set(16, 16); l.position.set(2 + i, 10, 4); scene.add(l); scene.add(l.target); objs.push(l); }
    scene.add(new THREE.DirectionalLight(0xffffff, 0.5), new THREE.DirectionalLight(0x8899ff, 0.1), new THREE.HemisphereLight(0xffffff, 0x334455, 0.5));
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x808080, roughness: 0.8 });
    const boxMat = new THREE.MeshLambertMaterial({ color: 0xa0a0a0 });
    const pg = new THREE.PlaneGeometry(40, 40); pg.rotateX(-Math.PI / 2);
    const floor = new THREE.Mesh(pg, floorMat); floor.receiveShadow = true; scene.add(floor);
    const box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), boxMat); box.position.y = 1; box.castShadow = true; box.receiveShadow = true; scene.add(box);
    const oceanMat = new THREE.ShaderMaterial({
      uniforms: { ...this.shadowU },
      vertexShader: 'varying vec3 vW; void main() { vec4 w = modelMatrix * vec4( position, 1.0 ); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
      fragmentShader: SHADOW_GLSL + '\nvarying vec3 vW; void main() { gl_FragColor = vec4( vec3( 0.2 + 0.6 * saltlineShadow( vW ) ), 1.0 ); }',
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), oceanMat); quad.position.set(0, 3, 6); scene.add(quad);
    const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 200); cam.position.set(0, 10, 12); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();
    const rt = new THREE.WebGLRenderTarget(8, 8, { type: THREE.UnsignedByteType, depthBuffer: true });
    const px = new Uint8Array(8 * 8 * 4);
    const prevRT = r.getRenderTarget(), cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha(), ac = r.autoClear;
    try {
      r.shadowMap.needsUpdate = true;
      r.setRenderTarget(rt); r.setClearColor(0xff00ff, 1); r.autoClear = true;
      r.render(scene, cam);
      r.readRenderTargetPixels(rt, 0, 0, 8, 8, px);
    } catch (e) { res.ok = false; res.why = 'render threw: ' + (e?.message || e); }
    finally { r.setRenderTarget(prevRT); r.setClearColor(cc, ca); r.autoClear = ac; }
    const bad = (m) => { const p = r.properties.get(m)?.currentProgram; return p && p.diagnostics && p.diagnostics.runnable === false ? (p.diagnostics.programLog || p.diagnostics.fragmentShader?.log || p.diagnostics.vertexShader?.log || 'link failed').slice(0, 400) : ''; };
    if (res.ok) {
      const bf = bad(floorMat) || bad(boxMat);
      if (bf) { res.ok = false; res.why = 'lit program failed to link: ' + bf; }
    }
    const bo = bad(oceanMat);
    if (bo) { res.oceanOk = false; res.oceanWhy = 'program failed to link: ' + bo; }
    if (res.ok) {
      let magenta = 0;
      for (let i = 0; i < 64; i++) if (px[i * 4] > 235 && px[i * 4 + 1] < 25 && px[i * 4 + 2] > 235) magenta++;
      if (magenta > 40) { res.ok = false; res.why = `nothing drawn (${magenta}/64 pixels still clear colour)`; }
    }
    // keep nothing alive (the floor/box programs stay cached: the same variant the game uses)
    rt.dispose(); pg.dispose(); box.geometry.dispose(); quad.geometry.dispose(); floorMat.dispose(); boxMat.dispose(); oceanMat.dispose();
    for (const l of objs) l.shadow.map?.dispose();
    return res;
  }

  /** the key light this frame: the brighter of the sky's Sun and Moon */
  keyLight() {
    const sun = this.app.sun, moon = this.app.skySys?.moonLight;
    if (moon && moon.intensity > (sun?.intensity || 0)) return moon;
    return sun || null;
  }
  focus() {
    const a = this.app, cam = this.camera;
    const walking = !!a.ashore?.active || !!a.interior?.active;
    if (!walking && a.myMesh) {
      if (this.focusOf !== a.myMesh) {
        this.focusOf = a.myMesh;
        try {
          const b = new THREE.Box3().setFromObject(a.myMesh), s = b.getSize(new THREE.Vector3());
          this.focusR = THREE.MathUtils.clamp(0.5 * Math.hypot(s.x, s.z) + 0.3 * s.y + 20, 45, 260);
        } catch { this.focusR = 80; }
      }
      a.myMesh.getWorldPosition(this._v);
      return { c: this._v.clone(), r: this.focusR };
    }
    cam.getWorldDirection(this._f);
    return { c: cam.position.clone().addScaledVector(this._f, 25), r: 50 };
  }
  /** place one cascade's light + ortho camera around a sphere (texel-snapped, fixed radius) */
  fit(i, center, r) {
    const c = this.cascades[i], l = c.light, s = l.shadow, cam = s.camera, size = s.mapSize.x;
    const texel = (2 * r) / size, basis = lightBasis(this._L);
    const sc = snapCenter(center, basis, texel);
    l.target.position.copy(sc); l.position.copy(sc).addScaledVector(basis.z, r + c.ext);
    const far = 2 * r + c.ext + 1;
    if (cam.right !== r || cam.far !== far) { cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r; cam.near = 0.5; cam.far = far; cam.updateProjectionMatrix(); }
    s.bias = -(0.6 * texel) / far - 0.00005; s.normalBias = 1.2 * texel;
    l.updateMatrixWorld(); l.target.updateMatrixWorld();
    c.r = r; c.texel = texel;
    this.shadowU.slShadowBias.value.setComponent(i, s.bias);
    this.shadowU.slShadowTexel.value.setComponent(i, 1 / size);
  }
  updateRig() {
    if (!this.shadowsOk) return null;
    const key = this.keyLight();
    const I = key ? key.intensity : 0;
    const n = this.nCasc;
    if (!key || I < 1e-4) {   // no Sun or Moon worth a shadow: keep maps, draw nothing new, light nothing
      for (const c of this.cascades) { c.light.intensity = 0; c.light.shadow.needsUpdate = false; }
      this.shadowU.slShadowN.value = 0;
      return null;
    }
    this._L.subVectors(key.position, key.target.position).normalize();
    if (this._L.y < 0.03) { this._L.y = 0.03; this._L.normalize(); }
    const night = key !== this.app.sun;
    const cam = this.camera, fov = cam.fov || 60, aspect = cam.aspect || 1.6;
    cam.getWorldDirection(this._f);
    for (let i = 0; i < n; i++) {
      const c = this.cascades[i], l = c.light;
      l.color.copy(key.color); l.intensity = I;
      const every = i === 0 ? 1 : (i === n - 1 && n > 1 ? (night ? 3 : 2) : (night ? 2 : 1));
      const due = (this.frame + i) % every === 0 || !l.shadow.map;
      l.shadow.needsUpdate = due;
      if (!due) continue;
      if (i === 0) { const f = this.focus(); this.fit(0, f.c, f.r); }
      else {
        const far = Math.min(cam.far, n === 2 ? 600 : i === 1 ? 400 : 2500);
        const sp = sliceSphere(0, far, fov, aspect);
        this.fit(i, cam.position.clone().addScaledVector(this._f, sp.z), sp.r);
      }
    }
    for (let i = n; i < 3; i++) this.cascades[i].light.intensity = 0;
    for (let i = 0; i < 3; i++) this.shadowU['slShadowMap' + i].value = (i < n && this.cascades[i].light.shadow.map?.texture) || this.dummy;
    this.shadowU.slShadowN.value = this.oceanShadowOk ? n : 0;
    const saved = key.intensity; key.intensity = 0;
    return () => { key.intensity = saved; };
  }

  // ------------------------------------------------------------------ flags (cast / receive) and display-value shaders
  flag(o) {
    if (o.userData.__sl) return;
    o.userData.__sl = 1;
    if (o.userData.noShadow || o.userData.casinoPart) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (o.isMesh && !o.isSprite && mats.length && mats.every(LIT)) {
      o.receiveShadow = true;
      if (!mats.some((m) => m.transparent && m.opacity < 0.6)) o.castShadow = true;
      return;
    }
    if (this.P.bloom > 0 && (o.isMesh || o.isPoints || o.isLine || o.isSprite)) for (const m of mats) this.patchDisplayShader(m);
  }
  patchDisplayShader(m) {
    if (!m || !m.isShaderMaterial || m.userData.__slInv !== undefined || m.userData.slLinear) return;
    m.userData.__slInv = false;
    if (!injectDisplayInverse(m.fragmentShader)) return;
    m.userData.__slInv = true;
    const invU = this.invU, prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey;
    m.onBeforeCompile = function (sh, r) {
      if (prev) prev.call(this, sh, r);
      const f = injectDisplayInverse(sh.fragmentShader);
      if (f) { sh.fragmentShader = f; sh.uniforms.slPostInv = invU.slPostInv; sh.uniforms.slExposure = invU.slExposure; }
    };
    m.customProgramCacheKey = function () { return (prevKey ? prevKey.call(this) : '') + '|slinv'; };
    m.needsUpdate = true;
  }
  /** Hook for builders: flag a freshly built object now (the periodic sweep catches everything else). */
  register(obj) { try { obj?.traverse?.((o) => this.flag(o)); } catch (e) { console.warn('[lighting] register failed', e); } return obj; }
  sweep(now) {
    if (now - this.lastSweep < (this.phone ? 3000 : 2000)) return;
    this.lastSweep = now;
    try { this.scene.traverse((o) => { if (!o.userData.__sl && (o.isMesh || o.isPoints || o.isLine || o.isSprite)) this.flag(o); }); } catch (e) { console.warn('[lighting] sweep failed', e); }
  }

  // ------------------------------------------------------------------ post chain
  async initPost() {
    const r = this.renderer;
    try {
      const base = '/vendor/three/addons/postprocessing/';
      const [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }, { OutputPass }] = await Promise.all([
        import(base + 'EffectComposer.js'), import(base + 'RenderPass.js'), import(base + 'UnrealBloomPass.js'), import(base + 'OutputPass.js')]);
      const gl2 = !!r.capabilities.isWebGL2, ext = r.extensions;
      const half = gl2 ? (ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float')) : (ext.has('OES_texture_half_float') && ext.has('EXT_color_buffer_half_float'));
      const pr = r.getPixelRatio(), size = r.getSize(new THREE.Vector2());
      const samples = gl2 ? (pr > 1.25 ? Math.min(2, this.P.msaa) : this.P.msaa) : 0;
      const rt = new THREE.WebGLRenderTarget(Math.max(1, Math.round(size.x * pr)), Math.max(1, Math.round(size.y * pr)), { type: half ? THREE.HalfFloatType : THREE.UnsignedByteType, samples });
      rt.texture.name = 'saltline.hdr';
      const composer = new EffectComposer(r, rt);
      composer.setPixelRatio(pr); composer.setSize(size.x, size.y);
      const renderPass = new RenderPass(this.scene, this.camera);
      composer.addPass(renderPass);
      const bloom = new UnrealBloomPass(new THREE.Vector2(size.x * pr, size.y * pr), 0.4, 0.4, half ? 1.0 : 0.92);
      const bloomSetSize = bloom.setSize.bind(bloom);
      bloom.setSize = (w, h) => { bloom._full = [w, h]; const k = Math.max(0.2, this.S.bloom || 0.35); bloomSetSize(Math.max(8, Math.round(w * k)), Math.max(8, Math.round(h * k))); };
      composer.addPass(bloom);
      const output = new OutputPass();
      composer.addPass(output);
      let fxaa = null;
      if (!samples) {   // WebGL1 / no MSAA: FXAA on the display-referred output
        const [{ ShaderPass }, { FXAAShader }] = await Promise.all([import(base + 'ShaderPass.js'), import('/vendor/three/addons/shaders/FXAAShader.js')]);
        fxaa = new ShaderPass(FXAAShader); composer.addPass(fxaa);
      }
      this.post = { composer, renderPass, bloom, output, fxaa, gtao: null, half, samples, size: [0, 0, 0] };
      this.composer = composer;
      this.state.post = `bloom ${half ? 'half-float' : '8-bit (no float targets)'}, ${samples ? 'MSAA x' + samples : 'FXAA'}`;
      this.applyPost();
    } catch (e) {
      this.postFailed = true; this.composer = null; this.post = null;
      this.state.post = 'FAILED: ' + (e?.message || e);
      console.error('[lighting] post chain unavailable, rendering direct', e);
    }
  }
  async ensureGtao() {
    if (!this.post || this.post.gtao || this.post.gtaoLoading) return;
    this.post.gtaoLoading = true;
    try {
      const { GTAOPass } = await import('/vendor/three/addons/postprocessing/GTAOPass.js');
      const r = this.renderer, s = r.getDrawingBufferSize(new THREE.Vector2());
      const gt = new GTAOPass(this.scene, this.camera, Math.max(1, s.x >> 1), Math.max(1, s.y >> 1));
      const baseSet = GTAOPass.prototype.setSize;
      gt.setSize = (w, h) => baseSet.call(gt, Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2)));   // half resolution
      // only opaque lit surfaces write the AO G-buffer (sky dome, water, glows, sprites stay out: depth 1 = no AO)
      gt.overrideVisibility = function () {
        const cache = this._visibilityCache;
        this.scene.traverse((o) => {
          cache.set(o, o.visible);
          if (o.isPoints || o.isLine || o.isSprite) o.visible = false;
          else if (o.isMesh) { const m = Array.isArray(o.material) ? o.material[0] : o.material; if (!LIT(m) || m.transparent) o.visible = false; }
        });
      };
      gt.updateGtaoMaterial({ radius: 2.5, distanceExponent: 1, thickness: 2.5, scale: 1, samples: 8, distanceFallOff: 1, screenSpaceRadius: false });
      gt.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 8 });
      gt.blendIntensity = 0.85;
      this.post.composer.insertPass(gt, 1);
      this.post.gtao = gt;
      this.state.ao = 'GTAO half-res';
    } catch (e) { this.state.ao = 'FAILED: ' + (e?.message || e); console.error('[lighting] GTAO unavailable', e); this.P.ao = false; }
    finally { if (this.post) this.post.gtaoLoading = false; }
    this.applyPost();
  }
  applyPost() {
    const p = this.post; if (!p) return;
    if (p.bloom._full) p.bloom.setSize(p.bloom._full[0], p.bloom._full[1]);
    if (this.S.ao && !p.gtao) this.ensureGtao();
    if (p.gtao) { p.gtao.enabled = !!this.S.ao; this.state.ao = p.gtao.enabled ? 'GTAO half-res' : 'off (quality)'; }
    else if (!this.S.ao) this.state.ao = 'off';
  }
  syncSize() {
    const p = this.post; if (!p) return;
    const r = this.renderer, pr = r.getPixelRatio(), s = r.getSize(this._v2 || (this._v2 = new THREE.Vector2()));
    if (p.size[0] === s.x && p.size[1] === s.y && p.size[2] === pr) return;
    p.size = [s.x, s.y, pr];
    p.composer.setPixelRatio(pr); p.composer.setSize(s.x, s.y);
    if (p.fxaa) p.fxaa.material.uniforms.resolution.value.set(1 / Math.max(1, s.x * pr), 1 / Math.max(1, s.y * pr));
  }

  // ------------------------------------------------------------------ quality
  setQuality(q) {
    this.q = THREE.MathUtils.clamp(Number(q) || 0, 0, 1);
    const S = qualityLadder(this.q, this.P), prev = this.S;
    this.S = S;
    if (S.cascades !== prev.cascades) this.applyCascades();
    if (S.bloom !== prev.bloom || S.ao !== prev.ao) this.applyPost();
    return this.q;
  }
  govern(now) {
    const g = this.gov, dt = (now - g.last) / 1000; g.last = now;
    if (dt <= 0 || dt > 1 || (typeof document !== 'undefined' && document.hidden)) { g.since = now; return; }
    g.ema += (dt - g.ema) * 0.05;
    if (this.forced) return;
    const slow = this.phone ? 1 / 27 : 1 / 50, fast = this.phone ? 1 / 40 : 1 / 58;
    if (now - g.since < 5000) return;
    if (g.ema > slow && this.q > 0) { this.setQuality(this.q - 0.15); g.since = now; g.ema = this.phone ? 1 / 32 : 1 / 55; }
    else if (g.ema < fast && this.q < 1 && now - g.since > 25000) { this.setQuality(Math.min(1, this.q + 0.15)); g.since = now; }
  }
  debugSet(x) {
    if (x === null || x === undefined) { this.forced = null; this.setQuality(1); return this.diag(); }
    if (typeof x === 'string' && PRESETS[x]) {
      this.forced = x; this.presetName = x; this.P = { ...PRESETS[x] };
      if (this.P.shadows && !this.shadowsOk && !this.cascades.length) this.initShadows();
      if (!this.P.shadows && this.shadowsOk) { for (const c of this.cascades) { c.light.visible = false; c.light.castShadow = false; } this.shadowsOk = false; this.state.shadows = 'off (level)'; }
      else if (this.P.shadows && !this.shadowsOk && this.cascades.length && CHUNK_STATE === 'patched') { this.shadowsOk = true; }
      this.S = qualityLadder(1, this.P); this.q = 1;
      this.applyCascades();
      if ((this.P.bloom > 0 || this.P.ao) && !this.post && !this.postFailed) this.initPost(); else this.applyPost();
      return this.diag();
    }
    if (Number.isFinite(+x)) { this.forced = this.presetName; this.setQuality(+x); }
    return this.diag();
  }

  // ------------------------------------------------------------------ per frame
  /** Replaces renderer.render(scene, camera) in the game loop. */
  render() {
    const r = this.renderer, now = performance.now();
    this.frame++;
    this.govern(now);
    this.sweep(now);
    let restore = null;
    try { restore = this.updateRig(); } catch (e) { if (!this.rigWarned) { this.rigWarned = true; console.error('[lighting] cascade update failed', e); } }
    const usePost = !!(this.post && this.S.bloom > 0);
    this.postActive = usePost;
    if (this.app.skySys) this.app.skySys.hdrFog = usePost;   // fog colour: linear radiance when OutputPass tone-maps
    this.invU.slPostInv.value = usePost ? 1 : 0; this.invU.slExposure.value = r.toneMappingExposure || 1;
    if (this.shadowsOk) r.shadowMap.needsUpdate = true;
    try {
      if (usePost) {
        this.syncSize();
        const night = this.app.skySys?.state?.night ?? 0;
        this.post.bloom.strength = 0.3 + 0.2 * sstep(0.2, 0.9, night);
        this.post.composer.render();
      } else r.render(this.scene, this.camera);
    } catch (e) {
      if (usePost) { console.error('[lighting] post chain failed, rendering direct from now on', e); this.post = null; this.composer = null; this.postFailed = true; this.state.post = 'FAILED at render: ' + (e?.message || e); r.setRenderTarget(null); r.render(this.scene, this.camera); }
      else throw e;
    } finally { if (restore) restore(); }
  }

  /** Uniforms for a custom (ocean) shader: same objects every call, values kept current by render(). */
  shadowUniforms() { return this.shadowU; }

  diag() {
    return {
      level: this.presetName + (this.forced ? ' (forced)' : ''), quality: Math.round(this.q * 100) / 100,
      now: { cascades: this.shadowsOk ? this.nCasc : 0, bloomScale: this.S.bloom, ao: !!this.S.ao, post: this.postActive },
      shadows: this.state.shadows, chunk: CHUNK_STATE, selfTest: this.state.selfTest, oceanHook: this.state.oceanHook,
      post: this.state.post, ao: this.state.ao, fps: Math.round(1 / this.gov.ema),
      cascadeRadii: this.cascades.slice(0, this.nCasc || 0).map((c) => Math.round(c.r)),
    };
  }
}
