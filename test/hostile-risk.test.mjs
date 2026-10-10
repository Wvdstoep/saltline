// Hostile AI ships, risk option and spawn rules (docs/HOSTILE-AI-CONTRACT.md R1-R3): risk off = no attacks, the conditions a
// hostile may spawn under, caps, cooldowns, the warp rule, per-day limit and save compatibility.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Game } from '../server/game.js';
import { HARBORS } from '../server/harbors.js';
import { healRisk } from '../server/hostile.js';
import { HOSTILE, dayKey } from '../shared/hostile.js';
import { areasAt } from '../shared/politics.js';
import { destination, haversine } from '../shared/geo.js';
import { world, mkGame, atSea, SPOTS, rig, run, forceSpawn, events, lastYou } from './hostile-helpers.mjs';

test('the test spots really lie in the dataset areas (and open water)', () => {
  const g = mkGame(), ds = g.politics.ds;
  for (const k of ['gog', 'somali', 'sgstrait']) { assert.ok(world.isWater(SPOTS[k].lat, SPOTS[k].lon), k); assert.equal(areasAt(ds, SPOTS[k].lat, SPOTS[k].lon, ['piracy'], g.simTime).length, 1, k); }
  assert.equal(areasAt(ds, SPOTS.redsea.lat, SPOTS.redsea.lon, ['war_risk'], g.simTime)[0].tier, 3);
  assert.equal(areasAt(ds, SPOTS.open.lat, SPOTS.open.lon, ['piracy', 'war_risk'], g.simTime).length, 0);
});

test('risk OFF is the default and nothing ever attacks: two sim hours in the Gulf of Guinea, every roll a hit', () => {
  const g = mkGame(), { p } = atSea(g, 'Ann', SPOTS.gog, { kn: 9, risk: false });
  const fresh = g.connect({ readyState: 1, sent: [], send() {}, close() {} }, null, 'New');
  assert.equal(fresh.risk.on, false, 'default off');
  assert.equal(g.hostiles.spawnBlock(p), 'risk off');
  rig(g, [], 0.0001);
  assert.equal(g.hostiles.trySpawn(p), null);
  run(g, 7200, { dt: 5 });
  assert.equal(g.hostiles.encs.length, 0);
  assert.equal(g.hostiles.stats.spawned, 0);
  assert.equal(p.cond, 100);
});

test('risk_set action turns the option on and off, tells the player what can happen, and shows in you.risk', () => {
  const g = mkGame(), { p, ws } = atSea(g, 'Ann', SPOTS.gog, { risk: false });
  g.onAction(p, { action: 'risk_set', on: true });
  assert.equal(p.risk.on, true);
  assert.match(events(ws).at(-1), /Risk mode ON: pirates and naval patrols can appear and attack/);
  assert.deepEqual({ on: lastYou(ws).risk.on, max: lastYou(ws).risk.max }, { on: true, max: HOSTILE.MAX_ATTACKS_PER_DAY });
  forceSpawn(g, p); assert.equal(g.hostiles.encs.length > 0, true);
  g.onAction(p, { action: 'risk_set', on: false });
  assert.equal(p.risk.on, false);
  assert.equal(g.hostiles.encs.length, 0, 'switching off removes the hostiles');
  assert.match(events(ws).at(-1), /Risk mode OFF/);
});

test('spawn conditions: inside a piracy area yes; open sea, docked, offline, warp > 5x, next to a harbour no', () => {
  const g = mkGame();
  const a = atSea(g, 'A', SPOTS.gog); assert.ok(forceSpawn(g, a.p), 'inside the Gulf of Guinea');
  g.hostiles.encs.length = 0;
  const b = atSea(g, 'B', SPOTS.open); assert.equal(forceSpawn(g, b.p), null, 'North Sea');
  const c = atSea(g, 'C', SPOTS.gog); c.p.docked = 'rotterdam'; assert.equal(g.hostiles.spawnBlock(c.p), 'not at sea');
  const d = atSea(g, 'D', SPOTS.gog); d.p.online = false; assert.equal(g.hostiles.spawnBlock(d.p), 'offline');
  const e = atSea(g, 'E', { lat: SPOTS.gog.lat + 0.3, lon: SPOTS.gog.lon }); e.p.warp = 20; assert.equal(g.hostiles.spawnBlock(e.p), 'warp');
  e.p.warp = 5; assert.equal(g.hostiles.spawnBlock(e.p), null, 'warp 5x is allowed');
  const h = HARBORS.find((x) => x.id === 'rotterdam');
  const f = atSea(g, 'F', { lat: h.lat, lon: h.lon }); assert.equal(g.hostiles.spawnBlock(f.p), 'harbour');
});

