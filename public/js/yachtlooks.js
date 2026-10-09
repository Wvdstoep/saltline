// Saltline sailing yachts — per-class hull lines, deck layout and colours (docs/SAILING-CONTRACT.md §4.2, §4.5).
// Pure data + outline functions: no three.js, no DOM. Shared by rigmesh.js (the 3D model), rigcore.js (clearances,
// rigging attachment points) and — phase 2 — shipplan.js (deck plans), so the walker, the rig and the model agree.
//
// Ship frame (metres): x to starboard, y up (0 = waterline), z aft; the bow is at z = −L/2, the stern at +L/2.
// A hull is described by: a sheer line (deck edge height, quadratic through bow / midships / stern), a deck half-breadth
// (fine entry to the maximum beam, then easing to the transom), a canoe-body profile (keel / stem / counter line) and a
// section fullness exponent. Each station is a quarter super-ellipse from the keel line (x = 0) to the sheer (x = hb).
// The catamaran describes ONE hull (centred at x = 0) plus `hullX` (hull centre offset) and a bridge deck.

export const YACHT_CLASSES = ['sloop', 'ketch', 'catamaran', 'schooner'];
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

// ------------------------------------------------------------------------------------------------ hulls
// keel: canoe-body profile [z, y] from the stem head to the transom (y > 0 = above the waterline: overhangs).
// transomRake: + = transom top aft of its bottom (classic), − = reverse transom (top forward of the bottom edge).
const HULLS = {
  sloop: {
    L: 11, B: 3.6, zMax: 0.6, hTransom: 1.35, pBow: 1.8, pAft: 2.0, e: 2.6, sheer: [[-5.5, 1.45], [-3.0, 1.31], [-1.0, 1.245], [1.5, 1.215], [4.0, 1.17], [5.5, 1.15]], camber: 0.06,
    keel: [[-5.5, 1.45], [-5.37, 0], [-4.6, -0.3], [-3.4, -0.47], [-1.0, -0.53], [1.5, -0.46], [3.0, -0.26], [4.33, 0], [5.5, 0.3]],
    transomRake: -0.22, bootTop: 0.14, cove: null, band: null, toeRail: 0.05, bulwark: 0,
  },
  ketch: {
    L: 16, B: 4.6, zMax: 0.5, hTransom: 1.3, pBow: 3.0, pAft: 2.2, e: 2.2, sheer: [[-8.0, 1.75], [-5.0, 1.57], [-2.6, 1.47], [0.5, 1.41], [4.0, 1.32], [6.5, 1.32], [8.0, 1.36]], camber: 0.08,
    keel: [[-8.0, 1.75], [-7.45, 0.95], [-6.4, 0], [-5.2, -0.42], [-3.0, -0.72], [0, -0.8], [3.0, -0.62], [5.5, -0.28], [7.0, 0], [8.0, 0.52]],
    transomRake: 0.35, bootTop: 0.16, cove: 0.2, band: null, toeRail: 0.09, bulwark: 0,
  },
  catamaran: {
    L: 14, B: 1.5, zMax: 0.8, hTransom: 0.6, pBow: 1.6, pAft: 2.0, e: 2.1, camber: 0.02,
    // hull decks 1.35 forward, rising to the bridge-deck level (1.9) where the bridge deck begins: one flush deck aft
    sheer: [[-7.0, 1.42], [-5.0, 1.37], [-3.7, 1.36], [-3.4, 1.45], [-3.15, 1.7], [-2.9, 1.86], [-2.6, 1.9], [7.0, 1.9]],
    keel: [[-7.0, 1.42], [-6.97, 0], [-6.2, -0.36], [-4.8, -0.55], [0, -0.62], [4.0, -0.5], [6.0, -0.2], [6.6, 0], [7.0, 0.14]],
    transomRake: -0.1, bootTop: 0.1, cove: null, band: [0.3, 0.42], toeRail: 0.03, bulwark: 0, hullX: 3.0,
  },
  schooner: {
    L: 35, B: 7.5, zMax: 1.0, hTransom: 1.75, pBow: 3.0, pAft: 2.7, e: 1.9, sheer: [[-17.5, 2.3], [-12.0, 1.95], [-7.7, 1.74], [-2.0, 1.64], [2.8, 1.62], [8.0, 1.66], [13.0, 1.76], [17.5, 1.9]], camber: 0.08,
    keel: [[-17.5, 2.3], [-16.6, 1.75], [-15.4, 0.95], [-14.0, 0], [-12.2, -0.75], [-9.0, -1.35], [-4.0, -1.6], [2.0, -1.6], [7.0, -1.3], [10.5, -0.62], [12.5, 0], [15.0, 0.72], [17.5, 1.32]],
    transomRake: 0.5, bootTop: 0.18, cove: 0.24, band: null, toeRail: 0, bulwark: 0.6, caprail: 0.1,
  },
};
export function hullOf(cls) { return HULLS[cls] || null; }

