// Saltline sailing — rig geometry core (docs/SAILING-CONTRACT.md §4.3–§4.4). Pure: no three.js, no DOM, deterministic
// (cloth motion is a function of the time you pass in). rigmesh.js copies what this computes into GPU buffers; the
// node tests (test/sailviz-*.test.mjs) check the geometry directly.
//
// Ship frame (metres): x to starboard, y up (0 = waterline), z aft (bow at −L/2). Angles in degrees.
// A sail is a (nu+1) × (nv+1) vertex grid: u 0…1 luff → leech, v 0…1 foot → head. Each row v is a chord from the luff
// point L(v) (on the mast's aft face, on the stay, or on the topmast) to the leech point C(v) (with roach), rotated about
// the vertical through L(v) by the chord angle δ(v) = angle + side·τ·v (τ = twist), then cambered to leeward:
// offset c0·fill·chord·f(u) along the leeward horizontal normal n = side·(cos δ, 0, −sin δ).
// `angle` is the RigView's signed chord angle at the foot (+ = clew to starboard), `side` the sail's side (−1 port).
import { rigOf, SAIL_TYPES } from '../../shared/sail/rigs.js';
import { twistFor } from '../../shared/sail/aero.js';
import { deckHalf, sheerY, structures, structHalfAt, deckHeightAt, stemZ, hullHalfAt, hullOf, hullExtent } from './yachtlooks.js';

const D2R = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const TAU = Math.PI * 2;

/** Grid resolution per LOD (§4.3, §4.6): own ship 10 × 14 (phones 8 × 10), others ≤ 300 m 6 × 8, far 1 × 1; gaff quads 12 × 14. */
export const GRID = { own: [10, 14], ownGaff: [12, 14], touch: [8, 10], near: [6, 8], far: [1, 1] };
export function gridFor(lod, quad, touch) {
  if (lod === 'far') return GRID.far;
  if (lod === 'near') return GRID.near;
  if (touch) return GRID.touch;
  return quad ? GRID.ownGaff : GRID.own;
}

/** Camber depth / chord (c0) and the draft-position skew k of f(u) = 4u(1 − u)(1 + k(1 − 2u)) per sail type. */
export const CAMBER = { main: [0.11, 0.3], mizzen: [0.11, 0.3], gaff: [0.12, 0.3], genoa: [0.13, 0.55], jib: [0.13, 0.55], stay: [0.13, 0.55], topsail: [0.12, 0.45], code0: [0.16, 0.5] };
/** Camber profile along the chord (0 at luff and leech; peak near 40 % for mains, 35 % for headsails). */
export function camberProfile(u, k) { return 4 * u * (1 - u) * (1 + k * (1 - 2 * u)); }
/** Fill factor of the camber by sail state: drawing / stalled 1, luffing 0.4, flogging 0 (flutter instead), crew 0.6. */
export function fillOf(state) { return state === 1 ? 0.4 : state === 2 ? 0 : state === 4 ? 0.6 : state === 5 ? 0 : 1; }

// ------------------------------------------------------------------------------------------------ rig bases (cached)
const BASE = new Map();
const mastOf = (R, id) => R.spars.masts.find((m) => m.id === id) || null;
/** Radius of a mast at height y (lower mast + topmast). */
export function mastRadius(m, y) {
  if (m.topmast && y > m.top) return lerp(m.tm0, m.tm1, clamp((y - m.top) / (m.topmast - m.top), 0, 1)) / 2;
  return lerp(m.d0, m.d1, clamp((y - m.foot) / (m.top - m.foot), 0, 1)) / 2;
}
// the mast a boomed / gaff / topsail luff runs up (nearest mast in z)
function luffMast(R, z) { let best = null, bd = Infinity; for (const m of R.spars.masts) { const d = Math.abs(m.z - z); if (d < bd) { bd = d; best = m; } } return best; }
// project point p [z, y] on the line a → b ([z, y]) → [z, y]
function project(p, a, b) {
  const dz = b[0] - a[0], dy = b[1] - a[1], l2 = dz * dz + dy * dy || 1;
  const t = ((p[0] - a[0]) * dz + (p[1] - a[1]) * dy) / l2;
  return [a[0] + dz * t, a[1] + dy * t];
}

/** Static per-sail geometry in the centre plane (cached per class). */
export function rigBase(cls) {
  let b = BASE.get(cls); if (b) return b;
  const R = rigOf(cls); if (!R) return null;
  const sails = R.sails.map((s, i) => {
    const P = s.pts.map((p) => [p[0], p[1]]);
    const quad = P.length === 4;
    const kind = s.head ? 'head' : s.type === 'topsail' ? 'top' : quad ? 'gaff' : 'boom';
    const out = { id: s.id, i, def: s, kind, quad, type: s.type, furl: !!s.furl, reefs: s.reefs || [], roach: s.roach || 1 };
    out.camber = CAMBER[s.type] || CAMBER.main;
    if (kind === 'head') {
      const stay = R.spars.stays.find((st) => st.sail === s.id);
      out.stay = stay || null;
      if (stay) { const a = [stay.from[2], stay.from[1]], c = [stay.to[2], stay.to[1]]; out.tack = project(P[0], a, c); out.head = project(P[1], a, c); }
      else { out.tack = P[0]; out.head = P[1]; }
      out.clew = P[2];
      const club = R.spars.booms.find((bm) => bm.club && bm.sail === s.id);
      out.club = club || null;
    } else {
      const m = luffMast(R, P[0][0]);
      out.mast = m;
      out.tack = P[0];
      if (quad) { out.throat = P[1]; out.peak = P[2]; out.clew = P[3]; out.head = P[1]; }
      else { out.head = P[1]; out.clew = P[2]; }
      out.boom = R.spars.booms.find((bm) => bm.sail === s.id && !bm.club) || null;
      out.gaff = R.spars.gaffs.find((g) => g.sail === s.id) || null;
    }
    out.follows = s.follows || null;
    return out;
  });
  b = { cls, R, sails, byId: Object.fromEntries(sails.map((x) => [x.id, x])) };
  // roach height (m) from the area factor: extra area = (roach − 1)·A_poly = ∫ bulge = (2/3)·h·leech length
  for (const s of sails) {
    s.roachH = 0;
    if (s.roach > 1) {
      const top = s.quad ? s.peak : s.head;
      const ll = Math.hypot(top[0] - s.clew[0], top[1] - s.clew[1]);
      s.roachH = (1.5 * (s.roach - 1) * polyArea(s.def.pts)) / ll;
    }
    s.reefV = [0];
    for (let k = 0; k < s.reefs.length; k++) s.reefV.push(reefRow(b, s, s.reefs[k]));
  }
  BASE.set(cls, b);
  return b;
}
function polyArea(P) { let a = 0; for (let i = 0; i < P.length; i++) { const [z0, y0] = P[i], [z1, y1] = P[(i + 1) % P.length]; a += z0 * y1 - z1 * y0; } return Math.abs(a) / 2; }

