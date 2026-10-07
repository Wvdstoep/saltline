// Map tile proxy (server/maptiles.js): validation, caches (memory LRU, disk with TTL, negative), politeness
// (User-Agent, ≤ 2 upstream requests in flight, circuit breaker), seamark 404 → transparent PNG, never throws.
// Every test runs against a mocked fetch and a temporary cache directory — no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createTileService, getTile, parseTileArgs, sniffImage, TRANSPARENT_PNG, USER_AGENT, TILE_LAYERS } from '../server/maptiles.js';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** a fake but sniffable PNG body, unique per tile */
const fakePng = (tag) => Buffer.concat([PNG_SIG, Buffer.from(`fake-tile:${tag}:` + 'x'.repeat(16))]);
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'saltline-tiles-'));
const silent = () => {};

function response(status, body, type = 'image/png') {
  return { status, ok: status >= 200 && status < 300, headers: new Map([['content-type', type]]), arrayBuffer: async () => { const b = Buffer.from(body ?? ''); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } };
}
/** fetch mock: answers a PNG unique to the URL unless `plan(url)` returns something else */
function mockFetch(plan = () => null) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = await plan(url, init, calls.length);
    if (r instanceof Error) throw r;
    return r || response(200, fakePng(url));
  };
  fn.calls = calls;
  return fn;
}
function clock(t0 = 1_800_000_000_000) { const c = { t: t0, now: () => c.t, advance: (ms) => { c.t += ms; } }; return c; }

test('argument validation: layers, integer coordinates, zoom 2..18, range 0..2^z-1', async () => {
  const f = mockFetch();
  const svc = createTileService({ fetchImpl: f, cacheDir: null, log: silent });
  const bad = [['wms', 5, 1, 1], ['osm', 1, 0, 0], ['osm', 19, 0, 0], ['osm', 5, 32, 0], ['osm', 5, 0, 32], ['osm', 5, -1, 0], ['osm', 5.5, 1, 1], ['osm', 5, 1.2, 1], ['osm', '5', 'a', '1'], ['osm', NaN, 1, 1], [null, 5, 1, 1], ['__proto__', 5, 1, 1], ['osm', '5e1', 1, 1]];
  for (const args of bad) assert.equal(await svc.getTile(...args), null, `rejects ${JSON.stringify(args)}`);
  assert.equal(f.calls.length, 0, 'invalid requests never reach the upstream');
  assert.deepEqual(parseTileArgs('osm', '12', '2100', '1350'), { layer: 'osm', z: 12, x: 2100, y: 1350 });
  assert.deepEqual(parseTileArgs('seamark', 2, 3, 3), { layer: 'seamark', z: 2, x: 3, y: 3 });
  assert.equal(parseTileArgs('osm', 18, 2 ** 18, 0), null);
  // the module-level entry point validates before doing anything else and never throws
  assert.equal(await getTile('nope', 3, 1, 1), null);
  assert.equal(await getTile('osm', 30, 1, 1), null);
});

test('fetches from the right upstream with the Saltline User-Agent and caches in memory', async () => {
  const f = mockFetch();
  const svc = createTileService({ fetchImpl: f, cacheDir: null, log: silent });
  const t = await svc.getTile('osm', 16, 33500, 21700);
  assert.ok(t && Buffer.isBuffer(t.buf));
  assert.equal(t.type, 'image/png');
  assert.equal(f.calls[0].url, 'https://tile.openstreetmap.org/16/33500/21700.png');
  assert.equal(f.calls[0].init.headers['User-Agent'], USER_AGENT);
  assert.match(USER_AGENT, /^Saltline\/0\.4 \(\+https:\/\/github\.com\/Wvdstoep\/saltline\)$/);
  const again = await svc.getTile('osm', 16, 33500, 21700);
  assert.equal(again.buf.toString(), t.buf.toString());
  assert.equal(f.calls.length, 1, 'second request is a memory hit');
  await svc.getTile('seamark', 12, 2100, 1350);
  assert.equal(f.calls[1].url, 'https://tiles.openseamap.org/seamark/12/2100/1350.png');
  assert.equal(TILE_LAYERS.osm.url(2, 1, 1), 'https://tile.openstreetmap.org/2/1/1.png');
  assert.equal(svc.stats().hits, 1);
});