/** Catmull-Rom through sorted [z, y] points; clamped at the ends. */
function spline(P, z) {
  const n = P.length;
  if (z <= P[0][0]) return P[0][1];
  if (z >= P[n - 1][0]) return P[n - 1][1];
  let i = 0; while (i < n - 2 && z > P[i + 1][0]) i++;
  const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(n - 1, i + 2)];
  const t = (z - p1[0]) / (p2[0] - p1[0]);
  // tangents scaled to the segment (non-uniform spacing)
  const m1 = ((p2[1] - p0[1]) / (p2[0] - p0[0] || 1)) * (p2[0] - p1[0]);
  const m2 = ((p3[1] - p1[1]) / (p3[0] - p1[0] || 1)) * (p2[0] - p1[0]);
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * p1[1] + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * p2[1] + (t3 - t2) * m2;
}

/** Deck-edge (sheer) height at z: quadratic through bow, midships (z = 0) and stern. */
export function sheerY(cls, z) {
  const H = HULLS[cls]; if (!H) return 0;
  if (Array.isArray(H.sheer[0])) return spline(H.sheer, z);          // [z, y] points (masts stand on the deck: §2.4 feet)
  const [b, m, s] = H.sheer, hl = H.L / 2;
  const a = ((b + s) / 2 - m) / (hl * hl), k = (s - b) / H.L;
  return a * z * z + k * z + m;
}
/** Half-breadth of the deck edge at z (one hull for the catamaran); 0 beyond the ends. */
export function deckHalf(cls, z) {
  const H = HULLS[cls]; if (!H) return 0;
  const hl = H.L / 2, hm = H.B / 2;
  if (z < -hl || z > hl) return 0;
  if (z <= H.zMax) { const t = (H.zMax - z) / (H.zMax + hl); return hm * (1 - Math.pow(clamp(t, 0, 1), H.pBow)); }
  const t = (z - H.zMax) / (hl - H.zMax);
  return hm - (hm - H.hTransom) * Math.pow(clamp(t, 0, 1), H.pAft);
}
/** Canoe-body bottom (keel / stem / counter line) at z. */
export function keelY(cls, z) { const H = HULLS[cls]; return H ? spline(H.keel, z) : 0; }
/** z of the stem at height y (the bow profile), from the stem head down to the waterline and the forefoot. */
export function stemZ(cls, y) {
  const H = HULLS[cls]; if (!H) return 0;
  let best = -H.L / 2;
  for (let z = -H.L / 2; z < 0; z += 0.02) { if (keelY(cls, z) <= y) return z; best = z; }
  return best;
}
/** Extents: bow, stern, transom top (with its rake), waterline ends. */
export function hullExtent(cls) {
  const H = HULLS[cls]; if (!H) return null;
  const hl = H.L / 2;
  let wlF = -hl, wlA = hl;
  for (let z = -hl; z < hl; z += 0.01) if (keelY(cls, z) <= 0) { wlF = z; break; }
  for (let z = hl; z > -hl; z -= 0.01) if (keelY(cls, z) <= 0) { wlA = z; break; }
  return { zBow: -hl, zStern: hl, zDeckEnd: hl + Math.min(0, H.transomRake), wlF, wlA, lwl: wlA - wlF };
}

/**
 * Section at z: n+1 points [x, y] from the keel line (x = 0) to the sheer (x = half-breadth) — a quarter super-ellipse
 * (exponent e: 2 = round bilge, higher = firmer). Monotone in y.
 */
