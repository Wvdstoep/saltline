import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { carvingsForWorld, harborById } from '../server/harbors.js';
import { Game } from '../server/game.js';
import { SHIP_CLASSES, LAW, GOODS } from '../shared/constants.js';

process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
const world = new World().load(carvingsForWorld(), () => {});
function fakeSocket() { const s = { readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); }, close() {} }; return s; }
function mkGame() { const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-test-state.json' }); g.saveState = () => {}; return g; }
function join(g, name) { const ws = fakeSocket(); const p = g.connect(ws, null, name); return { p, ws }; }
const last = (ws, t) => [...ws.sent].reverse().find((m) => m.t === t);
const events = (ws) => ws.sent.filter((m) => m.t === 'event').map((m) => m.text);

test('new players spawn docked at Rotterdam with the starter coaster', () => {
  const g = mkGame(); const { p, ws } = join(g, 'Ann');
  assert.equal(p.docked, 'rotterdam'); assert.equal(p.ship.cls, 'coaster'); assert.equal(p.money, 25000);
  assert.equal(last(ws, 'welcome').world.harbors.length > 80, true);
  assert.ok(last(ws, 'harbor').harbor.jobs.length >= 3);
});
test('accepting freight loads cargo, delivering at the destination pays', () => {
  const g = mkGame(); const { p, ws } = join(g, 'Bob');
  const job = g.harbors.rotterdam.jobs.find((j) => j.type === 'freight' && j.qty <= 1200);
  g.onAction(p, { action: 'accept_job', jobId: job.id });
  assert.equal(p.jobs.length, 1); assert.equal(p.cargo[0].qty, job.qty);
  // teleport to destination and dock
  g.onAction(p, { action: 'undock' });
  const dest = harborById(job.to); p.ship.lat = dest.lat; p.ship.lon = dest.lon; p.ship.spd = 0;
  const m0 = p.money; g.onAction(p, { action: 'dock' });
  assert.equal(p.docked, dest.id); assert.equal(p.jobs.length, 0); assert.equal(p.cargo.length, 0);
  assert.ok(p.money > m0 + job.pay * 0.9 && p.money <= m0 + job.pay, 'paid minus port dues');
});
test('contract cargo cannot be sold; free cargo can', () => {
  const g = mkGame(); const { p } = join(g, 'Cid');
  g.onAction(p, { action: 'buy_goods', good: 'grain', qty: 10 });
  const m = p.money; g.onAction(p, { action: 'sell_goods', good: 'grain', qty: 10 });
  assert.ok(p.money > m); assert.equal(p.cargo.length, 0);
  const job = g.harbors.rotterdam.jobs.find((j) => j.type === 'freight' && j.qty <= 1200);
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
  const job = g.harbors.rotterdam.jobs.find((j) => j.type === 'freight' && j.qty <= 1200);
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
