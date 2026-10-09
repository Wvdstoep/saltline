// World-tile service (server/worldtiles.js + server/wtsource.js, docs/WORLD-DETAIL-STREAMING.md §3.3, §3.5, §4.3) against
// a fake fetch and a temporary data dir — no network: priorities, the hierarchical uniform skip, shared in-flight
// fetches, the HTTP wait / 503 / 304 / 404 answers, disk LRU with pinned tiles, index rebuild, circuit breaker +
// negative cache, stale serving, re-pin on a deleted version, rev 0 → rev 1 swaps, sync queries and the worker.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createWorldTiles, inlineConverter, workerConverter, hintsFor, PRIO } from '../server/worldtiles.js';
import { createSources, versionFromTemplate, decodeTerrarium, compactOverlay, UA } from '../server/wtsource.js';
import { WT, tileF, tileFToLatLon, decodeTile } from '../shared/wtformat.js';
import { encodeMVT } from './fixtures/wt/mvtenc.mjs';

const silent = () => {};
const made = [];
const tmpDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'saltline-wt-')); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const sq = (x0, y0, x1, y1) => [x0, y0, x1, y0, x1, y1, x0, y1];
const MVT = {
  ocean: encodeMVT({ layers: { water: { extent: 4096, features: [{ type: 3, tags: { class: 'ocean' }, geom: [[sq(-64, -64, 4160, 4160)]] }] } } }),
  coast: encodeMVT({ layers: { water: { extent: 4096, features: [{ type: 3, tags: { class: 'ocean' }, geom: [[sq(-64, -64, 2048, 4160)]] }] } } }),
  land: encodeMVT({ layers: {} }),
};
// a coastal Rotterdam-area tile and its neighbours (well away from any big-port data box: plain conversion)
const T = { z: 14, x: 8300, y: 5380 };
const ver = (v) => ({ tiles: [`https://tiles.openfreemap.org/planet/${v}/{z}/{x}/{y}.pbf`], maxzoom: 14 });

function res(status, body, headers = {}) {
  const b = body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) || body instanceof Uint8Array ? Buffer.from(body) : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return { status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
}
/** fetch mock: plan(url, init) may return a response, an Error, a Promise, or null for the default (versions A, coast tiles). */
function fakeFetch(plan = () => null) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = await plan(url, init, calls);
    if (r instanceof Error) throw r;
    if (r) return r;
    if (url === 'https://tiles.openfreemap.org/planet') return res(200, ver('A'));
    if (url.includes('/planet/')) return res(200, MVT.coast);
    if (url.includes('terrarium')) return res(404, null);
    if (url.includes('interpreter')) return res(200, { osm3s: { timestamp_osm_base: '2026-10-08T00:00:00Z' }, elements: [] });
    return res(404, null);
  };
  fn.calls = calls;
  fn.tiles = () => calls.filter((c) => /\/planet\/[^/]+\/\d+\//.test(c.url)).map((c) => c.url.replace(/^.*\/planet\/[^/]+\//, '').replace('.pbf', ''));
  return fn;
}
function service(fetchImpl, more = {}) {
  const dataDir = more.dataDir || tmpDir();
  const sources = createSources({ fetchImpl, dataDir, offline: false, log: silent, ofmPerSec: 1000, overpassGapMs: 0, ...(more.src || {}) });
  const wt = createWorldTiles({ dataDir, offline: false, log: silent, sources, converter: inlineConverter(), flushMs: 3_600_000, ...more });
  return { wt, sources, dataDir };
}
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

