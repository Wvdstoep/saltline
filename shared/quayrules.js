// Dock anywhere (docs/DOCK-ANYWHERE-CONTRACT.md): the rules every side agrees on — which quay takes which ship, what a
// day alongside costs, which harbour services reach a quay and at what surcharge, and when a ship may make fast.
// Plain ESM, no deps, no DOM: the server (server/quays.js, game wiring), the client card (public/js/quayfmt.js) and the
// tests import it directly. Relative imports only, so '/shared/quayrules.js' works in the browser and under Node.
import { SHIP_CLASSES, FEES } from './constants.js';

const D2R = Math.PI / 180;

export const QUAY = {
  VERSION: 1,
  // --- discovery (server/quays.js)
  QUERY_RADIUS_M: 1500,      // quay_query lists candidates this far from the ship
  MAX_CANDIDATES: 12,        // … at most this many, nearest first
  MAX_NEW_TILES: 6,          // tiles analysed per query at most (≈ 30 ms each); the rest come with the next query
  MIN_RUN_M: 25,             // straight quay runs shorter than this are not berths
  MAX_RUN_M: 1200,           // longer straight runs are split into equal pieces (deterministic)
  STRAIGHT_TOL_M: 3,         // a vertex may sit this far off the run's line …
  STRAIGHT_TURN_DEG: 12,     // … and a segment may turn this much from the run's direction
  JOIN_M: 2.5,               // segment ends this close are the same point (chaining)
  MERGE_DEG: 25, MERGE_OFF_M: 8, MERGE_GAP_M: 60, REFINE_M: 12, // straight pieces that continue each other become one run (server/quays.js mergeCollinear)
  STEP_M: 10,                // depth is sampled every STEP_M along the run …
  OFFSETS_M: [4, 10, 18, 28, 40, 55], // … at these distances off the face into the water
  FACE_BAND_M: 10,          // offsets this close to the face may fail in short notches (raster stairs) …
  NOTCH_STEPS: 2,            // … of at most this many steps between good ones
  FENDER_M: 1.5,             // the hull lies this far off the face
  BRIDGE_CLEAR_M: 15,        // no berth within (bridge width / 2 + this) of a bridge
  FAIRWAY_OFFSET_M: 18,      // a step whose water within this of the face is FAIRWAY is not a berth (no mooring in a fairway)
  HARBOUR_BERTH_M: 35,       // a step this close to a harbour-patch berth belongs to that harbour's own berth list
  // --- fit
  SMALL_CRAFT_M: 30,         // pontoons take hulls up to this length (same as server/game.js berthFits)
  CLEAR_EXTRA_M: 6,          // water width needed alongside: beam + this
  // --- approach (quay_dock)
  DOCK_LATERAL_M: 40,        // ship centre within this of the berth line …
  DOCK_ALONG_MIN_M: 30,      // … and within max(this, L/4) of the slot centre along the quay
  DOCK_MAX_KN: 2,
  DOCK_ALIGN_DEG: 25,        // heading within this of the quay (either way round)
  TUG_RANGE_M: 1500, TUG_MAX_KN: 6, TUG_SECONDS: 45,
  // --- money
  MIN_FEE: 25,               // cr per day, any ship
  CLASS_MUL: { terminal: 1.5, industrial: 1.0, city: 1.3, marina: 1.2, quay: 0.9 },
  PORT_MUL: { mega: 1.25, major: 1.1, regional: 1.0, minor: 0.9 },
  OUTSIDE_PORT_MUL: 0.8,     // a quay beyond the linked harbour's port limits
  HOME_MUL: 0.5,             // your fleet's home port (within its port limits)
  TUG_OUTSIDE_MUL: 1.5,      // tugs called out beyond the port limits
  // --- services
  PORT_RADIUS_KM: { mega: 12, major: 8, regional: 5, minor: 3 }, // = server/worldtiles.js PORT_RADIUS_KM
  NEAR_KM: 25, REMOTE_KM: 60,
};

