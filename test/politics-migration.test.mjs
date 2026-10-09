// Contract §7 politics-migration: v6 saves without politics fields load, default and grandfather (§6.5).
import test from 'node:test';
import assert from 'node:assert/strict';
import { dutyFor, dateToS } from '../shared/politics.js';
import { healOfficePol, healVesselPol, newOfficePol } from '../server/politics.js';
import { makePolitics, T0 } from './politics-helpers.mjs';

const v6save = () => ({
  id: 'p9', name: 'Old Salt', money: 50000, office: { home: 'ha1', homeMoves: 0 },
  ship: { cls: 'coaster', lat: 50, lon: 0, spd: 0 }, cond: 78,
  cargo: [{ good: 'steel', qty: 100, contraband: false, jobId: null }],
  jobs: [{ id: 'jold', type: 'freight', from: 'ha1', to: 'hd1', good: 'grain', qty: 100, pay: 5000, title: 'Old grain run' }],
});
test('a v6 save without politics fields loads with defaults', () => {
  const { pol } = makePolitics(), p = v6save();
  pol.migrate(p);
  assert.deepEqual(p.office.pol, newOfficePol());
  assert.deepEqual(p.flag, { cc: 'XA', registry: 'national:XA', since: 0 });
  assert.equal(p.built, 2026 - 6);
  assert.deepEqual([p.builtIn, p.held, p.scrubber, p.flagWas], ['XX', null, false, []]);
  assert.equal(p.cargo[0].origin, null);
});
test('built year from condition, clamped to 0–30 years', () => {
  assert.equal(healVesselPol({ cond: 78 }, 'XA', T0).built, 2020);
  assert.equal(healVesselPol({ cond: 0 }, 'XA', T0).built, 1997);   // 28.6 → 29 years
  assert.equal(healVesselPol({ cond: 100 }, 'XA', T0).built, 2026);
  assert.equal(healVesselPol({ cond: -500 }, 'XA', T0).built, 1996);
});
test('cargo of unknown origin pays MFN and is never seized', () => {
  const { pol } = makePolitics(), p = v6save();
  pol.migrate(p);
  assert.equal(dutyFor(pol.ds, pol.ctxOf(p), { harbor: 'hd1', good: 'steel', origin: p.cargo[0].origin, value: 90000 }).duty, 4500);
  const r = pol.onDock(p, 'ha1');
  assert.deepEqual(r.seized, []); assert.equal(p.cargo.length, 1);
});
test('old accepted jobs are grandfathered: only closures cancel them', () => {
  const { pol, game } = makePolitics(), p = v6save();
  pol.migrate(p);
  game.simTime = dateToS('2026-10-20');
  assert.deepEqual(pol.reconcile(p), []);
  p.jobs[0].to = 'hz';
  assert.deepEqual(pol.reconcile(p), [{ jobId: 'jold', action: 'cancelled', pay: 1250 }]);
});
test('wrong types are reset and unknown country codes dropped from standing', () => {
  const { pol } = makePolitics();
  const h = healOfficePol({ rep: { XA: 5.4, ZZ: 3, bad: 1, XB: 'x', XC: 500 }, riskPolicy: 'yolo', warCover: 'ask', records: 'no', pending: { harbor: 'hc1' } }, pol.ds.countries);
  assert.deepEqual(h.rep, { XA: 5, XC: 100 });
  assert.deepEqual([h.riskPolicy, h.warCover, h.records, h.pending], ['avoid', 'ask', [], null]);
  const v = healVesselPol({ cond: 50, flag: 'XA', psc: 3, held: { why: 'x' }, cargo: [{ good: 'fish', qty: 1 }] }, 'XC', T0);
  assert.deepEqual([v.flag.cc, v.psc.detentions, v.held, v.cargo[0].origin], ['XC', [], null, null]);
  assert.doesNotThrow(() => pol.migrate({}));
  assert.doesNotThrow(() => pol.migrate(null));
});
