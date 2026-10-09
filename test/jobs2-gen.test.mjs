// Lane D §9 test 13 (jobs-gen): board sizes, family mix by harbour type, the fit guarantee, size bands and pay examples.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useStub, actor, seeded, ctxBase, T0, T_WINTER } from './jobs2-helpers.mjs';
import { harborById } from '../server/harbors.js';
import { generateBoard, generateFamilyJob, ensureFit, weightsFor, BOARD_SIZE, BANDS, generateSalvage } from '../server/jobsgen.js';
import { canDo } from '../shared/jobs/eligibility.js';
import { validJob, JOB_GEN, payOf } from '../shared/jobs/types.js';
import { FAMILIES, RUNNER_TYPES, payVoyage, payBox, tcHirePerH, payLesson, payStandby, paySalvage, eos, groupOf, familiesFor, payFish, weeklyQuota, fishValueFrac, speciesFor } from '../shared/jobs/catalogue.js';

useStub();
const H = harborById;
const YACHT = new Set(['lesson', 'daycharter', 'bareboat', 'regatta', 'ecotour', 'guests', 'charter', 'delivery']);

test('pay examples (exact)', () => {
  assert.equal(payVoyage({ good: 'grain', t: 55000, km: 3000, size: 'mega' }), 6651434);
  assert.equal(payBox({ teu: 1000, km: 1000 }), 1006553);
  assert.equal(payVoyage({ good: 'crude', t: 270000, km: 5000, size: 'mega' }), 32972084);
  assert.equal(tcHirePerH('ultramax64'), 17375);
  assert.equal(payLesson({ level: 2, students: 3, allTasks: true }), 2520);
  assert.equal(payLesson({ level: 2, students: 3 }), 2100);
  assert.equal(payStandby(24), 21600);
  assert.equal(paySalvage(2000000, 0.1), 200000);
  assert.equal(eos(2000), 1); assert.equal(eos(1e12), 0.5);
  assert.equal(payFish({ qty: 100, species: 'crab', size: 'mega' }), 285000);
  assert.equal(weeklyQuota(300), 3000);
  assert.equal(fishValueFrac(22, false), 0.8); assert.equal(fishValueFrac(22, true), 1);
  assert.deepEqual(speciesFor({ lat: 52.3, lon: 3.1 }, 7), ['sole', 'herring']);
});

test('board sizes 24 / 16 / 10 / 6', () => {
  assert.deepEqual(BOARD_SIZE, { mega: 24, major: 16, regional: 10, minor: 6 });
  const rnd = seeded(1);
  for (const [id, n] of [['rotterdam', 24], ['hull', 16], ['palma', 10], ['peterhead', 6]]) {
    assert.equal(H(id).size, { 24: 'mega', 16: 'major', 10: 'regional', 6: 'minor' }[n]);
    assert.equal(generateBoard(H(id), T0, rnd).length, n, id);
  }
});

test('every generated job is a valid JOB_GEN 8 record; boards are deterministic', () => {
  const rnd = seeded(7);
  for (const id of ['rotterdam', 'singapore', 'port_hedland', 'esbjerg', 'palma', 'aberdeen', 'ras_tanura', 'peterhead', 'galveston', 'reykjavik']) {
    for (const j of generateBoard(H(id), T0, rnd)) {
      assert.equal(j.gen, JOB_GEN, `${id} ${j.type}`);
      assert.ok(FAMILIES[j.type], j.type);
      assert.ok(payOf(j) > 0 || j.type === 'regatta', `${j.type} pays`);
      if (!FAMILIES[j.type].legacy) assert.deepEqual(validJob(j), [], `${id} ${j.type}: ${validJob(j)}`);
    }
  }
  const a = generateBoard(H('rotterdam'), T0, seeded(99)).map((j) => j.title);
  const b = generateBoard(H('rotterdam'), T0, seeded(99)).map((j) => j.title);
  assert.deepEqual(a, b);
});

