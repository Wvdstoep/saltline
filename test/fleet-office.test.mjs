// v6 fleet: the office, boat storage, home moves, renames and transfers in one harbour
// (docs/V6-FLEET-CONTRACTS.md §6, §14.1 fleet-office).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeGame, events, last } from './fleet-helpers.mjs';
import { dayKey } from '../shared/fleet.js';

const PHASE2 = {};
const book = (p, g, vid) => (p.office.book.days[dayKey(g.simTime)] || {})[vid] || {};
function setup(money = 500000) { const g = new FakeGame(); const j = g.join('Ann', { money }); return { g, f: g.fleet, ...j }; }

test('lay up at home: storage per whole day exactly, slot limit, buying a slot', () => {
  const { g, f, p, ws } = setup();
  const co = g.addVessel(p, { cls: 'coaster', harbor: 'rotterdam' });
  f.onAction(p, { action: 'fleet_layup', vesselId: co.id });
  assert.equal(co.status, 'laidup'); assert.equal(co.orders, null); assert.equal(co.cap, null);
  co.storagePaidTo = g.simTime - 3 * 86400 - 100;
  const m = p.money; f.daily(g.simTime);
  assert.equal(p.money, m - 96); assert.equal(book(p, g, co.id).storage, -96);
  assert.ok(Math.abs(co.storagePaidTo - (g.simTime - 100)) < 1e-6, 'paid to the last whole day');
  f.daily(g.simTime); assert.equal(p.money, m - 96, 'nothing more within the day');
  const a = g.addVessel(p, { cls: 'pilot' }), b = g.addVessel(p, { cls: 'pilot' }), c = g.addVessel(p, { cls: 'pilot' });
  f.onAction(p, { action: 'fleet_layup', vesselId: a.id }); f.onAction(p, { action: 'fleet_layup', vesselId: b.id });
  f.onAction(p, { action: 'fleet_layup', vesselId: c.id });
  assert.equal(c.status, 'active');
  assert.equal(events(ws).at(-1), 'Boat storage is full (3 of 3). Buy a place for 40,000 cr or recommission a ship.');
  const m2 = p.money; f.onAction(p, { action: 'fleet_slot' });
  assert.equal(p.money, m2 - 40000); assert.equal(p.office.slots, 4);
  f.onAction(p, { action: 'fleet_layup', vesselId: c.id }); assert.equal(c.status, 'laidup');
  assert.equal(last(ws, 'fleet').fleet.used, 4);
});

test('lay up refusals: away from home, with cargo, with a contract, the aboard ship', () => {
  const { g, f, p, ws } = setup();
  const ij = g.addVessel(p, { cls: 'trawler', harbor: 'ijmuiden' });
  f.onAction(p, { action: 'fleet_layup', vesselId: ij.id });
  assert.equal(events(ws).at(-1), 'Lay up only at your home harbour, Rotterdam.');
  const co = g.addVessel(p, { cls: 'coaster' });
  co.cargo.push({ good: 'grain', qty: 120, contraband: false, jobId: null });
  f.onAction(p, { action: 'fleet_layup', vesselId: co.id }); assert.equal(events(ws).at(-1), 'Unload her first (120 t aboard).');
  co.cargo = []; co.jobs.push({ id: 'jx1', type: 'freight', title: 'x', to: 'hamburg' });
  f.onAction(p, { action: 'fleet_layup', vesselId: co.id }); assert.equal(events(ws).at(-1), 'Finish or hand over her contracts first.');
  f.onAction(p, { action: 'fleet_layup', vesselId: p.aboard }); assert.match(events(ws).at(-1), /You are aboard/);
  assert.ok(p.fleet.every((v) => v.status === 'active'));
});

