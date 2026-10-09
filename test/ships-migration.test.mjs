// docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §9 test 6 / §8: old saves load; spec/hist healed; values unchanged; listings
// regenerated with history; jobs untouched. Phase 1: the heal helpers are applied the way H8 will call them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { carvingsForWorld, harborById } from '../server/harbors.js';
import { Game } from '../server/game.js';
import { Yard } from '../server/yard.js';
import { shipValue, portDues, demandBonus } from '../server/economy.js';
import { healShipsVessel, healOrders, healHarborYard, marketValue, shipValueCompat, defaultLivery, validLivery, newOrder } from '../shared/ships/index.js';

process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
const world = new World().load(carvingsForWorld(), () => {});
function fakeSocket() { const s = { readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); }, close() {} }; return s; }
function mkGame(opts = {}) { const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-test-state.json', ...opts }); g.saveState = () => {}; return g; }
function join(g, name) { const ws = fakeSocket(); const p = g.connect(ws, null, name); return { p, ws }; }
const NOW = Date.UTC(2026, 9, 9, 12) / 1000;

// v6/v7 vessel records as saved today (no spec, no hist; politics fields present on v7 saves)
const SAVE = [
  { id: 'v0001', name: 'Sea Bee', ship: { cls: 'coaster', lat: 51.98, lon: 4.03 }, cond: 78, fuel: 40, cargo: [], jobs: [] },
  { id: 'v0002', name: 'Big Box', ship: { cls: 'boxship', lat: 51.98, lon: 4.03 }, cond: 64, fuel: 2000, cargo: [{ good: 'grain', qty: 300 }], jobs: [], built: 2014, builtIn: 'XX', flag: { cc: 'NL', registry: 'national:NL', since: 0 } },
  { id: 'v0003', name: 'Puffin', ship: { cls: 'sloop', lat: 51.98, lon: 4.03, rig: {} }, cond: 91, fuel: 0.1, cargo: [], jobs: [] },
];

test('spec and hist healed on old vessels; cls, money fields and cargo untouched; values unchanged', () => {
  for (const rec of SAVE) {
    const v = structuredClone(rec), before = structuredClone(rec);
    healShipsVessel(v, NOW);
    assert.equal(v.ship.cls, before.ship.cls); assert.deepEqual(v.cargo, before.cargo); assert.equal(v.cond, before.cond); assert.equal(v.fuel, before.fuel);
    assert.deepEqual(v.spec, { v: 1, model: rec.ship.cls, opts: {}, livery: defaultLivery(rec.ship.cls) });
    assert.ok(validLivery(v.spec.livery));
    assert.equal(v.hist.estimated, true); assert.equal(v.hist.builtIn, 'XX'); assert.equal(v.hist.jonesLost, false); assert.equal(v.hist.owners, 1);
    assert.equal(v.hist.built, rec.built ?? 2026 - Math.round((100 - rec.cond) / 3.5));
    assert.equal(shipValueCompat(rec.ship.cls, rec.cond), shipValue(rec.ship.cls, rec.cond), 'shipValue wrapper = today');
    if (rec.ship.cls !== 'coaster') assert.equal(marketValue(v, null, NOW), shipValue(rec.ship.cls, rec.cond));
    const again = structuredClone(v); healShipsVessel(again, NOW); assert.deepEqual(again, v, 'idempotent');
  }
  assert.equal(marketValue(healShipsVessel(structuredClone(SAVE[0]), NOW), 'US', NOW), 55836, 'coaster with the D12 basis; never Jones (unknown build)');
});

test('office.orders: [] on old saves; saved orders survive a JSON round trip; malformed ones dropped', () => {
  assert.deepEqual(healOrders({ home: 'rotterdam' }).orders, []);
  const o = newOrder({ id: 'oabc1', ownerId: 'p1', variant: 'ultramax64~lng', yard: 'yzj', createdAt: NOW });
  const office = JSON.parse(JSON.stringify({ home: 'rotterdam', orders: [o, { id: 'obad', variant: 'nosuch', yard: 'yzj', schedule: [], state: 'ordered' }, null] }));
  healOrders(office);
  assert.equal(office.orders.length, 1); assert.deepEqual(office.orders[0], JSON.parse(JSON.stringify(o)));
});

test('harbour state: legacy used lists stay for old clients, the new market regenerates with history at the first visit', () => {
  const g = mkGame(); const y = new Yard(g);
  const st = g.harbors.rotterdam;
  st.used = [{ id: 'u1', cls: 'feeder', cond: 70, price: 500000, name: 'Container feeder', specs: {} }];
  st.yardUsed = [{ id: 'u-old', cls: 'feeder' }];
  healHarborYard(st);
  assert.equal(st.usedAt, 0); assert.deepEqual(st.yardUsed, []); assert.equal(st.used.length, 1, 'legacy list kept one release');
  const list = y.listingsAt(harborById('rotterdam'));
  assert.equal(list.length, 8);
  for (const l of list) {
    assert.equal(l.v, 2); assert.ok(l.hist.yard && l.hist.builtIn && l.hist.class && l.hist.flags.length >= 1 && Number.isFinite(l.hist.built));
    assert.ok(l.condLo <= l.cond && l.cond <= l.condHi && l.condHi - l.condLo <= 20);
  }
  assert.deepEqual(y.listingsAt(harborById('rotterdam')), list, 'stable inside the refresh window');
});

test('an accepted gen-7 freight contract still pays as before after the heal', () => {
  const g = mkGame(); const { p } = join(g, 'Bob'); const y = new Yard(g);
  const st = g.harbors.rotterdam;
  const job = { id: 'jfr1', type: 'freight', from: 'rotterdam', to: 'ijmuiden', good: 'grain', qty: 400, pay: 9000, distKm: 60, deadline: g.simTime + 36000, contraband: false, title: 'Freight 400 t of grain to IJmuiden', gen: 7 };
  st.jobs.push(job);
  g.onAction(p, { action: 'accept_job', jobId: job.id });
  assert.equal(p.jobs.length, 1);
  const jobsBefore = structuredClone(p.jobs);
  y.heal(p);
  assert.deepEqual(p.jobs, jobsBefore); assert.ok(p.vessel.spec && p.vessel.hist); assert.deepEqual(p.office.orders, []);
  g.onAction(p, { action: 'undock' });
  const dest = harborById('ijmuiden'); p.ship.lat = dest.lat; p.ship.lon = dest.lon; p.ship.spd = 0;
  const bonus = Math.round(job.pay * demandBonus(g.harbors[dest.id], job.good));
  const m0 = p.money; g.onAction(p, { action: 'dock' });
  assert.equal(p.docked, dest.id); assert.equal(p.jobs.length, 0);
  assert.equal(p.money, m0 + job.pay + bonus - portDues('coaster', dest));
});
