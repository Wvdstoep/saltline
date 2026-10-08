// Authoritative game state: players, survival (fuel/wear/flooding/sinking), economy, law, multiplayer
// interactions, AI coast guard, wrecks and persistence. Movement is client-simulated with plausibility checks.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { GEO, SIM, SHIP_CLASSES, GOODS, INTERACT, LAW, LAYERS, FEES, WARP } from '../shared/constants.js';
import { haversine, bearing, destination, unitsBetween, normDeg, angleDiff, wrapLon, clampLat } from '../shared/geo.js';
import { fuelBurnPerSimHour, wearPerSimHour, currentAt, headwindFactor, stepShip } from '../shared/physics.js';
import { tideAt } from '../shared/tide.js';
import { HARBORS, FISHING_GROUNDS, PATROLS, PLATFORMS, harborById } from './harbors.js';
import {
  generateJob, generateSmugglingJob, jobCountFor, cargoMass, cargoValue, publicJob,
  shipCapacity, setJobSeq, nextJobId, generateUsedShips, shipValue, repairCostFor, ECON,
  initEconomy, refreshPrices, driftEconomy, marketTrend, demandBonus, shipSpecs, serviceCostFor, serviceWearMul,
  portDues, berthFeePerDay, pilotageFee, tugCostFor,
} from './economy.js';
import { DATA_DIR } from './world.js';

const DEFAULT_STATE_FILE = path.join(DATA_DIR, 'state.json');
const START_HARBOR = 'rotterdam';
const START_MONEY = 25000;
const SERVICE_INTERVAL_S = FEES.SERVICE_INTERVAL_DAYS * 86400;
const NEAR_BERTH_RANGE_U = 2500;      // you.nearBerth is reported within this of a berth
const DOCK_SEARCH_RANGE_U = 6000;     // beyond this of the anchor there is no harbour to talk to
const LAND_PENETRATION_M = 0.5;       // onState rejects positions this far inside a quay/land

function rndFn() { return Math.random(); }
function shortId() { return crypto.randomBytes(4).toString('hex'); }
function token() { return crypto.randomBytes(24).toString('base64url'); }

export class Game {
  constructor(world, log = console.log, opts = {}) {
    this.world = world;
    this.log = log;
    this.stateFile = opts.stateFile || DEFAULT_STATE_FILE;
    // v0.3 services (docs/V3-CONTRACTS.md §3). Each is optional: tests construct the Game without them and the
    // synthetic weather / legacy harbour point / empty AI list take over. server.js ticks weather and traffic itself.
    this.weather = opts.weather || null;       // WeatherService: sample(lat, lon) / request(lat, lon)
    this.traffic = opts.traffic || null;       // Traffic: near(lat, lon, rangeM) / all()
    this.geom = opts.harborgeom || null;       // harborgeom module namespace
    this.lastEcon = 0;                         // Date.now() of the last market drift
    this.lastWxRequest = 0;                    // Date.now() of the last weather request sweep
    this.wxAsked = new Map();                  // "lat,lon" cell -> Date.now() of the last lazy request (throttle)
    this.players = new Map();   // token -> player
    this.byId = new Map();      // id -> player
    this.sockets = new Map();   // id -> ws
    this.wrecks = [];
    this.harbors = {};          // id -> { jobs, market, contact, lastRegen }
    this.cutters = [];
    this.convoys = new Map();   // convoyId -> { id, members: [ids], leader }
    this.offers = new Map();    // offerId -> trade offer
    this.invites = new Map();   // playerId:convoyId -> expiry
    this.rescues = [];          // active SAR missions
    this.storms = [];           // weather cells
    this.simTime = Date.now() / 1000; // real time: seconds since the Unix epoch
    this.wind = { u: 6, v: 2, dir: 0, spd: 0 };
    this.rnd = rndFn;
    this.lastSave = Date.now();
    this.lastYou = 0;
    this.eventSeq = 1;
    this.loadState();
    this.initHarbors();
    this.initCutters();
  }

