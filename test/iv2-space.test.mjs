// Interiors v2 — space planner (docs/INTERIORS-V2-CONTRACT.md §2, §4.1, §9.2; Lane A): SCALE, the house re-cut,
// SpacePlan shape, reachability, cabin sizes against MLC, clear heights, determinism.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCALE, SPACE_KINDS, IV2_READY, IV2_GENS, netArea, wetRange, spacePlan, scoreSpace, houseSpaces, solveBlock } from '../shared/ships/gaspace.js';
import { generalArrangement } from '../shared/ships/ga.js';
import { MODELS } from '../shared/ships/catalogue.js';
import { TILE_INDEX, ALIAS } from '../public/js/iv2atlas.js';
const ATLAS_OK = (t) => TILE_INDEX.has(t) || TILE_INDEX.has(ALIAS[t]);

const IDS = Object.keys(MODELS).filter((k) => MODELS[k].gen !== 'sail');
const READY = IDS.filter((k) => IV2_READY.has(MODELS[k].gen));
const area = (r) => (r.x1 - r.x0) * (r.z1 - r.z0);

test('space: SCALE rows are well formed (min ≤ target ≤ max, height band, fill band, atlas tiles)', () => {
  assert.ok(SPACE_KINDS.length >= 60, `${SPACE_KINDS.length} kinds`);
  for (const k of SPACE_KINDS) {
    const s = SCALE[k];
    assert.ok(s.min <= s.target && s.target <= s.max, `${k} min/target/max`);
    assert.ok(s.h[0] <= s.h[1] && s.h[0] >= 0.9, `${k} height band`);
    assert.ok(s.fill[0] <= s.fill[1] && s.fill[1] <= 1, `${k} fill band`);
    assert.ok(s.emptyR > 0, `${k} emptyR`);
    for (const t of [s.floor, s.wall]) assert.ok(ATLAS_OK(t), `${k}: tile ${t}`);
  }
  for (const g of IV2_READY) assert.ok(IV2_GENS.includes(g), g);
});

test('space: netArea / wetRange — cabins measure without the en-suite wet unit', () => {
  assert.deepEqual(wetRange('cabin_rating'), [1.6, 2.0]);
  assert.deepEqual(wetRange('mess'), [0, 0]);
  assert.ok(netArea('cabin_rating', 10.4).ok);
  assert.ok(!netArea('cabin_rating', 5).ok);
  assert.ok(!netArea('cabin_rating', 20).ok);
});

test('space: every non-sail model — SpacePlan reachable from the stairs, nothing over its cap', () => {
  const bad = [];
  for (const id of IDS) {
    const sp = spacePlan(id); if (!sp) continue;
    const s = scoreSpace(sp);
    if (s.unreachable) bad.push(`${id}: ${s.unreachable} unreachable`);
    if (s.missingMust) bad.push(`${id}: ${s.missingMust} missing`);
    for (const r of sp.rooms) {
      const k = SCALE[r.space]; if (!k || k.circulation || !Number.isFinite(k.max) || r.space === 'bridge' || r.space === 'stair' || r.space === 'corridor' || r.space === 'entrance') continue;
      if (!r.tags.some((t) => t.startsWith('host:'))) continue;   // GA rooms kept as they are
      if (!netArea(r.space, area(r)).ok) bad.push(`${id} ${r.id} ${r.space} ${area(r).toFixed(1)} m²`);
    }
  }
  assert.deepEqual(bad, []);
});

test('space: cabin sizes — ultramax64 (≥ 10,000 GT) and coaster (< 3,000 GT) against MLC and SCALE', () => {
  const net = (r) => netArea(r.space, area(r)).net;
  const um = spacePlan('ultramax64').rooms;
  const ur = um.filter((r) => r.space === 'cabin_rating'), uo = um.filter((r) => r.space === 'cabin_officer');
  assert.ok(ur.length >= 6 && uo.length >= 4, `ultramax64 cabins ${ur.length}/${uo.length}`);
  for (const r of ur) { const a = net(r); assert.ok(a >= 7.0 - 0.01 && a <= 10.5 * 1.03, `ultramax64 rating ${r.id} ${a}`); }
  for (const r of uo) { const a = net(r); assert.ok(a >= 8.5 * 0.97 && a <= 13 * 1.03, `ultramax64 officer ${r.id} ${a}`); }
  const co = spacePlan('coaster').rooms.filter((r) => r.space === 'cabin_rating' || r.space === 'cabin_officer');
  assert.ok(co.length >= 3, 'coaster cabins');
  for (const r of co) { const a = net(r); assert.ok(a >= 4.5 && a <= 13.5, `coaster ${r.id} ${a}`); }
});

