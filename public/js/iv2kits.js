// Interiors v2 — furnishing kits (docs/INTERIORS-V2-CONTRACT.md §3.2–3.3, §5.1, Lane K). Pure: no three.js, no DOM.
//
// A Placer owns a 0.1 m occupancy grid of one room: solids already in the plan (machinery, consoles), stairs and their
// landings, ladder ends, cuts, the door approaches and every hotspot's standing point are kept clear. Each placement is
// checked for the walker (radius R): every door, stair end, ladder and hotspot of the room stays connected, so the walk
// suites hold with the denser furniture. Kits place their "must" items in order (circulation first, then wall-bound,
// then free-standing), then fill the biggest empty disc until the space's fill band and emptyR (§2.1) hold, then dress
// the walls (signs, boards, extinguishers, lights). Items become `k2` props + solids (+ hotspots) in the plan.
//
//   furnishV2(P, room, ctx) → { fill, emptyR, items }
//   overheadRuns(P, room, ctx)  frames, deckhead stiffeners, pipes in ISO 14726 colours, cable trays, ducts (unlined)
//   roomLights(P, room, ctx)    fixtures (§5.1): practical, night mode, emergency, exit signs
import { ITEMS } from './iv2items.js';
import { SCALE } from '../../shared/ships/gaspace.js';
import { SYS_COLOR } from '../../shared/ships/gamach.js';

export const R = 0.25;
const C = 0.1;                 // grid cell (m)
const LAND = 1.0;              // stair landing kept clear (gaplan RULES.LAND)
const r2 = (v) => Math.round(v * 100) / 100;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const ROT = { n: 0, s: Math.PI, w: Math.PI / 2, e: -Math.PI / 2 };   // an item against wall X faces into the room

