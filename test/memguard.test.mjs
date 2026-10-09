// Memory budget (the 1 GiB pod was OOM-killed with world tiles on): server/memguard.js levels / hysteresis / shed,
// server/bytelru.js byte budgets, and the bounded caches of worldtiles.js (decoded tiles, background work, queue caps,
// one background build at a time), wtprefetch.js (warm-up gated by the guard, one harbour at a time) and harborgeom.js
// (patch budget, resident pins, lazy reload, anchors without loading).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readMemLimit, levelFor, createMemGuard, LEVEL, THRESHOLDS } from '../server/memguard.js';
import { ByteLRU } from '../server/bytelru.js';
import { createWorldTiles, inlineConverter, workerConverter, PRIO, DEFAULT_MEM_MB, BG_QUEUE_MAX, WORKER_HEAP_MB } from '../server/worldtiles.js';
import { createSources } from '../server/wtsource.js';
import { WT, tileF } from '../shared/wtformat.js';
import { encodeMVT } from './fixtures/wt/mvtenc.mjs';

const MB = 1048576;
const silent = () => {};
const made = [];
const tmpDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'saltline-mem-')); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

// ------------------------------------------------------------------------------------------------ memguard
test('readMemLimit: env override, cgroup v2, "max" falls through to cgroup v1 / totalmem, absurd values ignored', () => {
  const tot = () => 16 * 1024 * MB;
  const files = (m) => (p) => { if (p in m) return m[p]; throw new Error('ENOENT'); };
  assert.deepEqual(readMemLimit({ env: { SALTLINE_MEM_LIMIT_MB: '1024' }, read: files({}), totalmem: tot }), { bytes: 1024 * MB, source: 'env' });
  assert.deepEqual(readMemLimit({ env: {}, read: files({ '/sys/fs/cgroup/memory.max': '1073741824\n' }), totalmem: tot }), { bytes: 1073741824, source: 'cgroup2' });
  assert.deepEqual(readMemLimit({ env: {}, read: files({ '/sys/fs/cgroup/memory.max': 'max\n', '/sys/fs/cgroup/memory/memory.limit_in_bytes': '536870912' }), totalmem: tot }), { bytes: 536870912, source: 'cgroup1' });
  assert.deepEqual(readMemLimit({ env: {}, read: files({ '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712' }), totalmem: tot }), { bytes: tot(), source: 'totalmem' });
  assert.deepEqual(readMemLimit({ env: {}, read: files({}), totalmem: tot }), { bytes: tot(), source: 'totalmem' });
});

test('levelFor: 50 / 65 / 75 / 85 % thresholds going up, 3 % hysteresis going down', () => {
  assert.deepEqual(THRESHOLDS, [0, 0.5, 0.65, 0.75, 0.85]);
  assert.equal(levelFor(0.2), LEVEL.ok);
  assert.equal(levelFor(0.49), LEVEL.ok);
  assert.equal(levelFor(0.5), LEVEL.warm);
  assert.equal(levelFor(0.66), LEVEL.pause);
  assert.equal(levelFor(0.76), LEVEL.shed);
  assert.equal(levelFor(0.9), LEVEL.critical);
  assert.equal(levelFor(0.95, LEVEL.ok), LEVEL.critical, 'jumps straight up');
  // down: stays until 3 % under the threshold
  assert.equal(levelFor(0.83, LEVEL.critical), LEVEL.critical);
  assert.equal(levelFor(0.81, LEVEL.critical), LEVEL.shed);
  assert.equal(levelFor(0.73, LEVEL.shed), LEVEL.shed);
  assert.equal(levelFor(0.71, LEVEL.shed), LEVEL.pause);
  assert.equal(levelFor(0.3, LEVEL.critical), LEVEL.ok, 'falls through every level');
  assert.equal(levelFor(0.48, LEVEL.warm), LEVEL.warm);
  assert.equal(levelFor(0.46, LEVEL.warm), LEVEL.ok);
});

