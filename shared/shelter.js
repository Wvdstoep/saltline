// Sheltered water: fetch-limited sea state (docs/BRIDGES-LOCKS-VHF-CONTRACT.md §4.11). Pure, browser-safe.
// Inside canals, docks, rivers and lock chambers the waves come only from the wind over the short stretch of water
// upwind (the fetch). Open water (median upwind ray ≥ 20 km) is never altered.
import { douglas } from './seastate.js';

export const G = 9.81;
export const RAY_STEP = 25, RAY_MAX = 20000, RAY_SPREAD = [-30, -20, -10, 0, 10, 20, 30];
export const LOCK_HS = 0.05;
const D2R = Math.PI / 180;

/** JONSWAP fetch-limited Hs (m) and Tp (s) for 10 m wind U (m/s) over fetch F (m). */
export function fetchLimited(U, F) {
  const u = Math.max(0, U || 0), f = Math.max(0, F || 0);
  if (u <= 0 || f <= 0) return { Hs: 0, Tp: 0 };
  return { Hs: 0.0016 * u * Math.sqrt(f / G), Tp: 0.2857 * (u / G) * Math.cbrt((G * f) / (u * u)) };
}

/**
 * Cast the 7 rays from (lat, lon) toward `fromDeg` (the direction the wind or swell comes from) over the navigable mask.
 * sample(lat, lon) → true when navigable water. Each ray stops at the first non-navigable step or at RAY_MAX. → lengths (m)
 */
export function castRays(sample, lat, lon, fromDeg, { step = RAY_STEP, max = RAY_MAX } = {}) {
  const kx = 111320 * Math.cos(lat * D2R), ky = 110540;
  return RAY_SPREAD.map((d) => {
    const b = (fromDeg + d) * D2R, dn = Math.cos(b), de = Math.sin(b);
    let r = 0;
    while (r < max) {
      const n = r + step;
      if (!sample(lat + (dn * n) / ky, lon + (de * n) / kx)) break;
      r = n;
    }
    return r;
  });
}
export const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
export const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

/** Fetch F (m) at a point for a wind direction (mean ray length) plus the exposure flag. */
export function fetchAt(sample, lat, lon, windFromDeg, opts) {
  const rays = castRays(sample, lat, lon, windFromDeg, opts);
  return { F: mean(rays), rays, exposed: median(rays) >= RAY_MAX };
}

/**
 * Apply shelter to a public weather object (game.weatherPublic shape: windSpd, waveH, wavePeriod, swellH, sea, seaState, seaWord).
 * shelter = { windRays, swellRays, cell: 'lock'|'dock'|'water', dockLen }. Open water → the SAME object is returned.
 */
export function shelterWeather(w, shelter) {
  if (!w || !shelter) return w;
  const { windRays, swellRays = [], cell = 'water' } = shelter;
  const exposed = windRays && median(windRays) >= RAY_MAX;
  if (exposed && cell === 'water') return w;
  let F = windRays ? mean(windRays) : 0;
  if (cell === 'dock') F = Math.min(F, shelter.dockLen ?? 500);
  const f = fetchLimited(w.windSpd, F);
  let Hs = Math.min(w.waveH ?? Infinity, f.Hs);
  let swellH = (w.swellH || 0) * (swellRays.length ? swellRays.filter((r) => r >= RAY_MAX).length / swellRays.length : 0);
  if (cell === 'lock') { Hs = Math.min(Hs, LOCK_HS); swellH = 0; }
  const d = douglas(Hs);
  const r2 = (v) => Math.round(v * 100) / 100, r3 = (v) => Math.round(v * 1000) / 1000;
  return {
    ...w, waveH: r3(Hs), wavePeriod: Math.round(Math.min(w.wavePeriod ?? Infinity, f.Tp || 0.1) * 100) / 100, swellH: r2(swellH),
    sea: r2(Math.min(w.sea ?? 1, Hs / 6)), seaState: d.code, seaWord: d.word, sheltered: { F: Math.round(F), cell, openWaveH: w.waveH },
  };
}
