// v6 fleet, office and boat storage (docs/V6-FLEET-CONTRACTS.md). One instance: `game.fleet = new Fleet(game)`.
// Every ship is a Vessel record (server/vessel.js); a person sails the one they are aboard through accessors, a hired
// captain (server/captain.js) sails every other active one through an actor that runs the game's own methods. This file
// holds the index, migration, the small ledger (exact integer credits), the office (home, storage, slots), buying and
// selling without a trade-in, switching ships, the fleet actions, the per-socket snapshot list and the HQ payload.
import crypto from 'node:crypto';
import { SHIP_CLASSES, GOODS, FEES } from '../shared/constants.js';
import { haversine, bearing } from '../shared/geo.js';
import {
  FLEET, VESSEL_ID_RE, JOB_ID_RE, LEDGER_CATS, CAPTAIN_JOB_TYPES, storageFeePerDay, recommissionFee, transferFee,
  wageRateMcrH, validShipName, defaultShipName, homeAllowed, stateOf, dayKey, lastDays, totals, normalizeOrder,
} from '../shared/fleet.js';
import { hardReason, estimateJob } from '../shared/jobtime.js';
import { findSafeSpot } from './safespot.js';
import { shipValue, berthFeePerDay, cargoMass, publicJob } from './economy.js';
import { harborById } from './harbors.js';
import { relocateDocked } from './harbormove.js';
import { tugsPublic } from './tugassist.js';
import { rigOf } from '../shared/sail/rigs.js';                              // sailing (docs/SAILING-CONTRACT.md §3.6–§3.7)
import { ensureRig, normalizeRig, anyHoisted, packRigView } from '../shared/sail/state.js';
import { bindPlayer, takeVesselFields, makeActor } from './vessel.js';
import * as captain from './captain.js';
import { healShipsVessel, healOrders, marketValue } from '../shared/ships/index.js';   // SHIPYARD H8
import { vesselSlotsUsed } from '../shared/fleet.js';                                  // SHIPYARD H8c

const SERVICE_INTERVAL_S = FEES.SERVICE_INTERVAL_DAYS * 86400;
const START_HARBOR = 'rotterdam';
const ACTIONS = ['switch_ship', 'fleet_order', 'fleet_accept', 'fleet_board', 'fleet_service', 'fleet_rename', 'fleet_layup', 'fleet_recommission',
  'fleet_sell', 'fleet_transfer', 'fleet_move_job', 'fleet_slot', 'fleet_home', 'hq_watch', 'fleet_seen', 'fleet_debug'];
const QUIET = /^(Port dues|Pilotage|Berth fee|Bunkered|Cast off from)/; // bookkeeping lines the captain summarises himself (§7.11)
const STAT_KEYS = ['delivered', 'earned', 'distanceKm', 'sunk', 'inspected', 'fined', 'caught', 'boarded', 'pirated', 'collisions'];
const CELL_DEG = 0.5;

const clsOf = (c) => SHIP_CLASSES[c] || SHIP_CLASSES.coaster;
const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : 0);
const r6 = (v) => Math.round(v * 1e6) / 1e6;
const short = (name) => String(name || '').split(' (')[0];
const aName = (s) => `${/^[aeiou]/i.test(s) ? 'an' : 'a'} ${s}`;
const isHarbor = (id) => typeof id === 'string' && id.length <= 64 && !!harborById(id);
const newStats = () => Object.fromEntries(STAT_KEYS.map((k) => [k, 0]));
const cellKey = (lat, lon) => `${Math.floor(lat / CELL_DEG)},${Math.floor(lon / CELL_DEG)}`;
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** A fresh office (§3.1). */
export function newOffice(home = START_HARBOR) {
  return { home, homeSetAt: 0, homeMoves: 0, slots: FLEET.SLOTS_FREE, owed: 0, lastSwitchAt: 0, log: [], book: { days: {}, rem: 0 }, lost: [], unread: 0 };
}

export class Fleet {
  constructor(game) {
    this.game = game;
    this.vessels = new Map();   // VesselId → Vessel (every player's)
    this.actors = new Map();    // VesselId → Actor (lazy)
    this.rt = new Map();        // VesselId → runtime state, never saved (plans in flight, accumulated far-tick time, timers)
    this.m0 = new Map();        // playerId → p.money at the last drift booking
    this.watching = new Set();  // playerIds with the HQ open (hq_watch)
    this.buckets = new Map();   // playerId → action token bucket
    this.sentAt = new Map();    // playerId → Date.now() of the last `fleet` message
    this.changed = new Set();   // playerIds whose fleet view changed since the last `fleet` message
    this.planLog = new Map();   // playerId → [Date.now() of route plans] (6 per minute)
    this.tickNo = 0; this.snapNo = 0; this.idxSeq = 0; this.lastDaily = 0; this.wxCursor = 0;
    this.grid = null; this.gridAt = -1;
    this.perf = { ticks: 0, ms: 0, stepped: 0, lastStepped: 0 };
  }

  // ------------------------------------------------------------------------------------------------ index and records
  newId(extra) {
    let id;
    do { id = 'v' + crypto.randomBytes(4).toString('hex'); } while (this.vessels.has(id) || (extra && extra.has(id)));
    return id;
  }
  index(v) { this.vessels.set(v.id, v); this.gridAt = -1; this.ver = (this.ver || 0) + 1; }
  unindex(v) { this.vessels.delete(v.id); this.actors.delete(v.id); this.rt.delete(v.id); this.gridAt = -1; this.ver = (this.ver || 0) + 1; }
  rtOf(v) {
    let r = this.rt.get(v.id);
    if (!r) { r = { acc: 0, idx: this.idxSeq++, gen: 0, plan: null, pending: null, gwAt: 0, gwUntil: 0, stopUntil: 0, stormAt: 0, etaAt: 0, tugsUntil: 0 }; this.rt.set(v.id, r); }
    return r;
  }
  ownerOf(v) { return this.game.byId.get(v.ownerId) || null; }
  isAboard(v) { const p = this.ownerOf(v); return !!p && p.aboard === v.id; }
  actorOf(v) { let a = this.actors.get(v.id); if (!a) { a = makeActor(this, v); this.actors.set(v.id, a); } return a; }
  /** For server/tugassist.js tickTugs: the captain whose tug op this is (a person's op is keyed by the person's id). */
  actorById(id) { const v = this.vessels.get(id); return v && !this.isAboard(v) ? this.actorOf(v) : null; }
  homeOf(p) { return p?.isActor ? p.owner?.office?.home ?? null : p?.office?.home ?? null; }

  makeVessel(ownerId, f) {
    const sim = this.game.simTime, C = clsOf(f.ship.cls);
    return {
      id: f.id || this.newId(), ownerId, name: f.name || 'Vessel', status: 'active',
      acquiredAt: Math.floor(Number.isFinite(f.acquiredAt) ? f.acquiredAt : sim), acquiredPrice: Math.round(f.acquiredPrice || 0),
      ship: f.ship, cond: f.cond ?? 100, flooding: 0, fuel: f.fuel ?? C.fuelCap, cargo: [], jobs: [], kits: f.kits ?? 0,
      docked: f.docked ?? null, dockedAt: f.docked ? (f.dockedAt ?? sim) : null, berth: f.berth ?? null, assist: null,
      serviceDue: f.serviceDue ?? sim + SERVICE_INTERVAL_S, voyage: null, towing: null, fishing: false, fishInfo: null, sailsUp: this.sailRig(f.ship, !f.docked, f.sailsUp),
      lastValid: { lat: f.ship.lat, lon: f.ship.lon }, guideBerth: null, lowFuelWarned: false, condWarned: false, floodWarned: false,
      serviceWarned: false, fullWarned: false, shipTime: f.shipTime ?? sim, voyageEnd: null,
      orders: null, cap: null, pay: { rem: 0 }, laidUpAt: 0, storagePaidTo: 0, stats: newStats(),
      spec: f.spec ?? null, hist: f.hist ?? null,   // SHIPYARD §4.6 (server/yard.js fills both at delivery; healVessel heals null)
    };
  }
  /** Sailing (§3.6): create/repair ship.rig (a newer schema or a class change → a default rig). At sea the sails stay
   *  as the legacy `sailsUp` says; moored or laid up they are down. → the new sailsUp (engine classes: unchanged). */
  sailRig(ship, atSea, sailsUp = true) {
    if (!ship || !rigOf(ship.cls)) { if (ship && ship.rig !== undefined) delete ship.rig; return sailsUp !== false; }
    ship.rig = normalizeRig(ship.cls, ship.rig, atSea ? sailsUp : false);
    return anyHoisted(ship.rig);
  }
  /** Defaults for a saved vessel (v6 record) — never throws. */
  healVessel(v, office) {
    const sim = this.game.simTime;
    v.name = validShipName(v.name) || 'Vessel';
    v.status = v.status === 'laidup' ? 'laidup' : 'active';
    if (!Array.isArray(v.cargo)) v.cargo = [];
    if (!Array.isArray(v.jobs)) v.jobs = [];
    for (const k of ['cond', 'fuel']) if (!Number.isFinite(v[k])) v[k] = k === 'cond' ? 100 : 0;
    if (!Number.isFinite(v.flooding)) v.flooding = 0;
    if (!Number.isFinite(v.kits)) v.kits = 0;
    if (!Number.isFinite(v.acquiredAt)) v.acquiredAt = Math.floor(sim);
    if (!Number.isSafeInteger(v.acquiredPrice)) v.acquiredPrice = Math.round(Number(v.acquiredPrice) || 0);
    const rem = v.pay && Number(v.pay.rem);
    v.pay = { rem: Number.isSafeInteger(rem) && rem >= 0 && rem < FLEET.DEN_WAGE ? rem : 0 };
    if (!Number.isFinite(v.laidUpAt)) v.laidUpAt = 0;
    if (!Number.isFinite(v.storagePaidTo)) v.storagePaidTo = v.status === 'laidup' ? sim : 0;
    if (!v.stats || typeof v.stats !== 'object') v.stats = {};
    for (const k of STAT_KEYS) if (!Number.isFinite(v.stats[k])) v.stats[k] = 0;
    if (v.orders != null) { const o = normalizeOrder(v.orders, isHarbor); v.orders = o.ok ? o.order : null; }
    if (v.cap != null && (typeof v.cap !== 'object' || typeof v.cap.phase !== 'string')) v.cap = null;
    if (v.voyageEnd === undefined) v.voyageEnd = null;
    this.game.politics?.healVesselPol(v, harborById(office?.home)?.country);   // world politics: flag, built, PSC, holds
    if (v.status === 'laidup') { v.orders = null; v.cap = null; }
    if (v.ship && typeof v.ship === 'object' && (rigOf(v.ship.cls) || v.ship.rig !== undefined)) v.sailsUp = this.sailRig(v.ship, !v.docked && v.status !== 'laidup', v.sailsUp);   // sailing: save migration (§3.6); engine-class records stay byte-identical
    healShipsVessel(v, sim);                        // SHIPYARD §8: spec + hist (estimated: value unchanged); never touches cls or money
    return v;
  }
  healOffice(o, rec) {
    const sim = this.game.simTime;
    const out = { ...newOffice(), ...(o && typeof o === 'object' ? o : {}) };
    if (!isHarbor(out.home) || !homeAllowed(harborById(out.home))) out.home = START_HARBOR;
    out.slots = Math.max(FLEET.SLOTS_FREE, Math.min(FLEET.SLOTS_MAX, Math.floor(Number(out.slots) || FLEET.SLOTS_FREE)));
    out.owed = Math.max(0, Math.floor(Number(out.owed) || 0));
    out.homeSetAt = Number.isFinite(out.homeSetAt) ? out.homeSetAt : 0;
    out.pol = this.game.politics ? this.game.politics.healOfficePol(out.pol) : out.pol;
    out.homeMoves = Math.max(0, Math.floor(Number(out.homeMoves) || 0));
    out.lastSwitchAt = 0;
    out.unread = Math.max(0, Math.floor(Number(out.unread) || 0));
    out.log = (Array.isArray(out.log) ? out.log : []).filter((l) => l && typeof l.text === 'string').slice(-FLEET.LOG_MAX);
    out.lost = (Array.isArray(out.lost) ? out.lost : []).filter((l) => l && typeof l === 'object').slice(-FLEET.LOST_MAX);
    const days = {}, src = out.book && typeof out.book.days === 'object' && out.book.days ? out.book.days : {};
    for (const k of Object.keys(src).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().slice(-FLEET.LEDGER_DAYS)) {
      days[k] = {};
      for (const [vid, cats] of Object.entries(src[k] || {})) {
        if (!cats || typeof cats !== 'object') continue;
        const row = {};
        for (const [c, amt] of Object.entries(cats)) if (LEDGER_CATS.includes(c) && Number.isFinite(amt) && Math.round(amt) !== 0) row[c] = Math.round(amt);
        if (Object.keys(row).length) days[k][vid] = row;
      }
    }
    const rem = Number(out.book && out.book.rem);
    out.book = { days, rem: Number.isFinite(rem) && Math.abs(rem) < 1 ? rem : 0 };
    healOrders(out);                                // SHIPYARD §8: office.orders = [] on old saves
    void sim; void rec;
    return out;
  }

