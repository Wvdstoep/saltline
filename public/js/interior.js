// Walkable ship (docs/V3-CONTRACTS.md §5, docs/V5-PLAN.md items 6 + 7): bridge, passages, mess and galley, cabins, the
// engine room and the open decks (main deck, bridge wings, forecastle, flybridge, cockpit) of the player's own ship,
// built as a child group of the ship mesh so everything rides the waves with her.
//
// The layout is a pure deck plan (shipplan.js) and walking is a pure walk map (walker.js) — the node tests prove for
// every class that the stairs, doorways and decks connect. This file draws the plan and drives the walker: third- or
// first-person view, pointer-lock mouse look (touch: TouchHelm.stick + right-half drag), E / tap hotspots (helm,
// engine console, bunk, chart table, radio).
import * as THREE from 'three';
import { SHIP_CLASSES } from '/shared/constants.js';
import { orderLabel, rpmFraction } from '/shared/telegraph.js';
import * as ShipMod from './ship.js';
import { PartBuilder } from './models.js';
import { makeAvatar } from './avatar.js';
import { buildPlan } from './shipplan.js';
import { WalkMap, stairEnds } from './walker.js';
import { drawGAProp, GA_PROP_KINDS, buildZoned, gaInteract, gaZoneUpdate, openGotoMenu } from './gaprops.js';   // SHIPYARD H11 (docs/SHIPS-LANEC-PHASE2.md)
import { baseOf } from '/shared/ships/index.js';
import { buildInteriorV2 } from './iv2draw.js';   // IV2 HV2 (docs/INTERIORS-V2-CONTRACT.md §9.5)
import { iv2Interact, iv2Frame } from './iv2interact.js';   // IV2 HV3b, HV4
import { CruiseCrowd, wantsCrowd } from './iv2crowd.js';   // cruise ships: living guests and crew (docs/CRUISE-CONTRACT.md §6)

