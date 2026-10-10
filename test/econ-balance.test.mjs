// World economy, Lane C: balance per ship class on the seeded world (docs/WORLD-ECONOMY-CONTRACT.md §10, §17; seed 20261009).
//
// T1 is measured the way §10's table is built: each of the top 5 finder rows (default sort, from=all, full cash, full
// hold) against the voyage-contract pay the boards' formula gives for the SAME lift on the SAME route
// (t × km × PAY.PER_T_KM × GOOD_MUL[good] × eos(t), shared/jobs/catalogue.js). Board medians mix in small and hire jobs
// that a full-hold trade is not comparable to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { carvingsForWorld } from '../server/harbors.js';
import { Game } from '../server/game.js';
import { findTrades, parseRoutesQuery } from '../server/market.js';
import { PAY, eos } from '../shared/jobs/catalogue.js';
import { SHIP_CLASSES } from '../shared/constants.js';

process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
const world = new World().load(carvingsForWorld(), () => {});
function seeded(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const T0 = Date.UTC(2026, 9, 9) / 1000;
const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-econ-bal.json' }); g.saveState = () => {}; g.rnd = seeded(20261009);
for (let d = 0; d < 10; d++) { g.simTime = T0 + d * 86400; g.econ.step(24, g.simTime); }
const med = (a) => { const v = [...a].sort((x, y) => x - y); return v[v.length >> 1]; };
const contractPay = (t) => t.qty * t.distKm * PAY.PER_T_KM * (PAY.GOOD_MUL[t.good] ?? 1) * eos(t.qty);
const q = (cls, over = {}) => parseRoutesQuery({ from: 'all', cls, limit: '5', ...over }).q;

for (const cls of ['coaster', 'feeder', 'bulker', 'tanker', 'boxship', 'psv']) {
  test(`T1 ${cls}: the top 5 trades earn 0.5–1.1× the contract pay for the same lift`, () => {
    const r = findTrades(g, null, q(cls));
    assert.equal(r.trades.length, 5);
    const ratios = r.trades.map((t) => t.net / contractPay(t));
    const m = med(ratios);
    assert.ok(m >= 0.5 && m <= 1.1, `${cls}: median ${m.toFixed(2)} (${ratios.map((x) => x.toFixed(2)).join(', ')}) — ${r.trades.map((t) => `${t.good} ${t.from}→${t.to}`).join('; ')}`);
    for (const t of r.trades) assert.ok(t.qty <= SHIP_CLASSES[cls].capacity);
  });
}

test('T1 trawler (known gap): a 300 t fish hold cannot trade at contract level — its running costs exceed the landed margin', () => {
  // §10's own table gives the trawler a landed ceiling of 435 cr/h against 729 cr/h of contract pay (0.6× before any
  // running cost); trawlers earn their living fishing. Reported, not tuned with a per-class special case.
  const r = findTrades(g, null, q('trawler'));
  const m = med(r.trades.map((t) => t.net / contractPay(t)));
  assert.ok(m > 0 && m < 0.5, `trawler ${m.toFixed(2)}`);
});

test('T2 (lower bound): a request row always beats the plain trade on the same route', () => {
  let n = 0;
  for (const cls of ['coaster', 'feeder', 'bulker', 'tanker']) {
    for (const t of findTrades(g, null, q(cls, { mode: 'requests', limit: '10' })).trades) {
      const plain = findTrades(g, { estimateKm: (a, b) => (a === t.from && b === t.to ? { km: t.distKm, est: true } : null) }, parseRoutesQuery({ from: t.from, cls, good: t.good, hold: String(t.qty), limit: '50' }).q).trades.find((x) => x.to === t.to);
      if (!plain) continue;
      n++;
      assert.ok(t.perHour >= plain.perHour, `${cls} ${t.good} ${t.from}→${t.to}: request ${t.perHour} vs plain ${plain.perHour} cr/h`);
    }
  }
  assert.ok(n >= 5, `${n} request rows compared`);
});

test('the from=all scan stays fast (< 400 ms) on the seeded world', () => {
  findTrades(g, null, q('feeder'));
  let ms = Infinity;   // best of 3: the suite runs files in parallel
  for (let i = 0; i < 3; i++) { const t = Date.now(); findTrades(g, null, q('coaster')); ms = Math.min(ms, Date.now() - t); }
  assert.ok(ms < 400, `${ms} ms`);
});
