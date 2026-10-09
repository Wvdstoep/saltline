// Inland barges by CEMT class (§7.6), the lane D air-draught stand-in (= lane A §4.4 numbers, §10.1) and the
// stand-in inland planner (§4.10 refusal rules) on the synthetic graph test/fixtures/mh/graph.json.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as lib from '../shared/ships/index.js';
import { setShipSource } from '../shared/jobs/shipview.js';
import { BARGE_MODELS, BARGE_IDS, BARGE_AD, withBarges, bargeCemt, bargesFor } from '../shared/ships/barges.js';
import { cargoPrice, roundPrice, displacementOf, DERIVE } from '../shared/ships/catalogue.js';
import { CEMT, cemtRank, cemtOfDims, fitsCemt, airDraftNow, bestAirDraft, draughtNow, deckTiers, profileOf, passVerdictLite } from '../shared/inlandshim.js';
import { stubPlanInland, explainBlock, plannerShip, loadLaneA, stubLaneA, routeHours, routeKm } from '../server/inlandlink.js';
import { shipDimsOf } from '../server/minorharbours.js';

setShipSource(withBarges(lib));
after(() => setShipSource(null));
const graph = JSON.parse(fs.readFileSync(new URL('./fixtures/mh/graph.json', import.meta.url)));

test('eight barge models in the Model shape, one per CEMT row of §7.6', () => {
  assert.deepEqual(BARGE_IDS, ['spits38', 'kempenaar55', 'dortmunder67', 'rhk85', 'grk110', 'cbarge135', 'tbarge110', 'push4']);
  assert.deepEqual(BARGE_IDS.map(bargeCemt), ['I', 'II', 'III', 'IV', 'Va', 'Vb', 'Va', 'VIb']);
  assert.deepEqual(BARGE_IDS.map((id) => [BARGE_MODELS[id].length, BARGE_MODELS[id].beam, BARGE_MODELS[id].draft]),
    [[38.5, 5.05, 2.5], [55, 6.6, 2.5], [67, 8.2, 2.5], [85, 9.5, 2.8], [110, 11.45, 3.5], [135, 11.45, 3.7], [110, 11.45, 3.5], [193, 22.8, 3.9]]);
  assert.deepEqual(BARGE_IDS.map((id) => BARGE_MODELS[id].capacity), [350, 600, 1000, 1350, 3000, 2500, 2380, 11000]);
  assert.equal(BARGE_MODELS.cbarge135.units.teu, 208);
  assert.equal(BARGE_MODELS.tbarge110.units.m3, 2800);
  // every barge fits the class it is built for (dimensions), and not the class below
  for (const id of BARGE_IDS) {
    const m = BARGE_MODELS[id];
    assert.ok(fitsCemt(m.cemt, m.length, m.beam, m.draft), id);
    if (cemtRank(m.cemt) > 0 && !(id === 'tbarge110')) assert.ok(cemtRank(cemtOfDims(m.length, m.beam, m.draft)) >= cemtRank(m.cemt) - 1, id);
  }
  assert.equal(cemtOfDims(110, 11.45, 3.5), 'Va');        // 11.45 m is the built Va beam (tolerance 0.05 m)
  assert.equal(cemtOfDims(193, 22.8, 3.9), 'VIb');
  // game fields from the §2.4 formulas
  const g = BARGE_MODELS.grk110;
  assert.equal(g.price, roundPrice(cargoPrice(3000, DERIVE.CARGO_TYPE_MUL.general)));
  assert.equal(g.price, 564000);
  assert.equal(g.displacement, displacementOf(110, 11.45, 3.5, 0.88));
  assert.equal(g.burn, 0.308);
  assert.equal(BARGE_MODELS.cbarge135.price, 869000);
  assert.equal(BARGE_MODELS.push4.price, 1700000);
  assert.deepEqual(BARGE_IDS.map((id) => BARGE_MODELS[id].airDraft), [7.6, 7.9, 8.2, 8.3, 8.4, 8, 8, 9.2]);   // kTop + 5.5 − tDesign
  assert.deepEqual(bargesFor('III'), ['spits38', 'kempenaar55', 'dortmunder67']);
  // the ship source sees them (cargo / jobs code reads through shared/jobs/shipview.js)
  assert.deepEqual(shipDimsOf('cbarge135'), { cls: 'cbarge135', L: 135, B: 11.45, T: 3.7, disp: 5004, yacht: false, sail: false, cemt: 'Vb' });
  assert.ok(Object.isFrozen(BARGE_MODELS.grk110));
});

