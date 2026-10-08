// Harbour tugs (V5-PLAN item 4): renders the tugs the server runs for a tug assist — for our own ship and for every
// other skipper's (snapshot players[].tugs, ours included). Each tug is the harbour tug model (ship.js buildShip('tug'))
// interpolated between snapshots like any other ship and riding the sea through app.shipVisual, with its towline to the
// assisted ship (a ribbon on a shallow catenary, like the hawser in jobs.js) and prop wash foam that grows with thrust.
// Wiring: `new TugLayer(app)` listens to the app's messages itself; main.js calls `update(dt, now)` once per frame.
import * as THREE from 'three';
import { buildShip } from './ship.js';

const LINE_W = 0.45;            // towline ribbon width (m)
const LINE_N = 20;              // segments along the line
const STALE_SNAPS = 20;         // a tug missing from this many snapshots in a row is gone (back at its station); counted
                                // in snapshots, not frame time, so a slow device never drops tugs that are still there

function makeLine() {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(LINE_N * 4 * 3), 3));
  const idx = [];
  for (let r = 0; r < 2; r++) for (let i = 0; i < LINE_N - 1; i++) { const a = r * LINE_N * 2 + i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  geo.setIndex(idx);
  const line = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xe9e2c8, side: THREE.DoubleSide }));
  line.frustumCulled = false; line.visible = false;
  return line;
}
let FOAM_TEX = null;
function foamTexture() {
  if (FOAM_TEX) return FOAM_TEX;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(64, 64, 4, 64, 64, 62);
  g.addColorStop(0, 'rgba(255,255,255,0.95)'); g.addColorStop(0.45, 'rgba(240,248,255,0.55)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 128, 128);
  // churned speckle so it reads as foam, not a disc
  for (let i = 0; i < 260; i++) { const a = Math.random() * Math.PI * 2, r = Math.random() * 56; x.fillStyle = `rgba(255,255,255,${0.15 + Math.random() * 0.4})`; x.beginPath(); x.arc(64 + Math.cos(a) * r, 64 + Math.sin(a) * r, 1 + Math.random() * 3, 0, Math.PI * 2); x.fill(); }
  FOAM_TEX = new THREE.CanvasTexture(c); FOAM_TEX.userData.shared = true;
  return FOAM_TEX;
}
function makeFoam() {
  const geo = new THREE.PlaneGeometry(1, 1); geo.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: foamTexture(), transparent: true, opacity: 0, depthWrite: false, fog: true }));
  m.renderOrder = 3; m.visible = false;
  return m;
}

