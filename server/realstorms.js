// Real storms: severe weather found in the real Open-Meteo forecast and marine data, published on the chart as named
// storm areas (kind 'real'), beside the game's own storm cells.
//
// Detection input = every cached WeatherService sample (the ship and harbour cells cost nothing extra) plus a coarse
// scan: sea points on a `gridDeg` lattice within `nearKm` of the online players and ships at sea, nearest first,
// fetched as ONE multi-location forecast + marine request per batch (WeatherService.fetchBatch) at most every
// `minIntervalMs`, each point re-scanned after `refreshMs`. The scan spends the 'scan' share of the daily quota
// (WeatherService.canSpend: ≤ 30 % of the day's calls, paced over the UTC day), so it can never starve the ship cells.
//
// A sample is severe at Beaufort 8+ (mean wind ≥ 17.2 m/s) or a significant wave height ≥ 4 m (marine data only).
// Severe samples within `linkDeg` of each other form one area: centre = severity-weighted centroid, radius = the
// farthest member + half a grid step (≥ 90 km), Beaufort / Hs = the worst member. Areas keep their id (and name)
// while they overlap an area of the previous detection, so a storm tracked across scans stays the same storm.
import { haversine, bearing, normDeg } from '../shared/geo.js';
import { beaufort, BFT_WORD } from '../shared/seastate.js';

export const REAL_STORM = { WIND: 17.2, HS: 4, MAX_AGE_MS: 3 * 3600e3 };

