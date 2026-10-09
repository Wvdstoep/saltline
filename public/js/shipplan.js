// Deck plans of the walkable ship (docs/V5-PLAN.md items 6 + 7). Pure data — no three.js, no DOM — so the node tests can
// prove that every class can be walked from the bridge to the engine room and out onto the open deck.
//
// Ship frame (metres): x to starboard, y up (0 = waterline), z aft (the bow is at −L/2). The main deck is at deckY.
//
// buildPlan(cls, C, dims) → {
//   rooms:   [{ id, kind, name, x0,x1,z0,z1, y, h, open, walk, floor, wall, ceiling, walls:{n,s,e,w}, windows:[…],
//               floorHoles:[rect], ceilHoles:[rect], cuts:[rect], inset:{n,s,e,w}, dark, drawFloor }]
//            kind: bridge | passage | mess | cabin | engine | deck | stairs | store
//            open rooms are open decks (no walls / ceiling, rails at their edges); dark rooms have no windows
//   doors:   [{ a, b, side, at, w, h, kind, y }]   opening in room a's `side` wall (n = forward, s = aft, w = port, e = stbd)
//   stairs:  [{ id, x0,x1,z0,z1, yLow, yHigh, up, foot, head, kind }]  run along z; up 'n' = rises toward the bow
//   solids:  [{ x0,x1,z0,z1, y, h, tag }]         furniture / machinery footprints the walker cannot pass
//   props:   [{ t, … }]                            what interior.js draws (consoles, bunks, engines, hatches, signs…)
//   hotspots:[{ kind, label, x,y,z, r }]           E / tap actions
//   rails:   [{ pts:[[x,z]…], y }]                 handrails along open-deck edges
//   deck:    { y, polys:[[[x,z]…]], holes:[rect] } main-deck surface (replaces the hull's own deck while walking)
//   spawn, helm, levels
// }
import { deckOutlineHalf, yachtDims, structures as yachtStructures, deckOf as yachtDeckOf } from './yachtlooks.js';   // sailing yachts (docs/SAILING-CONTRACT.md §4.5)
import { rigOf } from '../../shared/sail/rigs.js';
import { planFromGA } from './gaplan.js';                                             // SHIPYARD H10 (docs/SHIPS-LANEC-PHASE2.md)
import { generalArrangement, outlineHalf as gaOutlineHalf } from '../../shared/ships/ga.js';
import { gaReady } from '../../shared/ships/index.js';
/** True when this class (catalogue model / variant id) is planned from its general arrangement (Lane C). */
export const gaPlanned = (cls) => gaReady(cls);
export const R = 0.25;          // walker radius: keeps the body off walls, rails and furniture
export const STEP = 0.32;       // the largest height change the walker takes in one sub-step (stairs are ramps)
const EDGE = 0.45;              // walk margin inside the hull outline at deck level
const RAIL_IN = 0.15;           // walk inset at a handrail (people lean on rails)
const HULL_IN = 0.3;            // room walls below deck stand this far inside the hull plating
const YACHT_EDGE = 0.3;         // yachts: open-deck margin inside the hull edge (lifelines stand on the toerail)
const YACHT_RAIL = 0.12;        // yachts: lifeline / pulpit line inside the hull edge

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const tanD = (d) => Math.tan((d * Math.PI) / 180);
const r2 = (v) => Math.round(v * 100) / 100;

// ------------------------------------------------------------------------------------------------ hull outline
// Mirrors ship.js hullShape / yachtShape (bow fraction, stern width) so walls stay inside the plating.
const MERCHANT_HULL = { coaster: [0.3, 0.86], feeder: [0.28, 0.86], bulker: [0.26, 0.9], tanker: [0.24, 0.92], boxship: [0.22, 0.95], trawler: [0.4, 0.8], tug: [0.42, 0.85], psv: [0.3, 0.95], pilot: [0.42, 0.8], ferry: [0.26, 0.98] };
function quadPts(p0, p1, p2, n, out) {
  for (let i = 1; i <= n; i++) { const t = i / n, a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, c = t * t; out.push([a * p0[0] + b * p1[0] + c * p2[0], a * p0[1] + b * p1[1] + c * p2[1]]); }
}
/** Starboard half of the deck outline as [x, z] from the stern (z = +L/2) to the bow tip (z = −L/2). */
export function outlineHalf(cls, L, B) {
  if (cls === 'sloop' || cls === 'ketch' || cls === 'schooner') return deckOutlineHalf(cls, 40);   // the lofted yacht hulls (yachtlooks.js)
  if (gaPlanned(cls)) { const ga = generalArrangement(cls); if (ga && ga.gen !== 'sail') return gaOutlineHalf(ga, 72); }   // SHIPYARD H10
  const hb = B / 2, hl = L / 2, pts = [];
  const m = MERCHANT_HULL[cls];
  if (m) {
    const [bowFrac, sternW] = m;
    pts.push([hb * sternW, hl]);
    quadPts([hb * sternW, hl], [hb, hl - L * 0.08], [hb, hl - L * 0.15], 10, pts);
    pts.push([hb, -hl + L * bowFrac]);
    quadPts([hb, -hl + L * bowFrac], [hb * 0.9, -hl + L * bowFrac * 0.35], [0, -hl], 16, pts);
  } else {
    pts.push([hb * 0.55, hl]);
    quadPts([hb * 0.55, hl], [hb * 1.02, hl - L * 0.3], [hb * 0.98, hl - L * 0.45], 14, pts);
    quadPts([hb * 0.98, hl - L * 0.45], [hb * 0.8, -hl + L * 0.25], [0, -hl], 18, pts);
  }
  return pts;
}
/** Half-beam of an outline half at z (0 beyond the ends). */
export function halfBeamAt(half, z) {
  let best = 0;
  for (let i = 0; i < half.length - 1; i++) {
    const [xa, za] = half[i], [xb, zb] = half[i + 1];
    const lo = Math.min(za, zb), hi = Math.max(za, zb);
    if (z < lo - 1e-9 || z > hi + 1e-9) continue;
    const t = hi - lo < 1e-9 ? 0 : (z - za) / (zb - za);
    best = Math.max(best, xa + (xb - xa) * t);
  }
  return best;
}
function minHalf(half, z0, z1) { let m = Infinity; for (let i = 0; i <= 16; i++) m = Math.min(m, halfBeamAt(half, z0 + ((z1 - z0) * i) / 16)); return m; }
/** z where the half-beam first reaches `w` going aft from the bow. */
function bowZWhere(half, L, w) { for (let z = -L / 2; z < L / 2; z += 0.1) if (halfBeamAt(half, z) >= w) return z; return -L / 2; }
function sternZWhere(half, L, w) { for (let z = L / 2; z > -L / 2; z -= 0.1) if (halfBeamAt(half, z) >= w) return z; return L / 2; }
function fullOutline(half, dx = 0, scale = 1) {
  const right = half.map(([x, z]) => [dx + x * scale, z]);
  const left = half.slice().reverse().map(([x, z]) => [dx - x * scale, z]);
  return right.concat(left.slice(1));
}

/** Ship dimensions exactly as ship.js builds the hull (mesh.userData overrides when the model provides them). */
export function shipDims(C, ud = {}) {
  const L = ud.length || C.length, B = ud.beam || C.beam, draft = ud.draft || C.draft;
  const Y = yachtDims(C.id), F = ud.freeboard || (Y ? Y.freeboard : 0) || C.freeboard || Math.max(3, L * 0.045);   // yachts: the §4.2 freeboard (1.25 / 1.45 / 1.9 bridge deck / 1.7)
  return { L, B, draft, F, deckY: Number.isFinite(ud.deckY) ? ud.deckY : F + 0.05 };
}

// ------------------------------------------------------------------------------------------------ plan builder
class Plan {
  constructor(cls, C, d) {
    Object.assign(this, { cls, C, L: d.L, B: d.B, F: d.F, draft: d.draft, deckY: d.deckY });
    this.rooms = []; this.doors = []; this.stairs = []; this.solids = []; this.props = []; this.hotspots = []; this.rails = [];
    this.half = outlineHalf(cls, d.L, d.B);
    this.deck = { y: d.deckY, polys: [fullOutline(this.half)], holes: [] };
    this.spawn = null; this.helm = null; this.levels = [];
    this.edge = EDGE; this.railInset = 0.3; // open-deck margin and handrail line inside the hull edge (yachts: tighter)
  }
  hb(z) { return halfBeamAt(this.half, z); }
  minHb(z0, z1) { return minHalf(this.half, Math.min(z0, z1), Math.max(z0, z1)); }
  byId(id) { return this.rooms.find((r) => r.id === id) || null; }
  room(o) {
    const open = !!o.open;
    const r = {
      kind: 'room', name: o.id, h: 2.4, walk: true, floor: 'lino', wall: 'white', ceiling: !open, dark: false, drawFloor: true,
      windows: [], floorHoles: [], ceilHoles: [], cuts: [], ...o, open,
      walls: { ...(open ? { n: false, s: false, e: false, w: false } : { n: true, s: true, e: true, w: true }), ...(o.walls || {}) },
      inset: { n: R, s: R, e: R, w: R, ...(o.inset || {}) },
    };
    for (const k of ['x0', 'x1', 'z0', 'z1', 'y', 'h']) r[k] = r2(r[k]);
    if (r.x1 - r.x0 < 0.5 || r.z1 - r.z0 < 0.5) throw new Error(`[shipplan] ${this.cls}: room ${r.id} is degenerate`);
    if (this.byId(r.id)) throw new Error(`[shipplan] ${this.cls}: duplicate room id ${r.id}`);
    this.rooms.push(r);
    return r;
  }
  /** Doorway in room a's `side` wall at `at` (x for n/s walls, z for e/w walls). b = the room on the other side (or null). */
  door(a, b, side, at, w = 0.95, h = 2.05, kind = 'door') {
    const d = { a: a.id, b: b ? b.id : null, side, at: r2(at), w, h: Math.min(h, a.h - 0.05, b && !b.open ? b.h - 0.05 : h), kind, y: a.y };
    this.doors.push(d);
    return d;
  }
  opening(a, b, side, at, w) { return this.door(a, b, side, at, w, 2.2, 'open'); }
  stair(o) {
    const s = { kind: 'stair', ...o };
    s.id = s.id || `stair-${this.stairs.length}`;
    for (const k of ['x0', 'x1', 'z0', 'z1', 'yLow', 'yHigh']) s[k] = r2(s[k]);
    this.stairs.push(s);
    return s;
  }
  solid(x0, x1, z0, z1, y, h = 1.2, tag = '') { const s = { x0: Math.min(x0, x1), x1: Math.max(x0, x1), z0: Math.min(z0, z1), z1: Math.max(z0, z1), y, h, tag }; this.solids.push(s); return s; }
  prop(t, o = {}) { const p = { t, ...o }; this.props.push(p); return p; }
  hot(kind, label, x, y, z, r = 1.4) { this.hotspots.push({ kind, label, x, y, z, r }); }
  window(room, side, from, to, bottom = 1.0, top = 2.1) { if (to - from > 0.3) room.windows.push({ side, from: r2(from), to: r2(to), bottom, top }); }
  rail(pts, y) { this.rails.push({ pts: pts.map(([x, z]) => [r2(x), r2(z)]), y }); }
  sign(x, y, z, rotY, lines) { this.prop('sign', { x, y, z, rotY, lines }); }

  // ---- composite pieces
  /** Open deck strips at height y following the hull outline between z0 (fwd) and z1 (aft). */
  deckStrips(id, z0, z1, y, { name = 'Main deck', len = 6, drawFloor = false, endN = RAIL_IN, endS = RAIL_IN, minW = 0.8, x0 = null, x1 = null } = {}) {
    const out = [], cuts = [z0];
    // split into strips no longer than `len`, and shorter where the hull narrows: each strip loses at most `tol` of
    // half-beam across its length, so the strips hug the outline wherever they start, the foredeck reaches right up to
    // the bow and side decks always meet the strips fore and aft of them
    const tol = Math.max(0.1, this.B * 0.01);
    const spread = (a, b) => { let lo = Infinity, hi = -Infinity; for (let k = 0; k <= 8; k++) { const h = this.hb(a + ((b - a) * k) / 8); lo = Math.min(lo, h); hi = Math.max(hi, h); } return hi - lo; };
    for (let z = z0; z < z1 - 1e-6; ) {
      let step = Math.min(len, z1 - z);
      while (step > 0.6 && spread(z, z + step) > tol) step = Math.max(0.6, step * 0.6);
      z = Math.min(z1, z + step);
      if (z1 - z < 0.6) z = z1; // no sliver strips at the end
      cuts.push(z);
    }
    const n = cuts.length - 1;
    for (let i = 0; i < n; i++) {
      const a = cuts[i], b = cuts[i + 1];
      const hw = this.minHb(a, b) - this.edge;
      if (hw * 2 < minW) continue;
      const r = this.room({ id: `${id}-${i}`, kind: 'deck', name, open: true, x0: x0 ?? -hw, x1: x1 ?? hw, z0: a, z1: b, y, h: 2.4, floor: 'deck', drawFloor,
        inset: { e: RAIL_IN, w: RAIL_IN, n: i === 0 ? endN : 0, s: i === n - 1 ? endS : 0 } });
      out.push(r);
    }
    return out;
  }
  /** Hull outline rails at deck level (both sides) between z0 and z1, standing `inset` m inside the plating. */
  hullRails(z0, z1, y, inset = this.railInset) {
    for (const side of [-1, 1]) {
      const pts = [];
      for (let z = z0; z <= z1 + 1e-6; z += Math.max(0.5, (z1 - z0) / 40)) pts.push([side * Math.max(0, this.hb(z) - inset), z]);
      if (pts.length > 1) this.rail(pts, y);
    }
  }

