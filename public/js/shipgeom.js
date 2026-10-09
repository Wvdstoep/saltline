// Pure hull geometry for the parametric ship generators (docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §6.1–§6.3, §6.6).
// No three.js, no DOM: node tests (test/shipviz-geometry.test.mjs) run it directly; public/js/shipgen.js turns its
// arrays into BufferGeometry.
//
// Frame: x = starboard, y = up (0 = design waterline, keel at −T), z = aft (LOA bow end at −L/2, stern end at +L/2).
// The hull is lofted from the GA's L, B, T, depth, Cb and hull block (bow/stern kind, sheer, flare, midbody):
//   * profile: the stem and stern contours zFwd(y) / zAft(y) per bow and stern kind (rake, bulb foot, cut-up run);
//   * planform: half-breadth along the length — entrance, parallel midbody, run — fuller with Cb (and flare above
//     the waterline), finer towards the keel;
//   * sections: a superellipse below the waterline whose exponent follows Cb (box-like VLCC, round tug, V planing hull);
//   * sheer: the deck edge rises towards the bow (and the stern) by sheerFwd / sheerAft.
// The loft is a closed solid: sides (rows × stations, mirrored), deck, transom; a bulb is a separate ellipsoid.

const clamp = (lo, hi, v) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;

/** stem contour: offset aft of the LOA bow end, as a fraction of L, at heights given as fractions (−1 = keel, 0 = WL, 1 = deck) */
const STEM = {
  bulb: [[-1, 0.045], [-0.35, 0.03], [0, 0.022], [0.5, 0.006], [1, 0]],
  raked: [[-1, 0.075], [-0.6, 0.055], [0, 0.032], [0.5, 0.012], [1, 0]],
  axe: [[-1, 0.04], [-0.5, 0.008], [0, 0.0], [0.6, 0.0], [1, 0.012]],
  ice: [[-1, 0.17], [-0.5, 0.1], [0, 0.06], [0.5, 0.025], [1, 0]],
  tug: [[-1, 0.24], [-0.5, 0.11], [0, 0.05], [0.5, 0.015], [1, 0]],
  planing: [[-1, 0.34], [-0.4, 0.2], [0, 0.11], [0.5, 0.035], [1, 0]],
  yacht: [[-1, 0.2], [-0.5, 0.09], [0, 0.045], [0.5, 0.012], [1, 0]],
  wavepiercer: [[-1, 0.05], [0, 0.0], [0.4, 0.015], [1, 0.07]],
};
/** stern contour: offset forward of the LOA stern end (fraction of L) */
const STERN = {
  transom: [[-1, 0.1], [-0.5, 0.04], [0, 0.006], [1, 0]],
  cruiser: [[-1, 0.095], [-0.4, 0.05], [0, 0.026], [0.4, 0.012], [1, 0]],
  ice: [[-1, 0.1], [-0.4, 0.05], [0, 0.025], [1, 0]],
  tug: [[-1, 0.2], [-0.4, 0.07], [0, 0.03], [1, 0]],
  ramp: [[-1, 0.12], [-0.5, 0.05], [0, 0.01], [1, 0]],
  yacht: [[-1, 0.16], [-0.5, 0.06], [0, 0.02], [1, 0]],
};
/** transom half-width as a fraction of the local maximum, by height fraction (−1 keel … 1 deck) */
const TRANSOM = {
  transom: [[-1, 0], [-0.35, 0], [0, 0.72], [1, 1]],
  cruiser: [[-1, 0], [0, 0.12], [0.5, 0.55], [1, 0.75]],
  ice: [[-1, 0], [0, 0.4], [1, 0.8]],
  tug: [[-1, 0], [-0.3, 0.1], [0, 0.55], [1, 1]],
  ramp: [[-1, 0], [-0.3, 0.1], [0, 0.66], [1, 1]],
  yacht: [[-1, 0], [-0.5, 0.15], [0, 0.65], [1, 1]],
};
function curve(pts, t) {
  if (t <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) if (t <= pts[i][0]) { const [a, va] = pts[i - 1], [b, vb] = pts[i]; return lerp(va, vb, (t - a) / (b - a)); }
  return pts[pts.length - 1][1];
}

