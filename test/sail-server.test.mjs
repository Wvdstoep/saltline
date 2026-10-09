// Lane A — server side of sailing (docs/SAILING-CONTRACT.md §3.4–§3.8, §6.4 A-7). These run against the real Game
// and are skipped until phase 2 has wired server/game.js and server/fleet.js (docs/SAILING-PHASE2.md). The Game is
// imported lazily so the skipped file costs nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { destination } from '../shared/geo.js';
import { RIGS } from '../shared/sail/rigs.js';
import { anyHoisted, packRigView, defaultRig } from '../shared/sail/state.js';
import { crashJibeDamage } from '../shared/sail/sailphys.js';

const SERVER_WIRED = fs.readFileSync(new URL('../server/game.js', import.meta.url), 'utf8').includes('rigCommand(');
const PH2 = SERVER_WIRED ? {} : { skip: 'needs wiring (phase 2)' };
const OPEN_A = { lat: 55.0, lon: 3.5 };          // open North Sea, > 100 km from any harbour (test/warp.test.mjs)

let W = null;
async function mods() {
  if (W) return W;
  process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
  const { Game } = await import('../server/game.js');
  const { World } = await import('../server/world.js');
  const { carvingsForWorld, harborById } = await import('../server/harbors.js');
  W = { Game, harborById, world: new World().load(carvingsForWorld(), () => {}) };
  return W;
}
async function mkGame(opts = {}) {
  const { Game, world } = await mods();
  const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-sail-test-state.json', ...opts });
  if (!opts.stateFile) g.saveState = () => {};
  g.rnd = () => 0.5;
  return g;
}
function fakeSocket() { return { readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); }, close() {} }; }
function join(g, name) { const ws = fakeSocket(); const p = g.connect(ws, null, name); return { p, ws }; }
const last = (ws, t) => [...ws.sent].reverse().find((m) => m.t === t);
const evs = (ws) => ws.sent.filter((m) => m.t === 'event');
function atSea(g, name, cls = 'sloop', pos = OPEN_A) {
  const j = join(g, name);
  g.onAction(j.p, { action: 'undock' });
  j.p.ship.cls = cls; j.p.sailsUp = true;
  Object.assign(j.p.ship, { lat: pos.lat, lon: pos.lon, hdg: 0, spd: 5, throttle: 0, rudder: 0 });
  j.p.lastValid = { lat: pos.lat, lon: pos.lon };
  return j;
}

test('rig action: validation, clamping, no `you` per command, warn on refusal, 20 per second', PH2, async () => {
  const g = await mkGame(); const { p, ws } = atSea(g, 'Ann');
  const yous = () => ws.sent.filter((m) => m.t === 'you').length;
  const y0 = yous();
  g.onAction(p, { action: 'rig', cmd: { sails: { main: { sheet: 1.7, reef: 5 } } } });
  assert.equal(p.ship.rig.sails.main.sheetCmd, 1); assert.equal(p.ship.rig.sails.main.reefCmd, 2);
  assert.equal(yous(), y0, 'optimistic client: no you per command');
  g.onAction(p, { action: 'rig', cmd: { sails: { mizzen: { sheet: 0.5 } } } });
  assert.equal(evs(ws).at(-1).kind, 'warn'); assert.equal(evs(ws).at(-1).text, 'No such sail.');
  g.onAction(p, { action: 'rig', cmd: 'nonsense' }); assert.equal(evs(ws).at(-1).kind, 'warn');
  g.rigLimits.delete(p);
  for (let i = 0; i < 25; i++) g.onAction(p, { action: 'rig', cmd: { sails: { genoa: { sheet: i / 100 } } } });
  assert.equal(p.ship.rig.sails.genoa.sheetCmd, 0.19, 'commands 21–25 in the same second are dropped');
  const c = atSea(g, 'Cy', 'coaster');
  assert.doesNotThrow(() => g.onAction(c.p, { action: 'rig', cmd: { all: 'set' } }));
  assert.equal(c.p.ship.rig, undefined);
});

