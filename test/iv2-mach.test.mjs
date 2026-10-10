// Interiors v2 — machinery (docs/INTERIORS-V2-CONTRACT.md §4.6, Lane M): frame spacing, main-engine detail per model,
// the equipment demand, ≤ 12 m bays, and the packed engine rooms of the phase-1 plans (no bare floor disc > 1.6 m,
// equipment fronts reachable, runs overhead).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameSpacing, meDetail, erEquipment, erBays, machineryPlan, SYS_COLOR } from '../shared/ships/gamach.js';
import { generalArrangement } from '../shared/ships/ga.js';
import { MODELS } from '../shared/ships/catalogue.js';
import { IV2_READY } from '../shared/ships/gaspace.js';
import { planFromGA } from '../public/js/gaplan.js';
import { roomMetrics, solidIndex } from '../scripts/interiors/metrics.mjs';

const has = (id) => !!MODELS[id];

test('mach: frame spacing', () => {
  assert.equal(frameSpacing(90), 0.66);
  assert.equal(frameSpacing(199.9), 0.85);
  assert.equal(frameSpacing(32), 0.544);
});

test('mach: main-engine detail per model (cylinders / turbochargers)', () => {
  const me = (id) => meDetail(generalArrangement(id));
  const want = { ultramax64: ['2s', 6, 1], vlcc300: ['2s', 7, 2], ulcv24k: ['2s', 11, 3], capesize180: ['2s', 6, 1] };
  for (const [id, [kind, cyl, tc]] of Object.entries(want)) { if (!has(id)) continue; const m = me(id); assert.deepEqual([m.kind, m.cyl, m.tc], [kind, cyl, tc], id); }
  if (has('coaster')) { const m = me('coaster'); assert.equal(m.layout, 'inline'); assert.equal(m.cyl, 6); }
  if (has('tug24')) { const m = me('tug24'); assert.equal(m.n, 2); assert.equal(m.cyl, 8); }
  for (const id of ['ferry', 'ropax200'].filter(has)) { const m = me(id); assert.equal(m.layout, 'V'); assert.equal(m.cyl, 12); }
  if (has('ropax200')) assert.equal(me('ropax200').n, 4);
});

test('mach: equipment demand, ≤ 12 m bays, MachPlan frozen', () => {
  for (const id of ['ultramax64', 'mr50', 'feeder', 'lng174k', 'coaster'].filter(has)) {
    const ga = generalArrangement(id), eq = erEquipment(ga);
    assert.ok(eq.reduce((s, e) => s + e.n, 0) >= 25, `${id} equipment`);
    for (const e of eq) for (const s of e.sys) assert.ok(SYS_COLOR[s] != null, `${id} ${e.item} system ${s}`);
    for (const b of erBays(ga)) assert.ok(b.z1 - b.z0 <= 12.5, `${id} bay ${b.z0}…${b.z1}`);
    const mp = machineryPlan(id);
    assert.ok(Object.isFrozen(mp) && mp.er.equip.length >= 25 && mp.me.cyl >= 5, id);
  }
  if (has('lng174k')) assert.ok(machineryPlan('lng174k').views.tanks.length > 0, 'LNG tank peeks');
});

const ER_IDS = ['coaster', 'feeder', 'ultramax64', 'mr50', 'kamsarmax82', 'ulcv24k', 'vlcc300', 'lng174k'].filter((id) => has(id) && IV2_READY.has(MODELS[id].gen));
test('mach: packed engine rooms — no bare floor disc > 1.6 m, walkways recorded, overhead runs', () => {
  const bad = [];
  for (const id of ER_IDS) {
    const p = planFromGA(id), idx = solidIndex(p);
    const er = p.rooms.filter((r) => r.zone === 'er' && r.space === 'er_platform' && r.walk !== false && !r.open);
    assert.ok(er.length >= 2, `${id} ER bays`);
    for (const r of er) {
      const m = roomMetrics(p, r, idx);
      if (m.emptyR > 1.6 + 0.25) bad.push(`${id} ${r.id} disc ${m.emptyR.toFixed(2)}`);
    }
    const packed = er.filter((r) => Array.isArray(r.walkways) && r.walkways.length);
    assert.ok(packed.length >= er.length * 0.7, `${id}: ${packed.length} of ${er.length} bays packed with walkways`);
    const runs = p.props.filter((q) => q.t === 'run' && er.some((r) => r.id === q.room));
    assert.ok(runs.length >= er.length, `${id} runs ${runs.length}`);
    for (const q of runs) if (q.kind === 'pipe' || q.kind === 'tray') { const r = er.find((x) => x.id === q.room); for (const pt of q.pts) assert.ok(pt[1] >= r.y + 2.0 - 1e-6, `${id} ${q.kind} at ${pt[1]} over ${r.y}`); }
    const k2 = p.props.filter((q) => q.t === 'k2' && er.some((r) => r.id === q.room));
    assert.ok(k2.length >= er.length * 3, `${id} items ${k2.length}`);
    assert.ok(p.emitters.some((e) => e.kind === 'me'), `${id} ME emitter`);
  }
  assert.deepEqual(bad, []);
});
