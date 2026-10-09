// Saltline sailing — trim: the auto-trim / crew controller, the HUD's TrimInfo and the rig view for ships without a
// rig state (docs/SAILING-CONTRACT.md §2.3.4, §3.3, §1.4). Pure, deterministic, cheap.
import { rigOf, planState, SAIL_TYPES, KN, clamp } from './rigs.js';
import { autoTrimSail, trimDelta, twistFor, chordOf, sheetFor, trimFor } from './aero.js';
import { applyPlan, anyHoisted } from './state.js';
import { polarSpeed, noGoDeg } from './polar.js';

export { autoTrimSail, trimDelta, twistFor, chordOf, sheetFor, trimFor };

export const HINT_ALPHA = 0.95;     // the "green tick": α = 0.95·αs at the middle band
const PLAN_DIFFER_S = 30, PLAN_MIN_GAP_S = 90, EMERGENCY_S = 10;

/** Set sheetCmd/travCmd of every hoisted sail for target AoA aFrac·αs from the last step's mid-band heeled AWA (t.be). */
export function trimSheets(cls, rig, aFrac = HINT_ALPHA) {
  const R = rigOf(cls); if (!R || !rig) return rig;
  for (const s of R.sails) {
    const t = rig.sails[s.id]; if (!t || !Number.isFinite(t.be)) continue;
    const { delta } = autoTrimSail(s, t.be, aFrac * SAIL_TYPES[s.type].as);
    const tr = trimFor(s, delta); t.sheetCmd = tr.sheet; t.travCmd = tr.trav;
  }
  return rig;
}

/**
 * Helper level *full* (§3.3), one step: depower controller on heel, plan level from the polar table (30 s differing,
 * ≥ 90 s since the last change; emergency step up after 10 s above phiT + 10°), sheets and travellers at the optimum
 * α = 0.95·αs·(1 − d). `phi` = heel magnitude (deg). Plans are only changed while some sail is set.
 */
export function autoTrimStep(cls, rig, { phi = 0, dt = 0, twsKn = 0, twa = 0, plans = true } = {}) {
  const R = rigOf(cls); if (!R || !rig) return rig;
  rig.d = clamp(rig.d + dt * 0.08 * (phi - R.phiT) / 5, 0, 0.9);
  if (plans && anyHoisted(rig)) {
    const want = polarSpeed(cls, twsKn, twa).level;
    if (want !== rig.lv) {
      rig.lvT += dt;
      if (rig.lvT >= PLAN_DIFFER_S && rig.clk - rig.lvAt >= PLAN_MIN_GAP_S) { applyPlan(cls, rig, want); rig.lvAt = rig.clk; rig.lvT = 0; }
    } else rig.lvT = 0;
    if (!R.cat && phi > R.phiT + 10) {
      rig.hiT += dt;
      if (rig.hiT >= EMERGENCY_S && rig.lv < R.plans.length - 1) { applyPlan(cls, rig, rig.lv + 1); rig.lvAt = rig.clk; rig.hiT = 0; }
    } else rig.hiT = 0;
  }
  return trimSheets(cls, rig, HINT_ALPHA * (1 - rig.d));
}

/** Rig view for ships without a rig state (AIS sail boats, thumbnails, legacy setSails): awa signed (+ = from starboard). */
export function autoTrimView(cls, awaDeg, awsMs) {
  const R = rigOf(cls); if (!R) return null;
  let awa = ((((Number(awaDeg) || 0) % 360) + 540) % 360) - 180; if (awa === -180) awa = 180;
  const tack = awa >= 0 ? 1 : -1, a = Math.abs(awa), side = -tack;
  const awsKn = Math.max(0, Number(awsMs) || 0) / KN;
  const pol = polarSpeed(cls, awsKn, a);
  const ps = planState(R, Math.min(pol.level, R.plans.length - 1));
  const out = { heel: -tack * Math.min(pol.heel, R.phiT), sails: [] };
  const sideOf = {};
  for (const s of R.sails) {
    const p = ps[s.id], up = p.hoist > 0;
    const hoist = up ? (s.furl ? 1 - p.furl : 1) : 0;
    const { delta } = autoTrimSail(s, a, HINT_ALPHA * SAIL_TYPES[s.type].as);
    const sd = s.follows && sideOf[s.follows] ? sideOf[s.follows] : side; sideOf[s.id] = sd;
    out.sails.push({ id: s.id, hoist, reef: p.reef, angle: Math.round(sd * delta * 10) / 10, state: up ? (a < 20 ? 2 : a < 28 ? 1 : 0) : 5, tt: 0 });
  }
  return out;
}

