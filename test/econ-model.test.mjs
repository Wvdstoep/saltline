// World economy, Lane A: the frozen pure interface (docs/WORLD-ECONOMY-CONTRACT.md §16.1) with the contract's exact
// numbers (§17). Inputs are given explicitly; nothing here reads the data files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ECON2, sigma, unitPrice, landFrac, flowsFor, stepStock, bump, mmddDoy, requestTerms, requestPremium, chainK, chainNormalInput,
  dumpPrice, buyable, histEncode, histDecode, migrateStock, quote, roundLot, lotOf, loadEcon, seasonMul, ECON2X,
} from '../shared/econ/model.js';

const r4 = (v) => Math.round(v * 1e4) / 1e4, r2 = (v) => Math.round(v * 100) / 100, r1 = (v) => Math.round(v * 10) / 10;

test('ECON2 is the frozen constant set of §16.1', () => {
  assert.equal(ECON2.R, 0.03); assert.equal(ECON2.COVER_H, 120); assert.equal(ECON2.EQ_K, 0.8); assert.equal(ECON2.EXPORT_DISC, 0.10);
  assert.equal(ECON2.LAND_MAX, 0.8); assert.equal(ECON2.FREIGHT_TKM, 0.06); assert.equal(ECON2.SIG_LO, -0.8); assert.equal(ECON2.SIG_HI, 1.5);
  assert.equal(ECON2.REQ_R, 0.6); assert.equal(ECON2.MAX_LISTED, 32); assert.deepEqual(ECON2.RESERVE, { P: 0.2, L: 0.6, I: 1.0 });
  assert.equal(ECON2.HIST_HOURLY, 168); assert.equal(ECON2.HIST_6H, 120); assert.equal(ECON2.INLAND_CAP_T, 200); assert.equal(ECON2.DUMP_FRAC, 0.45);
});

test('sigma: S 0.35 at s/n 0.2, 0.52, 1, 1.8, 2.5 (clamped at +1.5 and −0.8)', () => {
  const n = 10000;
  assert.equal(r4(sigma(0.35, n, 0.2 * n)), 0.525);
  assert.equal(r4(sigma(0.35, n, 0.52 * n)), 0.2289);
  assert.equal(r4(sigma(0.35, n, n)), 0);
  assert.equal(r4(sigma(0.35, n, 1.8 * n)), -0.2057);
  assert.equal(r4(sigma(0.35, n, 2.5 * n)), -0.28);
});

test('unitPrice: coffee at Santos 1,904; landed coffee at Rotterdam 3,550; iron ore 69 and the clamped importer 203', () => {
  assert.equal(unitPrice({ base: 2345, local: 1, role: 'P', S: 0.15, n: 12000, s: 21600 }), 1904);
  const land = landFrac({ role: 'I', base: 2345, fmul: 1.3, seaKm: 12500 });
  assert.equal(Math.round(land * 1e5) / 1e5, 0.41578);
  assert.equal(unitPrice({ base: 2345, local: 1, role: 'I', S: 0.15, land, n: 2800, s: 1456 }), 3550);
  assert.equal(unitPrice({ base: 100, local: 1, role: 'P', S: 0.35, n: 1000, s: 1800 }), 69);
  const landOre = landFrac({ role: 'I', base: 100, fmul: 0.5, seaKm: 7500 });
  assert.equal(landOre, 0.8);
  assert.equal(unitPrice({ base: 100, local: 1, role: 'I', S: 0.35, land: landOre, n: 1000, s: 520 }), 203);
  assert.equal(landFrac({ role: 'P', base: 100, fmul: 1, seaKm: 1e6 }), -0.1);
  assert.equal(landFrac({ role: 'L', base: 100, fmul: 1, seaKm: 1e6 }), 0);
});

