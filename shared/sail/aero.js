// Saltline sailing — sail aerodynamics (docs/SAILING-CONTRACT.md §2.2–§2.3, Appendix A `coeffs`, `aero`, trim rule).
// Ported from the reference model without changing equations or constants. Pure, deterministic.
import { SAIL_TYPES, D2R, clamp, sstep } from './rigs.js';

export const RA = 1.225, RW = 1025, G = 9.81, NU = 1.19e-6;
export const A_LUFF = 6;       // below this AoA the luff lifts (partial luffing); <= 0 flogging
export const K_IND = 0.05;     // quadratic (induced) sail drag
export const TYPES = SAIL_TYPES;

/** Sail coefficients vs angle of attack (deg): { cl, cd, st } with st 0 drawing, 1 luffing, 2 flogging, 3 stalled. */
export function coeffs(t, a) {
  const T = TYPES[t];
  const clAt = (x) => T.clmax * Math.sin((Math.PI / 2) * Math.min(1, x / T.as));
  if (a <= 0) return { cl: 0, cd: 0.10 + T.cd0, st: 2 };                                   // flogging
  if (a < A_LUFF) { const f = a / A_LUFF, cl = clAt(A_LUFF) * f; return { cl, cd: T.cd0 + 0.06 * (1 - f) + K_IND * cl * cl, st: 1 }; } // luffing
  if (a <= T.as) { const cl = clAt(a); return { cl, cd: T.cd0 + K_IND * cl * cl, st: 0 }; }
  const w = sstep(T.as, T.as + 25, a), ar = a * D2R;                                     // stall → flat plate
  const clfp = 1.3 * Math.sin(ar) * Math.cos(ar), cdfp = 1.3 * Math.sin(ar) ** 2 + T.cd0, cds = T.cd0 + K_IND * T.clmax ** 2;
  return { cl: T.clmax + (clfp - T.clmax) * w, cd: cds + (cdfp - cds) * w, st: w > 0.25 ? 3 : 0 };
}
export const BANDS_TRI = [[1 / 6, 5 / 9], [1 / 2, 3 / 9], [5 / 6, 1 / 9]], BANDS_QUAD = [[1 / 6, 0.4], [1 / 2, 0.33], [5 / 6, 0.27]];

/** Telltale code of one band (§2.3.6): 0 streaming, 1 windward lifting (α < 6°), 2 leeward stalling (α > αs). */
export const ttOf = (type, al) => (al < A_LUFF ? 1 : al > TYPES[type].as ? 2 : 0);

/** Apparent wind at height z (m) for tws10 (m/s at 10 m), |twa| (deg), V (m/s), leeway lam (deg, + to leeward). */
export function apparent(tws10, twa, V, lam, z = 10) {
  const tw = tws10 * Math.pow(Math.max(z, 1) / 10, 0.13);
  const ax = tw * Math.cos(twa * D2R) + V * Math.cos(lam * D2R), ay = tw * Math.sin(twa * D2R) - V * Math.sin(lam * D2R);
  return { aws: Math.hypot(ax, ay), awa: Math.atan2(ay, ax) / D2R };
}

/**
 * Aerodynamic forces (Appendix A `aero`). tws10 = true wind over the water at 10 m (m/s), twa (deg 0..180), V (m/s),
 * lam leeway (deg), phi heel (deg). ss = {id: {hoist, reef, furl, delta, twist, mul?}}. Optional game extras (absent in
 * the reference/polar path, which they do not change): `opt.waveH` (slatting in light air and a sea, §2.3.3).
 * Each sail's mid-band record also carries `tt` (telltales, 2 bits per band bottom → top).
 */
