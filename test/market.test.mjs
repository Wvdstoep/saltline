// V6 item 7, the world market (docs/V6-QUICK-CONTRACTS.md §3.7): snapshot, expected prices, the price history, the
// trade finder's maths, the route table, query parsing, tradeQuote, the range flag, the limiter and the answer cache.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { World } from '../server/world.js';
import { carvingsForWorld, harborById, HARBORS } from '../server/harbors.js';
import { Game } from '../server/game.js';
import { SHIP_CLASSES } from '../shared/constants.js';
import { haversine } from '../shared/geo.js';
import { RATES, serviceKn, serviceBurnTph, serviceWearPerH, kmHours } from '../shared/rates.js';
import {
  MARKET_GOODS, TRADE, tradeQuote, priceOf, refreshPrices, driftEconomy, marketTrend, portDues, pilotageFee, berthFeePerDay, repairCostFor,
} from '../server/economy.js';
import {
  MARKET, marketSnapshot, expectedStockAfter, expectedPriceAfter, findTrades, parseRoutesQuery, PriceHistory, routesHandler,
  historyAnswer, affordableQty,
} from '../server/market.js';
import { RouteTable, routesKey } from '../server/routetable.js';
import { buildGraph } from '../server/lanes.js';
import { planRoute } from '../server/searoute.js';

process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
const world = new World().load(carvingsForWorld(), () => {});

function mkGame() { const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-market-test-state.json' }); g.saveState = () => {}; g.rnd = () => 0.5; return g; }
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'saltline-market-'));
const fixedTable = (km = 300, est = false) => ({ estimateKm: (a, b) => (a === b ? null : { km, est }) });
const onlyTo = (to, km = 300) => ({ estimateKm: (a, b) => (b === to ? { km, est: false } : null) });
const q0 = (over = {}) => ({ from: 'rotterdam', cls: 'coaster', hold: 1200, cash: Infinity, good: null, limit: 50, sort: 'tkm', lat: null, lon: null, ...over });
/** Every harbour's stock at its target (prices at local level), so crafted cases are deterministic. */
function flatten(g) { for (const h of HARBORS) { const st = g.harbors[h.id]; for (const k of MARKET_GOODS) st.stock[k] = st.target[k]; refreshPrices(h, st); } }
function setStock(g, id, good, stock, target = null) {
  const h = harborById(id), st = g.harbors[id];
  st.stock[good] = stock; if (target != null) st.target[good] = target;
  st.market[good] = priceOf(h, good, st.stock[good], st.target[good]);
}

// ------------------------------------------------------------------------------------------------ 1 snapshot
test('snapshot: every harbour × good, buy = sell = market, stock/target/trend/fuel match, no mutation', () => {
  const g = mkGame();
  const before = JSON.stringify(g.harbors);
  const s = marketSnapshot(g);
  assert.equal(JSON.stringify(g.harbors), before);
  assert.equal(s.harbors.length, HARBORS.length);
  assert.deepEqual(s.goods.map((x) => x.id), MARKET_GOODS);
  for (const e of s.harbors) {
    const h = harborById(e.id), st = g.harbors[e.id], tr = marketTrend(st);
    assert.equal(e.fuel, g.fuelPrice(h));
    assert.ok(Number.isFinite(e.anchor.lat) && Number.isFinite(e.anchor.lon));
    for (const k of MARKET_GOODS) {
      const x = e.goods[k];
      assert.equal(x.buy, st.market[k]); assert.equal(x.sell, st.market[k]);
      assert.equal(x.stock, Math.round(st.stock[k])); assert.equal(x.target, Math.round(st.target[k])); assert.equal(x.trend, tr[k] ?? 0);
    }
  }
});

// ------------------------------------------------------------------------------------------------ 2 expected price
test('expected stock = driftEconomy without noise (rnd 0.5) for 1, 6, 24 h; expected price = priceOf of it', () => {
  const g = mkGame();
  for (const id of ['rotterdam', 'hull', 'bergen']) {
    const h = harborById(id);
    for (const hours of [1, 6, 24]) {
      const st = structuredClone(g.harbors[id]);
      st.stock.steel = Math.round(st.target.steel * 0.4); st.stock.fish = Math.round(st.target.fish * 1.7);
      const copy = structuredClone(st);
      driftEconomy(copy, hours, () => 0.5);
      for (const k of MARKET_GOODS) {
        assert.ok(Math.abs(expectedStockAfter(st, k, hours) - copy.stock[k]) <= 1, `${id} ${k} ${hours} h`);
        assert.equal(expectedPriceAfter(h, st, k, hours), priceOf(h, k, expectedStockAfter(st, k, hours), st.target[k]));
      }
    }
  }
});

