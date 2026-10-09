// Bridges & locks — pure geometry builders (docs/BRIDGES-LOCKS-VHF-CONTRACT.md §5, lane C). No three.js, no DOM: the
// Node tests (test/ww3d-*.test.mjs) import this file directly and wwmesh.js wraps the typed arrays into BufferGeometry.
//
// Frame ("object frame"): metres relative to the object's anchor (lat/lon), x east = (lon − lon0)·K_LON·cos(lat),
// z south = −(lat − lat0)·K_LAT, y up = height above model MSL (y = 0, the same datum as the tiles and the water plane).
// Every vertex uses its own latitude like shared/geo.js toLocal, so placing the object group at toLocal(anchor) matches
// the tiles to the centimetre over an object (≤ 2 km).
//
// Output of buildBridge / buildLock:
//   { anchor: {lat, lon}, lod, static: Mesh, moving: [Part], boards: [Board], gauges: [Gauge], signals: [Signal],
//     query: DeckModel | null, cut: [[x, z]…] | null (lock chambers), tris }
//   Mesh  = { pos: Float32Array, nor: Float32Array, col: Float32Array, idx: Uint16Array|Uint32Array, tris }
//   Part  = { key, kind: 'leaf'|'lift'|'swing'|'slide'|'beam'|'stretch'|'gate'|'water', span?, chamber?, head?, pivot: [x,y,z],
//             axis: [x,y,z] | null, rot?: rad (fully open), move?: [dx,dy,dz] (fully open), top?: y (stretch), mesh: Mesh }
//             part geometry is in part-local coordinates (object frame − pivot); partPose(part, frac) gives the transform.
//   Board  = { key, part, pos, nrm, w, h, kind: 'clr'|'width', text, est, span }   (pos / nrm in the part's frame)
//   Gauge  = { key, part: -1, pos (bottom centre), nrm, w, y0, y1, ref (absolute y of the deck underside), span, face }
//   Signal = { key, part: -1, pos, nrm, kind: 'span'|'head', span?, chamber?, head?, face: 0|1|'out'|'in' }
import { boardText, widthText } from './wwfmt.js';

export const K_LAT = 110574, K_LON = 111320;              // = shared/constants.js GEO.M_PER_DEG_LAT / M_PER_DEG_LON_EQ
const D2R = Math.PI / 180;
export const LOD3D = { NONE: 0, MID: 1, FULL: 2 };
/** §5.3 budgets. rFull / rMax in metres from the camera focus; buildMs = main-thread build budget per frame. */
export const BUDGET3D = {
  desktop: { objects: 80, rFull: 2500, rMax: 8000, tris: 200000, textures: 64, buildMs: 4, buildsPerFrame: 4 },
  phone: { objects: 30, rFull: 1200, rMax: 5000, tris: 60000, textures: 24, buildMs: 8, buildsPerFrame: 1 },
};
export const OPEN_ANGLE = { bascule: 82, bascule2: 82, draw: 80, swing: 90 };       // degrees, fully open
export const GATE_TIME = { mitre: 120, sector: 150, lift: 90, rolling: 180, drop: 60 }; // s (§4.8.2)
const MOVABLE = new Set(['bascule', 'bascule2', 'lift', 'swing', 'pontoon', 'draw', 'retract']);
export const isMovable = (mov) => MOVABLE.has(mov);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);

// ------------------------------------------------------------------------------------------------ colours
const hex = (h) => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
export const COL = {
  concrete: hex(0xb3aea4), concreteDk: hex(0x8f8a82), wet: hex(0x4a5249), wetTop: hex(0x5d6457), floor: hex(0x3a3d38),
  asphalt: hex(0x3b3d40), deckSide: hex(0x7f8285), under: hex(0x55575a), mark: hex(0xe8e8e0), markY: hex(0xe8c440),
  steel: hex(0x2f6f8f), steelDk: hex(0x24566e), steelRed: hex(0xa3352b), lattice: hex(0x5f7d8c), rail: hex(0x6f6a62),
  gate: hex(0x3f4a52), gateDk: hex(0x2c343a), wood: hex(0x6a5236), pile: hex(0x4e4234), bollard: hex(0x2a2a2a), bollardY: hex(0xd8b020),
  house: hex(0xd9d4c7), roof: hex(0x8a3a2a), glass: hex(0x2b4250), housing: hex(0x161a1d), white: hex(0xf2f2f2), cable: hex(0x202326),
  water: hex(0x24485a),
};

// ------------------------------------------------------------------------------------------------ frame
/** Object-frame metres of a lat/lon (x east, z south) relative to anchor f. */
export function llToLocal(f, lat, lon) {
  let dl = lon - f.lon; dl = ((dl + 540) % 360) - 180;
  return [dl * K_LON * Math.cos(lat * D2R), -(lat - f.lat) * K_LAT];
}
export function localToLl(f, x, z) {
  const lat = f.lat - z / K_LAT;
  return { lat, lon: f.lon + x / (K_LON * Math.cos(lat * D2R)) };
}
/** Anchor of an object: the middle of the deck line (bridges), the middle of the first chamber axis (locks), else p. */
export function anchorOf(o) {
  const L = o.line && o.line.length >= 2 ? o.line : o.chambers?.[0]?.axis;
  if (L && L.length >= 2) { const a = L[0], b = L[L.length - 1]; return { lat: (a[0] + b[0]) / 2, lon: (a[1] + b[1]) / 2 }; }
  if (Array.isArray(o.p)) return { lat: o.p[0], lon: o.p[1] };
  return { lat: o.lat, lon: o.lon };
}
/** Datum offset (m, model MSL frame) of an object's clearances. Lane A's shared/waterlevel.js may be injected as ctx.datumOffset. */
export function datumOffset(o, ctx = {}) {
  if (typeof ctx.datumOffset === 'function') { const v = ctx.datumOffset(o); if (Number.isFinite(v)) return v; }
  switch (o.datum) {
    case 'KP': return num(o.kp, num(ctx.kp, 0));
    case 'MHWS': return num(o.mhws, num(ctx.mhws, 0));
    case 'LAT': return num(o.lat0, num(ctx.lat0, 0));
    default: return 0;                                        // NAP, MSL
  }
}

// ------------------------------------------------------------------------------------------------ mesh buffer
class Geo {
  constructor(off = [0, 0, 0]) { this.p = []; this.n = []; this.c = []; this.i = []; this.o = off; }
  get tris() { return this.i.length / 3; }
  vtx(a, nr, col) { this.p.push(a[0] - this.o[0], a[1] - this.o[1], a[2] - this.o[2]); this.n.push(nr[0], nr[1], nr[2]); this.c.push(col[0], col[1], col[2]); return this.p.length / 3 - 1; }
  tri(a, b, c, col) { const nr = faceN(a, b, c); const i = this.vtx(a, nr, col); this.vtx(b, nr, col); this.vtx(c, nr, col); this.i.push(i, i + 1, i + 2); }
  quad(a, b, c, d, col) {
    let nr = faceN(a, b, c); if (!nr[0] && !nr[1] && !nr[2]) nr = faceN(a, c, d);
    const i = this.vtx(a, nr, col); this.vtx(b, nr, col); this.vtx(c, nr, col); this.vtx(d, nr, col);
    this.i.push(i, i + 1, i + 2, i, i + 2, i + 3);
  }
  out() {
    const nv = this.p.length / 3;
    return { pos: Float32Array.from(this.p), nor: Float32Array.from(this.n), col: Float32Array.from(this.c), idx: nv > 65535 ? Uint32Array.from(this.i) : Uint16Array.from(this.i), tris: this.i.length / 3, verts: nv };
  }
}
function faceN(a, b, c) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx, l = Math.hypot(x, y, z);
  return l > 1e-12 ? [x / l, y / l, z / l] : [0, 0, 0];
}
const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const shade = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
/** Oriented box: centre c, unit axes U, V, W with half extents. skip: set of face names to omit ('-v' bottom …). */
function obox(g, c, U, V, W, hu, hv, hw, col, skip) {
  const P = (su, sv, sw) => [c[0] + U[0] * hu * su + V[0] * hv * sv + W[0] * hw * sw, c[1] + U[1] * hu * su + V[1] * hv * sv + W[1] * hw * sw, c[2] + U[2] * hu * su + V[2] * hv * sv + W[2] * hw * sw];
  const f = (name, a, b, cc, d, k) => { if (!skip || !skip.includes(name)) g.quad(P(...a), P(...b), P(...cc), P(...d), shade(col, k)); };
  f('+v', [-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1], 1);
  f('-v', [-1, -1, -1], [-1, -1, 1], [1, -1, 1], [1, -1, -1], 0.62);
  f('+u', [1, -1, -1], [1, -1, 1], [1, 1, 1], [1, 1, -1], 0.86);
  f('-u', [-1, -1, -1], [-1, 1, -1], [-1, 1, 1], [-1, -1, 1], 0.86);
  f('+w', [-1, -1, 1], [-1, 1, 1], [1, 1, 1], [1, -1, 1], 0.78);
  f('-w', [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], 0.78);
}
const UP = [0, 1, 0];
/** Axis-aligned-in-plan box: footprint centre (x, z), plan axis t (unit [tx, tz]), half sizes along t / across, y from y0 to y1. */
function pbox(g, x, z, t, ht, hn, y0, y1, col, skip) {
  if (y1 - y0 < 1e-3) return;
  obox(g, [x, (y0 + y1) / 2, z], [t[0], 0, t[1]], UP, [-t[1], 0, t[0]], ht, (y1 - y0) / 2, hn, col, skip);
}
/** Beam between two points with cross-section w × h (h along `up`). */
function beam(g, p0, p1, w, h, col, up = UP) {
  const d = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], L = Math.hypot(d[0], d[1], d[2]); if (L < 1e-3) return;
  const W = [d[0] / L, d[1] / L, d[2] / L];
  let S = cross(up, W); if (Math.hypot(...S) < 1e-3) S = cross([1, 0, 0], W);
  S = norm(S); const V = norm(cross(W, S));
  obox(g, [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2], S, V, W, w / 2, h / 2, L / 2, col);
}
/** Vertical prism with n sides (round piers, bollards). */
function cyl(g, x, z, r, y0, y1, n, col, top = true) {
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
    const p0 = [x + Math.cos(a0) * r, y0, z + Math.sin(a0) * r], p1 = [x + Math.cos(a1) * r, y0, z + Math.sin(a1) * r];
    g.quad(p0, [p0[0], y1, p0[2]], [p1[0], y1, p1[2]], p1, shade(col, 0.75 + 0.25 * Math.cos(a0 - 0.8)));
    if (top) g.tri([x, y1, z], [p1[0], y1, p1[2]], [p0[0], y1, p0[2]], col);
  }
}

