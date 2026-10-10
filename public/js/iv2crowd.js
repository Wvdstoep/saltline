// Interiors v2 — the living guests and crew of a cruise ship in walk mode (docs/CRUISE-CONTRACT.md §6). iv2crowdplan.js decides who
// is where and when (pure, deterministic from the ship's seed and the ship's clock); this file only draws it: one instanced mesh
// per pose (≤ 11 on a desktop, 6 on a phone), per-instance colours picked in the shader, at most CROWD.max people within
// CROWD.radius of the player, built room by room as the player comes near and dropped again when they leave. Nothing here
// touches the server; walkers use the same WalkMap as the player (A* on its standAt).
import * as THREE from 'three';
import { ITEMS } from './iv2items.js';
import { cruiseProfile } from '../../shared/ships/cruiseprofile.js';
import { budgetFor, PARTS, posesFor, drawnPose, crowdForRoom, roamersFor, kindOfRoom, findPath, pathLen, agentPose, react, selectAgents, localHour, soundMix, hashStr, hash01, rngOf } from './iv2crowdplan.js';

const REFRESH = 0.6;        // s between looks at which rooms are near enough to need people
const MAX_ROOMS = 14;       // rooms with people kept built at a time
const PATH_PER_TICK = 2;    // A* runs per refresh
const WATER_ABOVE = (item) => Math.max(0.2, (ITEMS[item]?.h || 0.5) - 0.2);   // swimmers: shoulders above the water the pool shape draws

