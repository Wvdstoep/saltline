// Inland contracts (docs/BRIDGES-LOCKS-VHF-CONTRACT.md §7.6, lane D) on the JOB_GEN 8 engine of
// docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md lane D (shared/jobs/*, server/jobsgen.js, server/jobsx.js):
//   barge_bulk       grain / steel / machinery (sand, gravel, fertiliser, scrap mapped onto existing goods, Q14)
//   barge_container  sea terminals ↔ inland container terminals, TEU, by the container barge's CEMT class
//   barge_tanker     fuel (products) in tanker barges
//   charter_day      marina → marina ≤ 40 km with guests (yachts)
//   lesson           the existing family, posted at marinas with inland tasks (lock passage, bridge opening request, box mooring)
// Origins and destinations are named harbours or minor harbours (server/minorharbours.js ids 'mh:…') on the inland graph.
// Pay comes from the planned inland route (planInland: km + bridge / lock waits) with the existing pay formulas.
// Eligibility adds CEMT class and air draught on the route to shared/jobs/eligibility.js canDo.
// Not registered in jobsgen yet: docs/WATERWAYS-HARBOURS-PHASE2.md §6 adds the families and the minor-harbour boards.
import { haversine } from '../shared/geo.js';
import { nextJobId } from './economy.js';
import { JOB_GEN, step } from '../shared/jobs/types.js';
import { PAY, payVoyage, payBox, payLesson, lessonWindKn } from '../shared/jobs/catalogue.js';
import { canDo, reasonText } from '../shared/jobs/eligibility.js';
import { LESSON_TASKS } from './jobsgen.js';
import { CARGO, toTonnes, handlingOf, unitsOf } from '../shared/cargo.js';
import { isYacht, isSail } from '../shared/jobs/shipview.js';
import { CEMT, CEMT_ORDER, cemtRank, fitsCemt } from '../shared/inlandshim.js';
import { BARGE_MODELS } from '../shared/ships/barges.js';
import { stubLaneA, plannerShip, routeHours, routeKm } from './inlandlink.js';
import { shipDimsOf } from './minorharbours.js';

const r1 = (v) => Math.round(v * 10) / 10;
const U = (rnd, a, b) => a + rnd() * (b - a);
const I = (rnd, a, b) => a + Math.floor(rnd() * (b - a + 1));
const fmtN = (n) => Math.round(n).toLocaleString('en-US');

export const INLAND = {
  INLAND_MUL: 1.3,            // inland freight earns more per t-km than sea freight (short hauls, locks, small lots) — Game rule
  WAIT_KMH: 14,               // waits (bridges, locks) count as distance at the inland service speed
  MIN_KM: 10, MAX_KM: 400,    // barge contract distance band
  CHARTER_MAX_KM: 40, CHARTER_RATE: [150, 300], CHARTER_KM_CR: 1.5,
  MARGIN: [1.4, 1.8], FIXED_H: 3, MIN_HOURS: 4, TTL_H: 24,
  BARGE_GOODS: ['grain', 'steel', 'machinery'],
};
const hasH = (cls, h) => handlingOf(cls).includes(h);
/** Family records in the FAMILIES shape (shared/jobs/catalogue.js F(...)); phase 2 merges them. */
export const INLAND_FAMILIES = {
  barge_bulk: { type: 'barge_bulk', label: 'Barge cargo', group: 'cargo', unit: 't', captains: true, phase: 2, legacy: false, inland: true,
    fit: (c) => (hasH(c, 'bulk') || hasH(c, 'breakbulk') ? null : 'needs a dry-cargo hold') },
  barge_container: { type: 'barge_container', label: 'Container barge', group: 'containers', unit: 'teu', captains: true, phase: 2, legacy: false, inland: true,
    fit: (c) => (hasH(c, 'box') ? null : 'needs a container hold') },
  barge_tanker: { type: 'barge_tanker', label: 'Tanker barge', group: 'tankers', unit: 't', captains: true, phase: 2, legacy: false, inland: true,
    fit: (c) => (hasH(c, 'liquid:clean') ? null : 'needs coated product tanks') },
  charter_day: { type: 'charter_day', label: 'Day charter A→B', group: 'yachts', unit: 'pax', captains: false, phase: 2, legacy: false, inland: true,
    fit: (c) => (isYacht(c) ? null : 'needs a yacht') },
};
export const INLAND_TYPES = Object.keys(INLAND_FAMILIES);
/** Inland lesson tasks (§7.6), added to LESSON_TASKS for lessons posted at minor marinas. `action` = the runner's counter. */
export const INLAND_LESSON_TASKS = {
  lock: { label: 'Lock passage', action: 'lock_pass', n: [1, 1], min: 1 },
  bridge: { label: 'Request a bridge opening on VHF', action: 'bridge_req', n: [1, 2], min: 1 },
  box: { label: 'Moor in a box', action: 'box_moor', n: [1, 2], min: 1 },
};

