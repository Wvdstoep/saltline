// Procedural ship models (forward = -z, real-metre scale) with a wear shader: rust streaks, barnacle band at the
// waterline, antifouling below it, roughness increasing with neglect. Also coast-guard cutters, wake and labels.
import * as THREE from 'three';
import { SHIP_CLASSES } from '/shared/constants.js';

const WEAR_VERT_PARS = /* glsl */`varying vec3 vWPos; varying float vLocalY;`;
const WEAR_VERT = /* glsl */`vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz; vLocalY = position.y;`;
const WEAR_FRAG_PARS = /* glsl */`
uniform float uWear; uniform float uFlood; varying vec3 vWPos; varying float vLocalY;
float wh(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
float wnoise(vec3 p) { vec3 i = floor(p); vec3 f = fract(p); f = f*f*(3.0-2.0*f);
  float a = mix(mix(wh(i), wh(i+vec3(1,0,0)), f.x), mix(wh(i+vec3(0,1,0)), wh(i+vec3(1,1,0)), f.x), f.y);
  float b = mix(mix(wh(i+vec3(0,0,1)), wh(i+vec3(1,0,1)), f.x), mix(wh(i+vec3(0,1,1)), wh(i+vec3(1,1,1)), f.x), f.y);
  return mix(a, b, f.z); }`;