// ------------------------------------------------------------------------------------------------ polylines
/** Polyline in object metres → sampler: P(s) [x, z], T(s) unit tangent, length L. Extrapolates straight beyond the ends. */
export function polySampler(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const L = cum[cum.length - 1];
  const seg = (s) => { let i = 0; while (i < pts.length - 2 && cum[i + 1] < s) i++; return i; };
  const T = (s) => { const i = seg(clamp(s, 0, L)); const dx = pts[i + 1][0] - pts[i][0], dz = pts[i + 1][1] - pts[i][1], l = Math.hypot(dx, dz) || 1; return [dx / l, dz / l]; };
  const P = (s) => {
    if (s <= 0) { const t = T(0); return [pts[0][0] + t[0] * s, pts[0][1] + t[1] * s]; }
    if (s >= L) { const t = T(L); const e = pts[pts.length - 1]; return [e[0] + t[0] * (s - L), e[1] + t[1] * (s - L)]; }
    const i = seg(s), f = (s - cum[i]) / Math.max(1e-9, cum[i + 1] - cum[i]);
    return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f];
  };
  return { P, T, L, cum };
}

// ------------------------------------------------------------------------------------------------ spans
/**
 * Spans that get their own geometry. Overlapping spans (FIS lists e.g. the Calandbrug lift opening inside an 80 m fixed
 * passage, or the Botlekbrug's two lift openings at the same place along the line) are merged: movable spans first
 * (recommended, then widest), a span overlapping a kept one by > 20 % of the smaller is absorbed into it.
 */
export function drawnSpans(o) {
  const all = (o.spans || []).map((s, i) => ({ ...s, i, a: num(s.a, NaN), b: num(s.b, NaN) })).filter((s) => Number.isFinite(s.a) && Number.isFinite(s.b) && s.b - s.a > 0.5);
  const order = all.slice().sort((p, q) => (isMovable(q.mov) - isMovable(p.mov)) || ((q.rec || 0) - (p.rec || 0)) || (q.b - q.a) - (p.b - p.a) || p.i - q.i);
  const kept = [];
  for (const s of order) {
    const hit = kept.find((k) => Math.min(k.b, s.b) - Math.max(k.a, s.a) > 0.2 * Math.min(k.b - k.a, s.b - s.a));
    if (hit) { (hit.absorbed ||= []).push(s.i); if (s.mov === hit.mov && isMovable(s.mov)) hit.twin = true; continue; }
    kept.push({ ...s });
  }
  return kept.sort((p, q) => p.a - q.a);
}
/** Deck thickness (m) for a span width and bridge kind (§5.2). */
export function deckThickness(kind, w, truss = false) {
  if (truss) return 1.6;
  if (kind === 'foot') return 0.6;
  if (kind === 'rail') return clamp(w / 18, 1.5, 6);
  return clamp(w / 25, 1.2, 6);
}
const trussOf = (o, s) => o.structure === 'truss' || s.structure === 'truss' || (o.kind === 'rail' && (s.b - s.a) > 60);

// ------------------------------------------------------------------------------------------------ bridge
/**
 * Build a bridge. opts: { lod (2 full, 1 mid), anchor, heightAt(x, z) → terrain y | null (object frame), defaultGround (3),
 * bed (−8), water (mean water y for piles / signals, 0), datumOffset(obj) }.
 */