  /** §3.5: called by loadState for every saved player BEFORE migratePlayer. Turns the record into a v6 person. */
  adoptPlayer(rec) {
    const sim = this.game.simTime;
    if (Array.isArray(rec.fleet)) {
      takeVesselFields(rec);                        // stray person-level ship fields: the vessels are the truth
      const office = rec.office = this.healOffice(rec.office, rec);
      const seen = new Set(), list = [];
      for (const v of rec.fleet) {
        if (!v || typeof v !== 'object' || !v.ship || typeof v.ship !== 'object' || !SHIP_CLASSES[v.ship.cls]) continue;
        if (!Number.isFinite(v.ship.lat) || !Number.isFinite(v.ship.lon)) continue;
        if (typeof v.id !== 'string' || !VESSEL_ID_RE.test(v.id) || seen.has(v.id) || this.vessels.has(v.id)) v.id = this.newId(seen);
        seen.add(v.id); v.ownerId = rec.id;
        list.push(this.healVessel(v, office));
        if (list.length >= FLEET.MAX_VESSELS) break;
      }
      if (!list.length) list.push(this.starterVessel(rec, office.home, seen));
      // names unique within the fleet
      const names = [];
      for (const v of list) { if (names.some((n) => n.toLowerCase() === v.name.toLowerCase())) v.name = defaultShipName(names); names.push(v.name); }
      // laid-up only at home, empty, within the slots
      let laid = 0;
      for (const v of list) {
        if (v.status !== 'laidup') continue;
        if (v.docked !== office.home || v.cargo.length || v.jobs.length || laid >= office.slots) { v.status = 'active'; v.cap = null; v.orders = null; continue; }
        laid++;
      }
      let aboard = list.find((v) => v.id === rec.aboard && v.status === 'active') || list.find((v) => v.status === 'active');
      if (!aboard) { aboard = list[0]; aboard.status = 'active'; aboard.laidUpAt = 0; aboard.storagePaidTo = 0; }
      aboard.orders = null; aboard.cap = null; aboard.fishing = false;   // the aboard ship's nets are hauled on load, as today
      rec.fleet = list; rec.aboard = aboard.id;
    } else {
      const home0 = rec.docked, hh = isHarbor(home0) ? harborById(home0) : null;
      const home = hh && homeAllowed(hh) ? hh.id : START_HARBOR;
      const fields = takeVesselFields(rec);
      const want = typeof rec.id === 'string' && /^[0-9a-z]{1,15}$/.test(rec.id) ? 'v' + rec.id : null;
      const id = want && !this.vessels.has(want) ? want : this.newId();
      let v;
      if (fields.ship && typeof fields.ship === 'object' && SHIP_CLASSES[fields.ship.cls] && Number.isFinite(fields.ship.lat)) {
        v = { id, ownerId: rec.id, name: defaultShipName([]), status: 'active', acquiredAt: Math.floor(Number.isFinite(rec.createdAt) ? rec.createdAt / 1000 : sim), acquiredPrice: 0,
          ...fields, orders: null, cap: null, pay: { rem: 0 }, laidUpAt: 0, storagePaidTo: 0, stats: newStats() };
        if (!Array.isArray(v.cargo)) v.cargo = [];
        if (!Array.isArray(v.jobs)) v.jobs = [];
        if (v.voyageEnd === undefined) v.voyageEnd = null;
        v.fishing = false;
      } else v = this.starterVessel(rec, home, null, id);
      healShipsVessel(v, sim);                      // SHIPYARD §8: the migrated ship gets spec + hist now, so a second load is identical
      rec.fleet = [v]; rec.aboard = v.id; rec.office = newOffice(home);
    }
    bindPlayer(rec, this);
    for (const v of rec.fleet) this.index(v);
    return rec;
  }
  /** A coaster at the anchor of `home` (a corrupt record with no usable ship). */
  starterVessel(rec, home, seen, id) {
    const h = harborById(home) || harborById(START_HARBOR), a = this.game.harborAnchor ? this.game.harborAnchor(h) : { lat: h.lat, lon: h.lon };
    return this.makeVessel(rec.id, { id: id || this.newId(seen), name: defaultShipName([]), ship: { cls: 'coaster', lat: a.lat, lon: a.lon, hdg: 0, spd: 0, throttle: 0, rudder: 0 }, docked: h.id, kits: 1 });
  }
  /** §3.5 after the players loop of loadState. savedAtS = unix s of the save. */
  afterLoad(savedAtS) {
    const g = this.game, down = Number.isFinite(savedAtS) ? Math.max(0, g.simTime - savedAtS) : 0;
    // harbours moved by the position audit: ships (players' and fleet) saved docked at the old spot move with them
    try { relocateDocked([...this.vessels.values()], harborById, (m) => g.log?.(m)); } catch (e) { g.log?.(`[fleet] harbour relocation failed: ${e.message}`); }
    for (const v of this.vessels.values()) {
      if (this.isAboard(v)) continue;
      const a = this.actorOf(v);
      try { if (typeof g.migratePlayer === 'function') g.migratePlayer(a); } catch (e) { g.log?.(`[fleet] migrate ${v.id} failed: ${e.message}`); }
      a.warp = 1;
      if (v.status === 'laidup') { v.storagePaidTo = (Number.isFinite(v.storagePaidTo) && v.storagePaidTo > 0 ? v.storagePaidTo : g.simTime) + down; continue; }
      if (v.cap && v.cap.phase === 'planning') { v.cap.phase = 'idle'; v.cap.why = null; }
      if (!v.cap) v.cap = captain.newCap(g, v.docked ? 'idle' : 'idle');
    }
    for (const p of g.byId.values()) if (p.office) this.m0.set(p.id, p.money);
  }
  /** findOrCreatePlayer: the new person's first ship, exactly the values today's literal gave the person (§11.2). */
  createFirstVessel(p, { cls = 'coaster', spawn, berth = null, harbor = START_HARBOR } = {}) {
    const g = this.game, sim = g.simTime, C = clsOf(cls);
    const want = typeof p.id === 'string' && /^[0-9a-z]{1,15}$/.test(p.id) ? 'v' + p.id : null;
    const v = this.makeVessel(p.id, {
      id: want && !this.vessels.has(want) ? want : this.newId(), name: defaultShipName([]),
      ship: { cls, lat: spawn.lat, lon: spawn.lon, hdg: berth ? berth.hdg : 0, spd: 0, throttle: 0, rudder: 0 },
      cond: 100, fuel: C.fuelCap, kits: 1, docked: harbor, dockedAt: sim, berth: berth || null, serviceDue: sim + SERVICE_INTERVAL_S, shipTime: sim, acquiredAt: Math.floor(sim),
    });
    v.flooding = 0; v.assist = null; v.lastValid = { lat: spawn.lat, lon: spawn.lon };
    p.fleet = [v]; p.aboard = v.id; p.office = newOffice(harbor);
    this.game.politics?.newVesselFlag(p, v, { builtIn: harborById(harbor)?.country || null });   // shipyard country = builtIn (§4.10)
    bindPlayer(p, this); this.index(v);
    this.m0.set(p.id, p.money);
    return v;
  }