/**
 * The hull form of a GA: { L, B, T, F, zFwd(y), zAft(y), deckAt(z), halfBreadth(z, y), demi: [{ cx, B }] }.
 * For twin hulls (GA.hull.twin) each demihull has its own half-breadth around x = ±cx.
 */
export function hullForm(ga) {
  const L = ga.L, T = ga.hull?.draftHull ?? ga.T, F = Math.max(0.3, ga.F ?? ga.deckY), H = ga.hull || {};
  const twin = H.twin && H.twin.hullB > 0 ? H.twin : null;
  const B = twin ? twin.hullB : ga.B;
  const Cb = clamp(0.35, 0.9, twin ? 0.45 : ga.Cb || 0.7);
  const bow = STEM[H.bow] ? H.bow : 'raked';
  const stern = H.doubleEnded ? null : STERN[H.stern] ? H.stern : 'transom';
  const sheerFwd = Math.max(0, H.sheerFwd || 0), sheerAft = Math.max(0, H.sheerAft || 0);
  const flare = clamp(0, 1, H.flare ?? 0.3);
  const planing = bow === 'planing';
  const gaHalf = !twin && typeof H.halfAt === 'function' ? H.halfAt : null;   // ga.js hullHalf (public/js/gaext.js): the walkable plan's deck edge is the plating
  const hf = (y) => (y < 0 ? Math.max(-1, y / T) : Math.min(1, y / F));
  // longitudinal coordinate xi: 0 = stern end, 1 = bow end (deck LOA)
  const xiOf = (z) => (L / 2 - z) / L;
  const mid0 = H.mid ? xiOf(H.mid[1]) : 0.5, mid1 = H.mid ? xiOf(H.mid[0]) : 0.5;
  const xia = clamp(0.08, 0.6, Math.min(mid0, mid1)), xif = clamp(0.4, 0.92, Math.max(mid0, mid1));
  const zFwd = (y) => -L / 2 + L * curve(STEM[bow], hf(y));
  const plat = ga.deck?.swimPlatform ? Math.max(1.2, L * 0.045) : 0;   // yachts: the swim platform is part of the LOA
  const zAft = (y) => (stern ? L / 2 - plat - (L - plat) * curve(STERN[stern], hf(y)) : L / 2 - L * curve(STEM[bow], hf(y)));
  const deckAt = (z) => {
    const xi = xiOf(z);
    let d = F + sheerFwd * Math.pow(Math.max(0, (xi - 0.72) / 0.28), 2);
    if (H.doubleEnded) d += sheerFwd * Math.pow(Math.max(0, (0.28 - xi) / 0.28), 2);
    else d += sheerAft * Math.pow(Math.max(0, (0.22 - xi) / 0.22), 2);
    return d;
  };
  const nMid = planing ? 1.15 : bow === 'tug' ? 2.3 : 2.2 + 35 * Math.pow(Math.max(0, Cb - 0.5), 1.5);
  const pe0 = 1.45 + 2.6 * (Cb - 0.5), pr0 = 1.3 + 2.2 * (Cb - 0.5);
  /** plan fraction 0..1 at (z, y) */
  function plan(z, y) {
    const xi = xiOf(z), h = hf(y);
    const tip = xiOf(zFwd(y)), tail = xiOf(zAft(y));
    if (xi > tip + 1e-9 || xi < tail - 1e-9) return 0;
    const s = h < 0 ? -h : 0, up = h > 0 ? h : 0;
    if (xi >= xif || H.doubleEnded && xi >= 0.5) {
      const xf = H.doubleEnded ? Math.min(xif, 0.5) : xif;
      const t = clamp(0, 1, (xi - xf) / Math.max(1e-6, tip - xf));
      const pe = Math.max(1.05, pe0 + flare * 1.6 * up - 0.75 * s);
      const q = 1.0 + 0.9 * (Cb - 0.5) + flare * 0.5 * up;
      return Math.pow(Math.max(0, 1 - Math.pow(t, pe)), 1 / q);
    }
    if (xi <= xia || H.doubleEnded) {
      if (H.doubleEnded) {
        const xa = Math.max(xia, 0.5);
        if (xi >= xa) return 1;
        const t = clamp(0, 1, (xa - xi) / Math.max(1e-6, xa - tail));
        const pe = Math.max(1.05, pe0 + flare * 1.6 * up - 0.75 * s);
        return Math.pow(Math.max(0, 1 - Math.pow(t, pe)), 1 / (1.0 + 0.9 * (Cb - 0.5)));
      }
      const t = clamp(0, 1, (xia - xi) / Math.max(1e-6, xia - tail));
      const wT = curve(TRANSOM[stern] || TRANSOM.transom, h) * (H.sternW != null ? clamp(0.3, 1.2, H.sternW / 0.8) : 1);
      const pr = Math.max(0.6, pr0 * (1 - 0.45 * s) + 0.6 * up);
      return clamp(0, 1, 1 - (1 - Math.min(1, wT)) * Math.pow(t, pr));
    }
    return 1;
  }
  /** half-breadth (m) at (z, y) of one (demi)hull, ≥ 0 */
  function halfBreadth(z, y) {
    const p = plan(z, y);
    if (p <= 0) return 0;
    if (gaHalf) return clamp(0, B / 2, gaHalf(z, y));   // SHIPYARD H9: the GA's own hull lines inside the stem / stern contour
    let sec = 1;
    if (y < 0) {
      const s = Math.min(1, -y / T);
      const wl = plan(z, 0);
      const n = planing ? nMid : lerp(1.7, nMid, Math.pow(wl, 1.5));
      sec = Math.pow(Math.max(0, 1 - Math.pow(s, n)), 1 / n);
    } else if (planing) {
      sec = 1;
    }
    return clamp(0, B / 2, (B / 2) * p * sec);
  }
  const demi = twin ? [{ cx: -(twin.gap / 2 + twin.hullB / 2), B: twin.hullB }, { cx: twin.gap / 2 + twin.hullB / 2, B: twin.hullB }] : [{ cx: 0, B }];
  return { L, B: ga.B, Bd: B, T, F, Cb, bow, stern, zFwd, zAft, deckAt, halfBreadth, plan, demi, twin, xia, xif };
}

