// Walkable ship interior (docs/V3-CONTRACTS.md §5): bridge, passage, engine room, cabins, mess — or saloon / V-berth /
// cockpit on sailing yachts — built as a child group of the player's ship mesh so it inherits heave, pitch and roll.
// First-person walker with pointer-lock mouse look (touch: TouchHelm.stick + right-half drag), room AABB collision,
// doors, ramps/ladders between decks and E/tap hotspots (helm, engine panel, bunk, chart table, radio).
import * as THREE from 'three';
import { SHIP_CLASSES } from '/shared/constants.js';
import * as ShipMod from './ship.js';
import { makeAvatar } from './avatar.js';

const EYE = 1.65;
const WALK = 1.7, RUN = 3.3;
const INSET = 0.3;          // walkable inset from room walls (keeps the camera off the plaster)
const MOVE_KEYS = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
const LAYOUT = {
  coaster: { bridgeZ: 0.37, superH: 9, type: 'cargo', rpm: 900 },
  feeder: { bridgeZ: 0.37, superH: 14, type: 'cargo', rpm: 700 },
  bulker: { bridgeZ: 0.40, superH: 16, type: 'cargo', rpm: 110 },
  tanker: { bridgeZ: 0.40, superH: 16, type: 'cargo', rpm: 110 },
  boxship: { bridgeZ: 0.30, superH: 30, type: 'cargo', rpm: 90 },
  psv: { bridgeZ: -0.35, superH: 9, type: 'cargo', rpm: 750 },
  ferry: { bridgeZ: -0.30, superH: 10.8, type: 'cargo', rpm: 500 },
  superyacht: { bridgeZ: -0.15, superH: 8, type: 'cargo', rpm: 1600 },
  trawler: { bridgeZ: -0.20, superH: 4.5, type: 'small', rpm: 1200 },
  tug: { bridgeZ: -0.05, superH: 6, type: 'small', rpm: 1000 },
  pilot: { bridgeZ: -0.05, superH: 1.2, type: 'small', rpm: 2600 },
  cruiser: { bridgeZ: 0.05, superH: 0.4, type: 'yacht', open: true, rpm: 3800 },
  myacht: { bridgeZ: 0.0, superH: 3.0, type: 'yacht', rpm: 2200 },
  sloop: { bridgeZ: 0.3, superH: -0.5, type: 'sail', rpm: 2800 },
  ketch: { bridgeZ: 0.3, superH: -0.5, type: 'sail', rpm: 2800 },
  catamaran: { bridgeZ: 0.3, superH: -0.4, type: 'sail', rpm: 2800 },
  schooner: { bridgeZ: 0.32, superH: -0.5, type: 'sail', rpm: 1800 },
};
const DEFAULT_LAYOUT = { bridgeZ: 0.3, superH: 8, type: 'cargo', rpm: 900 };

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
function box(w, h, d, mat, x = 0, y = 0, z = 0) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); return m; }
function cyl(r, h, mat, x = 0, y = 0, z = 0, seg = 12) { const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), mat); m.position.set(x, y, z); return m; }
function rectMinusHoles(r, holes) {
  let rects = [r];
  for (const h of holes || []) {
    const next = [];
    for (const q of rects) {
      const ix0 = Math.max(q.x0, h.x0), ix1 = Math.min(q.x1, h.x1), iz0 = Math.max(q.z0, h.z0), iz1 = Math.min(q.z1, h.z1);
      if (ix1 - ix0 <= 0.01 || iz1 - iz0 <= 0.01) { next.push(q); continue; }
      if (ix0 - q.x0 > 0.01) next.push({ x0: q.x0, x1: ix0, z0: q.z0, z1: q.z1 });
      if (q.x1 - ix1 > 0.01) next.push({ x0: ix1, x1: q.x1, z0: q.z0, z1: q.z1 });
      if (iz0 - q.z0 > 0.01) next.push({ x0: ix0, x1: ix1, z0: q.z0, z1: iz0 });
      if (q.z1 - iz1 > 0.01) next.push({ x0: ix0, x1: ix1, z0: iz1, z1: q.z1 });
    }
    rects = next;
  }
  return rects;
}
function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

export class Interior {
  constructor(app) {
    this.app = app;
    this._active = false;
    this.group = null; this.builtFor = null; this.builtCls = null;
    this.pos = new THREE.Vector3(); this.y = 0; this.yaw = 0; this.pitch = 0; this.bob = 0;
    this.keys = new Set(); this.run = false; this.atHelm = false; this.touchLook = null;
    this.rooms = []; this.doors = []; this.ramps = []; this.hotspots = []; this.solids = []; this.nearHotspot = null;
    this.gauge = null; this.radarTex = null; this.lastRadarT = 0; this.lastGauge = 0;
    this.prevNear = null; this.restUntil = 0;
    this.light = new THREE.PointLight(0xfff1dc, 0, 24, 2); this.light.visible = true; app.scene.add(this.light);
    this.prompt = document.createElement('div'); this.prompt.id = 'interiorPrompt';
    this.prompt.style.cssText = 'position:fixed;left:50%;bottom:17%;transform:translateX(-50%);padding:8px 14px;background:rgba(4,12,20,.78);border:1px solid rgba(140,190,230,.35);border-radius:8px;font:14px/1.3 "Segoe UI",system-ui,sans-serif;color:#dbe9f4;pointer-events:none;z-index:15;display:none;white-space:nowrap';
    document.body.appendChild(this.prompt);
    this.isTouch = (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) || navigator.maxTouchPoints > 1;
    // third-person view: a crew member you walk around with (V / C or the button), camera kept inside the room
    this.view = 'third'; this.camDist = 2.6; this.avatar = null;
    this.viewBtn = document.createElement('button'); this.viewBtn.id = 'interiorView'; this.viewBtn.type = 'button';
    this.viewBtn.style.cssText = 'position:fixed;right:16px;top:calc(64px + env(safe-area-inset-top));z-index:16;min-height:44px;padding:8px 14px;border-radius:10px;border:1px solid rgba(140,190,230,.45);background:rgba(4,12,20,.8);color:#dbe9f4;font:14px "Segoe UI",system-ui,sans-serif;display:none;cursor:pointer';
    this.viewBtn.addEventListener('click', (e) => { e.stopPropagation(); this.toggleView(); this.viewBtn.blur(); });
    document.body.appendChild(this.viewBtn);
    this.bind();
  }
  get active() { return this._active; }

