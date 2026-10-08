// Walk map for the ship interior (docs/V5-PLAN.md items 6 + 7). Turns a deck plan (shipplan.js) into walkable
// rectangles, stair ramps and furniture footprints, and moves a walker through them forgivingly: it slides along
// walls, is funnelled into doorways and onto stairs it is heading for, and follows the stair ramp up and down.
// Pure (no three.js, no DOM) so the node tests drive exactly the code the game runs.
//
//   const map = new WalkMap(plan);
//   const st = { x, z, y };                      // ship frame, y = the floor the walker stands on
//   map.move(st, dx, dz)                         // → { moved, hit }   (st updated in place)
//   map.floorAt(x, z, y) / map.blocked(x, z, y) / map.roomAt(x, z, y) / map.stairAt(x, z, y)
//   map.cameraClamp(head, cam)                   // keeps a third-person camera out of walls
import { R, STEP } from './shipplan.js';

export const EXT = R + 0.35;      // a stair's walk band reaches this far past its foot and head onto the landings
const DOOR_X = R + 0.2;           // a doorway's walk band reaches this far into each room
const SUB = 0.07;                 // movement sub-step (m)
const CELL = 2;                   // spatial hash cell (m)

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const grow = (r, d) => ({ x0: r.x0 - d, x1: r.x1 + d, z0: r.z0 - d, z1: r.z1 + d });
export function rectMinus(r, holes) {
  let rects = [r];
  for (const h of holes) {
    const next = [];
    for (const q of rects) {
      const ix0 = Math.max(q.x0, h.x0), ix1 = Math.min(q.x1, h.x1), iz0 = Math.max(q.z0, h.z0), iz1 = Math.min(q.z1, h.z1);
      if (ix1 - ix0 <= 1e-6 || iz1 - iz0 <= 1e-6) { next.push(q); continue; }
      if (ix0 - q.x0 > 1e-6) next.push({ x0: q.x0, x1: ix0, z0: q.z0, z1: q.z1 });
      if (q.x1 - ix1 > 1e-6) next.push({ x0: ix1, x1: q.x1, z0: q.z0, z1: q.z1 });
      if (iz0 - q.z0 > 1e-6) next.push({ x0: ix0, x1: ix1, z0: q.z0, z1: iz0 });
      if (q.z1 - iz1 > 1e-6) next.push({ x0: ix0, x1: ix1, z0: iz1, z1: q.z1 });
    }
    rects = next;
  }
  return rects;
}
/** Height of a stair's ramp at z (clamped to its landings). */
export function rampY(s, z) {
  const t = s.up === 'n' ? (s.z1 - z) / (s.z1 - s.z0) : (z - s.z0) / (s.z1 - s.z0);
  return s.yLow + (s.yHigh - s.yLow) * clamp(t, 0, 1);
}
/** Where a stair starts (foot) and ends (head) along z, and which way is up. */
export function stairEnds(s) {
  const footZ = s.up === 'n' ? s.z1 : s.z0, headZ = s.up === 'n' ? s.z0 : s.z1;
  return { footZ, headZ, upDir: Math.sign(headZ - footZ), cx: (s.x0 + s.x1) / 2 };
}
/** The floor under a stair in its foot room, grown by the walker radius on the sides and the high end. */
function underStair(s) {
  return s.up === 'n' ? { x0: s.x0 - R, x1: s.x1 + R, z0: s.z0 - R, z1: s.z1 } : { x0: s.x0 - R, x1: s.x1 + R, z0: s.z0, z1: s.z1 + R };
}

