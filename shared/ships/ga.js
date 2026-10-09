// General arrangement (GA) of every catalogue ship — docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §6 (Lane C).
// ONE layout description per ship drives both the exterior (public/js/shipgen.js, Lane B) and the walkable deck plan
// (public/js/gaplan.js, Lane C), so walls always sit inside the plating and the windows line up.
//
// Pure and deterministic: numbers only, no three.js, no DOM, no Math.random. Frame (metres, 1 unit = 1 m): x to
// starboard, y up (0 = waterline), z aft (the bow at −L/2, the transom at +L/2) — the same frame as shipplan.js.
//
//   generalArrangement(variantId, { livery, stage }) → GA (frozen; §6.2 shape + the additive keys documented below)
//   hullHalf(ga, z, y)       half-breadth of the moulded hull at (z, y)            (exterior lofting + plan fitting)
//   deckHalf(ga, z)          half-breadth of the main deck edge at z
//   outlineHalf(ga, n)       starboard deck edge [[x, z]…] from the transom to the stem (shipplan.js outline format)
//   fitHalf(ga, z0, z1, y0, y1) the largest half-width a box spanning z0..z1, y0..y1 can have inside the plating
//   blindDistance(ga)        SOLAS V/22 blind distance ahead of the bow (m) at the GA's eye height over its obstructions
//   meDims(kind, kW, n), doubleBottom(B), cabinArea(gt, officer)
//
// Additive keys (beyond §6.2; consumers that do not know them ignore them):
//   ga.layout      'big' | 'small' | 'pax' | 'roro' — which planner gaplan.js uses
//   ga.crew        { opt, berths, officers, ratings, hospital, dayRooms, gym, ratingArea, officerArea }
//   ga.house.core  { x0,x1,z0,z1, fx0,fx1, runZ0,runZ1, deg }       the stacked stair column of the house
//   ga.house.tiers[k].rooms  [{ id, kind, use, name, x0,x1,z0,z1, doors:[{ to, side, at, w, kind }], win:[side], furn, berth }]
//   ga.er.column   { x0,x1, runZ0,runZ1, z0,z1, deg, top: 'house'|'casing', entrance }   the engine-room stair column
//   ga.pax         passenger decks (ferry / cruise): { decks:[{ id, y, h, use, name, zones:[{ z0,z1, use }] }], towers:[{ z0,z1 }], mvz }
//   ga.small       small-craft layout (deckhouse, wheelhouse, compartments below deck)
//   ga.roro        car decks { decks:[{ y, h }], ramps:[…], casing }
import { MODELS } from './catalogue.js';
import { parseVariant } from './options.js';

export const GA_VERSION = 1;
export const GA_GENS = ['aft_house_dry', 'aft_house_tanker', 'lng', 'container', 'roro_pctc', 'ferry', 'cruise', 'offshore', 'tug', 'fishing', 'small_fast', 'motor_yacht', 'special'];

// ------------------------------------------------------------------------------------------------ rules (§6.3)
export const RULES = {
  DEPTH_RATIO: { aft_house_dry: 0.72, aft_house_tanker: 0.70, lng: 0.62, container: 0.62, roro_pctc: 0.45, ferry: 0.45, cruise: 0.45, offshore: 0.82, tug: 0.80, fishing: 0.8, small_fast: 0.6, motor_yacht: 0.6, special: 0.8 },
  TIER_H: { merchant: 2.8, offshore: 3.0, ferry: 3.0, public: 3.2, yacht: 2.5 },   // Game rule (typical)
  ER_LEN: { '2s': 0.12, '4s': 0.12, aux: 0.12, de: 0.10, hs: 0.18, ob: 0 },        // × L (small craft 0.18, min 4 m)
  ER_LEVEL: 4.5, ER_LEVEL_SMALL: 3.4,                                             // m between engine-room levels
  CABIN_AREA: [[3000, 4.5], [10000, 5.5], [Infinity, 7.0]],                      // MLC A3.1 rating cabin floor (m²) by GT
  OFFICER_AREA: [[3000, 7.5], [10000, 8.5], [Infinity, 10.0]],                   // MLC A3.1 officers
  HOSPITAL_CREW: 15, DAYROOM_GT: 3000, GYM_GT: 10000,
  STAIR_DEG: 42, ER_STAIR_DEG: 55, SMALL_STAIR_DEG: 52,                           // Game rule
  CORRIDOR: 1.2, FLIGHT: 1.1, LAND: 1.3, ROOM_D: 3.8,
  CONTAINER: { bay: 12.2, lash: 0.8, row: 2.55, tier: 2.59, coaming: 1.6 },
};
const CB_TYPE = { bulk: 0.85, tanker: 0.82, gas: 0.75, container: 0.66, general: 0.76, roro: 0.6, ferry: 0.58, cruise: 0.66, offshore: 0.7, tug: 0.5, workboat: 0.6, pilot: 0.45, fishing: 0.6, motor_yacht: 0.45, special: 0.62 };

const r2 = (v) => Math.round(v * 100) / 100;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const D2R = Math.PI / 180;
export const stairRun = (rise, deg) => r2(rise / Math.tan(deg * D2R));
const lookup = (tbl, v) => { for (const [lim, a] of tbl) if (v < lim) return a; return tbl[tbl.length - 1][1]; };
export function cabinArea(gt, officer = false) { return lookup(officer ? RULES.OFFICER_AREA : RULES.CABIN_AREA, gt || 0); }
/** SOLAS II-1/9 double bottom: B/20, 1.0 … 2.0 m. */
export function doubleBottom(B) { return r2(Math.min(2, Math.max(1, B / 20))); }
/** Main engine (or one of n engines) size by kind (§6.3; Game rule fits). */
export function meDims(kind, kW, n = 1) {
  const k = kW / Math.max(1, n);
  if (kind === '2s') return { len: r2(4 + 0.07 * Math.sqrt(k)), w: r2(2 + 0.012 * Math.sqrt(k)), h: r2(6 + 0.3 * Math.cbrt(k)) };
  if (kind === 'hs') return { len: r2(1.2 + 0.035 * Math.sqrt(k)), w: r2(0.8 + 0.006 * Math.sqrt(k)), h: r2(1.0 + 0.06 * Math.cbrt(k)) };
  return { len: r2(2 + 0.05 * Math.sqrt(k)), w: r2(1.1 + 0.01 * Math.sqrt(k)), h: r2(1.8 + 0.1 * Math.cbrt(k)) };   // 4-stroke / DE genset / aux
}

// ------------------------------------------------------------------------------------------------ hull lines
// Deck edge: elliptical-ish bow over bowFrac·L, parallel middle body, quadratic run to a transom of sternW·hb.
// Below the deck the sections narrow toward the ends (run and entrance) and round off at the bilge.
export function deckHalf(ga, z) {
  const h = ga.hull, L = ga.L, hb = (h.twin ? ga.B : ga.B) / 2;
  if (z < -L / 2 - 1e-9 || z > L / 2 + 1e-9) return 0;
  const [m0, m1] = h.mid;
  if (z <= m0) {
    const t = clamp((m0 - z) / (m0 + L / 2), 0, 1);
    return hb * (h.stemW + (1 - h.stemW) * Math.pow(Math.max(0, 1 - Math.pow(t, h.bowP)), 0.5));
  }
  if (z >= m1) { const u = clamp((z - m1) / (L / 2 - m1), 0, 1); return hb * (1 - (1 - h.sternW) * u * u); }
  return hb;
}
/** Half-breadth of the hull at (z, y). Above the main deck: the deck edge (no flare); twin hulls: the outer demihull edge. */
export function hullHalf(ga, z, y) {
  const d = deckHalf(ga, z);
  if (d <= 0) return 0;
  if (y >= ga.deckY) return d;
  const h = ga.hull, Tk = ga.Tk, L = ga.L;
  if (h.twin && y < h.twin.wetY) { // demihulls: outer edge of one demihull
    const c = h.twin.xc, hh = h.twin.hullB / 2;
    const s = clamp((h.twin.wetY - y) / (h.twin.wetY + Tk), 0, 1);
    const end = Math.max(endFactor(ga, z, s), 0);
    return Math.min(d, (c + hh * end * (1 - 0.35 * s * s)) * (d / (ga.B / 2)));
  }
  const s = clamp((ga.deckY - y) / (ga.deckY + Tk), 0, 1);
  const local = d * endFactor(ga, z, s);
  const yk = y + Tk, R = Math.min(h.bilgeR, local * 0.95);
  if (yk >= R) return local;
  if (yk <= 0) return Math.max(0, local - R);
  return Math.max(0, local - R + Math.sqrt(Math.max(0, R * R - (R - yk) * (R - yk))));
}
function endFactor(ga, z, s) {
  const h = ga.hull, L = ga.L, [m0, m1] = h.mid;
  let f = 1;
  if (z > m1) { const u = clamp((z - m1) / (L / 2 - m1), 0, 1); f *= 1 - h.runK * Math.pow(u, 1.5) * Math.pow(s, 0.7); }
  if (z < m0) { const v = clamp((m0 - z) / (m0 + L / 2), 0, 1); f *= 1 - h.entK * Math.pow(v, 1.6) * Math.pow(s, 0.6); }
  return Math.max(0.02, f);
}
/** Starboard deck edge from the transom (z = +L/2) to the stem (z = −L/2), as [x, z] — shipplan.js outline format. */
export function outlineHalf(ga, n = 64) {
  const L = ga.L, m0 = ga.hull.mid[0], pts = [], r3 = (v) => Math.round(v * 1000) / 1000;
  const nA = Math.round(n * 0.45), nB = n - nA;
  for (let i = 0; i < nA; i++) { const z = L / 2 - ((L / 2 - m0) * i) / nA; pts.push([r3(deckHalf(ga, z)), r3(z)]); }
  for (let i = 0; i <= nB; i++) { const t = i / nB, z = m0 - (m0 + L / 2) * Math.sin((t * Math.PI) / 2); pts.push([r3(deckHalf(ga, z)), r3(z)]); }
  return pts;
}
/** Largest half-width of a box z0..z1 × y0..y1 that stays inside the plating. */
export function fitHalf(ga, z0, z1, y0, y1 = y0) {
  let m = Infinity;
  for (let i = 0; i <= 10; i++) {
    const z = z0 + ((z1 - z0) * i) / 10;
    for (let j = 0; j <= 2; j++) m = Math.min(m, hullHalf(ga, z, y0 + ((y1 - y0) * j) / 2));
  }
  return m;
}
/** Twin hull: the demihull centre x (±) and half-breadth at z, y (below the wet deck). */
export function demihullAt(ga, z, y) {
  const t = ga.hull.twin; if (!t) return null;
  const s = clamp((t.wetY - y) / (t.wetY + ga.Tk), 0, 1);
  return { xc: t.xc, half: (t.hullB / 2) * endFactor(ga, z, s) * (1 - 0.35 * s * s) * (deckHalf(ga, z) / (ga.B / 2)) };
}

// ------------------------------------------------------------------------------------------------ SOLAS V/22
/** Required eye height so the sea is visible within dMax ahead of the bow over an obstruction at (zO, yO). */
function eyeFor(L, zE, zO, yO, dMax) {
  const a = zE - zO, b = zE - (-L / 2 - dMax);
  return a >= b ? Infinity : (b * yO) / (b - a);
}
/** Blind distance ahead of the bow (m) from the eye (ga.bridge.z0, ga.house.eyeY) over every forward obstruction. */
export function blindDistance(ga) {
  const zE = ga.bridge.z0, yE = ga.house.eyeY, L = ga.L;
  let worst = 0;
  for (const o of ga.obstructions || []) {
    if (o.z >= zE || Math.abs(o.x || 0) > ga.B / 4) continue;
    if (o.y >= yE) return Infinity;
    const zHit = zE - ((zE - o.z) * yE) / (yE - o.y);   // where the line over the top meets the sea (y = 0)
    worst = Math.max(worst, -L / 2 - zHit);
  }
  return worst;
}

// ------------------------------------------------------------------------------------------------ base record
const HULL_KIND = {
  aft_house_dry: { bow: 'bulb', stern: 'cruiser', sternW: 0.88 }, aft_house_tanker: { bow: 'bulb', stern: 'cruiser', sternW: 0.9 },
  lng: { bow: 'bulb', stern: 'transom', sternW: 0.9 }, container: { bow: 'bulb', stern: 'transom', sternW: 0.95 },
  roro_pctc: { bow: 'bulb', stern: 'ramp', sternW: 0.98 }, ferry: { bow: 'bulb', stern: 'transom', sternW: 0.97 },
  cruise: { bow: 'bulb', stern: 'transom', sternW: 0.94 }, offshore: { bow: 'raked', stern: 'transom', sternW: 0.98 },
  tug: { bow: 'tug', stern: 'tug', sternW: 0.84 }, fishing: { bow: 'raked', stern: 'transom', sternW: 0.86 },
  small_fast: { bow: 'planing', stern: 'transom', sternW: 0.9 }, motor_yacht: { bow: 'yacht', stern: 'yacht', sternW: 0.82 },
  special: { bow: 'raked', stern: 'transom', sternW: 0.92 },
};

function baseGA(m, pv, opts) {
  const gen = m.gen, L = m.length, B = m.beam, T = m.draft;
  const Cb = m.Cb || CB_TYPE[m.type] || 0.65;
  let D = m.depth || T / (RULES.DEPTH_RATIO[gen] || 0.7);
  const small = L < 40;
  const fMin = gen === 'tug' ? (L < 20 ? 0.8 : 1.0) : gen === 'motor_yacht' || gen === 'small_fast' ? (L < 12 ? 0.6 : 0.8) : gen === 'fishing' ? 1.2 : Math.max(1.5, L * 0.015);
  const Th = m.draftHull > 0 && m.draftHull < T ? m.draftHull : T;   // ASD tugs: hull-body draught (catalogue draftHull); T stays the navigational draught over the drives
  if (D - Th < fMin) D = Th + fMin;
  const F = r2(D - Th);
  // keel depth of the moulded hull (tug and small-craft draughts include drives and skegs)
  const Tk = r2(Th < T ? Th : gen === 'tug' ? Math.min(T, D * 0.62) : gen === 'small_fast' || gen === 'motor_yacht' ? Math.min(T, D * 0.55) : T);
  const hk = HULL_KIND[gen] || HULL_KIND.special;
  const bowFrac = gen === 'tug' ? 0.3 : gen === 'motor_yacht' ? 0.38 : gen === 'small_fast' ? 0.4 : clamp(0.42 - 0.3 * Cb, 0.12, 0.32);
  const aftRun = gen === 'tug' ? 0.22 : gen === 'motor_yacht' || gen === 'small_fast' ? 0.12 : clamp(0.3 - 0.25 * Cb, 0.06, 0.24);
  const ice = pv.opts.ice || m.stats?.ice || null;
  const hull = {
    bow: ice && /^pc/.test(ice) ? 'ice' : L < 100 && hk.bow === 'bulb' ? 'raked' : hk.bow, stern: hk.stern,
    bowFrac: r2(bowFrac), sternW: hk.sternW, stemW: gen === 'tug' ? 0.28 : gen === 'small_fast' || gen === 'motor_yacht' ? 0.04 : 0.02,
    bowP: r2(1.4 + 1.6 * Cb), runK: gen === 'tug' ? 0.55 : 0.82, entK: hk.bow === 'bulb' ? 0.45 : 0.7,
    sheerFwd: 0, sheerAft: 0, flare: gen === 'container' || gen === 'cruise' ? 0.06 : 0.03,
    bilgeR: r2(gen === 'motor_yacht' || gen === 'small_fast' ? B * 0.32 : clamp(B * (0.25 - 0.2 * Cb), 0.3, B * 0.2)),
    mid: [r2(-L / 2 + bowFrac * L), r2(L / 2 - aftRun * L)], fcsle: null, poop: null, bulwark: 0, twin: null,
  };
  const ga = {
    id: pv.tokens.length ? `${m.id}~${pv.tokens.join('.')}` : m.id, model: m.id, gen, type: m.type, name: m.name,
    L, B, T, D: r2(D), F, deckY: F, Cb, Tk, small, gt: m.gt || 0, kW: m.kW || 0, opts: pv.opts, ice,
    hull, house: null, bridge: null, casing: null, funnel: null, er: null, cargo: { kind: 'none', zones: [] },
    deck: { mooring: [], cranes: [], boats: [], gangway: null, pilotLadder: null, aframe: null, sternRoller: null, heli: null, masts: [], rotors: [], hoseCranes: [], manifold: null, gear: [] },
    goto: [], levels: [], obstructions: [], livery: opts.livery || null, stage: opts.stage == null ? 1 : opts.stage,
    crew: crewOf(m), layout: 'big', eq: m.eq || [], db: doubleBottom(B),
  };
  return ga;
}
function crewOf(m) {
  const opt = m.crew?.opt || 2, gt = m.gt || 0;
  const officers = Math.max(1, Math.round(opt * 0.45)), ratings = Math.max(0, opt - officers);
  return { opt, berths: opt + 2, officers, ratings, hospital: opt >= RULES.HOSPITAL_CREW, dayRooms: gt >= RULES.DAYROOM_GT, gym: gt >= RULES.GYM_GT, ratingArea: cabinArea(gt), officerArea: cabinArea(gt, true) };
}

// ------------------------------------------------------------------------------------------------ house tiers
// The house is a box X0..X1 × Z0..Z1 with stacked tiers. Every tier shares one stair column (core); rooms are laid out
// either as a RING (outer rooms round a corridor ring round a central core: stair room + engine casing — big houses) or a
// SPINE (stair room in the aft port corner, transverse lobby, rooms forward — narrow houses).
const CW = RULES.CORRIDOR, FL = RULES.FLIGHT, LAND = RULES.LAND;