// ------------------------------------------------------------------------------------------------ the placer
export class Placer {
  constructor(P, room, ctx = {}) {
    this.P = P; this.r = room; this.ctx = ctx; this.y = room.y;
    this.x0 = room.x0; this.z0 = room.z0;
    const A = (room.x1 - room.x0) * (room.z1 - room.z0);
    this.c = ctx.cell || (A > 60 ? 0.2 : 0.1);
    this.nx = Math.max(1, Math.round((room.x1 - room.x0) / this.c)); this.nz = Math.max(1, Math.round((room.z1 - room.z0) / this.c));
    const N = this.nx * this.nz;
    this.solid = new Uint8Array(N); this.keep = new Uint8Array(N); this.block = new Uint8Array(N); this.near = new Uint16Array(N); this.mount = new Uint8Array(N);
    this.inset = new Uint8Array(N);
    this.items = []; this.targets = []; this.area = (room.x1 - room.x0) * (room.z1 - room.z0); this.footprint = 0;
    this.seed = ctx.seed ?? 1;
    this.doors = (room.doorList || []).map((d) => ({ ...d }));
    this.pocketOn = this.area <= 80 && room.zone !== 'er' && !String(room.space).startsWith('er_');
    this.init();
  }
  idx(i, j) { return j * this.nx + i; }
  ci(x) { return Math.floor((x - this.x0) / this.c + 1e-6); }
  cj(z) { return Math.floor((z - this.z0) / this.c + 1e-6); }
  rect(q, f) { const i0 = clamp(this.ci(q.x0 + 1e-4), 0, this.nx - 1), i1 = clamp(this.ci(q.x1 - 1e-4), 0, this.nx - 1), j0 = clamp(this.cj(q.z0 + 1e-4), 0, this.nz - 1), j1 = clamp(this.cj(q.z1 - 1e-4), 0, this.nz - 1); for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (f(this.idx(i, j), i, j) === false) return false; return true; }
  overlaps(q) { return q.x0 < this.r.x1 && q.x1 > this.r.x0 && q.z0 < this.r.z1 && q.z1 > this.r.z0; }
  init() {
    const r = this.r, P = this.P, y = this.y;
    // walls: the walker keeps R off them (door bands excepted)
    for (let j = 0; j < this.nz; j++) for (let i = 0; i < this.nx; i++) {
      const x = this.x0 + (i + 0.5) * this.c, z = this.z0 + (j + 0.5) * this.c;
      const ins = r.inset || { n: R, s: R, e: R, w: R };
      if (x < r.x0 + ins.w || x > r.x1 - ins.e || z < r.z0 + ins.n || z > r.z1 - ins.s) this.inset[this.idx(i, j)] = 1;
    }
    for (const d of this.doors) {
      const ns = d.side === 'n' || d.side === 's', hw = d.w / 2 - R;
      const c = { n: r.z0, s: r.z1, w: r.x0, e: r.x1 }[d.side], dir = { n: 1, s: -1, w: 1, e: -1 }[d.side];
      // the approach: no furniture within 1.0 m of the opening (± 0.3 m beside it); the walk band through it
      const ap = ns ? { x0: d.at - d.w / 2 - 0.3, x1: d.at + d.w / 2 + 0.3, z0: Math.min(c, c + dir * 1.05), z1: Math.max(c, c + dir * 1.05) } : { x0: Math.min(c, c + dir * 1.05), x1: Math.max(c, c + dir * 1.05), z0: d.at - d.w / 2 - 0.3, z1: d.at + d.w / 2 + 0.3 };
      this.rect(ap, (k) => { this.keep[k] = 1; });
      const band = ns ? { x0: d.at - hw, x1: d.at + hw, z0: Math.min(c, c + dir * (R + 0.25)), z1: Math.max(c, c + dir * (R + 0.25)) } : { x0: Math.min(c, c + dir * (R + 0.25)), x1: Math.max(c, c + dir * (R + 0.25)), z0: d.at - hw, z1: d.at + hw };
      this.rect(band, (k) => { this.inset[k] = 0; });
      this.targets.push(ns ? { x: d.at, z: c + dir * (R + 0.15) } : { x: c + dir * (R + 0.15), z: d.at });
      d.ap = ap;
    }
    // stairs and landings, ladders, cuts / floor holes
    for (const s of P.stairs) {
      if (s.yLow > y + 2.2 || s.yHigh < y - 0.1) continue;
      const q = { x0: s.x0 - 0.3, x1: s.x1 + 0.3, z0: s.z0 - LAND, z1: s.z1 + LAND };
      if (!this.overlaps(q)) continue;
      this.rect(q, (k) => { this.keep[k] = 1; });
      if (Math.abs(s.yLow - y) < 0.05 || Math.abs(s.yHigh - y) < 0.05) {
        const lowFoot = Math.abs(s.yLow - y) < 0.05, footZ = s.up === 'n' ? s.z1 : s.z0, headZ = s.up === 'n' ? s.z0 : s.z1, up = Math.sign(headZ - footZ);
        const pt = lowFoot ? { x: (s.x0 + s.x1) / 2, z: footZ - up * 0.5 } : { x: (s.x0 + s.x1) / 2, z: headZ + up * 0.5 };
        if (pt.x > r.x0 && pt.x < r.x1 && pt.z > r.z0 && pt.z < r.z1) this.targets.push(pt);
        // the floor under the flight is not walkable on its foot level
        if (lowFoot) this.rect({ x0: s.x0 - R, x1: s.x1 + R, z0: s.z0, z1: s.z1 }, (k) => { this.block[k] = 1; });
      }
      if (s.yLow < y - 0.05 && s.yHigh > y - 0.05 && s.yHigh <= y + 0.05) void 0;
      if (y > s.yLow + 0.2 && y <= s.yHigh + 0.05) this.rect({ x0: s.x0, x1: s.x1, z0: s.z0, z1: s.z1 }, (k) => { this.block[k] = 1; });   // stairwell opening
    }
    for (const q of P.reserved || []) { if (q.y0 > y + 2.2 || q.y1 < y - 0.1 || !this.overlaps(q)) continue; this.rect(q, (k) => { this.keep[k] = 1; }); }
    for (const l of P.links || []) for (const e of [l.a, l.b]) {
      if (Math.abs(e.y - y) > 0.1 || e.x < r.x0 || e.x > r.x1 || e.z < r.z0 || e.z > r.z1) continue;
      this.rect({ x0: e.x - 0.7, x1: e.x + 0.7, z0: e.z - 0.7, z1: e.z + 0.7 }, (k) => { this.keep[k] = 1; });
      this.targets.push({ x: e.x, z: e.z });
    }
    for (const c of [...(r.cuts || []), ...(r.floorHoles || [])]) this.rect({ x0: c.x0 - 0.3, x1: c.x1 + 0.3, z0: c.z0 - 0.3, z1: c.z1 + 0.3 }, (k, i, j) => { const x = this.x0 + (i + 0.5) * this.c, z = this.z0 + (j + 0.5) * this.c; if (x > c.x0 && x < c.x1 && z > c.z0 && z < c.z1) this.block[k] = 1; else this.keep[k] = 1; });
    for (const h of P.hotspots) {
      if (Math.abs(h.y - y) > 0.3 || h.x < r.x0 || h.x > r.x1 || h.z < r.z0 || h.z > r.z1) continue;
      this.rect({ x0: h.x - 0.55, x1: h.x + 0.55, z0: h.z - 0.55, z1: h.z + 0.55 }, (k) => { this.keep[k] = 1; });
      this.targets.push({ x: h.x, z: h.z });
    }
    for (const s of P.solidsNear(r.x0 - 0.5, r.x1 + 0.5, r.z0 - 0.5, r.z1 + 0.5)) {
      if (!(s.y < y + 1.7 && s.y + s.h > y + 0.05)) continue;
      if (!this.overlaps(s)) continue;
      this.stampSolid(s);
    }
    // targets that are not walkable to begin with are not this kit's to keep (v1 geometry), but stay furniture-free
    this.targets = this.targets.filter((t) => this.walkableAt(t.x, t.z));
    this.baseN = this.targets.length; this.groups = null;
    this.baseline();   // before anything is placed
    this.basePocket = 0; if (this.pocketOn) { this.connected(); this.basePocket = this.pocket(); }
  }
  /** Flood the walkable cells from cell s0; returns the stamp of the visited set. */
  flood(s0) {
    const N = this.nx * this.nz, seen = this.seen || (this.seen = new Uint32Array(N)); this.stamp = (this.stamp || 0) + 1; const st = this.stamp;
    if (!this.walkable(s0)) return st;
    const q = this.queue || (this.queue = new Int32Array(N)); let h = 0, t = 0; q[t++] = s0; seen[s0] = st;
    while (h < t) {
      const k = q[h++], i = k % this.nx, j = (k - i) / this.nx;
      if (i > 0 && seen[k - 1] !== st && this.walkable(k - 1)) { seen[k - 1] = st; q[t++] = k - 1; }
      if (i < this.nx - 1 && seen[k + 1] !== st && this.walkable(k + 1)) { seen[k + 1] = st; q[t++] = k + 1; }
      if (j > 0 && seen[k - this.nx] !== st && this.walkable(k - this.nx)) { seen[k - this.nx] = st; q[t++] = k - this.nx; }
      if (j < this.nz - 1 && seen[k + this.nx] !== st && this.walkable(k + this.nx)) { seen[k + this.nx] = st; q[t++] = k + this.nx; }
    }
    return st;
  }
  tcell(p) { return this.idx(clamp(this.ci(p.x), 0, this.nx - 1), clamp(this.cj(p.z), 0, this.nz - 1)); }
  /** The groups of targets connected inside this room before the kit placed anything (some meet only through a neighbour). */
  baseline() {
    if (this.groups) return this.groups;
    const groups = [], done = new Set();
    for (let a = 0; a < this.baseN; a++) {
      if (done.has(a)) continue;
      const st = this.flood(this.tcell(this.targets[a])), g = [];
      for (let b = a; b < this.baseN; b++) if (!done.has(b) && this.seen[this.tcell(this.targets[b])] === st) { g.push(b); done.add(b); }
      groups.push(g);
    }
    this.groups = groups;
    return groups;
  }
  stampSolid(q, v = 1) {
    this.rect(q, (k) => { this.solid[k] = v ? 1 : 0; });
    const m = R + 0.12;   // the walker's radius plus a margin: a lane must be ≥ 0.25 m wide at its centre line
    const g = { x0: q.x0 - m, x1: q.x1 + m, z0: q.z0 - m, z1: q.z1 + m };
    this.rect(g, (k) => { this.near[k] += v ? 1 : -1; });
  }
  walkable(k) { return !this.block[k] && !this.near[k] && !this.inset[k]; }
  walkableAt(x, z) { const i = this.ci(x), j = this.cj(z); if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return false; return this.walkable(this.idx(i, j)); }
  free(q, { ignoreKeep = false, ignoreLanes = false } = {}) {
    if (q.x0 < this.r.x0 - 1e-6 || q.x1 > this.r.x1 + 1e-6 || q.z0 < this.r.z0 - 1e-6 || q.z1 > this.r.z1 + 1e-6) return false;
    const L = this.lanes;
    return this.rect(q, (k) => !(this.solid[k] || this.block[k] || (!ignoreKeep && (this.keep[k] || (!ignoreLanes && L && L[k])))));
  }
  /** Every target (door bands, stair ends, ladders, hotspots) still reachable on foot: the baseline groups stay whole, and
   *  targets added since (hotspots of placed items) reach one of them. */
  connected() {
    const groups = this.groups || this.baseline();
    const reach = new Set(), sts = [];
    for (const g of groups) {
      if (!g.length) continue;
      const st = this.flood(this.tcell(this.targets[g[0]]));
      for (const b of g) if (this.seen[this.tcell(this.targets[b])] !== st) return false;
      for (let e = this.baseN; e < this.targets.length; e++) if (this.seen[this.tcell(this.targets[e])] === st) reach.add(e);
      if (this.pocketOn) this.markReach(st, sts.length === 0);
      sts.push(st);
    }
    for (let e = this.baseN; e < this.targets.length; e++) if (!reach.has(e) && (groups.length || !this.walkableAt(this.targets[e].x, this.targets[e].z))) return false;
    // no floor sealed off from the doors: walkable cells nobody reaches stay within what the room started with
    if (sts.length && this.pocketOn && this.pocket() > (this.basePocket ?? 0) + Math.ceil(0.5 / (this.c * this.c))) return false;
    return true;
  }
  markReach(st, first) {
    const N = this.nx * this.nz, m = this.reachM || (this.reachM = new Uint8Array(N));
    if (first) m.fill(0);
    for (let k = 0; k < N; k++) if (this.seen[k] === st) m[k] = 1;
  }
  /** Walkable cells not reached by the last connected() floods. */
  pocket() {
    const N = this.nx * this.nz, m = this.reachM; if (!m) return 0;
    let n = 0; for (let k = 0; k < N; k++) if (!m[k] && this.walkable(k)) n++;
    return n;
  }
  windowsBlocked(q, side, h) {
    if (h <= 1.05) return false;
    for (const w of this.r.windows || []) {
      if (w.side !== side) continue;
      const a = side === 'n' || side === 's' ? [q.x0, q.x1] : [q.z0, q.z1];
      const ov = Math.min(a[1], w.to) - Math.max(a[0], w.from);
      if (ov > 0.3 * (w.to - w.from)) return true;
    }
    return false;
  }
  /**
   * Commit one item: footprint q (ship frame), facing rot. opts: { h, solid, hot, front (clear depth), prop extras }.
   * Returns the record or null (blocked / would cut the walk).
   */
  put(id, q, rot, opts = {}) {
    const it = ITEMS[id] || {}, solidKind = opts.solid ?? it.solid ?? true;
    const roomH = (this.r.h ?? 2.4) - 0.05 - (opts.mount ?? it.mount ?? 0);
    const h = Math.min(opts.h ?? it.h ?? 1, Math.max(0.05, roomH));   // nothing pokes through the deckhead
    const isSolid = solidKind === true && h > 0.05;
    if (isSolid && !this.free(q, { ...opts, ignoreLanes: opts.ignoreLanes || this.softLanes })) return null;
    // the clear zone in front stays free of solids (for the item to be usable, and as circulation)
    const fd = opts.front ?? it.clear?.front ?? 0;
    const fz = fd > 0 ? frontRect(q, rot, fd) : null;
    if (isSolid && fz && !this.rect(clipTo(fz, this.r), (k) => !this.solid[k] && !this.block[k])) return null;
    let hot = null;
    if (opts.hot !== false && (opts.hot || it.hot)) {
      const hd = opts.hot || it.hot, p = frontPoint(q, rot, opts.hotDist ?? 0.6);
      hot = { kind: hd.kind, label: opts.hotLabel || hd.label, x: p.x, z: p.z, r: opts.hotR || 1.2 };
      if (!this.walkableAt(hot.x, hot.z)) { const p2 = frontPoint(q, rot, 0.85); hot.x = p2.x; hot.z = p2.z; if (!this.walkableAt(hot.x, hot.z)) return null; }
    }
    if (isSolid) {
      this.stampSolid(q);
      if (hot) this.targets.push({ x: hot.x, z: hot.z });
      if (!this.noCheck && !this.connected()) { this.stampSolid(q, 0); if (hot) this.targets.pop(); return null; }
      if (fz) this.rect(clipTo(fz, this.r), (k) => { this.keep[k] = 1; });
      this.footprint += (q.x1 - q.x0) * (q.z1 - q.z0);
    } else if (h > 0.05 && solidKind !== 'low') this.rect(q, (k) => { this.mount[k] = 1; });
    else if (hot) this.targets.push({ x: hot.x, z: hot.z });
    const cx = (q.x0 + q.x1) / 2, cz = (q.z0 + q.z1) / 2;
    const rec = { t: 'k2', item: id, x: r2(cx), y: r2(this.y + (opts.mount ?? it.mount ?? 0)), z: r2(cz), rotY: rot, w: r2(opts.w ?? it.w), d: r2(opts.d ?? it.d), h: r2(h), var: opts.var ?? ((this.seed + this.items.length * 7) % 4), room: this.r.id, ...(opts.prop || {}) };
    this.P.prop('k2', rec);
    if (isSolid) this.P.solid(q.x0, q.x1, q.z0, q.z1, this.y, Math.min(h, opts.solidH ?? h), id);
    if (hot) { this.P.hot(hot.kind, hot.label, hot.x, this.y, hot.z, hot.r); if (isSolid) this.rect({ x0: hot.x - 0.3, x1: hot.x + 0.3, z0: hot.z - 0.3, z1: hot.z + 0.3 }, (k) => { this.keep[k] = 1; }); }
    this.items.push({ id, q, rot, rec, hot, solid: isSolid, nP: this.P.props.length - 1, nS: isSolid ? this.P.solids.length - 1 : -1, nH: hot ? this.P.hotspots.length - 1 : -1 });
    return this.items[this.items.length - 1];
  }
  /** Against a wall. walls: order of sides; at: 'center' | 'start' | 'end' | 'door' (next to the door) | number (along) */
  wall(id, opts = {}) {
    const it = ITEMS[id]; if (!it) return null;
    const w = opts.w ?? it.w, d = opts.d ?? it.d, h = opts.h ?? it.h, gap = opts.gap ?? 0.03;
    const sides = opts.walls || ['n', 'e', 's', 'w'];
    const r = this.r;
    for (const side of sides) {
      if (opts.realWall !== false && r.walls && r.walls[side] === false) continue;
      const along = side === 'n' || side === 's';
      const lo = along ? r.x0 : r.z0, hi = along ? r.x1 : r.z1, len = hi - lo;
      if (w > len - 0.05) continue;
      const cands = [];
      const step = 0.1, n = Math.floor((len - w) / step);
      for (let k = 0; k <= n; k++) cands.push(lo + 0.02 + k * step);
      const anchor = typeof opts.at === 'number' ? opts.at : opts.at === 'start' ? lo : opts.at === 'end' ? hi - w : opts.at === 'door' ? this.doorAnchor(side, w) : lo + (len - w) / 2;
      cands.sort((a, b) => Math.abs(a - anchor) - Math.abs(b - anchor));
      if (opts.within != null && len > 6) { const lim = cands.findIndex((o) => Math.abs(o - anchor) > opts.within); if (lim >= 0) cands.length = lim; }
      for (const o of cands) {
        let q;
        if (side === 'n') q = { x0: o, x1: o + w, z0: r.z0 + gap, z1: r.z0 + gap + d };
        else if (side === 's') q = { x0: o, x1: o + w, z0: r.z1 - gap - d, z1: r.z1 - gap };
        else if (side === 'w') q = { x0: r.x0 + gap, x1: r.x0 + gap + d, z0: o, z1: o + w };
        else q = { x0: r.x1 - gap - d, x1: r.x1 - gap, z0: o, z1: o + w };
        if (q.x1 > r.x1 + 1e-6 || q.z1 > r.z1 + 1e-6) continue;
        if (opts.avoidWindows !== false && this.windowsBlocked(q, side, h)) continue;
        if ((opts.solid ?? it.solid) !== true || h <= 0.05) { if (!this.mountFree(q, { ...opts, side, h, mountY: opts.mount ?? it.mount ?? 0 })) continue; }
        const res = this.put(id, q, ROT[side], { ...opts, w, d, h });
        if (res) { res.side = side; return res; }
      }
    }
    return null;
  }
  mountFree(q, opts = {}) {
    // wall-mounted / non-solid items: not over a door opening or a window, not behind furniture taller than their
    // bottom edge, not on another mounted item
    for (const dd of this.doors) { if (q.x0 < dd.ap.x1 && q.x1 > dd.ap.x0 && q.z0 < dd.ap.z1 && q.z1 > dd.ap.z0) return false; }
    if (opts.side) {
      const y0 = (opts.mountY || 0), y1 = y0 + (opts.h || 0.5);
      for (const w of this.r.windows || []) {
        if (w.side !== opts.side) continue;
        const a = opts.side === 'n' || opts.side === 's' ? [q.x0, q.x1] : [q.z0, q.z1];
        if (Math.min(a[1], w.to + 0.1) > Math.max(a[0], w.from - 0.1) && y1 > w.bottom - 0.05 && y0 < w.top + 0.05) return false;
      }
      const g = { x0: q.x0 - 0.05, x1: q.x1 + 0.05, z0: q.z0 - 0.05, z1: q.z1 + 0.05 };
      for (const s of this.P.solidsNear(g.x0, g.x1, g.z0, g.z1)) if (s.x0 < g.x1 && s.x1 > g.x0 && s.z0 < g.z1 && s.z1 > g.z0 && s.y < this.y + y1 && s.y + s.h > this.y + y0 - 0.1) return false;
    }
    if (opts.mountClear === false) return true;
    return this.rect(q, (k) => !this.mount[k] && !this.block[k]);
  }
  doorAnchor(side, w) {
    const d = this.doors.find((q) => q.side === side) || this.doors[0];
    if (!d) return null;
    const along = side === 'n' || side === 's';
    if (d.side === side) return d.at + d.w / 2 + 0.35;
    const r = this.r, c = { n: r.z0, s: r.z1, w: r.x0, e: r.x1 }[d.side];
    return along ? (Math.abs(c - r.x0) < Math.abs(c - r.x1) ? r.x0 : r.x1 - w) : (Math.abs(c - r.z0) < Math.abs(c - r.z1) ? r.z0 : r.z1 - w);
  }
  /** Free-standing at the candidate nearest to (ax, az) (spiral search); rot 0 = facing -z. */
  freeAt(id, ax, az, opts = {}) {
    const it = ITEMS[id]; if (!it) return null;
    const w = opts.w ?? it.w, d = opts.d ?? it.d;
    const rots = opts.rots || [0, Math.PI / 2];
    const r = this.r, m = opts.margin ?? 0.35, step = 0.2;
    const maxN = opts.maxTries ?? 160;
    let tries = 0;
    const ix = Math.round((ax - r.x0) / step), iz = Math.round((az - r.z0) / step);
    const nx = Math.floor((r.x1 - r.x0) / step), nz = Math.floor((r.z1 - r.z0) / step);
    for (let ring = 0; ring <= Math.max(nx, nz) && tries < maxN; ring++) {
      for (let a = -ring; a <= ring && tries < maxN; a++) for (let b = -ring; b <= ring && tries < maxN; b++) {
        if (Math.max(Math.abs(a), Math.abs(b)) !== ring) continue;
        const i = ix + a, j = iz + b; if (i < 0 || j < 0 || i > nx || j > nz) continue;
        const x = r.x0 + i * step, z = r.z0 + j * step;
        if (x < r.x0 + m || x > r.x1 - m || z < r.z0 + m || z > r.z1 - m) continue;
        tries++;
        { const ci = this.ci(x), cj = this.cj(z); if (ci >= 0 && cj >= 0 && ci < this.nx && cj < this.nz) { const k = this.idx(ci, cj); if (this.solid[k] || this.block[k] || (!opts.ignoreKeep && this.keep[k])) continue; } }
        for (const rot of rots) {
          const sw = Math.abs(Math.sin(rot)) > 0.5 ? d : w, sd = Math.abs(Math.sin(rot)) > 0.5 ? w : d;
          const q = { x0: x - sw / 2, x1: x + sw / 2, z0: z - sd / 2, z1: z + sd / 2 };
          if (!this.free(q, { ...opts, ignoreLanes: opts.ignoreLanes || this.softLanes })) continue;
          if (opts.pad && !this.free({ x0: Math.max(this.r.x0, q.x0 - opts.pad), x1: Math.min(this.r.x1, q.x1 + opts.pad), z0: Math.max(this.r.z0, q.z0 - opts.pad), z1: Math.min(this.r.z1, q.z1 + opts.pad) }, { ignoreKeep: true })) continue;
          const res = this.put(id, q, rot, { ...opts, w, d });
          if (res) return res;
        }
      }
    }
    return null;
  }
  /** Mark a band as circulation (kept free of solids). */
  lane(q) { if (!this.lanes) this.lanes = new Uint8Array(this.nx * this.nz); const c = clipTo(q, this.r); if (c.x1 - c.x0 > 0.05 && c.z1 - c.z0 > 0.05) (this.laneRects || (this.laneRects = [])).push({ x0: r2(c.x0), x1: r2(c.x1), z0: r2(c.z0), z1: r2(c.z1) }); this.rect(c, (k) => { this.lanes[k] = 1; }); }
  /** A connector from point p to the nearest kept cell, straight along x or z (1.0 m wide). */
  connect(p, w = 1.0) {
    const i0 = this.ci(p.x), j0 = this.cj(p.z);
    let best = null;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (let k = 1; k < 400; k++) {
        const i = i0 + di * k, j = j0 + dj * k; if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) break;
        const id = this.idx(i, j); if (this.block[id]) break;
        if (this.lanes?.[id] && !this.solid[id]) { if (!best || k < best.k) best = { k, di, dj }; break; }
      }
    }
    if (!best) {
      let bk = -1, bd = Infinity;
      if (this.lanes) for (let k = 0; k < this.lanes.length; k++) { if (!this.lanes[k] || this.solid[k]) continue; const i = k % this.nx, j = (k - i) / this.nx, d = Math.abs(i - i0) + Math.abs(j - j0); if (d < bd) { bd = d; bk = k; } }
      if (bk < 0) return;
      const i = bk % this.nx, j = (bk - i) / this.nx, x = this.x0 + (i + 0.5) * this.c, z = this.z0 + (j + 0.5) * this.c, hw = w / 2;
      this.lane({ x0: Math.min(p.x, x) - hw, x1: Math.max(p.x, x) + hw, z0: p.z - hw, z1: p.z + hw });
      this.lane({ x0: x - hw, x1: x + hw, z0: Math.min(p.z, z) - hw, z1: Math.max(p.z, z) + hw });
      return;
    }
    const L = best.k * this.c, hw = w / 2;
    const q = best.di ? { x0: Math.min(p.x, p.x + best.di * L) - (best.di < 0 ? 0 : 0), x1: Math.max(p.x, p.x + best.di * L), z0: p.z - hw, z1: p.z + hw } : { x0: p.x - hw, x1: p.x + hw, z0: Math.min(p.z, p.z + best.dj * L), z1: Math.max(p.z, p.z + best.dj * L) };
    this.lane(q);
  }
  /** Remove one placed item (by index) from the grid and the plan. */
  removeAt(i) {
    const it = this.items[i]; if (!it) return;
    this.items.splice(i, 1);
    if (it.solid) { this.stampSolid(it.q, 0); this.footprint -= (it.q.x1 - it.q.x0) * (it.q.z1 - it.q.z0); const iS = this.P.solids.findIndex((q) => q.tag === it.id && Math.abs(q.x0 - Math.min(it.q.x0, it.q.x1)) < 0.011 && Math.abs(q.z0 - Math.min(it.q.z0, it.q.z1)) < 0.011 && q.y === this.y); if (iS >= 0) this.P.solids.splice(iS, 1); }
    const iP = this.P.props.lastIndexOf(it.rec); if (iP >= 0) this.P.props.splice(iP, 1);
    if (it.hot) { const iH = this.P.hotspots.findIndex((h) => h.kind === it.hot.kind && Math.abs(h.x - r2(it.hot.x)) < 0.011 && Math.abs(h.z - r2(it.hot.z)) < 0.011); if (iH >= 0) this.P.hotspots.splice(iH, 1); const t = this.targets.findIndex((q) => q.x === it.hot.x && q.z === it.hot.z); if (t >= this.baseN) this.targets.splice(t, 1); }
  }
  /** Restore the walk: drop the fewest items (newest first) whose footprint cuts a baseline link. */
  repair(from = 0) {
    let guard = 0;
    while (!this.connected() && guard++ < 200) {
      let fixed = false;
      for (let i = this.items.length - 1; i >= from; i--) {
        const it = this.items[i]; if (!it.solid) continue;
        this.stampSolid(it.q, 0);
        const ok = this.connected();
        this.stampSolid(it.q, 1);
        if (ok) { this.removeAt(i); fixed = true; break; }
      }
      if (!fixed) { for (let i = this.items.length - 1; i >= from; i--) if (this.items[i].solid) { this.removeAt(i); break; } if (!this.items.slice(from).some((q) => q.solid)) break; }
    }
  }
  /** Undo the last placed items (props / solids / hotspots) down to count n. */
  rollback(n) {
    while (this.items.length > n) {
      const it = this.items.pop();
      if (it.solid) { this.stampSolid(it.q, 0); this.footprint -= (it.q.x1 - it.q.x0) * (it.q.z1 - it.q.z0); }
      const iP = this.P.props.lastIndexOf(it.rec); if (iP >= 0) this.P.props.splice(iP, 1);
      if (it.solid) { const iS = this.P.solids.findIndex((q) => q.tag === it.id && Math.abs(q.x0 - Math.min(it.q.x0, it.q.x1)) < 0.011 && Math.abs(q.z0 - Math.min(it.q.z0, it.q.z1)) < 0.011 && q.y === this.y); if (iS >= 0) this.P.solids.splice(iS, 1); }
      if (it.hot) { const iH = this.P.hotspots.findIndex((h) => h.kind === it.hot.kind && Math.abs(h.x - r2(it.hot.x)) < 0.011 && Math.abs(h.z - r2(it.hot.z)) < 0.011); if (iH >= 0) this.P.hotspots.splice(iH, 1); const t = this.targets.findIndex((q) => q.x === it.hot.x && q.z === it.hot.z); if (t >= 0) this.targets.splice(t, 1); }
    }
  }
  center() { return { x: (this.r.x0 + this.r.x1) / 2, z: (this.r.z0 + this.r.z1) / 2 }; }
  /**
   * Distance transform of the free floor on a grid of f × 0.1 m (f = 2 for big rooms): to solids + cuts + walls (A3)
   * and to solids / wall-mounted items only (A2). → { emptyR, at, holes, share2, fill }
   */
  metrics(nHoles = 1) {
    const f = this.nx * this.nz > 6000 ? 2 : 1, cs = this.c * f;
    const nx = Math.ceil(this.nx / f), nz = Math.ceil(this.nz / f), N = nx * nz, INF = 1e9;
    this.metricsNx = nx;
    if (!this.mb || this.mb.N !== N) this.mb = { N, dW: new Float32Array(N), dS: new Float32Array(N), obs: new Uint8Array(N), sol: new Uint8Array(N) };
    const { dW, dS, obs, sol } = this.mb; obs.fill(0); sol.fill(0);
    for (let j = 0; j < this.nz; j++) for (let i = 0; i < this.nx; i++) {
      const k = this.idx(i, j), K2 = ((j / f) | 0) * nx + ((i / f) | 0);
      if (this.solid[k] || this.block[k]) obs[K2] = 1;
      if (this.solid[k] || this.mount[k]) sol[K2] = 1;
    }
    for (let k = 0; k < N; k++) { dW[k] = obs[k] ? 0 : INF; dS[k] = sol[k] ? 0 : INF; }
    const s2 = Math.SQRT2, wx = this.nx * this.c / cs, wz = this.nz * this.c / cs;
    const pass = (D, walls) => {
      for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
        const k = j * nx + i; let v = D[k];
        if (walls) { const e = Math.min(i + 0.5, j + 0.5); if (e < v) v = e; }
        if (i > 0 && D[k - 1] + 1 < v) v = D[k - 1] + 1; if (j > 0 && D[k - nx] + 1 < v) v = D[k - nx] + 1;
        if (i > 0 && j > 0 && D[k - nx - 1] + s2 < v) v = D[k - nx - 1] + s2; if (i < nx - 1 && j > 0 && D[k - nx + 1] + s2 < v) v = D[k - nx + 1] + s2;
        D[k] = v;
      }
      for (let j = nz - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
        const k = j * nx + i; let v = D[k];
        if (walls) { const e = Math.min(wx - i - 0.5, wz - j - 0.5); if (e < v) v = e; }
        if (i < nx - 1 && D[k + 1] + 1 < v) v = D[k + 1] + 1; if (j < nz - 1 && D[k + nx] + 1 < v) v = D[k + nx] + 1;
        if (i < nx - 1 && j < nz - 1 && D[k + nx + 1] + s2 < v) v = D[k + nx + 1] + s2; if (i > 0 && j < nz - 1 && D[k + nx - 1] + s2 < v) v = D[k + nx - 1] + s2;
        D[k] = v;
      }
    };
    pass(dW, true); pass(dS, false);
    let max = 0, at = -1, free = 0, nearN = 0, maxS = 0, atS = -1;
    const cand = [];
    for (let k = 0; k < N; k++) {
      if (obs[k]) continue;
      free++; if (dS[k] * cs <= 2.0) nearN++; else if (dS[k] > maxS && !this.skipFar?.has(k)) { maxS = dS[k]; atS = k; }
      if (dW[k] > max) { max = dW[k]; at = k; }
      if (nHoles > 1 && dW[k] * cs > 0.5) cand.push(k);
    }
    const pt = (k) => { const i = k % nx, j = (k - i) / nx; return { x: this.x0 + (i + 0.5) * cs, z: this.z0 + (j + 0.5) * cs, r: dW[k] * cs }; };
    let holes = [];
    if (nHoles > 1) {
      cand.sort((a, b) => dW[b] - dW[a]);
      for (const k of cand) { const p = pt(k); if (holes.some((h) => Math.hypot(h.x - p.x, h.z - p.z) < Math.max(2.0, h.r * 2))) continue; holes.push(p); if (holes.length >= nHoles) break; }
    }
    return { emptyR: max * cs, at: at < 0 ? null : pt(at), far: atS < 0 ? null : { ...pt(atS), k: atS }, holes, share2: free ? nearN / free : 1, fill: this.footprint / this.area };
  }
  /** Fill the biggest empty discs with the kit's fill items until emptyR and the fill band hold (§3.2 step 4). */
  fillLoop(list, { emptyR, fillLo, maxItems = 40 } = {}) {
    let placedN = 0, passes = 0, m = null;
    while (placedN < maxItems && passes++ < 12) {
      m = this.metrics(8);
      if (m.emptyR <= emptyR && m.fill >= fillLo) return m;
      if (!m.at) return m;
      const holes = m.holes.length ? m.holes.filter((h) => h.r > emptyR * 0.8 || m.fill < fillLo) : [m.at];
      if (!holes.length) holes.push(m.at);
      let got = 0;
      for (const h of holes) {
        if (placedN >= maxItems) break;
        let placed = null;
        for (const id of list) {
          const it = ITEMS[id]; if (!it) continue;
          if (it.wall) {
            const r = this.r, dists = { n: h.z - r.z0, s: r.z1 - h.z, w: h.x - r.x0, e: r.x1 - h.x };
            const sides = Object.keys(dists).sort((a, b) => dists[a] - dists[b]);
            if (dists[sides[0]] < Math.max(1.6, emptyR * 2)) placed = this.wall(id, { walls: sides.slice(0, 2), at: (sides[0] === 'n' || sides[0] === 's' ? h.x : h.z) - it.w / 2, within: Math.max(1.5, emptyR * 2) });
          }
          if (!placed) placed = this.freeAt(id, h.x, h.z, { maxTries: 24, pad: 0.05 });
          if (placed) break;
        }
        if (placed) { got++; placedN++; } else this.keepAround(h);
      }
      if (!got && passes > 3) break;
    }
    return this.metrics();
  }
  /** mark a stubborn hole as "keep" so the loop moves on (it is a lane the walker needs). */
  keepAround(p) { this.rect({ x0: p.x - 0.3, x1: p.x + 0.3, z0: p.z - 0.3, z1: p.z + 0.3 }, (k) => { this.keep[k] = 1; }); }
}
function frontRect(q, rot, fd) {
  const s = Math.round(Math.sin(rot) * 1000) / 1000, c = Math.round(Math.cos(rot) * 1000) / 1000;
  // facing direction: rot 0 → +z (into the room from the north wall)
  const fx = s, fz = c;
  if (Math.abs(fz) > 0.5) return fz > 0 ? { x0: q.x0, x1: q.x1, z0: q.z1, z1: q.z1 + fd } : { x0: q.x0, x1: q.x1, z0: q.z0 - fd, z1: q.z0 };
  return fx > 0 ? { x0: q.x1, x1: q.x1 + fd, z0: q.z0, z1: q.z1 } : { x0: q.x0 - fd, x1: q.x0, z0: q.z0, z1: q.z1 };
}
function frontPoint(q, rot, dist) {
  const s = Math.sin(rot), c = Math.cos(rot), cx = (q.x0 + q.x1) / 2, cz = (q.z0 + q.z1) / 2;
  const hx = (q.x1 - q.x0) / 2, hz = (q.z1 - q.z0) / 2;
  return { x: cx + s * (Math.abs(s) > 0.5 ? hx + dist : 0), z: cz + c * (Math.abs(c) > 0.5 ? hz + dist : 0) };
}
function clipTo(q, r) { return { x0: Math.max(q.x0, r.x0), x1: Math.min(q.x1, r.x1), z0: Math.max(q.z0, r.z0), z1: Math.min(q.z1, r.z1) }; }

