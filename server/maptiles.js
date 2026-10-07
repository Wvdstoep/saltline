// Map tile proxy (docs/V4-CONTRACTS.md §4): OpenStreetMap raster tiles and OpenSeaMap seamark overlays for the chart
// and the street-level terrain drape, fetched by the SERVER once and shared by every player.
//
//   memory LRU (500 tiles) → disk cache data/tiles/<layer>/<z>/<x>/<y>.png (30 days) → upstream
//
// Upstream politeness (OSM tile usage policy): a descriptive User-Agent, at most 2 requests in flight, every tile
// fetched at most once per 30 days, failures remembered for 10 minutes (negative cache), and a circuit breaker that
// stops talking to a server for a minute after a run of network errors / 429 / 5xx answers. A stale disk copy is served
// when the upstream cannot be reached. OpenSeaMap answers 404 for the (many) tiles without seamarks: those become a
// transparent 1×1 PNG, cached like a real tile. Zoom 2..18, integer coordinates only. `getTile` never throws: any
// failure resolves to null (the route answers 404). SALTLINE_OFFLINE=1 disables the upstream (disk/memory still serve).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DATA_DIR } from './world.js';

export const USER_AGENT = 'Saltline/0.4 (+https://github.com/Wvdstoep/saltline)';
export const TILE_LAYERS = {
  osm: { url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`, transparent404: false },
  seamark: { url: (z, x, y) => `https://tiles.openseamap.org/seamark/${z}/${x}/${y}.png`, transparent404: true },
};
export const Z_MIN = 2, Z_MAX = 18;
const DAY_MS = 24 * 3600e3;
const MAX_BYTES = 2 * 1024 * 1024;

// ------------------------------------------------------------------------------------------------ PNG helpers
const CRC = new Int32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c; }
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
/** A valid 1×1 RGBA PNG whose only pixel is fully transparent. */
export const TRANSPARENT_PNG = (() => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.from([0, 0, 0, 0, 0]); // filter byte + RGBA(0,0,0,0)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
})();

/** Image type from the magic bytes (png / jpeg / webp), or null when the body is not an image. */
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Validated integer tile coordinates or null. Accepts numbers or digit-only strings. */
export function parseTileArgs(layer, z, x, y) {
  if (typeof layer !== 'string' || !Object.prototype.hasOwnProperty.call(TILE_LAYERS, layer)) return null;
  const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,7}$/.test(v) ? Number(v) : NaN);
  const Z = num(z), X = num(x), Y = num(y);
  if (![Z, X, Y].every(Number.isInteger)) return null;
  if (Z < Z_MIN || Z > Z_MAX) return null;
  const max = 2 ** Z;
  if (X < 0 || Y < 0 || X >= max || Y >= max) return null;
  return { layer, z: Z, x: X, y: Y };
}

// ------------------------------------------------------------------------------------------------ service
/**
 * A tile service instance. Options (all optional):
 *  fetchImpl (globalThis.fetch), cacheDir (data/tiles; null disables the disk cache), lruSize 500, maxConcurrent 2,
 *  ttlMs 30 days, negativeTtlMs 10 min, timeoutMs 10 s, maxQueue 400, breakerThreshold 4, breakerMs 60 s,
 *  offline (SALTLINE_OFFLINE=1), now (Date.now), log (console, rate-limited).
 */