test('createMemGuard: transitions logged, shed handlers + gc on entering shed / critical and every reshedMs, allowPrio / allowBackground', () => {
  let rss = 100 * MB, t = 0, gcs = 0;
  const logs = [], sheds = [], levels = [];
  const g = createMemGuard({ limitBytes: 1000 * MB, sample: () => rss, now: () => t, log: (m) => logs.push(m), gc: () => { gcs++; }, reshedMs: 30_000 });
  g.onShed((e) => sheds.push(e.mode)).onLevel((n, p) => levels.push([p, n]));
  g.tick();
  assert.equal(g.name(), 'ok'); assert.ok(g.allowBackground()); assert.ok(g.allowPrio(4));
  rss = 550 * MB; g.tick();
  assert.equal(g.name(), 'warm'); assert.equal(g.allowBackground(), false); assert.ok(g.allowPrio(3)); assert.equal(g.allowPrio(4), false);
  rss = 700 * MB; g.tick();
  assert.equal(g.name(), 'pause'); assert.equal(g.allowPrio(3), false); assert.ok(g.allowPrio(2));
  assert.equal(sheds.length, 0, 'no shedding below 75 %');
  rss = 760 * MB; t = 1000; g.tick();
  assert.equal(g.name(), 'shed'); assert.deepEqual(sheds, ['shed']); assert.equal(gcs, 1);
  t = 10_000; g.tick(); assert.equal(sheds.length, 1, 'not again within reshedMs');
  t = 32_000; g.tick(); assert.equal(sheds.length, 2, 'again while still above 75 %');
  rss = 900 * MB; t = 33_000; g.tick();
  assert.equal(g.name(), 'critical'); assert.deepEqual(sheds.slice(-1), ['critical']);
  assert.ok(g.allowPrio(0)); assert.equal(g.allowPrio(1), false);
  rss = 300 * MB; t = 40_000; g.tick();
  assert.equal(g.name(), 'ok'); assert.ok(g.allowBackground());
  assert.deepEqual(levels.map((l) => l.join('>')), ['0>1', '1>2', '2>3', '3>4', '4>0']);
  assert.equal(logs.length, 5); assert.match(logs[3], /shed → critical: rss 900 MB of 1000 MB \(90 %\)/);
  const s = g.stats();
  assert.equal(s.limitMB, 1000); assert.equal(s.peakMB, 900); assert.equal(s.transitions, 5); assert.equal(s.gcs, gcs);
});

// ------------------------------------------------------------------------------------------------ ByteLRU
test('ByteLRU: byte budget, least recently touched out, get() does not reorder, pins, resize, dropWhere', () => {
  const ev = [];
  const pins = new Set();
  const c = new ByteLRU({ maxBytes: 100, sizeOf: (v) => v.n, onEvict: (k) => ev.push(k), pinned: (k) => pins.has(k) });
  c.set('a', { n: 40 }); c.set('b', { n: 40 });
  assert.equal(c.bytes, 80);
  c.get('a');                       // read only: 'a' stays the oldest
  c.set('c', { n: 40 });
  assert.deepEqual(ev, ['a']); assert.equal(c.bytes, 80); assert.ok(!c.has('a'));
  c.touch('b'); c.set('d', { n: 40 });
  assert.deepEqual(ev, ['a', 'c'], 'touch() made b recent');
  pins.add('b'); c.set('e', { n: 40 });
  assert.deepEqual(ev, ['a', 'c', 'd'], 'pinned b survives');
  assert.ok(c.bytes <= 100);
  c.set('huge', { n: 500 });
  assert.ok(c.has('huge'), 'a single oversize item is kept while newest'); assert.ok(c.has('b'), 'pin still kept');
  c.set('f', { n: 1 });
  assert.ok(!c.has('huge'));
  const v = { n: 1 }; c.set('g', v); v.n = 30; c.resize('g');
  assert.equal(c.bytes, [...c.map.values()].reduce((s, e) => s + e.b, 0));
  const others = c.size - 1;
  assert.equal(c.dropWhere((k) => k !== 'b'), others);
  assert.deepEqual([...c.keys()], ['b']);
  assert.equal(c.trim(0, (k) => !pins.has(k)), 0, 'filtered trim never drops a pinned entry');
});

// ------------------------------------------------------------------------------------------------ worldtiles budgets
const sq = (x0, y0, x1, y1) => [x0, y0, x1, y0, x1, y1, x0, y1];
const COAST = encodeMVT({ layers: { water: { extent: 4096, features: [{ type: 3, tags: { class: 'ocean' }, geom: [[sq(-64, -64, 2048, 4160)]] }] } } });
function res(status, body) {
  const b = body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) || body instanceof Uint8Array ? Buffer.from(body) : Buffer.from(JSON.stringify(body));
  return { status, headers: { get: () => null }, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
}
function fetchCoast(gate = null) {
  const fn = async (url) => {
    if (url === 'https://tiles.openfreemap.org/planet') return res(200, { tiles: ['https://tiles.openfreemap.org/planet/A/{z}/{x}/{y}.pbf'] });
    if (url.includes('/planet/')) { fn.tiles++; if (gate) await gate(url); return res(200, COAST); }
    return res(404, null);
  };
  fn.tiles = 0;
  return fn;
}
function service(fetchImpl, more = {}) {
  const dataDir = tmpDir();
  const sources = createSources({ fetchImpl, dataDir, offline: false, log: silent, ofmPerSec: 1000, ofmConc: 8 });
  return createWorldTiles({ dataDir, offline: false, log: silent, sources, converter: inlineConverter(), flushMs: 3_600_000, ...more });
}

