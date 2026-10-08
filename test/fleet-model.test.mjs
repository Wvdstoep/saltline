// v6 fleet: the vessel model, migration, save format, the small ledger and the client fixture
// (docs/V6-FLEET-CONTRACTS.md §3, §14.1 fleet-model). Phase 1 runs on test/fleet-helpers.mjs FakeGame; the tests marked
// "needs game.js wiring (phase 2)" use the real Game and run once server/game.js carries the §11.2 hooks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FakeGame, T0, last, harborById } from './fleet-helpers.mjs';
import { VESSEL_KEYS } from '../server/vessel.js';
import { VESSEL_ID_RE, FLEET, dayKey, stateOf } from '../shared/fleet.js';
import { newCap, fishLoop } from '../server/captain.js';
import { FISHING_GROUNDS } from '../server/harbors.js';
import { destination } from '../shared/geo.js';

const PHASE2 = {};
const save = (p) => JSON.parse(JSON.stringify({ ...p, hail: null, online: false, warp: 1, warpRouted: false, warpGraceUntil: 0, warpGraceFactor: 1 }));
const OLD = () => ({ id: 'p1', token: 't1', name: 'Old', ship: { cls: 'coaster', lat: 51.98, lon: 4.03, hdg: 0, spd: 0, throttle: 0, rudder: 0 }, cond: 90, flooding: 0, fuel: 50, cargo: [{ good: 'grain', qty: 40, contraband: false, jobId: null }], money: 1000, wanted: 0, wantedAt: 0, kits: 0, jobs: [], convoyId: null, docked: 'rotterdam', stats: { delivered: 1 } });
function load(g, rec) { g.fleet.adoptPlayer(rec); g.migratePlayer(rec); g.players.set(rec.token, rec); g.byId.set(rec.id, rec); return rec; }

test('a new player gets a fleet of one: Sea Bee, home Rotterdam, 3 storage places; ship fields are accessors', () => {
  const g = new FakeGame(); const { p } = g.join('Ann');
  assert.equal(p.fleet.length, 1); assert.ok(VESSEL_ID_RE.test(p.aboard)); assert.equal(p.vessel, p.fleet[0]);
  assert.equal(p.ship, p.fleet[0].ship); assert.equal(p.office.home, 'rotterdam'); assert.equal(p.office.slots, 3); assert.equal(p.fleet[0].name, 'Sea Bee');
  for (const k of VESSEL_KEYS) assert.ok(!Object.keys(p).includes(k), `${k} is not an own enumerable key of the person`);
  const j = JSON.parse(JSON.stringify(p));
  assert.equal(j.fleet[0].ship.cls, 'coaster'); assert.equal(j.ship, undefined);
  p.cargo = [{ good: 'fish', qty: 1, jobId: null }]; p.docked = null; p.ship.lat = 52;
  assert.equal(p.fleet[0].cargo[0].good, 'fish'); assert.equal(p.fleet[0].docked, null); assert.equal(p.fleet[0].ship.lat, 52);
  assert.equal({ ...p }.ship, undefined, 'a spread never copies ship fields');
});

test('an old (pre-v6) record becomes ship #1 with her cargo, fuel and condition; a second load is identical', () => {
  const g = new FakeGame(); const p = load(g, OLD());
  assert.equal(p.aboard, 'vp1'); assert.equal(p.fleet.length, 1); assert.equal(p.office.home, 'rotterdam');
  assert.equal(p.cond, 90); assert.equal(p.fuel, 50); assert.equal(p.cargo[0].qty, 40); assert.equal(p.docked, 'rotterdam'); assert.equal(p.vessel.name, 'Sea Bee');
  assert.equal(p.stats.delivered, 1, 'person stats stay with the person');
  const file = save(p);
  assert.equal(file.ship, undefined, 'no person-level ship key in the save'); assert.equal(file.fleet[0].ship.cls, 'coaster');
  const g2 = new FakeGame(); const q = load(g2, JSON.parse(JSON.stringify(file)));
  assert.equal(q.aboard, 'vp1'); assert.deepEqual(q.fleet.map((v) => v.id), ['vp1']); assert.equal(q.cargo[0].qty, 40);
  assert.deepEqual(JSON.parse(JSON.stringify(save(q))).fleet, JSON.parse(JSON.stringify(file)).fleet);
});

