// Can this ship do this job, and if not, why not (docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §5.8). Checks in the
// contract's order; the first failure is `why`, every failure is in `all`. Pure; plain ESM, browser-safe.
//   ctx = { harborById(id), simTime, berthWater?(harborId) → m, weatherAt?(harborId) → { windKn, hs },
//           politics?: { ds, ctx, jobCheck? }, licenceOk?(vessel, need) → bool, crewOk?(vessel, job) → { ok, n, m },
//           jonesActive?: bool, skipTime?: bool }
import { CARGO, UNITS, unitsOf, freeUnits, loadOption, handlingText, eqOf, craneSwlOf } from '../cargo.js';
import { FAMILIES, legacyNeeds, isPassengerShip, stepHours } from './catalogue.js';
import { limitsOf, tagsOf, shortName } from './ports.js';
import { iceNeedAt } from './sites.js';
import { loaOf, draftOf, bpOf, iceRank, ICE_RANK, ICE_LABEL, typeOf, isSail, rowOf, modelOf, shipSource } from './shipview.js';
import { isRunnerJob } from './types.js';
import { needFor, fmtShipH } from '../jobtime.js';

let POL = null;
try { POL = await import('../politics.js'); } catch { POL = null; }   // politics lane may be mid-edit: hook stays off

// Families whose cargo decides the hull: their "why not" is the cargo's handling text (with ship suggestions).
const CARGO_FAMILIES = new Set(['box', 'liner', 'voyage', 'coa', 'project', 'vehicles']);
/** Reason codes in check order. */
export const CHECK_ORDER = ['handling', 'eq', 'cap', 'paxcert', 'loa', 'draft', 'facility', 'ice', 'licence', 'crew', 'politics', 'weather', 'time'];
const FACILITY_NAME = {
  oil: 'crude oil terminal', products: 'product terminal', chem: 'chemical terminal', lng: 'LNG terminal', lpg: 'LPG terminal',
  roro: 'ro-ro ramp', livestock: 'livestock berth', bulk: 'Capesize bulk terminal', vloc: 'VLOC berth', cruise: 'cruise berth',
};
const fmtN = (n) => Math.round(n).toLocaleString('en-US');
const m1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
const unitWord = (u, n) => (u === 'pax' ? 'berths' : UNITS[u] ? (n === 1 ? UNITS[u].label : UNITS[u].plural) : u);

/** The text of a reason (≤ 60 chars for the chip; templates of §5.8). */
export function reasonText(r) {
  if (!r) return '';
  if (r.text) return r.text;
  switch (r.code) {
    case 'handling': return handlingText(r.handling);
    case 'eq': return `Needs ${r.eq}`;
    case 'cap': return `Needs ${fmtN(r.qty)} ${unitWord(r.unit, r.qty)} (${fmtN(Math.max(0, r.free))} free)`;
    case 'paxcert': return 'More than 12 guests needs a passenger ship';
    case 'loa': return `${r.port} takes up to ${r.n} m; you are ${r.L} m`;
    case 'draft': return `${r.port}: ${m1(r.water)} m at the berth, you draw ${m1(r.T)} m`;
    case 'facility': return r.facility === 'cranes' ? `No shore cranes at ${r.port} — needs a geared ship` : `${r.port} has no ${FACILITY_NAME[r.facility] || r.facility}`;
    case 'ice': return `Ice class ${ICE_LABEL[r.cls] || r.cls} needed at ${r.port} in season`;
    case 'licence': return `Needs a ${r.licence} licence`;
    case 'crew': return `Needs ${r.n} crew (${r.m} aboard)`;
    case 'weather': return r.level ? `Wind ${Math.round(r.n)} kn — limit ${r.m} kn for Level ${r.level} students` : `Wind ${Math.round(r.n)} kn — limit ${r.m} kn`;
    default: return r.code || '';
  }
}
const mk = (code, extra = {}) => { const r = { code, ...extra }; r.text = reasonText(r); return r; };
const cap1 = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function clsOfVessel(v) { return v?.ship?.cls ?? v?.cls ?? null; }
function freeOf(v, unit) {
  if (unit === 't' && Number.isFinite(v?.holdFreeT)) return v.holdFreeT;
  if (unit === 'pax' && (Number.isFinite(v?.paxFree) || v?.paxFree === Infinity)) return v.paxFree;
  return freeUnits(v, unit);
}
/** Harbour ids where cargo/passengers are worked (loa, draught, facilities, ice). */
export function portsOf(job) {
  const out = new Set();
  if (isRunnerJob(job)) {
    // a cruise works every port it calls at (length, draught, cruise terminal, ice, politics apply to each call)
    const kinds = job.type === 'cruise' ? ['load', 'discharge', 'board', 'land', 'sail', 'work'] : ['load', 'discharge', 'board', 'land'];
    for (const s of job.steps) if (kinds.includes(s.k) && typeof s.at === 'string') out.add(s.at);
    if (!out.size && typeof job.from === 'string') out.add(job.from);
  } else {
    if (job?.from) out.add(job.from);
    if (job?.to && !['fishing', 'supply'].includes(job.type)) out.add(job.to);
  }
  return [...out];
}
/** Harbours where `job` loads and where it discharges (facility rules apply at both). */
function cargoPorts(job) {
  if (!isRunnerJob(job)) return portsOf(job);
  const out = new Set();
  for (const s of job.steps) if ((s.k === 'load' || s.k === 'discharge') && typeof s.at === 'string') out.add(s.at);
  return [...out];
}

