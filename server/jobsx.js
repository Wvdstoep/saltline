// The single step runner for JOB_GEN 8 families (docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §5.4): it advances the first
// open step of every accepted runner job from three server hooks — onTick(actor, dtShipS), onDock(actor, harbourId),
// onAction(actor, 'job_step', jobId) — and pays on the last step. An actor is a player or a fleet vessel
// ({ id, ship: { cls, lat, lon, spd (kn) }, docked, cargo, jobs, shipTime, sail?: { stats } }). Legacy jobs (gen < 8 or a
// legacy family) are never touched: they finish on their old code path in server/game.js.
//   env = { now() → unix s, harborById(id), event(actor, kind, text), pay(actor, cr, job, text), charge?(actor, cr, why) → bool,
//           ctx?(actor) → canDo ctx, rep?(actor, delta), windKn?(actor), heelDeg?(actor), seaHs?(actor), offHire?(actor) → bool,
//           claim?(casualtyId, actor) → bool, damage?(actor, condLoss) }
import { haversine } from '../shared/geo.js';
import { JOB_GEN, isRunnerJob, payOf, migrateActor } from '../shared/jobs/types.js';
import { FAMILIES, PAY, payFor, payLesson, payEcotour, regattaPrize, CAPTAIN_TYPES } from '../shared/jobs/catalogue.js';
import { canDo } from '../shared/jobs/eligibility.js';
import { makeStack, freeUnits, CARGO, UNITS } from '../shared/cargo.js';
import { rowOf, basePriceOf } from '../shared/jobs/shipview.js';
import { CRUISE_RULES } from '../shared/jobs/cruises.js';
import { onboardIndex } from '../shared/ships/cruiseprofile.js';
import { generateBoard, ensureFit, generateFamilyJob, generateSalvage, weightsFor, BOARD_SIZE } from './jobsgen.js';

export const RUNNER = {
  BAND_GRACE_S: 120,          // survey line: this long outside the 4–6 kn band restarts the line
  TOW_OVER_KN: 0.5, TOW_PART_S: 60,   // towing faster than maxKn + 0.5 kn for 60 s parts the line
  DEPART_WINDOW_S: PAY.ROPAX_WINDOW_S,
  LESSON_HEEL_DEG: 30, LESSON_WIND_GRACE_H: 0.25,
  COMFORT_HEEL_DEG: 20, COMFORT_HS_M: 1.5,
  ABANDON_FRAC: 0.1,
};

/** Seeded [0,1) from a string (per-job outcomes: sightings, bareboat claims). */
export function seeded(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  let a = h >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const clsOf = (a) => a?.ship?.cls;
const unitLbl = (u) => (u === 't' ? 't' : UNITS[u]?.plural || u);
const shortName = (s) => String(s || '').split(' (')[0];
const cap1 = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);
const DRILL_BTN = { transfer: 'Transfer', ladder: 'Pilot aboard', heaveto: 'Hove-to', mob: 'MOB drill done', mooring: 'Buoy picked up', anchor: 'Anchored',
  lock_pass: 'Lock passed', bridge_req: 'Bridge requested', box_moor: 'Moored in the box' };
const spdOf = (a) => Math.abs(a?.ship?.spd || 0);
/** Sail counters (request S1 to SAILING: v.sail.stats = { tacks, gybes, reefs, maxHeel10s }); zeros until it lands. */
export function sailStats(a) { return a?.sail?.stats || a?.ship?.sail?.stats || a?.ship?.rig?.stats || a?.rig?.stats || {}; }
/** Time-correction factor for regattas: the boat's top speed over 8 kn (Game rule until SAILING exposes polar targets). */
export function tcfOf(cls) { const C = rowOf(cls); return C ? Math.round(((C.maxKn || 8) / 8) * 1000) / 1000 : 1; }

export class JobsX {
  constructor(env = {}) { this.env = env; }
  now() { return this.env.now ? this.env.now() : Date.now() / 1000; }
  event(a, kind, text) { this.env.event?.(a, kind, text); }
  H(id) { return this.env.harborById ? this.env.harborById(id) : null; }

  // ---------------------------------------------------------------------------------------------- generation (H6b)
  /** Board for a harbour (H6b: economy regen dispatches here). */
  generate(h, simTime, rnd, env = {}, opts = {}) { return generateBoard(h, simTime, rnd, env, opts); }
  generateFamily(h, simTime, rnd, type, env = {}, opts = {}) { return generateFamilyJob(h, simTime, rnd, type, env, opts); }
  ensureFit(board, h, vessel, simTime, rnd, env = {}, opts = {}) { return ensureFit(board, h, vessel, this.ctxFor(vessel), simTime, rnd, env, opts); }
  salvage(refuge, casualty, simTime, rnd) { return generateSalvage(refuge, casualty, simTime, rnd); }
  ctxFor(a) { return { harborById: (id) => this.H(id), simTime: this.now(), ...(this.env.ctx ? this.env.ctx(a) : {}) }; }

