// Inland harbours and marinas in 3D, on the radar / chart and alongside (player report: "inland harbours show no docks,
// and the map does not show the harbour in detail like the large harbours do"). Pure rules shared by the server
// (server/minorharbours.js geo records, server/mhmoor.js mooring and guidance) and the client (public/js/mharbour.js
// meshes, public/js/radarmap.js underlay, public/js/mhchart.js chart outlines). Plain ESM, no DOM, no Node-only imports.
//
// A harbour record (shared/mharbour.js) carries pontoon / quay axes from OSM, or nothing at all (FIS-only harbours,
// about half of the NL list). This module:
//   • synthPontoons   lays pontoons into the water next to a geometry-less harbour from the D14 world-tile mask the
//                     server holds (a water grid around the harbour point; pontoons with their box rows and an entry lane
//                     must lie on water, one end near the bank gets a gangway) — deterministic for the same tiles;
//   • sideMask        which sides of the OSM pontoons have room for boxes (the 6th pontoon field, berthsOf honours it);
//   • geoRecord       the compact record the client gets (GET /api/mh/geo): pontoons, quays, gangways, the
//                     harbour-master hut on the bank, the fuel berth, the sign;
//   • layoutOf        decks, finger piers, piles, box outlines, side berths — from berthsOf, so server and client agree;
//   • segmentsOf      the outlines the radar / chart / guidance plan draw;
//   • boxWhy / sideWhy / moorPoint / sideSlot       mooring rules (fit, depth, occupancy, where the hull lies);
//   • mhServices / mhDenies / mhSurcharge / mhServiceRows   services by tier on top of the dock-anywhere tier.
import { MH, berthsOf, marinaSize, boxLenFor, boxWidth, boxFits, sideFits, depthNeed, servicesOf, layerServices, nightFee, TIERS } from './mharbour.js';
import { distM, quayDenies, quaySurcharge, serviceTier, SERVICE_TIERS } from './quayrules.js';

const D2R = Math.PI / 180, R2D = 180 / Math.PI, M_LAT = 111320;
const r1 = (v) => Math.round(v * 10) / 10;
const r5 = (v) => Math.round(v * 1e5) / 1e5;
const r6 = (v) => Math.round(v * 1e6) / 1e6;   // outlines: 0.1 m
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mPerLon = (lat) => M_LAT * Math.cos(lat * D2R);

export const MHG = {
  VERSION: 1,
  // synthesis (server, from the tiles in memory)
  GRID_RES_M: 4, GRID_HALF_M: 280,      // water grid around the harbour point (141 × 141 samples)
  SEED_M: 350,                          // the harbour's water: the nearest navigable cell this close to its point
  SEARCH_M: 200, STEP_M: 10, DIRS: 12,  // candidate pontoon centres around that water, every 15°
  MAX_PONT: 4, MAX_PONT_LEN: 90, MIN_PONT_LEN: 24,
  LANE_MIN_M: 12, LANE_K: 1.2,          // the water in front of a box row: max(12 m, 1.2 × box length)
  KNOWN_MIN: 0.35,                      // fraction of the grid the tiles must cover before a layout is made
  SIDE_OK: 0.6,                         // OSM pontoons: a side takes boxes when this much of its box band is water
  GANG_MAX_M: 30, HUT_MAX_M: 80,
  HALF_W: MH.PONTOON_HALF_W, FINGER_W: 0.7, FINGER_K: 0.7, QUAY_HALF_W: 0.8, FENDER_M: 0.6,
  // client
  NEAR_KM: 3, MAX_NEAR: 12,
  BUDGET: {
    desktop: { harbours: 10, rFull: 1400, rMax: 3500, tris: 160000, labels: 24, buildMs: 6 },
    phone: { harbours: 5, rFull: 800, rMax: 2200, tris: 50000, labels: 10, buildMs: 6 },
  },
  // guidance and mooring (server)
  GUIDE_KM: 1.5, MOOR_M: 60, MOOR_KN: 2,          // MOOR_M = INTERACT.BERTH_RANGE_U (the Moor button)
};

// ------------------------------------------------------------------------------------------------ local frame
/** Local metres (east, north) about an anchor and back. */
export function frameAt(lat0, lon0) {
  const k = mPerLon(lat0);
  return { lat0, lon0, k, en: (lat, lon) => [(lon - lon0) * k, (lat - lat0) * M_LAT], ll: (e, n) => [lat0 + n / M_LAT, lon0 + e / k] };
}
/** Bearing (deg, 0 = north) of (east, north). */
export const bearingEN = (e, n) => (Math.atan2(e, n) * R2D + 360) % 360;
function bearingLL(a, b) { const k = mPerLon(a[0]); return bearingEN((b[1] - a[1]) * k, (b[0] - a[0]) * M_LAT); }
function moveLL(p, brg, m) { const b = brg * D2R; return [p[0] + (Math.cos(b) * m) / M_LAT, p[1] + (Math.sin(b) * m) / mPerLon(p[0])]; }

