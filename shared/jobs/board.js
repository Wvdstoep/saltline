// Job board logic (docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §5.9), DOM-free so the client (public/js/jobboard.js) and the
// node tests share it: grouping into "Your ship can do" / "Your fleet can do" / "Other work here", sorting by estimated
// profit per hour, family chips with counts, unit-aware card lines and the steps preview. Plain ESM, browser-safe.
import { canDo } from './eligibility.js';
import { FAMILIES, groupOf, payCrFor, stepHours, CAPTAIN_TYPES } from './catalogue.js';
import { GROUPS, isRunnerJob, payOf, payInfoOf } from './types.js';
import { CARGO } from '../cargo.js';
import { rowOf, serviceKnOf } from './shipview.js';
import { needFor } from '../jobtime.js';
import { shortName } from './ports.js';

const fmtN = (n) => Math.round(n).toLocaleString('en-US');
const SIZE_DUES = { mega: 1.6, major: 1.3, regional: 1.0, minor: 0.8 };   // display estimate only (economy SIZE_DUES shape)
export const BOARD_COST = { FUEL_CR_T: 650, BURN_SERVICE: 0.56, DUES_PER_T: 0.12 };

/** Unit-aware cargo line: "1,200 TEU · 300 reefer", "55,000 t grain", "174,000 m³ LNG", "6 crossings Dover ↔ Calais", … */
export function unitLine(job, harborById = () => null) {
  if (!job) return '';
  const nm = (id) => shortName(harborById(id)) || id;
  switch (job.type) {
    case 'ropax_route': return `${job.crossings || job.steps?.filter((s) => s.k === 'board').length || 0} crossings ${nm(job.legs?.[0] || job.from)} ↔ ${nm(job.legs?.[1] || job.to)}`;
    case 'lesson': return `${job.pax} student${job.pax === 1 ? '' : 's'} · Level ${job.level} · wind limit ${job.needs?.maxWindKn} kn`;
    case 'passengers': case 'charter': case 'daycharter': case 'ecotour': case 'guests': case 'cruise': return `${fmtN(job.pax || 0)} ${job.type === 'passengers' ? 'passengers' : 'guests'}`;
    case 'crewchange': return `${job.pax} technicians`;
    case 'research': return `${job.pax} scientists · ${job.stations} stations`;
    case 'standby': case 'tc': case 'bareboat': { const w = job.steps?.find((s) => s.k === 'work'), pi = payInfoOf(job); return w ? `${w.h} h${pi?.perH ? ` · ${fmtN(pi.perH)} cr/h` : ''}` : ''; }
    case 'dredge': return `${fmtN(job.m3 || 0)} m³ dredged`;
    case 'survey': return `${fmtN(job.lineKm || 0)} km of survey lines`;
    case 'regatta': return `${job.entries} entries · entry ${fmtN(payInfoOf(job)?.entry || 0)} cr · purse ${fmtN(payInfoOf(job)?.purse || 0)} cr`;
    default: break;
  }
  const c = job.cargo || (job.good ? { good: job.good, unit: 't', qty: job.qty } : null);
  if (!c) return '';
  const g = CARGO[c.good], name = (g?.name || c.good).toLowerCase();
  if (c.unit === 'teu') return `${fmtN(c.qty)} TEU${c.reefer ? ` · ${fmtN(c.reefer)} reefer` : ''}${c.dg ? ' · DG' : ''}`;
  if (c.unit === 'm3') return `${fmtN(c.qty)} m³ ${c.good === 'lng' || c.good === 'lpg' ? c.good.toUpperCase() : name}`;
  if (c.unit === 'ceu') return `${fmtN(c.qty)} CEU (cars)`;
  if (c.unit === 'lm') return `${fmtN(c.qty)} lane m`;
  if (c.unit === 'head') return `${fmtN(c.qty)} head of livestock`;
  if (c.pieces?.length) return `${c.pieces.length} piece${c.pieces.length > 1 ? 's' : ''}, max ${fmtN(Math.max(...c.pieces))} t`;
  return `${fmtN(c.qty)} t ${name}`;
}

/** Icons of the steps preview (load, sail, work, meet, race …), consecutive duplicates merged. */
export function stepsPreview(job) {
  if (!isRunnerJob(job)) return job?.type === 'fishing' ? ['sail', 'work', 'sail'] : ['load', 'sail', 'discharge'];
  const out = [];
  for (const s of job.steps) if (out[out.length - 1] !== s.k) out.push(s.k);
  return out;
}