  finish() {
    // holes: a stair cuts the floor of every room it rises into, the ceiling of every room it rises out of
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
    for (const r of this.rooms) for (const c of r.cuts) { r.floorHoles.push(c); if (r.ceiling !== false) r.ceilHoles.push(c); }
    return {
      cls: this.cls, L: this.L, B: this.B, F: this.F, deckY: this.deckY,
      rooms: this.rooms, doors: this.doors, stairs: this.stairs, solids: this.solids, props: this.props, hotspots: this.hotspots,
      rails: this.rails, deck: this.deck, spawn: this.spawn, helm: this.helm, levels: this.levels, style: this.style || 'ship', house: this.house || null,
    };
  }
}

// ------------------------------------------------------------------------------------------------ furniture (footprint + prop)
function bunk(P, x, y, z, along, len, tiers = 1, label = 'Rest in the bunk') {
  const w = 0.85, sx = along === 'z' ? w : len, sz = along === 'z' ? len : w;
  P.prop('bunk', { x, y, z, along, len, tiers });
  P.solid(x - sx / 2, x + sx / 2, z - sz / 2, z + sz / 2, y, 0.6 + (tiers - 1) * 0.95, 'bunk');
  P.hot('bunk', label, x, y, z, 1.5);
}
function desk(P, x, y, z, rotY = 0) { P.prop('desk', { x, y, z, rotY }); const c = Math.abs(Math.cos(rotY)) > 0.5; P.solid(x - (c ? 0.5 : 0.3), x + (c ? 0.5 : 0.3), z - (c ? 0.3 : 0.5), z + (c ? 0.3 : 0.5), y, 0.8, 'desk'); }
function table(P, x, y, z, w, d, benches = true) {
  P.prop('table', { x, y, z, w, d, benches });
  const bx = benches ? 0 : 0, bz = benches ? 0.5 : 0;
  P.solid(x - w / 2 - bx, x + w / 2 + bx, z - d / 2 - bz, z + d / 2 + bz, y, 0.8, 'table');
}
function counter(P, x0, x1, z0, z1, y, kind = 'galley') { P.prop('counter', { x0, x1, z0, z1, y, kind }); P.solid(x0, x1, z0, z1, y, 0.95, kind); }
/** A V-berth filling the forward part of a bow cabin; the standing room is at its aft end by the door. */
function vberth(P, r) {
  const len = Math.max(0.6, r.z1 - r.z0 - 0.75), w = Math.min(1.9, r.x1 - r.x0 + 0.2);
  P.prop('bunk', { x: (r.x0 + r.x1) / 2, y: r.y, z: r.z0 + len / 2, along: 'z', len, tiers: 1, w, vberth: true });
  P.solid(r.x0, r.x1, r.z0, r.z0 + len, r.y, 0.6, 'bunk');
  P.hot('bunk', 'Rest in the berth', (r.x0 + r.x1) / 2, r.y, r.z0 + len / 2, 1.6);
}
function lockers(P, x0, x1, z0, z1, y) { P.prop('lockers', { x0, x1, z0, z1, y }); P.solid(x0, x1, z0, z1, y, 2.0, 'lockers'); }

/** Wheelhouse console across the front of a bridge; the helmsman stands aft of it facing forward. */
function helmConsole(P, x, y, z, w, d = 0.8) {
  P.prop('helm', { x, y, z, w, facing: -1 });
  P.solid(x - w / 2, x + w / 2, z - d / 2 - 0.05, z + d / 2 + 0.05, y, 1.3, 'console');
  P.hot('helm', 'Take the helm', x, y, z + 1.0, 1.5);
  P.helm = { x, y, z: z + 1.0 };
}
function chartTable(P, x, y, z, w = 1.4, d = 0.9) { P.prop('chart', { x, y, z, w, d }); P.solid(x - w / 2, x + w / 2, z - d / 2, z + d / 2, y, 0.95, 'chart'); P.hot('chart', 'Open the chart', x, y, z, 1.6); }
function radio(P, x, y, z, rotY = 0) { P.prop('radio', { x, y: y + 1.55, z, rotY }); P.hot('radio', 'Use the VHF radio (chat)', x, y, z, 1.4); }

/** Engine room machinery: main engine(s), generators, pipes, and the control console with live gauges.
 *  consoleAt: { x, z, rotY, wall } — rotY 0: the screen faces aft (+z), π: forward; wall: a panel on the wall (no floor
 *  footprint). side: +1 puts a single engine of a small bay against the starboard side, −1 against port. */
function engineRoom(P, r, { twin = false, consoleAt = null, scale = 1, side = 1, doorSide = null } = {}) {
  const { L } = P, y = r.y, W = r.x1 - r.x0, D = r.z1 - r.z0;
  const small = W < 4.5 || D < 4.5, pad = small ? 0.1 : 0.3;
  const n = twin && W >= 3.6 ? 2 : 1;
  const el = Math.max(0.9, Math.min(clamp(L * 0.07, 1.2, 9), D - (small ? 1.1 : 3.0)));
  const ew = Math.max(0.5, Math.min(clamp(L * 0.022 * scale, 0.6, 2.6), (W - (small ? 1.25 : 2.8)) / n - (n > 1 ? 0.9 : 0)));
  const eh = clamp(L * 0.03, 0.6, Math.min(3.0, r.h - 0.7));
  let cz = (r.z0 + r.z1) / 2 + (small ? 0 : -0.3);
  let xs = n === 2 ? [r.x0 + W * 0.3, r.x0 + W * 0.7] : small ? [side > 0 ? r.x1 - 0.1 - ew / 2 - pad : r.x0 + 0.1 + ew / 2 + pad] : [r.x0 + W * 0.58];
  if (small && (doorSide === 'n' || doorSide === 's')) { // a tiny bay: the engine at the far end, standing room by the door
    cz = doorSide === 'n' ? r.z1 - 0.1 - el / 2 - pad : r.z0 + 0.1 + el / 2 + pad;
    xs = [(r.x0 + r.x1) / 2];
  }
  for (const x of xs) {
    P.prop('engine', { x, y, z: cz, len: el, w: ew, h: eh });
    P.solid(x - ew / 2 - pad, x + ew / 2 + pad, cz - el / 2 - pad, cz + el / 2 + pad, y, eh + 0.6, 'engine');
  }
  if (W >= 4.2 && D >= 5) { // generators along the port side, forward
    const gl = clamp(L * 0.025, 1.0, 2.6), gw = clamp(L * 0.01, 0.6, 1.2);
    const gx = r.x0 + 0.35 + gw / 2 + 0.2;
    for (let i = 0; i < (D >= 9 ? 2 : 1); i++) {
      const gz = r.z0 + 0.5 + gl / 2 + i * (gl + 0.9);
      P.prop('generator', { x: gx, y, z: gz, len: gl, w: gw, h: Math.min(1.4, r.h - 0.6) });
      P.solid(gx - gw / 2 - 0.15, gx + gw / 2 + 0.15, gz - gl / 2 - 0.15, gz + gl / 2 + 0.15, y, 1.5, 'generator');
    }
  }
  P.prop('pipes', { x0: r.x0, x1: r.x1, z0: r.z0, z1: r.z1, y, h: r.h });
  // control console with live rpm / throttle / fuel (interior.js draws the screen)
  const c = consoleAt || { x: r.x1 - 0.95, z: r.z0 + 0.45, rotY: 0 };
  const ox = Math.sin(c.rotY), oz = Math.cos(c.rotY);
  P.prop('console', { x: c.x, y, z: c.z, rotY: c.rotY, wall: !!c.wall });
  if (!c.wall) {
    const side90 = Math.abs(ox) > 0.5;
    // 1.75 m: up to the top of the gauge panel (interior.js), so a third-person camera is kept out of the panel too
    P.solid(c.x - (side90 ? 0.35 : 0.85), c.x + (side90 ? 0.35 : 0.85), c.z - (side90 ? 0.85 : 0.35), c.z + (side90 ? 0.85 : 0.35), y, 1.75, 'console');
  }
  const d = c.wall ? 0.75 : 1.0;
  P.hot('engine', 'Check the engine (rpm, fuel, temperature)', c.x + ox * d, y, c.z + oz * d, 1.6);
}

function furnishCabin(P, r, doorSide) {
  const W = r.x1 - r.x0, D = r.z1 - r.z0, y = r.y;
  if (doorSide === 's' || doorSide === 'n') {
    const far = doorSide === 's' ? r.z0 : r.z1, dir = doorSide === 's' ? 1 : -1; // from the wall opposite the door inwards
    if (W >= 2.3) bunk(P, (r.x0 + r.x1) / 2, y, far + dir * 0.55, 'x', Math.min(2.0, W - 0.3), 1);
    else { const len = Math.min(2.0, D - 1.3); bunk(P, r.x0 + 0.55, y, far + dir * (len / 2 + 0.1), 'z', len, 1); }
    if (D >= 3.3 && W >= 2.6) desk(P, r.x1 - 0.4, y, far + dir * 1.6, Math.PI / 2);
  } else {
    const far = doorSide === 'e' ? r.x0 : r.x1, dir = doorSide === 'e' ? 1 : -1;
    if (D >= 2.3) bunk(P, far + dir * 0.55, y, (r.z0 + r.z1) / 2, 'z', Math.min(2.0, D - 0.3), 1);
    else bunk(P, (r.x0 + r.x1) / 2, y, r.z0 + 0.55, 'x', Math.min(2.0, W - 1.3), 1);
    if (W >= 3.2 && D >= 2.6) desk(P, far + dir * 1.6, y, r.z0 + 0.4, 0);
  }
}

// ------------------------------------------------------------------------------------------------ deckhouse ships
// coaster, feeder, bulker, tanker, boxship, psv, trawler, tug, superyacht and (with a car deck) the ferry.
const HOUSE = {
  coaster: { hc: 0.37, hl: 0.15, hw: 0.74, tiers: 3, tierH: 2.9, wings: true, cargo: 'hatches', nHatch: 3, hatchW: 0.62, cargoFrom: 0.13 },
  feeder: { hc: 0.4, hl: 0.1, hw: 0.72, tiers: 5, tierH: 2.9, wings: true, cargo: 'boxes', cargoFrom: 0.12, rowsW: 0.76, fcsle: 0.05 },
  bulker: { hc: 0.415, hl: 0.085, hw: 0.62, tiers: 5, tierH: 2.9, wings: true, cargo: 'hatches', nHatch: 5, hatchW: 0.55, cargoFrom: 0.1, fcsle: 0.07 },
  tanker: { hc: 0.415, hl: 0.085, hw: 0.6, tiers: 5, tierH: 2.9, wings: true, cargo: 'pipes', cargoFrom: 0.09, fcsle: 0.07 },
  boxship: { hc: -0.16, hl: 0.055, hw: 0.55, tiers: 8, tierH: 2.9, wings: true, cargo: 'boxes', cargoFrom: 0.1, rowsW: 0.85, fcsle: 0.06, casing: { c: 0.33, l: 0.05, w: 0.4 } },
  psv: { hc: -0.12, hl: 0.22, hw: 0.92, tiers: 3, tierH: 3.0, wings: true, cargo: 'deck', aftCargo: true },
  trawler: { hc: -0.155, hl: 0.225, hw: 0.7, tiers: 1, tierH: 3.0, wings: false, small: true, aft: 'trawl' },
  tug: { hc: -0.13, hl: 0.3, hw: 0.62, tiers: 2, tierH: 2.8, wings: false, small: true, aft: 'tow' },
  superyacht: { hc: 0.085, hl: 0.42, hw: 0.62, tiers: 2, tierH: 3.2, wings: true, style: 'yacht', sideMin: 0.95 },
  ferry: { hc: -0.135, hl: 0.22, hw: 0.86, tiers: 3, tierH: 3.0, wings: true, ferry: true, carH: 4.6, sideMin: 1.6 },
};