test('every runner family can be generated somewhere', () => {
  const where = { box: 'rotterdam', liner: 'rotterdam', voyage: 'port_hedland', coa: 'ras_tanura', tc: 'rotterdam', project: 'rotterdam', vehicles: 'zeebrugge',
    ropax_route: 'dover', cruise: 'southampton', anchor: 'aberdeen', standby: 'aberdeen', crewchange: 'esbjerg', towage: 'rotterdam', ocean_tow: 'rotterdam',
    pilot_transfer: 'rotterdam', bunkering: 'singapore', launch: 'rotterdam', dredge: 'rotterdam', survey: 'esbjerg', research: 'bergen', escort: 'helsinki',
    lesson: 'palma', daycharter: 'palma', bareboat: 'palma', regatta: 'palma', ecotour: 'reykjavik', guests: 'southampton', delivery: 'palma' };
  for (const type of RUNNER_TYPES) {
    if (type === 'salvage') continue;
    const h = H(where[type]); assert.ok(h, type);
    let j = null;
    for (let s = 1; s < 40 && !j; s++) j = generateFamilyJob(h, type === 'escort' ? T_WINTER : T0, seeded(s), type);
    assert.ok(j, `no ${type} at ${h.id}`);
    assert.deepEqual(validJob(j), [], `${type}: ${validJob(j)}`);
    assert.ok(Number.isFinite(j.hours) && j.hours >= 4, `${type} hours`);
  }
  const s = generateSalvage(H('aberdeen'), { id: 'c1', lat: 57.3, lon: -1.2, value: 2000000 }, T0, seeded(3));
  assert.deepEqual(validJob(s), []); assert.equal(s.pay.model, 'award');
  assert.equal(s.pay.cr, Math.round(2000000 * s.pay.pct)); assert.ok(s.pay.pct >= 0.08 && s.pay.pct <= 0.15);
});

function mix(id, boards, seed) {
  const rnd = seeded(seed), count = {};
  let n = 0;
  for (let b = 0; b < boards; b++) for (const j of generateBoard(H(id), T0, rnd)) { count[j.type] = (count[j.type] || 0) + 1; n++; }
  return { count, n, share: (pred) => Object.entries(count).filter(([t]) => pred(t)).reduce((s, [, c]) => s + c, 0) / n };
}
test('family mix over 1,000 seeded boards', () => {
  const ph = mix('port_hedland', 1000, 11);
  assert.ok(ph.share((t) => t === 'voyage') >= 0.4, `Port Hedland voyage share ${ph.share((t) => t === 'voyage')}`);
  const pe = mix('peterhead', 1000, 12);
  assert.ok(pe.share((t) => t === 'fishing') >= 0.4, `Peterhead fishing share ${pe.share((t) => t === 'fishing')}`);
  const pa = mix('palma', 1000, 13);
  assert.ok(pa.share((t) => YACHT.has(t)) >= 0.3, `Palma yacht share ${pa.share((t) => YACHT.has(t))}`);
});

test('voyage quantities sit inside their size band', () => {
  const cape = BANDS.bulk.find((b) => b[0] === 'Capesize');
  assert.equal(cape[2], 162000);
  let seen = 0;
  for (let s = 1; s < 400; s++) {
    const j = generateFamilyJob(H('port_hedland'), T0, seeded(s), 'voyage', {}, { good: 'ore' });
    if (!j) continue;
    assert.equal(j.cargo.good, 'ore');
    const band = BANDS.bulk.find((b) => b[0] === j.band);
    assert.ok(j.cargo.qty >= Math.round(0.9 * band[2]) && j.cargo.qty <= band[2], `${j.band} ${j.cargo.qty}`);
    if (j.band === 'Capesize') { seen++; assert.ok(j.cargo.qty >= 145800 && j.cargo.qty <= 162000); }
  }
  assert.ok(seen > 0, 'some Capesize liftings');
  const lng = generateFamilyJob(H('ras_laffan'), T0, seeded(5), 'voyage', {}, { good: 'lng' });
  assert.equal(lng.cargo.unit, 'm3'); assert.ok(lng.cargo.qty >= 156600 && lng.cargo.qty <= 174000);
  assert.equal(lng.cargo.t, Math.round(lng.cargo.qty * 0.45 * 1000) / 1000);
  assert.equal(groupOf(lng), 'tankers');
});

