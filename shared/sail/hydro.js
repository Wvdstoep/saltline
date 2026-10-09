// Saltline sailing — hull hydrodynamics and stability (docs/SAILING-CONTRACT.md §2.5–§2.6, Appendix A `RR`, `RM`, `hull`).
// Ported from the reference model without changing equations or constants. Pure, deterministic.
import { D2R, lerpT } from './rigs.js';
import { RW, G, NU } from './aero.js';

/** Residuary resistance / weight vs Froude number, per hull family. */
export const RR = {
  mod:   [[0, 0], [0.15, 0.0002], [0.20, 0.0006], [0.25, 0.0014], [0.30, 0.0030], [0.35, 0.0068], [0.40, 0.0200], [0.45, 0.0400], [0.50, 0.0650], [0.55, 0.0850], [0.60, 0.1050], [0.70, 0.1400]],
  heavy: [[0, 0], [0.15, 0.0003], [0.20, 0.0008], [0.25, 0.0018], [0.30, 0.0040], [0.35, 0.0092], [0.40, 0.0260], [0.45, 0.0480], [0.50, 0.0750], [0.55, 0.0980], [0.60, 0.1200], [0.70, 0.1600]],
  cat:   [[0, 0], [0.15, 0.0008], [0.20, 0.0022], [0.25, 0.0055], [0.30, 0.0120], [0.35, 0.0220], [0.40, 0.0340], [0.45, 0.0450], [0.50, 0.0550], [0.60, 0.0680], [0.70, 0.0780], [0.80, 0.0860], [1.00, 0.1000]],
};

/** Righting moment (N·m) at heel phi (deg). */
export function RM(rig, phi) {
  const p = phi * D2R;
  if (rig.cat) return rig.disp * 1000 * G * (rig.hs * Math.cos(p) * Math.min(1, phi / rig.phiFly) - (phi > rig.phiFly ? rig.KG * Math.sin(p) : 0));
  return rig.disp * 1000 * G * Math.max(-0.2, rig.GM * Math.sin(p) * (1 - (phi / rig.AVS) ** 2) * (1 + 0.35 * Math.sin(p) ** 2));
}
/** Largest righting moment (catamaran: at the hull-flying angle) — the HUD's hull-load denominator. */
export function RMmax(rig) {
  if (rig.cat) return RM(rig, rig.phiFly);
  let m = 0; for (let a = 1; a <= 90; a++) m = Math.max(m, RM(rig, a)); return m;
}

/**
 * Hull: resistance, leeway, helm (Appendix A `hull`). V m/s, phi deg, Fs = horizontal sail side force (N), Mz = sail
 * yaw moment about the CLR, Fx = drive, zce = CE height above the CLR depth.
 * → { R, Rf, Rr, Ri, Rrud, lam (deg), dr (rudder deg), Hl (helm load, 1 = rudder at its limit), Fr }
 */
export function hull(rig, V, phi, Fs, Mz, Fx, zce) {
  const Vr = Math.max(V, 0.05), q = 0.5 * RW * Math.max(V, 0.5) ** 2;
  const Re = Vr * 0.7 * rig.LWL / NU, cf = 0.075 / (Math.log10(Math.max(Re, 1e5)) - 2) ** 2;
  const Fr = Vr / Math.sqrt(G * rig.LWL);
  const Rf = 0.5 * RW * Vr * Vr * rig.Sw * cf * 1.12, Rr = rig.disp * 1000 * G * lerpT(RR[rig.rr], Fr);
  const hf = 1 + 0.5 * (phi / 30) ** 2 + 2.0 * Math.max(0, (phi - 25) / 20) ** 2;          // heel drag
  const be = rig.bK * Math.cos(phi * D2R), cla = (2 * Math.PI * rig.ARk) / (rig.ARk + 2), LS = 10;
  const lamLin = Fs / (q * rig.Alat * cla) / D2R, FsK = Math.min(Fs, q * rig.Alat * cla * LS * D2R);
  let Ri = (FsK * FsK) / (q * Math.PI * be * be), lam = lamLin;
  if (lamLin > LS) { const ex = Math.min(20, (lamLin - LS) * 0.5); lam = LS + ex; Ri += q * rig.Alat * Math.sin(ex * D2R * 3) ** 2; } // keel stall: side-slip
  const Mw = Mz + Math.sin(phi * D2R) * (Fx * zce + 0.13 * 0.5 * RW * V * V * rig.LWL * rig.Alat); // weather helm (+ = luffs up)
  const lr = rig.zr - rig.xclr, LrMax = q * rig.Ar * 1.2, Hl = Mw / (LrMax * lr);
  const Lr = Math.sign(Mw) * Math.min(Math.abs(Mw / lr), LrMax), dr = Lr / (q * rig.Ar * ((2 * Math.PI * 3) / 5)) / D2R;
  const Rrud = (Lr * Lr) / (q * Math.PI * rig.br * rig.br) + q * rig.Ar * 0.5 * Math.max(0, Math.abs(dr) - 12) ** 2 * D2R * D2R;
  return { R: (Rf + Rr) * hf + Ri + Rrud, Rf, Rr, Ri, Rrud, lam, dr, Hl, Fr };
}

/** Calm-water resistance (N) upright with no side force (§2.9 `Rcalm`, §6.4 A-3). */
export function rcalm(rig, V) { return hull(rig, V, 0, 0, 0, 0, 0).R; }
/** Froude number at V (m/s). */
export const froude = (rig, V) => V / Math.sqrt(G * rig.LWL);
