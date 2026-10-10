// Interiors v2 — acceptance (docs/INTERIORS-V2-CONTRACT.md §8.1, Lane T): A1–A8 for every model of every gen in
// IV2_READY, measured with scripts/interiors/metrics.mjs (A9 budgets: iv2-render-budget). Prints the §0.2 table.
//   hard (every model): A1 scale / doors, A5 waste ≤ 8 % and no unkitted "Spare cabin" / "Store room", A6 detail
//   (cabins ≥ 7 items, unlined rooms framed + runs), A7 lights + exit signs, ship A2 ≥ 90 %, ER levels A2 ≥ 90 %.
//   per room A2 / A3 / A4: ≤ 3 % of a ship's measured rooms (or 2) may miss (≤ 2 % over the fleet) — the misses are
//   printed so they stay visible; A8 dead ends only in GA spine corridors (ga.js is frozen, §0.3), never in v2 cuts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planFromGA } from '../public/js/gaplan.js';
import { generalArrangement } from '../shared/ships/ga.js';
import { MODELS } from '../shared/ships/catalogue.js';
import { IV2_READY } from '../shared/ships/gaspace.js';
import { shipMetrics, summary, measured, roomMetrics, solidIndex } from '../scripts/interiors/metrics.mjs';

const IDS = Object.keys(MODELS).filter((k) => MODELS[k].gen !== 'sail' && IV2_READY.has(MODELS[k].gen));
const runs = new Map();
const run = (id) => { if (!runs.has(id)) { const p = planFromGA(id); runs.set(id, { p, acc: shipMetrics(p, { ga: generalArrangement(id) }) }); } return runs.get(id); };

test('acceptance: phase 1 covers the merchant gens', () => {
  for (const g of ['aft_house_dry', 'aft_house_tanker', 'container', 'lng']) assert.ok(IV2_READY.has(g), g);
  assert.ok(IDS.length >= 30, `${IDS.length} models`);
});

test('acceptance: A1 / A5 / A6 / A7 hold on every model, ship A2 ≥ 90 %', () => {
  const bad = [];
  for (const id of IDS) {
    const { p, acc } = run(id);
    assert.equal(p.v, 2, `${id} is a v2 plan`);
    for (const f of acc.fails) if (/^A[1567] /.test(f)) bad.push(`${id}: ${f}`);
    if (acc.ship.a2 < 0.9) bad.push(`${id}: ship A2 ${(acc.ship.a2 * 100).toFixed(1)} %`);
    if (acc.ship.waste > 0.08) bad.push(`${id}: waste ${(acc.ship.waste * 100).toFixed(1)} %`);
  }
  assert.deepEqual(bad, []);
});

test('acceptance: engine-room levels — free floor within 2 m of equipment ≥ 90 % per ship', () => {
  const bad = [];
  for (const id of IDS) {
    const { p } = run(id), idx = solidIndex(p);
    let A = 0, S = 0;
    for (const r of measured(p)) { if (r.zone !== 'er') continue; const m = roomMetrics(p, r, idx); A += m.free; S += m.free * m.a2; }
    if (A && S / A < 0.9) bad.push(`${id} ER ${((S / A) * 100).toFixed(1)} %`);
  }
  assert.deepEqual(bad, []);
});

test('acceptance: per-room A2 / A3 / A4 misses stay rare (≤ 3 % per ship or 2 rooms, ≤ 2 % fleet)', () => {
  let rooms = 0, miss = 0; const over = [], tally = {};
  for (const id of IDS) {
    const { acc } = run(id);
    const f = acc.fails.filter((x) => /^A[234] /.test(x) && !/^A2 ship/.test(x));
    const n = new Set(f.map((x) => x.split(' ')[1])).size;
    rooms += acc.rooms.length; miss += n;
    for (const x of f) { const k = `${x.split(' ')[0]} ${x.match(/\((\w+)\)/)?.[1] || ''}`; tally[k] = (tally[k] || 0) + 1; }
    if (n > Math.max(2, acc.rooms.length * 0.03)) over.push(`${id} ${n}/${acc.rooms.length}: ${f.slice(0, 4).join('; ')}`);
  }
  console.log(`# measured rooms ${rooms}, rooms missing A2/A3/A4 ${miss} (${((miss / rooms) * 100).toFixed(2)} %): ${Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  assert.deepEqual(over, []);
  assert.ok(miss <= rooms * 0.02, `${miss} of ${rooms} rooms`);
});

test('acceptance: A8 dead ends only in the frozen GA corridors, never in a v2 cut', () => {
  const bad = [], ga = [];
  for (const id of IDS) {
    const { p, acc } = run(id);
    for (const f of acc.fails) {
      if (!f.startsWith('A8 ')) continue;
      const r = p.rooms.find((q) => q.id === f.split(' ')[1]);
      (r?.v2recut ? bad : ga).push(`${id}: ${f}`);
    }
  }
  if (ga.length) console.log(`# GA corridors with dead ends > 7 m (ga.js frozen): ${ga.length} — ${ga.slice(0, 6).join('; ')}`);
  assert.deepEqual(bad, []);
});

test('acceptance: §0.2 — v2 against v1 (cabins to scale, lined, dense; no empty halls)', () => {
  const rows = [];
  for (const id of ['coaster', 'feeder', 'ultramax64', 'mr50', 'ulcv24k', 'vlcc300', 'lng174k'].filter((k) => IDS.includes(k))) {
    const v1 = summary(planFromGA(id, { v: 1 })), v2 = summary(run(id).p);
    rows.push(`${id.padEnd(11)} cabin ${v1.cabinArea.toFixed(1)}→${v2.cabinArea.toFixed(1)} m²  h ${v1.cabinH.toFixed(2)}→${v2.cabinH.toFixed(2)}  near2 ${(v1.near2All * 100).toFixed(0)}→${(v2.near2All * 100).toFixed(0)} %  ER disc ${v1.emptyER.toFixed(1)}→${v2.emptyER.toFixed(1)} m  max room ${v1.maxRoom.toFixed(0)}→${v2.maxRoom.toFixed(0)} m²`);
    assert.ok(v2.cabinArea >= 6.5 && v2.cabinArea <= 20, `${id} cabin (with wet unit, seniors included) ${v2.cabinArea}`);
    assert.ok(v2.cabinH >= 2.15 && v2.cabinH <= 2.3, `${id} cabin height ${v2.cabinH}`);
    assert.ok(v2.near2All >= 0.9, `${id} near2 ${v2.near2All}`);
    assert.ok(v2.emptyER <= 2.5, `${id} ER disc ${v2.emptyER}`);
    assert.ok(v2.near2All > v1.near2All, `${id} denser than v1`);
  }
  console.log(rows.map((r) => `# ${r}`).join('\n'));
});
