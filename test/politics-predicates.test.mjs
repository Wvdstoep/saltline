// Contract §7 politics-predicates: the `when` language, scaling and personal vs territorial scope.
import test from 'node:test';
import assert from 'node:assert/strict';
import { matches, scaledS, tradeCheck, entryCheck, jobCheck, isActive, dateToS, areasAt, routeExposure, avoidDiscs } from '../shared/politics.js';
import { fixtureDs, ctxFor, T0 } from './politics-helpers.mjs';

const SINCE = dateToS('2022-02-24');

test('flagWas: re-flagged away before the date → no match; after → match; flying it now → match', () => {
  const ds = fixtureDs(), when = { flagWas: { cc: ['XE'], since: '2022-02-24' } };
  assert.equal(matches(when, ctxFor(ds, { flag: 'XC', flagWas: [{ cc: 'XE', from: 0, until: SINCE - 86400 }] })), false);
  assert.equal(matches(when, ctxFor(ds, { flag: 'XC', flagWas: [{ cc: 'XE', from: 0, until: SINCE + 86400 }] })), true);
  assert.equal(matches(when, ctxFor(ds, { flag: 'XE' })), true);
});
test('calledIn 180 days with DAY_TO_H = 1 → a window of 648,000 s', () => {
  const ds = fixtureDs(), when = { calledIn: { cc: ['XF'], days: 180, trade: true } };
  assert.equal(scaledS(180), 648000);
  const call = (dt, trade = true) => ctxFor(ds, { calls: [{ cc: 'XF', at: T0 - dt, trade }] });
  assert.equal(matches(when, call(10 * 3600)), true);
  assert.equal(matches(when, call(648000)), true);
  assert.equal(matches(when, call(648001)), false);
  assert.equal(matches(when, call(3600, false)), false);
});
test('any / all / not, home, follows, cargoOrigin, designated', () => {
  const ds = fixtureDs(), ctx = ctxFor(ds, { home: 'XA', flag: 'XC', cargo: [{ good: 'fuel', qty: 5, origin: 'XE' }], designated: { XB: T0 + 10 } });
  assert.equal(matches({ any: [{ flag: ['XE'] }, { home: ['XA'] }] }, ctx), true);
  assert.equal(matches({ all: [{ flag: ['XC'] }, { home: ['XA'] }] }, ctx), true);
  assert.equal(matches({ all: [{ flag: ['XC'] }, { home: ['XB'] }] }, ctx), false);
  assert.equal(matches({ not: { flag: ['XC'] } }, ctx), false);
  assert.equal(matches({ follows: ['XA'] }, ctx), true);
  assert.equal(matches({ follows: ['XB'] }, ctx), false);
  assert.equal(matches({ cargoOrigin: { cc: ['XE'], goods: ['fuel'] } }, ctx), true);
  assert.equal(matches({ cargoOrigin: { cc: ['XE'], goods: ['steel'] } }, ctx), false);
  assert.equal(matches({ designated: ['XB'] }, ctx), true);
  assert.equal(matches({ designated: ['XB'] }, { ...ctx, simTime: T0 + 11 }), false);
});
test('follows = home follows ∪ flag-state follows (an XA-flag ship of an XC company is bound by XA)', () => {
  const ds = fixtureDs(), ctx = ctxFor(ds, { home: 'XC', flag: 'XA' });
  assert.deepEqual([...ctx.homeFollows], ['UN']);
  assert.ok(ctx.follows.has('XA'));
  assert.equal(tradeCheck(ds, ctx, { harbor: 'he1', good: 'steel', side: 'buy' }).ok, false);
});
test('territorial: an XA company at an XB port with an XB territorial ban → blocked', () => {
  const ds = fixtureDs(), ctx = ctxFor(ds, { home: 'XA' });
  const r = tradeCheck(ds, ctx, { harbor: 'hb1', good: 'fish', side: 'sell', origin: 'XA' });
  assert.equal(r.ok, false); assert.equal(r.block.measureId, 'xb-fish');
  assert.match(r.block.text, /^Not allowed for your company: Decision B9: fish from XA \(JWC, 01 Jan 2026\)\.$/);
  assert.equal(tradeCheck(ds, ctx, { harbor: 'ha1', good: 'fish', side: 'sell', origin: 'XA' }).ok, true);
});
test('personal: an XC company is not bound by XA personal measures; an XA company is', () => {
  const ds = fixtureDs();
  assert.equal(tradeCheck(ds, ctxFor(ds, { home: 'XC' }), { harbor: 'he1', good: 'steel', side: 'buy' }).ok, true);
  const a = tradeCheck(ds, ctxFor(ds, { home: 'XA' }), { harbor: 'he1', good: 'steel', side: 'buy' });
  assert.equal(a.ok, false); assert.equal(a.block.measureId, 'xa-steel');
  // the XC buyer is warned that XA ports seize this cargo, and secondary exposure for XE fuel
  assert.ok(tradeCheck(ds, ctxFor(ds, { home: 'XC' }), { harbor: 'he1', good: 'steel', side: 'buy' }).warn.some((w) => w.measureId === 'xa-steel'));
  assert.ok(tradeCheck(ds, ctxFor(ds, { home: 'XC' }), { harbor: 'he1', good: 'fuel', side: 'buy' }).warn.some((w) => w.code === 'secondary'));
  // export ban (personal): an XA company may not sell machinery in XE
  assert.equal(tradeCheck(ds, ctxFor(ds, { home: 'XA' }), { harbor: 'he1', good: 'machinery', side: 'sell', origin: 'XA' }).ok, false);
  assert.equal(tradeCheck(ds, ctxFor(ds, { home: 'XC' }), { harbor: 'he1', good: 'machinery', side: 'sell', origin: 'XA' }).ok, true);
});
test('port ban by flag and flag history; corridor and clearance entry', () => {
  const ds = fixtureDs();
  assert.equal(entryCheck(ds, ctxFor(ds, { home: 'XC', flag: 'XE' }), 'ha1').ok, false);
  assert.equal(entryCheck(ds, ctxFor(ds, { home: 'XC', flag: 'XE' }), 'hc1').ok, true);
  assert.equal(entryCheck(ds, ctxFor(ds, { home: 'XC', flag: 'XC', flagWas: [{ cc: 'XE', from: 0, until: SINCE + 1 }] }), 'ha1').ok, false);
  const r = entryCheck(ds, ctxFor(ds, { home: 'XC' }), 'hr');
  assert.equal(r.ok, false); assert.equal(r.needs, 'clearance');
  const c = entryCheck(ds, ctxFor(ds, { home: 'XC', clearance: { hr: T0 + 100 } }), 'hr');
  assert.deepEqual([c.ok, c.needs, c.corridor], [true, 'corridor', 'fx-corr']);
  assert.equal(entryCheck(ds, ctxFor(ds, { home: 'XC', flag: 'XH', clearance: { hr: T0 + 100 } }), 'hr').ok, false);
  const z = entryCheck(ds, ctxFor(ds, { home: 'XC' }), 'hz');
  assert.equal(z.refuse.text, 'Zulu Port port control refuses entry: closed to merchant shipping — port operations suspended (JWC).');
});
test('reputation ban at ≤ −60 and designation refuse entry', () => {
  const ds = fixtureDs();
  assert.equal(entryCheck(ds, ctxFor(ds, { home: 'XC', rep: { XD: -60 } }), 'hd1').ok, false);
  assert.equal(entryCheck(ds, ctxFor(ds, { home: 'XC', rep: { XD: -59 } }), 'hd1').ok, true);
  assert.equal(entryCheck(ds, ctxFor(ds, { home: 'XC', designated: { XA: T0 + 1 } }), 'ha2').ok, false);
  assert.equal(entryCheck(ds, ctxFor(ds, { home: 'XC', designated: { XA: T0 + 1 } }), 'hb1').ok, true);
});
test('jobs: arms embargo, cabotage, price-cap carriage warning, rep requirement, measures by date', () => {
  const ds = fixtureDs();
  const arms = jobCheck(ds, ctxFor(ds, { home: 'XC' }), { from: 'hc1', to: 'he1', good: 'weapons', contraband: true });
  assert.equal(arms.ok, false); assert.equal(arms.block.code, 'arms_embargo');
  const cab = jobCheck(ds, ctxFor(ds, { home: 'XC' }), { from: 'ha1', to: 'ha2', good: 'grain' });
  assert.equal(cab.ok, false); assert.match(cab.block.text, /reserved to XA-flag ships/);
  assert.equal(jobCheck(ds, ctxFor(ds, { home: 'XA' }), { from: 'ha1', to: 'ha2', good: 'grain' }, { builtIn: 'XA' }).ok, true);
  assert.equal(jobCheck(ds, ctxFor(ds, { home: 'XA' }), { from: 'ha1', to: 'ha2', good: 'grain' }, { builtIn: 'XX' }).ok, false);
  const cap = jobCheck(ds, ctxFor(ds, { home: 'XA' }), { from: 'he1', to: 'hc1', good: 'fuel' });
  assert.equal(cap.ok, true); assert.ok(cap.warn.some((w) => w.code === 'carriage'));
  const st = { from: 'hc1', to: 'hd1', good: 'grain', pol: { needs: { rep: { cc: 'XC', min: 20 } } } };
  assert.equal(jobCheck(ds, ctxFor(ds, { home: 'XC', rep: { XC: 19 } }), st).ok, false);
  assert.equal(jobCheck(ds, ctxFor(ds, { home: 'XC', rep: { XC: 20 } }), st).ok, true);
  const g = { from: 'ha1', to: 'hd1', good: 'grain' };
  assert.equal(jobCheck(ds, ctxFor(ds, { home: 'XA' }), g).ok, true);                       // 2026-10-08: not yet in force
  assert.equal(jobCheck(ds, ctxFor(ds, { home: 'XA', simTime: dateToS('2026-10-10') }), g).ok, false);
  assert.equal(isActive({ from: null }, T0), false);
});
test('geometry: areas at a point, route exposure in km and hours, avoid discs by policy', () => {
  const ds = fixtureDs();
  assert.deepEqual(areasAt(ds, 44, 30).map((a) => a.id), ['war4', 'fx-corr']);   // corridors are lines: within OFF_CORRIDOR_KM
  assert.deepEqual(areasAt(ds, 44, 30.5).map((a) => a.id), ['war4']);
  assert.deepEqual(areasAt(ds, 39.5, 0, null, T0).map((a) => a.id), []);          // future ECA not in force yet
  assert.deepEqual(areasAt(ds, 39.5, 0).map((a) => a.id), ['eca-future']);
  const ex = routeExposure(ds, { lat: 26, lon: 2.5 }, [[19, 2.5]], 10);
  const w3 = ex.areas.find((a) => a.id === 'war3');
  assert.ok(Math.abs(w3.km - 556) < 5, `war3 km ${w3.km}`);   // 5° of latitude, sampled every ≤ 5 km
  assert.equal(w3.h, Math.round((w3.km / 18.52) * 10) / 10);
  const from = { lat: 50, lon: 0 }, to = { lat: 15, lon: 2.5 };
  assert.deepEqual(avoidDiscs(ds, 'avoid', from, to).map((d) => d.areaId), ['war3']);
  assert.deepEqual(avoidDiscs(ds, 'cautious', { lat: 50, lon: 25 }, { lat: 40, lon: 35 }).map((d) => d.areaId), ['war4']);
  assert.deepEqual(avoidDiscs(ds, 'accept', from, to), []);
  assert.ok(avoidDiscs(ds, 'avoid', from, to)[0].radiusM > 0);
});