// ------------------------------------------------------------------------------------------------ kits
const longWalls = (r) => (r.x1 - r.x0 >= r.z1 - r.z0 ? ['n', 's', 'w', 'e'] : ['w', 'e', 'n', 's']);
const winSides = (r) => [...new Set((r.windows || []).map((w) => w.side))];
const doorSides = (K) => new Set(K.doors.map((d) => d.side));
const notDoor = (K, list) => list.filter((s) => !doorSides(K).has(s)).concat(list.filter((s) => doorSides(K).has(s)));
function wetUnitSize(kind, r) {
  const [lo, hi] = SCALE[kind]?.wet ? (Array.isArray(SCALE[kind].wet) ? SCALE[kind].wet : [SCALE[kind].wet, SCALE[kind].wet]) : [1.6, 2.0];
  const target = clamp(((r.x1 - r.x0) * (r.z1 - r.z0) - (SCALE[kind]?.target || 9)), lo, hi);
  const w = clamp(Math.sqrt(target) * 1.0, 1.2, 1.5), d = clamp(target / w, 1.25, 1.6);
  return { w: r2(w), d: r2(d) };
}
/** A cabin (rating / officer / pilot / super): wet unit by the door, bunk under the window, desk + chair, wardrobe. */
function cabinKit(K) {
  const r = K.r, kind = r.space;
  const officer = SCALE[kind]?.officer || kind === 'cabin_super';
  const wins = winSides(r), ds = doorSides(K);
  if (SCALE[kind]?.wet && !r.sharedWash) { const s = wetUnitSize(kind, r); K.wall('wet_unit', { ...s, walls: [...ds, ...notDoor(K, ['n', 's', 'e', 'w'])], at: 'door', front: 0.6 }); }
  const bunkWalls = [...wins.filter((s) => !ds.has(s)), ...notDoor(K, longWalls(r))];
  K.wall(r.berth >= 2 ? 'bunk2' : 'bunk', { walls: bunkWalls, at: 'center', avoidWindows: false, hotLabel: officer ? 'Rest in your cabin' : 'Rest in the bunk' });
  const desk = K.wall('desk', { walls: [...wins, ...notDoor(K, ['e', 'w', 'n', 's'])], at: 'center', front: 0.5 });
  if (desk) chairBefore(K, desk);
  K.wall('wardrobe', { w: officer ? 1.0 : 0.8, walls: notDoor(K, ['n', 's', 'e', 'w']), at: 'door' });
  if (officer) { const s = K.wall('settee', { walls: notDoor(K, ['s', 'n', 'w', 'e']), front: 0.8 }); if (s) coffeeBefore(K, s); }
  K.wall('drawers', { walls: notDoor(K, ['n', 'e', 's', 'w']) });
  K.wall('bin', { walls: notDoor(K, ['e', 'w', 'n', 's']) });
  curtains(K);
  const c = K.center(); K.freeAt('rug', c.x, c.z, { maxTries: 40 });
  return { fill: ['drawers', 'bookshelf', 'lifejacket_box', 'chair', 'armchair', 'plant', 'crate_stack'], dress: ['notice_board', 'tv', 'artwork', 'mirror'] };
}
/** Curtains either side of every window (cabins, suites, messes). */
function curtains(K) {
  const r = K.r;
  for (const w of r.windows || []) {
    const ns = w.side === 'n' || w.side === 's', c = { n: r.z0 + 0.1, s: r.z1 - 0.1, w: r.x0 + 0.1, e: r.x1 - 0.1 }[w.side], rot = { n: 0, s: Math.PI, w: Math.PI / 2, e: -Math.PI / 2 }[w.side];
    for (const u of [w.from - 0.12, w.to + 0.12]) K.P.prop('k2', { item: 'curtain', x: r2(ns ? u : c), y: r2(r.y + w.bottom - 0.05), z: r2(ns ? c : u), rotY: rot, w: 0.35, d: 0.08, h: r2(w.top - w.bottom + 0.15), room: r.id, var: 0 });
  }
}
function chairBefore(K, it, id = 'chair') {
  const p = frontPoint(it.q, it.rot, 0.15);
  const it2 = ITEMS[id], w = it2.w, d = it2.d;
  for (const dd of [0.12, 0.25, 0.4]) {
    const pp = frontPoint(it.q, it.rot, dd + d / 2 - 0.15);
    const q = { x0: pp.x - w / 2, x1: pp.x + w / 2, z0: pp.z - d / 2, z1: pp.z + d / 2 };
    if (K.put(id, q, it.rot + Math.PI, { ignoreKeep: true, front: 0 })) return true;
  }
  void p; return false;
}
function coffeeBefore(K, it) {
  const pp = frontPoint(it.q, it.rot, 0.55);
  const it2 = ITEMS.coffee_table, along = Math.abs(Math.cos(it.rot)) > 0.5;
  const w = along ? it2.w : it2.d, d = along ? it2.d : it2.w;
  const q = { x0: pp.x - w / 2, x1: pp.x + w / 2, z0: pp.z - d / 2, z1: pp.z + d / 2 };
  return K.put('coffee_table', q, it.rot, { ignoreKeep: true, front: 0 });
}
function suiteDayKit(K) {
  const s = K.wall('settee_L', { walls: notDoor(K, ['s', 'n', 'w', 'e']), front: 0.8 });
  if (s) coffeeBefore(K, s);
  const desk = K.wall('desk_office', { walls: [...winSides(K.r), ...notDoor(K, ['e', 'w', 'n', 's'])], front: 0.5 });
  if (desk) chairBefore(K, desk, 'office_chair');
  K.wall('sideboard', { walls: notDoor(K, ['n', 'e', 'w', 's']) });
  K.wall('bookshelf', { walls: notDoor(K, ['e', 'w', 'n', 's']) });
  K.wall('fridge_upright', { w: 0.6, d: 0.6, h: 0.9, walls: notDoor(K, ['w', 'e', 'n', 's']) });
  K.freeAt('armchair', K.center().x, K.center().z, { maxTries: 60 });
  curtains(K);
  return { fill: ['armchair', 'plant', 'drawers', 'cabinet_file', 'chair'], dress: ['tv', 'artwork', 'artwork'] };
}
function suiteBedKit(K) {
  const r = K.r;
  if (SCALE[r.space]?.wet) { const s = wetUnitSize(r.space, r); K.wall('wet_unit', { ...s, walls: [...doorSides(K), 'n', 's', 'e', 'w'], at: 'door', front: 0.6 }); }
  K.wall('bed_double', { w: 2.0, d: 1.4, walls: [...winSides(r), ...notDoor(K, longWalls(r))], at: 'center', avoidWindows: false, hotLabel: 'Rest in your cabin' });
  K.wall('wardrobe', { w: 1.2, walls: notDoor(K, ['n', 's', 'e', 'w']), at: 'door' });
  K.wall('drawers', { walls: notDoor(K, ['e', 'w', 'n', 's']) });
  curtains(K); K.freeAt('rug', K.center().x, K.center().z, { maxTries: 40 });
  K.wall('bin', { walls: notDoor(K, ['e', 'w', 'n', 's']) }); K.wall('plant', { walls: notDoor(K, ['s', 'n', 'e', 'w']) });
  return { fill: ['drawers', 'armchair', 'plant', 'chair'], dress: ['artwork', 'tv', 'mirror', 'notice_board'] };
}
function lobbyKit(K) {
  K.wall('wardrobe', { w: 0.6, walls: notDoor(K, ['e', 'w', 'n', 's']) });
  K.wall('locker_tall', { walls: notDoor(K, ['w', 'e', 'n', 's']) });
  K.wall('lifejacket_box', { walls: notDoor(K, ['n', 's', 'e', 'w']) });
  return { fill: ['locker_tall', 'drawers', 'crate_stack'], dress: ['fire_ext', 'notice_board'] };
}
/** Mess: tables with fixed benches for the watch (seats = berths of that mess + 2), serving hatch, TV, coffee corner. */
function messKit(K, ctx) {
  const r = K.r, W = r.x1 - r.x0, D = r.z1 - r.z0;
  const hatchWall = ctx.galleyWall?.(r);
  if (hatchWall) K.wall('serving_hatch', { walls: [hatchWall], at: 'center', front: 0.9 });
  K.wall('coffee_corner', { walls: notDoor(K, ['e', 'w', 'n', 's']), front: 0.7 });
  // table rows across the short side, benches either side
  const alongX = W >= D;
  const len = alongX ? W : D, span = alongX ? D : W;
  const tw = 1.8, pitch = 2.3;
  const rows = Math.max(1, Math.floor((span - 0.6) / pitch)), cols = Math.max(1, Math.floor((len - 0.8) / 2.4));
  const c = K.center();
  for (let a = 0; a < cols; a++) for (let b = 0; b < rows; b++) {
    const u = (alongX ? r.x0 : r.z0) + ((a + 0.5) * len) / cols, v = (alongX ? r.z0 : r.x0) + ((b + 0.5) * span) / rows;
    const x = alongX ? u : v, z = alongX ? v : u;
    tableSet(K, x, z, alongX, tw);
  }
  void c;
  K.wall('fridge_upright', { walls: notDoor(K, ['w', 'e', 'n', 's']) });
  K.wall('water_cooler', { walls: notDoor(K, ['e', 'w', 'n', 's']) });
  return { fill: ['sideboard', 'plant', 'drawers', 'bookshelf', 'armchair'], dress: ['tv', 'notice_board', 'artwork', 'fire_plan'] };
}
function tableSet(K, x, z, alongX, tw) {
  // table 1.8 × 0.8 with a fixed bench each side (0.45 deep, 0.08 gap) — one compound footprint, a passage round it
  const d = 0.8 + 2 * (0.45 + 0.08);
  return K.freeAt('table_mess', x, z, { w: tw, d, h: 0.75, rots: [alongX ? 0 : Math.PI / 2], pad: 0.5, maxTries: 40, front: 0, prop: { benches: true, tableD: 0.8 } });
}
function galleyKit(K, ctx) {
  const r = K.r;
  const hatchWall = ctx.messWall?.(r);
  if (hatchWall) K.wall('serving_hatch', { walls: [hatchWall], at: 'center', front: 1.0 });
  const walls = notDoor(K, longWalls(r));
  K.wall('range', { walls, at: 'center', front: 1.0 });
  K.wall('oven_combi', { walls, front: 1.0 });
  K.wall('sink_double', { walls, front: 0.9 });
  K.wall('dishwasher_hood', { walls, front: 0.9 });
  K.wall('fridge_upright', { walls, front: 0.9 });
  K.wall('fridge_upright', { walls, front: 0.9 });
  K.wall('freezer_chest', { walls, front: 0.8 });
  for (let i = 0; i < 6; i++) K.wall('counter', { walls, front: 0.9 });
  if ((r.x1 - r.x0) * (r.z1 - r.z0) > 18) {
    const ax = r.x1 - r.x0 >= r.z1 - r.z0 ? 0 : Math.PI / 2;
    K.freeAt('buffet_island', K.center().x, K.center().z, { w: 2.0, d: 0.9, maxTries: 60, front: 0.9, rots: [ax, ax + Math.PI / 2] })
      || K.freeAt('buffet_island', K.center().x, K.center().z, { w: 1.4, d: 0.7, maxTries: 80, front: 0, rots: [ax, ax + Math.PI / 2] })
      || K.freeAt('kettle_tilt', K.center().x, K.center().z, { maxTries: 80 });
  }
  let c = K.center();
  if (!K.walkableAt(c.x, c.z)) { const d = K.targets[0]; if (d) c = { x: (c.x + d.x) / 2, z: (c.z + d.z) / 2 }; }
  K.P.hot('galley', 'Galley — the cook\'s domain (crew morale)', c.x, r.y, c.z, 1.6);
  if (K.walkableAt(c.x, c.z)) { K.targets.push({ x: c.x, z: c.z }); }
  return { fill: ['counter', 'kettle_tilt', 'fryer', 'shelf_rack', 'crate_stack'], dress: ['fire_ext', 'notice_board'] };
}
function pantryKit(K) {
  const walls = notDoor(K, longWalls(K.r));
  K.wall('counter', { walls }); K.wall('sink_double', { walls }); K.wall('fridge_upright', { walls }); K.wall('coffee_machine', { walls });
  return { fill: ['counter', 'shelf_rack', 'fridge_upright'], dress: ['fire_ext'] };
}
function provisionsKit(K) {
  lineWalls(K, ['shelf_rack', 'shelf_rack', 'sack_stack'], ['n', 's', 'e', 'w']);
  lineWalls(K, ['shelf_rack'], ['n', 's', 'e', 'w'], { d: 0.35, ignoreKeep: K.area < 8 }); island(K, 'shelf_rack');
  return { fill: ['shelf_rack', 'sack_stack', 'crate_stack', 'drum_stack'], dress: ['fire_ext'] };
}
function coldKit(K) {
  lineWalls(K, ['shelf_rack', 'crate_stack'], ['n', 's', 'e', 'w'], { d: 0.45 });
  lineWalls(K, ['shelf_rack'], ['n', 's', 'e', 'w'], { d: 0.35, ignoreKeep: K.area < 8 }); island(K, 'shelf_rack');
  return { fill: ['shelf_rack', 'crate_stack', 'freezer_chest'], dress: [] };
}
function hospitalKit(K) {
  const r = K.r;
  if (SCALE[r.space]?.wet) K.wall('wet_unit', { w: 1.3, d: 1.5, walls: [...doorSides(K), 'n', 's', 'e', 'w'], at: 'door', front: 0.6 });
  K.freeAt('hospital_bed', K.center().x, K.center().z, { maxTries: 120, pad: 0.6, hotLabel: 'Ship\'s hospital — berth, medicine chest, radio-medical advice' });
  K.wall('medicine_cab', { walls: notDoor(K, ['w', 'e', 'n', 's']) });
  const desk = K.wall('desk', { walls: notDoor(K, ['e', 'w', 's', 'n']) }); if (desk) chairBefore(K, desk);
  K.wall('basin', { walls: notDoor(K, ['n', 's', 'e', 'w']) });
  return { fill: ['cabinet_file', 'chair', 'drawers', 'fridge_upright'], dress: ['first_aid_box', 'notice_board', 'eyewash'] };
}
function washKit(K) {
  const walls = notDoor(K, ['n', 's', 'e', 'w']);
  K.wall('shower_tray', { walls }); K.wall('wc', { walls }); K.wall('basin', { walls }); K.wall('wc', { walls }); K.wall('basin', { walls });
  return { fill: ['wc', 'basin', 'shower_tray', 'locker_tall'], dress: [] };
}
function laundryKit(K) {
  const walls = notDoor(K, longWalls(K.r));
  K.wall('washer', { walls }); K.wall('washer', { walls }); K.wall('dryer', { walls }); K.wall('dryer', { walls });
  K.wall('folding_table', { walls }); K.wall('ironing_board', { walls });
  return { fill: ['shelf_rack', 'sink_double', 'washer', 'locker_tall'], dress: ['fire_ext', 'notice_board'] };
}
function dryingKit(K) { lineWalls(K, ['locker_row', 'shelf_rack'], ['n', 's', 'e', 'w'], { d: 0.5 }); return { fill: ['locker_tall', 'shelf_rack'], dress: [] }; }
function gymKit(K) {
  K.wall('treadmill', { walls: [...winSides(K.r), ...notDoor(K, ['n', 'w', 'e', 's'])], d: 1.9, w: 0.85, front: 0.5 });
  K.wall('bike', { walls: [...winSides(K.r), ...notDoor(K, ['n', 'w', 'e', 's'])], front: 0.5 });
  K.wall('weights', { walls: notDoor(K, ['e', 'w', 's', 'n']), front: 1.0 });
  K.freeAt('gym_mat', K.center().x, K.center().z);
  if ((K.r.x1 - K.r.x0) * (K.r.z1 - K.r.z0) > 20) K.freeAt('table_tennis', K.center().x, K.center().z, { pad: 0.6 });
  return { fill: ['bike', 'weights', 'locker_tall', 'bench_mess', 'plant'], dress: ['tv', 'notice_board'] };
}
function loungeKit(K) {
  const s = K.wall('settee_L', { walls: notDoor(K, ['s', 'w', 'e', 'n']), front: 0.8 }); if (s) coffeeBefore(K, s);
  K.wall('settee', { walls: notDoor(K, ['n', 'e', 'w', 's']), front: 0.8 });
  K.freeAt('table_round', K.center().x, K.center().z, { pad: 0.5 });
  K.wall('bookshelf', { walls: notDoor(K, ['e', 'w', 'n', 's']) });
  K.wall('sideboard', { walls: notDoor(K, ['w', 'e', 'n', 's']) });
  return { fill: ['armchair', 'chair', 'plant', 'bookshelf', 'table_round'], dress: ['tv', 'artwork', 'notice_board'] };
}
function libraryKit(K) {
  for (let i = 0; i < 3; i++) K.wall('bookshelf', { walls: notDoor(K, ['n', 'e', 'w', 's']) });
  K.freeAt('table_round', K.center().x, K.center().z, { pad: 0.5 });
  K.wall('settee', { walls: notDoor(K, ['s', 'n', 'e', 'w']), front: 0.8 });
  return { fill: ['armchair', 'bookshelf', 'chair', 'plant'], dress: ['artwork'] };
}
function conferenceKit(K) {
  const c = K.center();
  K.freeAt('conference_table', c.x, c.z, { pad: 0.7, rots: [K.r.x1 - K.r.x0 >= K.r.z1 - K.r.z0 ? 0 : Math.PI / 2] });
  K.wall('sideboard', { walls: notDoor(K, ['n', 's', 'e', 'w']) });
  return { fill: ['office_chair', 'chair', 'plant', 'cabinet_file'], dress: ['tv', 'notice_board', 'artwork'] };
}
function changingKit(K) {
  const walls = notDoor(K, longWalls(K.r));
  K.wall('locker_row', { walls, front: 0.8 }); K.wall('locker_row', { walls, front: 0.8 });
  K.freeAt('bench_mess', K.center().x, K.center().z, { pad: 0.3 });
  K.wall('shower_tray', { walls });
  return { fill: ['locker_tall', 'shelf_rack', 'bench_mess'], dress: ['eyewash', 'notice_board'] };
}
function officeKit(K) {
  const a = K.wall('desk_office', { walls: [...winSides(K.r), ...notDoor(K, ['n', 'e', 'w', 's'])], front: 0.5 }); if (a) chairBefore(K, a, 'office_chair');
  const b = K.wall('desk_office', { walls: notDoor(K, ['e', 'w', 's', 'n']), front: 0.5 }); if (b) chairBefore(K, b, 'office_chair');
  K.wall('cabinet_file', { walls: notDoor(K, ['w', 'e', 'n', 's']) }); K.wall('cabinet_file', { walls: notDoor(K, ['w', 'e', 'n', 's']) });
  return { fill: ['cabinet_file', 'drawers', 'chair', 'bookshelf', 'plant'], dress: ['notice_board', 'fire_plan'] };
}
function ccrKit(K) {
  const r = K.r;
  const con = K.wall('ecr_console', { w: Math.min(3.6, Math.max(r.x1 - r.x0, r.z1 - r.z0) - 1.4), walls: [...winSides(r), ...notDoor(K, ['n', 'e', 'w', 's'])], front: 1.1, hot: { kind: 'ccr', label: 'Cargo control console — loading computer, valves, pumps' } });
  if (con) { chairBefore(K, con, 'office_chair'); }
  K.wall('mcc_panel', { walls: notDoor(K, ['e', 'w', 's', 'n']), front: 1.0 });
  const desk = K.wall('desk_office', { walls: notDoor(K, ['s', 'e', 'w', 'n']) }); if (desk) chairBefore(K, desk, 'office_chair');
  return { fill: ['cabinet_file', 'panel_gauges', 'chair', 'drawers'], dress: ['notice_board', 'fire_plan'] };
}
function bridgeRoomKit(K, kind) {
  const walls = notDoor(K, longWalls(K.r));
  if (kind === 'chartroom') { K.wall('chart_table', { walls, front: 0.9 }); K.wall('chart_drawers', { walls }); K.wall('bookshelf', { walls }); }
  else if (kind === 'radio_room') { K.wall('gmdss', { walls, hot: false }); const d = K.wall('desk', { walls }); if (d) chairBefore(K, d); K.wall('cabinet_file', { walls }); }
  else if (kind === 'electronics') { K.wall('mcc_panel', { walls }); K.wall('spares_rack', { walls, w: 1.4 }); K.wall('workbench', { walls, w: 1.6 }); island(K, 'workbench', { d: 0.8 }); }
  else if (kind === 'battery') { K.wall('shelf_rack', { walls, w: 1.4 }); K.wall('cabinet_file', { walls }); }
  if (kind === 'electronics' || kind === 'battery') lineWalls(K, ['shelf_rack', 'cabinet_file'], ['n', 's', 'e', 'w'], { d: 0.4, ignoreKeep: K.area < 8 });
  return { fill: ['cabinet_file', 'shelf_rack', 'chair', 'drawers'], dress: ['notice_board'] };
}
function storeKit(K) {
  lineWalls(K, ['shelf_rack', 'crate_stack', 'shelf_rack', 'drum_stack'], ['n', 's', 'e', 'w']);
  lineWalls(K, ['shelf_rack'], ['n', 's', 'e', 'w'], { d: 0.35, ignoreKeep: K.area < 8 }); island(K, 'shelf_rack');
  return { fill: ['shelf_rack', 'crate_stack', 'drum_stack', 'sack_stack'], dress: ['fire_ext'] };
}
function plantRoomKit(K, kind) {
  const walls = notDoor(K, longWalls(K.r));
  if (kind === 'ac_room') { K.wall('compressor', { walls }); K.wall('fw_generator', { walls }); K.wall('mcc_panel', { walls }); }
  else if (kind === 'fan_room') { K.wall('compressor', { walls }); K.wall('mcc_panel', { walls }); }
  else if (kind === 'co2_room') { for (let i = 0; i < 4; i++) K.wall('drum_stack', { walls, w: 1.2, d: 0.35, h: 1.6 }); K.wall('panel_gauges', { walls }); }
  else if (kind === 'bosun_store' || kind === 'paint_locker') { K.wall('shelf_rack', { walls }); K.wall('drum_stack', { walls }); K.freeAt('rope_reel', K.center().x, K.center().z); }
  return { fill: ['shelf_rack', 'drum_stack', 'crate_stack', 'pump_h'], dress: ['fire_ext'] };
}
function steeringKit(K) {
  const walls = notDoor(K, ['n', 's', 'e', 'w']);
  K.wall('hpu', { walls, front: 0.8 }); K.wall('hpu', { walls, front: 0.8 });
  K.wall('emerg_steer_panel', { walls }); K.wall('phone_sp', { walls });
  lineWalls(K, ['spares_rack', 'drum_stack', 'shelf_rack', 'pump_h', 'cooler_plate'], ['e', 'w', 'n', 's']);
  if (K.area > 40) gridFill(K, ['workbench', 'spares_rack', 'compressor', 'rope_reel', 'air_receiver', 'crate_stack', 'pump_h', 'local_stand']);
  return { fill: ['drum_stack', 'spares_rack', 'crate_stack', 'pump_h', 'shelf_rack'], dress: ['fire_ext', 'fire_plan'] };
}
function ecrKit(K) {
  const walls = notDoor(K, ['n', 's', 'e', 'w']);
  for (let i = 0; i < 6; i++) K.wall('msb_panel', { walls, front: 1.1 });
  const d = K.wall('desk_office', { walls }); if (d) chairBefore(K, d, 'office_chair');
  K.wall('printer', { walls }); K.wall('cabinet_file', { walls }); K.wall('coffee_corner', { walls, w: 0.9 });
  K.freeAt('office_chair', K.center().x, K.center().z, { maxTries: 40 });
  return { fill: ['cabinet_file', 'msb_panel', 'office_chair', 'drawers'], dress: ['notice_board', 'fire_plan', 'phone_sp'] };
}
function purifierKit(K) {
  const walls = notDoor(K, ['n', 's', 'e', 'w']);
  K.wall('heater_skid', { walls }); K.wall('purifier', { walls }); K.wall('tank_wall', { walls, w: 2.0, h: 2.0 }); K.wall('pump_h', { walls });
  return { fill: ['purifier', 'pump_v', 'heater_skid', 'drum_stack', 'spares_rack'], dress: ['fire_ext'] };
}
function workshopKit(K) {
  const walls = notDoor(K, ['n', 's', 'e', 'w']);
  K.wall('drill_press', { walls }); K.wall('welding_bench', { walls }); K.wall('spares_rack', { walls }); K.wall('workbench', { walls });
  return { fill: ['spares_rack', 'shelf_rack', 'drum_stack', 'crate_stack', 'workbench'], dress: ['fire_ext', 'notice_board'] };
}
function machineryRoomKit(K) {
  const walls = notDoor(K, ['n', 's', 'e', 'w']);
  K.wall('mcc_panel', { walls }); K.wall('pump_h', { walls }); K.wall('spares_rack', { walls });
  return { fill: ['pump_v', 'pump_h', 'drum_stack', 'spares_rack', 'compressor'], dress: ['fire_ext'] };
}
/** A free-standing double-sided rack / bench down the middle of a store when the lined walls leave a wide floor. */
function island(K, id, { d = 0.6 } = {}) {
  const r = K.r, W = r.x1 - r.x0, D = r.z1 - r.z0, alongX = W >= D, L = Math.max(W, D), S = Math.min(W, D);
  if (S < 2.9 || L < 2.6) return null;
  const c = K.center(), w = Math.min(3.2, L - 1.9);
  return K.freeAt(id, c.x, c.z, { w, d, rots: [alongX ? 0 : Math.PI / 2], front: 0, ignoreKeep: true, margin: 0.8, maxTries: 60 });
}
/** Large machinery flats: free-standing rows across the floor (a pitch apart, aisles kept by the walk check). */
function gridFill(K, ids, { pitch = 2.9, step = 2.4 } = {}) {
  const r = K.r, alongX = r.x1 - r.x0 >= r.z1 - r.z0;
  const [s0, s1] = alongX ? [r.z0, r.z1] : [r.x0, r.x1], [l0, l1] = alongX ? [r.x0, r.x1] : [r.z0, r.z1];
  let k = 0;
  for (let a = s0 + 1.9; a < s1 - 1.5; a += pitch) for (let b = l0 + 1.7; b < l1 - 1.5; b += step) {
    const id = ids[k++ % ids.length];
    K.freeAt(id, alongX ? b : a, alongX ? a : b, { maxTries: 8, margin: 0.6, rots: [alongX ? 0 : Math.PI / 2, alongX ? Math.PI / 2 : 0] });
  }
}
/** Line the walls with racks / units end to end (stores, cold rooms, lockers): along each side, as many as fit. */
function lineWalls(K, ids, sides, { gap = 0.05, d = null, ignoreKeep = false } = {}) {
  const r = K.r;
  for (const side of sides) {
    if (r.walls && r.walls[side] === false) continue;
    const along = side === 'n' || side === 's', lo = along ? r.x0 : r.z0, hi = along ? r.x1 : r.z1;
    let k = 0;
    for (let u = lo + 0.05; u < hi - 0.4;) {
      let done = false;
      for (let t = 0; t < ids.length && !done; t++) {
        const id = ids[(k + t) % ids.length], it = ITEMS[id]; if (!it) continue;
        const dd = d ?? it.d, w = Math.min(it.w, hi - 0.05 - u); if (w < 0.6) continue;
        const res = K.wall(id, { walls: [side], at: u, w, d: dd, ignoreKeep, within: hi - lo > 6 ? 0.6 : null });
        if (res) { done = true; k++; const q = res.q; u = (along ? q.x1 : q.z1) + gap; }
      }
      if (!done) u += 0.2;
    }
  }
}
const KIT_FNS = {
  cabin: cabinKit, suite_day: suiteDayKit, suite_bed: suiteBedKit, cabin_lobby: lobbyKit, mess: messKit, galley: galleyKit, pantry: pantryKit,
  provisions: provisionsKit, cold_room: coldKit, hospital: hospitalKit, washroom: washKit, laundry: laundryKit, drying_room: dryingKit, gym: gymKit,
  recreation: loungeKit, lounge_crew: loungeKit, library: libraryKit, conference: conferenceKit, changing_er: changingKit, office: officeKit, ccr: ccrKit,
  chartroom: (K) => bridgeRoomKit(K, 'chartroom'), radio_room: (K) => bridgeRoomKit(K, 'radio_room'), electronics: (K) => bridgeRoomKit(K, 'electronics'), battery: (K) => bridgeRoomKit(K, 'battery'),
  steering_gear: steeringKit, ecr: ecrKit, purifier_room: purifierKit, workshop: workshopKit, spares: workshopKit, machinery_room: machineryRoomKit,
  store: storeKit, ac_room: (K) => plantRoomKit(K, 'ac_room'), fan_room: (K) => plantRoomKit(K, 'fan_room'), co2_room: (K) => plantRoomKit(K, 'co2_room'), bosun_store: (K) => plantRoomKit(K, 'bosun_store'),
};
/** KITS (§9.2): kit id → { space: [kinds], band, emptyR, place }. */
export const KITS = Object.freeze(Object.fromEntries(Object.entries(KIT_FNS).map(([k, f]) => [k, Object.freeze({ space: Object.keys(SCALE).filter((s) => SCALE[s].kit === k), place: f })])));