  // ------------------------------------------------------------------ persistence
  loadState() {
    try {
      if (!fs.existsSync(this.stateFile)) return;
      const s = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      this.simTime = Date.now() / 1000;
      this.wrecks = s.wrecks || [];
      this.storms = s.storms || [];
      this.harbors = s.harbors || {};
      if (s.wind) this.wind = s.wind;
      let maxJob = 1;
      for (const p of s.players || []) {
        p.online = false; p.hail = null; p.fishing = false;
        this.migratePlayer(p);
        this.players.set(p.token, p); this.byId.set(p.id, p);
      }
      for (const h of Object.values(this.harbors)) for (const j of [...(h.jobs || []), ...((h.contact && h.contact.jobs) || [])]) maxJob = Math.max(maxJob, parseInt(j.id.slice(1), 36) + 1);
      for (const p of this.players.values()) for (const j of p.jobs || []) maxJob = Math.max(maxJob, parseInt(j.id.slice(1), 36) + 1);
      setJobSeq(maxJob);
      for (const p of this.players.values()) {
        if (!p.convoyId) continue;
        let c = this.convoys.get(p.convoyId);
        if (!c) { c = { id: p.convoyId, members: [], leader: p.id }; this.convoys.set(c.id, c); }
        c.members.push(p.id);
      }
      // Markets kept moving while the server was down (bounded to two days).
      const savedAt = s.savedAt ? Date.parse(s.savedAt) / 1000 : s.simTime;
      if (Number.isFinite(savedAt)) { const hours = Math.min(48, Math.max(0, (this.simTime - savedAt) / 3600)); for (const st of Object.values(this.harbors)) driftEconomy(st, hours, this.rnd); }
      this.log(`[game] loaded ${this.players.size} players, ${this.wrecks.length} wrecks`);
    } catch (e) { this.log(`[game] state load failed: ${e.message}`); }
  }
  // v0.3 player fields default safely for players saved by older versions.
  migratePlayer(p) {
    // Never resume warped (docs/V4-CONTRACTS.md §1): every load starts the ship back in real time.
    p.warp = 1; p.warpRouted = false; p.warpGraceUntil = 0; p.warpGraceFactor = 1;
    if (p.berth === undefined) p.berth = null;
    if (!(p.serviceDue > 0)) p.serviceDue = this.simTime + SERVICE_INTERVAL_S;
    if (!p.stats) p.stats = {};
    for (const k of ['delivered', 'earned', 'sunk', 'inspected', 'fined', 'caught', 'boarded', 'pirated', 'distanceKm', 'collisions']) if (!Number.isFinite(p.stats[k])) p.stats[k] = 0;
    if (!p.lastValid) p.lastValid = { lat: p.ship.lat, lon: p.ship.lon };
    if (p.docked && !(p.dockedAt > 0)) p.dockedAt = this.simTime;
    // A tug assist interrupted by a restart completes now: the berth is the only position guaranteed to be water.
    if (p.assist) {
      const h = harborById(p.assist.harbor), geom = h && this.geom && this.geom.getHarborGeom(h.id);
      const b = geom && (geom.berths || []).find((x) => x.id === p.assist.berthId);
      p.assist = null;
      if (h) { if (b) this.moorAt(p, h, b); else this.setDocked(p, h.id, null); }
    }
  }
  saveState() {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const s = {
        savedAt: new Date().toISOString(), simTime: this.simTime, wind: this.wind, wrecks: this.wrecks, harbors: this.harbors, storms: this.storms,
        players: [...this.players.values()].map((p) => ({ ...p, hail: null, fishing: false, online: false, warp: 1, warpRouted: false, warpGraceUntil: 0, warpGraceFactor: 1 })),
      };
      const tmp = this.stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(s));
      fs.renameSync(tmp, this.stateFile);
      this.lastSave = Date.now();
    } catch (e) { this.log(`[game] save failed: ${e.message}`); }
  }

  // ------------------------------------------------------------------ harbours / AI init
  initHarbors() {
    for (const h of HARBORS) {
      let st = this.harbors[h.id];
      if (!st) st = this.harbors[h.id] = { jobs: [], market: {}, contact: null, lastRegen: -1e9, ...initEconomy(h, this.rnd) };
      // Old state files carry a flat price table only: give them stock/target and derive the prices from it.
      if (!st.stock || !st.target) Object.assign(st, initEconomy(h, this.rnd));
      refreshPrices(h, st);
      this.regenHarbor(h, st, true);
    }
    this.lastEcon = Date.now();
  }
  regenHarbor(h, st, force) {
    st.jobs = (st.jobs || []).filter((j) => j && j.deadline > this.simTime);
    const n = jobCountFor(h);
    // Second-hand hulls turn over every 6 h (1–4 listings by harbour size).
    if (!st.used || !st.used.length || !(st.usedAt > 0) || this.simTime - st.usedAt > ECON.USED_REFRESH_H * 3600) { st.used = generateUsedShips(h, this.rnd); st.usedAt = this.simTime; }
    if (force || this.simTime - st.lastRegen > 3600 * 2) {
      let guard = 0;
      while (st.jobs.length < n && guard++ < 40) { const j = generateJob(h, this.simTime, this.rnd); if (j) st.jobs.push(j); }
      // Black-market contact: 70% present per regen, 1-3 runs.
      if (this.rnd() < 0.7) {
        const k = 1 + Math.floor(this.rnd() * 3);
        st.contact = { name: contactName(this.rnd), jobs: Array.from({ length: k }, () => generateSmugglingJob(h, this.simTime, this.rnd)).filter(Boolean) };
      } else st.contact = null;
      st.lastRegen = this.simTime;
    }
    refreshPrices(h, st);
  }
  // Every market drifts toward its target stock; called from tick once a minute and after loading state.
  driftMarkets() {
    const now = Date.now();
    const hours = Math.min(48, (now - (this.lastEcon || now)) / 3600e3);
    this.lastEcon = now;
    if (hours <= 0) return;
    for (const h of HARBORS) { const st = this.harbors[h.id]; if (!st) continue; driftEconomy(st, hours, this.rnd); refreshPrices(h, st); }
  }
  harborEcon(st) { return { stock: st.stock || {}, target: st.target || {}, trend: marketTrend(st) }; }
  initCutters() {
    this.cutters = PATROLS.map((p) => ({
      id: p.id, name: p.name, pts: p.pts, wp: 1, lat: p.pts[0][0], lon: p.pts[0][1], hdg: 0, spd: 0,
      state: 'patrol', targetId: null, timer: 0, kn: 18,
    }));
  }

  // ------------------------------------------------------------------ players
  findOrCreatePlayer(tok, name) {
    let p = tok ? this.players.get(tok) : null;
    if (!p) {
      const h = harborById(START_HARBOR);
      const berth = this.startBerth(h, 'coaster');
      const spawn = berth || this.spawnPointNear(h);
      p = {
        id: shortId(), token: token(), name: cleanName(name) || `Skipper-${Math.floor(Math.random() * 900 + 100)}`,
        createdAt: Date.now(), ship: { cls: 'coaster', lat: spawn.lat, lon: spawn.lon, hdg: berth ? berth.hdg : 0, spd: 0, throttle: 0, rudder: 0 },
        cond: 100, flooding: 0, fuel: SHIP_CLASSES.coaster.fuelCap, cargo: [], money: START_MONEY, wanted: 0, wantedAt: 0,
        kits: 1, jobs: [], convoyId: null, docked: START_HARBOR, dockedAt: this.simTime, berth, assist: null, serviceDue: this.simTime + SERVICE_INTERVAL_S, lastInspected: -1e9, lastSeen: Date.now(),
        stats: { delivered: 0, earned: 0, sunk: 0, inspected: 0, fined: 0, caught: 0, boarded: 0, pirated: 0, distanceKm: 0, collisions: 0 },
        lastValid: { lat: spawn.lat, lon: spawn.lon }, shallowSince: 0, log: [],
        warp: 1, warpRouted: false, warpGraceUntil: 0, warpGraceFactor: 1,
      };
      this.players.set(p.token, p); this.byId.set(p.id, p);
      this.log(`[game] new player ${p.name} (${p.id})`);
    } else if (name && cleanName(name) && cleanName(name) !== p.name) {
      p.name = cleanName(name);
    }
    return p;
  }
  // The harbour anchor: guaranteed water in the built geometry, else the harbour's own point. `built` tells callers
  // whether the coarse world raster may disagree with it (a dredged basin is land at 556 m resolution).
  harborAnchor(h) {
    if (!h) return null;
    if (this.geom) {
      try {
        const a = this.geom.harborAnchor(h.id);
        if (a && Number.isFinite(a.lat) && Number.isFinite(a.lon)) return { lat: a.lat, lon: a.lon, built: !!this.geom.getHarborGeom(h.id) };
      } catch (e) { this.log(`[game] harborAnchor ${h.id} failed: ${e.message}`); }
    }
    return { lat: h.lat, lon: h.lon, built: false };
  }
  // v0.4: a new skipper starts moored alongside a quay of the start harbour (built geometry only) — the least used
  // fitting berth, nearest the anchor — so going ashore walks down the gangway onto the real quay. Without built
  // geometry (or no fitting berth) the ship lies at the anchor as before and the launch takes the crew ashore.
  startBerth(h, cls) {
    const geom = h && this.harborGeom(h.id);
    if (!geom || !Array.isArray(geom.berths) || !geom.berths.length) return null;
    const probe = { ship: { cls } };
    const fits = geom.berths.filter((b) => b && Number.isFinite(b.lat) && Number.isFinite(b.lon) && Number.isFinite(b.hdg) && !this.berthFits(probe, b));
    if (!fits.length) return null;
    const used = new Map();
    for (const q of this.players.values()) if (q.docked === h.id && q.berth?.id) used.set(q.berth.id, (used.get(q.berth.id) || 0) + 1);
    const a = this.harborAnchor(h);
    const dist = (b) => haversine(a.lat, a.lon, b.lat, b.lon);
    fits.sort((x, y) => (used.get(x.id) || 0) - (used.get(y.id) || 0) || dist(x) - dist(y));
    const b = fits[0];
    return { harbor: h.id, id: b.id, name: b.name, hdg: normDeg(b.hdg), lat: b.lat, lon: b.lon, depth: b.depth, length: b.length };
  }
  spawnPointNear(h) {
    const a = this.harborAnchor(h);
    if (a.built) return { lat: a.lat, lon: a.lon };
    const w = this.world.nearestWater(a.lat, a.lon, 10);
    return { lat: w.lat, lon: w.lon };
  }
  harborGeom(id) { if (!this.geom) return null; try { return this.geom.getHarborGeom(id) || null; } catch { return null; } }
  // Nearest berth of the nearest harbour within NEAR_BERTH_RANGE_U, as shown in the HUD berth line.
  nearBerthFor(p) {
    if (!this.geom || p.docked) return null;
    const { harbor, units } = this.nearestHarbor(p.ship.lat, p.ship.lon);
    if (!harbor || units > NEAR_BERTH_RANGE_U + 4000 || !this.harborGeom(harbor.id)) return null;
    let nb = null;
    try { nb = this.geom.nearestBerth(harbor.id, p.ship.lat, p.ship.lon); } catch { nb = null; }
    if (!nb || !nb.berth || !(nb.distM <= NEAR_BERTH_RANGE_U)) return null;
    const b = nb.berth;
    return { id: b.id, name: b.name, harbor: harbor.id, harborName: harbor.name, distM: Math.round(nb.distM), brg: Math.round(nb.brg), hdg: Math.round(b.hdg), depth: b.depth, length: b.length, kind: b.kind, lat: b.lat, lon: b.lon };
  }
  tideFor(lat, lon) {
    const t = tideAt(lat, lon, this.simTime);
    return { height: round2(t.height), rate: round2(t.rate), stream: { u: round2(t.stream.u), v: round2(t.stream.v) }, range: round2(t.range), phase: round2(t.phase), state: t.state, nextHigh: Math.round(t.nextHigh), nextLow: Math.round(t.nextLow) };
  }

  publicState(p) {
    const s = p.ship;
    return {
      id: p.id, name: p.name, cls: s.cls, lat: round6(s.lat), lon: round6(s.lon), hdg: Math.round(s.hdg * 10) / 10,
      spd: Math.round(s.spd * 10) / 10, cond: Math.round(p.cond), flooding: Math.round(p.flooding * 100) / 100,
      convoyId: p.convoyId, wanted: p.wanted, docked: p.docked, sinking: p.flooding >= 1 || !!p.rescue, towing: !!p.towing, offline: !p.online,
      warp: this.warpOf(p),
    };
  }
  privateState(p) {
    return {
      id: p.id, name: p.name, ship: { ...p.ship }, cond: p.cond, flooding: p.flooding, fuel: p.fuel, cargo: p.cargo,
      money: p.money, wanted: p.wanted, kits: p.kits, jobs: p.jobs, convoyId: p.convoyId, docked: p.docked,
      fuelEmpty: p.fuel <= 0, hail: p.hail ? { cutter: p.hail.cutter, until: p.hail.until, state: p.hail.state } : null,
      fishing: !!p.fishing, fishInfo: p.fishing ? p.fishInfo : null, towing: p.towing || null, voyage: p.voyage || null, rescue: p.rescue || null, sailsUp: p.sailsUp !== false,
      weather: this.weatherPublic(p.ship.lat, p.ship.lon), tide: this.tideFor(p.ship.lat, p.ship.lon),
      berth: p.berth || null, assist: p.assist ? { harbor: p.assist.harbor, berthId: p.assist.berthId, berthName: p.assist.berthName, until: p.assist.until, from: p.assist.from, to: p.assist.to } : null,
      nearBerth: this.nearBerthFor(p), serviceDue: p.serviceDue, serviceMul: round2(serviceWearMul(p.serviceDue, this.simTime)),
      stats: p.stats, capacity: shipCapacity(p.ship.cls), pax: SHIP_CLASSES[p.ship.cls].pax,
      warp: this.warpOf(p), warpLimit: this.warpLimit(p),
      convoy: p.convoyId && this.convoys.get(p.convoyId) ? { id: p.convoyId, members: this.convoys.get(p.convoyId).members.map((id) => ({ id, name: this.byId.get(id)?.name })) } : null,
    };
  }
  // Flat, rounded weather for the wire (ocean.setSea / weatherFx.set read these names directly).
  weatherPublic(lat, lon) {
    const w = this.weatherAt(lat, lon);
    return {
      windDir: Math.round(w.wind.dir), windSpd: round1(w.wind.spd), gust: round1(w.wind.gust), sea: round2(w.sea), storm: round2(w.storm), rain: round2(w.rain),
      waveH: round2(w.waves.height), waveDir: Math.round(w.waves.dir), wavePeriod: round1(w.waves.period),
      swellH: round2(w.swell.height), swellDir: Math.round(w.swell.dir), swellPeriod: round1(w.swell.period),
      visibility: Math.round(w.visibility), pressure: round1(w.pressure), temp: round1(w.temp), cloud: round2(w.cloud), source: w.source,
      sst: Number.isFinite(w.sst) ? round1(w.sst) : null, curSpd: w.current ? round2(w.current.speed) : null, curDir: w.current ? Math.round(w.current.dir) : null,
    };
  }
  worldInfo() {
    return {
      harbors: HARBORS.map((h) => ({ id: h.id, name: h.name, country: h.country, lat: h.lat, lon: h.lon, size: h.size })),
      fishing: FISHING_GROUNDS, platforms: PLATFORMS, classes: SHIP_CLASSES, goods: GOODS, layers: LAYERS, interact: INTERACT, law: LAW, fees: FEES, warp: WARP,
      scale: GEO.SCALE, motionScale: SIM.MOTION_SCALE, clockScale: SIM.CLOCK_SCALE,
    };
  }

  // ------------------------------------------------------------------ networking helpers
  send(p, msg) {
    const ws = this.sockets.get(p.id);
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }
  event(p, kind, text, extra = {}) {
    const ev = { t: 'event', id: this.eventSeq++, kind, text, time: Date.now(), ...extra };
    p.log = (p.log || []).slice(-30).concat([{ kind, text, time: ev.time }]);
    this.send(p, ev);
  }
  broadcast(msg, except) {
    const s = JSON.stringify(msg);
    for (const [id, ws] of this.sockets) if (id !== except && ws.readyState === 1) ws.send(s);
  }
  sendYou(p, extra) { this.send(p, { t: 'you', you: this.privateState(p), ...(extra || {}) }); }
  sendHarbor(p) {
    const h = harborById(p.docked); if (!h) return;
    const st = this.harbors[h.id];
    this.regenHarbor(h, st, false);
    const geom = this.harborGeom(h.id), anchor = this.harborAnchor(h);
    this.send(p, {
      t: 'harbor', harbor: { id: h.id, name: h.name, country: h.country, size: h.size, lat: h.lat, lon: h.lon, fuelPrice: this.fuelPrice(h), repairCost: this.repairCost(p),
        jobs: st.jobs, market: st.market, econ: this.harborEcon(st), contact: p.contactSeen === h.id && st.contact ? st.contact : null, contactLooked: p.contactSeen === h.id,
        shipyard: Object.values(SHIP_CLASSES).filter((c) => c.price > 0).map((c) => ({ id: c.id, name: c.name, cat: c.cat, price: c.price, desc: c.desc, tradeIn: shipValue(p.ship.cls, p.cond), specs: shipSpecs(c.id) })),
        used: st.used || [], tradeIn: shipValue(p.ship.cls, p.cond), sellValue: p.ship.cls === 'pilot' ? 0 : shipValue(p.ship.cls, p.cond),
        berths: geom ? geom.berths || [] : [], anchor: { lat: anchor.lat, lon: anchor.lon }, geomSource: geom ? geom.source : null, berth: p.berth || null,
        tugCost: tugCostFor(p.ship.cls), fees: this.feesFor(p, h), serviceDue: p.serviceDue,
        dockedPlayers: [...this.byId.values()].filter((o) => o.online && o.docked === h.id && o.id !== p.id).map((o) => ({ id: o.id, name: o.name })) },
    });
  }
  feesFor(p, h) { return { dues: portDues(p.ship.cls, h), berthPerDay: berthFeePerDay(p.ship.cls), pilotage: pilotageFee(p.ship.cls, h), tug: tugCostFor(p.ship.cls), service: serviceCostFor(p.ship.cls) }; }
  fuelPrice(h) { return Math.round(this.harbors[h.id].market.fuel * (h.fuelMul || 1)); }
  repairCost(p) { return repairCostFor(p.ship.cls, p.cond); }
  aiNear(lat, lon) { if (!this.traffic) return []; try { return this.traffic.near(lat, lon, SIM.AI_RANGE_U) || []; } catch (e) { this.log(`[game] traffic.near failed: ${e.message}`); return []; } }

  connect(ws, tok, name) {
    const p = this.findOrCreatePlayer(tok, name);
    const old = this.sockets.get(p.id);
    if (old && old !== ws) { try { old.close(4001, 'replaced'); } catch {} }
    this.sockets.set(p.id, ws);
    p.online = true; p.lastSeen = Date.now(); p.lastTick = Date.now();
    // A (re)connecting client starts in real time: it has no route yet and its clock mirrors you.warp.
    this.resetWarp(p);
    ws.send(JSON.stringify({
      t: 'welcome', token: p.token, you: this.privateState(p), world: this.worldInfo(),
      players: [...this.byId.values()].filter((o) => o.online && o.id !== p.id).map((o) => this.publicState(o)),
      cutters: this.cutters.map(cutterPublic), wrecks: this.wrecks, wind: this.wind, simTime: this.simTime, log: p.log || [],
      storms: this.stormsPublic(), rescues: this.rescuesPublic(), ai: this.aiNear(p.ship.lat, p.ship.lon),
    }));
    if (this.weather) { try { this.weather.request(p.ship.lat, p.ship.lon); } catch {} }
    this.broadcast({ t: 'join', player: this.publicState(p) }, p.id);
    if (p.docked) this.sendHarbor(p);
    this.event(p, 'info', `Welcome aboard, ${p.name}. ${p.docked ? 'You are docked at ' + harborById(p.docked).name + '.' : ''}`);
    return p;
  }
  disconnect(p) {
    if (this.sockets.get(p.id)) this.sockets.delete(p.id);
    p.online = false; p.lastSeen = Date.now();
    this.resetWarp(p); // offline voyages run in real time
    if (p.hail) {
      const c = this.cutters.find((x) => x.id === p.hail.cutterId);
      this.bumpWanted(p, 1); p.hail = null;
      if (c) { c.state = 'patrol'; c.targetId = null; c.timer = 0; }
      p.log = (p.log || []).slice(-30).concat([{ kind: 'law', text: 'You vanished during a coast-guard hail. Noted as fleeing: wanted level ' + p.wanted + '.', time: Date.now() }]);
    }
    this.broadcast({ t: 'leave', id: p.id });
    this.cancelOffersOf(p);
  }

  // ------------------------------------------------------------------ inbound messages
  onState(p, m) {
    if (p.docked || p.flooding >= 1 || p.assist) return; // under tug assist the server owns the position
    const s = p.ship;
    const lat = Number(m.lat), lon0 = Number(m.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon0) || Math.abs(lat) > 85) return;
    const lon = wrapLon(lon0);
    const now = Date.now();
    const dt = Math.min(10, (now - (p.lastState || now)) / 1000) || 0.1;
    p.lastState = now;
    const C = SHIP_CLASSES[s.cls];
    // Distance budget: the ship may cover at most max speed (plus current/leeway margin) for the elapsed time.
    // Unused budget carries over for a few seconds so network jitter does not trigger rejections, but cannot
    // be banked indefinitely (no speed hacks by message spamming). Time warp multiplies the budget by the factor (for
    // GRACE_MS after a drop the old factor still applies to states the client sent before it heard of the drop).
    const perSec = (C.maxKn * 1.35 * GEO.KN_TO_MS * SIM.MOTION_SCALE + 1.5 * SIM.MOTION_SCALE) * this.warpBudgetFactor(p, now);
    p.moveBudget = Math.min(perSec * 5, (p.moveBudget == null ? perSec * 5 : p.moveBudget) + perSec * dt);
    const moved = haversine(s.lat, s.lon, lat, lon);
    if (moved > p.moveBudget + 5) {
      p.rejects = (p.rejects || 0) + 1;
      if (p.rejects === 1 || p.rejects % 20 === 0) this.event(p, 'warn', 'Position corrected by the server.');
      this.sendYou(p, { correction: true });
      return;
    }
    // Harbour geometry: a position inside a quay, breakwater, pontoon or land is rejected outright (the client's
    // collision resolver must never let the hull end up there). `null` = no built patch covers the point.
    const pen = this.landPenetration(lat, lon);
    if (pen != null && pen > LAND_PENETRATION_M) {
      p.rejects = (p.rejects || 0) + 1;
      if (now - (p.lastLandWarn || 0) > 10000) { p.lastLandWarn = now; this.event(p, 'warn', `Position rejected: ${pen.toFixed(1)} m inside the harbour structure. Corrected by the server.`); }
      this.sendYou(p, { correction: true });
      return;
    }
    p.rejects = 0; p.moveBudget -= moved;
    const hdg = Number(m.hdg), spd = Number(m.spd), thr = Number(m.throttle), rud = Number(m.rudder);
    s.lat = clampLat(lat); s.lon = lon; s.hdg = Number.isFinite(hdg) ? normDeg(hdg) : s.hdg;
    s.spd = clamp(Number.isFinite(spd) ? spd : 0, -C.maxKn * 0.4, C.maxKn * 1.1);
    s.throttle = clamp(Number.isFinite(thr) ? thr : 0, -0.3, 1); s.rudder = clamp(Number.isFinite(rud) ? rud : 0, -1, 1);
    p.stats.distanceKm += moved / 1000;
    // Land/shallow plausibility: tolerate brief shallows (client stops itself), teleport back if it persists.
    // Inside a built harbour patch the patch mask is the authority (coarse raster cells are 556 m); the tide adds to the depth.
    const depth = pen != null ? Infinity : this.world.depthAt(lat, lon) + tideAt(lat, lon, this.simTime).height;
    if (depth < C.draft * 0.5) {
      if (!p.shallowSince) p.shallowSince = now;
      else if (now - p.shallowSince > 4000) {
        s.lat = p.lastValid.lat; s.lon = p.lastValid.lon; s.spd = 0; p.shallowSince = 0;
        this.event(p, 'warn', 'Aground — the server moved you back to deeper water.');
        this.sendYou(p, { correction: true });
      }
    } else { p.shallowSince = 0; p.lastValid = { lat, lon }; }
  }
  landPenetration(lat, lon) {
    if (!this.geom) return null;
    try { const v = this.geom.landPenetration(lat, lon); return Number.isFinite(v) ? v : null; } catch { return null; }
  }

  onAction(p, m) {
    const a = m.action;
    try {
      switch (a) {
        case 'dock': return this.dock(p);
        case 'undock': return this.undock(p);
        case 'tug_assist': return this.tugAssist(p);
        case 'set_warp': return this.setWarp(p, m);
        case 'collision': return this.collision(p, m);
        case 'sell_ship': return this.sellShip(p);
        case 'service': return this.service(p);
        case 'lookaround': return this.lookAround(p);
        case 'buy_fuel': return this.buyFuel(p, +m.tonnes);
        case 'tow_pickup': return this.towPickup(p, m.jobId);
        case 'deliver_offshore': return this.deliverOffshore(p, m.jobId);
        case 'express': return this.expressPassage(p, +m.lat, +m.lon);
        case 'buy_used': return this.buyUsedShip(p, m.listingId);
        case 'set_voyage': return this.setVoyage(p, m);
        case 'sails': p.sailsUp = !!m.up; this.sendYou(p); return;
        case 'repair': return this.repair(p);
        case 'buy_kit': return this.buyKit(p);
        case 'accept_job': return this.acceptJob(p, m.jobId);
        case 'abandon_job': return this.abandonJob(p, m.jobId);
        case 'buy_goods': return this.tradeGoods(p, m.good, +m.qty, true);
        case 'sell_goods': return this.tradeGoods(p, m.good, +m.qty, false);
        case 'dump_cargo': return this.dumpCargo(p, m.good);
        case 'buy_ship': return this.buyShip(p, m.cls);
        case 'patch': return this.patch(p);
        case 'fish': return this.setFishing(p, !!m.on);
        case 'tow': return this.tow(p);
        case 'grounding': return this.grounding(p);
        case 'board': return this.board(p, m.targetId);
        case 'salvage': return this.salvage(p, m.wreckId);
        case 'trade_offer': return this.tradeOffer(p, m);
        case 'trade_accept': return this.tradeAccept(p, m.offerId);
        case 'trade_decline': return this.tradeDecline(p, m.offerId);
        case 'convoy_invite': return this.convoyInvite(p, m.targetId);
        case 'convoy_accept': return this.convoyAccept(p, m.convoyId);
        case 'convoy_leave': return this.convoyLeave(p);
        case 'rename': p.name = cleanName(m.name) || p.name; this.sendYou(p); this.broadcast({ t: 'rename', id: p.id, name: p.name }); return;
        default: this.event(p, 'warn', `Unknown action ${a}`);
      }
    } catch (e) {
      this.log(`[game] action ${a} failed: ${e.stack || e}`);
      this.event(p, 'warn', 'That did not work.');
    }
  }
  onChat(p, text) {
    text = String(text || '').slice(0, 200).trim();
    if (!text) return;
    this.broadcast({ t: 'chat', from: p.name, id: p.id, text, time: Date.now() });
  }

  // ------------------------------------------------------------------ harbour actions
  // Distances to harbours are measured from the ANCHOR (the built geometry's guaranteed-water point).
  nearestHarbor(lat, lon) {
    let best = null, bd = Infinity;
    for (const h of HARBORS) { const a = this.harborAnchor(h); const d = unitsBetween(lat, lon, a.lat, a.lon); if (d < bd) { bd = d; best = h; } }
    return { harbor: best, units: bd };
  }
  // Common "ship is now in harbour" state: used by docking, tows, impounds, resets and rescues.
  setDocked(p, harborId, berth) {
    this.dropWarp(p, 'In harbour.', false); // every caller sends `you` afterwards
    p.docked = harborId; p.dockedAt = this.simTime; p.berth = berth || null; p.assist = null;
    p.ship.spd = 0; p.ship.throttle = 0; p.ship.rudder = 0; p.fishing = false;
  }
  // Moor at a geometry berth: snap to the berth point, lie along the quay the way the ship is already pointing.
  moorAt(p, harbor, b) {
    const s = p.ship;
    s.lat = b.lat; s.lon = b.lon;
    s.hdg = Math.abs(angleDiff(s.hdg, b.hdg)) <= 90 ? normDeg(b.hdg) : normDeg(b.hdg + 180);
    p.lastValid = { lat: b.lat, lon: b.lon };
    this.setDocked(p, harbor.id, { harbor: harbor.id, id: b.id, name: b.name, hdg: s.hdg, lat: b.lat, lon: b.lon, depth: b.depth, length: b.length });
  }
  // Does this berth take the ship? Pontoons are small-craft only; the water must float the hull at the current tide.
  berthFits(p, b) {
    const C = SHIP_CLASSES[p.ship.cls];
    if (b.kind === 'pontoon' && C.length > 30) return `${b.name} is a pontoon for small craft; a ${C.name.toLowerCase()} needs a quay.`;
    const water = (Number.isFinite(b.depth) ? b.depth : 99) + tideAt(b.lat, b.lon, this.simTime).height;
    if (water + 0.3 < C.draft) return `${b.name} has ${water.toFixed(1)} m of water; you draw ${C.draft} m. Wait for the tide or pick a deeper berth.`;
    const maxLen = Number.isFinite(b.maxLength) ? b.maxLength : Number.isFinite(b.length) ? b.length : 1e9;
    if (C.length > maxLen * 1.5) return `${b.name} is ${Math.round(maxLen)} m long; your ${Math.round(C.length)} m hull will not fit.`;
    return null;
  }
  dock(p) {
    if (p.docked) return this.sendHarbor(p);
    if (p.assist) return this.event(p, 'info', 'The tugs have you. Hold on.');
    const { harbor, units } = this.nearestHarbor(p.ship.lat, p.ship.lon);
    if (!harbor || units > DOCK_SEARCH_RANGE_U) return this.event(p, 'warn', 'No harbour within docking range.');
    const geom = this.harborGeom(harbor.id);
    let berth = null;
    if (geom && (geom.berths || []).length) {
      // (a) built harbour: come alongside a berth within 60 m at under 2 kn.
      let nb = null; try { nb = this.geom.nearestBerth(harbor.id, p.ship.lat, p.ship.lon); } catch { nb = null; }
      if (!nb || !nb.berth || nb.distM > INTERACT.BERTH_RANGE_U || Math.abs(p.ship.spd) > 2) return this.event(p, 'warn', `Come alongside a berth (within ${INTERACT.BERTH_RANGE_U} m, under 2 kn) or request tugs.`);
      const why = this.berthFits(p, nb.berth); if (why) return this.event(p, 'warn', why);
      berth = nb.berth;
    } else {
      // (b) no geometry built yet: the legacy anchor rule.
      if (units > INTERACT.DOCK_RADIUS_U) return this.event(p, 'warn', 'No harbour within docking range.');
      if (Math.abs(p.ship.spd) > 3) return this.event(p, 'warn', 'Too fast to dock — slow below 3 kn.');
    }
    if (p.hail) return this.event(p, 'law', 'The harbour master refuses: the coast guard has ordered you to heave to first.');
    if (berth) this.moorAt(p, harbor, berth); else this.setDocked(p, harbor.id, null);
    this.finishDock(p, harbor);
  }
  // Inspection, deliveries and fees once the lines are fast (docking and tug assists both end here).
  finishDock(p, harbor) {
    if (p.cond > 0) p.flooding = 0;
    this.event(p, 'info', p.berth ? `Moored at ${harbor.name}, ${p.berth.name}.` : `Docked at ${harbor.name}.`);
    // Port authority inspection happens at the quay, before anything is unloaded.
    const chance = p.wanted > 0 ? LAW.PORT_INSPECT_CHANCE_WANTED : LAW.PORT_INSPECT_CHANCE;
    const seized = this.rnd() < chance ? this.inspect(p, `${harbor.name} port authority`) : false;
    if (p.docked === harbor.id) this.deliverJobs(p, harbor);
    // Port dues scaled by ship size and harbour class; pilotage for big ships at the big ports.
    const dues = portDues(p.ship.cls, harbor), pilot = pilotageFee(p.ship.cls, harbor);
    if (dues > 0 && !seized) { p.money = Math.max(0, p.money - dues); this.event(p, 'info', `Port dues: ${fmt(dues)} cr.`); }
    if (pilot > 0 && !seized) { p.money = Math.max(0, p.money - pilot); this.event(p, 'info', `Pilotage (${SHIP_CLASSES[p.ship.cls].length} m hull, compulsory here): ${fmt(pilot)} cr.`); }
    this.sendYou(p); this.sendHarbor(p);
  }
  undock(p) {
    if (!p.docked) return;
    const h = harborById(p.docked);
    // Berth fee per started 24 h alongside.
    const days = Math.max(1, Math.ceil((this.simTime - (p.dockedAt || this.simTime)) / 86400));
    const fee = days * berthFeePerDay(p.ship.cls);
    if (fee > 0) { p.money = Math.max(0, p.money - fee); this.event(p, 'info', `Berth fee: ${days} day${days > 1 ? 's' : ''} alongside, ${fmt(fee)} cr.`); }
    const spawn = this.undockPoint(p, h);
    p.docked = null; p.contactSeen = null; p.berth = null; p.dockedAt = null;
    p.ship.lat = spawn.lat; p.ship.lon = spawn.lon; if (Number.isFinite(spawn.hdg)) p.ship.hdg = spawn.hdg;
    p.lastValid = { lat: spawn.lat, lon: spawn.lon }; p.lastState = Date.now(); p.moveBudget = null; p.shallowSince = 0;
    this.event(p, 'info', `Cast off from ${h.name}. Fuel ${p.fuel.toFixed(1)} t, condition ${Math.round(p.cond)} %.`);
    this.sendYou(p, { correction: true });
  }
  // 20 m further out from the berth point (which is already 12 m off the quay face) on the deeper side; legacy = anchor.
  undockPoint(p, h) {
    const b = p.berth;
    if (!b || !Number.isFinite(b.lat) || !Number.isFinite(b.hdg)) return this.spawnPointNear(h);
    const cands = [normDeg(b.hdg + 90), normDeg(b.hdg - 90)].map((brg) => ({ brg, pt: destination(b.lat, b.lon, brg, 20) }));
    const score = (c) => {
      let v = null;
      if (this.geom) { try { v = this.geom.sdfAt(b.harbor || p.docked, c.pt.lat, c.pt.lon); } catch { v = null; } }
      if (!Number.isFinite(v)) { const pen = this.landPenetration(c.pt.lat, c.pt.lon); v = pen != null ? -pen : this.world.depthAt(c.pt.lat, c.pt.lon); }
      return v;
    };
    const best = cands.map((c) => ({ c, s: score(c) })).sort((a, b2) => b2.s - a.s)[0].c;
    return { lat: best.pt.lat, lon: best.pt.lon, hdg: Number.isFinite(p.ship.hdg) ? p.ship.hdg : b.hdg };
  }
  // Tugs: within 1500 m of the anchor, under 6 kn, no hail. They walk the ship to the best berth over 45 s.
  tugAssist(p) {
    if (p.docked || p.assist || p.flooding >= 1) return;
    if (p.hail) return this.event(p, 'law', 'No tug will take a line while the coast guard is hailing you.');
    const { harbor, units } = this.nearestHarbor(p.ship.lat, p.ship.lon);
    if (!harbor || units > INTERACT.TUG_RANGE_U) return this.event(p, 'warn', `Tugs only come out within ${INTERACT.TUG_RANGE_U} m of the harbour entrance.`);
    if (Math.abs(p.ship.spd) > 6) return this.event(p, 'warn', 'Slow below 6 kn so the tugs can make fast.');
    const cost = tugCostFor(p.ship.cls);
    if (p.money < cost) return this.event(p, 'warn', `The tugs want ${fmt(cost)} cr up front. You have ${fmt(p.money)}.`);
    const geom = this.harborGeom(harbor.id);
    let berth = null;
    if (geom && (geom.berths || []).length) {
      const ok = geom.berths.filter((b) => !this.berthFits(p, b));
      const pool = ok.length ? ok : geom.berths;
      berth = pool.map((b) => ({ b, d: haversine(p.ship.lat, p.ship.lon, b.lat, b.lon) })).sort((a, c) => a.d - c.d)[0].b;
    }
    const anchor = this.harborAnchor(harbor);
    const to = berth ? { lat: berth.lat, lon: berth.lon, hdg: berth.hdg } : { lat: anchor.lat, lon: anchor.lon, hdg: p.ship.hdg };
    const now = Date.now();
    p.money -= cost; p.fishing = false; p.voyage = null;
    p.ship.throttle = 0; p.ship.rudder = 0;
    p.assist = { harbor: harbor.id, berthId: berth ? berth.id : null, berthName: berth ? berth.name : null, from: { lat: p.ship.lat, lon: p.ship.lon, hdg: p.ship.hdg }, to, start: now, until: now + FEES.TUG_SECONDS * 1000, cost };
    this.event(p, 'info', `Two tugs made fast for ${fmt(cost)} cr. They will put you ${berth ? `alongside ${berth.name}` : 'in the harbour'} in ${FEES.TUG_SECONDS} s.`);
    this.sendYou(p, { correction: true });
  }
  // Tick: the server walks an assisted ship from `from` to the berth, then moors it exactly as dock() would.
  stepAssist(p) {
    const a = p.assist, s = p.ship, now = Date.now();
    const dur = Math.max(1, a.until - a.start);
    const f = now >= a.until ? 1 : Math.max(0, Math.min(1, (now - a.start) / dur));
    const e = f < 1 ? f * f * (3 - 2 * f) : 1; // ease in/out
    s.lat = a.from.lat + (a.to.lat - a.from.lat) * e; s.lon = wrapLon(a.from.lon + wrapLon(a.to.lon - a.from.lon) * e);
    const targetHdg = Math.abs(angleDiff(a.from.hdg, a.to.hdg)) <= 90 ? a.to.hdg : normDeg(a.to.hdg + 180);
    s.hdg = normDeg(a.from.hdg + angleDiff(a.from.hdg, targetHdg) * e);
    s.spd = f < 1 ? Math.round((haversine(a.from.lat, a.from.lon, a.to.lat, a.to.lon) / (dur / 1000)) / GEO.KN_TO_MS * 10) / 10 * (1 - Math.abs(2 * f - 1)) : 0;
    s.throttle = 0; s.rudder = 0;
    p.lastValid = { lat: s.lat, lon: s.lon };
    if (f < 1) return;
    const harbor = harborById(a.harbor);
    const geom = harbor && this.harborGeom(harbor.id);
    const b = geom && a.berthId ? (geom.berths || []).find((x) => x.id === a.berthId) : null;
    p.assist = null;
    if (!harbor) { this.sendYou(p, { correction: true }); return; }
    if (b) this.moorAt(p, harbor, b); else { s.lat = a.to.lat; s.lon = a.to.lon; this.setDocked(p, harbor.id, null); }
    this.event(p, 'info', 'Tugs cast off.');
    this.finishDock(p, harbor);
    this.sendYou(p, { correction: true });
  }
  // Client-reported contact with a quay, breakwater or another ship (rate-limited to one per 3 s).
  collision(p, m) {
    if (p.docked || p.assist || p.flooding >= 1) return;
    const now = Date.now();
    if (now - (p.lastCollision || 0) < 3000) return;
    const speedKn = Math.min(60, Math.abs(Number(m.speedKn)) || 0);
    if (speedKn < FEES.COLLISION_MIN_KN) return; // a nudge against the fenders
    p.lastCollision = now;
    const kind = m.kind === 'ship' || m.kind === 'breakwater' ? m.kind : 'quay';
    const dmg = Math.round(clamp(speedKn * 0.9, 0.5, 12) * (kind === 'ship' ? 0.6 : 1) * 10) / 10;
    p.cond = Math.max(0, p.cond - dmg);
    if (speedKn > 8) p.flooding = Math.min(1, p.flooding + 0.05);
    p.stats.collisions = (p.stats.collisions || 0) + 1;
    p.ship.spd *= 0.4;
    const what = kind === 'ship' ? 'another ship' : kind === 'breakwater' ? 'the breakwater' : 'the quay';
    this.event(p, 'warn', `${speedKn >= 8 ? 'Heavy contact' : speedKn >= 3 ? 'Collision' : 'Bumped'} with ${what} at ${speedKn.toFixed(1)} kn: hull −${dmg} %${speedKn > 8 ? ', taking water' : ''}. Condition ${Math.round(p.cond)} %.`);
    this.dropWarp(p, `Contact with ${what}.`, false);
    this.sendYou(p);
  }
  // Sell the current hull at shipValue; the yard leaves you a well-used pilot boat so the market is a real buy/sell market.
  sellShip(p) {
    if (!p.docked) return;
    const cls = p.ship.cls, C = SHIP_CLASSES[cls];
    if (cls === 'pilot') return this.event(p, 'warn', 'Nobody buys the pilot boat — it is the one hull the yard will not take.');
    const value = shipValue(cls, p.cond);
    const P = SHIP_CLASSES.pilot;
    if (cargoMass(p.cargo) > P.capacity) return this.event(p, 'warn', `Unload first: a pilot boat carries ${P.capacity} t and you have ${Math.round(cargoMass(p.cargo))} t aboard.`);
    const pax = p.jobs.filter((j) => j.pax).reduce((s, j) => s + j.pax, 0);
    if (pax > P.pax) return this.event(p, 'warn', 'Your passengers would not fit in a pilot boat. Deliver them first.');
    if (p.towing) return this.event(p, 'warn', 'Finish the tow first.');
    p.money += value; p.stats.earned += value;
    p.ship.cls = 'pilot'; p.cond = 60; p.flooding = 0; p.fuel = Math.min(p.fuel, P.fuelCap); p.sailsUp = true;
    p.serviceDue = this.simTime + SERVICE_INTERVAL_S / 2;
    this.event(p, 'info', `Sold the ${C.name} for ${fmt(value)} cr. The yard threw in a tired pilot boat (60 %) so you can get about.`);
    this.sendYou(p); this.sendHarbor(p);
  }
  // Yard service: 1 % of the hull price resets the 30-day maintenance clock that otherwise ramps wear up to +60 %.
  service(p) {
    if (!p.docked) return;
    const cost = serviceCostFor(p.ship.cls);
    if (p.money < cost) return this.event(p, 'warn', `A service costs ${fmt(cost)} cr. You have ${fmt(p.money)}.`);
    const overdue = Math.max(0, (this.simTime - (p.serviceDue || this.simTime)) / 86400);
    p.money -= cost; p.serviceDue = this.simTime + SERVICE_INTERVAL_S;
    this.event(p, 'info', `Engine and hull serviced for ${fmt(cost)} cr${overdue > 0 ? ` (${Math.ceil(overdue)} days overdue — wear back to normal)` : ''}. Next service due in ${FEES.SERVICE_INTERVAL_DAYS} days.`);
    this.sendYou(p); this.sendHarbor(p);
  }
  lookAround(p) {
    if (!p.docked) return;
    const st = this.harbors[p.docked];
    p.contactSeen = p.docked;
    if (st.contact) this.event(p, 'shady', `${st.contact.name} nods at you from behind the containers. "Looking for work that pays?"`);
    else this.event(p, 'info', 'You wander the quays. Nobody here wants to talk business today.');
    this.sendHarbor(p);
  }
  buyFuel(p, t) {
    if (!p.docked) return;
    const h = harborById(p.docked), C = SHIP_CLASSES[p.ship.cls];
    t = Math.max(0, Math.min(C.fuelCap - p.fuel, isFinite(t) ? t : C.fuelCap));
    const cost = Math.round(t * this.fuelPrice(h));
    if (t <= 0.01) return this.event(p, 'warn', 'Tanks are full.');
    if (cost > p.money) { t = Math.floor((p.money / this.fuelPrice(h)) * 10) / 10; if (t <= 0) return this.event(p, 'warn', 'You cannot afford any fuel.'); }
    const c2 = Math.round(t * this.fuelPrice(h));
    p.money -= c2; p.fuel = Math.min(C.fuelCap, p.fuel + t);
    const st = this.harbors[h.id];
    if (st.stock) { st.stock.fuel = Math.max(0, (st.stock.fuel || 0) - t); refreshPrices(h, st); }
    this.event(p, 'info', `Bunkered ${t.toFixed(1)} t for ${fmt(c2)} cr.`);
    this.sendYou(p); this.sendHarbor(p);
  }
  repair(p) {
    if (!p.docked) return;
    const cost = this.repairCost(p);
    if (cost <= 0) return this.event(p, 'warn', 'Nothing to repair.');
    if (cost > p.money) {
      const frac = p.money / cost; const gain = (100 - p.cond) * frac;
      if (gain < 1) return this.event(p, 'warn', 'You cannot afford repairs.');
      p.cond += gain; p.money = 0; p.flooding = 0;
      this.event(p, 'info', `Partial repairs: condition now ${Math.round(p.cond)} %.`);
    } else { p.money -= cost; p.cond = 100; p.flooding = 0; this.event(p, 'info', `Full overhaul for ${fmt(cost)} cr. Condition 100 %.`); }
    this.sendYou(p); this.sendHarbor(p);
  }
  buyKit(p) {
    if (!p.docked) return;
    if (p.money < 2500) return this.event(p, 'warn', 'A damage-control kit costs 2,500 cr.');
    p.money -= 2500; p.kits = (p.kits || 0) + 1;
    this.event(p, 'info', `Bought a damage-control kit (${p.kits} aboard).`);
    this.sendYou(p);
  }
  acceptJob(p, jobId) {
    if (!p.docked) return;
    const st = this.harbors[p.docked];
    let job = st.jobs.find((j) => j.id === jobId);
    let fromContact = false;
    if (!job && st.contact && p.contactSeen === p.docked) { job = st.contact.jobs.find((j) => j.id === jobId); fromContact = !!job; }
    if (!job) return this.event(p, 'warn', 'That contract is gone.');
    const C = SHIP_CLASSES[p.ship.cls];
    if (job.type === 'passengers' || job.type === 'charter') {
      const used = p.jobs.filter((j) => j.pax).reduce((s, j) => s + j.pax, 0);
      if (used + job.pax > C.pax) return this.event(p, 'warn', `Not enough berths (${C.pax - used} free).`);
      if (job.needsCat && !job.needsCat.includes(C.cat)) return this.event(p, 'warn', `Charter guests expect a ${job.needsCat.join(' or ')}; a ${C.name.toLowerCase()} will not do.`);
    } else if (job.type === 'tow') {
      if (p.jobs.some((j) => j.type === 'tow')) return this.event(p, 'warn', 'One tow at a time.');
    } else if (job.type === 'supply') {
      if (cargoMass(p.cargo) + job.qty > C.capacity) return this.event(p, 'warn', `Not enough deck space (${C.capacity - cargoMass(p.cargo)} t free).`);
      p.cargo.push({ good: 'supplies', qty: job.qty, contraband: false, jobId: job.id });
    } else if (job.type !== 'fishing') {
      if (cargoMass(p.cargo) + job.qty > C.capacity) return this.event(p, 'warn', `Not enough hold space (${C.capacity - cargoMass(p.cargo)} t free).`);
      p.cargo.push({ good: job.good, qty: job.qty, contraband: !!job.contraband, jobId: job.id });
    }
    if (fromContact) st.contact.jobs = st.contact.jobs.filter((j) => j.id !== jobId); else st.jobs = st.jobs.filter((j) => j.id !== jobId);
    p.jobs.push({ ...job, acceptedAt: this.simTime });
    this.event(p, fromContact ? 'shady' : 'info', `${fromContact ? 'Deal.' : 'Contract signed:'} ${job.title} — ${fmt(job.pay)} cr.`);
    this.sendYou(p); this.sendHarbor(p);
  }
  abandonJob(p, jobId) {
    const j = p.jobs.find((x) => x.id === jobId); if (!j) return;
    p.jobs = p.jobs.filter((x) => x.id !== jobId);
    // Contract cargo goes back to the shipper (docked) or over the side (at sea); it never becomes free goods.
    p.cargo = p.cargo.filter((c) => c.jobId !== j.id);
    if (j.towing) p.towing = null;
    const penalty = Math.min(p.money, Math.round(j.pay * 0.1));
    p.money -= penalty;
    this.event(p, 'warn', `Abandoned: ${j.title}. Cancellation fee ${fmt(penalty)} cr.`);
    this.sendYou(p);
  }
  deliverJobs(p, harbor) {
    for (const j of [...p.jobs]) {
      if (j.to !== harbor.id) continue;
      let ok = false, frac = 1;
      if (j.type === 'passengers' || j.type === 'charter') ok = true;
      else if (j.type === 'tow') { if (p.towing === j.id) { ok = true; p.towing = null; } }
      else if (j.type === 'supply') { if (j.loaded === false) ok = true; }
      else if (j.type === 'fishing') {
        const stacks = p.cargo.filter((c) => c.good === 'fish' && c.caught && !c.jobId);
        const have = stacks.reduce((s, c) => s + c.qty, 0);
        if (have >= j.qty * 0.25) {
          ok = true; frac = Math.min(1, have / j.qty);
          let left = Math.min(have, j.qty);
          for (const c of stacks) { const k = Math.min(c.qty, left); c.qty = Math.round((c.qty - k) * 10) / 10; left -= k; }
          p.cargo = p.cargo.filter((c) => c.qty > 0);
        }
      } else {
        const stack = p.cargo.find((c) => c.jobId === j.id);
        if (stack) { ok = true; frac = Math.min(1, stack.qty / j.qty); p.cargo = p.cargo.filter((c) => c !== stack); }
      }
      if (!ok) continue;
      let pay = Math.round(j.pay * frac);
      const late = this.simTime > j.deadline;
      if (late) pay = Math.round(pay * 0.5);
      if (frac < 1) this.event(p, 'warn', `Short delivery: only ${Math.round(frac * 100)} % of the contracted quantity.`);
      // Demand bonus: a port short of the good pays extra, and the delivery replenishes its stock.
      let bonus = 0;
      const st = this.harbors[harbor.id];
      if (st && j.good && !j.contraband && j.type !== 'supply' && st.stock && st.stock[j.good] != null) {
        bonus = Math.round(pay * demandBonus(st, j.good));
        st.stock[j.good] += Math.round(j.qty * frac); refreshPrices(harbor, st);
      }
      pay += bonus;
      p.money += pay; p.stats.delivered++; p.stats.earned += pay;
      p.jobs = p.jobs.filter((x) => x.id !== j.id);
      this.event(p, j.contraband ? 'shady' : 'info', `${late ? 'Late delivery (half pay)' : 'Delivered'}: ${j.title} — +${fmt(pay)} cr${bonus ? ` (incl. ${fmt(bonus)} demand bonus)` : ''}.`);
    }
  }
  // Supply/demand: buying takes from the harbour stock (price rises), selling adds to it (price falls).
  tradeGoods(p, good, qty, buying) {
    if (!p.docked) return;
    const h = harborById(p.docked), st = this.harbors[p.docked];
    if (!isGood(good) || GOODS[good].contraband || !(qty > 0)) return;
    qty = Math.min(5000, Math.round(qty));
    if (!st.stock || !st.target) refreshPrices(h, st);
    const price = st.market[good] = Math.max(1, st.market[good] || refreshPrices(h, st)[good]);
    if (buying) {
      const C = SHIP_CLASSES[p.ship.cls];
      const free = C.capacity - cargoMass(p.cargo);
      const avail = Math.floor(st.stock[good] ?? 0);
      if (avail <= 0) return this.event(p, 'warn', `${GOODS[good].name}: sold out here for now.`);
      qty = Math.min(qty, free, Math.floor(p.money / price), avail);
      if (qty <= 0) return this.event(p, 'warn', 'No space or no money.');
      p.money -= qty * price;
      const stack = p.cargo.find((c) => c.good === good && !c.jobId);
      if (stack) stack.qty += qty; else p.cargo.push({ good, qty, contraband: false, jobId: null });
      st.stock[good] = Math.max(0, st.stock[good] - qty);
      refreshPrices(h, st);
      const d = st.market[good] - price;
      this.event(p, 'info', `Bought ${qty} t of ${GOODS[good].name} at ${fmt(price)} cr/t${d > 0 ? ` (price now ${fmt(st.market[good])})` : ''}.`);
    } else {
      const stacks = p.cargo.filter((c) => c.good === good && !c.jobId);
      const have = stacks.reduce((s, c) => s + c.qty, 0);
      qty = Math.min(qty, have);
      if (qty <= 0) return this.event(p, 'warn', 'Nothing to sell (contract cargo cannot be sold).');
      let left = qty;
      for (const c of stacks) { const k = Math.min(c.qty, left); c.qty -= k; left -= k; }
      p.cargo = p.cargo.filter((c) => c.qty > 0);
      p.money += qty * price; p.stats.earned += qty * price;
      st.stock[good] = (st.stock[good] || 0) + qty;
      refreshPrices(h, st);
      const d = price - st.market[good];
      this.event(p, 'info', `Sold ${qty} t of ${GOODS[good].name} at ${fmt(price)} cr/t${d > 0 ? ` (price now ${fmt(st.market[good])})` : ''}.`);
    }
    this.sendYou(p); this.sendHarbor(p);
  }
  dumpCargo(p, good) {
    if (!isGood(good)) return;
    const before = p.cargo.length;
    p.cargo = p.cargo.filter((c) => c.good !== good);
    if (p.cargo.length !== before) {
      for (const j of [...p.jobs]) if (j.good === good && j.type !== 'fishing') { p.jobs = p.jobs.filter((x) => x !== j); }
      this.event(p, 'warn', `Dumped all ${GOODS[good]?.name || good} overboard.`);
      this.sendYou(p);
    }
  }
  buyShip(p, cls) {
    if (!p.docked) return;
    const C = SHIP_CLASSES[cls];
    if (!C || !C.price) return;
    if (cls === p.ship.cls) return this.event(p, 'warn', 'You already own this class.');
    const tradeIn = Math.round(SHIP_CLASSES[p.ship.cls].price * 0.5 * (p.cond / 100));
    const cost = C.price - tradeIn;
    if (p.money < cost) return this.event(p, 'warn', `${C.name} costs ${fmt(cost)} cr after trade-in. You have ${fmt(p.money)}.`);
    if (cargoMass(p.cargo) > C.capacity) return this.event(p, 'warn', 'Your cargo would not fit in the new ship. Sell or deliver first.');
    p.money -= cost; p.ship.cls = cls; p.cond = 100; p.flooding = 0; p.fuel = Math.min(p.fuel, C.fuelCap);
    p.serviceDue = this.simTime + SERVICE_INTERVAL_S;
    this.event(p, 'info', `Took delivery of a ${C.name}. Trade-in credited ${fmt(tradeIn)} cr.`);
    this.sendYou(p); this.sendHarbor(p);
  }

  // ------------------------------------------------------------------ at-sea actions
  patch(p) {
    if (!p.kits) return this.event(p, 'warn', 'No damage-control kit aboard.');
    p.kits--; p.cond = Math.min(100, p.cond + 15); p.flooding = Math.max(0, p.flooding - 0.3);
    this.event(p, 'info', `Crew patched the hull: condition ${Math.round(p.cond)} %, flooding ${Math.round(p.flooding * 100)} %.`);
    this.sendYou(p);
  }
  setFishing(p, on) {
    if (p.docked) return;
    if (on && !this.groundAt(p.ship.lat, p.ship.lon)) return this.event(p, 'warn', 'No fishing ground here. Check the chart for fishing banks (dashed circles).');
    if (!!p.fishing === !!on) return;
    p.fishing = on;
    if (on) { const g = this.groundAt(p.ship.lat, p.ship.lon); p.fishInfo = { ground: g.name, rate: 0, caught: 0, tooFast: Math.abs(p.ship.spd) >= 3 }; }
    this.event(p, 'info', on ? `Nets out on the ${this.groundAt(p.ship.lat, p.ship.lon).name}. Keep her under 3 knots; the catch rate shows in the HUD.` : `Nets hauled in. ${p.fishInfo ? p.fishInfo.caught + ' t caught this haul.' : ''}`);
    this.sendYou(p);
  }
  groundAt(lat, lon) {
    for (const g of FISHING_GROUNDS) if (haversine(lat, lon, g.lat, g.lon) / 1000 <= g.radiusKm) return g;
    return null;
  }
  tow(p) {
    if (p.docked) return;
    if (p.hail) return this.event(p, 'law', 'No tug will come while the coast guard is hailing you.');
    const { harbor, units } = this.nearestHarbor(p.ship.lat, p.ship.lon);
    const cost = Math.min(p.money, 3000 + Math.round(units * 2));
    p.money -= cost; p.hail = null; p.assist = null; this.setDocked(p, harbor.id, null);
    this.event(p, 'warn', `Towed to ${harbor.name} for ${fmt(cost)} cr.`);
    this.sendYou(p); this.sendHarbor(p);
  }
  grounding(p) {
    const now = Date.now();
    if (p.lastGrounding && now - p.lastGrounding < 4000) return;
    p.lastGrounding = now;
    p.cond = Math.max(0, p.cond - 5);
    if (p.cond < 20) p.flooding = Math.min(1, p.flooding + 0.05);
    this.event(p, 'warn', `Grounding! Hull condition ${Math.round(p.cond)} %.`);
    this.dropWarp(p, 'Aground.', false);
    this.sendYou(p);
  }

  // ------------------------------------------------------------------ law
  inspect(p, by) {
    p.stats.inspected++; p.lastInspected = this.simTime;
    const contra = p.cargo.filter((c) => c.contraband);
    if (!contra.length) { this.event(p, 'law', `${by}: papers and holds in order. Safe voyage.`); return false; }
    p.stats.caught++;
    const value = cargoValue(contra);
    const fine = LAW.FINE_FLAT + LAW.FINE_MULT * value;
    p.cargo = p.cargo.filter((c) => !c.contraband);
    p.jobs = p.jobs.filter((j) => !j.contraband);
    if (p.wanted >= LAW.IMPOUND_RESET_WANTED) {
      this.forcedReset(p, `${by} seized the vessel. Repeat offender: ship forfeited.`);
      return true;
    }
    if (p.money >= fine) {
      p.money -= fine; p.stats.fined += fine; this.bumpWanted(p, 1);
      this.event(p, 'law', `${by} found ${contra.map((c) => `${c.qty} t ${GOODS[c.good].name}`).join(', ')}. Confiscated. Fine ${fmt(fine)} cr. Wanted level ${p.wanted}.`);
    } else {
      this.impound(p, by, fine);
    }
    return true;
  }
  impound(p, by, fine) {
    const { harbor } = this.nearestHarbor(p.ship.lat, p.ship.lon);
    p.stats.fined += p.money; p.money = 0; this.bumpWanted(p, 1);
    p.hail = null; this.setDocked(p, harbor.id, null);
    this.convoyLeave(p, true);
    this.event(p, 'law', `${by}: you cannot pay the ${fmt(fine)} cr fine. Ship impounded and towed to ${harbor.name}; all credits seized. Wanted level ${p.wanted}. One more and the ship is forfeit.`);
    this.sendYou(p); this.sendHarbor(p);
  }
  forcedReset(p, why) {
    const { harbor } = this.nearestHarbor(p.ship.lat, p.ship.lon);
    p.ship.cls = 'coaster'; p.cond = 40; p.flooding = 0; p.fuel = 20; p.cargo = []; p.jobs = []; p.money = 500; p.wanted = 0; p.kits = 0;
    p.hail = null; p.towing = null; p.voyage = null; p.serviceDue = this.simTime + SERVICE_INTERVAL_S / 3; this.setDocked(p, harbor.id, null);
    this.convoyLeave(p, true);
    this.event(p, 'law', `${why} You start over at ${harbor.name} with a rust-bucket coaster and 500 cr.`);
    this.sendYou(p); this.sendHarbor(p);
  }
  bumpWanted(p, n) { p.wanted = Math.min(3, p.wanted + n); p.wantedAt = this.simTime; }

  updateCutters(dt) {
    const dts = dt * SIM.MOTION_SCALE;
    const online = [...this.byId.values()].filter((o) => o.online && !o.docked && o.flooding < 1);
    for (const c of this.cutters) {
      let target = null, kn = 18;
      if (c.state === 'patrol') {
        const wp = c.pts[c.wp];
        target = { lat: wp[0], lon: wp[1] };
        if (haversine(c.lat, c.lon, wp[0], wp[1]) < 1500) c.wp = (c.wp + 1) % c.pts.length;
        // Encounter check: players entering hail range.
        for (const p of online) {
          const u = unitsBetween(c.lat, c.lon, p.ship.lat, p.ship.lon);
          const key = c.id;
          p.inRange = p.inRange || {};
          const was = p.inRange[key];
          p.inRange[key] = u <= LAW.HAIL_RANGE_U;
          if (!was && p.inRange[key] && !p.hail && this.simTime - p.lastInspected > 1200 && Date.now() - (p.lastHailAt || 0) > 90000) {
            const chance = LAW.INSPECT_CHANCE[Math.min(3, p.wanted)] * (p.wanted ? 1 : 0.6);
            if (this.rnd() < chance) this.hail(c, p);
          }
        }
      } else {
        const p = this.byId.get(c.targetId);
        if (!p || !p.online || p.docked || !p.hail || p.flooding >= 1) { this.clearHail(c, p); continue; }
        target = { lat: p.ship.lat, lon: p.ship.lon };
        kn = c.state === 'pursue' ? LAW.PURSUIT_KN : 22;
        c.timer -= dt;
        const u = unitsBetween(c.lat, c.lon, p.ship.lat, p.ship.lon);
        if (c.state === 'hail') {
          if (c.timer <= 0) {
            if (Math.abs(p.ship.spd) <= LAW.HEAVE_TO_KN) {
              p.hail.state = 'inspecting'; c.state = 'inspect'; c.timer = 8; this.event(p, 'law', `${c.name} comes alongside. Boarding party inspecting.`);
            } else {
              this.bumpWanted(p, 1); p.hail.state = 'pursued'; c.state = 'pursue'; c.timer = LAW.PURSUIT_SECONDS;
              this.event(p, 'law', `You failed to heave to. ${c.name} is in pursuit at ${LAW.PURSUIT_KN} kn. Wanted level ${p.wanted}.`);
            }
            this.sendYou(p);
          }
        } else if (c.state === 'inspect') {
          if (c.timer <= 0) { this.inspect(p, c.name); this.clearHail(c, p); }
        } else if (c.state === 'pursue') {
          if (u < 150 && Math.abs(p.ship.spd) < 8) {
            this.event(p, 'law', `${c.name} has you. Forced inspection.`); this.inspect(p, c.name); this.clearHail(c, p);
          } else if (c.timer <= 0) {
            this.event(p, 'law', `${c.name} broke off the pursuit. Your name is on a list now.`); this.clearHail(c, p);
          }
        }
      }
      if (target) {
        const b = bearing(c.lat, c.lon, target.lat, target.lon);
        const d = angleDiff(c.hdg, b);
        c.hdg = normDeg(c.hdg + clamp(d, -12 * dt, 12 * dt));
        const dist = haversine(c.lat, c.lon, target.lat, target.lon);
        c.spd += (Math.min(kn, dist / 200) - c.spd) * Math.min(1, dt / 8);
        const step = c.spd * GEO.KN_TO_MS * dts;
        if (step > 1) { const n = destination(c.lat, c.lon, c.hdg, step); c.lat = n.lat; c.lon = n.lon; }
        // Set and drift: surface current plus tidal stream (the helmsman corrects for it over the next turns).
        c.driftT = (c.driftT || 0) + dts;
        if (c.driftT >= 5) {
          const cur = this.currentAtPos(c.lat, c.lon);
          c.lat = clampLat(c.lat + (cur.v * c.driftT) / GEO.M_PER_DEG_LAT);
          c.lon = wrapLon(c.lon + (cur.u * c.driftT) / (GEO.M_PER_DEG_LON_EQ * (Math.cos(c.lat * Math.PI / 180) || 1e-6)));
          c.driftT = 0;
        }
      }
    }
  }
  hail(c, p) {
    p.lastHailAt = Date.now();
    p.hail = { cutter: c.name, cutterId: c.id, until: Date.now() + LAW.HAIL_SECONDS * 1000, state: 'hailed' };
    c.state = 'hail'; c.targetId = p.id; c.timer = LAW.HAIL_SECONDS;
    this.dropWarp(p, `${c.name} is hailing you.`, false);
    this.event(p, 'law', `${c.name} on channel 16: "Vessel ${p.name}, this is the coast guard. Heave to for inspection. You have ${LAW.HAIL_SECONDS} seconds."`);
    this.sendYou(p);
  }
  clearHail(c, p) {
    c.state = 'patrol'; c.targetId = null; c.timer = 0;
    if (p && p.hail && p.hail.cutterId === c.id) { p.hail = null; this.sendYou(p); }
  }

  // ------------------------------------------------------------------ survival tick
  tick(dt) {
    this.simTime = Date.now() / 1000;
    const simHours = (dt * SIM.CLOCK_SCALE) / 3600;
    this.updateWind(dt);
    this.updateStorms(dt);
    this.updateRescues(dt);
    this.requestWeather();
    for (const p of this.byId.values()) {
      // Time warp: drop back to real time the moment a condition stops holding (before anything else, so a docked,
      // assisted or rescued player is caught too).
      if (p.warp !== 1) this.checkWarp(p);
      if (p.rescue) continue;
      if (p.docked) continue;
      if (p.assist) { this.stepAssist(p); continue; }
      if (!p.online) { if (p.voyage) this.simulateOffline(p, dt); else continue; }
      if (p.flooding >= 1) { this.sink(p); continue; }
      const s = p.ship, C = SHIP_CLASSES[s.cls];
      const load = cargoMass(p.cargo) / C.capacity;
      const underway = Math.abs(s.throttle) > 0.03 || Math.abs(s.spd) > 0.5;
      const wx = this.weatherAt(s.lat, s.lon);
      // The ship's own clock: warp multiplies everything that happens aboard per hour (the world clock stays real time).
      const hrs = simHours * this.warpOf(p);
      if (!(p.serviceDue > 0)) p.serviceDue = this.simTime + SERVICE_INTERVAL_S;
      if (underway && C.crewCost) p.money = Math.max(0, p.money - C.crewCost * hrs * (p.towing ? 1.2 : 1));
      if (p.fuel > 0 && Math.abs(s.throttle) > 0.01) {
        const burn = fuelBurnPerSimHour(s.cls, s.throttle, load, headwindFactor(s.hdg, wx.wind), p.cond) * hrs * (p.towing ? 1.3 : 1);
        p.fuel = Math.max(0, p.fuel - burn);
        if (p.fuel === 0) this.event(p, 'warn', 'Fuel exhausted. Engine stopped. You are drifting — call a tow or wait for a kind soul.');
        else if (p.fuel < C.fuelCap * 0.1 && !p.lowFuelWarned) { p.lowFuelWarned = true; this.event(p, 'warn', 'Low fuel: under 10 % remaining.'); }
        if (p.fuel > C.fuelCap * 0.2) p.lowFuelWarned = false;
      }
      if (underway && p.cond > 0) {
        // Overdue maintenance ramps the wear multiplier (+2 %/day past serviceDue, up to +60 %).
        const svc = serviceWearMul(p.serviceDue, this.simTime);
        p.cond = Math.max(0, p.cond - wearPerSimHour(s.throttle, wx.wind.spd, C.wearMul) * svc * hrs);
        if (svc > 1 && !p.serviceWarned) { p.serviceWarned = true; this.event(p, 'warn', 'Service overdue: the engineer reports rising wear. Book a service at the next yard (1 % of the hull price).'); }
        if (svc <= 1) p.serviceWarned = false;
        if (p.cond < 30 && !p.condWarned) { p.condWarned = true; this.event(p, 'warn', 'Hull condition under 30 %: steering is getting sluggish, leaks likely. Find a yard.'); }
        if (p.cond > 50) p.condWarned = false;
      }
      if (p.cond <= 0) {
        p.flooding = Math.min(1, p.flooding + (1.2 + 2 * wx.sea) * hrs);
        if (!p.floodWarned) { p.floodWarned = true; this.event(p, 'warn', 'Hull failed: taking on water! Use a damage-control kit (K) or make for the nearest harbour.'); }
      } else if (p.flooding > 0 && p.cond > 30) {
        p.flooding = Math.max(0, p.flooding - 0.3 * hrs); // pumps keep up on a sound hull
      }
      if (p.flooding < 0.2) p.floodWarned = false;
      if (p.fishing) {
        const g = this.groundAt(s.lat, s.lon);
        if (!g) { p.fishing = false; this.event(p, 'info', 'Left the fishing ground; nets hauled in.'); this.sendYou(p); }
        else if (Math.abs(s.spd) < 3) {
          const free = C.capacity - cargoMass(p.cargo);
          const rate = C.fishRate * g.richness * 5 * (wx.storm > 0.5 ? 0.4 : 1);
          const add = Math.max(0, Math.min(free, rate * hrs));
          p.fishInfo = { ground: g.name, rate: Math.round(rate * 10) / 10, caught: Math.round(((p.fishInfo && p.fishInfo.caught) || 0) + add), tooFast: false };
          if (add > 0) {
            const stack = p.cargo.find((c) => c.good === 'fish' && c.caught && !c.jobId);
            if (stack) stack.qty = Math.round((stack.qty + add) * 10) / 10; else p.cargo.push({ good: 'fish', qty: Math.round(add * 10) / 10, contraband: false, jobId: null, caught: true });
          } else if (free <= 0 && !p.fullWarned) { p.fullWarned = true; this.event(p, 'info', 'Hold is full of fish.'); }
        } else {
          p.fishInfo = { ground: g.name, rate: 0, caught: (p.fishInfo && p.fishInfo.caught) || 0, tooFast: true };
        }
      }
      if (p.wanted > 0 && this.simTime - p.wantedAt > LAW.WANTED_DECAY_SIM_HOURS * 3600) { p.wanted--; p.wantedAt = this.simTime; this.event(p, 'law', `Wanted level dropped to ${p.wanted}.`); }
      for (const j of p.jobs) if (!j.expiredWarned && this.simTime > j.deadline) { j.expiredWarned = true; this.event(p, 'warn', `Deadline passed: ${j.title} (half pay on delivery).`); }
    }
    this.updateCutters(dt);
    // Job boards regen lazily on dock; markets drift every minute; wrecks expire.
    if (Date.now() - this.lastEcon > 60000) this.driftMarkets();
    const before = this.wrecks.length;
    this.wrecks = this.wrecks.filter((w) => this.simTime - w.simTime < 48 * 3600 && w.cargo.length);
    if (this.wrecks.length !== before) this.broadcast({ t: 'wrecks', wrecks: this.wrecks });
    for (const [id, o] of this.offers) if (Date.now() > o.expires) { this.offers.delete(id); const a = this.byId.get(o.from); if (a) this.event(a, 'info', 'Your trade offer expired.'); }
    if (Date.now() - this.lastSave > 30000) this.saveState();
  }
  // Keep the weather cache warm for every online player's cell (every 30 s) and every harbour (every 10 min).
  // WeatherService.request() dedups, rate-limits and backs off by itself; the calls here are cheap.
  requestWeather() {
    if (!this.weather) return;
    const now = Date.now();
    if (now - this.lastWxRequest < 30000) return;
    const harbourSweep = now - (this.lastWxHarbors || 0) > 600000;
    this.lastWxRequest = now;
    try {
      for (const p of this.byId.values()) if (p.online || (p.voyage && !p.docked)) this.weather.request(p.ship.lat, p.ship.lon);
      if (harbourSweep) { this.lastWxHarbors = now; for (const h of HARBORS) { const a = this.harborAnchor(h); this.weather.request(a.lat, a.lon); } }
    } catch (e) { this.log(`[game] weather.request failed: ${e.message}`); }
  }
  updateWind(dt) {
    // Slow random walk in direction and speed. Only the fallback when no real data covers a position.
    this.wind.dir = normDeg((this.wind.dir || 240) + (this.rnd() - 0.5) * 2 * dt);
    this.wind.spd = clamp((this.wind.spd || 7) + (this.rnd() - 0.5) * 0.3 * dt, 1, 24);
    const r = (this.wind.dir + 180) * Math.PI / 180; // dir = where the wind comes FROM
    this.wind.u = Math.sin(r) * this.wind.spd; this.wind.v = Math.cos(r) * this.wind.spd;
  }
  sink(p) {
    const s = p.ship;
    this.dropWarp(p, 'Abandon ship.', false);
    p.stats.sunk++;
    if (p.cargo.length) {
      this.wrecks.push({ id: 'w' + shortId(), lat: s.lat, lon: s.lon, cargo: p.cargo, owner: p.name, cls: s.cls, simTime: this.simTime, time: Date.now() });
      this.broadcast({ t: 'wrecks', wrecks: this.wrecks });
    }
    this.broadcast({ t: 'chat', from: 'Shipping news', id: 'sys', text: `${p.name}'s ${SHIP_CLASSES[s.cls].name} went down at ${s.lat.toFixed(2)}, ${s.lon.toFixed(2)}.`, time: Date.now() });
    const lostJobs = p.jobs.length;
    p.cargo = []; p.jobs = []; p.fishing = false; p.hail = null; p.towing = null; p.voyage = null; this.convoyLeave(p, true);
    s.spd = 0; s.throttle = 0; s.rudder = 0;
    this.event(p, 'warn', `Your ship sank${lostJobs ? ` with ${lostJobs} contract(s)` : ''}. You are in the life raft.`);
    this.startRescue(p);
    this.sendYou(p);
  }

  // ------------------------------------------------------------------ multiplayer interactions
  near(p, q, range) {
    if (p.docked && q.docked) return p.docked === q.docked;
    if (p.docked || q.docked) return false;
    return unitsBetween(p.ship.lat, p.ship.lon, q.ship.lat, q.ship.lon) <= range;
  }
  board(p, targetId) {
    const q = this.byId.get(targetId);
    if (!q || !q.online || q.id === p.id) return;
    if (p.docked || q.docked) return this.event(p, 'warn', 'Not at sea.');
    if (!this.near(p, q, INTERACT.BOARD_RANGE_U)) return this.event(p, 'warn', `Get within ${INTERACT.BOARD_RANGE_U} m to board.`);
    if (Math.abs(q.ship.spd) > 6) return this.event(p, 'warn', 'Target too fast to board (needs < 6 kn).');
    if (Math.abs(p.ship.spd - q.ship.spd) > 4) return this.event(p, 'warn', 'Match speeds first (closing speed < 4 kn).');
    if (Date.now() - (p.lastBoard || 0) < 20000) return this.event(p, 'warn', 'Your crew is still regrouping.');
    p.lastBoard = Date.now();
    let chance = 0.55;
    const escorted = q.convoyId && [...this.byId.values()].some((o) => o.id !== q.id && o.online && o.convoyId === q.convoyId && !o.docked && unitsBetween(o.ship.lat, o.ship.lon, q.ship.lat, q.ship.lon) <= INTERACT.CONVOY_ESCORT_U);
    if (escorted) chance -= 0.25;
    chance += 0.1 * (SHIP_CLASSES[p.ship.cls].displacement > SHIP_CLASSES[q.ship.cls].displacement ? 1 : -1);
    this.bumpWanted(p, 2);
    if (this.rnd() < chance && q.cargo.length) {
      const taken = [];
      const free = SHIP_CLASSES[p.ship.cls].capacity - cargoMass(p.cargo);
      let room = free;
      for (const c of q.cargo) {
        const k = Math.min(room, Math.floor(c.qty / 2));
        if (k <= 0) continue;
        c.qty -= k; room -= k;
        const stack = p.cargo.find((x) => x.good === c.good && !x.jobId && x.contraband === c.contraband);
        if (stack) stack.qty += k; else p.cargo.push({ good: c.good, qty: k, contraband: c.contraband, jobId: null });
        taken.push(`${k} t ${GOODS[c.good].name}`);
      }
      q.cargo = q.cargo.filter((c) => c.qty > 0);
      p.stats.pirated++; q.stats.boarded++;
      this.event(p, 'pirate', `Boarding succeeded. Took ${taken.join(', ') || 'nothing of value'}. You are now wanted (level ${p.wanted}).`);
      this.event(q, 'pirate', `${p.name} boarded you and took ${taken.join(', ') || 'nothing'}!${escorted ? '' : ' Travelling in a convoy would have halved their odds.'}`);
      this.broadcast({ t: 'chat', from: 'Shipping news', id: 'sys', text: `Piracy: ${p.name} boarded ${q.name}.`, time: Date.now() });
    } else {
      p.cond = Math.max(0, p.cond - 10);
      this.event(p, 'pirate', `Boarding repelled${escorted ? ' by the convoy escort' : ''}. Hull damaged (−10 %). You are wanted (level ${p.wanted}).`);
      this.event(q, 'pirate', `${p.name} tried to board you and was beaten off.`);
    }
    this.sendYou(p); this.sendYou(q);
  }
  salvage(p, wreckId) {
    const w = this.wrecks.find((x) => x.id === wreckId);
    if (!w) return this.event(p, 'warn', 'Nothing left to salvage there.');
    if (p.docked) return;
    if (unitsBetween(p.ship.lat, p.ship.lon, w.lat, w.lon) > INTERACT.SALVAGE_RANGE_U) return this.event(p, 'warn', 'Get closer to the wreck.');
    if (Math.abs(p.ship.spd) > 3) return this.event(p, 'warn', 'Slow down below 3 kn to work the wreck.');
    let room = SHIP_CLASSES[p.ship.cls].capacity - cargoMass(p.cargo);
    const got = [];
    for (const c of w.cargo) {
      const k = Math.min(room, c.qty); if (k <= 0) continue;
      c.qty -= k; room -= k;
      const stack = p.cargo.find((x) => x.good === c.good && !x.jobId && x.contraband === c.contraband);
      if (stack) stack.qty += k; else p.cargo.push({ good: c.good, qty: k, contraband: c.contraband, jobId: null });
      got.push(`${k} t ${GOODS[c.good].name}`);
    }
    w.cargo = w.cargo.filter((c) => c.qty > 0);
    if (!w.cargo.length) this.wrecks = this.wrecks.filter((x) => x !== w);
    this.broadcast({ t: 'wrecks', wrecks: this.wrecks });
    this.event(p, 'info', got.length ? `Salvaged ${got.join(', ')} from ${w.owner}'s wreck.` : 'No room in the hold.');
    this.sendYou(p);
  }
  tradeOffer(p, m) {
    const q = this.byId.get(m.toId);
    if (!q || !q.online || q.id === p.id) return this.event(p, 'warn', 'No such player online.');
    if (!this.near(p, q, INTERACT.TRADE_RANGE_U)) return this.event(p, 'warn', 'Trade partner must be alongside (150 m) or docked in the same harbour.');
    const good = m.good, qty = Math.round(+m.qty), price = Math.round(+m.price);
    if (!isGood(good) || !(qty > 0) || !(price >= 0) || price > 1e9) return;
    const have = p.cargo.filter((c) => c.good === good && !c.jobId).reduce((s, c) => s + c.qty, 0);
    if (have < qty) return this.event(p, 'warn', 'You do not have that much free (non-contract) cargo.');
    const id = 'o' + shortId();
    const offer = { id, from: p.id, to: q.id, good, qty, price, expires: Date.now() + 60000 };
    this.offers.set(id, offer);
    this.send(q, { t: 'trade', offer: { ...offer, fromName: p.name, goodName: GOODS[good].name, contraband: GOODS[good].contraband } });
    this.event(p, 'info', `Offered ${qty} t ${GOODS[good].name} to ${q.name} for ${fmt(price)} cr.`);
  }
  tradeAccept(p, offerId) {
    const o = this.offers.get(offerId);
    if (!o || o.to !== p.id) return;
    const seller = this.byId.get(o.from);
    this.offers.delete(offerId);
    if (!seller || !seller.online || !this.near(seller, p, INTERACT.TRADE_RANGE_U)) return this.event(p, 'warn', 'Seller is out of range.');
    if (p.money < o.price) return this.event(p, 'warn', 'You cannot afford it.');
    const room = SHIP_CLASSES[p.ship.cls].capacity - cargoMass(p.cargo);
    if (room < o.qty) return this.event(p, 'warn', 'No room in the hold.');
    const sellerStacks = seller.cargo.filter((x) => x.good === o.good && !x.jobId);
    if (sellerStacks.reduce((s, c) => s + c.qty, 0) < o.qty) return this.event(p, 'warn', 'Seller no longer has the goods.');
    let left = o.qty;
    for (const c of sellerStacks) { const k = Math.min(c.qty, left); c.qty -= k; left -= k; }
    seller.cargo = seller.cargo.filter((c) => c.qty > 0);
    const stack = p.cargo.find((x) => x.good === o.good && !x.jobId);
    if (stack) stack.qty += o.qty; else p.cargo.push({ good: o.good, qty: o.qty, contraband: GOODS[o.good].contraband, jobId: null });
    p.money -= o.price; seller.money += o.price; seller.stats.earned += o.price;
    this.event(p, 'info', `Bought ${o.qty} t ${GOODS[o.good].name} from ${seller.name} for ${fmt(o.price)} cr.`);
    this.event(seller, 'info', `${p.name} accepted: +${fmt(o.price)} cr.`);
    this.sendYou(p); this.sendYou(seller);
  }
  tradeDecline(p, offerId) {
    const o = this.offers.get(offerId); if (!o || o.to !== p.id) return;
    this.offers.delete(offerId);
    const s = this.byId.get(o.from); if (s) this.event(s, 'info', `${p.name} declined your offer.`);
  }
  cancelOffersOf(p) { for (const [id, o] of this.offers) if (o.from === p.id || o.to === p.id) this.offers.delete(id); }
  convoyInvite(p, targetId) {
    const q = this.byId.get(targetId);
    if (!q || !q.online || q.id === p.id) return;
    if (!this.near(p, q, INTERACT.CONVOY_ESCORT_U * 2)) return this.event(p, 'warn', 'Too far away to form up.');
    if (!p.convoyId) { const id = 'c' + shortId(); this.convoys.set(id, { id, members: [p.id], leader: p.id }); p.convoyId = id; }
    this.invites.set(q.id + ':' + p.convoyId, Date.now() + 120000);
    this.send(q, { t: 'convoy_invite', convoyId: p.convoyId, from: p.name, fromId: p.id });
    this.event(p, 'info', `Invited ${q.name} to your convoy.`);
    this.sendYou(p);
  }
  convoyAccept(p, convoyId) {
    const c = this.convoys.get(convoyId); if (!c) return this.event(p, 'warn', 'That convoy no longer exists.');
    const inv = this.invites.get(p.id + ':' + convoyId);
    if (!inv || inv < Date.now()) return this.event(p, 'warn', 'No open invitation to that convoy.');
    this.invites.delete(p.id + ':' + convoyId);
    if (p.convoyId === convoyId) return;
    if (p.convoyId) this.convoyLeave(p, true);
    c.members.push(p.id); p.convoyId = c.id;
    for (const id of c.members) { const o = this.byId.get(id); if (o) { this.event(o, 'info', `${p.name} joined the convoy (${c.members.length} ships).`); this.sendYou(o); } }
    this.broadcast({ t: 'convoy', convoy: c });
  }
  convoyLeave(p, silent) {
    const c = p.convoyId && this.convoys.get(p.convoyId);
    p.convoyId = null;
    if (!c) return;
    c.members = c.members.filter((id) => id !== p.id);
    if (!c.members.length) this.convoys.delete(c.id);
    else { if (c.leader === p.id) c.leader = c.members[0]; for (const id of c.members) { const o = this.byId.get(id); if (o) { this.event(o, 'info', `${p.name} left the convoy.`); this.sendYou(o); } } }
    if (!silent) this.event(p, 'info', 'You left the convoy.');
    this.sendYou(p);
  }

  // ------------------------------------------------------------------ v0.4: time warp (docs/V4-CONTRACTS.md §1)
  // The world clock stays real time for everyone. Warp speeds up one ship: the client integrates dt × factor, the server
  // multiplies the movement budget and everything consumed aboard (fuel, wear, wages, catch, flooding) by the factor.
  warpOf(p) { return WARP.LEVELS.includes(p.warp) ? p.warp : 1; }
  // Movement budget factor: the current level, or the level just dropped from while states sent before the drop arrive.
  warpBudgetFactor(p, now = Date.now()) { return Math.max(this.warpOf(p), p.warpGraceUntil > now && WARP.LEVELS.includes(p.warpGraceFactor) ? p.warpGraceFactor : 1); }
  // `action: set_warp {factor, route}`. 1× is always accepted; higher levels only while every condition holds.
  setWarp(p, m) {
    const f = Number(m && m.factor);
    if (!WARP.LEVELS.includes(f)) return this.event(p, 'warn', `Time warp levels are ${WARP.LEVELS.map((l) => `${l}×`).join(', ')}.`);
    const was = this.warpOf(p);
    if (f === 1) {
      if (was > 1) { this.endWarp(p, was); this.event(p, 'info', 'Time warp off — back to real time.'); }
      this.sendYou(p);
      return;
    }
    // A route supplied now, or (stepping down) the one the higher level was engaged with.
    const routed = validWarpRoute(m.route) || (f <= was && !!p.warpRouted);
    const why = this.warpBlock(p, f, routed);
    if (why) { this.event(p, 'warn', `Time warp ${f}× refused: ${why}`); this.sendYou(p); return; }
    if (f < was) this.startGrace(p, was);
    p.warp = f; p.warpRouted = routed;
    this.event(p, 'info', `Time warp ${f}×: your ship's clock runs ${f} times faster — fuel, wear, wages and catch too. It drops back to real time near harbours, land, other skippers, storms and the coast guard.`);
    this.sendYou(p);
  }
  // Why the ship cannot (keep) warp(ing) at factor f right now, or null. Order = what the skipper should fix first.
  warpBlock(p, f, routed) {
    const why = this.warpConditions(p);
    if (why) return why;
    if (f > WARP.MAX_NO_ROUTE && !routed) return `above ${WARP.MAX_NO_ROUTE}× the crew needs a route to follow — plot one on the chart and sail it.`;
    if (f > WARP.LAND_CHECK_ABOVE) {
      const sh = this.shallowAhead(p, this.warpLookahead(p, f));
      if (sh) return this.landAheadReason(sh);
    }
    return null;
  }
  // The factor-independent conditions (contract list): ship state, harbours, other players, weather.
  warpConditions(p) {
    if (!p.online) return 'you are offline.';
    if (p.docked) return 'you are in harbour — cast off first.';
    if (p.assist) return 'the tugs have you.';
    if (p.hail) return 'the coast guard is hailing you.';
    if (p.rescue || p.flooding >= 1) return 'you are in the life raft.';
    const s = p.ship, C = SHIP_CLASSES[s.cls] || SHIP_CLASSES.coaster;
    // Out of fuel = no propulsion; a sailing yacht with her sails set is still driven by the wind.
    if (!(p.fuel > 0) && !(C.sail && p.sailsUp !== false)) return 'out of fuel.';
    if (p.flooding > WARP.MAX_FLOODING) return `taking water (${Math.round(p.flooding * 100)} %) — patch the hull or let the pumps catch up first.`;
    const { harbor, units } = this.nearestHarbor(s.lat, s.lon);
    if (harbor && units <= WARP.HARBOR_RADIUS_M) return `${harbor.name} is ${dist1(units)} away — warp needs ${km1(WARP.HARBOR_RADIUS_M)} km clear of any harbour.`;
    const other = this.nearestOtherSkipper(p, WARP.PLAYER_RADIUS_M);
    if (other) return `${other.player.name} is ${dist1(other.distM)} away — warp needs ${km1(WARP.PLAYER_RADIUS_M)} km of sea to yourself.`;
    const wx = this.weatherAt(s.lat, s.lon);
    if (wx.storm > WARP.MAX_STORM) return `heavy weather here (wind ${Math.round(wx.wind.spd)} m/s) — no warp in a storm.`;
    return null;
  }
  // The closest other online player at sea (docked ships and life rafts do not count) within rangeM.
  nearestOtherSkipper(p, rangeM) {
    const s = p.ship, dLat = rangeM / GEO.M_PER_DEG_LAT;
    let best = null, bd = rangeM;
    for (const o of this.byId.values()) {
      if (o === p || !o.online || o.docked || o.rescue || o.flooding >= 1) continue;
      if (Math.abs(o.ship.lat - s.lat) > dLat) continue;
      const d = haversine(s.lat, s.lon, o.ship.lat, o.ship.lon);
      if (d <= bd) { bd = d; best = o; }
    }
    return best ? { player: best, distM: bd } : null;
  }
  // Look-ahead distance for factor f: MIN_LAND_M, longer when LOOKAHEAD_S real seconds of warped travel cover more.
  warpLookahead(p, f) {
    const v = Math.abs(num(p.ship.spd, 0)) * GEO.KN_TO_MS * SIM.MOTION_SCALE * f;
    return clamp(v * WARP.LOOKAHEAD_S, WARP.MIN_LAND_M, Math.max(WARP.MIN_LAND_M, WARP.MAX_LOOKAHEAD_M));
  }
  // First point along the course (heading, reversed when going astern) within rangeM where the water is shallower than
  // draft + KEEL_MARGIN_M; samples every SAMPLE_M up to and including rangeM. Inside a built harbour patch the patch
  // mask decides (its basins are dredged where the coarse raster says land); elsewhere world.depthAt at low water.
  shallowAhead(p, rangeM) {
    const s = p.ship, C = SHIP_CLASSES[s.cls] || SHIP_CLASSES.coaster;
    const need = C.draft + WARP.KEEL_MARGIN_M;
    const course = num(s.spd, 0) < 0 ? normDeg(num(s.hdg, 0) + 180) : normDeg(num(s.hdg, 0));
    let tide = 0;
    try { tide = Math.min(0, num(tideAt(s.lat, s.lon, this.simTime).height, 0)); } catch { tide = 0; }
    const step = Math.max(50, WARP.SAMPLE_M), n = Math.max(1, Math.ceil(rangeM / step));
    for (let k = 1; k <= n; k++) {
      const d = Math.min(rangeM, k * step);
      const pt = destination(s.lat, s.lon, course, d);
      const pen = this.landPenetration(pt.lat, pt.lon);
      const depth = pen != null ? (pen > 0 ? -pen : Infinity) : this.world.depthAt(pt.lat, pt.lon) + tide;
      if (!(depth >= need)) return { distM: d, depth: Number.isFinite(depth) ? depth : -1 };
    }
    return null;
  }
  landAheadReason(sh) {
    return `${sh.depth <= 0 ? 'land' : `shallows (${sh.depth.toFixed(1)} m)`} ${dist1(sh.distM)} ahead — above ${WARP.LAND_CHECK_ABOVE}× you need ${km1(WARP.MIN_LAND_M)} km of deep water ahead.`;
  }
  // Every tick while warped: back to 1× (with the reason) as soon as the level is no longer allowed.
  checkWarp(p) {
    const f = this.warpOf(p);
    if (f <= 1) { p.warp = 1; return; }
    const why = this.warpBlock(p, f, !!p.warpRouted);
    if (why) this.dropWarp(p, capitalise(why));
  }
  // Drop to 1× with a 'warn' event; `send` = false when the caller sends `you` itself. Returns whether it was warped.
  dropWarp(p, reason, send = true) {
    const was = this.warpOf(p);
    if (was <= 1) { p.warp = 1; return false; }
    this.endWarp(p, was);
    this.event(p, 'warn', `Time warp off (${was}× → 1×): ${reason}`);
    if (send) this.sendYou(p);
    return true;
  }
  endWarp(p, was) { p.warp = 1; p.warpRouted = false; this.startGrace(p, was); }
  startGrace(p, was) {
    const now = Date.now();
    const prev = p.warpGraceUntil > now && WARP.LEVELS.includes(p.warpGraceFactor) ? p.warpGraceFactor : 1;
    p.warpGraceFactor = Math.max(prev, was); p.warpGraceUntil = now + WARP.GRACE_MS;
  }
  // Silent reset (connect, disconnect): no event, no grace — the client starts over in real time.
  resetWarp(p) { p.warp = 1; p.warpRouted = false; p.warpGraceUntil = 0; p.warpGraceFactor = 1; }
  // For the HUD (you.warpLimit): the highest level the server would accept right now given a route, and why not higher.
  warpLimit(p) {
    const top = WARP.LEVELS[WARP.LEVELS.length - 1];
    const why = this.warpConditions(p);
    if (why) return { max: 1, reason: capitalise(why), routeAbove: WARP.MAX_NO_ROUTE };
    const sh = this.shallowAhead(p, this.warpLookahead(p, top));
    if (!sh) return { max: top, reason: null, routeAbove: WARP.MAX_NO_ROUTE };
    let max = 1;
    for (let i = WARP.LEVELS.length - 1; i >= 0; i--) {
      const l = WARP.LEVELS[i];
      if (l <= WARP.LAND_CHECK_ABOVE || sh.distM > this.warpLookahead(p, l)) { max = l; break; }
    }
    return { max, reason: max < top ? capitalise(this.landAheadReason(sh)) : null, routeAbove: WARP.MAX_NO_ROUTE };
  }

  // ------------------------------------------------------------------ v0.2: contracts at sea
  towPickup(p, jobId) {
    const j = p.jobs.find((x) => x.id === jobId && x.type === 'tow');
    if (!j) return this.event(p, 'warn', 'No such towing contract.');
    if (p.docked) return;
    if (p.towing) return this.event(p, 'warn', 'You already have a tow.');
    if (unitsBetween(p.ship.lat, p.ship.lon, j.at.lat, j.at.lon) > INTERACT.TOW_RANGE_U) return this.event(p, 'warn', `Get within ${INTERACT.TOW_RANGE_U} m of the casualty.`);
    if (Math.abs(p.ship.spd) > 3) return this.event(p, 'warn', 'Slow below 3 kn to pass the tow line.');
    p.towing = j.id; j.pickedUp = true;
    this.event(p, 'info', `Tow line secured on the ${SHIP_CLASSES[j.victimCls].name.toLowerCase()}. Bring her to ${harborById(j.to).name}${SHIP_CLASSES[p.ship.cls].towPower ? '' : ' — expect a third less speed'}.`);
    this.sendYou(p);
  }
  deliverOffshore(p, jobId) {
    const j = p.jobs.find((x) => x.id === jobId && x.type === 'supply');
    if (!j) return this.event(p, 'warn', 'No such supply contract.');
    if (p.docked) return;
    if (unitsBetween(p.ship.lat, p.ship.lon, j.at.lat, j.at.lon) > INTERACT.PLATFORM_RANGE_U) return this.event(p, 'warn', `Get within ${INTERACT.PLATFORM_RANGE_U} m of ${j.platformName}.`);
    if (Math.abs(p.ship.spd) > 3) return this.event(p, 'warn', 'Hold station under 3 kn for the crane transfer.');
    const stack = p.cargo.find((c) => c.jobId === j.id);
    if (!stack) return this.event(p, 'warn', 'The supplies are no longer aboard.');
    const frac = Math.min(1, stack.qty / j.qty);
    p.cargo = p.cargo.filter((c) => c !== stack);
    let pay = Math.round(j.pay * frac * (this.simTime > j.deadline ? 0.5 : 1));
    p.money += pay; p.stats.delivered++; p.stats.earned += pay;
    p.jobs = p.jobs.filter((x) => x.id !== j.id);
    this.event(p, 'info', `${j.platformName} took the supplies. +${fmt(pay)} cr.`);
    this.sendYou(p);
  }
  expressPassage(p, lat, lon) {
    if (p.docked) return this.event(p, 'warn', 'Cast off first.');
    if (p.hail) return this.event(p, 'law', 'Not with the coast guard on the radio.');
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85) return;
    const distM = haversine(p.ship.lat, p.ship.lon, lat, lon);
    if (distM < 2000) return this.event(p, 'warn', 'Too close to bother.');
    const nm = distM / 1852;
    const cost = Math.round(nm * SIM.EXPRESS_CR_PER_NM);
    if (p.money < cost) return this.event(p, 'warn', `Express passage costs ${fmt(cost)} cr (${Math.round(nm)} nm × ${SIM.EXPRESS_CR_PER_NM}). You have ${fmt(p.money)}.`);
    const C = SHIP_CLASSES[p.ship.cls];
    const hours = distM / (Math.max(6, C.maxKn * 0.8) * GEO.KN_TO_MS) / 3600;
    const fuelNeeded = fuelBurnPerSimHour(p.ship.cls, 0.8, cargoMass(p.cargo) / C.capacity, 0, p.cond) * hours;
    if (p.fuel < fuelNeeded && !C.sail) return this.event(p, 'warn', `Not enough fuel for the passage: needs ${fuelNeeded.toFixed(1)} t, tanks hold ${p.fuel.toFixed(1)} t.`);
    const end = destination(lat, lon, bearing(lat, lon, p.ship.lat, p.ship.lon), 800);
    const spot = this.world.nearestWater(end.lat, end.lon, 30);
    if (!this.world.isWater(spot.lat, spot.lon)) return this.event(p, 'warn', 'That destination is on land.');
    p.money -= cost; p.fuel = Math.max(0, p.fuel - fuelNeeded);
    p.cond = Math.max(0, p.cond - wearPerSimHour(0.8, this.wind.spd, C.wearMul) * hours);
    p.ship.lat = spot.lat; p.ship.lon = spot.lon; p.ship.spd = 0; p.ship.throttle = 0; p.lastValid = { ...spot }; p.moveBudget = 0;
    p.stats.distanceKm += distM / 1000;
    this.event(p, 'info', `Express passage: ${Math.round(nm)} nm in the blink of an eye for ${fmt(cost)} cr (${hours.toFixed(1)} h of fuel and wear charged).`);
    this.sendYou(p, { correction: true });
  }
  setVoyage(p, m) {
    if (m.clear) { p.voyage = null; this.sendYou(p); return; }
    const lat = Number(m.lat), lon = Number(m.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    p.voyage = { lat: clampLat(lat), lon: wrapLon(lon), throttle: clamp(Number(m.throttle) || 0.7, 0.1, 1), setAt: Date.now() };
    this.event(p, 'info', `Course laid in for ${lat.toFixed(2)}°, ${lon.toFixed(2)}°. The crew will keep sailing it while you are away.`);
    this.sendYou(p);
  }
  // Offline players with a voyage set keep moving on the server.
  simulateOffline(p, dt) {
    const v = p.voyage; if (!v || p.docked || p.flooding >= 1 || p.hail) return;
    const s = p.ship;
    const brg = bearing(s.lat, s.lon, v.lat, v.lon);
    const dist = haversine(s.lat, s.lon, v.lat, v.lon);
    if (dist < 400) { p.voyage = null; s.throttle = 0; p.log = (p.log || []).slice(-30).concat([{ kind: 'info', text: 'The crew reached the waypoint and stopped engines.', time: Date.now() }]); return; }
    const w = this.weatherAt(s.lat, s.lon), tide = tideAt(s.lat, s.lon, this.simTime);
    const env = {
      cond: p.cond, flooding: p.flooding, loadFrac: cargoMass(p.cargo) / SHIP_CLASSES[s.cls].capacity, wind: w.wind, current: currentAt(s.lat, s.lon, this.simTime), tideStream: tide.stream,
      fuelEmpty: p.fuel <= 0, sea: w.sea, waveH: w.waves.height, waveDir: w.waves.dir, towing: !!p.towing, sailsUp: p.sailsUp !== false,
    };
    const before = { lat: s.lat, lon: s.lon };
    stepShip(s, { throttleCmd: v.throttle, rudderCmd: clamp(angleDiff(s.hdg, brg) / 25, -1, 1) }, env, dt);
    // Inside a built harbour patch the mask decides; elsewhere the coarse depth plus the tide.
    const pen = this.landPenetration(s.lat, s.lon);
    const depth = pen != null ? (pen > 0 ? -1 : Infinity) : this.world.depthAt(s.lat, s.lon) + tide.height;
    if (depth < SHIP_CLASSES[s.cls].draft) { s.lat = before.lat; s.lon = before.lon; s.spd = 0; p.voyage = null; p.log = (p.log || []).slice(-30).concat([{ kind: 'warn', text: 'The crew stopped: shoal water ahead on the autopilot course.', time: Date.now() }]); }
    else p.lastValid = { lat: s.lat, lon: s.lon };
  }

  // ------------------------------------------------------------------ v0.2: ship market
  buyUsedShip(p, listingId) {
    if (!p.docked) return;
    const st = this.harbors[p.docked];
    const l = (st.used || []).find((x) => x.id === listingId);
    if (!l) return this.event(p, 'warn', 'That hull was sold.');
    const C = SHIP_CLASSES[l.cls];
    const tradeIn = shipValue(p.ship.cls, p.cond);
    const cost = l.price - tradeIn;
    if (p.money < cost) return this.event(p, 'warn', `${C.name} (${l.cond} %) costs ${fmt(cost)} cr after trade-in. You have ${fmt(p.money)}.`);
    if (cargoMass(p.cargo) > C.capacity) return this.event(p, 'warn', 'Your cargo would not fit in that ship.');
    const pax = p.jobs.filter((j) => j.pax).reduce((s, j) => s + j.pax, 0);
    if (pax > C.pax) return this.event(p, 'warn', 'Your passengers would not fit in that ship.');
    p.money -= cost; p.ship.cls = l.cls; p.cond = l.cond; p.flooding = 0; p.fuel = Math.min(p.fuel, C.fuelCap);
    p.serviceDue = this.simTime + SERVICE_INTERVAL_S * (0.2 + 0.6 * (l.cond / 100)); // a used hull is part-way through its interval
    st.used = st.used.filter((x) => x !== l);
    this.event(p, 'info', `Bought a second-hand ${C.name} at ${l.cond} % condition. Trade-in credited ${fmt(tradeIn)} cr.`);
    this.sendYou(p); this.sendHarbor(p);
  }
  // Every harbour's job board for the chart (GET /api/jobs): jobs carry pay/t, destination name and deadline;
  // each entry carries the harbour's position so the chart can draw the board where it belongs.
  publicJobs() {
    const out = [];
    for (const h of HARBORS) {
      const st = this.harbors[h.id]; if (!st) continue;
      const harbor = { id: h.id, name: h.name, lat: h.lat, lon: h.lon, size: h.size, country: h.country };
      out.push({ ...harbor, harbor, jobs: (st.jobs || []).map(publicJob), used: (st.used || []).length, fuel: this.fuelPrice(h), trend: marketTrend(st) });
    }
    return { time: Date.now(), harbors: out };
  }

  // ------------------------------------------------------------------ v0.2: weather & storms
  // Weather at a point. Real Open-Meteo data when the WeatherService has the cell; otherwise the synthetic global
  // wind with storm cells overlaid. Shape (docs/V3-CONTRACTS.md §3): { wind:{u,v,spd,dir,gust}, sea, storm, rain,
  // waves:{height,dir,period}, swell:{height,dir,period}, visibility, pressure, temp, cloud, source }.
  weatherAt(lat, lon) {
    const real = this.sampleWeather(lat, lon);
    if (real) return real;
    let u = this.wind.u, v = this.wind.v, storm = 0, rain = 0;
    for (const st of this.storms) {
      const d = haversine(lat, lon, st.lat, st.lon) / 1000;
      if (d > st.radiusKm * 1.3) continue;
      const f = Math.max(0, 1 - d / (st.radiusKm * 1.3));           // 1 at the eye, 0 at the fringe
      const k = f * st.intensity;
      // cyclonic circulation (anticlockwise in the northern hemisphere) around the centre
      const b = (bearing(st.lat, st.lon, lat, lon) * Math.PI) / 180;
      const dirU = -Math.cos(b) * (lat >= 0 ? 1 : -1), dirV = Math.sin(b) * (lat >= 0 ? 1 : -1);
      u += dirU * 22 * k; v += dirV * 22 * k;
      storm = Math.max(storm, k); rain = Math.max(rain, Math.min(1, k * 1.4));
    }
    const spd = Math.hypot(u, v);
    const dir = normDeg((Math.atan2(-u, -v) * 180) / Math.PI);
    // Synthetic sea: wind sea grows with the square of the wind (fully developed), a longer swell lags it by 20°.
    const waveH = Math.min(14, 0.021 * spd * spd + 0.15), period = clamp(2.5 + 0.32 * spd, 3, 14);
    const sea = Math.min(1, Math.max(waveH / 6, spd / 24));
    const cloud = clamp(0.25 + 0.6 * storm + 0.3 * rain + 0.2 * Math.min(1, spd / 15), 0, 1);
    const visibility = Math.round(clamp(22000 * (1 - 0.85 * rain) * (1 - 0.5 * storm), 800, 22000));
    const month = new Date(this.simTime * 1000).getUTCMonth();
    const temp = Math.round((27 - 0.42 * Math.abs(lat) + (lat >= 0 ? 1 : -1) * 7 * Math.cos(((month - 7) / 12) * Math.PI * 2) - 3 * storm) * 10) / 10;
    return {
      wind: { u, v, spd, dir, gust: spd * (1.25 + 0.35 * storm) }, sea, storm, rain,
      waves: { height: waveH, dir, period }, swell: { height: Math.min(6, waveH * 0.45 + 0.2), dir: normDeg(dir - 20), period: period + 4 },
      visibility, pressure: Math.round((1014 - 38 * storm - 0.25 * spd) * 10) / 10, temp, cloud, source: 'synthetic',
    };
  }
  // Real data from the WeatherService: null when no cached cell covers the point (a fetch is requested lazily).
  sampleWeather(lat, lon) {
    if (!this.weather) return null;
    let s = null;
    try { s = this.weather.sample(lat, lon); } catch (e) { s = null; }
    if (!s) { this.lazyWeatherRequest(lat, lon); return null; }
    const w = s.wind || {};
    const spd = Math.max(0, num(w.spd, 0)), dir = normDeg(num(w.dir, 0));
    const r = ((dir + 180) * Math.PI) / 180; // dir = where the wind comes FROM
    const u = Math.sin(r) * spd, v = Math.cos(r) * spd;
    const waves = s.waves && Number.isFinite(s.waves.height) ? { height: Math.max(0, s.waves.height), dir: normDeg(num(s.waves.dir, dir)), period: Math.max(1, num(s.waves.period, 5)) }
      : { height: Math.min(14, 0.021 * spd * spd + 0.15), dir, period: clamp(2.5 + 0.32 * spd, 3, 14) };
    const swell = s.swell && Number.isFinite(s.swell.height) ? { height: Math.max(0, s.swell.height), dir: normDeg(num(s.swell.dir, waves.dir)), period: Math.max(1, num(s.swell.period, 9)) }
      : { height: Math.min(6, waves.height * 0.45), dir: normDeg(waves.dir - 20), period: waves.period + 4 };
    const storm = clamp((spd - 14) / 12, 0, 1);
    const rain = clamp(num(s.precip, 0) / 4, 0, 1);
    return {
      wind: { u, v, spd, dir, gust: Math.max(spd, num(w.gust, spd)) }, sea: Math.min(1, waves.height / 6), storm, rain, waves, swell,
      visibility: clamp(num(s.visibility, 20000), 50, 100000), pressure: num(s.pressure, 1013), temp: num(s.temp, 12), cloud: clamp(num(s.cloud, 0.5), 0, 1),
      source: s.source || 'open-meteo', fetchedAt: s.fetchedAt,
      windWaves: s.windWaves || null, current: s.current || null, sst: Number.isFinite(s.sst) ? s.sst : null,
    };
  }
  // At most one request per 0.5° cell per 30 s from the hot path (the service dedups too; this keeps the Map small).
  lazyWeatherRequest(lat, lon) {
    const key = `${Math.round(lat * 2)},${Math.round(lon * 2)}`, now = Date.now();
    const last = this.wxAsked.get(key);
    if (last && now - last < 30000) return;
    if (this.wxAsked.size > 2000) this.wxAsked.clear();
    this.wxAsked.set(key, now);
    try { this.weather.request(lat, lon); } catch {}
  }
  updateStorms(dt) {
    const now = this.simTime;
    this.storms = this.storms.filter((s) => now < s.dies);
    for (const s of this.storms) {
      const step = s.driftMs * dt;
      const n = destination(s.lat, s.lon, s.driftDir, step);
      s.lat = clampLat(n.lat); s.lon = n.lon;
      const age = (now - s.born) / (s.dies - s.born);
      s.intensity = s.peak * Math.sin(Math.min(1, Math.max(0, age)) * Math.PI) ** 0.7;
    }
    // Spawn: on average one new North Sea storm every ~5 hours, a few more worldwide.
    if (this.rnd() < dt / 18000 && this.storms.filter((s) => s.region).length < 3) {
      const lat = 50 + this.rnd() * 11, lon = -6 + this.rnd() * 16;
      this.storms.push({ id: 's' + shortId(), lat, lon, radiusKm: 60 + this.rnd() * 160, peak: 0.55 + this.rnd() * 0.45, intensity: 0.1, driftDir: 30 + this.rnd() * 90, driftMs: 4 + this.rnd() * 8, born: now, dies: now + 3600 * (3 + this.rnd() * 9), region: true, name: stormName(this.rnd) });
      this.broadcast({ t: 'chat', from: 'Met Office', id: 'sys', text: `Gale warning: storm ${this.storms[this.storms.length - 1].name} forming over the North Sea.`, time: Date.now() });
    }
    if (this.rnd() < dt / 9000 && this.storms.filter((s) => !s.region).length < 6) {
      const lat = -50 + this.rnd() * 100, lon = -180 + this.rnd() * 360;
      if (this.world.isWater(lat, lon)) this.storms.push({ id: 's' + shortId(), lat, lon, radiusKm: 150 + this.rnd() * 300, peak: 0.5 + this.rnd() * 0.5, intensity: 0.1, driftDir: this.rnd() * 360, driftMs: 3 + this.rnd() * 7, born: now, dies: now + 3600 * (6 + this.rnd() * 30), region: false, name: stormName(this.rnd) });
    }
  }
  stormsPublic() { return this.storms.map((s) => ({ id: s.id, name: s.name, lat: round6(s.lat), lon: round6(s.lon), radiusKm: Math.round(s.radiusKm), intensity: Math.round(s.intensity * 100) / 100 })); }

  // ------------------------------------------------------------------ v0.2: search and rescue
  startRescue(p) {
    const s = p.ship;
    const { harbor, units: distM } = this.nearestHarbor(s.lat, s.lon);
    const a = this.harborAnchor(harbor);
    const byBoat = distM < 40000;
    const kn = byBoat ? 25 : 150;
    const travel = distM / (kn * GEO.KN_TO_MS);
    const r = { id: 'r' + shortId(), playerId: p.id, playerName: p.name, kind: byBoat ? 'lifeboat' : 'helicopter', from: harbor.id, fromLat: a.lat, fromLon: a.lon, lat: a.lat, lon: a.lon, toLat: s.lat, toLon: s.lon, hdg: bearing(a.lat, a.lon, s.lat, s.lon), kn, state: 'outbound', eta: Date.now() + Math.min(travel, 1500) * 1000, started: Date.now() };
    this.rescues.push(r);
    p.rescue = { id: r.id, kind: r.kind, eta: r.eta, harbor: harbor.id, lat: s.lat, lon: s.lon };
    this.event(p, 'warn', `${harbor.name} ${byBoat ? 'lifeboat' : 'SAR helicopter'} launched. ETA ${Math.ceil((r.eta - Date.now()) / 60000)} min. Stay with the raft.`);
    this.broadcast({ t: 'chat', from: 'Coastguard', id: 'sys', text: `Mayday relay: ${p.name} in the water at ${s.lat.toFixed(2)}, ${s.lon.toFixed(2)}. ${byBoat ? 'Lifeboat' : 'Helicopter'} launched from ${harbor.name}.`, time: Date.now() });
  }
  updateRescues(dt) {
    for (const r of [...this.rescues]) {
      const p = this.byId.get(r.playerId);
      const now = Date.now();
      const h = r.fromLat != null ? { lat: r.fromLat, lon: r.fromLon } : this.harborAnchor(harborById(r.from));
      if (r.state === 'outbound') {
        const total = Math.max(1, r.eta - r.started), f = now >= r.eta ? 1 : Math.min(1, (now - r.started) / total);
        r.lat = h.lat + (r.toLat - h.lat) * f; r.lon = h.lon + wrapLon(r.toLon - h.lon) * f;
        if (f >= 1) { r.state = 'return'; r.started = now; r.eta = now + 60000; r.hdg = normDeg(r.hdg + 180); if (p) this.finishRescue(p, r); }
      } else if (now >= r.eta) {
        this.rescues = this.rescues.filter((x) => x !== r);
      } else {
        const f = Math.min(1, (now - r.started) / 60000);
        r.lat = r.toLat + (h.lat - r.toLat) * f; r.lon = r.toLon + wrapLon(h.lon - r.toLon) * f;
      }
    }
  }
  finishRescue(p, r) {
    const harbor = harborById(r.from), a = this.harborAnchor(harbor);
    p.rescue = null; this.setDocked(p, harbor.id, null);
    p.ship.lat = a.lat; p.ship.lon = a.lon; p.lastValid = { lat: a.lat, lon: a.lon }; p.voyage = null;
    if (p.money >= 2000) {
      p.money -= 2000; p.ship.cls = 'coaster'; p.cond = 70; p.flooding = 0; p.fuel = 30; p.serviceDue = this.simTime + SERVICE_INTERVAL_S / 2;
      this.event(p, 'warn', `Landed at ${harbor.name}. Insurance (2,000 cr) put you in a second-hand coaster.`);
    } else { this.forcedReset(p, 'Landed safe, but you cannot pay the insurance excess.'); return; }
    this.sendYou(p, { correction: true }); this.sendHarbor(p);
  }
  rescuesPublic() { return this.rescues.map((r) => ({ id: r.id, kind: r.kind, lat: round6(r.lat), lon: round6(r.lon), hdg: Math.round(r.hdg), state: r.state, playerName: r.playerName })); }

  // ------------------------------------------------------------------ snapshots
  snapshot() {
    const players = [];
    for (const p of this.byId.values()) if (p.online || (p.voyage && !p.docked)) players.push(this.publicState(p));
    return { t: 'snap', time: Date.now(), simTime: Math.round(this.simTime), wind: { dir: Math.round(this.wind.dir), spd: Math.round(this.wind.spd * 10) / 10, u: round3(this.wind.u), v: round3(this.wind.v) }, players, cutters: this.cutters.map(cutterPublic), storms: this.stormsPublic(), rescues: this.rescuesPublic() };
  }
  // The common part is serialised once; each socket gets it plus the AI ships within SIM.AI_RANGE_U of that player.
  broadcastSnapshot() {
    const common = JSON.stringify(this.snapshot());
    const prefix = common.slice(0, -1); // drop the closing brace, append the per-player "ai" field
    for (const [id, ws] of this.sockets) {
      if (ws.readyState !== 1) continue;
      const p = this.byId.get(id);
      const ai = p ? this.aiNear(p.ship.lat, p.ship.lon) : [];
      ws.send(ai.length ? `${prefix},"ai":${JSON.stringify(ai)}}` : `${prefix},"ai":[]}`);
    }
    const now = Date.now();
    if (now - this.lastYou > 1000) { this.lastYou = now; for (const p of this.byId.values()) if (p.online) this.sendYou(p); }
  }
  // Surface current + tidal stream (m/s east/north): what offline voyages, cutters and the client's physics feel.
  currentAtPos(lat, lon) {
    const c = currentAt(lat, lon, this.simTime), t = tideAt(lat, lon, this.simTime).stream;
    return { u: c.u + num(t && t.u, 0), v: c.v + num(t && t.v, 0) };
  }
  currentFor(p) { return this.currentAtPos(p.ship.lat, p.ship.lon); }
}