/** Geometry of one pose: a box per PARTS entry (positions, normals, indices, aPart). */
export function poseGeometry(pose) {
  const boxes = PARTS[pose] || PARTS.stand, n = boxes.length;
  const pos = new Float32Array(n * 24 * 3), nor = new Float32Array(n * 24 * 3), part = new Float32Array(n * 24), idx = new Uint16Array(n * 36);
  const M = new THREE.Matrix4();
  boxes.forEach(([p, w, h, d, x, y, z, rx, hang], b) => {
    const bg = new THREE.BoxGeometry(w, h, d);
    if (hang) bg.translate(0, -h / 2, 0);
    M.makeRotationX(rx).setPosition(x, y, z); bg.applyMatrix4(M);
    pos.set(bg.attributes.position.array, b * 72); nor.set(bg.attributes.normal.array, b * 72); part.fill(p, b * 24, b * 24 + 24);
    for (let k = 0; k < 36; k++) idx[b * 36 + k] = bg.index.array[k] + b * 24;
    bg.dispose();
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); g.setAttribute('aPart', new THREE.BufferAttribute(part, 1));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.userData.tris = n * 12;
  return g;
}

const ATTRS = ['iSkin', 'iHair', 'iTop', 'iLeg', 'iArm'];
function crowdMaterial(U) {
  const m = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });   // winding is not relied on: a person is closed anyway, and a phone saves nothing by culling
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uCrowdLit = U.uCrowdLit;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>
      attribute float aPart; attribute float iLit; attribute vec3 iSkin, iHair, iTop, iLeg, iArm; uniform float uCrowdLit; varying vec3 vCrowd;`)
      .replace('#include <color_vertex>', `#include <color_vertex>
      vec3 pc = aPart < 0.5 ? iSkin : aPart < 1.5 ? iHair : aPart < 2.5 ? iTop : aPart < 3.5 ? iLeg : aPart < 4.5 ? iArm : vec3(0.78);
      vec3 wn = normalize(mat3(instanceMatrix) * normal);
      vCrowd = pc * (0.6 + 0.28 * wn.y + 0.12 * abs(wn.z)) * iLit * uCrowdLit;`);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vCrowd;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = vCrowd;');
  };
  m.customProgramCacheKey = () => 'iv2crowd';
  return m;
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _c = new THREE.Color();

export class CruiseCrowd {
  /** I = the interior, plan = the v2 plan, root = the group the people live in. opts: { phone }. */
  constructor(I, plan, root, opts = {}) {
    this.I = I; this.plan = plan; this.phone = !!opts.phone;
    this.budget = budgetFor(this.phone);
    const cls = I.app?.you?.ship?.cls || I.builtCls;
    const prof = cruiseProfile(cls) || { guests: 800, crew: 400, seed: 1 };
    this.guests = prof.guests; this.crew = prof.crew; this.seed = (prof.seed ^ hashStr(cls || '')) >>> 0;
    this.group = new THREE.Group(); this.group.name = 'iv2:crowd'; root.add(this.group);
    this.U = { uCrowdLit: { value: 1 } };
    this.mat = crowdMaterial(this.U);
    this.meshes = new Map();
    const cap = this.budget.max;
    for (const pose of posesFor(this.phone)) {
      const geo = poseGeometry(pose);
      geo.setAttribute('iLit', new THREE.InstancedBufferAttribute(new Float32Array(cap), 1));
      for (const a of ATTRS) geo.setAttribute(a, new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3));
      const mesh = new THREE.InstancedMesh(geo, this.mat, cap);
      mesh.name = `iv2:crowd:${pose}`; mesh.count = 0; mesh.frustumCulled = false; mesh.userData.pose = pose;
      this.group.add(mesh); this.meshes.set(pose, mesh);
    }
    this.byRoom = new Map();   // room id → props
    for (const p of plan.props || []) if (p.t === 'k2' && p.room) { let l = this.byRoom.get(p.room); if (!l) this.byRoom.set(p.room, l = []); l.push(p); }
    this.rooms = new Map();    // room id → { room, hour, agents, pending }
    this.t = 0; this.acc = REFRESH; this.hourKey = -1;
    this.agents = []; this.poses = []; this.stats = { people: 0, drawn: 0, calls: 0, tris: 0, rooms: 0, hour: 0 };
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
      if (p.pose === 'swim') p.y = a.y + WATER_ABOVE(a.item) + p.bob - 0.05;
      else p.y += p.bob;
      const dx0 = p.x - px, dz0 = p.z - pz;
      if (dx0 * dx0 + dz0 * dz0 < 100) {   // within 10 m: react to the player
        const r = react(a, p, px, pz);
        if (r.slow < 1) a.s0 -= dt * (a.speed || 1) * (1 - r.slow);
        p = { ...p, x: p.x + r.dx, z: p.z + r.dz, yaw: r.yaw };
      }
      poses[i] = p;
    }
    const sel = selectAgents(agents, poses, px, pz, py, this.budget);
    const counts = new Map(), near = {};
    for (const m of this.meshes.values()) m.count = 0;
    for (const i of sel) {
      const a = agents[i], p = poses[i];
      if (Math.hypot(p.x - px, p.z - pz) < 0.5) continue;   // not through the player's eyes
      const mesh = this.meshes.get(drawnPose(a, p.pose, this.phone)); if (!mesh) continue;
      const k = mesh.count; if (k >= this.budget.max) continue;
      const L = a.look, sc = L.h * (a.look.kid ? 1 : 1);
      _q.setFromAxisAngle(_up, p.yaw); _p.set(p.x, p.y, p.z); _s.set(L.w * sc, sc, L.w * sc * 0.92);
      _m.compose(_p, _q, _s); mesh.setMatrixAt(k, _m);
      if (!a.col) {
        a.col = new Float32Array(15);
        const c = (hex, o) => { _c.setHex(hex); a.col[o] = _c.r; a.col[o + 1] = _c.g; a.col[o + 2] = _c.b; };
        c(L.skin, 0); c(L.hair, 3); c(L.top, 6); c(L.shorts ? (a.role === 'swim' ? L.bottom : L.skin) : L.bottom, 9); c(L.sleeves ? L.skin : L.top, 12);
        a.lit = this.rooms.get(a.room)?.room.dark ? 0.55 : 1;
      }
      const g = mesh.geometry;
      g.attributes.iSkin.array.set(a.col.subarray(0, 3), k * 3); g.attributes.iHair.array.set(a.col.subarray(3, 6), k * 3); g.attributes.iTop.array.set(a.col.subarray(6, 9), k * 3);
      g.attributes.iLeg.array.set(a.col.subarray(9, 12), k * 3); g.attributes.iArm.array.set(a.col.subarray(12, 15), k * 3); g.attributes.iLit.array[k] = a.lit;
      mesh.count = k + 1; counts.set(mesh, (counts.get(mesh) || 0) + 1);
      if (Math.hypot(p.x - px, p.z - pz) < 12) near[a.mode] = (near[a.mode] || 0) + 1;
    }
    let calls = 0, tris = 0, drawn = 0;
    for (const m of this.meshes.values()) {
      const g = m.geometry, on = m.count > 0 || m.userData.was;
      m.visible = m.count > 0;
      if (on) { m.instanceMatrix.needsUpdate = true; for (const n of [...ATTRS, 'iLit']) g.attributes[n].needsUpdate = true; }
      m.userData.was = m.count > 0;
      if (m.count > 0) { calls++; tris += m.count * g.userData.tris; drawn += m.count; }
    }
    this.stats.drawn = drawn; this.stats.calls = calls; this.stats.tris = tris;
    // the light the people stand in: follows the v2 light mode (lights on, daylight)
    const U = I.v2?.U; this.U.uCrowdLit.value = U ? Math.min(1.1, 0.5 + 0.42 * U.uLights.value + 0.25 * U.uDay.value) : 0.9;
    this.near = near;
    if (!this.nextMix || t > this.nextMix) { this.nextMix = t + 0.5; const room = I.curRoom; this.mix = soundMix(kindOfRoom(room || {}) || '', this.stats.hour, near); }
  }

  /** What to play: { murmur, music, splash, kind } (iv2crowdsound in sound.js reads it). */
  sound() { return this.mix; }

  dispose() {
    for (const m of this.meshes.values()) m.geometry.dispose();
    this.mat.dispose();
    this.group.parent?.remove(this.group);
    this.meshes.clear(); this.rooms.clear(); this.agents = []; this.poses = []; this.byRoom.clear(); this.queue = [];
  }
}

/** Does this plan get a crowd? Cruise ships on the v2 interiors only. */
export const wantsCrowd = (plan) => !!plan && plan.v === 2 && plan.gen === 'cruise';
void hash01;
