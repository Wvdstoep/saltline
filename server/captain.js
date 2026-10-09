// v6 hired captains (docs/V6-FLEET-CONTRACTS.md §7). A captain sails every active ship her owner is not aboard, through
// the ship's actor (server/vessel.js makeActor): departures (route plan, weather, hull, fuel, bills), the voyage (the
// offline-voyage stepper in ≤ 0.5 s substeps, give way, storm re-plans), arrivals (harbour tugs, else the pilot to a free
// berth), contracts (freight, passengers, charters, fishing, supply, a tow already on the line), holding safely at a
// safe spot, and the order of the day. Everything that touches money or the ship runs the game's own methods.
// State: v.cap (saved, §7.3) + fleet.rtOf(v) (runtime: the plan in flight, timers).
import { SHIP_CLASSES, INTERACT } from '../shared/constants.js';
import { haversine, bearing, destination, angleDiff } from '../shared/geo.js';
import { FLEET, accrueWage, wageRateMcrH } from '../shared/fleet.js';
import { serviceKn, serviceBurnTph } from '../shared/rates.js';
import { findSafeSpot, harbourAim, separation } from './safespot.js';
import { landOnLeg } from './searoute.js';
import { cargoMass } from './economy.js';
import { harborById, FISHING_GROUNDS } from './harbors.js';
import { throttleCap, stormOnRoute } from '../public/js/pilotcore.js';
import { rigOf } from '../shared/sail/rigs.js';                              // sailing (docs/SAILING-CONTRACT.md §3.5)
import { anyHoisted, applyRigCommand, settleRig } from '../shared/sail/state.js';

const clsOf = (c) => SHIP_CLASSES[c] || SHIP_CLASSES.coaster;
const short = (name) => String(name || '').split(' (')[0];
const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
const r1 = (v) => Math.round(v * 10) / 10;
const r5 = (v) => Math.round(v * 1e5) / 1e5;
const capital = (s) => { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); };
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compass = (b) => COMPASS[Math.round((((b % 360) + 360) % 360) / 45) % 8];
const AT_SEA_MOVING = new Set(['sailing', 'fishing']);

/** A fresh captain state (§7.3). */
export function newCap(g, phase = 'idle', extra = {}) {
  return { phase, why: null, since: Math.floor(g.simTime), target: null, route: null, routeKm: null, etaS: null, tries: 0, nextAt: 0, holdAt: null, jobId: null, stormIds: {}, ...extra };
}
/** Wage duty (§7.3 step 2): 'off' moored without orders (or stopped by a failure) and laid up; 'underway' when the
 *  engine turns or she makes way; 'duty' otherwise (anchored, waiting, planning, under tugs). */
export function dutyOf(v) {
  if (v.status === 'laidup') return 'off';
  if (v.assist) return 'duty';
  const ph = v.cap ? v.cap.phase : 'idle';
  if (v.docked && (!v.orders || ph === 'idle' || ph === 'failed')) return 'off';
  const s = v.ship;
  if (Math.abs(s.throttle || 0) > 0.03 || Math.abs(s.spd || 0) > 0.5) return 'underway';
  return 'duty';
}

// ------------------------------------------------------------------------------------------------ orders
/** Give vessel v an order (already validated by normalizeOrder and the fleet's checks). null = idle (moored) / hold (at sea). */
export function setOrder(fleet, v, order) {
  const g = fleet.game, rt = fleet.rtOf(v);
  rt.gen++; rt.plan = null; rt.pending = null; rt.tgt = null; rt.gwUntil = 0; rt.stopUntil = 0; rt.stopSince = 0;
  if (order && order.type === 'stop') order = v.docked ? null : { type: 'hold' };
  if (order && order.type === 'hold' && order.lat == null && v.docked) order = null; // moored is already safe
  if (!order && !v.docked) order = { type: 'hold' };                                 // never drifting
  v.orders = order || null;
  if (v.assist) { v.cap = newCap(g, 'arriving', { target: v.cap ? v.cap.target : null }); return; } // the tugs finish first
  v.cap = newCap(g, 'idle');
  if (!v.docked) {
    v.voyage = null;
    if (v.orders.type === 'route') beginAtSea(fleet, v); // her own waypoints: no planning, she sails on at once
  }
}
export function orderText(fleet, v, o) {
  if (!o) return 'no orders';
  const home = harborById(fleet.ownerOf(v)?.office?.home);
  switch (o.type) {
    case 'sail_to': return `sail to ${short(harborById(o.harbor)?.name)}${o.then === 'lay_up' ? ' and lay up' : o.then === 'hold' ? ' and anchor off' : ''}`;
    case 'home': return `return home to ${short(home?.name)}${o.then === 'lay_up' ? ' and lay up' : ''}`;
    case 'hold': return o.lat != null ? `hold position at ${o.lat.toFixed(2)}, ${o.lon.toFixed(2)}` : 'hold position here';
    case 'route': return `follow the route${o.harbor ? ` to ${short(harborById(o.harbor)?.name)}` : ''} (${o.route.length} waypoint${o.route.length > 1 ? 's' : ''})`;
    case 'contract': { const j = o.jobId && v.jobs.find((x) => x.id === o.jobId); return j ? `deliver ${j.title}` : 'work through her contracts'; }
    default: return 'stop';
  }
}
/** What the ship you just left does, for the switch event. */
export function leaveText(fleet, v) {
  const o = v.orders;
  if (!o) return v.docked ? `stays moored at ${short(harborById(v.docked)?.name)}` : 'waits for orders';
  switch (o.type) {
    case 'hold': return 'holds position under her captain';
    case 'sail_to': return `sails on to ${short(harborById(o.harbor)?.name)} under her captain`;
    case 'home': return 'sails home under her captain';
    case 'route': return `follows your route${o.harbor ? ` to ${short(harborById(o.harbor)?.name)}` : ''} under her captain`;
    case 'contract': return v.fishing ? 'keeps fishing under her captain' : 'carries on with her contracts under her captain';
    default: return 'waits for orders';
  }
}

// ------------------------------------------------------------------------------------------------ the step
/** §7.3: one step of world time `dt` (s) for a captained vessel. */
const PILOT_KN = 5, PILOT_ACCEL_KN_S = 0.1;   // the harbour pilot's speed inside a patch and how fast she gathers way
const FAR_SUBSTEP_S = 1;   // substep for ships no online skipper is near (shared/fleet.js is frozen, so it lives here)
export function stepVessel(fleet, v, dt) {
  if (!v || v.status !== 'active' || !(dt > 0)) return;
  const g = fleet.game, a = fleet.actorOf(v), p = fleet.ownerOf(v);
  if (!v.cap) v.cap = newCap(g, 'idle');
  g.advanceShipClock(a, dt);
  if (p && p.office) {
    const cr = accrueWage(v.pay, wageRateMcrH(v.ship.cls, dutyOf(v), !!v.towing), dt * 1000);
    if (cr > 0) fleet.charge(p, v.id, 'wages', cr);
  }
  if (v.assist) {
    a._cat = 'port'; try { g.stepAssist(a, dt); } finally { a._cat = null; }   // the dues when the tugs put her alongside
    if (v.docked) { fleet.rtOf(v).tugsUntil = Date.now() + 300000; onArrived(fleet, v); }
    return;
  }
  if (v.docked) return stepDocked(fleet, v);
  if (v.flooding >= 1) return fleet.sinkVessel(v);
  stepSea(fleet, v, dt);
}