function planHouse(P, S) {
  const { L, B, deckY: yD } = P;
  const small = !!S.small;
  const CW = small ? 1.0 : 1.15, LAND = small ? 1.1 : 1.3, CPW = small ? 1.4 : 1.8;
  P.style = S.style || 'ship';
  // levels: [main or car deck, accommodation…, bridge]
  const levels = [];
  if (S.ferry) {
    levels.push({ y: yD, kind: 'car', name: 'Car deck' });
    const y1 = yD + S.carH + 0.2;
    levels.push({ y: y1, kind: 'public', name: 'Passenger deck' });
    levels.push({ y: y1 + S.tierH, kind: 'accom', name: 'Cabin deck' });
    levels.push({ y: y1 + 2 * S.tierH, kind: 'bridge', name: 'Bridge deck' });
  } else {
    levels.push({ y: yD, kind: 'main', name: 'Main deck' });
    for (let k = 1; k < S.tiers; k++) levels.push({ y: yD + k * S.tierH, kind: 'accom', name: `${String.fromCharCode(64 + k)}-deck` });
    levels.push({ y: yD + S.tiers * S.tierH, kind: 'bridge', name: 'Bridge deck' });
  }
  for (const lv of levels) lv.y = r2(lv.y);
  // engine room depth and the common stair run (all flights stack in one column, so they share the run)
  const yE = r2(Math.max(0.75, yD - clamp(yD - 0.8, 2.3, 5.6)));
  const engRise = yD - yE;
  let maxRise = 0; for (let k = 0; k < levels.length - 1; k++) maxRise = Math.max(maxRise, levels[k + 1].y - levels[k].y);
  const run = r2(Math.max(maxRise / tanD(small ? 46 : 42), (S.casing ? 0 : engRise) / tanD(58), 2.2));
  const TL = 2 * LAND + run;
  // house footprint: length enough for the stairway + lobby + rooms; width leaves side decks
  let hlen = Math.max(S.hl * L, TL + CPW + (small ? 3.4 : 4.6));
  let hz0 = S.hc * L - hlen / 2, hz1 = hz0 + hlen;
  if (hz1 > L / 2 - 2.5) { hz1 = L / 2 - 2.5; hz0 = hz1 - hlen; }
  const sideMin = S.sideMin ?? (small ? 0.9 : 1.25);
  const hwMax = 2 * (P.minHb(hz0 - (S.ferry ? 0 : 1.2), Math.min(hz1 + 1.8, L / 2 - 0.8)) - EDGE - sideMin);
  const hw = r2(Math.min(S.hw * B, hwMax));
  if (hw < 2 * CW + 1.6) throw new Error(`[shipplan] ${P.cls}: house too narrow (${hw.toFixed(2)} m)`);
  const X0 = -hw / 2, X1 = hw / 2;
  const tz0 = hz1 - TL, tz1 = hz1, tx0 = X0, tx1 = X0 + 2 * CW;
  const runZ0 = tz0 + LAND, runZ1 = tz1 - LAND;
  const cz0 = tz0 - CPW, cz1 = tz0;
  P.house = { hz0, hz1, hw };
  const yMain = levels[0].y;

  // ---- open main deck (or the passenger deck on top of the ferry's car deck)
  const deckLv = S.ferry ? levels[1] : levels[0];
  const yO = deckLv.y, raised = !!S.ferry;
  const aftEnd = L / 2 - (raised ? 3 : 0.8);
  const hasAft = aftEnd - hz1 > 1.6;
  const sz0 = hz0 - (raised ? 0 : 1.2), sz1 = raised ? hz1 : Math.min(hz1 + 1.2, aftEnd);
  const sideW = P.minHb(sz0, sz1 + 0.6) - EDGE;
  const sIn = { n: raised ? RAIL_IN : 0, s: hasAft ? (raised ? -0.6 : 0) : RAIL_IN };
  const sideP = P.room({ id: 'deck-port', kind: 'deck', name: S.ferry ? 'Promenade deck (port)' : 'Main deck (port side)', open: true, x0: -sideW, x1: X0, z0: sz0, z1: sz1, y: yO, floor: 'deck', drawFloor: raised, inset: { w: RAIL_IN, e: R, ...sIn } });
  const sideS = P.room({ id: 'deck-stbd', kind: 'deck', name: S.ferry ? 'Promenade deck (starboard)' : 'Main deck (starboard side)', open: true, x0: X1, x1: sideW, z0: sz0, z1: sz1, y: yO, floor: 'deck', drawFloor: raised, inset: { e: RAIL_IN, w: R, ...sIn } });
  if (hasAft) P.deckStrips('deck-aft', hz1, aftEnd, yO, { name: S.ferry ? 'Sun deck (aft)' : S.aft === 'trawl' ? 'Working deck' : S.aft === 'tow' ? 'Towing deck' : 'Aft deck', len: raised ? 1e9 : 6, drawFloor: raised, endN: R, endS: RAIL_IN });
  let fcsle = null;
  if (!raised) {
    const bowW = bowZWhere(P.half, L, 0.9 + EDGE);
    const fcLen = S.fcsle ? S.fcsle * L : 0;
    const fz0 = bowW + 0.3;
    if (fcLen > 0) {
      fcsle = { z0: fz0, z1: -L / 2 + fcLen, y: r2(yD + 2.4) };
      P.deckStrips('fcsle', fcsle.z0, fcsle.z1, fcsle.y, { name: 'Forecastle', len: 5, drawFloor: true, endN: RAIL_IN, endS: RAIL_IN });
      P.prop('raised', { z0: fz0 - 1.2, z1: fcsle.z1, y0: yD, y1: fcsle.y });
      P.deckStrips('deck-fwd', fcsle.z1, hz0, yD, { name: 'Main deck (forward)', len: 8, endN: R, endS: R });
    } else P.deckStrips('deck-fwd', fz0, hz0, yD, { name: 'Main deck (forward)', len: 6, endN: RAIL_IN, endS: R });
  }

  // ---- ferry car deck (enclosed main deck under the passenger decks)
  let carDeck = null;
  if (S.ferry) {
    const cz0c = bowZWhere(P.half, L, B / 2 - 0.6) + 2, cz1c = L / 2 - 1.5;
    const half = P.minHb(cz0c, cz1c) - HULL_IN;
    carDeck = P.room({ id: 'cardeck', kind: 'store', name: 'Car deck', x0: -half, x1: half, z0: cz0c, z1: cz1c, y: yMain, h: S.carH, floor: 'steel', wall: 'steel', cuts: [{ x0: tx0, x1: tx1, z0: tz0, z1: tz1 }], dark: true });
    levels[0].carRoom = carDeck;
    // two lanes of lorries and cars with a walkway along the port side and around the stairway
    const lanes = [half * 0.18, half * 0.58];
    let seed = 7;
    const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    for (const lx of lanes) {
      for (let z = cz0c + 6; z < cz1c - 4; ) {
        const lorry = rnd() < 0.45, len = lorry ? 13 : 4.6, w = lorry ? 2.5 : 1.8, h = lorry ? 3.8 : 1.5;
        if (z + len > cz1c - 3) break;
        if (!(lx - w / 2 < tx1 + 1.6 && z + len > tz0 - 2 && z < tz1 + 2)) {
          P.prop('vehicle', { x: lx, z: z + len / 2, y: yMain, len, w, h, lorry, color: Math.floor(rnd() * 6) });
          P.solid(lx - w / 2, lx + w / 2, z, z + len, yMain, h, 'vehicle');
        }
        z += len + 1.2 + rnd() * 1.5;
      }
    }
    P.prop('ramp', { x: 0, z: cz1c, y: yMain, w: half * 1.4 });
  }

  // ---- the house, level by level
  const T = [];
  levels.forEach((lv, k) => {
    const top = k === levels.length - 1;
    const h = r2(top ? 2.6 : levels[k + 1].y - lv.y - 0.12);
    lv.h = h;
    const t = P.room({ id: `stairs-${k}`, kind: 'stairs', name: `Stairway (${lv.name})`, x0: tx0, x1: tx1, z0: tz0, z1: tz1, y: lv.y, h, floor: 'lino', wall: 'white', level: k });
    T.push(t);
    const down = k > 0 ? levels[k - 1].name.toLowerCase() : S.casing ? '' : 'engine room';
    P.sign(tx1 - 0.06, lv.y + 1.75, tz0 + LAND * 0.55, -Math.PI / 2, [lv.name.toUpperCase(), [top ? '' : '▲ bridge', down ? `▼ ${down}` : ''].filter(Boolean).join('   ')]);
    if (lv.kind === 'car') { P.opening(t, carDeck, 'n', (tx0 + tx1) / 2, 2 * CW - 0.2); P.door(t, carDeck, 'e', runZ1 + LAND / 2, 0.95, 2.05, 'door'); return; }
    const cp = P.room({ id: k === 0 ? 'passage' : `passage-${k}`, kind: 'passage', name: lv.kind === 'bridge' ? 'Lobby behind the bridge' : `Passage (${lv.name})`, x0: X0, x1: X1, z0: cz0, z1: cz1, y: lv.y, h });
    P.opening(t, cp, 'n', (tx0 + tx1) / 2, 2 * CW - 0.2);
    if (lv.kind === 'main' || lv.kind === 'public') { // weather doors to the side decks
      P.door(cp, sideP, 'w', (cz0 + cz1) / 2, 1.0, 2.05, 'ext'); P.door(cp, sideS, 'e', (cz0 + cz1) / 2, 1.0, 2.05, 'ext');
    }
    // the band beside the stairway
    if (X1 - tx1 >= 2.0) {
      const kind = lv.kind === 'bridge' ? 'store' : lv.kind === 'main' ? (small ? 'cabin' : 'store') : lv.kind === 'public' ? 'store' : 'cabin';
      const name = lv.kind === 'bridge' ? 'Radio room' : lv.kind === 'main' ? (small ? 'Crew cabin' : 'Changing room') : lv.kind === 'public' ? 'Shop' : 'Cabin';
      const band = P.room({ id: `band-${k}`, kind, name, x0: tx1, x1: X1, z0: tz0, z1: tz1, y: lv.y, h, floor: kind === 'cabin' ? 'carpet' : 'lino' });
      const dx = tx1 + Math.min(0.9, (X1 - tx1) / 2);
      P.door(band, cp, 'n', dx, 0.9);
      if (kind === 'cabin') furnishCabin(P, band, 'n');
      else if (lv.kind === 'bridge') { radio(P, X1 - 0.5, lv.y, tz1 - 0.6, Math.PI); P.prop('radio', { x: X1 - 0.5, y: lv.y + 1.55, z: tz0 + 1.2, rotY: Math.PI / 2 }); desk(P, X1 - 0.45, lv.y, (tz0 + tz1) / 2 + 0.6, Math.PI / 2); }
      else if (lv.kind === 'main') lockers(P, X1 - 0.5, X1 - 0.1, tz0 + 1.2, tz1 - 0.3, lv.y);
      else counter(P, X1 - 0.75, X1 - 0.1, tz0 + 1.3, tz1 - 0.3, lv.y, 'shop');
      if (X1 >= hw / 2 - 0.01) P.window(band, 'e', tz0 + 0.8, tz1 - 0.8, 1.2, 1.9);
    }
    fillFront(P, lv, { x0: X0, x1: X1, z0: hz0, z1: cz0 }, cp, S, k);
  });
  // ---- flights: one column on the port side, all rising forward, a corridor beside them to walk back aft
  for (let k = 0; k < levels.length - 1; k++) {
    P.stair({ id: `flight-${k}`, x0: tx0 + 0.06, x1: tx0 + CW - 0.04, z0: runZ0, z1: runZ1, yLow: levels[k].y, yHigh: levels[k + 1].y, up: 'n', foot: T[k].id, head: T[k + 1].id });
  }
  // ---- engine room under the house (or under an aft engine casing)
  if (S.casing) planCasing(P, S, yE, sideP, sideS);
  else {
    const ez0 = Math.max(hz0 - 3, bowZWhere(P.half, L, hw / 2 + 1)), ez1 = hz1;
    const eh = P.minHb(ez0, ez1) - HULL_IN;
    const ex0 = Math.max(-eh, X0 - 2.5), ex1 = Math.min(eh, X1 + 2.5);
    const eng = P.room({ id: 'engine', kind: 'engine', name: 'Engine room', x0: Math.min(ex0, X0), x1: Math.max(ex1, X1), z0: ez0, z1: ez1, y: yE, h: r2(yMain - yE - 0.12), floor: 'grating', wall: 'dark', dark: true });
    P.stair({ id: 'flight-engine', x0: tx0 + 0.06, x1: tx0 + CW - 0.04, z0: runZ0, z1: runZ1, yLow: yE, yHigh: levels[0].y, up: 'n', foot: 'engine', head: T[0].id, kind: 'steep' });
    engineRoom(P, eng, { twin: S.ferry || P.cls === 'psv' || P.cls === 'superyacht' || P.cls === 'tug', consoleAt: { x: Math.min(eng.x1 - 1.0, tx1 + 1.6), z: eng.z1 - 0.45, rotY: Math.PI } });
    P.sign(tx0 + 0.06, yE + 1.8, runZ1 + LAND * 0.5, Math.PI / 2, ['ENGINE ROOM', '▲ stairs up']);
  }
  P.levels = levels.map((l) => ({ y: l.y, name: l.name, kind: l.kind }));
  if (!S.casing) P.levels.unshift({ y: yE, name: 'Engine room', kind: 'engine' });

  // ---- cargo and deck machinery
  planCargo(P, S, { hz0, hz1, hw, fcsle });
  // ---- funnel on the house roof, mast on the forecastle, rails
  const topY = levels[levels.length - 1].y + 2.66;
  if (!S.style) P.prop('funnel', { x: (tx1 + X1) / 2, z: (tz0 + tz1) / 2 + 0.3, y: topY, h: small ? 2.5 : 5, r: clamp(B * 0.06, 0.5, 2.4) });
  if (!raised && fcsle) { P.hullRails(fcsle.z1, L / 2 - 0.2, yD); P.hullRails(bowZWhere(P.half, L, 0.35), fcsle.z1, fcsle.y); }
  else if (!raised) P.hullRails(bowZWhere(P.half, L, 0.35), L / 2 - 0.2, yD);
  else { // ferry: rails round the passenger-deck promenades and the sun deck, bulwark on the car deck
    P.rail([[-sideW - 0.2, hz0], [-sideW - 0.2, aftEnd + 0.1], [sideW + 0.2, aftEnd + 0.1], [sideW + 0.2, hz0]], yO);
    P.rail([[-sideW - 0.2, hz0], [X0, hz0]], yO); P.rail([[X1, hz0], [sideW + 0.2, hz0]], yO);
  }
}