test('recommission: coaster 240, trawler 360; the started day of storage first; needs cash and no owed', () => {
  const { g, f, p, ws } = setup();
  const co = g.addVessel(p, { cls: 'coaster' }), tr = g.addVessel(p, { cls: 'trawler' });
  f.layUpVessel(p, co); f.layUpVessel(p, tr);
  let m = p.money; f.onAction(p, { action: 'fleet_recommission', vesselId: co.id });
  assert.equal(p.money, m - 240); assert.equal(co.status, 'active'); assert.equal(co.cap.phase, 'idle');
  tr.storagePaidTo = g.simTime - 3600;                 // one started day of storage (25 cr) first
  m = p.money; f.onAction(p, { action: 'fleet_recommission', vesselId: tr.id });
  assert.equal(p.money, m - 360 - 25); assert.equal(book(p, g, tr.id).fees, -360); assert.equal(book(p, g, tr.id).storage, -25);
  f.layUpVessel(p, co); p.office.owed = 5;
  f.onAction(p, { action: 'fleet_recommission', vesselId: co.id }); assert.match(events(ws).at(-1), /unpaid bills/); assert.equal(co.status, 'laidup');
  p.office.owed = 0; p.money = 100; f.m0.set(p.id, 100);
  f.onAction(p, { action: 'fleet_recommission', vesselId: co.id }); assert.match(events(ws).at(-1), /costs 240 cr\. You have 100/);
});

test('home: first move free, then 25,000 and at most once in 7 days; regional and up; not with laid-up ships', () => {
  const { g, f, p, ws } = setup();
  p.docked = 'hamburg';
  f.onAction(p, { action: 'fleet_home', harbor: 'hamburg' });
  assert.equal(p.office.home, 'hamburg'); assert.equal(p.office.homeMoves, 1); assert.equal(p.money, 500000);
  g.simTime += 2 * 86400; p.docked = 'rotterdam';
  f.onAction(p, { action: 'fleet_home', harbor: 'rotterdam' });
  assert.equal(events(ws).at(-1), 'You moved your office 2 days ago — next move possible in 5 days.');
  g.simTime += 6 * 86400;
  f.onAction(p, { action: 'fleet_home', harbor: 'rotterdam' });
  assert.equal(p.office.home, 'rotterdam'); assert.equal(p.money, 475000);
  f.onAction(p, { action: 'fleet_home', harbor: 'rotterdam' }); assert.equal(events(ws).at(-1), 'Rotterdam is already your home.');
  p.docked = 'ostend'; g.simTime += 8 * 86400;
  f.onAction(p, { action: 'fleet_home', harbor: 'ostend' }); assert.equal(events(ws).at(-1), 'Small ports cannot host an office — pick a regional, major or mega port.');
  const co = g.addVessel(p, { cls: 'coaster' }); f.layUpVessel(p, co);
  p.docked = 'ijmuiden';
  f.onAction(p, { action: 'fleet_home', harbor: 'ijmuiden' }); assert.equal(events(ws).at(-1), 'Recommission or sell your laid-up ships first.');
  f.onAction(p, { action: 'fleet_home', harbor: 'hamburg' }); assert.match(events(ws).at(-1), /Moor in Hamburg/);
  f.onAction(p, { action: 'fleet_home', harbor: { toString() { return 'x'; } } }); assert.equal(events(ws).at(-1), 'Pick a harbour.');
});

test('no berth fee at home on undock (aboard and fleet ship); a coaster 1 day at IJmuiden pays 64', () => {
  const { g, f, p } = setup();
  p.dockedAt = g.simTime - 3600; let m = p.money; g.undock(p); assert.equal(p.money, m);
  const tr = g.addVessel(p, { cls: 'trawler' }); tr.dockedAt = g.simTime - 3 * 86400;
  const a = f.actorOf(tr); m = p.money; g.undock(a); assert.equal(p.money, m);
  const co = g.addVessel(p, { cls: 'coaster', harbor: 'ijmuiden' }); co.dockedAt = g.simTime - 3600;
  const b = f.actorOf(co); b._cat = 'port'; m = p.money; g.undock(b); b._cat = null;
  assert.equal(p.money, m - 64); assert.equal(book(p, g, co.id).port, -64);
});

