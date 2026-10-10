// Hostile AI ships (docs/HOSTILE-AI-CONTRACT.md): pirate skiffs and naval patrols that attack a skipper who accepted the risk.
// One Hostiles per Game. Everything runs on the tick's `dt` and `game.simTime`, rolls come from `game.rnd()` (tests inject both),
// and at most a handful of units exist (HOSTILE.MAX_PER_PLAYER / MAX_GLOBAL), so the cost per tick is a few distance checks.
// Units are never saved: a restart simply clears them. The player-side state is `p.risk` (saved, healed on load).
import { GEO, SHIP_CLASSES, GOODS } from '../shared/constants.js';
import { haversine, bearing, destination, normDeg, angleDiff, wrapLon, clampLat } from '../shared/geo.js';
import { areasAt, hullValue, pickShare, goodsMatch, isActive, routeExposure, bindsPersonally } from '../shared/politics.js';
import { HARBORS } from './harbors.js';
import {
  HOSTILE, KINDS, WEAPONS, NAVY_NAMES, NAVY_PRESENCE, NAVY_PRESENCE_DEFAULT, HOSTILE_TEXT,
  dayKey, isNight, detectRangeM, identRangeM, preyScore, pirateRatePerH, navyRatePerH, rollP, groupSize, damageFor, ransomFor, labelOf,
} from '../shared/hostile.js';

const r6 = (v) => Math.round(v * 1e6) / 1e6;
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const num = (v, d) => (Number.isFinite(v) ? v : d);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Heal `p.risk` (old saves have none). Pure; returns the object stored on the player. */
export function healRisk(r) {
  const o = r && typeof r === 'object' ? r : {};
  return { on: o.on === true, day: typeof o.day === 'string' ? o.day : '', n: Number.isFinite(o.n) && o.n > 0 ? Math.floor(o.n) : 0, last: num(o.last, 0), lastEnc: num(o.lastEnc, 0) };
}
/** Sails under the crew's hand, not the skipper's: a server-known voyage, a tug assist, a captain or nobody aboard (R11). */
export function isAutoSailed(p) { return !!(p.voyage || p.assist || p.isActor || !p.online); }

export class Hostiles {
  constructor(game, opts = {}) {
    this.game = game;
    this.opts = opts;
    this.encs = [];          // active encounters { id, pid, faction, role, areaId, tier, st, age, units: [] }
    this.seq = 1;
    this.checkT = 0;
    this.stats = { spawned: 0, attacks: 0, sunk: 0, scenes: 0 };
    this.sinking = new Map(); // pid → { p, txt, news, left }: ships going down in view
    this.timers = [];        // { at (sim s), fn }: outcomes that wait for a visual (a mine blast)
  }
  get now() { return this.game.simTime; }
  rnd() { return (this.opts.rnd || this.game.rnd).call(this.game); }
  get ds() { return this.game.politics?.ds || null; }
  water(la, lo) { const w = this.game.world; return w && typeof w.isWater === 'function' ? w.isWater(la, lo) : true; }

  // ------------------------------------------------------------------------------------------ player state
  riskOf(p) { return (p.risk = healRisk(p.risk)); }
  /** Attacks already started on this sim day. */
  attacksToday(p) { const r = this.riskOf(p); return r.day === dayKey(this.now) ? r.n : 0; }
  setRisk(p, on) {
    const r = this.riskOf(p); r.on = !!on;
    if (!r.on) this.endFor(p.id, true);
    this.game.event(p, r.on ? 'warn' : 'info', r.on ? HOSTILE_TEXT.riskOn : HOSTILE_TEXT.riskOff);
    this.game.sendYou(p);
    return r.on;
  }
  /** A rescue landing or a forced reset: no hostile spawns for RESPAWN_COOLDOWN_S (anti-grief). */
  noteRespawn(p) { const r = this.riskOf(p); r.last = this.now; this.endFor(p.id, true); }
  countAttack(p) {
    const r = this.riskOf(p), k = dayKey(this.now);
    if (r.day !== k) { r.day = k; r.n = 0; }
    r.n++; this.stats.attacks++;
  }

  // ------------------------------------------------------------------------------------------ lookups
  attackerOf(pid) { return this.encs.find((e) => e.pid === pid && e.role !== 'friend' && e.st !== 'leave') || null; }   // a unit sailing off is no longer an attacker
  friendOf(pid) { return this.encs.find((e) => e.pid === pid && e.role === 'friend') || null; }
  unitCount(pid = null) { let n = 0; for (const e of this.encs) if (pid == null || e.pid === pid) n += e.units.length; return n; }
  *units() { for (const e of this.encs) for (const u of e.units) yield [e, u]; }
  nearHarbourM(lat, lon) {
    let best = Infinity;
    for (const h of HARBORS) {
      if (Math.abs(h.lat - lat) > 0.2 || Math.abs(wrapLon(h.lon - lon)) > 0.4) continue;
      best = Math.min(best, haversine(lat, lon, h.lat, h.lon));
    }
    return best;
  }
  /** Danger areas at (or within NEAR_AREA_KM of) the ship: { piracy, war, inside } (war_risk only from tier 3). */
  dangerAt(lat, lon) {
    const ds = this.ds; if (!ds) return { piracy: null, war: null, inside: false };
    const pick = (list) => ({ piracy: list.find((a) => a.kind === 'piracy') || null, war: list.filter((a) => a.kind === 'war_risk' && a.tier >= 3).sort((a, b) => b.tier - a.tier)[0] || null });
    const here = pick(areasAt(ds, lat, lon, ['piracy', 'war_risk'], this.now));
    if (here.piracy || here.war) return { ...here, inside: true };
    const out = { piracy: null, war: null, inside: false };
    for (let b = 0; b < 360; b += 45) {
      const q = destination(lat, lon, b, HOSTILE.NEAR_AREA_KM * 1000), n = pick(areasAt(ds, q.lat, q.lon, ['piracy', 'war_risk'], this.now));
      out.piracy ||= n.piracy; out.war ||= n.war;
      if (out.piracy && out.war) break;
    }
    return out;
  }
  /** Cargo / zone grounds for a naval check (R8), or null. Only `contraband` and `sanctioned` ever justify fire. */
  groundsOf(p, area) {
    const ds = this.ds, t = this.now;
    for (const c of p.cargo || []) if (c.contraband && c.qty > 0) return { kind: 'contraband', good: c.good, text: 'carries cargo that is banned (contraband)' };
    if (ds && this.game.politics) {
      // a measure only counts as grounds when it binds this skipper's company (UN measures bind everybody, EU / UK / US ones their own)
      const ctx = this.game.politics.ctxOf(p);
      for (const c of p.cargo || []) {
        if (!(c.qty > 0)) continue;
        const m = ds.measures.find((x) => isActive(x, t) && x.enforce === 'block' && goodsMatch(x, c.good) && bindsPersonally(x, ctx)
          && ((x.kind === 'import_ban' && c.origin && x.origin?.includes(c.origin)) || (x.kind === 'arms_embargo' && c.good === 'weapons')));
        if (m) return { kind: 'sanctioned', good: c.good, origin: c.origin || null, text: `carries cargo under a measure in force: ${m.text || m.id}`, measureId: m.id };
      }
    }
    if (area && area.tier === 4 && this.game.politics) {
      const pol = this.game.politics, corr = pol.corridorFor(area);
      if (corr && pol.offCorridor(pol.vesselOf(p), corr)) return { kind: 'denied_zone', text: `is outside the recommended corridor in ${area.name}`, corridor: corr.id };
    }
    return null;
  }
  fireEligible(g, area) { return !!g && (g.kind === 'contraband' || g.kind === 'sanctioned') && (area?.tier || 0) >= 3; }