export function section(cls, z, n = 16) {
  const H = HULLS[cls]; if (!H) return [];
  const hb = deckHalf(cls, z), ys = sheerY(cls, z), yk = Math.min(keelY(cls, z), ys - 0.02), q = 2 / H.e;
  const out = [];
  for (let i = 0; i <= n; i++) {
    const f = (i / n) * (Math.PI / 2), s = Math.sin(f), c = Math.cos(f);
    out.push([hb * Math.pow(s, q), yk + (ys - yk) * (1 - Math.pow(c, q))]);
  }
  return out;
}
/** Half-breadth of the hull surface at (z, y) (0 below the keel line or ahead of the stem); the sheer half-breadth above. */
export function hullHalfAt(cls, z, y) {
  const H = HULLS[cls]; if (!H) return 0;
  const hb = deckHalf(cls, z), ys = sheerY(cls, z), yk = keelY(cls, z);
  if (y <= yk || hb <= 0) return 0;
  if (y >= ys) return hb;
  const q = 2 / H.e, w = (y - yk) / (ys - yk);          // 1 − c^q = w → c = (1 − w)^(1/q)
  const c = Math.pow(1 - w, 1 / q), s = Math.sqrt(Math.max(0, 1 - c * c));
  return hb * Math.pow(s, q);
}
/**
 * Hull stations for lofting: [{ z, pts: [[x, y, z] …] }] (starboard half; mirror for port). The last station is the
 * transom, whose points lean by the rake (z shifts linearly with height). nPts points per station.
 */
export function hullStations(cls, nStations = 40, nPts = 16) {
  const H = HULLS[cls]; if (!H) return [];
  const hl = H.L / 2, rake = H.transomRake || 0, zEnd = hl;
  const zLast = hl - Math.abs(rake) - 0.08;                // last regular station clears the raked transom
  const out = [];
  for (let i = 0; i <= nStations; i++) {
    // cosine spacing: denser at the bow (shape changes fastest there)
    const t = i / nStations, u = 1 - Math.cos((t * Math.PI) / 2);
    const z = -hl + 0.001 + (zLast + hl - 0.001) * (0.35 * t + 0.65 * u);
    const pts = section(cls, z, nPts).map(([x, y]) => [x, y, z]);
    out.push({ z, pts });
  }
  // transom: section at the stern, z leaning with the rake (reverse: top forward; classic: top aft)
  const sec = section(cls, zEnd, nPts), yk = sec[0][1], ys = sec[sec.length - 1][1];
  const pts = sec.map(([x, y]) => { const f = ys > yk ? (y - yk) / (ys - yk) : 0; return [x, y, rake < 0 ? zEnd + rake * f : zEnd - rake * (1 - f)]; });
  out.push({ z: zEnd, pts, transom: true });
  return out;
}

// ------------------------------------------------------------------------------------------------ looks
// Colours (hex) per class: hull topsides, boot-top, antifouling, cove line, band (cat), deck, house, trim (varnish /
// teak), spars, mastheads, ironwork, sails, sail accent (UV strip / boltrope), canvas (sprayhood, covers, lazy bag).
export const LOOKS = {
  sloop: {
    hull: 0x1e3f73, bootTop: 0xf3f3ef, antifoul: 0x23262d, cove: null, band: null, deck: 0xb3b8bc, deckKind: 'nonslip',
    house: 0xf2f2ee, trim: 0xb08a5a, cockpit: 0xb08a5a, spar: 0xc3c8cd, masthead: 0xc3c8cd, iron: 0xd6dadd, metal: 0xd6dadd,
    sail: 0xf4f2ea, sailAccent: 0x1e3f73, canvas: 0x1e3f73, window: 0x16202a, rope: 0xe8e2d0,
    sailcut: 'radial', sailNo: 'SL 11', battens: true, telltale: true,
  },
  ketch: {
    hull: 0x7a2e2e, bootTop: 0xefe9da, antifoul: 0x5a1f1b, cove: 0xd2ab45, band: null, deck: 0xb08a5a, deckKind: 'teak',
    house: 0xece3cc, trim: 0x8a5a2b, cockpit: 0xb08a5a, spar: 0xe6dcc0, masthead: 0xe6dcc0, iron: 0xcfd3d6, metal: 0xcfd3d6,
    sail: 0xf0e6cf, sailAccent: 0x6e1f2a, canvas: 0x6e1f2a, window: 0x1a2128, rope: 0xe3d8bd,
    sailcut: 'cross', sailNo: 'K 16', battens: true, telltale: true,
  },
  catamaran: {
    hull: 0xf0f0f0, bootTop: 0xf0f0f0, antifoul: 0x2b2f35, cove: null, band: 0x8a9097, deck: 0xe7e7e3, deckKind: 'nonslip',
    house: 0xf5f5f3, trim: 0x2b2e33, cockpit: 0xd9d4c8, spar: 0x2a2d31, masthead: 0x2a2d31, iron: 0xd0d4d7, metal: 0xd0d4d7,
    sail: 0xf6f6f2, sailAccent: 0x2a5ea8, canvas: 0x2a5ea8, window: 0x111418, rope: 0xe0e0dc, tramp: 0x15181b,
    sailcut: 'radial', sailNo: 'CT 14', battens: true, telltale: true,
  },
  schooner: {
    hull: 0x3b2a1a, bootTop: 0xf1efe6, antifoul: 0x7a3b28, cove: 0xd2ab45, band: null, deck: 0xbd9e6f, deckKind: 'teak',
    house: 0x6b3f22, trim: 0x8a5a2b, cockpit: 0xbd9e6f, spar: 0xb07a3c, masthead: 0xf0eee6, iron: 0x1b1b1b, metal: 0x1b1b1b,
    sail: 0xcfae7c, sailAccent: 0x9a7b4c, canvas: 0xd9cfb8, window: 0x1b2026, rope: 0xc9b48a, bulwark: 0xf0eee6,
    sailcut: 'cross', sailNo: null, battens: false, telltale: true,
  },
};
export function looksOf(cls) { return LOOKS[cls] || LOOKS.sloop; }