function stepDocked(fleet, v) {
  const g = fleet.game, cap = v.cap, now = g.simTime, rt = fleet.rtOf(v);
  if (!v.orders) { if (cap.phase !== 'idle') v.cap = newCap(g, 'idle'); return; }
  if (rt.pending || cap.nextAt > now) return;
  const tgt = targetFor(fleet, v);
  if (tgt.done) return finishOrder(fleet, v);
  if (tgt.fail) return fail(fleet, v, tgt.fail);
  if (tgt.here) return arrivedHere(fleet, v, tgt);
  if (!rt.plan || !sameTarget(rt.plan.target, tgt) || now - rt.plan.at > 3600) {
    rt.plan = null;
    requestPlan(fleet, v, tgt);
    if (!rt.plan) return;                      // in flight (or waiting for the navigator)
  }
  if (rt.plan.fail) return planFailed(fleet, v, rt.plan);
  if (departureBlocked(fleet, v, rt.plan)) return;
  castOff(fleet, v, rt.plan);
}

function stepSea(fleet, v, dt) {
  const g = fleet.game, cap = v.cap, a = fleet.actorOf(v), rt = fleet.rtOf(v), now = g.simTime;
  ownerAway(fleet, v);
  switch (cap.phase) {
    case 'idle': holdStill(v); beginAtSea(fleet, v); break;
    case 'failed': holdStill(v); if (cap.nextAt <= now) beginAtSea(fleet, v); break;
    case 'planning': case 'waiting':
      holdStill(v);
      if (rt.pending) break;
      if (rt.plan) { const plan = rt.plan; rt.plan = null; if (plan.fail) planFailed(fleet, v, plan); else startLeg(fleet, v, plan.points, plan.target, plan.distM); }
      else if (cap.nextAt <= now) beginAtSea(fleet, v);
      break;
    case 'sailing': case 'fishing': sail(fleet, v, dt); break;
    case 'arriving': { const h = harborById(cap.target && cap.target.harbor); if (h) return pilotFallback(fleet, v, h); cap.phase = 'idle'; break; }
    case 'transfer': holdStill(v); transferStep(fleet, v); break;
    case 'anchored': holdStill(v); break;
    case 'holding': holdStill(v, FLEET.HOLD_THROTTLE); break;
    default: cap.phase = 'idle';
  }
  if (v.docked || v.assist || !fleet.vessels.has(v.id)) return;
  g.stepAtSea(a, dt / 3600);                   // fuel, wear, flooding/pumps, catch, tow hand-over (§11.2)
  if (!fleet.vessels.has(v.id) || v.docked) return;
  afterMove(fleet, v);
}

/** §7.3 step 6: checks after moving, in order. */
function afterMove(fleet, v) {
  const g = fleet.game, cap = v.cap, a = fleet.actorOf(v), s = v.ship, C = clsOf(s.cls);
  const end = v.voyageEnd; v.voyageEnd = null;
  if (!(v.fuel > 0) && !C.sail) {
    a._cat = ['tugs', 'port']; try { g.tow(a); } finally { a._cat = null; }
    if (v.docked) { v.voyage = null; v.cap = newCap(g, 'idle'); fleet.rtOf(v).plan = null; fleet.note(v, 'warn', 'out of fuel — towed in. She carries on from here once bunkered.'); }
    return;
  }
  if (v.cond < FLEET.ABORT_COND && !(cap.target && cap.target.kind === 'harbor') && cap.phase !== 'arriving') {
    const { harbor } = g.nearestHarbor(s.lat, s.lon);
    if (harbor) {
      setOrder(fleet, v, { type: 'sail_to', harbor: harbor.id, then: 'moor' });
      fleet.note(v, 'warn', `hull at ${Math.round(v.cond)} % — making for ${short(harbor.name)} for repairs.`);
      return;
    }
  }
  if (cap.phase === 'sailing') arrivalTest(fleet, v, end);
  else if (cap.phase === 'fishing') fishingTest(fleet, v, end);
  if (end === 'shoal' && fleet.vessels.has(v.id) && !v.docked && AT_SEA_MOVING.has(v.cap.phase)) {
    v.cap.tries = (v.cap.tries || 0) + 1;
    const tgt = fleet.rtOf(v).tgt;
    if (tgt && v.cap.tries <= FLEET.REPLAN_TRIES) { requestPlan(fleet, v, tgt); }
    else { setOrder(fleet, v, { type: 'hold' }); fleet.note(v, 'warn', 'shoal water ahead on her course — she holds here. Give her new orders.'); }
  }
}

// ------------------------------------------------------------------------------------------------ targets
/** What the current order wants now: {kind, lat, lon, harbor?, then?, jobId?} | {here} | {done} | {fail}. */
function targetFor(fleet, v) {
  const o = v.orders, p = fleet.ownerOf(v);
  if (!o) return { done: true };
  switch (o.type) {
    case 'home': return harbourTarget(fleet, v, p && p.office ? p.office.home : null, o.then);
    case 'sail_to': return harbourTarget(fleet, v, o.harbor, o.then);
    case 'hold': return { kind: 'spot', aim: o.lat != null ? { lat: o.lat, lon: o.lon } : { lat: v.ship.lat, lon: v.ship.lon }, lat: o.lat ?? v.ship.lat, lon: o.lon ?? v.ship.lon };
    case 'route': {
      const last = o.route[o.route.length - 1], h = o.harbor ? harborById(o.harbor) : null;
      if (h && v.docked === h.id) return { here: true, harbor: h.id, then: o.then };
      return { kind: h ? 'harbor' : 'route', harbor: h ? h.id : undefined, name: h ? short(h.name) : null, lat: last[0], lon: last[1], then: o.then, points: o.route };
    }
    case 'contract': return contractTarget(fleet, v);
    default: return { done: true };
  }
}
function harbourTarget(fleet, v, hid, then) {
  const h = harborById(hid);
  if (!h) return { fail: 'That harbour is not on the chart.' };
  const a = fleet.game.harborAnchor(h);
  if (v.docked === h.id) {
    if (then !== 'hold') return { here: true, harbor: h.id, then };
    const aim = approachOf(fleet, h);
    return { kind: 'spot', aim, lat: aim.lat, lon: aim.lon };
  }
  return { kind: 'harbor', harbor: h.id, name: short(h.name), lat: a.lat, lon: a.lon, then };
}
function contractTarget(fleet, v) {
  const o = v.orders;
  const list = v.jobs.filter((j) => j && (o.jobId == null || j.id === o.jobId));
  if (!list.length) return { done: true };
  let best = null;
  for (const j of list) {
    const t = jobTarget(fleet, v, j);
    if (t.fail) { if (!best) best = t; continue; }
    const km = t.here ? 0 : haversine(v.ship.lat, v.ship.lon, t.lat, t.lon) / 1000;
    if (!best || best.fail || km < best.km) best = { ...t, km, jobId: j.id };
  }
  return best;
}
function fishHave(v) { return v.cargo.filter((c) => c.good === 'fish' && c.caught && !c.jobId).reduce((s, c) => s + c.qty, 0); }
function jobTarget(fleet, v, j) {
  const g = fleet.game, s = v.ship;
  const toHarbour = () => {
    const h = harborById(j.to); if (!h) return { fail: `${j.title}: the destination is not on the chart.` };
    if (v.docked === h.id) return { here: true, harbor: h.id, jobId: j.id };
    const a = g.harborAnchor(h);
    return { kind: 'harbor', harbor: h.id, name: short(h.name), lat: a.lat, lon: a.lon, jobId: j.id };
  };
  switch (j.type) {
    case 'tow': return v.towing === j.id ? toHarbour() : { fail: 'Captains do not take tows — sail her yourself.' };
    case 'fishing': {
      const C = clsOf(s.cls), have = fishHave(v), free = C.capacity - cargoMass(v.cargo);
      if (j.capHaul || have >= j.qty || free <= 0.05) return toHarbour();
      const gr = FISHING_GROUNDS.find((x) => x.id === j.ground) || (j.groundName && FISHING_GROUNDS.find((x) => x.name === j.groundName));
      if (!gr) return { fail: `${j.title}: no fishing ground on the chart.` };
      const R = gr.radiusKm * 1000, from = haversine(gr.lat, gr.lon, s.lat, s.lon);
      const pt = from < 1 ? { lat: gr.lat, lon: gr.lon } : destination(gr.lat, gr.lon, bearing(gr.lat, gr.lon, s.lat, s.lon), Math.min(from, 0.6 * R));
      return { kind: 'ground', ground: gr.id, name: gr.name, lat: pt.lat, lon: pt.lon, jobId: j.id };
    }
    case 'supply': {
      if (!j.at || !Number.isFinite(j.at.lat)) return toHarbour();
      const off = destination(j.at.lat, j.at.lon, bearing(j.at.lat, j.at.lon, s.lat, s.lon), 300);
      return { kind: 'platform', name: j.platformName || 'the platform', lat: off.lat, lon: off.lon, jobId: j.id };
    }
    default: return j.contraband ? { fail: 'No captain will carry that.' } : toHarbour();
  }
}
function sameTarget(a, b) { return !!a && !!b && a.kind === b.kind && a.harbor === b.harbor && Math.abs(a.lat - b.lat) < 1e-4 && Math.abs(a.lon - b.lon) < 1e-4; }
function targetWire(t) { return t ? { harbor: t.harbor || undefined, lat: r5(t.lat), lon: r5(t.lon), kind: t.kind === 'route' ? 'route' : t.kind, name: t.name || undefined } : null; }
function approachOf(fleet, h) {
  const g = fleet.game, anchor = g.harborAnchor(h), geom = g.harborGeom ? g.harborGeom(h.id) : null;
  try { return harbourAim({ anchor, fairway: geom && geom.fairway, depthLW: (a, b) => g.depthAtLowWater(a, b) }); } catch { return { lat: anchor.lat, lon: anchor.lon }; }
}