// ---- centre-plane rows (no rotation): luff L(v) and leech C(v) as [z, y]
function luffPt(b, s, v, hoistTop) {
  // hoistTop: the top of the hoisted luff in luff-fraction (1 = fully hoisted)
  const vv = v * hoistTop;
  if (s.kind === 'head') return [lerp(s.tack[0], s.head[0], vv), lerp(s.tack[1], s.head[1], vv)];
  const top = s.quad ? s.throat : s.head;
  const y = lerp(s.tack[1], top[1], vv);
  const m = s.mast;
  return [m ? m.z + mastRadius(m, y) + 0.03 : lerp(s.tack[0], top[0], vv), y];
}
function roachShape(cls, v) { return cls === 'catamaran' ? Math.pow(v, 0.9) * (1 - v) * 3.42 : 4 * v * (1 - v); }
function leechPt(b, s, v, hoistTop, gaffVec) {
  const c = s.clew;
  let top;
  if (s.quad) { const th = luffPt(b, s, 1, hoistTop); top = gaffVec ? [th[0] + gaffVec[0], th[1] + gaffVec[1]] : s.peak; }
  else top = hoistTop < 1 ? luffPt(b, s, 1, hoistTop) : s.head;
  let z = lerp(c[0], top[0], v), y = lerp(c[1], top[1], v);
  if (s.roachH > 0) {
    const dz = top[0] - c[0], dy = top[1] - c[1], l = Math.hypot(dz, dy) || 1;
    const k = s.roachH * roachShape(b.cls, v) * hoistTop;
    z += (dy / l) * k; y += (-dz / l) * k;                                // outward normal of the leech (aft / up)
  }
  return [z, y];
}
// reef row: the v whose region above has `red` of the full area (bisection on the centre-plane polygon)
function reefRow(b, s, red) {
  const area = (v0) => {
    const pts = [];
    const N = 24;
    for (let k = 0; k <= N; k++) pts.push(luffPt(b, s, v0 + ((1 - v0) * k) / N, 1));
    for (let k = N; k >= 0; k--) pts.push(leechPt(b, s, v0 + ((1 - v0) * k) / N, 1, null));
    return polyArea(pts);
  };
  const A0 = area(0);
  let lo = 0, hi = 1;
  for (let it = 0; it < 30; it++) { const m = (lo + hi) / 2; if (area(m) / A0 > red) lo = m; else hi = m; }
  return (lo + hi) / 2;
}
/** Area (m², centre plane, with roach) of a sail at hoist 1 for a reef level (fractional levels interpolate). */
export function sailAreaVis(cls, id, reef = 0) {
  const b = rigBase(cls), s = b && b.byId[id]; if (!s) return 0;
  const vr = reefV(s, reef), N = 32, pts = [];
  for (let k = 0; k <= N; k++) pts.push(luffPt(b, s, vr + ((1 - vr) * k) / N, 1));
  for (let k = N; k >= 0; k--) pts.push(leechPt(b, s, vr + ((1 - vr) * k) / N, 1, null));
  return polyArea(pts);
}
function reefV(s, reef) {
  const n = s.reefV.length - 1; if (!(reef > 0) || n < 1) return 0;
  const r = clamp(reef, 0, n), i = Math.floor(r), f = r - i;
  return i >= n ? s.reefV[n] : lerp(s.reefV[i], s.reefV[i + 1], f);
}

// ------------------------------------------------------------------------------------------------ boom / gaff poses
/** Gooseneck pivot [x, y, z] of a boom (on the mast's aft face) and its horizontal length. */
function boomPivot(b, bm) {
  if (bm.club) return { p: [0, bm.from[1], bm.from[0]], len: Math.hypot(bm.to[0] - bm.from[0], bm.to[1] - bm.from[1]), rise: bm.to[1] - bm.from[1] };
  const m = mastOf(b.R, bm.mast);
  const z = m && Math.abs(bm.z - m.z) < 0.05 ? m.z + mastRadius(m, bm.y) + 0.04 : bm.z;
  return { p: [0, bm.y, z], len: bm.len, rise: bm.rise };
}
/** Boom end for a chord angle (deg, signed) → { a: gooseneck, b: end } (ship frame). */
export function boomPose(cls, sailId, angleDeg) {
  const b = rigBase(cls); if (!b) return null;
  const bm = b.R.spars.booms.find((x) => x.sail === sailId); if (!bm) return null;
  const { p, len, rise } = boomPivot(b, bm);
  const h = Math.sqrt(Math.max(0, len * len - rise * rise)), a = angleDeg * D2R;
  return { a: p, b: [p[0] + h * Math.sin(a), p[1] + rise, p[2] + h * Math.cos(a)], len };
}

