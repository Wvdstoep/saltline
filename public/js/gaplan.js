// Walkable deck plans from the general arrangement (docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §6, Lane C).
// planFromGA(GA, opts) → the Plan shape of shipplan.js (rooms, doors, stairs, solids, props, hotspots, rails, deck,
// spawn, helm, levels) so walker.js and interior.js work unchanged, plus additive keys:
//   plan.zones    [{ id, name, y0, y1, near: [zoneId] }]   streaming groups (house, er, deck, fwd, cargo, deck:<n>)
//   room.zone / prop.zone / solid.zone / stair.zone        which group draws it
//   plan.goto     [{ id, label, x, y, z }]                  Go-to points, each on a standable floor
//   plan.links    [{ a: {x,y,z}, b: {x,y,z}, kind: 'ladder' }]   ladders the walker climbs with a hotspot (§6.5)
//   plan.deckGroup  the cruise / ferry deck this plan was built for (per-deck loading)
//   hotspot kinds added (§6.5): telegraph, thrusters, gmdss, whistle, ecr, steering, ccr, crane, winch, gangway,
//   ladder (with `to`), goto, galley, hospital, muster, lab, info
// Pure (no three.js, no DOM): the node tests walk every catalogue model with the game's own walker.
import { generalArrangement, hullHalf, deckHalf, outlineHalf, fitHalf, demihullAt, RULES, stairRun } from '../../shared/ships/ga.js';
import { IV2_READY } from '../../shared/ships/gaspace.js';   // IV2 HV1
import { planV2 } from './gaplan2.js';                         // IV2 HV1
import { cruiseDeckPlan, cruiseGotoSeeds } from './gacruise.js';                // cruise decks of interiors v2 (docs/CRUISE-CONTRACT.md §4)

export const R = 0.25;          // walker radius (shipplan.js R)
export const STEP = 0.32;       // shipplan.js STEP
const EDGE = 0.45, RAIL_IN = 0.15, HULL_IN = 0.3;
const { CORRIDOR: CW, FLIGHT: FL, LAND } = RULES;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const r2 = (v) => Math.round(v * 100) / 100;
const tanD = (d) => Math.tan((d * Math.PI) / 180);

/** Planners per GA layout ('big' is planBig; small craft, passenger ships, ro-ro register below). */
export const PLANNERS = {};

// ------------------------------------------------------------------------------------------------ plan builder
function fullOutline(half) {
  const right = half.map(([x, z]) => [x, z]);
  const left = half.slice().reverse().map(([x, z]) => [-x, z]);
  return right.concat(left.slice(1));
}
class GPlan {
  constructor(ga) {
    this.ga = ga; this.cls = ga.id; this.L = ga.L; this.B = ga.B; this.F = ga.F; this.draft = ga.T; this.deckY = ga.deckY;
    this.rooms = []; this.doors = []; this.stairs = []; this.solids = []; this.props = []; this.hotspots = []; this.rails = [];
    this.links = []; this.goto = []; this.zoneList = new Map(); this.zone = 'deck';
    this.half = outlineHalf(ga, 72);
    this.deck = { y: ga.deckY, polys: [fullOutline(this.half)], holes: [] };
    this.spawn = null; this.helm = null; this.levels = []; this.edge = EDGE; this.railInset = 0.3; this.style = 'ship';
    this.byIdMap = new Map(); this.reserved = []; this.sgrid = new Map();
  }
  /** Keep furniture off a stair footprint (+ landings) that is created later. */
  reserve(x0, x1, z0, z1, y0, y1) { this.reserved.push({ x0, x1, z0, z1, y0, y1 }); }
  hb(z) { return deckHalf(this.ga, z); }
  minHb(z0, z1) { let m = Infinity; for (let i = 0; i <= 16; i++) m = Math.min(m, this.hb(Math.min(z0, z1) + (Math.abs(z1 - z0) * i) / 16)); return m; }
  /** Half-width a closed room z0..z1 at y..y+h may have inside the plating (above the deck: unlimited by the hull). */
  fit(z0, z1, y, h) { return y >= this.deckY - 0.05 ? Infinity : fitHalf(this.ga, z0, z1, y, Math.min(y + h, this.deckY)) - HULL_IN; }
  byId(id) { return this.byIdMap.get(id) || null; }
  setZone(z, meta = {}) { this.zone = z; if (!this.zoneList.has(z)) this.zoneList.set(z, { id: z, name: meta.name || z, y0: Infinity, y1: -Infinity, near: new Set(meta.near || []) }); return this; }
  room(o) {
    const open = !!o.open;
    const r = {
      kind: 'room', name: o.id, h: 2.4, walk: true, floor: 'lino', wall: 'white', ceiling: !open, dark: false, drawFloor: true,
      windows: [], floorHoles: [], ceilHoles: [], cuts: [], zone: this.zone, ...o, open,
      walls: { ...(open ? { n: false, s: false, e: false, w: false } : { n: true, s: true, e: true, w: true }), ...(o.walls || {}) },
      inset: { n: R, s: R, e: R, w: R, ...(o.inset || {}) },
    };
    for (const k of ['x0', 'x1', 'z0', 'z1', 'y', 'h']) r[k] = r2(r[k]);
    if (r.x1 - r.x0 < 0.5 || r.z1 - r.z0 < 0.5) throw new Error(`[gaplan] ${this.cls}: room ${r.id} is degenerate (${r.x0},${r.x1},${r.z0},${r.z1})`);
    if (this.byIdMap.has(r.id)) throw new Error(`[gaplan] ${this.cls}: duplicate room id ${r.id}`);
    this.rooms.push(r); this.byIdMap.set(r.id, r); r.doorList = [];
    const z = this.zoneList.get(r.zone); if (z) { z.y0 = Math.min(z.y0, r.y); z.y1 = Math.max(z.y1, r.y + r.h); }
    return r;
  }
  door(a, b, side, at, w = 0.95, h = 2.05, kind = 'door') {
    const d = { a: a.id, b: b ? b.id : null, side, at: r2(at), w, h: Math.min(h, a.h - 0.05, b && !b.open ? b.h - 0.05 : h), kind, y: a.y };
    this.doors.push(d); a.doorList.push(d);
    if (b) { const opp = { n: 's', s: 'n', e: 'w', w: 'e' }[side]; b.doorList.push({ ...d, side: opp, mirror: true }); }
    return d;
  }
  opening(a, b, side, at, w) { return this.door(a, b, side, at, w, 2.2, 'open'); }
  stair(o) {
    const s = { kind: 'stair', zone: this.zone, ...o };
    s.id = s.id || `stair-${this.stairs.length}`;
    for (const k of ['x0', 'x1', 'z0', 'z1', 'yLow', 'yHigh']) s[k] = r2(s[k]);
    this.stairs.push(s);
    return s;
  }
  solid(x0, x1, z0, z1, y, h = 1.2, tag = '') {
    const s = { x0: r2(Math.min(x0, x1)), x1: r2(Math.max(x0, x1)), z0: r2(Math.min(z0, z1)), z1: r2(Math.max(z0, z1)), y, h, tag, zone: this.zone };
    this.solids.push(s);
    for (let i = Math.floor(s.x0 / 4); i <= Math.floor(s.x1 / 4); i++) for (let j = Math.floor(s.z0 / 4); j <= Math.floor(s.z1 / 4); j++) { const k = i * 100003 + j; let l = this.sgrid.get(k); if (!l) { l = []; this.sgrid.set(k, l); } l.push(s); }
    return s;
  }
  /** Solids whose footprint may touch the rect (spatial hash, 4 m cells). */
  solidsNear(x0, x1, z0, z1) {
    const out = [], stamp = (this._stamp = (this._stamp || 0) + 1);
    for (let i = Math.floor(x0 / 4); i <= Math.floor(x1 / 4); i++) for (let j = Math.floor(z0 / 4); j <= Math.floor(z1 / 4); j++) {
      const l = this.sgrid.get(i * 100003 + j); if (!l) continue;
      for (const s of l) if (s._st !== stamp) { s._st = stamp; out.push(s); }
    }
    return out;
  }
  prop(t, o = {}) { const p = { t, zone: this.zone, ...o }; this.props.push(p); return p; }
  hot(kind, label, x, y, z, r = 1.4, extra = {}) { const h = { kind, label, x: r2(x), y, z: r2(z), r, zone: this.zone, ...extra }; this.hotspots.push(h); return h; }
  window(room, side, from, to, bottom = 1.0, top = 2.1) { if (to - from > 0.3) room.windows.push({ side, from: r2(from), to: r2(to), bottom, top: Math.min(top, room.h - 0.15) }); }
  rail(pts, y) { this.rails.push({ pts: pts.map(([x, z]) => [r2(x), r2(z)]), y, zone: this.zone }); }
  sign(x, y, z, rotY, lines) { this.prop('sign', { x, y, z, rotY, lines }); }
  /** A ladder the walker climbs with E (hotspot at each end, `to` = where you arrive). */
  ladder(a, b, label, prop = null) {
    this.links.push({ a, b, kind: 'ladder', label });
    this.hot('ladder', `Climb ${b.y > a.y ? 'up' : 'down'}: ${label}`, a.x, a.y, a.z, 1.1, { to: { x: b.x, y: b.y, z: b.z } });
    this.hot('ladder', `Climb ${a.y > b.y ? 'up' : 'down'}: back`, b.x, b.y, b.z, 1.1, { to: { x: a.x, y: a.y, z: a.z } });
    if (prop) this.prop('ladder', prop);
  }
  /** Open deck strips at height y following the hull outline between z0 (fwd) and z1 (aft) — shipplan.js deckStrips. */
  deckStrips(id, z0, z1, y, { name = 'Main deck', len = 6, drawFloor = false, endN = RAIL_IN, endS = RAIL_IN, minW = 0.8, x0 = null, x1 = null, maxHalf = Infinity } = {}) {
    const out = [], cuts = [z0];
    const tol = Math.max(0.1, this.B * (this.B > 40 ? 0.02 : 0.01));   // wide ships: coarser strips (≤ 400 rooms)
    const spread = (a, b) => { let lo = Infinity, hi = -Infinity; for (let k = 0; k <= 8; k++) { const h = this.hb(a + ((b - a) * k) / 8); lo = Math.min(lo, h); hi = Math.max(hi, h); } return hi - lo; };
    for (let z = z0; z < z1 - 1e-6;) {
      let step = Math.min(len, z1 - z);
      while (step > 0.6 && spread(z, z + step) > tol) step = Math.max(0.6, step * 0.6);
      z = Math.min(z1, z + step);
      if (z1 - z < 0.6) z = z1;
      cuts.push(z);
    }
    const n = cuts.length - 1;
    for (let i = 0; i < n; i++) {
      const a = cuts[i], b = cuts[i + 1];
      const hw = Math.min(maxHalf, this.minHb(a, b) - this.edge);
      if (hw * 2 < minW) continue;
      out.push(this.room({ id: `${id}-${i}`, kind: 'deck', name, open: true, x0: x0 ?? -hw, x1: x1 ?? hw, z0: a, z1: b, y, h: 2.4, floor: 'deck', drawFloor,
        inset: { e: RAIL_IN, w: RAIL_IN, n: i === 0 ? endN : 0, s: i === n - 1 ? endS : 0 } }));
    }
    return out;
  }
  hullRails(z0, z1, y, inset = this.railInset, sides = [-1, 1]) {
    for (const side of sides) {
      const pts = [];
      for (let z = z0; z <= z1 + 1e-6; z += Math.max(0.5, (z1 - z0) / 40)) pts.push([side * Math.max(0, this.hb(z) - inset), z]);
      if (pts.length > 1) this.rail(pts, y);
    }
  }
  /** The open-deck room at (x, z, y), or null. */
  openAt(x, z, y) { return this.rooms.find((r) => r.open && Math.abs(r.y - y) < 0.06 && x >= r.x0 - 0.01 && x <= r.x1 + 0.01 && z >= r.z0 - 0.01 && z <= r.z1 + 0.01) || null; }
  roomAt(x, z, y) { let best = null, ba = Infinity; for (const r of this.rooms) { if (Math.abs(r.y - y) > 0.06 || x < r.x0 || x > r.x1 || z < r.z0 || z > r.z1) continue; const a = (r.x1 - r.x0) * (r.z1 - r.z0); if (a < ba) { ba = a; best = r; } } return best; }

  /**
   * A tall house (≥ 4 tiers) is streamed one tier at a time: zone `house` keeps the lowest tier (and everything the
   * other zones call `house`), tier k becomes `house:k` with its neighbours as `near`; `group: 'house'` lets a desktop
   * show a few tiers more (visibleZones). Keeps phones within §6.6 on the 10–12-tier houses of big ships.
   */
  splitHouse() {
    const tiers = this.ga.house?.tiers || [];
    const base = this.zoneList.get('house');
    if (tiers.length < 4 || !base) return;
    const ys = tiers.map((t) => t.y);
    const idOf = (k) => (k === 0 ? 'house' : `house:${k}`);
    const band = (y) => { let k = 0; for (let i = 0; i < ys.length; i++) if (y >= ys[i] - 0.3) k = i; return idOf(k); };
    base.group = 'house'; base.name = `Accommodation — ${tiers[0].name}`; base.near.add('house:1');
    for (let k = 1; k < tiers.length; k++) this.zoneList.set(idOf(k), { id: idOf(k), name: tiers[k].id === 'nav' ? 'Bridge' : `Accommodation — ${tiers[k].name}`, group: 'house', y0: Infinity, y1: -Infinity, near: new Set([idOf(k - 1), ...(k + 1 < tiers.length ? [idOf(k + 1)] : [])]) });
    const yOf = { rooms: (o) => o.y, stairs: (o) => o.yLow, solids: (o) => o.y, props: (o) => o.y ?? o.y0, hotspots: (o) => o.y, rails: (o) => o.y };
    for (const [key, f] of Object.entries(yOf)) for (const o of this[key]) { if (o.zone !== 'house') continue; const y = f(o); if (Number.isFinite(y)) o.zone = band(y); }
    for (const g of this.goto || []) if (g.zone === 'house' && Number.isFinite(g.y)) g.zone = band(g.y);
    base.y0 = Infinity; base.y1 = -Infinity;
    for (const r of this.rooms) { const z = this.zoneList.get(r.zone); if (z && z.group === 'house') { z.y0 = Math.min(z.y0, r.y); z.y1 = Math.max(z.y1, r.y + r.h); } }
    for (const [, z] of this.zoneList) if (!Number.isFinite(z.y0)) { z.y0 = 0; z.y1 = 0; }
  }
  /**
   * A cruise / ro-pax deck (per-deck plans) is streamed by section between the stair towers (the main vertical fire
   * zones): `deck:<id>` keeps the forward section (bridge included), section k becomes `deck:<id>.s<k>`; each section's
   * `near` is the sections either side plus the neighbour-deck landings. Phones show the section ± 1 (§6.6).
   */
  splitDeck() {
    const zid = this.deckGroup ? `deck:${this.deckGroup}` : null, base = zid && this.zoneList.get(zid);
    if (!base) return;
    const towers = this.rooms.filter((r) => r.zone === zid && r.kind === 'stairs' && /-t\d+$/.test(r.id)).map((r) => r.z0).sort((a, b) => a - b);
    if (towers.length < 2) return;
    const idOf = (k) => (k === 0 ? zid : `${zid}.s${k}`);
    const sec = (z) => { let k = 0; for (const t of towers) if (z >= t - 0.01) k++; return idOf(k); };
    const others = [...base.near];
    base.group = zid;
    for (let k = 1; k <= towers.length; k++) this.zoneList.set(idOf(k), { id: idOf(k), name: `${base.name} — section ${k + 1}`, group: zid, y0: base.y0, y1: base.y1, near: new Set([idOf(k - 1), ...(k < towers.length ? [idOf(k + 1)] : []), ...others]) });
    base.near = new Set([idOf(1), ...others]);
    const zc = { rooms: (o) => (o.z0 + o.z1) / 2, stairs: (o) => (o.z0 + o.z1) / 2, solids: (o) => (o.z0 + o.z1) / 2, props: (o) => o.z ?? ((o.z0 ?? 0) + (o.z1 ?? 0)) / 2, hotspots: (o) => o.z, rails: (o) => o.pts.reduce((a, q) => a + q[1], 0) / o.pts.length };
    for (const [key, f] of Object.entries(zc)) for (const o of this[key]) { if (o.zone !== zid) continue; const z = f(o); if (Number.isFinite(z)) o.zone = sec(z); }
  }
  finish() {
    for (const s of this.stairs) {
      const rect = { x0: s.x0, x1: s.x1, z0: s.z0, z1: s.z1 };
      for (const r of this.rooms) {
        const ix0 = Math.max(r.x0, rect.x0), ix1 = Math.min(r.x1, rect.x1), iz0 = Math.max(r.z0, rect.z0), iz1 = Math.min(r.z1, rect.z1);
        if (ix1 - ix0 < 0.05 || iz1 - iz0 < 0.05) continue;
        const hole = { x0: ix0, x1: ix1, z0: iz0, z1: iz1 };
        if (r.y > s.yLow + 0.2 && r.y <= s.yHigh + 0.05) r.floorHoles.push(hole);
        const top = r.y + r.h;
        if (!r.open && r.ceiling !== false && r.y < s.yHigh - 0.2 && top > s.yLow + 0.2 && top < s.yHigh + 0.4) r.ceilHoles.push(hole);
      }
      if (s.yLow < this.deckY - 0.3 && s.yHigh > this.deckY - 0.3) this.deck.holes.push(rect);
    }
    for (const r of this.rooms) { for (const c of r.cuts) { r.floorHoles.push(c); if (r.ceiling !== false) r.ceilHoles.push(c); } delete r.doorList; }
    // low spaces under a deck: furniture on the deck above must not reach down into the walker's body below
    for (const r of this.rooms) {
      if (r.walk === false) continue;
      for (const s of this.solidsNear(r.x0, r.x1, r.z0, r.z1)) {
        if (r.y >= s.y - 0.3 || r.y + 1.72 <= s.y || r.x0 >= s.x1 || r.x1 <= s.x0 || r.z0 >= s.z1 || r.z1 <= s.z0) continue;
        const ny = r2(r.y + 1.72); s.h = r2(s.h - (ny - s.y)); s.y = ny;
      }
    }
    this.solids = this.solids.filter((s) => s.h > 0.05);
    for (const s of this.solids) delete s._st;
    this.splitHouse(); this.splitDeck();
    const zones = [...this.zoneList.values()].map((z) => ({ id: z.id, name: z.name, y0: r2(z.y0), y1: r2(z.y1), near: [...z.near], ...(z.group ? { group: z.group } : {}) }));
    return {
      cls: this.cls, L: this.L, B: this.B, F: this.F, deckY: this.deckY, gen: this.ga.gen,
      rooms: this.rooms, doors: this.doors, stairs: this.stairs, solids: this.solids, props: this.props, hotspots: this.hotspots,
      rails: this.rails, deck: this.deck, spawn: this.spawn, helm: this.helm, levels: this.levels, style: this.style, house: this.house || null,
      zones, goto: this.goto, links: this.links, deckGroup: this.deckGroup ?? null,
    };
  }
}