  // ------------------------------------------------------------------------------------------ spawning
  /** Why no hostile may spawn for this skipper now, or null. (R2, R3) */
  spawnBlock(p, { express = false } = {}) {
    const r = this.riskOf(p), t = this.now;
    if (!r.on) return 'risk off';
    if (!p.online || p.isActor) return 'offline';
    if (p.docked || p.assist || p.rescue || p.flooding >= 1) return 'not at sea';
    if (!express && this.game.warpOf(p) > HOSTILE.MAX_WARP_SPAWN) return 'warp';
    if (r.last > 0 && t - r.last < HOSTILE.RESPAWN_COOLDOWN_S) return 'respawn cooldown';
    if (r.lastEnc > 0 && t - r.lastEnc < HOSTILE.ENCOUNTER_GAP_S) return 'encounter gap';
    if (this.attacksToday(p) >= HOSTILE.MAX_ATTACKS_PER_DAY) return 'daily cap';
    if (p.hail) return 'coast guard';
    if (this.attackerOf(p.id)) return 'busy';
    if (this.friendOf(p.id)?.st === 'escort') return 'escorted';
    if (this.unitCount(p.id) >= HOSTILE.MAX_PER_PLAYER) return 'player cap';
    if (this.unitCount() >= HOSTILE.MAX_GLOBAL) return 'global cap';
    if (this.nearHarbourM(p.ship.lat, p.ship.lon) < HOSTILE.HARBOUR_CLEAR_M) return 'harbour';
    return null;
  }
  preyOf(p, speedKn = null) {
    const C = SHIP_CLASSES[p.ship.cls] || SHIP_CLASSES.coaster, pol = this.game.politics;
    const load = this.game.cargoLoad ? this.game.cargoLoad(p) : (p.cargo || []).reduce((s, c) => s + num(c.qty, 0), 0) / C.capacity;
    const escorted = !!(p.convoyId && [...this.game.byId.values()].some((o) => o.id !== p.id && o.online && o.convoyId === p.convoyId && !o.docked && haversine(o.ship.lat, o.ship.lon, p.ship.lat, p.ship.lon) <= 1500));
    return preyScore({ spd: speedKn ?? p.ship.spd, loadFrac: clamp(load, 0, 1), length: C.length, escorted, guards: pol ? this.guardsActive(p) : false });
  }
  guardsActive(p, areaId = null) {
    const pol = this.game.politics; if (!pol) return false;
    const v = pol.vesselOf(p), g = pol.polOf(p).guards?.[pol.vkey(v, p)];
    return !!(g && g.until > this.now && (areaId == null || g.areaId === areaId));
  }
  /** Spawn roll for one skipper (called every SPAWN_CHECK_S). Returns the encounter or null. */
  trySpawn(p) {
    if (this.spawnBlock(p)) return null;
    const s = p.ship, d = this.dangerAt(s.lat, s.lon);
    if (!d.piracy && !d.war) return null;
    const wx = this.game.weatherAt?.(s.lat, s.lon) || {}, night = isNight(s.lat, s.lon, this.now);
    // navy first: a war-risk area with a tier-3+ listing
    if (d.war) {
      const g = this.groundsOf(p, d.war), rate = navyRatePerH(d.war, !!g) * (d.inside ? 1 : 0.4);
      if (rate > 0 && this.rnd() < rollP(rate, HOSTILE.SPAWN_CHECK_S)) return this.spawnNavy(p, d.war, g);
    }
    if (d.piracy) {
      if (wx.storm > HOSTILE.PIRATE_STORM) return null;
      const prey = this.preyOf(p);
      const rate = pirateRatePerH(d.piracy, prey) * (night ? 1.5 : 1) * (d.inside ? 1 : 0.4);
      if (rate > 0 && this.rnd() < rollP(rate, HOSTILE.SPAWN_CHECK_S)) return this.spawnPirates(p, d.piracy, prey, wx, night);
    }
    return null;
  }
  /** A water point `dist` m from the ship, within ±spread° of `centreBrg`; null if none found in 8 tries. */
  placeAt(s, dist, centreBrg, spread) {
    for (let i = 0; i < 8; i++) {
      const brg = normDeg(centreBrg + (this.rnd() * 2 - 1) * spread * (1 + i / 4)), q = destination(s.lat, s.lon, brg, dist * (1 - 0.05 * i));
      const lat = clampLat(q.lat), lon = wrapLon(q.lon);
      if (this.water(lat, lon) && this.nearHarbourM(lat, lon) >= HOSTILE.HARBOUR_CLEAR_M) return { lat, lon, brg };
    }
    return null;
  }
  makeUnit(enc, k, pos, hdg, role = enc.role) {
    return { id: `h${this.seq++}`, eid: enc.id, k, role, lat: pos.lat, lon: pos.lon, hdg, spd: 0, ident: false, fireAt: 0, fireKind: null, nextFire: 0 };
  }
  newEnc(p, faction, role, area, extra = {}) {
    const e = { id: `e${this.seq++}`, pid: p.id, faction, role, areaId: area?.id || null, tier: area?.tier || 0, st: 'approach', age: 0, units: [], navyCalledAt: 0, ...extra };
    this.encs.push(e); return e;
  }
  spawnPirates(p, area, prey, wx = {}, night = false) {
    const s = p.ship, room = Math.min(HOSTILE.MAX_PER_PLAYER - this.unitCount(p.id), HOSTILE.MAX_GLOBAL - this.unitCount());
    if (room < 1) return null;
    const n = Math.min(room, groupSize(this.rnd(), prey));
    const detect = detectRangeM(night, clamp((wx.visibility ?? 22000) / 22000, 0, 1));
    const [lo, hi] = HOSTILE.SPAWN_DIST_M, dist = clamp(lo + (hi - lo) * this.rnd(), lo, Math.max(lo, detect * 0.9));
    const at = this.placeAt(s, dist, s.hdg, 70); if (!at) return null;
    const enc = this.newEnc(p, 'pirate', 'hostile', area, { fast: 0, board: 0, hose: { uses: 0, last: -1e9, until: 0 }, comply: 0, citadel: 0, alongside: 0, detect, night, spawnedAt: this.now });
    for (let i = 0; i < n; i++) {
      const o = destination(at.lat, at.lon, normDeg(at.brg + 90), (i - (n - 1) / 2) * 90);
      enc.units.push(this.makeUnit(enc, 'skiff', { lat: clampLat(o.lat), lon: wrapLon(o.lon) }, normDeg(bearing(o.lat, o.lon, s.lat, s.lon))));
    }
    this.stats.spawned += n;
    this.countAttack(p);
    this.game.dropWarp(p, 'Unknown fast craft on the radar.', false);
    const brg = Math.round(bearing(s.lat, s.lon, enc.units[0].lat, enc.units[0].lon)), km = (dist / 1000).toFixed(1);
    this.game.event(p, 'pirate', `Radar: ${n} unknown fast craft, bearing ${brg}°, ${km} km, closing fast. Risk mode is on: speed up, call the navy on VHF, or prepare to be boarded.`);
    this.game.sendYou(p);
    // a patrol may already be in the area
    const presence = NAVY_PRESENCE[area.id] ?? NAVY_PRESENCE_DEFAULT;
    if (this.rnd() < presence * 0.25) this.spawnFriend(p, enc, 'patrol');
    return enc;
  }
  spawnNavy(p, area, grounds) {
    const s = p.ship;
    if (this.unitCount(p.id) >= HOSTILE.MAX_PER_PLAYER || this.unitCount() >= HOSTILE.MAX_GLOBAL) return null;
    const k = area.tier >= 4 ? (this.rnd() < 0.3 ? 'frigate' : 'corvette') : 'patrol';
    const at = this.placeAt(s, 7000 + this.rnd() * 5000, s.hdg, 90); if (!at) return null;
    const enc = this.newEnc(p, 'navy', 'hostile', area, { grounds, warnN: 0, hailT: 0, quiet: 0, ceaseT: 0, inspectT: 0, name: NAVY_NAMES[Math.floor(this.rnd() * NAVY_NAMES.length)], spawnedAt: this.now });
    enc.units.push(this.makeUnit(enc, k, at, normDeg(bearing(at.lat, at.lon, s.lat, s.lon))));
    this.stats.spawned++;
    this.countAttack(p);
    this.game.dropWarp(p, 'A warship is closing.', false);
    this.game.event(p, 'law', `Radar: a ${k === 'patrol' ? 'fast patrol craft' : 'warship'} is closing from ${Math.round(bearing(s.lat, s.lon, at.lat, at.lon))}°, ${(haversine(s.lat, s.lon, at.lat, at.lon) / 1000).toFixed(1)} km. You are in ${area.name}.`);
    this.game.sendYou(p);
    return enc;
  }
  spawnFriend(p, about, k = 'patrol') {
    if (this.friendOf(p.id) || this.unitCount() >= HOSTILE.MAX_GLOBAL + 4) return null;
    const s = p.ship, at = this.placeAt(s, HOSTILE.NAVY_CALL_DIST_M, normDeg(s.hdg + 180 + (this.rnd() - 0.5) * 120), 90); if (!at) return null;
    const area = about ? this.ds?.areaById?.[about.areaId] : null;
    const enc = this.newEnc(p, 'navy', 'friend', area, { st: 'respond', name: NAVY_NAMES[Math.floor(this.rnd() * NAVY_NAMES.length)], until: 0 });
    enc.units.push(this.makeUnit(enc, k, at, normDeg(bearing(at.lat, at.lon, s.lat, s.lon)), 'friend'));
    this.stats.spawned++;
    return enc;
  }