test('rename: trimmed, 2–24 characters, unique in the fleet', () => {
  const { g, f, p, ws } = setup();
  const tr = g.addVessel(p, { cls: 'trawler' });
  f.onAction(p, { action: 'fleet_rename', vesselId: tr.id, name: '  Grey   Gull ' }); assert.equal(tr.name, 'Grey Gull');
  for (const bad of ['X', 'A'.repeat(25), '<b>', 5, null]) { f.onAction(p, { action: 'fleet_rename', vesselId: tr.id, name: bad }); assert.equal(tr.name, 'Grey Gull', String(bad)); }
  f.onAction(p, { action: 'fleet_rename', vesselId: tr.id, name: 'sea bee' }); assert.equal(tr.name, 'Grey Gull'); assert.match(events(ws).at(-1), /already have a ship called/);
  f.onAction(p, { action: 'fleet_rename', vesselId: p.aboard, name: 'Morning Tide' }); assert.equal(p.vessel.name, 'Morning Tide');
  assert.equal(last(ws, 'you').you.vesselName, 'Morning Tide');
});

test('cargo transfer in one harbour: exact stacks, hold limits, same harbour, contract cargo stays', () => {
  const { g, f, p, ws } = setup();
  p.cargo.push({ good: 'grain', qty: 400, contraband: false, jobId: null });
  const tr = g.addVessel(p, { cls: 'trawler' });
  f.onAction(p, { action: 'fleet_transfer', fromId: p.aboard, toId: tr.id, good: 'grain', qty: 100 });
  assert.equal(p.cargo[0].qty, 300); assert.deepEqual(tr.cargo, [{ good: 'grain', qty: 100, contraband: false, jobId: null }]);
  f.onAction(p, { action: 'fleet_transfer', fromId: p.aboard, toId: tr.id, good: 'grain', qty: 250 });
  assert.equal(tr.cargo[0].qty, 100); assert.match(events(ws).at(-1), /No room aboard Kittiwake \(200 t free\)/);
  f.onAction(p, { action: 'fleet_transfer', fromId: p.aboard, toId: tr.id, good: 'grain', qty: 'Infinity' });
  assert.equal(events(ws).at(-1), 'Say how many tonnes.');
  f.onAction(p, { action: 'fleet_transfer', fromId: p.aboard, toId: tr.id, good: '__proto__', qty: 1 }); assert.equal(events(ws).at(-1), 'Unknown cargo.');
  const ij = g.addVessel(p, { cls: 'trawler', harbor: 'ijmuiden' });
  f.onAction(p, { action: 'fleet_transfer', fromId: p.aboard, toId: ij.id, good: 'grain', qty: 10 });
  assert.equal(events(ws).at(-1), 'Both ships must be moored in the same harbour.'); assert.equal(ij.cargo.length, 0);
  // caught fish keeps its flag, 0.1 t
  tr.cargo.push({ good: 'fish', qty: 12.34, contraband: false, jobId: null, caught: true });
  f.onAction(p, { action: 'fleet_transfer', fromId: tr.id, toId: p.aboard, good: 'fish', qty: 5.04 });
  assert.equal(p.cargo.find((c) => c.good === 'fish').qty, 5); assert.equal(p.cargo.find((c) => c.good === 'fish').caught, true);
  // contract cargo only moves with its contract
  p.cargo.push({ good: 'steel', qty: 50, contraband: false, jobId: 'jst1' });
  f.onAction(p, { action: 'fleet_transfer', fromId: p.aboard, toId: tr.id, good: 'steel', qty: 10 });
  assert.match(events(ws).at(-1), /Contract cargo moves with its contract/);
  // origin (politics: sanctions / origin rules) travels with the stack and keeps origins apart; none stays absent
  p.cargo.push({ good: 'machinery', qty: 20, contraband: false, jobId: null, origin: 'RU' }, { good: 'machinery', qty: 20, contraband: false, jobId: null, origin: 'NL' });
  f.onAction(p, { action: 'fleet_transfer', fromId: p.aboard, toId: tr.id, good: 'machinery', qty: 30 });
  assert.deepEqual(tr.cargo.filter((c) => c.good === 'machinery').map((c) => [c.origin, c.qty]).sort(), [['NL', 10], ['RU', 20]]);
  assert.ok(!('origin' in tr.cargo.find((c) => c.good === 'grain')), 'no origin key on a stack that never had one');
});