test('space: clear heights 2.15–2.30 m in lined accommodation, the deck height kept', () => {
  for (const id of ['coaster', 'ultramax64', 'mr50', 'feeder', 'lng174k']) {
    const sp = spacePlan(id);
    for (const r of sp.rooms) {
      if (!r.lined || !String(r.space).startsWith('cabin_') || r.space === 'cabin_lobby') continue;
      assert.ok(r.h >= 2.15 - 1e-6 && r.h <= 2.3 + 1e-6, `${id} ${r.id} h ${r.h}`);
      assert.ok(r.deckH >= r.h, `${id} ${r.id} deck height`);
    }
  }
});

test('space: one door per re-cut space, onto its corridor / host, inside the wall', () => {
  for (const id of ['ultramax64', 'mr50', 'feeder1000', 'lng174k', 'vlcc300']) {
    const sp = spacePlan(id), byId = new Map(sp.rooms.map((r) => [r.id, r]));
    for (const d of sp.doors) {
      const r = byId.get(d.a); if (!r || !r.tags.some((t) => t.startsWith('host:'))) continue;
      const ns = d.side === 'n' || d.side === 's', lo = ns ? r.x0 : r.z0, hi = ns ? r.x1 : r.z1;
      assert.ok(d.at - d.w / 2 >= lo - 0.02 && d.at + d.w / 2 <= hi + 0.02, `${id} ${d.a} door ${d.at}±${d.w / 2} in ${lo}…${hi}`);
      assert.ok(d.w >= 0.72, `${id} ${d.a} door width`);
    }
  }
});

test('space: deterministic and frozen; variants resolve', () => {
  const a = spacePlan('ultramax64'), b = spacePlan('ultramax64');
  assert.equal(a, b);
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.rooms[0]));
  const h1 = JSON.stringify([...houseSpaces(generalArrangement('mr50')).values()].map((x) => x.spaces.map((s) => [s.id, s.kind, s.x0, s.z0])));
  const h2 = JSON.stringify([...houseSpaces(generalArrangement('mr50')).values()].map((x) => x.spaces.map((s) => [s.id, s.kind, s.x0, s.z0])));
  assert.equal(h1, h2);
  const v = Object.keys(MODELS).find((k) => k === 'ultramax64') && spacePlan('ultramax64~lng.i1c.esd');
  if (v) assert.ok(v.rooms.length > 10, 'variant SpacePlan');
  assert.equal(spacePlan('nonesuch'), null);
});

test('space: houseSpaces — every GA block is tiled by its spaces (no overlaps, ≤ 3 % lost)', () => {
  for (const id of ['ultramax64', 'mr50', 'feeder', 'coaster', 'lng174k', 'vlcc300']) {
    for (const [bid, rep] of houseSpaces(generalArrangement(id))) {
      const b = rep.block, A = area(b);
      const sum = rep.spaces.reduce((t, x) => t + area(x), 0);
      assert.ok(sum <= A + 0.05 && sum >= A * 0.97 - 0.05, `${id} ${bid}: ${sum.toFixed(2)} of ${A.toFixed(2)} m²`);
      for (const x of rep.spaces) assert.ok(x.x0 >= b.x0 - 0.01 && x.x1 <= b.x1 + 0.01 && x.z0 >= b.z0 - 0.01 && x.z1 <= b.z1 + 0.01, `${id} ${x.id} inside ${bid}`);
      for (let i = 0; i < rep.spaces.length; i++) for (let k = i + 1; k < rep.spaces.length; k++) {
        const a = rep.spaces[i], c = rep.spaces[k];
        const ov = Math.max(0, Math.min(a.x1, c.x1) - Math.max(a.x0, c.x0)) * Math.max(0, Math.min(a.z1, c.z1) - Math.max(a.z0, c.z0));
        assert.ok(ov < 0.02, `${id} ${a.id} overlaps ${c.id}`);
      }
    }
  }
  assert.equal(typeof solveBlock, 'function');
});

test('space: phase-1 models all have a SpacePlan with cabins and a galley', () => {
  for (const id of READY) {
    const sp = spacePlan(id);
    assert.ok(sp && sp.rooms.some((r) => String(r.space).startsWith('cabin_')), `${id} cabins`);
    assert.ok(sp.rooms.some((r) => r.space === 'galley'), `${id} galley`);
  }
});
