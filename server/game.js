// Authoritative game state: players, survival (fuel/wear/flooding/sinking), economy, law, multiplayer
// interactions, AI coast guard, wrecks and persistence. Movement is client-simulated with plausibility checks.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { GEO, SIM, SHIP_CLASSES, GOODS, INTERACT, LAW, LAYERS, FEES, WARP } from '../shared/constants.js';
import { haversine, bearing, destination, unitsBetween, normDeg, angleDiff, wrapLon, clampLat } from '../shared/geo.js';
import { fuelBurnPerSimHour, wearPerSimHour, currentAt, headwindFactor, stepShip } from '../shared/physics.js';
import { THROTTLE_MIN } from '../shared/telegraph.js';
import { tideAt } from '../shared/tide.js';
import { HARBORS, FISHING_GROUNDS, PATROLS, PLATFORMS, harborById } from './harbors.js';
import {
  generateJob, generateSmugglingJob, jobCountFor, JOB_GEN, cargoMass, cargoValue, publicJob,
  shipCapacity, setJobSeq, nextJobId, generateUsedShips, shipValue, repairCostFor, ECON,
  initEconomy, refreshPrices, driftEconomy, marketTrend, demandBonus, shipSpecs, serviceCostFor, serviceWearMul,
  portDues, berthFeePerDay, pilotageFee, tugCostFor, tradeQuote,
  rateJob, setTradeProfile,
} from './economy.js';
import { affordableQty } from './market.js';
import { DATA_DIR } from './world.js';
import { pickGuideBerth, fittingBerthWithin, GUIDE } from './berthguide.js';
import { planTugAssist, beginTugAssist, stepTugAssist, tickTugs, tugsPublic, assistExtra, tugBerthCandidates } from './tugassist.js'; // V5 item 4: water-only tug paths + visible tugs
import { tugOp } from './tugassist.js';                       // V6 item 5: the tug op's time compression runs the ship's clock
import { catchRate } from '../shared/rates.js';                // V6 item 5: one catch-rate formula for the tick and the contract estimates
import { estimateJob, fmtShipH } from '../shared/jobtime.js';            // V6 item 5: contract hours on the ship's clock
import { setGen8 } from '../shared/jobtime.js';                                               // YARD lane D H6c
import { JobsX } from './jobsx.js';                                                            // YARD lane D H6: the step runner
import { wireJob, isRunnerJob, payOf, migrateActor } from '../shared/jobs/types.js';
import { canDo, jobtimeHooks } from '../shared/jobs/eligibility.js';
import { canLoad } from '../shared/cargo.js';                                                  // YARD lane D H7
const JOBS_PHASE = 2;   // YARD §12: phase-2 families only; 4 = every family
const EVENT_DEDUPE_MS = 4000;   // an identical contract warning ({ dedupe }) to the same skipper within this is dropped (log spam)
import { findSafeSpot, harbourAim, SAFE as EXPRESS_SAFE } from './safespot.js'; // V7 step 0: express arrives on safe open water
import { lowWaterAt } from '../shared/tide.js';
import { Fleet } from './fleet.js';                             // v6 fleet (docs/V6-FLEET-CONTRACTS.md)
import { Yard } from './yard.js';                               // SHIPYARD (docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §4)
import { compactOrder as compactOrderView, healHarborYard } from '../shared/ships/index.js';   // SHIPYARD §7.3 / §8
import { Politics } from './politics.js';                       // world politics (docs/WORLD-POLITICS-CONTRACT.md)
import { diplomaticJobs } from './politicsjobs.js';
import { quayQuery, quayDock, quayDockNearest, quayTugs, quayAssistDone, quayUndock, quayGate, quayMigrate, quayPublic, quayHarbourInfo } from './quaygame.js'; // DOCK ANYWHERE
import { ACTION_SERVICE } from '../shared/quayrules.js';
import { allSubPatches } from './bigports.js';                  // V7 step 0: big ports tiled with harbour patches
import { overlayStorms, stormMaxWind } from './stormfield.js';     // game storms over real AND synthetic weather
import { RealStorms } from './realstorms.js';                  // real severe-weather areas from Open-Meteo
import { beaufort, douglas, seaForBeaufort } from '../shared/seastate.js';        // HUD sea state (Douglas) and Beaufort
import { rigOf, KN } from '../shared/sail/rigs.js';                                    // sailing (docs/SAILING-CONTRACT.md)
import { ensureRig, anyHoisted, applyRigCommand, settleRig, packRigView, unpackRigView } from '../shared/sail/state.js';
import { maxSpeedKn } from '../shared/sail/polar.js';
import { sailHelm, crossTrackM, harbourRigCmd, departurePlan, HARBOUR_FURL_M } from '../shared/sail/tactics.js';
import { crashJibeDamage, windOverWater } from '../shared/sail/sailphys.js';
import { loadFis } from './fis.js';                                         // BRIDGES & LOCKS (docs/BRIDGES-LOCKS-VHF-CONTRACT.md)
import { createWaterworks } from './waterworks.js';
import { createShelter } from './shelter.js';
import { airPublic, airDraftNow, ballastStep, canFold, profileOf, FOLD_TIME, registerProfiles } from '../shared/airdraft.js';
import { waterLevelAt } from '../shared/waterlevel.js';
import { WT, WT_NAVIGABLE } from '../shared/wtformat.js';
import LEVELS_NL from './waterworks/levels-nl.json' with { type: 'json' };
import { Casino } from './casino.js';                                                     // cruise casino (docs/CRUISE-CONTRACT.md §7)
import { Venues, guestFor } from './venues.js';
import { createRadio } from './vhf.js';                                                   // VHF radio (docs/BRIDGES-LOCKS-VHF-CONTRACT.md §6)
import { createMinorHarbours, diskOverlayReader, tileDepthSampler, squaresUnder } from './minorharbours.js';
import { mhNearBerth, mhDock } from './mhmoor.js';                                  // inland harbours: boxes / visitor berths (guidance + mooring)   // inland harbours (§7)
import { boardFor as mhBoardFor, INLAND_TERMINALS } from './inlandjobs.js';
import { loadLaneA, stubLaneA } from './inlandlink.js';
import { WorldEcon } from './worldecon.js';                                             // world economy (docs/WORLD-ECONOMY-CONTRACT.md)
import { buildGraph as buildInlandGraph } from './inland.js';
import { marketSnapshot } from './market.js';
import { BARGE_AD } from '../shared/ships/barges.js';

const DEFAULT_STATE_FILE = path.join(DATA_DIR, 'state.json');
const START_HARBOR = 'rotterdam';
const START_MONEY = 25000;
const SERVICE_INTERVAL_S = FEES.SERVICE_INTERVAL_DAYS * 86400;
const NEAR_BERTH_RANGE_U = GUIDE.RANGE_M; // you.nearBerth (berth guidance, server/berthguide.js) is reported within this of the berth
const DOCK_SEARCH_RANGE_U = 6000;     // beyond this of the anchor there is no harbour to talk to
const LAND_PENETRATION_M = 0.5;       // onState rejects positions this far inside a quay/land

function rndFn() { return Math.random(); }
function shortId() { return crypto.randomBytes(4).toString('hex'); }
function token() { return crypto.randomBytes(24).toString('base64url'); }

export class Game {
  constructor(world, log = console.log, opts = {}) {
    this.world = world;
    this.log = log;
    this.stateFile = opts.stateFile || DEFAULT_STATE_FILE;
    // v0.3 services (docs/V3-CONTRACTS.md §3). Each is optional: tests construct the Game without them and the
    // synthetic weather / legacy harbour point / empty AI list take over. server.js ticks weather and traffic itself.
    this.weather = opts.weather || null;       // WeatherService: sample(lat, lon) / request(lat, lon)
    this.traffic = opts.traffic || null;       // Traffic: near(lat, lon, rangeM) / all()
    // Real storms (server/realstorms.js): severe weather in the real data, scanned within the 'scan' quota share
    this.realStorms = opts.realStorms !== undefined ? opts.realStorms
      : this.weather && typeof this.weather.fetchBatch === 'function' ? new RealStorms(this.weather, { isWater: (la, lo) => this.world.isWater(la, lo), log: this.log }) : null;
    this.geom = opts.harborgeom || null;       // harborgeom module namespace
    this.routeTable = opts.routeTable || null; // V6: harbour-to-harbour sea km (MARKET's RouteTable); contract budgets read it
    this.lastEcon = 0;                         // Date.now() of the last market drift
    this.lastWxRequest = 0;                    // Date.now() of the last weather request sweep
    this.wxAsked = new Map();                  // "lat,lon" cell -> Date.now() of the last lazy request (throttle)
    this.players = new Map();   // token -> player
    this.byId = new Map();      // id -> player
    this.sockets = new Map();   // id -> ws
    this.wrecks = [];
    this.harbors = {};          // id -> { jobs, market, contact, lastRegen }
    this.cutters = [];
    this.convoys = new Map();   // convoyId -> { id, members: [ids], leader }
    this.offers = new Map();    // offerId -> trade offer
    this.invites = new Map();   // playerId:convoyId -> expiry
    this.rescues = [];          // active SAR missions
    this.storms = [];           // weather cells
    this.simTime = Date.now() / 1000; // real time: seconds since the Unix epoch
    this.wind = { u: 6, v: 2, dir: 0, spd: 0 };
    this.rnd = rndFn;
    this.lastSave = Date.now();
    this.lastYou = 0;
    this.eventSeq = 1;
    this.routePlanner = opts.routePlanner || null;   // v6 fleet: captains plan their passages with the shared planner
    // BRIDGES & LOCKS (docs/WATERWAYS-LANE1-PHASE2.md §3b): registry, sheltered sea state. SALTLINE_WW_OFF=1 → none of it.
    this.wwOn = process.env.SALTLINE_WW_OFF !== '1';
    if (this.wwOn) registerProfiles(BARGE_AD);                                   // barge air-draught rows (§7.6)
    this.levels = this.wwOn ? LEVELS_NL : null;
    this.fis = this.wwOn ? (opts.fis !== undefined ? opts.fis : loadFis()) : null;   // one copy for ww + harbours (≈ 10 MB heap)
    this.ww = this.wwOn ? createWaterworks(this, this.fis, { now: () => this.simTime, levels: this.levels, aisIn: opts.aisIn || null }) : null;
    this.shelter = this.wwOn && opts.maskAt ? createShelter({
      navigable: (la, lo) => { const m = opts.maskAt(la, lo); return m == null ? this.world.isWater(la, lo) : WT_NAVIGABLE[m] === 1; },
      cellKind: (la, lo) => { const m = opts.maskAt(la, lo); return m === WT.MASK.LOCK ? 'lock' : m === WT.MASK.DOCK ? 'dock' : 'water'; },
      now: () => this.simTime, maxEntries: 2000 }) : null;
    if (this.ww) this.ww.onEvent((e) => this.onWaterworksEvent?.(e));   // lane B's radio subscribes through ww.onEvent itself
    this.wwRev = new WeakMap();                      // player → Map(object id → rev) of the `ww` deltas sent (never saved)
    // VHF radio (§6): stations from ww + VTS sectors + coast guard; AI and fleet ships answer, AIS ships never speak.
    this.radio = !this.wwOn ? null : createRadio(this, this.ww || null, {
      vts: opts.vts || null, harbors: HARBORS,
      aisNear: (lat, lon, r) => { try { return this.liveAis?.near(lat, lon, r) || []; } catch { return []; } },
      shipsNear: (lat, lon, r) => {
        const ai = (this.traffic?.near?.(lat, lon, r) || []).filter((a) => !this.aiFilter || this.aiFilter(a));
        const fleet = [...(this.fleet?.actors?.values?.() || [])].filter((a) => a.ship && haversine(lat, lon, a.ship.lat, a.ship.lon) <= r)
          .map((a) => ({ id: a.id, name: a.vesselName || a.name, lat: a.ship.lat, lon: a.ship.lon, hdg: a.ship.hdg }));
        return [...ai, ...fleet];
      },
      airOf: (p) => {
        const c = SHIP_CLASSES[p.ship.cls] || {};
        const a = this.airDraftNow(p);
        return { ad: a?.ad ?? null, T: a?.T ?? c.draft, need: a?.need ?? null, L: c.length, B: c.beam };
      },
      isInland: (lat, lon) => { try { return this.waterAt(lat, lon)?.ref === 'canal'; } catch { return false; } },
      harboursOn: (ch, lat, lon) => this.mh?.harboursOn(ch, lat, lon) || [],    // harbour masters (§6.3), ch 31 simulated in NL
    });
    this.radio?.on('sar_alert', (a) => this.log(`[sar] ${a.name} ${a.nature} at ${a.lat.toFixed(3)}, ${a.lon.toFixed(3)} (${a.cg})`));   // hook for search and rescue
    this.rigLimits = new WeakMap();                  // sailing: per-person rig command rate limit + rig_event times (never saved)
    this.rigViews = new WeakMap();                   // sailing: the rv each online skipper last sent (never saved)
    this.fleet = new Fleet(this);                   // v6 fleet: vessels, office, captains (before loadState)
    this.casino = new Casino(this); this.venues = new Venues(this);   // cruise ships: tables and venues the captain can use
    this.jobsx = new JobsX({                                                   // YARD lane D: runner for JOB_GEN 8 families
      now: () => this.simTime, harborById,
      harborName: (id) => harborById(id)?.name || this.mh?.get?.(id)?.name || null,   // minor harbours ('mh:…') too
      event: (a, kind, text) => this.event(a, kind, text, kind === 'warn' ? { dedupe: true } : {}),
      pay: (a, cr, j, text, o) => { a.money += cr; if (a.stats) { if (!o?.partial) a.stats.delivered++; a.stats.earned += cr; } this.sendYou?.(a); },   // partial: a COA lifting
      charge: (a, cr) => { if (!(a.money >= cr)) return false; a.money -= cr; return true; },
      ctx: (a) => this.jobsCtx(a),
      windKn: (a) => (this.weatherAt(a.ship.lat, a.ship.lon)?.wind?.spd ?? 0) / GEO.KN_TO_MS,
      seaHs: (a) => this.weatherAt(a.ship.lat, a.ship.lon)?.waves?.height ?? 0,
      heelDeg: (a) => this.rigFor?.(a)?.heel ?? 0,
      offHire: (a) => (a.cond ?? 100) < 30,
      damage: (a, pts) => { a.cond = Math.max(0, (a.cond ?? 100) - pts); },
      guest: (a) => guestFor(this, a),                // cruise pay: the guest rating of the ship (shared/ships/cruisesat.js)
    });
    setGen8(jobtimeHooks(() => ({ harborById, simTime: this.simTime })));
    this.yard = new Yard(this);                     // SHIPYARD: orders, stock, second-hand market (before loadState)
    // World politics (docs/WORLD-POLITICS-CONTRACT.md): rules per harbour, sanctions, war risk, flags. Tests pass a fixture.
    this.politics = opts.politics === false ? null : new Politics(this, { dir: opts.politicsDir, dataset: opts.politicsDataset, harbors: opts.politicsHarbors, log: this.log });
    if (this.politics?.ds.trade && !opts.politicsDataset) setTradeProfile((cc, g) => this.politics.tradeProfile(cc, g));   // only once shared/politics/trade.json exists
    this.econ = opts.econ === false ? null : new WorldEcon(this, opts.econOpts || {});   // world economy: roles, flows, requests (before loadState)
    this.loadState();
    // INLAND HARBOURS (docs/WATERWAYS-HARBOURS-PHASE2.md §2.2): generated per z12 square from the overlay as ships sail; ≤ 3,000 in memory
    this.inlandGraph = this.fis ? buildInlandGraph(this.fis, { levels: this.levels }) : null;   // the harbour card's reach (≈ 3 MB)
    this.mhBoards = new Map();                                                    // minor harbour id → board (regenerated every 24 h)
    this.mh = !this.wwOn ? null : createMinorHarbours({
      named: HARBORS, fis: this.fis, graph: this.inlandGraph, guard: opts.memGuard || null, lane: stubLaneA(),
      readOverlay: opts.readOverlay || diskOverlayReader(DATA_DIR),
      patchLand: (lat, lon) => this.landPenetration(lat, lon),                    // inland harbour pontoons never on a harbour patch's land / quays
      keepSquares: () => squaresUnder([...this.byId.values()].filter((p) => p.online && p.ship).map((p) => p.ship), 25),
      sampleDepth: opts.quaySample ? tileDepthSampler(opts.quaySample, lowWaterAt) : null,
      market: (id) => { try { return this.econ ? this.econ.marketRow(id) : marketSnapshot(this).harbors.find((h) => h.id === id) || null; } catch { return null; } },   // world economy §9.6: by role
      jobs: (h) => { try { return this.mhBoard(h); } catch { return null; } },
      log: (...a) => this.log(...a),
    });
    if (this.mh) loadLaneA().then((l) => this.mh?.setLane(l)).catch(() => {});
    this.initHarbors();
    this.initCutters();
  }