export function buildBridge(o, opts = {}) {
  const lod = opts.lod ?? LOD3D.FULL, full = lod >= LOD3D.FULL;
  const anchor = opts.anchor || anchorOf(o);
  const off = datumOffset(o, opts), water = num(opts.water, 0), bedY = num(opts.bed, -8), gDef = num(opts.defaultGround, 3);
  const kind = o.kind || 'road';
  const line = (o.line && o.line.length >= 2 ? o.line : null);
  if (!line) return null;
  const pts = line.map(([la, lo]) => llToLocal(anchor, la, lo));
  const S = polySampler(pts);
  const spans = drawnSpans(o);
  const twin = spans.some((s) => s.twin);
  const deckW = clamp(num(o.deckW, 12) * (twin ? 2 : 1) + (twin ? 2 : 0), 2.5, 60), hw = deckW / 2;
  const grade = kind === 'rail' ? 0.015 : 0.04;
  for (const s of spans) {
    s.truss = trussOf(o, s);
    s.th = deckThickness(kind, s.b - s.a, s.truss);
    s.u = num(s.clr, 2.5) + off;                                        // deck underside (closed) = clearance above datum
    s.uo = s.clrO != null && Number.isFinite(Number(s.clrO)) ? Number(s.clrO) + off : null;
    s.travel = s.mov === 'lift' && s.uo != null ? Math.max(0, s.uo - s.u) : 0;
  }
  const thMain = spans.length ? Math.max(...spans.map((s) => s.th)) : deckThickness(kind, 20);
  const groundAt = (s) => {
    const [x, z] = S.P(s), h = opts.heightAt ? opts.heightAt(x, z) : null;
    if (h == null || !Number.isFinite(h)) return s < 0 || s > S.L ? { land: true, g: gDef } : { land: false, g: bedY };
    return { land: h > water + 0.3, g: h };
  };
  // --- the underside profile: spans flat, linear between spans, approaches descend at `grade` once over land
  const prof = [];   // [s, u]
  if (!spans.length) { const u = num(o.clr, 2.5) + off; prof.push([0, u], [S.L, u]); }
  else {
    spans.forEach((s) => { prof.push([s.a - 1.25, s.u], [s.b + 1.25, s.u]); });
  }
  const walk = (s0, u0, dir) => {
    const out = []; let s = s0, u = u0;
    for (let k = 0; k < 160; k++) {
      s += dir * 5;
      const { land, g } = groundAt(s);
      const top = g + 0.25 - thMain;
      if (land) u -= grade * 5;
      if (land && u <= top) { out.push([s, Math.max(top, u)]); break; }
      if (k % 2 === 1) out.push([s, u]);
    }
    if (!out.length || out[out.length - 1][0] !== s) out.push([s, u]);
    return out;
  };
  prof.sort((p, q) => p[0] - q[0]);
  const left = walk(prof[0][0], prof[0][1], -1).reverse(), right = walk(prof[prof.length - 1][0], prof[prof.length - 1][1], 1);
  const profile = [...left, ...prof, ...right];
  const uAt = (s) => {
    if (s <= profile[0][0]) return profile[0][1];
    for (let i = 1; i < profile.length; i++) if (s <= profile[i][0]) { const [s0, u0] = profile[i - 1], [s1, u1] = profile[i]; return s1 - s0 < 1e-6 ? u1 : u0 + (u1 - u0) * (s - s0) / (s1 - s0); }
    return profile[profile.length - 1][1];
  };
  const sMin = profile[0][0], sMax = profile[profile.length - 1][0];
  const g = new Geo();
  const parts = [], boards = [], gauges = [], signals = [];
  const partOf = new Map();   // span index → [part indices]
  const nrmAt = (s) => { const t = S.T(s); return [-t[1], t[0]]; };
  const X = (s, lat, y) => { const p = S.P(s), n = nrmAt(s); return [p[0] + n[0] * lat, y, p[1] + n[1] * lat]; };

  // --- movable span parts (created first so the deck can be routed into them)
  for (const sp of spans) {
    if (!isMovable(sp.mov)) continue;
    const { a, b } = sp, u = sp.u, th = sp.th;
    const mk = (kindP, pivot, extra) => { const p = { key: `span${sp.i}:${kindP}:${parts.length}`, kind: kindP, span: sp.i, pivot, axis: null, g: new Geo(pivot), ...extra }; parts.push(p); (partOf.get(sp.i) || partOf.set(sp.i, []).get(sp.i)).push(parts.length - 1); return p; };
    const hingeA = sp.hinge !== 'b';
    if (sp.mov === 'bascule' || sp.mov === 'draw') {
      const hs = hingeA ? a : b, dir = hingeA ? 1 : -1, n = nrmAt(hs);
      const pv = X(hs, 0, u + th / 2);
      const axis = hingeA ? [n[0], 0, n[1]] : [-n[0], 0, -n[1]];
      const p = mk('leaf', pv, { axis, rot: (OPEN_ANGLE[sp.mov] || 82) * D2R, range: hingeA ? [a, b] : [a, b] });
      // counterweight behind the hinge (drops into the basement as the leaf rises)
      if (sp.mov === 'bascule') { const c0 = hs - dir * 6, c1 = hs - dir * 1.5; segBox(p.g, S, Math.min(c0, c1), Math.max(c0, c1), -hw + 0.6, hw - 0.6, () => u - 1.5, () => u - 0.1, COL.concreteDk); }
      if (sp.mov === 'draw') {      // balance beam on a portal ("galg"): rotates with the leaf (parallelogram)
        const H = 8, ptop = X(hs, 0, u + th + H);
        const bm = mk('beam', ptop, { axis, rot: (OPEN_ANGLE.draw) * D2R });
        for (const sd of [-1, 1]) {
          beam(bm.g, X(hs - dir * 5, sd * (hw + 0.4), u + th + H), X(hs + dir * (b - a) * 0.9, sd * (hw + 0.4), u + th + H), 0.45, 0.6, COL.white);
          if (full) beam(bm.g, X(hs - dir * 5, sd * (hw + 0.4), u + th + H - 0.3), X(hs - dir * 5, sd * (hw + 0.4), u + th + H - 2.4), 0.9, 0.9, COL.bollard);
          beam(g, X(hs, sd * (hw + 0.4), u + th), X(hs, sd * (hw + 0.4), u + th + H + 0.3), 0.5, 0.5, COL.white);    // portal posts
        }
        beam(bm.g, X(hs - dir * 5, -(hw + 0.4), u + th + H), X(hs - dir * 5, hw + 0.4, u + th + H), 0.4, 0.4, COL.white);
        beam(g, X(hs, -(hw + 0.6), u + th + H + 0.4), X(hs, hw + 0.6, u + th + H + 0.4), 0.5, 0.5, COL.white);     // portal top
      }
    } else if (sp.mov === 'bascule2') {
      const m = (a + b) / 2;
      for (const [hs, axSign, r] of [[a, 1, [a, m]], [b, -1, [m, b]]]) {
        const n = nrmAt(hs);
        mk('leaf', X(hs, 0, u + th / 2), { axis: [n[0] * axSign, 0, n[1] * axSign], rot: OPEN_ANGLE.bascule2 * D2R, range: r });
      }
    } else if (sp.mov === 'lift') {
      const pl = mk('lift', X((a + b) / 2, 0, u), { move: [0, sp.travel, 0], range: [a, b] });
      void pl;
      const topY = (sp.uo ?? sp.u + 25) + th + 6;
      if (full && !sp.twin) {
        const cb = mk('stretch', X((a + b) / 2, 0, u + th), { top: topY - 2, move: [0, sp.travel, 0] });
        const c0 = X((a + b) / 2, 0, u + th);
        for (const s of [a + 1.2, b - 1.2]) for (const sd of [-1, 1]) {
          const q = X(s, sd * (hw + 0.3), 0);
          obox(cb.g, [q[0], c0[1] + 0.5, q[2]], [1, 0, 0], UP, [0, 0, 1], 0.09, 0.5, 0.09, COL.cable);
        }
      }
    } else if (sp.mov === 'swing') {
      const hs = hingeA ? a : b, dir = hingeA ? 1 : -1;
      const sp0 = hs - dir * (hw + 1.5);                 // pivot pier just outside the opening: the opened deck lies along the bank
      const tail = (b - a) * 0.35;
      sp.pivotS = sp0; sp.range = hingeA ? [sp0 - tail, b] : [a, sp0 + tail];
      mk('swing', X(sp0, 0, u), { axis: [0, 1, 0], rot: (hingeA ? 1 : -1) * OPEN_ANGLE.swing * D2R, range: sp.range });
    } else if (sp.mov === 'pontoon' || sp.mov === 'retract') {
      const t = S.T((a + b) / 2), n = nrmAt((a + b) / 2), L = b - a + 2;
      const mv = sp.mov === 'retract' ? [-t[0] * L, th + 0.3, -t[1] * L] : [-t[0] * L + n[0] * (deckW + 2), 0, -t[1] * L + n[1] * (deckW + 2)];
      mk('slide', X((a + b) / 2, 0, u), { move: mv, range: [a, b] });
    }
  }
  // stations: profile points + span edges + every ≤ 12 m (so long ramps stay smooth on curved lines)
  const st = new Set(profile.map((p) => +p[0].toFixed(3)));
  for (const s of spans) { st.add(+s.a.toFixed(3)); st.add(+s.b.toFixed(3)); }
  for (const c of S.cum) if (c > sMin && c < sMax) st.add(+c.toFixed(3));
  for (const p of parts) if (p.range) for (const r of p.range) if (r > sMin && r < sMax) st.add(+r.toFixed(3));
  let stations = [...st].sort((a, b) => a - b);
  const dense = [];
  for (let i = 0; i < stations.length; i++) { if (i) { const g = stations[i] - stations[i - 1], n = Math.ceil(g / 12); for (let k = 1; k < n; k++) dense.push(stations[i - 1] + (g * k) / n); } dense.push(stations[i]); }
  stations = dense;

  const ownerAt = (sm) => {   // the part that owns the deck at station sm (null = static)
    for (const p of parts) if ((p.kind === 'leaf' || p.kind === 'lift' || p.kind === 'swing' || p.kind === 'slide') && sm > p.range[0] + 1e-6 && sm < p.range[1] - 1e-6) return p;
    return null;
  };
  const spanAt = (sm) => spans.find((s) => sm >= s.a - 1e-6 && sm <= s.b + 1e-6) || null;

  // --- deck (top asphalt, sides, underside), parapets, markings — routed to the owning part
  for (let i = 0; i + 1 < stations.length; i++) {
    const s0 = stations[i], s1 = stations[i + 1]; if (s1 - s0 < 0.05) continue;
    const sm = (s0 + s1) / 2, owner = ownerAt(sm), G = owner ? owner.g : g;
    const sp = spanAt(sm), th = sp ? sp.th : thMain;
    const u0 = owner && owner.kind !== 'swing' ? (spanAt(sm)?.u ?? uAt(s0)) : uAt(s0), u1 = owner && owner.kind !== 'swing' ? (spanAt(sm)?.u ?? uAt(s1)) : uAt(s1);
    deckSeg(G, S, s0, s1, hw, u0, u1, th, kind, full);
  }
  // swing span: the moving deck over the pivot pier and the tail is routed into the swing part by ownerAt(); add the
  // counterweight under the tail
  for (const p of parts) if (p.kind === 'swing') {
    const sp = spans.find((s) => s.i === p.span), [r0, r1] = p.range, hingeA = sp.hinge !== 'b';
    const t0 = hingeA ? r0 : r1 - (r1 - r0) * 0.18, t1 = hingeA ? r0 + (r1 - r0) * 0.18 : r1;
    segBox(p.g, S, t0, t1, -hw + 0.8, hw - 0.8, () => sp.u - 2.2, () => sp.u, COL.concreteDk);
  }
  // --- structure over spans: truss / arch / cable
  for (const sp of spans) {
    const own = partOf.get(sp.i)?.map((k) => parts[k]).find((p) => p.kind !== 'stretch' && p.kind !== 'beam');
    const G = own && own.kind !== 'leaf' ? own.g : own ? own.g : g;
    if (sp.truss && sp.mov !== 'bascule' && sp.mov !== 'bascule2' && sp.mov !== 'draw') truss(G, S, sp.a, sp.b, hw, sp.u + sp.th, clamp((sp.b - sp.a) / 8, 6, 14), full);
    else if (!isMovable(sp.mov) && o.structure === 'arch' && sp.b - sp.a > 40) arch(G, S, sp.a, sp.b, hw, sp.u + sp.th, full);
    else if (!isMovable(sp.mov) && o.structure === 'cable' && sp.b - sp.a > 60) cable(G, S, sp.a, sp.b, hw, sp.u + sp.th, full);
  }
  // --- piers: span edges, swing pivot, and every 40 m under the approaches while the deck is clear of the ground
  const pierAt = (s, wide = 1, round = false) => {
    const [x, z] = S.P(s), t = S.T(s), { land, g: gr } = groundAt(s), u = uAt(s);
    const bot = land ? gr - 0.5 : Math.min(gr, water - 4);
    if (u - bot < 0.8) return;
    if (round) { cyl(g, x, z, hw + 1, bot, u, full ? 16 : 8, COL.concrete); return; }
    pbox(g, x, z, t, 1.25 * wide, hw + 0.5, bot, u, COL.concrete);
    if (full && !land) for (const sd of [-1, 1]) {   // cutwaters (pointed noses up- and downstream)
      const n = nrmAt(s), e = hw + 0.5, tip = hw + 2.2;
      const A = [x + n[0] * e * sd - t[0] * 1.25 * wide, 0, z + n[1] * e * sd - t[1] * 1.25 * wide], B = [x + n[0] * e * sd + t[0] * 1.25 * wide, 0, z + n[1] * e * sd + t[1] * 1.25 * wide], C = [x + n[0] * tip * sd, 0, z + n[1] * tip * sd];
      const top = Math.min(u - 0.3, water + 3);
      for (const [p, q] of [[A, C], [C, B]]) g.quad([p[0], bot, p[2]], [q[0], bot, q[2]], [q[0], top, q[2]], [p[0], top, p[2]], COL.concreteDk);
      g.tri([A[0], top, A[2]], [C[0], top, C[2]], [B[0], top, B[2]], COL.concrete);
    }
  };
  const pierS = [];
  for (const sp of spans) {
    if (sp.mov === 'swing') { pierAt(sp.pivotS, 1, true); pierS.push(sp.pivotS); }
    const hingeA = sp.hinge !== 'b';
    for (const [s, e] of [[sp.a - 1.25, 'a'], [sp.b + 1.25, 'b']]) {
      if (sp.mov === 'lift') { pierS.push(s); continue; }     // tower bases
      const basement = (sp.mov === 'bascule') && ((e === 'a') === hingeA);
      if (basement) { const c = e === 'a' ? s - 3.5 : s + 3.5; pierAt(c, 3.8); pierS.push(c); }
      else { pierAt(s); pierS.push(s); }
    }
  }
  const minGap = 12;
  for (const dir of [-1, 1]) {
    const edge = spans.length ? (dir < 0 ? spans[0].a - 1.25 : spans[spans.length - 1].b + 1.25) : (dir < 0 ? 0 : S.L);
    for (let s = edge + dir * 40; dir < 0 ? s > sMin + 8 : s < sMax - 8; s += dir * 40) {
      if (pierS.some((q) => Math.abs(q - s) < minGap)) continue;
      const { land, g: gr } = groundAt(s); if (uAt(s) - (land ? gr : water) < 1.2) continue;
      pierAt(s); pierS.push(s);
    }
  }
  if (!spans.length) pierAt(S.L / 2);
  // abutments at the deck ends
  for (const s of [sMin, sMax]) { const [x, z] = S.P(s), t = S.T(s), { g: gr } = groundAt(s); pbox(g, x, z, t, 2, hw + 1, Math.min(gr, uAt(s)) - 1.5, uAt(s), COL.concreteDk); }

  // --- lift towers, machinery houses
  for (const sp of spans) {
    if (sp.mov !== 'lift') continue;
    const topY = (sp.uo ?? sp.u + 25) + sp.th + 6, concrete = o.structure === 'concrete' || (kind !== 'rail' && !sp.truss && (sp.b - sp.a) > 70);
    for (const s of [sp.a - 2.2, sp.b + 2.2]) {
      const t = S.T(s), { land, g: gr } = groundAt(s), bot = land ? gr - 0.5 : water - 5;
      for (const sd of [-1, 1]) {
        const [x, , z] = X(s, sd * (hw + 2.4), 0);
        if (concrete || !full) pbox(g, x, z, t, 2, 2, bot, topY, concrete ? COL.concrete : COL.lattice);
        else lattice(g, x, z, t, 2, 2, bot, topY, COL.lattice);
      }
      // machinery bridge across the tower tops + house
      const c = X(s, 0, topY + 1.6), tt = [t[0], 0, t[1]], nn = [-t[1], 0, t[0]];
      obox(g, c, tt, UP, nn, 2.4, 1.6, hw + 4.4, concrete ? COL.concreteDk : COL.steelDk);
      if (full) obox(g, add(c, UP, 3.0), tt, UP, nn, 2.0, 1.4, hw + 1.5, COL.house);
      // pier under the tower pair (water side)
      const [px, pz] = S.P(s); pbox(g, px, pz, t, 2.6, hw + 5, bot, Math.min(sp.u, water + 3), COL.concreteDk);
    }
  }
  // --- fender piles (remmingwerk) along movable openings, and an operator house on the hinge side
  if (full) for (const sp of spans) {
    if (!isMovable(sp.mov)) continue;
    if (!o.lockId) for (const s of [sp.a + 0.5, sp.b - 0.5]) for (const sd of [-1, 1]) {
      const top = water + 2.4, n0 = hw + 2.5;
      for (let d = 0; d <= 30; d += 3) { const [x, , z] = X(s, sd * (n0 + d), 0); pbox(g, x, z, S.T(s), 0.28, 0.28, bedY, top, COL.pile, ['-v']); }
      beam(g, X(s, sd * n0, top - 0.4), X(s, sd * (n0 + 30), top - 0.4), 0.35, 0.5, COL.wood);
      beam(g, X(s, sd * n0, water + 0.4), X(s, sd * (n0 + 30), water + 0.4), 0.35, 0.5, COL.wood);
    }
    const hs = sp.hinge === 'b' ? sp.b + 8 : sp.a - 8, sd = 1, base = uAt(hs) + (spanAt(hs)?.th ?? thMain);
    const [x, , z] = X(hs, sd * (hw + 4.5), 0), t = S.T(hs);
    if (sp.mov !== 'lift') {
      pbox(g, x, z, t, 2.6, 2.2, Math.min(base, groundAt(hs).g), base + 3.2, COL.house);
      pbox(g, x, z, t, 2.9, 2.5, base + 3.2, base + 3.5, COL.roof);
      obox(g, [x + (-t[1]) * -2.21, base + 2.2, z + t[0] * -2.21], [t[0], 0, t[1]], UP, [-t[1], 0, t[0]], 2.0, 0.55, 0.02, COL.glass);
    }
  }

  // --- signals, boards, gauges
  for (const sp of spans) {
    const mov = isMovable(sp.mov);
    if (!mov && !sp.rec) continue;
    for (const face of [0, 1]) {
      const sd = face === 0 ? 1 : -1, n = nrmAt(mov ? sp.a : (sp.a + sp.b) / 2);
      if (mov) {
        const y = clamp(water + 4, water + 1.2, sp.u - 0.9), s = sp.a - 0.2;
        const pos = X(s, sd * (hw + 0.75), y);
        signals.push({ key: `sig${sp.i}:${face}`, part: -1, pos, nrm: [n[0] * sd, 0, n[1] * sd], kind: 'span', span: sp.i, face });
        if (full) pbox(g, pos[0] - n[0] * sd * 0.12, pos[2] - n[1] * sd * 0.12, S.T(s), 0.75, 0.1, y - 0.95, y + 1.25, COL.housing);
      } else {
        const s = (sp.a + sp.b) / 2, y = sp.u + sp.th * 0.5 + 0.9;
        signals.push({ key: `sig${sp.i}:${face}`, part: -1, pos: X(s, sd * (hw + 0.12), y), nrm: [n[0] * sd, 0, n[1] * sd], kind: 'span', span: sp.i, face, fixed: true, narrow: (sp.b - sp.a) < 2 * (11.4 + 3) });
      }
    }
  }
  if (full) for (const sp of spans) {
    if ((sp.b - sp.a) < 3) continue;
    const own = partOf.get(sp.i)?.map((k) => parts[k]).find((p) => p.kind === 'lift' || p.kind === 'slide' || p.kind === 'swing' || p.kind === 'leaf');
    const s = (sp.a + sp.b) / 2;
    const n = nrmAt(s);
    for (const face of [0, 1]) {
      const sd = face === 0 ? 1 : -1, y = sp.u + sp.th / 2, lat = sd * (hw + 0.09);
      const toPart = (p) => (own ? [p[0] - own.pivot[0], p[1] - own.pivot[1], p[2] - own.pivot[2]] : p);
      // bascule2: the board hangs on the leaf that owns the middle (the "a" leaf), fine at closed; it tips with it
      const bscale = clamp(sp.th / 1.0, 0.7, 1.4);
      boards.push({ key: `bd${sp.i}:${face}`, part: own ? parts.indexOf(own) : -1, pos: toPart(X(s, lat, y)), nrm: [n[0] * sd, 0, n[1] * sd], w: 3.0 * bscale, h: 1.0 * bscale, kind: 'clr', text: boardText(sp, o.e), est: o.e === 2, span: sp.i });
      if (Number.isFinite(Number(sp.w)) && sp.w > 0) {
        const off2 = (3.0 * bscale) / 2 + 1.6 * bscale;
        boards.push({ key: `bw${sp.i}:${face}`, part: own ? parts.indexOf(own) : -1, pos: toPart(X(s + off2, lat, y)), nrm: [n[0] * sd, 0, n[1] * sd], w: 2.4 * bscale, h: 0.85 * bscale, kind: 'width', text: widthText(sp.w), est: o.e === 2, span: sp.i });
      }
    }
    // clearance gauge (peilschaal) on the a-edge pier, on the face looking into the opening, near both pier ends
    const faceS = sp.mov === 'lift' ? sp.a + 0.4 : (sp.mov === 'bascule' && sp.hinge !== 'b') ? sp.a + 1.25 : sp.mov === 'swing' && sp.hinge !== 'b' ? sp.a : sp.a;
    const ps = faceS + 0.04, tt = S.T(ps);
    for (const face of [0, 1]) {
      const sd = face === 0 ? 1 : -1;
      const p = X(ps, sd * (hw - 0.6), 0);
      gauges.push({ key: `ga${sp.i}:${face}`, part: -1, pos: [p[0], water - 3, p[2]], nrm: [tt[0], 0, tt[1]], w: 0.5, y0: water - 3, y1: sp.u - 0.25, ref: sp.u, span: sp.i, face });
    }
  }

  // --- deck model for clearance queries (overlay, verdict strip)
  const query = { stations: stations.map((s) => { const [x, z] = S.P(s), n = nrmAt(s); return { s, x, z, nx: n[0], nz: n[1], u: uAt(s) }; }), hw,
    spans: spans.map((s) => ({ i: s.i, a: s.a, b: s.b, mov: s.mov, u: s.u, travel: s.travel, range: s.range || [s.a, s.b] })) };
  for (const st0 of query.stations) { const sp = spans.find((s) => st0.s > s.a + 1e-6 && st0.s < s.b - 1e-6); if (sp) st0.u = sp.u; }

  const moving = parts.map((p) => { const { g: G, ...rest } = p; return { ...rest, mesh: G.out() }; });
  const stat = g.out();
  return { id: o.id, type: 'bridge', anchor, lod, static: stat, moving, boards, gauges, signals, query, cut: null,
    tris: stat.tris + moving.reduce((a, p) => a + p.mesh.tris, 0), piers: pierS.slice().sort((a, b) => a - b), spans: spans.map((s) => ({ i: s.i, a: s.a, b: s.b, mov: s.mov, u: s.u, uo: s.uo, th: s.th, travel: s.travel })), extent: [sMin, sMax] };
}

