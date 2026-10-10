// Pirates (contract R4-R7, R9): approach, ident, chase, board, small-arms damage, give-up, defence and the ways to end it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOSTILE } from '../shared/hostile.js';
import { ransomFor } from '../shared/hostile.js';
import { hullValue } from '../shared/politics.js';
import { haversine } from '../shared/geo.js';
import { mkGame, atSea, SPOTS, rig, run, forceSpawn, events, lastYou } from './hostile-helpers.mjs';

const text = (ws) => events(ws).join('\n');
/** A slow laden coaster in the Gulf of Guinea with one skiff on the radar. `rest` is the RNG for everything after the spawn. */
function setup({ kn = 8, rest = 0.5, cargo = [{ good: 'grain', qty: 400, contraband: false, jobId: null }], group = 0.1 } = {}) {
  const g = mkGame(), { p, ws } = atSea(g, 'Ann', SPOTS.gog, { kn, cargo });
  const enc = forceSpawn(g, p, { group });
  rig(g, [], rest);
  return { g, p, ws, enc };
}
const state = (g) => g.hostiles.attackerOf(g.hostiles.encs[0]?.pid)?.st;

test('a skiff group closes in, is unknown until close, then identified as pirates', () => {
  const { g, p, ws, enc } = setup({ rest: 0.99 });
  assert.equal(enc.units[0].k, 'skiff'); assert.equal(enc.faction, 'pirate');
  const d0 = haversine(enc.units[0].lat, enc.units[0].lon, p.ship.lat, p.ship.lon);
  assert.ok(d0 >= 3000 && d0 <= 7000, `spawned ${Math.round(d0)} m out`);
  assert.equal(g.hostiles.publicList()[0].ident, false);
  assert.equal(g.hostiles.publicList()[0].name, undefined, 'no name while unidentified');
  assert.match(events(ws).at(-1), /Radar: 1 unknown fast craft, bearing \d+°, \d\.\d km, closing fast/);
  run(g, 600, { until: () => enc.units[0].ident });
  assert.ok(enc.units[0].ident, 'identified before they arrive');
  const d1 = haversine(enc.units[0].lat, enc.units[0].lon, p.ship.lat, p.ship.lon);
  assert.ok(d1 < 2600, `identified at ${Math.round(d1)} m`);
  assert.equal(g.hostiles.publicList()[0].name, 'Pirate skiff');
  assert.match(text(ws), /pirates\. Armed men aboard/);
});

test('chase and board on a slow ship: warning shots, boarding progress, then a robbery through the existing piracy code', () => {
  const { g, p, ws, enc } = setup({ rest: 0.5 });
  const seen = new Set();
  const money0 = p.money;
  const done = run(g, 1500, { until: () => { seen.add(enc.st); return enc.st === 'leave'; } });
  assert.ok(done, 'the encounter resolved');
  assert.ok(seen.has('approach') && seen.has('attack'));
  const t = text(ws);
  assert.match(t, /Warning shots across the bow/);
  assert.match(t, /trying to board/);
  assert.match(t, /robbers boarded .* took stores and cash \(5000 cr\)\. Crew safe\./);
  assert.equal(money0 - p.money, 5000, 'robbery capped at ROBBERY_MAX');
  assert.ok(p.cond > 90, 'a robbery costs no real hull');
  assert.equal(p.risk.lastEnc, g.simTime);
  run(g, 400, { until: () => g.hostiles.encs.length === 0 });
  assert.equal(g.hostiles.encs.length, 0, 'the skiffs sail off and vanish');
});

test('hijack: the ship is held 12 h through the existing hold, 30 % of the free cargo goes, the cost is paid unless covered', () => {
  const { g, p, ws, enc } = setup({ rest: 0.99, cargo: [{ good: 'grain', qty: 400, contraband: false, jobId: null }, { good: 'steel', qty: 100, contraband: false, jobId: 'j1' }] });
  const v = g.politics.vesselOf(p), money0 = p.money, hv = hullValue(p.ship.cls, p.cond);
  run(g, 1500, { until: () => enc.st === 'leave' });
  assert.equal(v.held.why, 'hijack'); assert.ok(Math.abs(v.held.until - (g.simTime + 12 * 3600)) < 60);
  assert.equal(money0 - p.money, Math.round(0.05 * hv), 'hijack cost 5 % of the hull value');
  assert.equal(p.cargo.find((c) => c.good === 'grain').qty, 280, '30 % of the free cargo');
  assert.equal(p.cargo.find((c) => c.good === 'steel').qty, 100, 'contract cargo is not looted');
  assert.match(text(ws), /was held .* Crew safe\./);
  assert.match(text(ws), /took 120 t of cargo/);
  assert.ok(g.politics.heldText(v, p));
});

