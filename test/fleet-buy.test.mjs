// v6 fleet: buying without a forced trade-in, selling fleet ships (docs/V6-FLEET-CONTRACTS.md §5, §14.1 fleet-buy).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeGame, last, events, harborById } from './fleet-helpers.mjs';
import { dayKey, FLEET } from '../shared/fleet.js';
import { spotProblem } from '../server/safespot.js';
import { destination } from '../shared/geo.js';
import { SHIP_CLASSES } from '../shared/constants.js';
import { berthFeePerDay } from '../server/economy.js';

const PHASE2 = {};
const ROT = harborById('rotterdam');
function rich(o) { const g = new FakeGame(o); const j = g.join('Ann', { money: 200000 }); return { g, ...j, f: g.fleet }; }
const book = (p, g, vid) => (p.office.book.days[dayKey(g.simTime)] || {})[vid] || {};

test('buy_ship with tradeIn:false: a Stern trawler delivered here, 25 % fuel, money exact, the coaster stays', () => {
  const { g, p, ws, f } = rich();
  f.buyShip(p, { action: 'buy_ship', cls: 'trawler', tradeIn: false });
  assert.equal(p.money, 20000); assert.equal(p.fleet.length, 2);
  const v = p.fleet[1];
  assert.equal(v.docked, 'rotterdam'); assert.equal(v.ship.cls, 'trawler'); assert.equal(v.cond, 100); assert.equal(v.fuel, 10); assert.equal(v.name, 'Kittiwake');
  assert.equal(p.ship.cls, 'coaster', 'still aboard the coaster'); assert.equal(v.acquiredPrice, 180000);
  assert.equal(book(p, g, v.id).ships, -180000);
  assert.ok(events(ws).some((t) => /Took delivery of a Stern trawler, Kittiwake, .*Your Coastal freighter stays yours\./.test(t)), events(ws).join('\n'));
  assert.equal(last(ws, 'fleet').fleet.n, 2);
});

test('buy_ship without the field keeps today\'s trade-in path (and records the traded hull)', () => {
  const { g, p, f } = rich();
  f.buyShip(p, { action: 'buy_ship', cls: 'trawler' });
  assert.equal(p.money, 20000, '200,000 − 180,000 + coaster trade-in 0'); assert.equal(p.fleet.length, 1); assert.equal(p.ship.cls, 'trawler');
  assert.equal(p.office.lost[0].how, 'traded'); assert.equal(p.office.lost[0].cls, 'coaster');
  f.buyShip(p, { action: 'buy_ship', cls: 'pilot', tradeIn: true });
  assert.equal(p.ship.cls, 'pilot'); void g;
});

test('buy_used with tradeIn:false: listing price, listing condition, listing gone', () => {
  const { g, p, f } = rich();
  g.harbors.rotterdam.used = [{ id: 'u1', cls: 'tug', cond: 64, price: 150000, name: 'Harbour tug' }];
  f.buyUsed(p, { listingId: 'u1', tradeIn: false, name: 'Good Hope' });
  assert.equal(p.money, 50000); assert.equal(p.fleet[1].cond, 64); assert.equal(p.fleet[1].name, 'Good Hope'); assert.equal(g.harbors.rotterdam.used.length, 0);
  assert.ok(p.fleet[1].serviceDue < g.simTime + 30 * 86400, 'a used hull is part-way through her service interval');
  f.buyUsed(p, { listingId: 'u1', tradeIn: false });
  assert.equal(p.fleet.length, 2, 'a sold listing is refused');
});

