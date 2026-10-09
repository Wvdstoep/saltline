// Every step-runner family can be completed by a player through the game's own actions (accept_job, docking,
// deliver_jobs with a jobId = the harbour sheet's step button, job_step = the contract card's J) plus the server's tick
// hook. Also: the COA of the chemical-tanker report (lifting-by-lifting pay, honest status, no "ready to deliver"
// lies, no log spam) and the save healing that makes an already-accepted job with its cargo missing completable again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { carvingsForWorld, harborById, HARBORS } from '../server/harbors.js';
import { Game } from '../server/game.js';
import { generateFamilyJob } from '../server/jobsgen.js';
import { canDo } from '../shared/jobs/eligibility.js';
import { RUNNER_TYPES } from '../shared/jobs/catalogue.js';
import { loadOption, eqOf } from '../shared/cargo.js';
import { haversine } from '../shared/geo.js';

process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
const world = new World().load(carvingsForWorld(), () => {});
function mkGame() { const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-jobs2-complete.json' }); g.saveState = () => {}; g.rnd = () => 0.5; return g; }
function join(g, name) { const ws = { readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); }, close() {} }; const p = g.connect(ws, null, name); g.tick(0.1); return { p, ws }; }
const events = (ws) => ws.sent.filter((m) => m.t === 'event').map((m) => m.text);
const lastYou = (ws) => ws.sent.filter((m) => m.t === 'you').at(-1)?.you;
const GOODS = ['grain', 'ore', 'coal', 'steel', 'crude', 'fuel', 'chemicals', 'lpg', 'lng', 'livestock', 'fruit'];
function seeded(n) { let s = (n * 7919 + 13) % 2147483647 || 1; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; }

/** Dock `p` at harbour `id` (position + the game's docking hook). */
function dockAt(g, p, id) { const h = harborById(id); p.ship.lat = h.lat; p.ship.lon = h.lon; g.setDocked(p, id, null); }
/** Out at sea at `pt` (lat, lon) doing `spd` kn. */
function atSea(p, pt, spd = 0) { p.docked = null; p.berth = null; p.ship.lat = pt.lat; p.ship.lon = pt.lon; p.ship.spd = spd; }
/** The server's tick hook on the ship's clock for `h` hours (game.tick calls exactly this). */
function run(g, p, h, dt = 120) { for (let t = 0; t < h * 3600; t += dt) { g.simTime += dt; p.shipTime += dt; g.jobsx.onTick(p, dt); } }
const offshoreOf = (h) => ({ lat: h.lat + 0.2, lon: h.lon + 0.2 });

/** Find a job of `type` this ship can do (generated at `prefer` harbours first), put it on that board, dock there. */
// The test world's coarse depth grid rejects most near-shore "tow spots" (launch, dredge, regatta …): those families are
// posted without the spot check here — this suite is about completing the steps, jobs2-gen covers generation.
function postFor(g, p, type, cls, prefer = [], simTime = g.simTime) {
  return postWith(g, p, type, cls, prefer, simTime, g.jobEnv()) || postWith(g, p, type, cls, prefer, simTime, { seaKm: g.jobEnv().seaKm });
}
function postWith(g, p, type, cls, prefer, simTime, env) {
  p.ship.cls = cls; p.cargo = []; p.jobs = [];
  const fit = { cls, vessel: p, geared: eqOf(cls).includes('geared') }, fitGoods = GOODS.filter((x) => loadOption(x, cls));
  const near = [...HARBORS].sort((a, b) => haversine(a.lat, a.lon, 52, 4) - haversine(b.lat, b.lon, 52, 4));
  const list = [...prefer.map(harborById).filter(Boolean), ...near];
  for (const h of list) {
    if (!g.harbors[h.id]) g.regenHarbor(h, (g.harbors[h.id] = { jobs: [], market: {}, contact: null, lastRegen: g.simTime, stock: {} }), false);
    for (let n = 0; n < 6; n++) {
      const j = generateFamilyJob(h, simTime, seeded(n + h.id.length * 31), type, env, { fit, fitGoods });
      if (!j) continue;
      dockAt(g, p, h.id);
      const c = canDo(j, p, g.jobsCtx(p));
      if (!c.ok && c.why?.code !== 'time') continue;
      g.harbors[h.id].jobs.push(j);
      return j;
    }
  }
  return null;
}