// Named sea areas for the labels (first box that contains the point wins; boxes are lat/lon rectangles).
const SEA_AREAS = [
  ['North Sea', 51, 61, -4, 9], ['Skagerrak', 57, 59.5, 7, 12], ['Baltic Sea', 53.5, 66, 12, 30], ['English Channel', 48.5, 51.2, -6, 2],
  ['Irish Sea', 51.5, 55, -6.5, -2.8], ['Celtic Sea', 48.5, 52, -11, -5], ['Bay of Biscay', 43, 48.5, -10, -1], ['Norwegian Sea', 61, 72, -5, 15],
  ['Barents Sea', 69, 80, 15, 60], ['Mediterranean', 30, 46, -6, 36], ['Black Sea', 40.5, 47, 27, 42], ['Gulf of Mexico', 18, 31, -98, -80],
  ['Caribbean Sea', 9, 22, -88, -59], ['Labrador Sea', 52, 66, -66, -42], ['Bering Sea', 51, 66, 162, 200], ['Sea of Japan', 33, 52, 127, 142],
  ['South China Sea', 0, 23, 99, 121], ['Bay of Bengal', 5, 23, 79, 95], ['Arabian Sea', 5, 26, 50, 78], ['Tasman Sea', -48, -28, 147, 175],
  ['Southern Ocean', -80, -50, -180, 180], ['North Atlantic', 0, 70, -80, 0], ['South Atlantic', -50, 0, -70, 20], ['Indian Ocean', -50, 26, 20, 120],
  ['North Pacific', 0, 66, 100, 260], ['South Pacific', -50, 0, 120, 290],
];
export function seaAreaName(lat, lon) {
  for (const [n, a, b, c, d] of SEA_AREAS) {
    for (const L of [lon, lon + 360]) if (lat >= a && lat <= b && L >= c && L <= d) return n;
  }
  return `${Math.abs(Math.round(lat))}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(Math.round(lon))}°${lon >= 0 ? 'E' : 'W'}`;
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const marineHs = (s) => (s && s.marine !== false && s.waves && Number.isFinite(s.waves.height) ? s.waves.height : null);
/** Is a WeatherService sample severe (Bft 8+ or Hs ≥ 4 m)? */
export function isSevere(s) {
  if (!s || !s.wind) return false;
  const hs = marineHs(s);
  return (Number(s.wind.spd) || 0) >= REAL_STORM.WIND || (hs != null && hs >= REAL_STORM.HS);
}

/**
 * Severe samples → storm areas [{ id, kind:'real', name, lat, lon, radiusKm, intensity, bft, windMs, gustMs, hs, … }].
 * `prev` (the last detection) keeps ids/names stable. Pure; `now` is ms.
 */
export function detectRealStorms(samples, { gridDeg = 2, linkDeg, prev = [], now = Date.now(), maxAgeMs = REAL_STORM.MAX_AGE_MS } = {}) {
  const pts = (samples || []).filter((s) => s && Number.isFinite(s.lat) && Number.isFinite(s.lon) && now - (s.fetchedAt || 0) <= maxAgeMs && isSevere(s));
  const link = (linkDeg ?? gridDeg * 1.6) * 111;   // km
  // union-find over the severe points (n is small: tens)
  const par = pts.map((_, i) => i);
  const find = (i) => { while (par[i] !== i) i = par[i] = par[par[i]]; return i; };
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    if (haversine(pts[i].lat, pts[i].lon, pts[j].lat, pts[j].lon) / 1000 <= link) par[find(i)] = find(j);
  }
  const groups = new Map();
  pts.forEach((p, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(p); });
  const out = [], used = new Set();
  for (const g of groups.values()) {
    let sw = 0, x = 0, y = 0, z = 0, wind = 0, gust = 0, hs = 0, dirX = 0, dirY = 0, pmin = Infinity;
    for (const s of g) {
      const h = marineHs(s) ?? 0, sev = Math.max(0.2, (s.wind.spd - 12) / 10 + Math.max(0, h - 2.5) / 3);
      const la = s.lat * Math.PI / 180, lo = s.lon * Math.PI / 180;
      x += Math.cos(la) * Math.cos(lo) * sev; y += Math.cos(la) * Math.sin(lo) * sev; z += Math.sin(la) * sev; sw += sev;
      wind = Math.max(wind, s.wind.spd); gust = Math.max(gust, s.wind.gust || s.wind.spd); hs = Math.max(hs, h);
      dirX += Math.sin((s.wind.dir || 0) * Math.PI / 180) * sev; dirY += Math.cos((s.wind.dir || 0) * Math.PI / 180) * sev;
      if (Number.isFinite(s.pressure)) pmin = Math.min(pmin, s.pressure);
    }
    const lat = Math.atan2(z, Math.hypot(x, y)) * 180 / Math.PI, lon = Math.atan2(y, x) * 180 / Math.PI;
    let r = 0; for (const s of g) r = Math.max(r, haversine(lat, lon, s.lat, s.lon) / 1000);
    const radiusKm = Math.round(Math.max(90, r + gridDeg * 111 * 0.5));
    const bft = beaufort(wind);
    // intensity on the game's scale (Vmax = 36·I^0.6 m/s) or from the sea, whichever is worse
    const iWind = Math.pow(Math.min(1, wind / 36), 1 / 0.6), iSea = Math.min(1, Math.max(0, (hs - 2) / 10));
    const intensity = Math.round(Math.max(0.15, iWind, iSea) * 100) / 100;
    // keep the id of an overlapping area from the last detection
    let id = null, name = null;
    for (const p of prev) {
      if (used.has(p.id)) continue;
      if (haversine(lat, lon, p.lat, p.lon) / 1000 < radiusKm + p.radiusKm) { id = p.id; name = p.area; used.add(p.id); break; }
    }
    const area = name || seaAreaName(lat, lon);
    id = id || `r${Math.round((lat + 90) * 10)}x${Math.round((normDeg(lon)) * 10)}x${Math.floor(now / 60000) % 100000}`;
    const word = bft >= 8 ? BFT_WORD[bft] : hs >= 9 ? 'very high seas' : 'high seas';
    out.push({
      id, kind: 'real', area, name: `${cap(word)} · ${area}`, lat, lon, radiusKm, intensity, bft,
      windMs: Math.round(wind * 10) / 10, gustMs: Math.round(gust * 10) / 10, hs: Math.round(hs * 10) / 10,
      windDir: Math.round(normDeg(Math.atan2(dirX, dirY) * 180 / Math.PI)), pressure: Number.isFinite(pmin) ? Math.round(pmin) : null,
      cells: g.length, updated: now,
      // overlay fields (only used over the synthetic fallback): a fully developed sea, no drift known
      driftDir: 0, driftMs: 0, born: 0, devH: 24,
    });
  }
  out.sort((a, b) => b.intensity - a.intensity);
  return out;
}