test('refusals: fleet full (8), unpaid bills, not enough cash, at sea, unknown class; names fall back to the defaults', () => {
  const { g, p, ws, f } = rich();
  p.money = 5e6; f.m0.set(p.id, p.money);
  for (let i = 0; i < 7; i++) f.buyNew(p, { cls: 'pilot', name: i === 0 ? 'Sea Bee' : i === 1 ? '<b>' : undefined });
  assert.equal(p.fleet.length, 8);
  assert.equal(p.fleet[1].name, 'Kittiwake', 'a name already in the fleet → the next default');
  assert.equal(p.fleet[2].name, 'North Star', 'an invalid name → the next default');
  const m = p.money; f.buyNew(p, { cls: 'pilot' });
  assert.equal(p.money, m); assert.equal(events(ws).at(-1), 'Your fleet is full (8 ships and orders). Sell or trade in a ship first.');   // SHIPYARD Q3: open orders count
  const { p: q, ws: qs, f: f2 } = rich();
  q.office.owed = 30; f2.buyNew(q, { cls: 'trawler' });
  assert.equal(q.fleet.length, 1); assert.match(events(qs).at(-1), /unpaid bills first \(30 cr\)/);
  q.office.owed = 0; q.money = 25000; f2.buyNew(q, { cls: 'trawler' });
  assert.equal(events(qs).at(-1), 'A Stern trawler costs 180,000 cr. You have 25,000.');
  f2.buyNew(q, { cls: 'coaster' }); assert.match(events(qs).at(-1), /does not build/);
  q.docked = null; q.money = 1e6; f2.buyNew(q, { cls: 'trawler' }); assert.equal(q.fleet.length, 1);
  void g;
});

test('with every fitting berth taken the new ship lies at a safe lay-by spot at the anchorage', () => {
  const b1 = { id: 'rot-b1', name: 'Berth 1', ...destination(ROT.lat, ROT.lon, 90, 300), hdg: 45, depth: 12, length: 200, kind: 'quay' };
  const b2 = { id: 'rot-b2', name: 'Berth 2', ...destination(ROT.lat, ROT.lon, 90, 600), hdg: 45, depth: 12, length: 200, kind: 'quay' };
  const geom = { berths: [b1, b2], anchor: { lat: ROT.lat, lon: ROT.lon }, fairway: [] };
  const depthLW = (lat) => (lat > ROT.lat + 0.02 ? 20 : 15);
  const { g, p, f } = rich({ geom: (id) => (id === 'rotterdam' ? geom : null), depthLW });
  p.vessel.berth = { harbor: 'rotterdam', id: 'rot-b1', name: 'Berth 1' }; p.money = 1e6;
  const a = f.buyNew(p, { cls: 'trawler' });
  assert.equal(a.berth.id, 'rot-b2', 'the free fitting berth'); assert.equal(a.ship.lat, b2.lat);
  const b = f.buyNew(p, { cls: 'pilot' });
  assert.equal(b.berth, null); assert.equal(b.docked, 'rotterdam');
  const others = [p.ship, a.ship].map((s) => ({ lat: s.lat, lon: s.lon, len: SHIP_CLASSES[s.cls].length }));
  assert.equal(spotProblem(b.ship.lat, b.ship.lon, { draft: SHIP_CLASSES.pilot.draft, length: SHIP_CLASSES.pilot.length, depthLW, others }), null);
  assert.deepEqual([...f.berthsTaken('rotterdam')].sort(), ['rot-b1', 'rot-b2']);
  void g;
});

test('sendHome: the new ship is ordered home at once', () => {
  const g = new FakeGame(); const { p, ws } = g.join('Ann', { money: 500000, harbor: 'ijmuiden' }); const f = g.fleet;
  p.office.home = 'rotterdam';
  const v = f.buyNew(p, { cls: 'trawler', sendHome: true });
  assert.deepEqual(v.orders, { type: 'home', then: 'moor' });
  assert.ok(events(ws).some((t) => /Kittiwake: orders received|Took delivery/.test(t)));
});