// ------------------------------------------------------------------------------------------------ furnish one room
const tplCache = new Map();
/**
 * Furnish a room with its kit (writes k2 props / solids / hotspots into P). Identical modules (same kit, size, doors,
 * windows, and nothing else of the plan inside) re-use one solve, translated (§3.3).
 */
export function furnishV2(P, room, ctx = {}) {
  const kit = SCALE[room.space]?.kit, fn = KIT_FNS[kit];
  if (!fn) return { fill: 0, emptyR: 0, items: 0 };
  const key = tplKey(P, room, kit);
  if (key && tplCache.has(key)) { const t = tplCache.get(key); return replay(P, room, t); }
  const K = new Placer(P, room, ctx);
  const k = fn(K, ctx) || { fill: [], dress: [] };
  const s = SCALE[room.space];
  const m = K.fillLoop(k.fill || [], { emptyR: s.emptyR, fillLo: s.fill[0], maxItems: 30 });
  for (const id of k.dress || []) K.wall(id, { walls: notDoor(K, ['n', 's', 'e', 'w']) });
  const res = { fill: r2(m.fill), emptyR: r2(m.emptyR), share2: r2(m.share2), items: K.items.length };
  room.kitStat = res;
  if (key) tplCache.set(key, record(room, K, res));
  return res;
}
/** The template key: only for plain rooms (no stairs / ladders / cuts / existing solids / hotspots inside). */
function tplKey(P, r, kit) {
  if ((r.cuts || []).length) return null;
  if (P.stairs.some((s) => s.x0 < r.x1 + 1 && s.x1 > r.x0 - 1 && s.z0 < r.z1 + 1 && s.z1 > r.z0 - 1 && s.yLow <= r.y + 2.2 && s.yHigh >= r.y - 0.1)) return null;
  if (P.solidsNear(r.x0, r.x1, r.z0, r.z1).some((s) => s.x0 < r.x1 && s.x1 > r.x0 && s.z0 < r.z1 && s.z1 > r.z0 && s.y < r.y + 1.7 && s.y + s.h > r.y)) return null;
  if (P.hotspots.some((h) => Math.abs(h.y - r.y) < 0.3 && h.x >= r.x0 && h.x <= r.x1 && h.z >= r.z0 && h.z <= r.z1)) return null;
  if ((P.links || []).some((l) => [l.a, l.b].some((e) => Math.abs(e.y - r.y) < 0.1 && e.x >= r.x0 - 0.7 && e.x <= r.x1 + 0.7 && e.z >= r.z0 - 0.7 && e.z <= r.z1 + 0.7))) return null;
  const W = r2(r.x1 - r.x0), D = r2(r.z1 - r.z0);
  const doors = (r.doorList || []).map((d) => `${d.side}${r2(d.at - (d.side === 'n' || d.side === 's' ? r.x0 : r.z0))}/${d.w}`).sort().join(',');
  const wins = (r.windows || []).map((w) => `${w.side}${r2(w.from - (w.side === 'n' || w.side === 's' ? r.x0 : r.z0))}`).sort().join(',');
  const ins = r.inset ? `${r.inset.n}${r.inset.s}${r.inset.e}${r.inset.w}` : '';
  return `${kit}|${r.space}|${W}|${D}|${doors}|${wins}|${ins}|${r.berth || 0}|${r.sharedWash ? 1 : 0}`;
}
function record(r, K, res) {
  return { res, items: K.items.map((it) => ({ id: it.id, q: { x0: it.q.x0 - r.x0, x1: it.q.x1 - r.x0, z0: it.q.z0 - r.z0, z1: it.q.z1 - r.z0 }, rec: { ...it.rec, x: it.rec.x - r.x0, z: it.rec.z - r.z0, y: it.rec.y - r.y }, solidH: P_SOLID(it), hot: it.hot ? { ...it.hot, x: it.hot.x - r.x0, z: it.hot.z - r.z0 } : null })), hots: [] };
}
function P_SOLID(it) { const s = ITEMS[it.id]?.solid; return (s === true || s === undefined) && it.rec.h > 0.05 ? it.rec.h : 0; }
function replay(P, r, t) {
  for (const it of t.items) {
    P.prop('k2', { ...it.rec, x: r2(it.rec.x + r.x0), z: r2(it.rec.z + r.z0), y: r2(it.rec.y + r.y), room: r.id });
    if (it.solidH) P.solid(it.q.x0 + r.x0, it.q.x1 + r.x0, it.q.z0 + r.z0, it.q.z1 + r.z0, r.y, it.solidH, it.id);
    if (it.hot) P.hot(it.hot.kind, it.hot.label, r2(it.hot.x + r.x0), r.y, r2(it.hot.z + r.z0), it.hot.r);
  }
  r.kitStat = { ...t.res, cached: true };
  return r.kitStat;
}