test('home at migration: the harbour she is docked in when it is big enough, else Rotterdam', () => {
  const g = new FakeGame();
  const a = load(g, { ...OLD(), id: 'p2', token: 't2', docked: 'hamburg' });
  assert.equal(a.office.home, 'hamburg');
  const b = load(g, { ...OLD(), id: 'p3', token: 't3', docked: 'ostend' });
  assert.equal(b.office.home, 'rotterdam', 'minor harbour → Rotterdam');
  const c = load(g, { ...OLD(), id: 'p4', token: 't4', docked: null });
  assert.equal(c.office.home, 'rotterdam');
});

test('v6 round trip: three ships, the aboard one, laid-up status and the downtime shift of storage', () => {
  const g = new FakeGame(); const { p } = g.join('Ann');
  const tr = g.addVessel(p, { cls: 'trawler', at: { lat: 54.5, lon: 3.0 } });
  const pb = g.addVessel(p, { cls: 'pilot', harbor: 'rotterdam', status: 'laidup' });
  p.aboard = tr.id; tr.orders = null; tr.cap = null;
  const sea = p.fleet[0]; sea.orders = null; sea.cap = newCap(g, 'idle');
  const storagePaid = pb.storagePaidTo;
  p.office.book.days[dayKey(g.simTime)] = { [tr.id]: { income: 900 } };
  const file = JSON.parse(JSON.stringify({ savedAt: new Date((g.simTime - 7200) * 1000).toISOString(), players: [save(p)] }));
  const g2 = new FakeGame({ simTime: g.simTime });
  const q = load(g2, file.players[0]);
  g2.fleet.afterLoad(Date.parse(file.savedAt) / 1000);
  assert.equal(q.aboard, tr.id); assert.equal(q.ship.cls, 'trawler'); assert.equal(q.fleet.length, 3);
  const pb2 = q.fleet.find((v) => v.id === pb.id);
  assert.equal(pb2.status, 'laidup'); assert.ok(Math.abs(pb2.storagePaidTo - (storagePaid + 7200)) <= 2, `shifted ${pb2.storagePaidTo - storagePaid}`);
  assert.equal(q.office.book.days[dayKey(g.simTime)][tr.id].income, 900);
  assert.equal(g2.fleet.vessels.size, 3);
});

test('healing a v6 record: aboard → first active, duplicate ids, more than 8 ships, laid up away from home', () => {
  const g = new FakeGame(); const { p } = g.join('Ann');
  for (let i = 0; i < 9; i++) g.addVessel(p, { cls: 'coaster', harbor: i === 0 ? 'hamburg' : 'rotterdam' });
  const rec = save(p);
  rec.fleet[1].status = 'laidup';                         // in Hamburg, home is Rotterdam → active
  rec.fleet[2].status = 'laidup'; rec.fleet[2].docked = 'rotterdam';
  rec.aboard = rec.fleet[2].id;                            // laid up → not aboard
  rec.fleet[3].id = rec.fleet[4].id;                       // duplicate
  rec.fleet[5].id = '<bad>';
  const g2 = new FakeGame(); const q = load(g2, rec);
  assert.equal(q.fleet.length, FLEET.MAX_VESSELS);
  assert.equal(new Set(q.fleet.map((v) => v.id)).size, 8);
  assert.ok(q.fleet.every((v) => VESSEL_ID_RE.test(v.id)));
  assert.equal(q.fleet[1].status, 'active');
  assert.equal(q.fleet[2].status, 'laidup');
  assert.equal(q.aboard, q.fleet[0].id);
  // nothing active at all → the first one is recommissioned (fee waived)
  const r2 = save(p); for (const v of r2.fleet) { v.status = 'laidup'; v.docked = 'rotterdam'; } r2.fleet = r2.fleet.slice(0, 3);
  const z = load(new FakeGame(), r2);
  assert.equal(z.vessel.status, 'active'); assert.equal(z.fleet.filter((v) => v.status === 'laidup').length, 2);
});

