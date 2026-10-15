// Interiors v2 — the living guests and crew of a cruise ship in walk mode (docs/CRUISE-CONTRACT.md §6). iv2crowdplan.js decides who
// is where and when (pure, deterministic from the ship's seed and the ship's clock); this file only draws it, through the shared
// people system (people.js): two instanced meshes — the nearest few at LOD0 (≈ 2k triangles), the rest at LOD1 (≈ 0.5k) — animated
// from a vertex animation texture (walk / sit / clap / dance / lie / swim / tray / idle clips, frames blended, heads turning), dressed
// from the clothing atlas (faces, hair, holiday clothes, crew uniforms). At most CROWD.max people within CROWD.radius of the player,
// built room by room as the player comes near and dropped again when they leave. Nothing here touches the server; walkers use the
// same WalkMap as the player (A* on its standAt).
import * as THREE from 'three';
import { ITEMS } from './iv2items.js';
import { cruiseProfile } from '../../shared/ships/cruiseprofile.js';
import { budgetFor, drawnPose, crowdForRoom, roamersFor, kindOfRoom, findPath, pathLen, agentPose, react, selectAgents, localHour, soundMix, hashStr, rngOf } from './iv2crowdplan.js';
import { PeopleCrowd, PEOPLE_U, lookFromPlan } from './people.js';

const REFRESH = 0.6;        // s between looks at which rooms are near enough to need people
const MAX_ROOMS = 14;       // rooms with people kept built at a time
const PATH_PER_TICK = 2;    // A* runs per refresh
const WATER_ABOVE = (item) => Math.max(0.2, (ITEMS[item]?.h || 0.5) - 0.2);   // swimmers: shoulders above the water the pool shape draws
/** people drawn at LOD0 (the nearest; the rest at LOD1) */
export const HI_COUNT = Object.freeze({ desk: 12, phone: 4 });
const STRIDE = 1.4;         // m walked per gait cycle

/** The clip and phase (0…1) of the people system for a planned pose (iv2crowdplan agentPose / drawnPose). */
export function clipOf(a, pose, t) {
  const ph = a.phase || 0, k = ph / 6.283;
  switch (pose) {
    case 'walkA': case 'walkB': case 'tray': {
      const s = (a.s0 || 0) + t * (a.speed || 1);
      return [pose === 'tray' ? 'tray' : 'walk', s / STRIDE];
    }
    case 'sit': return ['sit', t * 0.18 + k];
    case 'clapA': case 'clapB': return ['clap', t * 2.6 + k];
    case 'danceA': case 'danceB': return ['dance', t * 0.5 + k];
    case 'lie': return ['lie', t * 0.15 + k];
    case 'swim': return ['swim', t * 0.42 + k];
    default: return a.mode === 'play' ? ['dance', t * 0.5 + k] : ['idle', t * 0.22 + k];
  }
}

export class CruiseCrowd {
  /** I = the interior, plan = the v2 plan, root = the group the people live in. opts: { phone }. */
  constructor(I, plan, root, opts = {}) {
    this.I = I; this.plan = plan; this.phone = !!opts.phone;
    this.budget = budgetFor(this.phone);
    const cls = I.app?.you?.ship?.cls || I.builtCls;
    const prof = cruiseProfile(cls) || { guests: 800, crew: 400, seed: 1 };
    this.guests = prof.guests; this.crew = prof.crew; this.seed = (prof.seed ^ hashStr(cls || '')) >>> 0;
    this.group = new THREE.Group(); this.group.name = 'iv2:crowd'; root.add(this.group);
    this.U = { uCrowdLit: PEOPLE_U.uLit };
    const cap = this.budget.max, hiN = Math.min(cap, this.phone ? HI_COUNT.phone : HI_COUNT.desk);
    this.hi = new PeopleCrowd(hiN, { lod: 0, lit: 'basic', name: 'iv2:crowd:hi' });
    this.lo = new PeopleCrowd(cap, { lod: 1, lit: 'basic', name: 'iv2:crowd:lo' });
    this.hi.mesh.userData.pose = 'hi'; this.lo.mesh.userData.pose = 'lo';
    this.group.add(this.hi.mesh, this.lo.mesh);
    this.meshes = new Map([['hi', this.hi.mesh], ['lo', this.lo.mesh]]);
    this.byRoom = new Map();   // room id → props
    for (const p of plan.props || []) if (p.t === 'k2' && p.room) { let l = this.byRoom.get(p.room); if (!l) this.byRoom.set(p.room, l = []); l.push(p); }
    this.rooms = new Map();    // room id → { room, hour, agents, pending }
    this.t = 0; this.acc = REFRESH; this.hourKey = -1;
    this.agents = []; this.poses = []; this.stats = { people: 0, drawn: 0, calls: 0, tris: 0, rooms: 0, hour: 0, hi: 0, lo: 0 };
    this.mix = soundMix('', 12, {}); this.near = {};
    this.queue = [];
  }

