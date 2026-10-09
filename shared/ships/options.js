// Options and variant ids (docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §2.5). A variant id is `<model>` or
// `<model>~<token>.<token>…` with tokens in the canonical group order engine, ice, gear, esd, rot, air, spec. Only options
// that change play go into the id (livery and name do not). Pure; no constants import.
import { MODELS } from './catalogue.js';
import { OPTIONS, GROUPS, GROUP_TOKENS, modelAllows, ecoGrade } from './optrules.js';

export { OPTIONS, GROUPS, modelAllows, ecoGrade };
export const VARIANT_RE = /^[a-z][a-z0-9_]{1,31}(~[a-z0-9]{2,8}(\.[a-z0-9]{2,8}){0,6})?$/;

/** The opts object of a model with no options chosen. */
export function defaultOpts(model) {
  const m = typeof model === 'string' ? MODELS[model] : model;
  return { engine: m?.defaults?.engine || 'vlsfo', ice: null, gear: m?.defaults?.gear || null, esd: false, rot: false, air: false, spec: 'std' };
}

/** Tokens (canonical order) for an opts object; null when an option is unknown or not allowed on the model. */
export function tokensOf(model, opts = {}) {
  const m = typeof model === 'string' ? MODELS[model] : model;
  if (!m) return null;
  const d = defaultOpts(m), out = [];
  const add = (t) => { if (!OPTIONS[t] || !modelAllows(m, t).ok) return false; out.push(t); return true; };
  if (opts.engine != null && opts.engine !== d.engine) { if (!add(opts.engine)) return null; }
  if (opts.ice) { if (!add(opts.ice)) return null; }
  if (opts.gear != null && opts.gear !== d.gear) { if (!add(opts.gear)) return null; }
  for (const k of ['esd', 'rot', 'air']) if (opts[k] === true) { if (!add(k)) return null; }
  if (opts.spec && opts.spec !== 'std') { if (!add(opts.spec)) return null; }
  return out;
}

/** variantId('ultramax64', { engine: 'lng', ice: 'i1c', esd: true }) → 'ultramax64~lng.i1c.esd'; null if not valid. */
export function variantId(model, opts = {}) {
  const id = typeof model === 'string' ? model : model?.id;
  const t = tokensOf(id, opts);
  if (!t) return null;
  return t.length ? `${id}~${t.join('.')}` : id;
}

/** → { model, tokens: [..], opts } or null (unknown model, unknown/duplicate/out-of-order token, token not allowed). */
export function parseVariant(id) {
  if (typeof id !== 'string' || id.length > 80 || !VARIANT_RE.test(id)) return null;
  const [model, rest] = id.split('~');
  const m = MODELS[model];
  if (!m) return null;
  const opts = defaultOpts(m);
  if (rest === undefined) return { model, tokens: [], opts };
  const tokens = rest.split('.');
  let gi = -1;
  for (const t of tokens) {
    const o = OPTIONS[t];
    if (!o) return null;
    const g = GROUPS.indexOf(o.group);
    if (g <= gi) return null;           // one token per group, canonical order
    gi = g;
    if (!modelAllows(m, t).ok) return null;
    if (o.group === 'engine') opts.engine = t;
    else if (o.group === 'ice') opts.ice = t;
    else if (o.group === 'gear') opts.gear = t;
    else if (o.group === 'spec') opts.spec = t;
    else opts[o.group] = true;
  }
  return { model, tokens, opts };
}

/** Π price multipliers of the tokens. */
export function priceMul(tokens) { return tokens.reduce((p, t) => p * (OPTIONS[t]?.price ?? 1), 1); }
/** Π burn (fuel mass) multipliers of the tokens. */
export function burnMul(tokens) { return tokens.reduce((p, t) => p * (OPTIONS[t]?.burn ?? 1), 1); }
export function specOf(tokens) { return tokens.includes('eco') ? OPTIONS.eco : tokens.includes('prem') ? OPTIONS.prem : null; }
/** Groups whose tokens exclude each other (for the configurator). */
export const EXCLUSIVE = GROUP_TOKENS;
