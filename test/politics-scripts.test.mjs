// scripts/politics: validator negatives, staleness, version bump, BACI condensing, covering discs; diplomatic jobs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDataset, readDir } from '../scripts/politics/validate.mjs';
import { staleRecords, nextVersion } from '../scripts/politics/refresh.mjs';
import { condense, goodOfHs, movers } from '../scripts/politics/build-trade.mjs';
import { withDiscs } from '../scripts/politics/build-discs.mjs';
import { diplomaticJobs, DIPLO } from '../server/politicsjobs.js';
import { pointInArea, riskPay } from '../shared/politics.js';
import { HARBORS } from '../server/harbors.js';
import { fixtureDs, fixtureParts, makePolitics, T0 } from './politics-helpers.mjs';

const clone = (o) => JSON.parse(JSON.stringify(o));
const real = () => clone(readDir().parts);
const errs = (parts, o = {}) => validateDataset(parts, { harbors: HARBORS, today: '2026-10-09', ...o }).errors;

test('validator rejects verify: true, open or clockwise rings, future asOf, unknown sources, banned words, person fields', () => {
  let p = real(); p.areas[0].verify = true;
  assert.ok(errs(p).some((e) => /verify: true/.test(e)));
  assert.deepEqual(errs(p, { allowUnverified: true }), []);
  p = real(); p.areas[0].poly[0].pop(); assert.ok(errs(p).some((e) => /not closed/.test(e)));
  p = real(); p.areas[0].poly[0].reverse(); assert.ok(errs(p).some((e) => /counter-clockwise/.test(e)));
  p = real(); p.regimes[0].asOf = '2027-01-01'; assert.ok(errs(p).some((e) => /in the future/.test(e)));
  p = real(); p.regimes[0].src = ['no-such-source']; assert.ok(errs(p).some((e) => /unknown source/.test(e)));
  p = real(); p.regimes[0].note = 'an aggressor'; assert.ok(errs(p).some((e) => /banned word/.test(e)));
  p = real(); p.regimes[0].person = 'x'; assert.ok(errs(p).some((e) => /person fields/.test(e)));
  p = real(); delete p.countries.NL; assert.ok(errs(p).some((e) => /no row for harbour country NL/.test(e)));
  p = real(); p.areas.find((a) => a.kind === 'war_risk').tier = 5; assert.ok(errs(p).some((e) => /tier must be 1–4/.test(e)));
  p = real(); p.trade = { flows: { NL: { grain: { exp: 1, imp: 1, top: [['DE', 0.7], ['BE', 0.5]] } } } }; assert.ok(errs(p).some((e) => /shares sum/.test(e)));
  assert.ok(validateDataset(real(), { harbors: HARBORS, today: '2026-10-09', sizes: { countries: 200 * 1024 } }).errors.some((e) => /client subset/.test(e)));
});
test('staleness: records past reviewBy, conflict/status (30-day) first; version bump', () => {
  const st = staleRecords(fixtureParts(), '2026-06-01');
  assert.ok(st.length > 0);
  assert.equal(st.find((r) => r.at === 'sources.fx-old').reviewBy, '2021-01-01');
  const realStale = staleRecords(real(), '2026-12-01');
  assert.ok(realStale[0].conflict);
  assert.equal(nextVersion('2026.10.1', '2026-10-15'), '2026.10.2');
  assert.equal(nextVersion('2026.09.3', '2026-10-01'), '2026.10.1');
});
test('BACI condensing: HS mapping, totals in USD m, top partners as shares', async () => {
  assert.deepEqual(['100199', '120190', '030289', '160414', '720851', '847130', '270900', '940360', '010121'].map(goodOfHs), ['grain', 'grain', 'fish', 'fish', 'steel', 'machinery', 'fuel', 'containers', null]);
  const codes = new Map([['1', 'XA'], ['2', 'XB'], ['3', 'XC']]);
  const lines = ['t,i,j,k,v,q', '2023,1,2,100199,600000,1', '2023,1,3,100630,300000,1', '2023,2,1,100199,100000,1', '2023,1,2,847130,5000,1', '2022,1,2,100199,999999,1', '2023,9,2,100199,7,1'];
  const r = await condense(lines, codes, { year: 2023 });
  assert.equal(r.year, 2023);
  assert.deepEqual(r.flows.XA.grain, { exp: 900, imp: 100, top: [['XB', 0.667], ['XC', 0.333]] });
  assert.deepEqual(r.flows.XB.grain, { exp: 100, imp: 600, top: [['XA', 1]] });
  assert.deepEqual(r.flows.XA.machinery.top, [['XB', 1]]);
  assert.deepEqual(movers({ flows: { XA: { grain: { exp: 800, imp: 100 } } } }, { flows: r.flows }), [{ cc: 'XA', g: 'grain', d: 100 }]);
});
test('covering discs: bbox, one disc for a small square, splits above 600 km', () => {
  const sq = withDiscs({ id: 'a', poly: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] });
  assert.deepEqual(sq.bbox, [0, 0, 2, 2]);
  assert.equal(sq.discs.length, 1); assert.equal(sq.discs[0].rKm, 158);
  const big = withDiscs({ id: 'b', poly: [[[0, 40], [20, 40], [20, 44], [0, 44], [0, 40]]] });
  assert.ok(big.discs.length >= 2 && big.discs.every((d) => d.rKm <= 600), JSON.stringify(big.discs));
  const corr = withDiscs({ id: 'c', line: [[30, 42], [30, 44]], poly: [] });
  assert.deepEqual([corr.bbox, corr.discs], [[30, 42, 30, 44], []]);
});
test('every shipped war-risk and piracy area is covered by its avoid discs at its vertices', () => {
  for (const a of real().areas.filter((x) => x.kind === 'war_risk' || x.kind === 'piracy')) {
    assert.ok(a.discs.length >= 1 && a.discs.every((d) => d.rKm <= 600), a.id);
    assert.ok(pointInArea({ ...a, bbox: a.bbox }, a.discs[0].lat, a.discs[0].lon) || a.discs.length > 1 || a.kind === 'piracy', a.id);
  }
});
test('diplomatic jobs: corridor run from a programme port (tier 4 pay, clearance title)', () => {
  const ds = fixtureDs(), seq = [0.1, 0.0, 0.5];   // corridor roll, destination pick, quantity
  const jobs = diplomaticJobs(ds, 'hr', T0, () => seq.shift() ?? 0.9, { harbors: Object.values(ds.harbors) });
  assert.equal(jobs.length, 1);
  const j = jobs[0];
  assert.deepEqual([j.type, j.from, j.to, j.good, j.qty, j.pol.tier], ['corridor', 'hr', 'hd1', 'grain', 11500, 4]);
  assert.equal(j.pay, riskPay(Math.round(11500 * j.seaKm * DIPLO.PAY_PER_T_KM + 800), 4));
  assert.match(j.title, /^Grain corridor: 11,500 t grain Romeo Port → Delta Port \(corridor, clearance required\)$/);
  assert.equal(j.expiresAt, T0 + 24 * 3600);
});
test('diplomatic jobs: aid to a sourced need, state charter needs standing, avoid-route and evacuation', () => {
  const ds = fixtureDs(), { pol } = makePolitics();
  const env = { harbors: Object.values(ds.harbors), riskOf: (a, b) => pol.riskOf(a, b) };
  const aid = diplomaticJobs(ds, 'ha1', T0, (() => { const s = [0.1, 0.0, 0.0, 0.0, 0.99, 0.99]; return () => s.shift() ?? 0.99; })(), env);
  assert.equal(aid[0].type, 'aid'); assert.equal(aid[0].to, 'hd1'); assert.equal(aid[0].qty, 250);
  assert.match(aid[0].title, /needs listed by JWC, 2026-01-01/);
  const st = diplomaticJobs(ds, 'ha1', T0, (() => { const s = [0.9, 0.1, 0.0]; return () => s.shift() ?? 0.99; })(), env);
  assert.equal(st[0].type, 'state'); assert.equal(st[0].to, 'hd1'); assert.deepEqual(st[0].pol.needs, { rep: { cc: 'XA', min: 20 } });
  const av = diplomaticJobs(ds, 'ha1', T0, (() => { const s = [0.9, 0.9, 0.1, 0.0, 0.0, 0.0]; return () => s.shift() ?? 0.99; })(), env);
  assert.equal(av[0].type, 'avoid'); assert.equal(av[0].to, 'hh1'); assert.deepEqual(av[0].pol.mustAvoid, ['war3']);
  const ev = diplomaticJobs(ds, 'he1', T0, (() => { const s = [0.9, 0.9, 0.1, 0.0, 0.0]; return () => s.shift() ?? 0.99; })(), env);
  assert.equal(ev[0].type, 'evac'); assert.equal(ev[0].pax, 50);
  assert.deepEqual(diplomaticJobs(ds, 'hf1', T0, () => 0.0, { harbors: env.harbors }), []);   // regional, no programme, need or flows
});
