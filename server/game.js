// Authoritative game state: players, survival (fuel/wear/flooding/sinking), economy, law, multiplayer
// interactions, AI coast guard, wrecks and persistence. Movement is client-simulated with plausibility checks.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { GEO, SIM, SHIP_CLASSES, GOODS, INTERACT, LAW, LAYERS } from '../shared/constants.js';
import { haversine, bearing, destination, unitsBetween, normDeg, angleDiff } from '../shared/geo.js';
import { fuelBurnPerSimHour, wearPerSimHour, currentAt, headwindFactor } from '../shared/physics.js';
import { HARBORS, FISHING_GROUNDS, PATROLS, harborById } from './harbors.js';
import {
  generateJob, generateSmugglingJob, jobCountFor, initMarket, driftMarket, cargoMass, cargoValue,
  shipCapacity, setJobSeq, nextJobId,
} from './economy.js';
import { DATA_DIR } from './world.js';

const DEFAULT_STATE_FILE = path.join(DATA_DIR, 'state.json');
const START_HARBOR = 'rotterdam';
const START_MONEY = 25000;

function rndFn() { return Math.random(); }
function shortId() { return crypto.randomBytes(4).toString('hex'); }
function token() { return crypto.randomBytes(24).toString('base64url'); }

export class Game {
  constructor(world, log = console.log, opts = {}) {
    this.world = world;
    this.log = log;
    this.stateFile = opts.stateFile || DEFAULT_STATE_FILE;
    this.players = new Map();   // token -> player
    this.byId = new Map();      // id -> player
    this.sockets = new Map();   // id -> ws
    this.wrecks = [];
    this.harbors = {};          // id -> { jobs, market, contact, lastRegen }
    this.cutters = [];
    this.convoys = new Map();   // convoyId -> { id, members: [ids], leader }
    this.offers = new Map();    // offerId -> trade offer
    this.simTime = 0;           // sim seconds since epoch of this shard
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
      this.simTime = s.simTime || 0;
      this.wrecks = s.wrecks || [];
      this.harbors = s.harbors || {};
      if (s.wind) this.wind = s.wind;
      let maxJob = 1;
      for (const p of s.players || []) {
        p.online = false; p.hail = null; p.fishing = false;
        this.players.set(p.token, p); this.byId.set(p.id, p);
      }
      for (const h of Object.values(this.harbors)) for (const j of [...(h.jobs || []), ...((h.contact && h.contact.jobs) || [])]) maxJob = Math.max(maxJob, parseInt(j.id.slice(1), 36) + 1);
      for (const p of this.players.values()) for (const j of p.jobs || []) maxJob = Math.max(maxJob, parseInt(j.id.slice(1), 36) + 1);
      setJobSeq(maxJob);
      this.log(`[game] loaded ${this.players.size} players, ${this.wrecks.length} wrecks`);
    } catch (e) { this.log(`[game] state load failed: ${e.message}`); }
  }
  saveState() {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const s = {
        savedAt: new Date().toISOString(), simTime: this.simTime, wind: this.wind, wrecks: this.wrecks, harbors: this.harbors,
        players: [...this.players.values()].map((p) => ({ ...p, hail: null, fishing: false, online: false })),
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
      if (!st) st = this.harbors[h.id] = { jobs: [], market: initMarket(h, this.rnd), contact: null, lastRegen: -1e9 };
      if (!st.market) st.market = initMarket(h, this.rnd);
      this.regenHarbor(h, st, true);
    }
  }
  regenHarbor(h, st, force) {
    st.jobs = (st.jobs || []).filter((j) => j.deadline > this.simTime);
    const n = jobCountFor(h);
    if (force || this.simTime - st.lastRegen > 3600 * 2) {
      while (st.jobs.length < n) st.jobs.push(generateJob(h, this.simTime, this.rnd));
      // Black-market contact: 70% present per regen, 1-3 runs.
      if (this.rnd() < 0.7) {
        const k = 1 + Math.floor(this.rnd() * 3);
        st.contact = { name: contactName(this.rnd), jobs: Array.from({ length: k }, () => generateSmugglingJob(h, this.simTime, this.rnd)) };
      } else st.contact = null;
      driftMarket(st.market, this.rnd);
      st.lastRegen = this.simTime;
    }
  }
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
      const spawn = this.spawnPointNear(h);
      p = {
        id: shortId(), token: token(), name: cleanName(name) || `Skipper-${Math.floor(Math.random() * 900 + 100)}`,
        createdAt: Date.now(), ship: { cls: 'coaster', lat: spawn.lat, lon: spawn.lon, hdg: 0, spd: 0, throttle: 0, rudder: 0 },
        cond: 100, flooding: 0, fuel: SHIP_CLASSES.coaster.fuelCap, cargo: [], money: START_MONEY, wanted: 0, wantedAt: 0,
        kits: 1, jobs: [], convoyId: null, docked: START_HARBOR, lastInspected: -1e9, lastSeen: Date.now(),
        stats: { delivered: 0, earned: 0, sunk: 0, inspected: 0, fined: 0, caught: 0, boarded: 0, pirated: 0, distanceKm: 0 },
        lastValid: { lat: spawn.lat, lon: spawn.lon }, shallowSince: 0, log: [],
      };
      this.players.set(p.token, p); this.byId.set(p.id, p);
      this.log(`[game] new player ${p.name} (${p.id})`);
    } else if (name && cleanName(name) && cleanName(name) !== p.name) {
      p.name = cleanName(name);
    }
    return p;
  }
  spawnPointNear(h) {
    const w = this.world.nearestWater(h.lat, h.lon, 10);
    return { lat: w.lat, lon: w.lon };
  }

  publicState(p) {
    const s = p.ship;
    return {
      id: p.id, name: p.name, cls: s.cls, lat: round6(s.lat), lon: round6(s.lon), hdg: Math.round(s.hdg * 10) / 10,
      spd: Math.round(s.spd * 10) / 10, cond: Math.round(p.cond), flooding: Math.round(p.flooding * 100) / 100,
      convoyId: p.convoyId, wanted: p.wanted, docked: p.docked, sinking: p.flooding >= 1,
    };
  }
  privateState(p) {
    return {
      id: p.id, name: p.name, ship: { ...p.ship }, cond: p.cond, flooding: p.flooding, fuel: p.fuel, cargo: p.cargo,
      money: p.money, wanted: p.wanted, kits: p.kits, jobs: p.jobs, convoyId: p.convoyId, docked: p.docked,
      fuelEmpty: p.fuel <= 0, hail: p.hail ? { cutter: p.hail.cutter, until: p.hail.until, state: p.hail.state } : null,
      fishing: !!p.fishing, stats: p.stats, capacity: shipCapacity(p.ship.cls), pax: SHIP_CLASSES[p.ship.cls].pax,
      convoy: p.convoyId && this.convoys.get(p.convoyId) ? { id: p.convoyId, members: this.convoys.get(p.convoyId).members.map((id) => ({ id, name: this.byId.get(id)?.name })) } : null,
    };
  }
  worldInfo() {
    return {
      harbors: HARBORS.map((h) => ({ id: h.id, name: h.name, country: h.country, lat: h.lat, lon: h.lon, size: h.size })),
      fishing: FISHING_GROUNDS, classes: SHIP_CLASSES, goods: GOODS, layers: LAYERS, interact: INTERACT, law: LAW,
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
  sendYou(p) { this.send(p, { t: 'you', you: this.privateState(p) }); }
  sendHarbor(p) {
    const h = harborById(p.docked); if (!h) return;
    const st = this.harbors[h.id];
    this.regenHarbor(h, st, false);
    this.send(p, {
      t: 'harbor', harbor: { id: h.id, name: h.name, country: h.country, size: h.size, fuelPrice: this.fuelPrice(h), repairCost: this.repairCost(p),
        jobs: st.jobs, market: st.market, contact: p.contactSeen === h.id && st.contact ? st.contact : null, contactLooked: p.contactSeen === h.id,
        shipyard: Object.values(SHIP_CLASSES).filter((c) => c.price > 0).map((c) => ({ id: c.id, name: c.name, price: c.price, desc: c.desc })),
        dockedPlayers: [...this.byId.values()].filter((o) => o.online && o.docked === h.id && o.id !== p.id).map((o) => ({ id: o.id, name: o.name })) },
    });
  }
  fuelPrice(h) { return Math.round(this.harbors[h.id].market.fuel * (h.fuelMul || 1)); }
  repairCost(p) { return Math.round((100 - p.cond) * 120 * (SHIP_CLASSES[p.ship.cls].displacement / 3200) ** 0.5); }

  connect(ws, tok, name) {
    const p = this.findOrCreatePlayer(tok, name);
    const old = this.sockets.get(p.id);
    if (old && old !== ws) { try { old.close(4001, 'replaced'); } catch {} }
    this.sockets.set(p.id, ws);
    p.online = true; p.lastSeen = Date.now(); p.lastTick = Date.now();
    ws.send(JSON.stringify({
      t: 'welcome', token: p.token, you: this.privateState(p), world: this.worldInfo(),
      players: [...this.byId.values()].filter((o) => o.online && o.id !== p.id).map((o) => this.publicState(o)),
      cutters: this.cutters.map(cutterPublic), wrecks: this.wrecks, wind: this.wind, simTime: this.simTime, log: p.log || [],
    }));
    this.broadcast({ t: 'join', player: this.publicState(p) }, p.id);
    if (p.docked) this.sendHarbor(p);
    this.event(p, 'info', `Welcome aboard, ${p.name}. ${p.docked ? 'You are docked at ' + harborById(p.docked).name + '.' : ''}`);
    return p;
  }
  disconnect(p) {
    if (this.sockets.get(p.id)) this.sockets.delete(p.id);
    p.online = false; p.lastSeen = Date.now();
    this.broadcast({ t: 'leave', id: p.id });
    this.cancelOffersOf(p);
  }

  // ------------------------------------------------------------------ inbound messages
  onState(p, m) {
    if (p.docked || p.flooding >= 1) return;
    const s = p.ship;
    const lat = +m.lat, lon = +m.lon;
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 85) return;
    const now = Date.now();
    const dt = Math.min(5, (now - (p.lastState || now)) / 1000) || 0.1;
    p.lastState = now;
    const C = SHIP_CLASSES[s.cls];
    const maxMove = (C.maxKn * 1.6 * GEO.KN_TO_MS) * dt * SIM.MOTION_SCALE + 60;
    const moved = haversine(s.lat, s.lon, lat, lon);
    if (moved > maxMove) {
      this.event(p, 'warn', 'Position rejected by the server (implausible move).');
      this.sendYou(p);
      return;
    }
    s.lat = lat; s.lon = lon; s.hdg = normDeg(+m.hdg || 0); s.spd = clamp(+m.spd || 0, -C.maxKn * 0.4, C.maxKn * 1.1);
    s.throttle = clamp(+m.throttle || 0, -0.3, 1); s.rudder = clamp(+m.rudder || 0, -1, 1);
    p.stats.distanceKm += moved / 1000;
    // Land/shallow plausibility: tolerate brief shallows (client stops itself), teleport back if it persists.
    const depth = this.world.depthAt(lat, lon);
    if (depth < C.draft * 0.5) {
      if (!p.shallowSince) p.shallowSince = now;
      else if (now - p.shallowSince > 4000) {
        s.lat = p.lastValid.lat; s.lon = p.lastValid.lon; s.spd = 0; p.shallowSince = 0;
        this.event(p, 'warn', 'Aground — the server moved you back to deeper water.');
        this.sendYou(p);
      }
    } else { p.shallowSince = 0; p.lastValid = { lat, lon }; }
  }

  onAction(p, m) {
    const a = m.action;
    try {
      switch (a) {
        case 'dock': return this.dock(p);
        case 'undock': return this.undock(p);
        case 'lookaround': return this.lookAround(p);
        case 'buy_fuel': return this.buyFuel(p, +m.t);
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
  nearestHarbor(lat, lon) {
    let best = null, bd = Infinity;
    for (const h of HARBORS) { const d = unitsBetween(lat, lon, h.lat, h.lon); if (d < bd) { bd = d; best = h; } }
    return { harbor: best, units: bd };
  }
  dock(p) {
    if (p.docked) return this.sendHarbor(p);
    const { harbor, units } = this.nearestHarbor(p.ship.lat, p.ship.lon);
    if (!harbor || units > INTERACT.DOCK_RADIUS_U) return this.event(p, 'warn', 'No harbour within docking range.');
    if (Math.abs(p.ship.spd) > 3) return this.event(p, 'warn', 'Too fast to dock — slow below 3 kn.');
    p.docked = harbor.id; p.ship.spd = 0; p.ship.throttle = 0; p.ship.rudder = 0; p.fishing = false;
    if (p.hail) { p.hail = null; }
    if (p.cond > 0) p.flooding = 0;
    this.event(p, 'info', `Docked at ${harbor.name}.`);
    this.deliverJobs(p, harbor);
    // Port authority inspection.
    const chance = p.wanted > 0 ? LAW.PORT_INSPECT_CHANCE_WANTED : LAW.PORT_INSPECT_CHANCE;
    if (this.rnd() < chance) this.inspect(p, `${harbor.name} port authority`);
    this.sendYou(p); this.sendHarbor(p);
  }
  undock(p) {
    if (!p.docked) return;
    const h = harborById(p.docked);
    p.docked = null; p.contactSeen = null;
    const spawn = this.spawnPointNear(h);
    p.ship.lat = spawn.lat; p.ship.lon = spawn.lon; p.lastValid = { ...spawn }; p.lastState = Date.now();
    this.event(p, 'info', `Cast off from ${h.name}. Fuel ${p.fuel.toFixed(1)} t, condition ${Math.round(p.cond)} %.`);
    this.sendYou(p);
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
    if (job.type === 'passengers') {
      const used = p.jobs.filter((j) => j.type === 'passengers').reduce((s, j) => s + j.pax, 0);
      if (used + job.pax > C.pax) return this.event(p, 'warn', `Not enough berths (${C.pax - used} free).`);
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
    if (j.type !== 'passengers' && j.type !== 'fishing') { /* cargo stays aboard; player may sell or dump it */ for (const c of p.cargo) if (c.jobId === j.id) c.jobId = null; }
    this.event(p, 'warn', `Abandoned: ${j.title}.`);
    this.sendYou(p);
  }
  deliverJobs(p, harbor) {
    for (const j of [...p.jobs]) {
      if (j.to !== harbor.id) continue;
      let ok = false;
      if (j.type === 'passengers') ok = true;
      else {
        const stack = p.cargo.find((c) => c.jobId === j.id) || p.cargo.find((c) => c.good === j.good && c.qty >= j.qty && !c.jobId);
        if (stack) { ok = true; stack.qty -= j.qty; if (stack.qty <= 0) p.cargo = p.cargo.filter((c) => c !== stack); else stack.jobId = null; }
      }
      if (!ok) continue;
      let pay = j.pay;
      const late = this.simTime > j.deadline;
      if (late) pay = Math.round(pay * 0.5);
      p.money += pay; p.stats.delivered++; p.stats.earned += pay;
      p.jobs = p.jobs.filter((x) => x.id !== j.id);
      this.event(p, j.contraband ? 'shady' : 'info', `${late ? 'Late delivery (half pay)' : 'Delivered'}: ${j.title} — +${fmt(pay)} cr.`);
    }
  }
  tradeGoods(p, good, qty, buying) {
    if (!p.docked) return;
    const st = this.harbors[p.docked];
    if (!GOODS[good] || GOODS[good].contraband || !(qty > 0)) return;
    qty = Math.min(5000, Math.round(qty));
    const price = st.market[good];
    if (buying) {
      const C = SHIP_CLASSES[p.ship.cls];
      const free = C.capacity - cargoMass(p.cargo);
      qty = Math.min(qty, free, Math.floor(p.money / price));
      if (qty <= 0) return this.event(p, 'warn', 'No space or no money.');
      p.money -= qty * price;
      const stack = p.cargo.find((c) => c.good === good && !c.jobId);
      if (stack) stack.qty += qty; else p.cargo.push({ good, qty, contraband: false, jobId: null });
      st.market[good] = Math.round(price * (1 + 0.0004 * qty));
      this.event(p, 'info', `Bought ${qty} t of ${GOODS[good].name} at ${fmt(price)} cr/t.`);
    } else {
      const stacks = p.cargo.filter((c) => c.good === good && !c.jobId);
      const have = stacks.reduce((s, c) => s + c.qty, 0);
      qty = Math.min(qty, have);
      if (qty <= 0) return this.event(p, 'warn', 'Nothing to sell (contract cargo cannot be sold).');
      let left = qty;
      for (const c of stacks) { const k = Math.min(c.qty, left); c.qty -= k; left -= k; }
      p.cargo = p.cargo.filter((c) => c.qty > 0);
      p.money += qty * price; p.stats.earned += qty * price;
      st.market[good] = Math.max(Math.round(GOODS[good].base * 0.4), Math.round(price * (1 - 0.0004 * qty)));
      this.event(p, 'info', `Sold ${qty} t of ${GOODS[good].name} at ${fmt(price)} cr/t.`);
    }
    this.sendYou(p); this.sendHarbor(p);
  }
  dumpCargo(p, good) {
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
    if (on && !this.groundAt(p.ship.lat, p.ship.lon)) return this.event(p, 'warn', 'No fishing ground here. Check the chart for fishing banks.');
    p.fishing = on; this.event(p, 'info', on ? 'Nets out. Keep her under 3 knots.' : 'Nets hauled in.'); this.sendYou(p);
  }
  groundAt(lat, lon) {
    for (const g of FISHING_GROUNDS) if (haversine(lat, lon, g.lat, g.lon) / 1000 <= g.radiusKm) return g;
    return null;
  }
  tow(p) {
    if (p.docked) return;
    const { harbor } = this.nearestHarbor(p.ship.lat, p.ship.lon);
    const cost = Math.min(p.money, 3000 + Math.round(unitsBetween(p.ship.lat, p.ship.lon, harbor.lat, harbor.lon) * 2));
    p.money -= cost; p.docked = harbor.id; p.ship.spd = 0; p.ship.throttle = 0; p.fishing = false; p.hail = null;
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
    p.docked = harbor.id; p.ship.spd = 0; p.ship.throttle = 0; p.hail = null; p.fishing = false;
    this.convoyLeave(p, true);
    this.event(p, 'law', `${by}: you cannot pay the ${fmt(fine)} cr fine. Ship impounded and towed to ${harbor.name}; all credits seized. Wanted level ${p.wanted}. One more and the ship is forfeit.`);
    this.sendYou(p); this.sendHarbor(p);
  }
  forcedReset(p, why) {
    const { harbor } = this.nearestHarbor(p.ship.lat, p.ship.lon);
    p.ship.cls = 'coaster'; p.cond = 40; p.flooding = 0; p.fuel = 20; p.cargo = []; p.jobs = []; p.money = 500; p.wanted = 0; p.kits = 0;
    p.docked = harbor.id; p.ship.spd = 0; p.ship.throttle = 0; p.hail = null; p.fishing = false;
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
      }
    }
  }
  hail(c, p) {
    p.lastHailAt = Date.now();
    p.hail = { cutter: c.name, cutterId: c.id, until: Date.now() + LAW.HAIL_SECONDS * 1000, state: 'hailed' };
    c.state = 'hail'; c.targetId = p.id; c.timer = LAW.HAIL_SECONDS;
    this.event(p, 'law', `${c.name} on channel 16: "Vessel ${p.name}, this is the coast guard. Heave to for inspection. You have ${LAW.HAIL_SECONDS} seconds."`);
    this.sendYou(p);
  }
  clearHail(c, p) {
    c.state = 'patrol'; c.targetId = null; c.timer = 0;
    if (p && p.hail && p.hail.cutterId === c.id) { p.hail = null; this.sendYou(p); }
  }

  // ------------------------------------------------------------------ survival tick
  tick(dt) {
    this.simTime += dt * SIM.CLOCK_SCALE;
    const simHours = (dt * SIM.CLOCK_SCALE) / 3600;
    this.updateWind(dt);
    for (const p of this.byId.values()) {
      if (!p.online) continue;
      if (p.docked) continue;
      if (p.flooding >= 1) { this.sink(p); continue; }
      const s = p.ship, C = SHIP_CLASSES[s.cls];
      const load = cargoMass(p.cargo) / C.capacity;
      const underway = Math.abs(s.throttle) > 0.03 || Math.abs(s.spd) > 0.5;
      if (p.fuel > 0 && Math.abs(s.throttle) > 0.01) {
        const burn = fuelBurnPerSimHour(s.cls, s.throttle, load, headwindFactor(s.hdg, this.wind), p.cond) * simHours;
        p.fuel = Math.max(0, p.fuel - burn);
        if (p.fuel === 0) this.event(p, 'warn', 'Fuel exhausted. Engine stopped. You are drifting — call a tow or wait for a kind soul.');
        else if (p.fuel < C.fuelCap * 0.1 && !p.lowFuelWarned) { p.lowFuelWarned = true; this.event(p, 'warn', 'Low fuel: under 10 % remaining.'); }
        if (p.fuel > C.fuelCap * 0.2) p.lowFuelWarned = false;
      }
      if (underway && p.cond > 0) {
        p.cond = Math.max(0, p.cond - wearPerSimHour(s.throttle, this.wind.spd) * simHours);
        if (p.cond < 30 && !p.condWarned) { p.condWarned = true; this.event(p, 'warn', 'Hull condition under 30 %: steering is getting sluggish, leaks likely. Find a yard.'); }
        if (p.cond > 50) p.condWarned = false;
      }
      if (p.cond <= 0) {
        p.flooding = Math.min(1, p.flooding + 1.2 * simHours);
        if (!p.floodWarned) { p.floodWarned = true; this.event(p, 'warn', 'Hull failed: taking on water! Use a damage-control kit (K) or make for the nearest harbour.'); }
      } else if (p.flooding > 0 && p.cond > 30) {
        p.flooding = Math.max(0, p.flooding - 0.3 * simHours); // pumps keep up on a sound hull
      }
      if (p.flooding < 0.2) p.floodWarned = false;
      if (p.fishing) {
        const g = this.groundAt(s.lat, s.lon);
        if (!g) { p.fishing = false; this.event(p, 'info', 'Left the fishing ground; nets hauled in.'); this.sendYou(p); }
        else if (Math.abs(s.spd) < 3) {
          const free = C.capacity - cargoMass(p.cargo);
          const add = Math.min(free, C.fishRate * g.richness * simHours * 5);
          if (add > 0) {
            const stack = p.cargo.find((c) => c.good === 'fish' && !c.jobId);
            if (stack) stack.qty = Math.round((stack.qty + add) * 10) / 10; else p.cargo.push({ good: 'fish', qty: Math.round(add * 10) / 10, contraband: false, jobId: null });
          } else if (free <= 0 && !p.fullWarned) { p.fullWarned = true; this.event(p, 'info', 'Hold is full of fish.'); }
        }
      }
      if (p.wanted > 0 && this.simTime - p.wantedAt > LAW.WANTED_DECAY_SIM_HOURS * 3600) { p.wanted--; p.wantedAt = this.simTime; this.event(p, 'law', `Wanted level dropped to ${p.wanted}.`); }
      for (const j of p.jobs) if (!j.expiredWarned && this.simTime > j.deadline) { j.expiredWarned = true; this.event(p, 'warn', `Deadline passed: ${j.title} (half pay on delivery).`); }
    }
    this.updateCutters(dt);
    // Markets & job boards regen lazily on dock; wrecks expire.
    const before = this.wrecks.length;
    this.wrecks = this.wrecks.filter((w) => this.simTime - w.simTime < 48 * 3600 && w.cargo.length);
    if (this.wrecks.length !== before) this.broadcast({ t: 'wrecks', wrecks: this.wrecks });
    for (const [id, o] of this.offers) if (Date.now() > o.expires) { this.offers.delete(id); const a = this.byId.get(o.from); if (a) this.event(a, 'info', 'Your trade offer expired.'); }
    if (Date.now() - this.lastSave > 30000) this.saveState();
  }
  updateWind(dt) {
    // Slow random walk in direction and speed.
    this.wind.dir = normDeg((this.wind.dir || 240) + (this.rnd() - 0.5) * 2 * dt);
    this.wind.spd = clamp((this.wind.spd || 7) + (this.rnd() - 0.5) * 0.3 * dt, 1, 24);
    const r = (this.wind.dir + 180) * Math.PI / 180; // dir = where the wind comes FROM
    this.wind.u = Math.sin(r) * this.wind.spd; this.wind.v = Math.cos(r) * this.wind.spd;
  }
  sink(p) {
    const s = p.ship;
    p.stats.sunk++;
    if (p.cargo.length) {
      this.wrecks.push({ id: 'w' + shortId(), lat: s.lat, lon: s.lon, cargo: p.cargo, owner: p.name, cls: s.cls, simTime: this.simTime, time: Date.now() });
      this.broadcast({ t: 'wrecks', wrecks: this.wrecks });
    }
    this.broadcast({ t: 'chat', from: 'Shipping news', id: 'sys', text: `${p.name}'s ${SHIP_CLASSES[s.cls].name} went down at ${s.lat.toFixed(2)}, ${s.lon.toFixed(2)}.`, time: Date.now() });
    const { harbor } = this.nearestHarbor(s.lat, s.lon);
    const lostJobs = p.jobs.length;
    p.cargo = []; p.jobs = []; p.fishing = false; p.hail = null; this.convoyLeave(p, true);
    p.docked = harbor.id; s.spd = 0; s.throttle = 0; s.rudder = 0;
    if (p.money >= 2000) {
      p.money -= 2000; p.ship.cls = 'coaster'; p.cond = 70; p.flooding = 0; p.fuel = 30;
      this.event(p, 'warn', `Your ship sank${lostJobs ? ` with ${lostJobs} contract(s)` : ''}. Insurance (2,000 cr) put you in a second-hand coaster at ${harbor.name}.`);
    } else {
      this.forcedReset(p, `Your ship sank and you cannot pay the insurance excess.`);
      return;
    }
    this.sendYou(p); this.sendHarbor(p);
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
    if (!GOODS[good] || !(qty > 0) || !(price >= 0)) return;
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
    let left = o.qty;
    for (const c of seller.cargo.filter((x) => x.good === o.good && !x.jobId)) { const k = Math.min(c.qty, left); c.qty -= k; left -= k; }
    if (left > 0) return this.event(p, 'warn', 'Seller no longer has the goods.');
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
    this.send(q, { t: 'convoy_invite', convoyId: p.convoyId, from: p.name, fromId: p.id });
    this.event(p, 'info', `Invited ${q.name} to your convoy.`);
    this.sendYou(p);
  }
  convoyAccept(p, convoyId) {
    const c = this.convoys.get(convoyId); if (!c) return this.event(p, 'warn', 'That convoy no longer exists.');
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

  // ------------------------------------------------------------------ snapshots
  snapshot() {
    const players = [];
    for (const p of this.byId.values()) if (p.online) players.push(this.publicState(p));
    return { t: 'snap', time: Date.now(), simTime: Math.round(this.simTime), wind: { dir: Math.round(this.wind.dir), spd: Math.round(this.wind.spd * 10) / 10, u: round3(this.wind.u), v: round3(this.wind.v) }, players, cutters: this.cutters.map(cutterPublic) };
  }
  broadcastSnapshot() {
    const snap = JSON.stringify(this.snapshot());
    for (const [id, ws] of this.sockets) if (ws.readyState === 1) ws.send(snap);
    const now = Date.now();
    if (now - this.lastYou > 1000) { this.lastYou = now; for (const p of this.byId.values()) if (p.online) this.sendYou(p); }
  }
  currentFor(p) { return currentAt(p.ship.lat, p.ship.lon, this.simTime); }
}

function cutterPublic(c) { return { id: c.id, name: c.name, lat: round6(c.lat), lon: round6(c.lon), hdg: Math.round(c.hdg), spd: Math.round(c.spd * 10) / 10, state: c.state, targetId: c.targetId }; }
function cleanName(n) { return String(n || '').replace(/[^\w \-'.]/g, '').trim().slice(0, 20); }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function round6(v) { return Math.round(v * 1e6) / 1e6; }
function round3(v) { return Math.round(v * 1e3) / 1e3; }
function fmt(n) { return Math.round(n).toLocaleString('en-US'); }
const CONTACT_NAMES = ['a man in an oilskin', 'Big Tomas', 'the woman with the dog', 'a kid on a scooter', 'Old Henk', 'the crane operator', 'Mister Lindqvist', 'the harbour master\'s cousin'];
function contactName(rnd) { return CONTACT_NAMES[Math.floor(rnd() * CONTACT_NAMES.length)]; }