test('a request fetches, converts, caches on disk and in memory; the User-Agent and pinned version are used', async () => {
  const f = fakeFetch();
  const { wt, dataDir } = service(f);
  const t = await wt.request(T.z, T.x, T.y, PRIO.P1);
  assert.ok(t && t.mask, 'coastal tile has cells');
  assert.equal(t.z, 14); assert.equal(t.x, T.x);
  assert.ok(f.calls.every((c) => c.init.headers['User-Agent'] === UA));
  assert.ok(f.calls.some((c) => c.url.includes('/planet/A/14/')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'world', 'pin.json'), 'utf8')).ofm, 'A');
  assert.ok(fs.existsSync(path.join(dataDir, 'world', 'tiles', 'f1', '14', String(T.x), `${T.y}.slwt.gz`)));
  const n = f.calls.length;
  assert.equal(await wt.request(T.z, T.x, T.y), t, 'memory hit');
  assert.equal(f.calls.length, n);
  assert.equal(wt.get(T.z, T.x, T.y), t);
  assert.ok(decodeTile(zlib.gunzipSync(wt.buffer(T.z, T.x, T.y))).contentHash === t.contentHash);
  assert.equal(await wt.request(13, 1, 1), null, 'only z11 / z14');
  assert.equal(await wt.request(14, -1, 0), null);
  wt.close();
});

test('priority order: with one build slot, P1 work goes before P4 work queued earlier (nearest first within a priority)', async () => {
  const gate = deferred();
  const f = fakeFetch((url) => (url.includes(`/14/${T.x}/${T.y}.pbf`) ? gate.promise.then(() => res(200, MVT.coast)) : null));
  const { wt } = service(f, { fetchConc: 1 });
  const first = wt.request(14, T.x, T.y, PRIO.P0);
  await new Promise((r) => setTimeout(r, 20));
  const p4 = wt.request(14, T.x + 1, T.y, PRIO.P4);
  const p1far = wt.request(14, T.x + 2, T.y, PRIO.P1, { d: 900 });
  const p1near = wt.request(14, T.x + 3, T.y, PRIO.P1, { d: 100 });
  gate.resolve();
  await Promise.all([first, p4, p1far, p1near]);
  assert.deepEqual(f.tiles(), [`14/${T.x}/${T.y}`, `14/${T.x + 3}/${T.y}`, `14/${T.x + 2}/${T.y}`, `14/${T.x + 1}/${T.y}`]);
  wt.close();
});

test('one upstream fetch is shared by 10 concurrent requests for the same tile', async () => {
  const f = fakeFetch();
  const { wt } = service(f);
  const all = await Promise.all(Array.from({ length: 10 }, () => wt.request(14, T.x, T.y, PRIO.P2)));
  assert.ok(all.every((t) => t === all[0] && t));
  assert.equal(f.tiles().length, 1);
  wt.close();
});

test('hierarchical skip: a uniform C11 parent makes its D14 children uniform without fetching them', async () => {
  const f = fakeFetch((url) => (url.includes('/planet/A/11/') ? res(200, MVT.ocean) : null));
  const { wt } = service(f);
  const parent = await wt.request(11, T.x >> 3, T.y >> 3, PRIO.P1);
  assert.ok(parent.flags & WT.FLAG.UNIFORM);
  const child = await wt.request(14, T.x, T.y, PRIO.P1);
  assert.ok(child.flags & WT.FLAG.UNIFORM);
  assert.equal(child.uniformH, parent.uniformH);
  assert.deepEqual(f.tiles(), [`11/${T.x >> 3}/${T.y >> 3}`]);
  assert.equal(wt.stats().uniformSkips, 1);
  wt.close();
});

test('HTTP answers: 200 gzip + ETag, 304 on If-None-Match, 503 + Retry-After after the wait, 404 X-WT fallback, 400', async () => {
  const hang = deferred();
  const f = fakeFetch((url) => (url.includes(`/14/${T.x + 5}/`) ? hang.promise.then(() => res(200, MVT.coast)) : url.includes(`/14/${T.x + 6}/`) ? res(500, null) : null));
  const { wt } = service(f, { waitMs: 5000 });
  const ok = await wt.serveTile(14, T.x, T.y);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['Content-Encoding'], 'gzip');
  assert.equal(ok.headers['Content-Type'], 'application/octet-stream');
  assert.equal(ok.headers['Cache-Control'], 'no-cache');
  assert.match(ok.headers.ETag, /^"[0-9a-f]+-0-[0-9a-f]+"$/);
  assert.ok(decodeTile(zlib.gunzipSync(ok.body)).mask);
  assert.equal((await wt.serveTile(14, T.x, T.y, { ifNoneMatch: ok.headers.ETag })).status, 304);
  const slow = await wt.serveTile(14, T.x + 5, T.y, { wait: 50 });
  assert.equal(slow.status, 503); assert.equal(slow.headers['Retry-After'], '2');
  hang.resolve();
  await wt.request(14, T.x + 5, T.y);
  assert.equal((await wt.serveTile(14, T.x + 5, T.y)).status, 200, 'built meanwhile');
  const down = await wt.serveTile(14, T.x + 6, T.y, { wait: 5000 });
  assert.equal(down.status, 404); assert.equal(down.headers['X-WT'], 'fallback');
  assert.equal((await wt.serveTile(12, 1, 1)).status, 400);
  assert.equal((await wt.serveTile(14, 2 ** 14, 0)).status, 400);
  wt.close();
});

