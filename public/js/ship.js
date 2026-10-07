// Procedural ship models (forward = -z, starboard = +x, real-metre scale) with a wear shader (rust streaks, barnacle
// band at the waterline, antifouling below it, roughness rising with neglect), world-space foam wakes (trailing
// ribbon + Kelvin V + bow strips), sails that sheet to the wind, navigation lights, coast-guard cutters, SAR lifeboat
// and helicopter, derelicts, wrecks, offshore platforms and sprite labels. Static parts are merged per material
// (models.js PartBuilder) so a ship is ~10–20 draw calls whatever its size.
import * as THREE from 'three';
import { SHIP_CLASSES } from '/shared/constants.js';
import { PartBuilder, noiseTexture } from './models.js';
import { surfaceHeightAt, oceanState } from './ocean.js';

// ----------------------------------------------------------------------------------------------- wear shader
// shipPos: per-vertex position in the SHIP group's frame, baked at build time (fixed to the plating, y = up, so the
// wear noise does not crawl with heave/motion). uWaterY: the ship group's world y (main.js: userData.setWaterY), so
// vLocalY is the height above the waterline whatever the part's own geometry axes are (the hull is an extrusion).
const WEAR_VERT_PARS = /* glsl */`attribute vec3 shipPos; uniform float uWaterY; varying vec3 vShipPos; varying float vLocalY;`;
const WEAR_VERT = /* glsl */`vShipPos = shipPos; vLocalY = (modelMatrix * vec4(transformed, 1.0)).y - uWaterY;`;
const WEAR_FRAG_PARS = /* glsl */`
uniform float uWear; uniform float uFlood; varying vec3 vShipPos; varying float vLocalY;
float wh(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
float wnoise(vec3 p) { vec3 i = floor(p); vec3 f = fract(p); f = f*f*(3.0-2.0*f);
  float a = mix(mix(wh(i), wh(i+vec3(1,0,0)), f.x), mix(wh(i+vec3(0,1,0)), wh(i+vec3(1,1,0)), f.x), f.y);
  float b = mix(mix(wh(i+vec3(0,0,1)), wh(i+vec3(1,0,1)), f.x), mix(wh(i+vec3(0,1,1)), wh(i+vec3(1,1,1)), f.x), f.y);
  return mix(a, b, f.z); }`;
const WEAR_FRAG = /* glsl */`
{
  vec3 lp = vShipPos;
  float n1 = wnoise(lp * 0.9) * 0.55 + wnoise(lp * 3.1) * 0.45;
  float streak = wnoise(vec3(lp.x * 4.0, lp.y * 0.35, lp.z * 4.0));
  float w = clamp(uWear, 0.0, 1.0);
  // antifouling red below the waterline
  if (vLocalY < 0.0) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.12, 0.08), 0.9);
  // rust: patches grow with wear, streaks run down from edges
  float rust = smoothstep(1.0 - w * 1.15, 1.0 - w * 1.15 + 0.22, n1) * (0.6 + 0.4 * streak);
  rust += smoothstep(1.0 - w * 0.9, 1.0 - w * 0.9 + 0.1, streak) * 0.5 * w;
  rust = clamp(rust, 0.0, 1.0);
  vec3 rustCol = mix(vec3(0.46, 0.21, 0.08), vec3(0.25, 0.1, 0.05), n1);
  diffuseColor.rgb = mix(diffuseColor.rgb, rustCol, rust * 0.95);
  // barnacles and weed around the waterline band
  float band = smoothstep(2.6, 0.2, abs(vLocalY + 0.6)) * w;
  float barn = smoothstep(0.35, 0.75, wnoise(lp * 2.3)) * band;
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2, 0.26, 0.16), barn);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.2, 0.1), band * 0.3);
  // flaking paint darkening
  diffuseColor.rgb *= 1.0 - 0.25 * w * n1;
}`;

export function makeWearMaterial(color, opts = {}) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: opts.roughness ?? 0.55, metalness: opts.metalness ?? 0.25, ...opts.extra });
  m.userData.uniforms = { uWear: { value: 0 }, uFlood: { value: 0 }, uWaterY: { value: 0 } };
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uWear = m.userData.uniforms.uWear; shader.uniforms.uFlood = m.userData.uniforms.uFlood; shader.uniforms.uWaterY = m.userData.uniforms.uWaterY;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\n' + WEAR_VERT_PARS)
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n' + WEAR_VERT);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + WEAR_FRAG_PARS)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + WEAR_FRAG)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = min(1.0, roughnessFactor + 0.45 * uWear);');
  };
  return m;
}

// ----------------------------------------------------------------------------------------------- shared palette
const std = (color, extra = {}) => { const m = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.2, ...extra }); m.userData.shared = true; return m; };
const P = {
  dark: std(0x1b2430, { roughness: 0.5, metalness: 0.3 }), glass: std(0x1d3f5c, { roughness: 0.2, metalness: 0.7 }), steel: std(0x8a9199, { roughness: 0.4, metalness: 0.7 }),
  rubber: std(0x15171a, { roughness: 0.95, metalness: 0 }), orange: std(0xf26b1d), red: std(0xc0392b), white: std(0xf2f2ee, { roughness: 0.7 }), yellow: std(0xf2b134),
  blue: std(0x1b4f9c), wood: std(0x8c6b3a, { roughness: 0.9, metalness: 0 }), teak: std(0xb08a5a, { roughness: 0.85, metalness: 0 }), net: std(0x6b5a3a, { roughness: 1, metalness: 0 }),
  hatch: std(0x5c6168, { roughness: 0.8 }), rust: std(0x4a2f1f, { roughness: 0.95, metalness: 0.1 }), grey: std(0x9ea3a8, { roughness: 0.7 }), lime: std(0xd4e157),
  sail: std(0xf3efe4, { roughness: 0.9, metalness: 0, side: THREE.DoubleSide }), sailCover: std(0x24466b, { roughness: 0.9, metalness: 0 }), tramp: std(0x222a33, { roughness: 1, metalness: 0, side: THREE.DoubleSide }),
  black: std(0x101214, { roughness: 0.6 }), heliBody: std(0xd62828), flame: null,
};
P.flame = new THREE.MeshBasicMaterial({ color: 0xff9a2a, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }); P.flame.userData.shared = true;
const CONTAINER_COLORS = [0xc0392b, 0x2980b9, 0x27ae60, 0xf39c12, 0x8e44ad, 0x7f8c8d, 0xd35400, 0x16a085];
const CONT = CONTAINER_COLORS.map((c) => std(c, { roughness: 0.7 }));
/** offshore platform palette (shared, never disposed) */
const PP = { jacket: std(0xb9a85c, { roughness: 0.7, metalness: 0.3 }), deck: std(0x6f7781, { roughness: 0.8 }), accom: std(0xe8ecef, { roughness: 0.7 }), proc: std(0x8a9199, { roughness: 0.6, metalness: 0.5 }) };

export const CUTTER_CLASS = { cutter: { id: 'cutter', length: 28, beam: 6.5, draft: 2.2, freeboard: 2.4, hullColor: 0xf26b1d, maxKn: 30 } };
/** Non-market hulls buildShip() also knows (cutter kept for compatibility; lifeboat/helicopter via buildRescue). */
export const EXTRA_CLASSES = {
  ...CUTTER_CLASS,
  lifeboat: { id: 'lifeboat', length: 17, beam: 5.5, draft: 1.4, freeboard: 1.8, hullColor: 0xf26b1d, maxKn: 25 },
  helicopter: { id: 'helicopter', length: 16, beam: 3, draft: 0.2, freeboard: 1, hullColor: 0xd62828, maxKn: 150 },
  derelict: { id: 'derelict', length: 70, beam: 12, draft: 4.5, freeboard: 3.5, hullColor: 0x3a3a3a, maxKn: 0 },
};
const SAIL_CLASSES = new Set(['sloop', 'ketch', 'catamaran', 'schooner']);

// ----------------------------------------------------------------------------------------------- hull outlines
/** Shape in XY (y = forward); after rotateX(-90°) shape-y becomes -z (forward). */
function hullShape(L, B, bowFrac = 0.32, sternW = 0.86, sternRound = 0.08) {
  const s = new THREE.Shape();
  const hb = B / 2, hl = L / 2;
  s.moveTo(-hb * sternW, -hl);
  s.lineTo(hb * sternW, -hl);
  s.quadraticCurveTo(hb, -hl + L * sternRound, hb, -hl + L * 0.15);
  s.lineTo(hb, hl - L * bowFrac);
  s.quadraticCurveTo(hb * 0.9, hl - L * bowFrac * 0.35, 0, hl);
  s.quadraticCurveTo(-hb * 0.9, hl - L * bowFrac * 0.35, -hb, hl - L * bowFrac);
  s.lineTo(-hb, -hl + L * 0.15);
  s.quadraticCurveTo(-hb, -hl + L * sternRound, -hb * sternW, -hl);
  return s;
}
/** fine-bowed yacht outline with a narrow transom */
function yachtShape(L, B) {
  const s = new THREE.Shape(); const hb = B / 2, hl = L / 2;
  s.moveTo(-hb * 0.55, -hl); s.lineTo(hb * 0.55, -hl);
  s.quadraticCurveTo(hb * 1.02, -hl + L * 0.3, hb * 0.98, -hl + L * 0.45);
  s.quadraticCurveTo(hb * 0.8, hl - L * 0.25, 0, hl);
  s.quadraticCurveTo(-hb * 0.8, hl - L * 0.25, -hb * 0.98, -hl + L * 0.45);
  s.quadraticCurveTo(-hb * 1.02, -hl + L * 0.3, -hb * 0.55, -hl);
  return s;
}
function extrudeHull(shape, depth, mats, y0, bevel = false) {
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel, bevelThickness: bevel ? 0.6 : 0, bevelSize: bevel ? 0.5 : 0, bevelSegments: 2, curveSegments: 12 });
  const m = new THREE.Mesh(geo, mats);
  m.rotation.x = -Math.PI / 2; m.position.y = y0;
  return m;
}
function detRand(seed) { let s = seed * 9301 + 49297; return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; }; }

// ----------------------------------------------------------------------------------------------- wake system
const WAKE_VERT = /* glsl */`
attribute float aAlpha; varying vec2 vUv; varying float vA;
#include <fog_pars_vertex>
void main() { vUv = uv; vA = aAlpha; vec4 mvPosition = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const WAKE_FRAG = /* glsl */`
uniform sampler2D uMap; uniform vec3 uColor; uniform float uTime; uniform float uIntensity; uniform float uScroll;
varying vec2 vUv; varying float vA;
#include <fog_pars_fragment>
void main() {
  float t1 = texture2D(uMap, vUv * vec2(1.0, 0.6) + vec2(0.0, uTime * 0.012 + uScroll)).a;
  float t2 = texture2D(uMap, vUv * vec2(2.3, 1.7) - vec2(uTime * 0.02, uScroll * 1.7)).a;
  float edge = smoothstep(0.0, 0.3, vUv.x) * smoothstep(1.0, 0.7, vUv.x);
  float a = vA * uIntensity * edge * clamp(t1 * 0.75 + t2 * 0.65, 0.0, 1.0);
  if (a < 0.012) discard;
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;
function wakeMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), uMap: { value: noiseTexture() }, uColor: { value: new THREE.Color(0.9, 0.94, 0.97) }, uTime: { value: 0 }, uIntensity: { value: 1 }, uScroll: { value: 0 } },
    vertexShader: WAKE_VERT, fragmentShader: WAKE_FRAG, transparent: true, depthWrite: false, depthTest: true, fog: true, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
  });
}
/** A strip of `n` cross-sections (2 vertices each) with dynamic position / alpha attributes. */
function makeStrip(n, mat) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(n * 2), 1).setUsage(THREE.DynamicDrawUsage));
  const uv = new Float32Array(n * 2 * 2);
  for (let i = 0; i < n; i++) { uv[i * 4] = 0; uv[i * 4 + 1] = i / 8; uv[i * 4 + 2] = 1; uv[i * 4 + 3] = i / 8; }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  const idx = [];
  for (let i = 0; i < n - 1; i++) { const a = i * 2, b = a + 1, c = a + 2, d = a + 3; idx.push(a, c, b, b, c, d); }
  geo.setIndex(idx); geo.setDrawRange(0, 0);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; m.renderOrder = 2;
  return m;
}
const WAKE_MAXP = 48, WAKE_LIFE = 25, WAKE_LIFT = 0.32, KELVIN_ANG = 19.47 * (Math.PI / 180);

