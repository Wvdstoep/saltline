// Saltline client: scene, floating origin, local ship simulation, networking glue, camera, day/night, HUD loop.
// v0.3 (docs/V3-CONTRACTS.md §5): harbour geometry + patch terrain + collision, tide/weather, AI traffic, rescues,
// offshore platforms, walkable interior, multi-waypoint routes, touch helm, sails, wakes, buoys.
// v0.4 (docs/V4-CONTRACTS.md §1, §3, §4): client time warp (app.warp mirrors you.warp; the local simulation integrates
// dt × warp in ≤ 0.05 s sim substeps, autopilot and grounding per substep; . / , step the level; manual helm above 20×
// drops to real time; the chase camera lifts above 20×), going ashore (app.ashore, G, mutually exclusive with the
// interior, no ship simulation while ashore, no casting off from the quay), chase camera sized to the hull.
import * as THREE from 'three';
import { GEO, SIM, SHIP_CLASSES, INTERACT, LAYERS, WARP } from '/shared/constants.js';
import { toLocal, fromLocal, haversine, bearing, destination, unitsBetween, angleDiff, normDeg, fmtDistance } from '/shared/geo.js';
import { stepShip, currentAt } from '/shared/physics.js';
import { Net } from './net.js';
import { Ocean } from './ocean2.js';
import { createMotion, stepMotion } from './motion.js';
import { SoundEngine } from './sound.js';
import { JobLayer, jobTargets } from './jobs.js';
import { AisLayer } from './ais.js';
import { Terrain, VSCALE } from './terrain.js';
import * as ShipMod from './ship.js';
import * as HarborMod from './harbor.js';
import { Hud } from './hud.js';
import { HarborGeomSet } from './harborgeom.js';
import { resolveShip } from './collision.js';
import { Interior } from './interior.js';
import { WeatherFX } from './weather.js';
import { seaForBeaufort, douglas } from '/shared/seastate.js';   // debug sea-state forcing (?bft=0..12)
import { TouchHelm, isTouch } from './touch.js';
import { Telegraph } from './telegraph.js';
import { THROTTLE_MIN, rpmFraction } from '/shared/telegraph.js';
import { Autopilot } from './autopilot.js'; // v6 chart-aware autopilot (docs/V6-QUICK-CONTRACTS.md §4.6)