const STORM_NAMES = ['Agnes', 'Babet', 'Ciarán', 'Debi', 'Elin', 'Fergus', 'Gerrit', 'Henk', 'Isha', 'Jocelyn', 'Kathleen', 'Lilian', 'Minnie', 'Nelly', 'Olga', 'Piet', 'Regina', 'Stuart', 'Tamara', 'Vincent'];
function stormName(rnd) { return STORM_NAMES[Math.floor(rnd() * STORM_NAMES.length)]; }
function isGood(g) { return typeof g === 'string' && Object.prototype.hasOwnProperty.call(GOODS, g); }
function cutterPublic(c) { return { id: c.id, name: c.name, lat: round6(c.lat), lon: round6(c.lon), hdg: Math.round(c.hdg), spd: Math.round(c.spd * 10) / 10, state: c.state, targetId: c.targetId }; }
function cleanName(n) { return String(n || '').replace(/[^\w \-'.]/g, '').trim().slice(0, 20); }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function round6(v) { return Math.round(v * 1e6) / 1e6; }
function round3(v) { return Math.round(v * 1e3) / 1e3; }
function round2(v) { return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0; }
function round1(v) { return Number.isFinite(v) ? Math.round(v * 10) / 10 : 0; }
function num(v, d) { return Number.isFinite(v) ? v : d; }
function fmt(n) { return Math.round(n).toLocaleString('en-US'); }
function km1(m) { return (Math.round(m / 100) / 10).toFixed(1); }
function dist1(m) { return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${km1(m)} km`; }
function capitalise(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
// The route a client sails under warp > MAX_NO_ROUTE: a non-empty array of finite {lat, lon} (or [lat, lon]) points.
// The server only checks it is there and sane; the client's autopilot follows it.
function validWarpRoute(route) {
  if (!Array.isArray(route) || route.length < 1 || route.length > 1000) return false;
  for (const pt of route) {
    const lat = Array.isArray(pt) ? pt[0] : pt && typeof pt === 'object' ? pt.lat : NaN;
    const lon = Array.isArray(pt) ? pt[1] : pt && typeof pt === 'object' ? pt.lon : NaN;
    if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 540) return false;
  }
  return true;
}
const CONTACT_NAMES = ['a man in an oilskin', 'Big Tomas', 'the woman with the dog', 'a kid on a scooter', 'Old Henk', 'the crane operator', 'Mister Lindqvist', 'the harbour master\'s cousin'];
function contactName(rnd) { return CONTACT_NAMES[Math.floor(rnd() * CONTACT_NAMES.length)]; }
