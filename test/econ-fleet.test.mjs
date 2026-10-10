// World economy, Lane E: captains' trade runs and voyage jobs that follow the market roles
// (docs/WORLD-ECONOMY-CONTRACT.md §9.2, §9.5, §17 econ-fleet).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { carvingsForWorld, harborById, HARBORS } from '../server/harbors.js';
import { Game } from '../server/game.js';
import { normalizeOrder, ORDER_TYPES } from '../shared/fleet.js';
import { newCap, tradeRunHere, orderText } from '../server/captain.js';
import { tradeQuote } from '../server/economy.js';
import { generateFamilyJob, VOYAGE_GOODS } from '../server/jobsgen.js';
import { roleOf } from '../shared/econ/model.js';
import { econDataset } from '../server/econdata.js';
import { PAY } from '../shared/jobs/catalogue.js';
import { catalogueOf } from '../shared/econ/catalogue.js';

process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
const world = new World().load(carvingsForWorld(), () => {});
function seeded(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function fakeSocket() { return { readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); }, close() {} }; }
const isHarbor = (id) => !!harborById(id);

test('normalizeOrder accepts a trade_run and rejects broken ones', () => {
  assert.ok(ORDER_TYPES.includes('trade_run'));
  const ok = normalizeOrder({ type: 'trade_run', good: 'coffee', buyAt: 'santos', maxBuy: 2000.4, qty: 1200, sellAt: 'rotterdam', minSell: 3000, then: 'hold' }, isHarbor);
  assert.deepEqual(ok, { ok: true, order: { type: 'trade_run', good: 'coffee', buyAt: 'santos', maxBuy: 2000, qty: 1200, sellAt: 'rotterdam', reqId: null, minSell: 3000, then: 'hold', stage: 'buy' } });
  assert.equal(normalizeOrder({ type: 'trade_run', good: 'coffee', buyAt: 'santos', maxBuy: 2000, qty: 100, reqId: 'q1a' }, isHarbor).order.reqId, 'q1a');
  for (const bad of [
    { good: 'weapons', buyAt: 'santos', maxBuy: 1, qty: 1, sellAt: 'rotterdam' }, { good: 'coffee', buyAt: 'atlantis', maxBuy: 1, qty: 1, sellAt: 'rotterdam' },
    { good: 'coffee', buyAt: 'santos', maxBuy: 1, qty: 1 }, { good: 'coffee', buyAt: 'santos', maxBuy: 0, qty: 1, sellAt: 'rotterdam' },
    { good: 'coffee', buyAt: 'santos', maxBuy: 1, qty: -5, sellAt: 'rotterdam' }, { good: 'coffee', buyAt: 'santos', maxBuy: 1, qty: 1, sellAt: 'santos' },
    { good: 'coffee', buyAt: 'santos', maxBuy: 1, qty: 1, reqId: 'DROP TABLE' },
  ]) assert.equal(normalizeOrder({ type: 'trade_run', ...bad }, isHarbor).ok, false, JSON.stringify(bad));
});

function setup() {
  const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-econ-fleet.json' }); g.saveState = () => {}; g.rnd = () => 0.5;
  for (const h of HARBORS) g.harbors[h.id].ev = null;
  const ws = fakeSocket(); const p = g.connect(ws, null, 'Owner'); p.money = 5e7;
  const f = g.fleet, h = harborById('santos'), a = g.harborAnchor(h);
  const v = f.makeVessel(p.id, { ship: { cls: 'feeder', lat: a.lat, lon: a.lon, hdg: 0, spd: 0, throttle: 0, rudder: 0 }, cond: 100, fuel: 300, docked: 'santos', berth: null });
  v.name = 'Trader'; v.cap = newCap(g, 'idle'); p.fleet.push(v); f.index(v);
  const notes = []; const orig = f.note.bind(f); f.note = (vv, kind, text) => { notes.push(text); orig(vv, kind, text); };
  return { g, p, f, v, notes };
}

test('a captain buys within the limit at the buy harbour, then sells at the sell harbour (same tradeGoods path)', () => {
  const { g, p, f, v, notes } = setup();
  const st = g.harbors.santos, first = tradeQuote(harborById('santos'), st, 'coffee', 1, 'buy').unit;
  v.orders = normalizeOrder({ type: 'trade_run', good: 'coffee', buyAt: 'santos', maxBuy: first + 40, qty: 600, sellAt: 'rotterdam', minSell: 1 }, isHarbor).order;
  assert.match(orderText(f, v, v.orders), /buy 600 t of green coffee at Santos/);
  const s0 = st.stock.coffee, m0 = p.money;
  tradeRunHere(f, v);
  const got = v.cargo.filter((c) => c.good === 'coffee').reduce((s, c) => s + c.qty, 0);
  assert.ok(got > 0 && got <= 600, `${got} t`);
  assert.equal(v.orders.stage, 'sell'); assert.ok(Math.abs(st.stock.coffee - (s0 - got)) < 1e-6);
  assert.ok(v.cargo[0].srcRole === 'P' && v.cargo[0].src === 'santos', 'eligible for requests');
  assert.ok(notes.some((t) => /bought .* coffee at Santos/.test(t)));
  // impact limit: the average stays within maxBuy
  assert.ok(m0 - p.money <= (first + 40) * got + 1);
  // arrives at Rotterdam: sells there
  v.docked = 'rotterdam'; const m1 = p.money;
  tradeRunHere(f, v);
  assert.ok(p.money > m1); assert.equal(v.cargo.filter((c) => c.good === 'coffee').length, 0); assert.equal(v.orders, null);
  assert.ok(notes.some((t) => /trade run done at Rotterdam/.test(t)));
});