/**
 * Inland terminals seeded from public port data (approximate positions, `verify: true`): endpoints for barge contracts
 * until OSM/FIS minor harbours of tier inland_port cover them. cemt = class of the waterway at the terminal.
 */
export const INLAND_TERMINALS = [
  { id: 'mh:seed:nijmegen', name: 'Nijmegen container terminal', lat: 51.8527, lon: 5.8390, cemt: 'VIb', tags: ['container', 'bulk'], verify: true },
  { id: 'mh:seed:moerdijk', name: 'Moerdijk', lat: 51.6925, lon: 4.5925, cemt: 'VIb', tags: ['container', 'bulk', 'tanker'], verify: true },
  { id: 'mh:seed:alblasserdam', name: 'Alblasserdam container terminal', lat: 51.8570, lon: 4.6630, cemt: 'Vb', tags: ['container'], verify: true },
  { id: 'mh:seed:utrecht', name: 'Utrecht (Lage Weide)', lat: 52.1050, lon: 5.0650, cemt: 'Vb', tags: ['container', 'bulk'], verify: true },
  { id: 'mh:seed:amsterdam_westpoort', name: 'Amsterdam Westpoort', lat: 52.4100, lon: 4.8000, cemt: 'VIb', tags: ['container', 'bulk', 'tanker'], verify: true },
  { id: 'mh:seed:venlo', name: 'Venlo', lat: 51.3930, lon: 6.1760, cemt: 'Vb', tags: ['container', 'bulk'], verify: true },
  { id: 'mh:seed:born', name: 'Born (Julianakanaal)', lat: 51.0330, lon: 5.8060, cemt: 'Vb', tags: ['container', 'bulk'], verify: true },
].map((t) => ({ ...t, tier: 'inland_port', size: 'minor' }));

const TAG_OF = { barge_bulk: 'bulk', barge_container: 'container', barge_tanker: 'tanker' };
const minClass = (...cs) => { const rs = cs.map(cemtRank).filter((r) => r >= 0); return rs.length ? CEMT_ORDER[Math.min(...rs)] : null; };
const kmBetween = (a, b) => haversine(a.lat, a.lon, b.lat, b.lon) / 1000;
/** Does an endpoint take a family? (seed tags, or the tier: inland ports take every barge family, marinas none). */
export function portTakes(p, type) {
  if (type === 'charter_day') return p.tier === 'marina' || p.tier === 'passant';
  if (Array.isArray(p.tags)) return p.tags.includes(TAG_OF[type]);
  return p.tier === 'inland_port';
}
/** Barge models of a family whose CEMT class fits `cls`, biggest first. */
export function bargesForFamily(type, cls) {
  const r = cemtRank(cls);
  return Object.values(BARGE_MODELS).filter((m) => cemtRank(m.cemt) <= r && INLAND_FAMILIES[type].fit(m.id) === null && (type !== 'barge_bulk' || m.type !== 'container'))
    .sort((a, b) => b.capacity - a.capacity || (a.id < b.id ? -1 : 1)).map((m) => m.id);
}
/** The biggest barge model of a family whose CEMT class fits `cls` (null when none). */
export function refBargeFor(type, cls) { return bargesForFamily(type, cls)[0] || null; }

/** Route summary stored on the job (what eligibility reads when it cannot re-plan). */
export function routeSummary(route, cemt) {
  const marks = route?.marks || [];
  const fixed = marks.filter((m) => m.kind === 'bridge' && m.action === 'under' && (m.clrO == null));
  return {
    km: r1(routeKm(route)), hours: r1(routeHours(route) ?? 0), cemt,
    minFixedClr: fixed.length ? Math.min(...fixed.map((m) => m.clr)) : null,
    openings: marks.filter((m) => m.kind === 'bridge' && m.action === 'opening').length, locks: marks.filter((m) => m.kind === 'lock').length,
    waitMin: Math.round(marks.reduce((s, m) => s + (Number(m.waitMin) || 0), 0)), marks: marks.slice(0, 12), src: route?.src || 'plan',
  };
}
/** Effective km for pay: route km + waits at the inland service speed. */
export const effKm = (rs) => r1(rs.km + (rs.waitMin / 60) * INLAND.WAIT_KMH);

