// Saltline sailing — tactics for every automatic helm: client autopilot, captains, offline voyages, the Tack/Jibe button
// (docs/SAILING-CONTRACT.md §3.5, §2.7). Pure, deterministic. The caller keeps a tiny memory object `mem`
// ({ tack, since, man, manAt, mode, build, target }: the autopilot instance, or `voyage.sail` on the vessel — saved).
import { haversine, bearing, normDeg, angleDiff } from '../geo.js';
import { GEO } from '../constants.js';
import { rigOf, D2R, KN, clamp, sstep } from './rigs.js';
import { bestVmg, polarSpeed } from './polar.js';
import { anyHoisted } from './state.js';
import { windOverWater } from './sailphys.js';

const MIN_LEG_S = 60;        // (b) cross-track tacks only after a leg this long
const LAYLINE_MIN_S = 15;    // (a) layline tacks: not twice within this
const HYST = 3;              // mode hysteresis (deg)
const BUILD_IN = 0.4, BUILD_OUT = 0.7, BUILD_TWA = 60;

/** Rudder authority at heel (§2.7): cos φ·(1 − 0.7·sstep(30, 50, φ)). */
export function authOf(heelDeg) { const p = Math.abs(Number(heelDeg) || 0); return Math.cos(p * D2R) * (1 - 0.7 * sstep(30, 50, p)); }
/** Helm feed-forward (§2.7): the rudder that cancels the weather helm. Positive H turns the bow to windward
 *  (towards the `tack` side), so the counter-rudder is −tack·H/max(auth, 0.2). */
export function helmFF(tack, helm, auth) { return (-(tack === -1 ? -1 : 1) * (Number(helm) || 0)) / Math.max(Number(auth) || 0, 0.2); }

const sideTack = (twd, hdg) => (angleDiff(hdg, twd) >= 0 ? 1 : -1);   // +1: the wind comes over the starboard side

/**
 * §3.5: q = { hdg, brg, distM, twd, twsKn, stwKn, helm, auth, tack, nowS, xtM } (twd = true wind FROM over the water,
 * xtM = cross-track from the leg, + right of it) → { hdg, maneuver: null | 'tack' | 'jibe', helmFF, mode }.
 */
export function sailCourse(cls, q, mem = {}) {
  const R = rigOf(cls);
  const hdg0 = Number.isFinite(q.hdg) ? q.hdg : 0;
  const tack0 = q.tack === -1 ? -1 : 1;
  const ff = helmFF(tack0, q.helm, q.auth ?? 1);
  if (!R || !Number.isFinite(q.brg)) return { hdg: hdg0, maneuver: null, helmFF: ff, mode: 'none' };
  const now = Number.isFinite(q.nowS) ? q.nowS : 0;
  const twsKn = Math.max(0, Number(q.twsKn) || 0), twd = Number(q.twd) || 0, brg = q.brg;
  if (!Number.isFinite(mem.since)) mem.since = now;
  if (twsKn < 1) { mem.mode = 'reach'; mem.man = null; return { hdg: brg, maneuver: null, helmFF: ff, mode: 'reach' }; }
  const { up, down } = bestVmg(cls, twsKn), upA = up.twa, dnA = down.twa;
  const off = angleDiff(twd, brg);
  const aOff = Math.abs(off);
  const beat = aOff < upA + (mem.mode === 'beat' ? HYST : 0);
  const run = !beat && aOff > dnA - (mem.mode === 'run' ? HYST : 0);
  const mode = beat ? 'beat' : run ? 'run' : 'reach';
  const angle = beat ? upA : dnA;
  if (mode !== mem.mode) {
    if (mode !== 'reach') {   // entering a beat / run: keep the tack she is on when it works, else the one nearer her heading
      const hS = normDeg(twd - angle), hP = normDeg(twd + angle);
      mem.tack = Math.abs(angleDiff(hdg0, hS)) <= Math.abs(angleDiff(hdg0, hP)) ? 1 : -1;
      mem.since = now;
    }
    mem.mode = mode;
  }
  let want, switched = false;
  if (mode === 'reach') {
    want = brg;
    mem.tack = sideTack(twd, want);
  } else {
    if (mem.tack !== 1 && mem.tack !== -1) mem.tack = tack0;
    want = normDeg(twd - mem.tack * angle);
    const lim = Math.max(500, 0.3 * (Number(q.distM) || 0), 3 * R.loa);
    const age = now - mem.since, s = mem.tack * off;
    const layline = mode === 'beat' ? s >= upA - 5 : s > 0 && s <= dnA + 5;
    const carries = angleDiff(brg, want) >= 0 ? 1 : -1;
    const xtOut = Number.isFinite(q.xtM) && carries * q.xtM > lim;
    if ((layline && age >= LAYLINE_MIN_S) || (xtOut && age >= MIN_LEG_S)) {
      mem.tack = -mem.tack; mem.since = now; switched = true;
      want = normDeg(twd - mem.tack * angle);
    }
  }
  // the manoeuvre this heading needs from the tack she is on (through the wind = tack, through the stern = jibe)
  const twaNow = angleDiff(hdg0, twd), twaWant = angleDiff(want, twd);
  const wantTack = twaWant >= 0 ? 1 : -1;
  if (wantTack !== tack0 && (switched || !mem.man)) {
    mem.man = Math.abs(twaNow) + Math.abs(twaWant) < 180 ? 'tack' : 'jibe'; mem.manAt = now;
  }
  if (mem.man && (Math.abs(angleDiff(hdg0, want)) < 5 || now - (mem.manAt ?? now) > 60)) mem.man = null;
  // build speed: too slow for the wanted heading close to the wind → 60° on the wanted tack until she recovers
  const pol = polarSpeed(cls, twsKn, twaWant).kn, stw = Number(q.stwKn) || 0;
  if (mem.build) { if (stw >= BUILD_OUT * pol || Math.abs(twaWant) >= BUILD_TWA) mem.build = false; }
  else if (!mem.man && pol > 0.5 && stw < BUILD_IN * pol && Math.abs(twaWant) < BUILD_TWA) mem.build = true;
  if (mem.build) want = normDeg(twd - wantTack * BUILD_TWA);
  return { hdg: want, maneuver: mem.man || null, helmFF: ff, mode };
}