// ------------------------------------------------------------------------------------------------ 3 history
test('price history: hourly sampling, ring of 168, gaps stay gaps, round trip, corrupt file, unknown harbour', () => {
  const g = mkGame(), dir = tmpDir(), file = path.join(dir, 'market-history.json');
  const ph = new PriceHistory({ file, log: () => {} });
  const T0 = 1791460800; // on the hour
  assert.equal(ph.maybeSample(g, T0 + 10), true);
  assert.equal(ph.maybeSample(g, T0 + 3000), false); // same hour
  assert.equal(ph.samples, 1);
  for (let i = 1; i < 200; i++) ph.maybeSample(g, T0 + i * 3600 + 5);
  assert.equal(ph.samples, MARKET.KEEP);
  for (let i = 1; i < ph.times.length; i++) assert.ok(ph.times[i] > ph.times[i - 1]);
  for (const s of Object.values(ph.series)) for (const k of MARKET_GOODS) assert.equal(s[k].length, ph.times.length);
  // a 10-hour outage: the next sample is 11 slots on, nothing invented in between
  const lastT = ph.times.at(-1);
  ph.maybeSample(g, lastT + 11 * 3600);
  assert.equal(ph.times.at(-1) - ph.times.at(-2), 11 * 3600);
  assert.equal(ph.samples, MARKET.KEEP);
  // round trip
  const ph2 = new PriceHistory({ file, log: () => {} }).load();
  assert.deepEqual(ph2.times, ph.times); assert.deepEqual(ph2.series, ph.series);
  // forGood(…, 1) ≤ 24 slots
  const one = ph2.forGood('fish', 1);
  assert.ok(one.times.length <= 24 && one.times.length > 0);
  assert.equal(one.series.rotterdam.length, one.times.length);
  const fh = ph2.forHarbor('rotterdam', 7);
  assert.deepEqual(Object.keys(fh.series), MARKET_GOODS);
  // corrupt file → empty, one log line, no throw
  fs.writeFileSync(file, '{ not json');
  const logs = [];
  const ph3 = new PriceHistory({ file, log: (...a) => logs.push(a.join(' ')) }).load();
  assert.equal(ph3.samples, 0); assert.equal(logs.length, 1);
  // unknown harbour dropped, short arrays padded
  fs.writeFileSync(file, JSON.stringify({ v: 1, sampleS: 3600, times: [T0, T0 + 3600], series: { atlantis: { fish: [1, 2] }, rotterdam: { fish: [700] } } }));
  const ph4 = new PriceHistory({ file, log: () => {} }).load();
  assert.equal(ph4.series.atlantis, undefined);
  assert.deepEqual(ph4.series.rotterdam.fish, [null, 700]);
  assert.deepEqual(ph4.series.rotterdam.grain, [null, null]);
  // a harbour new to the file starts null-padded on the next sample
  ph4.maybeSample(g, T0 + 7200);
  assert.equal(ph4.series.hull.fish.length, 3); assert.equal(ph4.series.hull.fish[0], null); assert.ok(ph4.series.hull.fish[2] > 0);
  // missing file → empty
  assert.equal(new PriceHistory({ file: path.join(dir, 'nope.json') }).load().samples, 0);
});

test('history answer: good, harbour, errors', () => {
  const ph = new PriceHistory({ file: null });
  assert.equal(historyAnswer(ph, { good: 'fish' }).status, 200);
  assert.equal(historyAnswer(ph, { harbor: 'rotterdam', days: '3' }).status, 200);
  assert.equal(historyAnswer(ph, { good: 'gold' }).status, 400);
  assert.equal(historyAnswer(ph, { harbor: 'atlantis' }).status, 400);
  assert.equal(historyAnswer(ph, {}).status, 400);
});

