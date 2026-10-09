// Lane D §9 test 17 (jobboard): grouping (can do / fleet / other), sorting by profit per hour, chips and unit strings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useStub, actor, T0 } from './jobs2-helpers.mjs';
import { harborById, HARBORS } from '../server/harbors.js';
import { JOB_GEN, step, wireJob, payOf } from '../shared/jobs/types.js';
import { payFor } from '../shared/jobs/catalogue.js';
import { toTonnes } from '../shared/cargo.js';
import * as board from '../shared/jobs/board.js';
import { FAMILIES, groupOf } from '../shared/jobs/catalogue.js';
import { JobBoard } from '../public/js/jobboard.js';

useStub();
const ctx = { harborById, simTime: T0 };
let n = 0;
const cargoJob = (type, from, to, good, unit, qty, pay, extra = {}) => ({ id: `jb${n++}`, gen: JOB_GEN, type, family: type, title: `${type} ${qty} ${unit}`, from, to, legs: null,
  cargo: { good, unit, qty, t: toTonnes(good, qty), ...(extra.cargo || {}) }, pax: 0, needs: { unit, qty }, steps: [step('load', from), step('sail', to, { km: extra.km ?? 500 }), step('discharge', to)],
  window: { readyAt: T0, dueAt: T0 + 9e6 }, pay: { cr: pay, model: 'lump' }, hours: 999, postedAt: T0, expiresAt: T0 + 86400, ...(extra.job || {}) });

test('unit strings', () => {
  const H = harborById;
  assert.equal(board.unitLine(cargoJob('box', 'rotterdam', 'hamburg', 'containers', 'teu', 1200, 1, { cargo: { reefer: 300 } })), '1,200 TEU · 300 reefer');
  assert.equal(board.unitLine(cargoJob('voyage', 'santos', 'rotterdam', 'grain', 't', 55000, 1)), '55,000 t grain');
  assert.equal(board.unitLine(cargoJob('voyage', 'ras_laffan', 'rotterdam', 'lng', 'm3', 174000, 1)), '174,000 m³ LNG');
  assert.equal(board.unitLine({ type: 'ropax_route', crossings: 6, legs: ['dover', 'calais'], from: 'dover', to: 'calais', pax: 300 }, H), '6 crossings Dover ↔ Calais');
  assert.equal(board.unitLine({ type: 'lesson', pax: 4, level: 2, needs: { maxWindKn: 18 } }), '4 students · Level 2 · wind limit 18 kn');
  assert.equal(board.unitLine({ type: 'freight', good: 'steel', qty: 900 }), '900 t steel coils');
  assert.deepEqual(board.stepsPreview(cargoJob('box', 'rotterdam', 'hamburg', 'containers', 'teu', 10, 1)), ['load', 'sail', 'discharge']);
});

test('grouping: your ship / your fleet / other work here, with reasons', () => {
  const you = actor('pctc7000', 'rotterdam');
  const cars = cargoJob('vehicles', 'rotterdam', 'zeebrugge', 'vehicles', 'ceu', 3000, 400000);
  const cars2 = cargoJob('vehicles', 'rotterdam', 'southampton', 'vehicles', 'ceu', 3000, 200000, { km: 700 });
  const grain = cargoJob('voyage', 'rotterdam', 'hamburg', 'grain', 't', 30000, 900000);
  const boxes = cargoJob('box', 'rotterdam', 'hamburg', 'containers', 'teu', 500, 300000);
  const fleet = [
    { id: 'v1', name: 'Kittiwake', ship: { cls: 'handy38' }, docked: 'rotterdam', cargo: [], jobs: [] },
    { id: 'v2', name: 'Puffin', ship: { cls: 'feeder1700' }, docked: 'antwerp', cargo: [], jobs: [] },
    { id: 'v3', name: 'Laid', ship: { cls: 'feeder1700' }, docked: 'rotterdam', status: 'laidup', cargo: [], jobs: [] },
  ];
  const g = board.groupBoard([boxes, grain, cars2, cars], you, fleet, ctx);
  assert.deepEqual(g.mine.map((x) => x.job.id), [cars.id, cars2.id], 'sorted by profit per hour');
  assert.ok(g.mine[0].est.pph > g.mine[1].est.pph);
  assert.deepEqual(g.fleet.map((x) => [x.job.id, x.vessels.map((v) => v.name)]), [[grain.id, ['Kittiwake']]]);
  assert.deepEqual(g.other.map((x) => [x.job.id, x.why.text]), [[boxes.id, 'Needs container cells — e.g. Feeder, Panamax, Neo-Panamax']]);
  const only = board.groupBoard([boxes, grain, cars2, cars], you, fleet, ctx, { filter: 'containers' });
  assert.equal(only.mine.length + only.fleet.length + only.other.length, 1);
});