/** Drive job `id` to the end the way a player would. → the events seen. */
function drive(g, p, ws, id, budget = 300) {
  for (let it = 0; it < budget; it++) {
    const j = p.jobs.find((x) => x.id === id); if (!j) return;
    const i = j.prog.i, s = j.steps[i];
    const si = g.jobsx.stepInfo(p, j);
    assert.ok(si && si.text, `step ${i} (${s.k}) has a status line`);
    assert.doesNotMatch(si.text, /ready to deliver/i);
    if (typeof s.at === 'string') {
      if (p.docked !== s.at) {
        if (p.docked) g.onAction(p, { action: 'undock' });
        atSea(p, offshoreOf(harborById(s.at) || harborById(j.from)), 8); run(g, p, 0.1);
        dockAt(g, p, s.at);
      } else if (s.k === 'land' && s.afterSea && !j.prog.sea) { g.onAction(p, { action: 'undock' }); atSea(p, offshoreOf(harborById(s.at)), 6); run(g, p, 0.5); }
      else {
        assert.ok(si.can, `${j.type} step ${i} ${s.k} at ${s.at}: the button is offered (${si.text})`);
        g.onAction(p, { action: 'deliver_jobs', jobId: id });
      }
    } else if (s.k === 'race') {
      if (g.simTime < s.startAt) g.simTime = s.startAt + 1;
      const m = s.marks[j.prog.mark]; atSea(p, m, 6); run(g, p, 0.05);
    } else if (s.k === 'drill' && s.stat) {
      if (p.docked) g.onAction(p, { action: 'undock' });
      if (!p.sail) p.sail = { stats: {} };
      atSea(p, offshoreOf(harborById(j.from)), 4);
      p.sail.stats[s.stat] = (p.sail.stats[s.stat] || 0) + (s.count || 1); run(g, p, 0.05);
    } else if (s.k === 'drill') {
      if (p.docked) g.onAction(p, { action: 'undock' });
      atSea(p, s.at || offshoreOf(harborById(j.from)), 0); run(g, p, 0.02);
      assert.ok(si.act === 'job_step' && si.btn, 'a drill offers its confirm button');
      g.onAction(p, { action: 'job_step', jobId: id });
    } else if (s.k === 'sail' && s.nm && !s.at) {
      if (p.docked) g.onAction(p, { action: 'undock' });
      atSea(p, offshoreOf(harborById(j.from)), 10); run(g, p, s.nm / 10 + 0.2);
    } else if (s.k === 'work' && !s.at) {
      if (!s.chartered && (s.atSea || !p.docked)) { if (p.docked) g.onAction(p, { action: 'undock' }); atSea(p, offshoreOf(harborById(j.from)), 3); }
      run(g, p, (s.h || 0) + 0.2);
    } else {                                                     // spot steps: sail, meet, tow, work at a position
      if (p.docked) g.onAction(p, { action: 'undock' });
      const spd = s.minKn != null ? (s.minKn + s.maxKn) / 2 : 0;
      atSea(p, s.at, spd); run(g, p, s.k === 'work' ? (s.h || 0) + 0.2 : 0.05);
    }
  }
  assert.fail(`${id} did not finish: ${JSON.stringify(g.jobsx.stepInfo(p, p.jobs.find((x) => x.id === id)))}`);
}

const SHIPS = {
  voyage: ['chem13k', ['rotterdam']], coa: ['chem13k', ['rotterdam']], box: ['feeder1700', ['rotterdam']], liner: ['feeder1700', ['rotterdam']],
  tc: ['ultramax64', ['rotterdam']], project: ['mpp160', ['rotterdam']], vehicles: ['pctc7000', ['rotterdam']], ropax_route: ['ropax200', ['rotterdam']],
  cruise: ['cruise230', ['rotterdam']], anchor: ['ahts85', ['aberdeen']], standby: ['psv90', ['aberdeen']], crewchange: ['ctv26', ['ijmuiden']],
  towage: ['tug24', ['rotterdam']], ocean_tow: ['oceantug60', ['rotterdam']], pilot_transfer: ['pilot', ['rotterdam']], bunkering: ['bunker85', ['rotterdam']],
  launch: ['ctv26', ['rotterdam']], dredge: ['tshd100', ['rotterdam']], survey: ['research75', ['rotterdam']], research: ['research75', ['rotterdam']],
  escort: ['icebreaker120', ['lulea', 'oulu']], lesson: ['sloop', ['rotterdam']], daycharter: ['myacht', ['rotterdam']], bareboat: ['sloop', ['rotterdam']],
  regatta: ['sloop', ['rotterdam']], ecotour: ['myacht', []], guests: ['superyacht', ['rotterdam']], delivery: ['ketch', ['rotterdam']],
};
const WINTER = Date.UTC(2027, 1, 10) / 1000;

