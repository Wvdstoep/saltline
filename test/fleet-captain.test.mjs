// v6 fleet: hired captains — wages, departures, voyages, arrivals, contracts, holding, give way, weather, fuel, sinking,
// an absent owner, the snapshot list and the action rate limit (docs/V6-FLEET-CONTRACTS.md §7, §14.1 fleet-captain).
// Phase 1 drives server/captain.js against test/fleet-helpers.mjs FakeGame (the game's own methods stubbed with the same
// rules); the "phase 2" tests repeat the voyages on the real Game, the inline route planner and the real world raster.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { FakeGame, straightPlanner, events, harborById } from './fleet-helpers.mjs';
import { dayKey, FLEET } from '../shared/fleet.js';
import { destination, haversine } from '../shared/geo.js';
import { serviceBurnTph, serviceKn } from '../shared/rates.js';
import { portDues } from '../server/economy.js';
import { clearRadius } from '../server/safespot.js';
import { setOrder, stepVessel, dutyOf, giveWay } from '../server/captain.js';
import { SHIP_CLASSES } from '../shared/constants.js';

const PHASE2 = { skip: 'needs game.js wiring (phase 2)' };
const IJ = harborById('ijmuiden');
const day = (p, g) => p.office.book.days[dayKey(g.simTime)] || {};
const sum = (p, cat, vid) => Object.values(p.office.book.days).reduce((s, d) => s + Object.entries(d).filter(([k]) => !vid || k === vid).reduce((t, [, row]) => t + (row[cat] || 0), 0), 0);
function setup(o = {}) { const g = new FakeGame({ routePlanner: straightPlanner(), ...o }); const j = g.join('Ann', { money: o.money ?? 100000 }); return { g, f: g.fleet, ...j }; }
async function until(f, v, pred, maxS, step = 1) { for (let t = 0; t < maxS; t += step) { await f.advance(v, step); if (pred()) return t + step; } return -1; }

test('wages: under way 60 cr/h, anchored 20, moored without orders 0, towing 68 — exact credits', async () => {
  const { g, f, p } = setup();
  const sea = { lat: 54.5, lon: 3.0 };
  const a = g.addVessel(p, { cls: 'coaster', at: sea });
  setOrder(f, a, { type: 'route', route: [[54.5, 5.0]], harbor: null, then: 'hold' });
  assert.equal(a.cap.phase, 'sailing');
  await f.advance(a, 3600);
  assert.equal(sum(p, 'wages', a.id), -60); assert.equal(dutyOf(a), 'underway');
  const b = g.addVessel(p, { cls: 'coaster', at: { lat: 55.5, lon: 3.0 } }); b.orders = { type: 'hold' }; b.cap.phase = 'anchored';
  await f.advance(b, 3600); assert.equal(sum(p, 'wages', b.id), -20);
  const c = g.addVessel(p, { cls: 'coaster', harbor: 'rotterdam' });
  await f.advance(c, 3600); assert.equal(sum(p, 'wages', c.id), 0); assert.equal(dutyOf(c), 'off');
  const d = g.addVessel(p, { cls: 'coaster', at: { lat: 56.5, lon: 3.0 } });
  d.jobs.push({ id: 'jtw', type: 'tow', title: 'Tow', to: 'hull', victimCls: 'trawler', pickedUp: true }); d.towing = 'jtw';
  setOrder(f, d, { type: 'route', route: [[56.5, 5.5]], then: 'hold' });
  await f.advance(d, 3600); assert.equal(sum(p, 'wages', d.id), -68);
  for (const v of [a, b, c, d]) assert.ok(Number.isSafeInteger(v.pay.rem) && v.pay.rem >= 0 && v.pay.rem < FLEET.DEN_WAGE);
});