function makeWake(L, B) {
  const group = new THREE.Group(); group.name = 'wake';
  const ribbonMat = wakeMaterial(), vMat = wakeMaterial();
  vMat.uniforms.uColor.value.setRGB(0.85, 0.9, 0.95);
  const ribbon = makeStrip(WAKE_MAXP, ribbonMat);
  const vLeft = makeStrip(8, vMat), vRight = makeStrip(8, vMat);
  group.add(ribbon, vLeft, vRight);
  const pts = []; // oldest first: {x, z, t, px, pz, spd}
  let lastEmit = null, time = 0, lastPos = null, intensity = 1;
  const pos = ribbon.geometry.attributes.position, alp = ribbon.geometry.attributes.aAlpha;
  /** cross-section i centred at (x, y, z), half-width hw along the perpendicular (px, pz), alpha a */
  const writeVertex = (attrP, attrA, i, x, y, z, px, pz, hw, a) => {
    attrP.setXYZ(i * 2, x - px * hw, y, z - pz * hw); attrP.setXYZ(i * 2 + 1, x + px * hw, y, z + pz * hw);
    attrA.setX(i * 2, a); attrA.setX(i * 2 + 1, a);
  };
  function updateArm(mesh, sx, sz, dx, dz, len, spdK, t) {
    const p = mesh.geometry.attributes.position, a = mesh.geometry.attributes.aAlpha, n = 8;
    const px = -dz, pz = dx;
    for (let i = 0; i < n; i++) {
      const s = i / (n - 1), x = sx + dx * len * s, z = sz + dz * len * s;
      const y = surfaceHeightAt(x, z, t) + WAKE_LIFT * 0.7;
      const hw = 0.6 + 2.6 * s * (0.6 + B / 25);
      writeVertex(p, a, i, x, y, z, px, pz, hw, spdK * Math.pow(1 - s, 1.3) * 0.55);
    }
    p.needsUpdate = true; a.needsUpdate = true;
    mesh.geometry.setDrawRange(0, (n - 1) * 6);
  }
  function update(dt, worldPos, hdgRad, spdKn) {
    if (!worldPos || !Number.isFinite(hdgRad)) return;
    dt = Number.isFinite(dt) ? Math.min(0.25, Math.max(0, dt)) : 0.016;
    time = oceanState.time || (time + dt);
    const spd = Number.isFinite(spdKn) ? Math.abs(spdKn) : 0, spdMs = spd * 0.514444;
    const fx = Math.sin(hdgRad), fz = -Math.cos(hdgRad), px = -fz, pz = fx;
    // floating-origin shift (or a teleport): keep the trail attached by moving it along with the ship
    if (lastPos && Math.hypot(worldPos.x - lastPos.x, worldPos.z - lastPos.z) > 2500) {
      const sx = worldPos.x - lastPos.x, sz = worldPos.z - lastPos.z;
      for (const q of pts) { q.x += sx; q.z += sz; }
      if (lastEmit) { lastEmit.x += sx; lastEmit.z += sz; }
    }
    lastPos = { x: worldPos.x, z: worldPos.z };
    const sternX = worldPos.x - fx * L * 0.47, sternZ = worldPos.z - fz * L * 0.47;
    const spdK = THREE.MathUtils.clamp((spd - 0.6) / 7, 0, 1);
    // emit a new section when the stern has moved far enough
    const spacing = Math.max(2.5, Math.min(L * 0.12, 14), spdMs * 0.5);
    if (spd > 0.5 && (!lastEmit || Math.hypot(sternX - lastEmit.x, sternZ - lastEmit.z) >= spacing)) {
      pts.push({ x: sternX, z: sternZ, t: time, px, pz, spd: spdK });
      lastEmit = { x: sternX, z: sternZ };
      while (pts.length > WAKE_MAXP - 1) pts.shift();
    }
    while (pts.length && time - pts[0].t > WAKE_LIFE) pts.shift();
    ribbonMat.uniforms.uTime.value = time; vMat.uniforms.uTime.value = time;
    ribbonMat.uniforms.uIntensity.value = intensity; vMat.uniforms.uIntensity.value = intensity;
    // ribbon: stored sections + the live stern section
    let n = 0;
    for (const q of pts) {
      const age = time - q.t, f = Math.min(1, age / WAKE_LIFE);
      const w = B * (0.9 + 2.1 * Math.sqrt(f));
      const y = surfaceHeightAt(q.x, q.z, time) + WAKE_LIFT;
      writeVertex(pos, alp, n++, q.x, y, q.z, q.px, q.pz, w / 2, q.spd * Math.pow(1 - f, 1.6) * 0.9);
    }
    if (n > 0 || spdK > 0) writeVertex(pos, alp, n++, sternX, surfaceHeightAt(sternX, sternZ, time) + WAKE_LIFT, sternZ, px, pz, B * 0.45, spdK * 0.9);
    pos.needsUpdate = true; alp.needsUpdate = true;
    ribbon.geometry.setDrawRange(0, n >= 2 ? (n - 1) * 6 : 0);
    // Kelvin V from the bow (steady in the ship frame; rebuilt each frame so it rides the waves without pitching)
    const vK = THREE.MathUtils.clamp((spd - 2.5) / 9, 0, 1);
    if (vK > 0) {
      const bx = worldPos.x + fx * L * 0.42, bz = worldPos.z + fz * L * 0.42;
      const len = Math.max(L * 2.2, spdMs * 11);
      const c = Math.cos(KELVIN_ANG), s = Math.sin(KELVIN_ANG);
      // backwards direction (-f) rotated ±KELVIN_ANG
      const b0x = -fx, b0z = -fz;
      updateArm(vLeft, bx, bz, b0x * c - b0z * s, b0x * s + b0z * c, len, vK, time);
      updateArm(vRight, bx, bz, b0x * c + b0z * s, -b0x * s + b0z * c, len, vK, time);
      vLeft.visible = vRight.visible = true;
    } else vLeft.visible = vRight.visible = false;
  }
  return {
    group, update,
    setIntensity(t) { intensity = THREE.MathUtils.clamp(t, 0, 1); },
    reset() { pts.length = 0; lastEmit = null; ribbon.geometry.setDrawRange(0, 0); vLeft.visible = vRight.visible = false; },
    dispose() { group.parent?.remove(group); for (const m of [ribbon, vLeft, vRight]) { m.geometry.dispose(); } ribbonMat.dispose(); vMat.dispose(); },
  };
}
/** Bow-wave foam strips along both sides of the stem, in the SHIP frame (they ride with pitch/roll). */
function makeBowStrips(L, B, bowFrac, yWater = 0.25) {
  const mat = wakeMaterial(); mat.uniforms.uIntensity.value = 0;
  const n = 7, geos = [];
  for (const side of [-1, 1]) {
    const g = new THREE.BufferGeometry();
    const p = new Float32Array(n * 2 * 3), a = new Float32Array(n * 2), uv = new Float32Array(n * 2 * 2);
    // follow the quadratic bow curve from the stem (0, -L/2) to the shoulder (±B/2, -L/2 + L*bowFrac)
    const x0 = 0, z0 = -L / 2, x1 = side * (B / 2), z1 = -L / 2 + L * bowFrac, cx = side * (B / 2) * 0.9, cz = -L / 2 + L * bowFrac * 0.35;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const x = (1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * cx + t * t * x1, z = (1 - t) * (1 - t) * z0 + 2 * (1 - t) * t * cz + t * t * z1;
      // outward normal of the curve: the perpendicular to the tangent that points away from the centreline
      const tx = 2 * (1 - t) * (cx - x0) + 2 * t * (x1 - cx), tz = 2 * (1 - t) * (cz - z0) + 2 * t * (z1 - cz);
      const tl = Math.hypot(tx, tz) || 1;
      let ox = -tz / tl, oz = tx / tl;
      if (ox * side < 0) { ox = -ox; oz = -oz; }
      const w = (0.5 + 1.8 * Math.sin(t * Math.PI)) * (0.5 + B / 20);
      const inX = x - ox * 0.3, inZ = z - oz * 0.3, outX = x + ox * w, outZ = z + oz * w;
      p.set([inX, yWater, inZ, outX, yWater + 0.1, outZ], i * 6);
      const al = Math.sin(t * Math.PI) * 0.9; a[i * 2] = al; a[i * 2 + 1] = al * 0.5;
      uv.set([0, t * 3, 1, t * 3], i * 4);
    }
    g.setAttribute('position', new THREE.BufferAttribute(p, 3)); g.setAttribute('aAlpha', new THREE.BufferAttribute(a, 1)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    const idx = []; for (let i = 0; i < n - 1; i++) { const q = i * 2; idx.push(q, q + 2, q + 1, q + 1, q + 2, q + 3); }
    g.setIndex(idx); geos.push(g);
  }
  const mesh = new THREE.Group();
  for (const g of geos) { const m = new THREE.Mesh(g, mat); m.frustumCulled = false; m.renderOrder = 2; mesh.add(m); }
  mesh.userData.mat = mat;
  return mesh;
}

// ----------------------------------------------------------------------------------------------- part helpers
function makeCtx(g, C, cls, seed) {
  const L = C.length, B = C.beam, draft = C.draft, freeboard = C.freeboard || Math.max(3, L * 0.045);
  const hullMat = makeWearMaterial(C.hullColor);
  const deckMat = makeWearMaterial(cls === 'schooner' || cls === 'ketch' ? 0xb08a5a : 0x6b7076, { roughness: 0.8, metalness: 0.1 });
  const superMat = makeWearMaterial(cls === 'myacht' || cls === 'superyacht' || cls === 'cruiser' ? 0xf7f7f4 : 0xe9ebe6, { roughness: 0.6, metalness: 0.1 });
  const windowMat = new THREE.MeshStandardMaterial({ color: 0x1b3650, roughness: 0.25, metalness: 0.6, emissive: 0xffd890, emissiveIntensity: 0 });
  const navMats = { red: new THREE.MeshStandardMaterial({ color: 0xff2020, emissive: 0xff2020, emissiveIntensity: 0.4 }), green: new THREE.MeshStandardMaterial({ color: 0x20ff40, emissive: 0x20ff40, emissiveIntensity: 0.4 }), white: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.4 }) };
  const pb = new PartBuilder();
  const ctx = {
    g, C, cls, L, B, draft, freeboard, deckY: freeboard + 0.05, rnd: detRand(seed), pb,
    hullMat, deckMat, superMat, windowMat, navMats, mats: [hullMat, deckMat, superMat], sails: [], rotor: null, lightsOff: false,
    box: (w, h, d, mat, x, y, z, rx = 0, ry = 0, rz = 0) => pb.box(w, h, d, mat, x, y, z, rx, ry, rz),
    cyl: (r, h, mat, x, y, z, rt = r, seg = 12, rx = 0, ry = 0, rz = 0) => pb.cyl(r, h, mat, x, y, z, rt, seg, rx, ry, rz),
    rod: (ax, ay, az, bx, by, bz, r, mat = P.dark) => pb.rod(ax, ay, az, bx, by, bz, r, mat),
    win: (w, h, x, y, z, ry = 0) => pb.box(w, h, 0.14, windowMat, x, y, z, 0, ry, 0),
    nav: (which, x, y, z) => { const m = new THREE.Mesh(new THREE.SphereGeometry(0.4, 8, 6), navMats[which]); m.position.set(x, y, z); g.add(m); return m; },
  };
  /** railing along a polyline [[x,z],…] at height y (posts every ~2.6 m + top rail) */
  ctx.rail = (pts, y, h = 1.05) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, z0] = pts[i], [x1, z1] = pts[i + 1], len = Math.hypot(x1 - x0, z1 - z0);
      pb.rod(x0, y + h, z0, x1, y + h, z1, 0.05, P.steel, 4);
      const n = Math.max(1, Math.round(len / 2.6));
      for (let k = 0; k <= n; k++) { const t = k / n; pb.rod(x0 + (x1 - x0) * t, y, z0 + (z1 - z0) * t, x0 + (x1 - x0) * t, y + h, z0 + (z1 - z0) * t, 0.04, P.steel, 4); }
    }
  };
  /** rail around the hull outline at deck level (sampled from the hull shape; bow + sides + stern) */
  ctx.hullRail = (shape, y, inset = 0.35) => {
    const pts = shape.getPoints(10).map((p) => [p.x * (1 - inset / (B / 2)), -p.y * (1 - inset / (L / 2))]);
    ctx.rail(pts.concat([pts[0]]), y);
  };
  ctx.mast = (x, y0, z, h, r = 0.22, yard = true) => { pb.cyl(r, h, P.steel, x, y0 + h / 2, z, r * 0.6, 8); if (yard) pb.box(h * 0.25, 0.16, 0.16, P.steel, x, y0 + h * 0.8, z); };
  ctx.funnel = (x, y, z, r, h, mat = P.dark, rt = r * 0.85) => { pb.cyl(r, h, mat, x, y + h / 2, z, rt, 14); pb.cyl(rt * 1.05, 0.6, P.black, x, y + h, z, rt * 0.75, 14); };
  ctx.lifeboatPod = (x, y, z, len = 6) => { pb.geo(new THREE.CapsuleGeometry(len * 0.17, len * 0.66, 3, 8), P.orange, x, y, z, Math.PI / 2, 0, 0); pb.rod(x, y - len * 0.2, z - len * 0.3, x, y - len * 0.2 - 1.6, z - len * 0.3, 0.12, P.steel); pb.rod(x, y - len * 0.2, z + len * 0.3, x, y - len * 0.2 - 1.6, z + len * 0.3, 0.12, P.steel); };
  /** pedestal deck crane: house + angled boom */
  ctx.crane = (x, y, z, h, boomLen, ry = 0, mat = P.yellow) => {
    pb.cyl(1.0, h, mat, x, y + h / 2, z, 0.9, 10);
    pb.box(3.2, 2.6, 3.6, mat, x, y + h + 1.3, z, 0, ry, 0);
    const bx = x + Math.sin(ry) * 1.2, bz = z - Math.cos(ry) * 1.2;
    const tipX = bx + Math.sin(ry) * boomLen * 0.82, tipZ = bz - Math.cos(ry) * boomLen * 0.82, tipY = y + h + 1.5 + boomLen * 0.55;
    pb.rod(bx, y + h + 1.5, bz, tipX, tipY, tipZ, 0.38, mat, 6);
    pb.rod(tipX, tipY, tipZ, tipX, tipY - boomLen * 0.35, tipZ, 0.05, P.dark, 4);
    pb.box(0.8, 0.6, 0.5, P.dark, tipX, tipY - boomLen * 0.35, tipZ);
  };
  ctx.containerBays = (zStart, zEnd, rows, tiersFn, y0, rowPitch = 2.6, bayLen = 12.2) => {
    const bays = Math.floor((zEnd - zStart) / (bayLen + 0.4));
    for (let b = 0; b < bays; b++) {
      const tiers = tiersFn(b);
      for (let r = 0; r < rows; r++) for (let t = 0; t < tiers; t++) {
        if (ctx.rnd() < 0.08) continue;
        const mat = CONT[Math.floor(ctx.rnd() * CONT.length)];
        pb.box(2.44, 2.59, bayLen, mat, (r - (rows - 1) / 2) * rowPitch, y0 + 1.3 + t * 2.59, zStart + (bayLen + 0.4) * b + bayLen / 2);
      }
    }
    return bays;
  };
  ctx.anchorGear = (y, z) => { pb.box(2.2, 1.2, 1.6, P.dark, 0, y + 0.6, z); pb.cyl(0.5, 2.6, P.dark, 0, y + 0.6, z, 0.5, 10, 0, 0, Math.PI / 2); pb.box(0.8, 0.8, 0.8, P.dark, -B * 0.32, y + 0.4, z - 1); pb.box(0.8, 0.8, 0.8, P.dark, B * 0.32, y + 0.4, z - 1); };
  ctx.bollards = (y, zs) => { for (const z of zs) { pb.cyl(0.28, 0.9, P.dark, -B * 0.42, y + 0.45, z, 0.32, 8); pb.cyl(0.28, 0.9, P.dark, B * 0.42, y + 0.45, z, 0.32, 8); } };
  return ctx;
}

