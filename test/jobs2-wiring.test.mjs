// Lane D phase 2 wiring (docs/JOBS-LANED-PHASE2.md): the real Game generates JOB_GEN 8 boards through the runner, sends
// the wire form (numeric pay), accepts and settles a runner job on the dock hook, checks market compatibility (H7), and
// still delivers an accepted gen-7 job on the legacy path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { carvingsForWorld, harborById } from '../server/harbors.js';
import { Game } from '../server/game.js';
import { canDo } from '../shared/jobs/eligibility.js';
import { CAPTAIN_JOB_TYPES } from '../shared/fleet.js';
import { hardReason } from '../shared/jobtime.js';

process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
const world = new World().load(carvingsForWorld(), () => {});
function mkGame() { const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-jobs2-wiring.json' }); g.saveState = () => {}; g.rnd = () => 0.5; return g; }
function join(g, name) { const ws = { readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); }, close() {} }; const p = g.connect(ws, null, name); g.tick(0.1); return { p, ws }; }
const events = (ws) => ws.sent.filter((m) => m.t === 'event').map((m) => m.text);
const board = (g, p, ws) => { g.sendHarbor(p); return ws.sent.filter((m) => m.t === 'harbor').at(-1).harbor.jobs; };

test('Rotterdam board: gen-8 runner families on the wire with numeric pay, ≥ 3 doable for a coaster', () => {
  const g = mkGame(); const { p, ws } = join(g, 'Ann');
  assert.equal(p.docked, 'rotterdam');
  g.regenHarbor(harborById('rotterdam'), g.harbors.rotterdam, true);
  const jobs = board(g, p, ws);
  assert.ok(jobs.length >= 10, `${jobs.length} offers`);
  assert.ok(jobs.every((j) => (j.gen || 0) >= 8 && typeof j.pay === 'number' && Number.isFinite(j.pay)), 'gen 8, pay is a number');
  assert.ok(jobs.some((j) => Array.isArray(j.steps) && j.steps.length), 'runner families have steps');
  assert.ok(jobs.filter((j) => canDo(j, p, g.jobsCtx(p)).ok).length >= 3, 'fit guarantee');
});

test('a runner cargo job: accept at Rotterdam, dock at the destination, the runner settles and pays', () => {
  const g = mkGame(); const { p, ws } = join(g, 'Bea');
  const st = g.harbors.rotterdam, oneWay = (j) => Array.isArray(j.steps) && j.steps.length === 3 && j.steps.every((s) => typeof s.at === 'string') && j.steps[0].k === 'load' && j.steps[2].k === 'discharge';
  let job = null;
  for (let i = 0; i < 6 && !job; i++) { g.rnd = () => 0.1 + i * 0.15; st.jobs = []; g.regenHarbor(harborById('rotterdam'), st, true); g.sendHarbor(p); job = st.jobs.find((j) => oneWay(j) && canDo(j, p, g.jobsCtx(p)).ok); }
  g.rnd = () => 0.5;
  assert.ok(job, 'a one-way runner cargo job a coaster can take');
  const to = job.steps.at(-1).at, m0 = p.money;
  g.onAction(p, { action: 'accept_job', jobId: job.id });
  assert.ok(p.jobs.some((j) => j.id === job.id && j.prog), 'accepted with runner progress');
  assert.ok(!st.jobs.some((j) => j.id === job.id), 'off the board');
  g.onAction(p, { action: 'undock' }); g.tick(0.1);
  g.setDocked(p, to, null); g.tick(0.1);
  assert.ok(p.money > m0, events(ws).slice(-4).join(' | '));
  assert.equal(p.jobs.length, 0); assert.equal(p.cargo.filter((c) => c.jobId === job.id).length, 0);
  assert.ok(Number.isFinite(p.money), 'never NaN');
});

test('the legacy deliverJobs never pays a runner job (its pay is an object)', () => {
  const g = mkGame(); const { p } = join(g, 'Eve');
  const m0 = p.money;
  p.jobs.push({ id: 'jrun', type: 'box', family: 'box', gen: 8, from: 'rotterdam', to: 'ijmuiden', title: 'Box', hours: 10, pay: { cr: 5000, model: 'lump' },
    cargo: { good: 'containers', qty: 10, unit: 'teu' }, steps: [{ k: 'load', at: 'rotterdam' }, { k: 'sail', at: 'ijmuiden' }, { k: 'discharge', at: 'ijmuiden' }], prog: { i: 1 } });
  p.cargo.push({ good: 'containers', qty: 120, units: 10, unit: 'teu', jobId: 'jrun' });
  assert.equal(g.deliverJobs(p, harborById('ijmuiden')), 0);
  assert.equal(p.money, m0); assert.equal(p.jobs.length, 1);
});

test('H7 market: a container ship cannot buy grain; a coaster can', () => {
  const g = mkGame(); const { p, ws } = join(g, 'Cid');
  g.sendHarbor(p);
  p.ship.cls = 'boxship';
  g.onAction(p, { action: 'buy_goods', good: 'grain', qty: 10 });
  assert.equal(p.cargo.length, 0); assert.match(events(ws).at(-1), /^Grain: Needs bulk holds/);
  p.ship.cls = 'coaster';
  g.onAction(p, { action: 'buy_goods', good: 'grain', qty: 10 });
  assert.ok(p.cargo.some((c) => c.good === 'grain' && c.qty === 10));
});

test('an accepted gen-7 freight job still delivers on the legacy path', () => {
  const g = mkGame(); const { p } = join(g, 'Dee');
  p.jobs.push({ id: 'jold', type: 'freight', gen: 7, from: 'rotterdam', to: 'ijmuiden', good: 'grain', qty: 50, pay: 4000, hours: 20, title: 'Freight 50 t of Grain to IJmuiden', acceptedShip: p.shipTime, dueShip: (p.shipTime || 0) + 72000 });
  p.cargo.push({ good: 'grain', qty: 50, contraband: false, jobId: 'jold' });
  const m0 = p.money;
  g.onAction(p, { action: 'undock' }); g.tick(0.1);
  g.setDocked(p, 'ijmuiden', null);
  g.onAction(p, { action: 'deliver_jobs' });
  assert.equal(p.jobs.length, 0); assert.ok(p.money >= m0 + 4000 - 1);
});

test('H6c/H6d: gen-8 reasons reach shared/jobtime; captains take the new families', () => {
  mkGame();
  for (const t of ['box', 'voyage', 'tc', 'crewchange']) assert.ok(CAPTAIN_JOB_TYPES.includes(t), t);
  const r = hardReason({ id: 'jx', type: 'voyage', family: 'voyage', gen: 8, from: 'rotterdam', to: 'hamburg', cargo: { good: 'grain', qty: 30000, unit: 't' }, needs: { handling: ['bulk'] }, steps: [], hours: 40, pay: { cr: 1 } }, { cls: 'boxship', holdFreeT: 90000, paxFree: 12 });
  assert.ok(r, 'a container ship gets a reason for a bulk voyage');
});
