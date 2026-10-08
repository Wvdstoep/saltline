// Test helper for the v6 fleet tests (not a test file itself). FakeGame implements the part of server/game.js the fleet
// and the captains call, with the same money and docking rules, so test/fleet-*.test.mjs can run the fleet without the
// real Game (phase 1 of docs/V6-FLEET-CONTRACTS.md: game.js is not wired yet). The phase-2 integration tests in the same
// files use the real Game instead (they are skipped until then).
import { Fleet } from '../server/fleet.js';
import { newCap } from '../server/captain.js';
import { defaultShipName } from '../shared/fleet.js';
import { HARBORS, harborById, FISHING_GROUNDS } from '../server/harbors.js';
import { SHIP_CLASSES, INTERACT, FEES } from '../shared/constants.js';
import { haversine, bearing, destination, normDeg, angleDiff } from '../shared/geo.js';
import { portDues, berthFeePerDay, cargoMass, tugCostFor, serviceCostFor, repairCostFor, shipValue } from '../server/economy.js';
import { catchRate } from '../shared/rates.js';

const SERVICE_INTERVAL_S = FEES.SERVICE_INTERVAL_DAYS * 86400;
export const T0 = Date.UTC(2026, 9, 8, 12, 0, 0) / 1000;   // Thu 2026-10-08 12:00 UTC
export const fakeSocket = () => ({ readyState: 1, sent: [], send(m) { this.sent.push(typeof m === 'string' ? JSON.parse(m) : m); }, close() {} });
export const last = (ws, t) => [...ws.sent].reverse().find((m) => m.t === t);
export const events = (ws) => ws.sent.filter((m) => m.t === 'event').map((m) => m.text);
/** Planner over open water: one straight leg. */
export const straightPlanner = (calls = []) => ({ plan: async (from, to, opts) => { calls.push({ from, to, opts }); return { points: [[from.lat, from.lon], [to.lat, to.lon]], distM: Math.round(haversine(from.lat, from.lon, to.lat, to.lon)) }; }, full: () => false });

