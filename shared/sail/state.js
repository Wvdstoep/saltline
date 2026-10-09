// Saltline sailing — the rig state on the ship (saved in vessel.ship, sent in `you`), commands, and the compact view
// for other players (docs/SAILING-CONTRACT.md §1.4, §3.1, §3.4, §3.6, §3.7). Pure, deterministic, never throws.
import { rigOf, sailDef, planState, clamp } from './rigs.js';
import { chordOf } from './aero.js';

export const RIG_SCHEMA = 1;
export const AUTO = ['off', 'hint', 'full'];
export const JOBS = ['hoist', 'lower', 'reef', 'shake'];
const DEFAULT_SHEET = 0.3;

/**
 * RigState — ship.rig (saved in vessel.ship, sent in `you`). All angles degrees, all fractions 0…1.
 * @typedef {{ v: 1, cls: string, auto: 'off'|'hint'|'full',
 *   lv: number, lvAt: number,            // plan level last applied by the crew (auto 'full') and the rig clock (s) of it
 *   d: number,                           // depower 0…0.9 (auto-trim controller memory)
 *   heel: number, leeway: number, helm: number, // heel + = starboard rail down; leeway + = to starboard of the heading; helm = weather-helm load (1 = full rudder)
 *   awa: number, aws: number, twa: number, tws: number, // apparent / true wind over the water: angle signed (+ = from starboard), speed m/s
 *   tack: 1|-1, irons: number, jibe: number, // +1 starboard tack / −1 port; seconds in irons; rig clock of the last jibe
 *   flags: number,                       // bit 0 by-the-lee, 1 rounding up, 2 hull flying (cat), 3 overpowered, 4 crash jibe this step
 *   sails: Object<string, SailState>,
 *   // extensions (Lane A, documented in docs/SAILING-PHASE2.md): rig clock, controller timers, diagnostics
 *   clk: number, lvT: number, hiT: number, rel: number, over: number, man: null|'tack'|'jibe', manT: number,
 *   bk: number, yr: number, load: number, nan: number, fast: number, ev: Array<{kind: string, aws?: number}> }} RigState
 * @typedef {{ hoist: number, hoistCmd: number, reef: number, reefCmd: number, sheet: number, sheetCmd: number,
 *   trav: number, travCmd: number, side: -1|1, angle: number, state: number, tt: number, work: number,
 *   job: null|'hoist'|'lower'|'reef'|'shake', al?: number, be?: number }} SailState
 * RigView — what a renderer needs: { heel, sails: [{ id, hoist, reef, angle, state, tt }] } in RIGS order.
 */

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const int = (v, lo, hi, d) => (typeof v === 'number' && Number.isFinite(v) ? clamp(Math.round(v), lo, hi) : d);

/** The hoist each sail gets from "all set" (§3.4): every working sail up, unreefed; light sails down. */
const setHoist = (s) => (s.light ? 0 : 1);

function newSail(s, hoisted, tack = 1) {
  const h = hoisted ? setHoist(s) : 0, side = -tack;
  const c = chordOf(s, DEFAULT_SHEET, 0);
  return { hoist: h, hoistCmd: h, reef: 0, reefCmd: 0, sheet: DEFAULT_SHEET, sheetCmd: DEFAULT_SHEET, trav: 0, travCmd: 0,
    side, angle: Math.round(side * c.delta * 10) / 10, state: h > 0 ? 0 : 5, tt: 0, work: 0, job: null };
}

/** A fresh rig for a sail class (null for engine classes). hoisted → every working sail set (§3.6 migration). */
export function defaultRig(cls, { hoisted = false, auto = 'hint' } = {}) {
  const R = rigOf(cls); if (!R) return null;
  const sails = {};
  for (const s of R.sails) sails[s.id] = newSail(s, hoisted);
  return {
    v: RIG_SCHEMA, cls, auto: AUTO.includes(auto) ? auto : 'hint',
    lv: 0, lvAt: 0, d: 0, heel: 0, leeway: 0, helm: 0, awa: 0, aws: 0, twa: 0, tws: 0,
    tack: 1, irons: 0, jibe: 0, flags: 0, sails,
    clk: 0, lvT: 0, hiT: 0, rel: 0, over: 0, man: null, manT: 0, bk: 0, yr: 0, load: 0, nan: 0, fast: 0, ev: [],
  };
}

