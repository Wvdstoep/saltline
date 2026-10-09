// DOCK ANYWHERE phase 2: the real Game routes the quay actions and gates services (docs/DOCK-ANYWHERE-PHASE2.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { carvingsForWorld, HARBORS } from '../server/harbors.js';
import { Game } from '../server/game.js';
import { createQuayFinder, fitRun, runFrame } from '../server/quays.js';
import { attachFinder } from '../server/quaygame.js';
import { loadPoints, loadPortFixture, FIXTURE_DIR } from './fixtures/wt/lib.mjs';

process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
const world = new World().load(carvingsForWorld(), () => {});
const fx = loadPortFixture(FIXTURE_DIR, loadPoints().ports.find((p) => p.id === 'rotterdam'));
const getTile = (z, x, y) => (z === 14 ? fx.tiles.get(`${x}/${y}`) || null : null);
const P_TERMINAL = { lat: 51.948952, lon: 4.062297 };
function mkGame() { const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-test-state.json' }); g.saveState = () => {}; attachFinder(g, createQuayFinder({ getTile, harbors: HARBORS }), getTile); return g; }
function fakeSocket() { return { readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); }, close() {} }; }

test('quay_query / quay_dock / services / undock through Game.onAction', () => {
  const g = mkGame(), ws = fakeSocket(), p = g.connect(ws, null, 'Quay Tester');
  if (p.docked) g.onAction(p, { action: 'undock' });
  const { runs } = g.quayFinder.runsNear(P_TERMINAL.lat, P_TERMINAL.lon, 300, 99);
  const t = runs.map((r) => ({ r, f: runFrame(r, P_TERMINAL.lat, P_TERMINAL.lon) })).filter(({ r, f }) => f.off > 0 && f.off < 120 && f.along > 0 && f.along < r.len).sort((a, b) => a.f.off - b.f.off)[0].r;
  p.ship.cls = 'boxship'; p.money = 1e6;
  const fit = fitRun(t, { ...P_TERMINAL, hdg: t.hdg, cls: 'boxship' });
  Object.assign(p.ship, { lat: fit.slot.lat, lon: fit.slot.lon, hdg: t.hdg, spd: 0.5 });
  g.onAction(p, { action: 'quay_query' });
  assert.ok([...ws.sent].reverse().find((m) => m.t === 'quays').list.some((c) => c.fits));
  g.onAction(p, { action: 'quay_dock', id: t.id });
  assert.equal(p.docked, 'rotterdam'); assert.equal(p.berth.quay, true);
  assert.deepEqual(g.publicState(p).quay, { name: p.berth.name, cls: 'terminal' });
  assert.equal([...ws.sent].reverse().find((m) => m.t === 'harbor').harbor.quay.tier, 'port');
  // 1.5 days alongside = 2 started days; day 1 was paid on mooring, the balance is one more day. A new skipper's fleet
  // home is the start harbour (Rotterdam) → the home rate (½) applies (contract §3.3: 4 125 / at home 2 063).
  const perDay = g.fleet.homeOf(p) === 'rotterdam' ? 2063 : 4125;
  assert.equal(p.berth.perDay, perDay);
  const m0 = p.money; g.simTime += 86400 * 1.5; g.onAction(p, { action: 'undock' });
  assert.equal(p.docked, null); assert.equal(m0 - p.money, perDay);
});

test('a quay outside the port: no shipyard, the market trucked', () => {
  const g = mkGame(), ws = fakeSocket(), p = g.connect(ws, null, 'Far Quay');
  p.docked = 'rotterdam'; p.berth = { quay: true, tier: 'near', harbor: 'rotterdam', hdKm: 13, name: 'Industrial AO · Rotterdam', perDay: 51, paid: 51, since: g.simTime };
  g.onAction(p, { action: 'buy_ship', cls: 'feeder' });
  assert.match([...ws.sent].reverse().find((m) => m.t === 'event').text, /shipyard is not available/i);
});