test('concurrent requests for the same tile share one upstream request', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const f = mockFetch(async () => { await gate; return null; });
  const svc = createTileService({ fetchImpl: f, cacheDir: null, log: silent });
  const ps = [svc.getTile('osm', 10, 500, 300), svc.getTile('osm', 10, 500, 300), svc.getTile('osm', 10, 500, 300)];
  await new Promise((r) => setTimeout(r, 10));
  release();
  const out = await Promise.all(ps);
  assert.equal(f.calls.length, 1);
  assert.ok(out.every((t) => t && t.buf.equals(out[0].buf)));
});

test('never more than 2 upstream requests in flight; the rest queue in order', async () => {
  let inFlight = 0, peak = 0;
  const f = mockFetch(async () => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 15)); inFlight--; return null; });
  const svc = createTileService({ fetchImpl: f, cacheDir: null, log: silent });
  const ps = [];
  for (let i = 0; i < 9; i++) ps.push(svc.getTile('osm', 14, 8000 + i, 5000));
  const out = await Promise.all(ps);
  assert.equal(peak, 2);
  assert.equal(f.calls.length, 9);
  assert.ok(out.every((t) => t && t.type === 'image/png'));
  assert.equal(f.calls[0].url, 'https://tile.openstreetmap.org/14/8000/5000.png');
  assert.equal(f.calls[8].url, 'https://tile.openstreetmap.org/14/8008/5000.png');
});

