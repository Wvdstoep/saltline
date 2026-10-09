// The job record of JOB_GEN 8 (docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §5.4, frozen shape) and the small pure
// helpers every lane-D module shares: step kinds, pay normalisation, legacy detection and save migration (§8).
// Plain ESM, browser-safe (served at /shared), no DOM, no state.

export const JOB_GEN = 8;

/** Step kinds the runner (server/jobsx.js) understands. */
export const STEP_KINDS = ['load', 'discharge', 'board', 'land', 'sail', 'work', 'meet', 'tow', 'race', 'drill'];

/** The six families (+ smuggling) that keep their own code path in server/game.js (no steps, numeric `pay`). */
export const LEGACY_TYPES = ['freight', 'passengers', 'charter', 'fishing', 'supply', 'tow', 'smuggling'];

/** Pay models: lump sum on the last step, hire per hour, award (salvage, regatta). */
export const PAY_MODELS = ['lump', 'hire', 'award'];

/** Filter-chip groups of the job board (§5.9), in display order. */
export const GROUPS = [
  ['cargo', 'Cargo'], ['tankers', 'Tankers & gas'], ['containers', 'Containers'], ['passengers', 'Passengers'],
  ['offshore', 'Offshore'], ['harbour', 'Harbour'], ['fishing', 'Fishing'], ['yachts', 'Yachts & sailing'], ['special', 'Special'],
];

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Credits a job pays as shown on a card: legacy jobs carry a number, JOB_GEN 8 runner jobs `{ cr, … }`. */
export function payOf(job) {
  if (!job) return 0;
  if (isNum(job.pay)) return job.pay;
  if (job.pay && isNum(job.pay.cr)) return job.pay.cr;
  return 0;
}

/** The pay record `{ cr, perH?, bonus?, model, … }` of a runner job, on the server (`pay`) or on the wire (`payInfo`). */
export function payInfoOf(job) { return job && typeof job.pay === 'object' && job.pay ? job.pay : job?.payInfo || null; }
/**
 * Wire form of a job for clients (sendHarbor `harbor.jobs`, `you.jobs`, publicJob): `pay` stays a number so every existing
 * reader (hud cards, chart boards, sorting) keeps working; the full pay record rides along as `payInfo`.
 */
export function wireJob(j) { return j && typeof j.pay === 'object' && j.pay ? { ...j, pay: payOf(j), payInfo: j.pay } : j; }

/** Is this a record the step runner owns (gen ≥ 8 with steps)? Legacy families and older saves are not. */
export function isRunnerJob(job) {
  return !!job && (job.gen || 0) >= JOB_GEN && Array.isArray(job.steps) && job.steps.length > 0 && !job.legacy;
}

/** A job generated before JOB_GEN 8 (accepted jobs of this kind finish on the legacy code path, no handling check). */
export function isLegacyGen(job) { return !job || (job.gen || 0) < JOB_GEN; }

/** Board filter (§8 "harbour jobs"): offers from an older generator leave the board at the first regen. */
export function boardCurrent(job) { return !!job && isNum(job.hours) && (job.gen || 0) >= JOB_GEN; }

/** §8: an accepted job from an older save keeps running exactly as before — mark it `legacy` (derived, idempotent). */
export function migrateAcceptedJob(job) {
  if (!job || typeof job !== 'object') return job;
  if (isLegacyGen(job)) job.legacy = true;
  return job;
}

/** §8 "cargo stacks": `unit` defaults to tonnes at read time; `units` (count in that unit) to qty. */
export function healCargoStack(c) {
  if (!c || typeof c !== 'object') return c;
  if (typeof c.unit !== 'string') c.unit = 't';
  if (!isNum(c.units)) c.units = c.unit === 't' ? c.qty : c.units ?? c.qty;
  return c;
}

/** Heal one actor (player or fleet vessel) loaded from a save: accepted jobs and cargo stacks. */
export function migrateActor(a) {
  if (!a) return a;
  for (const j of a.jobs || []) migrateAcceptedJob(j);
  for (const c of a.cargo || []) healCargoStack(c);
  return a;
}

/** Build a Step with only the known keys (drops undefined). */
export function step(k, at, extra = {}) {
  if (!STEP_KINDS.includes(k)) throw new Error(`unknown step kind ${k}`);
  const s = { k, at: at ?? null };
  for (const [key, v] of Object.entries(extra)) if (v !== undefined) s[key] = v;
  if (!s.label) s.label = k;
  return s;
}

/** Validate the frozen record shape (used by tests and by the server before persisting a generated job). */
export function validJob(j) {
  const errs = [];
  if (!j || typeof j !== 'object') return ['not an object'];
  if (typeof j.id !== 'string') errs.push('id');
  if (j.gen !== JOB_GEN) errs.push('gen');
  if (typeof j.type !== 'string') errs.push('type');
  if (typeof j.family !== 'string') errs.push('family');
  if (typeof j.title !== 'string' || !j.title) errs.push('title');
  if (typeof j.from !== 'string') errs.push('from');
  if (!(j.to === null || typeof j.to === 'string')) errs.push('to');
  if (!(j.legs === null || Array.isArray(j.legs))) errs.push('legs');
  if (!(j.cargo === null || (j.cargo && typeof j.cargo.good === 'string' && isNum(j.cargo.qty) && isNum(j.cargo.t)))) errs.push('cargo');
  if (!isNum(j.pax)) errs.push('pax');
  if (!j.needs || typeof j.needs !== 'object') errs.push('needs');
  if (!Array.isArray(j.steps) || !j.steps.length || j.steps.some((s) => !STEP_KINDS.includes(s.k))) errs.push('steps');
  if (!j.window || !isNum(j.window.dueAt)) errs.push('window');
  if (!j.pay || !isNum(j.pay.cr) || !PAY_MODELS.includes(j.pay.model)) errs.push('pay');
  if (!isNum(j.hours) || j.hours <= 0) errs.push('hours');
  if (!isNum(j.postedAt) || !isNum(j.expiresAt)) errs.push('posted');
  return errs;
}