/** Docked at the order's harbour already (sail_to here, a contract ending here). */
function arrivedHere(fleet, v, tgt) {
  const g = fleet.game, a = fleet.actorOf(v);
  if (tgt.jobId) {
    const h = harborById(v.docked), j = v.jobs.find((x) => x.id === tgt.jobId);
    if (j) {
      const n = g.deliverJobs(a, h);
      if (n) { g.sendYou(a); return; }
      return fail(fleet, v, `${j.title}: ${typeof g.whyNotDeliverable === 'function' ? g.whyNotDeliverable(a, j) : 'not deliverable here.'}`);
    }
    return;
  }
  onArrived(fleet, v);
}
function finishOrder(fleet, v) {
  const g = fleet.game, o = v.orders, p = fleet.ownerOf(v);
  if (o && o.type === 'contract') {
    if (o.then === 'home' && p && p.office.home !== v.docked) { fleet.note(v, 'info', 'contracts done — sailing home.'); return setOrder(fleet, v, { type: 'home', then: 'moor' }); }
    fleet.note(v, 'info', v.docked ? `contracts done — moored at ${short(harborById(v.docked)?.name)}, waiting for orders.` : 'contracts done — waiting for orders.');
  }
  if (v.docked) { v.orders = null; v.cap = newCap(g, 'idle'); }
  else setOrder(fleet, v, { type: 'hold' });
}
/** §7.5 onArrived: alongside (tugs, pilot, legacy dock or a tow). finishDock already delivered and charged. */
export function onArrived(fleet, v) {
  const g = fleet.game, o = v.orders, p = fleet.ownerOf(v);
  v.voyage = null; v.voyageEnd = null;
  const rt = fleet.rtOf(v); rt.plan = null; rt.tgt = null;
  v.cap = newCap(g, 'idle');
  if (!o || !v.docked) return;
  if (o.type === 'contract') return;            // the docked step picks the next contract or finishes
  const done = (o.type === 'sail_to' && o.harbor === v.docked) || (o.type === 'home' && p && p.office.home === v.docked) || (o.type === 'route' && (!o.harbor || o.harbor === v.docked));
  if (!done) return;                             // towed or diverted in elsewhere: the order stands and she re-plans from here
  if (o.then === 'lay_up' && p) {
    v.orders = null;
    const why = fleet.layUpVessel(p, v);
    if (why) fleet.note(v, 'warn', `not laid up: ${why}`);
    return;
  }
  v.orders = null;
}

