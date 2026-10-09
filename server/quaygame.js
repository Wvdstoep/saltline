// Dock anywhere — the game side (docs/DOCK-ANYWHERE-CONTRACT.md §4). Every function takes the Game (server/game.js)
// and a player, so the phase-2 edits to game.js are one-line calls (docs/DOCK-ANYWHERE-PHASE2.md). Pure glue: the
// berths come from server/quays.js, the rules from shared/quayrules.js.
//
//   quay_query  → { t: 'quays', list, … }                       (rate-limited, 1 / s per player)
//   quay_dock   → moored at the slot, day 1 paid, inspection, dues in port, jobs delivered in port
//   quay_tugs   → p.assist { quay: berth, … } (the legacy straight walk), moored when it ends (quayAssistDone)
//   undock      → balance of the stay paid, cast off 20 m out on the water side (quayUndock)
//   services    → quayGate(game, p, action, run): refused / surcharged by tier (trucks, mobile crew)
//
// A quay mooring is an ordinary docking at the LINKED harbour (p.docked = its id), so the harbour sheet, the fleet
// office, the warp rules and saving all work unchanged; p.berth carries `quay: true` and the tier that limits services.
import { SHIP_CLASSES, LAW } from '../shared/constants.js';
import { haversine } from '../shared/geo.js';
import { QUAY, ACTION_SERVICE, SERVICE_TIERS, quayDenies, quaySurcharge, serviceMul, quayFeePerDay, balanceDue, daysAlongside } from '../shared/quayrules.js';
import { queryQuays, dockCheck, tugCheck, quayBerth, quayUndockPoint, collectOccupants, makeSampler, quayName } from './quays.js';
import { HARBORS, harborById } from './harbors.js';
import { portDues, pilotageFee } from './economy.js';

const fmt = (n) => Math.round(n).toLocaleString('en-US');
const ASK_MS = 1000;
const ENSURE_MS = 15000;   // missing tiles are asked for at most this often per player

/** Harbour-patch berths near a point (their own Moor / Tugs flow wins there). */
export function harbourBerthsNear(game, lat, lon, rangeM) {
  const out = [];
  for (const h of HARBORS) {
    if (Math.abs(h.lat - lat) > 0.2 || haversine(lat, lon, h.lat, h.lon) > rangeM + 6000) continue;
    let g = null; try { g = game.harborGeom ? game.harborGeom(h.id) : null; } catch { g = null; }
    for (const b of g?.berths || []) if (Number.isFinite(b.lat) && Number.isFinite(b.lon)) out.push({ lat: b.lat, lon: b.lon, hdg: b.hdg, length: b.length || b.maxLength || 60 });
  }
  return out;
}
/** The options every fit needs for this player (occupants, harbour berths, home, restricted areas). */
export function fitOpts(game, p) {
  const s = p.ship;
  return {
    occupants: collectOccupants(game, s.lat, s.lon, QUAY.QUERY_RADIUS_M + 1500, p),
    harbourBerths: harbourBerthsNear(game, s.lat, s.lon, QUAY.QUERY_RADIUS_M + 500),
    forbidden: typeof game.quayForbidden === 'function' ? game.quayForbidden : null,
    home: game.fleet?.homeOf ? game.fleet.homeOf(p) : null,
    harborById, harbors: HARBORS,
    sample: game.quayFinder?.sample || null,
  };
}
const shipOf = (p) => ({ lat: p.ship.lat, lon: p.ship.lon, hdg: p.ship.hdg, spd: Math.abs(p.ship.spd || 0), cls: p.ship.cls });

/** quay_query: the candidate list near the ship → `{ t: 'quays', … }` to the player. Missing tiles are fetched (P1, ≤ 2.5 s) and the answer follows. */
export function quayQuery(game, p, { now = Date.now() } = {}) {
  const f = game.quayFinder;
  if (!f) return game.event(p, 'warn', 'Quays are not charted on this server yet.');
  if (p.docked || p.assist) return game.send(p, { t: 'quays', list: [], docked: !!p.docked });
  if (now - (p.quayAskAt || 0) < ASK_MS) return;
  p.quayAskAt = now;
  const o = fitOpts(game, p);
  let res;
  try { res = queryQuays(f, shipOf(p), o); } catch (e) { game.log?.(`[quays] query failed: ${e.stack || e}`); res = { list: [], missing: 0, pending: 0, busy: true }; }
  game.send(p, { t: 'quays', ...res });
  // At most one tile request per player per ENSURE_MS, and the re-answer after it never asks again: tiles that do not
  // come (offline server, uncharted water) must not turn query → ensure → query into a loop that starves the server.
  if (res.missing > 0 && typeof game.quayEnsure === 'function' && !p.quayEnsuring && !(now - (p.quayEnsureAt || 0) < ENSURE_MS)) {
    p.quayEnsuring = true; p.quayEnsureAt = now;
    Promise.resolve().then(() => game.quayEnsure(p.ship.lat, p.ship.lon)).catch(() => null).then(() => { p.quayEnsuring = false; p.quayAskAt = 0; if (p.online !== false && !p.docked) quayQuery(game, p, { now }); });
  }
}

