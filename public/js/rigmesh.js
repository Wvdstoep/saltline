// Saltline sailing yachts — the 3D model: lofted hull, deck structures, spars, cloth sails, standing and running rigging,
// telltales (docs/SAILING-CONTRACT.md §4.1–§4.6). Geometry comes from yachtlooks.js (hull lines, deck layout, colours)
// and rigcore.js (sails, booms, gaffs, lines — pure); this file only turns it into three.js objects and animates them.
//
// buildYacht(cls, opts) → yacht {
//   group            THREE.Group in the ship frame (x starboard, y up from the waterline, z aft; bow at −L/2)
//   setRig(view, extra)  RigView { heel, sails: [{ id, hoist, reef, angle, state, tt }] } (+ extra { aws, flags, sides })
//   setSails(up, rel)    legacy: rel = relative wind (deg, any range; + / 0…180 = from starboard) → autoTrimView
//   update(dt, { camera, time, own, touch })  springs, cloth, LOD (call every frame; cheap when far)
//   dims, lights (COLREGS positions, ship.js ctx.lights shape), labelY, mats (wear-shaded hull materials), dispose()
// }
// Everything sits directly in `group` with an identity transform (static parts merged per material: few draw calls,
// and ship.js bakeShipPos works unchanged). Heel and seaway motion are applied by the caller to the whole group.
import * as THREE from 'three';
import { PartBuilder } from './models.js';
import { rigOf } from '../../shared/sail/rigs.js';
import { autoTrimView } from '../../shared/sail/trim.js';
import { hullStations, hullOf, looksOf, deckOf, sheerY, deckHalf, keelY, hullExtent, structures, structHalfAt, yachtDims, hullHalfAt, stemZ } from './yachtlooks.js';
import { rigBase, rigFrame, sailGrid, sailUVs, gridIndex, gridFor, standingRigging, stowedOf, springStep, springOmega, crashStep, mastRadius } from './rigcore.js';

const D2R = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const SHARED = (o) => { o.userData.shared = true; return o; };

// ------------------------------------------------------------------------------------------------ textures (cached)
const TEX = new Map();
function canvasTex(key, w, h, paint, { repeat = false } = {}) {
  let t = TEX.get(key); if (t) return t;
  const c = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  if (!c) return null;
  c.width = w; c.height = h;
  paint(c.getContext('2d'), w, h);
  t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  SHARED(t); TEX.set(key, t);
  return t;
}
const css = (hex) => '#' + (hex >>> 0).toString(16).padStart(6, '0');
// hull stripes: u = absolute height (−4…+4 m), v = depth below the sheer (0…6 m)
const HU = (y) => (y + 4) / 8, HV = (d) => clamp(d / 6, 0, 1);
function hullTexture(cls) {
  const H = hullOf(cls), K = looksOf(cls);
  return canvasTex('hull:' + cls, 512, 512, (g, w, h) => {
    g.fillStyle = css(K.hull); g.fillRect(0, 0, w, h);
    const X = (y) => HU(y) * w, Y = (d) => HV(d) * h;
    g.fillStyle = css(K.antifoul); g.fillRect(0, 0, X(0), h);
    g.fillStyle = css(K.bootTop); g.fillRect(X(0), 0, X(H.bootTop || 0.12) - X(0), h);
    if (K.band && H.band) { g.fillStyle = css(K.band); g.fillRect(X(0.2), Y(H.band[0]), w, Y(H.band[1]) - Y(H.band[0])); }
    if (K.cove && H.cove) { g.fillStyle = css(K.cove); g.fillRect(X(0.25), Y(H.cove - 0.025), w, Math.max(2, Y(H.cove + 0.025) - Y(H.cove - 0.025))); }
    // a thin gloss line at the sheer
    g.fillStyle = 'rgba(255,255,255,0.10)'; g.fillRect(X(0.3), 0, w, 2);
  });
}
function deckTexture(cls) {
  const K = looksOf(cls);
  return canvasTex('deck:' + cls, 256, 256, (g, w, h) => {
    g.fillStyle = css(K.deck); g.fillRect(0, 0, w, h);
    if (K.deckKind === 'teak') {           // planks along the ship (texture v = z), black caulking every 0.125 m (1 m = 256 px / 2)
      for (let i = 0; i < 16; i++) {
        const x = (i * w) / 16; g.fillStyle = `rgba(0,0,0,${0.55})`; g.fillRect(x, 0, 1.4, h);
        g.fillStyle = `rgba(${i % 3 === 0 ? '255,240,210' : '60,35,10'},0.06)`; g.fillRect(x + 1.4, 0, w / 16 - 1.4, h);
      }
      for (let i = 0; i < 6; i++) { g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(((i * 37) % 16) * (w / 16), (i * 97) % h, w / 16, 1); }
    } else {                               // non-slip diamond pattern
      g.fillStyle = 'rgba(0,0,0,0.05)';
      for (let y = 0; y < h; y += 6) for (let x = (y / 6) % 2 ? 3 : 0; x < w; x += 6) g.fillRect(x, y, 2, 2);
    }
  }, { repeat: true });
}
/** Sail cloth texture (u = luff → leech, v = foot → head; canvas y is flipped): seams, tapes, battens, number, UV strip. */
function sailTexture(cls, kind) {
  const K = looksOf(cls);
  return canvasTex(`sail:${cls}:${kind}`, 512, 512, (g, w, h) => {
    const X = (u) => u * w, Y = (v) => (1 - v) * h;
    g.fillStyle = css(K.sail); g.fillRect(0, 0, w, h);
    const seam = cls === 'schooner' ? 'rgba(90,60,25,0.30)' : 'rgba(0,0,0,0.10)';
    g.strokeStyle = seam; g.lineWidth = cls === 'schooner' ? 2 : 1.5;
    if (K.sailcut === 'cross' || kind === 'gaff') {
      const n = kind === 'gaff' ? 18 : 12;
      for (let i = 1; i < n; i++) { g.beginPath(); g.moveTo(0, Y(i / n)); g.lineTo(w, Y(i / n - 0.03)); g.stroke(); }
      if (cls === 'schooner') { g.globalAlpha = 0.05; for (let i = 0; i < 40; i++) { g.fillStyle = i % 2 ? '#000' : '#fff'; g.fillRect(0, Y((i + 0.5) / 40), w, h / 80); } g.globalAlpha = 1; }
    } else {                                // tri-radial: from the head (u = const lines) and the clew
      for (let i = 1; i < 9; i++) { g.beginPath(); g.moveTo(X(i / 9), Y(1)); g.lineTo(X(i / 9), Y(0.62)); g.stroke(); }
      for (let i = 1; i < 8; i++) { g.beginPath(); g.moveTo(X(1), Y(0)); g.lineTo(X(0.55), Y(i / 8 * 0.6)); g.stroke(); }
      for (let i = 1; i < 6; i++) { g.beginPath(); g.moveTo(0, Y(0.28 + i * 0.065)); g.lineTo(w, Y(0.28 + i * 0.065)); g.stroke(); }
    }
    // luff / leech / foot tapes (boltropes on the classic canvas)
    g.fillStyle = cls === 'schooner' ? css(K.sailAccent) : 'rgba(0,0,0,0.10)';
    g.fillRect(0, 0, X(0.012), h); g.fillRect(X(0.988), 0, X(0.012), h); g.fillRect(0, Y(0.012), w, h * 0.012);
    if ((kind === 'main' || kind === 'mizzen') && K.battens) {
      g.fillStyle = 'rgba(0,0,0,0.13)';
      const full = cls === 'catamaran';
      const vs = full ? [0.14, 0.28, 0.42, 0.56, 0.7, 0.84] : [0.2, 0.4, 0.6, 0.8];
      for (const v of vs) g.fillRect(full ? X(0.02) : X(0.72), Y(v) - 3, full ? X(0.97) : X(0.27), 6);
    }
    if (kind === 'head' && cls === 'sloop') {   // navy UV strip along the leech and the foot (shows when rolled up)
      g.fillStyle = css(K.sailAccent); g.fillRect(X(0.9), 0, X(0.1), h); g.fillRect(0, Y(0.07), w, h * 0.07);
    }
    if (kind === 'main' && K.sailNo) {
      g.fillStyle = css(cls === 'catamaran' ? K.sailAccent : 0x1e3f73); g.font = '700 60px system-ui, sans-serif'; g.textAlign = 'center';
      g.save(); g.translate(X(0.42), Y(0.58)); g.scale(-1.25, 1.0); g.fillText(K.sailNo, 0, 0); g.restore();   // mirrored in u: reads right from starboard (bow to the right)
      if (cls === 'sloop' || cls === 'ketch') {  // class insignia: a small wave mark above the number
        g.strokeStyle = g.fillStyle; g.lineWidth = 6; g.beginPath(); g.arc(X(0.38), Y(0.74), 26, Math.PI * 1.1, Math.PI * 1.9); g.stroke();
      }
    }
    if (kind === 'code0') { g.fillStyle = css(K.sailAccent); g.fillRect(X(0.93), 0, X(0.07), h); }
  });
}
function netTexture() {
  return canvasTex('net', 128, 128, (g, w, h) => {
    g.clearRect(0, 0, w, h); g.strokeStyle = 'rgba(20,24,28,1)'; g.lineWidth = 3;
    for (let i = 0; i <= 8; i++) { g.beginPath(); g.moveTo((i * w) / 8, 0); g.lineTo((i * w) / 8, h); g.stroke(); g.beginPath(); g.moveTo(0, (i * h) / 8); g.lineTo(w, (i * h) / 8); g.stroke(); }
  }, { repeat: true });
}