  // ---------------------------------------------------------------------------------------------- accept / abandon
  /** Accept board job `job` for actor `a`. → { ok, why?, job? }. Legacy jobs → { ok: false, legacy: true } (old path). */
  accept(a, job, { skipCheck = false } = {}) {
    if (!isRunnerJob(job)) return { ok: false, legacy: true };
    const cls = clsOf(a);
    if (!skipCheck) {
      const c = canDo(job, a, this.ctxFor(a));
      if (!c.ok && c.why?.code !== 'time') return { ok: false, why: c.why?.text || 'Not possible with this ship.' };
    }
    if (job.type === 'bareboat' && a.docked !== job.from) return { ok: false, why: 'She must be alongside here to be chartered out.' };
    if (job.pay?.entry) {
      const ok = this.env.charge ? this.env.charge(a, job.pay.entry, `Entry fee: ${job.title}`) : true;
      if (!ok) return { ok: false, why: `The entry fee is ${fmt(job.pay.entry)} cr.` };
    }
    const mine = JSON.parse(JSON.stringify(job));
    if (!Number.isFinite(a.shipTime)) a.shipTime = this.now();
    mine.pay = payFor(mine, cls);
    mine.acceptedAt = this.now(); mine.acceptedShip = a.shipTime; mine.dueShip = a.shipTime + mine.hours * 3600;
    mine.prog = { i: 0, h: 0, n: 0, base: {}, sea: false, bad: 0, over: 0, late: 0, fracs: [], skipped: [], done: [], nm: 0, mark: 0,
      cT: 0, cBad: 0, windH: 0, safety: false, warned: {}, departed: {}, cond0: Number.isFinite(a.cond) ? a.cond : 100 };
    mine.prog.base0 = { ...sailStats(a) };
    if (!Array.isArray(a.jobs)) a.jobs = [];
    a.jobs.push(mine);
    this.advance(a, mine, { kind: 'accept' });
    return { ok: true, job: mine };
  }
  /** The legacy cancellation fee (10 % of the pay) for any job record. */
  abandonPenalty(job) { return Math.round(payOf(job) * RUNNER.ABANDON_FRAC); }
  abandon(a, jobId) {
    const j = (a.jobs || []).find((x) => x.id === jobId); if (!j) return null;
    a.jobs = a.jobs.filter((x) => x !== j);
    a.cargo = (a.cargo || []).filter((c) => c.jobId !== j.id);
    return j;
  }

  // ---------------------------------------------------------------------------------------------- hooks (H6)
  onTick(a, dtS) { for (const j of [...(a.jobs || [])]) if (isRunnerJob(j) && j.prog) this.advance(a, j, { kind: 'tick', dt: Math.max(0, dtS || 0) }); }
  onDock(a, harborId) { for (const j of [...(a.jobs || [])]) if (isRunnerJob(j) && j.prog) this.advance(a, j, { kind: 'dock', harbor: harborId }); }
  /** `job_step` (drill confirmation: CTV transfer, MOB, ladder …). → true when it counted. */
  onAction(a, kind, jobId) {
    if (kind !== 'job_step') return false;
    const j = (a.jobs || []).find((x) => x.id === jobId && isRunnerJob(x) && x.prog); if (!j) return false;
    return this.advance(a, j, { kind: 'action' }).counted;
  }
  /** Grounding / collision: a lesson in progress fails its safety rule (refund, reputation −5). */
  onIncident(a, kind) { for (const j of a.jobs || []) if (isRunnerJob(j) && j.type === 'lesson' && j.prog && !j.prog.safety) { j.prog.safety = kind; this.event(a, 'warn', `Safety failure (${kind}): the lesson will be refunded.`); } }