/** Room plan of the house block forward of the lobby on one level. */
function fillFront(P, lv, blk, cp, S, k) {
  const depth = blk.z1 - blk.z0, W = blk.x1 - blk.x0, y = lv.y, h = lv.h;
  const kind = lv.kind;
  const maxDirect = kind === 'bridge' ? 10 : 7.5;
  if (depth <= maxDirect) {
    if (kind === 'bridge') return bridgeRoom(P, lv, blk, cp, S);
    if (kind === 'main' || kind === 'public') return messRooms(P, lv, blk, cp, 's', S, k);
    // accommodation: cabins side by side across the house
    const m = clamp(Math.floor(W / 3.0), 1, 5);
    for (let i = 0; i < m; i++) {
      const x0 = blk.x0 + (W * i) / m, x1 = blk.x0 + (W * (i + 1)) / m;
      const c = P.room({ id: `cabin-${k}-${i}`, kind: 'cabin', name: 'Cabin', x0, x1, z0: blk.z0, z1: blk.z1, y, h, floor: 'carpet' });
      P.door(c, cp, 's', (x0 + x1) / 2 + (W / m > 2.6 ? 0.55 : 0), 0.9);
      furnishCabin(P, c, 's');
      P.window(c, 'n', x0 + 0.5, x1 - 0.5, 1.2, 1.9);
      if (i === 0) P.window(c, 'w', blk.z0 + 0.6, blk.z1 - 0.6, 1.2, 1.9);
      if (i === m - 1) P.window(c, 'e', blk.z0 + 0.6, blk.z1 - 0.6, 1.2, 1.9);
    }
    return;
  }
  // deep block: a centre passage from the lobby forward, rooms either side, one full-width room at the front
  const frontD = kind === 'bridge' ? Math.min(8.5, depth - 3) : kind === 'public' ? Math.min(9, depth - 3) : kind === 'main' ? Math.min(6, depth - 3) : Math.min(4.5, depth - 3);
  const pz0 = blk.z0 + frontD;
  const pw = 0.8;
  const pass = P.room({ id: `fpass-${k}`, kind: 'passage', name: `Passage (${lv.name})`, x0: -pw, x1: pw, z0: pz0, z1: blk.z1, y, h });
  P.opening(pass, cp, 's', 0, 2 * pw - 0.2);
  const front = { x0: blk.x0, x1: blk.x1, z0: blk.z0, z1: pz0 };
  if (kind === 'bridge') bridgeRoom(P, lv, front, pass, S);
  else if (kind === 'main' || kind === 'public') messRooms(P, lv, front, pass, 's', S, k);
  else {
    const day = P.room({ id: `dayroom-${k}`, kind: 'cabin', name: 'Day room', ...front, y, h, floor: 'carpet' });
    P.door(day, pass, 's', 0, 1.2);
    table(P, (front.x0 + front.x1) / 2 - W * 0.2, y, (front.z0 + front.z1) / 2, 1.4, 0.8, true);
    P.prop('sofa', { x0: front.x1 - 2.6, x1: front.x1 - 0.2, z0: front.z0 + 0.2, z1: front.z0 + 0.95, y }); P.solid(front.x1 - 2.6, front.x1 - 0.2, front.z0 + 0.2, front.z0 + 0.95, y, 0.8, 'sofa');
    P.window(day, 'n', front.x0 + 0.6, front.x1 - 0.6, 1.0, 2.0);
  }
  // side rooms along the passage
  const segs = Math.max(1, Math.round((blk.z1 - pz0) / 3.4));
  for (const side of [-1, 1]) {
    for (let i = 0; i < segs; i++) {
      const z0 = pz0 + ((blk.z1 - pz0) * i) / segs, z1 = pz0 + ((blk.z1 - pz0) * (i + 1)) / segs;
      const x0 = side < 0 ? blk.x0 : pw, x1 = side < 0 ? -pw : blk.x1;
      let rk = 'cabin', name = 'Cabin';
      if (kind === 'main') { rk = side < 0 && i === 0 ? 'mess' : 'store'; name = side < 0 && i === 0 ? 'Galley' : side < 0 ? 'Laundry' : i === 0 ? 'Ship\'s office' : 'Stores'; }
      if (kind === 'public') { rk = 'mess'; name = side < 0 ? 'Lounge' : 'Shop & bar'; }
      if (kind === 'bridge') name = i === 0 ? 'Captain\'s cabin' : 'Officer\'s cabin';
      const r = P.room({ id: `side-${k}-${side < 0 ? 'p' : 's'}-${i}`, kind: rk, name, x0, x1, z0, z1, y, h, floor: rk === 'cabin' ? 'carpet' : 'lino' });
      P.door(r, pass, side < 0 ? 'e' : 'w', (z0 + z1) / 2, 0.9);
      if (side < 0) P.window(r, 'w', z0 + 0.6, z1 - 0.6, 1.2, 1.9); else P.window(r, 'e', z0 + 0.6, z1 - 0.6, 1.2, 1.9);
      if (rk === 'cabin') furnishCabin(P, r, side < 0 ? 'e' : 'w');
      else if (name === 'Galley') { counter(P, x0 + 0.1, x0 + 0.75, z0 + 0.3, z1 - 0.3, y, 'galley'); const mess = P.byId(`mess-${k}`); if (mess && Math.abs(mess.z1 - z0) < 0.05) P.door(r, mess, 'n', (x0 + x1) / 2, 0.9); }
      else if (rk === 'mess') { table(P, (x0 + x1) / 2 + side * 0.2, y, (z0 + z1) / 2, Math.min(1.6, x1 - x0 - 1.6), 0.8, true); }
      else lockers(P, side < 0 ? x0 + 0.1 : x1 - 0.5, side < 0 ? x0 + 0.5 : x1 - 0.1, z0 + 0.4, z1 - 0.4, y);
    }
  }
}

/** Mess + galley (main deck) or cafeteria (ferry passenger deck) in a block whose `doorSide` wall faces `hall`. */
function messRooms(P, lv, blk, hall, doorSide, S, k) {
  const y = lv.y, h = lv.h, W = blk.x1 - blk.x0, D = blk.z1 - blk.z0;
  const id = lv.kind === 'public' ? 'mess-cafe' : `mess-${k}`;
  const name = lv.kind === 'public' ? 'Cafeteria' : S.style === 'yacht' ? 'Saloon & dining room' : 'Mess room';
  const hx0 = Math.max(blk.x0, hall.x0), hx1 = Math.min(blk.x1, hall.x1);
  if (W >= 7.2 && lv.kind === 'main' && hall.x1 - hall.x0 > 4) {
    const gw = clamp(W * 0.36, 2.6, 4.5);
    const galley = P.room({ id: 'galley', kind: 'mess', name: 'Galley', x0: blk.x0, x1: blk.x0 + gw, z0: blk.z0, z1: blk.z1, y, h });
    const mess = P.room({ id, kind: 'mess', name, x0: blk.x0 + gw, x1: blk.x1, z0: blk.z0, z1: blk.z1, y, h, floor: S.style === 'yacht' ? 'wood' : 'lino' });
    P.door(galley, hall, doorSide, blk.x0 + gw / 2, 0.9);
    P.door(mess, hall, doorSide, blk.x0 + gw + Math.min(1.4, (W - gw) / 2), 1.0);
    P.door(galley, mess, 'e', blk.z0 + Math.min(1.5, D / 2), 0.9);
    counter(P, blk.x0 + 0.1, blk.x0 + 0.75, blk.z0 + 0.4, blk.z1 - 1.3, y, 'galley');
    counter(P, blk.x0 + 1.1, blk.x0 + gw - 0.3, blk.z0 + 0.1, blk.z0 + 0.7, y, 'galley');
    const mw = W - gw;
    table(P, blk.x0 + gw + mw * 0.55, y, blk.z0 + D * 0.42, Math.min(2.2, mw - 2.4), 0.85, true);
    P.window(mess, 'n', blk.x0 + gw + 0.5, blk.x1 - 0.5, 1.1, 2.0); P.window(mess, 'e', blk.z0 + 0.6, blk.z1 - 0.6, 1.1, 2.0); P.window(galley, 'w', blk.z0 + 0.8, blk.z1 - 0.8, 1.2, 1.9);
    return mess;
  }
  const mess = P.room({ id, kind: 'mess', name: W < 7.2 && lv.kind === 'main' ? (S.style === 'yacht' ? 'Saloon & galley' : 'Mess & galley') : name, ...blk, y, h, floor: S.style === 'yacht' ? 'wood' : 'lino' });
  P.door(mess, hall, doorSide, clamp(0.6, hx0 + 0.6, hx1 - 0.6), Math.min(1.2, hx1 - hx0 - 0.2));
  counter(P, blk.x0 + 0.1, blk.x0 + 0.75, blk.z0 + 0.3, blk.z1 - 1.4, y, 'galley');
  if (lv.kind === 'public') {
    const nx = Math.max(1, Math.floor((W - 2.6) / 3.0)), nz = Math.max(1, Math.floor((D - 1.5) / 2.6));
    for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) table(P, blk.x0 + 2.4 + (i + 0.5) * ((W - 2.6) / nx), y, blk.z0 + 0.9 + (j + 0.5) * ((D - 1.8) / nz), 1.2, 0.7, true);
  } else table(P, blk.x0 + W * 0.6, y, blk.z0 + D * 0.42, Math.min(2.0, W - 3.0), 0.8, true);
  P.window(mess, 'n', blk.x0 + 0.5, blk.x1 - 0.5, 1.1, 2.0); P.window(mess, 'e', blk.z0 + 0.6, blk.z1 - 0.6, 1.1, 2.0);
  return mess;
}

