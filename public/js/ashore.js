// Go ashore (docs/V4-CONTRACTS.md §3): while docked the skipper walks the real harbour as the crew member. The
// on-foot layer is built ON TOP of the existing harbour scene (the terrain patch and the buildHarbor group stay) from
// the geometry JSON's street layer: road ribbons (asphalt / paving / gravel by kind, sidewalks, lane markings on main
// roads, bridges over water), land-use flats (grass, parks, woods, sand, port aprons, parking), rail tracks, street
// lamps that light up at night, benches, quay posts, parked cars, container stacks, trees, the POI doors with wall
// signs and glowing name sprites (visible from 200 m), street signs for real shops, a gangway to your ship and an
// instanced crowd of pedestrians on the sidewalks.
//
// Walking: WASD / the touch stick, Shift runs, mouse (pointer lock or drag) / right-half drag looks, wheel / pinch zooms
// (3–12 m), V toggles first / third person, E or a tap uses the nearest door (harbour panels through
// app.hud.openHarborTab), your gangway takes you back aboard, another skipper's ship offers trade / convoy. Collision:
// the patch mask (land, quay, pontoon walkable; water and breakwater rubble block; the water's edge follows the tide)
// plus building footprints and tanks from a 50 m spatial grid; ground height from the patch heights, quay / pontoon
// tops inside their rings, bridge decks over water. The third-person camera is pulled in when a footprint stands
// between it and the crew member, and never goes under the ground.
import * as THREE from 'three';
import { toLocal } from '/shared/geo.js';
import { PATCH, SHIP_CLASSES } from '/shared/constants.js';
import { makeAvatar, Crowd } from './avatar.js';
import { mergeGeometries } from './models.js';

const MASK = PATCH.MASK;
const WALK_CODE = new Uint8Array([0, 1, 1, 0, 1, 0, 0]);      // LAND, QUAY, PONTOON
const QUAY_TOP = 2.65, PONT_TOP = 0.7;                          // harbor.js extrusion tops (QUAY_H / PONT_H)
const EYE = 1.65, WALK_SPEED = 1.6, RUN_SPEED = 4.2, RADIUS = 0.3, STEP_UP = 1.3;
const CAM_MIN = 3, CAM_MAX = 12, CAM_DEFAULT = 5.5;
const USE_RANGE = 6, GANGWAY_RANGE = 5, SHIP_RANGE = 9, SIGN_RANGE = 200, PLACE_RANGE = 70, TAXI_MIN = 250;
const TAXI_ORDER = ['harbourmaster', 'market', 'shipyard', 'chandler', 'fuel', 'bar', 'cafe', 'police', 'aboard'];
const GRID = 50, DETAIL_R = 1600, CROWD_R = 380, CROWD_DROP_R = 480;
const MOVE_KEYS = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
const D2R = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** What each door does: the harbour panel tab it opens (hud.openHarborTab), its colour and icon. */
export const POI_INFO = {
  harbourmaster: { tab: 'jobs', label: 'Harbourmaster — contracts & job boards', short: 'Harbourmaster', color: '#2463b0', icon: 'anchor' },
  shipyard: { tab: 'shipyard', label: 'Shipyard — buy & sell ships', short: 'Shipyard', color: '#c25a1c', icon: 'ship' },
  chandler: { tab: 'services', label: 'Ship chandler — repairs, service & kits', short: 'Chandler', color: '#2c8051', icon: 'wrench' },
  fuel: { tab: 'services', label: 'Fuel dock — bunker fuel', short: 'Fuel dock', color: '#c9961a', icon: 'fuel' },
  market: { tab: 'market', label: 'Market hall — buy & sell goods', short: 'Market', color: '#6a45b8', icon: 'crate' },
  bar: { tab: 'shady', label: 'Bar — ask around…', short: 'Bar', color: '#9b2c2c', icon: 'mug' },
  police: { tab: null, label: 'Harbour police', short: 'Police', color: '#22457a', icon: 'shield' },
  cafe: { tab: 'overview', label: 'Café — harbour news, weather & tide', short: 'Café', color: '#8a5a1f', icon: 'cup' },
};
const ROAD_STYLE = {
  motorway: { mat: 'asphalt', y: 0.17, mark: 'motorway', lamps: 40 },
  primary: { mat: 'asphalt', y: 0.16, mark: 'dash', walk: true, lamps: 32 },
  secondary: { mat: 'asphalt', y: 0.16, mark: 'dash', walk: true, lamps: 32 },
  tertiary: { mat: 'asphalt', y: 0.15, walk: true, lamps: 34 },
  residential: { mat: 'asphalt', y: 0.15, walk: true, parked: true, lamps: 36, trees: true },
  service: { mat: 'asphaltLight', y: 0.14, parked: true, lamps: 42 },
  footway: { mat: 'paving', y: 0.12, lamps: 28, benches: true },
  track: { mat: 'gravel', y: 0.11 },
};
const AREA_STYLE = {
  residential: { color: 0xa69e91, y: 0.04 }, industrial: { color: 0x8c8780, y: 0.045 }, port: { color: 0x8b8882, y: 0.05 },
  sand: { color: 0xdcc99c, y: 0.055 }, grass: { color: 0x6f9c46, y: 0.06 }, park: { color: 0x5e9a40, y: 0.065 },
  wood: { color: 0x4b7234, y: 0.07 }, parking: { color: 0x5a5d61, y: 0.075, pattern: 'parking' },
};
const CAR_COLORS = [0xf2f2f2, 0x1c1c1e, 0x8a8f96, 0xb3b8bf, 0x9b1b1b, 0x1f3f7a, 0x2c5a3a, 0xcfa23a, 0x5a3a2a, 0x3d6f9e, 0xe0e0d8, 0x45484d];
const CONT_COLORS = [0xc0392b, 0x2980b9, 0x27ae60, 0xf39c12, 0x7f8c8d, 0xd35400, 0x8e44ad, 0x16a085, 0xbdc3c7, 0x2c3e50];

// ------------------------------------------------------------------------------------------------ small helpers
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) { let s = (seed >>> 0) || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function pointInRing(x, z, r) {
  let c = false;
  for (let i = 0, n = r.length, j = n - 1; i < n; j = i++) { const xi = r[i][0], zi = r[i][1], xj = r[j][0], zj = r[j][1]; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c; }
  return c;
}
function segDist2(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
  let t = L2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / L2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t - px, qz = az + dz * t - pz;
  return qx * qx + qz * qz;
}
function compass(dx, dz) { const b = ((Math.atan2(dx, -dz) / D2R) + 360) % 360; return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(b / 45) % 8]; }
const yawOf = (dx, dz) => Math.atan2(dx, -dz);                       // facing (dx, dz) with forward = (sin yaw, −cos yaw)

/** Resample a polyline every ≤ step metres: [{x, z, nx, nz (left normal, mitred at joints), tx, tz, d (distance)}]. */
function resample(pts, step) {
  const out = [];
  let d = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
    if (L < 1e-3) continue;
    const k = Math.max(1, Math.ceil(L / step));
    for (let s = out.length ? 1 : 0; s <= k; s++) out.push({ x: a[0] + (dx * s) / k, z: a[1] + (dz * s) / k, tx: dx / L, tz: dz / L, d: d + (L * s) / k, joint: s === k });
    d += L;
  }
  for (let i = 0; i < out.length; i++) {
    const p = out[i], q = out[i + 1];
    let tx = p.tx, tz = p.tz;
    if (p.joint && q) { tx += q.tx; tz += q.tz; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l; }
    // left normal of the direction of travel (x east, z south): (tz, −tx); mitre so the width holds through bends
    let nx = tz, nz = -tx;
    if (p.joint && q) { const c = Math.max(0.5, nx * p.tz - nz * p.tx); nx /= c; nz /= c; }
    p.nx = nx; p.nz = nz;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ canvas textures
function canvasTexture(size, draw, srgb = true) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function speckle(x, S, base, spread, count, seed, size = 2) {
  const r = rng(seed);
  x.fillStyle = base; x.fillRect(0, 0, S, S);
  for (let i = 0; i < count; i++) {
    const v = Math.round(r() * spread * 2 - spread);
    x.fillStyle = v >= 0 ? `rgba(255,255,255,${(v / 255).toFixed(3)})` : `rgba(0,0,0,${(-v / 255).toFixed(3)})`;
    const s = size * (0.5 + r());
    x.fillRect(r() * S, r() * S, s, s);
  }
}
function makeTextures() {
  return {
    noise: canvasTexture(256, (x, S) => speckle(x, S, '#e6e6e6', 40, 9000, 11, 3)),
    asphalt: canvasTexture(256, (x, S) => { speckle(x, S, '#45484c', 26, 12000, 21, 2); x.strokeStyle = 'rgba(20,20,22,0.35)'; x.lineWidth = 2; x.beginPath(); x.moveTo(0, S * 0.7); x.bezierCurveTo(S * 0.3, S * 0.62, S * 0.6, S * 0.82, S, S * 0.7); x.stroke(); }),
    paving: canvasTexture(256, (x, S) => {
      speckle(x, S, '#a99f8f', 14, 3000, 31, 2);
      x.strokeStyle = 'rgba(60,52,44,0.55)'; x.lineWidth = 2;
      const row = S / 8, brick = S / 4;
      for (let j = 0; j < 8; j++) { x.beginPath(); x.moveTo(0, j * row); x.lineTo(S, j * row); x.stroke(); for (let i = 0; i <= 4; i++) { const bx = i * brick + (j % 2 ? brick / 2 : 0); x.beginPath(); x.moveTo(bx, j * row); x.lineTo(bx, (j + 1) * row); x.stroke(); } }
    }),
    gravel: canvasTexture(256, (x, S) => speckle(x, S, '#7d7160', 45, 14000, 41, 3)),
    corrugated: canvasTexture(128, (x, S) => {
      x.fillStyle = '#e8e8e8'; x.fillRect(0, 0, S, S);
      for (let i = 0; i < S; i += 8) { x.fillStyle = 'rgba(0,0,0,0.22)'; x.fillRect(i, 0, 3, S); x.fillStyle = 'rgba(255,255,255,0.25)'; x.fillRect(i + 4, 0, 2, S); }
      x.fillStyle = 'rgba(0,0,0,0.3)'; x.fillRect(0, 0, S, 5); x.fillRect(0, S - 5, S, 5);
    }),
    parking: canvasTexture(256, (x, S) => {
      speckle(x, S, '#4d5054', 22, 9000, 51, 2);
      x.fillStyle = 'rgba(235,235,225,0.9)';
      for (let i = 0; i < 4; i++) x.fillRect(i * (S / 4), S * 0.08, 4, S * 0.38);   // bays 2.5 m wide (texture spans 10 m)
      for (let i = 0; i < 4; i++) x.fillRect(i * (S / 4), S * 0.54, 4, S * 0.38);
    }),
  };
}

/** Simple white pictograms for the POI signs (no fonts or emoji needed). */
function drawIcon(x, kind, cx, cy, r) {
  x.save(); x.translate(cx, cy); x.strokeStyle = '#fff'; x.fillStyle = '#fff'; x.lineWidth = r * 0.14; x.lineCap = 'round'; x.lineJoin = 'round';
  const L = r * 0.62;
  switch (kind) {
    case 'anchor':
      x.beginPath(); x.arc(0, -L * 0.82, L * 0.18, 0, Math.PI * 2); x.stroke();
      x.beginPath(); x.moveTo(0, -L * 0.64); x.lineTo(0, L * 0.85); x.stroke();
      x.beginPath(); x.moveTo(-L * 0.4, -L * 0.38); x.lineTo(L * 0.4, -L * 0.38); x.stroke();
      x.beginPath(); x.arc(0, L * 0.12, L * 0.75, Math.PI * 0.15, Math.PI * 0.85); x.stroke();
      x.beginPath(); x.moveTo(L * 0.7, L * 0.25); x.lineTo(L * 0.82, L * 0.48); x.lineTo(L * 0.52, L * 0.47); x.fill();
      x.beginPath(); x.moveTo(-L * 0.7, L * 0.25); x.lineTo(-L * 0.82, L * 0.48); x.lineTo(-L * 0.52, L * 0.47); x.fill();
      break;
    case 'ship':
      x.beginPath(); x.moveTo(-L, L * 0.15); x.lineTo(L, L * 0.15); x.lineTo(L * 0.7, L * 0.65); x.lineTo(-L * 0.75, L * 0.65); x.closePath(); x.fill();
      x.fillRect(-L * 0.55, -L * 0.25, L * 0.65, L * 0.4); x.fillRect(-L * 0.35, -L * 0.6, L * 0.25, L * 0.35);
      break;
    case 'wrench':
      x.rotate(-Math.PI / 4);
      x.fillRect(-L * 0.12, -L * 0.45, L * 0.24, L * 1.35);
      x.beginPath(); x.arc(0, -L * 0.55, L * 0.36, 0, Math.PI * 2); x.fill();
      x.globalCompositeOperation = 'destination-out'; x.fillRect(-L * 0.12, -L * 1.0, L * 0.24, L * 0.45); x.globalCompositeOperation = 'source-over';
      break;
    case 'fuel':
      x.fillRect(-L * 0.6, -L * 0.75, L * 0.8, L * 1.55);
      x.fillStyle = 'rgba(0,0,0,0.35)'; x.fillRect(-L * 0.45, -L * 0.6, L * 0.5, L * 0.35); x.fillStyle = '#fff';
      x.beginPath(); x.moveTo(L * 0.2, -L * 0.3); x.lineTo(L * 0.55, -L * 0.3); x.lineTo(L * 0.55, L * 0.45); x.lineTo(L * 0.75, L * 0.45); x.lineTo(L * 0.75, -L * 0.5); x.stroke();
      break;
    case 'crate':
      x.strokeRect(-L * 0.7, -L * 0.7, L * 1.4, L * 1.4);
      x.beginPath(); x.moveTo(-L * 0.7, -L * 0.7); x.lineTo(L * 0.7, L * 0.7); x.moveTo(L * 0.7, -L * 0.7); x.lineTo(-L * 0.7, L * 0.7); x.stroke();
      break;
    case 'mug':
      x.fillRect(-L * 0.55, -L * 0.45, L * 0.85, L * 1.2);
      x.beginPath(); x.arc(L * 0.38, L * 0.12, L * 0.3, -Math.PI / 2, Math.PI / 2); x.stroke();
      x.beginPath(); x.arc(-L * 0.3, -L * 0.52, L * 0.22, 0, Math.PI * 2); x.arc(0.0, -L * 0.6, L * 0.24, 0, Math.PI * 2); x.arc(L * 0.22, -L * 0.5, L * 0.2, 0, Math.PI * 2); x.fill();
      break;
    case 'shield':
      x.beginPath(); x.moveTo(0, -L * 0.85); x.lineTo(L * 0.7, -L * 0.55); x.lineTo(L * 0.55, L * 0.35); x.lineTo(0, L * 0.85); x.lineTo(-L * 0.55, L * 0.35); x.lineTo(-L * 0.7, -L * 0.55); x.closePath(); x.fill();
      break;
    case 'cup':
      x.beginPath(); x.moveTo(-L * 0.6, -L * 0.2); x.lineTo(L * 0.4, -L * 0.2); x.lineTo(L * 0.3, L * 0.5); x.lineTo(-L * 0.5, L * 0.5); x.closePath(); x.fill();
      x.beginPath(); x.arc(L * 0.42, L * 0.08, L * 0.2, -Math.PI / 2, Math.PI / 2); x.stroke();
      x.fillRect(-L * 0.8, L * 0.6, L * 1.4, L * 0.12);
      x.beginPath(); x.moveTo(-L * 0.25, -L * 0.4); x.quadraticCurveTo(-L * 0.4, -L * 0.6, -L * 0.25, -L * 0.85); x.moveTo(L * 0.05, -L * 0.4); x.quadraticCurveTo(-L * 0.1, -L * 0.6, L * 0.05, -L * 0.85); x.stroke();
      break;
    default: x.beginPath(); x.arc(0, 0, L * 0.5, 0, Math.PI * 2); x.fill();
  }
  x.restore();
}
function roundRect(x, X, Y, W, H, R) { x.beginPath(); x.moveTo(X + R, Y); x.arcTo(X + W, Y, X + W, Y + H, R); x.arcTo(X + W, Y + H, X, Y + H, R); x.arcTo(X, Y + H, X, Y, R); x.arcTo(X, Y, X + W, Y, R); x.closePath(); }
/** Sign texture: coloured plate, round icon badge, name and a sub line. */
function signTexture(info, name, sub) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 128;
  const x = c.getContext('2d');
  x.clearRect(0, 0, 512, 128);
  roundRect(x, 4, 8, 504, 112, 22); x.fillStyle = 'rgba(8,16,26,0.82)'; x.fill();
  x.lineWidth = 5; x.strokeStyle = info.color; x.stroke();
  x.beginPath(); x.arc(66, 64, 44, 0, Math.PI * 2); x.fillStyle = info.color; x.fill();
  drawIcon(x, info.icon, 66, 64, 44);
  x.fillStyle = '#ffffff'; x.textBaseline = 'middle'; x.textAlign = 'left';
  let size = 40; x.font = `700 ${size}px system-ui, "Segoe UI", sans-serif`;
  while (x.measureText(name).width > 390 && size > 22) { size -= 2; x.font = `700 ${size}px system-ui, "Segoe UI", sans-serif`; }
  x.fillText(name, 124, sub ? 50 : 64);
  if (sub) { x.font = '500 24px system-ui, "Segoe UI", sans-serif'; x.fillStyle = 'rgba(220,232,244,0.9)'; x.fillText(sub, 126, 92); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
function placeTexture(text, kind) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 96;
  const x = c.getContext('2d');
  roundRect(x, 4, 6, 504, 84, 14); x.fillStyle = kind === 'tourism' ? 'rgba(30,70,110,0.85)' : kind === 'amenity' ? 'rgba(60,60,70,0.85)' : 'rgba(110,40,30,0.85)'; x.fill();
  x.fillStyle = '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle';
  let size = 40; x.font = `600 ${size}px system-ui, "Segoe UI", sans-serif`;
  while (x.measureText(text).width > 480 && size > 18) { size -= 2; x.font = `600 ${size}px system-ui, "Segoe UI", sans-serif`; }
  x.fillText(text, 256, 49);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Growable triangle buffer for ground decals (strips, flats): every triangle is wound to face up. */
class Buf {
  constructor() { this.p = []; this.u = []; this.i = []; }
  v(x, y, z, u, w) { this.p.push(x, y, z); this.u.push(u, w); return this.p.length / 3 - 1; }
  tri(a, b, c) {
    const P = this.p;
    const ux = P[b * 3] - P[a * 3], uz = P[b * 3 + 2] - P[a * 3 + 2], vx = P[c * 3] - P[a * 3], vz = P[c * 3 + 2] - P[a * 3 + 2];
    if (uz * vx - ux * vz >= 0) this.i.push(a, b, c); else this.i.push(a, c, b);   // y of (b−a)×(c−a) ≥ 0 → faces up
  }
  quad(a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); }
  get empty() { return this.i.length === 0; }
  geometry(upNormals = true) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2));
    g.setIndex(this.p.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.i, 1) : new THREE.Uint16BufferAttribute(this.i, 1));
    if (upNormals) { const n = new Float32Array(this.p.length); for (let k = 1; k < n.length; k += 3) n[k] = 1; g.setAttribute('normal', new THREE.BufferAttribute(n, 3)); }
    else g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