// ------------------------------------------------------------------------------------------------ materials (cached per class)
const MATS = new Map();
function classMats(cls) {
  let m = MATS.get(cls); if (m) return m;
  const K = looksOf(cls);
  const std = (color, o = {}) => SHARED(new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.1, ...o }));
  m = {
    deck: std(0xffffff, { map: deckTexture(cls), roughness: 0.9, metalness: 0 }),
    house: std(K.house, { roughness: cls === 'schooner' ? 0.4 : 0.55 }),
    trim: std(K.trim, { roughness: 0.4 }),
    cockpit: std(K.cockpit, { roughness: 0.85, metalness: 0 }),
    spar: std(K.spar, { roughness: cls === 'schooner' ? 0.45 : 0.35, metalness: cls === 'sloop' ? 0.6 : cls === 'catamaran' ? 0.3 : 0.05 }),
    masthead: std(K.masthead, { roughness: 0.5 }),
    metal: std(K.metal, { roughness: 0.3, metalness: cls === 'schooner' ? 0.2 : 0.85 }),
    iron: std(K.iron, { roughness: 0.5, metalness: 0.4 }),
    dark: std(0x1a1d21, { roughness: 0.6, metalness: 0.2 }),
    canvas: std(K.canvas, { roughness: 0.95, metalness: 0 }),
    window: std(K.window, { roughness: 0.15, metalness: 0.6 }),
    bulwark: std(K.bulwark || K.house, { roughness: 0.5 }),
    gold: std(K.cove || 0xd2ab45, { roughness: 0.35, metalness: 0.7 }),
    keel: std(K.antifoul, { roughness: 0.8 }),
    hullPlain: std(K.hull, { roughness: 0.4 }),
    bulb: std(0x2a2d31, { roughness: 0.7, metalness: 0.3 }),
    tramp: SHARED(new THREE.MeshStandardMaterial({ color: K.tramp || 0x15181b, map: netTexture(), transparent: true, alphaTest: 0.3, side: THREE.DoubleSide, roughness: 1, metalness: 0 })),
    sails: {},
    line: SHARED(new THREE.LineBasicMaterial({ color: cls === 'schooner' ? 0x2b261f : 0x3a3f45, transparent: true, opacity: 0.85 })),
    rope: SHARED(new THREE.LineBasicMaterial({ color: K.rope })),
    wire: std(cls === 'schooner' ? 0x2b261f : 0x9aa1a8, { roughness: 0.4, metalness: 0.7 }),
    ropeMesh: std(K.rope, { roughness: 0.9, metalness: 0 }),
    tell: SHARED(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })),
    sailPlain: std(K.sail, { side: THREE.DoubleSide, roughness: 0.85, metalness: 0, emissive: new THREE.Color(K.sail).multiplyScalar(0.1) }),
    reefPt: SHARED(new THREE.PointsMaterial({ color: 0x30343a, size: 0.07, sizeAttenuation: true })),
  };
  for (const kind of ['main', 'mizzen', 'head', 'gaff', 'code0']) {
    m.sails[kind] = std(0xffffff, { map: sailTexture(cls, kind), side: THREE.DoubleSide, roughness: 0.85, metalness: 0, emissive: new THREE.Color(K.sail).multiplyScalar(0.07) });
  }
  MATS.set(cls, m);
  return m;
}
const sailKind = (s) => (s.type === 'code0' ? 'code0' : s.type === 'mizzen' ? 'mizzen' : s.kind === 'head' ? 'head' : s.kind === 'gaff' || s.kind === 'top' ? 'gaff' : 'main');