/** Room programme of one tier (merchant / offshore). */
function tierProgramme(ga, use, k, nTiers, extra = {}) {
  const c = ga.crew, P = [];
  const cab = (name, role, officer = false) => ({ kind: 'cabin', use: 'cabin', name, furn: 'cabin', berth: 1, role, officer });
  if (use === 'main') {
    if (c.opt >= 10) { P.push({ kind: 'mess', use: 'mess', name: 'Officers\' mess', furn: 'mess', at: 'front' }, { kind: 'mess', use: 'mess', name: 'Crew mess', furn: 'mess', at: 'front' }); }
    else P.push({ kind: 'mess', use: 'mess', name: 'Mess room', furn: 'mess', at: 'front' });
    P.push({ kind: 'mess', use: 'galley', name: 'Galley', furn: 'galley', at: 'front' });
    if (extra.ccr) P.push({ kind: 'store', use: 'ccr', name: 'Cargo control room', furn: 'ccr', at: 'front' });
    P.push({ kind: 'store', use: 'provisions', name: 'Provisions (dry store)', furn: 'shelves' }, { kind: 'store', use: 'cold', name: 'Cold room & freezer', furn: 'shelves' });
    P.push({ kind: 'store', use: 'changing', name: 'Changing room', furn: 'lockers' }, { kind: 'store', use: 'office', name: 'Ship\'s office', furn: 'office' });
  } else if (use === 'bridge') {
    P.push({ kind: 'store', use: 'electronics', name: 'Electronics room', furn: 'racks' }, { kind: 'store', use: 'wc', name: 'Pilot\'s toilet', furn: 'wc' }, { kind: 'store', use: 'store', name: 'Flag locker', furn: 'shelves' });
  }
  return P;
}

/** Distribute crew cabins and the other rooms over the accommodation tiers (A … top-1). Mutates progs. */
function crewProgramme(ga, progs) {
  const c = ga.crew, n = progs.length;
  const queue = [];
  const sen = c.dayRooms ? ['Master', 'Chief engineer', 'Chief officer'] : [];
  const offNames = ['Master', 'Chief engineer', 'Chief officer', '2nd engineer', '2nd officer', '3rd officer', '3rd engineer', 'Electro-technical officer', 'Cadet (deck)', 'Cadet (engine)', '4th engineer', 'Junior officer'];
  const ratNames = ['Bosun', 'Fitter', 'AB', 'AB', 'AB', 'Oiler', 'Oiler', 'Wiper', 'OS', 'OS', 'Cook', 'Steward', 'Messman', 'Pumpman', 'Electrician', 'AB', 'Oiler', 'OS', 'Steward', 'Messman'];
  const ratings = [], officers = [], seniors = [];
  for (let i = 0; i < c.ratings; i++) ratings.push({ kind: 'cabin', use: 'cabin', name: `${ratNames[i % ratNames.length]}'s cabin`, furn: 'cabin', berth: 1, officer: false });
  for (let i = 0; i < c.officers; i++) {
    const nm = offNames[i] || 'Officer';
    const o = { kind: 'cabin', use: 'cabin', name: `${nm}'s cabin`, furn: 'cabin', berth: 1, officer: true };
    if (sen.includes(nm)) seniors.push(o, { kind: 'cabin', use: 'dayroom', name: `${nm}'s day room`, furn: 'dayroom', officer: true });
    else officers.push(o);
  }
  const spare = [{ kind: 'cabin', use: 'cabin', name: 'Pilot\'s cabin', furn: 'cabin', berth: 1, officer: true }, { kind: 'cabin', use: 'cabin', name: 'Supernumerary cabin', furn: 'cabin', berth: 1, officer: true }];
  const misc = [{ kind: 'store', use: 'laundry', name: 'Laundry', furn: 'laundry' }];
  if (c.hospital) misc.push({ kind: 'cabin', use: 'hospital', name: 'Hospital', furn: 'hospital' });
  if (c.gym) misc.push({ kind: 'mess', use: 'gym', name: 'Gym', furn: 'gym' }, { kind: 'mess', use: 'recreation', name: 'Recreation room', furn: 'lounge' });
  if (ga.crew.opt >= 12) misc.push({ kind: 'mess', use: 'lounge', name: 'Officers\' lounge', furn: 'lounge' });
  // tier order: B = ratings + laundry + hospital, C = officers, D = seniors + office, E = spare. Small houses fold up.
  if (n <= 1) { progs[0].push(...seniors, ...officers, ...ratings, ...spare, ...misc); return; }
  const accom = progs.slice(1);
  const plan = accom.length >= 4 ? [[...misc.slice(0, 2), ...ratings], [...officers, ...misc.slice(2)], [...seniors], [...spare]]
    : accom.length === 3 ? [[...misc, ...ratings], [...officers], [...seniors, ...spare]]
      : accom.length === 2 ? [[...misc, ...ratings], [...seniors, ...officers, ...spare]] : [[...seniors, ...officers, ...ratings, ...spare, ...misc]];
  for (let i = 0; i < plan.length; i++) accom[Math.min(i, accom.length - 1)].push(...plan[i]);
  void queue;
}

/**
 * Lay out the tiers of a house. spec: { X0, X1, Z0, Z1, levels: [{ id, y, h, use, name }], progs: [[item]], roomD,
 * bridgeD, deg, entranceSides, erColumn: { rise, deg } | null }. → { core, tiers, layout, overflow }
 */
function layoutHouse(ga, spec) {
  const { X0, X1, Z0, Z1 } = spec, W = X1 - X0, Dp = Z1 - Z0;
  const deg = spec.deg || RULES.STAIR_DEG;
  let maxRise = 0; for (let k = 0; k < spec.levels.length - 1; k++) maxRise = Math.max(maxRise, spec.levels[k + 1].y - spec.levels[k].y);
  const run = Math.max(2.2, stairRun(maxRise, deg));
  const TL = r2(2 * LAND + run), SW = r2(2 * FL + 0.1);
  const dS = spec.roomD || RULES.ROOM_D, dA = spec.roomD || RULES.ROOM_D;
  const dF = Math.max(spec.roomD || RULES.ROOM_D, (spec.bridgeD || 0) - CW);
  const erTL = spec.erColumn ? r2(2 * LAND + Math.max(2.2, stairRun(spec.erColumn.rise, spec.erColumn.deg))) : 0;
  const ring = !spec.spine && W >= 2 * dS + 2 * CW + SW + 0.4 && Dp >= dF + dA + 2 * CW + Math.max(TL, 0) + 0.2 && Dp - dF - dA >= Math.max(erTL, 0) + 0.5;
  return ring ? ringHouse(ga, spec, { X0, X1, Z0, Z1, TL, SW, dS, dA, dF, run, deg, erTL }) : spineHouse(ga, spec, { X0, X1, Z0, Z1, TL, SW, run, deg, erTL });
}

function splitEven(a, b, target, minLen) {
  const n = Math.max(1, Math.round((b - a) / target));
  const out = []; for (let i = 0; i < n; i++) out.push([r2(a + ((b - a) * i) / n), r2(a + ((b - a) * (i + 1)) / n)]);
  if (out.length > 1 && out[0][1] - out[0][0] < minLen) return splitEven(a, b, target * 1.3, minLen);
  return out;
}

function ringHouse(ga, spec, g) {
  const { X0, X1, Z0, Z1, TL, SW, dS, dA, dF, run, deg, erTL } = g;
  const cx0 = r2(X0 + dS + CW), cx1 = r2(X1 - dS - CW), cz0 = r2(Z0 + dF + CW), cz1 = r2(Z1 - dA - CW);
  const core = { x0: cx0, x1: r2(cx0 + SW), z0: r2(Math.max(cz0, cz1 - TL)), z1: cz1, fx0: r2(cx0 + 0.06), fx1: r2(cx0 + FL - 0.04), runZ0: r2(cz1 - LAND - run), runZ1: r2(cz1 - LAND), deg, TL, SW, kind: 'ring' };
  if (core.z0 - cz0 < 1.6) core.z0 = cz0;   // too little in front of the stair room for a room: the stair room takes it
  const tiers = [];
  // engine-room stair column in the port side band (aft end), else starboard; tested against the hull by the caller
  let erSlot = null;
  if (spec.erColumn) {
    const len = erTL + 0.3;
    outer: for (const end of ['aft', 'fwd']) for (const side of spec.erColumn.sides || [-1, 1]) for (const inner of [false, true]) {
      const bx0 = side < 0 ? X0 : X1 - dS, bx1 = side < 0 ? X0 + dS : X1;
      const fx0 = (side < 0) !== inner ? bx0 + 0.15 : bx1 - 0.15 - FL;
      const z0 = end === 'aft' ? Z1 - dA - len : Z0 + dF, z1 = z0 + len;
      erSlot = { side, end, z0: r2(z0), z1: r2(z1), x0: r2(bx0), x1: r2(bx1), fx0: r2(fx0 + 0.06), fx1: r2(fx0 + FL - 0.04) };
      if (!spec.erColumn.fits || spec.erColumn.fits(erSlot)) break outer;
      erSlot = null;
    }
  }
  spec.levels.forEach((lv, k) => {
    const rooms = [], prog = (spec.progs[k] || []).slice();
    const id = (s) => `${lv.id}-${s}`;
    const top = lv.use === 'bridge', main = k === (spec.mainIndex ?? 0);
    const corF = { id: id('cor-f'), kind: top ? 'bridge' : 'passage', use: 'corridor', name: `Corridor (${lv.name})`, x0: r2(X0 + dS), x1: r2(X1 - dS), z0: r2(Z0 + dF), z1: cz0, doors: [] };
    const corA = { id: id('cor-a'), kind: 'passage', use: 'corridor', name: `Corridor (${lv.name})`, x0: r2(X0 + dS), x1: r2(X1 - dS), z0: cz1, z1: r2(Z1 - dA), doors: [] };
    const corP = { id: id('cor-p'), kind: 'passage', use: 'corridor', name: `Corridor (${lv.name}, port)`, x0: r2(X0 + dS), x1: cx0, z0: cz0, z1: cz1, doors: [] };
    const corS = { id: id('cor-s'), kind: 'passage', use: 'corridor', name: `Corridor (${lv.name}, starboard)`, x0: cx1, x1: r2(X1 - dS), z0: cz0, z1: cz1, doors: [] };
    if (!top) rooms.push(corF);
    rooms.push(corA, corP, corS);
    corP.doors.push({ to: top ? id('bridge') : corF.id, side: 'n', at: r2((corP.x0 + corP.x1) / 2), w: CW - 0.1, kind: 'open' }, { to: corA.id, side: 's', at: r2((corP.x0 + corP.x1) / 2), w: CW - 0.1, kind: 'open' });
    corS.doors.push({ to: top ? id('bridge') : corF.id, side: 'n', at: r2((corS.x0 + corS.x1) / 2), w: CW - 0.1, kind: 'open' }, { to: corA.id, side: 's', at: r2((corS.x0 + corS.x1) / 2), w: CW - 0.1, kind: 'open' });
    // core: stair room (aft port of the core), casing (rest), a small room in front of the stair room
    const st = { id: id('stairs'), kind: 'stairs', use: 'stairs', name: `Stairway (${lv.name})`, x0: core.x0, x1: core.x1, z0: core.z0, z1: core.z1, doors: [{ to: corA.id, side: 's', at: r2((core.x0 + core.x1) / 2), w: r2(SW - 0.2), kind: 'open' }], level: k };
    rooms.push(st);
    if (cx1 - core.x1 >= 1.2) rooms.push({ id: id('casing'), kind: 'store', use: 'casing', name: 'Engine casing', x0: core.x1, x1: cx1, z0: cz0, z1: cz1, walk: false, doors: [] });
    if (core.z0 - cz0 >= 1.6) rooms.push({ id: id('core-wc'), kind: 'store', use: 'wc', name: main ? 'Toilet' : 'Linen store', x0: core.x0, x1: core.x1, z0: cz0, z1: core.z0, doors: [{ to: corP.id, side: 'w', at: r2((cz0 + core.z0) / 2), w: 0.8 }], furn: main ? 'wc' : 'shelves' });
    // slots
    const slots = [];
    if (top) {
      rooms.push({ id: id('bridge'), kind: 'bridge', use: 'bridge', name: 'Bridge', x0: X0, x1: X1, z0: Z0, z1: cz0, doors: [], win: ['n', 'e', 'w'] });
    } else {
      // front band
      const fxs = [[X0, X0 + dS + CW], ...splitEven(X0 + dS + CW, X1 - dS - CW, 4.4, 2.4), [X1 - dS - CW, X1]];
      fxs.forEach(([a, b], i) => slots.push({ band: 'f', i, x0: r2(a), x1: r2(b), z0: Z0, z1: r2(Z0 + dF), door: { to: corF.id, side: 's', at: r2(i === 0 ? X0 + dS + CW / 2 : i === fxs.length - 1 ? X1 - dS - CW / 2 : (a + b) / 2 + Math.min(0.5, (b - a) / 2 - 0.6)), w: 0.9 }, win: ['n', ...(i === 0 ? ['w'] : []), ...(i === fxs.length - 1 ? ['e'] : [])] }));
    }
    // side bands (forward part on the bridge tier starts behind the bridge)
    const sz0 = top ? cz0 : r2(Z0 + dF), sz1 = r2(Z1 - dA);
    for (const side of [-1, 1]) {
      const bx0 = side < 0 ? X0 : r2(X1 - dS), bx1 = side < 0 ? r2(X0 + dS) : X1;
      let segs = [];
      let a = sz0, b = sz1;
      const reserve = [];
      if (main && erSlot && erSlot.side === side) { reserve.push({ z0: erSlot.z0, z1: erSlot.z1, kind: 'er' }); if (erSlot.end === 'fwd') a = erSlot.z1; else b = erSlot.z0; }
      if (main) { // weather entrance next aft (or the aft-most slot when there is no ER entrance here)
        const ez1 = b, ez0 = r2(Math.max(a + 0.1, b - 2.6));
        reserve.push({ z0: ez0, z1: ez1, kind: 'entrance' }); b = ez0;
      }
      if (b - a >= 1.0) segs = splitEven(a, b, 3.6, 2.2).map(([p, q]) => ({ z0: p, z1: q }));
      for (const s of segs) {
        const dz0 = Math.max(s.z0, cz0) + 0.5, dz1 = Math.min(s.z1, cz1) - 0.5;
        if (dz1 - dz0 < 0.9) { if (slots.length && slots[slots.length - 1].band === (side < 0 ? 'p' : 's') && slots[slots.length - 1].z1 === s.z0) { slots[slots.length - 1].z1 = s.z1; } continue; }
        slots.push({ band: side < 0 ? 'p' : 's', x0: bx0, x1: bx1, z0: s.z0, z1: s.z1, door: { to: side < 0 ? corP.id : corS.id, side: side < 0 ? 'e' : 'w', at: r2((dz0 + dz1) / 2), w: 0.9 }, win: [side < 0 ? 'w' : 'e'] });
      }
      for (const rsv of reserve) {
        const dz0 = Math.max(rsv.z0, cz0) + 0.5, dz1 = Math.min(rsv.z1, cz1) - 0.5;
        if (rsv.kind === 'er') {
          const r = { id: id(`er-entrance-${side < 0 ? 'p' : 's'}`), kind: 'store', use: 'er_entrance', name: 'Engine room entrance & changing room', x0: bx0, x1: bx1, z0: rsv.z0, z1: rsv.z1, doors: [{ to: side < 0 ? corP.id : corS.id, side: side < 0 ? 'e' : 'w', at: r2(clamp(rsv.z0 + LAND * 0.5 + 0.2, dz0, dz1)), w: 0.95 }], furn: 'lockers', win: [] };
          rooms.push(r); erSlot.room = r.id;
        } else {
          const r = { id: id(`entrance-${side < 0 ? 'p' : 's'}`), kind: 'passage', use: 'entrance', name: `Entrance (${side < 0 ? 'port' : 'starboard'})`, x0: bx0, x1: bx1, z0: rsv.z0, z1: rsv.z1, doors: [{ to: side < 0 ? corP.id : corS.id, side: side < 0 ? 'e' : 'w', at: r2(clamp((rsv.z0 + rsv.z1) / 2, dz0, dz1)), w: 1.0 }], ext: { side: side < 0 ? 'w' : 'e', at: r2((rsv.z0 + rsv.z1) / 2), w: 1.0 }, win: [] };
          rooms.push(r);
        }
      }
    }
    // aft band
    const axs = [[X0, X0 + dS + CW], ...splitEven(X0 + dS + CW, X1 - dS - CW, 4.4, 2.4), [X1 - dS - CW, X1]];
    axs.forEach(([a, b], i) => slots.push({ band: 'a', i, x0: r2(a), x1: r2(b), z0: r2(Z1 - dA), z1: Z1, door: { to: corA.id, side: 'n', at: r2(i === 0 ? X0 + dS + CW / 2 : i === axs.length - 1 ? X1 - dS - CW / 2 : (a + b) / 2 - Math.min(0.5, (b - a) / 2 - 0.6)), w: 0.9 }, win: ['s', ...(i === 0 ? ['w'] : []), ...(i === axs.length - 1 ? ['e'] : [])] }));
    tiers.push({ ...lv, rooms, slots, prog });
  });
  return { core, tiers, layout: 'ring', erSlot, assign: assignSlots };
}