// ------------------------------------------------------------------------------------------------ water grid
const NAV = new Uint8Array(256);   // world-tile mask codes that float a hull (= shared/wtformat.js WT_NAVIGABLE: water, fairway, shallow, dock, river, lock)
for (const c of [0, 5, 6, 7, 8, 9]) NAV[c] = 1;
/**
 * Water grid around (lat0, lon0): w[j * n + i] = 0 unknown (tile not in memory), 1 water, 2 land, 3 building / structure, 4 fairway.
 * sample(lat, lon) → { mask } | null (server/quays.js makeSampler). Row j = north → south, column i = west → east.
 */
export function waterGrid(sample, lat0, lon0, { res = MHG.GRID_RES_M, half = MHG.GRID_HALF_M, nav = NAV } = {}) {
  const F = frameAt(lat0, lon0), n = Math.floor((2 * half) / res) + 1, w = new Uint8Array(n * n);
  let known = 0;
  for (let j = 0; j < n; j++) {
    const N = half - j * res;
    for (let i = 0; i < n; i++) {
      const E = -half + i * res, [la, lo] = F.ll(E, N);
      let s = null; try { s = sample(la, lo); } catch { s = null; }
      if (!s || !Number.isFinite(s.mask)) continue;
      known++;
      w[j * n + i] = s.mask === 5 ? 4 : nav[s.mask] === 1 ? 1 : s.mask === 10 || s.mask === 2 || s.mask === 3 || s.mask === 4 ? 3 : 2;   // 4: fairway (open for lanes, never for pontoons)
    }
  }
  return { F, n, res, half, w, known: known / (n * n) };
}
/** Grid value at local metres (0 outside). */
export function gridAt(G, e, n) {
  const i = Math.round((e + G.half) / G.res), j = Math.round((G.half - n) / G.res);
  return i < 0 || j < 0 || i >= G.n || j >= G.n ? 0 : G.w[j * G.n + i];
}
/**
 * Fraction of water in a rectangle: centre c [e, n], unit axis u [ue, un], along −L/2…L/2, across a0…a1 (positive =
 * right of u). Sampled every `step` m; stops early (returns < min) once `min` can no longer be reached.
 */
export function rectWater(G, c, u, L, a0, a1, { step = 3, min = 0, lane = false } = {}) {
  const rx = u[1], ry = -u[0];
  const na = Math.max(1, Math.ceil(L / step)), nb = Math.max(1, Math.ceil(Math.abs(a1 - a0) / step));
  const total = (na + 1) * (nb + 1); let wet = 0, seen = 0;
  for (let p = 0; p <= na; p++) {
    const s = -L / 2 + (L * p) / na;
    for (let q = 0; q <= nb; q++) {
      const t = a0 + ((a1 - a0) * q) / nb;
      const v = gridAt(G, c[0] + u[0] * s + rx * t, c[1] + u[1] * s + ry * t);
      if (v === 1 || (lane && v === 4)) wet++;
      seen++;
      if (min > 0 && (wet + (total - seen)) / total < min) return wet / total;
    }
  }
  return wet / total;
}
/** Metres from a point along a bearing (deg) to the first cell that is not water (≤ maxM; maxM + 1 when none). */
export function marchToBank(G, e, n, brg, maxM = 60, step = 2) {
  const ue = Math.sin(brg * D2R), un = Math.cos(brg * D2R);
  for (let d = 0; d <= maxM; d += step) { const v = gridAt(G, e + ue * d, n + un * d); if (v !== 1) return v === 0 ? maxM + 1 : d; }
  return maxM + 1;
}
/** The nearest cell of a kind (1 water, 2 land) to a point within maxM → [e, n] | null (deterministic scan order). */
export function nearestCell(G, e, n, kind, maxM) {
  let best = null, bd = Infinity;
  const r = Math.ceil(maxM / G.res), ci = Math.round((e + G.half) / G.res), cj = Math.round((G.half - n) / G.res);
  for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
    const i = ci + di, j = cj + dj; if (i < 0 || j < 0 || i >= G.n || j >= G.n || G.w[j * G.n + i] !== kind) continue;
    const E = -G.half + i * G.res, N = G.half - j * G.res, d = Math.hypot(E - e, N - n);
    if (d <= maxM && d < bd - 1e-9) { bd = d; best = [E, N]; }
  }
  return best;
}