  // ------------------------------------------------------------------ input
  bind() {
    const canvas = this.app.canvas;
    window.addEventListener('keyup', (e) => { const k = e.key.toLowerCase(); this.keys.delete(k); if (k === 'shift') this.run = false; });
    document.addEventListener('mousemove', (e) => {
      if (!this._active || document.pointerLockElement !== canvas) return;
      this.yaw += e.movementX * 0.0022; this.pitch = clamp(this.pitch - e.movementY * 0.0022, -1.35, 1.35);
    });
    document.addEventListener('pointerlockerror', () => {});
    canvas.addEventListener('pointerdown', (e) => {
      if (!this._active) return;
      if (e.pointerType === 'touch') {
        if (e.clientX > innerWidth / 2 && !this.touchLook) { this.touchLook = { id: e.pointerId, x: e.clientX, y: e.clientY, t0: performance.now(), moved: 0 }; try { canvas.setPointerCapture(e.pointerId); } catch {} }
      } else if (document.pointerLockElement !== canvas) this.lock();
    });
    canvas.addEventListener('pointermove', (e) => {
      const t = this.touchLook; if (!this._active || !t || e.pointerId !== t.id) return;
      const dx = e.clientX - t.x, dy = e.clientY - t.y; t.x = e.clientX; t.y = e.clientY; t.moved += Math.abs(dx) + Math.abs(dy);
      this.yaw += dx * 0.006; this.pitch = clamp(this.pitch - dy * 0.006, -1.35, 1.35);
    });
    const endTouch = (e) => {
      const t = this.touchLook; if (!t || e.pointerId !== t.id) return;
      this.touchLook = null;
      if (this._active && t.moved < 10 && performance.now() - t.t0 < 350) this.interact();
    };
    canvas.addEventListener('pointerup', endTouch); canvas.addEventListener('pointercancel', endTouch);
    window.addEventListener('blur', () => { this.keys.clear(); this.run = false; });
    canvas.addEventListener('wheel', (e) => { if (!this._active || this.view !== 'third') return; this.camDist = clamp(this.camDist * (1 + Math.sign(e.deltaY) * 0.12), 1.2, 5); e.preventDefault(); }, { passive: false });
  }
  toggleView() {
    this.view = this.view === 'third' ? 'first' : 'third';
    this.updateViewBtn();
    this.app.hud.event?.({ kind: 'info', text: this.view === 'third' ? 'Third-person view: you see yourself walking through the ship.' : 'First-person view.' });
  }
  updateViewBtn() { this.viewBtn.textContent = this.view === 'third' ? '👁 First person (V)' : '🧍 Third person (V)'; this.viewBtn.style.display = this._active ? 'block' : 'none'; }
  /** The crew member (avatar.js): faces -z (the bow) at yaw 0. */
  makeAvatar() { return makeAvatar(); }
  /** Hide the ship's exterior parts that overlap the interior volume (superstructure blocks, masts, funnels, hatches):
   *  seen from inside they would z-fight with the floors or stand in the middle of a room. The hull, labels and the
   *  wake stay, so the deck and the sea outside the windows are still there. Restored on exit. */
  hideExterior(mesh) {
    this.restoreExterior();
    if (!mesh || !this.group) return;
    mesh.updateMatrixWorld(true);
    const inner = new THREE.Box3();
    for (const r of this.rooms) {
      const a = new THREE.Vector3(r.x0, r.y - 0.05, r.z0).applyMatrix4(mesh.matrixWorld), b = new THREE.Vector3(r.x1, r.y + (r.h || 2.5) + 0.05, r.z1).applyMatrix4(mesh.matrixWorld);
      inner.expandByPoint(a); inner.expandByPoint(b);
    }
    for (const r of this.ramps) {
      inner.expandByPoint(new THREE.Vector3(r.x0, Math.min(r.y0, r.y1), r.z0).applyMatrix4(mesh.matrixWorld));
      inner.expandByPoint(new THREE.Vector3(r.x1, Math.max(r.y0, r.y1) + 2.2, r.z1).applyMatrix4(mesh.matrixWorld));
    }
    this.hidden = [];
    const box = new THREE.Box3();
    for (const c of mesh.children) {
      if (c === this.group || c === mesh.userData.wake || c === mesh.userData.label || c.isSprite || !c.visible) continue;
      if (c.isMesh && c.geometry && c.geometry.type === 'ExtrudeGeometry') continue; // hull + bulwark: keep the deck
      box.setFromObject(c);
      if (!box.isEmpty() && box.intersectsBox(inner)) { c.visible = false; this.hidden.push(c); }
    }
  }
  restoreExterior() { for (const c of this.hidden || []) c.visible = true; this.hidden = []; }
  /** The room (AABB) the walker stands in, for keeping the third-person camera off the walls. */
  roomAt(x, z, y) {
    let best = null;
    for (const r of this.rooms) if (x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1 && Math.abs(r.y - y) < 1.4) { if (!best || (r.x1 - r.x0) * (r.z1 - r.z0) < (best.x1 - best.x0) * (best.z1 - best.z0)) best = r; }
    return best;
  }
  lock() { try { const p = this.app.canvas.requestPointerLock?.(); if (p && p.catch) p.catch(() => {}); } catch {} }
  unlock() { try { if (document.pointerLockElement === this.app.canvas) document.exitPointerLock(); } catch {} }
  /** keydown while inside; returns true when the key was consumed by the walker. */
  handleKey(e) {
    if (!this._active) return false;
    const k = e.key.toLowerCase();
    if (k === 'e') { this.interact(); return true; }
    if (k === 'v' || k === 'c') { this.toggleView(); return true; }
    if (k === 'escape' && this.atHelm) { this.leaveHelm(); return true; }
    if (this.atHelm) return false; // helm taken: W/S/A/D/space drive the ship through main.js
    if (k === 'shift') { this.run = true; return true; }
    if (MOVE_KEYS.has(k)) { this.keys.add(k); e.preventDefault?.(); return true; }
    if (k === ' ') { e.preventDefault?.(); return true; }
    return false;
  }

  // ------------------------------------------------------------------ enter / exit
  enter() {
    const app = this.app; if (!app.myMesh || !app.you) return false;
    if (!this.group || this.builtFor !== app.myMesh || this.builtCls !== app.you.ship.cls) this.build();
    if (!this.group) return false;
    this._active = true; this.atHelm = false; this.keys.clear();
    this.group.visible = true;
    this.hideExterior(app.myMesh);
    const s = this.spawn; this.pos.set(s.x, s.y, s.z); this.y = s.y; this.yaw = s.yaw || 0; this.pitch = 0;
    this.camState = { near: app.camera.near, fov: app.camera.fov };
    app.camera.near = 0.12; app.camera.fov = 70; app.camera.updateProjectionMatrix();
    if (app.myMesh.userData.label) app.myMesh.userData.label.visible = false;
    if (!this.isTouch) this.lock();
    app.hud.showInterior?.(true);
    this.updateViewBtn();
    app.hud.event?.({ kind: 'info', text: this.isTouch ? 'Below decks. Stick to walk, drag right half to look, tap to use, view button for first / third person. Interior button to go back on deck.' : 'Below decks. WASD walk (Shift runs), mouse look, E to use things, V first / third person, wheel to zoom, I to go back on deck.' });
    this.light.intensity = 7;
    return true;
  }
  exit() {
    if (!this._active) return;
    this._active = false; this.atHelm = false; this.keys.clear(); this.touchLook = null;
    if (this.group) this.group.visible = false;
    const app = this.app;
    if (this.camState) { app.camera.near = this.camState.near; app.camera.fov = this.camState.fov; app.camera.updateProjectionMatrix(); }
    app.camera.up.set(0, 1, 0);
    if (app.myMesh?.userData.label && app.cam?.mode !== 2) app.myMesh.userData.label.visible = true;
    this.unlock();
    this.prompt.style.display = 'none';
    this.light.intensity = 0;
    if (this.avatar) this.avatar.visible = false;
    this.restoreExterior();
    this.viewBtn.style.display = 'none';
    app.hud.showInterior?.(false);
  }
  toggle() { if (this._active) this.exit(); else this.enter(); }
  leaveHelm() { this.atHelm = false; this.app.hud.event?.({ kind: 'info', text: 'You step back from the helm.' }); }

  // ------------------------------------------------------------------ interaction
  interact() {
    if (this.atHelm) { this.leaveHelm(); return; }
    const h = this.nearHotspot; if (!h) return;
    const app = this.app, you = app.you, C = SHIP_CLASSES[you?.ship.cls] || SHIP_CLASSES.coaster;
    switch (h.kind) {
      case 'helm': {
        this.atHelm = true; this.keys.clear(); this.pos.set(h.x, h.y, h.z); this.yaw = 0; this.pitch = -0.05;
        app.hud.event?.({ kind: 'info', text: you?.docked ? 'At the helm — cast off (T) before you can get under way.' : 'You take the helm. W/S throttle, A/D rudder, space all stop; E or Esc to step away.' });
        break;
      }
      case 'engine': {
        const s = app.ship || you.ship, lay = LAYOUT[you.ship.cls] || DEFAULT_LAYOUT;
        const rpm = Math.round(Math.abs(s.throttle || 0) * lay.rpm);
        const txt = `Engine: ${rpm} rpm (${Math.round((s.throttle || 0) * 100)} %) · fuel ${(you.fuel || 0).toFixed(1)} / ${C.fuelCap} t · hull ${Math.round(you.cond)} % · ${you.flooding > 0.01 ? `flooding ${Math.round(you.flooding * 100)} % — pumps running` : 'bilges dry'}${you.fuelEmpty ? ' · NO FUEL' : ''}`;
        app.hud.event?.({ kind: you.fuelEmpty || you.cond < 30 ? 'warn' : 'info', text: txt });
        break;
      }
      case 'bunk': this.rest(); break;
      case 'chart': { if (typeof app.hud.openChart === 'function') app.hud.openChart(); else app.hud.toggleChart?.(); this.unlock(); break; }
      case 'radio': { const el = document.getElementById('chatInput'); if (el) { el.focus(); app.hud.event?.({ kind: 'info', text: 'VHF: type your message, Enter to transmit.' }); } break; }
      default: break;
    }
  }
  rest() {
    const now = performance.now(); if (now < this.restUntil) return;
    this.restUntil = now + 2600;
    let ov = document.getElementById('interiorRest');
    if (!ov) {
      ov = document.createElement('div'); ov.id = 'interiorRest';
      ov.style.cssText = 'position:fixed;inset:0;background:#000;opacity:0;transition:opacity .7s;pointer-events:none;z-index:14;display:flex;align-items:center;justify-content:center;color:#cfe;font:16px "Segoe UI",system-ui,sans-serif';
      document.body.appendChild(ov);
    }
    ov.textContent = 'You rest for a while…';
    ov.style.opacity = '1';
    setTimeout(() => { ov.style.opacity = '0'; }, 1600);
    this.app.hud.event?.({ kind: 'info', text: 'You rest for a while. The watch keeps the ship on her course.' });
  }

