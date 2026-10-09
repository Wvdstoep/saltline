// Water levels and reference datums (docs/BRIDGES-LOCKS-VHF-CONTRACT.md §4.1). Pure, browser-safe.
// Game frame: y = 0 is model mean sea level ≈ NAP in the Netherlands. Tidal water follows shared/tide.js; non-tidal
// pounds (canals and lakes behind locks) are constant at their streefpeil / KP. Clearances are published above a datum;
// `datumOffset` converts that datum to the game frame so that  deck underside y = clr + datumOffset(datum).
import { tideAt, lowWaterAt } from './tide.js';

export const DATUMS = ['NAP', 'KP', 'MHWS', 'LAT', 'MSL'];

/** M2 amplitude of the tide.js region (m), recovered from lowWaterAt = −1.33 × M2. */
export function m2At(lat, lon) { return -lowWaterAt(lat, lon) / 1.33; }

/** Height of a datum above the game zero (m). KP = that pound's level (`kp`, default 0). MHWS = +1.33 × M2, LAT = lowWaterAt. */
export function datumOffset(datum, lat, lon, kp = null) {
  switch (datum) {
    case 'KP': return Number.isFinite(kp) ? kp : 0;
    case 'MHWS': return 1.33 * m2At(lat, lon);
    case 'LAT': return lowWaterAt(lat, lon);
    case 'NAP': case 'MSL': default: return 0;
  }
}

/** Ray-cast point-in-polygon on [lat, lon] rings. */
export function inPoly(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i], [yj, xj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Pound containing the point, from a levels list ({ pounds: [{ id, name, h, hSummer?, poly, bbox? }] } or an array). */
export function poundAt(lat, lon, levels) {
  const list = Array.isArray(levels) ? levels : levels && levels.pounds;
  if (!list) return null;
  for (const p of list) {
    if (p.verified === false && !p.useUnverified) continue;
    const bb = p.bbox || (p.bbox = bboxOf(p.poly));
    if (lat < bb[0] || lat > bb[2] || lon < bb[1] || lon > bb[3]) continue;
    if (inPoly(lat, lon, p.poly)) return p;
  }
  return null;
}
function bboxOf(poly) { let s = 90, w = 180, n = -90, e = -180; for (const [a, b] of poly) { s = Math.min(s, a); n = Math.max(n, a); w = Math.min(w, b); e = Math.max(e, b); } return [s, w, n, e]; }

/** Summer (Apr–Sep) or winter level of a pound at time t (s). */
export function poundLevel(p, t) {
  if (!Number.isFinite(p.hSummer)) return p.h;
  const m = new Date(t * 1000).getUTCMonth();
  return m >= 3 && m <= 8 ? p.hSummer : p.h;
}

/**
 * Water height in the game frame.
 * ctx.levels: pounds (levels-nl.json); ctx.inlandRiver(lat, lon) → true when the D14 mask says RIVER > 50 km from the coast
 * (outside NL; constant 0, Q7). → { h, ref: 'tidal'|'canal', datum, pound? }
 */
export function waterLevelAt(lat, lon, t, ctx = {}) {
  const p = poundAt(lat, lon, ctx.levels);
  if (p) { const h = poundLevel(p, t); return { h, ref: 'canal', datum: 'KP', pound: p.id || p.name || null }; }
  if (ctx.inlandRiver && ctx.inlandRiver(lat, lon)) return { h: 0, ref: 'canal', datum: 'KP', pound: null };
  return { h: tideAt(lat, lon, t).height, ref: 'tidal', datum: 'NAP' };
}

/** Level of a lock side (§4.8.1 Level) at time t: tidal | { kind:'kp', h } | { kind:'damped', of:'tidal', k, lagMin }. */
export function sideLevel(level, lat, lon, t) {
  if (!level || level.kind === 'tidal') return tideAt(lat, lon, t).height;
  if (level.kind === 'kp') return Number.isFinite(level.h) ? level.h : 0;
  if (level.kind === 'damped') return (level.k ?? 0.6) * tideAt(lat, lon, t - (level.lagMin ?? 40) * 60).height;
  return 0;
}