// ------------------------------------------------------------------------------------------------ overhead runs
/** Frames, stiffeners, pipe racks and cable trays in an unlined space (§2.3–2.4); returns the runs added. */
export function overheadRuns(P, room, ctx = {}) {
  const s = ctx.frame || 0.7, top = room.y + room.h, out = [];
  const add = (o) => { const p = P.prop('run', { ...o, room: room.id }); out.push(p); return p; };
  const W = room.x1 - room.x0, D = room.z1 - room.z0;
  // transverse frames on the walls (flat bar + flange) every s, web frames every 4 s; deck girders fore-aft
  const z0 = Math.ceil(room.z0 / s) * s;
  add({ kind: 'frame', pts: [[room.x0, top, room.z0], [room.x1, top, room.z1]], s, web: 4 * s, z0 });
  // pipe rack: 2–4 pipes along the long axis near the ceiling, systems from the room's machinery
  const sys = ctx.sys || ['fw', 'sw', 'fuel', 'fire'];
  const alongX = W > D, len = alongX ? W : D;
  if (len > 1.5) {
    const n = Math.min(4, Math.max(2, Math.round(Math.min(W, D) / 2)));
    for (let i = 0; i < n; i++) {
      const off = 0.25 + i * 0.22, sy = sys[i % sys.length], y = top - 0.18 - (i % 2) * 0.12;
      const pts = alongX ? [[room.x0 + 0.1, y, room.z0 + off], [room.x1 - 0.1, y, room.z0 + off]] : [[room.x0 + off, y, room.z0 + 0.1], [room.x0 + off, y, room.z1 - 0.1]];
      add({ kind: 'pipe', sys: sy, color: SYS_COLOR[sy] ?? 0x888888, r: 0.04 + (i % 3) * 0.025, pts });
    }
    const tp = alongX ? [[room.x0 + 0.1, top - 0.12, room.z1 - 0.5], [room.x1 - 0.1, top - 0.12, room.z1 - 0.5]] : [[room.x1 - 0.5, top - 0.12, room.z0 + 0.1], [room.x1 - 0.5, top - 0.12, room.z1 - 0.1]];
    add({ kind: 'tray', w: 0.4, h: 0.08, pts: tp });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ lights
/** Fixtures of a room (§5.1). Pushes into P.lights; returns them. */
export function roomLights(P, room, ctx = {}) {
  const L = P.lights || (P.lights = []);
  const sp = room.space, s = SCALE[sp] || {}, W = room.x1 - room.x0, D = room.z1 - room.z0, A = W * D;
  const top = room.y + room.h - 0.02, out = [];
  const add = (o) => { const l = { id: `L${L.length}`, room: room.id, y: r2(top), em: false, night: 'on', ...o, x: r2(o.x), z: r2(o.z) }; L.push(l); out.push(l); return l; };
  const circ = s.circulation;
  if (room.open) {
    if (A > 30) add({ kind: 'flood', x: (room.x0 + room.x1) / 2, z: (room.z0 + room.z1) / 2, y: r2(room.y + 3.0), lm: 900, night: 'on' });
    return out;
  }
  if (circ) {
    const alongX = W >= D, len = Math.max(W, D), n = Math.max(1, Math.round(len / 2.4));
    for (let i = 0; i < n; i++) { const t = (i + 0.5) / n; add({ kind: 'panel', x: alongX ? room.x0 + W * t : (room.x0 + room.x1) / 2, z: alongX ? (room.z0 + room.z1) / 2 : room.z0 + D * t, lm: 400, night: sp === 'cabin_lobby' ? 'on' : 'dim' }); }
    const ne = Math.max(1, Math.ceil(len / 10));
    for (let i = 0; i < ne; i++) { const t = (i + 0.5) / ne; add({ kind: 'bulkhead', em: true, x: alongX ? room.x0 + W * t : room.x0 + 0.15, z: alongX ? room.z0 + 0.15 : room.z0 + D * t, y: r2(room.y + 2.0), lm: 80, night: 'on' }); }
    return out;
  }
  const unlined = !s.lined || s.unlined;
  const per = sp === 'mess' || sp === 'galley' || sp === 'recreation' || sp === 'lounge_crew' ? 6 : unlined ? 9 : sp === 'bridge' ? 12 : 8;
  const n = Math.max(1, Math.round(A / per));
  const cols = Math.max(1, Math.round(Math.sqrt(n * W / Math.max(D, 0.1)))), rows = Math.max(1, Math.ceil(n / cols));
  for (let a = 0; a < cols; a++) for (let b = 0; b < rows; b++) {
    const kind = unlined ? 'strip' : sp === 'galley' || sp === 'cold_room' || sp === 'provisions_dry' ? 'bulkhead' : 'panel';
    add({ kind, x: room.x0 + (W * (a + 0.5)) / cols, z: room.z0 + (D * (b + 0.5)) / rows, lm: sp === 'galley' || sp === 'ecr' || sp === 'ccr' ? 900 : sp === 'bridge' ? 500 : unlined ? 700 : 450, night: sp === 'bridge' ? 'off' : sp.startsWith('cabin') || sp.startsWith('suite') ? 'dim' : 'on', axis: W >= D ? 'x' : 'z', len: kind === 'strip' ? 1.2 : 0.6 });
  }
  if (sp === 'bridge' || sp === 'ecr' || sp === 'steering_gear' || sp === 'ccr' || unlined) add({ kind: 'bulkhead', em: true, x: room.x0 + 0.2, z: (room.z0 + room.z1) / 2, y: r2(room.y + 2.0), lm: 80 });
  if (sp === 'bridge') { const c = (room.x0 + room.x1) / 2; for (const dx of [-W / 4, W / 4]) add({ kind: 'red', x: c + dx, z: room.z0 + Math.min(2.5, D / 2), lm: 60, night: 'red' }); }
  if (s.berth || sp === 'suite_day') { for (const it of (ctx.propsByRoom?.get(room.id) || P.props)) { if (it.t !== 'k2' || it.room !== room.id) continue; if (it.item === 'bunk' || it.item === 'bunk2' || it.item === 'bed_double') add({ kind: 'spot', x: it.x, z: it.z, y: r2(room.y + 1.1), lm: 120, night: 'dim' }); if (it.item === 'desk' || it.item === 'desk_office') add({ kind: 'spot', x: it.x, z: it.z, y: r2(room.y + 1.2), lm: 150, night: 'on' }); } }
  void ctx;
  return out;
}

// ------------------------------------------------------------------------------------------------ engine-room packer
/**
 * Lane M placement (§4.6): per ER room (strip of a level) a circulation skeleton — a 1.2 m walkway along the edge open
 * to the engine, longitudinal aisles between rows on wide wings, cross aisles every ≤ 8 m, connectors to every door,
 * stair end, ladder and hotspot — then the equipment list against the hull side and in rows, then fill machinery on a
 * 1 m anchor grid. One walk check per room at the end (rolling back the fill until it holds).
 */
export function packEngineRoomV2(P, rooms, queue, ctx = {}) {
  const placers = new Map();
  const mk = (r) => { if (!placers.has(r)) { P.zone = r.zone; const K = new Placer(P, r, ctx); K.noCheck = true; skeleton(K); placers.set(r, K); } return placers.get(r); };
  const sidesOf = (r) => (r.tag === 'p' ? ['w', 'n', 's', 'e'] : r.tag === 's' ? ['e', 'n', 's', 'w'] : ['n', 's', 'w', 'e']);
  // 1. the listed equipment on its level
  const byLevel = new Map(); for (const r of rooms) { if (!byLevel.has(r.level)) byLevel.set(r.level, []); byLevel.get(r.level).push(r); }
  for (const l of byLevel.values()) l.sort((a, b) => (b.x1 - b.x0) * (b.z1 - b.z0) - (a.x1 - a.x0) * (a.z1 - a.z0));
  const levels = [...byLevel.keys()].sort((a, b) => a - b);
  for (const e of queue) {
    const it = ITEMS[e.item]; if (!it) continue;
    const want = e.level ?? 0;
    let done = false;
    for (const lv of [want, ...levels.filter((l) => l !== want)]) {
      for (const r of byLevel.get(lv) || []) {
        const K = mk(r); P.zone = r.zone;
        const extra = { prop: { label: e.label || null, sys: e.sys || [] } };
        const res = it.wall ? K.wall(e.item, { walls: sidesOf(r), at: 'center', ...extra }) : K.freeAt(e.item, (r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2, { maxTries: 60, ...extra });
        if (res) { done = true; break; }
      }
      if (done) break;
    }
  }
  // 2. machinery in rows: every band between two aisles packed along its length, fronts to the aisle
  const FILL = ctx.fill || ['heater_skid', 'cooler_plate', 'pump_h', 'pump_v', 'air_receiver', 'compressor', 'spares_rack', 'pump_v', 'local_stand', 'drum_stack', 'pump_h', 'crate_stack', 'shelf_rack'];
  for (const r of rooms) {
    const K = mk(r); P.zone = r.zone;
    const n0 = K.items.length;
    let k = (r.level || 0) * 3;
    const rowAlong = (x0f, x1f, faceE, atBack = false) => {   // one row between x0f..x1f, fronts east (faceE) or west, at the aisle edge (or back to the hull)
      const bw = x1f - x0f, rot = faceE ? Math.PI / 2 : -Math.PI / 2;
      for (let z = r.z0 + 0.15; z < r.z1 - 0.4;) {
        let placed = false;
        for (let t = 0; t < FILL.length && !placed; t++) {
          const id = FILL[(k + t) % FILL.length], it = ITEMS[id];
          if (it.d > bw || z + it.w > r.z1 - 0.1) continue;
          const front = faceE !== atBack;   // the item's front edge sits on x1f (east) or x0f (west)
          const xa = front ? x1f - it.d : x0f, q = { x0: xa, x1: xa + it.d, z0: z, z1: z + it.w };
          if (!K.free(q)) continue;
          if (K.put(id, q, rot, { front: 0, prop: { sys: id.startsWith('pump') ? [['sw', 'fw', 'lo', 'fire', 'fuel'][(k + t) % 5]] : [] } })) { placed = true; k++; z += it.w + 0.3; }
        }
        if (!placed) z += 0.25;
      }
    };
    for (const band of K.bands || []) {
      const bw = band.x1 - band.x0;
      if (band.aisles.length === 2 && bw >= 1.5) { rowAlong(band.x0 + 0.05, band.x0 + bw / 2 - 0.05, false); rowAlong(band.x0 + bw / 2 + 0.05, band.x1 - 0.05, true); }
      else if (band.aisles.includes('e')) { rowAlong(band.x0 + 0.05, band.x1 - 0.05, true); if (bw > 1.9) rowAlong(band.x0 + 0.05, band.x1 - 1.4, true, true); }   // at the aisle, then against the hull
      else { rowAlong(band.x0 + 0.05, band.x1 - 0.05, false); if (bw > 1.9) rowAlong(band.x0 + 1.4, band.x1 - 0.05, false, true); }
    }
    // leftover spots on a 1.3 m anchor grid
    const ext = (i, j, di, dj) => { let n = 0; for (;;) { i += di; j += dj; if (i < 0 || j < 0 || i >= K.nx || j >= K.nz) break; const c = K.idx(i, j); if (K.keep[c] || K.lanes?.[c] || K.solid[c] || K.block[c]) break; if (++n > 40) break; } return n * K.c; };
    const sizes = FILL.map((id) => ITEMS[id]).map((it) => [Math.min(it.w, it.d), Math.max(it.w, it.d)]);
    for (let z = r.z0 + 0.7; z < r.z1 - 0.5; z += 1.3) for (let x = r.x0 + 0.7; x < r.x1 - 0.5; x += 1.3) {
      const i = K.ci(x), j = K.cj(z); if (i < 0 || j < 0 || i >= K.nx || j >= K.nz) continue;
      const c = K.idx(i, j); if (K.keep[c] || K.lanes?.[c] || K.solid[c] || K.block[c]) continue;
      const ex = ext(i, j, 1, 0) + ext(i, j, -1, 0) + K.c, ez = ext(i, j, 0, 1) + ext(i, j, 0, -1) + K.c;
      const lo = Math.min(ex, ez), hi = Math.max(ex, ez);
      if (lo < 0.55) continue;
      for (let t = 0; t < FILL.length; t++) { const ti = (t + k) % FILL.length; if (sizes[ti][0] > lo || sizes[ti][1] > hi) continue; if (K.freeAt(FILL[ti], x, z, { maxTries: 4, margin: 0.2 })) { k++; break; } }
    }
    // the walk check, once: roll the fill back until every door / stair / ladder / hotspot is connected again
    K.noCheck = false;
    if (globalThis.__iv2debugRoom === r.id) { const g = K.baseline(); console.log('[iv2dbg]', r.id, 'targets', JSON.stringify(K.targets.map((t) => [+t.x.toFixed(2), +t.z.toFixed(2)])), 'groups', JSON.stringify(g), 'connected', K.connected(), 'items', K.items.length - n0); }
    if (!K.connected()) K.repair(0);
    // last holes (checked per item): small machinery and stores where the floor is still bare
    K.noCheck = false;
    K.fillLoop(['cooler_plate', 'pump_h', 'pump_v', 'air_receiver', 'drum_stack', 'local_stand', 'crate_stack', 'spares_rack'], { emptyR: 1.45, fillLo: 0, maxItems: 30 });
    K.softLanes = true;
    let m = K.fillLoop(['drum_stack', 'pump_v', 'air_receiver', 'crate_stack', 'local_stand'], { emptyR: 1.45, fillLo: 0, maxItems: 16 });
    // floor further than 2 m from any equipment (§8.1 A2): a small unit at the far spot, until ≥ 85 % is near
    K.skipFar = new Set();
    for (let t = 0; t < 14 && m.share2 < 0.85 && m.far; t++) {
      const f = m.far; let ok = null;
      const ids = ['pump_v', 'drum_stack', 'local_stand', 'cooler_plate', 'air_receiver'];
      for (const id of ids) if ((ok = K.freeAt(id, f.x, f.z, { maxTries: 30, margin: 0.2 }))) break;
      if (!ok) {   // at a wall: flush against the nearest side, beside whatever keeps the middle clear
        const dist = { w: f.x - r.x0, e: r.x1 - f.x, n: f.z - r.z0, s: r.z1 - f.z }, side = Object.keys(dist).sort((a, b) => dist[a] - dist[b])[0];
        const u = side === 'n' || side === 's' ? f.x : f.z;
        for (const id of ids) if ((ok = K.wall(id, { walls: [side], at: u - (ITEMS[id].w / 2), within: 1.2 }))) break;
      }
      if (!ok) { for (let a = -3; a <= 3; a++) for (let b = -3; b <= 3; b++) K.skipFar.add(f.k + a + b * (K.metricsNx || 0)); }
      m = K.metrics();
    }
    K.softLanes = false;
    // a strip that is mostly circulation (openings on several sides, walkways, landings) is a walkway junction
    let circ = 0, tot = 0;
    for (let c = 0; c < K.solid.length; c++) { if (K.block[c]) continue; tot++; if (K.keep[c] || K.lanes?.[c]) circ++; }
    const openings = K.doors.filter((d) => d.w >= 1.4).length;
    r.circShare = tot ? r2(circ / tot) : 0;
    // the walkways of this bay (§4.6): skeleton lanes and door approaches — circulation, not bare floor
    r.walkways = [...(K.laneRects || []), ...K.doors.map((d) => ({ x0: r2(d.ap.x0), x1: r2(d.ap.x1), z0: r2(d.ap.z0), z1: r2(d.ap.z1) }))];
    if (K.area < 60 && (m.emptyR > 1.6 || m.share2 < 0.8) && (openings >= 3 || r.circShare > 0.5)) { r.space = 'er_walkway'; r.name = 'Engine room walkway'; }
    r.kitStat = { fill: r2(m.fill), emptyR: r2(m.emptyR), share2: r2(m.share2), items: K.items.length };
  }
  return placers;
}
function skeleton(K) {
  const r = K.r, W = r.x1 - r.x0, D = r.z1 - r.z0;
  const inner = r.tag === 'p' ? 'e' : r.tag === 's' ? 'w' : null;
  // walkway along the engine side (or both long sides of the centre strip), 1.2 m
  if (inner === 'e') K.lane({ x0: r.x1 - 1.3, x1: r.x1, z0: r.z0, z1: r.z1 });
  else if (inner === 'w') K.lane({ x0: r.x0, x1: r.x0 + 1.3, z0: r.z0, z1: r.z1 });
  // round the machinery already there (main engine, gensets): 0.9 m
  for (const s of K.P.solidsNear(r.x0, r.x1, r.z0, r.z1)) {
    if (!(s.y < r.y + 1.7 && s.y + s.h > r.y + 0.05) || !K.overlaps(s)) continue;
    if (!['engine', 'generator', 'console', 'steering', 'boiler'].includes(s.tag)) continue;
    K.lane({ x0: s.x0 - 1.1, x1: s.x1 + 1.1, z0: s.z0 - 1.1, z1: s.z1 + 1.1 });
  }
  // longitudinal aisles between rows on wide strips (rows ≤ 2.6 m deep from the hull side inward); the bands between
  // them are packed with machinery facing the aisle
  K.bands = [];
  if (r.tag !== 'c') {
    const hull = r.tag === 'p' ? r.x0 : r.x1, dir = r.tag === 'p' ? 1 : -1, innerW = 1.2;
    const toward = dir > 0 ? 'e' : 'w', back = dir > 0 ? 'w' : 'e';
    let start = 0, first = true;
    for (let off = 2.7; off < W - innerW - 1.4; off += 4.8) {
      const x = hull + dir * off; K.lane({ x0: Math.min(x, x + dir * 1.2), x1: Math.max(x, x + dir * 1.2), z0: r.z0, z1: r.z1 });
      const a = hull + dir * start, b = hull + dir * off; K.bands.push({ x0: Math.min(a, b), x1: Math.max(a, b), aisles: first ? [toward] : ['w', 'e'] });
      start = off + 1.2; first = false;
    }
    const a = hull + dir * start, b = hull + dir * (W - innerW);
    if (Math.abs(b - a) >= 0.7) K.bands.push({ x0: Math.min(a, b), x1: Math.max(a, b), aisles: first ? [toward] : ['w', 'e'] });
    void back;
  } else if (W > 3.4 && W <= 5) {
    const m = (r.x0 + r.x1) / 2; K.bands.push({ x0: m - Math.min(0.8, (W - 2.6) / 2), x1: m + Math.min(0.8, (W - 2.6) / 2), aisles: ['w', 'e'] });
  } else if (W > 5) {
    let start = 0;
    for (let off = 3.2; off < W - 1.4; off += 4.4) { K.lane({ x0: r.x0 + off, x1: r.x0 + off + 1.2, z0: r.z0, z1: r.z1 }); K.bands.push({ x0: r.x0 + start, x1: r.x0 + off, aisles: start ? ['w', 'e'] : ['e'] }); start = off + 1.2; }
    if (W - start >= 0.7) K.bands.push({ x0: r.x0 + start, x1: r.x1, aisles: ['w'] });
  }
  // cross aisles every ≤ 8 m
  const nC = D > 3.5 ? Math.max(1, Math.ceil(D / 8) - 1) : 0;
  for (let i = 1; i <= nC; i++) { const z = r.z0 + (D * i) / (nC + 1); K.lane({ x0: r.x0, x1: r.x1, z0: z - 0.6, z1: z + 0.6 }); }
  if (!inner && r.tag !== 'c') K.lane({ x0: r.x0, x1: r.x1, z0: (r.z0 + r.z1) / 2 - 0.6, z1: (r.z0 + r.z1) / 2 + 0.6 });
  // every target joined to the skeleton
  for (const t of K.targets) K.connect(t, 1.2);
}