/** Common "lines ashore at a quay" state + fees (both quay_dock and the end of a tug assist). */
export function quayMoor(game, p, run, fit) {
  const h = run.harbor ? harborById(run.harbor) : null;
  if (h && game.politics) { const e = game.politics.entryCheck(p, h); if (e.refuse) return game.event(p, 'law', e.text); }   // world politics H8 (never on a restart re-mooring)
  const home = game.fleet?.homeOf ? game.fleet.homeOf(p) : null;
  const perDay = quayFeePerDay(p.ship.cls, run.cls, { size: h?.size, tier: run.tier, home: !!home && home === run.harbor });
  const s = p.ship, sl = fit.slot;
  s.lat = sl.lat; s.lon = sl.lon; s.hdg = sl.hdg;
  p.lastValid = { lat: sl.lat, lon: sl.lon };
  const paid = Math.min(perDay, Math.max(0, p.money));
  const berth = quayBerth(run, fit, s, { perDay, harbor: h, simTime: game.simTime, paid });
  game.setDocked(p, h ? h.id : null, berth);
  p.money = Math.max(0, p.money - paid);
  quayFinish(game, p, h, berth, paid);
}
/** Moor at a berth saved earlier (tug assist interrupted by a restart, tiles not in memory yet). */
export function quayMoorSaved(game, p, saved) {
  const h = saved.harbor ? harborById(saved.harbor) : null, s = p.ship;
  s.lat = saved.lat; s.lon = saved.lon; s.hdg = saved.hdg; p.lastValid = { lat: saved.lat, lon: saved.lon };
  const paid = Math.min(saved.perDay, Math.max(0, p.money));
  const berth = { ...saved, since: game.simTime, paid };
  game.setDocked(p, h ? h.id : null, berth);
  p.money = Math.max(0, p.money - paid);
  quayFinish(game, p, h, berth, paid);
}
function quayFinish(game, p, h, berth, paid) {
  if (p.cond > 0) p.flooding = 0;
  game.event(p, 'info', `Moored at ${berth.name}${h ? ` (${berth.hdKm} km from ${h.name})` : ''}. ${fmt(berth.perDay)} cr per day — day 1 paid (${fmt(paid)} cr), the rest when you cast off.`);
  const T = berth.tier;
  let seized = false;
  if (h && T === 'port') {
    const chance = p.wanted > 0 ? LAW.PORT_INSPECT_CHANCE_WANTED : LAW.PORT_INSPECT_CHANCE;
    seized = game.rnd() < chance ? game.inspect(p, `${h.name} port authority`) : false;
  }
  if (h && serviceMul(T, 'deliver') != null && p.docked === h.id) game.deliverJobs(p, h);
  if (h && T === 'port' && !seized) {
    const dues = portDues(p.ship.cls, h), pilot = pilotageFee(p.ship.cls, h);
    if (dues > 0) { p.money = Math.max(0, p.money - dues); game.event(p, 'info', `Port dues: ${fmt(dues)} cr.`); }
    if (pilot > 0) { p.money = Math.max(0, p.money - pilot); game.event(p, 'info', `Pilotage (${SHIP_CLASSES[p.ship.cls].length} m hull, compulsory here): ${fmt(pilot)} cr.`); }
  }
  if (T !== 'port' && h) game.event(p, 'info', T === 'none' ? 'No harbour services reach this quay.' : `${h.name} serves this quay by truck and phone: ${T === 'near' ? 'market, fuel, repairs, office and contracts' : 'fuel and the office'}.`);
  game.sendYou(p); game.sendHarbor(p);
}