/** The scan scheduler + the published list. `weather` is a WeatherService (fetchBatch, cells, canSpend). */
export class RealStorms {
  constructor(weather, { isWater = () => true, log = () => {}, now, gridDeg = 2, nearKm = 1200, batch = 40, minIntervalMs = 5 * 60e3, refreshMs = 90 * 60e3, maxStorms = 12 } = {}) {
    this.weather = weather; this.isWater = isWater; this.log = log;
    this.now = now || (() => (weather && typeof weather.now === 'function' ? weather.now() : Date.now()));
    Object.assign(this, { gridDeg, nearKm, batch, minIntervalMs, refreshMs, maxStorms });
    this.scanned = new Map();   // "lat|lon" grid point -> ms of the last scan
    this.scanSamples = new Map(); // grid point -> sample
    this.lastScan = -Infinity; this.busy = false;
    this.list = [];
    this.waterMemo = new Map();
  }
  water(lat, lon) {
    const k = `${lat}|${lon}`;
    let v = this.waterMemo.get(k);
    if (v === undefined) { try { v = !!this.isWater(lat, lon); } catch { v = false; } this.waterMemo.set(k, v); if (this.waterMemo.size > 20000) this.waterMemo.clear(); }
    return v;
  }
  /** Grid sea points due for a scan near `points` ([{lat, lon}]), nearest to a player first. */
  candidates(points) {
    const d = this.gridDeg, now = this.now(), seen = new Map();
    for (const p of points || []) {
      if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
      const span = Math.ceil(this.nearKm / 111 / d);
      const la0 = Math.round(p.lat / d) * d, lo0 = Math.round(p.lon / d) * d;
      for (let i = -span; i <= span; i++) {
        const lat = la0 + i * d; if (Math.abs(lat) > 78) continue;
        const kl = Math.max(0.2, Math.cos(lat * Math.PI / 180));
        const spanLon = Math.min(Math.ceil(180 / d), Math.ceil(span / kl));
        for (let j = -spanLon; j <= spanLon; j++) {
          const lon = ((lo0 + j * d + 540) % 360) - 180;
          const dk = haversine(p.lat, p.lon, lat, lon) / 1000;
          if (dk > this.nearKm) continue;
          const k = `${lat}|${lon}`;
          const old = seen.get(k); if (old !== undefined && old <= dk) continue;
          seen.set(k, dk);
        }
      }
    }
    const out = [];
    for (const [k, dk] of seen) {
      const t = this.scanned.get(k);
      if (t !== undefined && now - t < this.refreshMs) continue;
      const [lat, lon] = k.split('|').map(Number);
      if (!this.water(lat, lon)) continue;
      out.push({ lat, lon, dk, k });
    }
    out.sort((a, b) => a.dk - b.dk);
    return out;
  }
  /** Every ~30 s from Game.requestWeather: maybe start one scan batch, then re-detect from everything cached. */
  tick(points) {
    const now = this.now();
    if (!this.busy && now - this.lastScan >= this.minIntervalMs && this.weather && typeof this.weather.fetchBatch === 'function' && this.weather.enabled !== false) {
      const due = this.candidates(points).slice(0, this.batch);
      if (due.length) {
        const cost = typeof this.weather.batchCost === 'function' ? this.weather.batchCost(due.length) : due.length * 2.2;
        if (typeof this.weather.canSpend !== 'function' || this.weather.canSpend(cost, 'scan')) {
          this.lastScan = now; this.busy = true;
          Promise.resolve(this.weather.fetchBatch(due, 'scan')).then((res) => {
            for (const d of due) this.scanned.set(d.k, now);
            for (const s of res || []) this.scanSamples.set(`${s.lat}|${s.lon}`, s);
            this.detect();
          }).catch((e) => this.log('[realstorms] scan failed', e.message)).finally(() => { this.busy = false; });
        }
      }
    }
    this.detect();
    return this.list;
  }
  detect() {
    const now = this.now();
    const samples = [...this.scanSamples.values()];
    if (this.weather && this.weather.cells) for (const s of this.weather.cells.values()) samples.push(s);
    for (const [k, s] of this.scanSamples) if (now - (s.fetchedAt || 0) > REAL_STORM.MAX_AGE_MS) this.scanSamples.delete(k);
    this.list = detectRealStorms(samples, { gridDeg: this.gridDeg, prev: this.list, now }).slice(0, this.maxStorms);
    return this.list;
  }
  cells() { return this.list; }
  publicList() {
    return this.list.map((s) => ({ id: s.id, kind: 'real', name: s.name, lat: Math.round(s.lat * 1e4) / 1e4, lon: Math.round(s.lon * 1e4) / 1e4, radiusKm: s.radiusKm, intensity: s.intensity, bft: s.bft, windMs: s.windMs, gustMs: s.gustMs, hs: s.hs, windDir: s.windDir, pressure: s.pressure, updated: s.updated }));
  }
}