test('fleet_sell: shipValue for a fleet ship; never the aboard one, nor with cargo; berth days first; the coaster is scrapped', () => {
  const { g, p, ws, f } = rich();
  const tr = f.buyNew(p, { cls: 'trawler' });
  const m0 = p.money;
  f.onAction(p, { action: 'fleet_sell', vesselId: p.aboard });
  assert.equal(p.money, m0); assert.match(events(ws).at(-1), /You are aboard Sea Bee/);
  tr.cargo.push({ good: 'grain', qty: 5, contraband: false, jobId: null });
  f.onAction(p, { action: 'fleet_sell', vesselId: tr.id });
  assert.equal(p.money, m0); assert.match(events(ws).at(-1), /Unload her first \(5 t aboard\)/);
  tr.cargo = [];
  f.onAction(p, { action: 'fleet_sell', vesselId: tr.id });
  assert.equal(p.money, m0 + 99000, 'at home: no berth fee'); assert.equal(p.fleet.length, 1); assert.equal(p.office.lost.at(-1).how, 'sold');
  assert.ok(!f.vessels.has(tr.id));
  assert.ok(events(ws).some((t) => t === 'Sold Kittiwake (Stern trawler, 100 %) for 99,000 cr.'));
  // a coaster (not aboard) is scrapped for 0
  const co = g.addVessel(p, { cls: 'coaster', harbor: 'rotterdam' });
  f.onAction(p, { action: 'fleet_sell', vesselId: co.id });
  assert.equal(p.office.lost.at(-1).how, 'scrapped'); assert.match(events(ws).at(-1), /^Scrapped .* \(the yard pays nothing for a coastal freighter\)\.$/);
  // a trawler moored 2 days and 1 hour at IJmuiden: 3 started days of berth fee first
  const t2 = g.addVessel(p, { cls: 'trawler', harbor: 'ijmuiden' }); t2.dockedAt = g.simTime - (2 * 86400 + 3600);
  assert.equal(berthFeePerDay('trawler'), 18);
  const m1 = p.money; f.onAction(p, { action: 'fleet_sell', vesselId: t2.id });
  assert.equal(p.money, m1 - 54 + 99000);
  assert.equal(book(p, g, t2.id).port, -54);
  // someone else's ship
  const { p: bob } = g.join('Bob'); const bv = g.addVessel(bob, { cls: 'trawler' });
  f.onAction(p, { action: 'fleet_sell', vesselId: bv.id });
  assert.equal(events(ws).at(-1), 'That is not your ship.'); assert.ok(bob.fleet.includes(bv));
});

// ------------------------------------------------------------------------------------------- phase 2: the real Game
async function realGame() {
  const { Game } = await import('../server/game.js');
  const { World } = await import('../server/world.js');
  const { carvingsForWorld } = await import('../server/harbors.js');
  process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
  const world = new World().load(carvingsForWorld(), () => {});
  const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-fleet-buy.json' }); g.saveState = () => {}; g.rnd = () => 0.5;
  const ws = { readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); }, close() {} };
  const p = g.connect(ws, null, 'Ann'); p.money = 200000; g.tick(0.1);
  return { g, p, ws };
}
test('real game: buy_ship tradeIn:false through onAction', PHASE2, async () => {
  const { g, p } = await realGame();
  g.onAction(p, { action: 'buy_ship', cls: 'trawler', tradeIn: false });
  assert.equal(p.money, 20000); assert.equal(p.fleet.length, 2); assert.equal(p.fleet[1].fuel, 10); assert.equal(p.ship.cls, 'coaster');
});
test('real game: buy_ship without tradeIn is today\'s trade-in', PHASE2, async () => {
  const { g, p } = await realGame();
  g.onAction(p, { action: 'buy_ship', cls: 'trawler' });
  assert.equal(p.money, 20000); assert.equal(p.fleet.length, 1); assert.equal(p.ship.cls, 'trawler');
});
test('real game: buy_used tradeIn:false', PHASE2, async () => {
  const { g, p } = await realGame();
  const l = g.harbors.rotterdam.used[0];
  p.money = l.price + 10;
  g.onAction(p, { action: 'buy_used', listingId: l.id, tradeIn: false });
  assert.equal(p.money, 10); assert.equal(p.fleet[1].cond, l.cond); assert.ok(!g.harbors.rotterdam.used.includes(l));
});
test('real game: the harbour sheet carries office, fleetHere, fleetFull', PHASE2, async () => {
  const { g, p, ws } = await realGame();
  g.sendHarbor(p);
  const h = [...ws.sent].reverse().find((m) => m.t === 'harbor').harbor;
  assert.equal(h.office.isHome, true); assert.equal(h.fleetHere.length, 1); assert.equal(h.fleetFull, false); assert.equal(h.fleetN, 1);
  assert.equal(FLEET.MAX_VESSELS, 8);
});