/** quay_dock { id }: make fast at the quay's slot nearest the ship (server re-fits; the id only names the quay). */
export function quayDock(game, p, m = {}) {
  const f = game.quayFinder;
  if (!f) return game.event(p, 'warn', 'Quays are not charted on this server yet.');
  if (p.docked) return game.sendHarbor(p);
  if (p.assist) return game.event(p, 'info', 'The tugs have you. Hold on.');
  if (p.flooding >= 1 || p.rescue) return;
  if (p.hail) return game.event(p, 'law', 'Nobody takes your lines: the coast guard has ordered you to heave to first.');
  const o = fitOpts(game, p);
  const r = dockCheck(f, shipOf(p), String(m.id || ''), o);
  if (!r.ok) return game.event(p, 'warn', r.why);
  const h = r.run.harbor ? harborById(r.run.harbor) : null;
  const home = o.home;
  const perDay = quayFeePerDay(p.ship.cls, r.run.cls, { size: h?.size, tier: r.run.tier, home: !!home && home === r.run.harbor });
  if (p.money < perDay) return game.event(p, 'warn', `The quay wants the first day (${fmt(perDay)} cr) when your lines go ashore. You have ${fmt(p.money)} cr.`);
  game.dropWarp?.(p, 'Alongside.', false);
  quayMoor(game, p, r.run, r.fit);
  game.send(p, { t: 'quays', list: [], dockedAt: p.berth?.id || null });
}

/**
 * T / "Dock" next to a quay that is not a harbour berth: moor at the nearest quay (within 150 m) that fits and whose
 * approach rules hold now. Returns true when it moored her (game.dock calls this before refusing "No harbour …").
 */
export function quayDockNearest(game, p) {
  const f = game.quayFinder;
  if (!f || p.docked || p.assist || p.hail || p.flooding >= 1) return false;
  const o = fitOpts(game, p);
  let res; try { res = queryQuays(f, shipOf(p), { ...o, radiusM: 150 }); } catch { return false; }
  for (const c of res.list) {
    if (!c.fits) continue;
    const r = dockCheck(f, shipOf(p), c.id, o);
    if (r.ok && p.money >= c.perDay) { quayDock(game, p, { id: c.id }); return !!p.docked; }
  }
  return false;
}

/** quay_tugs { id }: tugs walk the ship to the slot (legacy straight walk, QUAY.TUG_SECONDS), then quayAssistDone moors her. */
export function quayTugs(game, p, m = {}, { now = Date.now() } = {}) {
  const f = game.quayFinder;
  if (!f || p.docked || p.assist || p.flooding >= 1) return;
  if (p.hail) return game.event(p, 'law', 'No tug will take a line while the coast guard is hailing you.');
  const o = fitOpts(game, p);
  const r = tugCheck(f, shipOf(p), String(m.id || ''), o);
  if (!r.ok) return game.event(p, 'warn', r.why);
  const h = r.harbor || (r.run.harbor ? harborById(r.run.harbor) : null);
  const perDay = quayFeePerDay(p.ship.cls, r.run.cls, { size: h?.size, tier: r.run.tier, home: !!o.home && o.home === r.run.harbor });
  if (p.money < r.cost + perDay) return game.event(p, 'warn', `The tugs want ${fmt(r.cost)} cr up front and the quay ${fmt(perDay)} cr for day 1. You have ${fmt(p.money)} cr.`);
  p.money -= r.cost;
  game.dropWarp?.(p, 'Tugs fast.', false);
  const sl = r.fit.slot, name = quayName(r.run, h);
  const saved = quayBerth(r.run, r.fit, p.ship, { perDay, harbor: h, simTime: game.simTime, paid: 0 });   // for a restart without tiles
  p.assist = {
    harbor: h ? h.id : null, berthId: sl.id, berthName: name, quay: { runId: r.run.id, slotS: sl.s, berth: saved },
    from: { lat: p.ship.lat, lon: p.ship.lon, hdg: p.ship.hdg }, to: { lat: sl.lat, lon: sl.lon, hdg: sl.hdg },
    start: now, until: now + QUAY.TUG_SECONDS * 1000, cost: r.cost,
  };
  game.event(p, 'info', `Two tugs made fast for ${fmt(r.cost)} cr. They will put you alongside ${name} in ${QUAY.TUG_SECONDS} s.`);
  game.sendYou(p);
}
/**
 * End of a quay tug assist (also after a restart): re-fit the same quay at the slot; if it is gone (another ship took it,
 * the tile changed) moor at the best free slot of that quay, else leave her stopped where the tugs are, not charged a day.
 */