/** Standard merchant hull: full-outline upper hull + narrower lower hull (bilge step), bulbous bow on big ships. */
function merchantHull(ctx, bowFrac = 0.3, sternW = 0.86) {
  const { g, L, B, draft, freeboard, hullMat, deckMat, pb } = ctx;
  const stepY = -draft * 0.4;
  const hull = extrudeHull(hullShape(L, B, bowFrac, sternW), freeboard - stepY, [deckMat, hullMat], stepY);
  g.add(hull);
  const lower = new THREE.ExtrudeGeometry(hullShape(L * 0.97, B * 0.78, bowFrac + 0.1, sternW * 0.8), { depth: draft + stepY + 0.05, bevelEnabled: false, curveSegments: 8 });
  lower.rotateX(-Math.PI / 2); lower.translate(0, -draft, 0);
  pb.geo(lower, hullMat);
  if (L >= 80) pb.geo(new THREE.CapsuleGeometry(B * 0.09, L * 0.03, 3, 8), hullMat, 0, -draft * 0.7, -L / 2 + L * 0.005, Math.PI / 2, 0, 0);
  // bulwark lip around the deck
  const lip = new THREE.ExtrudeGeometry(hullShape(L * 1.005, B * 1.03, bowFrac, sternW), { depth: 1.1, bevelEnabled: false, curveSegments: 10 });
  lip.rotateX(-Math.PI / 2); lip.translate(0, freeboard, 0);
  pb.geo(lip, hullMat);
  // rudder + propeller hint
  pb.box(0.4, draft * 0.8, draft * 0.6, hullMat, 0, -draft * 0.55, L / 2 - draft * 0.2);
  pb.geo(new THREE.TorusGeometry(Math.min(B * 0.12, draft * 0.3), 0.18, 5, 10), P.steel, 0, -draft * 0.65, L / 2 - draft * 0.55, 0, 0, 0);
  ctx.bowFrac = bowFrac;
  return hull;
}
function yachtHull(ctx, sheer = 0.6) {
  const { g, L, B, draft, freeboard, hullMat, deckMat, pb } = ctx;
  const hull = extrudeHull(yachtShape(L, B), freeboard + draft * 0.35, [deckMat, hullMat], -draft * 0.35, false);
  g.add(hull);
  // fin keel + bulb for sailing yachts, skeg for motor
  if (SAIL_CLASSES.has(ctx.cls)) { pb.box(0.25, draft * 0.7, L * 0.16, hullMat, 0, -draft * 0.62, L * 0.02); pb.geo(new THREE.CapsuleGeometry(0.22, L * 0.12, 3, 8), P.dark, 0, -draft * 0.95, L * 0.02, Math.PI / 2, 0, 0); }
  else pb.box(0.2, draft * 0.5, L * 0.3, hullMat, 0, -draft * 0.55, L * 0.1);
  pb.box(0.12, draft * 0.6, draft * 0.4, hullMat, 0, -draft * 0.5, L / 2 - L * 0.08);
  // toe rail
  const lip = new THREE.ExtrudeGeometry(yachtShape(L * 1.003, B * 1.02), { depth: 0.18, bevelEnabled: false, curveSegments: 10 });
  lip.rotateX(-Math.PI / 2); lip.translate(0, freeboard, 0);
  pb.geo(lip, ctx.cls === 'schooner' ? P.teak : hullMat);
  ctx.bowFrac = 0.42; void sheer;
  return hull;
}

// ----------------------------------------------------------------------------------------------- class builders
function superstructureBlock(ctx, x, z, w, d, decks, deckH = 2.9, withBridge = true, mat = ctx.superMat) {
  const { pb, deckY, box, win } = ctx;
  const h = decks * deckH;
  box(w, h, d, mat, x, deckY + h / 2, z);
  for (let k = 0; k < decks; k++) { // window strips per deck, front / sides
    const y = deckY + k * deckH + deckH * 0.62;
    if (k < decks - 1 || !withBridge) { win(w * 0.8, 0.7, x, y, z - d / 2 - 0.02); win(d * 0.8, 0.6, x - w / 2 - 0.02, y, z, Math.PI / 2); win(d * 0.8, 0.6, x + w / 2 + 0.02, y, z, Math.PI / 2); }
  }
  if (withBridge) { // bridge deck with wings and a full-width window band
    const by = deckY + h;
    box(w * 1.25, 2.9, d * 0.72, mat, x, by + 1.45, z - d * 0.1);
    win(w * 1.25 * 0.96, 1.2, x, by + 1.75, z - d * 0.1 - d * 0.36 - 0.02);
    win(d * 0.72 * 0.9, 1.0, x - w * 0.625 - 0.02, by + 1.75, z - d * 0.1, Math.PI / 2); win(d * 0.72 * 0.9, 1.0, x + w * 0.625 + 0.02, by + 1.75, z - d * 0.1, Math.PI / 2);
    pb.box(w * 1.25, 0.25, d * 0.75, mat, x, by + 3.0, z - d * 0.1);
    ctx.rail([[x - w * 0.625, z - d * 0.46], [x - w * 0.625, z + d * 0.26]], by + 3.1, 1.0); ctx.rail([[x + w * 0.625, z - d * 0.46], [x + w * 0.625, z + d * 0.26]], by + 3.1, 1.0);
    // radar scanner + mast on top
    pb.box(2.2, 0.25, 0.4, P.white, x, by + 4.2, z - d * 0.1); pb.cyl(0.12, 1.0, P.steel, x, by + 3.6, z - d * 0.1, 0.12, 6);
    return by + 3.0;
  }
  return deckY + h;
}

