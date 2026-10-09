// Route planning off the main thread (docs/V6-QUICK-CONTRACTS.md §4.4). A long route costs up to ~1 s of CPU; on the
// main thread that would freeze the 10 Hz tick for every skipper. One worker (routeworker-thread.js) loads its own copy
// of the world raster and the lane graph and answers one request at a time; the main thread keeps the queue
// (skippers before the route table, FIFO within a priority), a per-request timeout (terminate + restart), restarts a
// crashed worker after 1 s (at most once per 10 s, else plans inline with a log line). `inline: true` (tests) plans
// synchronously on the calling thread.
import { Worker } from 'node:worker_threads';
import { planRoute } from './searoute.js';
import { HARBORS } from './harbors.js';
import { haversine } from '../shared/geo.js';

const PATCH_NEAR_M = 3500;
const RESTART_DELAY_MS = 1000, RESTART_MIN_GAP_MS = 10000;

/** Built harbour patches the plan needs: within 3.5 km of `from`, and the destination harbour's. */
function endsFor(geom, from, opts) {
  if (!geom?.getHarborPatch) return [];
  const ids = new Set();
  for (const h of HARBORS) if (haversine(from.lat, from.lon, h.lat, h.lon) <= PATCH_NEAR_M) ids.add(h.id);
  if (opts?.toHarbor) ids.add(opts.toHarbor);
  const out = [];
  for (const id of ids) {
    let patch = null; try { patch = geom.getHarborPatch(id); } catch { patch = null; }
    if (!patch) continue;
    let g = null; try { g = geom.getHarborGeom?.(id) || null; } catch { g = null; }
    let anchor = null; try { anchor = geom.harborAnchor?.(id) || g?.anchor || null; } catch { anchor = null; }
    out.push({ id, patch: new Uint8Array(patch.buffer, patch.byteOffset, patch.byteLength), fairway: g?.fairway || null, anchor });
  }
  return out;
}

export class RoutePlanner {
  constructor({ world, graph, geom = null, log = () => {}, inline = false, timeoutMs = 8000, maxQueue = 50, workerData = null } = {}) {
    this.world = world; this.graph = graph; this.geom = geom; this.log = log;
    this.inline = !!inline; this.timeoutMs = timeoutMs; this.maxQueue = maxQueue;
    this.workerData = workerData;
    this.queue = { high: [], low: [] };
    this.current = null;       // { id, resolve, timer, t0 }
    this.seq = 0;
    this.st = { done: 0, failed: 0, restarts: 0, totalMs: 0 };
    this.worker = null; this.ready = false; this.closed = false;
    this.lastRestart = 0; this.restartTimer = null;
    if (!this.inline) this.spawn();
  }
  stats() {
    return { queued: this.queue.high.length + this.queue.low.length, inFlight: this.current ? 1 : 0, done: this.st.done, failed: this.st.failed,
      restarts: this.st.restarts, avgMs: this.st.done ? Math.round(this.st.totalMs / this.st.done) : 0, mode: this.inline ? 'inline' : this.ready ? 'worker' : 'starting' };
  }
  /** The queue is full: a new request would be refused (the HTTP handler answers 503). */
  full() { return !this.inline && this.queue.high.length + this.queue.low.length >= this.maxQueue; }
  plan(from, to, opts = {}, { priority = 'high' } = {}) {
    if (this.closed) return Promise.resolve(null);
    if (this.inline) {
      const t0 = Date.now();
      let r = null;
      try { r = planRoute(this.world, this.graph, from, to, { ...opts, geom: opts.geom || this.geom }); } catch (e) { this.log('[route] inline plan failed', e.message); r = null; }
      this.st.done++; this.st.totalMs += Date.now() - t0;
      return Promise.resolve(r);
    }
    if (this.queue.high.length + this.queue.low.length >= this.maxQueue) { this.st.failed++; return Promise.resolve(null); }
    return new Promise((resolve) => {
      const { geom, ...rest } = opts || {};
      const job = { id: ++this.seq, from: { lat: from.lat, lon: from.lon }, to: { lat: to.lat, lon: to.lon }, opts: JSON.parse(JSON.stringify(rest)), ends: endsFor(this.geom, from, opts), resolve };
      (priority === 'low' ? this.queue.low : this.queue.high).push(job);
      this.pump();
    });
  }
  close() {
    this.closed = true;
    clearTimeout(this.restartTimer);
    if (this.current) { clearTimeout(this.current.timer); this.current.resolve(null); this.current = null; }
    for (const j of [...this.queue.high, ...this.queue.low]) j.resolve(null);
    this.queue.high = []; this.queue.low = [];
    if (this.worker) { const w = this.worker; this.worker = null; w.terminate().catch(() => {}); }
  }

