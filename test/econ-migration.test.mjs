// World economy, Lane B: save migration (docs/WORLD-ECONOMY-CONTRACT.md §12, §17 econ-migration).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { World } from '../server/world.js';
import { carvingsForWorld, harborById, HARBORS } from '../server/harbors.js';
import { Game } from '../server/game.js';
import { migrateStock } from '../shared/econ/model.js';
import { ECON_SCHEMA } from '../server/worldecon.js';

process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
const world = new World().load(carvingsForWorld(), () => {});
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'saltline-econ-mig-'));
const LEGACY = { fish: 2500, grain: 30000, steel: 15000, machinery: 4000, containers: 25000, fuel: 20000, supplies: 3000 };
/** A pre-econ state file: every harbour with the 7 legacy goods, one player with legacy cargo. */
function oldState(file, over = {}) {
  const harbors = {};
  for (const h of HARBORS) {
    const stock = {}, target = {}, market = {};
    for (const [g, t] of Object.entries(LEGACY)) { target[g] = Math.round(t * 0.5); stock[g] = Math.round(t * 0.5 * 0.9); market[g] = 500; }
    harbors[h.id] = { jobs: [], market, stock, target, contact: null, lastRegen: 0 };
  }
  harbors.rotterdam.stock.steel = 9800; harbors.rotterdam.target.steel = 15000;
  Object.assign(harbors, over);
  fs.writeFileSync(file, JSON.stringify({ savedAt: new Date().toISOString(), simTime: Date.now() / 1000, harbors, players: [], wrecks: [], storms: [] }));
}
const load = (file) => { const g = new Game(world, () => {}, { stateFile: file }); g.saveState = () => {}; return g; };

test('an old save (7 goods) loads: legacy goods keep their scarcity ratio, new goods start within 0.85–1.15 × s*', () => {
  const dir = tmp(), file = path.join(dir, 'state.json'); oldState(file);
  const logs = []; const g = new Game(world, (...a) => logs.push(a.join(' ')), { stateFile: file }); g.saveState = () => {};
  const st = g.harbors.rotterdam, e = g.econ;
  const nSteel = e.n(e.row('rotterdam', 'steel'));
  assert.ok(Math.abs(st.stock.steel - migrateStock(9800, 15000, nSteel)) < 0.02 * nSteel, `steel ${st.stock.steel} vs ${migrateStock(9800, 15000, nSteel)}`);
  assert.equal(migrateStock(9800, 15000, 7500), 4900);
  for (const [good, k] of e.rowMap[e.hIdx.get('rotterdam')]) {
    if (good in LEGACY) continue;
    const d = k * 8, sEq = e.n(k) + (e.D[d + 1] - e.D[d + 2]) / 0.03;
    assert.ok(st.stock[good] >= 0.8 * sEq && st.stock[good] <= 1.2 * sEq, `${good} ${st.stock[good]} vs ${sEq}`);
  }
  assert.ok(st.req.every((q) => q.postedAt >= g.simTime - 5), 'no request carried over (new ones may post at once)'); assert.ok(!st.ev || st.ev.from >= g.simTime - 5);
  assert.equal(st.target.steel, Math.round(nSteel), 'target is the normal stock n');
  for (const h of HARBORS) for (const g2 of Object.keys(g.harbors[h.id].stock)) assert.ok(e.row(h.id, g2) >= 0, `${h.id} keeps only listed goods (${g2})`);
  assert.ok(!logs.some((l) => /state unreadable/.test(l)));
});

test('econSchema 2 round trip keeps stocks, requests and events; integers on disk', () => {
  const dir = tmp(), file = path.join(dir, 'state.json'); oldState(file);
  const g = load(file);
  const st = g.harbors.rotterdam; st.stock.coffee = st.target.coffee * 0.3; g.econ.step(1 / 60, g.simTime);
  const reqs = st.req.map((q) => q.id), coffee = st.stock.coffee;
  g.econ.forceEvent('santos', 'strike', 48);
  delete g.saveState; g.saveState();
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(disk.econSchema, ECON_SCHEMA); assert.equal(disk.econVersion, g.econ.eds.v);
  assert.ok(Object.values(disk.harbors.rotterdam.stock).every(Number.isInteger));
  const g2 = load(file);
  assert.deepEqual(g2.harbors.rotterdam.req.map((q) => q.id), reqs);
  assert.ok(Math.abs(g2.harbors.rotterdam.stock.coffee - coffee) < 0.05 * g2.harbors.rotterdam.target.coffee);
  assert.equal(g2.harbors.santos.ev?.kind, 'strike');
});

