// Inland contracts (§7.6, §10.8.6): barge families by CEMT class, pay from the planned inland route, eligibility with
// CEMT class and air draught on the route, minor-harbour boards (marinas: day charters A→B and inland lessons).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as lib from '../shared/ships/index.js';
import { setShipSource } from '../shared/jobs/shipview.js';
import { withBarges } from '../shared/ships/barges.js';
import { payBox, payVoyage } from '../shared/jobs/catalogue.js';
import { validJob } from '../shared/jobs/types.js';
import {
  INLAND, INLAND_FAMILIES, INLAND_TYPES, INLAND_TERMINALS, INLAND_LESSON_TASKS, generateInlandJob, inlandCanDo, boardFor, refBargeFor, bargesForFamily, portTakes, effKm, routeSummary,
} from '../server/inlandjobs.js';
import { stubLaneA } from '../server/inlandlink.js';

setShipSource(withBarges(lib));
after(() => setShipSource(null));
const graph = JSON.parse(fs.readFileSync(new URL('./fixtures/mh/graph.json', import.meta.url)));
const lane = stubLaneA();
const seeded = (s) => () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
const rdam = { id: 'mh:test:waalhaven', name: 'Waalhaven', lat: 51.9, lon: 4.48, tier: 'inland_port', cemt: 'VIb', tags: ['container', 'bulk', 'tanker'] };
const alb = INLAND_TERMINALS.find((t) => t.id === 'mh:seed:alblasserdam'), nijm = INLAND_TERMINALS.find((t) => t.id === 'mh:seed:nijmegen');
const ports = [rdam, alb, nijm, { id: 'mh:test:nijmtank', name: 'Nijmegen tank storage', lat: 51.853, lon: 5.84, tier: 'inland_port', cemt: 'VIb', tags: ['tanker'] }];
const vessel = (cls, extra = {}) => ({ ship: { cls }, cargo: [], jobs: [], ...extra });

test('families, terminals and reference barges', () => {
  assert.deepEqual(INLAND_TYPES, ['barge_bulk', 'barge_container', 'barge_tanker', 'charter_day']);
  assert.equal(INLAND_FAMILIES.barge_container.fit('cbarge135'), null);
  assert.equal(INLAND_FAMILIES.barge_container.fit('grk110'), 'needs a container hold');
  assert.equal(INLAND_FAMILIES.barge_tanker.fit('tbarge110'), null);
  assert.equal(INLAND_FAMILIES.barge_bulk.fit('coaster'), null);          // the sea-river coaster may carry barge cargo where she fits
  assert.equal(INLAND_FAMILIES.charter_day.fit('sloop'), null);
  assert.equal(INLAND_TERMINALS.length, 7);
  assert.ok(INLAND_TERMINALS.every((t) => t.verify && t.tier === 'inland_port' && t.id.startsWith('mh:seed:')));
  assert.equal(refBargeFor('barge_bulk', 'Vb'), 'grk110');
  assert.equal(refBargeFor('barge_bulk', 'VIb'), 'push4');
  assert.equal(refBargeFor('barge_bulk', 'II'), 'kempenaar55');
  assert.equal(refBargeFor('barge_container', 'Va'), null);               // the container barge is a Vb-size vessel
  assert.equal(refBargeFor('barge_container', 'Vb'), 'cbarge135');
  assert.deepEqual(bargesForFamily('barge_tanker', 'VIb'), ['tbarge110']);
  assert.equal(portTakes(rdam, 'barge_tanker'), true);
  assert.equal(portTakes(alb, 'barge_tanker'), false);
  assert.equal(portTakes({ tier: 'marina' }, 'charter_day'), true);
});

