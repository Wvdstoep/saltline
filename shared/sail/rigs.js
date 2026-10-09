// Saltline sailing — rig data (docs/SAILING-CONTRACT.md §2.4 and Appendix A `TYPES` / `RIGS`). Data only + tiny
// helpers. Pure, deterministic, no DOM: shared by the server, the client prediction, the polar generator and the tests.
// Ship frame: x to starboard, y up (0 = waterline), z aft (bow at −L/2). Sail points [z, y] in the centre plane:
// tack → head → clew (gaff sails: tack → throat → peak → clew). Do not change a number here without re-running
// scripts/gen-polars.mjs (and the reviewer's Appendix A tables).

export const D2R = Math.PI / 180;
export const KN = 0.514444;                          // m/s per knot
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
/** Piecewise-linear table lookup; past the last point the last slope continues (Appendix A `lerpT`). */
export const lerpT = (T, x) => {
  if (x <= T[0][0]) return T[0][1];
  for (let i = 1; i < T.length; i++) if (x <= T[i][0]) { const [x0, y0] = T[i - 1], [x1, y1] = T[i]; return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0); }
  const [xa, ya] = T[T.length - 2], [xb, yb] = T[T.length - 1]; return yb + ((yb - ya) * (x - xb)) / (xb - xa);
};

/** Sail section types: clmax, stall AoA `as` (deg), parasitic cd0, base twist tw0 (deg, foot → head). */
export const SAIL_TYPES = {
  main:    { clmax: 1.50, as: 20, cd0: 0.030, tw0: 6 },
  gaff:    { clmax: 1.32, as: 22, cd0: 0.055, tw0: 12 },
  genoa:   { clmax: 1.65, as: 18, cd0: 0.028, tw0: 8 },
  jib:     { clmax: 1.60, as: 18, cd0: 0.030, tw0: 8 },
  stay:    { clmax: 1.50, as: 18, cd0: 0.032, tw0: 8 },
  topsail: { clmax: 1.25, as: 20, cd0: 0.055, tw0: 8 },
  mizzen:  { clmax: 1.45, as: 20, cd0: 0.032, tw0: 6 },
  code0:   { clmax: 1.75, as: 28, cd0: 0.040, tw0: 10 },
};

// polygon area and centroid (Appendix A `poly`); the sail area is the polygon × roach
const poly = (P) => {
  let a = 0, cz = 0, cy = 0;
  for (let i = 0; i < P.length; i++) { const [z0, y0] = P[i], [z1, y1] = P[(i + 1) % P.length]; const c = z0 * y1 - z1 * y0; a += c; cz += (z0 + z1) * c; cy += (y0 + y1) * c; }
  a /= 2; return { A: Math.abs(a), zc: cz / (6 * a), yc: cy / (6 * a) };
};
function mk(cls, r) {
  r.cls = cls;
  for (const s of r.sails) {
    const g = poly(s.pts);
    s.A = g.A * (s.roach || 1); s.zc = g.zc; s.yc = g.yc;
    s.y0 = Math.min(...s.pts.map((p) => p[1])); s.y1 = Math.max(...s.pts.map((p) => p[1]));
    s.boom = !s.head && s.travMin !== undefined;     // boomed sail with a traveller (main, mizzen, gaff fore/main)
    s.reefs = s.reefs || [];
    s.furl = !!s.furl; s.light = !!s.light;
  }
  r.ids = r.sails.map((s) => s.id);
  r.byId = Object.fromEntries(r.sails.map((s) => [s.id, s]));
  return r;
}