  // ------------------------------------------------------------------ persistence
  loadState() {
    try {
      if (!fs.existsSync(this.stateFile)) return;
      const s = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (this.ww && s.ww) { try { this.ww.load(s.ww); } catch (e) { this.log(`[ww] load failed: ${e.message}`); } }
      this.simTime = Date.now() / 1000;
      this.wrecks = s.wrecks || [];
      this.storms = s.storms || [];
      this.harbors = s.harbors || {};
      if (s.wind) this.wind = s.wind;
      let maxJob = 1;
      for (const p of s.players || []) {
        p.online = false; p.hail = null;
        this.fleet.adoptPlayer(p);                    // v6: ship fields move onto the vessel records
        p.fishing = false;
        this.migratePlayer(p);
        migrateActor(p);                              // YARD §8: accepted gen-7 jobs → legacy, cargo stacks get `unit`
        this.players.set(p.token, p); this.byId.set(p.id, p);
      }
      for (const h of Object.values(this.harbors)) for (const j of [...(h.jobs || []), ...((h.contact && h.contact.jobs) || [])]) maxJob = Math.max(maxJob, parseInt(j.id.slice(1), 36) + 1);
      for (const p of this.players.values()) for (const j of p.jobs || []) maxJob = Math.max(maxJob, parseInt(j.id.slice(1), 36) + 1);
      for (const v of this.fleet.vessels.values()) for (const j of v.jobs || []) if (j && typeof j.id === 'string') maxJob = Math.max(maxJob, parseInt(j.id.slice(1), 36) + 1 || 1);
      setJobSeq(maxJob);
      for (const p of this.players.values()) {
        if (!p.convoyId) continue;
        let c = this.convoys.get(p.convoyId);
        if (!c) { c = { id: p.convoyId, members: [], leader: p.id }; this.convoys.set(c.id, c); }
        c.members.push(p.id);
      }
      // Markets kept moving while the server was down (bounded to two days).
      const savedAt = s.savedAt ? Date.parse(s.savedAt) / 1000 : s.simTime;
      if (Number.isFinite(savedAt)) { const hours = Math.min(48, Math.max(0, (this.simTime - savedAt) / 3600)); if (this.econ) this.econ.afterLoad(s, hours); else for (const st of Object.values(this.harbors)) driftEconomy(st, hours, this.rnd); }
      else if (this.econ) this.econ.afterLoad(s, 0);   // world economy §12: migrate old saves (scarcity ratios kept)
      this.fleet.afterLoad(savedAt);                  // v6: captained ships migrate, storage dates shift by the downtime
      for (const v of this.fleet.vessels.values()) migrateActor(v);   // YARD §8 (fleet vessels)
      this.log(`[game] loaded ${this.players.size} players, ${this.wrecks.length} wrecks`);
    } catch (e) { this.log(`[game] state load failed: ${e.message}`); }
  }
  // v0.3 player fields default safely for players saved by older versions.
  migratePlayer(p) {
    // Never resume warped (docs/V4-CONTRACTS.md §1): every load starts the ship back in real time.
    p.warp = 1; p.warpRouted = false; p.warpGraceUntil = 0; p.warpGraceFactor = 1;
    if (p.berth === undefined) p.berth = null;
    if (this.wwOn && p.ship) {                          // BRIDGES & LOCKS / VHF fields (never resumed inside a lock: the chamber restarts idle, §8.3)
      if (!Number.isFinite(p.ship.ballastT)) p.ship.ballastT = 0;
      if (!p.ship.fold || typeof p.ship.fold !== 'object') p.ship.fold = {};
      p.ship.foldOp = null; p.lockStay = null;
      if (!p.radio || typeof p.radio !== 'object') p.radio = { on: true, ch: 16, dual: true, power: 'hi', lang: 'auto', vol: 0.8 };
      p.radio.open = false; p.radioLastTx = 0; p.radioLastDsc = 0; p.radioMiss = null;
    }
    if (!(p.serviceDue > 0)) p.serviceDue = this.simTime + SERVICE_INTERVAL_S;
    if (!p.stats) p.stats = {};
    for (const k of ['delivered', 'earned', 'sunk', 'inspected', 'fined', 'caught', 'boarded', 'pirated', 'distanceKm', 'collisions']) if (!Number.isFinite(p.stats[k])) p.stats[k] = 0;
    if (!p.lastValid) p.lastValid = { lat: p.ship.lat, lon: p.ship.lon };
    if (p.docked && !(p.dockedAt > 0)) p.dockedAt = this.simTime;
    // V6 item 5: the ship's clock (seconds, runs at the warp factor). It starts at the world clock and does not run while
    // the server is down; accepted contracts move from world-clock deadlines to ship-time due dates.
    if (!Number.isFinite(p.shipTime)) p.shipTime = this.simTime;
    p.warpRun = null;
    if (!Array.isArray(p.jobs)) p.jobs = [];
    for (const j of p.jobs) if (j && !Number.isFinite(j.dueShip)) this.migrateAcceptedJob(p, j);
    // A tug assist interrupted by a restart completes now: the berth is the only position guaranteed to be water.
    if (p.assist?.quay) quayMigrate(this, p);            // DOCK ANYWHERE: tiles are not loaded yet → the berth saved at tug start
    if (p.assist) {
      const h = harborById(p.assist.harbor), geom = h && this.geom && this.geom.getHarborGeom(h.id);
      const b = geom && (geom.berths || []).find((x) => x.id === p.assist.berthId);
      p.assist = null;
      if (h) { if (b) this.moorAt(p, h, b); else this.setDocked(p, h.id, null); }
    }
    this.politics?.migrate(p);                         // office.pol, vessel flag/built/psc/held, cargo origin (never throws)
    this.politics?.reconcile(p);                       // §4.17 wind-down / frustration when the dataset changed
  }
  saveState() {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      const s = {
        savedAt: new Date().toISOString(), fleetSchema: 1, polSchema: 1, polVersion: this.politics?.version ?? null, ...(this.econ ? this.econ.saveMeta() : {}), simTime: this.simTime, ww: this.ww ? this.ww.toSave() : undefined, wind: this.wind, wrecks: this.wrecks, harbors: this.econ ? this.econ.harborsForSave(this.harbors) : this.harbors, storms: this.storms,
        players: [...this.players.values()].map((p) => ({ ...p, hail: null, online: false, warp: 1, warpRouted: false, warpGraceUntil: 0, warpGraceFactor: 1, ...(this.wwOn ? { radio: p.radio ? { ...p.radio, open: false } : undefined, radioLastTx: 0, radioLastDsc: 0, radioMiss: null, lockStay: null } : {}) })),
      };
      const tmp = this.stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(s));
      fs.renameSync(tmp, this.stateFile);
      this.lastSave = Date.now();
    } catch (e) { this.log(`[game] save failed: ${e.message}`); }
  }

  // ------------------------------------------------------------------ harbours / AI init
  initHarbors() {
    for (const h of HARBORS) {
      let st = this.harbors[h.id];
      if (!st) st = this.harbors[h.id] = { jobs: [], market: {}, contact: null, lastRegen: -1e9, ...initEconomy(h, this.rnd) };
      // Old state files carry a flat price table only: give them stock/target and derive the prices from it.
      if (!st.stock || !st.target) Object.assign(st, initEconomy(h, this.rnd));
      healHarborYard(st);                              // SHIPYARD §8: the new second-hand market regenerates at the first visit
      refreshPrices(h, st);
      // V6 item 5: board offers from before ship-hour budgets (no `hours`) are withdrawn; the regen refills the board.
      // v7 world coverage: offers from the old generator (before JOB_GEN 7, North-Sea-weighted destinations) too.
      const current = (j) => j && Number.isFinite(j.hours) && (j.gen || 0) >= JOB_GEN;
      st.jobs = (st.jobs || []).filter(current);
      if (st.contact && Array.isArray(st.contact.jobs)) st.contact.jobs = st.contact.jobs.filter(current);
      this.regenHarbor(h, st, true);
    }
    this.econ?.settle();   // world economy §10: landed ceilings once every harbour has a market
    this.lastEcon = Date.now();
  }
  regenHarbor(h, st, force) {
    st.jobs = (st.jobs || []).filter((j) => j && (j.expiresAt ?? j.deadline) > this.simTime && (j.type !== 'tow' || this.ensureTowSpot(j))); // offers leave the board after 24 h
    const n = jobCountFor(h);
    // Second-hand hulls turn over every 6 h (1–4 listings by harbour size).
    if (!st.used || !st.used.length || !(st.usedAt > 0) || this.simTime - st.usedAt > ECON.USED_REFRESH_H * 3600) { st.used = generateUsedShips(h, this.rnd); st.usedAt = this.simTime; }
    if (force || this.simTime - st.lastRegen > 3600 * 2) {
      let guard = 0;
      if (st.jobs.length < n) st.jobs.push(...this.jobsx.generate(h, this.simTime, this.rnd, this.jobEnv(), { n: n - st.jobs.length, phase: JOBS_PHASE })); // YARD §5.7
      void guard;
      if (this.politics) {
        for (const j of diplomaticJobs(this.politics.ds, h, this.simTime, this.rnd, { harbors: HARBORS, nextJobId, rateJob, seaKm: this.jobEnv().seaKm, riskOf: (a, b) => this.politics.riskOf(a, b) })) if (st.jobs.length < n + 2) st.jobs.push(j);
        for (const j of st.jobs) if (!j.pol || j.pol.ver !== this.politics.version) { const keep = j.pol?.mustAvoid; this.politics.tagJob(j); if (keep) j.pol.mustAvoid = keep; }
      }
      // Black-market contact: 70% present per regen, 1-3 runs.
      if (this.rnd() < 0.7) {
        const k = 1 + Math.floor(this.rnd() * 3);
        st.contact = { name: contactName(this.rnd), jobs: Array.from({ length: k }, () => generateSmugglingJob(h, this.simTime, this.rnd, this.jobEnv())).filter(Boolean) };
      } else st.contact = null;
      st.lastRegen = this.simTime;
    }
    refreshPrices(h, st);
  }
  /** canDo context for actor `a` (YARD §5.8). Politics: pass { ds, ctx } here once the politics lane exposes them. */
  jobsCtx(a) {
    return {
      harborById, simTime: this.simTime,
      weatherAt: (id) => { const h = harborById(id); if (!h) return null; const w = this.weatherAt(h.lat, h.lon); return { windKn: (w?.wind?.spd ?? 0) / GEO.KN_TO_MS, hs: w?.waves?.height ?? 0 }; },
    };
  }
  jobEnv() {
    return this._jobEnv || (this._jobEnv = {
      towSpot: (lat, lon, draft) => this.towSpotOk(lat, lon, draft),
      // V6 item 5: planned sea km between two harbours when the route table knows it (else the generator uses gc × 1.25)
      seaKm: (a, b) => { try { const km = this.routeTable?.seaKm?.(a, b); return Number.isFinite(km) && km > 0 ? km : null; } catch { return null; } },
      ...(this.politics ? this.politics.jobEnvHooks() : {}),   // destWeight, riskOf, contrabandOk, tradeProfile, payMul
    });
  }
  // Can a disabled vessel lie here? Open water at least draft + 6 m deep, deep water 1.5 km all round (no lee shore
  // to drift onto, no channel bank), 6 km clear of any harbour, outside every built harbour patch.
  towSpotOk(lat, lon, draft = 4) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
    const need = (Number.isFinite(draft) ? draft : 4) + 6;
    if (!(this.world.depthAt(lat, lon) >= need)) return false;
    for (let b = 0; b < 360; b += 45) { const q = destination(lat, lon, b, 1500); if (!(this.world.depthAt(q.lat, q.lon) >= need - 4)) return false; }
    const pen = this.landPenetration(lat, lon); if (pen != null) return false;
    const { units } = this.nearestHarbor(lat, lon);
    return !(units < 6000);
  }
  // Older boards and accepted contracts may hold a casualty on land: move it to the nearest valid open water (rings out
  // to 150 km), once per job. False when there is no water anywhere near (the job is then dropped from the board).
  ensureTowSpot(j) {
    if (!j || j.type !== 'tow' || !j.at) return true;
    if (j.spotOk) return true;
    const draft = SHIP_CLASSES[j.victimCls]?.draft ?? 4;
    if (this.towSpotOk(j.at.lat, j.at.lon, draft)) { j.spotOk = true; return true; }
    for (let r = 2000; r <= 150000; r += r < 40000 ? 2000 : 5000) {
      for (let b = 0; b < 360; b += 22.5) {
        const q = destination(j.at.lat, j.at.lon, b, r);
        if (this.towSpotOk(q.lat, q.lon, draft)) {
          j.at = { lat: round6(q.lat), lon: round6(q.lon) }; j.spotOk = true;
          j.title = `Tow a disabled ${SHIP_CLASSES[j.victimCls]?.name.toLowerCase() || 'vessel'} at ${j.at.lat.toFixed(2)}°, ${j.at.lon.toFixed(2)}° to ${harborById(j.to)?.name || j.to}`;
          return true;
        }
      }
    }
    return false;
  }
  // Every market drifts toward its target stock; called from tick once a minute and after loading state.
  driftMarkets() {
    const now = Date.now();
    const hours = Math.min(48, (now - (this.lastEcon || now)) / 3600e3);
    this.lastEcon = now;
    if (hours <= 0) return;
    if (this.econ) return this.econ.step(hours, this.simTime);   // world economy §6.4: flows, events, requests
    for (const h of HARBORS) { const st = this.harbors[h.id]; if (!st) continue; driftEconomy(st, hours, this.rnd); refreshPrices(h, st); }
  }
  harborEcon(st) { return { stock: st.stock || {}, target: st.target || {}, trend: marketTrend(st) }; }
  initCutters() {
    this.cutters = PATROLS.map((p) => ({
      id: p.id, name: p.name, pts: p.pts, wp: 1, lat: p.pts[0][0], lon: p.pts[0][1], hdg: 0, spd: 0,
      state: 'patrol', targetId: null, timer: 0, kn: 18,
    }));
  }

  // ------------------------------------------------------------------ players
  findOrCreatePlayer(tok, name) {
    let p = tok ? this.players.get(tok) : null;
    if (!p) {
      const h = harborById(START_HARBOR);
      const berth = this.startBerth(h, 'coaster');
      const spawn = berth || this.spawnPointNear(h);
      p = {
        id: shortId(), token: token(), name: cleanName(name) || `Skipper-${Math.floor(Math.random() * 900 + 100)}`,
        createdAt: Date.now(), money: START_MONEY, wanted: 0, wantedAt: 0, convoyId: null, lastInspected: -1e9, lastSeen: Date.now(),
        stats: { delivered: 0, earned: 0, sunk: 0, inspected: 0, fined: 0, caught: 0, boarded: 0, pirated: 0, distanceKm: 0, collisions: 0 },
        shallowSince: 0, log: [],
        warp: 1, warpRouted: false, warpGraceUntil: 0, warpGraceFactor: 1, warpRun: null,
      };
      // v6: the ship fields of today's literal live on the first vessel (Sea Bee), same values
      this.fleet.createFirstVessel(p, { cls: 'coaster', spawn, berth, harbor: START_HARBOR });
      this.players.set(p.token, p); this.byId.set(p.id, p);
      this.log(`[game] new player ${p.name} (${p.id})`);
    } else if (name && cleanName(name) && cleanName(name) !== p.name) {
      p.name = cleanName(name);
    }
    return p;
  }
  // The harbour anchor: guaranteed water in the built geometry, else the harbour's own point. `built` tells callers
  // whether the coarse world raster may disagree with it (a dredged basin is land at 556 m resolution).
  harborAnchor(h) {
    if (!h) return null;
    if (this.geom) {
      try {
        const a = this.geom.harborAnchor(h.id);
        if (a && Number.isFinite(a.lat) && Number.isFinite(a.lon)) return { lat: a.lat, lon: a.lon, built: typeof this.geom.isBuilt === 'function' ? this.geom.isBuilt(h.id) : !!this.geom.getHarborGeom(h.id) };   // isBuilt never loads a patch
      } catch (e) { this.log(`[game] harborAnchor ${h.id} failed: ${e.message}`); }
    }
    return { lat: h.lat, lon: h.lon, built: false };
  }
  // v0.4: a new skipper starts moored alongside a quay of the start harbour (built geometry only) — the least used
  // fitting berth, nearest the anchor — so going ashore walks down the gangway onto the real quay. Without built
  // geometry (or no fitting berth) the ship lies at the anchor as before and the launch takes the crew ashore.
  startBerth(h, cls) {
    const geom = h && this.harborGeom(h.id);
    if (!geom || !Array.isArray(geom.berths) || !geom.berths.length) return null;
    const probe = { ship: { cls } };
    const fits = geom.berths.filter((b) => b && Number.isFinite(b.lat) && Number.isFinite(b.lon) && Number.isFinite(b.hdg) && !this.berthFits(probe, b));
    if (!fits.length) return null;
    const used = this.fleet.berthUse(h.id);           // v6: every vessel moored there (fleet and laid-up ships too)
    const a = this.harborAnchor(h);
    const dist = (b) => haversine(a.lat, a.lon, b.lat, b.lon);
    fits.sort((x, y) => (used.get(x.id) || 0) - (used.get(y.id) || 0) || dist(x) - dist(y));
    const b = fits[0];
    return { harbor: h.id, id: b.id, name: b.name, hdg: normDeg(b.hdg), lat: b.lat, lon: b.lon, depth: b.depth, length: b.length };
  }
  spawnPointNear(h) {
    const a = this.harborAnchor(h);
    if (a.built) return { lat: a.lat, lon: a.lon };
    const w = this.world.nearestWater(a.lat, a.lon, 10);
    return { lat: w.lat, lon: w.lon };
  }
  harborGeom(id) { if (!this.geom) return null; try { return this.geom.getHarborGeom(id) || null; } catch { return null; } }
  // Berth guidance target (V5-PLAN item 2): the nearest berth of the nearest harbour that FITS the ship (free ones first,
  // sticky so the leading line does not jump), within NEAR_BERTH_RANGE_U; else the nearest one with `why` it does not fit.
  nearBerthFor(p) {
    const named = this.namedNearBerthFor(p);
    if (!this.mh || p.docked) return named;
    let mhb = null; try { mhb = mhNearBerth(this, p); } catch (e) { this.log(`[mh] near berth failed: ${e.stack || e}`); mhb = null; }
    // an inland harbour's box / visitor berth wins when it is nearer than the big harbour's berth (or that one does not fit)
    if (mhb && (!named || mhb.distM < named.distM || (named.fits === false && mhb.fits))) return mhb;
    return named;
  }
  namedNearBerthFor(p) {
    if (!this.geom || p.docked) { p.guideBerth = null; return null; }
    const { harbor, units } = this.nearestHarbor(p.ship.lat, p.ship.lon);
    const geom = harbor && units <= NEAR_BERTH_RANGE_U + 4000 ? this.harborGeom(harbor.id) : null;
    if (!geom || !Array.isArray(geom.berths) || !geom.berths.length) return null;
    const occupied = this.fleet.berthsTaken(harbor.id, p.vessel);
    let g = null;
    try { g = pickGuideBerth({ berths: geom.berths, lat: p.ship.lat, lon: p.ship.lon, why: (b) => this.berthFits(p, b), occupied, prevId: p.guideBerth?.harbor === harbor.id ? p.guideBerth.id : null, spdKn: Math.abs(p.ship.spd || 0) }); } catch { g = null; }
    if (!g || !(g.distM <= NEAR_BERTH_RANGE_U)) return null;
    const b = g.berth;
    if (g.fits) p.guideBerth = { harbor: harbor.id, id: b.id };
    const water = Number.isFinite(b.depth) ? round1(b.depth + tideAt(b.lat, b.lon, this.simTime).height) : null;
    return { id: b.id, name: b.name, harbor: harbor.id, harborName: harbor.name, distM: Math.round(g.distM), brg: Math.round(bearing(p.ship.lat, p.ship.lon, b.lat, b.lon)), hdg: Math.round(b.hdg), depth: b.depth, length: b.length, kind: b.kind, lat: b.lat, lon: b.lon,
      fits: g.fits, why: g.why || null, water, contract: (p.jobs || []).some((j) => j.to === harbor.id) };
  }

  tideFor(lat, lon) {
    const t = tideAt(lat, lon, this.simTime);
    return { height: round2(t.height), rate: round2(t.rate), stream: { u: round2(t.stream.u), v: round2(t.stream.v) }, range: round2(t.range), phase: round2(t.phase), state: t.state, nextHigh: Math.round(t.nextHigh), nextLow: Math.round(t.nextLow) };
  }

  publicState(p) {
    const s = p.ship;
    return {
      id: p.id, name: p.name, cls: s.cls, lat: round6(s.lat), lon: round6(s.lon), hdg: Math.round(s.hdg * 10) / 10,
      spd: Math.round(s.spd * 10) / 10, cond: Math.round(p.cond), flooding: Math.round(p.flooding * 100) / 100,
      convoyId: p.convoyId, wanted: p.wanted, docked: p.docked, sinking: p.flooding >= 1 || !!p.rescue, towing: !!p.towing, offline: !p.online,
      towCls: p.towing ? (p.jobs.find((j) => j.id === p.towing)?.victimCls || 'trawler') : null, fishing: !!p.fishing,
      warp: this.warpOf(p),
      tugs: tugsPublic(this, p),
      vid: p.vessel?.id ?? null, vname: p.vessel?.name ?? null,   // v6: which of her ships the skipper sails
      rv: this.rvOf(p),                                          // sailing: rig view (§3.7); undefined for engine classes
      quay: quayPublic(p),                                         // DOCK ANYWHERE: { name, cls } while moored at a quay
    };
  }
  privateState(p) {
    { const rig = this.rigFor(p); if (rig) p.sailsUp = anyHoisted(rig); }   // sailing: a yacht just bought / switched to gets her rig (moored: sails down) before `you` carries it
    return {
      id: p.id, name: p.name, ship: { ...p.ship }, cond: p.cond, flooding: p.flooding, fuel: p.fuel, cargo: p.cargo.map((c) => (c.caught ? { ...c, qty: Math.round(c.qty * 10) / 10 } : c)),
      money: p.money, wanted: p.wanted, kits: p.kits, jobs: p.jobs.map((j) => this.wireMine(p, j)), convoyId: p.convoyId, docked: p.docked,
      orders: (p.office?.orders || []).map((o) => compactOrderView(o, this.simTime)),   // SHIPYARD §7.3 you.orders
      fuelEmpty: p.fuel <= 0, hail: p.hail ? { cutter: p.hail.cutter, until: p.hail.until, state: p.hail.state } : null,
      fishing: !!p.fishing, fishInfo: p.fishing ? p.fishInfo : null, towing: p.towing || null, voyage: p.voyage || null, rescue: p.rescue || null, sailsUp: p.sailsUp !== false,
      weather: this.weatherFor(p), tide: this.tideFor(p.ship.lat, p.ship.lon),
      ...(this.ww ? this.wwYou(p) : {}),             // BRIDGES & LOCKS: air, water, lockStay, nextObjects
      berth: p.berth || null, assist: p.assist ? { harbor: p.assist.harbor, berthId: p.assist.berthId, berthName: p.assist.berthName, until: p.assist.until, from: p.assist.from, to: p.assist.to, ...assistExtra(this, p) } : null,
      nearBerth: this.nearBerthFor(p), serviceDue: p.serviceDue, serviceMul: round2(serviceWearMul(p.serviceDue, this.simTime)),
      guest: guestFor(this, p), stats: p.stats, capacity: shipCapacity(p.ship.cls), pax: SHIP_CLASSES[p.ship.cls].pax,
      warp: this.warpOf(p), warpLimit: this.warpLimit(p),
      shipTime: round1(p.shipTime), shipRate: this.shipRate(p), // V6 item 5: the ship's clock (s) and how fast it runs now
      warpRun: p.warpRun ? { shipStart: round1(p.warpRun.shipStart), worldStart: round1(p.warpRun.worldStart) } : null,
      ...this.fleet.youFields(p),                     // v6: aboard, vesselName, home, homeName, fleet {n, atSea, laidUp, owed, unread}
      ...(this.radio ? { radio: this.radio.youFields(p) } : {}),   // VHF {on, ch, dual, power, powerEff, inland, lang, vol, dmg}
      ...(this.mh && p.ship ? { mhNear: this.mh.near(p.ship.lat, p.ship.lon, 3).slice(0, 3).map((h) => ({ id: h.id, name: h.name, tier: h.tier, vhf: h.vhf })) } : {}),
      pol: this.politics ? this.politics.youView(p) : null,
      convoy: p.convoyId && this.convoys.get(p.convoyId) ? { id: p.convoyId, members: this.convoys.get(p.convoyId).members.map((id) => ({ id, name: this.byId.get(id)?.name })) } : null,
    };
  }
  wwYou(p) {
    const Hs = this.weatherFor(p).waveH || 0, wl = waterLevelAt(p.ship.lat, p.ship.lon, this.simTime, { levels: this.levels });
    return {
      air: airPublic(p.ship.cls, { cargo: p.cargo, fuelT: p.fuel, ballastT: p.ship.ballastT || 0, ballastTarget: p.ship.ballastTarget ?? null, fold: p.ship.fold || {} }, Hs),
      water: { h: Math.round(wl.h * 100) / 100, ref: wl.ref },
      lockStay: p.lockStay || null,
      nextObjects: this.ww.verdicts(p, p.ship.lat, p.ship.lon, 3000).filter((v) => {   // ahead (±90° of the heading) or right here
        const o = this.ww.get(v.id), q = o && (o.p || o.line?.[0]); if (!q || v.distM < 150) return true;
        return Math.abs(angleDiff(p.ship.hdg || 0, bearing(p.ship.lat, p.ship.lon, q[0], q[1]))) <= 90;
      }).slice(0, 3),
    };
  }
  // The weather a skipper is told about: the real thing, or (SALTLINE_DEBUG=1 'debug_sea') a forced Beaufort sea.
  weatherFor(p) {
    const w = this.weatherPublic(p.ship.lat, p.ship.lon);
    if (p.debugBft == null || process.env.SALTLINE_DEBUG !== '1') return this.sheltered(w, p);
    const f = seaForBeaufort(p.debugBft), d = douglas(f.waveH);
    return this.sheltered({ ...w, ...f, waveDir: w.windDir, swellDir: (w.windDir + 340) % 360, seaState: d.code, seaWord: d.word, forced: true }, p);
  }
  /** §4.11 (BRIDGES & LOCKS): fetch-limited sea state in sheltered water (canals, docks, locks); the open sea is unchanged. */
  sheltered(w, p) {
    if (!this.shelter) return w;
    try { return this.shelter.apply(w, p.ship.lat, p.ship.lon) || w; } catch { return w; }
  }
  // Flat, rounded weather for the wire (ocean.setSea / weatherFx.set read these names directly).
  weatherPublic(lat, lon) {
    const w = this.weatherAt(lat, lon);
    return {
      windDir: Math.round(w.wind.dir), windSpd: round1(w.wind.spd), gust: round1(w.wind.gust), sea: round2(w.sea), storm: round2(w.storm), rain: round2(w.rain),
      waveH: round2(w.waves.height), waveDir: Math.round(w.waves.dir), wavePeriod: round1(w.waves.period),
      swellH: round2(w.swell.height), swellDir: Math.round(w.swell.dir), swellPeriod: round1(w.swell.period),
      visibility: Math.round(w.visibility), pressure: round1(w.pressure), temp: round1(w.temp), cloud: round2(w.cloud), source: w.source,
      sst: Number.isFinite(w.sst) ? round1(w.sst) : null, curSpd: w.current ? round2(w.current.speed) : null, curDir: w.current ? Math.round(w.current.dir) : null,
      bft: beaufort(w.wind.spd), seaState: douglas(w.waves.height).code, seaWord: douglas(w.waves.height).word,   // WMO/Douglas sea state by Hs
      stormName: w.stormName || null, stormKind: w.stormKind || null,
    };
  }
  worldInfo() {
    return {
      harbors: HARBORS.map((h) => ({ id: h.id, name: h.name, country: h.country, lat: h.lat, lon: h.lon, size: h.size })),
      patches: allSubPatches(HARBORS),   // V7 big ports: extra harbour patches over the port areas (server/bigports.js)
      fishing: FISHING_GROUNDS, platforms: PLATFORMS, classes: SHIP_CLASSES, goods: GOODS, layers: LAYERS, interact: INTERACT, law: LAW, fees: FEES, warp: WARP,
      scale: GEO.SCALE, motionScale: SIM.MOTION_SCALE, clockScale: SIM.CLOCK_SCALE,
      ...(this.ww ? { ww: true, radio: !!this.radio, wwAttribution: 'Bridges, locks & harbours NL: © Rijkswaterstaat / Vaarweginformatie.nl (CC0)' } : {}),   // BRIDGES & LOCKS / VHF
    };
  }

  // ------------------------------------------------------------------ networking helpers
  send(p, msg) {
    if (p.isActor) return;                         // v6: a captain has no socket
    const ws = this.sockets.get(p.id);
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }
  event(p, kind, text, extra = {}) {
    if (p.isActor) return this.fleet.actorEvent(p, kind, text, extra);   // v6: a captain's lines go to the owner's ships' log
    if (extra.dedupe) { if (this.dupWarn(p, text)) return; extra = { ...extra }; delete extra.dedupe; }   // contract buttons: the same line again within a few seconds: once
    const ev = { t: 'event', id: this.eventSeq++, kind, text, time: Date.now(), ...extra };
    p.log = (p.log || []).slice(-30).concat([{ kind, text, time: ev.time }]);
    this.send(p, ev);
  }
  broadcast(msg, except) {
    const s = JSON.stringify(msg);
    for (const [id, ws] of this.sockets) if (id !== except && ws.readyState === 1) ws.send(s);
  }
  /** True when `text` was said to `p` with { dedupe } less than EVENT_DEDUPE_MS ago (button mashing, several hooks saying the same). */
  dupWarn(p, text) {
    const now = Date.now(), seen = this.warnSeen || (this.warnSeen = new WeakMap());
    let m = seen.get(p); if (!m) seen.set(p, (m = new Map()));
    const last = m.get(text); m.set(text, now);
    if (m.size > 40) for (const [k, t] of m) if (now - t > EVENT_DEDUPE_MS) m.delete(k);
    return last != null && now - last < EVENT_DEDUPE_MS;
  }
  /** An accepted job on the wire: runner jobs carry `stepInfo` (the current step: what, where, can it be done now). */
  wireMine(p, j) { const w = wireJob(j); return isRunnerJob(j) && j.prog ? { ...w, stepInfo: this.jobsx.stepInfo(p, j) } : w; }
  sendYou(p, extra) { if (p.isActor) return; this.send(p, { t: 'you', you: this.privateState(p), ...(extra || {}) }); }
  sendHarbor(p) {
    if (p.isActor) return;
    const h = harborById(p.docked); if (!h) return;
    const st = this.harbors[h.id];
    this.regenHarbor(h, st, false);
    this.jobsx.ensureFit(st.jobs, h, p, this.simTime, this.rnd, this.jobEnv(), { phase: JOBS_PHASE });   // YARD §5.7: ≥ 3 doable jobs
    const geom = this.harborGeom(h.id), anchor = this.harborAnchor(h);
    this.send(p, {
      t: 'harbor', harbor: { id: h.id, name: h.name, country: h.country, size: h.size, lat: h.lat, lon: h.lon, fuelPrice: this.fuelPrice(h), repairCost: this.repairCost(p),
        rules: this.politics ? this.politics.harbourPayload(p, h) : null,
        jobs: st.jobs.map(wireJob), market: st.market, econ: this.econ ? { ...this.harborEcon(st), ...this.econ.harborView(h.id, p) } : this.harborEcon(st), contact: p.contactSeen === h.id && st.contact ? st.contact : null, contactLooked: p.contactSeen === h.id,
        shipyard: Object.values(SHIP_CLASSES).filter((c) => c.price > 0).map((c) => ({ id: c.id, name: c.name, cat: c.cat, price: c.price, desc: c.desc, tradeIn: shipValue(p.ship.cls, p.cond), specs: shipSpecs(c.id) })),
        used: st.used || [], tradeIn: shipValue(p.ship.cls, p.cond), sellValue: p.ship.cls === 'pilot' ? 0 : shipValue(p.ship.cls, p.cond),
        yard: this.yard.view(p, h),                  // SHIPYARD §7.3: newbuild/stock/used/orders (old shipyard/used kept one release)
        berths: geom ? geom.berths || [] : [], anchor: { lat: anchor.lat, lon: anchor.lon }, geomSource: geom ? geom.source : null, berth: p.berth || null,
        tugCost: tugCostFor(p.ship.cls), fees: this.feesFor(p, h), serviceDue: p.serviceDue,
        dockedPlayers: [...this.byId.values()].filter((o) => o.online && o.docked === h.id && o.id !== p.id).map((o) => ({ id: o.id, name: o.name })),
        quay: quayHarbourInfo(p),                    // DOCK ANYWHERE: { name, tier, hdKm, perDay, since, paid } at a quay, else null
        ...this.fleet.harborFields(p, h) },          // v6: office, fleetHere, fleetFull, fleetN
    });
  }
  feesFor(p, h) { return { dues: portDues(p.ship.cls, h), berthPerDay: berthFeePerDay(p.ship.cls), pilotage: pilotageFee(p.ship.cls, h), tug: tugCostFor(p.ship.cls), service: serviceCostFor(p.ship.cls) }; }
  fuelPrice(h) { return Math.round(this.harbors[h.id].market.fuel * (h.fuelMul || 1)); }
  repairCost(p) { return repairCostFor(p.ship.cls, p.cond); }
  aiNear(lat, lon) {
    if (!this.traffic) return [];
    try { const l = this.traffic.near(lat, lon, SIM.AI_RANGE_U) || []; return this.aiFilter ? l.filter(this.aiFilter) : l; } catch (e) { this.log(`[game] traffic.near failed: ${e.message}`); return []; }
  }

  connect(ws, tok, name) {
    const p = this.findOrCreatePlayer(tok, name);
    const old = this.sockets.get(p.id);
    if (old && old !== ws) { try { old.close(4001, 'replaced'); } catch {} }
    this.sockets.set(p.id, ws);
    p.online = true; p.lastSeen = Date.now(); p.lastTick = Date.now();
    // A (re)connecting client starts in real time: it has no route yet and its clock mirrors you.warp.
    this.resetWarp(p);
    ws.send(JSON.stringify({
      t: 'welcome', token: p.token, you: this.privateState(p), world: this.worldInfo(),
      players: [...this.byId.values()].filter((o) => o.online && o.id !== p.id).map((o) => this.publicState(o)),
      cutters: this.cutters.map(cutterPublic), wrecks: this.wrecks, wind: this.wind, simTime: this.simTime, log: p.log || [],
      storms: this.stormsPublic(), rescues: this.rescuesPublic(), ai: this.aiNear(p.ship.lat, p.ship.lon),
    }));
    if (this.weather) { try { this.weather.request(p.ship.lat, p.ship.lon); } catch {} }
    this.broadcast({ t: 'join', player: this.publicState(p) }, p.id);
    if (p.docked) this.sendHarbor(p);
    this.fleet.sendFleet(p);                           // v6 §10.2: the owner's FleetView on connect (chip, Office, HQ)
    this.event(p, 'info', `Welcome aboard, ${p.name}. ${p.docked ? 'You are docked at ' + harborById(p.docked).name + '.' : ''}`);
    return p;
  }
  disconnect(p) {
    if (this.sockets.get(p.id)) this.sockets.delete(p.id);
    p.online = false; p.lastSeen = Date.now();
    this.resetWarp(p); // offline voyages run in real time
    if (p.hail) {
      const c = this.cutters.find((x) => x.id === p.hail.cutterId);
      this.bumpWanted(p, 1); p.hail = null;
      if (c) { c.state = 'patrol'; c.targetId = null; c.timer = 0; }
      p.log = (p.log || []).slice(-30).concat([{ kind: 'law', text: 'You vanished during a coast-guard hail. Noted as fleeing: wanted level ' + p.wanted + '.', time: Date.now() }]);
    }
    this.broadcast({ t: 'leave', id: p.id });
    this.cancelOffersOf(p);
    this.fleet.unwatch(p);
  }

  // ------------------------------------------------------------------ inbound messages
  onState(p, m) {
    if (m.vid != null && m.vid !== p.aboard) return;   // v6: states for the ship you just left never move the new one
    if (p.docked || p.flooding >= 1 || p.assist) return; // under tug assist the server owns the position
    const s = p.ship;
    const lat = Number(m.lat), lon0 = Number(m.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon0) || Math.abs(lat) > 85) return;
    const lon = wrapLon(lon0);
    const now = Date.now();
    const dt = Math.min(10, (now - (p.lastState || now)) / 1000) || 0.1;
    p.lastState = now;
    const C = SHIP_CLASSES[s.cls];
    // Distance budget: the ship may cover at most max speed (plus current/leeway margin) for the elapsed time.
    // Unused budget carries over for a few seconds so network jitter does not trigger rejections, but cannot
    // be banked indefinitely (no speed hacks by message spamming). Time warp multiplies the budget by the factor (for
    // GRACE_MS after a drop the old factor still applies to states the client sent before it heard of the drop).
    const vmaxKn = C.sail ? Math.max(C.maxKn, maxSpeedKn(s.cls)) : C.maxKn;   // sailing: the rig's absolute cap (§3.8)
    const perSec = (vmaxKn * 1.35 * GEO.KN_TO_MS * SIM.MOTION_SCALE + 1.5 * SIM.MOTION_SCALE) * this.warpBudgetFactor(p, now);
    p.moveBudget = Math.min(perSec * 5, (p.moveBudget == null ? perSec * 5 : p.moveBudget) + perSec * dt);
    const moved = haversine(s.lat, s.lon, lat, lon);
    if (moved > p.moveBudget + 5) {
      p.rejects = (p.rejects || 0) + 1;
      if (p.rejects === 1 || p.rejects % 20 === 0) this.event(p, 'warn', 'Position corrected by the server.');
      this.sendYou(p, { correction: true });
      return;
    }
    // Harbour geometry: a position inside a quay, breakwater, pontoon or land is rejected outright (the client's
    // collision resolver must never let the hull end up there). `null` = no built patch covers the point.
    const pen = this.landPenetration(lat, lon);
    if (pen != null && pen > LAND_PENETRATION_M) {
      p.rejects = (p.rejects || 0) + 1;
      if (now - (p.lastLandWarn || 0) > 10000) { p.lastLandWarn = now; this.event(p, 'warn', `Position rejected: ${pen.toFixed(1)} m inside the harbour structure. Corrected by the server.`); }
      this.sendYou(p, { correction: true });
      return;
    }
    p.rejects = 0; p.moveBudget -= moved;
    if (m.rv !== undefined && rigOf(s.cls)) {        // sailing: the skipper's rig view for the others (§3.7), ≤ 2 Hz
      const prev = this.rigViews.get(p);
      if ((!prev || now - prev.at >= 450) && unpackRigView(s.cls, m.rv)) this.rigViews.set(p, { rv: m.rv.slice(), at: now, cls: s.cls });
    }
    const hdg = Number(m.hdg), spd = Number(m.spd), thr = Number(m.throttle), rud = Number(m.rudder);
    s.lat = clampLat(lat); s.lon = lon; s.hdg = Number.isFinite(hdg) ? normDeg(hdg) : s.hdg;
    s.spd = clamp(Number.isFinite(spd) ? spd : 0, -C.maxKn * 0.6, vmaxKn * 1.1); // astern top speed is ~half the ahead speed (telegraph)
    s.throttle = clamp(Number.isFinite(thr) ? thr : 0, THROTTLE_MIN, 1); s.rudder = clamp(Number.isFinite(rud) ? rud : 0, -1, 1);
    p.stats.distanceKm += moved / 1000;
    // Land/shallow plausibility: tolerate brief shallows (client stops itself), teleport back if it persists.
    // Inside a built harbour patch the patch mask is the authority (coarse raster cells are 556 m); the tide adds to the depth.
    const depth = pen != null ? Infinity : this.world.depthAt(lat, lon) + tideAt(lat, lon, this.simTime).height;
    if (depth < C.draft * 0.5) {
      if (!p.shallowSince) p.shallowSince = now;
      else if (now - p.shallowSince > 4000) {
        s.lat = p.lastValid.lat; s.lon = p.lastValid.lon; s.spd = 0; p.shallowSince = 0;
        this.event(p, 'warn', 'Aground — the server moved you back to deeper water.');
        this.sendYou(p, { correction: true });
      }
    } else { p.shallowSince = 0; p.lastValid = { lat, lon }; }
  }
  landPenetration(lat, lon) {
    if (!this.geom) return null;
    try { const v = this.geom.landPenetration(lat, lon); return Number.isFinite(v) ? v : null; } catch { return null; }
  }

  onAction(p, m) {
    const a = m.action;
    // DOCK ANYWHERE: moored at a quay, harbour services are refused or trucked by tier (shared/quayrules.js)
    if (p.berth?.quay && !m.quayGated && ACTION_SERVICE[a]) {
      try { return quayGate(this, p, a, m, () => this.onAction(p, { ...m, quayGated: true })); } catch (e) { this.log(`[game] quay gate ${a} failed: ${e.stack || e}`); return; }
    }
    try {
      if (typeof a === 'string' && a.startsWith('pol_') && this.politics) {
        if (p.office && !this.fleet.allow(p)) return;   // the fleet actions' token bucket
        if (a === 'pol_home_plan' || a === 'pol_home_start') {   // the existing office rules (cost, cooldown, laid-up ships) come first
          const hm = this.fleet.homeMove(p, harborById(m.harbor));
          if (a === 'pol_home_start' && hm.allowed !== true) return this.event(p, 'warn', hm.allowed);
          m = { ...m, baseCost: hm.cost };
        }
        const r = this.politics.onAction(p, m);
        if (r !== null) { this.sendYou(p); if (p.docked) this.sendHarbor(p); this.fleet.dirty?.(p); return; }
      }
      switch (a) {
        case 'quay_query': return quayQuery(this, p);
        case 'quay_dock': if (this.ww && p.lockStay && this.ww.makeFast(p.lockStay.lockId, p.id)) { this.event(p, 'info', 'Made fast in the lock chamber.'); return this.sendYou(p); } return quayDock(this, p, m);   // in a lock: Moor = make fast
        case 'quay_tugs': return quayTugs(this, p, m);
        case 'dock': return this.dock(p);
        case 'undock': return this.undock(p);
        case 'tug_assist': return this.tugAssist(p);
        case 'set_warp': return this.setWarp(p, m);
        case 'ballast': return this.ww ? this.ballastCmd(p, m) : this.event(p, 'warn', `Unknown action ${a}`);   // BRIDGES & LOCKS
        case 'fold': return this.ww ? this.foldCmd(p, m) : this.event(p, 'warn', `Unknown action ${a}`);
        case 'ww_query': return this.ww ? this.send(p, { t: 'ww_static', objects: this.ww.statics(+m.lat, +m.lon, Math.min(15000, (+m.r || 8) * (+m.r > 100 ? 1 : 1000))) }) : this.event(p, 'warn', `Unknown action ${a}`);
        case 'ww_button': return this.ww ? this.wwButton(p, m) : this.event(p, 'warn', `Unknown action ${a}`);
        case 'lock_register': return this.ww ? this.lockRegister(p, m) : this.event(p, 'warn', `Unknown action ${a}`);
        case 'mh_query': { if (!this.mh) return this.event(p, 'warn', `Unknown action ${a}`); const b = String(m.bbox || '').split(',').map(Number); if (this.mh && b.length === 4 && b.every(Number.isFinite)) this.send(p, { t: 'mh_list', harbours: this.mh.inBbox(b, Number(m.z) || 11) }); return; }
        case 'collision': return this.collision(p, m);
        case 'sell_ship': return this.sellShip(p);
        case 'service': return this.service(p);
        case 'lookaround': return this.lookAround(p);
        case 'buy_fuel': return this.buyFuel(p, +m.tonnes);
        case 'tow_pickup': return this.towPickup(p, m.jobId);
        case 'deliver_offshore': return this.deliverOffshore(p, m.jobId);
        case 'express': return this.expressPassage(p, +m.lat, +m.lon);
        case 'buy_used': return this.fleet.buyUsed(p, m);   // v6: tradeIn !== false → today's buyUsedShip
        case 'set_voyage': return this.setVoyage(p, m);
        case 'sails': return this.rigCommand(p, { all: m.up ? 'set' : 'furl' }, true);   // legacy button → the rig (§3.4)
        case 'rig': return this.rigCommand(p, m.cmd);
        case 'rig_event': return this.rigEvent(p, m);
        case 'repair': return this.repair(p);
        case 'buy_kit': return this.buyKit(p);
        case 'accept_job': return this.acceptJob(p, m.jobId);
        case 'job_step': return this.runnerStep(p, String(m.jobId ?? ''));
        case 'abandon_job': return this.abandonJob(p, m.jobId);
        case 'deliver_jobs': return this.deliverHere(p, m.jobId != null ? String(m.jobId) : null);
        case 'buy_goods': return this.tradeGoods(p, m.good, +m.qty, true);
        case 'sell_goods': return this.tradeGoods(p, m.good, +m.qty, false);
        case 'dump_cargo': return this.dumpCargo(p, m.good);
        case 'deliver_request': case 'pledge_request': case 'unpledge_request': {   // world economy §7.3
          if (!this.econ) return this.event(p, 'warn', `Unknown action ${a}`);
          const r = a === 'deliver_request' ? this.econ.deliver(p, m.reqId, +m.qty || Infinity) : a === 'pledge_request' ? this.econ.pledge(p, m.reqId, +m.qty) : this.econ.unpledge(p, m.reqId);
          this.event(p, r.ok ? 'info' : 'warn', r.text); this.sendYou(p); if (p.docked) this.sendHarbor(p); return;
        }
        case 'mh_trade': {   // world economy §9.6: a small trade at an inland harbour, against the parent's pool
          const mh = this.mh?.get?.(String(m.mhId || '')), parent = mh && (mh.sub?.id || mh.link?.id);
          if (!mh || !parent || !this.econ) return this.event(p, 'warn', 'No market here.');
          if (haversine(p.ship.lat, p.ship.lon, mh.lat, mh.lon) > 1500 || Math.abs(p.ship.spd || 0) > 1) return this.event(p, 'warn', `Come alongside at ${mh.name} first.`);
          const r = this.econ.inlandTrade(p, { id: mh.id, parent, tier: mh.tier }, String(m.good || ''), +m.qty, m.side === 'buy');
          this.event(p, r.ok ? 'info' : 'warn', r.text); return this.sendYou(p);
        }
        case 'debug_econ': {   // SALTLINE_DEBUG=1 only: force a market event or a stock level at the docked harbour
          if (process.env.SALTLINE_DEBUG !== '1' || !this.econ || !p.docked) return this.event(p, 'warn', `Unknown action ${a}`);
          if (m.dockAt && harborById(String(m.dockAt))) { const h2 = harborById(String(m.dockAt)), an = this.harborAnchor(h2); p.docked = h2.id; p.berth = null; Object.assign(p.ship, { lat: an.lat, lon: an.lon, spd: 0 }); p.lastValid = { lat: an.lat, lon: an.lon }; this.sendYou(p); }
          const st = this.harbors[p.docked];
          if (m.kind) this.econ.forceEvent(p.docked, String(m.kind), +m.hours || 48, m.good || null);
          if (m.good && Number.isFinite(+m.ratio) && st.target?.[m.good] > 0) { st.stock[m.good] = Math.round(st.target[m.good] * +m.ratio); this.econ.step(1 / 60, this.simTime); }
          return this.sendHarbor(p);
        }
        case 'buy_ship': return this.fleet.buyShip(p, m);   // v6: tradeIn !== false → today's buyShip
        case 'yard_order': case 'yard_pay': case 'yard_cancel': case 'yard_deliver': case 'yard_buy_stock':
        case 'yard_inspect': case 'yard_buy_used': case 'yard_repaint': case 'yard_rename':
          this.yard.action(p, m); this.sendYou(p); return this.sendHarbor(p);   // SHIPYARD §7.3 (YARD_ACTIONS)
        case 'patch': return this.patch(p);
        case 'fish': return this.setFishing(p, !!m.on);
        case 'tow': return this.tow(p);
        case 'grounding': return this.grounding(p);
        case 'board': return this.board(p, m.targetId);
        case 'salvage': return this.salvage(p, m.wreckId);
        case 'trade_offer': return this.tradeOffer(p, m);
        case 'trade_accept': return this.tradeAccept(p, m.offerId);
        case 'trade_decline': return this.tradeDecline(p, m.offerId);
        case 'convoy_invite': return this.convoyInvite(p, m.targetId);
        case 'convoy_accept': return this.convoyAccept(p, m.convoyId);
        case 'convoy_leave': return this.convoyLeave(p);
        case 'casino': return this.casino.onAction(p, m);
        case 'venue': return this.venues.onAction(p, m);
        case 'vhf_set': case 'vhf_tx': case 'dsc': return this.radio ? this.radio.onAction(p, m) : this.event(p, 'warn', `Unknown action ${a}`);   // VHF (§8.2)
        case 'rename': p.name = cleanName(m.name) || p.name; this.sendYou(p); this.broadcast({ t: 'rename', id: p.id, name: p.name }); return;
        case 'debug_sea': {   // SALTLINE_DEBUG=1 only: force this skipper's reported sea state to Beaufort 0..12 (null = real weather)
          if (process.env.SALTLINE_DEBUG !== '1') return this.event(p, 'warn', `Unknown action ${a}`);
          const b = m.bft === null || m.bft === undefined || m.bft === '' ? null : Math.round(Number(m.bft));
          p.debugBft = Number.isFinite(b) ? clamp(b, 0, 12) : null;
          this.event(p, 'info', p.debugBft == null ? 'Debug: real weather again.' : `Debug: sea state forced to Beaufort ${p.debugBft}.`);
          return this.sendYou(p);
        }
        default: if (this.fleet.handles(a)) return this.fleet.onAction(p, m); this.event(p, 'warn', `Unknown action ${a}`);
      }
    } catch (e) {
      this.log(`[game] action ${a} failed: ${e.stack || e}`);
      this.event(p, 'warn', 'That did not work.');
    }
  }
  onChat(p, text) {
    text = String(text || '').slice(0, 200).trim();
    if (!text) return;
    this.broadcast({ t: 'chat', from: p.name, id: p.id, text, time: Date.now() });
  }

  // ------------------------------------------------------------------ harbour actions
  // Distances to harbours are measured from the ANCHOR (the built geometry's guaranteed-water point).
  nearestHarbor(lat, lon) {
    let best = null, bd = Infinity;
    for (const h of HARBORS) { const a = this.harborAnchor(h); const d = unitsBetween(lat, lon, a.lat, a.lon); if (d < bd) { bd = d; best = h; } }
    return { harbor: best, units: bd };
  }
  // Common "ship is now in harbour" state: used by docking, tows, impounds, resets and rescues. Warp is kept (V6 item 6:
  // up to 5× moored); the teleports (tow, impound, forced reset, rescue landing) drop it themselves.
  setDocked(p, harborId, berth) {
    p.docked = harborId; p.dockedAt = this.simTime; p.berth = berth || null; p.assist = null;
    p.ship.spd = 0; p.ship.throttle = 0; p.ship.rudder = 0; p.fishing = false;
    if (p.jobs?.length) this.jobsx?.onDock(p, harborId);                       // YARD H6: players and captains (captain.js docks via setDocked/moorAt)
  }
  // Moor at a geometry berth: snap to the berth point, lie along the quay the way the ship is already pointing.
  moorAt(p, harbor, b) {
    const s = p.ship;
    s.lat = b.lat; s.lon = b.lon;
    s.hdg = Math.abs(angleDiff(s.hdg, b.hdg)) <= 90 ? normDeg(b.hdg) : normDeg(b.hdg + 180);
    p.lastValid = { lat: b.lat, lon: b.lon };
    this.setDocked(p, harbor.id, { harbor: harbor.id, id: b.id, name: b.name, hdg: s.hdg, lat: b.lat, lon: b.lon, depth: b.depth, length: b.length });
  }
  // Does this berth take the ship? Pontoons are small-craft only; the water must float the hull at the current tide.
  berthFits(p, b) {
    const C = SHIP_CLASSES[p.ship.cls];
    if (b.kind === 'pontoon' && C.length > 30) return `${b.name} is a pontoon for small craft; a ${C.name.toLowerCase()} needs a quay.`;
    const water = (Number.isFinite(b.depth) ? b.depth : 99) + tideAt(b.lat, b.lon, this.simTime).height;
    if (water + 0.3 < C.draft) return `${b.name} has ${water.toFixed(1)} m of water; you draw ${C.draft} m. Wait for the tide or pick a deeper berth.`;
    const maxLen = Number.isFinite(b.maxLength) ? b.maxLength : Number.isFinite(b.length) ? b.length : 1e9;
    if (C.length > maxLen * 1.5) return `${b.name} is ${Math.round(maxLen)} m long; your ${Math.round(C.length)} m hull will not fit.`;
    return null;
  }
  dock(p) {
    if (p.docked) return this.sendHarbor(p);
    if (p.assist) return this.event(p, 'info', 'The tugs have you. Hold on.');
    if (this.mh) { try { if (mhDock(this, p)) return; } catch (e) { this.log(`[mh] dock failed: ${e.stack || e}`); } }   // a box / visitor berth of an inland harbour within 60 m
    const { harbor, units } = this.nearestHarbor(p.ship.lat, p.ship.lon);
    if (!harbor || units > DOCK_SEARCH_RANGE_U) { if (quayDockNearest(this, p)) return; return this.event(p, 'warn', 'No harbour within docking range. Quays near you: Q.'); }
    const geom = this.harborGeom(harbor.id);
    let berth = null;
    if (geom && (geom.berths || []).length) {
      // (a) built harbour: come alongside a berth within 60 m at under 2 kn.
      let nb = null; try { nb = this.geom.nearestBerth(harbor.id, p.ship.lat, p.ship.lon); } catch { nb = null; }
      if (!nb || !nb.berth || nb.distM > INTERACT.BERTH_RANGE_U || Math.abs(p.ship.spd) > 2) { if (quayDockNearest(this, p)) return; return this.event(p, 'warn', `Come alongside a berth (within ${INTERACT.BERTH_RANGE_U} m, under 2 kn) or request tugs — or moor at any quay that fits (Q).`); }
      const why = this.berthFits(p, nb.berth);
      const alt = why ? fittingBerthWithin(geom.berths, p.ship.lat, p.ship.lon, INTERACT.BERTH_RANGE_U, (b) => this.berthFits(p, b)) : null; // the quay next to a pontoon
      if (why && !alt) return this.event(p, 'warn', why);
      berth = alt || nb.berth;
    } else {
      // (b) no geometry built yet: the legacy anchor rule.
      if (units > INTERACT.DOCK_RADIUS_U) { if (quayDockNearest(this, p)) return; return this.event(p, 'warn', 'No harbour within docking range. Quays near you: Q.'); }
      if (Math.abs(p.ship.spd) > 3) return this.event(p, 'warn', 'Too fast to dock — slow below 3 kn.');
    }
    if (p.hail) return this.event(p, 'law', 'The harbour master refuses: the coast guard has ordered you to heave to first.');
    if (this.politics) { const e = this.politics.entryCheck(p, harbor); if (e.refuse) return this.event(p, 'law', e.text); }
    if (berth) this.moorAt(p, harbor, berth); else this.setDocked(p, harbor.id, null);
    this.finishDock(p, harbor);
  }
  // Inspection, deliveries and fees once the lines are fast (docking and tug assists both end here).
  finishDock(p, harbor) {
    if (p.cond > 0) p.flooding = 0;
    this.event(p, 'info', p.berth ? `Moored at ${harbor.name}, ${p.berth.name}.` : `Docked at ${harbor.name}.`);
    // Port authority inspection happens at the quay, before anything is unloaded.
    const chance = p.wanted > 0 ? LAW.PORT_INSPECT_CHANCE_WANTED : LAW.PORT_INSPECT_CHANCE;
    const seized = this.rnd() < chance ? this.inspect(p, `${harbor.name} port authority`) : false;
    const pol = this.politics ? this.politics.onDock(p, harbor) : null;   // call record, seizure, designation, PSC, port incident
    if (pol?.incident?.outcome === 'loss') return;                        // the ship was abandoned (sink already ran)
    if (p.docked === harbor.id) this.deliverJobs(p, harbor);
    // Port dues scaled by ship size and harbour class; pilotage for big ships at the big ports.
    const dues = portDues(p.ship.cls, harbor), pilot = pilotageFee(p.ship.cls, harbor);
    if (dues > 0 && !seized) { p.money = Math.max(0, p.money - dues); this.event(p, 'info', `Port dues: ${fmt(dues)} cr.`); }
    if (pilot > 0 && !seized) { p.money = Math.max(0, p.money - pilot); this.event(p, 'info', `Pilotage (${SHIP_CLASSES[p.ship.cls].length} m hull, compulsory here): ${fmt(pilot)} cr.`); }
    this.sendYou(p); this.sendHarbor(p);
  }
  undock(p) {
    if (!p.docked) return;
    const held = this.politics?.canUndock(p); if (held) return this.event(p, 'law', held);
    if (quayUndock(this, p)) return;                    // DOCK ANYWHERE: the stay's balance, 20 m out on the water side
    const h = harborById(p.docked);
    // Berth fee per started 24 h alongside.
    const days = Math.max(1, Math.ceil((this.simTime - (p.dockedAt || this.simTime)) / 86400));
    const fee = p.docked === this.fleet.homeOf(p) ? 0 : days * berthFeePerDay(p.ship.cls);   // v6: no berth fee at home
    if (fee > 0) { p.money = Math.max(0, p.money - fee); this.event(p, 'info', `Berth fee: ${days} day${days > 1 ? 's' : ''} alongside, ${fmt(fee)} cr.`); }
    const spawn = this.undockPoint(p, h);
    p.docked = null; p.contactSeen = null; p.berth = null; p.dockedAt = null;
    p.ship.lat = spawn.lat; p.ship.lon = spawn.lon; if (Number.isFinite(spawn.hdg)) p.ship.hdg = spawn.hdg;
    p.lastValid = { lat: spawn.lat, lon: spawn.lon }; p.lastState = Date.now(); p.moveBudget = null; p.shallowSince = 0;
    this.event(p, 'info', `Cast off from ${h.name}. Fuel ${p.fuel.toFixed(1)} t, condition ${Math.round(p.cond)} %.`);
    this.sendYou(p, { correction: true });
  }
  // 20 m further out from the berth point (which is already 12 m off the quay face) on the deeper side; legacy = anchor.
  undockPoint(p, h) {
    const b = p.berth;
    if (!b || !Number.isFinite(b.lat) || !Number.isFinite(b.hdg)) return this.spawnPointNear(h);
    const cands = [normDeg(b.hdg + 90), normDeg(b.hdg - 90)].map((brg) => ({ brg, pt: destination(b.lat, b.lon, brg, 20) }));
    const score = (c) => {
      let v = null;
      if (this.geom) { try { v = this.geom.sdfAt(b.harbor || p.docked, c.pt.lat, c.pt.lon); } catch { v = null; } }
      if (!Number.isFinite(v)) { const pen = this.landPenetration(c.pt.lat, c.pt.lon); v = pen != null ? -pen : this.world.depthAt(c.pt.lat, c.pt.lon); }
      return v;
    };
    const best = cands.map((c) => ({ c, s: score(c) })).sort((a, b2) => b2.s - a.s)[0].c;
    return { lat: best.pt.lat, lon: best.pt.lon, hdg: Number.isFinite(p.ship.hdg) ? p.ship.hdg : b.hdg };
  }
  // ------------------------------------------------------------------ sailing (docs/SAILING-CONTRACT.md §3.4–§3.7)
  /** The rig of a sail-class ship (created/repaired lazily: §3.6); null for engine classes. */
  rigFor(p) { const s = p.ship; return s && rigOf(s.cls) ? ensureRig(s, p.docked ? false : p.sailsUp) : null; }
  /** { action: 'rig', cmd } and the legacy 'sails' button. ≤ 20 per second per person (extra dropped silently); no
   *  sendYou per command (the client is optimistic), a refused one gets `event warn`. */
  rigCommand(p, cmd, legacy = false) {
    const rig = this.rigFor(p);
    if (!rig) { if (legacy) { p.sailsUp = !!(cmd && cmd.all === 'set'); this.sendYou(p); } return; }
    let st = this.rigLimits.get(p); if (!st) { st = { times: [], jibeAt: 0, strainAt: 0 }; this.rigLimits.set(p, st); }
    const now = Date.now();
    while (st.times.length && now - st.times[0] >= 1000) st.times.shift();
    if (st.times.length >= 20) return;
    st.times.push(now);
    const r = applyRigCommand(p.ship.cls, rig, cmd);
    if (!r.ok) return this.event(p, 'warn', r.why);
    settleRig(rig);                                  // the server copy = what the crew is doing; her client runs the timing
    p.sailsUp = anyHoisted(rig);                     // the legacy master switch follows the rig (§3.6)
    if (legacy) this.sendYou(p);
  }
  /** { action: 'rig_event', kind: 'crash_jibe', aws } → §2.8 damage only with the helper off, ≤ once per 10 s;
   *  kind 'strain' (catamaran hull load ≥ 1 for 2 s, §2.6) → cond −1, ≤ once per 10 s, any helper level. */
  rigEvent(p, m) {
    const rig = this.rigFor(p); if (!rig || p.docked) return;
    let st = this.rigLimits.get(p); if (!st) { st = { times: [], jibeAt: 0, strainAt: 0 }; this.rigLimits.set(p, st); }
    const now = Date.now();
    if (m.kind === 'crash_jibe') {
      if (rig.auto !== 'off' || now - st.jibeAt < 10000) return;
      st.jibeAt = now;
      const dmg = crashJibeDamage(p.ship.cls, clamp(Number(m.aws) || 0, 0, 40));
      if (dmg > 0) { p.cond = Math.max(0, p.cond - dmg); this.event(p, 'warn', `Crash jibe! The boom slammed across — ${dmg.toFixed(1)} % condition lost.`); this.sendYou(p); }
    } else if (m.kind === 'strain') {
      if (!rigOf(p.ship.cls).cat || now - st.strainAt < 10000) return;
      st.strainAt = now; p.cond = Math.max(0, p.cond - 1);
      this.event(p, 'warn', 'The rig groans — the windward hull flew too long. Ease the sheets or reef.'); this.sendYou(p);
    }
  }
  /** rv for publicState (§3.7): online skippers' own (≤ 10 s old), else built from the ship's rig. */
  rvOf(p) {
    const s = p.ship; if (!s || !rigOf(s.cls)) return undefined;
    const got = this.rigViews.get(p);
    if (p.online && got && got.cls === s.cls && Date.now() - got.at < 10000) return got.rv;
    return packRigView(s.cls, this.rigFor(p)) || undefined;
  }
  /** Offline voyages and captains (§3.5): furl in the harbour band, hoist again clear of it, tack/gybe with sailCourse.
   *  → rudderCmd, or null when she is not sailing (engine class, every sail down). Memory: voyage.sail (saved, tiny). */
  sailHelmOffline(p, v, i, wp, brg, dist, nearM, env, dt) {
    const s = p.ship; if (!rigOf(s.cls)) return null;
    const rig = ensureRig(s, p.sailsUp);
    const mem = v.sail && typeof v.sail === 'object' ? v.sail : (v.sail = {});
    mem.t = (Number(mem.t) || 0) + dt;               // the voyage's own clock (captains substep inside one tick)
    const furl = harbourRigCmd(rig, nearM);
    if (furl) { applyRigCommand(s.cls, rig, furl); settleRig(rig); mem.furled = 1; }
    else if (mem.furled && !anyHoisted(rig) && nearM > HARBOUR_FURL_M) {
      const ww = windOverWater(env);
      applyRigCommand(s.cls, rig, departurePlan(s.cls, ww.tws / KN, angleDiff(brg, ww.twd))); settleRig(rig); mem.furled = 0;
    }
    p.sailsUp = anyHoisted(rig); env.sailsUp = p.sailsUp;
    if (!p.sailsUp) return null;
    const a = i > 0 ? v.route[i - 1] : (Array.isArray(mem.o) ? mem.o : (mem.o = [s.lat, s.lon]));
    const h = sailHelm(s.cls, s, { brg, distM: dist, xtM: crossTrackM(s.lat, s.lon, a[0], a[1], wp[0], wp[1]), env, nowS: mem.t, mem });
    return h ? h.rudderCmd : null;
  }
  // Tugs: within 1500 m of the anchor, under 6 kn, no hail. They walk the ship to the best berth over 45 s.
  tugAssist(p) {
    if (p.docked || p.assist || p.flooding >= 1) return;
    if (p.hail) return this.event(p, 'law', 'No tug will take a line while the coast guard is hailing you.');
    const { harbor, units } = this.nearestHarbor(p.ship.lat, p.ship.lon);
    if (!harbor || units > INTERACT.TUG_RANGE_U) return this.event(p, 'warn', `Tugs only come out within ${INTERACT.TUG_RANGE_U} m of the harbour entrance.`);
    if (Math.abs(p.ship.spd) > 6) return this.event(p, 'warn', 'Slow below 6 kn so the tugs can make fast.');
    const cost = tugCostFor(p.ship.cls);
    if (p.money < cost) return this.event(p, 'warn', `The tugs want ${fmt(cost)} cr up front. You have ${fmt(p.money)}.`);
    if (this.politics) { const e = this.politics.entryCheck(p, harbor); if (e.refuse) return this.event(p, 'law', e.text); }   // world politics H8: no tugs into a port that refuses you
    const geom = this.harborGeom(harbor.id);
    let berth = null, tugPlan = null;
    if (geom && (geom.berths || []).length) {
      const ok = geom.berths.filter((b) => !this.berthFits(p, b));
      // tugs never put her on top of a ship lying there (or being brought in there) when a free fitting berth exists
      const taken = this.fleet.berthsTaken(harbor.id, p.vessel);   // v6: every vessel moored or being brought in there
      const free = ok.filter((b) => !taken.has(b.id));
      const pool = free.length ? free : ok.length ? ok : geom.berths;
      const guided = p.guideBerth?.harbor === harbor.id ? pool.find((b) => b.id === p.guideBerth.id) : null; // the berth the guidance card leads to
      berth = guided || pool.map((b) => ({ b, d: haversine(p.ship.lat, p.ship.lon, b.lat, b.lon) })).sort((a, c) => a.d - c.d)[0].b;
      // V5 item 4: a water-only path from here (server/tugassist.js); no path → refuse, nothing charged; no patch → legacy walk
      tugPlan = planTugAssist(this, p, harbor, tugBerthCandidates(berth, pool, p.ship.lat, p.ship.lon));
      if (tugPlan && !tugPlan.ok) return this.event(p, 'warn', tugPlan.msg);
      if (tugPlan) berth = tugPlan.berth;
    }
    const anchor = this.harborAnchor(harbor);
    const to = berth ? { lat: berth.lat, lon: berth.lon, hdg: berth.hdg } : { lat: anchor.lat, lon: anchor.lon, hdg: p.ship.hdg };
    const now = Date.now();
    p.money -= cost; p.fishing = false; p.voyage = null;
    p.ship.throttle = 0; p.ship.rudder = 0;
    { const rig = this.rigFor(p); if (rig && anyHoisted(rig)) { applyRigCommand(p.ship.cls, rig, { all: 'furl' }); settleRig(rig); p.sailsUp = false; this.event(p, 'info', 'The crew furls the sails for the tow.'); } }
    p.assist = { harbor: harbor.id, berthId: berth ? berth.id : null, berthName: berth ? berth.name : null, from: { lat: p.ship.lat, lon: p.ship.lon, hdg: p.ship.hdg }, to, start: now, until: now + FEES.TUG_SECONDS * 1000, cost };
    if (tugPlan) {
      const t = beginTugAssist(this, p, harbor, tugPlan); p.assist.opId = t.id; p.assist.until = t.until;
      this.event(p, 'info', `${t.tugs === 1 ? 'A harbour tug is' : 'Two harbour tugs are'} on the way for ${fmt(cost)} cr. They will take you alongside ${berth.name} — about ${Math.max(1, Math.round((t.until - now) / 60000))} min.`);
      return this.sendYou(p, { correction: true });
    }
    this.event(p, 'info', `Two tugs made fast for ${fmt(cost)} cr. They will put you ${berth ? `alongside ${berth.name}` : 'in the harbour'} in ${FEES.TUG_SECONDS} s.`);
    this.sendYou(p, { correction: true });
  }
  // Tick: the server walks an assisted ship from `from` to the berth, then moors it exactly as dock() would.
  // Harbour warp (V6 item 6): the assist runs w× faster; the HUD countdown (`assist.until`) shows the real time left.
  stepAssist(p, dt = 0.1) {
    const w = this.warpOf(p);
    if (p.assist?.opId && stepTugAssist(this, p, dt * w)) { // planned path + visible tugs (server/tugassist.js), w× faster
      if (p.assist && w > 1) { const now = Date.now(); p.assist.until = now + Math.max(0, p.assist.until - now) / w; }
      return;
    }
    if (w > 1 && p.assist) { const extra = dt * 1000 * (w - 1); p.assist.start -= extra; p.assist.until -= extra; } // legacy walk: progress w× faster
    const a = p.assist, s = p.ship, now = Date.now();
    const dur = Math.max(1, a.until - a.start);
    const f = now >= a.until ? 1 : Math.max(0, Math.min(1, (now - a.start) / dur));
    const e = f < 1 ? f * f * (3 - 2 * f) : 1; // ease in/out
    s.lat = a.from.lat + (a.to.lat - a.from.lat) * e; s.lon = wrapLon(a.from.lon + wrapLon(a.to.lon - a.from.lon) * e);
    const targetHdg = Math.abs(angleDiff(a.from.hdg, a.to.hdg)) <= 90 ? a.to.hdg : normDeg(a.to.hdg + 180);
    s.hdg = normDeg(a.from.hdg + angleDiff(a.from.hdg, targetHdg) * e);
    s.spd = f < 1 ? Math.round((haversine(a.from.lat, a.from.lon, a.to.lat, a.to.lon) / (dur / 1000)) / GEO.KN_TO_MS * 10) / 10 * (1 - Math.abs(2 * f - 1)) : 0;
    s.throttle = 0; s.rudder = 0;
    p.lastValid = { lat: s.lat, lon: s.lon };
    if (f < 1) return;
    if (a.quay) { quayAssistDone(this, p, a); return; }   // DOCK ANYWHERE: re-fit the quay, moor, day 1 + dues
    const harbor = harborById(a.harbor);
    const geom = harbor && this.harborGeom(harbor.id);
    const b = geom && a.berthId ? (geom.berths || []).find((x) => x.id === a.berthId) : null;
    p.assist = null;
    if (!harbor) { this.sendYou(p, { correction: true }); return; }
    if (b) this.moorAt(p, harbor, b); else { s.lat = a.to.lat; s.lon = a.to.lon; this.setDocked(p, harbor.id, null); }
    this.event(p, 'info', 'Tugs cast off.');
    this.finishDock(p, harbor);
    this.sendYou(p, { correction: true });
  }
  // Client-reported contact with a quay, breakwater or another ship (rate-limited to one per 3 s).
  collision(p, m) {
    this.jobsx?.onIncident(p, 'collision');
    if (p.docked || p.assist || p.flooding >= 1) return;
    const now = Date.now();
    if (now - (p.lastCollision || 0) < 3000) return;
    const speedKn = Math.min(60, Math.abs(Number(m.speedKn)) || 0);
    if (speedKn < FEES.COLLISION_MIN_KN) return; // a nudge against the fenders
    p.lastCollision = now;
    const kind = m.kind === 'ship' || m.kind === 'breakwater' ? m.kind : 'quay';
    const dmg = Math.round(clamp(speedKn * 0.9, 0.5, 12) * (kind === 'ship' ? 0.6 : 1) * 10) / 10;
    p.cond = Math.max(0, p.cond - dmg);
    if (speedKn > 8) p.flooding = Math.min(1, p.flooding + 0.05);
    p.stats.collisions = (p.stats.collisions || 0) + 1;
    p.ship.spd *= 0.4;
    const what = kind === 'ship' ? 'another ship' : kind === 'breakwater' ? 'the breakwater' : 'the quay';
    this.event(p, 'warn', `${speedKn >= 8 ? 'Heavy contact' : speedKn >= 3 ? 'Collision' : 'Bumped'} with ${what} at ${speedKn.toFixed(1)} kn: hull −${dmg} %${speedKn > 8 ? ', taking water' : ''}. Condition ${Math.round(p.cond)} %.`);
    this.dropWarp(p, `Contact with ${what}.`, false);
    this.sendYou(p);
  }
  // Sell the current hull at shipValue; the yard leaves you a well-used pilot boat so the market is a real buy/sell market.
  sellShip(p) {
    if (!p.docked) return;
    const cls = p.ship.cls, C = SHIP_CLASSES[cls];
    if (cls === 'pilot') return this.event(p, 'warn', 'Nobody buys the pilot boat — it is the one hull the yard will not take.');
    const value = shipValue(cls, p.cond);
    const P = SHIP_CLASSES.pilot;
    if (cargoMass(p.cargo) > P.capacity) return this.event(p, 'warn', `Unload first: a pilot boat carries ${P.capacity} t and you have ${Math.round(cargoMass(p.cargo))} t aboard.`);
    const pax = p.jobs.filter((j) => j.pax).reduce((s, j) => s + j.pax, 0);
    if (pax > P.pax) return this.event(p, 'warn', 'Your passengers would not fit in a pilot boat. Deliver them first.');
    if (p.towing) return this.event(p, 'warn', 'Finish the tow first.');
    p.money += value; p.stats.earned += value;
    p.ship.cls = 'pilot'; p.cond = 60; p.flooding = 0; p.fuel = Math.min(p.fuel, P.fuelCap); p.sailsUp = true;
    p.serviceDue = this.simTime + SERVICE_INTERVAL_S / 2;
    this.event(p, 'info', `Sold the ${C.name} for ${fmt(value)} cr. The yard threw in a tired pilot boat (60 %) so you can get about.`);
    this.sendYou(p); this.sendHarbor(p);
  }
  // Yard service: 1 % of the hull price resets the 30-day maintenance clock that otherwise ramps wear up to +60 %.
  service(p) {
    if (!p.docked) return;
    const cost = serviceCostFor(p.ship.cls);
    if (p.money < cost) return this.event(p, 'warn', `A service costs ${fmt(cost)} cr. You have ${fmt(p.money)}.`);
    const overdue = Math.max(0, (this.simTime - (p.serviceDue || this.simTime)) / 86400);
    p.money -= cost; p.serviceDue = this.simTime + SERVICE_INTERVAL_S;
    this.event(p, 'info', `Engine and hull serviced for ${fmt(cost)} cr${overdue > 0 ? ` (${Math.ceil(overdue)} days overdue — wear back to normal)` : ''}. Next service due in ${FEES.SERVICE_INTERVAL_DAYS} days.`);
    this.sendYou(p); this.sendHarbor(p);
  }
  lookAround(p) {
    if (!p.docked) return;
    const st = this.harbors[p.docked];
    p.contactSeen = p.docked;
    if (st.contact) this.event(p, 'shady', `${st.contact.name} nods at you from behind the containers. "Looking for work that pays?"`);
    else this.event(p, 'info', 'You wander the quays. Nobody here wants to talk business today.');
    this.sendHarbor(p);
  }
  buyFuel(p, t) {
    if (!p.docked) return;
    const h = harborById(p.docked), C = SHIP_CLASSES[p.ship.cls];
    t = Math.max(0, Math.min(C.fuelCap - p.fuel, isFinite(t) ? t : C.fuelCap));
    const cost = Math.round(t * this.fuelPrice(h));
    if (t <= 0.01) return this.event(p, 'warn', 'Tanks are full.');
    if (cost > p.money) { t = Math.floor((p.money / this.fuelPrice(h)) * 10) / 10; if (t <= 0) return this.event(p, 'warn', 'You cannot afford any fuel.'); }
    const c2 = Math.round(t * this.fuelPrice(h));
    p.money -= c2; p.fuel = Math.min(C.fuelCap, p.fuel + t);
    const st = this.harbors[h.id];
    if (st.stock) { st.stock.fuel = Math.max(0, (st.stock.fuel || 0) - t); refreshPrices(h, st); }
    this.event(p, 'info', `Bunkered ${t.toFixed(1)} t for ${fmt(c2)} cr.`);
    this.sendYou(p); this.sendHarbor(p);
  }
  repair(p) {
    if (!p.docked) return;
    const cost0 = this.repairCost(p);
    if (cost0 <= 0) return this.event(p, 'warn', 'Nothing to repair.');
    const credit = this.politics ? this.politics.repairCredit(p) : 0;   // hull points from covered war incidents (30 days)
    const covered = credit > 0 ? Math.min(cost0, Math.round(cost0 * Math.min(1, credit / Math.max(1, 100 - p.cond)))) : 0;
    const cost = cost0 - covered;
    if (covered > 0) this.event(p, 'info', `War cover pays ${fmt(covered)} cr of the repair.`);
    if (cost > p.money) {
      const frac = p.money / cost; const gain = (100 - p.cond) * frac;
      if (gain < 1) return this.event(p, 'warn', 'You cannot afford repairs.');
      p.cond += gain; p.money = 0; p.flooding = 0;
      this.event(p, 'info', `Partial repairs: condition now ${Math.round(p.cond)} %.`);
    } else { p.money -= cost; p.cond = 100; p.flooding = 0; this.event(p, 'info', `Full overhaul for ${fmt(cost)} cr. Condition 100 %.`); }
    if (p.antennaDmg) { p.antennaDmg = false; p.radioDamage = null; }   // VHF antenna (bridge strike) renewed with the repairs
    this.sendYou(p); this.sendHarbor(p);
  }
  buyKit(p) {
    if (!p.docked) return;
    if (p.money < 2500) return this.event(p, 'warn', 'A damage-control kit costs 2,500 cr.');
    p.money -= 2500; p.kits = (p.kits || 0) + 1;
    this.event(p, 'info', `Bought a damage-control kit (${p.kits} aboard).`);
    this.sendYou(p);
  }
  acceptJob(p, jobId) {
    if (!p.docked) return;
    const st = this.harbors[p.docked];
    let job = st.jobs.find((j) => j.id === jobId);
    let fromContact = false;
    if (!job && st.contact && p.contactSeen === p.docked) { job = st.contact.jobs.find((j) => j.id === jobId); fromContact = !!job; }
    if (!job) return this.event(p, 'warn', 'That contract is gone.');
    if (this.politics) { const c = this.politics.onAccept(p, job); if (c.block) return this.event(p, 'law', c.text); }
    if (isRunnerJob(job)) {                                                   // YARD lane D: runner families
      const r = this.jobsx.accept(p, job);
      if (!r.ok) return this.event(p, 'warn', r.why || 'Not possible with this ship.');
      if (fromContact) st.contact.jobs = st.contact.jobs.filter((j) => j.id !== jobId); else st.jobs = st.jobs.filter((j) => j.id !== jobId);
      this.event(p, 'info', `Contract signed: ${job.title} — ${fmt(payOf(r.job))} cr, ${fmtShipH(r.job.hours)} of ship time.${this.jobsx.stepInfo(p, r.job) ? ` Next: ${this.jobsx.stepInfo(p, r.job).text}.` : ''}`);
      this.sendYou(p); this.sendHarbor(p); return;
    }
    if ((job.gen || 0) >= JOB_GEN) {                                           // YARD §5.8: gen-8 legacy families are checked too
      const c = canDo(job, p, this.jobsCtx(p));
      if (!c.ok && c.why.code !== 'time') return this.event(p, 'warn', c.why.text);
    }
    const C = SHIP_CLASSES[p.ship.cls];
    if (job.type === 'passengers' || job.type === 'charter' || job.type === 'evac') {
      const used = p.jobs.filter((j) => j.pax).reduce((s, j) => s + j.pax, 0);
      if (used + job.pax > C.pax) return this.event(p, 'warn', `Not enough berths (${C.pax - used} free).`);
      if (job.needsCat && !job.needsCat.includes(C.cat)) return this.event(p, 'warn', `Charter guests expect a ${job.needsCat.join(' or ')}; a ${C.name.toLowerCase()} will not do.`);
    } else if (job.type === 'tow') {
      if (p.jobs.some((j) => j.type === 'tow')) return this.event(p, 'warn', 'One tow at a time.');
    } else if (job.type === 'supply') {
      if (cargoMass(p.cargo) + job.qty > C.capacity) return this.event(p, 'warn', `Not enough deck space (${C.capacity - cargoMass(p.cargo)} t free).`);
      p.cargo.push({ good: 'supplies', qty: job.qty, contraband: false, jobId: job.id });
    } else if (job.type !== 'fishing') {
      if (cargoMass(p.cargo) + job.qty > C.capacity) return this.event(p, 'warn', `Not enough hold space (${C.capacity - cargoMass(p.cargo)} t free).`);
      p.cargo.push({ good: job.good, qty: job.qty, contraband: !!job.contraband, jobId: job.id });
    }
    if (fromContact) st.contact.jobs = st.contact.jobs.filter((j) => j.id !== jobId); else st.jobs = st.jobs.filter((j) => j.id !== jobId);
    // V6 item 5: the contract's hours count on the ship's clock from now (a legacy offer: the hours left to its deadline).
    if (!Number.isFinite(p.shipTime)) p.shipTime = this.simTime;
    const hours = Number.isFinite(job.hours) && job.hours > 0 ? job.hours : Number.isFinite(job.deadline) ? Math.max(1, Math.round((job.deadline - this.simTime) / 36) / 100) : 24;
    const mine = { ...job, hours, acceptedAt: this.simTime, acceptedShip: p.shipTime, dueShip: p.shipTime + hours * 3600 };
    delete mine.deadline;
    p.jobs.push(mine);
    const held = cargoMass(p.cargo) - (job.type === 'fishing' || job.type === 'tow' || job.type === 'passengers' || job.type === 'charter' ? 0 : job.qty || 0);
    const est = estimateJob({ ...mine, richness: mine.richness ?? FISHING_GROUNDS.find((g) => g.id === mine.ground)?.richness },
      { cls: p.ship.cls, holdFreeT: C.capacity - held, paxFree: C.pax - p.jobs.filter((j) => j.pax && j !== mine).reduce((s, j) => s + j.pax, 0), budgetH: hours });
    this.event(p, fromContact ? 'shady' : 'info', `${fromContact ? 'Deal.' : 'Contract signed:'} ${job.title} — ${fmt(job.pay)} cr, ${fmtShipH(hours)} of ship time.`);
    if (!est.ok && !est.hard) this.event(p, 'warn', `Tight: ${est.why}. Late delivery pays half.`);
    const hint = job.type === 'tow' ? `The casualty is marked by an orange light column at sea. Come within ${INTERACT.TOW_RANGE_U} m under 3 kn and pass the tow line (J); harbour tugs take her over ${km1(INTERACT.TOW_HANDOVER_M)} km off ${harborById(job.to)?.name || 'the port'}.`
      : job.type === 'supply' ? `${job.platformName} is marked at sea. Hold station within ${INTERACT.PLATFORM_RANGE_U} m under 3 kn and start the crane transfer (J).`
      : job.type === 'fishing' ? `Sail to the ${job.groundName}, put the nets out (F) and trawl under ${INTERACT.FISH_MAX_KN} kn; land the catch here.`
      : `Sail to ${harborById(job.to)?.name || job.to} and moor there to deliver. Route on the contract card lays the course.`;
    this.event(p, 'info', hint);
    this.sendYou(p); this.sendHarbor(p);
  }
  abandonJob(p, jobId) {
    const j = p.jobs.find((x) => x.id === jobId); if (!j) return;
    p.jobs = p.jobs.filter((x) => x.id !== jobId);
    // Contract cargo goes back to the shipper (docked) or over the side (at sea); it never becomes free goods.
    p.cargo = p.cargo.filter((c) => c.jobId !== j.id);
    if (p.towing === j.id) p.towing = null;
    const penalty = Math.min(p.money, Math.round(payOf(j) * 0.1));
    p.money -= penalty;
    this.event(p, 'warn', `Abandoned: ${j.title}. Cancellation fee ${fmt(penalty)} cr.`);
    this.sendYou(p);
  }
  /** The harbour sheet's Deliver button: hand over what this port is waiting for, or say why a contract cannot be. */
  // `jobId` (the button of one contract): a step-runner job runs its current step (load, discharge, embark, land, drill).
  deliverHere(p, jobId = null) {
    const rj = jobId ? p.jobs.find((j) => j.id === jobId && isRunnerJob(j) && j.prog) : null;
    if (rj) return this.runnerStep(p, rj.id);
    if (!p.docked) return this.event(p, 'warn', 'Moor in the destination harbour to deliver.');
    const h = harborById(p.docked); if (!h) return;
    const n = this.deliverJobs(p, h);
    let moved = 0;
    const said = new Set(), warn = (t) => { if (!said.has(t)) { said.add(t); this.event(p, 'warn', t, { dedupe: true }); } };
    for (const j of [...p.jobs]) {                                             // runner jobs whose current step is in this port
      if (!isRunnerJob(j) || !j.prog || this.jobsx.stepInfo(p, j)?.at !== h.id) continue;
      const r = this.jobsx.tryStep(p, j);
      if (r.ok) moved++; else warn(`${j.title}: ${r.why}`);
    }
    if (!n && !moved) {
      const here = p.jobs.filter((j) => j.to === h.id && !(isRunnerJob(j) && this.jobsx.stepInfo(p, j)?.at === h.id));
      if (!here.length && !said.size) this.event(p, 'info', `No contract of yours ends at ${h.name}.`);
      for (const j of here) warn(`${j.title}: ${this.whyNotDeliverable(p, j)}`);
    }
    this.sendYou(p); this.sendHarbor(p);
  }
  /** The current step of runner job `jobId` from a button (Deliver in the harbour sheet, the contract card's J). */
  runnerStep(p, jobId) {
    const j = p.jobs.find((x) => x.id === jobId && isRunnerJob(x) && x.prog);
    if (!j) { this.event(p, 'warn', 'No such contract.'); return this.sendYou(p); }
    const r = this.jobsx.tryStep(p, j);
    if (!r.ok) this.event(p, 'warn', `${j.title}: ${r.why}`, { dedupe: true });
    this.sendYou(p); if (p.docked) this.sendHarbor(p);
  }
  whyNotDeliverable(p, j) {
    if (isRunnerJob(j) && j.prog) return this.jobsx.why(p, j);   // the runner's own step: load first, discharges at X …
    if (j.type === 'fishing') { const have = p.cargo.filter((c) => c.good === 'fish' && c.caught && !c.jobId).reduce((s, c) => s + c.qty, 0); return `needs at least ${Math.ceil(j.qty * 0.25)} t of fish you caught yourself aboard (you have ${Math.floor(have * 10) / 10} t; bought fish does not count).`; }
    if (j.type === 'tow') return p.towing === j.id ? 'the tow is still on the line.' : 'pick up the casualty first.';
    if (j.type === 'supply') return `the supplies go to ${j.platformName} at sea.`;
    if (j.qty && !p.cargo.some((c) => c.jobId === j.id)) return 'the contract cargo is no longer aboard.';
    return 'not deliverable here.';
  }
  deliverJobs(p, harbor) {
    let delivered = 0;
    for (const j of [...p.jobs]) {
      if (j.to !== harbor.id || isRunnerJob(j)) continue;   // YARD lane D: runner jobs settle in jobsx (pay is { cr, … })
      let ok = false, frac = 1;
      if (j.type === 'passengers' || j.type === 'charter') ok = true;
      else if (j.type === 'tow') { if (p.towing === j.id) { ok = true; p.towing = null; } }
      else if (j.type === 'supply') { if (j.loaded === false) ok = true; }
      else if (j.type === 'fishing') {
        const stacks = p.cargo.filter((c) => c.good === 'fish' && c.caught && !c.jobId);
        const have = stacks.reduce((s, c) => s + c.qty, 0);
        if (have >= j.qty * 0.25) {
          ok = true; frac = Math.min(1, have / j.qty);
          let left = Math.min(have, j.qty);
          for (const c of stacks) { const k = Math.min(c.qty, left); c.qty = Math.round((c.qty - k) * 10) / 10; left -= k; }
          p.cargo = p.cargo.filter((c) => c.qty > 0);
        }
      } else {
        const stack = p.cargo.find((c) => c.jobId === j.id);
        if (stack) { ok = true; frac = Math.min(1, stack.qty / j.qty); p.cargo = p.cargo.filter((c) => c !== stack); }
      }
      if (!ok) continue;
      this.payJob(p, j, frac, harbor); delivered++;
    }
    return delivered;
  }
  // Pay a finished contract (late = half pay; a port short of the good pays a demand bonus and restocks) and drop it.
  payJob(p, j, frac, harbor) {
    let pay = Math.round(j.pay * frac);
    if (!Number.isFinite(j.dueShip)) this.migrateAcceptedJob(p, j);
    const late = p.shipTime > (j.dueShip ?? Infinity); // V6 item 5: due on the ship's clock
    if (late) pay = Math.round(pay * 0.5);
    const pp = this.politics ? this.politics.onPaid(p, j, late, harbor) : null;   // standing, premium refund
    if (pp && pp.payMul !== 1) { pay = Math.round(pay * pp.payMul); this.event(p, 'warn', 'Entered an area the contract said to avoid: pay halved.'); }
    if (frac < 1) this.event(p, 'warn', `Short delivery: only ${Math.round(frac * 100)} % of the contracted quantity.`);
    // Demand bonus: a port short of the good pays extra, and the delivery replenishes its stock.
    let bonus = 0;
    const st = this.harbors[harbor.id];
    if (st && j.good && !j.contraband && j.type !== 'supply' && st.stock && st.stock[j.good] != null) {
      bonus = Math.round(pay * demandBonus(st, j.good));
      st.stock[j.good] += Math.round(j.qty * frac); refreshPrices(harbor, st);
    }
    pay += bonus;
    p.money += pay; p.stats.delivered++; p.stats.earned += pay;
    p.jobs = p.jobs.filter((x) => x.id !== j.id);
    this.event(p, j.contraband ? 'shady' : 'info', `${late ? 'Late delivery (half pay)' : 'Delivered'}: ${j.title} — +${fmt(pay)} cr${bonus ? ` (incl. ${fmt(bonus)} demand bonus)` : ''}.`);
  }

  // ------------------------------------------------------------------ V6 item 5: the ship's clock (docs/V6-QUICK-CONTRACTS.md §5.2)
  // How fast this ship's clock runs against the world clock: the warp factor at sea and moored (≤ 5× in harbours), times
  // the tug op's time compression under tugs; 1 in the life raft and while offline (offline voyages are real time).
  shipRate(p) {
    if (p.rescue || p.flooding >= 1) return 1;
    if (p.assist) { const op = tugOp(this, p.id); const r = op && Number.isFinite(op.rate) && op.rate >= 1 ? op.rate : 1; return this.warpOf(p) * r; }
    if (!p.online) return 1;
    return this.warpOf(p);
  }
  // Every tick for every player: advance the clock (full float64 precision, the same factor that scales fuel, wear,
  // wages and the catch), keep warpRun (where the clock stood when warp began), raise the due-date events once.
  advanceShipClock(p, dt) {
    if (!Number.isFinite(p.shipTime)) p.shipTime = this.simTime;
    const step = dt * SIM.CLOCK_SCALE * this.shipRate(p);
    if (this.warpOf(p) > 1) { if (!p.warpRun) p.warpRun = { shipStart: p.shipTime, worldStart: this.simTime }; }
    else if (p.warpRun) p.warpRun = null;
    if (step > 0) p.shipTime += step;
    for (const j of p.jobs || []) {
      if (!j) continue;
      if (!Number.isFinite(j.dueShip)) this.migrateAcceptedJob(p, j);
      const left = j.dueShip - p.shipTime;
      if (left < 0) { if (!j.expiredWarned) { j.expiredWarned = true; this.event(p, 'warn', `Deadline passed: ${j.title} (half pay on delivery).`); } }
      else if (left < 7200 && !j.twoHourWarned && !j.expiredWarned) { j.twoHourWarned = true; this.event(p, 'warn', `2 h of ship time left: ${j.title}.`); }
    }
  }
  // An accepted contract from before ship time: its world-clock deadline becomes a due date on the ship's clock (the time
  // left carries over; already late stays late), its budget the hours it was given; neither field → 24 h from now.
  migrateAcceptedJob(p, j) {
    if (!Number.isFinite(p.shipTime)) p.shipTime = this.simTime;
    if (Number.isFinite(j.deadline)) {
      j.dueShip = p.shipTime + (j.deadline - this.simTime);
      if (!(Number.isFinite(j.hours) && j.hours > 0)) j.hours = Math.max(1, Math.round((j.deadline - (Number.isFinite(j.acceptedAt) ? j.acceptedAt : this.simTime)) / 3600));
    } else {
      if (!(Number.isFinite(j.hours) && j.hours > 0)) j.hours = 24;
      j.dueShip = p.shipTime + j.hours * 3600;
    }
    if (!Number.isFinite(j.acceptedShip)) j.acceptedShip = p.shipTime;
    delete j.deadline;
  }
  // Supply/demand: buying takes from the harbour stock (price rises), selling adds to it (price falls).
  tradeGoods(p, good, qty, buying) {
    if (this.econ) return this.econ.trade(p, good, qty, buying);   // world economy §6.8–§6.9: reserve, fit, fallback buyer, stack src
    if (!p.docked) return;
    const h = harborById(p.docked), st = this.harbors[p.docked];
    if (!isGood(good) || GOODS[good].contraband || !(qty > 0)) return;
    qty = Math.min(5000, Math.round(qty));
    if (!st.stock || !st.target) refreshPrices(h, st);
    refreshPrices(h, st);
    if (buying) {
      const C = SHIP_CLASSES[p.ship.cls];
      const free = C.capacity - cargoMass(p.cargo);
      const fit = canLoad(good, p.ship.cls);                                   // YARD H7: the hull must handle the good
      if (!fit.ok) return this.event(p, 'warn', `${GOODS[good].name}: ${fit.why.text}.`);
      const avail = Math.floor(st.stock[good] ?? 0);
      if (avail <= 0) return this.event(p, 'warn', `${GOODS[good].name}: sold out here for now.`);
      // every tonne is priced on the stock it leaves behind (TRADE.IMPACT), so buying a harbour out and selling it
      // straight back always loses the spread instead of printing money
      qty = affordableQty(h, st, good, Math.min(qty, free, avail), p.money);
      if (qty <= 0) return this.event(p, 'warn', 'No space or no money.');
      const pc = this.politics?.onTrade(p, h, good, 'buy');
      if (pc?.block) return;                                  // the engine already sent the `law` event
      const q = tradeQuote(h, st, good, qty, 'buy');
      p.money -= q.total;
      const origin = this.politics ? this.politics.stackOrigin(p, h) : null;
      const stack = p.cargo.find((c) => c.good === good && !c.jobId && (c.origin ?? null) === origin);
      if (stack) stack.qty += qty; else p.cargo.push({ good, qty, contraband: false, jobId: null, origin });
      st.stock[good] = Math.max(0, st.stock[good] - qty);
      refreshPrices(h, st);
      const d = st.market[good] - q.unit;
      this.event(p, 'info', `Bought ${qty} t of ${GOODS[good].name} at ${fmt(q.unit)} cr/t average${d > 0 ? ` (price now ${fmt(st.market[good])})` : ''}.`);
    } else {
      const stacks = p.cargo.filter((c) => c.good === good && !c.jobId);
      const have = stacks.reduce((s, c) => s + c.qty, 0);
      qty = Math.min(qty, have);
      if (qty <= 0) return this.event(p, 'warn', 'Nothing to sell (contract cargo cannot be sold).');
      const q = tradeQuote(h, st, good, qty, 'sell');
      let left = qty, duty = 0, fees = 0;
      const lines = [], take = [];
      for (const c of stacks) {                                 // FIFO, duty per stack (contract §4.9); checked before anything is sold
        const k = Math.min(c.qty, left); if (k <= 0) break;
        if (this.politics) {
          const r = this.politics.onTrade(p, h, good, 'sell', { origin: c.origin ?? null, value: Math.round(q.total * k / qty) });
          if (r.block) return;                                  // nothing sold
          if (r.duty) { duty += r.duty.duty || 0; fees += r.duty.fee || 0; if (r.duty.duty || r.duty.fee) lines.push(`${c.origin || 'origin unknown'} ${(r.duty.rate * 100).toFixed(1)} % ${r.duty.via === 'mfn' ? 'WTO MFN' : r.duty.via}`); }
        }
        take.push([c, k]); left -= k;
      }
      for (const [c, k] of take) c.qty -= k;
      p.cargo = p.cargo.filter((c) => c.qty > 0);
      const net = q.total - duty - fees;
      p.money += net; p.stats.earned += net;
      st.stock[good] = (st.stock[good] || 0) + qty;
      refreshPrices(h, st);
      const d = q.unit - st.market[good];
      this.event(p, 'info', `Sold ${qty} t of ${GOODS[good].name} at ${fmt(q.unit)} cr/t average${d > 0 ? ` (price now ${fmt(st.market[good])})` : ''}${duty + fees ? ` — duty ${fmt(duty)} cr, fee ${fmt(fees)} cr (${lines.join('; ')})` : ''}.`);
    }
    this.sendYou(p); this.sendHarbor(p);
  }
  dumpCargo(p, good) {
    if (!isGood(good)) return;
    const before = p.cargo.length;
    p.cargo = p.cargo.filter((c) => c.good !== good);
    if (p.cargo.length !== before) {
      for (const j of [...p.jobs]) if (j.good === good && j.type !== 'fishing') { p.jobs = p.jobs.filter((x) => x !== j); }
      this.event(p, 'warn', `Dumped all ${GOODS[good]?.name || good} overboard.`);
      this.sendYou(p);
    }
  }
  buyShip(p, cls) {
    if (!p.docked) return;
    const C = SHIP_CLASSES[cls];
    if (!C || !C.price) return;
    if (cls === p.ship.cls) return this.event(p, 'warn', 'You already own this class.');
    const tradeIn = Math.round(SHIP_CLASSES[p.ship.cls].price * 0.5 * (p.cond / 100));
    const cost = C.price - tradeIn;
    if (p.money < cost) return this.event(p, 'warn', `${C.name} costs ${fmt(cost)} cr after trade-in. You have ${fmt(p.money)}.`);
    if (cargoMass(p.cargo) > C.capacity) return this.event(p, 'warn', 'Your cargo would not fit in the new ship. Sell or deliver first.');
    p.money -= cost; p.ship.cls = cls; p.cond = 100; p.flooding = 0; p.fuel = Math.min(p.fuel, C.fuelCap);
    p.serviceDue = this.simTime + SERVICE_INTERVAL_S;
    this.event(p, 'info', `Took delivery of a ${C.name}. Trade-in credited ${fmt(tradeIn)} cr.`);
    this.sendYou(p); this.sendHarbor(p);
  }

  // ------------------------------------------------------------------ at-sea actions
  patch(p) {
    if (!p.kits) return this.event(p, 'warn', 'No damage-control kit aboard.');
    p.kits--; p.cond = Math.min(100, p.cond + 15); p.flooding = Math.max(0, p.flooding - 0.3);
    this.event(p, 'info', `Crew patched the hull: condition ${Math.round(p.cond)} %, flooding ${Math.round(p.flooding * 100)} %.`);
    this.sendYou(p);
  }
  setFishing(p, on) {
    if (p.docked) return;
    if (on && !this.groundAt(p.ship.lat, p.ship.lon)) return this.event(p, 'warn', 'No fishing ground here. Check the chart for fishing banks (dashed circles).');
    if (!!p.fishing === !!on) return;
    p.fishing = on;
    if (on) { const g = this.groundAt(p.ship.lat, p.ship.lon); p.fishInfo = { ground: g.name, rate: 0, caught: 0, caughtRaw: 0, tooFast: Math.abs(p.ship.spd) >= INTERACT.FISH_MAX_KN }; }
    this.event(p, 'info', on ? `Nets out on the ${this.groundAt(p.ship.lat, p.ship.lon).name}. Trawl under ${INTERACT.FISH_MAX_KN} knots; the catch shows in the HUD.` : `Nets hauled in. ${p.fishInfo ? p.fishInfo.caught + ' t caught this haul.' : ''}`);
    this.sendYou(p);
  }
  groundAt(lat, lon) {
    for (const g of FISHING_GROUNDS) if (haversine(lat, lon, g.lat, g.lon) / 1000 <= g.radiusKm) return g;
    return null;
  }
  tow(p) {
    if (p.docked) return;
    if (p.hail) return this.event(p, 'law', 'No tug will come while the coast guard is hailing you.');
    this.dropWarp(p, 'In harbour.', false); // a teleport: back to real time (finishDock sends `you`)
    const { harbor, units } = this.nearestHarbor(p.ship.lat, p.ship.lon);
    const cost = Math.min(p.money, 3000 + Math.round(units * 2));
    const towH = Math.min(48, units / (8 * GEO.KN_TO_MS) / 3600); p.shipTime = (Number.isFinite(p.shipTime) ? p.shipTime : this.simTime) + towH * 3600; // V6 item 5: the hours under tow pass on the ship's clock
    p.money -= cost; p.hail = null; p.assist = null; this.setDocked(p, harbor.id, null);
    this.event(p, 'warn', `Towed to ${harbor.name} for ${fmt(cost)} cr (${towH.toFixed(1)} h under tow).`);
    this.finishDock(p, harbor); // an arrival like any other: contracts for this port are delivered
  }
  grounding(p) {
    this.jobsx?.onIncident(p, 'grounding');
    const now = Date.now();
    if (p.lastGrounding && now - p.lastGrounding < 4000) return;
    p.lastGrounding = now;
    p.cond = Math.max(0, p.cond - 5);
    if (p.cond < 20) p.flooding = Math.min(1, p.flooding + 0.05);
    this.event(p, 'warn', `Grounding! Hull condition ${Math.round(p.cond)} %.`);
    this.dropWarp(p, 'Aground.', false);
    this.sendYou(p);
  }

  // ------------------------------------------------------------------ law
  inspect(p, by) {
    p.stats.inspected++; p.lastInspected = this.simTime;
    const contra = p.cargo.filter((c) => c.contraband);
    if (!contra.length) { this.event(p, 'law', `${by}: papers and holds in order. Safe voyage.`); return false; }
    p.stats.caught++;
    const value = cargoValue(contra);
    const fine = LAW.FINE_FLAT + LAW.FINE_MULT * value;
    p.cargo = p.cargo.filter((c) => !c.contraband);
    p.jobs = p.jobs.filter((j) => !j.contraband);
    if (p.wanted >= LAW.IMPOUND_RESET_WANTED) {
      this.forcedReset(p, `${by} seized the vessel. Repeat offender: ship forfeited.`);
      return true;
    }
    if (p.money >= fine) {
      p.money -= fine; p.stats.fined += fine; this.bumpWanted(p, 1);
      this.event(p, 'law', `${by} found ${contra.map((c) => `${c.qty} t ${GOODS[c.good].name}`).join(', ')}. Confiscated. Fine ${fmt(fine)} cr. Wanted level ${p.wanted}.`);
    } else {
      this.impound(p, by, fine);
    }
    return true;
  }
  impound(p, by, fine) {
    const { harbor } = this.nearestHarbor(p.ship.lat, p.ship.lon);
    p.stats.fined += p.money; p.money = 0; this.bumpWanted(p, 1);
    p.hail = null; this.dropWarp(p, 'In harbour.', false); this.setDocked(p, harbor.id, null);
    this.convoyLeave(p, true);
    this.event(p, 'law', `${by}: you cannot pay the ${fmt(fine)} cr fine. Ship impounded and towed to ${harbor.name}; all credits seized. Wanted level ${p.wanted}. One more and the ship is forfeit.`);
    this.sendYou(p); this.sendHarbor(p);
  }
  forcedReset(p, why) {
    const { harbor } = this.nearestHarbor(p.ship.lat, p.ship.lon);
    p.ship.cls = 'coaster'; p.cond = 40; p.flooding = 0; p.fuel = 20; p.cargo = []; p.jobs = []; p.money = 500; p.wanted = 0; p.kits = 0;
    p.hail = null; p.towing = null; p.voyage = null; p.serviceDue = this.simTime + SERVICE_INTERVAL_S / 3; this.dropWarp(p, 'In harbour.', false); this.setDocked(p, harbor.id, null);
    this.convoyLeave(p, true);
    this.event(p, 'law', `${why} You start over at ${harbor.name} with a rust-bucket coaster and 500 cr.`);
    this.sendYou(p); this.sendHarbor(p);
  }
  bumpWanted(p, n) { p.wanted = Math.min(3, p.wanted + n); p.wantedAt = this.simTime; }

  updateCutters(dt) {
    const dts = dt * SIM.MOTION_SCALE;
    const online = [...this.byId.values()].filter((o) => o.online && !o.docked && o.flooding < 1);
    for (const c of this.cutters) {
      let target = null, kn = 18;
      if (c.state === 'patrol') {
        const wp = c.pts[c.wp];
        target = { lat: wp[0], lon: wp[1] };
        if (haversine(c.lat, c.lon, wp[0], wp[1]) < 1500) c.wp = (c.wp + 1) % c.pts.length;
        // Encounter check: players entering hail range.
        for (const p of online) {
          const u = unitsBetween(c.lat, c.lon, p.ship.lat, p.ship.lon);
          const key = c.id;
          p.inRange = p.inRange || {};
          const was = p.inRange[key];
          p.inRange[key] = u <= LAW.HAIL_RANGE_U;
          if (!was && p.inRange[key] && !p.hail && this.simTime - p.lastInspected > 1200 && Date.now() - (p.lastHailAt || 0) > 90000) {
            const chance = LAW.INSPECT_CHANCE[Math.min(3, p.wanted)] * (p.wanted ? 1 : 0.6);
            if (this.rnd() < chance) this.hail(c, p);
          }
        }
      } else {
        const p = this.byId.get(c.targetId);
        if (!p || !p.online || p.docked || !p.hail || p.flooding >= 1) { this.clearHail(c, p); continue; }
        target = { lat: p.ship.lat, lon: p.ship.lon };
        kn = c.state === 'pursue' ? LAW.PURSUIT_KN : 22;
        c.timer -= dt;
        const u = unitsBetween(c.lat, c.lon, p.ship.lat, p.ship.lon);
        if (c.state === 'hail') {
          if (c.timer <= 0) {
            if (Math.abs(p.ship.spd) <= LAW.HEAVE_TO_KN) {
              p.hail.state = 'inspecting'; c.state = 'inspect'; c.timer = 8; this.event(p, 'law', `${c.name} comes alongside. Boarding party inspecting.`);
            } else if (!p.hail.extended && num(p.ship.throttle, 1) <= 0) {
              // engine stopped or going astern: a ship takes minutes to lose way, so the cutter waits for her once
              p.hail.extended = true; c.timer = LAW.HEAVE_TO_GRACE_S; p.hail.until = Date.now() + LAW.HEAVE_TO_GRACE_S * 1000;
              this.event(p, 'law', `${c.name}: "We see you are stopping. You have ${LAW.HEAVE_TO_GRACE_S} seconds more to come below ${LAW.HEAVE_TO_KN} knots — go astern to brake."`);
            } else {
              this.bumpWanted(p, 1); p.hail.state = 'pursued'; c.state = 'pursue'; c.timer = LAW.PURSUIT_SECONDS;
              this.event(p, 'law', `You failed to heave to. ${c.name} is in pursuit at ${LAW.PURSUIT_KN} kn. Wanted level ${p.wanted}.`);
            }
            this.sendYou(p);
          }
        } else if (c.state === 'inspect') {
          if (c.timer <= 0) { this.inspect(p, c.name); this.clearHail(c, p); }
        } else if (c.state === 'pursue') {
          if (u < 150 && Math.abs(p.ship.spd) < 8) {
            this.event(p, 'law', `${c.name} has you. Forced inspection.`); this.inspect(p, c.name); this.clearHail(c, p);
          } else if (c.timer <= 0) {
            this.event(p, 'law', `${c.name} broke off the pursuit. Your name is on a list now.`); this.clearHail(c, p);
          }
        }
      }
      if (target) {
        const b = bearing(c.lat, c.lon, target.lat, target.lon);
        const d = angleDiff(c.hdg, b);
        c.hdg = normDeg(c.hdg + clamp(d, -12 * dt, 12 * dt));
        const dist = haversine(c.lat, c.lon, target.lat, target.lon);
        c.spd += (Math.min(kn, dist / 200) - c.spd) * Math.min(1, dt / 8);
        const step = c.spd * GEO.KN_TO_MS * dts;
        if (step > 1) { const n = destination(c.lat, c.lon, c.hdg, step); c.lat = n.lat; c.lon = n.lon; }
        // Set and drift: surface current plus tidal stream (the helmsman corrects for it over the next turns).
        c.driftT = (c.driftT || 0) + dts;
        if (c.driftT >= 5) {
          const cur = this.currentAtPos(c.lat, c.lon);
          c.lat = clampLat(c.lat + (cur.v * c.driftT) / GEO.M_PER_DEG_LAT);
          c.lon = wrapLon(c.lon + (cur.u * c.driftT) / (GEO.M_PER_DEG_LON_EQ * (Math.cos(c.lat * Math.PI / 180) || 1e-6)));
          c.driftT = 0;
        }
      }
    }
  }
  hail(c, p) {
    p.lastHailAt = Date.now();
    p.hail = { cutter: c.name, cutterId: c.id, until: Date.now() + LAW.HAIL_SECONDS * 1000, state: 'hailed' };
    c.state = 'hail'; c.targetId = p.id; c.timer = LAW.HAIL_SECONDS;
    this.dropWarp(p, `${c.name} is hailing you.`, false);
    this.event(p, 'law', `${c.name} on channel 16: "Vessel ${p.name}, this is the coast guard. Heave to for inspection. You have ${LAW.HAIL_SECONDS} seconds."`);
    this.sendYou(p);
  }
  clearHail(c, p) {
    c.state = 'patrol'; c.targetId = null; c.timer = 0;
    if (p && p.hail && p.hail.cutterId === c.id) { p.hail = null; this.sendYou(p); }
  }

  // ------------------------------------------------------------------ survival tick
  tick(dt) {
    this.simTime = Date.now() / 1000;
    const simHours = (dt * SIM.CLOCK_SCALE) / 3600;
    this.updateWind(dt);
    this.updateStorms(dt);
    this.updateRescues(dt);
    tickTugs(this, dt); // tugs sailing home after an assist
    this.requestWeather();
    for (const p of this.byId.values()) {
      // Time warp: drop back to real time the moment a condition stops holding (before anything else, so a docked,
      // assisted or rescued player is caught too).
      if (p.warp !== 1) this.checkWarp(p);
      this.advanceShipClock(p, dt); // V6 item 5: every player's ship clock (docked, offline and rescued too), and the due-date events
      if (p.jobs?.length) this.jobsx.onTick(p, dt * SIM.CLOCK_SCALE * this.shipRate(p));   // YARD H6: runner steps on the ship's clock
      if (p.rescue) continue;
      if (p.docked) continue;
      if (p.assist) { this.stepAssist(p, dt); continue; }
      if (!p.online) { if (p.voyage) this.simulateOffline(p, dt); else continue; }
      if (p.flooding >= 1) { this.sink(p); continue; }
      this.stepAtSea(p, simHours);                  // v6: the at-sea block, shared with the captains (server/captain.js)
      if (p.wanted > 0 && this.simTime - p.wantedAt > LAW.WANTED_DECAY_SIM_HOURS * 3600) { p.wanted--; p.wantedAt = this.simTime; this.event(p, 'law', `Wanted level dropped to ${p.wanted}.`); }
    }
    if (this.ww) { try { this.tickWaterworks(dt); } catch (e) { this.log(`[ww] tick failed: ${e.stack || e}`); } }   // BRIDGES & LOCKS
    this.fleet.tick(dt);                              // v6: drift booking, owed bills, captains, storage, `fleet` pushes
    this.yard.tick(this.simTime);                     // SHIPYARD: instalments, milestones, delays, delivery (runs once per sim second)
    this.radio?.tick(dt);                             // VHF: operator replies due, `vhf_st` pushes to open sets
    if (this.mh && (this._mhAt = (this._mhAt || 0) + dt) >= 10) {              // inland harbours: squares around online ships every 10 s
      this._mhAt = 0;
      for (const p of this.byId.values()) if (p.online && p.ship) this.mh.ensureNear(p.ship.lat, p.ship.lon, 25).catch(() => {});
    }
    this.updateCutters(dt);
    // Job boards regen lazily on dock; markets drift every minute; wrecks expire.
    if (Date.now() - this.lastEcon > 60000) this.driftMarkets();
    const before = this.wrecks.length;
    this.wrecks = this.wrecks.filter((w) => this.simTime - w.simTime < 48 * 3600 && w.cargo.length);
    if (this.wrecks.length !== before) this.broadcast({ t: 'wrecks', wrecks: this.wrecks });
    for (const [id, o] of this.offers) if (Date.now() > o.expires) { this.offers.delete(id); const a = this.byId.get(o.from); if (a) this.event(a, 'info', 'Your trade offer expired.'); }
    if (Date.now() - this.lastSave > 30000) this.saveState();
  }
  // v6 (docs/V6-FLEET-CONTRACTS.md §11.2): one player's (or captain's) ship at sea for `simHours` of world time: crew wages
  // (not for captains: the fleet pays them in whole credits), fuel, wear, flooding and pumps, the catch, the tow hand-over.
  stepAtSea(p, simHours) {
    const s = p.ship, C = SHIP_CLASSES[s.cls];
    const load = cargoMass(p.cargo) / C.capacity;
    const underway = Math.abs(s.throttle) > 0.03 || Math.abs(s.spd) > 0.5;
    const wx = this.weatherAt(s.lat, s.lon);
    // The ship's own clock: warp multiplies everything that happens aboard per hour (the world clock stays real time).
    const hrs = simHours * this.warpOf(p);
    const hold = this.politics?.vesselOf(p)?.held;
    if (hold && hold.until > this.simTime) { s.throttle = 0; s.spd = 0; if (this.warpOf(p) > 1) this.dropWarp?.(p, 'Held.', false); }
    if (!(p.serviceDue > 0)) p.serviceDue = this.simTime + SERVICE_INTERVAL_S;
    if (underway && C.crewCost && !p.isActor) p.money = Math.max(0, p.money - C.crewCost * hrs * (p.towing ? 1.2 : 1));
    let burnT = 0;
    if (p.fuel > 0 && Math.abs(s.throttle) > 0.01) {
      const burn = fuelBurnPerSimHour(s.cls, s.throttle, load, headwindFactor(s.hdg, wx.wind), p.cond) * hrs * (p.towing ? 1.3 : 1);
      burnT = burn;
      p.fuel = Math.max(0, p.fuel - burn);
      if (p.fuel === 0) this.event(p, 'warn', 'Fuel exhausted. Engine stopped. You are drifting — call a tow or wait for a kind soul.');
      else if (p.fuel < C.fuelCap * 0.1 && !p.lowFuelWarned) { p.lowFuelWarned = true; this.event(p, 'warn', 'Low fuel: under 10 % remaining.'); }
      if (p.fuel > C.fuelCap * 0.2) p.lowFuelWarned = false;
    }
    if (this.politics) this.politics.stepSea(p, hrs, burnT, { underway });   // cover, IBF wages, incidents, ECA, piracy (captains too: their IBF bonus is booked here)
    if (underway && p.cond > 0) {
      // Overdue maintenance ramps the wear multiplier (+2 %/day past serviceDue, up to +60 %).
      const svc = serviceWearMul(p.serviceDue, this.simTime);
      // Wear alone never sinks a ship the crew sails for you (autopilot, offline voyage, captains, tugs): it stops at 1 %.
      // Only a skipper sailing by hand can wear the hull to 0 % (then the ship floods and sinks).
      const autoSail = !!(p.voyage || p.assist || p.isActor || !p.online);
      p.cond = Math.max(autoSail ? Math.min(1, p.cond) : 0, p.cond - wearPerSimHour(s.throttle, wx.wind.spd, C.wearMul) * svc * hrs);
      if (svc > 1 && !p.serviceWarned) { p.serviceWarned = true; this.event(p, 'warn', 'Service overdue: the engineer reports rising wear. Book a service at the next yard (1 % of the hull price).'); }
      if (svc <= 1) p.serviceWarned = false;
      if (p.cond < 30 && !p.condWarned) { p.condWarned = true; this.event(p, 'warn', 'Hull condition under 30 %: steering is getting sluggish, leaks likely. Find a yard.'); }
      if (p.cond > 50) p.condWarned = false;
    }
    if (p.cond <= 0) {
      p.flooding = Math.min(1, p.flooding + (1.2 + 2 * wx.sea) * hrs);
      if (!p.floodWarned) { p.floodWarned = true; this.event(p, 'warn', 'Hull failed: taking on water! Use a damage-control kit (K) or make for the nearest harbour.'); }
    } else if (p.flooding > 0 && p.cond > 30) {
      p.flooding = Math.max(0, p.flooding - 0.3 * hrs); // pumps keep up on a sound hull
    }
    if (p.flooding < 0.2) p.floodWarned = false;
    if (p.fishing) {
      const g = this.groundAt(s.lat, s.lon);
      if (!g) { p.fishing = false; this.event(p, 'info', 'Left the fishing ground; nets hauled in.'); this.sendYou(p); }
      else if (Math.abs(s.spd) < INTERACT.FISH_MAX_KN) {
        const free = C.capacity - cargoMass(p.cargo);
        const rate = catchRate(s.cls, g.richness) * (wx.storm > 0.5 ? 0.4 : 1);
        const add = Math.max(0, Math.min(free, rate * hrs));
        // keep full precision: at 10 ticks a second each step is a few grams, rounding it every tick lost all of it
        const caught = ((p.fishInfo && p.fishInfo.caughtRaw) || 0) + add;
        p.fishInfo = { ground: g.name, rate: Math.round(rate * 10) / 10, caught: Math.round(caught * 10) / 10, caughtRaw: caught, tooFast: false };
        if (add > 0) {
          const stack = p.cargo.find((c) => c.good === 'fish' && c.caught && !c.jobId);
          if (stack) stack.qty += add; else p.cargo.push({ good: 'fish', qty: add, contraband: false, jobId: null, caught: true, origin: this.politics ? this.politics.stackOrigin(p, null, { caught: true }) : null });
          p.fullWarned = false;
        } else if (free <= 0 && !p.fullWarned) { p.fullWarned = true; this.event(p, 'info', 'Hold is full of fish.'); this.sendYou(p); }
        if (Date.now() - (p.fishSentAt || 0) > 2000) { p.fishSentAt = Date.now(); this.sendYou(p); } // the catch counter follows live
      } else {
        p.fishInfo = { ground: g.name, rate: 0, caught: (p.fishInfo && p.fishInfo.caught) || 0, caughtRaw: (p.fishInfo && p.fishInfo.caughtRaw) || 0, tooFast: true };
      }
    }
    if (p.towing) this.checkTowHandover(p);
    for (const j of p.jobs) if (j.type === 'tow' && !j.spotOk && !j.pickedUp) this.ensureTowSpot(j);
  }
  // Keep the weather cache warm for every ship at sea or online (every 30 s, urgent) and, every 5 min, for the harbours
  // within 400 km of an online player (v7 world coverage: wherever people sail, not a fixed North Sea grid).
  // WeatherService dedups, rate-limits and backs off by itself; the calls here are cheap.
  requestWeather() {
    if (!this.weather) return;
    const now = Date.now();
    if (now - this.lastWxRequest < 30000) return;
    const harbourSweep = now - (this.lastWxHarbors || 0) > 300000;
    this.lastWxRequest = now;
    try {
      const ships = [], online = [];
      for (const p of this.byId.values()) {
        if (p.online || (p.voyage && !p.docked)) ships.push(p.ship);
        if (p.online) online.push(p.ship);
      }
      for (const s of this.fleet.weatherPoints(50)) ships.push(s);   // v6: captained ships at sea, round robin
      if (harbourSweep && typeof this.weather.requestAround === 'function') {
        this.lastWxHarbors = now;
        for (const s of ships) this.weather.request(s.lat, s.lon, true);
        this.weather.requestAround(online, HARBORS.map((h) => this.harborAnchor(h)));
      } else for (const s of ships) this.weather.request(s.lat, s.lon, true);
      if (this.realStorms) this.realStorms.tick(ships);
    } catch (e) { this.log(`[game] weather.request failed: ${e.message}`); }
  }
  updateWind(dt) {
    // Slow random walk in direction and speed. Only the fallback when no real data covers a position.
    this.wind.dir = normDeg((this.wind.dir || 240) + (this.rnd() - 0.5) * 2 * dt);
    this.wind.spd = clamp((this.wind.spd || 7) + (this.rnd() - 0.5) * 0.3 * dt, 1, 24);
    const r = (this.wind.dir + 180) * Math.PI / 180; // dir = where the wind comes FROM
    this.wind.u = Math.sin(r) * this.wind.spd; this.wind.v = Math.cos(r) * this.wind.spd;
  }
  sink(p, reason = null, text = null) {
    if (p.isActor) return this.fleet.sinkVessel(p.vessel);   // world politics: a captained ship lost to a war incident (crew evacuated)
    const s = p.ship;
    this.dropWarp(p, 'Abandon ship.', false);
    p.stats.sunk++;
    if (p.cargo.length) {
      this.wrecks.push({ id: 'w' + shortId(), lat: s.lat, lon: s.lon, cargo: p.cargo, owner: p.name, cls: s.cls, simTime: this.simTime, time: Date.now() });
      this.broadcast({ t: 'wrecks', wrecks: this.wrecks });
    }
    this.broadcast({ t: 'chat', from: 'Shipping news', id: 'sys', text: `${p.name}'s ${SHIP_CLASSES[s.cls].name} went down at ${s.lat.toFixed(2)}, ${s.lon.toFixed(2)}.`, time: Date.now() });
    const lostJobs = p.jobs.length;
    p.cargo = []; p.jobs = []; p.fishing = false; p.hail = null; p.towing = null; p.voyage = null; this.convoyLeave(p, true);
    s.spd = 0; s.throttle = 0; s.rudder = 0;
    this.event(p, 'warn', reason === 'war_loss' && text ? text : `Your ship sank${lostJobs ? ` with ${lostJobs} contract(s)` : ''}. You are in the life raft.`);
    this.startRescue(p);
    this.sendYou(p);
  }

  // ------------------------------------------------------------------ multiplayer interactions
  near(p, q, range) {
    if (p.docked && q.docked) return p.docked === q.docked;
    if (p.docked || q.docked) return false;
    return unitsBetween(p.ship.lat, p.ship.lon, q.ship.lat, q.ship.lon) <= range;
  }
  board(p, targetId) {
    const q = this.byId.get(targetId);
    if (!q || !q.online || q.id === p.id) return;
    if (p.docked || q.docked) return this.event(p, 'warn', 'Not at sea.');
    if (!this.near(p, q, INTERACT.BOARD_RANGE_U)) return this.event(p, 'warn', `Get within ${INTERACT.BOARD_RANGE_U} m to board.`);
    if (Math.abs(q.ship.spd) > 6) return this.event(p, 'warn', 'Target too fast to board (needs < 6 kn).');
    if (Math.abs(p.ship.spd - q.ship.spd) > 4) return this.event(p, 'warn', 'Match speeds first (closing speed < 4 kn).');
    if (Date.now() - (p.lastBoard || 0) < 20000) return this.event(p, 'warn', 'Your crew is still regrouping.');
    p.lastBoard = Date.now();
    let chance = 0.55;
    const escorted = q.convoyId && [...this.byId.values()].some((o) => o.id !== q.id && o.online && o.convoyId === q.convoyId && !o.docked && unitsBetween(o.ship.lat, o.ship.lon, q.ship.lat, q.ship.lon) <= INTERACT.CONVOY_ESCORT_U);
    if (escorted) chance -= 0.25;
    chance += 0.1 * (SHIP_CLASSES[p.ship.cls].displacement > SHIP_CLASSES[q.ship.cls].displacement ? 1 : -1);
    this.bumpWanted(p, 2);
    if (this.rnd() < chance && q.cargo.length) {
      const taken = [];
      const free = SHIP_CLASSES[p.ship.cls].capacity - cargoMass(p.cargo);
      let room = free;
      for (const c of q.cargo) {
        const k = Math.min(room, Math.floor(c.qty / 2));
        if (k <= 0) continue;
        c.qty -= k; room -= k;
        const stack = p.cargo.find((x) => x.good === c.good && !x.jobId && x.contraband === c.contraband);
        if (stack) stack.qty += k; else p.cargo.push({ good: c.good, qty: k, contraband: c.contraband, jobId: null });
        taken.push(`${k} t ${GOODS[c.good].name}`);
      }
      q.cargo = q.cargo.filter((c) => c.qty > 0);
      p.stats.pirated++; q.stats.boarded++;
      this.event(p, 'pirate', `Boarding succeeded. Took ${taken.join(', ') || 'nothing of value'}. You are now wanted (level ${p.wanted}).`);
      this.event(q, 'pirate', `${p.name} boarded you and took ${taken.join(', ') || 'nothing'}!${escorted ? '' : ' Travelling in a convoy would have halved their odds.'}`);
      this.broadcast({ t: 'chat', from: 'Shipping news', id: 'sys', text: `Piracy: ${p.name} boarded ${q.name}.`, time: Date.now() });
    } else {
      p.cond = Math.max(0, p.cond - 10);
      this.event(p, 'pirate', `Boarding repelled${escorted ? ' by the convoy escort' : ''}. Hull damaged (−10 %). You are wanted (level ${p.wanted}).`);
      this.event(q, 'pirate', `${p.name} tried to board you and was beaten off.`);
    }
    this.sendYou(p); this.sendYou(q);
  }
  salvage(p, wreckId) {
    const w = this.wrecks.find((x) => x.id === wreckId);
    if (!w) return this.event(p, 'warn', 'Nothing left to salvage there.');
    if (p.docked) return;
    if (unitsBetween(p.ship.lat, p.ship.lon, w.lat, w.lon) > INTERACT.SALVAGE_RANGE_U) return this.event(p, 'warn', 'Get closer to the wreck.');
    if (Math.abs(p.ship.spd) > 3) return this.event(p, 'warn', 'Slow down below 3 kn to work the wreck.');
    let room = SHIP_CLASSES[p.ship.cls].capacity - cargoMass(p.cargo);
    const got = [];
    for (const c of w.cargo) {
      const k = Math.min(room, c.qty); if (k <= 0) continue;
      c.qty -= k; room -= k;
      const stack = p.cargo.find((x) => x.good === c.good && !x.jobId && x.contraband === c.contraband);
      if (stack) stack.qty += k; else p.cargo.push({ good: c.good, qty: k, contraband: c.contraband, jobId: null });
      got.push(`${k} t ${GOODS[c.good].name}`);
    }
    w.cargo = w.cargo.filter((c) => c.qty > 0);
    if (!w.cargo.length) this.wrecks = this.wrecks.filter((x) => x !== w);
    this.broadcast({ t: 'wrecks', wrecks: this.wrecks });
    this.event(p, 'info', got.length ? `Salvaged ${got.join(', ')} from ${w.owner}'s wreck.` : 'No room in the hold.');
    this.sendYou(p);
  }
  tradeOffer(p, m) {
    const q = this.byId.get(m.toId);
    if (!q || !q.online || q.id === p.id) return this.event(p, 'warn', 'No such player online.');
    if (!this.near(p, q, INTERACT.TRADE_RANGE_U)) return this.event(p, 'warn', 'Trade partner must be alongside (150 m) or docked in the same harbour.');
    const good = m.good, qty = Math.round(+m.qty), price = Math.round(+m.price);
    if (!isGood(good) || !(qty > 0) || !(price >= 0) || price > 1e9) return;
    const have = p.cargo.filter((c) => c.good === good && !c.jobId).reduce((s, c) => s + c.qty, 0);
    if (have < qty) return this.event(p, 'warn', 'You do not have that much free (non-contract) cargo.');
    const id = 'o' + shortId();
    const offer = { id, from: p.id, to: q.id, good, qty, price, expires: Date.now() + 60000 };
    this.offers.set(id, offer);
    this.send(q, { t: 'trade', offer: { ...offer, fromName: p.name, goodName: GOODS[good].name, contraband: GOODS[good].contraband } });
    this.event(p, 'info', `Offered ${qty} t ${GOODS[good].name} to ${q.name} for ${fmt(price)} cr.`);
  }
  tradeAccept(p, offerId) {
    const o = this.offers.get(offerId);
    if (!o || o.to !== p.id) return;
    const seller = this.byId.get(o.from);
    this.offers.delete(offerId);
    if (!seller || !seller.online || !this.near(seller, p, INTERACT.TRADE_RANGE_U)) return this.event(p, 'warn', 'Seller is out of range.');
    if (p.money < o.price) return this.event(p, 'warn', 'You cannot afford it.');
    const room = SHIP_CLASSES[p.ship.cls].capacity - cargoMass(p.cargo);
    if (room < o.qty) return this.event(p, 'warn', 'No room in the hold.');
    const sellerStacks = seller.cargo.filter((x) => x.good === o.good && !x.jobId);
    if (sellerStacks.reduce((s, c) => s + c.qty, 0) < o.qty) return this.event(p, 'warn', 'Seller no longer has the goods.');
    let left = o.qty;
    for (const c of sellerStacks) { const k = Math.min(c.qty, left); c.qty -= k; left -= k; }
    seller.cargo = seller.cargo.filter((c) => c.qty > 0);
    const stack = p.cargo.find((x) => x.good === o.good && !x.jobId);
    if (stack) stack.qty += o.qty; else p.cargo.push({ good: o.good, qty: o.qty, contraband: GOODS[o.good].contraband, jobId: null });
    p.money -= o.price; seller.money += o.price; seller.stats.earned += o.price;
    this.event(p, 'info', `Bought ${o.qty} t ${GOODS[o.good].name} from ${seller.name} for ${fmt(o.price)} cr.`);
    this.event(seller, 'info', `${p.name} accepted: +${fmt(o.price)} cr.`);
    this.sendYou(p); this.sendYou(seller);
  }
  tradeDecline(p, offerId) {
    const o = this.offers.get(offerId); if (!o || o.to !== p.id) return;
    this.offers.delete(offerId);
    const s = this.byId.get(o.from); if (s) this.event(s, 'info', `${p.name} declined your offer.`);
  }
  cancelOffersOf(p) { for (const [id, o] of this.offers) if (o.from === p.id || o.to === p.id) this.offers.delete(id); }
  convoyInvite(p, targetId) {
    const q = this.byId.get(targetId);
    if (!q || !q.online || q.id === p.id) return;
    if (!this.near(p, q, INTERACT.CONVOY_ESCORT_U * 2)) return this.event(p, 'warn', 'Too far away to form up.');
    if (!p.convoyId) { const id = 'c' + shortId(); this.convoys.set(id, { id, members: [p.id], leader: p.id }); p.convoyId = id; }
    this.invites.set(q.id + ':' + p.convoyId, Date.now() + 120000);
    this.send(q, { t: 'convoy_invite', convoyId: p.convoyId, from: p.name, fromId: p.id });
    this.event(p, 'info', `Invited ${q.name} to your convoy.`);
    this.sendYou(p);
  }
  convoyAccept(p, convoyId) {
    const c = this.convoys.get(convoyId); if (!c) return this.event(p, 'warn', 'That convoy no longer exists.');
    const inv = this.invites.get(p.id + ':' + convoyId);
    if (!inv || inv < Date.now()) return this.event(p, 'warn', 'No open invitation to that convoy.');
    this.invites.delete(p.id + ':' + convoyId);
    if (p.convoyId === convoyId) return;
    if (p.convoyId) this.convoyLeave(p, true);
    c.members.push(p.id); p.convoyId = c.id;
    for (const id of c.members) { const o = this.byId.get(id); if (o) { this.event(o, 'info', `${p.name} joined the convoy (${c.members.length} ships).`); this.sendYou(o); } }
    this.broadcast({ t: 'convoy', convoy: c });
  }
  convoyLeave(p, silent) {
    const c = p.convoyId && this.convoys.get(p.convoyId);
    p.convoyId = null;
    if (!c) return;
    c.members = c.members.filter((id) => id !== p.id);
    if (!c.members.length) this.convoys.delete(c.id);
    else { if (c.leader === p.id) c.leader = c.members[0]; for (const id of c.members) { const o = this.byId.get(id); if (o) { this.event(o, 'info', `${p.name} left the convoy.`); this.sendYou(o); } } }
    if (!silent) this.event(p, 'info', 'You left the convoy.');
    this.sendYou(p);
  }

  // ------------------------------------------------------------------ v0.4: time warp (docs/V4-CONTRACTS.md §1)
  // The world clock stays real time for everyone. Warp speeds up one ship: the client integrates dt × factor, the server
  // multiplies the movement budget and everything consumed aboard (fuel, wear, wages, catch, flooding) by the factor.
  warpOf(p) { return WARP.LEVELS.includes(p.warp) ? p.warp : 1; }
  // Movement budget factor: the current level, or the level just dropped from while states sent before the drop arrive.
  warpBudgetFactor(p, now = Date.now()) { return Math.max(this.warpOf(p), p.warpGraceUntil > now && WARP.LEVELS.includes(p.warpGraceFactor) ? p.warpGraceFactor : 1); }
  // `action: set_warp {factor, route}`. 1× is always accepted; higher levels only while every condition holds.
  // ------------------------------------------------------------------ BRIDGES & LOCKS (docs/WATERWAYS-LANE1-PHASE2.md §3)
  airDraftNow(p) { try { return p?.ship ? airDraftNow(p.ship.cls, { cargo: p.cargo || [], fuelT: p.fuel, ballastT: p.ship.ballastT || 0, fold: p.ship.fold || {} }) : null; } catch { return null; } }
  waterAt(lat, lon) { return this.levels ? waterLevelAt(lat, lon, this.simTime, { levels: this.levels }) : null; }
  ballastCmd(p, m) {
    const prof = profileOf(p.ship.cls);
    if (!(prof.ballastMax > 0)) return this.event(p, 'warn', 'This ship has no ballast tanks.');
    if (m.op === 'stop') p.ship.ballastTarget = p.ship.ballastT || 0;
    else p.ship.ballastTarget = m.op === 'fill' ? (Number.isFinite(+m.target) && m.target !== null && m.target !== '' ? clamp(+m.target, 0, prof.ballastMax) : prof.ballastMax) : (Number.isFinite(+m.target) && m.target !== null && m.target !== '' ? clamp(+m.target, 0, prof.ballastMax) : 0);
    this.sendYou(p);
  }
  foldCmd(p, m) {
    const part = String(m.part || '');
    if (!FOLD_TIME[part]) return this.event(p, 'warn', 'Nothing to fold there.');
    const r = canFold(p.ship.cls, part, !!m.down, { cargo: p.cargo, sogKn: Math.abs(p.ship.spd || 0) });
    if (!r.ok) return this.event(p, 'warn', r.why);
    p.ship.foldOp = { part, down: !!m.down, until: this.simTime + (FOLD_TIME[part] || 60) };
    this.event(p, 'info', `${part[0].toUpperCase()}${part.slice(1)} ${m.down ? 'lowering' : 'raising'} — ${Math.round(FOLD_TIME[part] / 60)} min.`);
    this.sendYou(p);
  }
  wwButton(p, m) {
    const r = this.ww?.request(String(m.id || ''), p, 60, { button: true });
    if (!r) return;
    if (!r.ok) return this.event(p, 'warn', r.reason === 'range' ? 'Too far from the push button (300 m).' : r.reason === 'hours' ? `No service until ${r.next}.` : r.reason === 'never' ? 'You will not fit through, even open.' : 'The bridge does not answer.');
    this.event(p, 'info', r.verdict === 'opening' ? `Opening requested — you are number ${r.n}.` : 'You fit under — no opening needed.');
  }
  lockRegister(p, m) {
    const r = this.ww?.registerLock(String(m.id || ''), p, m.side === 1 ? 1 : 0);
    if (r && r.ok) this.event(p, 'info', `Registered for chamber ${r.chamber}: number ${r.n}${r.fee ? `, lock fee ${r.fee} credits` : ''}.`);
    else if (r) this.event(p, 'warn', r.reason === 'fit' ? `Your ship does not fit this lock (${r.why}).` : r.reason === 'hours' ? `The lock is closed until ${r.next}.` : 'The lock does not answer.');
  }
  stepBallastFold(p, dt) {
    const s = p.ship, warp = this.shipRate ? this.shipRate(p) : 1;
    if (Number.isFinite(s.ballastTarget) && s.ballastTarget !== s.ballastT)
      s.ballastT = ballastStep(s.cls, s.ballastT || 0, s.ballastTarget, dt * warp, { cargoT: cargoMass(p.cargo), fuelT: p.fuel });
    if (s.foldOp && this.simTime >= s.foldOp.until) { s.fold = { ...(s.fold || {}), [s.foldOp.part]: s.foldOp.down ? 1 : 0 }; s.foldOp = null; this.sendYou(p); }
  }
  onStrike(p, s) {
    if (s.part === 'pier') return this.collision(p, { kind: 'bridge_pier', id: s.id, speedKn: Math.abs(p.ship.spd || 0) });
    const d = s.damage || {};
    if (d.dismast) this.rigEvent?.(p, { kind: 'dismast' });
    if (d.antennaMul < 1) { p.radioDamage = d.antennaMul; p.antennaDmg = true; }
    if (d.condLoss) p.cond = Math.max(0, p.cond - 100 * d.condLoss);
    if (d.teuLost && d.after?.cargo) { p.cargo = d.after.cargo; p.money -= d.pollutionFine || 0; }
    if (d.stop) { p.ship.spd = 0; p.ship.throttle = 0; }
    p.money -= s.fee || 0;
    this.send(p, { t: 'strike', id: s.id, part: s.part, overlap: s.overlap, damage: d, fee: s.fee });
    this.event(p, 'warn', `Bridge strike (${s.part}, ${Number(s.overlap || 0).toFixed(2)} m): damage bill ${s.fee} credits.`, { lawHook: 'bridge_strike' });
    this.dropWarp(p, 'Bridge strike.', false);
    this.sendYou(p);
  }
  /** Per tick: lock stays, ballast / fold, strikes (only near a bridge), and every second the `ww` deltas within 15 km. */
  tickWaterworks(dt) {
    const pts = []; for (const p of this.byId.values()) if (p.online && p.ship) pts.push([p.ship.lat, p.ship.lon]);
    this.ww.tick(pts);                                   // only objects near online ships (or with something going on)
    const push = Date.now() - (this.wwPushAt || 0) >= 1000;
    if (push) this.wwPushAt = Date.now();
    for (const p of this.byId.values()) {
      if (!p.online || !p.ship || p.isActor) continue;
      if (push) this.pushWw(p);
      if (p.docked || p.rescue) continue;
      this.stepBallastFold(p, dt);
      const stay = this.ww.lockStay(p.id);
      if (!!stay !== !!p.lockStay) { p.lockStay = stay; this.sendYou(p); } else p.lockStay = stay;
      if (stay) { p.ship.spd = Math.min(p.ship.spd, 1); continue; }   // held at the slot like docked; y = stay.y on the client
      if (!this.ww.near(p.ship.lat, p.ship.lon, 600).some((o) => o.type === 'bridge')) continue;
      const st = this.ww.strikeCheck({ ...p, Hs: this.weatherFor(p).waveH || 0 });
      if (st) this.onStrike(p, st);
    }
  }
  pushWw(p) {
    let seen = this.wwRev.get(p); if (!seen) { seen = new Map(); this.wwRev.set(p, seen); }
    const ids = new Set();
    for (const o of this.ww.near(p.ship.lat, p.ship.lon, 15000)) {
      ids.add(o.id);
      const st = this.ww.state(o.id); if (!st) continue;
      if (seen.get(o.id) === st.rev) continue;
      seen.set(o.id, st.rev);
      if (st.rev > 0 || o.type === 'lock') this.send(p, { t: 'ww', ...st });
    }
    for (const id of seen.keys()) if (!ids.has(id)) seen.delete(id);
  }
  wwWarpCap(p) {
    if (!this.ww || p.docked) return null;
    if (p.lockStay) return { max: 1, reason: 'Inside a lock chamber.' };
    const near = this.ww.verdicts(p, p.ship.lat, p.ship.lon, 2000);
    if (near.some((v) => v.verdict === 'opening' || v.verdict === 'tight' || v.verdict === 'never' || v.verdict === 'closed')) return { max: 5, reason: 'Bridge or lock within 2 km — 5× at most.' };
    return null;
  }
  /** Inland harbour board (§2.6): made when its card is first opened, then every 24 h. Shown on the card (accepting needs the jobs engine). */
  mhBoard(h) {
    const b = this.mhBoards.get(h.id);
    if (b && b.at > this.simTime - 86400) return b.jobs;
    const ports = [...INLAND_TERMINALS, ...this.mh.near(h.lat, h.lon, 400).filter((x) => x.tier !== 'ferry')];
    const jobs = mhBoardFor(h, { rnd: Math.random, simTime: this.simTime, ports, graph: this.inlandGraph, lane: this.mh.lane() });
    if (this.mhBoards.size > 200) this.mhBoards.delete(this.mhBoards.keys().next().value);   // small: boards of recently opened cards only
    this.mhBoards.set(h.id, { at: this.simTime, jobs });
    return jobs;
  }
  setWarp(p, m) {
    const f = Number(m && m.factor);
    if (!WARP.LEVELS.includes(f)) return this.event(p, 'warn', `Time warp levels are ${WARP.LEVELS.map((l) => `${l}×`).join(', ')}.`);
    const was = this.warpOf(p);
    if (f === 1) {
      if (was > 1) { this.endWarp(p, was); this.event(p, 'info', 'Time warp off — back to real time.'); }
      this.sendYou(p);
      return;
    }
    // A route supplied now, or (stepping down) the one the higher level was engaged with.
    const routed = validWarpRoute(m.route) || (f <= was && !!p.warpRouted);
    const why = this.warpBlock(p, f, routed);
    if (why) { this.event(p, 'warn', `Time warp ${f}× refused: ${why}`); this.sendYou(p); return; }
    if (f < was) this.startGrace(p, was);
    p.warp = f; p.warpRouted = routed;
    const zone = this.harbourZone(p); // V6 item 6: up to HARBOR_MAX inside a harbour zone
    if (zone) this.event(p, 'info', `Time warp ${f}× in ${zone.harbor.name}: your ship's clock runs ${f} times faster — fuel, wear, wages and contract hours too. The tide and everything ashore stay in real time.`);
    else this.event(p, 'info', `Time warp ${f}×: your ship's clock runs ${f} times faster — fuel, wear, wages and catch too. It steps down to ${WARP.HARBOR_MAX}× in harbours and drops back to real time near land, other skippers, storms and the coast guard.`);
    this.sendYou(p);
  }
  // Why the ship cannot (keep) warp(ing) at factor f right now, or null. Order = what the skipper should fix first.
  warpBlock(p, f, routed) {
    const why = this.warpConditions(p);
    if (why) return why;
    const zone = this.harbourZone(p);
    if (zone && f > WARP.HARBOR_MAX) return `${this.zoneWhere(zone)} — inside harbours time warp is limited to ${WARP.HARBOR_MAX}×.`;
    { const c = this.wwWarpCap(p); if (c && f > c.max) return c.reason.replace(/^./, (x) => x.toLowerCase()); }   // BRIDGES & LOCKS
    if (f > WARP.MAX_NO_ROUTE && !routed) return `above ${WARP.MAX_NO_ROUTE}× the crew needs a route to follow — plot one on the chart and sail it.`;
    if (f > WARP.LAND_CHECK_ABOVE) {
      const sh = this.shallowAhead(p, this.warpLookahead(p, f));
      if (sh) return this.landAheadReason(sh);
    }
    return null;
  }
  // The factor-independent conditions (contract list): ship state, other players, weather. Inside a harbour zone
  // (docs/V6-QUICK-CONTRACTS.md §2.2) a moored or assisted ship is only stopped by the first three; under way the other
  // skippers count within HARBOR_PLAYER_M instead of PLAYER_RADIUS_M. The 5× cap itself is in warpBlock / checkWarp.
  warpConditions(p) {
    if (!p.online) return 'you are offline.';
    if (p.hail) return 'the coast guard is hailing you.';
    if (p.rescue || p.flooding >= 1) return 'you are in the life raft.';
    if (p.docked || p.assist) return null; // moored or under tugs: fuel, flooding, storm and other skippers do not matter
    if (p.lockStay) return 'you are in a lock chamber.';                  // BRIDGES & LOCKS
    const s = p.ship, C = SHIP_CLASSES[s.cls] || SHIP_CLASSES.coaster;
    // Out of fuel = no propulsion; a sailing yacht with her sails set is still driven by the wind.
    if (!(p.fuel > 0) && !(C.sail && p.sailsUp !== false && (!rigOf(s.cls) || anyHoisted(this.rigFor(p))))) return 'out of fuel.';
    if (p.flooding > WARP.MAX_FLOODING) return `taking water (${Math.round(p.flooding * 100)} %) — patch the hull or let the pumps catch up first.`;
    if (this.harbourZone(p)) {
      const near = this.nearestOtherSkipper(p, WARP.HARBOR_PLAYER_M);
      if (near) return `${near.player.name} is ${dist1(near.distM)} away — in harbour, warp needs ${km1(WARP.HARBOR_PLAYER_M)} km between you and other skippers under way.`;
    } else {
      const other = this.nearestOtherSkipper(p, WARP.PLAYER_RADIUS_M);
      if (other) return `${other.player.name} is ${dist1(other.distM)} away — warp needs ${km1(WARP.PLAYER_RADIUS_M)} km of sea to yourself.`;
    }
    const wx = this.weatherAt(s.lat, s.lon);
    if (wx.storm > WARP.MAX_STORM) return `heavy weather here (wind ${Math.round(wx.wind.spd)} m/s) — no warp in a storm.`;
    return null;
  }
  // The closest other online player at sea (docked ships and life rafts do not count) within rangeM.
  nearestOtherSkipper(p, rangeM) {
    const s = p.ship, dLat = rangeM / GEO.M_PER_DEG_LAT;
    let best = null, bd = rangeM;
    for (const o of this.byId.values()) {
      if (o === p || !o.online || o.docked || o.rescue || o.flooding >= 1) continue;
      if (Math.abs(o.ship.lat - s.lat) > dLat) continue;
      const d = haversine(s.lat, s.lon, o.ship.lat, o.ship.lon);
      if (d <= bd) { bd = d; best = o; }
    }
    return best ? { player: best, distM: bd } : null;
  }
  // Look-ahead distance for factor f: MIN_LAND_M, longer when LOOKAHEAD_S real seconds of warped travel cover more.
  warpLookahead(p, f) {
    const v = Math.abs(num(p.ship.spd, 0)) * GEO.KN_TO_MS * SIM.MOTION_SCALE * f;
    return clamp(v * WARP.LOOKAHEAD_S, WARP.MIN_LAND_M, Math.max(WARP.MIN_LAND_M, WARP.MAX_LOOKAHEAD_M));
  }
  // First point along the course (heading, reversed when going astern) within rangeM where the water is shallower than
  // draft + KEEL_MARGIN_M; samples every SAMPLE_M up to and including rangeM. Inside a built harbour patch the patch
  // mask decides (its basins are dredged where the coarse raster says land); elsewhere world.depthAt at low water.
  shallowAhead(p, rangeM) {
    const s = p.ship, C = SHIP_CLASSES[s.cls] || SHIP_CLASSES.coaster;
    const need = C.draft + WARP.KEEL_MARGIN_M;
    const course = num(s.spd, 0) < 0 ? normDeg(num(s.hdg, 0) + 180) : normDeg(num(s.hdg, 0));
    let tide = 0;
    try { tide = Math.min(0, num(tideAt(s.lat, s.lon, this.simTime).height, 0)); } catch { tide = 0; }
    const step = Math.max(50, WARP.SAMPLE_M), n = Math.max(1, Math.ceil(rangeM / step));
    for (let k = 1; k <= n; k++) {
      const d = Math.min(rangeM, k * step);
      const pt = destination(s.lat, s.lon, course, d);
      const pen = this.landPenetration(pt.lat, pt.lon);
      const depth = pen != null ? (pen > 0 ? -pen : Infinity) : this.world.depthAt(pt.lat, pt.lon) + tide;
      if (!(depth >= need)) return { distM: d, depth: Number.isFinite(depth) ? depth : -1 };
    }
    return null;
  }
  landAheadReason(sh) {
    return `${sh.depth <= 0 ? 'land' : `shallows (${sh.depth.toFixed(1)} m)`} ${dist1(sh.distM)} ahead — above ${WARP.LAND_CHECK_ABOVE}× you need ${km1(WARP.MIN_LAND_M)} km of deep water ahead.`;
  }
  // Every tick while warped: back to 1× (with the reason) as soon as the level is no longer allowed; entering a harbour
  // zone above HARBOR_MAX steps down to HARBOR_MAX instead (the route flag is kept for the way out).
  checkWarp(p) {
    const f = this.warpOf(p);
    if (f <= 1) { p.warp = 1; return; }
    const cond = this.warpConditions(p);
    if (cond) return void this.dropWarp(p, capitalise(cond));
    const zone = this.harbourZone(p);
    if (zone && f > WARP.HARBOR_MAX) return void this.capWarp(p, WARP.HARBOR_MAX, `${this.zoneWhere(zone)} — ${WARP.HARBOR_MAX}× at most inside harbours.`);
    const why = this.warpBlock(p, f, !!p.warpRouted);
    if (why) this.dropWarp(p, capitalise(why));
  }
  // V6 item 6 (docs/V6-QUICK-CONTRACTS.md §2): the harbour zone caps warp at HARBOR_MAX. null, or
  // { harbor (HARBORS entry), distM (m to its anchor; 0 moored), kind: 'moored'|'tugs'|'near'|'patch' }.
  harbourZone(p) {
    const s = p.ship;
    if (p.docked) { const h = harborById(p.docked); if (h) return { harbor: h, distM: 0, kind: 'moored' }; }
    const { harbor, units } = this.nearestHarbor(s.lat, s.lon);
    if (p.assist) {
      const h = harborById(p.assist.harbor), a = h && this.harborAnchor(h);
      if (h) return { harbor: h, distM: a ? unitsBetween(s.lat, s.lon, a.lat, a.lon) : 0, kind: 'tugs' };
      if (harbor) return { harbor, distM: units, kind: 'tugs' };
    }
    if (!harbor) return null;
    if (units <= WARP.HARBOR_RADIUS_M) return { harbor, distM: units, kind: 'near' };
    if (this.landPenetration(s.lat, s.lon) !== null) return { harbor, distM: units, kind: 'patch' };
    return null;
  }
  // 'moored in Rotterdam (Maasvlakte)' | 'under tow by the Rotterdam (Maasvlakte) tugs' | 'Rotterdam (Maasvlakte) is 3.0 km away'
  zoneWhere(zone) {
    const name = zone.harbor.name;
    if (zone.kind === 'moored') return `moored in ${name}`;
    if (zone.kind === 'tugs') return `under tow by the ${name} tugs`;
    return `${name} is ${dist1(zone.distM)} away`;
  }
  // Step DOWN to `to` (never up), keeping the route flag; a 'warn' event and `you` go out. Returns whether it changed.
  capWarp(p, to, reason) {
    const was = this.warpOf(p);
    if (!(to < was) || !WARP.LEVELS.includes(to)) return false;
    p.warp = to; this.startGrace(p, was);
    this.event(p, 'warn', `Time warp ${was}× → ${to}×: ${capitalise(reason)}`);
    this.sendYou(p);
    return true;
  }
  // Drop to 1× with a 'warn' event; `send` = false when the caller sends `you` itself. Returns whether it was warped.
  dropWarp(p, reason, send = true) {
    const was = this.warpOf(p);
    if (was <= 1) { p.warp = 1; return false; }
    this.endWarp(p, was);
    this.event(p, 'warn', `Time warp off (${was}× → 1×): ${reason}`);
    if (send) this.sendYou(p);
    return true;
  }
  endWarp(p, was) { p.warp = 1; p.warpRouted = false; this.startGrace(p, was); }
  startGrace(p, was) {
    const now = Date.now();
    const prev = p.warpGraceUntil > now && WARP.LEVELS.includes(p.warpGraceFactor) ? p.warpGraceFactor : 1;
    p.warpGraceFactor = Math.max(prev, was); p.warpGraceUntil = now + WARP.GRACE_MS;
  }
  // Silent reset (connect, disconnect): no event, no grace — the client starts over in real time.
  resetWarp(p) { p.warp = 1; p.warpRouted = false; p.warpGraceUntil = 0; p.warpGraceFactor = 1; }
  // For the HUD (you.warpLimit): the highest level the server would accept right now given a route, and why not higher.
  warpLimit(p) {
    const top = WARP.LEVELS[WARP.LEVELS.length - 1];
    const why = this.warpConditions(p);
    const zone = this.harbourZone(p); // inside a harbour zone: HARBOR_MAX, and which harbour (the key is omitted outside)
    const harbour = zone ? { id: zone.harbor.id, name: zone.harbor.name, distM: Math.round(zone.distM), kind: zone.kind } : null;
    if (why) return harbour ? { max: 1, reason: capitalise(why), routeAbove: WARP.MAX_NO_ROUTE, harbour } : { max: 1, reason: capitalise(why), routeAbove: WARP.MAX_NO_ROUTE };
    if (harbour) return { max: WARP.HARBOR_MAX, reason: `${capitalise(this.zoneWhere(zone))} — ${WARP.HARBOR_MAX}× at most inside harbours.`, routeAbove: WARP.MAX_NO_ROUTE, harbour };
    { const c = this.wwWarpCap(p); if (c) return { max: Math.min(c.max, top), reason: c.reason, routeAbove: WARP.MAX_NO_ROUTE }; }   // BRIDGES & LOCKS
    const sh = this.shallowAhead(p, this.warpLookahead(p, top));
    if (!sh) return { max: top, reason: null, routeAbove: WARP.MAX_NO_ROUTE };
    let max = 1;
    for (let i = WARP.LEVELS.length - 1; i >= 0; i--) {
      const l = WARP.LEVELS[i];
      if (l <= WARP.LAND_CHECK_ABOVE || sh.distM > this.warpLookahead(p, l)) { max = l; break; }
    }
    return { max, reason: max < top ? capitalise(this.landAheadReason(sh)) : null, routeAbove: WARP.MAX_NO_ROUTE };
  }

  // ------------------------------------------------------------------ v0.2: contracts at sea
  towPickup(p, jobId) {
    const j = p.jobs.find((x) => x.id === jobId && x.type === 'tow');
    if (!j) return this.event(p, 'warn', 'No such towing contract.');
    if (p.docked) return;
    if (p.towing) return this.event(p, 'warn', 'You already have a tow.');
    if (unitsBetween(p.ship.lat, p.ship.lon, j.at.lat, j.at.lon) > INTERACT.TOW_RANGE_U) return this.event(p, 'warn', `Get within ${INTERACT.TOW_RANGE_U} m of the casualty.`);
    if (Math.abs(p.ship.spd) > 3) return this.event(p, 'warn', 'Slow below 3 kn to pass the tow line.');
    p.towing = j.id; j.pickedUp = true; p.fishing = false;
    this.event(p, 'info', `Tow line secured on the ${SHIP_CLASSES[j.victimCls].name.toLowerCase()}. Bring her to ${harborById(j.to).name}: harbour tugs take over ${km1(INTERACT.TOW_HANDOVER_M)} km off the port${SHIP_CLASSES[p.ship.cls].towPower ? '' : ' — expect a third less speed'}.`);
    this.sendYou(p);
  }
  // Harbour tugs take the casualty off your hands outside the destination port; the contract pays there.
  checkTowHandover(p) {
    const j = p.jobs.find((x) => x.id === p.towing);
    if (!j) { p.towing = null; return; }
    const h = harborById(j.to); if (!h) return;
    const a = this.geom?.harborAnchor?.(h.id) || h;
    if (haversine(p.ship.lat, p.ship.lon, a.lat, a.lon) > INTERACT.TOW_HANDOVER_M) return;
    p.towing = null;
    this.event(p, 'info', `${h.name} harbour tugs take the ${SHIP_CLASSES[j.victimCls]?.name.toLowerCase() || 'casualty'} in. Tow line slipped.`);
    this.payJob(p, j, 1, h);
    this.sendYou(p);
  }
  deliverOffshore(p, jobId) {
    const j = p.jobs.find((x) => x.id === jobId && x.type === 'supply');
    if (!j) return this.event(p, 'warn', 'No such supply contract.');
    if (p.docked) return;
    if (unitsBetween(p.ship.lat, p.ship.lon, j.at.lat, j.at.lon) > INTERACT.PLATFORM_RANGE_U) return this.event(p, 'warn', `Get within ${INTERACT.PLATFORM_RANGE_U} m of ${j.platformName}.`);
    if (Math.abs(p.ship.spd) > 3) return this.event(p, 'warn', 'Hold station under 3 kn for the crane transfer.');
    const stack = p.cargo.find((c) => c.jobId === j.id);
    if (!stack) return this.event(p, 'warn', 'The supplies are no longer aboard.');
    const frac = Math.min(1, stack.qty / j.qty);
    p.cargo = p.cargo.filter((c) => c !== stack);
    if (!Number.isFinite(j.dueShip)) this.migrateAcceptedJob(p, j);
    let pay = Math.round(j.pay * frac * (p.shipTime > (j.dueShip ?? Infinity) ? 0.5 : 1)); // V6 item 5: due on the ship's clock
    p.money += pay; p.stats.delivered++; p.stats.earned += pay;
    p.jobs = p.jobs.filter((x) => x.id !== j.id);
    this.event(p, 'info', `${j.platformName} took the supplies. +${fmt(pay)} cr.`);
    this.sendYou(p);
  }
  expressPassage(p, lat, lon, opts = {}) {
    if (p.docked) return this.event(p, 'warn', 'Cast off first.');
    if (p.assist) return this.event(p, 'info', 'The tugs have you. Hold on.'); // the tug assist owns the position (was charged, then undone)
    if (p.hail) return this.event(p, 'law', 'Not with the coast guard on the radio.');
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85) return;
    if (p.expressBusy && !opts.built) return this.event(p, 'info', 'The navigator is still plotting the last passage.');
    const distM = haversine(p.ship.lat, p.ship.lon, lat, lon);
    if (distM < 2000) return this.event(p, 'warn', 'Too close to bother.');
    const nm = distM / 1852;
    const cost = Math.round(nm * SIM.EXPRESS_CR_PER_NM);
    if (p.money < cost) return this.event(p, 'warn', `Express passage costs ${fmt(cost)} cr (${Math.round(nm)} nm × ${SIM.EXPRESS_CR_PER_NM}). You have ${fmt(p.money)}.`);
    const C = SHIP_CLASSES[p.ship.cls];
    const hours = distM / (Math.max(6, C.maxKn * 0.8) * GEO.KN_TO_MS) / 3600;
    const fuelNeeded = fuelBurnPerSimHour(p.ship.cls, 0.8, cargoMass(p.cargo) / C.capacity, 0, p.cond) * hours;
    if (p.fuel < fuelNeeded && !C.sail) return this.event(p, 'warn', `Not enough fuel for the passage: needs ${fuelNeeded.toFixed(1)} t, tanks hold ${p.fuel.toFixed(1)} t.`);
    // V7 step 0: the harbour maps the arrival may sit on are built first (production builds them on demand), so the
    // safe-spot check sees the same quays and depths the client will load; then nothing is charged before a spot is found.
    if (!opts.built) {
      const need = this.expressPatchesToBuild(lat, lon);
      if (need.length) {
        p.expressBusy = true;
        const tmo = (pr) => Promise.race([Promise.resolve(pr).catch(() => null), new Promise((r) => setTimeout(r, 8000).unref?.())]);
        return Promise.all(need.map((id) => tmo(this.geom.ensureHarbor(id)))).then(() => {
          p.expressBusy = false;
          return this.expressPassage(p, lat, lon, { built: true });
        }, () => { p.expressBusy = false; });
      }
    }
    const arr = this.expressArrival(p, lat, lon);
    if (!arr.ok) return this.event(p, 'warn', arr.why);
    if (this.politics) {                               // war cover and incident rolls for the listed areas on the way (H17)
      const x = this.politics.expressCheck(p, { points: [[arr.lat, arr.lon]] });
      if (x.refuse) return this.event(p, 'warn', x.text);
      if (x.incidents.some((i) => i.outcome === 'loss')) return;
    }
    p.money -= cost; p.fuel = Math.max(0, p.fuel - fuelNeeded);
    p.cond = Math.max(Math.min(1, p.cond), p.cond - wearPerSimHour(0.8, this.wind.spd, C.wearMul) * hours);   // an express passage never takes the hull below 1 %
    const s = p.ship;
    s.lat = arr.lat; s.lon = arr.lon; s.hdg = normDeg(arr.hdg); s.spd = 0; s.throttle = 0; s.rudder = 0;
    // grounding watch starts afresh at the new position (no stale shallow timer, no teleport back to the old water)
    p.lastValid = { lat: arr.lat, lon: arr.lon }; p.shallowSince = 0; p.moveBudget = 0; p.lastState = Date.now(); p.rejects = 0;
    p.stats.distanceKm += distM / 1000;
    p.shipTime = (Number.isFinite(p.shipTime) ? p.shipTime : this.simTime) + hours * 3600; // V6 item 5: the passage hours pass on the ship's clock
    const where = arr.harbor ? ` You lie ${(arr.offM / 1000).toFixed(1)} km off ${arr.harbor.name}, heading for the entrance.` : '';
    this.event(p, 'info', `Express passage: ${Math.round(nm)} nm in the blink of an eye for ${fmt(cost)} cr (${hours.toFixed(1)} h of fuel and wear charged; ship's clock +${hours.toFixed(1)} h).${where}`);
    this.sendYou(p, { correction: true });
  }
  // Harbours whose built map could cover the express arrival near (lat, lon) but are not built yet (at most 3).
  // Big ports (server/bigports.js) count too: their extra patches carry the real quays where the raster only has 550 m cells.
  // A map that could not be built (an extra patch with no data, Overpass down) is not waited for again for 10 min.
  expressPatchesToBuild(lat, lon) {
    if (!this.geom || typeof this.geom.ensureHarbor !== 'function' || typeof this.geom.getHarborGeom !== 'function') return [];
    const tried = this.expressGeomTried || (this.expressGeomTried = new Map()), now = Date.now();
    const out = [];
    for (const h of HARBORS.concat(allSubPatches(HARBORS))) {
      if (Math.abs(h.lat - lat) > 0.12 || haversine(lat, lon, h.lat, h.lon) > EXPRESS_SAFE.HARBOUR_NEAR_M + 3000) continue;
      if (now - (tried.get(h.id) || 0) < 600e3) continue;
      try { if (!this.geom.getHarborGeom(h.id)) out.push({ id: h.id, d: haversine(lat, lon, h.lat, h.lon) }); } catch { /* skip */ }
    }
    const ids = out.sort((a, b) => a.d - b.d).slice(0, 4).map((x) => x.id);
    for (const id of ids) tried.set(id, now);
    return ids;
  }
  // Water depth (m) at LOW water: the built harbour map where one covers the point (quays/land = -1), else the world raster.
  depthAtLowWater(lat, lon) {
    const lw = lowWaterAt(lat, lon);
    const pen = this.landPenetration(lat, lon);
    if (pen != null) {
      if (pen > 0) return -1;
      let h = null;
      try { h = typeof this.geom.patchHeightAt === 'function' ? this.geom.patchHeightAt(lat, lon) : null; } catch { h = null; }
      if (Number.isFinite(h)) return -h + lw;
    }
    return this.world.depthAt(lat, lon) + lw;
  }
  // Every other hull near (lat, lon) the arrival must keep clear of: skippers (and their tugs), AI traffic, cutters, AIS, wrecks.
  expressOthers(p, lat, lon, rangeM = 25000) {
    const out = [], near = (o) => o && Number.isFinite(o.lat) && Number.isFinite(o.lon) && Math.abs(o.lat - lat) < rangeM / 100000 && haversine(lat, lon, o.lat, o.lon) <= rangeM;
    const push = (o, len) => { if (near(o)) out.push({ lat: o.lat, lon: o.lon, len }); };
    for (const q of this.players.values()) {
      if (q === p || !q.ship) continue;
      push(q.ship, SHIP_CLASSES[q.ship.cls]?.length || 100);
      let tugs = null; try { tugs = tugsPublic(this, q); } catch { tugs = null; }
      for (const t of tugs || []) push(t, 32);
    }
    if (this.traffic) { try { for (const a of this.traffic.near(lat, lon, rangeM) || []) push(a, SHIP_CLASSES[a.cls]?.length || 150); } catch { /* no traffic */ } }
    for (const c of this.cutters || []) push(c, 60);
    if (this.liveAis && typeof this.liveAis.near === 'function') { try { for (const v of this.liveAis.near(lat, lon, rangeM, { limit: 500 }) || []) push(v, Number(v.length) || 120); } catch { /* AIS down */ } }
    for (const w of this.wrecks || []) push(w, 60);
    for (const o of this.fleet.hullsNear(lat, lon, rangeM, p.vessel)) out.push(o);   // v6: fleet ships
    return out;
  }
  /**
   * Where an express passage to (lat, lon) arrives: {ok, lat, lon, hdg, offM, harbor?} or {ok: false, why}. Within
   * HARBOUR_NEAR_M of a harbour the ship lies 1.5–2 km out on its approach heading for the entrance; elsewhere at the
   * nearest safe spot to the point. Safe = server/safespot.js (depth at low water, a clear circle, other ships).
   */
  expressArrival(p, lat, lon) {
    const C = SHIP_CLASSES[p.ship.cls];
    const o = { draft: C.draft, length: C.length, depthLW: (a, b) => this.depthAtLowWater(a, b), others: this.expressOthers(p, lat, lon) };
    const { harbor, units } = this.nearestHarbor(lat, lon);
    if (harbor && units <= EXPRESS_SAFE.HARBOUR_NEAR_M) {
      const anchor = this.harborAnchor(harbor), geom = this.harborGeom(harbor.id);
      const fromAnchor = (a, b) => haversine(anchor.lat, anchor.lon, a, b);
      const score = (a, b) => -Math.abs(fromAnchor(a, b) - EXPRESS_SAFE.APPROACH_M);
      // the approach 1.5–2 km out (fairway, else the most open bearing); a deep hull on a shoal coast further out
      const tries = [[harbourAim({ anchor, fairway: geom?.fairway, depthLW: o.depthLW }), 2500], [harbourAim({ anchor, depthLW: o.depthLW }), 6000], [harbourAim({ anchor, depthLW: o.depthLW, distM: 6000 }), 9000]];
      if (harbor.roads) tries.push([{ lat: harbor.roads.lat, lon: harbor.roads.lon }, 9000]);   // audited harbours: their roads (deep hulls)
      for (const [aim, maxRadiusM] of tries) {
        const spot = findSafeSpot(aim, { ...o, score, maxRadiusM });
        if (spot) return { ok: true, lat: spot.lat, lon: spot.lon, hdg: bearing(spot.lat, spot.lon, anchor.lat, anchor.lon), offM: fromAnchor(spot.lat, spot.lon), harbor };
      }
      return { ok: false, why: `No safe water to arrive in off ${harbor.name} for a ${C.name.toLowerCase()} (${C.draft} m draught) — try a point further out.` };
    }
    const onLand = !(o.depthLW(lat, lon) > 0);
    const spot = findSafeSpot({ lat, lon }, { ...o, maxRadiusM: onLand ? 2000 : 5000 });
    if (!spot) return { ok: false, why: onLand ? 'That destination is on land.' : `No safe water there for a ${C.name.toLowerCase()} (${C.draft} m draught, room to swing, clear of other ships) — pick deeper open water.` };
    return { ok: true, lat: spot.lat, lon: spot.lon, hdg: bearing(p.ship.lat, p.ship.lon, lat, lon), offM: spot.offM };
  }
  setVoyage(p, m) {
    if (m.clear) { p.voyage = null; this.sendYou(p); return; }
    // v6 (docs/V6-QUICK-CONTRACTS.md §4.7): { route: [[lat, lon], …] (≤ 250), throttle, harbor? }; the legacy
    // { lat, lon, throttle } is a one-point route. The crew sails the planned waypoints while the skipper is away.
    let route;
    if (Array.isArray(m.route)) {
      if (!validWarpRoute(m.route) || m.route.length > 250) { this.event(p, 'warn', 'Voyage refused: that route is not valid (1–250 waypoints).'); return; }
      route = m.route.map((pt) => (Array.isArray(pt) ? [pt[0], pt[1]] : [pt.lat, pt.lon])).map(([lat, lon]) => [Math.round(clampLat(lat) * 1e5) / 1e5, Math.round(wrapLon(lon) * 1e5) / 1e5]);
    } else {
      const lat = Number(m.lat), lon = Number(m.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      route = [[clampLat(lat), wrapLon(lon)]];
    }
    const harbor = typeof m.harbor === 'string' && harborById(m.harbor) ? m.harbor : null;
    p.voyage = { route, i: 0, throttle: clamp(Number(m.throttle) || 0.7, 0.1, 1), harbor, setAt: Date.now() };
    let d = 0, prev = p.ship;
    for (const [lat, lon] of route) { d += haversine(prev.lat, prev.lon, lat, lon); prev = { lat, lon }; }
    const where = harbor ? `to the approach off ${harborById(harbor).name}` : route.length > 1 ? 'to the last waypoint' : `to ${route[0][0].toFixed(2)}°, ${route[0][1].toFixed(2)}°`;
    this.event(p, 'info', `Course laid in: ${route.length} waypoint${route.length > 1 ? 's' : ''}, ${Math.round(d / 1852)} nm ${where}. The crew keeps sailing it while you are away.`);
    this.sendYou(p);
  }
  // Offline players with a voyage set keep moving on the server, waypoint by waypoint, slowing in harbour approaches.
  /** tideAt per 0.1° cell and sim minute (the offline stepper calls it every substep for every voyage and fleet ship;
   *  tideAt walks forward for the next high/low water, ~20 µs a call). Height drifts < 3 cm within a minute. */
  tideCached(lat, lon) {
    const min = Math.floor(this.simTime / 60);
    if (this._tideMin !== min || !this._tide || this._tide.size > 20000) { this._tideMin = min; this._tide = new Map(); }
    const key = Math.round(lat * 10) * 4000 + Math.round(lon * 10);
    let t = this._tide.get(key);
    if (!t) { t = tideAt(Math.round(lat * 10) / 10, Math.round(lon * 10) / 10, min * 60); this._tide.set(key, t); }
    return t;
  }
  simulateOffline(p, dt) {
    const v = p.voyage; if (!v || p.docked || p.flooding >= 1 || p.hail) return;
    const BANDS = [[1000, 4], [2500, 6], [5000, 10]]; // harbour speed limits (m from the nearest anchor → kn), = PILOT.BANDS (public/js/pilotcore.js)
    if (!Array.isArray(v.route) || !v.route.length) { // a legacy saved voyage { lat, lon }
      if (!Number.isFinite(v.lat) || !Number.isFinite(v.lon)) { p.voyage = null; return; }
      v.route = [[v.lat, v.lon]]; v.i = 0; v.harbor = v.harbor || null; delete v.lat; delete v.lon;
    }
    const s = p.ship, C = SHIP_CLASSES[s.cls] || SHIP_CLASSES.coaster;
    const last = v.route.length - 1;
    let i = Math.max(0, Math.min(last, Number(v.i) | 0));
    let wp = v.route[i], dist = haversine(s.lat, s.lon, wp[0], wp[1]);
    // Inside a built harbour patch the route threads basins and quay corners: take its waypoints closely (cutting 300 m
    // corners there ran captains' ships into the quays — v6 fleet phase 2); in open water keep the wide reach.
    const reach = this.landPenetration(s.lat, s.lon) != null ? Math.max(40, C.length) : Math.max(300, 3 * C.length);
    while (i < last && dist < reach) { i++; wp = v.route[i]; dist = haversine(s.lat, s.lon, wp[0], wp[1]); }
    v.i = i;
    if (i === last && dist < 400) {
      const h = v.harbor ? harborById(v.harbor) : null;
      p.voyage = null; s.throttle = 0; p.voyageEnd = 'arrived';
      p.log = (p.log || []).slice(-30).concat([{ kind: 'info', text: h ? `The crew reached the approach off ${h.name} and stopped engines.` : 'The crew reached the waypoint and stopped engines.', time: Date.now() }]);
      return;
    }
    const brg = bearing(s.lat, s.lon, wp[0], wp[1]);
    let nearM = Infinity;
    for (const h of HARBORS) { if (Math.abs(h.lat - s.lat) > 0.1) continue; const a = this.harborAnchor(h); const d = haversine(s.lat, s.lon, a.lat, a.lon); if (d < nearM) nearM = d; }
    let capKn = Infinity; for (const [m, kn] of BANDS) if (nearM <= m) { capKn = kn; break; }
    const throttle = Math.min(v.throttle, capKn / C.maxKn);
    const w = this.weatherAt(s.lat, s.lon), tide = this.tideCached(s.lat, s.lon);
    const env = {
      cond: p.cond, flooding: p.flooding, loadFrac: cargoMass(p.cargo) / C.capacity, wind: w.wind, current: currentAt(s.lat, s.lon, this.simTime), tideStream: tide.stream,
      fuelEmpty: p.fuel <= 0, sea: w.sea, waveH: w.waves.height, waveDir: w.waves.dir, towing: !!p.towing, sailsUp: p.sailsUp !== false,
      fast: true, simTime: this.simTime, gusts: false, crewAuto: 'full',   // sailing: offline/captains use the polar fast path, crew on auto (§2.10)
    };
    const before = { lat: s.lat, lon: s.lon };
    const rudderCmd = this.sailHelmOffline(p, v, i, wp, brg, dist, nearM, env, dt) ?? clamp(angleDiff(s.hdg, brg) / 25, -1, 1);
    stepShip(s, { throttleCmd: throttle, rudderCmd }, env, dt);
    // Inside a built harbour patch the mask decides; elsewhere the coarse depth plus the tide.
    const pen = this.landPenetration(s.lat, s.lon);
    // (the same tolerance as onState: a hull centre grazing a mask edge by < LAND_PENETRATION_M is not aground)
    const depth = pen != null ? (pen > LAND_PENETRATION_M ? -1 : Infinity) : this.world.depthAt(s.lat, s.lon) + tide.height;
    if (depth < C.draft) { s.lat = before.lat; s.lon = before.lon; s.spd = 0; p.voyage = null; p.voyageEnd = 'shoal'; p.log = (p.log || []).slice(-30).concat([{ kind: 'warn', text: 'The crew stopped: shoal water ahead on the autopilot course.', time: Date.now() }]); }
    else p.lastValid = { lat: s.lat, lon: s.lon };
  }

  // ------------------------------------------------------------------ v0.2: ship market
  buyUsedShip(p, listingId) {
    if (!p.docked) return;
    const st = this.harbors[p.docked];
    const l = (st.used || []).find((x) => x.id === listingId);
    if (!l) return this.event(p, 'warn', 'That hull was sold.');
    const C = SHIP_CLASSES[l.cls];
    const tradeIn = shipValue(p.ship.cls, p.cond);
    const cost = l.price - tradeIn;
    if (p.money < cost) return this.event(p, 'warn', `${C.name} (${l.cond} %) costs ${fmt(cost)} cr after trade-in. You have ${fmt(p.money)}.`);
    if (cargoMass(p.cargo) > C.capacity) return this.event(p, 'warn', 'Your cargo would not fit in that ship.');
    const pax = p.jobs.filter((j) => j.pax).reduce((s, j) => s + j.pax, 0);
    if (pax > C.pax) return this.event(p, 'warn', 'Your passengers would not fit in that ship.');
    p.money -= cost; p.ship.cls = l.cls; p.cond = l.cond; p.flooding = 0; p.fuel = Math.min(p.fuel, C.fuelCap);
    p.serviceDue = this.simTime + SERVICE_INTERVAL_S * (0.2 + 0.6 * (l.cond / 100)); // a used hull is part-way through its interval
    st.used = st.used.filter((x) => x !== l);
    this.event(p, 'info', `Bought a second-hand ${C.name} at ${l.cond} % condition. Trade-in credited ${fmt(tradeIn)} cr.`);
    this.sendYou(p); this.sendHarbor(p);
  }
  // Every harbour's job board for the chart (GET /api/jobs): jobs carry pay/t, destination name and deadline;
  // each entry carries the harbour's position so the chart can draw the board where it belongs.
  publicJobs() {
    const out = [];
    for (const h of HARBORS) {
      const st = this.harbors[h.id]; if (!st) continue;
      const harbor = { id: h.id, name: h.name, lat: h.lat, lon: h.lon, size: h.size, country: h.country };
      out.push({ ...harbor, harbor, jobs: (st.jobs || []).map(publicJob), used: (st.used || []).length, fuel: this.fuelPrice(h), trend: marketTrend(st) });
    }
    return { time: Date.now(), harbors: out };
  }

  // ------------------------------------------------------------------ v0.2: weather & storms
  // Weather at a point: the base is real Open-Meteo data when the WeatherService has the cell, else the synthetic
  // global wind; the game's storm cells are overlaid on EITHER base (server/stormfield.js: cyclonic wind, gusts, a sea
  // grown with fetch and duration, swell running ahead, rain bands, pressure, visibility), so a storm on the chart is
  // a storm at sea for every player. Real-weather storm areas (server/realstorms.js) are only overlaid on the synthetic
  // base — where real data exists it already contains them. Shape (docs/V3-CONTRACTS.md §3): { wind:{u,v,spd,dir,gust},
  // sea, storm, rain, waves:{height,dir,period}, swell:{height,dir,period}, visibility, pressure, temp, cloud, source,
  // [stormId, stormName, stormKind] }.
  weatherAt(lat, lon) {
    const real = this.sampleWeather(lat, lon);
    if (real) return overlayStorms(real, this.storms, lat, lon, this.simTime);
    const rs = this.realStorms ? this.realStorms.cells() : [];
    return overlayStorms(this.syntheticWeather(lat), rs.length ? this.storms.concat(rs) : this.storms, lat, lon, this.simTime);
  }
  // The synthetic fallback without storms: the slowly wandering global wind and its fully developed sea.
  syntheticWeather(lat) {
    const u = this.wind.u, v = this.wind.v;
    const spd = Math.hypot(u, v);
    const dir = normDeg((Math.atan2(-u, -v) * 180) / Math.PI);
    // Synthetic sea: wind sea grows with the square of the wind (fully developed), a longer swell lags it by 20°.
    const waveH = Math.min(14, 0.021 * spd * spd + 0.15), period = clamp(2.5 + 0.32 * spd, 3, 14);
    const sea = Math.min(1, Math.max(waveH / 6, spd / 24));
    const storm = clamp((spd - 14) / 14, 0, 1);
    const cloud = clamp(0.25 + 0.2 * Math.min(1, spd / 15), 0, 1);
    const month = new Date(this.simTime * 1000).getUTCMonth();
    const temp = Math.round((27 - 0.42 * Math.abs(lat) + (lat >= 0 ? 1 : -1) * 7 * Math.cos(((month - 7) / 12) * Math.PI * 2)) * 10) / 10;
    return {
      wind: { u, v, spd, dir, gust: spd * 1.25 }, sea, storm, rain: 0,
      waves: { height: waveH, dir, period }, swell: { height: Math.min(6, waveH * 0.45 + 0.2), dir: normDeg(dir - 20), period: period + 4 },
      visibility: 22000, pressure: Math.round((1014 - 0.25 * spd) * 10) / 10, temp, cloud, source: 'synthetic',
    };
  }
  // Real data from the WeatherService: null when no cached cell covers the point (a fetch is requested lazily).
  sampleWeather(lat, lon) {
    if (!this.weather) return null;
    let s = null;
    try { s = this.weather.sample(lat, lon); } catch (e) { s = null; }
    if (!s) { this.lazyWeatherRequest(lat, lon); return null; }
    const w = s.wind || {};
    const spd = Math.max(0, num(w.spd, 0)), dir = normDeg(num(w.dir, 0));
    const r = ((dir + 180) * Math.PI) / 180; // dir = where the wind comes FROM
    const u = Math.sin(r) * spd, v = Math.cos(r) * spd;
    const waves = s.waves && Number.isFinite(s.waves.height) ? { height: Math.max(0, s.waves.height), dir: normDeg(num(s.waves.dir, dir)), period: Math.max(1, num(s.waves.period, 5)) }
      : { height: Math.min(14, 0.021 * spd * spd + 0.15), dir, period: clamp(2.5 + 0.32 * spd, 3, 14) };
    const swell = s.swell && Number.isFinite(s.swell.height) ? { height: Math.max(0, s.swell.height), dir: normDeg(num(s.swell.dir, waves.dir)), period: Math.max(1, num(s.swell.period, 9)) }
      : { height: Math.min(6, waves.height * 0.45), dir: normDeg(waves.dir - 20), period: waves.period + 4 };
    const storm = clamp((spd - 14) / 12, 0, 1);
    const rain = clamp(num(s.precip, 0) / 4, 0, 1);
    return {
      wind: { u, v, spd, dir, gust: Math.max(spd, num(w.gust, spd)) }, sea: Math.min(1, waves.height / 6), storm, rain, waves, swell,
      visibility: clamp(num(s.visibility, 20000), 50, 100000), pressure: num(s.pressure, 1013), temp: num(s.temp, 12), cloud: clamp(num(s.cloud, 0.5), 0, 1),
      source: s.source || 'open-meteo', fetchedAt: s.fetchedAt,
      windWaves: s.windWaves || null, current: s.current || null, sst: Number.isFinite(s.sst) ? s.sst : null,
    };
  }
  // At most one request per 0.5° cell per 30 s from the hot path (the service dedups too; this keeps the Map small).
  lazyWeatherRequest(lat, lon) {
    const key = `${Math.round(lat * 2)},${Math.round(lon * 2)}`, now = Date.now();
    const last = this.wxAsked.get(key);
    if (last && now - last < 30000) return;
    if (this.wxAsked.size > 2000) this.wxAsked.clear();
    this.wxAsked.set(key, now);
    try { this.weather.request(lat, lon); } catch {}
  }
  updateStorms(dt) {
    const now = this.simTime;
    this.storms = this.storms.filter((s) => now < s.dies);
    for (const s of this.storms) {
      const step = s.driftMs * dt;
      const n = destination(s.lat, s.lon, s.driftDir, step);
      s.lat = clampLat(n.lat); s.lon = n.lon;
      const age = (now - s.born) / (s.dies - s.born);
      s.intensity = s.peak * Math.sin(Math.min(1, Math.max(0, age)) * Math.PI) ** 0.7;
    }
    // Spawn: on average one new North Sea storm every ~5 hours, a few more worldwide.
    if (this.rnd() < dt / 18000 && this.storms.filter((s) => s.region).length < 3) {
      const lat = 50 + this.rnd() * 11, lon = -6 + this.rnd() * 16;
      this.storms.push({ id: 's' + shortId(), lat, lon, radiusKm: 60 + this.rnd() * 160, peak: 0.55 + this.rnd() * 0.45, intensity: 0.1, driftDir: 30 + this.rnd() * 90, driftMs: 4 + this.rnd() * 8, born: now, dies: now + 3600 * (3 + this.rnd() * 9), region: true, name: stormName(this.rnd) });
      this.broadcast({ t: 'chat', from: 'Met Office', id: 'sys', text: `Gale warning: storm ${this.storms[this.storms.length - 1].name} forming over the North Sea.`, time: Date.now() });
    }
    if (this.rnd() < dt / 9000 && this.storms.filter((s) => !s.region).length < 6) {
      const lat = -50 + this.rnd() * 100, lon = -180 + this.rnd() * 360;
      if (this.world.isWater(lat, lon)) this.storms.push({ id: 's' + shortId(), lat, lon, radiusKm: 150 + this.rnd() * 300, peak: 0.5 + this.rnd() * 0.5, intensity: 0.1, driftDir: this.rnd() * 360, driftMs: 3 + this.rnd() * 7, born: now, dies: now + 3600 * (6 + this.rnd() * 30), region: false, name: stormName(this.rnd) });
    }
  }
  // Game cells (kind 'game': Bft of the peak wind) then the real-weather areas (kind 'real'). Captains and the
  // autopilot route round both.
  stormsPublic() {
    const game = this.storms.map((s) => {
      const v = stormMaxWind(s.intensity);
      return { id: s.id, kind: 'game', name: s.name, lat: round6(s.lat), lon: round6(s.lon), radiusKm: Math.round(s.radiusKm), intensity: Math.round(s.intensity * 100) / 100, bft: beaufort(v), windMs: round1(v), driftDir: Math.round(s.driftDir || 0), driftMs: round1(s.driftMs || 0) };
    });
    let real = [];
    try { real = this.realStorms ? this.realStorms.publicList() : []; } catch { real = []; }
    return real.length ? game.concat(real) : game;
  }

  // ------------------------------------------------------------------ v0.2: search and rescue
  startRescue(p) {
    const s = p.ship;
    const { harbor, units: distM } = this.nearestHarbor(s.lat, s.lon);
    const a = this.harborAnchor(harbor);
    const byBoat = distM < 40000;
    const kn = byBoat ? 25 : 150;
    const travel = distM / (kn * GEO.KN_TO_MS);
    const r = { id: 'r' + shortId(), playerId: p.id, playerName: p.name, kind: byBoat ? 'lifeboat' : 'helicopter', from: harbor.id, fromLat: a.lat, fromLon: a.lon, lat: a.lat, lon: a.lon, toLat: s.lat, toLon: s.lon, hdg: bearing(a.lat, a.lon, s.lat, s.lon), kn, state: 'outbound', eta: Date.now() + Math.min(travel, 1500) * 1000, started: Date.now() };
    this.rescues.push(r);
    p.rescue = { id: r.id, kind: r.kind, eta: r.eta, harbor: harbor.id, lat: s.lat, lon: s.lon };
    this.event(p, 'warn', `${harbor.name} ${byBoat ? 'lifeboat' : 'SAR helicopter'} launched. ETA ${Math.ceil((r.eta - Date.now()) / 60000)} min. Stay with the raft.`);
    this.broadcast({ t: 'chat', from: 'Coastguard', id: 'sys', text: `Mayday relay: ${p.name} in the water at ${s.lat.toFixed(2)}, ${s.lon.toFixed(2)}. ${byBoat ? 'Lifeboat' : 'Helicopter'} launched from ${harbor.name}.`, time: Date.now() });
  }
  updateRescues(dt) {
    for (const r of [...this.rescues]) {
      const p = this.byId.get(r.playerId);
      const now = Date.now();
      const h = r.fromLat != null ? { lat: r.fromLat, lon: r.fromLon } : this.harborAnchor(harborById(r.from));
      if (r.state === 'outbound') {
        const total = Math.max(1, r.eta - r.started), f = now >= r.eta ? 1 : Math.min(1, (now - r.started) / total);
        r.lat = h.lat + (r.toLat - h.lat) * f; r.lon = h.lon + wrapLon(r.toLon - h.lon) * f;
        if (f >= 1) { r.state = 'return'; r.started = now; r.eta = now + 60000; r.hdg = normDeg(r.hdg + 180); if (p) this.finishRescue(p, r); }
      } else if (now >= r.eta) {
        this.rescues = this.rescues.filter((x) => x !== r);
      } else {
        const f = Math.min(1, (now - r.started) / 60000);
        r.lat = r.toLat + (h.lat - r.toLat) * f; r.lon = r.toLon + wrapLon(h.lon - r.toLon) * f;
      }
    }
  }
  finishRescue(p, r) {
    const harbor = harborById(r.from), a = this.harborAnchor(harbor);
    p.rescue = null; this.dropWarp(p, 'In harbour.', false); this.setDocked(p, harbor.id, null);
    p.ship.lat = a.lat; p.ship.lon = a.lon; p.lastValid = { lat: a.lat, lon: a.lon }; p.voyage = null;
    if (p.money >= 2000) {
      p.money -= 2000; p.ship.cls = 'coaster'; p.cond = 70; p.flooding = 0; p.fuel = 30; p.serviceDue = this.simTime + SERVICE_INTERVAL_S / 2;
      this.event(p, 'warn', `Landed at ${harbor.name}. Insurance (2,000 cr) put you in a second-hand coaster.`);
    } else { this.forcedReset(p, 'Landed safe, but you cannot pay the insurance excess.'); return; }
    this.sendYou(p, { correction: true }); this.sendHarbor(p);
  }
  rescuesPublic() { return this.rescues.map((r) => ({ id: r.id, kind: r.kind, lat: round6(r.lat), lon: round6(r.lon), hdg: Math.round(r.hdg), state: r.state, playerName: r.playerName })); }

  // ------------------------------------------------------------------ snapshots
  snapshot() {
    const players = [];
    for (const p of this.byId.values()) if (p.online || (p.voyage && !p.docked) || p.assist) players.push(this.publicState(p)); // an assist runs on when its skipper drops out: others keep seeing her and her tugs
    return { t: 'snap', time: Date.now(), simTime: Math.round(this.simTime), wind: { dir: Math.round(this.wind.dir), spd: Math.round(this.wind.spd * 10) / 10, u: round3(this.wind.u), v: round3(this.wind.v) }, players, cutters: this.cutters.map(cutterPublic), storms: this.stormsPublic(), rescues: this.rescuesPublic() };
  }
  // The common part is serialised once; each socket gets it plus the AI ships within SIM.AI_RANGE_U of that player.
  broadcastSnapshot() {
    const common = JSON.stringify(this.snapshot());
    const prefix = common.slice(0, -1); // drop the closing brace, append the per-player "ai" field
    const full = this.fleet.snapFull();   // v6: every 10th snapshot also lists moored, anchored and laid-up fleet ships
    for (const [id, ws] of this.sockets) {
      if (ws.readyState !== 1) continue;
      const p = this.byId.get(id);
      const ai = p ? this.aiNear(p.ship.lat, p.ship.lon) : [];
      const fl = p ? `,"fleet":${JSON.stringify(this.fleet.viewFor(p, full))}${full ? ',"fleetFull":true' : ''}` : '';
      ws.send(ai.length ? `${prefix},"ai":${JSON.stringify(ai)}${fl}}` : `${prefix},"ai":[]${fl}}`);
    }
    const now = Date.now();
    if (now - this.lastYou > 1000) { this.lastYou = now; for (const p of this.byId.values()) if (p.online) this.sendYou(p); }
  }
  // Surface current + tidal stream (m/s east/north): what offline voyages, cutters and the client's physics feel.
  currentAtPos(lat, lon) {
    const c = currentAt(lat, lon, this.simTime), t = tideAt(lat, lon, this.simTime).stream;
    return { u: c.u + num(t && t.u, 0), v: c.v + num(t && t.v, 0) };
  }
  currentFor(p) { return this.currentAtPos(p.ship.lat, p.ship.lon); }
}

