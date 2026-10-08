// v6 fleet: switching ships — checks, the transfer fee, what the ship you leave does (docs/V6-FLEET-CONTRACTS.md §8,
// §14.1 fleet-switch).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeGame, events, last, harborById } from './fleet-helpers.mjs';
import { dayKey, FLEET } from '../shared/fleet.js';
import { destination, haversine } from '../shared/geo.js';
import { spotProblem, separation } from '../server/safespot.js';
import { SHIP_CLASSES } from '../shared/constants.js';

const PHASE2 = { skip: 'needs game.js wiring (phase 2)' };
function setup(o = {}) { const g = new FakeGame(o); const j = g.join('Ann', { money: 100000 }); return { g, f: g.fleet, ...j }; }
const cool = (p) => { p.office.lastSwitchAt = 0; };

test('same harbour: free, aboard changes, `you` says switched + correction, warp reset; 10 s cooldown', () => {
  const { g, f, p, ws } = setup();
  const tr = g.addVessel(p, { cls: 'trawler' }), co = p.vessel;
  p.warp = 5; const m = p.money;
  f.onAction(p, { action: 'switch_ship', vesselId: tr.id });
  assert.equal(p.aboard, tr.id); assert.equal(p.ship.cls, 'trawler'); assert.equal(p.money, m); assert.equal(p.warp, 1);
  const y = last(ws, 'you'); assert.equal(y.switched, true); assert.equal(y.correction, true); assert.equal(y.you.aboard, tr.id);
  assert.equal(tr.orders, null); assert.equal(tr.cap, null);
  assert.equal(co.orders, null, 'the coaster stays moored, idle'); assert.equal(co.cap.phase, 'idle');
  assert.ok(events(ws).some((t) => /^You took the helm of Kittiwake — moored|^You took the helm of Kittiwake — in Rotterdam/.test(t)), events(ws).join('\n'));
  p.office.lastSwitchAt = Date.now() - 5000;
  f.onAction(p, { action: 'switch_ship', vesselId: co.id });
  assert.equal(p.aboard, tr.id); assert.equal(events(ws).at(-1), 'One moment — the launch is still coming back.');
  p.office.lastSwitchAt = Date.now() - 10001;
  f.onAction(p, { action: 'switch_ship', vesselId: co.id }); assert.equal(p.aboard, co.id);
  f.onAction(p, { action: 'switch_ship', vesselId: co.id }); // already aboard: ignored silently
});

test('remote: a launch 100 km out costs 450, booked as fees to the target', () => {
  const { g, f, p, ws } = setup();
  const at = destination(p.ship.lat, p.ship.lon, 270, 100000);
  const tr = g.addVessel(p, { cls: 'trawler', at }); tr.cap.phase = 'anchored';
  const m = p.money; f.onAction(p, { action: 'switch_ship', vesselId: tr.id });
  assert.equal(p.money, m - 450); assert.equal(p.aboard, tr.id);
  assert.equal(p.office.book.days[dayKey(g.simTime)][tr.id].fees, -450);
  assert.ok(events(ws).some((t) => /The launch cost 450 cr/.test(t)));
  // not enough cash
  cool(p); const far = g.addVessel(p, { cls: 'pilot', at: destination(p.ship.lat, p.ship.lon, 0, 182000) });
  p.money = 300; f.m0.set(p.id, 300);
  f.onAction(p, { action: 'switch_ship', vesselId: far.id });
  assert.equal(events(ws).at(-1), `A launch out to ${far.name} (182 km) costs 614 cr. You have 300.`);
});

test('leaving at sea with no order and no route: she holds at a safe spot clear of other hulls', async () => {
  const depthLW = () => 35;
  const { g, f, p } = setup({ depthLW, world: { isWater: () => true, depthAt: () => 36 } });
  const sea = { lat: 53.4, lon: 3.6 };                                   // ~30 km off the Dutch coast
  g.undock(p); Object.assign(p.ship, { lat: sea.lat, lon: sea.lon, hdg: 90, spd: 10, throttle: 0.7 });
  const old = p.vessel;
  const tr = g.addVessel(p, { cls: 'trawler', harbor: 'rotterdam' });
  const other = g.addVessel(p, { cls: 'feeder', at: destination(sea.lat, sea.lon, 0, 200) }); other.cap.phase = 'anchored'; other.orders = { type: 'hold' };
  f.onAction(p, { action: 'switch_ship', vesselId: tr.id });
  assert.deepEqual(old.orders, { type: 'hold' });
  await f.advance(old, 600);
  assert.ok(['anchored', 'holding'].includes(old.cap.phase), old.cap.phase);
  assert.equal(old.cap.phase, 'anchored', '35 m at low water: anchored');
  const C = SHIP_CLASSES.coaster;
  const others = [{ lat: other.ship.lat, lon: other.ship.lon, len: SHIP_CLASSES.feeder.length }];
  assert.equal(spotProblem(old.ship.lat, old.ship.lon, { draft: C.draft, length: C.length, depthLW, others }), null);
  assert.ok(haversine(old.ship.lat, old.ship.lon, other.ship.lat, other.ship.lon) >= separation(C.length));
  assert.equal(old.ship.spd, 0);
});