  // ---------------------------------------------------------------------------------------------- the step machine
  within(a, at, rM) {
    if (!at) return true;
    const s = a.ship || {};
    if (typeof at === 'string') { const h = this.H(at); return !!h && haversine(s.lat, s.lon, h.lat, h.lon) <= (rM ?? 4000); }
    return haversine(s.lat, s.lon, at.lat, at.lon) <= (rM ?? at.rM ?? 500);
  }
  lotUnits(job, s) {
    const c = job.cargo; if (!c) return 0;
    if (Array.isArray(c.lots) && s.lot != null) return c.lots.find((l) => l.lot === s.lot)?.teu ?? c.qty;
    return c.qty;
  }
  /** Is the cargo of step `s` (its lot, or any lot when the step has none) aboard? */
  aboard(a, job, s) {
    const lot = s?.lot ?? null;
    return (a.cargo || []).some((x) => x.jobId === job.id && (lot == null || (x.lot ?? null) === lot));
  }
  /** Room to load the lot of step `s`: { ok, free, unit }. */
  room(a, job, s) {
    const c = job.cargo; if (!c) return { ok: true, free: Infinity, unit: 't' };
    const units = this.lotUnits(job, s), t = makeStack(c.good, units, c.unit, job.id).qty;
    if (freeUnits(a, c.unit) + 1e-9 < units) return { ok: false, free: freeUnits(a, c.unit), unit: c.unit };
    if (c.unit !== 'm3' && freeUnits(a, 't') + 1e-9 < t) return { ok: false, free: freeUnits(a, 't'), unit: 't' };
    return { ok: true, free: freeUnits(a, c.unit), unit: c.unit };
  }
  loadCargo(a, job, s) {
    const c = job.cargo; if (!c) return true;
    const units = this.lotUnits(job, s), lot = s.lot ?? null;
    if ((a.cargo || []).some((x) => x.jobId === job.id && (x.lot ?? null) === lot)) return true;
    const stack = makeStack(c.good, units, c.unit, job.id, { lot, plugs: c.reefer ? Math.round((c.reefer * units) / c.qty) : 0 });
    const r = this.room(a, job, s);
    if (!r.ok) {
      if (!job.prog.warned[`load${job.prog.i}`]) { job.prog.warned[`load${job.prog.i}`] = true; this.event(a, 'warn', `${job.title}: not enough space to load ${this.cargoText(job, s)} (${fmt(Math.max(0, r.free))} ${unitLbl(r.unit)} free).`); }
      return false;
    }
    if (!Array.isArray(a.cargo)) a.cargo = [];
    a.cargo.push(stack);
    return true;
  }
  unloadCargo(a, job, s, expectUnits) {
    const lot = s?.lot ?? null;
    const stacks = (a.cargo || []).filter((x) => x.jobId === job.id && (lot == null || (x.lot ?? null) === lot));
    if (!stacks.length) return null;
    const have = stacks.reduce((t, x) => t + (x.units ?? x.qty), 0);
    a.cargo = a.cargo.filter((x) => !stacks.includes(x));
    return expectUnits > 0 ? Math.min(1, have / expectUnits) : 1;
  }
  /** Is the step at index k doable right now (used to skip optional drills when the boat is back)? */
  readyNow(a, job, k) {
    const s = job.steps[k]; if (!s) return false;
    if (s.k === 'land' || s.k === 'board') return a.docked === s.at && (!s.afterSea || job.prog.sea);
    return false;
  }