// ================================================================================================= Ashore
export class Ashore {
  constructor(app) {
    this.app = app;
    this._active = false; this.entering = false;
    this.harborId = null; this.entry = null; this.layer = null;
    this.disposables = [];
    this.pos = new THREE.Vector3(); this.y = 0; this.heading = 0; this.yaw = 0; this.pitch = -0.18; this.bob = 0;
    this.view = 'third'; this.camDist = CAM_DEFAULT; this.camDistEff = CAM_DEFAULT; this.camPos = new THREE.Vector3();
    this.keys = new Set(); this.run = false;
    this.near = null; this.prevPrompt = ''; this.prevHint = ''; this.lastHintT = 0; this.lastLightsT = 0; this.lastSignT = 0;
    this.pointers = new Map(); this.pinch = null; this.look = null; this.stick = null; this.drag = null;
    this.isTouch = (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) || (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1);
    this.buildDom();
    this.bind();
  }
  get active() { return this._active; }

  // ---------------------------------------------------------------------------------------------- DOM + input
  buildDom() {
    if (typeof document === 'undefined') return;
    const font = 'font:14px/1.35 system-ui,"Segoe UI",sans-serif;color:#dbe9f4';
    this.promptEl = document.createElement('button'); this.promptEl.type = 'button'; this.promptEl.id = 'ashorePrompt';
    this.promptEl.style.cssText = `position:fixed;left:50%;bottom:calc(19% + env(safe-area-inset-bottom));transform:translateX(-50%);min-height:44px;padding:10px 18px;background:rgba(4,12,20,.84);border:1px solid rgba(140,190,230,.45);border-radius:12px;${font};z-index:15;display:none;white-space:nowrap;cursor:pointer;box-shadow:0 6px 24px rgba(0,0,0,.35)`;
    this.promptEl.addEventListener('click', (e) => { e.stopPropagation(); this.interact(); this.promptEl.blur(); });
    this.hintEl = document.createElement('div'); this.hintEl.id = 'ashoreHintFallback';
    this.hintEl.style.cssText = `position:fixed;left:50%;top:calc(70px + env(safe-area-inset-top));transform:translateX(-50%);padding:6px 14px;background:rgba(4,12,20,.66);border-radius:999px;${font};font-size:13px;z-index:15;display:none;pointer-events:none;white-space:nowrap`;
    this.viewBtn = document.createElement('button'); this.viewBtn.type = 'button'; this.viewBtn.id = 'ashoreView';
    this.viewBtn.style.cssText = `position:fixed;right:16px;top:calc(64px + env(safe-area-inset-top));z-index:16;min-height:44px;padding:8px 14px;border-radius:10px;border:1px solid rgba(140,190,230,.45);background:rgba(4,12,20,.8);${font};display:none;cursor:pointer`;
    this.viewBtn.addEventListener('click', (e) => { e.stopPropagation(); this.toggleView(); this.viewBtn.blur(); });
    this.fadeEl = document.createElement('div'); this.fadeEl.id = 'ashoreFade';
    this.fadeEl.style.cssText = `position:fixed;inset:0;background:#02070c;opacity:0;transition:opacity .45s;pointer-events:none;z-index:14;display:flex;align-items:center;justify-content:center;${font};font-size:17px`;
    document.body.append(this.promptEl, this.hintEl, this.viewBtn, this.fadeEl);
  }
  bind() {
    const canvas = this.app.canvas;
    this._onKeyUp = (e) => { const k = String(e.key || '').toLowerCase(); this.keys.delete(k); if (k === 'shift') this.run = false; };
    this._onBlur = () => { this.keys.clear(); this.run = false; this.pointers.clear(); this.pinch = null; this.look = null; this.stick = null; this.drag = null; };
    this._onMouseMove = (e) => {
      if (!this._active || !canvas || document.pointerLockElement !== canvas) return;
      this.yaw += e.movementX * 0.0022; this.pitch = clamp(this.pitch - e.movementY * 0.0022, -1.25, this.view === 'first' ? 1.35 : 0.9);
    };
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    document.addEventListener('mousemove', this._onMouseMove);
    if (!canvas) return;
    this._onDown = (e) => {
      if (!this._active || this.panelOpen()) return;
      if (e.pointerType === 'touch') {
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const ownStick = !this.app.touchHelm?.stick;
        if (ownStick && e.clientX < innerWidth / 2 && !this.stick) { this.stick = { id: e.pointerId, x0: e.clientX, y0: e.clientY, x: 0, y: 0 }; }
        else if (!this.look) this.look = { id: e.pointerId, x: e.clientX, y: e.clientY, t0: performance.now(), moved: 0 };
        const right = [...this.pointers.entries()].filter(([id]) => id !== this.stick?.id);
        if (right.length === 2) { const [a, b] = right.map(([, p]) => p); this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), dist: this.camDist }; this.look = null; }
        try { canvas.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      } else {
        if (document.pointerLockElement !== canvas && !this.isTouch) this.lock();
        this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      }
    };
    this._onMove = (e) => {
      if (!this._active) return;
      const p = this.pointers.get(e.pointerId); if (p) { p.x = e.clientX; p.y = e.clientY; }
      if (this.pinch && e.pointerType === 'touch') {
        const right = [...this.pointers.entries()].filter(([id]) => id !== this.stick?.id).map(([, q]) => q);
        if (right.length >= 2) { const d = Math.hypot(right[0].x - right[1].x, right[0].y - right[1].y); if (d > 10) this.camDist = clamp((this.pinch.dist * this.pinch.d) / d, CAM_MIN, CAM_MAX); }
        return;
      }
      if (this.stick && e.pointerId === this.stick.id) {
        const dx = e.clientX - this.stick.x0, dy = e.clientY - this.stick.y0, R = 60, l = Math.hypot(dx, dy), k = l > R ? R / l : 1;
        this.stick.x = (dx * k) / R; this.stick.y = (-dy * k) / R;
        return;
      }
      if (this.look && e.pointerId === this.look.id) {
        const dx = e.clientX - this.look.x, dy = e.clientY - this.look.y; this.look.x = e.clientX; this.look.y = e.clientY; this.look.moved += Math.abs(dx) + Math.abs(dy);
        this.yaw += dx * 0.006; this.pitch = clamp(this.pitch - dy * 0.006, -1.25, this.view === 'first' ? 1.35 : 0.9);
        return;
      }
      if (this.drag && e.pointerId === this.drag.id && document.pointerLockElement !== canvas && e.buttons) {
        const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y; this.drag.x = e.clientX; this.drag.y = e.clientY;
        this.yaw += dx * 0.005; this.pitch = clamp(this.pitch - dy * 0.005, -1.25, this.view === 'first' ? 1.35 : 0.9);
      }
    };
    this._onUp = (e) => {
      this.pointers.delete(e.pointerId);
      if (this.pinch && this.pointers.size < 2) this.pinch = null;
      if (this.stick && e.pointerId === this.stick.id) this.stick = null;
      if (this.drag && e.pointerId === this.drag.id) this.drag = null;
      const t = this.look;
      if (t && e.pointerId === t.id) { this.look = null; if (this._active && t.moved < 10 && performance.now() - t.t0 < 350) this.interact(); }
    };
    this._onWheel = (e) => { if (!this._active || this.view !== 'third' || this.panelOpen()) return; this.camDist = clamp(this.camDist * (1 + Math.sign(e.deltaY) * 0.12), CAM_MIN, CAM_MAX); e.preventDefault(); };
    canvas.addEventListener('pointerdown', this._onDown);
    canvas.addEventListener('pointermove', this._onMove);
    canvas.addEventListener('pointerup', this._onUp);
    canvas.addEventListener('pointercancel', this._onUp);
    canvas.addEventListener('wheel', this._onWheel, { passive: false });
  }
  lock() { try { const p = this.app.canvas?.requestPointerLock?.(); if (p && p.catch) p.catch(() => {}); } catch { /* not allowed here */ } }
  unlock() { try { if (document.pointerLockElement === this.app.canvas) document.exitPointerLock(); } catch { /* ignore */ } }
  panelOpen() { const h = this.app.hud; try { return !!(h?.anyOverlayOpen?.() || h?.harborOpen?.()); } catch { return false; } }
  toggleView() {
    this.view = this.view === 'third' ? 'first' : 'third';
    if (this.view === 'third') this.pitch = clamp(this.pitch, -1.25, 0.9);
    this.updateViewBtn();
  }
  updateViewBtn() { if (!this.viewBtn) return; const key = this.isTouch ? '' : ' (V)'; this.viewBtn.textContent = (this.view === 'third' ? 'First person' : 'Third person') + key; this.viewBtn.style.display = this._active ? 'block' : 'none'; }

  /** keydown while ashore; returns true when the key was consumed. G goes back aboard only when main.js has no toggle. */
  handleKey(e) {
    if (!this._active) return false;
    const k = String(e.key || '').toLowerCase();
    if (k === 'e') { this.interact(); return true; }
    if (k === 'v' || k === 'c') { this.toggleView(); return true; }
    if (k === 't') { this.taxi(); return true; }
    if (k === 'g' && typeof this.app.toggleAshore !== 'function') { this.exit(); return true; }
    if (k === 'shift') { this.run = true; return true; }
    if (MOVE_KEYS.has(k)) { this.keys.add(k); e.preventDefault?.(); return true; }
    if (k === ' ') { e.preventDefault?.(); return true; }
    return false;
  }

  // ---------------------------------------------------------------------------------------------- enter / exit
  /** Build the on-foot layer at the harbour you are docked in and hand the camera to the walker. */
  async enter(harborId) {
    const app = this.app;
    const id = String(harborId ?? app.you?.docked ?? '');
    if (this._active) return this.harborId === id;
    if (this.entering || !id || !app.you || app.you.docked !== id) {
      if (!this.entering) app.hud?.event?.({ kind: 'warn', text: 'Moor in a harbour first, then go ashore.' });
      return false;
    }
    this.entering = true;
    try {
      let entry = app.geoms?.get?.(id) || null;
      if (!entry && app.geoms?.load) { app.hud?.event?.({ kind: 'info', text: 'Loading the harbour streets…' }); entry = await app.geoms.load(id); }
      if (!entry || !entry.geom) { app.hud?.event?.({ kind: 'warn', text: 'This harbour is not mapped yet — try again in a moment.' }); return false; }
      if (!app.you || app.you.docked !== id || this._active) return false;    // cast off (or entered) while loading
      if (app.terrain && typeof app.terrain.hasPatch === 'function' && !app.terrain.hasPatch(id)) app.terrain.addPatch?.(entry);
      if (app.interior?.active) app.interior.exit();
      this.harborId = id; this.entry = entry;
      this.build(entry);
      this._active = true;
      this.keys.clear(); this.run = false;
      this.camState = { near: app.camera.near, fov: app.camera.fov };
      app.camera.near = 0.1; app.camera.fov = 62; app.camera.updateProjectionMatrix(); app.camera.up.set(0, 1, 0);
      this.hiddenLabels = [];
      const hide = (o) => { if (o && o.visible) { o.visible = false; this.hiddenLabels.push(o); } };
      hide(app.myMesh?.userData?.label);
      app.harborMeshes?.get?.(id)?.userData?.setAshore?.(true);
      app.hud?.hideHarbor?.();
      if (this.isTouch) { app.touchHelm?.setHelmVisible?.(false); app.touchHelm?.showStick?.(true); } else this.lock();
      this.updateViewBtn();
      this.snapCamera();
      const name = app.world?.harbors?.find?.((h) => h.id === id)?.name || entry.geom.name || 'the harbour';
      app.hud?.event?.({ kind: 'info', text: this.isTouch
        ? `Ashore at ${name}. Stick to walk, drag to look, pinch to zoom, tap to use doors. Your gangway takes you back aboard.`
        : `Ashore at ${name}. WASD walk (Shift runs), mouse look, E to use doors, V first / third person, wheel zoom, G or your gangway to go back aboard.` });
      return true;
    } catch (err) {
      console.warn('[ashore] enter failed', err);
      this.teardown();
      this._active = false;
      app.hud?.event?.({ kind: 'warn', text: 'Could not go ashore here.' });
      return false;
    } finally { this.entering = false; }
  }
  /** Remove everything the layer added and give the camera back to the chase / berth view. */
  exit() {
    if (!this._active) return;
    const app = this.app;
    this._active = false;
    this.keys.clear(); this.run = false; this.pointers.clear(); this.pinch = null; this.look = null; this.stick = null; this.drag = null;
    this.unlock();
    if (this.camState) { app.camera.near = this.camState.near; app.camera.fov = this.camState.fov; app.camera.updateProjectionMatrix(); }
    app.camera.up.set(0, 1, 0);
    for (const o of this.hiddenLabels || []) o.visible = true;
    this.hiddenLabels = [];
    app.harborMeshes?.get?.(this.harborId)?.userData?.setAshore?.(false);
    if (this.isTouch) { app.touchHelm?.showStick?.(false); app.touchHelm?.setHelmVisible?.(true); }
    if (app.cam) app.cam.free = false;
    if (this.promptEl) this.promptEl.style.display = 'none';
    if (this.hintEl) this.hintEl.style.display = 'none';
    if (this.fadeEl) this.fadeEl.style.opacity = '0';
    this.prevPrompt = ''; this.prevHint = ''; this.taxiBusy = false; this.taxiIdx = -1; this.taxiOffer = null;
    app.hud?.showAshoreHint?.(null);
    this.teardown();
    this.updateViewBtn();
  }
  toggle() { if (this._active) this.exit(); else this.enter(this.app.you?.docked); }
  dispose() {
    this.exit();
    this.teardown();
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    document.removeEventListener('mousemove', this._onMouseMove);
    const c = this.app.canvas;
    if (c) { c.removeEventListener('pointerdown', this._onDown); c.removeEventListener('pointermove', this._onMove); c.removeEventListener('pointerup', this._onUp); c.removeEventListener('pointercancel', this._onUp); c.removeEventListener('wheel', this._onWheel); }
    for (const el of [this.promptEl, this.hintEl, this.viewBtn, this.fadeEl]) el?.remove();
  }
  teardown() {
    if (this.layer) {
      this.layer.parent?.remove(this.layer);
      this.layer.traverse((o) => {
        if (!o.isMesh && !o.isSprite) return;
        if (!o.isSprite) o.geometry?.dispose?.();             // sprites share one geometry with every label in the scene
        if (o.isInstancedMesh) o.dispose?.();
        const m = o.material; if (Array.isArray(m)) m.forEach((x) => x.dispose()); else m?.dispose?.();
      });
    }
    for (const d of this.disposables) d?.dispose?.();
    this.disposables = []; this.layer = null; this.poolMat = null; this.lampMat = null; this.doorLampMat = null; this.crowd = null; this.avatar = null;
    this.blds = []; this.bGrid = null; this.hardGrid = null; this.bridgeGrid = null; this.pois = []; this.places = []; this.lamps = []; this.npcs = []; this.paths = [];
  }

  // ---------------------------------------------------------------------------------------------- terrain queries (layer frame)
  waterLevel() { return Number(this.app.tideLevel) || 0; }
  /** Patch ground height (bilinear over the cell centres, same as the terrain mesh). */
  terrainH(x, z) {
    const e = this.entry, n = e.n, H = this.hF;
    let u = x / e.res + n / 2 - 0.5, v = z / e.res + n / 2 - 0.5;
    u = clamp(u, 0, n - 1.001); v = clamp(v, 0, n - 1.001);
    const i = Math.floor(u), j = Math.floor(v), fx = u - i, fy = v - j, o = j * n + i;
    return (H[o] * (1 - fx) + H[o + 1] * fx) * (1 - fy) + (H[o + n] * (1 - fx) + H[o + n + 1] * fx) * fy;
  }
  maskAt(x, z) { const e = this.entry, i = Math.floor(x / e.res + e.n / 2), j = Math.floor(z / e.res + e.n / 2); return i < 0 || j < 0 || i >= e.n || j >= e.n ? -1 : e.mask[j * e.n + i]; }
  gkey(x, z) { const gi = Math.floor((x + this.half) / GRID), gj = Math.floor((z + this.half) / GRID); return gi < 0 || gj < 0 || gi >= this.gN || gj >= this.gN ? -1 : gj * this.gN + gi; }
  gridAdd(grid, x0, z0, x1, z1, item) {
    const g0 = clamp(Math.floor((x0 + this.half) / GRID), 0, this.gN - 1), g1 = clamp(Math.floor((x1 + this.half) / GRID), 0, this.gN - 1);
    const h0 = clamp(Math.floor((z0 + this.half) / GRID), 0, this.gN - 1), h1 = clamp(Math.floor((z1 + this.half) / GRID), 0, this.gN - 1);
    for (let j = h0; j <= h1; j++) for (let i = g0; i <= g1; i++) { const k = j * this.gN + i; (grid[k] || (grid[k] = [])).push(item); }
  }
  /** Quay / pier / pontoon top inside its ring (the extrusions harbor.js draws), else null. */
  hardTop(x, z) {
    const k = this.gkey(x, z); if (k < 0) return null;
    const L = this.hardGrid[k]; if (!L) return null;
    let top = null;
    for (const h of L) if (x >= h.x0 && x <= h.x1 && z >= h.z0 && z <= h.z1 && pointInRing(x, z, h.ring)) top = Math.max(top ?? -Infinity, h.top);
    return top;
  }
  /** Bridge deck height under (x, z), or null. */
  bridgeAt(x, z) {
    const k = this.gkey(x, z); if (k < 0) return null;
    const L = this.bridgeGrid[k]; if (!L) return null;
    for (const b of L) {
      const dx = b.bx - b.ax, dz = b.bz - b.az, L2 = dx * dx + dz * dz;
      const t = L2 > 0 ? clamp(((x - b.ax) * dx + (z - b.az) * dz) / L2, 0, 1) : 0;
      const qx = b.ax + dx * t - x, qz = b.az + dz * t - z;
      if (qx * qx + qz * qz <= b.hw * b.hw) return b.y0 + (b.y1 - b.y0) * t;
    }
    return null;
  }
  groundAt(x, z) {
    const top = this.hardTop(x, z); if (top != null) return top;
    const br = this.bridgeAt(x, z); if (br != null) return br;
    return this.terrainH(x, z);
  }
  /** Solid ground for decorations (tide-independent): a structure ring, or land / quay / pontoon cells above mean sea level. */
  solidAt(x, z) {
    if (Math.abs(x) > this.half - 1 || Math.abs(z) > this.half - 1) return false;
    return this.hardTop(x, z) != null || (WALK_CODE[this.maskAt(x, z)] === 1 && this.terrainH(x, z) > 0.1);
  }
  /**
   * Where the crew member may stand: structure rings and bridges always; land / quay / pontoon cells only where the
   * ground (the same bilinear surface the terrain mesh shows) is above the water line — so the edge of a raster quay
   * that no extruded ring covers, or a beach at high tide, stops you; never breakwater rubble or water.
   */
  walkable(x, z) {
    if (Math.abs(x) > this.half - 2 || Math.abs(z) > this.half - 2) return false;
    if (this.hardTop(x, z) != null || this.bridgeAt(x, z) != null) return true;
    if (!WALK_CODE[this.maskAt(x, z)]) return false;
    return this.terrainH(x, z) > this.waterLevel() + 0.2;
  }
  /** Inside (or within `margin` of) a building footprint or tank. */
  inBuilding(x, z, margin = 0) {
    const m2 = margin * margin;
    const g0 = Math.floor((x - margin + this.half) / GRID), g1 = Math.floor((x + margin + this.half) / GRID);
    const h0 = Math.floor((z - margin + this.half) / GRID), h1 = Math.floor((z + margin + this.half) / GRID);
    for (let j = h0; j <= h1; j++) for (let i = g0; i <= g1; i++) {
      if (i < 0 || j < 0 || i >= this.gN || j >= this.gN) continue;
      const L = this.bGrid[j * this.gN + i]; if (!L) continue;
      for (const b of L) {
        if (x < b.x0 - margin || x > b.x1 + margin || z < b.z0 - margin || z > b.z1 + margin) continue;
        if (b.circle) { if (Math.hypot(x - b.cx, z - b.cz) < b.r + margin) return b; continue; }
        if (pointInRing(x, z, b.ring)) return b;
        if (margin > 0) for (let k = 0, r = b.ring, n = r.length; k < n; k++) { const a = r[k], c = r[(k + 1) % n]; if (segDist2(x, z, a[0], a[1], c[0], c[1]) < m2) return b; }
      }
    }
    return null;
  }
  canStand(x, z) {
    if (!this.walkable(x, z) || this.inBuilding(x, z, RADIUS)) return false;
    const r = RADIUS;
    return this.walkable(x + r, z) && this.walkable(x - r, z) && this.walkable(x, z + r) && this.walkable(x, z - r);
  }

  // ---------------------------------------------------------------------------------------------- build
  build(entry) {
    const app = this.app, geom = entry.geom, F = geom.features || {};
    this.teardown();
    this.half = (entry.n * entry.res) / 2; this.gN = Math.ceil((2 * this.half) / GRID);
    this.hF = new Float32Array(entry.n * entry.n);
    for (let k = 0; k < this.hF.length; k++) this.hF[k] = (entry.heights[k] - PATCH.H_OFFSET) * PATCH.H_STEP;
    this.origin = geom.origin;
    this.toXZ = (lat, lon) => { const p = toLocal(lat, lon, this.origin); return [p.x, p.z]; };
    const layer = new THREE.Group(); layer.name = 'ashore';
    this.layer = layer;
    this.placeLayer();
    app.scene.add(layer);
    const tex = makeTextures(); for (const t of Object.values(tex)) this.disposables.push(t);
    this.tex = tex;
    this.rnd = rng(hashStr(`${geom.id}:ashore`));
    // spatial indices: structures (with their walking tops), buildings (+ tanks)
    this.hardGrid = new Array(this.gN * this.gN); this.bGrid = new Array(this.gN * this.gN); this.bridgeGrid = new Array(this.gN * this.gN);
    const ringOf = (pts) => (Array.isArray(pts) ? pts.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])).map((p) => this.toXZ(p[0], p[1])) : []);
    const bbox = (ring) => { let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity; for (const p of ring) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); } return { x0, x1, z0, z1 }; };
    this.hardRings = [];
    for (const [list, top, kind] of [[F.quays, QUAY_TOP, 'quay'], [F.piers, QUAY_TOP, 'pier'], [F.pontoons, PONT_TOP, 'pontoon']]) {
      for (const f of list || []) { const ring = ringOf(f?.pts); if (ring.length < 3) continue; const h = { ring, top, kind, ...bbox(ring) }; this.hardRings.push(h); this.gridAdd(this.hardGrid, h.x0, h.z0, h.x1, h.z1, h); }
    }
    this.blds = [];
    (F.buildings || []).forEach((b, idx) => {
      const ring = ringOf(b?.pts); if (ring.length < 3) { this.blds[idx] = null; return; }
      const bb = bbox(ring); let cx = 0, cz = 0; for (const p of ring) { cx += p[0]; cz += p[1]; }
      const B = { idx, ring, ...bb, cx: cx / ring.length, cz: cz / ring.length, height: Number.isFinite(b.height) ? b.height : 8, kind: b.kind || 'building' };
      B.base = this.terrainH(B.cx, B.cz);
      this.blds[idx] = B; this.gridAdd(this.bGrid, B.x0, B.z0, B.x1, B.z1, B);
    });
    for (const t of F.tanks || []) {
      if (!Number.isFinite(t?.lat) || !Number.isFinite(t?.lon)) continue;
      const [x, z] = this.toXZ(t.lat, t.lon), r = Number.isFinite(t.radius) ? t.radius : 12;
      const T = { circle: true, cx: x, cz: z, r, x0: x - r, x1: x + r, z0: z - r, z1: z + r, height: t.height || 12, base: this.terrainH(x, z) };
      this.gridAdd(this.bGrid, T.x0, T.z0, T.x1, T.z1, T);
    }
    // spawn first: decorations are densest around where the skipper stands
    this.findSpawn(geom);
    const builders = [
      ['roads', () => this.buildRoads(F.roads || [])],
      ['areas', () => this.buildAreas(F.areas || [])],
      ['rails', () => this.buildRails(F.rails || [])],
      ['props', () => this.buildProps()],
      ['pois', () => this.buildPois(F.pois || [])],
      ['places', () => this.buildPlaces(F.places || [])],
      ['gangway', () => this.buildGangway()],
      ['crowd', () => this.buildCrowd()],
    ];
    for (const [name, fn] of builders) { try { fn(); } catch (err) { console.warn(`[ashore] ${name} skipped`, err); } }
    // the crew member
    this.avatar = makeAvatar();
    this.disposables.push({ dispose: () => this.avatar?.userData?.dispose?.() });
    layer.add(this.avatar);
    this.pos.set(this.spawn.x, 0, this.spawn.z); this.y = this.groundAt(this.spawn.x, this.spawn.z);
    this.heading = this.spawn.yaw; this.yaw = this.spawn.yaw; this.pitch = -0.18;
    this.camDist = CAM_DEFAULT; this.camDistEff = CAM_DEFAULT;
  }
  placeLayer() { const o = toLocal(this.origin.lat, this.origin.lon, this.app.origin); this.layer.position.set(o.x, 0, o.z); }

  /** On the quay next to your berth, facing the ship; also records the gangway (quay end + ship end). */
  findSpawn(geom) {
    const app = this.app, you = app.you;
    const berths = geom.berths || [];
    this.gangway = null; this.spawn = null;
    let berth = berths.find((b) => b.id === you?.berth?.id) || null;
    const ship = app.ship || you?.ship;
    let sx = 0, sz = 0;
    if (app.myMesh && this.layer) { sx = app.myMesh.position.x - this.layer.position.x; sz = app.myMesh.position.z - this.layer.position.z; }
    else if (ship) [sx, sz] = this.toXZ(ship.lat, ship.lon);
    if (!berth && berths.length) { let bd = Infinity; for (const b of berths) { const [x, z] = this.toXZ(b.lat, b.lon); const d = Math.hypot(x - sx, z - sz); if (d < bd) { bd = d; berth = b; } } if (bd > 40) berth = null; }
    if (berth) { const [x, z] = this.toXZ(berth.lat, berth.lon); if (Math.hypot(x - sx, z - sz) > 60) berth = null; }   // not actually alongside it
    const C = SHIP_CLASSES[you?.ship?.cls] || SHIP_CLASSES.coaster;
    const beam = app.myMesh?.userData?.beam || C.beam || 10;
    this.shipXZ = [sx, sz];
    if (berth) {
      const [bx, bz] = this.toXZ(berth.lat, berth.lon);
      const h = berth.hdg * D2R, tx = Math.sin(h), tz = -Math.cos(h);
      let best = null;
      for (const s of [1, -1]) {
        const nx = -tz * s, nz = tx * s;
        let face = null;
        for (let d = 2; d <= 40; d += 0.5) if (this.solidAt(bx + nx * d, bz + nz * d)) { face = d; break; }
        if (face == null) continue;
        let ok = 0; for (let d = face + 2; d <= face + 14; d += 3) if (this.walkable(bx + nx * d, bz + nz * d)) ok++;
        if (!best || ok > best.ok || (ok === best.ok && face < best.face)) best = { nx, nz, face, ok };
      }
      if (best) {
        const { nx, nz, face } = best;
        // the ship lies along the berth; use the hull's actual centre when it is near
        const cx = Math.hypot(sx - bx, sz - bz) < 60 ? sx : bx, cz = Math.hypot(sx - bx, sz - bz) < 60 ? sz : bz;
        // the gangway lands a little aft of midships (the berth number board stands at the berth centre)
        const len = app.myMesh?.userData?.length || C.length || 40;
        const along = (cx - bx) * tx + (cz - bz) * tz + Math.min(10, Math.max(0, len / 2 - 4));
        const gx = bx + tx * along, gz = bz + tz * along;
        this.gangway = { qx: gx + nx * (face + 1.4), qz: gz + nz * (face + 1.4), sx: gx + nx * (beam / 2 - 0.4), sz: gz + nz * (beam / 2 - 0.4), nx, nz };
        for (let d = face + 3; d <= face + 30; d += 1) {
          const x = gx + nx * d, z = gz + nz * d;
          if (this.canStand(x, z)) { this.spawn = { x, z, yaw: yawOf(-nx, -nz) }; return; }
        }
      }
    }
    // not alongside a berth (anchored in the basin, legacy harbour): the quay nearest the ship; a launch takes you out
    let bestP = null, bd = Infinity;
    for (let r = 4; r <= 900 && !bestP; r += r < 160 ? 4 : 12) for (let a = 0; a < 36; a++) {
      const x = sx + Math.cos((a / 36) * Math.PI * 2) * r, z = sz + Math.sin((a / 36) * Math.PI * 2) * r;
      if (this.canStand(x, z)) { const d = Math.hypot(x - sx, z - sz); if (d < bd) { bd = d; bestP = [x, z]; } }
    }
    if (!bestP) bestP = [sx, sz];
    this.spawn = { x: bestP[0], z: bestP[1], yaw: yawOf(sx - bestP[0], sz - bestP[1]) };
    const dx = sx - bestP[0], dz = sz - bestP[1], L = Math.hypot(dx, dz) || 1;
    // a boarding point at the water's edge; the plank is only drawn when the hull is really within reach
    this.gangway = { qx: bestP[0] + (dx / L) * 1.5, qz: bestP[1] + (dz / L) * 1.5, sx: sx - (dx / L) * (beam / 2 - 0.4), sz: sz - (dz / L) * (beam / 2 - 0.4), nx: -dx / L, nz: -dz / L, launch: L > beam / 2 + 14 };
  }
  nearSpawn(x, z, r = DETAIL_R) { return Math.hypot(x - this.spawn.x, z - this.spawn.z) <= r; }
  mat(kind, opts = {}) {
    const m = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0.02, polygonOffset: true, polygonOffsetFactor: opts.off ?? -2, polygonOffsetUnits: (opts.off ?? -2) * 2, ...opts.extra });
    if (opts.map) m.map = opts.map;
    if (opts.color != null) m.color.setHex(opts.color);
    m.name = kind;
    return m;
  }
  addMesh(geometry, material, renderOrder = 0) { const m = new THREE.Mesh(geometry, material); m.renderOrder = renderOrder; m.frustumCulled = true; this.layer.add(m); return m; }

  /** Road ribbons, sidewalks, lane markings, bridges; collects lamp / bench / car / tree spots and the crowd paths. */
  buildRoads(roads) {
    const bufs = { asphalt: new Buf(), asphaltLight: new Buf(), paving: new Buf(), gravel: new Buf(), sidewalk: new Buf(), marking: new Buf(), parapet: new Buf() };
    const lampSpots = [], benchSpots = [], carSpots = [], treeSpots = [];
    this.paths = [];
    this.roadSegs = new Array(this.gN * this.gN);
    const WL = this.waterLevel();
    for (const road of roads) {
      const pts = (road?.pts || []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])).map((p) => this.toXZ(p[0], p[1]));
      if (pts.length < 2) continue;
      const st = ROAD_STYLE[road.kind] || ROAD_STYLE.residential;
      const w = clamp(Number(road.width) || 6, 1.2, 40), hw = w / 2;
      const S = resample(pts, 4);
      if (S.length < 2) continue;
      // ground under each sample; water runs between land become bridge decks (or gaps when too long)
      for (const s of S) { s.land = this.solidAt(s.x, s.z); s.g = s.land ? this.groundAt(s.x, s.z) : null; s.ok = s.land; }
      for (let i = 0; i < S.length; i++) {
        if (S[i].land) continue;
        let j = i; while (j < S.length && !S[j].land) j++;
        const a = S[i - 1], b = S[j];
        if (a && b && b.d - a.d <= 350) {
          const y0 = Math.max(a.g, WL + 2.2), y1 = Math.max(b.g, WL + 2.2);
          for (let k = i; k < j; k++) { const t = (S[k].d - a.d) / Math.max(1, b.d - a.d); S[k].g = y0 + (y1 - y0) * t; S[k].ok = true; S[k].bridge = true; }
          const addSeg = (p, q, ya, yb) => { const br = { ax: p.x, az: p.z, bx: q.x, bz: q.z, hw: hw + 0.2, y0: ya, y1: yb }; this.gridAdd(this.bridgeGrid, Math.min(p.x, q.x) - hw, Math.min(p.z, q.z) - hw, Math.max(p.x, q.x) + hw, Math.max(p.z, q.z) + hw, br); };
          addSeg(a, b, y0, y1);
          // ramps: up to 3 samples (12 m) of land on each side climb to the deck, so the crew member can walk on
          for (const [end, dirK, y] of [[i - 1, -1, y0], [j, 1, y1]]) {
            const far = S[clamp(end + dirK * 3, 0, S.length - 1)];
            if (!far.land || far === S[end]) { S[end].g = y; continue; }
            const span = Math.abs(far.d - S[end].d) || 1;
            for (let k = end; k !== end + dirK * 4 && k >= 0 && k < S.length; k += dirK) { const t = Math.abs(S[k].d - S[end].d) / span; if (t <= 1 && S[k].land) S[k].g = y + (S[k].g - y) * t; }
            addSeg(far, S[end], far.g, y);
          }
        }
        i = j;
      }
      const buf = bufs[st.mat];
      const uS = 1 / 4;
      let prevL = -1, prevR = -1;
      for (let i = 0; i < S.length; i++) {
        const s = S[i];
        if (!s.ok) { prevL = prevR = -1; continue; }
        const lx = s.x + s.nx * hw, lz = s.z + s.nz * hw, rx = s.x - s.nx * hw, rz = s.z - s.nz * hw;
        let yl = s.g, yr = s.g;
        if (!s.bridge) {
          if (this.solidAt(lx, lz)) yl = Math.max(s.g, this.groundAt(lx, lz));
          if (this.solidAt(rx, rz)) yr = Math.max(s.g, this.groundAt(rx, rz));
        }
        const L = buf.v(lx, yl + st.y, lz, 0, s.d * uS), R = buf.v(rx, yr + st.y, rz, w * uS, s.d * uS);
        if (prevL >= 0) buf.quad(prevL, prevR, R, L);
        prevL = L; prevR = R;
        // bridge parapets
        if (s.bridge && i > 0 && S[i - 1].ok) {
          const p = S[i - 1];
          for (const sg of [1, -1]) {
            const ax = p.x + p.nx * (hw + 0.15) * sg, az = p.z + p.nz * (hw + 0.15) * sg, bx = s.x + s.nx * (hw + 0.15) * sg, bz = s.z + s.nz * (hw + 0.15) * sg;
            const a0 = bufs.parapet.v(ax, p.g + st.y, az, 0, 0), a1 = bufs.parapet.v(ax, p.g + st.y + 1.1, az, 0, 1), b0 = bufs.parapet.v(bx, s.g + st.y, bz, 1, 0), b1 = bufs.parapet.v(bx, s.g + st.y + 1.1, bz, 1, 1);
            bufs.parapet.i.push(a0, b0, b1, a0, b1, a1);
          }
        }
      }
      // sidewalks along town roads (where there is land under them)
      if (st.walk) {
        for (const sg of [1, -1]) {
          let pa = -1, pb = -1;
          for (const s of S) {
            const off = (hw + 1.1) * sg, cx = s.x + s.nx * off, cz = s.z + s.nz * off;
            const ok = s.ok && (s.bridge || (this.solidAt(cx, cz) && !this.inBuilding(cx, cz, 0)));
            if (!ok) { pa = pb = -1; continue; }
            const g = s.bridge ? s.g : Math.max(s.g, this.groundAt(cx, cz));
            const ax = s.x + s.nx * (hw + 0.1) * sg, az = s.z + s.nz * (hw + 0.1) * sg, bx = s.x + s.nx * (hw + 2.1) * sg, bz = s.z + s.nz * (hw + 2.1) * sg;
            const A = bufs.sidewalk.v(ax, g + st.y + 0.03, az, 0, s.d / 2), B = bufs.sidewalk.v(bx, g + st.y + 0.03, bz, 1, s.d / 2);
            if (pa >= 0) bufs.sidewalk.quad(pa, pb, B, A);
            pa = A; pb = B;
          }
        }
      }
      // lane markings: dashed centre line on primary / secondary roads, edge lines + dashes on motorways
      if (st.mark && w >= 6) {
        const stripe = (a, b, off, wid) => {
          const ax = a.x + a.nx * off, az = a.z + a.nz * off, bx = b.x + b.nx * off, bz = b.z + b.nz * off;
          const px = (a.nx * wid) / 2, pz = (a.nz * wid) / 2;
          const y = (a.g + b.g) / 2 + st.y + 0.02;
          const i0 = bufs.marking.v(ax + px, y, az + pz, 0, 0), i1 = bufs.marking.v(ax - px, y, az - pz, 1, 0), i2 = bufs.marking.v(bx - px, y, bz - pz, 1, 1), i3 = bufs.marking.v(bx + px, y, bz + pz, 0, 1);
          bufs.marking.quad(i0, i1, i2, i3);
        };
        const dashed = (off, len, gap, wid) => {
          for (let d0 = 2; d0 + len <= S[S.length - 1].d; d0 += len + gap) {
            const a = this.sampleAt(S, d0), b = this.sampleAt(S, d0 + len);
            if (a && b && a.ok && b.ok) stripe(a, b, off, wid);
          }
        };
        const solid = (off, wid) => { for (let i = 1; i < S.length; i++) if (S[i].ok && S[i - 1].ok) stripe(S[i - 1], S[i], off, wid); };
        if (st.mark === 'motorway') { solid(hw - 0.7, 0.2); solid(-(hw - 0.7), 0.2); dashed(0, 4, 8, 0.18); }
        else dashed(0, 3, 6, 0.15);
      }
      // walking paths for the crowd (sidewalk centre / footway centre), spots for lamps, benches, parked cars, trees
      const pathOff = st.walk ? hw + 1.1 : road.kind === 'footway' ? 0 : road.kind === 'service' ? hw + 0.6 : null;
      if (pathOff != null && road.kind !== 'motorway') {
        for (const sg of pathOff === 0 ? [0] : [1, -1]) {
          const pts2 = []; let d = 0;
          for (const s of S) { if (!s.ok) { if (pts2.length >= 2) this.addPath(pts2.slice(), d); pts2.length = 0; continue; } const px = s.x + s.nx * pathOff * sg, pz = s.z + s.nz * pathOff * sg; if (pts2.length) d += Math.hypot(px - pts2[pts2.length - 1][0], pz - pts2[pts2.length - 1][1]); else d = 0; pts2.push([px, pz]); }
          if (pts2.length >= 2) this.addPath(pts2, d);
        }
      }
      if (st.lamps) {
        let next = st.lamps * this.rnd(), side = 1;
        for (const s of S) {
          if (s.d < next || !s.ok) continue;
          next = s.d + st.lamps; side = -side;
          if (!this.nearSpawn(s.x, s.z)) continue;
          const off = (st.walk ? hw + 1.9 : hw + 0.6) * side;
          lampSpots.push({ x: s.x + s.nx * off, z: s.z + s.nz * off, y: s.g, nx: -s.nx * side, nz: -s.nz * side, bridge: !!s.bridge });
        }
      }
      if (st.benches) for (const s of S) if (s.ok && !s.bridge && s.d % 45 < 4 && s.d > 10 && this.nearSpawn(s.x, s.z, 900)) benchSpots.push({ x: s.x + s.nx * (hw + 0.8), z: s.z + s.nz * (hw + 0.8), yaw: yawOf(-s.nx, -s.nz) });
      if (st.parked && w >= 5) {
        for (const s of S) {
          if (!s.ok || s.bridge || s.d < 8 || s.d > S[S.length - 1].d - 8 || this.rnd() > 0.22 || !this.nearSpawn(s.x, s.z, 1200)) continue;
          const sg = this.rnd() < 0.5 ? 1 : -1, off = (hw - 1.15) * sg;
          carSpots.push({ x: s.x + s.nx * off, z: s.z + s.nz * off, yaw: yawOf(s.tx * sg, s.tz * sg) });
        }
      }
      if (st.trees && st.walk) for (const s of S) if (s.ok && !s.bridge && s.d % 24 < 4 && this.rnd() < 0.5 && this.nearSpawn(s.x, s.z, 1200)) { const sg = this.rnd() < 0.5 ? 1 : -1; treeSpots.push({ x: s.x + s.nx * (hw + 2.6) * sg, z: s.z + s.nz * (hw + 2.6) * sg, street: true }); }
      // segments for "is this on a road" queries (props avoid carriageways)
      for (let i = 0; i + 1 < S.length; i++) { const a = S[i], b = S[i + 1]; this.gridAdd(this.roadSegs, Math.min(a.x, b.x) - hw, Math.min(a.z, b.z) - hw, Math.max(a.x, b.x) + hw, Math.max(a.z, b.z) + hw, { ax: a.x, az: a.z, bx: b.x, bz: b.z, hw }); }
    }
    const T = this.tex;
    const mats = {
      asphalt: this.mat('asphalt', { map: T.asphalt, off: -3 }), asphaltLight: this.mat('asphaltLight', { map: T.asphalt, color: 0xb9b9b9, off: -3 }),
      paving: this.mat('paving', { map: T.paving, off: -2 }), gravel: this.mat('gravel', { map: T.gravel, off: -2 }),
      sidewalk: this.mat('sidewalk', { map: T.paving, color: 0xd8d2c8, off: -2 }),
      marking: this.mat('marking', { color: 0xecebe2, off: -4, extra: { roughness: 0.6 } }),
      parapet: new THREE.MeshStandardMaterial({ color: 0x8d8a84, roughness: 0.9, side: THREE.DoubleSide }),
    };
    for (const [k, b] of Object.entries(bufs)) { if (b.empty) { mats[k].dispose(); continue; } this.addMesh(b.geometry(k !== 'parapet'), mats[k], k === 'marking' ? 3 : 2); }
    this.lampSpots = lampSpots; this.benchSpots = benchSpots; this.carSpots = carSpots; this.treeSpots = treeSpots;
  }
  sampleAt(S, d) {
    if (d < 0 || d > S[S.length - 1].d) return null;
    let lo = 0, hi = S.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m].d <= d) lo = m; else hi = m; }
    const a = S[lo], b = S[hi], t = b.d > a.d ? (d - a.d) / (b.d - a.d) : 0;
    return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, nx: a.nx, nz: a.nz, g: a.g + ((b.g ?? a.g) - a.g) * t, ok: a.ok && b.ok };
  }
  addPath(pts, len) {
    if (len < 25) return;
    const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    let cx = 0, cz = 0; for (const p of pts) { cx += p[0]; cz += p[1]; }
    this.paths.push({ pts, cum, len: cum[cum.length - 1], cx: cx / pts.length, cz: cz / pts.length });
  }
  onRoad(x, z, margin = 0) {
    const k = this.gkey(x, z); if (k < 0 || !this.roadSegs?.[k]) return false;
    for (const s of this.roadSegs[k]) if (segDist2(x, z, s.ax, s.az, s.bx, s.bz) < (s.hw + margin) ** 2) return true;
    return false;
  }

  /** Land-use flats: triangulated, subdivided to follow the ground, triangles over water dropped. */
  buildAreas(areas) {
    const bufs = new Map();
    this.treeAreaSpots = [];
    const WL = this.waterLevel();
    for (const a of areas) {
      const st = AREA_STYLE[a?.kind]; if (!st) continue;
      const ring = (a.pts || []).filter((p) => Array.isArray(p) && Number.isFinite(p[0])).map((p) => this.toXZ(p[0], p[1]));
      if (ring.length < 3) continue;
      let tris;
      try { tris = THREE.ShapeUtils.triangulateShape(ring.map((p) => new THREE.Vector2(p[0], p[1])), []); } catch { continue; }
      let buf = bufs.get(a.kind); if (!buf) { buf = new Buf(); bufs.set(a.kind, buf); }
      const uvS = st.pattern === 'parking' ? 1 / 10 : 1 / 6;
      const emit = (A, B, C, depth) => {
        const ab = Math.hypot(A[0] - B[0], A[1] - B[1]), bc = Math.hypot(B[0] - C[0], B[1] - C[1]), ca = Math.hypot(C[0] - A[0], C[1] - A[1]);
        const m = Math.max(ab, bc, ca);
        if (m > 14 && depth < 9) {
          if (m === ab) { const M = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2]; emit(A, M, C, depth + 1); emit(M, B, C, depth + 1); }
          else if (m === bc) { const M = [(B[0] + C[0]) / 2, (B[1] + C[1]) / 2]; emit(A, B, M, depth + 1); emit(A, M, C, depth + 1); }
          else { const M = [(C[0] + A[0]) / 2, (C[1] + A[1]) / 2]; emit(A, B, M, depth + 1); emit(M, B, C, depth + 1); }
          return;
        }
        const gx = (A[0] + B[0] + C[0]) / 3, gz = (A[1] + B[1] + C[1]) / 3;
        if (!WALK_CODE[this.maskAt(gx, gz)]) return;
        const y = (p) => Math.max(this.terrainH(p[0], p[1]), WL + 0.05) + st.y;
        const i0 = buf.v(A[0], y(A), A[1], A[0] * uvS, A[1] * uvS), i1 = buf.v(B[0], y(B), B[1], B[0] * uvS, B[1] * uvS), i2 = buf.v(C[0], y(C), C[1], C[0] * uvS, C[1] * uvS);
        buf.tri(i0, i1, i2);
      };
      for (const t of tris) emit(ring[t[0]], ring[t[1]], ring[t[2]], 0);
      if ((a.kind === 'wood' || a.kind === 'park' || a.kind === 'grass') && this.nearSpawn(ring[0][0], ring[0][1], DETAIL_R + 400)) this.treeAreaSpots.push({ ring, kind: a.kind });
    }
    const order = ['residential', 'industrial', 'port', 'sand', 'grass', 'park', 'wood', 'parking'];
    for (const [kind, buf] of bufs) {
      if (buf.empty) continue;
      const st = AREA_STYLE[kind], o = order.indexOf(kind);
      const m = this.mat(`area-${kind}`, { map: st.pattern === 'parking' ? this.tex.parking : this.tex.noise, color: st.pattern === 'parking' ? 0xffffff : st.color, off: -1 - o * 0.1 });
      this.addMesh(buf.geometry(true), m, 1);
    }
  }

  /** Ballast beds, steel rails (instanced bars) and sleepers near the spawn. */
  buildRails(rails) {
    const bed = new Buf(), bars = [], sleepers = [];
    for (const r of rails) {
      const pts = (r?.pts || []).filter((p) => Array.isArray(p) && Number.isFinite(p[0])).map((p) => this.toXZ(p[0], p[1]));
      if (pts.length < 2) continue;
      const S = resample(pts, 6);
      let pa = -1, pb = -1;
      for (let i = 0; i < S.length; i++) {
        const s = S[i];
        if (!this.solidAt(s.x, s.z)) { pa = pb = -1; continue; }
        s.g = this.groundAt(s.x, s.z);
        const A = bed.v(s.x + s.nx * 1.6, s.g + 0.1, s.z + s.nz * 1.6, 0, s.d / 3), B = bed.v(s.x - s.nx * 1.6, s.g + 0.1, s.z - s.nz * 1.6, 1, s.d / 3);
        if (pa >= 0) bed.quad(pa, pb, B, A);
        pa = A; pb = B;
        const p = S[i - 1];
        if (p && p.g != null && this.nearSpawn(s.x, s.z, DETAIL_R)) {
          for (const sg of [1, -1]) bars.push({ ax: p.x + p.nx * 0.72 * sg, az: p.z + p.nz * 0.72 * sg, ay: p.g + 0.32, bx: s.x + s.nx * 0.72 * sg, bz: s.z + s.nz * 0.72 * sg, by: s.g + 0.32 });
          if (this.nearSpawn(s.x, s.z, 900)) for (let d = 0; d < Math.hypot(s.x - p.x, s.z - p.z); d += 0.7) { const t = d / Math.max(0.01, Math.hypot(s.x - p.x, s.z - p.z)); sleepers.push({ x: p.x + (s.x - p.x) * t, z: p.z + (s.z - p.z) * t, y: p.g + (s.g - p.g) * t + 0.2, yaw: yawOf(s.tx, s.tz) }); }
        }
      }
    }
    if (!bed.empty) this.addMesh(bed.geometry(true), this.mat('ballast', { map: this.tex.gravel, color: 0x8a847a, off: -3 }), 2);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), sc = new THREE.Vector3();
    if (bars.length) {
      const im = new THREE.InstancedMesh(new THREE.BoxGeometry(0.08, 0.15, 1), new THREE.MeshStandardMaterial({ color: 0x8a8d90, metalness: 0.75, roughness: 0.35 }), bars.length);
      bars.forEach((b, i) => { const L = Math.hypot(b.bx - b.ax, b.bz - b.az, b.by - b.ay); e.set(Math.atan2(b.by - b.ay, Math.hypot(b.bx - b.ax, b.bz - b.az)), Math.atan2(b.bx - b.ax, b.bz - b.az), 0, 'YXZ'); im.setMatrixAt(i, m4.compose(p.set((b.ax + b.bx) / 2, (b.ay + b.by) / 2, (b.az + b.bz) / 2), q.setFromEuler(e), sc.set(1, 1, L + 0.05))); });
      this.layer.add(im);
    }
    if (sleepers.length) {
      const n = Math.min(5000, sleepers.length);
      const im = new THREE.InstancedMesh(new THREE.BoxGeometry(2.4, 0.14, 0.24), new THREE.MeshStandardMaterial({ color: 0x5b4a3a, roughness: 0.95 }), n);
      for (let i = 0; i < n; i++) { const s = sleepers[i]; im.setMatrixAt(i, m4.compose(p.set(s.x, s.y, s.z), q.setFromEuler(e.set(0, s.yaw, 0)), sc.set(1, 1, 1))); }
      this.layer.add(im);
    }
  }

  /** Street lamps, benches, quay posts, parked cars, container stacks, trees (all instanced). */
  buildProps() {
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), sc = new THREE.Vector3(), col = new THREE.Color();
    const R = this.rnd;
    // ---- street lamps
    const lamps = (this.lampSpots || []).filter((l) => (l.bridge || this.solidAt(l.x, l.z)) && !this.inBuilding(l.x, l.z, 0.5)).slice(0, 700);
    this.lamps = lamps;
    if (lamps.length) {
      const poleG = new THREE.CylinderGeometry(0.06, 0.09, 6.2, 6); poleG.translate(0, 3.1, 0);
      const armG = new THREE.BoxGeometry(0.08, 0.08, 1.3); armG.translate(0, 6.1, 0.55);
      const headG = new THREE.BoxGeometry(0.34, 0.14, 0.6); headG.translate(0, 6.02, 1.15);
      const metal = new THREE.MeshStandardMaterial({ color: 0x3a4048, metalness: 0.5, roughness: 0.5 });
      this.lampMat = new THREE.MeshStandardMaterial({ color: 0xfff4d8, emissive: 0xffd28a, emissiveIntensity: 0.2, roughness: 0.4 });
      const pole = new THREE.InstancedMesh(mergeGeometries([poleG, armG]), metal, lamps.length), head = new THREE.InstancedMesh(headG, this.lampMat, lamps.length);
      lamps.forEach((l, i) => { const y = (l.bridge ? l.y : this.groundAt(l.x, l.z)); l.gy = y; m4.compose(p.set(l.x, y, l.z), q.setFromEuler(e.set(0, Math.atan2(l.nx, l.nz), 0)), one); pole.setMatrixAt(i, m4); head.setMatrixAt(i, m4); l.hx = l.x + l.nx * 1.15; l.hz = l.z + l.nz * 1.15; l.hy = y + 5.9; });
      this.layer.add(pole, head);
      // pools of lamp light on the ground (additive decals, faded in at night — no real lights, no shader recompiles)
      const poolTex = canvasTexture(128, (x, S) => { const g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2); g.addColorStop(0, 'rgba(255,214,150,1)'); g.addColorStop(0.45, 'rgba(255,200,130,0.45)'); g.addColorStop(1, 'rgba(255,190,120,0)'); x.clearRect(0, 0, S, S); x.fillStyle = g; x.fillRect(0, 0, S, S); });
      poolTex.wrapS = poolTex.wrapT = THREE.ClampToEdgeWrapping; this.disposables.push(poolTex);
      this.poolMat = new THREE.MeshBasicMaterial({ map: poolTex, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -12 });
      const pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(15, 15).rotateX(-Math.PI / 2), this.poolMat, lamps.length);
      lamps.forEach((l, i) => pools.setMatrixAt(i, m4.compose(p.set(l.hx, Math.max(this.groundAt(l.hx, l.hz), l.gy) + 0.2, l.hz), q.identity(), one)));
      pools.renderOrder = 4; pools.visible = false;
      this.pools = pools; this.layer.add(pools);
    }
    // ---- benches (footways, parks)
    const benches = (this.benchSpots || []).filter((b) => this.solidAt(b.x, b.z) && !this.inBuilding(b.x, b.z, 1) && !this.onRoad(b.x, b.z, 0.2)).slice(0, 160);
    if (benches.length) {
      const g = mergeGeometries([new THREE.BoxGeometry(1.6, 0.06, 0.45).translate(0, 0.45, 0), new THREE.BoxGeometry(1.6, 0.4, 0.05).translate(0, 0.72, 0.21), new THREE.BoxGeometry(0.06, 0.45, 0.4).translate(-0.7, 0.22, 0), new THREE.BoxGeometry(0.06, 0.45, 0.4).translate(0.7, 0.22, 0)]);
      const im = new THREE.InstancedMesh(g, new THREE.MeshStandardMaterial({ color: 0x6b4a2e, roughness: 0.8 }), benches.length);
      benches.forEach((b, i) => im.setMatrixAt(i, m4.compose(p.set(b.x, this.groundAt(b.x, b.z), b.z), q.setFromEuler(e.set(0, b.yaw, 0)), one)));
      this.layer.add(im);
    }
    // ---- quay posts along the waterside edges of quays and piers (clear of the berths)
    const berthsXZ = (this.entry.geom.berths || []).map((b) => this.toXZ(b.lat, b.lon));
    const posts = [];
    for (const h of this.hardRings) {
      if (h.kind === 'pontoon' || !this.nearSpawn(h.x0, h.z0, DETAIL_R + 600)) continue;
      const r = h.ring;
      for (let k = 0; k < r.length && posts.length < 700; k++) {
        const a = r[k], b = r[(k + 1) % r.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (L < 8) continue;
        const tx = (b[0] - a[0]) / L, tz = (b[1] - a[1]) / L;
        let nx = tz, nz = -tx;
        const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
        if (pointInRing(mx + nx * 0.8, mz + nz * 0.8, r)) { nx = -nx; nz = -nz; }   // n points out of the quay
        if (this.solidAt(mx + nx * 3, mz + nz * 3)) continue;                        // not a waterside edge
        for (let d = 6; d < L - 4; d += 12) {
          const x = a[0] + tx * d - nx * 1.3, z = a[1] + tz * d - nz * 1.3;
          if (berthsXZ.some((bp) => Math.hypot(bp[0] - x, bp[1] - z) < 26)) continue;
          posts.push([x, z]);
        }
      }
    }
    if (posts.length) {
      const im = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.11, 0.13, 0.95, 8).translate(0, 0.47, 0), new THREE.MeshStandardMaterial({ color: 0xd9b52a, roughness: 0.6 }), posts.length);
      posts.forEach(([x, z], i) => im.setMatrixAt(i, m4.compose(p.set(x, this.groundAt(x, z), z), q.identity(), one)));
      this.layer.add(im);
    }
    // ---- parked cars (kerbside) and in parking areas
    const cars = [];
    for (const c of this.carSpots || []) if (this.solidAt(c.x, c.z) && !this.inBuilding(c.x, c.z, 1.2)) cars.push(c);
    for (const a of (this.entry.geom.features?.areas || []).filter((x) => x.kind === 'parking')) {
      const ring = a.pts.map((pp) => this.toXZ(pp[0], pp[1]));
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity; for (const pp of ring) { x0 = Math.min(x0, pp[0]); x1 = Math.max(x1, pp[0]); z0 = Math.min(z0, pp[1]); z1 = Math.max(z1, pp[1]); }
      if (!this.nearSpawn((x0 + x1) / 2, (z0 + z1) / 2, DETAIL_R)) continue;
      for (let z = z0 + 3; z < z1 - 2 && cars.length < 320; z += 5.5) for (let x = x0 + 1.5; x < x1 - 1; x += 2.6) {
        if (R() < 0.45 || !pointInRing(x, z, ring) || !this.solidAt(x, z) || this.inBuilding(x, z, 1) || this.onRoad(x, z, 0.5)) continue;
        cars.push({ x, z, yaw: R() < 0.5 ? 0 : Math.PI });
      }
    }
    if (cars.length) {
      const n = Math.min(320, cars.length);
      const body = mergeGeometries([new THREE.BoxGeometry(1.78, 0.72, 4.3).translate(0, 0.62, 0), new THREE.BoxGeometry(1.56, 0.5, 2.2).translate(0, 1.22, 0.15)]);
      const glass = new THREE.BoxGeometry(1.6, 0.36, 2.0).translate(0, 1.22, 0.15);
      const wheels = mergeGeometries([[-0.8, 1.35], [0.8, 1.35], [-0.8, -1.35], [0.8, -1.35]].map(([x, z]) => new THREE.CylinderGeometry(0.33, 0.33, 0.22, 10).rotateZ(Math.PI / 2).translate(x, 0.33, z)));
      const imB = new THREE.InstancedMesh(body, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.45 }), n);
      const imG = new THREE.InstancedMesh(glass, new THREE.MeshStandardMaterial({ color: 0x1b2836, roughness: 0.15, metalness: 0.6 }), n);
      const imW = new THREE.InstancedMesh(wheels, new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.9 }), n);
      for (let i = 0; i < n; i++) { const c = cars[i]; m4.compose(p.set(c.x, this.groundAt(c.x, c.z) + 0.02, c.z), q.setFromEuler(e.set(0, c.yaw, 0)), one); imB.setMatrixAt(i, m4); imG.setMatrixAt(i, m4); imW.setMatrixAt(i, m4); imB.setColorAt(i, col.setHex(CAR_COLORS[Math.floor(R() * CAR_COLORS.length)])); }
      if (imB.instanceColor) imB.instanceColor.needsUpdate = true;
      this.layer.add(imB, imG, imW);
    }
    // ---- container stacks on the port aprons near the spawn (never in front of a door or the gangway)
    const boxes = [];
    const stacks = [];
    const doors = (this.entry.geom.features?.pois || []).filter((d) => Number.isFinite(d?.door?.lat)).map((d) => this.toXZ(d.door.lat, d.door.lon));
    for (const a of (this.entry.geom.features?.areas || []).filter((x) => x.kind === 'port')) {
      const ring = a.pts.map((pp) => this.toXZ(pp[0], pp[1]));
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity; for (const pp of ring) { x0 = Math.min(x0, pp[0]); x1 = Math.max(x1, pp[0]); z0 = Math.min(z0, pp[1]); z1 = Math.max(z1, pp[1]); }
      const area = Math.abs((x1 - x0) * (z1 - z0));
      // align with the longest edge of the apron
      let best = 0, ang = 0; for (let k = 0; k < ring.length; k++) { const s = ring[k], t = ring[(k + 1) % ring.length]; const L = Math.hypot(t[0] - s[0], t[1] - s[1]); if (L > best) { best = L; ang = Math.atan2(t[0] - s[0], t[1] - s[1]); } }
      const want = Math.min(14, Math.round(area / 6000));
      for (let tries = 0, made = 0; tries < want * 12 && made < want && boxes.length < 260; tries++) {
        const x = x0 + R() * (x1 - x0), z = z0 + R() * (z1 - z0);
        if (!pointInRing(x, z, ring) || !this.nearSpawn(x, z, DETAIL_R) || stacks.some((s) => Math.hypot(s[0] - x, s[1] - z) < 18)) continue;
        const ux = Math.sin(ang), uz = Math.cos(ang), vx = uz, vz = -ux;
        const cols = 1 + Math.floor(R() * 3), tiers = 1 + Math.floor(R() * 3);
        let ok = true;
        for (let c = 0; c < cols && ok; c++) for (const s of [-6.5, 0, 6.5]) {
          const px = x + vx * c * 2.6 + ux * s, pz = z + vz * c * 2.6 + uz * s;
          if (!this.solidAt(px, pz) || this.inBuilding(px, pz, 2) || this.onRoad(px, pz, 1.5) || Math.hypot(px - this.spawn.x, pz - this.spawn.z) < 20
            || (this.gangway && Math.hypot(px - this.gangway.qx, pz - this.gangway.qz) < 20) || doors.some((d) => Math.hypot(px - d[0], pz - d[1]) < 16)) ok = false;
        }
        if (!ok) continue;
        stacks.push([x, z]); made++;
        const g = this.groundAt(x, z);
        for (let c = 0; c < cols; c++) for (let t = 0; t < tiers; t++) boxes.push({ x: x + vx * c * 2.6, z: z + vz * c * 2.6, y: g + 1.3 + t * 2.59, yaw: ang, color: CONT_COLORS[Math.floor(R() * CONT_COLORS.length)] });
      }
    }
    this.containers = stacks.map(([x, z]) => ({ x, z }));
    if (boxes.length) {
      const cg = new THREE.BoxGeometry(2.44, 2.59, 12.19);
      { const uv = cg.attributes.uv; for (let k = 0; k < uv.count; k++) uv.setX(k, uv.getX(k) * (k >= 16 && k < 24 ? 1 : 6)); }   // ribs repeat along the long sides
      this.tex.corrugated.repeat.set(1, 1);
      const im = new THREE.InstancedMesh(cg, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.65, metalness: 0.25, map: this.tex.corrugated }), boxes.length);
      boxes.forEach((b, i) => { im.setMatrixAt(i, m4.compose(p.set(b.x, b.y, b.z), q.setFromEuler(e.set(0, b.yaw, 0)), one)); im.setColorAt(i, col.setHex(b.color)); });
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      this.layer.add(im);
      // containers block walking like small buildings
      boxes.forEach((b) => { if (b.y > this.groundAt(b.x, b.z) + 2) return; const c = Math.cos(b.yaw), s = Math.sin(b.yaw); const ring = [[-1.22, -6.1], [1.22, -6.1], [1.22, 6.1], [-1.22, 6.1]].map(([u, v]) => [b.x + u * c + v * s, b.z - u * s + v * c]); const B = { ring, x0: Math.min(...ring.map((r) => r[0])), x1: Math.max(...ring.map((r) => r[0])), z0: Math.min(...ring.map((r) => r[1])), z1: Math.max(...ring.map((r) => r[1])), cx: b.x, cz: b.z, height: 2.6, base: this.groundAt(b.x, b.z), container: true }; this.gridAdd(this.bGrid, B.x0, B.z0, B.x1, B.z1, B); });
    }
    // ---- trees: street trees + scattered in woods / parks / grass
    const trees = [];
    for (const t of this.treeSpots || []) if (this.solidAt(t.x, t.z) && !this.inBuilding(t.x, t.z, 2.5) && !this.onRoad(t.x, t.z, 0.6)) trees.push(t);
    for (const a of this.treeAreaSpots || []) {
      const ring = a.ring;
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity; for (const pp of ring) { x0 = Math.min(x0, pp[0]); x1 = Math.max(x1, pp[0]); z0 = Math.min(z0, pp[1]); z1 = Math.max(z1, pp[1]); }
      const per = a.kind === 'wood' ? 90 : a.kind === 'park' ? 260 : 900;
      const want = Math.min(260, Math.round(((x1 - x0) * (z1 - z0)) / per));
      for (let k = 0, made = 0; k < want * 3 && made < want && trees.length < 1100; k++) {
        const x = x0 + R() * (x1 - x0), z = z0 + R() * (z1 - z0);
        if (!pointInRing(x, z, ring) || !this.nearSpawn(x, z, DETAIL_R) || !this.walkable(x, z) || this.inBuilding(x, z, 2) || this.onRoad(x, z, 1)) continue;
        trees.push({ x, z }); made++;
      }
    }
    if (trees.length) {
      const n = Math.min(1100, trees.length);
      const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.14, 0.2, 2.6, 6).translate(0, 1.3, 0), new THREE.MeshStandardMaterial({ color: 0x5a4330, roughness: 0.95 }), n);
      const crown = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1.9, 1).translate(0, 3.9, 0), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true }), n);
      for (let i = 0; i < n; i++) {
        const t = trees[i], s = 0.75 + R() * 0.7;
        m4.compose(p.set(t.x, this.groundAt(t.x, t.z), t.z), q.setFromEuler(e.set(0, R() * 6.28, 0)), sc.set(s, s * (0.9 + R() * 0.3), s));
        trunk.setMatrixAt(i, m4); crown.setMatrixAt(i, m4);
        crown.setColorAt(i, col.setRGB(0.22 + R() * 0.12, 0.38 + R() * 0.16, 0.16 + R() * 0.08));
      }
      if (crown.instanceColor) crown.instanceColor.needsUpdate = true;
      this.layer.add(trunk, crown);
      for (let i = 0; i < n; i++) { const t = trees[i]; this.gridAdd(this.bGrid, t.x - 0.3, t.z - 0.3, t.x + 0.3, t.z + 0.3, { circle: true, cx: t.x, cz: t.z, r: 0.25, x0: t.x - 0.3, x1: t.x + 0.3, z0: t.z - 0.3, z1: t.z + 0.3, height: 3, base: 0, tree: true }); }
    }
  }

  /** POI doors: door leaf, awning, wall sign and lamp on the building; a glowing name sprite above (visible ≤ 200 m). */
  buildPois(pois) {
    this.pois = [];
    const blds = this.blds;
    const doorMat = new THREE.MeshStandardMaterial({ color: 0x2b2420, roughness: 0.6 });
    this.doorLampMat = new THREE.MeshStandardMaterial({ color: 0xfff1d0, emissive: 0xffd9a0, emissiveIntensity: 0.3 });
    const metal = new THREE.MeshStandardMaterial({ color: 0x8c949c, metalness: 0.6, roughness: 0.4 });
    for (const P of pois) {
      if (!P?.door || !Number.isFinite(P.door.lat)) continue;
      const info = POI_INFO[P.kind]; if (!info) continue;
      const [dx, dz] = this.toXZ(P.door.lat, P.door.lon);
      const b = P.building >= 0 ? blds[P.building] : null;
      // wall point and outward normal
      let wx = dx, wz = dz, nx = 0, nz = 1;
      if (b) {
        let bd = Infinity;
        for (let k = 0; k < b.ring.length; k++) {
          const a = b.ring[k], c = b.ring[(k + 1) % b.ring.length], L2 = (c[0] - a[0]) ** 2 + (c[1] - a[1]) ** 2;
          const t = L2 > 0 ? clamp(((dx - a[0]) * (c[0] - a[0]) + (dz - a[1]) * (c[1] - a[1])) / L2, 0, 1) : 0;
          const qx = a[0] + (c[0] - a[0]) * t, qz = a[1] + (c[1] - a[1]) * t, d = Math.hypot(qx - dx, qz - dz);
          if (d < bd) { bd = d; wx = qx; wz = qz; }
        }
        const l = Math.hypot(dx - wx, dz - wz) || 1; nx = (dx - wx) / l; nz = (dz - wz) / l;
      } else {
        // a stand-alone dock (fuel pump): face the nearest water so the sign reads from the berth
        let bestD = Infinity;
        for (let a = 0; a < 16; a++) {
          const ux = Math.sin((a / 16) * Math.PI * 2), uz = -Math.cos((a / 16) * Math.PI * 2);
          for (let d = 2; d <= 40; d += 2) if (!this.solidAt(dx + ux * d, dz + uz * d)) { if (d < bestD) { bestD = d; nx = ux; nz = uz; } break; }
        }
      }
      const g = this.groundAt(dx, dz);
      const grp = new THREE.Group(); grp.position.set(wx, 0, wz); grp.rotation.y = Math.atan2(nx, nz); this.layer.add(grp);
      const signTex = signTexture(info, P.name || info.short, info.label.split(' — ')[1] || info.short); this.disposables.push(signTex);
      if (b) {
        // (harbor.js window strips stand up to 0.13 m proud of the wall: everything here sits in front of them)
        const door = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 2.3), doorMat); door.position.set(0, g + 1.15, 0.17); grp.add(door);
        const jamb = new THREE.Mesh(new THREE.BoxGeometry(1.8, 2.5, 0.08), metal); jamb.position.set(0, g + 1.25, 0.14); grp.add(jamb);
        const glass = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.9), new THREE.MeshStandardMaterial({ color: 0x9fc6e0, emissive: 0xffd9a0, emissiveIntensity: 0.25, roughness: 0.15, metalness: 0.4 })); glass.position.set(0, g + 1.55, 0.18); grp.add(glass);
        const awn = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.12, 1.3), new THREE.MeshStandardMaterial({ color: new THREE.Color(info.color), roughness: 0.7 })); awn.position.set(0, g + 2.75, 0.8); awn.rotation.x = 0.12; grp.add(awn);
        const wall = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 0.9), new THREE.MeshBasicMaterial({ map: signTex, transparent: true })); wall.position.set(0, g + 3.6, 0.26); grp.add(wall);
        const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), this.doorLampMat); lamp.position.set(1.15, g + 2.5, 0.35); grp.add(lamp);
      } else {
        // a fuel pump island with a canopy (or a kiosk post for the other kinds)
        const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.9, 0.55), new THREE.MeshStandardMaterial({ color: new THREE.Color(info.color), roughness: 0.5 })); body.position.set(0, g + 0.95, -1.4); grp.add(body);
        const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.3), new THREE.MeshStandardMaterial({ color: 0x0b1a10, emissive: 0x33ff88, emissiveIntensity: 0.6 })); scr.position.set(0, g + 1.45, -1.12); grp.add(scr);
        const hose = new THREE.Mesh(new THREE.TorusGeometry(0.35, 0.035, 6, 16, Math.PI), new THREE.MeshStandardMaterial({ color: 0x111111 })); hose.position.set(0.48, g + 1.0, -1.4); hose.rotation.y = Math.PI / 2; grp.add(hose);
        for (const [x, z] of [[-2.6, -3], [2.6, -3], [-2.6, 1.2], [2.6, 1.2]]) { const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 4.2, 8), metal); post.position.set(x, g + 2.1, z); grp.add(post); }
        const roof = new THREE.Mesh(new THREE.BoxGeometry(6, 0.3, 5), new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.6 })); roof.position.set(0, g + 4.3, -0.9); grp.add(roof);
        const fascia = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 1.1), new THREE.MeshBasicMaterial({ map: signTex, transparent: true })); fascia.position.set(0, g + 4.3, 1.62); grp.add(fascia);
        const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), this.doorLampMat); lamp.position.set(0, g + 4.1, -0.9); grp.add(lamp);
      }
      const spriteMat = new THREE.SpriteMaterial({ map: signTex, depthTest: false, depthWrite: false, transparent: true });
      const sprite = new THREE.Sprite(spriteMat); sprite.renderOrder = 20;
      const top = g + (b ? 5.6 : 6.4);
      sprite.position.set(dx, top, dz); sprite.scale.set(7.2, 1.8, 1); sprite.visible = false;
      this.layer.add(sprite);
      this.pois.push({ ...P, info, x: dx, z: dz, g, sprite, wall: [wx, wz], n: [nx, nz] });
    }
    this.disposables.push(doorMat, metal);
  }
  /** Small street signs for real shops / tourism / other amenities (OSM). */
  buildPlaces(places) {
    this.places = [];
    for (const pl of places.slice(0, 120)) {
      if (!Number.isFinite(pl?.lat) || !pl.name) continue;
      const [x, z] = this.toXZ(pl.lat, pl.lon);
      if (!this.nearSpawn(x, z, DETAIL_R) || !this.solidAt(x, z)) continue;
      const t = placeTexture(pl.name, pl.kind); this.disposables.push(t);
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false }));
      s.position.set(x, this.groundAt(x, z) + 3.4, z); s.scale.set(4.2, 0.79, 1); s.visible = false; s.renderOrder = 5;
      this.layer.add(s); this.places.push({ x, z, sprite: s });
    }
  }
  /** A gangway (plank, treads, hand rails) from the quay up to your ship's deck, in the layer frame. */
  buildGangway() {
    const gw = this.gangway; if (!gw || gw.launch) return;
    const app = this.app;
    const qy = this.groundAt(gw.qx, gw.qz) + 0.05;
    const deck = (app.myMesh ? app.myMesh.position.y : this.waterLevel()) + (app.myMesh?.userData?.freeboard ?? 3) + 0.05;
    const a = new THREE.Vector3(gw.qx, qy, gw.qz), b = new THREE.Vector3(gw.sx, deck, gw.sz);
    const L = a.distanceTo(b);
    if (!(L > 0.5) || L > 40) return;
    const parts = [new THREE.BoxGeometry(1.0, 0.08, L)];
    for (const s of [-0.5, 0.5]) {
      parts.push(new THREE.BoxGeometry(0.04, 0.04, L).translate(s, 1.0, 0));
      for (let k = 0; k <= Math.floor(L / 1.2); k++) parts.push(new THREE.BoxGeometry(0.035, 1.0, 0.035).translate(s, 0.5, -L / 2 + k * 1.2));
    }
    for (let k = 0; k < Math.floor(L / 0.45); k++) parts.push(new THREE.BoxGeometry(0.95, 0.03, 0.05).translate(0, 0.055, -L / 2 + 0.2 + k * 0.45));
    const mesh = new THREE.Mesh(mergeGeometries(parts), new THREE.MeshStandardMaterial({ color: 0xa9b0b6, metalness: 0.6, roughness: 0.4 }));
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), b.clone().sub(a).normalize());
    this.layer.add(mesh);
    gw.qy = qy; gw.deck = deck;
  }
  /** Pedestrians on sidewalks / footways near the crew member. */
  buildCrowd() {
    const nearLen = this.paths.reduce((s, p) => s + (Math.hypot(p.cx - this.spawn.x, p.cz - this.spawn.z) < 700 ? p.len : 0), 0);
    const count = this.paths.length ? clamp(Math.round(nearLen / 110), 10, 30) : 0;
    this.npcs = [];
    if (!count) return;
    this.crowd = new Crowd(count, hashStr(this.harborId || 'crowd'));
    this.layer.add(this.crowd.group);
    for (let i = 0; i < count; i++) { const n = { i, path: null, s: 0, dir: 1, speed: 1.05 + this.rnd() * 0.55, phase: this.rnd() * 6.28, pause: 0 }; this.placeNpc(n, true); this.npcs.push(n); }
  }
  placeNpc(n, initial) {
    const ax = this.pos?.x ?? this.spawn.x, az = this.pos?.z ?? this.spawn.z;
    const cands = this.paths.filter((p) => Math.hypot(p.cx - ax, p.cz - az) < CROWD_R + p.len / 2);
    if (!cands.length) { n.path = null; return; }
    for (let tries = 0; tries < 8; tries++) {
      const p = cands[Math.floor(this.rnd() * cands.length)];
      const s = this.rnd() * p.len;
      const q = this.pathPoint(p, s);
      const d = Math.hypot(q[0] - ax, q[1] - az);
      if (d > CROWD_R || (!initial && d < 45 && tries < 6)) continue;
      n.path = p; n.s = s; n.dir = this.rnd() < 0.5 ? 1 : -1; return;
    }
    n.path = cands[0]; n.s = 0;
  }
  pathPoint(p, s) {
    const c = p.cum; let lo = 0, hi = c.length - 1;
    s = clamp(s, 0, p.len);
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= s) lo = m; else hi = m; }
    const t = c[hi] > c[lo] ? (s - c[lo]) / (c[hi] - c[lo]) : 0, a = p.pts[lo], b = p.pts[hi];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, b[0] - a[0], b[1] - a[1]];
  }

  // ---------------------------------------------------------------------------------------------- per frame
  update(dt) {
    const app = this.app;
    if (!this._active) return;
    if (!app.you || app.you.docked !== this.harborId) { this.exit(); return; }
    dt = clamp(Number(dt) || 0, 0, 0.25);
    this.placeLayer();
    const panel = this.panelOpen() || this.taxiBusy;
    if (panel) { if (this.keys.size) this.keys.clear(); if (!this.taxiBusy) this.unlock(); }
    // ---- movement (camera-relative), collision, ground following
    let mx = 0, mz = 0;
    if (!panel) {
      if (this.keys.has('w') || this.keys.has('arrowup')) mz += 1;
      if (this.keys.has('s') || this.keys.has('arrowdown')) mz -= 1;
      if (this.keys.has('a') || this.keys.has('arrowleft')) mx -= 1;
      if (this.keys.has('d') || this.keys.has('arrowright')) mx += 1;
      const st = app.touchHelm?.stick?.active ? app.touchHelm.stick : this.stick;
      if (st && (st.active !== false)) { mx += clamp(st.x || 0, -1, 1); mz += clamp(st.y || 0, -1, 1); }
    }
    const l = Math.hypot(mx, mz);
    const moving = l > 0.08;
    const touchStick = app.touchHelm?.stick?.active ? app.touchHelm.stick : this.stick;
    const running = this.run || (!!touchStick && Math.hypot(touchStick.x || 0, touchStick.y || 0) > 0.95);
    if (moving) {
      if (l > 1) { mx /= l; mz /= l; }
      const spd = running ? RUN_SPEED : WALK_SPEED;
      const fx = Math.sin(this.yaw), fz = -Math.cos(this.yaw), rx = Math.cos(this.yaw), rz = Math.sin(this.yaw);
      const vx = (fx * mz + rx * mx) * spd * dt, vz = (fz * mz + rz * mx) * spd * dt;
      const steps = Math.max(1, Math.ceil(Math.hypot(vx, vz) / 0.3));       // ≤ 30 cm per collision test (slow frames)
      for (let k = 0; k < steps; k++) if (!this.tryMove(vx / steps, vz / steps)) break;
      const want = this.view === 'first' ? this.yaw : Math.atan2(vx, -vz);
      let dh = want - this.heading; dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      this.heading += dh * Math.min(1, dt * 10);
    } else if (this.view === 'first') this.heading = this.yaw;
    const gy = this.groundAt(this.pos.x, this.pos.z);
    this.y += (gy - this.y) * Math.min(1, dt * (gy < this.y ? 9 : 14));
    // ---- the crew member
    if (this.avatar) {
      const bob = this.avatar.userData.animate(dt, moving, running);
      this.avatar.position.set(this.pos.x, this.y + bob, this.pos.z);
      this.avatar.rotation.y = -this.heading;
      this.avatar.visible = this.view === 'third';
    }
    this.updateCamera(dt);
    this.updateCrowd(dt);
    this.updateInteract();
    const now = performance.now();
    if (now - this.lastSignT > 200) { this.lastSignT = now; this.updateSigns(); }
    if (now - this.lastLightsT > 500) { this.lastLightsT = now; this.updateLights(); }
  }
  tryMove(dx, dz) {
    const p = this.pos;
    const stuck = !this.canStand(p.x, p.z);   // spawned on an edge: let the walker step out freely towards solid ground
    const curG = this.groundAt(p.x, p.z);
    const ok = (x, z) => (stuck ? this.walkable(x, z) && !this.inBuilding(x, z, 0.05) : this.canStand(x, z)) && this.groundAt(x, z) - curG <= STEP_UP;
    if (ok(p.x + dx, p.z + dz)) { p.x += dx; p.z += dz; return true; }
    if (ok(p.x + dx, p.z)) { p.x += dx; return true; }
    if (ok(p.x, p.z + dz)) { p.z += dz; return true; }
    return false;
  }
  /** Is the point inside a solid volume (building / tank / container) for the camera? */
  cameraBlocked(x, y, z) {
    const b = this.inBuilding(x, z, 0.25);
    if (!b || b.tree) return false;
    const top = (b.base ?? this.terrainH(b.cx, b.cz)) + (b.height || 8) + (b.container ? 0 : 1);
    return y < top;
  }
  updateCamera(dt) {
    const cam = this.app.camera, L = this.layer.position;
    const cp = Math.cos(this.pitch);
    const dir = new THREE.Vector3(Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
    if (this.view === 'first') {
      const eye = new THREE.Vector3(this.pos.x, this.y + EYE, this.pos.z);
      cam.position.copy(eye).add(L);
      cam.lookAt(eye.add(dir).add(L));
      this.camPos.copy(cam.position);
      return;
    }
    const head = new THREE.Vector3(this.pos.x, this.y + 1.55, this.pos.z);
    // pull the camera in when a footprint (or the ground) stands between it and the crew member
    let dist = this.camDist;
    for (let t = 0.4; t <= this.camDist; t += 0.3) {
      const x = head.x - dir.x * t, y = head.y - dir.y * t + 0.35 * (t / this.camDist), z = head.z - dir.z * t;
      if (this.cameraBlocked(x, y, z)) { dist = Math.max(0.6, t - 0.45); break; }
    }
    this.camDistEff += (dist - this.camDistEff) * Math.min(1, dt * (dist < this.camDistEff ? 20 : 4));
    const d = this.camDistEff;
    const want = new THREE.Vector3(head.x - dir.x * d, head.y - dir.y * d + 0.35, head.z - dir.z * d);
    const floor = Math.max(this.solidAt(want.x, want.z) ? this.groundAt(want.x, want.z) : -Infinity, this.waterLevel() + 0.3) + 0.35;
    if (want.y < floor) want.y = floor;
    cam.position.copy(want).add(L);
    cam.lookAt(head.clone().add(L));
    this.camPos.copy(cam.position);
  }
  /** Teleport the camera to its target this frame (after entering), no easing. */
  snapCamera() { this.camDistEff = this.camDist; if (this.layer) this.updateCamera(1); }
  updateCrowd(dt) {
    if (!this.crowd || !this.npcs.length) return;
    for (const n of this.npcs) {
      if (!n.path) { this.crowd.hide(n.i); if (Math.random() < 0.02) this.placeNpc(n, false); continue; }
      if (n.pause > 0) n.pause -= dt;
      else {
        n.s += n.dir * n.speed * dt;
        if (n.s < 0 || n.s > n.path.len) { n.dir = -n.dir; n.s = clamp(n.s, 0, n.path.len); if (this.rnd() < 0.3) n.pause = 1 + this.rnd() * 3; }
        n.phase += dt * n.speed * 4.4;
      }
      const q = this.pathPoint(n.path, n.s);
      if (Math.hypot(q[0] - this.pos.x, q[1] - this.pos.z) > CROWD_DROP_R) { this.placeNpc(n, false); continue; }
      const y = this.groundAt(q[0], q[1]);
      this.crowd.set(n.i, q[0], y, q[1], Math.atan2(-q[2] * n.dir, -q[3] * n.dir), n.phase, n.pause <= 0);
    }
    this.crowd.commit();
  }
  /** Nearest usable thing (door, own gangway, another skipper's ship) → prompt; nearest POI → hint line. */
  updateInteract() {
    const app = this.app, x = this.pos.x, z = this.pos.z;
    let best = null, bd = Infinity;
    for (const p of this.pois) { const d = Math.hypot(p.x - x, p.z - z); if (d < USE_RANGE && d < bd) { bd = d; best = { kind: 'poi', poi: p, label: `${p.name || p.info.short} — ${p.info.label.split(' — ')[1] || p.info.label}` }; } }
    const gw = this.gangway;
    if (gw) { const d = Math.hypot(gw.qx - x, gw.qz - z); if (d < GANGWAY_RANGE && d < bd) { bd = d; best = { kind: 'aboard', label: gw.launch ? 'Take the launch back to your ship' : `Go aboard ${app.you?.name ? `— ${app.you.name}` : 'your ship'}` }; } }
    for (const o of app.others?.values?.() || []) {
      if (o.docked !== this.harborId || !o.cur) continue;
      const [ox, oz] = this.toXZ(o.cur.lat, o.cur.lon), C = SHIP_CLASSES[o.cls] || { length: 40, beam: 10 };
      const h = (o.cur.hdg || 0) * D2R, tx = Math.sin(h) * C.length / 2, tz = -Math.cos(h) * C.length / 2;
      const d = Math.sqrt(segDist2(x, z, ox - tx, oz - tz, ox + tx, oz + tz)) - C.beam / 2;
      if (d < SHIP_RANGE && d < bd) { bd = d; best = { kind: 'ship', other: o, label: `Trade / convoy with ${o.name}` }; }
    }
    this.near = best;
    const panel = this.panelOpen();
    let nearestPoi = Infinity; for (const p of this.pois) nearestPoi = Math.min(nearestPoi, Math.hypot(p.x - x, p.z - z));
    this.taxiOffer = !best && !this.taxiBusy && this.pois.length > 0 && nearestPoi > TAXI_MIN ? this.taxiTarget() : null;
    const text = panel ? '' : best ? `${this.isTouch ? 'Tap' : 'E'} — ${best.label}` : this.taxiOffer ? `${this.isTouch ? 'Tap' : 'T'} — harbour taxi to ${this.taxiOffer.name}` : '';
    if (text !== this.prevPrompt && this.promptEl) { this.prevPrompt = text; this.promptEl.textContent = text; this.promptEl.style.display = text ? 'block' : 'none'; }
    const now = performance.now();
    if (now - this.lastHintT > 250) {
      this.lastHintT = now;
      let np = null, nd = Infinity;
      for (const p of this.pois) { const d = Math.hypot(p.x - x, p.z - z); if (d < nd) { nd = d; np = p; } }
      const nm = np ? np.name || np.info.short : '';
      const what = np && !nm.toLowerCase().includes(np.info.short.toLowerCase()) ? ` (${np.info.short})` : '';
      const hint = np && !panel ? `${nm}${what} · ${nd < 1000 ? `${Math.round(nd)} m` : `${(nd / 1000).toFixed(1)} km`} ${compass(np.x - x, np.z - z)}` : '';
      if (hint !== this.prevHint) {
        this.prevHint = hint;
        if (typeof app.hud?.showAshoreHint === 'function') { app.hud.showAshoreHint(hint || null); if (this.hintEl) this.hintEl.style.display = 'none'; }
        else if (this.hintEl) { this.hintEl.textContent = hint; this.hintEl.style.display = hint ? 'block' : 'none'; }
      }
    }
  }
  interact() {
    if (!this._active || this.panelOpen() || this.taxiBusy) return;
    const n = this.near, app = this.app;
    if (!n) { if (this.taxiOffer) this.taxi(); return; }
    if (n.kind === 'aboard') { this.exit(); return; }
    if (n.kind === 'ship') {
      const o = n.other;
      this.unlock();
      if (typeof app.hud?.prompt === 'function') app.hud.prompt(`ashore-${o.id}`, `<b>${escapeHtml(o.name)}</b> is moored here. Trade goods or invite her skipper to sail in convoy?`, [
        { label: 'Trade', primary: true, fn: () => this.openTab('players') },
        { label: 'Convoy', fn: () => app.net?.action?.('convoy_invite', { targetId: o.id }) },
        { label: 'Not now', fn: () => {} },
      ]);
      else this.openTab('players');
      return;
    }
    const p = n.poi;
    if (p.kind === 'police') {
      const w = app.you?.wanted || 0;
      app.hud?.event?.({ kind: w ? 'warn' : 'info', text: w ? `Harbour police: "We have our eye on you, skipper." (wanted level ${w})` : 'Harbour police: "All quiet. Fair winds, skipper."' });
      return;
    }
    this.openTab(p.info.tab);
  }
  /** Next taxi stop: the doors in a fixed round (harbourmaster → market → … → your gangway), skipping where you stand. */
  taxiTarget() {
    const stops = [];
    for (const k of TAXI_ORDER) {
      if (k === 'aboard') { if (this.spawn) stops.push({ key: 'aboard', name: 'your ship', x: this.spawn.x, z: this.spawn.z, yaw: this.spawn.yaw }); continue; }
      const p = this.pois.find((q) => q.kind === k); if (!p) continue;
      const nx = p.n?.[0] ?? 0, nz = p.n?.[1] ?? 1;
      stops.push({ key: k, name: p.name || p.info.short, x: p.x + nx * 3.5, z: p.z + nz * 3.5, yaw: yawOf(-nx, -nz) });
    }
    if (!stops.length) return null;
    const start = (this.taxiIdx ?? -1) + 1;
    for (let k = 0; k < stops.length; k++) {
      const s = stops[(start + k) % stops.length];
      if (Math.hypot(s.x - this.pos.x, s.z - this.pos.z) > 30) return { ...s, idx: (start + k) % stops.length };
    }
    return null;
  }
  /** Harbour taxi: fade out, ride to the next stop, fade in facing its door. */
  taxi() {
    if (!this._active || this.taxiBusy || this.panelOpen()) return;
    const t = this.taxiTarget(); if (!t) return;
    this.taxiBusy = true; this.taxiIdx = t.idx; this.keys.clear();
    if (this.fadeEl) { this.fadeEl.textContent = `Harbour taxi → ${t.name}`; this.fadeEl.style.opacity = '1'; }
    setTimeout(() => {
      if (this._active) {
        let x = t.x, z = t.z;
        if (!this.canStand(x, z)) { let best = null, bd = Infinity; for (let r = 1; r <= 24 && !best; r += 1) for (let a = 0; a < 16; a++) { const px = t.x + Math.cos((a / 16) * Math.PI * 2) * r, pz = t.z + Math.sin((a / 16) * Math.PI * 2) * r; if (this.canStand(px, pz)) { const d = Math.hypot(px - t.x, pz - t.z); if (d < bd) { bd = d; best = [px, pz]; } } } if (best) [x, z] = best; }
        this.pos.set(x, 0, z); this.y = this.groundAt(x, z); this.heading = t.yaw; this.yaw = t.yaw; this.pitch = -0.18;
        for (const n of this.npcs) this.placeNpc(n, true);
        this.snapCamera();
      }
      if (this.fadeEl) this.fadeEl.style.opacity = '0';
      setTimeout(() => { this.taxiBusy = false; }, 450);
    }, 650);
  }
  /** Open the harbour panel at a section (hud.openHarborTab, else the server's harbour payload via 'dock'). */
  openTab(tab) {
    const app = this.app;
    this.keys.clear(); this.unlock();
    if (typeof app.hud?.openHarborTab === 'function') app.hud.openHarborTab(tab || 'overview');
    else app.net?.action?.('dock');
  }
  updateSigns() {
    const x = this.pos.x, z = this.pos.z;
    for (const p of this.pois) {
      const d = Math.hypot(p.x - x, p.z - z);
      p.sprite.visible = d < SIGN_RANGE;
      if (p.sprite.visible) { const s = clamp(d / 35, 1, 4); p.sprite.scale.set(7.2 * s, 1.8 * s, 1); p.sprite.position.y = p.g + (p.building >= 0 ? 5.6 : 6.4) + (s - 1) * 1.2; p.sprite.material.opacity = d < 8 ? 0.35 : 1; }
    }
    for (const pl of this.places) pl.sprite.visible = Math.hypot(pl.x - x, pl.z - z) < PLACE_RANGE;
  }
  /** Street lamps, door lamps and their light pools follow the day / night cycle (app.night 0..1). */
  updateLights() {
    const night = clamp(Number(this.app.night) || 0, 0, 1);
    if (this.lampMat) this.lampMat.emissiveIntensity = 0.15 + night * 3.2;
    if (this.doorLampMat) this.doorLampMat.emissiveIntensity = 0.3 + night * 3;
    if (this.poolMat) { const k = clamp((night - 0.25) / 0.5, 0, 1); this.poolMat.opacity = 0.55 * k; if (this.pools) this.pools.visible = k > 0.01; }
  }
}

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