  // ------------------------------------------------------------------ per-frame
  update(dt) {
    const app = this.app;
    if (!this._active) return;
    if (!app.myMesh || !app.you) { this.exit(); return; }
    if (this.builtFor !== app.myMesh || this.builtCls !== app.you.ship.cls) { this.build(); if (!this.group) { this.exit(); return; } const s = this.spawn; this.pos.set(s.x, s.y, s.z); this.y = s.y; }
    dt = Math.min(0.1, dt);
    // ---- movement
    if (!this.atHelm) {
      let mx = 0, mz = 0; // local: +mz forward
      if (this.keys.has('w') || this.keys.has('arrowup')) mz += 1;
      if (this.keys.has('s') || this.keys.has('arrowdown')) mz -= 1;
      if (this.keys.has('a') || this.keys.has('arrowleft')) mx -= 1;
      if (this.keys.has('d') || this.keys.has('arrowright')) mx += 1;
      const st = app.touchHelm?.stick;
      if (st && st.active) { mx += clamp(st.x, -1, 1); mz += clamp(st.y, -1, 1); }
      const l = Math.hypot(mx, mz);
      if (l > 0.05) {
        if (l > 1) { mx /= l; mz /= l; }
        const spd = this.run ? RUN : WALK;
        const fx = Math.sin(this.yaw), fz = -Math.cos(this.yaw), rx = Math.cos(this.yaw), rz = Math.sin(this.yaw);
        let dx = (fx * mz + rx * mx) * spd * dt, dz = (fz * mz + rz * mx) * spd * dt;
        const slope = this.slopeAt(this.pos.x, this.pos.z);
        if (slope > 0) { const f = 1 / Math.sqrt(1 + slope * slope); dx *= f; dz *= f; }
        this.tryMove(dx, dz);
        this.bob += dt * spd * 1.8;
      }
    }
    const fl = this.floorAt(this.pos.x, this.pos.z, this.y);
    if (fl != null) this.y += (fl - this.y) * Math.min(1, dt * 14);
    // ---- hotspots
    let best = null, bd = 1e9;
    for (const h of this.hotspots) {
      const d = Math.hypot(h.x - this.pos.x, h.z - this.pos.z, (h.y - this.y) * 0.5);
      if (d < h.r && d < bd) { bd = d; best = h; }
    }
    this.nearHotspot = this.atHelm ? null : best;
    const label = this.atHelm ? (this.isTouch ? 'Tap to step away from the helm' : 'E / Esc — step away from the helm') : best ? `${this.isTouch ? 'Tap' : 'E'} — ${best.label}` : '';
    if (label !== this.prevLabel) { this.prevLabel = label; this.prompt.textContent = label; this.prompt.style.display = label ? 'block' : 'none'; }
    // ---- camera (ship frame → world through the ship's matrix so heave/pitch/roll carry over)
    const mesh = app.myMesh; mesh.updateMatrixWorld(true);
    const third = this.view === 'third' && !this.atHelm;
    if (!this.avatar || this.avatar.parent !== this.group) { this.avatar = this.makeAvatar(); this.group.add(this.avatar); }
    const moving = !this.atHelm && (this.keys.size > 0 || app.touchHelm?.stick?.active);
    const bob = this.avatar.userData.animate(dt, moving, this.run);
    this.avatar.visible = third;
    this.avatar.position.set(this.pos.x, this.y + bob, this.pos.z);
    this.avatar.rotation.y = -this.yaw;
    const bobY = third ? 0 : Math.sin(this.bob) * 0.03;
    const dirL = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    let eyeL = new THREE.Vector3(this.pos.x, this.y + EYE + bobY, this.pos.z), lookL;
    if (third) {
      // orbit behind and slightly above the head, then keep the camera inside the room the crew member is in
      const head = new THREE.Vector3(this.pos.x, this.y + 1.55, this.pos.z);
      const camL = head.clone().addScaledVector(dirL, -this.camDist).add(new THREE.Vector3(0, 0.35, 0));
      const r = this.roomAt(this.pos.x, this.pos.z, this.y);
      if (r) {
        const m = 0.18;
        camL.x = clamp(camL.x, r.x0 + m, r.x1 - m); camL.z = clamp(camL.z, r.z0 + m, r.z1 - m);
        let top = r.y + (r.h || 2.5) - 0.12;
        if (Number.isFinite(this.deckF) && r.y < this.deckF - 0.5) top = Math.min(top, this.deckF - 0.12);
        camL.y = clamp(camL.y, r.y + 0.4, top);
      }
      eyeL = camL; lookL = head;
    } else lookL = eyeL.clone().add(dirL);
    const eye = eyeL.applyMatrix4(mesh.matrixWorld), look = lookL.clone().applyMatrix4(mesh.matrixWorld);
    const dir = look.clone().sub(eye).normalize();
    app.camera.up.set(0, 1, 0).applyQuaternion(mesh.quaternion);
    app.camera.position.copy(eye);
    app.camera.lookAt(look);
    { // the lamp hangs under the ceiling of the room the crew member is in (never inside a wall or above the roof)
      const r = this.roomAt(this.pos.x, this.pos.z, this.y);
      const lampL = new THREE.Vector3(this.pos.x, r ? r.y + (r.h || 2.5) - 0.25 : this.y + 2.2, this.pos.z);
      this.light.position.copy(lampL.applyMatrix4(mesh.matrixWorld));
    }
    // ---- screens
    const now = performance.now();
    if (this.radarTex && app.lastRadar !== this.lastRadarT) { this.lastRadarT = app.lastRadar; this.radarTex.needsUpdate = true; }
    if (this.gauge && now - this.lastGauge > 250) { this.lastGauge = now; this.drawGauges(); }
    if (this.wheel) { const r = (app.ship?.rudder || 0) * 2.2; this.wheel.rotation.z += (r - this.wheel.rotation.z) * Math.min(1, dt * 6); }
    if (this.lever) { const t = app.ship?.throttle || 0; this.lever.rotation.x += (-t * 0.9 - this.lever.rotation.x) * Math.min(1, dt * 6); }
  }
  slopeAt(x, z) { for (const r of this.ramps) if (x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1) return Math.abs(r.y1 - r.y0) / Math.max(0.1, r.z1 - r.z0); return 0; }
  floorAt(x, z, yCur) {
    let best = null, bd = 1.8;
    const consider = (y) => { const d = Math.abs(y - yCur); if (d < bd) { bd = d; best = y; } };
    for (const r of this.rooms) {
      if (x < r.x0 + INSET || x > r.x1 - INSET || z < r.z0 + INSET || z > r.z1 - INSET) continue;
      let inHole = false;
      for (const h of r.floorHoles) if (x > h.x0 - 0.2 && x < h.x1 + 0.2 && z > h.z0 - 0.2 && z < h.z1 + 0.2) { inHole = true; break; }
      if (!inHole) consider(r.y);
    }
    for (const d of this.doors) if (x >= d.x0 && x <= d.x1 && z >= d.z0 && z <= d.z1) consider(d.y);
    for (const r of this.ramps) if (x >= r.x0 + 0.08 && x <= r.x1 - 0.08 && z >= r.z0 && z <= r.z1) consider(r.y0 + ((r.y1 - r.y0) * (z - r.z0)) / Math.max(0.01, r.z1 - r.z0));
    return best;
  }
  blocked(x, z) {
    const R = 0.25;
    for (const b of this.solids) if (Math.abs(b.y - this.y) < 1.2 && x > b.x0 - R && x < b.x1 + R && z > b.z0 - R && z < b.z1 + R) return true;
    return false;
  }
  canStand(x, z) { return this.floorAt(x, z, this.y) != null && !this.blocked(x, z); }
  tryMove(dx, dz) {
    const p = this.pos;
    const inside = this.blocked(p.x, p.z); // spawned / teleported into furniture: let the walker step out freely
    const ok = (x, z) => this.floorAt(x, z, this.y) != null && (inside || !this.blocked(x, z));
    if (ok(p.x + dx, p.z + dz)) { p.x += dx; p.z += dz; return; }
    if (ok(p.x + dx, p.z)) { p.x += dx; return; }
    if (ok(p.x, p.z + dz)) { p.z += dz; }
  }

