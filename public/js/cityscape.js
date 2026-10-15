// Cityscape — the three.js side of the city layer (citymesh.js builds the arrays in the world-tile worker).
//
//  * facade material: ONE program for every building of every tile. Walls carry `fac` (metres along the wall, metres
//    above the ground, wall height) and `sty` (facade style, per-building seed); the fragment shader draws the window
//    grid of the style (cityrules.js FACADE — floor height, bay width, window box), dark glass with a sky gradient by
//    day, a random share of warm lit windows at night (setCityNight), and fades the grid into its average colour when
//    a window gets smaller than a couple of pixels, so a whole city stays one smooth draw call per tile without
//    shimmering. Roofs (and the ground under low buildings) take their colour from the satellite detail drape where
//    it is loaded, so the 3D roofs and the imagery agree instead of showing a roof twice; tall buildings (their roofs
//    lean in the imagery) keep their own colour.
//  * instanced trees (broadleaf, conifer, palm), 40' containers in eight line colours, and the satellite trees: tree
//    canopies detected in the z18 satellite drape around the ship (cityrules.canopyScore) become instanced trees on
//    land, so parks, gardens and street trees stand where the imagery shows them.
import * as THREE from 'three';
import { toLocal } from '/shared/geo.js';
import { FACADE, STYLE, canopyScore, hash01 } from './cityrules.js';

/** Night factor shared by every city material (0 day … 1 night); main.js → terrain.setNight → setCityNight. */
const U_NIGHT = { value: 0 };
export function setCityNight(k) { U_NIGHT.value = Math.max(0, Math.min(1, Number(k) || 0)); }
export function cityNight() { return U_NIGHT.value; }