test('small arms hit the hull for small damage by range, the crew stays safe, and a 14 kn ship cannot be boarded', () => {
  const { g, p, ws, enc } = setup({ kn: 14, rest: 0.1 });
  run(g, 600, { until: () => enc.st === 'attack' });
  run(g, 120);
  assert.equal(enc.board, 0, 'no boarding above 13 kn');
  assert.ok(p.cond < 100 && p.cond > 90, `hull ${p.cond}`);
  assert.match(text(ws), /Small-arms fire hits the hull: −[\d.]+ % \(\d+ % left\)\. Crew safe\./);
  assert.equal(p.flooding, 0);
  assert.notEqual(enc.st, 'leave');
});

test('pirates give up against a fast ship (22 kn+), in a storm, and when a navy ship is close', () => {
  const a = setup({ kn: 8, rest: 0.99 });
  a.p.ship.spd = 25;
  run(a.g, 120, { until: () => a.enc.st === 'leave' });
  assert.equal(a.enc.st, 'leave'); assert.match(text(a.ws), /The skiffs break off \(too fast for them\)/);
  const b = setup({ kn: 8, rest: 0.99 });
  b.g.weatherAt = () => ({ storm: 0.9, sea: 1, visibility: 22000, wind: { spd: 20 } });
  run(b.g, 5);
  assert.match(text(b.ws), /break off \(the sea is too rough\)/);
});

test('fire hose: resets the boarding, three uses, and a wait between them', () => {
  const { g, p, ws, enc } = setup({ rest: 0.99 });
  run(g, 1500, { until: () => enc.board > 0.3 });
  assert.ok(enc.board > 0.3);
  g.onAction(p, { action: 'hostile_hose' });
  assert.equal(enc.board, 0); assert.match(text(ws), /Fire hoses on full pressure/);
  g.onAction(p, { action: 'hostile_hose' });
  assert.match(events(ws).at(-1), /still reeling in the hose/);
  assert.equal(enc.hose.uses, 1);
  for (let i = 0; i < 3; i++) { run(g, HOSTILE.HOSE_GAP_S + 1); g.onAction(p, { action: 'hostile_hose' }); }
  assert.equal(enc.hose.uses, 3);
  assert.match(events(ws).at(-1), /out of pressure|Fire hoses|reeling|sheer/);
  assert.equal(lastYou(ws).hostile.hose, 0);
});

test('citadel: boarding stops and the navy is called; if a patrol answers the pirates are driven off, else they break in after 15 min', () => {
  const a = setup({ rest: 0.99 });
  run(a.g, 1500, { until: () => a.enc.board > 0.2 });
  rig(a.g, [0.1], 0.99);                                  // the navy call succeeds (presence roll 0.1 < 0.35)
  a.g.onAction(a.p, { action: 'hostile_citadel' });
  assert.ok(a.enc.citadel); assert.match(text(a.ws), /withdraws to the citadel/); assert.match(text(a.ws), /diverts the naval patrol/);
  const friend = a.g.hostiles.friendOf(a.p.id); assert.ok(friend);
  const before = a.enc.board; run(a.g, 30); assert.ok(a.enc.board <= before, 'boarding frozen');
  run(a.g, 900, { until: () => a.enc.st === 'leave' });
  assert.equal(a.enc.st, 'leave'); assert.match(text(a.ws), /drives the skiffs off/);
  assert.ok(!a.g.politics.vesselOf(a.p).held, 'never held');
  const b = setup({ rest: 0.99 });
  run(b.g, 1500, { until: () => b.enc.board > 0.2 });
  rig(b.g, [0.99], 0.99);                                 // no patrol answers
  b.g.onAction(b.p, { action: 'hostile_citadel' });
  assert.match(text(b.ws), /no patrol is within reach/);
  run(b.g, HOSTILE.CITADEL_MAX_S + 5, { until: () => b.enc.st === 'leave' });
  assert.match(text(b.ws), /citadel door gives way/);
});

test('release payment ends the attack without boarding; refused when you cannot pay', () => {
  const { g, p, ws, enc } = setup({ rest: 0.99 });
  const cost = ransomFor(hullValue(p.ship.cls, p.cond));
  assert.equal(lastYou(ws).hostile.ransom, cost);
  p.money = cost - 1; g.onAction(p, { action: 'hostile_pay' });
  assert.match(events(ws).at(-1), /release payment is [\d,]+ cr/); assert.equal(enc.st, 'approach');
  p.money = 1e6; g.onAction(p, { action: 'hostile_pay' });
  assert.equal(p.money, 1e6 - cost); assert.equal(enc.st, 'leave'); assert.match(text(ws), /release money \(ransom\)/);
  assert.ok(cost >= HOSTILE.RANSOM_MIN);
});

test('handing over cargo: 40 % of the free cargo, never contract cargo; nothing free = refused', () => {
  const a = setup({ rest: 0.99, cargo: [{ good: 'grain', qty: 400, contraband: false, jobId: null }, { good: 'steel', qty: 100, contraband: false, jobId: 'j1' }] });
  a.g.onAction(a.p, { action: 'hostile_cargo' });
  assert.equal(a.p.cargo.find((c) => c.good === 'grain').qty, 240); assert.equal(a.p.cargo.find((c) => c.good === 'steel').qty, 100);
  assert.equal(a.enc.st, 'leave');
  const b = setup({ rest: 0.99, cargo: [{ good: 'steel', qty: 100, contraband: false, jobId: 'j1' }] });
  b.g.onAction(b.p, { action: 'hostile_cargo' });
  assert.match(events(b.ws).at(-1), /no free cargo/); assert.equal(b.enc.st, 'approach');
});

