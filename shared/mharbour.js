// Inland harbours and marinas everywhere (docs/BRIDGES-LOCKS-VHF-CONTRACT.md §7, lane D): the pure rules every side
// agrees on — which OSM / FIS feature is which kind of harbour (tier), how a z12 square's overlay becomes harbour records,
// marina boxes along pontoons, berth fit, fees per night, services per tier, the harbour master's VHF channel, the
// harbour card built on demand, the chart symbol and the 3D marker spec, the small inland market.
//
// Plain ESM, no DOM, no Node-only imports: the server (server/minorharbours.js), the client card / chart
// (public/js/mhchart.js) and the tests import it. Relative imports only.
//
// Record (≈ 1 KB, what server/minorharbours.js keeps in memory; berths are generated on demand from `pont` / `quay`):
//   { id: 'mh:osm:w123' | 'mh:fis:42', name, tier, lat, lon, src: 'osm'|'fis'|'fis+osm', e: 0|1|2, sq: 'x12/y12',
//     cc: 'NL'|null, places, cap, depth, depthSrc, maxL, maxB, maxT, vhf, vhfSim, svc: {…flags}, pont: [[la0,lo0,la1,lo1,lenM]],
//     quay: [[la0,lo0,la1,lo1,lenM]], sub: {id, name, dKm}|null, link: {id, dKm}|null, osm: [ids], fis: id|null, inferred? }
import { QUAY, SERVICE_TIERS, distM, serviceTier, linkHarbour } from './quayrules.js';
import { FEES } from './constants.js';

const D2R = Math.PI / 180, R2D = 180 / Math.PI, M_LAT = 111320;
const r1 = (v) => Math.round(v * 10) / 10;
const r5 = (v) => Math.round(v * 1e5) / 1e5;

export const MH = {
  VERSION: 1,
  MAX_IN_MEMORY: 3000,       // harbours kept (server LRU, §7.2)
  NEAR_KM: 25,               // squares pulled around each ship
  MERGE_M: 150,              // seeds of one harbour / FIS ↔ OSM duplicates
  ATTACH_M: 250,             // pontoons, piers and quays that belong to a harbour seed
  SERVICE_M: 300,            // fuel, water, slipway… nodes that belong to the nearest harbour
  CLUSTER_M: 120,            // pontoons this close form one (inferred) marina
  CLUSTER_MIN: 3, CLUSTER_MIN_PONTOONS: 2, CLUSTER_MIN_LEN_M: 150,
  POOL_MAX_LEN_M: 400,       // a pier longer than this is a jetty / mole, not a berth pontoon
  MAX_PONTOONS: 24,          // pontoon axes kept per harbour record
  MAX_QUAYS: 8,
  BOXES: [[8, 3.0], [10, 3.5], [12, 4.0], [15, 4.5], [20, 5.5]],   // box length → box width (m)
  BOX_L_TOL: 1.5, BOX_W_TOL: 0.4,                                     // L ≤ box + 1.5, B ≤ boxW − 0.4
  PONTOON_HALF_W: 1.2,
  RAFT_MAX_L: 15, RAFT_ABREAST: 3, RAFT_SLOT_M: 12,                  // passant: yachts ≤ 15 m raft up to 3 abreast
  PASSANT_MAX_PLACES: 20,
  DEPTH: { marina: 2.0, passant: 1.8, city: 2.5, inland_port: 3.5, fishing: 3.0, ferry: null },   // §3.6 (inland_port: CEMT Va draught unless the waterway says)
  FEE: { marina: 1.6, passant: 1.2, city: 1.0, fishing: 0.8 }, POWER_CR: 3,
  FUEL_TRUCK_MUL: 1.08, MOBILE_REPAIR_MUL: 1.25, YACHT_REPAIR_MUL: 1.3,
  VHF_SIM: { NL: 31, other: 9 },
  CHART_MIN_ZOOM: 11, CHART_MAX_ROWS: 400,
  REACH_TTL_S: 600,
  BOARD_MAX: { marina: 4, passant: 2, inland_port: 6, fishing: 0, city: 0, ferry: 0 },
  MARKET_SPREAD: 0.06, MARKET_STOCK_FRAC: 0.1, MARKET_GOODS: [3, 5],
};

/** Tiers (§7.3) with their words, chart symbol and harbour-sheet tabs. */
export const TIERS = Object.freeze({
  marina: { id: 'marina', label: 'Marina', nl: 'Jachthaven', sym: 'marina', rank: 5, tabs: ['overview', 'berths', 'services', 'jobs', 'weather'] },
  passant: { id: 'passant', label: 'Visitor harbour', nl: 'Passantenhaven', sym: 'passant', rank: 4, tabs: ['overview', 'berths', 'services', 'weather'] },
  city: { id: 'city', label: 'City quay', nl: 'Stadshaven', sym: 'city', rank: 2, tabs: ['overview', 'berths', 'weather'] },
  inland_port: { id: 'inland_port', label: 'Inland port', nl: 'Binnenhaven', sym: 'anchor', rank: 3, tabs: ['overview', 'berths', 'services', 'market', 'jobs', 'weather'] },
  fishing: { id: 'fishing', label: 'Fishing harbour', nl: 'Vissershaven', sym: 'fish', rank: 1, tabs: ['overview', 'berths', 'services', 'market', 'weather'] },
  ferry: { id: 'ferry', label: 'Ferry terminal', nl: 'Veerhaven', sym: 'ferry', rank: 0, tabs: ['overview'] },
});
export const TIER_IDS = Object.freeze(Object.keys(TIERS));

// ------------------------------------------------------------------------------------------------ classification
const COMMERCIAL_CATS = /^(container|bulk|tanker|roro|timber|cargo|industrial|lng|oil|passenger|port|harbour_master)$/;
const SERVICE_KEYS = { fuel_station: 'fuel', water_tap: 'water', electricity: 'power', slipway: 'slipway', toilets: 'toilets', showers: 'showers',
  boatyard: 'boatyard', chandler: 'chandler', sailmaker: 'sailmaker', laundrette: 'laundry', pump_out: 'pumpout', boat_hoist: 'hoist', visitor_berth: 'visitor' };
const list = (v) => String(v ?? '').split(';').map((s) => s.trim()).filter(Boolean);

/**
 * Tier of one tagged feature (§7.3) → { tier, why } | null. ctx: { places (FIS / capacity), townKm (to the nearest town
 * centre, when known) }. Pure tag rules; pontoon clusters without tags are inferred in harboursFromOverlay.
 */