test('ledger: book refuses non-integers; charge turns what cash cannot cover into owed; owed is paid first from income', () => {
  const g = new FakeGame(); const { p } = g.join('Ann'); const f = g.fleet;
  for (const bad of [1.5, 0, NaN, Infinity]) assert.throws(() => f.book(p, p.aboard, 'income', bad));
  assert.throws(() => f.book(p, p.aboard, 'bribes', 10));
  const tr = g.addVessel(p, { cls: 'trawler', harbor: 'rotterdam' });
  p.money = 30; f.m0.set(p.id, 30);
  f.charge(p, tr.id, 'wages', 50);
  assert.equal(p.money, 0); assert.equal(p.office.owed, 20);
  const day = p.office.book.days[dayKey(g.simTime)];
  assert.equal(day[tr.id].wages, -30);
  f.actorOf(tr).money = p.money + 100;                    // the captain's contract pays 100
  assert.equal(p.money, 100); assert.equal(day[tr.id].income, 100);
  f.tick(0.1);
  assert.equal(p.office.owed, 0); assert.equal(p.money, 80); assert.equal(day._.arrears, -20);
  for (const d of Object.values(p.office.book.days)) for (const row of Object.values(d)) for (const v of Object.values(row)) assert.ok(Number.isSafeInteger(v));
  // an actor never takes cash below zero
  p.money = 10.6; f.m0.set(p.id, p.money);
  f.actorOf(tr)._cat = 'port'; f.actorOf(tr).money = 0; f.actorOf(tr)._cat = null;
  assert.ok(p.money >= 0 && p.money < 1, `money ${p.money}`);
});

test('drift booking: what the aboard ship earns and spends lands on her, in whole credits', () => {
  const g = new FakeGame(); const { p } = g.join('Ann'); const f = g.fleet;
  f.tick(0.1);
  p.money += 9000; f.tick(0.1);
  p.money -= 538; f.tick(0.1);
  p.money -= 0.4; f.tick(0.1); p.money -= 0.4; f.tick(0.1); p.money -= 0.4; f.tick(0.1);
  const row = p.office.book.days[dayKey(g.simTime)][p.aboard];
  assert.equal(row.income, 9000); assert.equal(row.costs, -539, 'three 0.4 cr wage drips book 1 cr, 0.2 carried');
  assert.ok(Math.abs(p.office.book.rem + 0.2) < 1e-9);
});

test('ledger keeps the newest 8 days only', () => {
  const g = new FakeGame(); const { p } = g.join('Ann'); const f = g.fleet;
  for (let d = 12; d >= 0; d--) { g.simTime = T0 - d * 86400; f.book(p, p.aboard, 'income', 10); }
  assert.equal(Object.keys(p.office.book.days).length, FLEET.LEDGER_DAYS);
  assert.ok(p.office.book.days[dayKey(T0)]); assert.ok(!p.office.book.days[dayKey(T0 - 8 * 86400)]);
});

// ------------------------------------------------------------------------------------------- the client fixture
/** A 4-ship fleet: aboard coaster at Rotterdam, trawler fishing on the Dogger Bank, feeder on passage to Hamburg with
 *  freight (route + ETA), laid-up pilot boat; a week of ledger, a log, a sale. Additive to the contract's 3-ship fixture. */