let warnedSchema = false;
/** Clamp/repair a saved or received rig → a valid RigState for `cls` (or null for engine classes). Never throws. */
export function normalizeRig(cls, rig, legacySailsUp) {
  const R = rigOf(cls); if (!R) return null;
  const hoisted = legacySailsUp !== false;
  try {
    if (!rig || typeof rig !== 'object' || Array.isArray(rig)) return defaultRig(cls, { hoisted });
    if (num(rig.v, 0) > RIG_SCHEMA) {
      if (!warnedSchema) { warnedSchema = true; try { console.warn(`[sail] rig schema v${rig.v} is newer than ${RIG_SCHEMA}: replaced by a default rig`); } catch { /* no console */ } }
      return defaultRig(cls, { hoisted });
    }
    if (rig.cls !== cls) return defaultRig(cls, { hoisted, auto: rig.auto });
    const out = defaultRig(cls, { hoisted: false, auto: rig.auto });
    out.lv = int(rig.lv, 0, R.plans.length - 1, 0);
    out.lvAt = num(rig.lvAt, 0); out.clk = Math.max(0, num(rig.clk, 0));
    out.d = clamp(num(rig.d, 0), 0, 0.9);
    out.heel = clamp(num(rig.heel, 0), -80, 80); out.leeway = clamp(num(rig.leeway, 0), -30, 30); out.helm = clamp(num(rig.helm, 0), -5, 5);
    out.awa = clamp(num(rig.awa, 0), -180, 180); out.aws = clamp(num(rig.aws, 0), 0, 150);
    out.twa = clamp(num(rig.twa, 0), -180, 180); out.tws = clamp(num(rig.tws, 0), 0, 150);
    out.tack = rig.tack === -1 ? -1 : 1;
    out.irons = clamp(num(rig.irons, 0), 0, 1e6); out.jibe = num(rig.jibe, 0);
    out.flags = int(rig.flags, 0, 31, 0) & ~16;        // a crash jibe is a one-step event
    out.lvT = clamp(num(rig.lvT, 0), 0, 1e6); out.hiT = clamp(num(rig.hiT, 0), 0, 1e6);
    out.rel = clamp(num(rig.rel, 0), 0, 5); out.over = clamp(num(rig.over, 0), 0, 1e6);
    out.man = rig.man === 'tack' || rig.man === 'jibe' ? rig.man : null; out.manT = clamp(num(rig.manT, 0), 0, 1e6);
    out.bk = rig.bk === 1 || rig.bk === -1 ? rig.bk : 0; out.yr = clamp(num(rig.yr, 0), -100, 100);
    out.load = clamp(num(rig.load, 0), 0, 10);
    const src = rig.sails && typeof rig.sails === 'object' ? rig.sails : {};
    for (const s of R.sails) {
      const o = Object.prototype.hasOwnProperty.call(src, s.id) ? src[s.id] : null;
      if (!o || typeof o !== 'object') continue;        // missing sail → stays down (defaultRig above)
      const t = out.sails[s.id], nr = s.reefs.length;
      t.hoist = clamp(num(o.hoist, 0), 0, 1);
      t.hoistCmd = clamp(num(o.hoistCmd, t.hoist), 0, 1); if (!s.furl) t.hoistCmd = t.hoistCmd >= 0.5 ? 1 : 0;
      t.reef = int(o.reef, 0, nr, 0); t.reefCmd = int(o.reefCmd, 0, nr, t.reef);
      t.sheet = clamp(num(o.sheet, DEFAULT_SHEET), 0, 1); t.sheetCmd = clamp(num(o.sheetCmd, t.sheet), 0, 1);
      t.trav = s.boom ? clamp(num(o.trav, 0), -1, 1) : 0; t.travCmd = s.boom ? clamp(num(o.travCmd, t.trav), -1, 1) : 0;
      t.side = o.side === 1 ? 1 : -1;
      t.angle = clamp(num(o.angle, t.side * chordOf(s, t.sheet, t.trav).delta), -100, 100);
      t.state = int(o.state, 0, 5, t.hoist > 0 ? 0 : 5); t.tt = int(o.tt, 0, 63, 0);
      t.job = JOBS.includes(o.job) ? o.job : null;
      t.work = t.job ? clamp(num(o.work, 0), 0, 3600) : 0;
      if (t.job && !(t.work > 0)) t.job = null;
      if (!s.furl && !t.job) t.hoist = t.hoist >= 0.5 ? 1 : 0;   // a non-furling sail is up or down when nobody works on it
    }
    return out;
  } catch {
    return defaultRig(cls, { hoisted });
  }
}