function needsOf(job) { return job?.needs || legacyNeeds(job); }

/**
 * canDo(job, vessel, ctx) → { ok, why: Reason|null, all: [Reason] }. `vessel` = { ship: { cls }, cargo, jobs, … } (a player or
 * a fleet vessel) or the jobtime shape { cls, holdFreeT, paxFree }.
 */
export function canDo(job, vessel, ctx = {}) {
  const all = [];
  const cls = clsOfVessel(vessel);
  if (!job || !cls || !modelOf(cls)) return { ok: false, why: mk('handling', { text: 'Unknown ship' }), all: [mk('handling', { text: 'Unknown ship' })] };
  const fam = FAMILIES[job.type];
  const needs = needsOf(job);
  const H = (id) => (ctx.harborById ? ctx.harborById(id) : null);
  const ports = portsOf(job).map(H).filter(Boolean);

  // 1. handling: the family's ship type, the legacy charter category, then the cargo's handling
  let handlingFailed = false;
  if (fam && !fam.legacy && !(CARGO_FAMILIES.has(job.type) && job.cargo?.good)) { const fit = fam.fit(cls); if (fit) { all.push(mk('handling', { family: job.type, text: cap1(fit) })); handlingFailed = true; } }
  if (!handlingFailed && needs.cats && !needs.cats.includes(rowOf(cls)?.cat)) { all.push(mk('handling', { text: needs.cats.includes('passenger') ? 'Needs a yacht or ferry' : 'Needs a yacht' })); handlingFailed = true; }
  if (!handlingFailed && job.type === 'fishing' && fam?.fit(cls)) { all.push(mk('handling', { handling: 'fish', text: 'This hull cannot fish' })); handlingFailed = true; }
  if (!handlingFailed && needs.sail && !isSail(cls)) { all.push(mk('handling', { text: 'Needs a sailing yacht' })); handlingFailed = true; }
  if (!handlingFailed && needs.motor && typeOf(cls) !== 'motor_yacht' && !isSail(cls)) { all.push(mk('handling', { text: 'Needs a yacht' })); handlingFailed = true; }
  const good = job.cargo?.good ?? (job.type === 'freight' || job.type === 'smuggling' ? job.good : null);
  let opt = null;
  if (!handlingFailed && good && CARGO[good]) {
    opt = loadOption(good, cls);
    if (!opt) {
      const g = CARGO[good];
      const hs = new Set(modelOf(cls).handling || []);
      const partial = g.opts.find((o) => hs.has(o.h));
      if (partial) { opt = partial; } // handling present, plugs/dg missing → eq check below
      else { all.push(mk('handling', { handling: g.opts[0].h })); handlingFailed = true; }
    }
  } else if (!handlingFailed && Array.isArray(needs.handling) && needs.handling.length && !good) {
    const hs = new Set(modelOf(cls).handling || []);
    if (!needs.handling.some((h) => hs.has(h))) { all.push(mk('handling', { handling: needs.handling[0] })); handlingFailed = true; }
  }

  // 2. equipment
  const eq = new Set(eqOf(cls)), u = unitsOf(cls);
  if (!handlingFailed) {
    const plugsNeed = job.cargo?.reefer || (opt?.plugs ? job.cargo?.qty : 0) || 0;
    if (plugsNeed > 0 && u.plugs < plugsNeed) all.push(mk('eq', { eq: `${fmtN(plugsNeed)} reefer plugs (you have ${fmtN(u.plugs)})` }));
    if ((job.cargo?.dg || opt?.dg) && !eq.has('dg')) all.push(mk('eq', { eq: 'a dangerous-goods (IMDG) ship' }));
    for (const e of needs.eq || []) if (!eq.has(e)) all.push(mk('eq', { eq: EQ_WORDS[e] || e }));
    if (needs.eqAny?.length && !needs.eqAny.some((e) => eq.has(e))) all.push(mk('eq', { eq: needs.eqAny.map((e) => EQ_WORDS[e] || e).join(' or ') }));
    if (needs.minBp && bpOf(cls) < needs.minBp) all.push(mk('eq', { eq: `${needs.minBp} t bollard pull (you have ${bpOf(cls)} t)` }));
    if (needs.grades && (u.segregations || 0) < needs.grades) all.push(mk('eq', { eq: `${needs.grades} tank segregations (you have ${u.segregations || 0})` }));
    if (job.cargo?.pieces?.length) {
      const heaviest = Math.max(...job.cargo.pieces), lift = 2 * craneSwlOf(cls);
      const portsHeavy = cargoPorts(job).map(H).every((h) => h && tagsOf(h).has('heavy'));
      if (heaviest > lift && !portsHeavy) all.push(mk('eq', { eq: `cranes for a ${fmtN(heaviest)} t piece (you lift ${fmtN(lift)} t)` }));
    }
    if (needs.ice && iceRank(cls) < (ICE_RANK[needs.ice] || 0)) all.push(mk('eq', { eq: `ice class ${ICE_LABEL[needs.ice] || needs.ice}` }));
    if (needs.maxLoa && loaOf(cls) > needs.maxLoa) all.push(mk('eq', { eq: `a boat ≤ ${needs.maxLoa} m (you are ${Math.round(loaOf(cls))} m)` }));
  }

  // 3. capacity in the job's unit (and tonnes)
  if (!handlingFailed) {
    const unit = needs.unit || job.cargo?.unit || null, qty = needs.qty ?? job.cargo?.qty ?? 0;
    if (unit && qty > 0) {
      const free = freeOf(vessel, unit);
      if (qty > free + 1e-9) all.push(mk('cap', { qty, unit, free }));
      else if (unit !== 't' && unit !== 'pax' && unit !== 'm3' && job.cargo?.t > 0) {
        const freeT = freeOf(vessel, 't');
        if (job.cargo.t > freeT + 1e-9) all.push(mk('cap', { qty: job.cargo.t, unit: 't', free: freeT }));
      }
    }
    if (job.pax > 0 && unit !== 'pax') { const free = freeOf(vessel, 'pax'); if (job.pax > free) all.push(mk('cap', { qty: job.pax, unit: 'pax', free })); }
  }

  // 4. passenger certificate (SOLAS I/2: more than 12 passengers)
  if ((needs.paxCert || ((job.type === 'passengers' || job.type === 'charter') && (job.pax || 0) > 12)) && !isPassengerShip(cls)) all.push(mk('paxcert'));

  // 5. length and draught at every port worked
  const L = loaOf(cls), T = draftOf(cls);
  for (const h of ports) {
    const lim = limitsOf(h);
    if (L > lim.maxLoa) all.push(mk('loa', { port: shortName(h), n: lim.maxLoa, L: Math.round(L) }));
    const water = ctx.berthWater ? ctx.berthWater(h.id) : lim.maxDraft;
    if (Number.isFinite(water) && water < T) all.push(mk('draft', { port: shortName(h), water, T }));
  }

  // 6. shore facilities at the cargo ports
  if (!handlingFailed) for (const id of cargoPorts(job)) {
    const h = H(id); if (!h) continue;
    const f = facilityGap(job, cls, h, opt);
    if (f) all.push(mk('facility', { port: shortName(h), facility: f }));
  }

  // 6b. a cruise ship over 250 m needs a cruise terminal at every call (smaller ships tender or use a commercial quay)
  if (job.type === 'cruise' && L > 250) for (const h of ports) if (!tagsOf(h).has('cruise')) all.push(mk('facility', { port: shortName(h), facility: 'cruise' }));

  // 7. seasonal ice at every port worked
  for (const h of ports) {
    const need = iceNeedAt(h, ctx.simTime ?? 0);
    if (need && iceRank(cls) < ICE_RANK[need]) all.push(mk('ice', { cls: need, port: shortName(h) }));
  }

  // 8. licence (V7 #1 stub) and crew (wave-2 stub)
  if (ctx.licenceOk && needs.licence && !ctx.licenceOk(vessel, needs.licence)) all.push(mk('licence', { licence: needs.licence }));
  if (ctx.crewOk) { const c = ctx.crewOk(vessel, job); if (c && c.ok === false) all.push(mk('crew', { n: c.n, m: c.m })); }

  // 9. politics (jobCheck when the politics data is live; Jones Act R1/R4 when switched on)
  if (ctx.politics?.ds) {
    const check = ctx.politics.jobCheck || POL?.jobCheck;
    if (check) {
      let r = null;
      try { r = check(ctx.politics.ds, ctx.politics.ctx, job, vessel); } catch { r = null; }
      if (r && r.ok === false) all.push(mk('politics', { text: (POL?.reasonText ? POL.reasonText(r.block) : r.block?.text) || 'Not allowed for your company', block: r.block }));
    }
  }
  if (needs.jones && ctx.jonesActive) {
    const jonesOk = shipSource()?.jonesOk;
    if (!(jonesOk ? jonesOk(vessel) : vessel?.builtIn === 'US')) all.push(mk('politics', { text: 'Jones Act: needs a US-built, US-flag ship' }));
  }

  // 10. weather window
  if (needs.maxWindKn && ctx.weatherAt) {
    const w = ctx.weatherAt(job.from);
    if (w && Number.isFinite(w.windKn) && w.windKn > needs.maxWindKn) all.push(mk('weather', { n: w.windKn, m: needs.maxWindKn, level: needs.level || null }));
  }

  // 11. ship-hours feasibility
  if (!ctx.skipTime && !all.length && Number.isFinite(job.hours)) {
    const need = isRunnerJob(job) ? stepHours(job, cls) : needFor(job, cls).needH;
    if (!(need <= job.hours)) all.push(mk('time', { needH: need, budgetH: job.hours, text: `too slow for your ship: needs ~${fmtShipH(need)}, the contract allows ${job.hours} h` }));
  }

  all.sort((a, b) => CHECK_ORDER.indexOf(a.code) - CHECK_ORDER.indexOf(b.code));
  return { ok: all.length === 0, why: all[0] || null, all };
}

