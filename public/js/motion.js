// Ship motions in a seaway: heave, pitch and roll as damped second-order oscillators driven by the wave surface
// sampled at 8 hull points (bow, stern, the four quarters and both sides amidships). Least-squares plane fit of the
// sampled heights gives the hydrostatic equilibrium (mean level, fore-aft slope, athwartships slope; the roll forcing
// uses the effective wave slope, ≈ 0.85 of the surface slope); the oscillators' natural periods come from the hull
// (roll T = 0.8·B/√GM with GM per class, heave/pitch T ≈ 2.4·√draft), with class damping (+ quadratic roll damping
// from bilge eddies, fin stabilisers at speed on ferries / superyachts). Because the surface is
// sampled at the ship's moving position, speed and heading relative to the waves give the right encounter
// frequency (head seas: quick, hard pitching; following seas: slow surging rolls; beam seas near T_roll: resonance).
// On top: steady heel from wind on high-sided hulls and sails, heel in turns (outward for displacement hulls, inward
// for planing craft), list and bow-down trim from flooding, bow slamming (forefoot re-entry faster than Ochi's
// 0.093·√(gL)) and green water over the bow. Docked ships get strongly damped, small motion.
// Sign convention = main.js shipVisual: mesh.rotation.set(pitch, -hdg, roll, 'YXZ') — pitch > 0 bow up, roll > 0
// starboard side up (heeled to port); heave is metres relative to the ocean's tide level (add the tide yourself).
// Deterministic (no randomness, no clocks) and allocation-free per step (the returned object is reused).

const G = 9.81, D2R = Math.PI / 180, KN = 0.514444;

/**
 * Per-class hull behaviour. gm = metacentric height (m); zr / zh = linear roll / heave-pitch damping ratio; bq =
 * quadratic roll damping (default 1); wind = steady heel (deg) in a 20 m/s beam wind (sail classes: in 12 m/s, sails up); turn = heel (deg) at full rudder
 * and service speed (+ outward, − inward/planing); fins = extra roll damping from stabilisers at speed.
 */
export const MOTION_CLASSES = {
  coaster: { gm: 1.5, zr: 0.06, zh: 0.28, bq: 1.2, wind: 1.6, turn: 4, vmax: 14 },
  feeder: { gm: 1.3, zr: 0.05, zh: 0.3, wind: 2.6, turn: 3.5, vmax: 20 },
  bulker: { gm: 2.2, zr: 0.045, zh: 0.3, wind: 0.8, turn: 2.5, vmax: 14 },
  tanker: { gm: 2.5, zr: 0.045, zh: 0.3, wind: 0.7, turn: 2.5, vmax: 15 },
  boxship: { gm: 1.2, zr: 0.05, zh: 0.3, wind: 3.2, turn: 3, vmax: 22 },
  trawler: { gm: 2.5, zr: 0.07, zh: 0.26, wind: 1.2, turn: 5, vmax: 12 },
  tug: { gm: 2.5, zr: 0.08, zh: 0.26, wind: 1.0, turn: 6, vmax: 13 },
  psv: { gm: 2.0, zr: 0.07, zh: 0.27, wind: 1.8, turn: 4, vmax: 14 },
  pilot: { gm: 1.0, zr: 0.09, zh: 0.3, wind: 0.8, turn: -7, vmax: 26 },
  ferry: { gm: 2.0, zr: 0.06, zh: 0.3, wind: 3.0, turn: 5, vmax: 22, fins: 0.16 },
  cruiser: { gm: 0.9, zr: 0.1, zh: 0.32, wind: 1.0, turn: -10, vmax: 30 },
  myacht: { gm: 1.1, zr: 0.09, zh: 0.3, wind: 1.5, turn: -6, vmax: 26 },
  superyacht: { gm: 1.4, zr: 0.06, zh: 0.3, wind: 2.2, turn: 3, vmax: 18, fins: 0.18 },
  sloop: { gm: 1.2, zr: 0.12, zh: 0.3, wind: 22, turn: 2, vmax: 7.2, sail: true },
  ketch: { gm: 1.3, zr: 0.12, zh: 0.3, wind: 18, turn: 2, vmax: 8.6, sail: true },
  catamaran: { gm: 9, zr: 0.15, zh: 0.3, wind: 3, turn: 1, vmax: 10.5, sail: true, multihull: true },
  schooner: { gm: 1.4, zr: 0.1, zh: 0.3, wind: 15, turn: 2, vmax: 10, sail: true },
  cutter: { gm: 1.6, zr: 0.08, zh: 0.28, wind: 1.5, turn: 5, vmax: 24 },
  lifeboat: { gm: 1.2, zr: 0.1, zh: 0.3, wind: 1.0, turn: -5, vmax: 25 },
  derelict: { gm: 0.6, zr: 0.04, zh: 0.25, wind: 1.0, turn: 0, vmax: 1 },
};
const BY_CATEGORY = { cargo: 'coaster', working: 'trawler', passenger: 'ferry', 'motor yacht': 'myacht', 'sailing yacht': 'sloop' };