// ------------------------------------------------------------------------------------------------ synthesis
const BOX_MAX = { small: 12, medium: 15, large: 20 };
/** What a harbour of this tier and size needs: { L (pontoon length each), count, total, zone (box band m), lane, twoSided }. */
export function synthNeeds(h) {
  const places = Number(h.places) > 0 ? Number(h.places) : Number(h.cap) > 0 ? Number(h.cap) : 20;
  let total, zone, lane;
  if (h.tier === 'marina') {
    const size = marinaSize(places), bl = BOX_MAX[size], w = boxWidth(boxLenFor(1, 2, size));
    total = (places / 2) * w; zone = bl + 1; lane = Math.max(MHG.LANE_MIN_M, MHG.LANE_K * bl);
  } else {
    total = h.tier === 'passant' ? Math.ceil(places / MH.RAFT_ABREAST) * MH.RAFT_SLOT_M : Math.min(places, 8) * MH.RAFT_SLOT_M;
    zone = h.tier === 'passant' ? 11 : 9; lane = MHG.LANE_MIN_M;
  }
  total = clamp(total, MHG.MIN_PONT_LEN, MHG.MAX_PONT * MHG.MAX_PONT_LEN);
  const count = Math.max(1, Math.min(MHG.MAX_PONT, Math.ceil(total / MHG.MAX_PONT_LEN)));
  return { places, total, count, L: Math.round(clamp(total / count, MHG.MIN_PONT_LEN, MHG.MAX_PONT_LEN)), zone, lane, twoSided: h.tier === 'marina' };
}
/** Chamfer distance (m) from every grid cell to the nearest cell where ok(v) is false (outside the grid counts as not ok). */
export function distField(G, ok) {
  const n = G.n, D = new Float32Array(n * n), INF = 1e9, a = G.res, b = G.res * Math.SQRT2;
  for (let k = 0; k < n * n; k++) D[k] = ok(G.w[k]) ? INF : 0;
  const at = (i, j) => (i < 0 || j < 0 || i >= n || j >= n ? 0 : D[j * n + i]);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const k = j * n + i; if (!D[k]) continue; D[k] = Math.min(D[k], at(i - 1, j) + a, at(i, j - 1) + a, at(i - 1, j - 1) + b, at(i + 1, j - 1) + b); }
  for (let j = n - 1; j >= 0; j--) for (let i = n - 1; i >= 0; i--) { const k = j * n + i; if (!D[k]) continue; D[k] = Math.min(D[k], at(i + 1, j) + a, at(i, j + 1) + a, at(i + 1, j + 1) + b, at(i - 1, j + 1) + b); }
  return D;
}
/** Is the band (along −L/2…L/2, across a0…a1) clear on a distance field? Disks along its centre line cover it. */
function bandClear(G, D, c, u, L, a0, a1) {
  const rx = u[1], ry = -u[0], m = (a0 + a1) / 2, r = Math.abs(a1 - a0) / 2 + G.res * 0.5, steps = Math.max(1, Math.ceil(L / 3));
  for (let p = 0; p <= steps; p++) {
    const s = -L / 2 + (L * p) / steps, e = c[0] + u[0] * s + rx * m, nn = c[1] + u[1] * s + ry * m;
    const i = Math.round((e + G.half) / G.res), j = Math.round((G.half - nn) / G.res);
    if (i < 0 || j < 0 || i >= G.n || j >= G.n || D[j * G.n + i] < r) return false;
  }
  return true;
}
/** Mark a rectangle on an occupancy grid (1 hard: deck / boxes, 2 lane). */
function markRect(G, occ, c, u, L, a0, a1, val) {
  const rx = u[1], ry = -u[0], step = G.res / 2;
  for (let s = -L / 2; s <= L / 2 + 1e-9; s += step) for (let t = Math.min(a0, a1); t <= Math.max(a0, a1) + 1e-9; t += step) {
    const e = c[0] + u[0] * s + rx * t, n = c[1] + u[1] * s + ry * t;
    const i = Math.round((e + G.half) / G.res), j = Math.round((G.half - n) / G.res);
    if (i < 0 || j < 0 || i >= G.n || j >= G.n) continue;
    const k = j * G.n + i; if (val === 1 || occ[k] === 0) occ[k] = val;
  }
}
/** Does a rectangle touch occupied cells (hard only, or hard and lanes)? */
function hitsRect(G, occ, c, u, L, a0, a1, lanesToo) {
  const rx = u[1], ry = -u[0], step = G.res / 2;
  for (let s = -L / 2; s <= L / 2 + 1e-9; s += step) for (let t = Math.min(a0, a1); t <= Math.max(a0, a1) + 1e-9; t += step) {
    const e = c[0] + u[0] * s + rx * t, n = c[1] + u[1] * s + ry * t;
    const i = Math.round((e + G.half) / G.res), j = Math.round((G.half - n) / G.res);
    if (i < 0 || j < 0 || i >= G.n || j >= G.n) continue;
    const v = occ[j * G.n + i]; if (v === 1 || (lanesToo && v === 2)) return true;
  }
  return false;
}
/**
 * Lay pontoons for a harbour without geometry. G = waterGrid around (h.lat, h.lon). → { pont: [[la0,lo0,la1,lo1,len,sides]],
 * gang: [[la0,lo0,la1,lo1]], synth: true } | { pending: true } (tiles not in memory yet) | { none: true } (no room on the water).
 */