const BUILDERS = {
  coaster(ctx) {
    const { L, B, deckY, box, cyl, mast, funnel, lifeboatPod } = ctx;
    merchantHull(ctx, 0.3);
    const sd = L * 0.15, sz = L / 2 - L * 0.13, sw = B * 0.74;
    const top = superstructureBlock(ctx, 0, sz, sw, sd, 3);
    funnel(0, top, sz + sd * 0.25, 1.3, 5.5, P.dark);
    mast(0, top, sz - sd * 0.3, 10);
    lifeboatPod(-sw / 2 - 1.3, deckY + 6.5, sz + 1, 5.5); lifeboatPod(sw / 2 + 1.3, deckY + 6.5, sz + 1, 5.5);
    // three hatches with coamings
    const holdStart = -L / 2 + L * 0.13, holdEnd = sz - sd / 2 - 3, hl = (holdEnd - holdStart) / 3;
    for (let i = 0; i < 3; i++) { box(B * 0.62, 1.4, hl * 0.8, P.hatch, 0, deckY + 0.7, holdStart + hl * (i + 0.5)); box(B * 0.6, 0.3, hl * 0.78, P.grey, 0, deckY + 1.55, holdStart + hl * (i + 0.5)); }
    // deck containers + crane
    for (let i = 0; i < 4; i++) { if (ctx.rnd() < 0.4) continue; box(2.44, 2.59, 6.1, CONT[Math.floor(ctx.rnd() * CONT.length)], (i % 2 ? 1 : -1) * B * 0.2, deckY + 3.0, holdStart + 6 + Math.floor(i / 2) * hl); }
    ctx.crane(B * 0.3, deckY, holdStart + hl, 7, 14, 0.3, P.yellow);
    mast(0, deckY, -L / 2 + 5, 8, 0.18);
    ctx.anchorGear(deckY, -L / 2 + 3);
    ctx.bollards(deckY, [-L / 2 + 7, 0, L / 2 - 6]);
    ctx.hullRail(hullShape(L, B, 0.3), deckY + 1.1);
    cyl(0.1, 1, P.steel, 0, deckY + 0.5, L / 2 - 1.5, 0.1, 6);
    ctx.lights = { x: sw * 0.62 + 0.3, y: top + 1.5, z: sz, mastY: top + 10, mastZ: sz - sd * 0.3, fore: { y: deckY + 8, z: -L / 2 + 5 }, stern: { y: deckY + 2, z: L / 2 - 1 } };
    return top + 9;
  },
  feeder(ctx) {
    const { L, B, deckY, box, mast, funnel, lifeboatPod } = ctx;
    merchantHull(ctx, 0.28);
    const sd = L * 0.1, sz = L / 2 - L * 0.1, sw = B * 0.72;
    const top = superstructureBlock(ctx, 0, sz, sw, sd, 5);
    funnel(0, top - 2.9, sz + sd * 0.32, 1.6, 6.5, P.dark);
    mast(0, top, sz - sd * 0.3, 10);
    lifeboatPod(-sw / 2 - 1.6, deckY + 9, sz + 1, 6.5); lifeboatPod(sw / 2 + 1.6, deckY + 9, sz + 1, 6.5);
    const rows = Math.max(3, Math.floor(B / 2.6) - 2);
    const zEnd = sz - sd / 2 - 3, zStart = -L / 2 + L * 0.12;
    const bays = ctx.containerBays(zStart, zEnd, rows, (b) => (b === 0 ? 2 : 2 + Math.floor(ctx.rnd() * 2)), deckY + 0.5);
    for (let b = 1; b < bays; b += 2) box(B * 0.78, 6, 0.5, P.steel, 0, deckY + 3.3, zStart + (12.6) * b - 0.2); // lashing bridges
    // bow thruster mark
    ctx.pb.geo(new THREE.TorusGeometry(1.6, 0.18, 5, 14), P.white, -B / 2 - 0.02, -ctx.draft * 0.3, -L / 2 + L * 0.1, 0, Math.PI / 2, 0);
    ctx.pb.geo(new THREE.TorusGeometry(1.6, 0.18, 5, 14), P.white, B / 2 + 0.02, -ctx.draft * 0.3, -L / 2 + L * 0.1, 0, Math.PI / 2, 0);
    mast(0, deckY, -L / 2 + 6, 9, 0.2);
    ctx.anchorGear(deckY, -L / 2 + 4);
    ctx.bollards(deckY, [-L / 2 + 9, L / 2 - 8]);
    ctx.lights = { x: sw * 0.62 + 0.3, y: top + 1.5, z: sz, mastY: top + 10, mastZ: sz - sd * 0.3, fore: { y: deckY + 9, z: -L / 2 + 6 }, stern: { y: deckY + 2, z: L / 2 - 1 } };
    return top + 9;
  },
  bulker(ctx) {
    const { L, B, deckY, box, mast, funnel, lifeboatPod } = ctx;
    merchantHull(ctx, 0.26, 0.9);
    const sd = L * 0.085, sz = L / 2 - L * 0.085, sw = B * 0.62;
    const top = superstructureBlock(ctx, 0, sz, sw, sd, 5);
    funnel(0, top - 2.9, sz + sd * 0.3, 2.0, 8, P.red, 1.6);
    mast(0, top, sz - sd * 0.3, 12);
    lifeboatPod(-sw / 2 - 1.8, deckY + 10, sz + 1, 7); lifeboatPod(sw / 2 + 1.8, deckY + 10, sz + 1, 7);
    // forecastle
    box(B * 0.9, 2.4, L * 0.07, ctx.hullMat, 0, deckY + 1.2, -L / 2 + L * 0.04);
    // 5 hatches with raised coamings, 4 cranes between them (offset to one side)
    const zStart = -L / 2 + L * 0.1, zEnd = sz - sd / 2 - 4, hl = (zEnd - zStart) / 5;
    for (let i = 0; i < 5; i++) {
      const zc = zStart + hl * (i + 0.5);
      box(B * 0.55, 1.8, hl * 0.72, P.hatch, 0, deckY + 0.9, zc); box(B * 0.53, 0.5, hl * 0.7, P.grey, 0, deckY + 2.0, zc);
      if (i < 4) ctx.crane(B * 0.33, deckY, zStart + hl * (i + 1), 10, 22, -0.6, P.yellow);
    }
    mast(0, deckY + 2.4, -L / 2 + 6, 12, 0.22);
    ctx.anchorGear(deckY + 2.4, -L / 2 + 4);
    ctx.bollards(deckY, [-L / 2 + 12, -L / 4, L / 4, L / 2 - 8]);
    ctx.hullRail(hullShape(L, B, 0.26, 0.9), deckY + 1.1);
    ctx.lights = { x: sw * 0.62 + 0.3, y: top + 1.5, z: sz, mastY: top + 12, mastZ: sz - sd * 0.3, fore: { y: deckY + 14, z: -L / 2 + 6 }, stern: { y: deckY + 2, z: L / 2 - 1 } };
    return top + 11;
  },
  tanker(ctx) {
    const { L, B, deckY, box, cyl, rod, mast, funnel, lifeboatPod } = ctx;
    merchantHull(ctx, 0.24, 0.92);
    const sd = L * 0.085, sz = L / 2 - L * 0.085, sw = B * 0.6;
    const top = superstructureBlock(ctx, 0, sz, sw, sd, 5);
    funnel(0, top - 2.9, sz + sd * 0.3, 2.0, 8, P.dark, 1.5);
    mast(0, top, sz - sd * 0.3, 12);
    lifeboatPod(0, deckY + 9, L / 2 - 1, 7); // free-fall lifeboat over the stern
    rod(0, deckY + 9, L / 2 - 4, 0, deckY + 7, L / 2 + 1, 0.25, P.steel);
    // forecastle, central catwalk on posts, three deck pipes, manifold amidships with its hose crane
    box(B * 0.9, 2.2, L * 0.07, ctx.hullMat, 0, deckY + 1.1, -L / 2 + L * 0.04);
    const z0 = -L / 2 + L * 0.09, z1 = sz - sd / 2 - 1;
    box(2.4, 0.2, z1 - z0, P.grey, 0, deckY + 3.2, (z0 + z1) / 2);
    for (let z = z0 + 4; z < z1; z += 10) { rod(-1.1, deckY, z, -1.1, deckY + 3.2, z, 0.12, P.steel); rod(1.1, deckY, z, 1.1, deckY + 3.2, z, 0.12, P.steel); }
    ctx.rail([[-1.2, z0], [-1.2, z1]], deckY + 3.3, 1.0); ctx.rail([[1.2, z0], [1.2, z1]], deckY + 3.3, 1.0);
    for (const px of [-B * 0.22, -B * 0.14, B * 0.14, B * 0.22]) rod(px, deckY + 0.9, z0, px, deckY + 0.9, z1, 0.32, P.grey);
    for (let z = z0 + 8; z < z1; z += 18) for (const px of [-B * 0.3, B * 0.3]) { cyl(0.5, 1.6, P.grey, px, deckY + 0.8, z, 0.5, 10); } // valve stands
    const mz = (z0 + z1) / 2;
    for (const side of [-1, 1]) { box(B * 0.12, 1.6, 6, P.grey, side * B * 0.34, deckY + 0.8, mz); for (let k = 0; k < 4; k++) rod(side * B * 0.3, deckY + 0.9, mz - 2.2 + k * 1.5, side * B * 0.46, deckY + 0.9, mz - 2.2 + k * 1.5, 0.3, P.grey); }
    ctx.crane(-B * 0.3, deckY, mz + 8, 6, 12, 2.4, P.grey); ctx.crane(B * 0.3, deckY, mz + 8, 6, 12, -2.4, P.grey);
    mast(0, deckY + 2.2, -L / 2 + 6, 12, 0.22);
    ctx.anchorGear(deckY + 2.2, -L / 2 + 4);
    ctx.bollards(deckY, [-L / 2 + 12, -L / 4, L / 4, L / 2 - 8]);
    ctx.hullRail(hullShape(L, B, 0.24, 0.92), deckY + 1.1);
    ctx.lights = { x: sw * 0.62 + 0.3, y: top + 1.5, z: sz, mastY: top + 12, mastZ: sz - sd * 0.3, fore: { y: deckY + 14, z: -L / 2 + 6 }, stern: { y: deckY + 2, z: L / 2 - 1 } };
    return top + 11;
  },
  boxship(ctx) {
    const { L, B, deckY, box, mast, funnel, lifeboatPod } = ctx;
    merchantHull(ctx, 0.22, 0.95);
    // forward bridge tower (modern layout) + aft engine casing with the funnel
    const bz = -L * 0.16, bd = L * 0.055, bw = B * 0.55;
    const top = superstructureBlock(ctx, 0, bz, bw, bd, 8, 2.9, true);
    mast(0, top, bz - bd * 0.3, 14, 0.3);
    lifeboatPod(-bw / 2 - 2.2, deckY + 14, bz + 2, 8); lifeboatPod(bw / 2 + 2.2, deckY + 14, bz + 2, 8);
    const cz = L * 0.33, cd = L * 0.05, cw = B * 0.4;
    box(cw, 14, cd, ctx.superMat, 0, deckY + 7, cz);
    funnel(0, deckY + 14, cz, 3.2, 10, P.dark, 2.6);
    // bays: bow to bridge, bridge to casing, aft of casing
    const rows = Math.max(6, Math.floor(B / 2.6) - 2);
    const tiersFn = (b) => 4 + Math.floor(ctx.rnd() * 4);
    const zA0 = -L / 2 + L * 0.1, zA1 = bz - bd / 2 - 2, zB0 = bz + bd / 2 + 2, zB1 = cz - cd / 2 - 2, zC0 = cz + cd / 2 + 2, zC1 = L / 2 - L * 0.06;
    const b1 = ctx.containerBays(zA0, zA1, rows, (b) => (b < 2 ? 2 + b : tiersFn(b)), deckY + 0.5);
    const b2 = ctx.containerBays(zB0, zB1, rows, tiersFn, deckY + 0.5);
    const b3 = ctx.containerBays(zC0, zC1, rows, (b) => 3 + Math.floor(ctx.rnd() * 3), deckY + 0.5);
    for (const [z0, n] of [[zA0, b1], [zB0, b2], [zC0, b3]]) for (let b = 1; b < n; b += 2) box(B * 0.82, 8, 0.6, P.steel, 0, deckY + 4.3, z0 + 12.6 * b - 0.2);
    // bow thruster marks, forecastle, masts
    for (const side of [-1, 1]) ctx.pb.geo(new THREE.TorusGeometry(2.2, 0.25, 5, 16), P.white, side * (B / 2 + 0.02), -ctx.draft * 0.3, -L / 2 + L * 0.08, 0, Math.PI / 2, 0);
    box(B * 0.9, 2.6, L * 0.06, ctx.hullMat, 0, deckY + 1.3, -L / 2 + L * 0.035);
    mast(0, deckY + 2.6, -L / 2 + 8, 12, 0.25);
    ctx.anchorGear(deckY + 2.6, -L / 2 + 5);
    ctx.bollards(deckY, [-L / 2 + 16, -L / 4, 0, L / 4, L / 2 - 10]);
    ctx.lights = { x: bw * 0.62 + 0.3, y: top + 1.5, z: bz, mastY: top + 14, mastZ: bz - bd * 0.3, fore: { y: deckY + 14, z: -L / 2 + 8 }, stern: { y: deckY + 2, z: L / 2 - 1 } };
    return top + 14;
  },
  trawler(ctx) {
    const { L, B, deckY, box, cyl, rod, mast, win } = ctx;
    merchantHull(ctx, 0.4, 0.8);
    const sz = -L / 2 + L * 0.3, sw = B * 0.7, sd = L * 0.22;
    box(sw, 3.0, sd, ctx.superMat, 0, deckY + 1.5, sz);
    box(sw * 0.8, 2.6, sd * 0.55, ctx.superMat, 0, deckY + 4.3, sz - sd * 0.12);
    win(sw * 0.78, 1.0, 0, deckY + 4.6, sz - sd * 0.12 - sd * 0.275 - 0.02); win(sd * 0.5, 0.8, -sw * 0.4 - 0.02, deckY + 4.6, sz - sd * 0.12, Math.PI / 2); win(sd * 0.5, 0.8, sw * 0.4 + 0.02, deckY + 4.6, sz - sd * 0.12, Math.PI / 2);
    win(sw * 0.6, 0.6, 0, deckY + 1.9, sz - sd / 2 - 0.02);
    mast(0, deckY + 5.6, sz, 9, 0.2); box(1.2, 0.3, 1.2, P.white, 0, deckY + 11.5, sz);
    ctx.funnel(sw * 0.3, deckY + 5.6, sz + sd * 0.3, 0.7, 3, P.dark);
    // stern gantry (A-frame), net drum, trawl doors, stern ramp
    const gz = L / 2 - 5;
    rod(-B * 0.38, deckY, gz, -B * 0.3, deckY + 8, gz + 1.5, 0.3, P.dark); rod(B * 0.38, deckY, gz, B * 0.3, deckY + 8, gz + 1.5, 0.3, P.dark);
    rod(-B * 0.3, deckY + 8, gz + 1.5, B * 0.3, deckY + 8, gz + 1.5, 0.3, P.dark);
    rod(-B * 0.38, deckY, gz - 3, -B * 0.3, deckY + 8, gz + 1.5, 0.2, P.dark); rod(B * 0.38, deckY, gz - 3, B * 0.3, deckY + 8, gz + 1.5, 0.2, P.dark);
    for (const side of [-1, 1]) box(1.8, 2.6, 0.3, P.rust, side * B * 0.25, deckY + 5.5, gz + 1.6, 0, 0, 0.15 * side);
    cyl(1.3, B * 0.5, P.dark, 0, deckY + 1.5, gz - 8, 1.3, 12, 0, 0, Math.PI / 2); // net drum
    box(B * 0.5, 2.4, 5, P.net, 0, deckY + 1.5, gz - 8);
    box(B * 0.35, 0.3, 6, P.hatch, 0, deckY + 0.15, L / 2 - 3);
    ctx.hullRail(hullShape(L, B, 0.4, 0.8), deckY + 1.1);
    box(B * 0.5, 1.2, L * 0.12, P.hatch, 0, deckY + 0.6, 0);
    ctx.anchorGear(deckY, -L / 2 + 2.5);
    ctx.lights = { x: sw * 0.4 + 0.3, y: deckY + 5, z: sz - 1, mastY: deckY + 14.5, mastZ: sz, fore: null, stern: { y: deckY + 1.5, z: L / 2 - 1 } };
    return deckY + 16;
  },
  tug(ctx) {
    const { L, B, deckY, box, cyl, rod, mast, win, pb } = ctx;
    merchantHull(ctx, 0.42, 0.85);
    const sz = -L / 2 + L * 0.36, sw = B * 0.62, sd = L * 0.3;
    box(sw, 2.8, sd, ctx.superMat, 0, deckY + 1.4, sz);
    box(sw * 0.72, 2.8, sd * 0.5, ctx.superMat, 0, deckY + 4.2, sz);
    box(sw * 0.62, 2.6, sd * 0.42, ctx.superMat, 0, deckY + 6.9, sz);
    win(sw * 0.6, 1.3, 0, deckY + 7.3, sz - sd * 0.21 - 0.02); win(sw * 0.6, 1.0, 0, deckY + 7.3, sz + sd * 0.21 + 0.02);
    win(sd * 0.4, 1.0, -sw * 0.31 - 0.02, deckY + 7.3, sz, Math.PI / 2); win(sd * 0.4, 1.0, sw * 0.31 + 0.02, deckY + 7.3, sz, Math.PI / 2);
    win(sw * 0.6, 0.6, 0, deckY + 4.6, sz - sd * 0.25 - 0.02);
    mast(0, deckY + 8.2, sz - 0.5, 6, 0.18);
    ctx.funnel(-sw * 0.34, deckY + 2.8, sz + sd * 0.32, 0.7, 3.5, P.dark); ctx.funnel(sw * 0.34, deckY + 2.8, sz + sd * 0.32, 0.7, 3.5, P.dark);
    // winch drum + towing bitt aft, bow fender block, tyre fenders along the sides
    cyl(1.0, 2.8, P.dark, 0, deckY + 1.2, L / 2 - L * 0.28, 1.0, 12, 0, 0, Math.PI / 2);
    box(3.6, 1.0, 1.4, P.dark, 0, deckY + 0.5, L / 2 - L * 0.28);
    cyl(0.5, 1.6, P.dark, 0, deckY + 0.8, L / 2 - L * 0.16, 0.5, 10);
    box(B * 0.8, 1.8, 1.6, P.rubber, 0, ctx.freeboard - 0.2, -L / 2 + 0.2);
    for (let i = 0; i < 6; i++) for (const side of [-1, 1]) pb.geo(new THREE.TorusGeometry(0.75, 0.28, 6, 12), P.rubber, side * (B / 2 + 0.15), ctx.freeboard - 1.0, -L / 2 + L * 0.18 + i * L * 0.12, 0, Math.PI / 2, 0);
    ctx.hullRail(hullShape(L, B, 0.42, 0.85), deckY + 1.1);
    rod(0, deckY + 1, L / 2 - L * 0.3, 0, deckY + 1, L / 2 - 0.5, 0.08, P.wood); // towline hint
    ctx.lights = { x: sw * 0.31 + 0.3, y: deckY + 7.8, z: sz, mastY: deckY + 13.5, mastZ: sz - 0.5, fore: null, stern: { y: deckY + 1.8, z: L / 2 - 1 } };
    return deckY + 15;
  },
  psv(ctx) {
    const { L, B, deckY, box, cyl, rod, mast, win } = ctx;
    merchantHull(ctx, 0.3, 0.95);
    // forward 4-deck superstructure with a wrap-around bridge
    const sz = -L / 2 + L * 0.19, sw = B * 0.92, sd = L * 0.22;
    box(sw, 3.0, sd, ctx.superMat, 0, deckY + 1.5, sz);
    box(sw * 0.94, 3.0, sd * 0.8, ctx.superMat, 0, deckY + 4.5, sz);
    box(sw * 0.9, 3.0, sd * 0.65, ctx.superMat, 0, deckY + 7.5, sz);
    box(sw * 0.86, 3.0, sd * 0.5, ctx.superMat, 0, deckY + 10.5, sz);
    for (let k = 0; k < 3; k++) { win(sw * 0.7, 0.7, 0, deckY + 1.9 + k * 3, sz - sd * (0.5 - k * 0.075) - 0.02); }
    win(sw * 0.84, 1.4, 0, deckY + 11.0, sz - sd * 0.25 - 0.02); win(sw * 0.84, 1.1, 0, deckY + 11.0, sz + sd * 0.25 + 0.02);
    win(sd * 0.46, 1.1, -sw * 0.43 - 0.02, deckY + 11.0, sz, Math.PI / 2); win(sd * 0.46, 1.1, sw * 0.43 + 0.02, deckY + 11.0, sz, Math.PI / 2);
    box(sw * 0.9, 0.3, sd * 0.55, ctx.superMat, 0, deckY + 12.1, sz);
    mast(0, deckY + 12.2, sz - 2, 9, 0.22); ctx.funnel(-sw * 0.3, deckY + 9, sz + sd * 0.3, 0.8, 4, P.dark); ctx.funnel(sw * 0.3, deckY + 9, sz + sd * 0.3, 0.8, 4, P.dark);
    // long low cargo deck with side cargo rails, pipes and deck cargo
    const z0 = sz + sd / 2 + 1, z1 = L / 2 - 2;
    for (const side of [-1, 1]) { box(0.3, 1.6, z1 - z0, P.steel, side * B * 0.44, deckY + 0.8, (z0 + z1) / 2); for (const dz of [0.12, 0.2]) rod(side * B * 0.41, deckY + 0.4, z0, side * B * 0.41, deckY + 0.4, z1, dz, P.grey); }
    for (let i = 0; i < 5; i++) { const z = z0 + 6 + i * ((z1 - z0 - 12) / 4); if (ctx.rnd() < 0.5) box(2.44, 2.59, 6.1, CONT[Math.floor(ctx.rnd() * CONT.length)], (i % 2 ? 1 : -1) * B * 0.18, deckY + 1.3, z); else cyl(1.2, 5, P.white, (i % 2 ? 1 : -1) * B * 0.18, deckY + 1.2, z, 1.2, 12, 0, 0, Math.PI / 2); }
    ctx.crane(sw * 0.36, deckY + 3, sz + sd / 2 - 1.5, 5, 12, Math.PI, P.grey);
    ctx.anchorGear(deckY, -L / 2 + 3);
    ctx.lights = { x: sw * 0.43 + 0.3, y: deckY + 11.5, z: sz, mastY: deckY + 21, mastZ: sz - 2, fore: null, stern: { y: deckY + 2, z: L / 2 - 1 } };
    return deckY + 23;
  },
  pilot(ctx) {
    const { L, B, deckY, box, mast, win, rod } = ctx;
    merchantHull(ctx, 0.42, 0.8);
    const sz = -L / 2 + L * 0.45, sw = B * 0.7, sd = L * 0.3;
    box(sw, 2.2, sd, ctx.superMat, 0, deckY + 1.1, sz);
    win(sw * 0.86, 0.9, 0, deckY + 1.5, sz - sd / 2 - 0.02); win(sd * 0.8, 0.8, -sw / 2 - 0.02, deckY + 1.5, sz, Math.PI / 2); win(sd * 0.8, 0.8, sw / 2 + 0.02, deckY + 1.5, sz, Math.PI / 2);
    box(sw * 1.05, 0.2, sd * 1.05, P.white, 0, deckY + 2.3, sz);
    mast(0, deckY + 2.4, sz - 0.5, 3.5, 0.1); rod(-0.9, deckY + 2.4, sz + 1, 0.9, deckY + 2.4, sz + 1, 0.06, P.steel);
    box(0.8, 0.25, 0.3, P.white, 0, deckY + 4.6, sz - 0.5); // radar
    box(B * 0.55, 0.9, 0.8, P.rubber, 0, ctx.freeboard - 0.3, -L / 2 + 0.3);
    ctx.hullRail(hullShape(L, B, 0.42, 0.8), deckY + 0.3, 0.9);
    box(sw * 0.9, 0.6, L * 0.2, ctx.deckMat, 0, deckY + 0.3, L / 2 - L * 0.2);
    ctx.lights = { x: sw / 2 + 0.3, y: deckY + 2.6, z: sz, mastY: deckY + 6, mastZ: sz - 0.5, fore: null, stern: { y: deckY + 1, z: L / 2 - 0.8 } };
    return deckY + 8;
  },
  ferry(ctx) {
    const { L, B, deckY, box, mast, funnel, win, lifeboatPod } = ctx;
    merchantHull(ctx, 0.26, 0.98);
    const sw = B * 0.92, sd = L * 0.8, sz = L * 0.02;
    // car deck (hull extension) + three passenger decks with continuous window bands, a bow visor and a top bridge
    box(sw, 4.2, sd * 1.05, ctx.hullMat, 0, deckY + 2.1, sz);
    for (let d = 0; d < 3; d++) {
      const w = sw * (1 - d * 0.04), dd = sd * (1 - d * 0.1), y = deckY + 4.2 + d * 3.3;
      box(w, 3.3, dd, ctx.superMat, 0, y + 1.65, sz + d * 3);
      win(dd * 0.9, 1.1, -w / 2 - 0.02, y + 2.0, sz + d * 3, Math.PI / 2); win(dd * 0.9, 1.1, w / 2 + 0.02, y + 2.0, sz + d * 3, Math.PI / 2);
      ctx.rail([[-w / 2, sz + d * 3 - dd / 2], [-w / 2, sz + d * 3 + dd / 2]], y + 3.3, 1.0); ctx.rail([[w / 2, sz + d * 3 - dd / 2], [w / 2, sz + d * 3 + dd / 2]], y + 3.3, 1.0);
    }
    const bz = -L / 2 + L * 0.22, by = deckY + 4.2 + 9.9;
    box(sw * 0.88, 3.0, L * 0.12, ctx.superMat, 0, by + 1.5, bz);
    win(sw * 0.86, 1.3, 0, by + 1.8, bz - L * 0.06 - 0.02); win(L * 0.11, 1.1, -sw * 0.44 - 0.02, by + 1.8, bz, Math.PI / 2); win(L * 0.11, 1.1, sw * 0.44 + 0.02, by + 1.8, bz, Math.PI / 2);
    box(sw * 1.1, 0.3, L * 0.12, ctx.superMat, 0, by + 3.1, bz);
    funnel(0, by, L / 2 - L * 0.3, 2.6, 8, P.red, 2.0);
    mast(0, by + 3.2, bz, 10, 0.25);
    box(2.2, 0.25, 0.4, P.white, 0, by + 4.4, bz);
    for (let i = 0; i < 3; i++) for (const side of [-1, 1]) lifeboatPod(side * (sw / 2 + 1.5), deckY + 4.2 + 6.8, sz - sd * 0.2 + i * sd * 0.22, 7);
    // bow visor: angled plate
    box(sw * 0.9, 4.0, 1.0, ctx.hullMat, 0, deckY + 2.0, -L / 2 + L * 0.06, -0.45, 0, 0);
    // stern ramp
    box(sw * 0.5, 0.4, 6, P.hatch, 0, deckY + 0.3, L / 2 - 1, 0.25, 0, 0);
    ctx.lights = { x: sw * 0.44 + 0.3, y: by + 2, z: bz, mastY: by + 13, mastZ: bz, fore: null, stern: { y: deckY + 6, z: L / 2 - 1 } };
    return by + 14;
  },
  cruiser(ctx) {
    const { L, B, deckY, box, win, rod, pb } = ctx;
    yachtHull(ctx);
    // raked windscreen, open cockpit with seats, sun pad aft, radar arch, sterndrive
    const wsZ = -L * 0.08;
    box(B * 0.78, 0.9, 0.12, P.glass, 0, deckY + 0.85, wsZ, -0.5, 0, 0);
    box(0.12, 0.8, 1.6, P.glass, -B * 0.39, deckY + 0.8, wsZ + 0.8, 0, 0, 0); box(0.12, 0.8, 1.6, P.glass, B * 0.39, deckY + 0.8, wsZ + 0.8, 0, 0, 0);
    box(B * 0.7, 0.6, L * 0.22, ctx.superMat, 0, deckY + 0.3, -L * 0.28); // foredeck cabin top
    win(B * 0.5, 0.25, 0, deckY + 0.5, -L * 0.28 - L * 0.11 - 0.02);
    box(B * 0.72, 0.9, L * 0.14, ctx.superMat, 0, deckY + 0.45, L * 0.05); // helm console/seat
    box(B * 0.5, 0.35, L * 0.2, P.teak, 0, deckY + 0.3, L * 0.3); // sun pad
    box(0.9, 0.9, 0.9, P.white, -B * 0.25, deckY + 0.45, L * 0.1); box(0.9, 0.9, 0.9, P.white, B * 0.25, deckY + 0.45, L * 0.1);
    rod(-B * 0.35, deckY + 0.2, L * 0.12, -B * 0.25, deckY + 2.2, L * 0.16, 0.06, P.steel); rod(B * 0.35, deckY + 0.2, L * 0.12, B * 0.25, deckY + 2.2, L * 0.16, 0.06, P.steel); rod(-B * 0.25, deckY + 2.2, L * 0.16, B * 0.25, deckY + 2.2, L * 0.16, 0.08, P.steel);
    box(0.7, 0.18, 0.3, P.white, 0, deckY + 2.35, L * 0.16);
    pb.cyl(0.25, 0.5, P.dark, 0, -ctx.draft * 0.5, L / 2 + 0.2, 0.25, 8, Math.PI / 2, 0, 0);
    box(B * 0.5, 0.15, 1.2, P.teak, 0, 0.3, L / 2 + 0.5); // swim platform
    ctx.hullRail(yachtShape(L, B), deckY + 0.1, 0.5);
    ctx.lights = { x: B * 0.3, y: deckY + 1.2, z: wsZ, mastY: deckY + 2.6, mastZ: L * 0.16, fore: null, stern: { y: deckY + 0.5, z: L / 2 - 0.3 } };
    return deckY + 4;
  },
  myacht(ctx) {
    const { L, B, deckY, box, win, rod } = ctx;
    yachtHull(ctx);
    // main deck saloon, raked wheelhouse, flybridge with rail and radar arch, hull windows, swim platform
    const sw = B * 0.82;
    box(sw, 2.4, L * 0.52, ctx.superMat, 0, deckY + 1.2, L * 0.08);
    win(L * 0.45, 0.8, -sw / 2 - 0.02, deckY + 1.5, L * 0.08, Math.PI / 2); win(L * 0.45, 0.8, sw / 2 + 0.02, deckY + 1.5, L * 0.08, Math.PI / 2);
    box(sw * 0.9, 2.2, L * 0.3, ctx.superMat, 0, deckY + 3.5, -L * 0.03);
    box(sw * 0.88, 1.6, 0.12, P.glass, 0, deckY + 3.6, -L * 0.03 - L * 0.15 - 0.3, -0.5, 0, 0);
    win(L * 0.26, 0.9, -sw * 0.45 - 0.02, deckY + 3.9, -L * 0.03, Math.PI / 2); win(L * 0.26, 0.9, sw * 0.45 + 0.02, deckY + 3.9, -L * 0.03, Math.PI / 2);
    box(sw * 0.94, 0.25, L * 0.42, ctx.superMat, 0, deckY + 4.7, L * 0.05);
    ctx.rail([[-sw * 0.46, -L * 0.15], [-sw * 0.46, L * 0.26], [sw * 0.46, L * 0.26], [sw * 0.46, -L * 0.15]], deckY + 4.8, 0.95);
    rod(-sw * 0.4, deckY + 4.8, L * 0.2, -sw * 0.3, deckY + 7.2, L * 0.23, 0.1, P.white); rod(sw * 0.4, deckY + 4.8, L * 0.2, sw * 0.3, deckY + 7.2, L * 0.23, 0.1, P.white); rod(-sw * 0.3, deckY + 7.2, L * 0.23, sw * 0.3, deckY + 7.2, L * 0.23, 0.14, P.white);
    box(1.4, 0.2, 0.4, P.white, 0, deckY + 7.4, L * 0.23); box(0.5, 0.5, 0.5, P.white, -sw * 0.15, deckY + 7.45, L * 0.23);
    box(sw * 0.5, 0.6, L * 0.08, P.white, 0, deckY + 5.1, L * 0.02); // flybridge console
    win(L * 0.3, 0.6, -B / 2 - 0.02, ctx.freeboard * 0.45, 0, Math.PI / 2); win(L * 0.3, 0.6, B / 2 + 0.02, ctx.freeboard * 0.45, 0, Math.PI / 2);
    box(B * 0.7, 0.2, 1.8, P.teak, 0, 0.4, L / 2 + 0.7);
    ctx.hullRail(yachtShape(L, B), deckY + 0.15, 0.5);
    ctx.lights = { x: sw * 0.45, y: deckY + 4.4, z: -L * 0.03, mastY: deckY + 7.6, mastZ: L * 0.23, fore: null, stern: { y: deckY + 1, z: L / 2 - 0.5 } };
    return deckY + 10;
  },
  superyacht(ctx) {
    const { L, B, deckY, box, win, rod, pb } = ctx;
    yachtHull(ctx);
    // four tiers stepping back, helipad aft on the main deck, tender on the top deck, radar mast with domes
    const tiers = [[B * 0.86, L * 0.62, L * 0.0], [B * 0.8, L * 0.5, -L * 0.04], [B * 0.7, L * 0.36, -L * 0.07], [B * 0.55, L * 0.2, -L * 0.1]];
    let y = deckY;
    for (let i = 0; i < tiers.length; i++) {
      const [w, d, z] = tiers[i], h = 2.8;
      box(w, h, d, ctx.superMat, 0, y + h / 2, z);
      win(d * 0.9, 0.9, -w / 2 - 0.02, y + h * 0.6, z, Math.PI / 2); win(d * 0.9, 0.9, w / 2 + 0.02, y + h * 0.6, z, Math.PI / 2);
      if (i === 2) win(w * 0.9, 1.3, 0, y + h * 0.6, z - d / 2 - 0.02);
      box(w * 1.04, 0.25, d * 1.04, ctx.superMat, 0, y + h, z);
      if (i < 3) { const nz = tiers[i + 1][2] + tiers[i + 1][1] / 2; ctx.rail([[-w / 2, nz], [-w / 2, z + d / 2], [w / 2, z + d / 2], [w / 2, nz]], y + h + 0.1, 1.0); }
      y += h;
    }
    const hz = L * 0.36;
    pb.cyl(B * 0.34, 0.2, P.grey, 0, deckY + 0.15, hz, B * 0.34, 8); pb.geo(new THREE.TorusGeometry(B * 0.26, 0.12, 4, 24), P.yellow, 0, deckY + 0.28, hz, Math.PI / 2, 0, 0);
    box(0.5, 0.05, 2.6, P.yellow, -0.9, deckY + 0.28, hz); box(0.5, 0.05, 2.6, P.yellow, 0.9, deckY + 0.28, hz); box(1.6, 0.05, 0.5, P.yellow, 0, deckY + 0.28, hz);
    // tender on the top deck + davit
    pb.geo(new THREE.CapsuleGeometry(0.9, 4.5, 3, 8), P.white, 0, y + 0.7, tiers[3][2] + tiers[3][1] / 2 + 3.5, Math.PI / 2, 0, 0);
    rod(0, y + 0.1, tiers[3][2] + tiers[3][1] / 2 + 1.5, 0, y + 3.2, tiers[3][2] + tiers[3][1] / 2 + 2.5, 0.1, P.steel);
    // radar mast
    const mz = tiers[3][2];
    rod(-1.5, y, mz, 0, y + 5, mz + 0.5, 0.16, P.white); rod(1.5, y, mz, 0, y + 5, mz + 0.5, 0.16, P.white);
    pb.sphere(0.6, P.white, -1.2, y + 3.6, mz + 0.3); pb.sphere(0.6, P.white, 1.2, y + 3.6, mz + 0.3); box(2.6, 0.25, 0.5, P.white, 0, y + 5.2, mz + 0.5);
    win(L * 0.5, 0.7, -B / 2 - 0.02, ctx.freeboard * 0.5, 0, Math.PI / 2); win(L * 0.5, 0.7, B / 2 + 0.02, ctx.freeboard * 0.5, 0, Math.PI / 2);
    box(B * 0.6, 0.3, 3, P.teak, 0, 0.5, L / 2 + 1.3);
    ctx.hullRail(yachtShape(L, B), deckY + 0.15, 0.6);
    ctx.lights = { x: tiers[2][0] / 2, y: deckY + 9, z: tiers[2][2], mastY: y + 5.5, mastZ: mz + 0.5, fore: null, stern: { y: deckY + 1, z: L / 2 - 0.5 } };
    return y + 8;
  },
  sloop(ctx) { yachtHull(ctx); sailboatDeck(ctx, 0.15); return rig(ctx, [{ z: -ctx.L * 0.12, h: ctx.L * 1.3, boom: ctx.L * 0.38, jib: true }]); },
  ketch(ctx) { yachtHull(ctx); sailboatDeck(ctx, 0.18); return rig(ctx, [{ z: -ctx.L * 0.15, h: ctx.L * 1.2, boom: ctx.L * 0.34, jib: true }, { z: ctx.L * 0.3, h: ctx.L * 0.8, boom: ctx.L * 0.24, jib: false }]); },
  schooner(ctx) {
    yachtHull(ctx);
    const { L, B, deckY, box, rod, pb } = ctx;
    // deckhouses, wheel, bowsprit
    box(B * 0.5, 1.0, L * 0.14, ctx.superMat, 0, deckY + 0.5, L * 0.14); box(B * 0.45, 0.9, L * 0.1, ctx.superMat, 0, deckY + 0.45, -L * 0.2);
    pb.geo(new THREE.TorusGeometry(0.6, 0.05, 5, 12), P.teak, 0, deckY + 1.1, L * 0.36, 0, 0, 0); rod(0, deckY, L * 0.36, 0, deckY + 1.1, L * 0.36, 0.06, P.steel);
    rod(0, deckY + 0.3, -L / 2 + 1, 0, deckY + 0.9, -L / 2 - L * 0.12, 0.12, P.teak);
    ctx.bowsprit = { x: 0, y: deckY + 0.9, z: -L / 2 - L * 0.12 };
    ctx.hullRail(yachtShape(L, B), deckY + 0.2, 0.5);
    return rig(ctx, [{ z: -L * 0.22, h: L * 0.7, boom: L * 0.3, jib: true, gaff: true }, { z: L * 0.12, h: L * 0.82, boom: L * 0.36, jib: false, gaff: true }]);
  },
  catamaran(ctx) {
    const { g, L, B, deckY, draft, freeboard, hullMat, deckMat, box, win, pb } = ctx;
    // twin hulls + bridge deck + cabin + trampoline
    for (const side of [-1, 1]) {
      const h = extrudeHull(yachtShape(L, B * 0.2), freeboard + draft * 0.5, [deckMat, hullMat], -draft * 0.5, false); h.position.x = side * B * 0.4; g.add(h);
      pb.box(0.2, draft * 0.5, L * 0.18, hullMat, side * B * 0.4, -draft * 0.7, L * 0.05);
      pb.box(0.1, draft * 0.5, draft * 0.5, hullMat, side * B * 0.4, -draft * 0.4, L / 2 - 1);
    }
    box(B * 0.84, 0.5, L * 0.6, ctx.superMat, 0, freeboard - 0.1, L * 0.08);
    box(B * 0.6, 1.9, L * 0.34, ctx.superMat, 0, freeboard + 1.1, L * 0.02);
    win(B * 0.56, 0.7, 0, freeboard + 1.5, L * 0.02 - L * 0.17 - 0.02); win(L * 0.3, 0.6, -B * 0.3 - 0.02, freeboard + 1.5, L * 0.02, Math.PI / 2); win(L * 0.3, 0.6, B * 0.3 + 0.02, freeboard + 1.5, L * 0.02, Math.PI / 2);
    box(B * 0.66, 0.2, L * 0.38, ctx.superMat, 0, freeboard + 2.1, L * 0.02);
    box(B * 0.5, 0.9, L * 0.12, ctx.superMat, 0, freeboard + 0.6, L * 0.3); // cockpit seats
    const tramp = new THREE.Mesh(new THREE.PlaneGeometry(B * 0.66, L * 0.26), P.tramp); tramp.rotation.x = -Math.PI / 2; tramp.position.set(0, freeboard - 0.05, -L * 0.33); g.add(tramp);
    ctx.rail([[-B * 0.4, -L * 0.45], [-B * 0.4, L * 0.4]], freeboard + 0.1, 0.8); ctx.rail([[B * 0.4, -L * 0.45], [B * 0.4, L * 0.4]], freeboard + 0.1, 0.8);
    ctx.deckY = freeboard + 0.3; ctx.bowFrac = 0.42;
    return rig(ctx, [{ z: -L * 0.05, h: L * 1.25, boom: L * 0.36, jib: true, foot: freeboard + 2.2 }]);
  },
  cutter(ctx) {
    const { L, B, deckY, box, win, mast, pb } = ctx;
    merchantHull(ctx, 0.45, 0.85);
    box(B * 0.95, 0.9, L * 0.5, P.blue, 0, ctx.freeboard - 1.0, 0);
    const sz = -L / 2 + L * 0.42, sw = B * 0.7, sd = L * 0.3;
    box(sw, 3.0, sd, ctx.superMat, 0, deckY + 1.5, sz);
    box(sw * 0.86, 2.4, sd * 0.55, ctx.superMat, 0, deckY + 4.2, sz - 1);
    win(sw * 0.84, 0.9, 0, deckY + 4.6, sz - 1 - sd * 0.275 - 0.02); win(sd * 0.5, 0.8, -sw * 0.43 - 0.02, deckY + 4.6, sz - 1, Math.PI / 2); win(sd * 0.5, 0.8, sw * 0.43 + 0.02, deckY + 4.6, sz - 1, Math.PI / 2);
    win(sw * 0.7, 0.6, 0, deckY + 1.9, sz - sd / 2 - 0.02);
    mast(0, deckY + 5.4, sz, 5, 0.18); box(2.6, 0.3, 0.3, P.white, 0, deckY + 9.8, sz);
    pb.geo(new THREE.CapsuleGeometry(0.9, 4.5, 3, 8), P.rubber, 0, deckY + 0.9, L / 2 - L * 0.2, Math.PI / 2, 0, 0); // RIB aft
    box(B * 0.3, 0.6, 2.2, P.dark, 0, deckY + 0.3, -L / 2 + L * 0.16); // bow gun mount / winch
    ctx.hullRail(hullShape(L, B, 0.45, 0.85), deckY + 0.3, 0.9);
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 8), new THREE.MeshStandardMaterial({ color: 0x3366ff, emissive: 0x3366ff, emissiveIntensity: 2 }));
    beacon.position.set(0, deckY + 6.2, sz - 1); ctx.g.add(beacon); ctx.g.userData.beacon = beacon;
    ctx.lights = { x: sw * 0.43 + 0.3, y: deckY + 5.2, z: sz - 1, mastY: deckY + 10.4, mastZ: sz, fore: null, stern: { y: deckY + 1.5, z: L / 2 - 0.8 } };
    return deckY + 12;
  },
  lifeboat(ctx) {
    const { L, B, deckY, box, win, mast, pb } = ctx;
    merchantHull(ctx, 0.42, 0.75);
    box(B * 0.98, 0.5, L * 0.6, P.blue, 0, ctx.freeboard - 0.6, 0);
    const sz = -L / 2 + L * 0.48, sw = B * 0.74, sd = L * 0.36;
    box(sw, 2.2, sd, ctx.superMat, 0, deckY + 1.1, sz);
    box(sw * 0.8, 1.6, sd * 0.5, ctx.superMat, 0, deckY + 3.0, sz - 0.5);
    win(sw * 0.78, 0.8, 0, deckY + 3.1, sz - 0.5 - sd * 0.25 - 0.02); win(sw * 0.8, 0.7, 0, deckY + 1.4, sz - sd / 2 - 0.02);
    win(sd * 0.45, 0.7, -sw * 0.4 - 0.02, deckY + 3.1, sz - 0.5, Math.PI / 2); win(sd * 0.45, 0.7, sw * 0.4 + 0.02, deckY + 3.1, sz - 0.5, Math.PI / 2);
    mast(0, deckY + 3.8, sz, 3.5, 0.12); box(1.2, 0.2, 0.3, P.white, 0, deckY + 7.4, sz);
    pb.geo(new THREE.TorusGeometry(0.9, 0.12, 5, 12), P.rubber, 0, ctx.freeboard + 0.6, -L / 2 + 0.3, 0, 0, 0);
    ctx.hullRail(hullShape(L, B, 0.42, 0.75), deckY + 0.2, 0.9);
    box(B * 0.5, 0.3, L * 0.25, P.rubber, 0, deckY + 0.15, L / 2 - L * 0.15);
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.4, 8, 8), new THREE.MeshStandardMaterial({ color: 0x3399ff, emissive: 0x3399ff, emissiveIntensity: 2 }));
    beacon.position.set(0, deckY + 4.9, sz - 0.5); ctx.g.add(beacon); ctx.g.userData.beacon = beacon;
    ctx.lights = { x: sw * 0.4 + 0.3, y: deckY + 3.6, z: sz - 0.5, mastY: deckY + 7.6, mastZ: sz, fore: null, stern: { y: deckY + 1, z: L / 2 - 0.6 } };
    return deckY + 9;
  },
  helicopter(ctx) {
    const { g, pb, L } = ctx;
    const H = 28; // hover height above the group origin (main.js places the group on the water)
    const body = new THREE.Group(); body.position.y = H; g.add(body);
    const b = new PartBuilder();
    b.geo(new THREE.CapsuleGeometry(1.3, 5.5, 4, 10), P.heliBody, 0, 0, -0.5, Math.PI / 2, 0, 0);
    b.box(2.2, 1.0, 2.6, P.white, 0, 0.2, 2.2);
    b.geo(new THREE.SphereGeometry(1.2, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2), P.glass, 0, 0.1, -3.4, -Math.PI / 2, 0, 0);
    b.box(2.0, 1.1, 0.14, P.glass, 0, 0.6, -3.1, -0.5, 0, 0);
    b.rod(0, 0.5, 2.5, 0, 1.2, 9.5, 0.45, P.heliBody, 8);
    b.box(0.2, 2.4, 1.4, P.heliBody, 0, 2.0, 9.4); b.box(2.2, 0.15, 1.0, P.white, 0, 1.3, 9.0);
    b.rod(-1.5, -1.6, -2.5, -1.5, -1.6, 2.5, 0.12, P.dark); b.rod(1.5, -1.6, -2.5, 1.5, -1.6, 2.5, 0.12, P.dark);
    for (const z of [-1.8, 1.8]) for (const x of [-1.5, 1.5]) b.rod(x * 0.6, -0.9, z, x, -1.6, z, 0.08, P.dark);
    b.cyl(0.35, 1.0, P.dark, 0, 1.8, -0.5, 0.3, 8); b.box(1.6, 0.7, 2.2, P.dark, 0, 1.5, -0.3);
    b.cyl(0.3, 0.5, P.dark, 0, -1.1, -2.8, 0.3, 8); // searchlight
    b.build(body);
    const rotor = new THREE.Group(); rotor.position.set(0, 2.3, -0.5); body.add(rotor);
    const rb = new PartBuilder();
    for (let i = 0; i < 4; i++) rb.box(L * 0.95, 0.06, 0.4, P.dark, 0, 0, 0, 0, (i * Math.PI) / 4, 0);
    rb.build(rotor);
    const tail = new THREE.Group(); tail.position.set(0.25, 2.0, 9.4); body.add(tail);
    const tb = new PartBuilder(); tb.box(0.05, 2.6, 0.3, P.dark, 0, 0, 0); tb.box(0.05, 0.3, 2.6, P.dark, 0, 0, 0); tb.build(tail);
    ctx.rotor = { main: rotor, tail };
    // lights: red belly beacon, white strobe at the tail, nav
    ctx.nav('red', -1.6, H + 0.2, -1); ctx.nav('green', 1.6, H + 0.2, -1); ctx.nav('white', 0, H + 3.2, 9.4);
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 6), new THREE.MeshStandardMaterial({ color: 0xff3030, emissive: 0xff3030, emissiveIntensity: 2 }));
    beacon.position.set(0, H - 1.4, 1.5); g.add(beacon); g.userData.beacon = beacon;
    const spot = new THREE.Mesh(new THREE.ConeGeometry(8, H - 2, 12, 1, true), new THREE.MeshBasicMaterial({ color: 0xfff2c0, transparent: true, opacity: 0.08, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
    spot.position.set(0, (H - 2) / 2 + 1, -2.8); g.add(spot); g.userData.spot = spot;
    ctx.lights = null; ctx.hover = H;
    pb.build(g);
    return H + 6;
  },
  derelict(ctx) {
    const { g, L, B, draft, freeboard, deckMat, hullMat, superMat } = ctx;
    // everything hangs off a listing sub-group; the wear bake uses the full matrix chain
    const tilt = new THREE.Group(); tilt.rotation.z = 0.21; tilt.rotation.x = -0.03; tilt.position.y = -0.8; g.add(tilt);
    const hull = extrudeHull(hullShape(L, B, 0.3, 0.86), draft + freeboard, [deckMat, hullMat], -draft); tilt.add(hull);
    const b = new PartBuilder();
    const sd = L * 0.16, sz = L / 2 - L * 0.14, sw = B * 0.7, deckY = freeboard + 0.3;
    b.box(sw, 6, sd, superMat, 0, deckY + 3, sz);
    b.box(sw * 0.9, 2.4, sd * 0.6, superMat, 0, deckY + 7.2, sz - 1);
    b.box(sw * 0.9, 0.9, 0.14, P.black, 0, deckY + 7.6, sz - 1 - sd * 0.3 - 0.02);
    b.cyl(1.2, 4, P.rust, 0, deckY + 8, sz + sd * 0.3, 1.0, 10);
    b.rod(0, deckY, -L / 2 + 6, 2.5, deckY + 7, -L / 2 + 9, 0.2, P.rust); // broken foremast
    for (let i = 0; i < 2; i++) b.box(B * 0.6, 1.2, L * 0.2, P.rust, 0, deckY + 0.6, -L / 2 + L * 0.2 + i * L * 0.3);
    b.box(2.44, 2.59, 6.1, P.rust, -B * 0.2, deckY + 2.5, -L * 0.1, 0, 0.3, 0);
    b.build(tilt);
    ctx.lights = null; ctx.lightsOff = true;
    for (const m of ctx.mats) m.userData.uniforms.uWear.value = 1;
    return freeboard + 14;
  },
};

/** cabin trunk, cockpit, lifelines for monohull sailing yachts */
function sailboatDeck(ctx, trunkFrac) {
  const { L, B, deckY, box, win, pb } = ctx;
  box(B * 0.6, 0.8, L * 0.34, ctx.superMat, 0, deckY + 0.3, -L * 0.05);
  win(L * 0.26, 0.3, -B * 0.3 - 0.02, deckY + 0.45, -L * 0.05, Math.PI / 2); win(L * 0.26, 0.3, B * 0.3 + 0.02, deckY + 0.45, -L * 0.05, Math.PI / 2);
  box(B * 0.56, 0.35, L * 0.1, ctx.superMat, 0, deckY + 0.85, -L * 0.08, -0.35, 0, 0); // sprayhood
  box(B * 0.5, 0.5, L * 0.22, P.teak, 0, deckY + 0.15, L * 0.25); // cockpit seats
  pb.geo(new THREE.TorusGeometry(B * 0.16, 0.035, 5, 16), P.steel, 0, deckY + 0.9, L * 0.34, 0, 0, 0); // wheel
  pb.rod(0, deckY, L * 0.34, 0, deckY + 0.9, L * 0.34, 0.05, P.steel);
  ctx.hullRail(yachtShape(L, B), deckY + 0.1, 0.45);
  void trunkFrac;
}

/** masts, booms, standing rigging and sails. Each spec: {z, h (mast height above deck), boom, jib, gaff?, foot?} */
function rig(ctx, specs) {
  const { g, L, B, deckY, pb } = ctx;
  let topY = deckY;
  const sails = ctx.sails;
  specs.forEach((s, i) => {
    const foot = s.foot ?? deckY;
    const mastTop = foot + s.h, boomY = foot + 1.6;
    pb.cyl(0.11 + L * 0.004, s.h, P.steel, 0, foot + s.h / 2, s.z, 0.06 + L * 0.002, 8);
    pb.box(0.12, 0.08, B * 0.5, P.steel, 0, foot + s.h * 0.6, s.z); // spreaders
    // standing rigging: shrouds via the spreader tips, forestay to the bow (or bowsprit), backstay to the stern
    const bowZ = ctx.bowsprit ? ctx.bowsprit.z : -L / 2 + 0.3, bowY = ctx.bowsprit ? ctx.bowsprit.y : deckY + 0.2;
    for (const side of [-1, 1]) { pb.rod(side * B * 0.46, deckY + 0.1, s.z + 0.4, side * B * 0.25, foot + s.h * 0.6, s.z, 0.02, P.dark, 4); pb.rod(side * B * 0.25, foot + s.h * 0.6, s.z, 0, mastTop - 0.3, s.z, 0.02, P.dark, 4); }
    if (i === 0) pb.rod(0, bowY, bowZ, 0, mastTop - 0.2, s.z, 0.025, P.dark, 4);
    if (i === specs.length - 1) pb.rod(0, deckY + 0.3, L / 2 - 0.4, 0, mastTop - 0.4, s.z, 0.025, P.dark, 4);
    if (i > 0) pb.rod(0, (specs[i - 1].foot ?? deckY) + specs[i - 1].h * 0.98, specs[i - 1].z, 0, mastTop - 0.5, s.z, 0.02, P.dark, 4); // triatic
    // boom + mainsail pivot at the mast
    const pivot = new THREE.Group(); pivot.position.set(0, 0, s.z); g.add(pivot);
    const boomMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.07 + L * 0.002, 0.07 + L * 0.002, s.boom, 8), P.steel);
    boomMesh.rotation.x = Math.PI / 2; boomMesh.position.set(0, boomY, s.boom / 2); pivot.add(boomMesh);
    const cover = new THREE.Mesh(new THREE.BoxGeometry(0.35 + L * 0.006, 0.4 + L * 0.008, s.boom * 0.9), P.sailCover); cover.position.set(0, boomY + 0.25, s.boom * 0.48); pivot.add(cover);
    // mainsail: triangle (or gaff quad) with a convex leech, in the pivot's YZ plane
    const shape = new THREE.Shape();
    const headY = s.gaff ? mastTop - s.h * 0.1 : mastTop - 0.3;
    shape.moveTo(0, boomY); shape.lineTo(s.boom * 0.97, boomY);
    if (s.gaff) { shape.quadraticCurveTo(s.boom * 0.9, (boomY + headY) / 2 + 1, s.boom * 0.55, headY + s.h * 0.08); shape.lineTo(0, headY); }
    else shape.quadraticCurveTo(s.boom * 0.72, (boomY + headY) / 2, 0, headY);
    shape.closePath();
    const sailGeo = new THREE.ShapeGeometry(shape, 6); sailGeo.rotateY(-Math.PI / 2); // shape x → +z (aft), y stays up
    const main = new THREE.Mesh(sailGeo, P.sail); pivot.add(main);
    if (s.gaff) { const gaff = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, s.boom * 0.6, 6), P.steel); gaff.position.set(0, headY + s.h * 0.04, s.boom * 0.28); gaff.rotation.x = Math.PI / 2 - 0.25; pivot.add(gaff); }
    sails.push({ kind: 'main', pivot, mesh: main, cover, boomY, headY });
    if (s.jib) {
      const jp = new THREE.Group(); jp.position.set(0, 0, bowZ); g.add(jp);
      const js = new THREE.Shape(); const jh = mastTop - 0.9, jfoot = s.z - bowZ;
      js.moveTo(0, bowY + 0.2); js.lineTo(jfoot * 0.86, bowY + 0.3); js.quadraticCurveTo(jfoot * 0.5, (bowY + jh) / 2 + 0.5, 0.05, jh); js.closePath();
      const jg = new THREE.ShapeGeometry(js, 6); jg.rotateY(-Math.PI / 2);
      const jib = new THREE.Mesh(jg, P.sail); jp.add(jib);
      // furled jib: a roll along the forestay (cylinder axis Y → rotate it onto the bow→masthead direction)
      const flen = Math.hypot(jfoot, jh - bowY);
      const furl = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, flen, 6), P.sailCover);
      furl.position.set(0, (bowY + jh) / 2, jfoot / 2);
      furl.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, jh - bowY, jfoot).normalize());
      jp.add(furl);
      sails.push({ kind: 'jib', pivot: jp, mesh: jib, cover: furl, boomY: bowY, headY: jh });
    }
    topY = Math.max(topY, mastTop);
    if (i === 0) ctx.lights = { x: B * 0.42, y: deckY + 0.6, z: -L * 0.2, mastY: mastTop + 0.2, mastZ: s.z, fore: null, stern: { y: deckY + 0.6, z: L / 2 - 0.3 } };
  });
  return topY + 3;
}