  // ------------------------------------------------------------------------------------------ tick
  tick(dt) {
    if (this.sinking.size) this.stepSinking(dt);
    if (this.timers.length) { const due = this.timers.filter((x) => x.at <= this.now); if (due.length) { this.timers = this.timers.filter((x) => x.at > this.now); for (const x of due) { try { x.fn(); } catch (err) { this.game.log?.(`[hostile] timer failed: ${err.stack || err}`); } } } }
    if (this.encs.length) for (const e of [...this.encs]) { try { this.stepEnc(e, dt); } catch (err) { this.game.log?.(`[hostile] step failed: ${err.stack || err}`); this.removeEnc(e); } }
    this.checkT += dt;
    if (this.checkT >= HOSTILE.SPAWN_CHECK_S) {
      this.checkT = 0;
      for (const p of this.game.byId.values()) { if (p.risk?.on && p.online) { try { this.trySpawn(p); } catch (err) { this.game.log?.(`[hostile] spawn failed: ${err.stack || err}`); } } }
    }
  }
  removeEnc(e) {
    const i = this.encs.indexOf(e); if (i >= 0) this.encs.splice(i, 1);
    this.settle(e);
  }
  /** A scripted scene always delivers its roll's outcome, even if the scene is cut short (docking, switching risk off). */
  settle(e) { const sc = e.script; if (sc && !sc.done) { sc.done = true; try { sc.fn(); } catch (err) { this.game.log?.(`[hostile] scene outcome failed: ${err.stack || err}`); } } }

  // ------------------------------------------------------------------------------------------ 3D scenes for the dice incidents
  /** Can the dice roll of `politics.stepSea` be played as a 3D scene for this skipper? (online, hand-sailed, at sea, room for the boats) */
  canPresent(p) {
    if (!p.online || p.isActor || isAutoSailed(p) || p.docked || p.rescue || p.flooding >= 1 || p.hail) return false;
    if (this.attackerOf(p.id) || this.unitCount(p.id) >= HOSTILE.MAX_PER_PLAYER || this.unitCount() >= HOSTILE.MAX_GLOBAL) return false;
    return this.nearHarbourM(p.ship.lat, p.ship.lon) >= HOSTILE.HARBOUR_CLEAR_M;
  }
  /**
   * Play a politics dice roll as a 3D scene: the roll already happened (it is `spec.kind`), `fn` applies its outcome when the
   * scene reaches that moment. spec { type: 'piracy' | 'incident', kind, area }. Returns true when a scene took over (the caller
   * must not apply the outcome itself), false for the text-only path (offline, express, autopilot, no room).
   */
  present(p, spec, fn) {
    if (!this.canPresent(p)) return false;
    const s = p.ship, area = spec.area, script = { fn, kind: spec.kind, type: spec.type, done: false };
    this.game.dropWarp(p, 'Contact at sea.', false);
    if (spec.kind === 'mine') {
      this.game.send?.(p, { t: 'hostile_fx', kind: 'blast' });
      this.game.event(p, 'warn', 'A deep thud: an explosion in the water beside the hull!');
      this.timers.push({ at: this.now + 1.5, fn });
      this.stats.scenes++; return true;
    }
    const pirate = spec.type === 'piracy', navy = !pirate;
    const at = this.placeAt(s, pirate ? 3500 + this.rnd() * 2500 : 4500 + this.rnd() * 2000, s.hdg, 70); if (!at) return false;
    const enc = this.newEnc(p, pirate ? 'pirate' : 'navy', 'hostile', area, { script, fast: 0, board: 0, hose: { uses: 0, last: -1e9, until: 0 }, comply: 0, citadel: 0, alongside: 0, detect: 9000, night: false, spawnedAt: this.now, name: NAVY_NAMES[Math.floor(this.rnd() * NAVY_NAMES.length)], grounds: null, warnN: 0, hailT: 0, quiet: 0, ceaseT: 0, inspectT: 0, shots: 0 });
    const n = pirate ? (spec.kind === 'hijack' ? 2 : 1 + (this.rnd() < 0.4 ? 1 : 0)) : 1;
    for (let i = 0; i < n; i++) {
      const o = destination(at.lat, at.lon, normDeg(at.brg + 90), (i - (n - 1) / 2) * 90);
      enc.units.push(this.makeUnit(enc, pirate ? 'skiff' : 'patrol', { lat: clampLat(o.lat), lon: wrapLon(o.lon) }, normDeg(bearing(o.lat, o.lon, s.lat, s.lon))));
    }
    this.stats.spawned += n; this.stats.scenes++;
    const brg = Math.round(bearing(s.lat, s.lon, at.lat, at.lon));
    this.game.event(p, pirate ? 'pirate' : 'law', `Radar: ${n > 1 ? `${n} unknown fast craft` : 'an unknown fast craft'}, bearing ${brg}°, ${(haversine(s.lat, s.lon, at.lat, at.lon) / 1000).toFixed(1)} km, closing.`);
    this.game.sendYou(p);
    void navy;
    return true;
  }
  /** The scripted scene's motion: approach, circle, come alongside, fire, board, then the outcome of the roll. The skipper keeps the helm. */
  stepScript(e, p, dt, dmin) {
    const s = p.ship, sc = e.script, pirate = e.faction === 'pirate', spd = Math.abs(s.spd);
    if (e.st === 'approach') {
      const lead = this.station(s, Math.max(0, s.spd) * GEO.KN_TO_MS * 20, 0);
      for (const u of e.units) this.moveUnit(u, lead.lat, lead.lon, KINDS[u.k].kn, dt);
      if (!e.units[0].ident && dmin < 2500) { for (const u of e.units) u.ident = true; this.game.event(p, pirate ? 'pirate' : 'law', pirate ? `VHF channel 16: "Merchant vessel, stop your engine. We are coming alongside." Small boats with armed men.` : `VHF channel 16: "Vessel ${p.name}, this is naval patrol ${e.name}. Reduce speed and stand by."`); }
      if (dmin < 1200) { e.st = 'attack'; e.t0 = e.age; this.game.sendYou(p); }
      return;
    }
    const t = e.age - e.t0, kind = sc.kind;
    e.units.forEach((u, i) => {
      const orbit = t < 14 ? 1 : 0.25;
      const q = this.station(s, -25 + 55 * Math.sin(e.age * 0.45 + i * 2.1) * orbit - 20 * i, (i % 2 ? -1 : 1) * (45 + 35 * Math.cos(e.age * 0.45 + i) * orbit));
      const far = haversine(u.lat, u.lon, s.lat, s.lon) > 300;
      this.moveUnit(u, q.lat, q.lon, far ? KINDS[u.k].kn : Math.max(6, spd + 6), dt);
      if (u.k === 'skiff' && t > 3 && t < 18 && e.age >= u.nextFire) { u.nextFire = e.age + 2.2 + i; this.volleyFx(u, kind === 'repelled' ? 'splash' : 'hit'); }
      if (u.k === 'patrol' && t > 2 && e.age >= u.nextFire && e.shots < 3) { u.nextFire = e.age + 5; e.shots++; this.volleyFx(u, kind === 'projectile' ? 'hit' : 'warning'); }
    });
    const board = pirate && (kind === 'robbery' || kind === 'hijack') && t > 14;
    if (board) e.board = Math.min(1, (t - 14) / 12);
    const due = pirate ? (kind === 'repelled' ? 20 : 26) : (kind === 'projectile' ? 16 : 20);
    if (t > due) {
      this.settle(e);
      if (kind === 'repelled' || !pirate) { this.game.sendYou(p); }
      this.finish(e, p); this.game.sendYou(p);
    }
  }
  /** End an encounter: units sail off and vanish. */
  finish(e, p = null) {
    e.st = 'leave'; e.leaveT = 0;
    if (p && e.role !== 'friend') this.riskOf(p).lastEnc = this.now;
  }
  endFor(pid, hard = false) { for (const e of [...this.encs]) if (e.pid === pid) { if (hard) this.removeEnc(e); else e.st = 'leave'; } }