export function synthPontoons(h, G, { avoid = [] } = {}) {
  if (h.tier === 'ferry') return { none: true };
  if (!G || G.known < MHG.KNOWN_MIN) return { pending: true };
  const need = synthNeeds(h), F = G.F, hw = MHG.HALF_W;
  const seed = gridAt(G, 0, 0) === 1 ? [0, 0] : nearestCell(G, 0, 0, 1, MHG.SEED_M);
  if (!seed) return { none: true };
  const cands = [], L = need.L, reach = L / 2 + need.zone + need.lane + hw;
  const D1 = distField(G, (v) => v === 1), D2 = distField(G, (v) => v === 1 || v === 4);   // to the nearest cell that is not water (/ not water or fairway)
  for (let n0 = -MHG.SEARCH_M; n0 <= MHG.SEARCH_M; n0 += MHG.STEP_M) for (let e0 = -MHG.SEARCH_M; e0 <= MHG.SEARCH_M; e0 += MHG.STEP_M) {
    if (Math.hypot(e0, n0) > MHG.SEARCH_M) continue;
    const c = [seed[0] + e0, seed[1] + n0];
    if (Math.abs(c[0]) + reach > G.half || Math.abs(c[1]) + reach > G.half || gridAt(G, c[0], c[1]) !== 1) continue;
    for (let d = 0; d < MHG.DIRS; d++) {
      const th = (d * 180) / MHG.DIRS, u = [Math.sin(th * D2R), Math.cos(th * D2R)];
      if (!bandClear(G, D1, c, u, L + 2, -hw - 0.6, hw + 0.6)) continue;
      const sides = [];
      for (const s of [1, -1]) {
        if (!bandClear(G, D1, c, u, L, s * (hw + 0.5), s * (hw + need.zone))) continue;
        if (bandClear(G, D2, c, u, L, s * (hw + need.zone), s * (hw + need.zone + need.lane))) sides.push(s);
      }
      if (!sides.length) continue;
      // the bank: the nearer end of the pontoon should reach it (a gangway); the score prefers rows close to the
      // harbour point, both sides usable (marinas), a short gangway
      const ends = [[c[0] - (u[0] * L) / 2, c[1] - (u[1] * L) / 2, (th + 180) % 360], [c[0] + (u[0] * L) / 2, c[1] + (u[1] * L) / 2, th]];
      const gaps = ends.map(([e, n, b]) => marchToBank(G, e, n, b, 45));
      const gap = Math.min(...gaps), root = gaps[0] <= gaps[1] ? 0 : 1;
      const score = (need.twoSided ? sides.length : 1) * L - 0.25 * Math.hypot(c[0], c[1]) - 0.8 * Math.min(gap, 45);
      cands.push({ c, u, th, sides, score, gap, root });
    }
  }
  if (!cands.length) return { none: true };
  cands.sort((a, b) => b.score - a.score || a.c[1] - b.c[1] || a.c[0] - b.c[0] || a.th - b.th);
  const occ = new Uint8Array(G.n * G.n), out = [], gang = [];
  // the neighbours' pontoons and box rows (harbours laid out before this one, OSM pontoons nearby) are taken
  for (const v of avoid) {
    const a = F.en(v[0], v[1]), b = F.en(v[2], v[3]), len = Math.hypot(b[0] - a[0], b[1] - a[1]); if (len < 1) continue;
    const u = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    markRect(G, occ, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], u, len + 4, -v[4], v[4], 1);
  }
  let sum = 0;
  for (const k of cands) {
    if (out.length >= need.count || sum >= need.total - 1) break;
    const sides = need.twoSided ? k.sides : [k.sides[0]];
    // deck + box bands must not touch earlier decks / boxes / lanes; the lane may share another row's lane
    if (hitsRect(G, occ, k.c, k.u, L + 4, -hw - 1, hw + 1, true)) continue;
    let bad = false;
    for (const s of sides) {
      if (hitsRect(G, occ, k.c, k.u, L, s * hw, s * (hw + need.zone), true) || hitsRect(G, occ, k.c, k.u, L, s * (hw + need.zone), s * (hw + need.zone + need.lane), false)) { bad = true; break; }
    }
    if (bad) continue;
    markRect(G, occ, k.c, k.u, L + 4, -hw - 1, hw + 1, 1);
    for (const s of sides) { markRect(G, occ, k.c, k.u, L, s * hw, s * (hw + need.zone), 1); markRect(G, occ, k.c, k.u, L, s * (hw + need.zone), s * (hw + need.zone + need.lane), 2); }
    let a = F.ll(k.c[0] - (k.u[0] * L) / 2, k.c[1] - (k.u[1] * L) / 2), b = F.ll(k.c[0] + (k.u[0] * L) / 2, k.c[1] + (k.u[1] * L) / 2);
    let sgn = sides.length === 2 ? 0 : sides[0];
    if (a[1] > b[1] || (a[1] === b[1] && a[0] > b[0])) { [a, b] = [b, a]; sgn = -sgn; }          // west → east like axisOf (right flips)
    out.push([r5(a[0]), r5(a[1]), r5(b[0]), r5(b[1]), L, sgn || 0]);
    sum += L;
    if (k.gap <= MHG.GANG_MAX_M) {
      const [e, n, brg] = k.root === 0 ? [k.c[0] - (k.u[0] * L) / 2, k.c[1] - (k.u[1] * L) / 2, (k.th + 180) % 360] : [k.c[0] + (k.u[0] * L) / 2, k.c[1] + (k.u[1] * L) / 2, k.th];
      const ue = Math.sin(brg * D2R), un = Math.cos(brg * D2R), g0 = F.ll(e, n), g1 = F.ll(e + ue * (k.gap + 3), n + un * (k.gap + 3));
      gang.push([r5(g0[0]), r5(g0[1]), r5(g1[0]), r5(g1[1])]);
    }
  }
  if (!out.length) return { none: true };
  return { pont: out.map((p) => (p[5] ? p : p.slice(0, 5))), gang, synth: true };
}
/** Lines a harbour's water use occupies for its neighbours' synthesis: [[la0, lo0, la1, lo1, half width m]] (deck + box rows). */
export function footprintOf(h) {
  if (!h?.pont?.length && !h?.quay?.length) return [];
  const zone = h.tier === 'marina' ? BOX_MAX[marinaSize(h.places, (h.pont || []).reduce((s, p) => s + p[4], 0))] + 1 : 11;
  return [...(h.pont || []).map((p) => [p[0], p[1], p[2], p[3], MHG.HALF_W + zone + 4]), ...(h.quay || []).map((q) => [q[0], q[1], q[2], q[3], 14])];
}
/**
 * OSM pontoons: which sides have room for boxes (the box band — box length + 1 m from 3 m off the axis — mostly water).
 * → the pontoon rows with a 6th field (1 / −1) where only one side does; unchanged rows otherwise (and when the grid is unknown).
 */