/** heights of the loft rows below the waterline (fractions of T, 1 = keel) per LOD */
const ROWS_BELOW = [[1, 0.995, 0.97, 0.9, 0.78, 0.6, 0.38, 0.18, 0], [1, 0.97, 0.75, 0.35, 0], [1, 0.6, 0]];
/** rows above the waterline: fractions of the local freeboard (deckAt) */
const ROWS_ABOVE = [[0.25, 0.5, 0.75, 0.92, 1], [0.5, 1], [1]];

/**
 * Loft the hull into plain arrays. opts: { lod 0|1|2, stations, bootH (m above WL), band: [y0, y1] | null }.
 * Returns { side: { pos, idx, groups: [{ start, count, mat }] }, deck: { pos, idx }, transom: { pos, idx }, rows, stations }
 * where mat ∈ 'boot' | 'hull' | 'band'. Indices are triangle lists (counter-clockwise seen from outside).
 */
export function loftHull(ga, opts = {}) {
  const hf = hullForm(ga);
  const lod = clamp(0, 2, opts.lod | 0);
  const N = Math.max(6, opts.stations ?? [44, 18, 8][lod]);
  const bootH = clamp(0, hf.F * 0.6, opts.bootH ?? clamp(0.25, 2.5, hf.T * 0.12));
  const band = opts.band && lod < 2 ? opts.band : null;
  // row definitions: { y(z) }
  const rowDefs = [];
  for (const s of ROWS_BELOW[lod]) rowDefs.push({ kind: 'below', s, y: () => -s * hf.T });
  const above = [...ROWS_ABOVE[lod]];
  const extra = [];
  if (lod < 2) extra.push({ boot: true });
  if (band) extra.push({ band: 0 }, { band: 1 });
  for (const f of above) rowDefs.push({ kind: 'above', f, y: (z) => f * hf.deckAt(z) });
  if (lod < 2) rowDefs.push({ kind: 'boot', y: () => bootH });
  if (band) { rowDefs.push({ kind: 'band0', y: () => band[0] }); rowDefs.push({ kind: 'band1', y: () => band[1] }); }
  void extra;
  // sort rows by height at midship; keep only strictly increasing
  rowDefs.sort((a, b) => a.y(0) - b.y(0));
  const rows = [];
  for (const r of rowDefs) if (!rows.length || r.y(0) > rows[rows.length - 1].y(0) + 0.02) rows.push(r);
  const pos = [], idx = [], groups = [];
  const deckPos = [], deckIdx = [], trPos = [], trIdx = [];
  const tris = { boot: [], hull: [], band: [] };
  for (const d of hf.demi) {
    const base = pos.length / 3;
    // grid: for each row i, station j: (x, y, z) starboard side of this demihull
    const grid = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      // ends of this row (use mid-length height to place them; deckAt varies little at the ends)
      const yMid = r.y(0);
      const za = hf.zAft(yMid), zf = hf.zFwd(yMid);
      const line = [];
      for (let j = 0; j <= N; j++) {
        const t = 0.5 - 0.5 * Math.cos(Math.PI * j / N);
        const z = za + (zf - za) * t;           // j = 0 aft end, j = N bow end
        const y = r.y(z);
        const hb = hf.halfBreadth(z, y);
        line.push([hb, y, z]);
      }
      grid.push(line);
    }
    // the deck row follows the sheer exactly; bow tip half-breadth is 0
    const R = rows.length, C = N + 1;
    for (const side of [1, -1]) {
      const off = pos.length / 3;
      for (let i = 0; i < R; i++) for (let j = 0; j < C; j++) { const [hb, y, z] = grid[i][j]; pos.push(d.cx + side * hb, y, z); }
      for (let i = 0; i < R - 1; i++) {
        const yLo = rows[i].y(0), yHi = rows[i + 1].y(0);
        const mid = (yLo + yHi) / 2;
        const mat = mid < bootH - 1e-6 ? 'boot' : band && mid > band[0] && mid < band[1] ? 'band' : 'hull';
        for (let j = 0; j < C - 1; j++) {
          const a = off + i * C + j, b = off + i * C + j + 1, c = off + (i + 1) * C + j + 1, e = off + (i + 1) * C + j;
          // outward winding: starboard (side 1) normal +x
          if (side > 0) tris[mat].push(a, c, e, a, b, c); else tris[mat].push(a, e, c, a, c, b);
        }
      }
    }
    void base;
    // deck: quads across between the two top rows (separate vertices so the deck edge stays sharp)
    const top = grid[R - 1];
    const dOff = deckPos.length / 3;
    for (let j = 0; j < C; j++) { const [hb, y, z] = top[j]; deckPos.push(d.cx - hb, y, z, d.cx + hb, y, z); }
    for (let j = 0; j < C - 1; j++) { const p0 = dOff + j * 2, s0 = p0 + 1, p1 = p0 + 2, s1 = p0 + 3; deckIdx.push(p0, s0, s1, p0, s1, p1); }
    // transom (aft end of every row): quads across
    const tOff = trPos.length / 3;
    for (let i = 0; i < R; i++) { const [hb, y, z] = grid[i][0]; trPos.push(d.cx - hb, y, z, d.cx + hb, y, z); }
    for (let i = 0; i < R - 1; i++) { const p0 = tOff + i * 2, s0 = p0 + 1, p1 = p0 + 2, s1 = p0 + 3; if (grid[i][0][0] + grid[i + 1][0][0] < 0.02) continue; trIdx.push(p0, s0, s1, p0, s1, p1); }
    // double-ended: the 'stern' end is a stem too (half-breadth 0) — nothing to close
  }
  let start = 0;
  for (const mat of ['boot', 'hull', 'band']) { if (!tris[mat].length) continue; idx.push(...tris[mat]); groups.push({ start, count: tris[mat].length, mat }); start += tris[mat].length; }
  return { side: { pos, idx, groups }, deck: { pos: deckPos, idx: deckIdx }, transom: { pos: trPos, idx: trIdx }, rows: rows.length, stations: N + 1, form: hf, bootH };
}