  hourNow() {
    const app = this.I.app, t = app.shipTimeNow ? app.shipTimeNow() : app.simTime;
    return localHour(t, app.ship?.lon ?? app.you?.lon ?? 0);
  }
  ctx(hour, room) { return { seed: this.seed, hour, guests: this.guests, crew: this.crew, props: this.byRoom.get(room.id) || [] }; }

  /** Rooms within reach of the player get people (and lose them again when far). */
  refresh(px, pz, py, hour) {
    const R = this.budget.radius + 4, hk = Math.floor(hour);
    if (hk !== this.hourKey) { this.hourKey = hk; this.rooms.clear(); this.queue.length = 0; }
    const near = [];
    for (const room of this.plan.rooms) {
      if (!kindOfRoom(room)) continue;
      const dy = room.y - py; if (dy < -3.2 || dy > 3.5) continue;
      const dx = px < room.x0 ? room.x0 - px : px > room.x1 ? px - room.x1 : 0, dz = pz < room.z0 ? room.z0 - pz : pz > room.z1 ? pz - room.z1 : 0, d = Math.hypot(dx, dz);
      if (d <= R) near.push([d, room]);
    }
    near.sort((a, b) => a[0] - b[0]);
    const keep = new Set();
    for (const [, room] of near.slice(0, MAX_ROOMS)) {
      keep.add(room.id);
      if (this.rooms.has(room.id)) continue;
      const ctx = this.ctx(hour, room), still = crowdForRoom(room, ctx), roam = roamersFor(room, ctx);
      this.rooms.set(room.id, { room, agents: still.concat(roam) });
      for (const a of roam) this.queue.push({ a, room });
    }
    for (const id of [...this.rooms.keys()]) if (!keep.has(id)) this.rooms.delete(id);
    this.agents = []; for (const r of this.rooms.values()) for (const a of r.agents) this.agents.push(a);
    this.queue = this.queue.filter((q) => this.rooms.has(q.room.id));
    this.stats.rooms = this.rooms.size; this.stats.people = this.agents.length; this.stats.hour = hour;
  }

  /** Give up to PATH_PER_TICK walkers their route (A* on the player's walk map, two places in the room, not too far apart). */
  routes() {
    const map = this.I.map; if (!map) return;
    for (let n = 0; n < PATH_PER_TICK && this.queue.length; n++) {
      const { a, room } = this.queue.shift(), rnd = rngOf(hashStr(a.seedKey || a.id)), y = room.y;
      const free = (x, z) => map.standAt(x, z, y) != null;
      const pick = (cx, cz, span) => {
        for (let i = 0; i < 14; i++) {
          const x = cx == null ? room.x0 + 0.6 + rnd() * Math.max(0.1, room.x1 - room.x0 - 1.2) : cx + (rnd() - 0.5) * 2 * span;
          const z = cz == null ? room.z0 + 0.6 + rnd() * Math.max(0.1, room.z1 - room.z0 - 1.2) : cz + (rnd() - 0.5) * 2 * span;
          if (x > room.x0 + 0.3 && x < room.x1 - 0.3 && z > room.z0 + 0.3 && z < room.z1 - 0.3 && free(x, z)) return { x, z };
        }
        return null;
      };
      const A = pick(null, null, 0); if (!A) { a.dead = true; continue; }
      const B = pick(A.x, A.z, a.mode === 'clean' ? 6 : 12); if (!B) { a.dead = true; continue; }
      const path = findPath(free, A, B, 0.5, 1800);
      if (!path || path.length < 2) { a.dead = true; continue; }
      const L = pathLen(path); a.path = path; a.cum = L.cum; a.total = L.total; a.y = y; a.s0 = rnd() * 2 * L.total; a.x = A.x; a.z = A.z; a.yaw = 0;
    }
  }

