// World detail tiles (docs/WORLD-DETAIL-STREAMING.md §3.3, §3.5, §4): D14 (z14, ≈ 6–10 m cells + vectors) and C11
// (z11, coast) tiles built from OpenFreeMap by server/wtconvert.js, shared by every player.
//
//   request(z,x,y,prio) ─► memory LRU ─► disk data/world/tiles/f1/<z>/<x>/<y>.slwt.gz ─► build queue (priority, nearest)
//        build: wtsource.fetchBase (+ Terrarium z9 bathy, + cached z12 overlay) → worker (wtconvert-thread.js) → disk
//        (tmp + rename) → memory → waiters, onSwap listeners
//
// Sync queries (heightAt / maskAt / sdfAt / landPenetration) read memory only and return null when the tile is not
// loaded: physics falls through to the coarse layers (server/worldstack.js), it never waits for the network. Nothing
// here throws to callers. SALTLINE_WT_OFFLINE=1 (or NODE_TEST_CONTEXT) keeps the upstreams off; whatever is on disk
// keeps serving.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Worker } from 'node:worker_threads';
import { DATA_DIR } from './paths.js';
import { WT, WT_OBSTACLE, decodeTile, tileKey, tileFToLatLon, tileSizeM, tilesInRadius, cellOf, tileHeightAt, tileMaskAt, encodeTile } from '../shared/wtformat.js';
import { createSources } from './wtsource.js';
import { CONVERTER_VERSION, srcHashOf, edt } from './wtconvert.js';
import { convertJob } from './wtconvert-thread.js';
import { HARBORS } from './harbors.js';
import { BIG_PORTS } from './bigports.js';
import { builtinPorts } from './ais/ports.js';
import { ialaRegion } from './osm.js';
import { haversine } from '../shared/geo.js';
import { ByteLRU } from './bytelru.js';

export const PRIO = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 };
/** Default disk cap (MB) for tiles + overlays + bathy; SALTLINE_WT_CACHE_MB overrides. */
export const DEFAULT_CACHE_MB = 600;
/** Decoded-tile memory budget (MB): SALTLINE_WT_MEM_MB overrides. Bathy (z9 depth) budget 8 MB. */
export const DEFAULT_MEM_MB = 64;
export const BATHY_MEM_MB = 8;
/** Build queue caps: all priorities / background (P3, P4) jobs. */
export const QUEUE_MAX = 1500, BG_QUEUE_MAX = 200;
export const ATTRIBUTION = '© OpenStreetMap contributors · OpenMapTiles · OpenFreeMap · Terrain: Mapzen/AWS (ETOPO1, GEBCO…)';
const ZS = new Set([WT.Z_DETAIL, WT.Z_COAST]);
const SWAP_GRACE_MS = 30_000;
const APRON = 16;
/** Port-area radius (km) by harbour size: tiles within it get `hints.port` (docks by context, the port water floor). */
export const PORT_RADIUS_KM = { mega: 12, major: 8, regional: 5, minor: 3 };

// ------------------------------------------------------------------------------------------------ converter hints
let portList = null;
function ports() {
  if (portList) return portList;
  const list = HARBORS.map((h) => ({ lat: h.lat, lon: h.lon, size: h.size || 'minor', r: PORT_RADIUS_KM[h.size] || 3, harbor: true }));
  try {
    for (const p of builtinPorts()) list.push({ lat: p.lat, lon: p.lon, size: p.r >= 10 ? 'major' : p.r >= 5 ? 'regional' : 'minor', r: p.r || 3, harbor: false });
  } catch { /* the gazetteer is optional */ }
  portList = list;
  return list;
}
/**
 * Converter hints of a tile (§3.4): size = the nearest game harbour within 25 km (else the gazetteer port whose in-port
 * radius covers the tile, sized by that radius), port = a port area reaches the tile, bigport = a server/bigports data
 * box overlaps it, iala = buoyage region.
 */
export function hintsFor(z, x, y, extra = {}) {
  const c = tileFToLatLon(z, x + 0.5, y + 0.5), half = tileSizeM(z, c.lat) * 0.71;
  let size = null, best = Infinity, port = false, gz = null, gd = Infinity;
  for (const p of ports()) {
    const d = haversine(c.lat, c.lon, p.lat, p.lon);
    if (p.harbor && d <= 25000 && d < best) { best = d; size = p.size; }
    if (d - half <= p.r * 1000) { port = true; if (!p.harbor && d < gd) { gd = d; gz = p.size; } }
  }
  if (!size && gz) size = gz;
  const nw = tileFToLatLon(z, x, y), se = tileFToLatLon(z, x + 1, y + 1);
  let bigport = null;
  for (const b of BIG_PORTS) if (b.bbox.latMin <= nw.lat && b.bbox.latMax >= se.lat && b.bbox.lonMin <= se.lon && b.bbox.lonMax >= nw.lon) { bigport = b.id; break; }
  let iala = null; try { iala = ialaRegion(c.lat, c.lon); } catch { iala = null; }
  return { size, port, bigport, guard: true, iala, ...extra };
}

// ------------------------------------------------------------------------------------------------ converter runners
/** Inline converter (tests, or when the worker cannot start). */
export function inlineConverter() {
  return { convert: async (job) => { try { return convertJob(job); } catch { return null; } }, close() {}, stats: () => ({ mode: 'inline' }) };
}
/**
 * Converter heap cap (MB) of the worker: SALTLINE_WT_WORKER_HEAP_MB, default 96. One D14 conversion peaks at a few
 * tens of MB; a tile that needs more kills the worker (ERR_WORKER_OUT_OF_MEMORY), never the process.
 */
export const WORKER_HEAP_MB = 96;
/**
 * One worker thread (wtconvert-thread.js) with a hard heap cap (resourceLimits). It is restarted after every exit
 * (crash, out-of-memory, timeout) with a backoff of 1 s doubling to 60 s while it keeps dying; there is no fallback to
 * converting on the main thread (that would move the same memory into the game's heap) unless a Worker cannot be
 * created at all. While it is down convert() resolves null (the build fails, the old tile keeps serving).
 * An idle worker (no job for idleMs, 60 s) is stopped and started again by the next job, so its heap (≈ 50–90 MB)
 * is only held while tiles are being converted.
 */