/** Deck segment between stations s0 and s1 (underside u0 → u1, thickness th). */
function deckSeg(G, S, s0, s1, hw, u0, u1, th, kind, full) {
  const P0 = S.P(s0), P1 = S.P(s1), t0 = S.T(s0), t1 = S.T(s1);
  const n0 = [-t0[1], t0[0]], n1 = [-t1[1], t1[0]];
  const at = (P, n, lat, y) => [P[0] + n[0] * lat, y, P[1] + n[1] * lat];
  const top0 = u0 + th, top1 = u1 + th;
  const topC = kind === 'rail' ? COL.rail : kind === 'foot' ? COL.concrete : COL.asphalt;
  G.quad(at(P0, n0, -hw, top0), at(P1, n1, -hw, top1), at(P1, n1, hw, top1), at(P0, n0, hw, top0), topC);
  G.quad(at(P0, n0, -hw, u0), at(P0, n0, hw, u0), at(P1, n1, hw, u1), at(P1, n1, -hw, u1), COL.under);
  for (const sd of [-1, 1]) G.quad(at(P0, n0, sd * hw, u0), at(P1, n1, sd * hw, u1), at(P1, n1, sd * hw, top1), at(P0, n0, sd * hw, top0), COL.deckSide);
  if (!full) return;
  // parapets (1.1 m) and, on roads, a dashed centre line + edge lines
  for (const sd of [-1, 1]) {
    const a = at(P0, n0, sd * (hw - 0.15), top0), b = at(P1, n1, sd * (hw - 0.15), top1);
    beam(G, [a[0], a[1] + 0.55, a[2]], [b[0], b[1] + 0.55, b[2]], 0.3, 1.1, kind === 'rail' ? COL.steelDk : COL.concrete);
  }
  if (kind === 'road' || kind === 'mixed') {
    const L = Math.hypot(P1[0] - P0[0], P1[1] - P0[1]);
    for (let d = 1; d + 3 <= L; d += 9) {
      const f0 = d / L, f1 = (d + 3) / L, A = [P0[0] + (P1[0] - P0[0]) * f0, P0[1] + (P1[1] - P0[1]) * f0], B = [P0[0] + (P1[0] - P0[0]) * f1, P0[1] + (P1[1] - P0[1]) * f1];
      const y0 = top0 + (top1 - top0) * f0 + 0.03, y1 = top0 + (top1 - top0) * f1 + 0.03;
      G.quad(at(A, n0, -0.08, y0), at(B, n1, -0.08, y1), at(B, n1, 0.08, y1), at(A, n0, 0.08, y0), COL.mark);
    }
    for (const sd of [-1, 1]) G.quad(at(P0, n0, sd * (hw - 0.55), top0 + 0.03), at(P1, n1, sd * (hw - 0.55), top1 + 0.03), at(P1, n1, sd * (hw - 0.4), top1 + 0.03), at(P0, n0, sd * (hw - 0.4), top0 + 0.03), COL.mark);
  }
  if (kind === 'rail') for (const off of [-0.72, 0.72]) {
    const a = at(P0, n0, off, top0 + 0.12), b = at(P1, n1, off, top1 + 0.12);
    beam(G, a, b, 0.12, 0.16, COL.cable);
  }
}
/** A box following the line between s0 and s1, laterally lat0..lat1, y from y0(s) to y1(s). */
function segBox(G, S, s0, s1, lat0, lat1, y0f, y1f, col) {
  const n = Math.max(1, Math.ceil((s1 - s0) / 10));
  for (let k = 0; k < n; k++) {
    const a = s0 + ((s1 - s0) * k) / n, b = s0 + ((s1 - s0) * (k + 1)) / n, m = (a + b) / 2;
    const P = S.P(m), t = S.T(m);
    const latC = (lat0 + lat1) / 2, x = P[0] - t[1] * latC, z = P[1] + t[0] * latC;
    pbox(G, x, z, t, (b - a) / 2, (lat1 - lat0) / 2, y0f(m), y1f(m), col);
  }
}
/** Warren truss on both deck edges between a and b, height H above the deck top y. */
function truss(G, S, a, b, hw, y, H, full) {
  const L = b - a, n = Math.max(2, Math.round(L / H)), step = L / n;
  for (const sd of [-1, 1]) {
    const at = (s, yy) => { const p = S.P(s), t = S.T(s); return [p[0] - t[1] * sd * (hw + 0.2), yy, p[1] + t[0] * sd * (hw + 0.2)]; };
    beam(G, at(a, y + 0.4), at(b, y + 0.4), 0.6, 0.8, COL.steel);                        // bottom chord
    beam(G, at(a + step / 2, y + H), at(b - step / 2, y + H), 0.6, 0.8, COL.steel);      // top chord
    if (!full) { G.quad(at(a, y + 0.8), at(b, y + 0.8), at(b - step / 2, y + H), at(a + step / 2, y + H), shade(COL.steel, 0.8)); continue; }
    for (let k = 0; k < n; k++) {
      const s0 = a + k * step, s1 = s0 + step / 2, s2 = s0 + step;
      beam(G, at(s0, y + 0.4), at(s1, y + H), 0.45, 0.45, COL.steel);
      beam(G, at(s1, y + H), at(s2, y + 0.4), 0.45, 0.45, COL.steel);
    }
  }
  if (full) for (let k = 0; k < n; k++) {         // top lateral bracing
    const s = a + (k + 0.5) * step, p = S.P(s), t = S.T(s);
    beam(G, [p[0] + t[1] * (hw + 0.2), y + H, p[1] - t[0] * (hw + 0.2)], [p[0] - t[1] * (hw + 0.2), y + H, p[1] + t[0] * (hw + 0.2)], 0.4, 0.5, COL.steelDk);
  }
}
function arch(G, S, a, b, hw, y, full) {
  const L = b - a, rise = L / 6, n = full ? 16 : 8;
  for (const sd of [-1, 1]) {
    const at = (s, yy) => { const p = S.P(s), t = S.T(s); return [p[0] - t[1] * sd * (hw + 0.3), yy, p[1] + t[0] * sd * (hw + 0.3)]; };
    for (let k = 0; k < n; k++) {
      const f0 = k / n, f1 = (k + 1) / n;
      beam(G, at(a + L * f0, y + 4 * rise * f0 * (1 - f0)), at(a + L * f1, y + 4 * rise * f1 * (1 - f1)), 0.9, 1.2, COL.white);
      if (full && k > 0) beam(G, at(a + L * f0, y), at(a + L * f0, y + 4 * rise * f0 * (1 - f0)), 0.12, 0.12, COL.cable);
    }
  }
}
function cable(G, S, a, b, hw, y, full) {
  const H = (b - a) * 0.35, ps = a;
  for (const sd of [-1, 1]) {
    const at = (s, yy, lat = hw + 0.4) => { const p = S.P(s), t = S.T(s); return [p[0] - t[1] * sd * lat, yy, p[1] + t[0] * sd * lat]; };
    beam(G, at(ps, y - 2), at(ps, y + H), 1.6, 1.6, COL.white);
    const n = full ? 8 : 3;
    for (let k = 1; k <= n; k++) { beam(G, at(ps, y + H - k * 0.8), at(ps + ((b - a) * 0.9 * k) / n, y + 0.5), 0.12, 0.12, COL.cable); beam(G, at(ps, y + H - k * 0.8), at(ps - ((b - a) * 0.45 * k) / n, y + 0.5), 0.12, 0.12, COL.cable); }
  }
}
/** Lattice tower: 4 legs, braces every 6 m, X bracing on all faces. */
function lattice(G, x, z, t, ht, hn, y0, y1, col) {
  const n = [-t[1], t[0]];
  const c = (su, sn, y) => [x + t[0] * ht * su + n[0] * hn * sn, y, z + t[1] * ht * su + n[1] * hn * sn];
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (const [su, sn] of corners) beam(G, c(su, sn, y0), c(su, sn, y1), 0.55, 0.55, col);
  const lv = Math.max(2, Math.round((y1 - y0) / 6)), dy = (y1 - y0) / lv;
  for (let k = 0; k <= lv; k++) {
    const yy = y0 + k * dy;
    for (let i = 0; i < 4; i++) { const [a1, b1] = corners[i], [a2, b2] = corners[(i + 1) % 4]; beam(G, c(a1, b1, yy), c(a2, b2, yy), 0.3, 0.3, col); if (k < lv) beam(G, c(a1, b1, yy), c(a2, b2, yy + dy), 0.22, 0.22, col); }
  }
}