test('near a danger area (within 30 km) pirates can come, at a reduced rate; far away no', () => {
  const g = mkGame(), ds = g.politics.ds;
  // walk east out of the Somali Basin along the equator until the point is outside but within 30 km
  let edge = null;
  for (let lon = 54.0; lon < 56; lon += 0.02) if (areasAt(ds, 0, lon, ['piracy'], g.simTime).length === 0) { edge = lon; break; }
  assert.ok(edge, 'found the eastern edge');
  const out = destination(0, edge, 90, 10000);
  const d = g.hostiles.dangerAt(out.lat, out.lon);
  assert.equal(d.inside, false); assert.equal(d.piracy?.id, 'piracy-somali-basin');
  const far = destination(0, edge, 90, 150000);
  assert.equal(g.hostiles.dangerAt(far.lat, far.lon).piracy, null);
  // reduced rate: a roll between 0.4x and 1x of the inside probability spawns inside but not near
  const inside = atSea(g, 'In', { lat: 0, lon: 52 }, { kn: 9 }), near = atSea(g, 'Near', out, { kn: 9 });
  const prey = g.hostiles.preyOf(inside.p);
  const area = ds.areaById['piracy-somali-basin'];
  const rate = area.p100 * HOSTILE.PIRACY_K * prey;
  const pIn = 1 - Math.exp(-rate * HOSTILE.SPAWN_CHECK_S / 3600), pNear = 1 - Math.exp(-rate * 0.4 * HOSTILE.SPAWN_CHECK_S / 3600);
  const roll = (pIn + pNear) / 2;
  rig(g, [roll], 0.5); assert.equal(g.hostiles.trySpawn(near.p), null, 'near: roll above the reduced chance');
  rig(g, [roll, 0.1, 0.5, 0.5, 0.9], 0.5); assert.ok(g.hostiles.trySpawn(inside.p), 'inside: same roll spawns');
});

test('ships that outrun skiffs are not targeted: a 24 kn ship scores 0, a slow laden one scores high', () => {
  const g = mkGame();
  const fast = atSea(g, 'Fast', SPOTS.gog, { kn: 24 }), slow = atSea(g, 'Slow', SPOTS.gog, { kn: 6 });
  assert.equal(g.hostiles.preyOf(fast.p), 0);
  assert.ok(g.hostiles.preyOf(slow.p) > 0.6);
  assert.equal(forceSpawn(g, fast.p), null, 'even with every roll a hit');
  assert.ok(forceSpawn(g, slow.p));
});

test('caps: 3 units per skipper, 12 global; at most 3 attacks per sim day; 20 min between encounters', () => {
  const g = mkGame(), { p } = atSea(g, 'Ann', SPOTS.gog, { kn: 6 });
  p.risk = healRisk({ on: true });
  assert.equal(g.hostiles.spawnBlock(p), null);
  // per-skipper cap: a group never exceeds 3 units, whatever the roll
  const enc = forceSpawn(g, p, { group: 0.99 }); assert.equal(enc.units.length, 3);
  assert.equal(g.hostiles.spawnBlock(p), 'busy');
  g.hostiles.encs.length = 0;
  // global cap
  const others = Array.from({ length: 4 }, (_, i) => atSea(g, 'O' + i, SPOTS.gog));
  for (const o of others) { const e = g.hostiles.newEnc(o.p, 'pirate', 'hostile', null); for (let k = 0; k < 3; k++) e.units.push(g.hostiles.makeUnit(e, 'skiff', { lat: 1, lon: 1 }, 0)); }
  assert.equal(g.hostiles.unitCount(), 12);
  assert.equal(g.hostiles.spawnBlock(p), 'global cap');
  g.hostiles.encs.length = 0;
  // daily cap and the encounter gap
  p.risk = healRisk({ on: true, day: dayKey(g.simTime), n: HOSTILE.MAX_ATTACKS_PER_DAY });
  assert.equal(g.hostiles.spawnBlock(p), 'daily cap');
  g.simTime += 86400; assert.equal(g.hostiles.spawnBlock(p), null, 'a new sim day resets the count');
  p.risk.lastEnc = g.simTime - 60; assert.equal(g.hostiles.spawnBlock(p), 'encounter gap');
  p.risk.lastEnc = g.simTime - HOSTILE.ENCOUNTER_GAP_S - 1; assert.equal(g.hostiles.spawnBlock(p), null);
  // every spawn counts as an attack today
  const before = g.hostiles.attacksToday(p); p.risk.lastEnc = 0; forceSpawn(g, p); assert.equal(g.hostiles.attacksToday(p), before + 1);
});