test('leaving near a harbour, with an order, with a route', () => {
  const { g, f, p } = setup();
  const ij = harborById('ijmuiden');
  const tr = g.addVessel(p, { cls: 'trawler', harbor: 'rotterdam' });
  g.undock(p); Object.assign(p.ship, destination(ij.lat, ij.lon, 280, 3000));
  const co = p.vessel;
  f.onAction(p, { action: 'switch_ship', vesselId: tr.id });
  assert.deepEqual(co.orders, { type: 'sail_to', harbor: 'ijmuiden', then: 'moor' });
  // back aboard the coaster, leave the trawler (docked) with a home order; then the coaster with a route
  cool(p); co.cap = null;
  f.onAction(p, { action: 'switch_ship', vesselId: co.id }); assert.equal(p.aboard, co.id);
  cool(p); const pb = g.addVessel(p, { cls: 'pilot', harbor: 'ijmuiden' }); g.undock(f.actorOf(pb));
  Object.assign(pb.ship, destination(ij.lat, ij.lon, 270, 30000)); pb.orders = { type: 'hold' }; pb.cap.phase = 'anchored';
  f.onAction(p, { action: 'switch_ship', vesselId: pb.id, leave: { type: 'home' } });
  assert.deepEqual(co.orders, { type: 'home', then: 'moor' });
  cool(p); co.cap.phase = 'anchored';
  f.onAction(p, { action: 'switch_ship', vesselId: co.id, leave: { type: 'route', route: [[52.5, 3.9], [52.4, 4.2], [52.46, 4.5]], harbor: 'ijmuiden' } });
  assert.equal(pb.orders.type, 'route'); assert.equal(pb.orders.route.length, 3); assert.equal(pb.cap.phase, 'sailing', 'a route sails on at once');
  cool(p);
  f.onAction(p, { action: 'switch_ship', vesselId: pb.id, leave: { type: 'sail_to', harbor: 'ijmuiden', then: 'lay_up' } });
  assert.notEqual(co.orders?.then, 'lay_up', 'lay_up only to the home: the default instead');
});

test('leaving with a tow on the line → sail to the tow\'s port; with nets out and a fishing contract → keep fishing', () => {
  const { g, f, p } = setup();
  const tr = g.addVessel(p, { cls: 'trawler', harbor: 'rotterdam' });
  g.undock(p); Object.assign(p.ship, { lat: 54.0, lon: 3.0 });
  p.jobs.push({ id: 'jtw', type: 'tow', title: 'Tow to Hull', to: 'hull', pickedUp: true, victimCls: 'trawler' }); p.towing = 'jtw';
  const co = p.vessel;
  f.onAction(p, { action: 'switch_ship', vesselId: tr.id });
  assert.deepEqual(co.orders, { type: 'sail_to', harbor: 'hull', then: 'moor' });
  // nets out on the Dogger Bank with a fishing contract
  cool(p); const fv = g.addVessel(p, { cls: 'trawler', at: { lat: 54.7, lon: 2.8 } }); fv.orders = { type: 'hold' }; fv.cap.phase = 'anchored';
  f.onAction(p, { action: 'switch_ship', vesselId: fv.id });
  cool(p); g.undock(f.actorOf(tr));
  p.jobs.push({ id: 'jfi', type: 'fishing', title: 'Catch 30 t', to: 'rotterdam', ground: 'dogger', qty: 30, dueShip: p.shipTime + 86400 });
  g.setFishing(p, true); assert.equal(p.fishing, true);
  f.onAction(p, { action: 'switch_ship', vesselId: tr.id });
  assert.deepEqual(fv.orders, { type: 'contract', jobId: 'jfi', then: 'stay' }); assert.equal(fv.fishing, true, 'nets stay out');
});