// ------------------------------------------------------------------------------------------------ hull
/** Lofted hull (both sides + transom) for one hull centred at x = dx. */
function hullGeometry(cls, dx = 0, nSt = 44, nPt = 18) {
  const st = hullStations(cls, nSt, nPt);
  const pos = [], uv = [], idx = [];
  const pushV = (x, y, z) => { pos.push(x, y, z); uv.push(HU(y), HV(sheerY(cls, z) - y)); return pos.length / 3 - 1; };
  for (const side of [1, -1]) {
    const base = pos.length / 3;
    for (const s of st) for (const [x, y, z] of s.pts) pushV(dx + side * x, y, z);
    const n = nPt + 1;
    for (let i = 0; i < st.length - 1; i++) for (let j = 0; j < nPt; j++) {
      const a = base + i * n + j, b = a + 1, c = a + n, d = c + 1;
      if (side > 0) idx.push(a, b, c, b, d, c); else idx.push(a, c, b, b, c, d);   // outward faces
    }
  }
  // transom face
  const t = st[st.length - 1].pts, b0 = pos.length / 3;
  for (const [x, y, z] of t) { pushV(dx + x, y, z); pushV(dx - x, y, z); }
  for (let j = 0; j < t.length - 1; j++) { const a = b0 + 2 * j, b = a + 1, c = a + 2, d = a + 3; idx.push(a, c, b, b, c, d); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
/** Deck surface between the sheer lines with camber; holes for cockpit wells (sole drawn separately). */
function deckGeometry(cls, dx = 0, holes = [], nz = 60, lite = false) {
  const H = hullOf(cls), ext = hullExtent(cls);
  const zs = [];
  for (let i = 0; i <= nz; i++) { const t = i / nz, u = 1 - Math.cos((t * Math.PI) / 2); zs.push(-H.L / 2 + 0.002 + (ext.zDeckEnd - 0.002 + H.L / 2) * (0.4 * t + 0.6 * u)); }
  for (const h of holes) zs.push(h.z0, h.z1);
  zs.sort((a, b) => a - b);
  const pos = [], uv = [], idx = [], cols = lite ? 3 : 6;
  const row = (z) => {
    const hb = deckHalf(cls, z), ys = sheerY(cls, z), hole = holes.find((h) => z >= h.z0 - 1e-6 && z <= h.z1 + 1e-6);
    const w = hole ? Math.min(hole.half, hb - 0.15) : 0;
    const xs = lite ? [-hb, 0, hb] : [-hb, -lerp(hb, w, 0.5), -w, w, lerp(hb, w, 0.5), hb];
    return xs.map((x) => { const y = ys + H.camber * (1 - (x / Math.max(hb, 0.01)) ** 2); return [dx + x, y, z]; });
  };
  const rows = zs.map(row);
  for (const r of rows) for (const [x, y, z] of r) { pos.push(x, y + 0.004, z); uv.push(x / 2, z / 2); }
  for (let i = 0; i < rows.length - 1; i++) {
    const za = zs[i], zb = zs[i + 1], zm = (za + zb) / 2;
    const inHole = holes.some((h) => zm > h.z0 && zm < h.z1);
    for (let j = 0; j < cols - 1; j++) {
      if (inHole && j === 2 && !lite) continue;
      const a = i * cols + j, b = a + 1, c = a + cols, d = c + 1;
      idx.push(a, c, b, b, c, d);                          // facing up
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
/** Vertical strip along the sheer from y0 to y1 above it (bulwarks, toe rails); inset = how far inboard (m). */
function sheerStrip(cls, dx, h0, h1, inset, side, step = 0.5, face = side) {
  const H = hullOf(cls), ext = hullExtent(cls), pos = [], idx = [];
  const zs = []; for (let z = -H.L / 2 + 0.3; z < ext.zDeckEnd; z += step) zs.push(z); zs.push(ext.zDeckEnd - 0.02);
  for (const z of zs) { const hb = Math.max(0, deckHalf(cls, z) - inset), ys = sheerY(cls, z); pos.push(dx + side * hb, ys + h0, z, dx + side * hb, ys + h1, z); }
  for (let i = 0; i < zs.length - 1; i++) { const a = 2 * i; if (face > 0) idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); else idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  return g.toNonIndexed();
}
/** A deck house: tapered, crowned, sides leaning inboard, front raked. */
function houseGeometry(z0, z1, halfFwd, halfAft, yBase, top, { lean = 0.1, rake = 0.25, crown = 0.05 } = {}) {
  const g = new THREE.BoxGeometry(1, 1, 1, 4, 1, 1), p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const t = z + 0.5, isTop = y > 0;
    let zz = lerp(z0, z1, t);
    if (isTop && t < 0.01) zz += rake;
    const hw = lerp(halfFwd, halfAft, clamp((zz - z0) / (z1 - z0), 0, 1)) * (isTop ? 1 - lean : 1);
    const yy = isTop ? top + crown * (1 - 4 * x * x) : yBase;
    p.setXYZ(i, x * 2 * hw, yy, zz);
  }
  const ng = g.toNonIndexed(); g.dispose(); ng.computeVertexNormals();
  return ng;
}

// ------------------------------------------------------------------------------------------------ helpers
const _up = new THREE.Vector3(0, 1, 0), _d = new THREE.Vector3(), _q = new THREE.Quaternion();
/** Place a unit cylinder mesh (radius 1, height 1, y axis) between a and b with radius r. */
function placeRod(mesh, a, b, r) {
  _d.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const l = _d.length(); if (l < 1e-5) { mesh.visible = false; return; }
  mesh.visible = true;
  mesh.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  mesh.quaternion.setFromUnitVectors(_up, _d.multiplyScalar(1 / l));
  mesh.scale.set(r, l, r);
}
const UNIT_CYL = SHARED(new THREE.CylinderGeometry(1, 1, 1, 10, 1));
const UNIT_CYL6 = SHARED(new THREE.CylinderGeometry(1, 1, 1, 6, 1));

// ------------------------------------------------------------------------------------------------ static model
function buildStatic(cls, ctx) {
  const { g, pb, M, hullMats } = ctx;
  const H = hullOf(cls), D = deckOf(cls), K = looksOf(cls), R = rigOf(cls), sp = R.spars, ext = hullExtent(cls);
  const cat = cls === 'catamaran', hx = cat ? H.hullX : 0, xs = cat ? [-hx, hx] : [0];
  const deckAt = (x, z) => sheerY(cls, z) + H.camber * (1 - (x / Math.max(deckHalf(cls, z), 0.01)) ** 2);
  // ---- hulls and decks
  const wells = cat ? [] : D.structures.filter((s) => s.kind === 'cockpit');
  for (const dx of xs) {
    const hull = new THREE.Mesh(hullGeometry(cls, dx), hullMats.hull); hull.name = 'hull'; g.add(hull);
    const deck = new THREE.Mesh(deckGeometry(cls, dx, wells), M.deck); deck.name = 'deck'; g.add(deck);
    // toe rail / bulwark
    if (H.bulwark) {
      for (const sd of [-1, 1]) {
        pb.geo(sheerStrip(cls, dx, -0.05, H.bulwark, 0, sd), hullMats.hull);
        pb.geo(sheerStrip(cls, dx, 0, H.bulwark, 0.09, sd, 0.5, -sd), M.bulwark);
      }
      // caprail: flat varnished plank on the bulwark
      const zs = []; for (let z = -H.L / 2 + 0.35; z < ext.zDeckEnd; z += 0.6) zs.push(z); zs.push(ext.zDeckEnd - 0.03);
      for (const sd of [-1, 1]) for (let i = 0; i < zs.length - 1; i++) {
        const za = zs[i], zb = zs[i + 1], xa = deckHalf(cls, za) - 0.03, xb = deckHalf(cls, zb) - 0.03;
        pb.rod(sd * xa, sheerY(cls, za) + H.bulwark + 0.04, za, sd * xb, sheerY(cls, zb) + H.bulwark + 0.04, zb, 0.08, M.trim, 4);
      }
    } else {
      for (const sd of [-1, 1]) pb.geo(sheerStrip(cls, dx, -0.02, H.toeRail || 0.04, 0.01, sd, 0.4), cat ? hullMats.hull : M.trim);
    }
  }
  // ---- appendages: keel(s), rudder(s)
  const kl = sp.keel;
  const finShape = (pts, thick, x, mat) => {
    const s = new THREE.Shape(); s.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]); s.closePath();
    const geo = new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: true, bevelThickness: thick * 0.35, bevelSize: thick * 0.35, bevelSegments: 1, curveSegments: 4 });
    geo.translate(0, 0, -thick / 2); geo.rotateY(-Math.PI / 2);    // shape x → z, extrude along x
    pb.geo(geo, mat, x, 0, 0);
  };
  if (kl.kind === 'fin-bulb') {
    const le0 = kl.le, sw = Math.tan(kl.sweep * D2R) * (kl.y0 - kl.y1), le1 = le0 + sw;
    finShape([[le0, keelY(cls, le0) + 0.15], [le0 + kl.rootChord, keelY(cls, le0 + kl.rootChord) + 0.15], [le1 + kl.tipChord, kl.y1], [le1, kl.y1]], 0.11, 0, M.keel);
    const bz = le1 + kl.tipChord * 0.45, r = (kl.bulb.y0 - kl.bulb.y1) / 2;
    pb.geo(new THREE.CapsuleGeometry(r, kl.bulb.len - 2 * r, 4, 10), M.bulb, 0, (kl.bulb.y0 + kl.bulb.y1) / 2, bz, Math.PI / 2, 0, 0);
  } else if (kl.kind === 'long-fin') {
    finShape([[kl.z0, keelY(cls, kl.z0) + 0.2], [kl.z1, keelY(cls, kl.z1) + 0.2], [kl.z1 - 0.6, kl.y1], [kl.z0 + 0.7, kl.y1]], 0.22, 0, M.keel);
  } else if (kl.kind === 'mini-keels') {
    for (const dx of xs) { const z0 = kl.z - kl.chord / 2, z1 = kl.z + kl.chord / 2, yb = keelY(cls, kl.z); finShape([[z0 - 0.4, yb + 0.12], [z1, yb + 0.12], [z1 - 0.15, yb - kl.depth], [z0 + 0.25, yb - kl.depth]], 0.16, dx, M.keel); }
  } else if (kl.kind === 'full') {
    const pts = [];
    for (let z = -12.6; z <= 11.9; z += 0.7) pts.push([z, keelY(cls, z) + 0.3]);
    pts.push([11.9, keelY(cls, 11.9) + 0.3], [11.6, -3.3], [8, kl.y1], [-4, -3.4], [-8.5, -3.2], [-10.4, -2.55], [-12.6, -0.55]);
    finShape(pts, 0.5, 0, M.keel);
  }
  for (const rd of sp.rudders) {
    const rx = rd.mirror ? [-rd.x, rd.x] : [0];
    for (const x of rx) {
      if (rd.kind === 'spade') {
        const span = rd.span || Math.sqrt((rd.area || 0.45) * 2.1), chord = rd.chord || (rd.area || 0.45) / span, yt = keelY(cls, rd.z) - 0.02;
        finShape([[rd.z - chord * 0.3, yt], [rd.z + chord * 0.7, yt], [rd.z + chord * 0.6, yt - span], [rd.z - chord * 0.2, yt - span * 0.97]], 0.06, x, M.keel);
      } else if (rd.kind === 'skeg') {
        const yt = keelY(cls, rd.z0);
        finShape([[rd.z0 - 0.9, yt + 0.25], [rd.z0 + 0.35, yt + 0.25], [rd.z0 + 0.35, -1.45], [rd.z0 + 0.1, -1.45]], 0.14, 0, M.keel);
        finShape([[rd.z0 + 0.42, keelY(cls, rd.z0 + 0.4) + 0.1], [rd.z1, keelY(cls, rd.z1) + 0.1], [rd.z1 - 0.05, -1.5], [rd.z0 + 0.42, -1.5]], 0.08, 0, M.keel);
      } else if (rd.kind === 'sternpost') {
        finShape([[11.95, keelY(cls, 11.95) + 0.6], [12.85, keelY(cls, 12.85) + 0.3], [12.75, -3.0], [11.95, -3.2]], 0.2, 0, M.keel);
      }
    }
  }
  // ---- cat bridge deck, trampoline, crossbeam, nacelle
  if (cat) {
    const b = D.bridge, sh = new THREE.Shape(), N = 18;
    const outer = () => hx;                                          // between the hull centres (the hulls carry the side decks)
    sh.moveTo(-outer(b.z0), b.z0);
    for (let i = 0; i <= N; i++) { const z = lerp(b.z0, b.z1, i / N); sh.lineTo(outer(z), z); }
    for (let i = N; i >= 0; i--) { const z = lerp(b.z0, b.z1, i / N); sh.lineTo(-outer(z), z); }
    void sh;
    const geo = new THREE.ExtrudeGeometry(sh, { depth: b.top - b.under, bevelEnabled: false });
    geo.rotateX(Math.PI / 2); geo.translate(0, b.top, 0);             // shape (x, z) → extrude down from the top
    { const bd = new THREE.Mesh(geo, M.hullPlain); bd.name = 'bridgedeck'; bd.userData.keepWhileWalking = true; g.add(bd); }
    const top = new THREE.PlaneGeometry(2 * hx, b.z1 - b.z0 - 0.05, 1, 1); top.rotateX(-Math.PI / 2);
    const tg = new THREE.Mesh(top, M.deck); tg.position.set(0, b.top + 0.006, (b.z0 + b.z1) / 2 + 0.05); g.add(tg);
    const tr = D.structures.find((s) => s.kind === 'trampoline');
    const tp = new THREE.PlaneGeometry(2 * (hx - 0.55), tr.z1 - tr.z0, 1, 1); tp.rotateX(-Math.PI / 2);
    const uvs = tp.attributes.uv; for (let i = 0; i < uvs.count; i++) uvs.setXY(i, uvs.getX(i) * 2 * (hx - 0.55) * 3, uvs.getY(i) * (tr.z1 - tr.z0) * 3);
    const tm = new THREE.Mesh(tp, M.tramp); tm.position.set(0, tr.top, (tr.z0 + tr.z1) / 2); g.add(tm);
    pb.rod(-hx, 1.55, tr.z0, hx, 1.55, tr.z0, 0.09, hullMats.hull, 8);                  // forward crossbeam
    pb.box(0.3, 0.25, 0.4, M.dark, 0, 1.75, tr.z0);                                     // forestay fitting
    // black window strips on the outer hull sides, stepped transoms
    for (const sd of [-1, 1]) {
      const z0 = -1.6, z1 = 3.4, zc = (z0 + z1) / 2, x = sd * (hx + hullHalfAt(cls, zc, 1.3) + 0.01);
      pb.box(0.02, 0.2, z1 - z0, M.window, x, 1.3, zc);
      for (const zz of [-3.0, 4.6]) pb.box(0.02, 0.12, 0.7, M.window, sd * (hx + hullHalfAt(cls, zz, 1.15) + 0.01), 1.15, zz);
      pb.box(1.0, 0.06, 0.45, M.deck, sd * hx, 0.55, 6.85); pb.box(1.1, 0.06, 0.45, M.deck, sd * hx, 0.95, 6.5);
    }
  }
  // ---- deck structures
  for (const s of D.structures) {
    const zc = (s.z0 + s.z1) / 2;
    const base = cat ? D.bridge.top - 0.02 : Math.min(deckAt(0, s.z0), deckAt(0, s.z1)) - 0.08;
    if (s.kind === 'coachroof' || s.kind === 'doghouse' || s.kind === 'house') {
      const hw0 = s.halfFwd ?? s.half, hw1 = s.half;
      pb.geo(houseGeometry(s.z0, s.z1, hw0, hw1, base, s.top - 0.05, { lean: s.kind === 'house' ? 0.03 : 0.1, rake: s.kind === 'house' ? 0 : 0.18, crown: 0.05 }), s.kind === 'house' || cls === 'schooner' ? M.house : M.house);
      pb.geo(houseGeometry(s.z0 - 0.03, s.z1 + 0.03, hw0 + 0.03, hw1 + 0.03, s.top - 0.07, s.top, { lean: 0.1, rake: 0.18, crown: 0.05 }), cls === 'schooner' ? M.trim : M.house);
      if (s.windows) for (const sd of [-1, 1]) {
        const wz0 = s.z0 + 0.35, wz1 = s.z1 - 0.3, hwm = lerp(hw0, hw1, 0.5), yw = lerp(base, s.top, 0.68);
        const n = s.kind === 'doghouse' ? 2 : 3, len = (wz1 - wz0) / n;
        for (let i = 0; i < n; i++) pb.box(0.03, (s.top - base) * 0.22, len * 0.8, M.window, sd * (hwm * (1 - 0.1 * 0.68) + 0.012), yw, wz0 + len * (i + 0.5), 0, 0, sd * -0.1);
        if (s.kind === 'doghouse') pb.box(hw1 * 1.5, (s.top - base) * 0.3, 0.03, M.window, 0, yw, s.z0 + 0.1, -0.18, 0, 0);
      }
      if (s.skylight) { pb.geo(houseGeometry(zc - 0.7, zc + 0.7, 0.6, 0.6, s.top - 0.05, s.top + 0.45, { lean: 0.35, rake: 0, crown: 0 }), M.trim); pb.box(0.9, 0.04, 1.2, M.window, 0, s.top + 0.3, zc); }
    } else if (s.kind === 'sprayhood') {
      const geo = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true, -Math.PI / 2, Math.PI);
      geo.rotateZ(Math.PI / 2);
      pb.geo(geo, M.canvas, 0, deckAt(0, s.z1) + 0.62, s.z1 - 0.05, 0, Math.PI / 2, 0, s.half, s.top - deckAt(0, s.z1) - 0.35, 0.9);
    } else if (s.kind === 'cockpit') {
      const yd = deckAt(0, s.z0), w = s.half, z0 = s.z0, z1 = s.z1;
      pb.box(2 * w, 0.04, z1 - z0, M.cockpit, 0, s.sole, (z0 + z1) / 2);                       // sole
      for (const sd of [-1, 1]) {
        pb.box(0.04, yd - s.sole + 0.02, z1 - z0, M.house, sd * w, (yd + s.sole) / 2, (z0 + z1) / 2);   // well sides
        pb.box(0.42, 0.06, (z1 - z0) * 0.86, M.cockpit, sd * (w - 0.23), s.sole + 0.42, (z0 + z1) / 2 - (z1 - z0) * 0.05);    // seats
        pb.box(0.42, 0.42, (z1 - z0) * 0.86, M.house, sd * (w - 0.23), s.sole + 0.21, (z0 + z1) / 2 - (z1 - z0) * 0.05);
        pb.box(0.05, s.coaming - yd, (z1 - z0) * 0.8, cls === 'schooner' ? M.trim : M.house, sd * (w + 0.03), (s.coaming + yd) / 2, (z0 + z1) / 2 - (z1 - z0) * 0.1);   // coamings
      }
      pb.box(2 * w, yd - s.sole, 0.04, M.house, 0, (yd + s.sole) / 2, z0);
      if (cls !== 'sloop') pb.box(2 * w, yd - s.sole, 0.04, M.house, 0, (yd + s.sole) / 2, z1);
    } else if (s.kind === 'saloon') {
      pb.geo(houseGeometry(s.z0, s.z1, s.half - 0.3, s.half, base, s.top - 0.06, { lean: 0.06, rake: s.rake || 0.6, crown: 0.06 }), M.house);
      pb.geo(houseGeometry(s.z0 + (s.rake || 0.6) - 0.05, s.z1 + 0.05, s.half - 0.2, s.half + 0.05, s.top - 0.08, s.top, { lean: 0, rake: 0, crown: 0.06 }), M.house);
      // raked windscreen + side windows (black glass band)
      pb.box(2 * (s.half - 0.45), 0.75, 0.03, M.window, 0, base + 1.35, s.z0 + (s.rake || 0.6) * 0.62, -Math.atan2(s.rake || 0.6, s.top - base) * 0.9, 0, 0);
      for (const sd of [-1, 1]) pb.box(0.03, 0.75, (s.z1 - s.z0) * 0.62, M.window, sd * (s.half - 0.08), base + 1.4, zc + 0.15, 0, 0, sd * -0.06);
      pb.box(0.9, 1.9, 0.03, M.window, -0.5, base + 0.95, s.z1 + 0.01);                       // aft sliding door
    } else if (s.kind === 'hardtop') {
      pb.box(2 * s.half, s.thick, s.z1 - s.z0, M.house, 0, s.top - s.thick / 2, zc);
      for (const sd of [-1, 1]) pb.rod(sd * (s.half - 0.15), D.bridge.top, s.z1 - 0.12, sd * (s.half - 0.15), s.top - s.thick, s.z1 - 0.12, 0.05, M.metal, 8);
    } else if (s.kind === 'windlass') {
      pb.box(0.9, 0.5, 0.7, M.dark, 0, deckAt(0, zc) + 0.25, zc); pb.cyl(0.18, 1.6, M.dark, 0, deckAt(0, zc) + 0.42, zc, 0.18, 10, 0, 0, Math.PI / 2);
    }
  }
  for (const [z, top, w] of D.hatches || []) pb.box(w, 0.08, w, M.trim, 0, top + 0.03, z), pb.box(w * 0.86, 0.02, w * 0.86, M.window, 0, top + 0.08, z);
  // ---- steering
  const wh = sp.wheel;
  if (wh.kind === 'pedestal') {
    const [x, y, z] = wh.at, yd = cls === 'sloop' ? 0.85 : 1.42;
    pb.cyl(0.07, y - yd, M.metal, x, (y + yd) / 2, z + 0.05, 0.06, 10);
    pb.sphere(0.13, M.dark, x, y + 0.25, z - 0.12, 10);                                       // binnacle compass
    pb.geo(new THREE.TorusGeometry(wh.r, 0.022, 6, 28), M.metal, x, y, z);
    for (let k = 0; k < 3; k++) { const a = (k * 2 * Math.PI) / 3; pb.rod(x, y, z, x + Math.cos(a) * wh.r, y + Math.sin(a) * wh.r, z, 0.012, M.metal, 4); }
  } else if (wh.kind === 'bulkhead') {
    const [x, y, z] = wh.at;
    pb.box(1.1, 1.0, 0.25, M.house, x, y - 0.35, z + 0.35);
    pb.geo(new THREE.TorusGeometry(wh.r, 0.02, 6, 24), M.metal, x, y, z + 0.2);
    for (let k = 0; k < 3; k++) { const a = (k * 2 * Math.PI) / 3; pb.rod(x, y, z + 0.2, x + Math.cos(a) * wh.r, y + Math.sin(a) * wh.r, z + 0.2, 0.012, M.metal, 4); }
    pb.box(0.8, 0.12, 0.45, M.cockpit, x, 2.2, z + 0.95);                                      // helm seat
  } else if (wh.kind === 'spoked') {
    const [x, y, z] = wh.at, yd = deckAt(0, z);
    pb.box(0.5, y - yd - 0.15, 0.6, M.trim, x, (y + yd) / 2 - 0.1, z + 0.3);                 // wheel box
    pb.geo(new THREE.TorusGeometry(wh.r, 0.035, 6, 32), M.trim, x, y, z);
    for (let k = 0; k < 8; k++) { const a = (k * Math.PI) / 4; pb.rod(x, y, z, x + Math.cos(a) * (wh.r + 0.14), y + Math.sin(a) * (wh.r + 0.14), z, 0.018, M.trim, 4); }
    pb.cyl(0.09, 0.12, M.gold, x, y, z, 0.09, 10, Math.PI / 2, 0, 0);
  }
  // ---- deck hardware: winches, traveller tracks, genoa tracks, cleats
  for (const w of sp.winches) for (const sd of w.mirror ? [-1, 1] : [1]) {
    const [x, y, z] = w.at; pb.cyl(0.085, 0.16, M.metal, sd * x, y + 0.08, z, 0.07, 12); pb.cyl(0.05, 0.05, M.dark, sd * x, y + 0.185, z, 0.05, 10);
  }
  for (const t of sp.travellers) {
    if (t.horse) { pb.rod(-t.half, t.y + 0.25, t.z, t.half, t.y + 0.25, t.z, 0.035, M.metal, 6); for (const sd of [-1, 1]) pb.rod(sd * t.half, t.y - 0.1, t.z, sd * t.half, t.y + 0.25, t.z, 0.04, M.metal, 6); }
    else pb.box(2 * t.half, 0.05, 0.08, M.metal, 0, t.y + 0.02, t.z);
  }
  for (const ld of sp.leads) {
    if (ld.track && ld.track.x !== undefined) for (const sd of [-1, 1]) pb.box(0.04, 0.03, ld.track.z1 - ld.track.z0, M.metal, sd * ld.track.x, deckAt(ld.track.x, (ld.track.z0 + ld.track.z1) / 2) + 0.015, (ld.track.z0 + ld.track.z1) / 2);
    if (ld.track && ld.selfTack) pb.box(2 * ld.track.half, 0.05, 0.07, M.metal, 0, ld.track.y + 0.02, ld.track.z);
  }
  // ---- lifelines, pulpit, pushpit, stanchions (yachts) — wires as thin rods, 0.65 m high
  if (D.lifelines) {
    for (const dx of xs) for (const sd of [-1, 1]) {
      if (cat && sd * dx < 0) continue;                  // cat: lifelines on the outer sides only
      const z0 = -H.L / 2 + (cat ? 1.0 : 1.4), z1 = ext.zDeckEnd - (cat ? 0.9 : 0.6), n = Math.max(2, Math.round((z1 - z0) / 2.0));
      let prev = null;
      for (let i = 0; i <= n; i++) {
        const z = lerp(z0, z1, i / n), x = dx + sd * (deckHalf(cls, z) - 0.08), y = sheerY(cls, z) + 0.04;
        pb.rod(x, y, z, x, y + 0.66, z, 0.013, M.metal, 5);
        if (prev) { pb.rod(prev[0], prev[1] + 0.64, prev[2], x, y + 0.64, z, 0.005, M.metal, 4); pb.rod(prev[0], prev[1] + 0.34, prev[2], x, y + 0.34, z, 0.005, M.metal, 4); }
        prev = [x, y, z];
      }
    }
    if (D.pulpit) {
      const zb = -H.L / 2 + (cls === 'ketch' ? 0.2 : 0.35), y0 = sheerY(cls, zb);
      if (cls === 'ketch') {                                      // bowsprit platform with its own pulpit
        const bs = sp.bowsprit; pb.box(0.45, 0.07, 1.6, M.trim, 0, bs.from[1] + 0.02, (bs.from[2] + bs.to[2]) / 2 + 0.2);
        for (const sd of [-1, 1]) { pb.rod(sd * 0.3, bs.from[1], -7.6, sd * 0.3, bs.from[1] + 0.68, -8.4, 0.016, M.metal, 5); pb.rod(sd * 0.3, bs.from[1] + 0.68, -8.4, 0, bs.to[1] + 0.68, bs.to[2] + 0.1, 0.016, M.metal, 5); }
      } else for (const dx of xs) {
        for (const sd of [-1, 1]) { const x = dx + sd * Math.max(0.25, deckHalf(cls, zb + 1.0) - 0.15); pb.rod(x, y0, zb + 1.0, x, y0 + 0.7, zb + 0.6, 0.016, M.metal, 5); pb.rod(x, y0 + 0.7, zb + 0.6, dx, y0 + 0.72, zb + 0.05, 0.016, M.metal, 5); }
      }
    }
    if (D.pushpit) {
      const zs = ext.zDeckEnd - 0.4, y0 = sheerY(cls, zs) + 0.03, hw = deckHalf(cls, zs) - 0.12;
      for (const sd of [-1, 1]) { pb.rod(sd * hw, y0, zs, sd * hw, y0 + 0.7, zs, 0.016, M.metal, 5); pb.rod(sd * hw, y0 + 0.7, zs, sd * hw * 0.35, y0 + 0.7, zs + 0.05, 0.016, M.metal, 5); pb.rod(sd * hw, y0 + 0.7, zs, sd * (deckHalf(cls, zs - 1.5) - 0.08), y0 + 0.68, zs - 1.5, 0.016, M.metal, 5); }
    }
  }
  if (D.swimLadder) {                                       // folding swim ladder on the reverse transom
    const ze = hullExtent(cls).zDeckEnd, yt = sheerY(cls, ze);
    for (const x of [-0.18, 0.18]) pb.rod(x, yt + 0.05, ze + 0.02, x, 0.15, H.L / 2 + 0.06, 0.012, M.metal, 4);
    for (let k = 1; k <= 3; k++) { const t = k / 4; pb.rod(-0.18, lerp(yt + 0.05, 0.15, t), lerp(ze + 0.02, H.L / 2 + 0.06, t), 0.18, lerp(yt + 0.05, 0.15, t), lerp(ze + 0.02, H.L / 2 + 0.06, t), 0.014, M.metal, 4); }
  }
  // bow roller + anchor (sloop, ketch)
  if (cls === 'sloop' || cls === 'ketch') {
    const zb = -H.L / 2 + 0.05, y = sheerY(cls, zb) + 0.08;
    pb.box(0.14, 0.1, 0.6, M.metal, 0, y, zb - 0.1); pb.box(0.06, 0.32, 0.12, M.dark, 0, y - 0.18, zb - 0.38);
  }
  // ---- schooner: channels + deadeyes, pin rails, fife rails, trailboards, bitts, dolphin striker
  if (cls === 'schooner') {
    for (const cp of sp.chainplates) for (const sd of [-1, 1]) {
      const zc = (cp.zs[0] + cp.zs[cp.zs.length - 1]) / 2;
      pb.box(0.42, 0.1, cp.zs[cp.zs.length - 1] - cp.zs[0] + 0.9, M.trim, sd * (deckHalf(cls, zc) + 0.2), cp.y, zc);
      for (const z of cp.zs) { pb.cyl(0.11, 0.07, M.iron, sd * cp.x, cp.y + 0.3, z, 0.11, 10, 0, 0, Math.PI / 2); pb.cyl(0.11, 0.07, M.iron, sd * cp.x, cp.y + 0.62, z, 0.11, 10, 0, 0, Math.PI / 2); pb.rod(sd * cp.x, cp.y + 0.3, z, sd * cp.x, cp.y + 0.62, z, 0.02, M.ropeMesh, 4); pb.rod(sd * cp.x, cp.y + 0.05, z, sd * (cp.x - 0.05), cp.y - 0.9, z, 0.02, M.iron, 4); }
      pb.box(0.12, 0.08, 1.8, M.trim, sd * (deckHalf(cls, zc) - 0.18), sheerY(cls, zc) + 0.55, zc);    // pin rail
      for (let k = 0; k < 6; k++) pb.cyl(0.018, 0.3, M.trim, sd * (deckHalf(cls, zc) - 0.18), sheerY(cls, zc) + 0.65, zc - 0.75 + k * 0.3, 0.018, 4);
    }
    for (const m of sp.masts) {                                    // fife rail round each mast
      const yd = sheerY(cls, m.z) + H.camber;
      for (const sd of [-1, 1]) { pb.box(0.1, 0.06, 1.3, M.trim, sd * 0.75, yd + 0.65, m.z); pb.rod(sd * 0.75, yd, m.z - 0.55, sd * 0.75, yd + 0.65, m.z - 0.55, 0.04, M.trim, 6); pb.rod(sd * 0.75, yd, m.z + 0.55, sd * 0.75, yd + 0.65, m.z + 0.55, 0.04, M.trim, 6); }
      pb.box(1.6, 0.06, 0.1, M.trim, 0, yd + 0.65, m.z + 0.62);
    }
    for (const sd of [-1, 1]) {                                     // trailboards on the clipper bow
      const z0 = -16.6, z1 = -15.0, x0 = hullHalfAt(cls, z0, 1.85) + 0.02, x1 = hullHalfAt(cls, z1, 1.85) + 0.02;
      pb.rod(sd * x0, 1.92, z0, sd * x1, 1.85, z1, 0.06, M.gold, 6);
      pb.rod(sd * x0 * 0.6, 1.7, z0 - 0.4, sd * x0, 1.92, z0, 0.04, M.gold, 6);
    }
    const bs = sp.bowsprit;
    pb.rod(bs.heel[0], bs.heel[1], bs.heel[2] + 1.0, bs.tip[0], bs.tip[1], bs.tip[2], 0.17, M.spar, 10);
    pb.cyl(0.2, 0.25, M.iron, 0, lerp(bs.heel[1], bs.tip[1], 0.68), lerp(bs.heel[2], bs.tip[2], 0.68), 0.2, 10, Math.PI / 2 + 0.06, 0, 0);
    const mz = bs.martingale[2], my = lerp(bs.heel[1], bs.tip[1], (mz - bs.heel[2]) / (bs.tip[2] - bs.heel[2]));
    pb.rod(0, my - 0.05, mz, 0, bs.martingale[1], mz, 0.05, M.iron, 6);                // dolphin striker
    pb.box(0.5, 0.6, 0.4, M.trim, 0, sheerY(cls, -14.3) + 0.3, -14.3);                    // bitts at the bowsprit heel
  }
  if (cls === 'catamaran') {                                     // longeron (code 0 bowsprit)
    const bs = sp.bowsprit; pb.rod(bs.from[0], bs.from[1], bs.from[2], bs.to[0], bs.to[1], bs.to[2], 0.06, M.spar, 8);
  }
  if (cls === 'ketch') { const bs = sp.bowsprit; pb.rod(bs.from[0], bs.from[1] - 0.05, bs.from[2] + 0.3, bs.to[0], bs.to[1] - 0.05, bs.to[2], 0.09, M.trim, 8); }
  // ---- masts, topmasts, mast caps, spreaders / crosstrees, furler drums
  for (const m of sp.masts) {
    pb.cyl(m.d0 / 2, m.top - m.foot, M.spar, 0, (m.top + m.foot) / 2, m.z, m.d1 / 2, 14);
    if (m.topmast) {
      pb.cyl(m.tm0 / 2, m.topmast - m.top + 2.2, M.spar, 0, (m.topmast + m.top - 2.2) / 2, m.z + 0.0, m.tm1 / 2, 10);
      pb.box(m.d1 + 0.12, 0.22, m.d1 + 0.45, M.iron, 0, m.top + 0.05, m.z + 0.12);          // mast cap
      pb.cyl(m.d1 / 2 + 0.01, 1.6, M.masthead, 0, m.top - 0.8, m.z, m.d1 / 2 + 0.01, 12);   // white masthead
      pb.sphere(m.tm1 * 0.9, M.masthead, 0, m.topmast + 0.05, m.z, 8);                   // truck
      pb.box(0.5, 0.1, 0.5, M.trim, 0, m.top - 1.3, m.z);                                  // trestle trees
    } else pb.box(m.d1 * 1.2, 0.12, m.d1 * 1.8, M.metal, 0, m.top + 0.03, m.z + 0.05);  // masthead crane
    pb.cyl(m.d0 / 2 + 0.04, 0.12, M.metal, 0, m.foot + 0.06, m.z, m.d0 / 2 + 0.04, 12);    // mast collar
  }
  for (const st of sp.stays) if (st.kind === 'furler') pb.cyl(0.07, 0.14, M.metal, st.from[0], st.from[1] + 0.07, st.from[2], 0.07, 10);
  // ---- crew (scale reference): one at the helm
  const helmAt = wh.at, cy = cls === 'sloop' ? 0.85 : cls === 'ketch' ? 1.42 : cls === 'catamaran' ? 1.9 : deckAt(0, helmAt[2] + 0.9) - 0.5;
  ctx.crewSpot = [helmAt[0] + (cls === 'catamaran' ? 0 : 0.0), cy, helmAt[2] + 0.75];
}

