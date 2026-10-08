// Safe arrival finder for the express passage (docs/V7-PLAN.md step 0 "Fixes first").
//
// Pure: everything about the world comes in through callbacks, so it is testable without a game. A spot is safe when
//  * the water at the spot is at least draught + 3 m deep at LOW water,
//  * every sample on a clear circle of radius max(ship length, 150 m) (rings at 1, ¾, ½ and ¼ of it, every 10°) is water
//    at least draught + 1 m deep at low water — room to swing and to manoeuvre (dense enough for the narrow river /
//    dock geometry of the big ports, V7 step 0),
//  * no other ship (players, AI traffic, cutters, AIS, tugs) lies within max(300 m, 2 ship lengths) (+ half their length).
// Candidates are searched in rings around the aim point, nearest ring first.
import { haversine, bearing, destination } from '../shared/geo.js';

export const SAFE = {
  KEEL_CENTRE_M: 3,     // depth under the keel at the spot itself (low water)
  KEEL_RING_M: 1,       // depth under the keel everywhere on the clear circle (low water)
  RING_MIN_M: 150,      // clear circle radius: max(ship length, this)
  SEP_MIN_M: 300,       // separation from other ships: max(this, 2 ship lengths)
  RING_SAMPLES: 36,
  STEP_M: 100,          // ring spacing of the candidate search
  HARBOUR_NEAR_M: 6000, // a destination this close to a harbour arrives on its approach
  APPROACH_M: 1750,     // … this far out from the harbour anchor (1.5–2 km)
  APPROACH_BAND_M: [1500, 2000],
};

export const clearRadius = (length) => Math.max(Number(length) || 0, SAFE.RING_MIN_M);
export const separation = (length) => Math.max(SAFE.SEP_MIN_M, 2 * (Number(length) || 0));

/**
 * Is (lat, lon) a safe place to put the ship? Returns null when it is, else a short reason ('depth' | 'room' | 'traffic').
 * @param {object} o { draft, length, depthLW(lat, lon) → metres of water at low water (≤ 0 on land), others: [{lat, lon, len?}] }
 */
export function spotProblem(lat, lon, o) {
  const draft = Number(o.draft) || 0;
  const d0 = o.depthLW(lat, lon);
  if (!(d0 >= draft + SAFE.KEEL_CENTRE_M)) return 'depth';
  const others = o.others || [], sep = separation(o.length);
  for (const s of others) {
    if (!s || !Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
    if (haversine(lat, lon, s.lat, s.lon) < sep + (Number(s.len) || 0) / 2) return 'traffic';
  }
  const R = clearRadius(o.length), need = draft + SAFE.KEEL_RING_M, n = SAFE.RING_SAMPLES;
  for (const [r, k] of [[R, n], [R * 0.75, n], [R / 2, n], [R / 4, n]]) {
    for (let i = 0; i < k; i++) {
      const q = destination(lat, lon, (360 * i) / k, r);
      if (!(o.depthLW(q.lat, q.lon) >= need)) return 'room';
    }
  }
  return null;
}

/**
 * Nearest safe spot to `aim` within maxRadiusM: {lat, lon, offM} or null.
 * o = { draft, length, depthLW, others, maxRadiusM = 5000, stepM = SAFE.STEP_M, accept?(lat, lon) → bool }
 */
export function findSafeSpot(aim, o) {
  if (!aim || !Number.isFinite(aim.lat) || !Number.isFinite(aim.lon)) return null;
  const maxR = Number.isFinite(o.maxRadiusM) ? o.maxRadiusM : 5000, step = o.stepM || SAFE.STEP_M;
  const ok = (lat, lon) => (!o.accept || o.accept(lat, lon)) && spotProblem(lat, lon, o) == null;
  if (ok(aim.lat, aim.lon)) return { lat: aim.lat, lon: aim.lon, offM: 0 };
  for (let r = step; r <= maxR + 1e-6; r += step) {
    const n = Math.max(8, Math.round((2 * Math.PI * r) / step));
    let best = null;
    for (let i = 0; i < n; i++) {
      const q = destination(aim.lat, aim.lon, (360 * i) / n, r);
      if (!ok(q.lat, q.lon)) continue;
      const score = o.score ? o.score(q.lat, q.lon) : 0;
      if (!best || score > best.score) best = { lat: q.lat, lon: q.lon, offM: r, score };
    }
    if (best) return { lat: best.lat, lon: best.lon, offM: best.offM };
  }
  return null;
}

/**
 * The approach aim of a harbour: a point APPROACH_M out from the anchor along the fairway (built harbour geometry: anchor
 * → patch edge through the entrance), else along the bearing with the deepest open water. {lat, lon, hdg (toward the
 * entrance), brg (anchor → aim)}.
 * o = { anchor: {lat, lon}, fairway?: [{lat, lon}], depthLW, distM = APPROACH_M }
 */
export function harbourAim(o) {
  const a = o.anchor, distM = o.distM || SAFE.APPROACH_M;
  const fw = Array.isArray(o.fairway) ? o.fairway.filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon)) : [];
  let pt = null;
  if (fw.length >= 2) {
    // walk the fairway polyline from the anchor; past its end continue on the bearing anchor → last point
    let left = distM, prev = a;
    for (const q of fw) {
      const d = haversine(prev.lat, prev.lon, q.lat, q.lon);
      if (d >= left && d > 0) { pt = destination(prev.lat, prev.lon, bearing(prev.lat, prev.lon, q.lat, q.lon), left); break; }
      left -= d; prev = q;
    }
    if (!pt) {
      const last = fw[fw.length - 1], d = haversine(a.lat, a.lon, last.lat, last.lon);
      if (d > 50) pt = destination(a.lat, a.lon, bearing(a.lat, a.lon, last.lat, last.lon), distM);
    }
  }
  if (!pt) {
    // no fairway: the bearing whose line out to 2.5 km has the most water (mean depth, land counts heavily against)
    let bestB = 0, bestS = -Infinity;
    for (let b = 0; b < 360; b += 15) {
      let s = 0;
      for (const f of [0.3, 0.5, 0.7, 0.85, 1, 1.2, 1.45]) {
        const q = destination(a.lat, a.lon, b, distM * f);
        const d = o.depthLW(q.lat, q.lon);
        s += d > 0 ? Math.min(d, 40) : d * 5 - 50;
      }
      if (s > bestS) { bestS = s; bestB = b; }
    }
    pt = destination(a.lat, a.lon, bestB, distM);
  }
  return { lat: pt.lat, lon: pt.lon, hdg: bearing(pt.lat, pt.lon, a.lat, a.lon), brg: bearing(a.lat, a.lon, pt.lat, pt.lon) };
}