  /** Advance job `j` of actor `a` on event `ev` ({ kind: 'tick'|'dock'|'action'|'accept', dt?, harbor? }). */
  advance(a, j, ev) {
    const p = j.prog, now = this.now(), cls = clsOf(a), spd = spdOf(a);
    const res = { counted: false, finished: false };
    if (ev.kind !== 'accept') this.heal(a, j);
    const i0 = p.i;
    if (ev.kind === 'tick' && !a.docked && p.i > 0) p.sea = true;
    // lesson rules: students ask to go back above the level's wind limit; heel > 30° for 10 s is a safety failure
    if (ev.kind === 'tick' && j.type === 'lesson' && !a.docked) {
      const w = this.env.windKn ? this.env.windKn(a) : NaN;
      if (Number.isFinite(w) && w > (j.needs?.maxWindKn ?? Infinity)) {
        if (!p.windWarned) { p.windWarned = true; this.event(a, 'warn', `Wind ${Math.round(w)} kn: the students ask to go back (limit ${j.needs.maxWindKn} kn; −50 % pay if you carry on).`); }
        p.windH += ev.dt / 3600;
      }
      if ((sailStats(a).maxHeel10s || 0) > RUNNER.LESSON_HEEL_DEG && !p.safety) { p.safety = 'heel'; this.event(a, 'warn', 'Heeled over 30° for 10 s: the lesson will be refunded.'); }
    }
    for (let guard = 0; guard < j.steps.length + 2 && p.i < j.steps.length; guard++) {
      const i = p.i, s = j.steps[i];
      // optional drills are skipped once the next required step can be done (the boat is back alongside)
      if (s.optional) {
        let k = i; while (j.steps[k]?.optional) k++;
        if (this.readyNow(a, j, k)) { for (let q = i; q < k; q++) p.skipped.push(j.steps[q].task || q); p.i = k; continue; }
      }
      let done = false;
      switch (s.k) {
        case 'load': done = a.docked === s.at && this.loadCargo(a, j, s); break;
        case 'board': done = a.docked === s.at && (!j.cargo || j.steps.some((x) => x.k === 'load') || this.loadCargo(a, j, s)); break;
        case 'discharge': {
          if (typeof s.at === 'string' ? a.docked !== s.at : !(this.within(a, s.at) && spd <= (s.maxKn ?? Infinity))) break;
          const f = this.unloadCargo(a, j, s, this.lotUnits(j, s));
          if (f == null) { if (!p.warned[`dis${i}`]) { p.warned[`dis${i}`] = true; this.event(a, 'warn', `${j.title}: the contract cargo is no longer aboard.`); } break; }
          p.fracs.push(f); done = true; break;
        }
        case 'land': {
          done = a.docked === s.at && (!s.afterSea || p.sea);
          if (done && j.cargo && !j.steps.some((x) => x.k === 'discharge')) { const f = this.unloadCargo(a, j, null, j.cargo.qty); if (f != null) p.fracs.push(f); }
          break;
        }
        case 'sail': {
          // ro-pax departures: the moment she leaves after boarding counts against the timetable
          const prev = j.steps[i - 1];
          if (prev?.depart && !p.departed[i] && !a.docked) { p.departed[i] = now; if (now > prev.depart + RUNNER.DEPART_WINDOW_S) p.late++; }
          if (s.comfort && ev.kind === 'tick' && !a.docked) {   // cruise guests: rough seas on the way spoil the holiday
            p.cT += ev.dt;
            if ((this.env.seaHs ? this.env.seaHs(a) : 0) > RUNNER.COMFORT_HS_M) p.cBad += ev.dt;
          }
          if (s.nm && !s.at) { if (ev.kind === 'tick' && !a.docked) p.nm += (spd * ev.dt) / 3600; done = p.nm >= s.nm; if (done) p.done.push(s.task || i); break; }
          if (typeof s.at === 'string') { done = a.docked === s.at; break; }
          if ((s.minKn || s.maxKn) && ev.kind === 'tick' && !a.docked) {
            if (spd < (s.minKn ?? 0) || spd > (s.maxKn ?? Infinity)) p.bad += ev.dt;
            if (p.bad > RUNNER.BAND_GRACE_S && s.resetTo != null) { p.bad = 0; p.i = s.resetTo; this.event(a, 'warn', `${s.label}: speed outside ${s.minKn}–${s.maxKn} kn — run the line again.`); continue; }
          }
          done = this.within(a, s.at);
          break;
        }
        case 'meet': {
          done = this.within(a, s.at) && spd <= (s.maxKn ?? Infinity);
          if (done && s.claim && this.env.claim && !this.env.claim(s.claim, a)) {
            a.jobs = a.jobs.filter((x) => x !== j);
            this.event(a, 'warn', `${j.title}: another salvor connected first.`);
            return res;
          }
          if (done && s.unload) this.unloadCargo(a, j, null, 0);
          break;
        }
        case 'tow': {
          if (ev.kind === 'tick' && !a.docked && spd > (s.maxKn ?? Infinity) + RUNNER.TOW_OVER_KN) p.over += ev.dt;
          if (p.over > RUNNER.TOW_PART_S) {
            p.over = 0; let k = i - 1; while (k > 0 && j.steps[k].k !== 'meet') k--;
            p.i = Math.max(0, k); this.event(a, 'warn', `The tow line parted (over ${s.maxKn} kn). Reconnect.`); continue;
          }
          done = this.within(a, s.at);
          break;
        }
        case 'work': {
          if (ev.kind === 'tick') {
            const offHire = s.hire && this.env.offHire && this.env.offHire(a);
            const ok = s.chartered || ((!s.at || this.within(a, s.at)) && spd <= (s.maxKn ?? Infinity) && (!s.atSea || !a.docked) && !offHire);
            if (ok) p.h += ev.dt / 3600;
            if (s.comfort && !a.docked) {
              p.cT += ev.dt;
              const heel = this.env.heelDeg ? Math.abs(this.env.heelDeg(a)) : 0, hs = this.env.seaHs ? this.env.seaHs(a) : 0;
              if ((rowOf(cls)?.sail && heel > RUNNER.COMFORT_HEEL_DEG) || (!rowOf(cls)?.sail && hs > RUNNER.COMFORT_HS_M)) p.cBad += ev.dt;
            }
          }
          done = p.h >= (s.h || 0) - 1e-9;
          if (done) { p.h = 0; if (s.unload) this.unloadCargo(a, j, null, 0); }
          break;
        }
        case 'race': {
          if (now < s.startAt) break;
          const marks = s.marks || [];
          while (p.mark < marks.length && this.within(a, marks[p.mark], marks[p.mark].rM)) p.mark++;
          done = p.mark >= marks.length;
          if (done) p.elapsed = now - s.startAt;
          break;
        }
        case 'drill': {
          if (s.stat) {
            const v = sailStats(a)[s.stat] || 0;
            if (p.base[i] == null) p.base[i] = p.base0?.[s.stat] ?? v;   // counted since the lesson began
            done = v - p.base[i] >= (s.count || 1);
          } else {
            if (ev.kind === 'action' && (!s.at || this.within(a, s.at)) && spd <= (s.maxKn ?? Infinity)) { p.n++; res.counted = true; }
            done = p.n >= (s.count || 1);
          }
          if (done) { p.n = 0; p.done.push(s.task || i); }
          break;
        }
        default: break;
      }
      if (!done) break;
      if (s.until && now > s.until) p.late++;
      p.i++;
    }
    const lifted = this.payLiftings(a, j);
    if (p.i >= j.steps.length) { this.settle(a, j); res.finished = true; return res; }
    if (ev.kind !== 'accept' && (p.i > i0 || lifted)) this.progressEvent(a, j, i0, lifted);
    return res;
  }