test('disk LRU: over the cap the least recently used tiles go, pinned harbour tiles stay', async () => {
  const f = fakeFetch();
  const { wt, dataDir } = service(f, { cacheMB: 0.02 });       // ≈ 20 KB
  const pinned = await wt.request(14, T.x, T.y, PRIO.P2, { pin: true });
  assert.ok(pinned);
  for (let k = 1; k <= 24; k++) await wt.request(14, T.x + k, T.y, PRIO.P4);
  const st = wt.stats();
  assert.ok(st.evicted > 0, 'evicted some');
  assert.ok(st.diskMB * 1048576 <= 0.02 * 1048576 * 0.95 + 1, 'under the cap');
  const file = (x) => path.join(dataDir, 'world', 'tiles', 'f1', '14', String(x), `${T.y}.slwt.gz`);
  assert.ok(fs.existsSync(file(T.x)), 'pinned tile kept');
  assert.ok(!fs.existsSync(file(T.x + 1)), 'oldest unpinned evicted');
  assert.ok(fs.existsSync(file(T.x + 24)), 'newest kept');
  wt.close();
});

test('index: flushed on close, rebuilt from a directory walk when missing; disk tiles serve without the network', async () => {
  const f = fakeFetch();
  const { wt, dataDir } = service(f);
  for (let k = 0; k < 3; k++) await wt.request(14, T.x + k, T.y, PRIO.P2);
  wt.close();
  const idx = path.join(dataDir, 'world', 'index.ndjson');
  assert.ok(fs.readFileSync(idx, 'utf8').trim().split('\n').length >= 3);
  fs.unlinkSync(idx);
  const f2 = fakeFetch(() => new Error('offline'));
  const again = service(f2, { dataDir });
  assert.equal(again.wt._index.size >= 3, true);
  const t = await again.wt.request(14, T.x + 1, T.y, PRIO.P1);
  assert.ok(t && t.mask);
  assert.equal(f2.tiles().length, 0);
  assert.ok(fs.existsSync(idx), 'index rewritten');
  again.wt.close();
});

test('circuit breaker + negative cache: failures stop hitting the source; a failed tile is not retried for 10 minutes', async () => {
  let now = 1e12;
  const f = fakeFetch((url) => (url.includes('/planet/A/') ? res(503, null) : null));
  const { wt, sources } = service(f, { src: { now: () => now, breakerThreshold: 3 } });
  assert.equal(await wt.request(14, T.x, T.y), null);
  assert.equal(await wt.request(14, T.x, T.y), null, 'negative cache');
  assert.equal(f.tiles().length, 1);
  for (let k = 1; k <= 4; k++) await wt.request(14, T.x + k, T.y);
  const n = f.tiles().length;
  assert.equal(n, 3, 'breaker opened after 3 failures');
  assert.equal(sources.sourceInfo().breaker.ofm.open, true);
  now += 61_000;
  await wt.request(14, T.x + 9, T.y);
  assert.equal(f.tiles().length, n + 1, 'half-open after the pause');
  now += 11 * 60_000;
  wt.close();
});