test('refusals: hailed, raft, tugs (either ship), laid up, flooding, someone else\'s ship (every fleet action)', () => {
  const { g, f, p, ws } = setup();
  const tr = g.addVessel(p, { cls: 'trawler' });
  const tries = [
    [() => { p.hail = { cutter: 'X' }; }, 'Not with the coast guard on the radio.', () => { p.hail = null; }],
    [() => { p.rescue = { id: 'r1' }; }, 'You are in the life raft.', () => { p.rescue = null; }],
    [() => { p.assist = { harbor: 'rotterdam' }; }, 'The tugs have her — wait until she is alongside.', () => { p.assist = null; }],
    [() => { tr.assist = { harbor: 'rotterdam' }; }, 'The tugs have her — wait until she is alongside.', () => { tr.assist = null; }],
    [() => { p.flooding = 0.6; }, 'Not now — she is taking water. Patch the hull (K) first.', () => { p.flooding = 0; }],
    [() => { tr.status = 'laidup'; }, 'Kittiwake is laid up — recommission her first.', () => { tr.status = 'active'; }],
  ];
  for (const [set, text, reset] of tries) {
    set(); f.onAction(p, { action: 'switch_ship', vesselId: tr.id }); reset();
    assert.equal(p.aboard, p.fleet[0].id); assert.equal(events(ws).at(-1), text);
  }
  const { p: bob } = g.join('Bob'); const bv = g.addVessel(bob, { cls: 'trawler' });
  const snapshot = JSON.stringify(bob.fleet);
  for (const m of [{ action: 'switch_ship', vesselId: bv.id }, { action: 'fleet_order', vesselId: bv.id, order: { type: 'stop' } }, { action: 'fleet_sell', vesselId: bv.id },
    { action: 'fleet_rename', vesselId: bv.id, name: 'Mine Now' }, { action: 'fleet_layup', vesselId: bv.id }, { action: 'fleet_transfer', fromId: p.aboard, toId: bv.id, good: 'grain', qty: 1 },
    { action: 'fleet_recommission', vesselId: bv.id }, { action: 'fleet_service', vesselId: bv.id, what: 'fuel' }, { action: 'fleet_accept', vesselId: bv.id, jobId: 'j1' }]) {
    f.onAction(p, m); assert.equal(events(ws).at(-1), 'That is not your ship.', m.action);
  }
  assert.equal(JSON.stringify(bob.fleet), snapshot);
});

test('the HQ helm button: fee and reason come from the same check', () => {
  const { g, f, p } = setup();
  const tr = g.addVessel(p, { cls: 'trawler', at: destination(p.ship.lat, p.ship.lon, 270, 150000) });
  const vv = f.vesselView(p, tr);
  assert.equal(vv.can.helm, true); assert.equal(vv.can.helmFee, 550);
  p.hail = { cutter: 'X' }; assert.equal(f.vesselView(p, tr).can.helm, 'Not with the coast guard on the radio.');
  void FLEET;
});

test('real game: `state` with the old vessel id after a switch is ignored', PHASE2, async () => {
  const { Game } = await import('../server/game.js');
  const { World } = await import('../server/world.js');
  const { carvingsForWorld } = await import('../server/harbors.js');
  process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
  const g = new Game(new World().load(carvingsForWorld(), () => {}), () => {}, { stateFile: '/nonexistent/saltline-fleet-switch.json' }); g.saveState = () => {};
  const p = g.connect({ readyState: 1, sent: [], send() {}, close() {} }, null, 'Ann');
  p.money = 1e6; g.fleet.m0.set(p.id, p.money);
  const old = p.aboard;
  g.onAction(p, { action: 'buy_ship', cls: 'trawler', tradeIn: false });
  g.onAction(p, { action: 'switch_ship', vesselId: p.fleet[1].id });
  g.onAction(p, { action: 'undock' });
  const lat = p.ship.lat;
  g.onState(p, { vid: old, lat: lat + 0.001, lon: p.ship.lon, hdg: 0, spd: 1 });
  assert.equal(p.ship.lat, lat); assert.ok(!p.rejects);
});
test('real game: switch through onAction, then the old ship is stepped by her captain in g.tick', PHASE2, async () => {
  const { Game } = await import('../server/game.js');
  const { World } = await import('../server/world.js');
  const { carvingsForWorld } = await import('../server/harbors.js');
  process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
  const g = new Game(new World().load(carvingsForWorld(), () => {}), () => {}, { stateFile: '/nonexistent/saltline-fleet-switch2.json' }); g.saveState = () => {};
  const p = g.connect({ readyState: 1, sent: [], send() {}, close() {} }, null, 'Ann');
  p.money = 1e6; g.tick(0.1);
  g.onAction(p, { action: 'buy_ship', cls: 'trawler', tradeIn: false });
  const co = p.vessel;
  g.onAction(p, { action: 'switch_ship', vesselId: p.fleet[1].id });
  assert.equal(p.ship.cls, 'trawler'); assert.equal(co.cap.phase, 'idle');
  for (let i = 0; i < 20; i++) g.tick(0.1);
  assert.ok(co.shipTime > g.simTime - 10);
});
