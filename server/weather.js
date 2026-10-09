// Live marine weather from Open-Meteo (no key), docs/V3-CONTRACTS.md §2. Cached per 0.5° cell with a TTL,
// concurrency- and rate-limited, offline-safe: sample() never throws and returns null until a cell is cached.
const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const MARINE = 'https://marine-api.open-meteo.com/v1/marine';
import { readFileSync } from 'node:fs';
const FORECAST_VARS = 'wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl,temperature_2m,precipitation,visibility,cloud_cover';
const MARINE_VARS = 'wave_height,wave_direction,wave_period,wind_wave_height,wind_wave_direction,wind_wave_period,swell_wave_height,swell_wave_direction,swell_wave_period,ocean_current_velocity,ocean_current_direction,sea_surface_temperature';
const nv = (s) => s.split(',').length;
/** Quota units of one ship cell (forecast + marine for one location). */
export const CELL_COST = Math.max(1, nv(FORECAST_VARS) / 10) + Math.max(1, nv(MARINE_VARS) / 10);
const UA = 'Saltline/0.3 (weather; https://github.com/Wvdstoep/saltline)';
const distKm = (a, b) => {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(x)));
};

export class WeatherService {
  constructor({ fetchImpl, log, cellDeg = 0.5, ttlMs = 20 * 60e3, maxConcurrent = 2, now, dailyLimit, fixture } = {}) {
    this.fetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    this.log = log || (() => {});
    this.cellDeg = cellDeg; this.ttlMs = ttlMs; this.maxConcurrent = maxConcurrent;
    this.now = now || (() => Date.now());
    this.cells = new Map();        // key -> sample
    this.queue = [];               // keys waiting
    this.queued = new Map();       // key -> urgent
    this.inflight = 0;
    this.failures = 0; this.consecutive = 0; this.disabledUntil = 0; this.backoffUntil = 0;
    this.window = []; // request timestamps in the last minute
    this.forceOff = process.env.SALTLINE_OFFLINE === '1' || !this.fetch;
    // Daily quota (Open-Meteo free tier: 10 000 calls/day; a call with > 10 variables counts nVars/10, every location of
    // a multi-location call counts). Ship cells may use it all, the background harbour sweep 60 %, the real-storm scan
    // 30 %; background and scan are also paced over the UTC day so a busy morning cannot starve the evening.
    this.dailyLimit = Math.max(10, Number(dailyLimit ?? process.env.SALTLINE_WX_DAILY) || 9000);
    this.usage = { day: '', used: 0, scan: 0, refused: 0 };
    const fx = fixture ?? process.env.SALTLINE_WX_FIXTURE;
    if (fx) this.loadFixture(fx);
  }
  /** Seed the cache from a JSON file of samples ([{ lat, lon, wind, waves, … }]) — offline screenshots and tests. */
  loadFixture(file) {
    try {
      const list = typeof file === 'string' ? JSON.parse(readFileSync(file, 'utf8')) : file;
      for (const c of list || []) if (c && Number.isFinite(c.lat) && Number.isFinite(c.lon)) this.cells.set(this.key(c.lat, c.lon), { source: 'open-meteo', marine: true, ...c, fetchedAt: this.now() + 365 * 86400e3 });
      this.log(`[weather] fixture: ${this.cells.size} cells`);
    } catch (e) { this.log('[weather] fixture failed', e.message); }
  }
  /** Calls (quota units) one request costs: locations × max(1, variables / 10). */
  static cost(nVars, nLoc = 1) { return nLoc * Math.max(1, nVars / 10); }
  /** Quota units of one multi-location forecast + marine batch of n points. */
  batchCost(n) { return WeatherService.cost(nv(FORECAST_VARS), n) + WeatherService.cost(nv(MARINE_VARS), n); }
  rollDay() { const d = new Date(this.now()).toISOString().slice(0, 10); if (d !== this.usage.day) { this.usage.day = d; this.usage.used = 0; this.usage.scan = 0; this.usage.refused = 0; } }
  /** Fraction of the UTC day gone (0..1). */
  dayFrac() { const t = this.now(); return (t - Math.floor(t / 86400e3) * 86400e3) / 86400e3; }
  /** May `cost` quota units be spent on `kind` ('urgent' ship cells, 'background' harbours, 'scan' real storms)? */
  canSpend(cost, kind = 'urgent') {
    this.rollDay();
    const u = this.usage, L = this.dailyLimit, pace = L * Math.min(1, this.dayFrac() + 0.15);
    if (u.used + cost > L) return false;
    if (kind === 'background') return u.used + cost <= Math.min(0.6 * L, pace);
    if (kind === 'scan') return u.scan + cost <= 0.3 * L && u.used + cost <= Math.min(0.85 * L, pace);
    return true;
  }
  spend(cost, kind = 'urgent') {
    if (!this.canSpend(cost, kind)) { this.usage.refused++; return false; }
    this.usage.used += cost; if (kind === 'scan') this.usage.scan += cost;
    return true;
  }
  get enabled() { return !this.forceOff && this.now() >= this.disabledUntil; }
  key(lat, lon) { const d = this.cellDeg; return `${Math.round(lat / d) * d}|${Math.round(lon / d) * d}`; }
  sample(lat, lon) {
    try {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const exact = this.cells.get(this.key(lat, lon));
      if (exact) return exact;
      let best = null, bd = 1.0 * 1.0;
      for (const s of this.cells.values()) { const d = (s.lat - lat) ** 2 + ((s.lon - lon) * Math.cos(lat * Math.PI / 180)) ** 2; if (d <= bd) { bd = d; best = s; } }
      return best;
    } catch { return null; }
  }
  /** Queue a cell. `urgent` (a ship's own position) goes ahead of the background harbour cells. */
  request(lat, lon, urgent = false) {
    if (!this.enabled || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const k = this.key(lat, lon), s = this.cells.get(k);
    if (s && this.now() - s.fetchedAt < this.ttlMs) return;
    if (this.queued.has(k)) {
      if (urgent) { this.queued.set(k, true); const i = this.queue.indexOf(k); if (i > 0) { this.queue.splice(i, 1); this.queue.unshift(k); } }
      return;
    }
    if (this.queue.length > 400) return;
    this.queued.set(k, !!urgent);
    if (urgent) this.queue.unshift(k); else this.queue.push(k);
  }
  /**
   * World coverage (v7 step 0): keep the weather warm where people sail — every ship position (urgent) and every
   * harbour within `nearKm` of one of them (background), nearest harbours first. Replaces the old fixed North Sea grid.
   * `ships` and `harbors` are [{lat, lon}]. Returns the number of harbour cells asked for.
   */
  requestAround(ships, harbors, { nearKm = 400, maxHarbors = 40 } = {}) {
    if (!this.enabled) return 0;
    const pts = (ships || []).filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon));
    for (const p of pts) this.request(p.lat, p.lon, true);
    const near = [];
    for (const h of harbors || []) {
      if (!h || !Number.isFinite(h.lat) || !Number.isFinite(h.lon)) continue;
      let best = Infinity;
      for (const p of pts) { const d = distKm(p, h); if (d < best) best = d; }
      if (best <= nearKm) near.push({ h, d: best });
    }
    near.sort((a, b) => a.d - b.d);
    let n = 0;
    for (const { h } of near.slice(0, maxHarbors)) { this.request(h.lat, h.lon); n++; }
    return n;
  }
  tick() {
    const now = this.now();
    if (!this.enabled) return;
    if (now < this.backoffUntil) return;
    this.window = this.window.filter((t) => now - t < 60e3);
    while (this.inflight < this.maxConcurrent && this.queue.length && this.window.length < 60) {
      const k = this.queue[0], urgent = this.queued.get(k);
      if (!this.spend(CELL_COST, urgent ? 'urgent' : 'background')) {
        if (urgent) break;                     // daily quota spent: keep the ship cells queued, serve the cache
        this.queue.shift(); this.queued.delete(k); continue;   // background cell over its share: skip it
      }
      this.queue.shift(); this.queued.delete(k);
      const [lat, lon] = k.split('|').map(Number);
      this.window.push(now); this.inflight++;
      this.fetchCell(lat, lon).then((s) => {
        this.cells.set(k, s); this.consecutive = 0;
      }).catch((e) => {
        this.failures++; this.consecutive++;
        this.backoffUntil = this.now() + Math.min(300e3, 2000 * 2 ** Math.min(7, this.consecutive));
        if (this.consecutive >= 5) { this.disabledUntil = this.now() + 600e3; this.consecutive = 0; this.log('[weather] Open-Meteo unreachable, using synthetic weather for 10 min:', e.message); }
      }).finally(() => { this.inflight--; });
    }
  }
  async get(url) {
    const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 12000);
    try {
      const r = await this.fetch(url, { headers: { 'User-Agent': UA }, signal: ac.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(to); }
  }
  async fetchCell(lat, lon) {
    const q = `latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}`;
    const f = await this.get(`${FORECAST}?${q}&current=${FORECAST_VARS}&wind_speed_unit=ms`);
    let m = null;
    try { m = await this.get(`${MARINE}?${q}&current=${MARINE_VARS}`); } catch { m = null; } // inland cells have no marine data
    return this.parseSample(lat, lon, f?.current, m?.current);
  }
  /**
   * Many locations in ONE forecast + ONE marine request (the real-storm scan). Spends the quota as 'scan' first;
   * returns [] when the quota or the service says no. Each sample is also cached as its 0.5° cell when that cell has
   * nothing fresher, so the scan doubles as weather coverage.
   */
  async fetchBatch(points, kind = 'scan') {
    const pts = (points || []).filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon)).slice(0, 50);
    if (!pts.length || !this.enabled || this.now() < this.backoffUntil) return [];
    const cost = this.batchCost(pts.length);
    if (!this.spend(cost, kind)) return [];
    const q = `latitude=${pts.map((p) => p.lat.toFixed(2)).join(',')}&longitude=${pts.map((p) => p.lon.toFixed(2)).join(',')}`;
    const arr = (j) => (Array.isArray(j) ? j : j ? [j] : []);
    try {
      this.window.push(this.now());
      const f = arr(await this.get(`${FORECAST}?${q}&current=${FORECAST_VARS}&wind_speed_unit=ms`));
      let m = [];
      try { m = arr(await this.get(`${MARINE}?${q}&current=${MARINE_VARS}`)); } catch { m = []; }
      const out = [];
      for (let i = 0; i < pts.length; i++) {
        if (!f[i]?.current) continue;
        const s = this.parseSample(pts[i].lat, pts[i].lon, f[i].current, m[i]?.current);
        out.push(s);
        const k = this.key(s.lat, s.lon), old = this.cells.get(k);
        if (!old || old.fetchedAt < s.fetchedAt - this.ttlMs) this.cells.set(k, s);
      }
      this.consecutive = 0;
      return out;
    } catch (e) {
      this.failures++; this.consecutive++;
      this.backoffUntil = this.now() + Math.min(300e3, 2000 * 2 ** Math.min(7, this.consecutive));
      this.log('[weather] batch failed:', e.message);
      return [];
    }
  }
  /** One sample from Open-Meteo `current` blocks (forecast c, marine mc — mc null/empty inland). */
  parseSample(lat, lon, c = {}, mc = {}) {
    c = c || {}; mc = mc || {};
    const num = (v, d) => (Number.isFinite(+v) && v !== null && v !== undefined ? +v : d);
    const has = (v) => Number.isFinite(+v) && v !== null && v !== undefined;
    const spd = num(c.wind_speed_10m, 5);
    return {
      lat, lon, fetchedAt: this.now(), source: 'open-meteo', marine: has(mc.wave_height),
      wind: { spd, dir: num(c.wind_direction_10m, 240), gust: num(c.wind_gusts_10m, spd * 1.3) },
      waves: { height: num(mc.wave_height, Math.min(8, 0.021 * spd * spd)), dir: num(mc.wave_direction, num(c.wind_direction_10m, 240)), period: num(mc.wave_period, 3 + spd * 0.35) },
      swell: { height: num(mc.swell_wave_height, 0.3), dir: num(mc.swell_wave_direction, 270), period: num(mc.swell_wave_period, 9) },
      // wind sea and swell separately (Open-Meteo wave_height is the combined sea); null when the marine model has no value
      windWaves: has(mc.wind_wave_height) ? { height: +mc.wind_wave_height, dir: num(mc.wind_wave_direction, num(c.wind_direction_10m, 240)), period: num(mc.wind_wave_period, 3 + spd * 0.35) } : null,
      // surface current: Open-Meteo gives km/h and the direction the current flows TOWARDS
      current: has(mc.ocean_current_velocity) ? { speed: +mc.ocean_current_velocity / 3.6, dir: num(mc.ocean_current_direction, 0) } : null,
      sst: has(mc.sea_surface_temperature) ? +mc.sea_surface_temperature : null,
      pressure: num(c.pressure_msl, 1013), temp: num(c.temperature_2m, 12), precip: num(c.precipitation, 0),
      visibility: num(c.visibility, 20000), cloud: num(c.cloud_cover, 40) / 100,
    };
  }
  stats() { this.rollDay(); return { cells: this.cells.size, inflight: this.inflight, queued: this.queue.length, failures: this.failures, enabled: this.enabled, quota: { day: this.usage.day, used: Math.round(this.usage.used * 10) / 10, scan: Math.round(this.usage.scan * 10) / 10, limit: this.dailyLimit, refused: this.usage.refused } }; }
}