  // ------------------------------------------------------------------------------------------------ money (§3.6)
  actorMoney(a, x) {
    const p = a.owner; if (!p || !p.office || !Number.isFinite(x)) return;
    let amt = Math.round(x - p.money);
    if (p.money + amt < 0) amt = -Math.floor(p.money);          // cash never below 0 (I6)
    if (amt === 0) return;
    // _cat: a category, or a list consumed one per cost (tow: ['tugs', 'port'] = the tow, then the dues on arrival)
    let cat = a._cat;
    if (Array.isArray(cat)) cat = amt < 0 && cat.length > 1 ? cat.shift() : cat[0];
    this.book(p, a.id, amt > 0 ? 'income' : (LEDGER_CATS.includes(cat) ? cat : 'costs'), amt);
  }
  /** The ONLY way fleet code changes money. */
  book(p, vid, cat, amt) {
    if (!Number.isSafeInteger(amt) || amt === 0 || !LEDGER_CATS.includes(cat)) throw new Error(`book: bad ${cat} ${amt}`);
    p.money += amt; this.m0.set(p.id, (this.m0.get(p.id) ?? p.money - amt) + amt);
    this.addDay(p, vid, cat, amt);
  }
  addDay(p, vid, cat, amt) {
    const day = dayKey(this.game.simTime), days = p.office.book.days, d = (days[day] ||= {}), row = (d[vid] ||= {});
    row[cat] = (row[cat] || 0) + amt;
    this.pruneDays(p); this.dirty(p);
  }
  pruneDays(p) {
    const days = p.office.book.days, keys = Object.keys(days);
    if (keys.length <= FLEET.LEDGER_DAYS) return;
    keys.sort();
    for (const k of keys.slice(0, keys.length - FLEET.LEDGER_DAYS)) delete days[k];
  }
  /** Forced costs (wages, storage, berth days): pay what the cash covers, the rest becomes owed (F6). */
  charge(p, vid, cat, amt) {
    amt = Math.round(amt);
    if (!(amt > 0) || !p.office) return;
    const can = Math.min(amt, Math.max(0, Math.floor(p.money)));
    if (can > 0) this.book(p, vid, cat, -can);
    if (amt > can) { p.office.owed = Math.min(this.owedCap(p, amt - can), p.office.owed + (amt - can)); this.dirty(p); }
  }
  /** 30 days of storage + wages at today's rates (at least the bill being charged now, so a ship that just went idle does
   *  not wipe her own last bill). */
  owedCap(p, atLeast = 0) {
    let perDay = 0;
    for (const v of p.fleet || []) {
      if (v.status === 'laidup') perDay += storageFeePerDay(v.ship.cls);
      else if (p.aboard !== v.id) perDay += 24 * wageRateMcrH(v.ship.cls, captain.dutyOf(v), !!v.towing) / 1000;
    }
    return Math.max(Math.round(FLEET.OWED_CAP_DAYS * perDay), Math.round(atLeast), Math.round(p.office.owed || 0));
  }
  /** Once per tick: the aboard ship's money changes (existing code changes p.money directly) go to her in whole credits. */
  driftBook(p) {
    const m0 = this.m0.get(p.id);
    if (m0 === undefined || !Number.isFinite(m0)) { this.m0.set(p.id, p.money); return; }
    const d = p.money - m0;
    if (d === 0 || !Number.isFinite(d)) return;
    this.m0.set(p.id, p.money);
    const b = p.office.book;
    b.rem = (b.rem || 0) + d;
    const whole = Math.trunc(b.rem);
    if (whole) { this.addDay(p, p.aboard, whole > 0 ? 'income' : 'costs', whole); b.rem -= whole; }
  }
  payOwed(p) {
    const o = p.office;
    if (!(o.owed > 0) || !(p.money >= 1)) return;
    const pay = Math.min(o.owed, Math.floor(p.money));
    this.book(p, '_', 'arrears', -pay); o.owed -= pay;
    if (!o.owed) this.logLine(p, 'info', `Office: unpaid bills settled (${fmt(pay)} cr).`, null);
  }

  // ------------------------------------------------------------------------------------------------ events and messages
  dirty(p) { if (p && p.id) this.changed.add(p.id); }
  logLine(p, kind, text, vid) {
    const o = p.office; if (!o) return;
    o.log.push({ t: Math.floor(this.game.simTime), kind: kind === 'info' ? 'info' : 'warn', text, vid: vid || null });
    if (o.log.length > FLEET.LOG_MAX) o.log.splice(0, o.log.length - FLEET.LOG_MAX);
    o.unread = Math.min(999, (o.unread || 0) + 1);
    this.dirty(p);
  }
  /** game.event(actor, …) lands here (§7.11). */
  actorEvent(a, kind, text, extra = {}) {
    const v = a.vessel, p = a.owner; if (!p || !p.office) return;
    const line = `${v.name}: ${text}`;
    this.logLine(p, kind, line, v.id);
    if (kind === 'info' && QUIET.test(String(text))) return;
    this.game.event(p, kind, line, { ...extra, vesselId: v.id, vesselName: v.name, fleet: true });
  }
  /** A captain's own line about her ship. */
  note(v, kind, text) { this.actorEvent(this.actorOf(v), kind, text); }
  /** An office line the person also sees live (purchases, sales, lay-ups, switches). */
  tell(p, kind, text, v = null) {
    this.logLine(p, kind, text, v ? v.id : null);
    this.game.event(p, kind, text, v ? { vesselId: v.id, vesselName: v.name, fleet: true } : { fleet: true });
  }
  warn(p, text) { this.game.event(p, 'warn', text); return false; }
  sendFleet(p) {
    if (!p || !p.office || p.isActor) return;
    this.sentAt.set(p.id, Date.now()); this.changed.delete(p.id);
    this.game.send(p, { t: 'fleet', fleet: this.fleetView(p) });
  }
  /** After an action: the person's `fleet`, `you` and (docked) `harbor`. */
  refresh(p, { you = true, harbor = true } = {}) {
    this.sendFleet(p);
    if (you) this.game.sendYou(p);
    if (harbor && p.docked) this.game.sendHarbor(p);
  }

  // ------------------------------------------------------------------------------------------------ actions (§10)
  handles(a) { return ACTIONS.includes(a) && (a !== 'fleet_debug' || process.env.SALTLINE_DEBUG === '1'); }
  /** Token bucket per person: 10/s, burst 20; excess ignored silently. */
  allow(p) {
    const now = Date.now();
    let b = this.buckets.get(p.id);
    if (!b) { b = { t: FLEET.ACTION_BURST, at: now }; this.buckets.set(p.id, b); }
    b.t = Math.min(FLEET.ACTION_BURST, b.t + ((now - b.at) / 1000) * FLEET.ACTION_RATE); b.at = now;
    if (b.t < 1) return false;
    b.t -= 1; return true;
  }
  onAction(p, m) {
    const a = m && typeof m === 'object' ? m.action : null;
    if (!p || !p.office) return;
    if (!this.handles(a)) return this.warn(p, `Unknown action ${String(a).slice(0, 40)}`);
    if (!this.allow(p)) return;
    try {
      switch (a) {
        case 'switch_ship': return this.switchShip(p, m);
        case 'fleet_order': return this.orderAction(p, m);
        case 'fleet_accept': return this.acceptAction(p, m);
        case 'fleet_board': return this.boardAction(p, m);
        case 'fleet_service': return this.serviceAction(p, m);
        case 'fleet_rename': return this.renameAction(p, m);
        case 'fleet_layup': return this.layUpAction(p, m);
        case 'fleet_recommission': return this.recommissionAction(p, m);
        case 'fleet_sell': return this.sellAction(p, m);
        case 'fleet_transfer': return this.transferAction(p, m);
        case 'fleet_move_job': return this.moveJobAction(p, m);
        case 'fleet_slot': return this.slotAction(p);
        case 'fleet_home': return this.homeAction(p, m);
        case 'hq_watch': if (m.on === true) this.watching.add(p.id); else this.watching.delete(p.id); return this.sendFleet(p);
        case 'fleet_seen': p.office.unread = 0; return this.sendFleet(p);
        case 'fleet_debug': return this.debugAction(p, m);
        default: return undefined;
      }
    } catch (e) {
      this.game.log?.(`[fleet] action ${a} failed: ${e.stack || e}`);
      this.warn(p, 'That did not work.');
    }
  }
  /** The vessel `id` if it is p's, else null (and the caller refuses with "That is not your ship."). */
  own(p, id) {
    if (typeof id !== 'string' || id.length > 20 || !VESSEL_ID_RE.test(id)) return null;
    const v = this.vessels.get(id);
    return v && v.ownerId === p.id ? v : null;
  }
  notYours(p) { return this.warn(p, 'That is not your ship.'); }

  // --- buying and selling (§5)
  buyShip(p, m) {
    if (m && m.tradeIn === false) return this.buyNew(p, m);
    const before = p.vessel, oldCls = p.ship.cls, oldName = before.name;
    this.game.buyShip(p, m && m.cls);
    if (p.ship.cls !== oldCls) this.lostLine(p, { id: before.id, name: oldName, cls: oldCls, how: 'traded' });
    this.sendFleet(p);
  }
  buyUsed(p, m) {
    if (m && m.tradeIn === false) return this.buyNew(p, m, true);
    const before = p.vessel, oldCls = p.ship.cls, oldName = before.name;
    this.game.buyUsedShip(p, m && m.listingId);
    if (p.ship.cls !== oldCls) this.lostLine(p, { id: before.id, name: oldName, cls: oldCls, how: 'traded' });
    this.sendFleet(p);
  }
  lostLine(p, l) {
    p.office.lost.push({ id: l.id, name: l.name, cls: l.cls, how: l.how, at: Math.floor(this.game.simTime) });
    if (p.office.lost.length > FLEET.LOST_MAX) p.office.lost.splice(0, p.office.lost.length - FLEET.LOST_MAX);
    this.dirty(p);
  }
  /** §5.1 tradeIn === false: a new (or second-hand) ship delivered in this harbour; the aboard one is not touched. */
  buyNew(p, m, used = false) {
    if (!used && m && typeof m.stockId === 'string' && this.game.yard) return this.game.yard.action(p, { ...m, action: 'yard_buy_stock' });   // SHIPYARD H8
    const g = this.game;
    if (!p.docked) return this.warn(p, 'Moor in a harbour to buy a ship.');
    const h = harborById(p.docked), st = g.harbors[h.id];
    if (p.office.owed > 0) return this.warn(p, `Settle the office's unpaid bills first (${fmt(p.office.owed)} cr).`);
    if (vesselSlotsUsed(p) >= FLEET.MAX_VESSELS) return this.warn(p, `Your fleet is full (${FLEET.MAX_VESSELS} ships and orders). Sell or trade in a ship first.`);
    let cls, price, cond = 100, listing = null;
    if (used) {
      listing = (st?.used || []).find((x) => x && x.id === m.listingId);
      if (typeof m.listingId !== 'string' || !listing) return this.warn(p, 'That hull was sold.');
      cls = listing.cls; price = Math.round(listing.price); cond = listing.cond;
    } else {
      cls = typeof m.cls === 'string' ? m.cls : '';
      if (!Object.prototype.hasOwnProperty.call(SHIP_CLASSES, cls) || !(SHIP_CLASSES[cls].price > 0)) return this.warn(p, 'The yard does not build that.');   // SHIPYARD: catalogue models are ordered at a yard (H1 resolves them, the legacy buy path does not sell them)
      price = SHIP_CLASSES[cls].price;
    }
    const C = clsOf(cls);
    if (Math.floor(p.money) < price) return this.warn(p, `${used ? `A second-hand ${C.name} (${cond} %)` : capital(aName(C.name))} costs ${fmt(price)} cr. You have ${fmt(Math.floor(p.money))}.`);
    const names = p.fleet.map((v) => v.name);
    let name = validShipName(m.name);
    if (!name || names.some((n) => n.toLowerCase() === name.toLowerCase())) name = defaultShipName(names);
    const id = this.newId();
    this.book(p, id, 'ships', -price);
    const spot = this.freeBerth(h, cls);
    const sim = g.simTime;
    const v = this.makeVessel(p.id, {
      id, name, ship: { cls, lat: spot.lat, lon: spot.lon, hdg: spot.hdg ?? 0, spd: 0, throttle: 0, rudder: 0 },
      cond, fuel: r1(FLEET.NEW_FUEL_FRAC * C.fuelCap), kits: 0, docked: h.id, dockedAt: sim, berth: spot.berth ? berthRef(h, spot.berth, spot.hdg) : null,
      serviceDue: used ? sim + SERVICE_INTERVAL_S * (0.2 + 0.6 * (cond / 100)) : sim + SERVICE_INTERVAL_S, shipTime: sim, acquiredAt: Math.floor(sim), acquiredPrice: price,
    });
    v.cap = captain.newCap(g, 'idle');
    this.game.politics?.newVesselFlag(p, v, { builtIn: h.country || null });   // the yard's (or listing's) country = builtIn (§4.10)
    p.fleet.push(v); this.index(v);
    if (listing) st.used = st.used.filter((x) => x !== listing);
    const where = spot.berth ? `moored at ${short(h.name)}, ${spot.berth.name}` : `lying at ${short(h.name)} anchorage`;
    this.tell(p, 'info', `Took delivery of ${aName(C.name)}, ${name}, ${where}. Your ${clsOf(p.ship.cls).name} stays yours.`, v);
    if (m.sendHome === true && h.id !== p.office.home) captain.setOrder(this, v, { type: 'home', then: 'moor' });
    this.refresh(p);
    return v;
  }
  sellAction(p, m) {
    const v = this.own(p, m.vesselId); if (!v) return this.notYours(p);
    if (p.aboard === v.id) return this.warn(p, `You are aboard ${v.name} — go aboard another ship to sell her, or sell her at the yard.`);
    if (!v.docked) return this.warn(p, `${v.name} must be moored in a harbour to be sold.`);
    if (v.assist) return this.warn(p, 'The tugs have her — wait until she is alongside.');
    if (v.cargo.length) return this.warn(p, `Unload her first (${fmt(cargoMass(v.cargo))} t aboard).`);
    if (v.jobs.length) return this.warn(p, 'Finish or hand over her contracts first.');
    const g = this.game, C = clsOf(v.ship.cls);
    if (v.status === 'laidup') this.chargeStorage(p, v, true);
    else if (v.docked !== p.office.home) {
      const days = Math.max(1, Math.ceil((g.simTime - (v.dockedAt || g.simTime)) / 86400));
      this.charge(p, v.id, 'port', days * berthFeePerDay(v.ship.cls));
    }
    const value = v.ship.cls === 'coaster' && !(SHIP_CLASSES.coaster.price > 0) ? 0 : marketValue(v, harborById(v.docked)?.country ?? null, Math.floor(g.simTime));   // SHIPYARD §4.5
    if (value > 0) this.book(p, v.id, 'ships', value);
    this.removeVessel(p, v, value > 0 ? 'sold' : 'scrapped');
    this.tell(p, 'info', value > 0 ? `Sold ${v.name} (${C.name}, ${Math.round(v.cond)} %) for ${fmt(value)} cr.` : `Scrapped ${v.name} (the yard pays nothing for ${aName(C.name.toLowerCase())}).`);
    this.refresh(p);
  }
  removeVessel(p, v, how) {
    p.fleet = p.fleet.filter((x) => x !== v);
    this.unindex(v);
    this.lostLine(p, { id: v.id, name: v.name, cls: v.ship.cls, how });
  }