test('profit per hour = (pay − fuel − crew − dues) / hours', () => {
  const j = cargoJob('vehicles', 'rotterdam', 'zeebrugge', 'vehicles', 'ceu', 3000, 400000, { km: 300 });
  const e = board.profitPerH(j, 'pctc7000', ctx);
  assert.ok(e.hours > 0 && e.fuel > 0 && e.crew > 0 && e.dues > 0);
  assert.equal(Math.round(e.net), Math.round(400000 - e.fuel - e.crew - e.dues));
  assert.equal(e.pph, e.net / e.hours);
});

test('family chips with counts in display order', () => {
  const jobs = [cargoJob('box', 'rotterdam', 'hamburg', 'containers', 'teu', 10, 1), cargoJob('voyage', 'ras_tanura', 'rotterdam', 'crude', 't', 100000, 1),
    cargoJob('voyage', 'santos', 'rotterdam', 'grain', 't', 30000, 1), { type: 'fishing', pay: 5 }, { type: 'lesson', pay: { cr: 1, model: 'lump' } }];
  assert.deepEqual(board.familyChips(jobs).map((c) => [c.group, c.n]), [['cargo', 1], ['tankers', 1], ['containers', 1], ['fishing', 1], ['yachts', 1]]);
  for (const t of Object.keys(FAMILIES)) assert.ok(groupOf({ type: t }), t);
});

test('JobBoard.html renders the three groups and the actions', () => {
  const lib = { ...board, FAMILIES, groupOf };
  const app = { world: { harbors: HARBORS }, simTime: T0, fleetView: { vessels: [{ id: 'v1', name: 'Kittiwake', ship: { cls: 'handy38' }, docked: 'rotterdam', cargo: [], jobs: [] }] } };
  const jb = new JobBoard(app, lib);
  const h = { id: 'rotterdam', name: 'Rotterdam (Maasvlakte)', jobs: [cargoJob('vehicles', 'rotterdam', 'zeebrugge', 'vehicles', 'ceu', 3000, 400000),
    cargoJob('voyage', 'rotterdam', 'hamburg', 'grain', 't', 30000, 900000), cargoJob('box', 'rotterdam', 'hamburg', 'containers', 'teu', 500, 300000)] };
  const html = jb.html(h, actor('pctc7000', 'rotterdam'));
  assert.match(html, /Your ship can do <span class="cnt">1/);
  assert.match(html, /Your fleet can do <span class="cnt">1/);
  assert.match(html, /Other work here <span class="cnt">1/);
  assert.match(html, /data-act="accept" data-job="[^"]+">Accept</);
  assert.match(html, /data-act="jbAssign" data-vessel="v1"[^>]*>Assign to Kittiwake \(captain\)</);
  assert.match(html, /disabled title="Needs container cells — e.g. Feeder, Panamax, Neo-Panamax"/);
  assert.match(html, /3,000 CEU \(cars\)/);
  const sent = [];
  assert.equal(jb.click({ dataset: { act: 'jbFilter', group: 'containers' } }, null), true);
  assert.equal(jb.filter, 'containers');
  jb.click({ dataset: { act: 'jbAssign', vessel: 'v1', job: 'j1' } }, { action: (a, m) => sent.push([a, m]) });
  assert.deepEqual(sent, [['fleet_accept', { vesselId: 'v1', jobId: 'j1' }]]);
});

test('wire form keeps a numeric pay for old readers; payInfo carries the record', () => {
  const tc = { id: 'jw', gen: JOB_GEN, type: 'tc', steps: [step('work', null, { h: 24, hire: true })], pay: { cr: 300000, perH: 12500, rate: 0.0025, hireH: 24, model: 'hire' } };
  const w = wireJob(tc);
  assert.equal(w.pay, 300000); assert.equal(w.payInfo.model, 'hire'); assert.equal(payOf(w), 300000);
  assert.equal(payFor(w, 'ultramax64').cr, 17375 * 24, 'hire for her own price from the wire form');
  assert.equal(board.unitLine(w), '24 h · 12,500 cr/h');
  const legacy = { id: 'jl', type: 'freight', pay: 5000 };
  assert.equal(wireJob(legacy), legacy);
});