/** Hours this ship needs for `job` (runner: steps; legacy: jobtime's needFor). */
export function hoursFor(job, cls) {
  if (isRunnerJob(job)) return stepHours(job, cls);
  try { return needFor(job, cls).needH; } catch { return NaN; }
}
/** Estimated profit per hour: (pay − fuel − crew − dues) / hours, at service speed (§5.9 sort key). */
export function profitPerH(job, cls, { fuelCrT = BOARD_COST.FUEL_CR_T, harborById = () => null } = {}) {
  const C = rowOf(cls) || {};
  const h = hoursFor(job, cls);
  const pay = isRunnerJob(job) ? payCrFor(job, cls) : payOf(job);
  if (!(h > 0) || !Number.isFinite(h)) return { pph: -Infinity, net: pay, hours: h, fuel: 0, crew: 0, dues: 0, pay };
  const fuelPaid = payInfoOf(job)?.fuelPaid ? (job.steps?.find((s) => s.hire)?.h || 0) : 0;
  const fuel = C.sail ? 0 : (C.burn || 0) * BOARD_COST.BURN_SERVICE * Math.max(0, h - fuelPaid) * fuelCrT;
  const crew = (C.crewCost || 0) * h;
  const calls = isRunnerJob(job) ? new Set(job.steps.filter((s) => typeof s.at === 'string').map((s) => s.at)) : new Set([job.to].filter(Boolean));
  let dues = 0;
  for (const id of calls) dues += (C.displacement || 0) * BOARD_COST.DUES_PER_T * (SIZE_DUES[harborById(id)?.size] || 1);
  const net = pay - fuel - crew - dues;
  return { pph: net / h, net, hours: h, fuel, crew, dues, pay };
}

/** Family filter chips with counts, in GROUPS order (empty groups left out). */
export function familyChips(jobs) {
  const n = new Map();
  for (const j of jobs || []) { const g = groupOf(j); n.set(g, (n.get(g) || 0) + 1); }
  return GROUPS.filter(([g]) => n.has(g)).map(([group, label]) => ({ group, label, n: n.get(group) }));
}

const vCls = (v) => v?.ship?.cls ?? v?.cls;
const vDocked = (v) => v?.docked ?? v?.harbor ?? null;
/**
 * Group a harbour board for `you` (the ship you are aboard) and your other vessels (`fleet`: [{ id, name, ship|cls, docked,
 * cargo, jobs, status }]) docked here: { mine: [{ job, est }], fleet: [{ job, vessels: [{ id, name }] }], other: [{ job, why, all }] }.
 * `mine` is sorted by estimated profit per hour; `other` by pay. `filter` = a group id or null.
 */
export function groupBoard(jobs, you, fleet = [], ctx = {}, { harbor = null, filter = null } = {}) {
  const mine = [], fl = [], other = [];
  const cls = vCls(you);
  const here = harbor ?? you?.docked ?? null;
  const others = (fleet || []).filter((v) => v && v.id !== you?.id && v.status !== 'laidup' && (!here || vDocked(v) === here));
  for (const job of jobs || []) {
    if (filter && groupOf(job) !== filter) continue;
    const r = cls ? canDo(job, you, ctx) : { ok: false, why: null, all: [] };
    if (r.ok) { mine.push({ job, est: profitPerH(job, cls, ctx) }); continue; }
    const fam = FAMILIES[job.type];
    const vs = fam && (CAPTAIN_TYPES.includes(job.type)) && !job.contraband
      ? others.filter((v) => canDo(job, { ...v, ship: { cls: vCls(v) }, cargo: v.cargo || [], jobs: v.jobs || [] }, ctx).ok).map((v) => ({ id: v.id, name: v.name || v.id })) : [];
    if (vs.length) fl.push({ job, vessels: vs, why: r.why });
    else other.push({ job, why: r.why, all: r.all });
  }
  mine.sort((a, b) => b.est.pph - a.est.pph || payOf(b.job) - payOf(a.job));
  fl.sort((a, b) => payOf(b.job) - payOf(a.job));
  other.sort((a, b) => payOf(b.job) - payOf(a.job));
  return { mine, fleet: fl, other };
}
export { serviceKnOf };