test('worldtiles: decoded tiles stay inside the byte budget (memMB), vectors are parsed lazily', async () => {
  assert.equal(DEFAULT_MEM_MB, 64);
  const wt = service(fetchCoast(), { memMB: 1 });
  for (let i = 0; i < 16; i++) await wt.request(14, 8300 + i, 5380, PRIO.P1);
  const s = wt.stats();
  assert.ok(s.memMB <= 1.01, `memMB ${s.memMB} ≤ 1`);
  assert.ok(s.memTiles >= 3 && s.memTiles < 16, `${s.memTiles} tiles fit`);
  assert.ok(s.memEvicted > 0);
  assert.equal(wt.get(14, 8300, 5380), null, 'oldest dropped from memory');
  assert.ok(wt.has(14, 8300, 5380), 'still on disk');
  const again = await wt.request(14, 8300, 5380, PRIO.P1);
  assert.ok(again && again.mask, 'reloaded from disk');
  const d = Object.getOwnPropertyDescriptor(again, 'vectors');
  assert.equal(typeof d.get, 'function', 'vectors is a lazy getter');
  wt.close();
});

test('worldtiles: background (P3/P4) builds and disk reads never fill the memory cache; the caller still gets the tile', async () => {
  const wt = service(fetchCoast());
  const t = await wt.request(14, 8310, 5380, PRIO.P4);
  assert.ok(t && t.mask);
  assert.equal(wt.get(14, 8310, 5380), null, 'P4 build not kept in memory');
  assert.equal(wt.stats().memTiles, 0);
  const t2 = await wt.request(14, 8310, 5380, PRIO.P3);
  assert.ok(t2 && t2.mask); assert.equal(wt.stats().memTiles, 0, 'P3 disk read not kept either');
  const t3 = await wt.request(14, 8310, 5380, PRIO.P1);
  assert.ok(t3); assert.equal(wt.stats().memTiles, 1, 'foreground request keeps it');
  // collect(): the patch builder's tiles, handed back without filling memory
  const m = await wt.collect(51.9, 4.1, 300, PRIO.P4, { timeoutMs: 5000 });
  assert.ok(m instanceof Map && m.size >= 1);
  assert.equal(wt.stats().memTiles, 1);
  wt.close();
});

test('worldtiles: one background build at a time, foreground builds in parallel; background queue capped', async () => {
  let inFlight = 0, peakBg = 0;
  const release = [];
  const gate = async () => { inFlight++; peakBg = Math.max(peakBg, inFlight); await new Promise((r) => release.push(r)); inFlight--; };
  const wt = service(fetchCoast(gate), { fetchConc: 4 });
  const bg = [];
  for (let i = 0; i < 5; i++) bg.push(wt.request(14, 8400 + i, 5380, PRIO.P4));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(inFlight, 1, 'only one P4 build in flight');
  const fg = [wt.request(14, 8500, 5380, PRIO.P1), wt.request(14, 8501, 5380, PRIO.P1)];
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(inFlight, 3, 'foreground builds start next to it');
  const s = wt.stats(); assert.equal(s.activeBg, 1);
  // drain
  const pump = setInterval(() => { while (release.length) release.shift()(); }, 5);
  await Promise.all([...bg, ...fg]);
  clearInterval(pump);
  assert.equal(peakBg <= 3, true);
  // background cap: beyond BG_QUEUE_MAX queued P4 jobs, new ones are refused at once
  const hold = []; const gate2 = () => new Promise((r) => hold.push(r));
  const wt2 = service(fetchCoast(gate2));
  const ps = [];
  for (let i = 0; i < BG_QUEUE_MAX + 20; i++) ps.push(wt2.request(14, 9000 + i, 5380, PRIO.P4));
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(wt2.stats().queueBg <= BG_QUEUE_MAX, `queueBg ${wt2.stats().queueBg}`);
  assert.ok(wt2.stats().denied >= 19, `denied ${wt2.stats().denied}`);   // 1 building + 200 queued
  wt2.close(); for (const r of hold) r();
  await Promise.all(ps);
  wt.close();
});