  // ---------------------------------------------------------------------------------------------- worker plumbing
  spawn() {
    if (this.closed) return;
    this.ready = false;
    let w;
    try { w = new Worker(new URL('./routeworker-thread.js', import.meta.url), { workerData: this.workerData || {}, resourceLimits: { maxOldGenerationSizeMb: Number(process.env.SALTLINE_ROUTE_WORKER_HEAP_MB) || 256 } }); }   // a hard cap: a runaway plan kills the worker, not the pod
    catch (e) { this.log('[route] worker failed to start — planning inline', e.message); this.goInline(); return; }
    this.worker = w;
    w.on('message', (m) => this.onMessage(w, m));
    w.on('error', (e) => { if (w === this.worker) { this.log('[route] worker error', e?.message || e); this.crashed(w); } });
    w.on('exit', (code) => { if (w === this.worker && !this.closed) { this.log('[route] worker exited', code); this.crashed(w); } });
  }
  goInline() {
    this.inline = true; this.worker = null; this.ready = false;
    const jobs = [...this.queue.high, ...this.queue.low]; this.queue.high = []; this.queue.low = [];
    if (this.current) { clearTimeout(this.current.timer); this.current.resolve(null); this.st.failed++; this.current = null; }
    for (const j of jobs) {
      const geom = this.geom;
      let r = null; try { r = planRoute(this.world, this.graph, j.from, j.to, { ...j.opts, geom }); } catch { r = null; }
      this.st.done++; j.resolve(r);
    }
  }
  crashed(w) {
    if (w !== this.worker) return;
    this.worker = null; this.ready = false;
    if (this.current) { clearTimeout(this.current.timer); this.current.resolve(null); this.st.failed++; this.current = null; }
    const now = Date.now();
    if (now - this.lastRestart < RESTART_MIN_GAP_MS) { this.log('[route] worker keeps failing — planning inline on the main thread'); this.goInline(); return; }
    this.lastRestart = now;
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => { this.st.restarts++; this.spawn(); }, RESTART_DELAY_MS);
    this.restartTimer.unref?.();
  }
  restart() { // after a timeout: terminate at once and start a fresh worker
    const w = this.worker; this.worker = null; this.ready = false;
    if (w) w.terminate().catch(() => {});
    this.st.restarts++; this.lastRestart = Date.now();
    this.spawn();
  }
  onMessage(w, m) {
    if (w !== this.worker || !m) return;
    if (m.ready) { this.ready = true; this.log(`[route] planner worker ready (${m.ms} ms)`); this.pump(); return; }
    const c = this.current;
    if (!c || m.id !== c.id) return;
    clearTimeout(c.timer); this.current = null;
    if (m.ok) { this.st.done++; this.st.totalMs += Date.now() - c.t0; c.resolve(m.result || null); }
    else { this.st.failed++; if (m.error) this.log('[route] plan failed', m.error); c.resolve(null); }
    this.pump();
  }
  pump() {
    if (this.inline) { this.goInline(); return; }
    if (this.current || !this.ready || !this.worker) return;
    const job = this.queue.high.shift() || this.queue.low.shift();
    if (!job) return;
    const t0 = Date.now();
    this.current = { id: job.id, resolve: job.resolve, t0, timer: null };
    this.current.timer = setTimeout(() => {
      if (!this.current || this.current.id !== job.id) return;
      this.current = null; this.st.failed++;
      this.log(`[route] plan timed out after ${this.timeoutMs} ms — restarting the worker`);
      job.resolve(null);
      this.restart();
    }, this.timeoutMs);
    try { this.worker.postMessage({ id: job.id, from: job.from, to: job.to, opts: job.opts, ends: job.ends }); }
    catch (e) { clearTimeout(this.current.timer); this.current = null; this.st.failed++; job.resolve(null); this.log('[route] post failed', e.message); this.pump(); }
  }
}