test('sail_to over open water: arrives, docks at IJmuiden, pays the dues; money = −dues − wages exactly', async () => {
  const { g, f, p } = setup();
  const v = g.addVessel(p, { cls: 'coaster', at: destination(IJ.lat, IJ.lon, 280, 20000) });
  const m0 = p.money; f.m0.set(p.id, m0);
  setOrder(f, v, { type: 'sail_to', harbor: 'ijmuiden', then: 'moor' });
  const t = await until(f, v, () => !!v.docked, 4 * 3600, 10);
  assert.ok(t > 0, 'arrived'); assert.equal(v.docked, 'ijmuiden'); assert.equal(v.orders, null); assert.equal(v.cap.phase, 'idle');
  assert.equal(portDues('coaster', IJ), 461);
  const wages = sum(p, 'wages', v.id);
  assert.ok(wages < 0);
  assert.equal(p.money, m0 - 461 + wages);
  assert.equal(sum(p, 'port', v.id), -461);
});

test('freight end to end: accept at Rotterdam for a moored coaster, sail, deliver at IJmuiden, +9,000 booked as income', async () => {
  const { g, f, p, ws } = setup();
  const v = g.addVessel(p, { cls: 'coaster', harbor: 'rotterdam' });
  g.harbors.rotterdam.jobs.push({ id: 'jfr9', type: 'freight', from: 'rotterdam', to: 'ijmuiden', good: 'grain', qty: 100, pay: 9000, hours: 30, title: 'Freight 100 t of Grain to IJmuiden' });
  f.onAction(p, { action: 'fleet_accept', vesselId: v.id, jobId: 'jfr9', then: 'stay' });
  assert.deepEqual(v.orders, { type: 'contract', jobId: 'jfr9', then: 'stay' }); assert.equal(v.cargo[0].qty, 100);
  const m0 = p.money; f.m0.set(p.id, m0);
  const t = await until(f, v, () => v.docked === 'ijmuiden', 8 * 3600, 10);
  assert.ok(t > 0 && t <= 8 * 3600, `took ${t} s`);
  assert.equal(v.jobs.length, 0); assert.equal(v.cargo.length, 0);
  assert.equal(sum(p, 'income', v.id), 9000);
  assert.equal(p.money, m0 + 9000 - 461 + sum(p, 'wages', v.id) + sum(p, 'fuel', v.id) + sum(p, 'tugs', v.id) + (sum(p, 'port', v.id) + 461));
  assert.ok(events(ws).some((x) => /cast off from Rotterdam for IJmuiden/.test(x)), events(ws).join('\n'));
  assert.ok(events(ws).some((x) => /^Sea Bee 2?.*Delivered: Freight 100 t|Delivered: Freight 100 t of Grain to IJmuiden — \+9000 cr/.test(x)));
  await f.advance(v, 30); assert.equal(v.orders, null, 'then: stay → moored, idle');
});

test('fishing: 30 t on the Dogger Bank at 30 t/h, under 4 kn, then nets in and home to land it', async () => {
  const { g, f, p } = setup();
  const dog = { lat: 54.7, lon: 2.8 };
  const v = g.addVessel(p, { cls: 'trawler', at: dog });
  v.jobs.push({ id: 'jfi1', type: 'fishing', title: 'Catch 30 t of fish', from: 'rotterdam', to: 'rotterdam', ground: 'dogger', groundName: 'Dogger Bank', good: 'fish', qty: 30, pay: 21000, dueShip: v.shipTime + 30 * 3600 });
  setOrder(f, v, { type: 'contract', jobId: 'jfi1', then: 'stay' });
  let maxKn = 0;
  for (let s = 0; s < 3600; s += 10) { await f.advance(v, 10); if (v.cap.phase === 'fishing') maxKn = Math.max(maxKn, Math.abs(v.ship.spd)); }
  const have = v.cargo.filter((c) => c.good === 'fish' && c.caught).reduce((s, c) => s + c.qty, 0);
  assert.ok(Math.abs(have - 30) <= 0.5, `caught ${have} t`);
  assert.ok(maxKn > 2 && maxKn < 4, `trawled at ${maxKn} kn`);
  await f.advance(v, 120);
  assert.equal(v.fishing, false, 'nets in'); assert.ok(['planning', 'sailing'].includes(v.cap.phase), v.cap.phase);
  assert.equal(v.cap.target.harbor, 'rotterdam');
});