// ------------------------------------------------------------------------------------------------ 4 trade maths
test('trade maths: qty limited by hold, stock and cash; costs equal the economy functions', () => {
  const g = mkGame(); flatten(g);
  const A = harborById('rotterdam');
  // a steel glut at Rotterdam, a steel shortage at Hull
  setStock(g, 'rotterdam', 'steel', 50000, 15000);
  setStock(g, 'hull', 'steel', 1000, 6000);
  const buy = g.harbors.rotterdam.market.steel;
  const pick = (r, to = 'hull') => r.trades.find((t) => t.to === to && t.good === 'steel');
  const T = onlyTo('hull');
  // hold
  let row = pick(findTrades(g, T, q0({ hold: 1000 })));
  assert.equal(row.qty, 1000); assert.equal(row.limitedBy, 'hold');
  // stock
  setStock(g, 'rotterdam', 'steel', 640, 640);
  row = pick(findTrades(g, T, q0()));
  assert.equal(row.qty, 640); assert.equal(row.limitedBy, 'stock');
  setStock(g, 'rotterdam', 'steel', 50000, 15000);
  // cash
  row = pick(findTrades(g, T, q0({ cash: 100000 })));
  assert.equal(row.qty, Math.floor(100000 / buy)); assert.equal(row.limitedBy, 'cash');
  assert.ok(row.qty * buy <= 100000 && (row.qty + 1) * buy > 100000);
  // costs
  row = pick(findTrades(g, T, q0()));
  const C = SHIP_CLASSES.coaster, B = harborById('hull'), load = row.qty / C.capacity;
  const hours = kmHours(300, serviceKn('coaster', load));
  assert.equal(row.hours, Math.round(hours * 100) / 100);
  assert.equal(row.costs.goods, row.qty * buy);
  assert.equal(row.costs.fuel, Math.round(serviceBurnTph('coaster', load) * hours * g.fuelPrice(A)));
  assert.equal(row.costs.wages, Math.round(C.crewCost * hours));
  assert.equal(row.costs.wear, Math.round(serviceWearPerH('coaster') * hours * repairCostFor('coaster', 99)));
  assert.equal(row.costs.dues, portDues('coaster', B));
  assert.equal(row.costs.pilotage, 0);
  assert.equal(row.costs.berth, berthFeePerDay('coaster') * MARKET.BERTH_DAYS);
  // revenue uses the expected price on arrival (Hull's steel shortage eases while we sail)
  const stB = g.harbors.hull;
  const arrive = tradeQuote(B, { ...stB, stock: { ...stB.stock, steel: expectedStockAfter(stB, 'steel', hours) } }, 'steel', row.qty, 'sell');
  assert.equal(row.sellArrive, arrive.unit); assert.equal(row.revenue, arrive.total);
  assert.ok(row.sellArrive < row.sellNow);
  const cost = row.costs.goods + serviceBurnTph('coaster', load) * hours * g.fuelPrice(A) + C.crewCost * hours + serviceWearPerH('coaster') * hours * repairCostFor('coaster', 99) + row.costs.dues + row.costs.berth;
  assert.equal(row.net, Math.round(row.revenue - cost));
  // feeder (150 m) at a mega port pays pilotage
  const fr = findTrades(g, fixedTable(300), q0({ cls: 'feeder', hold: 1200 })).trades.find((t) => harborById(t.to).size === 'mega');
  if (fr) assert.equal(fr.costs.pilotage, pilotageFee('feeder', harborById(fr.to)));
  assert.ok(pilotageFee('feeder', harborById('antwerp')) > 0 && pilotageFee('coaster', harborById('antwerp')) === 0);
});

test('trade rows: net ≤ 0 omitted, sorts, limit, from=all one row per origin, never A = B', () => {
  const g = mkGame();
  const all = findTrades(g, fixedTable(300), q0({ limit: 50 }));
  assert.ok(all.trades.length > 0 && all.trades.length <= 50);
  for (const t of all.trades) { assert.ok(t.net > 0); assert.notEqual(t.from, t.to); }
  for (const sort of ['tkm', 'hour', 'net']) {
    const key = { tkm: 'perTkm', hour: 'perHour', net: 'net' }[sort];
    const r = findTrades(g, fixedTable(300), q0({ sort, limit: 50 })).trades;
    for (let i = 1; i < r.length; i++) assert.ok(r[i - 1][key] >= r[i][key], `${sort} sorted`);
  }
  assert.equal(findTrades(g, fixedTable(300), q0({ limit: 3 })).trades.length, 3);
  const any = findTrades(g, fixedTable(300), q0({ from: 'all', limit: 50, lat: 52, lon: 4 })).trades;
  const origins = any.map((t) => t.from);
  assert.equal(new Set(origins).size, origins.length);
  assert.ok(any.every((t) => Number.isFinite(t.fromDistKm)));
  // no money → no rows
  assert.equal(findTrades(g, fixedTable(300), q0({ cash: 0 })).trades.length, 0);
});