// ------------------------------------------------------------------------------------------------ facade shader
function styleTable() {
  // GLSL: vec4 (bay, floor, ground, lit) + vec4 (wx0, wx1, wy0, wy1) per style 1..8
  const lines = [];
  for (let s = 1; s <= 8; s++) {
    const f = FACADE[s];
    lines.push(`  if (st == ${s}) { g0 = vec4(${f.bay.toFixed(2)}, ${f.floor.toFixed(2)}, ${f.ground.toFixed(2)}, ${f.lit.toFixed(2)}); g1 = vec4(${f.wx[0].toFixed(2)}, ${f.wx[1].toFixed(2)}, ${f.wy[0].toFixed(2)}, ${f.wy[1].toFixed(2)}); }`);
  }
  return lines.join('\n');
}
const FACADE_GLSL = `
varying vec3 vSlFac; varying vec2 vSlSty; varying vec3 vSlW; varying float vSlNy;
uniform float uCityNight;
uniform sampler2D uDetailDrape; uniform float uDetailOn; uniform vec4 uDetailBox;
float slH(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float slBox(vec2 f, vec2 lo, vec2 hi, vec2 aa) {
  vec2 a = smoothstep(lo - aa, lo + aa, f) * (1.0 - smoothstep(hi - aa, hi + aa, f));
  return a.x * a.y;
}`;
const FACADE_FRAG = `
  float slWin = 0.0; vec3 slLit = vec3(0.0);
  {
    // satellite colour under the fragment (roofs, low walls): the imagery and the 3D roofs agree
    if (uDetailOn > 0.5) {
      vec2 dUv = vec2((vSlW.x - uDetailBox.x) / (uDetailBox.z - uDetailBox.x), (vSlW.z - uDetailBox.y) / (uDetailBox.w - uDetailBox.y));
      if (dUv.x > 0.01 && dUv.x < 0.99 && dUv.y > 0.01 && dUv.y < 0.99) {
        vec4 sat = texture2D(uDetailDrape, vec2(dUv.x, 1.0 - dUv.y));
        if (sat.a > 0.5 && max(sat.r, max(sat.g, sat.b)) > 0.02) {
          vec3 s = sat.rgb / max(sat.a, 0.004);
          float roof = smoothstep(0.55, 0.8, vSlNy) * (1.0 - smoothstep(18.0, 32.0, vSlFac.z));
          diffuseColor.rgb = mix(diffuseColor.rgb, s * 0.92, roof * 0.8);
          float wallTint = (1.0 - smoothstep(0.55, 0.8, vSlNy)) * 0.18;
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * (0.6 + 0.8 * s / max(0.15, dot(s, vec3(0.333)))) , wallTint);
        }
      }
    }
    int st = int(vSlSty.x + 0.5);
    if (st > 0) {
      vec4 g0 = vec4(3.2, 3.0, 0.3, 0.4); vec4 g1 = vec4(0.25, 0.75, 0.3, 0.8);
${styleTable()}
      float seed = vSlSty.y;
      vec2 c = vec2(vSlFac.x / g0.x, (vSlFac.y - g0.z) / g0.y);
      vec2 id = floor(c); vec2 f = fract(c);
      vec2 aa = fwidth(c) * 0.7 + 1e-4;
      float px = max(aa.x, aa.y);
      float far = smoothstep(0.12, 0.42, px);                       // window cells under ~3 px: average colour
      float inWall = step(0.0, vSlFac.y - g0.z) * step(vSlFac.y + 0.6, vSlFac.z);
      if (st == ${STYLE.WAREHOUSE}) inWall = step(0.0, vSlFac.y) * step(id.y, 0.5);           // loading doors only
      if (st == ${STYLE.RETAIL}) inWall *= step(id.y, 0.5) + 0.35 * step(0.5, id.y);          // shop glazing, few upstairs
      float colOn = step(0.18, slH(vec2(id.x, seed)));                                        // some bays blind
      float win = slBox(f, g1.xy, g1.zw, aa) * inWall * (st == ${STYLE.OFFICE} ? 1.0 : colOn);
      float cover = (g1.y - g1.x) * (g1.w - g1.z) * 0.8;
      win = mix(win, cover * inWall, far);
      float r = slH(id + vec2(seed * 0.37, seed));
      vec3 glass = st == ${STYLE.OFFICE} ? vec3(0.20, 0.27, 0.33) : st == ${STYLE.WAREHOUSE} ? vec3(0.22, 0.23, 0.24) : vec3(0.08, 0.10, 0.12);
      glass *= 0.75 + 0.5 * r;
      glass += vec3(0.05, 0.07, 0.09) * f.y * (1.0 - far);         // sky reflection gradient
      // corrugated sheet on sheds, floor bands on blocks (fade away like the windows)
      if (st == ${STYLE.WAREHOUSE} || st == ${STYLE.INDUSTRIAL}) diffuseColor.rgb *= 1.0 - 0.07 * (1.0 - far) * step(0.5, fract(vSlFac.x * 1.6));
      else diffuseColor.rgb *= 1.0 - 0.06 * (1.0 - far) * (1.0 - smoothstep(0.0, 0.06, f.y)) * inWall;
      diffuseColor.rgb = mix(diffuseColor.rgb, glass, win);
      slWin = win;
      float lit = step(1.0 - g0.w, fract(r * 7.13 + seed * 0.011));
      lit = mix(lit, g0.w, far);
      vec3 warm = mix(vec3(1.0, 0.72, 0.42), vec3(0.85, 0.9, 1.0), step(0.82, fract(r * 3.7)));
      slLit = warm * win * lit * uCityNight * (st == ${STYLE.OFFICE} ? 1.3 : 1.7);
    }
    // contact shade: walls darken toward the ground
    if (vSlNy < 0.5) diffuseColor.rgb *= 0.78 + 0.22 * smoothstep(-0.5, 4.0, vSlFac.y + (1.0 - step(0.5, vSlFac.z)) * 10.0);
  }`;

/** The building material (one per WorldTileSet: it shares that set's detail drape uniforms). */
export function makeBuildingMaterial(detailUniforms = null, mobile = false) {
  const m = mobile
    ? new THREE.MeshLambertMaterial({ vertexColors: true })
    : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0.0 });
  const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat); blank.needsUpdate = true;
  const du = detailUniforms || { uDetailDrape: { value: blank }, uDetailOn: { value: 0 }, uDetailBox: { value: new THREE.Vector4() } };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uCityNight = U_NIGHT;
    sh.uniforms.uDetailDrape = du.uDetailDrape; sh.uniforms.uDetailOn = du.uDetailOn; sh.uniforms.uDetailBox = du.uDetailBox;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 fac; attribute vec2 sty; varying vec3 vSlFac; varying vec2 vSlSty; varying vec3 vSlW; varying float vSlNy;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vSlFac = fac; vSlSty = sty; vSlW = (modelMatrix * vec4(transformed, 1.0)).xyz;')
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n  vSlNy = objectNormal.y;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${FACADE_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FACADE_FRAG}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = mix(roughnessFactor, 0.22, slWin * 0.85);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += slLit;');
  };
  m.customProgramCacheKey = () => `saltline-city-${mobile ? 'l' : 's'}`;
  return m;
}

