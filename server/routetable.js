// Harbour-to-harbour sea distances (docs/V6-QUICK-CONTRACTS.md §3.3 RouteTable). Used by the world market's trade
// finder and by contract budgets (TIME-MODEL). The table fills itself in the background, one plan at a time through the
// injected `plan` (in production the route planner's worker thread at low priority), nearest pairs first, and is kept in
// data/cache/sea-routes-v1-<key>.json. Until a pair is known, `estimateKm` answers great circle × RATES.DETOUR.
import fs from 'node:fs';
import path from 'node:path';
import { HARBORS, carvingsForWorld } from './harbors.js';
import { LANE_NODES, LANE_EDGES } from './lanes.js';
import { PLANNER_VERSION } from './searoute.js';
import { DATA_DIR } from './world.js';
import { haversine } from '../shared/geo.js';
import { RATES } from '../shared/rates.js';

export const ROUTE_TABLE = { VERSION: 1, SAVE_EVERY: 50 };

/** FNV-1a (32 bit, hex) over everything a planned distance depends on: harbours, lanes, carvings, the planner. */
export function routesKey(extra = '') {
  let h = 0x811c9dc5;
  const feed = (s) => { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } };
  feed(JSON.stringify(HARBORS.map((x) => [x.id, x.lat, x.lon])));
  feed(JSON.stringify(LANE_NODES)); feed(JSON.stringify(LANE_EDGES));
  feed(JSON.stringify(carvingsForWorld()));
  feed(String(PLANNER_VERSION ?? 1)); feed(String(extra));
  return (h >>> 0).toString(16).padStart(8, '0');
}

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export class RouteTable {
  constructor({ harbors = HARBORS, plan = null, dir = path.join(DATA_DIR, 'cache'), log = () => {}, key = null } = {}) {
    this.harbors = harbors; this.plan = plan; this.dir = dir; this.log = log;
    this.byId = new Map(harbors.map((h) => [h.id, h]));
    this.key = key || routesKey();
    this.file = path.join(dir, `sea-routes-v${ROUTE_TABLE.VERSION}-${this.key}.json`);
    this.pairs = {};
    this.building = false; this.pending = 0; this.unsaved = 0; this.builtAt = null;
    this.load();
  }
  load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!j || j.key !== this.key || typeof j.pairs !== 'object' || !j.pairs) { this.log('[routes] table file ignored (other key or shape)'); return; }
      for (const [k, v] of Object.entries(j.pairs)) {
        const [a, b] = k.split('|');
        if (!this.byId.has(a) || !this.byId.has(b) || a === b) continue;
        if (v === -1 || (Number.isFinite(v) && v >= 0)) this.pairs[pairKey(a, b)] = v;
      }
      this.builtAt = j.builtAt || null;
    } catch (e) { this.pairs = {}; this.log('[routes] table file unreadable, rebuilding', e.message); }
  }
  save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ v: ROUTE_TABLE.VERSION, key: this.key, builtAt: this.builtAt, pairs: this.pairs }));
      fs.renameSync(tmp, this.file);
      this.unsaved = 0;
    } catch (e) { this.log('[routes] table save failed', e.message); }
  }
  raw(a, b) { if (!a || !b || a === b) return undefined; return this.pairs[pairKey(a, b)]; }
  /** Planned sea distance (km, unordered pair); null = not known yet or no route. */
  seaKm(a, b) { const v = this.raw(a, b); return Number.isFinite(v) && v >= 0 ? v : null; }
  reachable(a, b) { const v = this.raw(a, b); return v === undefined ? undefined : v !== -1; }
  /** { km, est:false } planned | { km, est:true } great circle × detour | null = known unreachable. */
  estimateKm(a, b) {
    const v = this.raw(a, b);
    if (v === -1) return null;
    if (Number.isFinite(v) && v >= 0) return { km: v, est: false };
    const A = this.byId.get(a), B = this.byId.get(b);
    if (!A || !B || a === b) return null;
    return { km: Math.round(haversine(A.lat, A.lon, B.lat, B.lon) / 1000 * RATES.DETOUR * 10) / 10, est: true };
  }
  /** Every unknown pair, shortest great circle first. */
  todo() {
    const out = [];
    const hs = this.harbors;
    for (let i = 0; i < hs.length; i++) for (let j = i + 1; j < hs.length; j++) {
      const a = hs[i].id < hs[j].id ? hs[i] : hs[j], b = a === hs[i] ? hs[j] : hs[i];
      if (this.pairs[pairKey(a.id, b.id)] !== undefined) continue;
      out.push({ a, b, d: haversine(a.lat, a.lon, b.lat, b.lon) });
    }
    return out.sort((x, y) => x.d - y.d);
  }
  /** Background warm-up: ONE plan at a time. Returns a promise that settles when the table is complete (or stopped). */
  start() {
    if (this.building || typeof this.plan !== 'function') return this.running || Promise.resolve();
    const list = this.todo();
    if (!list.length) return Promise.resolve();
    this.building = true; this.pending = list.length; this.stopped = false;
    const t0 = Date.now();
    this.log(`[routes] warming the sea-route table: ${list.length} harbour pairs to plan`);
    this.running = (async () => {
      for (const { a, b } of list) {
        if (this.stopped) break;
        let r;
        try { r = await this.plan(a, b, { toHarbor: b.id }); } catch (e) { r = undefined; this.log('[routes] plan failed', a.id, b.id, e?.message); }
        this.pending--;
        if (r === undefined) continue; // an error: leave the pair unknown, try again on the next start
        this.pairs[pairKey(a.id, b.id)] = r && Number.isFinite(r.distM) ? Math.round(r.distM / 100) / 10 : -1;
        if (++this.unsaved >= ROUTE_TABLE.SAVE_EVERY) this.save();
      }
      this.building = false; this.pending = 0;
      if (!this.stopped) this.builtAt = Date.now();
      this.save();
      this.log(`[routes] sea-route table ${this.stopped ? 'stopped' : 'complete'} in ${Math.round((Date.now() - t0) / 1000)} s`);
    })();
    return this.running;
  }
  stop() { this.stopped = true; }
  stats() {
    const vals = Object.values(this.pairs), n = this.harbors.length;
    return { pairs: (n * (n - 1)) / 2, known: vals.length, unreachable: vals.filter((v) => v === -1).length, pending: this.pending, building: this.building };
  }
}