  // ---------------------------------------------------------------------------------------------- player-facing status
  hname(id) { return shortName(this.env.harborName?.(id) || this.H(id)?.name || id); }
  /** '11,592 t of chemicals' for the lot of step `s` (or the whole contract). */
  cargoText(job, s) {
    const c = job.cargo; if (!c) return job.pax ? `${fmt(job.pax)} passengers` : 'the cargo';
    const units = s ? this.lotUnits(job, s) : c.qty;
    return `${fmt(units)} ${unitLbl(c.unit)} of ${(CARGO[c.good]?.name || c.good).toLowerCase()}`;
  }
  /** Index of the load step that fills the lot of step `i` (the last load before it with the same lot), or -1. */
  loadIndexFor(j, i) {
    const lot = j.steps[i]?.lot ?? null;
    for (let k = i - 1; k >= 0; k--) { const s = j.steps[k]; if (s.k === 'load' && (lot == null || (s.lot ?? null) === lot)) return k; }
    return -1;
  }
  /** 'Lifting 2 of 4' for a COA step with a lot, else null. */
  liftingOf(j, s) {
    if (j.type !== 'coa' || s?.lot == null) return null;
    return { n: s.lot + 1, of: j.liftings || j.steps.filter((x) => x.k === 'discharge').length };
  }
  /**
   * What the current step of runner job `j` wants, for the HUD card and the harbour sheet: { i, n, k, label, at, atName,
   * spot, maxKn, text (one line: what to do, where), act ('dock' | 'job_step' | null), btn (button label), can (a press
   * would advance it now), lift ({ n, of } on a COA) }. null for legacy jobs.
   */
  stepInfo(a, j) {
    if (!isRunnerJob(j) || !j.prog) return null;
    const p = j.prog, s = j.steps[p.i]; if (!s) return null;
    const at = typeof s.at === 'string' ? s.at : null, spot = s.at && typeof s.at === 'object' ? { lat: s.at.lat, lon: s.at.lon, rM: s.at.rM ?? 500 } : null;
    const hn = at ? this.hname(at) : null, hereH = !!at && a.docked === at, spd = spdOf(a);
    const lift = this.liftingOf(j, s), pre = lift ? `Lifting ${lift.n} of ${lift.of}: ` : '';
    const what = this.cargoText(j, s), mk = s.maxKn != null ? ` under ${s.maxKn} kn` : '';
    const onSpot = () => this.within(a, s.at) && spd <= (s.maxKn ?? Infinity);
    let text = '', act = null, btn = null, can = false;
    switch (s.k) {
      case 'load': {
        if (!hereH) { text = `${pre}sail to ${hn} and moor to load ${what}`; break; }
        const r = this.room(a, j, s);
        if (r.ok) { text = `${pre}load ${what} at ${hn}`; act = 'dock'; btn = 'Load'; can = true; }
        else text = `${pre}not enough space to load ${what} at ${hn} (${fmt(Math.max(0, r.free))} ${unitLbl(r.unit)} free) — make room first`;
        break;
      }
      case 'discharge': {
        if (!this.aboard(a, j, s)) { const k = this.loadIndexFor(j, p.i); text = `${pre}cargo not aboard — load ${what} at ${k >= 0 ? this.hname(j.steps[k].at) : 'the load port'} first`; break; }
        const ok = at ? hereH : onSpot();
        if (ok) { text = `${pre}discharge ${what} at ${hn || 'the site'}`; act = 'dock'; btn = 'Discharge'; can = true; }
        else if (at) text = `${lift ? `this lifting (${lift.n} of ${lift.of})` : 'the cargo'} discharges at ${hn} — sail there and moor`;
        else text = `${pre}${s.label}${mk}`;
        break;
      }
      case 'board':
        if (hereH) { text = `${s.label} at ${hn}`; act = 'dock'; btn = 'Embark'; can = true; }
        else text = `sail to ${hn} and moor — ${s.label.toLowerCase()}`;
        break;
      case 'land':
        if (hereH && s.afterSea && !p.sea) text = `${s.label}: take them out to sea first`;
        else if (hereH) { text = `${s.label} at ${hn}`; act = 'dock'; btn = 'Land'; can = true; }
        else text = `sail to ${hn} and moor — ${s.label.toLowerCase()}`;
        break;
      case 'sail': {
        const prev = j.steps[p.i - 1], ballast = prev?.k === 'discharge' && lift == null && this.liftingOf(j, j.steps[p.i + 1]);
        if (s.nm && !s.at) { text = `${s.label}: ${fmt(p.nm)} of ${fmt(s.nm)} nm sailed`; break; }
        if (at) {
          const nl = this.liftingOf(j, j.steps[p.i + 1]);
          if (hereH) { text = `arrived at ${hn}`; act = 'dock'; btn = 'Arrive'; can = true; }
          else if (ballast && nl && j.steps[p.i + 1].k === 'load') text = `sail back to ${hn} to load lifting ${nl.n} of ${nl.of}`;
          else if (j.steps[p.i + 1]?.k === 'discharge' && j.steps[p.i + 1].at === at) text = `${nl ? `Lifting ${nl.n} of ${nl.of}: ` : ''}sail to ${hn} and moor to discharge ${this.cargoText(j, j.steps[p.i + 1])}`;
          else text = `${s.label && s.label !== 'sail' && !/^(Sail to|Back to|To) /.test(s.label) ? `${s.label} — ` : ''}sail to ${hn} and moor there`;
          break;
        }
        text = `${s.label}${s.minKn != null ? ` (${s.minKn}–${s.maxKn} kn)` : ''}${spot ? ` — within ${fmt(spot.rM)} m` : ''}`;
        break;
      }
      case 'work': text = `${s.label} — ${(Math.floor(p.h * 10) / 10).toLocaleString('en-US')} of ${s.h} h${spot ? ` (within ${fmt(spot.rM)} m${mk})` : ''}`; break;
      case 'meet': case 'tow': text = `${s.label} — within ${fmt(spot?.rM ?? 500)} m${mk}`; break;
      case 'drill': {
        if (s.stat) { const v = sailStats(a)[s.stat] || 0, b = p.base[p.i] ?? p.base0?.[s.stat] ?? v; text = `${s.label} — ${Math.max(0, Math.min(s.count || 1, v - b))} of ${s.count || 1}`; break; }
        act = 'job_step'; btn = DRILL_BTN[s.action] || 'Confirm'; can = onSpot();
        text = `${s.label} — ${p.n} of ${s.count || 1}: ${spot ? `within ${fmt(spot.rM)} m${mk}` : mk ? mk.trim() : 'when ready'}, then confirm`;
        break;
      }
      case 'race': text = this.now() < s.startAt ? `${s.label}: wait in the start area` : `${s.label}: round mark ${Math.min(p.mark + 1, (s.marks || []).length)} of ${(s.marks || []).length}`; break;
      default: text = s.label || s.k;
    }
    if (s.optional) text += ' (optional)';
    return { i: p.i, n: j.steps.length, k: s.k, label: s.label, at, atName: hn, spot, maxKn: s.maxKn ?? null, text: cap1(text), act, btn, can, lift };
  }
  /** Why a runner job cannot advance here right now (Deliver pressed, captains), in the player's words. */
  why(a, j) { const si = this.stepInfo(a, j); return si ? `${si.text}${/[.!?]$/.test(si.text) ? '' : '.'}` : 'not deliverable here.'; }
  /** The Deliver / step button: try the current step now. → { ok, why? }. */
  tryStep(a, j) {
    if (!isRunnerJob(j) || !j.prog) return { ok: false, why: 'not a step contract.' };
    const i0 = j.prog.i, s = j.steps[i0];
    const r = this.advance(a, j, s?.k === 'drill' && !s.stat ? { kind: 'action' } : { kind: 'dock', harbor: a.docked });
    const ok = r.finished || r.counted || j.prog.i !== i0;
    return ok ? { ok: true } : { ok: false, why: this.why(a, j) };
  }
  /** One log line when steps finished outside the accept: what was done, what is next. */
  progressEvent(a, j, i0, lifted) {
    const p = j.prog, last = j.steps[p.i - 1], si = this.stepInfo(a, j);
    const next = si ? ` Next: ${si.text}.` : '';
    if (lifted) { this.event(a, 'info', `${j.title}: ${lifted}${next}`); return; }
    if (!last || p.i <= i0) return;
    const hn = typeof last.at === 'string' ? this.hname(last.at) : null;
    const done = last.k === 'load' ? `loaded ${this.cargoText(j, last)}${hn ? ` at ${hn}` : ''}`
      : last.k === 'discharge' ? `discharged ${this.cargoText(j, last)}${hn ? ` at ${hn}` : ''}`
      : last.k === 'sail' && hn ? `arrived at ${hn}` : `${last.label} — done`;
    this.event(a, 'info', `${j.title}: ${cap1(done)}.${next}`);
  }
  /** A COA pays each lifting when it is discharged (the last one, any bonus and penalties settle at the end). → text or null. */
  payLiftings(a, j) {
    if (j.type !== 'coa') return null;
    const p = j.prog, n = j.liftings || j.steps.filter((x) => x.k === 'discharge').length; if (n < 2) return null;
    const base = Math.max(0, (j.pay?.cr || 0) - (j.pay?.bonus?.cr || 0));
    p.paidN = p.paidN || 0; p.paid = p.paid || 0;
    const parts = [];
    while (p.paidN < Math.min(p.fracs.length, n - 1)) {
      const f = p.fracs[p.paidN], late = Number.isFinite(j.dueShip) && Number.isFinite(a.shipTime) && a.shipTime > j.dueShip;
      const cr = Math.round((base / n) * f * (late ? 0.5 : 1));
      p.paidN++; p.paid += cr;
      const text = `Lifting ${p.paidN} of ${n} discharged — +${fmt(cr)} cr${f < 1 ? ` (short ${Math.round(f * 100)} %)` : ''}${late ? ' (late, half pay)' : ''}.`;
      if (this.env.pay) this.env.pay(a, cr, j, text, { partial: true }); else if (Number.isFinite(a.money)) a.money += cr;
      parts.push(text);
    }
    return parts.length ? parts.join(' ') : null;
  }
  /**
   * Save healing for accepted runner jobs: a laden step (sailing to / discharging a lot) whose cargo is not aboard goes
   * back to that lot's load step, so a contract whose cargo was never loaded (or lost) can still be completed.
   */
  heal(a, j) {
    const p = j.prog; if (!j.cargo || !p || p.i >= j.steps.length) return;
    const s = j.steps[p.i]; if (!s || s.k === 'load' || s.k === 'board') return;
    const k = this.loadIndexFor(j, p.i); if (k < 0) return;
    const lot = j.steps[k].lot ?? null, sameLot = (x) => lot == null || (x.lot ?? null) === lot;
    for (let q = k + 1; q < p.i; q++) { const x = j.steps[q]; if ((x.k === 'discharge' && sameLot(x)) || x.unload || x.k === 'load') return; }   // already discharged: ballast leg
    let laden = false;
    for (let q = p.i; q < j.steps.length; q++) { const x = j.steps[q]; if (x.k === 'load') break; if ((x.k === 'discharge' && sameLot(x)) || x.unload) { laden = true; break; } }
    if (!laden || this.aboard(a, j, j.steps[k])) return;
    p.i = k;
    this.event(a, 'warn', `${j.title}: the cargo is not aboard — ${this.stepInfo(a, j)?.text.replace(/^./, (c) => c.toLowerCase()) || 'load it first'}.`);
  }