function terminalRun(g) {
  const { runs } = g.quayFinder.runsNear(P_TERMINAL.lat, P_TERMINAL.lon, 300, 99);
  return runs.map((r) => ({ r, f: runFrame(r, P_TERMINAL.lat, P_TERMINAL.lon) })).filter(({ r, f }) => f.off > 0 && f.off < 120 && f.along > 0 && f.along < r.len).sort((a, b) => a.f.off - b.f.off)[0].r;
}

test('away from the fleet home: a container ship pays the full terminal rate (4 125) and the balance on cast-off', () => {
  const g = mkGame(), ws = fakeSocket(), p = g.connect(ws, null, 'Away Skipper');
  if (p.docked) g.onAction(p, { action: 'undock' });
  p.office = { ...(p.office || {}), home: 'hamburg' };
  assert.equal(g.fleet.homeOf(p), 'hamburg');
  const t = terminalRun(g);
  p.ship.cls = 'boxship'; p.money = 1e6;
  const fit = fitRun(t, { ...P_TERMINAL, hdg: t.hdg, cls: 'boxship' });
  Object.assign(p.ship, { lat: fit.slot.lat, lon: fit.slot.lon, hdg: t.hdg, spd: 0.5 });
  g.onAction(p, { action: 'quay_dock', id: t.id });
  assert.equal(p.berth?.quay, true);
  assert.equal(p.berth.perDay, 4125);
  const m0 = p.money; g.simTime += 86400 * 1.5; g.onAction(p, { action: 'undock' });
  assert.equal(p.docked, null); assert.equal(m0 - p.money, 4125);
});

test('T (dock) alongside a quay that is not a harbour berth moors at the quay', () => {
  const g = mkGame(), ws = fakeSocket(), p = g.connect(ws, null, 'T Skipper');
  if (p.docked) g.onAction(p, { action: 'undock' });
  const t = terminalRun(g);
  p.ship.cls = 'coaster'; p.money = 1e6;
  const fit = fitRun(t, { ...P_TERMINAL, hdg: t.hdg, cls: 'coaster' });
  Object.assign(p.ship, { lat: fit.slot.lat, lon: fit.slot.lon, hdg: t.hdg, spd: 0.3 });
  g.onAction(p, { action: 'dock' });
  assert.equal(p.docked, 'rotterdam'); assert.equal(p.berth?.quay, true);
  assert.equal(p.berth.run, t.id);
});

test('no finder (world tiles off): quay_query explains, nothing else changes', () => {
  const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-test-state.json' }); g.saveState = () => {};
  const ws = fakeSocket(), p = g.connect(ws, null, 'No Tiles');
  g.onAction(p, { action: 'quay_query' });
  assert.match([...ws.sent].reverse().find((m) => m.t === 'event').text, /not charted/i);
  assert.equal(g.publicState(p).quay, null);
});

test('tiles that never come (offline): one tile request and one re-answer, no query ↔ ensure loop', async () => {
  // Regression: an instantly-resolving quayEnsure with tiles still missing re-queried and re-ensured forever (a microtask
  // loop that starved the server's event loop and filled the heap).
  const g = mkGame(), ws = fakeSocket(), p = g.connect(ws, null, 'Edge Of Chart');
  if (p.docked) g.onAction(p, { action: 'undock' });
  let ensures = 0; g.quayEnsure = () => { ensures++; return Promise.resolve({ ready: 0, total: 9 }); };
  Object.assign(p.ship, { lat: 51.92256, lon: 4.19545, hdg: 38.8, spd: 0 });   // east edge of the recorded tiles → missing > 0
  g.onAction(p, { action: 'quay_query' });
  const first = ws.sent.filter((m) => m.t === 'quays');
  assert.equal(first.length, 1); assert.ok(first[0].missing > 0); assert.ok(first[0].list.length > 0);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(ensures, 1);
  assert.equal(ws.sent.filter((m) => m.t === 'quays').length, 2);                 // the re-answer after the request
  p.quayAskAt = 0; g.onAction(p, { action: 'quay_query' });                       // the card's next ask (2 s later)
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(ensures, 1, 'no new tile request within 15 s');
});