test('flows with n = 10,000 for every balance b (2 decimals)', () => {
  const f = (b, role) => { const x = flowsFor(10000, b, role); return { P: r2(x.P), C: r2(x.C), sEq: Math.round(x.sEq) }; };
  assert.deepEqual(f(1, 'P'), { P: 323.33, C: 83.33, sEq: 18000 });
  assert.deepEqual(f(0.75, 'P'), { P: 263.33, C: 83.33, sEq: 16000 });
  assert.deepEqual(f(0.5, 'P'), { P: 203.33, C: 83.33, sEq: 14000 });
  assert.deepEqual(f(0, 'L'), { P: 83.33, C: 83.33, sEq: 10000 });
  assert.deepEqual(f(-0.3, 'I'), { P: 0, C: 72, sEq: 7600 });
  assert.deepEqual(f(-0.45, 'I'), { P: 0, C: 108, sEq: 6400 });
  assert.deepEqual(f(-0.6, 'I'), { P: 0, C: 144, sEq: 5200 });
});

test('stepStock: closed form 5,103.7 after 24 h; a shut port drains linearly to 1,544', () => {
  assert.equal(r1(stepStock(5000, { n: 10000, P: 0, C: 144, R: 0.03 }, { fP: 1, fC: 1, rMul: 1 }, 24)), 5103.7);
  assert.equal(stepStock(5000, { n: 10000, P: 0, C: 144, R: 0.03 }, { fP: 1, fC: 1, rMul: 0 }, 24), 1544);
  assert.equal(stepStock(100, { n: 10000, P: 0, C: 144, R: 0.03 }, { rMul: 0 }, 24), 0);   // floored at 0
});

test('seasons: wheat, holiday, Valentine, heating and monsoon bumps (4 decimals); yearly mean 1', () => {
  const d = mmddDoy;
  assert.equal(r4(bump(2, 60, d('08-01'), d('08-01'))), 2.5814);
  assert.equal(r4(bump(2, 60, d('08-01'), d('09-01'))), 1.9581);
  assert.equal(r4(bump(2, 60, d('08-01'), d('02-01'))), 0.5814);
  let sum = 0; for (let i = 0; i < 365; i++) sum += bump(2, 60, d('08-01'), i);
  assert.equal(r4(sum / 365), 1.0000);
  assert.equal(r4(bump(1, 40, d('11-25'), d('11-25'))), 1.8605);
  assert.equal(r4(bump(1, 40, d('11-25'), d('12-20'))), 1.416);
  assert.equal(r4(bump(1, 40, d('11-25'), d('03-01'))), 0.8605);
  assert.equal(r4(bump(1.5, 10, d('02-07'), d('02-07'))), 2.4477);
  assert.equal(r4(bump(1.5, 10, d('02-07'), d('06-01'))), 0.9477);
  assert.equal(r4(bump(0.6, 75, d('01-15'), d('01-15'))), 1.443);
  assert.equal(r4(bump(0.6, 75, d('01-15'), d('07-15'))), 0.843);
  assert.equal(r4(bump(-0.6, 60, d('07-20'), d('07-20'))), 0.5256);
  assert.equal(r4(bump(-0.6, 60, d('07-20'), d('01-01'))), 1.1256);
});

test("a southern-hemisphere harbour's wheat peaks on 31 Jan (seasonMul with a contract-amplitude row)", () => {
  const eds = loadEcon({ countries: { AU: { region: null, make: { grain: 1 }, need: {} } }, seasons: [{ good: 'grain', side: 'P', peak: '08-01', W: 60, A: 2, hemi: true }], sites: { sites: [], exportVia: {} } });
  const h = { id: 'test_au', country: 'AU', size: 'major', lat: -32, lon: 115 };
  const at = (mmdd) => Date.UTC(2027, +mmdd.slice(0, 2) - 1, +mmdd.slice(3)) / 1000;
  assert.equal(r4(seasonMul(eds, h, 'grain', 'P', at('01-31'))), 2.5814);
  assert.ok(seasonMul(eds, h, 'grain', 'P', at('01-30')) < 2.5814 && seasonMul(eds, h, 'grain', 'P', at('02-01')) < 2.5814);
  const north = { ...h, id: 'test_n', lat: 50 };
  assert.equal(r4(seasonMul(eds, north, 'grain', 'P', at('08-01'))), 2.5814);
  assert.equal(ECON2X.HEMI_SHIFT, 183);
});