test('fit guarantee: every docked ship finds at least 3 doable jobs', () => {
  const cases = [['pctc7000', 'rotterdam'], ['vlcc300', 'ras_tanura'], ['lng174k', 'ras_laffan'], ['feeder1700', 'hamburg'], ['capesize180', 'port_hedland'],
    ['tug24', 'rotterdam'], ['ctv26', 'esbjerg'], ['sov90', 'esbjerg'], ['tshd100', 'rotterdam'], ['sloop', 'palma'], ['giga100', 'southampton'],
    ['trawler', 'peterhead'], ['coaster', 'lowestoft'], ['ropax200', 'dover'], ['livestock135', 'fremantle'], ['research75', 'bergen'], ['mr50', 'singapore'],
    ['bunker85', 'singapore'], ['icebreaker120', 'helsinki']];
  for (const [cls, hid] of cases) {
    const h = H(hid), rnd = seeded(hid.length * 31 + cls.length);
    const board = generateBoard(h, T0, rnd);
    const v = actor(cls, hid), ctx = ctxBase(T0);
    ensureFit(board, h, v, ctx, T0, rnd);
    const ok = board.filter((j) => canDo(j, v, ctx).ok);
    assert.ok(ok.length >= 3, `${cls} at ${hid}: ${ok.length} doable (${board.map((j) => j.type).join(',')})`);
  }
});

test('the pctc7000 at Rotterdam gets vehicle work sized to her', () => {
  const h = H('rotterdam'), rnd = seeded(2), v = actor('pctc7000', 'rotterdam'), ctx = ctxBase(T0);
  const board = [];
  const added = ensureFit(board, h, v, ctx, T0, rnd);
  assert.ok(added.length >= 3);
  assert.ok(added.some((j) => j.type === 'vehicles' && j.cargo.unit === 'ceu' && j.cargo.qty <= 7000));
  for (const j of added) assert.equal(canDo(j, v, ctx).ok, true, j.title);
});

test('weights: harbour tags, seeds, seasons and phases', () => {
  const w = (id, t = T0, o) => Object.fromEntries(weightsFor(H(id), t, o).reduce((m, e) => { m.set(e.type, (m.get(e.type) || 0) + e.w); return m; }, new Map()));
  assert.equal(w('port_hedland').voyage, 4 * 4 + 4 + 2 * 4, 'ore ×4 (seed) + products + livestock ×4 (seed)');
  assert.equal(w('peterhead').fishing, 16);
  assert.equal(w('helsinki', T0).escort, undefined); assert.equal(w('helsinki', T_WINTER).escort, 1);
  assert.equal(w('esbjerg').crewchange, 1 * 4 + 3 * 4, 'offshore + windfarm seeds');
  const p2 = weightsFor(H('rotterdam'), T0, { phase: 2 }).map((e) => e.type);
  for (const t of p2) assert.ok(FAMILIES[t].legacy || FAMILIES[t].phase <= 2, t);
  assert.ok(p2.includes('box') && p2.includes('voyage') && !p2.includes('liner'));
  assert.deepEqual(familiesFor('pctc7000', { phase: 2, includeLegacy: false }), ['tc', 'vehicles']);
  assert.ok(familiesFor('tug24').includes('towage'));
  assert.ok(familiesFor('sloop').includes('lesson') && familiesFor('sloop').includes('regatta'));
});