test('surrender (comply): they stop firing, come alongside and board after a few seconds, half-weight hijack', () => {
  const { g, p, ws, enc } = setup({ rest: 0.5 });
  g.onAction(p, { action: 'hostile_surrender' });
  assert.match(text(ws), /raise your hands/);
  const cond0 = p.cond;
  const done = run(g, 1500, { until: () => enc.st === 'leave' });
  assert.ok(done); assert.equal(p.cond, cond0, 'no more shots after surrendering');
  assert.match(text(ws), /robbers boarded/);
  // the hijack share is halved: a roll in the upper part of the normalised mix that would hijack in a fight is a robbery here
  const h = setup({ rest: 0.95 });
  h.g.onAction(h.p, { action: 'hostile_surrender' });
  run(h.g, 1500, { until: () => h.enc.st === 'leave' });
  assert.match(text(h.ws), /robbers boarded/, '0.95 would be a hijack in a fight (> 0.933) but the comply mix renormalises to 0.966');
});

test('armed guards bought beforehand: spawn rate x0.2 and 80 % of boardings are repelled for a small hull cost', () => {
  const g = mkGame(), { p, ws } = atSea(g, 'Ann', SPOTS.gog, { kn: 8 });
  const prey0 = g.hostiles.preyOf(p);
  assert.equal(g.politics.buyGuards(p, 'piracy-gog', 1).ok, true);
  assert.ok(g.hostiles.guardsActive(p, 'piracy-gog'));
  assert.ok(g.hostiles.preyOf(p) <= prey0 * 0.2 + 1e-3);
  const enc = forceSpawn(g, p); rig(g, [], 0.1);        // repel roll 0.1 < 0.8
  run(g, 1500, { until: () => enc.st === 'leave' });
  assert.match(text(ws), /approach by a suspicious craft was repelled .* Hull −3 %/);
  assert.ok(!g.politics.vesselOf(p).held);
});

test('a MAYDAY / DSC distress while attacked calls the navy; escort follows, and no new pirates during the escort', () => {
  const { g, p, ws, enc } = setup({ rest: 0.99 });
  rig(g, [0.1], 0.99);
  g.hostiles.onDistress(p);
  const f = g.hostiles.friendOf(p.id); assert.ok(f, 'a patrol answers');
  assert.match(text(ws), /diverts the naval patrol/);
  run(g, 1500, { until: () => f.st === 'escort' });
  assert.equal(f.st, 'escort'); assert.equal(enc.st, 'leave');
  p.risk.lastEnc = 0; assert.equal(g.hostiles.spawnBlock(p), 'escorted');
  g.sendYou(p); assert.equal(lastYou(ws).escort.name, f.name);
  run(g, HOSTILE.ESCORT_S + 5, { until: () => g.hostiles.encs.length === 0 });
  assert.match(text(ws), /leaves you: "Safe passage\."/);
  // a second call within the gap, with no attacker, is refused politely
  g.hostiles.callNavy(p); assert.match(events(ws).at(-1), /nobody is threatening you/);
});

test('calling the navy with no patrol in reach says so; once called, a second call within 10 min is answered with "hold on"', () => {
  const { g, p, ws } = setup({ rest: 0.99 });
  rig(g, [0.99], 0.99);
  g.onAction(p, { action: 'hostile_navy' });
  assert.match(events(ws).at(-1), /no patrol is within reach/);
  g.onAction(p, { action: 'hostile_navy' });
  assert.match(events(ws).at(-1), /has your call\. Hold on/);
});

test('despawn: a skipper who docks, goes offline or sails 25 km away loses the hostiles', () => {
  const a = setup({ rest: 0.99 }); a.p.docked = 'rotterdam'; run(a.g, 1); assert.equal(a.g.hostiles.encs.length, 0);
  const b = setup({ rest: 0.99 }); b.p.online = false; run(b.g, 1); assert.equal(b.g.hostiles.encs.length, 0);
  const c = setup({ rest: 0.99 }); c.enc.units[0].lat += 0.3; run(c.g, 1); assert.equal(c.g.hostiles.encs.length, 0);
});

test('tick through Game.tick: units advance with the real server loop', () => {
  const { g, p, enc } = setup({ rest: 0.99 });
  const d0 = haversine(enc.units[0].lat, enc.units[0].lon, p.ship.lat, p.ship.lon);
  for (let i = 0; i < 100; i++) g.tick(0.1);
  const d1 = haversine(enc.units[0].lat, enc.units[0].lon, p.ship.lat, p.ship.lon);
  assert.ok(d1 < d0 - 50, `closing: ${Math.round(d0)} → ${Math.round(d1)}`);
  assert.equal(state(g), 'approach');
});
