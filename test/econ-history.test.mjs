// World economy, Lane C: the 16-bit price history ring (docs/WORLD-ECONOMY-CONTRACT.md §13, §17 econ-history).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { World } from '../server/world.js';
import { carvingsForWorld } from '../server/harbors.js';
import { Game } from '../server/game.js';
import { EconHistory, econHistoryAnswer } from '../server/market.js';
import { LEVEL } from '../server/memguard.js';
import { histDecode, histEncode } from '../shared/econ/model.js';

process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
const world = new World().load(carvingsForWorld(), () => {});
function mkGame() { const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-econ-hist.json' }); g.saveState = () => {}; g.rnd = () => 0.5; return g; }
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'saltline-econ-hist-'));
const T0 = 1791460800;   // on a 6-hour boundary

test('the full rings fit in 6 MB; hourly samples, the 6-hourly ring every 6 h, a binary round trip', () => {
  const g = mkGame(), dir = tmp(), file = path.join(dir, 'market-history.bin');
  const h = new EconHistory({ file, econ: g.econ });
  assert.ok(h.bytes() <= 6 * 1024 * 1024, `${h.bytes()} B`);
  assert.equal(h.h1.length, g.econ.K * 168); assert.equal(h.h6.length, g.econ.K * 120);
  const k = g.econ.row('rotterdam', 'coffee'), st = g.harbors.rotterdam, base = g.econ.baseOfRow(k);
  for (let i = 0; i < 30; i++) { st.market.coffee = 3000 + i * 10; assert.equal(h.maybeSample(g, T0 + i * 3600 + 5), true); assert.equal(h.maybeSample(g, T0 + i * 3600 + 50), false, 'one sample an hour'); }
  assert.equal(h.samples, 30); assert.equal(h.n6, 5);
  const s = h.series(k, 7);
  assert.equal(s.length, 30); assert.equal(s[0], histDecode(histEncode(3000, base), base)); assert.equal(s.at(-1), histDecode(histEncode(3290, base), base));
  assert.equal(h.d24(k), Math.round(((histEncode(3290, base) - histEncode(3050, base)) / histEncode(3050, base)) * 1000) / 10);
  assert.equal(h.series(k, 30).length, 5, '30 days → the 6-hourly ring');
  const h2 = new EconHistory({ file, econ: g.econ }).load();
  assert.deepEqual(h2.series(k, 7), s); assert.deepEqual(h2.series(k, 30), h.series(k, 30)); assert.equal(h2.samples, 30);
  const sz = fs.statSync(file).size; assert.ok(sz > h.h1.byteLength && sz < 6 * 1024 * 1024, `${sz} B on disk`);
});

test('the ring keeps 168 hours; days=30 returns 6-hourly samples; the API shapes', () => {
  const g = mkGame(), h = new EconHistory({ file: null, econ: g.econ });
  for (let i = 0; i < 200; i++) h.sample(g, T0 + i * 3600);
  const k = g.econ.row('santos', 'coffee');
  assert.equal(h.series(k, 7).length, 168); assert.equal(h.times(7).length, 168); assert.equal(h.times(7).at(-1), T0 + 199 * 3600);
  assert.equal(h.series(k, 30).length, Math.ceil(200 / 6));
  let a = econHistoryAnswer(h, { good: 'coffee', days: '30' });
  assert.equal(a.status, 200); assert.equal(a.body.sampleS, 21600); assert.ok(a.body.series.santos.length > 0);
  a = econHistoryAnswer(h, { good: 'coffee', harbor: 'santos', days: '2' }); assert.equal(a.body.series.length, 48);
  a = econHistoryAnswer(h, { harbor: 'rotterdam' }); assert.ok(a.body.series.coffee && a.body.series.flowers);
  assert.equal(econHistoryAnswer(h, { good: 'nope' }).status, 400);
  assert.equal(econHistoryAnswer(h, { harbor: 'atlantis' }).status, 400);
  assert.equal(econHistoryAnswer(h, { good: 'coffee', harbor: 'tokyo_bay' }).status, 400);
});

test('corrupt or truncated files start empty with one log line; never throws', () => {
  const g = mkGame(), dir = tmp(), file = path.join(dir, 'market-history.bin'), logs = [];
  for (const junk of ['', 'garbage', '{"v":2}\nxx', Buffer.alloc(100, 7)]) {
    fs.writeFileSync(file, junk);
    const h = new EconHistory({ file, econ: g.econ, log: (...a) => logs.push(a.join(' ')) }).load();
    assert.equal(h.samples, 0);
  }
  assert.equal(logs.filter((l) => /unreadable/.test(l)).length, 4);
});

test('memory guard: at shed the 6-hourly ring goes to disk and is dropped, at ok it comes back; critical pauses sampling', () => {
  const g = mkGame(), dir = tmp(), file = path.join(dir, 'market-history.bin');
  const h = new EconHistory({ file, econ: g.econ });
  for (let i = 0; i < 13; i++) h.sample(g, T0 + i * 3600);
  const k = g.econ.row('rotterdam', 'fuel'), six = h.series(k, 30), full = h.bytes();
  h.onLevel(LEVEL.shed, LEVEL);
  assert.equal(h.h6, null); assert.ok(h.bytes() < full - g.econ.K * 120 * 2 + 1);
  assert.equal(h.sample(g, T0 + 13 * 3600), true, 'hourly sampling continues at shed');
  h.onLevel(LEVEL.critical, LEVEL); assert.equal(h.maybeSample(g, T0 + 20 * 3600), false, 'critical pauses sampling');
  h.onLevel(LEVEL.ok, LEVEL);
  assert.ok(h.h6); assert.deepEqual(h.series(k, 30), six, '6-hourly ring restored from disk');
  assert.equal(h.maybeSample(g, T0 + 20 * 3600), true);
});
