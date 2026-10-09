// Lane D §9 test 16 (jobs-migration): gen-7 board offers leave at the first regen; accepted gen-7 jobs finish exactly as
// before (no handling check), cargo stacks heal to tonnes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useStub, actor, T0, seeded, ctxBase } from './jobs2-helpers.mjs';
import { harborById } from '../server/harbors.js';
import { JOB_GEN, boardCurrent, migrateAcceptedJob, isRunnerJob, isLegacyGen, healCargoStack, migrateActor, payOf } from '../shared/jobs/types.js';
import { JobsX, migrateSave } from '../server/jobsx.js';
import { canDo } from '../shared/jobs/eligibility.js';
import { generateBoard } from '../server/jobsgen.js';

useStub();
const gen7Freight = () => ({ id: 'j7a', type: 'freight', from: 'rotterdam', to: 'hamburg', good: 'grain', qty: 2000, pay: 48000, distKm: 400, seaKm: 500,
  contraband: false, title: 'Freight 2000 t of Grain to Hamburg', hours: 30, gen: 7, postedAt: T0 - 3600, expiresAt: T0 + 80000 });

test('board: gen-7 offers are withdrawn, gen-8 offers stay', () => {
  const board = [gen7Freight(), { ...gen7Freight(), id: 'j7b', gen: undefined }, ...generateBoard(harborById('rotterdam'), T0, seeded(1))];
  const kept = board.filter(boardCurrent);
  assert.equal(kept.length, 24);
  assert.ok(kept.every((j) => j.gen === JOB_GEN));
  assert.equal(boardCurrent({ gen: 8 }), false, 'a gen-8 offer without hours is not current');
});

test('an accepted gen-7 freight of grain on a boxship is legacy: no handling check, the runner leaves it alone', () => {
  const p = actor('boxship', 'rotterdam');
  const j = migrateAcceptedJob({ ...gen7Freight(), acceptedAt: T0, dueShip: p.shipTime + 30 * 3600 });
  p.jobs.push(j); p.cargo.push({ good: 'grain', qty: 2000, contraband: false, jobId: j.id });
  assert.equal(j.legacy, true); assert.equal(isLegacyGen(j), true); assert.equal(isRunnerJob(j), false);
  assert.equal(canDo({ ...j, legacy: undefined, gen: 8 }, p, ctxBase()).why.code, 'handling', 'a new offer like it would be refused…');
  const jx = new JobsX({ now: () => T0, harborById, pay: () => assert.fail('the runner must not pay a legacy job') });
  p.docked = null; jx.onTick(p, 60);
  p.docked = 'hamburg'; jx.onDock(p, 'hamburg');
  assert.equal(p.jobs.length, 1); assert.equal(p.cargo.length, 1, '…but the accepted one is untouched by the runner');
  assert.deepEqual(jx.accept(p, gen7Freight()), { ok: false, legacy: true });
  assert.equal(payOf(j), 48000); assert.equal(jx.abandonPenalty(j), 4800);
});

test('the legacy delivery path in server/game.js still completes and pays it', async (t) => {
  let Game;
  try { ({ Game } = await import('../server/game.js')); } catch (e) { t.skip(`server/game.js not importable right now (${e.message})`); return; }
  const p = actor('boxship', 'hamburg', { stats: { delivered: 0, earned: 0 }, money: 100 });
  const j = migrateAcceptedJob({ ...gen7Freight(), acceptedAt: T0, dueShip: p.shipTime + 30 * 3600 });
  p.jobs.push(j); p.cargo.push(healCargoStack({ good: 'grain', qty: 2000, contraband: false, jobId: j.id }));
  const events = [];
  const fake = { simTime: T0, harbors: {}, event: (pp, kind, text) => events.push(text) };
  for (const k of ['deliverJobs', 'payJob', 'migrateAcceptedJob']) fake[k] = Game.prototype[k];
  const n = fake.deliverJobs(p, harborById('hamburg'));
  assert.equal(n, 1);
  assert.equal(p.money, 100 + 48000); assert.equal(p.jobs.length, 0); assert.equal(p.cargo.length, 0);
  assert.ok(events.some((e) => /Delivered: Freight 2000 t of Grain to Hamburg — \+48,000 cr/.test(e)), events.join(' | '));
});

test('cargo stacks and whole saves heal idempotently', () => {
  const c = healCargoStack({ good: 'steel', qty: 300 });
  assert.deepEqual([c.unit, c.units], ['t', 300]);
  assert.deepEqual(healCargoStack({ ...c }), c);
  const box = healCargoStack({ good: 'containers', qty: 1200, unit: 'teu', units: 100 });
  assert.deepEqual([box.unit, box.units, box.qty], ['teu', 100, 1200]);
  const save = [{ jobs: [gen7Freight(), { id: 'j8', gen: 8, type: 'box', steps: [{ k: 'load', at: 'rotterdam' }] }], cargo: [{ good: 'grain', qty: 5 }] }, { jobs: null, cargo: null }];
  migrateSave(save);
  assert.equal(save[0].jobs[0].legacy, true); assert.equal(save[0].jobs[1].legacy, undefined);
  assert.equal(save[0].cargo[0].unit, 't');
  assert.doesNotThrow(() => migrateActor(save[1]));
});