export class TugLayer {
  constructor(app) {
    this.app = app;
    this.tugs = new Map();        // tug id → { id, owner, mesh, samples, cur, vis, data, seen, line, foam }
    this.group = new THREE.Group(); app.scene.add(this.group);
    this.tmpA = new THREE.Vector3(); this.tmpB = new THREE.Vector3();
    this.snapSeq = 0;
    // listen to the app's messages (snapshots carry every skipper's tugs at 10 Hz, ours included)
    const orig = typeof app.onMessage === 'function' ? app.onMessage.bind(app) : null;
    if (orig) app.onMessage = (m) => { orig(m); try { this.onMessage(m); } catch (e) { if (!this.warned) { this.warned = true; console.warn('[tugs] message failed', e); } } };
  }
  onMessage(m) {
    if (!m) return;
    const now = performance.now();
    if (m.t === 'snap') this.snapSeq++;
    if (m.t === 'snap' || m.t === 'welcome') for (const p of m.players || []) if (Array.isArray(p.tugs)) for (const t of p.tugs) this.upsert(p.id, t, now);
    if (m.t === 'you' && Array.isArray(m.you?.assist?.tugs)) for (const t of m.you.assist.tugs) if (!this.tugs.has(t.id)) this.upsert(m.you.id, t, now);
  }
  upsert(owner, t, now) {
    if (!t || !t.id || !Number.isFinite(t.lat) || !Number.isFinite(t.lon)) return;
    let o = this.tugs.get(t.id);
    if (!o) {
      const mesh = buildShip('tug', null, 31 + this.tugs.size);
      o = { id: t.id, owner, mesh, samples: [], cur: { lat: t.lat, lon: t.lon, hdg: t.hdg, spd: t.spd }, vis: { heave: 0, pitch: 0, roll: 0 }, data: t, seen: now, line: makeLine(), foam: makeFoam(), thrust: 0 };
      this.app.scene.add(mesh); this.group.add(o.line, o.foam);
      this.tugs.set(t.id, o);
    }
    o.owner = owner; o.data = t; o.seen = now; o.seenSeq = this.snapSeq;
    const last = o.samples[o.samples.length - 1];
    if (!last || now - last.t > 5) { o.samples.push({ t: now, lat: t.lat, lon: t.lon, hdg: t.hdg, spd: t.spd }); if (o.samples.length > 4) o.samples.shift(); }
  }
  drop(id) {
    const o = this.tugs.get(id); if (!o) return;
    this.dropped = (this.dropped || 0) + 1;
    this.app.drop(o.mesh);
    this.group.remove(o.line, o.foam);
    o.line.geometry.dispose(); o.line.material.dispose(); o.foam.geometry.dispose(); o.foam.material.dispose();
    this.tugs.delete(id);
  }
  /** The assisted ship's mesh: ours, or another skipper's. */
  ownerMesh(owner) {
    const app = this.app;
    if (owner && owner === app.you?.id) return app.myMesh;
    return app.others?.get(owner)?.mesh || null;
  }
  /** Per frame: place and animate every tug, its line and its wash. */
  update(dt, now) {
    const app = this.app;
    for (const [id, o] of this.tugs) if (this.snapSeq - o.seenSeq > STALE_SNAPS) this.drop(id);
    if (!this.tugs.size) return;
    const night = app.night || 0;
    for (const o of this.tugs.values()) {
      app.interp(o, now);
      const c = o.cur, d = o.data;
      // fast-forwarded assist (d.ff): she covers ff× the ground, so feed the wake her real speed / ff, or it is drawn as a
      // long bright stripe behind her
      const ff = Number(d.ff) > 1 ? Number(d.ff) : 1;
      app.shipVisual(o.mesh, c.lat, c.lon, c.hdg, c.spd / ff, o.vis, 0, dt, false);
      o.mesh.userData.setLights?.(night);
      // thrust eases (the wash builds up and dies down rather than switching)
      o.thrust += ((Number(d.thrust) || 0) - o.thrust) * Math.min(1, dt * 1.5);
      this.drawLine(o);
      this.drawFoam(o, dt);
    }
  }
  drawLine(o) {
    const d = o.data, ship = this.ownerMesh(o.owner), line = o.line;
    if (!Array.isArray(d.line) || !ship) { line.visible = false; return; }
    ship.updateMatrixWorld(); o.mesh.updateMatrixWorld();
    // ship frame: x = starboard, z = aft (bow at −z); the server sends [forward, starboard] metres from midships
    const fb = (ship.userData.freeboard || 2) + 0.6, tfb = (o.mesh.userData.freeboard || 2) + 0.8;
    const a = this.tmpA.set(Number(d.line[1]) || 0, fb, -(Number(d.line[0]) || 0)).applyMatrix4(ship.matrixWorld);
    const b = this.tmpB.set(0, tfb, -(Number(d.end) || 0)).applyMatrix4(o.mesh.matrixWorld);
    const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz) || 1;
    if (L > 200) { line.visible = false; return; } // not made fast yet / snapshot gap
    line.visible = true;
    const pos = line.geometry.attributes.position;
    const sag = 0.3 + 2.2 * (1 - Math.min(1, o.thrust)) * Math.min(1, L / 40); // a working tug keeps her line taut
    const px = (-dz / L) * LINE_W / 2, pz = (dx / L) * LINE_W / 2;
    for (let i = 0; i < LINE_N; i++) {
      const f = i / (LINE_N - 1);
      const x = a.x + dx * f, y = a.y + (b.y - a.y) * f - sag * 4 * f * (1 - f), z = a.z + dz * f;
      pos.setXYZ(i * 2, x - px, y, z - pz); pos.setXYZ(i * 2 + 1, x + px, y, z + pz);
      pos.setXYZ(LINE_N * 2 + i * 2, x, y - LINE_W / 2, z); pos.setXYZ(LINE_N * 2 + i * 2 + 1, x, y + LINE_W / 2, z);
    }
    pos.needsUpdate = true; line.geometry.computeBoundingSphere();
  }
  /** Prop wash: a churned patch astern of the tug, bigger and whiter with thrust (pushing tugs throw it away from the hull). */
  drawFoam(o, dt) {
    const f = o.foam, k = Math.min(1, o.thrust);
    if (k < 0.05) { f.visible = false; return; }
    f.visible = true;
    const L = o.mesh.userData.length || 32, h = (o.cur.hdg || 0) * Math.PI / 180;
    const back = L * 0.5 + 4 + 6 * k;
    f.position.set(o.mesh.position.x - Math.sin(h) * back, (this.app.tideLevel || 0) + Math.max(0.05, o.mesh.position.y - (this.app.tideLevel || 0)) * 0.5 + 0.12, o.mesh.position.z + Math.cos(h) * back);
    f.rotation.y = -h;
    o.foamT = (o.foamT || 0) + dt;
    const w = 8 + 8 * k, len = 14 + 22 * k;
    f.scale.set(w * (1 + 0.04 * Math.sin(o.foamT * 5.3)), 1, len * (1 + 0.05 * Math.sin(o.foamT * 3.7 + 1)));
    f.material.opacity = 0.2 + 0.6 * k;
  }
  /** Tugs currently shown (for checks). */
  list() { return [...this.tugs.values()].map((o) => ({ id: o.id, owner: o.owner, lat: o.cur.lat, lon: o.cur.lon, hdg: o.cur.hdg, mode: o.data.mode, line: !!o.line.visible, foam: !!o.foam.visible })); }
}