// ------------------------------------------------------------------------------------------------ planning and departure
function requestPlan(fleet, v, tgt) {
  const g = fleet.game, rt = fleet.rtOf(v), cap = v.cap, now = g.simTime, C = clsOf(v.ship.cls);
  const log = (fleet.planLog.get(v.ownerId) || []).filter((t) => now - t < 60 && t <= now);
  if (log.length >= FLEET.PLANS_PER_MIN) { fleet.planLog.set(v.ownerId, log); return wait(fleet, v, 'waiting for the navigator', FLEET.PLAN_RETRY_S, true); }
  const planner = g.routePlanner;
  if (planner && typeof planner.full === 'function' && planner.full()) return wait(fleet, v, 'waiting for the navigator', FLEET.PLAN_RETRY_S, true);
  log.push(now); fleet.planLog.set(v.ownerId, log);
  rt.tgt = tgt;
  cap.phase = 'planning'; cap.why = null; cap.target = targetWire(tgt); cap.jobId = tgt.jobId || null;
  const from = { lat: v.ship.lat, lon: v.ship.lon };
  const to = { lat: tgt.lat, lon: tgt.lon };
  if (!planner) { rt.plan = directPlan(fleet, v, from, tgt); return; }
  const gen = rt.gen;
  const opts = { toHarbor: tgt.kind === 'harbor' ? tgt.harbor : undefined, draft: C.draft, beam: C.beam, length: C.length, avoid: tgt.avoid || stormsNear(g, from, to), simTime: now };
  let pr;
  try { pr = planner.plan(from, to, opts, { priority: 'high' }); } catch { pr = null; }
  rt.pending = Promise.resolve(pr).then((r) => {
    if (rt.gen !== gen) return;
    rt.pending = null;
    if (r && Array.isArray(r.points) && r.points.length) rt.plan = { points: r.points.map((q) => [q[0], q[1]]), distM: Number.isFinite(r.distM) ? r.distM : routeLenM(from, r.points), at: g.simTime, target: tgt };
    else rt.plan = { fail: true, busy: !!(planner.full && planner.full()), at: g.simTime, target: tgt };
  }, () => { if (rt.gen === gen) { rt.pending = null; rt.plan = { fail: true, at: g.simTime, target: tgt }; } });
}
/** No planner (tests, a server without the worker): one straight leg when it crosses no land. */
function directPlan(fleet, v, from, tgt) {
  const g = fleet.game, slackA = v.docked ? 3000 : 0, slackB = tgt.kind === 'harbor' ? 3000 : 0;
  const pts = tgt.points ? [[from.lat, from.lon], ...tgt.points] : [[from.lat, from.lon], [tgt.lat, tgt.lon]];
  let bad = 0;
  if (g.world) for (let i = 1; i < pts.length; i++) bad += landOnLeg(g.world, { lat: pts[i - 1][0], lon: pts[i - 1][1] }, { lat: pts[i][0], lon: pts[i][1] }, i === 1 ? slackA : 0, i === pts.length - 1 ? slackB : 0);
  if (bad) return { fail: true, at: g.simTime, target: tgt };
  return { points: pts.slice(1), distM: routeLenM(from, pts.slice(1)), at: g.simTime, target: tgt };
}
function stormsNear(g, from, to) {
  const storms = typeof g.stormsPublic === 'function' ? g.stormsPublic() : [];
  const mid = { lat: (from.lat + to.lat) / 2, lon: (from.lon + to.lon) / 2 }, half = haversine(from.lat, from.lon, to.lat, to.lon) / 2;
  return storms.filter((s) => s && s.intensity >= FLEET.DEPART_STORM && haversine(mid.lat, mid.lon, s.lat, s.lon) <= half + s.radiusKm * 1000 + 50000)
    .slice(0, 8).map((s) => ({ lat: s.lat, lon: s.lon, radiusM: s.radiusKm * 1000, name: s.name }));
}
function routeLenM(from, pts) { let d = 0, a = from; for (const q of pts) { d += haversine(a.lat, a.lon, q[0], q[1]); a = { lat: q[0], lon: q[1] }; } return d; }
function planFailed(fleet, v, plan) {
  const g = fleet.game, rt = fleet.rtOf(v), t = plan.target || {};
  rt.plan = null;
  if (plan.busy) return wait(fleet, v, 'waiting for the navigator', FLEET.PLAN_RETRY_S, true);
  const C = clsOf(v.ship.cls);
  const where = t.kind === 'harbor' ? short(harborById(t.harbor)?.name) : t.name || 'that position';
  const why = `No sea route found to ${where} for her ${C.draft} m draught.`;
  if (v.docked) return fail(fleet, v, why);
  v.cap.tries = (v.cap.tries || 0) + 1;
  if (v.cap.tries <= FLEET.REPLAN_TRIES) { v.cap.phase = 'waiting'; v.cap.why = 'waiting for the navigator'; v.cap.nextAt = g.simTime + FLEET.PLAN_RETRY_S; return; }
  fleet.note(v, 'warn', `${why} She holds here.`);
  setOrder(fleet, v, { type: 'hold' });
}
function wait(fleet, v, why, s, quiet = false) {
  const cap = v.cap;
  if (cap.why !== why && !quiet) fleet.note(v, 'info', `${capital(why)}.`);
  cap.phase = 'waiting'; cap.why = why; cap.nextAt = fleet.game.simTime + s;
}
function fail(fleet, v, why) {
  const cap = v.cap;
  if (cap.phase !== 'failed' || cap.why !== why) fleet.note(v, 'warn', `${why.replace(/\.$/, '')}.`);
  cap.phase = 'failed'; cap.why = why; cap.nextAt = fleet.game.simTime + FLEET.WEATHER_RECHECK_S;
}
const BEAUFORT = [0.3, 1.6, 3.4, 5.5, 8, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];
function galeText(ms) { let b = 0; while (b < BEAUFORT.length && ms >= BEAUFORT[b]) b++; return `${b >= 10 ? 'storm' : b >= 8 ? 'gale' : 'strong wind'} force ${b}`; }
/** §7.4 steps 2–5 (+ no contraband): true when she cannot leave now (phase set to waiting/failed). */
function departureBlocked(fleet, v, plan) {
  const g = fleet.game, s = v.ship, C = clsOf(s.cls), h = harborById(v.docked), a = fleet.actorOf(v), p = fleet.ownerOf(v);
  const w = g.weatherAt(s.lat, s.lon), wind = w && w.wind ? w.wind.spd : 0;
  const windMax = C.length < FLEET.SMALL_LENGTH_M ? FLEET.DEPART_WIND_SMALL_MS : FLEET.DEPART_WIND_MS;
  if ((w && w.storm >= FLEET.DEPART_STORM) || wind >= windMax) { wait(fleet, v, `waiting for weather (${galeText(Math.max(wind, w.storm >= FLEET.DEPART_STORM ? 17.2 : 0))} at ${short(h?.name)})`, FLEET.WEATHER_RECHECK_S); return true; }
  if (v.cond < FLEET.MIN_COND_DEPART) { fail(fleet, v, `Hull at ${Math.round(v.cond)} % — repair her before she sails`); return true; }
  if (v.cargo.some((c) => c.contraband)) { fail(fleet, v, 'No captain will carry that — unload the contraband first'); return true; }
  if (!C.sail) {
    const load = Math.min(1, cargoMass(v.cargo) / C.capacity), burn = serviceBurnTph(s.cls, load), km = plan.distM / 1000;
    const need = (burn * km) / (serviceKn(s.cls, load) * 1.852) * FLEET.FUEL_RESERVE + burn * FLEET.FUEL_RESERVE_H;
    if (need > C.fuelCap) { fail(fleet, v, `needs ${need.toFixed(1)} t of fuel for ${fmt(km)} km; her tanks hold ${C.fuelCap} t — give her a nearer harbour first`); return true; }
    if (v.fuel < need) {
      const want = Math.min(C.fuelCap, need * 1.1) - v.fuel;
      if (want > 0.05 && p && Math.floor(p.money) >= 1) { a._cat = 'fuel'; try { g.buyFuel(a, want); } finally { a._cat = null; } }
      if (v.fuel < need - 1e-9) {
        const price = h && typeof g.fuelPrice === 'function' ? g.fuelPrice(h) : 0;
        fail(fleet, v, `needs ${need.toFixed(1)} t of fuel, has ${v.fuel.toFixed(1)} t and the office cannot pay for bunkers (${fmt((need - v.fuel) * price)} cr)`);
        return true;
      }
    }
  }
  if (p && p.office.owed > 0) { wait(fleet, v, 'unpaid bills', 60); return true; }
  return false;
}
function castOff(fleet, v, plan) {
  const g = fleet.game, a = fleet.actorOf(v), from = harborById(v.docked), tgt = plan.target;
  a._cat = 'port'; try { g.undock(a); } finally { a._cat = null; }
  if (v.docked) return fail(fleet, v, 'She could not cast off');
  fleet.rtOf(v).plan = null;
  startLeg(fleet, v, plan.points, tgt, plan.distM);
  // The harbour's tugs / her thrusters swing her off the quay onto the first leg: left on the berth heading, her turning
  // circle would carry the hull into the quay and the offline stepper stops her for 'shoal water' (phase-2 browser run).
  const s = v.ship, next = v.voyage?.route?.find((q) => haversine(s.lat, s.lon, q[0], q[1]) > 60);
  if (next) { s.hdg = bearing(s.lat, s.lon, next[0], next[1]); s.spd = 0; s.rudder = 0; }
  const C = clsOf(v.ship.cls);
  const eta = v.cap.etaS ? ` ETA ${fmtEtaUtc(v.cap.etaS, g.simTime)}.` : '';
  const dest = tgt.kind === 'harbor' ? short(harborById(tgt.harbor)?.name) : tgt.kind === 'ground' ? `the ${tgt.name}` : tgt.name || 'her position';
  fleet.note(v, 'info', `cast off from ${short(from?.name)} for ${dest}, ${fmt(plan.distM / 1000)} km.${eta}`);
  void C;
}
/** Inside a built harbour patch (basins, quays): the harbour pilot's waters. */
function inPatch(g, s) { try { return typeof g.landPenetration === 'function' && g.landPenetration(s.lat, s.lon) != null; } catch { return false; } }
/** The harbour pilot (phase 2): inside a patch she follows the planner's water-only polyline exactly at harbour speed
 *  (≤ 5 kn), instead of the offline stepper's physics, whose turning circle cut the basin corners into the quays.
 *  Outside the patch the stepper takes over. Same voyage bookkeeping as simulateOffline (`i`, `voyageEnd`, lastValid). */
