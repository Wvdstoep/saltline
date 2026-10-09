// Server side of the sheltered-water sea state (docs/BRIDGES-LOCKS-VHF-CONTRACT.md §4.11): ray casting over the
// navigable mask with a cache per 200 m cell, 10° of wind direction and 10 minutes.
import { castRays, shelterWeather, RAY_MAX } from '../shared/shelter.js';

const D2R = Math.PI / 180;
/**
 * createShelter({ navigable(lat, lon) → bool, cellKind(lat, lon) → 'lock'|'dock'|'water', now() → s, maxEntries })
 * → { apply(weather, lat, lon), rays(lat, lon, fromDeg), stats() }
 */
export function createShelter({ navigable, cellKind = () => 'water', now = () => Date.now() / 1000, maxEntries = 4000, ttl = 600 } = {}) {
  const cache = new Map();
  let hits = 0, misses = 0;
  const key = (lat, lon, dir) => {
    const cy = Math.round((lat * 110540) / 200), cx = Math.round((lon * 111320 * Math.cos(lat * D2R)) / 200);
    return `${cy}:${cx}:${Math.round((((dir % 360) + 360) % 360) / 10) % 36}`;
  };
  function rays(lat, lon, fromDeg) {
    const k = key(lat, lon, fromDeg), t = now(), c = cache.get(k);
    if (c && t - c.t < ttl) { hits++; return c.r; }
    misses++;
    const r = castRays(navigable, lat, lon, Math.round(fromDeg / 10) * 10);
    if (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
    cache.set(k, { t, r });
    return r;
  }
  function apply(w, lat, lon) {
    if (!w || !navigable || process.env.SALTLINE_WW_OFF === '1') return w;
    const windRays = rays(lat, lon, w.windDir ?? 0);
    const cell = cellKind(lat, lon);
    if (cell === 'water' && windRays.slice().sort((a, b) => a - b)[3] >= RAY_MAX) return w;   // open sea: untouched
    const swellRays = (w.swellH || 0) > 0 ? rays(lat, lon, w.swellDir ?? w.windDir ?? 0) : [];
    return shelterWeather(w, { windRays, swellRays, cell });
  }
  return { apply, rays, stats: () => ({ size: cache.size, hits, misses }) };
}