test('stale serving: an old-converter tile on disk keeps serving while its rebuild fails', async () => {
  const f = fakeFetch();
  const { wt, dataDir } = service(f);
  const t0 = await wt.request(14, T.x, T.y);
  wt._index.get(`t14/${T.x}/${T.y}`).cv = 0;            // built by an older converter
  wt.compactIndex(); wt.close();
  const f2 = fakeFetch((url) => (url.includes('/planet/') && url.includes('/14/') ? res(500, null) : null));
  const { wt: wt2 } = service(f2, { dataDir });
  const t = await wt2.request(14, T.x, T.y, PRIO.P1);
  assert.equal(t.contentHash, t0.contentHash, 'old tile served at once');
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(f2.tiles().length >= 1, 'lazy rebuild attempted');
  assert.equal(wt2.get(14, T.x, T.y).contentHash, t0.contentHash, 'still serving the old tile');
  wt2.close();
});

test('re-pin: the pinned version answering 404 while the TileJSON advertises a newer one moves the pin', async () => {
  let current = 'A';
  const f = fakeFetch((url) => {
    if (url === 'https://tiles.openfreemap.org/planet') return res(200, ver(current));
    if (url.includes('/planet/A/')) return res(404, null);
    return null;
  });
  const { wt, dataDir, sources } = service(f);
  await sources.ensurePin();
  current = 'B';
  const t = await wt.request(14, T.x, T.y, PRIO.P0);
  assert.ok(t && t.mask);
  assert.equal(sources.sourceInfo().pin, 'B');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'world', 'pin.json'), 'utf8')).ofm, 'B');
  assert.ok(f.calls.some((c) => c.url.includes('/planet/B/14/')));
  assert.equal(versionFromTemplate('https://tiles.openfreemap.org/planet/20261004_113936_pt/{z}/{x}/{y}.pbf'), '20261004_113936_pt');
  wt.close();
});

test('rev 0 → rev 1: the z12 overlay arriving rebuilds its loaded children and fires onSwap once per tile', async () => {
  const ll = tileFToLatLon(14, T.x + 0.4, T.y + 0.5), ll2 = tileFToLatLon(14, T.x + 0.4, T.y + 0.7);
  const overpass = { osm3s: { timestamp_osm_base: '2026-10-08T00:00:00Z' }, elements: [{ type: 'node', id: 7, lat: ll.lat, lon: ll.lon, tags: { man_made: 'lighthouse', height: '30' } }, { type: 'way', id: 8, tags: { man_made: 'breakwater' }, geometry: [{ lat: ll.lat, lon: ll.lon }, { lat: ll2.lat, lon: ll2.lon }] }] };
  const f = fakeFetch((url) => (url.includes('interpreter') ? res(200, overpass) : null));
  const { wt } = service(f);
  const t0 = await wt.request(14, T.x, T.y, PRIO.P1);
  assert.equal(t0.rev, 0);
  const swaps = [];
  wt.onSwap((ev) => swaps.push(ev));
  assert.equal(await wt.requestOverlay(T.x >> 2, T.y >> 2), true);
  assert.equal(swaps.length, 1);
  assert.deepEqual([swaps[0].key, swaps[0].rev, swaps[0].prevRev], [`14/${T.x}/${T.y}`, 1, 0]);
  const t1 = wt.get(14, T.x, T.y);
  assert.ok(t1.flags & WT.FLAG.OVERLAY);
  assert.equal(t1.vectors.lights[0].k, 'lighthouse');
  assert.ok(wt.swappedAt(ll.lat, ll.lon) > 0);
  assert.equal(await wt.requestOverlay(T.x >> 2, T.y >> 2), true);
  assert.equal(swaps.length, 1, 'no second swap for the same overlay');
  // the next request after a restart reads rev 1 from disk with the overlay applied
  assert.equal((await wt.request(14, T.x, T.y)).rev, 1);
  wt.close();
});

