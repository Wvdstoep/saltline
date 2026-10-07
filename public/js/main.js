// Saltline client: scene, floating origin, local ship simulation, networking glue, camera, day/night, HUD loop.
// v0.3 (docs/V3-CONTRACTS.md §5): harbour geometry + patch terrain + collision, tide/weather, AI traffic, rescues,
// offshore platforms, walkable interior, multi-waypoint routes, touch helm, sails, wakes, buoys.
import * as THREE from 'three';
import { GEO, SIM, SHIP_CLASSES, INTERACT, LAYERS } from '/shared/constants.js';
import { toLocal, fromLocal, haversine, bearing, unitsBetween, angleDiff, normDeg, fmtDistance } from '/shared/geo.js';
import { stepShip, currentAt } from '/shared/physics.js';
import { Net } from './net.js';
import { Ocean } from './ocean.js';
import { Terrain, VSCALE } from './terrain.js';
import * as ShipMod from './ship.js';
import * as HarborMod from './harbor.js';
import { Hud } from './hud.js';
import { HarborGeomSet } from './harborgeom.js';
import { resolveShip } from './collision.js';
import { Interior } from './interior.js';
import { WeatherFX } from './weather.js';
import { TouchHelm, isTouch } from './touch.js';

const { buildShip, buildWreck } = ShipMod;
const { buildHarbor, buildFishingMarker } = HarborMod;
const D2R = Math.PI / 180;
const GEOM_LOAD_M = 12000, GEOM_UNLOAD_M = 16000, GEOM_RETRY_MS = 120000;
const SCENERY_LOAD_M = 11000, SCENERY_UNLOAD_M = 13000;
const PLATFORM_LOAD_M = 15000, PLATFORM_UNLOAD_M = 18000;
const COLLISION_RATE_MS = 3000;
const ANCHOR_ORIGIN_M = 5000; // keep the floating origin on a harbour's own origin while this close, so patch, scenery and ship agree to the metre
const CUTTER_DIMS = { length: 28, beam: 6.5 };