const STORM_NAMES = ['Agnes', 'Babet', 'Ciarán', 'Debi', 'Elin', 'Fergus', 'Gerrit', 'Henk', 'Isha', 'Jocelyn', 'Kathleen', 'Lilian', 'Minnie', 'Nelly', 'Olga', 'Piet', 'Regina', 'Stuart', 'Tamara', 'Vincent'];
function stormName(rnd) { return STORM_NAMES[Math.floor(rnd() * STORM_NAMES.length)]; }
function isGood(g) { return typeof g === 'string' && Object.prototype.hasOwnProperty.call(GOODS, g); }
function cutterPublic(c) { return { id: c.id, name: c.name, lat: round6(c.lat), lon: round6(c.lon), hdg: Math.round(c.hdg), spd: Math.round(c.spd * 10) / 10, state: c.state, targetId: c.targetId }; }
function cleanName(n) { return String(n || '').replace(/[^\w \-'.]/g, '').trim().slice(0, 20); }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function round6(v) { return Math.round(v * 1e6) / 1e6; }
function round3(v) { return Math.round(v * 1e3) / 1e3; }
function round2(v) { return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0; }
function round1(v) { return Number.isFinite(v) ? Math.round(v * 10) / 10 : 0; }
function num(v, d) { return Number.isFinite(v) ? v : d; }
function fmt(n) { return Math.round(n).toLocaleString('en-US'); }
function km1(m) { return (Math.round(m / 100) / 10).toFixed(1); }
function dist1(m) { return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${km1(m)} km`; }
function capitalise(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }
// The route a client sails under warp > MAX_NO_ROUTE: a non-empty array of finite {lat, lon} (or [lat, lon]) points.
// The server only checks it is there and sane; the client's autopilot follows it.
function validWarpRoute(route) {
  if (!Array.isArray(route) || route.length < 1 || route.length > 1000) return false;
  for (const pt of route) {
    const lat = Array.isArray(pt) ? pt[0] : pt && typeof pt === 'object' ? pt.lat : NaN;
    const lon = Array.isArray(pt) ? pt[1] : pt && typeof pt === 'object' ? pt.lon : NaN;
    if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 540) return false;
  }
  return true;
}
const CONTACT_NAMES = ['a man in an oilskin', 'Big Tomas', 'the woman with the dog', 'a kid on a scooter', 'Old Henk', 'the crane operator', 'Mister Lindqvist', 'the harbour master\'s cousin'];
function contactName(rnd) { return CONTACT_NAMES[Math.floor(rnd() * CONTACT_NAMES.length)]; }