// ------------------------------------------------------------------------------------------------ the sail surface
/**
 * Per-frame parameters of one sail from its RigView entry. sv = { id, hoist, reef, angle, state, tt, side? }.
 * opts = { t (s), aws (m/s), side (fallback), gaffAngle (deg: the gaff below, for topsails), gaffPeak }
 */
export function sailParams(cls, sv, opts = {}) {
  const b = rigBase(cls), s = b && b.byId[sv.id]; if (!s) return null;
  const angle = Number.isFinite(sv.angle) ? sv.angle : 0;
  const side = sv.side === 1 || sv.side === -1 ? sv.side : Math.abs(angle) > 4 ? Math.sign(angle) : (opts.side === 1 ? 1 : -1);
  const hoist = clamp(Number(sv.hoist) || 0, 0, 1);
  const state = Number.isFinite(sv.state) ? sv.state : 0;
  const def = s.def;
  const tw = twistFor(def, Math.abs(angle));
  const p = { b, s, side, angle, tw, state, tt: sv.tt | 0, t: Number(opts.t) || 0, aws: Math.max(0, Number(opts.aws) || 0) };
  // hoisted fraction of the luff (non-furling) / unrolled fraction (furling)
  p.unroll = s.furl ? hoist : 1;
  p.hoistTop = s.furl ? (hoist > 0.001 ? 1 : 0) : hoist;
  p.visible = hoist > 0.02 && state !== 5;
  p.reef = clamp(Number(sv.reef) || 0, 0, s.reefs.length);
  p.vr = reefV(s, p.reef);
  p.fill = fillOf(state);
  // reef: rows above vr drop by the luff length below vr (the reef tack is pulled down to the gooseneck)
  p.drop = 0;
  if (p.vr > 0) { const l0 = luffPt(b, s, 0, 1), l1 = luffPt(b, s, p.vr, 1); p.drop = l1[1] - l0[1]; }
  // gaff vector while lowering: the peak comes down towards the boom (gaff along the boom when lowered)
  p.gaffVec = null;
  if (s.quad && p.hoistTop < 1) {
    const g = [s.peak[0] - s.throat[0], s.peak[1] - s.throat[1]], gl = Math.hypot(g[0], g[1]);
    const g0 = [gl * 0.995, gl * 0.1], h = p.hoistTop;
    const v = [lerp(g0[0], g[0], h), lerp(g0[1], g[1], h)], vl = Math.hypot(v[0], v[1]) || 1;
    p.gaffVec = [(v[0] / vl) * gl, (v[1] / vl) * gl];
  }
  // topsails ride on the gaff below: their foot takes the gaff's head angle
  p.baseAngle = s.kind === 'top' && Number.isFinite(opts.gaffAngle) ? opts.gaffAngle : angle;
  // flutter frequencies scale with the apparent wind
  p.fFlog = clamp(2 + p.aws / 8, 2, 4); p.fLuff = clamp(3 + p.aws / 6, 3, 6);
  p.phase = (s.i * 1.618) % 1;
  return p;
}
/** Chord angle of row v (deg). */
export function rowAngle(p, v) {
  const a = p.baseAngle + p.side * p.tw * v, lim = p.s.def.dmax + 8;               // the shrouds stop a twisted-off head
  return a > lim ? lim : a < -lim ? -lim : a;
}

// row geometry after hoist / reef / furl, in the centre plane: { L: [z, y], C: [z, y] }
function row(p, v) {
  const { b, s } = p;
  const vv = p.vr + (1 - p.vr) * v;
  const L = luffPt(b, s, vv, p.hoistTop), C = leechPt(b, s, vv, p.hoistTop, p.gaffVec);
  if (p.drop) { L[1] -= p.drop; C[1] -= p.drop; if (v === 0 && s.boom) { const bp = boomLine(b, s, C[0]); if (C[1] < bp) C[1] = bp; } }
  if (p.unroll < 1) { C[0] = lerp(L[0], C[0], p.unroll); C[1] = lerp(L[1], C[1], p.unroll); }
  return { L, C };
}
// boom height (centre plane) at z along the boom (reefed clew lands on the boom)
function boomLine(b, s, z) {
  const bm = s.boom; if (!bm) return -Infinity;
  const t = clamp((z - bm.z) / bm.len, 0, 1);
  return bm.y + bm.rise * t + 0.05;
}

const _o = [0, 0, 0];
/**
 * Evaluate the sail surface at (u, v) → out [x, y, z] (ship frame). Includes camber, luff ripple, flogging. Returns out.
 * With `flat` true: the uncambered chord surface (for spar poses and tests).
 */
export function sailPoint(p, u, v, out = _o, flat = false) {
  const { L, C } = row(p, v);
  const dz = C[0] - L[0], dy = C[1] - L[1];
  const d = rowAngle(p, v) * D2R, sd = Math.sin(d), cd = Math.cos(d);
  let x = u * dz * sd, y = L[1] + u * dy, z = L[0] + u * dz * cd;
  if (!flat) {
    const chord = Math.hypot(dz, dy);
    const nx = p.side * cd, nz = -p.side * sd;                // leeward horizontal normal
    let off = p.s.camber[0] * p.fill * chord * camberProfile(u, p.s.camber[1]);
    const t = p.t;
    if (p.state === 1) {                                      // luffing: the front third backs and ripples aft
      if (u < 0.35) {                                         // the bubble behind the luff turns inside out (to windward)
        const w = Math.sin((Math.PI / 2) * (1 - u / 0.35));
        off = off * (1 - 2 * w) - 0.05 * chord * 0.7 * w * (0.6 + 0.4 * Math.sin(TAU * (p.fLuff * t - 3 * u + p.phase)));
      }
      off += 0.012 * chord * u * Math.sin(TAU * (p.fLuff * t * 0.7 - 2 * u - v + p.phase));
    } else if (p.state === 2) {                               // flogging: the whole sail ripples, the leech whips
      const a = 0.08 * chord * (0.25 + 0.75 * Math.pow(u, 0.8));
      off += a * (0.65 * Math.sin(TAU * (p.fFlog * t - 2.4 * u - 1.1 * v + p.phase)) + 0.35 * Math.sin(TAU * (2.3 * p.fFlog * t - 4.3 * u + 0.9 * v)));
      off += 0.2 * u * u * (1 - v) * Math.sin(TAU * (1.3 * p.fFlog * t + p.phase));
      y += 0.05 * u * (1 - v) * Math.sin(TAU * (p.fFlog * t * 1.1 + 0.5));
    } else if (p.state === 4) {
      off += 0.02 * chord * u * Math.sin(TAU * (2.5 * t - 2 * u + p.phase));
    }
    x += off * nx; z += off * nz;
  }
  out[0] = x; out[1] = y; out[2] = z;
  return out;
}

