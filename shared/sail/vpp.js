// Saltline sailing — steady-state velocity prediction (Appendix A `evalV`, `solve`, `trimmed`, `polarPoint`).
// Used by scripts/gen-polars.mjs (writes polars.gen.js) and by test/sail-polar.test.mjs (re-solves sample points).
// Not used at runtime by the game (the game reads the tables through polar.js). Kept separate from polar.js so that
// the generator never imports the table it is about to overwrite.
import { RIGS, planState, plansAt, D2R, KN } from './rigs.js';
import { aero, autoTrimSail, TYPES } from './aero.js';
import { hull, RM } from './hydro.js';

// heel by bisection, leeway by fixed point
export function evalV(rig, ss, tws10, twa, V) {
  let lam = 3, phi = 0, a, h;
  for (let it = 0; it < 5; it++) {
    let lo = 0, hi = rig.cat ? 30 : 75;
    for (let k = 0; k < 16; k++) { const m = (lo + hi) / 2; if (aero(rig, ss, tws10, twa, V, lam, m).HM > RM(rig, m)) lo = m; else hi = m; }
    phi = (lo + hi) / 2; a = aero(rig, ss, tws10, twa, V, lam, phi);
    h = hull(rig, V, phi, a.Fn * Math.cos(phi * D2R), a.Mz, a.Fx, a.HM / Math.max(a.Fn, 1e-6) - rig.zclr); lam = h.lam;
  }
  return { f: a.Fx - h.R, V, phi, lam, dr: h.dr, Hl: h.Hl, bands: a.bands };
}
// speed = largest root of drive − resistance
export function solve(rig, ss, tws10, twa) {
  let prev = evalV(rig, ss, tws10, twa, 12.5);
  for (let V = 12.0; V >= 0.05; V -= 0.5) {
    const cur = evalV(rig, ss, tws10, twa, V);
    if (cur.f > 0 && prev.f <= 0) { let lo = V, hi = V + 0.5, r = cur; for (let k = 0; k < 12; k++) { const m = (lo + hi) / 2; r = evalV(rig, ss, tws10, twa, m); if (r.f > 0) lo = m; else hi = m; } return r; }
    prev = cur;
  }
  const r = evalV(rig, ss, tws10, twa, 0.05); r.V = 0; return r;
}
export function trimmed(rig, tws10, twa, lv, k) {
  const ss = planState(rig, lv); let r;
  for (let it = 0; it < 4; it++) { r = solve(rig, ss, tws10, twa); for (const b of r.bands) { const s = rig.sails.find((x) => x.id === b.id); Object.assign(ss[b.id], autoTrimSail(s, b.be, k * TYPES[s.type].as)); } }
  return { ...r, ss };
}
/** polar point: best plan level allowed at this wind × trim factor k ∈ {0.8, 0.95, 1.1} → { V (m/s), phi, lam, lv, k, … } */
export function polarPoint(cls, twsKn, twa) {
  const rig = RIGS[cls]; let b = null;
  for (const lv of plansAt(rig, twsKn)) for (const k of [0.8, 0.95, 1.1]) { const r = trimmed(rig, twsKn * KN, twa, lv, k); if (!b || r.V > b.V) b = { ...r, lv, k }; }
  return b;
}
