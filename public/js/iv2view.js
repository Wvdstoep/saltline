// Interiors v2 — offline viewer (docs/INTERIORS-V2-CONTRACT.md §8.3, Lane T). No game server: a stub app with a scene,
// a camera, a flat ocean and the sun from ?t=<hour>; builds the walkable plan of ?model=<id> with the game's own
// Interior drawing (v2 renderer for v2 plans) and puts the camera at a named shot.
//   iv2view.html?model=ultramax64&shot=bridge[&light=night][&deck=<id>][&phone=1][&v=1][&x=&y=&z=&yaw=&pitch=]
// The page sets window.__iv2view = { ready, stats, shots } for scripted captures.
import * as THREE from 'three';
import { Interior } from './interior.js';
import { planFromGA } from './gaplan.js';
import { buildPlan } from './shipplan.js';
import { WalkMap } from './walker.js';
import { SHIP_CLASSES } from '/shared/constants.js';
import { buildZoned, visibleZones } from './gaprops.js';
import { CruiseCrowd, wantsCrowd } from './iv2crowd.js';

const Q = new URLSearchParams(location.search);
const model = Q.get('model') || 'ultramax64', shotName = Q.get('shot') || 'bridge', light = Q.get('light') || 'day';
const phone = Q.get('phone') === '1', hour = Number(Q.get('t') ?? (light === 'night' ? 1 : 11));
if (Q.get('v') === '1' || Q.get('iv2') === '0') globalThis.__iv2 = false;

const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;   // as main.js
const scene = new THREE.Scene();
const day = light === 'night' ? 0 : Math.max(0, Math.sin(((hour - 6) / 12) * Math.PI));
scene.background = new THREE.Color(0x0b1626).lerp(new THREE.Color(0x9cc4e4), day);
const sun = new THREE.DirectionalLight(0xfff2d0, 0.35 + 2.0 * day); sun.position.set(300, 800, 200); scene.add(sun);
const hemi = new THREE.HemisphereLight(0xbfd9ee, 0x2a3a48, 0.45 + 0.6 * day); scene.add(hemi);
const ocean = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), new THREE.MeshStandardMaterial({ color: new THREE.Color(0x0a2a40).lerp(new THREE.Color(0x2a6a90), day), roughness: 0.3, metalness: 0.2 }));
ocean.rotation.x = -Math.PI / 2; ocean.position.y = 0; scene.add(ocean);
const camera = new THREE.PerspectiveCamera(phone ? 80 : 70, innerWidth / innerHeight, 0.08, 4000);

const plan = (SHIP_CLASSES[model] && !model.includes('~')) && Q.get('legacy') === '1' ? buildPlan(model, SHIP_CLASSES[model]) : planFromGA(model, { deck: Q.get('deck') || null });
const map = new WalkMap(plan);
const app = { scene, canvas, camera, dayK: day, gloomK: 0, you: { ship: { cls: model, throttle: 0 }, fuel: 100, cond: 100 }, ship: { throttle: 0, rudder: 0 }, wx: { rain: 0 }, hud: {} };
const I = Object.create(Interior.prototype);
I.app = app; I.textures = []; I.isTouch = phone; I.plan = plan; I.map = map; I.pos = new THREE.Vector3(); I.y = 0;
I.mats = I.makeMaterials(plan.style);
const root = new THREE.Group(); scene.add(root);
const groups = plan.v === 2 ? (await import('./iv2draw.js')).buildInteriorV2(I, plan, root, { phone }) : (plan.zones?.length ? buildZoned(I, plan, root) : null);

