// v6 fleet, office and boat storage (docs/V6-FLEET-CONTRACTS.md §4). Numbers and pure rules shared by the server
// (server/fleet.js, server/captain.js) and the client (public/js/fleet.js, public/js/hq.js). Plain ESM, no DOM, no state.
import { SHIP_CLASSES } from './constants.js';

export const FLEET = {
  MAX_VESSELS: 8,
  SLOTS_FREE: 3, SLOTS_MAX: 8, SLOT_PRICE: 40000,
  STORAGE_MIN_CR_DAY: 25, STORAGE_PER_T_DAY: 0.01,
  RECOMMISSION_MIN_CR: 100, RECOMMISSION_FRAC: 0.002, HULL_BASIS_MIN: 120000,
  HOME_SIZES: ['regional', 'major', 'mega'], HOME_MOVE_CR: 25000, HOME_MOVE_COOLDOWN_S: 7 * 86400,
  SWITCH_COOLDOWN_MS: 10000, SWITCH_FREE_M: 2000, TRANSFER_BASE_CR: 250, TRANSFER_CR_PER_KM: 2, TRANSFER_MAX_CR: 5000,
  NO_SWITCH_FLOODING: 0.5,
  CAPTAIN_CR_H: 20, CAPTAIN_SMALL_CR_H: 12, SMALL_LENGTH_M: 30, TOW_CREW_MUL: 1.2,
  DEN_WAGE: 3600000000,             // (milli-credits per hour) × ms → credits
  NEW_FUEL_FRAC: 0.25,
  SERVICE_THROTTLE: 0.8, TRAWL_KN: 3,
  NEAR_M: 40000, FAR_EVERY: 10, SUBSTEP_S: 0.5,
  VIEW_RANGE_M: 40000, VIEW_MAX: 60, VIEW_MOVING_MAX: 40, VIEW_FULL_EVERY: 10,
  ARRIVE_M: 1200, ARRIVE_KN: 6, HARBOUR_ZONE_M: 5000,
  HOLD_NEAR_M: 300, HOLD_SEARCH_M: [3000, 10000], HOLD_MAX_KM: 200, ANCHOR_MAX_DEPTH_M: 80, HOLD_THROTTLE: 0.1,
  DEPART_STORM: 0.6, DEPART_WIND_MS: 20, DEPART_WIND_SMALL_MS: 14, WEATHER_RECHECK_S: 600,
  MIN_COND_DEPART: 30, ABORT_COND: 20,
  FUEL_RESERVE: 1.25, FUEL_RESERVE_H: 2,
  GIVE_WAY_CHECK_S: 1, GIVE_WAY_CONE_DEG: 40, GIVE_WAY_TURN_DEG: 30, GIVE_WAY_S: 30, GIVE_WAY_THR: 0.3, GIVE_WAY_STOP_S: 120,
  REPLAN_TRIES: 2, PLANS_PER_MIN: 6, PLAN_RETRY_S: 10, STORM_REPLAN_S: 600,
  OWNER_AWAY_S: 7 * 86400, OWED_CAP_DAYS: 30,
  LEDGER_DAYS: 8, LOG_MAX: 50, LOST_MAX: 20,
  ACTION_RATE: 10, ACTION_BURST: 20,
  NAMES: ['Sea Bee', 'Kittiwake', 'North Star', 'Grey Gull', 'Dogger Lass', 'Morning Tide', 'Silver Herring', 'Puffin',
    'Westerly', 'Good Hope', 'Storm Petrel', 'Harbour Light'],
};
export const VESSEL_ID_RE = /^v[0-9a-z]{1,16}$/;
export const JOB_ID_RE = /^j[0-9a-z]{1,16}$/;
export const SHIP_NAME_RE = /^[\p{L}\p{N} '.\-]{2,24}$/u;
export const ORDER_TYPES = ['sail_to', 'home', 'hold', 'route', 'contract', 'stop'];
export const STATES = ['laid_up', 'docked', 'at_sea', 'anchored'];
export const LEDGER_CATS = ['income', 'costs', 'fuel', 'port', 'tugs', 'repairs', 'wages', 'storage', 'fees', 'arrears', 'ships'];
export const CAPTAIN_JOB_TYPES = ['freight', 'passengers', 'charter', 'fishing', 'supply'];

const cls = (c) => SHIP_CLASSES[c] || SHIP_CLASSES.coaster;
const r5 = (v) => Math.round(v * 1e5) / 1e5;

export function storageFeePerDay(c) { return Math.max(FLEET.STORAGE_MIN_CR_DAY, Math.round(FLEET.STORAGE_PER_T_DAY * cls(c).displacement)); }
export function recommissionFee(c) { return Math.max(FLEET.RECOMMISSION_MIN_CR, Math.round(FLEET.RECOMMISSION_FRAC * Math.max(FLEET.HULL_BASIS_MIN, cls(c).price || 0))); }
/** Launch / helicopter transfer to a ship `distM` metres away: free within SWITCH_FREE_M. */
export function transferFee(distM) {
  if (!(distM > FLEET.SWITCH_FREE_M)) return 0;
  return Math.min(FLEET.TRANSFER_MAX_CR, Math.round(FLEET.TRANSFER_BASE_CR + (FLEET.TRANSFER_CR_PER_KM * distM) / 1000));
}
export function captainCrH(c) { return cls(c).length < FLEET.SMALL_LENGTH_M ? FLEET.CAPTAIN_SMALL_CR_H : FLEET.CAPTAIN_CR_H; }
/** Wage rate (milli-credits per hour) of a captained ship. duty: 'underway' | 'duty' | 'off'. */
export function wageRateMcrH(c, duty, towing = false) {
  const cap = captainCrH(c) * 1000;
  if (duty === 'underway') return Math.round((cls(c).crewCost || 0) * (towing ? FLEET.TOW_CREW_MUL : 1) * 1000) + cap;
  return duty === 'duty' ? cap : 0;
}
/** Integer wage accrual: adds rate × ms to pay.rem and returns the whole credits now due (remainder carried). */
export function accrueWage(pay, rateMcrH, ms) {
  const m = Math.round(ms);
  if (!(rateMcrH > 0) || !(m > 0)) return 0;
  const total = rateMcrH * m + (pay.rem || 0);
  const cr = Math.floor(total / FLEET.DEN_WAGE);
  pay.rem = total - cr * FLEET.DEN_WAGE;
  return cr;
}
export function validShipName(s) { const n = String(s ?? '').replace(/\s+/g, ' ').trim(); return SHIP_NAME_RE.test(n) ? n : null; }
/** First default name not in `taken` (case-insensitive); then "Sea Bee 2", "Kittiwake 2", … */
export function defaultShipName(taken) {
  const t = new Set([...(taken || [])].map((x) => String(x).toLowerCase()));
  for (let k = 1; k < 100; k++) for (const n of FLEET.NAMES) { const name = k === 1 ? n : `${n} ${k}`; if (!t.has(name.toLowerCase())) return name; }
  return 'Vessel';
}
export function homeAllowed(h) { return !!h && FLEET.HOME_SIZES.includes(h.size); }
export function stateOf(v) {
  if (v.status === 'laidup') return 'laid_up';
  if (v.docked) return 'docked';
  const ph = v.cap && v.cap.phase;
  return ph === 'anchored' || ph === 'holding' ? 'anchored' : 'at_sea';
}
export function dayKey(unixS) { return new Date(Math.floor(unixS) * 1000).toISOString().slice(0, 10); }
/** The n UTC day keys ending today, oldest first. */
export function lastDays(unixS, n = 7) { const out = []; for (let i = n - 1; i >= 0; i--) out.push(dayKey(unixS - i * 86400)); return out; }
/** Ledger totals over `keys` (day keys) of book.days, for one vessel or all. */
export function totals(days, keys, vid = null) {
  const t = { income: 0, costs: 0, net: 0, ships: 0, byCat: {} };
  for (const k of keys) for (const [v, cats] of Object.entries((days && days[k]) || {})) {
    if (vid && v !== vid) continue;
    for (const [cat, amt] of Object.entries(cats)) {
      t.byCat[cat] = (t.byCat[cat] || 0) + amt;
      if (cat === 'ships') t.ships += amt; else if (amt > 0) t.income += amt; else t.costs -= amt;
    }
  }
  t.net = t.income - t.costs;
  return t;
}
/** Validate and normalise an order from the wire. isHarbor(id) → bool. → { ok: true, order } | { ok: false, why }. */
export function normalizeOrder(o, isHarbor) {
  if (!o || typeof o !== 'object' || !ORDER_TYPES.includes(o.type)) return { ok: false, why: 'Unknown order.' };
  const pick = (v, allowed, d) => (allowed.includes(v) ? v : d);
  const ll = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 85 && Math.abs(lon) <= 180;
  switch (o.type) {
    case 'sail_to':
      if (typeof o.harbor !== 'string' || !isHarbor(o.harbor)) return { ok: false, why: 'Pick a harbour to sail to.' };
      return { ok: true, order: { type: 'sail_to', harbor: o.harbor, then: pick(o.then, ['moor', 'lay_up', 'hold'], 'moor') } };
    case 'home': return { ok: true, order: { type: 'home', then: pick(o.then, ['moor', 'lay_up'], 'moor') } };
    case 'hold': {
      if (o.lat == null && o.lon == null) return { ok: true, order: { type: 'hold' } };
      const lat = Number(o.lat), lon = Number(o.lon);
      if (!ll(lat, lon)) return { ok: false, why: 'That position is not on the chart.' };
      return { ok: true, order: { type: 'hold', lat: r5(lat), lon: r5(lon) } };
    }
    case 'route': {
      const r = o.route;
      if (!Array.isArray(r) || r.length < 1 || r.length > 250) return { ok: false, why: 'A route needs 1–250 waypoints.' };
      const pts = [];
      for (const p of r) {
        const lat = Number(Array.isArray(p) ? p[0] : p && p.lat), lon = Number(Array.isArray(p) ? p[1] : p && p.lon);
        if (!ll(lat, lon)) return { ok: false, why: 'A waypoint is not on the chart.' };
        pts.push([r5(lat), r5(lon)]);
      }
      const harbor = typeof o.harbor === 'string' && isHarbor(o.harbor) ? o.harbor : null;
      return { ok: true, order: { type: 'route', route: pts, harbor, then: pick(o.then, ['moor', 'hold'], harbor ? 'moor' : 'hold') } };
    }
    case 'contract': {
      const jobId = o.jobId == null ? null : String(o.jobId);
      if (jobId !== null && !JOB_ID_RE.test(jobId)) return { ok: false, why: 'Unknown contract.' };
      return { ok: true, order: { type: 'contract', jobId, then: pick(o.then, ['stay', 'home'], 'stay') } };
    }
    default: return { ok: true, order: { type: 'stop' } };
  }
}