export function sideMask(h, G) {
  if (!G || G.known < MHG.KNOWN_MIN || h.tier !== 'marina' || !h.pont?.length) return h.pont || [];
  const order = h.pont.map((p, k) => ({ p, k })).sort((x, y) => y.p[4] - x.p[4] || x.p[0] - y.p[0] || x.p[1] - y.p[1]);
  const size = marinaSize(h.places, h.pont.reduce((s, p) => s + p[4], 0)), lens = new Map();
  order.forEach((o, i) => lens.set(o.k, boxLenFor(i, order.length, size)));
  return h.pont.map((p, k) => {
    const a = G.F.en(p[0], p[1]), b = G.F.en(p[2], p[3]), L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < 2) return p;
    const c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L], bl = lens.get(k);
    const ok = [1, -1].filter((s) => rectWater(G, c, u, L * 0.9, s * 3, s * (MHG.HALF_W + bl + 1)) >= MHG.SIDE_OK);
    return ok.length === 1 ? [...p.slice(0, 5), ok[0]] : p.slice(0, 5);
  });
}
/** The harbour-master hut: on the bank nearest the pontoon roots (6 m back from the water) → { lat, lon, hdg } | null. */
export function hutSpot(G, roots) {
  if (!G || G.known < MHG.KNOWN_MIN) return null;
  for (const r of roots) {
    const [e, n] = G.F.en(r[0], r[1]), land = nearestCell(G, e, n, 2, MHG.HUT_MAX_M); if (!land) continue;
    const d = Math.hypot(land[0] - e, land[1] - n) || 1, ue = (land[0] - e) / d, un = (land[1] - n) / d;
    let p = [land[0] + ue * 6, land[1] + un * 6]; if (gridAt(G, p[0], p[1]) !== 2) p = land;
    const ll = G.F.ll(p[0], p[1]);
    return { lat: r5(ll[0]), lon: r5(ll[1]), hdg: r1(bearingEN(-ue, -un)) };     // the door faces the water
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ geo record
/**
 * The compact geometry record the client gets (GET /api/mh/geo) and the server moors against. g = { pont, quay, gang,
 * synth, hut } overrides from synthesis / side masks (else the record's own). Deterministic.
 */
export function geoRecord(h, g = {}) {
  const pont = g.pont || h.pont || [], quay = g.quay || h.quay || [];
  const svc = servicesOf(h);
  const roots = [...pont.map((p) => [p[0], p[1]]), ...quay.map((q) => [q[0], q[1]])];
  let hut = g.hut || null;
  if (!hut && (h.tier === 'marina' || h.tier === 'passant')) {
    const r = roots[0] || [h.lat, h.lon], away = bearingLL([h.lat, h.lon], r);
    const p = moveLL(r, Number.isFinite(away) && (r[0] !== h.lat || r[1] !== h.lon) ? away : 0, 18);
    hut = { lat: r5(p[0]), lon: r5(p[1]), hdg: r1((away + 180) % 360) };
  }
  // fuel berth: at the outer end of the longest pontoon (marinas / fishing harbours with fuel; inland ports get trucks)
  let fuel = null;
  if (svc.fuel && h.tier !== 'inland_port' && pont.length) {
    const p = [...pont].sort((a, b) => b[4] - a[4] || a[0] - b[0])[0];
    const gang = g.gang || [], gd = (la, lo) => Math.min(...gang.map((x) => distM(la, lo, x[0], x[1])));
    const da = gang.length ? gd(p[0], p[1]) : distM(p[0], p[1], h.lat, h.lon), db = gang.length ? gd(p[2], p[3]) : distM(p[2], p[3], h.lat, h.lon);
    const end = da >= db ? [p[0], p[1]] : [p[2], p[3]], other = da >= db ? [p[2], p[3]] : [p[0], p[1]];
    fuel = { lat: r5(end[0]), lon: r5(end[1]), hdg: r1(bearingLL(other, end)) };
  }
  const sign = h.tier === 'passant' ? (h.cc === 'NL' ? 'Passantenhaven' : 'Visitor berths') : h.name;
  return {
    id: h.id, v: MHG.VERSION, name: h.name, tier: h.tier, lat: h.lat, lon: h.lon, cc: h.cc || null, places: h.places ?? null, cap: h.cap ?? null,
    pont, quay, gang: g.gang || [], hut, fuel, sign, synth: !!g.synth, est: h.e === 2 || !!g.synth, svc: h.svc || {},
    vhf: Number.isInteger(h.vhf) ? h.vhf : null, link: h.link || null, sub: h.sub || null, maxL: h.maxL ?? null, maxB: h.maxB ?? null, depth: h.depth ?? null, depthSrc: h.depthSrc ?? null, e: h.e,
  };
}

// ------------------------------------------------------------------------------------------------ layout (3D, radar, chart)
const parseBox = (id) => { const m = /#(\d+)([rl])(\d+)$/.exec(String(id)); return m ? { k: +m[1], side: m[2], j: +m[3] } : null; };
/**
 * Everything drawn for a harbour, in lat / lon (the client converts): { decks, fingers, piles, boxes, sides, quays, gang,
 * hut, fuel, berths }. Finger piers stand between every second pair of boxes (one finger serves two boats).
 */
export function layoutOf(geo, { limit = 800 } = {}) {
  const b = berthsOf(geo, { limit });
  const decks = (geo.pont || []).map((p) => ({ a: [p[0], p[1]], b: [p[2], p[3]], w: 2 * MHG.HALF_W, len: p[4] }));
  const quays = (geo.quay || []).map((q) => ({ a: [q[0], q[1]], b: [q[2], q[3]], w: 2 * MHG.QUAY_HALF_W, len: q[4] }));
  const fingers = [], piles = [], boxes = [], sides = [];
  const last = new Map();
  if (b.kind === 'box') for (const x of b.list) { const q = parseBox(x.id); if (q) { const key = `${q.k}${q.side}`; last.set(key, Math.max(last.get(key) || 0, q.j)); } }
  for (const x of b.list) {
    if (x.kind === 'box') {
      const q = parseBox(x.id); if (!q) continue;
      const along = (x.hdg + (q.side === 'r' ? -90 : 90) + 360) % 360;     // the pontoon direction a → b
      const inner = moveLL([x.lat, x.lon], (x.hdg + 180) % 360, x.len / 2), outer = moveLL([x.lat, x.lon], x.hdg, x.len / 2);
      const c = [moveLL(inner, along, -x.w / 2), moveLL(inner, along, x.w / 2), moveLL(outer, along, x.w / 2), moveLL(outer, along, -x.w / 2)];
      boxes.push({ id: x.id, no: x.no, len: x.len, w: x.w, lat: x.lat, lon: x.lon, hdg: x.hdg, c: c.map((p) => [r6(p[0]), r6(p[1])]) });
      const fLen = Math.max(4, x.len * MHG.FINGER_K);
      const finger = (p) => fingers.push({ a: [r6(p[0]), r6(p[1])], b: (() => { const e = moveLL(p, x.hdg, fLen); return [r6(e[0]), r6(e[1])]; })(), w: MHG.FINGER_W });
      if ((q.j - 1) % 2 === 0) finger(moveLL(inner, along, -x.w / 2));
      if (q.j === last.get(`${q.k}${q.side}`)) finger(moveLL(inner, along, x.w / 2));
      piles.push([r6(c[2][0]), r6(c[2][1])]);
      if (q.j === 1) piles.push([r6(c[3][0]), r6(c[3][1])]);
    } else if (x.a && x.b) sides.push({ id: x.id, a: x.a, b: x.b, lenM: x.lenM, places: x.places, raft: !!x.raft, src: x.src, side: x.side || 0 });
  }
  // guide piles every ~20 m along each pontoon (they hold the floating deck)
  for (const d of decks) {
    const n = Math.max(1, Math.round(d.len / 20)), brg = bearingLL(d.a, d.b);
    for (let i = 0; i <= n; i++) { const p = moveLL(d.a, brg, (d.len * i) / n); piles.push([r6(moveLL(p, brg + 90, MHG.HALF_W + 0.35)[0]), r6(moveLL(p, brg + 90, MHG.HALF_W + 0.35)[1])]); }
  }
  const gang = (geo.gang || []).map((g) => ({ a: [g[0], g[1]], b: [g[2], g[3]], w: 1.2 }));
  return { decks, fingers, piles, boxes, sides, quays, gang, hut: geo.hut || null, fuel: geo.fuel || null, berths: b };
}
/** Outlines for the radar, chart and the guidance plan: [{ a, b, w, k: 'deck' | 'finger' | 'quay' | 'gang' }]. */
export function segmentsOf(lay) {
  if (!lay) return [];
  return [...lay.quays.map((s) => ({ ...s, k: 'quay' })), ...lay.decks.map((s) => ({ ...s, k: 'deck' })), ...lay.gang.map((s) => ({ ...s, k: 'gang' })), ...lay.fingers.map((s) => ({ ...s, k: 'finger' }))];
}
/** Is a point on a pontoon / quay of the layout (radar mask, collisions)? → 'pontoon' | 'quay' | null. */
export function structureAt(lay, lat, lon, pad = 0) {
  if (!lay) return null;
  const k = mPerLon(lat);
  const on = (s) => {
    const ax = (s.a[1] - lon) * k, ay = (s.a[0] - lat) * M_LAT, bx = (s.b[1] - lon) * k, by = (s.b[0] - lat) * M_LAT;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, t = L2 > 0 ? clamp(-(ax * dx + ay * dy) / L2, 0, 1) : 0;
    return Math.hypot(ax + dx * t, ay + dy * t) <= s.w / 2 + pad;
  };
  for (const s of lay.quays) if (on(s)) return 'quay';
  for (const s of [...lay.decks, ...lay.fingers, ...lay.gang]) if (on(s)) return 'pontoon';
  return null;
}

// ------------------------------------------------------------------------------------------------ mooring rules
/** Ship dimensions from a SHIP_CLASSES row: { L, B, T, disp, yacht }. */
export const dimsOfClass = (C, yacht = null) => ({ L: C.length, B: C.beam, T: C.draft, disp: C.displacement ?? 0, yacht: yacht ?? (C.length <= 30) });
/**
 * Why a box does not take this ship now (null = it does). ctx: { depth: { m, src }, occupied: bool, money, fee }.
 * Order: taken → harbour limits → depth → box size.
 */
export function boxWhy(h, box, d, { depth = null, occupied = false } = {}) {
  if (occupied) return `Box ${box.no} is taken.`;
  if (Number.isFinite(h.maxL) && d.L > h.maxL) return `${h.name} takes boats up to ${h.maxL} m; you are ${r1(d.L)} m.`;
  if (Number.isFinite(h.maxB) && d.B > h.maxB) return `${h.name} takes up to ${h.maxB} m beam; yours is ${r1(d.B)} m.`;
  if (depth && depth.m < depthNeed(d.T, h.tier)) return `${depth.m} m${depth.src === 'est.' ? ' (est.)' : ''} in the harbour; you draw ${r1(d.T)} m.`;
  const f = boxFits(box, d);
  return f.ok ? null : `Box ${box.no}: ${f.why}.`;
}
/** Side berth (visitor quay, pontoon side): depth, length, rafting (passant: yachts ≤ 15 m up to 3 abreast). rafted = boats already there. */
export function sideWhy(h, berth, d, { depth = null, rafted = 0 } = {}) {
  if (depth && depth.m < depthNeed(d.T, h.tier)) return `${depth.m} m${depth.src === 'est.' ? ' (est.)' : ''} at the quay; you draw ${r1(d.T)} m.`;
  const f = sideFits(berth, d); if (!f.ok) return `${f.why}.`;
  const raft = berth.raft && d.yacht && d.L <= MH.RAFT_MAX_L ? MH.RAFT_ABREAST : 1;
  if (rafted >= raft) return raft > 1 ? `Already ${rafted} abreast here.` : 'Another ship lies there.';
  return null;
}
/**
 * Where the hull lies when moored. Box: bow at the pontoon (FENDER_M off the deck edge), stern toward the posts, along the
 * box axis → { lat, lon, hdg (the ship's heading, bow in), wb (bearing to open water, for casting off) }.
 * Side berth: see sideSlot.
 */
export function moorPoint(box, d) {
  const out = (box.hdg + 360) % 360;
  const p = moveLL([box.lat, box.lon], out, MHG.FENDER_M + d.L / 2 - box.len / 2);
  return { lat: r5(p[0]), lon: r5(p[1]), hdg: r1((out + 180) % 360), wb: r1(out) };
}
/**
 * Slot along a side berth for a ship at (lat, lon, hdg): projected on the line, clamped inside it, on the side the ship
 * is (or the berth's fixed side), off the face by half the pontoon / quay, the fender and half the beam (plus the beams
 * of boats rafted inside). → { lat, lon, hdg, wb, along }
 */
export function sideSlot(berth, ship, d, { rafted = [], quay = false } = {}) {
  const F = frameAt(berth.a[0], berth.a[1]), bb = F.en(berth.b[0], berth.b[1]), L = Math.hypot(bb[0], bb[1]) || 1;
  const u = [bb[0] / L, bb[1] / L], s = F.en(ship.lat, ship.lon);
  const along = clamp(s[0] * u[0] + s[1] * u[1], Math.min(L / 2, d.L / 2 + 1), Math.max(L / 2, L - d.L / 2 - 1));
  const lat = s[0] * u[1] - s[1] * u[0];                                   // > 0: right of a → b
  const side = berth.side || (lat >= 0 ? 1 : -1);
  const inside = rafted.reduce((t, r) => t + (Number(r.B) || 0) + 0.4, 0);
  const off = (quay ? MHG.QUAY_HALF_W : MHG.HALF_W) + MHG.FENDER_M + inside + d.B / 2;
  const e = u[0] * along + u[1] * off * side, n = u[1] * along - u[0] * off * side;
  const [la, lo] = F.ll(e, n), axis = bearingEN(u[0], u[1]);
  const hdg = Math.abs((((ship.hdg ?? axis) - axis + 540) % 360) - 180) <= 90 ? axis : (axis + 180) % 360;
  return { lat: r5(la), lon: r5(lo), hdg: r1(hdg), wb: r1((axis + (side > 0 ? 90 : 270)) % 360), along: r1(along), side };
}

// ------------------------------------------------------------------------------------------------ services
/** The services at a berth in this harbour: the minor harbour's own (by tier) on top of the named link's dock-anywhere tier. */
export function mhServices(h, linkTier = 'none') {
  const own = servicesOf(h), lay = layerServices(h, linkTier);
  return { tier: linkTier, water: own.water, power: own.power, fuel: lay.fuel, repair: lay.repair, repairYachtsOnly: !!own.repair?.yachtsOnly && lay.from.repair === 'minor', market: lay.market, from: lay.from, slipway: own.slipway, vhf: own.vhf };
}
/** The berth record fields a minor-harbour mooring carries (server/mhmoor.js), from the harbour and its named link. */
export function linkOf(h, named = []) {
  const n = h.link?.id ? named.find((x) => x.id === h.link.id) : null;
  const dKm = h.link?.dKm ?? null;
  return { harbor: n || null, dKm, tier: n ? serviceTier(n, dKm) : 'none' };
}
const WHAT = { market: 'The market', fuel: 'Fuel', repair: 'Repairs', service: 'The yard service', shipyard: 'The shipyard', office: 'The fleet office', jobs: 'The contract board', deliver: 'Contract delivery', shady: 'The back room', ashore: 'Going ashore' };
/** quayDenies for a minor-harbour berth: fuel / repairs / market from the harbour itself when it has them, the rest by the link tier. */
export function mhDenies(berth, service, harbourName = 'the harbour') {
  const s = berth?.svc;
  if (!berth?.mh || !s) return quayDenies(berth, service, harbourName);
  if (service === 'fuel') return s.fuel != null ? null : `${WHAT.fuel} is not sold at ${berth.mhName || 'this harbour'}.`;
  if (service === 'repair') {
    if (s.repair == null) return `${WHAT.repair} are not offered at ${berth.mhName || 'this harbour'}.`;
    if (s.repairYachtsOnly && berth.yacht === false) return `The yard at ${berth.mhName || 'this harbour'} only works on yachts.`;
    return null;
  }
  if (service === 'market') return s.market ? null : `${WHAT.market} is not available at ${berth.mhName || 'this harbour'}.`;
  return quayDenies(berth, service, harbourName);
}
/** Surcharge on a bill at a minor-harbour berth (the harbour's own fuel / repair multiplier, trucked goods from the named market). */
export function mhSurcharge(berth, service, amount) {
  const s = berth?.svc;
  if (!berth?.mh || !s) return quaySurcharge(berth?.tier, service, amount);
  const m = service === 'fuel' ? s.fuel : service === 'repair' ? s.repair : null;
  if (m != null) return m <= 1 ? 0 : Math.round(Math.abs(Number(amount) || 0) * (m - 1));
  if (service === 'market') return s.from?.market === 'named' ? quaySurcharge(berth.tier, service, amount) : 0;
  return quaySurcharge(berth.tier, service, amount);
}
/** Rows of the moored panel (public/js/quayfmt.js mooredModel): [{ id, label, ok, note }]. */
export function mhServiceRows(berth) {
  const s = berth?.svc || {}, t = SERVICE_TIERS[berth?.tier] || SERVICE_TIERS.none;
  const mul = (v) => (v > 1 ? ` (×${v})` : '');
  return [
    { id: 'water', label: 'Water & power', ok: !!(s.water || s.power), note: s.water && s.power ? 'on the pontoon' : s.water ? 'water only' : s.power ? 'power only' : 'not here' },
    { id: 'fuel', label: 'Fuel', ok: s.fuel != null, note: s.fuel == null ? 'not here' : s.from?.fuel === 'minor' ? (s.fuel > 1 ? `by truck${mul(s.fuel)}` : 'fuel berth') : s.fuel > 1 ? `by truck${mul(s.fuel)}` : 'from the harbour' },
    { id: 'repair', label: 'Repairs', ok: s.repair != null, note: s.repair == null ? 'not here' : s.from?.repair === 'minor' ? `${s.repairYachtsOnly ? 'yard (yachts)' : 'mobile crew'}${mul(s.repair)}` : s.repair > 1 ? `mobile crew${mul(s.repair)}` : 'the harbour yard' },
    { id: 'market', label: 'Market', ok: !!s.market, note: !s.market ? 'not here' : s.market === 'fish' ? 'fish only' : s.market === 'small' ? 'small inland market' : 'trucked from the harbour' },
    { id: 'office', label: 'Fleet office', ok: !!t.office, note: t.office ? 'by phone' : 'not here' },
    { id: 'jobs', label: 'Contracts', ok: !!t.jobs, note: t.jobs ? (t.deliver ? 'take and deliver' : 'take only — deliver at the harbour') : 'not here' },
  ];
}
/** Fee per night for a ship (shared/mharbour.js nightFee with the named link's size / tier for the quay-fee tiers). */
export function feeFor(h, d, link = null) { return nightFee(h, d, { power: true, link: link?.harbor ? { size: link.harbor.size, tier: link.tier } : null }); }
/** Tier word for messages. */
export const tierWord = (h) => (TIERS[h.tier]?.label || 'Harbour');