function bridgeRoom(P, lv, blk, hall, S) {
  const y = lv.y, h = lv.h, W = blk.x1 - blk.x0, D = blk.z1 - blk.z0;
  const br = P.room({ id: 'bridge', kind: 'bridge', name: P.cls === 'trawler' || P.cls === 'tug' ? 'Wheelhouse' : 'Bridge', ...blk, y, h, floor: S.style === 'yacht' ? 'wood' : 'lino' });
  const hx0 = Math.max(blk.x0, hall.x0), hx1 = Math.min(blk.x1, hall.x1);
  P.door(br, hall, 's', clamp(0, hx0 + 0.7, hx1 - 0.7), Math.min(1.2, hx1 - hx0 - 0.3), 2.1, 'open');
  const cw = Math.min(W - 2.2, 6);
  helmConsole(P, 0, y, blk.z0 + 0.75, cw);
  if (D >= 4.2) chartTable(P, blk.x1 - 1.05, y, blk.z1 - 0.85, 1.3, 0.85);
  radio(P, blk.x0 + 0.6, y, blk.z0 + 0.35, 0);
  P.window(br, 'n', blk.x0 + 0.25, blk.x1 - 0.25, 1.0, 2.3);
  const wingZ = blk.z0 + 2.15;
  P.window(br, 'e', blk.z0 + 0.25, wingZ - 0.7, 1.0, 2.3); P.window(br, 'w', blk.z0 + 0.25, wingZ - 0.7, 1.0, 2.3);
  P.window(br, 'e', wingZ + 0.7, blk.z1 - 0.4, 1.1, 2.2); P.window(br, 'w', wingZ + 0.7, blk.z1 - 0.4, 1.1, 2.2);
  P.spawn = { x: 0.8, y, z: blk.z0 + 2.2, yaw: 0 };
  if (!S.wings) return br;
  // bridge wings: open platforms out to the ship's side, doors from the wheelhouse
  const out = Math.max(blk.x1 + 1.7, P.hb(blk.z0) + 0.4);
  const wz0 = blk.z0 + 0.5, wz1 = Math.min(blk.z1, blk.z0 + 3.6);
  const wS = P.room({ id: 'wing-stbd', kind: 'deck', name: 'Bridge wing (starboard)', open: true, x0: blk.x1, x1: out, z0: wz0, z1: wz1, y, h: 2.4, floor: 'deck', inset: { w: R, e: RAIL_IN, n: RAIL_IN, s: RAIL_IN } });
  const wP = P.room({ id: 'wing-port', kind: 'deck', name: 'Bridge wing (port)', open: true, x0: -out, x1: blk.x0, z0: wz0, z1: wz1, y, h: 2.4, floor: 'deck', inset: { e: R, w: RAIL_IN, n: RAIL_IN, s: RAIL_IN } });
  P.door(br, wS, 'e', wingZ, 0.95, 2.05, 'ext'); P.door(br, wP, 'w', wingZ, 0.95, 2.05, 'ext');
  P.rail([[blk.x1, wz0], [out, wz0], [out, wz1], [blk.x1, wz1]], y); P.rail([[blk.x0, wz0], [-out, wz0], [-out, wz1], [blk.x0, wz1]], y);
  P.prop('repeater', { x: out - 0.5, y, z: wz0 + 0.5 }); P.prop('repeater', { x: -out + 0.5, y, z: wz0 + 0.5 });
  P.solid(out - 0.75, out - 0.25, wz0 + 0.25, wz0 + 0.75, y, 1.3, 'repeater'); P.solid(-out + 0.25, -out + 0.75, wz0 + 0.25, wz0 + 0.75, y, 1.3, 'repeater');
  return br;
}

/** Big boxship: engine room aft under the funnel casing, entered from the deck walkway. */
function planCasing(P, S, yE, sideP, sideS) {
  const { L, B, deckY: yD } = P;
  const c = S.casing, cz0 = c.c * L - (c.l * L) / 2, cz1 = cz0 + c.l * L, cw = Math.min(c.w * B, 2 * (P.minHb(cz0, cz1) - EDGE - 2));
  const CW = 1.15, LAND = 1.3, run = r2((yD - yE) / tanD(55));
  const tz1 = cz1, tz0 = tz1 - (2 * LAND + run);
  const casing = P.room({ id: 'casing', kind: 'stairs', name: 'Engine casing', x0: -cw / 2, x1: -cw / 2 + 2 * CW + 1.2, z0: tz0, z1: tz1, y: yD, h: 2.6, floor: 'grating', wall: 'dark' });
  const deckAround = P.rooms.filter((r) => r.id.startsWith('deck-aft') || r.id.startsWith('deck-fwd'));
  const host = deckAround.find((r) => r.z0 <= tz0 + LAND && r.z1 >= tz0 + LAND) || deckAround[0];
  P.door(casing, host, 'w', tz0 + LAND / 2 + 0.2, 1.0, 2.05, 'ext');
  for (const r of P.rooms) if (r.open && Math.abs(r.y - yD) < 0.05 && r.x0 < casing.x1 && r.x1 > casing.x0 && r.z0 < casing.z1 && r.z1 > casing.z0) r.cuts.push({ x0: casing.x0, x1: casing.x1, z0: casing.z0, z1: casing.z1 });
  const sx0 = casing.x0 + 2 * CW + 1.2;
  if (cw / 2 - sx0 > 0.6) { P.solid(sx0, cw / 2, cz0, cz1, yD, 14, 'casing'); P.prop('block', { x0: sx0, x1: cw / 2, z0: cz0, z1: cz1, y: yD, h: 14 }); }
  if (tz0 - cz0 > 0.6) { P.solid(-cw / 2, sx0, cz0, tz0, yD, 14, 'casing'); P.prop('block', { x0: -cw / 2, x1: sx0, z0: cz0, z1: tz0, y: yD, h: 14 }); }
  P.prop('funnel', { x: 0, z: (cz0 + cz1) / 2, y: yD + 14, h: 10, r: 2.6 });
  const eng = P.room({ id: 'engine', kind: 'engine', name: 'Engine room', x0: -cw / 2 - 2, x1: cw / 2 + 2, z0: cz0 - 6, z1: tz1, y: yE, h: r2(yD - yE - 0.12), floor: 'grating', wall: 'dark', dark: true });
  P.stair({ id: 'flight-engine', x0: casing.x0 + 0.06, x1: casing.x0 + CW - 0.04, z0: tz0 + LAND, z1: tz1 - LAND, yLow: yE, yHigh: yD, up: 'n', foot: 'engine', head: 'casing', kind: 'steep' });
  engineRoom(P, eng, { consoleAt: { x: casing.x0 + 2 * CW + 1.6, z: eng.z1 - 0.45, rotY: Math.PI }, scale: 1.4 });
  P.sign(casing.x1 - 0.06, yD + 1.75, tz0 + LAND * 0.6, -Math.PI / 2, ['ENGINE CASING', '▼ engine room']);
  P.levels.push({ y: yE, name: 'Engine room', kind: 'engine' });
  void sideP; void sideS;
}

/** Hatches, container bays, pipe racks, trawl gear, towing gear on the open deck. */
function planCargo(P, S, { hz0, hz1, hw, fcsle }) {
  const { L, B, deckY: yD } = P;
  const fwdEnd = (fcsle ? fcsle.z1 + 4.0 : -L / 2 + (S.cargoFrom || 0.12) * L);
  // a stair up onto the forecastle, on the centreline just aft of it
  if (fcsle) {
    const run = r2(2.4 / tanD(45));
    const fdeck = P.rooms.filter((r) => r.id.startsWith('deck-fwd'));
    const foot = fdeck.find((r) => r.z0 <= fcsle.z1 + run + 0.6 && r.z1 >= fcsle.z1 + run + 0.6) || fdeck[0];
    const head = P.rooms.filter((r) => r.id.startsWith('fcsle')).sort((a, b) => b.z1 - a.z1)[0];
    P.stair({ id: 'fcsle-stair', x0: -0.6, x1: 0.6, z0: fcsle.z1, z1: fcsle.z1 + run, yLow: yD, yHigh: fcsle.y, up: 'n', foot: foot.id, head: head.id, kind: 'outdoor' });
    P.rail([[-0.65, fcsle.z1], [-P.hb(fcsle.z1) + 0.3, fcsle.z1]], fcsle.y); P.rail([[0.65, fcsle.z1], [P.hb(fcsle.z1) - 0.3, fcsle.z1]], fcsle.y);
    // windlass + mast on the forecastle
    const fl = fcsle.z1 - fcsle.z0, wz = fcsle.z0 + fl * 0.62, mz = fcsle.z0 + Math.max(0.7, fl * 0.12);
    const ww = Math.min(1.6, B * 0.09, P.hb(wz - 0.7) - EDGE - RAIL_IN - R - 0.85);
    if (ww > 0.4) { P.prop('winch', { x: 0, z: wz, y: fcsle.y, w: ww * 2 }); P.solid(-ww - 0.2, ww + 0.2, wz - 0.7, wz + 0.7, fcsle.y, 1.3, 'windlass'); }
    P.prop('mast', { x: 0, z: mz, y: fcsle.y, h: 10, r: 0.25 }); P.solid(-0.35, 0.35, mz - 0.35, mz + 0.35, fcsle.y, 10, 'mast');
  } else if (!S.small && !S.style && !S.ferry && !S.aftCargo) {
    const mz = -L / 2 + Math.max(5, L * 0.06);
    P.prop('mast', { x: 0, z: mz, y: yD, h: 8, r: 0.2 }); P.solid(-0.3, 0.3, mz - 0.3, mz + 0.3, yD, 8, 'mast');
  }
  const bollards = (zs, y = yD) => { for (const z of zs) for (const side of [-1, 1]) { const x = side * (P.hb(z) - EDGE - 0.05); P.prop('bollard', { x, z, y }); } };
  if (S.cargo === 'hatches') {
    const z0 = fwdEnd, z1 = hz0 - 3, n = S.nHatch, hl = (z1 - z0) / n;
    for (let i = 0; i < n; i++) {
      const a = z0 + hl * i + hl * 0.1, b = z0 + hl * (i + 1) - hl * 0.1;
      const w = Math.min(S.hatchW * B, 2 * (P.minHb(a - 3, b + 3) - EDGE - 1.2));
      if (w < 2) continue;
      P.prop('hatch', { x0: -w / 2, x1: w / 2, z0: a, z1: b, y: yD, h: P.cls === 'bulker' ? 2.3 : 1.7 });
      P.solid(-w / 2, w / 2, a, b, yD, P.cls === 'bulker' ? 2.3 : 1.7, 'hatch');
    }
  } else if (S.cargo === 'boxes') {
    const segs = [[fwdEnd, hz0 - 2]];
    if (P.cls === 'boxship') { const c = S.casing; const cz0 = c.c * L - (c.l * L) / 2 - 2.5, cz1 = cz0 + c.l * L + 5; segs.push([hz1 + 2, cz0], [cz1, L / 2 - L * 0.06]); }
    for (const [a, b] of segs) {
      if (b - a < 6) continue;
      const nb = Math.max(1, Math.floor((b - a) / 12.6));
      for (let i = 0; i < nb; i++) {
        const za = a + i * ((b - a) / nb) + 0.2, zb = a + (i + 1) * ((b - a) / nb) - 0.2;
        const w = Math.floor(Math.min(S.rowsW * B, 2 * (P.minHb(za - 6, zb + 6) - EDGE - 1.2)) / 2.6) * 2.6;
        if (w < 2.6) continue;
        const tiers = 2 + ((i * 7 + Math.round(a)) % 4);
        P.prop('boxes', { x0: -w / 2, x1: w / 2, z0: za, z1: zb, y: yD, tiers, seed: i + Math.round(a) });
        P.solid(-w / 2, w / 2, za, zb, yD, tiers * 2.6 + 1, 'containers');
      }
    }
  } else if (S.cargo === 'pipes') {
    const z0 = fwdEnd, z1 = hz0 - 1.5, w = Math.min(0.48 * B, 2 * (P.minHb(z0 - 3, z1) - EDGE - 1.5));
    P.prop('piperack', { x0: -w / 2, x1: w / 2, z0, z1, y: yD });
    P.solid(-w / 2, w / 2, z0, z1, yD, 1.3, 'pipes');
    const mz = (z0 + z1) / 2;
    for (const side of [-1, 1]) { P.prop('manifold', { x: side * (w / 2 + 1.2), z: mz, y: yD }); P.solid(side * (w / 2) - 0.1, side * (w / 2 + 2.0), mz - 2.5, mz + 2.5, yD, 1.6, 'manifold'); }
  }
  if (S.aftCargo) { // PSV: open cargo deck aft of the house
    const z0 = hz1 + 3, z1 = L / 2 - 3;
    let i = 0;
    for (let z = z0; z < z1 - 6.2; z += 8, i++) {
      const x = (i % 2 ? 1 : -1) * B * 0.17;
      P.prop('boxes', { x0: x - 1.25, x1: x + 1.25, z0: z, z1: z + 6.1, y: yD, tiers: 1, seed: i });
      P.solid(x - 1.25, x + 1.25, z, z + 6.1, yD, 2.7, 'container');
    }
  }
  if (S.aft === 'trawl') { // net drum, A-frame gantry legs, fish hatch
    const gz = L / 2 - 5, dz = gz - 8;
    P.prop('drum', { x: 0, z: dz, y: yD, len: B * 0.5, r: 1.3 }); P.solid(-B * 0.25, B * 0.25, dz - 1.3, dz + 1.3, yD, 2.8, 'netdrum');
    P.prop('gantry', { z: gz, y: yD, w: B * 0.76, h: 8 });
    for (const side of [-1, 1]) P.solid(side * B * 0.38 - 0.35, side * B * 0.38 + 0.35, gz - 0.35, gz + 0.35, yD, 8, 'gantry');
    const fz = (hz1 + dz - 1.3) / 2;
    if (dz - 1.3 - hz1 > 3) { P.prop('hatch', { x0: -B * 0.15, x1: B * 0.15, z0: fz - 0.8, z1: fz + 0.8, y: yD, h: 0.5 }); P.solid(-B * 0.15, B * 0.15, fz - 0.8, fz + 0.8, yD, 0.5, 'fishhatch'); }
  }
  if (S.aft === 'tow') {
    const wz = L / 2 - L * 0.28, hz = L / 2 - L * 0.16;
    P.prop('winch', { x: 0, z: wz, y: yD, w: 3.6 }); P.solid(-1.9, 1.9, wz - 0.8, wz + 0.8, yD, 1.5, 'towwinch');
    P.prop('towhook', { x: 0, z: hz, y: yD }); P.solid(-0.6, 0.6, hz - 0.6, hz + 0.6, yD, 1.8, 'towhook');
  }
  if (!S.ferry) bollards([-L / 2 + Math.max(4, L * 0.05), L / 2 - Math.max(2.5, L * 0.04)], yD);
  void hw;
}