test('worldtiles: the memory guard denies and drops work above its level; shed keeps tiles near ships only', async () => {
  let allowed = 4;
  const guard = { allowPrio: (p) => p <= allowed };
  const hold = []; let gated = true;
  const wt = service(fetchCoast(() => (gated ? new Promise((r) => hold.push(r)) : null)), { guard, fetchConc: 1 });
  const first = wt.request(14, 8300, 5380, PRIO.P1);           // occupies the only slot
  const queued = [wt.request(14, 8301, 5380, PRIO.P2), wt.request(14, 8302, 5380, PRIO.P3)];
  await new Promise((r) => setTimeout(r, 20));
  allowed = 2;                                                  // pause: P3 dropped from the queue on the next pump
  gated = false; for (const r of hold) r();
  assert.ok(await first);
  assert.equal(await queued[1], null, 'queued P3 dropped');
  assert.ok(await queued[0], 'P2 still built');
  assert.equal(await wt.request(14, 8303, 5380, PRIO.P4), null, 'new P4 refused');
  assert.ok(wt.stats().denied >= 1 && wt.stats().dropped >= 1);
  allowed = 0;
  assert.equal(await wt.request(14, 8304, 5380, PRIO.P1), null, 'critical: only P0');
  assert.ok(await wt.request(14, 8304, 5380, PRIO.P0), 'P0 still fetched');
  // shed: tiles away from the kept ships go
  const near = tileF(14, 51.9, 4.1);
  allowed = 4;
  await wt.request(14, Math.floor(near.fx), Math.floor(near.fy), PRIO.P1);
  const before = wt.stats().memTiles;
  const r = wt.shed({ keep: [{ lat: 51.9, lon: 4.1 }], keepM: 3000 });
  assert.ok(r.dropped >= 1 && wt.stats().memTiles < before);
  assert.ok(wt.get(14, Math.floor(near.fx), Math.floor(near.fy)), 'the tile under the ship stays');
  wt.close();
});

test('converter worker: heap-capped, stopped when idle, started again by the next job', async () => {
  assert.equal(WORKER_HEAP_MB, 96);
  const w = workerConverter({ log: silent, idleMs: 150 });
  const job = { z: 14, x: 8300, y: 5380, mvt: COAST, overlay: null, bathy: null, hints: { src: 'ofm:A', builtAt: 0 } };
  const a = await w.convert(job);
  assert.ok(a && a.raw);
  assert.equal(w.stats().heapMb, 96);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(w.stats().mode, 'idle'); assert.equal(w.stats().idleStops, 1); assert.equal(w.stats().restarts, 0, 'an idle stop is not a crash');
  const b = await w.convert(job);
  assert.ok(b && b.raw, 'converted by a fresh worker');
  assert.deepEqual(Buffer.from(a.raw), Buffer.from(b.raw));
  assert.equal(w.stats().spawns, 2);
  w.close();
});

// ------------------------------------------------------------------------------------------------ prefetch
test('prefetch: warm-up only while the guard allows background work, one harbour at a time, P3 paused by the guard', async () => {
  const { startPrefetch } = await import('../server/wtprefetch.js');
  const asked = [];
  const pending = [];
  const wt = {
    request: (z, x, y, prio, o) => { asked.push({ z, x, y, prio, ...o }); if (prio === PRIO.P4) return new Promise((r) => pending.push(() => r(z === 11 ? { flags: WT.FLAG.UNIFORM } : null))); return Promise.resolve(null); },
    queued: () => 0, healthy: () => true, sources: { sourceInfo: () => ({ today: { ofm: 0 } }) },
  };
  let bgOk = false, p3 = true;
  const guard = { allowBackground: () => bgOk, allowPrio: (p) => (p === 3 ? p3 : true) };
  const harbors = [{ id: 'a', lat: 51.98, lon: 4.03, size: 'mega' }, { id: 'b', lat: 53.5, lon: 9.9, size: 'mega' }];
  const game = { byId: new Map([['off', { id: 'off', online: false, ship: { lat: 50, lon: -10, cls: 'coaster', spd: 0 } }]]) };
  let t = 1_000_000;
  const pf = startPrefetch({ game, wt, harbors, timers: false, loadavg: () => 0, guard, warmGapMs: 10_000, now: () => t, tickMs: 2000 });
  const run = (ms) => { for (let k = 0; k < ms / 2000; k++) { t += 2000; pf.tick(); } };   // 2 s ticks (no event-loop lag)
  pf.tick();
  assert.equal(asked.filter((a) => a.prio === PRIO.P4).length, 0, 'no warm-up while memory ≥ 50 %');
  assert.ok(asked.some((a) => a.prio === PRIO.P3));
  bgOk = true; run(2000);
  assert.equal(asked.filter((a) => a.prio === PRIO.P4 && a.z === 11).length, 9, 'first harbour');
  run(20_000);
  assert.equal(asked.filter((a) => a.prio === PRIO.P4 && a.z === 11).length, 9, 'not the next while the first is in flight');
  for (const r of pending.splice(0)) r();
  await new Promise((r) => setTimeout(r, 10));
  run(6000);
  assert.equal(asked.filter((a) => a.prio === PRIO.P4 && a.z === 11).length, 9, 'and not within warmGapMs of it');
  run(6000);
  assert.equal(asked.filter((a) => a.prio === PRIO.P4 && a.z === 11).length, 18, 'then the second');
  for (const r of pending.splice(0)) r();
  await new Promise((r) => setTimeout(r, 10));
  run(40_000);
  assert.equal(asked.filter((a) => a.prio === PRIO.P4 && a.z === 11).length, 18, 'one sweep per day');
  assert.equal(pf.stats().sweeps, 1);
  // P3 paused
  p3 = false; const n3 = asked.filter((a) => a.prio === PRIO.P3).length; run(120_000);
  assert.equal(asked.filter((a) => a.prio === PRIO.P3).length, n3);
  assert.ok(pf.stats().skippedP3 >= 1);
  pf.stop();
});