// ----------------------------------------------------------------------------------------------- buildShip
/** Build a ship. Returns a THREE.Group with the userData API (see the contract §6). */
export function buildShip(cls, name, seed = 1) {
  const C = SHIP_CLASSES[cls] || EXTRA_CLASSES[cls] || SHIP_CLASSES.coaster;
  const key = BUILDERS[cls] ? cls : 'coaster';
  const g = new THREE.Group();
  const ctx = makeCtx(g, C, cls, seed);
  let labelY;
  try { labelY = BUILDERS[key](ctx); } catch (e) { console.warn('[ship] builder failed for', cls, e); labelY = ctx.deckY + 20; }
  const { L, B, draft, freeboard } = ctx;
  // merged static parts
  ctx.pb.build(g);
  // navigation lights (port red, starboard green, masthead + stern white)
  const navs = [];
  if (ctx.lights && !ctx.lightsOff) {
    const l = ctx.lights;
    navs.push(ctx.nav('red', -l.x, l.y, l.z), ctx.nav('green', l.x, l.y, l.z), ctx.nav('white', 0, l.mastY, l.mastZ));
    if (l.fore) navs.push(ctx.nav('white', 0, l.fore.y, l.fore.z));
    if (l.stern) navs.push(ctx.nav('white', 0, l.stern.y, l.stern.z));
  }
  // bow foam strips (ship frame) + world-space wake
  const bowFrac = ctx.bowFrac ?? 0.32;
  const bow = key === 'helicopter' ? null : makeBowStrips(L, B, bowFrac, 0.22);
  if (bow) g.add(bow);
  const wake = key === 'helicopter' ? null : makeWake(L, B);
  // Bake each wear-shaded part's vertex positions in the ship frame (full local matrix chain; g itself is untransformed
  // at build time) for the `shipPos` attribute the wear shader samples.
  bakeShipPos(g);
  const mats = ctx.mats, windowMat = ctx.windowMat, navMats = ctx.navMats;
  let sailsUp = true, sailAngle = 0;
  Object.assign(g.userData, {
    cls, length: L, beam: B, draft, freeboard, mats, wake: bow, wakeGroup: wake ? wake.group : null, hover: ctx.hover || 0, isSail: SAIL_CLASSES.has(cls),
    setWear(w) { for (const m of mats) m.userData.uniforms.uWear.value = THREE.MathUtils.clamp(w, 0, 1); },
    setFlood(f) { for (const m of mats) m.userData.uniforms.uFlood.value = f; },
    /** world y of this group (its position.y as set by shipVisual); the waterline band is painted relative to it */
    setWaterY(y) { for (const m of mats) m.userData.uniforms.uWaterY.value = y; },
    /** legacy intensity hook (0..1 from speed): bow strips + Kelvin V */
    setWake(t) { const k = THREE.MathUtils.clamp(t, 0, 1); if (bow) bow.userData.mat.uniforms.uIntensity.value = k * 0.9; if (wake) wake.setIntensity(0.4 + 0.6 * k); },
    /** trailing foam ribbon in world space; main.js adds userData.wakeGroup to the scene once */
    updateWake(dt, worldPos, hdgRad, spdKn) {
      if (!wake) return;
      wake.update(dt, worldPos, hdgRad, spdKn);
      const k = THREE.MathUtils.clamp((Math.abs(spdKn || 0) - 0.5) / 8, 0, 1);
      if (bow) { bow.userData.mat.uniforms.uIntensity.value = k * 0.9; bow.userData.mat.uniforms.uTime.value = oceanState.time; bow.userData.mat.uniforms.uScroll.value = (bow.userData.mat.uniforms.uScroll.value + (dt || 0) * Math.abs(spdKn || 0) * 0.02) % 1000; }
      wake.setIntensity(1);
    },
    resetWake() { wake?.reset(); },
    /** sails: up/down and sheeting to the relative wind (deg, + = wind from starboard) */
    setSails(up, windRelDeg) {
      sailsUp = up !== false;
      const rel = Number.isFinite(windRelDeg) ? windRelDeg : 0;
      const a = Math.abs(((rel % 360) + 540) % 360 - 180); // 0 = head to wind, 180 = run
      const sheet = THREE.MathUtils.clamp((a - 25) / 155, 0, 1) * 82 * (Math.PI / 180);
      const side = rel > 0 ? -1 : 1; // wind from starboard → boom to port
      sailAngle = side * sheet;
      for (const s of ctx.sails) {
        const ang = s.kind === 'jib' ? sailAngle * 1.08 : sailAngle;
        s.pivot.rotation.y = sailsUp ? ang : 0;
        s.mesh.visible = sailsUp; s.cover.visible = !sailsUp;
        if (sailsUp && a < 25) s.mesh.scale.set(1, 1, 0.92); else s.mesh.scale.set(1, 1, 1);
      }
    },
    /** navigation + window lights (night 0..1) */
    setLights(night) {
      const n = THREE.MathUtils.clamp(night, 0, 1);
      if (ctx.lightsOff) return;
      for (const k in navMats) navMats[k].emissiveIntensity = 0.3 + 3.2 * n;
      windowMat.emissiveIntensity = 1.7 * n;
    },
    /** helicopter rotor spin (t = seconds) */
    setRotor(t) { if (ctx.rotor) { ctx.rotor.main.rotation.y = t * 28; ctx.rotor.tail.rotation.x = t * 50; } },
    dispose() { wake?.dispose(); disposeGroup(g); },
  });
  if (ctx.sails.length) g.userData.setSails(true, 90);
  if (name) { const l = makeLabel(name); l.position.set(0, labelY + 4, 0); g.add(l); g.userData.label = l; }
  return g;
}