test('anti-grief: a rescue landing or a forced reset stops hostile spawns for 2 h', () => {
  const g = mkGame(), { p } = atSea(g, 'Ann', SPOTS.gog, { kn: 6 });
  p.cond = 0; p.flooding = 1; g.sink(p);
  const r = g.rescues[0]; assert.ok(r);
  g.finishRescue(p, r);
  assert.ok(p.risk.last > 0);
  Object.assign(p, { docked: null }); Object.assign(p.ship, { lat: SPOTS.gog.lat, lon: SPOTS.gog.lon });
  assert.equal(g.hostiles.spawnBlock(p), 'respawn cooldown');
  g.simTime += HOSTILE.RESPAWN_COOLDOWN_S + 1;
  assert.equal(g.hostiles.spawnBlock(p), null);
  g.forcedReset(p, 'Test.'); assert.ok(p.risk.last >= g.simTime);
});

test('a hostile appearing drops time warp to real time; a warp above 5x never spawns one', () => {
  const g = mkGame(), { p, ws } = atSea(g, 'Ann', SPOTS.gog, { kn: 6 });
  p.warp = 5;
  assert.ok(forceSpawn(g, p));
  assert.equal(p.warp, 1);
  assert.ok(events(ws).some((t) => /Time warp off \(5× → 1×\)/.test(t)));
  assert.match(g.warpConditions(p), /hostile ships are close/);
  g.hostiles.encs.length = 0; p.risk.lastEnc = 0; p.risk.n = 0;
  p.warp = 100;
  assert.equal(g.hostiles.spawnBlock(p), 'warp');
});

test('the periodic check only looks at online skippers with risk on (offline players are never attacked)', () => {
  const g = mkGame(), on = atSea(g, 'On', SPOTS.gog, { kn: 6 }), off = atSea(g, 'Off', SPOTS.somali, { kn: 6 });
  off.p.online = false; off.p.voyage = { route: [[0, 60]], i: 0, throttle: 0.7 };
  rig(g, [], 0.0001);
  g.hostiles.checkT = HOSTILE.SPAWN_CHECK_S;
  g.hostiles.tick(0.1);
  assert.ok(g.hostiles.encs.some((e) => e.pid === on.p.id));
  assert.ok(!g.hostiles.encs.some((e) => e.pid === off.p.id));
});

test('save compatibility: healRisk, old saves without p.risk load with risk OFF, and the choice survives a save', () => {
  assert.deepEqual(healRisk(undefined), { on: false, day: '', n: 0, last: 0, lastEnc: 0 });
  assert.deepEqual(healRisk({ on: 'yes', n: -3, day: 5 }), { on: false, day: '', n: 0, last: 0, lastEnc: 0 });
  assert.deepEqual(healRisk({ on: true, day: '2026-10-10', n: 2, last: 5, lastEnc: 6 }), { on: true, day: '2026-10-10', n: 2, last: 5, lastEnc: 6 });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'slhostile-')), 'state.json');
  const g1 = new Game(world, () => {}, { stateFile: file });
  const { p } = atSea(g1, 'Ann', SPOTS.gog); p.risk = healRisk({ on: true, day: '2026-10-10', n: 2 });
  g1.saveState();
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.players[0].risk.on, true);
  const g2 = new Game(world, () => {}, { stateFile: file });
  assert.equal([...g2.players.values()][0].risk.on, true, 'the choice survives');
  assert.equal([...g2.players.values()][0].risk.n, 2);
  delete saved.players[0].risk; fs.writeFileSync(file, JSON.stringify(saved));
  const g3 = new Game(world, () => {}, { stateFile: file });
  const q = [...g3.players.values()][0];
  assert.deepEqual(q.risk, { on: false, day: '', n: 0, last: 0, lastEnc: 0 }, 'an old save loads with risk off');
  assert.equal(g3.hostiles.encs.length, 0, 'hostile units are never saved');
});