export function classifyTags(t = {}, ctx = {}) {
  const sm = t['seamark:type'] || '', cat = list(t['seamark:harbour:category'] || t['harbour:category']), sc = list(t['seamark:small_craft_facility:category']);
  const places = Number(ctx.places ?? t.capacity);
  if (t.leisure === 'marina') {
    if (Number.isFinite(places) && places > 0 && places <= MH.PASSANT_MAX_PLACES && (t.mooring === 'visitor' || sc.includes('visitor_berth'))) return { tier: 'passant', why: 'leisure=marina, ≤ 20 visitor places' };
    return { tier: 'marina', why: 'leisure=marina' };
  }
  if (cat.some((c) => c.startsWith('marina'))) return { tier: 'marina', why: `harbour category ${cat.find((c) => c.startsWith('marina'))}` };
  if (cat.includes('fishing')) return { tier: 'fishing', why: 'harbour category fishing' };
  if (cat.includes('ferry_terminal')) return { tier: 'ferry', why: 'harbour category ferry_terminal' };
  if (cat.some((c) => COMMERCIAL_CATS.test(c))) return { tier: 'inland_port', why: `harbour category ${cat.find((c) => COMMERCIAL_CATS.test(c))}` };
  if (t.landuse === 'port' || t.industrial === 'port') return { tier: 'inland_port', why: `${t.landuse === 'port' ? 'landuse' : 'industrial'}=port` };
  if (sc.includes('visitor_berth') || t.mooring === 'visitor' || t.mooring === 'guest') return { tier: 'passant', why: sc.includes('visitor_berth') ? 'small craft visitor berth' : `mooring=${t.mooring}` };
  if (t.mooring === 'commercial') return { tier: 'inland_port', why: 'mooring=commercial' };
  if (t.mooring && !['private', 'no', 'waiting', 'ferry'].includes(t.mooring)) {
    return Number.isFinite(ctx.townKm) && ctx.townKm <= 1 ? { tier: 'city', why: `mooring=${t.mooring} in town` } : { tier: 'passant', why: `mooring=${t.mooring}` };
  }
  if (t.harbour === 'yes') return Number.isFinite(ctx.townKm) && ctx.townKm <= 1 ? { tier: 'city', why: 'harbour=yes in town' } : { tier: 'passant', why: 'harbour=yes' };
  if (sm === 'harbour') return { tier: 'passant', why: 'seamark harbour (no category)' };
  return null;
}
/** Tier of a FIS tourist harbour (§7.3): > 20 places → marina, else passantenhaven. */
export function classifyFis(f = {}) {
  const places = fisPlaces(f);
  if (f.kind === 'terminal' || f.commercial) return { tier: 'inland_port', why: 'FIS terminal' };
  if (places > MH.PASSANT_MAX_PLACES) return { tier: 'marina', why: `FIS tourist harbour, ${places} places` };
  return { tier: 'passant', why: `FIS tourist harbour${places ? `, ${places} places` : ''}` };
}
/** Places of a FIS harbour record ({ places } | lane A's { long, short }). */
export function fisPlaces(f = {}) {
  if (Number.isFinite(f.places)) return f.places;
  const n = (Number(f.long) || 0) + (Number(f.short) || 0);
  return n;
}
/** Service flags a tagged feature adds to its harbour (fuel, water, power, slipway, boatyard …). */
export function serviceFlags(t = {}) {
  const out = {};
  for (const c of list(t['seamark:small_craft_facility:category'])) if (SERVICE_KEYS[c]) out[SERVICE_KEYS[c]] = true;
  if (t.waterway === 'fuel' || t.amenity === 'fuel' && t.boat === 'yes') out.fuel = true;
  if (t.leisure === 'slipway') out.slipway = true;
  if (t.amenity === 'drinking_water' || t.drinking_water === 'yes') out.water = true;
  if (t.power_supply === 'yes' || t['power_supply'] === 'yes') out.power = true;
  if (t.craft === 'boatbuilder' || t.shop === 'boat') out.boatyard = true;
  return out;
}
/** Marine VHF channel from tags (`vhf`, `seamark:radio_station:channel`, `communication:vhf`) → integer | null (16 is skipped when another is given). */
export function parseVhf(t = {}) {
  const raw = [t.vhf, t['seamark:radio_station:channel'], t['communication:vhf'], t['vhf:channel']].filter((v) => v != null).join(';');
  const chs = (raw.match(/\d{1,2}/g) || []).map(Number).filter((c) => (c >= 1 && c <= 28) || c === 31 || (c >= 60 && c <= 88));   // 31: NL marinas
  if (!chs.length) return null;
  return chs.find((c) => c !== 16 && c !== 70) ?? chs[0];
}