for (const type of RUNNER_TYPES) {
  if (type === 'salvage') continue;   // posted by storms, not boards: covered below
  test(`${type}: a player can complete every step through the game's actions`, () => {
    const g = mkGame(); const { p, ws } = join(g, `P${type}`);
    const [cls, prefer] = SHIPS[type] || [];
    assert.ok(cls, `a ship for ${type} in this test`);
    if (type === 'escort') g.simTime = WINTER;
    const job = postFor(g, p, type, cls, prefer, g.simTime);
    assert.ok(job, `a ${type} job a ${cls} can take`);
    p.money = 1e7; const m0 = p.money;
    g.onAction(p, { action: 'accept_job', jobId: job.id });
    assert.ok(p.jobs.some((x) => x.id === job.id), `accepted: ${events(ws).slice(-2).join(' | ')}`);
    drive(g, p, ws, job.id);
    assert.equal(p.jobs.length, 0, 'finished');
    assert.ok(events(ws).some((t) => t.startsWith(`Completed: ${job.title}`)), 'settled');
    if (!['regatta', 'bareboat'].includes(type)) assert.ok(p.money > m0, `paid (${p.money - m0})`);
    assert.equal(p.cargo.filter((c) => c.jobId === job.id).length, 0, 'no contract cargo left behind');
  });
}

test('salvage (storm posting): connect, tow to the refuge, award paid', () => {
  const g = mkGame(); const { p, ws } = join(g, 'Sal');
  p.ship.cls = 'oceantug60';
  const h = harborById('rotterdam'), cas = { id: 'cas1', lat: 52.4, lon: 3.3, value: 2e6 };
  const job = g.jobsx.salvage(h, cas, g.simTime, seeded(3));
  g.harbors.rotterdam.jobs.push(job);
  const m0 = p.money;
  g.onAction(p, { action: 'accept_job', jobId: job.id });
  assert.ok(p.jobs.some((x) => x.id === job.id), events(ws).at(-1));
  drive(g, p, ws, job.id);
  assert.ok(p.money > m0);
});

/** The report: a chemical-tanker COA, 4 liftings Rotterdam → Aberdeen. */
function coaGame(name = 'Chem') {
  const g = mkGame(); const { p, ws } = join(g, name);
  p.ship.cls = 'chem13k'; p.cargo = []; p.money = 25000;
  let job = null;
  for (let n = 0; n < 200 && !job; n++) {
    const j = generateFamilyJob(harborById('rotterdam'), g.simTime, seeded(n), 'coa', g.jobEnv(), { fit: { cls: 'chem13k', vessel: p }, fitGoods: ['chemicals'] });
    if (j && j.liftings >= 3) job = j;
  }
  g.harbors.rotterdam.jobs.push(job);
  return { g, p, ws, job };
}

test('COA: loads on accept, each lifting pays on discharge, honest next step, the last settles the rest', () => {
  const { g, p, ws, job } = coaGame();
  const to = job.steps[2].at, n = job.liftings;
  g.onAction(p, { action: 'accept_job', jobId: job.id });
  const mine = p.jobs.find((x) => x.id === job.id);
  assert.equal(p.cargo.filter((c) => c.jobId === job.id).length, 1, 'lifting 1 loaded at Rotterdam on signing');
  assert.match(events(ws).at(-1), /Next: Lifting 1 of \d: sail to .* and moor to discharge .* chemicals/);
  const si0 = lastYou(ws).jobs.find((x) => x.id === job.id).stepInfo;
  assert.equal(si0.can, false); assert.equal(si0.at, to, 'the wire carries the step for the HUD and harbour sheet');
  let paid = 0;
  for (let L = 1; L <= n; L++) {
    g.onAction(p, { action: 'undock' }); atSea(p, offshoreOf(harborById(to)), 10); run(g, p, 0.1);
    const m0 = p.money;
    dockAt(g, p, to);
    if (L < n) {
      assert.ok(p.money > m0, `lifting ${L} paid on discharge`); paid += p.money - m0;
      assert.ok(events(ws).some((t) => t.includes(`Lifting ${L} of ${n} discharged`) && /sail back to Rotterdam to load lifting/i.test(t)), events(ws).slice(-3).join(' | '));
      const si = g.jobsx.stepInfo(p, mine);
      assert.equal(si.can, false, 'not "ready to deliver" while ballasting back');
      assert.match(si.text, new RegExp(`Sail back to Rotterdam to load lifting ${L + 1} of ${n}`));
      // pressing the harbour sheet's button here gives the specific reason, once
      const k = events(ws).length;
      for (let r = 0; r < 4; r++) g.onAction(p, { action: 'deliver_jobs', jobId: job.id });
      const said = events(ws).slice(k);
      assert.equal(said.length, 1, `one line, not four: ${said.join(' | ')}`);
      assert.match(said[0], /Sail back to Rotterdam to load lifting/);
      g.onAction(p, { action: 'undock' }); atSea(p, offshoreOf(harborById('rotterdam')), 10); run(g, p, 0.1);
      dockAt(g, p, 'rotterdam');
      assert.equal(p.cargo.filter((c) => c.jobId === job.id).length, 1, `lifting ${L + 1} loaded`);
    } else {
      assert.equal(p.jobs.length, 0, 'COA finished');
      assert.ok(events(ws).some((t) => t.startsWith(`Completed: ${job.title}`) && t.includes('paid per lifting')));
    }
  }
  assert.equal(p.stats.delivered >= 1, true);
  assert.ok(paid > 0);
});