// ------------------------------------------------------------------------------------------------ deck layout
// Deck structures (§4.2): kind coachroof | doghouse | house | saloon | hardtop | sprayhood | cockpit (a well: `sole`
// is its floor) | helm (raised helm station) | windlass | wheelbox. z0 < z1 (aft), half = half-width (halfFwd at z0
// when tapered), top = roof height (y, ship frame), base = where it stands. `solid`: a walker / boom obstacle.
// `walkIn`: has a door and floor inside (doghouse / saloon). `roofWalk`: people stand on it (not under a boom).
const DECK = {
  sloop: {
    deckY: 1.25, structures: [
      { id: 'coachroof', kind: 'coachroof', z0: -3.0, z1: 1.6, half: 1.0, halfFwd: 0.8, top: 1.80, solid: true, windows: true },
      { id: 'sprayhood', kind: 'sprayhood', z0: 0.75, z1: 1.6, half: 0.92, top: 2.10, solid: true, soft: true },
      { id: 'cockpit', kind: 'cockpit', z0: 1.6, z1: 4.6, half: 1.2, sole: 0.85, coaming: 1.55, top: 0.85 },
    ],
    hatches: [[-2.4, 1.80, 0.5], [-0.4, 1.80, 0.4]], lifelines: true, pulpit: true, pushpit: true, swimLadder: true,
  },
  ketch: {
    deckY: 1.45, structures: [
      { id: 'coachroof', kind: 'coachroof', z0: -2.0, z1: 0.6, half: 1.3, halfFwd: 1.1, top: 2.15, solid: true, windows: true },
      { id: 'doghouse', kind: 'doghouse', z0: 0.6, z1: 1.8, half: 1.3, top: 2.45, solid: true, windows: true },
      { id: 'cockpit', kind: 'cockpit', z0: 1.8, z1: 3.8, half: 1.35, sole: 1.0, coaming: 1.75, top: 1.0 },
      { id: 'helm', kind: 'helm', z0: 4.4, z1: 6.8, half: 1.5, sole: 1.42, top: 1.42 },
    ],
    hatches: [[-4.5, 1.6, 0.55], [-1.2, 2.15, 0.5]], lifelines: true, pulpit: true, pushpit: true,
  },
  catamaran: {
    deckY: 1.9, hullDeckY: 1.35, bridge: { z0: -3.1, z1: 5.6, under: 0.9, top: 1.9 },
    structures: [
      { id: 'saloon', kind: 'saloon', z0: -2.1, z1: 2.66, half: 2.55, top: 3.9, solid: true, walkIn: true, windows: true, rake: 0.7, roofWalk: true },
      { id: 'hardtop', kind: 'hardtop', z0: 2.66, z1: 5.0, half: 2.7, top: 4.0, thick: 0.12, roofWalk: true },
      { id: 'trampoline', kind: 'trampoline', z0: -6.2, z1: -3.1, half: 2.25, top: 1.55 },
    ],
    hatches: [], lifelines: true, pulpit: true, pushpit: false,
  },
  schooner: {
    deckY: 1.7, structures: [
      { id: 'house', kind: 'house', z0: -4.6, z1: -0.8, half: 1.6, top: 2.6, solid: true, skylight: true },
      { id: 'doghouse', kind: 'doghouse', z0: 4.4, z1: 9.6, half: 1.9, top: 3.05, solid: true, walkIn: true, windows: true },
      { id: 'cockpit', kind: 'cockpit', z0: 10.8, z1: 14.4, half: 1.5, sole: 1.15, coaming: 2.15, top: 1.15 },
      { id: 'windlass', kind: 'windlass', z0: -16.0, z1: -15.2, half: 0.9, top: 2.75, solid: true },
    ],
    hatches: [[-12.0, 2.05, 0.8], [-10.0, 1.95, 0.6], [0.6, 1.85, 0.6]], lifelines: false, pulpit: false, pushpit: false,
  },
};
export function deckOf(cls) { return DECK[cls] || null; }
/** Deck structures for clearance checks and plans (copies). */
export function structures(cls) { const d = DECK[cls]; return d ? d.structures.map((s) => ({ ...s })) : []; }
/** Structure half-width at z (tapered coachroofs). */
export function structHalfAt(s, z) { if (s.halfFwd === undefined) return s.half; const t = clamp((z - s.z0) / (s.z1 - s.z0), 0, 1); return lerp(s.halfFwd, s.half, t); }

