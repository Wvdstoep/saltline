// Engine order telegraph (docs/V5-PLAN.md item 3) — shared by the client (keys, touch lever, widget, bridge console),
// the physics (astern limits) and the server (throttle clamp). Plain ESM, no dependencies, no DOM.
//
// Throttle is the engine command as a fraction of full ahead power: +1 = full ahead, 0 = stop, −0.6 = full astern
// (astern power is at most 60 % of ahead). The nine real telegraph orders map to fixed throttle values; anything in
// between is allowed too (fine control) and is shown as a percentage.

export const THROTTLE_MAX = 1;
export const THROTTLE_MIN = -0.6;          // full astern
export const ASTERN_SPEED_FRAC = 0.5;      // astern top speed ≈ half the ahead top speed (thrust 60 %, stern-first resistance higher)

// Ordered from full astern (index 0) to full ahead (index 8). `short` fits the instrument strip and the touch lever.
export const ORDERS = [
  { id: 'full_astern', name: 'Full astern', short: 'FULL AST', word: 'FULL', thr: -0.6 },
  { id: 'half_astern', name: 'Half astern', short: 'HALF AST', word: 'HALF', thr: -0.45 },
  { id: 'slow_astern', name: 'Slow astern', short: 'SLOW AST', word: 'SLOW', thr: -0.3 },
  { id: 'dead_slow_astern', name: 'Dead slow astern', short: 'D.SLOW AST', word: 'D.SLOW', thr: -0.15 },
  { id: 'stop', name: 'Stop', short: 'STOP', word: 'STOP', thr: 0 },
  { id: 'dead_slow_ahead', name: 'Dead slow ahead', short: 'D.SLOW AHD', word: 'D.SLOW', thr: 0.25 },
  { id: 'slow_ahead', name: 'Slow ahead', short: 'SLOW AHD', word: 'SLOW', thr: 0.45 },
  { id: 'half_ahead', name: 'Half ahead', short: 'HALF AHD', word: 'HALF', thr: 0.7 },
  { id: 'full_ahead', name: 'Full ahead', short: 'FULL AHD', word: 'FULL', thr: 1 },
];
export const STOP_INDEX = 4;
const EPS = 0.02; // a throttle within this of an order IS that order

const fin = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
export function clampThrottle(v) { v = fin(Number(v)); return v < THROTTLE_MIN ? THROTTLE_MIN : v > THROTTLE_MAX ? THROTTLE_MAX : v; }

/** Index of the order the throttle sits on (within EPS), or -1 when it is between orders. */
export function orderIndex(thr) {
  thr = clampThrottle(thr);
  for (let i = 0; i < ORDERS.length; i++) if (Math.abs(ORDERS[i].thr - thr) <= EPS) return i;
  return -1;
}
/** The order the throttle sits on, or null between orders. */
export function orderFor(thr) { const i = orderIndex(thr); return i < 0 ? null : ORDERS[i]; }
/** Nearest order (always one). */
export function nearestOrderIndex(thr) {
  thr = clampThrottle(thr);
  let best = 0, bd = Infinity;
  for (let i = 0; i < ORDERS.length; i++) { const d = Math.abs(ORDERS[i].thr - thr); if (d < bd - 1e-9) { bd = d; best = i; } }
  return best;
}
export function throttleFor(idOrIndex) {
  if (typeof idOrIndex === 'number') return ORDERS[Math.max(0, Math.min(ORDERS.length - 1, Math.round(idOrIndex)))].thr;
  const o = ORDERS.find((x) => x.id === idOrIndex); return o ? o.thr : 0;
}

/**
 * One telegraph step from the current command: dir = +1 (towards full ahead) or −1 (towards full astern).
 * From a value between two orders the step lands on the next order in that direction. Clamped at the ends.
 */
export function stepOrder(thr, dir) {
  thr = clampThrottle(thr);
  const d = dir > 0 ? 1 : -1;
  const i = orderIndex(thr);
  if (i >= 0) return ORDERS[Math.max(0, Math.min(ORDERS.length - 1, i + d))].thr;
  if (d > 0) { for (const o of ORDERS) if (o.thr > thr + 1e-9) return o.thr; return ORDERS[ORDERS.length - 1].thr; }
  for (let k = ORDERS.length - 1; k >= 0; k--) if (ORDERS[k].thr < thr - 1e-9) return ORDERS[k].thr;
  return ORDERS[0].thr;
}

/** Fractional order position 0 (full astern) … 4 (stop) … 8 (full ahead), piecewise-linear between orders (dials, pointers). */
export function orderPosition(thr) {
  thr = clampThrottle(thr);
  for (let i = 1; i < ORDERS.length; i++) {
    const a = ORDERS[i - 1].thr, b = ORDERS[i].thr;
    if (thr <= b) return i - 1 + (thr - a) / (b - a);
  }
  return ORDERS.length - 1;
}

/** Human label: the order name, or a percentage with ahead/astern between orders ("35 % ahead", "20 % astern"). */
export function orderLabel(thr, { short = false } = {}) {
  const o = orderFor(thr);
  if (o) return short ? o.short : o.name;
  const t = clampThrottle(thr);
  if (Math.abs(t) < 0.005) return short ? 'STOP' : 'Stop';
  // astern percentages are of full astern power (−0.6 = 100 % astern) so both ends read 100 %
  const pct = t > 0 ? Math.round(t * 100) : Math.round((-t / -THROTTLE_MIN) * 100);
  return short ? `${pct}% ${t > 0 ? 'AHD' : 'AST'}` : `${pct} % ${t > 0 ? 'ahead' : 'astern'}`;
}
export function isAstern(thr) { return clampThrottle(thr) < -0.005; }

/**
 * Engine rpm as a fraction of full-ahead rpm for the sound engine and the gauges: ahead = throttle; astern the engine
 * turns up to ~80 % of full rpm at full astern (power is limited to 60 % by the astern torque, not by rpm).
 */
export function rpmFraction(thr) {
  const t = clampThrottle(thr);
  return t >= 0 ? t : Math.min(1, (-t / -THROTTLE_MIN) * 0.8);
}

// What the ship does after an order (HUD text): STOP only stops the engine — she carries her way; ASTERN is the brake.
/** The one-line note under the order callout: what the ship will do now (spd = speed through the water, kn, + ahead). */
export function calloutNote(zone, spd) {
  if (zone === 'stop') return spd > 1 ? 'engine stopped · she carries her way for several ship lengths · ring ASTERN to brake' : spd < -1 ? 'engine stopped · she carries her sternway · ring AHEAD to stop her' : 'engine stopped';
  if (zone === 'astern') return spd > 0.5 ? 'braking: she slows, then goes astern · steering is weak · the bow swings to starboard' : 'going astern · steering is weak · the bow swings to starboard';
  return spd < -0.5 ? 'braking the sternway, then ahead' : '';
}
/** Panel hint line while the ship's way and the order disagree (null: nothing to say). */
export function motionHint(cmd, actual, spd) {
  if (Math.abs(cmd) < 0.005 && spd > 1) return `Coasting at ${spd.toFixed(1)} kn — STOP only stops the engine. Ring ASTERN to brake`;
  if (cmd < -0.005 && spd > 0.3) return actual < -0.005 ? `Braking — still ${spd.toFixed(1)} kn ahead` : 'Engine reversing — astern power coming';
  if (cmd > 0.005 && spd < -0.3) return `Braking the sternway — ${(-spd).toFixed(1)} kn astern`;
  return null;
}