function spineHouse(ga, spec, g) {
  const { X0, X1, Z0, Z1, TL, SW, run, deg, erTL } = g, W = X1 - X0;
  const CPW = 1.6;
  const stz0 = r2(Z1 - Math.max(TL, erTL || 0)), stz1 = Z1;
  const core = { x0: X0, x1: r2(X0 + SW), z0: stz0, z1: stz1, fx0: r2(X0 + 0.06), fx1: r2(X0 + FL - 0.04), runZ0: r2(stz1 - LAND - run), runZ1: r2(stz1 - LAND), deg, TL, SW, kind: 'spine' };
  const lz0 = r2(stz0 - CPW), lz1 = stz0;
  let erSlot = null;
  if (spec.erColumn && X1 - core.x1 >= 2.4) {
    for (const pos of [1, -1]) {
      const fx0 = pos > 0 ? X1 - 0.15 - FL : core.x1 + 0.15;
      erSlot = { side: pos, end: 'band', z0: stz0, z1: stz1, x0: core.x1, x1: X1, fx0: r2(fx0 + 0.06), fx1: r2(fx0 + FL - 0.04) };
      if (!spec.erColumn.fits || spec.erColumn.fits(erSlot)) break;
      erSlot = null;
    }
  }
  if (spec.erColumn && !erSlot && lz0 - Z0 >= (erTL || 0) + 0.3) {   // the forward block, port (or starboard) side next to the lobby
    const shallow = lz0 - Z0 <= 7.5, len = shallow ? r2(lz0 - Z0) : r2((erTL || 0) + 0.3), xc = (X0 + X1) / 2;
    const half = shallow ? Math.min(2.9, (X1 - X0) / 2 - 0.65) : (X1 - X0) / 2 - 0.65;
    for (const side of [-1, 1]) for (const inner of [false, true]) {
      const x0 = side < 0 ? X0 : r2(X1 - half), x1 = side < 0 ? r2(X0 + half) : X1;
      const fx0 = (side < 0) !== inner ? x0 + 0.15 : x1 - 0.15 - FL;
      erSlot = { side, end: 'front', shallow, z0: r2(lz0 - len), z1: lz0, x0, x1, fx0: r2(fx0 + 0.06), fx1: r2(fx0 + FL - 0.04) };
      if (!spec.erColumn.fits || spec.erColumn.fits(erSlot)) break;
      erSlot = null;
    }
    void xc;
  }
  const tiers = [];
  spec.levels.forEach((lv, k) => {
    const rooms = [], prog = (spec.progs[k] || []).slice(), id = (s) => `${lv.id}-${s}`;
    const top = lv.use === 'bridge', main = k === (spec.mainIndex ?? 0);
    const lobby = { id: id('lobby'), kind: top ? 'passage' : 'passage', use: 'corridor', name: top ? 'Lobby behind the bridge' : `Passage (${lv.name})`, x0: X0, x1: X1, z0: lz0, z1: lz1, doors: [] };
    if (main) lobby.ext = [{ side: 'w', at: r2((lz0 + lz1) / 2), w: 1.0 }, { side: 'e', at: r2((lz0 + lz1) / 2), w: 1.0 }];
    rooms.push(lobby);
    rooms.push({ id: id('stairs'), kind: 'stairs', use: 'stairs', name: `Stairway (${lv.name})`, x0: core.x0, x1: core.x1, z0: stz0, z1: stz1, doors: [{ to: lobby.id, side: 'n', at: r2((core.x0 + core.x1) / 2), w: r2(SW - 0.2), kind: 'open' }], level: k });
    const slots = [];
    if (X1 - core.x1 >= 2.0) {
      if (main && erSlot && erSlot.end === 'band') {
        const r = { id: id('er-entrance'), kind: 'store', use: 'er_entrance', name: 'Engine room entrance & changing room', x0: core.x1, x1: X1, z0: stz0, z1: stz1, doors: [{ to: lobby.id, side: 'n', at: r2(erSlot.side > 0 ? core.x1 + 0.6 : X1 - 0.6), w: 0.9 }], furn: 'lockers', win: [] };
        rooms.push(r); erSlot.room = r.id;
      } else slots.push({ band: 'a', x0: core.x1, x1: X1, z0: stz0, z1: stz1, door: { to: lobby.id, side: 'n', at: r2(core.x1 + Math.min(0.9, (X1 - core.x1) / 2)), w: 0.9 }, win: ['e', 's'] });
    }
    const fz0 = Z0, fz1 = lz0, depth = fz1 - fz0;
    if (top && depth <= 10) {
      rooms.push({ id: id('bridge'), kind: 'bridge', use: 'bridge', name: 'Bridge', x0: X0, x1: X1, z0: fz0, z1: fz1, doors: [{ to: lobby.id, side: 's', at: r2(clamp(0, X0 + 0.8, X1 - 0.8)), w: Math.min(1.2, W - 1), kind: 'open' }], win: ['n', 'e', 'w'] });
    } else if (depth <= 7.5) {
      let FX0 = X0, FX1 = X1;
      if (main && erSlot && erSlot.end === 'front') {
        const e = erSlot, walkX = e.fx0 - e.x0 > e.x1 - e.fx1 ? (e.x0 + e.fx0) / 2 : (e.fx1 + e.x1) / 2;
        const r = { id: id('er-entrance'), kind: 'store', use: 'er_entrance', name: 'Engine room entrance & changing room', x0: e.x0, x1: e.x1, z0: e.z0, z1: e.z1, doors: [{ to: lobby.id, side: 's', at: r2(clamp(walkX, e.x0 + 0.5, e.x1 - 0.5)), w: 0.9 }], furn: 'lockers', win: [] };
        rooms.push(r); e.room = r.id;
        if (e.side < 0) FX0 = e.x1; else FX1 = e.x0;
      }
      const FW = FX1 - FX0, m = clamp(Math.floor(FW / 3.2), 1, 6);
      for (let i = 0; i < m; i++) {
        const a = FX0 + (FW * i) / m, b = FX0 + (FW * (i + 1)) / m;
        slots.push({ band: 'f', i, x0: r2(a), x1: r2(b), z0: fz0, z1: fz1, door: { to: lobby.id, side: 's', at: r2((a + b) / 2 + (b - a > 2.6 ? 0.55 : 0)), w: 0.9 }, win: ['n', ...(Math.abs(a - X0) < 0.01 ? ['w'] : []), ...(Math.abs(b - X1) < 0.01 ? ['e'] : [])] });
      }
    } else {
      // centre spine corridor from the lobby forward; a full-width front room; rooms either side of the spine
      const frontD = top ? Math.min(8.5, depth - 3) : main ? Math.min(5, depth - 3) : 0;
      const pz0 = r2(fz0 + frontD), xc = r2((X0 + X1) / 2), pw = 0.65;
      const spine = { id: id('spine'), kind: 'passage', use: 'corridor', name: `Passage (${lv.name})`, x0: r2(xc - pw), x1: r2(xc + pw), z0: pz0, z1: fz1, doors: [{ to: lobby.id, side: 's', at: xc, w: r2(2 * pw - 0.1), kind: 'open' }] };
      rooms.push(spine);
      if (top) rooms.push({ id: id('bridge'), kind: 'bridge', use: 'bridge', name: 'Bridge', x0: X0, x1: X1, z0: fz0, z1: pz0, doors: [{ to: spine.id, side: 's', at: xc, w: 1.2, kind: 'open' }], win: ['n', 'e', 'w'] });
      else if (frontD > 0) slots.push({ band: 'f', i: 0, x0: X0, x1: X1, z0: fz0, z1: pz0, door: { to: spine.id, side: 's', at: xc, w: 1.1 }, win: ['n', 'w', 'e'], big: true });
      const segs = splitEven(pz0, fz1, 3.4, 2.4);
      const erF = main && erSlot && erSlot.end === 'front' ? erSlot : null;
      if (erF) {
        const ez0 = erF.z0 - pz0 < 2.2 ? pz0 : erF.z0;
        const walkZ = (ez0 + erF.z0) / 2 + LAND * 0.5 + 0.3;
        const r = { id: id('er-entrance'), kind: 'store', use: 'er_entrance', name: 'Engine room entrance & changing room', x0: erF.x0, x1: erF.x1, z0: r2(ez0), z1: erF.z1, doors: [{ to: spine.id, side: erF.side < 0 ? 'e' : 'w', at: r2(clamp(erF.z0 + LAND * 0.5 + 0.1, ez0 + 0.6, erF.z1 - 0.6)), w: 0.9 }], furn: 'lockers', win: [erF.side < 0 ? 'w' : 'e'] };
        void walkZ; rooms.push(r); erF.room = r.id; erF.z0 = r.z0;
      }
      for (const side of [-1, 1]) (erF && erF.side === side ? (erF.z0 - pz0 >= 2.2 ? splitEven(pz0, erF.z0, 3.4, 2.2) : []) : segs).forEach(([a, b]) => {
        const x0 = side < 0 ? X0 : r2(xc + pw), x1 = side < 0 ? r2(xc - pw) : X1;
        if (x1 - x0 < 1.6) return;
        slots.push({ band: frontD > 0 || a > fz0 + 0.01 ? (side < 0 ? 'p' : 's') : 'f', x0, x1, z0: a, z1: b, door: { to: spine.id, side: side < 0 ? 'e' : 'w', at: r2((a + b) / 2), w: 0.9 }, win: [side < 0 ? 'w' : 'e', ...(a <= fz0 + 0.01 ? ['n'] : [])] });
      });
    }
    tiers.push({ ...lv, rooms, slots, prog });
  });
  return { core, tiers, layout: 'spine', erSlot, assign: assignSlots };
}

/** Fill a tier's slots with its programme (front items first); returns the items that did not fit. */
function assignSlots(tier, idOf) {
  const left = [];
  const slots = tier.slots.slice();
  const take = (pred) => { const i = slots.findIndex(pred); return i < 0 ? null : slots.splice(i, 1)[0]; };
  const items = tier.prog.slice().sort((a, b) => (b.at === 'front') - (a.at === 'front'));
  let n = tier._n || 0;
  for (const it of items) {
    let s = it.at === 'front' ? take((q) => q.band === 'f') || take(() => true)
      : it.at === 'aftA' || it.at === 'aftNav' ? take((q) => q.band === 'a') || take((q) => q.band !== 'f') || take(() => true)
        : take((q) => q.band !== 'f') || take(() => true);
    if (!s) { left.push(it); continue; }
    const area = (s.x1 - s.x0) * (s.z1 - s.z0);
    // a mess / galley / day room wants space: merge a neighbouring slot of the same band
    if (['mess', 'galley', 'dayroom', 'lounge', 'gym', 'winch', 'owner', 'aftbridge', 'lab'].includes(it.furn) && area < (it.furn === 'winch' || it.furn === 'owner' ? 22 : 14)) {
      const j = slots.findIndex((q) => q.band === s.band && ((s.band === 'f' || s.band === 'a') ? (Math.abs(q.x0 - s.x1) < 0.01 || Math.abs(q.x1 - s.x0) < 0.01) : (Math.abs(q.z0 - s.z1) < 0.01 || Math.abs(q.z1 - s.z0) < 0.01)));
      if (j >= 0) { const q = slots.splice(j, 1)[0]; s = { ...s, x0: Math.min(s.x0, q.x0), x1: Math.max(s.x1, q.x1), z0: Math.min(s.z0, q.z0), z1: Math.max(s.z1, q.z1), win: [...new Set([...s.win, ...q.win])] }; }
    }
    tier.rooms.push({ id: idOf(n++), kind: it.kind, use: it.use, name: it.name, x0: s.x0, x1: s.x1, z0: s.z0, z1: s.z1, doors: [s.door], win: s.win, furn: it.furn, berth: it.berth || 0, officer: !!it.officer });
  }
  tier.slots = slots; tier.prog = []; tier._n = n;
  return left;
}
/** Empty slots become spare cabins (furnished) or stores. */
const YACHT_SPARE = [['Guest lounge', 'mess', 'lounge'], ['Day head', 'store', 'wc'], ['Pantry', 'store', 'shelves'], ['Cinema room', 'mess', 'lounge'], ['Gym', 'mess', 'gym']];
function fillSpares(tier, idOf, yacht = false) {
  let n = tier._n || 0, k = 0;
  for (const s of tier.slots) {
    if (yacht && tier.use !== 'lower') { const [name, kind, furn] = YACHT_SPARE[k++ % YACHT_SPARE.length]; tier.rooms.push({ id: idOf(n++), kind, use: 'spare', name, x0: s.x0, x1: s.x1, z0: s.z0, z1: s.z1, doors: [s.door], win: s.win, furn, berth: 0 }); continue; }
    tier.rooms.push({ id: idOf(n++), kind: tier.use === 'bridge' || tier.use === 'main' ? 'store' : 'cabin', use: 'spare', name: tier.use === 'bridge' ? 'Store' : tier.use === 'main' ? 'Store room' : 'Spare cabin', x0: s.x0, x1: s.x1, z0: s.z0, z1: s.z1, doors: [s.door], win: s.win, furn: tier.use === 'bridge' || tier.use === 'main' ? 'shelves' : 'cabin', berth: 0 });
  }
  delete tier.slots; delete tier.prog; delete tier._n;
}

/**
 * Build a merchant-style house: tiers from yMain upward, programme, layout; grows the house aft/longer until all the
 * cabins fit. opts: { pos, X0, X1, Z0, Z1 (initial), zMinFwd, zMaxAft, nAcc, tierH, bridgeD, extra, erColumn, spine }
 */