// Hull fields (Appendix A names): LWL, T, disp (t), GM, AVS, Sw, Alat, ARk, bK, Ar, br, zr, zclr, xclr, Apar, rr, fb,
// phiT, turn, tauPhi. Game fields (§2.4 / §2.10): loa (C.length), vmaxKn, crew (parallel jobs), tauV (fast path lag, s).
// Sail fields: id, name (HUD), type, pts, roach, reefs (area factors), furl (roller), light (code 0 / topsails / flying
// jib), head (headsail: luff on a stay, no boom), dmin/dmax (chord angle range, deg), travMin/travMax (traveller car),
// kind (furler / hanked / club-footed — the renderer), selfTack (cat jib), follows (topsails: the gaff sail below).
export const RIGS = {
  sloop: mk('sloop', {
    LWL: 9.7, T: 1.9, disp: 6.0, GM: 1.45, AVS: 120, Sw: 25, Alat: 2.9, ARk: 1.6, bK: 2.85, Ar: 0.55, br: 1.35, zr: 4.3, zclr: 0.8, xclr: 0.0, Apar: 8, rr: 'mod', fb: 1.25, phiT: 22, turn: 22, tauPhi: 1.5,
    loa: 11, vmaxKn: 12, crew: 1, tauV: 10,
    sails: [
      { id: 'genoa', name: 'genoa', type: 'genoa', pts: [[-5.35, 1.65], [-1.45, 15.0], [0.0, 1.95]], furl: true, kind: 'roller', dmin: 12, dmax: 75, head: true },
      { id: 'main', name: 'mainsail', type: 'main', pts: [[-1.3, 3.15], [-1.3, 15.9], [3.1, 3.3]], roach: 1.15, reefs: [0.78, 0.58], dmin: -3, dmax: 80, travMin: -3, travMax: 12 },
    ],
    plans: [{ maxTws: 24, set: {} }, { minTws: 14, set: { main: { reef: 1 }, genoa: { furl: 0.25 } } }, { minTws: 20, set: { main: { reef: 2 }, genoa: { furl: 0.5 } } }, { minTws: 28, set: { main: { reef: 2 }, genoa: { furl: 0.75 } } }],
    spars: {
      masts: [{ id: 'main', z: -1.3, foot: 1.80, top: 16.2, d0: 0.20, d1: 0.12, mat: 'alu', onRoof: true }],
      booms: [{ sail: 'main', mast: 'main', z: -1.3, y: 3.15, len: 4.45, rise: 0.15 }],
      gaffs: [],
      spreaders: [{ mast: 'main', y: 6.6, half: 1.25, sweep: 20 }, { mast: 'main', y: 11.3, half: 0.85, sweep: 20 }],
      chainplates: [{ mast: 'main', x: 1.55, y: 1.30, z: -0.95 }],
      stays: [
        { id: 'forestay', from: [0, 1.65, -5.35], to: [0, 15.2, -1.3], kind: 'furler', sail: 'genoa' },
        { id: 'backstay', from: [0, 16.2, -1.3], to: [0, 1.15, 5.45], split: true },
      ],
      bowsprit: null,
      travellers: [{ sail: 'main', z: 3.0, y: 0.85, half: 0.95 }],
      leads: [{ sail: 'genoa', track: { x: 1.45, z0: -0.6, z1: 0.6 }, winch: [1.35, 1.75, 2.3] }],
      winches: [{ use: 'primary', at: [1.35, 1.75, 2.3], mirror: true }, { use: 'halyard', at: [0.55, 1.85, 1.4], mirror: true }],
      wheel: { at: [0, 1.75, 4.1], r: 0.50, kind: 'pedestal' },
      keel: { kind: 'fin-bulb', rootChord: 1.6, tipChord: 1.1, y0: -0.5, y1: -1.5, sweep: 15, le: -0.6, bulb: { y0: -1.5, y1: -1.9, len: 2.2 } },
      rudders: [{ kind: 'spade', z: 4.3, span: 1.35, chord: 0.42 }],
    },
  }),
  ketch: mk('ketch', {
    LWL: 13.4, T: 2.3, disp: 18, GM: 1.5, AVS: 125, Sw: 40, Alat: 6.5, ARk: 1.0, bK: 3.2, Ar: 1.0, br: 1.5, zr: 6.6, zclr: 1.0, xclr: 0.0, Apar: 13, rr: 'heavy', fb: 1.45, phiT: 20, turn: 16, tauPhi: 2,
    loa: 16, vmaxKn: 13, crew: 1, tauV: 15,
    sails: [
      { id: 'yankee', name: 'yankee', type: 'jib', pts: [[-9.0, 2.0], [-2.75, 18.4], [-3.6, 5.2]], furl: true, kind: 'roller', dmin: 13, dmax: 75, head: true },
      { id: 'stay', name: 'staysail', type: 'stay', pts: [[-6.4, 1.75], [-2.75, 13.8], [-2.3, 2.3]], kind: 'hanked', dmin: 11, dmax: 70, head: true },
      { id: 'main', name: 'mainsail', type: 'main', pts: [[-2.6, 3.45], [-2.6, 18.45], [2.6, 3.6]], roach: 1.1, reefs: [0.78, 0.58], dmin: -3, dmax: 80, travMin: -3, travMax: 12 },
      { id: 'mizzen', name: 'mizzen', type: 'mizzen', pts: [[4.0, 3.65], [4.0, 13.4], [7.4, 3.8]], roach: 1.1, reefs: [0.75], dmin: -2, dmax: 80, travMin: -2, travMax: 10 },
    ],
    plans: [{ maxTws: 24, set: {} }, { minTws: 14, set: { yankee: { furl: 0.3 }, main: { reef: 1 } } }, { minTws: 20, set: { yankee: { hoist: 0 }, main: { reef: 2 }, mizzen: { reef: 1 } } }, { minTws: 30, set: { yankee: { hoist: 0 }, main: { hoist: 0 }, mizzen: { reef: 1 } } }],
    spars: {
      masts: [
        { id: 'main', z: -2.6, foot: 1.55, top: 18.85, d0: 0.22, d1: 0.13, mat: 'alu' },
        { id: 'mizzen', z: 4.0, foot: 1.40, top: 13.7, d0: 0.15, d1: 0.09, mat: 'alu' },
      ],
      booms: [{ sail: 'main', mast: 'main', z: -2.6, y: 3.45, len: 5.2, rise: 0.15 }, { sail: 'mizzen', mast: 'mizzen', z: 4.0, y: 3.65, len: 3.4, rise: 0.15 }],
      gaffs: [],
      spreaders: [{ mast: 'main', y: 7.6, half: 1.4, sweep: 0 }, { mast: 'main', y: 13.0, half: 0.95, sweep: 0 }, { mast: 'mizzen', y: 9.0, half: 0.9, sweep: 0 }],
      chainplates: [{ mast: 'main', x: 2.15, y: 1.45, z: -2.6 }, { mast: 'mizzen', x: 1.75, y: 1.40, z: 4.1 }],
      stays: [
        { id: 'yankee', from: [0, 2.0, -9.0], to: [0, 18.85, -2.6], kind: 'furler', sail: 'yankee' },
        { id: 'inner', from: [0, 1.75, -6.4], to: [0, 13.8, -2.6], kind: 'hanked', sail: 'stay' },
        { id: 'runner', from: [0, 13.8, -2.6], to: [2.0, 1.5, 4.8], mirror: true, running: true },
        { id: 'triatic', from: [0, 18.85, -2.6], to: [0, 13.7, 4.0] },
        { id: 'mizzenBack', from: [0, 13.7, 4.0], to: [1.6, 1.45, 7.6], mirror: true },
      ],
      bowsprit: { from: [0, 1.8, -7.9], to: [0, 2.0, -9.1], pulpit: true },
      travellers: [{ sail: 'main', z: 1.6, y: 2.45, half: 0.9 }, { sail: 'mizzen', z: 7.5, y: 1.5, half: 0.7 }],
      leads: [{ sail: 'yankee', winch: [1.85, 2.0, 2.4] }, { sail: 'stay', winch: [1.6, 2.0, 2.0] }],
      winches: [{ use: 'yankee', at: [1.85, 2.0, 2.4], mirror: true }, { use: 'staysail', at: [1.6, 2.0, 2.0], mirror: true }],
      wheel: { at: [0, 2.35, 5.4], r: 0.60, kind: 'pedestal' },
      keel: { kind: 'long-fin', z0: -2.4, z1: 1.8, y1: -2.3 },
      rudders: [{ kind: 'skeg', z0: 6.2, z1: 7.0 }],
    },
  }),
  catamaran: mk('catamaran', {
    cat: true, hs: 3.0, phiFly: 5, KG: 2.4, LWL: 13.6, T: 1.3, disp: 12, GM: 30, AVS: 90, Sw: 42, Alat: 8.2, ARk: 0.7, bK: 2.2, Ar: 0.9, br: 1.0, zr: 6.3, zclr: 0.6, xclr: -0.4, Apar: 30, rr: 'cat', fb: 1.9, phiT: 4, turn: 18, tauPhi: 1.5,
    loa: 14, vmaxKn: 18, crew: 1, tauV: 10,
    sails: [
      { id: 'code0', name: 'code 0', type: 'code0', light: true, pts: [[-7.6, 2.1], [-2.75, 21.2], [0.2, 3.2]], furl: true, kind: 'roller', dmin: 20, dmax: 95, head: true },
      { id: 'jib', name: 'jib', type: 'jib', pts: [[-6.2, 2.0], [-2.8, 19.0], [-2.2, 2.6]], furl: true, kind: 'roller', selfTack: true, dmin: 12, dmax: 60, head: true },
      { id: 'main', name: 'mainsail', type: 'main', pts: [[-2.7, 4.5], [-2.7, 21.8], [3.7, 4.6]], roach: 1.3, reefs: [0.75, 0.55, 0.38], dmin: -3, dmax: 75, travMin: -3, travMax: 15 },
    ],
    plans: [{ maxTws: 14, set: { code0: { hoist: 1 }, jib: { hoist: 0 } } }, { maxTws: 20, set: {} }, { minTws: 16, maxTws: 28, set: { main: { reef: 1 } } }, { minTws: 22, set: { main: { reef: 2 }, jib: { furl: 0.4 } } }],
    spars: {
      masts: [{ id: 'main', z: -2.7, foot: 1.90, top: 22.2, d0: 0.24, d1: 0.14, mat: 'carbon' }],
      booms: [{ sail: 'main', mast: 'main', z: -2.7, y: 4.5, len: 6.4, rise: 0.1 }],
      gaffs: [],
      spreaders: [{ mast: 'main', y: 9.5, half: 1.5, sweep: 25 }, { mast: 'main', y: 15.5, half: 1.0, sweep: 25 }],
      chainplates: [{ mast: 'main', x: 2.35, y: 1.4, z: -2.2 }],
      stays: [
        { id: 'forestay', from: [0, 2.0, -6.2], to: [0, 19.2, -2.75], kind: 'furler', sail: 'jib' },
        { id: 'code0', from: [0, 2.1, -7.6], to: [0, 22.2, -2.7], kind: 'furler', sail: 'code0' },
      ],
      bowsprit: { from: [0, 2.0, -6.2], to: [0, 2.1, -7.6], longeron: true },
      travellers: [{ sail: 'main', z: 3.6, y: 4.05, half: 2.2 }],
      leads: [{ sail: 'jib', track: { z: -3.2, y: 2.0, half: 1.2 }, selfTack: true }],
      winches: [{ use: 'coachroof', at: [1.0, 4.0, 2.7], mirror: true }],
      wheel: { at: [2.2, 2.6, 2.9], r: 0.40, kind: 'bulkhead' },
      keel: { kind: 'mini-keels', chord: 2.0, depth: 0.7, z: 0.6, hullX: 3.0 },
      rudders: [{ kind: 'spade', z: 6.0, area: 0.45, x: 3.0, mirror: true }],
    },
  }),
  schooner: mk('schooner', {
    LWL: 26.5, T: 3.5, disp: 180, GM: 1.35, AVS: 115, Sw: 175, Alat: 48, ARk: 0.7, bK: 4.55, Ar: 4.2, br: 2.6, zr: 15.2, zclr: 1.5, xclr: 2.1, Apar: 70, rr: 'heavy', fb: 1.7, phiT: 18, turn: 9, tauPhi: 3,
    loa: 35, vmaxKn: 15, crew: 2, tauV: 30,
    sails: [
      { id: 'flyjib', name: 'flying jib', type: 'jib', light: true, pts: [[-24.0, 3.2], [-7.7, 27.0], [-17.0, 7.8]], kind: 'hanked', dmin: 14, dmax: 70, head: true },
      { id: 'jib', name: 'jib', type: 'jib', pts: [[-21.0, 2.8], [-7.7, 21.5], [-12.6, 4.0]], kind: 'hanked', dmin: 13, dmax: 70, head: true },
      { id: 'stay', name: 'staysail', type: 'stay', pts: [[-17.2, 2.4], [-7.7, 16.0], [-10.4, 2.9]], kind: 'club', dmin: 12, dmax: 70, head: true },
      { id: 'fore', name: 'foresail', type: 'gaff', blank: true, pts: [[-7.4, 3.9], [-7.4, 17.2], [-1.6, 21.6], [1.8, 4.3]], reefs: [0.78], dmin: 0, dmax: 80, travMin: 0, travMax: 6 },
      { id: 'foretop', name: 'fore topsail', type: 'topsail', light: true, blank: true, follows: 'fore', pts: [[-7.4, 17.4], [-7.4, 27.5], [-1.9, 21.4]], dmin: 4, dmax: 80, travMax: 4 },
      { id: 'main', name: 'mainsail', type: 'gaff', pts: [[3.1, 4.3], [3.1, 20.3], [12.0, 25.7], [17.2, 4.9]], reefs: [0.78, 0.6], dmin: 0, dmax: 80, travMin: 0, travMax: 8 },
      { id: 'maintop', name: 'main topsail', type: 'topsail', light: true, follows: 'main', pts: [[3.1, 20.5], [3.1, 32.5], [11.7, 25.4]], dmin: 4, dmax: 80, travMax: 4 },
    ],
    plans: [{ maxTws: 18, set: {} }, { maxTws: 26, set: { flyjib: { hoist: 0 }, foretop: { hoist: 0 }, maintop: { hoist: 0 } } }, { minTws: 16, set: { flyjib: { hoist: 0 }, foretop: { hoist: 0 }, maintop: { hoist: 0 }, main: { reef: 1 } } }, { minTws: 22, set: { flyjib: { hoist: 0 }, foretop: { hoist: 0 }, maintop: { hoist: 0 }, jib: { hoist: 0 }, main: { reef: 2 }, fore: { reef: 1 } } }],
    spars: {
      masts: [
        { id: 'fore', z: -7.7, foot: 1.82, top: 22.0, topmast: 28.2, d0: 0.42, d1: 0.28, tm0: 0.20, tm1: 0.10, mat: 'wood' },
        { id: 'main', z: 2.8, foot: 1.70, top: 26.0, topmast: 33.2, d0: 0.48, d1: 0.32, tm0: 0.22, tm1: 0.11, mat: 'wood' },
      ],
      booms: [
        { sail: 'fore', mast: 'fore', z: -7.4, y: 3.9, len: 9.2, rise: 0.4 },
        { sail: 'main', mast: 'main', z: 3.1, y: 4.3, len: 14.1, rise: 0.6 },
        { sail: 'stay', club: true, from: [-17.2, 2.4], to: [-10.4, 2.9] },
      ],
      gaffs: [{ sail: 'fore', throat: [-7.4, 17.2], peak: [-1.6, 21.6] }, { sail: 'main', throat: [3.1, 20.3], peak: [12.0, 25.7] }],
      spreaders: [{ mast: 'fore', y: 21.0, half: 1.8, crosstrees: true }, { mast: 'main', y: 25.3, half: 2.0, crosstrees: true }],
      chainplates: [
        { mast: 'fore', x: 3.65, y: 2.35, zs: [-8.4, -7.7, -7.0], deadeyes: true, ratlines: true },
        { mast: 'main', x: 3.65, y: 2.35, zs: [2.1, 2.8, 3.5], deadeyes: true, ratlines: true },
      ],
      stays: [
        { id: 'staysail', from: [0, 2.4, -17.2], to: [0, 16.0, -7.7], kind: 'hanked', sail: 'stay' },
        { id: 'jib', from: [0, 2.8, -21.0], to: [0, 21.5, -7.7], kind: 'hanked', sail: 'jib' },
        { id: 'flyjib', from: [0, 3.2, -24.0], to: [0, 27.0, -7.7], kind: 'hanked', sail: 'flyjib' },
        { id: 'spring', from: [0, 22.0, -7.7], to: [0, 20.3, 2.8] },
        { id: 'topmastStay', from: [0, 33.2, 2.8], to: [0, 22.0, -7.7] },
        { id: 'runner', from: [0, 20.3, 2.8], to: [3.3, 2.3, 9.0], mirror: true, running: true },
        { id: 'topmastBack', from: [0, 33.2, 2.8], to: [3.4, 2.2, 6.0], mirror: true },
        { id: 'bobstay', from: [0, 3.1, -24.5], to: [0, 0.3, -17.0] },
        { id: 'whisker', from: [0, 3.1, -24.5], to: [1.9, 2.5, -17.5], mirror: true },
        { id: 'martingale', from: [0, 3.1, -24.5], to: [0, 1.2, -20.5] },
      ],
      bowsprit: { heel: [0, 2.5, -14.5], stem: -17.0, tip: [0, 3.1, -24.5], martingale: [0, 1.2, -20.5] },
      travellers: [{ sail: 'fore', z: 1.6, y: 1.95, half: 1.3, horse: true }, { sail: 'main', z: 16.6, y: 2.1, half: 2.0, horse: true }],
      leads: [{ sail: '*', pinRails: true }],
      winches: [],
      wheel: { at: [0, 2.75, 12.6], r: 0.75, kind: 'spoked', box: true },
      keel: { kind: 'full', z0: -10, z1: 8, y1: -3.5 },
      rudders: [{ kind: 'sternpost', z0: 12.5, z1: 15.2 }],
    },
  }),
};