function base(type, from, extra) {
  return { id: nextJobId(), gen: JOB_GEN, type, family: type, title: '', from: from.id, to: null, legs: null, cargo: null, pax: 0,
    needs: {}, steps: [], window: { readyAt: 0, laycanTo: null, dueAt: 0 }, pay: { cr: 0, model: 'lump' }, hours: 0, ref: null,
    postedAt: 0, expiresAt: 0, contraband: false, inland: true, ...extra };
}
function finish(job, o, refCls, routeH) {
  const margin = INLAND.MARGIN[0] + o.rnd() * (INLAND.MARGIN[1] - INLAND.MARGIN[0]);
  const ports = job.steps.filter((s) => ['load', 'discharge', 'board', 'land'].includes(s.k)).length * 0.5;
  job.hours = Math.max(INLAND.MIN_HOURS, Math.ceil((routeH + ports) * margin + INLAND.FIXED_H));
  job.ref = { cls: refCls, margin: Math.round(margin * 100) / 100 };
  job.postedAt = o.simTime; job.expiresAt = o.simTime + INLAND.TTL_H * 3600;
  job.window = { readyAt: o.simTime, laycanTo: null, dueAt: o.simTime + job.hours * 3600 };
  return job;
}
/** Plan from → to for a ship (lane A planInland or the stand-in); without a graph: great circle × 1.25, no objects. */
function plan(o, from, to, dims, air) {
  const lane = o.lane || stubLaneA();
  if (!o.graph) return { points: [[from.lat, from.lon], [to.lat, to.lon]], marks: [], warnings: [], km: r1(kmBetween(from, to) * 1.25), hours: (kmBetween(from, to) * 1.25) / INLAND.WAIT_KMH, src: 'gc' };
  try { return lane.planInland(o.graph, { lat: from.lat, lon: from.lon }, { lat: to.lat, lon: to.lon }, plannerShip(dims, air), o.simTime || 0); } catch { return null; }
}

/**
 * One inland job of `type` from `from` ({ id, name, lat, lon, cemt?, tier, tags? }), or null.
 * o = { rnd, simTime, ports: [endpoints], lane (loadLaneA/stubLaneA), graph, fit?: { cls, vessel } }
 */