const { buildShip, buildWreck } = ShipMod;
const { buildHarbor, buildFishingMarker } = HarborMod;
const D2R = Math.PI / 180;
const GEOM_LOAD_M = 12000, GEOM_UNLOAD_M = 16000, GEOM_RETRY_MS = 120000;
const SUBPATCH_LOAD_M = 5200, SUBPATCH_UNLOAD_M = 7500;   // V7 big ports: extra patches (centre distance)
const SCENERY_LOAD_M = 11000, SCENERY_UNLOAD_M = 13000;
const PLATFORM_LOAD_M = 15000, PLATFORM_UNLOAD_M = 18000;
const COLLISION_RATE_MS = 3000;
const ANCHOR_ORIGIN_M = 5000; // keep the floating origin on a harbour's own origin while this close, so patch, scenery and ship agree to the metre
const CUTTER_DIMS = { length: 28, beam: 6.5 };
// time warp (docs/V4-CONTRACTS.md §1)
const WARP_LEVELS = Array.isArray(WARP?.LEVELS) && WARP.LEVELS.length ? WARP.LEVELS : [1, 5, 20, 100, 400];
const WARP_MAX_NO_ROUTE = Number.isFinite(WARP?.MAX_NO_ROUTE) ? WARP.MAX_NO_ROUTE : 20; // above this: route + autopilot only, manual helm drops to 1×, camera lifts
const SUBSTEP_S = 0.05;          // longest SIM-time integration step
const MAX_SUBSTEPS = 400;        // per frame (at the cap a substep grows past SUBSTEP_S rather than losing sim time)
const WARP_HOLD_MS = 3000;       // after the client lowers the level, ignore stale higher `you.warp` values this long
const WARP_SHIP_COLLIDE_MAX = 20; // ship–ship contacts are resolved up to this level (above it the watch keeps clear of traffic)
const ROUTE_SEND_MAX = 250;      // waypoints sent with set_warp (the socket's payload limit is 16 KiB)
// chase camera (docs/V4-CONTRACTS.md §4): distance = max(60, 2.6 × ship length), pitch 0.32
const CAM_PITCH = 0.32;
const camDistFor = (L) => Math.max(60, 2.6 * (Number(L) || 60));
const camZoomMin = (L) => Math.max(20, 0.6 * (Number(L) || 60));
const camZoomMax = (L) => Math.max(1800, 10 * (Number(L) || 60));

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
    this.weatherFx.onThunder = (k, delayS) => setTimeout(() => this.sound?.event('thunder', k), delayS * 1000);   // light first, then the sound
    // Debug / screenshots: ?bft=0..12 (or window.saltlineSea(n), null = real weather) forces this client's sea state,
    // visuals and HUD only (the server's SALTLINE_DEBUG=1 action 'debug_sea' {bft} does the same server-side).
    this.forceBft = null; this.camJolt = 0;
    try { const q = new URLSearchParams(location.search).get('bft') ?? new URLSearchParams(location.search).get('sea'); if (q !== null && q !== '' && Number.isFinite(+q)) this.forceBft = Math.max(0, Math.min(12, Math.round(+q))); } catch { /* no URL API */ }
    window.saltlineSea = (n) => { this.forceBft = n === null || n === undefined || !Number.isFinite(+n) ? null : Math.max(0, Math.min(12, Math.round(+n))); if (this.you?.weather) { const w = this.forceBft != null ? this.forcedWeather(this.you.weather) : this.you.weather; this.applyWeather(w); this.ocean.snapSea?.(); } return this.forceBft; };
    try { this.sound = new SoundEngine(); } catch (e) { console.warn('[sound] unavailable', e); this.sound = null; }
    this.soundState = { view: 'deck', room: null, shipCls: 'coaster', throttle: 0, rpmFrac: 0, speedKn: 0, windSpd: 0, windRelDeg: 0, waveH: 0, rain: 0, storm: 0, night: 0, nearHarborM: null, nearShips: [], underway: false, docked: true, towing: false, warp: 1 };
    this.lastNearHarbor = 0; this.lastFootstep = 0; this.shelterSet = false;
    this.origin = { lat: 52, lon: 4 };
    this.net = new Net({ status: (s) => this.onStatus(s), message: (m) => this.onMessage(m) });
    this.hud = new Hud(this);
    try { this.telegraph = new Telegraph(this); } catch (e) { console.warn('[telegraph] unavailable', e); this.telegraph = null; } // engine order telegraph (V5 item 3)
    this.you = null; this.world = { harbors: [], fishing: [], platforms: [] }; this.ship = null; this.simTime = 0; this.wind = { u: 0, v: 0, spd: 5, dir: 240 };
    this.wx = null; this.tide = null; this.tideLevel = 0; this.localWind = null; this.storms = []; this.night = 0; this.lightning = 0; this.fogFar = 15000;
    this.others = new Map(); this.cutters = new Map(); this.ai = new Map(); this.rescues = new Map(); this.wrecks = []; this.wreckMeshes = new Map();
    this.harborMeshes = new Map(); this.groundMeshes = new Map(); this.platformMeshes = new Map();
    this.myMesh = null; this.myVis = { heave: 0, pitch: 0, roll: 0 }; this.raft = null; this.selfSamples = [];
    this.input = { throttleCmd: 0, rudderCmd: 0, left: false, right: false, up: false, down: false, rudderHold: false };
    this.cam = { yaw: 0, pitch: CAM_PITCH, dist: camDistFor(90), free: false, mode: 0 };
    this.camLift = 0; this.camPrevTarget = null; // warp camera lift (0..1) and the last chase target (the camera follows its motion 1:1)
    this.route = []; this.autopilot = false;
    // time warp: `warp` mirrors you.warp (the client follows a server drop at once and lowers it itself on manual helm)
    this.warp = 1; this.warpHold = null; this.warpReq = null;
    this.lastGrounding = 0; this.lastCollision = 0; this.clock = new THREE.Clock(); this.time = 0; this.started = false; this.lastSend = 0;
    this.lastTerrainUpdate = 0; this.lastRadar = 0; this.lastTelemetry = 0; this.lastSails = 0; this.ready = false;
    this.interior = new Interior(this);
    this.jobLayer = new JobLayer(this); this.jobTargets = [];
    this.routeMeta = null; this.pilot = new Autopilot(this); // planned route (route planner v2) + the pilot that sails it
    this.aisLayer = new AisLayer(this); // live AIS: real ships at real size
    // Going ashore (docs/V4-CONTRACTS.md §3): `app.ashore = new Ashore(this)`. Loaded as its own module so a problem in the
    // on-foot layer can never take the helm down with it; `ashoreReady` resolves to the instance (or null).
    this.ashore = null;
    this.ashoreReady = import('./ashore.js').then((m) => { this.ashore = new m.Ashore(this); this.hud.syncModes?.(); return this.ashore; })
      .catch((e) => { console.warn('[ashore] unavailable', e); return null; });
    // Berth guidance (V5-PLAN item 2, berthguide.js): berth outline + board + leading line + fairway lanes, and the HUD guidance card
    this.berthGuide = null;
    import('./berthguide.js').then((m) => { this.berthGuide = new m.BerthGuide(this); }).catch((e) => console.warn('[berthguide] unavailable', e));
    // World market (V6 item 7, market.js): every harbour's prices, the trade finder and the chart's price layer
    import('./market.js').then((m) => { this.market = new m.WorldMarket(this); }).catch((e) => console.warn('[market] unavailable', e));
    // Harbour tugs (V5-PLAN item 4, tugs.js): every skipper's assist tugs from the snapshots, with towlines and prop wash
    this.tugLayer = null;
    import('./tugs.js').then((m) => { this.tugLayer = new m.TugLayer(this); }).catch((e) => console.warn('[tugs] unavailable', e));
    // v6 fleet (fleet.js, hq.js): harbour Office tab, fleet dialogs, the top-bar chip and the Fleet HQ (O)
    this.fleetShips = new Map();   // snap.fleet (FleetPublic): fleet ships near you, drawn like AI traffic
    this.fleetUi = null; this.hq = null;
    import('./fleet.js').then((m) => { this.fleetUi = new m.FleetUi(this); }).catch((e) => console.warn('[fleet] unavailable', e));
    import('./hq.js').then((m) => { this.hq = new m.Hq(this); }).catch((e) => console.warn('[hq] unavailable', e));
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
    if (s !== 'connected') { this.applyWarp(1); this.warpHold = null; } // the server resets warp on every (re)connect; never run ahead while unheard
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
      case 'wt': this.terrain.wtiles?.onPush(m); break;                 // WORLD TILES: a tile near us changed revision → refetch (ETag)
      case 'ais': try { this.aisLayer.ingest(m.ships || [], m.time); } catch (e) { console.warn('[ais] ingest failed', e); } break;
      case 'you': this.onYou(m.you, false, !!m.correction, !!m.switched); break;
      case 'fleet': this.fleetUi?.onFleet(m.fleet); this.hq?.onFleet(m.fleet); break;
      case 'fleet_board': this.fleetUi?.onBoard(m); break;
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
    try { // v6 §10.3 fixture mode (development): ?fixture=fleet renders the Office/HQ from docs/fixtures/fleet.sample.json
      if (new URLSearchParams(location.search).get('fixture') === 'fleet') fetch('/docs/fixtures/fleet.sample.json').then((r) => r.json()).then((fx) => { this.fleetUi?.onFleet(fx.fleet); this.hq?.onFleet(fx.fleet); }).catch(() => {});
    } catch { /* no URL API */ }
  }
  // `correction` is set by the server when it rejected / moved our position: always snap to its ship then, otherwise
  // the two sides disagree forever (the server keeps rejecting every state sent from the stale client position).
  onYou(you, first, correction, switched) {
    const prev = this.you;
    this.you = you;
    this.net.vid = you.aboard ?? null;   // v6: states carry the ship they are for
    this.shipClock = { t: Number(you.shipTime) || 0, rate: Number(you.shipRate) || 1, at: performance.now(), warpRun: you.warpRun || null }; // V6 item 5
    const s = you.ship;
    const serverWarp = WARP_LEVELS.includes(Number(you.warp)) ? Number(you.warp) : 1;
    // Under warp the local ship runs ahead of the server's copy by (latency + upload interval) × speed × warp: only a
    // gap beyond that is a real disagreement (teleport, tow, impound) that must snap the ship.
    const lead = Math.abs(Number(s.spd) || 0) * GEO.KN_TO_MS * SIM.MOTION_SCALE * Math.max(this.warp, serverWarp) * 2;
    const hard = !this.ship || first || !prev || prev.ship.cls !== s.cls || !!prev.docked !== !!you.docked || (!!prev && prev.aboard !== you.aboard) || (!you.assist && unitsBetween(this.ship.lat, this.ship.lon, s.lat, s.lon) > 400 + lead);
    if (hard || (correction && !you.assist)) {
      // a plain correction is a few hundred metres: keep the helm commands and do not force a frame rebuild
      this.ship = { ...s, throttleCmd: hard ? s.throttle : this.input.throttleCmd, rudderCmd: hard ? 0 : this.input.rudderCmd };
      if (hard) { this.input.throttleCmd = you.docked ? 0 : s.throttle; this.input.rudderCmd = 0; this.selfSamples = []; }
      if (!this.myMesh || prev?.ship.cls !== s.cls || prev?.aboard !== you.aboard) {
        if (this.myMesh) { if (this.interior.active) this.interior.exit(); this.drop(this.myMesh); }
        this.myMesh = buildShip(s.cls, you.name, 7); this.scene.add(this.myMesh);
        this.hud.setSailsButton?.(!!SHIP_CLASSES[s.cls]?.sail, you.sailsUp !== false);
        // a new hull: chase camera sized to it (docs/V4-CONTRACTS.md §4)
        this.cam.dist = camDistFor(this.shipLength()); this.cam.pitch = CAM_PITCH;
        if (this.ashore?.active && this.myMesh.userData.label) this.myMesh.userData.label.visible = false; // bought a ship while ashore
      }
      this.recentre(hard);
    }
    this.syncWarp(serverWarp, you);
    if (prev && prev.docked && !you.docked) { this.hud.hideHarbor(); }
    if (!prev?.docked && you.docked) { this.input.throttleCmd = 0; this.input.rudderCmd = 0; this.autopilot = false; this.touchHelm?.setThrottle?.(0); }
    if (!prev?.assist && you.assist) { this.input.throttleCmd = 0; this.input.rudderCmd = 0; this.autopilot = false; this.touchHelm?.setThrottle?.(0); }
    if (prev?.name !== you.name) this.myMesh?.userData.label?.userData.setText(you.name);
    this.myMesh?.userData.setWear(1 - you.cond / 100); this.myMesh?.userData.setFlood(you.flooding);
    if (prev?.sailsUp !== you.sailsUp) { this.hud.setSailsButton?.(!!SHIP_CLASSES[s.cls]?.sail, you.sailsUp !== false); this.lastSails = 0; }
    // environment: tide level + stream, local weather for sea state / particles / fog
    if (you.tide) { this.tide = you.tide; this.tideLevel = Number(you.tide.height) || 0; this.ocean.setLevel?.(this.tideLevel); }
    if (you.weather && this.forceBft != null) you.weather = this.forcedWeather(you.weather);
    if (you.weather) this.applyWeather(you.weather);
    if (you.rescue && !prev?.rescue) { this.cam.free = false; this.hud.event({ kind: 'warn', text: 'You are in the life raft. Hold on — help is on the way.' }); }
    if (this.hud.harborOpen()) {
      // 'you' arrives every second while docked: only rebuild the panel when something it shows actually changed
      // (or a rebuild was deferred because the player was typing in it); the 'harbor' message re-renders on its own.
      const key = [you.money, you.fuel, you.cond, you.flooding, you.kits, you.ship.cls, JSON.stringify(you.cargo), JSON.stringify(you.jobs), you.convoy?.members?.length ?? 0, you.serviceDue ?? 0, you.berth?.id ?? ''].join('|');
      if (key !== this.lastHarborKey || this.hud.harborDirty) { this.lastHarborKey = key; this.hud.renderHarborTabs(); }
    }
    if (switched) {   // v6 §8.4: a new ship under you
      if (this.interior.active) this.interior.exit();
      if (this.ashore?.active) this.ashore.exit?.();
      this.hq?.close?.();                                             // show her: the HQ steps aside
      this.clearRoute(); this.autopilot = false; this.warp = 1;      // the server already reset warp; no event
      this.input.throttleCmd = 0; this.input.rudderCmd = 0; this.touchHelm?.setThrottle?.(0);
      this.fleetUi?.switchFade(you);
      if (you.docked) this.net.action('dock');                       // a fresh harbour sheet for her harbour
    }
  }
  /** V6 item 5: the ship's clock (s), smooth between the 1 Hz `you` — it runs at the warp factor (under tugs: the op's rate). */
  shipTimeNow() {
    const c = this.shipClock; if (!c || !(c.t > 0)) return this.simTime || Date.now() / 1000;
    return c.t + ((performance.now() - c.at) / 1000) * (this.you?.assist ? c.rate : (this.warp || 1));
  }
  /** The real weather with its sea state replaced by a representative open sea of Beaufort `forceBft` (debug). */
  forcedWeather(w) {
    const f = seaForBeaufort(this.forceBft), dir = Number.isFinite(+w?.windDir) ? +w.windDir : 250;
    const d = douglas(f.waveH);
    return { ...w, ...f, windDir: dir, waveDir: dir, swellDir: (dir + 340) % 360, seaState: d.code, seaWord: d.word, stormName: null, stormKind: null, forced: true, source: `${w?.source || 'synthetic'} (forced F${f.bft})` };
  }
  applyWeather(w) {
    this.wx = w;
    const spd = Number(w.windSpd) || 0, dir = Number(w.windDir) || 0;
    this.localWind = { spd, dir, u: -Math.sin(dir * D2R) * spd, v: -Math.cos(dir * D2R) * spd, gust: w.gust };
    this.ocean.setWind(spd);
    this.ocean.setSea?.({ windSpd: spd, windDir: dir, waveH: w.waveH ?? Math.min(6, (w.sea || 0) * 6), waveDir: w.waveDir ?? dir, wavePeriod: w.wavePeriod ?? 3 + 0.6 * spd, swellH: w.swellH ?? 0, swellDir: w.swellDir ?? dir, swellPeriod: w.swellPeriod ?? 9, storm: Number(w.storm) || 0, rain: Number(w.rain) || 0 });
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
    if (Array.isArray(m.fleet)) this.syncFleet(m.fleet, !!m.fleetFull, now);
  }
  /** v6: fleet ships (snap.fleet) drawn and interpolated like AI traffic; labels "<ship> · <owner>" / "· yours" / "· laid up". */
  syncFleet(list, full, now) {
    const seen = new Set();
    for (const f of list) {
      if (!f || !f.id || !Number.isFinite(f.lat) || !Number.isFinite(f.lon)) continue;
      seen.add(f.id);
      const own = f.ownerId === this.you?.id, cls = SHIP_CLASSES[f.cls] ? f.cls : 'coaster';
      const label = `${f.name} · ${f.state === 'laid_up' ? 'laid up' : own ? 'yours' : f.owner}`;
      let o = this.fleetShips.get(f.id);
      if (!o) { o = { id: f.id, cls, mesh: buildShip(cls, label, hashStr(f.id) % 97 + 1), samples: [], cur: { lat: f.lat, lon: f.lon, hdg: f.hdg, spd: f.spd }, vis: { heave: 0, pitch: 0, roll: 0 }, label }; this.scene.add(o.mesh); o.mesh.userData.setLights?.(!!this.lightsOn); this.fleetShips.set(f.id, o); }
      else if (o.cls !== cls) { this.drop(o.mesh); o.cls = cls; o.mesh = buildShip(cls, label, 5); this.scene.add(o.mesh); o.mesh.userData.setLights?.(!!this.lightsOn); }
      if (o.label !== label) { o.label = label; o.mesh.userData.label?.userData.setText(label); }
      Object.assign(o, { name: f.name, owner: f.owner, ownerId: f.ownerId, state: f.state, cond: f.cond, fishing: !!f.fishing, towing: !!f.towing, towCls: f.towCls || null });
      o.mesh.userData.setWear?.(1 - (f.cond ?? 100) / 100);
      o.samples.push({ t: now, lat: f.lat, lon: f.lon, hdg: f.hdg, spd: f.spd }); if (o.samples.length > 4) o.samples.shift();
    }
    for (const [id, o] of this.fleetShips) if (!seen.has(id) && (full || o.state === 'at_sea')) { this.drop(o.mesh); this.fleetShips.delete(id); }
  }
  /** Remove a ship / harbour / wreck / marker group from the scene and free its GPU resources. */
  drop(obj) { if (!obj) return; this.scene.remove(obj); if (obj.userData.wakeGroup?.parent) obj.userData.wakeGroup.parent.remove(obj.userData.wakeGroup); obj.userData.dispose?.(); }
  upsertOther(p, now) {
    let o = this.others.get(p.id);
    if (!o) {
      o = { id: p.id, name: p.name, cls: p.cls, mesh: buildShip(p.cls, p.name, p.id.charCodeAt(0)), samples: [], cur: { lat: p.lat, lon: p.lon, hdg: p.hdg, spd: p.spd }, vis: { heave: 0, pitch: 0, roll: 0 } };
      this.scene.add(o.mesh); this.others.set(p.id, o);
    } else if (o.cls !== p.cls || (p.vid && o.vid && o.vid !== p.vid)) { this.drop(o.mesh); o.cls = p.cls; o.mesh = buildShip(p.cls, p.name, 3); this.scene.add(o.mesh); o.samples = []; o.vname = undefined; } // v6: switched ships — no glide across the map
    o.vid = p.vid;
    if (o.vname !== p.vname) { o.vname = p.vname; o.mesh.userData.label?.userData.setText(p.vname ? `${p.name} — ${p.vname}` : p.name); }
    Object.assign(o, { name: p.name, cond: p.cond, flooding: p.flooding, convoyId: p.convoyId, wanted: p.wanted, docked: p.docked, sinking: p.sinking, towing: p.towing, towCls: p.towCls || null, fishing: !!p.fishing, offline: p.offline, warp: WARP_LEVELS.includes(Number(p.warp)) ? Number(p.warp) : 1 });
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
    this.ocean.shiftOrigin?.(p.x, p.z);
    if (this.camPrevTarget) { this.camPrevTarget.x -= p.x; this.camPrevTarget.z -= p.z; }
    this.terrain.setOrigin(this.origin);
    const mp = toLocal(this.ship.lat, this.ship.lon, this.origin);
    this.ocean.rebuildDepth(mp.x, mp.z, (x, z) => this.heightLocal(x, z), true);
    for (const [id, m] of this.harborMeshes) { const at = m.userData.placeAt; if (at) this.place(m, at.lat, at.lon); else { this.drop(m); this.harborMeshes.delete(id); } }
    for (const [id, m] of this.groundMeshes) { const g = this.world.fishing.find((x) => x.id === id); if (g) this.place(m, g.lat, g.lon); else { this.drop(m); this.groundMeshes.delete(id); } }
    for (const [id, m] of this.platformMeshes) { if (!m) continue; const pl = (this.world.platforms || []).find((x) => x.id === id); if (pl) this.place(m, pl.lat, pl.lon); else { this.drop(m); this.platformMeshes.delete(id); } }
    for (const w of this.wrecks) { const m = this.wreckMeshes.get(w.id); if (m) this.place(m, w.lat, w.lon, -2); }
    for (const o of [...this.others.values(), ...this.cutters.values(), ...this.ai.values(), ...this.rescues.values(), ...this.fleetShips.values()]) { const wg = o.mesh.userData.wakeGroup; if (wg) wg.position.set(wg.position.x - p.x, wg.position.y, wg.position.z - p.z); }
    if (this.myMesh?.userData.wakeGroup) { const wg = this.myMesh.userData.wakeGroup; wg.position.set(wg.position.x - p.x, wg.position.y, wg.position.z - p.z); }
  }
  /** Calm water inside breakwaters: the share of 8 directions blocked by land/quays/breakwaters within 700 m (harbour SDF). */
  shelterAt(x, z) {
    const g = this.geoms; if (!g || !g.entries || !g.entries.size) return 0;
    const ll = fromLocal(x, z, this.origin), s0 = g.sdfAt(ll.lat, ll.lon);
    if (!s0) return 0;
    if (s0.d < 0) return 1;
    let blocked = 0;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2, dx = Math.sin(a), dz = -Math.cos(a);
      let t = Math.max(4, s0.d);
      while (t < 700) {
        const q = fromLocal(x + dx * t, z + dz * t, this.origin), s = g.sdfAt(q.lat, q.lon);
        if (!s) break;
        if (s.d < 1) { blocked++; break; }
        t += Math.max(5, s.d * 0.9);
      }
    }
    return THREE.MathUtils.clamp((blocked / 8 - 0.35) / 0.5, 0, 1);
  }
  refreshShelter() { if (this.ocean.setShelter) this.ocean.setShelter((x, z) => this.shelterAt(x, z)); }
  toggleMute() {
    if (!this.sound) return;
    this.sound.unlock(); this.sound.setMuted(!this.sound.muted);
    this.syncSoundButton();
    this.hud.event?.({ kind: 'info', text: this.sound.muted ? 'Sound off (U)' : 'Sound on (U) — Y sounds the horn' });
  }
  /** Frame-rate governor for the spectral ocean: a slow GPU steps the sea down (grid, foam target, spray, ripples) before
   *  the game becomes unplayable, and steps it back up once there is headroom again. Hidden tabs and hitches are ignored. */
  governOceanQuality(now) {
    if (!this.ocean.setQuality) return;
    const g = this.qGov || (this.qGov = { ema: 1 / 60, since: now, last: now, top: this.ocean.quality ?? 1 });
    const dt = (now - g.last) / 1000; g.last = now;
    if (dt <= 0 || dt > 3 || document.hidden) { g.since = Math.max(g.since, now - 2000); return; } // tab switch / hitch
    g.ema += (dt - g.ema) * 0.05;
    if (now - g.since < 4000) return;
    const q = this.ocean.quality ?? 1;
    if (g.ema > 1 / 24 && q > 0.2) { this.ocean.setQuality(q >= 0.75 ? 0.5 : 0.2); g.since = now; g.ema = 1 / 40; }
    else if (g.ema > 1 / 24 && this.renderer.getPixelRatio() > 0.6) { // still slow on the lowest sea: shade fewer pixels
      this.renderer.setPixelRatio(Math.max(0.6, this.renderer.getPixelRatio() - 0.25)); g.since = now; g.ema = 1 / 40;
    }
    else if (g.ema < 1 / 55 && q < g.top && now - g.since > 20000) { this.ocean.setQuality(q < 0.4 ? 0.5 : g.top); g.since = now; }
  }
  /** The sound toggle lives in the More menu (a floating button collided with the dock and the radar). */
  ensureMuteButton() {
    const b = document.getElementById('btnSound');
    if (!b || b.dataset.wired || !this.sound) return;
    b.dataset.wired = '1';
    b.addEventListener('click', (e) => { e.stopPropagation(); this.toggleMute(); this.hud.closeMore?.(); });
    this.syncSoundButton();
  }
  syncSoundButton() {
    const b = document.getElementById('btnSound'); if (!b || !this.sound) return;
    const m = this.sound.muted;
    this.hud.setIcon?.(b.querySelector('.si'), m ? 'mute' : 'volume');
    const l = b.querySelector('.lbl'); if (l) l.textContent = m ? 'Sound off (U)' : 'Sound on (U)';
  }
  updateSound(dt, now, ashore) {
    const snd = this.sound; if (!snd || !this.ship || !this.you) return;
    if (!this.shelterSet && this.geoms?.entries?.size) { this.shelterSet = true; this.refreshShelter(); }
    this.ensureMuteButton();
    const s = this.ship, you = this.you, st = this.soundState, w = this.wx || {};
    let view = 'deck', room = null;
    if (ashore) view = 'ashore';
    else if (this.interior.active) {
      view = 'interior';
      const I = this.interior, r = I.roomAt?.(I.pos.x, I.pos.z, I.y), id = String(r?.id || '');
      room = id.startsWith('cabin') ? 'cabin' : id === 'engine' ? 'engine' : (id === 'bridge' || id === 'wheelhouse') ? 'bridge' : (id === 'mess' || id === 'saloon' || id === 'galley') ? 'mess' : 'passage';
      if (r?.kind && ['cabin', 'engine', 'bridge', 'mess'].includes(r.kind)) room = r.kind; // deck-plan rooms (shipplan.js) carry their kind
      if (r?.open) { view = 'deck'; room = null; } // out on the open deck: wind and sea, not a room
      if (room === 'bridge') view = 'bridge';
      const moving = I.keys?.size > 0 || this.touchHelm?.stick?.active;
      if (moving && now - this.lastFootstep > (I.run ? 330 : 520)) { this.lastFootstep = now; snd.footstep(room === 'engine' ? 'grating' : room === 'cabin' ? 'wood' : 'steel'); }
    } else if (this.hud.chartOpen?.()) view = 'chart';
    else if (this.cam.mode === 2) view = 'bridge';
    if (ashore && this.ashore?.keys?.size > 0 && now - this.lastFootstep > (this.ashore.run ? 330 : 520)) { this.lastFootstep = now; snd.footstep('concrete'); }
    st.view = view; st.room = room; st.shipCls = s.cls; st.throttle = s.throttle || 0; st.rpmFrac = rpmFraction(s.throttle || 0);
    st.speedKn = Math.abs(s.spd || 0);
    const wspd = this.localWind?.spd ?? this.wind?.spd ?? 0, wdir = this.localWind?.dir ?? this.wind?.dir ?? 0;
    st.windSpd = wspd; st.windRelDeg = angleDiff(s.hdg, wdir);
    st.waveH = Number(w.waveH) || 0; st.rain = Number(w.rain) || 0; st.storm = Number(w.storm) || 0; st.night = this.night || 0;
    st.underway = Math.abs(s.spd || 0) > 0.5 || Math.abs(s.throttle || 0) > 0.05; st.docked = !!you.docked; st.towing = !!you.towing; st.warp = this.warp || 1;
    if (now - this.lastNearHarbor > 1000) {
      this.lastNearHarbor = now;
      let nd = Infinity; for (const hb of this.world.harbors || []) { const d = haversine(s.lat, s.lon, hb.lat, hb.lon); if (d < nd) nd = d; }
      st.nearHarborM = Number.isFinite(nd) ? nd : null;
      const ships = [];
      const add = (o, cls) => { if (!o?.cur) return; const d = haversine(s.lat, s.lon, o.cur.lat, o.cur.lon); if (d > 2500) return; ships.push({ id: o.id, distM: d, bearingRel: angleDiff(s.hdg, bearing(s.lat, s.lon, o.cur.lat, o.cur.lon)), cls, speedKn: Math.abs(o.cur.spd || 0) }); };
      for (const o of this.others.values()) add(o, o.cls);
      for (const a of this.ai.values()) add(a, a.cls);
      for (const c of this.cutters.values()) add(c, 'pilot');
      for (const v of this.aisLayer.others({ rangeM: 2500 })) add({ id: v.id, cur: v }, 'coaster');
      ships.sort((a, b) => a.distM - b.distM); st.nearShips = ships.slice(0, 4);
    }
    snd.update(st, dt);
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
            if (this.ashore?.active && this.ashore.harborId === h.id) m.userData.setAshore?.(true); // rebuilt under the walker's feet
          }
        }
      } else if (d > SCENERY_UNLOAD_M && has) { this.drop(has); this.harborMeshes.delete(h.id); }
    }
    // V7 big ports (server/bigports.js): extra 4.48 km patches tiled over the port around the harbour's own patch —
    // real quays, docks and buildings where the terminals are. Only the near ones load (a patch is a 448² mesh); the
    // scenery appears once the geometry is in (no compact fallback, no name board).
    for (const sp of this.world.patches || []) {
      const d = unitsBetween(s.lat, s.lon, sp.lat, sp.lon);
      const gs = this.geomState.get(sp.id);
      if (d < SUBPATCH_LOAD_M && !this.geoms.has(sp.id) && !this.geoms.isLoading(sp.id) && (!gs || gs.state !== 'failed' || now - gs.t > GEOM_RETRY_MS)) this.loadGeom(sp);
      else if (d > SUBPATCH_UNLOAD_M && (this.geoms.has(sp.id) || this.geoms.isLoading(sp.id))) this.unloadGeom(sp.id);
      const entry = this.geoms.get(sp.id), has = this.harborMeshes.get(sp.id);
      if (entry && !has) {
        let m = null;
        try { m = buildHarbor({ id: sp.id, name: '', sub: true, size: 'regional' }, entry.geom); } catch (e) { console.warn('[harbor] patch build failed', sp.id, e); }
        if (m) {
          const at = { lat: entry.geom.origin.lat, lon: entry.geom.origin.lon };
          m.userData.geomId = entry.id; m.userData.placeAt = at;
          this.place(m, at.lat, at.lon); this.scene.add(m); this.harborMeshes.set(sp.id, m);
          m.userData.setNight?.(this.night, this.time);
        }
      } else if (!entry && has) { this.drop(has); this.harborMeshes.delete(sp.id); }
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
    const cam = this.camera.position, onFoot = !!this.ashore?.active; // ashore the street signs name things, not the harbour label
    for (const m of this.harborMeshes.values()) { const l = m.children.find((c) => c.isSprite); if (l) l.visible = !onFoot && m.position.distanceTo(cam) < 3200; }
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
      const k = String(e.key || '').toLowerCase();
      if (k === 'enter') { document.getElementById('chatInput')?.focus(); e.preventDefault(); return; }
      if (k === 'escape') {
        if (this.interior.active && this.interior.handleKey(e)) return;
        if (this.hud.transientOpen()) this.hud.closeOverlays(); else if (this.hud.harborOpen()) this.hud.hideHarbor(); return; // chart/ships/help first, harbour panel next
      }
      if (k === 'g') return this.toggleAshore();
      if (k === 'y' && !this.interior.active && !this.ashore?.active) { this.sound?.unlock(); this.sound?.horn(e.shiftKey ? 'short' : 'long'); return; }
      if (k === 'u' && !this.interior.active && !this.ashore?.active) { this.toggleMute(); return; }
      if (k === 'i') return this.toggleInterior();
      // the walkers (on foot ashore, below decks) get their keys first: WASD walk, E use, V view, T taxi ashore …
      if (this.ashore?.active && this.ashore.handleKey(e)) return;
      if (this.interior.active && this.interior.handleKey(e)) return;
      if (k === 'm') return this.hud.toggleChart();
      if (k === 'tab') { e.preventDefault(); return this.hud.toggleShips(); }
      if (k === 'h') return document.getElementById('helpWrap')?.classList.toggle('hidden');
      if (k === 'r' && this.hud.chartOpen()) { this.hud.chartMode = this.hud.chartMode === 'region' ? 'world' : 'region'; this.hud.drawChart(); return; }
      if (k === 'l') return this.market?.toggle();
      if (k === 'o') return this.hq?.toggle();
      if (this.ashore?.active) return; // ashore: the ship's controls are aboard
      if (k === 't') return this.toggleDock();
      if (k === 'j') return this.jobAction();
      if (k === 'f') return this.net.action('fish', { on: !this.you?.fishing });
      if (k === 'k') return this.net.action('patch');
      if (k === 'p') return this.toggleAutopilot();
      if (k === 'c') { this.cycleCamera(); return; }
      if (k === 'x') { this.clearRoute(); return; }
      if (k === 'n') return this.requestTugs();
      if (k === '.' || k === '>') { e.preventDefault(); return this.stepWarp(1); }
      if (k === ',' || k === '<') { e.preventDefault(); return this.stepWarp(-1); }
      if (this.you?.docked || this.you?.assist) return;
      // W/S step the engine order telegraph one order at a time (Shift: fine 5 % steps between the orders)
      if (k === 'w' || k === 'arrowup') { e.preventDefault(); if (e.shiftKey || !this.telegraph) this.nudgeThrottle(e.shiftKey ? 0.05 : 0.1); else this.telegraph.step(1, e.repeat); }
      if (k === 's' || k === 'arrowdown') { e.preventDefault(); if (e.shiftKey || !this.telegraph) this.nudgeThrottle(e.shiftKey ? -0.05 : -0.1); else this.telegraph.step(-1, e.repeat); }
      if (k === 'a' || k === 'arrowleft') { this.manualHelm(); this.input.left = true; this.autopilot = false; }
      if (k === 'd' || k === 'arrowright') { this.manualHelm(); this.input.right = true; this.autopilot = false; }
      if (k === ' ') { this.manualHelm(); this.input.rudderCmd = 0; this.input.throttleCmd = 0; this.touchHelm?.setThrottle?.(0); this.touchHelm?.setRudder?.(0); e.preventDefault(); }
      if (k === 'b') this.boardNearest();
      if (k === 'v') this.salvageNearest();
    });
    window.addEventListener('keyup', (e) => { const k = String(e.key || '').toLowerCase(); if (k === 'a' || k === 'arrowleft') this.input.left = false; if (k === 'd' || k === 'arrowright') this.input.right = false; });
    // camera: one-pointer drag orbits (mouse or finger), two fingers pinch to zoom, wheel zooms (the walkers own theirs)
    const pointers = new Map();
    let pinch = null;
    this.canvas.addEventListener('pointerdown', (e) => {
      if (this.walking()) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { this.canvas.setPointerCapture(e.pointerId); } catch {}
      if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), dist: this.cam.dist }; }
    });
    this.canvas.addEventListener('pointermove', (e) => {
      const pt = pointers.get(e.pointerId); if (!pt) return;
      if (this.walking()) { pointers.delete(e.pointerId); pinch = null; return; }
      if (pointers.size >= 2 && pinch) {
        pt.x = e.clientX; pt.y = e.clientY;
        const [a, b] = [...pointers.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d > 10) this.cam.dist = this.clampZoom((pinch.dist * pinch.d) / d);
        return;
      }
      const dx = e.clientX - pt.x, dy = e.clientY - pt.y;
      if (this.cam.mode === 2) this.cam.look = (this.cam.look || 0) + dx * 0.006; // bridge view: look around relative to the bow
      else this.cam.yaw -= dx * 0.006;
      this.cam.pitch = THREE.MathUtils.clamp(this.cam.pitch + dy * 0.004, 0.05, 1.3); this.cam.free = true; this.cam.lastDrag = performance.now();
      pt.x = e.clientX; pt.y = e.clientY;
    });
    const tap = { x: 0, y: 0, t: 0 };
    this.canvas.addEventListener('pointerdown', (e) => { tap.x = e.clientX; tap.y = e.clientY; tap.t = performance.now(); }, true);
    const endPointer = (e) => {
      if (e.type === 'pointerup' && pointers.size === 1 && !this.walking() && performance.now() - tap.t < 450 && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 8) this.pickAt(e.clientX, e.clientY);
      pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null;
    };
    this.canvas.addEventListener('pointerup', endPointer);
    this.canvas.addEventListener('pointercancel', endPointer);
    this.canvas.addEventListener('lostpointercapture', endPointer);
    this.canvas.addEventListener('wheel', (e) => { if (this.walking()) return; this.cam.dist = this.clampZoom(this.cam.dist * (1 + Math.sign(e.deltaY) * 0.12)); e.preventDefault(); }, { passive: false });
    // A key held while focus leaves the page never gets its keyup (alt-tab, confirm() dialogs): release everything.
    const reset = () => { this.releaseControls(); pointers.clear(); pinch = null; };
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) return;
      reset();
      // a hidden tab stops the frame loop, so the ship stops moving while the server would keep charging fuel and wear × warp
      if (this.warp > 1) this.setWarp(1, 'Game hidden — time warp off (your ship only sails ahead while the game is on screen).');
    });
    // buttons the HUD may not bind itself (it owns them in v0.4; a HUD binding is never overridden, so nothing double-fires)
    const btn = (id, fn) => { const b = document.getElementById(id); if (b && !b.onclick) b.onclick = fn; };
    btn('btnInterior', () => this.toggleInterior());
    btn('btnSails', () => this.setSails(!(this.you?.sailsUp !== false)));
    btn('btnTugs', () => this.requestTugs());
    btn('btnMoor', () => this.toggleDock());
    btn('btnAshore', () => this.toggleAshore());
    btn('btnAboard', () => this.toggleAshore());
    btn('warpUp', () => this.stepWarp(1));
    btn('warpDown', () => this.stepWarp(-1));
    this.bindTouch();
  }
  /** Walking on foot (below decks or ashore): those modes own the camera and the pointer. */
  walking() { return !!(this.interior.active || this.ashore?.active); }
  shipLength() { return SHIP_CLASSES[this.ship?.cls || this.you?.ship?.cls]?.length || this.myMesh?.userData.length || 60; }
  clampZoom(d) { const L = this.shipLength(); return THREE.MathUtils.clamp(d, camZoomMin(L), camZoomMax(L)); }
  cycleCamera() { if (!this.walking()) this.cam.mode = (this.cam.mode + 1) % 3; }
  nudgeThrottle(d) { if (this.you?.docked || this.you?.assist) return; this.manualHelm(); this.input.throttleCmd = THREE.MathUtils.clamp(Math.round((this.input.throttleCmd + d) * 20) / 20, THROTTLE_MIN, 1); this.touchHelm?.setThrottle?.(this.input.throttleCmd); }
  releaseControls() { this.input.left = this.input.right = false; for (const id of ['tchPort', 'tchStbd']) document.getElementById(id)?.classList.remove('on'); }
  /** Touch devices: the TouchHelm sliders (C2) drive the same input state as the keys; the v0.2 hold buttons keep working too. */
  bindTouch() {
    if (!isTouch()) return;
    document.body.classList.add('touch');
    try {
      const root = document.getElementById('touchHelm') || document.getElementById('hud') || document.body;
      this.touchHelm = new TouchHelm(root, {
        onThrottle: (v) => { if (this.you?.docked || this.you?.assist) return; v = Number(v) || 0; if (Math.abs(v) > 1.5) v /= 100; this.manualHelm(); this.input.throttleCmd = THREE.MathUtils.clamp(v, THROTTLE_MIN, 1); },
        // `active` = a finger is on the slider. Without it the slider is only re-centring (or mirroring the autopilot):
        // that must never switch the autopilot off or count as manual helm.
        onRudder: (v, active) => {
          if (this.you?.docked || this.you?.assist) return;
          v = Number(v) || 0; if (Math.abs(v) > 1.5) v /= 100; v = THREE.MathUtils.clamp(v, -1, 1);
          const finger = active !== false;
          if (finger) { if (Math.abs(v) > 0.01) { this.manualHelm(); this.autopilot = false; } this.input.rudderCmd = v; this.input.rudderHold = Math.abs(v) > 0.01; }
          else if (!this.autopilot) { this.input.rudderCmd = v; this.input.rudderHold = Math.abs(v) > 0.01; }
        },
        onAllStop: () => { this.manualHelm(); this.input.rudderCmd = 0; this.input.throttleCmd = 0; this.input.rudderHold = false; },
        onDock: () => this.toggleDock(), onChart: () => this.hud.toggleChart(), onInterior: () => this.toggleInterior(), onCamera: () => this.cycleCamera(), onAshore: () => this.toggleAshore(),
      });
    } catch (e) { console.warn('[touch] helm unavailable', e); this.touchHelm = null; }
    const hold = (id, key) => {
      const b = document.getElementById(id); if (!b) return;
      const on = (e) => { e.preventDefault(); if (this.you?.docked) return; this.manualHelm(); this.input[key] = true; this.autopilot = false; b.classList.add('on'); };
      const off = () => { this.input[key] = false; b.classList.remove('on'); };
      b.addEventListener('pointerdown', on);
      for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) b.addEventListener(ev, off);
    };
    hold('tchPort', 'left'); hold('tchStbd', 'right');
    document.getElementById('tchThrUp')?.addEventListener('click', () => (this.telegraph ? this.telegraph.step(1) : this.nudgeThrottle(0.1)));
    document.getElementById('tchThrDn')?.addEventListener('click', () => (this.telegraph ? this.telegraph.step(-1) : this.nudgeThrottle(-0.1)));
  }
  // T / the Dock button: dock when at sea; while docked they (re)open the harbour panel if it is closed (the server
  // answers 'dock' from a docked player with the harbour payload) and cast off when it is open. Cast off is explicit too.
  toggleDock() {
    if (!this.you) return;
    if (!this.you.docked) return this.net.action('dock');
    if (!this.hud.harborOpen()) return this.net.action('dock');
    this.castOff();
  }
  castOff() {
    if (!this.you?.docked) return;
    if (this.ashore?.active) { this.hud.event({ kind: 'warn', text: 'Go aboard first (G) — the ship cannot cast off without her skipper.' }); return; }
    this.net.action('undock');
  }
  /** A tap / click on the 3D view: a live AIS ship under it opens its info card. */
  pickAt(cx, cy) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    const rc = this._raycaster || (this._raycaster = new THREE.Raycaster());
    rc.setFromCamera(ndc, this.camera);
    const v = this.aisLayer.pick(rc);
    if (v) this.hud.showAisCard?.(this.aisLayer.info(v), v); else this.hud.showAisCard?.(null);
  }
  /** The contract card's action (J): pass the tow line, crane transfer, nets out / in. `t` = a jobTargets() entry. */
  jobAction(t) {
    t = t || this.hud.jobShown || (this.jobTargets || []).find((x) => x.action);
    if (!t?.action) { this.hud.event({ kind: 'info', text: (this.jobTargets || []).length ? 'Nothing to do here for your contracts yet — follow the beacon.' : 'No contracts aboard. Sign one at the harbour master.' }); return; }
    if (!t.action.enabled) { this.hud.event({ kind: 'warn', text: `${t.action.label}: ${t.action.why || 'not possible right now'}.` }); return; }
    const id = t.action.id;
    if (id === 'fish' || id === 'fish_off') this.net.action('fish', { on: id === 'fish' });
    else this.net.action(id, { jobId: t.job.id });
    this.sound?.ui?.('click');
  }
  /** Lay a sea route to a contract target (server route planner: straight over open water, else along the lanes). */
  async routeToJob(t) {
    const s = this.ship; if (!s || !t || !Number.isFinite(t.lat)) return;
    let to = { lat: t.lat, lon: t.lon };
    if (t.kind === 'ground' && t.distM > t.rangeM) to = destination(t.lat, t.lon, bearing(t.lat, t.lon, s.lat, s.lon), Math.max(0, t.rangeM - 2000)); // the near edge of the bank
    const harbor = t.kind === 'harbor' ? t.job.to : null;
    // route planner v2 for this hull's draught; the crew steers it at sea (any helm input takes over again)
    return this.pilot.planTo({ lat: to.lat, lon: to.lon, harbor, label: t.name || 'contract', engage: !this.you?.docked });
  }
  requestTugs() {
    const you = this.you; if (!you || you.docked || you.assist) return;
    const C = SHIP_CLASSES[you.ship.cls];
    const cost = Math.max(400, Math.round(C.displacement * 0.35));
    if (!you.nearBerth) return this.hud.event({ kind: 'warn', text: 'No berth within reach of the tugs (get within 1.5 km of the harbour, under 6 kn).' });
    if (confirm(`Request tugs to ${you.nearBerth.name || 'the berth'} for ${cost.toLocaleString()} cr?`)) this.net.action('tug_assist');
  }
  toggleInterior() {
    if (this.interior.active) { this.interior.exit(); return; }
    if (this.ashore?.active) { this.hud.event({ kind: 'warn', text: 'Go back aboard first (G).' }); return; } // the two walkers are mutually exclusive
    this.releaseControls();
    if (!this.interior.enter()) this.hud.event({ kind: 'warn', text: 'Nothing to go below into yet — wait for your ship.' });
  }
  /**
   * Go ashore / back aboard (docs/V4-CONTRACTS.md §3). Only while moored; leaves the interior first. Returns the
   * Ashore.enter promise (→ boolean) when going ashore, true when coming back aboard, false when refused.
   */
  toggleAshore() {
    const a = this.ashore;
    if (a?.active) { a.exit(); this.afterAshoreChange(); return true; }
    const you = this.you;
    if (!you?.docked) { this.hud.event({ kind: 'warn', text: 'Moor at a berth first, then go ashore.' }); return false; }
    if (this.warp > 1) this.setWarp(1, 'Going ashore — time warp off.'); // V6 item 6: walking the quay must not burn contract hours 5×
    if (!a) {
      // the module is still loading (or failed): try once more when it arrives
      return this.ashoreReady.then((inst) => {
        if (!inst) { this.hud.event({ kind: 'warn', text: 'Going ashore is not available right now.' }); return false; }
        return inst.active ? true : this.toggleAshore();
      });
    }
    if (this.interior.active) this.interior.exit();
    this.releaseControls(); this.autopilot = false;
    this.input.throttleCmd = 0; this.input.rudderCmd = 0; this.input.rudderHold = false; this.touchHelm?.setThrottle?.(0);
    this.cam.mode = this.cam.mode === 2 ? 0 : this.cam.mode; // come back to the chase view, not the bridge
    let p;
    try { p = Promise.resolve(a.enter(you.docked)); } catch (e) { console.warn('[ashore] enter threw', e); p = Promise.resolve(false); }
    return p.then((ok) => { this.afterAshoreChange(); return !!ok; }, (e) => { console.warn('[ashore] enter failed', e); this.afterAshoreChange(); return false; });
  }
  afterAshoreChange() {
    this.camPrevTarget = null; this.cam.free = false;
    // the harbour name label comes back with the next scenery pass; the HUD follows app.ashore.active
    this.updateScenery();
    this.hud.showAshoreHint?.(null); // the default line until the walker reports the nearest door
    this.hud.syncModes?.();
  }
  setSails(up) {
    const you = this.you; if (!you) return;
    up = !!up;
    this.net.action('sails', { up });
    this.myMesh?.userData.setSails?.(up, this.windRel());
    this.hud.setSailsButton?.(!!SHIP_CLASSES[you.ship.cls]?.sail, up);
  }
  /** Relative wind angle in degrees (0 = on the bow, 90 = from starboard). */
  windRel() { const w = this.localWind || this.wind; const from = Number.isFinite(w?.dir) ? w.dir : normDeg((Math.atan2(-(w?.u || 0), -(w?.v || 0)) * 180) / Math.PI); return normDeg(from - (this.ship?.hdg || 0)); }
  toggleAutopilot() { return this.pilot.engage(!this.autopilot); }
  /** Route API used by the chart: ordered waypoints the autopilot follows. */
  setRoute(points, opts = {}) {
    // planned points keep their `mark` (approach / tss / patch_exit / canal), `name` and user-waypoint index `wp`
    const pts = (points || []).map((p) => {
      const q = { lat: Number(Array.isArray(p) ? p[0] : p.lat), lon: Number(Array.isArray(p) ? p[1] : p.lon) };
      if (p && !Array.isArray(p)) { if (p.mark) q.mark = p.mark; if (p.name) q.name = p.name; if (Number.isInteger(p.wp)) q.wp = p.wp; }
      return q;
    }).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    this.route = pts;
    if (!opts.planned) { this.routeMeta = null; this.pilot?.clear(); } // a raw route: no plan behind it
    if (!pts.length) { this.autopilot = false; if (this.warp > WARP_MAX_NO_ROUTE) this.setWarp(WARP_MAX_NO_ROUTE, `Route cleared — time warp back to ${WARP_MAX_NO_ROUTE}×.`); return; }
    const total = this.routeLength();
    if (this.warp > WARP_MAX_NO_ROUTE) this.autopilot = true; // above 20× the crew sails the (new) route
    const from = this.ship || pts[0];
    if (opts.planned) return; // the pilot tells the skipper about a planned route itself
    this.hud.event({ kind: 'info', text: `Route set: ${pts.length} waypoint${pts.length > 1 ? 's' : ''}, ${fmtDistance(total)}, first leg bearing ${Math.round(bearing(from.lat, from.lon, pts[0].lat, pts[0].lon))}°. ${this.autopilot ? 'Autopilot steering.' : 'Press P for autopilot, . / , for time warp.'}` });
  }
  clearRoute() {
    this.route = []; this.autopilot = false; this.pilot?.clear(); this.routeMeta = null; this.hud.chart?.clearRoute?.(true);
    if (this.warp > WARP_MAX_NO_ROUTE) this.setWarp(WARP_MAX_NO_ROUTE, `Route cleared — time warp back to ${WARP_MAX_NO_ROUTE}×.`);
  }

  // ------------------------------------------------------------------ time warp (docs/V4-CONTRACTS.md §1)
  warpLevels() { const L = this.world?.warp?.LEVELS; return Array.isArray(L) && L.length ? L : WARP_LEVELS; }
  /** One level up (+1) or down (-1): keys . and , (the HUD's ◀◀ ▶▶ call setWarp directly). */
  stepWarp(dir) {
    const you = this.you; if (!you) return false;
    const L = this.warpLevels();
    // a raise still waiting for the server's answer counts, so two quick presses step two levels
    const req = this.warpReq, base = req && req.f > this.warp && performance.now() - req.t < 1500 ? req.f : this.warp;
    // V6 item 6: inside a harbour zone (moored, tugs, approach, built patch) 5× is the top
    const hMax = Number(this.world?.warp?.HARBOR_MAX ?? WARP?.HARBOR_MAX) || 5;
    if (dir > 0 && you.warpLimit?.harbour && base >= hMax) { this.hud.event({ kind: 'warn', text: `Inside harbours time warp is limited to ${hMax}×.` }); return false; }
    let i = L.indexOf(base); if (i < 0) i = L.reduce((bi, v, k) => (Math.abs(v - base) < Math.abs(L[bi] - base) ? k : bi), 0);
    const next = L[Math.max(0, Math.min(L.length - 1, i + (dir > 0 ? 1 : -1)))];
    return next === base ? false : this.setWarp(next);
  }
  /**
   * Ask the server for warp level `factor` (`net.action('set_warp', {factor, route})`). Lowering is applied at once (it is
   * always allowed); raising waits for the server's `you.warp`, which then becomes `app.warp`. Above 20× the route is
   * required and the autopilot takes over. `note` = an event line explaining a client-side drop.
   */
  setWarp(factor, note) {
    const f = Number(factor), L = this.warpLevels();
    if (!L.includes(f)) return false;
    const you = this.you; if (!you) return false;
    if (f > 1) {
      const hMax = Number(this.world?.warp?.HARBOR_MAX ?? WARP?.HARBOR_MAX) || 5;
      if (f > hMax && you.warpLimit?.harbour) { this.hud.event({ kind: 'warn', text: `Inside harbours time warp is limited to ${hMax}×.` }); return false; }
      if (f > WARP_MAX_NO_ROUTE && !this.route.length) { this.hud.event({ kind: 'warn', text: `Above ${WARP_MAX_NO_ROUTE}× the crew needs a route to follow — plot one on the chart (M) and sail it.` }); return false; }
      if (f > WARP_MAX_NO_ROUTE) {
        this.autopilot = true; this.input.rudderHold = false; this.input.left = this.input.right = false;
        // the crew sails the route ahead: an astern order would back the ship away from it at hundreds × real time
        if (this.input.throttleCmd < 0) { this.input.throttleCmd = 0.7; this.touchHelm?.setThrottle?.(0.7); this.hud.event({ kind: 'info', text: 'The crew rings HALF AHEAD to sail the route.' }); }
      }
    }
    const now = performance.now();
    const raisePending = !!this.warpReq && this.warpReq.f > f && now - this.warpReq.t < WARP_HOLD_MS; // asked higher, not answered yet
    if (f < this.warp || raisePending) { // lowering: follow at once and ignore stale higher answers for a moment
      if (f < this.warp) this.applyWarp(f);
      this.warpHold = { f, until: now + WARP_HOLD_MS }; this.warpReq = null;
    } else if (f === 1 && (Number(you.warp) || 1) === 1) return true; // already in real time on both sides
    else if (f > this.warp) this.warpReq = { f, t: now };
    if (note) this.hud.event({ kind: 'info', text: note });
    const route = this.route.slice(0, ROUTE_SEND_MAX).map((p) => ({ lat: Math.round(p.lat * 1e5) / 1e5, lon: Math.round(p.lon * 1e5) / 1e5 }));
    this.net.action('set_warp', { factor: f, route });
    return true;
  }
  /** Mirror the server's level (`you.warp`): a drop is followed at once; a raise only once we have not just lowered it ourselves. */
  syncWarp(serverWarp, you) {
    let w = you?.rescue ? 1 : serverWarp; // V6 item 6: docked and assisted ships may be warped (≤ 5×)
    const hold = this.warpHold;
    if (hold) { if (w <= hold.f || performance.now() > hold.until) this.warpHold = null; else w = Math.min(w, hold.f); }
    if (w !== this.warp) this.applyWarp(w);
  }
  applyWarp(f) {
    f = WARP_LEVELS.includes(f) ? f : 1;
    if (f === this.warp) return;
    this.warp = f;
    if (f > WARP_MAX_NO_ROUTE && this.route.length) { this.autopilot = true; this.input.rudderHold = false; }
  }
  /** Any manual throttle / rudder input above 20× hands the ship back to real time (contract §1). */
  manualHelm() { if (this.warp > WARP_MAX_NO_ROUTE) this.setWarp(1, 'Manual helm — time warp off.'); }
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
    // Time warp: the ship's own clock runs `warp` times faster (the world clock and everything else stay real time).
    const warp = this.warp > 1 ? this.warp : 1;
    const simDt = dt * warp;
    const topLevel = warp >= WARP_LEVELS[WARP_LEVELS.length - 1];
    const steerByRoute = this.autopilot && this.route.length > 0;
    // manual rudder (keys held / touch slider) follows the hand in REAL time; at the top warp level only the route steers
    if (!steerByRoute) {
      if ((this.input.left || this.input.right) && !topLevel) {
        this.input.rudderCmd = THREE.MathUtils.clamp(this.input.rudderCmd + (this.input.left ? -1 : 1) * dt * 1.4, -1, 1);
      } else if (!this.input.rudderHold || topLevel) { this.input.rudderCmd += (0 - this.input.rudderCmd) * Math.min(1, dt * 2.5); if (Math.abs(this.input.rudderCmd) < 0.02) this.input.rudderCmd = 0; }
    }
    const cur = currentAt(s.lat, s.lon, this.simTime);
    const env = {
      cond: you.cond, flooding: you.flooding, loadFrac: you.cargo.reduce((a, c) => a + c.qty, 0) / C.capacity, wind: this.localWind || this.wind, current: cur,
      tideStream: this.tide?.stream || null, sea: this.wx?.sea ?? 0, waveH: this.wx?.waveH ?? 0, sailsUp: you.sailsUp !== false, towing: !!you.towing,
      fuelEmpty: you.fuelEmpty, grounded: false,
    };
    // ≤ SUBSTEP_S of sim time per step, at most MAX_SUBSTEPS per frame; the autopilot steers and the keel is checked
    // every substep, so even 400× follows the route leg by leg and cannot hop over a spit between two frames
    const sub = Math.max(1, Math.min(MAX_SUBSTEPS, Math.ceil(simDt / SUBSTEP_S)));
    const h = simDt / sub;
    const cmd = { throttleCmd: this.input.throttleCmd, rudderCmd: this.input.rudderCmd };
    let aground = null;
    for (let i = 0; i < sub; i++) {
      if (this.autopilot && this.route.length) { if (!this.autopilotStep(s, C)) this.input.rudderCmd = 0; }
      if (this.warp !== warp) break; // dropped mid-frame (destination reached): the rest of this frame's warped time is not sailed
      cmd.throttleCmd = this.input.throttleCmd; cmd.rudderCmd = this.input.rudderCmd;
      const pLat = s.lat, pLon = s.lon;
      stepShip(s, cmd, env, h);
      aground = this.keelCheck(s, C, pLat, pLon);
      if (aground) break;
    }
    if (aground) this.onGrounding(aground.bump);
    // quays, breakwaters, land of the loaded harbour patches, and other hulls (ship–ship only up to 20×: above it the
    // hull covers hundreds of metres a frame and the watch keeps clear of traffic)
    const res = resolveShip(s, C, this.geoms, dt, warp <= WARP_SHIP_COLLIDE_MAX ? this.collisionOthers() : null);
    if (res.hit) this.onCollision(res);
    this.net.sendState(s);
  }
  /**
   * Autopilot: steer for the head of the route, advance it when the waypoint is reached. Returns false when the route
   * is finished (autopilot off; time warp back to real time so the ship does not run on past the destination warped).
   */
  autopilotStep(s, C) {
    if (this.pilot) return this.pilot.step(s, C); // v6: route planner v2 + harbour speed bands + berth hand-over (autopilot.js)
    const wp = this.route[0];
    const brg = bearing(s.lat, s.lon, wp.lat, wp.lon);
    this.input.rudderCmd = s.spd < -0.3 ? 0 : THREE.MathUtils.clamp(angleDiff(s.hdg, brg) / 25, -1, 1); // going astern the rudder works backwards: the autopilot holds it amidships
    const d = unitsBetween(s.lat, s.lon, wp.lat, wp.lon);
    const reach = this.route.length > 1 ? Math.max(300, C.length * 3) : Math.max(200, C.length * 2);
    if (d >= reach) return true;
    this.route.shift();
    if (this.route.length) { this.hud.event({ kind: 'info', text: `Waypoint reached, ${this.route.length} to go.` }); return true; }
    this.autopilot = false; this.input.rudderCmd = 0;
    this.hud.event({ kind: 'info', text: 'Route complete — waypoint reached.' });
    this.hud.chart?.clearRoute?.(true);
    if (this.warp > 1) this.setWarp(1, 'Destination reached — time warp off.');
    return false;
  }
  /**
   * Depth under the keel (loaded terrain + tide) after a substep from (pLat, pLon). Refuses only moves that go SHALLOWER
   * than where the ship already was, so a ship sitting on a shallow reading can still back (or push) off towards deeper
   * water. Returns null when the water is deep enough, else {bump} after putting the ship back.
   */
  keelCheck(s, C, pLat, pLon) {
    const hh = this.terrain.heightAt(s.lat, s.lon);
    if (hh == null || -hh + this.tideLevel >= C.draft) return null;
    const hPrev = this.terrain.heightAt(pLat, pLon);
    if (hPrev != null && hh <= hPrev) return null;
    s.lat = pLat; s.lon = pLon;
    const bump = Math.abs(s.spd) > 0.5;
    if (bump) s.spd *= 0.15; else s.spd = 0;
    return { bump };
  }
  onGrounding(bump) {
    if (this.warp > 1) this.setWarp(1, 'Aground — time warp off.');
    const now = performance.now();
    if (now - this.lastGrounding > 4000) { // always tell the player; only a real bump costs hull condition
      this.lastGrounding = now;
      if (bump) { this.net.action('grounding'); this.sound?.event('grounding', Math.min(1, Math.abs(this.ship?.spd || 0) / 6)); }
      this.hud.alert('ground', 'AGROUND — reverse off (S)', ''); setTimeout(() => this.hud.clearAlert('ground'), 4000);
    }
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
    for (const f of this.fleetShips.values()) { if (f.state === 'docked' || f.state === 'laid_up') continue; push(f, SHIP_CLASSES[f.cls] || f.mesh.userData); }
    for (const v of this.aisLayer.others({ rangeM: 600 })) out.push(v); // real AIS hulls at their reported size
    return out;
  }
  onCollision(res) {
    const now = performance.now();
    this.flash();
    const kindTxt = res.kind === 'ship' ? 'another hull' : res.kind === 'breakwater' ? 'the breakwater' : res.mask === 1 ? 'the shore' : 'the quay';
    this.hud.alert('coll', `COLLISION — hit ${kindTxt} at ${res.speedKn.toFixed(1)} kn`, ''); setTimeout(() => this.hud.clearAlert('coll'), 3500);
    if (now - this.lastCollision > COLLISION_RATE_MS) { this.lastCollision = now; this.net.action('collision', { speedKn: res.speedKn, kind: res.kind || 'quay' }); this.sound?.event('collision', Math.min(1, (res.speedKn || 1) / 8)); }
  }
  interp(o, now) {
    const S = o.samples; if (!S.length) return;
    const t = now - 150;
    let a = S[0], b = S[S.length - 1];
    for (let i = 0; i < S.length - 1; i++) if (S[i].t <= t && S[i + 1].t >= t) { a = S[i]; b = S[i + 1]; break; }
    let lat, lon, hdg;
    if (t >= b.t) { // extrapolate briefly by dead reckoning (a warped skipper's ship runs `warp` times faster)
      const dtE = Math.min(1.0, (t - b.t) / 1000);
      const v = b.spd * GEO.KN_TO_MS * SIM.MOTION_SCALE * (o.warp > 1 ? o.warp : 1) * dtE;
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
    const ud = mesh.userData, h = hdg * D2R;
    // per-class second-order heave / pitch / roll driven by the real wave field (motion.js); one state per mesh
    if (!vis.motion || vis.motionCls !== ud.cls) { vis.motion = createMotion(ud.cls); vis.motionCls = ud.cls; }
    const C = SHIP_CLASSES[ud.cls];
    const own = mesh === this.myMesh;
    const ctx = vis.ctx || (vis.ctx = {});
    ctx.length = ud.length; ctx.beam = ud.beam; ctx.draft = ud.draft; ctx.freeboard = ud.freeboard;
    ctx.displacementT = C?.displacement || Math.max(5, ud.length * ud.beam * (ud.draft || 2) * 0.55);
    ctx.speedKn = spd || 0; ctx.hdgRad = h; ctx.x = p.x; ctx.z = p.z; ctx.time = this.time; ctx.ocean = this.ocean;
    ctx.throttle = own ? (this.ship?.throttle || 0) : 0; ctx.rudder = own ? (this.ship?.rudder || 0) : 0;
    ctx.flooding = flooding || 0; ctx.docked = !!docked;
    ctx.windSpd = this.localWind?.spd ?? this.wind?.spd ?? 0; ctx.windDir = this.localWind?.dir ?? this.wind?.dir ?? 0;
    ctx.gust = Number(this.localWind?.gust) || undefined;
    ctx.sails = own ? this.you?.sailsUp !== false : true;
    const r = stepMotion(vis.motion, ctx, dt);
    vis.heave = r.heave; vis.pitch = r.pitch; vis.roll = r.roll; vis.slam = r.slam; vis.greenWater = r.greenWater;
    if (own && r.slam > 0.5 && this.time - (this.lastSlamSound || 0) > 1.5) { this.lastSlamSound = this.time; this.sound?.event('splash', r.slam); }
    const sink = flooding >= 1 ? Math.min(60, (vis.sinkT = (vis.sinkT || 0) + dt) * 6) : 0;
    if (flooding < 1) vis.sinkT = 0;
    mesh.position.y = r.heave + this.tideLevel - flooding * (ud.freeboard + 2) - sink; // the flooding list is already in roll
    mesh.rotation.set(r.pitch, -h, r.roll, 'YXZ');
    mesh.userData.setWake?.(Math.abs(spd) / 10);
    mesh.userData.setWaterY?.(mesh.position.y);
    if (ud.updateWake) {
      if (ud.wakeGroup && !ud.wakeGroup.parent) this.scene.add(ud.wakeGroup);
      ud.updateWake(dt, mesh.position, h, flooding >= 1 ? 0 : spd);
    }
  }
  /** Spray over the bow on slams, green water on the foredeck, spindrift around the ship, water on the lens. */
  feedHeavyWeather(dt, ashore) {
    const m = this.myMesh, vis = this.myVis, fx = this.weatherFx; if (!m || !vis || !fx?.heavy) return;
    const ud = m.userData, L = ud.length || 60, h = (this.ship.hdg || 0) * D2R;
    const bow = this._bowW || (this._bowW = new THREE.Vector3());
    bow.set(0, (ud.freeboard || 3) * 1.25, -0.47 * L).applyMatrix4(m.matrixWorld);
    const cam = this.camera.position, dCam = cam.distanceTo(m.position);
    const dir = this._camDir || (this._camDir = new THREE.Vector3()); this.camera.getWorldDirection(dir);
    const wd = (this.localWind?.dir ?? this.wind?.dir ?? 0) * D2R;      // FROM; world from-vector = (sin, -cos)
    const hor = Math.hypot(dir.x, dir.z) || 1;
    const indoors = this.interior.active || !!this.hud.chartOpen?.();
    fx.heavy({
      hs: Number(this.wx?.waveH) || 0, bow, fwd: { x: Math.sin(h), z: -Math.cos(h) }, shipSpd: Math.abs(this.ship.spd || 0) * GEO.KN_TO_MS * SIM.MOTION_SCALE,
      slam: this.you?.docked ? 0 : vis.slam || 0, green: this.you?.docked ? 0 : vis.greenWater || 0, length: L, beam: ud.beam || L / 6,
      center: m.position, seaY: this.tideLevel, outdoors: !indoors && !ashore,
      camNear: !indoors && !ashore && dCam < Math.max(60, L * 2.2), camBow: this.cam.mode === 2,
      faceWind: (dir.x * Math.sin(wd) - dir.z * Math.cos(wd)) / hor,
    });
    if ((vis.slam || 0) > 0.5) this.camJolt = Math.max(this.camJolt, vis.slam);
  }
  /** Camera jolt on slams and buffeting in a gale (added after the camera is placed; decays by itself). */
  shakeCamera(dt) {
    const U = this.localWind?.spd ?? 0, buffet = THREE.MathUtils.clamp((U - 14) / 18, 0, 1) * (this.cam.mode === 2 ? 0.05 : 0.18);
    this.camJolt = Math.max(0, this.camJolt - dt * 2.2);
    const j = this.camJolt * this.camJolt * (this.cam.mode === 2 ? 0.35 : 0.8), t = this.time;
    if (j + buffet < 1e-3) return;
    this.camera.position.x += Math.sin(t * 23.1) * j + Math.sin(t * 3.7 + Math.sin(t * 1.3)) * buffet;
    this.camera.position.y += Math.sin(t * 29.7 + 1) * j + Math.sin(t * 4.3) * buffet * 0.6;
    this.camera.position.z += Math.sin(t * 19.3 + 2) * j + Math.cos(t * 3.1) * buffet;
  }
  updateCamera(dt) {
    const s = this.ship; if (!s || !this.myMesh) return;
    if (this.you?.rescue) { this.camPrevTarget = null; return this.updateRaftCamera(dt); }
    const target = this.myMesh.position.clone().add(new THREE.Vector3(0, 8, 0));
    // Carry the camera along with the ship's own motion (horizontal) before easing the orbit: a plain lerp trails a
    // warped ship by hundreds of metres (2.9 km/s at 400×); a teleport (snap / correction) is not carried.
    const prev = this.camPrevTarget;
    if (prev) { const mx = target.x - prev.x, mz = target.z - prev.z; if (mx * mx + mz * mz < 25e6) { this.camera.position.x += mx; this.camera.position.z += mz; } }
    this.camPrevTarget = (prev || new THREE.Vector3()).copy(target);
    if (this.cam.free && performance.now() - this.cam.lastDrag > 6000) this.cam.free = false;
    const h = s.hdg * D2R;
    let yaw = this.cam.free ? this.cam.yaw : (this.cam.yaw += angleDiffRad(this.cam.yaw, -h) * Math.min(1, dt * 1.5));
    let dist = this.cam.dist, pitch = this.cam.pitch;
    // above 20× the chase camera climbs to a higher, wider view (eased in and out)
    this.camLift += ((this.warp > WARP_MAX_NO_ROUTE ? 1 : 0) - this.camLift) * Math.min(1, dt * 1.2);
    if (this.camLift < 1e-3) this.camLift = 0;
    if (this.camLift > 0) {
      const L = this.shipLength();
      dist += (Math.max(dist * 2, 250 + 3 * L) - dist) * this.camLift;
      pitch += (Math.max(pitch, 0.55) - pitch) * this.camLift;
    }
    if (this.cam.mode === 1) { dist = dist * 2.2; pitch = 1.1; }
    const pos = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch) * dist, Math.sin(pitch) * dist + 6, Math.cos(yaw) * Math.cos(pitch) * dist).add(target);
    if (this.cam.mode === 2) { // bridge view: look azimuth = heading + the mouse yaw offset (which eases back to dead ahead)
      const L = this.myMesh.userData.length; const bp = new THREE.Vector3(0, this.myMesh.userData.freeboard + 16, L * 0.35).applyMatrix4(this.myMesh.matrixWorld);
      if (!this.cam.free) this.cam.look = (this.cam.look || 0) * Math.max(0, 1 - dt * 1.5);
      const la = h + (this.cam.look || 0);
      this.camera.position.copy(bp); const look = new THREE.Vector3(Math.sin(la), -0.05, -Math.cos(la)).add(bp); this.camera.lookAt(look); this.shakeCamera(dt); if (this.myMesh.userData.label) this.myMesh.userData.label.visible = false; return;
    }
    if (this.myMesh.userData.label) this.myMesh.userData.label.visible = true;
    const wave = this.ocean.heightAt(pos.x, pos.z, this.time);
    pos.y = Math.max(pos.y, wave + 4);
    this.camera.position.lerp(pos, Math.min(1, dt * 6));
    this.camera.lookAt(target);
    this.shakeCamera(dt);
  }
  /** Adrift after sinking: a low orbit around the life raft while the SAR craft comes in. */
  updateRaftCamera(dt) {
    const r = this.you.rescue;
    if (!this.raft) { this.raft = buildRaft(); this.scene.add(this.raft); }
    const p = this.place(this.raft, r.lat, r.lon, 0);
    const wave = this.ocean.heightAt(p.x, p.z, this.time);
    this.raft.position.y = wave + 0.2; this.raft.rotation.set(Math.sin(this.time * 0.7) * 0.08, this.time * 0.05, Math.cos(this.time * 0.9) * 0.08);
    this.cam.yaw += dt * 0.12;
    const pos = new THREE.Vector3(Math.sin(this.cam.yaw) * 16, 5, Math.cos(this.cam.yaw) * 16).add(this.raft.position);
    pos.y = Math.max(pos.y, this.ocean.heightAt(pos.x, pos.z, this.time) + 2.5);
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
    const rainW = Number(this.wx?.rain) || 0, gale = THREE.MathUtils.smoothstep(Number(this.wx?.windSpd) || 0, 10, 26);
    // overcast and storm darkening: a gale sky is low and grey, a storm at noon is dusk-dark
    const gloom = THREE.MathUtils.clamp(0.5 * storm + 0.35 * gale + 0.25 * cloud + 0.15 * rainW, 0, 0.88);
    const grey = new THREE.Color(0x5d6670).lerp(new THREE.Color(0x2c3438), THREE.MathUtils.clamp(Math.max(storm, gale) * 1.2 - 0.2, 0, 1)); // storm: slate, nearly black under the scud
    const top = new THREE.Color(0x101e33).lerp(new THREE.Color(0x3f7fc9), day).lerp(new THREE.Color(0x8c5a6a), dusk * 0.35).lerp(grey, gloom * day);
    const hor = new THREE.Color(0x24364d).lerp(new THREE.Color(0xbfd9ee), day).lerp(new THREE.Color(0xf2a860), dusk * 0.7).lerp(grey.clone().multiplyScalar(1.3 - 0.45 * Math.max(storm, gale)), gloom * day);
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
      for (const o of [...this.others.values(), ...this.cutters.values(), ...this.ai.values(), ...this.fleetShips.values()]) o.mesh.userData.setLights?.(lightsOn);
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
    const ashore = !!this.ashore?.active;
    if (!ashore) this.simulate(dt); // ashore the ship lies moored: nothing to integrate, no helm
    this.recentre(false);
    if (now - this.lastTerrainUpdate > 500) { this.lastTerrainUpdate = now; this.terrain.update(this.ship.lat, this.ship.lon, this.camera); this.updateScenery(); this.hud.setWorldDetail?.(this.terrain.wtiles?.attribution(), this.terrain.wtiles?.loading() || 0); }   // WORLD TILES: focus = where the camera looks; credit + loading dot
    const mp = toLocal(this.ship.lat, this.ship.lon, this.origin);
    if (this.terrain.version !== this.depthVersion) { this.depthVersion = this.terrain.version; this.ocean.rebuildDepth(mp.x, mp.z, (x, z) => this.heightLocal(x, z), true); }
    else this.ocean.rebuildDepth(mp.x, mp.z, (x, z) => this.heightLocal(x, z), false);
    this.ocean.update(this.time, this.camera.position.x, this.camera.position.z, dt);
    this.governOceanQuality(now);
    this.updateSound(dt, now, ashore);
    this.shipVisual(this.myMesh, this.ship.lat, this.ship.lon, this.ship.hdg, this.ship.spd, this.myVis, this.you.flooding, dt, !!this.you.docked);
    try { this.feedHeavyWeather(dt, ashore); } catch (e) { if (!this.heavyWarned) { this.heavyWarned = true; console.warn('[weather] heavy-weather fx failed', e); } }
    if (this.myMesh.userData.setSails && now - this.lastSails > 500) { this.lastSails = now; this.myMesh.userData.setSails(this.you.sailsUp !== false, this.windRel()); }
    for (const o of this.others.values()) { this.interp(o, now); this.shipVisual(o.mesh, o.cur.lat, o.cur.lon, o.cur.hdg, o.cur.spd, o.vis, o.flooding || 0, dt, !!o.docked); }
    for (const c of this.cutters.values()) { this.interp(c, now); this.shipVisual(c.mesh, c.cur.lat, c.cur.lon, c.cur.hdg, c.cur.spd, c.vis, 0, dt, false); if (c.mesh.userData.beacon) c.mesh.userData.beacon.material.emissiveIntensity = c.state === 'patrol' ? 0.5 : 2 + 2 * Math.sin(this.time * 12); }
    for (const a of this.ai.values()) { this.interp(a, now); this.shipVisual(a.mesh, a.cur.lat, a.cur.lon, a.cur.hdg, a.state === 'underway' ? a.cur.spd : 0, a.vis, 0, dt, a.state !== 'underway'); }
    for (const f of this.fleetShips.values()) { this.interp(f, now); this.shipVisual(f.mesh, f.cur.lat, f.cur.lon, f.cur.hdg, f.state === 'at_sea' ? f.cur.spd : 0, f.vis, 0, dt, f.state !== 'at_sea'); }
    for (const r of this.rescues.values()) {
      this.interp(r, now);
      if (r.kind === 'helicopter') { const p = this.place(r.mesh, r.cur.lat, r.cur.lon, 60 + Math.sin(this.time * 0.8) * 2); r.mesh.rotation.set(-0.08, -r.cur.hdg * D2R, 0, 'YXZ'); r.mesh.userData.setRotor?.(this.time); void p; }
      else this.shipVisual(r.mesh, r.cur.lat, r.cur.lon, r.cur.hdg, r.cur.spd, r.vis, 0, dt, false);
    }
    try { this.aisLayer.update(dt, now); } catch (e) { if (!this.aisWarned) { this.aisWarned = true; console.warn('[ais] layer update failed', e); } }
    try { this.jobLayer.update(dt); } catch (e) { if (!this.jobLayerWarned) { this.jobLayerWarned = true; console.warn('[jobs] layer update failed', e); } }
    try { this.berthGuide?.update(dt, now); } catch (e) { if (!this.berthGuideWarned) { this.berthGuideWarned = true; console.warn('[berthguide] update failed', e); } }
    try { this.tugLayer?.update(dt, now); } catch (e) { if (!this.tugLayerWarned) { this.tugLayerWarned = true; console.warn('[tugs] update failed', e); } }
    for (const m of this.harborMeshes.values()) m.userData.updateBuoys?.(this.time);
    // the camera belongs to whoever is walking (ashore / below decks), else to the chase / bridge / raft views
    if (ashore) { this.camPrevTarget = null; try { this.ashore.update(dt); } catch (e) { console.warn('[ashore] update failed — back aboard', e); try { this.ashore.exit(); } catch {} this.afterAshoreChange(); } }
    else if (this.interior.active) { this.camPrevTarget = null; this.interior.update(dt); }
    else { if (this.raft && !this.you.rescue) { this.drop(this.raft); this.raft = null; } this.updateCamera(dt); }
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
    try { this.pilot?.update(now); } catch (e) { if (!this.pilotWarned) { this.pilotWarned = true; console.warn('[autopilot] update failed', e); } }
    const h = this.terrain.heightAt(s.lat, s.lon);
    const cur = currentAt(s.lat, s.lon, this.simTime);
    if (this.tide?.stream) { cur.u += this.tide.stream.u || 0; cur.v += this.tide.stream.v || 0; }
    let nearest = null, nd = Infinity;
    for (const hb of this.world.harbors) { const a = this.harborAnchor(hb); const d = haversine(s.lat, s.lon, a.lat, a.lon); if (d < nd) { nd = d; nearest = hb; } }
    const hasGeom = nearest && this.geoms.has(nearest.id);
    if (!you.docked && !you.assist) {
      if (you.nearBerth && you.nearBerth.distM <= INTERACT.BERTH_RANGE_U) { // the berth guidance card says it already (and has the Moor button)
        if (this.berthGuide?.info) this.hud.clearAlert('dock');
        else this.hud.alert('dock', `${you.nearBerth.name || 'Berth'}: alongside — ${this.hud.touch ? 'tap Moor' : 'press T'} to moor (under 2 kn)`, 'warn');
      }
      else if (!hasGeom && nearest && nd / GEO.SCALE <= INTERACT.DOCK_RADIUS_U) this.hud.alert('dock', `${nearest.name}: in docking range — press T (under 3 kn)`, 'warn');
      else this.hud.clearAlert('dock');
    } else this.hud.clearAlert('dock');
    if (you.assist) {
      const a = you.assist, left = Math.max(0, Math.round(((Number(a.until) || 0) - (Date.now() + (this.clockOffset || 0))) / 1000));
      const eta = ` · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left${a.rate > 1.05 ? ` · fast-forward ×${Math.round(a.rate * 10) / 10}` : ''}`;
      this.hud.alert('assist', a.phaseText ? `Tugs ${a.phaseText} · ${a.berthName || 'the berth'}${eta}` : `Tugs have you — berthing at ${a.berthName || 'the berth'}…`, 'warn');
    } else this.hud.clearAlert('assist');
    let wp = null, eta = null;
    const v = Math.abs(s.spd) * GEO.KN_TO_MS * SIM.MOTION_SCALE;
    if (this.route.length) {
      const first = this.route[0];
      const d = haversine(s.lat, s.lon, first.lat, first.lon), total = this.routeLength();
      eta = v > 0.5 ? total / v : null; // at sea (ship's clock); the telemetry line shows the real-time wait under warp
      const etaTxt = eta == null ? '—' : this.warp > 1 ? `${fmtTime(eta / this.warp)} (${this.warp}×)` : fmtTime(eta);
      wp = { dist: fmtDistance(d), brg: bearing(s.lat, s.lon, first.lat, first.lon), eta: etaTxt, etaSea: eta, total: fmtDistance(total), count: this.route.length, warp: this.warp };
    }
    this.hud.updateTelemetry(s, {
      depth: h == null ? null : -h + this.tideLevel, draft: C.draft, current: { set: normDeg((Math.atan2(cur.u, cur.v) * 180) / Math.PI), drift: Math.hypot(cur.u, cur.v) / GEO.KN_TO_MS }, flooding: you.flooding,
      nearest: nearest ? { name: nearest.name, dist: fmtDistance(nd) } : null, wp, autopilot: this.autopilot, jobs: you.jobs.length, tide: this.tide, berth: you.nearBerth,
      status: you.rescue ? 'ADRIFT' : this.ashore?.active ? 'ashore' : you.docked ? (you.berth ? `moored · ${you.berth.name}` : 'docked') : you.assist ? 'under tow' : you.fuelEmpty ? 'NO FUEL' : you.fishing ? 'fishing' : you.hail ? 'HAILED' : you.towing ? 'towing' : this.warp > 1 ? `warp ${this.warp}×` : 'at sea',
      warp: this.warp,
    });
    this.hud.updateTop(you, { simTime: this.simTime, wind: this.localWind ? { dir: this.localWind.dir, spd: this.localWind.spd, u: this.localWind.u, v: this.localWind.v } : this.wind, storms: this.storms }, this.others.size + 1, this.net.latency);
    if (you.fuelEmpty) this.hud.alert('fuel', 'OUT OF FUEL — drifting. Call a tow or wait for help.', ''); else this.hud.clearAlert('fuel');
    if (you.flooding > 0.05 && you.flooding < 1) this.hud.alert('flood', `TAKING ON WATER ${Math.round(you.flooding * 100)} % — use a kit (K) or make harbour`, ''); else this.hud.clearAlert('flood');
    // v0.3 HUD panels (C2): each is optional while the HUD is still being built
    this.hud.showFishing?.(you.fishing ? you.fishInfo || { ground: '—', rate: 0, caught: 0, tooFast: Math.abs(s.spd) >= 3 } : null);
    this.hud.showWeather?.(this.wx, this.tide);
    this.hud.showRescue?.(you.rescue ? { ...you.rescue, now: Date.now() + (this.clockOffset || 0), harborName: this.world.harbors.find((x) => x.id === you.rescue.harbor)?.name } : null);
    this.hud.showBerth?.(you.nearBerth || null, you.berth || null, you.assist || null, Math.max(400, Math.round(C.displacement * 0.35)));
    this.jobTargets = jobTargets(this); this.jobLayer.setTargets(this.jobTargets); this.hud.showJobs?.(this.jobTargets);
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
    for (const f of this.fleetShips.values()) contacts.push({ kind: 'ai', lat: f.cur.lat, lon: f.cur.lon, hdg: f.cur.hdg, spd: f.cur.spd, color: f.ownerId === this.you?.id ? '#6fe3d6' : '#c8d6e2', label: f.name, state: f.state === 'at_sea' ? 'underway' : 'moored' });
    for (const c of this.aisLayer.contacts()) contacts.push({ ...c, kind: 'ai', color: c.color || '#9aa3ab' });
    for (const r of this.rescues.values()) contacts.push({ kind: 'rescue', lat: r.cur.lat, lon: r.cur.lon, hdg: r.cur.hdg, color: '#ff8c42', label: r.kind === 'helicopter' ? 'SAR heli' : 'Lifeboat' });
    if (this.you?.nearBerth) { const b = this.you.nearBerth; if (Number.isFinite(b.lat) && Number.isFinite(b.lon)) contacts.push({ kind: 'berth', lat: b.lat, lon: b.lon, hdg: b.hdg, color: '#58d68d', label: b.name }); }
    for (const t of this.jobTargets || []) contacts.push({ kind: 'job', lat: t.lat, lon: t.lon, color: t.color, label: t.kind === 'casualty' ? 'Casualty' : t.name, radiusU: t.kind === 'ground' ? t.rangeM / GEO.SCALE : 0 });
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
