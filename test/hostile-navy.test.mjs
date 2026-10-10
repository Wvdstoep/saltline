// Naval patrols (contract R8, R9, R12): hail, clean ships are let through, force only with grounds from the dataset or a
// contraband flag, the warning ladder, ceasefire on heaving to, the search, war cover interplay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOSTILE, KINDS } from '../shared/hostile.js';
import { hullValue } from '../shared/politics.js';
import { mkGame, atSea, SPOTS, rig, run, forceSpawn, events, lastYou } from './hostile-helpers.mjs';

const text = (ws) => events(ws).join('\n');
const CONTRA = () => [{ good: 'weapons', qty: 10, contraband: true, jobId: null }, { good: 'grain', qty: 200, contraband: false, jobId: null }];
/** A skipper in the southern Red Sea (tier 3) or the Black Sea (tier 4) with a naval patrol on the radar. */
function setup({ spot = SPOTS.redsea, kn = 10, cargo = [], rest = 0.5, k = 0.9, hdg = 90 } = {}) {
  const g = mkGame(), { p, ws } = atSea(g, 'Ann', spot, { kn, cargo, hdg });
  const enc = forceSpawn(g, p, { queue: [0.0001, k, 0.5, 0.5, 0.5] });
  rig(g, [], rest);
  return { g, p, ws, enc };
}

test('spawn: a tier-3 area sends a patrol craft, tier 4 a corvette or frigate; the unit is anonymous until identified', () => {
  const a = setup({});
  assert.equal(a.enc.faction, 'navy'); assert.equal(a.enc.units[0].k, 'patrol');
  assert.equal(a.g.hostiles.publicList()[0].name, undefined);
  assert.match(events(a.ws).at(-1), /a fast patrol craft is closing/);
  const b = setup({ spot: SPOTS.blacksea, k: 0.9 }); assert.equal(b.enc.units[0].k, 'corvette');
  const c = setup({ spot: SPOTS.blacksea, k: 0.1 }); assert.equal(c.enc.units[0].k, 'frigate');
  assert.ok(KINDS[c.enc.units[0].k].name.startsWith('Naval'), 'made-up names, no nationality');
});

test('a clean ship is hailed, shadowed for a minute and told to carry on: no fire, no seizure, no delay', () => {
  const { g, p, ws, enc } = setup({ cargo: [{ good: 'grain', qty: 300, contraband: false, jobId: null }] });
  run(g, 600, { until: () => enc.st === 'leave' });
  const t = text(ws);
  assert.equal(enc.st, 'leave');
  assert.match(t, /State your cargo and destination/); assert.match(t, /Carry on/);
  assert.doesNotMatch(t, /warning shot|opens fire|seized/);
  assert.equal(p.cond, 100); assert.ok(!g.politics.vesselOf(p).held);
  assert.equal(enc.units[0].k, 'patrol');
});

test('contraband that ignores the hail: heave-to order, final warning, warning shot (no damage), then fire by range and gun', () => {
  const { g, p, ws, enc } = setup({ cargo: CONTRA(), rest: 0.1 });
  assert.equal(enc.grounds.kind, 'contraband');
  run(g, 600, { until: () => enc.st === 'hail' });
  assert.match(text(ws), /Your ship carries cargo that is banned \(contraband\)\. Heave to for inspection within 90 seconds/);
  const t0 = enc.hailT;
  run(g, HOSTILE.HEAVE_TO_S - t0 + 1, { until: () => enc.warnN >= 1 });
  assert.match(text(ws), /Final warning/); assert.equal(p.cond, 100);
  run(g, HOSTILE.WARN_GAP_S + 1, { until: () => enc.warnN >= 2 });
  assert.match(text(ws), /warning shot across your bow/); assert.equal(p.cond, 100, 'warning shots do no damage');
  assert.equal(enc.st, 'hail');
  assert.ok(g.hostiles.publicList()[0].fire === 'warning' || enc.warnN === 2);
  run(g, HOSTILE.WARN_GAP_S + 1, { until: () => enc.st === 'fire' });
  assert.equal(enc.st, 'fire'); assert.match(text(ws), /opens fire\. Heave to now/);
  run(g, 60);
  assert.ok(p.cond < 100 && p.cond > 60, `hull ${p.cond}`);
  assert.match(text(ws), /Naval gunfire hits the hull: −[\d.]+ % .*Crew safe/);
});