test('barge jobs: route-planned pay, CEMT of the route, deterministic', () => {
  const o = { rnd: seeded(7), simTime: 1000, ports, graph, lane };
  const box = generateInlandJob(rdam, 'barge_container', o);
  assert.ok(validJob(box));
  assert.equal(box.to, 'mh:seed:alblasserdam');
  // 198 TEU = 2 deck tiers: the wheelhouse must stay up to see over the stack (§4.4 fold rule) → need 8.3 m, so the barge
  // goes round by the lift bridge (12 min) instead of under the fixed 7.0 m bridge
  assert.deepEqual([box.cargo.qty, box.needs.cemt, box.needs.maxNeed, box.route.km, box.route.openings, box.route.locks, box.route.waitMin, box.route.marks[0].need], [198, 'Vb', null, 32, 1, 0, 12, 8.3]);
  assert.deepEqual([box.pay.cr, box.hours], [12593, 8]);
  assert.equal(box.pay.cr, Math.round(payBox({ teu: box.cargo.qty, km: effKm(box.route), size: 'minor' }) * INLAND.INLAND_MUL));
  assert.equal(box.ref.cls, 'cbarge135');
  assert.deepEqual(box.steps.map((s) => s.k), ['load', 'sail', 'discharge']);
  assert.equal(box.inland, true);
  // same seed → same job (ids aside)
  const again = generateInlandJob(rdam, 'barge_container', { ...o, rnd: seeded(7) });
  assert.deepEqual({ ...again, id: 0 }, { ...box, id: 0 });
  // bulk to Nijmegen: the push convoy cannot pass the Vb arm, so the biggest barge with a route (Large Rhine, Va) takes it
  const bulk = generateInlandJob(rdam, 'barge_bulk', { ...o, rnd: seeded(3), ports: [rdam, nijm] });
  assert.deepEqual([bulk.to, bulk.ref.cls, bulk.needs.cemt, bulk.needs.maxNeed, bulk.route.km, bulk.route.locks, bulk.route.waitMin, bulk.cargo.good, bulk.cargo.t], ['mh:seed:nijmegen', 'grk110', 'Vb', 7, 118, 1, 25, 'steel', 2819]);
  assert.equal(effKm(bulk.route), 123.8);                                   // 118 km + 25 min × 14 km/h
  assert.equal(bulk.pay.cr, Math.round(payVoyage({ good: bulk.cargo.good, t: bulk.cargo.t, km: 123.8, size: 'minor' }) * 1.3));
  const tank = generateInlandJob(rdam, 'barge_tanker', { ...o, rnd: seeded(5) });
  assert.deepEqual([tank.to, tank.cargo.good, tank.cargo.t, tank.ref.cls], ['mh:test:nijmtank', 'fuel', 2257, 'tbarge110']);
  // nothing where nothing fits
  assert.equal(generateInlandJob(alb, 'barge_tanker', o), null);
  assert.equal(generateInlandJob({ ...rdam, id: 'x' }, 'barge_bulk', { ...o, ports: [] }), null);
  // without a graph: great circle × 1.25, no objects, still a job
  const gc = generateInlandJob(rdam, 'barge_container', { ...o, graph: null, rnd: seeded(7) });
  assert.deepEqual([gc.route.src, gc.route.minFixedClr, gc.needs.cemt], ['gc', null, 'Vb']);
});

