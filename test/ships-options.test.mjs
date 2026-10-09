// docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §9 test 2: options, variant ids and the SHIP_CLASSES lookup wrapper (H1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHIP_CLASSES } from '../shared/constants.js';
import { MODELS, variantId, parseVariant, classRow, optionAllowed, basePrice, effStats, OPTIONS } from '../shared/ships/index.js';
import { installVariants, classesProxy } from '../shared/ships/classes.js';
import { legacyRows } from '../shared/ships/rows.js';
import { ecoGrade } from '../shared/ships/optrules.js';

// A copy of today's table with the H1 hook applied (shared/constants.js itself is not edited in phase 1).
const T = installVariants(structuredClone(SHIP_CLASSES));

test('variant ids: canonical order, round trip, invalid combinations', () => {
  assert.equal(variantId('ultramax64', { engine: 'lng', ice: 'i1c', esd: true }), 'ultramax64~lng.i1c.esd');
  const pv = parseVariant('ultramax64~lng.i1c.esd');
  assert.deepEqual(pv.tokens, ['lng', 'i1c', 'esd']);
  assert.equal(variantId('ultramax64', pv.opts), 'ultramax64~lng.i1c.esd');
  assert.equal(variantId('ultramax64', {}), 'ultramax64');
  assert.equal(variantId('ultramax64', { gear: 'geared' }), 'ultramax64', 'the default gear is not a token');
  assert.equal(variantId('ultramax64', { gear: 'gearless', spec: 'prem' }), 'ultramax64~gearless.prem');
  assert.equal(parseVariant('ultramax64~lng.meoh'), null, 'two engine tokens');
  assert.equal(parseVariant('ultramax64~esd.lng'), null, 'out of canonical order');
  assert.equal(parseVariant('ultramax64~'), null);
  assert.equal(parseVariant('ultramax64~geared'), null, 'already geared');
  assert.equal(parseVariant('tug24~scr'), null, 'scrubber needs ≥ 10,000 GT');
  assert.equal(parseVariant('nosuch~lng'), null);
  assert.equal(parseVariant('__proto__'), null);
  assert.equal(variantId('tug24', { engine: 'meoh' }), null);
  // every allowed single token round-trips for every model
  for (const m of Object.values(MODELS)) for (const t of m.options) {
    const id = `${m.id}~${t}`, p = parseVariant(id);
    assert.ok(p, id);
    assert.equal(variantId(m.id, p.opts), id);
  }
});

test('the H1 wrapper: variants resolve, enumeration stays the 17 legacy ids', () => {
  assert.equal(T['ultramax64~lng.i1c.esd'].burn, 1.171);
  assert.equal(T['ultramax64~meoh'].fuelCap, Math.round(1165 * 2.1));
  assert.equal(T['ultramax64~meoh'].fuelCap, 2447);
  assert.equal(T['ultramax64~lng.meoh'], undefined, 'two engine tokens → undefined');
  assert.equal(Object.keys(T).length, 17);
  assert.deepEqual(Object.keys(T), Object.keys(SHIP_CLASSES));
  assert.equal(JSON.stringify(T), JSON.stringify(SHIP_CLASSES), 'the welcome payload is unchanged');
  assert.ok('tug24' in T); assert.ok(!('nosuch' in T)); assert.ok(!Object.prototype.hasOwnProperty.call(T, 'tug24'));
  assert.equal(T.tug24.price, 256000); assert.equal(T.coaster, T.coaster); assert.deepEqual(T.coaster, SHIP_CLASSES.coaster);
  assert.equal(T.toString, Object.prototype.toString); assert.ok(T.hasOwnProperty('coaster'));
  T.extra = { id: 'extra' }; assert.ok(Object.prototype.hasOwnProperty.call(T, 'extra')); delete T.extra;
  assert.equal(T[Symbol.iterator], undefined);
  // the variant of a legacy id is derived from the live row
  assert.equal(T['bulker~prem'].price, Math.round(4500000 * 1.12 / 1000) * 1000);
  assert.equal(T['sloop~eco'].sail, true);
  // the contract's Proxy form behaves the same
  const P = classesProxy({ ...legacyRows, sloop: SHIP_CLASSES.sloop, ketch: SHIP_CLASSES.ketch, catamaran: SHIP_CLASSES.catamaran, schooner: SHIP_CLASSES.schooner });
  assert.equal(Object.keys(P).length, 17); assert.ok('tug24' in P); assert.equal(P['ultramax64~lng.i1c.esd'].burn, 1.171); assert.equal(P['x~y'], undefined);
});