/** Bake `shipPos` (vertex position in the group frame) into every geometry rendered with a wear material. */
function bakeShipPos(g) {
  g.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(g.matrixWorld).invert(), m = new THREE.Matrix4(), sp = new THREE.Vector3();
  g.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    if (!ms.some((x) => x && x.userData.uniforms)) return;
    m.multiplyMatrices(inv, o.matrixWorld);
    const p = o.geometry.attributes.position, a = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) sp.fromBufferAttribute(p, i).applyMatrix4(m).toArray(a, i * 3);
    o.geometry.setAttribute('shipPos', new THREE.BufferAttribute(a, 3));
  });
}

/** Free the GPU resources of a group built here or in harbor.js (per-mesh geometries, materials, label canvas textures).
 *  Call after scene.remove(). Geometries/materials/textures flagged userData.shared (module-level palettes) are kept, as
 *  is the geometry of Sprites (one BufferGeometry shared by every THREE.Sprite). Disposing a material twice is harmless. */
export function disposeGroup(g) {
  g.traverse((o) => {
    if (o.isSprite) { o.material.map?.dispose(); o.material.dispose(); return; }
    if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
    const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of ms) { if (!m || m.userData.shared) continue; if (m.map && !m.map.userData.shared) m.map.dispose(); m.dispose(); }
  });
}