// ------------------------------------------------------------------------------------------------ shared instance assets
let ASSETS = null;
function colourGeo(geo, fn) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  const p = g.attributes.position, c = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) { const rgb = fn(p.getX(i), p.getY(i), p.getZ(i)); c[i * 3] = rgb[0]; c[i * 3 + 1] = rgb[1]; c[i * 3 + 2] = rgb[2]; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}
function merge(geos) {
  let n = 0; for (const g of geos) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, o * 3); nrm.set(g.attributes.normal.array, o * 3); col.set(g.attributes.color.array, o * 3);
    o += g.attributes.position.count; g.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}
const TRUNK = [0.32, 0.24, 0.17];
/** Trees are 1 m tall in their geometry (scaled by the instance height); crowns white × the instance colour. */
export function cityAssets() {
  if (ASSETS) return ASSETS;
  const shadeY = (y0, y1) => (x, y) => { const k = 0.62 + 0.38 * Math.min(1, Math.max(0, (y - y0) / (y1 - y0))); return [k, k, k]; };
  const trunk = (r, h) => colourGeo(new THREE.CylinderGeometry(r * 0.7, r, h, 5, 1).translate(0, h / 2, 0), () => TRUNK);
  const broad = merge([
    trunk(0.035, 0.42),
    colourGeo(new THREE.IcosahedronGeometry(0.34, 0).scale(1, 0.85, 1).translate(0, 0.66, 0), shadeY(0.36, 0.95)),
  ]);
  const conifer = merge([
    trunk(0.03, 0.2),
    colourGeo(new THREE.ConeGeometry(0.26, 0.55, 7).translate(0, 0.42, 0), shadeY(0.15, 0.7)),
    colourGeo(new THREE.ConeGeometry(0.19, 0.45, 7).translate(0, 0.72, 0), shadeY(0.5, 0.95)),
  ]);
  const palmFronds = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const leaf = new THREE.BoxGeometry(0.36, 0.012, 0.07).translate(0.18, 0, 0).rotateZ(-0.35).rotateY(a).translate(0, 0.95, 0);
    palmFronds.push(colourGeo(leaf, () => [0.85, 0.9, 0.8]));
  }
  const palm = merge([colourGeo(new THREE.CylinderGeometry(0.018, 0.03, 0.96, 5, 1).translate(0, 0.48, 0), () => [0.55, 0.47, 0.36]), ...palmFronds]);
  const treeMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  // a 40' box, 1 × 1 × 1 at the origin's floor (scaled per container): corrugated sides, darker doors at one end
  const box = colourGeo(new THREE.BoxGeometry(1, 0.98, 1, 1, 1, 1).translate(0, 0.49, 0), (x, y) => (y > 0.97 ? [0.86, 0.86, 0.86] : x > 0.49 ? [0.78, 0.78, 0.78] : [1, 1, 1]));
  const contMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  contMat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vSlL;').replace('#include <begin_vertex>', '#include <begin_vertex>\n  vSlL = position;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vSlL;')
      .replace('#include <color_fragment>', '#include <color_fragment>\n  { float rib = step(0.5, fract(vSlL.x * 40.0)) * (1.0 - smoothstep(0.3, 0.6, fwidth(vSlL.x * 40.0))); diffuseColor.rgb *= 1.0 - 0.1 * rib; }');
  };
  contMat.customProgramCacheKey = () => 'saltline-container';
  ASSETS = { trees: [broad, conifer, palm], treeMat, box, contMat };
  return ASSETS;
}
/** Line colours (sRGB): sky blue, deep blue, orange, green, magenta, red, grey, rust. */
const CONTAINER_COLOURS = [0x3f9fc6, 0x1f4e8c, 0xd9622b, 0x2f7a4c, 0xb42c74, 0xa3352b, 0x8b9093, 0x7a4b2e].map((h) => new THREE.Color(h));
const TREE_TINTS = [[0.36, 0.5, 0.22], [0.2, 0.34, 0.18], [0.42, 0.52, 0.26]];

