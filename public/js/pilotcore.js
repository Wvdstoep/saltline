// Autopilot decisions (docs/V6-QUICK-CONTRACTS.md §4.6): harbour speed bands, the throttle cap, the look-ahead for
// shallows, off-route distance, the re-plan rate limit, the berth hand-over and storms across the route.
// Import-free and DOM-free so Node tests import it directly (test/pilot.test.mjs); public/js/autopilot.js drives it.

export const PILOT = {
  BANDS: [[1000, 4], [2500, 6], [5000, 10]],  // harbour speed limits: within m of the nearest anchor → max kn
  MIN_THR: 0.12,
  HANDOVER_M: 400,           // at max(this, 3 L) from the approach point → berth mode
  STOP_M: 120,               // berth mode stops at max(this, 1.5 L) from the berth
  LOOK_S: 90,                // look ahead this many REAL seconds of travel …
  LOOK_MIN_M: 1500, LOOK_MAX_M: 12000, LOOK_MAX_SAMPLES: 240, LOOK_STEP_M: 50,
  UKC_LIVE_M: 1.0,           // live check uses the current tide, so a smaller margin than planning
  OFF_ROUTE_M: 500,          // re-plan when further than max(this, 5 L) off the current leg
  REPLAN_MIN_MS: 20000, CHECK_MS: 1000,
  STORM_MIN: 0.6,            // storm cells at or above this intensity are avoided (= WARP.MAX_STORM, where warp stops)
  STORM_HORIZON_H: 6, STORM_HORIZON_MIN_M: 30000,   // look this far along the remaining route: max(30 km, 6 ship hours at SOG)
  STORM_REPLAN_MS: 600000,   // one storm re-plan per storm id per 10 minutes (real time)
};
const KN_MS = 0.514444, R_EARTH = 6371000, D2R = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function hav(a, b) {
  const p1 = a.lat * D2R, p2 = b.lat * D2R, dp = (b.lat - a.lat) * D2R, dl = (b.lon - a.lon) * D2R;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}
const lerp = (a, b, t) => ({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (((b.lon - a.lon + 540) % 360) - 180) * t });
// local plane (m) about `o`
function xy(o, p) { return [(((p.lon - o.lon + 540) % 360) - 180) * D2R * R_EARTH * Math.cos(o.lat * D2R), (p.lat - o.lat) * D2R * R_EARTH]; }
const pt = (p) => (Array.isArray(p) ? { lat: p[0], lon: p[1] } : p);

/** Harbour speed limit (kn) at `distAnchorM` from the nearest harbour anchor; Infinity outside the bands. */
export function speedCapKn(distAnchorM) {
  if (!Number.isFinite(distAnchorM)) return Infinity;
  for (const [m, kn] of PILOT.BANDS) if (distAnchorM <= m) return kn;
  return Infinity;
}
/** Telegraph order that holds a ship of top speed `maxKn` at or under `capKn` (MIN_THR … 1; Infinity → 1). */
export function throttleCap(capKn, maxKn) {
  if (!Number.isFinite(capKn)) return 1;
  if (!(maxKn > 0)) return 1;
  return clamp(capKn / maxKn, PILOT.MIN_THR, 1);
}
/** How far ahead (m) the live depth check looks: LOOK_S real seconds of travel at the warp level, clamped. */
export function lookAheadM(spdKn, warp = 1) {
  const w = Number(warp) > 1 ? Number(warp) : 1;
  return clamp(Math.abs(Number(spdKn) || 0) * KN_MS * w * PILOT.LOOK_S, PILOT.LOOK_MIN_M, PILOT.LOOK_MAX_M);
}
/**
 * Walk the route ahead of the ship (ship → route[0] → route[1] …) for `maxM`, sampling every LOOK_STEP_M (at most
 * LOOK_MAX_SAMPLES samples), and return the first sample with depth under `needM`: { distM, depthM, lat, lon } or null.
 * depthFn(lat, lon) → metres of water, or null when unknown (skipped).
 */
export function firstShoal(ship, route, maxM, depthFn, needM) {
  if (!ship || !Array.isArray(route) || !route.length || !(maxM > 0)) return null;
  const step = Math.max(PILOT.LOOK_STEP_M, maxM / PILOT.LOOK_MAX_SAMPLES);
  let a = { lat: ship.lat, lon: ship.lon }, cum = 0, next = step;
  for (const raw of route) {
    const b = pt(raw); if (!b || !Number.isFinite(b.lat)) continue;
    const L = hav(a, b);
    while (next <= cum + L && next <= maxM) {
      const t = L > 0 ? (next - cum) / L : 1, p = lerp(a, b, t);
      const d = depthFn(p.lat, p.lon);
      if (d != null && Number.isFinite(d) && d < needM) return { distM: next, depthM: d, lat: p.lat, lon: p.lon };
      next += step;
    }
    cum += L; a = b;
    if (cum >= maxM) break;
  }
  return null;
}
/**
 * Cross-track distance (m) of the ship from the current leg route[0] → route[1] (the autopilot passes the last waypoint
 * reached, or where the leg began, as route[0]); beyond a leg end the distance to that end. One point: the distance to it
 * is not "off route" → 0.
 */