/** Fill a position buffer (Float32Array, (nu+1)(nv+1)·3) with the sail grid. Rows v-major: index (j·(nu+1) + i). */
export function sailGrid(p, nu, nv, pos) {
  const tmp = [0, 0, 0];
  let k = 0;
  for (let j = 0; j <= nv; j++) {
    const v = j / nv;
    for (let i = 0; i <= nu; i++) { sailPoint(p, i / nu, v, tmp); pos[k++] = tmp[0]; pos[k++] = tmp[1]; pos[k++] = tmp[2]; }
  }
  return pos;
}
/** UVs for the grid (u along the chord, v = height in the FULL sail so seams and numbers stay put when reefed). */
export function sailUVs(p, nu, nv, uv) {
  let k = 0;
  for (let j = 0; j <= nv; j++) { const v = p.vr + (1 - p.vr) * (j / nv); for (let i = 0; i <= nu; i++) { uv[k++] = (i / nu) * p.unroll + (1 - p.unroll) * 0; uv[k++] = v; } }
  return uv;
}
/** Triangle indices for a grid (two per cell). */
export function gridIndex(nu, nv) {
  const idx = [];
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
    idx.push(a, b, d, a, d, c);
  }
  return idx;
}

/** Telltale code (0 streaming, 1 windward lifting, 2 leeward stalling) of band 0 bottom / 1 middle / 2 top. */
export const ttBand = (tt, band) => ((tt | 0) >> (2 * band)) & 3;

/**
 * Telltales of one sail (§4.3): headsails three pairs on the luff at 25/50/75 % (both faces), mains three on the leech
 * at the batten ends. → [{ p: [x,y,z] attach, d: [x,y,z] unit direction, face: −1 port | +1 starboard, code }]
 */
export function telltales(p) {
  if (!p.visible || p.unroll < 0.3) return [];
  const out = [], head = p.s.kind === 'head', u0 = head ? 0.1 : 1.0, vs = head ? [0.25, 0.5, 0.75] : [0.3, 0.55, 0.8];
  const P = [0, 0, 0], Q = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const v = vs[k], code = p.state === 5 ? 0 : ttBand(p.tt, k);
    sailPoint(p, u0, v, P); sailPoint(p, Math.max(0, u0 - 0.04), v, Q);
    let tx = P[0] - Q[0], ty = P[1] - Q[1], tz = P[2] - Q[2]; const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
    const d = rowAngle(p, v) * D2R, nx = p.side * Math.cos(d), nz = -p.side * Math.sin(d);   // leeward normal
    const t = p.t, wob = Math.sin(TAU * (3.1 * t + k * 0.37 + p.phase));
    for (const face of head ? [-1, 1] : [0]) {
      const lee = face === 0 ? 0 : face === p.side ? 1 : -1;    // +1: this ribbon is on the leeward face
      let dx = tx, dy = ty - 0.12, dz = tz;
      if (code === 1 && lee <= 0) { dx = tx * 0.35 - nx * 0.3; dy = 0.85 + 0.1 * wob; dz = tz * 0.35 - nz * 0.3; }        // windward ribbon lifts / twirls
      else if (code === 2 && lee >= 0) { dx = -tx * 0.25 + nx * 0.55; dy = -0.75; dz = -tz * 0.25 + nz * 0.55; }          // leeward ribbon stalls, droops and curls
      else { dx += 0.08 * wob * nx; dz += 0.08 * wob * nz; }
      const l = Math.hypot(dx, dy, dz) || 1;
      const off = face === 0 ? 0 : 0.012 * (face === p.side ? 1 : -1);
      out.push({ p: [P[0] + nx * off, P[1], P[2] + nz * off], d: [dx / l, dy / l, dz / l], face: face === 0 ? p.side : face, code });
    }
  }
  return out;
}

/** Reef points (§4.3): small dots on every reef line not taken in. → [[x, y, z] …] */
export function reefPoints(p) {
  const s = p.s; if (!p.visible || !s.reefs.length) return [];
  const out = [];
  for (let k = Math.round(p.reef) + 1; k < s.reefV.length; k++) {
    const vAbs = s.reefV[k], v = (vAbs - p.vr) / (1 - p.vr); if (!(v > 0 && v < 1)) continue;
    const { L, C } = row(p, v), n = Math.max(3, Math.round(Math.abs(C[0] - L[0]) / 0.6));
    for (let i = 1; i < n; i++) out.push(sailPoint(p, i / n, v, [0, 0, 0]));
  }
  return out;
}

/**
 * What to draw for a sail that is (partly) stowed: furled roll on the stay, flaked bundle on the boom, bag on deck.
 * → { kind: 'roll' | 'bundle' | 'bag' | 'gaffDown', a, b, r } or null.
 */
