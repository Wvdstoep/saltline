// Berth guidance (V5-PLAN item 2), server side: which berth `you.nearBerth` leads a ship to. Pure (no game state), so
// game.js decides fit / occupancy and the tests can drive it directly.
import { haversine } from '../shared/geo.js';

export const GUIDE = {
  RANGE_M: 6000,        // you.nearBerth is reported this far from the target berth
  ALONGSIDE_M: 150,     // a fitting berth this close becomes the target (the one the ship is coming alongside) …
  ALONGSIDE_KN: 3,      // … but only at manoeuvring speed: a ship sailing past a quay is not coming alongside it
  OCCUPIED_MUL: 3,      // a berth another skipper lies at counts as this many times further away
  SWITCH_FRAC: 0.35,    // a sticky target is dropped for another fitting berth this many times its distance away
};

/**
 * Pick the berth to guide a ship to.
 *   berths    the harbour's berths ({ id, lat, lon, hdg, … })
 *   lat, lon  the ship
 *   why(b)    null when the berth takes this ship (game.berthFits), else the reason it does not
 *   occupied  Set of berth ids other skippers are moored at
 *   prevId    the previous target (sticky: the leading line must not jump around while the ship moves)
 *   spdKn     the ship's speed (kn); the "coming alongside" override only applies at or below GUIDE.ALONGSIDE_KN
 * Returns { berth, distM, fits, why } — the nearest fitting free berth (sticky), else the nearest berth with `why` —
 * or null without berths.
 */
export function pickGuideBerth({ berths, lat, lon, why = () => null, occupied = null, prevId = null, spdKn = 0 }) {
  const list = (berths || []).filter((b) => b && Number.isFinite(b.lat) && Number.isFinite(b.lon) && Number.isFinite(b.hdg));
  if (!list.length || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const rows = list.map((b) => ({ b, d: haversine(lat, lon, b.lat, b.lon), why: why(b) || null, occ: !!occupied?.has?.(b.id) }));
  const fit = rows.filter((r) => !r.why);
  if (!fit.length) {
    const r = rows.sort((x, y) => x.d - y.d)[0];
    return { berth: r.b, distM: r.d, fits: false, why: r.why };
  }
  const score = (r) => r.d * (r.occ ? GUIDE.OCCUPIED_MUL : 1);
  const nearest = fit.slice().sort((x, y) => x.d - y.d)[0];
  const best = fit.slice().sort((x, y) => score(x) - score(y))[0];
  let pick = best;
  if (nearest.d <= GUIDE.ALONGSIDE_M && !(Math.abs(spdKn) > GUIDE.ALONGSIDE_KN)) pick = nearest; // coming alongside this one
  else {
    const prev = prevId ? fit.find((r) => r.b.id === prevId && !r.occ) : null;
    if (prev && !(score(best) < prev.d * GUIDE.SWITCH_FRAC)) pick = prev;
  }
  return { berth: pick.b, distM: pick.d, fits: true, why: null };
}

/** The nearest berth within `rangeM` that takes the ship (dock: moor at the one that fits, not the pontoon next to it). */
export function fittingBerthWithin(berths, lat, lon, rangeM, why = () => null) {
  let best = null, bd = Infinity;
  for (const b of berths || []) {
    if (!b || !Number.isFinite(b.lat) || !Number.isFinite(b.lon)) continue;
    const d = haversine(lat, lon, b.lat, b.lon);
    if (d <= rangeM && d < bd && !why(b)) { bd = d; best = b; }
  }
  return best;
}