// ------------------------------------------------------------------------------------------------ small motor craft
// pilot (wheelhouse on deck), cruiser (open cockpit), myacht (saloon + flybridge): cabin and engine bay below.
function planMotor(P) {
  P.edge = YACHT_EDGE; P.railInset = YACHT_RAIL; // lifelines at the toerail: side decks you can actually walk
  const { cls, L, B, deckY: yD } = P;
  const yC = r2(Math.max(0.75, yD - 2.25)), hC = r2(yD - yC - 0.12);
  P.style = cls === 'pilot' ? 'ship' : 'yacht';
  const below = (id, kind, name, z0, z1, o = {}) => {
    const half = P.minHb(z0, z1) - HULL_IN;
    return P.room({ id, kind, name, x0: o.x0 ?? -half, x1: o.x1 ?? half, z0, z1, y: yC, h: hC, floor: kind === 'engine' ? 'grating' : P.style === 'yacht' ? 'wood' : 'lino', wall: kind === 'engine' ? 'dark' : P.style === 'yacht' ? 'wood' : 'white', dark: kind === 'engine', ...o });
  };
  const zb = bowZWhere(P.half, L, 0.55 + EDGE);
  const zf = bowZWhere(P.half, L, 0.42 + EDGE); // the foredeck reaches further forward than the cabins below it
  if (cls === 'pilot' || cls === 'myacht') {
    // ---- enclosed wheelhouse / saloon on deck
    const pilot = cls === 'pilot';
    const wz0 = pilot ? -0.155 * L : -0.083 * L, wz1 = pilot ? 0.145 * L : 0.25 * L;
    const side = pilot ? 0.8 : 0.62;
    const hw = r2(Math.min(B * 0.7, 2 * (P.minHb(wz0, wz1) - EDGE - side)));
    const X0 = -hw / 2, X1 = hw / 2, hW = 2.25;
    const helmD = pilot ? wz1 - wz0 : Math.min(3.2, (wz1 - wz0) * 0.4);
    const wh = P.room({ id: 'bridge', kind: 'bridge', name: pilot ? 'Wheelhouse' : 'Lower helm station', x0: X0, x1: X1, z0: wz0, z1: wz0 + helmD, y: yD, h: hW, floor: pilot ? 'lino' : 'wood', wall: pilot ? 'white' : 'wood' });
    P.window(wh, 'n', X0 + 0.2, X1 - 0.2, 0.95, 2.05); P.window(wh, 'e', wz0 + 0.3, wh.z1 - 1.4, 1.0, 2.0); P.window(wh, 'w', wz0 + 0.3, wh.z1 - 1.4, 1.0, 2.0);
    let saloon = null;
    if (!pilot) {
      saloon = P.room({ id: 'saloon', kind: 'mess', name: 'Saloon & galley', x0: X0, x1: X1, z0: wh.z1, z1: wz1, y: yD, h: hW, floor: 'wood', wall: 'wood' });
      P.opening(wh, saloon, 's', 0.35, hw - 1.6);
      P.window(saloon, 'e', saloon.z0 + 0.4, saloon.z1 - 0.6, 1.0, 1.9); P.window(saloon, 'w', saloon.z0 + 0.4, saloon.z1 - 0.6, 1.0, 1.9);
      counter(P, X1 - 0.65, X1 - 0.08, saloon.z0 + 0.5, saloon.z0 + 2.2, yD, 'galley');
      table(P, X0 + 0.95, yD, saloon.z0 + (saloon.z1 - saloon.z0) * 0.62, 0.8, 1.3, false);
      P.prop('sofa', { x0: X0 + 0.08, x1: X0 + 0.5, z0: saloon.z0 + 1.2, z1: saloon.z1 - 0.5, y: yD }); P.solid(X0 + 0.08, X0 + 0.5, saloon.z0 + 1.2, saloon.z1 - 0.5, yD, 0.8, 'sofa');
    }
    // helm console on the starboard side, stairs down on the port side of the wheelhouse
    helmConsole(P, X1 - (hw - 1.15) / 2 - 0.05, yD, wz0 + 0.6, hw - 1.25, 0.7);
    P.helm.z = wz0 + 1.6; P.hotspots[P.hotspots.length - 1].z = wz0 + 1.6;
    radio(P, X0 + 0.5, yD, wz0 + 0.25, 0);
    const run = r2((yD - yC) / tanD(52)), sx0 = X0 + 0.08, sx1 = X0 + 0.9;
    const sz0 = wz0 + 0.45, sz1 = sz0 + run;
    P.spawn = { x: X1 - 0.8, y: yD, z: wz0 + 1.9, yaw: 0 };
    // ---- below: forepeak cabin, passage (stair foot), mess, engine room
    const pz0 = sz0 - 1.3, pz1 = sz1 + 0.5;
    const cab = below('cabin-fwd', 'cabin', pilot ? 'Crew cabin' : 'Owner\'s cabin', Math.max(zb + 0.4, pz0 - (pilot ? 3.2 : 3.6)), pz0);
    const pass = below('passage', 'passage', 'Passage', pz0, pz1);
    P.stair({ id: 'companionway', x0: sx0, x1: sx1, z0: sz0, z1: sz1, yLow: yC, yHigh: yD, up: 's', foot: 'passage', head: 'bridge', kind: 'steep' });
    P.door(cab, pass, 's', (Math.max(cab.x0, pass.x0) + Math.min(cab.x1, pass.x1)) / 2 + 0.3, 0.8, 1.95);
    bunk(P, (cab.x0 + cab.x1) / 2, yC, cab.z0 + 0.7, 'x', Math.min(1.9, cab.x1 - cab.x0 - 0.2), pilot ? 2 : 1);
    let mz0 = pz1;
    if (!pilot) { // guest cabins either side of a short corridor
      const cz1 = mz0 + 3.4;
      const cor = below('passage-aft', 'passage', 'Corridor', mz0, cz1, { x0: -0.55, x1: 0.55 });
      P.opening(pass, cor, 's', 0, 0.9);
      const half = P.minHb(mz0, cz1) - HULL_IN;
      const gp = below('cabin-port', 'cabin', 'Guest cabin', mz0, cz1, { x0: -half, x1: -0.55 });
      const gs = below('cabin-stbd', 'cabin', 'Guest cabin', mz0, cz1, { x0: 0.55, x1: half });
      P.door(gp, cor, 'e', (mz0 + cz1) / 2 + 0.6, 0.75, 1.95); P.door(gs, cor, 'w', (mz0 + cz1) / 2 + 0.6, 0.75, 1.95);
      bunk(P, gp.x0 + 0.5, yC, mz0 + 1.1, 'z', 1.9, 1); bunk(P, gs.x1 - 0.5, yC, mz0 + 1.1, 'z', 1.9, 1);
      const eng = below('engine', 'engine', 'Engine room', cz1, Math.min(L / 2 - 1.6, cz1 + 5));
      P.door(eng, cor, 'n', 0, 0.8, 1.9, 'watertight');
      engineRoom(P, eng, { twin: true, consoleAt: { x: eng.x1 - 0.06, z: eng.z0 + 1.5, rotY: -Math.PI / 2, wall: true } });
    } else {
      const mess = below('mess', 'mess', 'Crew mess & galley', mz0, mz0 + 3.2);
      P.door(pass, mess, 's', 0, 1.0, 1.95);
      counter(P, mess.x0 + 0.1, mess.x0 + 0.7, mess.z0 + 0.3, mess.z1 - 0.4, yC, 'galley');
      table(P, mess.x1 - 1.0, yC, (mess.z0 + mess.z1) / 2, 0.7, 1.1, false);
      const eng = below('engine', 'engine', 'Engine room', mess.z1, Math.min(L / 2 - 1.4, mess.z1 + 4.4));
      P.door(eng, mess, 'n', -0.2, 0.8, 1.9, 'watertight');
      engineRoom(P, eng, { twin: true, consoleAt: { x: eng.x1 - 0.06, z: eng.z0 + 1.4, rotY: -Math.PI / 2, wall: true } });
    }
    // ---- open deck: foredeck, side decks, aft deck; doors from the deckhouse
    const sw = P.minHb(wz0, wz1) - P.edge;
    const sP = P.room({ id: 'deck-port', kind: 'deck', name: 'Side deck (port)', open: true, x0: -sw, x1: X0, z0: wz0 - 0.8, z1: wz1 + 0.8, y: yD, floor: 'deck', drawFloor: false, inset: { w: RAIL_IN, e: R, n: 0, s: 0 } });
    const sS = P.room({ id: 'deck-stbd', kind: 'deck', name: 'Side deck (starboard)', open: true, x0: X1, x1: sw, z0: wz0 - 0.8, z1: wz1 + 0.8, y: yD, floor: 'deck', drawFloor: false, inset: { e: RAIL_IN, w: R, n: 0, s: 0 } });
    P.deckStrips('deck-fwd', zf, wz0, yD, { name: 'Foredeck', len: 4, endS: R });
    const aft = P.deckStrips('deck-aft', wz1, L / 2 - 0.5, yD, { name: pilot ? 'Aft deck' : 'Aft deck (cockpit)', len: 6, endN: R });
    const aftRoom = pilot ? wh : saloon;
    P.door(aftRoom, aft[0], 's', 0, 1.0, 2.0, 'ext');
    if (pilot) P.door(wh, sS, 'e', wz1 - 1.0, 0.8, 1.95, 'ext');
    void sP;
    if (!pilot) { // flybridge on the saloon roof, a ladder-stair up from the aft deck lands on its aft edge
      const fy = r2(yD + hW + 0.25), fz0 = wz0 + 0.6, fz1 = wz1 + 0.3;
      P.room({ id: 'flybridge', kind: 'deck', name: 'Flybridge', open: true, x0: X0, x1: X1, z0: fz0, z1: fz1, y: fy, floor: 'deck', drawFloor: true, inset: { n: RAIL_IN, s: RAIL_IN, e: RAIL_IN, w: RAIL_IN } });
      const frun = r2((fy - yD) / tanD(52)), fsx0 = X1 - 0.95, fsx1 = X1 - 0.12;
      const footRoom = aft.find((r) => r.z0 <= fz1 + frun + 0.3 && r.z1 >= fz1 + frun + 0.3) || aft[0];
      P.stair({ id: 'fly-stair', x0: fsx0, x1: fsx1, z0: fz1, z1: fz1 + frun, yLow: yD, yHigh: fy, up: 'n', foot: footRoom.id, head: 'flybridge', kind: 'outdoor' });
      P.prop('helm', { x: -0.2, y: fy, z: fz0 + 0.7, w: 1.4, facing: -1, upper: true }); P.solid(-0.9, 0.5, fz0 + 0.3, fz0 + 1.1, fy, 1.2, 'console');
      P.prop('sofa', { x0: X0 + 0.1, x1: X0 + 0.55, z0: fz0 + 2.2, z1: fz1 - 1.0, y: fy }); P.solid(X0 + 0.1, X0 + 0.55, fz0 + 2.2, fz1 - 1.0, fy, 0.7, 'sofa');
      P.rail([[fsx0, fz1], [X0, fz1], [X0, fz0], [X1, fz0], [X1, fz1]], fy);
    }
    P.hullRails(zf - 0.5, L / 2 - 0.25, yD);
    P.levels = [{ y: yC, name: 'Lower deck', kind: 'below' }, { y: yD, name: 'Main deck', kind: 'main' }];
    return;
  }
  // ---- cruiser: open cockpit with the helm, companionway down to the saloon, V-berth forward, engine bay aft
  const cz0 = 0.05 * L, cz1 = L / 2 - 1.25;
  const ck = P.deckStrips('cockpit', cz0, cz1, yD, { name: 'Cockpit & helm', len: 2.0, endN: 0, endS: R });
  for (const r of ck) { r.kind = 'bridge'; r.floor = 'teak'; }
  P.prop('helm', { x: 0.95, y: yD, z: cz0 + 0.45, w: 0.8, facing: -1, windscreen: true });
  P.solid(0.55, 1.35, cz0 + 0.05, cz0 + 0.85, yD, 1.2, 'console');
  P.hot('helm', 'Take the helm', 0.95, yD, cz0 + 1.45, 1.4); P.helm = { x: 0.95, y: yD, z: cz0 + 1.45 };
  const ckW = P.minHb(cz0, cz0 + 1) - EDGE;
  P.prop('windscreen', { x0: -ckW + 0.1, x1: ckW - 0.1, z: cz0 - 0.05, y: yD, gap: [-0.42, 0.42] });
  const bz1 = cz1 + 0.65, bw = P.minHb(cz1, bz1) - EDGE - 0.1;
  P.prop('sofa', { x0: -bw, x1: bw, z0: cz1 + 0.02, z1: bz1, y: yD });
  P.spawn = { x: 0.6, y: yD, z: cz0 + 1.9, yaw: 0 };
  const run = r2((yD - yC) / tanD(56));
  P.stair({ id: 'companionway', x0: -0.38, x1: 0.38, z0: cz0 - run, z1: cz0, yLow: yC, yHigh: yD, up: 's', foot: 'saloon', head: ck[0].id, kind: 'steep' });
  P.deckStrips('deck-fwd', zf, cz0, yD, { name: 'Foredeck', len: 2.5, endS: 0 });
  P.prop('sunpad', { x0: -0.55, x1: 0.55, z0: cz0 - run - 1.9, z1: cz0 - run - 0.7, y: yD, flat: true }); // a cushion you can walk on
  const sal = below('saloon', 'mess', 'Saloon & galley', cz0 - run - 1.6, cz0 + 0.4);
  const cab = below('cabin-fwd', 'cabin', 'Forward cabin (V-berth)', Math.max(bowZWhere(P.half, L, 0.75), sal.z0 - 2.0), sal.z0);
  P.door(cab, sal, 's', 0, Math.min(0.75, cab.x1 - cab.x0 - 0.15), 1.9);
  vberth(P, cab);
  counter(P, sal.x0 + 0.05, sal.x0 + 0.5, sal.z0 + 0.2, sal.z0 + 1.2, yC, 'galley');
  const pass = below('passage', 'passage', 'Passage', sal.z1, sal.z1 + 1.4);
  P.door(sal, pass, 's', 0.62, 0.75, 1.9);
  const eng = below('engine', 'engine', 'Engine bay', pass.z1, Math.min(L / 2 - 0.9, pass.z1 + 3.0));
  P.door(eng, pass, 'n', 0.4, 0.75, 1.85, 'watertight');
  engineRoom(P, eng, { side: -1, consoleAt: { x: eng.x1 - 0.06, z: eng.z0 + 1.2, rotY: -Math.PI / 2, wall: true } });
  P.hullRails(zf - 0.5, L / 2 - 0.25, yD);
  P.levels = [{ y: yC, name: 'Cabin', kind: 'below' }, { y: yD, name: 'Deck', kind: 'main' }];

}