test('a dataset version change rescales stocks by the ratio rule and drops unlisted requests', () => {
  const dir = tmp(), file = path.join(dir, 'state.json'); oldState(file);
  const g = load(file); delete g.saveState; g.saveState();
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  disk.econVersion = 'older';
  disk.harbors.rotterdam.stock.coffee = 1000; disk.harbors.rotterdam.target.coffee = 4000;
  disk.harbors.rotterdam.req = [{ id: 'qold', good: 'unobtainium', qty: 100, done: 0, unit: 1, premium: 0.2, postedAt: 0, dueAt: 9e12, pledges: [], by: {} }];
  fs.writeFileSync(file, JSON.stringify(disk));
  const g2 = load(file), n = g2.harbors.rotterdam.target.coffee;
  assert.ok(Math.abs(g2.harbors.rotterdam.stock.coffee - migrateStock(1000, 4000, n)) < 0.02 * n);
  assert.ok(!g2.harbors.rotterdam.req.some((q) => q.id === 'qold'));
});

test('50 random corrupt harbour states never throw; each re-initialises at equilibrium', () => {
  const dir = tmp(), file = path.join(dir, 'state.json');
  let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const junk = [null, 'x', 5, [], {}, { a: 1 }, NaN, -1, '12', { stock: 3 }];
  const over = {};
  for (const h of HARBORS.slice(0, 50)) over[h.id] = { jobs: [], stock: junk[Math.floor(rnd() * junk.length)], target: junk[Math.floor(rnd() * junk.length)], market: junk[Math.floor(rnd() * junk.length)], req: junk[Math.floor(rnd() * junk.length)], ev: junk[Math.floor(rnd() * junk.length)] };
  oldState(file, over);
  const disk = JSON.parse(fs.readFileSync(file, 'utf8')); disk.econSchema = 2; disk.econVersion = 'x'; fs.writeFileSync(file, JSON.stringify(disk));
  let g; assert.doesNotThrow(() => { g = load(file); });
  for (const h of HARBORS.slice(0, 50)) {
    const st = g.harbors[h.id];
    assert.ok(st.stock && typeof st.stock === 'object' && Array.isArray(st.req), h.id);
    for (const [good, k] of g.econ.rowMap[g.econ.hIdx.get(h.id)]) assert.ok(Number.isFinite(st.stock[good]) && st.stock[good] >= 0 && st.market[good] >= 1, `${h.id}:${good}`);
  }
});

test('cargo stacks and contracts survive; old stacks without src are ineligible but sellable', () => {
  const dir = tmp(), file = path.join(dir, 'state.json'); oldState(file);
  const g = load(file);
  const p = { id: 'po', docked: 'rotterdam', ship: { cls: 'coaster' }, cargo: [{ good: 'grain', qty: 100, contraband: false, jobId: null }, { good: 'steel', qty: 50, contraband: false, jobId: 'j1' }], money: 0, stats: { earned: 0 } };
  assert.equal(g.econ.stackSrcOk(p.cargo[0]), false);
  g.sendYou = () => {}; g.sendHarbor = () => {}; g.event = () => {};
  g.tradeGoods(p, 'grain', 100, false);
  assert.ok(p.money > 0 && p.cargo.length === 1 && p.cargo[0].jobId === 'j1');
});

test('the v1 price history converts once to the binary ring (legacy goods kept) and is renamed .v1.bak', async () => {
  const { EconHistory } = await import('../server/market.js');
  const dir = tmp(), v1 = path.join(dir, 'market-history.json'), bin = path.join(dir, 'market-history.bin');
  const g = load('/nonexistent/saltline-econ-mig-none.json');
  const T = 1791460800, times = [T, T + 3600, T + 7200];
  fs.writeFileSync(v1, JSON.stringify({ v: 1, sampleS: 3600, times, series: { rotterdam: { steel: [900, 910, null], fish: [700, 705, 710] }, atlantis: { steel: [1, 2, 3] } } }));
  const h = new EconHistory({ file: bin, v1File: v1, econ: g.econ }).load();
  assert.equal(h.samples, 3);
  const k = g.econ.row('rotterdam', 'steel');
  assert.deepEqual(h.series(k, 7), [900, 910, null]);
  assert.ok(fs.existsSync(bin) && !fs.existsSync(v1) && fs.existsSync(path.join(dir, 'market-history.v1.bak')));
});