test('sync queries read memory only: height / mask / SDF / land penetration; ensureAround waits for the ring', async () => {
  const f = fakeFetch();
  const { wt } = service(f);
  const sea = tileFToLatLon(14, T.x + 0.25, T.y + 0.5), land = tileFToLatLon(14, T.x + 0.75, T.y + 0.5);
  assert.equal(wt.heightAt(sea.lat, sea.lon), null);
  assert.equal(wt.landPenetration(land.lat, land.lon), null);
  const r = await wt.ensureAround(sea.lat, sea.lon, 1000, PRIO.P0, { timeoutMs: 5000 });
  assert.ok(r.total >= 1 && r.ready === r.total);
  assert.ok(wt.heightAt(sea.lat, sea.lon) < -0.5);
  assert.equal(wt.maskAt(sea.lat, sea.lon), WT.MASK.WATER);
  assert.equal(wt.maskAt(land.lat, land.lon), WT.MASK.LAND);
  assert.ok(wt.sdfAt(sea.lat, sea.lon) > 300);
  assert.ok(wt.landPenetration(land.lat, land.lon) > 300);
  assert.equal(wt.landPenetration(sea.lat, sea.lon), 0);
  const edge = tileFToLatLon(14, T.x + 0.5 + 3 / 256, T.y + 0.5);      // 3 cells inland
  const pen = wt.landPenetration(edge.lat, edge.lon);
  assert.ok(pen > 5 && pen < 25, `penetration ${pen}`);
  const d = wt.debugAt(sea.lat, sea.lon);
  assert.equal(d.mask, 0); assert.equal(d.rev, 0);
  assert.equal(wt.meta().zDetail, 14); assert.match(wt.meta().attribution, /OpenStreetMap/);
  wt.close();
});

test('offline (SALTLINE_WT_OFFLINE / tests): no upstream request ever, nothing built', async () => {
  const f = fakeFetch();
  const dataDir = tmpDir();
  const wt = createWorldTiles({ dataDir, log: silent, sources: createSources({ fetchImpl: f, dataDir, log: silent }), converter: inlineConverter() });
  assert.equal(wt.offline, true);
  assert.equal(await wt.request(14, T.x, T.y, PRIO.P0), null);
  assert.equal((await wt.serveTile(14, T.x, T.y, { wait: 20 })).status, 404);
  assert.equal(f.calls.length, 0);
  wt.close();
});

test('the converter worker thread converts a tile like the inline converter', async () => {
  const w = workerConverter({ log: silent });
  const job = { z: 14, x: T.x, y: T.y, mvt: MVT.coast, overlay: null, bathy: null, hints: { src: 'ofm:A', builtAt: 0 } };
  const a = await w.convert(job), b = await inlineConverter().convert(job);
  w.close();
  assert.ok(a && b);
  assert.deepEqual(Buffer.from(a.raw), Buffer.from(b.raw));
});

test('sources: Terrarium PNG decoding, compact overlays, converter hints', () => {
  // a 256² RGB PNG, filter 0 rows, R=127 G=0 B=0 → 127·256 − 32768 = −256 m
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(256 * 3)]);
  for (let i = 0; i < 256; i++) row[1 + i * 3] = 127;
  const raw = Buffer.concat(Array.from({ length: 256 }, () => row));
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); return Buffer.concat([len, Buffer.from(type), data, Buffer.alloc(4)]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(256, 0); ihdr.writeUInt32BE(256, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  const dm = decodeTerrarium(png);
  assert.equal(dm.length, 65536); assert.equal(dm[0], -2560); assert.equal(dm[65535], -2560);
  assert.equal(decodeTerrarium(Buffer.from('nope')), null);
  const ov = compactOverlay({ elements: [{ type: 'way', id: 2, tags: { man_made: 'quay', name: 'Kade', fixme: 'x' }, geometry: [{ lat: 1, lon: 2 }, { lat: 1.1, lon: 2.2 }] }, { type: 'node', id: 1, lat: 1, lon: 2, tags: { highway: 'x' } }] }, 3, 4, '2026-10-08');
  // v2: the waterways overlay (bridges, locks, CEMT fairways, harbour tags); v1 only with SALTLINE_WW_OFF=1
  assert.deepEqual(ov, { v: process.env.SALTLINE_WW_OFF === '1' ? 1 : 2, date: '2026-10-08', x: 3, y: 4, f: [{ id: 'w2', k: 'quay', t: { man_made: 'quay', name: 'Kade' }, g: [1, 2, 1.1, 2.2], c: 0 }] });
  const { fx, fy } = tileF(14, 51.968, 4.035);
  const h = hintsFor(14, Math.floor(fx), Math.floor(fy));
  assert.deepEqual([h.size, h.port, h.bigport, h.iala], ['mega', true, 'rotterdam', 'A']);
  const { fx: ox, fy: oy } = tileF(14, 45, -30);       // mid-Atlantic
  const o = hintsFor(14, Math.floor(ox), Math.floor(oy));
  assert.deepEqual([o.size, o.port, o.bigport], [null, false, null]);
});