test('legacy sails action maps onto the rig and keeps sailsUp', PH2, async () => {
  const g = await mkGame(); const { p, ws } = atSea(g, 'Ann', 'ketch');
  g.onAction(p, { action: 'sails', up: false });
  for (const id of Object.keys(p.ship.rig.sails)) assert.equal(p.ship.rig.sails[id].hoistCmd, 0);
  assert.equal(p.sailsUp, false); assert.equal(last(ws, 'you').you.sailsUp, false);
  g.onAction(p, { action: 'sails', up: true });
  assert.equal(p.sailsUp, true); assert.equal(anyHoisted(p.ship.rig), true);
  for (const s of RIGS.ketch.sails) assert.equal(p.ship.rig.sails[s.id].hoistCmd, s.light ? 0 : 1);
  assert.equal(last(ws, 'you').you.ship.rig.cls, 'ketch', 'the rig travels in you.ship');
});

test('tug assist: the crew furls the sails once when the tow begins', PH2, async () => {
  const g = await mkGame(); const { harborById } = await mods(); const ROT = harborById('rotterdam');
  const at = destination(ROT.lat, ROT.lon, 270, 800);
  const { p, ws } = atSea(g, 'Bo', 'sloop', at); p.ship.spd = 2;
  assert.equal(anyHoisted(g.rigFor(p)), true);
  g.onAction(p, { action: 'tug_assist' });
  assert.ok(p.assist, 'assist started');
  assert.equal(anyHoisted(p.ship.rig), false); assert.equal(p.sailsUp, false);
  assert.ok(evs(ws).some((e) => e.text === 'The crew furls the sails for the tow.'));
});

test('warp with an empty tank needs a sail actually set', PH2, async () => {
  const g = await mkGame(); const { p, ws } = atSea(g, 'Ann');
  p.fuel = 0;
  g.onAction(p, { action: 'set_warp', factor: 5 }); assert.equal(p.warp, 5, evs(ws).at(-1)?.text);
  g.onAction(p, { action: 'set_warp', factor: 1 });
  g.onAction(p, { action: 'rig', cmd: { all: 'furl' } }); p.sailsUp = true;   // even with the legacy switch on
  g.onAction(p, { action: 'set_warp', factor: 5 });
  assert.equal(p.warp, 1); assert.match(evs(ws).at(-1).text, /out of fuel/);
});

test('move budget and speed clamp use the rig cap: sloop 11 kn and catamaran 15 kn pass, sloop 25 kn is corrected', PH2, async () => {
  const g = await mkGame();
  const move = (j, kn) => {
    const p = j.p, from = { lat: p.ship.lat, lon: p.ship.lon }, to = destination(from.lat, from.lon, 0, 3 * kn * 0.514444);   // 3 s (the 5 m slack is small against it)
    p.lastState = Date.now() - 3000; p.moveBudget = 0;
    g.onState(p, { lat: to.lat, lon: to.lon, hdg: 0, spd: kn, throttle: 0, rudder: 0 });
    return p.ship.lat === to.lat;
  };
  assert.equal(move(atSea(g, 'S', 'sloop'), 11), true);
  const c = atSea(g, 'C', 'catamaran', { lat: 55.0, lon: 2.0 });
  assert.equal(move(c, 15), true);
  assert.ok(c.p.ship.spd === 15, 'the reported speed is not clamped to C.maxKn·1.1 any more');
  assert.equal(move(atSea(g, 'T', 'sloop', { lat: 55.5, lon: 3.0 }), 25), false);
});