/** Create/repair ship.rig for ship.cls (rig.cls mismatch → new rig); deletes rigs of engine classes. → rig | null */
export function ensureRig(ship, legacySailsUp) {
  if (!ship || typeof ship !== 'object') return null;
  if (!rigOf(ship.cls)) { if (ship.rig !== undefined) delete ship.rig; return null; }
  const g = ship.rig;
  if (g && typeof g === 'object' && g.v === RIG_SCHEMA && g.cls === ship.cls && g.sails && typeof g.sails === 'object' && Array.isArray(g.ev)) return g;
  ship.rig = normalizeRig(ship.cls, g, legacySailsUp);
  return ship.rig;
}

/** The crew has done it: actual values = commands, no jobs running. For the server's copy of an online skipper's rig
 *  (her own client runs the crew) and for automatic crews outside the physics (captains, tug furl). Returns rig. */
export function settleRig(rig) {
  if (!rig || !rig.sails) return rig;
  for (const k in rig.sails) { const t = rig.sails[k]; t.hoist = t.hoistCmd; t.reef = t.reefCmd; t.sheet = t.sheetCmd; t.trav = t.travCmd; t.job = null; t.work = 0; if (!(t.hoist > 0.001)) t.state = 5; }
  return rig;
}

/** True when any sail is (being) set: hoist > 0.05 or hoistCmd > 0. */
export function anyHoisted(rig) {
  if (!rig || !rig.sails) return false;
  for (const k in rig.sails) { const t = rig.sails[k]; if (t && (t.hoist > 0.05 || t.hoistCmd > 0)) return true; }
  return false;
}

/** Plan level → hoistCmd/reefCmd (crew preset, Appendix A planState); sets rig.lv. Returns rig. */
export function applyPlan(cls, rig, level) {
  const R = rigOf(cls); if (!R || !rig || !rig.sails) return rig;
  const lv = clamp(Math.round(num(level, 0)), 0, R.plans.length - 1);
  const ps = planState(R, lv);
  for (const s of R.sails) {
    const t = rig.sails[s.id]; if (!t) continue;
    const p = ps[s.id];
    t.hoistCmd = s.furl ? (p.hoist > 0 ? clamp(1 - p.furl, 0, 1) : 0) : (p.hoist > 0 ? 1 : 0);
    t.reefCmd = Math.min(p.reef, s.reefs.length);
  }
  rig.lv = lv;
  return rig;
}

/**
 * Validate + apply a client command (§3.4) → { ok: true } | { ok: false, why }. Sets *Cmd fields only (the crew and
 * winches move the actual values). Order of application: auto, all, plan, sails, maneuver.
 */