  moveUnit(u, tlat, tlon, wantKn, dt) {
    const K = KINDS[u.k];
    const want = normDeg(bearing(u.lat, u.lon, tlat, tlon)), d = angleDiff(u.hdg, want);
    u.hdg = normDeg(u.hdg + clamp(d, -K.turn * dt, K.turn * dt));
    u.spd += clamp(wantKn - u.spd, -6 * dt, 6 * dt);
    const step = u.spd * GEO.KN_TO_MS * dt;
    if (step < 0.01) return;
    const n = destination(u.lat, u.lon, u.hdg, step), lat = clampLat(n.lat), lon = wrapLon(n.lon);
    if (this.water(lat, lon)) { u.lat = lat; u.lon = lon; } else { u.hdg = normDeg(u.hdg + 50); u.spd *= 0.5; u.blocked = (u.blocked || 0) + dt; }
  }
  /** A fixed point relative to the ship (m ahead, m to starboard). */
  station(s, ahead, side) {
    const a = destination(s.lat, s.lon, s.hdg, ahead);
    return destination(a.lat, a.lon, normDeg(s.hdg + 90), side);
  }

  stepEnc(e, dt) {
    const p = this.game.byId.get(e.pid);
    e.age += dt;
    if (!p || !p.online || p.docked || p.assist || p.rescue || p.flooding >= 1) return this.removeEnc(e);
    const s = p.ship;
    let dmin = Infinity;
    for (const u of e.units) dmin = Math.min(dmin, haversine(u.lat, u.lon, s.lat, s.lon));
    if (dmin > HOSTILE.DESPAWN_M || e.units.some((u) => (u.blocked || 0) > 25)) return this.removeEnc(e);
    if (e.st === 'leave') return this.stepLeave(e, p, dt, dmin);
    if (e.script) return this.stepScript(e, p, dt, dmin);
    if (e.role === 'friend') return this.stepFriend(e, p, dt, dmin);
    if (e.faction === 'pirate') return this.stepPirates(e, p, dt, dmin);
    return this.stepNavy(e, p, dt, dmin);
  }
  stepLeave(e, p, dt, dmin) {
    e.leaveT = (e.leaveT || 0) + dt;
    const s = p.ship;
    for (const u of e.units) { const away = bearing(s.lat, s.lon, u.lat, u.lon), q = destination(u.lat, u.lon, away, 5000); this.moveUnit(u, q.lat, q.lon, KINDS[u.k].kn, dt); }
    if (dmin > 9000 || e.leaveT > HOSTILE.LEAVE_S * 4) this.removeEnc(e);
  }
  identify(e, p, dmin, msg) {
    if (e.units.every((u) => u.ident) || dmin > identRangeM(isNight(p.ship.lat, p.ship.lon, this.now))) return;
    for (const u of e.units) u.ident = true;
    this.game.event(p, e.faction === 'pirate' ? 'pirate' : 'law', msg);
  }