/** Bounding box of a loft (all three parts). */
export function loftBounds(loft) {
  const b = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, z0: Infinity, z1: -Infinity };
  for (const part of [loft.side, loft.deck, loft.transom]) {
    const p = part.pos;
    for (let i = 0; i < p.length; i += 3) {
      b.x0 = Math.min(b.x0, p[i]); b.x1 = Math.max(b.x1, p[i]);
      b.y0 = Math.min(b.y0, p[i + 1]); b.y1 = Math.max(b.y1, p[i + 1]);
      b.z0 = Math.min(b.z0, p[i + 2]); b.z1 = Math.max(b.z1, p[i + 2]);
    }
  }
  return b;
}

/** Waterplane area coefficient of a hull form (numerical, for tests: fuller ships have fuller waterplanes). */
export function waterplaneCoeff(hf, n = 200) {
  let a = 0;
  const z0 = hf.zAft(0), z1 = hf.zFwd(0);
  for (let i = 0; i < n; i++) { const z = z1 + (z0 - z1) * (i + 0.5) / n; a += 2 * hf.halfBreadth(z, 0); }
  return (a * Math.abs(z0 - z1) / n) / (Math.abs(z0 - z1) * hf.Bd);
}
/** Block coefficient of the lofted underwater body (numerical). */
export function blockCoeff(hf, nz = 120, ny = 24) {
  let v = 0;
  const z0 = hf.zAft(0), z1 = hf.zFwd(0), lwl = Math.abs(z0 - z1);
  for (let i = 0; i < nz; i++) {
    const z = z1 + (z0 - z1) * (i + 0.5) / nz;
    for (let k = 0; k < ny; k++) { const y = -hf.T * (k + 0.5) / ny; v += 2 * hf.halfBreadth(z, y) * (hf.T / ny) * (lwl / nz); }
  }
  return v / (lwl * hf.Bd * hf.T);
}