function pilotStep(g, v, h) {
  const vo = v.voyage, s = v.ship, C = clsOf(s.cls);
  if (!vo || !Array.isArray(vo.route) || !vo.route.length) return;
  const last = vo.route.length - 1;
  const want = Math.min(PILOT_KN, (C.maxKn || 10) * Math.max(0.05, vo.throttle ?? FLEET.SERVICE_THROTTLE));
  s.spd = Math.min(want, Math.max(0, s.spd || 0) + PILOT_ACCEL_KN_S * h);
  s.throttle = Math.min(vo.throttle ?? FLEET.SERVICE_THROTTLE, want / (C.maxKn || 10)); s.rudder = 0;
  let left = s.spd * 0.514444 * h, i = Math.max(0, Math.min(last, vo.i | 0));
  while (left > 0 && i <= last) {
    const wp = vo.route[i], d = haversine(s.lat, s.lon, wp[0], wp[1]);
    if (d < 1) { i++; continue; }
    const b = bearing(s.lat, s.lon, wp[0], wp[1]);
    s.hdg = b;
    if (d <= left) { s.lat = wp[0]; s.lon = wp[1]; left -= d; i++; } else { const q = destination(s.lat, s.lon, b, left); s.lat = q.lat; s.lon = q.lon; left = 0; }
  }
  v.lastValid = { lat: s.lat, lon: s.lon };
  if (i > last) { vo.i = last; v.voyage = null; s.throttle = 0; v.voyageEnd = 'arrived'; return; }
  vo.i = i;
}
/** Sailing (§3.5): the harbour pilot's waters — every sail furled (once). */
function furlInPatch(v) {
  const rig = rigOf(v.ship.cls) ? v.ship.rig : null;
  if (!rig || !anyHoisted(rig)) return;
  applyRigCommand(v.ship.cls, rig, { all: 'furl' }); settleRig(rig); v.sailsUp = false;
  if (v.voyage) v.voyage.sail = { ...(v.voyage.sail || {}), furled: 1 };
}
/** Sail `points` towards target `tgt` (phase sailing). */
function startLeg(fleet, v, points, tgt, distM) {
  const g = fleet.game, old = v.cap || newCap(g), rt = fleet.rtOf(v);
  const route = points.map((q) => [q[0], q[1]]);
  v.cap = newCap(g, 'sailing', {
    target: targetWire(tgt), route, routeKm: r1((distM ?? routeLenM(v.ship, route)) / 1000), tries: old.tries || 0, tugTries: old.tugTries || 0,
    stormIds: old.stormIds || {}, jobId: tgt.jobId || null, holdAt: tgt.kind === 'spot' ? { lat: tgt.lat, lon: tgt.lon } : null, baseThr: FLEET.SERVICE_THROTTLE,
  });
  rt.tgt = tgt; rt.plan = null; rt.pending = null;
  v.voyage = { route, i: 0, throttle: FLEET.SERVICE_THROTTLE, harbor: tgt.kind === 'harbor' ? tgt.harbor : null, setAt: Date.now() };
  v.ship.throttle = FLEET.SERVICE_THROTTLE;            // the telegraph goes ahead at once (wages run from this step)
  if (rigOf(v.ship.cls)) v.voyage.sail = { furled: anyHoisted(v.ship.rig) ? 0 : 1 };   // sailing: the crew hoists the plan for the wind once clear of the harbour band (simulateOffline)
  v.voyageEnd = null;
  v.cap.etaS = etaOf(fleet, v);
  rt.etaAt = g.simTime;
}

// ------------------------------------------------------------------------------------------------ at sea
function beginAtSea(fleet, v) {
  const g = fleet.game;
  if (!v.orders) v.orders = { type: 'hold' };
  const tgt = targetFor(fleet, v);
  if (tgt.done) return finishOrder(fleet, v);
  if (tgt.fail) { fleet.note(v, 'warn', `${tgt.fail.replace(/\.$/, '')}. She holds here.`); return setOrder(fleet, v, { type: 'hold' }); }
  if (tgt.here) return;   // cannot happen at sea
  if (tgt.kind === 'spot') return startHold(fleet, v, tgt.aim);
  if (tgt.points) {        // the route order: her own waypoints, at once
    v.cap = newCap(g, 'idle');
    return startLeg(fleet, v, tgt.points, tgt, routeLenM(v.ship, tgt.points));
  }
  requestPlan(fleet, v, tgt);
  const rt = fleet.rtOf(v);
  if (rt.plan && !rt.pending) { const plan = rt.plan; rt.plan = null; if (plan.fail) planFailed(fleet, v, plan); else startLeg(fleet, v, plan.points, plan.target, plan.distM); }
}
function holdStill(v, thr = 0) { const s = v.ship; s.spd = 0; s.throttle = thr; s.rudder = 0; v.voyage = null; }