  // ------------------------------------------------------------------------------------------ pirates
  stepPirates(e, p, dt, dmin) {
    const s = p.ship, spd = Math.abs(s.spd), ownKn = KINDS.skiff.kn;
    this.identify(e, p, dmin, `${e.units.length > 1 ? `${e.units.length} skiffs` : 'A skiff'} with outboards: pirates. Armed men aboard.`);
    // give up (R4)
    if (e.st === 'approach' || e.st === 'attack') {
      e.fast = spd >= HOSTILE.PIRATE_GIVEUP_KN ? e.fast + dt : Math.max(0, e.fast - dt);
      const wx = this.game.weatherAt?.(s.lat, s.lon) || {};
      let why = null;
      if (e.fast > 30) why = 'too fast for them';
      else if (dmin > e.detect * 1.6 && e.age > 60) why = 'out of sight';
      else if (e.age > HOSTILE.PIRATE_MAX_CHASE_S && e.board < 1) why = 'the chase took too long';
      else if (wx.storm > HOSTILE.PIRATE_STORM) why = 'the sea is too rough';
      else if (this.encs.some((o) => o.pid === e.pid && o.role === 'friend' && o.units.some((u) => haversine(u.lat, u.lon, e.units[0].lat, e.units[0].lon) < HOSTILE.FLEE_M))) why = 'a naval patrol is close';
      if (why) { this.game.event(p, 'pirate', `The skiffs break off (${why}).`); e.st = 'flee'; this.finish(e, p); this.game.sendYou(p); return; }
    }
    const lead = this.station(s, Math.max(0, s.spd) * GEO.KN_TO_MS * 20, 0);   // aim 20 s ahead of the bow
    if (e.st === 'approach') {
      for (const u of e.units) this.moveUnit(u, lead.lat, lead.lon, ownKn, dt);
      if (dmin < 1500) { e.st = 'attack'; this.game.event(p, 'pirate', 'The skiffs are on you! Warning shots across the bow.'); this.volleyFx(e.units[0], 'warning'); this.game.sendYou(p); }
      return;
    }
    // attack: stay on the quarters, fire, board
    e.alongside = 0;
    const comply = e.comply > 0, hose = this.now < e.hose.until;
    e.units.forEach((u, i) => {
      const side = (i % 2 ? -1 : 1) * (e.citadel ? 30 : 38 + i * 6);
      const q = hose ? destination(s.lat, s.lon, normDeg(s.hdg + 180), 400) : this.station(s, -25 - i * 12, side);
      const d = haversine(u.lat, u.lon, s.lat, s.lon);
      this.moveUnit(u, q.lat, q.lon, d > 300 ? ownKn : Math.max(6, spd + 5), dt);
      if (d < HOSTILE.BOARD_ALONGSIDE_M * 1.5) e.alongside++;
      if (!comply && !e.citadel && !hose && d <= WEAPONS.small_arms.rangeM && e.age >= u.nextFire) this.fire(e, u, p, 'small_arms', d);
    });
    if (e.citadel) {
      if (e.age - e.citadel > HOSTILE.CITADEL_MAX_S) { this.game.event(p, 'pirate', 'The citadel door gives way. Pirates in the engine room.'); return this.resolveBoarding(e, p, 'board'); }
      return;
    }
    if (comply) {
      if (e.alongside > 0) e.comply += dt;
      if (e.comply > HOSTILE.COMPLY_S) return this.resolveBoarding(e, p, 'comply');
      return;
    }
    if (e.alongside > 0 && spd <= HOSTILE.BOARD_MAX_KN && !hose) {
      e.board += dt * e.alongside / HOSTILE.BOARD_S;
      if (!e.boardMsg) { e.boardMsg = true; this.game.event(p, 'pirate', 'Grappling hooks and a ladder on the rail: they are trying to board! Fire hose (H), citadel, speed up, or comply.'); this.game.sendYou(p); }
      if (e.board >= 1) return this.resolveBoarding(e, p, 'board');
    } else if (e.alongside > 0 && spd > HOSTILE.BOARD_MAX_KN) e.board = Math.max(0, e.board - dt / HOSTILE.BOARD_S);
  }
  resolveBoarding(e, p, how) {
    const pol = this.game.politics, ds = this.ds, area = ds?.areaById?.[e.areaId];
    const v = pol?.vesselOf(p) || p;
    let kind;
    if (how === 'board' && this.guardsActive(p, e.areaId) && this.rnd() < HOSTILE.GUARD_REPEL) kind = 'repelled';
    else {
      const mix = { ...(area?.kinds || { robbery: 1 }) }; delete mix.repelled;
      if (how === 'comply' && mix.hijack) mix.hijack *= 0.5;
      const tot = Object.values(mix).reduce((a, b) => a + b, 0) || 1;
      for (const k of Object.keys(mix)) mix[k] /= tot;
      kind = pickShare(mix, this.rnd());
    }
    if (pol && area) pol.piracy(p, v, area, kind, `at ${p.ship.lat.toFixed(2)}°, ${p.ship.lon.toFixed(2)}°`);
    else this.game.event(p, 'pirate', 'Pirates boarded and left.');
    if (kind === 'hijack') {
      let lost = 0;
      for (const c of p.cargo) if (!c.jobId && c.qty > 0) { const k = Math.round(c.qty * HOSTILE.HIJACK_CARGO_LOSS * 10) / 10; c.qty = Math.round((c.qty - k) * 10) / 10; lost += k; }
      p.cargo = p.cargo.filter((c) => c.qty > 0);
      if (lost > 0) this.game.event(p, 'pirate', `The pirates took ${fmt(lost)} t of cargo before they left. Crew safe.`);
    }
    this.finish(e, p); this.game.sendYou(p);
    return kind;
  }

  // ------------------------------------------------------------------------------------------ fire and damage
  /** One volley from `u` at the ship. Returns the hull points taken (after the 1 % floor logic). */
  fire(e, u, p, weapon, rangeM) {
    const W = WEAPONS[weapon];
    u.nextFire = e.age + W.volleyS;
    u.fireAt = Date.now(); u.fireKind = weapon;
    const C = SHIP_CLASSES[p.ship.cls] || SHIP_CLASSES.coaster;
    const pts = damageFor(weapon, rangeM, this.rnd(), this.rnd(), C.displacement);
    u.fireKind = pts > 0 ? 'hit' : 'splash';
    if (!(pts > 0)) return 0;
    for (const o of e.units) o.ident = true;
    return this.applyHit(e, p, pts);
  }
  volleyFx(u, kind) { u.fireAt = Date.now(); u.fireKind = kind; }
  applyHit(e, p, pts) {
    const auto = isAutoSailed(p), before = p.cond, floor = auto ? 1 : 0;
    p.cond = Math.max(floor, before - pts);
    const took = Math.round((before - p.cond) * 10) / 10;
    const who = e.faction === 'pirate' ? 'Small-arms fire' : 'Naval gunfire';
    if (took > 0) this.game.event(p, e.faction === 'pirate' ? 'pirate' : 'law', `${who} hits the hull: −${took} % (${Math.round(p.cond)} % left). Crew safe.`, { dedupe: true });
    const area = this.ds?.areaById?.[e.areaId];
    if (e.faction === 'navy' && area?.kind === 'war_risk' && took > 0) this.game.politics?.hostileClaim(p, area, { points: took });
    if (p.cond <= 0 && !auto) { if (!this.sinking.has(p.id)) this.sinkByAttack(e, p, area, before); return took; }
    if (auto && p.cond <= 1) this.handsUp(e, p);
    return took;
  }
  /** A ship under automatic sailing taken to 1 %: the crew stops, hands up, the attacker takes over (R11). Never sunk. */
  handsUp(e, p) {
    if (e.handsUp) return; e.handsUp = true;
    const s = p.ship; s.throttle = 0; s.spd = 0;
    this.game.event(p, e.faction === 'pirate' ? 'pirate' : 'law', 'The hull is nearly gone: your crew stops the engine and raises their hands. The ship is being taken. Crew safe.');
    if (e.faction === 'pirate') this.resolveBoarding(e, p, 'comply');
    else { e.st = 'inspect'; e.inspectT = 0; }
  }
  /** The hand-sailed ship takes her last hit: existing sink flow with a clear message (R11, R12). */
  sinkByAttack(e, p, area, condBefore) {
    const pirate = e.faction === 'pirate', cls = SHIP_CLASSES[p.ship.cls]?.name || 'ship';
    const by = pirate ? 'pirates' : 'naval gunfire';
    const s = p.ship;
    const txt = `Your ${cls.toLowerCase()} was sunk by ${by}${p.jobs.length ? ` with ${p.jobs.length} contract(s)` : ''}. The crew is in the life raft; a rescue craft is on its way. Cargo is in a wreck you can salvage.`;
    const news = `${p.name}'s ${cls} was sunk by ${by} at ${s.lat.toFixed(2)}, ${s.lon.toFixed(2)}. Crew rescued by the coast guard.`;
    if (!pirate && area?.kind === 'war_risk') this.game.politics?.hostileClaim(p, area, { loss: true, cond: condBefore });
    this.game.politics?.record(p, 'loss', news, { areaId: e.areaId || null });
    this.stats.sunk++;
    p.cond = 0; p.flooding = Math.max(p.flooding, 0.5);
    this.endFor(p.id, false);
    this.riskOf(p).lastEnc = this.now;
    this.game.event(p, 'warn', 'The hull is breached! She is listing and going down: abandon ship!');
    this.game.sendYou(p);
    // she goes down over SINK_S seconds in plain view (list, smoke, bow dips), then the existing sink flow runs
    this.sinking.set(p.id, { p, txt, news, left: HOSTILE.SINK_S });
  }
  stepSinking(dt) {
    for (const [pid, x] of [...this.sinking]) {
      const { p } = x; x.left -= dt;
      if (!p.online || p.rescue || p.docked) { this.sinking.delete(pid); if (p.cond <= 0 && !p.rescue && p.flooding < 1) { p.flooding = 1; } continue; }
      p.flooding = Math.min(0.98, 0.5 + 0.48 * (1 - Math.max(0, x.left) / HOSTILE.SINK_S));
      if (x.left <= 0) { this.sinking.delete(pid); p.flooding = 1; this.game.sink(p, 'hostile', x.txt, x.news); }
    }
  }