export function applyRigCommand(cls, rig, cmd) {
  const R = rigOf(cls);
  if (!R) return { ok: false, why: 'Not a sailing ship.' };
  if (!rig || typeof rig !== 'object' || !rig.sails) return { ok: false, why: 'No rig.' };
  if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) return { ok: false, why: 'Bad command.' };
  if (cmd.auto !== undefined && !AUTO.includes(cmd.auto)) return { ok: false, why: 'Unknown helper level.' };
  if (cmd.all !== undefined && cmd.all !== 'set' && cmd.all !== 'furl') return { ok: false, why: 'Bad command.' };
  if (cmd.plan !== undefined && !(Number.isInteger(cmd.plan) && cmd.plan >= 0 && cmd.plan < R.plans.length)) return { ok: false, why: 'No such sail plan.' };
  if (cmd.maneuver !== undefined && cmd.maneuver !== null && cmd.maneuver !== 'tack' && cmd.maneuver !== 'jibe') return { ok: false, why: 'Bad manoeuvre.' };
  const edits = [];
  if (cmd.sails !== undefined) {
    if (!cmd.sails || typeof cmd.sails !== 'object' || Array.isArray(cmd.sails)) return { ok: false, why: 'Bad command.' };
    for (const id of Object.keys(cmd.sails)) {
      const s = sailDef(R, id);
      if (!s || !rig.sails[id]) return { ok: false, why: 'No such sail.' };
      const o = cmd.sails[id];
      if (!o || typeof o !== 'object') return { ok: false, why: 'Bad command.' };
      for (const k of ['hoist', 'reef', 'sheet', 'trav']) if (o[k] !== undefined && !(typeof o[k] === 'number' && Number.isFinite(o[k]))) return { ok: false, why: 'Bad number.' };
      edits.push([s, o]);
    }
  }
  if (cmd.auto !== undefined) rig.auto = cmd.auto;
  if (cmd.all === 'set') {
    for (const s of R.sails) { const t = rig.sails[s.id]; if (!t) continue; t.hoistCmd = setHoist(s); t.reefCmd = 0; }
    rig.lv = 0;
  } else if (cmd.all === 'furl') {
    for (const s of R.sails) { const t = rig.sails[s.id]; if (t) t.hoistCmd = 0; }
  }
  if (cmd.plan !== undefined) applyPlan(cls, rig, cmd.plan);
  for (const [s, o] of edits) {
    const t = rig.sails[s.id];
    if (o.hoist !== undefined) { const h = clamp(o.hoist, 0, 1); t.hoistCmd = s.furl ? h : (h >= 0.5 ? 1 : 0); }
    if (o.reef !== undefined) t.reefCmd = clamp(Math.round(o.reef), 0, s.reefs.length);
    if (o.sheet !== undefined) t.sheetCmd = clamp(o.sheet, 0, 1);
    if (o.trav !== undefined) t.travCmd = s.boom ? clamp(o.trav, -1, 1) : 0;
  }
  if (cmd.maneuver !== undefined) { rig.man = cmd.maneuver; rig.manT = 0; }
  return { ok: true };
}

// ---- rv: the compact rig view for other players (§3.7): [heel·10, …per sail: hoist %, reef, angle °, state, tt]
export const RV_LIMITS = { heel: 800, hoist: 100, reef: 3, angle: 100, state: 5, tt: 63 };
/** RigState → int[] (sloop 11 ints, schooner 36); null without a rig. */
export function packRigView(cls, rig) {
  const R = rigOf(cls); if (!R || !rig || !rig.sails) return null;
  const out = [clamp(Math.round(num(rig.heel, 0) * 10), -800, 800)];
  for (const s of R.sails) {
    const t = rig.sails[s.id] || {};
    out.push(clamp(Math.round(num(t.hoist, 0) * 100), 0, 100), clamp(Math.round(num(t.reef, 0)), 0, Math.min(3, s.reefs.length)),
      clamp(Math.round(num(t.angle, 0)), -100, 100), clamp(Math.round(num(t.state, 5)), 0, 5), clamp(Math.round(num(t.tt, 0)), 0, 63));
  }
  return out;
}
/** int[] → RigView, or null when the array is not a valid rv for this class (length, integers, ranges). */
export function unpackRigView(cls, rv) {
  const R = rigOf(cls); if (!R || !Array.isArray(rv) || rv.length !== 1 + 5 * R.sails.length) return null;
  for (const x of rv) if (!Number.isInteger(x)) return null;
  if (Math.abs(rv[0]) > 800) return null;
  const sails = [];
  for (let i = 0; i < R.sails.length; i++) {
    const s = R.sails[i], [h, rf, a, st, tt] = rv.slice(1 + 5 * i, 6 + 5 * i);
    if (h < 0 || h > 100 || rf < 0 || rf > 3 || Math.abs(a) > 100 || st < 0 || st > 5 || tt < 0 || tt > 63) return null;
    sails.push({ id: s.id, hoist: h / 100, reef: Math.min(rf, s.reefs.length), angle: a, state: st, tt });
  }
  return { heel: rv[0] / 10, sails };
}
/** RigState → RigView (own ship rendering, every frame; no network). */
export function rigViewOf(cls, rig) {
  const R = rigOf(cls); if (!R || !rig || !rig.sails) return null;
  return {
    heel: num(rig.heel, 0),
    sails: R.sails.map((s) => { const t = rig.sails[s.id] || {}; return { id: s.id, hoist: num(t.hoist, 0), reef: num(t.reef, 0), angle: num(t.angle, 0), state: num(t.state, 5), tt: num(t.tt, 0) }; }),
  };
}