// ------------------------------------------------------------------------------------------------ geometry helpers
const mPerLon = (lat) => M_LAT * Math.cos(lat * D2R);
function pts(g) { const out = []; for (let i = 0; i + 1 < (g?.length || 0); i += 2) out.push([g[i], g[i + 1]]); return out; }
/** Centroid of a compact overlay geometry (vertex mean; a node is itself). */
export function centroidOf(g) {
  const p = pts(g); if (!p.length) return null;
  let a = 0, b = 0; for (const [la, lo] of p) { a += la; b += lo; }
  return { lat: a / p.length, lon: b / p.length };
}
/** The feature's long axis: the two vertices farthest apart → { a: [lat, lon], b, lenM }. */
export function axisOf(g) {
  const p = pts(g); if (p.length < 2) return null;
  let best = null, bd = -1;
  for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) { const d = distM(p[i][0], p[i][1], p[j][0], p[j][1]); if (d > bd + 1e-9) { bd = d; best = [p[i], p[j]]; } }
  // deterministic orientation: west → east (then south → north)
  if (best[0][1] > best[1][1] || (best[0][1] === best[1][1] && best[0][0] > best[1][0])) best.reverse();
  return { a: best[0], b: best[1], lenM: bd };
}
/** Polyline length (m) of an open feature, perimeter of a closed one. */
export function lengthOf(g, closed = false) {
  const p = pts(g); let L = 0;
  for (let i = 1; i < p.length; i++) L += distM(p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]);
  if (closed && p.length > 2) L += distM(p[p.length - 1][0], p[p.length - 1][1], p[0][0], p[0][1]);
  return L;
}
function inRingLL(g, lat, lon) {
  const p = pts(g); let c = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [yi, xi] = p[i], [yj, xj] = p[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
/** Point `along` metres from a toward b and `off` metres to the right (looking a → b). */
export function offsetPoint(a, b, along, off) {
  const k = mPerLon(a[0]), E = (b[1] - a[1]) * k, N = (b[0] - a[0]) * M_LAT, L = Math.hypot(E, N) || 1;
  const ux = E / L, uy = N / L, rx = uy, ry = -ux;                // right of (ux, uy) in (east, north)
  const e = ux * along + rx * off, n = uy * along + ry * off;
  return [a[0] + n / M_LAT, a[1] + e / k];
}
const bearingOf = (a, b) => { const k = mPerLon(a[0]); return (Math.atan2((b[1] - a[1]) * k, (b[0] - a[0]) * M_LAT) * R2D + 360) % 360; };

/** Rough Netherlands outline (land + inland waters) for the NL-only rules (marina channel 31, FIS). */
const NL_RING = [51.37, 3.36, 51.27, 3.80, 51.21, 4.29, 51.50, 4.50, 51.43, 5.00, 51.26, 5.07, 51.31, 5.55, 51.15, 5.85, 50.75, 5.64, 50.76, 6.02, 50.97, 5.92, 51.10, 6.17, 51.25, 6.07, 51.50, 6.22, 51.84, 5.96, 51.84, 6.40, 51.97, 6.83, 52.24, 7.06, 52.65, 7.06, 53.19, 7.22, 53.35, 7.10, 53.60, 6.60, 53.55, 5.00, 53.30, 4.65, 52.90, 4.55, 52.40, 4.45, 52.00, 3.95, 51.70, 3.55, 51.37, 3.36];
export function inNL(lat, lon) { return inRingLL(NL_RING, lat, lon); }

// ------------------------------------------------------------------------------------------------ marina boxes
/** Box width (m) for a box length (§7.3 table: 8/10/12/15/20 → 3.0/3.5/4.0/4.5/5.5); in between → the next size up. */
export function boxWidth(len) { for (const [l, w] of MH.BOXES) if (len <= l + 1e-9) return w; return MH.BOXES[MH.BOXES.length - 1][1]; }
/** Boxes along a pontoon of `lenM` with box length `boxLen`, on `sides` sides: sides × floor(lenM / boxW). */
export function boxesAlong(lenM, boxLen, sides = 2) { return sides * Math.floor((lenM + 1e-9) / boxWidth(boxLen)); }
/** Marina size class from its place count (or its total pontoon length when the count is unknown). */
export function marinaSize(places, pontoonM = 0) {
  const n = Number.isFinite(places) && places > 0 ? places : pontoonM / 4.0 * 2;
  return n < 60 ? 'small' : n < 250 ? 'medium' : 'large';
}
const BOX_SETS = { small: [8, 10, 12], medium: [10, 12, 15], large: [10, 12, 15, 20] };
/** Box length for pontoon k of n (pontoons sorted longest first: the longest pontoons get the biggest boxes). */
export function boxLenFor(k, n, size = 'medium') {
  const s = BOX_SETS[size] || BOX_SETS.medium;
  const i = Math.min(s.length - 1, Math.floor((k * s.length) / Math.max(1, n)));
  return s[s.length - 1 - i];
}
/** Pontoon axes of a harbour sorted longest first (ties by position): [{ a, b, lenM, k }]. */
function pontoonsOf(h) {
  return (h.pont || []).map((p, k) => ({ a: [p[0], p[1]], b: [p[2], p[3]], lenM: p[4], k })).sort((x, y) => y.lenM - x.lenM || x.a[0] - y.a[0] || x.a[1] - y.a[1]);
}
/**
 * The berths of a harbour, generated on demand (deterministic). Marina: numbered boxes on both sides of each pontoon.
 * Passant / city / fishing / inland_port: quay and pontoon sides (`kind: 'side'`, first come first served).
 * opts.limit caps the list (the count is always exact). → { kind, total, list: [Berth], sizes: [{len, w, n}] }
 */
export function berthsOf(h, { limit = 600 } = {}) {
  const out = []; let total = 0;
  // no geometry yet (FIS-only harbour, pontoons not in the overlay): the place count spread over the size class's boxes
  // (marina) or one virtual visitor quay (passant) — counts only, no positions (est.)
  if (!(h.pont?.length) && !(h.quay?.length) && Number(h.places) > 0 && (h.tier === 'marina' || h.tier === 'passant')) {
    const n = Math.round(Number(h.places));
    if (h.tier === 'passant') return { kind: 'side', total: n, list: [{ id: `${h.id}#v`, kind: 'side', src: 'places', lenM: Math.ceil(n / MH.RAFT_ABREAST) * MH.RAFT_SLOT_M, places: n, raft: true, lat: h.lat, lon: h.lon, hdg: 0, est: true }], sizes: [], est: true };
    const set = BOX_SETS[marinaSize(n)], per = Math.floor(n / set.length), sizes = set.map((len) => ({ len, w: boxWidth(len), n: per }));
    sizes[Math.floor(set.length / 2)].n += n - per * set.length;
    return { kind: 'box', total: n, list: [], sizes: sizes.filter((x) => x.n > 0), est: true };
  }
  if (h.tier === 'marina') {
    const ps = pontoonsOf(h), size = marinaSize(h.places, ps.reduce((s, p) => s + p.lenM, 0)), sizes = new Map();
    ps.forEach((p, k) => {
      const len = boxLenFor(k, ps.length, size), w = boxWidth(len), n = Math.floor((p.lenM + 1e-9) / w);
      for (const side of [1, -1]) {
        for (let j = 0; j < n; j++) {
          total++;
          sizes.set(len, (sizes.get(len) || 0) + 1);
          if (out.length >= limit) continue;
          const along = (j + 0.5) * w, off = side * (MH.PONTOON_HALF_W + len / 2);
          const c = offsetPoint(p.a, p.b, along, off), post = offsetPoint(p.a, p.b, (j + 1) * w, side * (MH.PONTOON_HALF_W + len));
          const hdg = (bearingOf(p.a, p.b) + (side > 0 ? 90 : 270)) % 360;
          out.push({ id: `${h.id}#${p.k}${side > 0 ? 'r' : 'l'}${j + 1}`, no: total, kind: 'box', len, w, lat: r5(c[0]), lon: r5(c[1]), hdg: r1(hdg), post: [r5(post[0]), r5(post[1])] });
        }
      }
    });
    return { kind: 'box', total, list: out, sizes: [...sizes.entries()].sort((a, b) => a[0] - b[0]).map(([len, n]) => ({ len, w: boxWidth(len), n })) };
  }
  const sides = [...(h.quay || []).map((q, k) => ({ q, k, src: 'quay' })), ...(h.pont || []).map((q, k) => ({ q, k, src: 'pont' }))];
  for (const { q, k, src } of sides) {
    const lenM = q[4], rafts = h.tier === 'passant' ? MH.RAFT_ABREAST : 1;
    const places = Math.max(1, Math.floor(lenM / MH.RAFT_SLOT_M)) * rafts;
    total += places;
    if (out.length < limit) out.push({ id: `${h.id}#${src[0]}${k}`, kind: 'side', src, lenM: r1(lenM), places, raft: h.tier === 'passant', lat: r5((q[0] + q[2]) / 2), lon: r5((q[1] + q[3]) / 2), hdg: r1(bearingOf([q[0], q[1]], [q[2], q[3]])) });
  }
  return { kind: 'side', total, list: out, sizes: [] };
}

// ------------------------------------------------------------------------------------------------ fit
/**
 * Under-keel clearance alongside: the shared/quayrules.js ukc (5 %, ≥ 0.3 m) at quays; in the sheltered, soft-bottomed
 * small-craft basins (marina, passant) 5 %, ≥ 0.1 m — Game rule, so a 1.9 m sloop lies in a 2.0 m (est.) marina.
 */
export const SMALL_CRAFT_TIERS = new Set(['marina', 'passant']);
export const ukcFor = (T, tier = null) => (SMALL_CRAFT_TIERS.has(tier) ? Math.max(0.1, 0.05 * T) : Math.max(0.3, 0.05 * T));
/** Depth a hull of draught T needs (= quayrules neededDepth for the same draught at a quay). */
export const depthNeed = (T, tier = null) => r1(T + ukcFor(T, tier));
/** Quay length a hull of length L needs (= quayrules neededLength). */
export const lengthNeed = (L) => Math.round(L + Math.max(10, 0.1 * L));
/** Box fit (§7.4): L ≤ box + 1.5, B ≤ boxW − 0.4. → { ok, why } */
export function boxFits(box, d) {
  if (d.L > box.len + MH.BOX_L_TOL) return { ok: false, why: `${box.len} m boxes; you are ${r1(d.L)} m long` };
  if (d.B > box.w - MH.BOX_W_TOL) return { ok: false, why: `${box.w} m wide boxes; your beam is ${r1(d.B)} m` };
  return { ok: true, why: null };
}
/** Side berth fit: length (rafting yachts ≤ 15 m count one slot) and the needed quay length. */
export function sideFits(berth, d) {
  if (berth.raft && d.yacht && d.L <= MH.RAFT_MAX_L) return { ok: true, why: null };
  const need = lengthNeed(d.L);
  return need <= berth.lenM ? { ok: true, why: null } : { ok: false, why: `${Math.round(berth.lenM)} m of quay; you need ${need} m` };
}
/**
 * Harbour depth for the card (§3.6): data tag / FIS > tier default, except that the sampled chart depth (D14 tiles, at
 * low water) wins when it is DEEPER than the default — the z9 bathymetry under small basins is too coarse to trust
 * when it is shallower (Game rule). → { m, src }
 */
export function depthOf(h, { sampled = null, cemtT = null } = {}) {
  if (Number.isFinite(h.depth)) return { m: h.depth, src: h.depthSrc || 'data' };
  const def = h.tier === 'inland_port' && Number.isFinite(cemtT) ? cemtT : MH.DEPTH[h.tier] ?? 2.0;
  if (Number.isFinite(sampled) && sampled > def) return { m: r1(sampled), src: 'chart' };
  return { m: def, src: h.tier === 'inland_port' && Number.isFinite(cemtT) ? 'waterway class' : 'est.' };
}
/**
 * Fit summary of a whole harbour for one ship (the card's "berths" line):
 * { fits, total, depthOk, depth, why, best } — fits = berths that take her (0 when the depth or a harbour limit refuses).
 */
export function fitSummary(h, d, { depth = null, berths = null } = {}) {
  const dep = depth || depthOf(h);
  const b = berths || berthsOf(h, { limit: 4000 });
  const need = depthNeed(d.T, h.tier);
  if (Number.isFinite(h.maxL) && d.L > h.maxL) return { fits: 0, total: b.total, depthOk: true, depth: dep, why: `Harbour takes up to ${h.maxL} m; you are ${r1(d.L)} m`, best: null };
  if (Number.isFinite(h.maxB) && d.B > h.maxB) return { fits: 0, total: b.total, depthOk: true, depth: dep, why: `Harbour takes up to ${h.maxB} m beam; yours is ${r1(d.B)} m`, best: null };
  if (dep.m < need) return { fits: 0, total: b.total, depthOk: false, depth: dep, why: `${dep.m} m ${dep.src === 'est.' ? '(est.) ' : ''}in the harbour; you need ${need} m`, best: null };
  let fits = 0, best = null, why = null;
  if (b.kind === 'box') {
    for (const s of b.sizes) { const f = boxFits({ len: s.len, w: s.w }, d); if (f.ok) { fits += s.n; if (!best || s.len < best.len) best = s; } else why = why || f.why; }
  } else {
    for (const s of b.list) { const f = sideFits(s, d); if (f.ok) { fits += s.places; if (!best || s.lenM < best.lenM) best = s; } else why = why || f.why; }
    if (!b.list.length) why = 'No berth geometry known yet (est.)';
  }
  if (!b.total) why = 'No berth geometry known yet (est.)';
  return { fits, total: b.total, depthOk: true, depth: dep, why: fits ? null : why, best };
}

// ------------------------------------------------------------------------------------------------ fees
/** Dock-anywhere quay fee from a displacement (= quayrules quayFeePerDay for a class of that displacement). */
export function quayFeeFromDisp(disp, quayCls, { size = null, tier = 'none' } = {}) {
  const cm = QUAY.CLASS_MUL[quayCls] ?? QUAY.CLASS_MUL.quay, pm = tier === 'port' ? QUAY.PORT_MUL[size] ?? 1 : QUAY.OUTSIDE_PORT_MUL;
  return Math.max(QUAY.MIN_FEE, Math.round(Math.round(disp * FEES.BERTH_PER_T_DAY) * cm * pm));
}
/**
 * Fee per night (§7.5). d = { L, disp, yacht }. marina 1.6 cr/m + 3 power; passant 1.2 cr/m (+ power if the harbour has it);
 * city 1.0 cr/m for yachts, the city-quay fee for ships; inland_port the industrial-quay fee; fishing 0.8 cr/m.
 * → { perNight, power, basis }
 */
export function nightFee(h, d, { power = true, link = null } = {}) {
  const tier = h.tier, svc = h.svc || {};
  const pw = (on) => (on ? MH.POWER_CR : 0);
  switch (tier) {
    case 'marina': { const p = pw(power); return { perNight: Math.round(MH.FEE.marina * d.L + p), power: p, basis: `${MH.FEE.marina} cr per metre${p ? ` + ${p} cr power` : ''}` }; }
    case 'passant': { const p = pw(power && !!svc.power); return { perNight: Math.round(MH.FEE.passant * d.L + p), power: p, basis: `${MH.FEE.passant} cr per metre${p ? ` + ${p} cr power` : ''}` }; }
    case 'city': if (d.yacht) return { perNight: Math.round(MH.FEE.city * d.L), power: 0, basis: `${MH.FEE.city} cr per metre` };
      return { perNight: quayFeeFromDisp(d.disp, 'city', link || {}), power: 0, basis: 'city quay fee' };
    case 'fishing': return { perNight: Math.round(MH.FEE.fishing * d.L), power: 0, basis: `${MH.FEE.fishing} cr per metre` };
    case 'inland_port': return { perNight: quayFeeFromDisp(d.disp, 'industrial', link || {}), power: 0, basis: 'quay fee (dock anywhere)' };
    default: return { perNight: 0, power: 0, basis: 'no berths' };
  }
}

// ------------------------------------------------------------------------------------------------ services
/** Harbour-master channel: data, else simulated (NL marinas ch 31, marinas abroad ch 9, Q12); none for other tiers without data. */
export function vhfOf(h) {
  if (Number.isInteger(h.vhf)) return { ch: h.vhf, sim: false };
  if (h.tier === 'marina') return { ch: h.cc === 'NL' ? MH.VHF_SIM.NL : MH.VHF_SIM.other, sim: true };
  return { ch: null, sim: false };
}
/**
 * Services of a minor harbour by tier (§7.5) → { water, power, fuel, fuelMul, market: 'small'|'fish'|null, repair: { mul, yachtsOnly }|null,
 * shipyard: false, slipway, … , vhf }.
 */
export function servicesOf(h) {
  const f = h.svc || {}, v = vhfOf(h);
  const base = { water: false, power: false, fuel: false, fuelMul: null, market: null, repair: null, shipyard: false, slipway: !!f.slipway, toilets: !!f.toilets, showers: !!f.showers, chandler: !!f.chandler, sailmaker: !!f.sailmaker, pumpout: !!f.pumpout, vhf: v.ch, vhfSim: v.sim };
  switch (h.tier) {
    case 'marina': return { ...base, water: true, power: true, fuel: !!f.fuel, fuelMul: f.fuel ? 1 : null, repair: f.boatyard ? { mul: MH.YACHT_REPAIR_MUL, yachtsOnly: true } : null };
    case 'passant': return { ...base, water: !!f.water, power: !!f.power };
    case 'city': return { ...base };
    case 'inland_port': return { ...base, fuel: true, fuelMul: MH.FUEL_TRUCK_MUL, market: 'small', repair: { mul: MH.MOBILE_REPAIR_MUL, yachtsOnly: false } };
    case 'fishing': return { ...base, water: true, fuel: true, fuelMul: 1, market: 'fish', repair: { mul: MH.MOBILE_REPAIR_MUL, yachtsOnly: false } };
    default: return { ...base };
  }
}
/**
 * The services layer at a berth (§7.5): a minor harbour's own services on top of the named harbour's dock-anywhere tier;
 * per service the better of the two applies. quayTier = serviceTier of the named link ('port'|'near'|'remote'|'none').
 * → { fuel: mul|null, repair: mul|null, market: 'harbour'|'small'|'fish'|null, shipyard, office, jobs, from: {fuel, repair, market} }
 */
export function layerServices(minor, quayTier = 'none') {
  const t = SERVICE_TIERS[quayTier] || SERVICE_TIERS.none, s = minor ? servicesOf(minor) : null;
  const pick = (a, b) => (a == null ? b : b == null ? a : Math.min(a, b));
  const fuel = pick(s?.fuel ? s.fuelMul : null, Number.isFinite(t.fuel) ? t.fuel : null);
  const repair = pick(s?.repair ? s.repair.mul : null, Number.isFinite(t.repair) ? t.repair : null);
  const named = Number.isFinite(t.market) ? t.market : null;
  const market = named != null ? 'harbour' : s?.market || null;
  return {
    fuel, repair, market, shipyard: !!t.shipyard, office: !!t.office, jobs: !!t.jobs || (s && (MH.BOARD_MAX[minor.tier] || 0) > 0),
    from: { fuel: fuel == null ? null : s?.fuel && s.fuelMul === fuel ? 'minor' : 'named', repair: repair == null ? null : s?.repair && s.repair.mul === repair ? 'minor' : 'named', market: named != null ? 'named' : s?.market ? 'minor' : null },
  };
}

// ------------------------------------------------------------------------------------------------ names, links
/** Display name (§7.3): OSM name, else FIS name, else "{town} {tier word}", else "{tier word} near {nearest named harbour}". */
export function nameFor(h, { town = null, near = null } = {}) {
  if (h.name) return h.name;
  const word = TIERS[h.tier]?.label || 'Harbour';
  if (town) return `${town} ${word.toLowerCase()}`;
  if (near) return `${word} near ${String(near).split(/\s[(/]/)[0]}`;
  return word;
}
/** Sub-harbour link (§7.5): the nearest named harbour, and whether this one lies inside its port limits. */
export function subOf(lat, lon, named = []) {
  const l = linkHarbour(named, lat, lon);
  if (!l) return { sub: null, link: null };
  const lim = QUAY.PORT_RADIUS_KM[l.harbor.size] || 3;
  const link = { id: l.harbor.id, name: l.harbor.name, dKm: l.dKm, size: l.harbor.size, tier: serviceTier(l.harbor, l.dKm) };
  return { sub: l.dKm <= lim ? { id: l.harbor.id, name: l.harbor.name, dKm: l.dKm } : null, link };
}

// ------------------------------------------------------------------------------------------------ overlay → records
const POOL_KINDS = new Set(['pontoon', 'pier']);
/** Named landing stages that are ferry / terminal pontoons: they never make an inferred marina. */
const FERRY_NAME = /ferry|f[äa]hr|veer|anleger(?!.*yacht)|terminal|hhla|bus/i;
function isHulk(t) { return t['seamark:type'] === 'hulk'; }
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
function lineRec(ax) { return [r5(ax.a[0]), r5(ax.a[1]), r5(ax.b[0]), r5(ax.b[1]), r1(ax.lenM)]; }
function union(n) { const p = Array.from({ length: n }, (_, i) => i); const f = (i) => (p[i] === i ? i : (p[i] = f(p[i]))); return { find: f, join: (a, b) => { const x = f(a), y = f(b); if (x !== y) p[Math.max(x, y)] = Math.min(x, y); } }; }

/**
 * Harbour records of one z12 square from its compact overlay (server/wtsource.js compactOverlay, v1 or v2) and the
 * FIS tourist harbours that fall in it. Deterministic (sorted by feature id). ctx:
 *   { x12, y12 (keep only harbours whose centre lies in this square; omit to keep all), fis: [FIS harbour],
 *     named: HARBORS (sub-harbour links), townAt(lat, lon) → { name, km } | null }
 */
export function harboursFromOverlay(ov, ctx = {}) {
  const feats = [...(ov?.f || [])].sort(byId);
  const seeds = [], pool = [], quays = [], services = [];
  for (const f of feats) {
    const t = f.t || {}, c = centroidOf(f.g); if (!c) continue;
    const town = ctx.townAt ? safe(() => ctx.townAt(c.lat, c.lon)) : null;
    const cl = classifyTags(t, { townKm: town?.km });
    const sv = serviceFlags(t);
    const isPool = POOL_KINDS.has(f.k) && !isHulk(t) && pts(f.g).length >= 2;
    const ax = isPool ? axisOf(f.g) : null;
    if (cl) seeds.push({ f, c, ...cl, ring: f.c === 1 ? f.g : null, town });
    if (isPool && ax && ax.lenM >= 6 && ax.lenM <= MH.POOL_MAX_LEN_M) pool.push({ f, c, ax, pontoon: f.k === 'pontoon' });
    if (f.k === 'quay' && pts(f.g).length >= 2) { const a = axisOf(f.g); if (a && a.lenM >= 15) quays.push({ f, c, ax: a }); }
    if (Object.keys(sv).length) services.push({ f, c, sv });
  }
  // 1. seeds → harbours (seeds within MERGE_M merge; the higher-ranked tier wins, then the lower feature id)
  const hs = [];
  for (const s of seeds) {
    let h = hs.find((x) => distM(x.lat, x.lon, s.c.lat, s.c.lon) <= MH.MERGE_M || (x.ring && inRingLL(x.ring, s.c.lat, s.c.lon)) || (s.ring && inRingLL(s.ring, x.lat, x.lon)));
    if (!h) { hs.push(h = { seeds: [], lat: s.c.lat, lon: s.c.lon, tier: s.tier, why: s.why, ring: s.ring, pool: [], quays: [], svc: {}, tags: {}, town: s.town }); }
    else if ((TIERS[s.tier]?.rank ?? 0) > (TIERS[h.tier]?.rank ?? 0)) { h.tier = s.tier; h.why = s.why; }
    h.seeds.push(s);
    if (!h.ring && s.ring) { h.ring = s.ring; h.lat = s.c.lat; h.lon = s.c.lon; }
    for (const [k, v] of Object.entries(s.f.t || {})) if (h.tags[k] == null) h.tags[k] = v;
  }
  // 2. pontoon / pier components
  const U = union(pool.length);
  for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) {
    const a = pool[i], b = pool[j];
    const d = Math.min(distM(a.c.lat, a.c.lon, b.c.lat, b.c.lon), distM(a.ax.a[0], a.ax.a[1], b.ax.a[0], b.ax.a[1]), distM(a.ax.b[0], a.ax.b[1], b.ax.b[0], b.ax.b[1]), distM(a.ax.a[0], a.ax.a[1], b.ax.b[0], b.ax.b[1]), distM(a.ax.b[0], a.ax.b[1], b.ax.a[0], b.ax.a[1]));
    if (d <= MH.CLUSTER_M) U.join(i, j);
  }
  const comps = new Map();
  pool.forEach((p, i) => { const r = U.find(i); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(p); });
  for (const comp of [...comps.values()].sort((a, b) => byId(a[0].f, b[0].f))) {
    let host = null, hd = Infinity;
    for (const h of hs) for (const p of comp) {
      const inside = h.ring && inRingLL(h.ring, p.c.lat, p.c.lon);
      const d = inside ? 0 : distM(h.lat, h.lon, p.c.lat, p.c.lon);
      if (d <= MH.ATTACH_M && d < hd) { hd = d; host = h; }
    }
    if (host) { host.pool.push(...comp); continue; }
    const nPont = comp.filter((p) => p.pontoon && !FERRY_NAME.test(p.f.t?.name || '')).length, lenSum = comp.reduce((s, p) => s + p.ax.lenM, 0);
    if (nPont >= MH.CLUSTER_MIN_PONTOONS && (comp.length >= MH.CLUSTER_MIN || lenSum >= MH.CLUSTER_MIN_LEN_M)) {
      let la = 0, lo = 0; for (const p of comp) { la += p.c.lat; lo += p.c.lon; }
      hs.push({ seeds: [{ f: comp[0].f }], lat: la / comp.length, lon: lo / comp.length, tier: 'marina', why: `${comp.length} pontoons / finger piers (inferred)`, ring: null, pool: comp, quays: [], svc: {}, tags: {}, inferred: true });
    }
  }
  // 3. quays and services
  for (const q of quays) {
    let host = null, hd = Infinity;
    for (const h of hs) { if (h.tier === 'marina') continue; const d = distM(h.lat, h.lon, q.c.lat, q.c.lon); if (d <= MH.ATTACH_M && d < hd) { hd = d; host = h; } }
    if (host) host.quays.push(q);
  }
  for (const s of services) {
    let host = null, hd = Infinity;
    for (const h of hs) { const d = distM(h.lat, h.lon, s.c.lat, s.c.lon); if (d <= MH.SERVICE_M && d < hd) { hd = d; host = h; } }
    if (host) Object.assign(host.svc, s.sv);
  }
  // 4. records
  let recs = hs.map((h) => recordOf(h, ctx));
  // 5. FIS tourist harbours (NL): merge with an OSM harbour within MERGE_M (FIS wins id, name and numbers), else standalone
  for (const fis of [...(ctx.fis || [])].sort(byId)) {
    const p = fis.p || [fis.lat, fis.lon]; if (!Number.isFinite(p?.[0])) continue;
    let best = null, bd = Infinity;
    for (const r of recs) { if (r.fis) continue; const d = distM(r.lat, r.lon, p[0], p[1]); if (d <= MH.MERGE_M && d < bd) { bd = d; best = r; } }
    const cl = classifyFis(fis), places = fisPlaces(fis);
    if (best) {
      const osmId = best.id;
      Object.assign(best, {
        id: `mh:fis:${String(fis.id).replace(/^fis:/, '')}`, fis: fis.id, src: 'fis+osm', e: 0, name: fis.name || best.name,
        places: places || best.places, tier: best.inferred || (TIERS[cl.tier].rank > TIERS[best.tier].rank) ? cl.tier : best.tier,
        maxL: num(fis.maxL) ?? best.maxL, maxB: num(fis.maxB) ?? best.maxB, maxT: num(fis.maxT) ?? best.maxT,
        depth: num(fis.depth ?? fis.maxT) ?? best.depth, depthSrc: num(fis.depth ?? fis.maxT) != null ? 'FIS' : best.depthSrc,
        vhf: Number.isInteger(fis.vhf) ? fis.vhf : best.vhf, osm: [...best.osm], was: osmId, inferred: false,
      });
      if (fis.fuel) best.svc = { ...best.svc, fuel: true };
      finishRecord(best, ctx);
    } else {
      const r = {
        id: `mh:fis:${String(fis.id).replace(/^fis:/, '')}`, name: fis.name || null, tier: cl.tier, why: cl.why, lat: r5(p[0]), lon: r5(p[1]), src: 'fis', e: 0,
        places, maxL: num(fis.maxL), maxB: num(fis.maxB), maxT: num(fis.maxT), depth: num(fis.depth ?? fis.maxT), depthSrc: num(fis.depth ?? fis.maxT) != null ? 'FIS' : null,
        vhf: Number.isInteger(fis.vhf) ? fis.vhf : null, svc: fis.fuel ? { fuel: true } : {}, pont: [], quay: [], osm: [], fis: fis.id,
      };
      finishRecord(r, ctx);
      recs.push(r);
    }
  }
  if (Number.isInteger(ctx.x12) && Number.isInteger(ctx.y12)) recs = recs.filter((r) => sqOf(r.lat, r.lon) === `${ctx.x12}/${ctx.y12}`);
  recs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return recs;
}
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
function safe(fn) { try { return fn(); } catch { return null; } }
function recordOf(h, ctx) {
  const first = [...h.seeds].map((s) => s.f).sort(byId)[0];
  const t = h.tags || {};
  const pont = h.pool.filter((p) => p.ax).sort((a, b) => b.ax.lenM - a.ax.lenM || byId(a.f, b.f)).slice(0, MH.MAX_PONTOONS).map((p) => lineRec(p.ax));
  const quay = h.quays.sort((a, b) => b.ax.lenM - a.ax.lenM || byId(a.f, b.f)).slice(0, MH.MAX_QUAYS).map((q) => lineRec(q.ax));
  const vhf = parseVhf(t) ?? h.seeds.map((s) => parseVhf(s.f?.t || {})).find((v) => v != null) ?? null;
  const r = {
    id: `mh:osm:${first.id}`, name: t.name || h.seeds.map((s) => s.f?.t?.name).find(Boolean) || null, tier: h.tier, why: h.why,
    lat: r5(h.lat), lon: r5(h.lon), src: 'osm', e: h.inferred ? 2 : 1, places: num(t.capacity) ?? null,
    maxL: num(t.maxlength), maxB: num(t.maxwidth), maxT: num(t.maxdraught), depth: num(t.maxdraught ?? t.depth ?? t['seamark:harbour:minimum_depth']), depthSrc: null,
    vhf, svc: { ...h.svc }, pont, quay, osm: h.seeds.map((s) => s.f.id).filter(Boolean).sort(), fis: null, inferred: !!h.inferred,
    town: h.town?.name || null,
  };
  if (r.depth != null) r.depthSrc = 'OSM';
  finishRecord(r, ctx);
  return r;
}
function finishRecord(r, ctx) {
  r.cc = inNL(r.lat, r.lon) ? 'NL' : null;
  r.sq = sqOf(r.lat, r.lon);
  const { sub, link } = subOf(r.lat, r.lon, ctx.named || []);
  r.sub = sub; r.link = link ? { id: link.id, dKm: link.dKm } : null;
  if (!r.name) r.name = nameFor(r, { town: r.town, near: link?.name });
  const b = berthsOf(r, { limit: 0 });
  r.cap = r.places ?? b.total;
  return r;
}
/** z12 square key of a point. */
export function sqOf(lat, lon) {
  const n = 4096, la = Math.max(-85.0511, Math.min(85.0511, lat)) * D2R;
  const x = Math.floor(((lon + 180) / 360) * n), y = Math.floor(((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2) * n);
  return `${x}/${y}`;
}

// ------------------------------------------------------------------------------------------------ card, chart, 3D
/** Reach line (§7.4) from a planInland answer: 'yes' | 'with openings (…)' | 'no: {first blocking object}' | 'unknown'. */
export function reachOf(route, { blocked = null, available = true } = {}) {
  if (!available) return { state: 'unknown', text: 'Route check unavailable here' };
  if (!route || !Array.isArray(route.points)) {
    const what = blocked?.name ? `${blocked.name}${blocked.why ? ` (${blocked.why})` : ''}` : 'no route for your ship';
    return { state: 'no', text: `No: ${what}`, blocked: blocked || null };
  }
  const marks = route.marks || [];
  const br = marks.filter((m) => m.kind === 'bridge' && m.action === 'opening').length, lk = marks.filter((m) => m.kind === 'lock').length;
  const wait = Math.round(marks.reduce((s, m) => s + (Number(m.waitMin) || 0), 0));
  if (!br && !lk) return { state: 'yes', text: 'Yes', bridges: 0, locks: 0, waitMin: 0 };
  const parts = []; if (br) parts.push(`${br} bridge${br > 1 ? 's' : ''}`); if (lk) parts.push(`${lk} lock${lk > 1 ? 's' : ''}`);
  return { state: 'openings', text: `With openings (${parts.join(', ')}, est. +${wait} min)`, bridges: br, locks: lk, waitMin: wait };
}
/**
 * The harbour card (§7.5), built on demand. ctx: { ship: dims (shipDimsOf), depth: {m, src}, reach, market, jobs, named (for the sub link name), power }
 * → plain JSON for GET /api/mh/:id and the client sheet.
 */
export function harbourCard(h, ctx = {}) {
  const tier = TIERS[h.tier] || TIERS.passant, dep = ctx.depth || depthOf(h), b = berthsOf(h, { limit: ctx.berthLimit ?? 120 });
  const svc = servicesOf(h), v = vhfOf(h);
  const card = {
    id: h.id, name: h.name, tier: h.tier, tierLabel: h.cc === 'NL' ? `${tier.label} (${tier.nl})` : tier.label, sym: tier.sym,
    lat: h.lat, lon: h.lon, src: h.src, est: h.e === 2, why: h.why || null,
    vhf: v.ch ? { ch: v.ch, sim: v.sim, text: `Harbour master ch ${v.ch}${v.sim ? ' (simulated)' : ''}` } : { ch: null, sim: false, text: 'No VHF (phone only)' },
    depth: { m: dep.m, src: dep.src, text: `${dep.m} m${dep.src === 'est.' ? ' (est.)' : ''}` },
    berths: { kind: b.kind, total: b.total, sizes: b.sizes, list: b.list, rafting: h.tier === 'passant' ? `Rafting allowed (yachts ≤ ${MH.RAFT_MAX_L} m, up to ${MH.RAFT_ABREAST} abreast)` : null },
    services: svc, tabs: [...tier.tabs], sub: h.sub || null,
    limits: { maxL: h.maxL ?? null, maxB: h.maxB ?? null, maxT: h.maxT ?? null },
    notes: [],
  };
  if (h.sub) card.notes.push(`Inside the port of ${h.sub.name} (${h.sub.dKm} km): its market, shipyard and boards are at the harbour sheet.`);
  if (h.e === 2) card.notes.push('Harbour found from pontoons on the chart (est.): berths and depth are estimates.');
  if (ctx.ship) {
    const fit = fitSummary(h, ctx.ship, { depth: dep, berths: b });
    card.fit = { fits: fit.fits, total: fit.total, ok: fit.fits > 0, why: fit.why, text: fit.fits > 0 ? `${fit.fits} of ${fit.total} berths take you` : `No berth for you: ${fit.why || 'too big'}` };
    const fee = nightFee(h, ctx.ship, { power: ctx.power !== false, link: ctx.link || null });
    card.fee = { ...fee, text: fee.perNight ? `${fee.perNight} cr per night (${fee.basis})` : 'No berth fee' };
  }
  if (ctx.reach) card.reach = ctx.reach;
  if (ctx.market) card.market = ctx.market; else if (!svc.market) card.tabs = card.tabs.filter((t) => t !== 'market');
  if (ctx.jobs) card.jobs = ctx.jobs; else if (!(MH.BOARD_MAX[h.tier] > 0)) card.tabs = card.tabs.filter((t) => t !== 'jobs');
  return card;
}
/** Chart row (§8.2 mh_list entry). */
export function chartRow(h) {
  const v = vhfOf(h);
  return { id: h.id, name: h.name, tier: h.tier, lat: h.lat, lon: h.lon, vhf: v.ch, berths: h.cap ?? 0, sym: TIERS[h.tier]?.sym || 'passant', est: h.e === 2, sub: h.sub ? h.sub.id : null };
}
/**
 * What lane C's public/js/mharbour.js draws (§7.5 3D): the harbour-master hut with a flag at the entrance, the blue
 * sign board, numbered box posts on the finger pontoons (from berthsOf), the berth outline reused from dock-anywhere.
 */
export function markerSpec(h, { maxPosts = 200 } = {}) {
  const b = berthsOf(h, { limit: maxPosts });
  const p0 = h.pont?.[0], q0 = h.quay?.[0];
  const root = p0 ? [p0[0], p0[1]] : q0 ? [q0[0], q0[1]] : [h.lat, h.lon];
  const hut = offsetPoint(root, [h.lat, h.lon], -15, 12);
  const sign = h.tier === 'passant' ? (h.cc === 'NL' ? 'Passantenhaven' : 'Visitor berths') : h.tier === 'marina' ? (h.name || 'Marina') : h.name;
  return {
    id: h.id, tier: h.tier,
    hut: h.tier === 'marina' || h.tier === 'passant' ? { lat: r5(hut[0]), lon: r5(hut[1]), flag: true } : null,
    sign: { text: sign, color: h.tier === 'passant' ? '#1f5fbf' : '#1f5fbf', lat: r5(root[0]), lon: r5(root[1]) },
    posts: b.kind === 'box' ? b.list.map((x) => ({ no: x.no, lat: x.post[0], lon: x.post[1] })) : [],
    berths: b.list.map((x) => ({ id: x.id, lat: x.lat, lon: x.lon, hdg: x.hdg, len: x.len ?? x.lenM, w: x.w ?? null })),
  };
}

// ------------------------------------------------------------------------------------------------ small inland market
function hash32(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
/**
 * Small market at an inland port (§7.6): 3–5 goods (no contraband) priced from the nearest named harbour's quote ×
 * (1 ± 0.06), stock 10 % of a regional harbour's. Fishing harbours: fish only. named = { goods: { g: { buy, sell, stock, target } } }
 * (server/market.js marketSnapshot row). Deterministic per harbour id. → { goods: [{ id, buy, sell, stock }], from }
 */
export function inlandMarket(h, named, { regionalTarget = null, contraband = new Set() } = {}) {
  if (!named?.goods) return null;
  const pool = Object.keys(named.goods).filter((g) => !contraband.has(g) && Number.isFinite(named.goods[g]?.buy)).sort();
  if (!pool.length) return null;
  const r = rng(hash32(String(h.id)));
  let chosen;
  if (h.tier === 'fishing') chosen = pool.includes('fish') ? ['fish'] : [];
  else {
    const n = Math.min(pool.length, MH.MARKET_GOODS[0] + Math.floor(r() * (MH.MARKET_GOODS[1] - MH.MARKET_GOODS[0] + 1)));
    const bag = [...pool]; chosen = [];
    while (chosen.length < n) chosen.push(bag.splice(Math.floor(r() * bag.length), 1)[0]);
    chosen.sort();
  }
  const goods = chosen.map((g) => {
    const q = named.goods[g], f = Math.round((1 + (r() * 2 - 1) * MH.MARKET_SPREAD) * 1000) / 1000;
    const tgt = regionalTarget?.[g] ?? q.target ?? q.stock ?? 0;
    return { id: g, buy: Math.round(q.buy * f), sell: Math.round(q.sell * f), stock: Math.round(MH.MARKET_STOCK_FRAC * (Number(tgt) || 0)), f };
  });
  return { goods, from: named.id || null };
}