export class WalkMap {
  constructor(plan) {
    this.plan = plan;
    this.rects = []; this.portals = []; this.walls = [];
    this.solids = plan.solids || [];
    const rooms = new Map(plan.rooms.map((r) => [r.id, r]));
    this.roomsById = rooms;
    // rooms: inset from their walls (or rails), minus floor holes, nested rooms and the space under stairs
    for (const r of plan.rooms) {
      if (r.walk === false) continue;
      const base = { x0: r.x0 + r.inset.w, x1: r.x1 - r.inset.e, z0: r.z0 + r.inset.n, z1: r.z1 - r.inset.s };
      const excl = r.floorHoles.map((h) => grow(h, R));
      for (const s of plan.stairs) { // the floor under a stair is not walkable on its foot level (whichever room that is)
        if (Math.abs(r.y - s.yLow) < 0.05 && r.x0 < s.x1 && r.x1 > s.x0 && r.z0 < s.z1 + R && r.z1 > s.z0 - R) excl.push(underStair(s));
      }
      for (const q of rectMinus(base, excl)) if (q.x1 - q.x0 > 0.02 && q.z1 - q.z0 > 0.02) this.rects.push({ ...q, y: r.y, ramp: null, room: r, door: null });
    }
    // doorways: a band through the opening into both rooms
    for (const d of plan.doors) {
      const a = rooms.get(d.a); if (!a) continue;
      const hw = d.w / 2 - R; if (hw <= 0.04) continue;
      if (d.side === 'n' || d.side === 's') {
        const zc = d.side === 'n' ? a.z0 : a.z1;
        this.rects.push({ x0: d.at - hw, x1: d.at + hw, z0: zc - DOOR_X, z1: zc + DOOR_X, y: d.y, ramp: null, room: null, door: d });
        this.portals.push({ x: d.at, z: zc, nx: 0, nz: 1, tx: 1, tz: 0, half: hw, y: d.y, door: d });
      } else {
        const xc = d.side === 'w' ? a.x0 : a.x1;
        this.rects.push({ x0: xc - DOOR_X, x1: xc + DOOR_X, z0: d.at - hw, z1: d.at + hw, y: d.y, ramp: null, room: null, door: d });
        this.portals.push({ x: xc, z: d.at, nx: 1, nz: 0, tx: 0, tz: 1, half: hw, y: d.y, door: d });
      }
    }
    // stairs: a band between the stringers, from the foot landing to the head landing
    for (const s of plan.stairs) {
      const w = s.x1 - s.x0, rs = Math.min(R, Math.max(0.05, (w - 0.3) / 2));
      this.rects.push({ x0: s.x0 + rs, x1: s.x1 - rs, z0: s.z0 - EXT, z1: s.z1 + EXT, y: s.yLow, ramp: s, room: null, door: null });
      const { footZ, headZ, cx } = stairEnds(s), half = w / 2 - rs;
      this.portals.push({ x: cx, z: footZ, nx: 0, nz: 1, tx: 1, tz: 0, half, y: s.yLow, stair: s });
      this.portals.push({ x: cx, z: headZ, nx: 0, nz: 1, tx: 1, tz: 0, half, y: s.yHigh, stair: s });
    }
    this.index();
    this.buildWalls();
  }

  // ------------------------------------------------------------------ spatial hash
  index() {
    this.grid = new Map(); this.sgrid = new Map();
    const add = (g, r, item) => {
      for (let i = Math.floor(r.x0 / CELL); i <= Math.floor(r.x1 / CELL); i++) for (let j = Math.floor(r.z0 / CELL); j <= Math.floor(r.z1 / CELL); j++) {
        const k = i * 100003 + j; let l = g.get(k); if (!l) { l = []; g.set(k, l); } l.push(item);
      }
    };
    for (const r of this.rects) add(this.grid, r, r);
    for (const s of this.solids) add(this.sgrid, grow(s, R), s);
  }
  cell(g, x, z) { return g.get(Math.floor(x / CELL) * 100003 + Math.floor(z / CELL)) || []; }

  // ------------------------------------------------------------------ queries
  /** The walkable floor at (x, z) closest to yRef within `tol` (null if none). */
  floorAt(x, z, yRef, tol = STEP) {
    let best = null, bd = tol + 1e-9;
    for (const r of this.cell(this.grid, x, z)) {
      if (x < r.x0 || x > r.x1 || z < r.z0 || z > r.z1) continue;
      const y = r.ramp ? rampY(r.ramp, z) : r.y;
      const d = Math.abs(y - yRef);
      if (d < bd) { bd = d; best = y; }
    }
    return best;
  }
  /** Inside a furniture / machinery footprint (grown by the walker radius) that overlaps the body at floor y. */
  blocked(x, z, y) {
    for (const s of this.cell(this.sgrid, x, z)) {
      if (x > s.x0 - R && x < s.x1 + R && z > s.z0 - R && z < s.z1 + R && s.y < y + 1.7 && s.y + s.h > y + 0.08) return true;
    }
    return false;
  }
  /** A place the walker can stand: floor within reach and no furniture. */
  standAt(x, z, yRef, tol = STEP) { const y = this.floorAt(x, z, yRef, tol); return y != null && !this.blocked(x, z, y) ? y : null; }
  /** The stair whose ramp the walker is on (between foot and head), or null. */
  stairAt(x, z, y) {
    for (const s of this.plan.stairs) if (x >= s.x0 && x <= s.x1 && z > s.z0 + 0.02 && z < s.z1 - 0.02 && Math.abs(rampY(s, z) - y) < 0.3) return s;
    return null;
  }
  /** Horizontal speed factor on a ramp (walking up a steep stair is slower along the deck). */
  speedFactor(x, z, y) { const s = this.stairAt(x, z, y); if (!s) return 1; const k = (s.yHigh - s.yLow) / (s.z1 - s.z0); return 1 / Math.sqrt(1 + k * k); }
  /** The room the walker is in (the smallest one containing the point at that height). */
  roomAt(x, z, y) {
    let best = null, ba = Infinity;
    for (const r of this.plan.rooms) {
      if (x < r.x0 - 0.01 || x > r.x1 + 0.01 || z < r.z0 - 0.01 || z > r.z1 + 0.01) continue;
      if (y < r.y - 0.35 || y > r.y + Math.max(1.0, r.h - 0.3)) continue;
      const a = (r.x1 - r.x0) * (r.z1 - r.z0) + (r.walk === false ? 1e6 : 0) + Math.abs(y - r.y) * 50;
      if (a < ba) { ba = a; best = r; }
    }
    return best;
  }

