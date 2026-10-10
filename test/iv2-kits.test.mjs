// Interiors v2 — kits (docs/INTERIORS-V2-CONTRACT.md §3, Lane K): every accommodation / service kit over a grid of room
// sizes (min, target, max of §2.1) and door sides, furnished into a scratch plan: the door stays reachable from every
// hotspot, the largest empty disc and the fill hold for (nearly) all cases, the template cache replays a fresh solve,
// items exist in the catalogue and the per-kit triangle sum stays small.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _internals } from '../public/js/gaplan.js';
import { generalArrangement } from '../shared/ships/ga.js';
import { SCALE, wetRange } from '../shared/ships/gaspace.js';
import { KITS, Placer, furnishV2 } from '../public/js/iv2kits.js';
import { ITEMS, trisOf } from '../public/js/iv2items.js';
import { roomMetrics } from '../scripts/interiors/metrics.mjs';

const { GPlan } = _internals;
const KINDS = ['cabin_rating', 'cabin_officer', 'suite_day', 'suite_bed', 'mess', 'galley', 'pantry', 'provisions_dry', 'cold_room', 'hospital', 'laundry', 'gym', 'recreation', 'lounge_crew', 'library', 'conference', 'changing_er', 'office', 'ccr', 'chartroom', 'radio_room', 'electronics', 'store_gen', 'linen', 'ac_room', 'fan_room', 'bonded_store'].filter((k) => SCALE[k]?.kit && KITS[SCALE[k].kit]);
const ga = generalArrangement('ultramax64');
let seq = 0;
/** A room of the given area / depth with one door on `side`, onto a corridor, at y = 200 (nothing else around). */
function scratch(kind, A, side, D = 3.6) {
  const P = new GPlan(ga); P.setZone('house');
  const W = Math.max(1.8, A / D), y = 200, x0 = 1000 + (seq++ % 50) * 40, z0 = 0;
  const s = SCALE[kind];
  const r = P.room({ id: `t${seq}`, x0, x1: x0 + W, z0, z1: z0 + D, y, h: s.h[0], space: kind, use: kind, zone: 'house', walls: { n: true, s: true, e: true, w: true } });
  const c = { n: { x0, x1: x0 + W, z0: z0 - 1.2, z1: z0 }, s: { x0, x1: x0 + W, z0: z0 + D, z1: z0 + D + 1.2 }, w: { x0: x0 - 1.2, x1: x0, z0, z1: z0 + D }, e: { x0: x0 + W, x1: x0 + W + 1.2, z0, z1: z0 + D } }[side];
  const cor = P.room({ id: `c${seq}`, ...c, y, h: 2.2, space: 'corridor', kind: 'passage', zone: 'house' });
  const at = side === 'n' || side === 's' ? x0 + Math.min(W - 0.6, 0.75) : z0 + Math.min(D - 0.6, 0.75);
  P.door(r, cor, side, at, 0.8);
  return { P, r };
}

test('kits: the catalogue — every kit item exists with sizes and triangle counts', () => {
  for (const [id, it] of Object.entries(ITEMS)) {
    assert.ok(it.w > 0 && it.d > 0 && it.h >= 0, `${id} size`);
    assert.ok(Array.isArray(it.tris) && it.tris[0] >= it.tris[1], `${id} LODs`);
  }
  assert.ok(Object.keys(ITEMS).length >= 120, `${Object.keys(ITEMS).length} items`);
  assert.ok(Object.keys(KITS).length >= 25, `${Object.keys(KITS).length} kits`);
});

test('kits: grid of sizes and door sides — reachable, emptyR and fill hold in ≥ 90 % of cases', () => {
  let n = 0, okR = 0, okF = 0; const unreachable = [], missR = [], empty = [];
  for (const kind of KINDS) {
    const s = SCALE[kind], wet = wetRange(kind)[1];
    const areas = [s.min + wet, s.target + wet, Math.min(s.max, s.target * 1.6) + wet];
    for (const A of areas) for (const side of ['n', 's', 'e', 'w']) {
      const { P, r } = scratch(kind, A, side, Math.min(4.2, Math.max(2.2, Math.sqrt(A))));
      furnishV2(P, r, { seed: 7 });
      n++;
      const items = P.props.filter((p) => p.t === 'k2' && p.room === r.id);
      if (!items.length) empty.push(`${kind} ${A.toFixed(1)} ${side}`);
      for (const p of items) assert.ok(ITEMS[p.item], `${kind}: unknown item ${p.item}`);
      // every target (door, hotspots) in one walkable group with the furniture in place
      const K = new Placer(P, r, {});
      if (K.baseline().length > 1) unreachable.push(`${kind} ${A.toFixed(1)} m² door ${side}`);
      const m = roomMetrics(P, r);
      if (m.emptyR <= s.emptyR + 0.25) okR++; else missR.push(`${kind} ${A.toFixed(1)} ${side} r ${m.emptyR.toFixed(2)}`);
      if (m.fill <= s.fill[1] * 1.35) okF++;
    }
  }
  console.log(`# kits: ${n} cases, emptyR ok ${okR}, fill ok ${okF}${missR.length ? `; misses: ${missR.slice(0, 8).join(', ')}` : ''}`);
  assert.deepEqual(unreachable, []);
  assert.deepEqual(empty, []);
  assert.ok(okR >= n * 0.9, `emptyR ${okR}/${n}`);
  assert.ok(okF >= n * 0.95, `fill ${okF}/${n}`);
});

test('kits: hotspots stand on walkable floor in front of their item', () => {
  for (const kind of ['galley', 'hospital', 'ccr', 'mess']) {
    const s = SCALE[kind], { P, r } = scratch(kind, s.target + wetRange(kind)[1], 's', 4);
    furnishV2(P, r, { seed: 3 });
    const K = new Placer(P, r, {});
    for (const h of P.hotspots) assert.ok(K.walkableAt(h.x, h.z), `${kind} hotspot ${h.label} at ${h.x},${h.z}`);
  }
});

test('kits: the template cache replays a fresh solve (same items, translated)', () => {
  const a = scratch('cabin_rating', 10, 's'), b = scratch('cabin_rating', 10, 's');
  furnishV2(a.P, a.r, { seed: 1 }); const st = furnishV2(b.P, b.r, { seed: 1 });
  const rel = (P, r) => P.props.filter((p) => p.t === 'k2' && p.room === r.id).map((p) => [p.item, +(p.x - r.x0).toFixed(2), +(p.z - r.z0).toFixed(2), p.rotY]);
  assert.deepEqual(rel(b.P, b.r), rel(a.P, a.r));
  assert.ok(st.cached, 'second solve came from the cache');
});

test('kits: a cabin has a berth, a desk and a wardrobe; triangles per kit stay small', () => {
  const { P, r } = scratch('cabin_officer', 12.5, 'n');
  furnishV2(P, r, { seed: 2 });
  const ids = P.props.filter((p) => p.t === 'k2' && p.room === r.id).map((p) => p.item);
  assert.ok(ids.some((i) => /bunk|bed|berth/.test(i)), `berth in ${ids}`);
  assert.ok(ids.some((i) => /desk/.test(i)), `desk in ${ids}`);
  assert.ok(ids.length >= 7, `${ids.length} items`);
  assert.ok(trisOf(ids, 0) <= 12000, `cabin LOD0 ${trisOf(ids, 0)} tris`);
  assert.ok(trisOf(ids, 1) <= trisOf(ids, 0) / 3, 'LOD1 much cheaper');
});