export function quayAssistDone(game, p, a) {
  const f = game.quayFinder, s = p.ship;
  p.assist = null;
  s.lat = a.to.lat; s.lon = a.to.lon; s.hdg = a.to.hdg; s.spd = 0; s.throttle = 0; s.rudder = 0;
  p.lastValid = { lat: s.lat, lon: s.lon };
  const r = f ? dockCheck(f, { ...shipOf(p), spd: 0 }, a.quay?.runId || a.berthId, fitOpts(game, p)) : { ok: false, missing: true, why: 'Quays are not charted here.' };
  game.event(p, 'info', 'Tugs cast off.');
  if (!r.ok && r.missing && a.quay?.berth?.quay) { quayMoorSaved(game, p, a.quay.berth); game.sendYou(p, { correction: true }); return true; } // tiles not loaded (restart): the berth checked when the tugs took her
  if (!r.ok) { game.event(p, 'warn', `${r.why} The tugs leave you lying off the quay.`); game.sendYou(p, { correction: true }); return false; }
  quayMoor(game, p, r.run, r.fit);
  game.sendYou(p, { correction: true });
  return true;
}

/** undock from a quay berth: the balance of the stay, then 20 m out on the water side. Returns true when handled. */
export function quayUndock(game, p) {
  const b = p.berth;
  if (!p.docked || !b || !b.quay) return false;
  const secs = Math.max(0, game.simTime - (b.since ?? p.dockedAt ?? game.simTime));
  const due = balanceDue(b.perDay, secs, b.paid), days = daysAlongside(secs);
  if (due > 0) { p.money = Math.max(0, p.money - due); game.event(p, 'info', `Quay fee: ${days} day${days > 1 ? 's' : ''} alongside at ${fmt(b.perDay)} cr, ${fmt(due)} cr still due — paid.`); }
  const spawn = quayUndockPoint(b);
  p.docked = null; p.contactSeen = null; p.berth = null; p.dockedAt = null;
  p.ship.lat = spawn.lat; p.ship.lon = spawn.lon; if (Number.isFinite(spawn.hdg)) p.ship.hdg = spawn.hdg;
  p.lastValid = { lat: spawn.lat, lon: spawn.lon }; p.lastState = Date.now(); p.moveBudget = null; p.shallowSince = 0;
  game.event(p, 'info', `Cast off from ${b.name}. Fuel ${p.fuel.toFixed(1)} t, condition ${Math.round(p.cond)} %.`);
  game.sendYou(p, { correction: true });
  return true;
}

/**
 * Service gate for an action while moored at a quay. run() performs the normal harbour action. Refused services return
 * the reason as a warning; offered ones run and the tier's surcharge (trucks, mobile crew) is charged on the money that
 * changed hands. Fuel orders are capped at the tier's truck size. Harbour berths and actions without a service pass through.
 */
export function quayGate(game, p, action, m, run) {
  const b = p.berth;
  const service = ACTION_SERVICE[action] || null;
  if (!b || !b.quay || !service) return run();
  const h = harborById(b.harbor);
  const why = quayDenies(b, service, h?.name || 'the harbour');
  if (why) return game.event(p, 'warn', why);
  if (service === 'fuel') {
    const cap = SERVICE_TIERS[b.tier]?.maxFuelT ?? null;
    if (cap != null && m) m.tonnes = Math.min(Number.isFinite(+m.tonnes) ? +m.tonnes : cap, cap);
  }
  const before = p.money;
  const out = run();
  const moved = Math.abs((Number(p.money) || 0) - (Number(before) || 0));
  const fee = quaySurcharge(b.tier, service, moved);
  if (fee > 0) {
    p.money = Math.max(0, p.money - fee);
    game.event(p, 'info', `${service === 'market' ? 'Trucking' : service === 'fuel' ? 'Fuel truck' : 'Call-out'} to ${b.name}: ${fmt(fee)} cr.`);
    game.sendYou(p);
  }
  return out;
}

/** Restart: an interrupted quay tug assist completes now (like harbour assists in migratePlayer). */
export function quayMigrate(game, p) {
  if (p.assist?.quay) { const a = p.assist; quayAssistDone(game, p, a); return true; }
  return false;
}
/** What other skippers see of a ship moored at a quay (publicState.quay). */
export function quayPublic(p) { return p.docked && p.berth?.quay ? { name: p.berth.name, cls: p.berth.cls } : null; }
/** The harbour sheet's extra field: which tabs and services this quay reaches (hud gating). */
export function quayHarbourInfo(p) {
  const b = p.berth; if (!b || !b.quay) return null;
  return { name: b.name, tier: b.tier, hdKm: b.hdKm, perDay: b.perDay, since: b.since, paid: b.paid };
}
/** Is ashore (the harbour walk) possible from here? (never from a quay: the walk is built around the harbour) */
export function quayAllowsAshore(p) { return !(p.berth && p.berth.quay); }

/** createQuayFinder + sampler bundle for server.js: game.quayFinder. */
export function attachFinder(game, finder, getTile) {
  finder.sample = makeSampler(getTile);
  game.quayFinder = finder;
  return finder;
}