const EQ_WORDS = {
  towWinch: 'a towing winch', sternRoller: 'a stern roller', gangway: 'a walk-to-work gangway', survey: 'survey equipment',
  aframe: 'an A-frame', moonpool: 'a moon pool', hoseCranes: 'hose cranes', tender: 'a tender', dp2: 'DP2', fifi: 'fire-fighting gear',
  helideck: 'a helideck', rsw: 'RSW tanks', freezer: 'a freezer hold', dg: 'a DG certificate',
};

/** The missing shore facility for this job's cargo at harbour `h`, or null (§5.3 "Shore equipment"). */
export function facilityGap(job, cls, h, opt = null) {
  const tags = tagsOf(h), good = job.cargo?.good ?? job.good, g = CARGO[good];
  const handling = opt?.h ?? g?.opts?.[0]?.h ?? null;
  if (!handling) return null;
  const any = (...ts) => ts.some((t) => tags.has(t));
  switch (handling) {
    case 'box': return !tags.has('container') || h.size === 'minor' ? (eqOf(cls).includes('geared') ? null : 'cranes') : null;
    case 'liquid:crude': return any('oil') ? null : 'oil';
    case 'liquid:clean': return any('products', 'oil', 'bunkers') ? null : 'products';
    case 'liquid:chem': return any('chem', 'products') ? null : 'chem';
    case 'gas:lpg': return any('lpg') ? null : 'lpg';
    case 'gas:lng': return any('lng') ? null : 'lng';
    case 'roro': return any('roro', 'cars', 'ferry') ? null : 'roro';
    case 'livestock': return any('livestock') ? null : 'livestock';
    case 'bulk': {
      const dwt = modelOf(cls)?.dwt || unitsOf(cls).t || 0;
      if (dwt >= 300000 && !limitsOf(h).vloc) return 'vloc';
      if (dwt >= 150000 && !any('bulk_ore', 'bulk_coal', 'bulk_grain')) return 'bulk';
      return null;
    }
    default: return null;
  }
}

/**
 * The two functions shared/jobtime.js registers for JOB_GEN 8 jobs (hook H6c, `setGen8(jobtimeHooks(ctxFn))`):
 *   hardReason(job, ship) → string | null   (canDo minus the time check, which estimateJob does itself)
 *   needFor(job, cls)     → { type, workH, sailH, needH } for runner jobs, null for legacy families (jobtime keeps its own)
 * `ctxFn()` returns the canDo ctx (harborById, simTime, …) of the side that registers (server or client).
 */
export function jobtimeHooks(ctxFn = () => ({})) {
  return {
    hardReason(job, ship) {
      if (!job || (job.gen || 0) < 8 || job.legacy) return undefined;          // undefined → jobtime's own legacy rules
      const r = canDo(job, ship, { ...ctxFn(), skipTime: true });
      return r.ok ? null : r.why.text;
    },
    needFor(job, cls) {
      if (!isRunnerJob(job)) return null;
      const h = stepHours(job, cls);
      const workH = job.steps.reduce((s, x) => s + (x.k === 'work' ? x.h || 0 : 0), 0);
      return { type: job.type, workH, sailH: Math.max(0, h - workH), needH: h };
    },
  };
}
