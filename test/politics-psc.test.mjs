// Contract §7 politics-psc: risk points, profile, inspection window, detention by hull (§4.7).
import test from 'node:test';
import assert from 'node:assert/strict';
import { pscProfile, pscChance, pDetainFor, flagListing } from '../shared/politics.js';
import { fixtureDs, ctxFor, T0 } from './politics-helpers.mjs';

// Contract §4.7 says 2 % for the 78 % starter, but its own PSC_DETAIN table (≥ 80 → 2 %, ≥ 60 → 6 %) gives 6 %; the table wins.
test('starter coaster (6 years, white flag, 78 %, clean) → 0 points, LRS, 4 %, detention 6 % (2 % from 80 %)', () => {
  const ds = fixtureDs(), ctx = ctxFor(ds, { home: 'XA', flag: 'XA' });
  const v = { cls: 'coaster', built: 2020, cond: 78, psc: { last: {}, detentions: [] } };
  const pp = pscProfile(ds, 'pm', v, ctx);
  assert.deepEqual([pp.total, pp.profile, pp.points.length], [0, 'LRS', 0]);
  const pc = pscChance(ds, 'pm', v, ctx, T0);
  assert.deepEqual([pc.pInspect, pc.pDetain], [0.04, 0.06]);
  assert.equal(pscChance(ds, 'pm', { ...v, cond: 80 }, ctx, T0).pDetain, 0.02);
});
test('tanker 15 years, grey flag, 55 %, 1 detention → 5 points, HRS, 30 %, detention 15 % (4.5 % combined)', () => {
  const ds = fixtureDs(), ctx = ctxFor(ds, { home: 'XC', flag: 'XG' });
  const v = { cls: 'tanker', built: 2011, cond: 55, psc: { last: {}, detentions: [{ regime: 'pm', at: T0 - 10 * 86400 }] } };
  v.pscDetentions = v.psc.detentions;
  const pp = pscProfile(ds, 'pm', v, ctx);
  assert.deepEqual([pp.total, pp.profile], [5, 'HRS']);
  assert.deepEqual(pp.points.map((x) => x.n), [1, 1, 1, 1, 1]);
  const pc = pscChance(ds, 'pm', v, ctx, T0);
  assert.deepEqual([pc.pInspect, pc.pDetain], [0.3, 0.15]);
  assert.equal(Math.round(pc.pInspect * pc.pDetain * 1e6) / 1e6, 0.045);
});
test('inside the profile window → no inspection; outside → the profile chance', () => {
  const ds = fixtureDs(), ctx = ctxFor(ds, { home: 'XC', flag: 'XG' });
  const v = { cls: 'tanker', built: 2011, cond: 55, psc: { last: { pm: T0 - 100 * 3600 }, detentions: [{ regime: 'pm', at: T0 - 10 * 86400 }] } };
  v.pscDetentions = v.psc.detentions;
  assert.equal(pscChance(ds, 'pm', v, ctx, T0).pInspect, 0);
  v.psc.last.pm = T0 - 166 * 3600;
  assert.equal(pscChance(ds, 'pm', v, ctx, T0).pInspect, 0.3);
});
test('black list +2, unlisted +1, ≥ 3 detentions +2; watched standing raises the chance ×1.5', () => {
  const ds = fixtureDs();
  const v = { cls: 'coaster', built: 2024, cond: 90, psc: { last: {}, detentions: [] } };
  assert.equal(pscProfile(ds, 'pm', v, ctxFor(ds, { flag: 'XH' })).total, 2);
  assert.equal(pscProfile(ds, 'pm', v, ctxFor(ds, { flag: 'XD' })).total, 1);
  assert.equal(flagListing(ds.psc.regimes.pm, 'XD'), 'unlisted');
  const det = { ...v, pscDetentions: [1, 2, 3].map((k) => ({ regime: 'pm', at: T0 - k * 86400 })) };
  assert.equal(pscProfile(ds, 'pm', det, ctxFor(ds, { flag: 'XA' })).total, 2);
  const pc = pscChance(ds, 'pm', v, ctxFor(ds, { flag: 'XD', rep: { XD: -30 } }), T0, 'XD');
  assert.ok(Math.abs(pc.pInspect - 0.18) < 1e-12);
});
test('detention given inspection by hull condition', () => {
  assert.deepEqual([pDetainFor(80), pDetainFor(79), pDetainFor(60), pDetainFor(40), pDetainFor(39)], [0.02, 0.06, 0.06, 0.15, 0.4]);
});
