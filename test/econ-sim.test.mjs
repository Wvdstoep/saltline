// World economy, Lane B: the simulation on the seeded world (docs/WORLD-ECONOMY-CONTRACT.md §6, §8, §10 T4/T5, §17).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { carvingsForWorld, harborById, HARBORS } from '../server/harbors.js';
import { Game } from '../server/game.js';
import { GOODS } from '../shared/constants.js';
import { ECON2, stepStock } from '../shared/econ/model.js';

process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
const world = new World().load(carvingsForWorld(), () => {});
function seeded(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function mkGame(opts = {}) { const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-econ-sim.json', ...opts }); g.saveState = () => {}; g.rnd = seeded(20261009); return g; }
const T0 = Date.UTC(2026, 8, 1) / 1000;   // 1 Sep: no short (Valentine-type) season is running
/** Rows of the econ as { i, k, h, g, st }. */
function* rows(g) { const e = g.econ; for (let i = 0; i < e.harbors.length; i++) { const h = e.harbors[i], st = g.harbors[h.id]; for (let k = e.off[i]; k < e.off[i + 1]; k++) yield { i, k, h, g: e.gOf(k), st }; } }

test('a market step over ~7,700 rows stays under a few milliseconds', () => {
  const g = mkGame();
  for (let i = 0; i < 50; i++) g.econ.step(1 / 60, T0 + i * 60);
  let ms = Infinity;   // best of 5 batches: the suite runs files in parallel
  for (let b = 0; b < 5; b++) { const t = process.hrtime.bigint(); for (let i = 0; i < 40; i++) g.econ.step(1 / 60, T0 + 3000 + (b * 40 + i) * 60); ms = Math.min(ms, Number(process.hrtime.bigint() - t) / 1e6 / 40); }
  assert.ok(ms < 8, `${ms.toFixed(2)} ms per step`);
});

test('with no players every harbour × good settles within 5 % of its seasonal equilibrium after 30 days (noise on)', () => {
  const g = mkGame();
  const evAt = new Map();   // harbour → last time it had an event (a boom's extra stock takes a day or two to ship out)
  for (let h = 0; h < 30 * 24; h++) { g.simTime = T0 + h * 3600; g.econ.step(1, g.simTime); for (const x of HARBORS) if (g.harbors[x.id].ev) evAt.set(x.id, g.simTime); }   // the noise term grows with the step: step hourly
  let bad = [], n = 0;
  for (const r of rows(g)) {
    if (r.st.ev || g.simTime - (evAt.get(r.h.id) ?? -1e12) < 3 * 86400) continue;   // a strike, storm or boom moves the target itself
    const sEq = g.econ.sEqOf(r.k, r.st), s = r.st.stock[r.g], nn = g.econ.n(r.k);
    n++;
    // the contract's noise term (0.01 × n × h × (rnd − 0.5)) keeps a stationary spread of ≈ 1.2 % of n around s*
    // 5 % is ≈ 4 σ of that spread: over 6,000+ rows one or two such draws are expected, a real drift goes past 8 %
    if (Math.abs(s - sEq) > 0.05 * nn) bad.push({ far: Math.abs(s - sEq) > 0.08 * nn, txt: `${r.h.id}:${r.g} ${Math.round(s)} vs ${Math.round(sEq)}` });
  }
  assert.ok(n > 6000, `${n} rows checked`);
  assert.deepEqual(bad.filter((b) => b.far).map((b) => b.txt), [], 'rows off by more than 8 %');
  assert.ok(bad.length <= 2, `${bad.length} rows off by more than 5 %: ${bad.map((b) => b.txt).join(', ')}`);
});

test('T4 and T5 over a simulated year: bunker price within ±25 % of base × fuelMul; no good at the σ clamp > 10 % of the year', () => {
  const g = mkGame(), e = g.econ, STEP = 2, steps = 365 * 24 / STEP, LO = ECON2.SIG_LO, HI = ECON2.SIG_HI;
  const atClamp = new Uint16Array(e.K), politics = new Set();
  let worstFuel = 0, worstAt = '';
  for (let x = 0; x < steps; x++) {
    g.simTime = T0 + x * STEP * 3600; e.step(STEP, g.simTime);
    for (let i = 0; i < e.harbors.length; i++) {
      const st = g.harbors[e.harbors[i].id];
      if (st.ev && (st.ev.kind === 'closed' || st.ev.kind === 'restricted')) politics.add(e.harbors[i].id);
      for (let k = e.off[i]; k < e.off[i + 1]; k++) { const l = Math.log(Math.max(1, e.n(k)) / Math.max(1, st.stock[e.gOf(k)])); if (l >= HI || l <= LO) atClamp[k]++; }
    }
    if (x % 12 === 0) for (const h of HARBORS) { const dev = Math.abs(g.fuelPrice(h) / (GOODS.fuel.base * (h.fuelMul || 1)) - 1); if (dev > worstFuel) { worstFuel = dev; worstAt = `${h.id} ${g.fuelPrice(h)}`; } }
  }
  assert.ok(worstFuel <= 0.25, `bunker price off by ${(worstFuel * 100).toFixed(1)} % at ${worstAt}`);
  // a port politics holds closed or restricted (Odesa) is not the model breathing: it is excluded and named
  assert.ok(politics.has('odesa'), [...politics].join(','));
  const over = [];
  for (const r of rows(g)) if (!politics.has(r.h.id) && atClamp[r.k] / steps > 0.1) over.push(`${r.h.id}:${r.g} ${(100 * atClamp[r.k] / steps).toFixed(0)} %`);
  assert.deepEqual(over, [], `at the clamp more than 10 % of the year: ${over.slice(0, 10).join(', ')}`);
});

test('a dock strike closes the market, stops all shipping (rMul 0) and drains an importer by 24 × C × fC a day', () => {
  const g = mkGame(); g.rnd = () => 0.5; g.simTime = T0;
  const e = g.econ, st = g.harbors.rotterdam, k = e.row('rotterdam', 'coffee');
  e.forceEvent('rotterdam', 'strike', 72);
  const s0 = st.stock.coffee, C = e.D[k * 8 + 2] * e.fC[k] * e.kIn(k);
  e.step(24, T0);
  assert.ok(Math.abs(st.stock.coffee - Math.max(0, s0 - 24 * C)) < 0.01, `${st.stock.coffee} vs ${s0 - 24 * C}`);
  assert.ok(e.marketClosed(st));
  const p = { id: 'px', docked: 'rotterdam', ship: { cls: 'feeder' }, cargo: [], money: 1e6, stats: { earned: 0 } };
  const ev = []; g.event = (a, kind, text) => ev.push(text); g.sendYou = () => {}; g.sendHarbor = () => {};
  g.tradeGoods(p, 'flowers', 10, true);
  assert.equal(p.cargo.length, 0); assert.match(ev.at(-1), /Dock strike — market closed until/);
  // a maker piles up while nobody ships it
  const ks = e.row('santos', 'coffee'), ss = g.harbors.santos;
  e.forceEvent('santos', 'strike', 72); const before = ss.stock.coffee; e.step(24, T0 + 86400);
  assert.ok(ss.stock.coffee > before, 'Santos piles up coffee during the strike');
  assert.ok(ks >= 0);
});

test('a storm covering Rotterdam multiplies R by 0.3 for its duration', () => {
  const g = mkGame(); g.rnd = () => 0.5; g.simTime = T0;
  const e = g.econ, st = g.harbors.rotterdam, k = e.row('rotterdam', 'coffee');
  st.ev = null; st.stock.coffee = 500;
  g.storms = [{ id: 'sx', lat: 51.98, lon: 4.03, radiusKm: 80, dies: T0 + 6 * 3600, name: 'Test' }];
  const d = k * 8, n = e.n(k), P = e.D[d + 1] * e.fP[k], C = e.D[d + 2] * e.fC[k] * e.kIn(k);
  const want = stepStock(500, { n, P, C, R: ECON2.R }, { rMul: 0.3 }, 1);
  e.step(1, T0);
  assert.equal(st.ev?.kind, 'storm');
  assert.ok(Math.abs(st.stock.coffee - want) < 0.01, `${st.stock.coffee} vs ${want}`);
});

test('real storms (server/realstorms.js cells()) count too; an event failure never stops the markets', () => {
  const g = mkGame(); g.rnd = () => 0.5; g.simTime = T0; g.harbors.hamburg.ev = null;
  g.realStorms = { cells: () => [{ id: 'r1', name: 'Real', lat: 53.54, lon: 9.93, radiusKm: 50, intensity: 0.8 }] };
  g.econ.step(1, T0);
  assert.equal(g.harbors.hamburg.ev?.kind, 'storm');
  g.realStorms = { cells: () => { throw new Error('boom'); } };
  const s0 = g.harbors.rotterdam.stock.coffee; g.harbors.rotterdam.stock.coffee = s0 * 0.5;
  assert.doesNotThrow(() => g.econ.step(1, T0 + 3600));
  assert.notEqual(g.harbors.rotterdam.stock.coffee, s0 * 0.5, 'stocks still moved');
});

test('sanctions (§9.3): the EU import ban on Russian steel moves Gdańsk’s nearest steel maker from Baltiysk to Malmö', () => {
  const g = mkGame(), g0 = mkGame({ politics: false });
  const e = g.econ, k = e.row('gdansk', 'steel');
  const land = e.D[k * 8 + 4], km = e.D[k * 8 + 6], maker = e.harbors[e.maker[k]];
  g0.econ.computeLanded();
  const land0 = g0.econ.D[k * 8 + 4], maker0 = g0.econ.harbors[g0.econ.maker[k]];
  assert.equal(maker0.id, 'baltiysk', `without politics the nearest steel maker is ${maker0.id}`);
  assert.equal(maker.id, 'malmo', `with the EU ban: ${maker.id}`);
  assert.ok(land > land0 && km > 0, `landed ${land0} → ${land}`);
  // polGroup: the steel measure also covers iron ore and pipes of Russian origin
  assert.ok(e.banned('ore', 'RU', 'PL') && e.banned('pipes', 'RU', 'PL') && !e.banned('coffee', 'RU', 'PL') && !e.banned('steel', 'RU', 'CN'));
  // when every maker within 5,000 km is banned, AI shipping halves for that good
  const makers = [...new Set(e.makersOf('steel').map((h) => h.country))];
  const ds = g.politics.ds;
  g.politics = { ds: { ...ds, measures: [...ds.measures, { id: 'fx-all-steel', kind: 'import_ban', scope: 'territorial', authority: 'EU', origin: makers.filter((c) => c !== 'PL'), goods: ['steel'], from: '2020-01-01' }] } };
  e.onPolitics();
  assert.equal(e.sanc[k], 1);
  assert.equal(e.rMulOf(e.hIdx.get('gdansk'), k, { ev: null }), 0.5);
});

test('chains (§8.3): IJmuiden cut off from ore makes less steel, its steel price rises and an ore request opens', () => {
  const mk = () => { const g = mkGame(); g.rnd = () => 0.5; g.simTime = T0; return g; };
  const a = mk(), b = mk(), sa = a.harbors.ijmuiden, sb = b.harbors.ijmuiden;
  sa.stock.steel = sb.stock.steel = a.econ.n(a.econ.row('ijmuiden', 'steel')) * 1.8;
  sb.stock.ore = Math.round(b.econ.n(b.econ.row('ijmuiden', 'ore')) * 0.1);
  for (const g of [a, b]) for (const id of ['ijmuiden']) g.harbors[id].ev = null;
  // the cut-off: no AI ore deliveries (a sanction-style rMul 0 on the ore row only)
  b.econ.sanc[b.econ.row('ijmuiden', 'ore')] = 1;
  for (let h = 0; h < 24; h++) { a.econ.step(1, T0 + h * 3600); b.econ.step(1, T0 + h * 3600); }
  const site = b.econ.sites[b.econ.hIdx.get('ijmuiden')].find((s) => s.chain === 'steel');
  assert.ok(site.k < 0.7, `steelworks running at ${site.k}`);
  assert.ok(sb.stock.steel < sa.stock.steel, `steel ${Math.round(sb.stock.steel)} < ${Math.round(sa.stock.steel)}`);
  assert.ok(sb.market.steel >= sa.market.steel, `steel price ${sb.market.steel} ≥ ${sa.market.steel}`);
  assert.ok(sb.req.some((q) => q.good === 'ore'), 'an ore request is open');
});

test('prices: makers sell below base, importers pay the landed price; tier-1 makers sit at 1.8 n, tier-1 importers at 0.52 n', () => {
  const g = mkGame(); g.rnd = () => 0.5;
  for (let d = 0; d < 10; d++) g.econ.step(24, T0 + d * 86400);
  const sa = g.harbors.santos, ro = g.harbors.rotterdam;
  assert.ok(sa.market.coffee < GOODS.coffee.base && ro.market.coffee > GOODS.coffee.base, `${sa.market.coffee} / ${ro.market.coffee}`);
  const r = (id, gd) => g.harbors[id].stock[gd] / g.econ.n(g.econ.row(id, gd));
  assert.ok(Math.abs(r('santos', 'coffee') - 1.8) < 0.15, `Santos ${r('santos', 'coffee')}`);
  assert.ok(Math.abs(r('rotterdam', 'coffee') - 0.52) < 0.05, `Rotterdam ${r('rotterdam', 'coffee')}`);
  // the landed ceiling: no harbour's price exceeds its nearest seller's by more than the freight
  const e = g.econ;
  for (const x of rows(g)) { const c = e.ceil[x.k]; if (Number.isFinite(c)) assert.ok(x.st.market[x.g] <= Math.round(c) + 1, `${x.h.id}:${x.g}`); }
  assert.ok(e.memBytes < 1.5e6, `derived arrays ${e.memBytes} B`);
});

