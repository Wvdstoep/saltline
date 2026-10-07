// Saltline client: scene, floating origin, local ship simulation, networking glue, camera, day/night, HUD loop.
import * as THREE from 'three';
import { GEO, SIM, SHIP_CLASSES, INTERACT, LAYERS } from '/shared/constants.js';
import { toLocal, fromLocal, haversine, bearing, unitsBetween, angleDiff, normDeg, fmtDistance } from '/shared/geo.js';
import { stepShip, currentAt } from '/shared/physics.js';
import { Net } from './net.js';
import { Ocean } from './ocean.js';
import { Terrain, VSCALE } from './terrain.js';
import { buildShip, buildWreck } from './ship.js';
import { buildHarbor, buildFishingMarker } from './harbor.js';
import { Hud } from './hud.js';

const D2R = Math.PI / 180;

class App {
  constructor() {
    this.canvas = document.getElementById('view');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.0;
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0xbfd9ee, 1200, 5200);
    this.camera = new THREE.PerspectiveCamera(60, 1, 1, 12000);
    this.sun = new THREE.DirectionalLight(0xfff2d0, 2.2); this.scene.add(this.sun); this.scene.add(this.sun.target);
    this.hemi = new THREE.HemisphereLight(0x9fc4e8, 0x3a4a3a, 0.9); this.scene.add(this.hemi);
    this.sky = this.makeSky();
    this.ocean = new Ocean(this.scene);
    this.terrain = new Terrain(this.scene);
    this.origin = { lat: 52, lon: 4 };
    this.net = new Net({ status: (s) => this.onStatus(s), message: (m) => this.onMessage(m) });
    this.hud = new Hud(this);
    this.you = null; this.world = { harbors: [], fishing: [] }; this.ship = null; this.simTime = 0; this.wind = { u: 0, v: 0, spd: 5, dir: 240 };
    this.others = new Map(); this.cutters = new Map(); this.wrecks = []; this.wreckMeshes = new Map();
    this.harborMeshes = new Map(); this.groundMeshes = new Map(); this.osm = null;
    this.myMesh = null; this.myVis = { heave: 0, pitch: 0, roll: 0 };
    this.input = { throttleCmd: 0, rudderCmd: 0, left: false, right: false, up: false, down: false };
    this.cam = { yaw: 0, pitch: 0.28, dist: 260, free: false, mode: 0 };
    this.waypoint = null; this.autopilot = false;
    this.lastGrounding = 0; this.clock = new THREE.Clock(); this.time = 0; this.started = false; this.lastSend = 0;
    this.lastTerrainUpdate = 0; this.lastRadar = 0; this.lastTelemetry = 0; this.ready = false;
    window.addEventListener('resize', () => this.resize()); this.resize();
    this.bindInput();
    this.net.connect('');
    requestAnimationFrame(() => this.loop());
  }
  resize() { const w = innerWidth, h = innerHeight; this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }
  makeSky() {
    const geo = new THREE.SphereGeometry(9000, 24, 12);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new THREE.Color(0x3f7fc9) }, horizon: { value: new THREE.Color(0xbfd9ee) }, sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunCol: { value: new THREE.Color(0xfff0c0) } },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; uniform vec3 sunCol; varying vec3 vDir;
        void main(){ float t = clamp(vDir.y, -0.1, 1.0); vec3 c = mix(horizon, top, pow(max(0.0,t), 0.55)); float s = max(0.0, dot(normalize(vDir), sunDir));
        c += sunCol * (pow(s, 600.0) * 1.5 + pow(s, 8.0) * 0.12); if (vDir.y < 0.0) c = mix(c, horizon * 0.55, min(1.0, -vDir.y * 8.0)); gl_FragColor = vec4(c, 1.0); }`,
    });
    const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; this.scene.add(m); return m;
  }

  // ------------------------------------------------------------------ networking
  onStatus(s) { this.hud.setStatus(s === 'connected' ? 'Connected to the shard.' : s === 'replaced' ? 'This skipper logged in from another tab.' : 'Disconnected — reconnecting…'); if (s === 'connected' && this.started) this.net.send({ t: 'hello', token: this.net.token, name: this.net.name }); }
  start(name) {
    if (!this.net.connected) { this.hud.setStatus('Still connecting… try again in a second.'); return; }
    try { localStorage.setItem('saltline.name', name); } catch {}
    this.started = true; this.net.name = name;
    this.net.send({ t: 'hello', token: this.net.token, name });
    this.hud.showWelcome(false);
  }
  onMessage(m) {
    switch (m.t) {
      case 'welcome': this.onWelcome(m); break;
      case 'snap': this.onSnap(m); break;
      case 'you': this.onYou(m.you); break;
      case 'event': this.hud.event(m); if (m.kind === 'law' || m.kind === 'pirate') this.flash(); break;
      case 'harbor': this.hud.showHarbor(m.harbor); break;
      case 'chat': this.hud.chat(m); break;
      case 'join': this.hud.event({ kind: 'info', text: `${m.player.name} came online.` }); break;
      case 'leave': { const o = this.others.get(m.id); if (o) { this.hud.event({ kind: 'info', text: `${o.name} went offline.` }); this.scene.remove(o.mesh); this.others.delete(m.id); } break; }
      case 'rename': { const o = this.others.get(m.id); if (o) { o.name = m.name; o.mesh.userData.label?.userData.setText(m.name); } break; }
      case 'wrecks': this.wrecks = m.wrecks; this.syncWrecks(); break;
      case 'trade': this.hud.prompt(m.offer.id, `<b>${m.offer.fromName}</b> offers <b>${m.offer.qty} t ${m.offer.goodName}</b>${m.offer.contraband ? ' <span class="pill bad">contraband</span>' : ''} for <b>${m.offer.price.toLocaleString()} cr</b>.`, [{ label: 'Accept', primary: true, fn: () => this.net.action('trade_accept', { offerId: m.offer.id }) }, { label: 'Decline', fn: () => this.net.action('trade_decline', { offerId: m.offer.id }) }]); break;
      case 'convoy_invite': this.hud.prompt(m.convoyId, `<b>${m.from}</b> invites you to form a convoy. Escorts halve pirates' boarding odds.`, [{ label: 'Join', primary: true, fn: () => this.net.action('convoy_accept', { convoyId: m.convoyId }) }, { label: 'No', fn: () => {} }]); break;
    }
  }
  onWelcome(m) {
    this.world = m.world; this.wrecks = m.wrecks; this.simTime = m.simTime;
    this.onYou(m.you, true);
    for (const l of m.log || []) this.hud.event(l);
    for (const p of m.players) this.upsertOther(p, performance.now());
    for (const c of m.cutters) this.upsertCutter(c, performance.now());
    this.syncWrecks();
    if (!this.osm) fetch('/api/osm').then((r) => r.json()).then((j) => { this.osm = j.harbors || {}; }).catch(() => { this.osm = {}; });
    this.ready = true;
    if (!this.started) this.hud.setStatus('Connected. Pick a name and set sail.');
  }
  onYou(you, first) {
    const prev = this.you;
    this.you = you;
    const s = you.ship;
    if (!this.ship || first || !prev || prev.ship.cls !== s.cls || !!prev.docked !== !!you.docked || unitsBetween(this.ship.lat, this.ship.lon, s.lat, s.lon) > 400) {
      this.ship = { ...s, throttleCmd: s.throttle, rudderCmd: 0 };
      this.input.throttleCmd = you.docked ? 0 : s.throttle; this.input.rudderCmd = 0;
      if (!this.myMesh || prev?.ship.cls !== s.cls) {
        if (this.myMesh) this.scene.remove(this.myMesh);
        this.myMesh = buildShip(s.cls, you.name, 7); this.scene.add(this.myMesh);
      }
      this.recentre(true);
    }
    if (prev && prev.docked && !you.docked) { this.hud.hideHarbor(); }
    if (!prev?.docked && you.docked) { this.input.throttleCmd = 0; this.input.rudderCmd = 0; this.autopilot = false; }
    if (prev?.name !== you.name) this.myMesh?.userData.label?.userData.setText(you.name);
    this.myMesh?.userData.setWear(1 - you.cond / 100); this.myMesh?.userData.setFlood(you.flooding);
    if (this.hud.harborOpen()) this.hud.renderHarborTabs();
  }
  onSnap(m) {
    const now = performance.now();
    this.simTime = m.simTime; this.wind = m.wind; this.ocean.setWind(m.wind.spd);
    const seen = new Set();
    for (const p of m.players) { if (p.id === this.you?.id) continue; seen.add(p.id); this.upsertOther(p, now); }
    for (const [id, o] of this.others) if (!seen.has(id)) { this.scene.remove(o.mesh); this.others.delete(id); }
    for (const c of m.cutters) this.upsertCutter(c, now);
  }
  upsertOther(p, now) {
    let o = this.others.get(p.id);
    if (!o) {
      o = { id: p.id, name: p.name, cls: p.cls, mesh: buildShip(p.cls, p.name, p.id.charCodeAt(0)), samples: [], cur: { lat: p.lat, lon: p.lon, hdg: p.hdg, spd: p.spd }, vis: { heave: 0, pitch: 0, roll: 0 } };
      this.scene.add(o.mesh); this.others.set(p.id, o);
    } else if (o.cls !== p.cls) { this.scene.remove(o.mesh); o.cls = p.cls; o.mesh = buildShip(p.cls, p.name, 3); this.scene.add(o.mesh); }
    Object.assign(o, { name: p.name, cond: p.cond, flooding: p.flooding, convoyId: p.convoyId, wanted: p.wanted, docked: p.docked, sinking: p.sinking });
    o.samples.push({ t: now, lat: p.lat, lon: p.lon, hdg: p.hdg, spd: p.spd }); if (o.samples.length > 4) o.samples.shift();
    o.mesh.userData.setWear(1 - p.cond / 100); o.mesh.userData.setFlood(p.flooding);
    o.mesh.visible = !p.docked || true;
  }
  upsertCutter(c, now) {
    let o = this.cutters.get(c.id);
    if (!o) { o = { id: c.id, name: c.name, mesh: buildShip('cutter', c.name, 11), samples: [], cur: { lat: c.lat, lon: c.lon, hdg: c.hdg, spd: c.spd }, vis: { heave: 0, pitch: 0, roll: 0 } }; this.scene.add(o.mesh); this.cutters.set(c.id, o); }
    o.state = c.state; o.targetId = c.targetId;
    o.samples.push({ t: now, lat: c.lat, lon: c.lon, hdg: c.hdg, spd: c.spd }); if (o.samples.length > 4) o.samples.shift();
  }
  syncWrecks() {
    const ids = new Set(this.wrecks.map((w) => w.id));
    for (const [id, m] of this.wreckMeshes) if (!ids.has(id)) { this.scene.remove(m); this.wreckMeshes.delete(id); }
    for (const w of this.wrecks) if (!this.wreckMeshes.has(w.id)) { const m = buildWreck(w.cls); this.scene.add(m); this.wreckMeshes.set(w.id, m); }
  }

  // ------------------------------------------------------------------ world placement
  recentre(force) {
    if (!this.ship) return;
    const p = toLocal(this.ship.lat, this.ship.lon, this.origin);
    if (!force && Math.hypot(p.x, p.z) < SIM.ORIGIN_RESHIFT_UNITS) return;
    this.origin = { lat: this.ship.lat, lon: this.ship.lon };
    this.terrain.setOrigin(this.origin);
    this.ocean.rebuildDepth(0, 0, (x, z) => this.heightLocal(x, z), true);
    for (const [id, m] of this.harborMeshes) this.scene.remove(m); this.harborMeshes.clear();
    for (const [id, m] of this.groundMeshes) this.scene.remove(m); this.groundMeshes.clear();
  }
  heightLocal(x, z) { const ll = fromLocal(x, z, this.origin); return this.terrain.heightAt(ll.lat, ll.lon); }
  place(obj, lat, lon, y = 0) { const p = toLocal(lat, lon, this.origin); obj.position.set(p.x, y, p.z); return p; }
  inRegion() { const s = this.ship; if (!s) return false; const d = LAYERS[1]; return s.lat >= d.latMin && s.lat < d.latMax && s.lon >= d.lonMin && s.lon < d.lonMax; }
  updateScenery() {
    const s = this.ship; if (!s) return;
    for (const h of this.world.harbors) {
      const d = unitsBetween(s.lat, s.lon, h.lat, h.lon);
      const has = this.harborMeshes.has(h.id);
      if (d < 9000 && !has) { const m = buildHarbor(h, this.osm?.[h.id]); this.place(m, h.lat, h.lon); this.scene.add(m); this.harborMeshes.set(h.id, m); }
      else if (d > 11000 && has) { this.scene.remove(this.harborMeshes.get(h.id)); this.harborMeshes.delete(h.id); }
    }
    for (const g of this.world.fishing) {
      const d = unitsBetween(s.lat, s.lon, g.lat, g.lon);
      const has = this.groundMeshes.has(g.id);
      if (d < 9000 && !has) { const m = buildFishingMarker(g); this.place(m, g.lat, g.lon); this.scene.add(m); this.groundMeshes.set(g.id, m); }
      else if (d > 11000 && has) { this.scene.remove(this.groundMeshes.get(g.id)); this.groundMeshes.delete(g.id); }
    }
    for (const w of this.wrecks) { const m = this.wreckMeshes.get(w.id); if (m) this.place(m, w.lat, w.lon, -2); }
    const cam = this.camera.position;
    for (const m of this.harborMeshes.values()) { const l = m.children.find((c) => c.isSprite); if (l) l.visible = m.position.distanceTo(cam) < 3200; }
    for (const m of this.groundMeshes.values()) { const l = m.children.find((c) => c.isSprite); if (l) l.visible = m.position.distanceTo(cam) < 3200; }
  }

  // ------------------------------------------------------------------ input
  bindInput() {
    const typing = () => document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA');
    window.addEventListener('keydown', (e) => {
      if (!this.started) return;
      if (typing()) return;
      const k = e.key.toLowerCase();
      if (k === 'enter') { document.getElementById('chatInput').focus(); e.preventDefault(); return; }
      if (k === 'escape') { this.hud.closeOverlays(); if (this.hud.harborOpen()) this.hud.hideHarbor(); return; }
      if (k === 'm') return this.hud.toggleChart();
      if (k === 'tab') { e.preventDefault(); return this.hud.toggleShips(); }
      if (k === 'h') return document.getElementById('helpWrap').classList.toggle('hidden');
      if (k === 'r' && this.hud.chartOpen()) { this.hud.chartMode = this.hud.chartMode === 'region' ? 'world' : 'region'; this.hud.drawChart(); return; }
      if (k === 't') return this.toggleDock();
      if (k === 'f') return this.net.action('fish', { on: !this.you?.fishing });
      if (k === 'k') return this.net.action('patch');
      if (k === 'p') return this.toggleAutopilot();
      if (k === 'c') { this.cam.mode = (this.cam.mode + 1) % 3; return; }
      if (k === 'x') { this.waypoint = null; this.autopilot = false; return; }
      if (this.you?.docked) return;
      if (k === 'w' || k === 'arrowup') { this.input.throttleCmd = Math.min(1, Math.round((this.input.throttleCmd + 0.1) * 10) / 10); this.autopilotThrottle = false; }
      if (k === 's' || k === 'arrowdown') { this.input.throttleCmd = Math.max(-0.3, Math.round((this.input.throttleCmd - 0.1) * 10) / 10); }
      if (k === 'a' || k === 'arrowleft') { this.input.left = true; this.autopilot = false; }
      if (k === 'd' || k === 'arrowright') { this.input.right = true; this.autopilot = false; }
      if (k === ' ') { this.input.rudderCmd = 0; this.input.throttleCmd = 0; e.preventDefault(); }
      if (k === 'b') this.boardNearest();
      if (k === 'v') this.salvageNearest();
    });
    window.addEventListener('keyup', (e) => { const k = e.key.toLowerCase(); if (k === 'a' || k === 'arrowleft') this.input.left = false; if (k === 'd' || k === 'arrowright') this.input.right = false; });
    let drag = null;
    this.canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; this.canvas.setPointerCapture(e.pointerId); });
    this.canvas.addEventListener('pointermove', (e) => { if (!drag) return; this.cam.yaw -= (e.clientX - drag.x) * 0.006; this.cam.pitch = THREE.MathUtils.clamp(this.cam.pitch + (e.clientY - drag.y) * 0.004, 0.05, 1.3); this.cam.free = true; this.cam.lastDrag = performance.now(); drag = { x: e.clientX, y: e.clientY }; });
    this.canvas.addEventListener('pointerup', () => { drag = null; });
    this.canvas.addEventListener('wheel', (e) => { this.cam.dist = THREE.MathUtils.clamp(this.cam.dist * (1 + Math.sign(e.deltaY) * 0.12), 60, 1800); e.preventDefault(); }, { passive: false });
  }
  toggleDock() { if (!this.you) return; if (this.you.docked) this.net.action('undock'); else this.net.action('dock'); }
  toggleAutopilot() { if (!this.waypoint) { this.hud.event({ kind: 'warn', text: 'Set a waypoint on the chart (M) first.' }); return; } this.autopilot = !this.autopilot; }
  setWaypoint(lat, lon) { this.waypoint = { lat, lon }; this.hud.event({ kind: 'info', text: `Waypoint set: ${fmtDistance(haversine(this.ship.lat, this.ship.lon, lat, lon))}, bearing ${Math.round(bearing(this.ship.lat, this.ship.lon, lat, lon))}°. Press P for autopilot.` }); }
  nearestOther(range) { let best = null, bd = range; for (const o of this.others.values()) { const d = unitsBetween(this.ship.lat, this.ship.lon, o.cur.lat, o.cur.lon); if (d < bd) { bd = d; best = o; } } return best; }
  boardNearest() { const o = this.nearestOther(INTERACT.BOARD_RANGE_U * 1.5); if (!o) return this.hud.event({ kind: 'warn', text: 'No ship within boarding range (120 m).' }); if (confirm(`Board ${o.name}? Piracy makes you wanted.`)) this.net.action('board', { targetId: o.id }); }
  salvageNearest() { let best = null, bd = INTERACT.SALVAGE_RANGE_U * 1.5; for (const w of this.wrecks) { const d = unitsBetween(this.ship.lat, this.ship.lon, w.lat, w.lon); if (d < bd) { bd = d; best = w; } } if (!best) return this.hud.event({ kind: 'warn', text: 'No wreck within 100 m.' }); this.net.action('salvage', { wreckId: best.id }); }
  flash() { document.body.style.boxShadow = 'inset 0 0 120px rgba(255,60,60,0.6)'; setTimeout(() => { document.body.style.boxShadow = ''; }, 600); }

  // ------------------------------------------------------------------ simulation
  simulate(dt) {
    const s = this.ship, you = this.you; if (!s || !you) return;
    if (you.docked || you.flooding >= 1) { s.spd = 0; s.throttle = 0; return; }
    // rudder from keys (hold) or autopilot
    if (this.autopilot && this.waypoint) {
      const brg = bearing(s.lat, s.lon, this.waypoint.lat, this.waypoint.lon);
      this.input.rudderCmd = THREE.MathUtils.clamp(angleDiff(s.hdg, brg) / 25, -1, 1);
      const d = unitsBetween(s.lat, s.lon, this.waypoint.lat, this.waypoint.lon);
      if (d < 250) { this.autopilot = false; this.waypoint = null; this.input.rudderCmd = 0; this.hud.event({ kind: 'info', text: 'Waypoint reached.' }); }
    } else if (this.input.left || this.input.right) {
      this.input.rudderCmd = THREE.MathUtils.clamp(this.input.rudderCmd + (this.input.left ? -1 : 1) * dt * 1.4, -1, 1);
    } else { this.input.rudderCmd += (0 - this.input.rudderCmd) * Math.min(1, dt * 2.5); if (Math.abs(this.input.rudderCmd) < 0.02) this.input.rudderCmd = 0; }
    const C = SHIP_CLASSES[s.cls];
    const prevLat = s.lat, prevLon = s.lon;
    const env = { cond: you.cond, flooding: you.flooding, loadFrac: you.cargo.reduce((a, c) => a + c.qty, 0) / C.capacity, wind: this.wind, current: currentAt(s.lat, s.lon, this.simTime), fuelEmpty: you.fuelEmpty, grounded: false };
    const sub = Math.max(1, Math.min(8, Math.ceil(dt / 0.02)));
    for (let i = 0; i < sub; i++) stepShip(s, { throttleCmd: this.input.throttleCmd, rudderCmd: this.input.rudderCmd }, env, dt / sub);
    // grounding check against loaded terrain
    const h = this.terrain.heightAt(s.lat, s.lon);
    if (h != null && -h < C.draft) {
      s.lat = prevLat; s.lon = prevLon;
      if (Math.abs(s.spd) > 0.5) {
        s.spd *= 0.15;
        const now = performance.now();
        if (now - this.lastGrounding > 4000) { this.lastGrounding = now; this.net.action('grounding'); this.hud.alert('ground', 'AGROUND — reverse off (S)', ''); setTimeout(() => this.hud.clearAlert('ground'), 4000); }
      } else s.spd = 0;
    }
    this.net.sendState(s);
  }
  interp(o, now) {
    const S = o.samples; if (!S.length) return;
    const t = now - 150;
    let a = S[0], b = S[S.length - 1];
    for (let i = 0; i < S.length - 1; i++) if (S[i].t <= t && S[i + 1].t >= t) { a = S[i]; b = S[i + 1]; break; }
    let lat, lon, hdg;
    if (t >= b.t) { // extrapolate briefly by dead reckoning
      const dtE = Math.min(1.0, (t - b.t) / 1000);
      const v = b.spd * GEO.KN_TO_MS * SIM.MOTION_SCALE * dtE;
      lat = b.lat + (Math.cos(b.hdg * D2R) * v) / GEO.M_PER_DEG_LAT; lon = b.lon + (Math.sin(b.hdg * D2R) * v) / (GEO.M_PER_DEG_LON_EQ * Math.cos(b.lat * D2R));
      hdg = b.hdg;
    } else {
      const f = b.t === a.t ? 1 : (t - a.t) / (b.t - a.t);
      lat = a.lat + (b.lat - a.lat) * f; lon = a.lon + (b.lon - a.lon) * f; hdg = normDeg(a.hdg + angleDiff(a.hdg, b.hdg) * f);
    }
    o.cur = { lat, lon, hdg, spd: b.spd };
  }
  shipVisual(mesh, lat, lon, hdg, spd, vis, flooding, dt, docked) {
    const p = this.place(mesh, lat, lon, 0);
    const L = mesh.userData.length, B = mesh.userData.beam;
    const h = hdg * D2R, fx = Math.sin(h), fz = -Math.cos(h);
    const t = this.time;
    const wave = (x, z) => this.ocean.heightAt(x, z, t);
    const hb = wave(p.x + fx * L * 0.4, p.z + fz * L * 0.4), hs = wave(p.x - fx * L * 0.4, p.z - fz * L * 0.4);
    const hp = wave(p.x - fz * B * 0.5, p.z + fx * B * 0.5), hst = wave(p.x + fz * B * 0.5, p.z - fx * B * 0.5);
    const k = Math.min(1, dt * 2.5);
    const damp = docked ? 0.3 : 1;
    vis.heave += ((hb + hs + hp + hst) / 4 * damp - vis.heave) * k;
    vis.pitch += (Math.atan2(hb - hs, L * 0.8) * damp - vis.pitch) * k;
    vis.roll += (Math.atan2(hp - hst, B) * damp + flooding * 0.25 - vis.roll) * k;
    const sink = flooding >= 1 ? Math.min(60, (vis.sinkT = (vis.sinkT || 0) + dt) * 6) : 0;
    if (flooding < 1) vis.sinkT = 0;
    mesh.position.y = vis.heave - flooding * (mesh.userData.freeboard + 2) - sink;
    mesh.rotation.set(vis.pitch, -h, vis.roll, 'YXZ');
    mesh.userData.setWake?.(Math.abs(spd) / 10);
  }
  updateCamera(dt) {
    const s = this.ship; if (!s || !this.myMesh) return;
    const target = this.myMesh.position.clone().add(new THREE.Vector3(0, 8, 0));
    if (this.cam.free && performance.now() - this.cam.lastDrag > 6000) this.cam.free = false;
    const h = s.hdg * D2R;
    let yaw = this.cam.free ? this.cam.yaw : (this.cam.yaw += angleDiffRad(this.cam.yaw, -h) * Math.min(1, dt * 1.5));
    let dist = this.cam.dist, pitch = this.cam.pitch;
    if (this.cam.mode === 1) { dist = this.cam.dist * 2.2; pitch = 1.1; }
    const pos = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch) * dist, Math.sin(pitch) * dist + 6, Math.cos(yaw) * Math.cos(pitch) * dist).add(target);
    if (this.cam.mode === 2) { // bridge view
      const L = this.myMesh.userData.length; const bp = new THREE.Vector3(0, this.myMesh.userData.freeboard + 16, L * 0.35).applyMatrix4(this.myMesh.matrixWorld);
      this.camera.position.copy(bp); const la = this.cam.free ? -(this.cam.yaw) + Math.PI : h; const look = new THREE.Vector3(Math.sin(la), -0.05, -Math.cos(la)).add(bp); this.camera.lookAt(look); if (this.myMesh.userData.label) this.myMesh.userData.label.visible = false; return;
    }
    if (this.myMesh.userData.label) this.myMesh.userData.label.visible = true;
    const wave = this.ocean.heightAt(pos.x, pos.z, this.time);
    pos.y = Math.max(pos.y, wave + 4);
    this.camera.position.lerp(pos, Math.min(1, dt * 6));
    this.camera.lookAt(target);
  }
  updateDayNight() {
    const dayFrac = (this.simTime % 86400) / 86400; // 0 = midnight
    const elev = Math.sin((dayFrac - 0.25) * Math.PI * 2);
    const az = dayFrac * Math.PI * 2;
    const dir = new THREE.Vector3(Math.cos(az) * Math.cos(Math.asin(THREE.MathUtils.clamp(elev, -1, 1))), Math.max(-0.2, elev), Math.sin(az) * 0.6).normalize();
    const day = THREE.MathUtils.smoothstep(elev, -0.08, 0.25);
    const dusk = Math.exp(-Math.pow((elev - 0.02) / 0.12, 2));
    const top = new THREE.Color(0x101e33).lerp(new THREE.Color(0x3f7fc9), day).lerp(new THREE.Color(0x8c5a6a), dusk * 0.35);
    const hor = new THREE.Color(0x24364d).lerp(new THREE.Color(0xbfd9ee), day).lerp(new THREE.Color(0xf2a860), dusk * 0.7);
    const sunCol = new THREE.Color(0xfff2d0).lerp(new THREE.Color(0xff9a4a), dusk);
    this.sun.position.copy(dir).multiplyScalar(3000).add(this.camera.position); this.sun.target.position.copy(this.camera.position);
    this.sun.intensity = 0.35 + 2.0 * day; this.sun.color.copy(sunCol);
    this.hemi.intensity = 0.45 + 0.6 * day;
    this.sky.material.uniforms.top.value.copy(top); this.sky.material.uniforms.horizon.value.copy(hor); this.sky.material.uniforms.sunDir.value.copy(dir); this.sky.material.uniforms.sunCol.value.copy(sunCol).multiplyScalar(day);
    this.scene.fog.color.copy(hor);
    this.ocean.setSun(dir, sunCol, 1 - day, top, hor);
    const night = 1 - day;
    for (const m of this.harborMeshes.values()) if (m.userData.light) m.userData.light.intensity = 40 * night;
    this.sky.position.copy(this.camera.position);
  }

  // ------------------------------------------------------------------ loop
  loop() {
    requestAnimationFrame(() => this.loop());
    const dt = Math.min(0.25, this.clock.getDelta()); this.time += dt;
    const now = performance.now();
    if (!this.ready || !this.ship) { this.renderer.render(this.scene, this.camera); return; }
    this.simulate(dt);
    this.recentre(false);
    if (now - this.lastTerrainUpdate > 500) { this.lastTerrainUpdate = now; this.terrain.update(this.ship.lat, this.ship.lon); this.updateScenery(); }
    const mp = toLocal(this.ship.lat, this.ship.lon, this.origin);
    if (this.terrain.version !== this.depthVersion) { this.depthVersion = this.terrain.version; this.ocean.rebuildDepth(mp.x, mp.z, (x, z) => this.heightLocal(x, z), true); }
    else this.ocean.rebuildDepth(mp.x, mp.z, (x, z) => this.heightLocal(x, z), false);
    this.ocean.update(this.time, this.camera.position.x, this.camera.position.z, dt);
    this.shipVisual(this.myMesh, this.ship.lat, this.ship.lon, this.ship.hdg, this.ship.spd, this.myVis, this.you.flooding, dt, !!this.you.docked);
    for (const o of this.others.values()) { this.interp(o, now); this.shipVisual(o.mesh, o.cur.lat, o.cur.lon, o.cur.hdg, o.cur.spd, o.vis, o.flooding || 0, dt, !!o.docked); }
    for (const c of this.cutters.values()) { this.interp(c, now); this.shipVisual(c.mesh, c.cur.lat, c.cur.lon, c.cur.hdg, c.cur.spd, c.vis, 0, dt, false); if (c.mesh.userData.beacon) c.mesh.userData.beacon.material.emissiveIntensity = c.state === 'patrol' ? 0.5 : 2 + 2 * Math.sin(this.time * 12); }
    this.updateCamera(dt);
    this.updateDayNight();
    this.renderer.render(this.scene, this.camera);
    // HUD
    if (now - this.lastTelemetry > 120) { this.lastTelemetry = now; this.updateHud(now); }
    if (now - this.lastRadar > 100) { this.lastRadar = now; this.drawRadar(now); }
    this.hud.tickLog(now); this.hud.updateHail(this.you, Date.now());
  }
  updateHud(now) {
    const s = this.ship, you = this.you, C = SHIP_CLASSES[s.cls];
    const h = this.terrain.heightAt(s.lat, s.lon);
    const cur = currentAt(s.lat, s.lon, this.simTime);
    let nearest = null, nd = Infinity;
    for (const hb of this.world.harbors) { const d = haversine(s.lat, s.lon, hb.lat, hb.lon); if (d < nd) { nd = d; nearest = hb; } }
    const dockable = nearest && nd / GEO.SCALE <= INTERACT.DOCK_RADIUS_U;
    if (dockable && !you.docked) this.hud.alert('dock', `${nearest.name}: in docking range — press T (under 3 kn)`, 'warn'); else this.hud.clearAlert('dock');
    let wp = null;
    if (this.waypoint) { const d = haversine(s.lat, s.lon, this.waypoint.lat, this.waypoint.lon); const v = Math.abs(s.spd) * GEO.KN_TO_MS * SIM.MOTION_SCALE; wp = { dist: fmtDistance(d), brg: bearing(s.lat, s.lon, this.waypoint.lat, this.waypoint.lon), eta: v > 0.5 ? fmtTime(d / v) : '—' }; }
    this.hud.updateTelemetry(s, {
      depth: h == null ? null : -h, draft: C.draft, current: { set: normDeg((Math.atan2(cur.u, cur.v) * 180) / Math.PI), drift: Math.hypot(cur.u, cur.v) / GEO.KN_TO_MS }, flooding: you.flooding,
      nearest: nearest ? { name: nearest.name, dist: fmtDistance(nd) } : null, wp, autopilot: this.autopilot, jobs: you.jobs.length,
      status: you.docked ? 'docked' : you.fuelEmpty ? 'NO FUEL' : you.fishing ? 'fishing' : you.hail ? 'HAILED' : 'at sea',
    });
    this.hud.updateTop(you, { simTime: this.simTime, wind: this.wind }, this.others.size + 1, this.net.latency);
    if (you.fuelEmpty) this.hud.alert('fuel', 'OUT OF FUEL — drifting. Call a tow or wait for help.', ''); else this.hud.clearAlert('fuel');
    if (you.flooding > 0.05 && you.flooding < 1) this.hud.alert('flood', `TAKING ON WATER ${Math.round(you.flooding * 100)} % — use a kit (K) or make harbour`, ''); else this.hud.clearAlert('flood');
    if (this.hud.chartOpen() && now - (this.lastChart || 0) > 1000) { this.lastChart = now; this.hud.drawChart(); }
  }
  drawRadar(now) {
    const s = this.ship, contacts = [];
    for (const h of this.world.harbors) contacts.push({ kind: 'harbor', lat: h.lat, lon: h.lon, color: '#58d68d', label: h.name.split(' (')[0], size: h.size });
    for (const g of this.world.fishing) contacts.push({ kind: 'ground', lat: g.lat, lon: g.lon, color: 'rgba(120,200,255,0.8)', radiusU: (g.radiusKm * 1000) / GEO.SCALE });
    for (const w of this.wrecks) contacts.push({ kind: 'wreck', lat: w.lat, lon: w.lon, color: '#bbb' });
    for (const c of this.cutters.values()) contacts.push({ kind: 'cutter', lat: c.cur.lat, lon: c.cur.lon, color: c.state === 'patrol' ? '#ff6b6b' : '#ff2020' });
    for (const o of this.others.values()) contacts.push({ kind: 'ship', lat: o.cur.lat, lon: o.cur.lon, hdg: o.cur.hdg, color: o.convoyId && o.convoyId === this.you?.convoyId ? '#5ad6ff' : o.wanted ? '#ffb070' : '#ffffff', label: o.name });
    if (this.waypoint) contacts.push({ kind: 'wp', lat: this.waypoint.lat, lon: this.waypoint.lon, color: '#f2b134' });
    this.hud.drawRadar(s, contacts, now);
  }
}

function angleDiffRad(a, b) { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; }
function fmtTime(sec) { const m = Math.round(sec / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`; }

window.app = new App();
