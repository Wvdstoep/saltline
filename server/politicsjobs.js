// Diplomatic contract types (docs/WORLD-POLITICS-CONTRACT.md §4.12): aid, corridor, state, avoid, evac.
// Pure generators: diplomaticJobs(ds, harbor, simTime, rnd, env) → Job[] (0–2 per regen), only where the dataset
// defines a programme or a need. The jobs reuse the existing delivery mechanics (cargo or passengers).
//
// env (all optional): { harbors: [...], nextJobId(), rateJob(job, simTime, rnd), seaKm(fromId, toId),
//   avoidKm(fromId, toId, areaIds), riskOf(fromId, toId) → { tier, areas } }
// Phase 2 passes economy.js's nextJobId and an exported rateJob; without them a local id and a simple board TTL are used.
import { haversine } from '../shared/geo.js';
import { GOODS } from '../shared/constants.js';
import { POL, harborOf, portStatus, isActive, areasAt, riskPay } from '../shared/politics.js';

export const DIPLO = {
  MAX_PER_REGEN: 2, AID_RANGE_KM: 5000, STATE_RANGE_KM: 6000, PAY_PER_T_KM: 0.08, DETOUR: 1.25,
  AID_MUL: 1.1, STATE_MUL: 1.25, EVAC_MUL: 3, EVAC_WINDOW_H: 24, BOARD_TTL_H: 24,
  P_AID: 0.35, P_CORRIDOR: 0.6, P_STATE: 0.3, P_AVOID: 0.4, P_EVAC: 0.5,
};
let localSeq = 0;
const r1 = (x) => Math.round(x * 10) / 10;
const kmBetween = (a, b) => haversine(a.lat, a.lon, b.lat, b.lon) / 1000;
function seaKm(env, a, b) { let km = null; try { km = env.seaKm ? env.seaKm(a.id, b.id) : null; } catch { km = null; } return Number.isFinite(km) && km > 0 ? r1(km) : r1(kmBetween(a, b) * DIPLO.DETOUR); }
function stamp(job, simTime, rnd, env) {
  if (env.rateJob) return env.rateJob(job, simTime, rnd);
  const kn = 12, km = job.seaKm || job.distKm || 100;
  job.hours = Math.ceil((km / (kn * 1.852)) * 1.5 + 6);
  job.postedAt = simTime; job.expiresAt = simTime + DIPLO.BOARD_TTL_H * 3600;
  return job;
}
const idOf = (env) => (env.nextJobId ? env.nextJobId() : `jp${(localSeq++).toString(36)}`);
const freightPay = (qty, km) => Math.round(qty * km * DIPLO.PAY_PER_T_KM + 800);
const pick = (list, rnd) => list[Math.floor(rnd() * list.length) % list.length];
function tierAt(ds, h, simTime) { return Math.max(0, ...areasAt(ds, h.lat, h.lon, ['war_risk'], simTime).map((a) => a.tier)); }
function srcNote(ds, rec) { const s = ds.sources[(rec?.src || [])[0]]; return s ? `${s.short || s.publisher}, ${rec.asOf || s.published}` : ''; }