// ------------------------------------------------------------------------------------------------ shots
const rooms = plan.rooms;
const area = (r) => (r.x1 - r.x0) * (r.z1 - r.z0);
const find = (pred) => rooms.filter(pred).sort((a, b) => area(b) - area(a))[0] || null;
const bySpace = (sp) => find((r) => r.space === sp && r.walk !== false);
/** Camera in room r: from the door (stepped inside) towards the far side, eye 1.62 m. */
function fromDoor(r, { back = 0.45, lookY = 1.15, side = null } = {}) {
  const d = plan.doors.find((q) => (q.a === r.id || q.b === r.id) && (!side || q.side === side)) || plan.doors.find((q) => q.a === r.id || q.b === r.id);
  if (!d) return corner(r);
  const mine = d.a === r.id, sd = mine ? d.side : { n: 's', s: 'n', e: 'w', w: 'e' }[d.side];
  const ns = sd === 'n' || sd === 's', c = { n: r.z0, s: r.z1, w: r.x0, e: r.x1 }[sd], dir = { n: 1, s: -1, w: 1, e: -1 }[sd];
  const x = ns ? d.at : c + dir * back, z = ns ? c + dir * back : d.at;
  return { x, y: r.y + 1.62, z, tx: (r.x0 + r.x1) / 2 + (ns ? 0 : dir * (r.x1 - r.x0) * 0.3), ty: r.y + lookY, tz: (r.z0 + r.z1) / 2 + (ns ? dir * (r.z1 - r.z0) * 0.3 : 0), room: r };
}
function corner(r, k = 0) {
  const cs = [[r.x0 + 0.45, r.z1 - 0.45], [r.x1 - 0.45, r.z1 - 0.45], [r.x1 - 0.45, r.z0 + 0.45], [r.x0 + 0.45, r.z0 + 0.45]];
  for (let i = 0; i < 4; i++) { const [x, z] = cs[(k + i) % 4]; if (map.standAt(x, z, r.y, 0.1) != null && !map.blocked(x, z, r.y)) return { x, y: r.y + 1.62, z, tx: (r.x0 + r.x1) / 2, ty: r.y + 1.0, tz: (r.z0 + r.z1) / 2, room: r }; }
  const [x, z] = cs[k % 4]; return { x, y: r.y + 1.62, z, tx: (r.x0 + r.x1) / 2, ty: r.y + 1.0, tz: (r.z0 + r.z1) / 2, room: r };
}
const SHOTS = {
  bridge: () => { const r = rooms.find((q) => q.kind === 'bridge' && !q.id.startsWith('wing')) || bySpace('bridge'); const cz = r.z0 + 0.75; return { x: 0.6, y: r.y + 1.72, z: Math.min(r.z1 - 0.4, cz + 3.4), tx: 0, ty: r.y + 1.05, tz: r.z0 - 2, room: r }; },
  bridge_back: () => { const r = rooms.find((q) => q.kind === 'bridge' && !q.id.startsWith('wing')); return { x: -1.0, y: r.y + 1.65, z: r.z0 + 1.6, tx: 1, ty: r.y + 1.0, tz: r.z1, room: r }; },
  wing: () => { const r = rooms.find((q) => q.id === 'wing-stbd') || rooms.find((q) => q.id === 'wing-port'); return r ? { x: (r.x0 + r.x1) / 2, y: r.y + 1.65, z: r.z1 - 0.4, tx: (r.x0 + r.x1) / 2 - 3, ty: r.y + 1, tz: r.z0 - 4, room: r } : null; },
  corridor: () => { const r = rooms.filter((q) => q.space === 'corridor' && String(q.zone).startsWith('house')).sort((a, b) => Math.max(b.x1 - b.x0, b.z1 - b.z0) - Math.max(a.x1 - a.x0, a.z1 - a.z0))[2] || bySpace('corridor'); const ax = r.x1 - r.x0 > r.z1 - r.z0; return { x: ax ? r.x0 + 0.5 : (r.x0 + r.x1) / 2, y: r.y + 1.62, z: ax ? (r.z0 + r.z1) / 2 : r.z0 + 0.5, tx: ax ? r.x1 : (r.x0 + r.x1) / 2, ty: r.y + 1.3, tz: ax ? (r.z0 + r.z1) / 2 : r.z1, room: r }; },
  cabin_rating: () => fromDoor(bySpace('cabin_rating') || bySpace('cabin_officer')),
  cabin_officer: () => fromDoor(bySpace('cabin_officer')),
  suite_day: () => fromDoor(bySpace('suite_day') || bySpace('cabin_officer')),
  mess: () => fromDoor(bySpace('mess')),
  galley: () => fromDoor(bySpace('galley')),
  ecr: () => { const r = bySpace('ecr'); return r ? fromDoor(r) : null; },
  ccr: () => { const r = bySpace('ccr'); return r ? fromDoor(r) : null; },
  hospital: () => fromDoor(bySpace('hospital')),
  gym: () => fromDoor(bySpace('gym')),
  er_floor_me: () => { const h = plan.hotspots.find((q) => q.kind === 'engine' && q.zone === 'er') || plan.hotspots.find((q) => q.kind === 'engine'); const me = plan.props.find((q) => q.t === 'me2s' || q.t === 'engine'); return { x: h.x + 1.5, y: h.y + 1.65, z: h.z + 1.2, tx: me ? me.x : h.x, ty: h.y + 2.2, tz: me ? me.z : h.z - 4, room: null }; },
  er_wing: () => { const r = find((q) => q.space === 'er_platform' && q.level === 0 && q.tag === 's') || find((q) => q.space === 'er_platform'); return corner(r, 0); },
  er_top: () => { const ys = [...new Set(rooms.filter((q) => q.space === 'er_platform').map((q) => q.y))].sort((a, b) => b - a); const r = find((q) => q.space === 'er_platform' && Math.abs(q.y - ys[0]) < 0.05 && q.tag === 'c') || find((q) => q.space === 'er_platform' && Math.abs(q.y - ys[0]) < 0.05); return corner(r, 1); },
  purifiers: () => { const r = bySpace('purifier_room'); return r ? fromDoor(r) : null; },
  steering: () => { const r = bySpace('steering_gear'); return r ? corner(r, 2) : null; },
  fcsle_mooring: () => { const r = find((q) => q.zone === 'fwd' && q.open); return r ? { x: 0, y: r.y + 1.7, z: r.z1 - 1, tx: 0, ty: r.y, tz: r.z0, room: r } : null; },
  poop_mooring: () => { const r = rooms.filter((q) => q.open && q.zone === 'deck').sort((a, b) => b.z1 - a.z1)[0]; return r ? { x: 0, y: r.y + 1.7, z: r.z0 + 1, tx: 0, ty: r.y, tz: r.z1, room: r } : null; },
  laundry: () => fromDoor(bySpace('laundry')),
  // ---- cruise ships (docs/CRUISE-CONTRACT.md §4): ?model=cruise362&deck=d4&shot=atrium
  atrium: () => { const r = bySpace('atrium'); if (!r) return null; return { x: (r.x0 + r.x1) / 2 + 3, y: r.y + 1.7, z: r.z1 - 2.2, tx: (r.x0 + r.x1) / 2 - 1, ty: r.y + 3.0, tz: r.z0 + 3, room: r }; },
  theatre: () => { const r = bySpace('theatre'); if (!r) return null; const a = (r.x1 - r.x0 >= 20 ? 4.5 : 0); return { x: (r.x0 + r.x1) / 2 + a, y: r.y + 1.75, z: r.z0 + (r.z1 - r.z0) * 0.55, tx: (r.x0 + r.x1) / 2, ty: r.y + 1.4, tz: r.z0, room: r }; },
  street: () => { const r = find((q) => q.space === 'promenade' && q.walk !== false); if (!r) return null; const al = r.z1 - r.z0 > r.x1 - r.x0; return al ? { x: (r.x0 + r.x1) / 2, y: r.y + 1.7, z: r.z1 - 1.0, tx: (r.x0 + r.x1) / 2, ty: r.y + 1.6, tz: r.z0, room: r } : { x: r.x1 - 1.0, y: r.y + 1.7, z: (r.z0 + r.z1) / 2, tx: r.x0, ty: r.y + 1.6, tz: (r.z0 + r.z1) / 2, room: r }; },
  restaurant: () => { const r = find((q) => q.space === 'restaurant' && q.walk !== false); return r ? fromDoor(r) : null; },
  buffet: () => { const r = bySpace('buffet'); return r ? fromDoor(r) : null; },
  casino: () => { const r = bySpace('casino'); return r ? fromDoor(r) : null; },
  club: () => { const r = bySpace('nightclub'); return r ? fromDoor(r) : null; },
  bar: () => { const r = bySpace('bar'); return r ? fromDoor(r) : null; },
  shop: () => { const r = bySpace('shop'); return r ? fromDoor(r) : null; },
  kids: () => { const r = bySpace('kids'); return r ? fromDoor(r) : null; },
  spa: () => { const r = bySpace('spa'); return r ? fromDoor(r) : null; },
  galley_pax: () => { const r = bySpace('galley_pax'); return r ? fromDoor(r) : null; },
  crew_mess: () => { const r = bySpace('crew_mess'); return r ? fromDoor(r) : null; },
  cabin_pax: () => { const r = find((q) => /^cabin_cruise/.test(q.space || '')); return r ? fromDoor(r) : null; },
  cabin_corridor: () => { const r = find((q) => q.space === 'corridor_pax' && q.walk !== false); if (!r) return null; const al = r.x1 - r.x0 > r.z1 - r.z0; return al ? { x: r.x1 - 1, y: r.y + 1.65, z: (r.z0 + r.z1) / 2, tx: r.x0, ty: r.y + 1.4, tz: (r.z0 + r.z1) / 2, room: r } : { x: (r.x0 + r.x1) / 2, y: r.y + 1.65, z: r.z1 - 1, tx: (r.x0 + r.x1) / 2, ty: r.y + 1.4, tz: r.z0, room: r }; },
  pool: () => { const r = find((q) => q.space === 'pool_deck' || q.space === 'water_deck'); if (!r) return null; return { x: r.x0 + 3, y: r.y + 1.7, z: r.z1 - 3, tx: (r.x0 + r.x1) / 2, ty: r.y + 1.0, tz: (r.z0 + r.z1) / 2 - 3, room: r }; },
  sports: () => { const r = find((q) => q.space === 'sports_deck' || q.space === 'sun_deck'); if (!r) return null; return { x: r.x0 + 3, y: r.y + 1.7, z: r.z1 - 3, tx: (r.x0 + r.x1) / 2, ty: r.y + 1.5, tz: (r.z0 + r.z1) / 2, room: r }; },
  lobby: () => { const r = bySpace('cabin_lobby'); return r ? fromDoor(r) : null; },
};
let s = null;
if (Q.get('x')) s = { x: +Q.get('x'), y: +Q.get('y'), z: +Q.get('z'), tx: +Q.get('x') + Math.sin(+(Q.get('yaw') || 0)), ty: +Q.get('y') + Math.sin(+(Q.get('pitch') || 0)), tz: +Q.get('z') - Math.cos(+(Q.get('yaw') || 0)) };
else s = (SHOTS[shotName] || SHOTS.bridge)();
if (!s) s = SHOTS.bridge();
camera.position.set(s.x, s.y, s.z); camera.lookAt(s.tx, s.ty, s.tz);
// the walker stands where the camera is (chunk / zone selection, light mode)
const standY = map.standAt(s.x, s.z, s.y - 1.62, 0.6) ?? (s.y - 1.62);
I.pos.set(s.x, standY, s.z); I.y = standY;
const here = map.roomAt(s.x, s.z, standY);
if (groups) {
  const vis = visibleZones(plan, here?.zone || 'deck', phone);
  for (const [id, g] of groups) g.visible = vis.has(id);
}
if (I.v2) { for (let i = 0; i < 30; i++) I.v2.frame(I, 0.2); }
// cruise ships: the people (?crowd=0 hides them; ?t= is the ship's hour)
if (wantsCrowd(plan) && Q.get('crowd') !== '0') {
  app.shipTimeNow = () => hour * 3600; I.group = root; I.curRoom = here;
  const crowd = new CruiseCrowd(I, plan, root, { phone });
  for (let i = 0; i < 40; i++) crowd.frame(I, 0.25);
  I.crowd = crowd;
}
// stats for scripted captures
const stats = { tris: 0, calls: 0, room: here?.id || null, space: here?.space || null, zone: here?.zone || null, plan: { v: plan.v || 1, rooms: plan.rooms.length } };
scene.traverseVisible((o) => { if (o.isMesh) { stats.calls++; const g = o.geometry; stats.tris += (o.isInstancedMesh ? o.count : 1) * (g.index ? g.index.count : g.attributes.position.count) / 3; } });
stats.tris = Math.round(stats.tris);
function frame() { renderer.render(scene, camera); }
frame();
addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); frame(); });
// mouse look for manual review
let drag = null; let yaw = Math.atan2(s.tx - s.x, -(s.tz - s.z)), pitch = Math.atan2(s.ty - s.y, Math.hypot(s.tx - s.x, s.tz - s.z));
canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; });
addEventListener('pointerup', () => { drag = null; });
addEventListener('pointermove', (e) => { if (!drag) return; yaw += (e.clientX - drag.x) * 0.005; pitch = Math.max(-1.3, Math.min(1.3, pitch - (e.clientY - drag.y) * 0.005)); drag = { x: e.clientX, y: e.clientY }; camera.lookAt(camera.position.x + Math.sin(yaw) * Math.cos(pitch), camera.position.y + Math.sin(pitch), camera.position.z - Math.cos(yaw) * Math.cos(pitch)); frame(); });
addEventListener('keydown', (e) => { const k = e.key.toLowerCase(), v = 0.3; const fx = Math.sin(yaw), fz = -Math.cos(yaw); if (k === 'w') camera.position.add(new THREE.Vector3(fx * v, 0, fz * v)); if (k === 's') camera.position.add(new THREE.Vector3(-fx * v, 0, -fz * v)); if (k === 'a') camera.position.add(new THREE.Vector3(fz * v, 0, -fx * v)); if (k === 'd') camera.position.add(new THREE.Vector3(-fz * v, 0, fx * v)); camera.lookAt(camera.position.x + Math.sin(yaw) * Math.cos(pitch), camera.position.y + Math.sin(pitch), camera.position.z - Math.cos(yaw) * Math.cos(pitch)); frame(); });
document.getElementById('info').textContent = `${model} · ${shotName} · ${here?.name || '—'} (${here?.space || ''}) · v${plan.v || 1} · ${stats.tris.toLocaleString()} tris · ${stats.calls} calls`;
window.__iv2view = { ready: true, stats, shots: Object.keys(SHOTS) };