test('rv: validated, ≤ 2 Hz, in publicState; offline ships get it from their rig; engine classes none', PH2, async () => {
  const g = await mkGame(); const { p } = atSea(g, 'Ann');
  const good = packRigView('sloop', defaultRig('sloop', { hoisted: true })); good[0] = -150;
  p.lastState = Date.now() - 500;
  g.onState(p, { lat: p.ship.lat, lon: p.ship.lon, hdg: 0, spd: 5, rv: good });
  assert.deepEqual(g.publicState(p).rv, good);
  const other = good.slice(); other[0] = 120;
  g.onState(p, { lat: p.ship.lat, lon: p.ship.lon, hdg: 0, spd: 5, rv: other });
  assert.deepEqual(g.publicState(p).rv, good, 'a second rv within 450 ms is ignored');
  g.rigViews.get(p).at -= 1000;
  g.onState(p, { lat: p.ship.lat, lon: p.ship.lon, hdg: 0, spd: 5, rv: good.slice(1) });
  assert.deepEqual(g.publicState(p).rv, good, 'a malformed rv is ignored');
  g.disconnect(p);
  assert.equal(g.publicState(p).rv.length, 11, 'offline: built from ship.rig');
  const c = atSea(g, 'Cy', 'coaster');
  assert.equal(g.publicState(c.p).rv, undefined);
  assert.equal(JSON.parse(JSON.stringify(g.publicState(c.p))).rv, undefined);
});

test('save → load keeps ship.rig; an old save without a rig migrates (at sea: set, moored: down)', PH2, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saltline-sail-')); const file = path.join(dir, 'state.json');
  const g = await mkGame({ stateFile: file });
  const a = atSea(g, 'Ann', 'schooner');
  g.onAction(a.p, { action: 'rig', cmd: { auto: 'full', sails: { main: { reef: 1, sheet: 0.6 } } } });
  const b = join(g, 'Bo'); b.p.ship.cls = 'sloop';          // moored at Rotterdam
  g.saveState();
  const g2 = await mkGame({ stateFile: file });
  const a2 = g2.byId.get(a.p.id);
  assert.equal(a2.ship.rig.cls, 'schooner'); assert.equal(a2.ship.rig.auto, 'full'); assert.equal(a2.ship.rig.sails.main.reefCmd, 1); assert.equal(a2.ship.rig.sails.main.sheetCmd, 0.6);
  // strip every rig: a save from before sailing
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  const strip = (o) => { if (!o || typeof o !== 'object') return; if (o.ship && typeof o.ship === 'object' && 'cls' in o.ship) { delete o.ship.rig; if (o.sailsUp === undefined) o.sailsUp = true; } for (const k of Object.keys(o)) strip(o[k]); };
  strip(s); fs.writeFileSync(file, JSON.stringify(s));
  const g3 = await mkGame({ stateFile: file });
  const a3 = g3.byId.get(a.p.id), b3 = g3.byId.get(b.p.id);
  assert.equal(a3.ship.rig.v, 1); assert.equal(a3.ship.rig.auto, 'hint'); assert.equal(anyHoisted(a3.ship.rig), true, 'at sea: her sails were set');
  for (const sd of RIGS.schooner.sails) assert.equal(a3.ship.rig.sails[sd.id].hoist, sd.light ? 0 : 1);
  assert.equal(anyHoisted(b3.ship.rig), false, 'moored: everything down'); assert.equal(b3.sailsUp, false);
});

test('crash jibe damage: only with the helper off, at most once per 10 s', PH2, async () => {
  const g = await mkGame(); const { p } = atSea(g, 'Ann');
  g.onAction(p, { action: 'rig', cmd: { auto: 'off' } });
  const c0 = p.cond;
  g.onAction(p, { action: 'rig_event', kind: 'crash_jibe', aws: 12 });
  assert.ok(Math.abs(c0 - crashJibeDamage('sloop', 12) - p.cond) < 1e-9 && p.cond < c0);
  const c1 = p.cond;
  g.onAction(p, { action: 'rig_event', kind: 'crash_jibe', aws: 12 }); assert.equal(p.cond, c1, 'once per 10 s');
  g.rigLimits.get(p).jibeAt -= 11000;
  g.onAction(p, { action: 'rig_event', kind: 'crash_jibe', aws: 99 }); assert.ok(c1 - p.cond <= 3 + 1e-9, 'aws clamped, ≤ 3 points');
  g.onAction(p, { action: 'rig', cmd: { auto: 'hint' } }); g.rigLimits.get(p).jibeAt -= 11000;
  const c2 = p.cond; g.onAction(p, { action: 'rig_event', kind: 'crash_jibe', aws: 12 }); assert.equal(p.cond, c2, 'helper hint: no damage');
});