  // ------------------------------------------------------------------------------------------ navy
  stepNavy(e, p, dt, dmin) {
    const s = p.ship, u = e.units[0], K = KINDS[u.k], spd = Math.abs(s.spd), W = WEAPONS[K.weapon];
    const label = `${K.name} ${e.name}`;
    const d = haversine(u.lat, u.lon, s.lat, s.lon);
    const night = isNight(s.lat, s.lon, this.now);
    if (!u.ident && d < identRangeM(night) * 3) { for (const o of e.units) o.ident = true; this.game.event(p, 'law', `${label}: grey hull, gun forward. Naval vessel.`); }
    const area = this.ds?.areaById?.[e.areaId];
    if (e.st === 'approach') {
      this.moveUnit(u, s.lat, s.lon, K.kn, dt);
      if (d < HOSTILE.HAIL_M) {
        e.st = 'hail'; e.hailT = 0;
        const g = e.grounds;
        if (g) this.game.event(p, 'law', `${label} on channel 16: "Vessel ${p.name}, this is naval patrol ${e.name}. Your ship ${g.text}. Heave to for inspection within ${HOSTILE.HEAVE_TO_S} seconds."`);
        else this.game.event(p, 'law', `${label} on channel 16: "Vessel ${p.name}, this is naval patrol ${e.name}. You are in a listed area. State your cargo and destination."`);
        this.game.sendYou(p);
      }
      return;
    }
    if (e.st === 'hail') {
      e.hailT += dt;
      const g = e.grounds;
      const q = this.station(s, -400, 500);
      this.moveUnit(u, q.lat, q.lon, d > 1500 ? K.kn : Math.max(6, spd + 4), dt);
      if (!g || g.kind === 'denied_zone' && e.warnN >= 2) {
        // clean ship: shadow, then carry on
        e.quiet += dt;
        if (e.quiet > 60) { this.game.event(p, 'law', `${label}: "Thank you, ${p.name}. Carry on${g ? ' and keep to the corridor' : ''}."`); this.finish(e, p); this.game.sendYou(p); }
        return;
      }
      if (spd <= HOSTILE.HEAVE_TO_KN && d > 1500) return;   // she has stopped: the patrol closes in before the search starts
      if (spd <= HOSTILE.HEAVE_TO_KN) { e.st = 'inspect'; e.inspectT = 0; this.game.event(p, 'law', `${label} comes alongside. Boarding party inspecting.`); this.game.sendYou(p); return; }
      const t0 = HOSTILE.HEAVE_TO_S;
      if (e.warnN === 0 && e.hailT > t0) { e.warnN = 1; this.game.event(p, 'law', `${label}: "Final warning. Stop your engine or we will fire."`); }
      else if (e.warnN === 1 && e.hailT > t0 + HOSTILE.WARN_GAP_S) { e.warnN = 2; this.volleyFx(u, 'warning'); this.game.event(p, 'law', `${label} fires a warning shot across your bow. Splash 100 m ahead.`); }
      else if (e.warnN === 2 && e.hailT > t0 + 2 * HOSTILE.WARN_GAP_S) {
        if (this.fireEligible(g, area)) { e.st = 'fire'; e.ceaseT = 0; this.game.event(p, 'law', `${label} opens fire. Heave to now (under ${HOSTILE.HEAVE_TO_KN} kn) or surrender to end it.`); this.game.sendYou(p); }
        else e.warnN = 3;   // no grounds for force: the ladder ends here
      }
      return;
    }
    if (e.st === 'fire') {
      const q = this.station(s, -Math.min(W.rangeM * 0.5, 1800), 700);
      this.moveUnit(u, q.lat, q.lon, d > W.rangeM * 0.8 ? K.kn : Math.max(8, spd + 6), dt);
      e.ceaseT = spd <= HOSTILE.HEAVE_TO_KN ? e.ceaseT + dt : 0;
      if (e.ceaseT > 8) { e.st = 'inspect'; e.inspectT = 0; this.game.event(p, 'law', `${label}: ceasefire. Boarding party coming alongside.`); this.game.sendYou(p); return; }
      if (d <= W.rangeM && e.age >= u.nextFire) this.fire(e, u, p, K.weapon, d);
      return;
    }
    if (e.st === 'inspect') {
      if (d > 600) { const q0 = this.station(s, 0, 150); this.moveUnit(u, q0.lat, q0.lon, K.kn, dt); return; }   // closing in first: the clock starts when she lies alongside
      if (e.units.length < 2 && !e.rib) { e.rib = true; e.units.push(this.makeUnit(e, 'rib', { lat: u.lat, lon: u.lon }, u.hdg)); e.units[1].ident = true; this.game.event(p, 'law', `${label} lowers a rigid boat: the boarding party is coming across.`); }
      const rb = e.units[1]; if (rb) { const bq = this.station(s, -5, 18); this.moveUnit(rb, bq.lat, bq.lon, KINDS.rib.kn, dt); }
      const q = this.station(s, 0, 120);
      this.moveUnit(u, q.lat, q.lon, Math.max(1, spd), dt);
      e.inspectT += dt;
      if (e.inspectT >= HOSTILE.INSPECT_S) this.resolveInspection(e, p, label);
    }
  }
  resolveInspection(e, p, label) {
    const g = e.grounds, pol = this.game.politics, v = pol?.vesselOf(p) || p;
    const seize = [];
    if (g && (g.kind === 'contraband' || g.kind === 'sanctioned')) {
      for (const c of p.cargo) if (c.qty > 0 && (c.contraband || (g.kind === 'sanctioned' && c.good === g.good && (c.origin || null) === (g.origin || null)))) seize.push(c);
    }
    if (seize.length) {
      let value = 0; for (const c of seize) value += c.qty * (GOODS[c.good]?.base || 0);
      const fine = Math.min(Math.max(0, num(p.money, 0)), Math.max(HOSTILE.FINE_MIN, Math.round(HOSTILE.FINE_MULT * value)));
      p.cargo = p.cargo.filter((c) => !seize.includes(c));
      const ids = new Set(seize.map((c) => c.jobId).filter(Boolean));
      p.jobs = p.jobs.filter((j) => !(ids.has(j.id) || (j.contraband && seize.some((c) => c.contraband))));
      if (pol) pol.charge(p, fine, 'fees', v); else p.money -= fine;
      p.stats.caught++;
      const txt = `${label} seized ${seize.map((c) => `${fmt(c.qty)} t ${GOODS[c.good]?.name || c.good}`).join(', ')}: ${g.text}. Fine ${fmt(fine)} cr. Crew safe.`;
      this.game.event(p, 'law', txt); pol?.record(p, 'seizure', txt, { areaId: e.areaId });
    } else this.game.event(p, 'law', `${label}: papers and holds in order. Thank you for your cooperation.`);
    const [a, b] = HOSTILE.DETAIN_H, h = Math.round(a + this.rnd() * (b - a));
    if (v && h > 0) { v.held = { until: this.now + h * 3600, why: 'detention', areaId: e.areaId || null }; this.game.event(p, 'law', `The search delays you: held for ${h} h.`); }
    this.finish(e, p); this.game.sendYou(p);
  }