export function offRouteM(ship, route) {
  if (!ship || !Array.isArray(route) || route.length < 2) return 0;
  const a = pt(route[0]), b = pt(route[1]);
  const [ax, ay] = xy(ship, a), [bx, by] = xy(ship, b);
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? clamp(-(ax * dx + ay * dy) / L2, 0, 1) : 0;
  return Math.hypot(ax + dx * t, ay + dy * t);
}
/**
 * Re-plan now? state: { lastPlanMs, inFlight }. Never while a plan is in flight, at most every REPLAN_MIN_MS; then for a
 * shoal ahead, a storm across the route, or more than max(OFF_ROUTE_M, 5 L) off the leg.
 */
export function shouldReplan(state, nowMs, { shoal = null, offM = 0, L = 0, storm = false } = {}) {
  if (!state || state.inFlight) return false;
  if (Number.isFinite(state.lastPlanMs) && nowMs - state.lastPlanMs < PILOT.REPLAN_MIN_MS) return false;
  return !!shoal || !!storm || offM > Math.max(PILOT.OFF_ROUTE_M, 5 * (Number(L) || 0));
}
/**
 * Berth hand-over: 'route' (keep sailing the route), 'berth' (follow the berth guidance line), 'stop' (engines stopped).
 * Within max(HANDOVER_M, 3 L) of the approach point: berth mode when the guide has a plan, else stop there. In berth
 * mode: stop at max(STOP_M, 1.5 L) from the berth (or when the guide is lost).
 */
export function handoverStep({ remainingToApproachM, L = 0, guideReady = false, guideRemainingM = null, mode = 'route' } = {}) {
  const stopAt = Math.max(PILOT.STOP_M, 1.5 * (Number(L) || 0));
  if (mode === 'berth') {
    if (!guideReady) return 'stop';
    return guideRemainingM != null && guideRemainingM <= stopAt ? 'stop' : 'berth';
  }
  if (!(remainingToApproachM <= Math.max(PILOT.HANDOVER_M, 3 * (Number(L) || 0)))) return 'route';
  if (!guideReady) return 'stop';
  return guideRemainingM != null && guideRemainingM <= stopAt ? 'stop' : 'berth';
}
/**
 * The first storm cell (intensity ≥ minIntensity) whose disc a leg of the remaining route (ship → route[0] → …) passes
 * through within `horizonM` of route distance: { storm, distM } (distM = route distance to where the leg enters the
 * disc; 0 when the ship is inside it) or null.
 */
export function stormOnRoute(ship, route, storms, { minIntensity = PILOT.STORM_MIN, horizonM = PILOT.STORM_HORIZON_MIN_M } = {}) {
  if (!ship || !Array.isArray(route) || !route.length || !Array.isArray(storms) || !storms.length) return null;
  const cells = storms.filter((s) => s && Number.isFinite(s.lat) && Number.isFinite(s.lon) && (Number(s.intensity) || 0) >= minIntensity && s.radiusKm > 0);
  if (!cells.length) return null;
  let best = null;
  let a = { lat: ship.lat, lon: ship.lon }, cum = 0;
  for (const raw of route) {
    const b = pt(raw); if (!b || !Number.isFinite(b.lat)) continue;
    const L = hav(a, b);
    for (const s of cells) {
      const R = s.radiusKm * 1000;
      const [ax, ay] = xy(s, a), [bx, by] = xy(s, b);
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      let tIn = null;
      if (ax * ax + ay * ay <= R * R) tIn = 0;
      else if (L2 > 0) { // |a + t d|² = R² → smallest t in [0, 1]
        const B = 2 * (ax * dx + ay * dy), Cc = ax * ax + ay * ay - R * R, disc = B * B - 4 * L2 * Cc;
        if (disc >= 0) { const t = (-B - Math.sqrt(disc)) / (2 * L2); if (t >= 0 && t <= 1) tIn = t; }
      }
      if (tIn == null) continue;
      const distM = cum + tIn * L;
      if (distM <= horizonM && (!best || distM < best.distM)) best = { storm: s, distM };
    }
    cum += L; a = b;
    if (cum > horizonM || best) break;
  }
  return best;
}