// ------------------------------------------------------------------------------------------------ LOD plan
/** Rough triangle estimates per LOD before an object was built once. */
export const EST_TRIS = { bridge: [0, 900, 3500], lock: [0, 400, 5000] };
/**
 * LOD plan (§5.3): items [{dist, type: 'bridge'|'lock', tris?: {1: n, 2: n}, builtLod?, builtTris?}] → wanted LOD per item
 * (same order). Nearest first: FULL within rFull, MID within rMax, at most B.objects drawn, and the triangle budget is
 * kept by dropping FULL → MID → NONE for the farther objects.
 */
export function planLod(items, B) {
  const order = items.map((it, k) => k).sort((a, b) => items[a].dist - items[b].dist);
  const want = new Array(items.length).fill(LOD3D.NONE);
  let tris = 0, n = 0;
  for (const k of order) {
    const e = items[k];
    let w = e.dist <= B.rFull ? LOD3D.FULL : e.dist <= B.rMax ? LOD3D.MID : LOD3D.NONE;
    if (n >= B.objects) w = LOD3D.NONE;
    const est = (lod) => (e.builtLod === lod && e.builtTris != null ? e.builtTris : e.tris?.[lod] ?? EST_TRIS[e.type || 'bridge'][lod]);
    if (w === LOD3D.FULL && tris + est(LOD3D.FULL) > B.tris) w = LOD3D.MID;
    if (w && tris + est(w) > B.tris) w = LOD3D.NONE;
    if (w) { tris += est(w); n++; }
    want[k] = w;
  }
  return want;
}