export function sampleFleet() {
  const g = new FakeGame({ simTime: T0 }); const { p, ws } = g.join('Ann', { id: '3fa9c2d1', money: 84310 }); const f = g.fleet;
  const { p: bob, ws: bws } = g.join('Bob', { id: '7b0e11aa', harbor: 'rotterdam' });
  bob.ship.lat = 54.3; bob.ship.lon = 3.2; bob.docked = null;
  p.vessel.berth = { harbor: 'rotterdam', id: 'rotterdam-waalhaven-3', name: 'Waalhaven 3', hdg: 45, lat: 51.98, lon: 4.03 };
  // trawler fishing on the Dogger Bank
  const dog = FISHING_GROUNDS.find((x) => x.id === 'dogger');
  const tPos = destination(dog.lat, dog.lon, 200, 0.4 * dog.radiusKm * 1000);
  const tr = g.addVessel(p, { id: 'v1a2b3c4d', cls: 'trawler', name: 'Kittiwake', at: tPos, hdg: 110, spd: 3 });
  tr.fuel = 28.8; tr.cond = 94; tr.fishing = true; tr.ship.throttle = 0.25;
  tr.jobs.push({ id: 'jf1', type: 'fishing', title: 'Catch 30 t of fish for Rotterdam', from: 'rotterdam', to: 'rotterdam', ground: 'dogger', groundName: 'Dogger Bank', good: 'fish', qty: 30, pay: 21000, hours: 30, dueShip: tr.shipTime + 6.2 * 3600 });
  tr.cargo.push({ good: 'fish', qty: 18.4, contraband: false, jobId: null, caught: true });
  tr.orders = { type: 'contract', jobId: 'jf1', then: 'stay' };
  tr.cap = newCap(g, 'fishing', { target: { lat: dog.lat, lon: dog.lon, kind: 'ground', name: 'Dogger Bank' }, jobId: 'jf1', baseThr: 0.25 });
  tr.voyage = { route: fishLoop(dog, tr.ship), i: 1, throttle: 0.25, harbor: null, setAt: 0 };
  // feeder on passage Rotterdam → Hamburg with freight
  const route = [[52.1, 3.9], [52.6, 4.25], [53.2, 4.6], [53.65, 5.6], [53.85, 6.8], [54.0, 7.7], [53.95, 8.45], [53.86, 8.9], [53.6, 9.5], [53.54, 9.93]];
  const ns = g.addVessel(p, { id: 'v5e6f7a8b', cls: 'feeder', name: 'North Star', at: { lat: 53.4, lon: 4.95 }, hdg: 62, spd: 15.6 });
  ns.fuel = 212.5; ns.cond = 88; ns.ship.throttle = 0.8;
  ns.jobs.push({ id: 'jc7', type: 'freight', title: 'Freight 2,400 t of Containers to Hamburg', from: 'rotterdam', to: 'hamburg', good: 'containers', qty: 2400, pay: 61800, hours: 30, dueShip: ns.shipTime + 22 * 3600 });
  ns.cargo.push({ good: 'containers', qty: 2400, contraband: false, jobId: 'jc7' });
  ns.orders = { type: 'contract', jobId: 'jc7', then: 'stay' };
  const ham = harborById('hamburg');
  ns.cap = newCap(g, 'sailing', { target: { harbor: 'hamburg', lat: ham.lat, lon: ham.lon, kind: 'harbor', name: 'Hamburg' }, jobId: 'jc7', route, routeKm: 470.2, baseThr: 0.8, etaS: T0 + Math.round(9.6 * 3600) });
  ns.voyage = { route, i: 3, throttle: 0.8, harbor: 'hamburg', setAt: 0 };
  // laid-up pilot boat
  const pb = g.addVessel(p, { id: 'v9c0d1e2f', cls: 'pilot', name: 'Puffin', harbor: 'rotterdam', status: 'laidup' });
  pb.berth = { harbor: 'rotterdam', id: 'rotterdam-pontoon-1', name: 'Pontoon 1', hdg: 45, lat: 51.982, lon: 4.035 }; pb.storagePaidTo = T0 - 3600;
  // a week of books
  const book = (d, vid, cat, amt) => { g.simTime = T0 - d * 86400; f.addDay(p, vid, cat, amt); g.simTime = T0; };
  book(6, ns.id, 'ships', -950000); book(6, p.aboard, 'income', 7400); book(6, p.aboard, 'costs', -930);
  book(5, ns.id, 'income', 48200); book(5, ns.id, 'fuel', -14200); book(5, ns.id, 'port', -2352); book(5, ns.id, 'wages', -2400);
  book(4, tr.id, 'income', 19400); book(4, tr.id, 'wages', -1210); book(4, tr.id, 'fuel', -1800); book(4, pb.id, 'storage', -25);
  book(3, p.aboard, 'income', 11250); book(3, p.aboard, 'costs', -1460); book(3, pb.id, 'storage', -25); book(3, '_', 'fees', -40000);
  book(2, ns.id, 'income', 52100); book(2, ns.id, 'fuel', -15800); book(2, ns.id, 'tugs', -4900); book(2, ns.id, 'wages', -2880); book(2, pb.id, 'storage', -25);
  book(1, tr.id, 'income', 21000); book(1, tr.id, 'wages', -1320); book(1, tr.id, 'repairs', -3600); book(1, pb.id, 'storage', -25); book(1, '_', 'ships', 54000);
  book(0, p.aboard, 'income', 6120); book(0, ns.id, 'wages', -1210); book(0, tr.id, 'wages', -440); book(0, ns.id, 'port', -1680);
  p.office.lost.push({ id: 'v0c1d2e3f', name: 'Grey Gull', cls: 'trawler', how: 'sold', at: T0 - 86400 - 3000 });
  p.office.slots = 4;
  const L = (dt, kind, text, vid) => p.office.log.push({ t: T0 - dt, kind, text, vid });
  L(30000, 'info', 'Took delivery of a Container feeder, North Star, moored at Rotterdam, Euromax 2. Your Coastal freighter stays yours.', ns.id);
  L(26000, 'info', 'North Star: cast off from Rotterdam for Hamburg, 470 km. ETA Thu 21:36 UTC.', ns.id);
  L(9000, 'info', 'Kittiwake: nets out on the Dogger Bank.', tr.id);
  L(5400, 'info', 'Kittiwake: 7.5 of 30 t caught on the Dogger Bank.', tr.id);
  L(2700, 'warn', 'North Star: waiting for the navigator.', ns.id);
  L(900, 'info', 'Kittiwake: 15 of 30 t caught on the Dogger Bank.', tr.id);
  p.office.unread = 2;
  // the board of the harbour a docked ship lies in
  g.harbors.rotterdam.jobs.push(
    { id: 'jb1', type: 'freight', title: 'Freight 900 t of Grain to Hamburg', from: 'rotterdam', to: 'hamburg', good: 'grain', qty: 900, pay: 24300, hours: 40, distKm: 410 },
    { id: 'jb2', type: 'passengers', title: '10 passengers to IJmuiden', from: 'rotterdam', to: 'ijmuiden', pax: 10, pay: 3100, hours: 8, distKm: 60 },
    { id: 'jb3', type: 'tow', title: 'Tow a disabled stern trawler to Rotterdam', from: 'rotterdam', to: 'rotterdam', victimCls: 'trawler', pay: 16000, hours: 20, at: { lat: 53.2, lon: 3.4 } },
    { id: 'jb4', type: 'freight', title: 'Freight 5,000 t of Steel coils to Antwerp', from: 'rotterdam', to: 'antwerp', good: 'steel', qty: 5000, pay: 51000, hours: 20, distKm: 130 },
  );
  return { g, p, ws, bob, bws, tr, ns, pb };
}