export class FakeGame {
  constructor(o = {}) {
    this.simTime = o.simTime ?? T0;
    this.players = new Map(); this.byId = new Map(); this.sockets = new Map();
    this.harbors = {}; for (const h of HARBORS) this.harbors[h.id] = { jobs: [], used: [], market: { fuel: 600 }, stock: { fuel: 1e6 } };
    this.storms = []; this.wrecks = []; this.cutters = []; this.broadcasts = [];
    this.rnd = () => 0.5; this.log = () => {};
    this.world = o.world || { isWater: () => true, depthAt: () => 60, nearestWater: (lat, lon) => ({ lat, lon }) };
    this.routePlanner = o.routePlanner || null;
    this.geomFn = o.geom || null; this.depthFn = o.depthLW || null; this.wxFn = o.weather || null;
    this.liveAis = null;
    this.fleet = new Fleet(this);
    this.seq = 1;
  }
  // --- people
  join(name = 'Ann', o = {}) {
    const id = o.id || (0x10000000 + this.seq++).toString(16);
    const h = harborById(o.harbor || 'rotterdam'), a = this.harborAnchor(h);
    const p = { id, token: 't' + id, name, createdAt: Date.now(), money: o.money ?? 25000, wanted: 0, wantedAt: 0, convoyId: null, lastInspected: -1e9, lastSeen: Date.now(),
      stats: { delivered: 0, earned: 0, sunk: 0, inspected: 0, fined: 0, caught: 0, boarded: 0, pirated: 0, distanceKm: 0, collisions: 0 }, shallowSince: 0, log: [],
      warp: 1, warpRouted: false, warpGraceUntil: 0, warpGraceFactor: 1, warpRun: null, online: true };
    this.fleet.createFirstVessel(p, { cls: o.cls || 'coaster', spawn: { lat: a.lat, lon: a.lon }, berth: null, harbor: h.id });
    this.players.set(p.token, p); this.byId.set(p.id, p);
    const ws = fakeSocket(); this.sockets.set(p.id, ws);
    return { p, ws };
  }
  /** Add a vessel to p's fleet (docked at `harbor`, or at sea at lat/lon). */
  addVessel(p, o = {}) {
    const f = this.fleet, cls = o.cls || 'trawler', C = SHIP_CLASSES[cls];
    let pos;
    if (o.at) pos = o.at; else { const h = harborById(o.harbor || 'rotterdam'); pos = this.harborAnchor(h); }
    const v = f.makeVessel(p.id, { id: o.id, name: o.name || null, ship: { cls, lat: pos.lat, lon: pos.lon, hdg: o.hdg ?? 0, spd: o.spd ?? 0, throttle: 0, rudder: 0 }, cond: o.cond ?? 100, fuel: o.fuel ?? C.fuelCap, docked: o.at ? null : (o.harbor || 'rotterdam'), berth: o.berth || null });
    if (!o.name) v.name = defaultShipName(p.fleet.map((x) => x.name));
    v.cap = newCap(this, 'idle');
    p.fleet.push(v); f.index(v);
    if (o.status === 'laidup') { v.status = 'laidup'; v.cap = null; v.laidUpAt = this.simTime; v.storagePaidTo = this.simTime; }
    return v;
  }
  // --- networking
  send(p, msg) { if (p.isActor) return; const ws = this.sockets.get(p.id); if (ws) ws.send(JSON.stringify(msg)); }
  event(p, kind, text, extra = {}) {
    if (p.isActor) return this.fleet.actorEvent(p, kind, text, extra);
    p.log = (p.log || []).slice(-30).concat([{ kind, text, time: Date.now() }]);
    this.send(p, { t: 'event', kind, text, ...extra });
  }
  sendYou(p, extra) { if (p.isActor) return; this.send(p, { t: 'you', you: { id: p.id, money: p.money, docked: p.docked, ship: { ...p.ship }, cond: p.cond, fuel: p.fuel, warp: p.warp, ...this.fleet.youFields(p) }, ...(extra || {}) }); }
  sendHarbor(p) {
    if (p.isActor) return;
    const h = harborById(p.docked); if (!h) return;
    this.send(p, { t: 'harbor', harbor: { id: h.id, name: h.name, country: h.country, size: h.size, lat: h.lat, lon: h.lon, fuelPrice: this.fuelPrice(h), jobs: this.harbors[h.id].jobs, used: this.harbors[h.id].used,
      shipyard: Object.values(SHIP_CLASSES).filter((c) => c.price > 0).map((c) => ({ id: c.id, name: c.name, cat: c.cat, price: c.price, tradeIn: shipValue(p.ship.cls, p.cond) })), tradeIn: shipValue(p.ship.cls, p.cond),
      ...this.fleet.harborFields(p, h) } });
  }
  broadcast(msg) { this.broadcasts.push(msg); }
  resetWarp(p) { p.warp = 1; p.warpRouted = false; p.warpGraceUntil = 0; p.warpGraceFactor = 1; }
  convoyLeave(p) { p.convoyId = null; }
  regenHarbor() {}
  aiNear() { return []; }
  stormsPublic() { return this.storms.map((s) => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon, radiusKm: s.radiusKm, intensity: s.intensity })); }
  // --- world
  harborAnchor(h) { const g = this.harborGeom(h.id); return g && g.anchor ? { ...g.anchor, built: true } : { lat: h.lat, lon: h.lon, built: false }; }
  harborGeom(id) { return this.geomFn ? this.geomFn(id) : null; }
  nearestHarbor(lat, lon) { let best = null, bd = Infinity; for (const h of HARBORS) { const a = this.harborAnchor(h), d = haversine(lat, lon, a.lat, a.lon); if (d < bd) { bd = d; best = h; } } return { harbor: best, units: bd }; }
  depthAtLowWater(lat, lon) { return this.depthFn ? this.depthFn(lat, lon) : this.world.depthAt(lat, lon) - 1; }
  weatherAt(lat, lon) { return this.wxFn ? this.wxFn(lat, lon) : { wind: { spd: 6, dir: 240 }, storm: 0, sea: 0.2 }; }
  groundAt(lat, lon) { for (const g of FISHING_GROUNDS) if (haversine(lat, lon, g.lat, g.lon) / 1000 <= g.radiusKm) return g; return null; }
  fuelPrice() { return 600; }
  berthFits(p, b) {
    const C = SHIP_CLASSES[p.ship.cls];
    if (b.kind === 'pontoon' && C.length > 30) return 'pontoon';
    if ((Number.isFinite(b.depth) ? b.depth : 99) + 0.3 < C.draft) return 'shallow';
    const maxLen = Number.isFinite(b.maxLength) ? b.maxLength : Number.isFinite(b.length) ? b.length : 1e9;
    return C.length > maxLen * 1.5 ? 'short' : null;
  }
  // --- ship clock and the at-sea step (the real ones are server/game.js advanceShipClock / stepAtSea)
  advanceShipClock(p, dt) { if (!Number.isFinite(p.shipTime)) p.shipTime = this.simTime; p.shipTime += dt; }
  migratePlayer(p) { if (!(p.serviceDue > 0)) p.serviceDue = this.simTime + SERVICE_INTERVAL_S; if (!Number.isFinite(p.shipTime)) p.shipTime = this.simTime; if (!Array.isArray(p.jobs)) p.jobs = []; p.warp = 1; }
  stepAtSea(p, h) {
    const s = p.ship, C = SHIP_CLASSES[s.cls];
    if (p.fuel > 0 && Math.abs(s.throttle) > 0.01) p.fuel = Math.max(0, p.fuel - C.burn * Math.abs(s.throttle) * h);
    if (p.fishing) {
      const g = this.groundAt(s.lat, s.lon);
      if (!g) { p.fishing = false; return; }
      if (Math.abs(s.spd) < INTERACT.FISH_MAX_KN) {
        const free = C.capacity - cargoMass(p.cargo), add = Math.max(0, Math.min(free, catchRate(s.cls, g.richness) * h));
        if (add > 0) { const st = p.cargo.find((c) => c.good === 'fish' && c.caught && !c.jobId); if (st) st.qty += add; else p.cargo.push({ good: 'fish', qty: add, contraband: false, jobId: null, caught: true }); }
      }
    }
  }
  simulateOffline(p, dt) {
    const v = p.voyage; if (!v || p.docked || p.flooding >= 1) return;
    const s = p.ship, C = SHIP_CLASSES[s.cls], last = v.route.length - 1;
    let i = Math.max(0, Math.min(last, v.i | 0)), wp = v.route[i], dist = haversine(s.lat, s.lon, wp[0], wp[1]);
    while (i < last && dist < Math.max(300, 3 * C.length)) { i++; wp = v.route[i]; dist = haversine(s.lat, s.lon, wp[0], wp[1]); }
    v.i = i;
    if (i === last && dist < 400) { p.voyage = null; s.throttle = 0; p.voyageEnd = 'arrived'; return; }
    const brg = bearing(s.lat, s.lon, wp[0], wp[1]);
    s.hdg = brg; s.throttle = v.throttle; s.spd = v.throttle * C.maxKn;
    const step = Math.min(dist, s.spd * 0.514444 * dt);
    const before = { lat: s.lat, lon: s.lon }, q = destination(s.lat, s.lon, brg, step);
    s.lat = q.lat; s.lon = q.lon;
    if (this.world.depthAt(s.lat, s.lon) < C.draft) { s.lat = before.lat; s.lon = before.lon; s.spd = 0; p.voyage = null; p.voyageEnd = 'shoal'; }
    else p.lastValid = { lat: s.lat, lon: s.lon };
  }
  // --- harbour (copies of the game's rules)
  setDocked(p, id, berth) { p.docked = id; p.dockedAt = this.simTime; p.berth = berth || null; p.assist = null; p.ship.spd = 0; p.ship.throttle = 0; p.ship.rudder = 0; p.fishing = false; }
  moorAt(p, h, b) { const s = p.ship; s.lat = b.lat; s.lon = b.lon; s.hdg = Math.abs(angleDiff(s.hdg, b.hdg)) <= 90 ? normDeg(b.hdg) : normDeg(b.hdg + 180); p.lastValid = { lat: b.lat, lon: b.lon }; this.setDocked(p, h.id, { harbor: h.id, id: b.id, name: b.name, hdg: s.hdg, lat: b.lat, lon: b.lon, depth: b.depth, length: b.length }); }
  dock(p) { if (p.docked) return; const { harbor, units } = this.nearestHarbor(p.ship.lat, p.ship.lon); if (units > INTERACT.DOCK_RADIUS_U || Math.abs(p.ship.spd) > 3) return this.event(p, 'warn', 'No harbour within docking range.'); this.setDocked(p, harbor.id, null); this.finishDock(p, harbor); }
  finishDock(p, h) {
    if (p.cond > 0) p.flooding = 0;
    this.event(p, 'info', p.berth ? `Moored at ${h.name}, ${p.berth.name}.` : `Docked at ${h.name}.`);
    this.deliverJobs(p, h);
    const dues = portDues(p.ship.cls, h);
    if (dues > 0) { p.money = Math.max(0, p.money - dues); this.event(p, 'info', `Port dues: ${dues} cr.`); }
    this.sendYou(p); this.sendHarbor(p);
  }
  undock(p) {
    if (!p.docked) return;
    const days = Math.max(1, Math.ceil((this.simTime - (p.dockedAt || this.simTime)) / 86400));
    const fee = p.docked === this.fleet.homeOf(p) ? 0 : days * berthFeePerDay(p.ship.cls);
    if (fee > 0) { p.money = Math.max(0, p.money - fee); this.event(p, 'info', `Berth fee: ${fee} cr.`); }
    p.docked = null; p.berth = null; p.dockedAt = null; p.lastValid = { lat: p.ship.lat, lon: p.ship.lon };
    this.event(p, 'info', 'Cast off.');
  }
  tugAssist(p) { this.event(p, 'warn', 'No tugs in the fake game.'); }
  stepAssist() {}
  tow(p) {
    if (p.docked) return;
    const { harbor, units } = this.nearestHarbor(p.ship.lat, p.ship.lon);
    const cost = Math.min(p.money, 3000 + Math.round(units * 2));
    p.money -= cost; p.assist = null; this.setDocked(p, harbor.id, null);
    const a = this.harborAnchor(harbor); p.ship.lat = a.lat; p.ship.lon = a.lon;
    this.event(p, 'warn', `Towed to ${harbor.name} for ${cost} cr.`);
    this.finishDock(p, harbor);
  }
  buyFuel(p, t) {
    if (!p.docked) return;
    const h = harborById(p.docked), C = SHIP_CLASSES[p.ship.cls], price = this.fuelPrice(h);
    t = Math.max(0, Math.min(C.fuelCap - p.fuel, Number.isFinite(t) ? t : C.fuelCap));
    if (t <= 0.01) return this.event(p, 'warn', 'Tanks are full.');
    if (Math.round(t * price) > p.money) { t = Math.floor((p.money / price) * 10) / 10; if (t <= 0) return this.event(p, 'warn', 'You cannot afford any fuel.'); }
    const c2 = Math.round(t * price);
    p.money -= c2; p.fuel = Math.min(C.fuelCap, p.fuel + t);
    this.event(p, 'info', `Bunkered ${t.toFixed(1)} t for ${c2} cr.`);
  }
  repair(p) { if (!p.docked) return; const cost = repairCostFor(p.ship.cls, p.cond); if (cost <= 0 || cost > p.money) return this.event(p, 'warn', 'No repair.'); p.money -= cost; p.cond = 100; }
  service(p) { if (!p.docked) return; const cost = serviceCostFor(p.ship.cls); if (p.money < cost) return; p.money -= cost; p.serviceDue = this.simTime + SERVICE_INTERVAL_S; }
  setFishing(p, on) {
    if (p.docked) return;
    if (on && !this.groundAt(p.ship.lat, p.ship.lon)) return this.event(p, 'warn', 'No fishing ground here.');
    p.fishing = !!on;
    if (on) p.fishInfo = { ground: this.groundAt(p.ship.lat, p.ship.lon).name, rate: 0, caught: 0, caughtRaw: 0, tooFast: false };
  }
  deliverOffshore(p, jobId) {
    const j = p.jobs.find((x) => x.id === jobId && x.type === 'supply'); if (!j || p.docked) return;
    if (haversine(p.ship.lat, p.ship.lon, j.at.lat, j.at.lon) > INTERACT.PLATFORM_RANGE_U || Math.abs(p.ship.spd) > 3) return this.event(p, 'warn', 'Too far.');
    const stack = p.cargo.find((c) => c.jobId === j.id); if (!stack) return;
    p.cargo = p.cargo.filter((c) => c !== stack);
    const pay = Math.round(j.pay * (p.shipTime > j.dueShip ? 0.5 : 1));
    p.money += pay; p.jobs = p.jobs.filter((x) => x !== j);
    this.event(p, 'info', `${j.platformName} took the supplies. +${pay} cr.`);
  }
  acceptJob(p, jobId) {
    if (!p.docked) return;
    const st = this.harbors[p.docked], job = st.jobs.find((j) => j.id === jobId);
    if (!job) return this.event(p, 'warn', 'That contract is gone.');
    const C = SHIP_CLASSES[p.ship.cls];
    if (job.type === 'fishing' || job.type === 'passengers' || job.type === 'charter') { /* nothing loaded */ }
    else { if (cargoMass(p.cargo) + job.qty > C.capacity) return this.event(p, 'warn', 'Not enough hold space.'); p.cargo.push({ good: job.type === 'supply' ? 'supplies' : job.good, qty: job.qty, contraband: false, jobId: job.id }); }
    st.jobs = st.jobs.filter((j) => j !== job);
    const hours = job.hours || 24;
    p.jobs.push({ ...job, hours, acceptedAt: this.simTime, acceptedShip: p.shipTime, dueShip: p.shipTime + hours * 3600 });
    this.event(p, 'info', `Contract signed: ${job.title}.`);
  }
  deliverJobs(p, h) {
    let n = 0;
    for (const j of [...p.jobs]) {
      if (j.to !== h.id) continue;
      let ok = false, frac = 1;
      if (j.type === 'passengers' || j.type === 'charter') ok = true;
      else if (j.type === 'tow') { if (p.towing === j.id) { ok = true; p.towing = null; } }
      else if (j.type === 'supply') ok = j.loaded === false;
      else if (j.type === 'fishing') {
        const stacks = p.cargo.filter((c) => c.good === 'fish' && c.caught && !c.jobId), have = stacks.reduce((s, c) => s + c.qty, 0);
        if (have >= j.qty * 0.25) { ok = true; frac = Math.min(1, have / j.qty); let left = Math.min(have, j.qty); for (const c of stacks) { const k = Math.min(c.qty, left); c.qty = Math.round((c.qty - k) * 10) / 10; left -= k; } p.cargo = p.cargo.filter((c) => c.qty > 0); }
      } else { const stack = p.cargo.find((c) => c.jobId === j.id); if (stack) { ok = true; frac = Math.min(1, stack.qty / j.qty); p.cargo = p.cargo.filter((c) => c !== stack); } }
      if (!ok) continue;
      let pay = Math.round(j.pay * frac); if (p.shipTime > j.dueShip) pay = Math.round(pay * 0.5);
      p.money += pay; p.jobs = p.jobs.filter((x) => x !== j); n++;
      this.event(p, 'info', `Delivered: ${j.title} — +${pay} cr.`);
    }
    return n;
  }
  whyNotDeliverable() { return 'not deliverable here.'; }
  buyShip(p, cls) {
    if (!p.docked) return; const C = SHIP_CLASSES[cls]; if (!C || !C.price || cls === p.ship.cls) return;
    const tradeIn = Math.round(SHIP_CLASSES[p.ship.cls].price * 0.5 * (p.cond / 100)), cost = C.price - tradeIn;
    if (p.money < cost) return this.event(p, 'warn', 'Too dear.');
    p.money -= cost; p.ship.cls = cls; p.cond = 100; p.flooding = 0; p.fuel = Math.min(p.fuel, C.fuelCap);
  }
  buyUsedShip(p, id) {
    const st = this.harbors[p.docked], l = (st.used || []).find((x) => x.id === id); if (!l) return;
    const cost = l.price - shipValue(p.ship.cls, p.cond); if (p.money < cost) return;
    p.money -= cost; p.ship.cls = l.cls; p.cond = l.cond; st.used = st.used.filter((x) => x !== l);
  }
  tugCost(p) { return tugCostFor(p.ship.cls); }
}
export { harborById };