/**
 * Walkable deck height at (x, z), or null when (x, z) is off the deck (outside the hull, over the trampoline it is the
 * net). Monohulls: sheer + camber; cockpits: their sole. Catamaran: bridge deck (1.9) between the hulls over its z
 * range, hull decks forward of it, the trampoline in between.
 */
export function deckHeightAt(cls, x, z) {
  const H = HULLS[cls], D = DECK[cls]; if (!H || !D) return null;
  if (cls === 'catamaran') {
    const hx = H.hullX, b = D.bridge;
    const hb = deckHalf(cls, z), inHull = Math.abs(Math.abs(x) - hx) <= hb;
    if (z >= b.z0 && z <= b.z1 && Math.abs(x) <= hx + hb) return b.top;
    if (inHull) return sheerY(cls, z) + H.camber;
    const tr = D.structures.find((s) => s.kind === 'trampoline');
    if (tr && z >= tr.z0 && z <= tr.z1 && Math.abs(x) <= hx) return tr.top;
    return null;
  }
  const hb = deckHalf(cls, z);
  if (Math.abs(x) > hb) return null;
  for (const s of D.structures) if (s.kind === 'cockpit' && z >= s.z0 && z <= s.z1 && Math.abs(x) <= s.half) return s.sole;
  return sheerY(cls, z) + H.camber * (1 - (x / Math.max(hb, 0.01)) ** 2);
}
/** Is (x, z) under a deck structure footprint? → the structure or null (cockpits are wells, not obstacles). */
export function structureAt(cls, x, z) {
  for (const s of DECK[cls]?.structures || []) {
    if (s.kind === 'cockpit' || s.kind === 'helm' || s.kind === 'trampoline') continue;
    if (z >= s.z0 && z <= s.z1 && Math.abs(x) <= structHalfAt(s, z)) return s;
  }
  return null;
}

/**
 * Starboard half of the deck outline as [x, z] from the stern to the bow tip (shipplan.js `outlineHalf` replacement for
 * yachts). Catamaran: one hull centred at x = 0 (offset by hullX yourself).
 */
export function deckOutlineHalf(cls, n = 32) {
  const H = HULLS[cls]; if (!H) return [];
  const ext = hullExtent(cls), out = [];
  for (let i = 0; i <= n; i++) { const z = ext.zDeckEnd - ((ext.zDeckEnd + H.L / 2) * i) / n; out.push([Math.round(deckHalf(cls, z) * 1000) / 1000, Math.round(z * 1000) / 1000]); }
  return out;
}

/** The point on the hull side at height y nearest z (for whisker stays / bobstays that end on the hull). */
export function hullSidePoint(cls, z, y) { return [hullHalfAt(cls, z, y), y, z]; }

/** Ship dimensions the rest of the client reads (userData.freeboard etc.). */
export function yachtDims(cls) {
  const H = HULLS[cls], D = DECK[cls]; if (!H) return null;
  const B = cls === 'catamaran' ? 2 * (H.hullX + H.B / 2) : H.B;
  return { L: H.L, B, freeboard: D.deckY, deckY: D.deckY, hullX: H.hullX || 0, hullB: H.B };
}