// ------------------------------------------------------------------------------------------------ poses
/** Transform of a moving part at open fraction f (0 closed … 1 open): {pos, axis, angle, sy}. pos = where the part origin goes. */
export function partPose(p, f) {
  f = clamp(Number(f) || 0, 0, 1);
  const pos = p.pivot.slice();
  let angle = 0, sy = 1;
  if (p.rot != null) angle = p.rot * f;
  if (p.move) { pos[0] += p.move[0] * f; pos[1] += p.move[1] * f; pos[2] += p.move[2] * f; }
  if (p.kind === 'stretch') sy = Math.max(0.01, p.top - pos[1]);
  return { pos, axis: p.axis || [0, 1, 0], angle, sy };
}
/** Apply a pose to a part-local point (Rodrigues) → object frame. */
export function posePoint(pose, v) {
  const [kx, ky, kz] = pose.axis, c = Math.cos(pose.angle), s = Math.sin(pose.angle);
  const x = v[0], y = v[1] * pose.sy, z = v[2];
  const d = kx * x + ky * y + kz * z;
  const cx = ky * z - kz * y, cy = kz * x - kx * z, cz = kx * y - ky * x;
  return [pose.pos[0] + x * c + cx * s + kx * d * (1 - c), pose.pos[1] + y * c + cy * s + ky * d * (1 - c), pose.pos[2] + z * c + cz * s + kz * d * (1 - c)];
}
/** Bounding box (object frame) of a part at fraction f. */
export function partBounds(part, f) {
  const pose = partPose(part, f), P = part.mesh.pos;
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < P.length; i += 3) { const q = posePoint(pose, [P[i], P[i + 1], P[i + 2]]); for (let k = 0; k < 3; k++) { if (q[k] < mn[k]) mn[k] = q[k]; if (q[k] > mx[k]) mx[k] = q[k]; } }
  return { min: mn, max: mx };
}
export function meshBounds(m) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity], P = m.pos;
  for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { if (P[i + k] < mn[k]) mn[k] = P[i + k]; if (P[i + k] > mx[k]) mx[k] = P[i + k]; }
  return { min: mn, max: mx };
}

// ------------------------------------------------------------------------------------------------ clearance queries
/**
 * Deck underside (object frame y) above point (x, z), or null when the point is not under the deck or the span over it is
 * fully open. fracs: span index → open fraction. Bascule / swing / pontoon count as closed until fully open (§4.3).
 */
export function undersideAt(q, x, z, fracs = {}) {
  if (!q) return null;
  const st = q.stations; let best = null;
  for (let i = 0; i + 1 < st.length; i++) {
    const A = st[i], B = st[i + 1], dx = B.x - A.x, dz = B.z - A.z, L2 = dx * dx + dz * dz; if (L2 < 1e-6) continue;
    const f = ((x - A.x) * dx + (z - A.z) * dz) / L2; if (f < -1e-6 || f > 1 + 1e-6) continue;
    const px = A.x + dx * f, pz = A.z + dz * f, d = Math.hypot(x - px, z - pz);
    if (d > q.hw) continue;
    const s = A.s + (B.s - A.s) * f;
    if (!best || d < best.d) best = { d, s, u: A.u + (B.u - A.u) * f };
  }
  if (!best) return null;
  for (const sp of q.spans) if (best.s >= sp.a && best.s <= sp.b) {
    const fr = clamp(Number(fracs[sp.i]) || 0, 0, 1);
    if (sp.mov === 'lift') return sp.u + sp.travel * fr;
    if (isMovable(sp.mov) && fr >= 0.999) return null;
    return sp.u;
  }
  return best.u;
}
/**
 * Air-draught overlay strip (§5.2): a horizontal band at y = water + need, `len` metres ahead of (x, z) along heading
 * hdg (deg, 0 = north), `beam` wide. under(x, z) → underside y | null. Returns typed arrays for a triangle strip with
 * vertex colours: green where the ship passes, red where the band is above the underside.
 */