export function workerConverter({ log = () => {}, timeoutMs = 20_000, heapMb = Number(process.env.SALTLINE_WT_WORKER_HEAP_MB) || WORKER_HEAP_MB, idleMs = 60_000 } = {}) {
  let worker = null, ready = false, seq = 0, inline = null, closed = false, restarts = 0, ooms = 0, backoff = 1000, startedAt = 0, restartTimer = null;
  let idleTimer = null, idleStops = 0, spawns = 0;
  const idleExits = new WeakSet();
  const pending = new Map();
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (!idleMs || pending.size || !worker) return;
    idleTimer = setTimeout(() => { idleTimer = null; const w = worker; if (!w || pending.size) return; idleExits.add(w); worker = null; ready = false; idleStops++; try { w.terminate(); } catch { /* gone */ } }, idleMs);
    idleTimer.unref?.();
  };
  const spawn = () => {
    restartTimer = null;
    if (closed) return;
    spawns++;
    try {
      const w = new Worker(new URL('./wtconvert-thread.js', import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: heapMb, maxYoungGenerationSizeMb: Math.max(4, Math.min(32, Math.round(heapMb / 6))) } });
      worker = w; startedAt = Date.now();
      w.unref?.();
      w.on('message', (m) => {
        if (m?.ready) { ready = true; return; }
        const p = pending.get(m?.id); if (!p) return;
        pending.delete(m.id); clearTimeout(p.timer);
        p.resolve(m.ok ? { raw: m.raw, gz: m.gz, ms: m.ms, flags: m.flags, rev: m.rev } : null);
        armIdle();
      });
      w.on('error', (e) => { if (e?.code === 'ERR_WORKER_OUT_OF_MEMORY') ooms++; try { log('[wt] converter worker error', e?.code || '', e?.message || e); } catch { /* never */ } });
      w.on('exit', () => {
        if (idleExits.has(w)) return;   // stopped for being idle: the next job starts a new one
        if (worker === w) { worker = null; ready = false; }
        for (const [, p] of pending) { clearTimeout(p.timer); p.resolve(null); }
        pending.clear();
        if (closed) return;
        restarts++;
        backoff = Date.now() - startedAt > 120_000 ? 1000 : Math.min(60_000, backoff * 2);
        if (!restartTimer) { restartTimer = setTimeout(spawn, backoff); restartTimer.unref?.(); }
      });
    } catch (e) { inline = inlineConverter(); try { log('[wt] converter worker unavailable — converting inline', e?.message || e); } catch { /* never */ } }
  };
  spawn(); armIdle();
  return {
    convert(job) {
      if (inline) return inline.convert(job);
      if (!worker && !restartTimer && !closed) spawn();   // idle-stopped (or never started): start on demand
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      const w = worker;
      if (!w) return Promise.resolve(null);
      return new Promise((resolve) => {
        const id = ++seq;
        const timer = setTimeout(() => { pending.delete(id); resolve(null); try { w.terminate(); } catch { /* restart via exit */ } }, timeoutMs);
        pending.set(id, { resolve, timer });
        try { w.postMessage({ id, ...job }); } catch { pending.delete(id); clearTimeout(timer); resolve(null); }
      });
    },
    close() { closed = true; if (restartTimer) clearTimeout(restartTimer); if (idleTimer) clearTimeout(idleTimer); try { worker?.terminate(); } catch { /* gone */ } },
    /** Worker heap now (Node ≥ 22.16 only; null elsewhere). */
    async heap() { try { if (!worker?.getHeapStatistics) return null; const h = await worker.getHeapStatistics(); return { usedMB: Math.round(h.used_heap_size / 1048576), limitMB: Math.round(h.heap_size_limit / 1048576) }; } catch { return null; } },
    stats: () => ({ mode: inline ? 'inline' : ready ? 'worker' : worker ? 'starting' : 'idle', pending: pending.size, restarts, ooms, heapMb, spawns, idleStops }),
  };
}

// ------------------------------------------------------------------------------------------------ service
/**
 * createWorldTiles(opts): { dataDir, offline, log, sources (wtsource instance), converter ({convert}), now,
 * memMB (SALTLINE_WT_MEM_MB, 64: decoded tiles in memory, bytes), guard (server/memguard.js: allowPrio), cacheMB (SALTLINE_WT_CACHE_MB, 600), reserveMB (SALTLINE_WT_RESERVE_MB, 400: kept free on the volume),
 * freeBytes(dir) (injectable), fetchConc 4, waitMs 6000, flushMs 60 s, useWorker }.
 */