// ------------------------------------------------------------------------------------------------ distant LODs (§4.6)
/** Static model for other ships: 'near' (≤ 300 m: ~1 k triangles, 3 draw calls) or 'mid' (300 m – 2 km: ~150 triangles). */
function buildLite(cls, level, M, hullMat) {
  const H = hullOf(cls), D = deckOf(cls), R = rigOf(cls), cat = cls === 'catamaran', xs = cat ? [-H.hullX, H.hullX] : [0];
  const g = new THREE.Group(); g.name = 'lite:' + level;
  const [nSt, nPt, nDeck] = level === 'near' ? [16, 6, 12] : cat ? [5, 3, 3] : [7, 3, 5];
  const pb = new PartBuilder();
  for (const dx of xs) {
    pb.geo(hullGeometry(cls, dx, nSt, nPt), hullMat);              // both hulls of the cat merge into one mesh
    pb.geo(deckGeometry(cls, dx, [], nDeck, true), M.house);
  }
  if (cat) pb.box(2 * H.hullX, 0.9, D.bridge.z1 - D.bridge.z0, M.house, 0, (D.bridge.top + D.bridge.under) / 2, (D.bridge.z0 + D.bridge.z1) / 2);
  if (level === 'near') for (const st of D.structures) {
    if (!st.solid && st.kind !== 'hardtop') continue;
    const base = cat ? D.bridge.top : sheerY(cls, (st.z0 + st.z1) / 2) - 0.05;
    pb.box(2 * st.half, Math.max(0.1, st.top - base), st.z1 - st.z0, M.house, 0, (st.top + base) / 2, (st.z0 + st.z1) / 2);
  }
  pb.build(g);
  for (const c of g.children) c.userData.keepWhileWalking = true;
  g.visible = false;
  return g;
}
/** One merged cloth mesh for every sail of a distant ship (one draw call): offsets per sail into a shared buffer. */
function buildSailsLite(cls, base, nu, nv, mat) {
  const per = (nu + 1) * (nv + 1), n = base.sails.length;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(per * n * 3), 3));
  const idx = [], one = gridIndex(nu, nv);
  for (let k = 0; k < n; k++) for (const i of one) idx.push(i + k * per);
  geo.setIndex(idx);
  const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; mesh.visible = false; mesh.name = `sails-lite:${nu}x${nv}`; mesh.userData.keepWhileWalking = true;
  return { mesh, nu, nv, per };
}