  // ------------------------------------------------------------------------------------------ friendly patrol
  stepFriend(e, p, dt, dmin) {
    const s = p.ship, u = e.units[0], K = KINDS[u.k], spd = Math.abs(s.spd);
    u.ident = true;
    const pirates = this.attackerOf(e.pid);
    if (e.st === 'respond') {
      const tgt = pirates && pirates.faction === 'pirate' && pirates.units.length ? pirates.units[0] : s;
      this.moveUnit(u, tgt.lat, tgt.lon, K.kn, dt);
      const dp = haversine(u.lat, u.lon, s.lat, s.lon);
      if (dp < HOSTILE.FLEE_M || (pirates && pirates.units.length && haversine(u.lat, u.lon, pirates.units[0].lat, pirates.units[0].lon) < HOSTILE.FLEE_M)) {
        if (pirates && pirates.faction === 'pirate' && pirates.st !== 'leave') { pirates.st = 'flee'; this.finish(pirates, p); this.game.event(p, 'law', `The naval patrol ${e.name} drives the skiffs off. "Stay on this course, we will escort you."`); }
        else this.game.event(p, 'law', `The naval patrol ${e.name} has joined you and will escort for a while.`);
        e.st = 'escort'; e.age = 0; this.game.sendYou(p);
      }
      return;
    }
    if (e.st === 'escort') {
      const q = this.station(s, 0, 600);
      this.moveUnit(u, q.lat, q.lon, Math.max(4, spd + 2), dt);
      if (e.age > HOSTILE.ESCORT_S) { this.game.event(p, 'law', `The naval patrol ${e.name} leaves you: "Safe passage."`); e.st = 'leave'; this.game.sendYou(p); }
    }
  }
  callNavy(p, via = 'button') {
    const r = this.riskOf(p), enc = this.attackerOf(p.id);
    if (!r.on) return false;
    if (!enc) { this.game.event(p, 'info', 'VHF: nobody is threatening you. No patrol dispatched.'); return false; }
    if (enc.faction === 'navy') { this.game.event(p, 'info', 'VHF: the vessel challenging you is a naval patrol. Heave to or surrender to end it.'); return false; }
    if (this.friendOf(p.id)) { this.game.event(p, 'info', 'VHF: a naval patrol is already on its way.'); return false; }
    if (this.now - enc.navyCalledAt < HOSTILE.NAVY_CALL_GAP_S) { this.game.event(p, 'info', 'VHF: the maritime security centre has your call. Hold on.'); return false; }
    enc.navyCalledAt = this.now;
    const presence = NAVY_PRESENCE[enc.areaId] ?? NAVY_PRESENCE_DEFAULT;
    if (this.rnd() < presence) {
      const f = this.spawnFriend(p, enc, 'patrol');
      if (f) {
        const eta = Math.max(1, Math.round(HOSTILE.NAVY_CALL_DIST_M / (KINDS.patrol.kn * GEO.KN_TO_MS) / 60));
        this.game.event(p, 'law', `VHF (${via}): the regional maritime security centre diverts the naval patrol ${f.name}. ETA about ${eta} min. Keep your speed up.`);
        this.game.sendYou(p); return true;
      }
    }
    this.game.event(p, 'warn', 'VHF: the maritime security centre acknowledges, but no patrol is within reach. You are on your own.');
    return false;
  }
  /** Hook for a MAYDAY / DSC distress from server/vhf.js. */
  onDistress(p) { if (p.risk?.on && this.attackerOf(p.id)) this.callNavy(p, 'distress call'); }

  // ------------------------------------------------------------------------------------------ player actions
  onAction(p, m) {
    const a = m.action;
    if (a === 'risk_set') { this.setRisk(p, !!m.on); return true; }
    if (!String(a).startsWith('hostile_')) return null;
    const enc = this.attackerOf(p.id), g = this.game;
    if (a === 'hostile_debug') {   // SALTLINE_DEBUG=1 only (like debug_sea / debug_econ): force an encounter now, caps and rates ignored
      if (process.env.SALTLINE_DEBUG !== '1') { g.event(p, 'warn', `Unknown action ${a}`); return true; }
      if (m.kind === 'rescue_fast') { for (const r of g.rescues) if (r.playerId === p.id) { r.started = Date.now(); r.eta = r.started + 40000; if (p.rescue) p.rescue.eta = r.eta; } return true; }
      this.endFor(p.id, true); this.riskOf(p).on = true;
      const ds = this.ds, d = this.dangerAt(p.ship.lat, p.ship.lon);
      if (m.kind === 'navy') {
        const area = d.war || ds.areaById['jwc-redsea-aden'], e = this.spawnNavy(p, area, this.groundsOf(p, area)), at = e && this.placeAt(p.ship, 5200, p.ship.hdg, 60);
        if (at) { e.units[0].lat = at.lat; e.units[0].lon = at.lon; }   // close enough to hail within a minute
      }
      else this.spawnPirates(p, d.piracy || ds.areaById['piracy-gog'], this.preyOf(p), {}, false);
      return true;
    }
    if (a === 'hostile_navy') { this.callNavy(p, 'VHF'); return true; }
    if (!enc || (enc.st === 'leave')) { g.event(p, 'info', 'Nobody is attacking you.'); return true; }
    const pirate = enc.faction === 'pirate';
    switch (a) {
      case 'hostile_surrender':
        if (pirate) { if (!enc.comply) { enc.comply = 0.001; enc.st = 'attack'; g.event(p, 'pirate', 'You raise your hands and stop firing back. The skiffs come alongside.'); } }
        else { enc.st = 'inspect'; enc.inspectT = 0; g.event(p, 'law', `You heave to and surrender. ${KINDS[enc.units[0].k].name} ${enc.name}: "Ceasefire. Stand by for boarding."`); }
        break;
      case 'hostile_pay': {
        if (!pirate) { g.event(p, 'info', 'The navy takes no payment. Heave to or surrender.'); break; }
        const v = g.politics?.vesselOf(p) || p, cost = ransomFor(hullValue(p.ship.cls, num(v.cond, p.cond)));
        if (p.money < cost) { g.event(p, 'warn', `The release payment is ${fmt(cost)} cr (3 % of the hull value). You have ${fmt(p.money)}.`); break; }
        if (g.politics) g.politics.charge(p, cost, 'costs', v); else p.money -= cost;
        g.event(p, 'pirate', `You pay ${fmt(cost)} cr release money (ransom) over the radio. The skiffs turn away. Crew safe.`);
        g.politics?.record(p, 'piracy', `Paid ${fmt(cost)} cr to end an attack.`, { areaId: enc.areaId });
        this.finish(enc, p); break;
      }
      case 'hostile_cargo': {
        if (!pirate) { g.event(p, 'info', 'The navy does not take cargo. Heave to or surrender.'); break; }
        const free = p.cargo.filter((c) => !c.jobId && c.qty > 0);
        if (!free.length) { g.event(p, 'warn', 'You have no free cargo to hand over (contract cargo is not yours to give).'); break; }
        const out = [];
        for (const c of free) { const k = Math.round(c.qty * HOSTILE.CARGO_HANDOVER * 10) / 10; c.qty = Math.round((c.qty - k) * 10) / 10; out.push(`${fmt(k)} t ${GOODS[c.good]?.name || c.good}`); }
        p.cargo = p.cargo.filter((c) => c.qty > 0);
        g.event(p, 'pirate', `You throw ${out.join(', ')} over to the skiffs. They take it and leave. Crew safe.`);
        this.finish(enc, p); break;
      }
      case 'hostile_hose': {
        if (!pirate) { g.event(p, 'info', 'A fire hose does nothing against a warship.'); break; }
        const h = enc.hose;
        if (h.uses >= HOSTILE.HOSE_USES) { g.event(p, 'warn', 'The hoses are out of pressure: no more water.'); break; }
        if (enc.age - h.last < HOSTILE.HOSE_GAP_S) { g.event(p, 'warn', 'The crew is still reeling in the hose. Wait a moment.'); break; }
        h.uses++; h.last = enc.age; h.until = this.now + 20; enc.board = 0;
        g.event(p, 'pirate', `Fire hoses on full pressure sweep the rail. The skiffs sheer off (${HOSTILE.HOSE_USES - h.uses} use(s) left).`);
        if (enc.units.length > 1 && this.rnd() < 0.35) { enc.units.pop(); g.event(p, 'pirate', 'One skiff gives up and heads home.'); }
        break;
      }
      case 'hostile_citadel':
        if (!pirate) { g.event(p, 'info', 'There is no citadel against a warship. Heave to or surrender.'); break; }
        if (!enc.citadel) {
          enc.citadel = enc.age; enc.board = Math.min(enc.board, 0.5);
          g.event(p, 'pirate', 'The crew withdraws to the citadel and the engine room is locked. The navy is being called.');
          this.callNavy(p, 'citadel');
        }
        break;
      default: return null;
    }
    g.sendYou(p);
    return true;
  }