// hull sample stations: s = fraction of length forward of midships, t = fraction of beam to starboard
const ST_S = [0.45, -0.45, 0.25, 0.25, -0.25, -0.25, 0, 0];
const ST_T = [0, 0, 0.5, -0.5, 0.5, -0.5, 0.5, -0.5];
const SUM_S2 = ST_S.reduce((a, s) => a + s * s, 0), SUM_T2 = ST_T.reduce((a, t) => a + t * t, 0);

/**
 * New motion state for a ship class: `cls` is a class id ('coaster', 'tug', …), a SHIP_CLASSES-like object
 * ({ id, cat, maxKn, sail, … }), or omitted (generic cargo hull).
 */
export function createMotion(cls) {
  let id = typeof cls === 'string' ? cls : cls && cls.id;
  let p = MOTION_CLASSES[id];
  if (!p && cls && typeof cls === 'object') p = MOTION_CLASSES[BY_CATEGORY[cls.cat]];
  p = p || MOTION_CLASSES.coaster;
  const vmax = cls && typeof cls === 'object' && Number.isFinite(cls.maxKn) ? cls.maxKn : p.vmax;
  return {
    cls: id || 'coaster',
    gm: p.gm, zr: p.zr, zh: p.zh, bq: Number.isFinite(p.bq) ? p.bq : 1, windHeel: p.wind, turnHeel: p.turn, vmax: Math.max(1, vmax), fins: p.fins || 0,
    sail: !!(p.sail || (cls && typeof cls === 'object' && cls.sail)), multihull: !!p.multihull,
    init: false,
    heave: 0, heaveV: 0, pitch: 0, pitchV: 0, roll: 0, rollV: 0,
    eqH: 0, eqP: 0, eqR: 0,            // last step's equilibrium (forcing is interpolated across sub-steps)
    rel: 0, emerged: false, slam: 0, green: 0,
    out: { heave: 0, pitch: 0, roll: 0, slam: 0, greenWater: 0 },
  };
}

/**
 * Advance the motion by dt seconds and return { heave (m), pitch (rad), roll (rad), slam 0..1, greenWater 0..1 }
 * (the same object every call). ctx = { length, beam, draft, freeboard, displacementT, speedKn, hdgRad, x, z, time,
 * ocean, throttle, rudder, flooding, docked } plus optional { windSpd, windDir (from, deg), sails (bool) } — wind
 * defaults to ocean.wind / ocean.windDir. hdgRad is the compass heading (0 = north = −z, clockwise).
 */