test('the client fixture docs/fixtures/fleet.sample.json: every VesselView and FleetView key, written from the real fleet code', () => {
  const { g, p, ws, bob, tr, pb } = sampleFleet(); const f = g.fleet;
  const view = f.fleetView(p);
  const VV = ['id', 'name', 'cls', 'clsName', 'status', 'state', 'aboard', 'lat', 'lon', 'hdg', 'spd', 'harbor', 'harborName', 'berthName', 'fuel', 'fuelCap', 'cond', 'flooding', 'cargoT', 'capacity', 'pax', 'paxUsed',
    'cargo', 'jobs', 'shipTime', 'order', 'task', 'route', 'costNow', 'value', 'profit', 'can'];
  const FV = ['home', 'homeName', 'slots', 'slotsMax', 'slotPrice', 'used', 'max', 'n', 'cash', 'owed', 'value', 'costPerH', 'storagePerDay', 'unread', 'homeMove', 'vessels', 'money', 'log'];
  for (const k of FV) assert.ok(k in view, `FleetView.${k}`);
  for (const v of view.vessels) for (const k of VV) assert.ok(k in v, `VesselView.${k} (${v.name})`);
  for (const k of ['helm', 'helmFee', 'orders', 'contract', 'layUp', 'recommission', 'recommissionFee', 'sell', 'sellValue', 'services', 'rename']) assert.ok(k in view.vessels[0].can, `can.${k}`);
  assert.deepEqual(view.vessels.map((v) => v.name), ['Sea Bee', 'Kittiwake', 'North Star', 'Puffin'], 'aboard first, then active by name, then laid up');
  assert.deepEqual(view.vessels.map((v) => v.state), ['docked', 'at_sea', 'at_sea', 'laid_up']);
  assert.equal(view.money.days.length, 7);
  assert.equal(view.cash, 84310);
  const ns = view.vessels[2];
  assert.ok(ns.route.length >= 2 && ns.route.length <= 40); assert.equal(ns.task.etaS, T0 + Math.round(9.6 * 3600)); assert.equal(ns.costNow.crPerH, 140);
  assert.equal(view.vessels[3].costNow.kind, 'storage'); assert.equal(view.vessels[3].costNow.crPerDay, 25);
  assert.ok(typeof view.vessels[1].can.helm === 'string' || view.vessels[1].can.helmFee > 0, 'a remote ship costs a launch');
  // the harbour payload additions and the other skipper's snapshot list
  g.sendHarbor(p); const harbor = last(ws, 'harbor').harbor;
  for (const k of ['office', 'fleetHere', 'fleetFull', 'fleetN']) assert.ok(k in harbor, `harbor.${k}`);
  assert.deepEqual(harbor.fleetHere.map((v) => v.name), ['Sea Bee', 'Puffin']);
  const snapFleet = f.viewFor(bob, true);
  assert.ok(snapFleet.some((x) => x.id === tr.id && x.owner === 'Ann' && x.state === 'at_sea'));
  for (const x of snapFleet) { assert.ok(!('cargo' in x) && !('jobs' in x) && !('money' in x), 'FleetPublic carries no cargo, money or contracts'); }
  f.onAction(p, { action: 'fleet_board', vesselId: p.aboard === tr.id ? pb.id : p.fleet[0].id }); // the aboard ship: still answered (it is docked)
  const board = last(ws, 'fleet_board');
  assert.ok(board && board.jobs.length >= 4);
  assert.equal(board.jobs.find((j) => j.id === 'jb3').why, 'Captains do not take tows — sail her yourself.');
  g.sendYou(p); const y = last(ws, 'you').you;
  const you = { id: p.id, name: p.name, money: p.money, docked: p.docked, ship: { ...p.ship }, cond: p.cond, fuel: p.fuel, cargo: p.cargo, jobs: p.jobs, berth: p.berth, warp: 1, ...f.youFields(p) };
  assert.equal(y.aboard, p.aboard); assert.equal(y.fleet.n, 4); assert.equal(y.fleet.atSea, 2); assert.equal(y.fleet.laidUp, 1);
  const fixture = { note: 'v6 fleet sample (docs/V6-FLEET-CONTRACTS.md §10.3), written by test/fleet-model.test.mjs from server/fleet.js', simTime: T0,
    you, fleet: view, harbor, snapFleet, board,
    harbors: ['rotterdam', 'ijmuiden', 'hamburg', 'antwerp', 'felixstowe', 'hull', 'esbjerg', 'bremerhaven', 'zeebrugge', 'dunkirk', 'immingham', 'ostend', 'vlissingen', 'den-helder', 'aberdeen']
      .map((id) => harborById(id)).filter(Boolean).map((h) => ({ id: h.id, name: h.name, lat: h.lat, lon: h.lon, size: h.size })) };
  const out = new URL('../docs/fixtures/fleet.sample.json', import.meta.url);
  fs.mkdirSync(new URL('.', out), { recursive: true });
  const tmp = new URL(`../docs/fixtures/fleet.sample.json.${process.pid}.tmp`, import.meta.url);   // atomic: fleet-client reads it in parallel
  fs.writeFileSync(tmp, JSON.stringify(fixture, null, 1) + '\n'); fs.renameSync(tmp, out);
  assert.ok(fs.statSync(out).size > 2000);
  void stateOf;
});