// ------------------------------------------------------------------------------------------------ sailing yachts
/** Yacht deck layout from the model (yachtlooks.js) and the rig (shared/sail/rigs.js): masts, cockpit, wheel, coachroof /
 *  doghouse, the schooner's forward house — so the walker, the rig and the hull agree (§4.5). Fractions of L as before. */
function sailLayout(cls) {
  const R = rigOf(cls), L = R.loa, st = yachtStructures(cls), D = yachtDeckOf(cls);
  const find = (k) => st.find((s) => s.kind === k);
  const ck = find('cockpit'), helm = find('helm');
  const house = cls === 'schooner' ? find('doghouse') : find('coachroof'), dog = cls === 'ketch' ? find('doghouse') : null;
  return {
    masts: R.spars.masts.map((m) => ({ z: m.z, r: m.d0 / 2, h: (m.topmast || m.top) - D.deckY })),
    cockpit: [ck.z0 / L, Math.max(helm ? helm.z1 : ck.z1, R.spars.wheel.at[2] + 1.4) / L], wheel: R.spars.wheel.at[2] / L,   // the helmsman stands aft of the wheel
    roof: [house.z0 / L, (dog ? dog.z1 : house.z1) / L], roofH: Math.max(0.45, (dog ? dog.top : house.top) - D.deckY - 0.05),
    doghouse: cls === 'schooner',
    houses: cls === 'schooner' ? st.filter((s) => s.kind === 'house') : [],   // (the windlass stays a model detail: the foredeck is narrow there)
  };
}
const SAIL = { sloop: sailLayout('sloop'), ketch: sailLayout('ketch'), schooner: sailLayout('schooner') };
function planSail(P) {
  const { cls, L, B, deckY: yD } = P;
  P.edge = YACHT_EDGE; P.railInset = YACHT_RAIL; // lifelines at the toerail: side decks you can actually walk
  const S = SAIL[cls];
  P.style = 'yacht';
  const yC = r2(yD - 2.05), hC = r2(yD - yC - 0.12);   // §4.5: real yacht freeboard → cabin soles below the waterline (1.9 m headroom)
  const below = (id, kind, name, z0, z1, o = {}) => {
    const half = P.minHb(z0, z1) - HULL_IN;
    return P.room({ id, kind, name, x0: o.x0 ?? -half, x1: o.x1 ?? half, z0, z1, y: yC, h: hC, floor: kind === 'engine' ? 'grating' : 'wood', wall: kind === 'engine' ? 'dark' : 'wood', dark: kind === 'engine', ...o });
  };
  const zb = bowZWhere(P.half, L, 0.5 + EDGE);
  const zf = bowZWhere(P.half, L, 0.42 + EDGE); // the foredeck reaches further forward than the cabins below it
  const cz0 = S.cockpit[0] * L, cz1 = Math.min(S.cockpit[1] * L, sternZWhere(P.half, L, 0.65 + EDGE));
  const big = !!S.doghouse;
  // cockpit (helm) — open, in strips so it follows the narrowing stern
  const ck = P.deckStrips('cockpit', cz0, cz1, yD, { name: 'Cockpit', len: 2.0, endN: 0, endS: RAIL_IN });
  for (const r of ck) r.kind = 'bridge';
  const wz = S.wheel * L;
  P.prop('wheel', { x: 0, z: wz, y: yD, r: clamp(B * 0.16, 0.45, 0.9) }); P.solid(-0.22, 0.22, wz - 0.22, wz + 0.22, yD, 1.1, 'pedestal');
  const hz = Math.min(wz + 0.7, cz1 - 0.55);                   // the sloop's open transom: the helmsman stands just aft of the wheel
  P.hot('helm', 'Take the helm', 0, yD, hz, 1.4); P.helm = { x: 0, y: yD, z: hz };
  P.spawn = { x: 0.6, y: yD, z: wz - 1.2, yaw: 0 };
  for (const m of S.masts) { const z = m.z, r = m.r + 0.15; P.prop('mast', { x: 0, z, y: yD, h: m.h, r: m.r, sail: true, real: true }); P.solid(-r, r, z - r, z + r, yD, 12, 'mast'); }
  for (const h of S.houses) { P.solid(-h.half, h.half, h.z0, h.z1, yD, Math.max(0.5, h.top - yD), h.id); if (h.kind === 'house') P.prop('coachroof', { x0: -h.half, x1: h.half, z0: h.z0, z1: h.z1, y: yD, h: h.top - yD }); }
  // deck around the coachroof: foredeck + side decks
  P.deckStrips('deck', zf, cz0, yD, { name: 'Deck', len: big ? 4 : 2.5, endS: 0 });
  const rz1 = S.roof[1] * L, rwMin = 0.5, sideNeed = EDGE + RAIL_IN + R + 0.3;
  const rz0 = Math.min(rz1 - 2, Math.max(S.roof[0] * L, bowZWhere(P.half, L, rwMin + sideNeed)));
  const rw = Math.max(rwMin, Math.min(B * 0.3, P.minHb(rz0, rz1) - sideNeed));
  // companionway: aft end of the coachroof (or inside the doghouse), steep steps down forward
  const run = r2((yD - yC) / tanD(big ? 50 : 60)), sw = big ? 0.9 : 0.8;
  let head = ck[0].id, sz1 = cz0, sz0 = cz0 - run;
  if (big) { // schooner: walk-in doghouse with the stairs inside
    const dh = P.room({ id: 'doghouse', kind: 'stairs', name: 'Doghouse', x0: -rw, x1: rw, z0: rz0, z1: rz1, y: yD, h: 2.1, floor: 'wood', wall: 'wood' });
    P.window(dh, 'e', rz0 + 0.5, rz1 - 0.6, 1.0, 1.7); P.window(dh, 'w', rz0 + 0.5, rz1 - 0.6, 1.0, 1.7); P.window(dh, 'n', -rw + 0.4, rw - 0.4, 1.0, 1.7);
    const host = P.rooms.find((r) => r.id.startsWith('deck-') && r.z0 <= rz1 + 0.3 && r.z1 >= rz1 + 0.3) || ck[0];
    P.door(dh, host, 's', rw - 0.7, 0.9, 1.95, 'ext');
    sz1 = rz1 - 0.9; sz0 = sz1 - run; head = 'doghouse';
    P.stair({ id: 'companionway', x0: -0.45, x1: 0.45, z0: sz0, z1: sz1, yLow: yC, yHigh: yD, up: 's', foot: 'saloon', head, kind: 'steep' });
    chartTable(P, -rw + 0.5, yD, rz0 + 0.6, 0.8, 0.6);
  } else {
    P.stair({ id: 'companionway', x0: -sw / 2, x1: sw / 2, z0: sz0, z1: sz1, yLow: yC, yHigh: yD, up: 's', foot: 'galley', head, kind: 'steep' });
    // coachroof: solid either side of the companionway hatch and forward of it
    // coachroof: the companionway hatch is cut into its aft end (the deck's stair hole already keeps walkers off it)
    const g = sw / 2 + R;
    P.prop('coachroof', { x0: -rw, x1: rw, z0: rz0, z1: rz1, y: yD, h: S.roofH, hatch: { x0: -sw / 2, x1: sw / 2, z0: sz0, z1: rz1 } });
    if (rw > g + 0.05) { P.solid(-rw, -g, rz0, rz1, yD, S.roofH, 'coachroof'); P.solid(g, rw, rz0, rz1, yD, S.roofH, 'coachroof'); }
    P.solid(-rw, rw, rz0, sz0 - R - 0.05, yD, S.roofH, 'coachroof');
  }
  // ---- below decks
  let fwdOfStair;
  if (big) {
    const sal = below('saloon', 'mess', 'Saloon & galley', sz0 - 3.6, sz1 + 1.2);
    counter(P, sal.x1 - 0.65, sal.x1 - 0.06, sal.z0 + 0.4, sal.z0 + 2.4, yC, 'galley');
    table(P, sal.x0 + 1.4, yC, sal.z0 + 1.6, 0.9, 1.6, false);
    const pass = below('passage', 'passage', 'Passage', Math.max(zb + 2.6, sal.z0 - 7), sal.z0, { x0: -0.6, x1: 0.6 });
    P.opening(pass, sal, 's', 0, 1.0);
    const n = Math.max(1, Math.floor((pass.z1 - pass.z0) / 2.6));
    for (let i = 0; i < n; i++) {
      const z0 = pass.z0 + ((pass.z1 - pass.z0) * i) / n, z1 = pass.z0 + ((pass.z1 - pass.z0) * (i + 1)) / n, half = P.minHb(z0, z1) - HULL_IN;
      for (const side of [-1, 1]) {
        const c = below(`cabin-${side < 0 ? 'p' : 's'}${i}`, 'cabin', 'Guest cabin', z0, z1, { x0: side < 0 ? -half : 0.6, x1: side < 0 ? -0.6 : half });
        P.door(c, pass, side < 0 ? 'e' : 'w', (z0 + z1) / 2 + 0.5, 0.75, 1.95);
        furnishCabin(P, c, side < 0 ? 'e' : 'w');
      }
    }
    const fc = below('cabin-crew', 'cabin', 'Crew cabin', Math.max(zb + 0.4, pass.z0 - 2.6), pass.z0);
    P.door(fc, pass, 's', 0, 0.75, 1.9);
    bunk(P, (fc.x0 + fc.x1) / 2, yC, fc.z0 + 0.6, 'x', Math.min(1.9, fc.x1 - fc.x0 - 0.2), 2);
    const eng = below('engine', 'engine', 'Engine room', sal.z1, Math.min(sal.z1 + 4.5, sternZWhere(P.half, L, 1.2)));
    P.door(eng, sal, 'n', Math.min(sal.x1, eng.x1) - 0.65, 0.8, 1.9, 'watertight');
    engineRoom(P, eng, { consoleAt: { x: eng.x0 + 0.85, z: eng.z0 + 0.45, rotY: 0 } });
    fwdOfStair = sal;
  } else {
    // galley at the foot of the companionway, saloon forward, V-berth in the bow (if there is room), engine bay
    // and aft cabin side by side under the cockpit
    const galley = below('galley', 'passage', 'Companionway & galley', sz0 - 0.65, sz1 + 0.1);
    const din = below('saloon', 'mess', 'Saloon', Math.max(bowZWhere(P.half, L, 1.05), galley.z0 - 2.6), galley.z0);
    P.opening(din, galley, 's', 0, Math.min(din.x1 - din.x0, galley.x1 - galley.x0) - 0.3);
    counter(P, din.x1 - 0.5, din.x1 - 0.05, din.z0 + 0.2, din.z1 - 0.25, yC, 'galley');
    radio(P, galley.x1 - 0.08, yC, galley.z0 + 0.5, -Math.PI / 2);
    P.prop('sofa', { x0: din.x0 + 0.05, x1: din.x0 + 0.42, z0: din.z0 + 0.2, z1: din.z1 - 0.3, y: yC });
    P.prop('table', { x: din.x0 + 0.62, y: yC, z: (din.z0 + din.z1) / 2, w: 0.35, d: 0.8, benches: false, fold: true });
    const vbz0 = Math.max(bowZWhere(P.half, L, 0.85), din.z0 - 1.9);
    if (din.z0 - vbz0 >= 1.4) {
      const vb = below('cabin-fwd', 'cabin', 'Forward cabin (V-berth)', vbz0, din.z0);
      P.door(vb, din, 's', 0, Math.min(0.75, vb.x1 - vb.x0 - 0.15), 1.85);
      vberth(P, vb);
    }
    const az1 = Math.min(galley.z1 + 2.3, sternZWhere(P.half, L, 1.1));
    const half = P.minHb(galley.z1, az1) - HULL_IN;
    const eng = below('engine', 'engine', 'Engine bay', galley.z1, az1 - 0.3, { x0: -0.02, x1: half });
    const ac = below('cabin-aft', 'cabin', 'Aft cabin', galley.z1, az1, { x0: -half, x1: -0.02 });
    const dx = Math.min(sw / 2 + R + 0.15, half - 0.4);
    P.door(eng, galley, 'n', dx, 0.72, 1.85, 'watertight');
    P.door(ac, galley, 'n', -dx, 0.72, 1.85);
    engineRoom(P, eng, { doorSide: 'n', consoleAt: { x: eng.x0 + 0.06, z: eng.z0 + 0.55, rotY: Math.PI / 2, wall: true } });
    { const len = Math.min(1.9, ac.z1 - ac.z0 - 1.0); bunk(P, ac.x0 + 0.5, yC, ac.z1 - 0.1 - len / 2, 'z', len, 1); }
    fwdOfStair = galley;
  }
  void fwdOfStair;
  P.hullRails(zf - 0.5, L / 2 - 0.25, yD);
  P.levels = [{ y: yC, name: 'Below decks', kind: 'below' }, { y: yD, name: 'Deck', kind: 'main' }];
}