export const QUAY_CLASSES = {
  terminal: { id: 'terminal', name: 'Commercial terminal', short: 'Terminal' },
  industrial: { id: 'industrial', name: 'Industrial quay', short: 'Industrial' },
  city: { id: 'city', name: 'City quay', short: 'City quay' },
  marina: { id: 'marina', name: 'Marina pontoon', short: 'Pontoon' },
  quay: { id: 'quay', name: 'Quay wall', short: 'Quay' },
};

/**
 * Harbour services by tier (distance from the quay to the linked harbour). mul = price factor for that service
 * (buy side; market sell prices are divided by `market`), maxFuelT = most fuel one order may take (null = no cap).
 *   port    inside the harbour's port limits: everything, as in the harbour (port dues and pilotage too)
 *   near    ≤ 25 km: goods and fuel come by truck, a mobile repair crew, the office; no shipyard, no yard service
 *   remote  ≤ 60 km: fuel by truck and the office only
 *   none    beyond: nothing but the quay itself
 */
export const SERVICE_TIERS = {
  port: { id: 'port', label: 'In port', market: 1, fuel: 1, repair: 1, service: 1, shipyard: true, office: true, jobs: true, deliver: true, shady: true, inport: true, tugs: true, dues: true, ashore: false, maxFuelT: null, note: 'All harbour services, as at the harbour berths.' },
  near: { id: 'near', label: 'Outside the port', market: 1.06, fuel: 1.12, repair: 1.25, service: null, shipyard: false, office: true, jobs: true, deliver: false, shady: false, inport: false, tugs: 'big', dues: false, ashore: false, maxFuelT: 400, note: 'Goods and fuel come by truck, repairs by a mobile crew. Shipyard and contract delivery only at the harbour.' },
  remote: { id: 'remote', label: 'Remote quay', market: null, fuel: 1.25, repair: null, service: null, shipyard: false, office: true, jobs: false, deliver: false, shady: false, inport: false, tugs: false, dues: false, ashore: false, maxFuelT: 150, note: 'Only fuel by truck and the fleet office (by phone).' },
  none: { id: 'none', label: 'No services', market: null, fuel: null, repair: null, service: null, shipyard: false, office: false, jobs: false, deliver: false, shady: false, inport: false, tugs: false, dues: false, ashore: false, maxFuelT: null, note: 'No harbour within 60 km: you can only lie here.' },
};
/** Harbour-sheet tabs (public/js/hud.js TABS) open at each tier. */
export const TIER_TABS = {
  port: ['overview', 'jobs', 'boards', 'market', 'shipyard', 'services', 'shady', 'office', 'players'],
  near: ['overview', 'jobs', 'boards', 'market', 'services', 'office', 'players'],
  remote: ['overview', 'services', 'office'],
  none: ['overview'],
};

export const clsOf = (cls) => SHIP_CLASSES[cls] || SHIP_CLASSES.coaster;
const r1 = (v) => Math.round(v * 10) / 10;