export function overlayStrip({ x, z, hdg, need, beam: bw = 8, water = 0 }, under, len = 200, step = 4) {
  const n = Math.max(2, Math.ceil(len / step) + 1), y = water + need;
  const dx = Math.sin(hdg * D2R), dz = -Math.cos(hdg * D2R), nx = -dz, nz = dx, hw = bw / 2;
  const pos = new Float32Array(n * 2 * 3), col = new Float32Array(n * 2 * 3), idx = [];
  let red = 0, firstRed = null;
  for (let i = 0; i < n; i++) {
    const d = (i * len) / (n - 1), cx = x + dx * d, cz = z + dz * d;
    let hit = false;
    for (const s of [-hw, 0, hw]) { const u = under(cx + nx * s, cz + nz * s); if (u != null && y > u) { hit = true; break; } }
    if (hit) { red++; if (firstRed == null) firstRed = d; }
    const c = hit ? [0.95, 0.22, 0.2] : [0.25, 0.85, 0.45];
    for (const [k, s] of [[0, -hw], [1, hw]]) { const o = (i * 2 + k) * 3; pos[o] = cx + nx * s; pos[o + 1] = y; pos[o + 2] = cz + nz * s; col[o] = c[0]; col[o + 1] = c[1]; col[o + 2] = c[2]; }
    if (i) { const a = (i - 1) * 2; idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
  }
  return { pos, col, idx: Uint16Array.from(idx), red, firstRed, y };
}
/**
 * Bridges ahead of a ship: the heading ray (lat, lon, hdg) crossing each bridge line (extended 30 m each side) within maxM.
 * Returns [{id, obj, dist, s, span}] nearest first; span = the drawn span index containing the crossing (or the nearest).
 */
export function bridgesAhead(objs, lat, lon, hdg, maxM = 5000, n = 3) {
  const f = { lat, lon }, dx = Math.sin(hdg * D2R), dz = -Math.cos(hdg * D2R), out = [];
  for (const o of objs) {
    if (!o || !o.line || o.line.length < 2 || !o.spans) continue;
    const pts = o.line.map(([a, b]) => llToLocal(f, a, b));
    const S = polySampler(pts);
    let hit = null;
    for (let i = 0; i + 1 < pts.length; i++) {
      let A = pts[i], B = pts[i + 1];
      const ex = (B[0] - A[0]), ez = (B[1] - A[1]), el = Math.hypot(ex, ez) || 1;
      if (i === 0) A = [A[0] - (ex / el) * 30, A[1] - (ez / el) * 30];
      if (i === pts.length - 2) B = [B[0] + (ex / el) * 30, B[1] + (ez / el) * 30];
      const sx = B[0] - A[0], sz = B[1] - A[1], det = sx * dz - dx * sz; if (Math.abs(det) < 1e-9) continue;
      // ray t·d = A + uu·(B − A)  →  t·dx − uu·sx = Ax, t·dz − uu·sz = Az
      const tt = (sx * A[1] - sz * A[0]) / det, uu = (dx * A[1] - dz * A[0]) / det;
      if (tt > 0 && tt <= maxM && uu >= -1e-6 && uu <= 1 + 1e-6) { const s = S.cum[i] + uu * Math.hypot(sx, sz) - (i === 0 ? 30 : 0); if (!hit || tt < hit.dist) hit = { dist: tt, s }; }
    }
    if (!hit) continue;
    const sp = drawnSpans(o); let span = sp.find((q) => hit.s >= q.a && hit.s <= q.b);
    if (!span && sp.length) span = sp.reduce((m, q) => (Math.min(Math.abs(hit.s - q.a), Math.abs(hit.s - q.b)) < Math.min(Math.abs(hit.s - m.a), Math.abs(hit.s - m.b)) ? q : m));
    out.push({ id: o.id, obj: o, dist: hit.dist, s: hit.s, span: span ? span.i : 0 });
  }
  return out.sort((a, b) => a.dist - b.dist).slice(0, n);
}

// ------------------------------------------------------------------------------------------------ locks
/**
 * Build a lock complex. opts: { lod, anchor, hi (highest operational level, y), lo (lowest), datumOffset, water }.
 * Gate parts: per chamber, head 0 / 1, leaf 0 / 1. Water part per chamber (chamber surface at y = 0 part-local, floating
 * bollards ride on it). cut = chamber footprints (object frame) for the ocean cut-outs.
 */
export function buildLock(o, opts = {}) {
  const lod = opts.lod ?? LOD3D.FULL, full = lod >= LOD3D.FULL;
  const anchor = opts.anchor || anchorOf(o);
  const hi = num(opts.hi, 2.5), lo = num(opts.lo, -1.5), cop = hi + 1.5;
  const g = new Geo(), parts = [], signals = [], cut = [], boards = [];
  for (const [ci, ch] of (o.chambers || []).entries()) {
    const ax = (ch.axis || []).map(([la, lo2]) => llToLocal(anchor, la, lo2));
    if (ax.length < 2) continue;
    const A = ax[0], B = ax[ax.length - 1], dl = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
    const u = [(B[0] - A[0]) / dl, (B[1] - A[1]) / dl], v = [-u[1], u[0]], C = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
    const len = num(ch.len, dl), wid = num(ch.wid, 12), hw = wid / 2;
    const sill = Math.max(num(ch.sillUp, 3), num(ch.sillDn, 3)), floor = lo - sill;
    const P = (uu, vv, y) => [C[0] + u[0] * uu + v[0] * vv, y, C[1] + u[1] * uu + v[1] * vv];
    const gates = (ch.gates && ch.gates.length ? ch.gates : [{ head: 0, type: 'mitre', at: 0 }, { head: 1, type: 'mitre', at: len }]);
    const gU = [0, 1].map((h) => { const gg = gates.find((x) => x.head === h); return -len / 2 + num(gg?.at, h ? len : 0); });
    const HL = clamp(wid * 0.9, 14, 30), wallT = 5;
    const uMin = gU[0] - HL, uMax = gU[1] + HL;
    // walls: inner faces with gate recesses on the outward side of each gate (mitre leaves open into them)
    const types = [0, 1].map((h) => (gates.find((x) => x.head === h)?.type) || 'mitre');
    const leafL = (t) => (t === 'mitre' ? hw / Math.cos(18 * D2R) : t === 'sector' ? hw * 1.05 : 0);
    const rec = [0, 1].map((h) => { const L = leafL(types[h]) + 1; return h === 0 ? [gU[0] - L, gU[0]] : [gU[1], gU[1] + L]; });
    for (const sd of [-1, 1]) {
      const segs = [[uMin, rec[0][0], 0], [rec[0][0], rec[0][1], 1.6], [rec[0][1], rec[1][0], 0], [rec[1][0], rec[1][1], 1.6], [rec[1][1], uMax, 0]];
      for (const [u0, u1, setback] of segs) {
        if (u1 - u0 < 0.05) continue;
        const vin = sd * (hw + setback), vout = sd * (hw + wallT + (u0 < gU[0] || u1 > gU[1] ? 3 : 0));
        // inner face: wet band below hi, concrete above (dark wet band on the walls, §5.4)
        g.quad(P(u0, vin, floor), P(u1, vin, floor), P(u1, vin, hi), P(u0, vin, hi), COL.wet);
        g.quad(P(u0, vin, hi), P(u1, vin, hi), P(u1, vin, cop), P(u0, vin, cop), COL.concrete);
        g.quad(P(u0, vin, cop), P(u1, vin, cop), P(u1, vout, cop), P(u0, vout, cop), shade(COL.concrete, 1.05));       // coping
        g.quad(P(u0, vout, cop), P(u1, vout, cop), P(u1, vout, floor), P(u0, vout, floor), COL.concreteDk);
        if (setback) { for (const uu of [u0, u1]) g.quad(P(uu, sd * hw, floor), P(uu, vin, floor), P(uu, vin, cop), P(uu, sd * hw, cop), COL.concreteDk); }
      }
      for (const uu of [uMin, uMax]) g.quad(P(uu, sd * hw, floor), P(uu, sd * (hw + wallT + 3), floor), P(uu, sd * (hw + wallT + 3), cop), P(uu, sd * hw, cop), COL.concreteDk);
      if (full) {   // coping edge line (yellow) and bollards on the coping
        g.quad(P(uMin, sd * (hw + 0.05), cop + 0.02), P(uMax, sd * (hw + 0.05), cop + 0.02), P(uMax, sd * (hw + 0.35), cop + 0.02), P(uMin, sd * (hw + 0.35), cop + 0.02), COL.markY);
        const step = num(ch.bollards?.step, 15);
        for (let uu = gU[0] + step / 2; uu < gU[1]; uu += step) { const p = P(uu, sd * (hw + 1.2), 0); cyl(g, p[0], p[2], 0.3, cop, cop + 0.7, 6, COL.bollard); }
      }
    }
    g.quad(P(uMin, -hw - 2, floor), P(uMin, hw + 2, floor), P(uMax, hw + 2, floor), P(uMax, -hw - 2, floor), COL.floor);
    // sills at the heads (raised floor across the gate line)
    for (const h of [0, 1]) { const p = P(gU[h], 0, 0); pbox(g, p[0], p[2], u, 1.5, hw, floor, floor + 0.8, COL.concreteDk); }
    // furniture: recess bollards at `levels` heights, floating bollard slots, ladders, lock-keeper's house, signals
    const step = num(ch.bollards?.step, 15), levels = num(ch.bollards?.levels, 3), floating = !!ch.bollards?.floating;
    if (full) for (const sd of [-1, 1]) {
      for (let uu = gU[0] + step / 2, k = 0; uu < gU[1]; uu += step, k++) {
        if (floating) { const a = P(uu - 0.45, sd * (hw - 0.01), floor + 0.5), b = P(uu + 0.45, sd * (hw - 0.01), floor + 0.5); g.quad(a, b, [b[0], cop - 0.3, b[2]], [a[0], cop - 0.3, a[2]], COL.gateDk); }
        else for (let l = 0; l < levels; l++) { const y = lo + 0.6 + ((hi - lo) * (l + 0.5)) / levels; const p = P(uu, sd * (hw - 0.25), y); pbox(g, p[0], p[2], u, 0.3, 0.25, y - 0.25, y + 0.25, COL.bollardY); }
        if (k % 2 === 1) {   // ladder every 30 m (2 rails + rungs on the wall face)
          const ul = uu + step / 2;
          for (const o2 of [-0.25, 0.25]) beam(g, P(ul + o2, sd * (hw - 0.12), floor + 1), P(ul + o2, sd * (hw - 0.12), cop), 0.06, 0.06, COL.steelDk);
          for (let y = floor + 1.3; y < cop; y += 0.6) g.quad(P(ul - 0.25, sd * (hw - 0.14), y), P(ul + 0.25, sd * (hw - 0.14), y), P(ul + 0.25, sd * (hw - 0.14), y + 0.05), P(ul - 0.25, sd * (hw - 0.14), y + 0.05), COL.steelDk);
        }
      }
      // guide walls (remmingwerk) flaring out of both heads
      for (const [h, dir] of [[0, -1], [1, 1]]) {
        const u0 = h ? uMax : uMin;
        for (let d = 0; d <= 80; d += 4) { const p = P(u0 + dir * d, sd * (hw + 1 + d * 0.12), 0); pbox(g, p[0], p[2], u, 0.3, 0.3, floor, hi + 0.8, COL.pile, ['-v']); }
        beam(g, P(u0, sd * (hw + 1), hi + 0.4), P(u0 + dir * 80, sd * (hw + 1 + 80 * 0.12), hi + 0.4), 0.4, 0.6, COL.wood);
        beam(g, P(u0, sd * (hw + 1), lo + 0.6), P(u0 + dir * 80, sd * (hw + 1 + 80 * 0.12), lo + 0.6), 0.4, 0.6, COL.wood);
      }
    }
    if (full && ci === 0) {   // lock-keeper's house on head 0 (+v side)
      const p = P(gU[0] + HL * 1.6, hw + wallT + 16, 0);
      pbox(g, p[0], p[2], u, 5, 4, cop, cop + 4.5, COL.house);
      obox(g, [p[0], cop + 5.4, p[2]], [u[0], 0, u[1]], UP, [v[0], 0, v[1]], 5.4, 0.9, 4.4, COL.roof);
      for (const sd of [-1, 1]) obox(g, add(P(gU[0] + HL * 1.6 + sd * 5.02, hw + wallT + 16, 0), [0, cop + 3.0, 0]), [v[0], 0, v[1]], UP, [u[0], 0, u[1]], 3.2, 0.6, 0.02, COL.glass);
    }
    for (const h of [0, 1]) for (const face of ['out', 'in']) {      // signal masts on the +v wall at each head
      const uu = h === 0 ? (face === 'out' ? uMin + 1 : gU[0] + 3) : (face === 'out' ? uMax - 1 : gU[1] - 3);
      const dirU = (h === 0) === (face === 'out') ? -1 : 1;
      const pos = P(uu, hw + 1.6, cop + 4.2);
      signals.push({ key: `sig${ch.id}:${h}:${face}`, part: -1, pos, nrm: [u[0] * dirU, 0, u[1] * dirU], kind: 'head', chamber: ch.id ?? ci, head: h, face });
      const m = P(uu, hw + 1.6, 0); beam(g, [m[0], cop, m[2]], [m[0], cop + 3.2, m[2]], 0.2, 0.2, COL.steelDk);
      if (full) obox(g, add(pos, [u[0] * dirU, 0, u[1] * dirU], -0.13), [v[0], 0, v[1]], UP, [u[0], 0, u[1]], 0.75, 1.1, 0.1, COL.housing);
    }
    // gates
    for (const h of [0, 1]) {
      const type = types[h], ug = gU[h], out = h === 0 ? -1 : 1, gh = cop - floor;
      const mkPart = (kind, pivot, extra) => { const p = { key: `ch${ch.id ?? ci}:g${h}:${parts.length}`, kind, chamber: ch.id ?? ci, head: h, pivot, axis: null, g: new Geo(pivot), ...extra }; parts.push(p); return p; };
      if (type === 'mitre' || type === 'sector') {
        for (const sd of [-1, 1]) {
          const hinge = P(ug, sd * hw, floor), Lf = leafL(type);
          const apexU = ug + out * hw * Math.tan(18 * D2R);
          const closedDir = norm([C[0] + u[0] * apexU - hinge[0], 0, C[1] + u[1] * apexU - hinge[2]]);
          const openDir = [u[0] * out, 0, u[1] * out];
          const ang = yawBetween(closedDir, openDir);
          const p = mkPart('gate', hinge, { axis: [0, 1, 0], rot: ang });
          if (type === 'mitre') {
            const end = add(hinge, closedDir, Lf);
            obox(p.g, [(hinge[0] + end[0]) / 2, floor + gh / 2, (hinge[2] + end[2]) / 2], closedDir, UP, norm(cross(closedDir, UP)), Lf / 2, gh / 2 - 0.05, 0.55, COL.gate);
            if (full) { const top = [(hinge[0] + end[0]) / 2, cop + 0.55, (hinge[2] + end[2]) / 2]; obox(p.g, top, closedDir, UP, norm(cross(closedDir, UP)), Lf / 2, 0.05, 0.6, COL.wood); beam(p.g, add(hinge, [0, cop - floor + 0.6, 0]), add(add(hinge, closedDir, Lf), [0, cop - floor + 0.6, 0]), 0.06, 1.0, COL.white); }
          } else {     // sector: a curved skin with two arms
            const R = Lf, n = full ? 6 : 3, perp = norm(cross(closedDir, UP));
            let prev = null;
            for (let k = 0; k <= n; k++) {
              const f = k / n, bulge = Math.sin(f * Math.PI) * R * 0.12 * out;
              const q = add(add(hinge, closedDir, R * f), [u[0], 0, u[1]], bulge);
              if (prev) obox(p.g, [(prev[0] + q[0]) / 2, floor + gh / 2, (prev[2] + q[2]) / 2], norm([q[0] - prev[0], 0, q[2] - prev[2]]), UP, perp, Math.hypot(q[0] - prev[0], q[2] - prev[2]) / 2 + 0.05, gh / 2, 0.4, COL.gate);
              prev = q;
            }
            if (full) for (const y of [floor + 1, cop - 0.5]) beam(p.g, add(hinge, [0, y - floor, 0]), add(add(hinge, closedDir, R * 0.5), [u[0] * out * R * 0.25, y - floor, u[1] * out * R * 0.25]), 0.3, 0.3, COL.steelDk);
          }
        }
      } else if (type === 'lift') {
        const clrG = num(ch.gateClr, 20), travel = hi + clrG - floor;
        const p = mkPart('gate', P(ug, 0, floor), { move: [0, travel, 0] });
        obox(p.g, P(ug, 0, floor + gh / 2), [v[0], 0, v[1]], UP, [u[0], 0, u[1]], hw + 0.6, gh / 2, 0.8, COL.gate);
        const topY = floor + travel + gh + 2;
        for (const sd of [-1, 1]) { const q = P(ug, sd * (hw + 2.2), 0); pbox(g, q[0], q[2], u, 2, 1.6, cop, topY, COL.concrete); }
        obox(g, P(ug, 0, topY + 1.2), [v[0], 0, v[1]], UP, [u[0], 0, u[1]], hw + 3.8, 1.2, 2, COL.concreteDk);
      } else if (type === 'rolling') {
        const p = mkPart('gate', P(ug, 0, floor), { move: [v[0] * (wid + 1), 0, v[1] * (wid + 1)] });
        obox(p.g, P(ug, 0, floor + gh / 2), [v[0], 0, v[1]], UP, [u[0], 0, u[1]], hw + 0.4, gh / 2 - 0.05, 3, COL.gate);
        const d = P(ug, hw + wallT + wid / 2 + 2, 0); pbox(g, d[0], d[2], u, 4, wid / 2 + 2, floor, cop + 0.2, COL.concreteDk, ['-v', '+v']);
      } else if (type === 'drop') {
        const p = mkPart('gate', P(ug, 0, floor), { move: [0, -(gh - 0.5), 0] });
        obox(p.g, P(ug, 0, floor + gh / 2), [v[0], 0, v[1]], UP, [u[0], 0, u[1]], hw + 0.4, gh / 2, 0.8, COL.gate);
      }
    }
    // chamber water (surface at part-local y = 0; the part rides the chamber level) + floating bollards
    const wp = { key: `ch${ch.id ?? ci}:water`, kind: 'water', chamber: ch.id ?? ci, pivot: [C[0], 0, C[1]], axis: null, move: [0, 1, 0], g: new Geo([C[0], 0, C[1]]) };
    const apex = (t) => (t === 'mitre' ? hw * Math.tan(18 * D2R) : t === 'sector' ? hw * 0.25 : 0.8);
    const wu0 = gU[0] - apex(types[0]), wu1 = gU[1] + apex(types[1]);
    wp.g.quad(P(wu0, -hw - 1.6, 0), P(wu0, hw + 1.6, 0), P(wu1, hw + 1.6, 0), P(wu1, -hw - 1.6, 0), COL.water);
    if (floating && full) for (const sd of [-1, 1]) for (let uu = gU[0] + step / 2; uu < gU[1]; uu += step) { const p = P(uu, sd * (hw - 0.35), 0); cyl(wp.g, p[0], p[2], 0.3, -0.3, 0.8, 6, COL.bollardY); }
    parts.push(wp);
    cut.push({ chamber: ch.id ?? ci, ring: [P(wu0, -hw - 1.6, 0), P(wu1, -hw - 1.6, 0), P(wu1, hw + 1.6, 0), P(wu0, hw + 1.6, 0)].map((p) => [p[0], p[2]]),
      gates: [P(gU[0], 0, 0), P(gU[1], 0, 0)].map((p) => [p[0], p[2]]), u, v, C, len, wid, hw, gU, floor, cop, area: len * wid });
  }
  const moving = parts.map((p) => { const { g: G, ...rest } = p; return { ...rest, mesh: G.out() }; });
  const stat = g.out();
  return { id: o.id, type: 'lock', anchor, lod, static: stat, moving, boards, gauges: [], signals, query: null, cut,
    tris: stat.tris + moving.reduce((a, p) => a + p.mesh.tris, 0), hi, lo, cop };
}
/** Signed yaw (rad, three.js rotation about +y) that turns direction c into o (x/z only). */
export function yawBetween(c, o) {
  let d = -(Math.atan2(o[2], o[0]) - Math.atan2(c[2], c[0]));
  while (d > Math.PI) d -= 2 * Math.PI; while (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}
/** Which chamber (cut entry) contains object-frame point (x, z), or null. */
export function chamberAt(cuts, x, z) {
  for (const c of cuts || []) if (inRing(c.ring, x, z)) return c;
  return null;
}
export function inRing(r, x, z) {
  let ins = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, zi] = r[i], [xj, zj] = r[j]; if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) ins = !ins; }
  return ins;
}