export function aero(rig, ss, tws10, twa, V, lam, phi, opt) {
  let Fx = 0, Fn = 0, HM = 0, Mz = 0;
  const bands = [], cphi = Math.cos(phi * D2R);
  const slatH = opt && opt.waveH > 0.5 ? Math.min(1, opt.waveH) : 0;
  for (const s of rig.sails) {
    const st = ss[s.id]; if (!st || !(st.hoist > 0)) continue;
    // downwash: a sail sets in the turned-down flow behind a headsail (5°) / another boomed sail (3°) ahead of it
    let dw = 0;
    if (!s.head) { for (const o of rig.sails) if (o !== s && ss[o.id]?.hoist > 0.5 && o.zc < s.zc) dw = Math.max(dw, o.head ? 5 : 3); }
    const red = st.reef ? s.reefs[st.reef - 1] : 1;
    const area = s.A * red * (1 - (st.furl || 0)) * st.hoist;
    const y0 = s.y0, y1 = s.y0 + (s.y1 - s.y0) * Math.sqrt(red);
    const mul = st.mul ?? 1;
    let tt = 0, bi = 0, mid = null;
    for (const [eta, w] of s.type === 'gaff' ? BANDS_QUAD : BANDS_TRI) {
      const z = y0 + eta * (y1 - y0);
      const tw = tws10 * Math.pow(Math.max(z, 1) / 10, 0.13);                              // wind gradient
      const ax = tw * Math.cos(twa * D2R) + V * Math.cos(lam * D2R), ay = tw * Math.sin(twa * D2R) - V * Math.sin(lam * D2R);
      const aws = Math.hypot(ax, ay), awa = Math.atan2(ay, ax) / D2R;
      const be = Math.atan2(Math.sin(awa * D2R) * cphi, Math.cos(awa * D2R)) / D2R;          // heeled (Kerwin) angle
      const awse = aws * Math.sqrt(Math.cos(awa * D2R) ** 2 + (Math.sin(awa * D2R) * cphi) ** 2);
      const blank = s.head || s.blank ? 1 - 0.65 * sstep(110, 170, awa) * (twa > 160 ? 0.25 : 1) : 1; // main's wind shadow; wing-on-wing past 160
      const al = be - (st.delta + st.twist * eta) - dw * sstep(70, 40, awa);
      let { cl, cd, st: state } = coeffs(s.type, al);
      if (st.furl) cl *= 1 - 0.3 * st.furl;
      if (st.reef) cl *= 1 - 0.04 * st.reef;
      if (st.hoist < 1) cl *= st.hoist * st.hoist;
      if (slatH && aws < 4) { cl *= 1 - 0.15 * slatH; if (state === 0) state = 1; }       // slatting: light air and a sea
      const q = 0.5 * RA * (awse * blank) ** 2 * area * w * mul;
      const fx = q * (cl * Math.sin(be * D2R) - cd * Math.cos(be * D2R)), fn = q * (cl * Math.cos(be * D2R) + cd * Math.sin(be * D2R));
      Fx += fx; Fn += fn; HM += fn * (z + rig.zclr); Mz += fn * cphi * (s.zc - rig.xclr);
      tt |= ttOf(s.type, al) << (2 * bi++);
      if (eta === 0.5) mid = { id: s.id, alpha: al, be, awa, aws, state };
    }
    mid.tt = tt; bands.push(mid);
  }
  { // hull + rig windage at 6 m
    const tw = tws10 * Math.pow(0.6, 0.13), ax = tw * Math.cos(twa * D2R) + V, ay = tw * Math.sin(twa * D2R), aws = Math.hypot(ax, ay), q = 0.5 * RA * aws * aws * rig.Apar * 0.9;
    if (aws > 0) { Fx -= (q * ax) / aws; Fn += (q * ay) / aws; HM += ((q * ay) / aws) * (rig.fb + 2 + rig.zclr); }
  }
  return { Fx, Fn, HM, Mz, bands };
}

/** Windage drag (N) of hull and rig moving at V (m/s) through still air — the engine's share in §2.9. */
export function windageCalm(rig, V) { const q = 0.5 * RA * V * V * rig.Apar * 0.9; return q; }

// ---- trim rule (auto-trim): chord angle at the foot = heeled AWA at mid height − target AoA − half the twist
export const trimDelta = (s, be, aT, twist) => clamp(be - aT - twist * 0.5, s.dmin, s.dmax);
/** twist (deg, foot→head) for a chord angle at the foot: easing a sheet opens the leech; the traveller car does not */
export function twistFor(s, delta, car = Math.min(delta, s.travMax ?? 12)) {
  const T = TYPES[s.type];
  return s.head ? T.tw0 + 6 * clamp((delta - s.dmin) / 25, 0, 1) : T.tw0 + 8 * clamp((delta - car) / 20, 0, 1);
}
/** auto-trim one sail: target AoA aT at mid height → {delta, twist} (two passes because twist depends on delta) */
export function autoTrimSail(s, be, aT) {
  let tw = twistFor(s, s.dmin), d = trimDelta(s, be, aT, tw);
  tw = twistFor(s, d); d = trimDelta(s, be, aT, tw); return { delta: d, twist: twistFor(s, d) };
}

// ---- sheet / traveller ↔ chord angle (§2.3.4). Boomed sails: the car sets δcar, the sheet the rest; headsails: the
// sheet alone; schooner topsails sheet to their gaff (car fixed at travMax), as the reference model's twistFor treats them.
/** Chord angle at the foot and twist for a sheet (0 hard in … 1 all out) and traveller (−1 windward … +1 leeward). */
export function chordOf(s, sheet, trav = 0) {
  if (s.head) { const d = s.dmin + sheet * (s.dmax - s.dmin); return { delta: d, twist: twistFor(s, d), car: s.dmin }; }
  const car = s.boom ? s.travMin + ((trav + 1) / 2) * (s.travMax - s.travMin) : (s.travMax ?? s.dmin);
  const d = car + sheet * (s.dmax - car);
  return { delta: d, twist: twistFor(s, d, car), car };
}
/** Sheet value giving chord angle `delta` with the traveller where it is (HUD inverse; clamped 0…1). */
export function sheetFor(s, delta, trav = 0) {
  if (s.head) return clamp((delta - s.dmin) / (s.dmax - s.dmin), 0, 1);
  const car = s.boom ? s.travMin + ((trav + 1) / 2) * (s.travMax - s.travMin) : (s.travMax ?? s.dmin);
  return s.dmax > car ? clamp((delta - car) / (s.dmax - car), 0, 1) : 0;
}
/** Auto-trim setting for chord angle `delta`: the traveller drops first (car up to travMax), the sheet does the rest. */
export function trimFor(s, delta) {
  if (s.head) return { sheet: clamp((delta - s.dmin) / (s.dmax - s.dmin), 0, 1), trav: 0 };
  if (!s.boom) return { sheet: sheetFor(s, delta, 0), trav: 0 };
  const car = clamp(Math.min(delta, s.travMax), s.travMin, s.travMax);
  return { sheet: s.dmax > car ? clamp((delta - car) / (s.dmax - car), 0, 1) : 0, trav: clamp((2 * (car - s.travMin)) / (s.travMax - s.travMin) - 1, -1, 1) };
}