  // --- office (§6)
  laidUpCount(p) { return p.fleet.filter((v) => v.status === 'laidup').length; }
  layUpWhy(p, v) {
    const home = harborById(p.office.home);
    if (p.aboard === v.id) return `You are aboard ${v.name} — go aboard another ship first.`;
    if (v.status === 'laidup') return `${v.name} is already laid up.`;
    if (v.docked !== p.office.home || v.assist) return `Lay up only at your home harbour, ${short(home?.name || p.office.home)}.`;
    if (v.cargo.length) return `Unload her first (${fmt(cargoMass(v.cargo))} t aboard).`;
    if (v.jobs.length) return 'Finish or hand over her contracts first.';
    const used = this.laidUpCount(p);
    if (used >= p.office.slots) return `Boat storage is full (${used} of ${p.office.slots}). Buy a place for ${fmt(FLEET.SLOT_PRICE)} cr or recommission a ship.`;
    return null;
  }
  layUpVessel(p, v) {
    const why = this.layUpWhy(p, v);
    if (why) return why;
    const sim = this.game.simTime;
    v.status = 'laidup'; v.orders = null; v.cap = null; v.voyage = null; v.fishing = false; v.laidUpAt = sim; v.storagePaidTo = sim;
    v.ship.spd = 0; v.ship.throttle = 0; v.ship.rudder = 0;
    this.rtOf(v).gen++;
    this.tell(p, 'info', `${v.name} laid up at ${short(harborById(v.docked)?.name)} — storage ${fmt(storageFeePerDay(v.ship.cls))} cr a day, no wages.`, v);
    this.dirty(p);
    return null;
  }
  layUpAction(p, m) {
    const v = this.own(p, m.vesselId); if (!v) return this.notYours(p);
    const why = this.layUpVessel(p, v);
    if (why) return this.warn(p, why);
    this.refresh(p, { you: false });
  }
  /** Storage owed for a laid-up ship up to now: whole days (`ceil` = the started day too). */
  chargeStorage(p, v, started) {
    const sim = this.game.simTime, f = storageFeePerDay(v.ship.cls);
    const raw = (sim - (v.storagePaidTo || sim)) / 86400;
    const days = started ? Math.max(0, Math.ceil(raw - 1e-9)) : Math.max(0, Math.floor(raw));
    if (days < 1) return 0;
    this.charge(p, v.id, 'storage', days * f);
    v.storagePaidTo += days * 86400;
    return days * f;
  }
  recommissionAction(p, m) {
    const v = this.own(p, m.vesselId); if (!v) return this.notYours(p);
    if (v.status !== 'laidup') return this.warn(p, `${v.name} is not laid up.`);
    const fee = recommissionFee(v.ship.cls);
    const due = Math.max(0, Math.ceil((this.game.simTime - (v.storagePaidTo || this.game.simTime)) / 86400 - 1e-9)) * storageFeePerDay(v.ship.cls);
    if (p.office.owed > 0) return this.warn(p, `Settle the office's unpaid bills first (${fmt(p.office.owed)} cr).`);
    if (Math.floor(p.money) < fee + due) return this.warn(p, `Recommissioning ${v.name} costs ${fmt(fee + due)} cr. You have ${fmt(Math.floor(p.money))}.`);
    this.chargeStorage(p, v, true);
    this.book(p, v.id, 'fees', -fee);
    v.status = 'active'; v.laidUpAt = 0; v.storagePaidTo = 0; v.orders = null; v.cap = captain.newCap(this.game, 'idle');
    this.tell(p, 'info', `${v.name} recommissioned for ${fmt(fee)} cr. Her captain is aboard and waiting for orders.`, v);
    this.refresh(p, { you: false });
  }
  slotAction(p) {
    const o = p.office;
    if (p.docked !== o.home) return this.warn(p, `Buy storage places at your home harbour, ${short(harborById(o.home)?.name)}.`);
    if (o.slots >= FLEET.SLOTS_MAX) return this.warn(p, `Boat storage is at its maximum (${FLEET.SLOTS_MAX} places).`);
    if (o.owed > 0) return this.warn(p, `Settle the office's unpaid bills first (${fmt(o.owed)} cr).`);
    if (Math.floor(p.money) < FLEET.SLOT_PRICE) return this.warn(p, `A storage place costs ${fmt(FLEET.SLOT_PRICE)} cr. You have ${fmt(Math.floor(p.money))}.`);
    this.book(p, '_', 'fees', -FLEET.SLOT_PRICE);
    o.slots++;
    this.tell(p, 'info', `Bought a storage place at ${short(harborById(o.home)?.name)} — ${o.slots} places now.`);
    this.refresh(p);
  }
  /** true, or why the office cannot move to harbour h now; with the cost. */
  homeMove(p, h) {
    const o = p.office, cost = o.homeMoves === 0 ? 0 : FLEET.HOME_MOVE_CR, sim = this.game.simTime;
    if (!h) return { allowed: 'Moor in the harbour you want as your home.', cost };
    if (o.home === h.id) return { allowed: `${short(h.name)} is already your home.`, cost };
    if (!homeAllowed(h)) return { allowed: 'Small ports cannot host an office — pick a regional, major or mega port.', cost };
    if (this.laidUpCount(p)) return { allowed: 'Recommission or sell your laid-up ships first.', cost };
    if (o.homeMoves > 0 && sim - o.homeSetAt < FLEET.HOME_MOVE_COOLDOWN_S) {
      const ago = Math.floor((sim - o.homeSetAt) / 86400), left = Math.max(1, Math.ceil((o.homeSetAt + FLEET.HOME_MOVE_COOLDOWN_S - sim) / 86400));
      return { allowed: `You moved your office ${ago === 0 ? 'today' : ago === 1 ? '1 day ago' : `${ago} days ago`} — next move possible in ${left} day${left > 1 ? 's' : ''}.`, cost };
    }
    if (cost > 0 && o.owed > 0) return { allowed: `Settle the office's unpaid bills first (${fmt(o.owed)} cr).`, cost };
    if (cost > 0 && Math.floor(p.money) < cost) return { allowed: `Moving the office costs ${fmt(cost)} cr. You have ${fmt(Math.floor(p.money))}.`, cost };
    return { allowed: true, cost };
  }
  homeAction(p, m) {
    if (typeof m.harbor !== 'string' || !isHarbor(m.harbor)) return this.warn(p, 'Pick a harbour.');
    if (p.docked !== m.harbor) return this.warn(p, `Moor in ${short(harborById(m.harbor).name)} to move your office there.`);
    const h = harborById(m.harbor), hm = this.homeMove(p, h);
    if (hm.allowed !== true) return this.warn(p, hm.allowed);
    if (this.game.politics) {
      const r = this.game.politics.homeStart(p, h, { baseCost: hm.cost });   // books move + formation + re-flags, starts the wait
      if (!r.ok) return this.warn(p, r.text);
      return this.refresh(p);
    }
    if (hm.cost > 0) this.book(p, '_', 'fees', -hm.cost);
    const o = p.office;
    o.home = h.id; o.homeSetAt = this.game.simTime; o.homeMoves++;
    this.tell(p, 'info', `Your office is now at ${short(h.name)}${hm.cost ? ` (${fmt(hm.cost)} cr)` : ''}. No berth fees here for your ships.`);
    this.refresh(p);
  }
  renameAction(p, m) {
    const v = this.own(p, m.vesselId); if (!v) return this.notYours(p);
    const raw = typeof m.name === 'string' ? m.name.slice(0, 64) : '';
    const name = validShipName(raw);
    if (!name) return this.warn(p, "Ship names are 2–24 letters or digits (spaces, ' . - allowed).");
    if (p.fleet.some((x) => x !== v && x.name.toLowerCase() === name.toLowerCase())) return this.warn(p, `You already have a ship called ${name}.`);
    if (name === v.name) return;
    const old = v.name; v.name = name;
    this.tell(p, 'info', `${old} is now ${name}.`, v);
    this.refresh(p, { harbor: false });
  }