function rectMinus(r, holes) {
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
// ------------------------------------------------------------------------------------------------ furniture
/** Free floor for a furniture footprint: inside the room, clear of door approaches, stairs and other solids. */
/** What can collide with furniture in room r (stairs, reserved strips, solids near it): computed once per placement. */
function nearOf(P, r, m = 2.5) {
  const hit = (s) => s.x0 < r.x1 + m && s.x1 > r.x0 - m && s.z0 < r.z1 + m && s.z1 > r.z0 - m;
  return { stairs: P.stairs.filter(hit), reserved: P.reserved.filter(hit), solids: P.solidsNear(r.x0 - m, r.x1 + m, r.z0 - m, r.z1 + m) };
}
function freeRect(P, r, q, pad = 0.75, pre = null) {
  if (q.x0 < r.x0 - 1e-6 || q.x1 > r.x1 + 1e-6 || q.z0 < r.z0 - 1e-6 || q.z1 > r.z1 + 1e-6) return false;
  for (const d of r.doorList || []) {
    const span = d.w / 2 + 0.35, depth = 1.15;
    let zx0, zx1, zz0, zz1;
    if (d.side === 'n') { zx0 = d.at - span; zx1 = d.at + span; zz0 = r.z0; zz1 = r.z0 + depth; }
    else if (d.side === 's') { zx0 = d.at - span; zx1 = d.at + span; zz0 = r.z1 - depth; zz1 = r.z1; }
    else if (d.side === 'w') { zx0 = r.x0; zx1 = r.x0 + depth; zz0 = d.at - span; zz1 = d.at + span; }
    else { zx0 = r.x1 - depth; zx1 = r.x1; zz0 = d.at - span; zz1 = d.at + span; }
    if (q.x0 < zx1 && q.x1 > zx0 && q.z0 < zz1 && q.z1 > zz0) return false;
  }
  for (const s of pre ? pre.stairs : P.stairs) { if (s.yLow > r.y + 2.2 || s.yHigh < r.y - 0.1) continue; if (q.x0 < s.x1 + 0.3 && q.x1 > s.x0 - 0.3 && q.z0 < s.z1 + LAND && q.z1 > s.z0 - LAND) return false; }
  for (const s of pre ? pre.reserved : P.reserved) { if (s.y0 > r.y + 2.2 || s.y1 < r.y - 0.1) continue; if (q.x0 < s.x1 && q.x1 > s.x0 && q.z0 < s.z1 && q.z1 > s.z0) return false; }
  for (const s of pre && pad <= 2.5 ? pre.solids : P.solidsNear(q.x0 - pad, q.x1 + pad, q.z0 - pad, q.z1 + pad)) { if (Math.abs(s.y - r.y) > 0.1 && !(s.y < r.y + 1.7 && s.y + s.h > r.y)) continue; if (q.x0 < s.x1 + pad && q.x1 > s.x0 - pad && q.z0 < s.z1 + pad && q.z1 > s.z0 - pad) return false; }
  for (const h of r.floorHoles || []) if (q.x0 < h.x1 + 0.3 && q.x1 > h.x0 - 0.3 && q.z0 < h.z1 + 0.3 && q.z1 > h.z0 - 0.3) return false;
  return true;
}
/** Try to place a w × d footprint against one of the room's walls (in order); returns the rect or null. */
function placeAgainst(P, r, w, d, walls = ['n', 'e', 'w', 's'], gap = 0.08, slide = true) {
  const pre = nearOf(P, r);
  for (const side of walls) {
    const along = side === 'n' || side === 's';
    const len = along ? r.x1 - r.x0 : r.z1 - r.z0, fw = along ? w : d, fd = along ? d : w;
    if (fw > len - 0.1) continue;
    const n = slide ? Math.max(1, Math.floor((len - fw) / 0.3)) : 0;
    const q = { x0: 0, x1: 0, z0: 0, z1: 0 };
    // candidates from the middle of the wall outward (i = n/2, then alternately either side)
    for (let t = 0; t <= n; t++) {
      const i = n ? Math.round(n / 2 + (t % 2 ? -1 : 1) * Math.ceil(t / 2)) : 0;
      if (t && (i < 0 || i > n)) continue;
      const o = n ? ((len - fw - 0.1) * i) / n + 0.05 : (len - fw) / 2;
      if (side === 'n') { q.x0 = r.x0 + o; q.x1 = r.x0 + o + fw; q.z0 = r.z0 + gap; q.z1 = r.z0 + gap + fd; }
      else if (side === 's') { q.x0 = r.x0 + o; q.x1 = r.x0 + o + fw; q.z0 = r.z1 - gap - fd; q.z1 = r.z1 - gap; }
      else if (side === 'w') { q.x0 = r.x0 + gap; q.x1 = r.x0 + gap + fd; q.z0 = r.z0 + o; q.z1 = r.z0 + o + fw; }
      else { q.x0 = r.x1 - gap - fd; q.x1 = r.x1 - gap; q.z0 = r.z0 + o; q.z1 = r.z0 + o + fw; }
      if (freeRect(P, r, q, 0.75, pre)) return { ...q, side };
    }
  }
  return null;
}
const rotOf = (side) => ({ n: 0, s: Math.PI, w: Math.PI / 2, e: -Math.PI / 2 })[side];   // facing into the room from that wall
function bunkIn(P, r, label = 'Rest in the bunk', tiers = 1) {
  const W = r.x1 - r.x0, D = r.z1 - r.z0, len = Math.min(2.0, Math.max(W, D) - 0.3);
  const q = placeAgainst(P, r, len, 0.9, W >= D ? ['n', 's', 'e', 'w'] : ['e', 'w', 'n', 's']) || placeAgainst(P, r, Math.min(1.9, Math.min(W, D) - 0.2), 0.85, ['n', 's', 'e', 'w']);
  if (!q) return false;
  const along = q.x1 - q.x0 >= q.z1 - q.z0 ? 'x' : 'z';
  const x = (q.x0 + q.x1) / 2, z = (q.z0 + q.z1) / 2;
  P.prop('bunk', { x, y: r.y, z, along, len: along === 'x' ? q.x1 - q.x0 : q.z1 - q.z0, tiers });
  P.solid(q.x0, q.x1, q.z0, q.z1, r.y, 0.6 + (tiers - 1) * 0.95, 'bunk');
  const off = { n: [0, 0.95], s: [0, -0.95], w: [0.95, 0], e: [-0.95, 0] }[q.side];
  // keep the strip beside the bunk clear (desk and lockers go elsewhere)
  const fr = { n: { x0: q.x0, x1: q.x1, z0: q.z1, z1: q.z1 + 0.75 }, s: { x0: q.x0, x1: q.x1, z0: q.z0 - 0.75, z1: q.z0 }, w: { x0: q.x1, x1: q.x1 + 0.75, z0: q.z0, z1: q.z1 }, e: { x0: q.x0 - 0.75, x1: q.x0, z0: q.z0, z1: q.z1 } }[q.side];
  P.reserve(fr.x0, fr.x1, fr.z0, fr.z1, r.y, r.y + 1);
  P.hot('bunk', label, x + off[0], r.y, z + off[1], 1.3);
  return true;
}
function deskIn(P, r) { const q = placeAgainst(P, r, 1.0, 0.6, ['e', 'w', 's', 'n']); if (!q) return; P.prop('desk', { x: (q.x0 + q.x1) / 2, y: r.y, z: (q.z0 + q.z1) / 2, rotY: ({ n: Math.PI, s: 0, w: -Math.PI / 2, e: Math.PI / 2 })[q.side] }); P.solid(q.x0, q.x1, q.z0, q.z1, r.y, 0.8, 'desk'); }
function lockersIn(P, r, n = 1) { for (let i = 0; i < n; i++) { const q = placeAgainst(P, r, Math.min(2.2, Math.max(r.x1 - r.x0, r.z1 - r.z0) * 0.5), 0.5, ['w', 'e', 'n', 's']); if (!q) return; P.prop('lockers', { x0: q.x0, x1: q.x1, z0: q.z0, z1: q.z1, y: r.y }); P.solid(q.x0, q.x1, q.z0, q.z1, r.y, 2.0, 'lockers'); } }
function counterIn(P, r, len, kind = 'galley', walls = ['n', 'w', 'e', 's']) { const q = placeAgainst(P, r, Math.min(len, Math.max(r.x1 - r.x0, r.z1 - r.z0) - 1.4), 0.65, walls); if (!q) return null; P.prop('counter', { x0: q.x0, x1: q.x1, z0: q.z0, z1: q.z1, y: r.y, kind }); P.solid(q.x0, q.x1, q.z0, q.z1, r.y, 0.95, kind); return q; }
function tableAt(P, r, x, z, w, d, benches = true) {
  const q = { x0: x - w / 2, x1: x + w / 2, z0: z - d / 2 - (benches ? 0.5 : 0), z1: z + d / 2 + (benches ? 0.5 : 0) };
  if (!freeRect(P, r, { x0: q.x0 - 0.6, x1: q.x1 + 0.6, z0: q.z0 - 0.6, z1: q.z1 + 0.6 }, 0)) return false;
  P.prop('table', { x, y: r.y, z, w, d, benches }); P.solid(q.x0, q.x1, q.z0, q.z1, r.y, 0.8, 'table'); return true;
}
function sofaIn(P, r, len = 2.2) { const q = placeAgainst(P, r, Math.min(len, Math.max(r.x1 - r.x0, r.z1 - r.z0) - 1.5), 0.8, ['s', 'w', 'e', 'n']); if (!q) return; P.prop('sofa', { x0: q.x0, x1: q.x1, z0: q.z0, z1: q.z1, y: r.y }); P.solid(q.x0, q.x1, q.z0, q.z1, r.y, 0.8, 'sofa'); }
function equipIn(P, r, kind, w, d, h = 1.2, walls = ['n', 'e', 'w', 's'], extra = {}) { const q = placeAgainst(P, r, w, d, walls); if (!q) return null; P.prop('equip', { kind, x0: q.x0, x1: q.x1, z0: q.z0, z1: q.z1, y: r.y, h, rotY: rotOf(q.side), ...extra }); P.solid(q.x0, q.x1, q.z0, q.z1, r.y, h, kind); return q; }

/** Furnish a room from its programme kind (house tiers, passenger decks, small craft). */
function furnish(P, r, furn) {
  const W = r.x1 - r.x0, D = r.z1 - r.z0, cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
  switch (furn) {
    case 'cabin': bunkIn(P, r); if (W * D >= 9) deskIn(P, r); if (W * D >= 12) lockersIn(P, r); return;
    case 'dayroom': sofaIn(P, r); deskIn(P, r); tableAt(P, r, cx, cz, 0.9, 0.6, false); return;
    case 'mess': {
      counterIn(P, r, Math.min(3, Math.max(W, D) * 0.4), 'pantry', ['w', 'e']);
      const along = W >= D, n = Math.max(1, Math.floor(((along ? W : D) - 1.4) / 2.6)), tw = Math.min(2.2, (along ? D : W) - 2.6);
      if (tw < 0.8) { tableAt(P, r, cx, cz, 1.0, 0.7, false); return; }
      for (let i = 0; i < n; i++) { const t = (i + 0.5) / n; if (along) tableAt(P, r, r.x0 + 0.7 + (W - 1.4) * t, cz, 0.85, tw, true); else tableAt(P, r, cx, r.z0 + 0.7 + (D - 1.4) * t, tw, 0.85, true); }
      return;
    }
    case 'galley': {
      counterIn(P, r, Math.max(W, D) - 1.2, 'galley', W >= D ? ['n', 's'] : ['w', 'e']);
      equipIn(P, r, 'range', 1.6, 0.9, 0.95, ['e', 'w', 'n', 's']);
      P.hot('galley', 'Galley — the cook\'s domain (crew morale)', cx, r.y, cz, 1.6);
      return;
    }
    case 'lounge': sofaIn(P, r, 2.6); sofaIn(P, r, 2.0); tableAt(P, r, cx, cz, 1.0, 0.6, false); equipIn(P, r, 'tv', 1.2, 0.4, 1.4, ['n', 'e']); return;
    case 'gym': equipIn(P, r, 'treadmill', 0.9, 1.9, 1.3, ['n', 'w', 'e']); equipIn(P, r, 'bike', 0.6, 1.2, 1.2, ['n', 'w', 'e']); equipIn(P, r, 'weights', 1.4, 0.7, 1.2); return;
    case 'hospital': bunkIn(P, r, 'Hospital bed'); equipIn(P, r, 'medcab', 1.0, 0.45, 1.9, ['w', 'e', 'n']); P.hot('hospital', 'Ship\'s hospital — first aid', cx, r.y, cz, 1.6); return;
    case 'laundry': equipIn(P, r, 'washer', 0.7, 0.7, 0.9, ['n', 'w', 'e']); equipIn(P, r, 'washer', 0.7, 0.7, 0.9, ['n', 'w', 'e']); equipIn(P, r, 'dryer', 0.7, 0.7, 0.9, ['n', 'w', 'e']); return;
    case 'lockers': lockersIn(P, r, 2); return;
    case 'office': deskIn(P, r); deskIn(P, r); equipIn(P, r, 'cabinet', 1.2, 0.5, 1.9, ['w', 'e', 'n']); return;
    case 'shelves': equipIn(P, r, 'shelves', Math.min(2.4, Math.max(W, D) - 1.4), 0.55, 2.0, ['n', 'w', 'e', 's']); equipIn(P, r, 'shelves', Math.min(2.4, Math.max(W, D) - 1.4), 0.55, 2.0, ['e', 'w', 's']); return;
    case 'wc': equipIn(P, r, 'wc', 0.6, 0.7, 0.8, ['n', 'w', 'e']); return;
    case 'racks': equipIn(P, r, 'rack', 1.2, 0.6, 2.0, ['w', 'e', 'n']); return;
    case 'ccr': { const q = equipIn(P, r, 'ccr', Math.min(3.2, W - 1.2), 0.8, 1.2, ['n', 'w', 'e']); if (q) P.hot('ccr', 'Cargo control console — loading and discharge', (q.x0 + q.x1) / 2 + (q.side === 'w' ? 1 : q.side === 'e' ? -1 : 0), r.y, (q.z0 + q.z1) / 2 + (q.side === 'n' ? 1 : q.side === 's' ? -1 : 0), 1.5); return; }
    case 'lab': counterIn(P, r, Math.max(W, D) - 1.4, 'lab', ['n', 'w', 'e']); equipIn(P, r, 'rack', 1.2, 0.6, 1.9, ['e', 'w']); P.hot('lab', 'Laboratory — research jobs', cx, r.y, cz, 1.6); return;
    case 'owner': { const q = placeAgainst(P, r, 2.1, 1.9, ['n', 'e', 'w']); if (q) { P.prop('bunk', { x: (q.x0 + q.x1) / 2, y: r.y, z: (q.z0 + q.z1) / 2, along: q.x1 - q.x0 > q.z1 - q.z0 ? 'x' : 'z', len: 2.1, tiers: 1, w: 1.9, double: true }); P.solid(q.x0, q.x1, q.z0, q.z1, r.y, 0.6, 'bunk'); P.hot('bunk', 'Rest in the owner\'s bed', (q.x0 + q.x1) / 2 + (q.side === 'e' ? -1.3 : q.side === 'w' ? 1.3 : 0), r.y, (q.z0 + q.z1) / 2 + (q.side === 'n' ? 1.3 : 0), 1.2); } sofaIn(P, r, 2.0); deskIn(P, r); return; }
    case 'winch': {
      const q = placeAgainst(P, r, Math.min(W - 1.6, 6), Math.min(2.4, D - 1.6), ['s', 'n']);
      if (q) { P.prop('towWinch', { x: (q.x0 + q.x1) / 2, y: r.y, z: (q.z0 + q.z1) / 2, w: q.x1 - q.x0, d: q.z1 - q.z0, h: 2.0, drums: 3 }); P.solid(q.x0, q.x1, q.z0, q.z1, r.y, 2.0, 'towwinch'); P.hot('winch', 'Anchor-handling / towing winch (three drums)', (q.x0 + q.x1) / 2, r.y, q.side === 's' ? q.z0 - 0.9 : q.z1 + 0.9, 1.3); }
      return;
    }
    case 'aftbridge': {
      const q = placeAgainst(P, r, Math.min(W - 1.6, 3), 0.8, ['s']);
      if (q) { P.prop('helm', { x: (q.x0 + q.x1) / 2, y: r.y, z: (q.z0 + q.z1) / 2, w: q.x1 - q.x0, facing: 1, aft: true }); P.solid(q.x0, q.x1, q.z0, q.z1, r.y, 1.25, 'console'); P.hot('thrusters', 'Aft bridge — conning position facing aft (icebreaking astern, towing)', (q.x0 + q.x1) / 2, r.y, q.z0 - 0.95, 1.2); }
      return;
    }
    case 'saloon': sofaIn(P, r, 2.4); tableAt(P, r, cx, cz, 1.2, 0.8, false); return;
    default: return;
  }
}

// ------------------------------------------------------------------------------------------------ the house
function floorOf(kind, style) { return kind === 'cabin' ? (style === 'yacht' ? 'wood' : 'carpet') : kind === 'bridge' ? 'lino' : kind === 'stairs' ? 'lino' : style === 'yacht' ? 'wood' : 'lino'; }

/** Rooms, doors, windows, furniture and the stair flights of every house tier (ga.house). */
function planHouseTiers(P, ga, house, { style = 'ship', zone = 'house' } = {}) {
  P.setZone(zone, { name: 'Accommodation', near: ['deck', 'er'] });
  const X0 = house.x0, X1 = house.x1;
  const rooms = [];
  house.tiers.forEach((t, k) => {
    for (const q of t.rooms) {
      const r = P.room({ id: q.id, kind: q.kind, use: q.use, name: q.name, x0: q.x0, x1: q.x1, z0: q.z0, z1: q.z1, y: t.y, h: t.h, floor: floorOf(q.kind, style), wall: style === 'yacht' ? 'wood' : 'white', walk: q.walk !== false, tier: t.id, berth: q.berth || 0 });
      rooms.push([r, q, t]);
    }
  });
  // doors (both rooms exist now), windows on the house's outer walls
  for (const [r, q] of rooms) {
    for (const d of q.doors || []) { const b = P.byId(d.to); if (!b) continue; P.door(r, b, d.side, d.at, d.w || 0.9, 2.05, d.kind || 'door'); }
    const outer = { n: Math.abs(r.z0 - house.z0) < 0.01, s: Math.abs(r.z1 - house.z1) < 0.01, w: Math.abs(r.x0 - X0) < 0.01, e: Math.abs(r.x1 - X1) < 0.01 };
    for (const side of q.win || []) {
      if (!outer[side] || r.walk === false) continue;
      const big = r.kind === 'bridge';
      if (side === 'n' || side === 's') P.window(r, side, r.x0 + 0.4, r.x1 - 0.4, big ? 1.0 : 1.1, big ? 2.35 : 1.9);
      else P.window(r, side, r.z0 + 0.4, r.z1 - 0.4, big ? 1.0 : 1.1, big ? 2.35 : 1.9);
    }
    if (r.kind === 'bridge') for (const side of ['n', 'e', 'w']) if (outer[side] && !r.windows.some((w) => w.side === side)) { if (side === 'n') P.window(r, 'n', r.x0 + 0.3, r.x1 - 0.3, 1.0, 2.35); else P.window(r, side, r.z0 + 0.3, r.z1 - 0.3, 1.0, 2.35); }
  }
  // stair flights: one column, all rising forward; signs on each landing
  const C = house.core;
  for (let k = 0; k < house.tiers.length - 1; k++) {
    const a = house.tiers[k], b = house.tiers[k + 1];
    P.stair({ id: `flight-${a.id}`, x0: C.fx0, x1: C.fx1, z0: C.runZ0, z1: C.runZ1, yLow: a.y, yHigh: b.y, up: 'n', foot: `${a.id}-stairs`, head: `${b.id}-stairs` });
  }
  house.tiers.forEach((t, k) => {
    const st = P.byId(`${t.id}-stairs`); if (!st) return;
    const up = k < house.tiers.length - 1 ? `▲ ${house.tiers[house.tiers.length - 1].name.toLowerCase()}` : '', down = k > 0 ? `▼ ${house.tiers[k - 1].name.toLowerCase()}` : '';
    P.sign(st.x1 - 0.06, t.y + 1.75, Math.min(st.z1 - 0.5, C.runZ1 + 0.5), -Math.PI / 2, [t.name.toUpperCase(), [up, down].filter(Boolean).join('   ')]);
  });
  // furniture
  for (const [r, q] of rooms) if (q.furn && r.walk !== false) furnish(P, r, q.furn);
  for (const [r, q] of rooms) if (q.use === 'casing') P.prop('block', { x0: r.x0, x1: r.x1, z0: r.z0, z1: r.z1, y: r.y, h: r.h, casing: true });
  return rooms;
}

/** The bridge: console row with the steering stand, radars, ECDIS, conning, telegraph; GMDSS, chart table; wings. */
function planBridge(P, ga, b, { style = 'ship' } = {}) {
  const br = P.byId(b.room); if (!br) return;
  P.setZone(br.zone);
  const y = br.y, W = br.x1 - br.x0, wingGear = [];
  const cz = br.z0 + 0.75, steer = b.consoles.find((c) => c.kind === 'steering');
  // wings to the ship's side
  if (b.wings !== 'none') {
    const wz0 = r2(br.z0 + 0.4), wz1 = r2(Math.min(br.z1 - 0.2, br.z0 + 0.4 + b.wingD));
    const encl = b.wings === 'enclosed';
    for (const side of [-1, 1]) {
      const out = side < 0 ? -b.wingTo : b.wingTo, inner = side < 0 ? br.x0 : br.x1;
      if (Math.abs(out - inner) < 1.2) continue;
      const w = P.room({ id: `wing-${side < 0 ? 'port' : 'stbd'}`, kind: encl ? 'bridge' : 'deck', name: `Bridge wing (${side < 0 ? 'port' : 'starboard'})`, open: !encl, x0: Math.min(out, inner), x1: Math.max(out, inner), z0: wz0, z1: wz1, y, h: encl ? br.h : 2.4, floor: encl ? 'lino' : 'deck', drawFloor: true,
        inset: side < 0 ? { e: R, w: encl ? R : RAIL_IN, n: encl ? R : RAIL_IN, s: encl ? R : RAIL_IN } : { w: R, e: encl ? R : RAIL_IN, n: encl ? R : RAIL_IN, s: encl ? R : RAIL_IN } });
      if (encl) { P.window(w, 'n', w.x0 + 0.2, w.x1 - 0.2, 1.0, 2.3); P.window(w, side < 0 ? 'w' : 'e', wz0 + 0.2, wz1 - 0.2, 1.0, 2.3); P.window(w, 's', w.x0 + 0.2, w.x1 - 0.2, 1.0, 2.3); }
      else P.rail(side < 0 ? [[inner, wz0], [out, wz0], [out, wz1], [inner, wz1]] : [[inner, wz0], [out, wz0], [out, wz1], [inner, wz1]], y);
      P.door(br, w, side < 0 ? 'w' : 'e', r2(wz0 + Math.min(1.5, (wz1 - wz0) / 2)), 0.95, 2.05, encl ? 'open' : 'ext');
      const cx = out - side * 0.55; void cx;
      wingGear.push([cx, side, wz0, y]);
    }
  }
  // the front console bank (screens drawn per console kind), the steering stand in the middle of it
  const bank = Math.min(W - 1.4, Math.max(2.4, ...b.consoles.filter((c) => Math.abs(c.z - cz) < 0.2).map((c) => Math.abs(c.x) + c.w / 2 + 0.2).map((v) => v * 2)));
  const sw = steer ? steer.w : 1.4;
  P.prop('helm', { x: 0, y, z: cz, w: sw, facing: -1 });
  P.solid(-sw / 2, sw / 2, cz - 0.45, cz + 0.45, y, 1.3, 'console');
  P.hot('helm', 'Take the helm', 0, y, cz + 1.0, 1.5); P.helm = { x: 0, y, z: cz + 1.0 };
  for (const side of [-1, 1]) {
    const xa = side < 0 ? -bank / 2 : sw / 2 + 0.05, xb = side < 0 ? -sw / 2 - 0.05 : bank / 2;
    if (xb - xa > 0.4) { P.prop('bconsole', { x0: xa, x1: xb, z0: cz - 0.4, z1: cz + 0.4, y, screens: b.consoles.filter((c) => Math.abs(c.z - cz) < 0.2 && Math.sign(c.x) === side && c.kind !== 'steering').map((c) => ({ kind: c.kind, x: c.x, w: c.w, band: c.band || null })) }); P.solid(xa, xb, cz - 0.4, cz + 0.4, y, 1.25, 'console'); }
  }
  const tg = b.consoles.find((c) => c.kind === 'telegraph');
  if (tg) P.hot('telegraph', 'Engine telegraph', tg.x, y, cz + 0.95, 1.0);
  P.hot('whistle', 'Sound the ship\'s whistle', -0.6, y, cz + 0.95, 0.9);
  P.prop('radio', { x: -sw / 2 - 0.25, y: y + 1.3, z: cz - 0.1, rotY: 0 });
  const gm = b.consoles.find((c) => c.kind === 'gmdss');
  if (gm) { const q = placeAgainst(P, br, 1.4, 0.75, ['w', 's', 'e']); if (q) { P.prop('gmdss', { x: (q.x0 + q.x1) / 2, y, z: (q.z0 + q.z1) / 2, rotY: rotOf(q.side) }); P.solid(q.x0, q.x1, q.z0, q.z1, y, 1.2, 'console'); const hx = q.side === 'w' ? q.x1 + 0.7 : q.side === 'e' ? q.x0 - 0.7 : (q.x0 + q.x1) / 2, hz = q.side === 's' ? q.z0 - 0.7 : (q.z0 + q.z1) / 2; P.hot('gmdss', 'GMDSS station — VHF ch 16 / DSC', hx, y, hz, 1.2); P.hot('radio', 'Use the VHF radio (chat)', hx, y, hz + (q.side === 's' ? 0 : 0.6), 1.0); } }
  else P.hot('radio', 'Use the VHF radio (chat)', -sw / 2 - 0.3, y, cz + 0.9, 1.0);
  const ch = b.consoles.find((c) => c.kind === 'chart');
  if (ch || br.z1 - br.z0 >= 4.2) { const q = placeAgainst(P, br, 1.4, 0.9, ['e', 's', 'w']); if (q) { P.prop('chart', { x: (q.x0 + q.x1) / 2, y, z: (q.z0 + q.z1) / 2, w: q.x1 - q.x0, d: q.z1 - q.z0 }); P.solid(q.x0, q.x1, q.z0, q.z1, y, 0.95, 'chart'); P.hot('chart', 'Open the chart', (q.x0 + q.x1) / 2 + (q.side === 'e' ? -0.9 : q.side === 'w' ? 0.9 : 0), y, (q.z0 + q.z1) / 2 + (q.side === 's' ? -0.9 : 0), 1.3); } }
  const pn = b.consoles.find((c) => c.kind === 'panel');
  if (pn) { const q = placeAgainst(P, br, 0.9, 0.35, ['w', 'e']); if (q) { P.prop('equip', { kind: 'panel', x0: q.x0, x1: q.x1, z0: q.z0, z1: q.z1, y, h: 1.8, rotY: rotOf(q.side) }); P.solid(q.x0, q.x1, q.z0, q.z1, y, 1.8, 'panel'); } }
  const aft = b.consoles.find((c) => c.kind === 'aft');
  if (aft) {
    const q = placeAgainst(P, br, Math.min(aft.w, W - 2.6), 0.8, ['s']);
    if (q) {
      const ax = (q.x0 + q.x1) / 2, az = (q.z0 + q.z1) / 2;
      P.prop('helm', { x: ax, y, z: az, w: q.x1 - q.x0, facing: 1, aft: true }); P.solid(q.x0, q.x1, q.z0, q.z1, y, 1.3, 'console');
      P.hot('thrusters', 'Aft control station — winches, thrusters, joystick', ax, y, az - 1.0, 1.3);
    }
    if (!br.windows.some((w) => w.side === 's')) P.window(br, 's', br.x0 + 0.5, br.x1 - 0.5, 1.0, 2.3);
  }
  for (const c of b.consoles.filter((q) => q.kind === 'sonar')) { P.prop('equip', { kind: 'sonar', x0: c.x - 0.4, x1: c.x + 0.4, z0: cz - 0.35, z1: cz + 0.35, y, h: 1.25, rotY: 0 }); }
  P.spawn = { x: Math.min(0.9, W / 2 - 0.6), y, z: Math.min(br.z1 - 0.5, cz + 1.6), yaw: 0 };
  for (const [cx, side, wz0] of wingGear) {
    P.prop('wingConsole', { x: cx, y, z: wz0 + 0.55, side }); P.solid(cx - 0.35, cx + 0.35, wz0 + 0.2, wz0 + 0.9, y, 1.25, 'console');
    P.hot('thrusters', `Wing console (${side < 0 ? 'port' : 'starboard'}) — engine, rudder, thrusters`, cx - side * 0.2, y, wz0 + 1.45, 1.1);
    P.hot('whistle', 'Sound the whistle', cx - side * 0.8, y, wz0 + 1.45, 0.8);
  }
  // compass deck on the bridge roof: magnetic compass, radar mast, EPIRB; a ladder from the starboard wing
  const roofY = b.compassY;
  if (roofY && ga.house && ga.house.tiers.length) {
    const h = ga.house;
    const cdk = P.room({ id: 'compass-deck', kind: 'deck', name: 'Compass deck', open: true, x0: h.x0, x1: h.x1, z0: h.z0, z1: h.z1, y: roofY, h: 2.4, floor: 'deck', drawFloor: true, inset: { n: RAIL_IN, s: RAIL_IN, e: RAIL_IN, w: RAIL_IN } });
    P.rail([[h.x0, h.z0], [h.x1, h.z0], [h.x1, h.z1], [h.x0, h.z1], [h.x0, h.z0]], roofY);
    P.prop('compass', { x: 0, y: roofY, z: br.z0 + 1.0 }); P.solid(-0.35, 0.35, br.z0 + 0.65, br.z0 + 1.35, roofY, 1.4, 'compass');
    const mast = ga.deck.masts.find((m) => m.radar);
    if (mast) { const mz = clamp(mast.z, h.z0 + 1.5, h.z1 - 1.5); P.prop('radarMast', { x: 0, y: roofY, z: mz, h: mast.h, bands: ga.gt >= 3000 ? 2 : 1 }); P.solid(-0.6, 0.6, mz - 0.6, mz + 0.6, roofY, mast.h, 'mast'); }
    P.prop('equip', { kind: 'epirb', x0: h.x1 - 0.8, x1: h.x1 - 0.4, z0: br.z0 + 0.4, z1: br.z0 + 0.8, y: roofY, h: 0.6, rotY: 0 });
    if (ga.funnel && ga.funnel.z > h.z0 && ga.funnel.z < h.z1 && Math.abs(ga.funnel.y - roofY) < 0.3) { const f = ga.funnel; P.prop('funnel', { x: f.x, z: f.z, y: roofY, h: f.h, r: f.r }); P.solid(f.x - f.r, f.x + f.r, f.z - f.r, f.z + f.r, roofY, f.h, 'funnel'); }
    const wingS = P.byId('wing-stbd');
    if (wingS && wingS.open) P.ladder({ x: wingS.x0 + 0.5, y, z: wingS.z1 - 0.5 }, { x: Math.min(cdk.x1 - 0.6, wingS.x0 - 0.3), y: roofY, z: Math.min(cdk.z1 - 0.6, wingS.z1 - 0.5) }, 'compass deck', { x: wingS.x0 + 0.1, z: wingS.z1 - 0.3, y0: y, y1: roofY });
    else { const st = P.rooms.find((r) => r.tier === h.tiers[h.tiers.length - 1].id && r.use === 'stairs'); if (st) P.ladder({ x: (st.x0 + st.x1) / 2 + 0.45, y, z: st.z0 + 0.6 }, { x: clamp((st.x0 + st.x1) / 2 + 0.45, cdk.x0 + 0.6, cdk.x1 - 0.6), y: roofY, z: st.z0 - 0.4 }, 'compass deck (roof hatch)'); }
  }
}

// ------------------------------------------------------------------------------------------------ engine room
/**
 * The engine room on every level: wings beside the engine strip, the engines (2-stroke through the platforms), gensets,
 * ECR with switchboard and console on the upper platform, purifier room, workshop, boiler, the stacked stair column,
 * steering gear room aft, shaft tunnel, emergency escape ladder.
 */
function planEngineRoom(P, ga, er, { entranceRoom = null } = {}) {
  P.setZone('er', { name: 'Engine room', near: ['house', 'deck'] });
  const n = er.levels.length, col = er.column;
  const me = { ...er.me, h: Math.min(er.me.h, r2(er.top - er.floorY - 0.45)) };   // a taller engine tops out in the casing above
  const tops = er.levels.map((y, i) => (i < n - 1 ? er.levels[i + 1] : er.top));
  const meTop = er.floorY + 0.2 + me.h;
  const span = me.len * me.rows + 1.2 * (me.rows - 1);
  const mez0 = me.z - span / 2, mez1 = me.z + span / 2;
  let ex0 = r2(Math.min(...me.xs) - me.w / 2 - 0.7), ex1 = r2(Math.max(...me.xs) + me.w / 2 + 0.7);
  if (col && col.x1 > ex0 - 1.9 && col.x0 < ex1 + 1.9) { ex0 = r2(Math.min(ex0, col.x0 - 0.55)); ex1 = r2(Math.max(ex1, col.x1 + 0.55)); }
  const created = [];
  // z segments where the hull narrows aft
  const zs = [er.z0, er.z1];
  const hwAt = (z0, z1, y, h) => r2(Math.min(P.fit(z0, z1, y, h), ga.B / 2 - 0.5));
  const levelRooms = [];
  for (let i = 0; i < n; i++) {
    const y = er.levels[i], h = r2(tops[i] - y - 0.12);
    // z segments: where the hull narrows (toward the stern) the room steps in; boundaries keep clear of the engine and
    // the stair column
    const keepOut = [[mez0 - 1.0, mez1 + 1.0]]; if (col) keepOut.push([col.runZ0 - LAND - 0.3, col.runZ1 + LAND + 0.3]);
    const bounds = [er.z0];
    const cands = []; for (let z = er.z0 + 7; z < er.z1 - 3; z += 7) cands.push(z);
    cands.sort((p, q) => p - q);
    for (const z of cands) {
      if (keepOut.some(([p, q]) => z > p && z < q)) continue;
      if (z - bounds[bounds.length - 1] >= 2.5 && er.z1 - z >= 2.5) bounds.push(r2(z));
    }
    bounds.push(er.z1);
    let pieces = [];
    for (let k = 0; k < bounds.length - 1; k++) pieces.push([bounds[k], bounds[k + 1], hwAt(bounds[k], bounds[k + 1], y, h)]);
    const hasCol = (a0, b1) => col && col.z0 < b1 && col.z1 > a0;
    for (let k = 0; k < pieces.length - 1;) { const [a0, a1, ha] = pieces[k], [b0, b1, hb] = pieces[k + 1]; const short = a1 - a0 < 3 || b1 - b0 < 3; if ((Math.abs(ha - hb) < 0.8 || (short && !hasCol(a0, a1) && !hasCol(b0, b1))) && !(hasCol(a0, a1) !== hasCol(b0, b1) && Math.abs(ha - hb) >= 0.3)) { pieces.splice(k, 2, [a0, b1, Math.min(ha, hb)]); } else k++; }
    const segs = pieces.map(([a0, b1]) => [a0, b1]);
    const rowRooms = [];
    segs.forEach(([z0, z1], si) => {
      const hw = pieces[si][2];
      const strips = [];
      const wingOK = (a, b) => b - a >= 1.6;
      const colIn = (a, b) => col && col.x0 >= a - 0.01 && col.x1 <= b + 0.01;
      if (hw - Math.max(ex1, -ex0) >= 1.6 && wingOK(-hw, ex0) && wingOK(ex1, hw)) strips.push(['p', -hw, ex0], ['c', ex0, ex1], ['s', ex1, hw]);
      else if (hw > 1.2) strips.push(['c', -hw, hw]);
      else return;
      const rooms = {};
      for (const [tag, a, b] of strips) {
        const nm = i === 0 ? 'Engine room floor' : i === n - 1 ? 'Engine room upper platform' : `Engine room ${i === 1 ? '2nd' : i === 2 ? '3rd' : `${i + 1}th`} platform`;
        const id = `er${i}-${tag}${segs.length > 1 ? si : ''}`;
        rooms[tag] = { id, kind: 'engine', name: `${nm}${tag === 'p' ? ' (port)' : tag === 's' ? ' (starboard)' : ''}`, x0: r2(a), x1: r2(b), z0, z1, y, h, floor: 'grating', wall: 'dark', dark: true, level: i, tag, seg: si, colIn: colIn(a, b) };
      }
      rowRooms.push(rooms);
    });
    levelRooms.push(rowRooms);
  }
  // enclosed rooms: ECR (upper platform, wing away from the stair column), purifiers (a platform), workshop (floor)
  const enclosed = [];
  const pickWing = (i, pref) => {
    const rows = levelRooms[i]; if (!rows) return null;
    for (const tag of [pref, pref === 's' ? 'p' : 's']) for (const rr of rows) { const w = rr[tag]; if (w && !w.colIn && w.x1 - w.x0 >= 2.6) return w; }
    for (const tag of [pref, pref === 's' ? 'p' : 's']) for (const rr of rows) { const w = rr[tag]; if (w && w.x1 - w.x0 >= 2.6) return w; }
    return null;
  };
  const ecrSide = er.ecr.side > 0 ? 's' : 'p';
  const want = [{ use: 'ecr', name: 'Engine control room', level: er.ecr.level, len: clamp((ga.L || 50) * 0.035, 3.2, 8), pref: ecrSide }];
  if (er.purifier && n >= 2) want.push({ use: 'purifier', name: 'Purifier room', level: Math.max(0, er.ecr.level - 1), len: clamp(ga.L * 0.025, 2.6, 6), pref: ecrSide === 's' ? 'p' : 's' });
  if (er.workshop) want.push({ use: 'workshop', name: 'Workshop & stores', level: 0, len: clamp(ga.L * 0.025, 2.6, 6), pref: ecrSide });
  for (const wnt of want) {
    const w = pickWing(wnt.level, wnt.pref); if (!w) continue;
    const segLen = w.z1 - w.z0;
    if (segLen < wnt.len + 3.2) continue;
    // keep clear of the stair column landings and of enclosed rooms already in this strip
    const avoid = [];
    if (col && col.x1 > w.x0 - 0.3 && col.x0 < w.x1 + 0.3) avoid.push([col.z0 - 0.4, col.z1 + 0.4]);
    for (const e of enclosed) if (e.parent === w) avoid.push([e.z0, e.z1]);
    let z0 = null;
    for (const cand of [w.z0, w.z1 - wnt.len]) { if (!avoid.some(([a, b]) => cand < b && cand + wnt.len > a)) { z0 = cand; break; } }
    if (z0 == null) continue;
    let ew = Math.min(w.x1 - w.x0, Math.max(3.0, Math.min(7, (w.x1 - w.x0) * 0.85)));
    if (w.x1 - w.x0 - ew < 1.8) ew = w.x1 - w.x0;
    const outer = w.tag === 'p' ? w.x0 : w.tag === 's' ? w.x1 - ew : w.x1 - ew;
    enclosed.push({ ...wnt, parent: w, x0: r2(w.tag === 'p' ? w.x0 : w.x1 - ew), x1: r2(w.tag === 'p' ? w.x0 + ew : w.x1), z0: r2(z0), z1: r2(z0 + wnt.len), y: w.y, h: w.h, outer });
  }
  // materialise: each strip minus its enclosed room becomes up to three rectangles (beside / fore / aft)
  const ids = new Map();
  for (const rows of levelRooms) for (const rr of rows) for (const tag of Object.keys(rr)) {
    const w = rr[tag], enc = enclosed.filter((e) => e.parent === w);
    const parts = [];
    if (!enc.length) parts.push({ ...w });
    else {
      const e = enc[0];
      if (e.z0 - w.z0 >= 0.6) parts.push({ ...w, id: `${w.id}a`, z1: e.z0 });
      if (w.z1 - e.z1 >= 0.6) parts.push({ ...w, id: `${w.id}b`, z0: e.z1 });
      const bx0 = w.tag === 'p' ? e.x1 : w.x0, bx1 = w.tag === 'p' ? w.x1 : e.x0;
      if (bx1 - bx0 >= 0.8) parts.push({ ...w, id: `${w.id}c`, x0: bx0, x1: bx1, z0: e.z0, z1: e.z1, beside: true });
    }
    // the stair column sticks out of this strip (hull wider at the column than over the whole strip): widen a z-slice
    const cxm = col ? (col.x0 + col.x1) / 2 : 0;
    for (let k = 0; col && k < parts.length; k++) {
      const q = parts[k];
      if (!(col.z0 >= q.z0 - 0.01 && col.z1 <= q.z1 + 0.01)) continue;
      const outerP = q.tag === 'p' || (q.tag === 'c' && !rr.p), outerS = q.tag === 's' || (q.tag === 'c' && !rr.s);
      if (!((cxm >= q.x0 - 0.6 && cxm <= q.x1 + 0.6) || (outerP && col.x1 > q.x0 - 3.5 && col.x0 < q.x0) || (outerS && col.x0 < q.x1 + 3.5 && col.x1 > q.x1))) continue;
      if (col.x0 >= q.x0 - 0.01 && col.x1 <= q.x1 + 0.01) continue;
      const wx0 = Math.min(q.x0, r2(col.x0 - 0.25)), wx1 = Math.max(q.x1, r2(col.x1 + 0.25));
      const out = [];
      if (col.z0 - q.z0 >= 0.6) out.push({ ...q, id: `${q.id}f`, z1: col.z0, link: 'n' });
      out.push({ ...q, id: `${q.id}m`, x0: wx0, x1: wx1, z0: Math.max(q.z0, col.z0), z1: Math.min(q.z1, col.z1), mid: true });
      if (q.z1 - col.z1 >= 0.6) out.push({ ...q, id: `${q.id}t`, z0: col.z1, link: 's' });
      parts.splice(k, 1, ...out); break;
    }
    rr[tag] = parts.map((q) => { const r = P.room({ ...q, colIn: undefined, link: undefined, mid: undefined }); r.colSplit = q.mid ? 'mid' : q.link || null; created.push(r); return r; });
    { const mid = rr[tag].find((r) => r.colSplit === 'mid'); if (mid) for (const r of rr[tag]) { if (r.colSplit === 'n') { const lo = Math.max(r.x0, mid.x0), hi = Math.min(r.x1, mid.x1); P.opening(r, mid, 's', (lo + hi) / 2, r2(hi - lo - 0.1)); } if (r.colSplit === 's') { const lo = Math.max(r.x0, mid.x0), hi = Math.min(r.x1, mid.x1); P.opening(r, mid, 'n', (lo + hi) / 2, r2(hi - lo - 0.1)); } } }
    ids.set(w.id, rr[tag]);
  }
  const encRooms = enclosed.map((e) => {
    const r = P.room({ id: `er-${e.use}`, kind: e.use === 'ecr' ? 'engine' : 'store', use: e.use, name: e.name, x0: e.x0, x1: e.x1, z0: e.z0, z1: e.z1, y: e.y, h: e.h, floor: e.use === 'ecr' ? 'lino' : 'steel', wall: e.use === 'ecr' ? 'white' : 'steel', dark: false });
    return { e, r };
  });
  // connect: strips across (wing ↔ centre) where the centre is walkable, fore ↔ aft segments, enclosed rooms to their strip
  const blockedZ = (i) => { const out = []; if (i === 0 || meTop > er.levels[i] - 0.2) out.push([mez0 - 0.6, mez1 + 0.6]); return out; };
  const shared = (a, b, side) => {
    const lo = Math.max(side === 'e' || side === 'w' ? a.z0 : a.x0, side === 'e' || side === 'w' ? b.z0 : b.x0), hi = Math.min(side === 'e' || side === 'w' ? a.z1 : a.x1, side === 'e' || side === 'w' ? b.z1 : b.x1);
    return [lo, hi];
  };
  const doorBetween = (a, b, side, block = [], w = 1.2, kind = 'open') => {
    const [lo, hi] = shared(a, b, side);
    if (hi - lo < w + 0.2) return false;
    const free = []; let cur = lo + 0.1;
    for (const [p, q] of block.slice().sort((u, v) => u[0] - v[0])) { if (p > cur) free.push([cur, Math.min(p, hi - 0.1)]); cur = Math.max(cur, q); }
    if (cur < hi - 0.1) free.push([cur, hi - 0.1]);
    const ok = free.filter(([p, q]) => q - p >= Math.min(w, 0.95) + 0.15);
    if (!ok.length) return false;
    const picks = ok.length > 1 ? [ok[0], ok[ok.length - 1]] : [ok[0]];
    for (const [p, q] of picks) { const ww = Math.min(kind === 'open' ? 2.4 : 0.95, q - p - 0.1); P.door(a, b, side, (p + q) / 2, Math.max(0.95, ww), 2.05, kind); }
    return true;
  };
  levelRooms.forEach((rows, i) => {
    for (const rr of rows) {
      const c = rr.c || [];
      for (const tag of ['p', 's']) for (const w of rr[tag] || []) for (const cc of c) {
        if (tag === 'p' && Math.abs(w.x1 - cc.x0) > 0.01) continue;
        if (tag === 's' && Math.abs(w.x0 - cc.x1) > 0.01) continue;
        const wx = tag === 'p' ? w.x1 : w.x0, cb = col && Math.min(Math.abs(col.x0 - wx), Math.abs(col.x1 - wx)) < 1.6 ? [[col.z0 - 0.3, col.z1 + 0.3]] : [];
        doorBetween(w, cc, tag === 'p' ? 'e' : 'w', [...blockedZ(i), ...cb]);
      }
      // pieces of one strip around an enclosed room: fore / aft parts join the beside part
      for (const tag of Object.keys(rr)) {
        const parts = rr[tag]; if (parts.length < 2) continue;
        const bes = parts.find((q) => q.beside);
        for (const q of parts) {
          if (q === bes) continue;
          if (bes && Math.abs(q.z1 - bes.z0) < 0.01) doorBetween(q, bes, 's', [], 1.2);
          else if (bes && Math.abs(q.z0 - bes.z1) < 0.01) doorBetween(q, bes, 'n', [], 1.2);
        }
      }
    }
    for (let si = 0; si < rows.length - 1; si++) for (const ta of ['p', 'c', 's']) for (const tb of ['p', 'c', 's']) for (const a of rows[si][ta] || []) for (const b of rows[si + 1][tb] || []) {
      const tag = ta === 'c' && tb === 'c' ? 'c' : ta;
      if (Math.abs(a.z1 - b.z0) > 0.01) continue;
      const lo = Math.max(a.x0, b.x0), hi = Math.min(a.x1, b.x1);
      if (hi - lo < 1.4) continue;
      const blk = tag === 'c' && (i === 0 || meTop > er.levels[i] - 0.2) && mez0 - 0.8 < a.z1 && mez1 + 0.8 > a.z1 ? [[ex0, ex1]] : [];
      doorBetween(a, b, 's', blk.map(([p, q]) => [p, q]));
    }
  });
  for (const { e, r } of encRooms) {
    const host = (ids.get(e.parent.id) || []).find((q) => q.beside) || (ids.get(e.parent.id) || []).find((q) => (Math.abs(q.z1 - r.z0) < 0.01 || Math.abs(q.z0 - r.z1) < 0.01) && Math.min(q.x1, r.x1) - Math.max(q.x0, r.x0) >= 1.2);
    if (!host) continue;
    if (host.beside) P.door(r, host, e.parent.tag === 'p' ? 'e' : 'w', (r.z0 + r.z1) / 2, 0.95, 2.05, 'door');
    else if (Math.abs(host.z1 - r.z0) < 0.01) P.door(r, host, 'n', (Math.max(r.x0, host.x0) + Math.min(r.x1, host.x1)) / 2, 0.95, 2.05, 'door');
    else P.door(r, host, 's', (Math.max(r.x0, host.x0) + Math.min(r.x1, host.x1)) / 2, 0.95, 2.05, 'door');
    if (e.use === 'ecr') {
      P.window(r, e.parent.tag === 'p' ? 'e' : 'w', r.z0 + 0.4, r.z1 - 0.4, 1.0, 2.0);
      const q = placeAgainst(P, r, Math.min(2.6, r.x1 - r.x0 - 1.2), 0.8, ['n', 's']);
      if (q) {
        P.prop('console', { x: (q.x0 + q.x1) / 2, y: r.y, z: (q.z0 + q.z1) / 2, rotY: q.side === 'n' ? 0 : Math.PI, wall: false, ecr: true });
        P.solid(q.x0, q.x1, q.z0, q.z1, r.y, 1.75, 'console');
        const hz = q.side === 'n' ? q.z1 + 0.85 : q.z0 - 0.85;
        P.hot('ecr', 'Engine control console — generators, fuel transfer, bilge pumps', (q.x0 + q.x1) / 2, r.y, hz, 1.3);
        P.hot('engine', 'Check the engine (rpm, fuel, temperature)', (q.x0 + q.x1) / 2 + 0.7, r.y, hz, 1.0);
      }
      equipIn(P, r, 'switchboard', Math.min(3.2, r.z1 - r.z0 - 1.6), 0.6, 2.0, [e.parent.tag === 'p' ? 'w' : 'e', 's', 'n']);
      P.sign(r.x0 + 0.06, r.y + 1.8, r.z0 + 0.8, Math.PI / 2, ['ENGINE CONTROL ROOM', 'main switchboard']);
    } else if (e.use === 'purifier') { equipIn(P, r, 'purifier', 0.9, 0.9, 1.4, ['n', 's', 'w', 'e']); equipIn(P, r, 'purifier', 0.9, 0.9, 1.4, ['n', 's', 'w', 'e']); equipIn(P, r, 'purifier', 0.9, 0.9, 1.4, ['n', 's', 'w', 'e']); }
    else if (e.use === 'workshop') { equipIn(P, r, 'lathe', 1.8, 0.7, 1.2, ['n', 's', 'w', 'e']); equipIn(P, r, 'bench', 2.0, 0.8, 0.95, ['n', 's', 'w', 'e']); equipIn(P, r, 'shelves', 1.8, 0.5, 2.0, ['w', 'e', 's']); }
  }
  // machinery: the main engine(s) (a 2-stroke passes up through the platforms), gensets, boiler, pipes
  const floorRooms = levelRooms[0].flatMap((rr) => Object.values(rr).flat());
  const big2s = me.kind === '2s';
  me.xs.forEach((x, j) => {
    for (let row = 0; row < me.rows; row++) {
      if (j * me.rows + row >= me.n && !big2s) continue;
      const z = mez0 + me.len / 2 + row * (me.len + 1.2);
      P.prop(big2s ? 'me2s' : 'engine', { x, y: er.floorY, z, len: me.len, w: me.w, h: me.h });
      P.solid(x - me.w / 2 - 0.3, x + me.w / 2 + 0.3, z - me.len / 2 - 0.3, z + me.len / 2 + 0.3, er.floorY, me.h + 0.4, 'engine');
    }
  });
  const mx0 = Math.min(...me.xs) - me.w / 2 - 0.5, mx1 = Math.max(...me.xs) + me.w / 2 + 0.5;
  for (let i = 1; i < n; i++) if (meTop > er.levels[i] - 0.2) {
    for (const rr of levelRooms[i]) for (const c of rr.c || []) {
      const cut = { x0: r2(Math.max(c.x0, mx0)), x1: r2(Math.min(c.x1, mx1)), z0: r2(Math.max(c.z0, mez0 - 0.4)), z1: r2(Math.min(c.z1, mez1 + 0.4)) };
      if (cut.x1 - cut.x0 > 0.3 && cut.z1 - cut.z0 > 0.3) c.cuts.push(cut);
    }
  }
  // local control stand on the floor, forward of the engine
  let stand = null;
  for (const r of floorRooms) {
    for (const dz of [1.4, 1.8, 2.3]) for (const sx of [0, 1.2, -1.2, 2.4, -2.4]) {
      const sz = mez0 - dz;
      if (stand || sz < r.z0 + 1.6 || sz > r.z1 - 0.4 || sx < r.x0 + 0.95 || sx > r.x1 - 0.95) continue;
      if (freeRect(P, r, { x0: sx - 0.9, x1: sx + 0.9, z0: sz - 1.6, z1: sz + 0.4 }, 0.1)) stand = { r, sx, sz };
    }
  }
  if (stand) {
    const { sx, sz } = stand;
    P.prop('console', { x: sx, y: er.floorY, z: sz, rotY: Math.PI, wall: false }); P.solid(sx - 0.85, sx + 0.85, sz - 0.35, sz + 0.35, er.floorY, 1.75, 'console');
    P.hot('engine', 'Main engine local control stand (rpm, fuel, temperature)', sx, er.floorY, sz - 1.0, 1.3);
  } else {
    let spot = null, best = Infinity;
    const ref = er.hatch ? { x: er.hatch.x, z: er.hatch.z } : col ? { x: (col.x0 + col.x1) / 2, z: col.runZ1 + LAND } : { x: 0, z: er.z0 + 1 };
    for (const r of floorRooms) { if (r.walk === false) continue; const near = [...P.solidsNear(r.x0, r.x1, r.z0, r.z1)]; for (let zz = r.z0 + 0.6; zz < r.z1 - 0.5; zz += 0.3) for (let xx = r.x0 + 0.6; xx < r.x1 - 0.5; xx += 0.3) { if (Math.hypot(xx - ref.x, zz - ref.z) >= best) continue; if (near.some((q) => xx > q.x0 - R - 0.1 && xx < q.x1 + R + 0.1 && zz > q.z0 - R - 0.1 && zz < q.z1 + R + 0.1 && q.y < er.floorY + 1.7 && q.y + q.h > er.floorY)) continue; const dd = Math.hypot(xx - ref.x, zz - ref.z); if (dd < best) { best = dd; spot = { x: xx, z: zz }; } } }
    if (spot) P.hot('engine', 'Check the main engine', spot.x, er.floorY, spot.z, 1.4);
  }
  if (er.gens) {
    const g = er.gens, wing = floorRooms.filter((r) => r.tag !== 'c' && r.x1 - r.x0 >= g.w + 1.6).sort((a, b) => (b.z1 - b.z0) - (a.z1 - a.z0))[0];
    if (wing) for (let k = 0; k < g.n; k++) {
      const z = wing.z0 + 0.8 + g.len / 2 + k * (g.len + 0.9); if (z + g.len / 2 > wing.z1 - 0.8) break;
      const x = wing.tag === 'p' ? wing.x0 + 0.5 + g.w / 2 : wing.x1 - 0.5 - g.w / 2;
      const q = { x0: x - g.w / 2 - 0.15, x1: x + g.w / 2 + 0.15, z0: z - g.len / 2 - 0.15, z1: z + g.len / 2 + 0.15 };
      if (!freeRect(P, wing, q, 0.1)) continue;
      P.prop('generator', { x, y: wing.y, z, len: g.len, w: g.w, h: Math.min(g.h, wing.h - 0.3) }); P.solid(q.x0, q.x1, q.z0, q.z1, wing.y, Math.min(g.h, wing.h - 0.3) + 0.2, 'generator');
    }
  }
  if (er.boiler && n >= 2) { const lvRooms = levelRooms[1].flatMap((rr) => Object.values(rr).flat()).filter((r) => r.tag !== 'c' && r.x1 - r.x0 >= 3.4); const b = lvRooms[lvRooms.length - 1]; if (b) equipIn(P, b, 'boiler', 1.8, 1.8, Math.min(3.2, b.h - 0.2), ['n', 's']); }
  for (const r of created) P.prop('pipes', { x0: r.x0, x1: r.x1, z0: r.z0, z1: r.z1, y: r.y, h: r.h });
  // stair column: stacked flights from the floor up to the deck (or A-deck) entrance
  const hasDoor = new Set(); for (const d of P.doors) { hasDoor.add(d.a); if (d.b) hasDoor.add(d.b); }
  if (col) {
    const roomOfAt = (i, z) => created.find((r) => r.level === i && col.x0 >= r.x0 - 0.01 && col.x1 <= r.x1 + 0.01 && z >= r.z0 && z <= r.z1) || created.find((r) => r.level === i && (col.x0 + col.x1) / 2 >= r.x0 && (col.x0 + col.x1) / 2 <= r.x1 && z >= r.z0 && z <= r.z1);
    for (let i = 0; i < n; i++) {
      const yLow = er.levels[i], yHigh = i < n - 1 ? er.levels[i + 1] : er.top;
      const foot = roomOfAt(i, col.runZ1 + 0.5), head = i < n - 1 ? roomOfAt(i + 1, col.runZ0 - 0.5) : entranceRoom;
      P.stair({ id: `er-flight-${i}`, x0: col.x0, x1: col.x1, z0: col.runZ0, z1: col.runZ1, yLow, yHigh, up: 'n', foot: foot ? foot.id : null, head: head ? head.id : null, kind: 'steep' });
      if (foot) { // the landing sign stands clear of machinery (the main engine or a genset can sit beside the column) and inside the landing room
        const zS = col.runZ1 + LAND * 0.6;
        const clear = (x) => x > foot.x0 + 0.1 && x < foot.x1 - 0.1 && !P.solidsNear(x - 1.3, x + 1.3, zS - 1.3, zS + 1.3).some((q) => q.y < yLow + 2.3 && q.y + q.h > yLow + 1.2 && x > q.x0 - 1.2 && x < q.x1 + 1.2 && zS > q.z0 - 1.2 && zS < q.z1 + 1.2);
        const xs = [col.x1 + 0.9, col.x0 - 0.9].find(clear), x = xs ?? col.x1 + 0.06;
        P.sign(x, yLow + 1.8, zS, xs === col.x0 - 0.9 ? Math.PI / 2 : -Math.PI / 2, [i === 0 ? 'ENGINE ROOM' : `ER LEVEL ${i + 1}`, i < n - 1 ? '▲ platforms   ▲ deck' : '▲ deck / accommodation']);
      }
    }
  }
  // open plan: the strips of one level are one space — no walls (and no wall margin) where a strip only meets other strips
  const openPlan = created.filter((r) => r.walk !== false);
  for (const r of openPlan) for (const side of ['n', 's', 'e', 'w']) {
    const ns = side === 'n' || side === 's', c = { n: r.z0, s: r.z1, w: r.x0, e: r.x1 }[side], [lo, hi] = ns ? [r.x0, r.x1] : [r.z0, r.z1];
    const opp = { n: 's', s: 'n', e: 'w', w: 'e' }[side];
    const segs = [];
    for (const q of openPlan) {
      if (q === r || q.level !== r.level) continue;
      const cq = { n: q.z0, s: q.z1, w: q.x0, e: q.x1 }[opp]; if (Math.abs(cq - c) > 0.02) continue;
      const a = Math.max(lo, ns ? q.x0 : q.z0), b = Math.min(hi, ns ? q.x1 : q.z1); if (b - a > 0.01) segs.push([a, b]);
    }
    segs.sort((u, v) => u[0] - v[0]); let cur = lo; for (const [a, b] of segs) { if (a > cur + 0.05) break; cur = Math.max(cur, b); }
    if (cur >= hi - 0.05) { r.walls[side] = false; r.inset[side] = 0; }
  }
  if (!(er.hatch && created.length === 1)) for (const r of created) if (!hasDoor.has(r.id) && !(col && col.x0 >= r.x0 && col.x1 <= r.x1 && col.z0 < r.z1 && col.z1 > r.z0)) r.walk = false;
  // steering gear room aft (watertight door from the upper level), shaft tunnel, escape ladder
  const upper = levelRooms[n - 1].flatMap((rr) => Object.values(rr).flat());
  if (er.steering) {
    const s = er.steering, yS = er.levels[n - 1], hS = r2(er.top - yS - 0.12);
    const hw = Math.min(P.fit(s.z0, s.z1, yS, hS), ga.B / 2 - 0.5);
    const aftRooms = upper.filter((r) => Math.abs(r.z1 - s.z0) < 0.02);
    if (hw >= 1.4 && !aftRooms.length && s.z1 - s.z0 >= 2.4) {
      const sg = P.room({ id: 'steering-gear', kind: 'engine', use: 'steering', name: 'Steering gear room', x0: -hw, x1: hw, z0: s.z0, z1: s.z1, y: yS, h: hS, floor: 'steel', wall: 'dark', dark: true });
      const q = placeAgainst(P, sg, Math.min(2.4, 2 * hw - 1.4), Math.min(1.6, s.z1 - s.z0 - 1.6), ['s', 'n']);
      if (q) { P.prop('steeringGear', { x: (q.x0 + q.x1) / 2, y: yS, z: (q.z0 + q.z1) / 2, w: q.x1 - q.x0, d: q.z1 - q.z0 }); P.solid(q.x0, q.x1, q.z0, q.z1, yS, 1.4, 'steering'); P.hot('steering', 'Local steering — steering gear (emergency steering drill)', (q.x0 + q.x1) / 2, yS, q.side === 's' ? q.z0 - 0.8 : q.z1 + 0.8, 1.3); }
      P.setZone('deck');
      const dz = clamp(s.z0 + 1.0, s.z0 + 0.6, s.z1 - 0.6), host = P.openAt(hw - 0.8, dz, ga.deckY) || P.openAt(0, dz, ga.deckY);
      if (host) P.ladder({ x: clamp(hw - 0.8, host.x0 + 0.6, host.x1 - 0.6), y: ga.deckY, z: dz }, { x: hw - 0.7, y: yS, z: dz }, 'steering gear room hatch', { x: hw - 0.5, z: dz, y0: yS, y1: ga.deckY });
      P.setZone('er');
    } else if (hw >= 1.4 && aftRooms.length && s.z1 - s.z0 >= 2.4) {
      const sg = P.room({ id: 'steering-gear', kind: 'engine', use: 'steering', name: 'Steering gear room', x0: -hw, x1: hw, z0: s.z0, z1: s.z1, y: yS, h: hS, floor: 'steel', wall: 'dark', dark: true });
      let host = aftRooms.find((r) => r.x0 <= -0.6 && r.x1 >= 0.6 && !(r.cuts || []).some((c) => c.z1 > r.z1 - 1.5 && c.x0 < 0.6 && c.x1 > -0.6)) || aftRooms.find((r) => Math.min(r.x1, hw) - Math.max(r.x0, -hw) >= 1.4);
      if (host) {
        const at = clamp(0, Math.max(host.x0, -hw) + 0.7, Math.min(host.x1, hw) - 0.7);
        P.door(host, sg, 's', at, 0.9, 1.95, 'watertight');
        const q = placeAgainst(P, sg, Math.min(2.4, 2 * hw - 1.4), Math.min(1.6, s.z1 - s.z0 - 1.6), ['s', 'n']);
        if (q) { P.prop('steeringGear', { x: (q.x0 + q.x1) / 2, y: yS, z: (q.z0 + q.z1) / 2, w: q.x1 - q.x0, d: q.z1 - q.z0 }); P.solid(q.x0, q.x1, q.z0, q.z1, yS, 1.4, 'steering'); P.hot('steering', 'Local steering — steering gear (emergency steering drill)', (q.x0 + q.x1) / 2, yS, q.side === 's' ? q.z0 - 0.8 : q.z1 + 0.8, 1.3); }
      }
    }
  }
  if (er.shaft && er.shaft.z1 - er.shaft.z0 > 3) {
    const floorAft = floorRooms.filter((r) => Math.abs(r.z1 - er.z1) < 0.02 && r.x0 <= -0.8 && r.x1 >= 0.8);
    const host = floorAft.find((r) => !(r.z1 - mez1 < 1.6 && r.tag === 'c')) || floorAft[0];
    const sh = P.room({ id: 'shaft-tunnel', kind: 'engine', use: 'shaft', name: 'Shaft tunnel', x0: -1.4, x1: 1.4, z0: er.shaft.z0, z1: er.shaft.z1, y: er.floorY, h: 2.3, floor: 'grating', wall: 'dark', dark: true });
    if (host) { const at = host.x0 > -0.6 ? host.x0 + 0.7 : host.x1 < 0.6 ? host.x1 - 0.7 : -0.9; P.door(host, sh, 's', clamp(at, -0.9, 0.9), 0.9, 1.95, 'watertight'); }
    P.prop('shaft', { x: 0.55, y: er.floorY + 0.7, z0: er.shaft.z0 + 0.2, z1: er.shaft.z1 - 0.2, r: 0.3 }); P.solid(0.2, 0.9, er.shaft.z0 + 0.2, er.shaft.z1 - 0.2, er.floorY, 1.2, 'shaft');
  }
  return { levelRooms, created, upper, floorRooms };
}

// ------------------------------------------------------------------------------------------------ open decks
/** Main deck around one or more deckhouses: strips forward / between / aft, side decks alongside each house. */
function planMainDeck(P, ga, houses, { y = ga.deckY, z0, z1, name = 'Main deck', sideName = 'Side deck' } = {}) {
  P.setZone('deck', { name: 'Open decks', near: ['house', 'fwd'] });
  const hs = houses.slice().sort((a, b) => a.z0 - b.z0);
  let cur = z0;
  const out = { strips: [], sides: [] };
  hs.forEach((h, i) => {
    if (h.z0 - cur > 0.6) out.strips.push(...P.deckStrips(`deck-${i}`, cur, h.z0, y, { name, len: 8, endN: cur === z0 ? RAIL_IN : R, endS: R }));
    const sz0 = h.z0 - 1.2, sz1 = h.z1 + 1.2;
    const sideW = P.minHb(sz0, sz1) - EDGE;
    for (const side of [-1, 1]) {
      const inner = side < 0 ? h.x0 : h.x1, outer = side * sideW;
      if (Math.abs(outer - inner) < 0.9) continue;
      out.sides.push(P.room({ id: `side-${i}-${side < 0 ? 'p' : 's'}`, kind: 'deck', name: `${sideName} (${side < 0 ? 'port' : 'starboard'})`, open: true, x0: Math.min(inner, outer), x1: Math.max(inner, outer), z0: r2(sz0), z1: r2(sz1), y, h: 2.4, floor: 'deck', drawFloor: false, inset: side < 0 ? { w: RAIL_IN, e: R, n: 0, s: 0 } : { e: RAIL_IN, w: R, n: 0, s: 0 } }));
    }
    cur = h.z1;
  });
  if (z1 - cur > 0.6) out.strips.push(...P.deckStrips(`deck-aft`, cur, z1, y, { name: hs.length ? 'Aft mooring deck' : name, len: 8, endN: hs.length ? R : RAIL_IN, endS: RAIL_IN }));
  return out;
}

/** Exterior doors of the house's A-deck entrances onto the side decks. */
function houseExits(P, house, y, ti = 0) {
  const t0 = house.tiers[ti];
  for (const q of t0.rooms) {
    const ext = q.ext ? (Array.isArray(q.ext) ? q.ext : [q.ext]) : [];
    const r = P.byId(q.id);
    for (const e of ext) {
      const x = e.side === 'w' ? r.x0 - 0.6 : e.side === 'e' ? r.x1 + 0.6 : (r.x0 + r.x1) / 2, z = e.side === 'n' ? r.z0 - 0.6 : e.side === 's' ? r.z1 + 0.6 : e.at;
      const b = P.openAt(e.side === 'w' || e.side === 'e' ? x : e.at, z, y);
      P.door(r, b, e.side, e.at, e.w || 1.0, 2.05, 'ext');
    }
  }
}

function forecastle(P, ga) {
  const fc = ga.hull.fcsle; if (!fc) return null;
  const L = ga.L, yF = r2(ga.deckY + fc.h), z1 = r2(-L / 2 + fc.len);
  P.setZone('fwd', { name: 'Forecastle', near: ['deck'] });
  const zb = bowStart(P, 0.9);
  const strips = P.deckStrips('fcsle', zb, z1, yF, { name: 'Forecastle', len: 5, drawFloor: true, endN: RAIL_IN, endS: RAIL_IN });
  P.prop('raised', { z0: zb - 1.2, z1, y0: ga.deckY, y1: yF });
  // stair up from the main deck on the starboard side, just aft of the forecastle
  const last = strips.slice().sort((a, b) => b.z1 - a.z1)[0];
  const run = stairRun(fc.h, 48), sx1 = r2(Math.min(P.hb(z1 + run) - EDGE - RAIL_IN - 0.5, last.x1 - RAIL_IN - 0.45)), sx0 = r2(sx1 - 1.0);
  P.setZone('deck');
  const foot = P.openAt((sx0 + sx1) / 2, z1 + run + 0.6, ga.deckY);
  const head = strips.slice().sort((a, b) => b.z1 - a.z1)[0];
  P.setZone('fwd');
  P.stair({ id: 'fcsle-stair', x0: sx0, x1: sx1, z0: z1, z1: r2(z1 + run), yLow: ga.deckY, yHigh: yF, up: 'n', foot: foot ? foot.id : null, head: head.id, kind: 'outdoor' });
  P.rail([[-P.hb(z1) + 0.3, z1], [sx0 - 0.05, z1]], yF); P.rail([[sx1 + 0.05, z1], [P.hb(z1) - 0.3, z1]], yF);
  P.hullRails(bowStart(P, 0.35), z1, yF);
  // windlasses, mooring winches, the foremast, bollards
  for (const m of ga.deck.mooring.filter((q) => Math.abs(q.y - yF) < 0.05)) mooringGear(P, m);
  for (const m of ga.deck.masts.filter((q) => Math.abs(q.y - yF) < 0.05)) { P.prop('mast', { x: 0, z: m.z, y: yF, h: m.h, r: 0.3 }); P.solid(-0.4, 0.4, m.z - 0.4, m.z + 0.4, yF, m.h, 'mast'); }
  return { yF, z1, strips };
}
function bowStart(P, w) { for (let z = -P.L / 2; z < 0; z += 0.1) if (P.hb(z) >= w + EDGE) return r2(z + 0.2); return -P.L / 2; }
function mooringGear(P, m) {
  const big = P.L >= 150, w = big ? 2.2 : 1.6, d = big ? 1.6 : 1.2;
  const x = r2(m.side * clamp(P.hb(m.z) * 0.42, 1.6, Math.max(1.6, P.hb(m.z) - EDGE - 2.2 - w / 2)));
  const room = P.openAt(x, m.z, m.y); if (!room) return;
  const q = { x0: x - w / 2, x1: x + w / 2, z0: m.z - d / 2, z1: m.z + d / 2 };
  if (!freeRect(P, room, q, 0.6)) return;
  P.prop(m.kind === 'windlass' ? 'windlass' : 'mwinch', { x, z: m.z, y: m.y, w, d, side: m.side });
  P.solid(q.x0, q.x1, q.z0, q.z1, m.y, 1.3, m.kind);
  P.hot('winch', m.kind === 'windlass' ? `Windlass (${m.side < 0 ? 'port' : 'starboard'} anchor)` : 'Mooring winch', x, m.y, m.z + (m.z < 0 ? d / 2 + 0.9 : -d / 2 - 0.9), 1.2);
  for (const s of [-1, 1]) P.prop('bollard', { x: r2(m.side * (P.hb(m.z + s * 2.2) - EDGE - 0.15)), z: r2(m.z + s * 2.2), y: m.y });
}

/** Lifeboats, rescue boat, liferafts, gangway, muster point. */
function lifesaving(P, ga, { muster = null } = {}) {
  P.setZone('deck');
  for (const b of ga.deck.boats) {
    if (b.kind === 'freefall') {
      const len = clamp(ga.L * 0.045, 6.5, 10), z0 = b.z, z1 = z0 + len;
      if (z1 > ga.L / 2 - 0.8) continue;
      P.prop('lifeboat', { kind: 'freefall', x: 0, y: b.y, z: (z0 + z1) / 2, len, yDeck: ga.deckY });
      const room = P.openAt(0, (z0 + z1) / 2, ga.deckY);
      if (room) { P.solid(-1.7, 1.7, z0, z1, ga.deckY, Math.max(2, b.y - ga.deckY + 3), 'lifeboat'); P.hot('muster', 'Muster station — free-fall lifeboat (abandon-ship drill)', 2.6, ga.deckY, z0 + 1.0, 1.4); }
    } else if (b.kind === 'rescue' || b.kind === 'davit' || b.kind === 'tender') {
      const room = P.openAt(b.x, b.z, b.y);
      const len = b.kind === 'davit' ? 8.5 : 5.5;
      P.prop('lifeboat', { kind: b.kind, x: b.x, y: b.y, z: b.z, len, side: b.side || 1 });
      if (room && room.x1 - room.x0 > 4.2) { const x = b.side > 0 ? room.x1 - 1.1 : room.x0 + 1.1; P.solid(x - 1.0, x + 1.0, b.z - len / 2, b.z + len / 2, b.y, 2.4, 'boat'); }
      if (b.kind === 'davit') P.hot('muster', 'Lifeboat muster station', b.x - (b.side || 1) * 1.6, b.y, b.z, 1.4);
    } else if (b.kind === 'raft') P.prop('liferaft', { x: b.x, y: b.y, z: b.z, side: b.side || 1 });
  }
  if (ga.deck.gangway) { const g = ga.deck.gangway, x = r2(g.side * (P.hb(g.z) - EDGE - 0.6)); P.prop('gangwayLadder', { x, y: ga.deckY, z: g.z, side: g.side }); P.hot('gangway', 'Accommodation ladder (gangway)', x - g.side * 0.4, ga.deckY, g.z, 1.2); }
  void muster;
}

// ------------------------------------------------------------------------------------------------ cargo
function cargoHolds(P, ga, deck) {
  const c = ga.cargo, yD = ga.deckY;
  P.setZone('deck');
  for (const z of c.zones) {
    const h = z.hatch;
    P.prop('hatch', { x0: -h.w / 2, x1: h.w / 2, z0: h.z0, z1: h.z1, y: yD, h: h.h, bulk: z.hopper });
    P.solid(-h.w / 2, h.w / 2, h.z0, h.z1, yD, h.h, 'hatch');
  }
  for (const k of ga.deck.cranes) {
    const p = k.ped / 2;
    P.prop('crane', { x: k.x, z: k.z, y: yD, h: k.h, boom: k.boom, swl: k.swl, ped: k.ped });
    P.solid(k.x - p, k.x + p, k.z - p, k.z + p, yD, k.h, 'crane');
    P.hot('crane', `Deck crane (${k.swl} t SWL)`, k.x + (k.x <= 0 ? p + 0.8 : -p - 0.8), yD, k.z, 1.2);
  }
  // one hold to visit: access ladder at the hatch coaming → tank top (dark, two floodlights)
  const w = c.zones[c.walk ?? -1];
  if (w) {
    P.setZone('cargo', { name: 'Cargo hold', near: ['deck'] });
    const fy = w.floorY, len = w.z1 - w.z0;
    const hw = Math.min(P.fit(w.z0 + 0.6, w.z1 - 0.6, fy, 3) - (w.hopper ? ga.B * 0.12 : 0), ga.B / 2 - 1);
    if (hw > 1.5 && len > 4) {
      const hr = P.room({ id: 'hold', kind: 'store', use: 'hold', name: `Cargo hold ${w.i + 1} (tank top)`, x0: -hw, x1: hw, z0: w.z0 + 0.6, z1: w.z1 - 0.6, y: fy, h: r2(yD - fy - 0.15), floor: 'steel', wall: 'steel', dark: true });
      P.prop('holdShell', { x0: hr.x0, x1: hr.x1, z0: hr.z0, z1: hr.z1, y: fy, h: hr.h, hopper: !!w.hopper, B: ga.B, hatchW: w.hatch.w, cells: false });
      for (const s of [-1, 1]) P.prop('floodlight', { x: s * (hw - 0.4), y: fy + hr.h - 0.6, z: (hr.z0 + hr.z1) / 2 });
      const lx = r2(w.hatch.w / 2 + 0.55), lz = r2(w.hatch.z1 - 0.6);
      P.setZone('deck');
      P.ladder({ x: lx + 0.5, y: yD, z: lz }, { x: clamp(lx - 0.4, hr.x0 + 0.6, hr.x1 - 0.6), y: fy, z: clamp(lz, hr.z0 + 0.6, hr.z1 - 0.6) }, `hold ${w.i + 1} access ladder`, { x: lx, z: lz, y0: fy, y1: yD + w.hatch.h, hold: true });
    }
  }
  void deck;
}

function cargoBays(P, ga) {
  const c = ga.cargo, yD = ga.deckY, CT = RULES.CONTAINER;
  P.setZone('deck');
  c.zones.forEach((b, i) => {
    const top = CT.coaming + b.tiers * CT.tier;
    P.prop('bay', { x0: -b.w / 2, x1: b.w / 2, z0: b.z0, z1: b.z1, y: yD, tiers: b.tiers, rows: b.rows, coaming: CT.coaming, seed: i * 7 + 3 });
    P.solid(-b.w / 2, b.w / 2, b.z0, b.z1, yD, top, 'containers');
  });
  for (const lb of ga.deck.lashing || []) P.prop('lashingBridge', { x0: -lb.w / 2, x1: lb.w / 2, z: lb.z, y: yD + CT.coaming, tiers: lb.tiers });
  // a walkable lashing bridge just forward of the house, reached by a ladder from the side walkway
  const lb = (ga.deck.lashing || []).filter((q) => q.z < ga.house.z0).sort((a, b) => b.z - a.z)[0];
  if (lb) {
    const y = r2(yD + CT.coaming), half = lb.w / 2;
    P.setZone('cargo', { name: 'Cargo', near: ['deck'] });
    const room = P.room({ id: 'lashing-bridge', kind: 'deck', use: 'lashing', name: 'Lashing bridge', open: true, x0: -half, x1: half + 0.6, z0: lb.z0, z1: lb.z1, y, h: 2.4, floor: 'grating', drawFloor: true, inset: { n: R, s: R, w: R, e: R } });
    P.setZone('deck');
    const sideX = r2(half + 0.35);
    P.ladder({ x: Math.min(sideX + 0.4, P.hb(lb.z) - EDGE - 0.4), y: yD, z: lb.z + 0.9 }, { x: half + 0.2, y, z: lb.z }, 'lashing bridge', { x: sideX + 0.1, z: lb.z + 0.5, y0: yD, y1: y });
    void room;
  }
  // hold view through an access hatch: the cell guides of the bay ahead of the house
  const w = c.zones[c.walkBay];
  if (w) {
    P.setZone('cargo', { name: 'Cargo', near: ['deck'] });
    const fy = c.floorY, hw = Math.min(P.fit(w.z0, w.z1, fy, 3), w.w / 2 + 0.8);
    if (hw > 1.5) {
      const hr = P.room({ id: 'hold', kind: 'store', use: 'hold', name: 'Container hold (cell guides)', x0: -hw, x1: hw, z0: w.z0 + 0.2, z1: w.z1 - 0.2, y: fy, h: r2(yD - fy - 0.15), floor: 'steel', wall: 'steel', dark: true });
      P.prop('holdShell', { x0: hr.x0, x1: hr.x1, z0: hr.z0, z1: hr.z1, y: fy, h: hr.h, cells: true, rows: w.rows, hatchW: w.w });
      for (const s of [-1, 1]) P.prop('floodlight', { x: s * (hw - 0.4), y: fy + hr.h - 0.6, z: (hr.z0 + hr.z1) / 2 });
      const lx = r2(w.w / 2 + 0.6), lz = r2(w.z1 + 0.1);
      P.setZone('deck');
      P.ladder({ x: Math.min(lx + 0.4, P.hb(lz) - EDGE - 0.4), y: yD, z: lz + 0.3 }, { x: clamp(lx - 0.6, hr.x0 + 0.6, hr.x1 - 0.6), y: fy, z: hr.z1 - 0.6 }, 'hold access hatch', { x: lx, z: lz, y0: fy, y1: yD + CT.coaming, hold: true });
    }
  }
}

function cargoTanks(P, ga) {
  const c = ga.cargo, yD = ga.deckY;
  P.setZone('deck');
  const pw = c.pipes.w;
  P.prop('piperack', { x0: -pw / 2, x1: pw / 2, z0: c.pipes.z0, z1: c.pipes.z1, y: yD });
  P.solid(-pw / 2, pw / 2, c.pipes.z0, c.pipes.z1, yD, 1.4, 'pipes');
  const m = ga.deck.manifold;
  for (const side of [-1, 1]) {
    const x = side * (pw / 2 + 0.9);
    P.prop('manifold', { x, z: m.z, y: yD, side });
    P.solid(side < 0 ? x - 0.9 : pw / 2, side < 0 ? -pw / 2 : x + 0.9, m.z - 2.4, m.z + 2.4, yD, 1.6, 'manifold');
    P.hot('ccr', 'Cargo manifold — hose connections', x + side * 1.4, yD, m.z, 1.4);
  }
  for (const hc of ga.deck.hoseCranes) { P.prop('crane', { x: hc.x, z: hc.z, y: yD, h: hc.h, boom: 12, swl: hc.swl, ped: 1.2, hose: true }); P.solid(hc.x - 0.6, hc.x + 0.6, hc.z - 0.6, hc.z + 0.6, yD, hc.h, 'crane'); P.hot('crane', `Hose crane (${hc.swl} t)`, hc.x + (hc.x > 0 ? 1.2 : -1.2), yD, hc.z, 1.1); }
  for (const z of c.zones) {
    const tz = r2(z.z0 + Math.min(3, (z.z1 - z.z0) * 0.25)), x = r2(pw / 2 + 0.6);
    P.prop('tankHatch', { x, z: tz, y: yD });
    P.hot('info', 'Enclosed space — entry permit and gas test needed (SOLAS XI-1/7)', x + 0.7, yD, tz, 1.1);
  }
  if (ga.deck.domes) for (const d of ga.deck.domes) { P.prop('dome', { x: d.x, z: d.z, y: d.y ?? yD, r: d.r, h: d.h }); P.solid(d.x - d.r, d.x + d.r, d.z - d.r, d.z + d.r, d.y ?? yD, d.h, 'dome'); }
  // catwalk from the forecastle to the house front: two runs either side of the manifold, steps down at each run's end
  const cw = ga.deck.catwalk;
  if (cw) {
    const x0 = r2(cw.x - cw.w / 2), x1 = r2(cw.x + cw.w / 2), run = stairRun(cw.y - yD, 45);
    const segs = [[cw.z0, r2(m.z - 2.8 - run - 0.8), 'aft'], [r2(m.z + 2.8 + run + 0.8), r2(ga.house.z0 - 1.5 - run - 0.8), 'both']];
    P.setZone('deck');
    segs.forEach(([a, b, ends], i) => {
      if (b - a < 3) return;
      const room = P.room({ id: `catwalk-${i}`, kind: 'deck', use: 'catwalk', name: 'Catwalk', open: true, x0, x1, z0: r2(a), z1: r2(b), y: cw.y, h: 2.4, floor: 'grating', drawFloor: true, inset: { e: RAIL_IN, w: RAIL_IN, n: i === 0 ? 0 : RAIL_IN, s: RAIL_IN } });
      P.rail([[x0, a], [x0, b]], cw.y); P.rail([[x1, a], [x1, b]], cw.y);
      P.prop('catwalk', { x0, x1, z0: a, z1: b, y: cw.y });
      const footA = P.openAt(cw.x, b + run + 0.6, yD);
      if (footA) P.stair({ id: `catwalk-steps-${i}a`, x0: x0 + 0.05, x1: x1 - 0.05, z0: r2(b), z1: r2(b + run), yLow: yD, yHigh: cw.y, up: 'n', foot: footA.id, head: room.id, kind: 'outdoor' });
      if (ends === 'both') { const footF = P.openAt(cw.x, a - run - 0.6, yD); if (footF) P.stair({ id: `catwalk-steps-${i}f`, x0: x0 + 0.05, x1: x1 - 0.05, z0: r2(a - run), z1: r2(a), yLow: yD, yHigh: cw.y, up: 's', foot: footF.id, head: room.id, kind: 'outdoor' }); }
    });
  }
  if (ga.deck.compressor) {
    const k = ga.deck.compressor;
    const cr = P.room({ id: 'compressor-house', kind: 'store', use: 'compressor', name: 'Cargo compressor house', x0: k.x0, x1: k.x1, z0: k.z0, z1: k.z1, y: yD, h: 2.6, floor: 'steel', wall: 'steel' });
    for (const r of P.rooms) if (r.open && Math.abs(r.y - yD) < 0.05 && r.x0 < k.x1 && r.x1 > k.x0 && r.z0 < k.z1 && r.z1 > k.z0) r.cuts.push({ x0: k.x0, x1: k.x1, z0: k.z0, z1: k.z1 });
    const host = P.openAt(k.x1 + 0.6, (k.z0 + k.z1) / 2, yD);
    if (host) P.door(cr, host, 'e', (k.z0 + k.z1) / 2, 1.0, 2.05, 'ext');
    equipIn(P, cr, 'compressor', 1.8, 1.2, 1.5, ['w', 'n', 's']);
    P.window(cr, 'e', k.z0 + 0.5, k.z1 - 0.5, 1.2, 1.8);
  }
}

function cargoMembrane(P, ga) {
  const c = ga.cargo, t = c.trunk, yD = ga.deckY;
  P.setZone('deck');
  P.prop('trunk', { x0: -t.w / 2, x1: t.w / 2, z0: t.z0, z1: t.z1, y0: yD, y1: t.y });
  for (const r of P.rooms) if (r.open && Math.abs(r.y - yD) < 0.05 && r.x0 < t.w / 2 && r.x1 > -t.w / 2 && r.z0 < t.z1 && r.z1 > t.z0) r.cuts.push({ x0: -t.w / 2, x1: t.w / 2, z0: Math.max(t.z0, r.z0), z1: Math.min(t.z1, r.z1) });
  P.setZone('cargo', { name: 'Trunk deck', near: ['deck'] });
  const td = P.room({ id: 'trunk-deck', kind: 'deck', use: 'trunk', name: 'Trunk deck', open: true, x0: -t.w / 2, x1: t.w / 2, z0: t.z0, z1: t.z1, y: t.y, h: 2.4, floor: 'deck', drawFloor: true, inset: { n: RAIL_IN, s: RAIL_IN, e: RAIL_IN, w: RAIL_IN } });
  P.rail([[-t.w / 2, t.z0], [t.w / 2, t.z0]], t.y); P.rail([[-t.w / 2, t.z0], [-t.w / 2, t.z1]], t.y); P.rail([[t.w / 2, t.z0], [t.w / 2, t.z1]], t.y);
  for (const d of ga.deck.domes || []) { P.prop('dome', { x: d.x, z: d.z, y: t.y, r: d.r, h: d.h }); P.solid(d.x - d.r, d.x + d.r, d.z - d.r, d.z + d.r, t.y, d.h, 'dome'); }
  P.prop('piperack', { x0: t.w / 2 - 2.2, x1: t.w / 2 - 0.6, z0: t.z0 + 2, z1: t.z1 - 2, y: t.y }); P.solid(t.w / 2 - 2.2, t.w / 2 - 0.6, t.z0 + 2, t.z1 - 2, t.y, 1.2, 'pipes');
  // compressor house on the trunk deck
  const k = ga.deck.compressor;
  if (k) {
    const cr = P.room({ id: 'compressor-house', kind: 'store', use: 'compressor', name: 'Cargo compressor house', x0: k.x0, x1: k.x1, z0: k.z0, z1: k.z1, y: t.y, h: 3.2, floor: 'steel', wall: 'steel' });
    td.cuts.push({ x0: k.x0, x1: k.x1, z0: k.z0, z1: k.z1 });
    P.door(cr, td, 'w', (k.z0 + k.z1) / 2, 1.0, 2.05, 'ext');
    equipIn(P, cr, 'compressor', 2.4, 1.4, 1.8, ['e', 'n', 's']); equipIn(P, cr, 'compressor', 2.4, 1.4, 1.8, ['e', 'n', 's']);
    P.window(cr, 'w', k.z0 + 0.5, k.z1 - 0.5, 1.2, 2.0);
  }
  // stairs: up from the main deck at the aft end of the trunk (centreline, rising forward)
  const run = stairRun(t.y - yD, 45);
  P.setZone('deck');
  const foot = P.openAt(-1.0, t.z1 + run + 0.7, yD);
  if (foot) P.stair({ id: 'trunk-stair', x0: -1.6, x1: -0.5, z0: t.z1, z1: r2(t.z1 + run), yLow: yD, yHigh: t.y, up: 'n', foot: foot.id, head: td.id, kind: 'outdoor' });
  const mz = ga.deck.manifold.z;
  for (const side of [-1, 1]) { P.prop('manifold', { x: side * (t.w / 2 + 0.9), z: mz, y: yD, side }); P.hot('ccr', 'LNG manifold — vapour return and liquid lines', side * (t.w / 2 + 1.8), yD, mz, 1.3); }
}

function cargoPens(P, ga) {
  const z = ga.cargo.zones[0], yD = ga.deckY, w = z.w;
  P.setZone('cargo', { name: 'Pen decks', near: ['deck'] });
  const run = stairRun(2.6, 40), sz1 = z.z1 - 0.4, sz0 = r2(sz1 - run - 2 * LAND);
  const rooms = z.decks.map((d, k) => {
    const r = P.room({ id: `pens-${k}`, kind: 'store', use: 'pens', name: `Pen deck ${k + 1}`, x0: -w / 2, x1: w / 2, z0: z.z0, z1: z.z1, y: d.y, h: d.h, floor: 'steel', wall: 'steel' });
    P.window(r, 'w', z.z0 + 1, z.z1 - 1, 1.2, 2.2); P.window(r, 'e', z.z0 + 1, z.z1 - 1, 1.2, 2.2);
    return r;
  });
  for (const r of P.rooms) if (r.open && Math.abs(r.y - yD) < 0.05 && r.x0 < w / 2 && r.x1 > -w / 2 && r.z0 < z.z1 && r.z1 > z.z0) r.cuts.push({ x0: -w / 2, x1: w / 2, z0: Math.max(z.z0, r.z0), z1: Math.min(z.z1, r.z1) });
  // pens either side of a centre alley; a stair column at the aft end
  rooms.forEach((r, k) => {
    for (const side of [-1, 1]) {
      const x0 = side < 0 ? r.x0 + 1.3 : 1.0, x1 = side < 0 ? -1.0 : r.x1 - 1.3;
      if (x1 - x0 < 1.5) continue;
      for (let zz = r.z0 + 1.2; zz < sz0 - 5; zz += 6) { P.prop('pen', { x0, x1, z0: zz, z1: zz + 5, y: r.y, animals: (k * 7 + Math.round(zz)) % 3 }); P.solid(x0, x1, zz, zz + 5, r.y, 1.4, 'pen'); }
    }
    if (k < rooms.length - 1) P.stair({ id: `pens-flight-${k}`, x0: -0.9, x1: 0.2, z0: r2(sz1 - LAND - run), z1: r2(sz1 - LAND), yLow: r.y, yHigh: rooms[k + 1].y, up: 'n', foot: r.id, head: rooms[k + 1].id });
  });
  P.setZone('deck');
  for (const side of [-1, 1]) { const host = P.openAt(side * (w / 2 + 0.6), (z.z0 + z.z1) / 2, yD); if (host) P.door(rooms[0], host, side < 0 ? 'w' : 'e', (z.z0 + z.z1) / 2, 1.2, 2.05, 'ext'); }
  P.hot('info', 'Livestock pens — fodder and fresh water for the voyage', 0, yD, (z.z0 + z.z1) / 2, 1.6);
}

// ------------------------------------------------------------------------------------------------ working decks
function gearSolid(P, t, x, z, w, d, h, tag, extra = {}, y = P.deckY) {
  const host = P.openAt(x, z, y); if (!host) return false;
  const q = { x0: x - w / 2, x1: x + w / 2, z0: z - d / 2, z1: z + d / 2 };
  if (!freeRect(P, host, q, 0.7)) return false;
  P.prop(t, { x, y, z, w, d, h, ...extra }); P.solid(q.x0, q.x1, q.z0, q.z1, y, h, tag); return true;
}
/** Offshore, fishing, research, towing and dredging gear on the working deck aft (and anything generic: cranes). */
function deckGear(P, ga) {
  const L = ga.L, B = ga.B, yD = ga.deckY, k = ga.deck, h = ga.house;
  P.setZone('deck');
  const z0 = ga.cargo.zones[0];
  if (z0 && z0.rails) for (const s of [-1, 1]) { const pts = []; for (let z = h.z1 + 1; z <= L / 2 - 1; z += 2) pts.push([s * (P.hb(z) - EDGE - 0.15), z]); P.prop('crashRail', { pts, y: yD, h: 2.8 }); }
  for (const c of k.cranes) { const p = (c.ped || 1.4) / 2; if (!P.openAt(c.x, c.z, yD)) continue; P.prop('crane', { x: c.x, z: c.z, y: yD, h: c.h, boom: c.boom, swl: c.swl, ped: c.ped }); P.solid(c.x - p, c.x + p, c.z - p, c.z + p, yD, c.h, 'crane'); P.hot('crane', `Deck crane (${c.swl} t)`, c.x - Math.sign(c.x || 1) * (p + 0.9), yD, c.z, 1.1); }
  if (k.sternRoller) P.prop('sternRoller', { z: k.sternRoller.z, y: yD, w: k.sternRoller.w });
  if (k.sharkJaws) { gearSolid(P, 'sharkJaws', 0, k.sharkJaws.z, k.sharkJaws.w, 0.8, 0.6, 'sharkjaws'); P.hot('winch', 'Shark jaws and towing pins (anchor handling)', 1.8, yD, k.sharkJaws.z - 1.2, 1.1); }
  if (k.towPins) for (const s of [-1, 1]) P.prop('towPin', { x: s * k.towPins.x, z: k.towPins.z + 0.8, y: yD });
  if (k.towWinch && !k.towWinch.inHouse) { if (gearSolid(P, 'towWinch', 0, k.towWinch.z + 1.2, k.towWinch.w, 2.0, 2.0, 'towwinch', { drums: 2 })) P.hot('winch', 'Tow winch', 0, yD, k.towWinch.z + 3.0, 1.2); }
  for (const t of k.tankHatches || []) P.prop('tankHatch', { x: t.x, z: t.z, y: yD });
  if (k.gangway && k.gangway.tower) {
    const g = k.gangway, x = r2(g.side * (P.hb(g.z) - EDGE - 1.6));
    if (gearSolid(P, 'gangwayTower', x, g.z, 2.2, 2.2, g.y - yD + 1, 'gangway', { len: g.len, side: g.side, top: g.y })) P.hot('gangway', 'Motion-compensated gangway — walk to work', x - g.side * 1.8, yD, g.z, 1.3);
  }
  if (k.aframe) { const a = k.aframe; P.prop('aframe', { z: a.z, y: yD, w: a.w, h: a.h }); for (const s of [-1, 1]) P.solid(s * a.w / 2 - 0.3, s * a.w / 2 + 0.3, a.z - 0.3, a.z + 0.3, yD, a.h, 'aframe'); P.hot('crane', 'A-frame — deploy and recover instruments over the stern', 0, yD, a.z - 1.6, 1.3); }
  if (k.moonpool) { const m = k.moonpool; if (gearSolid(P, 'moonpool', 0, m.z, 2 * m.r, 2 * m.r, 1.0, 'moonpool')) P.hot('lab', 'Moon pool — instruments go down through the hull here', m.r + 1.0, yD, m.z, 1.2); }
  if (k.heli) P.prop('helideck', { x: 0, z: k.heli.z, y: k.heli.y ?? yD, r: k.heli.r });
  if (k.gantry) { const g = k.gantry; P.prop('gantry', { z: g.z, y: yD, w: g.w, h: g.h }); for (const s of [-1, 1]) P.solid(s * g.w / 2 - 0.3, s * g.w / 2 + 0.3, g.z - 0.3, g.z + 0.3, yD, g.h, 'gantry'); }
  for (const z of k.netDrums || []) { if (gearSolid(P, 'drum', 0, z, B * 0.42, 2.4, 2.8, 'netdrum', { len: B * 0.42, r: 1.2 })) P.hot('winch', 'Net drum', B * 0.21 + 0.9, yD, z, 1.1); }
  if (k.sternRamp) P.prop('sternRamp', { y: yD, z: L / 2, w: k.sternRamp.w });
  if (k.netBin) { const n = k.netBin; P.prop('netBin', { ...n, y: yD, h: 1.6 }); P.solid(n.x0, n.x1, n.z0, n.z1, yD, 1.6, 'netbin'); }
  if (k.powerBlock) { P.prop('powerBlock', { x: k.powerBlock.x, z: k.powerBlock.z, y: yD, h: k.powerBlock.h }); gearSolid(P, 'block', k.powerBlock.x, k.powerBlock.z, 0.8, 0.8, k.powerBlock.h, 'powerblock'); P.hot('winch', 'Power block — hauls the purse seine', k.powerBlock.x - 1.2, yD, k.powerBlock.z, 1.1); }
  if (k.purseWinch) { if (gearSolid(P, 'winch', 0, k.purseWinch.z + 1.0, k.purseWinch.w, 1.6, 1.6, 'pursewinch')) P.hot('winch', 'Purse winch', 0, yD, k.purseWinch.z + 2.6, 1.1); }
  for (const t of ga.cargo.rsw || []) { gearSolid(P, 'hatch', t.x, t.z, 1.6, 1.6, 0.6, 'rsw', { x0: t.x - 0.8, x1: t.x + 0.8, z0: t.z - 0.8, z1: t.z + 0.8 }); P.hot('info', 'RSW tank — fish kept in refrigerated sea water', t.x + 1.4, yD, t.z, 1.0); }
  if (ga.cargo.kind === 'hopper') {
    const hp = ga.cargo.zones[0];
    P.prop('hopper', { x0: -hp.w / 2, x1: hp.w / 2, z0: hp.z0, z1: hp.z1, y: yD, h: hp.coaming });
    P.solid(-hp.w / 2, hp.w / 2, hp.z0, hp.z1, yD, hp.coaming, 'hopper');
    P.hot('info', 'Hopper — dredged spoil settles here; overflow and bottom doors', hp.w / 2 + 0.8, yD, (hp.z0 + hp.z1) / 2, 1.4);
    const da = k.dragArm;
    if (da) { P.prop('dragArm', { side: da.side, z0: da.z0, z1: da.z1, y: yD, x: r2(da.side * (P.hb((da.z0 + da.z1) / 2) - 0.2)) }); for (const gz of da.gantries) gearSolid(P, 'davitGantry', r2(da.side * (P.hb(gz) - EDGE - 1.0)), gz, 1.2, 1.2, 4, 'gantry'); P.hot('crane', 'Drag-arm gantries (trailing suction pipe)', r2(da.side * (P.hb(da.z0) - EDGE - 2.4)), yD, da.z0 + 1.6, 1.2); }
  }
}
/** A 'tween deck below the main deck (factory deck) entered from a small deckhouse; a freezer hold below it. */
function tweenDeck(P, ga) {
  const t = ga.tween, yD = ga.deckY, B = ga.B;
  P.setZone('cargo', { name: 'Factory deck', near: ['deck'] });
  const hw = r2(Math.min(P.fit(t.z0, t.z1, t.y, t.h), B / 2 - 0.6));
  if (hw < 2) return;
  const f = P.room({ id: 'factory', kind: 'store', use: t.use, name: t.name, x0: -hw, x1: hw, z0: t.z0, z1: t.z1, y: t.y, h: t.h, floor: 'steel', wall: 'white' });
  // entrance deckhouse on the main deck at the forward port corner, a stair down into the factory
  const run = stairRun(yD - t.y, 50), ez0 = r2(t.z0 + 0.4), ez1 = r2(ez0 + 2 * LAND + run), ex0 = r2(-hw + 0.4), ex1 = r2(ex0 + 2 * FL + 0.3);
  P.setZone('deck');
  const ent = P.room({ id: 'factory-entrance', kind: 'stairs', use: 'stairs', name: 'Factory entrance', x0: ex0, x1: ex1, z0: ez0, z1: ez1, y: yD, h: 2.4, floor: 'steel', wall: 'steel' });
  for (const r of P.rooms) if (r.open && Math.abs(r.y - yD) < 0.05 && r.x0 < ex1 && r.x1 > ex0 && r.z0 < ez1 && r.z1 > ez0) r.cuts.push({ x0: ex0, x1: ex1, z0: ez0, z1: ez1 });
  const host = P.openAt(ex1 + 0.6, ez0 + LAND / 2 + 0.2, yD);
  if (host) P.door(ent, host, 'e', r2(ez0 + LAND / 2 + 0.2), 1.0, 2.05, 'ext');
  P.reserve(ex0, ex1 + 0.6, ez0, ez1 + 0.6, t.y - 0.1, t.y + 0.1);
  P.stair({ id: 'factory-stair', x0: r2(ex0 + 0.06), x1: r2(ex0 + FL - 0.04), z0: r2(ez0 + LAND), z1: r2(ez0 + LAND + run), yLow: t.y, yHigh: yD, up: 'n', foot: f.id, head: ent.id, kind: 'steep' });
  P.setZone('cargo');
  // processing line: conveyors down the middle, filleting machines, plate freezers along the sides
  P.prop('conveyor', { x0: -0.5, x1: 0.5, z0: t.z0 + 6, z1: t.z1 - 3, y: t.y }); P.solid(-0.5, 0.5, t.z0 + 6, t.z1 - 3, t.y, 1.0, 'conveyor');
  for (let z = t.z0 + 7; z < t.z1 - 4; z += 4.5) for (const s of [-1, 1]) { const x = s * Math.min(hw - 1.2, 3.2); const q = { x0: x - 0.7, x1: x + 0.7, z0: z - 1, z1: z + 1 }; if (freeRect(P, f, q, 0.75)) { P.prop('equip', { kind: s < 0 ? 'filleter' : 'freezer', ...q, y: t.y, h: 1.6, rotY: 0 }); P.solid(q.x0, q.x1, q.z0, q.z1, t.y, 1.6, 'factory'); } }
  P.hot('info', 'Factory deck — gutting, filleting and plate freezing', 1.2, t.y, t.z0 + 4, 1.4);
  const fz = ga.cargo.freezer;
  if (fz) {
    const fhw = r2(Math.min(P.fit(fz.z0, fz.z1, fz.y, t.y - fz.y - 0.2), B / 2 - 1));
    if (fhw > 1.5) {
      const fr = P.room({ id: 'freezer-hold', kind: 'store', use: 'hold', name: 'Freezer hold (−30 °C)', x0: -fhw, x1: fhw, z0: fz.z0, z1: fz.z1, y: fz.y, h: r2(t.y - fz.y - 0.15), floor: 'steel', wall: 'steel', dark: true });
      const lz = r2(fz.z1 - 1.2);
      P.ladder({ x: Math.min(hw - 0.8, 2.2), y: t.y, z: lz }, { x: Math.min(fhw - 0.8, 2.2), y: fz.y, z: lz }, 'freezer hold hatch', { x: Math.min(hw - 0.5, 2.6), z: lz, y0: fz.y, y1: t.y });
      P.prop('holdShell', { x0: fr.x0, x1: fr.x1, z0: fr.z0, z1: fr.z1, y: fr.y, h: fr.h, fish: true });
    }
  }
}
/** Yacht stern: the beach club at the lower-deck level opening onto the swim platform, stairs down from the aft deck. */
function yachtAft(P, ga) {
  const Y = ga.yachtAft, yD = ga.deckY, B = ga.B, L = ga.L;
  P.setZone('deck');
  const bc = Y.beachClub, sw = Y.swim;
  const hw0 = r2(Math.min(P.fit(bc.z0, bc.z1, bc.y, yD - bc.y - 0.15), B / 2 - 0.6)), hw = r2(hw0 - 1.3);
  if (hw < 2) return;
  const club = P.room({ id: 'beach-club', kind: 'mess', use: 'beachclub', name: 'Beach club', x0: -hw, x1: hw, z0: bc.z0, z1: bc.z1, y: bc.y, h: r2(yD - bc.y - 0.15), floor: 'teak', wall: 'wood' });
  const shw = r2(Math.min(B / 2 - 0.5, hw0 + 0.2));
  const plat = P.room({ id: 'swim-platform', kind: 'deck', use: 'swim', name: 'Swim platform', open: true, x0: -shw, x1: shw, z0: sw.z0, z1: sw.z1, y: sw.y, h: 2.4, floor: 'teak', drawFloor: true, inset: { n: 0, s: RAIL_IN, e: RAIL_IN, w: RAIL_IN } });
  P.door(club, plat, 's', 0, 2.4, 2.1, 'ext');
  P.window(club, 's', -hw + 0.3, -1.4, 0.3, 2.0); P.window(club, 's', 1.4, hw - 0.3, 0.3, 2.0);
  sofaIn(P, club, 2.4); counterIn(P, club, 2.0, 'bar', ['n']); equipIn(P, club, 'treadmill', 0.9, 1.9, 1.3, ['w', 'e']);
  P.hot('info', 'Beach club — sauna, bar and the swim platform', 0, bc.y, (bc.z0 + bc.z1) / 2, 1.5);
  // the tender garage beside it (to starboard) is part of the hull model; stairs down either side from the aft deck
  const run = stairRun(yD - sw.y, 45);
  for (const s of [-1, 1]) {
    const x0 = s < 0 ? -hw0 + 0.05 : hw + 0.15, x1 = x0 + 0.95;
    if (x1 > hw0 + 0.01 || x0 < -hw0 - 0.01) continue;
    const head = P.openAt((x0 + x1) / 2, sw.z0 - run - 0.5, yD);
    if (!head) continue;
    P.stair({ id: `swim-stair-${s < 0 ? 'p' : 's'}`, x0: r2(x0), x1: r2(x1), z0: r2(sw.z0 - run), z1: r2(sw.z0), yLow: sw.y, yHigh: yD, up: 'n', foot: plat.id, head: head.id, kind: 'outdoor' });
  }
  for (const r of P.rooms) if (r.open && Math.abs(r.y - yD) < 0.05 && r.z1 > sw.z0 - run - 0.1 && r.z0 < sw.z1) void 0;
  P.prop('tenderGarage', { x0: 1.0, x1: hw, z0: bc.z0, z1: bc.z1, y: bc.y });
}
/** Yachts: the main deck is tier 1 — its stair hall connects down to the lower deck inside the hull. (Flights are generic.) */
function houseStairToMain(P, ga, house) { void P; void ga; void house; }

// ------------------------------------------------------------------------------------------------ the big-ship planner
function planBig(P, ga) {
  const house = ga.house, yD = ga.deckY;
  const col0 = ga.er.column;
  if (col0) P.reserve(col0.x0 - 0.3, col0.x1 + 0.3, col0.runZ0 - LAND, col0.runZ1 + LAND, ga.er.floorY, ga.er.top);
  if (ga.yacht) P.style = 'yacht';
  planHouseTiers(P, ga, house, { style: ga.yacht ? 'yacht' : 'ship' });
  planBridge(P, ga, ga.bridge);
  // ER entrance on deck when the column does not come up inside the house
  let entrance = null;
  const col = ga.er.column || { top: 'none' };
  if (col.top === 'house') entrance = P.byId(col.entrance);
  // open decks first (the casing deckhouse and exits need them)
  const fc = forecastle(P, ga);
  const z0 = fc ? fc.z1 : bowStart(P, 0.9);
  const houses = [{ x0: house.x0, x1: house.x1, z0: house.z0, z1: house.z1 }];
  const md = planMainDeck(P, ga, houses, { z0, z1: r2(ga.L / 2 - 0.8) });
  if (fc) { const fs = P.stairs.find((s) => s.id === 'fcsle-stair'); if (fs && !fs.foot) { const f = P.openAt((fs.x0 + fs.x1) / 2, fs.z1 + 0.6, yD); if (f) fs.foot = f.id; } }
  P.hullRails(z0, ga.L / 2 - 0.2, yD);
  P.rail([[-P.hb(ga.L / 2 - 0.3) + 0.3, ga.L / 2 - 0.25], [P.hb(ga.L / 2 - 0.3) - 0.3, ga.L / 2 - 0.25]], yD);
  houseExits(P, house, yD, house.mainTier || 0);
  if (house.mainTier) houseStairToMain(P, ga, house);
  if (col.top === 'casing') {
    P.setZone('deck');
    const cx0 = Math.min(col.cx0 ?? col.x0 - 0.1, col.x0 - 0.1), cx1 = Math.max(col.cx1 ?? col.x1 + 1.3, col.x1 + 1.3);
    const cas = P.room({ id: 'er-casing', kind: 'stairs', use: 'er_entrance', name: 'Engine casing (engine room entrance)', x0: cx0, x1: cx1, z0: col.z0, z1: col.z1, y: yD, h: 2.6, floor: 'grating', wall: 'steel' });
    for (const r of P.rooms) if (r.open && Math.abs(r.y - yD) < 0.05 && r.x0 < cx1 && r.x1 > cx0 && r.z0 < col.z1 && r.z1 > col.z0) r.cuts.push({ x0: cx0, x1: cx1, z0: col.z0, z1: col.z1 });
    const side = (cx0 + cx1) / 2 < 0 ? 'w' : 'e';
    const hx = side === 'e' ? cx1 + 0.6 : cx0 - 0.6, hz = col.z0 + LAND / 2 + 0.3;
    const host = P.openAt(hx, hz, yD) || P.openAt(hx, col.z0 - 0.6, yD);
    if (host) P.door(cas, host, side, hz, 1.0, 2.05, 'ext');
    else { const h2 = P.openAt((cx0 + cx1) / 2, col.z0 - 0.6, yD); if (h2) P.door(cas, h2, 'n', (cx0 + cx1) / 2 + 0.6, 1.0, 2.05, 'ext'); }
    if (ga.casing && ga.gen === 'container') { const c = ga.casing; for (const [a, b] of [[c.x0, cx0 - 0.05], [cx1 + 0.05, c.x1]]) if (b - a > 0.5) { P.prop('block', { x0: a, x1: b, z0: c.z0, z1: c.z1, y: yD, h: 14 }); P.solid(a, b, c.z0, c.z1, yD, 14, 'casing'); } if (c.z1 - col.z1 > 0.5) { P.prop('block', { x0: cx0, x1: cx1, z0: col.z1 + 0.05, z1: c.z1, y: yD, h: 14 }); P.solid(cx0, cx1, col.z1 + 0.05, c.z1, yD, 14, 'casing'); } for (const r of P.rooms) if (r.open && Math.abs(r.y - yD) < 0.05 && r.x0 < c.x1 && r.x1 > c.x0 && r.z0 < c.z1 && r.z1 > c.z0) void 0; const f = ga.funnel; P.prop('funnel', { x: f.x, z: f.z, y: yD + 14, h: f.h, r: f.r }); }
    entrance = cas;
    P.sign(cx1 - 0.06, yD + 1.75, col.z0 + 0.8, -Math.PI / 2, ['ENGINE CASING', '▼ engine room']);
  }
  planEngineRoom(P, ga, ga.er, { entranceRoom: entrance });
  if (ga.er.hatch) { // yacht: crew access to the engine room by a deck hatch and ladder
    const hz = ga.er.hatch.z, host = P.openAt(ga.er.hatch.x, hz, yD) || P.openAt(-ga.er.hatch.x, hz, yD) || P.openAt(0, hz, yD);
    const frs = P.rooms.filter((r) => r.zone === 'er' && r.level === 0 && r.walk !== false);
    let spot = null, best = Infinity;
    for (const r of frs) for (let zz = r.z0 + 0.6; zz < r.z1 - 0.5; zz += 0.2) for (let xx = r.x0 + 0.6; xx < r.x1 - 0.5; xx += 0.2) {
      if (P.solids.some((q) => xx > q.x0 - R - 0.15 && xx < q.x1 + R + 0.15 && zz > q.z0 - R - 0.15 && zz < q.z1 + R + 0.15 && q.y < r.y + 1.7 && q.y + q.h > r.y)) continue;
      const d = Math.hypot(xx - ga.er.hatch.x, zz - hz); if (d < best) { best = d; spot = { x: xx, z: zz, y: r.y }; }
    }
    if (host && spot) { const dz = clamp(spot.z, host.z0 + 0.6, host.z1 - 0.6), hx = clamp(spot.x, host.x0 + 0.6, host.x1 - 0.6); P.setZone('deck'); P.prop('escapeHatch', { x: hx + 0.6, z: dz, y: yD }); P.ladder({ x: hx, y: yD, z: dz }, { x: r2(spot.x), y: spot.y, z: r2(spot.z) }, 'engine room hatch'); }
  }
  // escape trunk: a vertical ladder from the ER floor to the open deck aft of the house
  const esc = ga.er.escape;
  if (esc) {
    const fl = P.rooms.filter((r) => r.zone === 'er' && r.level === 0 && r.kind === 'engine' && r.walk !== false).sort((a, b) => b.z1 - a.z1);
    const dk = P.rooms.filter((r) => r.open && Math.abs(r.y - yD) < 0.05 && r.z0 >= house.z1 - 0.5).sort((a, b) => a.z0 - b.z0);
    const a = fl.find((r) => (esc.side < 0 ? r.x0 < -1 : r.x1 > 1)) || fl[0], b = dk[0];
    if (a && b) {
      const ax = esc.side < 0 ? a.x0 + 0.7 : a.x1 - 0.7, az = a.z1 - 0.8, bx = clamp(esc.side * 2.6, b.x0 + 0.6, b.x1 - 0.6), bz = r2(clamp(b.z0 + 1.0, b.z0 + 0.6, b.z1 - 0.6));
      P.ladder({ x: ax, y: a.y, z: az }, { x: bx, y: yD, z: bz }, 'emergency escape trunk', { x: ax, z: az, y0: a.y, y1: yD, trunk: true });
      P.prop('escapeHatch', { x: bx + 0.6 * Math.sign(bx || 1), z: bz, y: yD });
    }
  }
  // cargo
  const kind = ga.cargo.kind;
  if (kind === 'holds') cargoHolds(P, ga, md);
  else if (kind === 'bays') cargoBays(P, ga);
  else if (kind === 'tanks') cargoTanks(P, ga);
  else if (kind === 'membrane') cargoMembrane(P, ga);
  else if (kind === 'pens') cargoPens(P, ga);
  else if (kind === 'deck' || kind === 'hopper') deckGear(P, ga);
  if (ga.tween) tweenDeck(P, ga);
  if (ga.yachtAft) yachtAft(P, ga);
  // mooring gear on the main deck aft, lifesaving, masts
  P.setZone('deck');
  for (const m of ga.deck.mooring.filter((q) => Math.abs(q.y - yD) < 0.05)) mooringGear(P, m);
  lifesaving(P, ga);
  P.setZone('deck');
  for (const b of [-P.L / 2 + 6, P.L / 2 - 3]) for (const s of [-1, 1]) P.prop('bollard', { x: r2(s * (P.hb(b) - EDGE - 0.1)), z: r2(b), y: yD });
}

// ------------------------------------------------------------------------------------------------ levels, go-to, entry point
function finishCommon(P, ga) {
  // levels: every floor height you can stand on
  const ys = new Map();
  for (const l of ga.levels || []) ys.set(r2(l.y), l.name);
  for (const r of P.rooms) if (!ys.has(r2(r.y))) ys.set(r2(r.y), r.name);
  P.levels = [...ys.entries()].sort((a, b) => a[0] - b[0]).map(([y, name]) => ({ y, name, kind: y < P.deckY - 0.5 ? 'below' : 'deck' }));
  // go-to points snapped to free floor
  const snap = (g) => {
    const dist = (r) => Math.hypot(Math.max(r.x0 - g.x, 0, g.x - r.x1), Math.max(r.z0 - g.z, 0, g.z - r.z1)) + Math.abs(r.y - g.y) * 3;
    let cands = P.rooms.filter((r) => r.walk !== false && Math.abs(r.y - g.y) < 0.3);
    if (!cands.length) cands = P.rooms.filter((q) => q.walk !== false);
    cands = cands.map((r) => [dist(r), r]).sort((a, b) => a[0] - b[0]).slice(0, 8).map((q) => q[1]);
    let best = null;
    for (const r of cands) {
      if (best && dist(r) > best.d) break;
      const x0 = r.x0 + r.inset.w + 0.05, x1 = r.x1 - r.inset.e - 0.05, z0 = r.z0 + r.inset.n + 0.05, z1 = r.z1 - r.inset.s - 0.05;
      if (x1 <= x0 || z1 <= z0) continue;
      const near = [...P.solidsNear(x0 - 1, x1 + 1, z0 - 1, z1 + 1)];
      for (let k = 0; k <= 30; k++) for (let a = 0; a < (k ? 12 : 1); a++) {
        const x = clamp(g.x + Math.cos((a / 12) * 2 * Math.PI) * k * 0.25, x0, x1), z = clamp(g.z + Math.sin((a / 12) * 2 * Math.PI) * k * 0.25, z0, z1);
        if (near.some((s) => x > s.x0 - R - 0.05 && x < s.x1 + R + 0.05 && z > s.z0 - R - 0.05 && z < s.z1 + R + 0.05 && s.y < r.y + 1.7 && s.y + s.h > r.y + 0.08)) continue;
        if ([...r.floorHoles, ...r.cuts].some((h) => x > h.x0 - R - 0.05 && x < h.x1 + R + 0.05 && z > h.z0 - R - 0.05 && z < h.z1 + R + 0.05)) continue;
        if (P.stairs.some((s) => Math.abs(s.yLow - r.y) < 0.05 && x > s.x0 - R - 0.05 && x < s.x1 + R + 0.05 && z > s.z0 - R - 0.1 && z < s.z1 + R + 0.1)) continue;
        const d = Math.hypot(x - g.x, z - g.z) + Math.abs(r.y - g.y) * 3;
        if (!best || d < best.d) best = { x: r2(x), z: r2(z), y: r.y, d, room: r.id };
        break;
      }
    }
    return best;
  };
  const seen = new Set();
  // cruise ships (interiors v2): every guest venue is a Go-to entry (casino, theatre, restaurants, pools, spa …)
  const venueSeeds = ga.type === 'cruise' && P.cruiseV2 ? cruiseGotoSeeds(ga) : [];
  const seeds = venueSeeds.length ? [...(ga.goto || []).filter((g) => g.id !== 'theatre' && g.id !== 'reception'), ...venueSeeds] : (ga.goto || []);
  for (const g of seeds) {
    if (seen.has(g.id)) continue;
    let tgt = g;
    if (g.room === 'ecr') { const r = P.byId('er-ecr'); if (!r) continue; tgt = { ...g, x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2, y: r.y }; }
    else if (g.room === 'er-floor') { const eh = P.hotspots.find((h) => h.kind === 'engine' && h.zone === 'er' && Math.abs(h.y - g.y) < 0.1); if (eh) tgt = { ...g, x: eh.x, z: eh.z }; }
    else if (g.room) { const r = P.byId(g.room); if (r) tgt = { ...g, x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2, y: r.y }; }
    if (g.id === 'hold') { const r = P.byId('hold'); if (!r) continue; tgt = { ...g, x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2, y: r.y }; }
    if (g.id === 'lashing') { const r = P.byId('lashing-bridge'); if (!r) continue; tgt = { ...g, x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2, y: r.y }; }
    // per-deck plans (cruise, big ro-pax): a point on a deck that is not loaded travels there (`deck`), and is snapped
    // when that deck's plan is built
    if (P.deckGroup && ga.pax && !P.rooms.some((r) => r.walk !== false && Math.abs(r.y - tgt.y) < 0.3 && tgt.x >= r.x0 - 3 && tgt.x <= r.x1 + 3 && tgt.z >= r.z0 - 3 && tgt.z <= r.z1 + 3)) {
      const decks = ga.pax.decks, named = typeof g.room === 'string' && g.room.startsWith('deck:') ? g.room.slice(5) : null;
      const below = decks.filter((d) => d.y <= tgt.y + 0.3), deck = named || (below.length ? below[below.length - 1] : decks[0]).id;
      if (deck !== P.deckGroup) { P.goto.push({ id: g.id, label: g.label, x: r2(tgt.x), y: tgt.y, z: r2(tgt.z), deck }); seen.add(g.id); continue; }
    }
    const s = snap(tgt);
    if (s) { P.goto.push({ id: g.id, label: g.label, x: s.x, y: s.y, z: s.z }); seen.add(g.id); }
  }
  if (P.L > 60) P.hotspots.push({ kind: 'goto', label: 'Go to… (quick travel)', x: P.spawn.x - 0.6, y: P.spawn.y, z: P.spawn.z, r: 1.0, zone: P.byId(ga.bridge?.room)?.zone || P.roomAt(P.spawn.x, P.spawn.z, P.spawn.y)?.zone || P.rooms[0]?.zone || 'deck' });
  for (const [, z] of P.zoneList) if (!Number.isFinite(z.y0)) { z.y0 = 0; z.y1 = 0; }
}

/**
 * planFromGA(GA | variantId, opts) → Plan. opts.deck: the deck id to load on passenger ships (cruise / big ferries:
 * one deck plus the stair landings of its neighbours); omitted = the deck the bridge is on.
 */
export function planFromGA(gaOrId, opts = {}) {
  const ga = typeof gaOrId === 'string' ? generalArrangement(gaOrId) : gaOrId;
  if (!ga || ga.gen === 'sail') return null;
  if (IV2_READY.has(ga.gen) && opts.v !== 1 && globalThis.__iv2 !== false) return planV2(ga, opts);   // IV2 HV1 (docs/INTERIORS-V2-CONTRACT.md §9.5)
  const P = new GPlan(ga);
  const layout = ga.layout;
  if (layout === 'big') planBig(P, ga);
  else if (PLANNERS[layout]) PLANNERS[layout](P, ga, opts);
  else throw new Error(`[gaplan] no planner for layout ${layout}`);
  finishCommon(P, ga);
  return P.finish();
}
export const _internals = { GPlan, furnish, planHouseTiers, planBridge, planEngineRoom, planMainDeck, houseExits, forecastle, lifesaving, mooringGear, bowStart, freeRect, placeAgainst, equipIn, bunkIn, counterIn, tableAt, sofaIn, deskIn, lockersIn, rotOf, finishCommon, EDGE, RAIL_IN, HULL_IN };

// ------------------------------------------------------------------------------------------------ small craft
const LS = 0.95;   // small-craft stair landing
/** A small engine room: engines (twin side by side), generator, pipes and a wall console with live gauges. */
function smallEngines(P, ga, r, { twin = false } = {}) {
  const me = ga.er.me, n = twin || me.n >= 2 ? 2 : 1, y = r.y;
  const W = r.x1 - r.x0, D = r.z1 - r.z0;
  const ew = Math.min(me.w, (W - 1.3) / n - (n > 1 ? 0.7 : 0)), el = Math.min(me.len, D - 1.6), eh = Math.min(me.h, r.h - 0.4);
  if (ew < 0.4 || el < 0.8) { P.hot('engine', 'Check the engine', (r.x0 + r.x1) / 2, y, (r.z0 + r.z1) / 2, 1.6); return; }
  const cz = (r.z0 + r.z1) / 2 + (D > 4 ? 0.3 : 0);
  const xs = n === 2 ? [r.x0 + W * 0.28, r.x0 + W * 0.72] : [(r.x0 + r.x1) / 2];
  for (const x of xs) {
    const q = { x0: x - ew / 2 - 0.15, x1: x + ew / 2 + 0.15, z0: cz - el / 2 - 0.15, z1: cz + el / 2 + 0.15 };
    if (!freeRect(P, r, q, 0.3)) continue;
    P.prop('engine', { x, y, z: cz, len: el, w: ew, h: eh });
    P.solid(q.x0, q.x1, q.z0, q.z1, y, eh + 0.4, 'engine');
  }
  P.prop('pipes', { x0: r.x0, x1: r.x1, z0: r.z0, z1: r.z1, y, h: r.h });
  const side = r.x1 > -r.x0 ? 'e' : 'w';
  const cx = side === 'e' ? r.x1 - 0.06 : r.x0 + 0.06, czc = clamp(r.z0 + 1.2, r.z0 + 0.7, r.z1 - 0.7);
  P.prop('console', { x: cx, y, z: czc, rotY: side === 'e' ? -Math.PI / 2 : Math.PI / 2, wall: true });
  P.hot('engine', 'Check the engine (rpm, fuel, temperature)', cx + (side === 'e' ? -0.8 : 0.8), y, czc, 1.4);
}

function planSmall(P, ga) {
  const S = ga.small, L = ga.L, B = ga.B, yD = ga.deckY, yB = S.yB, hB = S.hB;
  P.style = S.yacht || ga.gen === 'motor_yacht' ? 'yacht' : 'ship';
  P.edge = 0.3; P.railInset = 0.14;
  const d = S.dh, wk = S.wh;
  P.setZone('house', { name: 'Deckhouse', near: ['deck', 'er'] });
  // ---------------------------------------------------------------- deckhouse: front room + stair hall
  let hall = null, front = null, upFlight = null, downCol = null;
  const runDown = S.runDown, runUp = S.runUp;
  if (d) {
    const W = d.x1 - d.x0, hz0 = S.hall.z0;
    front = P.room({ id: wk === 'front' ? 'bridge' : 'saloon', kind: wk === 'front' ? 'bridge' : 'mess', use: wk === 'front' ? 'bridge' : 'mess', name: wk === 'front' ? 'Wheelhouse' : S.yacht ? 'Saloon, galley & lower helm' : 'Mess & galley', x0: d.x0, x1: d.x1, z0: d.z0, z1: hz0, y: yD, h: d.h, floor: S.yacht ? 'wood' : 'lino', wall: S.yacht ? 'wood' : 'white' });
    hall = P.room({ id: 'hall', kind: 'passage', use: 'stairs', name: wk === 'front' ? 'Companionway' : 'Stair hall', x0: d.x0, x1: d.x1, z0: hz0, z1: d.z1, y: yD, h: d.h, floor: S.yacht ? 'wood' : 'lino', wall: S.yacht ? 'wood' : 'white' });
    const wx1 = r2(d.x1 - 0.95), wx0 = wk === 'roof' ? r2(d.x0 + 0.95) : d.x0;
    P.opening(front, hall, 's', r2((wx0 + wx1) / 2), r2(Math.max(0.8, Math.min(1.2, wx1 - wx0 - 0.1))));
    P.window(front, 'n', d.x0 + 0.25, d.x1 - 0.25, 1.0, 2.0); P.window(front, 'e', d.z0 + 0.3, hz0 - 0.3, 1.0, 2.0); P.window(front, 'w', d.z0 + 0.3, hz0 - 0.3, 1.0, 2.0);
    downCol = { x0: r2(d.x1 - 0.92), x1: r2(d.x1 - 0.12) };
    if (wk === 'roof') upFlight = { x0: r2(d.x0 + 0.12), x1: r2(d.x0 + 0.92) };
    P.reserve(downCol.x0 - 0.2, downCol.x1, hz0, d.z1, yB, yD);
    if (upFlight) P.reserve(upFlight.x0, upFlight.x1 + 0.2, hz0, d.z1, yD, S.whY);
  }
  // ---------------------------------------------------------------- below deck: compartments from the bow to the stern (ga.small)
  P.setZone('er', { name: 'Below deck', near: ['house', 'deck'] });
  const fitAt = (z0, z1) => (S.twin ? 0 : Math.min(P.fit(z0, z1, yB, hB), B / 2 - 0.3));
  const below = S.compartments;
  const rooms = [];
  below.forEach((c, i) => {
    let hw = fitAt(c.z0, c.z1);
    if (c.stair && downCol) hw = Math.max(hw, 0);   // checked below
    if (hw < 0.75) return;
    const base = { y: yB, h: c.h || hB, z0: c.z0, z1: c.z1, floor: c.furn === 'engine' || c.furn === 'steering' ? 'grating' : P.style === 'yacht' ? 'wood' : 'lino', wall: c.furn === 'engine' || c.furn === 'steering' ? 'dark' : P.style === 'yacht' ? 'wood' : 'white' };
    if (c.layout === 'pair' && 2 * hw >= 4.4) {
      const pass = P.room({ id: `b${i}-pass`, kind: 'passage', name: 'Passage', x0: -0.55, x1: 0.55, ...base });
      const cp = P.room({ id: `b${i}-p`, kind: 'cabin', name: c.name.replace(/s$/, ''), x0: -hw, x1: -0.55, ...base, floor: P.style === 'yacht' ? 'wood' : 'carpet', berth: 1 });
      const cs = P.room({ id: `b${i}-s`, kind: 'cabin', name: c.name.replace(/s$/, ''), x0: 0.55, x1: hw, ...base, floor: P.style === 'yacht' ? 'wood' : 'carpet', berth: 1 });
      P.door(cp, pass, 'e', (c.z0 + c.z1) / 2 + 0.3, 0.75, 1.95); P.door(cs, pass, 'w', (c.z0 + c.z1) / 2 + 0.3, 0.75, 1.95);
      rooms.push({ c, link: pass, all: [pass, cp, cs] });
    } else {
      const kind = c.furn === 'engine' || c.furn === 'steering' ? 'engine' : c.furn === 'hold' ? 'store' : c.furn === 'stair' ? 'passage' : c.furn === 'mess' || c.furn === 'saloon' ? 'mess' : 'cabin';
      const r = P.room({ id: `b${i}`, kind, use: c.furn, name: c.name, x0: -hw, x1: hw, ...base, dark: kind === 'engine' || c.furn === 'hold', berth: kind === 'cabin' ? 1 : 0 });
      rooms.push({ c, link: c.furn === 'hold' ? null : r, all: [r] });
    }
  });
  // the open cockpit's companionway (cruiser): keep its footprint clear of the saloon furniture
  let cockpitStair = null;
  if (!d && wk === 'cockpit') { const sr = rooms.find((q) => q.c.furn === 'saloon'); if (sr) { const r = sr.all[0], run = stairRun(yD - yB, 56); const sx0 = r2(Math.max(r.x0 + 0.12, -1.0)); cockpitStair = { r, run, x0: sx0, x1: r2(sx0 + 0.76), z0: r2(r.z1 - 0.3 - run), z1: r2(r.z1 - 0.3) }; P.reserve(sx0 - 0.1, sx0 + 0.95, cockpitStair.z0 - LS, cockpitStair.z1 + 0.3, yB, yD); } }
  // doors along the centreline between neighbouring compartments (the fish hold is entered by a ladder from deck)
  for (let i = 0; i < rooms.length - 1; i++) {
    const a = rooms[i], b = rooms[i + 1];
    if (!a.link || !b.link || Math.abs(a.c.z1 - b.c.z0) > 0.02) continue;
    const lo = Math.max(a.link.x0, b.link.x0), hi = Math.min(a.link.x1, b.link.x1);
    if (hi - lo < 0.8) continue;
    const zb = a.c.z1, clear = (x) => !P.reserved.some((q) => q.y0 <= yB + 0.1 && q.y1 >= yB && x + 0.55 > q.x0 && x - 0.25 < q.x1 && zb + 1.0 > q.z0 && zb - 1.0 < q.z1);
    const at = [0, 0.6, -0.6, 1.1, -1.1, 1.6, -1.6].map((x) => clamp(x, lo + 0.4, hi - 0.4)).find((x) => clear(x - 0.15)) ?? clamp(0, lo + 0.4, hi - 0.4);
    P.door(a.link, b.link, 's', at, Math.min(0.75, hi - lo - 0.05), 1.9, b.c.furn === 'engine' || a.c.furn === 'engine' ? 'watertight' : 'door');
  }
  // the companionway from the hall (or the cockpit) down into the stair compartment
  const stairRoom = rooms.find((q) => q.c.stair);
  if (hall && stairRoom && downCol) {
    const sr = stairRoom.all[0];
    const x1 = Math.min(downCol.x1, sr.x1 - 0.05), x0 = r2(x1 - 0.8);
    P.setZone('house');
    P.stair({ id: 'companionway', x0, x1, z0: r2(hall.z0 + LS), z1: r2(hall.z0 + LS + runDown), yLow: yB, yHigh: yD, up: 'n', foot: sr.id, head: hall.id, kind: 'steep' });
  }
  // furniture below
  P.setZone('er');
  for (const { c, all } of rooms) {
    if (c.furn === 'engine') smallEngines(P, ga, all[0], { twin: (ga.er.me.n || 1) >= 2 });
    else if (c.furn === 'steering') { const r = all[0]; const q = placeAgainst(P, r, Math.min(1.8, r.x1 - r.x0 - 1.4), 0.9, ['s']); if (q) { P.prop('steeringGear', { x: (q.x0 + q.x1) / 2, y: r.y, z: (q.z0 + q.z1) / 2, w: q.x1 - q.x0, d: q.z1 - q.z0, azimuth: /Azimuth/.test(c.name) }); P.solid(q.x0, q.x1, q.z0, q.z1, r.y, 1.3, 'steering'); P.hot('steering', /Azimuth/.test(c.name) ? 'Azimuth thruster drives (Z-drives)' : 'Steering gear', (q.x0 + q.x1) / 2, r.y, q.z0 - 0.8, 1.2); } }
    else if (c.furn === 'hold') { const r = all[0]; P.prop('holdShell', { x0: r.x0, x1: r.x1, z0: r.z0, z1: r.z1, y: r.y, h: r.h, fish: true }); }
    else if (c.furn === 'vberth') { const r = all[0]; const len = Math.max(0.6, r.z1 - r.z0 - 0.8), w = Math.min(1.9, r.x1 - r.x0 + 0.2); P.prop('bunk', { x: (r.x0 + r.x1) / 2, y: r.y, z: r.z0 + len / 2, along: 'z', len, tiers: 1, w, vberth: true }); P.solid(r.x0, r.x1, r.z0, r.z0 + len, r.y, 0.6, 'bunk'); P.hot('bunk', 'Rest in the berth', (r.x0 + r.x1) / 2, r.y, r.z0 + len + 0.35, 1.3); }
    else if (c.furn === 'owner') { furnish(P, all[0], 'owner'); }
    else if (c.furn === 'saloon') { const r = all[0]; counterIn(P, r, 1.4, 'galley', ['e', 'w']); sofaIn(P, r, 1.8); }
    else if (c.furn === 'mess') { const r = all[0]; counterIn(P, r, Math.min(2, r.z1 - r.z0 - 1), 'galley', ['w', 'e']); tableAt(P, r, (r.x0 + r.x1) / 2 + 0.4, (r.z0 + r.z1) / 2, 0.7, 1.0, false); }
    else if (c.furn === 'cabin2') bunkIn(P, all[0], 'Rest in the bunk', 2);
    else if (c.furn === 'stair') { /* the passage under the hall */ }
    else for (const r of all) if (r.kind === 'cabin') bunkIn(P, r);
  }
  // ---------------------------------------------------------------- twin hulls (crew transfer vessel): an engine room in each demihull
  if (S.twin && hall) {
    const t = ga.hull.twin;
    for (const side of [-1, 1]) {
      const z0 = hall.z0, z1 = Math.min(L / 2 - 2.2, hall.z1 + 4.2), xc = side * t.xc;
      const dh = demihullAt(ga, (z0 + z1) / 2, yB);
      let hh = Infinity; for (let k = 0; k <= 8; k++) { const q = demihullAt(ga, z0 + ((z1 - z0) * k) / 8, yB); hh = Math.min(hh, q.half); }
      void dh; hh = Math.min(hh, t.hullB / 2) - 0.2;
      if (hh < 0.6) continue;
      const r = P.room({ id: `hull-${side < 0 ? 'p' : 's'}`, kind: 'engine', name: `Engine room (${side < 0 ? 'port' : 'starboard'} hull)`, x0: r2(xc - hh), x1: r2(xc + hh), z0, z1, y: yB, h: hB, floor: 'grating', wall: 'dark', dark: true });
      P.setZone('house');
      const sx = side < 0 ? Math.max(xc, hall.x0 + 0.5, r.x0 + 0.5) : Math.min(xc, hall.x1 - 0.5, r.x1 - 0.5);
      P.stair({ id: `hullstair-${side < 0 ? 'p' : 's'}`, x0: r2(sx - 0.4), x1: r2(sx + 0.4), z0: r2(z0 + LS), z1: r2(z0 + LS + runDown), yLow: yB, yHigh: yD, up: 'n', foot: r.id, head: hall.id, kind: 'steep' });
      P.setZone('er');
      const me = ga.er.me, el = Math.min(me.len, z1 - z0 - LS - runDown - 1.6), ew = Math.min(me.w, 2 * hh - 0.9);
      if (el > 0.8 && ew > 0.4) { const ez = z1 - 0.4 - el / 2; P.prop('engine', { x: xc, y: yB, z: ez, len: el, w: ew, h: Math.min(me.h, hB - 0.4) }); P.solid(xc - ew / 2 - 0.1, xc + ew / 2 + 0.1, ez - el / 2 - 0.1, ez + el / 2 + 0.1, yB, Math.min(me.h, hB - 0.4) + 0.3, 'engine'); }
      P.prop('console', { x: r.x1 - 0.06, y: yB, z: z0 + 0.7, rotY: -Math.PI / 2, wall: true });
      P.hot('engine', 'Check the engine (rpm, fuel, temperature)', r.x1 - 0.7, yB, z0 + 0.7, 1.3);
      P.deck.holes.push({ x0: r.x0, x1: r.x1, z0: z0, z1: z1 });   // (the cross deck is above the wet deck: no hole needed)
      P.deck.holes.pop();
    }
  }
  // ---------------------------------------------------------------- open decks, helm, wheelhouse
  P.setZone('deck', { name: 'Open decks', near: ['house'] });
  const zf = bowStart(P, 0.45);
  const zAft = L / 2 - 0.4;
  let strips = [];
  if (d) {
    strips.push(...P.deckStrips('deck-fwd', zf, d.z0, yD, { name: 'Foredeck', len: 3, endS: R }));
    const sw = P.minHb(d.z0 - 0.6, d.z1 + 0.6) - P.edge;
    for (const side of [-1, 1]) {
      const inner = side < 0 ? d.x0 : d.x1, outer = side * sw;
      if (Math.abs(outer - inner) < 0.62) continue;
      strips.push(P.room({ id: `side-${side < 0 ? 'p' : 's'}`, kind: 'deck', name: `Side deck (${side < 0 ? 'port' : 'starboard'})`, open: true, x0: Math.min(inner, outer), x1: Math.max(inner, outer), z0: r2(d.z0 - 0.6), z1: r2(d.z1 + 0.6), y: yD, floor: 'deck', drawFloor: false, inset: side < 0 ? { w: RAIL_IN, e: R, n: 0, s: 0 } : { e: RAIL_IN, w: R, n: 0, s: 0 } }));
    }
    strips.push(...P.deckStrips('deck-aft', d.z1, zAft, yD, { name: ga.gen === 'tug' ? 'Towing deck' : ga.gen === 'fishing' ? 'Working deck' : S.yacht ? 'Aft deck (cockpit)' : 'Aft deck', len: 4, endN: R }));
    const aft0 = P.openAt(0, d.z1 + 0.6, yD);
    if (aft0) P.door(hall, aft0, 's', r2((hall.x0 + hall.x1) / 2), 0.9, 1.95, 'ext');
    for (const side of [-1, 1]) { const sd = P.byId(`side-${side < 0 ? 'p' : 's'}`); if (sd && front.z1 - front.z0 >= 2.0) P.door(front, sd, side < 0 ? 'w' : 'e', r2(front.z1 - 0.8), 0.8, 1.95, 'ext'); }
  } else strips.push(...P.deckStrips('deck', zf, zAft, yD, { name: wk === 'cockpit' ? 'Cockpit & deck' : 'Deck', len: 2.5 }));
  P.hullRails(zf - 0.4, L / 2 - 0.25, yD);
  // ---------------------------------------------------------------- the helm
  P.setZone('house');
  const helmAt = (room, x, z, w, facing = -1) => {
    P.prop('helm', { x, y: room.y, z, w, facing, small: true }); P.solid(x - w / 2, x + w / 2, z - 0.35, z + 0.35, room.y, 1.25, 'console');
    P.hot('helm', 'Take the helm', x, room.y, z - facing * 0.95, 1.4); P.helm = { x, y: room.y, z: z - facing * 0.95 };
  };
  let wh = null;
  if (wk === 'front') wh = front;
  else if (wk === 'roof' && d) {
    const z1 = r2(hall.z0 + LS + runUp + 0.15);
    wh = P.room({ id: 'bridge', kind: 'bridge', use: 'bridge', name: 'Wheelhouse', x0: d.x0, x1: d.x1, z0: d.z0, z1, y: S.whY, h: 2.25, floor: 'lino', wall: 'white' });
    for (const sd of ['n', 's']) P.window(wh, sd, d.x0 + 0.2, d.x1 - 0.2, 0.95, 2.1);
    for (const sd of ['e', 'w']) P.window(wh, sd, d.z0 + 0.2, z1 - 0.2, 0.95, 2.1);
    P.stair({ id: 'wheelhouse-stair', x0: upFlight.x0, x1: upFlight.x1, z0: r2(hall.z0 + LS), z1: r2(hall.z0 + LS + runUp), yLow: yD, yHigh: S.whY, up: 'n', foot: hall.id, head: wh.id, kind: 'steep' });
  }
  if (wh) {
    const W = wh.x1 - wh.x0;
    helmAt(wh, wk === 'front' ? r2(Math.min(0.5, W / 2 - 1.0)) : 0, r2(wh.z0 + 0.55), r2(Math.min(1.6, W - 1.6)));
    P.prop('radio', { x: wh.x0 + 0.4, y: wh.y + 1.4, z: wh.z0 + 0.3, rotY: 0 }); P.hot('radio', 'Use the VHF radio (chat)', wh.x0 + 0.7, wh.y, wh.z0 + 1.3, 1.0);
    for (const c of ga.bridge.consoles.filter((q) => q.kind === 'ecdis' || q.kind === 'sonar')) { const x = clamp(c.x, wh.x0 + 0.5, wh.x1 - 0.5); P.prop('equip', { kind: c.kind === 'sonar' ? 'sonar' : 'mfd', x0: x - 0.35, x1: x + 0.35, z0: wh.z0 + 0.2, z1: wh.z0 + 0.9, y: wh.y, h: 1.25, rotY: 0 }); }
    if (ga.bridge.aftConsole && wk === 'roof') {
      const az = wh.z1 - 0.55, aw = Math.min(1.4, W - 2.4), ax = r2(Math.min(W / 2 - aw / 2 - 0.3, 0.6));
      if (aw > 0.6 && freeRect(P, wh, { x0: ax - aw / 2, x1: ax + aw / 2, z0: az - 0.35, z1: az + 0.35 }, 0.3)) { P.prop('helm', { x: ax, y: wh.y, z: az, w: aw, facing: 1, aft: true, small: true }); P.solid(ax - aw / 2, ax + aw / 2, az - 0.35, az + 0.35, wh.y, 1.25, 'console'); P.hot('thrusters', ga.gen === 'tug' ? 'Aft control station — azimuth levers, tow winch' : 'Aft control station — winches and net drum', ax, wh.y, az - 1.0, 1.1); }
    }
    if (ga.gen === 'tug' && wk === 'roof') P.hot('thrusters', 'Azimuth levers (forward station)', -Math.min(0.9, W / 2 - 0.7), wh.y, wh.z0 + 1.4, 0.9);
    P.spawn = { x: P.helm.x + 0.4, y: wh.y, z: P.helm.z + 0.4, yaw: 0 };
  }
  if (wk === 'flybridge' && d) {
    // flybridge on the saloon roof, an outdoor stair up from the aft deck; lower helm in the saloon
    helmAt(front, r2(Math.min(0.6, (d.x1 - d.x0) / 2 - 0.9)), r2(front.z0 + 0.5), 1.1);
    const fy = S.whY, fz0 = r2(d.z0 + 0.5), fz1 = r2(d.z1 + 0.3);
    const fb = P.room({ id: 'flybridge', kind: 'bridge', use: 'flybridge', name: 'Flybridge', open: true, x0: d.x0, x1: d.x1, z0: fz0, z1: fz1, y: fy, floor: 'teak', drawFloor: true, inset: { n: RAIL_IN, s: RAIL_IN, e: RAIL_IN, w: RAIL_IN } });
    const frun = stairRun(fy - yD, 52), fsx1 = r2(d.x1 - 0.12), fsx0 = r2(fsx1 - 0.8);
    P.setZone('deck');
    const foot = P.openAt((fsx0 + fsx1) / 2, fz1 + frun + 0.5, yD);
    P.setZone('house');
    if (foot) P.stair({ id: 'fly-stair', x0: fsx0, x1: fsx1, z0: fz1, z1: r2(fz1 + frun), yLow: yD, yHigh: fy, up: 'n', foot: foot.id, head: fb.id, kind: 'outdoor' });
    P.prop('helm', { x: -0.2, y: fy, z: fz0 + 0.6, w: 1.3, facing: -1, upper: true }); P.solid(-0.85, 0.45, fz0 + 0.25, fz0 + 0.95, fy, 1.2, 'console');
    P.hot('helm', 'Take the helm (flybridge)', -0.2, fy, fz0 + 1.55, 1.2);
    P.rail([[fsx0, fz1], [d.x0, fz1], [d.x0, fz0], [d.x1, fz0], [d.x1, fz1 - 0.01]], fy);
    sofaIn(P, fb, 1.8);
    P.spawn = { x: P.helm.x + 0.4, y: yD, z: P.helm.z + 0.4, yaw: 0 };
  }
  if (!d) {
    // open boats: a centre console (RIB) or an open cockpit helm (cruiser) with a companionway down to the saloon
    const host = strips.find((r) => r.z0 <= 0.5 && r.z1 >= 0.5) || strips[Math.floor(strips.length / 2)];
    if (wk === 'console') {
      helmAt(host, 0, 0.3, 0.8);
      P.prop('windscreen', { x0: -0.5, x1: 0.5, z: -0.05, y: yD, gap: [0, 0] });
      const seat = strips.find((r) => r.z0 <= 2.2 && r.z1 >= 2.2) || host; P.prop('sofa', { x0: -0.55, x1: 0.55, z0: 2.0, z1: 2.5, y: yD }); P.solid(-0.55, 0.55, 2.0, 2.5, yD, 0.6, 'seat'); void seat;
    } else {
      const sal = rooms.find((q) => q.c.furn === 'saloon');
      const cz0 = r2(sal ? sal.c.z1 + 0.15 : 0.05 * L), hostC = P.openAt(0.9, cz0 + 0.45, yD) || host;
      helmAt(hostC, 0.9, r2(cz0 + 0.45), 0.8);
      P.prop('windscreen', { x0: -P.hb(cz0) + 0.5, x1: P.hb(cz0) - 0.5, z: cz0 - 0.05, y: yD, gap: [-0.42, 0.42] });
      if (cockpitStair) { const { r, z0, z1, x0, x1 } = cockpitStair; P.stair({ id: 'companionway', x0, x1, z0, z1, yLow: yB, yHigh: yD, up: 's', foot: r.id, head: (P.openAt(0, z1 + 0.4, yD) || host).id, kind: 'steep' }); }
    }
    P.prop('radio', { x: P.helm.x - 0.3, y: yD + 1.1, z: P.helm.z - 1.0, rotY: 0 }); P.hot('radio', 'Use the VHF radio (chat)', P.helm.x - 0.5, yD, P.helm.z, 0.9);
    P.spawn = { x: P.helm.x + 0.3, y: yD, z: P.helm.z + 0.3, yaw: 0 };
  }
  // ---------------------------------------------------------------- deck gear, fish hold ladder, engine escape, outboards
  P.setZone('deck');
  if (ga.er.outboard) { P.prop('outboard', { x: 0, y: yD, z: L / 2 - 0.1, n: ga.er.me.n || 2 }); const st = strips.slice().sort((a, b) => b.z1 - a.z1)[0]; P.hot('engine', 'Check the outboards (rpm, fuel)', 0, yD, Math.min(st.z1 - 0.5, L / 2 - 0.8), 1.2); }
  const holdRoom = rooms.find((q) => q.c.furn === 'hold')?.all[0];
  if (holdRoom) { const z = clamp((holdRoom.z0 + holdRoom.z1) / 2, holdRoom.z0 + 0.6, holdRoom.z1 - 0.6), host = P.openAt(0.9, z, yD); if (host) { P.prop('hatch', { x0: -0.6, x1: 0.6, z0: z - 0.6, z1: z + 0.6, y: yD, h: 0.45 }); P.solid(-0.6, 0.6, z - 0.6, z + 0.6, yD, 0.45, 'hatch'); P.ladder({ x: 1.0, y: yD, z }, { x: clamp(0.2, holdRoom.x0 + 0.5, holdRoom.x1 - 0.5), y: holdRoom.y, z: clamp(z + 0.8, holdRoom.z0 + 0.5, holdRoom.z1 - 0.5) }, 'fish hold hatch'); } }
  if (S.hold) { const z0 = r2(-L / 2 + S.hold[0] * L), z1 = r2(-L / 2 + S.hold[1] * L), z = (z0 + z1) / 2; P.prop('hatch', { x0: -0.55, x1: 0.55, z0: z - 0.55, z1: z + 0.55, y: yD, h: 0.4 }); P.solid(-0.55, 0.55, z - 0.55, z + 0.55, yD, 0.4, 'fishhold'); P.hot('info', 'Fish hold (ice and boxes)', 0.95, yD, z, 1.0); }
  // an engine room not reached through a door gets a deck hatch with a ladder
  const erRoom = rooms.find((q) => q.c.furn === 'engine')?.all[0];
  if (erRoom && !P.doors.some((dd) => dd.a === erRoom.id || dd.b === erRoom.id)) {
    const z = clamp(erRoom.z0 + 0.8, erRoom.z0 + 0.5, erRoom.z1 - 0.5), host = P.openAt(-0.8, z, yD) || P.openAt(0.8, z, yD);
    if (host) P.ladder({ x: clamp(-0.8, host.x0 + 0.5, host.x1 - 0.5), y: yD, z }, { x: clamp(-0.6, erRoom.x0 + 0.5, erRoom.x1 - 0.5), y: erRoom.y, z: clamp(z + 0.3, erRoom.z0 + 0.5, erRoom.z1 - 0.5) }, 'engine room hatch');
  }
  for (const g of S.gear) smallGear(P, ga, g);
  // coachroofs over raised compartments, with the companionway hatch left open
  let blockTo = -Infinity;
  for (const { c, all } of rooms) {
    if (!c.roof) continue;
    const x0 = Math.min(...all.map((r) => r.x0)) - 0.05, x1 = Math.max(...all.map((r) => r.x1)) + 0.05, h = r2(c.roof - yD);
    const holes = P.stairs.filter((st) => st.x1 > x0 && st.x0 < x1 && st.z1 > c.z0 && st.z0 < c.z1).map((st) => ({ x0: st.x0 - R - 0.05, x1: st.x1 + R + 0.05, z0: st.z0 - (st.up === 'n' ? R + 0.1 : 0), z1: st.z1 + (st.up === 's' ? R + 0.6 : 0) }));
    void 0;
    P.prop('coachroof', { x0, x1, z0: c.z0, z1: c.z1, y: yD, h, hatch: holes[0] ? { x0: holes[0].x0, x1: holes[0].x1, z0: holes[0].z0, z1: c.z1 } : { x0: 0, x1: 0, z0: c.z1, z1: c.z1 } });
    // the deck there is the cabin top: cut out of the walkable deck (not a solid, which would also stop the walker below)
    for (const r of P.rooms) {
      if (!r.open || Math.abs(r.y - yD) > 0.05 || r.x0 > x1 || r.x1 < x0 || r.z0 > c.z1 || r.z1 < c.z0) continue;
      for (const q of rectMinus({ x0: Math.max(r.x0, x0), x1: Math.min(r.x1, x1), z0: Math.max(r.z0, c.z0), z1: Math.min(r.z1, c.z1) }, holes)) if (q.x1 - q.x0 > 0.05 && q.z1 - q.z0 > 0.05) r.cuts.push(q);
      const side = Math.max(x0 - (r.x0 + RAIL_IN), (r.x1 - RAIL_IN) - x1);
      if (side < 0.6) { r.walk = r.z1 <= c.z1 + 0.01 ? false : r.walk; blockTo = Math.max(blockTo, c.z1); }
    }   // (bottom raised: the walker below passes under it)
  }
  if (blockTo > -Infinity) for (const r of P.rooms) if (r.open && Math.abs(r.y - yD) < 0.05 && r.z1 <= blockTo + 0.01) r.walk = false;
  for (const m of [-L / 2 + Math.max(1.6, L * 0.06), L / 2 - 1.0]) for (const s of [-1, 1]) P.prop('bollard', { x: r2(s * (P.hb(m) - 0.45)), z: r2(m), y: yD });
  P.levels = [];
}
function smallGear(P, ga, g) {
  const L = ga.L, B = ga.B, yD = ga.deckY, d = ga.small.dh;
  const put = (t, x, z, w, dd, h, tag, extra = {}) => { const host = P.openAt(x, z, yD); if (!host || !freeRect(P, host, { x0: x - w / 2, x1: x + w / 2, z0: z - dd / 2, z1: z + dd / 2 }, 0.6)) return false; P.prop(t, { x, y: yD, z, w, d: dd, h, ...extra }); P.solid(x - w / 2, x + w / 2, z - dd / 2, z + dd / 2, yD, h, tag); return true; };
  switch (g) {
    case 'towWinchFwd': { const z = r2((d.z0 + -L / 2 + L * 0.08) / 2); if (put('towWinch', 0, z, Math.min(2.6, B * 0.3), 1.6, 1.6, 'towwinch')) P.hot('winch', 'Tow winch (forward, ASD towing over the bow)', 0, yD, z + 1.4, 1.1); break; }
    case 'towWinchAft': { const z = r2(d.z1 + 2.4); if (put('towWinch', 0, z, Math.min(2.8, B * 0.32), 1.6, 1.6, 'towwinch')) P.hot('winch', 'Tow winch (aft)', 0, yD, z + 1.4, 1.1); break; }
    case 'towHook': { const z = r2(d.z1 + Math.min(2.4, (L / 2 - d.z1) * 0.4)); if (put('towhook', 0, z, 1.0, 1.0, 1.6, 'towhook')) P.hot('winch', 'Towing hook', 0, yD, z + 1.1, 1.0); break; }
    case 'pushKnees': P.prop('pushKnees', { y: yD, z: -L / 2, w: B * 0.6 }); break;
    case 'fenders': P.prop('tugFender', { L, B, y: yD }); break;
    case 'crane': { const z = r2(d.z1 + 1.6), x = r2(B / 2 - 1.6); if (put('crane', x, z, 1.2, 1.2, 4.5, 'crane', { boom: 12, swl: 25, ped: 1.2 })) P.hot('crane', 'Deck crane (25 t)', x - 1.2, yD, z, 1.1); break; }
    case 'anchorWinch': { const z = r2(L / 2 - 4); put('winch', 0, z, 2.2, 1.2, 1.3, 'winch'); P.hot('winch', 'Anchor-handling winch', 0, yD, z - 1.3, 1.0); break; }
    case 'gantry': case 'gantrySmall': { const z = r2(L / 2 - 1.6), w = B * (g === 'gantry' ? 0.76 : 0.5); P.prop('gantry', { z, y: yD, w, h: g === 'gantry' ? 6 : 3.5 }); for (const s of [-1, 1]) P.solid(s * w / 2 - 0.25, s * w / 2 + 0.25, z - 0.25, z + 0.25, yD, 6, 'gantry'); break; }
    case 'netDrum': { const z = r2(L / 2 - 7); if (put('drum', 0, z, B * 0.45, 2.2, 2.6, 'netdrum', { len: B * 0.45, r: 1.1 })) P.hot('winch', 'Net drum', B * 0.25 + 0.9, yD, z, 1.0); break; }
    case 'sternRamp': P.prop('sternRamp', { y: yD, z: L / 2, w: B * 0.3 }); break;
    case 'derricks': for (const s of [-1, 1]) P.prop('derrick', { x: s * 0.6, y: yD, z: r2(-0.05 * L), side: s, len: B * 1.1 }); P.solid(-0.9, 0.9, -0.05 * L - 0.5, -0.05 * L + 0.5, yD, 6, 'derrick'); break;
    case 'beamWinch': { const z = r2(d.z1 + 2); if (put('winch', 0, z, 2.6, 1.4, 1.4, 'winch')) P.hot('winch', 'Beam-trawl winch', 0, yD, z + 1.3, 1.0); break; }
    case 'potHauler': { const x = r2(P.hb(d.z1 + 1) - 0.8); P.prop('potHauler', { x, y: yD, z: d.z1 + 1 }); P.hot('winch', 'Pot hauler', x - 0.8, yD, d.z1 + 1, 1.0); break; }
    case 'haulingPort': P.prop('haulingPort', { x: B / 2, y: yD, z: r2(-0.15 * L) }); P.hot('info', 'Hauling port — the longline comes aboard here', r2(P.hb(-0.15 * L) - 0.9), yD, r2(-0.15 * L), 1.1); break;
    case 'lineDrum': { const z = r2(L / 2 - 6); put('drum', 0, z, B * 0.4, 2.0, 2.2, 'linedrum', { len: B * 0.4, r: 1.0 }); break; }
    case 'pilotDeck': P.prop('pilotRail', { L, B, y: yD }); P.hot('gangway', 'Pilot boarding — step across to the ladder here', r2(P.hb(0) - 0.6), yD, 0, 1.1); break;
    case 'bowFender': P.prop('bowFender', { y: yD, z: -L / 2, w: B * 0.7 }); { const z = r2(-L / 2 + 2.2); const host = P.openAt(0, z, yD); if (host) P.hot('gangway', 'Transfer area — step across to the turbine ladder', 0, yD, Math.max(z, host.z0 + 0.6), 1.2); } break;
    case 'transfer': break;
    case 'swimPlatform': P.prop('swimPlatform', { y: r2(Math.max(0.3, yD - 0.8)), z: L / 2, w: B * 0.9 }); break;
    case 'tenderDeck': P.prop('tender', { x: 0, y: yD + 2.5, z: d ? d.z1 - 1 : 0, len: 3.2 }); break;
    case 'outboards': break;
    default: break;
  }
}
PLANNERS.small = planSmall;

// ------------------------------------------------------------------------------------------------ passenger ships
// Ferries and cruise ships: a stack of decks with stair towers (flights + lifts) through all of them. Cruise ships and
// the big ro-pax are planned one deck at a time (opts.deck): that deck in full plus the tower landings of the decks
// above and below, so the stairs have somewhere to arrive; interior.js reloads when you reach the next deck.
const PUBLIC = {
  cruise: [['Theatre', 'theatre'], ['Shops & boutiques', 'shop'], ['Atrium & reception', 'atrium'], ['Casino', 'lounge'], ['Main dining room', 'dining'], ['Piano bar', 'bar'], ['Library & card room', 'lounge'], ['Specialty restaurant', 'dining'], ['Nightclub', 'bar'], ['Art gallery', 'lounge'], ['Medical centre', 'hospital'], ['Main dining room (upper)', 'dining']],
  ferry: [['Reception & information', 'atrium'], ['Cafeteria', 'dining'], ['Shop', 'shop'], ['Bar & lounge', 'bar'], ['Restaurant', 'dining'], ['Children\'s play area', 'lounge'], ['Reclining seat lounge', 'seats']],
  hsc: [['Seating saloon', 'seats'], ['Café & bar', 'bar'], ['Duty-free shop', 'shop'], ['Seating saloon', 'seats']],
};
function paxFurnish(P, r, kind) {
  const W = r.x1 - r.x0, D = r.z1 - r.z0, cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2, y = r.y;
  switch (kind) {
    case 'theatre': {
      const q = placeAgainst(P, r, Math.min(W - 4, 14), Math.min(4, D * 0.3), ['n']);
      if (q) { P.prop('stage', { x0: q.x0, x1: q.x1, z0: q.z0, z1: q.z1, y, h: 0.9 }); P.solid(q.x0, q.x1, q.z0, q.z1, y, 0.9, 'stage'); }
      const rows = Math.floor((D - (q ? q.z1 - r.z0 : 0) - 3) / 1.6);
      for (let i = 0; i < Math.min(rows, 10); i++) { const z = (q ? q.z1 : r.z0) + 2.2 + i * 1.6; P.prop('seatRow', { x0: r.x0 + 1.6, x1: -0.9, z, y }); P.prop('seatRow', { x0: 0.9, x1: r.x1 - 1.6, z, y }); P.solid(r.x0 + 1.6, -0.9, z - 0.3, z + 0.3, y, 0.9, 'seats'); P.solid(0.9, r.x1 - 1.6, z - 0.3, z + 0.3, y, 0.9, 'seats'); }
      return;
    }
    case 'dining': for (let x = r.x0 + 2.2; x < r.x1 - 1.6; x += 3.2) for (let z = r.z0 + 2.2; z < r.z1 - 1.8; z += 3.0) tableAt(P, r, x, z, 1.0, 1.0, false); counterIn(P, r, Math.min(6, W * 0.4), 'pantry', ['s', 'n']); return;
    case 'bar': counterIn(P, r, Math.min(8, Math.max(W, D) * 0.4), 'bar', ['n', 'w', 'e']); for (let x = r.x0 + 2.2; x < r.x1 - 1.6; x += 3.4) for (let z = r.z0 + 3; z < r.z1 - 1.8; z += 3.4) tableAt(P, r, x, z, 0.7, 0.7, false); return;
    case 'shop': counterIn(P, r, Math.min(5, W * 0.4), 'shop', ['n', 'w']); for (let x = r.x0 + 2; x < r.x1 - 2; x += 3.2) { const q = { x0: x - 0.5, x1: x + 0.5, z0: cz - 1.2, z1: cz + 1.2 }; if (freeRect(P, r, q, 0.8)) { P.prop('equip', { kind: 'shelves', ...q, y, h: 1.6, rotY: 0 }); P.solid(q.x0, q.x1, q.z0, q.z1, y, 1.6, 'shelves'); } } return;
    case 'atrium': { const q = placeAgainst(P, r, Math.min(5, W * 0.3), 0.9, ['n', 's']); if (q) { P.prop('counter', { ...q, y, kind: 'reception' }); P.solid(q.x0, q.x1, q.z0, q.z1, y, 1.1, 'reception'); P.hot('info', 'Reception — information and excursions', (q.x0 + q.x1) / 2, y, q.side === 'n' ? q.z1 + 0.9 : q.z0 - 0.9, 1.3); } P.prop('chandelier', { x: cx, y: y + r.h - 0.2, z: cz }); return; }
    case 'lounge': sofaIn(P, r, 3); sofaIn(P, r, 3); for (let x = r.x0 + 2.5; x < r.x1 - 2; x += 4) tableAt(P, r, x, cz, 0.9, 0.9, false); return;
    case 'seats': for (let z = r.z0 + 1.6; z < r.z1 - 1.4; z += 1.25) for (const [a, b] of [[r.x0 + 1.2, -0.8], [0.8, r.x1 - 1.2]]) if (b - a > 1) { P.prop('seatRow', { x0: a, x1: b, z, y, recline: true }); P.solid(a, b, z - 0.35, z + 0.35, y, 1.0, 'seats'); } return;
    case 'hospital': furnish(P, r, 'hospital'); return;
    case 'galley': furnish(P, r, 'galley'); return;
    case 'mess': furnish(P, r, 'mess'); return;
    case 'buffet': counterIn(P, r, Math.min(10, W * 0.6), 'buffet', ['n', 's']); for (let x = r.x0 + 2.2; x < r.x1 - 1.6; x += 3.2) for (let z = r.z0 + 3.4; z < r.z1 - 1.8; z += 3.0) tableAt(P, r, x, z, 0.9, 0.9, false); return;
    case 'spa': equipIn(P, r, 'treadmill', 0.9, 1.9, 1.3, ['n', 'w']); equipIn(P, r, 'treadmill', 0.9, 1.9, 1.3, ['n', 'w']); equipIn(P, r, 'bike', 0.6, 1.2, 1.2, ['n', 'e']); equipIn(P, r, 'weights', 1.4, 0.7, 1.2); return;
    case 'laundry': furnish(P, r, 'laundry'); return;
    case 'store': furnish(P, r, 'shelves'); return;
    default: return;
  }
}

function planPax(P, ga, opts = {}) {
  const X = ga.pax, L = ga.L, B = ga.B, decks = X.decks;
  const cruise = ga.type === 'cruise', hsc = ga.model === 'hsc112', de = X.doubleEnded;
  const cruiseV2 = cruise && !!opts.iv2 && globalThis.__iv2 !== false;   // the cruise deck programme of interiors v2
  P.cruiseV2 = cruiseV2;
  P.style = 'ship';
  const bridgeDeck = decks[X.bridgeDeck - 1];
  const cur = opts.deck ? decks.find((d) => d.id === opts.deck) || bridgeDeck : bridgeDeck;
  const full = X.perDeck ? [cur] : decks;
  const ci = decks.indexOf(cur);
  const landings = X.perDeck ? [decks[ci - 1], decks[ci + 1]].filter(Boolean) : [];
  P.deckGroup = X.perDeck ? cur.id : null;
  const towerW = (d) => (B > 26 ? 6.4 : B > 16 ? 5.2 : 4.0);
  const half = (d, z0, z1) => {
    // inside the hull below its top: the plating; above: the superstructure line (balconies outboard of it)
    if (d.y < X.hullTop - 0.1) return Math.min(P.fit(z0, z1, d.y, d.h), B / 2 - 0.4);
    const m = P.minHb(z0, z1) - 0.3;
    return d.use === 'cabin' && cruise ? m - 1.5 : d.use === 'sun' || d.use === 'lido' ? m - 0.15 : m;
  };
  const span = (d) => {
    if (d.use === 'car') return [r2(bowStart(P, B * 0.3) + (ga.cargo.bowDoor ? 2.5 : 1.0)), r2(L / 2 - 1.5)];
    if (d.y < X.hullTop - 0.1 || d.use === 'crew' && d.y < X.hullTop + 3) return [r2(-L * 0.4), r2(L * 0.4)];
    if (d.use === 'sun') return [r2(-L * 0.3), r2(L * 0.44)];
    if (de) return [r2(-L * 0.32), r2(L * 0.32)];
    return [r2(-L / 2 + (cruise ? 0.1 : 0.12) * L), r2(L / 2 - 0.06 * L)];
  };
  const towers = X.towers;
  const flightFor = (t, d) => { const rise = d.h + 0.12, run = stairRun(rise, 38); const fx0 = -towerW(d) / 2 + 0.1; return { x0: r2(fx0), x1: r2(fx0 + 1.3), runZ1: r2(t.z1 - LAND), runZ0: r2(t.z1 - LAND - run) }; };
  const towerRooms = new Map();
  const mkTower = (d, t, w) => {
    const id = `${d.id}-${t.id}`;
    const r = P.room({ id, kind: 'stairs', use: 'stairs', name: `Stairway & lifts (${d.name})`, x0: r2(-w / 2), x1: r2(w / 2), z0: t.z0, z1: t.z1, y: d.y, h: d.h, floor: d.use === 'car' ? 'steel' : 'carpet', wall: 'white', deck: d.id });
    towerRooms.set(id, r);
    // lift bank on the starboard side of the stairwell; the lift takes you to any deck (Go to)
    const lx0 = r2(w / 2 - 1.9), q = { x0: lx0, x1: r2(w / 2 - 0.1), z0: r2(t.z0 + 1.6), z1: r2(t.z0 + 4.2) };
    P.prop('lifts', { ...q, y: d.y, h: d.h }); P.solid(q.x0, q.x1, q.z0, q.z1, d.y, d.h - 0.1, 'lifts');
    P.hot('goto', `Lift — go to another deck (${d.name})`, q.x0 - 0.8, d.y, (q.z0 + q.z1) / 2, 1.2, { decks: decks.map((k) => ({ id: k.id, label: k.name, y: k.y })) });
    P.sign(q.x0 - 0.06, d.y + 1.8, q.z1 + 0.8, -Math.PI / 2, [d.name.toUpperCase(), `▲ ${decks[decks.length - 1].name.split(' (')[0]}   ▼ ${decks[0].name.split(' (')[0]}`]);
    return r;
  };
  // the crew stair down to the engine room comes up on deck 1: keep vehicles and furniture off its landing
  if (full.includes(decks[0]) && !ga.er.twinHull) { const er = ga.er, sx0 = paxErStairX(P, ga, decks[0]), run = stairRun(decks[0].y - er.floorY, 52); P.reserve(sx0 - 0.4, sx0 + 2.2, er.z0 - 0.6, er.z0 + 2 * LAND + run + 9, decks[0].y - 0.1, decks[0].y + 0.1); }
  if (full.includes(decks[0]) && ga.er.twinHull) for (const sd of [-1, 1]) { const xc = sd * (ga.hull.twin.xc - ga.hull.twin.hullB / 2 + 0.9), run = stairRun(decks[0].y - ga.er.floorY, 55); P.reserve(xc - 1.2, xc + 1.2, ga.er.z0 - 0.6, ga.er.z0 + 2 * LAND + run + 1.2, decks[0].y - 0.1, decks[0].y + 0.1); }
  // -------------------------------------------------------------- full decks
  const deckRooms = new Map();
  for (const d of full) {
    P.setZone(`deck:${d.id}`, { name: d.name, near: [] });
    let [z0, z1] = span(d);
    if (d.id === bridgeDeck.id) { z0 = ga.bridge.z1; if (ga.bridge.twin) z1 = Math.min(z1, -ga.bridge.z1); }
    const rooms = [];
    const ts = towers.filter((t) => t.z0 > z0 + 1 && t.z1 < z1 - 1);
    const blocks = []; let a = z0;
    for (const t of ts) { if (t.z0 - a > 1.5) blocks.push([a, t.z0]); a = t.z1; }
    if (z1 - a > 1.5) blocks.push([a, z1]);
    // the towers
    const tw = new Map();
    for (const t of ts) {
      const hw = half(d, t.z0, t.z1);
      let w = towerW(d);
      if (d.use === 'cabin' || d.use === 'crew') { const g = cabinGeom(ga, d, hw); w = g.two ? 2 * (hw - g.dO) : 2 * hw; }
      else if (d.use === 'public' || d.use === 'lido') w = Math.max(towerW(d), Math.min(2 * hw - 1, 12));
      tw.set(t.id, mkTower(d, t, r2(Math.min(2 * hw, w))));
    }
    const plan = cruiseV2 ? cruiseDeckPlan(P, ga, d, tw) : paxDeckPlan(P, ga, d, blocks, tw, ts, half, { cruise, hsc, de });
    rooms.push(...plan);
    deckRooms.set(d.id, rooms);
    if (d.id === bridgeDeck.id) paxBridge(P, ga, d, half);
  }
  // -------------------------------------------------------------- landings of the neighbour decks (per-deck plans)
  for (const d of landings) {
    P.setZone(`deck:${d.id}`, { name: d.name, near: [] });
    const [z0, z1] = span(d);
    for (const t of towers.filter((q) => q.z0 > z0 + 1 && q.z1 < z1 - 1 && towerRooms.has(`${cur.id}-${q.id}`))) { const hw = half(d, t.z0, t.z1); mkTower(d, t, r2(Math.min(2 * hw, towerW(d)))); }
  }
  // -------------------------------------------------------------- flights in every tower between built decks
  const built = [...full, ...landings].sort((p, q) => p.y - q.y);
  // one run for the whole stairwell: every flight lands where the next one starts (no landing under a flight)
  let maxRise = 0; for (let k = 0; k < decks.length - 1; k++) maxRise = Math.max(maxRise, decks[k + 1].y - decks[k].y);
  const towerRun = stairRun(maxRise, 38);
  for (let k = 0; k < built.length - 1; k++) {
    const a = built[k], b = built[k + 1];
    if (decks.indexOf(b) !== decks.indexOf(a) + 1) continue;
    for (const t of towers) {
      const ra = towerRooms.get(`${a.id}-${t.id}`), rb = towerRooms.get(`${b.id}-${t.id}`);
      if (!ra || !rb) continue;
      const f = flightFor(t, a), run = towerRun;
      P.setZone(ra.zone);
      P.stair({ id: `flight-${a.id}-${t.id}`, x0: f.x0, x1: f.x1, z0: r2(t.z1 - LAND - run), z1: r2(t.z1 - LAND), yLow: a.y, yHigh: b.y, up: 'n', foot: ra.id, head: rb.id, kind: 'stair' });
    }
  }
  // -------------------------------------------------------------- engine room under deck 1 (when deck 1 is loaded)
  if (full.includes(decks[0])) paxEngineRoom(P, ga, decks[0]);
  for (const d of [...full, ...landings]) { const z = P.zoneList.get(`deck:${d.id}`); if (z) for (const n of [decks[decks.indexOf(d) - 1], decks[decks.indexOf(d) + 1]]) if (n) z.near.add(`deck:${n.id}`); }
  if (!P.spawn) { const tr = towerRooms.get(`${cur.id}-${towers[Math.floor(towers.length / 2)].id}`) || [...towerRooms.values()][0]; 
    // a free spot in the tower lobby: clear of the lifts, the flights and their holes
    const free = (x, z) => !P.solids.some((q) => x > q.x0 - R - 0.1 && x < q.x1 + R + 0.1 && z > q.z0 - R - 0.1 && z < q.z1 + R + 0.1 && q.y < tr.y + 1.7 && q.y + q.h > tr.y)
      && !P.stairs.some((q) => x > q.x0 - R - 0.1 && x < q.x1 + R + 0.1 && z > q.z0 - LAND && z < q.z1 + LAND && Math.abs(q.yLow - tr.y) > 0.05 && q.yLow < tr.y + 2 && q.yHigh > tr.y - 0.1)
      && x > tr.x0 + R + 0.1 && x < tr.x1 - R - 0.1 && z > tr.z0 + R + 0.1 && z < tr.z1 - R - 0.1;
    const cz = (tr.z0 + tr.z1) / 2;
    let sp = null;
    for (let k = 0; k < 40 && !sp; k++) for (const [dx, dz] of [[0.6, -1], [0, -1], [-0.6, -1], [0.6, 1], [0, 1], [0, 0], [-0.6, 0], [0.6, 0]]) { const x = dx + (k % 2 ? -1 : 1) * Math.floor(k / 2) * 0.2, z = cz + dz + Math.floor(k / 4) * 0.1; if (free(x, z)) { sp = { x: r2(x), z: r2(z) }; break; } }
    P.spawn = { x: sp ? sp.x : 0.6, y: tr.y, z: sp ? sp.z : cz - 1, yaw: 0 }; }
  P.house = { z0: span(cur)[0], z1: span(cur)[1] };
}

/** One deck: blocks between the towers become cabins (two corridors), public rooms, car deck, lido, crew spaces. */
function paxDeckPlan(P, ga, d, blocks, tw, ts, half, { cruise, hsc, de }) {
  const B = ga.B, L = ga.L, X = ga.pax, y = d.y, h = d.h, out = [];
  const link = (r, z, side) => { // connect a block room to the tower at its fore (side 'n') or aft ('s') end
    const t = [...tw.values()].find((q) => (side === 'n' ? Math.abs(q.z1 - z) < 0.02 : Math.abs(q.z0 - z) < 0.02));
    if (!t) return;
    const lo = Math.max(r.x0, t.x0), hi = Math.min(r.x1, t.x1);
    if (hi - lo < 1.0) return;
    // through the walkway column of the stairwell (starboard of the flights, port of the lifts)
    const wx0 = t.x0 + 1.5, wx1 = t.x1 - 2.0;
    const a = Math.max(lo, wx0) + 0.1, b = Math.min(hi, wx1) - 0.1;
    if (b - a >= 0.9) P.opening(r, t, side, r2((a + b) / 2), r2(Math.min(2.4, b - a)));
    else if (hi - lo >= 1.05) P.door(r, t, side, r2((lo + hi) / 2), r2(Math.min(0.95, hi - lo - 0.1)));
  };
  const isBoat = X.boatDeck === d.id;
  blocks.forEach(([z0, z1], bi) => {
    const hw = r2(half(d, z0, z1)), id = (s) => `${d.id}-b${bi}-${s}`;
    if (hw < 1.6) return;
    if (d.use === 'car') {
      const r = P.room({ id: id('car'), kind: 'store', use: 'cardeck', name: d.name, x0: -hw, x1: hw, z0, z1, y, h, floor: 'steel', wall: 'steel', dark: true });
      out.push(r); link(r, z0, 'n'); link(r, z1, 's');
      carLanes(P, r, bi);
      return;
    }
    if (d.use === 'sun' || (d.use === 'lido' && bi === Math.floor(blocks.length / 2))) {
      const r = P.room({ id: id('open'), kind: 'deck', use: d.use === 'lido' ? 'pool' : 'sundeck', name: d.use === 'lido' ? 'Lido & pool deck' : d.name, open: true, x0: -hw, x1: hw, z0, z1, y, h: 2.4, floor: 'teak', drawFloor: true, inset: { n: R, s: R, e: RAIL_IN, w: RAIL_IN } });
      out.push(r); P.rail([[-hw, z0], [-hw, z1]], y); P.rail([[hw, z0], [hw, z1]], y);
      for (const t of tw.values()) { if (Math.abs(t.z1 - z0) < 0.02) P.door(t, r, 's', r2((t.x0 + t.x1) / 2), 1.2, 2.05, 'ext'); if (Math.abs(t.z0 - z1) < 0.02) P.door(t, r, 'n', r2((t.x0 + t.x1) / 2), 1.2, 2.05, 'ext'); }
      if (d.use === 'lido') { const pw = Math.min(hw * 0.9, 6), pl = Math.min((z1 - z0) * 0.45, 14), pz = (z0 + z1) / 2; P.prop('pool', { x0: -pw, x1: pw, z0: pz - pl / 2, z1: pz + pl / 2, y }); P.solid(-pw, pw, pz - pl / 2, pz + pl / 2, y, 0.7, 'pool'); P.hot('info', 'Pool — the lido', pw + 0.9, y, pz, 1.4); }
      for (let z = z0 + 2; z < z1 - 1.5; z += 2.2) for (const s of [-1, 1]) { const x = s * (hw - 1.3), q = { x0: x - 0.4, x1: x + 0.4, z0: z - 0.9, z1: z + 0.9 }; if (freeRect(P, r, q, 0.6)) { P.prop('lounger', { x, y, z }); P.solid(q.x0, q.x1, q.z0, q.z1, y, 0.5, 'lounger'); } }
      return;
    }
    if (d.use === 'cabin' || d.use === 'crew') return cabinBlock(P, ga, d, z0, z1, hw, bi, link, out);
    // public decks: one big room per block (the boat deck keeps an open promenade outboard on both sides)
    const prom = isBoat && hw > 6 ? 2.4 : 0;
    const ix = r2(hw - prom);
    const list = d.use === 'lido' ? [[bi < blocks.length / 2 ? 'Spa & gym' : 'Buffet restaurant', bi < blocks.length / 2 ? 'spa' : 'buffet']] : (cruise ? PUBLIC.cruise : hsc ? PUBLIC.hsc : PUBLIC.ferry);
    const pi = (X.decks.indexOf(d) * 3 + bi) % list.length;
    const [name, kind] = list[pi];
    const r = P.room({ id: id('pub'), kind: 'mess', use: kind, name, x0: -ix, x1: ix, z0, z1, y, h, floor: 'carpet', wall: 'white' });
    out.push(r); link(r, z0, 'n'); link(r, z1, 's');
    P.window(r, 'w', z0 + 0.6, z1 - 0.6, 0.9, 2.4); P.window(r, 'e', z0 + 0.6, z1 - 0.6, 0.9, 2.4);
    if (prom) for (const s of [-1, 1]) {
      const pr = P.room({ id: id(`prom-${s < 0 ? 'p' : 's'}`), kind: 'deck', use: 'promenade', name: `Promenade (${s < 0 ? 'port' : 'starboard'})`, open: true, x0: s < 0 ? -hw : ix, x1: s < 0 ? -ix : hw, z0, z1, y, h: 2.4, floor: 'teak', drawFloor: true, inset: s < 0 ? { w: RAIL_IN, e: R, n: 0, s: 0 } : { e: RAIL_IN, w: R, n: 0, s: 0 } });
      P.door(r, pr, s < 0 ? 'w' : 'e', r2((z0 + z1) / 2), 1.2, 2.05, 'ext');
      P.rail([[s * hw, z0], [s * hw, z1]], y);
      out.push(pr);
    }
    paxFurnish(P, r, kind);
  });
  // lifeboats along the boat deck
  if (isBoat) for (const b of ga.deck.boats.filter((q) => q.deck === d.id)) {
    P.prop('lifeboat', { kind: b.kind, x: b.x, y: b.y, z: b.z, len: b.kind === 'davit' ? Math.min(14, ga.L * 0.04) : 3, side: b.side });
    const pr = P.openAt(b.side * (half(d, b.z - 1, b.z + 1) - 1.0), b.z, y);
    if (pr && b.kind === 'davit') P.hot('muster', 'Lifeboat muster station', b.side * (pr.x1 - pr.x0 > 2 ? (b.side < 0 ? -(pr.x0 + pr.x1) / -2 : (pr.x0 + pr.x1) / 2) : 0), y, b.z, 1.3);
  }
  return out;
}

function carLanes(P, r, seed) {
  const y = r.y, W = r.x1 - r.x0;
  let s = seed * 7 + 3; const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  // lanes along z, a 1.2 m walkway every three lanes
  const lanes = [];
  for (let x = r.x0 + 1.6; x + 2.6 < r.x1 - 1.4;) { for (let k = 0; k < 3 && x + 2.6 < r.x1 - 1.4; k++) { lanes.push(x + 1.3); x += 2.75; } x += 1.4; }
  for (const lx of lanes) {
    for (let z = r.z0 + 2.2; z < r.z1 - 2.2;) {
      const lorry = r.h > 4 && rnd() < 0.35, len = lorry ? 13 : 4.6, w = lorry ? 2.5 : 1.85, h = lorry ? 3.9 : 1.5;
      if (z + len > r.z1 - 2.2) break;
      const q = { x0: lx - w / 2, x1: lx + w / 2, z0: z, z1: z + len };
      if (freeRect(P, r, q, 0.5)) { P.prop('vehicle', { x: lx, z: z + len / 2, y, len, w, h, lorry, color: Math.floor(rnd() * 6) }); P.solid(q.x0, q.x1, q.z0, q.z1, y, h, 'vehicle'); }
      z += len + 0.7;
    }
  }
  for (let z = r.z0 + 3; z < r.z1 - 3; z += 6) P.prop('lashPoint', { x0: r.x0, x1: r.x1, z, y });
  void W;
}

/** Cabin (or crew) block between two towers: outer cabins, corridors, inner cabins back to back. */
function cabinGeom(ga, d, hw) {
  const cruise = ga.type === 'cruise', crew = d.use === 'crew';
  const dO = crew ? 3.6 : cruise ? Math.min(5.6, Math.max(3.8, hw * 0.3)) : 4.0, cw = cruise && !crew ? 1.6 : 1.3;
  return { dO, cw, two: hw - dO - cw >= 3.4 + 2.2 };   // room for inner cabins + a centre service band: two corridors
}
/** On the deck over a passenger ship's engine room: which cabin slots (zs indices) give way to the crew stair down. */
function erEntranceSlots(ga, d, zs, z0, z1) {
  const er = ga.er;
  if (!er || ga.hull?.twin || d !== ga.pax.decks[0] || !(er.z0 < z1 && er.z1 > z0)) return null;
  const need = 2 * LAND + stairRun(d.y - er.floorY, 52) + 0.4;
  const i0 = zs.findIndex(([, b]) => b > er.z0 + 1);
  if (i0 < 0) return null;
  for (let i1 = i0; i1 < zs.length; i1++) { const za = Math.max(er.z0 + 0.1, zs[i0][0] + 0.1); if (Math.min(zs[i1][1], er.z1 - 1) - za >= need) return [i0, i1]; }
  return null;
}
function cabinBlock(P, ga, d, z0, z1, hw, bi, link, out) {
  const y = d.y, h = d.h, cruise = ga.type === 'cruise', crew = d.use === 'crew', id = (s) => `${d.id}-b${bi}-${s}`;
  const { dO, cw, two } = cabinGeom(ga, d, hw);
  const cabinW = crew ? 2.8 : cruise ? 3.4 : 3.0;
  const mk = (sfx, x0, x1, za, zb, name, kind, use) => P.room({ id: id(sfx), kind, use, name, x0: r2(x0), x1: r2(x1), z0: r2(za), z1: r2(zb), y, h, floor: kind === 'cabin' ? 'carpet' : 'lino', wall: 'white', berth: kind === 'cabin' ? 1 : 0 });
  const n = Math.max(1, Math.floor((z1 - z0) / cabinW));
  const zs = []; for (let i = 0; i < n; i++) zs.push([z0 + ((z1 - z0) * i) / n, z0 + ((z1 - z0) * (i + 1)) / n]);
  const extra = crew ? [['Crew mess', 'mess', 'mess'], ['Laundry', 'store', 'laundry'], ['Provisions', 'store', 'store'], ['Crew bar', 'mess', 'bar'], ['Medical centre', 'cabin', 'hospital']] : [];
  if (two) {
    const cx = hw - dO - cw;   // corridor inner edge
    const corr = [-1, 1].map((s) => mk(`cor-${s < 0 ? 'p' : 's'}`, s < 0 ? -(hw - dO) : cx, s < 0 ? -cx : hw - dO, z0, z1, `Corridor (${d.name})`, 'passage', 'corridor'));
    for (const c of corr) { out.push(c); link(c, z0, 'n'); link(c, z1, 's'); }
    const ci = Math.min(4.6, cx - 1.1), cen = cx - ci;
    const ent2 = ci >= 2.4 ? erEntranceSlots(ga, d, zs, z0, z1) : null;   // inner port cabins over the engine room → crew stair down
    zs.forEach(([a, b], i) => {
      for (const s of [-1, 1]) {
        const ox0 = s < 0 ? -hw : hw - dO, ox1 = s < 0 ? -(hw - dO) : hw;
        const ex = crew && extra[(bi + i) % 7] && i % 3 === 1 ? extra[(bi + i) % 7] : null;
        const oc = mk(`o${s < 0 ? 'p' : 's'}${i}`, ox0, ox1, a, b, ex ? ex[0] : crew ? 'Crew cabin' : cruise ? 'Balcony stateroom' : 'Outside cabin', ex ? ex[1] : 'cabin', ex ? ex[2] : 'cabin');
        P.door(oc, corr[s < 0 ? 0 : 1], s < 0 ? 'e' : 'w', r2((a + b) / 2 + 0.6 * (i % 2 ? 1 : -1) * Math.min(1, (b - a) / 2 - 0.6)), 0.85);
        P.window(oc, s < 0 ? 'w' : 'e', a + 0.4, b - 0.4, cruise && !crew && d.y >= ga.pax.hullTop ? 0.1 : 1.0, 2.3);
        if (cruise && !crew && d.y >= ga.pax.hullTop) P.prop('balcony', { x: s * hw, y, z0: a, z1: b, side: s, d: 1.4 });
        if (!ex) cabinFurnish(P, oc, s < 0 ? 'e' : 'w'); else paxFurnish(P, oc, ex[2]);
        out.push(oc);
        if (ci >= 2.4 && s < 0 && ent2 && i >= ent2[0] && i <= ent2[1]) {
          if (i === ent2[0]) { const st = mk('erstair', -cx, -cen, a, zs[ent2[1]][1], 'Crew stair to the engine room', 'stairs', 'er_entrance'); P.door(st, corr[0], 'w', r2(zs[ent2[1]][1] - 0.9), 0.9); out.push(st); }
        } else if (ci >= 2.4) {
          const ic = mk(`i${s < 0 ? 'p' : 's'}${i}`, s < 0 ? -cx : cen, s < 0 ? -cen : cx, a, b, crew ? 'Crew cabin' : 'Inside cabin', 'cabin', 'cabin');
          P.door(ic, corr[s < 0 ? 0 : 1], s < 0 ? 'w' : 'e', r2((a + b) / 2 - 0.6 * (i % 2 ? 1 : -1) * Math.min(1, (b - a) / 2 - 0.6)), 0.85);
          cabinFurnish(P, ic, s < 0 ? 'w' : 'e'); out.push(ic);
        }
      }
    });
    if (cen > 0.6) { // the service core between the inner cabins: a crew passage from tower to tower, stores either side
      const pw = Math.min(cen, 1.0), nd = P.doors.length;
      const sv = P.room({ id: id('service'), kind: 'passage', use: 'service', name: 'Crew service passage', x0: r2(-pw), x1: r2(pw), z0, z1, y, h, floor: 'lino', wall: 'white' });
      link(sv, z0, 'n'); link(sv, z1, 's');
      if (P.doors.length === nd) { sv.walk = false; sv.name = 'Service core (linen, pantry)'; }   // no tower at either end: a closed store
      out.push(sv);
      if (cen - pw > 0.6) for (const s of [-1, 1]) out.push(P.room({ id: id(`store-${s < 0 ? 'p' : 's'}`), kind: 'store', use: 'service', name: s < 0 ? 'Linen & laundry store' : 'Pantry & provisions store', x0: r2(s < 0 ? -cen : pw), x1: r2(s < 0 ? -pw : cen), z0, z1, y, h, walk: false }));
    }
  } else {
    const corr = mk('cor', -cw / 2, cw / 2, z0, z1, `Corridor (${d.name})`, 'passage', 'corridor');
    out.push(corr); link(corr, z0, 'n'); link(corr, z1, 's');
    // the deck over the engine room: a run of port cabins gives way to the crew stair down (paxEngineRoom lands it here)
    const ent = erEntranceSlots(ga, d, zs, z0, z1);
    zs.forEach(([a, b], i) => {
      for (const s of [-1, 1]) {
        const x0 = s < 0 ? -hw : cw / 2, x1 = s < 0 ? -cw / 2 : hw;
        if (x1 - x0 < 1.6) continue;
        if (s < 0 && ent && i >= ent[0] && i <= ent[1]) {
          if (i !== ent[0]) continue;
          const st = mk('erstair', x0, x1, a, zs[ent[1]][1], 'Crew stair to the engine room', 'stairs', 'er_entrance');
          P.door(st, corr, 'e', r2(zs[ent[1]][1] - 0.9), 0.9);
          out.push(st);
          continue;
        }
        const ex = crew && i % 3 === 1 ? extra[(bi + i) % extra.length] : null;
        const c = mk(`c${s < 0 ? 'p' : 's'}${i}`, x0, x1, a, b, ex ? ex[0] : crew ? 'Crew cabin' : 'Cabin', ex ? ex[1] : 'cabin', ex ? ex[2] : 'cabin');
        P.door(c, corr, s < 0 ? 'e' : 'w', r2((a + b) / 2), 0.85);
        P.window(c, s < 0 ? 'w' : 'e', a + 0.4, b - 0.4, 1.0, 2.0);
        if (!ex) cabinFurnish(P, c, s < 0 ? 'e' : 'w'); else paxFurnish(P, c, ex[2]);
        out.push(c);
      }
    });
  }
}
function cabinFurnish(P, r, doorSide) {
  bunkIn(P, r, 'Rest in the bunk');
  const W = r.x1 - r.x0, D = r.z1 - r.z0;
  if (W * D >= 10) equipIn(P, r, 'wc', 1.2, 1.4, 2.2, [doorSide === 'e' ? 'e' : 'w', 'n', 's']);
}

function paxBridge(P, ga, d, half) {
  const b = ga.bridge, L = ga.L, y = d.y;
  // the bridge across the front of the deck; on the double-ended ferry a second wheelhouse at the other end
  P.setZone(`deck:${d.id}`);
  const hw = r2(Math.min(half(d, b.z0, b.z1), Math.max(Math.abs(b.x0), Math.abs(b.x1)) + (b.twin ? 0 : 4)));
  const ends = b.twin ? [[b.z0, b.z1, 'bridge', 1], [r2(-b.z1), r2(-b.z0), 'bridge-aft', -1]] : [[b.z0, b.z1, 'bridge', 1]];
  for (const [z0, z1, id, dir] of ends) {
    if (P.byId(id)) continue;

    const br = P.room({ id, kind: 'bridge', use: 'bridge', name: dir > 0 ? 'Bridge' : 'Wheelhouse (aft end)', x0: -hw, x1: hw, z0, z1, y, h: d.h, floor: 'lino', wall: 'white' });
    for (const s of ['n', 's', 'e', 'w']) if (s === 'n' || s === 'e' || s === 'w' || b.twin) { if (s === 'n' || s === 's') P.window(br, s, -hw + 0.3, hw - 0.3, 1.0, 2.35); else P.window(br, s, z0 + 0.3, z1 - 0.3, 1.0, 2.35); }
    // door aft to the deck's first room or tower behind it
    const touching = P.rooms.filter((r) => r !== br && r.y === y && r.walk !== false && r.kind !== 'cabin' && (dir > 0 ? Math.abs(r.z0 - z1) < 0.02 : Math.abs(r.z1 - z0) < 0.02) && Math.min(r.x1, br.x1) - Math.max(r.x0, br.x0) >= 1.2);
    touching.sort((p, q) => (p.kind === 'passage' ? 0 : 1) - (q.kind === 'passage' ? 0 : 1) || Math.abs((p.x0 + p.x1) / 2) - Math.abs((q.x0 + q.x1) / 2));
    for (const behind of touching.slice(0, 2)) { const lo = Math.max(behind.x0, br.x0), hi = Math.min(behind.x1, br.x1); P.door(br, behind, dir > 0 ? 's' : 'n', r2((lo + hi) / 2), Math.min(0.95, hi - lo - 0.2), 2.05, behind.open ? 'ext' : 'door'); }
    if (dir > 0) planBridge(P, ga, { ...b, room: id });
    else { P.prop('helm', { x: 0, y, z: z1 - 0.75, w: 1.4, facing: 1 }); P.solid(-0.7, 0.7, z1 - 1.15, z1 - 0.35, y, 1.3, 'console'); P.hot('helm', 'Take the helm (aft wheelhouse — double-ended ferry)', 0, y, z1 - 1.75, 1.2); }
  }
}

/** x of the crew stair from deck 1 down into the engine room: inside both, clear of the centreline gensets. */
function paxErStairX(P, ga, d1) {
  const er = ga.er, hwE = Math.min(P.fit(er.z0, er.z1, er.floorY, d1.y - er.floorY - 0.12), ga.B / 2 - 0.6);
  const hwD = Math.min(P.fit(er.z0, er.z0 + 8, d1.y, d1.h), ga.B / 2 - 0.6);
  const ent = P.rooms.find((r) => r.use === 'er_entrance' && Math.abs(r.y - d1.y) < 0.05 && r.z1 > er.z0 && r.z0 < er.z1);
  if (ent) { const x = Math.max(ent.x0 + 0.6, -(hwE - 0.4)); if (x + 1.0 <= Math.min(ent.x1 - 0.4, hwE - 0.4)) return r2(x); }
  return r2(-Math.min(hwE - 0.4, hwD - 0.6, 4.0));
}
function paxEngineRoom(P, ga, d1) {
  const er = ga.er, L = ga.L, B = ga.B;
  P.setZone('er', { name: 'Engine room', near: [`deck:${d1.id}`] });
  const y = er.floorY, h = r2(d1.y - y - 0.12);
  const rooms = [];
  if (er.twinHull) {
    // high-speed catamaran: an engine room in each demihull, a steep ladder-stair from the car deck
    const t = ga.hull.twin;
    for (const side of [-1, 1]) {
      let hh = Infinity; for (let k = 0; k <= 8; k++) hh = Math.min(hh, demihullAt(ga, er.z0 + ((er.z1 - er.z0) * k) / 8, y + 0.5).half);
      hh = r2(Math.min(hh, t.hullB / 2) - 0.25); if (hh < 0.7) continue;
      const xc = side * t.xc;
      const r = P.room({ id: `er-${side < 0 ? 'p' : 's'}`, kind: 'engine', name: `Engine room (${side < 0 ? 'port' : 'starboard'} hull)`, x0: r2(xc - hh), x1: r2(xc + hh), z0: er.z0, z1: er.z1, y, h, floor: 'grating', wall: 'dark', dark: true });
      rooms.push(r);
      const me = er.me, n = 2, el = Math.min(me.len, (er.z1 - er.z0 - 6) / n - 0.8);
      for (let k = 0; k < n; k++) { const z = er.z0 + 5 + el / 2 + k * (el + 0.8); const ew = Math.min(me.w, 2 * hh - 1.0); if (ew > 0.4 && el > 1) { P.prop('engine', { x: xc, y, z, len: el, w: ew, h: Math.min(me.h, h - 0.3) }); P.solid(xc - ew / 2 - 0.1, xc + ew / 2 + 0.1, z - el / 2 - 0.1, z + el / 2 + 0.1, y, Math.min(me.h, h - 0.3) + 0.3, 'engine'); } }
      P.prop('console', { x: r.x1 - 0.06, y, z: er.z0 + 4.2, rotY: -Math.PI / 2, wall: true });
      P.hot('engine', 'Check the engines (rpm, fuel, temperature)', r.x1 - 0.8, y, er.z0 + 4.2, 1.3);
      const run = stairRun(d1.y - y, 55), inner = side < 0 ? r.x1 : r.x0;
      const sx0 = side < 0 ? r2(inner - 1.0) : r2(inner + 0.1), sx1 = r2(sx0 + 0.9);
      const cz0 = er.z0, cz1 = r2(er.z0 + 2 * LAND + run);
      const car = P.rooms.find((q) => q.y === d1.y && q.use === 'cardeck' && q.z0 <= cz0 && q.z1 >= cz1);
      if (car) {
        P.setZone(car.zone);
        const cx0 = side < 0 ? r2(sx0 - 1.2) : r2(sx0 - 0.1), cx1 = side < 0 ? r2(sx1 + 0.1) : r2(sx1 + 1.2);
        const cas = P.room({ id: `er-casing-${side < 0 ? 'p' : 's'}`, kind: 'stairs', use: 'er_entrance', name: 'Engine room hatch (crew)', x0: cx0, x1: cx1, z0: cz0, z1: cz1, y: d1.y, h: 2.4, floor: 'grating', wall: 'steel' });
        car.cuts.push({ x0: cx0, x1: cx1, z0: cz0, z1: cz1 });
        const dsd = side < 0 ? 'e' : 'w', dx = side < 0 ? cx1 : cx0;
        if ((side < 0 ? dx < car.x1 : dx > car.x0)) P.door(cas, car, dsd, r2(cz0 + LAND / 2 + 0.2), 0.95, 2.05, 'door');
        else P.door(cas, car, 'n', r2((cx0 + cx1) / 2), 0.95, 2.05, 'door');
        P.stair({ id: `er-stair-${side < 0 ? 'p' : 's'}`, x0: sx0, x1: sx1, z0: r2(er.z0 + LAND), z1: r2(er.z0 + LAND + run), yLow: y, yHigh: d1.y, up: 'n', foot: r.id, head: cas.id, kind: 'steep' });
        P.setZone('er');
      }
    }
    return;
  }
  const hw = r2(Math.min(P.fit(er.z0, er.z1, y, h), B / 2 - 0.6));
  const r = P.room({ id: 'er-main', kind: 'engine', name: 'Engine room (diesel generators)', x0: -hw, x1: hw, z0: er.z0, z1: er.z1, y, h, floor: 'grating', wall: 'dark', dark: true });
  rooms.push(r);
  // gensets in two rows, a walkway down the middle
  { const sx = paxErStairX(P, ga, d1), run0 = stairRun(d1.y - y, 52); P.reserve(sx - 0.4, sx + 2.2, er.z0 - 0.2, er.z0 + 2 * LAND + run0 + 0.6, y, d1.y); }
  const me = er.me, nPer = Math.ceil(me.n / 2), el = Math.min(me.len, (er.z1 - er.z0 - 7) / nPer - 0.9), ew = Math.min(me.w, hw - 2.2);
  if (el > 1 && ew > 0.5) for (const s of [-1, 1]) for (let k = 0; k < nPer; k++) {
    const x = s * (1.1 + ew / 2 + 0.3), z = er.z0 + 5.5 + el / 2 + k * (el + 0.9);
    if (!freeRect(P, r, { x0: x - ew / 2 - 0.3, x1: x + ew / 2 + 0.3, z0: z - el / 2 - 0.3, z1: z + el / 2 + 0.3 }, 0.4)) continue;
    P.prop('engine', { x, y, z, len: el, w: ew, h: Math.min(me.h, h - 0.4), genset: true }); P.solid(x - ew / 2 - 0.3, x + ew / 2 + 0.3, z - el / 2 - 0.3, z + el / 2 + 0.3, y, Math.min(me.h, h - 0.4) + 0.4, 'engine');
  }
  // ECR forward in the engine room, behind a glass wall; crew stair up to deck 1
  const ecr = P.room({ id: 'er-ecr', kind: 'engine', use: 'ecr', name: 'Engine control room', x0: r2(hw - Math.min(8, hw)), x1: hw, z0: r2(er.z0 - 4.2), z1: er.z0, y, h, floor: 'lino', wall: 'white' });
  P.door(ecr, r, 's', r2(ecr.x0 + 1.2), 0.95);
  P.window(ecr, 's', ecr.x0 + 2, ecr.x1 - 0.5, 1.0, 2.0);
  const q = placeAgainst(P, ecr, Math.min(3, ecr.x1 - ecr.x0 - 1.6), 0.8, ['n']);
  if (q) { P.prop('console', { x: (q.x0 + q.x1) / 2, y, z: (q.z0 + q.z1) / 2, rotY: 0, wall: false, ecr: true }); P.solid(q.x0, q.x1, q.z0, q.z1, y, 1.75, 'console'); P.hot('ecr', 'Engine control room — power management, propulsion, bilge', (q.x0 + q.x1) / 2, y, q.z1 + 0.85, 1.3); P.hot('engine', 'Check the engines (rpm, fuel, temperature)', (q.x0 + q.x1) / 2 + 0.8, y, q.z1 + 0.85, 1.0); }
  const run = stairRun(d1.y - y, 52), sx0 = r2(paxErStairX(P, ga, d1));
  let sz = null;
  const head = P.rooms.find((k) => { if (k.y !== d1.y || k.x0 > sx0 || k.x1 < sx0 + 1.1 || k.walk === false || k.open) return false; const a = Math.max(er.z0 + 0.1, k.z0 + 0.1); if (a + 2 * LAND + run + 0.3 > Math.min(k.z1, er.z1 - 1)) return false; sz = a; return true; });
  if (head) {
    P.reserve(sx0 - 0.2, sx0 + 1.3, sz, sz + 2 * LAND + run, y, d1.y);
    P.setZone(head.zone);
    P.stair({ id: 'er-stair', x0: sx0, x1: r2(sx0 + 1.0), z0: r2(sz + LAND), z1: r2(sz + LAND + run), yLow: y, yHigh: d1.y, up: 'n', foot: r.id, head: head.id, kind: 'steep' });
    P.setZone('er');
  }
  if (er.steering) {
    const s = er.steering, hs = r2(Math.min(P.fit(s.z0, s.z1, y, h), B / 2 - 0.6));
    if (hs > 1.5) {
      const pr = P.room({ id: 'steering-gear', kind: 'engine', use: 'steering', name: s.pods ? 'Pod motor room' : 'Steering gear room', x0: -hs, x1: hs, z0: s.z0, z1: s.z1, y, h, floor: 'steel', wall: 'dark', dark: true });
      if (Math.abs(r.z1 - s.z0) < 0.6) { const z = pr.z0; pr.z0 = r.z1; void z; }
      if (Math.abs(r.z1 - pr.z0) < 0.02) P.door(r, pr, 's', 0, 0.95, 2.0, 'watertight');
      const qq = placeAgainst(P, pr, Math.min(2.6, 2 * hs - 1.6), 1.4, ['s']);
      if (qq) { P.prop('steeringGear', { x: (qq.x0 + qq.x1) / 2, y, z: (qq.z0 + qq.z1) / 2, w: qq.x1 - qq.x0, d: qq.z1 - qq.z0, pods: !!s.pods }); P.solid(qq.x0, qq.x1, qq.z0, qq.z1, y, 1.5, 'steering'); P.hot('steering', s.pods ? 'Pod motors — azimuthing propulsion' : 'Steering gear', (qq.x0 + qq.x1) / 2, y, qq.z0 - 0.8, 1.3); }
    }
  }
  P.prop('pipes', { x0: r.x0, x1: r.x1, z0: r.z0, z1: r.z1, y, h });
}
PLANNERS.pax = planPax;

// ------------------------------------------------------------------------------------------------ ro-ro / PCTC
function planRoro(P, ga) {
  const X = ga.roro, L = ga.L, B = ga.B, yW = ga.deckY;
  // car decks: one hold per deck, ramps between them, a crew stair tower forward to the weather deck and the house
  const tw = X.tower, TW = 2 * FL + 0.3;
  const decks = [...X.decks, { id: 'weather', y: yW, h: 2.4, name: 'Weather deck', weather: true }];
  const tz0 = tw.z0, rise = Math.max(...decks.slice(1).map((d, i) => d.y - decks[i].y)), run = stairRun(rise, 45), tz1 = r2(tz0 + 2 * LAND + run);
  const rooms = [];
  P.setZone('cargo', { name: 'Car decks', near: ['house', 'er'] });
  for (const d of X.decks) {
    const z0 = r2(Math.max(bowStart(P, B * 0.3) + 2, -L / 2 + 0.06 * L)), z1 = r2(L / 2 - 1.2);
    const hw = r2(Math.min(P.fit(z0, z1, d.y, d.h), B / 2 - 0.6));
    const r = P.room({ id: d.id, kind: 'store', use: 'cardeck', name: d.name, x0: -hw, x1: hw, z0, z1, y: d.y, h: d.h, floor: 'steel', wall: 'steel', dark: true, cuts: [] });
    rooms.push(r);
  }
  // the stair tower (cut out of each car deck), with a stair room on each deck
  const tx0 = r2(tw.x0), tx1 = r2(tx0 + TW);
  P.setZone('house');
  const towerRooms = decks.map((d, k) => P.room({ id: `tower-${d.id}`, kind: 'stairs', use: 'stairs', name: `Crew stair (${d.name})`, x0: tx0, x1: tx1, z0: tz0, z1: tz1, y: d.y, h: d.weather ? 2.6 : Math.min(d.h, (decks[k + 1]?.y ?? d.y + 3) - d.y - 0.12), floor: 'lino', wall: 'white' }));
  for (const r of rooms) r.cuts.push({ x0: tx0, x1: tx1, z0: tz0, z1: tz1 });
  for (let k = 0; k < decks.length - 1; k++) P.stair({ id: `tower-flight-${k}`, x0: r2(tx0 + 0.06), x1: r2(tx0 + FL - 0.04), z0: r2(tz1 - LAND - run), z1: r2(tz1 - LAND), yLow: decks[k].y, yHigh: decks[k + 1].y, up: 'n', foot: towerRooms[k].id, head: towerRooms[k + 1].id });
  rooms.forEach((r, k) => P.door(towerRooms[k], r, 'e', r2(tz1 - LAND / 2), 1.0, 2.05, 'door'));
  // vehicles and ramps
  P.setZone('cargo');
  for (const rp of X.ramps) {
    const a = rooms.find((q) => q.id === rp.from), b = rooms.find((q) => q.id === rp.to);
    if (!a || !b) continue;
    P.stair({ id: `ramp-${rp.from}`, x0: rp.x0, x1: rp.x1, z0: rp.z0, z1: rp.z1, yLow: a.y, yHigh: b.y, up: rp.up, foot: a.id, head: b.id, kind: 'ramp' });
    P.prop('carRamp', { x: (rp.x0 + rp.x1) / 2, z: (rp.z0 + rp.z1) / 2, y: a.y, w: rp.x1 - rp.x0, len: rp.z1 - rp.z0, rise: b.y - a.y, up: rp.up });
  }
  { const col = ga.er.column; if (col) P.reserve(col.x0 - 0.6, col.x1 + 2.6, col.z0 - 0.6, col.z1 + 0.6, X.decks[0].y - 0.1, X.decks[0].y + 0.1); }
  for (const [i, r] of rooms.entries()) {
    for (const rp of X.ramps) P.reserve(rp.x0 - 1.2, rp.x1 + 1.2, Math.min(rp.z0, rp.z1) - 3.5, Math.max(rp.z0, rp.z1) + 3.5, r.y - 0.1, r.y + 0.1);
    P.reserve(tx0 - 0.4, tx1 + 2.6, tz0 - 0.4, tz1 + 0.6, r.y - 0.1, r.y + 0.1);
    carLanes(P, r, i);
    P.prop('lashPoint', { x0: r.x0, x1: r.x1, z: r.z0 + 3, y: r.y });
    for (let z = r.z0 + 8; z < r.z1 - 8; z += 20) for (const s of [-1, 1]) P.prop('floodlight', { x: s * (r.x1 - 0.4), y: r.y + r.h - 0.4, z });
  }
  P.prop('sternRampBig', { y: X.decks[0].y, z: L / 2, w: X.stern.w, quarter: X.stern.quarter });
  if (X.side) P.prop('sideRamp', { y: X.decks[0].y, z: X.side.z, side: X.side.side });
  // the house on the weather deck forward; weather deck strips; ER under the main car deck
  planHouseTiers(P, ga, ga.house);
  planBridge(P, ga, ga.bridge);
  P.setZone('deck', { name: 'Weather deck', near: ['house', 'cargo'] });
  const md = planMainDeck(P, ga, [{ x0: ga.house.x0, x1: ga.house.x1, z0: ga.house.z0, z1: ga.house.z1 }], { z0: bowStart(P, 0.9), z1: r2(L / 2 - 0.8), name: 'Weather deck' });
  void md;
  P.hullRails(bowStart(P, 0.9), L / 2 - 0.2, yW);
  houseExits(P, ga.house, yW);
  // the tower comes up as a small deckhouse on the weather deck
  const wt = towerRooms[towerRooms.length - 1];
  for (const r of P.rooms) if (r.open && Math.abs(r.y - yW) < 0.05 && r.x0 < tx1 && r.x1 > tx0 && r.z0 < tz1 && r.z1 > tz0) r.cuts.push({ x0: tx0, x1: tx1, z0: tz0, z1: tz1 });
  const host = P.openAt(tx1 + 0.6, tz1 - LAND / 2, yW) || P.openAt((tx0 + tx1) / 2, tz1 + 0.6, yW);
  if (host) { if (host.x0 >= tx1 - 0.05) P.door(wt, host, 'e', r2(tz1 - LAND / 2), 1.0, 2.05, 'ext'); else P.door(wt, host, 's', r2((tx0 + tx1) / 2 + 0.5), 1.0, 2.05, 'ext'); }
  for (const m of ga.deck.mooring) mooringGear(P, m);
  lifesaving(P, ga);
  // ER below the main car deck (casing column from the main car deck)
  const er = ga.er, col = er.column;
  const entr = rooms[0];
  if (col) {
    for (const r of rooms) if (r === entr) r.cuts.push({ x0: col.x0 - 0.1, x1: col.x1 + 1.3, z0: col.z0, z1: col.z1 });
    P.setZone('cargo');
    const cas = P.room({ id: 'er-casing', kind: 'stairs', use: 'er_entrance', name: 'Engine room entrance', x0: r2(col.x0 - 0.1), x1: r2(col.x1 + 1.3), z0: col.z0, z1: col.z1, y: entr.y, h: 2.6, floor: 'grating', wall: 'steel' });
    P.door(cas, entr, 'e', r2(col.z0 + LAND / 2 + 0.3), 1.0, 2.05, 'door');
    P.reserve(cas.x0 - 0.3, cas.x1 + 2.0, cas.z0 - 0.5, cas.z1 + 0.5, entr.y - 0.1, entr.y + 0.1);
    planEngineRoom(P, ga, er, { entranceRoom: cas });
  }
  P.spawn = P.spawn || { x: 0.8, y: ga.bridge.y, z: ga.bridge.z0 + 2.2, yaw: 0 };
}
PLANNERS.roro = planRoro;