/** Instanced trees from records [x, y, z, h, kind, shade] (local frame) → up to three InstancedMeshes. */
export function treeMeshes(arr) {
  const A = cityAssets(), out = [];
  if (!arr || !arr.length) return out;
  const byKind = [[], [], []];
  for (let i = 0; i < arr.length; i += 6) byKind[Math.max(0, Math.min(2, arr[i + 4] | 0))].push(i);
  const M4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), c = new THREE.Color(), Y = new THREE.Vector3(0, 1, 0);
  for (let k = 0; k < 3; k++) {
    const list = byKind[k]; if (!list.length) continue;
    const im = new THREE.InstancedMesh(A.trees[k], A.treeMat, list.length);
    list.forEach((o, n) => {
      const h = arr[o + 3], sh = arr[o + 5];
      p.set(arr[o], arr[o + 1], arr[o + 2]); q.setFromAxisAngle(Y, sh * 6.283);
      const w = h * (k === 1 ? 0.9 : k === 2 ? 1 : 0.85 + 0.35 * hash01(o, 3));
      s.set(w, h, w); M4.compose(p, q, s); im.setMatrixAt(n, M4);
      const t = TREE_TINTS[k], v = 0.82 + 0.36 * sh;
      c.setRGB(t[0] * v, t[1] * v * (0.95 + 0.1 * hash01(o, 5)), t[2] * v); im.setColorAt(n, c);
    });
    im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.computeBoundingSphere?.();
    im.name = 'city-trees';
    out.push(im);
  }
  return out;
}
/** Instanced containers from records [x, y, z, yaw (rad, long axis = (cos, sin) in x/z), colour, 0]. */
export function containerMesh(arr) {
  if (!arr || !arr.length) return null;
  const A = cityAssets(), k = arr.length / 6;
  const im = new THREE.InstancedMesh(A.box, A.contMat, k);
  const M4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(12.19, 2.59, 2.44), Y = new THREE.Vector3(0, 1, 0), c = new THREE.Color();
  for (let i = 0; i < k; i++) {
    const o = i * 6;
    p.set(arr[o], arr[o + 1], arr[o + 2]); q.setFromAxisAngle(Y, -arr[o + 3]);
    M4.compose(p, q, s); im.setMatrixAt(i, M4);
    c.copy(CONTAINER_COLOURS[(arr[o + 4] | 0) % CONTAINER_COLOURS.length]).multiplyScalar(0.85 + 0.25 * hash01(i, 9)); im.setColorAt(i, c);
  }
  im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true;
  im.computeBoundingSphere?.();
  im.name = 'city-containers';
  return im;
}
/** Building mesh from a citymesh.js result (typed arrays are freed from the JS heap once on the GPU). */
export function buildingMesh(city, material) {
  if (!city || !city.verts) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(city.pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(city.nrm, 3, true));
  g.setAttribute('color', new THREE.BufferAttribute(city.col, 3, true));
  g.setAttribute('fac', new THREE.BufferAttribute(city.fac, 3));
  g.setAttribute('sty', new THREE.BufferAttribute(city.sty, 2));
  g.setIndex(new THREE.BufferAttribute(city.verts < 65536 ? Uint16Array.from(city.idx) : city.idx, 1));
  g.computeBoundingSphere();
  for (const a of Object.values(g.attributes)) a.onUpload(freeArray);
  g.index.onUpload(freeArray);
  const mesh = new THREE.Mesh(g, material);
  mesh.name = 'city-buildings';
  return mesh;
}
function freeArray() { this.array = null; }
/** GPU bytes of a city result (budget accounting). */
export function cityBytes(city) {
  if (!city) return 0;
  let b = 0; for (const k of ['pos', 'nrm', 'col', 'fac', 'sty', 'idx']) b += city[k]?.byteLength || 0;
  b += (city.inst?.trees?.length || 0) / 6 * 76 + (city.inst?.boxes?.length || 0) / 6 * 76;
  return b;
}

// ------------------------------------------------------------------------------------------------ satellite trees
const SAT_N = 512;
/**
 * Trees where the satellite drape shows canopy. `build(drape, box)` reads the drape canvas once (scaled to 512²),
 * classifies each pixel (canopyScore) and places a tree on land (`landAt(lat, lon)` → ground height or null) with a
 * probability by confidence, capped. Placed in a group anchored at the box centre (setOrigin moves the group only).
 */