test('air draught stand-in = §10.1 numbers (coaster, sail yachts, catalogue parity)', () => {
  const down = { wheelhouse: 1 };
  assert.equal(profileOf('coaster').dwMax, 1306);
  assert.equal(draughtNow('coaster', {}), 2.652);
  assert.equal(airDraftNow('coaster', { fold: down }).ad, 8.948);
  assert.equal(airDraftNow('coaster', { ballastT: 600, fold: down }).ad, 7.524);
  assert.equal(airDraftNow('coaster', { ballastT: 600, fold: down }).T, 4.076);
  assert.equal(airDraftNow('coaster', { cargo: [{ good: 'containers', qty: 720 }], fold: down }).ad, 9.719);
  assert.equal(deckTiers('coaster', 720), 2);
  assert.equal(airDraftNow('coaster', { cargo: [{ good: 'containers', qty: 576 }], fold: down }).ad, 7.581);
  assert.equal(airDraftNow('coaster', { ballastT: 600 }).ad, 14.924);
  assert.deepEqual(['sloop', 'ketch', 'catamaran', 'schooner'].map((c) => airDraftNow(c, {}).ad), [17, 19.65, 23, 34]);
  assert.equal(airDraftNow('bulker', { cargo: lib.MODELS.bulker.capacity }).ad, lib.MODELS.bulker.airDraft);
  // best case for a contract: folded + ballast to DWmax
  assert.deepEqual([bestAirDraft('coaster').ad, bestAirDraft('coaster').ballastT], [7.524, 600]);
  assert.equal(bestAirDraft('coaster', { cargo: [{ good: 'containers', qty: 720 }] }).fold.wheelhouse, undefined);   // fold refused (stack 14.08)
  // barges
  assert.deepEqual(BARGE_IDS.map((id) => bestAirDraft(id).ad), [3.706, 3.912, 4.122, 4.396, 5.018, 4.49, 4.583, 6.585]);
  const four = airDraftNow('cbarge135', { cargo: [{ good: 'containers', qty: 208 * 12 }], fold: { wheelhouse: 1, mast: 1 } });
  assert.deepEqual([four.deckTiers, four.stackTop, four.T, four.ad], [2, 10.18, 3.696, 6.484]);
  assert.equal(four.need(0), 6.784);                       // 4 tiers pass a CEMT Va 7.0 m bridge
  assert.equal(four.need(0.2), 6.884);
  assert.equal(BARGE_AD.push4.ballastMax, 0);
  // verdicts
  assert.equal(passVerdictLite(7.824, { clr: 9.0 }).verdict, 'under');
  assert.equal(passVerdictLite(9.248, { clr: 9.0 }).verdict, 'never');
  assert.equal(passVerdictLite(17.3, { clr: 3.6, clrO: 24.0 }).verdict, 'opening');
  assert.equal(passVerdictLite(34.3, { clr: 3.6, clrO: 24.0 }).verdict, 'never');
  assert.equal(passVerdictLite(8.6, { clr: 9.0 }).verdict, 'tight');
  assert.equal(passVerdictLite(3, { clr: 9.0, w: 10 }, { beam: 11.45 }).why, 'too wide');
});