export function createWorldTiles(opts = {}) {
  const dataDir = opts.dataDir || DATA_DIR;
  const root = path.join(dataDir, 'world');
  const offline = opts.offline ?? (process.env.SALTLINE_WT_OFFLINE === '1' || !!process.env.NODE_TEST_CONTEXT);
  const log = opts.log || ((...a) => console.log(new Date().toISOString(), '[wt]', ...a));
  const now = opts.now || Date.now;
  const sources = opts.sources || createSources({ dataDir, offline, log });
  const converter = opts.converter || (opts.useWorker === false || process.env.NODE_TEST_CONTEXT ? inlineConverter() : workerConverter({ log }));
  const memBudget = Math.max(1, Number(opts.memMB ?? process.env.SALTLINE_WT_MEM_MB ?? DEFAULT_MEM_MB) || DEFAULT_MEM_MB) * 1048576;
  const guard = opts.guard || null;
  const allowPrio = (prio) => { try { return !guard || guard.allowPrio(prio); } catch { return true; } };
  // Disk cap: SALTLINE_WT_CACHE_MB (default 600 MB — the production volume has ≈ 1.5 GB free, the design's 1 536 MB
  // would not fit) and never more than what the volume can spare: the cap shrinks to (our bytes + free − reserve) so
  // the tiles never fill the disk the game state is saved on (SALTLINE_WT_RESERVE_MB, default 400 MB, kept free).
  const capCfg = Math.max(0.001, Number(opts.cacheMB ?? process.env.SALTLINE_WT_CACHE_MB ?? DEFAULT_CACHE_MB) || DEFAULT_CACHE_MB) * 1048576;
  const reserveBytes = Math.max(0, Number(opts.reserveMB ?? process.env.SALTLINE_WT_RESERVE_MB ?? 400) || 0) * 1048576;
  const freeBytes = opts.freeBytes || ((dir) => { try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return Infinity; } });
  let capBytes = capCfg;
  const fetchConc = Math.max(1, opts.fetchConc ?? 4);
  const waitMs = opts.waitMs ?? 6000;
  const st = { requests: 0, memHits: 0, diskHits: 0, built: 0, buildFailed: 0, uniformSkips: 0, swaps: 0, evicted: 0, convertMs: 0, overlays: 0, memEvicted: 0, shed: 0, denied: 0, dropped: 0, convertBackoff: 0 };

  // Decoded tiles, bounded in BYTES (raw SLWT incl. the vector bytes + gzip bytes + SDF): least recently requested
  // first out. Only foreground work (P0–P2: ships, clients, harbours near players) is kept here; background warm-up and
  // the patch rebuild (P3/P4) get their tile handed back without filling this cache.
  const entryBytes = (e) => (e.raw?.byteLength || 0) + (e.gz?.byteLength || 0) + (e.sdf?.byteLength || 0) + 600;
  const mem = new ByteLRU({ maxBytes: memBudget, sizeOf: entryBytes, onEvict: () => { st.memEvicted++; } });   // key → entry { key, z, x, y, raw, gz, tile, etag, rev, last, sdf, sdfAt, swappedAt }
  const parentInfo = new Map();   // C11 key → uniform-tile header fields | false (mixed): the hierarchical skip without re-reading the parent
  const convertFails = new Map(); // key → { n, until }: a tile whose conversion keeps failing (e.g. kills the worker) waits
  const index = new Map();        // disk key → { bytes, last, pin, cv }
  const dirty = new Set();
  const jobs = new Map();         // key → job { key, z, x, y, prio, d, seq, promise, resolve, pin }
  let queue = [];                 // jobs waiting for a build slot
  let active = 0, seqN = 0, closed = false;
  const swapFns = [];
  const bathyMem = new ByteLRU({ maxBytes: BATHY_MEM_MB * 1048576, sizeOf: (dm) => (dm ? dm.byteLength : 0) + 100 });   // 'x9/y9' → Int16Array | null (null = known missing)
  const bathyInflight = new Map();

  // ------------------------------------------------------------ disk layout + index
  const tileFile = (z, x, y) => path.join(root, 'tiles', `f${WT.FORMAT}`, String(z), String(x), `${y}.slwt.gz`);
  const overlayFile = (x, y) => path.join(root, 'overlay', String(x), `${y}.json.gz`);
  const bathyFile = (x, y) => path.join(root, 'bathy', String(x), `${y}.bin`);
  const indexFile = path.join(root, 'index.ndjson');
  const fileOfKey = (k) => {
    const [kind, a, b, c] = k.split('/');
    if (kind === 't11' || kind === 't14') return tileFile(Number(kind.slice(1)), +a, +b);
    if (kind === 'o12') return overlayFile(+a, +b);
    if (kind === 'b9') return bathyFile(+a, +b);
    return null;
  };
  function loadIndex() {
    index.clear();
    let ok = false;
    try {
      const text = fs.readFileSync(indexFile, 'utf8');
      for (const line of text.split('\n')) {
        if (!line) continue;
        try { const e = JSON.parse(line); if (e.bytes < 0) index.delete(e.k); else index.set(e.k, { bytes: e.bytes, last: e.last || 0, pin: !!e.pin, cv: e.cv ?? CONVERTER_VERSION, src: e.src || null }); } catch { /* torn line */ }
      }
      ok = true;
    } catch { ok = false; }
    if (!ok) rebuildIndex();
    compactIndex();
  }
  function walk(dir, fn) { let list = []; try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; } for (const d of list) { const p = path.join(dir, d.name); if (d.isDirectory()) walk(p, fn); else fn(p); } }
  function rebuildIndex() {
    index.clear();
    const t0 = Date.now();
    walk(path.join(root, 'tiles', `f${WT.FORMAT}`), (p) => {
      const m = /[\\/](\d+)[\\/](\d+)[\\/](\d+)\.slwt\.gz$/.exec(p); if (!m) return;
      try { const s = fs.statSync(p); index.set(`t${m[1]}/${m[2]}/${m[3]}`, { bytes: s.size, last: s.mtimeMs, pin: false, cv: CONVERTER_VERSION, src: null }); } catch { /* raced */ }
    });
    walk(path.join(root, 'overlay'), (p) => { const m = /[\\/](\d+)[\\/](\d+)\.json\.gz$/.exec(p); if (m) try { index.set(`o12/${m[1]}/${m[2]}`, { bytes: fs.statSync(p).size, last: fs.statSync(p).mtimeMs, pin: false }); } catch { /* raced */ } });
    walk(path.join(root, 'bathy'), (p) => { const m = /[\\/](\d+)[\\/](\d+)\.bin$/.exec(p); if (m) try { index.set(`b9/${m[1]}/${m[2]}`, { bytes: fs.statSync(p).size, last: fs.statSync(p).mtimeMs, pin: false }); } catch { /* raced */ } });
    try { log(`index rebuilt from disk: ${index.size} files in ${Date.now() - t0} ms`); } catch { /* never */ }
  }
  function compactIndex() {
    try {
      fs.mkdirSync(root, { recursive: true });
      const lines = [...index].map(([k, e]) => JSON.stringify({ k, ...e })).join('\n');
      const tmp = `${indexFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, lines ? lines + '\n' : ''); fs.renameSync(tmp, indexFile);
      dirty.clear();
    } catch (e) { try { log('index write failed', e.message); } catch { /* never */ } }
  }
  function flushIndex() {
    if (!dirty.size) return;
    const lines = [];
    for (const k of dirty) { const e = index.get(k); lines.push(JSON.stringify(e ? { k, ...e } : { k, bytes: -1 })); }
    dirty.clear();
    try { fs.mkdirSync(root, { recursive: true }); fs.appendFileSync(indexFile, lines.join('\n') + '\n'); } catch { /* next flush */ }
  }
  /** Re-derive the effective cap from the free space on the data volume (start + every index flush). */
  function updateCap() {
    let free = Infinity;
    try { fs.mkdirSync(root, { recursive: true }); free = freeBytes(root); } catch { free = Infinity; }
    const ours = diskBytes().b;
    const room = Number.isFinite(free) ? Math.max(0, ours + free - reserveBytes) : Infinity;
    const next = Math.max(Math.min(capCfg, 32 * 1048576), Math.min(capCfg, room));
    if (Math.abs(next - capBytes) > 1048576 && next < capCfg) { try { log(`disk cap ${Math.round(next / 1048576)} MB (volume has ${Math.round(free / 1048576)} MB free, ${Math.round(reserveBytes / 1048576)} MB kept free)`); } catch { /* never */ } }
    capBytes = next;
    maybeEvict();
  }
  const flushTimer = setInterval(() => { try { flushIndex(); updateCap(); } catch { /* never */ } }, opts.flushMs ?? 60_000);
  flushTimer.unref?.();
  function touch(k) { const e = index.get(k); if (e) { e.last = now(); dirty.add(k); } }
  function diskBytes() { let b = 0, p = 0; for (const e of index.values()) { b += e.bytes; if (e.pin) p += e.bytes; } return { b, p }; }
  function setIndex(k, bytes, extra = {}) {
    const prev = index.get(k);
    let pin = !!(extra.pin || prev?.pin);
    if (pin && !prev?.pin) { const { p } = diskBytes(); if (p + bytes > capBytes * 0.25) pin = false; }
    index.set(k, { bytes, last: now(), pin, cv: extra.cv ?? prev?.cv ?? CONVERTER_VERSION, src: extra.src ?? prev?.src ?? null });
    dirty.add(k);
    maybeEvict();
  }
  function maybeEvict() {
    let { b } = diskBytes();
    if (b <= capBytes * 0.95) return;
    const victims = [...index].filter(([, e]) => !e.pin).sort((a, c) => a[1].last - c[1].last);
    for (const [k, e] of victims) {
      if (b <= capBytes * 0.85) break;
      const f = fileOfKey(k);
      try { if (f) fs.unlinkSync(f); } catch { /* already gone */ }
      index.delete(k); dirty.add(k); b -= e.bytes; st.evicted++;
      if (k[0] === 't') mem.delete(k.slice(1));
    }
  }
  async function writeAtomic(file, buf) {
    const tmp = `${file}.${process.pid}.${(++seqN).toString(36)}.tmp`;
    try { await fs.promises.mkdir(path.dirname(file), { recursive: true }); await fs.promises.writeFile(tmp, buf); await fs.promises.rename(tmp, file); return true; }
    catch { try { await fs.promises.unlink(tmp); } catch { /* nothing */ } return false; }
  }

  // ------------------------------------------------------------ memory
  function remember(e) { mem.set(e.key, e); }
  /** Background priorities (P3 offline ships, P4 warm-up / patch rebuild) never fill the memory cache. */
  const isBg = (prio) => prio >= PRIO.P3;
  function fromRaw(z, x, y, raw, gz) {
    const tile = decodeTile(raw, { lazyVectors: true });
    return { key: tileKey(z, x, y), z, x, y, raw, gz, tile, rev: tile.rev, etag: `"${tile.srcHash.toString(16)}-${tile.rev}-${tile.contentHash.toString(16)}"`, last: now(), sdf: null, swappedAt: 0 };
  }
  async function readDiskTile(z, x, y) {
    try {
      const gz = await fs.promises.readFile(tileFile(z, x, y));
      const raw = new Uint8Array(zlib.gunzipSync(gz));
      return fromRaw(z, x, y, raw, gz);
    } catch { return null; }
  }

  // ------------------------------------------------------------ bathy / overlay inputs
  async function bathyFor(z, x, y) {
    const k = 2 ** (z - WT.Z_BATHY), x9 = Math.floor(x / k), y9 = Math.floor(y / k), key = `${x9}/${y9}`;
    if (bathyMem.has(key)) { const dm = bathyMem.get(key); return dm ? { x9, y9, dm } : null; }
    if (!bathyInflight.has(key)) {
      bathyInflight.set(key, (async () => {
        try { const b = await fs.promises.readFile(bathyFile(x9, y9)); if (b.length === 131072) { touch(`b9/${key}`); return new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); } } catch { /* not cached */ }
        const r = await sources.fetchBathy(x9, y9);
        if (!r.ok) return null;
        const buf = Buffer.from(r.dm.buffer, r.dm.byteOffset, r.dm.byteLength);
        if (await writeAtomic(bathyFile(x9, y9), buf)) setIndex(`b9/${key}`, buf.length);
        return r.dm;
      })().catch(() => null).then((dm) => { bathyMem.set(key, dm); bathyInflight.delete(key); return dm; }));
    }
    const dm = await bathyInflight.get(key);
    return dm ? { x9, y9, dm } : null;
  }
  async function overlayFor(z, x, y) {
    if (z !== WT.Z_DETAIL) return null;
    const x12 = x >> 2, y12 = y >> 2;
    try { const b = await fs.promises.readFile(overlayFile(x12, y12)); touch(`o12/${x12}/${y12}`); return JSON.parse(zlib.gunzipSync(b).toString('utf8')); } catch { return null; }
  }

  // ------------------------------------------------------------ build queue
  function cmpJob(a, b) { return a.prio - b.prio || a.d - b.d || a.seq - b.seq; }
  let activeBg = 0;
  /** Resolve and forget queued jobs for which `drop(job)` is true (memory guard, caps). */
  function dropQueued(drop) {
    const keep = [];
    for (const j of queue) { if (drop(j)) { jobs.delete(j.key); st.dropped++; j.resolve(mem.get(j.key)?.tile || null); } else keep.push(j); }
    queue = keep;
  }
  function pump() {
    if (closed) return;
    if (guard && queue.some((j) => !allowPrio(j.prio))) dropQueued((j) => !allowPrio(j.prio));   // the guard tightened: shed what may not run
    while (active < fetchConc && queue.length) {
      queue.sort(cmpJob);
      const job = queue[0];
      if (!allowPrio(job.prio)) { dropQueued((j) => !allowPrio(j.prio)); continue; }
      // background work (P3/P4): one build at a time, so warm-up never holds more than one conversion's memory
      if (isBg(job.prio) && activeBg >= 1) break;
      queue.shift();
      active++;
      const bg = isBg(job.prio); if (bg) activeBg++;
      build(job).catch(() => null).then((e) => {
        active--; if (bg) activeBg--;
        jobs.delete(job.key);
        job.resolve(e ? e.tile : null);
        pump();
      });
    }
  }
  async function parentUniform(x11, y11) {
    const pk = tileKey(WT.Z_COAST, x11, y11);
    const m = mem.get(pk);
    if (m) return m.tile.flags & WT.FLAG.UNIFORM ? m.tile : null;
    if (parentInfo.has(pk)) return parentInfo.get(pk) || null;
    if (!index.has(`t${pk}`)) return null;
    const e = await readDiskTile(WT.Z_COAST, x11, y11);
    if (!e) return null;
    const t = e.tile, info = t.flags & WT.FLAG.UNIFORM ? { flags: t.flags, rev: t.rev, srcHash: t.srcHash, builtAt: t.builtAt, uniformH: t.uniformH } : false;
    parentInfo.set(pk, info); if (parentInfo.size > 2048) parentInfo.delete(parentInfo.keys().next().value);
    return info || null;
  }
  async function build(job) {
    const { z, x, y } = job;
    const prev = mem.get(job.key) || null;
    // hierarchical skip: a uniform C11 parent makes its 64 D14 children uniform without a fetch
    if (z === WT.Z_DETAIL && !job.force) {
      const parent = await parentUniform(x >> 3, y >> 3);
      if (parent) {
        st.uniformSkips++;
        const t = { z, x, y, n: WT.N, flags: parent.flags, rev: parent.rev, srcHash: parent.srcHash, builtAt: parent.builtAt, uniformH: parent.uniformH, mask: null, height: null, vectors: null };
        const raw = encodeTile(t);
        return commit(job, raw, new Uint8Array(zlib.gzipSync(raw)), prev, { src: null });
      }
    }
    const cf = convertFails.get(job.key);
    if (cf && cf.until > now()) { st.convertBackoff++; return prev; }
    const base = await sources.fetchBase(z, x, y);
    if (!base.ok) { st.buildFailed++; return prev; }
    const [bathy, overlay] = await Promise.all([bathyFor(z, x, y).catch(() => null), job.noOverlay ? null : overlayFor(z, x, y)]);
    const hints = hintsFor(z, x, y, { src: base.src, builtAt: Math.floor(now() / 1000) });
    const r = await converter.convert({ z, x, y, mvt: base.buf, overlay, bathy, hints });
    if (!r) {
      st.buildFailed++;
      const n = (cf?.n || 0) + 1;   // 1 min, 4 min, 16 min … ≤ 6 h before this tile is tried again
      convertFails.set(job.key, { n, until: now() + Math.min(6 * 3600e3, 60e3 * 4 ** (n - 1)) });
      if (convertFails.size > 5000) convertFails.delete(convertFails.keys().next().value);
      return prev;
    }
    convertFails.delete(job.key);
    st.built++; st.convertMs += r.ms || 0;
    return commit(job, r.raw, r.gz, prev, { src: base.src });
  }
  async function commit(job, raw, gz, prev, { src }) {
    const e = fromRaw(job.z, job.x, job.y, raw instanceof Uint8Array ? raw : new Uint8Array(raw), Buffer.from(gz.buffer, gz.byteOffset, gz.byteLength));
    const file = tileFile(job.z, job.x, job.y);
    if (await writeAtomic(file, e.gz)) setIndex(`t${job.key}`, e.gz.length, { pin: job.pin, cv: CONVERTER_VERSION, src });
    const old = prev || mem.get(job.key) || null;
    if (old && old.etag !== e.etag) { e.swappedAt = now(); st.swaps++; }
    if (job.z === WT.Z_COAST) parentInfo.delete(job.key);
    if (!isBg(job.prio) || mem.has(job.key)) remember(e);   // background builds go to disk; the caller still gets the tile
    invalidateNeighbours(job.z, job.x, job.y);
    if (old && old.etag !== e.etag) for (const fn of swapFns) { try { fn({ key: e.key, z: e.z, x: e.x, y: e.y, rev: e.rev, prevRev: old.rev, tile: e.tile, etag: e.etag }); } catch { /* listener errors stay there */ } }
    return e;
  }

  /** Validated z/x/y or null. */
  function valid(z, x, y) {
    if (!ZS.has(z) || !Number.isInteger(x) || !Number.isInteger(y)) return false;
    const n = 2 ** z; return x >= 0 && y >= 0 && x < n && y < n;
  }
  /**
   * The decoded tile (memory → disk → build at `prio`). opts: { d (metres, nearest first within a priority), pin
   * (harbour ring: exempt from disk eviction), force (rebuild even when cached), noOverlay }. Never rejects; null when
   * the tile cannot be had now (source down and nothing cached).
   */
  async function request(z, x, y, prio = PRIO.P2, o = {}) {
    try {
      if (closed || !valid(z, x, y)) return null;
      st.requests++;
      const key = tileKey(z, x, y);
      let e = mem.get(key);
      if (e && !o.force) { st.memHits++; e.last = now(); if (!isBg(prio)) mem.touch(key); touch(`t${key}`); if (o.pin) pinKey(`t${key}`); return e.tile; }
      const ix = index.get(`t${key}`);
      if (!e && ix && !o.force) {
        e = await readDiskTile(z, x, y);
        if (e) {
          st.diskHits++; if (!isBg(prio)) remember(e); touch(`t${key}`); if (o.pin) pinKey(`t${key}`);
          if ((ix.cv ?? CONVERTER_VERSION) !== CONVERTER_VERSION) enqueue(z, x, y, Math.max(prio, PRIO.P3), { ...o, force: true });   // lazy rebuild, old tile keeps serving
          return e.tile;
        }
        index.delete(`t${key}`); dirty.add(`t${key}`);
      }
      return await enqueue(z, x, y, prio, o);
    } catch { return null; }
  }
  function enqueue(z, x, y, prio, o = {}) {
    const key = tileKey(z, x, y);
    let job = jobs.get(key);
    if (job) {
      if (prio < job.prio) job.prio = prio;
      if (Number.isFinite(o.d) && o.d < job.d) job.d = o.d;
      if (o.pin) job.pin = true;
      return job.promise;
    }
    if (offline && !index.has(`t${key}`) && !mem.has(key) && !(z === WT.Z_DETAIL && mem.has(tileKey(WT.Z_COAST, x >> 3, y >> 3)))) return Promise.resolve(null);
    if (!allowPrio(prio)) { st.denied++; return Promise.resolve(mem.get(key)?.tile || null); }   // memory guard
    if (isBg(prio)) { let bg = 0; for (const j of queue) if (isBg(j.prio)) bg++; if (bg >= BG_QUEUE_MAX) { st.denied++; return Promise.resolve(null); } }
    job = { key, z, x, y, prio, d: Number.isFinite(o.d) ? o.d : 0, seq: ++seqN, pin: !!o.pin, force: !!o.force, noOverlay: !!o.noOverlay };
    job.promise = new Promise((r) => { job.resolve = r; });
    jobs.set(key, job);
    if (queue.length >= QUEUE_MAX) {   // shed the least urgent work
      queue.sort(cmpJob);
      const drop = queue.pop(); jobs.delete(drop.key); st.dropped++; drop.resolve(mem.get(drop.key)?.tile || null);
    }
    queue.push(job);
    pump();
    return job.promise;
  }
  function pinKey(k) { const e = index.get(k); if (e && !e.pin) { const { p } = diskBytes(); if (p + e.bytes <= capBytes * 0.25) { e.pin = true; dirty.add(k); } } }

  /** Fetch (if needed) the Overpass overlay of a z12 square and rebuild its loaded / cached D14 children as rev 1. */
  async function requestOverlay(x12, y12, { rebuild = true } = {}) {
    try {
      const k = `o12/${x12}/${y12}`;
      if (!index.has(k)) {
        const r = await sources.fetchOverlay(x12, y12);
        if (!r.ok) return false;
        const gz = zlib.gzipSync(JSON.stringify(r.overlay));
        if (!(await writeAtomic(overlayFile(x12, y12), gz))) return false;
        setIndex(k, gz.length); st.overlays++;
      }
      if (!rebuild) return true;
      const waits = [];
      for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) {
        const x = x12 * 4 + dx, y = y12 * 4 + dy, key = tileKey(WT.Z_DETAIL, x, y);
        const e = mem.get(key);
        if ((e && !(e.tile.flags & WT.FLAG.OVERLAY) && !(e.tile.flags & WT.FLAG.UNIFORM)) || (!e && index.has(`t${key}`))) waits.push(enqueue(WT.Z_DETAIL, x, y, PRIO.P2, { force: true }));
      }
      await Promise.all(waits);
      return true;
    } catch { return false; }
  }

  // ------------------------------------------------------------ sync queries (memory only)
  function entryAt(z, lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > WT.LAT_MAX) return null;
    const c = cellOf(z, lat, lon);
    const e = mem.get(tileKey(z, ((c.x % 2 ** z) + 2 ** z) % 2 ** z, c.y));
    return e ? { e, u: c.u, v: c.v } : null;
  }
  function heightAt(lat, lon, { z = WT.Z_DETAIL } = {}) { const r = entryAt(z, lat, lon); return r ? tileHeightAt(r.e.tile, r.u, r.v) : null; }
  function maskAt(lat, lon, { z = WT.Z_DETAIL } = {}) { const r = entryAt(z, lat, lon); return r ? tileMaskAt(r.e.tile, r.u, r.v) : null; }
  function invalidateNeighbours(z, x, y) { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const e = mem.get(tileKey(z, x + dx, y + dy)); if (e && e.sdf && now() - e.sdfAt > 2000) e.sdf = null; } }
  /** Signed distance field of a D14 tile (Int16, quarter metres, + in water, − inside obstacles) with a 16-cell apron from loaded neighbours. */
  function sdfOf(e) {
    if (e.sdf) return e.sdf;
    const N = e.tile.n, W = N + 2 * APRON, m = new Uint8Array(W * W);
    const cellM = tileSizeM(e.z, tileFToLatLon(e.z, e.x + 0.5, e.y + 0.5).lat) / N;
    for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
      let gi = i - APRON, gj = j - APRON, dx = 0, dy = 0;
      if (gi < 0) { dx = -1; gi += N; } else if (gi >= N) { dx = 1; gi -= N; }
      if (gj < 0) { dy = -1; gj += N; } else if (gj >= N) { dy = 1; gj -= N; }
      let t = e.tile;
      if (dx || dy) { const nb = mem.get(tileKey(e.z, e.x + dx, e.y + dy)); if (nb) t = nb.tile; else { gi = Math.max(0, Math.min(N - 1, i - APRON)); gj = Math.max(0, Math.min(N - 1, j - APRON)); } }
      m[j * W + i] = WT_OBSTACLE[t.mask ? t.mask[gj * N + gi] : t.flags & WT.FLAG.UNIFORM_LAND ? WT.MASK.LAND : WT.MASK.WATER] ? 1 : 0;
    }
    const water = new Uint8Array(W * W); for (let k = 0; k < m.length; k++) water[k] = m[k] ? 0 : 1;
    const dObs = edt(m, W, W), dWat = edt(water, W, W);
    const out = new Int16Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = (j + APRON) * W + i + APRON, obst = m[k];
      const d = obst ? -Math.max(0, (dWat[k] === Infinity ? 1e4 : dWat[k]) - 0.5) * cellM : Math.max(0, (dObs[k] === Infinity ? 1e4 : dObs[k]) - 0.5) * cellM;
      out[j * N + i] = Math.max(-32000, Math.min(32000, Math.round(d * 4)));
    }
    e.sdf = out; e.sdfAt = now();
    if (mem.get(e.key) === e) mem.resize(e.key);
    return out;
  }
  /** Signed distance (m) to the nearest obstacle edge at lat/lon (+ water, − inside), bilinear; null when not loaded. */
  function sdfAt(lat, lon) {
    const r = entryAt(WT.Z_DETAIL, lat, lon); if (!r) return null;
    const t = r.e.tile;
    if (!t.mask) return t.flags & WT.FLAG.UNIFORM_LAND ? -1000 : 1000;
    const s = sdfOf(r.e), N = t.n, u = r.u - 0.5, v = r.v - 0.5;
    const i0 = Math.max(0, Math.min(N - 2, Math.floor(u))), j0 = Math.max(0, Math.min(N - 2, Math.floor(v))), fx = Math.max(0, Math.min(1, u - i0)), fy = Math.max(0, Math.min(1, v - j0)), o = j0 * N + i0;
    return ((s[o] * (1 - fx) + s[o + 1] * fx) * (1 - fy) + (s[o + N] * (1 - fx) + s[o + N + 1] * fx) * fy) / 4;
  }
  /** Metres inside a D14 obstacle (0 in water), null when the tile is not loaded. */
  function landPenetration(lat, lon) { const d = sdfAt(lat, lon); return d == null ? null : d < 0 ? -d : 0; }
  /** When (ms) the D14 tile under lat/lon last changed revision / content under the server (0 = never). */
  function swappedAt(lat, lon) { const r = entryAt(WT.Z_DETAIL, lat, lon); return r ? r.e.swappedAt : 0; }

  /** Request every D14 tile within radiusM (nearest first) and wait for them up to timeoutMs. Resolves { ready, total }. */
  async function ensureAround(lat, lon, radiusM = 3000, prio = PRIO.P0, { timeoutMs = 3000, z = WT.Z_DETAIL } = {}) {
    try {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { ready: 0, total: 0 };
      const list = tilesInRadius(z, lat, lon, radiusM);
      let ready = 0;
      const ps = list.map((t) => request(t.z, t.x, t.y, prio, { d: t.d }).then((r) => { if (r) ready++; }));
      let timer;
      await Promise.race([Promise.all(ps), new Promise((r) => { timer = setTimeout(r, timeoutMs); })]);
      clearTimeout(timer);
      return { ready, total: list.length };
    } catch { return { ready: 0, total: 0 }; }
  }
  /**
   * Every D14 tile within radiusM requested at `prio` and handed back as Map('x/y' → decoded tile), or null when one is
   * missing after timeoutMs. The tiles are held by the caller only (background priorities never fill the memory cache):
   * the patch builder uses this instead of ensureAround + get.
   */
  async function collect(lat, lon, radiusM, prio = PRIO.P4, { timeoutMs = 120_000, z = WT.Z_DETAIL } = {}) {
    try {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const list = tilesInRadius(z, lat, lon, radiusM), out = new Map();
      let timer, missing = false;
      const all = Promise.all(list.map((t) => request(t.z, t.x, t.y, prio, { d: t.d }).then((r) => { if (r) out.set(`${t.x}/${t.y}`, r); else missing = true; })));
      const timedOut = await Promise.race([all.then(() => false), new Promise((r) => { timer = setTimeout(() => r(true), timeoutMs); })]);
      clearTimeout(timer);
      return timedOut || missing || out.size < list.length ? null : out;
    } catch { return null; }
  }
  /**
   * Memory guard (server/memguard.js) shed: keep only decoded tiles near `keep` points ([{lat, lon}], D14 within
   * keepM, C11 within 4 × keepM), drop the bathy / parent caches and queued work the guard no longer allows.
   * Returns { dropped, memMB }.
   */
  function shed({ keep = [], keepM = 6000 } = {}) {
    st.shed++;
    const near = (e) => {
      const c = tileFToLatLon(e.z, e.x + 0.5, e.y + 0.5), r = e.z === WT.Z_COAST ? keepM * 4 : keepM;
      for (const p of keep) if (haversine(p.lat, p.lon, c.lat, c.lon) <= r) return true;
      return false;
    };
    const dropped = mem.dropWhere((k, e) => !near(e));
    bathyMem.clear(); parentInfo.clear();
    dropQueued((j) => !allowPrio(j.prio));
    return { dropped, memMB: Math.round(mem.bytes / 1048576) };
  }

  /**
   * HTTP answer for GET /api/wt/:z/:x/:y (§3.5): { status, headers, body }. 200 gzip bytes + ETag, 304 on a matching
   * If-None-Match, 503 + Retry-After when the build does not finish within waitMs, 404 + X-WT: fallback when the
   * source is down and nothing is cached, 400 for bad coordinates.
   */
  async function serveTile(z, x, y, { ifNoneMatch = null, wait = waitMs } = {}) {
    try {
      if (!valid(z, x, y)) return { status: 400, headers: {}, body: null };
      const key = tileKey(z, x, y);
      let e = mem.get(key);
      if (!e) {
        let timer, timedOut = false;
        const p = request(z, x, y, PRIO.P0);
        await Promise.race([p, new Promise((r) => { timer = setTimeout(() => { timedOut = true; r(); }, wait); })]);
        clearTimeout(timer);
        e = mem.get(key);
        if (!e) return timedOut && jobs.has(key) ? { status: 503, headers: { 'Retry-After': '2', 'Cache-Control': 'no-store' }, body: null } : { status: 404, headers: { 'X-WT': 'fallback', 'Cache-Control': 'no-store' }, body: null };
      }
      const headers = { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip', ETag: e.etag, 'Cache-Control': 'no-cache' };
      if (ifNoneMatch && ifNoneMatch.split(/\s*,\s*/).includes(e.etag)) return { status: 304, headers: { ETag: e.etag, 'Cache-Control': 'no-cache' }, body: null };
      return { status: 200, headers, body: e.gz };
    } catch { return { status: 500, headers: {}, body: null }; }
  }
  /** Debug answer for /api/wt/at?lat&lon. */
  function debugAt(lat, lon) {
    const c = Number.isFinite(lat) && Number.isFinite(lon) ? cellOf(WT.Z_DETAIL, lat, lon) : null;
    if (!c) return null;
    const e = mem.get(tileKey(WT.Z_DETAIL, c.x, c.y));
    if (!e) return { key: tileKey(WT.Z_DETAIL, c.x, c.y), loaded: false };
    return { key: e.key, rev: e.rev, flags: e.tile.flags, mask: tileMaskAt(e.tile, c.u, c.v), height: Math.round(tileHeightAt(e.tile, c.u, c.v) * 100) / 100, src: e.tile.vectors?.src ?? null, ov: e.tile.vectors?.ov ?? null, etag: e.etag };
  }
  function meta() {
    const s = sources.sourceInfo();
    return { format: WT.FORMAT, n: WT.N, zDetail: WT.Z_DETAIL, zCoast: WT.Z_COAST, src: s.src, attribution: ATTRIBUTION, offline: !!offline };
  }
  function stats() {
    const s = sources.sourceInfo(), { b } = diskBytes();
    let bg = 0; for (const j of queue) if (isBg(j.prio)) bg++;
    return { ...st, fetched: s.ofmOk, failed: s.failed, queue: queue.length, queueBg: bg, active, activeBg, diskMB: Math.round(b / 1048576), capMB: Math.round(capBytes / 1048576), diskFiles: index.size, memTiles: mem.size, memMB: Math.round(mem.bytes / 1048576 * 10) / 10, memBudgetMB: Math.round(memBudget / 1048576), bathyMB: Math.round(bathyMem.bytes / 1048576 * 10) / 10, jobs: jobs.size, pin: s.pin, healthy: s.healthy, offline: !!offline, today: s.today, converter: converter.stats?.() };
  }
  function close() { closed = true; clearInterval(flushTimer); try { flushIndex(); } catch { /* never */ } try { converter.close?.(); } catch { /* never */ } for (const j of queue) j.resolve(null); queue = []; }

  loadIndex();
  updateCap();
  return {
    request, requestOverlay, enqueue, collect, shed, get: (z, x, y) => mem.get(tileKey(z, x, y))?.tile || null,
    buffer: (z, x, y) => mem.get(tileKey(z, x, y))?.gz || null, etag: (z, x, y) => mem.get(tileKey(z, x, y))?.etag || null,
    has: (z, x, y) => mem.has(tileKey(z, x, y)) || index.has(`t${tileKey(z, x, y)}`),
    heightAt, maskAt, sdfAt, landPenetration, swappedAt, ensureAround, serveTile, debugAt, meta, stats,
    onSwap(fn) { if (typeof fn === 'function') swapFns.push(fn); return () => { const i = swapFns.indexOf(fn); if (i >= 0) swapFns.splice(i, 1); }; },
    queued: () => queue.length + active, healthy: () => sources.sourceInfo().healthy, sources, flushIndex, compactIndex, close, offline, enabled: true,
    capMB: () => capBytes / 1048576,
    _index: index, _mem: mem,
  };
}

/**
 * The tile service switched off (SALTLINE_WT=0): the same surface, nothing on disk or in memory is ever read or
 * written, nothing is fetched. /api/wt answers 404 + X-WT: fallback, so clients keep the coarse world (today's game).
 */
export function disabledTiles() {
  const none = () => null;
  return {
    enabled: false, offline: true,
    request: async () => null, requestOverlay: async () => false, enqueue: async () => null, get: none, buffer: none, etag: none, has: () => false,
    heightAt: none, maskAt: none, sdfAt: none, landPenetration: none, swappedAt: () => 0,
    ensureAround: async () => ({ ready: 0, total: 0 }), collect: async () => null, shed: () => ({ dropped: 0, memMB: 0 }),
    serveTile: async () => ({ status: 404, headers: { 'X-WT': 'fallback', 'Cache-Control': 'no-store' }, body: null }),
    debugAt: () => ({ disabled: true }),
    meta: () => ({ format: WT.FORMAT, n: WT.N, zDetail: WT.Z_DETAIL, zCoast: WT.Z_COAST, src: null, attribution: ATTRIBUTION, offline: true, disabled: true }),
    stats: () => ({ disabled: true, fetched: 0, failed: 0, queue: 0, diskMB: 0, memTiles: 0, pin: null, built: 0, swaps: 0, converter: null }),
    onSwap: () => () => {}, queued: () => 0, healthy: () => false, sources: null, flushIndex() {}, compactIndex() {}, close() {}, capMB: () => 0,
  };
}

// ------------------------------------------------------------------------------------------------ default instance (server.js)
let svc = null;
/** Create the shared instance (server.js calls this once). Returns it. */
export function init(opts = {}) { if (svc) svc.close(); svc = createWorldTiles(opts); return svc; }
const S = () => svc;
export const request = (z, x, y, prio, o) => (S() ? S().request(z, x, y, prio, o) : Promise.resolve(null));
export const get = (z, x, y) => S()?.get(z, x, y) ?? null;
export const buffer = (z, x, y) => S()?.buffer(z, x, y) ?? null;
export const heightAt = (lat, lon, o) => S()?.heightAt(lat, lon, o) ?? null;
export const maskAt = (lat, lon, o) => S()?.maskAt(lat, lon, o) ?? null;
export const landPenetration = (lat, lon) => S()?.landPenetration(lat, lon) ?? null;
export const sdfAt = (lat, lon) => S()?.sdfAt(lat, lon) ?? null;
export const swappedAt = (lat, lon) => S()?.swappedAt(lat, lon) ?? 0;
export const ensureAround = (lat, lon, r, prio, o) => (S() ? S().ensureAround(lat, lon, r, prio, o) : Promise.resolve({ ready: 0, total: 0 }));
export const onSwap = (fn) => S()?.onSwap(fn) ?? (() => {});
export const stats = () => S()?.stats() ?? null;