export class SatTrees {
  constructor(parent, { mobile = false } = {}) {
    this.group = new THREE.Group(); this.group.name = 'sat-trees';
    parent.add(this.group);
    this.cap = mobile ? 1800 : 7000;
    this.meshes = []; this.anchor = null; this.key = null;
    this._c = null;
  }
  /** drape: terrain.js Drape (canvas, z, x0, y0, cols, rows); box: its lat/lon box; landAt(lat, lon) → ground y | null */
  build(drape, box, landAt, origin, pxToLon, pxToLat) {
    const key = `${drape.z}/${drape.x0}/${drape.y0}/${drape.cols}/${drape.rows}`;
    if (key === this.key) return false;
    this.key = key;
    let data;
    try {
      if (!this._c) { const c = document.createElement('canvas'); c.width = c.height = SAT_N; this._c = { c, x: c.getContext('2d', { willReadFrequently: true }) }; }
      this._c.x.clearRect(0, 0, SAT_N, SAT_N);
      this._c.x.drawImage(drape.canvas, 0, 0, SAT_N, SAT_N);
      data = this._c.x.getImageData(0, 0, SAT_N, SAT_N).data;
    } catch { return false; }     // tainted / lost canvas: keep the old trees
    const anchor = { lat: (box.latMin + box.latMax) / 2, lon: (box.lonMin + box.lonMax) / 2 };
    const W = drape.cols * 256, H = drape.rows * 256;
    const cand = [];
    for (let j = 1; j < SAT_N - 1; j++) for (let i = 1; i < SAT_N - 1; i++) {
      const o = (j * SAT_N + i) * 4;
      if (data[o + 3] < 200) continue;
      const s = canopyScore(data[o], data[o + 1], data[o + 2]);
      if (s <= 0.15) continue;
      // texture: canopies are lumpy, lawns are flat — need some contrast with the neighbours
      const l = (k) => data[k] * 0.3 + data[k + 1] * 0.59 + data[k + 2] * 0.11;
      const c0 = l(o), dv = Math.abs(c0 - l(o - 4)) + Math.abs(c0 - l(o + 4)) + Math.abs(c0 - l(o - SAT_N * 4)) + Math.abs(c0 - l(o + SAT_N * 4));
      const score = s * Math.min(1, 0.35 + dv / 30);
      if (hash01(i * 7 + 3, j * 13 + 5) > score * 0.55) continue;
      cand.push(i, j, score);
    }
    // thin evenly to the cap
    const step = Math.max(1, cand.length / 3 / this.cap);
    const recs = [];
    const lat0 = anchor.lat, cosA = Math.cos(lat0 * Math.PI / 180);
    for (let t = 0; t < cand.length / 3 && recs.length / 6 < this.cap; t += step) {
      const k = Math.floor(t) * 3, i = cand[k], j = cand[k + 1], sc = cand[k + 2];
      const jx = hash01(i, j * 3 + 1) - 0.5, jy = hash01(i * 5 + 2, j) - 0.5;
      const px = drape.x0 * 256 + ((i + 0.5 + jx) / SAT_N) * W, py = drape.y0 * 256 + ((j + 0.5 + jy) / SAT_N) * H;
      const lat = pxToLat(py, drape.z), lon = pxToLon(px, drape.z);
      const y = landAt(lat, lon);
      if (y == null) continue;
      const x = (lon - anchor.lon) * 111320 * cosA, z = -(lat - lat0) * 110574;
      const r = hash01(i * 31, j * 17);
      const kind = Math.abs(lat) < 28 && r < 0.4 ? 2 : Math.abs(lat) > 50 && r < 0.35 ? 1 : 0;
      recs.push(x, y - 0.3, z, kind === 2 ? 9 + r * 6 : 7 + sc * 9 + r * 4, kind, r);
    }
    this.clear();
    this.anchor = anchor;
    this.meshes = treeMeshes(Float32Array.from(recs));
    for (const m of this.meshes) { m.name = 'sat-trees'; this.group.add(m); }
    this.setOrigin(origin);
    this.count = recs.length / 6;
    return true;
  }
  setOrigin(origin) {
    if (!this.anchor || !origin) return;
    const l = toLocal(this.anchor.lat, this.anchor.lon, origin);
    this.group.position.set(l.x, 0, l.z);
  }
  clear() { for (const m of this.meshes) { this.group.remove(m); m.dispose?.(); } this.meshes = []; this.count = 0; }
  reset() { this.clear(); this.key = null; }
  dispose() { this.clear(); this.group.parent?.remove(this.group); }
}