  // ------------------------------------------------------------------------------------------ express passage (R13)
  expressCheck(p, pts, speedKn) {
    const out = { incidents: [] };
    if (this.spawnBlock(p, { express: true }) || !this.ds || !pts?.length) return out;
    const s = p.ship, ex = routeExposure(this.ds, { lat: s.lat, lon: s.lon }, pts, speedKn, this.now), pol = this.game.politics, v = pol.vesselOf(p);
    let used = false;
    for (const x of ex.areas) {
      if (used || this.attacksToday(p) >= HOSTILE.MAX_ATTACKS_PER_DAY) break;
      const a = this.ds.areaById[x.id], hours = x.km / (Math.max(1, speedKn) * 1.852);
      if (a.kind === 'piracy') {
        const prey = this.preyOf(p, speedKn);
        if (!(prey > 0) || this.guardsActive(p, a.id) && this.rnd() > 0.5) continue;
        if (this.rnd() < rollP(pirateRatePerH(a, prey) * 0.5, hours * 3600)) {
          this.countAttack(p); used = true;
          const kind = pickShare(a.kinds || { robbery: 1 }, this.rnd());
          out.incidents.push(pol.piracy(p, v, a, kind, `in ${a.name}`));
          this.riskOf(p).lastEnc = this.now;
        }
      } else if (a.kind === 'war_risk' && a.tier >= 3) {
        const g = this.groundsOf(p, a);
        if (g && (g.kind === 'contraband' || g.kind === 'sanctioned') && this.rnd() < 0.5) {
          this.countAttack(p); used = true;
          const e = this.newEnc(p, 'navy', 'hostile', a, { grounds: g, name: NAVY_NAMES[Math.floor(this.rnd() * NAVY_NAMES.length)] });
          e.units.push(this.makeUnit(e, 'patrol', { lat: s.lat, lon: s.lon }, 0));
          this.game.event(p, 'law', `A naval patrol stops your express passage in ${a.name}.`);
          this.resolveInspection(e, p, `Naval patrol ${e.name}`);
          this.removeEnc(e);
          out.incidents.push({ kind: 'search', areaId: a.id });
        }
      }
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------ wire
  publicList() {
    const out = [];
    const nowMs = Date.now();
    for (const [e, u] of this.units()) {
      const o = { id: u.id, k: u.k, f: e.role === 'friend' ? 'friend' : e.faction, lat: r6(u.lat), lon: r6(u.lon), hdg: Math.round(u.hdg), spd: Math.round(u.spd * 10) / 10, st: e.st, ident: !!u.ident };
      if (e.board > 0 || (e.comply > 0 && e.alongside > 0) || (e.st === 'inspect' && e.inspectT > 8)) o.bd = 1;   // a boarding party is on deck
      if (u.k === 'rib') o.name = 'Naval boarding boat';
      else if (u.ident) o.name = e.role === 'friend' ? `${KINDS[u.k].name} ${e.name}` : e.faction === 'navy' ? `${KINDS[u.k].name} ${e.name}` : labelOf(u);
      if (u.fireAt && nowMs - u.fireAt < 1500) { o.fire = u.fireKind || 'splash'; o.fireAge = nowMs - u.fireAt; }
      out.push(o);
    }
    return out;
  }
  /** `you.risk` / `you.hostile` for the skipper's own state. */
  youView(p) {
    const r = this.riskOf(p), t = this.now;
    const risk = { on: r.on, today: this.attacksToday(p), max: HOSTILE.MAX_ATTACKS_PER_DAY, cooldown: Math.max(0, Math.round(Math.max(r.last > 0 ? r.last + HOSTILE.RESPAWN_COOLDOWN_S - t : 0, r.lastEnc > 0 ? r.lastEnc + HOSTILE.ENCOUNTER_GAP_S - t : 0))) };
    const e = this.attackerOf(p.id), f = this.friendOf(p.id);
    let hostile = null;
    if (e && e.units.length) {
      const u = e.units[0], s = p.ship, pirate = e.faction === 'pirate', K = KINDS[u.k];
      const v = this.game.politics?.vesselOf(p) || p, area = this.ds?.areaById?.[e.areaId];
      hostile = {
        f: e.faction, st: e.st, label: labelOf({ ...u, role: 'hostile' }), ident: !!u.ident, n: e.units.length,
        dist: Math.round(haversine(u.lat, u.lon, s.lat, s.lon)), brg: Math.round(bearing(s.lat, s.lon, u.lat, u.lon)),
        board: pirate ? Math.round(clamp(e.board, 0, 1) * 100) / 100 : 0, citadel: !!e.citadel, comply: e.comply > 0,
        ransom: pirate ? ransomFor(hullValue(p.ship.cls, num(v.cond, p.cond))) : 0, hose: pirate ? HOSTILE.HOSE_USES - e.hose.uses : 0,
        area: area?.name || null, navyCalled: !!f || (e.navyCalledAt > 0),
        demand: !pirate && e.grounds ? e.grounds.text : null, name: !pirate && u.ident ? `${K.name} ${e.name}` : null,
        left: !pirate && e.st === 'hail' && e.grounds ? Math.max(0, Math.round(HOSTILE.HEAVE_TO_S - e.hailT)) : null,
      };
    }
    return { risk, hostile, escort: f && f.st === 'escort' ? { name: f.name, left: Math.max(0, Math.round(HOSTILE.ESCORT_S - f.age)) } : null };
  }
}