test('prefetch rings (wtprefetch.js): P1 around and ahead of online ships, P2 routes / harbours (pinned + overlay), P3 offline ships, P4 only when idle', async () => {
  const { startPrefetch } = await import('../server/wtprefetch.js');
  const asked = [], overlays = [];
  let queued = 0, healthy = true;
  const wt = {
    request: (z, x, y, prio, o) => { asked.push({ z, x, y, prio, ...o }); return Promise.resolve(z === 11 ? { flags: 0 } : null); },
    requestOverlay: (x, y) => { overlays.push(`${x}/${y}`); return Promise.resolve(true); },
    queued: () => queued, healthy: () => healthy, sources: { sourceInfo: () => ({ today: { ofm: 0 } }) },
  };
  const harbor = { id: 'h', lat: 51.98, lon: 4.03, size: 'mega' };
  const game = { byId: new Map([
    ['on', { id: 'on', online: true, ship: { lat: 51.9, lon: 3.6, cls: 'coaster', spd: 12, hdg: 90 } }],
    ['off', { id: 'off', online: false, ship: { lat: 50, lon: -10, cls: 'coaster', spd: 0 } }],
  ]), fleet: { vessels: new Map([['v1', { id: 'v1', ship: { lat: 51.95, lon: 3.9, cls: 'tug', spd: 8, hdg: 0 }, voyage: { route: [[52.2, 3.9], [52.6, 4.2]], i: 0 } }]]) } };
  const pf = startPrefetch({ game, wt, harbors: [harbor], timers: false, loadavg: () => 0 });
  queued = 1;
  pf.tick();
  const at = (prio, z = 14) => asked.filter((a) => a.prio === prio && a.z === z);
  const { fx, fy } = tileF(14, 51.9, 3.6);
  assert.ok(at(PRIO.P1).some((a) => a.x === Math.floor(fx) && a.y === Math.floor(fy)), 'own tile at P1');
  const cone = at(PRIO.P1).filter((a) => a.x > Math.floor(fx) + 2);
  assert.ok(cone.length > 0 && cone.every((a) => a.d >= 1000), 'heading cone east at P1, nearest first by distance along');
  assert.ok(at(PRIO.P1, 11).length > 0, 'C11 ring');
  const route = at(PRIO.P2).filter((a) => !a.pin);
  assert.ok(route.some((a) => tileFToLatLon(14, a.x + 0.5, a.y + 0.5).lat > 51.99), 'hired captain route at P2 (the next 30 min ≈ 7 km)');
  assert.ok(route.every((a) => tileFToLatLon(14, a.x + 0.5, a.y + 0.5).lat < 52.05), 'not beyond 30 min of sailing');
  const ring = at(PRIO.P2).filter((a) => a.pin);
  assert.ok(ring.length >= 9, 'harbour core pinned at P2');
  assert.ok(overlays.length >= 1, 'harbour overlays requested');
  const { fx: ox, fy: oy } = tileF(14, 50, -10);
  assert.ok(at(PRIO.P3).some((a) => a.x === Math.floor(ox) && a.y === Math.floor(oy)), 'offline ship at P3');
  assert.equal(at(PRIO.P4).length + at(PRIO.P4, 11).length, 0, 'no warm-up while work is queued');
  const n = asked.length;
  pf.tick();
  assert.equal(asked.length, n, 'rings are not re-queued within 60 s');
  queued = 0;
  pf.tick();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(at(PRIO.P4, 11).length, 9, 'warm-up: C11 3×3 around the harbour');
  assert.ok(at(PRIO.P4).length > 0 && at(PRIO.P4).every((a) => a.pin), 'then D14 children of mixed C11 tiles, pinned');
  pf.stop();
});
