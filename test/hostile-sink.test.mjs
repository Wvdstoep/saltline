// Combat outcomes (contract R10-R13): a hand-sailed ship shot to 0 % sinks through the existing flow (wreck, jobs lost, raft,
// rescue, coaster excess), ships under automatic sailing stop at 1 % and are held, the free paths keep their 1 % floor, express
// encounters, and the wire format.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHIP_CLASSES } from '../shared/constants.js';
import { HOSTILE } from '../shared/hostile.js';
import { harborById } from '../server/harbors.js';
import { isAutoSailed } from '../server/hostile.js';
import { mkGame, atSea, SPOTS, rig, run, forceSpawn, events, lastYou } from './hostile-helpers.mjs';

const text = (ws) => events(ws).join('\n');
const CARGO = () => [{ good: 'grain', qty: 400, contraband: false, jobId: null }, { good: 'steel', qty: 100, contraband: false, jobId: 'jx' }];
const CONTRA = () => [{ good: 'weapons', qty: 10, contraband: true, jobId: null }, { good: 'grain', qty: 200, contraband: false, jobId: null }];

test('pirates finish a crippled hand-sailed ship: sink flow with wreck, lost contracts, raft, rescue and a "sunk by pirates" news line', () => {
  const g = mkGame(), { p, ws } = atSea(g, 'Ann', SPOTS.gog, { kn: 14, cargo: CARGO() });
  p.cond = 0.3; p.jobs = [{ id: 'jx', type: 'freight', to: 'lagos' }];
  const enc = forceSpawn(g, p); rig(g, [], 0.1);
  const sunk0 = p.stats.sunk;
  assert.ok(run(g, 900, { until: () => !!p.rescue }), 'the ship went down');
  assert.equal(p.cond, 0); assert.equal(p.flooding, 1);
  assert.equal(p.stats.sunk, sunk0 + 1);
  assert.equal(g.wrecks.length, 1); assert.equal(g.wrecks[0].owner, 'Ann'); assert.equal(g.wrecks[0].cargo.length, 2, 'cargo to a salvageable wreck');
  assert.deepEqual(p.cargo, []); assert.deepEqual(p.jobs, []);
  assert.ok(p.rescue && g.rescues.length === 1);
  assert.match(text(ws), /Your coastal freighter was sunk by pirates with 1 contract\(s\)\. The crew is in the life raft; a rescue craft is on its way\./);
  assert.match(text(ws), /launched\. ETA/);
  const news = ws.sent.filter((m) => m.t === 'chat' && m.from === 'Shipping news').map((m) => m.text).join('\n');
  assert.match(news, /Ann's Coastal freighter was sunk by pirates at 2\.\d\d, 5\.\d\d\. Crew rescued/);
  assert.equal(g.hostiles.attackerOf(p.id), null, 'the attackers leave');
  assert.ok(enc.st === 'leave' || g.hostiles.encs.length === 0);
  assert.equal(g.hostiles.stats.sunk, 1);
});

test('the rescue lands the skipper at the nearest harbour and gives the 2,000 cr excess coaster; lifeboat inside 40 km, helicopter beyond', () => {
  const g = mkGame(), { p } = atSea(g, 'Ann', SPOTS.sgstrait, { kn: 14, cargo: CARGO() });
  p.cond = 0.2; p.ship.cls = 'feeder';
  const enc = forceSpawn(g, p); rig(g, [], 0.1);
  run(g, 900, { until: () => !!p.rescue });
  const r = g.rescues[0]; assert.ok(r);
  const { harbor, units } = g.nearestHarbor(p.ship.lat, p.ship.lon);
  assert.equal(r.from, harbor.id); assert.equal(r.kind, units < 40000 ? 'lifeboat' : 'helicopter');
  const money0 = p.money;
  r.eta = Date.now() - 1; g.updateRescues(0.1);
  assert.equal(p.rescue, null); assert.equal(p.docked, harbor.id);
  assert.equal(p.ship.cls, 'coaster'); assert.equal(p.cond, 70); assert.equal(money0 - p.money, 2000);
  assert.ok(p.risk.last > 0, 'respawn cooldown running');
  void enc;
  // far offshore → helicopter
  const g2 = mkGame(), b = atSea(g2, 'Bo', { lat: 0, lon: 52 }, { kn: 14, cargo: CARGO() });
  b.p.cond = 0.2; forceSpawn(g2, b.p); rig(g2, [], 0.1);
  run(g2, 900, { until: () => !!b.p.rescue });
  assert.equal(g2.rescues[0].kind, 'helicopter');
});

test('naval gunfire can sink a hand-sailed ship in a war area with the navy line in the news; the free hull never reaches 0 % any other way', () => {
  const g = mkGame(), { p, ws } = atSea(g, 'Ann', SPOTS.redsea, { kn: 10, cargo: CONTRA() });
  p.cond = 4;
  forceSpawn(g, p, { queue: [0.0001, 0.9, 0.5, 0.5, 0.5] }); rig(g, [], 0.1);
  assert.ok(run(g, 900, { until: () => !!p.rescue }));
  assert.match(text(ws), /sunk by naval gunfire/);
  const news = ws.sent.filter((m) => m.t === 'chat' && m.from === 'Shipping news').map((m) => m.text).join('\n');
  assert.match(news, /sunk by naval gunfire/);
  assert.equal(g.wrecks.length, 1);
});

test('a ship under automatic sailing (set voyage) is taken to 1 % at most: hands up, searched or boarded, held, never sunk', () => {
  const g = mkGame(), { p, ws } = atSea(g, 'Ann', SPOTS.redsea, { kn: 10, cargo: CONTRA() });
  p.cond = 3; p.voyage = { route: [[18, 41]], i: 0, throttle: 0.7 };
  assert.equal(isAutoSailed(p), true);
  const enc = forceSpawn(g, p, { queue: [0.0001, 0.9, 0.5, 0.5, 0.5] }); rig(g, [], 0.1);
  run(g, 900, { until: () => enc.st === 'leave' });
  assert.equal(p.cond, 1, 'exactly 1 %'); assert.equal(p.flooding, 0); assert.equal(p.rescue, undefined);
  assert.equal(g.wrecks.length, 0); assert.equal(g.rescues.length, 0);
  assert.match(text(ws), /your crew stops the engine and raises their hands/);
  assert.equal(g.politics.vesselOf(p).held.why, 'detention', 'searched and held');
  assert.ok(!p.cargo.some((c) => c.contraband));
  // the same for pirates: comply boarding
  const h = mkGame(), b = atSea(h, 'Bo', SPOTS.gog, { kn: 12, cargo: CARGO() });
  b.p.cond = 1.1; b.p.voyage = { route: [[2, 6]], i: 0, throttle: 0.7 };
  const e2 = forceSpawn(h, b.p); rig(h, [], 0.1);
  run(h, 900, { until: () => e2.st === 'leave' });
  assert.equal(b.p.cond, 1); assert.equal(b.p.flooding, 0); assert.ok(!b.p.rescue);
  assert.match(text(b.ws), /raises their hands/);
});

test('the same ship sailed by hand under the same fire does sink: the exception is only for automatic sailing', () => {
  const g = mkGame(), { p } = atSea(g, 'Ann', SPOTS.redsea, { kn: 10, cargo: CONTRA() });
  p.cond = 3;
  forceSpawn(g, p, { queue: [0.0001, 0.9, 0.5, 0.5, 0.5] }); rig(g, [], 0.1);
  assert.ok(run(g, 900, { until: () => !!p.rescue }));
});

test('free paths keep the 1 % floor with risk on: wear under a voyage, offline voyage, repelled approach', () => {
  const g = mkGame(), { p } = atSea(g, 'Ann', SPOTS.gog, { kn: 12 });
  p.cond = 1.001; p.voyage = { route: [[2, 6]], i: 0, throttle: 0.7 };
  g.stepAtSea(p, 500);
  assert.ok(p.cond >= 1 - 1e-9 && p.cond <= 1.001, `wear under a voyage: ${p.cond}`);
  const pol = g.politics, v = pol.vesselOf(p); p.cond = 2;
  pol.piracy(p, v, pol.ds.areaById['piracy-gog'], 'repelled');
  assert.equal(p.cond, 1, 'a repelled approach takes at most down to 1 %');
  p.cond = 90; pol.piracy(p, v, pol.ds.areaById['piracy-gog'], 'repelled'); assert.equal(p.cond, 87);
  // a hand-sailing skipper can still wear the hull to 0 (lead's rule) when no voyage is set
  const h = atSea(g, 'Hand', SPOTS.open, { kn: 12 }); h.p.cond = 0.0001; delete h.p.voyage;
  g.stepAtSea(h.p, 500); assert.equal(h.p.cond, 0);
});

// ---- express passage (R13): abstract encounters, never sunk, hull ≥ 1 %
function expressSetup(spot, dest, opts = {}) {
  const g = mkGame(), s = atSea(g, 'Ann', spot, { kn: 0, ...opts });
  g.expressPatchesToBuild = () => []; g.expressArrival = (p, lat, lon) => ({ ok: true, lat, lon, hdg: 0 });
  return { g, ...s, dest };
}
test('express passage through a piracy area with risk ON rolls an abstract encounter (robbery / hijack hold), hull untouched', () => {
  const { g, p, ws } = expressSetup(SPOTS.gog, { lat: 2, lon: 8.5 }, { cargo: CARGO() });
  rig(g, [0.0001, 0.99], 0.5);                          // encounter roll, kind roll → hijack
  const money0 = p.money; p.cond = 100;
  g.expressPassage(p, 2, 8.5);
  assert.match(text(ws), /Express passage:/);
  assert.match(text(ws), /was held .* Crew safe\./);
  assert.equal(g.politics.vesselOf(p).held.why, 'hijack');
  assert.ok(p.cond <= 100 && p.cond >= 1);
  assert.equal(g.hostiles.attacksToday(p), 1);
  assert.equal(g.hostiles.encs.length, 0, 'no ships are spawned for an express passage');
  assert.ok(money0 > p.money);
});
test('express passage with risk OFF, a daily cap reached, or a recent respawn: no encounter', () => {
  for (const mut of [(p) => { p.risk.on = false; }, (p, g) => { p.risk.n = 3; p.risk.day = new Date(g.simTime * 1000).toISOString().slice(0, 10); }, (p, g) => { p.risk.last = g.simTime - 60; }]) {
    const { g, p, ws } = expressSetup(SPOTS.gog, null, { cargo: CARGO() });
    mut(p, g); rig(g, [], 0.0001);
    g.expressPassage(p, 2, 8.5);
    assert.doesNotMatch(text(ws), /was held|robbers boarded/);
  }
});
test('express passage through a war area with banned cargo: naval search at sea (seizure + hold), hull never touched, never sunk', () => {
  const { g, p, ws } = expressSetup(SPOTS.redsea, null, { cargo: CONTRA() });
  p.cond = 1.5; rig(g, [0.99, 0.0001], 0.5);           // the dataset's own dice roll misses, the naval check hits
  g.expressPassage(p, 26, 35.5);
  assert.match(text(ws), /A naval patrol stops your express passage/);
  assert.match(text(ws), /seized 10 t/);
  assert.ok(p.cond >= 1 && p.cond <= 1.5, 'only the passage wear, floored at 1 %');
  assert.ok(!p.cargo.some((c) => c.contraband)); assert.ok(!p.rescue);
  assert.equal(g.politics.vesselOf(p).held.why, 'detention');
});

// ---- wire
test('snapshot carries hostiles only while there are some; you.hostile is the banner state with the options', () => {
  const g = mkGame(), { p, ws } = atSea(g, 'Ann', SPOTS.gog, { kn: 8, cargo: CARGO() });
  assert.equal(g.snapshot().hostiles, undefined);
  const enc = forceSpawn(g, p); rig(g, [], 0.5);
  const list = g.snapshot().hostiles;
  assert.equal(list.length, 1);
  assert.deepEqual(Object.keys(list[0]).sort(), ['f', 'hdg', 'id', 'ident', 'k', 'lat', 'lon', 'spd', 'st']);
  assert.equal(list[0].f, 'pirate'); assert.equal(list[0].k, 'skiff');
  g.sendYou(p);
  const y = lastYou(ws);
  assert.equal(y.hostile.f, 'pirate'); assert.equal(y.hostile.label, 'Unknown fast craft'); assert.equal(y.hostile.ident, false);
  assert.ok(y.hostile.dist > 2000); assert.ok(y.hostile.ransom >= HOSTILE.RANSOM_MIN); assert.equal(y.hostile.hose, HOSTILE.HOSE_USES);
  assert.deepEqual({ on: y.risk.on, today: y.risk.today }, { on: true, today: 1 });
  run(g, 600, { until: () => enc.units[0].ident });
  g.broadcastSnapshot();
  const snap = [...ws.sent].reverse().find((m) => m.t === 'snap');
  assert.equal(snap.hostiles[0].name, 'Pirate skiff');
});
test('class sizes: the damage model scales with the hull so a container ship shrugs off what hurts a coaster', async () => {
  const { damageFor } = await import('../shared/hostile.js');
  const small = damageFor('gun_76', 2000, 0.5, 0.1, SHIP_CLASSES.coaster.displacement), big = damageFor('gun_76', 2000, 0.5, 0.1, SHIP_CLASSES.boxship.displacement);
  assert.ok(small > 0 && big > 0 && big < small * 0.5);
  assert.equal(damageFor('gun_76', 7000, 0.5, 0.1), 0, 'out of reach');
  assert.equal(damageFor('gun_76', 2000, 0.5, 0.99), 0, 'a miss');
  assert.equal(damageFor('warning', 100, 0.5, 0.0), 0, 'warning shots never damage');
  void harborById;
});