test('supply: 300 m off the platform, 60 s of crane transfer, paid, cargo gone, then back to her port', async () => {
  const { g, f, p } = setup();
  const pf = { lat: 56.55, lon: 3.21 };
  const v = g.addVessel(p, { cls: 'psv', at: destination(pf.lat, pf.lon, 200, 300) });
  v.jobs.push({ id: 'jsu1', type: 'supply', title: 'Supply Ekofisk', from: 'rotterdam', to: 'rotterdam', at: pf, platformName: 'Ekofisk complex', qty: 200, pay: 15000, dueShip: v.shipTime + 86400 });
  v.cargo.push({ good: 'supplies', qty: 200, contraband: false, jobId: 'jsu1' });
  const m0 = p.money;
  setOrder(f, v, { type: 'contract', jobId: 'jsu1', then: 'stay' });
  await f.advance(v, 5); assert.equal(v.cap.phase, 'transfer');
  await f.advance(v, 60);
  assert.equal(v.jobs.length, 0); assert.equal(v.cargo.length, 0);
  assert.equal(sum(p, 'income', v.id), 15000); assert.ok(p.money > m0 + 15000 - 100);
  assert.deepEqual(v.orders, { type: 'sail_to', harbor: 'rotterdam', then: 'moor' });
});

test('give way: two captained coasters on reciprocal courses keep more than clearRadius(90) apart and both arrive', async () => {
  const { g, f, p } = setup();
  const A = { lat: 54.0, lon: 3.0 }, B = destination(A.lat, A.lon, 90, 4000);
  const endA = destination(A.lat, A.lon, 90, 12000), endB = destination(A.lat, A.lon, 90, -8000);
  const a = g.addVessel(p, { cls: 'coaster', at: A, hdg: 90 }), b = g.addVessel(p, { cls: 'coaster', at: B, hdg: 270 });
  setOrder(f, a, { type: 'route', route: [[endA.lat, endA.lon]], then: 'hold' });
  setOrder(f, b, { type: 'route', route: [[endB.lat, endB.lon]], then: 'hold' });
  let minD = Infinity;
  for (let t = 0; t < 3600; t++) {
    g.simTime += 1; f.tickNo++;
    stepVessel(f, a, 1); stepVessel(f, b, 1);
    minD = Math.min(minD, haversine(a.ship.lat, a.ship.lon, b.ship.lat, b.ship.lon));
  }
  assert.ok(minD > clearRadius(90), `closest ${Math.round(minD)} m`);
  assert.ok(['anchored', 'holding'].includes(a.cap.phase) && ['anchored', 'holding'].includes(b.cap.phase), `${a.cap.phase} ${b.cap.phase}`);
  assert.ok(haversine(a.ship.lat, a.ship.lon, endA.lat, endA.lon) < 3500 && haversine(b.ship.lat, b.ship.lon, endB.lat, endB.lon) < 3500);
});

test('give way: land on both sides → dead slow, at most 120 s', () => {
  const g = new FakeGame({ world: { isWater: (lat) => lat < 54.0001 && lat > 53.9999, depthAt: () => 50 } }); const { p } = g.join('Ann'); const f = g.fleet;
  const a = g.addVessel(p, { cls: 'coaster', at: { lat: 54, lon: 3 }, hdg: 90, spd: 10 });
  g.addVessel(p, { cls: 'coaster', at: destination(54, 3, 90, 300) }).status = 'active';
  a.voyage = { route: [[54, 3.2]], i: 0, throttle: 0.8 };
  assert.equal(giveWay(f, a), true); assert.equal(a.voyage.route.length, 1, 'no waypoint over land');
  assert.ok(f.rtOf(a).stopUntil > g.simTime);
  g.simTime += 121; giveWay(f, a);
  assert.ok(f.rtOf(a).stopUntil < g.simTime, 'gives up dead slow after 120 s');
});