  /** Credits for a finished runner job (exported for tests and the job board's estimates). */
  settleAmount(a, j) {
    const p = j.prog, cls = clsOf(a), pay = j.pay || {};
    let cr = pay.cr || 0;
    const notes = [];
    switch (j.type) {
      case 'liner': case 'ropax_route': if (p.late === 0 && pay.bonus) { cr += pay.bonus.cr; notes.push('on-time bonus'); } break;
      case 'coa': if (p.late > 0 && pay.bonus) { cr -= pay.bonus.cr; notes.push('COA bonus lost (laycan missed)'); } break;
      case 'lesson': {
        const allTasks = p.skipped.length === 0;
        cr = payLesson({ level: j.level, students: j.pax, allTasks });
        if (allTasks) notes.push('all tasks');
        if (p.windH > RUNNER.LESSON_WIND_GRACE_H) { cr = Math.round(cr * 0.5); notes.push('carried on above the wind limit'); }
        if (p.safety) { cr = 0; notes.push(`refunded: safety failure (${p.safety})`); this.env.rep?.(a, -5); }
        break;
      }
      case 'cruise': {
        // net charter fee: the ticket as sold, the onboard spending of the venues THIS ship really has, then the penalties
        const R = CRUISE_RULES, ticket = pay.ticket ?? null;
        if (ticket != null) {
          const hrs = j.cruiseH || j.hours || 0, gs = this.env.guest?.(a);   // the guest rating (shared/ships/cruisesat.js) scales ticket and onboard spending
          const onboard = Math.round((j.pax || 0) * hrs * onboardIndex(cls) * (gs ? gs.spendMul : 1)), tk = Math.round(ticket * (gs ? gs.payMul : 1));
          cr = tk + onboard; if (onboard > 0) notes.push(`onboard spending ${fmt(onboard)} cr`);
          if (gs) notes.push(`guests rated the ship ${gs.stars.toFixed(1)} / 5 (fare ×${gs.payMul})`);
        }
        const lateK = Math.min(R.LATE_MAX, R.LATE_PER_CALL * p.late);
        if (p.late > 0) { cr -= Math.round(cr * lateK); notes.push(`${p.late} late call${p.late > 1 ? 's' : ''} −${Math.round(lateK * 100)} %`); }
        const rough = p.cT > 0 ? p.cBad / p.cT : 0;
        if (rough > 0.05) { const f = Math.min(R.ROUGH_MAX, rough * R.ROUGH_MAX); cr -= Math.round(cr * f); notes.push(`rough seas: refunds −${Math.round(f * 100)} %`); }
        const loss = Math.max(0, (p.cond0 ?? 100) - (Number.isFinite(a.cond) ? a.cond : 100)), over = Math.max(0, loss - R.DAMAGE_FREE_PCT);
        if (over > 0) { const f = Math.min(R.DAMAGE_MAX, over * R.DAMAGE_PER_PCT); cr -= Math.round(cr * f); notes.push(`hull damage −${Math.round(f * 100)} %`); this.env.rep?.(a, -Math.min(5, Math.ceil(over / 4))); }
        if (Number.isFinite(j.dueShip) && Number.isFinite(a.shipTime) && a.shipTime > j.dueShip) { cr -= Math.round(cr * R.OVERRUN); notes.push('the cruise overran its hours'); }
        else if (p.late === 0 && over <= 0 && pay.bonus) { cr += Math.round(cr * R.PERFECT_BONUS); notes.push('perfect cruise bonus'); }
        break;
      }
      case 'daycharter': case 'guests': {
        const comfort = p.cT > 0 ? Math.max(0, 1 - p.cBad / p.cT) : 1;
        const tipMax = j.type === 'daycharter' ? PAY.DAYCHARTER_TIP_MAX : PAY.GUESTS_TIP_MAX;
        const tip = Math.round(cr * tipMax * comfort);
        if (tip > 0) notes.push(`tips ${fmt(tip)} cr`);
        cr += tip; break;
      }
      case 'ecotour': { const sighting = seeded(`eco:${j.id}`)() < (pay.p ?? 0); cr = payEcotour({ guests: j.pax, sighting }); if (sighting) notes.push('sighting bonus'); break; }
      case 'regatta': {
        const corrected = (p.elapsed ?? Infinity) * tcfOf(cls);
        const place = 1 + (j.field || []).filter((t) => t < corrected).length;
        cr = regattaPrize(j.entries, place); p.place = place; notes.push(`place ${place} of ${j.entries}`); break;
      }
      case 'bareboat': {
        const days = (pay.hireH || 0) / 24;
        this.env.damage?.(a, PAY.BAREBOAT_COND_DAY * days);
        if (seeded(`bb:${j.id}`)() < PAY.BAREBOAT_CLAIM_P) { const d = Math.round(basePriceOf(cls) * PAY.BAREBOAT_DEDUCT); cr -= d; notes.push(`damage claim −${fmt(d)} cr`); }
        break;
      }
      default: break;
    }
    const frac = p.fracs.length ? p.fracs.reduce((s, f) => s + f, 0) / p.fracs.length : 1;
    if (frac < 1) { cr = Math.round(cr * frac); notes.push(`short delivery ${Math.round(frac * 100)} %`); }
    const late = pay.model !== 'award' && j.type !== 'cruise' && Number.isFinite(j.dueShip) && Number.isFinite(a.shipTime) && a.shipTime > j.dueShip;
    if (late) { cr = Math.round(cr * 0.5); notes.push('late (half pay)'); }
    return { cr: Math.round(cr), notes, late };
  }
  settle(a, j) {
    const { cr: total, notes } = this.settleAmount(a, j);
    const before = j.prog?.paid || 0, cr = Math.max(0, total - before);
    if (before > 0) notes.push(`${fmt(before)} cr paid per lifting`);
    a.jobs = (a.jobs || []).filter((x) => x !== j);
    a.cargo = (a.cargo || []).filter((c) => c.jobId !== j.id);
    const text = `Completed: ${j.title} — +${fmt(cr)} cr${notes.length ? ` (${notes.join(', ')})` : ''}.`;
    if (this.env.pay) this.env.pay(a, cr, j, text); else if (Number.isFinite(a.money)) a.money += cr;
    this.event(a, 'info', text);
  }

  // ---------------------------------------------------------------------------------------------- captains (H6e)
  /** Where a captain should take the ship for the job's current step (null = captains cannot do this step). */
  nextTarget(a, j) {
    if (!isRunnerJob(j) || !j.prog) return null;
    if (!CAPTAIN_TYPES.includes(j.type)) return null;
    const s = j.steps[j.prog.i]; if (!s) return null;
    if (typeof s.at === 'string') return { kind: 'harbor', harbor: s.at, here: a.docked === s.at, jobId: j.id };
    if (s.k === 'drill') return null;
    if (s.k === 'work' && !s.at) return { kind: 'stay', jobId: j.id, h: s.h };
    if (s.at) return { kind: 'spot', lat: s.at.lat, lon: s.at.lon, rM: s.at.rM, maxKn: s.maxKn ?? null, hold: s.k === 'work', jobId: j.id };
    return null;
  }
}

/** Load-time healing for players and fleet vessels (§8): accepted gen-7 jobs become `legacy`, cargo stacks get `unit`. */
export function migrateSave(actors) { for (const a of actors || []) migrateActor(a); return actors; }
export { JOB_GEN, weightsFor, BOARD_SIZE, FAMILIES };