  frame(I, dt) {
    if (!I.group || !I.group.visible) return;
    dt = Math.min(0.1, dt || 0); this.t += dt;
    const px = I.pos.x, pz = I.pos.z, py = I.y;
    this.acc += dt;
    if (this.acc >= REFRESH) { this.acc = 0; this.refresh(px, pz, py, this.hourNow()); this.routes(); }
    const agents = this.agents, poses = this.poses; poses.length = agents.length;
    const t = this.t;
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      if (a.dead || ((a.mode === 'walk' || a.mode === 'tray' || a.mode === 'clean') && !a.path)) { poses[i] = null; continue; }
      let p = agentPose(a, t);
      if (p.pose === 'swim') p.y = a.y + WATER_ABOVE(a.item) + p.bob - 0.05;   // the clips carry the gait's own bob; only the water lifts swimmers
      const dx0 = p.x - px, dz0 = p.z - pz;
      if (dx0 * dx0 + dz0 * dz0 < 100) {   // within 10 m: react to the player
        const r = react(a, p, px, pz);
        if (r.slow < 1) a.s0 -= dt * (a.speed || 1) * (1 - r.slow);
        p = { ...p, x: p.x + r.dx, z: p.z + r.dz, yaw: r.yaw };
      }
      poses[i] = p;
    }
    const sel = selectAgents(agents, poses, px, pz, py, this.budget);   // nearest first
    const near = {};
    let nHi = 0, nLo = 0;
    for (const i of sel) {
      const a = agents[i], p = poses[i];
      const d = Math.hypot(p.x - px, p.z - pz);
      if (d < 0.5) continue;   // not through the player's eyes
      const crowd = nHi < this.hi.capacity ? this.hi : this.lo, k = crowd === this.hi ? nHi++ : nLo++;
      if (crowd === this.lo && k >= this.lo.capacity) continue;
      if (!a.pl) {
        a.pl = lookFromPlan(a.look, a.role, hashStr(a.id));
        a.lit = this.rooms.get(a.room)?.room.dark ? 0.55 : 1;
      }
      const L = a.pl, h = L.h, w = L.w * h;
      const [clip, phase] = clipOf(a, drawnPose(a, p.pose, false), t);
      const still = clip === 'idle' || clip === 'sit';
      const head = still ? 0.38 * Math.sin(t * 0.23 + (a.phase || 0) * 3) * Math.sin(t * 0.071 + (a.phase || 0)) : 0;
      crowd.set(k, p.x, p.y, p.z, p.yaw, [w, h, w * 0.95], L, clip, phase, head, a.lit);
      if (d < 12) near[a.mode] = (near[a.mode] || 0) + 1;
    }
    this.hi.commit(nHi); this.lo.commit(Math.min(nLo, this.lo.capacity));
    const calls = (this.hi.count > 0 ? 1 : 0) + (this.lo.count > 0 ? 1 : 0);
    this.stats.drawn = this.hi.count + this.lo.count; this.stats.calls = calls; this.stats.hi = this.hi.count; this.stats.lo = this.lo.count;
    this.stats.tris = this.hi.count * this.hi.tris + this.lo.count * this.lo.tris;
    // the light the people stand in: follows the v2 light mode (lights on, daylight)
    const U = I.v2?.U; this.U.uCrowdLit.value = U ? Math.min(1.1, 0.5 + 0.42 * U.uLights.value + 0.25 * U.uDay.value) : 0.9;
    this.near = near;
    if (!this.nextMix || t > this.nextMix) { this.nextMix = t + 0.5; const room = I.curRoom; this.mix = soundMix(kindOfRoom(room || {}) || '', this.stats.hour, near); }
  }

  /** What to play: { murmur, music, splash, kind } (iv2crowdsound in sound.js reads it). */
  sound() { return this.mix; }

  dispose() {
    this.hi.dispose(); this.lo.dispose();
    this.group.parent?.remove(this.group);
    this.meshes.clear(); this.rooms.clear(); this.agents = []; this.poses = []; this.byRoom.clear(); this.queue = [];
  }
}

/** Does this plan get a crowd? Cruise ships on the v2 interiors only. */
export const wantsCrowd = (plan) => !!plan && plan.v === 2 && plan.gen === 'cruise';