// ------------------------------------------------------------------------------------------- phase 2: the real Game
async function realGame(opts = {}) {
  const { Game } = await import('../server/game.js');
  const { World } = await import('../server/world.js');
  const { carvingsForWorld } = await import('../server/harbors.js');
  process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
  const world = new World().load(carvingsForWorld(), () => {});
  const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-fleet-model.json', ...opts }); g.saveState = () => {}; g.rnd = () => 0.5;
  return { g, world, Game };
}
function sock() { return { readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); }, close() {} }; }

test('real game: a new player has a fleet of one, Sea Bee at Rotterdam, no ship keys on the person', PHASE2, async () => {
  const { g } = await realGame(); const p = g.connect(sock(), null, 'Ann');
  assert.equal(p.fleet.length, 1); assert.ok(VESSEL_ID_RE.test(p.aboard)); assert.equal(p.vessel, p.fleet[0]); assert.equal(p.ship, p.fleet[0].ship);
  assert.equal(p.office.home, 'rotterdam'); assert.equal(p.office.slots, 3); assert.equal(p.fleet[0].name, 'Sea Bee');
  for (const k of VESSEL_KEYS) assert.ok(!Object.keys(p).includes(k), k);
  assert.equal(JSON.parse(JSON.stringify(p)).fleet[0].ship.cls, 'coaster');
});