/** Container stack layout on one 40 ft bay: [{ x, tiers }] (outer rows one tier lower on the forward bays). */
export function bayStacks(rows, tiers, { fwd = false, rnd = Math.random } = {}) {
  const out = [];
  for (let r = 0; r < rows; r++) {
    const x = (r - (rows - 1) / 2) * 2.55;
    let t = tiers;
    if (fwd && (r === 0 || r === rows - 1)) t = Math.max(1, t - 1);
    if (rnd() < 0.12) t = Math.max(0, t - 1 - Math.floor(rnd() * 3));   // partly loaded stacks
    out.push({ x: Math.round(x * 1000) / 1000, tiers: t });
  }
  return out;
}

/** Triangle budget of §6.6 for a model's generator (desktop; phone × 0.5). */
export function triBudget(gen, L, phone = false) {
  const b = gen === 'cruise' ? 120000 : ['small_fast', 'motor_yacht'].includes(gen) && L < 30 ? 25000 : ['tug', 'fishing', 'small_fast', 'motor_yacht', 'offshore', 'special'].includes(gen) && L < 100 ? 40000 : 80000;
  return phone ? b / 2 : b;
}
export const DRAW_CALLS = { desktop: 24, phone: 16 };
/** LOD switch distances (§6.6): LOD0 < max(150, 1.5 L), LOD1 < max(2 km, 6 L), LOD2 < 15 km. */
export function lodDistances(L) { return [Math.max(150, 1.5 * L), Math.max(2000, 6 * L), 15000]; }