test('eligibility adds CEMT and air draught on the route (§10.8.6)', () => {
  // a Vb container-barge route whose fixed bridges clear 7.0 m, 104 TEU (hold only, wheelhouse can go down)
  const gen = generateInlandJob(rdam, 'barge_container', { rnd: seeded(7), simTime: 1000, ports, graph, lane });
  const job = { ...gen, cargo: { good: 'containers', unit: 'teu', qty: 104, t: 1248 }, needs: { ...gen.needs, qty: 104, maxNeed: 7.0 } };
  // the coaster (best case: wheelhouse down, ballast 600 t → ad 7.524 > 6.7) cannot take it; she is also too wide for Vb
  const c = inlandCanDo(job, vessel('coaster'), { lane });
  assert.equal(c.ok, false);
  assert.deepEqual(c.all.map((r) => r.code).filter((k) => k === 'cemt' || k === 'air'), ['cemt', 'air']);
  assert.ok(c.all.find((r) => r.code === 'air').need > 7.0);
  // the container barge takes it
  const ok = inlandCanDo(job, vessel('cbarge135'), { lane, graph });
  assert.deepEqual([ok.ok, ok.all], [true, []]);
  // a kempenaar job to a CEMT II destination is refused for the large Rhine vessel
  const small = { id: 'mh:test:small', name: 'Small canal village', lat: 51.70, lon: 4.95, tier: 'inland_port', cemt: 'II', tags: ['bulk'] };
  const dord = { id: 'mh:test:dord', name: 'Dordrecht', lat: 51.81, lon: 4.67, tier: 'inland_port', cemt: 'VIb', tags: ['bulk'] };
  const kj = generateInlandJob(dord, 'barge_bulk', { rnd: seeded(11), simTime: 0, ports: [dord, small], graph, lane });
  assert.deepEqual([kj.to, kj.ref.cls, kj.needs.cemt], ['mh:test:small', 'kempenaar55', 'II']);
  const big = inlandCanDo(kj, vessel('grk110'), { lane, graph });
  assert.equal(big.ok, false);
  assert.equal(big.why.code, 'cemt');
  assert.equal(big.why.text, 'Waterway CEMT II (55 × 6.6 m, 2.5 m); you are 110 × 11.5 m, 3.5 m');
  assert.equal(inlandCanDo(kj, vessel('kempenaar55'), { lane, graph }).ok, true);
  // the family's hull rule: a tanker barge cannot take a container job
  assert.equal(inlandCanDo(job, vessel('tbarge110'), { lane }).why.code, 'handling');
  // with a graph the route is re-planned for the ship: a spits fits CEMT Vb, needs little air, but…
  const sp = inlandCanDo(job, vessel('spits38'), { lane, graph });
  assert.equal(sp.ok, false);                              // …no container hold
});

test('marina boards: day charters A → B ≤ 40 km and inland lessons (lock, bridge, box tasks)', () => {
  const m1 = { id: 'mh:test:m1', name: 'Jachthaven Een', lat: 51.86, lon: 4.66, tier: 'marina', cc: 'NL' };
  const m2 = { id: 'mh:test:m2', name: 'Jachthaven Twee', lat: 51.81, lon: 4.67, tier: 'marina', cc: 'NL' };
  const far = { id: 'mh:test:far', name: 'Far', lat: 52.4, lon: 4.8, tier: 'marina' };
  const o = { rnd: seeded(13), simTime: 0, ports: [m1, m2, far], graph, lane };
  const ch = generateInlandJob(m1, 'charter_day', o);
  assert.ok(validJob(ch));
  assert.deepEqual([ch.to, ch.steps.map((s) => s.k)], ['mh:test:m2', ['board', 'sail', 'land']]);
  assert.ok(ch.pax >= 2 && ch.pax <= 8);
  assert.equal(ch.pay.cr, Math.round(ch.pax * ch.pay.rate + ch.pax * ch.route.km * INLAND.CHARTER_KM_CR));
  const les = generateInlandJob(m1, 'lesson', { ...o, rnd: seeded(17) });
  assert.equal(les.type, 'lesson');
  assert.ok(les.steps.some((s) => Object.keys(INLAND_LESSON_TASKS).includes(s.task)));
  assert.equal(les.needs.sail, true);
  const board = boardFor(m1, { ...o, rnd: seeded(19) });
  assert.equal(board.length, 4);
  assert.deepEqual([...new Set(board.map((j) => j.type))].sort(), ['charter_day', 'lesson']);
  assert.ok(board.every(validJob));
  assert.equal(boardFor({ ...m1, tier: 'city' }, o).length, 0);
  assert.ok(boardFor(rdam, { rnd: seeded(23), simTime: 0, ports, graph, lane }).length <= 6);
  // a charter for a sloop under the fixed bridge on the short arm is fine (need 17.3 m only if the route has fixed bridges)
  assert.equal(inlandCanDo(ch, vessel('myacht'), { lane }).ok, true);
  assert.deepEqual(routeSummary(null, null).km, 0);
});