class App {
  constructor() {
    this.canvas = document.getElementById('view');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.0;
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0xbfd9ee, 3000, 15000);
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.5, 40000);
    this.sun = new THREE.DirectionalLight(0xfff2d0, 2.2); this.scene.add(this.sun); this.scene.add(this.sun.target);
    this.hemi = new THREE.HemisphereLight(0x9fc4e8, 0x3a4a3a, 0.9); this.scene.add(this.hemi);
    this.sky = this.makeSky();
    this.ocean = new Ocean(this.scene);
    this.terrain = new Terrain(this.scene);
    this.geoms = new HarborGeomSet(); this.geomState = new Map(); // harbour id -> { state: 'loading'|'loaded'|'failed', t }
    this.weatherFx = new WeatherFX(this.scene, this.camera);
    this.origin = { lat: 52, lon: 4 };
    this.net = new Net({ status: (s) => this.onStatus(s), message: (m) => this.onMessage(m) });
    this.hud = new Hud(this);
    this.you = null; this.world = { harbors: [], fishing: [], platforms: [] }; this.ship = null; this.simTime = 0; this.wind = { u: 0, v: 0, spd: 5, dir: 240 };
    this.wx = null; this.tide = null; this.tideLevel = 0; this.localWind = null; this.storms = []; this.night = 0; this.lightning = 0; this.fogFar = 15000;
    this.others = new Map(); this.cutters = new Map(); this.ai = new Map(); this.rescues = new Map(); this.wrecks = []; this.wreckMeshes = new Map();
    this.harborMeshes = new Map(); this.groundMeshes = new Map(); this.platformMeshes = new Map();
    this.myMesh = null; this.myVis = { heave: 0, pitch: 0, roll: 0 }; this.raft = null; this.selfSamples = [];
    this.input = { throttleCmd: 0, rudderCmd: 0, left: false, right: false, up: false, down: false, rudderHold: false };
    this.cam = { yaw: 0, pitch: 0.28, dist: 260, free: false, mode: 0 };
    this.route = []; this.autopilot = false;
    this.lastGrounding = 0; this.lastCollision = 0; this.clock = new THREE.Clock(); this.time = 0; this.started = false; this.lastSend = 0;
    this.lastTerrainUpdate = 0; this.lastRadar = 0; this.lastTelemetry = 0; this.lastSails = 0; this.ready = false;
    this.interior = new Interior(this);
    this.touchHelm = null;
    window.addEventListener('resize', () => this.resize()); this.resize();
    this.bindInput();
    this.net.connect('');
    requestAnimationFrame(() => this.loop());
  }
  resize() { const w = innerWidth, h = innerHeight; this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); }
  makeSky() {
    const geo = new THREE.SphereGeometry(30000, 24, 12);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new THREE.Color(0x3f7fc9) }, horizon: { value: new THREE.Color(0xbfd9ee) }, sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunCol: { value: new THREE.Color(0xfff0c0) } },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; uniform vec3 sunCol; varying vec3 vDir;
        void main(){ float t = clamp(vDir.y, -0.1, 1.0); vec3 c = mix(horizon, top, pow(max(0.0,t), 0.55)); float s = max(0.0, dot(normalize(vDir), sunDir));
        c += sunCol * (pow(s, 600.0) * 1.5 + pow(s, 8.0) * 0.12); if (vDir.y < 0.0) c = mix(c, horizon * 0.55, min(1.0, -vDir.y * 8.0)); gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        }`,
    });
    const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; this.scene.add(m); return m;
  }
  // The single waypoint API of v0.2 maps onto the head of the route (chart, radar and old callers keep working).
  get waypoint() { return this.route[0] || null; }
  set waypoint(v) { this.route = v ? [{ lat: v.lat, lon: v.lon }] : []; }

  // ------------------------------------------------------------------ networking
  onStatus(s) {
    this.hud.setStatus(s === 'connected' ? 'Connected to the shard.' : s === 'replaced' ? 'This skipper logged in from another tab. Set sail again to take the helm back here.' : 'Disconnected — reconnecting…');
    this.hud.setConn(s);
    if (s === 'replaced') { this.started = false; this.hud.showWelcome(true); return; } // the socket is dead for good: bring the login card back
    if (s === 'connected' && this.pendingName != null) { const n = this.pendingName; this.pendingName = null; this.start(n); return; }
    if (s === 'connected' && this.started) this.net.send({ t: 'hello', token: this.net.token, name: this.net.name });
  }
  start(name) {
    if (!this.net.connected) { this.pendingName = name; this.hud.setStatus('Connecting… you will set sail as soon as the shard answers.'); this.net.connect(name); return; }
    try { localStorage.setItem('saltline.name', name); } catch {}
    this.started = true; this.net.name = name;
    this.net.send({ t: 'hello', token: this.net.token, name });
    this.hud.showWelcome(false);
    this.touchHelm?.show?.(true);
  }
  onMessage(m) {
    switch (m.t) {
      case 'welcome': this.onWelcome(m); break;
      case 'snap': this.onSnap(m); break;
      case 'you': this.onYou(m.you, false, !!m.correction); break;
      case 'event': this.hud.event(m); if (m.kind === 'law' || m.kind === 'pirate') this.flash(); break;
      case 'harbor': this.hud.showHarbor(m.harbor); break;
      case 'chat': this.hud.chat(m); break;
      case 'join': this.hud.event({ kind: 'info', text: `${m.player.name} came online.` }); break;
      case 'leave': { const o = this.others.get(m.id); if (o) { this.hud.event({ kind: 'info', text: `${o.name} went offline.` }); this.drop(o.mesh); this.others.delete(m.id); } break; }
      case 'rename': { const o = this.others.get(m.id); if (o) { o.name = m.name; o.mesh.userData.label?.userData.setText(m.name); } break; }
      case 'wrecks': this.wrecks = m.wrecks; this.syncWrecks(); break;
      case 'trade': this.hud.prompt(m.offer.id, `<b>${m.offer.fromName}</b> offers <b>${m.offer.qty} t ${m.offer.goodName}</b>${m.offer.contraband ? ' <span class="pill bad">contraband</span>' : ''} for <b>${m.offer.price.toLocaleString()} cr</b>.`, [{ label: 'Accept', primary: true, fn: () => this.net.action('trade_accept', { offerId: m.offer.id }) }, { label: 'Decline', fn: () => this.net.action('trade_decline', { offerId: m.offer.id }) }]); break;
      case 'convoy_invite': this.hud.prompt(m.convoyId, `<b>${m.from}</b> invites you to form a convoy. Escorts halve pirates' boarding odds.`, [{ label: 'Join', primary: true, fn: () => this.net.action('convoy_accept', { convoyId: m.convoyId }) }, { label: 'No', fn: () => {} }]); break;
    }
  }
  onWelcome(m) {
    this.world = { platforms: [], ...m.world }; this.wrecks = m.wrecks; this.simTime = m.simTime;
    if (m.storms) this.storms = m.storms;
    this.onYou(m.you, true);
    for (const l of m.log || []) this.hud.event(l);
    for (const p of m.players) this.upsertOther(p, performance.now());
    for (const c of m.cutters) this.upsertCutter(c, performance.now());
    if (m.rescues) this.syncRescues(m.rescues, performance.now());
    this.syncWrecks();
    this.ready = true;
    if (!this.started) this.hud.setStatus('Connected. Pick a name and set sail.');
  }
  // `correction` is set by the server when it rejected / moved our position: always snap to its ship then, otherwise
  // the two sides disagree forever (the server keeps rejecting every state sent from the stale client position).
  onYou(you, first, correction) {
    const prev = this.you;
    this.you = you;
    const s = you.ship;
    const hard = !this.ship || first || !prev || prev.ship.cls !== s.cls || !!prev.docked !== !!you.docked || (!you.assist && unitsBetween(this.ship.lat, this.ship.lon, s.lat, s.lon) > 400);
    if (hard || (correction && !you.assist)) {
      // a plain correction is a few hundred metres: keep the helm commands and do not force a frame rebuild
      this.ship = { ...s, throttleCmd: hard ? s.throttle : this.input.throttleCmd, rudderCmd: hard ? 0 : this.input.rudderCmd };
      if (hard) { this.input.throttleCmd = you.docked ? 0 : s.throttle; this.input.rudderCmd = 0; this.selfSamples = []; }
      if (!this.myMesh || prev?.ship.cls !== s.cls) {
        if (this.myMesh) { if (this.interior.active) this.interior.exit(); this.drop(this.myMesh); }
        this.myMesh = buildShip(s.cls, you.name, 7); this.scene.add(this.myMesh);
        this.hud.setSailsButton?.(!!SHIP_CLASSES[s.cls]?.sail, you.sailsUp !== false);
      }
      this.recentre(hard);
    }
    if (prev && prev.docked && !you.docked) { this.hud.hideHarbor(); }
    if (!prev?.docked && you.docked) { this.input.throttleCmd = 0; this.input.rudderCmd = 0; this.autopilot = false; this.touchHelm?.setThrottle?.(0); }
    if (!prev?.assist && you.assist) { this.input.throttleCmd = 0; this.input.rudderCmd = 0; this.autopilot = false; this.touchHelm?.setThrottle?.(0); }
    if (prev?.name !== you.name) this.myMesh?.userData.label?.userData.setText(you.name);
    this.myMesh?.userData.setWear(1 - you.cond / 100); this.myMesh?.userData.setFlood(you.flooding);
    if (prev?.sailsUp !== you.sailsUp) { this.hud.setSailsButton?.(!!SHIP_CLASSES[s.cls]?.sail, you.sailsUp !== false); this.lastSails = 0; }
    // environment: tide level + stream, local weather for sea state / particles / fog
    if (you.tide) { this.tide = you.tide; this.tideLevel = Number(you.tide.height) || 0; this.ocean.setLevel?.(this.tideLevel); }
    if (you.weather) this.applyWeather(you.weather);
    if (you.rescue && !prev?.rescue) { this.cam.free = false; this.hud.event({ kind: 'warn', text: 'You are in the life raft. Hold on — help is on the way.' }); }
    if (this.hud.harborOpen()) {
      // 'you' arrives every second while docked: only rebuild the panel when something it shows actually changed
      // (or a rebuild was deferred because the player was typing in it); the 'harbor' message re-renders on its own.
      const key = [you.money, you.fuel, you.cond, you.flooding, you.kits, you.ship.cls, JSON.stringify(you.cargo), JSON.stringify(you.jobs), you.convoy?.members?.length ?? 0, you.serviceDue ?? 0, you.berth?.id ?? ''].join('|');
      if (key !== this.lastHarborKey || this.hud.harborDirty) { this.lastHarborKey = key; this.hud.renderHarborTabs(); }
    }
  }
  applyWeather(w) {
    this.wx = w;
    const spd = Number(w.windSpd) || 0, dir = Number(w.windDir) || 0;
    this.localWind = { spd, dir, u: -Math.sin(dir * D2R) * spd, v: -Math.cos(dir * D2R) * spd, gust: w.gust };
    this.ocean.setWind(spd);
    this.ocean.setSea?.({ windSpd: spd, windDir: dir, waveH: w.waveH ?? Math.min(6, (w.sea || 0) * 6), waveDir: w.waveDir ?? dir, wavePeriod: w.wavePeriod ?? 3 + 0.6 * spd, swellH: w.swellH ?? 0, swellDir: w.swellDir ?? dir, swellPeriod: w.swellPeriod ?? 9 });
    this.ocean.setRain?.(w.rain || 0);
    const vis = Number.isFinite(w.visibility) ? w.visibility : (w.storm || 0) > 0.5 ? 4000 : 20000;
    this.fogFar = THREE.MathUtils.clamp(vis, 500, 24000);
    this.weatherFx.set?.({ rain: w.rain || 0, storm: w.storm || 0, cloud: w.cloud ?? Math.min(1, 0.3 + (w.storm || 0)), visibility: vis, windSpd: spd, windDir: dir, night: this.night });
  }
  onSnap(m) {
    const now = performance.now();
    this.simTime = m.simTime; this.wind = m.wind; if (!this.localWind) this.ocean.setWind(m.wind.spd);
    if (m.storms) this.storms = m.storms;
    if (Number.isFinite(m.time)) { // server clock offset (ms) for countdowns that compare against server timestamps
      const off = m.time - Date.now();
      this.clockOffset = this.clockOffset == null || Math.abs(off - this.clockOffset) > 2000 ? off : this.clockOffset + (off - this.clockOffset) * 0.1;
    }
    const seen = new Set();
    for (const p of m.players) {
      if (p.id === this.you?.id) { this.selfSamples.push({ t: now, lat: p.lat, lon: p.lon, hdg: p.hdg, spd: p.spd }); if (this.selfSamples.length > 4) this.selfSamples.shift(); continue; }
      seen.add(p.id); this.upsertOther(p, now);
    }
    for (const [id, o] of this.others) if (!seen.has(id)) { this.drop(o.mesh); this.others.delete(id); }
    for (const c of m.cutters) this.upsertCutter(c, now);
    if (Array.isArray(m.ai)) {
      const seenAi = new Set();
      for (const a of m.ai) { seenAi.add(a.id); this.upsertAi(a, now); }
      for (const [id, o] of this.ai) if (!seenAi.has(id)) { this.drop(o.mesh); this.ai.delete(id); }
    }
    if (Array.isArray(m.rescues)) this.syncRescues(m.rescues, now);
  }
  /** Remove a ship / harbour / wreck / marker group from the scene and free its GPU resources. */
  drop(obj) { if (!obj) return; this.scene.remove(obj); if (obj.userData.wakeGroup?.parent) obj.userData.wakeGroup.parent.remove(obj.userData.wakeGroup); obj.userData.dispose?.(); }
  upsertOther(p, now) {
    let o = this.others.get(p.id);
    if (!o) {
      o = { id: p.id, name: p.name, cls: p.cls, mesh: buildShip(p.cls, p.name, p.id.charCodeAt(0)), samples: [], cur: { lat: p.lat, lon: p.lon, hdg: p.hdg, spd: p.spd }, vis: { heave: 0, pitch: 0, roll: 0 } };
      this.scene.add(o.mesh); this.others.set(p.id, o);
    } else if (o.cls !== p.cls) { this.drop(o.mesh); o.cls = p.cls; o.mesh = buildShip(p.cls, p.name, 3); this.scene.add(o.mesh); }
    Object.assign(o, { name: p.name, cond: p.cond, flooding: p.flooding, convoyId: p.convoyId, wanted: p.wanted, docked: p.docked, sinking: p.sinking, towing: p.towing, offline: p.offline });
    o.samples.push({ t: now, lat: p.lat, lon: p.lon, hdg: p.hdg, spd: p.spd }); if (o.samples.length > 4) o.samples.shift();
    o.mesh.userData.setWear(1 - p.cond / 100); o.mesh.userData.setFlood(p.flooding);
  }
  upsertCutter(c, now) {
    let o = this.cutters.get(c.id);
    if (!o) { o = { id: c.id, name: c.name, cls: 'cutter', mesh: buildShip('cutter', c.name, 11), samples: [], cur: { lat: c.lat, lon: c.lon, hdg: c.hdg, spd: c.spd }, vis: { heave: 0, pitch: 0, roll: 0 } }; this.scene.add(o.mesh); this.cutters.set(c.id, o); }
    o.state = c.state; o.targetId = c.targetId;
    o.samples.push({ t: now, lat: c.lat, lon: c.lon, hdg: c.hdg, spd: c.spd }); if (o.samples.length > 4) o.samples.shift();
  }
  /** AI traffic from snap.ai (AiPublic): rendered and interpolated like other players, labelled 'name · destination'. */
  upsertAi(a, now) {
    let o = this.ai.get(a.id);
    const label = `${a.name} · ${a.destName || a.dest || '—'}`;
    if (!o) {
      o = { id: a.id, name: a.name, cls: SHIP_CLASSES[a.cls] ? a.cls : 'coaster', mesh: buildShip(SHIP_CLASSES[a.cls] ? a.cls : 'coaster', label, hashStr(a.id) % 97 + 1), samples: [], cur: { lat: a.lat, lon: a.lon, hdg: a.hdg, spd: a.spd }, vis: { heave: 0, pitch: 0, roll: 0 }, label };
      this.scene.add(o.mesh); this.ai.set(a.id, o);
    } else if (o.cls !== a.cls && SHIP_CLASSES[a.cls]) { this.drop(o.mesh); o.cls = a.cls; o.mesh = buildShip(a.cls, label, 5); this.scene.add(o.mesh); }
    if (o.label !== label) { o.label = label; o.mesh.userData.label?.userData.setText(label); }
    Object.assign(o, { name: a.name, flag: a.flag, dest: a.dest, destName: a.destName, state: a.state, eta: a.eta });
    o.samples.push({ t: now, lat: a.lat, lon: a.lon, hdg: a.hdg, spd: a.spd }); if (o.samples.length > 4) o.samples.shift();
  }
  /** SAR craft from snap.rescues: lifeboats ride the sea, helicopters fly at 60 m. */
  syncRescues(list, now) {
    const seen = new Set();
    for (const r of list) {
      seen.add(r.id);
      let o = this.rescues.get(r.id);
      if (!o) {
        const mesh = ShipMod.buildRescue?.(r.kind) || buildShip('pilot', r.kind === 'helicopter' ? 'SAR helicopter' : 'Lifeboat', 9);
        o = { id: r.id, kind: r.kind, mesh, samples: [], cur: { lat: r.lat, lon: r.lon, hdg: r.hdg, spd: r.kind === 'helicopter' ? 150 : 25 }, vis: { heave: 0, pitch: 0, roll: 0 }, playerName: r.playerName };
        this.scene.add(mesh); this.rescues.set(r.id, o);
      }
      o.state = r.state;
      o.samples.push({ t: now, lat: r.lat, lon: r.lon, hdg: r.hdg, spd: o.cur.spd }); if (o.samples.length > 4) o.samples.shift();
    }
    for (const [id, o] of this.rescues) if (!seen.has(id)) { this.drop(o.mesh); this.rescues.delete(id); }
  }
  syncWrecks() {
    const ids = new Set(this.wrecks.map((w) => w.id));
    for (const [id, m] of this.wreckMeshes) if (!ids.has(id)) { this.drop(m); this.wreckMeshes.delete(id); }
    for (const w of this.wrecks) if (!this.wreckMeshes.has(w.id)) { const m = buildWreck(w.cls); this.place(m, w.lat, w.lon, -2); this.scene.add(m); this.wreckMeshes.set(w.id, m); }
  }

  // ------------------------------------------------------------------ world placement
  /** The origin of a loaded harbour patch within ANCHOR_ORIGIN_M of the ship, if any: the floating origin sits there. */
  anchorOrigin() {
    if (!this.ship || !this.geoms.size) return null;
    let best = null, bd = ANCHOR_ORIGIN_M;
    for (const e of this.geoms.entries.values()) { const d = unitsBetween(this.ship.lat, this.ship.lon, e.origin.lat, e.origin.lon); if (d < bd) { bd = d; best = e.origin; } }
    return best;
  }
  recentre(force) {
    if (!this.ship) return;
    const want = this.anchorOrigin();
    let target;
    if (want) { if (!force && this.origin.lat === want.lat && this.origin.lon === want.lon) return; target = { lat: want.lat, lon: want.lon }; }
    else {
      const p = toLocal(this.ship.lat, this.ship.lon, this.origin);
      if (!force && Math.hypot(p.x, p.z) < SIM.ORIGIN_RESHIFT_UNITS) return;
      target = { lat: this.ship.lat, lon: this.ship.lon };
    }
    const p = toLocal(target.lat, target.lon, this.origin); // = the new origin expressed in the old frame
    this.origin = target;
    // Everything cached in the old frame shifts by -p so there is no frame of nothing: the camera keeps its offset
    // from the ship, and scenery is re-placed instead of thrown away and rebuilt 500 ms later.
    this.camera.position.x -= p.x; this.camera.position.z -= p.z;
    this.terrain.setOrigin(this.origin);
    const mp = toLocal(this.ship.lat, this.ship.lon, this.origin);
    this.ocean.rebuildDepth(mp.x, mp.z, (x, z) => this.heightLocal(x, z), true);
    for (const [id, m] of this.harborMeshes) { const at = m.userData.placeAt; if (at) this.place(m, at.lat, at.lon); else { this.drop(m); this.harborMeshes.delete(id); } }
    for (const [id, m] of this.groundMeshes) { const g = this.world.fishing.find((x) => x.id === id); if (g) this.place(m, g.lat, g.lon); else { this.drop(m); this.groundMeshes.delete(id); } }
    for (const [id, m] of this.platformMeshes) { if (!m) continue; const pl = (this.world.platforms || []).find((x) => x.id === id); if (pl) this.place(m, pl.lat, pl.lon); else { this.drop(m); this.platformMeshes.delete(id); } }
    for (const w of this.wrecks) { const m = this.wreckMeshes.get(w.id); if (m) this.place(m, w.lat, w.lon, -2); }
    for (const o of [...this.others.values(), ...this.cutters.values(), ...this.ai.values(), ...this.rescues.values()]) { const wg = o.mesh.userData.wakeGroup; if (wg) wg.position.set(wg.position.x - p.x, wg.position.y, wg.position.z - p.z); }
    if (this.myMesh?.userData.wakeGroup) { const wg = this.myMesh.userData.wakeGroup; wg.position.set(wg.position.x - p.x, wg.position.y, wg.position.z - p.z); }
  }
  heightLocal(x, z) { const ll = fromLocal(x, z, this.origin); return this.terrain.heightAt(ll.lat, ll.lon); }
  place(obj, lat, lon, y = 0) { const p = toLocal(lat, lon, this.origin); obj.position.set(p.x, y, p.z); return p; }
  inRegion() { const s = this.ship; if (!s) return false; const d = LAYERS[1]; return s.lat >= d.latMin && s.lat < d.latMax && s.lon >= d.lonMin && s.lon < d.lonMax; }
  /** Harbour anchor (guaranteed water) when its geometry is loaded, else the harbour point. */
  harborAnchor(h) { const e = this.geoms.get(h.id); return e?.geom?.anchor || h; }
  updateScenery() {
    const s = this.ship; if (!s) return;
    const now = performance.now();
    for (const h of this.world.harbors) {
      const d = unitsBetween(s.lat, s.lon, h.lat, h.lon);
      // high-resolution geometry: load within 12 km, unload beyond 16 km, retry a failed build every 2 minutes
      const gs = this.geomState.get(h.id);
      if (d < GEOM_LOAD_M && !this.geoms.has(h.id) && !this.geoms.isLoading(h.id) && (!gs || gs.state !== 'failed' || now - gs.t > GEOM_RETRY_MS)) this.loadGeom(h);
      else if (d > GEOM_UNLOAD_M && (this.geoms.has(h.id) || this.geoms.isLoading(h.id))) this.unloadGeom(h.id);
      // scenery: legacy compact harbour at the harbour point until the geometry arrives, then the real one at its origin
      const entry = this.geoms.get(h.id);
      const has = this.harborMeshes.get(h.id);
      if (d < SCENERY_LOAD_M) {
        const wantGeom = entry ? entry.id : null;
        if (!has || has.userData.geomId !== wantGeom) {
          if (has) { this.drop(has); this.harborMeshes.delete(h.id); }
          let m = null;
          try { m = buildHarbor(h, entry ? entry.geom : null); } catch (e) { console.warn('[harbor] build failed', h.id, e); }
          if (m) {
            const at = entry ? { lat: entry.geom.origin.lat, lon: entry.geom.origin.lon } : { lat: h.lat, lon: h.lon };
            m.userData.geomId = wantGeom; m.userData.placeAt = at;
            this.place(m, at.lat, at.lon); this.scene.add(m); this.harborMeshes.set(h.id, m);
            m.userData.setNight?.(this.night, this.time);
          }
        }
      } else if (d > SCENERY_UNLOAD_M && has) { this.drop(has); this.harborMeshes.delete(h.id); }
    }
    for (const g of this.world.fishing) {
      const d = unitsBetween(s.lat, s.lon, g.lat, g.lon);
      const has = this.groundMeshes.has(g.id);
      if (d < 9000 && !has) { const m = buildFishingMarker(g); this.place(m, g.lat, g.lon); this.scene.add(m); this.groundMeshes.set(g.id, m); }
      else if (d > 11000 && has) { this.drop(this.groundMeshes.get(g.id)); this.groundMeshes.delete(g.id); }
    }
    for (const pl of this.world.platforms || []) {
      const d = unitsBetween(s.lat, s.lon, pl.lat, pl.lon);
      const has = this.platformMeshes.has(pl.id);
      if (d < PLATFORM_LOAD_M && !has) {
        let m = null;
        try { m = (HarborMod.buildPlatform || ShipMod.buildPlatform)?.(pl) || null; } catch (e) { console.warn('[platform] build failed', pl.id, e); }
        if (m) { this.place(m, pl.lat, pl.lon); this.scene.add(m); }
        this.platformMeshes.set(pl.id, m); // null = builder not available yet: do not retry every tick
      } else if (d > PLATFORM_UNLOAD_M && has) { this.drop(this.platformMeshes.get(pl.id)); this.platformMeshes.delete(pl.id); }
    }
    for (const w of this.wrecks) { const m = this.wreckMeshes.get(w.id); if (m) this.place(m, w.lat, w.lon, -2); }
    const cam = this.camera.position;
    for (const m of this.harborMeshes.values()) { const l = m.children.find((c) => c.isSprite); if (l) l.visible = m.position.distanceTo(cam) < 3200; }
    for (const m of this.groundMeshes.values()) { const l = m.children.find((c) => c.isSprite); if (l) l.visible = m.position.distanceTo(cam) < 3200; }
  }
  loadGeom(h) {
    this.geomState.set(h.id, { state: 'loading', t: performance.now() });
    this.geoms.load(h.id).then((entry) => {
      const st = this.geomState.get(h.id);
      if (!entry) { if (st?.state === 'loading') this.geomState.set(h.id, { state: 'failed', t: performance.now() }); return; }
      this.geomState.set(h.id, { state: 'loaded', t: performance.now() });
      this.terrain.addPatch(entry);
      console.info(`[geom] ${h.id}: ${entry.geom.source || (entry.synthetic ? 'synthetic' : 'osm')} patch ${entry.n}×${entry.res} m, ${entry.geom.berths?.length || 0} berths`);
      this.recentre(false);
      this.updateScenery();
    }).catch((e) => { console.warn('[geom] load error', h.id, e); this.geomState.set(h.id, { state: 'failed', t: performance.now() }); });
  }
  unloadGeom(id) { this.geoms.unload(id); this.terrain.removePatch(id); this.geomState.delete(id); }

  // ------------------------------------------------------------------ input
  bindInput() {
    const typing = () => document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA');
    window.addEventListener('keydown', (e) => {
      if (!this.started) return;
      if (typing()) return;
      const k = e.key.toLowerCase();
      if (k === 'enter') { document.getElementById('chatInput')?.focus(); e.preventDefault(); return; }
      if (k === 'escape') {
        if (this.interior.active && this.interior.handleKey(e)) return;
        if (this.hud.transientOpen()) this.hud.closeOverlays(); else if (this.hud.harborOpen()) this.hud.hideHarbor(); return; // chart/ships/help first, harbour panel next
      }
      if (k === 'i') return this.toggleInterior();
      if (this.interior.active && this.interior.handleKey(e)) return;
      if (k === 'm') return this.hud.toggleChart();
      if (k === 'tab') { e.preventDefault(); return this.hud.toggleShips(); }
      if (k === 'h') return document.getElementById('helpWrap')?.classList.toggle('hidden');
      if (k === 'r' && this.hud.chartOpen()) { this.hud.chartMode = this.hud.chartMode === 'region' ? 'world' : 'region'; this.hud.drawChart(); return; }
      if (k === 't') return this.toggleDock();
      if (k === 'f') return this.net.action('fish', { on: !this.you?.fishing });
      if (k === 'k') return this.net.action('patch');
      if (k === 'p') return this.toggleAutopilot();
      if (k === 'c') { if (!this.interior.active) this.cam.mode = (this.cam.mode + 1) % 3; return; }
      if (k === 'x') { this.clearRoute(); return; }
      if (k === 'n') return this.requestTugs();
      if (this.you?.docked || this.you?.assist) return;
      if (k === 'w' || k === 'arrowup') this.nudgeThrottle(0.1);
      if (k === 's' || k === 'arrowdown') this.nudgeThrottle(-0.1);
      if (k === 'a' || k === 'arrowleft') { this.input.left = true; this.autopilot = false; }
      if (k === 'd' || k === 'arrowright') { this.input.right = true; this.autopilot = false; }
      if (k === ' ') { this.input.rudderCmd = 0; this.input.throttleCmd = 0; this.touchHelm?.setThrottle?.(0); this.touchHelm?.setRudder?.(0); e.preventDefault(); }
      if (k === 'b') this.boardNearest();
      if (k === 'v') this.salvageNearest();
    });
    window.addEventListener('keyup', (e) => { const k = e.key.toLowerCase(); if (k === 'a' || k === 'arrowleft') this.input.left = false; if (k === 'd' || k === 'arrowright') this.input.right = false; });
    // camera: one-pointer drag orbits (mouse or finger), two fingers pinch to zoom, wheel zooms
    const pointers = new Map();
    let pinch = null;
    this.canvas.addEventListener('pointerdown', (e) => {
      if (this.interior.active) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { this.canvas.setPointerCapture(e.pointerId); } catch {}
      if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), dist: this.cam.dist }; }
    });
    this.canvas.addEventListener('pointermove', (e) => {
      const pt = pointers.get(e.pointerId); if (!pt || this.interior.active) return;
      if (pointers.size >= 2 && pinch) {
        pt.x = e.clientX; pt.y = e.clientY;
        const [a, b] = [...pointers.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d > 10) this.cam.dist = THREE.MathUtils.clamp((pinch.dist * pinch.d) / d, 60, 1800);
        return;
      }
      const dx = e.clientX - pt.x, dy = e.clientY - pt.y;
      if (this.cam.mode === 2) this.cam.look = (this.cam.look || 0) + dx * 0.006; // bridge view: look around relative to the bow
      else this.cam.yaw -= dx * 0.006;
      this.cam.pitch = THREE.MathUtils.clamp(this.cam.pitch + dy * 0.004, 0.05, 1.3); this.cam.free = true; this.cam.lastDrag = performance.now();
      pt.x = e.clientX; pt.y = e.clientY;
    });
    const endPointer = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; };
    this.canvas.addEventListener('pointerup', endPointer);
    this.canvas.addEventListener('pointercancel', endPointer);
    this.canvas.addEventListener('lostpointercapture', endPointer);
    this.canvas.addEventListener('wheel', (e) => { if (this.interior.active) return; this.cam.dist = THREE.MathUtils.clamp(this.cam.dist * (1 + Math.sign(e.deltaY) * 0.12), 60, 1800); e.preventDefault(); }, { passive: false });
    // A key held while focus leaves the page never gets its keyup (alt-tab, confirm() dialogs): release everything.
    const reset = () => { this.releaseControls(); pointers.clear(); pinch = null; };
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', () => { if (document.hidden) reset(); });
    // buttons that C2 may add to the DOM (bound with onclick so a HUD binding of the same button never double-fires)
    const btn = (id, fn) => { const b = document.getElementById(id); if (b) b.onclick = fn; };
    btn('btnInterior', () => this.toggleInterior());
    btn('btnSails', () => this.setSails(!(this.you?.sailsUp !== false)));
    btn('btnTugs', () => this.requestTugs());
    btn('btnMoor', () => this.toggleDock());
    this.bindTouch();
  }
  nudgeThrottle(d) { if (this.you?.docked || this.you?.assist) return; this.input.throttleCmd = THREE.MathUtils.clamp(Math.round((this.input.throttleCmd + d) * 10) / 10, -0.3, 1); this.touchHelm?.setThrottle?.(this.input.throttleCmd); }
  releaseControls() { this.input.left = this.input.right = false; for (const id of ['tchPort', 'tchStbd']) document.getElementById(id)?.classList.remove('on'); }
  /** Touch devices: the TouchHelm sliders (C2) drive the same input state as the keys; the v0.2 hold buttons keep working too. */
  bindTouch() {
    if (!isTouch()) return;
    document.body.classList.add('touch');
    try {
      const root = document.getElementById('touchHelm') || document.getElementById('hud') || document.body;
      this.touchHelm = new TouchHelm(root, {
        onThrottle: (v) => { if (this.you?.docked || this.you?.assist) return; v = Number(v) || 0; if (Math.abs(v) > 1.5) v /= 100; this.input.throttleCmd = THREE.MathUtils.clamp(v, -0.3, 1); },
        onRudder: (v) => { if (this.you?.docked || this.you?.assist) return; v = Number(v) || 0; if (Math.abs(v) > 1.5) v /= 100; this.input.rudderCmd = THREE.MathUtils.clamp(v, -1, 1); this.input.rudderHold = Math.abs(v) > 0.01; if (this.input.rudderHold) this.autopilot = false; },
        onAllStop: () => { this.input.rudderCmd = 0; this.input.throttleCmd = 0; this.input.rudderHold = false; },
        onDock: () => this.toggleDock(), onChart: () => this.hud.toggleChart(), onInterior: () => this.toggleInterior(), onCamera: () => { this.cam.mode = (this.cam.mode + 1) % 3; },
      });
    } catch (e) { console.warn('[touch] helm unavailable', e); this.touchHelm = null; }
    const hold = (id, key) => {
      const b = document.getElementById(id); if (!b) return;
      const on = (e) => { e.preventDefault(); if (this.you?.docked) return; this.input[key] = true; this.autopilot = false; b.classList.add('on'); };
      const off = () => { this.input[key] = false; b.classList.remove('on'); };
      b.addEventListener('pointerdown', on);
      for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) b.addEventListener(ev, off);
    };
    hold('tchPort', 'left'); hold('tchStbd', 'right');
    document.getElementById('tchThrUp')?.addEventListener('click', () => this.nudgeThrottle(0.1));
    document.getElementById('tchThrDn')?.addEventListener('click', () => this.nudgeThrottle(-0.1));
  }
  // T / the Dock button: dock when at sea; while docked they (re)open the harbour panel if it is closed (the server
  // answers 'dock' from a docked player with the harbour payload) and cast off when it is open. Cast off is explicit too.
  toggleDock() {
    if (!this.you) return;
    if (!this.you.docked) return this.net.action('dock');
    if (!this.hud.harborOpen()) return this.net.action('dock');
    this.castOff();
  }
  castOff() { if (this.you?.docked) this.net.action('undock'); }
  requestTugs() {
    const you = this.you; if (!you || you.docked || you.assist) return;
    const C = SHIP_CLASSES[you.ship.cls];
    const cost = Math.max(400, Math.round(C.displacement * 0.35));
    if (!you.nearBerth) return this.hud.event({ kind: 'warn', text: 'No berth within reach of the tugs (get within 1.5 km of the harbour, under 6 kn).' });
    if (confirm(`Request tugs to ${you.nearBerth.name || 'the berth'} for ${cost.toLocaleString()} cr?`)) this.net.action('tug_assist');
  }
  toggleInterior() { if (this.interior.active) this.interior.exit(); else if (!this.interior.enter()) this.hud.event({ kind: 'warn', text: 'Nothing to go below into yet — wait for your ship.' }); }
  setSails(up) {
    const you = this.you; if (!you) return;
    up = !!up;
    this.net.action('sails', { up });
    this.myMesh?.userData.setSails?.(up, this.windRel());
    this.hud.setSailsButton?.(!!SHIP_CLASSES[you.ship.cls]?.sail, up);
  }
  /** Relative wind angle in degrees (0 = on the bow, 90 = from starboard). */
  windRel() { const w = this.localWind || this.wind; const from = Number.isFinite(w?.dir) ? w.dir : normDeg((Math.atan2(-(w?.u || 0), -(w?.v || 0)) * 180) / Math.PI); return normDeg(from - (this.ship?.hdg || 0)); }
  toggleAutopilot() { if (!this.route.length) { this.hud.event({ kind: 'warn', text: 'Set a waypoint or a route on the chart (M) first.' }); return; } this.autopilot = !this.autopilot; if (this.autopilot) this.input.rudderHold = false; }
  /** Route API used by the chart: ordered waypoints the autopilot follows. */
  setRoute(points) {
    const pts = (points || []).map((p) => ({ lat: Number(Array.isArray(p) ? p[0] : p.lat), lon: Number(Array.isArray(p) ? p[1] : p.lon) })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    this.route = pts;
    if (!pts.length) { this.autopilot = false; return; }
    const last = pts[pts.length - 1];
    const total = this.routeLength();
    this.hud.event({ kind: 'info', text: `Route set: ${pts.length} waypoint${pts.length > 1 ? 's' : ''}, ${fmtDistance(total)}, first leg bearing ${Math.round(bearing(this.ship.lat, this.ship.lon, pts[0].lat, pts[0].lon))}°. Press P for autopilot.` });
    void last;
  }
  clearRoute() { this.route = []; this.autopilot = false; this.hud.chart?.clearRoute?.(true); }
  setWaypoint(lat, lon) { this.setRoute([{ lat, lon }]); }
  routeLength() { let d = 0, a = this.ship; for (const p of this.route) { d += haversine(a.lat, a.lon, p.lat, p.lon); a = p; } return d; }
  nearestOther(range) { let best = null, bd = range; for (const o of this.others.values()) { const d = unitsBetween(this.ship.lat, this.ship.lon, o.cur.lat, o.cur.lon); if (d < bd) { bd = d; best = o; } } return best; }
  boardNearest() { const o = this.nearestOther(INTERACT.BOARD_RANGE_U * 1.5); if (!o) return this.hud.event({ kind: 'warn', text: `No ship within boarding range (${fmtDistance(INTERACT.BOARD_RANGE_U * GEO.SCALE)}).` }); if (confirm(`Board ${o.name}? Piracy makes you wanted.`)) this.net.action('board', { targetId: o.id }); }
  salvageNearest() { let best = null, bd = INTERACT.SALVAGE_RANGE_U * 1.5; for (const w of this.wrecks) { const d = unitsBetween(this.ship.lat, this.ship.lon, w.lat, w.lon); if (d < bd) { bd = d; best = w; } } if (!best) return this.hud.event({ kind: 'warn', text: `No wreck within ${fmtDistance(INTERACT.SALVAGE_RANGE_U * GEO.SCALE)}.` }); this.net.action('salvage', { wreckId: best.id }); }
  flash() { document.body.style.boxShadow = 'inset 0 0 120px rgba(255,60,60,0.6)'; setTimeout(() => { document.body.style.boxShadow = ''; }, 600); }

  // ------------------------------------------------------------------ simulation
  simulate(dt) {
    const s = this.ship, you = this.you; if (!s || !you) return;
    if (you.assist) { this.followServer(dt); return; } // tugs: the server moves the ship, we only show it
    if (you.docked || you.flooding >= 1 || you.rescue) { s.spd = 0; s.throttle = 0; return; }
    const C = SHIP_CLASSES[s.cls] || SHIP_CLASSES.coaster;
    // rudder from keys (hold), the touch slider, or the autopilot following the route
    if (this.autopilot && this.route.length) {
      const wp = this.route[0];
      const brg = bearing(s.lat, s.lon, wp.lat, wp.lon);
      this.input.rudderCmd = THREE.MathUtils.clamp(angleDiff(s.hdg, brg) / 25, -1, 1);
      const d = unitsBetween(s.lat, s.lon, wp.lat, wp.lon);
      const reach = this.route.length > 1 ? Math.max(300, C.length * 3) : Math.max(200, C.length * 2);
      if (d < reach) {
        this.route.shift();
        if (!this.route.length) { this.autopilot = false; this.input.rudderCmd = 0; this.hud.event({ kind: 'info', text: 'Route complete — waypoint reached.' }); this.hud.chart?.clearRoute?.(true); }
        else this.hud.event({ kind: 'info', text: `Waypoint reached, ${this.route.length} to go.` });
      }
    } else if (this.input.left || this.input.right) {
      this.input.rudderCmd = THREE.MathUtils.clamp(this.input.rudderCmd + (this.input.left ? -1 : 1) * dt * 1.4, -1, 1);
    } else if (!this.input.rudderHold) { this.input.rudderCmd += (0 - this.input.rudderCmd) * Math.min(1, dt * 2.5); if (Math.abs(this.input.rudderCmd) < 0.02) this.input.rudderCmd = 0; }
    const prevLat = s.lat, prevLon = s.lon;
    const cur = currentAt(s.lat, s.lon, this.simTime);
    const env = {
      cond: you.cond, flooding: you.flooding, loadFrac: you.cargo.reduce((a, c) => a + c.qty, 0) / C.capacity, wind: this.localWind || this.wind, current: cur,
      tideStream: this.tide?.stream || null, sea: this.wx?.sea ?? 0, waveH: this.wx?.waveH ?? 0, sailsUp: you.sailsUp !== false, towing: !!you.towing,
      fuelEmpty: you.fuelEmpty, grounded: false,
    };
    const sub = Math.max(1, Math.min(8, Math.ceil(dt / 0.02)));
    for (let i = 0; i < sub; i++) stepShip(s, { throttleCmd: this.input.throttleCmd, rudderCmd: this.input.rudderCmd }, env, dt / sub);
    // grounding check against loaded terrain (+ tide): refuse only moves that go SHALLOWER than where we already are,
    // so a ship sitting on a shallow reading can still back (or push) off towards deeper water
    const h = this.terrain.heightAt(s.lat, s.lon);
    if (h != null && -h + this.tideLevel < C.draft) {
      const hPrev = this.terrain.heightAt(prevLat, prevLon);
      if (hPrev == null || h > hPrev) {
        s.lat = prevLat; s.lon = prevLon;
        const bump = Math.abs(s.spd) > 0.5;
        if (bump) s.spd *= 0.15; else s.spd = 0;
        const now = performance.now();
        if (now - this.lastGrounding > 4000) { // always tell the player; only a real bump costs hull condition
          this.lastGrounding = now;
          if (bump) this.net.action('grounding');
          this.hud.alert('ground', 'AGROUND — reverse off (S)', ''); setTimeout(() => this.hud.clearAlert('ground'), 4000);
        }
      }
    }
    // quays, breakwaters, land of the loaded harbour patches, and other hulls
    const res = resolveShip(s, C, this.geoms, dt, this.collisionOthers());
    if (res.hit) this.onCollision(res);
    this.net.sendState(s);
  }
  /** Tug assist: ease the local ship onto the server's positions (10 Hz from the snapshot, 1 Hz from `you`). */
  followServer(dt) {
    const s = this.ship, you = this.you;
    const S = this.selfSamples;
    let target;
    if (S.length) { const o = { samples: S, cur: null }; this.interp(o, performance.now()); target = o.cur; } else target = you.ship;
    const k = Math.min(1, dt * 4);
    s.lat += (target.lat - s.lat) * k; s.lon += (target.lon - s.lon) * k; s.hdg = normDeg(s.hdg + angleDiff(s.hdg, target.hdg) * k); s.spd = target.spd ?? you.ship.spd;
    s.throttle = 0; s.rudder = 0; this.input.throttleCmd = 0; this.input.rudderCmd = 0;
  }
  /** Hulls the local ship can bump into: other players at sea, cutters, AI traffic under way (moored AI share an anchor point). */
  collisionOthers() {
    const out = [];
    const me = this.ship;
    const push = (o, dims) => { if (unitsBetween(me.lat, me.lon, o.cur.lat, o.cur.lon) < 600) out.push({ id: o.id, lat: o.cur.lat, lon: o.cur.lon, hdg: o.cur.hdg, spd: o.cur.spd, length: dims.length, beam: dims.beam }); };
    for (const o of this.others.values()) { if (o.docked || o.sinking) continue; push(o, SHIP_CLASSES[o.cls] || o.mesh.userData); }
    for (const c of this.cutters.values()) push(c, CUTTER_DIMS);
    for (const a of this.ai.values()) { if (a.state === 'moored') continue; push(a, SHIP_CLASSES[a.cls] || a.mesh.userData); }
    return out;
  }
  onCollision(res) {
    const now = performance.now();
    this.flash();
    const kindTxt = res.kind === 'ship' ? 'another hull' : res.kind === 'breakwater' ? 'the breakwater' : res.mask === 1 ? 'the shore' : 'the quay';
    this.hud.alert('coll', `COLLISION — hit ${kindTxt} at ${res.speedKn.toFixed(1)} kn`, ''); setTimeout(() => this.hud.clearAlert('coll'), 3500);
    if (now - this.lastCollision > COLLISION_RATE_MS) { this.lastCollision = now; this.net.action('collision', { speedKn: res.speedKn, kind: res.kind || 'quay' }); }
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
    mesh.position.y = vis.heave + this.tideLevel - flooding * (mesh.userData.freeboard + 2) - sink;
    mesh.rotation.set(vis.pitch, -h, vis.roll, 'YXZ');
    mesh.userData.setWake?.(Math.abs(spd) / 10);
    mesh.userData.setWaterY?.(mesh.position.y);
    const ud = mesh.userData;
    if (ud.updateWake) {
      if (ud.wakeGroup && !ud.wakeGroup.parent) this.scene.add(ud.wakeGroup);
      ud.updateWake(dt, mesh.position, h, flooding >= 1 ? 0 : spd);
    }
  }
  updateCamera(dt) {
    const s = this.ship; if (!s || !this.myMesh) return;
    if (this.you?.rescue) return this.updateRaftCamera(dt);
    const target = this.myMesh.position.clone().add(new THREE.Vector3(0, 8, 0));
    if (this.cam.free && performance.now() - this.cam.lastDrag > 6000) this.cam.free = false;
    const h = s.hdg * D2R;
    let yaw = this.cam.free ? this.cam.yaw : (this.cam.yaw += angleDiffRad(this.cam.yaw, -h) * Math.min(1, dt * 1.5));
    let dist = this.cam.dist, pitch = this.cam.pitch;
    if (this.cam.mode === 1) { dist = this.cam.dist * 2.2; pitch = 1.1; }
    const pos = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch) * dist, Math.sin(pitch) * dist + 6, Math.cos(yaw) * Math.cos(pitch) * dist).add(target);
    if (this.cam.mode === 2) { // bridge view: look azimuth = heading + the mouse yaw offset (which eases back to dead ahead)
      const L = this.myMesh.userData.length; const bp = new THREE.Vector3(0, this.myMesh.userData.freeboard + 16, L * 0.35).applyMatrix4(this.myMesh.matrixWorld);
      if (!this.cam.free) this.cam.look = (this.cam.look || 0) * Math.max(0, 1 - dt * 1.5);
      const la = h + (this.cam.look || 0);
      this.camera.position.copy(bp); const look = new THREE.Vector3(Math.sin(la), -0.05, -Math.cos(la)).add(bp); this.camera.lookAt(look); if (this.myMesh.userData.label) this.myMesh.userData.label.visible = false; return;
    }
    if (this.myMesh.userData.label) this.myMesh.userData.label.visible = true;
    const wave = this.ocean.heightAt(pos.x, pos.z, this.time) + this.tideLevel;
    pos.y = Math.max(pos.y, wave + 4);
    this.camera.position.lerp(pos, Math.min(1, dt * 6));
    this.camera.lookAt(target);
  }
  /** Adrift after sinking: a low orbit around the life raft while the SAR craft comes in. */
  updateRaftCamera(dt) {
    const r = this.you.rescue;
    if (!this.raft) { this.raft = buildRaft(); this.scene.add(this.raft); }
    const p = this.place(this.raft, r.lat, r.lon, 0);
    const wave = this.ocean.heightAt(p.x, p.z, this.time) + this.tideLevel;
    this.raft.position.y = wave + 0.2; this.raft.rotation.set(Math.sin(this.time * 0.7) * 0.08, this.time * 0.05, Math.cos(this.time * 0.9) * 0.08);
    this.cam.yaw += dt * 0.12;
    const pos = new THREE.Vector3(Math.sin(this.cam.yaw) * 16, 5, Math.cos(this.cam.yaw) * 16).add(this.raft.position);
    pos.y = Math.max(pos.y, this.ocean.heightAt(pos.x, pos.z, this.time) + this.tideLevel + 2.5);
    this.camera.position.lerp(pos, Math.min(1, dt * 3));
    this.camera.lookAt(this.raft.position.clone().add(new THREE.Vector3(0, 1, 0)));
    if (this.myMesh.userData.label) this.myMesh.userData.label.visible = false;
  }
  updateDayNight(dt) {
    const dayFrac = (this.simTime % 86400) / 86400; // 0 = midnight
    const elev = Math.sin((dayFrac - 0.25) * Math.PI * 2);
    // azimuth from north through east (x = east, -z = north): east at 06:00, south (+z) at noon, west at 18:00
    const az = dayFrac * Math.PI * 2;
    const cosE = Math.cos(Math.asin(THREE.MathUtils.clamp(elev, -1, 1)));
    const dir = new THREE.Vector3(Math.sin(az) * cosE, Math.max(-0.2, elev), -Math.cos(az) * cosE).normalize();
    const day = THREE.MathUtils.smoothstep(elev, -0.08, 0.25);
    const dusk = Math.exp(-Math.pow((elev - 0.02) / 0.12, 2));
    const storm = this.wx?.storm || 0, cloud = this.wx?.cloud ?? 0;
    const gloom = THREE.MathUtils.clamp(0.55 * storm + 0.2 * cloud, 0, 0.75); // storm darkening
    const grey = new THREE.Color(0x5d6670);
    const top = new THREE.Color(0x101e33).lerp(new THREE.Color(0x3f7fc9), day).lerp(new THREE.Color(0x8c5a6a), dusk * 0.35).lerp(grey, gloom * day);
    const hor = new THREE.Color(0x24364d).lerp(new THREE.Color(0xbfd9ee), day).lerp(new THREE.Color(0xf2a860), dusk * 0.7).lerp(grey.clone().multiplyScalar(1.3), gloom * day);
    const sunCol = new THREE.Color(0xfff2d0).lerp(new THREE.Color(0xff9a4a), dusk);
    // lightning: a short sky + ambient pulse (WeatherFX adds its own light flash)
    if (storm > 0.6 && Math.random() < dt / 11) { this.lightning = 0.14; this.weatherFx.flash?.(); }
    const bolt = this.lightning > 0 ? Math.min(1, this.lightning / 0.14) : 0;
    this.lightning = Math.max(0, this.lightning - dt);
    this.sun.position.copy(dir).multiplyScalar(3000).add(this.camera.position); this.sun.target.position.copy(this.camera.position);
    this.sun.intensity = (0.35 + 2.0 * day) * (1 - gloom); this.sun.color.copy(sunCol);
    this.hemi.intensity = (0.45 + 0.6 * day) * (1 - 0.6 * gloom) + bolt * 2.5;
    if (bolt > 0) { top.lerp(new THREE.Color(0xe8f0ff), bolt * 0.7); hor.lerp(new THREE.Color(0xf4f8ff), bolt * 0.7); }
    this.sky.material.uniforms.top.value.copy(top); this.sky.material.uniforms.horizon.value.copy(hor); this.sky.material.uniforms.sunDir.value.copy(dir); this.sky.material.uniforms.sunCol.value.copy(sunCol).multiplyScalar(day * (1 - gloom));
    this.scene.fog.color.copy(hor);
    const far = this.fogFar, near = far * 0.22;
    const kf = Math.min(1, dt * 0.5);
    this.scene.fog.far += (far - this.scene.fog.far) * kf; this.scene.fog.near += (near - this.scene.fog.near) * kf;
    this.ocean.setSun(dir, sunCol, 1 - day, top, hor);
    const night = 1 - day; this.night = night;
    for (const m of this.harborMeshes.values()) m.userData.setNight?.(night, this.time);
    for (const m of this.platformMeshes.values()) m?.userData.setNight?.(night, this.time);
    const lightsOn = night > 0.5;
    if (this.lightsOn !== lightsOn) {
      this.lightsOn = lightsOn;
      for (const o of [...this.others.values(), ...this.cutters.values(), ...this.ai.values()]) o.mesh.userData.setLights?.(lightsOn);
      this.myMesh?.userData.setLights?.(lightsOn);
    }
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
    if (this.myMesh.userData.setSails && now - this.lastSails > 500) { this.lastSails = now; this.myMesh.userData.setSails(this.you.sailsUp !== false, this.windRel()); }
    for (const o of this.others.values()) { this.interp(o, now); this.shipVisual(o.mesh, o.cur.lat, o.cur.lon, o.cur.hdg, o.cur.spd, o.vis, o.flooding || 0, dt, !!o.docked); }
    for (const c of this.cutters.values()) { this.interp(c, now); this.shipVisual(c.mesh, c.cur.lat, c.cur.lon, c.cur.hdg, c.cur.spd, c.vis, 0, dt, false); if (c.mesh.userData.beacon) c.mesh.userData.beacon.material.emissiveIntensity = c.state === 'patrol' ? 0.5 : 2 + 2 * Math.sin(this.time * 12); }
    for (const a of this.ai.values()) { this.interp(a, now); this.shipVisual(a.mesh, a.cur.lat, a.cur.lon, a.cur.hdg, a.state === 'underway' ? a.cur.spd : 0, a.vis, 0, dt, a.state !== 'underway'); }
    for (const r of this.rescues.values()) {
      this.interp(r, now);
      if (r.kind === 'helicopter') { const p = this.place(r.mesh, r.cur.lat, r.cur.lon, 60 + Math.sin(this.time * 0.8) * 2); r.mesh.rotation.set(-0.08, -r.cur.hdg * D2R, 0, 'YXZ'); r.mesh.userData.setRotor?.(this.time); void p; }
      else this.shipVisual(r.mesh, r.cur.lat, r.cur.lon, r.cur.hdg, r.cur.spd, r.vis, 0, dt, false);
    }
    for (const m of this.harborMeshes.values()) m.userData.updateBuoys?.(this.time);
    if (this.interior.active) this.interior.update(dt); else { if (this.raft && !this.you.rescue) { this.drop(this.raft); this.raft = null; } this.updateCamera(dt); }
    this.updateDayNight(dt);
    this.weatherFx.update?.(dt, this.camera.position, this.time);
    this.renderer.render(this.scene, this.camera);
    // HUD
    if (now - this.lastTelemetry > 120) { this.lastTelemetry = now; this.updateHud(now); }
    if (now - this.lastRadar > 100) { this.lastRadar = now; this.drawRadar(now); }
    this.hud.tickLog(now); this.hud.updateHail(this.you, Date.now() + (this.clockOffset || 0)); // hail deadline is a server timestamp
  }
  updateHud(now) {
    const s = this.ship, you = this.you, C = SHIP_CLASSES[s.cls] || SHIP_CLASSES.coaster;
    const h = this.terrain.heightAt(s.lat, s.lon);
    const cur = currentAt(s.lat, s.lon, this.simTime);
    if (this.tide?.stream) { cur.u += this.tide.stream.u || 0; cur.v += this.tide.stream.v || 0; }
    let nearest = null, nd = Infinity;
    for (const hb of this.world.harbors) { const a = this.harborAnchor(hb); const d = haversine(s.lat, s.lon, a.lat, a.lon); if (d < nd) { nd = d; nearest = hb; } }
    const hasGeom = nearest && this.geoms.has(nearest.id);
    if (!you.docked && !you.assist) {
      if (you.nearBerth && you.nearBerth.distM <= INTERACT.BERTH_RANGE_U) this.hud.alert('dock', `${you.nearBerth.name || 'Berth'}: alongside — press T to moor (under 2 kn)`, 'warn');
      else if (!hasGeom && nearest && nd / GEO.SCALE <= INTERACT.DOCK_RADIUS_U) this.hud.alert('dock', `${nearest.name}: in docking range — press T (under 3 kn)`, 'warn');
      else this.hud.clearAlert('dock');
    } else this.hud.clearAlert('dock');
    if (you.assist) this.hud.alert('assist', `Tugs have you — berthing at ${you.assist.berthName || 'the berth'}…`, 'warn'); else this.hud.clearAlert('assist');
    let wp = null, eta = null;
    const v = Math.abs(s.spd) * GEO.KN_TO_MS * SIM.MOTION_SCALE;
    if (this.route.length) {
      const first = this.route[0];
      const d = haversine(s.lat, s.lon, first.lat, first.lon), total = this.routeLength();
      eta = v > 0.5 ? total / v : null;
      wp = { dist: fmtDistance(d), brg: bearing(s.lat, s.lon, first.lat, first.lon), eta: eta != null ? fmtTime(eta) : '—', total: fmtDistance(total), count: this.route.length };
    }
    this.hud.updateTelemetry(s, {
      depth: h == null ? null : -h + this.tideLevel, draft: C.draft, current: { set: normDeg((Math.atan2(cur.u, cur.v) * 180) / Math.PI), drift: Math.hypot(cur.u, cur.v) / GEO.KN_TO_MS }, flooding: you.flooding,
      nearest: nearest ? { name: nearest.name, dist: fmtDistance(nd) } : null, wp, autopilot: this.autopilot, jobs: you.jobs.length, tide: this.tide, berth: you.nearBerth,
      status: you.rescue ? 'ADRIFT' : you.docked ? (you.berth ? `moored · ${you.berth.name}` : 'docked') : you.assist ? 'under tow' : you.fuelEmpty ? 'NO FUEL' : you.fishing ? 'fishing' : you.hail ? 'HAILED' : you.towing ? 'towing' : 'at sea',
    });
    this.hud.updateTop(you, { simTime: this.simTime, wind: this.localWind ? { dir: this.localWind.dir, spd: this.localWind.spd, u: this.localWind.u, v: this.localWind.v } : this.wind, storms: this.storms }, this.others.size + 1, this.net.latency);
    if (you.fuelEmpty) this.hud.alert('fuel', 'OUT OF FUEL — drifting. Call a tow or wait for help.', ''); else this.hud.clearAlert('fuel');
    if (you.flooding > 0.05 && you.flooding < 1) this.hud.alert('flood', `TAKING ON WATER ${Math.round(you.flooding * 100)} % — use a kit (K) or make harbour`, ''); else this.hud.clearAlert('flood');
    // v0.3 HUD panels (C2): each is optional while the HUD is still being built
    this.hud.showFishing?.(you.fishing ? you.fishInfo || { ground: '—', rate: 0, caught: 0, tooFast: Math.abs(s.spd) >= 3 } : null);
    this.hud.showWeather?.(this.wx, this.tide);
    this.hud.showRescue?.(you.rescue ? { ...you.rescue, now: Date.now() + (this.clockOffset || 0), harborName: this.world.harbors.find((x) => x.id === you.rescue.harbor)?.name } : null);
    this.hud.showBerth?.(you.nearBerth || null, you.berth || null, you.assist || null, Math.max(400, Math.round(C.displacement * 0.35)));
    this.hud.showVoyage?.(this.route, eta, this.route.length ? Math.round((this.routeLength() / 1852) * SIM.EXPRESS_CR_PER_NM) : 0);
    if (this.hud.chartOpen() && now - (this.lastChart || 0) > 1000) { this.lastChart = now; this.hud.drawChart(); }
  }
  drawRadar(now) {
    const s = this.ship, contacts = [];
    for (const h of this.world.harbors) { const a = this.harborAnchor(h); contacts.push({ kind: 'harbor', lat: a.lat, lon: a.lon, color: '#58d68d', label: h.name.split(' (')[0], size: h.size }); }
    for (const g of this.world.fishing) contacts.push({ kind: 'ground', lat: g.lat, lon: g.lon, color: 'rgba(120,200,255,0.8)', radiusU: (g.radiusKm * 1000) / GEO.SCALE });
    for (const pl of this.world.platforms || []) contacts.push({ kind: 'platform', lat: pl.lat, lon: pl.lon, color: '#f2b134', label: pl.name.split(' (')[0] });
    for (const w of this.wrecks) contacts.push({ kind: 'wreck', lat: w.lat, lon: w.lon, color: '#bbb' });
    for (const c of this.cutters.values()) contacts.push({ kind: 'cutter', lat: c.cur.lat, lon: c.cur.lon, color: c.state === 'patrol' ? '#ff6b6b' : '#ff2020' });
    for (const o of this.others.values()) contacts.push({ kind: 'ship', lat: o.cur.lat, lon: o.cur.lon, hdg: o.cur.hdg, color: o.convoyId && o.convoyId === this.you?.convoyId ? '#5ad6ff' : o.wanted ? '#ffb070' : '#ffffff', label: o.name });
    for (const a of this.ai.values()) contacts.push({ kind: 'ai', lat: a.cur.lat, lon: a.cur.lon, hdg: a.cur.hdg, spd: a.cur.spd, color: '#9aa3ab', label: a.name, dest: a.destName, state: a.state });
    for (const r of this.rescues.values()) contacts.push({ kind: 'rescue', lat: r.cur.lat, lon: r.cur.lon, hdg: r.cur.hdg, color: '#ff8c42', label: r.kind === 'helicopter' ? 'SAR heli' : 'Lifeboat' });
    if (this.you?.nearBerth) { const b = this.you.nearBerth; if (Number.isFinite(b.lat) && Number.isFinite(b.lon)) contacts.push({ kind: 'berth', lat: b.lat, lon: b.lon, hdg: b.hdg, color: '#58d68d', label: b.name }); }
    this.route.forEach((p, i) => contacts.push({ kind: 'wp', lat: p.lat, lon: p.lon, color: i === 0 ? '#f2b134' : 'rgba(242,177,52,0.55)', label: String(i + 1) }));
    this.hud.drawRadar(s, contacts, now);
  }
}

function buildRaft() {
  const g = new THREE.Group();
  const orange = new THREE.MeshStandardMaterial({ color: 0xff6a00, roughness: 0.7 });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.45, 10, 20), orange); ring.rotation.x = Math.PI / 2; g.add(ring);
  const floor = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, 0.2, 16), new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.9 })); floor.position.y = -0.15; g.add(floor);
  const canopy = new THREE.Mesh(new THREE.ConeGeometry(1.5, 1.1, 12), new THREE.MeshStandardMaterial({ color: 0xff8c1a, roughness: 0.8 })); canopy.position.y = 0.8; g.add(canopy);
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 8), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 3 })); lamp.position.y = 1.45; g.add(lamp);
  g.userData.dispose = () => g.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
  return g;
}
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function angleDiffRad(a, b) { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; }
function fmtTime(sec) { const m = Math.round(sec / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`; }

window.app = new App();