// ------------------------------------------------------------------------------------------------ harbour patches
test('harborgeom: patch cache bounded in bytes, resident patches pinned, evicted ones reload lazily, anchors kept', async () => {
  const harborgeom = await import('../server/harborgeom.js');
  const { World } = await import('../server/world.js');
  const { carvingsForWorld } = await import('../server/harbors.js');
  const world = new World().load(carvingsForWorld(), silent);
  const dataDir = tmpDir();
  harborgeom.configure({ dataDir, offline: true, preload: false, log: silent, wt: null, lazyLoad: true, patchMemMB: 1000 });
  harborgeom.init(world);
  const ids = ['rotterdam', 'hamburg', 'antwerp'];
  try {
    for (const id of ids) assert.ok(await harborgeom.ensureHarbor(id));
    const all = harborgeom.stats();
    assert.equal(all.built, 3);
    const per = all.memMB / 3;
    assert.ok(per > 0.5, `≈ ${per.toFixed(2)} MB per patch counted`);
    const anchor = harborgeom.harborAnchor('rotterdam');
    harborgeom.setResident(['hamburg']);
    harborgeom.configure({ patchMemMB: Math.max(0.01, per * 1.2) });   // room for ~1 patch
    let s = harborgeom.stats();
    assert.ok(s.built <= 2, `${s.built} patches in memory`);
    assert.ok(s.entries.some((e) => e.id === 'hamburg'), 'resident patch pinned');
    assert.ok(!s.entries.some((e) => e.id === 'rotterdam'), 'oldest non-resident evicted');
    assert.deepEqual(harborgeom.harborAnchor('rotterdam'), anchor, 'anchor answers without loading');
    assert.equal(harborgeom.isBuilt('rotterdam'), true);
    assert.equal(harborgeom.stats().built, s.built, 'harborAnchor / isBuilt did not load anything');
    const g = harborgeom.getHarborGeom('rotterdam');
    assert.ok(g && g.berths, 'geometry read from data/geom');
    assert.ok(harborgeom.getHarborPatch('rotterdam'));
    s = harborgeom.stats();
    assert.ok(s.lazy.light >= 1 && s.lightMB > 0, 'light read: patch bytes + JSON, no SDF');
    assert.ok(!s.entries.some((e) => e.id === 'rotterdam'), 'not a full entry (landPenetration unaffected)');
    const b = g.berths[0];
    assert.ok(harborgeom.nearestBerth('rotterdam', b.lat, b.lon), 'a query needing the SDF / berths loads the full entry');
    s = harborgeom.stats();
    assert.ok(s.lazy.loads >= 1 && s.entries.some((e) => e.id === 'rotterdam'));
    assert.ok(s.memMB <= per * 1.2 + per + 0.1, 'still within budget + the pinned patch');
    harborgeom.trimPatches(0);
    assert.deepEqual(harborgeom.stats().entries.map((e) => e.id), ['hamburg'], 'shed keeps only resident patches');
    assert.equal(harborgeom.landPenetration(53.5, 9.9) !== undefined, true);
  } finally {
    harborgeom.configure({ patchMemMB: 96, lazyLoad: false });
    harborgeom.setResident([]);
    harborgeom.resetCache();
  }
});