function sail(fleet, v, dt) {
  const g = fleet.game, cap = v.cap, rt = fleet.rtOf(v), s = v.ship, a = fleet.actorOf(v), now = g.simTime;
  if (!v.voyage) {
    if (cap.phase === 'fishing') v.voyage = fishVoyage(fleet, v);
    else if (Array.isArray(cap.route) && cap.route.length) v.voyage = { route: cap.route, i: 0, throttle: cap.baseThr || FLEET.SERVICE_THROTTLE, harbor: cap.target && cap.target.harbor || null, setAt: Date.now() };
    if (!v.voyage) { cap.phase = 'idle'; return; }
  }
  if (cap.phase === 'sailing' && now - (rt.stormAt || 0) >= 60) {
    rt.stormAt = now;
    let hit = null;
    try { hit = stormOnRoute(s, v.voyage.route.slice(Math.max(0, v.voyage.i | 0)), typeof g.stormsPublic === 'function' ? g.stormsPublic() : [], { minIntensity: FLEET.DEPART_STORM }); } catch { hit = null; }
    if (hit && hit.distM > 0 && rt.tgt && !(cap.stormIds[hit.storm.id] > now - FLEET.STORM_REPLAN_S)) {
      cap.stormIds[hit.storm.id] = now;
      fleet.note(v, 'info', `storm ${hit.storm.name || ''} ahead on her course — re-planning round it.`.replace('storm  ahead', 'a storm ahead'));
      return requestPlan(fleet, v, { ...rt.tgt, avoid: [{ lat: hit.storm.lat, lon: hit.storm.lon, radiusM: hit.storm.radiusKm * 1000, name: hit.storm.name }] });
    }
  }
  if (now - (rt.gwAt || 0) >= FLEET.GIVE_WAY_CHECK_S) { rt.gwAt = now; giveWay(fleet, v); }
  let thr = cap.baseThr ?? FLEET.SERVICE_THROTTLE;
  const wx = g.weatherAt(s.lat, s.lon);
  if (wx && wx.storm >= FLEET.DEPART_STORM) thr = Math.min(thr, 0.5);
  if (rt.gwUntil > now) thr = Math.min(thr, FLEET.GIVE_WAY_THR);
  if (rt.stopUntil > now) thr = Math.min(thr, 0.05);
  v.voyage.throttle = thr;
  const before = { lat: s.lat, lon: s.lon };
  let left = dt;
  // 0.5 s substeps near online skippers (what they see); 1 s far from everyone (1,000 far ships ≤ 4 ms a tick, docs/V6-FLEET-PHASE2.md §7.2)
  const sub = fleet.rtOf(v).far ? FAR_SUBSTEP_S : FLEET.SUBSTEP_S;
  while (left > 1e-9 && v.voyage && !v.docked && v.flooding < 1) {
    const h = Math.min(sub, left); left -= h;
    if (inPatch(g, s)) { furlInPatch(v); pilotStep(g, v, h); } else g.simulateOffline(a, h);
  }
  const moved = haversine(before.lat, before.lon, s.lat, s.lon);
  if (moved > 0 && moved < 1e6) v.stats.distanceKm = (v.stats.distanceKm || 0) + moved / 1000;
  if (cap.phase === 'sailing' && now - (rt.etaAt || 0) >= 60) { rt.etaAt = now; cap.etaS = etaOf(fleet, v); }
}
function remainingKm(v) {
  const vo = v.voyage; if (!vo || !Array.isArray(vo.route)) return null;
  let d = 0, a = { lat: v.ship.lat, lon: v.ship.lon };
  for (let i = Math.max(0, vo.i | 0); i < vo.route.length; i++) { const q = vo.route[i]; d += haversine(a.lat, a.lon, q[0], q[1]); a = { lat: q[0], lon: q[1] }; }
  return d / 1000;
}
function etaOf(fleet, v) {
  const km = remainingKm(v); if (km == null) return null;
  const C = clsOf(v.ship.cls), kn = serviceKn(v.ship.cls, Math.min(1, cargoMass(v.cargo) / C.capacity));
  return Math.round(fleet.game.simTime + (km / (kn * 1.852)) * 3600);
}
function arrivalTest(fleet, v, end) {
  const g = fleet.game, cap = v.cap, s = v.ship, t = cap.target;
  if (!t) return;
  if (t.kind === 'harbor') {
    const h = harborById(t.harbor); if (!h) return;
    const anc = g.harborAnchor(h), d = haversine(s.lat, s.lon, anc.lat, anc.lon);
    if ((d <= FLEET.ARRIVE_M && Math.abs(s.spd) <= FLEET.ARRIVE_KN) || (end === 'arrived' && d <= FLEET.HARBOUR_ZONE_M)) {
      const rt = fleet.rtOf(v);
      if ((rt.tgt && rt.tgt.then === 'hold') || (v.orders && v.orders.then === 'hold')) return startHold(fleet, v, approachOf(fleet, h));
      return berth(fleet, v, h);
    }
    if (end === 'arrived') {            // the route ended short of the harbour: a direct leg in, else plan again
      if (!g.world || landOnLeg(g.world, s, anc, 0, 3000) === 0) return startLeg(fleet, v, [[anc.lat, anc.lon]], fleet.rtOf(v).tgt || { ...t }, d);
      cap.tries = (cap.tries || 0) + 1;
      if (cap.tries <= FLEET.REPLAN_TRIES && fleet.rtOf(v).tgt) return requestPlan(fleet, v, fleet.rtOf(v).tgt);
      fleet.note(v, 'warn', `could not find the way into ${short(h.name)} — she holds here.`);
      return setOrder(fleet, v, { type: 'hold' });
    }
    return;
  }
  const d = haversine(s.lat, s.lon, t.lat, t.lon);
  if (end !== 'arrived' && d > 400) return;
  switch (t.kind) {
    case 'ground': return startFishing(fleet, v);
    case 'platform': return startTransfer(fleet, v);
    case 'spot': return settle(fleet, v);
    default: { // a route without a harbour: then hold
      if (v.orders && v.orders.type === 'route') { v.orders = { type: 'hold' }; }
      return startHold(fleet, v, { lat: s.lat, lon: s.lon });
    }
  }
}

// --- harbour arrival (§7.5)
function berth(fleet, v, h) {
  const g = fleet.game, a = fleet.actorOf(v), cap = v.cap, s = v.ship;
  v.voyage = null; s.throttle = 0;
  const geom = g.harborGeom ? g.harborGeom(h.id) : null;
  if (geom && Array.isArray(geom.berths) && geom.berths.length) {
    if ((cap.tugTries || 0) < 2) {
      a._cat = 'tugs'; try { g.tugAssist(a); } finally { a._cat = null; }
      if (v.assist) { cap.phase = 'arriving'; cap.why = null; return; }
      cap.tugTries = (cap.tugTries || 0) + 1;
      if (cap.tugTries < 2) {           // one more try from the approach point 1.5–2 km out
        const aim = approachOf(fleet, h), anc = g.harborAnchor(h);
        const tgt = fleet.rtOf(v).tgt || { kind: 'harbor', harbor: h.id, name: short(h.name), lat: anc.lat, lon: anc.lon };
        return startLeg(fleet, v, [[aim.lat, aim.lon], [anc.lat, anc.lon]], tgt, haversine(s.lat, s.lon, aim.lat, aim.lon) + haversine(aim.lat, aim.lon, anc.lat, anc.lon));
      }
    }
    return pilotFallback(fleet, v, h);
  }
  const anc = g.harborAnchor(h);
  if (haversine(s.lat, s.lon, anc.lat, anc.lon) <= INTERACT.DOCK_RADIUS_U) {
    s.spd = 0;
    a._cat = 'port'; try { g.dock(a); } finally { a._cat = null; }
    if (v.docked) return onArrived(fleet, v);
  }
  pilotFallback(fleet, v, h);
}
/** The harbour pilot: a free fitting berth, else a lay-by spot at the anchorage (never through quays: a teleport). */
function pilotFallback(fleet, v, h) {
  const g = fleet.game, a = fleet.actorOf(v), s = v.ship;
  const spot = fleet.freeBerth(h, s.cls, v);
  v.voyage = null;
  if (spot.berth) g.moorAt(a, h, spot.berth);
  else { s.lat = spot.lat; s.lon = spot.lon; v.lastValid = { lat: spot.lat, lon: spot.lon }; g.setDocked(a, h.id, null); }
  a._cat = 'port'; try { g.finishDock(a, h); } finally { a._cat = null; }
  onArrived(fleet, v);
}