  // --- transfers in one harbour (§6.7)
  transferAction(p, m) {
    const a = this.own(p, m.fromId), b = this.own(p, m.toId);
    if (!a || !b) return this.notYours(p);
    if (a === b) return this.warn(p, 'Pick two different ships.');
    if (a.status === 'laidup' || b.status === 'laidup') return this.warn(p, 'Laid-up ships carry nothing — recommission her first.');
    if (!a.docked || a.docked !== b.docked || a.assist || b.assist) return this.warn(p, 'Both ships must be moored in the same harbour.');
    const good = m.good;
    if (typeof good !== 'string' || !Object.prototype.hasOwnProperty.call(GOODS, good)) return this.warn(p, 'Unknown cargo.');
    const qty = typeof m.qty === 'number' ? m.qty : Number.NaN;
    if (!Number.isFinite(qty) || !(qty > 0)) return this.warn(p, 'Say how many tonnes.');
    if (a.cargo.some((c) => c.good === good && c.jobId) && !a.cargo.some((c) => c.good === good && !c.jobId)) return this.warn(p, 'Contract cargo moves with its contract — use "Move contract".');
    const stacks = a.cargo.filter((c) => c.good === good && !c.jobId);
    const have = stacks.reduce((s, c) => s + c.qty, 0);
    const caught = stacks.length > 0 && stacks.every((c) => c.caught);
    const q = caught ? Math.round(qty * 10) / 10 : Math.round(qty);
    if (!(q > 0)) return this.warn(p, 'Say how many tonnes.');
    if (q > have + 1e-6) return this.warn(p, `${a.name} only has ${fmtT(have)} of ${GOODS[good].name}.`);
    const free = clsOf(b.ship.cls).capacity - cargoMass(b.cargo);
    if (q > free + 1e-6) return this.warn(p, `No room aboard ${b.name} (${fmtT(Math.max(0, free))} free).`);
    let left = q;
    for (const c of stacks) {
      if (left <= 1e-9) break;
      const k = Math.min(c.qty, left); c.qty = c.caught ? Math.round((c.qty - k) * 1e6) / 1e6 : c.qty - k; left -= k;
      const dst = b.cargo.find((x) => x.good === good && !x.jobId && !!x.contraband === !!c.contraband && !!x.caught === !!c.caught && (x.origin ?? null) === (c.origin ?? null));
      if (dst) dst.qty += k; else b.cargo.push({ good, qty: k, contraband: !!c.contraband, jobId: null, ...(c.caught ? { caught: true } : {}), ...(c.origin != null ? { origin: c.origin } : {}) });
    }
    a.cargo = a.cargo.filter((c) => c.qty > 1e-6);
    this.tell(p, 'info', `Moved ${fmtT(q)} of ${GOODS[good].name} from ${a.name} to ${b.name}.`, b);
    this.refresh(p);
  }
  moveJobAction(p, m) {
    const a = this.own(p, m.fromId), b = this.own(p, m.toId);
    if (!a || !b) return this.notYours(p);
    if (a === b) return this.warn(p, 'Pick two different ships.');
    if (typeof m.jobId !== 'string' || !JOB_ID_RE.test(m.jobId)) return this.warn(p, 'Unknown contract.');
    if (a.status === 'laidup' || b.status === 'laidup') return this.warn(p, 'Laid-up ships carry nothing — recommission her first.');
    if (!a.docked || a.docked !== b.docked || a.assist || b.assist) return this.warn(p, 'Both ships must be moored in the same harbour.');
    const job = a.jobs.find((j) => j && j.id === m.jobId);
    if (!job) return this.warn(p, `${a.name} does not hold that contract.`);
    if (a.towing === job.id || (job.type === 'tow' && job.pickedUp)) return this.warn(p, 'A tow on the line stays with her ship.');
    if (job.type === 'supply' && job.loaded === false) return this.warn(p, 'Those supplies are already delivered.');
    if (p.aboard !== b.id) { const r = captainRefusalFor(this.game, p, b, job); if (r) return this.warn(p, r); }
    const Cb = clsOf(b.ship.cls);
    const stack = a.cargo.find((c) => c.jobId === job.id);
    const paxUsed = b.jobs.filter((j) => j.pax).reduce((s, j) => s + j.pax, 0);
    const why = hardReason(job, { cls: b.ship.cls, holdFreeT: Cb.capacity - cargoMass(b.cargo), paxFree: Cb.pax - paxUsed });
    if (why) return this.warn(p, `${b.name} cannot take it: ${why}.`);
    a.jobs = a.jobs.filter((j) => j !== job);
    if (stack) { a.cargo = a.cargo.filter((c) => c !== stack); b.cargo.push(stack); }
    if (Number.isFinite(job.dueShip) && Number.isFinite(a.shipTime) && Number.isFinite(b.shipTime)) job.dueShip = b.shipTime + (job.dueShip - a.shipTime);
    b.jobs.push(job);
    this.tell(p, 'info', `${job.title}: handed over from ${a.name} to ${b.name}.`, b);
    this.refresh(p);
  }

  // --- orders, contracts, services (§7)
  needsDeparture(v, o) {
    if (!o) return false;
    if (o.type === 'stop') return false;
    if (o.type === 'hold') return !!v.docked && o.lat != null;
    if ((o.type === 'sail_to') && v.docked === o.harbor) return o.then === 'hold';
    return true;
  }
  orderWhy(p, v, o) {
    if (v.status !== 'active') return `${v.name} is laid up — recommission her first.`;
    if (p.aboard === v.id) return `You are aboard ${v.name} — she follows your helm.`;
    const home = p.office.home;
    if ((o.type === 'sail_to' && o.then === 'lay_up' && o.harbor !== home)) return `Lay up only at your home harbour, ${short(harborById(home)?.name)}.`;
    if (o.type === 'hold' && o.lat != null && haversine(v.ship.lat, v.ship.lon, o.lat, o.lon) > FLEET.HOLD_MAX_KM * 1000) return `That position is more than ${FLEET.HOLD_MAX_KM} km from ${v.name}.`;
    if (o.type === 'contract') {
      if (o.jobId != null && !v.jobs.some((j) => j.id === o.jobId)) return `${v.name} does not hold that contract.`;
      if (o.jobId == null && !v.jobs.length) return `${v.name} has no contracts aboard.`;
      for (const j of v.jobs) if ((o.jobId == null || j.id === o.jobId) && j.type === 'tow' && v.towing !== j.id) return 'Captains do not take tows — sail her yourself.';
    }
    if (this.needsDeparture(v, o)) {
      if (p.office.owed > 0) return "Settle the office's unpaid bills first.";
      if (v.cargo.some((c) => c.contraband)) return 'No captain will carry that — unload the contraband first.';
    }
    return null;
  }
  orderAction(p, m) {
    const v = this.own(p, m.vesselId); if (!v) return this.notYours(p);
    const n = normalizeOrder(m.order, isHarbor);
    if (!n.ok) return this.warn(p, n.why);
    const why = this.orderWhy(p, v, n.order);
    if (why) return this.warn(p, why);
    captain.setOrder(this, v, n.order);
    this.note(v, 'info', `orders received — ${captain.orderText(this, v, n.order)}.`);
    this.refresh(p, { you: false, harbor: false });
  }
  boardAction(p, m) {
    const v = this.own(p, m.vesselId); if (!v) return this.notYours(p);
    if (!v.docked) return this.warn(p, `${v.name} is at sea — contracts are signed at the quay.`);
    const g = this.game, h = harborById(v.docked), st = g.harbors[h.id];
    if (!st) return;
    try { g.regenHarbor?.(h, st, false); g.jobsx?.ensureFit(st.jobs, h, v, g.simTime, g.rnd, g.jobEnv(), { phase: 2 }); } catch { /* keep the board as it is */ }
    const C = clsOf(v.ship.cls), paxUsed = v.jobs.filter((j) => j.pax).reduce((s, j) => s + j.pax, 0);
    const ship = { cls: v.ship.cls, holdFreeT: C.capacity - cargoMass(v.cargo), paxFree: C.pax - paxUsed, warp: 1 };
    const jobs = (st.jobs || []).filter(Boolean).map((j) => ({ ...publicJob(j), est: estimateJob(j, ship), why: hardReason(j, ship) || captainRefusalFor(g, p, v, j) || null }));
    g.send(p, { t: 'fleet_board', vesselId: v.id, harbor: h.id, harborName: h.name, jobs });
  }
  acceptAction(p, m) {
    const v = this.own(p, m.vesselId); if (!v) return this.notYours(p);
    if (v.status !== 'active') return this.warn(p, `${v.name} is laid up — recommission her first.`);
    if (p.aboard === v.id) return this.warn(p, 'Sign contracts for the ship you are aboard on the harbour board.');
    if (!v.docked || v.assist) return this.warn(p, `${v.name} is at sea — contracts are signed at the quay.`);
    if (typeof m.jobId !== 'string' || !JOB_ID_RE.test(m.jobId)) return this.warn(p, 'Unknown contract.');
    if (p.office.owed > 0) return this.warn(p, "Settle the office's unpaid bills first.");
    const st = this.game.harbors[v.docked], job = (st?.jobs || []).find((j) => j && j.id === m.jobId);
    if (!job) return this.warn(p, 'That contract is gone.');
    const r = captainRefusalFor(this.game, p, v, job); if (r) return this.warn(p, r);
    const then = m.then === 'home' ? 'home' : 'stay';
    const a = this.actorOf(v);
    this.game.acceptJob(a, m.jobId);
    if (!v.jobs.some((j) => j.id === m.jobId)) { this.refresh(p, { you: false }); return; }  // the game said why (capacity, berths, …)
    captain.setOrder(this, v, { type: 'contract', jobId: m.jobId, then });
    this.refresh(p, { you: false });
  }
  serviceAction(p, m) {
    const v = this.own(p, m.vesselId); if (!v) return this.notYours(p);
    if (p.aboard === v.id) return this.warn(p, 'Use the harbour services for the ship you are aboard.');
    if (!v.docked || v.assist) return this.warn(p, `${v.name} must be moored for the yard to work on her.`);
    const g = this.game, a = this.actorOf(v);
    if (m.what === 'fuel') {
      const t = m.tonnes == null ? undefined : Number(m.tonnes);
      if (t !== undefined && !(Number.isFinite(t) && t > 0)) return this.warn(p, 'Say how many tonnes.');
      a._cat = 'fuel'; try { g.buyFuel(a, t === undefined ? Infinity : t); } finally { a._cat = null; }
    } else if (m.what === 'repair') { a._cat = 'repairs'; try { g.repair(a); } finally { a._cat = null; } }
    else if (m.what === 'service') { a._cat = 'repairs'; try { g.service(a); } finally { a._cat = null; } }
    else return this.warn(p, 'Fuel, repair or service?');
    this.refresh(p, { you: false });
  }
  debugAction(p, m) {
    const g = this.game, op = m.op;
    if (op === 'money') { const amt = Math.round(Number(m.amount)); if (Number.isSafeInteger(amt) && amt !== 0 && p.money + amt >= 0) { p.money += amt; this.m0.set(p.id, p.money); } }
    else if (op === 'place') {
      const v = this.own(p, m.vesselId), lat = Number(m.lat), lon = Number(m.lon);
      if (!v || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85) return this.warn(p, 'place: vesselId, lat, lon');
      if (v.status === 'laidup') return this.warn(p, 'place: recommission her first');
      Object.assign(v.ship, { lat, lon, spd: 0, throttle: 0, rudder: 0 });
      v.docked = null; v.dockedAt = null; v.berth = null; v.assist = null; v.voyage = null; v.lastValid = { lat, lon };
      if (p.aboard !== v.id) captain.setOrder(this, v, { type: 'hold' });
      else g.sendYou(p, { correction: true });
    } else if (op === 'advance') {
      const v = this.own(p, m.vesselId), s = Number(m.seconds);
      if (!v || !Number.isFinite(s) || s <= 0 || s > 86400) return this.warn(p, 'advance: vesselId, seconds ≤ 86400');
      if (p.aboard === v.id) return this.warn(p, 'advance: not the ship you are aboard');
      return this.advance(v, s, 1, { clock: false }).then(() => this.sendFleet(p));
    } else if (op === 'storm') {
      const lat = Number(m.lat), lon = Number(m.lon), radiusKm = Number(m.radiusKm), intensity = Number(m.intensity);
      if (![lat, lon, radiusKm, intensity].every(Number.isFinite)) return this.warn(p, 'storm: lat, lon, radiusKm, intensity');
      const now = g.simTime;
      g.storms.push({ id: 's' + crypto.randomBytes(4).toString('hex'), lat, lon, radiusKm, peak: intensity, intensity, driftDir: 0, driftMs: 0, born: now - 3600, dies: now + 7200, region: false, name: typeof m.name === 'string' && m.name.trim() ? m.name.trim().slice(0, 20) : 'Debug' });
    } else if (op === 'give') {   // SHIPYARD (debug): a finished catalogue ship at the harbour you are moored in
      const h = harborById(p.docked);
      if (!h || !g.yard || typeof m.variant !== 'string' || !SHIP_CLASSES[m.variant]?.length || vesselSlotsUsed(p) >= FLEET.MAX_VESSELS) return this.warn(p, 'give: moored, variant, fleet room');
      const yr = new Date(g.simTime * 1000).getUTCFullYear(), cc = h.country || 'XX';
      g.yard.createVessel(p, h, { variant: m.variant, name: m.name, price: 0, yardId: null, builtIn: cc, hist: { v: 1, built: yr, builtAt: g.simTime, yard: null, builtIn: cc, hull: 'DBG', class: 'LR', owners: 1, lastDock: g.simTime, nextSpecial: yr + 5, incidents: [], runHours: 0, estimated: false, jonesLost: false, rebuiltAbroad: false, warrantyTo: 0, specialist: false } });
    } else return this.warn(p, 'fleet_debug: money | place | advance | storm | give');
    this.sendFleet(p);
  }
  /** Test / debug helper: step her captain in `step`-second steps for `seconds` of world time (awaits route plans). */
  //  clock: true (tests) moves game.simTime along; the live debug action leaves the world clock alone.
  async advance(v, seconds, step = 1, { clock = true } = {}) {
    const g = this.game;
    let left = seconds;
    while (left > 1e-9 && this.vessels.has(v.id)) {
      const h = Math.min(step, left); left -= h;
      if (clock) g.simTime += h;
      captain.stepVessel(this, v, h);
      const rt = this.rtOf(v);
      if (rt.pending) await rt.pending;
    }
  }