test('real game: the v0.3 state file of test/game.test.mjs loads as vp1 and survives a save/load with identical ids', PHASE2, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saltline-fleet-')); const file = path.join(dir, 'state.json');
  const old = { savedAt: new Date().toISOString(), wrecks: [], storms: [], harbors: {}, players: [{ ...OLD(), cargo: [] }] };
  fs.writeFileSync(file, JSON.stringify(old));
  const { Game, world } = await realGame();
  const g = new Game(world, () => {}, { stateFile: file });
  const p = g.players.get('t1');
  assert.equal(p.aboard, 'vp1'); assert.equal(p.fleet.length, 1); assert.equal(p.fuel, 50); assert.equal(p.cond, 90); assert.equal(p.office.home, 'rotterdam');
  g.saveState();
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(s.fleetSchema, 1); assert.equal(s.players[0].ship, undefined); assert.equal(s.players[0].fleet[0].id, 'vp1');
  const g2 = new Game(world, () => {}, { stateFile: file });
  assert.equal(g2.players.get('t1').aboard, 'vp1');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('real game: v6 round trip keeps the aboard trawler, the laid-up pilot boat and shifts storage by the downtime', PHASE2, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saltline-fleet-')); const file = path.join(dir, 'state.json');
  const { Game, world } = await realGame();
  const g = new Game(world, () => {}, { stateFile: file }); g.rnd = () => 0.5;
  const p = g.connect(sock(), null, 'Ann');
  p.money = 1e6; g.fleet.m0.set(p.id, p.money);
  g.fleet.buyNew(p, { cls: 'trawler' }); g.fleet.buyNew(p, { cls: 'pilot' });
  const pb = p.fleet[2]; g.fleet.layUpVessel(p, pb);
  g.fleet.switchShip(p, { vesselId: p.fleet[1].id });
  g.saveState();
  const s = JSON.parse(fs.readFileSync(file, 'utf8')); s.savedAt = new Date(Date.now() - 7200e3).toISOString(); fs.writeFileSync(file, JSON.stringify(s));
  const g2 = new Game(world, () => {}, { stateFile: file });
  const q = g2.players.get(p.token);
  assert.equal(q.ship.cls, 'trawler'); assert.equal(q.fleet.find((v) => v.id === pb.id).status, 'laidup');
  assert.ok(Math.abs(q.fleet.find((v) => v.id === pb.id).storagePaidTo - pb.storagePaidTo - 7200) <= 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('real game: drift booking of the aboard ship through payJob and port dues', PHASE2, async () => {
  const { g } = await realGame(); const p = g.connect(sock(), null, 'Ann');
  g.tick(0.1);
  const h = harborById('ijmuiden');
  g.payJob(p, { id: 'jx', title: 'x', pay: 9000, to: 'ijmuiden', dueShip: Infinity }, 1, h); g.tick(0.1);
  p.money -= 538; g.tick(0.1);
  const row = p.office.book.days[dayKey(g.simTime)][p.aboard];
  assert.equal(row.income, 9000); assert.equal(row.costs, -538);
});