// ------------------------------------------------------------------------------------------------ catamaran
function planCat(P) {
  const { L, B, deckY: yD } = P;
  P.style = 'yacht';
  const hx = B * 0.4, hb = B * 0.1;           // hull centre offset and hull half-beam (ship.js: yachtShape(L, B * 0.2))
  const hull = deckOutlineHalf('catamaran', 40);              // one hull of the lofted model (yachtlooks.js), centred at x = 0
  const hullHalf = (z0, z1) => minHalf(hull, Math.min(z0, z1), Math.max(z0, z1));
  P.half = hull;
  const px = B * 0.42, pz0 = L * 0.08 - L * 0.3, pz1 = L * 0.08 + L * 0.3;
  P.deck.polys = [[[-px, pz0], [px, pz0], [px, pz1], [-px, pz1]], fullOutline(hull, -hx), fullOutline(hull, hx)];
  const yC = r2(yD - 2.05), hC = r2(yD - yC - 0.12);   // §4.5: hull soles just above the canoe bottom (bridge deck 1.9 → −0.1)
  // saloon on the bridge deck, nav station at its front
  const sz0 = L * 0.02 - L * 0.17, sz1 = L * 0.02 + L * 0.17, sw = hx + 0.3;
  const nav = P.room({ id: 'bridge', kind: 'bridge', name: 'Nav station & helm', x0: -sw, x1: sw, z0: sz0, z1: sz0 + 2.0, y: yD, h: 2.0, floor: 'wood', wall: 'wood' });
  const sal = P.room({ id: 'saloon', kind: 'mess', name: 'Saloon & galley', x0: -sw, x1: sw, z0: sz0 + 2.0, z1: sz1, y: yD, h: 2.0, floor: 'wood', wall: 'wood' });
  P.opening(nav, sal, 's', 0, 2.2);
  P.window(nav, 'n', -sw + 0.3, sw - 0.3, 0.9, 1.8); P.window(sal, 'e', sal.z0 + 0.3, sal.z1 - 0.4, 0.9, 1.7); P.window(sal, 'w', sal.z0 + 0.3, sal.z1 - 0.4, 0.9, 1.7);
  helmConsole(P, 0, yD, sz0 + 0.45, 1.6, 0.6); P.helm.z = sz0 + 1.3; P.hotspots[P.hotspots.length - 1].z = sz0 + 1.3;
  P.spawn = { x: 0.3, y: yD, z: sz0 + 1.6, yaw: 0 };
  counter(P, 0.7, 1.9, sal.z1 - 0.65, sal.z1 - 0.1, yD, 'galley');
  table(P, -1.4, yD, sal.z1 - 0.8, 0.9, 0.7, false);
  // cockpit + side decks on the bridge deck, foredeck/trampoline forward
  const ck = P.room({ id: 'cockpit', kind: 'deck', name: 'Cockpit', open: true, x0: -px + 0.3, x1: px - 0.3, z0: sz1, z1: pz1 - 0.2, y: yD, floor: 'teak', drawFloor: false, inset: { n: R, s: RAIL_IN, e: RAIL_IN, w: RAIL_IN } });
  P.door(sal, ck, 's', 0, 1.2, 1.95, 'ext');
  const tr = P.room({ id: 'deck-fwd', kind: 'deck', name: 'Foredeck & trampoline', open: true, x0: -px + 0.3, x1: px - 0.3, z0: Math.max(-L / 2 + 2.2, pz0 - 3.2), z1: sz0, y: yD, floor: 'deck', drawFloor: false, inset: { n: RAIL_IN, s: R, e: RAIL_IN, w: RAIL_IN } });
  P.door(nav, tr, 'n', sw - 0.75, 0.8, 1.9, 'ext');
  P.prop('trampoline', { x0: -hx + hb, x1: hx - hb, z0: tr.z0, z1: pz0, y: yD });
  { const m = rigOf('catamaran').spars.masts[0], r = m.d0 / 2 + 0.15;   // the rig's mast on the bridge deck, 0.6 m ahead of the saloon (§4.5)
    P.prop('mast', { x: 0, z: m.z, y: yD, h: m.top - yD, r: m.d0 / 2, sail: true, real: true }); P.solid(-r, r, m.z - r, m.z + r, yD, 12, 'mast'); }
  P.rail([[-px, pz0], [-px, pz1]], yD); P.rail([[px, pz0], [px, pz1]], yD); P.rail([[-px, pz1], [px, pz1]], yD);
  // hulls: steps from the saloon's forward corners lead down aft into each hull — a corridor, then the engine room
  // (port) or the owner's cabin (starboard) at the after end
  const run = r2((yD - yC) / tanD(55)), hullIn = 0.12;
  const sz0h = sal.z0 + 0.9, sz1h = sz0h + run;
  const cz0 = sz0h - 0.3, cz1 = sz1h + 1.1, az1 = Math.min(cz1 + 2.4, L / 2 - 1.2);
  for (const side of [-1, 1]) {
    const tag = side < 0 ? 'port' : 'stbd', sx = side * hx;
    const hh = (z0, z1) => hullHalf(z0, z1) - hullIn;
    const corr = P.room({ id: `hull-${tag}`, kind: 'passage', name: `Hull corridor (${tag})`, x0: sx - hh(cz0, cz1), x1: sx + hh(cz0, cz1), z0: cz0, z1: cz1, y: yC, h: hC, floor: 'wood', wall: 'wood' });
    P.stair({ id: `hullstair-${tag}`, x0: sx - 0.42, x1: sx + 0.33, z0: sz0h, z1: sz1h, yLow: yC, yHigh: yD, up: 'n', foot: corr.id, head: 'saloon', kind: 'steep' });
    const eng = side < 0;
    const aftRoom = P.room({ id: eng ? 'engine' : 'cabin-aft', kind: eng ? 'engine' : 'cabin', name: eng ? 'Engine room (port hull)' : 'Owner\'s cabin', x0: sx - hh(cz1, az1), x1: sx + hh(cz1, az1), z0: cz1, z1: az1, y: yC, h: hC, floor: eng ? 'grating' : 'wood', wall: eng ? 'dark' : 'wood', dark: eng });
    P.door(aftRoom, corr, 'n', sx, Math.min(0.75, aftRoom.x1 - aftRoom.x0), 1.85, eng ? 'watertight' : 'door');
    if (eng) engineRoom(P, aftRoom, { doorSide: 'n', consoleAt: { x: aftRoom.x1 - 0.04, z: aftRoom.z0 + 0.55, rotY: -Math.PI / 2, wall: true } });
    else { const len = Math.min(1.9, az1 - cz1 - 1.05); P.prop('bunk', { x: sx, y: yC, z: az1 - 0.1 - len / 2, along: 'z', len, tiers: 1, w: aftRoom.x1 - aftRoom.x0 }); P.solid(aftRoom.x0, aftRoom.x1, az1 - 0.1 - len, az1, yC, 0.6, 'bunk'); P.hot('bunk', 'Rest in the berth', sx, yC, az1 - 0.1 - len / 2, 1.6); }
  }
  P.levels = [{ y: yC, name: 'Hulls', kind: 'below' }, { y: yD, name: 'Bridge deck', kind: 'main' }];
}

// ------------------------------------------------------------------------------------------------ entry point
const MOTOR = new Set(['pilot', 'cruiser', 'myacht']);
/**
 * Build the walkable plan for a ship class. C = SHIP_CLASSES[cls]; ud = the ship mesh's userData (length, beam,
 * freeboard, deckY) so the plan matches the model the player sees.
 */
export function buildPlan(cls, C, ud = {}, opts = {}) {
  // Lane C: catalogue models whose gen is GA-ready get the general-arrangement plan (same record as the exterior);
  // opts.deck picks the deck of a cruise ship / big ro-pax (one deck plus the stair landings of its neighbours)
  if (gaPlanned(cls)) { const p = planFromGA(cls, { deck: opts.deck || null }); if (p) return p; }
  const d = shipDims(C, ud);
  const P = new Plan(cls, C, d);
  if (HOUSE[cls]) planHouse(P, HOUSE[cls]);
  else if (MOTOR.has(cls)) planMotor(P);
  else if (cls === 'catamaran') planCat(P);
  else if (SAIL[cls]) planSail(P);
  else planHouse(P, HOUSE.coaster);
  return P.finish();
}
export const PLAN_CLASSES = [...Object.keys(HOUSE), ...MOTOR, ...Object.keys(SAIL), 'catamaran'];