test('fleet_move_job: the contract and its cargo move together and the due date keeps the time left', () => {
  const { g, f, p, ws } = setup();
  const tr = g.addVessel(p, { cls: 'trawler' });
  p.shipTime = g.simTime + 5000; tr.shipTime = g.simTime + 100;
  p.jobs.push({ id: 'jfr1', type: 'freight', title: 'Freight 100 t of Grain to Hamburg', to: 'hamburg', good: 'grain', qty: 100, pay: 5000, dueShip: p.shipTime + 7200 });
  p.cargo.push({ good: 'grain', qty: 100, contraband: false, jobId: 'jfr1' });
  f.onAction(p, { action: 'fleet_move_job', jobId: 'jfr1', fromId: p.aboard, toId: tr.id });
  assert.equal(p.jobs.length, 0); assert.equal(p.cargo.length, 0);
  assert.equal(tr.jobs[0].id, 'jfr1'); assert.equal(tr.cargo[0].jobId, 'jfr1');
  assert.equal(tr.jobs[0].dueShip, tr.shipTime + 7200);
  tr.jobs.push({ id: 'jfr2', type: 'freight', title: 'Big', to: 'hamburg', good: 'steel', qty: 1100, pay: 1 });
  tr.cargo.push({ good: 'steel', qty: 150, contraband: false, jobId: 'jfr2' });
  const t2 = g.addVessel(p, { cls: 'pilot' });
  f.onAction(p, { action: 'fleet_move_job', jobId: 'jfr2', fromId: tr.id, toId: t2.id });
  assert.match(events(ws).at(-1), /cannot take it: needs 1,100 t of hold/);
  tr.jobs.push({ id: 'jtw1', type: 'tow', title: 'Tow', to: 'hamburg', pickedUp: false });
  f.onAction(p, { action: 'fleet_move_job', jobId: 'jtw1', fromId: tr.id, toId: t2.id });
  assert.equal(events(ws).at(-1), 'Captains do not take tows — sail her yourself.');
  f.onAction(p, { action: 'fleet_move_job', jobId: 'jtw1', fromId: tr.id, toId: p.aboard });
  assert.ok(p.jobs.some((j) => j.id === 'jtw1'), 'a tow not yet picked up can go to the ship you sail');
});

test('hq_watch and fleet_seen', () => {
  const { f, p, ws } = setup();
  p.office.unread = 4;
  f.onAction(p, { action: 'hq_watch', on: true }); assert.ok(f.watching.has(p.id)); assert.equal(last(ws, 'fleet').fleet.unread, 4);
  f.onAction(p, { action: 'fleet_seen' }); assert.equal(p.office.unread, 0);
  f.onAction(p, { action: 'hq_watch', on: false }); assert.ok(!f.watching.has(p.id));
  f.unwatch(p);
});

test('real game: berth fee at home is 0 on undock for the aboard ship', PHASE2, async () => {
  const { Game } = await import('../server/game.js');
  const { World } = await import('../server/world.js');
  const { carvingsForWorld } = await import('../server/harbors.js');
  process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
  const g = new Game(new World().load(carvingsForWorld(), () => {}), () => {}, { stateFile: '/nonexistent/saltline-fleet-office.json' }); g.saveState = () => {};
  const p = g.connect({ readyState: 1, sent: [], send() {}, close() {} }, null, 'Ann');
  p.dockedAt = g.simTime - 2 * 86400; const m = p.money;
  g.onAction(p, { action: 'undock' });
  assert.equal(p.money, m);
});