export function generateInlandJob(from, type, o) {
  if (type === 'charter_day') return charterDay(from, o);
  if (type === 'lesson') return inlandLesson(from, o);
  if (!INLAND_FAMILIES[type] || !portTakes(from, type)) return null;
  const lane = o.lane || stubLaneA(), rnd = o.rnd;
  const cands = (o.ports || []).filter((p) => p.id !== from.id && portTakes(p, type)).map((p) => ({ p, d: kmBetween(from, p) })).filter((c) => c.d >= INLAND.MIN_KM && c.d <= INLAND.MAX_KM)
    .sort((a, b) => a.d - b.d || (a.p.id < b.p.id ? -1 : 1));
  for (let tries = 0; tries < 4 && cands.length; tries++) {
    const { p: to } = cands.splice(Math.floor(rnd() * cands.length), 1)[0];
    const cls = minClass(from.cemt || 'VII', to.cemt || 'VII');
    // the biggest barge of the class that has a route (bridges, locks and fairway limits on the way); the fitted ship only
    for (const refCls of (o.fit ? [o.fit.cls] : bargesForFamily(type, cls).slice(0, 4))) {
    const dims = shipDimsOf(refCls), u = unitsOf(refCls);
    // cargo
    let good, unit, qty, t;
    if (type === 'barge_container') { good = 'containers'; unit = 'teu'; qty = Math.max(10, Math.floor(U(rnd, 0.4, 1.0) * (o.fit ? u.teu : (BARGE_MODELS[refCls]?.units.teu || u.teu || 100)))); t = qty * 12; }
    else if (type === 'barge_tanker') { good = 'fuel'; unit = 't'; qty = Math.floor(U(rnd, 0.85, 1.0) * (o.fit ? u.t : BARGE_MODELS[refCls]?.capacity || u.t || 1000)); t = qty; }
    else { good = INLAND.BARGE_GOODS[Math.floor(rnd() * INLAND.BARGE_GOODS.length)]; unit = 't'; qty = Math.floor(U(rnd, 0.85, 1.0) * (BARGE_MODELS[refCls]?.capacity || u.t || 500)); t = toTonnes(good, qty); }
    if (!(qty > 0)) continue;
    const air = lane.bestAirDraft(refCls, { cargo: [{ good, qty: t }] });
    const route = plan(o, from, to, dims, air);
    if (!route) continue;
    const rs = routeSummary(route, minClass(cls, route.cemtMin || cls));
    const km = effKm(rs);
    const payCr = type === 'barge_container' ? Math.round(payBox({ teu: qty, km, size: 'minor' }) * INLAND.INLAND_MUL)
      : Math.round(payVoyage({ good, t, km, size: 'minor' }) * INLAND.INLAND_MUL);
    const what = type === 'barge_container' ? `${fmtN(qty)} TEU` : `${fmtN(t)} t ${CARGO[good]?.name?.toLowerCase() || good}`;
    const job = base(type, from, {
      to: to.id, title: `${what} by barge to ${to.name} (CEMT ${rs.cemt})`,
      cargo: { good, unit, qty, t }, needs: { handling: type === 'barge_container' ? ['box'] : type === 'barge_tanker' ? ['liquid:clean'] : ['bulk', 'breakbulk'], unit, qty, cemt: rs.cemt, maxNeed: rs.minFixedClr },
      steps: [step('load', from.id, { label: `Load at ${from.name}` }), step('sail', to.id, { km: rs.km, inland: true, label: `Inland passage to ${to.name} (${rs.openings} openings, ${rs.locks} locks)` }), step('discharge', to.id, { label: `Discharge at ${to.name}` })],
      pay: { cr: payCr, model: 'lump' }, seaKm: rs.km, route: rs, endpoints: { from: { lat: from.lat, lon: from.lon }, to: { lat: to.lat, lon: to.lon } },
    });
    return finish(job, o, refCls, rs.hours);
    }
  }
  return null;
}
function charterDay(from, o) {
  if (!(from.tier === 'marina' || from.tier === 'passant')) return null;
  const rnd = o.rnd;
  const cands = (o.ports || []).filter((p) => p.id !== from.id && portTakes(p, 'charter_day')).map((p) => ({ p, d: kmBetween(from, p) })).filter((c) => c.d >= 3 && c.d <= INLAND.CHARTER_MAX_KM).sort((a, b) => a.d - b.d || (a.p.id < b.p.id ? -1 : 1));
  if (!cands.length) return null;
  const to = cands[Math.floor(rnd() * cands.length)].p;
  const refCls = o.fit?.cls || 'myacht', cap = Math.min(12, unitsOf(refCls).pax || 8);
  if (cap < 2) return null;
  const guests = I(rnd, 2, Math.min(8, cap)), rate = Math.round(U(rnd, ...INLAND.CHARTER_RATE) / 10) * 10;
  const lane = o.lane || stubLaneA();
  const route = plan(o, from, to, shipDimsOf(refCls), lane.bestAirDraft(refCls, {}));
  if (!route) return null;
  const rs = routeSummary(route, null);
  const job = base('charter_day', from, {
    to: to.id, title: `Day charter: ${guests} guests from ${from.name} to ${to.name}`, pax: guests, needs: { unit: 'pax', qty: guests, paxCert: guests > 12, maxNeed: rs.minFixedClr },
    steps: [step('board', from.id, { label: 'Guests board' }), step('sail', to.id, { km: rs.km, inland: true, comfort: true, label: `Cruise to ${to.name}` }), step('land', to.id, { label: 'Guests land' })],
    pay: { cr: Math.round(guests * rate + guests * rs.km * INLAND.CHARTER_KM_CR), rate, bonus: { kind: 'tip', cr: Math.round(guests * rate * PAY.DAYCHARTER_TIP_MAX) }, model: 'lump' }, route: rs,
  });
  return finish(job, o, refCls, rs.hours);
}
function inlandLesson(from, o) {
  if (from.tier !== 'marina') return null;
  const rnd = o.rnd, level = rnd() < 0.6 ? 1 : 2, sail = !o.fit || isSail(o.fit.cls);
  const students = I(rnd, 1, o.fit ? Math.max(1, Math.min(4, unitsOf(o.fit.cls).pax - 1)) : 4);
  const pool = [...Object.entries(INLAND_LESSON_TASKS), ...Object.entries(LESSON_TASKS).filter(([k, t]) => t.min <= level && (sail || !t.stat) && ['tack', 'gybe', 'mob'].includes(k))];
  const k = Math.min(pool.length, I(rnd, 2, 4)), bag = [...pool], tasks = [];
  // every inland lesson has at least one inland task
  tasks.push(bag.splice(Math.floor(rnd() * 3), 1)[0]);
  while (tasks.length < k) tasks.push(bag.splice(Math.floor(rnd() * bag.length), 1)[0]);
  const steps = [step('board', from.id, { label: `${students} student${students > 1 ? 's' : ''} board` })];
  for (const [id, t] of tasks) { const n = I(rnd, t.n[0], t.n[1]); steps.push(step('drill', null, { count: n, stat: t.stat, action: t.action, optional: true, task: id, estH: id === 'lock' ? 0.75 : id === 'bridge' ? 0.4 : 0.15 * n, label: `${t.label}${n > 1 ? ` × ${n}` : ''}` })); }
  steps.push(step('land', from.id, { afterSea: true, label: 'Back alongside' }));
  const job = base('lesson', from, {
    to: from.id, title: `Inland ${sail ? 'sailing' : 'boating'} lesson, Level ${level}: ${students} student${students > 1 ? 's' : ''}`, pax: students, level,
    needs: { level, maxWindKn: lessonWindKn(level), unit: 'pax', qty: students + 1, ...(sail ? { sail: true } : {}) }, steps,
    pay: { cr: payLesson({ level, students }), bonus: { kind: 'tasks', cr: payLesson({ level, students, allTasks: true }) - payLesson({ level, students }) }, model: 'lump' },
  });
  return finish(job, o, o.fit?.cls || 'sloop', steps.reduce((s, x) => s + (x.estH || 0), 0));
}