function buildHouse(ga, o) {
  let { Z0, Z1 } = o;
  for (let attempt = 0; attempt < 14; attempt++) {
    const levels = [];
    for (let k = 0; k < o.nAcc; k++) levels.push({ id: String.fromCharCode(65 + k), y: r2(o.yMain + k * o.tierH), h: r2(o.tierH - 0.12), use: k === 0 ? 'main' : 'accom', name: k === 0 ? 'A-deck (main deck)' : `${String.fromCharCode(65 + k)}-deck` });
    levels.push({ id: 'nav', y: r2(o.yMain + o.nAcc * o.tierH), h: 2.75, use: 'bridge', name: 'Bridge deck' });
    const progs = levels.map((lv, k) => tierProgramme(ga, lv.use, k, levels.length, o.extra || {}));
    crewProgramme(ga, progs.slice(0, -1));
    for (const it of o.more || []) {
      if (it.at === 'aftA') progs[0].push(it);
      else if (it.at === 'aftNav') progs[progs.length - 1].push(it);
      else { const acc = progs.slice(1, -1); (acc.length ? acc : [progs[0]]).reduce((a, b) => (a.length <= b.length ? a : b)).push(it); }
    }
    const L = layoutHouse(ga, { X0: o.X0, X1: o.X1, Z0, Z1, levels, progs, roomD: o.roomD, bridgeD: o.bridgeD, erColumn: o.erColumn, spine: o.spine });
    // tier by tier; what does not fit moves up a tier (never onto the bridge deck), then back down into free slots
    let carry = [];
    const acc = L.tiers.slice(0, -1);
    for (const t of acc) { t.prog = [...t.prog, ...carry]; carry = L.assign(t, (n) => `${t.id}-r${n}`); }
    for (const t of acc.slice().reverse()) { if (!carry.length) break; t.prog = carry; carry = L.assign(t, (n) => `${t.id}-r${n}`); }
    L.assign(L.tiers[L.tiers.length - 1], (n) => `${L.tiers[L.tiers.length - 1].id}-r${n}`);
    const left = carry.filter((i) => i.berth).length;
    if (!left || attempt === 13) {
      for (const t of L.tiers) fillSpares(t, (n) => `${t.id}-r${n}`);
      return { pos: o.pos, z0: r2(Z0), z1: r2(Z1), w: r2(o.X1 - o.X0), x0: o.X0, x1: o.X1, tiers: L.tiers, core: L.core, layout: L.layout, erSlot: L.erSlot, eyeY: r2(levels[levels.length - 1].y + 1.6), overflow: left };
    }
    // grow: longer forward when allowed, else aft
    if (o.pos === 'fwd' ? Z1 + 2.4 <= o.zMaxAft : Z0 - 2.4 >= o.zMinFwd) { if (o.pos === 'fwd') Z1 = r2(Z1 + 2.4); else Z0 = r2(Z0 - 2.4); }
    else if (o.pos !== 'fwd' && Z1 + 2.4 <= o.zMaxAft) Z1 = r2(Z1 + 2.4);
    else if (o.nAcc < (o.nMax ?? o.nAcc + 2)) o = { ...o, nAcc: o.nAcc + 1 };
    else attempt = 12;
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ engine room
function engineRoom(ga, m, o) {
  const L = ga.L, kind = m.engine?.kind === 'aux' ? '4s' : m.engine?.kind || '4s', n = m.engine?.n || 1;
  const de = kind === 'de';
  const meKind = de ? '4s' : kind;
  const nMe = de ? (m.kW <= 10000 ? 4 : m.kW <= 40000 ? 5 : 6) : n;
  const me = meDims(meKind, m.kW, nMe);
  const floorY = r2(o.floorY ?? (-ga.Tk + (ga.small ? 0.5 : ga.db)));
  const top = o.topY ?? ga.deckY, H = top - floorY;
  const step = o.levelStep || (L >= 100 ? RULES.ER_LEVEL : RULES.ER_LEVEL_SMALL);
  let nLv = Math.max(1, Math.ceil(H / step - 1e-6));
  while (nLv > 1 && H / nLv < 2.3) nLv--;
  const levels = []; for (let i = 0; i < nLv; i++) levels.push(r2(floorY + (H * i) / nLv));
  // engines side by side: one on the centreline; two or more across (DE gensets in two rows when 5–6)
  const xs = [];
  const nAcross = nMe === 1 ? 1 : 2;
  const gap = Math.max(1.2, me.w * 0.9);
  if (nAcross === 1) xs.push(0); else xs.push(r2(-(me.w + gap) / 2), r2((me.w + gap) / 2));
  const rows = Math.ceil(nMe / nAcross);
  const span0 = me.len * rows + 1.2 * (rows - 1);
  const len = Math.max(o.len ?? Math.max(ga.small ? 4 : 8, (RULES.ER_LEN[kind] || 0.12) * L * (o.lenMul || 1)), span0 + 5.5);
  const z1 = r2(o.z1), z0 = r2(z1 - len);
  const meZ = r2(o.meZ ?? Math.max(z0 + 2.4 + span0 / 2, z1 - Math.max(2.2, len * 0.12) - span0 / 2));
  const gens = de ? null : { n: 3, ...meDims('4s', Math.max(150, m.kW * 0.07)) };
  return {
    z0, z1, floorY, levels, top: r2(top), kind,
    me: { kind: meKind, n: nMe, rows, len: me.len, w: me.w, h: me.h, xs, z: meZ, de },
    gens, ecr: { level: nLv - 1, side: o.ecrSide || 1 }, purifier: m.kW >= 1500, boiler: m.kW >= 5000, workshop: L >= 40,
    steering: o.steering || null, escape: o.escape || null, shaft: o.shaft || null, column: null, sb: o.sb || null,
  };
}

// ------------------------------------------------------------------------------------------------ bridge consoles
function bridgeConsoles(ga, br, { aft = false, fishing = false, small = false } = {}) {
  const W = br.x1 - br.x0, c = [];
  const z = br.z0 + 0.75, y = br.y;
  const big = ga.gt >= 3000 && !small;
  c.push({ id: 'steering', kind: 'steering', x: 0, z, w: Math.min(1.6, W * 0.3), label: 'Steering stand: wheel, autopilot, rudder indicator' });
  if (!small) {
    const s1 = Math.min(W / 2 - 1.2, 2.4);
    c.push({ id: 'radar-x', kind: 'radar', band: 'X', x: r2(Math.min(1.6, s1 * 0.6)), z, w: 1.0, label: 'X-band radar' });
    c.push({ id: 'conning', kind: 'conning', x: r2(Math.min(2.7, s1)), z, w: 0.9, label: 'Conning display' });
    c.push({ id: 'telegraph', kind: 'telegraph', x: r2(Math.min(0.95, s1 * 0.35)), z: r2(z + 0.05), w: 0.5, label: 'Engine telegraph' });
    if (big) c.push({ id: 'radar-s', kind: 'radar', band: 'S', x: r2(-Math.min(1.6, s1 * 0.6)), z, w: 1.0, label: 'S-band radar' });
    c.push({ id: 'ecdis-1', kind: 'ecdis', x: r2(-Math.min(big ? 2.7 : 1.6, s1)), z, w: 0.9, label: 'ECDIS (primary)' });
    if (W > 7) c.push({ id: 'ecdis-2', kind: 'ecdis', x: r2(-Math.min(big ? 3.7 : 2.6, s1 + 1)), z, w: 0.9, label: 'ECDIS (backup)' });
    c.push({ id: 'gmdss', kind: 'gmdss', x: r2(br.x0 + 0.9), z: r2(br.z1 - 1.0), w: 1.4, label: 'GMDSS station: VHF/MF/HF DSC, NAVTEX' });
    c.push({ id: 'chart', kind: 'chart', x: r2(br.x1 - 1.1), z: r2(br.z1 - 1.0), w: 1.4, label: 'Chart table' });
    c.push({ id: 'bnwas', kind: 'panel', x: r2(br.x0 + 0.35), z: r2(br.z0 + 2.0), w: 0.6, label: 'BNWAS, alarm, fire and navigation-light panels' });
  } else {
    c.push({ id: 'mfd', kind: 'ecdis', x: r2(-Math.min(0.9, W * 0.2)), z, w: 0.7, label: 'Plotter / radar MFD' });
  }
  if (fishing) c.push({ id: 'sonar', kind: 'sonar', x: r2(-Math.min(1.8, W / 2 - 0.9)), z, w: 0.8, label: 'Sonar and echo sounder' });
  if (aft) c.push({ id: 'aft', kind: 'aft', x: 0, z: r2(br.z1 - 0.7), w: Math.min(2.4, W * 0.4), label: 'Aft control station (winches, thrusters, joystick)' });
  return c;
}

// ------------------------------------------------------------------------------------------------ generators (§6.4)
// GEN[gen](mk, m) → GA. mk() returns a fresh base record, so a generator can rebuild with more house tiers until the
// bridge sees the sea ahead as SOLAS V/22 requires.
const GEN = {};

/** Narrowest deck half-breadth between z0 and z1. */
function deckMin(ga, z0, z1) { let m = Infinity; for (let i = 0; i <= 12; i++) m = Math.min(m, deckHalf(ga, z0 + ((z1 - z0) * i) / 12)); return m; }
function holdsAlong(z0, z1, n) { const out = [], hl = (z1 - z0) / n; for (let i = 0; i < n; i++) out.push({ z0: r2(z0 + hl * i), z1: r2(z0 + hl * (i + 1)) }); return out; }
/** Eye height needed over every recorded forward obstruction. */
function eyeNeed(ga) {
  const dMax = Math.min(2 * ga.L, 500);
  let need = 0;
  // obstructions well off the centreline (side cranes) make blind sectors (≤ 10° each, V/22.1.3), not a blind distance ahead
  for (const o of ga.obstructions) if (o.z < ga.bridge.z0 && Math.abs(o.x || 0) <= ga.B / 4) need = Math.max(need, eyeFor(ga.L, ga.bridge.z0, o.z, o.y, dMax));
  return r2(need);
}
function withEye(mk, n0, nMax, build) {
  let ga = null;
  for (let n = n0; n <= nMax; n++) { ga = mk(); build(ga, n); ga.eyeNeed = eyeNeed(ga); if (ga.eyeNeed <= ga.house.eyeY + 1e-6) break; }
  return ga;
}

/** Engine-room stair column test: inside the plating on every ER level, inside the ER box. */
function columnFits(ga, er) {
  const rise = (er.top - er.floorY) / er.levels.length;
  return (slot) => {
    for (const y of er.levels) { const hh = fitHalf(ga, slot.z0, slot.z1, y, y + rise) - 0.45; if (Math.max(Math.abs(slot.fx0), Math.abs(slot.fx1)) > hh) return false; }
    return true;
  };
}
function columnFromSlot(er, s) {
  const rise = (er.top - er.floorY) / er.levels.length, run = Math.max(2.2, stairRun(rise, RULES.ER_STAIR_DEG));
  return { x0: s.fx0, x1: s.fx1, runZ0: r2(s.z0 + LAND), runZ1: r2(s.z0 + LAND + run), z0: s.z0, z1: s.z1, deg: RULES.ER_STAIR_DEG, top: 'house', entrance: s.room, side: s.side };
}
/** ER stair column inside an engine casing deckhouse on deck (the ER is not under the house). */
function casingColumn(ga, er, { side = -1, z0 = null, x = null, zEnd = null } = {}) {
  const rise = (er.top - er.floorY) / er.levels.length, run = Math.max(2.2, stairRun(rise, RULES.ER_STAIR_DEG));
  const TL = r2(2 * LAND + run + 0.3);
  if (zEnd != null) z0 = zEnd - TL;
  const cz0 = z0 != null ? r2(z0) : r2(Math.max(er.z0 + 1.0, er.z1 - 1.0 - TL)), cz1 = r2(cz0 + TL);
  let fx0 = x;
  if (fx0 == null) {
    const hh = fitHalf(ga, cz0, cz1, er.floorY, er.top) - 0.5;
    const off = clamp(hh - 2.6, 0.2, 5);
    fx0 = side < 0 ? r2(-off - FL) : r2(off);
  }
  return { x0: r2(fx0 + 0.06), x1: r2(fx0 + FL - 0.04), runZ0: r2(cz0 + LAND), runZ1: r2(cz0 + LAND + run), z0: cz0, z1: cz1, deg: RULES.ER_STAIR_DEG, top: 'casing', entrance: 'er-casing', side, cx0: r2(Math.min(fx0, fx0 + FL) - 0.1), cx1: r2(fx0 + 2 * FL + 0.2) };
}
/** Move the engines clear of the ER stair column (fore or aft of it) when they share its x band. */
function placeEngines(er) {
  const c = er.column, me = er.me; if (!c) return;
  const ex0 = Math.min(...me.xs) - me.w / 2 - 0.7, ex1 = Math.max(...me.xs) + me.w / 2 + 0.7;
  const span = me.len * me.rows + 1.2 * (me.rows - 1);
  const fwdEnd = r2(c.z0 - 0.9 - span / 2), aftEnd = r2(c.z1 + 0.9 + span / 2);
  if (c.x1 < ex0 - 0.3 || c.x0 > ex1 + 0.3) return;
  if (fwdEnd - span / 2 >= er.z0 + 1.2) me.z = fwdEnd;
  else if (aftEnd + span / 2 <= er.z1 - 1.2) me.z = aftEnd;
  else { er.z0 = r2(fwdEnd - span / 2 - 2.4); me.z = fwdEnd; }
}

/** Bridge record from the top tier of a house. */
function bridgeOf(ga, house, o = {}) {
  const nav = house.tiers[house.tiers.length - 1];
  const br = nav.rooms.find((r) => r.use === 'bridge');
  const encl = o.enclosed || (ga.ice && /^(i1a|i1as|pc)/.test(ga.ice));
  const b = { y: nav.y, h: nav.h, z0: br.z0, z1: br.z1, x0: br.x0, x1: br.x1, room: br.id, wings: o.wings === false ? 'none' : encl ? 'enclosed' : 'open', wingTo: r2(Math.min(ga.B / 2 - 0.3, Math.max(br.x1 + 1.6, o.wingTo ?? ga.B / 2 - 0.3))), wingD: r2(Math.min(3.4, br.z1 - br.z0 - 0.6)), consoles: [], aftConsole: !!o.aft, compassY: r2(nav.y + nav.h + 0.12) };
  b.consoles = bridgeConsoles(ga, b, o);
  return b;
}

/** Aft-house merchant ship: forecastle, engine room aft, house over it, mooring decks, lifesaving. */
function merchantAft(ga, m, o = {}) {
  const L = ga.L, B = ga.B, yD = ga.deckY;
  const tierH = RULES.TIER_H.merchant;
  if (L >= 60 && o.fcsle !== false) ga.hull.fcsle = { len: r2(clamp((o.fcsleFrac || 0.08) * L, 6, 30)), h: L >= 150 ? 2.6 : 2.4 };
  const aftPeak = r2(clamp(0.05 * L, 3.5, 16));
  const er = engineRoom(ga, m, { z1: r2(L / 2 - aftPeak) });
  const poop = r2(clamp(0.045 * L, 4, 14));
  const hz1 = r2(L / 2 - poop);
  let hl0 = r2(clamp(0.085 * L, 11, 30));
  const hw = r2(Math.min(clamp((o.houseW || 0.66) * B, 8, 44), 2 * (deckMin(ga, hz1 - hl0 - 6, hz1 + 1) - 0.45 - 1.5)));
  const bridgeD = L >= 150 ? 7.0 : L >= 100 ? 6.0 : 5.0;
  if (hw >= 16) hl0 = r2(Math.max(hl0, Math.max(RULES.ROOM_D, bridgeD - CW) + RULES.ROOM_D + 2 * CW + 6.6));   // room for the ring layout
  const house = buildHouse(ga, { pos: 'aft', X0: r2(-hw / 2), X1: r2(hw / 2), Z0: r2(hz1 - hl0), Z1: hz1, zMinFwd: r2(er.z0 - 12), zMaxAft: r2(L / 2 - 3.5), nAcc: o.nAcc, tierH, yMain: yD, bridgeD, extra: o.extra, erColumn: { rise: (er.top - er.floorY) / er.levels.length, deg: RULES.ER_STAIR_DEG, fits: columnFits(ga, er) } });
  ga.house = house;
  er.column = house.erSlot ? columnFromSlot(er, house.erSlot) : casingColumn(ga, er, { side: 1, zEnd: r2(house.z0 - 1.0) });
  er.z0 = r2(Math.min(er.z0, er.column.z0 - 1.5)); er.z1 = r2(Math.max(er.z1, er.column.z1 + 0.8));
  placeEngines(er);
  er.steering = { z0: er.z1, z1: r2(Math.min(L / 2 - 1.2, er.z1 + Math.max(3.5, aftPeak * 0.8))), y: er.levels[er.levels.length - 1] };
  er.ecr.side = er.column.side > 0 ? -1 : 1;
  er.escape = { side: -er.column.side, z: r2(Math.min(L / 2 - 2.5, house.z1 + 1.8)) };
  ga.er = er;
  const cas = house.tiers[0].rooms.find((r) => r.use === 'casing');
  ga.casing = cas ? { z0: cas.z0, z1: cas.z1, w: r2(cas.x1 - cas.x0), x0: cas.x0, x1: cas.x1 } : { z0: r2(house.z1 - 4), z1: r2(house.z1 - 1), w: 2.4, x0: r2(house.x1 - 3.4), x1: r2(house.x1 - 1) };
  ga.bridge = bridgeOf(ga, house);
  ga.funnel = { z: r2((ga.casing.z0 + ga.casing.z1) / 2 + 0.5), x: r2((ga.casing.x0 + ga.casing.x1) / 2), y: ga.bridge.compassY, r: r2(clamp(0.045 * B, 0.8, 3.2)), h: r2(clamp(0.035 * L, 3.5, 12)), kind: o.funnel || 'single' };
  // mooring: forecastle windlasses + winches, aft mooring winches
  const fc = ga.hull.fcsle;
  if (fc) {
    const yF = r2(yD + fc.h);
    for (const side of [-1, 1]) ga.deck.mooring.push({ z: r2(-L / 2 + fc.len * 0.5), kind: 'windlass', side, y: yF }, { z: r2(-L / 2 + fc.len * 0.8), kind: 'winch', side, y: yF });
    ga.deck.masts.push({ z: r2(-L / 2 + Math.max(1.6, fc.len * 0.22)), x: 0, h: r2(clamp(L * 0.06, 6, 16)), y: yF });
  }
  const aftZ = r2(Math.min(L / 2 - 2.6, (house.z1 + L / 2) / 2 + 0.6));
  for (const side of [-1, 1]) ga.deck.mooring.push({ z: aftZ, kind: 'winch', side, y: yD });
  // lifesaving: free-fall lifeboat on its ramp at the stern, rescue boat on a davit, liferafts both sides
  ga.deck.boats.push({ kind: o.boats || 'freefall', z: r2(house.z1 + 2.2), x: 0, y: r2(yD + tierH * Math.min(2, (o.nAcc || 3) - 1)) });
  ga.deck.boats.push({ kind: 'rescue', z: r2(house.z0 + Math.min(4, (house.z1 - house.z0) * 0.4)), x: r2(house.x1 + 1.5), y: yD, side: 1 });
  for (const side of [-1, 1]) ga.deck.boats.push({ kind: 'raft', z: r2(house.z0 + (house.z1 - house.z0) * 0.75), x: r2(side * (hw / 2 + 0.9)), y: yD, side });
  ga.deck.gangway = { z: r2(house.z0 + 1.5), side: -1 };
  ga.deck.pilotLadder = { z: r2(-0.05 * L), side: 1 };
  ga.deck.masts.push({ z: r2(ga.bridge.z0 + 2.4), x: 0, h: r2(clamp(L * 0.035, 4, 10)), y: ga.bridge.compassY, radar: true });
  if (fc) ga.obstructions.push({ z: r2(-L / 2 + 1), y: r2(yD + fc.h + 1.1), what: 'forecastle bulwark' });
  return ga;
}

GEN.aft_house_dry = (mk, m) => {
  const gt = m.gt || 0, livestock = m.id === 'livestock135';
  const n0 = livestock ? 6 : gt < 3000 ? 3 : gt < 10000 ? 4 : gt < 60000 ? 5 : gt < 150000 ? 6 : 7;
  return withEye(mk, n0, n0 + 3, (ga, nAcc) => {
    const L = ga.L, B = ga.B, yD = ga.deckY;
    const geared = ga.opts.gear === 'geared' || (ga.opts.gear == null && (m.eq || []).some((e) => /^cranes:/.test(e)));
    merchantAft(ga, m, { nAcc });
    const fc = ga.hull.fcsle, h = ga.house;
    const c0 = r2((fc ? -L / 2 + fc.len : -L / 2 + 0.12 * L) + 3.2), c1 = r2(Math.min(h.z0 - 3, ga.er.z0 - 0.3));
    if (livestock) {
      const decks = []; for (let k = 0; k < 4; k++) decks.push({ y: r2(yD + k * 2.6), h: 2.48 });
      ga.cargo = { kind: 'pens', zones: [{ z0: c0, z1: c1, decks, w: r2(2 * (deckMin(ga, c0, c1) - 0.45) - 2.4) }] };
      ga.obstructions.push({ z: c0, y: r2(yD + 4 * 2.6 + 0.4), what: 'pen decks' });
      return;
    }
    const nHold = m.units?.holds || (m.type === 'bulk' ? Math.max(5, Math.round(L / 38)) : Math.max(1, Math.round(L / 45)));
    const hatchW = m.type === 'bulk' ? 0.55 : m.units?.teu ? 0.74 : 0.62, coaming = m.type === 'bulk' ? 2.3 : 1.6;
    const craneSpec = geared ? /cranes:(\d+)x(\d+)/.exec((m.eq || []).find((e) => /^cranes:/.test(e)) || 'cranes:4x30') : null;
    const heavyPed = craneSpec && +craneSpec[2] >= 200 ? 4.0 : 0;   // side cranes: the walkway passes inboard of the pedestals
    const zones = holdsAlong(c0, c1, nHold).map((z, i) => {
      const len = z.z1 - z.z0, w = Math.min(hatchW * B, 2 * (deckMin(ga, z.z0 - 1, z.z1 + 1) - 0.45 - 1.9 - (heavyPed ? heavyPed + 1.4 : 0)));
      return { kind: 'hold', i, z0: z.z0, z1: z.z1, hatch: { z0: r2(z.z0 + Math.min(1.6, len * 0.08)), z1: r2(z.z1 - Math.min(1.6, len * 0.08)), w: r2(w), h: coaming }, floorY: r2(-ga.T + ga.db), hopper: m.type === 'bulk' };
    });
    ga.cargo = { kind: 'holds', zones, walk: zones.length - 1, teu: m.units?.teu || 0 };
    for (const z of zones) ga.obstructions.push({ z: z.hatch.z0, y: r2(yD + coaming + 0.3), what: 'hatch coaming' });
    if (geared) {
      const spec = (m.eq || []).find((e) => /^cranes:/.test(e)) || 'cranes:4x30';
      const [, nS, swlS] = /cranes:(\d+)x(\d+)/.exec(spec) || [0, '4', '30'];
      const swl = +swlS, heavy = swl >= 200;
      const between = []; for (let i = 0; i < zones.length - 1; i++) between.push(r2((zones[i].z1 + zones[i + 1].z0) / 2));
      if (!between.length) between.push(r2(zones[0].z0 - 0.2), r2(zones[0].z1 + 0.2));
      const nC = Math.min(+nS, between.length);
      const picks = heavy ? between.slice(0, nC) : between.length <= nC ? between : between.filter((_, i) => i % 2 === 0).slice(0, nC);
      picks.forEach((z, i) => {
        const x = heavy ? (i % 2 ? 1 : -1) * r2(deckMin(ga, z - 3, z + 3) - 0.45 - 2.05) : 0, ch = r2(clamp(7 + Math.sqrt(swl) * 0.8, 9, 22));
        ga.deck.cranes.push({ z, x, swl, boom: r2(clamp(20 + Math.sqrt(swl) * 1.6, 20, 48)), h: ch, ped: heavy ? 4.0 : 2.6 });
        ga.obstructions.push({ z, x, y: r2(yD + ch), what: 'crane house' });
      });
    }
  });
};

GEN.aft_house_tanker = (mk, m) => {
  const gt = m.gt || 0, n0 = gt < 3000 ? 3 : gt < 10000 ? 4 : gt < 60000 ? 5 : gt < 150000 ? 6 : 7;
  return withEye(mk, n0, n0 + 3, (ga, nAcc) => {
    const L = ga.L, B = ga.B, yD = ga.deckY, gas = m.type === 'gas';
    merchantAft(ga, m, { nAcc, fcsleFrac: 0.07, extra: { ccr: true } });
    const fc = ga.hull.fcsle, h = ga.house;
    const c0 = r2((fc ? -L / 2 + fc.len : -L / 2 + 0.1 * L) + 2), c1 = r2(Math.min(h.z0 - 3, ga.er.z0 - (m.id === 'tanker' ? 4.5 : 0.3)));
    const nT = clamp(Math.round((c1 - c0) / 26), 3, 8);
    ga.cargo = { kind: 'tanks', gas, pumpRoom: m.id === 'tanker', deepwell: m.id !== 'tanker', zones: holdsAlong(c0, c1, nT).map((z, i) => ({ kind: gas ? 'gastank' : 'tank', i, ...z, segregations: m.units?.segregations || 6 })) };
    const mz = r2((c0 + c1) / 2);
    const pw = r2(Math.min(B * 0.36, 2 * (deckMin(ga, c0, c1) - 0.45 - 3.0)));
    ga.cargo.pipes = { z0: c0, z1: c1, w: pw };
    ga.deck.manifold = { z: mz, w: pw };
    ga.deck.catwalk = { z0: r2(fc ? -L / 2 + fc.len : c0), z1: r2(c1 + 0.4), y: r2(yD + (fc ? fc.h : 2.4)), w: 1.1, x: r2(-pw / 2 - 1.0) };
    const nHC = Number(((m.eq || []).find((e) => /^hoseCranes:/.test(e)) || 'hoseCranes:1').split(':')[1]);
    const room = deckMin(ga, mz - 8, mz + 8) - 0.45;
    for (let i = 0; i < Math.max(1, nHC); i++) {
      const x = i % 2 ? -(pw / 2 + 2.9) : pw / 2 + 1.6;
      if (Math.abs(x) + 1.3 > room) continue;
      ga.deck.hoseCranes.push({ z: r2(mz + (i ? 6.5 : -6.5)), x: r2(x), swl: 10, h: 9 });
    }
    if (gas) {
      ga.deck.domes = ga.cargo.zones.map((z) => ({ z: r2((z.z0 + z.z1) / 2), x: r2(pw / 2 - 1.2), r: r2(clamp(B * 0.05, 0.8, 1.6)), h: 1.6, y: yD }));
      ga.deck.compressor = { z0: r2(c1 - 9), z1: r2(c1 - 1), x0: r2(-pw / 2 + 0.2), x1: r2(pw / 2 - 0.2), y: yD };
      ga.cargo.pipes.z1 = r2(c1 - 9.6);
    }
    for (const z of ga.cargo.zones) ga.obstructions.push({ z: z.z0, y: r2(yD + 2.6), what: 'pipe rack' });
  });
};

GEN.lng = (mk, m) => withEye(mk, 6, 9, (ga, nAcc) => {
  const L = ga.L, B = ga.B, yD = ga.deckY;
  merchantAft(ga, m, { nAcc, fcsleFrac: 0.07, extra: { ccr: true }, funnel: 'twin' });
  const fc = ga.hull.fcsle, h = ga.house;
  const c0 = r2((fc ? -L / 2 + fc.len : -L / 2 + 0.1 * L) + 4), c1 = r2(Math.min(h.z0 - 6.5, ga.er.z0 - 0.3));
  const trunkH = 3.4, trunkW = r2(Math.min(B * 0.6, 2 * (deckMin(ga, c0, c1) - 0.45 - 3.0)));
  const zones = holdsAlong(c0, c1, 4).map((z, i) => ({ kind: 'membrane', i, ...z }));
  ga.cargo = { kind: 'membrane', zones, trunk: { z0: c0, z1: c1, y: r2(yD + trunkH), w: trunkW } };
  ga.deck.domes = zones.map((z) => ({ z: r2((z.z0 + z.z1) / 2), x: 0, r: 1.6, h: 2.2, y: r2(yD + trunkH) }));
  ga.deck.compressor = { z0: r2(c1 - 16), z1: r2(c1 - 4), x0: r2(-Math.min(trunkW / 2 - 1.6, 6)), x1: r2(Math.min(trunkW / 2 - 1.6, 6)), y: r2(yD + trunkH) };
  ga.deck.manifold = { z: r2((c0 + c1) / 2 + 6), w: trunkW };
  ga.obstructions.push({ z: c0, y: r2(yD + trunkH + 2.4), what: 'trunk deck + domes' });
});

GEN.container = (mk, m) => {
  const teu = m.units?.teu || 1000, CT = RULES.CONTAINER;
  const twin = teu >= 14000, threeQ = !twin && m.length >= 210;
  const tOn = teu < 1500 ? 4 : teu < 3000 ? 5 : teu < 6000 ? 6 : teu < 10000 ? 7 : teu < 15000 ? 8 : 10;
  const n0 = teu < 1500 ? 5 : teu < 3000 ? 6 : 7;
  const stackTop = (ga, t) => r2(ga.deckY + CT.coaming + t * CT.tier);
  let ga = null;
  for (let nAcc = n0; nAcc <= 13; nAcc++) {
    ga = mk();
    if (!twin && !threeQ) merchantAft(ga, m, { nAcc, fcsleFrac: 0.06 });
    else midHouseShip(ga, m, { nAcc, twin });
    // the stack right ahead of the bridge must stay under the sight line at full height
    const need = eyeFor(ga.L, ga.bridge.z0, ga.house.z0 - 3 - CT.bay, stackTop(ga, tOn), Math.min(2 * ga.L, 500));
    if (need <= ga.house.eyeY || nAcc === 13) break;
  }
  const L = ga.L, B = ga.B, yD = ga.deckY, h = ga.house, fc = ga.hull.fcsle;
  const zE = ga.bridge.z0, dMax = Math.min(2 * L, 500), eyeY = h.eyeY;
  const rows = Math.floor((B - 1.2) / CT.row), pitch = CT.bay + CT.lash;
  const segs = [[r2(-L / 2 + fc.len + 4.2), r2(h.z0 - 2)]];
  if (twin) { segs.push([r2(h.z1 + 2), r2(ga.casing.z0 - 2)], [r2(ga.casing.z1 + 2), r2(L / 2 - Math.max(7, 0.05 * L))]); }
  else if (threeQ) segs.push([r2(h.z1 + 2), r2(L / 2 - Math.max(7, 0.05 * L))]);
  const bays = [];
  for (const [a, b] of segs) {
    const nb = Math.floor((b - a + CT.lash) / pitch);
    const start = r2(b - nb * pitch + CT.lash);
    for (let i = 0; i < nb; i++) {
      const z0 = r2(start + i * pitch), z1 = r2(z0 + CT.bay);
      const r = Math.min(rows, Math.floor((2 * (deckMin(ga, z0 - 1, z1 + 1) - 0.45 - 1.3)) / CT.row));
      if (r < 2) continue;
      let t = tOn;
      if (z1 < zE) { const yMax = (eyeY * (zE + L / 2 + dMax - (zE - z0))) / (zE + L / 2 + dMax); t = Math.max(1, Math.min(tOn, Math.floor((yMax - yD - CT.coaming - 0.05) / CT.tier))); }
      const overER = z1 > ga.er.z0 - 0.5 && z0 < ga.er.z1 + 0.5;
      bays.push({ z0, z1, rows: r, w: r2(r * CT.row), tiers: t, below: overER ? 0 : Math.max(1, Math.floor((ga.D - ga.db - 1) / CT.tier)), fwd: z1 < zE });
      if (z1 < zE) ga.obstructions.push({ z: z0, y: stackTop(ga, t), what: 'containers on deck' });
    }
  }
  let walkBay = -1;
  bays.forEach((b, i) => { if (b.below && b.z1 < h.z0 && b.z1 < ga.er.z0 - 0.5 && (walkBay < 0 || b.z1 > bays[walkBay].z1)) walkBay = i; });
  ga.cargo = { kind: 'bays', zones: bays, rows, tiersOnDeck: tOn, walkBay, floorY: r2(-ga.T + ga.db) };
  ga.deck.lashing = [];
  for (let i = 1; i < bays.length; i++) if (bays[i].z0 - bays[i - 1].z1 < 1.2) ga.deck.lashing.push({ z: r2((bays[i].z0 + bays[i - 1].z1) / 2), z0: bays[i - 1].z1, z1: bays[i].z0, w: r2(Math.min(bays[i].w, bays[i - 1].w)), tiers: 2 });
  ga.eyeNeed = eyeNeed(ga);
  return ga;
};

/** Container ship with the house amidships-aft (3/4 aft, ER under it) or forward (twin island: ER + funnel aft). */
function midHouseShip(ga, m, { nAcc, twin }) {
  const L = ga.L, B = ga.B, yD = ga.deckY, tierH = RULES.TIER_H.merchant;
  ga.hull.fcsle = { len: r2(clamp((twin ? 0.05 : 0.06) * L, 6, 22)), h: 2.6 };
  const hzC = twin ? r2(L / 2 - 0.62 * L) : r2(L / 2 - 0.25 * L);
  const hl = r2(clamp(0.05 * L, 15, 22));
  const hw = r2(Math.min(0.5 * B, 2 * (deckMin(ga, hzC - hl, hzC + hl) - 0.45 - 2.4)));
  const er = twin ? engineRoom(ga, m, { z1: r2(L / 2 - 0.13 * L) }) : engineRoom(ga, m, { z1: r2(hzC + hl / 2 + 6) });
  const house = buildHouse(ga, { pos: 'mid', X0: r2(-hw / 2), X1: r2(hw / 2), Z0: r2(hzC - hl / 2), Z1: r2(hzC + hl / 2), zMinFwd: r2(hzC - hl / 2 - 12), zMaxAft: r2(hzC + hl / 2 + 12), nAcc, tierH, yMain: yD, bridgeD: 7, erColumn: twin ? null : { rise: (er.top - er.floorY) / er.levels.length, deg: RULES.ER_STAIR_DEG, fits: columnFits(ga, er) } });
  ga.house = house;
  if (twin) {
    const cw = r2(Math.min(0.36 * B, 18));
    er.column = casingColumn(ga, er, { side: -1, x: r2(-cw / 2 + 0.4) });
    ga.casing = { z0: r2(er.column.z0 - 0.3), z1: r2(er.column.z1 + 6), w: cw, x0: r2(-cw / 2), x1: r2(cw / 2) };
    er.shaft = { z0: er.z1, z1: r2(L / 2 - Math.max(6, 0.045 * L)), y: er.floorY };
    er.steering = { z0: er.shaft.z1, z1: r2(L / 2 - 1.5), y: er.levels[er.levels.length - 1] };
  } else {
    er.column = house.erSlot ? columnFromSlot(er, house.erSlot) : casingColumn(ga, er, { side: -1, z0: r2(house.z1 + 0.6) });
    const cas = house.tiers[0].rooms.find((r) => r.use === 'casing');
    ga.casing = cas ? { z0: cas.z0, z1: cas.z1, w: r2(cas.x1 - cas.x0), x0: cas.x0, x1: cas.x1 } : { z0: r2(house.z1 - 4), z1: r2(house.z1 - 1), w: 3, x0: r2(house.x1 - 4), x1: r2(house.x1 - 1) };
    er.shaft = { z0: er.z1, z1: r2(L / 2 - Math.max(6, 0.045 * L)), y: er.floorY };
    er.steering = { z0: er.shaft.z1, z1: r2(L / 2 - 1.5), y: er.levels[er.levels.length - 1] };
  }
  er.z0 = r2(Math.min(er.z0, er.column.z0 - 1.5)); er.z1 = r2(Math.max(er.z1, er.column.z1 + 0.8));
  if (er.shaft) er.shaft.z0 = er.z1;
  placeEngines(er);
  er.ecr.side = er.column.side > 0 ? -1 : 1;
  er.escape = { side: -er.column.side, z: r2(er.z1 - 3) };
  ga.er = er;
  ga.bridge = bridgeOf(ga, house);
  ga.funnel = { z: r2((ga.casing.z0 + ga.casing.z1) / 2 + (twin ? 2 : 0.5)), x: twin ? 0 : r2((ga.casing.x0 + ga.casing.x1) / 2), y: r2(twin ? yD + 14 : ga.bridge.compassY), r: r2(clamp(0.045 * B, 1.4, 3.2)), h: r2(twin ? 18 : clamp(0.03 * L, 6, 12)), kind: 'single' };
  const fc = ga.hull.fcsle, yF = r2(yD + fc.h);
  for (const side of [-1, 1]) ga.deck.mooring.push({ z: r2(-L / 2 + fc.len * 0.5), kind: 'windlass', side, y: yF }, { z: r2(-L / 2 + fc.len * 0.8), kind: 'winch', side, y: yF }, { z: r2(L / 2 - Math.max(3, 0.02 * L)), kind: 'winch', side, y: yD });
  ga.deck.masts.push({ z: r2(-L / 2 + Math.max(1.6, fc.len * 0.22)), x: 0, h: 12, y: yF }, { z: r2(ga.bridge.z0 + 2.4), x: 0, h: 8, y: ga.bridge.compassY, radar: true });
  ga.deck.boats.push({ kind: 'freefall', z: r2(house.z1 + 2.2), x: 0, y: r2(yD + tierH * 2) }, { kind: 'rescue', z: r2(house.z0 + 4), x: r2(hw / 2 + 1.5), y: yD, side: 1 });
  for (const side of [-1, 1]) ga.deck.boats.push({ kind: 'raft', z: r2(house.z0 + (house.z1 - house.z0) * 0.75), x: r2(side * (hw / 2 + 0.9)), y: yD, side });
  ga.deck.gangway = { z: r2(house.z0 + 1.5), side: -1 };
  ga.obstructions.push({ z: r2(-L / 2 + 1), y: r2(yF + 1.1), what: 'forecastle bulwark' });
  return ga;
}

// ------------------------------------------------------------------------------------------------ forward-house ships
// Offshore vessels, the big fishing ships, the ocean tug and the special ships: the house forward, a long working deck
// aft, the engine room under the house (or aft with a casing), a bridge with an aft-facing console over the deck.
function extraBerths(name, n, furn = 'cabin') { const out = []; for (let i = 0; i < n; i++) out.push({ kind: 'cabin', use: 'cabin', name, furn, berth: 1, extra: true }); return out; }

function fwdHouseShip(ga, m, o = {}) {
  const L = ga.L, B = ga.B, yD = ga.deckY, tierH = o.tierH || RULES.TIER_H.offshore;
  if (o.fcsle) ga.hull.fcsle = { len: r2(clamp(o.fcsle * L, 5, 16)), h: 2.4 };
  const fcLen = ga.hull.fcsle ? ga.hull.fcsle.len : 0;
  const hz0 = r2(-L / 2 + Math.max(fcLen + 4, o.fwd ?? clamp(0.12 * L, 6, 18)));
  const hl = r2(clamp((o.hl ?? 0.3) * L, 12, 60));
  const hw = r2(Math.min((o.houseW ?? 0.86) * B, 2 * (deckMin(ga, hz0 - 1.3, hz0 + hl + 1.9) - 0.45 - (o.side ?? 1.3))));
  const sternRoom = r2(Math.max(5, 0.08 * L));
  const er = o.erAft ? engineRoom(ga, m, { z1: r2(L / 2 - sternRoom) }) : engineRoom(ga, m, { z1: r2(Math.min(hz0 + hl + 0.06 * L, L / 2 - sternRoom)) });
  const extra = { ccr: false };
  const house = buildHouse(ga, { pos: 'fwd', X0: r2(-hw / 2), X1: r2(hw / 2), Z0: hz0, Z1: r2(hz0 + hl), zMinFwd: hz0, zMaxAft: r2(L / 2 - Math.max(10, 0.25 * L)), nAcc: o.nAcc || 3, nMax: (o.nAcc || 3) + 2, tierH, yMain: yD, bridgeD: o.bridgeD || 5.5, extra, erColumn: o.erAft ? null : { rise: (er.top - er.floorY) / er.levels.length, deg: RULES.ER_STAIR_DEG, fits: columnFits(ga, er) }, more: o.more, morePerTier: o.morePerTier });
  ga.house = house;
  if (house.erSlot) er.column = columnFromSlot(er, house.erSlot);
  else er.column = casingColumn(ga, er, { side: -1, zEnd: r2(Math.min(er.z1 - 0.8, L / 2 - sternRoom - 1)) });
  er.z0 = r2(Math.min(er.z0, er.column.z0 - 1.5)); er.z1 = r2(Math.max(er.z1, er.column.z1 + 0.8));
  placeEngines(er);
  er.steering = { z0: r2(L / 2 - sternRoom + 0.5), z1: r2(L / 2 - 1.2), y: er.levels[er.levels.length - 1], azimuth: /azimuth|pods|DE/.test(m.engine?.label || '') };
  er.ecr.side = er.column.side > 0 ? -1 : 1;
  er.escape = { side: -er.column.side, z: r2(Math.min(er.z1 + 1, L / 2 - 3)) };
  ga.er = er;
  ga.bridge = bridgeOf(ga, house, { aft: o.aft !== false, fishing: !!o.fishing, enclosed: o.enclosed, wingTo: B / 2 - 0.3 });
  const yTop = ga.bridge.compassY;
  ga.funnel = o.funnel === 'single' ? { z: r2(house.z1 - 2.5), x: 0, y: yTop, r: r2(clamp(0.05 * B, 0.6, 1.6)), h: r2(clamp(0.05 * L, 2.5, 6)), kind: 'single' } : { z: r2(house.z1 - 1.6), x: r2(hw / 2 - 1.2), y: yTop, r: r2(clamp(0.03 * B, 0.4, 0.8)), h: r2(clamp(0.05 * L, 2.5, 6)), kind: 'twin' };
  ga.casing = { z0: r2(house.z1 - 3), z1: house.z1, w: 2, x0: r2(hw / 2 - 2.2), x1: r2(hw / 2 - 0.2) };
  // foredeck mooring, masts
  const yF = ga.hull.fcsle ? r2(yD + ga.hull.fcsle.h) : yD;
  for (const side of [-1, 1]) ga.deck.mooring.push({ z: r2(-L / 2 + Math.max(3.2, (fcLen || 0.08 * L) * 0.55)), kind: 'windlass', side, y: yF });
  ga.deck.masts.push({ z: r2(ga.bridge.z0 + 2), x: 0, h: r2(clamp(0.06 * L, 3, 8)), y: ga.bridge.compassY, radar: true });
  // the working deck aft
  const az0 = r2(house.z1), az1 = r2(L / 2 - 0.8);
  ga.cargo = { kind: 'deck', zones: [{ z0: az0, z1: az1, w: r2(2 * (deckMin(ga, az0, az1) - 0.45) - 1.2), rails: !!o.crashRails }] };
  for (const side of [-1, 1]) ga.deck.mooring.push({ z: r2(L / 2 - 3.5), kind: 'capstan', side, y: yD });
  ga.deck.boats.push({ kind: 'rescue', z: r2(house.z0 + Math.min(4, hl * 0.35)), x: r2(hw / 2 + 1.2), y: yD, side: 1 });
  for (const side of [-1, 1]) ga.deck.boats.push({ kind: 'raft', z: r2(house.z1 - 2), x: r2(side * (hw / 2 + 0.8)), y: yD, side });
  return ga;
}

GEN.offshore = (mk, m) => {
  const ga = mk(), L = ga.L, B = ga.B, sov = m.id === 'sov90', ahts = /^ahts/.test(m.id);
  const more = sov ? extraBerths('Technician\'s cabin', Math.round((m.pax || 60) / 2)) : extraBerths('Supernumerary cabin', 2);
  if (sov) more.push({ kind: 'mess', use: 'lounge', name: 'Technicians\' lounge', furn: 'lounge' }, { kind: 'mess', use: 'gym', name: 'Gym', furn: 'gym' }, { kind: 'store', use: 'office', name: 'Wind-farm control room', furn: 'office' });
  if (ahts) more.push({ kind: 'store', use: 'winch', name: 'Winch room', furn: 'winch', at: 'aftA' });
  fwdHouseShip(ga, m, { hl: sov ? 0.42 : 0.3, nAcc: sov ? 5 : 3, crashRails: !sov, more });
  const yD = ga.deckY, h = ga.house;
  const dz1 = r2(L / 2 - 1);
  if (ahts) {
    ga.deck.sternRoller = { z: r2(L / 2 - 0.4), w: r2(B * 0.35) };
    ga.deck.sharkJaws = { z: r2(L / 2 - 4.5), w: 2.4 };
    ga.deck.towPins = { z: r2(L / 2 - 4.5), x: 1.6 };
    ga.deck.towWinch = { z: r2(h.z1 + 0.2), w: r2(Math.min(h.w - 2, B * 0.5)), y: yD, inHouse: true };
  }
  if (sov) {
    ga.deck.gangway = { z: r2(h.z1 + 5), side: 1, tower: true, y: r2(yD + 2 * RULES.TIER_H.offshore), len: 25 };
    ga.deck.cranes.push({ z: r2(h.z1 + 12), x: r2(-(B / 2 - 2.6)), swl: 5, boom: 18, h: 9, ped: 1.6 });
    ga.deck.heli = null;
  } else ga.deck.cranes.push({ z: r2(dz1 - 6), x: r2(B / 2 - 2.6), swl: m.id === 'psv90' ? 10 : 5, boom: 14, h: 7, ped: 1.4 });
  ga.deck.tankHatches = [0.35, 0.6, 0.85].map((f) => ({ z: r2(h.z1 + (dz1 - h.z1) * f), x: r2(B * 0.28) }));
  return ga;
};

GEN.special = (mk, m) => {
  const ga = mk(), L = ga.L, B = ga.B, yD = ga.deckY;
  if (m.id === 'tshd100') {
    // trailing suction hopper dredger: house forward, hopper amidships, engine room aft, drag arm on the starboard side
    fwdHouseShip(ga, m, { hl: 0.22, nAcc: 3, erAft: true, aft: true, funnel: 'single', more: extraBerths('Dredge master\'s cabin', 1) });
    const h = ga.house, c0 = r2(h.z1 + 3), c1 = r2(ga.er.z0 - 2);
    ga.cargo = { kind: 'hopper', zones: [{ z0: c0, z1: c1, w: r2(Math.min(B * 0.62, 2 * (deckMin(ga, c0, c1) - 0.45 - 2.2))), coaming: 1.6 }] };
    ga.deck.dragArm = { side: 1, z0: r2(c0 + 4), z1: r2(c1 - 2), gantries: [r2(c0 + 4), r2((c0 + c1) / 2), r2(c1 - 2)] };
    return ga;
  }
  const ice = m.id === 'icebreaker120';
  const more = ice ? [...extraBerths('Scientist\'s cabin', 14), ...extraBerths('Helicopter crew cabin', 2), { kind: 'bridge', use: 'aftbridge', name: 'Aft bridge', furn: 'aftbridge', at: 'aftNav' }, { kind: 'store', use: 'lab', name: 'Ice laboratory', furn: 'lab' }]
    : [...extraBerths('Scientist\'s cabin', Math.round((m.pax || 30) / 2)), { kind: 'store', use: 'lab', name: 'Wet laboratory', furn: 'lab', at: 'aftA' }, { kind: 'store', use: 'lab', name: 'Dry laboratory', furn: 'lab', at: 'aftA' }, { kind: 'store', use: 'lab', name: 'Computer & survey room', furn: 'office' }];
  fwdHouseShip(ga, m, { hl: ice ? 0.36 : 0.42, nAcc: ice ? 5 : 4, enclosed: ice, more, fwd: ice ? 0.2 * L : undefined });
  const h = ga.house;
  if (!ice) { ga.deck.aframe = { z: r2(L / 2 - 1.5), w: r2(B * 0.55), h: 8 }; ga.deck.moonpool = { z: r2(h.z1 - 3), r: 1.4 }; ga.deck.cranes.push({ z: r2(h.z1 + 4), x: r2(B / 2 - 2.4), swl: 10, boom: 14, h: 8, ped: 1.4 }); }
  else { ga.deck.heli = { z: r2(L / 2 - 0.16 * L), r: r2(Math.min(B / 2 - 1, 11)) }; ga.deck.cranes.push({ z: r2(h.z1 + 3), x: r2(-(B / 2 - 2.6)), swl: 20, boom: 18, h: 9, ped: 1.8 }); }
  return ga;
};

GEN.fishing = (mk, m) => {
  const ga = mk();
  if (ga.L < 60) return smallCraft(ga, m);
  const L = ga.L, B = ga.B, yD = ga.deckY, factory = m.id === 'factory80';
  fwdHouseShip(ga, m, { hl: factory ? 0.3 : 0.27, nAcc: factory ? 4 : 3, tierH: RULES.TIER_H.merchant, fishing: true, aft: true, funnel: 'single', fcsle: 0.08 });
  const h = ga.house;
  if (factory) {
    ga.tween = { id: 'factory', name: 'Factory deck (processing)', use: 'factory', y: r2(yD - 3.0), h: 2.8, z0: r2(h.z1 + 1), z1: r2(L / 2 - 0.16 * L) };
    ga.cargo.freezer = { z0: r2(h.z1 + 2), z1: r2(L / 2 - 0.2 * L), y: r2(-ga.T + ga.db) };
    ga.deck.gantry = { z: r2(L / 2 - 3), w: r2(B * 0.8), h: 9 };
    ga.deck.netDrums = [r2(L / 2 - 12), r2(L / 2 - 17)];
    ga.deck.sternRamp = { z: r2(L / 2 - 0.5), w: r2(B * 0.3) };
  } else {
    ga.deck.netBin = { z0: r2(L / 2 - 14), z1: r2(L / 2 - 3), x0: r2(-B * 0.32), x1: r2(B * 0.05) };
    ga.deck.powerBlock = { z: r2(L / 2 - 10), x: r2(B * 0.25), h: 10 };
    ga.deck.purseWinch = { z: r2(h.z1 + 3), w: r2(B * 0.4) };
    ga.cargo.rsw = [0.25, 0.45, 0.65].map((f) => ({ z: r2(h.z1 + (L / 2 - 16 - h.z1) * f), x: 0 }));
  }
  return ga;
};

GEN.tug = (mk, m) => {
  const ga = mk();
  if (ga.L < 40) return smallCraft(ga, m);
  // ocean towing & salvage tug: house forward, long tow deck with the tow winch and a stern roller
  fwdHouseShip(ga, m, { hl: 0.3, nAcc: 3, tierH: RULES.TIER_H.merchant, aft: true, fcsle: 0.12, more: extraBerths('Salvage crew cabin', 3) });
  const L = ga.L, B = ga.B, h = ga.house;
  ga.deck.towWinch = { z: r2(h.z1 + 2.2), w: r2(B * 0.5), y: ga.deckY };
  ga.deck.sternRoller = { z: r2(L / 2 - 0.4), w: r2(B * 0.4) };
  ga.deck.towPins = { z: r2(L / 2 - 3.5), x: 1.4 };
  ga.deck.cranes.push({ z: r2(h.z1 + 7), x: r2(-(B / 2 - 2.2)), swl: 10, boom: 14, h: 7, ped: 1.4 });
  return ga;
};

// ------------------------------------------------------------------------------------------------ small craft
// Deckhouse (+ wheelhouse on its roof, at its front, or an open helm), compartments below deck in a row from the bow to
// the stern, open decks round them. gaplan.js builds the walk from ga.small.
const SMALL = {
  tug16: { dh: [0.38, 0.72, 0.62], wh: 'roof', below: [['Crew cabin', 'pair', 'cabin'], ['STAIR'], ['Engine room', 'full', 'engine', 4.2], ['Steering flat', 'full', 'steering']], gear: ['pushKnees', 'towHook'] },
  tug24: { dh: [0.2, 0.62, 0.66], wh: 'roof', below: [['Crew cabins', 'pair', 'cabin'], ['STAIR'], ['Engine room', 'full', 'engine', 7.0], ['Azimuth thruster room', 'full', 'steering']], gear: ['towWinchFwd', 'fenders'] },
  tug: { dh: [0.18, 0.55, 0.66], wh: 'roof', below: [['Crew cabins', 'pair', 'cabin'], ['Crew cabins', 'pair', 'cabin'], ['STAIR'], ['Engine room', 'full', 'engine', 9.0], ['Azimuth thruster room', 'full', 'steering']], gear: ['towWinchFwd', 'towWinchAft', 'fenders'] },
  multicat27: { dh: [0.08, 0.4, 0.7], wh: 'roof', below: [['Crew cabins', 'pair', 'cabin'], ['STAIR'], ['Engine room', 'full', 'engine', 7.0], ['Steering flat', 'full', 'steering']], gear: ['crane', 'anchorWinch', 'towWinchAft'] },
  pilot14: { dh: [0.3, 0.68, 0.7], wh: 'front', below: [['Forepeak cabin', 'full', 'vberth'], ['STAIR'], ['Engine room', 'full', 'engine', 3.6]], gear: ['pilotDeck'] },
  pilot: { dh: [0.3, 0.66, 0.7], wh: 'front', below: [['Crew cabin', 'full', 'cabin2'], ['STAIR'], ['Mess & galley', 'full', 'mess', 3.0], ['Engine room', 'full', 'engine', 4.2]], gear: ['pilotDeck'] },
  ctv26: { dh: [0.22, 0.6, 0.88], wh: 'front', twin: true, gear: ['bowFender', 'transfer'] },
  inshore15: { dh: [0.16, 0.42, 0.66], wh: 'front', below: [['Forepeak cabin', 'full', 'vberth'], ['STAIR'], ['Engine room', 'full', 'engine', 3.0]], hold: [0.55, 0.85], gear: ['potHauler', 'gantrySmall'] },
  beam40: { dh: [0.14, 0.4, 0.62], wh: 'roof', below: [['Crew cabins', 'pair', 'cabin'], ['STAIR'], ['Fish hold', 'hold', 'hold', 9], ['Engine room', 'full', 'engine', 7.0]], gear: ['derricks', 'beamWinch'] },
  trawler: { dh: [0.12, 0.38, 0.66], wh: 'roof', below: [['Crew cabins', 'pair', 'cabin'], ['STAIR'], ['Engine room', 'full', 'engine', 7.0], ['Fish hold', 'hold', 'hold', 9]], gear: ['gantry', 'netDrum', 'sternRamp'] },
  longliner50: { dh: [0.12, 0.42, 0.7], wh: 'roof', below: [['Crew cabins', 'pair', 'cabin'], ['Crew cabins', 'pair', 'cabin'], ['STAIR'], ['Freezer hold', 'hold', 'hold', 10], ['Engine room', 'full', 'engine', 7.0]], gear: ['haulingPort', 'lineDrum'] },
  rib8: { open: 'console', gear: ['outboards'] },
  cruiser: { open: 'cockpit', below: [['Forward cabin (V-berth)', 'full', 'vberth'], ['Saloon & galley', 'full', 'saloon', 3.2], ['Engine bay', 'full', 'engine', 2.6]], gear: ['swimPlatform'] },
  flybridge18: { dh: [0.32, 0.72, 0.74], wh: 'flybridge', yacht: true, below: [['Owner\'s cabin', 'full', 'owner'], ['STAIR'], ['Guest cabins', 'pair', 'cabin'], ['Engine room', 'full', 'engine', 3.4]], gear: ['swimPlatform'] },
  myacht: { dh: [0.28, 0.74, 0.74], wh: 'flybridge', yacht: true, below: [['Owner\'s cabin', 'full', 'owner'], ['STAIR'], ['Guest cabins', 'pair', 'cabin'], ['Engine room', 'full', 'engine', 4.0], ['Crew cabin', 'full', 'cabin2']], gear: ['swimPlatform', 'tenderDeck'] },
};

function smallCraft(ga, m) {
  const S = SMALL[m.id] || (ga.gen === 'fishing' ? SMALL.trawler : ga.gen === 'tug' ? SMALL.tug24 : SMALL.pilot);
  const L = ga.L, B = ga.B, yD = ga.deckY;
  ga.layout = 'small';
  if (S.twin) { const hullB = r2(B * 0.27); ga.hull.twin = { hullB, gap: r2(B - 2 * hullB), xc: r2(B / 2 - hullB / 2), wetY: r2(yD - 1.2) }; ga.hull.bow = 'wavepiercer'; ga.hull.stemW = 0.55; }
  const yB = r2(Math.max(-ga.Tk + 0.25, yD - 2.35)), hB = r2(yD - yB - 0.12);
  const dh = S.dh ? (() => {
    const z0 = r2(-L / 2 + S.dh[0] * L), z1 = r2(-L / 2 + S.dh[1] * L);
    const side = S.twin ? 0.9 : S.yacht ? 0.75 : 0.85;
    const w = r2(Math.min(S.dh[2] * B, 2 * (deckMin(ga, z0 - 0.5, z1 + 0.5) - 0.3 - side)));
    return { z0, z1, x0: r2(-w / 2), x1: r2(w / 2), w, h: S.yacht ? 2.25 : 2.3 };
  })() : null;
  const whKind = S.wh || S.open || 'none';
  const whY = whKind === 'roof' ? r2(yD + dh.h + 0.12) : whKind === 'flybridge' ? r2(yD + dh.h + 0.25) : yD;
  // compartments below deck, from the bow to the stern; the stair compartment sits under the deckhouse's stair hall
  const LS = 0.95, runDown = stairRun(yD - yB, 54), runUp = whKind === 'roof' ? stairRun(r2(yD + (dh ? dh.h : 0) + 0.12) - yD, 54) : 0;
  let hall = null;
  if (dh) { const hallL = r2(Math.max(runDown, runUp) + 2 * LS); hall = { z0: r2(Math.max(dh.z0 + 2.2, dh.z1 - hallL)), z1: dh.z1 }; }
  const fitB = (z0, z1) => (S.twin ? 0 : Math.min(fitHalf(ga, z0, z1, yB, yD) - 0.3, B / 2 - 0.3));
  let zb = -L / 2 + 0.5; while (zb < 0 && fitB(zb, zb + 1.2) < 0.75) zb = r2(zb + 0.2);
  let zs = L / 2 - 0.6; while (zs > 0 && fitB(zs - 1.2, zs) < 0.9) zs = r2(zs - 0.2);
  const comps = [], spec = S.below || [], iS = spec.findIndex((q) => q[0] === 'STAIR');
  const placeRow = (items, a, b) => {
    if (b - a < 1.2) return;
    const fixed = items.reduce((t, q) => t + (q[3] || 0), 0), free = items.filter((q) => !q[3]).length;
    const scale = fixed > b - a - 1.8 * free ? Math.max(0.4, (b - a - 1.8 * free) / Math.max(1, fixed)) : 1;
    const each = free ? Math.max(1.8, (b - a - fixed * scale) / free) : 0;
    let z = a;
    for (const q of items) { const len = q[3] ? q[3] * scale : each; const z1 = Math.min(b, z + len); if (z1 - z >= 1.3) comps.push({ name: q[0], layout: q[1], furn: q[2], z0: r2(z), z1: r2(z1) }); z = z1; }
  };
  if (hall && iS >= 0) { placeRow(spec.slice(0, iS), zb, hall.z0); comps.push({ name: 'Passage', layout: 'full', furn: 'stair', z0: hall.z0, z1: hall.z1, stair: true }); placeRow(spec.slice(iS + 1), hall.z1, zs); }
  else if (!S.twin) placeRow(spec, zb, zs);
  // too little headroom under a low deck: living spaces get a raised coachroof (the cabin top of small yachts and launches)
  for (const c of comps) if (hB < 1.8 && !c.stair && c.furn !== 'engine' && c.furn !== 'hold' && !(dh && c.z1 > dh.z0 && c.z0 < dh.z1)) { c.h = 1.95; c.roof = r2(yB + 2.05); }
  ga.small = { yB, hB, dh, hall, runDown, runUp, LS, compartments: comps, wh: whKind, whY, below: S.below || [], hold: S.hold || null, gear: S.gear || [], twin: !!S.twin, yacht: !!S.yacht, levels: [{ id: 'below', y: yB, name: 'Below deck' }, { id: 'main', y: yD, name: 'Main deck' }, ...(whKind === 'roof' || whKind === 'flybridge' ? [{ id: 'wheelhouse', y: whY, name: whKind === 'flybridge' ? 'Flybridge' : 'Wheelhouse' }] : [])] };
  const k = m.engine?.kind || 'hs';
  const me = meDims(k === 'aux' ? '4s' : k === 'de' ? '4s' : k, m.kW || 300, m.engine?.n || 1);
  const ec = comps.find((c) => c.furn === 'engine') || (S.twin && hall ? { z0: hall.z0, z1: r2(Math.min(L / 2 - 2.2, hall.z1 + 4.2)) } : { z0: r2(L / 2 - 2), z1: r2(L / 2 - 0.3) });
  ga.er = { z0: ec.z0, z1: ec.z1, floorY: yB, levels: [yB], top: yD, kind: k, me: { kind: k, n: m.engine?.n || 1, rows: 1, len: me.len, w: me.w, h: me.h, xs: [], z: 0 }, gens: null, ecr: { level: 0, side: 1 }, purifier: false, boiler: false, workshop: false, steering: null, escape: null, shaft: null, column: null, small: true, outboard: k === 'ob' };
  const bz0 = dh ? dh.z0 : r2(-0.1 * L);
  ga.bridge = { y: whY, h: 2.2, z0: bz0, z1: r2(bz0 + 2.4), x0: dh ? dh.x0 : -1, x1: dh ? dh.x1 : 1, room: 'wheelhouse', wings: 'none', wingTo: 0, wingD: 0, consoles: [], aftConsole: ga.gen === 'tug' || ga.gen === 'fishing', compassY: 0, small: true };
  ga.bridge.consoles = bridgeConsoles(ga, ga.bridge, { small: true, aft: ga.gen === 'tug' || ga.gen === 'fishing', fishing: ga.gen === 'fishing' });
  ga.funnel = ga.gen === 'tug' || ga.gen === 'fishing' ? { z: r2(dh ? dh.z1 - 0.8 : 0), x: r2(dh ? dh.x1 - 0.5 : 0), y: r2(yD + (dh ? dh.h : 0)), r: 0.35, h: 2.2, kind: 'twin' } : { kind: 'none' };
  ga.house = null;
  ga.eyeNeed = 0;
  return ga;
}
GEN.small_fast = (mk, m) => smallCraft(mk(), m);

// ------------------------------------------------------------------------------------------------ motor yachts
GEN.motor_yacht = (mk, m) => {
  const ga = mk();
  if (ga.L < 30) return smallCraft(ga, m);
  // explorer / superyacht / gigayacht: lower deck (guest cabins, crew forward) inside the hull, main deck (saloon,
  // dining, owner's suite forward), upper deck (bridge, sky lounge), sun deck; engine room aft below the aft deck
  const L = ga.L, B = ga.B, yD = ga.deckY, giga = m.id === 'giga100';
  ga.layout = 'big'; ga.yacht = true;
  const yLow = r2(yD - 2.65);
  const hz0 = r2(-L / 2 + (giga ? 0.17 : 0.15) * L), hz1 = r2(L / 2 - (giga ? 0.3 : 0.22) * L);
  const fitLow = fitHalf(ga, hz0, hz1, yLow, yD) - 0.3;
  const hw = r2(Math.min(0.84 * B, 2 * fitLow, 2 * (deckMin(ga, hz0 - 1.3, hz1 + 1.9) - 0.45 - 1.0)));
  const guests = Math.round((m.pax || 12) / 2), crew = m.crew?.opt || 8;
  const progs = [
    [...extraBerths('Guest cabin (double)', Math.max(2, guests - 1), 'cabin'), ...extraBerths('Crew cabin', Math.ceil(crew / 2), 'cabin'), { kind: 'mess', use: 'mess', name: 'Crew mess', furn: 'mess' }, { kind: 'store', use: 'laundry', name: 'Laundry', furn: 'laundry' }],
    [{ kind: 'cabin', use: 'owner', name: 'Owner\'s suite', furn: 'owner', berth: 1, at: 'front' }, { kind: 'mess', use: 'saloon', name: 'Main saloon', furn: 'lounge', at: 'aftA' }, { kind: 'mess', use: 'dining', name: 'Dining room', furn: 'mess' }, { kind: 'mess', use: 'galley', name: 'Galley', furn: 'galley' }, { kind: 'cabin', use: 'cabin', name: 'VIP cabin', furn: 'cabin', berth: 1 }],
    [{ kind: 'mess', use: 'lounge', name: 'Sky lounge', furn: 'lounge', at: 'aftA' }, { kind: 'cabin', use: 'cabin', name: 'Captain\'s cabin', furn: 'cabin', berth: 1 }, { kind: 'store', use: 'office', name: 'Ship\'s office', furn: 'office' }],
  ];
  const levels = [{ id: 'L', y: yLow, h: 2.53, use: 'lower', name: 'Lower deck' }, { id: 'M', y: yD, h: r2(RULES.TIER_H.ferry - 0.12), use: 'main', name: 'Main deck' }];
  if (giga || L >= 60) levels.push({ id: 'U', y: r2(yD + RULES.TIER_H.ferry), h: 2.88, use: 'accom', name: 'Upper deck' });
  levels.push({ id: 'nav', y: r2(levels[levels.length - 1].y + RULES.TIER_H.ferry), h: 2.6, use: 'bridge', name: 'Bridge deck' });
  if (levels.length === 3) progs.splice(2, 1);
  progs.push(tierProgramme(ga, 'bridge', levels.length - 1, levels.length, {}));
  const Lh = layoutHouse(ga, { X0: r2(-hw / 2), X1: r2(hw / 2), Z0: hz0, Z1: hz1, levels, progs, roomD: 3.6, bridgeD: 5.0, spine: !giga, mainIndex: 1 });
  let carry = [];
  for (const t of Lh.tiers) { t.prog = [...t.prog, ...carry]; carry = Lh.assign(t, (n) => `${t.id}-r${n}`); }
  for (const t of Lh.tiers) fillSpares(t, (n) => `${t.id}-r${n}`, true);
  // the lower deck is inside the hull: no windows there (portholes are part of the hull model); the main deck has the entrances
  for (const r of Lh.tiers[0].rooms) r.win = [];
  ga.house = { pos: 'mid', z0: hz0, z1: hz1, w: hw, x0: r2(-hw / 2), x1: r2(hw / 2), tiers: Lh.tiers, core: Lh.core, layout: Lh.layout, erSlot: null, eyeY: r2(levels[levels.length - 1].y + 1.6), overflow: carry.length, mainTier: 1, style: 'yacht' };
  const er = engineRoom(ga, m, { z1: r2(L / 2 - (giga ? 0.12 : 0.08) * L), floorY: r2(Math.max(-ga.Tk + 0.6, yLow - 1.2)), levelStep: 9, len: r2(Math.max(7, 0.13 * L)) });
  er.z0 = r2(Math.max(er.z0, hz1 + 0.3));
  er.column = null;
  er.hatch = { z: r2(er.z0 + 1.4), x: 1.2 };   // crew access by a ladder through a deck hatch (no deckhouse on a yacht's aft deck)
  placeEngines(er);
  er.steering = null; er.workshop = false; er.ecr.side = 1;
  ga.er = er;
  ga.bridge = bridgeOf(ga, ga.house, { enclosed: true, wings: giga ? undefined : false, wingTo: B / 2 - 0.4 });
  ga.funnel = { kind: 'mast', z: r2(ga.bridge.z1 + 2), x: 0, y: ga.bridge.compassY, r: 0.3, h: 5 };
  ga.deck.masts.push({ z: r2(ga.bridge.z1 + 1.5), x: 0, h: 5, y: ga.bridge.compassY, radar: true });
  ga.deck.boats.push({ kind: 'tender', z: r2(hz1 + 3), x: 0, y: r2(yD + RULES.TIER_H.ferry), side: 1 });
  for (const side of [-1, 1]) ga.deck.boats.push({ kind: 'raft', z: r2(hz0 + 2), x: r2(side * (hw / 2 + 0.6)), y: yD, side });
  for (const side of [-1, 1]) ga.deck.mooring.push({ z: r2(-L / 2 + 0.08 * L), kind: 'windlass', side, y: yD }, { z: r2(L / 2 - 2.5), kind: 'capstan', side, y: yD });
  if (giga || L >= 60) ga.yachtAft = { beachClub: { z0: r2(L / 2 - 0.1 * L), z1: r2(L / 2 - 1.0), y: yLow }, garage: true, swim: { z0: r2(L / 2 - 1.0), z1: r2(L / 2 + 1.6), y: yLow } };
  if (giga) ga.deck.heli = { z: r2(-L / 2 + 0.11 * L), r: r2(Math.min(B / 2 - 0.6, 7)), y: yD };
  if (m.id === 'explorer45') ga.deck.cranes.push({ z: r2(hz1 + 2.5), x: r2(B / 2 - 1.4), swl: 5, boom: 10, h: 5, ped: 1.0 });
  return ga;
};

// ------------------------------------------------------------------------------------------------ ro-ro / PCTC
GEN.roro_pctc = (mk, m) => {
  const ga = mk(), L = ga.L, B = ga.B, F = ga.deckY, pctc = m.id === 'pctc7000';
  ga.layout = 'roro';
  // car decks inside the box hull: a high main deck, then car decks to the weather deck (PCTC: hoistable decks)
  const decks = [];
  let y = r2(Math.max(1.4, -ga.T + ga.db + 6.4));
  const hMain = pctc ? 5.2 : 6.2;
  decks.push({ id: 'cd1', y, h: hMain, name: 'Main car deck (heavy)' });
  y = r2(y + hMain + 0.25);
  let k = 2;
  while (y + (pctc ? 2.3 : 5.0) <= F - 0.2) { const hh = pctc ? (k === 2 ? 4.4 : 2.1) : 5.0; if (y + hh > F - 0.2) break; decks.push({ id: `cd${k}`, y, h: hh, name: `Car deck ${k}` }); y = r2(y + hh + 0.25); k++; }
  const top = { id: 'weather', y: F, name: 'Weather deck' };
  ga.roro = { decks, top, x: r2(B / 2 - 1.0), ramps: [], stern: { w: pctc ? 7 : 12, quarter: pctc }, side: pctc ? { z: r2(0.1 * L), side: 1 } : null, lanes: m.units?.lm || 0, ceu: m.units?.ceu || 0 };
  // internal ramps between decks, alternating sides, ~8°
  for (let i = 0; i < decks.length - 1; i++) {
    const a = decks[i], b = decks[i + 1], rise = b.y - a.y, run = r2(rise / Math.tan(8 * D2R));
    const side = i % 2 ? -1 : 1, x0 = side > 0 ? r2(B / 2 - 1.6 - 3.4) : r2(-B / 2 + 1.6), z0 = r2(i % 2 ? -0.05 * L : 0.1 * L - run);
    ga.roro.ramps.push({ from: a.id, to: b.id, x0, x1: r2(x0 + 3.4), z0, z1: r2(z0 + run), up: i % 2 ? 's' : 'n' });
  }
  // house on the weather deck forward, ER aft below the main car deck, casing stair from the main car deck
  const hz0 = r2(-L / 2 + 0.06 * L), hl = r2(clamp(0.1 * L, 16, 24));
  const hw = r2(Math.min(0.82 * B, 2 * (deckMin(ga, hz0 - 1.3, hz0 + hl + 1.9) - 0.45 - 1.2)));
  const house = buildHouse(ga, { pos: 'fwd', X0: r2(-hw / 2), X1: r2(hw / 2), Z0: hz0, Z1: r2(hz0 + hl), zMinFwd: hz0, zMaxAft: r2(hz0 + hl + 14), nAcc: 4, nMax: 6, tierH: RULES.TIER_H.merchant, yMain: F, bridgeD: 6.5 });
  ga.house = house;
  const er = engineRoom(ga, m, { z1: r2(L / 2 - Math.max(6, 0.05 * L)), topY: decks[0].y });
  er.column = casingColumn(ga, er, { side: -1, z0: r2(er.z0 + 1.0) });
  placeEngines(er);
  er.steering = { z0: er.z1, z1: r2(L / 2 - 1.5), y: er.levels[er.levels.length - 1] };
  er.ecr.side = 1; er.escape = null;
  ga.er = er;
  ga.bridge = bridgeOf(ga, house, { enclosed: true });
  ga.funnel = { z: r2(L / 2 - 0.12 * L), x: 0, y: F, r: r2(clamp(0.05 * B, 1.2, 2.4)), h: 8, kind: 'single' };
  // crew stair tower from the main car deck to the weather deck (and the house), forward
  ga.roro.tower = { z0: r2(Math.max(hz0 + 1, -L / 2 + 0.2 * L)), x0: r2(-Math.min(hw / 2 - 0.6, 6)) };
  ga.deck.boats.push({ kind: 'freefall', z: r2(L / 2 - 0.1 * L), x: 0, y: r2(F + 2.8) }, { kind: 'rescue', z: r2(hz0 + hl * 0.5), x: r2(hw / 2 + 1.4), y: F, side: 1 });
  for (const side of [-1, 1]) ga.deck.mooring.push({ z: r2(-L / 2 + 0.035 * L), kind: 'windlass', side, y: F }, { z: r2(L / 2 - 4), kind: 'winch', side, y: F });
  ga.deck.masts.push({ z: r2(ga.bridge.z0 + 2), x: 0, h: 6, y: ga.bridge.compassY, radar: true });
  ga.cargo = { kind: 'cardecks', zones: decks.map((d) => ({ ...d, z0: r2(-L / 2 + 0.1 * L), z1: r2(L / 2 - 2) })) };
  return ga;
};

// ------------------------------------------------------------------------------------------------ ferries and cruise ships
// A stack of decks: crew/service decks low, car decks (ferries), public decks, cabin decks, lido and sun decks; stair
// towers through all of them (main vertical zones ≤ 48 m, SOLAS II-2/9); the bridge forward on a high deck.
function paxDecks(ga, m, o) {
  const L = ga.L, B = ga.B;
  const decks = [];
  let y = o.y0;
  let n = 1;
  for (const [use, h, name] of o.stack) { decks.push({ id: `d${n}`, n, y: r2(y), h: r2(h - 0.12), use, name: name || `Deck ${n}` }); y += h; n++; }
  const mvz = Math.max(1, Math.ceil((L * 0.86) / 48));
  const nT = o.towers || Math.max(2, Math.round(L / 75));
  let maxRise = 0; for (let k = 0; k < decks.length - 1; k++) maxRise = Math.max(maxRise, decks[k + 1].y - decks[k].y);
  const th = r2(Math.max(4.2, (stairRun(maxRise, 38) + 2 * LAND + 0.4) / 2));   // one run for the whole stairwell (gaplan.js)
  const towers = [];
  for (let i = 0; i < nT; i++) { const zc = r2(-L * 0.36 + (L * 0.7 * (i + 0.5)) / nT); towers.push({ z0: r2(zc - th), z1: r2(zc + th), id: `t${i}` }); }
  ga.layout = 'pax';
  ga.pax = { decks, towers, mvz, hullTop: ga.deckY, bridgeDeck: o.bridgeDeck, carDecks: o.carDecks || [], doubleEnded: !!o.doubleEnded, cabinsPerDeck: o.cabinsPerDeck || 0, perDeck: !!o.perDeck };
  return ga.pax;
}

GEN.cruise = (mk, m) => {
  const ga = mk(), L = ga.L, B = ga.B;
  const n = Math.min(18, Math.round(3 + 0.042 * L));
  const crewN = n >= 12 ? 3 : 2, pubN = n >= 15 ? 3 : n >= 10 ? 2 : 1, cabN = n - crewN - pubN - 2;
  const stack = [];
  for (let i = 0; i < crewN; i++) stack.push(['crew', 2.9, `Deck ${stack.length + 1} (crew)`]);
  for (let i = 0; i < pubN; i++) stack.push(['public', 3.3, `Deck ${stack.length + 1} (public)`]);
  for (let i = 0; i < cabN; i++) stack.push(['cabin', 2.9, `Deck ${stack.length + 1} (cabins)`]);
  stack.push(['lido', 3.3, `Deck ${stack.length + 1} (lido & pool)`], ['sun', 2.8, `Deck ${stack.length + 2} (sun deck)`]);
  const er = engineRoom(ga, m, { z1: r2(L / 2 - 0.1 * L), lenMul: 1 });
  const y0 = r2(er.floorY + Math.max(5.6, er.me.h + 1.4));
  er.top = y0; er.levels = [er.floorY];
  const bridgeDeck = crewN + pubN + Math.max(1, Math.round(cabN * 0.55));
  const pax = paxDecks(ga, m, { y0, stack, bridgeDeck, towers: Math.max(2, Math.round(L / 70)), perDeck: true });
  er.column = null; er.ecr.level = 0; er.steering = { z0: r2(er.z1 + 0.5), z1: r2(L / 2 - 1.5), y: pax.decks[0].y, pods: true }; er.escape = null; er.workshop = true;
  er.me = { ...er.me, rows: Math.ceil(er.me.n / 2) };
  ga.er = er;
  const bd = pax.decks[bridgeDeck - 1];
  ga.bridge = { y: bd.y, h: bd.h, z0: r2(-L / 2 + 0.13 * L), z1: r2(-L / 2 + 0.13 * L + 8), x0: r2(-B / 2 + 4), x1: r2(B / 2 - 4), room: 'bridge', wings: 'enclosed', wingTo: r2(B / 2 + 0.6), wingD: 3.2, consoles: [], aftConsole: false, compassY: r2(bd.y + bd.h + 0.12), deck: bd.id };
  ga.bridge.consoles = bridgeConsoles(ga, ga.bridge);
  ga.house = { pos: 'pax', z0: r2(-L / 2 + 0.1 * L), z1: r2(L / 2 - 0.06 * L), w: B, x0: -B / 2, x1: B / 2, tiers: [], eyeY: r2(bd.y + 1.6) };
  ga.funnel = { z: r2(L / 2 - 0.2 * L), x: 0, y: pax.decks[pax.decks.length - 1].y, r: r2(clamp(0.06 * B, 2, 3.4)), h: 9, kind: 'twin' };
  const boatDeck = pax.decks.find((d) => d.use === 'public' && d.y >= ga.deckY - 0.5) || pax.decks[crewN];
  pax.boatDeck = boatDeck.id;
  const nb = Math.max(2, Math.round((L * 0.55) / 16));
  for (let i = 0; i < nb; i++) for (const side of [-1, 1]) ga.deck.boats.push({ kind: 'davit', z: r2(-L * 0.25 + (L * 0.5 * i) / Math.max(1, nb - 1)), x: r2(side * (B / 2 + 0.9)), y: r2(boatDeck.y + 2.2), side, deck: boatDeck.id });
  for (const side of [-1, 1]) ga.deck.mooring.push({ z: r2(-L / 2 + 0.05 * L), kind: 'windlass', side, y: pax.decks[crewN].y }, { z: r2(L / 2 - 5), kind: 'winch', side, y: pax.decks[crewN].y });
  ga.cargo = { kind: 'paxdecks', zones: [] };
  ga.crew = { ...ga.crew, berths: ga.crew.opt };
  return ga;
};

GEN.ferry = (mk, m) => {
  const ga = mk(), L = ga.L, B = ga.B, F = ga.deckY;
  const de = m.id === 'ferry50', hsc = m.id === 'hsc112', big = m.id === 'ropax200';
  if (hsc) { const hullB = r2(B * 0.24); ga.hull.twin = { hullB, gap: r2(B - 2 * hullB), xc: r2(B / 2 - hullB / 2), wetY: r2(F - 2.2) }; ga.hull.bow = 'wavepiercer'; ga.hull.stemW = 0.5; }
  if (de) { ga.hull.bow = 'raked'; ga.hull.stern = 'raked'; ga.hull.sternW = 0.62; ga.hull.mid = [r2(-L / 2 + 0.2 * L), r2(L / 2 - 0.2 * L)]; ga.hull.bowFrac = 0.2; }
  const carH = de ? 4.6 : hsc ? 4.0 : 5.0;
  const car1 = r2(de ? F : hsc ? F - 2.2 : Math.max(1.8, Math.min(F - (big ? 5.3 : 0), 2.6)));
  const stack = [['car', carH + 0.3, 'Car deck']];
  if (big) stack.push(['car', carH + 0.3, 'Upper car deck']);
  stack.push(['public', 3.3, 'Passenger deck']);
  if (big) stack.push(['public', 3.3, 'Restaurant deck'], ['cabin', 2.9, 'Cabin deck'], ['cabin', 2.9, 'Cabin deck'], ['crew', 2.9, 'Crew & officers\' deck'], ['sun', 2.8, 'Sun deck']);
  else if (m.id === 'ferry') stack.push(['crew', 3.0, 'Crew & officers\' deck'], ['sun', 2.8, 'Sun deck']);
  else if (hsc) stack.push(['public', 3.3, 'Upper passenger deck'], ['sun', 2.8, 'Bridge deck']);
  else stack.push(['sun', 2.8, 'Bridge deck']);
  const er = engineRoom(ga, m, { z1: r2(L / 2 - (de ? 0.2 : 0.08) * L), topY: car1, floorY: hsc ? r2(-ga.Tk + 0.5) : undefined, levelStep: 9 });
  er.ecr.level = 0;
  const crewIdx = stack.map((q) => q[0]).lastIndexOf('crew');
  const pax = paxDecks(ga, m, { y0: car1, stack, bridgeDeck: crewIdx >= 0 ? crewIdx + 1 : stack.length, towers: de ? 1 : Math.max(2, Math.round(L / 60)), carDecks: stack.map((s, i) => (s[0] === 'car' ? i + 1 : 0)).filter(Boolean), doubleEnded: de, perDeck: big });
  // the bridge forward on the crew deck (or the top deck; fore and aft on the double-ended ferry)
  const bd = pax.decks[pax.bridgeDeck - 1];
  ga.bridge = { y: bd.y, h: bd.h, z0: r2(-L / 2 + (de ? 0.1 : 0.14) * L), z1: r2(-L / 2 + (de ? 0.1 : 0.14) * L + (de ? 4.4 : 6.5)), x0: r2(-Math.min(B / 2 - 2.5, de ? 3.5 : 8)), x1: r2(Math.min(B / 2 - 2.5, de ? 3.5 : 8)), room: 'bridge', wings: de ? 'none' : 'enclosed', wingTo: r2(B / 2 - 0.3), wingD: 3.0, consoles: [], aftConsole: false, compassY: r2(bd.y + bd.h + 0.12), deck: bd.id, twin: de };
  ga.bridge.consoles = bridgeConsoles(ga, ga.bridge);
  er.column = null; er.steering = de ? null : { z0: r2(er.z1 + 0.3), z1: r2(L / 2 - 1.5), y: er.levels[er.levels.length - 1] }; er.escape = null;
  if (hsc) { er.twinHull = true; er.me = { ...er.me, xs: [] }; }
  ga.er = er;
  ga.house = { pos: 'pax', z0: r2(-L / 2 + 0.12 * L), z1: r2(L / 2 - 0.12 * L), w: B, x0: -B / 2, x1: B / 2, tiers: [], eyeY: r2(bd.y + 1.6) };
  ga.funnel = { z: r2(L / 2 - 0.25 * L), x: 0, y: bd.y, r: r2(clamp(0.05 * B, 0.8, 2.4)), h: 5, kind: de ? 'mast' : 'twin' };
  const boatDeck = pax.decks.find((d) => d.use === 'public');
  pax.boatDeck = boatDeck.id;
  const nb = Math.max(1, Math.round((L * 0.5) / 18));
  for (let i = 0; i < nb; i++) for (const side of [-1, 1]) ga.deck.boats.push({ kind: hsc || de ? 'raft' : 'davit', z: r2(-L * 0.2 + (L * 0.4 * i) / Math.max(1, nb - 1)), x: r2(side * (B / 2 + 0.6)), y: r2(boatDeck.y + 2.2), side, deck: boatDeck.id });
  ga.cargo = { kind: 'cardecks', zones: pax.carDecks.map((n) => ({ ...pax.decks[n - 1] })), bowDoor: (m.eq || []).includes('bowDoor'), sternDoor: (m.eq || []).includes('sternDoor') };
  ga.crew = { ...ga.crew, berths: ga.crew.opt };
  return ga;
};

// ------------------------------------------------------------------------------------------------ entry point
const CACHE = new Map();
export function generalArrangement(variantId, opts = {}) {
  const pv = parseVariant(variantId);
  if (!pv) return null;
  const m = MODELS[pv.model];
  const key = `${variantId}|${opts.stage ?? 1}|${opts.livery ? JSON.stringify(opts.livery) : ''}`;
  if (CACHE.has(key)) return CACHE.get(key);
  let ga;
  if (m.gen === 'sail') ga = { id: variantId, model: m.id, gen: 'sail', delegate: 'sailing', L: m.length, B: m.beam, T: m.draft, D: m.depth, F: r2(m.depth - m.draft), deckY: r2(m.depth - m.draft), stage: opts.stage ?? 1, livery: opts.livery || null };
  else {
    const g = GEN[m.gen];
    if (!g) throw new Error(`[ga] no generator for ${m.gen}`);
    ga = g(() => baseGA(m, pv, opts), m);
    finish(ga, m);
  }
  const out = deepFreeze(ga);
  if (CACHE.size > 300) CACHE.clear();
  CACHE.set(key, out);
  return out;
}
/** True when the model (or variant) has a GA generator (all but the four sail classes). */
export function hasGA(cls) { const pv = parseVariant(cls); return !!pv && !!GEN[MODELS[pv.model].gen]; }

function finish(ga, m) {
  // levels (every floor you can stand on), sorted by height
  const lv = [];
  if (ga.er) ga.er.levels.forEach((y, i) => lv.push({ id: `er${i}`, y, name: i === 0 ? 'Engine room floor' : i === ga.er.levels.length - 1 ? 'Engine room upper platform' : `Engine room ${['', '2nd', '3rd', '4th', '5th'][i] || `${i + 1}th`} platform` }));
  if (ga.house) for (const t of ga.house.tiers) lv.push({ id: t.id, y: t.y, name: t.name });
  if (ga.bridge?.compassY) lv.push({ id: 'compass', y: ga.bridge.compassY, name: 'Compass deck' });
  if (ga.hull.fcsle) lv.push({ id: 'fcsle', y: r2(ga.deckY + ga.hull.fcsle.h), name: 'Forecastle deck' });
  if (ga.pax) for (const d of ga.pax.decks) lv.push({ id: d.id, y: d.y, name: d.name });
  if (ga.small) for (const l of ga.small.levels || []) lv.push(l);
  const seen = new Set();
  ga.levels = lv.filter((l) => (seen.has(l.id) ? false : seen.add(l.id))).sort((a, b) => a.y - b.y);
  ga.goto = gotoSeeds(ga);
  void m;
}

function roomCentre(r, y) { return { x: r2((r.x0 + r.x1) / 2), y, z: r2((r.z0 + r.z1) / 2) }; }
/** Go-to targets (gaplan.js snaps each to a standable point). */
function gotoSeeds(ga) {
  const g = [];
  const add = (id, label, p, room = null) => { if (p) g.push({ id, label, x: p.x, y: p.y, z: p.z, room }); };
  if (ga.house && ga.house.tiers.length) {
    const tiers = ga.house.tiers, nav = tiers[tiers.length - 1];
    const br = nav.rooms.find((r) => r.use === 'bridge');
    if (br) add('bridge', 'Bridge', { x: 0, y: nav.y, z: r2(br.z0 + 2.2) }, br.id);
    for (const t of tiers) for (const r of t.rooms) {
      if (r.use === 'mess' && !g.some((q) => q.id === 'mess')) add('mess', r.name, roomCentre(r, t.y), r.id);
      if (r.use === 'ccr') add('ccr', 'Cargo control room', roomCentre(r, t.y), r.id);
      if (r.use === 'hospital') add('hospital', 'Hospital', roomCentre(r, t.y), r.id);
    }
    const cab = tiers.flatMap((t) => t.rooms.map((r) => ({ r, y: t.y }))).find(({ r }) => /Master's cabin|Captain/.test(r.name)) || tiers.flatMap((t) => t.rooms.map((r) => ({ r, y: t.y }))).find(({ r }) => r.berth);
    if (cab) add('cabin', cab.r.name, roomCentre(cab.r, cab.y), cab.r.id);
  }
  if (ga.pax) {
    add('bridge', 'Bridge', { x: 0, y: ga.bridge.y, z: r2(ga.bridge.z0 + 2.2) }, 'bridge');
    for (const d of ga.pax.decks) {
      if (d.use === 'public' && !g.some((q) => q.id === 'reception')) add('reception', ga.type === 'cruise' ? 'Atrium & reception' : 'Reception', { x: 0, y: d.y, z: r2(ga.pax.towers[Math.floor(ga.pax.towers.length / 2)].z1 + 3) }, `deck:${d.id}`);
      if (d.use === 'car' && !g.some((q) => q.id === 'cardeck')) add('cardeck', 'Car deck', { x: 0, y: d.y, z: 0 }, `deck:${d.id}`);
      if (d.use === 'lido') add('lido', 'Lido & pool deck', { x: 0, y: d.y, z: 0 }, `deck:${d.id}`);
      if (d.use === 'cabin' && !g.some((q) => q.id === 'cabin')) add('cabin', 'Cabin deck', { x: 0, y: d.y, z: 0 }, `deck:${d.id}`);
    }
    if (ga.pax.boatDeck) { const d = ga.pax.decks.find((q) => q.id === ga.pax.boatDeck); add('boatdeck', 'Boat deck (promenade)', { x: r2(ga.B / 2 - 1.5), y: d.y, z: 0 }, `deck:${d.id}`); }
    if (ga.type === 'cruise') { const d = ga.pax.decks.find((q) => q.use === 'public'); add('theatre', 'Theatre', { x: 0, y: d.y, z: r2(-ga.L * 0.3) }, `deck:${d.id}`); }
  }
  if (ga.er && !ga.er.small) {
    add('ecr', 'Engine control room', { x: 0, y: ga.er.levels[ga.er.ecr.level], z: r2((ga.er.z0 + ga.er.z1) / 2) }, 'ecr');
    add('er', 'Engine room floor', { x: 0, y: ga.er.floorY, z: r2(ga.er.me.z) }, 'er-floor');
  }
  const L = ga.L;
  if (ga.hull.fcsle) add('bow', 'Forecastle (bow)', { x: 0, y: r2(ga.deckY + ga.hull.fcsle.h), z: r2(-L / 2 + ga.hull.fcsle.len * 0.35) });
  else add('bow', 'Bow', { x: 0, y: ga.deckY, z: r2(-L / 2 + Math.max(2.5, L * 0.06)) });
  add('stern', 'Stern (mooring deck)', { x: 0, y: ga.deckY, z: r2(L / 2 - Math.max(2, L * 0.025)) });
  if (ga.cargo.kind === 'holds' && ga.cargo.walk >= 0) { const z = ga.cargo.zones[ga.cargo.walk]; add('hold', `Hold ${z.i + 1} (tank top)`, { x: 0, y: z.floorY, z: r2((z.z0 + z.z1) / 2) }); }
  if (ga.deck.manifold) add('manifold', 'Manifold', { x: r2((ga.deck.manifold.w || 6) / 2 + 1.2), y: ga.deckY, z: ga.deck.manifold.z });
  if (ga.deck.compressor) add('compressor', 'Cargo compressor house', { x: 0, y: ga.deck.compressor.y ?? ga.deckY, z: r2((ga.deck.compressor.z0 + ga.deck.compressor.z1) / 2) });
  if (ga.deck.lashing?.length) { const lb = ga.deck.lashing.reduce((a, b) => (b.z < ga.house.z0 && b.z > a.z ? b : a), { z: -Infinity }); if (lb.z > -Infinity) add('lashing', 'Lashing bridge', { x: 0, y: r2(ga.deckY + RULES.CONTAINER.coaming), z: lb.z }); }
  return g;
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); }
  return o;
}