test('disk cache: data/tiles/<layer>/<z>/<x>/<y>.png survives a restart and expires after 30 days', async () => {
  const dir = tmpDir(), c = clock(Date.now());
  try {
    const f1 = mockFetch();
    const a = createTileService({ fetchImpl: f1, cacheDir: dir, now: c.now, log: silent });
    const t1 = await a.getTile('osm', 15, 16800, 10800);
    await a.flush();
    const file = path.join(dir, 'osm', '15', '16800', '10800.png');
    assert.ok(fs.existsSync(file), 'tile written to the cache path');
    assert.ok(fs.readFileSync(file).equals(t1.buf));
    // a fresh service (server restart) answers from disk without the network
    const f2 = mockFetch(() => new Error('offline'));
    const b = createTileService({ fetchImpl: f2, cacheDir: dir, now: c.now, log: silent });
    const t2 = await b.getTile('osm', 15, 16800, 10800);
    assert.ok(t2.buf.equals(t1.buf));
    assert.equal(f2.calls.length, 0);
    // 31 days later the copy is stale → refetched and rewritten
    const later = clock(Date.now() + 31 * 24 * 3600e3);
    const f3 = mockFetch(() => response(200, fakePng('fresh')));
    const d = createTileService({ fetchImpl: f3, cacheDir: dir, now: later.now, log: silent });
    const t3 = await d.getTile('osm', 15, 16800, 10800);
    await d.flush();
    assert.equal(f3.calls.length, 1);
    assert.ok(t3.buf.equals(fakePng('fresh')));
    assert.ok(fs.readFileSync(file).equals(fakePng('fresh')));
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp')), [], 'no temp files left behind');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a stale disk copy is served when the upstream fails', async () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'osm', '12', '2000', '1300.png');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, fakePng('old'));
    const old = new Date(Date.now() - 40 * 24 * 3600e3); fs.utimesSync(file, old, old);
    const f = mockFetch(() => new Error('ECONNRESET'));
    const svc = createTileService({ fetchImpl: f, cacheDir: dir, log: silent });
    const t = await svc.getTile('osm', 12, 2000, 1300);
    assert.ok(t && t.buf.equals(fakePng('old')));
    assert.equal(f.calls.length, 1, 'the refresh was attempted');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('negative cache: a failed tile is not requested again for 10 minutes', async () => {
  const c = clock();
  const f = mockFetch(() => response(500, 'oops', 'text/plain'));
  const svc = createTileService({ fetchImpl: f, cacheDir: null, now: c.now, breakerThreshold: 99, log: silent });
  assert.equal(await svc.getTile('osm', 9, 260, 170), null);
  assert.equal(await svc.getTile('osm', 9, 260, 170), null);
  assert.equal(f.calls.length, 1);
  c.advance(9 * 60e3);
  assert.equal(await svc.getTile('osm', 9, 260, 170), null);
  assert.equal(f.calls.length, 1, 'still negative after 9 minutes');
  c.advance(2 * 60e3);
  await svc.getTile('osm', 9, 260, 170);
  assert.equal(f.calls.length, 2, 'retried after 10 minutes');
});

test('seamark 404 → transparent 1×1 PNG (cached); osm 404 → null', async () => {
  const dir = tmpDir();
  try {
    const f = mockFetch(() => response(404, 'Not Found', 'text/html'));
    const svc = createTileService({ fetchImpl: f, cacheDir: dir, log: silent });
    const s = await svc.getTile('seamark', 13, 4200, 2700);
    assert.ok(s, 'seamark 404 answers a tile');
    assert.equal(s.type, 'image/png');
    assert.ok(s.buf.equals(TRANSPARENT_PNG));
    await svc.flush();
    // decode: IHDR 1×1 RGBA, the single pixel has alpha 0
    assert.ok(s.buf.subarray(0, 8).equals(PNG_SIG));
    assert.equal(s.buf.readUInt32BE(16), 1); assert.equal(s.buf.readUInt32BE(20), 1); assert.equal(s.buf[25], 6);
    const idatLen = s.buf.readUInt32BE(33);
    assert.equal(s.buf.toString('ascii', 37, 41), 'IDAT');
    const raw = zlib.inflateSync(s.buf.subarray(41, 41 + idatLen));
    assert.deepEqual([...raw], [0, 0, 0, 0, 0]);
    assert.ok(fs.existsSync(path.join(dir, 'seamark', '13', '4200', '2700.png')), 'empty seamark tiles are cached too');
    await svc.getTile('seamark', 13, 4200, 2700);
    assert.equal(f.calls.length, 1);
    assert.equal(await svc.getTile('osm', 13, 4200, 2700), null, 'a missing OSM tile is a 404 for the client');
    assert.equal(sniffImage(TRANSPARENT_PNG), 'image/png');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bodies that are not images are rejected; thrown errors and odd responses never escape', async () => {
  const f1 = mockFetch(() => response(200, '<html>blocked</html>', 'text/html'));
  const s1 = createTileService({ fetchImpl: f1, cacheDir: null, log: silent });
  assert.equal(await s1.getTile('osm', 8, 130, 80), null);
  const f2 = mockFetch(() => new TypeError('fetch failed'));
  const s2 = createTileService({ fetchImpl: f2, cacheDir: null, log: silent });
  assert.equal(await s2.getTile('osm', 8, 131, 80), null);
  const f3 = mockFetch(() => ({ status: 200, arrayBuffer: async () => { throw new Error('socket hang up'); } }));
  const s3 = createTileService({ fetchImpl: f3, cacheDir: null, log: silent });
  assert.equal(await s3.getTile('osm', 8, 132, 80), null);
  const s4 = createTileService({ fetchImpl: () => { throw new Error('sync throw'); }, cacheDir: null, log: silent });
  assert.equal(await s4.getTile('osm', 8, 133, 80), null);
  const dir = tmpDir(), blocker = path.join(dir, 'a-file');
  fs.writeFileSync(blocker, 'not a directory');
  try {
    const s5 = createTileService({ fetchImpl: mockFetch(() => undefined), cacheDir: path.join(blocker, 'tiles'), log: silent });
    const t5 = await s5.getTile('osm', 8, 134, 80);
    await s5.flush();
    assert.ok(t5 && t5.type === 'image/png', 'an unwritable cache directory does not break serving');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg');
  assert.equal(sniffImage(Buffer.from('hello world!')), null);
});

test('in-memory LRU keeps at most lruSize tiles and evicts the least recently used', async () => {
  const f = mockFetch();
  const svc = createTileService({ fetchImpl: f, cacheDir: null, lruSize: 3, log: silent });
  for (const x of [1, 2, 3]) await svc.getTile('osm', 6, x, 1);
  await svc.getTile('osm', 6, 1, 1);          // touch 1 → 2 is now the oldest
  await svc.getTile('osm', 6, 4, 1);          // evicts 2
  assert.equal(svc.stats().memory, 3);
  const before = f.calls.length;
  await svc.getTile('osm', 6, 1, 1); await svc.getTile('osm', 6, 3, 1); await svc.getTile('osm', 6, 4, 1);
  assert.equal(f.calls.length, before, '1, 3, 4 are still cached');
  await svc.getTile('osm', 6, 2, 1);
  assert.equal(f.calls.length, before + 1, '2 was evicted and is fetched again');
});

test('circuit breaker: after repeated network failures the upstream is left alone for a while', async () => {
  const c = clock();
  const f = mockFetch(() => new Error('ENOTFOUND tile.openstreetmap.org'));
  const svc = createTileService({ fetchImpl: f, cacheDir: null, now: c.now, breakerThreshold: 3, breakerMs: 60e3, log: silent });
  for (let i = 0; i < 3; i++) assert.equal(await svc.getTile('osm', 11, 1000 + i, 600), null);
  assert.equal(f.calls.length, 3);
  for (let i = 0; i < 5; i++) assert.equal(await svc.getTile('osm', 11, 1100 + i, 600), null);
  assert.equal(f.calls.length, 3, 'breaker open: no upstream traffic');
  assert.equal(svc.stats().breaker.osm.open, true);
  // the seamark server is a different host with its own breaker
  await svc.getTile('seamark', 11, 1000, 600);
  assert.equal(f.calls.length, 4);
  c.advance(61e3);
  await svc.getTile('osm', 11, 1200, 600);
  assert.equal(f.calls.length, 5, 'half-open after the pause');
});

test('offline mode and a full queue degrade to null without touching the network', async () => {
  const f = mockFetch();
  const off = createTileService({ fetchImpl: f, cacheDir: null, offline: true, log: silent });
  assert.equal(await off.getTile('osm', 12, 2100, 1350), null);
  assert.equal(f.calls.length, 0);
  let release; const gate = new Promise((r) => { release = r; });
  const slow = mockFetch(async () => { await gate; return null; });
  const svc = createTileService({ fetchImpl: slow, cacheDir: null, maxConcurrent: 1, maxQueue: 1, log: silent });
  const p1 = svc.getTile('osm', 12, 1, 1), p2 = svc.getTile('osm', 12, 2, 1), p3 = svc.getTile('osm', 12, 3, 1);
  assert.equal(await p3, null, 'beyond the queue limit the request is dropped');
  release();
  assert.ok(await p1); assert.ok(await p2);
  assert.equal(svc.stats().dropped, 1);
});

test('request timeout aborts a hung upstream request', async () => {
  const f = mockFetch((url, init) => new Promise((resolve, reject) => { init.signal?.addEventListener('abort', () => reject(new Error('aborted'))); }));
  const svc = createTileService({ fetchImpl: f, cacheDir: null, timeoutMs: 30, log: silent });
  const t0 = Date.now();
  const keepAlive = setInterval(() => {}, 1000); // the abort timer is unref'd (it must never hold a server open)
  try { assert.equal(await svc.getTile('osm', 12, 7, 7), null); } finally { clearInterval(keepAlive); }
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(svc.stats().active, 0, 'the slot was released');
});