  // ------------------------------------------------------------------------------------------------ switching (§8)
  /** {ok:true, fee, distM, same} | {ok:false, why, silent?} */
  switchCheck(p, t) {
    if (!t || t.ownerId !== p.id) return { ok: false, why: 'That is not your ship.' };
    if (t.status !== 'active') return { ok: false, why: `${t.name} is laid up — recommission her first.` };
    if (t.id === p.aboard) return { ok: false, why: null, silent: true };
    const same = !!p.docked && p.docked === t.docked;
    const distM = haversine(p.ship.lat, p.ship.lon, t.ship.lat, t.ship.lon);
    const fee = same ? 0 : transferFee(distM);   // computed first: the HQ/dialog show the fee even while a check below refuses
    if (Date.now() - (p.office.lastSwitchAt || 0) < FLEET.SWITCH_COOLDOWN_MS) return { ok: false, why: 'One moment — the launch is still coming back.', fee, distM };
    if (p.hail) return { ok: false, why: 'Not with the coast guard on the radio.' };
    if (p.rescue || p.flooding >= 1) return { ok: false, why: 'You are in the life raft.' };
    if (p.assist || t.assist) return { ok: false, why: 'The tugs have her — wait until she is alongside.' };
    if (p.flooding >= FLEET.NO_SWITCH_FLOODING) return { ok: false, why: 'Not now — she is taking water. Patch the hull (K) first.' };
    if (t.flooding >= 1) return { ok: false, why: `${t.name} is going down.` };
    if (fee > 0 && p.office.owed > 0) return { ok: false, why: `Settle the office's unpaid bills first (${fmt(p.office.owed)} cr).`, fee, distM };
    if (fee > 0 && Math.floor(p.money) < fee) return { ok: false, why: `${distM > 200000 ? 'A helicopter' : 'A launch'} out to ${t.name} (${fmt(distM / 1000)} km) costs ${fmt(fee)} cr. You have ${fmt(Math.floor(p.money))}.`, fee, distM };
    return { ok: true, fee, distM, same };
  }
  /** F14: what the ship you leave does when you give no order. */
  defaultLeaveOrder(v) {
    const g = this.game;
    if (v.docked) return null;
    if (v.towing) { const j = v.jobs.find((x) => x.id === v.towing); if (j && isHarbor(j.to)) return { type: 'sail_to', harbor: j.to, then: 'moor' }; }
    if (v.fishing) { const j = v.jobs.find((x) => x.type === 'fishing'); if (j) return { type: 'contract', jobId: j.id, then: 'stay' }; }
    const vr = v.voyage && Array.isArray(v.voyage.route) ? v.voyage.route.slice(Math.max(0, v.voyage.i | 0)) : null;
    if (vr && vr.length) {
      const n = normalizeOrder({ type: 'route', route: vr.slice(0, 250), harbor: v.voyage.harbor || undefined }, isHarbor);
      if (n.ok) return n.order;
    }
    const { harbor, units } = g.nearestHarbor(v.ship.lat, v.ship.lon);
    if (harbor && units <= FLEET.HARBOUR_ZONE_M) return { type: 'sail_to', harbor: harbor.id, then: 'moor' };
    return { type: 'hold' };
  }
  switchShip(p, m) {
    const g = this.game;
    const t = this.own(p, m.vesselId);
    if (!t) return this.notYours(p);
    const chk = this.switchCheck(p, t);
    if (!chk.ok) { if (!chk.silent) this.warn(p, chk.why); return; }
    const old = p.vessel;
    let order;
    if (m.leave != null) {
      const n = normalizeOrder(m.leave, isHarbor);
      order = n.ok ? n.order : undefined;
      if (order && order.type === 'stop') order = old.docked ? null : { type: 'hold' };
      if (order && this.orderWhyLeave(p, old, order)) order = undefined;
    }
    if (order === undefined) order = this.defaultLeaveOrder(old);
    if (chk.fee > 0) this.book(p, t.id, 'fees', -chk.fee);
    // the person changes ships
    p.aboard = t.id;
    t.orders = null; t.cap = null;
    this.rtOf(t).gen++;
    const a = this.actorOf(old);
    a.warp = 1; a.warpRouted = false; a.warpRun = null;
    if (old.fishing && !(order && order.type === 'contract') && !old.docked) { try { g.setFishing(a, false); } catch { old.fishing = false; } }
    captain.setOrder(this, old, order);
    p.office.lastSwitchAt = Date.now(); p.office.cdSent = false;
    p.moveBudget = null; p.lastState = Date.now(); p.rejects = 0; p.shallowSince = 0; p.contactSeen = null;
    t.lastValid = { lat: t.ship.lat, lon: t.ship.lon };
    g.resetWarp?.(p);
    g.convoyLeave?.(p, true);
    this.m0.set(p.id, p.money);
    const msg = `You took the helm of ${t.name} — ${this.whereText(t)}.${chk.fee ? ` The ${chk.distM > 200000 ? 'helicopter' : 'launch'} cost ${fmt(chk.fee)} cr.` : ''} ${old.name} ${captain.leaveText(this, old)}.`;
    this.tell(p, 'info', msg, t);
    g.sendYou(p, { correction: true, switched: true });
    if (t.docked) g.sendHarbor(p);
    this.sendFleet(p);
  }
  orderWhyLeave(p, v, o) {
    if (o.type === 'sail_to' && o.then === 'lay_up' && o.harbor !== p.office.home) return 'not home';
    if (o.type === 'contract' && (o.jobId != null ? !v.jobs.some((j) => j.id === o.jobId) : !v.jobs.length)) return 'no contract';
    if (o.type === 'hold' && o.lat != null && haversine(v.ship.lat, v.ship.lon, o.lat, o.lon) > FLEET.HOLD_MAX_KM * 1000) return 'too far';
    return null;
  }
  /** "moored at Rotterdam, Waalhaven 3" | "at sea 22 nm W of Texel" */
  whereText(v) {
    if (v.docked) { const h = harborById(v.docked); return v.berth ? `moored at ${short(h?.name)}, ${v.berth.name}` : `in ${short(h?.name)}`; }
    const { harbor } = this.game.nearestHarbor(v.ship.lat, v.ship.lon);
    if (!harbor) return 'at sea';
    const a = this.game.harborAnchor(harbor), d = haversine(a.lat, a.lon, v.ship.lat, v.ship.lon);
    return `at sea ${Math.round(d / 1852)} nm ${compass(bearing(a.lat, a.lon, v.ship.lat, v.ship.lon))} of ${short(harbor.name)}`;
  }