export function diplomaticJobs(ds, harbor, simTime, rnd, env = {}) {
  const h = harborOf(ds, harbor); if (!h) return [];
  const all = env.harbors || Object.values(ds.harbors);
  const out = [];
  const push = (j) => { if (j && out.length < DIPLO.MAX_PER_REGEN) out.push(stamp(j, simTime, rnd, env)); };
  const open = (x) => portStatus(ds, x).value !== 'closed';
  const po = ds.ports[h.id] || {};

  // corridor: grain-corridor runs from a programme port to the programme's destination list
  for (const pid of po.programmes || []) {
    const prog = ds.agreements.find((a) => a.id === pid && a.kind === 'cooperation' && isActive(a, simTime))?.programme;
    if (!prog || rnd() >= DIPLO.P_CORRIDOR) continue;
    const dests = (prog.destinations || []).map((id) => harborOf(ds, id)).filter((x) => x && open(x));
    if (!dests.length) continue;
    const to = pick(dests, rnd), qty = Math.round((2500 + rnd() * 17500) / 500) * 500, km = seaKm(env, h, to);
    push({ id: idOf(env), type: 'corridor', from: h.id, to: to.id, good: prog.good || 'grain', qty, contraband: false, distKm: Math.round(kmBetween(h, to)), seaKm: km,
      pay: riskPay(freightPay(qty, km), 4), title: `Grain corridor: ${qty.toLocaleString('en-US')} t ${GOODS[prog.good || 'grain'].name.toLowerCase()} ${h.name} → ${to.name} (corridor, clearance required)`,
      pol: { tier: 4, programme: pid, refundPremium: true } });
  }
  // aid: humanitarian cargo to ports with a dated, sourced need, offered at major/mega ports within range
  if (['major', 'mega'].includes(h.size) && rnd() < DIPLO.P_AID) {
    const needs = Object.entries(ds.ports).filter(([id, p]) => p.needs && isActive(p.needs, simTime) && id !== h.id).map(([id, p]) => ({ to: harborOf(ds, id), need: p.needs })).filter((x) => x.to && open(x.to) && kmBetween(h, x.to) <= DIPLO.AID_RANGE_KM);
    if (needs.length) {
      const { to, need } = pick(needs, rnd), good = pick(need.goods || ['grain', 'supplies'], rnd), qty = Math.round((250 + rnd() * 2250) / 50) * 50, km = seaKm(env, h, to);
      const tier = tierAt(ds, to, simTime);
      push({ id: idOf(env), type: 'aid', from: h.id, to: to.id, good, qty, contraband: false, distKm: Math.round(kmBetween(h, to)), seaKm: km,
        pay: Math.round(riskPay(freightPay(qty, km), tier) * DIPLO.AID_MUL), title: `Humanitarian cargo: ${qty.toLocaleString('en-US')} t ${GOODS[good].name.toLowerCase()} to ${to.name} (needs listed by ${srcNote(ds, need)})`,
        pol: { tier, refundPremium: tier > 0 } });
    }
  }
  // state charter: the country's top export good to its top partner within range (needs standing ≥ charterMin)
  const flows = ds.trade?.flows?.[h.country];
  if (flows && ['major', 'mega'].includes(h.size) && rnd() < DIPLO.P_STATE) {
    const goods = Object.entries(flows).filter(([g, f]) => GOODS[g] && !GOODS[g].contraband && f.exp > 0 && (f.top || []).length).sort((a, b) => b[1].exp - a[1].exp);
    if (goods.length) {
      const [good, f] = goods[0];
      let to = null;
      for (const [cc] of f.top) { to = all.filter((x) => x.country === cc && open(x) && ['major', 'mega'].includes(x.size) && kmBetween(h, x) <= DIPLO.STATE_RANGE_KM).sort((a, b) => kmBetween(h, a) - kmBetween(h, b))[0]; if (to) break; }
      if (to) {
        const qty = Math.round((2000 + rnd() * 8000) / 500) * 500, km = seaKm(env, h, to);
        push({ id: idOf(env), type: 'state', from: h.id, to: to.id, good, qty, contraband: false, distKm: Math.round(kmBetween(h, to)), seaKm: km,
          pay: Math.round(freightPay(qty, km) * DIPLO.STATE_MUL), title: `State charter: ${qty.toLocaleString('en-US')} t ${GOODS[good].name.toLowerCase()} to ${to.name} for ${ds.countries[h.country]?.name || h.country}`,
          pol: { needs: { rep: { cc: h.country, min: POL.REP.charterMin } } } });
      }
    }
  }
  // avoid: freight whose direct route crosses a tier ≥ 3 area, paid on the avoiding route's km
  if (env.riskOf && rnd() < DIPLO.P_AVOID) {
    const cands = all.filter((x) => x.id !== h.id && open(x) && ['major', 'mega'].includes(x.size)).map((x) => ({ x, r: env.riskOf(h.id, x.id) }))
      .filter(({ x, r }) => r && r.tier >= 3 && tierAt(ds, x, simTime) < 3 && tierAt(ds, h, simTime) < 3);
    if (cands.length) {
      const { x: to, r } = pick(cands, rnd), must = r.areas.filter((id) => ds.areaById[id]?.kind === 'war_risk' && ds.areaById[id].tier >= 3);
      const good = pick(['containers', 'machinery', 'steel', 'grain'], rnd), qty = [900, 1800, 3600, 8000][Math.floor(rnd() * 4)];
      let km = null; try { km = env.avoidKm ? env.avoidKm(h.id, to.id, must) : null; } catch { km = null; }
      if (!(km > 0)) km = seaKm(env, h, to) * 1.6;
      push({ id: idOf(env), type: 'avoid', from: h.id, to: to.id, good, qty, contraband: false, distKm: Math.round(kmBetween(h, to)), seaKm: r1(km),
        pay: freightPay(qty, km), title: `Freight ${qty.toLocaleString('en-US')} t of ${GOODS[good].name} to ${to.name} — avoid ${must.map((id) => ds.areaById[id].name).join(', ')}`,
        pol: { mustAvoid: must, tier: 0 } });
    }
  }
  // evac: assisted departure only where a dated source marks one
  if (po.evacuation && isActive(po.evacuation, simTime) && rnd() < DIPLO.P_EVAC) {
    const dests = all.filter((x) => x.id !== h.id && open(x) && tierAt(ds, x, simTime) === 0).sort((a, b) => kmBetween(h, a) - kmBetween(h, b)).slice(0, 3);
    if (dests.length) {
      const to = pick(dests, rnd), pax = Math.round(50 + rnd() * 350), km = seaKm(env, h, to);
      push({ id: idOf(env), type: 'evac', from: h.id, to: to.id, pax, contraband: false, distKm: Math.round(kmBetween(h, to)), seaKm: km, needsPax: true,
        pay: Math.round(pax * (25 + km * 0.35) * DIPLO.EVAC_MUL), title: `Assisted departure: ${pax} passengers ${h.name} → ${to.name} (${srcNote(ds, po.evacuation)})`,
        windowH: DIPLO.EVAC_WINDOW_H, pol: { tier: tierAt(ds, h, simTime) } });
    }
  }
  return out;
}