/** The Tack/Jibe button (Z): mirror the true wind angle → the new heading; the caller steers until within 5°. */
export function beginManeuver(cls, q, mem = {}, kind = null) {
  const hdg = Number(q.hdg) || 0, twd = Number(q.twd) || 0, twa = angleDiff(hdg, twd);
  const target = normDeg(twd + twa);
  mem.man = kind === 'tack' || kind === 'jibe' ? kind : Math.abs(twa) < 90 ? 'tack' : 'jibe';
  mem.manAt = Number.isFinite(q.nowS) ? q.nowS : 0; mem.target = target; mem.tack = twa >= 0 ? -1 : 1; mem.since = mem.manAt;
  void cls;
  return { hdg: target, maneuver: mem.man };
}
/** One step of a running Z manoeuvre → { hdg, done, rudderCmd } (rudder with the helm feed-forward). */
export function maneuverStep(q, mem) {
  const target = Number.isFinite(mem.target) ? mem.target : Number(q.hdg) || 0;
  const d = angleDiff(Number(q.hdg) || 0, target), done = Math.abs(d) < 5;
  if (done) mem.man = null;
  return { hdg: target, done, rudderCmd: clamp(d / 25 + helmFF(q.tack, q.helm, q.auth ?? 1), -1, 1) };
}

/** Signed cross-track distance (m) of point p from the great-circle leg a → b; + = right of the leg. */
export function crossTrackM(lat, lon, aLat, aLon, bLat, bLon) {
  const d13 = haversine(aLat, aLon, lat, lon) / GEO.EARTH_R;
  if (!(d13 > 0)) return 0;
  const t13 = bearing(aLat, aLon, lat, lon) * D2R, t12 = bearing(aLat, aLon, bLat, bLon) * D2R;
  return Math.asin(clamp(Math.sin(d13) * Math.sin(t13 - t12), -1, 1)) * GEO.EARTH_R;
}

/**
 * Offline voyages / captains (server/game.js simulateOffline): the sailing helm for a sail class with a sail set.
 * ctx = { brg, distM, xtM, env (the stepShip env: wind, current, tideStream), nowS, mem } →
 * { rudderCmd, hdg, maneuver, mode } or null when she is not sailing (engine class, no rig, every sail down, sailsUp false).
 */
export function sailHelm(cls, ship, ctx) {
  const R = rigOf(cls), rig = ship && ship.rig;
  if (!R || !rig || !anyHoisted(rig) || (ctx.env && ctx.env.sailsUp === false)) return null;
  const ww = windOverWater(ctx.env || {});
  const q = { hdg: ship.hdg, brg: ctx.brg, distM: ctx.distM, twd: ww.twd, twsKn: ww.tws / KN, stwKn: ship.spd, helm: rig.helm,
    auth: authOf(rig.heel), tack: rig.tack, nowS: ctx.nowS, xtM: ctx.xtM };
  const r = sailCourse(cls, q, ctx.mem || {});
  return { rudderCmd: clamp(angleDiff(ship.hdg, r.hdg) / 25 + r.helmFF, -1, 1), hdg: r.hdg, maneuver: r.maneuver, mode: r.mode };
}

export const HARBOUR_FURL_M = 2500;   // = the PILOT.BANDS 2,500 m band
/** Harbour approach (§3.5): the rig command for an automatic helm at nearM from the nearest anchor, or null. */
export function harbourRigCmd(rig, nearM) {
  if (!rig || !(nearM <= HARBOUR_FURL_M) || !anyHoisted(rig)) return null;
  return { all: 'furl' };
}
/** Departure (§3.5): the plan level for the current true wind (kn) — the crew hoists it once clear of the patch. */
export function departurePlan(cls, twsKn, twaDeg = 90) {
  if (!rigOf(cls)) return null;
  return { plan: polarSpeed(cls, Math.max(0, Number(twsKn) || 0), twaDeg).level };
}