export function createTileService(opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const cacheDir = opts.cacheDir === undefined ? path.join(DATA_DIR, 'tiles') : opts.cacheDir;
  const lruSize = Math.max(1, opts.lruSize ?? 500);
  const maxConcurrent = Math.max(1, opts.maxConcurrent ?? 2);
  const ttlMs = opts.ttlMs ?? 30 * DAY_MS;
  const negativeTtlMs = opts.negativeTtlMs ?? 10 * 60e3;
  const timeoutMs = opts.timeoutMs ?? 10000;
  const maxQueue = opts.maxQueue ?? 400;
  const breakerThreshold = opts.breakerThreshold ?? 4;
  const breakerMs = opts.breakerMs ?? 60e3;
  const offline = opts.offline ?? process.env.SALTLINE_OFFLINE === '1';
  const now = opts.now || Date.now;
  const log = opts.log || ((...a) => console.log(new Date().toISOString(), '[maptiles]', ...a));

  const lru = new Map();        // key -> { buf, type, at }
  const negative = new Map();   // key -> expiry (ms)
  const inflight = new Map();   // key -> Promise<{buf,type}|null>
  const waiters = [];           // resolve functions waiting for an upstream slot
  let active = 0;
  const breaker = new Map();    // layer -> { fails, openUntil }
  const writes = new Set();     // pending disk writes (never awaited by a request: a slow disk must not delay tiles)
  const diskTimeoutMs = opts.diskTimeoutMs ?? 3000;
  const st = { hits: 0, diskHits: 0, misses: 0, upstream: 0, upstreamOk: 0, failures: 0, stale: 0, dropped: 0 };

  const keyOf = (a) => `${a.layer}/${a.z}/${a.x}/${a.y}`;
  const fileOf = (a) => (cacheDir ? path.join(cacheDir, a.layer, String(a.z), String(a.x), `${a.y}.png`) : null);

  function remember(key, val) {
    lru.delete(key); lru.set(key, val);
    while (lru.size > lruSize) lru.delete(lru.keys().next().value);
  }
  function fromMemory(key) {
    const v = lru.get(key);
    if (!v) return null;
    if (now() - v.at > ttlMs) { lru.delete(key); return null; }
    lru.delete(key); lru.set(key, v); // most recently used last
    return v;
  }
  function negativeHit(key) {
    const until = negative.get(key);
    if (until == null) return false;
    if (now() < until) return true;
    negative.delete(key);
    return false;
  }
  function setNegative(key) {
    negative.set(key, now() + negativeTtlMs);
    if (negative.size > 20000) { const t = now(); for (const [k, u] of negative) if (u <= t) negative.delete(k); }
  }

  /** resolves to `fallback` when `p` takes longer than `ms` (a hung network filesystem must not hang the route) */
  function withTimeout(p, ms, fallback) {
    let t; const timer = new Promise((res) => { t = setTimeout(() => res(fallback), ms); t.unref?.(); });
    return Promise.race([p, timer]).finally(() => clearTimeout(t));
  }
  function readDisk(a) { return withTimeout(readDiskNow(a), diskTimeoutMs, null); }
  async function readDiskNow(a) {
    const file = fileOf(a); if (!file) return null;
    try {
      const s = await fs.promises.stat(file);
      if (!s.isFile() || s.size === 0 || s.size > MAX_BYTES) return null;
      const buf = await fs.promises.readFile(file);
      const type = sniffImage(buf);
      if (!type) return null;
      return { buf, type, at: s.mtimeMs, fresh: now() - s.mtimeMs <= ttlMs };
    } catch { return null; }
  }
  function writeDisk(a, buf) {
    if (!fileOf(a)) return;
    const w = writeDiskNow(a, buf).finally(() => writes.delete(w));
    writes.add(w);
  }
  async function writeDiskNow(a, buf) {
    const file = fileOf(a); if (!file) return;
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(tmp, buf);
      await fs.promises.rename(tmp, file);
    } catch { try { await fs.promises.unlink(tmp); } catch { /* nothing to clean */ } }
  }

  // ---- upstream slots (FIFO) and circuit breaker
  function acquire() {
    if (active < maxConcurrent) { active++; return Promise.resolve(true); }
    if (waiters.length >= maxQueue) return Promise.resolve(false);
    return new Promise((res) => waiters.push(res));
  }
  function release() {
    const next = waiters.shift();
    if (next) next(true); else active--;
  }
  function breakerOpen(layer) { const b = breaker.get(layer); return !!b && b.openUntil > now(); }
  function breakerResult(layer, ok) {
    let b = breaker.get(layer); if (!b) { b = { fails: 0, openUntil: 0, logged: 0 }; breaker.set(layer, b); }
    if (ok) { b.fails = 0; return; }
    b.fails++;
    if (b.fails >= breakerThreshold && b.openUntil <= now()) {
      b.openUntil = now() + breakerMs;
      if (now() - b.logged > 10 * 60e3) { b.logged = now(); try { log(`${layer} upstream unreachable — pausing requests for ${Math.round(breakerMs / 1000)} s`); } catch { /* logging must never break a tile */ } }
    }
  }

  /** One upstream request. Resolves to { buf, type } (a real tile), { empty: true } (seamark 404 → transparent) or null. */
  async function fetchUpstream(a) {
    const L = TILE_LAYERS[a.layer];
    if (offline || typeof fetchImpl !== 'function' || breakerOpen(a.layer)) return null;
    if (!(await acquire())) { st.dropped++; return null; }
    try {
      if (breakerOpen(a.layer)) return null; // the breaker may have opened while we queued
      st.upstream++;
      let res;
      try {
        const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
        res = await fetchImpl(L.url(a.z, a.x, a.y), { headers: { 'User-Agent': USER_AGENT, Accept: 'image/png,image/*;q=0.8' }, signal, redirect: 'follow' });
      } catch { breakerResult(a.layer, false); return null; }
      const status = Number(res?.status) || 0;
      if (status === 404 || status === 410) {
        breakerResult(a.layer, true);
        try { await res.arrayBuffer?.(); } catch { /* drain */ }
        return L.transparent404 ? { empty: true } : null;
      }
      if (status === 429 || status >= 500 || status === 403 || status === 0) { breakerResult(a.layer, false); return null; }
      if (status < 200 || status >= 300) { breakerResult(a.layer, true); return null; }
      let buf;
      try { buf = Buffer.from(await res.arrayBuffer()); } catch { breakerResult(a.layer, false); return null; }
      breakerResult(a.layer, true);
      if (buf.length === 0 || buf.length > MAX_BYTES) return null;
      const type = sniffImage(buf);
      if (!type) return null;
      st.upstreamOk++;
      return { buf, type };
    } finally { release(); }
  }

  async function resolveTile(a, key) {
    const disk = await readDisk(a);
    if (disk && disk.fresh) { st.diskHits++; const v = { buf: disk.buf, type: disk.type, at: now() }; remember(key, v); return { buf: v.buf, type: v.type }; }
    if (negativeHit(key)) { if (disk) { st.stale++; return { buf: disk.buf, type: disk.type }; } return null; }
    st.misses++;
    const up = await fetchUpstream(a);
    if (up && (up.buf || up.empty)) {
      const buf = up.empty ? TRANSPARENT_PNG : up.buf, type = up.empty ? 'image/png' : up.type;
      remember(key, { buf, type, at: now() });
      negative.delete(key);
      writeDisk(a, buf);
      return { buf, type };
    }
    st.failures++;
    setNegative(key);
    if (disk) { st.stale++; remember(key, { buf: disk.buf, type: disk.type, at: now() - ttlMs + negativeTtlMs }); return { buf: disk.buf, type: disk.type }; }
    return null;
  }

  async function getTile(layer, z, x, y) {
    try {
      const a = parseTileArgs(layer, z, x, y);
      if (!a) return null;
      const key = keyOf(a);
      const mem = fromMemory(key);
      if (mem) { st.hits++; return { buf: mem.buf, type: mem.type }; }
      let p = inflight.get(key);
      if (!p) {
        p = resolveTile(a, key).catch(() => null).finally(() => inflight.delete(key));
        inflight.set(key, p);
      }
      return await p;
    } catch { return null; }
  }

  return {
    getTile,
    stats: () => ({ ...st, memory: lru.size, negative: negative.size, inflight: inflight.size, active, queued: waiters.length, breaker: Object.fromEntries([...breaker].map(([k, b]) => [k, { fails: b.fails, open: b.openUntil > now() }])) }),
    clear: () => { lru.clear(); negative.clear(); breaker.clear(); },
    /** resolves when every pending disk write has finished (tests, graceful shutdown) */
    flush: async () => { while (writes.size) await Promise.allSettled([...writes]); },
  };
}

let service = null;
function defaultService() { if (!service) service = createTileService(); return service; }

/** Contract entry point used by server.js: `{ buf, type }` or null. Never throws. */
export async function getTile(layer, z, x, y) {
  try { return await defaultService().getTile(layer, z, x, y); } catch { return null; }
}
/** Counters of the default service (cache hits, upstream requests, failures, breaker state). */
export function tileStats() { return defaultService().stats(); }
