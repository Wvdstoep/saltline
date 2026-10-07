import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { carvingsForWorld, harborById } from '../server/harbors.js';
import { Game } from '../server/game.js';
import { SHIP_CLASSES, LAW } from '../shared/constants.js';

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
  assert.equal(p.docked, dest.id); assert.equal(p.jobs.length, 0); assert.equal(p.cargo.length, 0); assert.equal(p.money, m0 + job.pay);
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
test('sinking creates a persistent wreck with the cargo and respawns the player', () => {
  const g = mkGame(); const { p, ws } = join(g, 'Eve');
  g.onAction(p, { action: 'undock' });
  p.cargo.push({ good: 'steel', qty: 100, contraband: false, jobId: null });
  p.cond = 0; p.flooding = 1; p.money = 10000;
  g.tick(0.1);
  assert.equal(g.wrecks.length, 1); assert.equal(g.wrecks[0].cargo[0].qty, 100);
  assert.ok(p.docked); assert.equal(p.flooding, 0); assert.equal(p.money, 8000);
  // salvage by another player
  const { p: q } = join(g, 'Fay'); g.onAction(q, { action: 'undock' });
  q.ship.lat = g.wrecks[0].lat; q.ship.lon = g.wrecks[0].lon; q.ship.spd = 0;
  g.onAction(q, { action: 'salvage', wreckId: g.wrecks[0].id });
  assert.equal(q.cargo[0].qty, 100); assert.equal(g.wrecks.length, 0);
});
test('fuel burns under way and the engine stops when empty', () => {
  const g = mkGame(); const { p } = join(g, 'Gus');
  g.onAction(p, { action: 'undock' }); p.ship.throttle = 1; p.ship.spd = 14; p.fuel = 0.001;
  g.tick(1);
  assert.equal(p.fuel, 0); assert.equal(g.privateState(p).fuelEmpty, true);
});
test('implausible position jumps are rejected', () => {
  const g = mkGame(); const { p, ws } = join(g, 'Hal');
  g.onAction(p, { action: 'undock' });
  const lat = p.ship.lat;
  g.onState(p, { lat: lat + 2, lon: p.ship.lon, hdg: 0, spd: 5, throttle: 0.5, rudder: 0 });
  assert.equal(p.ship.lat, lat);
  g.onState(p, { lat: lat + 0.0005, lon: p.ship.lon, hdg: 10, spd: 5, throttle: 0.5, rudder: 0 });
  assert.equal(p.ship.lat, lat + 0.0005);
  g.onState(p, { lat: 'x', lon: null }); assert.ok(Number.isFinite(p.ship.lat));
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
