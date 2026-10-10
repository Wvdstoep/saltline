// The politics dice incidents (robbery, repelled, hijack, projectile, mine, detention) are played as 3D scenes for an online,
// hand-sailed skipper: the roll decides the outcome, the boats arrive first and the outcome lands at the end of the scene.
// Offline / automatic / express players keep the text-only path. Risk mode is not needed for these (they are the old dice).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkGame, atSea, SPOTS, rig, run, events } from './hostile-helpers.mjs';

const text = (ws) => events(ws).join('\n');
function piracyRoll(g, p, kindRoll) { rig(g, [0.0001, kindRoll], 0.5); return g.politics.stepSea(p, 1000, 0, { underway: true }); }
function warRoll(g, p, kindRoll) { rig(g, [0.0001, kindRoll], 0.5); p.warCoverSkip = true; return g.politics.stepSea(p, 24, 0, { underway: true }); }

test('piracy roll for a hand-sailed online skipper: skiffs come, circle, fire, board; the hijack outcome lands at the end', () => {
  const g = mkGame(), { p, ws } = atSea(g, 'Ann', SPOTS.gog, { kn: 9, risk: false, cargo: [{ good: 'grain', qty: 200, contraband: false, jobId: null }] });
  const out = piracyRoll(g, p, 0.99);
  assert.deepEqual(out.incidents, [], 'not applied yet');
  const enc = g.hostiles.attackerOf(p.id); assert.ok(enc?.script, 'a scene started'); assert.equal(enc.units[0].k, 'skiff');
  assert.ok(!g.politics.vesselOf(p).held); assert.match(text(ws), /Radar: .*unknown fast craft/);
  const seen = new Set();
  run(g, 200, { until: () => { seen.add(enc.st); if (enc.board > 0) seen.add('boarding'); const l = g.hostiles.publicList(); if (l.some((u) => u.bd)) seen.add('bd'); if (l.some((u) => u.fire)) seen.add('fire'); return enc.st === 'leave'; } });
  assert.ok(['approach', 'attack', 'boarding', 'bd', 'fire'].every((x) => seen.has(x)), [...seen].join());
  assert.equal(g.politics.vesselOf(p).held.why, 'hijack'); assert.match(text(ws), /was held .* Crew safe/);
  assert.match(text(ws), /VHF channel 16: "Merchant vessel, stop your engine/);
  assert.equal(p.risk.on, false, 'no risk mode needed'); assert.equal(g.hostiles.attacksToday(p), 0);
});

test('robbery and repelled outcomes match their roll; the player keeps the helm during the scene', () => {
  const g = mkGame(), { p, ws } = atSea(g, 'Ann', SPOTS.gog, { kn: 9, risk: false });
  const m0 = p.money; piracyRoll(g, p, 0.1); run(g, 200, { until: () => g.hostiles.encs.every((e) => e.st === 'leave') });
  assert.match(text(ws), /robbers boarded/); assert.ok(p.money < m0);
  const h = mkGame(), b = atSea(h, 'Bo', SPOTS.gog, { kn: 9, risk: false });
  piracyRoll(h, b.p, 0.8); run(h, 200, { until: () => h.hostiles.encs.every((e) => e.st === 'leave') });
  assert.match(text(b.ws), /repelled .* Hull −3 %/); assert.equal(b.p.cond, 97);
  assert.equal(b.p.ship.spd, 9, 'the server never touches the helm');
});

test('war-area incidents: a projectile comes from an unidentified patrol craft that fires (hit effects), a mine is a blast message, a detention a patrol that stops you', () => {
  const g = mkGame(), { p, ws } = atSea(g, 'Ann', SPOTS.redsea, { kn: 9, risk: false });
  warRoll(g, p, 0.5);
  const enc = g.hostiles.attackerOf(p.id); assert.ok(enc?.script); assert.equal(enc.units[0].k, 'patrol');
  const kinds = new Set(); run(g, 900, { until: () => { for (const u of g.hostiles.publicList()) if (u.fire) kinds.add(u.fire); return enc.st === 'leave'; } });
  assert.ok(kinds.has('hit')); assert.match(text(ws), /hit by an unidentified projectile .* Crew safe\. Hull −/);
  assert.ok(p.cond < 100 && p.cond >= 1);
  const m = mkGame(), b = atSea(m, 'Bo', SPOTS.redsea, { kn: 9, risk: false });
  warRoll(m, b.p, 0.05);   // mix: mine 0.1 first
  assert.ok(b.ws.sent.some((x) => x.t === 'hostile_fx' && x.kind === 'blast'), 'blast effect sent');
  assert.doesNotMatch(text(b.ws), /struck an underwater object/); run(m, 3, { dt: 0.5 });
  assert.match(text(b.ws), /struck an underwater object believed to be a mine/);
  const d = mkGame(), c = atSea(d, 'Cy', SPOTS.redsea, { kn: 9, risk: false });
  warRoll(d, c.p, 0.95);
  assert.equal(d.hostiles.attackerOf(c.p.id).units[0].k, 'patrol'); run(d, 900, { until: () => d.hostiles.encs.every((e) => e.st === 'leave') });
  assert.equal(d.politics.vesselOf(c.p).held.why, 'detention');
});

test('text-only for offline, automatic and express players, and with no room for boats', () => {
  const g = mkGame(), { p, ws } = atSea(g, 'Ann', SPOTS.gog, { kn: 9, risk: false });
  p.voyage = { route: [[2, 6]], i: 0, throttle: 0.7 };
  const out = piracyRoll(g, p, 0.1);
  assert.equal(out.incidents.length, 1); assert.equal(g.hostiles.encs.length, 0); assert.match(text(ws), /robbers boarded/);
  const h = mkGame(), o = atSea(h, 'Off', SPOTS.gog, { kn: 9, risk: false }); o.p.online = false;
  assert.equal(piracyRoll(h, o.p, 0.1).incidents.length, 1);
  const k = mkGame(), q = atSea(k, 'Cap', SPOTS.gog, { kn: 9, risk: false }); k.hostiles.unitCount = () => 99;
  assert.equal(piracyRoll(k, q.p, 0.1).incidents.length, 1, 'cap reached → immediate outcome');
});

test('a scene cut short still delivers its roll: docking or switching risk off mid-scene applies the outcome', () => {
  const g = mkGame(), { p, ws } = atSea(g, 'Ann', SPOTS.gog, { kn: 9, risk: false });
  piracyRoll(g, p, 0.1); run(g, 5);
  assert.doesNotMatch(text(ws), /robbers boarded/);
  p.docked = 'rotterdam'; run(g, 1);
  assert.match(text(ws), /robbers boarded/); assert.equal(g.hostiles.encs.length, 0);
});

test('risk-mode navy: a rigid boarding boat is launched for the search and the boarding party is flagged on deck', () => {
  const g = mkGame(), { p, ws } = atSea(g, 'Ann', SPOTS.redsea, { kn: 0, cargo: [{ good: 'weapons', qty: 5, contraband: true, jobId: null }] });
  rig(g, [0.0001, 0.9, 0.5, 0.5, 0.5], 0.5); const enc = g.hostiles.trySpawn(p); rig(g, [], 0.5);
  let rib = false, bd = false;
  run(g, 1200, { until: () => { const l = g.hostiles.publicList(); rib ||= l.some((u) => u.k === 'rib' && u.name === 'Naval boarding boat'); bd ||= l.some((u) => u.bd); return enc.st === 'leave'; } });
  assert.ok(rib && bd); assert.match(text(ws), /lowers a rigid boat/);
});