test('requestTerms: premium, deadline and lots', () => {
  assert.equal(r4(requestPremium(0.3)), 0.275);
  assert.equal(r4(requestPremium(0.52)), 0.1833);
  assert.equal(r4(requestPremium(0.1)), 0.3583);
  assert.equal(r4(requestPremium(0)), 0.4);
  const t = requestTerms({ r: 0.52, price: 3550, seaKm: 12500, size: 'mega', n: 2800, s: 1456, good: 'coffee' });
  assert.equal(t.premium, 0.1833); assert.equal(t.unit, Math.round(3550 * 1.1833)); assert.equal(t.deadlineH, 720); assert.equal(t.qty, 1344);
  assert.equal(requestTerms({ r: 0.3, price: 100, seaKm: 500, size: 'mega', n: 2000, s: 750, good: 'grain' }).deadlineH, 55);
  assert.equal(requestTerms({ r: 0.3, price: 100, seaKm: 500, size: 'mega', n: 2000, s: 750, good: 'grain' }).qty, 1200);   // 1,250 t bulk → 1,200
  assert.equal(requestTerms({ r: 0.3, price: 100, seaKm: 500, size: 'mega', n: 200, s: 70, good: 'coffee' }).qty, 120);      // 130 t box → 120
  assert.equal(requestTerms({ r: 0.3, price: 100, seaKm: 500, size: 'mega', n: 20, s: 10, good: 'bananas' }), null);         // 10 t reefer → null
  assert.equal(requestTerms({ r: 0.6, price: 100, seaKm: 500, size: 'mega', n: 2000, s: 1200, good: 'grain' }), null);       // only below 0.6
  assert.equal(requestTerms({ r: 0.1, price: 100, seaKm: 500, size: 'minor', n: 100000, s: 10000, good: 'grain' }).qty, 800);   // REQ_QMAX minor
  assert.deepEqual([lotOf('grain'), lotOf('coffee'), lotOf('bananas'), lotOf('vehicles'), lotOf('livestock')], [100, 12, 14, 1.5, 0.5]);
  assert.equal(roundLot(10.9, 'livestock'), 10.5);
});

test('chains: k from fills and the normal input stock', () => {
  assert.equal(chainK([0.5]), 0.625);
  assert.equal(chainK([1.28]), 1);
  assert.equal(chainK([1, 0.2]), 0.4);
  assert.equal(chainNormalInput(1.6, 363.75), 53889);
  assert.equal(chainNormalInput(0.75, 363.75), 25260);
});

test('dump price, reserve, 16-bit history, migration', () => {
  assert.equal(dumpPrice(2345), 1055);
  assert.equal(buyable('I', 6000, 5000), 1000);
  assert.equal(buyable('I', 4000, 5000), 0);
  assert.equal(buyable('P', 21600, 12000), 19200);
  assert.equal(buyable('L', 7000, 10000), 1000);
  assert.equal(buyable(null, 7000, 10000), 0);
  assert.equal(histEncode(3550, 2345), 15139);
  assert.equal(histDecode(15139, 2345), 3550);
  assert.equal(histEncode(69, 100), 6900);
  assert.equal(histEncode(1e9, 1), 65535);
  assert.equal(histDecode(0, 100), null);
  assert.equal(migrateStock(9800, 15000, 7500), 4900);
});

test('quote: the old exploit round trip at the Santos fixture loses 92,400 cr; Rotterdam pays 3,365 cr/t', () => {
  const santos = { base: 2345, local: 1, role: 'P', S: 0.15, n: 12000, s: 21600 };
  const buy = quote(santos, 1200, 'buy');
  assert.deepEqual(buy, { unit: 1952, total: 2342400 });
  const back = quote({ ...santos, s: 21600 - 1200 }, 1200, 'sell');
  assert.deepEqual(back, { unit: 1875, total: 2250000 });
  assert.equal(back.total - buy.total, -92400);
  const rot = { base: 2345, local: 1, role: 'I', S: 0.15, land: landFrac({ role: 'I', base: 2345, fmul: 1.3, seaKm: 12500 }), n: 2800, s: 1456 };
  assert.deepEqual(quote(rot, 1200, 'sell'), { unit: 3365, total: 4038000 });
});