// --- fishing (§7.6)
/** Four waypoints on a circle of 0.4 × the ground radius round its centre, starting abeam of the ship. */
export function fishLoop(ground, ship) {
  const r = 0.4 * ground.radiusKm * 1000, b0 = bearing(ground.lat, ground.lon, ship.lat, ship.lon);
  const out = [];
  for (let k = 1; k <= 4; k++) { const q = destination(ground.lat, ground.lon, b0 + 90 * k, r); out.push([r5(q.lat), r5(q.lon)]); }
  return out;
}
function fishJob(v) { return v.jobs.find((j) => j && j.id === v.cap.jobId && j.type === 'fishing') || v.jobs.find((j) => j && j.type === 'fishing') || null; }
function fishVoyage(fleet, v) {
  const j = fishJob(v), gr = j && FISHING_GROUNDS.find((x) => x.id === j.ground) || fleet.game.groundAt(v.ship.lat, v.ship.lon);
  if (!gr) return null;
  return { route: fishLoop(gr, v.ship), i: 0, throttle: v.cap.baseThr, harbor: null, setAt: Date.now() };
}
function startFishing(fleet, v) {
  const g = fleet.game, a = fleet.actorOf(v), s = v.ship, C = clsOf(s.cls), j = fishJob(v);
  const gr = (j && FISHING_GROUNDS.find((x) => x.id === j.ground)) || g.groundAt(s.lat, s.lon);
  if (!j || !gr) { fleet.note(v, 'warn', 'no fishing contract or ground here — she holds.'); return setOrder(fleet, v, { type: 'hold' }); }
  if (!v.fishing) g.setFishing(a, true);
  if (!v.fishing) { fleet.note(v, 'warn', `not on the ${gr.name} — she holds.`); return setOrder(fleet, v, { type: 'hold' }); }
  const thr = throttleCap(FLEET.TRAWL_KN, C.maxKn);
  v.cap = newCap(g, 'fishing', { target: { lat: r5(gr.lat), lon: r5(gr.lon), kind: 'ground', name: gr.name }, jobId: j.id, baseThr: thr, fishPct: Math.floor((fishHave(v) / j.qty) * 4) * 25, tries: 0 });
  v.voyage = fishVoyage(fleet, v);
  fleet.note(v, 'info', `nets out on the ${gr.name}.`);
}
function fishingTest(fleet, v, end) {
  const g = fleet.game, a = fleet.actorOf(v), s = v.ship, C = clsOf(s.cls), cap = v.cap, j = fishJob(v);
  if (!j) { if (v.fishing) g.setFishing(a, false); return finishOrder(fleet, v); }
  if (!v.fishing) { v.cap = newCap(g, 'idle'); return; }    // nets came in (left the ground): start again from the order
  const have = fishHave(v), free = C.capacity - cargoMass(v.cargo);
  const pct = Math.min(100, Math.floor((have / j.qty) * 4) * 25);
  if (pct > (cap.fishPct || 0) && pct < 100) { cap.fishPct = pct; fleet.note(v, 'info', `${r1(have)} of ${j.qty} t caught on the ${cap.target?.name || 'ground'}.`); }
  const h = harborById(j.to), anc = h ? g.harborAnchor(h) : null;
  const backKm = anc ? (haversine(s.lat, s.lon, anc.lat, anc.lon) / 1000) * 1.25 : 0;
  const needH = (backKm / (serviceKn(s.cls, Math.min(1, cargoMass(v.cargo) / C.capacity)) * 1.852)) * 1.2;
  const leftH = Number.isFinite(j.dueShip) ? (j.dueShip - v.shipTime) / 3600 : Infinity;
  if (have >= j.qty || free <= 0.05 || leftH < needH) {
    j.capHaul = true;
    g.setFishing(a, false);
    fleet.note(v, 'info', `nets in with ${r1(have)} t — sailing for ${short(h?.name)}.`);
    v.voyage = null; v.cap = newCap(g, 'idle');
    return;
  }
  if (!v.voyage || end === 'arrived') v.voyage = fishVoyage(fleet, v);
}

// --- supply (§7.6)
function startTransfer(fleet, v) {
  const g = fleet.game, cap = v.cap;
  holdStill(v);
  v.cap = newCap(g, 'transfer', { target: cap.target, jobId: cap.jobId, t0: g.simTime });
  const j = v.jobs.find((x) => x.id === cap.jobId);
  fleet.note(v, 'info', `alongside ${j?.platformName || 'the platform'} — crane transfer under way.`);
}
function transferStep(fleet, v) {
  const g = fleet.game, cap = v.cap, a = fleet.actorOf(v);
  if (g.simTime - (cap.t0 ?? g.simTime) < 60) return;
  const j = v.jobs.find((x) => x.id === cap.jobId);
  if (!j) return finishOrder(fleet, v);
  a._cat = null; g.deliverOffshore(a, j.id);
  if (v.jobs.some((x) => x.id === j.id)) { fleet.note(v, 'warn', `${j.platformName || 'The platform'} refused the transfer — she holds here.`); return setOrder(fleet, v, { type: 'hold' }); }
  const o = v.orders || {};
  if (o.type === 'contract' && o.jobId == null && v.jobs.length) { v.cap = newCap(g, 'idle'); return; }
  if (o.then === 'home') return setOrder(fleet, v, { type: 'home', then: 'moor' });
  if (j.from && harborById(j.from)) return setOrder(fleet, v, { type: 'sail_to', harbor: j.from, then: 'moor' });
  return setOrder(fleet, v, { type: 'hold' });
}

// --- holding safely (§7.7)
/** The express passage's safe spot near `aim`: within 3 km, else 10 km; null when there is none. */
export function holdSpot(fleet, v, aim) {
  const g = fleet.game, C = clsOf(v.ship.cls);
  const o = { draft: C.draft, length: C.length, depthLW: (a, b) => g.depthAtLowWater(a, b), others: fleet.hullsNear(aim.lat, aim.lon, 25000, v) };
  return findSafeSpot(aim, { ...o, maxRadiusM: FLEET.HOLD_SEARCH_M[0] }) || findSafeSpot(aim, { ...o, maxRadiusM: FLEET.HOLD_SEARCH_M[1], stepM: 250 }) || null;
}
function startHold(fleet, v, aim) {
  const g = fleet.game, s = v.ship;
  let spot = null;
  try { spot = holdSpot(fleet, v, aim); } catch { spot = null; }
  if (!spot) {
    const { harbor } = g.nearestHarbor(aim.lat, aim.lon);
    if (harbor) { const q = approachOf(fleet, harbor); spot = { lat: q.lat, lon: q.lon }; }
  }
  if (!spot) { v.cap = newCap(g, 'holding', { holdAt: { lat: s.lat, lon: s.lon } }); return settle(fleet, v); }
  const tgt = { kind: 'spot', lat: spot.lat, lon: spot.lon, name: 'her holding spot' };
  const d = haversine(s.lat, s.lon, spot.lat, spot.lon);
  if (d <= FLEET.HOLD_NEAR_M) { v.cap = newCap(g, 'sailing', { target: targetWire(tgt), holdAt: { lat: spot.lat, lon: spot.lon } }); return settle(fleet, v); }
  if (!g.world || landOnLeg(g.world, s, spot) === 0) return startLeg(fleet, v, [[spot.lat, spot.lon]], tgt, d);
  v.cap = newCap(g, 'idle', { holdAt: { lat: spot.lat, lon: spot.lon } });
  requestPlan(fleet, v, tgt);
  const rt = fleet.rtOf(v);
  if (rt.plan && !rt.pending) { const plan = rt.plan; rt.plan = null; if (plan.fail) { v.cap = newCap(g, 'holding', { holdAt: { lat: s.lat, lon: s.lon } }); settle(fleet, v); } else startLeg(fleet, v, plan.points, plan.target, plan.distM); }
}
/** At the spot: anchored (≤ 80 m at low water) or holding on the engine. */
function settle(fleet, v) {
  const g = fleet.game, s = v.ship;
  const at = v.cap && v.cap.holdAt ? v.cap.holdAt : { lat: s.lat, lon: s.lon };
  if (haversine(s.lat, s.lon, at.lat, at.lon) <= 2 * FLEET.HOLD_NEAR_M) { s.lat = at.lat; s.lon = at.lon; v.lastValid = { lat: at.lat, lon: at.lon }; } // the last cable on the anchor chain
  const depth = g.depthAtLowWater(s.lat, s.lon);
  const anchored = Number.isFinite(depth) && depth <= FLEET.ANCHOR_MAX_DEPTH_M;
  v.voyage = null;
  v.cap = newCap(g, anchored ? 'anchored' : 'holding', { holdAt: { lat: r5(at.lat), lon: r5(at.lon) }, target: { lat: r5(s.lat), lon: r5(s.lon), kind: 'spot' } });
  holdStill(v, anchored ? 0 : FLEET.HOLD_THROTTLE);
  if (!v.orders || (v.orders.type !== 'hold')) v.orders = { type: 'hold' };
  const { harbor } = g.nearestHarbor(s.lat, s.lon);
  let where = '';
  if (harbor) { const a = g.harborAnchor(harbor), d = haversine(a.lat, a.lon, s.lat, s.lon); where = ` ${r1(d / 1000)} km ${compass(bearing(a.lat, a.lon, s.lat, s.lon))} of ${short(harbor.name)}`; }
  fleet.note(v, 'info', anchored ? `at anchor${where}, ${Math.round(depth)} m of water.` : `holding station on the engine${where} — ${Number.isFinite(depth) ? `${Math.round(depth)} m` : 'too much'} of water to anchor.`);
}
function ownerAway(fleet, v) {
  const cap = v.cap, p = fleet.ownerOf(v);
  if (!p || p.online || !(cap.phase === 'anchored' || cap.phase === 'holding')) return;
  if (v.orders && v.orders.type !== 'hold') return;
  if (!(Date.now() - (p.lastSeen || 0) > FLEET.OWNER_AWAY_S * 1000)) return;
  const { harbor } = fleet.game.nearestHarbor(v.ship.lat, v.ship.lon);
  if (!harbor) return;
  setOrder(fleet, v, { type: 'sail_to', harbor: harbor.id, then: 'moor' });
  fleet.note(v, 'info', `you have been away a week — she sails for ${short(harbor.name)} to moor (no wages alongside).`);
}