  // ------------------------------------------------------------------ construction
  dispose() {
    if (this.group) { this.group.parent?.remove(this.group); (ShipMod.disposeGroup || disposeFallback)(this.group); this.group = null; }
    this.avatar = null; this.solids = [];
    this.rooms = []; this.doors = []; this.ramps = []; this.hotspots = []; this.gauge = null; this.radarTex = null; this.wheel = null; this.lever = null;
    this.builtFor = null; this.builtCls = null;
  }
  build() {
    const app = this.app; const mesh = app.myMesh; if (!mesh) return;
    this.dispose();
    const cls = app.you?.ship.cls || mesh.userData.cls || 'coaster';
    const C = SHIP_CLASSES[cls] || SHIP_CLASSES.coaster;
    const L = mesh.userData.length || C.length, B = mesh.userData.beam || C.beam, F = mesh.userData.freeboard || Math.max(3, L * 0.045);
    const deckY = mesh.userData.deckY ?? F + 1.1;
    const lay = LAYOUT[cls] || DEFAULT_LAYOUT;
    this.deckF = F; // the hull's top (main deck) is solid from above: cameras below it must stay below it
    const g = new THREE.Group(); g.name = 'interior'; g.visible = false;
    const M = this.makeMaterials(lay.type);
    this.mats = M;
    const ctx = { g, M, L, B, deckY, lay, C, cls };
    if (lay.type === 'cargo') this.layoutCargo(ctx);
    else if (lay.type === 'small') this.layoutSmall(ctx);
    else if (lay.type === 'yacht') this.layoutYacht(ctx);
    else this.layoutSail(ctx);
    mesh.add(g);
    this.group = g; this.builtFor = mesh; this.builtCls = cls;
  }
  makeMaterials(type) {
    const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.05, side: THREE.DoubleSide, ...extra });
    return {
      wall: std(type === 'sail' || type === 'yacht' ? 0xe6dccb : 0xdfe3e0), wallDark: std(0x9aa0a4), ceil: std(0xf1f1ec),
      floor: std(type === 'sail' || type === 'yacht' ? 0x8a6a44 : 0x4a4f55, { roughness: 0.6 }), floorEng: std(0x3b4043, { metalness: 0.3, roughness: 0.5 }),
      steel: std(0x6b7378, { metalness: 0.6, roughness: 0.4 }), dark: std(0x23272b, { metalness: 0.3, roughness: 0.5 }), console: std(0x2c3238, { metalness: 0.2, roughness: 0.5 }),
      wood: std(0x7d5a36, { roughness: 0.5 }), fabric: std(0x2f4a7a), fabric2: std(0x7a3a3a), blanket: std(0x3a5a8a), pillow: std(0xf0f0ea), engine: std(0x2e7d4f, { metalness: 0.5, roughness: 0.45 }),
      yellow: std(0xe3b018), red: std(0xc0392b), white: std(0xf4f4f0), rail: std(0xbfc4c8, { metalness: 0.7, roughness: 0.3 }),
      glass: new THREE.MeshStandardMaterial({ color: 0x9fc8e8, transparent: true, opacity: 0.16, roughness: 0.05, metalness: 0.3, side: THREE.DoubleSide, depthWrite: false }),
      light: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2d8, emissiveIntensity: 1.6 }),
    };
  }
  /** A room: walls (with openings), floor and ceiling (with holes). side n = forward (smaller z), s = aft, e = starboard, w = port. */
  room(ctx, r) {
    const { g, M } = ctx;
    const h = r.h ?? 2.5; r.h = h; r.floorHoles = r.floorHoles || []; r.ceilHoles = r.ceilHoles || []; r.walls = r.walls || {};
    r.openings = r.openings || { n: [], s: [], e: [], w: [] };
    this.rooms.push(r);
    // floor and ceiling
    for (const q of rectMinusHoles({ x0: r.x0, x1: r.x1, z0: r.z0, z1: r.z1 }, r.floorHoles)) g.add(box(q.x1 - q.x0, 0.06, q.z1 - q.z0, r.floorMat || M.floor, (q.x0 + q.x1) / 2, r.y - 0.03, (q.z0 + q.z1) / 2));
    if (r.ceiling !== false) {
      for (const q of rectMinusHoles({ x0: r.x0, x1: r.x1, z0: r.z0, z1: r.z1 }, r.ceilHoles)) g.add(box(q.x1 - q.x0, 0.06, q.z1 - q.z0, M.ceil, (q.x0 + q.x1) / 2, r.y + h + 0.03, (q.z0 + q.z1) / 2));
      // a light fixture
      g.add(box(Math.min(1.2, (r.x1 - r.x0) * 0.4), 0.04, 0.25, M.light, (r.x0 + r.x1) / 2, r.y + h - 0.03, (r.z0 + r.z1) / 2));
    }
    r.built = true;
  }
  /** Build the walls of every room after all doors/openings were registered. */
  finishWalls(ctx) {
    for (const r of this.rooms) {
      const wallH = r.wallH ?? r.h;
      const sides = { n: { axis: 'x', c: r.z0 + 0.05, from: r.x0, to: r.x1 }, s: { axis: 'x', c: r.z1 - 0.05, from: r.x0, to: r.x1 }, w: { axis: 'z', c: r.x0 + 0.05, from: r.z0, to: r.z1 }, e: { axis: 'z', c: r.x1 - 0.05, from: r.z0, to: r.z1 } };
      for (const [side, s] of Object.entries(sides)) {
        if (r.walls[side] === false) continue;
        this.wall(ctx, s.axis, s.c, s.from, s.to, r.y, wallH, r.openings[side], r.wallMat || ctx.M.wall);
      }
    }
  }
  wall(ctx, axis, c, from, to, yBase, h, openings, mat) {
    const { g, M } = ctx;
    const segs = [];
    const ops = [...(openings || [])].filter((o) => o.to > o.from).sort((a, b) => a.from - b.from);
    let cur = from;
    const place = (a, b, bot, top, m) => {
      if (b - a < 0.01 || top - bot < 0.01) return;
      const len = b - a, mid = (a + b) / 2, yy = yBase + (bot + top) / 2, hh = top - bot;
      segs.push(axis === 'x' ? box(len, hh, 0.1, m, mid, yy, c) : box(0.1, hh, len, m, c, yy, mid));
    };
    for (const o of ops) {
      const a = Math.max(from, o.from), b = Math.min(to, o.to);
      if (a > cur) place(cur, a, 0, h, mat);
      const bot = Math.max(0, o.bottom ?? 0), top = Math.min(h, o.top ?? h);
      if (bot > 0) place(a, b, 0, bot, mat);
      if (top < h) place(a, b, top, h, mat);
      if (o.glass) place(a, b, bot, top, M.glass);
      cur = Math.max(cur, b);
    }
    if (cur < to) place(cur, to, 0, h, mat);
    for (const s of segs) g.add(s);
  }
  /** Doorway between two rooms sharing a wall (A's `side` faces B). at = centre along the wall, w = width. */
  door(a, b, side, at, w = 1.0, height = 2.05, opts = {}) {
    const opp = { n: 's', s: 'n', e: 'w', w: 'e' }[side];
    const op = { from: at - w / 2, to: at + w / 2, bottom: 0, top: height };
    a.openings[side].push(op); if (b) b.openings[opp].push({ ...op });
    const y = a.y;
    if (opts.walk !== false) {
      if (side === 'n' || side === 's') { const zc = side === 'n' ? a.z0 : a.z1; this.doors.push({ x0: at - w / 2 + 0.1, x1: at + w / 2 - 0.1, z0: zc - 0.7, z1: zc + 0.7, y }); }
      else { const xc = side === 'w' ? a.x0 : a.x1; this.doors.push({ x0: xc - 0.7, x1: xc + 0.7, z0: at - w / 2 + 0.1, z1: at + w / 2 - 0.1, y }); }
    }
  }
  window(r, side, from, to, bottom = 1.0, top = 2.2) { r.openings[side].push({ from, to, bottom, top, glass: true }); }
  /** Ramp / ladder between two decks, running along z: y0 at z0, y1 at z1. Cuts holes in the rooms it passes. */
  ramp(ctx, r) {
    const { g, M } = ctx;
    this.ramps.push(r);
    const dz = r.z1 - r.z0, dy = r.y1 - r.y0, len = Math.hypot(dz, dy), w = r.x1 - r.x0;
    const ang = -Math.atan2(dy, dz);
    const yTop = Math.max(r.y0, r.y1), yBot = Math.min(r.y0, r.y1);
    // holes: the upper room's floor and the lower room's ceiling where the ramp passes
    let upper = null, covered = 0;
    for (const room of this.rooms) {
      const ix0 = Math.max(room.x0, r.x0 - 0.05), ix1 = Math.min(room.x1, r.x1 + 0.05), iz0 = Math.max(room.z0, r.z0), iz1 = Math.min(room.z1, r.z1);
      if (ix1 - ix0 < 0.05 || iz1 - iz0 < 0.05) continue;
      if (Math.abs(room.y - yTop) < 0.3) { room.floorHoles.push({ x0: ix0, x1: ix1, z0: iz0, z1: iz1 }); upper = room; covered += (ix1 - ix0) * (iz1 - iz0); }
      else if (room.y < yTop - 0.3 && room.y + room.h > yBot) room.ceilHoles.push({ x0: ix0, x1: ix1, z0: iz0, z1: iz1 });
    }
    const capH = upper ? (upper.ceiling === false ? upper.h : upper.h) : 2.2;
    const surf = box(w, 0.08, len, M.dark, (r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2 + 0.02, (r.z0 + r.z1) / 2); surf.rotation.x = ang; g.add(surf);
    const steps = Math.max(3, Math.round(len / 0.3));
    for (let i = 0; i < steps; i++) { const t = (i + 0.5) / steps; const s = box(w - 0.1, 0.03, 0.12, M.rail, (r.x0 + r.x1) / 2, r.y0 + dy * t + 0.06, r.z0 + dz * t); s.rotation.x = ang; g.add(s); }
    const hr = cyl(0.025, len, M.rail, r.x0 + 0.08, (r.y0 + r.y1) / 2 + 0.95, (r.z0 + r.z1) / 2, 8); hr.rotation.x = ang + Math.PI / 2; g.add(hr);
    // stairwell enclosure: two side walls up to the upper room's ceiling, the end wall under the upper landing, a roof when nothing covers it
    const wallTop = yTop + capH;
    for (const x of [r.x0 - 0.03, r.x1 + 0.03]) g.add(box(0.08, wallTop - yBot, dz, M.wallDark, x, (wallTop + yBot) / 2, (r.z0 + r.z1) / 2));
    const highEnd = r.y1 > r.y0 ? r.z1 : r.z0;
    g.add(box(w + 0.1, yTop - yBot, 0.08, M.wallDark, (r.x0 + r.x1) / 2, (yTop + yBot) / 2, highEnd + (r.y1 > r.y0 ? 0.04 : -0.04)));
    if (covered < 0.5 * w * dz) {
      g.add(box(w + 0.16, 0.06, dz, M.ceil, (r.x0 + r.x1) / 2, wallTop + 0.03, (r.z0 + r.z1) / 2));
      const lowEnd = r.y1 > r.y0 ? r.z0 : r.z1; // the open lower end leads into the lower room; close the sides above the upper landing
      g.add(box(w + 0.1, capH, 0.08, M.wallDark, (r.x0 + r.x1) / 2, yTop + capH / 2, highEnd + (r.y1 > r.y0 ? 0.04 : -0.04)));
      void lowEnd;
    }
  }
  /** A short flat corridor piece (floor, two side walls, roof) joining a room's doorway to a stair outside the room. */
  landing(ctx, x0, x1, z0, z1, y, h = 2.2) {
    const { g, M } = ctx;
    g.add(box(x1 - x0, 0.06, z1 - z0, M.floor, (x0 + x1) / 2, y - 0.03, (z0 + z1) / 2));
    g.add(box(x1 - x0 + 0.16, 0.06, z1 - z0, M.ceil, (x0 + x1) / 2, y + h + 0.03, (z0 + z1) / 2));
    for (const x of [x0 - 0.03, x1 + 0.03]) g.add(box(0.08, h, z1 - z0, M.wallDark, x, y + h / 2, (z0 + z1) / 2));
    this.doors.push({ x0: x0 + 0.1, x1: x1 - 0.1, z0: z0 - 0.5, z1: z1 + 0.4, y });
  }
  hotspot(kind, label, x, y, z, r = 1.7) { this.hotspots.push({ kind, label, x, y, z, r }); }
  /** Furniture footprint the walker cannot pass through (ship frame, on the deck at height y). */
  solid(x0, x1, z0, z1, y) { this.solids.push({ x0: Math.min(x0, x1), x1: Math.max(x0, x1), z0: Math.min(z0, z1), z1: Math.max(z0, z1), y }); }

  // ---- furniture
  helmConsole(ctx, x, y, z, w, facing = -1) {
    // console box at the front of the bridge (facing = -1: the player stands aft of it looking forward)
    const { g, M } = ctx;
    const d = 0.8;
    g.add(box(w, 1.0, d, M.console, x, y + 0.5, z));
    const top = box(w, 0.08, d + 0.1, M.dark, x, y + 1.04, z); top.rotation.x = facing * 0.18; g.add(top);
    // wheel
    const wheel = new THREE.Group(); wheel.position.set(x, y + 1.25, z - facing * 0.5);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.025, 8, 24), M.wood); wheel.add(ring);
    for (let i = 0; i < 4; i++) { const sp = box(0.03, 0.56, 0.03, M.wood); sp.rotation.z = (i * Math.PI) / 4; wheel.add(sp); }
    wheel.rotation.x = facing * -0.35; g.add(wheel); this.wheel = wheel;
    // throttle lever on the starboard side of the wheel
    const lever = new THREE.Group(); lever.position.set(x + Math.min(0.9, w * 0.25), y + 1.08, z); const stem = box(0.04, 0.3, 0.04, M.rail, 0, 0.15, 0); const knob = box(0.08, 0.08, 0.08, M.red, 0, 0.32, 0); lever.add(stem, knob); g.add(lever); this.lever = lever;
    g.add(box(0.14, 0.04, 0.3, M.dark, lever.position.x, y + 1.06, z));
    // radar screen on the port side: mirrors the HUD radar canvas
    const radarCv = document.getElementById('radar');
    if (radarCv) {
      this.radarTex = new THREE.CanvasTexture(radarCv); this.radarTex.colorSpace = THREE.SRGBColorSpace;
      const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5), new THREE.MeshBasicMaterial({ map: this.radarTex, side: THREE.DoubleSide }));
      scr.position.set(x - Math.min(0.9, w * 0.25), y + 1.36, z - facing * 0.06); scr.rotation.x = facing * -0.35; if (facing > 0) scr.rotation.y = Math.PI; g.add(scr);
      const back = box(0.6, 0.6, 0.06, M.dark, scr.position.x, scr.position.y, z); back.rotation.x = facing * -0.35; g.add(back);
    }
    // compass + instrument panel
    g.add(cyl(0.12, 0.06, M.white, x, y + 1.1, z + facing * 0.25, 16));
    g.add(box(w * 0.6, 0.28, 0.04, M.dark, x, y + 1.3, z + facing * 0.36));
    for (let i = 0; i < 5; i++) g.add(box(0.05, 0.05, 0.02, i % 2 ? M.red : new THREE.MeshStandardMaterial({ color: 0x58d68d, emissive: 0x58d68d, emissiveIntensity: 1.2 }), x - w * 0.25 + i * (w * 0.12), y + 1.3, z + facing * 0.385));
    // chair
    g.add(cyl(0.05, 0.6, M.rail, x, y + 0.3, z - facing * 1.6, 8)); g.add(box(0.5, 0.08, 0.5, M.fabric, x, y + 0.62, z - facing * 1.6)); g.add(box(0.5, 0.5, 0.08, M.fabric, x, y + 0.9, z - facing * 1.6 - facing * -0.22));
    this.solid(x - w / 2, x + w / 2, z - d / 2 - 0.05, z + d / 2 + 0.05, y);
    this.hotspot('helm', 'Take the helm', x, y, z - facing * 1.0, 1.5);
    this.helmPos = { x, y, z: z - facing * 1.0 };
  }
  radio(ctx, x, y, z, rotY = 0) {
    const { g, M } = ctx;
    const r = new THREE.Group(); r.position.set(x, y, z); r.rotation.y = rotY;
    r.add(box(0.36, 0.14, 0.2, M.dark, 0, 0, 0)); r.add(box(0.26, 0.05, 0.01, new THREE.MeshStandardMaterial({ color: 0x9ad7ff, emissive: 0x9ad7ff, emissiveIntensity: 1.1 }), 0, 0.02, 0.105)); r.add(cyl(0.015, 0.22, M.rail, 0.22, 0.18, 0, 6));
    g.add(r); this.hotspot('radio', 'Use the VHF radio (chat)', x, y - 1.0, z, 1.5);
  }
  chartTable(ctx, x, y, z, w = 1.4, d = 0.9) {
    const { g, M } = ctx;
    g.add(box(w, 0.06, d, M.wood, x, y + 0.9, z)); g.add(box(w - 0.1, 0.8, d - 0.1, M.wallDark, x, y + 0.45, z));
    const paper = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.2, d - 0.2), new THREE.MeshStandardMaterial({ color: 0xf2eedc, roughness: 0.9 }));
    paper.rotation.x = -Math.PI / 2; paper.position.set(x, y + 0.935, z); g.add(paper);
    try { new THREE.TextureLoader().load('/api/chart/region.png', (t) => { t.colorSpace = THREE.SRGBColorSpace; paper.material.map = t; paper.material.color.set(0xffffff); paper.material.needsUpdate = true; }); } catch {}
    const pencil = cyl(0.012, 0.18, M.yellow, x + w * 0.3, y + 0.95, z + d * 0.2, 6); pencil.rotation.z = 1.2; g.add(pencil);
    this.solid(x - w / 2, x + w / 2, z - d / 2, z + d / 2, y);
    this.hotspot('chart', 'Open the chart', x, y, z, 1.6);
  }
  bunk(ctx, x, y, z, along = 'z', len = 2.0, tiers = 2, flip = false) {
    const { g, M } = ctx;
    const w = 0.85;
    for (let t = 0; t < tiers; t++) {
      const yy = y + 0.45 + t * 0.95;
      const sx = along === 'z' ? w : len, sz = along === 'z' ? len : w;
      g.add(box(sx, 0.16, sz, M.wood, x, yy, z)); g.add(box(sx - 0.1, 0.12, sz - 0.1, M.blanket, x, yy + 0.13, z));
      const px = along === 'z' ? x : x + (flip ? -1 : 1) * (len / 2 - 0.3), pz = along === 'z' ? z + (flip ? 1 : -1) * (len / 2 - 0.3) : z;
      g.add(box(along === 'z' ? 0.5 : 0.4, 0.1, along === 'z' ? 0.4 : 0.5, M.pillow, px, yy + 0.22, pz));
    }
    { const sx = along === 'z' ? w : len, sz = along === 'z' ? len : w; this.solid(x - sx / 2, x + sx / 2, z - sz / 2, z + sz / 2, y); }
    this.hotspot('bunk', 'Rest in the bunk', x, y, z, 1.4);
  }
  table(ctx, x, y, z, w = 1.6, d = 0.8, sofa = true) {
    const { g, M } = ctx;
    g.add(box(w, 0.05, d, M.wood, x, y + 0.75, z)); g.add(box(0.1, 0.72, 0.1, M.rail, x, y + 0.36, z));
    if (sofa) { g.add(box(w + 0.3, 0.45, 0.55, M.fabric2, x, y + 0.23, z + d / 2 + 0.4)); g.add(box(w + 0.3, 0.5, 0.15, M.fabric2, x, y + 0.7, z + d / 2 + 0.6)); }
    this.solid(x - w / 2, x + w / 2, z - d / 2, z + d / 2, y);
    if (sofa) this.solid(x - (w + 0.3) / 2, x + (w + 0.3) / 2, z + d / 2 + 0.12, z + d / 2 + 0.68, y);
  }
  galley(ctx, x, y, z, w = 1.8, rotY = 0) {
    const { g, M } = ctx;
    const k = new THREE.Group(); k.position.set(x, y, z); k.rotation.y = rotY;
    k.add(box(w, 0.9, 0.6, M.white, 0, 0.45, 0)); k.add(box(w, 0.05, 0.62, M.dark, 0, 0.92, 0));
    k.add(box(0.5, 0.03, 0.4, M.steel, -w * 0.25, 0.96, 0)); for (let i = 0; i < 4; i++) k.add(cyl(0.07, 0.02, M.dark, -w * 0.25 + (i % 2 ? 0.14 : -0.14), 0.98, i < 2 ? -0.1 : 0.1, 10));
    k.add(box(0.45, 0.02, 0.35, M.rail, w * 0.25, 0.95, 0)); k.add(box(w * 0.8, 0.6, 0.35, M.white, 0, 1.75, -0.12));
    g.add(k);
    { const c = Math.abs(Math.cos(rotY)), sn = Math.abs(Math.sin(rotY)); const hx = (w / 2) * c + 0.3 * sn, hz = (w / 2) * sn + 0.3 * c; this.solid(x - hx, x + hx, z - hz, z + hz, y); }
  }
  engineBlock(ctx, x, y, z, L) {
    const { g, M } = ctx;
    const el = clamp(L * 0.08, 1.4, 8), eh = clamp(L * 0.03, 0.9, 3.2), ew = clamp(L * 0.025, 0.8, 2.6);
    g.add(box(ew, eh, el, M.engine, x, y + eh / 2 + 0.2, z)); g.add(box(ew + 0.5, 0.2, el + 0.6, M.dark, x, y + 0.1, z));
    const cylN = Math.max(3, Math.min(8, Math.round(el / 0.6)));
    for (let i = 0; i < cylN; i++) g.add(cyl(ew * 0.18, 0.35, M.steel, x, y + eh + 0.35, z - el / 2 + ((i + 0.5) * el) / cylN, 10));
    const ex = cyl(ew * 0.16, 1.4, M.steel, x + ew * 0.45, y + eh + 0.7, z + el * 0.4, 10); g.add(ex);
    const shaft = cyl(ew * 0.12, el * 0.9, M.rail, x - ew * 0.5, y + eh * 0.6, z, 8); shaft.rotation.x = Math.PI / 2; g.add(shaft);
    g.add(box(0.35, 0.5, 0.6, M.yellow, x + ew * 0.7 + 0.3, y + 0.45, z - el * 0.3));
    g.add(box(0.4, 1.9, 0.5, M.wallDark, x - ew - 0.6, y + 0.95, z + el * 0.3)); g.add(box(0.8, 0.5, 0.5, M.steel, x - ew - 0.6, y + 0.25, z - el * 0.1));
    this.solid(x - (ew + 0.5) / 2 - ew * 0.5, x + (ew + 0.5) / 2 + 0.5, z - (el + 0.6) / 2, z + (el + 0.6) / 2, y);
    this.solid(x - ew - 1.0, x - ew - 0.2, z + el * 0.3 - 0.25, z + el * 0.3 + 0.25, y);
  }
  gaugePanel(ctx, x, y, z, rotY = 0) {
    const { g, M } = ctx;
    const cv = makeCanvas(512, 192); this.gauge = { cv, ctx: cv.getContext('2d'), tex: new THREE.CanvasTexture(cv) };
    this.gauge.tex.colorSpace = THREE.SRGBColorSpace;
    const panel = new THREE.Group(); panel.position.set(x, y, z); panel.rotation.y = rotY;
    panel.add(box(1.7, 0.75, 0.1, M.dark, 0, 0, 0));
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.56), new THREE.MeshBasicMaterial({ map: this.gauge.tex })); scr.position.set(0, 0, 0.06); panel.add(scr);
    panel.add(box(0.5, 0.18, 0.04, M.red, -0.5, -0.32, 0.05)); panel.add(box(0.3, 0.18, 0.04, M.yellow, 0.4, -0.32, 0.05));
    g.add(panel);
    this.hotspot('engine', 'Check the engine panel', x, y - 1.2, z, 1.7);
    this.drawGauges();
  }
  drawGauges() {
    const G = this.gauge; if (!G) return;
    const { ctx: c, cv } = G, app = this.app, you = app.you, s = app.ship || you?.ship || { throttle: 0 };
    const C = SHIP_CLASSES[you?.ship.cls] || SHIP_CLASSES.coaster, lay = LAYOUT[you?.ship.cls] || DEFAULT_LAYOUT;
    const thr = Math.abs(s.throttle || 0);
    const t = performance.now() / 1000;
    const dials = [
      { label: 'RPM', v: thr * (you?.fuelEmpty ? 0 : 1) + Math.sin(t * 7) * 0.01 * thr, txt: `${Math.round(thr * lay.rpm)}`, red: 0.92 },
      { label: 'FUEL', v: you ? clamp(you.fuel / C.fuelCap, 0, 1) : 0, txt: you ? `${you.fuel.toFixed(1)} t` : '—', red: 0.1, redLow: true },
      { label: 'TEMP', v: clamp(0.35 + 0.55 * thr + Math.sin(t * 0.7) * 0.03 + (you ? (1 - you.cond / 100) * 0.1 : 0), 0, 1), txt: `${Math.round(40 + 55 * thr)} °C`, red: 0.9 },
    ];
    c.fillStyle = '#1b1f23'; c.fillRect(0, 0, cv.width, cv.height);
    dials.forEach((d, i) => {
      const cx = 86 + i * 170, cy = 92, R = 68;
      c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.fillStyle = '#0d1114'; c.fill(); c.lineWidth = 4; c.strokeStyle = '#596067'; c.stroke();
      const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
      c.lineWidth = 6; c.strokeStyle = '#2d3a44'; c.beginPath(); c.arc(cx, cy, R - 10, a0, a1); c.stroke();
      c.strokeStyle = '#c0392b'; c.beginPath(); if (d.redLow) c.arc(cx, cy, R - 10, a0, a0 + (a1 - a0) * d.red); else c.arc(cx, cy, R - 10, a0 + (a1 - a0) * d.red, a1); c.stroke();
      for (let k = 0; k <= 10; k++) { const a = a0 + ((a1 - a0) * k) / 10; c.strokeStyle = '#cfd6dc'; c.lineWidth = k % 5 ? 1 : 2; c.beginPath(); c.moveTo(cx + Math.cos(a) * (R - 18), cy + Math.sin(a) * (R - 18)); c.lineTo(cx + Math.cos(a) * (R - 24), cy + Math.sin(a) * (R - 24)); c.stroke(); }
      const a = a0 + (a1 - a0) * clamp(d.v, 0, 1);
      c.strokeStyle = '#f2b134'; c.lineWidth = 3; c.beginPath(); c.moveTo(cx - Math.cos(a) * 8, cy - Math.sin(a) * 8); c.lineTo(cx + Math.cos(a) * (R - 22), cy + Math.sin(a) * (R - 22)); c.stroke();
      c.fillStyle = '#f2b134'; c.beginPath(); c.arc(cx, cy, 5, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#dbe9f4'; c.font = 'bold 15px monospace'; c.textAlign = 'center'; c.fillText(d.label, cx, cy + 40); c.font = '13px monospace'; c.fillStyle = '#9ad7ff'; c.fillText(d.txt, cx, cy + 58);
    });
    c.fillStyle = you?.fuelEmpty ? '#ff6b6b' : you && you.flooding > 0.01 ? '#f2b134' : '#58d68d'; c.beginPath(); c.arc(cv.width - 22, 22, 7, 0, Math.PI * 2); c.fill();
    G.tex.needsUpdate = true;
  }

  // ---- layouts
  layoutCargo(ctx) {
    const { L, B, deckY, lay, C } = ctx;
    const W = clamp(B * 0.7, 7, 14), bz = lay.bridgeZ * L;
    const y2 = deckY + lay.superH, y1 = y2 - 2.8, y0 = Math.max(1.4, Math.min(deckY - 3.2, y1 - 3.0));
    // --- bridge
    const bridge = { id: 'bridge', x0: -W / 2, x1: W / 2, z0: bz - 2.5, z1: bz + 2.5, y: y2, h: 2.6 };
    this.room(ctx, bridge);
    this.window(bridge, 'n', -W / 2 + 0.3, W / 2 - 0.3, 1.0, 2.3);
    this.window(bridge, 'e', bz - 2.3, bz + 1.0, 1.0, 2.3); this.window(bridge, 'w', bz - 2.3, bz + 1.0, 1.0, 2.3);
    this.window(bridge, 's', -W / 2 + 1.8, W / 2 - 0.3, 1.2, 2.2);
    this.helmConsole(ctx, 0, y2, bz - 1.9, Math.min(W - 1.5, 5.5));
    this.chartTable(ctx, W / 2 - 1.1, y2, bz + 1.6, 1.4, 0.9);
    this.radio(ctx, -Math.min(2.2, W / 2 - 0.8), y2 + 1.75, bz - 2.3, 0);
    this.spawn = { x: 0, y: y2, z: bz + 0.6, yaw: 0 };
    // --- accommodation deck: fore-aft passage, cabins port/starboard forward, lobby (stair foot) aft-port, mess aft-starboard
    const pass = { id: 'passage', x0: -0.8, x1: 0.8, z0: bz - 2.5, z1: bz + 7.5, y: y1, h: 2.5 };
    const lobby = { id: 'lobby', x0: -W / 2, x1: -0.8, z0: bz + 2.9, z1: bz + 7.5, y: y1, h: 2.5 };
    this.room(ctx, pass); this.room(ctx, lobby);
    this.door(lobby, pass, 'e', bz + 4.6, 2.2, 2.4); // wide opening
    for (let i = 0; i < 3; i++) ctx.g.add(box(0.5, 0.5, 0.5, i % 2 ? ctx.M.yellow : ctx.M.wood, -W / 2 + 0.6, y1 + 0.25 + i * 0.5, bz + 7.0));
    const bunks = clamp(C.pax || 4, 2, 8), cabinsN = Math.ceil(bunks / 2);
    const slots = [{ side: 'e', z0: bz - 2.5, z1: bz + 0.2 }, { side: 'w', z0: bz - 2.5, z1: bz + 0.2 }, { side: 'e', z0: bz + 0.2, z1: bz + 2.9 }, { side: 'w', z0: bz + 0.2, z1: bz + 2.9 }];
    let placed = 0;
    for (let i = 0; i < slots.length && placed < cabinsN; i++) {
      const s = slots[i];
      const cab = { id: 'cabin' + i, x0: s.side === 'e' ? 0.8 : -W / 2, x1: s.side === 'e' ? W / 2 : -0.8, z0: s.z0, z1: s.z1, y: y1, h: 2.5 };
      this.room(ctx, cab);
      this.door(cab, pass, s.side === 'e' ? 'w' : 'e', (s.z0 + s.z1) / 2, 0.9);
      const bx = s.side === 'e' ? W / 2 - 0.55 : -W / 2 + 0.55;
      this.bunk(ctx, bx, y1, (s.z0 + s.z1) / 2, 'z', Math.min(2.0, s.z1 - s.z0 - 0.4), Math.min(2, bunks - placed * 2));
      this.window(cab, s.side === 'e' ? 'e' : 'w', s.z0 + 0.8, s.z1 - 0.8, 1.3, 1.9);
      placed++;
    }
    const mess = { id: 'mess', x0: 0.8, x1: W / 2, z0: bz + 2.9, z1: bz + 7.5, y: y1, h: 2.5 };
    this.room(ctx, mess); this.door(mess, pass, 'w', bz + 3.6, 0.95);
    const messW = W / 2 - 0.8;
    this.table(ctx, 0.8 + messW * 0.42, y1, bz + 4.3, Math.min(1.6, messW * 0.6), 0.8, true);
    this.galley(ctx, 0.8 + Math.max(0.9, (messW - 1.6) / 2), y1, bz + 7.1, Math.max(1.2, messW - 1.9), 0);
    this.window(mess, 'e', bz + 3.4, bz + 5.6, 1.3, 1.9);
    // stairs: bridge → lobby, through the bridge's aft wall, a short landing, then down aft inside the lobby
    const s1len = clamp((y2 - y1) * 0.95, 2.6, 4);
    const sx0 = -W / 2 + 0.3, sx1 = -W / 2 + 1.5;
    bridge.openings.s.push({ from: sx0, to: sx1, bottom: 0, top: 2.1 });
    this.landing(ctx, sx0, sx1, bz + 2.45, bz + 2.9, y2, 2.2);
    this.ramp(ctx, { x0: sx0, x1: sx1, z0: bz + 2.9, z1: bz + 2.9 + s1len, y0: y2, y1: y1 });
    // --- engine room (below) + its ladder from the starboard aft corner of the mess
    const eng = { id: 'engine', x0: -W / 2, x1: W / 2, z0: bz - 3, z1: bz + 8, y: y0, h: Math.min(3.2, y1 - y0 - 0.3), floorMat: ctx.M.floorEng, wallMat: ctx.M.wallDark };
    this.room(ctx, eng);
    const s2len = clamp((y1 - y0) * 0.7, 2.6, 4.2);
    this.ramp(ctx, { x0: W / 2 - 1.3, x1: W / 2 - 0.2, z0: bz + 7.3 - s2len, z1: bz + 7.3, y0: y0, y1: y1 });
    this.engineBlock(ctx, -W * 0.12, y0, bz + 1.0, L);
    this.gaugePanel(ctx, W / 2 - 1.6, y0 + 1.5, bz - 2.9, 0);
    for (let i = 0; i < 3; i++) ctx.g.add(cyl(0.12, y1 - y0 - 0.4, ctx.M.rail, -W / 2 + 0.5, y0 + (y1 - y0 - 0.4) / 2, bz - 1 + i * 2.5, 8));
    this.finishWalls(ctx);
  }
  layoutSmall(ctx) {
    const { L, B, deckY, lay, C } = ctx;
    const W = clamp(B * 0.6, 3, 6), bz = lay.bridgeZ * L;
    const y2 = deckY + lay.superH, y0 = Math.max(1.2, deckY - 2.4);
    const wh = { id: 'wheelhouse', x0: -W / 2, x1: W / 2, z0: bz - 1.8, z1: bz + 1.8, y: y2, h: 2.3 };
    this.room(ctx, wh);
    this.window(wh, 'n', -W / 2 + 0.25, W / 2 - 0.25, 1.0, 2.1); this.window(wh, 'e', bz - 1.6, bz + 1.0, 1.0, 2.1); this.window(wh, 'w', bz - 1.6, bz + 1.0, 1.0, 2.1); this.window(wh, 's', W / 2 - 1.6, W / 2 - 0.25, 1.1, 2.0);
    this.helmConsole(ctx, -W * 0.12, y2, bz - 1.3, Math.min(W - 1.4, 2.6));
    this.radio(ctx, -W / 2 + 0.5, y2 + 1.7, bz - 1.5, 0);
    this.chartTable(ctx, -W / 2 + 0.55, y2, bz + 1.2, 0.9, 0.7);
    this.spawn = { x: -W * 0.12, y: y2, z: bz + 0.6, yaw: 0 };
    const zMin = Math.max(-L / 2 + 1.5, bz - 5), zMid = bz + 4, zMax = Math.min(L / 2 - 1.5, bz + 8);
    const cab = { id: 'cabin', x0: -W / 2, x1: W / 2, z0: zMin, z1: zMid, y: y0, h: 2.1 };
    const eng = { id: 'engine', x0: -W / 2, x1: W / 2, z0: zMid, z1: zMax, y: y0, h: 2.1, floorMat: ctx.M.floorEng, wallMat: ctx.M.wallDark };
    this.room(ctx, cab); this.room(ctx, eng);
    this.door(cab, eng, 's', 0, 0.9, 1.9);
    const bunks = clamp(C.pax || 4, 2, 6);
    this.bunk(ctx, -W / 2 + 0.5, y0, zMin + 1.4, 'z', 2.0, Math.min(2, bunks));
    if (bunks > 2) this.bunk(ctx, W / 2 - 0.5, y0, zMin + 1.4, 'z', 2.0, Math.min(2, bunks - 2));
    if (bunks > 4) this.bunk(ctx, -W / 2 + 0.5, y0, zMin + 3.6, 'z', 2.0, Math.min(2, bunks - 4));
    this.table(ctx, W * 0.15, y0, zMid - 1.8, 1.2, 0.7, true);
    this.galley(ctx, -W / 2 + 0.35, y0, zMid - 1.5, 1.4, Math.PI / 2);
    const s1len = clamp((y2 - y0) * 0.6, 2.4, 3.2);
    this.ramp(ctx, { x0: W / 2 - 1.2, x1: W / 2 - 0.15, z0: bz + 1.8 - s1len, z1: bz + 1.8, y0: y0, y1: y2 });
    this.engineBlock(ctx, 0, y0, (zMid + zMax) / 2 + 0.4, L);
    this.gaugePanel(ctx, -W / 2 + 0.95, y0 + 1.4, zMid + 0.12, 0);
    this.finishWalls(ctx);
  }
  layoutYacht(ctx) {
    const { L, B, deckY, lay, C } = ctx;
    const W = clamp(B * 0.7, 2.6, 5), bz = lay.bridgeZ * L;
    const y2 = deckY + lay.superH, y0 = Math.max(1.0, deckY - 2.2);
    const open = !!lay.open;
    const helm = { id: 'helm', x0: -W / 2, x1: W / 2, z0: bz - 1.6, z1: bz + 2.6, y: y2, h: open ? 0.9 : 2.2, ceiling: !open };
    this.room(ctx, helm);
    if (!open) { this.window(helm, 'n', -W / 2 + 0.2, W / 2 - 0.2, 0.9, 2.0); this.window(helm, 'e', bz - 1.4, bz + 2.2, 0.9, 1.9); this.window(helm, 'w', bz - 1.4, bz + 2.2, 0.9, 1.9); }
    else { this.window(helm, 'n', -W / 2 + 0.2, W / 2 - 0.2, 0.6, 0.9); helm.walls.s = false; }
    this.helmConsole(ctx, W * 0.2, y2, bz - 1.0, Math.min(W - 0.6, 1.6));
    this.radio(ctx, -W * 0.3, y2 + 1.0, bz - 1.2, 0);
    this.spawn = { x: 0, y: y2, z: bz + 1.2, yaw: 0 };
    const zMin = Math.max(-L / 2 + 1.2, bz - 7.5);
    const saloon = { id: 'saloon', x0: -W / 2, x1: W / 2, z0: zMin, z1: bz - 1.6 + 0.4, y: y0, h: 1.95 };
    this.room(ctx, saloon);
    this.window(saloon, 'e', zMin + 1, saloon.z1 - 1.2, 1.2, 1.6); this.window(saloon, 'w', zMin + 1, saloon.z1 - 1.2, 1.2, 1.6);
    this.table(ctx, 0.2, y0, zMin + 2.4, Math.min(1.4, W - 1.2), 0.7, true);
    this.galley(ctx, -W / 2 + 0.35, y0, saloon.z1 - 1.3, 1.4, Math.PI / 2);
    this.bunk(ctx, 0, y0, zMin + 1.0, 'x', Math.min(W - 0.6, 1.9), 1, false);
    this.chartTable(ctx, W / 2 - 0.5, y0, saloon.z1 - 1.3, 0.8, 0.6);
    const s1len = clamp((y2 - y0) * 0.7, 1.6, 2.6);
    this.ramp(ctx, { x0: -0.45, x1: 0.45, z0: bz - 1.2 - s1len + 0.4, z1: bz - 1.2 + 0.4, y0: y0, y1: y2 });
    this.gaugePanel(ctx, 0, y0 + 1.2, saloon.z1 - 0.12, Math.PI);
    this.hotspots[this.hotspots.length - 1].label = 'Check the engine panel';
    this.finishWalls(ctx);
  }
  layoutSail(ctx) {
    const { L, B, deckY, lay, C } = ctx;
    const Wc = clamp(B * 0.55, 1.8, 4), Ws = clamp(B * 0.7, 2.2, 5), bz = lay.bridgeZ * L;
    const y2 = deckY + lay.superH, y0 = Math.max(0.9, deckY - 2.3);
    const cockpit = { id: 'cockpit', x0: -Wc / 2, x1: Wc / 2, z0: bz - 1.4, z1: bz + 1.8, y: y2, h: 0.6, ceiling: false };
    this.room(ctx, cockpit);
    // wheel pedestal at the aft end of the cockpit; the skipper stands forward of it
    const ped = cyl(0.07, 0.9, ctx.M.rail, 0, y2 + 0.45, bz + 1.2, 8); ctx.g.add(ped);
    const wheel = new THREE.Group(); wheel.position.set(0, y2 + 1.0, bz + 1.2); wheel.add(new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.025, 8, 28), ctx.M.rail)); for (let i = 0; i < 4; i++) { const sp = box(0.03, 0.9, 0.03, ctx.M.rail); sp.rotation.z = (i * Math.PI) / 4; wheel.add(sp); } ctx.g.add(wheel); this.wheel = wheel;
    ctx.g.add(cyl(0.1, 0.05, ctx.M.white, 0, y2 + 1.05, bz + 0.1, 16)); ctx.g.add(box(0.22, 0.22, 0.06, ctx.M.dark, 0, y2 + 1.2, bz - 1.3));
    this.hotspot('helm', 'Take the helm', 0, y2, bz + 0.5, 1.4); this.helmPos = { x: 0, y: y2, z: bz + 0.5 };
    for (const x of [-Wc / 2 + 0.25, Wc / 2 - 0.25]) ctx.g.add(box(0.4, 0.4, 2.8, ctx.M.wood, x, y2 + 0.2, bz + 0.2));
    this.spawn = { x: 0, y: y2, z: bz + 0.4, yaw: 0 };
    const zMin = Math.max(-L / 2 + 1.4, bz - 8.5);
    const saloon = { id: 'saloon', x0: -Ws / 2, x1: Ws / 2, z0: zMin + 2.2, z1: bz - 1.4 + 0.4, y: y0, h: 1.9 };
    const vberth = { id: 'vberth', x0: -Ws / 2 + 0.3, x1: Ws / 2 - 0.3, z0: zMin, z1: zMin + 2.2, y: y0, h: 1.7 };
    this.room(ctx, saloon); this.room(ctx, vberth);
    this.door(saloon, vberth, 'n', 0, 0.8, 1.65);
    this.window(saloon, 'e', saloon.z0 + 0.8, saloon.z1 - 1.0, 1.25, 1.55); this.window(saloon, 'w', saloon.z0 + 0.8, saloon.z1 - 1.0, 1.25, 1.55);
    this.table(ctx, 0, y0, saloon.z0 + 1.6, Math.min(1.2, Ws - 1.4), 0.6, false);
    for (const sx of [-1, 1]) ctx.g.add(box(0.55, 0.42, 2.0, ctx.M.fabric2, sx * (Ws / 2 - 0.4), y0 + 0.21, saloon.z0 + 1.6));
    this.galley(ctx, Ws / 2 - 0.35, y0, saloon.z1 - 1.0, 1.3, -Math.PI / 2);
    this.chartTable(ctx, -Ws / 2 + 0.5, y0, saloon.z1 - 0.9, 0.8, 0.6);
    this.radio(ctx, -Ws / 2 + 0.5, y0 + 1.55, saloon.z1 - 0.25, 0);
    this.bunk(ctx, 0, y0, zMin + 1.1, 'x', Math.min(Ws - 0.8, 1.9), 1);
    const s1len = clamp((y2 - y0) * 0.6, 1.2, 2.2);
    this.ramp(ctx, { x0: -0.4, x1: 0.4, z0: bz - 1.0 - s1len, z1: bz - 1.0, y0: y0, y1: y2 });
    this.gaugePanel(ctx, Ws / 2 - 1.0, y0 + 1.3, saloon.z1 - 0.12, Math.PI);
    this.finishWalls(ctx);
    void C;
  }
}

function disposeFallback(g) {
  g.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of ms) { m.map?.dispose(); m.dispose(); }
  });
}