  // ------------------------------------------------------------------------------------------------ berths, hulls (§6.6)
  berthsTaken(harborId, except) {
    const out = new Set();
    for (const v of this.vessels.values()) {
      if (v === except || !v.ship) continue;
      if (v.docked === harborId && v.berth && v.berth.id) out.add(v.berth.id);
      if (v.assist && v.assist.harbor === harborId && v.assist.berthId) out.add(v.assist.berthId);
    }
    return out;
  }
  berthUse(harborId) {
    const used = new Map();
    for (const v of this.vessels.values()) {
      if (v.docked === harborId && v.berth && v.berth.id) used.set(v.berth.id, (used.get(v.berth.id) || 0) + 1);
      if (v.assist && v.assist.harbor === harborId && v.assist.berthId) used.set(v.assist.berthId, (used.get(v.assist.berthId) || 0) + 1);
    }
    return used;
  }
  /** A free fitting berth nearest the anchor, else a lay-by spot at the anchorage, else the anchor: {lat, lon, hdg, berth|null}. */
  freeBerth(h, cls, except = null) {
    const g = this.game, C = clsOf(cls), a = g.harborAnchor(h);
    const geom = g.harborGeom ? g.harborGeom(h.id) : null;
    if (geom && Array.isArray(geom.berths) && geom.berths.length) {
      const probe = { ship: { cls } }, taken = this.berthsTaken(h.id, except);
      const fits = geom.berths.filter((b) => b && Number.isFinite(b.lat) && Number.isFinite(b.lon) && Number.isFinite(b.hdg) && !taken.has(b.id) && !g.berthFits(probe, b));
      if (fits.length) {
        fits.sort((x, y) => haversine(a.lat, a.lon, x.lat, x.lon) - haversine(a.lat, a.lon, y.lat, y.lon));
        const b = fits[0];
        return { lat: b.lat, lon: b.lon, hdg: ((b.hdg % 360) + 360) % 360, berth: b };
      }
    }
    let spot = null;
    try {
      spot = findSafeSpot(a, { draft: C.draft, length: C.length, depthLW: (la, lo) => g.depthAtLowWater(la, lo), others: this.hullsNear(a.lat, a.lon, 5000, except), maxRadiusM: 1500 });
    } catch { spot = null; }
    if (spot) return { lat: spot.lat, lon: spot.lon, hdg: 0, berth: null };
    return { lat: a.lat, lon: a.lon, hdg: 0, berth: null };
  }
  buildGrid() {
    if (this.gridAt === this.tickNo && this.grid) return this.grid;
    const cells = new Map();
    for (const v of this.vessels.values()) {
      if (!v.ship || !Number.isFinite(v.ship.lat)) continue;
      const k = cellKey(v.ship.lat, v.ship.lon);
      let c = cells.get(k); if (!c) cells.set(k, (c = []));
      c.push(v);
    }
    this.grid = cells; this.gridAt = this.tickNo;
    return cells;
  }
  /** Vessels within rangeM of (lat, lon) (from the 0.5° grid), except `except`. */
  vesselsNear(lat, lon, rangeM, except = null) {
    const cells = this.buildGrid(), out = [];
    const dLat = Math.ceil(rangeM / 111000 / CELL_DEG), cos = Math.max(0.05, Math.cos((lat * Math.PI) / 180)), dLon = Math.ceil(rangeM / (111000 * cos) / CELL_DEG);
    const ci = Math.floor(lat / CELL_DEG), cj = Math.floor(lon / CELL_DEG);
    for (let i = ci - dLat; i <= ci + dLat; i++) for (let j = cj - dLon; j <= cj + dLon; j++) {
      const c = cells.get(`${i},${j}`); if (!c) continue;
      for (const v of c) if (v !== except && haversine(lat, lon, v.ship.lat, v.ship.lon) <= rangeM) out.push(v);
    }
    return out;
  }
  /** Hulls for safe spots and give-way: [{lat, lon, len}] (every vessel, persons' ships included). */
  hullsNear(lat, lon, rangeM, except = null) {
    return this.vesselsNear(lat, lon, rangeM, except).map((v) => ({ lat: v.ship.lat, lon: v.ship.lon, len: clsOf(v.ship.cls).length }));
  }