export function makeLabel(text, color = '#ffffff', size = 36) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 96;
  const x = c.getContext('2d');
  x.font = `600 ${size}px Segoe UI, system-ui, sans-serif`; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillStyle = 'rgba(4,12,20,0.55)'; const w = Math.min(500, x.measureText(text).width + 30); x.fillRect(256 - w / 2, 18, w, 60);
  x.fillStyle = color; x.fillText(text, 256, 48);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, fog: true }));
  s.scale.set(44, 8.25, 1);
  s.userData.setText = (t) => { x.clearRect(0, 0, 512, 96); x.fillStyle = 'rgba(4,12,20,0.55)'; const w2 = Math.min(500, x.measureText(t).width + 30); x.fillRect(256 - w2 / 2, 18, w2, 60); x.fillStyle = color; x.fillText(t, 256, 48); tex.needsUpdate = true; };
  return s;
}

export function buildWreck(cls) {
  const C = SHIP_CLASSES[cls] || EXTRA_CLASSES[cls] || SHIP_CLASSES.coaster;
  const g = new THREE.Group();
  const b = new PartBuilder();
  const L = C.length * 0.6, B = C.beam, d = C.draft;
  const hull = new THREE.ExtrudeGeometry(hullShape(L, B, 0.3, 0.86), { depth: d + 2.5, bevelEnabled: false, curveSegments: 8 });
  hull.rotateX(-Math.PI / 2);
  b.geo(hull, P.rust, 0, -d * 1.3, 0, 0.12, 0, 0.55);
  b.rod(B * 0.3, 0.5, -L * 0.2, B * 0.5, 7, -L * 0.1, 0.18, P.rust);
  b.box(B * 0.5, 3, L * 0.14, P.rust, B * 0.4, 0.8, L * 0.25, 0.12, 0, 0.55);
  b.build(g);
  const buoy = new THREE.Mesh(new THREE.SphereGeometry(1.6, 10, 10), new THREE.MeshStandardMaterial({ color: 0xffd400, emissive: 0x806000, emissiveIntensity: 0.6 }));
  buoy.position.set(B, 1.2, 0); g.add(buoy);
  const l = makeLabel('WRECK', '#ffd400', 30); l.position.set(0, 16, 0); g.add(l);
  g.userData.dispose = () => disposeGroup(g);
  return g;
}