// ------------------------------------------------------------------------------------------------ 5 unreachable / estimated
test('unreachable pairs are omitted; estimated distances keep the row with distEst', () => {
  const g = mkGame();
  assert.equal(findTrades(g, { estimateKm: () => null }, q0()).trades.length, 0);
  const r = findTrades(g, fixedTable(250, true), q0()).trades;
  assert.ok(r.length > 0 && r.every((t) => t.distEst === true && t.distKm === 250));
  const onlyHull = { estimateKm: (a, b) => (b === 'hull' ? { km: 300, est: false } : null) };
  assert.ok(findTrades(g, onlyHull, q0()).trades.every((t) => t.to === 'hull'));
});

// ------------------------------------------------------------------------------------------------ 6 route table
test('route table: warm-up over 4 harbours, -1 for no route, symmetric, file round trip, key change, estimate', async () => {
  const hs = ['rotterdam', 'ijmuiden', 'hull', 'bergen'].map(harborById);
  const dir = tmpDir();
  const calls = [];
  const plan = (a, b, o) => { calls.push([a.id, b.id, o.toHarbor]); return Promise.resolve(a.id === 'bergen' && b.id === 'hull' ? null : { distM: haversine(a.lat, a.lon, b.lat, b.lon) * 1.1 }); };
  const rt = new RouteTable({ harbors: hs, plan, dir, key: 'k1' });
  // before warm-up: great circle × 1.25, estimated
  const e0 = rt.estimateKm('rotterdam', 'hull');
  const gc = haversine(hs[0].lat, hs[0].lon, hs[2].lat, hs[2].lon) / 1000;
  assert.equal(e0.est, true); assert.ok(Math.abs(e0.km - gc * RATES.DETOUR) < 0.1);
  assert.equal(rt.seaKm('rotterdam', 'hull'), null); assert.equal(rt.reachable('rotterdam', 'hull'), undefined);
  await rt.start();
  assert.equal(calls.length, 6);
  for (const [a, b, to] of calls) { assert.ok(a < b); assert.equal(to, b); }
  assert.equal(rt.stats().known, 6); assert.equal(rt.stats().unreachable, 1); assert.equal(rt.stats().building, false);
  assert.equal(rt.seaKm('bergen', 'hull'), null); assert.equal(rt.reachable('hull', 'bergen'), false); assert.equal(rt.estimateKm('hull', 'bergen'), null);
  assert.equal(rt.seaKm('rotterdam', 'hull'), rt.seaKm('hull', 'rotterdam'));
  assert.deepEqual(rt.estimateKm('hull', 'rotterdam'), { km: rt.seaKm('rotterdam', 'hull'), est: false });
  assert.ok(Math.abs(rt.seaKm('rotterdam', 'hull') - gc * 1.1) < 0.1);
  // round trip
  const rt2 = new RouteTable({ harbors: hs, plan: null, dir, key: 'k1' });
  assert.deepEqual(rt2.pairs, rt.pairs);
  // another key ignores the old file
  const rt3 = new RouteTable({ harbors: hs, plan: null, dir, key: 'k2' });
  assert.equal(rt3.stats().known, 0);
  assert.match(routesKey(), /^[0-9a-f]{8}$/); assert.notEqual(routesKey('x'), routesKey());
});

