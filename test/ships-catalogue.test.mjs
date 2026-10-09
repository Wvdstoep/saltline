// docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §9 test 1: the 76-model catalogue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHIP_CLASSES } from '../shared/constants.js';
import { MODELS, MODEL_IDS, LEGACY_ROWS, LEGACY_IDS, SAIL_IDS, TYPES, cargoPrice, paxPrice, workPrice, yachtPrice, roundPrice, admiralty, DERIVE } from '../shared/ships/catalogue.js';
import { YARDS, YARD_IDS, CAP_TAGS, YARD_COUNTRIES } from '../shared/ships/yards.js';
import { legacyRows } from '../shared/ships/rows.js';
import { HARBORS, harborById } from '../server/harbors.js';
import { check as appendixCheck } from '../scripts/ships/gen-catalogue.mjs';

const GAME_KEYS = ['id', 'cat', 'name', 'length', 'beam', 'draft', 'maxKn', 'turnRate', 'displacement', 'capacity', 'pax', 'fuelCap', 'burn', 'price', 'hullColor', 'fishRate', 'wearMul', 'crewCost', 'desc'];
const NEW = Object.values(MODELS).filter((m) => m.era === 'eco');
const MERCHANT = new Set(['general', 'container', 'bulk', 'tanker', 'gas', 'roro', 'ferry', 'cruise']);

test('76 models in 16 types, with the type table of §2.1', () => {
  assert.equal(MODEL_IDS.length, 76);
  assert.equal(TYPES.length, 16);
  const count = {};
  for (const m of Object.values(MODELS)) count[m.type] = (count[m.type] || 0) + 1;
  assert.deepEqual(count, { workboat: 2, tug: 4, pilot: 2, fishing: 6, offshore: 5, general: 6, container: 8, bulk: 7, tanker: 8, gas: 4, roro: 2, ferry: 4, cruise: 4, special: 3, motor_yacht: 7, sail_yacht: 4 });
  assert.equal(NEW.length, 59);
});

test('the 17 legacy rows deep-equal today\'s SHIP_CLASSES; every existing id is a model id', () => {
  assert.deepEqual(LEGACY_IDS.sort(), Object.keys(SHIP_CLASSES).sort());
  for (const id of Object.keys(SHIP_CLASSES)) {
    assert.deepEqual(LEGACY_ROWS[id], SHIP_CLASSES[id], id);
    const m = MODELS[id];
    assert.ok(m, id); assert.equal(m.era, 'classic'); assert.equal(m.base, id);
    for (const k of Object.keys(SHIP_CLASSES[id])) assert.deepEqual(m[k], SHIP_CLASSES[id][k], `${id}.${k}`);
  }
  assert.deepEqual(Object.keys(legacyRows).sort(), Object.keys(SHIP_CLASSES).filter((k) => !SAIL_IDS.includes(k)).sort(), 'rows.js carries the 13 non-sail rows (H1)');
  for (const id of SAIL_IDS) { assert.equal(MODELS[id].type, 'sail_yacht'); assert.equal(MODELS[id].sail, true); assert.equal(MODELS[id].gen, 'sail'); }
});

test('new rows: burn = kW × sfoc / 1e6 and the contract\'s expected game numbers', () => {
  for (const m of NEW) assert.ok(Math.abs(m.burn - m.kW * m.sfoc / 1e6) <= 0.001, m.id);
  assert.equal(MODELS.ultramax64.burn, 1.419); assert.equal(MODELS.vlcc300.burn, 4.05); assert.equal(MODELS.lng174k.burn, 4.29);
  const price = { ultramax64: 6950000, mr50: 6200000, vlcc300: 28400000, ulcv24k: 38500000, tug24: 256000, cruise330: 22200000, ropax200: 3810000, giga100: 23300000 };
  for (const [id, p] of Object.entries(price)) assert.equal(MODELS[id].price, p, id);
  assert.equal(MODELS.ultramax64.turnRate, 3.0); assert.equal(MODELS.ultramax64.crewCost, 221); assert.equal(MODELS.ultramax64.fuelCap, 1165);
  assert.equal(MODELS.ultramax64.capacity, 57600); assert.equal(MODELS.ultramax64.displacement, 72439);
});