/** SAR craft for snap.rescues: 'lifeboat' (orange all-weather boat) or 'helicopter' (rotor spins via userData.setRotor(t)). */
export function buildRescue(kind) {
  const g = buildShip(kind === 'helicopter' ? 'helicopter' : 'lifeboat', kind === 'helicopter' ? 'SAR' : 'LIFEBOAT', 5);
  g.userData.kind = kind === 'helicopter' ? 'helicopter' : 'lifeboat';
  return g;
}

// ----------------------------------------------------------------------------------------------- offshore platform
/** Offshore platform: four jacket legs with X-bracing, cellar + main deck, accommodation block, process modules, pipe
 *  racks, derrick, pedestal crane, flare boom with an emissive flame, helideck with the H, name label. userData:
 *  setNight(n), update(time) (flame flicker + aviation lights), dispose(). */
export function buildPlatform(platform) {
  const g = new THREE.Group();
  const name = platform?.name || platform?.id || 'Platform';
  const b = new PartBuilder();
  const { jacket, deck: deckMat, accom, proc } = PP;
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xfff1c0, emissive: 0xffd080, emissiveIntensity: 0.5 });
  const windowMat = new THREE.MeshStandardMaterial({ color: 0x1b3650, roughness: 0.3, metalness: 0.5, emissive: 0xffd890, emissiveIntensity: 0 });
  const aviMat = new THREE.MeshStandardMaterial({ color: 0xff2020, emissive: 0xff2020, emissiveIntensity: 1.5 });
  const DY = 28, S = 18, S0 = 24, BOT = -48;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.rod(sx * S0, BOT, sz * S0, sx * S, DY, sz * S, 2.3, jacket, 10);
  for (let lvl = 0; lvl < 3; lvl++) {
    const y0 = BOT + 10 + lvl * 20, y1 = y0 + 20, f0 = S0 + (S - S0) * ((y0 - BOT) / (DY - BOT)), f1 = S0 + (S - S0) * ((y1 - BOT) / (DY - BOT));
    for (const [ax, az, bx, bz] of [[-1, -1, 1, -1], [1, -1, 1, 1], [1, 1, -1, 1], [-1, 1, -1, -1]]) {
      b.rod(ax * f0, y0, az * f0, bx * f1, y1, bz * f1, 0.8, jacket, 6); b.rod(bx * f0, y0, bz * f0, ax * f1, y1, az * f1, 0.8, jacket, 6);
      b.rod(ax * f1, y1, az * f1, bx * f1, y1, bz * f1, 0.8, jacket, 6);
    }
  }
  for (let i = 0; i < 6; i++) b.rod(-6 + i * 2.4, BOT, 4, -6 + i * 2.4, DY, 4, 0.45, proc, 6); // conductors
  b.box(2 * S + 18, 2.5, 2 * S + 14, deckMat, 0, DY - 10, 0); // cellar deck
  b.box(2 * S + 22, 3.0, 2 * S + 18, deckMat, 0, DY + 1.5, 0); // main deck
  const top = DY + 3;
  // accommodation block (windows) with the helideck on top
  b.box(22, 15, 18, accom, -16, top + 7.5, 10);
  for (let k = 0; k < 4; k++) { b.box(20, 0.8, 0.14, windowMat, -16, top + 2 + k * 3.4, 10 - 9.02); b.box(20, 0.8, 0.14, windowMat, -16, top + 2 + k * 3.4, 10 + 9.02); b.box(0.14, 0.8, 16, windowMat, -27.02, top + 2 + k * 3.4, 10); }
  b.cyl(13, 0.8, deckMat, -16, top + 15.4, 10, 13, 8);
  b.geo(new THREE.TorusGeometry(10.5, 0.3, 4, 32), P.yellow, -16, top + 15.9, 10, Math.PI / 2, 0, 0);
  b.box(1.2, 0.1, 7, P.yellow, -18.5, top + 15.9, 10); b.box(1.2, 0.1, 7, P.yellow, -13.5, top + 15.9, 10); b.box(5, 0.1, 1.2, P.yellow, -16, top + 15.9, 10);
  for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; b.box(0.4, 0.4, 0.4, lampMat, -16 + Math.cos(a) * 12.5, top + 16, 10 + Math.sin(a) * 12.5); }
  // process modules, pipe racks, tanks
  b.box(16, 9, 14, proc, 12, top + 4.5, 12); b.box(14, 7, 12, P.yellow, 12, top + 3.5, -8); b.box(10, 6, 10, proc, -14, top + 3, -12);
  for (let i = 0; i < 4; i++) b.rod(-22, top + 2 + i * 1.2, -2, 22, top + 2 + i * 1.2, -2, 0.35, proc, 6);
  for (let i = 0; i < 3; i++) b.cyl(2.2, 7, P.white, 4 + i * 5.5, top + 3.5, -18, 2.2, 12);
  // derrick (lattice) at the well bay
  const dh = 42;
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) b.rod(sx * 5, top, sz * 5, sx * 1.5, top + dh, sz * 1.5, 0.35, proc, 6);
  for (let k = 1; k < 6; k++) { const y = top + (dh * k) / 6, f = 5 + (1.5 - 5) * (k / 6); b.rod(-f, y, -f, f, y, -f, 0.15, proc, 4); b.rod(f, y, -f, f, y, f, 0.15, proc, 4); b.rod(f, y, f, -f, y, f, 0.15, proc, 4); b.rod(-f, y, f, -f, y, -f, 0.15, proc, 4); b.rod(-f, y, -f, f, y - dh / 6, f, 0.1, proc, 4); }
  b.box(4, 2, 4, proc, 0, top + dh + 1, 0);
  b.box(0.5, 0.5, 0.5, aviMat, 0, top + dh + 2.3, 0);
  // pedestal crane
  b.cyl(1.6, 8, P.yellow, 20, top + 4, 18, 1.4, 10); b.box(5, 3.5, 5, P.yellow, 20, top + 9.5, 18, 0, 0.6, 0);
  b.rod(20, top + 10, 18, 44, top + 24, 36, 0.6, P.yellow, 6); b.rod(44, top + 24, 36, 44, top + 12, 36, 0.06, P.dark, 4); b.box(1.2, 0.8, 0.8, P.dark, 44, top + 12, 36);
  // flare boom
  const fx = 2 * S + 11, fz = -(2 * S + 9);
  b.rod(fx - 6, top, fz + 6, fx + 30, top + 22, fz - 26, 0.5, proc, 6); b.rod(fx - 6, top + 6, fz + 6, fx + 30, top + 22, fz - 26, 0.3, proc, 6);
  for (let k = 1; k < 5; k++) b.rod(fx - 6 + 36 * (k / 5), top + 22 * (k / 5), fz + 6 - 32 * (k / 5), fx - 6 + 36 * (k / 5), top + 6 + 16 * (k / 5), fz + 6 - 32 * (k / 5), 0.12, proc, 4);
  b.box(0.5, 0.5, 0.5, aviMat, fx + 30, top + 23, fz - 26);
  b.build(g);
  const flame = new THREE.Mesh(new THREE.ConeGeometry(2.2, 9, 10), P.flame); flame.position.set(fx + 30, top + 27, fz - 26); g.add(flame);
  const glow = new THREE.Mesh(new THREE.SphereGeometry(4, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false })); glow.position.copy(flame.position); glow.position.y += 2; g.add(glow);
  const label = makeLabel(name, '#ffd877', 34); label.position.set(0, top + dh + 14, 0); label.scale.set(90, 17, 1); g.add(label);
  g.userData.platform = platform; g.userData.label = label; g.userData.lampPos = new THREE.Vector3(-16, top + 16, 10);
  g.userData.setNight = (n) => { const k = THREE.MathUtils.clamp(n, 0, 1); lampMat.emissiveIntensity = 0.5 + 3.5 * k; windowMat.emissiveIntensity = 1.8 * k; };
  g.userData.update = (t) => { const f = 1 + 0.25 * Math.sin(t * 9.3) + 0.15 * Math.sin(t * 23.1); flame.scale.set(1, f, 1); flame.rotation.y = t * 2; glow.scale.setScalar(0.8 + 0.3 * f); aviMat.emissiveIntensity = (Math.sin(t * 2.5) > 0.6 ? 2.5 : 0.4); };
  g.userData.dispose = () => { lampMat.dispose(); windowMat.dispose(); aviMat.dispose(); glow.material.dispose(); disposeGroup(g); };
  return g;
}