/** Great-circle metres (same formula as shared/geo.js haversine, inlined so this module stays dependency-light). */
export function distM(lat1, lon1, lat2, lon2) {
  const R = 6371000, dLat = (lat2 - lat1) * D2R, dLon = (lon2 - lon1) * D2R;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Quay length a ship needs: hull + 10 % (≥ 10 m) for the lines fore and aft. */
export function neededLength(cls) { const L = clsOf(cls).length; return Math.round(L + Math.max(10, 0.1 * L)); }
/** Under-keel clearance alongside (sheltered water): 5 % of the draught, at least 0.3 m. */
export function ukc(cls) { return Math.max(0.3, 0.05 * clsOf(cls).draft); }
/** Depth at LOW WATER a ship needs alongside. */
export function neededDepth(cls) { return r1(clsOf(cls).draft + ukc(cls)); }
/** Water width needed off the face (beam + 6 m). */
export function neededWidth(cls) { return clsOf(cls).beam + QUAY.CLEAR_EXTRA_M; }
/** Which sampled offsets (QUAY.OFFSETS_M indices) must be deep enough for this ship: the first, plus every one inside the needed width. */
export function offsetsFor(cls) {
  const w = neededWidth(cls), out = [0];
  for (let i = 1; i < QUAY.OFFSETS_M.length; i++) if (QUAY.OFFSETS_M[i] <= w) out.push(i);
  // a ship wider than the last offset needs that one too (the profile cannot see further)
  if (w > QUAY.OFFSETS_M[QUAY.OFFSETS_M.length - 1] && !out.includes(QUAY.OFFSETS_M.length - 1)) out.push(QUAY.OFFSETS_M.length - 1);
  return out;
}

/** Service tier of a quay `dKm` from harbour `h` ({size}). */
export function serviceTier(h, dKm) {
  if (!h || !Number.isFinite(dKm)) return 'none';
  if (dKm <= (QUAY.PORT_RADIUS_KM[h.size] || 3)) return 'port';
  if (dKm <= QUAY.NEAR_KM) return 'near';
  if (dKm <= QUAY.REMOTE_KM) return 'remote';
  return 'none';
}
/** The nearest harbour to a point (deterministic: ties go to the lower id) → { harbor, dKm } | null. */
export function linkHarbour(harbors, lat, lon) {
  let best = null, bd = Infinity;
  for (const h of harbors || []) {
    if (!h || !Number.isFinite(h.lat) || !Number.isFinite(h.lon)) continue;
    const d = distM(lat, lon, h.lat, h.lon);
    if (d < bd - 1e-6 || (Math.abs(d - bd) <= 1e-6 && best && h.id < best.id)) { bd = d; best = h; }
  }
  return best ? { harbor: best, dKm: Math.round(bd / 100) / 10 } : null;
}
/** Can this tier's harbour send tugs? (port: always; near: only mega / major ports; else no) */
export function tugsAvailable(tier, h) {
  const t = SERVICE_TIERS[tier]; if (!t || !t.tugs) return false;
  return t.tugs === true || (t.tugs === 'big' && (h?.size === 'mega' || h?.size === 'major'));
}
/** Tug cost to a quay: the harbour tug rate (server/economy.js tugCostFor) × 1.5 outside the port limits. */
export function quayTugCost(cls, tier) {
  const base = Math.max(FEES.TUG_MIN, Math.round(clsOf(cls).displacement * FEES.TUG_PER_T));
  return tier === 'port' ? base : Math.round(base * QUAY.TUG_OUTSIDE_MUL);
}

/** Harbour berth fee per day for the class (= server/economy.js berthFeePerDay). */
export function baseBerthFee(cls) { return Math.round(clsOf(cls).displacement * FEES.BERTH_PER_T_DAY); }
/**
 * Price of one day (or started day) at a quay:
 *   max(MIN_FEE, round(baseBerthFee(cls) × CLASS_MUL[quayCls] × portMul × homeMul))
 *   portMul = PORT_MUL[harbour size] inside its port limits, else OUTSIDE_PORT_MUL; homeMul = HOME_MUL at the home port.
 */
export function quayFeePerDay(cls, quayCls, { size = null, tier = 'none', home = false } = {}) {
  const cm = QUAY.CLASS_MUL[quayCls] ?? QUAY.CLASS_MUL.quay;
  const pm = tier === 'port' ? QUAY.PORT_MUL[size] ?? 1 : QUAY.OUTSIDE_PORT_MUL;
  const hm = home && tier === 'port' ? QUAY.HOME_MUL : 1;
  return Math.max(QUAY.MIN_FEE, Math.round(baseBerthFee(cls) * cm * pm * hm));
}
/** Started days alongside (at least 1). */
export function daysAlongside(seconds) { return Math.max(1, Math.ceil(Math.max(0, Number(seconds) || 0) / 86400 - 1e-9)); }
/** Total for a stay; the first day is paid when the lines go ashore, the rest on casting off. */
export function stayFee(perDay, seconds) { return perDay * daysAlongside(seconds); }
/** What casting off still costs: the stay minus what was paid. */
export function balanceDue(perDay, seconds, paid) { return Math.max(0, stayFee(perDay, seconds) - Math.max(0, Number(paid) || 0)); }

/** Price factor of a service at a tier, or null when the tier does not offer it. 'shipyard' / 'office' → 1 | null. */
export function serviceMul(tier, service) {
  const t = SERVICE_TIERS[tier] || SERVICE_TIERS.none;
  if (service === 'shipyard' || service === 'office' || service === 'jobs' || service === 'deliver' || service === 'shady' || service === 'inport' || service === 'ashore') return t[service] ? 1 : null;
  const v = t[service];
  return Number.isFinite(v) ? v : null;
}
/**
 * May a ship moored at a quay berth (`berth.quay`) use a harbour service? Harbour berths (no `quay` flag) always may.
 * Returns null (allowed) or the reason shown to the skipper.
 */
export function quayDenies(berth, service, harbourName = 'the harbour') {
  if (!berth || !berth.quay) return null;
  if (serviceMul(berth.tier, service) != null) return null;
  if (service === 'inport') return `That needs you in ${harbourName} itself${Number.isFinite(berth.hdKm) ? `, ${berth.hdKm} km away` : ''}.`;
  const what = { shady: 'The back room', market: 'The market', fuel: 'Fuel', repair: 'Repairs', service: 'The yard service', shipyard: 'The shipyard', office: 'The fleet office', jobs: 'The contract board', deliver: 'Contract delivery', ashore: 'Going ashore' }[service] || 'That service';
  return `${what} is not available at this quay. Sail to ${harbourName}${berth.tier === 'none' || !Number.isFinite(berth.hdKm) ? '' : `, ${berth.hdKm} km away`}.`;
}

/** Which harbour service a game action (server/game.js onAction) uses — gated at quay berths by quayDenies. */
export const ACTION_SERVICE = {
  buy_goods: 'market', sell_goods: 'market', buy_fuel: 'fuel', repair: 'repair', buy_kit: 'repair', service: 'service',
  buy_ship: 'shipyard', buy_used: 'shipyard', sell_ship: 'shipyard', accept_job: 'jobs', deliver_jobs: 'deliver', lookaround: 'shady',
  // fleet (server/fleet.js) actions that need you IN the harbour; the rest (orders, renames, HQ) work from anywhere
  fleet_slot: 'inport', fleet_home: 'inport', switch_ship: 'inport',
};
/** Trucking / call-out surcharge on a harbour bill paid at a quay: round(amount × (mul − 1)); 0 in port or when not offered. */
export function quaySurcharge(tier, service, amount) {
  const m = serviceMul(tier, service);
  return m == null || m <= 1 ? 0 : Math.round(Math.abs(Number(amount) || 0) * (m - 1));
}

/** Approach check for quay_dock. slot: { lat, lon, hdg, s, len } in the run frame; ship: { lat, lon, hdg, spd }; along/lateral (m) precomputed. */
export function approachWhy({ lateralM, alongM, hdgDiffDeg, spdKn, cls }) {
  const L = clsOf(cls).length;
  if (Math.abs(spdKn) > QUAY.DOCK_MAX_KN) return `Slow below ${QUAY.DOCK_MAX_KN} kn to make fast.`;
  if (!(Math.abs(lateralM) <= QUAY.DOCK_LATERAL_M)) return `Come alongside: you are ${Math.round(Math.abs(lateralM))} m off the berth line (≤ ${QUAY.DOCK_LATERAL_M} m).`;
  if (!(Math.abs(alongM) <= Math.max(QUAY.DOCK_ALONG_MIN_M, L / 4))) return `The marked berth is ${Math.round(Math.abs(alongM))} m further along the quay — move up to it.`;
  const a = Math.abs(((hdgDiffDeg % 180) + 180) % 180); const off = Math.min(a, 180 - a);
  if (off > QUAY.DOCK_ALIGN_DEG) return `Line up with the quay: you are ${Math.round(off)}° off (≤ ${QUAY.DOCK_ALIGN_DEG}°).`;
  return null;
}