test('every new row reproduces Appendix A (scripts/ships/gen-catalogue.mjs --check)', () => {
  assert.deepEqual(appendixCheck(), []);
});

test('price formulas of §2.4, recomputed independently', () => {
  for (const m of NEW) {
    let p;
    if (DERIVE.CARGO_TYPE_MUL[m.type] !== undefined) p = cargoPrice(Math.round(0.9 * m.dwt), DERIVE.CARGO_TYPE_MUL[m.type] * (DERIVE.CARGO_MODEL_MUL[m.id] || 1));
    else if (m.type === 'ferry' || m.type === 'cruise') {
      p = paxPrice(m.pax, m.type === 'cruise' ? (m.id === 'expedition105' ? 8 : 4) : m.id === 'hsc112' ? 1.6 : 1);
      if (m.units.lm && m.id === 'ropax200') p += 0.5 * cargoPrice(m.units.lm * 2.5, 1.9);
    } else if (m.type === 'motor_yacht') p = yachtPrice(m.usdM * 1e6);
    else p = workPrice(m.usdM * 1e6, m.type === 'fishing');
    assert.equal(m.price, roundPrice(p), m.id);
  }
  // the fits of §2.4: legacy bulker 4.5 M and tanker 4.2 M are within 5 % of the cargo formula
  assert.ok(Math.abs(cargoPrice(35000, 1) / 4.5e6 - 1) < 0.05);
  assert.ok(Math.abs(cargoPrice(30000, 1.1) / 4.2e6 - 1) < 0.05);
  assert.ok(Math.abs(paxPrice(400, 1) / 700000 - 1) < 0.01, 'legacy ferry 700k for 400 pax');
});

test('size rules: Panamax beams, Neo-Panamax limits, L/B, Admiralty coefficient, Froude number', () => {
  for (const id of ['panamax4500', 'kamsarmax82', 'ultramax64', 'lr1_75']) assert.ok(MODELS[id].beam <= 32.31, id);
  const n = MODELS.neopmax14k; assert.ok(n.length <= 366 && n.beam <= 51.25 && n.draft <= 15.2);
  for (const m of NEW) {
    if (!MERCHANT.has(m.type) || m.id === 'hsc112') continue;           // catamaran: not a monohull
    const lb = m.length / m.beam;
    // exception: the real 294 × 32.2 m Panamax container class has L/B 9.13 (old-lock beam, long hull)
    assert.ok(lb >= 3.5 && lb <= (m.id === 'panamax4500' ? 9.2 : 9), `${m.id} L/B ${lb.toFixed(2)}`);
  }
  // Admiralty coefficient 300–1,000 for cargo/ferry/cruise ≥ 100 m. Exceptions (documented): the fast catamaran, and the
  // diesel-electric ships whose installed kW also feeds hotel / cargo plant (Appendix A Cadm 141–243).
  const ADM_EXCEPT = new Set(['hsc112', 'expedition105', 'cruise362', 'lngbv7500']);
  for (const m of NEW) {
    if (!MERCHANT.has(m.type) || m.length < 100 || ADM_EXCEPT.has(m.id)) continue;
    const c = admiralty(m.displacement, m.maxKn, m.kW);
    assert.ok(c >= 300 && c <= 1000, `${m.id} Cadm ${c}`);
  }
  for (const m of NEW) {
    if (m.length < 100 || m.id === 'hsc112' || !(m.Cb > 0)) continue;   // displacement ships only
    const fn = (m.svcKn * 0.514444) / Math.sqrt(9.81 * m.length);
    assert.ok(fn <= 0.30, `${m.id} Fn ${fn.toFixed(3)}`);
  }
});

