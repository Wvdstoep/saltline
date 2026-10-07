// Live marine weather from Open-Meteo (no key), docs/V3-CONTRACTS.md §2. Cached per 0.5° cell with a TTL,
// concurrency- and rate-limited, offline-safe: sample() never throws and returns null until a cell is cached.
const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const MARINE = 'https://marine-api.open-meteo.com/v1/marine';
const UA = 'Saltline/0.3 (weather; https://github.com/Wvdstoep/saltline)';

export class WeatherService {
  constructor({ fetchImpl, log, cellDeg = 0.5, ttlMs = 20 * 60e3, maxConcurrent = 2, now } = {}) {
    this.fetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    this.log = log || (() => {});
    this.cellDeg = cellDeg; this.ttlMs = ttlMs; this.maxConcurrent = maxConcurrent;
    this.now = now || (() => Date.now());
    this.cells = new Map();        // key -> sample
    this.queue = [];               // keys waiting
    this.queued = new Set();
    this.inflight = 0;
    this.failures = 0; this.consecutive = 0; this.disabledUntil = 0; this.backoffUntil = 0;
    this.window = []; // request timestamps in the last minute
    this.forceOff = process.env.SALTLINE_OFFLINE === '1' || !this.fetch;
    this.gridIdx = 0; this.lastGrid = 0;
    this.grid = [];
    for (let lat = 50; lat <= 61; lat += 2) for (let lon = -6; lon <= 12; lon += 3) this.grid.push([lat, lon]);
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
  request(lat, lon) {
    if (!this.enabled || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const k = this.key(lat, lon), s = this.cells.get(k);
    if (s && this.now() - s.fetchedAt < this.ttlMs) return;
    if (this.queued.has(k) || this.queue.length > 400) return;
    this.queued.add(k); this.queue.push(k);
  }
  tick() {
    const now = this.now();
    if (!this.enabled) return;
    if (now - this.lastGrid > 2000 && this.gridIdx < this.grid.length) { this.lastGrid = now; const [a, b] = this.grid[this.gridIdx++]; this.request(a, b); }
    if (now < this.backoffUntil) return;
    this.window = this.window.filter((t) => now - t < 60e3);
    while (this.inflight < this.maxConcurrent && this.queue.length && this.window.length < 60) {
      const k = this.queue.shift(); this.queued.delete(k);
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
    const f = await this.get(`${FORECAST}?${q}&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl,temperature_2m,precipitation,visibility,cloud_cover&wind_speed_unit=ms`);
    let m = null;
    try { m = await this.get(`${MARINE}?${q}&current=wave_height,wave_direction,wave_period,swell_wave_height,swell_wave_direction,swell_wave_period`); } catch { m = null; } // inland cells have no marine data
    const c = f?.current || {}, mc = m?.current || {};
    const num = (v, d) => (Number.isFinite(+v) && v !== null ? +v : d);
    const spd = num(c.wind_speed_10m, 5);
    return {
      lat, lon, fetchedAt: this.now(), source: 'open-meteo',
      wind: { spd, dir: num(c.wind_direction_10m, 240), gust: num(c.wind_gusts_10m, spd * 1.3) },
      waves: { height: num(mc.wave_height, Math.min(8, 0.021 * spd * spd)), dir: num(mc.wave_direction, num(c.wind_direction_10m, 240)), period: num(mc.wave_period, 3 + spd * 0.35) },
      swell: { height: num(mc.swell_wave_height, 0.3), dir: num(mc.swell_wave_direction, 270), period: num(mc.swell_wave_period, 9) },
      pressure: num(c.pressure_msl, 1013), temp: num(c.temperature_2m, 12), precip: num(c.precipitation, 0),
      visibility: num(c.visibility, 20000), cloud: num(c.cloud_cover, 40) / 100,
    };
  }
  stats() { return { cells: this.cells.size, inflight: this.inflight, queued: this.queue.length, failures: this.failures, enabled: this.enabled }; }
}