  // ------------------------------------------------------------------ movement
  /** Move by (dx, dz) in sub-steps; slides along walls and funnels into doorways / onto stairs. */
  move(st, dx, dz) {
    const len = Math.hypot(dx, dz);
    if (len < 1e-9) return { moved: 0, hit: false };
    const n = Math.max(1, Math.ceil(len / SUB)), sx = dx / n, sz = dz / n;
    let moved = 0, hit = false;
    for (let i = 0; i < n; i++) {
      const p = this.step(st, sx, sz);
      if (p <= 0) { hit = true; break; }
      if (p < 0.99) hit = true;
      moved += (len / n) * p;
    }
    return { moved, hit };
  }
  step(st, sx, sz) {
    const inside = this.blocked(st.x, st.z, st.y); // spawned / teleported into furniture: let the walker out
    const tryAt = (x, z) => { const y = this.floorAt(x, z, st.y); if (y == null) return null; if (!inside && this.blocked(x, z, y)) return null; return y; };
    const L2 = sx * sx + sz * sz, L = Math.sqrt(L2);
    const accept = (cx, cz, minProg) => {
      if (Math.abs(cx) + Math.abs(cz) < 1e-9) return 0;
      const prog = (cx * sx + cz * sz) / L2;
      if (prog < minProg) return 0;
      const y = tryAt(st.x + cx, st.z + cz);
      if (y == null) return 0;
      st.x += cx; st.z += cz; st.y = y;
      return Math.max(prog, 0.05);
    };
    let p = accept(sx, sz, -1); if (p) return 1;
    // funnel: heading into the wall beside a doorway or the stringers beside a stair → slide toward the opening
    const f = this.funnel(st, sx, sz, L);
    if (f) {
      p = accept(f[0], f[1], -1); if (p) return Math.max(p, 0.3);
      // already alongside a stairwell (came at the stair head / foot at an angle): step back toward its mouth instead
      if (f.length > 2) { p = accept(f[2], f[3], -1) || accept(f[4], f[5], -1); if (p) return 0.3; }
    }
    // pushing (nearly) straight at an edge or corner: look up to 0.4 m to either side for where the way opens
    const ax = Math.abs(sx), az = Math.abs(sz);
    const round = () => {
      const px = -sz / L, pz = sx / L;
      for (let k = 1; k <= 8; k++) {
        for (const sg of [1, -1]) {
          const ox = px * sg * 0.05 * k, oz = pz * sg * 0.05 * k;
          const y1 = tryAt(st.x + ox, st.z + oz); if (y1 == null) continue;
          const y2 = this.floorAt(st.x + ox + sx, st.z + oz + sz, y1);
          if (y2 == null || (!inside && this.blocked(st.x + ox + sx, st.z + oz + sz, y2))) continue;
          let ok = true; // the sideways path itself must be clear
          for (let j = 1; j < k && ok; j++) if (tryAt(st.x + px * sg * 0.05 * j, st.z + pz * sg * 0.05 * j) == null) ok = false;
          if (!ok) continue;
          const m = Math.min(0.05 * k, 0.6 * L);
          const y = tryAt(st.x + px * sg * m, st.z + pz * sg * m); if (y == null) continue;
          st.x += px * sg * m; st.z += pz * sg * m; st.y = y;
          return 0.05;
        }
      }
      return 0;
    };
    const nearAxis = Math.min(ax, az) / L < 0.3;
    if (nearAxis) { p = round(); if (p) return p; }
    // slide along whatever stopped us (at least a third of walking pace, so door jambs are rounded)
    const cands = ax >= az ? [[sx, 0], [0, sz]] : [[0, sz], [sx, 0]];
    for (const [cx, cz] of cands) {
      const c = Math.abs(cx) + Math.abs(cz); if (c < 1e-9) continue;
      const k = Math.max(c, 0.35 * L) / c;
      p = accept(cx * k, cz * k, 0.01); if (p) return p;
    }
    for (const a of [0.45, 0.8, 1.1]) {
      const c = Math.cos(a);
      for (const sg of [1, -1]) {
        const ca = Math.cos(sg * a), sa = Math.sin(sg * a);
        p = accept((sx * ca - sz * sa) * c, (sx * sa + sz * ca) * c, 0.12); if (p) return p;
      }
    }
    return nearAxis ? 0 : round();
  }
  funnel(st, sx, sz, L) {
    let best = null, bd = Infinity;
    for (const pt of this.portals) {
      if (Math.abs(pt.y - st.y) > 0.45) continue;
      const dx = st.x - pt.x, dz = st.z - pt.z;
      const dn = dx * pt.nx + dz * pt.nz, dt = dx * pt.tx + dz * pt.tz;
      if (Math.abs(dn) > 1.3 || Math.abs(dt) > pt.half + (pt.stair ? 0.8 : 0.65)) continue; // within reach of the opening
      const vn = (sx * pt.nx + sz * pt.nz) / L;
      if (vn * Math.sign(dn || 1) > -0.5) continue;             // must be heading toward the opening's plane
      if (Math.abs(dt) <= pt.half * 0.8) continue;               // already lined up: something else is in the way
      if (((sx * pt.tx + sz * pt.tz) / L) * -Math.sign(dt) < -0.15) continue; // steering away from it: not this one
      // only openings the walker is actually heading for: the point half a metre through it lies within ±62°
      const tx = pt.x - pt.nx * Math.sign(dn || 1) * 0.5 - st.x, tz = pt.z - pt.nz * Math.sign(dn || 1) * 0.5 - st.z, tl = Math.hypot(tx, tz) || 1;
      const aim = (tx * sx + tz * sz) / (tl * L);
      if (aim < 0.47) continue;
      // further out to the side of a stair (came at it at an angle) only when heading almost straight for it (±25°),
      // so walkers passing by a stairwell are not pulled onto it
      if (pt.stair && Math.abs(dt) > pt.half + 0.4 && aim < 0.9) continue;
      const d = Math.abs(dn) + Math.abs(dt);
      if (d < bd) { bd = d; best = { pt, dt }; }
    }
    if (!best) return null;
    const { pt, dt } = best, s = -Math.sign(dt);
    if (!pt.stair) return [pt.tx * s * L, pt.tz * s * L];
    // stairs: also a step toward the mouth (the centre line, just clear of the stairwell on the walker's side), for a
    // walker already beside the stairwell where the purely sideways step is blocked (else straight back onto the landing)
    const se = stairEnds(pt.stair), side = pt.y === pt.stair.yHigh ? se.upDir : -se.upDir, k = EXT - 0.2; // landing side
    const mx = pt.x + pt.nx * side * k + pt.tx * clamp(dt, -pt.half, pt.half) - st.x, mz = pt.z + pt.nz * side * k + pt.tz * clamp(dt, -pt.half, pt.half) - st.z;
    const ml = Math.hypot(mx, mz) || 1;
    return [pt.tx * s * L, pt.tz * s * L, (mx / ml) * L, (mz / ml) * L, pt.nx * side * L, pt.nz * side * L];
  }