test('weather: a gale at the berth keeps her in (gale text); the next re-check after it clears lets her go', async () => {
  let storm = 0.8;
  const { g, f, p, ws } = setup({ weather: () => ({ wind: { spd: storm ? 22 : 6 }, storm, sea: 0.5 }) });
  const v = g.addVessel(p, { cls: 'coaster', harbor: 'rotterdam' });
  setOrder(f, v, { type: 'sail_to', harbor: 'ijmuiden', then: 'moor' });
  await f.advance(v, 3);
  assert.equal(v.cap.phase, 'waiting'); assert.match(v.cap.why, /^waiting for weather \(storm force 9|^waiting for weather \(gale force|^waiting for weather/);
  assert.match(v.cap.why, /at Rotterdam\)$/);
  assert.ok(events(ws).some((t) => /Kittiwake: Waiting for weather/.test(t)));
  storm = 0;
  await f.advance(v, 300); assert.equal(v.docked, 'rotterdam', 'not before the re-check');
  await f.advance(v, 310); assert.equal(v.docked, null); assert.equal(v.cap.phase, 'sailing');
});

test('fuel: short and broke → failed with the fuel text; with cash → bunkered, booked fuel = round(t × price)', async () => {
  const { g, f, p, ws } = setup({ money: 0 });
  const v = g.addVessel(p, { cls: 'coaster', harbor: 'rotterdam', fuel: 2 });
  setOrder(f, v, { type: 'sail_to', harbor: 'hamburg', then: 'moor' });
  await f.advance(v, 3);
  assert.equal(v.cap.phase, 'failed');
  assert.match(v.cap.why, /^needs \d+\.\d t of fuel, has 2\.0 t and the office cannot pay for bunkers \([\d,]+ cr\)$/);
  assert.ok(events(ws).some((t) => /Kittiwake: needs .* of fuel/.test(t)));
  p.money = 50000; f.m0.set(p.id, 50000);
  const C = SHIP_CLASSES.coaster, km = haversine(51.98, 4.03, 53.54, 9.93) / 1000;
  const need = serviceBurnTph('coaster', 0) * km / (serviceKn('coaster', 0) * 1.852) * 1.25 + serviceBurnTph('coaster', 0) * 2;
  const want = Math.min(C.fuelCap, need * 1.1) - 2;
  await f.advance(v, 601);
  assert.equal(v.docked, null, 'sailed after the re-check'); assert.equal(sum(p, 'fuel', v.id), -Math.round(want * 600));
  assert.ok(Math.abs(v.fuel - (2 + want)) < 0.5);
});

test('fuel exhausted at sea → towed to the nearest harbour, the tow booked as tugs; order kept', async () => {
  const { g, f, p } = setup();
  const v = g.addVessel(p, { cls: 'coaster', at: destination(IJ.lat, IJ.lon, 270, 25000), fuel: 0.0001 });
  setOrder(f, v, { type: 'route', route: [[52.465, 2.0]], then: 'hold' });
  const m0 = p.money; f.m0.set(p.id, m0);
  const units = haversine(v.ship.lat, v.ship.lon, IJ.lat, IJ.lon);
  await f.advance(v, 2);
  assert.equal(v.docked, 'ijmuiden');
  const tow = -sum(p, 'tugs', v.id);
  assert.ok(Math.abs(tow - (3000 + Math.round(units * 2))) <= 60, `tow ${tow}`);   // she made a few metres before the tanks ran dry
  assert.equal(sum(p, 'port', v.id), -461, 'the dues on arrival are port costs, not the tow');
  assert.equal(p.money, m0 - tow - 461 + sum(p, 'wages', v.id));
  assert.equal(v.orders.type, 'route', 'the order stands');
  void m0;
});

test('hull below 20 % at sea → she makes for the nearest harbour', async () => {
  const { g, f, p, ws } = setup();
  const v = g.addVessel(p, { cls: 'coaster', at: destination(IJ.lat, IJ.lon, 270, 40000) });
  setOrder(f, v, { type: 'route', route: [[52.465, 1.0]], then: 'hold' });
  v.cond = 19;
  await f.advance(v, 2);
  assert.equal(v.orders.type, 'sail_to'); assert.equal(v.orders.harbor, 'ijmuiden');
  assert.ok(events(ws).some((t) => /hull at 19 % — making for IJmuiden/.test(t)));
});

test('sinking: the fleet ship goes, a wreck holds her cargo, the office lists her as sunk; the person is untouched', async () => {
  const { g, f, p, ws } = setup();
  const v = g.addVessel(p, { cls: 'trawler', at: { lat: 54.21, lon: 3.05 } });
  v.cargo.push({ good: 'fish', qty: 12, contraband: false, jobId: null, caught: true });
  v.orders = { type: 'hold' }; v.cap.phase = 'anchored'; v.flooding = 1;
  const before = JSON.stringify(p.vessel);
  await f.advance(v, 1);
  assert.ok(!p.fleet.includes(v)); assert.ok(!f.vessels.has(v.id));
  assert.equal(g.wrecks.length, 1); assert.equal(g.wrecks[0].cargo[0].qty, 12); assert.equal(g.wrecks[0].owner, 'Ann');
  assert.equal(p.office.lost.at(-1).how, 'sunk');
  assert.equal(JSON.stringify(p.vessel), before);
  assert.ok(g.broadcasts.some((m) => m.t === 'chat' && /Ann's Stern trawler Kittiwake went down at 54\.21, 3\.05\. Her crew was taken off by the lifeboat\./.test(m.text)));
  assert.ok(events(ws).some((t) => /Kittiwake sank/.test(t)));
});

test('an owner away for 8 days: an anchored ship without other orders sails to the nearest harbour and moors', async () => {
  const { g, f, p } = setup();
  const v = g.addVessel(p, { cls: 'coaster', at: destination(IJ.lat, IJ.lon, 270, 15000) });
  v.orders = { type: 'hold' }; v.cap.phase = 'anchored';
  p.online = false; p.lastSeen = Date.now() - 8 * 86400e3;
  await f.advance(v, 1);
  assert.deepEqual(v.orders, { type: 'sail_to', harbor: 'ijmuiden', then: 'moor' });
  const t = await until(f, v, () => !!v.docked, 3 * 3600, 10);
  assert.ok(t > 0); assert.equal(v.docked, 'ijmuiden');
});

test('unpaid bills: no departure until paid; hold and stop are still allowed', async () => {
  const { g, f, p, ws } = setup();
  const v = g.addVessel(p, { cls: 'coaster', harbor: 'rotterdam' });
  p.office.owed = 100;
  f.onAction(p, { action: 'fleet_order', vesselId: v.id, order: { type: 'sail_to', harbor: 'ijmuiden' } });
  assert.equal(events(ws).at(-1), "Settle the office's unpaid bills first."); assert.equal(v.orders, null);
  f.onAction(p, { action: 'fleet_order', vesselId: v.id, order: { type: 'stop' } });
  assert.equal(v.orders, null);
  p.office.owed = 0;
  f.onAction(p, { action: 'fleet_order', vesselId: v.id, order: { type: 'sail_to', harbor: 'ijmuiden' } });
  p.office.owed = 50;
  await f.advance(v, 3);
  assert.equal(v.cap.phase, 'waiting'); assert.equal(v.cap.why, 'unpaid bills');
});

test('route plans: 6 per minute per owner, then "waiting for the navigator" and a retry in 10 s', async () => {
  const calls = [];
  const { g, f, p } = setup({ routePlanner: straightPlanner(calls) });
  const vs = [];
  for (let i = 0; i < 8; i++) vs.push(g.addVessel(p, { cls: 'pilot', at: { lat: 55 + i * 0.2, lon: 3 } }));
  for (const v of vs) setOrder(f, v, { type: 'sail_to', harbor: 'hamburg' });
  for (const v of vs) stepVessel(f, v, 1);
  await Promise.all(vs.map((v) => f.rtOf(v).pending));
  assert.equal(calls.length, 6);
  assert.equal(vs[7].cap.phase, 'waiting'); assert.equal(vs[7].cap.why, 'waiting for the navigator');
});

test('snapshot list: other skippers see fleet ships within 40 km (≤ 60, moving first); the aboard ship never', () => {
  const g = new FakeGame(); const { p: ann } = g.join('Ann'); const { p: bob } = g.join('Bob'); const f = g.fleet;
  bob.docked = null; Object.assign(bob.ship, { lat: 54.0, lon: 3.0 });
  const tr = g.addVessel(ann, { cls: 'trawler', at: destination(54, 3, 45, 10000) }); tr.orders = { type: 'hold' }; tr.cap.phase = 'anchored';
  ann.docked = null; Object.assign(ann.ship, destination(54, 3, 180, 5000));
  let list = f.viewFor(bob, false);
  assert.ok(!list.some((x) => x.id === tr.id), 'anchored ships only on full snapshots');
  list = f.viewFor(bob, true);
  const e = list.find((x) => x.id === tr.id);
  assert.equal(e.owner, 'Ann'); assert.equal(e.state, 'anchored');
  assert.ok(!list.some((x) => x.id === ann.aboard), "a person's own ship is in snap.players, never in snap.fleet");
  for (let i = 0; i < 70; i++) {
    const v = g.addVessel(ann, { cls: 'pilot', at: destination(54, 3, i * 5, 2000 + i * 300) });
    if (i >= 50) { v.orders = { type: 'hold' }; v.cap.phase = 'anchored'; } else v.cap.phase = 'sailing';
  }
  list = f.viewFor(bob, true);
  assert.equal(list.length, FLEET.VIEW_MAX);
  const firstStill = list.findIndex((x) => x.state !== 'at_sea');
  assert.ok(list.slice(0, firstStill).every((x) => x.state === 'at_sea') && firstStill === FLEET.VIEW_MOVING_MAX, `moving first (${firstStill})`);
  let fulls = 0; for (let i = 0; i < 20; i++) if (f.snapFull()) fulls++;
  assert.equal(fulls, 2, 'every 10th snapshot is full');
});

test('the fleet tick steps far ships once in 10 ticks and near ones every tick', () => {
  const g = new FakeGame(); const { p } = g.join('Ann'); const f = g.fleet;
  p.docked = null; Object.assign(p.ship, { lat: 52, lon: 4 });
  for (let i = 0; i < 100; i++) { const v = g.addVessel(p, { cls: 'pilot', at: { lat: 40 + (i % 10) * 0.5, lon: -30 - Math.floor(i / 10) } }); v.orders = { type: 'hold' }; v.cap.phase = 'anchored'; }
  for (let i = 0; i < 5; i++) { const v = g.addVessel(p, { cls: 'pilot', at: destination(52, 4, i * 60, 5000) }); v.orders = { type: 'hold' }; v.cap.phase = 'anchored'; }
  f.tick(0.1);
  assert.ok(f.perf.lastStepped <= Math.ceil(100 / 10) + 5 + 1, `stepped ${f.perf.lastStepped}`);
  assert.ok(f.perf.lastStepped >= 5);
});

test('a ship you sailed for hours starts her captained life with no banked time (clock, wages)', () => {
  const g = new FakeGame(); const { p } = g.join('Ann', { money: 100000 }); const f = g.fleet;
  const tr = g.addVessel(p, { cls: 'trawler' });
  f.switchShip(p, { vesselId: tr.id });
  p.docked = null; for (let i = 0; i < 3000; i++) { g.simTime += 0.1; f.tick(0.1); }   // 5 min aboard the trawler
  p.office.lastSwitchAt = 0; p.docked = 'rotterdam';
  const t0 = tr.shipTime, w0 = p.office.book.days;
  f.switchShip(p, { vesselId: p.fleet[0].id });
  for (let i = 0; i < 20; i++) { g.simTime += 0.1; f.tick(0.1); }
  assert.ok(tr.shipTime - t0 < 3, `her clock ran ${tr.shipTime - t0} s on the first captained steps`);
  void w0;
});

test('rate limit: 25 renames in a burst → at most 20 applied; malformed payloads never throw or change anything', () => {
  const g = new FakeGame(); const { p, ws } = g.join('Ann'); const f = g.fleet;
  const tr = g.addVessel(p, { cls: 'trawler' });
  let applied = 0, last = tr.name;
  for (let i = 0; i < 25; i++) { f.onAction(p, { action: 'fleet_rename', vesselId: tr.id, name: `Boat ${String.fromCharCode(65 + i)}${i}` }); if (tr.name !== last) { applied++; last = tr.name; } }
  assert.ok(applied <= FLEET.ACTION_BURST && applied >= 19, `applied ${applied}`);
  f.buckets.clear();
  const before = JSON.stringify(p.fleet);
  const bad = [{ action: 'fleet_order', vesselId: 5, order: { type: 'stop' } }, { action: 'fleet_order', vesselId: tr.id, order: 'x' }, { action: 'fleet_transfer', fromId: p.aboard, toId: tr.id, good: 'grain', qty: 'Infinity' },
    { action: 'fleet_order', vesselId: tr.id, order: { type: 'route', route: Array.from({ length: 300 }, () => [54, 3]) } }, { action: 'switch_ship' }, { action: 'fleet_sell', vesselId: { id: 1 } },
    { action: 'fleet_move_job', jobId: ['j1'], fromId: p.aboard, toId: tr.id }, { action: 'fleet_accept', vesselId: tr.id, jobId: 'j<x>' }, { action: 'fleet_home', harbor: 7 }, { action: 'fleet_service', vesselId: tr.id, what: 'magic' },
    { action: 'fleet_debug', op: 'money', amount: 1e9 }, null, { action: 'hq_watch' }];
  for (const m of bad) assert.doesNotThrow(() => f.onAction(p, m));
  const warn = ws.sent.filter((m) => m.t === 'event' && m.kind === 'warn').length;
  assert.ok(warn >= 9, `warn events ${warn}`);
  assert.equal(JSON.stringify(p.fleet), before);
  assert.ok(events(ws).includes('Unknown action fleet_debug'), 'debug actions only with SALTLINE_DEBUG=1');
});

// ------------------------------------------------------------------------------------------- phase 2: the real Game
/** What fleet_debug place does (the debug action itself needs SALTLINE_DEBUG=1). */
function place(g, v, lat, lon) { Object.assign(v.ship, { lat, lon, spd: 0, throttle: 0, rudder: 0 }); v.docked = null; v.dockedAt = null; v.berth = null; v.voyage = null; v.lastValid = { lat, lon }; setOrder(g.fleet, v, { type: 'hold' }); }
async function realGame(opts = {}) {
  const { Game } = await import('../server/game.js');
  const { World } = await import('../server/world.js');
  const { carvingsForWorld } = await import('../server/harbors.js');
  const { RoutePlanner } = await import('../server/routeworker.js');
  const { buildGraph } = await import('../server/lanes.js');
  process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
  const world = new World().load(carvingsForWorld(), () => {});
  const routePlanner = opts.fakePlanner ? straightPlanner() : new RoutePlanner({ world, graph: buildGraph(world), inline: true });
  const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-fleet-captain.json', routePlanner, ...opts }); g.saveState = () => {}; g.rnd = () => 0.5;
  const ws = { readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); }, close() {} };
  const p = g.connect(ws, null, 'Ann'); p.money = 1e6; g.tick(0.1);
  return { g, p, ws, world };
}
test('real game: world time — warp on the aboard ship does not change a captained ship\'s clock or burn', PHASE2, async () => {
  const { g, p } = await realGame({ fakePlanner: true });
  g.onAction(p, { action: 'buy_ship', cls: 'trawler', tradeIn: false });
  const tr = p.fleet[1]; place(g, tr, 54.5, 3);
  g.onAction(p, { action: 'undock' }); Object.assign(p.ship, { lat: 55.5, lon: 3 }); p.warp = 100;
  const t0 = tr.shipTime;
  for (let i = 0; i < 600; i++) { g.simTime += 0.1; g.fleet.tick(0.1); }
  const acc = g.fleet.rtOf(tr).acc;                 // far ships are stepped once in 10 ticks: the rest is still pending
  assert.ok(Math.abs(tr.shipTime + acc - t0 - 60) < 1e-6, `${tr.shipTime + acc - t0}`);
});
test('real game: sail_to IJmuiden with the inline planner — every sampled position floats her', PHASE2, async () => {
  const { g, p, world } = await realGame();
  g.onAction(p, { action: 'buy_ship', cls: 'trawler', tradeIn: false });
  const v = p.fleet[1]; const at = destination(IJ.lat, IJ.lon, 280, 20000);
  place(g, v, at.lat, at.lon);
  g.fleet.onAction(p, { action: 'fleet_order', vesselId: v.id, order: { type: 'sail_to', harbor: 'ijmuiden' } });
  for (let s = 0; s < 4 * 3600 && !v.docked; s += 1) {
    await g.fleet.advance(v, 1);
    const pen = g.landPenetration(v.ship.lat, v.ship.lon);
    assert.ok(pen === 0 || pen === null ? world.depthAt(v.ship.lat, v.ship.lon) + 3 >= SHIP_CLASSES.trawler.draft || pen === 0 : false, `aground at ${v.ship.lat},${v.ship.lon}`);
  }
  assert.equal(v.docked, 'ijmuiden');
});
test('real game: freight end to end with fleet_accept and the inline planner', PHASE2, async () => {
  const { g, p } = await realGame();
  g.onAction(p, { action: 'buy_ship', cls: 'trawler', tradeIn: false });
  const v = p.fleet[1];
  g.harbors.rotterdam.jobs.push({ id: 'jfr9', type: 'freight', from: 'rotterdam', to: 'ijmuiden', good: 'grain', qty: 100, pay: 9000, hours: 30, gen: 99, title: 'Freight 100 t of Grain to IJmuiden', expiresAt: g.simTime + 86400 });
  g.onAction(p, { action: 'fleet_accept', vesselId: v.id, jobId: 'jfr9' });
  for (let s = 0; s < 8 * 3600 && v.docked !== 'ijmuiden'; s += 1) await g.fleet.advance(v, 1);
  assert.equal(v.docked, 'ijmuiden'); assert.ok(sum(p, 'income', v.id) >= 9000);
});
const ROT_GEOM = new URL('../data/geom/', import.meta.url).pathname;
const haveRot = fs.existsSync(ROT_GEOM + 'rotterdam.bin') && fs.existsSync(ROT_GEOM + 'rotterdam.json');
test('real game: a captain berths with the cached Rotterdam tugs at a berth nobody else holds; tickTugs keeps her op', haveRot ? PHASE2 : { skip: 'no cached Rotterdam geometry' }, async () => {
  const os = await import('node:os'), path = await import('node:path');
  const TP = await import('../server/tugpath.js');
  const { tugOp } = await import('../server/tugassist.js');
  const { Game } = await import('../server/game.js');
  const { World } = await import('../server/world.js');
  const { carvingsForWorld } = await import('../server/harbors.js');
  process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
  const world = new World().load(carvingsForWorld(), () => {});
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'saltline-fleet-tugs-'));
  fs.mkdirSync(path.join(tmp, 'geom'));
  for (const f of ['rotterdam.json', 'rotterdam.bin']) fs.copyFileSync(ROT_GEOM + f, path.join(tmp, 'geom', f));
  const hg = await import('../server/harborgeom.js');
  hg.configure({ dataDir: tmp, offline: true, preload: false, log: () => {} });
  hg.init(world);
  try {
    assert.ok(await hg.ensureHarbor('rotterdam'));
    const grid = TP.gridFromPatch(hg.getHarborPatch('rotterdam'));
    const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-fleet-tugs.json', harborgeom: hg, routePlanner: straightPlanner() }); g.saveState = () => {}; g.rnd = () => 0.5;
    const p = g.connect({ readyState: 1, sent: [], send() {}, close() {} }, null, 'Ann'); p.money = 1e6; g.tick(0.1);
    g.onAction(p, { action: 'buy_ship', cls: 'trawler', tradeIn: false });
    const v = p.fleet[1];
    assert.ok(v.berth && v.berth.id && v.berth.id !== p.berth?.id, 'delivered at a free berth');
    const a = hg.getHarborGeom('rotterdam').anchor, [ax, az] = TP.toXZ(grid, a.lat, a.lon), st = TP.toLL(grid, ax - 560, az + 200);
    place(g, v, st.lat, st.lon); v.ship.hdg = 90;
    g.fleet.onAction(p, { action: 'fleet_order', vesselId: v.id, order: { type: 'sail_to', harbor: 'rotterdam' } });
    let t = 0, sawOp = false;
    while (!v.docked && t < 1800) { g.tick(0.5); t += 0.5; await Promise.resolve(); const op = tugOp(g, v.id); if (v.assist && op) { sawOp = true; assert.notEqual(op.phase, 'return', 'tickTugs keeps a captain\'s op'); } }
    assert.ok(sawOp, 'the harbour tugs took her'); assert.equal(v.docked, 'rotterdam'); assert.ok(v.berth?.id);
    const others = [...g.fleet.vessels.values()].filter((x) => x !== v && x.docked === 'rotterdam' && x.berth?.id).map((x) => x.berth.id);
    assert.ok(!others.includes(v.berth.id), `berth ${v.berth.id} is hers alone`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