test('over the limit she moors and reports; under the minimum sale price she waits with the cargo', () => {
  const { g, f, v, notes } = setup();
  const first = tradeQuote(harborById('santos'), g.harbors.santos, 'coffee', 1, 'buy').unit;
  v.orders = normalizeOrder({ type: 'trade_run', good: 'coffee', buyAt: 'santos', maxBuy: first - 100, qty: 600, sellAt: 'rotterdam' }, isHarbor).order;
  tradeRunHere(f, v);
  assert.equal(v.orders, null); assert.equal(v.cargo.length, 0);
  assert.match(notes.at(-1), new RegExp(`Green coffee at Santos is ${first.toLocaleString('en-US')} cr/t — over your limit of ${(first - 100).toLocaleString('en-US')}\\. Waiting for orders\\.`));
  v.orders = normalizeOrder({ type: 'trade_run', good: 'coffee', buyAt: 'santos', maxBuy: first + 100, qty: 300, sellAt: 'rotterdam', minSell: 999999 }, isHarbor).order;
  tradeRunHere(f, v); v.docked = 'rotterdam'; tradeRunHere(f, v);
  assert.equal(v.orders, null); assert.ok(v.cargo.some((c) => c.good === 'coffee'), 'no silent loss: the cargo stays aboard');
  assert.match(notes.at(-1), /under your minimum of 999,999/);
});

test('a captain fills a request: pledges on buying, delivers at the requesting harbour', () => {
  const { g, p, f, v, notes } = setup();
  const rs = g.harbors.rotterdam; rs.req = []; rs.stock.coffee = rs.target.coffee * 0.3; g.econ.step(1 / 60, g.simTime);
  const q = rs.req.find((x) => x.good === 'coffee');
  v.orders = normalizeOrder({ type: 'trade_run', good: 'coffee', buyAt: 'santos', maxBuy: 9999, qty: 600, reqId: q.id }, isHarbor).order;
  tradeRunHere(f, v);
  assert.ok(q.pledges.some((x) => x.qty > 0), 'pledged on departure');
  v.docked = 'rotterdam'; const m = p.money;
  tradeRunHere(f, v);
  assert.ok(q.done > 0 && p.money > m);
  assert.ok(notes.some((t) => /Delivered .* coffee to Rotterdam's request/.test(t)));
});

test('politics blocks are respected: the trade does not happen and she reports', () => {
  const { g, p, f, v, notes } = setup();
  p.office.home = 'rotterdam'; g.politics?.migrate?.(p);
  const st = g.harbors.st_petersburg;
  const a = g.harborAnchor(harborById('st_petersburg'));
  Object.assign(v, { docked: 'st_petersburg' }); Object.assign(v.ship, { lat: a.lat, lon: a.lon });
  st.stock.steel = st.target.steel * 2;
  v.orders = normalizeOrder({ type: 'trade_run', good: 'steel', buyAt: 'st_petersburg', maxBuy: 99999, qty: 500, sellAt: 'hamburg' }, isHarbor).order;
  tradeRunHere(f, v);
  assert.equal(v.cargo.length, 0, 'EU-home company: Russian steel is blocked');
  assert.match(notes.at(-1), /could not buy steel coils at St\.? Petersburg/i);
});

const LEGACY_TERMINAL = new Set(['grain', 'ore', 'coal', 'steel', 'crude', 'fuel', 'chemicals', 'lpg', 'lng', 'livestock', 'fruit']);
test('voyage jobs follow the market roles: they load where the good is made (P) and go where it is needed or traded', () => {
  const eds = econDataset(), rnd = seeded(11), T = Date.UTC(2026, 9, 9) / 1000;
  let n = 0;
  for (const h of HARBORS.filter((x) => x.size !== 'minor')) {
    for (let i = 0; i < 3; i++) {
      const j = generateFamilyJob(h, T, rnd, 'voyage', {});
      if (!j || !catalogueOf(j.cargo?.good)) continue;
      n++;
      assert.equal(roleOf(eds, h, j.cargo.good).role, 'P', `${h.id} loads ${j.cargo.good}`);
      // legacy terminal goods (grain … livestock, fruit) go to any harbour with the terminal that doesn't make them;
      // catalogue-only goods go where they are needed or traded
      const dr = roleOf(eds, harborById(j.to), j.cargo.good).role;
      if (LEGACY_TERMINAL.has(j.cargo.good)) assert.notEqual(dr, 'P', `${j.to} makes ${j.cargo.good} itself`);
      else assert.ok(['I', 'L'].includes(dr), `${j.to} takes ${j.cargo.good}`);
    }
  }
  assert.ok(n > 100, `${n} voyages checked`);
  for (const g of VOYAGE_GOODS) if (catalogueOf(g)) assert.equal(PAY.GOOD_MUL[g], g in { grain: 1, coal: 1, ore: 1, steel: 1, crude: 1, fuel: 1, chemicals: 1, lpg: 1, lng: 1, livestock: 1 } ? PAY.GOOD_MUL[g] : catalogueOf(g).fmul);
  assert.equal(PAY.GOOD_MUL.coffee, 1.3); assert.equal(PAY.GOOD_MUL.salmon, 1.6); assert.equal(PAY.GOOD_MUL.grain, 0.75);
});