test('route table: a real planRoute for rotterdam|ijmuiden gives the same km', async () => {
  const graph = buildGraph(world);
  const hs = ['rotterdam', 'ijmuiden'].map(harborById);
  const rt = new RouteTable({ harbors: hs, dir: tmpDir(), key: 'real', plan: (a, b, o) => Promise.resolve(planRoute(world, graph, a, b, o)) });
  await rt.start();
  const direct = planRoute(world, graph, hs[1], hs[0], { toHarbor: 'rotterdam' }); // min → max: 'ijmuiden' < 'rotterdam'
  assert.ok(direct && direct.distM > 0);
  assert.equal(rt.seaKm('rotterdam', 'ijmuiden'), Math.round(direct.distM / 100) / 10);
});

// ------------------------------------------------------------------------------------------------ 7 query parsing
test('routes query parsing', () => {
  assert.equal(parseRoutesQuery({ cls: 'coaster' }).ok, false);
  assert.equal(parseRoutesQuery({ from: 'rotterdam' }).ok, false);
  assert.equal(parseRoutesQuery({ from: 'atlantis', cls: 'coaster' }).ok, false);
  assert.equal(parseRoutesQuery({ from: 'rotterdam', cls: 'coaster', good: 'gold' }).ok, false);
  assert.equal(parseRoutesQuery({ from: 'rotterdam', cls: 'coaster', good: 'cigarettes' }).ok, false);
  assert.equal(parseRoutesQuery({ from: 'rotterdam', cls: 'coaster', limit: '500' }).q.limit, 50);
  assert.equal(parseRoutesQuery({ from: 'rotterdam', cls: 'coaster', hold: '99999' }).q.hold, 1200);
  assert.equal(parseRoutesQuery({ from: 'rotterdam', cls: 'coaster', hold: '0' }).ok, false);
  const d = parseRoutesQuery({ from: 'all', cls: 'coaster' }).q;
  assert.deepEqual([d.hold, d.cash, d.good, d.limit, d.sort], [1200, Infinity, null, 20, 'tkm']);
  assert.equal(parseRoutesQuery({ from: 'all', cls: 'coaster', sort: 'fun' }).ok, false);
  assert.equal(parseRoutesQuery({ from: 'all', cls: 'coaster', sort: 'hour', good: 'fish', cash: '5000' }).q.cash, 5000);
});

// ------------------------------------------------------------------------------------------------ 8 tradeQuote
test('tradeQuote: defaults reproduce the one-price rule; impact and spread behave; balance numbers', () => {
  const g = mkGame();
  for (const h of HARBORS) {
    const st = g.harbors[h.id];
    for (const k of MARKET_GOODS) for (const q of [1, 100, 5000]) for (const side of ['buy', 'sell']) {
      const r = tradeQuote(h, st, k, q, side);
      assert.equal(r.unit, st.market[k]); assert.equal(r.total, r.unit * q);
    }
  }
  const A = harborById('rotterdam'), stA = g.harbors.rotterdam;
  assert.ok(Number.isInteger(tradeQuote(A, stA, 'fish', 123.4, 'sell').total));
  const saved = { ...TRADE };
  try {
    TRADE.IMPACT = true;
    const b1 = tradeQuote(A, stA, 'steel', 100, 'buy').unit, b2 = tradeQuote(A, stA, 'steel', 5000, 'buy').unit;
    const s1 = tradeQuote(A, stA, 'steel', 100, 'sell').unit, s2 = tradeQuote(A, stA, 'steel', 5000, 'sell').unit;
    assert.ok(b2 > b1, 'a big buy costs more per tonne'); assert.ok(s2 < s1, 'a big sale earns less per tonne');
    assert.equal(tradeQuote(A, stA, 'steel', 0, 'buy').unit, tradeQuote(A, { ...stA, stock: { ...stA.stock } }, 'steel', 0, 'buy').unit);
    assert.equal(tradeQuote(A, stA, 'steel', 0, 'buy').unit, priceOf(A, 'steel', stA.stock.steel, stA.target.steel));
    TRADE.IMPACT = false; TRADE.SPREAD = 0.01;
    assert.ok(tradeQuote(A, stA, 'steel', 1, 'buy').unit > tradeQuote(A, stA, 'steel', 1, 'sell').unit);
  } finally { Object.assign(TRADE, saved); }
  // the balance case of V5-WAVE2 §3.10 (a full coaster hold of steel, Rotterdam → Hull, 410 km). The contract's crafted
  // stocks (9,800 / 15,000 → 4,100 / 6,960) make no trade at all once Hull's stock drifts back toward normal during the
  // 23 h passage (sellArrive), so the case is a steel glut at Rotterdam sold into a thin, balanced Hull market.
  const balance = () => {
    const g2 = mkGame();
    setStock(g2, 'rotterdam', 'steel', 17000, 15000); setStock(g2, 'hull', 'steel', 3000, 3000);
    const row = findTrades(g2, onlyTo('hull', 410), q0({ good: 'steel', limit: 50 })).trades.find((t) => t.to === 'hull');
    return row ? row.net / row.hours : -Infinity;
  };
  assert.ok(balance() > 7000, `defaults: ${balance()} cr per ship hour`);
  try { TRADE.IMPACT = true; TRADE.SPREAD = 0.01; assert.ok(balance() < 2000, `wave 2: ${balance()} cr per ship hour`); } finally { Object.assign(TRADE, saved); }
  // cash-limited search returns the largest affordable integer (also with impact)
  try {
    TRADE.IMPACT = true;
    const q = affordableQty(A, stA, 'steel', 1200, 300000);
    assert.ok(tradeQuote(A, stA, 'steel', q, 'buy').total <= 300000);
    assert.ok(tradeQuote(A, stA, 'steel', q + 1, 'buy').total > 300000);
  } finally { Object.assign(TRADE, saved); }
});