// --- keeping clear (§7.8)
/** Once a world second while sailing: a hull ahead within reach → one waypoint 30° to starboard (else port), throttle
 *  capped for 30 s; both sides blocked by land → dead slow until clear (≤ 120 s). Returns whether she is giving way. */
export function giveWay(fleet, v) {
  const g = fleet.game, s = v.ship, C = clsOf(s.cls), rt = fleet.rtOf(v), now = g.simTime;
  if (!v.voyage || !Array.isArray(v.voyage.route)) return false;
  const reach = separation(C.length) + 40 * Math.abs(s.spd || 0) * 0.514444;   // 40 s of her own way on top of the separation
  const others = [];
  for (const o of fleet.vesselsNear(s.lat, s.lon, reach + 400, v)) if (!o.docked && o.status === 'active') others.push({ lat: o.ship.lat, lon: o.ship.lon, len: clsOf(o.ship.cls).length });
  try { for (const o of (g.aiNear ? g.aiNear(s.lat, s.lon) : []) || []) others.push({ lat: o.lat, lon: o.lon, len: clsOf(o.cls).length }); } catch { /* no traffic */ }
  try { if (g.liveAis && typeof g.liveAis.near === 'function') for (const o of g.liveAis.near(s.lat, s.lon, 3000, { limit: 20 }) || []) others.push({ lat: o.lat, lon: o.lon, len: Number(o.length) || 120 }); } catch { /* AIS down */ }
  for (const c of g.cutters || []) others.push({ lat: c.lat, lon: c.lon, len: 60 });
  let threat = false;
  for (const o of others) {
    if (!Number.isFinite(o.lat) || !Number.isFinite(o.lon)) continue;
    const d = haversine(s.lat, s.lon, o.lat, o.lon);
    if (d > reach + (o.len || 0) / 2 || d < 1) continue;
    if (Math.abs(angleDiff(s.hdg || 0, bearing(s.lat, s.lon, o.lat, o.lon))) <= FLEET.GIVE_WAY_CONE_DEG) { threat = true; break; }
  }
  if (!threat) { rt.stopSince = 0; return false; }
  if (rt.gwUntil > now) return true;
  const off = Math.max(800, 6 * C.length);
  for (const turn of [FLEET.GIVE_WAY_TURN_DEG, -FLEET.GIVE_WAY_TURN_DEG]) {
    const q = destination(s.lat, s.lon, (s.hdg || 0) + turn, off);
    if (!g.world || landOnLeg(g.world, s, q) === 0) {
      const i = Math.max(0, v.voyage.i | 0);
      v.voyage.route.splice(i, 0, [r5(q.lat), r5(q.lon)]); v.voyage.i = i;
      rt.gwUntil = now + FLEET.GIVE_WAY_S; rt.stopSince = 0;
      return true;
    }
  }
  if (!rt.stopSince) rt.stopSince = now;
  if (now - rt.stopSince <= FLEET.GIVE_WAY_STOP_S) rt.stopUntil = now + FLEET.GIVE_WAY_CHECK_S * 2;
  return true;
}

// ------------------------------------------------------------------------------------------------ the ship card's task line
export function fmtEtaUtc(etaS, nowS) {
  if (!Number.isFinite(etaS)) return '—';
  const d = new Date(etaS * 1000), hm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  const same = new Date(nowS * 1000).toISOString().slice(0, 10) === d.toISOString().slice(0, 10);
  return same ? `${hm} UTC` : `${DAYS[d.getUTCDay()]} ${hm} UTC`;
}
/** VesselView.task (§10.3). `text` carries no ETA (the client adds it in the viewer's words from etaS). */
export function task(fleet, v, aboard = false) {
  const g = fleet.game, cap = v.cap, here = v.docked ? short(harborById(v.docked)?.name) : null;
  const base = { phase: cap ? cap.phase : 'idle', text: '', why: cap && cap.why || null, etaS: null, leftKm: null, target: null };
  if (aboard) return { ...base, phase: 'aboard', text: v.docked ? `You are aboard · moored at ${here}` : 'You are at the helm', why: null };
  if (v.status === 'laidup') return { ...base, phase: 'laid_up', text: `Laid up at ${here}`, why: null };
  const t = cap && cap.target ? { harbor: cap.target.harbor, lat: cap.target.lat, lon: cap.target.lon, kind: cap.target.kind } : null;
  const job = cap && cap.jobId ? v.jobs.find((j) => j.id === cap.jobId) : null;
  const dest = cap && cap.target ? (cap.target.harbor ? short(harborById(cap.target.harbor)?.name) : cap.target.name || null) : null;
  const leftKm = v.voyage ? Math.round(remainingKm(v) * 10) / 10 : null;
  let text;
  switch (base.phase) {
    case 'idle': text = v.docked ? (v.orders ? `Getting ready: ${orderText(fleet, v, v.orders)}` : `Moored at ${here} · no orders`) : 'Taking her bearings'; break;
    case 'planning': text = `Planning the route${dest ? ` to ${dest}` : ''}`; break;
    case 'waiting': text = capital(cap.why || 'waiting'); break;
    case 'failed': text = `Stopped: ${cap.why || 'needs you'}`; break;
    case 'sailing': text = job ? `${job.title}` : dest ? `Sailing to ${dest}` : 'Under way'; break;
    case 'arriving': text = `Berthing at ${dest || 'the harbour'} with the harbour tugs`; break;
    case 'fishing': { const j = job || v.jobs.find((x) => x.type === 'fishing'); text = `Fishing on the ${cap.target?.name || 'ground'}${j ? ` · ${r1(fishHave(v))} of ${j.qty} t` : ''}`; break; }
    case 'transfer': text = `Crane transfer at ${job?.platformName || 'the platform'}`; break;
    case 'anchored': text = 'At anchor'; break;
    case 'holding': text = 'Holding station on the engine'; break;
    default: text = capital(base.phase);
  }
  return { ...base, text, etaS: cap && cap.phase === 'sailing' ? cap.etaS ?? null : null, leftKm, target: t };
}