export function stepMotion(st, ctx, dt) {
  const out = st.out;
  dt = Number.isFinite(dt) ? Math.min(0.25, Math.max(0, dt)) : 0.016;
  const oc = ctx.ocean;
  const L = Math.max(4, ctx.length || 50), B = Math.max(1.5, ctx.beam || L / 6), d = Math.max(0.4, ctx.draft || L / 18);
  const fb = Math.max(0.6, ctx.freeboard || Math.max(3, L * 0.045));
  const flood = Math.min(1, Math.max(0, ctx.flooding || 0)), docked = !!ctx.docked;
  const V = Math.abs(ctx.speedKn || 0), vr = Math.min(1.3, V / st.vmax);
  const hdg = ctx.hdgRad || 0, fx = Math.sin(hdg), fz = -Math.cos(hdg), px = -fz, pz = fx; // forward, starboard
  const x = ctx.x || 0, z = ctx.z || 0, t = ctx.time;
  const level = oc && Number.isFinite(oc.level) ? oc.level : 0;
  // ---- wave surface at the hull points → least-squares plane (mean, fore-aft slope, athwartships slope)
  let mean = 0, as = 0, at = 0, hBow = 0;
  if (oc && typeof oc.heightAt === 'function') {
    for (let i = 0; i < 8; i++) {
      const s = ST_S[i] * L, w = ST_T[i] * B;
      const h = oc.heightAt(x + fx * s + px * w, z + fz * s + pz * w, t) - level;
      mean += h; as += ST_S[i] * h; at += ST_T[i] * h;
      if (i === 0) hBow = h;
    }
    mean /= 8; as /= SUM_S2 * L; at /= SUM_T2 * B;
  }
  const exc = docked ? 0.08 : 1;
  // ---- steady heel: wind (high sides / sails), turning, flooding list
  const U = Number.isFinite(ctx.windSpd) ? ctx.windSpd : oc && Number.isFinite(oc.wind) ? oc.wind : 0;
  const wFrom = Number.isFinite(ctx.windDir) ? ctx.windDir : oc && Number.isFinite(oc.windDir) ? oc.windDir : 0;
  const rb = (wFrom - hdg / D2R) * D2R, sinRb = Math.sin(rb); // wind on the starboard side → sinRb > 0 → heel to port (roll > 0)
  let heel;
  // sails: heel grows with the square of the wind up to ~12 m/s, then the crew reefs (heel held, then eased)
  if (st.sail && ctx.sails !== false) heel = Math.min(25, st.windHeel * (U / 12) * (U / 12)) * D2R * Math.sign(sinRb) * Math.pow(Math.abs(sinRb), 0.6) * (U > 13 ? Math.pow(13 / U, 1.5) : 1);
  else heel = st.windHeel * (U / 20) * (U / 20) * D2R * sinRb;
  heel += st.turnHeel * D2R * Math.max(-1, Math.min(1, ctx.rudder || 0)) * vr * vr;
  heel = Math.max(-0.5, Math.min(0.5, heel));
  const list = flood * 0.25, trim = -flood * 0.035;
  // roll is excited by the effective wave slope: the pressure field decays over the draft (Smith effect, ≈ 0.85)
  const eqH = mean * exc, eqP = Math.atan(as) * exc + trim, eqR = Math.atan(at) * 0.85 * exc + (docked ? 0 : heel) + list;
  // ---- natural frequencies and damping
  const gm = Math.max(0.12 * st.gm, st.gm * (1 - 0.65 * flood));           // free-surface loss when flooding
  const Tr = Math.min(30, Math.max(1.4, (0.8 * B) / Math.sqrt(gm)));
  const Th = Math.min(12, Math.max(1.5, 2.4 * Math.sqrt(d))), Tp = Th * 0.95;
  const wr = (2 * Math.PI) / Tr, wh = (2 * Math.PI) / Th, wpp = (2 * Math.PI) / Tp;
  const dk = docked ? 5 : 1;
  const zr = Math.min(1.2, (st.zr * (1 + 0.6 * Math.min(1, vr)) + st.fins * Math.min(1, V / (0.5 * st.vmax))) * dk);
  const zh = Math.min(1.5, st.zh * dk * (1 + 0.3 * vr));
  const bq = docked ? 4 : st.bq; // quadratic roll damping (bilge vortices, eddy making) — caps resonant rolling
  if (!st.init) {
    st.init = true; st.heave = eqH; st.pitch = eqP; st.roll = eqR; st.heaveV = st.pitchV = st.rollV = 0;
    st.eqH = eqH; st.eqP = eqP; st.eqR = eqR; st.rel = hBow - (eqH + Math.sin(eqP) * 0.45 * L);
  }
  // ---- integrate (semi-implicit Euler, ≤ 1/60 s sub-steps, forcing interpolated across the step)
  const nSub = Math.max(1, Math.ceil(dt * 60)), h = dt / nSub;
  for (let k = 1; k <= nSub; k++) {
    const f = k / nSub;
    const fh = st.eqH + (eqH - st.eqH) * f, fp = st.eqP + (eqP - st.eqP) * f, fr = st.eqR + (eqR - st.eqR) * f;
    st.heaveV += (-2 * zh * wh * st.heaveV - wh * wh * (st.heave - fh)) * h; st.heave += st.heaveV * h;
    st.pitchV += (-2 * zh * wpp * st.pitchV - wpp * wpp * (st.pitch - fp)) * h; st.pitch += st.pitchV * h;
    st.rollV += (-2 * zr * wr * st.rollV - bq * Math.abs(st.rollV) * st.rollV - wr * wr * (st.roll - fr)) * h; st.roll += st.rollV * h;
  }
  st.eqH = eqH; st.eqP = eqP; st.eqR = eqR;
  if (st.roll > 0.75) { st.roll = 0.75; st.rollV = Math.min(0, st.rollV); } else if (st.roll < -0.75) { st.roll = -0.75; st.rollV = Math.max(0, st.rollV); }
  // ---- bow: slamming (forefoot re-entry) and green water (sea over the foredeck)
  const zBow = st.heave + Math.sin(st.pitch) * 0.45 * L;
  const rel = hBow * exc - zBow;                 // > 0: water higher than the bow's rest waterline
  const relV = dt > 0 ? (rel - st.rel) / dt : 0;
  const forefoot = 0.8 * d;
  const vcrit = 0.093 * Math.sqrt(G * L);
  let slam = 0;
  if (!docked && st.emerged && rel >= -forefoot && relV > vcrit) slam = Math.min(1, 0.35 + (relV - vcrit) / (1.5 * vcrit) + 0.15 * vr);
  st.emerged = rel < -forefoot;
  st.rel = rel;
  st.slam = Math.max(slam, st.slam * Math.exp(-dt / 0.4));
  const deck = fb * 1.25;                        // sheer: the bow stands higher than amidships
  const gw = docked ? 0 : Math.min(1, Math.max(0, (rel - deck) / (0.25 * fb + 0.4)));
  st.green = Math.max(gw, st.green * Math.exp(-dt / 1.2));
  out.heave = st.heave; out.pitch = st.pitch; out.roll = st.roll; out.slam = st.slam; out.greenWater = st.green;
  return out;
}