const EYE = 1.65;
const WALK = 1.7, RUN = 3.3;
const MOVE_KEYS = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
const RPM = { coaster: 900, feeder: 700, bulker: 110, tanker: 110, boxship: 90, psv: 750, ferry: 500, superyacht: 1600, trawler: 1200, tug: 1000, pilot: 2600, cruiser: 3800, myacht: 2200, sloop: 2800, ketch: 2800, catamaran: 2800, schooner: 1800 };
const LABEL_LAYER = 30; // world name boards are parked here (not rendered) while you are in an enclosed room
const BOX_COLORS = [0xb03a2e, 0x1f618d, 0x117a65, 0xd4ac0d, 0x7d3c98, 0xca6f1e, 0x566573, 0xf0f3f4];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
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
    this.group = null; this.builtFor = null; this.builtCls = null; this.crowd = null;
    this.plan = null; this.map = null; this.st = { x: 0, z: 0, y: 0 };
    this.pos = new THREE.Vector3(); this.y = 0;
    this.v = { dir: new THREE.Vector3(), eye: new THREE.Vector3(), look: new THREE.Vector3(), head: new THREE.Vector3(), want: new THREE.Vector3(), lamp: new THREE.Vector3() }; // per-frame scratch this.yaw = 0; this.pitch = 0; this.bob = 0;
    this.keys = new Set(); this.run = false; this.atHelm = false; this.touchLook = null;
    this.rooms = []; this.hotspots = []; this.nearHotspot = null;
    this.gauge = null; this.radarTex = null; this.lastRadarT = 0; this.lastGauge = 0; this.textures = [];
    this.restUntil = 0; this.curRoom = null; this.oceanHidden = false; this.hidden = []; this.capSwaps = [];
    this.light = new THREE.PointLight(0xfff1dc, 0, 24, 2); this.light.visible = true; app.scene.add(this.light);
    this.prompt = document.createElement('div'); this.prompt.id = 'interiorPrompt';
    this.prompt.style.cssText = 'position:fixed;left:50%;bottom:17%;transform:translateX(-50%);padding:8px 14px;background:rgba(4,12,20,.78);border:1px solid rgba(140,190,230,.35);border-radius:8px;font:14px/1.3 "Segoe UI",system-ui,sans-serif;color:#dbe9f4;pointer-events:none;z-index:15;display:none;white-space:nowrap';
    document.body.appendChild(this.prompt);
    this.isTouch = (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) || navigator.maxTouchPoints > 1;
    // third-person view: a crew member you walk around with (V / C or the button), camera kept out of the walls
    this.view = 'third'; this.camDist = 2.6; this.avatar = null;
    this.viewBtn = document.createElement('button'); this.viewBtn.id = 'interiorView'; this.viewBtn.type = 'button';
    this.viewBtn.style.cssText = 'position:fixed;right:16px;top:calc(64px + env(safe-area-inset-top));z-index:16;min-height:44px;padding:8px 14px;border-radius:10px;border:1px solid rgba(140,190,230,.45);background:rgba(4,12,20,.8);color:#dbe9f4;font:14px "Segoe UI",system-ui,sans-serif;display:none;cursor:pointer';
    this.viewBtn.addEventListener('click', (e) => { e.stopPropagation(); this.toggleView(); this.viewBtn.blur(); });
    document.body.appendChild(this.viewBtn);
    this.gotoBtn = document.createElement('button'); this.gotoBtn.id = 'interiorGotoBtn'; this.gotoBtn.type = 'button'; this.gotoBtn.textContent = 'Go to…';   // SHIPYARD (Lane C): quick travel on GA ships
    this.gotoBtn.style.cssText = this.viewBtn.style.cssText.replace('top:calc(64px', 'top:calc(116px');
    this.gotoBtn.addEventListener('click', (e) => { e.stopPropagation(); this.openGoto(); this.gotoBtn.blur(); });
    document.body.appendChild(this.gotoBtn);
    this.hiddenMat = new THREE.MeshBasicMaterial({ visible: false });
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
  updateViewBtn() { const k = this.isTouch ? '' : ' (V)'; this.viewBtn.textContent = this.view === 'third' ? `👁 First person${k}` : `🧍 Third person${k}`; this.viewBtn.style.display = this._active ? 'block' : 'none'; if (this.gotoBtn && !this._active) this.gotoBtn.style.display = 'none'; }
  /**
   * Phones: the top bar wraps to two or three rows, taller than the --top-h the HUD assumes, so the walking HUD (Stop
   * walking / view buttons, room hint) and the message log under it are kept below the bar's real bottom edge while
   * walking; cleared on exit.
   */
  placeHud(on = this._active) {
    const hud = document.getElementById('interiorHud'), log = document.getElementById('log'), bar = document.getElementById('topbar');
    if (!hud) return;
    if (!on || !this.isTouch || !bar) { hud.style.top = ''; if (log && this.logMoved) { log.style.top = ''; this.logMoved = false; } return; }
    const b = bar.getBoundingClientRect().bottom;
    if (!(b > 0)) return;
    hud.style.top = `${Math.round(b + 6)}px`;
    const hb = hud.getBoundingClientRect().bottom;
    if (log && hb > 0) { log.style.top = `${Math.round(hb + 6)}px`; this.logMoved = true; }
  }
  /** The crew member (avatar.js): faces -z (the bow) at yaw 0. */
  makeAvatar() { return makeAvatar(); }
  /**
   * While walking, the ship's exterior model is hidden and the plan's own decks, deckhouse and gear are drawn instead,
   * so what you see is exactly what you walk on. The hull sides stay (their deck caps are hidden: the plan draws the
   * deck with the stairwell openings cut out), as do sails, nav lights and the bow foam. Restored on exit.
   */
  hideExterior(mesh) {
    this.restoreExterior();
    if (!mesh || !this.group) return;
    const hasSail = (c) => { let s = false; c.traverse((o) => { if (o.isMesh && o.geometry?.type === 'ShapeGeometry') s = true; }); return s; };
    for (const c of mesh.children) {
      if (c === this.group || c === mesh.userData.wake || c === mesh.userData.label || c.isSprite || !c.visible) continue;
      if (c.isMesh && c.geometry && c.geometry.type === 'ExtrudeGeometry') {
        if (Array.isArray(c.material) && c.material.length >= 2) { this.capSwaps.push({ mesh: c, mats: c.material }); c.material = [this.hiddenMat, ...c.material.slice(1)]; }
        continue;
      }
      if (c.userData.keepWhileWalking) continue;
      if (c.userData.shipgen) {   // SHIPYARD: a generated ship (THREE.LOD): only the hull plating stays, every level
        for (const lv of c.children) for (const k of lv.children) if (k.name !== 'hull' && k.visible) { k.visible = false; this.hidden.push(k); }
        continue;
      }
      if (c.userData.yacht || String(c.name || '').startsWith('yacht:')) {   // sailing yachts (rigmesh.js): the plan draws deck + houses; hull and rig stay
        for (const k of c.children) if (k.userData.walkHide && k.visible) { k.visible = false; this.hidden.push(k); }
        continue;
      }
      if (!c.isMesh && hasSail(c)) continue; // sails on their booms
      c.visible = false; this.hidden.push(c);
    }
  }
  restoreExterior() {
    for (const c of this.hidden || []) c.visible = true;
    for (const s of this.capSwaps || []) s.mesh.material = s.mats;
    this.hidden = []; this.capSwaps = [];
  }
  /** The room (plan room) the walker stands in. */
  roomAt(x, z, y) { return this.map ? this.map.roomAt(x, z, y) : null; }
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
    if (app.you.rescue) { app.hud.event?.({ kind: 'warn', text: 'You are in the life raft — there is no ship to walk.' }); return true; } // (true: no second message)
    if (!this.group || this.builtFor !== app.myMesh || this.builtCls !== app.you.ship.cls) this.build();
    if (!this.group) return false;
    this._active = true; this.atHelm = false; this.keys.clear();
    this.group.visible = true;
    this.hideExterior(app.myMesh);
    this.placeAt(this.plan.spawn);
    this.camState = { near: app.camera.near, fov: app.camera.fov };
    app.camera.near = 0.12; app.camera.fov = 70; app.camera.updateProjectionMatrix();
    if (app.myMesh.userData.label) app.myMesh.userData.label.visible = false;
    if (!this.isTouch) this.lock();
    app.hud.showInterior?.(true);
    this.placeHud(true); this.lastHudT = performance.now();
    this.updateViewBtn();
    this.curRoom = null;
    app.hud.event?.({ kind: 'info', text: this.isTouch ? 'Walking your ship. Stick to walk (push it all the way to hurry), drag the right half to look, tap to use things. The signs by the stairs show the way to the bridge and the engine room.' : 'Walking your ship. WASD walk (Shift runs), mouse look, E to use things, V first / third person. The signs by the stairs show the way to the bridge and the engine room; doors lead out on deck. I to stop walking.' });
    if (this.plan?.goto?.some((g) => /^v:/.test(g.id))) app.hud.event?.({ kind: 'info', text: 'This ship is huge: tap the "Go to…" button (top left) to jump straight to the casino, theatre, restaurants, pools, spa and more.' });
    this.light.intensity = 7;
    return true;
  }
  placeAt(p) { this.st = { x: p.x, z: p.z, y: p.y }; this.pos.set(p.x, p.y, p.z); this.y = p.y; this.yaw = p.yaw || 0; this.pitch = 0; }
  exit() {
    if (!this._active) return;
    this._active = false; this.atHelm = false; this.keys.clear(); this.touchLook = null;
    if (this.group) this.group.visible = false;
    const app = this.app;
    if (this.camState) { app.camera.near = this.camState.near; app.camera.fov = this.camState.fov; app.camera.updateProjectionMatrix(); }
    app.camera.up.set(0, 1, 0);
    if (app.myMesh?.userData.label && app.cam?.mode !== 2) app.myMesh.userData.label.visible = true;
    this.unlock();
    this.prompt.style.display = 'none'; this.prevLabel = '';
    this.light.intensity = 0;
    if (this.avatar) this.avatar.visible = false;
    this.restoreExterior();
    this.setOcean(true);
    this.setWorldLabels(true);
    this.viewBtn.style.display = 'none';
    app.hud.showInterior?.(false);
    this.placeHud(false);
  }
  toggle() { if (this._active) this.exit(); else this.enter(); }
  leaveHelm() { this.atHelm = false; this.app.hud.event?.({ kind: 'info', text: 'You step back from the helm.' }); }
  setOcean(on) {
    const m = this.app.ocean?.mesh; if (!m) return;
    if (!on && !this.oceanHidden) { this.oceanWas = m.visible; m.visible = false; this.oceanHidden = true; }
    else if (on && this.oceanHidden) { m.visible = this.oceanWas !== false; this.oceanHidden = false; }
  }
  /**
   * World name boards (harbours, ships, AIS) are sprites drawn without a depth test, so inside the ship they would float
   * through the walls. In enclosed rooms they are moved to a layer the camera does not render (their `visible` flag is
   * left alone — other code drives it), rescanning now and then for boards that appear meanwhile; restored on deck.
   */
  setWorldLabels(show) {
    if (show) {
      if (this.labelsOff) { for (const [s, mask] of this.labelsOff) s.layers.mask = mask; this.labelsOff = null; }
      return;
    }
    const now = performance.now();
    if (this.labelsOff && now - (this.labelScanT || 0) < 700) return;
    this.labelScanT = now;
    const off = this.labelsOff || new Map();
    const walk = (o) => {
      if (o === this.group) return;
      if (o.isSprite && o.material && o.material.depthTest === false && !off.has(o)) { off.set(o, o.layers.mask); o.layers.set(LABEL_LAYER); }
      for (const c of o.children) walk(c);
    };
    walk(this.app.scene);
    this.labelsOff = off;
  }

  // ------------------------------------------------------------------ interaction
  engineText() {
    const app = this.app, you = app.you, C = SHIP_CLASSES[you?.ship.cls] || SHIP_CLASSES.coaster;
    const s = app.ship || you.ship, thr = s.throttle || 0;
    const rpm = Math.round(rpmFraction(thr) * (RPM[you.ship.cls] || RPM[baseOf(you.ship.cls)] || 900) * (you.fuelEmpty ? 0 : 1));
    return `Engine: ${rpm} rpm${thr < -0.005 ? ' astern' : ''} · ${orderLabel(thr)} (${Math.round(thr * 100)} %) · fuel ${(you.fuel || 0).toFixed(1)} / ${C.fuelCap} t · hull ${Math.round(you.cond)} % · ${you.flooding > 0.01 ? `flooding ${Math.round(you.flooding * 100)} % — pumps running` : 'bilges dry'}${you.fuelEmpty ? ' · NO FUEL' : ''}`;
  }
  /** G / Go-to button: the quick-travel list of this ship (L > 60 m). False when the ship has none. */
  openGoto() { if (!this._active || this.atHelm || !this.plan?.goto?.length) return false; return openGotoMenu(this); }
  interact() {
    if (this.atHelm) { this.leaveHelm(); return; }
    const h = this.nearHotspot; if (!h) return;
    if (this.plan?.v === 2 && iv2Interact(this, h)) return;   // IV2 HV4: stations, VHF / GMDSS panel, engine panel, animated ladders
    if (gaInteract(this, h)) return;   // ladder climb, Go-to / lift, telegraph, thrusters, whistle, GMDSS, ECR, info points
    const app = this.app, you = app.you;
    switch (h.kind) {
      case 'helm': {
        const p = this.plan.helm || h;
        this.atHelm = true; this.keys.clear(); this.st = { x: p.x, z: p.z, y: p.y }; this.pos.set(p.x, p.y, p.z); this.y = p.y; this.yaw = 0; this.pitch = -0.05;
        app.hud.event?.({ kind: 'info', text: you?.docked ? 'At the helm — cast off (T) before you can get under way.' : 'You take the helm. W/S engine telegraph (one order at a time, down past STOP is astern), A/D rudder, space STOP; E or Esc to step away.' });
        break;
      }
      case 'engine': app.hud.event?.({ kind: you.fuelEmpty || you.cond < 30 ? 'warn' : 'info', text: this.engineText() }); break;
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
    if (!app.myMesh || !app.you || app.you.rescue) { this.exit(); return; } // sank / abandoned while below: to the raft view
    if (this.builtFor !== app.myMesh || this.builtCls !== app.you.ship.cls) { this.build(); if (!this.group) { this.exit(); return; } this.group.visible = true; this.hideExterior(app.myMesh); this.placeAt(this.plan.spawn); }
    dt = Math.min(0.1, dt);
    // ---- movement (walk map: sliding along walls, funnelled into doorways and onto stairs)
    let moving = false;
    if (!this.atHelm && !this.modal) {   // modal: a casino table or venue panel is open (iv2games.js)
      let mx = 0, mz = 0; // local: +mz forward
      if (this.keys.has('w') || this.keys.has('arrowup')) mz += 1;
      if (this.keys.has('s') || this.keys.has('arrowdown')) mz -= 1;
      if (this.keys.has('a') || this.keys.has('arrowleft')) mx -= 1;
      if (this.keys.has('d') || this.keys.has('arrowright')) mx += 1;
      const stk = app.touchHelm?.stick;
      let hurry = this.run;
      if (stk && stk.active) { mx += clamp(stk.x, -1, 1); mz += clamp(stk.y, -1, 1); if (Math.hypot(stk.x, stk.y) > 0.94) hurry = true; }
      const l = Math.hypot(mx, mz);
      if (l > 0.05) {
        if (l > 1) { mx /= l; mz /= l; }
        const st = this.st, spd = (hurry ? RUN : WALK) * this.map.speedFactor(st.x, st.z, st.y);
        const fx = Math.sin(this.yaw), fz = -Math.cos(this.yaw), rx = Math.cos(this.yaw), rz = Math.sin(this.yaw);
        const r = this.map.move(st, (fx * mz + rx * mx) * spd * dt, (fz * mz + rz * mx) * spd * dt);
        moving = r.moved > 1e-4;
        this.bob += dt * spd * 1.8;
        this.runVis = hurry;
      }
    }
    this.pos.set(this.st.x, this.st.y, this.st.z); this.y = this.st.y;
    // ---- where am I (HUD hint, sea hidden in windowless spaces below the deck)
    const room = this.map.roomAt(this.pos.x, this.pos.z, this.y);
    if (room && room !== this.curRoom) {
      this.curRoom = room;
      const gs = this.app.you?.guest;   // cruise ships: the guest rating on the bridge and in the guest areas (docs/CRUISE-CONTRACT.md §7)
      this.app.hud.setInteriorHint?.(`${room.name}${gs && (room.space === 'bridge' || room.space === 'guest_services') ? ` · guests rate the ship ${gs.stars.toFixed(1)} / 5` : ''} — ${this.isTouch ? 'stick to walk · tap to use' : 'WASD walk · Shift runs · E use · V view · I stop walking'}`);
    }
    // ---- zone streaming (GA plans): the zone you stand in and its neighbours; a tower landing of a neighbour deck
    // reloads that deck's plan (cruise ships, big ro-pax)
    if (this.zoneGroups) gaZoneUpdate(this, this.isTouch || window.innerWidth < 900);
    this.v2?.frame(this, dt);   // IV2 HV3a: detail chunks, window views, light mode, wipers
    if (this.crowd) { try { this.crowd.frame(this, dt); } catch (e) { console.warn('[interior] crowd', e); this.crowd.dispose(); this.crowd = null; } }
    // ---- hotspots
    let best = null, bd = 1e9;
    for (const h of this.hotspots) {
      const d = Math.hypot(h.x - this.pos.x, h.z - this.pos.z, (h.y - this.y) * 2);
      if (d < h.r && d < bd) { bd = d; best = h; }
    }
    this.nearHotspot = this.atHelm ? null : best;
    const label = this.atHelm ? (this.isTouch ? 'Tap to step away from the helm' : 'E / Esc — step away from the helm') : best ? `${this.isTouch ? 'Tap' : 'E'} — ${best.label}` : '';
    if (label !== this.prevLabel) { this.prevLabel = label; this.prompt.textContent = label; this.prompt.style.display = label ? 'block' : 'none'; }
    // ---- avatar + camera (ship frame → world through the ship's matrix so heave/pitch/roll carry over)
    const mesh = app.myMesh; mesh.updateMatrixWorld(true);
    const third = this.view === 'third' && !this.atHelm;
    if (!this.avatar || this.avatar.parent !== this.group) { this.avatar = this.makeAvatar(); this.group.add(this.avatar); }
    const bob = this.avatar.userData.animate(dt, moving, this.runVis && moving);
    this.avatar.position.set(this.pos.x, this.y + bob, this.pos.z);
    this.avatar.rotation.y = -this.yaw;
    iv2Frame(this, dt);   // IV2 HV3b: ladder climb, door leaves, sill foot-lift
    const bobY = third ? 0 : (moving ? Math.sin(this.bob) * 0.03 : 0);
    const V = this.v, dirL = V.dir.set(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    const eyeL = V.eye.set(this.pos.x, this.y + EYE + bobY, this.pos.z), lookL = V.look;
    if (third) {
      const head = V.head.set(this.pos.x, this.y + 1.55, this.pos.z);
      const small = room && !room.open && Math.min(room.x1 - room.x0, room.z1 - room.z0) < 3.2; // cabins, yacht interiors
      const want = V.want.copy(head).addScaledVector(dirL, -(small ? Math.min(this.camDist, 1.7) : this.camDist)); want.y += small ? 0.2 : 0.35;
      const c = this.map.cameraClamp(head, want, this.y);
      // squeezed against a wall or machinery (the camera would sit inside the crew member's head or a panel): look
      // through their eyes instead until there is room again (hysteresis, so it does not flicker)
      const room3 = Math.hypot(c.x - head.x, c.y - head.y, c.z - head.z);
      this.squeezed = this.squeezed ? room3 < 1.25 : room3 < 0.95; // (closer than ~1 m the body fills half the screen)
      if (this.squeezed) lookL.copy(eyeL).add(dirL);
      // aim past the crew member's head at where they are going: the body sits low in the frame, the way ahead stays in view
      else { eyeL.set(c.x, c.y, c.z); lookL.copy(head).addScaledVector(dirL, 2); lookL.y += 0.35; }
    } else lookL.copy(eyeL).add(dirL);
    this.avatar.visible = third && !this.squeezed;
    const camRoom = this.map.roomAt(eyeL.x, eyeL.z, eyeL.y - 1.5) || room;
    this.setOcean(!(camRoom && (camRoom.dark || (!camRoom.open && camRoom.y < 0.1))));   // §4.5: cabin soles below the waterline — the sea would show through the floor
    this.setWorldLabels(!camRoom || camRoom.open || camRoom.kind === 'bridge'); // through the bridge windows they are fine
    const eye = eyeL.applyMatrix4(mesh.matrixWorld), look = lookL.applyMatrix4(mesh.matrixWorld);
    const fov = app.camera.aspect < 0.75 ? 80 : 70; // portrait phones: a wider view, so the crew member does not fill the screen
    if (app.camera.fov !== fov) { app.camera.fov = fov; app.camera.updateProjectionMatrix(); }
    app.camera.up.set(0, 1, 0).applyQuaternion(mesh.quaternion);
    app.camera.position.copy(eye);
    app.camera.lookAt(look);
    { // the lamp hangs under the ceiling of the room the crew member is in (deck lights outside)
      const r = room;
      const lampL = V.lamp.set(this.pos.x, r && !r.open ? r.y + r.h - 0.25 : this.y + 3.0, this.pos.z);
      this.light.position.copy(lampL.applyMatrix4(mesh.matrixWorld));
      this.light.intensity = (r && r.dark ? 6 : r && r.open ? 4 : 6) * (this.plan?.v === 2 ? 0.35 : 1);   // IV2 HV5
    }
    // ---- screens and controls
    const now = performance.now();
    if (this.radarTex && app.lastRadar !== this.lastRadarT) { this.lastRadarT = app.lastRadar; this.radarTex.needsUpdate = true; }
    if (this.gauge && now - this.lastGauge > 250) { this.lastGauge = now; this.drawGauges(); }
    if (this.isTouch && now - (this.lastHudT || 0) > 1000) { this.lastHudT = now; this.placeHud(); } // the bar re-wraps as its values change
    if (this.wheel) { const r = (app.ship?.rudder || 0) * 2.2; this.wheel.rotation.z += (r - this.wheel.rotation.z) * Math.min(1, dt * 6); }
    if (this.lever) { const t = app.ship?.throttle || 0; this.lever.rotation.x += (-t * 0.9 - this.lever.rotation.x) * Math.min(1, dt * 6); }
  }

  // ------------------------------------------------------------------ construction
  dispose() {
    if (this.crowd) { this.crowd.dispose(); this.crowd = null; }
    if (this.group) { this.group.parent?.remove(this.group); (ShipMod.disposeGroup || disposeFallback)(this.group); this.group = null; }
    for (const t of this.textures) t.dispose?.();
    this.textures = [];
    if (this.mats) for (const m of Object.values(this.mats)) m.dispose?.();
    this.mats = null;
    this.avatar = null; this.plan = null; this.map = null;
    this.rooms = []; this.hotspots = []; this.gauge = null; this.radarTex = null; this.wheel = null; this.lever = null;
    this.builtFor = null; this.builtCls = null; this.zoneGroups = null;
  }
  build() {
    const app = this.app; const mesh = app.myMesh; if (!mesh) return;
    this.restoreExterior();
    this.dispose();
    const cls = app.you?.ship.cls || mesh.userData.cls || 'coaster';
    const C = SHIP_CLASSES[cls] || SHIP_CLASSES.coaster;
    let plan;
    if (this.deckCls !== cls) { this.deck = null; this.deckCls = cls; }   // a new ship starts on its bridge deck
    try { plan = buildPlan(cls, C, mesh.userData, { deck: this.deck }); } catch (e) { console.warn('[interior] plan failed, using the coaster plan', e); plan = buildPlan('coaster', SHIP_CLASSES.coaster, {}); }
    this.plan = plan; this.map = new WalkMap(plan);
    this.rooms = plan.rooms; this.hotspots = plan.hotspots.map((h) => ({ ...h }));
    const g = new THREE.Group(); g.name = 'interior'; g.visible = false;
    this.mats = this.makeMaterials(plan.style);
    this.zoneGroups = null;
    this.v2 = null;
    if (plan.zones?.length) this.zoneGroups = plan.v === 2 ? buildInteriorV2(this, plan, g, { phone: this.isTouch || window.innerWidth < 900 }) : buildZoned(this, plan, g);   // GA plans: one group per zone (§6.6 streaming); IV2 HV2
    else {
      this.pb = new PartBuilder();
      const ctx = { g, M: this.mats, pb: this.pb, plan };
      this.drawDeck(ctx);
      this.drawRooms(ctx);
      this.drawStairs(ctx);
      for (const p of plan.props) { try { this.drawProp(ctx, p); } catch (e) { console.warn('[interior] prop', p.t, e); } }
      for (const r of plan.rails) this.drawRail(ctx, r.pts, r.y);
      this.pb.build(g);
      this.pb = null;
    }
    if (wantsCrowd(plan) && !/[?&]crowd=0\b/.test(location.search)) { try { this.crowd = new CruiseCrowd(this, plan, g, { phone: this.isTouch || window.innerWidth < 900 }); } catch (e) { console.warn('[interior] crowd failed', e); this.crowd = null; } }
    mesh.add(g);
    this.group = g; this.builtFor = mesh; this.builtCls = cls;
  }
  makeMaterials(style) {
    const yacht = style === 'yacht';
    // a faint emissive term stands in for the room lights, so cabins and passages never go pitch dark (or night-blue)
    const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.05, side: THREE.DoubleSide, emissive: color, emissiveIntensity: 0.12, ...extra });
    return {
      wall: std(yacht ? 0xeae0cf : 0xdfe3e0), wallDark: std(0x8f969b, { roughness: 0.7, metalness: 0.2 }), wallWood: std(0x9b7650, { roughness: 0.6 }), wallSteel: std(0xb9bec2, { roughness: 0.6, metalness: 0.3 }),
      ceil: std(0xf1f1ec), lino: std(0x5a6772, { roughness: 0.55 }), carpet: std(0x3f4f63, { roughness: 0.95 }), woodFloor: std(0x8a6a44, { roughness: 0.5 }),
      grating: std(0x4b5154, { metalness: 0.45, roughness: 0.45 }), steelFloor: std(0x6d7377, { metalness: 0.3, roughness: 0.6 }),
      deck: std(yacht ? 0xb48a5a : 0x5f6d63, { roughness: 0.8 }), teak: std(0xb48a5a, { roughness: 0.7 }),
      steel: std(0x6b7378, { metalness: 0.6, roughness: 0.4 }), dark: std(0x23272b, { metalness: 0.3, roughness: 0.5 }), console: std(0x2c3238, { metalness: 0.2, roughness: 0.5 }),
      wood: std(0x7d5a36, { roughness: 0.5 }), fabric: std(0x2f4a7a), fabric2: std(0x7a3a3a), blanket: std(0x3a5a8a), pillow: std(0xf0f0ea), engine: std(0x2e7d4f, { metalness: 0.5, roughness: 0.45 }),
      yellow: std(0xe3b018), red: std(0xc0392b), white: std(0xf4f4f0), rail: std(0xbfc4c8, { metalness: 0.7, roughness: 0.3 }), hatch: std(0x3c5a3c, { metalness: 0.3 }),
      orange: std(0xd9641e), green: std(0x58d68d, { emissive: 0x58d68d, emissiveIntensity: 1.2 }),
      glass: new THREE.MeshStandardMaterial({ color: 0x9fc8e8, transparent: true, opacity: 0.16, roughness: 0.05, metalness: 0.3, side: THREE.DoubleSide, depthWrite: false }),
      light: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2d8, emissiveIntensity: 1.6 }),
      net: new THREE.MeshStandardMaterial({ color: 0x222222, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }),
      boxes: BOX_COLORS.map((c) => std(c, { roughness: 0.7, metalness: 0.2 })),
    };
  }
  floorMat(k) { const M = this.mats; return { lino: M.lino, carpet: M.carpet, wood: M.woodFloor, grating: M.grating, steel: M.steelFloor, deck: M.deck, teak: M.teak }[k] || M.lino; }
  wallMat(k) { const M = this.mats; return { white: M.wall, dark: M.wallDark, wood: M.wallWood, steel: M.wallSteel }[k] || M.wall; }

  /** The main deck (replaces the hull's own deck cap while walking) with the stairwells cut out. */
  drawDeck({ g, M, plan }) {
    const d = plan.deck;
    d.polys.forEach((poly, i) => {
      const shape = new THREE.Shape(poly.map(([x, z]) => new THREE.Vector2(x, -z)));
      const bx0 = Math.min(...poly.map((q) => q[0])) + 0.02, bx1 = Math.max(...poly.map((q) => q[0])) - 0.02;
      const bz0 = Math.min(...poly.map((q) => q[1])) + 0.02, bz1 = Math.max(...poly.map((q) => q[1])) - 0.02;
      for (const h0 of d.holes) { // stairwell openings, clipped to this deck piece
        const h = { x0: Math.max(h0.x0, bx0), x1: Math.min(h0.x1, bx1), z0: Math.max(h0.z0, bz0), z1: Math.min(h0.z1, bz1) };
        if (h.x1 - h.x0 < 0.05 || h.z1 - h.z0 < 0.05) continue;
        const p = new THREE.Path(); p.moveTo(h.x0, -h.z0); p.lineTo(h.x0, -h.z1); p.lineTo(h.x1, -h.z1); p.lineTo(h.x1, -h.z0); p.lineTo(h.x0, -h.z0); shape.holes.push(p);
      }
      const geo = new THREE.ShapeGeometry(shape, 8); geo.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(geo, M.deck); m.position.y = d.y - 0.06 - i * 0.004; g.add(m);
    });
  }

  drawRooms({ pb, M, plan }) {
    const byId = new Map(plan.rooms.map((r) => [r.id, r]));
    const ops = new Map(); // roomId:side → [{from,to,bottom,top,glass}]
    const push = (id, side, o) => { const k = id + ':' + side; let l = ops.get(k); if (!l) { l = []; ops.set(k, l); } l.push(o); };
    const edge = (r, side) => ({ n: r.z0, s: r.z1, w: r.x0, e: r.x1 })[side];
    for (const d of plan.doors) {
      const a = byId.get(d.a), b = d.b ? byId.get(d.b) : null;
      push(a.id, d.side, { from: d.at - d.w / 2, to: d.at + d.w / 2, bottom: 0, top: d.h });
      const opp = { n: 's', s: 'n', e: 'w', w: 'e' }[d.side];
      if (b && !b.open && Math.abs(edge(a, d.side) - edge(b, opp)) < 0.06) push(b.id, opp, { from: d.at - d.w / 2, to: d.at + d.w / 2, bottom: 0, top: d.h });
      this.drawDoor(pb, M, a, d);
    }
    for (const r of plan.rooms) {
      for (const w of r.windows) push(r.id, w.side, { from: w.from, to: w.to, bottom: w.bottom, top: w.top, glass: true });
      const fm = this.floorMat(r.floor);
      if (r.drawFloor !== false && !(r.open && !r.drawFloor)) {
        for (const q of rectMinusHoles({ x0: r.x0, x1: r.x1, z0: r.z0, z1: r.z1 }, r.floorHoles)) pb.box(q.x1 - q.x0, 0.06, q.z1 - q.z0, fm, (q.x0 + q.x1) / 2, r.y - 0.03, (q.z0 + q.z1) / 2);
      }
      if (r.open) continue;
      if (r.ceiling !== false) {
        for (const q of rectMinusHoles({ x0: r.x0, x1: r.x1, z0: r.z0, z1: r.z1 }, r.ceilHoles)) pb.box(q.x1 - q.x0, 0.06, q.z1 - q.z0, M.ceil, (q.x0 + q.x1) / 2, r.y + r.h + 0.03, (q.z0 + q.z1) / 2);
        const lw = Math.min(1.2, (r.x1 - r.x0) * 0.4), lz = Math.min(0.3, (r.z1 - r.z0) * 0.2);
        const holes = r.ceilHoles;
        const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
        if (!holes.some((h) => cx > h.x0 - lw && cx < h.x1 + lw && cz > h.z0 - lz && cz < h.z1 + lz)) pb.box(lw, 0.04, lz, M.light, cx, r.y + r.h - 0.02, cz);
      }
      const wallH = r.h + 0.1, wm = this.wallMat(r.wall);
      const sides = { n: ['x', r.z0 + 0.05, r.x0, r.x1], s: ['x', r.z1 - 0.05, r.x0, r.x1], w: ['z', r.x0 + 0.05, r.z0, r.z1], e: ['z', r.x1 - 0.05, r.z0, r.z1] };
      for (const [side, [axis, c, from, to]] of Object.entries(sides)) {
        if (!r.walls[side]) continue;
        this.wall(pb, M, axis, c, from, to, r.y, wallH, ops.get(r.id + ':' + side), wm);
      }
    }
  }
  wall(pb, M, axis, c, from, to, yBase, h, openings, mat) {
    const ops = [...(openings || [])].filter((o) => o.to > o.from).sort((a, b) => a.from - b.from);
    let cur = from;
    const place = (a, b, bot, top, m) => {
      if (b - a < 0.01 || top - bot < 0.01) return;
      const len = b - a, mid = (a + b) / 2, yy = yBase + (bot + top) / 2, hh = top - bot;
      if (axis === 'x') pb.box(len, hh, 0.1, m, mid, yy, c); else pb.box(0.1, hh, len, m, c, yy, mid);
    };
    for (const o of ops) {
      const a = Math.max(from, o.from), b = Math.min(to, o.to);
      if (b <= cur) { if (o.glass) { /* overlapped by a door: skip */ } continue; }
      const a2 = Math.max(a, cur);
      if (a2 > cur) place(cur, a2, 0, h, mat);
      const bot = Math.max(0, o.bottom ?? 0), top = Math.min(h, o.top ?? h);
      if (bot > 0) place(a2, b, 0, bot, mat);
      if (top < h) place(a2, b, top, h, mat);
      if (o.glass) place(a2, b, bot, top, M.glass);
      cur = Math.max(cur, b);
    }
    if (cur < to) place(cur, to, 0, h, mat);
  }
  /** Door frame and an open leaf folded back against the wall (none for open archways). */
  drawDoor(pb, M, a, d) {
    if (d.kind === 'open') return;
    const ns = d.side === 'n' || d.side === 's';
    const c = { n: a.z0, s: a.z1, w: a.x0, e: a.x1 }[d.side];
    const inward = { n: 1, s: -1, w: 1, e: -1 }[d.side];
    const fm = d.kind === 'watertight' ? M.steel : d.kind === 'ext' ? M.white : M.wood, lm = d.kind === 'watertight' ? M.wallDark : d.kind === 'ext' ? M.white : M.wood;
    const y = a.y, h = d.h;
    const jamb = (along) => { if (ns) pb.box(0.07, h, 0.16, fm, along, y + h / 2, c); else pb.box(0.16, h, 0.07, fm, c, y + h / 2, along); };
    jamb(d.at - d.w / 2 - 0.035); jamb(d.at + d.w / 2 + 0.035);
    if (ns) pb.box(d.w + 0.14, 0.07, 0.16, fm, d.at, y + h + 0.035, c); else pb.box(0.16, 0.07, d.w + 0.14, fm, c, y + h + 0.035, d.at);
    if (d.kind === 'watertight') { if (ns) pb.box(d.w + 0.1, 0.12, 0.16, fm, d.at, y + 0.06, c); else pb.box(0.16, 0.12, d.w + 0.1, fm, c, y + 0.06, d.at); }
    // leaf: hinged at the "from" jamb, opened 90° into room a, lying along the wall
    const lw = d.w - 0.06, off = c + inward * (0.08 + lw / 2), hinge = d.at - d.w / 2;
    if (ns) pb.box(0.05, h - 0.05, lw, lm, hinge - 0.05, y + (h - 0.05) / 2, off); else pb.box(lw, h - 0.05, 0.05, lm, off, y + (h - 0.05) / 2, hinge - 0.05);
  }

  drawStairs({ pb, M, plan }) {
    const byId = new Map(plan.rooms.map((r) => [r.id, r]));
    for (const s of plan.stairs) {
      const { footZ, headZ, upDir, cx } = stairEnds(s);
      const rise = s.yHigh - s.yLow, run = s.z1 - s.z0, len = Math.hypot(rise, run), w = s.x1 - s.x0;
      const ang = s.up === 'n' ? Math.atan2(rise, run) : -Math.atan2(rise, run);
      const cz = (s.z0 + s.z1) / 2, cy = (s.yLow + s.yHigh) / 2;
      const steel = s.kind === 'steep' || s.kind === 'outdoor' || plan.style !== 'yacht';
      const tread = steel ? M.grating : M.wood;
      // stringers (side plates) and the underside
      for (const x of [s.x0 + 0.025, s.x1 - 0.025]) pb.box(0.05, 0.28, len, M.steel, x, cy - 0.06, cz, ang);
      pb.box(w - 0.06, 0.03, len, M.dark, cx, cy - 0.17, cz, ang);
      // treads at ~0.2 m rise (the walk ramp runs along their nosings)
      const n = Math.max(3, Math.round(rise / 0.2)), dz = (headZ - footZ) / n;
      for (let i = 0; i < n; i++) {
        const z = footZ + dz * (i + 0.5), y = s.yLow + (rise * (i + 0.5)) / n;
        pb.box(w - 0.08, 0.05, Math.abs(dz) + 0.04, tread, cx, y - 0.02, z);
        if (!steel) pb.box(w - 0.08, rise / n, 0.03, M.wood, cx, y - rise / n / 2, z - (dz / 2) * Math.sign(dz));
      }
      // handrails both sides, posts at the ends
      for (const x of [s.x0 + 0.04, s.x1 - 0.04]) {
        pb.rod(x, s.yLow + 0.95, footZ - upDir * 0.05, x, s.yHigh + 0.95, headZ + upDir * 0.05, 0.022, M.rail, 6);
        pb.rod(x, s.yLow, footZ, x, s.yLow + 0.95, footZ, 0.025, M.rail, 6);
        pb.rod(x, s.yHigh, headZ, x, s.yHigh + 0.95, headZ, 0.025, M.rail, 6);
      }
      // guard rail round the stairwell opening on the upper deck (the head end stays open)
      const head = byId.get(s.head);
      if (head) {
        const y = s.yHigh;
        const far = footZ;
        pb.rod(s.x0 - 0.02, y + 1.0, headZ, s.x0 - 0.02, y + 1.0, far, 0.022, M.rail, 6);
        pb.rod(s.x1 + 0.02, y + 1.0, headZ, s.x1 + 0.02, y + 1.0, far, 0.022, M.rail, 6);
        pb.rod(s.x0 - 0.02, y + 1.0, far, s.x1 + 0.02, y + 1.0, far, 0.022, M.rail, 6);
        for (const [x, z] of [[s.x0 - 0.02, far], [s.x1 + 0.02, far], [s.x0 - 0.02, (headZ + far) / 2], [s.x1 + 0.02, (headZ + far) / 2]]) pb.rod(x, y, z, x, y + 1.0, z, 0.02, M.rail, 6);
        pb.rod(s.x0 - 0.02, y + 0.5, headZ, s.x0 - 0.02, y + 0.5, far, 0.016, M.rail, 5);
        pb.rod(s.x1 + 0.02, y + 0.5, headZ, s.x1 + 0.02, y + 0.5, far, 0.016, M.rail, 5);
      }
    }
  }
  drawRail(ctx, pts, y) {
    const { pb, M } = ctx;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, z0] = pts[i], [x1, z1] = pts[i + 1], len = Math.hypot(x1 - x0, z1 - z0);
      if (len < 0.05) continue;
      pb.rod(x0, y + 1.0, z0, x1, y + 1.0, z1, 0.025, M.rail, 5);
      pb.rod(x0, y + 0.5, z0, x1, y + 0.5, z1, 0.018, M.rail, 4);
      const n = Math.max(1, Math.ceil(len / 1.5));
      for (let k = i === 0 ? 0 : 1; k <= n; k++) { const t = k / n; pb.rod(x0 + (x1 - x0) * t, y, z0 + (z1 - z0) * t, x0 + (x1 - x0) * t, y + 1.0, z0 + (z1 - z0) * t, 0.022, M.rail, 4); }
    }
  }

  // ------------------------------------------------------------------ props
  drawProp(ctx, p) {
    if (GA_PROP_KINDS.has(p.t) && drawGAProp(ctx, p)) return;   // Lane C prop kinds (consoles, ME, winches, cranes …)
    const { g, pb, M, plan } = ctx;
    const lbox = (w, h, d, mat, lx, ly, lz, rotY, ox, oy, oz) => { const c = Math.cos(rotY), s = Math.sin(rotY); pb.box(w, h, d, mat, ox + lx * c + lz * s, oy + ly, oz - lx * s + lz * c, 0, rotY, 0); };
    switch (p.t) {
      case 'helm': return p.upper ? this.upperHelm(ctx, p) : this.helmConsole(ctx, p.x, p.y, p.z, p.w, p.facing ?? -1, p.windscreen);
      case 'chart': return this.chartTable(ctx, p.x, p.y, p.z, p.w, p.d);
      case 'radio': return this.radio(ctx, p.x, p.y, p.z, p.rotY || 0);
      case 'bunk': return this.bunk(ctx, p);
      case 'desk': {
        lbox(1.0, 0.05, 0.6, M.wood, 0, 0.75, 0, p.rotY, p.x, p.y, p.z); lbox(0.06, 0.72, 0.55, M.wood, -0.45, 0.36, 0, p.rotY, p.x, p.y, p.z); lbox(0.06, 0.72, 0.55, M.wood, 0.45, 0.36, 0, p.rotY, p.x, p.y, p.z);
        lbox(0.32, 0.22, 0.03, M.dark, 0, 0.92, -0.2, p.rotY, p.x, p.y, p.z);
        return;
      }
      case 'table': {
        pb.box(p.w, 0.05, p.d, M.wood, p.x, p.y + (p.fold ? 0.7 : 0.75), p.z); pb.box(0.1, 0.72, 0.1, M.rail, p.x, p.y + 0.36, p.z);
        if (p.benches) for (const s of [-1, 1]) { pb.box(p.w, 0.45, 0.4, M.fabric2, p.x, p.y + 0.23, p.z + s * (p.d / 2 + 0.3)); }
        return;
      }
      case 'counter': {
        const w = p.x1 - p.x0, d = p.z1 - p.z0;
        pb.box(w, 0.88, d, p.kind === 'shop' ? M.wood : M.white, (p.x0 + p.x1) / 2, p.y + 0.44, (p.z0 + p.z1) / 2); pb.box(w + 0.02, 0.05, d + 0.02, M.dark, (p.x0 + p.x1) / 2, p.y + 0.91, (p.z0 + p.z1) / 2);
        if (p.kind === 'galley') {
          const along = w < d ? 'z' : 'x', cx = (p.x0 + p.x1) / 2, czz = (p.z0 + p.z1) / 2;
          for (let i = 0; i < 4; i++) { const o = (i % 2 ? 0.14 : -0.14) + (along === 'z' ? 0 : -w * 0.2), q = (i < 2 ? -0.1 : 0.1) + (along === 'z' ? -d * 0.2 : 0); pb.cyl(0.07, 0.02, M.dark, along === 'z' ? cx + q : cx + o, p.y + 0.95, along === 'z' ? czz + o : czz + q, 0.07, 10); }
          if (along === 'z') pb.box(0.4, 0.03, 0.45, M.rail, cx, p.y + 0.94, czz + d * 0.25); else pb.box(0.45, 0.03, 0.4, M.rail, cx + w * 0.25, p.y + 0.94, czz);
        }
        return;
      }
      case 'lockers': { const w = p.x1 - p.x0, d = p.z1 - p.z0; pb.box(w, 1.95, d, M.steel, (p.x0 + p.x1) / 2, p.y + 0.975, (p.z0 + p.z1) / 2); return; }
      case 'sofa': { const w = p.x1 - p.x0, d = p.z1 - p.z0; pb.box(w, 0.42, d, M.fabric, (p.x0 + p.x1) / 2, p.y + 0.21, (p.z0 + p.z1) / 2); return; }
      case 'sunpad': { pb.box(p.x1 - p.x0, p.flat ? 0.08 : 0.3, p.z1 - p.z0, M.fabric, (p.x0 + p.x1) / 2, p.y + (p.flat ? 0.04 : 0.15), (p.z0 + p.z1) / 2); return; }
      case 'engine': return this.engineBlock(ctx, p);
      case 'generator': {
        pb.box(p.w, p.h * 0.75, p.len * 0.6, M.yellow, p.x, p.y + 0.2 + p.h * 0.375, p.z - p.len * 0.18); pb.cyl(p.w * 0.42, p.len * 0.35, M.steel, p.x, p.y + 0.2 + p.h * 0.4, p.z + p.len * 0.3, p.w * 0.42, 12, Math.PI / 2, 0, 0);
        pb.box(p.w + 0.2, 0.2, p.len + 0.2, M.dark, p.x, p.y + 0.1, p.z);
        return;
      }
      case 'pipes': {
        const y = p.y + p.h - 0.35;
        pb.rod(p.x1 - 0.25, y, p.z0 + 0.2, p.x1 - 0.25, y, p.z1 - 0.2, 0.09, M.red, 8);
        pb.rod(p.x1 - 0.45, y + 0.05, p.z0 + 0.2, p.x1 - 0.45, y + 0.05, p.z1 - 0.2, 0.06, M.yellow, 8);
        pb.rod(p.x0 + 0.25, y, p.z0 + 0.2, p.x0 + 0.25, y, p.z1 - 0.2, 0.08, M.steel, 8);
        pb.rod(p.x0 + 0.25, y, p.z1 - 0.3, p.x1 - 0.25, y, p.z1 - 0.3, 0.07, M.steel, 8);
        return;
      }
      case 'console': return this.engineConsole(ctx, p);
      case 'hatch': {
        const w = p.x1 - p.x0, d = p.z1 - p.z0;
        pb.box(w, p.h * 0.75, d, M.steel, (p.x0 + p.x1) / 2, p.y + p.h * 0.375, (p.z0 + p.z1) / 2);
        pb.box(w - 0.1, p.h * 0.25, d - 0.1, M.hatch, (p.x0 + p.x1) / 2, p.y + p.h * 0.875, (p.z0 + p.z1) / 2);
        for (let z = p.z0 + 2; z < p.z1 - 1; z += 3) pb.box(w - 0.06, 0.06, 0.12, M.dark, (p.x0 + p.x1) / 2, p.y + p.h + 0.01, z);
        return;
      }
      case 'boxes': {
        const rows = Math.max(1, Math.round((p.x1 - p.x0) / 2.6)), pitch = (p.x1 - p.x0) / rows, d = p.z1 - p.z0;
        let s = (p.seed * 9301 + 49297) % 233280;
        for (let r = 0; r < rows; r++) for (let t = 0; t < p.tiers; t++) {
          s = (s * 9301 + 49297) % 233280;
          if (t === p.tiers - 1 && s / 233280 < 0.25) continue;
          pb.box(pitch - 0.12, 2.5, d, M.boxes[s % M.boxes.length], p.x0 + pitch * (r + 0.5), p.y + 0.6 + 1.3 + t * 2.6, (p.z0 + p.z1) / 2);
        }
        pb.box(p.x1 - p.x0, 0.6, d, M.hatch, (p.x0 + p.x1) / 2, p.y + 0.3, (p.z0 + p.z1) / 2);
        return;
      }
      case 'block': { pb.box(p.x1 - p.x0, p.h, p.z1 - p.z0, M.wall, (p.x0 + p.x1) / 2, p.y + p.h / 2, (p.z0 + p.z1) / 2); return; }
      case 'piperack': {
        const w = p.x1 - p.x0;
        for (let i = 0; i < 4; i++) pb.rod(p.x0 + w * (0.15 + i * 0.23), p.y + 0.6, p.z0, p.x0 + w * (0.15 + i * 0.23), p.y + 0.6, p.z1, 0.25, M.steel, 8);
        pb.box(1.4, 0.12, p.z1 - p.z0, M.grating, 0, p.y + 1.25, (p.z0 + p.z1) / 2);
        for (let z = p.z0 + 2; z < p.z1; z += 8) for (const x of [p.x0 + 0.3, p.x1 - 0.3]) pb.box(0.2, 1.2, 0.2, M.steel, x, p.y + 0.6, z);
        return;
      }
      case 'manifold': { pb.box(1.6, 1.4, 4.5, M.steel, p.x, p.y + 0.7, p.z); for (let k = 0; k < 4; k++) pb.rod(p.x - 1.0, p.y + 1.0, p.z - 1.6 + k, p.x + 1.0, p.y + 1.0, p.z - 1.6 + k, 0.15, M.red, 8); return; }
      case 'bollard': { for (const dz of [-0.35, 0.35]) pb.cyl(0.16, 0.6, M.dark, p.x, p.y + 0.3, p.z + dz, 0.18, 10); pb.box(0.3, 0.12, 1.1, M.dark, p.x, p.y + 0.06, p.z); return; }
      case 'winch': { pb.cyl(0.45, p.w, M.dark, p.x, p.y + 0.7, p.z, 0.45, 12, 0, 0, Math.PI / 2); pb.box(p.w + 0.3, 0.4, 1.2, M.steel, p.x, p.y + 0.2, p.z); return; }
      case 'towhook': { pb.cyl(0.35, 1.4, M.dark, p.x, p.y + 0.7, p.z, 0.35, 10); pb.box(0.2, 0.2, 0.8, M.yellow, p.x, p.y + 1.35, p.z + 0.4); return; }
      case 'mast': { if (p.real) return; pb.cyl(p.r, p.h, p.sail ? M.rail : M.yellow, p.x, p.y + p.h / 2, p.z, p.r * 0.75, 10); if (!p.sail) pb.box(1.6, 0.12, 0.12, M.yellow, p.x, p.y + p.h * 0.75, p.z); return; }
      case 'funnel': { pb.cyl(p.r, p.h, M.dark, p.x, p.y + p.h / 2, p.z, p.r * 0.95, 16); pb.cyl(p.r * 1.01, p.h * 0.18, M.red, p.x, p.y + p.h * 0.62, p.z, p.r * 0.96, 16); return; }
      case 'raised': return this.raised(ctx, p);
      case 'vehicle': {
        const col = [M.red, M.white, M.boxes[1], M.boxes[2], M.yellow, M.dark][p.color % 6];
        if (p.lorry) { pb.box(p.w, p.h - 0.9, p.len - 2.4, M.boxes[(p.color + 3) % 8], p.x, p.y + 0.9 + (p.h - 0.9) / 2, p.z + 1.1); pb.box(p.w, 2.6, 2.2, col, p.x, p.y + 1.6, p.z - p.len / 2 + 1.1); }
        else { pb.box(p.w, 0.8, p.len, col, p.x, p.y + 0.6, p.z); pb.box(p.w - 0.2, 0.55, p.len * 0.5, M.glass, p.x, p.y + 1.25, p.z + 0.1); }
        return;
      }
      case 'ramp': { pb.box(p.w, 0.15, 5, M.steel, p.x, p.y + 1.2, p.z - 0.5, -0.9, 0, 0); return; }
      case 'drum': { pb.cyl(p.r, p.len, M.dark, p.x, p.y + p.r + 0.2, p.z, p.r, 14, 0, 0, Math.PI / 2); pb.cyl(p.r * 0.85, p.len * 0.95, M.boxes[2], p.x, p.y + p.r + 0.2, p.z, p.r * 0.85, 14, 0, 0, Math.PI / 2); return; }
      case 'gantry': {
        for (const s of [-1, 1]) pb.rod(s * p.w / 2, p.y, p.z, s * p.w * 0.42, p.y + p.h, p.z + 1.2, 0.25, M.orange, 8);
        pb.rod(-p.w * 0.42, p.y + p.h, p.z + 1.2, p.w * 0.42, p.y + p.h, p.z + 1.2, 0.25, M.orange, 8);
        return;
      }
      case 'coachroof': {
        const h = p.hatch, w = p.x1 - p.x0;
        pb.box(w, p.h, h.z0 - p.z0, M.white, (p.x0 + p.x1) / 2, p.y + p.h / 2, (p.z0 + h.z0) / 2);
        pb.box(h.x0 - p.x0, p.h, p.z1 - h.z0, M.white, (p.x0 + h.x0) / 2, p.y + p.h / 2, (h.z0 + p.z1) / 2);
        pb.box(p.x1 - h.x1, p.h, p.z1 - h.z0, M.white, (h.x1 + p.x1) / 2, p.y + p.h / 2, (h.z0 + p.z1) / 2);
        for (const s of [-1, 1]) pb.box(0.03, 0.18, (p.z1 - p.z0) * 0.5, M.dark, s * (w / 2 + 0.005), p.y + p.h * 0.6, (p.z0 + h.z0) / 2 + 0.3);
        return;
      }
      case 'wheel': {
        pb.cyl(0.08, 0.95, M.rail, p.x, p.y + 0.48, p.z, 0.08, 8);
        const wg = new THREE.Group(); wg.position.set(p.x, p.y + 1.0, p.z + 0.12);
        wg.add(new THREE.Mesh(new THREE.TorusGeometry(p.r, 0.025, 8, 28), M.rail)); for (let i = 0; i < 4; i++) { const sp = new THREE.Mesh(new THREE.BoxGeometry(0.03, p.r * 2, 0.03), M.rail); sp.rotation.z = (i * Math.PI) / 4; wg.add(sp); }
        g.add(wg); this.wheel = wg;
        pb.cyl(0.1, 0.05, M.white, p.x, p.y + 1.02, p.z - 0.15, 0.1, 14);
        return;
      }
      case 'windscreen': {
        const [ga, gb] = p.gap || [0, 0];
        if (ga > p.x0) pb.box(ga - p.x0, 0.6, 0.04, M.glass, (p.x0 + ga) / 2, p.y + 1.0, p.z, -0.4, 0, 0);
        if (p.x1 > gb) pb.box(p.x1 - gb, 0.6, 0.04, M.glass, (gb + p.x1) / 2, p.y + 1.0, p.z, -0.4, 0, 0);
        return;
      }
      case 'trampoline': { const m = new THREE.Mesh(new THREE.PlaneGeometry(p.x1 - p.x0, p.z1 - p.z0), M.net); m.rotation.x = -Math.PI / 2; m.position.set((p.x0 + p.x1) / 2, p.y - 0.02, (p.z0 + p.z1) / 2); g.add(m); return; }
      case 'repeater': { pb.cyl(0.12, 1.0, M.dark, p.x, p.y + 0.5, p.z, 0.15, 10); pb.cyl(0.2, 0.12, M.white, p.x, p.y + 1.06, p.z, 0.2, 14); return; }
      case 'sign': return this.sign(ctx, p);
      default: void plan; return;
    }
  }
  raised({ g, M, plan }, p) {
    // the forecastle's hull block (bosun's store), following the hull outline between z0 and z1
    const half = [];
    const L = plan.L, B = plan.B;
    for (let i = 0; i <= 16; i++) {
      const z = p.z0 + ((p.z1 - p.z0) * i) / 16;
      let hb = 0;
      for (const poly of plan.deck.polys) for (let k = 0; k < poly.length - 1; k++) {
        const [xa, za] = poly[k], [xb, zb] = poly[k + 1];
        if ((z - za) * (z - zb) <= 0 && Math.abs(zb - za) > 1e-9) hb = Math.max(hb, Math.abs(xa + ((xb - xa) * (z - za)) / (zb - za)));
      }
      half.push([Math.max(0.05, hb - 0.02), z]);
    }
    const pts = half.map(([x, z]) => new THREE.Vector2(x, -z)).concat(half.slice().reverse().map(([x, z]) => new THREE.Vector2(-x, -z)));
    const geo = new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth: p.y1 - p.y0 - 0.07, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, M.wallSteel); m.position.y = p.y0; g.add(m);
    void L; void B;
  }
  sign({ g }, p) {
    const cv = makeCanvas(512, 128), c = cv.getContext('2d');
    c.fillStyle = '#f4f1e6'; c.fillRect(0, 0, 512, 128); c.strokeStyle = '#1d3b5a'; c.lineWidth = 8; c.strokeRect(4, 4, 504, 120);
    c.fillStyle = '#1d3b5a'; c.textAlign = 'center'; c.font = 'bold 44px "Segoe UI", system-ui, sans-serif'; c.fillText(p.lines[0] || '', 256, 54);
    c.font = '34px "Segoe UI", system-ui, sans-serif'; c.fillStyle = '#7a1f12'; c.fillText(p.lines[1] || '', 256, 104);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; this.textures.push(tex);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.225), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
    m.position.set(p.x, p.y, p.z); m.rotation.y = p.rotY || 0; g.add(m);
  }
  bunk({ pb, M }, p) {
    const w = p.w || 0.85, sx = p.along === 'z' ? w : p.len, sz = p.along === 'z' ? p.len : w;
    for (let t = 0; t < (p.tiers || 1); t++) {
      const yy = p.y + 0.45 + t * 0.95;
      pb.box(sx, 0.16, sz, M.wood, p.x, yy, p.z); pb.box(sx - 0.1, 0.12, sz - 0.1, M.blanket, p.x, yy + 0.13, p.z);
      const px = p.along === 'z' ? p.x : p.x - (p.len / 2 - 0.3), pz = p.along === 'z' ? p.z - (p.len / 2 - 0.3) : p.z;
      pb.box(p.along === 'z' ? Math.min(0.5, sx - 0.2) : 0.4, 0.1, p.along === 'z' ? 0.4 : 0.5, M.pillow, px, yy + 0.22, pz);
    }
    pb.box(sx, 0.45, sz, M.wood, p.x, p.y + 0.18, p.z);
  }
  engineBlock({ pb, M }, p) {
    const { x, y, z, len: el, w: ew, h: eh } = p;
    pb.box(ew, eh, el, M.engine, x, y + eh / 2 + 0.2, z); pb.box(ew + 0.4, 0.2, el + 0.4, M.dark, x, y + 0.1, z);
    const n = Math.max(3, Math.min(8, Math.round(el / 0.6)));
    for (let i = 0; i < n; i++) pb.cyl(ew * 0.18, 0.3, M.steel, x, y + eh + 0.35, z - el / 2 + ((i + 0.5) * el) / n, ew * 0.18, 10);
    pb.rod(x + ew * 0.35, y + eh + 0.3, z + el * 0.35, x + ew * 0.35, y + eh + 1.0, z + el * 0.35, ew * 0.15, M.steel, 10);
    pb.rod(x - ew * 0.5, y + eh * 0.55, z - el * 0.45, x - ew * 0.5, y + eh * 0.55, z + el * 0.45, ew * 0.1, M.rail, 8);
    pb.box(ew * 0.5, eh * 0.4, 0.4, M.yellow, x, y + eh * 0.35 + 0.2, z + el / 2 + 0.2);
    // flywheel at the aft end and a turbocharger on the forward end: reads as a marine diesel at a glance
    const fr = Math.min(eh * 0.42, ew * 0.55);
    pb.cyl(fr, 0.12, M.dark, x, y + 0.2 + fr + 0.05, z + el / 2 - 0.08, fr, 18, Math.PI / 2, 0, 0);
    const tr = Math.max(0.12, ew * 0.2);
    pb.cyl(tr, tr * 2.2, M.steel, x - ew * 0.15, y + eh + 0.35 + tr, z - el / 2 + tr + 0.15, tr * 0.8, 12, 0, 0, Math.PI / 2);
    pb.rod(x - ew * 0.15 + tr * 1.1, y + eh + 0.35 + tr, z - el / 2 + tr + 0.15, x + ew * 0.35, y + eh + 0.3, z - el / 2 + tr + 0.15, tr * 0.45, M.steel, 8);
  }
  engineConsole({ g, pb, M }, p) {
    const c = Math.cos(p.rotY), s = Math.sin(p.rotY);
    const w = p.wall ? 1.0 : 1.7;
    if (!p.wall) {
      const cx = p.x, cz = p.z;
      pb.box(Math.abs(c) > 0.5 ? w : 0.7, 0.95, Math.abs(c) > 0.5 ? 0.7 : w, M.console, cx, p.y + 0.475, cz);
    }
    const cv = makeCanvas(512, 256); this.gauge = { cv, ctx: cv.getContext('2d'), tex: new THREE.CanvasTexture(cv) };
    this.gauge.tex.colorSpace = THREE.SRGBColorSpace; this.textures.push(this.gauge.tex);
    const panel = new THREE.Group();
    panel.position.set(p.x + s * (p.wall ? 0.04 : -0.15), p.y + (p.wall ? 1.45 : 1.3), p.z + c * (p.wall ? 0.04 : -0.15)); panel.rotation.y = p.rotY;
    panel.add(new THREE.Mesh(new THREE.BoxGeometry(w * 0.95, w * 0.5, 0.08), M.dark));
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.88, w * 0.44), new THREE.MeshBasicMaterial({ map: this.gauge.tex })); scr.position.z = 0.045; panel.add(scr);
    if (!p.wall) panel.rotation.x = -0.3 * 0;
    g.add(panel);
    this.drawGauges();
  }
  drawGauges() {
    const G = this.gauge; if (!G) return;
    const { ctx: c, cv } = G, app = this.app, you = app.you, s = app.ship || you?.ship || { throttle: 0 };
    const C = SHIP_CLASSES[you?.ship.cls] || SHIP_CLASSES.coaster, rpmMax = RPM[you?.ship.cls] || RPM[baseOf(you?.ship.cls)] || 900;
    const thr = s.throttle || 0, rf = rpmFraction(thr) * (you?.fuelEmpty ? 0 : 1);
    const t = performance.now() / 1000;
    const dials = [
      { label: 'RPM', v: rf + Math.sin(t * 7) * 0.01 * rf, txt: `${Math.round(rf * rpmMax)}`, red: 0.92 },
      { label: 'FUEL', v: you ? clamp(you.fuel / C.fuelCap, 0, 1) : 0, txt: you ? `${you.fuel.toFixed(1)} t` : '—', red: 0.1, redLow: true },
      { label: 'TEMP', v: clamp(0.35 + 0.55 * Math.abs(thr) + Math.sin(t * 0.7) * 0.03 + (you ? (1 - you.cond / 100) * 0.1 : 0), 0, 1), txt: `${Math.round(40 + 55 * Math.abs(thr))} °C`, red: 0.9 },
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
    // telegraph order and throttle, as the engine room sees them
    c.fillStyle = '#0d1114'; c.fillRect(16, 182, cv.width - 32, 58);
    c.fillStyle = thr < -0.005 ? '#f2b134' : '#58d68d'; c.font = 'bold 26px monospace'; c.textAlign = 'left';
    c.fillText(`${orderLabel(thr).toUpperCase()}`, 30, 220);
    c.fillStyle = '#dbe9f4'; c.font = '20px monospace'; c.textAlign = 'right'; c.fillText(`THR ${Math.round(thr * 100)} %`, cv.width - 30, 220);
    c.fillStyle = you?.fuelEmpty ? '#ff6b6b' : you && you.flooding > 0.01 ? '#f2b134' : '#58d68d'; c.beginPath(); c.arc(cv.width - 22, 22, 7, 0, Math.PI * 2); c.fill();
    G.tex.needsUpdate = true;
  }

  // ---- bridge furniture
  helmConsole(ctx, x, y, z, w, facing = -1, windscreen = false) {
    // console box at the front of the bridge (facing = -1: the player stands aft of it looking forward)
    const { g, pb, M } = ctx;
    const d = 0.8;
    pb.box(w, 1.0, d, M.console, x, y + 0.5, z);
    pb.box(w, 0.08, d + 0.1, M.dark, x, y + 1.04, z, facing * 0.18, 0, 0);
    const wheel = new THREE.Group(); wheel.position.set(x, y + 1.25, z - facing * 0.5);
    wheel.add(new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.025, 8, 24), M.wood));
    for (let i = 0; i < 4; i++) { const sp = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.56, 0.03), M.wood); sp.rotation.z = (i * Math.PI) / 4; wheel.add(sp); }
    wheel.rotation.x = facing * -0.35; g.add(wheel); this.wheel = wheel;
    const lever = new THREE.Group(); lever.position.set(x + Math.min(0.9, w * 0.25), y + 1.08, z);
    lever.add(new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.3, 0.04), M.rail)); const knob = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.08), M.red); knob.position.y = 0.32; lever.children[0].position.y = 0.15; lever.add(knob);
    g.add(lever); this.lever = lever;
    pb.box(0.14, 0.04, 0.3, M.dark, lever.position.x, y + 1.06, z);
    try { this.app.telegraph?.attachBridge?.(g, x + Math.min(w / 2 - 0.05, Math.min(0.9, w * 0.25) + 0.42), y + 1.36, z, facing); } catch (e) { console.warn('[interior] telegraph dial', e); }
    const radarCv = document.getElementById('radar');
    if (radarCv && w > 1.2) {
      this.radarTex = new THREE.CanvasTexture(radarCv); this.radarTex.colorSpace = THREE.SRGBColorSpace;
      const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5), new THREE.MeshBasicMaterial({ map: this.radarTex, side: THREE.DoubleSide }));
      scr.position.set(x - Math.min(0.9, w * 0.25), y + 1.36, z - facing * 0.06); scr.rotation.x = facing * -0.35; if (facing > 0) scr.rotation.y = Math.PI; g.add(scr);
      pb.box(0.6, 0.6, 0.06, M.dark, scr.position.x, scr.position.y, z, facing * -0.35, 0, 0);
    }
    pb.cyl(0.12, 0.06, M.white, x, y + 1.1, z + facing * 0.25, 0.12, 16);
    pb.box(w * 0.6, 0.28, 0.04, M.dark, x, y + 1.3, z + facing * 0.36);
    for (let i = 0; i < 5; i++) pb.box(0.05, 0.05, 0.02, i % 2 ? M.red : M.green, x - w * 0.25 + i * (w * 0.12), y + 1.3, z + facing * 0.385);
    if (windscreen) pb.box(w + 0.2, 0.55, 0.04, M.glass, x, y + 1.35, z + facing * 0.45, -0.45, 0, 0);
    // chair
    pb.cyl(0.05, 0.6, M.rail, x, y + 0.3, z - facing * 1.6, 0.05, 8); pb.box(0.5, 0.08, 0.5, M.fabric, x, y + 0.62, z - facing * 1.6); pb.box(0.5, 0.5, 0.08, M.fabric, x, y + 0.9, z - facing * 1.6 - facing * -0.22);
  }
  upperHelm({ pb, M }, p) {
    pb.box(p.w, 1.0, 0.7, M.white, p.x, p.y + 0.5, p.z); pb.box(p.w, 0.06, 0.8, M.dark, p.x, p.y + 1.03, p.z, -0.18, 0, 0);
    pb.geo(new THREE.TorusGeometry(0.22, 0.02, 6, 20), M.rail, p.x, p.y + 1.2, p.z + 0.42, -0.4, 0, 0);
    pb.box(p.w + 0.1, 0.4, 0.04, M.glass, p.x, p.y + 1.25, p.z - 0.4, -0.5, 0, 0);
  }
  radio({ pb, M }, x, y, z, rotY = 0) {
    pb.box(0.36, 0.14, 0.2, M.dark, x, y, z, 0, rotY, 0);
    pb.box(0.26, 0.05, 0.012, M.green, x + Math.sin(rotY) * 0.105, y + 0.02, z + Math.cos(rotY) * 0.105, 0, rotY, 0);
    pb.cyl(0.015, 0.22, M.rail, x + Math.cos(rotY) * 0.22, y + 0.18, z - Math.sin(rotY) * 0.22, 0.015, 6);
  }
  chartTable({ g, pb, M }, x, y, z, w = 1.4, d = 0.9) {
    pb.box(w, 0.06, d, M.wood, x, y + 0.9, z); pb.box(w - 0.1, 0.8, d - 0.1, M.wallDark, x, y + 0.45, z);
    const paper = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.2, d - 0.2), new THREE.MeshStandardMaterial({ color: 0xf2eedc, roughness: 0.9 }));
    paper.rotation.x = -Math.PI / 2; paper.position.set(x, y + 0.935, z); g.add(paper);
    try { new THREE.TextureLoader().load('/api/chart/region.png', (t) => { t.colorSpace = THREE.SRGBColorSpace; this.textures.push(t); paper.material.map = t; paper.material.color.set(0xffffff); paper.material.needsUpdate = true; }); } catch {}
    pb.cyl(0.012, 0.18, M.yellow, x + w * 0.3, y + 0.95, z + d * 0.2, 0.012, 6, 0, 0, 1.2);
  }
}

function disposeFallback(g) {
  g.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of ms) { m.map?.dispose(); m.dispose(); }
  });
}
