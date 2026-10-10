// Interiors v2 — plan assembly (docs/INTERIORS-V2-CONTRACT.md §9.4, HV1; Lane K): Plan v2 shape for every phase-1
// model, legacy kinds kept, lights / emergency rules, the v1 fallback (opts.v = 1, globalThis.__iv2 = false), memo
// and plan time (the cold build, and the memo hit the YARD budget suite measures).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planFromGA } from '../public/js/gaplan.js';
import { MODELS } from '../shared/ships/catalogue.js';
import { IV2_READY, SCALE } from '../shared/ships/gaspace.js';
import { ITEMS } from '../public/js/iv2items.js';
import { TILE_INDEX, ALIAS } from '../public/js/iv2atlas.js';

const IDS = Object.keys(MODELS).filter((k) => MODELS[k].gen !== 'sail' && IV2_READY.has(MODELS[k].gen));
const LEGACY = new Set(['passage', 'stairs', 'deck', 'cabin', 'mess', 'galley', 'bridge', 'engine', 'store', 'cargo', 'room', 'hold', 'wheelhouse', 'saloon', 'heads']);
const tileOk = (t) => TILE_INDEX.has(t) || TILE_INDEX.has(ALIAS[t]);

test('plan: every phase-1 model builds a v2 plan with the §9.4 keys', () => {
  for (const id of IDS) {
    const p = planFromGA(id);
    assert.equal(p.v, 2, id);
    for (const k of ['lights', 'emitters', 'views', 'chunks']) assert.ok(Array.isArray(p[k]), `${id} ${k}`);
    assert.ok(p.iv2 && p.iv2.me && p.iv2.params, `${id} iv2 meta`);
    const spaced = p.rooms.filter((r) => r.space);
    assert.ok(spaced.length >= p.rooms.length * 0.8, `${id}: ${spaced.length}/${p.rooms.length} rooms with a space`);
    for (const r of spaced) {
      assert.ok(SCALE[r.space] || r.space === 'er_walkway', `${id} ${r.id} space ${r.space}`);
      if (r.mat) for (const t of [r.mat.floor, r.mat.wall]) assert.ok(tileOk(t), `${id} ${r.id} tile ${t}`);
      assert.ok(typeof r.kind === 'string' && r.kind.length, `${id} ${r.id} legacy kind`);
    }
    for (const q of p.props) if (q.t === 'k2') { assert.ok(ITEMS[q.item], `${id} item ${q.item}`); assert.ok(Number.isFinite(q.x + q.y + q.z), `${id} ${q.item} position`); }
    const chunked = new Set(p.chunks.flatMap((c) => c.rooms));
    for (const r of p.rooms) if (!r.open) assert.ok(chunked.has(r.id), `${id} ${r.id} in a chunk`);
  }
});

test('plan: legacy prop kinds the v1 code and tests look for are still there', () => {
  for (const id of ['ultramax64', 'mr50', 'feeder', 'lng174k']) {
    const p = planFromGA(id), kinds = new Set(p.props.map((q) => q.t)), hot = new Set(p.hotspots.map((h) => h.kind));
    assert.ok(kinds.has('helm') || hot.has('helm'), `${id} helm`);
    for (const k of ['telegraph', 'radio']) assert.ok(hot.has(k), `${id} hotspot ${k}`);
    assert.ok(p.rooms.some((r) => r.kind === 'bridge'), `${id} bridge`);
    assert.ok(p.rooms.some((r) => r.kind === 'engine'), `${id} engine`);
    assert.ok(p.spawn && p.helm, `${id} spawn / helm`);
  }
});

test('plan: lights — a practical in every enclosed walkable room, emergency lights along escapes, red at night on the bridge', () => {
  for (const id of IDS) {
    const p = planFromGA(id);
    const lit = new Set(p.lights.filter((l) => !l.em).map((l) => l.room)), em = new Set(p.lights.filter((l) => l.em).map((l) => l.room));
    for (const r of p.rooms) if (!r.open && r.walk !== false && r.space) assert.ok(lit.has(r.id), `${id} ${r.id} unlit`);
    for (const r of p.rooms) if (['corridor', 'stair'].includes(r.space)) assert.ok(em.has(r.id), `${id} ${r.id} no emergency light`);
    assert.ok(p.lights.some((l) => l.night === 'red' && p.rooms.find((r) => r.id === l.room)?.space === 'bridge'), `${id} bridge night light`);
    for (const l of p.lights) assert.ok(['on', 'dim', 'off', 'red'].includes(l.night) && l.lm > 0, `${id} light ${l.id}`);
  }
});

test('plan: the v1 fallback — opts.v = 1 and globalThis.__iv2 = false give the v1 plan', () => {
  const v1 = planFromGA('ultramax64', { v: 1 });
  assert.notEqual(v1.v, 2);
  globalThis.__iv2 = false;
  try { assert.notEqual(planFromGA('mr50').v, 2); } finally { delete globalThis.__iv2; }
  assert.equal(planFromGA('mr50').v, 2);
});

test('plan: memo hit ≤ 30 ms × slack; cold build of a big ship within seconds', () => {
  const SLACK = Number(process.env.GA_PLAN_SLACK || 4);
  const id = 'vlcc300~prem';   // a variant nothing above has built: a cold build
  const c0 = process.cpuUsage(); const a = planFromGA(id); const u0 = process.cpuUsage(c0), cold = (u0.user + u0.system) / 1000;
  assert.equal(a.v, 2);
  const c1 = process.cpuUsage(); assert.equal(planFromGA(id), a, 'memoised'); const hit = process.cpuUsage(c1).user / 1000;
  assert.ok(hit <= 30 * SLACK, `memo hit ${hit} ms`);
  assert.ok(cold <= 2500 * SLACK, `cold ${id} ${cold.toFixed(0)} ms`);
  console.log(`# ${id} cold ${cold.toFixed(0)} ms CPU, memo ${hit.toFixed(2)} ms`);
});