const ADVICE = {
  irons: 'In irons — the crew backs the jib.',
  bylee: 'By the lee — jibe risk!',
  nogo: 'Too close to the wind — bear away.',
  roundup: 'Too much sail — she rounds up. Reef or ease the main.',
  flying: 'Windward hull lifting — ease the sheets!',
  heel: 'Heeling too much — ease the traveller or reef.',
  reef_out: 'Light wind — shake out the reef.',
  good: 'Good trim.',
};
export const ADVICE_TEXT = ADVICE;

/**
 * TrimInfo for the HUD (§1.4, §3.3): pure, cheap; uses the last step's diagnostics in ship.rig.
 * { tws, twa, aws, awa, twsKn, targetKn, pct, vmg, heel, heelT, helm, noGo, load, flags, advice: { key, text } | null, sails: [...] }
 */
export function trimInfo(cls, ship, env) {
  void env;
  const R = rigOf(cls), rig = ship && ship.rig;
  if (!R || !rig || !rig.sails) return null;
  const twsKn = rig.tws / KN, stw = Number(ship.spd) || 0;
  const targetKn = polarSpeed(cls, twsKn, rig.twa).kn;
  const pct = targetKn > 0.1 ? stw / targetKn : 0;
  const noGo = noGoDeg(cls, twsKn);
  const sails = [];
  for (const s of R.sails) {
    const t = rig.sails[s.id]; if (!t) continue;
    const T = SAIL_TYPES[s.type];
    let sheetOpt = t.sheet, sheetLo = 0, sheetHi = 1, travOpt = t.trav;
    if (Number.isFinite(t.be)) {
      const opt = autoTrimSail(s, t.be, HINT_ALPHA * T.as), tw = opt.twist;
      sheetOpt = sheetFor(s, opt.delta, t.trav); travOpt = trimFor(s, opt.delta).trav;
      sheetLo = sheetFor(s, t.be - T.as - tw * 0.5, t.trav); sheetHi = sheetFor(s, t.be - 6 - tw * 0.5, t.trav);
    }
    sails.push({ id: s.id, name: s.name, state: t.state, tt: t.tt, sheet: t.sheet, sheetOpt, sheetLo, sheetHi, trav: t.trav, travOpt,
      reef: t.reef, reefs: s.reefs.length, hoist: t.hoist, canFurl: s.furl, boom: s.boom, work: t.work, job: t.job });
  }
  return {
    tws: rig.tws, twa: rig.twa, aws: rig.aws, awa: rig.awa, twsKn, targetKn, pct, vmg: stw * Math.cos((rig.twa * Math.PI) / 180),
    heel: rig.heel, heelT: R.phiT, helm: rig.helm, noGo, load: rig.load || 0, flags: rig.flags, auto: rig.auto,
    advice: adviceFor(R, rig, { twsKn, noGo }), sails,
  };
}

/** First matching advice (§3.3): irons > by-the-lee > no-go > round-up > hull flying > heel > luff > stall > reef out > good. */
export function adviceFor(R, rig, { twsKn = rig.tws / KN, noGo = 40 } = {}) {
  if (!anyHoisted(rig)) return null;
  const pick = (key, text) => ({ key, text: text || ADVICE[key] });
  if (rig.irons > 3) return pick('irons');
  if (rig.flags & 1) return pick('bylee');
  if (twsKn > 2 && Math.abs(rig.twa) < noGo) return pick('nogo');
  if (rig.flags & 2) return pick('roundup');
  if (rig.flags & 4) return pick('flying');
  if (!R.cat && Math.abs(rig.heel) > R.phiT + 5) return pick('heel');
  for (const s of R.sails) { const t = rig.sails[s.id]; if (t && t.hoist > 0.05 && (t.state === 1 || t.state === 2)) return pick(`luff:${s.id}`, `Pull in the ${s.name} — it is shaking.`); }
  for (const s of R.sails) { const t = rig.sails[s.id]; if (t && t.hoist > 0.05 && t.state === 3) return pick(`stall:${s.id}`, `Ease the ${s.name} — it is stalled.`); }
  if (twsKn < 12) {
    for (const s of R.sails) { const t = rig.sails[s.id]; if (t && !s.light && t.hoist > 0.05 && (t.reef > 0 || (s.furl && t.hoist < 0.95))) return pick('reef_out'); }
  }
  return pick('good');
}
