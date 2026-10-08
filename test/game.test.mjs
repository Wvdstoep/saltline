import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { World } from '../server/world.js';
import { carvingsForWorld, harborById } from '../server/harbors.js';
import { Game } from '../server/game.js';
import { SHIP_CLASSES, LAW, GOODS, FEES, INTERACT } from '../shared/constants.js';
import { haversine, bearing, destination } from '../shared/geo.js';
import { shipValue, serviceCostFor, portDues, pilotageFee, berthFeePerDay, tugCostFor, priceOf, demandBonus, ECON } from '../server/economy.js';

process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
const world = new World().load(carvingsForWorld(), () => {});
function fakeSocket() { const s = { readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); }, close() {} }; return s; }
function mkGame(opts = {}) { const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-test-state.json', ...opts }); g.saveState = () => {}; return g; }
function join(g, name) { const ws = fakeSocket(); const p = g.connect(ws, null, name); return { p, ws }; }
const last = (ws, t) => [...ws.sent].reverse().find((m) => m.t === t);
const events = (ws) => ws.sent.filter((m) => m.t === 'event').map((m) => m.text);
// A freight contract the starter coaster can carry; the random board does not always have one, so plant one.
function freightJob(g, maxQty = 1000) {
  const st = g.harbors.rotterdam;
  let j = st.jobs.find((x) => x.type === 'freight' && x.qty <= maxQty);
  if (!j) { j = { id: 'jfr' + st.jobs.length, type: 'freight', from: 'rotterdam', to: 'ijmuiden', good: 'grain', qty: 400, pay: 9000, distKm: 60, deadline: g.simTime + 36000, contraband: false, title: 'Freight 400 t of grain to IJmuiden' }; st.jobs.push(j); }
  return j;
}
// ---- fakes implementing the v0.3 contracts of harborgeom / WeatherService / Traffic (docs/V3-CONTRACTS.md) ----
const ROT = harborById('rotterdam');
function mkBerth(id, name, brgFromAnchor, distM, extra = {}) { return { id, name, ...destination(ROT.lat, ROT.lon, brgFromAnchor, distM), hdg: 45, length: 200, depth: 12, kind: 'quay', maxLength: 220, ...extra }; }
function fakeGeom(harborId, berths, opts = {}) {
  const hb = harborById(harborId);
  const anchor = opts.anchor || { lat: hb.lat, lon: hb.lon };
  const geom = { id: harborId, name: hb.name, source: 'synthetic', origin: { lat: hb.lat, lon: hb.lon }, anchor, n: 448, res: 10, berths, fairway: [], features: {} };
  return {
    getHarborGeom: (id) => (id === harborId ? geom : null),
    getHarborPatch: () => null,
    harborAnchor: (id) => (id === harborId ? anchor : harborById(id) ? { lat: harborById(id).lat, lon: harborById(id).lon } : null),
    nearestBerth(id, lat, lon) {
      if (id !== harborId || !berths.length) return null;
      let best = null;
      for (const b of berths) { const d = haversine(lat, lon, b.lat, b.lon); if (!best || d < best.distM) best = { berth: b, distM: d, brg: bearing(lat, lon, b.lat, b.lon) }; }
      return best;
    },
    landPenetration: (lat, lon) => (opts.land ? opts.land(lat, lon) : null),
    sdfAt: (id, lat, lon) => (opts.sdf ? opts.sdf(lat, lon) : null),
  };
}
function fakeTraffic(ships) { return { near: (lat, lon, r) => ships.filter((s) => haversine(lat, lon, s.lat, s.lon) <= r), all: () => ships, tick() {} }; }

test('new players spawn docked at Rotterdam with the starter coaster', () => {
  const g = mkGame(); const { p, ws } = join(g, 'Ann');
  assert.equal(p.docked, 'rotterdam'); assert.equal(p.ship.cls, 'coaster'); assert.equal(p.money, 25000);
  assert.equal(last(ws, 'welcome').world.harbors.length > 80, true);
  assert.ok(last(ws, 'harbor').harbor.jobs.length >= 3);
});
test('new players start moored at the least used fitting quay of a built start harbour, else at the anchor', () => {
  const b1 = mkBerth('rotterdam-b1', 'Berth 1', 90, 300), b2 = mkBerth('rotterdam-b2', 'Berth 2', 90, 600);
  const pont = mkBerth('rotterdam-b3', 'Pontoon', 90, 100, { kind: 'pontoon', depth: 4, length: 30 }), shallow = mkBerth('rotterdam-b4', 'Shallow', 90, 50, { depth: 2 });
  const g = mkGame({ harborgeom: fakeGeom('rotterdam', [pont, shallow, b2, b1]) });
  const a = join(g, 'Ann').p, b = join(g, 'Bob').p, c = join(g, 'Cy').p;
  assert.equal(a.docked, 'rotterdam'); assert.equal(a.berth.id, 'rotterdam-b1', 'the fitting quay nearest the anchor first');
  assert.equal(a.ship.lat, b1.lat); assert.equal(a.ship.lon, b1.lon); assert.equal(a.ship.hdg, 45); assert.equal(a.berth.harbor, 'rotterdam');
  assert.equal(b.berth.id, 'rotterdam-b2', 'the next skipper gets a free quay, not a pontoon or a shallow berth');
  assert.ok(['rotterdam-b1', 'rotterdam-b2'].includes(c.berth.id), 'all quays taken: share the least used one');
  const g2 = mkGame({ harborgeom: fakeGeom('rotterdam', [pont]) }); const d = join(g2, 'Di').p;
  assert.equal(d.berth, null); assert.ok(Math.abs(d.ship.lat - ROT.lat) < 1e-9, 'no fitting berth: at the anchor');
  const e = join(mkGame(), 'Ed').p; assert.equal(e.berth, null); assert.equal(e.docked, 'rotterdam', 'no geometry: docked at the anchor');
});
test('accepting freight loads cargo, delivering at the destination pays', () => {
  const g = mkGame(); const { p, ws } = join(g, 'Bob');
  const job = freightJob(g, 1200);
  g.onAction(p, { action: 'accept_job', jobId: job.id });
  assert.equal(p.jobs.length, 1); assert.equal(p.cargo[0].qty, job.qty);
  // teleport to destination and dock
  g.onAction(p, { action: 'undock' });
  const dest = harborById(job.to); p.ship.lat = dest.lat; p.ship.lon = dest.lon; p.ship.spd = 0;
  const bonus = Math.round(job.pay * demandBonus(g.harbors[dest.id], job.good));
  const m0 = p.money; g.onAction(p, { action: 'dock' });
  assert.equal(p.docked, dest.id); assert.equal(p.jobs.length, 0); assert.equal(p.cargo.length, 0);
  assert.equal(p.money, m0 + job.pay + bonus - portDues('coaster', dest), 'paid plus the demand bonus, minus port dues');
  assert.ok(bonus >= 0 && bonus <= job.pay * ECON.DEMAND_BONUS_MAX);
});
test('contract cargo cannot be sold; free cargo can', () => {
  const g = mkGame(); const { p } = join(g, 'Cid');
  const m0 = p.money; g.onAction(p, { action: 'buy_goods', good: 'grain', qty: 10 });
  assert.ok(p.money < m0 && p.cargo[0].qty === 10);
  const m = p.money; g.onAction(p, { action: 'sell_goods', good: 'grain', qty: 10 });
  assert.ok(p.money > m); assert.equal(p.cargo.length, 0);
  const job = freightJob(g, 1200);
  g.onAction(p, { action: 'accept_job', jobId: job.id });
  g.onAction(p, { action: 'sell_goods', good: job.good, qty: job.qty });
  assert.equal(p.cargo[0].qty, job.qty, 'contract cargo untouched');
});
test('inspection with contraband fines or impounds; clean ships pass', () => {
  const g = mkGame(); const { p, ws } = join(g, 'Dee');
  assert.equal(g.inspect(p, 'test authority'), false);
  p.cargo.push({ good: 'narcotics', qty: 10, contraband: true, jobId: null });
  p.money = 1e9; const m = p.money;
  assert.equal(g.inspect(p, 'test authority'), true);
  assert.equal(p.cargo.length, 0); assert.ok(p.money < m); assert.equal(p.wanted, 1);
  p.cargo.push({ good: 'weapons', qty: 10, contraband: true, jobId: null }); p.money = 0; p.docked = null;
  g.inspect(p, 'test authority');
  assert.ok(p.docked, 'impounded → docked'); assert.equal(p.wanted, 2);
  p.cargo.push({ good: 'weapons', qty: 10, contraband: true, jobId: null }); p.docked = null; p.money = 5e6;
  g.inspect(p, 'test authority');
  assert.equal(p.money, 500, 'forced reset'); assert.equal(p.wanted, 0);
});
test('sinking creates a persistent wreck, launches a rescue, and the rescue lands the player at the nearest harbour', () => {
  const g = mkGame(); const { p, ws } = join(g, 'Eve');
  g.onAction(p, { action: 'undock' });
  p.cargo.push({ good: 'steel', qty: 100, contraband: false, jobId: null });
  p.cond = 0; p.flooding = 1; p.money = 10000;
  g.tick(0.1);
  assert.equal(g.wrecks.length, 1); assert.equal(g.wrecks[0].cargo[0].qty, 100);
  assert.ok(p.rescue, 'rescue started'); assert.equal(g.rescues.length, 1); assert.equal(g.rescues[0].kind, 'lifeboat');
  assert.ok(!p.docked, 'adrift until rescued');
  g.rescues[0].eta = Date.now() - 1; g.updateRescues(0.1);
  assert.ok(p.docked); assert.equal(p.flooding, 0); assert.equal(p.money, 8000); assert.equal(p.rescue, null);
  // salvage by another player
  const { p: q } = join(g, 'Fay'); g.onAction(q, { action: 'undock' });
  q.ship.lat = g.wrecks[0].lat; q.ship.lon = g.wrecks[0].lon; q.ship.spd = 0;
  g.onAction(q, { action: 'salvage', wreckId: g.wrecks[0].id });
  assert.equal(q.cargo[0].qty, 100); assert.equal(g.wrecks.length, 0);
});
test('fuel burns under way and the engine stops when empty', () => {
  const g = mkGame(); const { p } = join(g, 'Gus');
  g.onAction(p, { action: 'undock' }); p.ship.throttle = 1; p.ship.spd = 14; p.fuel = 0.00001;
  g.tick(1);
  assert.equal(p.fuel, 0); assert.equal(g.privateState(p).fuelEmpty, true);
});
test('implausible position jumps are rejected', () => {
  const g = mkGame(); const { p, ws } = join(g, 'Hal');
  g.onAction(p, { action: 'undock' });
  const lat = p.ship.lat;
  g.onState(p, { lat: lat + 2, lon: p.ship.lon, hdg: 0, spd: 5, throttle: 0.5, rudder: 0 });
  assert.equal(p.ship.lat, lat);
  assert.ok(last(ws, 'you').correction, 'server sends a correction flag');
  g.onState(p, { lat: lat + 0.0002, lon: p.ship.lon, hdg: 10, spd: 5, throttle: 0.5, rudder: 0 });
  assert.equal(p.ship.lat, lat + 0.0002);
  g.onState(p, { lat: 'x', lon: null }); assert.ok(Number.isFinite(p.ship.lat));
  g.onState(p, { lat: p.ship.lat, lon: p.ship.lon, hdg: NaN, spd: 'abc', throttle: Infinity, rudder: {} });
  assert.ok(Number.isFinite(p.ship.hdg) && Number.isFinite(p.ship.spd) && Number.isFinite(p.ship.throttle) && Number.isFinite(p.ship.rudder));
  // spamming cannot bank distance: 50 instant messages of 20 m each are not all accepted
  const before = p.ship.lat; let accepted = 0;
  for (let i = 0; i < 50; i++) { const want = p.ship.lat + 0.00018; g.onState(p, { lat: want, lon: p.ship.lon, hdg: 0, spd: 14, throttle: 1, rudder: 0 }); if (p.ship.lat === want) accepted++; }
  assert.ok(accepted < 50, `accepted ${accepted} of 50 spam moves`);
});
test('trade between docked players transfers goods and credits', () => {
  const g = mkGame(); const a = join(g, 'Ian'), b = join(g, 'Jo');
  g.onAction(a.p, { action: 'buy_goods', good: 'grain', qty: 50 });
  g.onAction(a.p, { action: 'trade_offer', toId: b.p.id, good: 'grain', qty: 20, price: 1000 });
  const offer = last(b.ws, 'trade').offer; const ma = a.p.money, mb = b.p.money;
  g.onAction(b.p, { action: 'trade_accept', offerId: offer.id });
  assert.equal(a.p.money, ma + 1000); assert.equal(b.p.money, mb - 1000);
  assert.equal(b.p.cargo[0].qty, 20); assert.equal(a.p.cargo[0].qty, 30);
});
test('boarding needs range and speed, steals half the cargo and raises wanted', () => {
  const g = mkGame(); g.rnd = () => 0.01; const a = join(g, 'Kim'), b = join(g, 'Lou');
  g.onAction(a.p, { action: 'undock' }); g.onAction(b.p, { action: 'undock' });
  b.p.cargo.push({ good: 'steel', qty: 100, contraband: false, jobId: null });
  b.p.ship.lat = a.p.ship.lat + 0.5; g.onAction(a.p, { action: 'board', targetId: b.p.id });
  assert.equal(b.p.cargo[0].qty, 100, 'out of range');
  b.p.ship.lat = a.p.ship.lat; b.p.ship.lon = a.p.ship.lon; b.p.ship.spd = 2; a.p.ship.spd = 2;
  g.onAction(a.p, { action: 'board', targetId: b.p.id });
  assert.equal(b.p.cargo[0].qty, 50); assert.equal(a.p.cargo[0].qty, 50); assert.equal(a.p.wanted, 2);
});
test('coast guard hail → comply → inspection clears the hail', () => {
  const g = mkGame(); const { p, ws } = join(g, 'Mo');
  g.onAction(p, { action: 'undock' });
  const c = g.cutters[0]; g.hail(c, p);
  assert.ok(p.hail); p.ship.spd = 0; c.timer = 0; p.ship.lat = c.lat; p.ship.lon = c.lon;
  g.updateCutters(0.1); assert.equal(c.state, 'inspect');
  c.timer = 0; g.updateCutters(0.1); assert.equal(c.state, 'patrol'); assert.equal(p.hail, null);
  assert.ok(events(ws).some((t) => /in order/.test(t)));
});
test('state round-trips through JSON persistence', () => {
  const g = mkGame(); const { p } = join(g, 'Ned');
  const s = JSON.parse(JSON.stringify({ players: [...g.players.values()], wrecks: g.wrecks, harbors: g.harbors, simTime: g.simTime }));
  assert.equal(s.players[0].name, 'Ned'); assert.ok(s.harbors.rotterdam.jobs.length);
});

test('abandoning a contract removes the contract cargo instead of freeing it for sale', () => {
  const g = mkGame(); const { p } = join(g, 'Oz');
  const job = freightJob(g, 1200);
  g.onAction(p, { action: 'accept_job', jobId: job.id });
  const m = p.money; g.onAction(p, { action: 'abandon_job', jobId: job.id });
  assert.equal(p.cargo.length, 0); assert.equal(p.jobs.length, 0); assert.ok(p.money <= m);
});
test('prototype keys and unknown goods are rejected everywhere', () => {
  const g = mkGame(); const { p } = join(g, 'Pat');
  const m = p.money;
  for (const bad of ['__proto__', 'constructor', 'toString', 'narcotics', 42, null]) {
    g.onAction(p, { action: 'buy_goods', good: bad, qty: 10 });
    g.onAction(p, { action: 'sell_goods', good: bad, qty: 10 });
    g.onAction(p, { action: 'dump_cargo', good: bad });
  }
  assert.equal(p.money, m); assert.ok(Number.isFinite(p.money)); assert.equal(p.cargo.length, 0);
});
test('fuel dock reads the tonnes field and fishing contracts need caught fish', () => {
  const g = mkGame(); const { p } = join(g, 'Quin');
  p.fuel = 10; g.onAction(p, { action: 'buy_fuel', tonnes: 20 });
  assert.ok(Math.abs(p.fuel - 30) < 0.01);
  const job = g.harbors.rotterdam.jobs.find((j) => j.type === 'fishing');
  if (job) {
    g.onAction(p, { action: 'accept_job', jobId: job.id });
    g.onAction(p, { action: 'buy_goods', good: 'fish', qty: Math.min(1000, job.qty) }); p.money = 1e6;
    g.onAction(p, { action: 'undock' }); p.ship.lat = harborById('rotterdam').lat; p.ship.lon = harborById('rotterdam').lon; p.ship.spd = 0; g.onAction(p, { action: 'dock' });
    assert.equal(p.jobs.length, 1, 'bought fish does not complete a fishing contract');
    p.cargo.push({ good: 'fish', qty: job.qty, contraband: false, jobId: null, caught: true });
    g.onAction(p, { action: 'undock' }); p.ship.lat = harborById('rotterdam').lat; p.ship.lon = harborById('rotterdam').lon; p.ship.spd = 0; g.onAction(p, { action: 'dock' });
    assert.equal(p.jobs.length, 0, 'caught fish completes it');
  }
});
test('convoys need an invitation; hail cannot be escaped by docking or disconnecting without a wanted level', () => {
  const g = mkGame(); const a = join(g, 'Ray'), b = join(g, 'Sue');
  g.onAction(b.p, { action: 'convoy_accept', convoyId: 'cnope' });
  assert.equal(b.p.convoyId, null);
  g.onAction(a.p, { action: 'convoy_invite', targetId: b.p.id });
  g.onAction(b.p, { action: 'convoy_accept', convoyId: a.p.convoyId });
  assert.equal(b.p.convoyId, a.p.convoyId);
  g.onAction(a.p, { action: 'undock' }); const c = g.cutters[0]; g.hail(c, a.p);
  a.p.ship.lat = harborById('rotterdam').lat; a.p.ship.lon = harborById('rotterdam').lon; a.p.ship.spd = 0; g.onAction(a.p, { action: 'dock' });
  assert.ok(!a.p.docked, 'docking refused while hailed');
  g.disconnect(a.p); assert.equal(a.p.wanted, 1); assert.equal(a.p.hail, null); assert.equal(c.state, 'patrol');
});
test('towing, supply and charter contracts', () => {
  const g = mkGame(); g.rnd = () => 0.5; const { p } = join(g, 'Tom');
  const st = g.harbors.rotterdam;
  const tow = { id: 'jtow', type: 'tow', from: 'rotterdam', to: 'ijmuiden', at: { lat: 52.3, lon: 3.6 }, victimCls: 'trawler', pay: 10000, deadline: g.simTime + 36000, title: 'tow' };
  const sup = { id: 'jsup', type: 'supply', from: 'rotterdam', to: 'rotterdam', at: { lat: 53.6, lon: 4.9 }, platformName: 'L9', good: 'supplies', qty: 100, pay: 8000, deadline: g.simTime + 36000, title: 'supply' };
  const cha = { id: 'jcha', type: 'charter', from: 'rotterdam', to: 'ijmuiden', pax: 4, pay: 5000, needsCat: ['motor yacht', 'sailing yacht', 'passenger'], deadline: g.simTime + 36000, title: 'charter' };
  st.jobs.push(tow, sup, cha);
  g.onAction(p, { action: 'accept_job', jobId: 'jcha' }); assert.equal(p.jobs.length, 0, 'coaster cannot take a charter');
  g.onAction(p, { action: 'accept_job', jobId: 'jtow' }); g.onAction(p, { action: 'accept_job', jobId: 'jsup' });
  assert.equal(p.jobs.length, 2); assert.equal(p.cargo[0].good, 'supplies');
  g.onAction(p, { action: 'undock' });
  g.onAction(p, { action: 'tow_pickup', jobId: 'jtow' }); assert.equal(p.towing, undefined === p.towing ? undefined : null, 'out of range');
  p.ship.lat = 52.3; p.ship.lon = 3.6; p.ship.spd = 1; g.onAction(p, { action: 'tow_pickup', jobId: 'jtow' }); assert.equal(p.towing, 'jtow');
  const m = p.money; p.ship.lat = 53.6; p.ship.lon = 4.9; g.onAction(p, { action: 'deliver_offshore', jobId: 'jsup' });
  assert.equal(p.money, m + 8000); assert.equal(p.cargo.length, 0);
  const ij = g.worldInfo().harbors.find((h) => h.id === 'ijmuiden'); p.ship.lat = ij.lat; p.ship.lon = ij.lon; p.ship.spd = 0; g.onAction(p, { action: 'dock' });
  assert.equal(p.towing, null); assert.equal(p.jobs.length, 0); assert.ok(p.money > m + 8000);
});
test('express passage costs credits and fuel and moves the ship; used ships can be bought with trade-in', () => {
  const g = mkGame(); const { p, ws } = join(g, 'Uma');
  g.onAction(p, { action: 'undock' }); p.money = 1e6;
  const f = p.fuel, m = p.money;
  g.onAction(p, { action: 'express', lat: 52.46, lon: 4.5 });
  assert.ok(p.money < m && p.fuel < f); assert.ok(Math.abs(p.ship.lat - 52.46) < 0.05); assert.ok(last(ws, 'you').correction);
  p.ship.lat = harborById('rotterdam').lat; p.ship.lon = harborById('rotterdam').lon; p.ship.spd = 0; g.onAction(p, { action: 'dock' });
  const used = g.harbors.rotterdam.used; assert.ok(used.length >= 1);
  const l = used[0]; p.money = l.price + 1; g.onAction(p, { action: 'buy_used', listingId: l.id });
  assert.equal(p.ship.cls, l.cls); assert.equal(p.cond, l.cond);
});
test('storms raise local wind and sea state; offline voyages keep sailing', () => {
  const g = mkGame();
  g.storms.push({ id: 's1', name: 'Test', lat: 55, lon: 3, radiusKm: 100, peak: 1, intensity: 1, driftDir: 90, driftMs: 5, born: g.simTime, dies: g.simTime + 3600 });
  const inside = g.weatherAt(55.1, 3.1), outside = g.weatherAt(50, -5);
  assert.ok(inside.wind.spd > outside.wind.spd + 6); assert.ok(inside.sea > 0.5); assert.ok(inside.storm > 0.5);
  const { p } = join(g, 'Vic'); g.onAction(p, { action: 'undock' });
  g.onAction(p, { action: 'set_voyage', lat: 52.3, lon: 3.5, throttle: 1 });
  g.disconnect(p); const lat0 = p.ship.lat;
  for (let i = 0; i < 600; i++) g.tick(0.1);
  assert.ok(p.ship.lat !== lat0 && p.ship.spd > 1, 'ship moved while offline');
});

// ------------------------------------------------------------------------------------------ v0.3 (docs/V3-CONTRACTS.md §3)
test('berthing: moor only alongside a berth within 60 m under 2 kn; the ship snaps to the berth and casts off beside it', () => {
  const b1 = mkBerth('rotterdam-b1', 'Berth 1', 90, 300);
  const g = mkGame({ harborgeom: fakeGeom('rotterdam', [b1]) }); const { p, ws } = join(g, 'Ann');
  assert.equal(p.berth?.id, 'rotterdam-b1', 'a new skipper starts moored alongside the built quay');
  g.onAction(p, { action: 'undock' });
  const d0 = haversine(p.ship.lat, p.ship.lon, b1.lat, b1.lon);
  assert.ok(d0 > 15 && d0 < 25, `first cast off ${d0.toFixed(1)} m off the start berth`);
  const far = destination(b1.lat, b1.lon, 180, 200); p.ship.lat = far.lat; p.ship.lon = far.lon; p.ship.spd = 1;
  g.onAction(p, { action: 'dock' });
  assert.ok(!p.docked); assert.ok(events(ws).some((t) => /alongside a berth/.test(t)), 'guidance when not at a berth');
  const nearPt = destination(b1.lat, b1.lon, 180, 30); p.ship.lat = nearPt.lat; p.ship.lon = nearPt.lon; p.ship.spd = 3;
  g.onAction(p, { action: 'dock' }); assert.ok(!p.docked, 'too fast');
  p.ship.spd = 1; p.ship.hdg = 200; g.rnd = () => 0.99; g.onAction(p, { action: 'dock' });
  assert.equal(p.docked, 'rotterdam'); assert.equal(p.berth.id, 'rotterdam-b1'); assert.equal(p.berth.name, 'Berth 1');
  assert.equal(p.ship.lat, b1.lat); assert.equal(p.ship.lon, b1.lon); assert.equal(p.ship.hdg, 225, 'lies along the quay the way she was pointing');
  const hv = last(ws, 'harbor').harbor;
  assert.equal(hv.berths.length, 1); assert.ok(hv.anchor.lat && hv.tugCost === tugCostFor('coaster') && hv.fees.berthPerDay === berthFeePerDay('coaster') && hv.fees.dues === portDues('coaster', ROT));
  assert.ok(hv.econ.stock.grain >= 0 && hv.econ.target.grain > 0 && hv.shipyard[0].specs.length > 0 && hv.shipyard[0].cat);
  assert.equal(last(ws, 'you').you.berth.id, 'rotterdam-b1');
  g.onAction(p, { action: 'undock' });
  const d = haversine(p.ship.lat, p.ship.lon, b1.lat, b1.lon);
  assert.ok(d > 15 && d < 25, `cast off ${d.toFixed(1)} m off the berth point`); assert.equal(p.berth, null); assert.ok(last(ws, 'you').correction);
  // a shallow berth or a pontoon refuses a freighter
  const shallow = mkBerth('rotterdam-b2', 'Berth 2', 270, 300, { depth: 3 }), pont = mkBerth('rotterdam-b3', 'Pontoon', 0, 300, { kind: 'pontoon', depth: 4, length: 30 });
  g.geom = fakeGeom('rotterdam', [shallow, pont]);
  p.ship.lat = shallow.lat; p.ship.lon = shallow.lon; p.ship.spd = 0; g.onAction(p, { action: 'dock' }); assert.ok(!p.docked && events(ws).some((t) => /m of water/.test(t)));
  p.ship.lat = pont.lat; p.ship.lon = pont.lon; g.onAction(p, { action: 'dock' }); assert.ok(!p.docked && events(ws).some((t) => /pontoon/.test(t)));
  // legacy rule when no geometry is built: within DOCK_RADIUS_U of the anchor at ≤ 3 kn
  g.geom = fakeGeom('ijmuiden', []); p.ship.lat = ROT.lat; p.ship.lon = ROT.lon; p.ship.spd = 2.5; g.onAction(p, { action: 'dock' }); assert.equal(p.docked, 'rotterdam'); assert.equal(p.berth, null);
});
test('tug assist charges the fee, takes control of the ship and moors it at a fitting berth', () => {
  const b1 = mkBerth('rotterdam-b1', 'Berth 1', 90, 300), small = mkBerth('rotterdam-b2', 'Dinghy pontoon', 60, 100, { kind: 'pontoon', depth: 2, length: 20 });
  const g = mkGame({ harborgeom: fakeGeom('rotterdam', [small, b1]) }); const { p, ws } = join(g, 'Bo'); g.rnd = () => 0.99;
  g.onAction(p, { action: 'undock' });
  const start = destination(ROT.lat, ROT.lon, 270, 800); p.ship.lat = start.lat; p.ship.lon = start.lon; p.ship.spd = 4; p.ship.hdg = 90;
  const m = p.money; g.onAction(p, { action: 'tug_assist' });
  assert.ok(p.assist, 'assist started'); assert.equal(p.assist.berthId, 'rotterdam-b1', 'the pontoon does not fit a coaster'); assert.equal(p.money, m - Math.max(400, Math.round(3200 * 0.35)));
  assert.ok(last(ws, 'you').you.assist.until > Date.now());
  g.onState(p, { lat: start.lat + 0.001, lon: start.lon, hdg: 0, spd: 0 }); assert.equal(p.ship.lat, start.lat, 'client state ignored under tow');
  p.assist.start = Date.now() - 22500; p.assist.until = Date.now() + 22500; g.tick(0.1);
  const mid = haversine(p.ship.lat, p.ship.lon, start.lat, start.lon);
  assert.ok(p.assist && mid > 300 && mid < 800, `halfway (${mid.toFixed(0)} m from the start)`);
  p.assist.until = Date.now() - 1; g.tick(0.1);
  assert.equal(p.assist, null); assert.equal(p.docked, 'rotterdam'); assert.equal(p.berth.id, 'rotterdam-b1'); assert.equal(p.ship.lat, b1.lat); assert.equal(p.ship.hdg, 45);
  assert.ok(events(ws).some((t) => /Tugs cast off/.test(t)) && events(ws).some((t) => /Port dues/.test(t)));
  // refusals: too far from the anchor, too fast, hailed
  g.onAction(p, { action: 'undock' });
  const farPt = destination(ROT.lat, ROT.lon, 270, 3000); p.ship.lat = farPt.lat; p.ship.lon = farPt.lon; p.ship.spd = 2;
  g.onAction(p, { action: 'tug_assist' }); assert.equal(p.assist, null);
  p.ship.lat = start.lat; p.ship.lon = start.lon; p.ship.spd = 8; g.onAction(p, { action: 'tug_assist' }); assert.equal(p.assist, null);
  p.ship.spd = 2; p.hail = { cutter: 'x', cutterId: 'x', until: 0, state: 'hailed' }; g.onAction(p, { action: 'tug_assist' }); assert.equal(p.assist, null);
  p.hail = null; p.money = 10; g.onAction(p, { action: 'tug_assist' }); assert.equal(p.assist, null, 'cannot pay');
});
test('positions inside harbour structures are rejected with a correction and a rate-limited warning', () => {
  const wall = destination(ROT.lat, ROT.lon, 0, 40);
  const g = mkGame({ harborgeom: fakeGeom('rotterdam', [], { land: (lat, lon) => (haversine(lat, lon, wall.lat, wall.lon) < 15 ? 3 : 0) }) });
  const { p, ws } = join(g, 'Cy'); g.onAction(p, { action: 'undock' });
  const lat0 = p.ship.lat;
  g.onState(p, { lat: wall.lat, lon: wall.lon, hdg: 0, spd: 2, throttle: 0.3, rudder: 0 });
  assert.equal(p.ship.lat, lat0, 'stays at the last good position'); assert.ok(last(ws, 'you').correction);
  const warns = () => events(ws).filter((t) => /inside the harbour/.test(t)).length;
  assert.equal(warns(), 1);
  g.onState(p, { lat: wall.lat, lon: wall.lon, hdg: 0, spd: 2, throttle: 0.3, rudder: 0 }); assert.equal(warns(), 1, 'warning rate-limited');
  const ok = destination(ROT.lat, ROT.lon, 90, 30);
  g.onState(p, { lat: ok.lat, lon: ok.lon, hdg: 90, spd: 2, throttle: 0.3, rudder: 0 }); assert.equal(p.ship.lat, ok.lat, 'open water inside the patch is accepted');
});
test('collision damage is clamped to 0.5–12 %, ×0.6 for ships, floods above 8 kn and is rate-limited', () => {
  const g = mkGame(); const { p, ws } = join(g, 'Di'); g.onAction(p, { action: 'undock' });
  g.onAction(p, { action: 'collision', speedKn: 30, kind: 'quay' });
  assert.equal(p.cond, 88); assert.ok(Math.abs(p.flooding - 0.05) < 1e-9); assert.equal(p.stats.collisions, 1);
  g.onAction(p, { action: 'collision', speedKn: 30, kind: 'quay' }); assert.equal(p.cond, 88, 'one report per 3 s');
  p.lastCollision = 0; g.onAction(p, { action: 'collision', speedKn: 0.5, kind: 'breakwater' }); assert.equal(p.cond, 87.5, 'floor 0.5');
  p.lastCollision = 0; g.onAction(p, { action: 'collision', speedKn: 10, kind: 'ship' }); assert.ok(Math.abs(p.cond - 82.1) < 1e-9, 'ship ×0.6'); assert.ok(Math.abs(p.flooding - 0.1) < 1e-9);
  p.lastCollision = 0; g.onAction(p, { action: 'collision', speedKn: 0.2, kind: 'quay' }); assert.ok(Math.abs(p.cond - 82.1) < 1e-9, 'fenders absorb a nudge');
  p.lastCollision = 0; g.onAction(p, { action: 'collision', speedKn: 'x', kind: {} }); assert.ok(Number.isFinite(p.cond) && Math.abs(p.cond - 82.1) < 1e-9);
  assert.equal(p.stats.collisions, 3); assert.ok(events(ws).some((t) => /Heavy contact/.test(t)));
});
test('sell_ship pays shipValue and leaves a 60 % pilot boat; the pilot boat itself cannot be sold', () => {
  const g = mkGame(); const { p } = join(g, 'Ed');
  p.ship.cls = 'feeder'; p.cond = 80; p.fuel = 200; const m = p.money; const v = shipValue('feeder', 80);
  p.cargo.push({ good: 'steel', qty: 50, contraband: false, jobId: null });
  g.onAction(p, { action: 'sell_ship' }); assert.equal(p.ship.cls, 'feeder', 'cargo aboard: refused');
  p.cargo = []; g.onAction(p, { action: 'sell_ship' });
  assert.equal(p.money, m + v); assert.equal(p.ship.cls, 'pilot'); assert.equal(p.cond, 60); assert.ok(p.fuel <= SHIP_CLASSES.pilot.fuelCap);
  g.onAction(p, { action: 'sell_ship' }); assert.equal(p.money, m + v); assert.equal(p.ship.cls, 'pilot');
});
test('supply and demand: buying raises the price, selling lowers it, stock caps purchases, deliveries earn a demand bonus', () => {
  const g = mkGame(); const { p, ws } = join(g, 'Fy'); p.money = 1e9; g.rnd = () => 0.99;
  const st = g.harbors.rotterdam; const p0 = st.market.grain, s0 = st.stock.grain;
  assert.equal(p0, priceOf(ROT, 'grain', s0, st.target.grain), 'price is a function of stock/target');
  g.onAction(p, { action: 'buy_goods', good: 'grain', qty: 1000 });
  assert.equal(st.stock.grain, s0 - 1000); assert.ok(st.market.grain > p0, `price ${p0} → ${st.market.grain}`);
  g.onAction(p, { action: 'sell_goods', good: 'grain', qty: 1000 });
  assert.equal(st.stock.grain, s0); assert.equal(st.market.grain, p0);
  st.stock.grain = 1; st.target.grain = 30000; g.sendHarbor(p);
  assert.ok(st.market.grain <= Math.round(GOODS.grain.base * ECON.PRICE_MAX * 1.3) && st.market.grain >= GOODS.grain.base, 'shortage clamps at 1.9×');
  st.stock.grain = 1e9; g.sendHarbor(p); assert.ok(st.market.grain <= Math.round(GOODS.grain.base * ECON.PRICE_MIN * 1.3) + 1, 'glut clamps at 0.55×');
  st.stock.grain = s0;
  const econ = last(ws, 'harbor').harbor.econ;
  assert.ok(econ.stock.grain >= 0 && econ.target.grain > 0 && [-1, 0, 1].includes(econ.trend.grain));
  st.stock.steel = 5; g.onAction(p, { action: 'buy_goods', good: 'steel', qty: 100 });
  assert.equal(p.cargo.find((c) => c.good === 'steel').qty, 5, 'cannot buy more than the harbour holds');
  g.onAction(p, { action: 'buy_goods', good: 'steel', qty: 100 }); assert.ok(events(ws).some((t) => /sold out/.test(t)));
  // demand bonus at a destination short of the good; the delivery restocks it
  const job = freightJob(g, 900); g.onAction(p, { action: 'accept_job', jobId: job.id }); assert.equal(p.jobs.length, 1);
  const dest = harborById(job.to), ds = g.harbors[dest.id]; ds.stock[job.good] = 0;
  g.onAction(p, { action: 'undock' }); p.ship.lat = dest.lat; p.ship.lon = dest.lon; p.ship.spd = 0; const m = p.money;
  g.onAction(p, { action: 'dock' });
  assert.equal(p.docked, dest.id); assert.equal(p.jobs.length, 0);
  assert.equal(p.money, m + job.pay + Math.round(job.pay * ECON.DEMAND_BONUS_MAX) - portDues('coaster', dest) - pilotageFee('coaster', dest));
  assert.equal(ds.stock[job.good], job.qty, 'delivered cargo restocks the destination');
});
test('markets drift toward target between visits and over a restart', () => {
  const g = mkGame(); const st = g.harbors.rotterdam;
  st.stock.grain = 1000; st.target.grain = 30000; g.lastEcon = Date.now() - 2 * 3600e3; g.driftMarkets();
  assert.ok(st.stock.grain > 1000 && st.stock.grain < 30000, `drifted to ${st.stock.grain}`);
  assert.ok(Math.abs(st.stock.grain - (1000 + 29000 * (1 - 0.95 ** 2))) < 0.03 * 30000, 'about 5 %/h');
  assert.equal(st.market.grain, priceOf(ROT, 'grain', st.stock.grain, st.target.grain), 'prices refreshed');
});
test('berth fee per started day on undock, pilotage for big ships at big ports, service resets the wear ramp', () => {
  const g = mkGame(); g.rnd = () => 0.99; const { p, ws } = join(g, 'Gi'); p.money = 100000;
  p.office.home = 'hamburg'; // v6: no berth fee at home — this test is about the fee, so her office is elsewhere
  p.dockedAt = g.simTime - 2 * 86400 - 10; let m = p.money;
  g.onAction(p, { action: 'undock' }); assert.equal(p.money, m - 3 * berthFeePerDay('coaster')); assert.ok(events(ws).some((t) => /Berth fee: 3 days/.test(t)));
  p.ship.cls = 'feeder'; p.ship.lat = ROT.lat; p.ship.lon = ROT.lon; p.ship.spd = 0; m = p.money;
  g.onAction(p, { action: 'dock' });
  assert.equal(pilotageFee('feeder', ROT), Math.round(14000 * 0.05)); assert.equal(pilotageFee('coaster', ROT), 0, '90 m is not over 90 m'); assert.equal(pilotageFee('feeder', harborById('ostend')), 0, 'minor port');
  assert.equal(p.money, m - portDues('feeder', ROT) - pilotageFee('feeder', ROT));
  m = p.money; g.onAction(p, { action: 'undock' }); assert.equal(p.money, m - berthFeePerDay('feeder'), 'one started day');
  p.ship.lat = ROT.lat; p.ship.lon = ROT.lon; g.onAction(p, { action: 'dock' });
  const cost = serviceCostFor('feeder'); assert.equal(cost, Math.round(950000 * FEES.SERVICE_FRAC)); m = p.money;
  g.onAction(p, { action: 'service' }); assert.equal(p.money, m - cost); assert.ok(Math.abs(p.serviceDue - (g.simTime + FEES.SERVICE_INTERVAL_DAYS * 86400)) < 2);
  assert.equal(last(ws, 'harbor').harbor.fees.service, cost); assert.equal(last(ws, 'you').you.serviceDue, p.serviceDue);
  p.money = 0; g.onAction(p, { action: 'service' }); assert.equal(p.money, 0, 'cannot afford: nothing charged');
  // wear ramp: 30 days overdue wears 1.6× as fast (the cap)
  const a = join(g, 'Ha').p, b = join(g, 'Ia').p;
  for (const q of [a, b]) { g.onAction(q, { action: 'undock' }); q.ship.throttle = 1; q.ship.spd = 14; }
  a.serviceDue = g.simTime + 1e6; b.serviceDue = g.simTime - 30 * 86400;
  g.tick(1);
  assert.ok(a.cond < 100 && b.cond < 100); assert.ok(Math.abs((100 - b.cond) / (100 - a.cond) - 1.6) < 0.01, `ratio ${(100 - b.cond) / (100 - a.cond)}`);
  assert.equal(g.privateState(b).serviceMul, 1.6);
});
test('snapshots carry nearby AI per player; you carries tide, extended weather and nearBerth', () => {
  const b1 = mkBerth('rotterdam-b1', 'Berth 1', 90, 300);
  const ai = [{ id: 'ai1', name: 'Nordic Trader', cls: 'feeder', flag: 'NL', lat: ROT.lat + 0.05, lon: ROT.lon, hdg: 0, spd: 12, dest: 'hull', destName: 'Hull', state: 'underway', eta: 0 },
    { id: 'ai2', name: 'Far Away', cls: 'bulker', flag: 'PA', lat: 30, lon: -40, hdg: 0, spd: 12, dest: 'new_york', destName: 'New York', state: 'underway', eta: 0 }];
  const g = mkGame({ harborgeom: fakeGeom('rotterdam', [b1]), traffic: fakeTraffic(ai) });
  const { p, ws } = join(g, 'Jo');
  assert.equal(last(ws, 'welcome').ai.length, 1);
  g.broadcastSnapshot(); const snap = last(ws, 'snap');
  assert.equal(snap.ai.length, 1); assert.equal(snap.ai[0].id, 'ai1'); assert.ok(Array.isArray(snap.players) && Array.isArray(snap.storms) && snap.simTime > 0);
  const you = last(ws, 'you').you;
  assert.ok(Number.isFinite(you.tide.height) && ['flood', 'ebb'].includes(you.tide.state) && Number.isFinite(you.tide.stream.u) && you.tide.nextHigh > 0);
  for (const k of ['windDir', 'windSpd', 'gust', 'sea', 'storm', 'rain', 'waveH', 'waveDir', 'wavePeriod', 'swellH', 'swellDir', 'swellPeriod', 'visibility', 'pressure', 'temp', 'cloud']) assert.ok(Number.isFinite(you.weather[k]), k);
  assert.equal(you.weather.source, 'synthetic'); assert.equal(you.nearBerth, null, 'docked: no berth guidance'); assert.equal(you.assist, null);
  g.onAction(p, { action: 'undock' }); const y2 = last(ws, 'you').you;
  // the new skipper started at Berth 1, so casting off leaves the ship ~20 m off it
  assert.equal(y2.nearBerth.id, 'rotterdam-b1'); assert.ok(y2.nearBerth.distM > 15 && y2.nearBerth.distM < 25 && y2.nearBerth.hdg === 45 && y2.nearBerth.depth === 12);
  const anchorPt = destination(b1.lat, b1.lon, 270, 300); p.ship.lat = anchorPt.lat; p.ship.lon = anchorPt.lon; g.sendYou(p);
  const y3 = last(ws, 'you').you; assert.ok(y3.nearBerth.distM > 250 && y3.nearBerth.distM < 350, 'distance follows the ship');
  p.ship.lat = 55; p.ship.lon = 3; g.sendYou(p); assert.equal(last(ws, 'you').you.nearBerth, null, 'beyond 2500 m');
  // a Game without traffic still produces valid snapshots
  const g2 = mkGame(); const { ws: ws2 } = join(g2, 'Ko'); g2.broadcastSnapshot(); assert.deepEqual(last(ws2, 'snap').ai, []);
});
test('weatherAt uses real samples when the service has the cell, requests missing cells, and keeps synthetic storms as a fallback only', () => {
  const requested = [];
  const sample = { wind: { spd: 20, dir: 270, gust: 28 }, waves: { height: 3, dir: 280, period: 7 }, swell: { height: 1, dir: 250, period: 11 }, pressure: 998, temp: 9, precip: 2, visibility: 6000, cloud: 0.9, fetchedAt: Date.now(), source: 'open-meteo' };
  const weather = { sample: (lat) => (lat > 54 ? sample : null), request: (lat, lon) => requested.push([lat, lon]), tick() {}, stats: () => ({}) };
  const g = mkGame({ weather });
  const w = g.weatherAt(55, 3);
  assert.equal(w.source, 'open-meteo'); assert.equal(w.wind.spd, 20); assert.equal(w.wind.dir, 270); assert.ok(w.wind.u > 19.9, 'a westerly blows east'); assert.equal(w.wind.gust, 28);
  assert.equal(w.storm, 0.5); assert.equal(w.sea, 0.5); assert.equal(w.rain, 0.5); assert.equal(w.waves.height, 3); assert.equal(w.swell.period, 11); assert.equal(w.visibility, 6000);
  g.storms.push({ id: 's1', name: 'Test', lat: 55, lon: 3, radiusKm: 100, peak: 1, intensity: 1, driftDir: 90, driftMs: 5, born: g.simTime, dies: g.simTime + 3600 });
  assert.equal(g.weatherAt(55, 3).storm, 0.5, 'synthetic storms do not overlay real data');
  const s = g.weatherAt(50, -5);
  assert.equal(s.source, 'synthetic'); assert.ok(s.waves.height > 0 && s.visibility > 0 && Number.isFinite(s.temp));
  assert.ok(requested.some(([la, lo]) => la === 50 && lo === -5), 'missing cell requested lazily');
  const { p } = join(g, 'Lu'); assert.ok(requested.some(([la, lo]) => Math.abs(la - p.ship.lat) < 1e-6), 'player cell requested on connect');
  // marine data missing: waves are synthesised from the wind
  weather.sample = () => ({ wind: { spd: 10, dir: 0 }, waves: null, swell: null, pressure: 1015, temp: 14, precip: 0, visibility: 20000, cloud: 0.2, fetchedAt: 1, source: 'open-meteo' });
  const w2 = g.weatherAt(55, 3); assert.ok(w2.waves.height > 1 && w2.waves.height < 4 && w2.storm === 0 && w2.rain === 0);
});
test('old state files load with v0.3 defaults; new harbour and player fields survive a save/load round trip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saltline-')); const file = path.join(dir, 'state.json');
  const old = {
    savedAt: new Date().toISOString(), wrecks: [], storms: [], harbors: { rotterdam: { jobs: [], market: { grain: 250, fish: 700 }, contact: null, lastRegen: -1e9 } },
    players: [{ id: 'p1', token: 't1', name: 'Old', ship: { cls: 'coaster', lat: 51.98, lon: 4.03, hdg: 0, spd: 0, throttle: 0, rudder: 0 }, cond: 90, flooding: 0, fuel: 50, cargo: [], money: 1000, wanted: 0, wantedAt: 0, kits: 0, jobs: [], convoyId: null, docked: 'rotterdam', stats: { delivered: 1 } }],
  };
  fs.writeFileSync(file, JSON.stringify(old));
  const g = new Game(world, () => {}, { stateFile: file });
  const st = g.harbors.rotterdam; assert.ok(st.stock.grain > 0 && st.target.grain > 0 && st.market.grain > 0 && st.used.length >= 1);
  const p = g.players.get('t1');
  assert.equal(p.berth, null); assert.ok(p.serviceDue > g.simTime); assert.equal(p.stats.collisions, 0); assert.equal(p.stats.delivered, 1); assert.ok(p.dockedAt > 0);
  p.berth = { harbor: 'rotterdam', id: 'rotterdam-b1', name: 'Berth 1' }; p.stats.collisions = 2; p.serviceDue = 123456789;
  g.saveState();
  const g2 = new Game(world, () => {}, { stateFile: file });
  const q = g2.players.get('t1'); assert.equal(q.berth.id, 'rotterdam-b1'); assert.equal(q.stats.collisions, 2); assert.equal(q.serviceDue, 123456789);
  assert.ok(Math.abs(g2.harbors.rotterdam.stock.grain - st.stock.grain) <= 1); assert.deepEqual(g2.harbors.rotterdam.target, st.target);
  // an assist interrupted by a restart completes at its berth
  const b1 = mkBerth('rotterdam-b1', 'Berth 1', 90, 300);
  q.docked = null; q.berth = null; q.assist = { harbor: 'rotterdam', berthId: 'rotterdam-b1', from: { lat: 51.98, lon: 4.0, hdg: 90 }, to: { lat: b1.lat, lon: b1.lon, hdg: 45 }, start: 0, until: 1 };
  g2.saveState();
  const g3 = new Game(world, () => {}, { stateFile: file, harborgeom: fakeGeom('rotterdam', [b1]) });
  const r = g3.players.get('t1'); assert.equal(r.assist, null); assert.equal(r.docked, 'rotterdam'); assert.equal(r.berth.id, 'rotterdam-b1'); assert.equal(r.ship.lat, b1.lat);
  fs.rmSync(dir, { recursive: true, force: true });
});
test('public job boards carry pay per tonne, destination names, ship-hour budgets and harbour positions', () => {
  const g = mkGame(); const jobs = g.publicJobs();
  const r = jobs.harbors.find((h) => h.id === 'rotterdam');
  assert.ok(r.harbor.lat === ROT.lat && r.harbor.name === ROT.name && r.harbor.size === 'mega' && r.lat === ROT.lat && r.name === ROT.name);
  assert.ok(r.jobs.length >= 3 && r.fuel > 0 && r.trend);
  for (const j of r.jobs) {
    for (const k of ['pay', 'payPerT', 'type', 'distKm', 'to', 'toName', 'hours', 'expiresAt', 'needsCat', 'good', 'qty', 'pax', 'title']) assert.ok(k in j, `${j.type} has ${k}`);
    assert.ok(!('deadline' in j), 'V6 item 5: ship-hour budgets replace world-clock deadlines');
    assert.equal(j.toName, harborById(j.to).name);
    if (j.qty) assert.equal(j.payPerT, Math.round(j.pay / j.qty)); else if (j.pax) assert.equal(j.payPerT, Math.round(j.pay / j.pax));
  }
});
test('used-ship listings refresh every 6 h and carry specs; rescues and tows use the harbour anchor', () => {
  const anchor = destination(ROT.lat, ROT.lon, 180, 1500);
  const g = mkGame({ harborgeom: fakeGeom('rotterdam', [], { anchor }) }); const { p } = join(g, 'Mo');
  const st = g.harbors.rotterdam; const first = st.used.map((u) => u.id).join();
  assert.ok(st.used.length >= 1 && st.used.length <= 4 && st.used[0].specs.maxKn > 0);
  g.regenHarbor(ROT, st, false); assert.equal(st.used.map((u) => u.id).join(), first, 'no refresh inside 6 h');
  st.usedAt = g.simTime - 7 * 3600; g.regenHarbor(ROT, st, false); assert.notEqual(st.used.map((u) => u.id).join(), first, 'refreshed after 6 h');
  g.onAction(p, { action: 'undock' });
  assert.ok(Math.abs(p.ship.lat - anchor.lat) < 1e-9, 'undock at the geometry anchor');
  p.cond = 0; p.flooding = 1; p.money = 5000; g.tick(0.1);
  assert.ok(Math.abs(g.rescues[0].lat - anchor.lat) < 1e-9, 'lifeboat launches from the anchor');
  g.rescues[0].eta = Date.now() - 1; g.updateRescues(0.1);
  assert.equal(p.docked, 'rotterdam'); assert.ok(Math.abs(p.ship.lat - anchor.lat) < 1e-9, 'landed at the anchor');
});
test('heave to: a ship stopping with the engine on STOP or astern gets one grace period before the pursuit', () => {
  const g = mkGame(); const { p, ws } = join(g, 'Halt');
  g.onAction(p, { action: 'undock' });
  const c = g.cutters[0]; g.hail(c, p); p.ship.lat = c.lat; p.ship.lon = c.lon;
  p.ship.spd = 8; p.ship.throttle = -0.6; c.timer = 0;
  g.updateCutters(0.1);
  assert.equal(c.state, 'hail', 'still waiting, not pursuing'); assert.equal(p.wanted, 0); assert.ok(p.hail.extended);
  assert.ok(events(ws).some((t) => /seconds more/.test(t)));
  p.ship.spd = 1; c.timer = 0; g.updateCutters(0.1);
  assert.equal(c.state, 'inspect');
  // a second time, or with the engine still ahead, there is no grace
  const g2 = mkGame(); const b = join(g2, 'Run'); g2.onAction(b.p, { action: 'undock' });
  const c2 = g2.cutters[0]; g2.hail(c2, b.p); b.p.ship.lat = c2.lat; b.p.ship.lon = c2.lon;
  b.p.ship.spd = 8; b.p.ship.throttle = 0.5; c2.timer = 0; g2.updateCutters(0.1);
  assert.equal(c2.state, 'pursue');
});