test('a game built with hostiles:false works and has no hostile fields', () => {
  const g = mkGame({ hostiles: false });
  assert.equal(g.hostiles, null);
  const { p, ws } = atSea(g, 'Ann', SPOTS.gog);
  g.tick(0.1); g.onAction(p, { action: 'risk_set', on: true });
  assert.equal(g.snapshot().hostiles, undefined);
  void ws;
});

test('detection range depends on night: a night spawn is within 3.5 km, a day spawn can be 3-7 km out', () => {
  const night = mkGame(); night.simTime = Date.UTC(2026, 9, 10, 23, 0, 0) / 1000;   // 23:00 UTC at lon 5° E → local night
  const n = atSea(night, 'N', SPOTS.gog, { kn: 8 }), en = forceSpawn(night, n.p);
  const dn = haversine(en.units[0].lat, en.units[0].lon, n.p.ship.lat, n.p.ship.lon);
  assert.ok(dn <= 3500, `night: ${Math.round(dn)} m`);
  const day = mkGame(), d = atSea(day, 'D', SPOTS.gog, { kn: 8 }); rig(day, [0.0001, 0.1, 1, 0.5, 0.9], 0.5);
  const ed = day.hostiles.trySpawn(d.p), dd = haversine(ed.units[0].lat, ed.units[0].lon, d.p.ship.lat, d.p.ship.lon);
  assert.ok(dd > 6000 && dd <= 7100, `day: ${Math.round(dd)} m`);
  // poor visibility pulls the spawn in as well
  const fog = mkGame(), wx0 = fog.weatherAt.bind(fog); fog.weatherAt = (la, lo) => ({ ...wx0(la, lo), visibility: 2000 });
  const f = atSea(fog, 'F', SPOTS.gog, { kn: 8 }); rig(fog, [0.0001, 0.1, 1, 0.5, 0.9], 0.5);
  const ef = fog.hostiles.trySpawn(f.p), df = haversine(ef.units[0].lat, ef.units[0].lon, f.p.ship.lat, f.p.ship.lon);
  assert.ok(df <= 3500 * 0.9 + 400 && df < dd, `fog: ${Math.round(df)} m`);
});

test('server load stays small: 12 units and 5 skippers tick in well under a millisecond each; the wire list is a few KB', () => {
  const g = mkGame();
  const ps = Array.from({ length: 5 }, (_, i) => atSea(g, 'P' + i, { lat: SPOTS.gog.lat + i * 0.2, lon: SPOTS.gog.lon }, { kn: 7 }));
  rig(g, [], 0.5);
  for (const { p } of ps.slice(0, 4)) { const e = g.hostiles.newEnc(p, 'pirate', 'hostile', g.politics.ds.areaById['piracy-gog'], { fast: 0, board: 0, hose: { uses: 0, last: -1e9, until: 0 }, comply: 0, citadel: 0, alongside: 0, detect: 9000 }); for (let k = 0; k < 3; k++) e.units.push(g.hostiles.makeUnit(e, 'skiff', { lat: p.ship.lat + 0.02 + k * 0.001, lon: p.ship.lon + 0.02 }, 200)); }
  assert.equal(g.hostiles.unitCount(), 12);
  assert.ok(JSON.stringify(g.hostiles.publicList()).length < 3000);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 400; i++) { g.simTime += 0.1; g.hostiles.tick(0.1); }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 400;
  assert.ok(ms < 1, `${ms.toFixed(3)} ms per tick`);
});