  // ------------------------------------------------------------------ camera
  buildWalls() {
    const doorsOf = new Map();
    for (const d of this.plan.doors) {
      const a = this.roomsById.get(d.a), b = d.b ? this.roomsById.get(d.b) : null;
      const opp = { n: 's', s: 'n', e: 'w', w: 'e' }[d.side];
      for (const [room, side] of [[a, d.side], [b, opp]]) {
        if (!room) continue;
        const k = room.id + ':' + side; let l = doorsOf.get(k); if (!l) { l = []; doorsOf.set(k, l); } l.push(d);
      }
    }
    for (const r of this.plan.rooms) {
      if (r.open) continue;
      const top = r.y + r.h + 0.12;
      const sides = { n: [r.x0, r.x1, r.z0, 'x'], s: [r.x0, r.x1, r.z1, 'x'], w: [r.z0, r.z1, r.x0, 'z'], e: [r.z0, r.z1, r.x1, 'z'] };
      for (const [side, [a, b, c, ax]] of Object.entries(sides)) {
        if (!r.walls[side]) continue;
        let segs = [{ x0: a, x1: b, z0: 0, z1: 0 }];
        const seg = (s0, s1, y0, y1) => this.walls.push(ax === 'x' ? { ax: s0, az: c, bx: s1, bz: c, y0, y1 } : { ax: c, az: s0, bx: c, bz: s1, y0, y1 });
        for (const d of doorsOf.get(r.id + ':' + side) || []) {
          segs = rectMinus1D(segs, d.at - d.w / 2, d.at + d.w / 2);
          if (r.y + d.h < top - 0.02) seg(d.at - d.w / 2, d.at + d.w / 2, r.y + d.h, top); // the lintel over the doorway
        }
        for (const s of segs) if (s.x1 - s.x0 >= 0.02) seg(s.x0, s.x1, r.y, top);
      }
    }
  }
  /** Pull a third-person camera in front of the first wall between the head and it, and under ceilings. */
  cameraClamp(head, cam, yFeet) {
    const dx = cam.x - head.x, dz = cam.z - head.z, dy = cam.y - head.y, len = Math.hypot(dx, dz, dy);
    let tHit = 1;
    for (const w of this.walls) {
      const t = segHit(head.x, head.z, dx, dz, w);
      if (t == null || t >= tHit) continue;
      const y = head.y + dy * t;
      if (y < w.y0 - 0.05 || y > w.y1) continue;
      tHit = t;
    }
    // stairs (the space under and just above the treads) and tall furniture block the camera too
    for (let i = 1; i <= 12; i++) {
      const ti = (tHit * i) / 12, x = head.x + dx * ti, y = head.y + dy * ti, z = head.z + dz * ti;
      let blockedHere = false;
      for (const st of this.plan.stairs) {
        if (x < st.x0 - 0.05 || x > st.x1 + 0.05 || z < st.z0 || z > st.z1) continue;
        if (y > st.yLow - 0.3 && y < rampY(st, z) + 0.35) { blockedHere = true; break; }
      }
      // (with a margin: a camera skimming a console panel or an engine casing would see nothing but that surface)
      if (!blockedHere) for (const sd of this.cell(this.sgrid, x, z)) if (sd.h >= 1.2 && x > sd.x0 - 0.15 && x < sd.x1 + 0.15 && z > sd.z0 - 0.15 && z < sd.z1 + 0.15 && y > sd.y && y < sd.y + sd.h + 0.25) { blockedHere = true; break; }
      if (blockedHere) { tHit = (tHit * (i - 1)) / 12; break; }
    }
    let t = tHit < 1 ? Math.max(0, tHit - 0.22 / Math.max(len, 1e-6)) : 1;
    const out = { x: head.x + dx * t, y: head.y + dy * t, z: head.z + dz * t };
    // ceiling / floor of the room the camera ends up in
    let room = null;
    for (const r of this.plan.rooms) {
      if (r.open || out.x < r.x0 || out.x > r.x1 || out.z < r.z0 || out.z > r.z1) continue;
      if (out.y < r.y - 0.5 || out.y > r.y + r.h + 0.6) continue;
      if (!room || Math.abs(r.y - yFeet) < Math.abs(room.y - yFeet)) room = r;
    }
    if (room) out.y = clamp(out.y, room.y + 0.35, room.y + room.h - 0.15);
    else out.y = Math.max(out.y, yFeet + 0.45);
    return out;
  }
}

function rectMinus1D(segs, a, b) {
  const out = [];
  for (const s of segs) {
    if (b <= s.x0 || a >= s.x1) { out.push(s); continue; }
    if (a > s.x0) out.push({ ...s, x1: a });
    if (b < s.x1) out.push({ ...s, x0: b });
  }
  return out;
}
/** Parameter t ∈ (0, 1) where the ray (ox, oz) + t·(dx, dz) crosses an axis-aligned wall segment, or null. */
function segHit(ox, oz, dx, dz, w) {
  if (w.az === w.bz) { // wall along x at z = az
    if (Math.abs(dz) < 1e-9) return null;
    const t = (w.az - oz) / dz; if (t <= 1e-4 || t >= 1) return null;
    const x = ox + dx * t; return x >= Math.min(w.ax, w.bx) && x <= Math.max(w.ax, w.bx) ? t : null;
  }
  if (Math.abs(dx) < 1e-9) return null;
  const t = (w.ax - ox) / dx; if (t <= 1e-4 || t >= 1) return null;
  const z = oz + dz * t; return z >= Math.min(w.az, w.bz) && z <= Math.max(w.az, w.bz) ? t : null;
}