const WEAR_FRAG = /* glsl */`
{
  vec3 lp = vWPos;
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
  m.userData.uniforms = { uWear: { value: 0 }, uFlood: { value: 0 } };
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uWear = m.userData.uniforms.uWear; shader.uniforms.uFlood = m.userData.uniforms.uFlood;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\n' + WEAR_VERT_PARS)
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n' + WEAR_VERT);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + WEAR_FRAG_PARS)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + WEAR_FRAG)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = min(1.0, roughnessFactor + 0.45 * uWear);');
  };
  return m;
}

function box(w, h, d, mat, x = 0, y = 0, z = 0) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); return m; }
function cyl(r, h, mat, x = 0, y = 0, z = 0, rt = r) { const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, r, h, 14), mat); m.position.set(x, y, z); return m; }

function hullShape(L, B, bowFrac = 0.32, sternW = 0.86) {
  const s = new THREE.Shape();
  const hb = B / 2, hl = L / 2;
  s.moveTo(-hb * sternW, -hl);
  s.lineTo(hb * sternW, -hl);
  s.quadraticCurveTo(hb, -hl + L * 0.08, hb, -hl + L * 0.15);
  s.lineTo(hb, hl - L * bowFrac);
  s.quadraticCurveTo(hb * 0.9, hl - L * bowFrac * 0.35, 0, hl);
  s.quadraticCurveTo(-hb * 0.9, hl - L * bowFrac * 0.35, -hb, hl - L * bowFrac);
  s.lineTo(-hb, -hl + L * 0.15);
  s.quadraticCurveTo(-hb, -hl + L * 0.08, -hb * sternW, -hl);
  return s;
}

const CONTAINER_COLORS = [0xc0392b, 0x2980b9, 0x27ae60, 0xf39c12, 0x8e44ad, 0x7f8c8d, 0xd35400, 0x16a085];
function detRand(seed) { let s = seed * 9301 + 49297; return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; }; }

/** Build a ship. Returns a THREE.Group with userData { setWear, setFlood, length, beam, freeboard, draft, label } */
export function buildShip(cls, name, seed = 1) {
  const C = SHIP_CLASSES[cls] || CUTTER_CLASS[cls] || SHIP_CLASSES.coaster;
  const L = C.length, B = C.beam, draft = C.draft, freeboard = C.freeboard || Math.max(3, L * 0.045);
  const g = new THREE.Group();
  const rnd = detRand(seed);
  const hullMat = makeWearMaterial(C.hullColor);
  const deckMat = makeWearMaterial(0x6b7076, { roughness: 0.8, metalness: 0.1 });
  const superMat = makeWearMaterial(0xe9ebe6, { roughness: 0.6, metalness: 0.1 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x1b2430, roughness: 0.5, metalness: 0.3 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x1d3f5c, roughness: 0.2, metalness: 0.7 });
  const mats = [hullMat, deckMat, superMat];

  // Hull: extruded outline (shape plane XY → rotated so Y becomes -Z forward, extrusion Z becomes up)
  const hullGeo = new THREE.ExtrudeGeometry(hullShape(L, B, cls === 'trawler' ? 0.4 : cls === 'cutter' ? 0.45 : 0.3), { depth: draft + freeboard, bevelEnabled: false, curveSegments: 10 });
  const hull = new THREE.Mesh(hullGeo, [deckMat, hullMat]);
  hull.rotation.x = -Math.PI / 2; hull.position.y = -draft;
  g.add(hull);
  // Bulwark lip around the deck
  const lipGeo = new THREE.ExtrudeGeometry(hullShape(L * 1.005, B * 1.03), { depth: 1.1, bevelEnabled: false, curveSegments: 10 });
  const lip = new THREE.Mesh(lipGeo, hullMat); lip.rotation.x = -Math.PI / 2; lip.position.y = freeboard; g.add(lip);

  const deckY = freeboard + 1.1;
  if (cls === 'coaster' || cls === 'feeder') {
    // Aft superstructure + bridge + funnel
    const sw = B * 0.78, sd = L * (cls === 'feeder' ? 0.11 : 0.14), sh = cls === 'feeder' ? 14 : 9;
    const sz = L / 2 - L * 0.13;
    g.add(box(sw, sh, sd, superMat, 0, deckY + sh / 2, sz));
    g.add(box(sw * 1.08, 3.2, sd * 0.7, superMat, 0, deckY + sh + 1.6, sz - sd * 0.1));
    g.add(box(sw * 1.1, 1.2, 1.2, glassMat, 0, deckY + sh + 1.9, sz - sd * 0.45));
    g.add(cyl(1.4, 6, darkMat, 0, deckY + sh + 3, sz + sd * 0.2, 1.1));
    g.add(cyl(0.3, 12, darkMat, 0, deckY + sh + 8, sz - sd * 0.2)); // mast
    // Hatches / containers
    const holdStart = -L / 2 + L * 0.1, holdEnd = sz - sd / 2 - 3;
    if (cls === 'feeder') {
      const bays = Math.floor((holdEnd - holdStart) / 12.6), rows = Math.max(3, Math.floor(B / 2.6) - 2), tiers = 3;
      for (let b = 0; b < bays; b++) for (let r = 0; r < rows; r++) for (let t = 0; t < tiers; t++) {
        if (rnd() < 0.15) continue;
        const cm = new THREE.MeshStandardMaterial({ color: CONTAINER_COLORS[Math.floor(rnd() * CONTAINER_COLORS.length)], roughness: 0.7 });
        g.add(box(2.4, 2.5, 12, cm, (r - (rows - 1) / 2) * 2.6, deckY + 1.3 + t * 2.6, holdStart + 6.3 + b * 12.6));
      }
    } else {
      const nH = 3;
      const hl = (holdEnd - holdStart) / nH;
      for (let i = 0; i < nH; i++) g.add(box(B * 0.6, 1.6, hl * 0.82, deckMat, 0, deckY + 0.8, holdStart + hl * (i + 0.5)));
      for (let i = 0; i < 6; i++) { if (rnd() < 0.5) continue; const cm = new THREE.MeshStandardMaterial({ color: CONTAINER_COLORS[Math.floor(rnd() * CONTAINER_COLORS.length)], roughness: 0.7 }); g.add(box(2.4, 2.5, 6, cm, (i % 2 ? 1 : -1) * B * 0.18, deckY + 2.9, holdStart + 8 + Math.floor(i / 2) * 14)); }
      // deck crane
      g.add(cyl(0.9, 9, darkMat, B * 0.3, deckY + 4.5, holdStart + hl * 1.5));
      const boom = cyl(0.35, 14, darkMat, B * 0.3, deckY + 10, holdStart + hl * 1.5 - 5); boom.rotation.x = 1.1; g.add(boom);
    }
    g.add(cyl(0.25, 8, darkMat, 0, deckY + 4, -L / 2 + 4)); // foremast
  } else if (cls === 'trawler') {
    const sz = -L / 2 + L * 0.3;
    g.add(box(B * 0.7, 7, L * 0.22, superMat, 0, deckY + 3.5, sz));
    g.add(box(B * 0.72, 1.2, 1, glassMat, 0, deckY + 5.6, sz - L * 0.11 + 0.2));
    g.add(cyl(0.3, 9, darkMat, 0, deckY + 11, sz));
    g.add(cyl(0.8, 3.5, darkMat, 0, deckY + 8.5, sz + 2, 0.6));
    // stern gantry
    g.add(box(0.6, 8, 0.6, darkMat, -B * 0.35, deckY + 4, L / 2 - 6)); g.add(box(0.6, 8, 0.6, darkMat, B * 0.35, deckY + 4, L / 2 - 6));
    g.add(box(B * 0.75, 0.6, 0.6, darkMat, 0, deckY + 8, L / 2 - 6));
    const net = box(B * 0.5, 2.2, 6, new THREE.MeshStandardMaterial({ color: 0x8c6b3a, roughness: 1 }), 0, deckY + 1.1, L / 2 - 10); g.add(net);
  } else if (cls === 'ferry') {
    const sw = B * 0.9, sd = L * 0.78, sz = 2;
    for (let d = 0; d < 3; d++) {
      g.add(box(sw * (1 - d * 0.03), 3.6, sd * (1 - d * 0.08), superMat, 0, deckY + 1.8 + d * 3.6, sz + d * 2));
      g.add(box(sw * (1 - d * 0.03) + 0.1, 1.0, sd * (1 - d * 0.08) * 0.92, glassMat, 0, deckY + 2.4 + d * 3.6, sz + d * 2));
    }
    g.add(box(sw * 0.9, 2.8, L * 0.12, superMat, 0, deckY + 12.2, -L / 2 + L * 0.2));
    g.add(box(sw * 0.92, 1.0, L * 0.11, glassMat, 0, deckY + 12.6, -L / 2 + L * 0.2));
    g.add(cyl(2.2, 7, new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.6 }), 0, deckY + 14, L / 2 - L * 0.25, 1.6));
    g.add(cyl(0.3, 10, darkMat, 0, deckY + 18, -L / 2 + L * 0.2));
  } else if (cls === 'cutter') {
    const stripe = new THREE.MeshStandardMaterial({ color: 0x1b4f9c, roughness: 0.5 });
    g.add(box(B * 0.95, 0.9, L * 0.5, stripe, 0, freeboard - 1.0, 0));
    const sz = -L / 2 + L * 0.42;
    g.add(box(B * 0.7, 3.2, L * 0.3, superMat, 0, deckY + 1.6, sz));
    g.add(box(B * 0.6, 2.4, L * 0.16, superMat, 0, deckY + 4.4, sz - 1));
    g.add(box(B * 0.62, 0.9, L * 0.16 * 0.8, glassMat, 0, deckY + 4.8, sz - 1));
    g.add(cyl(0.2, 5, darkMat, 0, deckY + 8, sz)); g.add(box(2.6, 0.3, 0.3, darkMat, 0, deckY + 10.5, sz));
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 8), new THREE.MeshStandardMaterial({ color: 0x3366ff, emissive: 0x3366ff, emissiveIntensity: 2 }));
    beacon.position.set(0, deckY + 6.2, sz - 1); g.add(beacon); g.userData.beacon = beacon;
  }
  // Navigation lights
  const mk = (c, x, y, z) => { const m = new THREE.Mesh(new THREE.SphereGeometry(0.45, 8, 8), new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 2.5 })); m.position.set(x, y, z); return m; };
  g.add(mk(0xff2020, -B / 2 - 0.2, deckY + 3, -L * 0.1)); g.add(mk(0x20ff40, B / 2 + 0.2, deckY + 3, -L * 0.1)); g.add(mk(0xffffff, 0, deckY + 14, -L / 2 + L * 0.2));
  // Wake
  const wakeMat = new THREE.MeshBasicMaterial({ color: 0xeaf6ff, transparent: true, opacity: 0, depthWrite: false });
  const wakeGeo = new THREE.BufferGeometry();
  wakeGeo.setAttribute('position', new THREE.Float32BufferAttribute([-B * 0.6, 0.3, L * 0.45, B * 0.6, 0.3, L * 0.45, -B * 1.8, 0.3, L * 0.45 + L * 2.2, B * 1.8, 0.3, L * 0.45 + L * 2.2], 3));
  wakeGeo.setIndex([0, 2, 1, 1, 2, 3]);
  const wake = new THREE.Mesh(wakeGeo, wakeMat); g.add(wake);

  g.userData = {
    cls, length: L, beam: B, draft, freeboard, mats, wake,
    setWear(w) { for (const m of mats) m.userData.uniforms.uWear.value = w; },
    setFlood(f) { for (const m of mats) m.userData.uniforms.uFlood.value = f; },
    setWake(t) { wakeMat.opacity = THREE.MathUtils.clamp(t, 0, 1) * 0.35; },
  };
  if (name) { const l = makeLabel(name); l.position.set(0, deckY + 24, 0); g.add(l); g.userData.label = l; }
  return g;
}

export const CUTTER_CLASS = { cutter: { id: 'cutter', length: 28, beam: 6.5, draft: 2.2, freeboard: 2.4, hullColor: 0xf26b1d, maxKn: 30 } };

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
  const C = SHIP_CLASSES[cls] || SHIP_CLASSES.coaster;
  const g = new THREE.Group();
  const m = new THREE.MeshStandardMaterial({ color: 0x3a2a22, roughness: 0.95, metalness: 0.1 });
  const hull = box(C.beam, C.draft + 3, C.length * 0.55, m, 0, -C.draft * 0.6, 0);
  hull.rotation.z = 0.5; hull.rotation.x = 0.12; g.add(hull);
  const buoy = new THREE.Mesh(new THREE.SphereGeometry(1.6, 10, 10), new THREE.MeshStandardMaterial({ color: 0xffd400, emissive: 0x806000, emissiveIntensity: 0.6 }));
  buoy.position.set(C.beam, 1.2, 0); g.add(buoy);
  const l = makeLabel('WRECK', '#ffd400', 30); l.position.set(0, 16, 0); g.add(l);
  return g;
}