test('heaving to ends the fire at once and starts the search: contraband seized, fine, 2-6 h detention', () => {
  const { g, p, ws, enc } = setup({ cargo: CONTRA(), rest: 0.1 });
  p.jobs = [{ id: 'jc1', type: 'freight', contraband: true }];
  run(g, 600, { until: () => enc.st === 'fire' });
  assert.equal(enc.st, 'fire');
  const money0 = p.money;
  p.ship.spd = 0; p.ship.throttle = 0;
  run(g, 20, { until: () => enc.st === 'inspect' });
  assert.match(text(ws), /ceasefire/);
  run(g, HOSTILE.INSPECT_S + 200, { until: () => enc.st === 'leave' });
  assert.equal(enc.st, 'leave');
  assert.ok(!p.cargo.some((c) => c.contraband), 'contraband gone');
  assert.equal(p.cargo.find((c) => c.good === 'grain').qty, 200, 'legal cargo stays');
  assert.equal(p.jobs.length, 0, 'the contraband contract is lost');
  assert.match(text(ws), /seized 10 t .*: carries cargo that is banned \(contraband\)\. Fine [\d,]+ cr\. Crew safe\./);
  const fine = money0 - p.money; assert.ok(fine >= HOSTILE.FINE_MIN, `fine ${fine}`);
  const h = g.politics.vesselOf(p).held; assert.equal(h.why, 'detention');
  const hours = (h.until - g.simTime) / 3600; assert.ok(hours > 1.9 && hours <= 6.01, `held ${hours.toFixed(1)} h`);
  assert.match(text(ws), /The search delays you: held for \d h/);
});

test('surrender action: ceasefire and search without waiting; heaving to before the hail cuts the whole ladder', () => {
  const a = setup({ cargo: CONTRA(), rest: 0.1 });
  run(a.g, 600, { until: () => a.enc.st === 'fire' });
  a.g.onAction(a.p, { action: 'hostile_surrender' });
  assert.equal(a.enc.st, 'inspect'); assert.match(text(a.ws), /heave to and surrender/);
  const hull = a.p.cond; run(a.g, 10); assert.equal(a.p.cond, hull, 'no more hits after surrendering');
  const b = setup({ cargo: CONTRA(), kn: 0, rest: 0.1 });
  run(b.g, 600, { until: () => b.enc.st === 'inspect' });
  assert.equal(b.enc.warnN, 0); assert.doesNotMatch(text(b.ws), /Final warning|warning shot|opens fire/);
  assert.equal(b.p.cond, 100);
});

test('payment buys nothing from the navy and the citadel/hose are useless against a warship', () => {
  const { g, p, ws, enc } = setup({ cargo: CONTRA() });
  for (const [a, re] of [['hostile_pay', /takes no payment/], ['hostile_cargo', /does not take cargo/], ['hostile_hose', /does nothing against a warship/], ['hostile_citadel', /no citadel against a warship/]]) {
    g.onAction(p, { action: a }); assert.match(events(ws).at(-1), re);
  }
  g.onAction(p, { action: 'hostile_navy' }); assert.match(events(ws).at(-1), /naval patrol/);
  assert.equal(enc.st, 'approach');
});