export function stowedOf(p, boom) {
  const s = p.s, A = s.def.A;
  if (s.furl) {
    const rolled = (1 - p.unroll) * A; if (rolled < 0.3) return null;
    const a = [0, s.tack[1], s.tack[0]], h = [0, s.head[1], s.head[0]];
    return { kind: 'roll', a, b: h, r: 0.03 + 0.017 * Math.sqrt(rolled) };
  }
  const reefed = p.visible ? (1 - (s.reefs.length ? (p.reef > 0 ? s.reefs[Math.ceil(p.reef) - 1] : 1) : 1)) * A : 0;
  const down = !p.visible ? A : reefed;
  if (down < 0.5) return null;
  if (boom) {
    const r = 0.05 + 0.024 * Math.sqrt(down);
    const a = boom.a, e = boom.b, f = 0.08, g = 0.92;
    return { kind: 'bundle', a: [lerp(a[0], e[0], f), lerp(a[1], e[1], f) + r * 0.8, lerp(a[2], e[2], f)], b: [lerp(a[0], e[0], g), lerp(a[1], e[1], g) + r * 0.8, lerp(a[2], e[2], g)], r };
  }
  if (!p.visible) {
    if (s.kind === 'top') { const m = s.mast; return { kind: 'roll', a: [0, s.tack[1], m.z + 0.12], b: [0, s.head[1] - 0.6, m.z + 0.12], r: 0.07 }; }
    // hanked headsail lowered: bagged along the foot of its stay (on the bowsprit / foredeck)
    const a = [0, s.tack[1] + 0.12, s.tack[0]], t = 0.18, h = [0, lerp(s.tack[1], s.head[1], t) + 0.12, lerp(s.tack[0], s.head[0], t)];
    return { kind: 'bag', a, b: h, r: 0.06 + 0.012 * Math.sqrt(A) };
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ rigging
const LEADS = {
  sloop: { genoa: { lead: (sd) => [sd * 1.45, 1.36, 0.45], winch: (sd) => [sd * 1.35, 1.82, 2.3] } },
  ketch: { yankee: { lead: (sd) => [sd * 2.08, 1.62, 0.1], winch: (sd) => [sd * 1.85, 2.06, 2.4] }, stay: { lead: (sd) => [sd * 1.2, 2.2, -0.9], winch: (sd) => [sd * 1.6, 2.06, 2.0] } },
  catamaran: { jib: { self: { z: -3.2, y: 2.0, half: 1.2 }, winch: () => [1.0, 4.05, 2.7] }, code0: { lead: (sd) => [sd * 3.6, 1.5, 4.8], winch: (sd) => [sd * 2.4, 2.05, 4.3] } },
  schooner: { flyjib: { lead: (sd) => [sd * 3.4, 2.45, -9.8] }, jib: { lead: (sd) => [sd * 3.45, 2.45, -7.2] }, stay: { lead: (sd) => [sd * 0.5, 2.4, -9.7] } },
};

/** Stay / chainplate attachment repaired onto the hull where the frozen data ends off the hull (bobstay, whiskers). */
function onHull(cls, q) {
  const [x, y, z] = q, H = hullOf(cls);
  if (!H) return q;
  if (Math.abs(x) < 0.05 && y < sheerY(cls, z) - 0.3) return [0, y, stemZ(cls, y) + 0.05];                   // stem fitting
  const hb = deckHalf(cls, z);
  if (Math.abs(x) > hb + 0.1 && z < 0) { const zz = Math.max(z, -H.L / 2 + 1.2); return [Math.sign(x) * hullHalfAt(cls, zz, y), y, zz]; }   // whisker end on the bow
  if (z > hullExtent(cls).zDeckEnd - 0.05) return [x, y, hullExtent(cls).zDeckEnd - 0.08];
  return q;
}

/**
 * Standing rigging (static, ship frame): [{ a, b, r (m), kind }]. kind: shroud | stay | backstay | bobstay | ratline |
 * foil (roller furler) | spreader | crosstree. Lines thinner than 1 cm are lines only (r = 0.004…).
 */
export function standingRigging(cls) {
  const b = rigBase(cls); if (!b) return [];
  const R = b.R, sp = R.spars, out = [];
  const wire = cls === 'schooner' ? 0.011 : cls === 'ketch' ? 0.006 : 0.005;
  const seg = (a, c, kind, r = wire) => out.push({ a, b: c, r, kind });
  for (const m of sp.masts) {
    const sprs = sp.spreaders.filter((x) => x.mast === m.id).sort((p, q) => p.y - q.y);
    const cps = sp.chainplates.filter((c) => c.mast === m.id);
    const hounds = Math.max(...sp.stays.filter((st) => Math.abs(st.to[2] - m.z) < 0.2 && st.to[1] <= m.top + 0.01 && !st.running && !(st.sail && b.byId[st.sail]?.def.light)).map((st) => st.to[1]), m.top * 0.85);
    for (const sd of [-1, 1]) {
      for (const cp of cps) {
        const zs = cp.zs || [cp.z];
        if (sprs.length && !sprs[0].crosstrees) {
          const tips = sprs.map((s0) => [sd * s0.half * Math.cos((s0.sweep || 0) * D2R), s0.y, m.z + s0.half * Math.sin((s0.sweep || 0) * D2R)]);
          const base = [sd * cp.x, cp.y, zs[0]];
          // cap shroud over every spreader tip to the hounds / masthead
          let prev = base;
          for (const t of tips) { seg(prev, t, 'shroud'); prev = t; }
          seg(prev, [0, Math.min(hounds, m.top), m.z], 'shroud');
          // lowers (fore + aft) to the first spreader root; intermediates tip → next root
          seg([sd * cp.x, cp.y, zs[0] - 0.35], [0, sprs[0].y, m.z], 'shroud');
          seg([sd * cp.x, cp.y, zs[0] + 0.35], [0, sprs[0].y, m.z], 'shroud');
          for (let i = 0; i < tips.length - 1; i++) seg(tips[i], [0, sprs[i + 1].y, m.z], 'shroud');
          for (const t of tips) seg([0, t[1], m.z], t, 'spreader', 0.025);
        } else {
          // schooner: three lower shrouds from the channels (deadeyes) to the hounds below the crosstrees, ratlines
          const ct = sprs[0], hy = ct ? ct.y - 0.5 : m.top - 1;
          const ends = zs.map((z) => [sd * cp.x, cp.y + 0.45, z]);
          for (const e of ends) seg(e, [sd * mastRadius(m, hy), hy, m.z], 'shroud', wire * 1.6);
          // ratlines every 0.38 m between the lower shrouds up to 3 m below the hounds
          for (let y = cp.y + 1.0; y < hy - 3; y += 0.38) {
            const f = (y - (cp.y + 0.45)) / (hy - (cp.y + 0.45));
            const pts = ends.map((e) => [lerp(e[0], sd * mastRadius(m, hy), f), y, lerp(e[2], m.z, f)]);
            for (let i = 0; i < pts.length - 1; i++) seg(pts[i], pts[i + 1], 'ratline', 0.004);
          }
          if (ct && m.topmast) {
            const tip = [sd * ct.half, ct.y, m.z + 0.1];
            seg([sd * 0.3, ct.y, m.z], tip, 'crosstree', 0.06);
            seg(tip, [0, m.topmast - 0.7, m.z], 'shroud', wire);                           // topmast shroud
            seg(tip, [sd * mastRadius(m, hy - 2.2), hy - 2.2, m.z], 'shroud', wire * 0.8);   // futtock shroud
          }
        }
      }
    }
  }
  for (const st of sp.stays) {
    if (st.running) continue;                                 // runners are drawn with the running rigging (one slack)
    const sides = st.mirror ? [-1, 1] : [1];
    for (const sd of sides) {
      let a = st.from.slice(), c = st.to.slice();
      if (st.mirror) c[0] = sd * Math.abs(c[0]);
      if (st.id === 'bobstay' || st.id === 'whisker') c = onHull(cls, c);
      const kind = st.kind === 'furler' ? 'foil' : st.id === 'bobstay' || st.id === 'whisker' || st.id === 'martingale' ? 'bobstay' : /back/i.test(st.id) ? 'backstay' : 'stay';
      if (st.split) {                                         // split backstay: one leg to each quarter
        const ext = hullExtent(cls), zEnd = Math.min(c[2], ext.zDeckEnd - 0.1);
        const sy = c[1] + 3.0, f = (a[1] - sy) / (a[1] - c[1]), split = [0, sy, lerp(a[2], zEnd, f)];
        seg(a, split, 'backstay');
        for (const s2 of [-1, 1]) seg(split, [s2 * Math.min(1.0, deckHalf(cls, zEnd) - 0.2), c[1], zEnd], 'backstay');
      } else seg(a, c, kind, kind === 'foil' ? 0.022 : kind === 'bobstay' ? wire * 1.8 : wire);
    }
  }
  // schooner: martingale back ropes from the dolphin striker to the bows
  if (sp.bowsprit && sp.bowsprit.martingale) {
    const mg = sp.bowsprit.martingale, z = -R.loa / 2 + 1.0;
    for (const sd of [-1, 1]) seg(mg, [sd * hullHalfAt(cls, z, 1.4), 1.4, z], 'bobstay', wire * 1.4);
  }
  return out;
}

/** Leeward side of the rig (the main's side, else the heel's). */
function rigSide(frameSails, heel) {
  const m = frameSails.find((p) => p && p.visible && (p.s.kind === 'boom' || p.s.kind === 'gaff'));
  if (m) return m.side;
  return heel > 0 ? 1 : -1;
}
function sagLine(a, c, sag, n = 5) {
  const pts = [];
  for (let i = 0; i <= n; i++) { const t = i / n; pts.push([lerp(a[0], c[0], t), lerp(a[1], c[1], t) - sag * 4 * t * (1 - t), lerp(a[2], c[2], t)]); }
  return pts;
}

/**
 * Everything dynamic for a RigView: per-sail params, boom / gaff / club poses, running rigging and telltales.
 * view = { heel, sails: [{ id, hoist, reef, angle, state, tt, side? }] }; opts = { t, aws, side, angles: {id: deg} (animated) }
 * → { params: {id: p}, booms: [{ sail, a, b, r }], gaffs: [...], sheets: [{ sail, pts, r }], runners, halyards, telltales }
 */
export function rigFrame(cls, view, opts = {}) {
  const b = rigBase(cls); if (!b || !view || !Array.isArray(view.sails)) return null;
  const heel = Number(view.heel) || 0;
  const sideFallback = heel > 0.5 ? 1 : heel < -0.5 ? -1 : (opts.side === 1 ? 1 : -1);
  const params = {}, list = [];
  const ang = opts.angles || {};
  const viewOf = Object.fromEntries(view.sails.map((x) => [x.id, x]));
  for (const s of b.sails) {                                  // RIGS order: gaff sails come before their topsails
    const sv0 = viewOf[s.id] || { id: s.id, hoist: 0, reef: 0, angle: 0, state: 5, tt: 0 };
    const sv = Number.isFinite(ang[s.id]) ? { ...sv0, angle: ang[s.id] } : sv0;
    let gaffAngle;
    if (s.follows && params[s.follows] && params[s.follows].visible) gaffAngle = rowAngle(params[s.follows], 1);
    const p = sailParams(cls, sv, { t: opts.t, aws: opts.aws, side: sideFallback, gaffAngle });
    if (s.follows && params[s.follows]) p.side = params[s.follows].side;
    params[s.id] = p; list.push(p);
  }
  const booms = [], gaffs = [];
  for (const bm of b.R.spars.booms) {
    const p = params[bm.sail]; if (!p) continue;
    const a = p.angle;
    if (bm.club) {
      const { p: piv, len, rise } = boomPivot(b, bm), h = Math.sqrt(Math.max(0, len * len - rise * rise)), r = a * D2R;
      booms.push({ sail: bm.sail, a: piv, b: [piv[0] + h * Math.sin(r), piv[1] + rise, piv[2] + h * Math.cos(r)], r: 0.07, club: true });
    } else { const pose = boomPose(cls, bm.sail, a); booms.push({ sail: bm.sail, a: pose.a, b: pose.b, r: boomR(cls, bm) }); }
  }
  for (const g of b.R.spars.gaffs) {
    const p = params[g.sail]; if (!p) continue;
    const th = sailPoint(p, 0, 1, [0, 0, 0], true), pk = sailPoint(p, 1, 1, [0, 0, 0], true);
    if (!p.visible) {                                         // lowered: the gaff lies on top of the furled sail on the boom
      const bo = booms.find((x) => x.sail === g.sail);
      if (bo) { const dir = sub(bo.b, bo.a), l = len3(dir), gl = Math.hypot(g.peak[0] - g.throat[0], g.peak[1] - g.throat[1]); th[0] = bo.a[0]; th[1] = bo.a[1] + 0.55; th[2] = bo.a[2] + 0.1; for (let k = 0; k < 3; k++) pk[k] = th[k] + (dir[k] / l) * gl * 0.97; pk[1] += 0.25; }
    }
    gaffs.push({ sail: g.sail, a: th, b: pk, r: cls === 'schooner' ? (g.sail === 'main' ? 0.11 : 0.095) : 0.06 });
  }
  const side = rigSide(list, heel);
  // ---- sheets
  const sheets = [];
  const L = LEADS[cls] || {};
  for (const p of list) {
    if (!p.visible) continue;
    const s = p.s;
    const clew = sailPoint(p, 1, 0, [0, 0, 0]);
    const slack = p.state === 2 ? 0.25 + 0.15 * Math.sin(TAU * p.fFlog * p.t) : p.state === 1 ? 0.12 : 0.03 + 0.08 * clamp(Math.abs(p.angle) / 80, 0, 1);
    if (s.kind === 'boom' || s.kind === 'gaff') {
      const bo = booms.find((x) => x.sail === s.id), tr = b.R.spars.travellers.find((t) => t.sail === s.id);
      if (!bo || !tr) continue;
      const f = clamp((tr.z - bo.a[2]) / Math.max(0.1, bo.b[2] - bo.a[2]), 0.45, 0.97);
      const at = [lerp(bo.a[0], bo.b[0], f), lerp(bo.a[1], bo.b[1], f) - 0.06, lerp(bo.a[2], bo.b[2], f)];
      const car = [clamp(at[0], -tr.half, tr.half), tr.y + 0.08, tr.z];
      for (const dx of [-0.05, 0.05]) sheets.push({ sail: s.id, pts: sagLine([at[0] + dx, at[1], at[2]], [car[0] + dx, car[1], car[2]], slack * 0.3, 2), r: 0.006, kind: 'mainsheet', car });
    } else if (s.kind === 'head') {
      const ld = L[s.id];
      if (s.club) {
        const bo = booms.find((x) => x.sail === s.id);
        const end = bo ? bo.b : clew, to = ld ? ld.lead(p.side) : [p.side * 0.5, 2.4, end[2] + 0.8];
        sheets.push({ sail: s.id, pts: sagLine(end, [clamp(end[0], -0.9, 0.9), to[1], to[2]], slack * 0.5, 3), r: 0.007, kind: 'sheet' });
      } else if (ld && ld.self) {                             // self-tacking jib: clew → car on the athwartships track
        const car = [clamp(clew[0], -ld.self.half, ld.self.half), ld.self.y, ld.self.z];
        sheets.push({ sail: s.id, pts: sagLine(clew, car, slack, 4), r: 0.006, kind: 'sheet', car });
      } else {
        const lead = ld && ld.lead ? ld.lead(p.side) : [p.side * 0.8 * deckHalf(cls, clew[2] + 2), sheerY(cls, clew[2] + 2) + 0.15, clew[2] + 2];
        const pts = sagLine(clew, lead, slack * Math.hypot(clew[0] - lead[0], clew[1] - lead[1], clew[2] - lead[2]) * 0.06, 5);
        if (ld && ld.winch) pts.push(ld.winch(p.side));
        sheets.push({ sail: s.id, pts, r: 0.006, kind: 'sheet' });
        // lazy sheet on the windward side, slack
        const lz = ld && ld.lead ? ld.lead(-p.side) : [-lead[0], lead[1], lead[2]];
        sheets.push({ sail: s.id, pts: sagLine(clew, lz, 0.6, 5), r: 0.005, kind: 'lazy' });
      }
    }
  }
  // ---- running backstays: windward one set up, leeward one slack forward
  const runners = [];
  for (const st of b.R.spars.stays) {
    if (!st.running) continue;
    for (const sd of [-1, 1]) {
      const to = [sd * Math.abs(st.to[0]), st.to[1], st.to[2]];
      if (sd === -side) runners.push({ pts: [st.from.slice(), to], r: 0.008, kind: 'runner' });
      else { const lz = [sd * Math.abs(st.to[0]) * 0.92, st.to[1] + 0.3, st.to[2] - 2.6]; runners.push({ pts: sagLine(st.from, lz, 0.5, 5), r: 0.007, kind: 'runner' }); }
    }
  }
  // ---- halyards: from the head up to the masthead sheave, down the mast front to the deck
  const halyards = [];
  for (const p of list) {
    if (!p.visible) continue;
    const s = p.s, head = sailPoint(p, 0, 1, [0, 0, 0], true);
    const m = s.mast || luffMast(b.R, s.head[0]);
    if (!m) continue;
    const topY = (m.topmast && head[1] > m.top - 0.5 ? m.topmast : m.top) - 0.15;
    halyards.push({ pts: [head, [0, Math.max(head[1] + 0.2, topY), m.z + (s.kind === 'head' ? -mastRadius(m, topY) - 0.02 : mastRadius(m, topY) + 0.02)], [0, m.foot + 0.6, m.z - mastRadius(m, m.foot) - 0.03]], r: 0.005, kind: 'halyard' });
  }
  // ---- telltales and reef points
  const tts = [], reefs = [];
  for (const p of list) { if (LOOKS_TT && p.visible) { for (const t of telltales(p)) tts.push(t); for (const r of reefPoints(p)) reefs.push(r); } }
  return { params, list, booms, gaffs, sheets, runners, halyards, telltales: tts, reefPoints: reefs, side };
}
const LOOKS_TT = true;
function boomR(cls, bm) { return cls === 'schooner' ? (bm.sail === 'main' ? 0.15 : 0.12) : cls === 'catamaran' ? 0.11 : bm.sail === 'mizzen' ? 0.065 : 0.08; }
const sub = (a, c) => [a[0] - c[0], a[1] - c[1], a[2] - c[2]];
const len3 = (a) => Math.hypot(a[0], a[1], a[2]) || 1;

// ------------------------------------------------------------------------------------------------ animation
/**
 * Critically damped spring towards `target` (exact solution: stable for any dt). st = { x, v } (x deg, v deg/s).
 * ω = 3 rad/s for LOA ≤ 16 m, 1.5 rad/s for the schooner (§4.4).
 */
export function springStep(st, target, omega, dt) {
  if (!(dt > 0)) return st;
  const x0 = st.x - target, v0 = st.v, e = Math.exp(-omega * dt), c = v0 + omega * x0;
  st.x = target + (x0 + c * dt) * e;
  st.v = (v0 - omega * c * dt) * e;
  return st;
}
export function springOmega(cls) { const R = rigOf(cls); return R && R.loa > 16 ? 1.5 : 3; }
/**
 * Crash jibe (flag bit 4): the boom crosses at 180°/s, then a 0.5 s overshoot wobble. st = { x, v, crash: s left }.
 * Returns true while the crash animation owns the boom.
 */
export function crashStep(st, target, dt) {
  if (!(st.crash > 0)) return false;
  const d = target - st.x, step = 180 * dt;
  if (Math.abs(d) > step) { st.x += Math.sign(d) * step; st.v = Math.sign(d) * 180; return true; }
  st.x = target; st.v = Math.sign(d || 1) * 140; st.crash = 0;            // hand over to the spring with an overshoot
  return false;
}

// ------------------------------------------------------------------------------------------------ clearances (tests)
/** Mast foot gap (m) to every deck structure footprint: [{ mast, structure, gap, onRoof }]. */
export function mastClearances(cls) {
  const R = rigOf(cls); if (!R) return [];
  const out = [];
  for (const m of R.spars.masts) {
    const r = mastRadius(m, m.foot);
    for (const s of structures(cls)) {
      if (s.kind === 'cockpit' || s.kind === 'helm' || s.kind === 'trampoline' || s.soft) continue;
      // the mast stands on the centreline (x = 0), every structure spans it: the gap is along z
      const dz = m.z < s.z0 ? s.z0 - m.z : m.z > s.z1 ? m.z - s.z1 : 0;
      const inside = dz === 0;
      out.push({ mast: m.id, structure: s.id, gap: inside ? -r : dz - r, onRoof: !!m.onRoof && inside && Math.abs(m.foot - s.top) < 0.05 });
    }
  }
  return out;
}
/**
 * Boom sweep 0…dmax (both sides): minimum gap from the boom's underside to the deck structure tops it passes over and
 * to the walkable deck (outside structures). → [{ sail, structGap, structId, deckGap }]
 */
export function boomSweep(cls, stepDeg = 5) {
  const b = rigBase(cls); if (!b) return [];
  const out = [];
  for (const bm of b.R.spars.booms) {
    if (bm.club) continue;
    const s = b.byId[bm.sail], dmax = s.def.dmax;
    let structGap = Infinity, structId = null, deckGap = Infinity;
    for (let a = -dmax; a <= dmax + 1e-9; a += stepDeg) {
      const pose = boomPose(cls, bm.sail, a);
      for (let t = 0; t <= 1.0001; t += 0.02) {
        // measured from the boom's axis (the contract's numbers: gooseneck height − deck height)
        const x = lerp(pose.a[0], pose.b[0], t), y = lerp(pose.a[1], pose.b[1], t), z = lerp(pose.a[2], pose.b[2], t);
        let over = null;
        for (const st of structures(cls)) {
          if (st.kind === 'cockpit' || st.kind === 'helm' || st.kind === 'trampoline') continue;
          if (z >= st.z0 && z <= st.z1 && Math.abs(x) <= structHalfAt(st, z)) { const g = y - st.top; if (g < structGap) { structGap = g; structId = st.id; } over = st; }
        }
        if (!over) { const d = deckHeightAt(cls, x, z); if (d !== null && y - d < deckGap) deckGap = y - d; }
      }
    }
    out.push({ sail: bm.sail, structGap, structId, deckGap });
  }
  return out;
}
/** Distance (m) from point q [x, y, z] to the segment a → c. */
export function distToSegment(q, a, c) {
  const d = sub(c, a), l2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2] || 1;
  const t = clamp(((q[0] - a[0]) * d[0] + (q[1] - a[1]) * d[1] + (q[2] - a[2]) * d[2]) / l2, 0, 1);
  return Math.hypot(q[0] - a[0] - d[0] * t, q[1] - a[1] - d[1] * t, q[2] - a[2] - d[2] * t);
}
/** The stay a headsail's luff runs on, as [from, to] in the ship frame (null for sails without one). */
export function stayOf(cls, id) { const s = rigBase(cls)?.byId[id]; return s && s.stay ? [s.stay.from, s.stay.to] : null; }