test('whyNotDeliverable is specific for runner jobs (cargo not aboard, discharges elsewhere)', () => {
  const { g, p, job } = coaGame('Why');
  g.onAction(p, { action: 'accept_job', jobId: job.id });
  const mine = p.jobs.find((x) => x.id === job.id);
  p.cargo = [{ good: 'fuel', qty: 5000, unit: 't', units: 5000, jobId: null }]; mine.prog.i = 0;   // a full hold: lifting 1 not loaded
  g.jobsx.onDock(p, 'rotterdam');
  assert.equal(mine.prog.i, 0, 'still at the load step');
  assert.match(g.whyNotDeliverable(p, mine), /not enough space to load .* chemicals at Rotterdam/);
  g.onAction(p, { action: 'undock' }); atSea(p, offshoreOf(harborById(job.to)), 8); dockAt(g, p, job.to);
  assert.match(g.whyNotDeliverable(p, mine), /^Lifting 1 of \d: sail to Rotterdam and moor to load .* chemicals/);
  p.cargo = []; g.onAction(p, { action: 'undock' }); dockAt(g, p, 'rotterdam');
  assert.equal(mine.prog.i, 1, 'loads once there is room');
  g.onAction(p, { action: 'undock' }); atSea(p, { lat: 53, lon: 3 }, 10);
  assert.match(g.whyNotDeliverable(p, mine), /discharge/);
  const other = HARBORS.find((h) => h.id !== job.to && h.id !== 'rotterdam' && h.size !== 'minor');
  dockAt(g, p, other.id);
  assert.match(g.whyNotDeliverable(p, mine), /^Lifting 1 of \d: sail to .* and moor to discharge/);
});

test('save healing: an accepted COA whose cargo is not aboard goes back to its load step; unpaid liftings are paid', () => {
  const { g, p, ws, job } = coaGame('Heal');
  g.onAction(p, { action: 'accept_job', jobId: job.id });
  const mine = p.jobs.find((x) => x.id === job.id);
  // the reported save: sailed to the discharge port with the cargo gone (never loaded / lost) → stuck at "discharge"
  p.cargo = []; mine.prog.i = 2;
  g.onAction(p, { action: 'undock' }); dockAt(g, p, job.to);
  assert.equal(mine.prog.i, 0, 'back to the lifting 1 load step');
  assert.ok(events(ws).some((t) => t.includes('the cargo is not aboard') && t.includes('Rotterdam')));
  const st = g.privateState(p).jobs.find((x) => x.id === job.id).stepInfo;
  assert.match(st.text, /sail to Rotterdam and moor to load/);
  dockAt(g, p, 'rotterdam');
  assert.equal(p.cargo.filter((c) => c.jobId === job.id).length, 1, 'loaded on docking at the origin');
  // an older save that discharged lifting 1 before liftings were paid: the next tick pays it
  g.onAction(p, { action: 'undock' }); atSea(p, { lat: 54, lon: 2 }, 10);
  const m0 = p.money; mine.prog.fracs = [1]; mine.prog.i = 3; delete mine.prog.paidN; delete mine.prog.paid; p.cargo = [];
  run(g, p, 0.01);
  assert.ok(p.money > m0, 'the discharged lifting is paid');
  assert.equal(mine.prog.i, 3, 'a ballast leg is not rewound');
});

test('identical contract warnings within a few seconds are logged once; other warnings are not swallowed', () => {
  const g = mkGame(); const { p, ws } = join(g, 'Dup');
  const k = events(ws).length;
  for (let i = 0; i < 4; i++) g.event(p, 'warn', 'Same thing again.', { dedupe: true });
  g.event(p, 'warn', 'Something else.', { dedupe: true });
  g.event(p, 'warn', 'Refused.'); g.event(p, 'warn', 'Refused.');
  assert.deepEqual(events(ws).slice(k), ['Same thing again.', 'Something else.', 'Refused.', 'Refused.']);
  assert.ok(ws.sent.filter((m) => m.t === 'event').every((m) => !('dedupe' in m)), 'the flag stays on the server');
});