test('option effects: price, burn, fuel, capacity, eco grade, finish', () => {
  const r = classRow('ultramax64~lng.i1c.esd');
  assert.equal(r.price, basePrice('ultramax64~lng.i1c.esd'));
  assert.equal(r.price, Math.round(6950000 * 1.15 * 1.02 * 1.015 / 1000) * 1000);
  assert.equal(r.fuelCostMul, 0.95); assert.equal(r.ecaExempt, true); assert.equal(r.lngBunkers, true);
  assert.equal(r.eco, 'A', 'B + lng + esd'); assert.equal(r.ice, 'i1c');
  assert.equal(classRow('ultramax64~gearless').capacity, Math.round(57600 / 0.98));
  assert.equal(classRow('kamsarmax82~geared').capacity, Math.round(73800 * 0.98));
  assert.equal(classRow('ultramax64~scr').fuelCostMul, 0.8);
  assert.equal(classRow('ultramax64~rot').airDraft, 46 + 35);
  assert.equal(classRow('ultramax64~eco').wearMul, Math.round(1.1 * 1.08 * 1000) / 1000);
  assert.equal(classRow('cruise330~prem').comfort, 4); assert.equal(classRow('ultramax64~prem').comfort, 1, 'comfort only on passenger types');
  assert.equal(ecoGrade('C', ['meoh', 'esd', 'rot', 'air']), 'A');
  assert.equal(ecoGrade('C', ['esd', 'rot']), 'B', 'esd/rot/air +1 together at most');
  const e = effStats({ ship: { cls: 'ultramax64~prem' }, hist: { specialist: true } });
  assert.equal(e.reliability, 1.1, '1.07 + specialist 0.03');
  assert.equal(classRow('ulcv24k').lngBunkers, true, 'LNG dual-fuel by default');
  assert.deepEqual(classRow('coaster'), SHIP_CLASSES.coaster);
});

test('option rules and yard reasons', () => {
  assert.deepEqual(optionAllowed('ultramax64', 'meoh', 'tsuneishi_cebu'), { ok: false, why: 'This yard does not build methanol engines.' });
  assert.equal(optionAllowed('ultramax64', 'meoh', 'yzj').ok, true);
  assert.equal(optionAllowed('tug16', 'i1as').why, 'Ice class 1A Super needs a hull ≥ 20 m.');
  assert.equal(optionAllowed('ctv26', 'i1c').why, 'Ice class needs a displacement hull.');
  assert.equal(optionAllowed('cruise230', 'de').ok, false, 'already diesel-electric');
  assert.equal(optionAllowed('expedition105', 'pc4', 'helsinki_sy').ok, true);
  assert.equal(optionAllowed('expedition105', 'pc4', 'meyer_papenburg').why, 'This yard does not build Polar Class hulls.');
  assert.equal(optionAllowed('icebreaker120', 'pc4').ok, false);
  assert.equal(optionAllowed('panamax4500', 'air').ok, true); assert.equal(optionAllowed('feeder1700', 'air').ok, false);
  assert.equal(optionAllowed('mr50', 'rot').ok, true); assert.equal(optionAllowed('shortsea88', 'rot').ok, false);
  assert.equal(optionAllowed('ferry50', 'scr').ok, false); assert.equal(optionAllowed('ferry50', 'hyb').ok, false, 'already a battery hybrid');
  assert.equal(optionAllowed('sloop', 'esd').ok, false);
  for (const t of Object.keys(OPTIONS)) assert.ok(OPTIONS[t].basis, t);
});