test('tier-4 area, clean cargo, off the recommended corridor: warnings and a shadow only, never fire', () => {
  const { g, p, ws, enc } = setup({ spot: SPOTS.blacksea, cargo: [{ good: 'grain', qty: 300, contraband: false, jobId: null }], rest: 0.1 });
  assert.equal(enc.grounds.kind, 'denied_zone');
  assert.equal(g.hostiles.fireEligible(enc.grounds, g.politics.ds.areaById[enc.areaId]), false);
  run(g, 900, { until: () => enc.st === 'leave' });
  const t = text(ws);
  assert.match(t, /outside the recommended corridor/); assert.match(t, /warning shot/); assert.match(t, /Carry on and keep to the corridor/);
  assert.doesNotMatch(t, /opens fire|seized/);
  assert.equal(p.cond, 100);
});

test('grounds come from the dataset: contraband flag, a sanctions measure that binds the skipper, never a measure that does not', () => {
  const g = mkGame(), { p } = atSea(g, 'Ann', SPOTS.blacksea, { cargo: [{ good: 'steel', qty: 50, origin: 'RU', contraband: false, jobId: null }] });
  const area = g.politics.ds.areaById['jwc-blacksea-ua'];
  assert.equal(g.hostiles.groundsOf(p, area)?.kind, 'sanctioned', 'a Rotterdam company follows the EU measure on Russian steel');
  assert.equal(g.hostiles.groundsOf(p, area)?.measureId, 'eu-ru-833-steel');
  assert.equal(g.hostiles.fireEligible(g.hostiles.groundsOf(p, area), area), true);
  p.office.home = 'singapore'; g.politics.vesselOf(p).flag = { cc: 'SG' };
  assert.notEqual(g.hostiles.groundsOf(p, area)?.kind, 'sanctioned', 'a Singapore company is not bound by the EU measure');
  p.cargo = [{ good: 'grain', qty: 50, origin: 'UA', contraband: false, jobId: null }];
  assert.equal(g.hostiles.groundsOf(p, g.politics.ds.areaById['jwc-redsea-aden']), null, 'clean cargo, tier 3: no grounds');
  p.cargo = [{ good: 'weapons', qty: 5, contraband: false, jobId: null }];
  assert.equal(g.hostiles.groundsOf(p, g.politics.ds.areaById['jwc-redsea-aden'])?.kind, 'sanctioned', 'UN arms embargo binds everybody');
});

test('war cover interplay: covered naval hits become repair credits; a covered loss pays the hull value; uncovered pays nothing', () => {
  const run1 = (covered) => {
    const { g, p, enc } = setup({ cargo: CONTRA(), rest: 0.1 });
    const area = g.politics.ds.areaById[enc.areaId];
    if (covered) g.politics.buyCover(p, g.politics.vesselOf(p), area);
    const money0 = p.money;
    run(g, 800, { until: () => enc.st === 'fire' });
    run(g, 30);
    const credit = g.politics.repairCredit(p);
    return { credit, hit: 100 - p.cond, money0, p, g, enc, area };
  };
  const a = run1(true), b = run1(false);
  assert.ok(a.hit > 0 && b.hit > 0);
  assert.ok(Math.abs(a.credit - a.hit) < 0.5, `covered credit ${a.credit} vs hull lost ${a.hit}`);
  assert.equal(b.credit, 0);
  // total loss
  const c = setup({ cargo: CONTRA(), rest: 0.1 });
  c.g.politics.buyCover(c.p, c.g.politics.vesselOf(c.p), c.g.politics.ds.areaById[c.enc.areaId]);
  c.p.cond = 6; const m0 = c.p.money, hv = hullValue(c.p.ship.cls, 6);
  run(c.g, 800, { until: () => c.p.rescue });
  assert.ok(c.p.rescue, 'sunk');
  const gain = c.p.money - m0;
  assert.ok(gain >= hullValue(c.p.ship.cls, 0) && gain <= hv, `the covered loss paid the hull value (${gain})`);
  const d = setup({ cargo: CONTRA(), rest: 0.1 }); d.p.cond = 6; const m1 = d.p.money;
  run(d.g, 800, { until: () => d.p.rescue });
  assert.ok(d.p.rescue); assert.equal(d.p.money, m1, 'no cover, no payout');
});