// ------------------------------------------------------------------------------------------------ the yacht
/**
 * Build a sailing yacht. opts: { makeHullMat(colorHex, { map }) → material (ship.js passes its wear-shader factory),
 * touch (phone budget), own (the player's ship: full grid), hullColor }.
 */
export function buildYacht(cls, opts = {}) {
  const R = rigOf(cls), H = hullOf(cls); if (!R || !H) return null;
  const M = classMats(cls), K = looksOf(cls);
  const g = new THREE.Group(); g.name = 'yacht:' + cls;
  const hullMat = opts.makeHullMat ? opts.makeHullMat(0xffffff, { map: hullTexture(cls) }) : new THREE.MeshStandardMaterial({ color: 0xffffff, map: hullTexture(cls), roughness: 0.38, metalness: 0.08 });
  if (!hullMat.map) { hullMat.map = hullTexture(cls); hullMat.needsUpdate = true; }
  const hullMats = { hull: hullMat };
  const pb = new PartBuilder();
  const ctx = { g, pb, M, hullMats };
  buildStatic(cls, ctx);
  pb.build(g);
  // walking the ship (interior.js): the deck plan draws its own deck, houses and deck gear — those meshes are flagged
  // walkHide; the hull sides, keel, bulwarks and the whole rig stay (keepWhileWalking)
  const planDraws = new Set([M.deck, M.house, M.cockpit, M.metal, M.window, M.canvas, M.dark, M.trim, M.tramp]);
  for (const c of g.children) { if (planDraws.has(c.material)) c.userData.walkHide = true; else c.userData.keepWhileWalking = true; }
  const detail = g.children.slice();                        // the full static model (own ship, others within reach of the eye)
  const liteNear = buildLite(cls, 'near', M, hullMat), liteMid = buildLite(cls, 'mid', M, hullMat);
  g.add(liteNear, liteMid);
  // ---- standing rigging: merged line segments (far) + merged thin cylinders (own ship within 40 m)
  const stand = standingRigging(cls);
  const lp = [];
  for (const s of stand) { if (s.kind === 'spreader' || s.kind === 'crosstree') continue; lp.push(...s.a, ...s.b); }
  const lineGeo = new THREE.BufferGeometry(); lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
  const standLines = new THREE.LineSegments(lineGeo, M.line); standLines.name = 'standing-lines'; standLines.userData.keepWhileWalking = true; g.add(standLines);
  const sb = new PartBuilder(), spb = new PartBuilder();
  for (const s of stand) {
    if (s.kind === 'spreader' || s.kind === 'crosstree') { spb.rod(...s.a, ...s.b, s.kind === 'crosstree' ? 0.07 : 0.03, M.spar, 6); continue; }
    if (s.kind === 'ratline') continue;
    sb.rod(...s.a, ...s.b, Math.max(0.006, s.r), s.kind === 'foil' ? M.metal : M.wire, s.kind === 'foil' ? 6 : 4);
  }
  const nBefore = g.children.length;
  spb.build(g);
  for (const c of g.children.slice(nBefore)) { c.userData.keepWhileWalking = true; detail.push(c); }
  const standCyl = new THREE.Group(); standCyl.name = 'standing-cyl'; standCyl.userData.keepWhileWalking = true; sb.build(standCyl); g.add(standCyl);
  // ---- distant LODs: masts / bowsprit / headstays as lines (mid), merged cloth (near 6 × 8, mid 1 × 1)
  const midPts = [];
  for (const m of R.spars.masts) midPts.push(0, m.foot, m.z, 0, m.topmast || m.top, m.z);
  for (const st of R.spars.stays) if (st.sail && !rigBase(cls).byId[st.sail]?.def.light) midPts.push(...st.from, ...st.to);
  const midGeo = new THREE.BufferGeometry(); midGeo.setAttribute('position', new THREE.Float32BufferAttribute(midPts, 3));
  const midLines = new THREE.LineSegments(midGeo, M.line); midLines.name = 'mid-lines'; midLines.visible = false; midLines.userData.keepWhileWalking = true; g.add(midLines);
  for (const m of R.spars.masts) lp.push(0, m.foot, m.z, 0, m.topmast || m.top, m.z);           // masts in the standing lines too (near LOD)
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
  const sailsNear = buildSailsLite(cls, rigBase(cls), 6, 8, M.sailPlain), sailsMid = buildSailsLite(cls, rigBase(cls), 1, 1, M.sailPlain);
  g.add(sailsNear.mesh, sailsMid.mesh);
  // ---- dynamic spars: booms (+ lazy bag on the cat), gaffs, vangs
  const base = rigBase(cls);
  const booms = R.spars.booms.map((bm) => { const m = new THREE.Mesh(UNIT_CYL, M.spar); m.name = 'boom:' + bm.sail; m.userData.keepWhileWalking = true; g.add(m); return m; });
  const lazy = cls === 'catamaran' ? (() => { const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), M.canvas); m.name = 'lazybag'; m.userData.keepWhileWalking = true; g.add(m); return m; })() : null;
  const gaffs = R.spars.gaffs.map((gf) => { const m = new THREE.Mesh(UNIT_CYL, M.spar); m.name = 'gaff:' + gf.sail; m.userData.keepWhileWalking = true; g.add(m); return m; });
  const vangs = R.spars.booms.filter((bm) => !bm.club && cls !== 'schooner').map(() => { const m = new THREE.Mesh(UNIT_CYL6, M.metal); m.userData.keepWhileWalking = true; g.add(m); return m; });
  // ---- sails
  const sails = base.sails.map((s) => {
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), M.sails[sailKind(s)]);
    mesh.name = 'sail:' + s.id; mesh.frustumCulled = false; mesh.userData.keepWhileWalking = true;
    g.add(mesh);
    const stow = new THREE.Mesh(UNIT_CYL, s.def.furl ? (cls === 'sloop' ? M.canvas : M.sails[sailKind(s)]) : cls === 'catamaran' ? M.canvas : M.sails[sailKind(s)]);
    stow.name = 'stow:' + s.id; stow.visible = false; stow.userData.keepWhileWalking = true; g.add(stow);
    return { s, mesh, stow, grid: null, spring: { x: 0, v: 0, crash: 0 }, hoist: 0, reef: 0, init: false };
  });
  // ---- running rigging (dynamic line segments), telltales (quads), reef points
  const MAXR = 256;
  const runGeo = new THREE.BufferGeometry(); runGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAXR * 6), 3)); runGeo.setDrawRange(0, 0);
  const runLines = new THREE.LineSegments(runGeo, M.rope); runLines.frustumCulled = false; runLines.name = 'running'; runLines.userData.keepWhileWalking = true; g.add(runLines);
  const MAXT = 48;
  const ttGeo = new THREE.BufferGeometry();
  ttGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAXT * 4 * 3 * 3), 3));
  ttGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAXT * 4 * 3 * 3), 3));
  { const idx = []; for (let i = 0; i < MAXT * 3; i++) { const a = i * 4; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } ttGeo.setIndex(idx); }
  ttGeo.setDrawRange(0, 0);
  const tell = new THREE.Mesh(ttGeo, M.tell); tell.frustumCulled = false; tell.name = 'telltales'; tell.userData.keepWhileWalking = true; g.add(tell);
  const rpGeo = new THREE.BufferGeometry(); rpGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(96 * 3), 3)); rpGeo.setDrawRange(0, 0);
  const reefPts = new THREE.Points(rpGeo, M.reefPt); reefPts.frustumCulled = false; reefPts.userData.keepWhileWalking = true; g.add(reefPts);

  // ---- dims, lights, label
  const dims = yachtDims(cls);
  const mastMain = R.spars.masts.reduce((a, m) => (m.topmast || m.top) > (a.topmast || a.top) ? m : a);
  const topY = mastMain.topmast || mastMain.top;
  const LIGHTS = {
    sloop: { x: 0.32, y: 2.15, z: -5.1, stern: { y: 1.95, z: 5.05 } },
    ketch: { x: 0.36, y: 2.6, z: -8.75, stern: { y: 2.15, z: 7.55 } },
    catamaran: { x: 3.3, y: 1.75, z: -6.3, stern: { y: 4.15, z: 5.0 } },
    schooner: { x: 3.55, y: 3.4, z: -8.9, stern: { y: 2.75, z: 17.2 } },
  }[cls];
  const fm = R.spars.masts[0];
  const lights = { x: LIGHTS.x, y: LIGHTS.y, z: LIGHTS.z, mastY: lerp(fm.foot, fm.top, 0.6), mastZ: fm.z - mastRadius(fm, lerp(fm.foot, fm.top, 0.6)) - 0.08, fore: null, stern: LIGHTS.stern };

  // ---- state + API
  let view = null, extra = {}, time = 0, lod = 'own', lastFrame = -1, sinceNear = 1, lastMode = '', fresh = true;
  const omega = springOmega(cls);
  const touch = !!opts.touch;
  const yacht = {
    group: g, cls, dims, lights, labelY: topY + 3, mats: [hullMat], crewSpot: ctx.crewSpot, own: !!opts.own,
    /** RigView from rigViewOf / unpackRigView / autoTrimView; extra { aws, flags (bit 4 crash jibe), sides: {id: ±1}, snap } */
    setRig(v, ex = {}) {
      if (!v || !Array.isArray(v.sails)) return;
      view = v; extra = ex || {};
      if (extra.snap || fresh) for (const sl of sails) sl.init = false;   // teleport / first sight (before the first update): no animation from the old pose
      for (const sl of sails) {
        const sv = v.sails.find((x) => x.id === sl.s.id); if (!sv) continue;
        if (!sl.init) { sl.spring.x = sv.angle; sl.spring.v = 0; sl.hoist = sv.hoist; sl.reef = sv.reef; sl.init = true; }
        if ((extra.flags & 16) && (sl.s.kind === 'boom' || sl.s.kind === 'gaff') && Math.sign(sv.angle) !== Math.sign(sl.spring.x)) sl.spring.crash = 1;
      }
      lastFrame = -1;
    },
    /** Legacy: sails up / down sheeted to the relative wind (deg: any range, 0…180 = from starboard, or signed). */
    setSails(up, rel) {
      const r = Number.isFinite(rel) ? rel : 90, signed = ((((r % 360) + 540) % 360) - 180) || 0;
      const v = autoTrimView(cls, signed, 8);
      if (up === false) for (const s of v.sails) { s.hoist = 0; s.state = 5; }
      this.setRig(v, { aws: 8 });
    },
    /** Per frame. opts { camera, time, own, touch }. Returns the LOD used. */
    update(dt, o = {}) {
      dt = Math.min(0.1, Math.max(0, Number(dt) || 0));
      time = Number.isFinite(o.time) ? o.time : time + dt;
      const own = o.own ?? yacht.own;
      let dist = 0;
      if (o.camera) { g.updateWorldMatrix(true, false); const p = new THREE.Vector3().setFromMatrixPosition(g.matrixWorld); dist = p.distanceTo(o.camera.position); }
      lod = own ? 'own' : dist <= 300 ? 'near' : dist <= 2000 ? 'mid' : 'far';
      const isTouch = o.touch ?? touch;
      // visibility per LOD (§4.6): own = full model; near (≤ 300 m) = lite hull + houses, merged 6 × 8 cloth, rigging as
      // lines; mid (≤ 2 km) = hull, merged 2-triangle sails, mast + headstay lines; far = the hull only
      const cylOn = own && !isTouch && dist < 40, full = lod === 'own';
      if (lod !== lastMode) {
        for (const m of detail) m.visible = full;
        liteNear.visible = lod === 'near'; liteMid.visible = lod === 'mid' || lod === 'far';
        for (const b of [...booms, ...gaffs, ...vangs]) b.visible = full;
        if (lazy) lazy.visible = full;
        for (const sl of sails) { if (!full) sl.mesh.visible = false; if (lod === 'mid' || lod === 'far') sl.stow.visible = false; }
        sailsNear.mesh.visible = lod === 'near'; sailsMid.mesh.visible = lod === 'mid';
        midLines.visible = lod === 'mid';
        lastMode = lod; lastFrame = -1;
      }
      standCyl.visible = cylOn; standLines.visible = (full || lod === 'near') && !cylOn;
      runLines.visible = full || lod === 'near';
      tell.visible = dist <= 60 && (own || !isTouch) && (full || lod === 'near');
      reefPts.visible = full;
      if (!view) return lod;
      // springs (always — cheap), hoist / reef easing
      const angles = {};
      for (const sl of sails) {
        const sv = view.sails.find((x) => x.id === sl.s.id); if (!sv) continue;
        if (!crashStep(sl.spring, sv.angle, dt)) springStep(sl.spring, sv.angle, sl.spring.crash ? omega * 2 : omega, dt);
        sl.hoist += clamp(sv.hoist - sl.hoist, -dt * 0.8, dt * 0.8);
        if (Math.abs(sv.hoist - sl.hoist) > 0.5) sl.hoist = sv.hoist;   // big jumps (others' rv, setSails): no slow animation
        sl.reef += clamp(sv.reef - sl.reef, -dt * 0.6, dt * 0.6);
        angles[sl.s.id] = sl.spring.x;
      }
      // others ≤ 300 m: 15 Hz cloth; beyond: angle only (1 × 1 grid) at 4 Hz
      sinceNear += dt;
      const period = lod === 'own' ? 0 : lod === 'near' ? 1 / 15 : 0.25;
      if (sinceNear < period && lastFrame >= 0) return lod;
      sinceNear = 0;
      const vw = { heel: view.heel, sails: view.sails.map((sv) => { const sl = sails.find((x) => x.s.id === sv.id); return { ...sv, hoist: sl ? sl.hoist : sv.hoist, reef: sl ? sl.reef : sv.reef, side: extra.sides ? extra.sides[sv.id] : sv.side }; }) };
      const fr = rigFrame(cls, vw, { t: time, aws: extra.aws ?? 8, angles });
      lastFrame = time;
      // distant ships: every sail into one merged mesh (one draw call)
      const lite = lod === 'near' ? sailsNear : lod === 'mid' ? sailsMid : null;
      if (lite) {
        const arr = lite.mesh.geometry.attributes.position.array, n3 = lite.per * 3;
        sails.forEach((sl, k) => { const p = fr.params[sl.s.id], sub = arr.subarray(k * n3, (k + 1) * n3); if (p.visible) sailGrid(p, lite.nu, lite.nv, sub); else sub.fill(0); });
        lite.mesh.geometry.attributes.position.needsUpdate = true; lite.mesh.geometry.computeVertexNormals(); lite.mesh.geometry.computeBoundingSphere();
      }
      // sails (own ship / full model)
      for (const sl of sails) {
        const p = fr.params[sl.s.id];
        if (!full) {                                         // distant: only the stowed rolls / bundles (near)
          const bo = fr.booms.find((x) => x.sail === sl.s.id), st = lod === 'near' ? stowedOf(p, bo || null) : null;
          if (st) placeRod(sl.stow, st.a, st.b, st.r); else sl.stow.visible = false;
          continue;
        }
        const [nu, nv] = gridFor('own', sl.s.quad, isTouch);
        const mode = `${nu}x${nv}`;
        if (!sl.grid || sl.grid.mode !== mode) {
          const geo = new THREE.BufferGeometry(), n = (nu + 1) * (nv + 1);
          geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
          geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
          geo.setIndex(gridIndex(nu, nv));
          sl.mesh.geometry.dispose(); sl.mesh.geometry = geo; sl.grid = { mode, nu, nv };
        }
        sl.mesh.visible = p.visible;
        if (sl.mesh.visible) {
          const geo = sl.mesh.geometry;
          sailGrid(p, nu, nv, geo.attributes.position.array); geo.attributes.position.needsUpdate = true;
          sailUVs(p, nu, nv, geo.attributes.uv.array); geo.attributes.uv.needsUpdate = true;
          geo.computeVertexNormals(); geo.computeBoundingSphere();
        }
        // stowed cloth: roll on the stay, bundle on the boom, bag on deck
        const bo = fr.booms.find((x) => x.sail === sl.s.id);
        const st = stowedOf(p, bo || null);
        if (st) placeRod(sl.stow, st.a, st.b, st.r); else sl.stow.visible = false;
      }
      // booms, gaffs, vangs, lazy bag (full model; distant ships draw booms and gaffs as lines below)
      if (full) fr.booms.forEach((bo, i) => placeRod(booms[i], bo.a, bo.b, bo.r));
      if (full) fr.gaffs.forEach((gf, i) => placeRod(gaffs[i], gf.a, gf.b, gf.r));
      let vi = 0;
      if (full) for (const bo of fr.booms) {
        if (bo.club || cls === 'schooner') continue;
        const m = R.spars.masts.find((mm) => Math.abs(mm.z - bo.a[2]) < 0.4) || R.spars.masts[0];
        const at = [lerp(bo.a[0], bo.b[0], 0.28), lerp(bo.a[1], bo.b[1], 0.28) - 0.05, lerp(bo.a[2], bo.b[2], 0.28)];
        placeRod(vangs[vi++], at, [0, m.foot + 0.35, m.z + mastRadius(m, m.foot) + 0.05], 0.025);
      }
      if (lazy && full) {
        const bo = fr.booms[0]; const l = Math.hypot(bo.b[0] - bo.a[0], bo.b[2] - bo.a[2]);
        lazy.position.set(lerp(bo.a[0], bo.b[0], 0.5), lerp(bo.a[1], bo.b[1], 0.5) + 0.3, lerp(bo.a[2], bo.b[2], 0.5));
        lazy.rotation.set(0, Math.atan2(bo.b[0] - bo.a[0], bo.b[2] - bo.a[2]), 0); lazy.scale.set(0.42, 0.55, l * 0.96);
      }
      // running rigging
      if (runLines.visible) {
        const arr = runGeo.attributes.position.array; let k = 0;
        const add = (pts) => { for (let i = 0; i < pts.length - 1 && k < MAXR; i++, k++) arr.set([...pts[i], ...pts[i + 1]], k * 6); };
        for (const s of fr.sheets) add(s.pts);
        for (const s of fr.runners) add(s.pts);
        if (full) for (const s of fr.halyards) add(s.pts);
        else for (const sp of [...fr.booms, ...fr.gaffs]) add([sp.a, sp.b]);
        runGeo.setDrawRange(0, k * 2); runGeo.attributes.position.needsUpdate = true; runGeo.computeBoundingSphere();
      }
      // telltales: 0.25 m ribbons in three segments, red to port, green to starboard
      if (tell.visible) {
        const P = ttGeo.attributes.position.array, C = ttGeo.attributes.color.array; let q = 0;
        for (const t of fr.telltales) {
          if (q >= MAXT * 3) break;
          const col = t.face < 0 ? [0.9, 0.08, 0.06] : [0.05, 0.75, 0.15];
          let a = t.p.slice(); const seg = 0.25 / 3, wdt = 0.035;
          for (let s2 = 0; s2 < 3; s2++, q++) {
            const wob = 0.25 * Math.sin(time * 9 + s2 * 1.7 + t.p[1]);
            const d = [t.d[0] + wob * 0.15 * s2, t.d[1] - 0.06 * s2, t.d[2] + wob * 0.15 * s2];
            const b = [a[0] + d[0] * seg, a[1] + d[1] * seg, a[2] + d[2] * seg];
            const off = [0, wdt / 2, 0];
            const o = q * 12;
            P.set([a[0] - off[0], a[1] - off[1], a[2] - off[2], a[0] + off[0], a[1] + off[1], a[2] + off[2], b[0] - off[0], b[1] - off[1], b[2] - off[2], b[0] + off[0], b[1] + off[1], b[2] + off[2]], o);
            for (let c = 0; c < 4; c++) C.set(col, o + c * 3);
            a = b;
          }
        }
        ttGeo.setDrawRange(0, q * 6); ttGeo.attributes.position.needsUpdate = true; ttGeo.attributes.color.needsUpdate = true;
      }
      if (reefPts.visible) {
        const arr = rpGeo.attributes.position.array; let n = 0;
        for (const p of fr.reefPoints) { if (n >= 96) break; arr.set(p, n * 3); n++; }
        rpGeo.setDrawRange(0, n); rpGeo.attributes.position.needsUpdate = true;
      }
      yacht.frame = fr; fresh = false;
      return lod;
    },
    /** Triangle / draw-call estimate of what is visible now (budget checks, §4.6). */
    stats() {
      let tris = 0, calls = 0;
      g.traverse((o) => {
        if (!o.visible || !(o.isMesh || o.isLine || o.isPoints)) return;
        let p = o.parent, vis = true; while (p && p !== g) { if (!p.visible) { vis = false; break; } p = p.parent; }
        if (!vis) return;
        calls++;
        if (o.isMesh && o.geometry.attributes.position) { const gg = o.geometry; const n = gg.index ? (gg.drawRange.count !== Infinity ? Math.min(gg.drawRange.count, gg.index.count) : gg.index.count) : gg.attributes.position.count; tris += n / 3; }
      });
      return { tris: Math.round(tris), calls, lod: lastMode };
    },
    dispose() {
      g.traverse((o) => {
        if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
        const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
        for (const m of ms) if (m && !m.userData.shared) m.dispose();
      });
    },
  };
  // a crew member at the helm is added by ship.js (ctx.crew); expose the spot
  yacht.setSails(true, 90);
  return yacht;
}