/**
 * A minor harbour's board (§7.6): marinas ≤ 4 (day charters A→B, inland lessons), passant ≤ 2, inland ports ≤ 6 barge jobs.
 */
export function boardFor(h, o) {
  const n = { marina: 4, passant: 2, inland_port: 6 }[h.tier] || 0, out = [];
  if (!n) return out;
  const fams = h.tier === 'inland_port' ? ['barge_bulk', 'barge_container', 'barge_tanker'].filter((t) => portTakes(h, t)) : h.tier === 'marina' ? ['charter_day', 'lesson'] : ['charter_day'];
  for (let guard = 0; out.length < n && guard < n * 4 && fams.length; guard++) {
    const j = generateInlandJob(h, fams[guard % fams.length], o);
    if (j) out.push(j);
  }
  return out;
}

/**
 * Eligibility (§7.6): canDo + the family's hull, the CEMT class of the route and the air draught under its fixed bridges
 * (best case: folded, ballasted, with this job's cargo). With ctx.graph the route is re-planned for this ship and must exist.
 * ctx = canDo ctx + { lane, graph }. → { ok, why, all }
 */
export function inlandCanDo(job, vessel, ctx = {}) {
  const base0 = canDo(job, vessel, ctx), all = [...base0.all];
  const cls = vessel?.ship?.cls ?? vessel?.cls;
  const mk = (code, text, extra = {}) => ({ code, text, ...extra });
  const fam = INLAND_FAMILIES[job?.type];
  if (cls && fam && !all.some((r) => r.code === 'handling')) { const f = fam.fit(cls); if (f) all.unshift(mk('handling', f[0].toUpperCase() + f.slice(1))); }
  if (cls && job?.inland) {
    const d = shipDimsOf(cls), lane = ctx.lane || stubLaneA();
    const cemt = job.needs?.cemt;
    if (cemt && CEMT[cemt] && !fitsCemt(cemt, d.L, d.B, d.T)) {
      const c = CEMT[cemt];
      all.push(mk('cemt', `Waterway CEMT ${cemt} (${c.L} × ${c.B} m, ${c.T} m); you are ${r1(d.L)} × ${r1(d.B)} m, ${r1(d.T)} m`, { cemt }));
    }
    const cargo = job.cargo ? [{ good: job.cargo.good, qty: job.cargo.t }] : [];
    let air = null; try { air = lane.bestAirDraft(cls, { cargo }); } catch { air = null; }
    if (air && Number.isFinite(job.needs?.maxNeed) && air.need > job.needs.maxNeed + 1e-9) {
      all.push(mk('air', `Fixed bridges on the route clear ${job.needs.maxNeed.toFixed(1)} m; you need ${air.need.toFixed(1)} m`, { need: air.need, clr: job.needs.maxNeed }));
    }
    if (ctx.graph && job.endpoints && !all.some((r) => r.code === 'cemt' || r.code === 'air')) {
      const ps = plannerShip(d, air);
      let route = null; try { route = lane.planInland(ctx.graph, job.endpoints.from, job.endpoints.to, ps, ctx.simTime || 0); } catch { route = null; }
      if (!route) {
        const b = lane.explain ? lane.explain(ctx.graph, job.endpoints.from, job.endpoints.to, ps) : null;
        all.push(mk('route', b ? `No inland route for you: ${b.name} (${b.why})` : 'No inland route for your ship', { blocked: b }));
      }
    }
  }
  for (const r of all) if (!r.text) r.text = reasonText(r);
  return { ok: all.length === 0, why: all[0] || null, all };
}