// ------------------------------------------------------------------------------------------------ D14 fallback
const MOV_NUM = ['fixed', 'bascule', 'lift', 'swing', 'pontoon', 'bascule'];
/**
 * A tile-vector bridge (converter v2, §4.2: { p (tile decimetres x, y pairs), w, deck, clr, mov, k, e, id, clrO, wO, datum,
 * sp: [aDm, bDm] }) as a registry-shaped Bridge object, so the same builder draws it while the registry has not answered.
 * frame: { z, x, y } of the tile (Web Mercator).
 */
export function bridgeFromVector(vb, tz, tx, ty) {
  if (!vb || !vb.p || vb.p.length < 4) return null;
  const n2 = 2 ** tz, latOf = (fy) => Math.atan(Math.sinh(Math.PI * (1 - (2 * (ty + fy)) / n2))) / D2R;
  const lonW = (tx / n2) * 360 - 180, dlon = 360 / n2, latC = latOf(0.5);
  const sizeM = (2 * Math.PI * 6378137 * Math.cos(latC * D2R)) / n2, sz10 = sizeM * 10;
  const line = [];
  for (let i = 0; i + 1 < vb.p.length; i += 2) line.push([latOf(vb.p[i + 1] / sz10), lonW + (vb.p[i] / sz10) * dlon]);
  const S = polySampler(line.map(([a, b]) => llToLocal({ lat: line[0][0], lon: line[0][1] }, a, b)));
  let a = vb.sp ? vb.sp[0] / 10 : S.L * 0.2, b = vb.sp ? vb.sp[1] / 10 : S.L * 0.8;
  if (b <= a) [a, b] = [S.L * 0.2, S.L * 0.8];
  const mov = typeof vb.mov === 'string' ? vb.mov : MOV_NUM[vb.mov | 0] || 'fixed';
  const kind = vb.k === 'rail' || vb.k === 2 ? 'rail' : vb.k === 'path' || vb.k === 3 ? 'foot' : 'road';
  return { id: vb.id || null, name: vb.name || 'Bridge', kind, src: String(vb.id || '').startsWith('osm:') ? 'osm' : 'ofm', e: num(vb.e, 2), line, deckW: num(vb.w, 8),
    structure: 'girder', datum: vb.datum || 'MSL', spans: [{ id: 0, a, b, mov, clr: num(vb.clr, 2.5), clrO: vb.clrO ?? null, w: num(vb.wO, b - a), hinge: null, pivot: null, rec: 1 }], fromTile: true };
}