test('game fields of new rows follow §2.4 (turn, crew cost, wear, fish, tow, capacity)', () => {
  for (const m of NEW) {
    const tm = DERIVE.TURN_MUL[m.type] || 1;
    assert.equal(m.turnRate, Math.round(Math.min(30, 5.5 * Math.pow(90 / m.length, 0.75) * tm) * 10) / 10, m.id);
    if (DERIVE.CARGO_TYPE_MUL[m.type] !== undefined) assert.equal(m.capacity, Math.round(0.9 * m.dwt), m.id);
    if (m.bp) assert.ok(Math.abs(m.towPower - m.bp / 70) < 0.001, m.id);
    if (m.type !== 'fishing') assert.equal(m.fishRate, 0, m.id);
    assert.ok(m.wearMul >= 1 && m.wearMul <= 1.4, m.id);
  }
  assert.deepEqual(['inshore15', 'beam40', 'longliner50', 'seiner75', 'factory80'].map((id) => MODELS[id].fishRate), [1.0, 2.5, 1.6, 6.0, 5.0]);
  assert.equal(MODELS.tug24.towPower, 1);
});

test('every model has the frozen shape, a builder tag offered by a yard, options and wave-2 stats', () => {
  const offered = new Set(YARD_IDS.flatMap((id) => YARDS[id].builds));
  for (const m of Object.values(MODELS)) {
    for (const k of [...GAME_KEYS, 'type', 'gen', 'base', 'era', 'dwt', 'gt', 'kW', 'sfoc', 'svcKn', 'crew', 'engine', 'usdM', 'buildMonths', 'units', 'eq', 'handling', 'stats', 'options', 'defaults', 'builders', 'minPort', 'tags', 'hidden', 'verify'])
      assert.ok(m[k] !== undefined, `${m.id}.${k}`);
    assert.ok(CAP_TAGS.includes(m.builders[0]), m.id);
    assert.ok(offered.has(m.builders[0]), `${m.id}: no yard builds ${m.builders[0]}`);
    assert.ok(m.buildMonths >= 1 && m.buildMonths <= 42, m.id);
    assert.ok(SHIP_CLASSES[m.base], `${m.id} base ${m.base}`);
    assert.ok(['A', 'B', 'C', 'D', 'E'].includes(m.stats.eco), m.id);
    assert.ok(Object.isFrozen(m));
  }
  assert.deepEqual(MODELS.ultramax64.stats, { airDraft: 46, thrusters: null, maxHs: 8, hull: 0.78, ice: null, reliability: 1.0, comfort: 1, eco: 'B', locker: 12 });
  assert.equal(MODELS.ultramax64.base, 'bulker'); assert.equal(MODELS.ulcv24k.base, 'boxship'); assert.equal(MODELS.feeder1000.base, 'feeder');
});

test('yards: 60 seed yards, every harbour exists in the yard\'s country, every country has a row, no person fields', () => {
  assert.equal(YARD_IDS.length, 60);
  for (const id of YARD_IDS) {
    const y = YARDS[id], h = harborById(y.harbor);
    assert.ok(h, `${id}: harbour ${y.harbor}`);
    assert.equal(h.country, y.cc, `${id} in ${y.cc}, harbour ${h.id} in ${h.country}`);
    assert.ok(YARD_COUNTRIES[y.cc], id);
    for (const t of [...y.builds, ...y.spec]) assert.ok(CAP_TAGS.includes(t), `${id}: ${t}`);
    for (const t of y.spec) assert.ok(y.builds.includes(t), `${id}: speciality ${t} not built`);
    assert.equal(y.verify, true);
  }
  const PERSON = /^(person|people|owner|ceo|founder|director|chairman|contact|email|phone)$/i;
  const walk = (o, path) => { for (const [k, v] of Object.entries(o)) { assert.ok(!PERSON.test(k), `${path}.${k}`); if (v && typeof v === 'object') walk(v, `${path}.${k}`); } };
  walk(YARDS, 'YARDS'); walk(MODELS, 'MODELS'); walk(YARD_COUNTRIES, 'YARD_COUNTRIES');
  assert.equal(YARDS.ru_far_east.name, 'Bolshoy Kamen yard', 'sanctions-target yard: location name only (P6)');
  assert.ok(HARBORS.length > 300);
});

test('sail rows untouched: constants keeps them literal, the catalogue mirrors them exactly', () => {
  for (const id of SAIL_IDS) assert.deepEqual(LEGACY_ROWS[id], SHIP_CLASSES[id]);
  assert.equal(MODELS.sloop.options.join(','), 'eco,prem');
});