/** The rig of a sail class, or null (engine classes, unknown ids). */
export function rigOf(cls) { return typeof cls === 'string' && Object.prototype.hasOwnProperty.call(RIGS, cls) ? RIGS[cls] : null; }
/** Sail ids in RIGS order (front to back) — the order of `rv` and of the HUD rows. */
export function sailIds(cls) { const r = rigOf(cls); return r ? r.ids.slice() : []; }
/** Sail definition by id (null if unknown). */
export function sailDef(rigOrCls, id) { const r = typeof rigOrCls === 'string' ? rigOf(rigOrCls) : rigOrCls; return r && Object.prototype.hasOwnProperty.call(r.byId, id) ? r.byId[id] : null; }
/** m² = A · reef factor · hoist (furl handled by the caller: hoist = unrolled fraction). */
export function sailArea(rig, id, hoist = 1, reef = 0) {
  const s = sailDef(rig, id); if (!s) return 0;
  const n = Math.max(0, Math.min(s.reefs.length, Math.round(Number(reef) || 0)));
  return s.A * (n ? s.reefs[n - 1] : 1) * clamp(Number(hoist) || 0, 0, 1);
}
/** Sail settings for plan level `lv`: {id: {hoist, reef, furl, delta, twist}}; light sails only when the plan sets them. */
export function planState(rig, lv) {
  const ss = {}, set = rig.plans[lv].set;
  for (const s of rig.sails) { const o = set[s.id] || {}; ss[s.id] = { hoist: o.hoist ?? (s.light ? 0 : 1), reef: o.reef || 0, furl: o.furl || 0, delta: 25, twist: SAIL_TYPES[s.type].tw0 }; }
  return ss;
}
/** Plan levels allowed at this true wind speed (kn). */
export const plansAt = (rig, twsKn) => rig.plans.map((p, i) => i).filter((i) => twsKn >= (rig.plans[i].minTws ?? 0) && twsKn <= (rig.plans[i].maxTws ?? 99));