test('stand-in planner on the synthetic graph (§4.10 rules, §10.4-style)', () => {
  const ship = (cls, cargo = []) => plannerShip(shipDimsOf(cls), bestAirDraft(cls, { cargo }));
  // container barge with 104 TEU: under the fixed 7.0 m bridge on the short arm, then the Waal lock
  const cb = stubPlanInland(graph, 'rdam', 'nijm', ship('cbarge135', [{ good: 'containers', qty: 1248 }]), 1000);
  assert.deepEqual([cb.km, cb.hours, cb.eta, cb.cemtMin, cb.marks.map((m) => `${m.name}:${m.action}`)], [118, 6.972, 1000 + 25099 + 1, 'Vb', ['Testbrug A:under', 'Testsluis:lock']]);
  // a 17 m sloop: the lift bridge (12 min), 128 km
  const sl = stubPlanInland(graph, 'rdam', 'nijm', ship('sloop'), 0);
  assert.deepEqual([sl.km, sl.hours, sl.marks.map((m) => `${m.name}:${m.action}:${m.waitMin}`)], [128, 7.728, ['Testbrug B:opening:12', 'Testsluis:lock:25']]);
  assert.equal(sl.marks[0].vhf, 18);
  assert.equal(routeHours(sl), 7.728); assert.equal(routeKm(sl), 128);
  // need 7.5: fixed 7.0 refused → round by the lift bridge
  const hi = stubPlanInland(graph, 'rdam', 'alb', { L: 110, B: 11.45, T: 3.5, need: 7.5 }, 0);
  assert.deepEqual(hi.marks.map((m) => m.action), ['opening']);
  const lo = stubPlanInland(graph, 'rdam', 'alb', { L: 110, B: 11.45, T: 3.5, need: 6.9 }, 0);
  assert.deepEqual([lo.km, lo.marks.map((m) => m.action)], [22, ['under']]);
  // too wide for Vb: the push convoy has no route to Alblasserdam; the coaster neither (beam 14 m)
  assert.equal(stubPlanInland(graph, 'rdam', 'alb', ship('push4'), 0), null);
  assert.deepEqual(explainBlock(graph, 'rdam', 'alb', ship('coaster')), { name: 'Noord (short)', why: 'beam 14 m > 11.5 m (CEMT Vb)' });
  // the CEMT II canal and its small lock: a kempenaar goes, a dortmunder (67 m) does not
  assert.ok(stubPlanInland(graph, 'dord', 'small', ship('kempenaar55'), 0));
  assert.equal(stubPlanInland(graph, 'dord', 'small', ship('dortmunder67'), 0), null);
  assert.deepEqual(explainBlock(graph, 'dord', 'small', ship('dortmunder67')), { name: 'Small canal', why: 'length 67 m > 55 m (CEMT II)' });
  // positions snap to the nearest node within 5 km
  assert.ok(stubPlanInland(graph, { lat: 51.901, lon: 4.481 }, { lat: 51.8527, lon: 5.8390 }, ship('sloop'), 0));
  assert.equal(stubPlanInland(graph, { lat: 53, lon: 6 }, 'nijm', ship('sloop'), 0), null);
});

test('loadLaneA falls back to the stand-ins when lane A is absent (and reports what it uses)', async () => {
  const api = await loadLaneA({ importer: () => Promise.reject(new Error('absent')) });
  assert.deepEqual(api.src, { air: 'stub', cemt: 'stub', plan: 'stub' });
  assert.equal(api.AD_MARGIN, 0.3);
  assert.equal(api.CEMT.Va.L, 110);
  assert.equal(api.bestAirDraft('coaster').ad, 7.524);
  assert.equal(stubLaneA().planInland, stubPlanInland);
  // a lane A module with the frozen airDraftNow / profileOf is used through the same best-case composer
  const fake = { AD_MARGIN: 0.3, profileOf: (c) => profileOf(c), airDraftNow: (c, o) => airDraftNow(c, o) };
  const api2 = await loadLaneA({ importer: (s) => (s.endsWith('airdraft.js') ? Promise.resolve(fake) : Promise.reject(new Error('x'))) });
  assert.equal(api2.src.air, 'laneA');
  assert.equal(api2.bestAirDraft('coaster').ad, 7.524);
  assert.equal(CEMT.VIc.b2, 34.2);
});