  // ------------------------------------------------------------------------------------------------ the tick (§11.4)
  tick(dt) {
    const g = this.game, t0 = nowMs();
    this.tickNo++;
    for (const p of g.byId.values()) {
      if (!p.office) continue;
      this.driftBook(p);
      if (p.office.owed > 0) this.payOwed(p);
    }
    const near = this.nearOnlineSet();
    let stepped = 0;
    const slot = this.tickNo % FLEET.FAR_EVERY;
    if (!this._list || this._listVer !== this.ver) { this._list = [...this.vessels.values()]; this._listVer = this.ver; }
    const list = this._list;
    for (const v of list) {
      if (v.status === 'laidup' || !this.vessels.has(v.id)) continue;
      const rt = this.rtOf(v);
      if (rt.idx % FLEET.FAR_EVERY !== slot && !v.assist && !near.has(v.id)) { rt.acc += dt; continue; }
      if (this.isAboard(v)) { rt.acc = 0; continue; }   // her person sails her (never bank time for when she is left)
      rt.acc += dt;
      const d = rt.acc; rt.acc = 0;
      rt.far = !v.assist && !near.has(v.id);   // phase-2 decision: far ships integrate in FAR_SUBSTEP_S steps (perf budget)
      try { captain.stepVessel(this, v, d); } catch (e) { g.log?.(`[fleet] step ${v.id} failed: ${e.stack || e}`); }
      stepped++;
      if (!v.docked) { const p = this.ownerOf(v); if (p) this.dirty(p); }
    }
    if (g.politics) for (const p of g.byId.values()) if (p.office) g.politics.tick(p);   // holds, re-flags, pending home move
    if (g.simTime - this.lastDaily >= 60) { this.lastDaily = g.simTime; this.daily(g.simTime); }
    const now = Date.now();
    // the switch cooldown ran out: push a fresh view so the helm buttons / dialog enable again (nothing else may change)
    for (const p of g.byId.values()) { const o = p.office; if (p.online && o && o.lastSwitchAt && !o.cdSent && now - o.lastSwitchAt >= FLEET.SWITCH_COOLDOWN_MS) { o.cdSent = true; this.dirty(p); } }
    for (const p of g.byId.values()) {
      if (!p.online || !p.office) continue;
      const last = this.sentAt.get(p.id) || 0;
      if (this.watching.has(p.id) ? now - last >= 1000 : this.changed.has(p.id) && now - last >= 2000) this.sendFleet(p);
    }
    const ms = nowMs() - t0;
    this.perf.ticks++; this.perf.ms += ms; this.perf.stepped += stepped; this.perf.lastStepped = stepped; this.perf.lastMs = ms;
  }
  /** Ids of the vessels within NEAR_M of an online person's ship (stepped every tick). */
  nearOnlineSet() {
    const out = new Set();
    for (const p of this.game.byId.values()) {
      if (!p.online || !p.ship) continue;
      for (const v of this.vesselsNear(p.ship.lat, p.ship.lon, FLEET.NEAR_M)) out.add(v.id);
    }
    return out;
  }
  onlineGrid() {
    const cells = new Map();
    for (const p of this.game.byId.values()) {
      if (!p.online || !p.ship) continue;
      const k = cellKey(p.ship.lat, p.ship.lon);
      let c = cells.get(k); if (!c) cells.set(k, (c = []));
      c.push(p.ship);
    }
    return cells;
  }
  nearOnline(cells, v) {
    if (!cells.size) return false;
    const lat = v.ship.lat, lon = v.ship.lon, ci = Math.floor(lat / CELL_DEG), cj = Math.floor(lon / CELL_DEG);
    const dLon = Math.min(8, Math.ceil(FLEET.NEAR_M / (111000 * Math.max(0.05, Math.cos((lat * Math.PI) / 180))) / CELL_DEG));
    for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - dLon; j <= cj + dLon; j++) {
      const c = cells.get(`${i},${j}`); if (!c) continue;
      for (const s of c) if (haversine(lat, lon, s.lat, s.lon) <= FLEET.NEAR_M) return true;
    }
    return false;
  }
  /** Storage fees of laid-up ships, whole days (from the tick once a minute). */
  daily(now) {
    void now;
    if (this.game.politics) for (const p of this.game.byId.values()) if (p.office) this.game.politics.dailyTick(p);   // self-limits to once per day
    for (const v of this.vessels.values()) {
      if (v.status !== 'laidup') continue;
      const p = this.ownerOf(v); if (!p) continue;
      this.chargeStorage(p, v, false);
    }
  }
  /** §7.10: a captained ship goes down. */
  sinkVessel(v) {
    const g = this.game, p = this.ownerOf(v), s = v.ship, C = clsOf(s.cls);
    if (v.cargo.length) {
      g.wrecks.push({ id: 'w' + crypto.randomBytes(4).toString('hex'), lat: s.lat, lon: s.lon, cargo: v.cargo, owner: p ? p.name : '?', cls: s.cls, simTime: g.simTime, time: Date.now() });
      g.broadcast({ t: 'wrecks', wrecks: g.wrecks });
    }
    g.broadcast({ t: 'chat', from: 'Shipping news', id: 'sys', text: `${p ? `${p.name}'s` : 'A'} ${C.name} ${v.name} went down at ${s.lat.toFixed(2)}, ${s.lon.toFixed(2)}. Her crew was taken off by the lifeboat.`, time: Date.now() });
    v.stats.sunk = (v.stats.sunk || 0) + 1;
    const jobs = v.jobs.length;
    if (!p) { this.unindex(v); return; }
    this.removeVessel(p, v, 'sunk');
    this.tell(p, 'warn', `${v.name} sank at ${s.lat.toFixed(2)}, ${s.lon.toFixed(2)}${jobs ? ` with ${jobs} contract${jobs > 1 ? 's' : ''}` : ''}. The lifeboat took her crew off.`);
    this.sendFleet(p);
  }
  unwatch(p) { this.watching.delete(p.id); this.buckets.delete(p.id); }
  /** requestWeather: up to n captained ships at sea, round robin. */
  weatherPoints(n = 50) {
    const list = [];
    for (const v of this.vessels.values()) if (!v.docked && v.status === 'active' && !this.isAboard(v)) list.push(v.ship);
    if (!list.length) return [];
    const out = [], k = Math.min(n, list.length);
    for (let i = 0; i < k; i++) out.push(list[(this.wxCursor + i) % list.length]);
    this.wxCursor = (this.wxCursor + k) % list.length;
    return out;
  }
  stats() {
    let captained = 0, atSea = 0, laidUp = 0;
    for (const v of this.vessels.values()) {
      if (v.status === 'laidup') { laidUp++; continue; }
      if (!this.isAboard(v)) { captained++; if (!v.docked) atSea++; }
    }
    const t = this.perf.ticks || 1;
    return { vessels: this.vessels.size, captained, atSea, laidUp, stepsPerTick: Math.round((this.perf.stepped / t) * 10) / 10, meanTickMs: Math.round((this.perf.ms / t) * 1000) / 1000 };
  }

  // ------------------------------------------------------------------------------------------------ wire views (§10.3)
  /** broadcastSnapshot calls this once per broadcast: true on every 10th (then moored/anchored/laid-up ships are listed). */
  snapFull() { this.snapNo++; this.buildGrid(); return this.snapNo % FLEET.VIEW_FULL_EVERY === 0; }
  publicOf(v) {
    const s = v.ship, p = this.ownerOf(v), rt = this.rt.get(v.id);
    const o = {
      id: v.id, name: v.name, owner: p ? p.name : '', ownerId: v.ownerId, cls: s.cls, lat: r6(s.lat), lon: r6(s.lon),
      hdg: Math.round((s.hdg || 0) * 10) / 10, spd: Math.round((s.spd || 0) * 10) / 10, state: stateOf(v), cond: Math.round(v.cond),
      fishing: !!v.fishing, towing: !!v.towing, towCls: v.towing ? (v.jobs.find((j) => j.id === v.towing)?.victimCls || 'trawler') : null,
    };
    if (v.assist || (rt && rt.tugsUntil > Date.now())) { let t = null; try { t = tugsPublic(this.game, this.actorOf(v)); } catch { t = null; } if (t) o.tugs = t; }
    if (rigOf(s.cls)) o.rv = packRigView(s.cls, ensureRig(s, v.docked ? false : v.sailsUp));   // sailing: rig view (§3.7)
    return o;
  }
  /** Per socket: fleet ships within 40 km (≤ 60, under way first, ≤ 40 under way); moored/anchored/laid-up only when `full`. */
  viewFor(p, full = false) {
    if (!p || !p.ship) return [];
    const moving = [], still = [];
    for (const v of this.vesselsNear(p.ship.lat, p.ship.lon, FLEET.VIEW_RANGE_M)) {
      if (this.isAboard(v)) continue;
      const st = stateOf(v), d = haversine(p.ship.lat, p.ship.lon, v.ship.lat, v.ship.lon);
      if (st === 'at_sea') moving.push({ v, d }); else if (full) still.push({ v, d });
    }
    moving.sort((a, b) => a.d - b.d); still.sort((a, b) => a.d - b.d);
    const pick = moving.slice(0, FLEET.VIEW_MOVING_MAX);
    for (const x of still) { if (pick.length >= FLEET.VIEW_MAX) break; pick.push(x); }
    return pick.map((x) => this.publicOf(x.v));
  }
  youFields(p) {
    const fl = p.fleet || [], h = harborById(p.office?.home);
    return {
      aboard: p.aboard, vesselName: p.vessel?.name ?? null, home: p.office?.home ?? null, homeName: h ? h.name : null,
      livery: p.vessel?.spec?.livery ?? null,         // SHIPYARD H9: the own ship is drawn in her livery
      fleet: { n: fl.length, atSea: fl.filter((v) => v.status === 'active' && !v.docked).length, laidUp: fl.filter((v) => v.status === 'laidup').length, owed: p.office?.owed || 0, unread: p.office?.unread || 0 },
    };
  }
  /** sendHarbor additions (§6.5). */
  harborFields(p, h) {
    const o = p.office, home = harborById(o.home), hm = this.homeMove(p, h);
    const here = (p.fleet || []).filter((v) => v.docked === h.id).sort((a, b) => (a.id === p.aboard ? -1 : b.id === p.aboard ? 1 : a.name.localeCompare(b.name)));
    return {
      office: { isHome: o.home === h.id, home: o.home, homeName: home ? home.name : o.home, slots: o.slots, slotsMax: FLEET.SLOTS_MAX, slotPrice: FLEET.SLOT_PRICE,
        used: this.laidUpCount(p), storagePerDay: this.storagePerDay(p), homeMove: { allowed: hm.allowed, cost: hm.cost, plan: this.homePlan(p, h, hm) } },
      fleetHere: here.map((v) => this.vesselView(p, v)),
      fleetFull: vesselSlotsUsed(p) >= FLEET.MAX_VESSELS, fleetN: p.fleet.length,
    };
  }
  /** World politics: what moving the company to h (the harbour moored in) would change, or null. */
  homePlan(p, h, hm) { const pol = this.game.politics; if (!pol || !h || p.office?.home === h.id) return null; try { return pol.homeMovePlan(p, h, { baseCost: hm.cost }); } catch { return null; } }
  storagePerDay(p) { return (p.fleet || []).filter((v) => v.status === 'laidup').reduce((s, v) => s + storageFeePerDay(v.ship.cls), 0); }
  costPerH(p) { return (p.fleet || []).filter((v) => v.status === 'active' && v.id !== p.aboard).reduce((s, v) => s + wageRateMcrH(v.ship.cls, captain.dutyOf(v), !!v.towing) / 1000, 0); }
  vesselView(p, v) {
    const g = this.game, s = v.ship, C = clsOf(s.cls), sim = g.simTime, aboard = p.aboard === v.id;
    const h = v.docked ? harborById(v.docked) : null;
    const days = p.office.book.days, today = [dayKey(sim)], d7 = lastDays(sim, 7);
    const t1 = totals(days, today, v.id), t7 = totals(days, d7, v.id);
    const paxUsed = v.jobs.filter((j) => j && j.pax).reduce((n, j) => n + j.pax, 0);
    const value = shipValue(s.cls, v.cond);
    const route = !aboard && v.voyage && Array.isArray(v.voyage.route) ? decimate(v.voyage.route.slice(Math.max(0, v.voyage.i | 0)), 40) : null;
    const duty = aboard ? 'aboard' : captain.dutyOf(v);
    const crPerH = aboard || v.status === 'laidup' ? 0 : Math.round(wageRateMcrH(s.cls, duty, !!v.towing) / 1000);
    const sw = aboard ? null : this.switchCheck(p, v);
    const helm = aboard ? 'You are aboard her.' : sw.ok ? true : sw.why || 'Not now.';
    const sellWhy = aboard ? 'You are aboard her.' : !v.docked ? 'Moor her in a harbour first.' : v.assist ? 'The tugs have her.' : v.cargo.length ? `Unload her first (${fmt(cargoMass(v.cargo))} t aboard).` : v.jobs.length ? 'Finish or hand over her contracts first.' : true;
    const layWhy = v.status === 'laidup' ? 'Laid up.' : this.layUpWhy(p, v) || true;
    const recFee = recommissionFee(s.cls);
    const recWhy = v.status !== 'laidup' ? 'Not laid up.' : p.office.owed > 0 ? "Settle the office's unpaid bills first." : Math.floor(p.money) < recFee ? `Costs ${fmt(recFee)} cr.` : true;
    const ordWhy = aboard ? 'You are aboard her.' : v.status !== 'active' ? 'Laid up.' : v.assist ? 'The tugs have her.' : true;
    return {
      id: v.id, name: v.name, cls: s.cls, clsName: C.name, status: v.status, state: stateOf(v), aboard,
      lat: r6(s.lat), lon: r6(s.lon), hdg: Math.round(s.hdg || 0), spd: r1(s.spd || 0), harbor: v.docked || null, harborName: h ? h.name : null, berthName: v.berth ? v.berth.name : null,
      fuel: r1(v.fuel), fuelCap: C.fuelCap, cond: Math.round(v.cond), flooding: Math.round((v.flooding || 0) * 100) / 100, cargoT: r1(cargoMass(v.cargo)), capacity: C.capacity, pax: C.pax, paxUsed,
      cargo: v.cargo.map((c) => ({ good: c.good, qty: c.caught ? r1(c.qty) : c.qty, jobId: c.jobId || null, caught: !!c.caught })),
      jobs: v.jobs.filter(Boolean).map((j) => ({ id: j.id, type: j.type, title: j.title, to: j.to, toName: harborById(j.to)?.name || j.to, pay: j.pay, dueShip: j.dueShip, leftH: Number.isFinite(j.dueShip) ? Math.round(((j.dueShip - v.shipTime) / 3600) * 10) / 10 : null })),
      shipTime: r1(v.shipTime), order: v.orders || null,
      task: captain.task(this, v, aboard),
      route,
      costNow: v.status === 'laidup' ? { kind: 'storage', crPerH: 0, crPerDay: storageFeePerDay(s.cls) } : crPerH > 0 ? { kind: 'wages', crPerH, crPerDay: 0 } : { kind: 'none', crPerH: 0, crPerDay: 0 },
      value, profit: { today: t1.net, d7: t7.net },
      can: {
        helm, helmFee: aboard ? 0 : sw.fee ?? 0, orders: ordWhy, contract: ordWhy === true ? (v.docked ? true : 'Contracts are signed at the quay.') : ordWhy,
        layUp: layWhy, recommission: recWhy, recommissionFee: recFee, sell: sellWhy, sellValue: value,
        services: aboard ? 'Use the harbour services.' : v.docked && !v.assist ? true : 'Moor her in a harbour first.', rename: true,
      },
    };
  }
  fleetView(p) {
    const o = p.office, sim = this.game.simTime, home = harborById(o.home), hm = this.homeMove(p, p.docked ? harborById(p.docked) : null);
    const order = (a, b) => (a.id === p.aboard ? -1 : b.id === p.aboard ? 1 : (a.status === 'laidup') - (b.status === 'laidup') || a.name.localeCompare(b.name));
    const vessels = [...p.fleet].sort(order).map((v) => this.vesselView(p, v));
    const days = o.book.days, keys7 = lastDays(sim, 7);
    const perShip = {};
    for (const v of p.fleet) perShip[v.id] = { today: totals(days, [dayKey(sim)], v.id), d7: totals(days, keys7, v.id) };
    return {
      home: o.home, homeName: home ? home.name : o.home, slots: o.slots, slotsMax: FLEET.SLOTS_MAX, slotPrice: FLEET.SLOT_PRICE, used: this.laidUpCount(p), max: FLEET.MAX_VESSELS, n: p.fleet.length,
      cash: Math.floor(p.money), owed: o.owed, value: p.fleet.reduce((s, v) => s + shipValue(v.ship.cls, v.cond), 0), costPerH: Math.round(this.costPerH(p)), storagePerDay: this.storagePerDay(p), unread: o.unread || 0,
      homeMove: { allowed: hm.allowed, cost: hm.cost, plan: this.homePlan(p, p.docked ? harborById(p.docked) : null, hm) },
      compliance: this.game.politics?.officeView(p) ?? null,
      vessels,
      money: {
        today: totals(days, [dayKey(sim)]), d7: totals(days, keys7),
        days: keys7.map((day) => { const t = totals(days, [day]); return { day, income: t.income, costs: t.costs, net: t.net }; }),
        perShip, lost: o.lost.slice(-FLEET.LOST_MAX),
      },
      log: o.log.slice(-FLEET.LOG_MAX),
    };
  }
}

/** Why no captain takes this job, or null (F16). */
export function captainRefusal(job) {
  if (!job) return 'Unknown contract.';
  if (job.contraband || job.type === 'smuggling') return 'No captain will carry that.';
  if (job.type === 'tow') return 'Captains do not take tows — sail her yourself.';
  if (!CAPTAIN_JOB_TYPES.includes(job.type)) return 'Captains do not take this kind of work.';
  return null;
}
/** captainRefusal plus the office's world-politics checks (measures, entry rules, risk policy) for vessel v. */
export function captainRefusalFor(game, owner, v, job) {
  return captainRefusal(job) || (game.politics ? game.politics.captainCheck(owner, job, owner.office?.pol?.riskPolicy || 'avoid', v) : null);
}
/** Every n-th point, first and last kept, at most n points. */
export function decimate(route, n) {
  if (!Array.isArray(route) || route.length <= n) return route ? route.map((q) => [q[0], q[1]]) : null;
  const out = [], step = (route.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) { const q = route[Math.round(i * step)]; out.push([q[0], q[1]]); }
  return out;
}
export function compass(brg) { return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round((((brg % 360) + 360) % 360) / 45) % 8]; }
function berthRef(h, b, hdg) { return { harbor: h.id, id: b.id, name: b.name, hdg, lat: b.lat, lon: b.lon, depth: b.depth, length: b.length }; }
function capital(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function fmtT(t) { return `${t >= 100 ? fmt(t) : (Math.round(t * 10) / 10).toLocaleString('en-US')} t`; }