// ------------------------------------------------------------------------------------------------ 9 range flag
test('range flag: bunkering stops when the fuel needed exceeds 90 % of the tank', () => {
  const g = mkGame(); flatten(g);
  setStock(g, 'rotterdam', 'machinery', 40000, 4000);
  const C = SHIP_CLASSES.coaster;
  // hold 1200 t of machinery → load 1; fuel t/h at service speed full; pick km so fuelT = 1.5 × 0.9 × fuelCap
  const burn = serviceBurnTph('coaster', 1), kn = serviceKn('coaster', 1);
  const kmFor = (t) => (t / burn) * kn * RATES.KMH_PER_KN;
  const far = findTrades(g, fixedTable(kmFor(1.5 * 0.9 * C.fuelCap)), q0({ good: 'machinery', limit: 50 })).trades[0];
  assert.ok(far, 'a machinery row exists');
  assert.ok(Math.abs(far.fuelT - 1.5 * 0.9 * C.fuelCap) < 0.2);
  assert.equal(far.bunker, 1);
  const near = findTrades(g, fixedTable(kmFor(100 * 0.1)), q0({ good: 'machinery', limit: 50 })).trades[0];
  assert.equal(near.bunker, 0);
});

// ------------------------------------------------------------------------------------------------ 10 limiter and cache
test('routes handler: 429 after 30 a minute per IP; identical queries within 30 s run findTrades once', () => {
  const g = mkGame();
  let calls = 0, t = 1e12;
  const h = routesHandler({ game: g, routeTable: fixedTable(300), find: (...a) => { calls++; return findTrades(...a); }, now: () => t });
  const res = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
  const req = (url, ip = '1.2.3.4') => ({ headers: {}, socket: { remoteAddress: ip }, originalUrl: url, query: Object.fromEntries(new URL('http://x' + url).searchParams) });
  let r = res(); h(req('/api/market/routes?from=all&cls=coaster'), r); assert.equal(r.code, 200); assert.ok(r.body.trades.length > 0);
  r = res(); h(req('/api/market/routes?from=all&cls=coaster'), r); assert.equal(r.code, 200);
  assert.equal(calls, 1);
  t += 31000;
  r = res(); h(req('/api/market/routes?from=all&cls=coaster'), r); assert.equal(calls, 2);
  r = res(); h(req('/api/market/routes?from=atlantis&cls=coaster'), r); assert.equal(r.code, 400);
  for (let i = 4; i < 30; i++) { r = res(); h(req('/api/market/routes?from=rotterdam&cls=coaster'), r); assert.equal(r.code, 200); }
  r = res(); h(req('/api/market/routes?from=rotterdam&cls=coaster'), r); assert.equal(r.code, 429);
  r = res(); h(req('/api/market/routes?from=rotterdam&cls=coaster', '5.6.7.8'), r); assert.equal(r.code, 200);
  t += 61000;
  r = res(); h(req('/api/market/routes?from=rotterdam&cls=coaster'), r); assert.equal(r.code, 200);
});
