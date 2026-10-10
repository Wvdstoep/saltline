// Interiors v2 — plan assembly (docs/INTERIORS-V2-CONTRACT.md §9.2, §9.4, Lane K). Pure: no three.js, no DOM.
//
// planV2(ga, opts) → Plan v2. The v1 planner (gaplan.js) still lays the skeleton the walk suites trust — hull-fitted
// decks, corridors, stair flights, the engine-room strips with their openings, ladders, cargo and deck gear — and, just
// before its finish() splits the streaming zones, v2 takes over the GPlan:
//   1. the house: every slot-sized GA room is replaced by the spaces of shared/ships/gaspace.js (real-scale cabins,
//      suites, messes with pantry, galley with provisions and cold rooms …) with their own doors and windows;
//   2. every room gets its fine kind (`space`), clear height, lining, materials (atlas tiles) and acoustic;
//   3. kits furnish them densely (iv2kits.js), the engine room is packed with machinery round walkways (er packer),
//      the bridge gets its full console row, chairs, overhead panel and rear-wall panels;
//   4. unlined spaces get frames and runs, every room its light fixtures, machinery its sound emitters;
//   5. Go-to points are snapped again onto the (now furnished) floor.
// Then the finished plan gains the additive v2 keys (§9.4): v, lights, emitters, views, chunks.
import { planFromGA, _internals } from './gaplan.js';
import { houseSpaces, SCALE } from '../../shared/ships/gaspace.js';
import { modelParams } from '../../shared/ships/gaparams.js';
import { frameSpacing, erEquipment, meDetail } from '../../shared/ships/gamach.js';
import { furnishV2, overheadRuns, roomLights, Placer, packEngineRoomV2 } from './iv2kits.js';
import { ITEMS } from './iv2items.js';

const r2 = (v) => Math.round(v * 100) / 100;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ------------------------------------------------------------------------------------------------ the finish hook
let hooked = false, pending = null;
function hook() {
  if (hooked) return;
  const G = _internals.GPlan, orig = G.prototype.finish;
  G.prototype.finish = function finishV2() { if (pending) { const f = pending; pending = null; f(this); } return orig.call(this); };
  hooked = true;
}

const memo = new Map(), MEMO_MAX = 32;
/**
 * Plan v2 for a GA (or variant id). opts as planFromGA (deck). Falls back to v1 if the v2 pass throws. Plans are pure
 * and deterministic, so the last few are kept (callers treat plans as read-only).
 */
export function planV2(gaOrId, opts = {}) {
  const key = `${typeof gaOrId === 'string' ? gaOrId : gaOrId?.id}|${opts.deck ?? ''}`;
  if (memo.has(key)) { const p = memo.get(key); memo.delete(key); memo.set(key, p); return p; }
  const plan = buildV2(gaOrId, opts);
  memo.set(key, plan); if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
  return plan;
}
function buildV2(gaOrId, opts) {
  hook();
  let P = null, err = null;
  pending = (gp) => { P = gp; try { transform(gp, gp.ga, opts); } catch (e) { err = e; } };
  let plan;
  try { plan = planFromGA(gaOrId, { ...opts, v: 1 }); } finally { pending = null; }
  if (err) { if (globalThis.__iv2strict) throw err; console.warn('[iv2] v2 pass failed, v1 plan used', err); return planFromGA(gaOrId, { ...opts, v: 1 }); }
  if (!plan || !P) return plan;
  return decorate(plan, P);
}

// ------------------------------------------------------------------------------------------------ helpers on the GPlan
function rebuildSolidGrid(P) {
  P.sgrid = new Map();
  for (const s of P.solids) for (let i = Math.floor(s.x0 / 4); i <= Math.floor(s.x1 / 4); i++) for (let j = Math.floor(s.z0 / 4); j <= Math.floor(s.z1 / 4); j++) { const k = i * 100003 + j; let l = P.sgrid.get(k); if (!l) { l = []; P.sgrid.set(k, l); } l.push(s); }
}
const centerOf = (o) => ({ x: o.x ?? (o.x0 != null ? (o.x0 + o.x1) / 2 : NaN), z: o.z ?? (o.z0 != null ? (o.z0 + o.z1) / 2 : NaN), y: o.y ?? o.y0 });
/** Remove the v1 furniture of the rooms (props, solids, hotspots, reserved strips whose centre is inside). */
function clearRooms(P, rooms, { keepProps = new Set(['sign', 'pipes', 'block']), keepHot = new Set() } = {}) {
  const inAny = (o) => { const c = centerOf(o); if (!Number.isFinite(c.x) || !Number.isFinite(c.z)) return false; return rooms.some((r) => c.x > r.x0 - 0.01 && c.x < r.x1 + 0.01 && c.z > r.z0 - 0.01 && c.z < r.z1 + 0.01 && Math.abs((c.y ?? r.y) - r.y) < 0.15); };
  P.props = P.props.filter((p) => keepProps.has(p.t) || !inAny(p));
  P.solids = P.solids.filter((s) => !inAny(s));
  P.hotspots = P.hotspots.filter((h) => keepHot.has(h.kind) || !inAny(h));
  P.reserved = P.reserved.filter((q) => !rooms.some((r) => (q.x0 + q.x1) / 2 > r.x0 && (q.x0 + q.x1) / 2 < r.x1 && (q.z0 + q.z1) / 2 > r.z0 && (q.z0 + q.z1) / 2 < r.z1 && q.y0 <= r.y + 0.1 && q.y1 >= r.y - 0.1));
  rebuildSolidGrid(P);
}
function removeRoom(P, r) {
  P.rooms = P.rooms.filter((q) => q !== r); P.byIdMap.delete(r.id);
  P.doors = P.doors.filter((d) => d.a !== r.id && d.b !== r.id);
  for (const q of P.rooms) if (q.doorList) q.doorList = q.doorList.filter((d) => d.a !== r.id && d.b !== r.id);
}
const LEGACY_FLOOR = { vinyl: 'lino', vinyl_dark: 'lino', vinyl_heavy: 'lino', carpet: 'carpet', carpet_corr: 'carpet', carpet_pax: 'carpet', carpet_th: 'carpet', quarry: 'lino', tile_wet: 'lino', stone: 'lino', wood: 'wood', rubber: 'lino', chequer: 'steel', alu_chequer: 'steel', grating: 'grating', epoxy: 'steel', steel: 'steel', deck: 'deck', teak: 'teak' };

// ------------------------------------------------------------------------------------------------ 1. the house
function recutHouse(P, ga) {
  const hs = new Map(houseSpaces(ga));
  if (!hs.size) return 0;
  const style = P.style;
  let n = 0;
  // the plan keeps ≤ 400 rooms (§6.6): when the re-cut would exceed it, the upper tiers' blocks stay whole
  const budget = 392 - P.rooms.length - (ga.er ? 40 : 0);
  let extra = 0;
  const tierRank = (t) => { const ts = ga.house.tiers.map((q) => q.id); return ts.indexOf(t); };
  const order = [...hs.entries()].sort((a, b) => tierRank(a[1].tier) - tierRank(b[1].tier));
  for (const [id, rep] of order) { const add = rep.spaces.length - 1; if (extra + add > budget) hs.delete(id); else extra += add; }
  const olds = [...hs.keys()].map((id) => P.byId(id)).filter((r) => r && r.walk !== false);
  clearRooms(P, olds);
  for (const [gaId, rep] of hs) {
    const old = P.byId(gaId);
    if (!old || old.walk === false) continue;
    removeRoom(P, old);
    P.zone = old.zone;
    const made = new Map();
    for (const s of rep.spaces) {
      const k = SCALE[s.kind];
      const r = P.room({ id: s.id, kind: k.legacy, use: s.kind, space: s.kind, name: s.id === gaId && old.name && rep.spaces.length === 1 ? old.name : k.name, x0: s.x0, x1: s.x1, z0: s.z0, z1: s.z1, y: old.y, h: r2(Math.min(old.h, k.h[1])), deckH: r2(old.h + 0.12), floor: LEGACY_FLOOR[k.floor] || 'lino', wall: style === 'yacht' ? 'wood' : 'white', walk: true, tier: old.tier, berth: k.berth || 0, role: s.role, v2recut: true });
      made.set(s.id, r); n++;
    }
    for (const s of rep.spaces) {
      const a = made.get(s.id), b = made.get(s.door.to) || P.byId(s.door.to);
      if (!b) continue;
      P.door(a, b, s.door.side, s.door.at, s.door.w, 2.05, 'door');
      for (const w of s.win || []) P.window(a, w.side, w.from, w.to, w.bottom, Math.min(w.top, a.h - 0.15));
    }
  }
  return n;
}

// ------------------------------------------------------------------------------------------------ 2. fine kinds
function spaceOfRoom(r, P) {
  if (r.space) return r.space;
  const u = r.use || '', id = r.id || '';
  if (r.open) return 'open_deck';
  if (r.kind === 'bridge') return r.id.startsWith('wing') ? 'bridge' : 'bridge';
  if (u === 'ecr' || id === 'er-ecr') return 'ecr';
  if (u === 'purifier') return 'purifier_room';
  if (u === 'workshop') return 'workshop';
  if (u === 'steering') return 'steering_gear';
  if (u === 'shaft') return 'er_platform';
  if (u === 'hold' || u === 'pens' || u === 'trunk') return 'cargo';
  if (u === 'compressor') return 'compressor_house';
  if (u === 'winch') return 'winch_room';
  if (u === 'lab') return 'lab';
  if (u === 'er_entrance') return 'entrance';
  if (u === 'casing') return null;
  if (r.kind === 'engine') return 'er_platform';
  if (r.kind === 'stairs') return 'stair';
  if (r.kind === 'passage') return u === 'entrance' ? 'entrance' : 'corridor';
  if (r.kind === 'cabin') return u === 'hospital' ? 'hospital' : u === 'dayroom' ? 'suite_day' : 'cabin_officer';
  if (r.kind === 'mess') return u === 'galley' ? 'galley' : u === 'gym' ? 'gym' : u === 'mess' ? 'mess' : 'recreation';
  if (r.kind === 'store') return u === 'ccr' ? 'ccr' : u === 'lockers' ? 'changing_er' : 'store_gen';
  void P; return null;
}
const PALETTE = {
  classic_beige: { vinyl: 'lino_beige', laminate: 'laminate_cream' }, classic_green: { vinyl: 'lino_green', laminate: 'laminate_cream' },
  eco_grey: { vinyl: 'lino_grey', laminate: 'laminate' }, eco_blue: { vinyl: 'lino_blue', laminate: 'laminate' },
  yacht_oak: { vinyl: 'wood', laminate: 'veneer_light' }, yacht_walnut: { vinyl: 'wood', laminate: 'veneer_dark' },
  pax_warm: { vinyl: 'lino_beige', laminate: 'veneer' }, pax_cool: { vinyl: 'lino_grey', laminate: 'laminate_grey' },
};
function tagSpaces(P, params) {
  const pal = PALETTE[params?.palette] || PALETTE.eco_grey;
  for (const r of P.rooms) {
    const sp = spaceOfRoom(r, P);
    r.space = sp || null;
    const k = sp ? SCALE[sp] : null;
    if (!k) { r.lined = false; r.ceil = 'open'; r.acoustic = r.open ? 'deck' : 'passage'; r.mat = { floor: 'steel', wall: 'paint_grey', ceil: 'paint_grey' }; continue; }
    r.lined = !!k.lined && !k.unlined; r.ceil = k.ceil; r.acoustic = k.acoustic;
    r.deckH = r.deckH ?? r2(r.h + 0.12);
    const fl = pal[k.floor] || k.floor, wl = pal[k.wall] || k.wall;
    r.mat = { floor: r.floor === 'grating' && !r.lined ? 'grating' : r.floor === 'teak' ? 'teak' : r.floor === 'deck' ? 'deck' : r.floor === 'carpet' && k.floor === 'vinyl' ? 'carpet' : fl, wall: r.wall === 'dark' && !r.lined ? 'paint_er' : r.wall === 'steel' ? 'paint_grey' : r.wall === 'wood' ? 'veneer' : wl, ceil: k.ceil === 'open' ? (r.zone === 'er' ? 'paint_er' : 'paint_grey') : k.ceil === 'coffered' ? 'ceil_coffered' : 'ceil_panel' };
    if (r.open) r.mat = { floor: r.floor === 'teak' ? 'teak' : r.floor === 'grating' ? 'grating' : 'deck', wall: 'paint_white', ceil: 'paint_white' };
    if (sp === 'er_platform' && r.level === 0) r.mat.floor = 'chequer';
    // lined accommodation: clear height to the false ceiling (§2.3); deck-to-deck kept as deckH
    if (k.lined && !k.unlined && !r.open && sp !== 'stair' && sp !== 'bridge' && r.zone !== 'er' && !r.cuts?.length) {
      const h = clamp(r.h, k.h[0], k.h[1]);
      if (h < r.h - 0.05 && !P.stairs.some((s) => s.foot === r.id || s.head === r.id)) { r.deckH = r2(r.h + 0.12); r.h = r2(h); }
    }
  }
}

// ------------------------------------------------------------------------------------------------ 3a. the bridge
function bridgeKit(P, ga, br, ctx) {
  if (!br || !ga.bridge) return;
  P.zone = br.zone;
  const K = new Placer(P, br, ctx);
  const W = br.x1 - br.x0, cz = br.z0 + 0.75, y = br.y;
  // the console row across ≥ 60 % of the front: extend the v1 bank with segments both sides
  let xl = Infinity, xr = -Infinity;
  for (const s of P.solids) if (s.tag === 'console' && Math.abs(s.y - y) < 0.05 && s.z0 < cz && s.z1 > cz && s.x0 >= br.x0 && s.x1 <= br.x1) { xl = Math.min(xl, s.x0); xr = Math.max(xr, s.x1); }
  if (!Number.isFinite(xl)) { xl = -0.7; xr = 0.7; }
  const want = Math.max(W * 0.62, xr - xl), lim = W / 2 - 1.7;
  const screens = ['alarm', 'thruster', 'conning', 'radarS', 'ecdis', 'autopilot', 'dp', 'alarm'];
  let k = 0;
  for (const side of [-1, 1]) {
    let x = side < 0 ? xl : xr;
    while (Math.abs(x) < lim && (xr - xl) < want + 1.2) {
      const segW = 1.0, x0 = side < 0 ? x - segW : x, x1 = side < 0 ? x : x + segW;
      if (Math.max(Math.abs(x0), Math.abs(x1)) > lim) break;
      const it = K.put('console_seg', { x0, x1, z0: cz - 0.45, z1: cz + 0.45 }, 0, { front: 0.9, prop: { screen: screens[k++ % screens.length] } });
      if (!it) break;
      if (side < 0) xl = x0; else xr = x1;
      x = side < 0 ? x0 : x1;
    }
  }
  // overhead instrument panel over the centre of the row, two pilot chairs behind it
  P.prop('k2', { item: 'overhead_panel', x: 0, y: r2(y + 2.05), z: r2(cz - 0.1), rotY: 0, w: Math.min(4.0, xr - xl), d: 0.3, h: 0.45, room: br.id, var: 0 });
  for (const sx of [-1, 1]) for (const ax of [2.0, 2.6, 1.6, 3.2]) {
    const x = sx * ax, q = { x0: x - 0.4, x1: x + 0.4, z0: cz + 0.95, z1: cz + 1.75 };
    if (K.put('pilot_chair', q, Math.PI, { front: 0, hot: false })) break;
  }
  // rear wall: VDR, fire, nav-light panels, BNWAS, coffee corner, lifejackets, signal lamp, binoculars, flag locker
  for (const id of ['fire_panel', 'navlight_panel', 'vdr_panel', 'chart_drawers', 'coffee_corner', 'lifejacket_box', 'flag_locker', 'signal_lamp']) K.wall(id, { walls: ['s', 'w', 'e'], at: id === 'coffee_corner' ? 'end' : 'center' });
  for (const id of ['bnwas', 'binocular_rack', 'fire_ext', 'fire_plan', 'muster_board']) K.wall(id, { walls: ['s', 'w', 'e'] });
  // wipers, clear-view screens and sun visors on the front windows
  const front = (br.windows || []).filter((w) => w.side === 'n');
  for (const w of front) { const n = clamp(Math.round((w.to - w.from) / 3.2), 1, 5); for (let i = 0; i < n; i++) { const x = w.from + ((i + 0.5) * (w.to - w.from)) / n; P.prop('k2', { item: 'wiper', x: r2(x), y: r2(y + w.bottom + 0.1), z: r2(br.z0 + 0.06), rotY: 0, w: 0.9, d: 0.05, h: 0.05, room: br.id, var: i, anim: 'wiper' }); P.prop('k2', { item: 'sun_visor', x: r2(x), y: r2(y + w.top - 0.35), z: r2(br.z0 + 0.12), rotY: 0, w: 1.2, d: 0.05, h: 0.6, room: br.id, var: i }); } }
  const s = SCALE.bridge;
  K.fillLoop(['plant', 'chart_drawers', 'lifejacket_box', 'cabinet_file', 'signal_lamp'], { emptyR: s.emptyR, fillLo: 0.1, maxItems: 16 });
  br.kitStat = { ...K.metrics(), items: K.items.length };
  // wings: pelorus on an open wing, lifebuoy
  for (const wid of ['wing-port', 'wing-stbd']) {
    const wg = P.byId(wid); if (!wg) continue;
    P.zone = wg.zone;
    const WK = new Placer(P, wg, ctx);
    if (wg.open) WK.freeAt('pelorus', (wg.x0 + wg.x1) / 2 + (wid === 'wing-stbd' ? 0.6 : -0.6), wg.z0 + 0.6, { maxTries: 40 });
  }
}

// ------------------------------------------------------------------------------------------------ 3b. engine room packer
/**
 * Every ER level: machinery along the hull side and round the walkways, tank faces on the wing bulkheads, the
 * equipment list of gamach.js placed level by level, then fill items until no bare floor is wider than emptyR.
 */
function packEngineRoom(P, ga, params, ctx) {
  const er = ga.er; if (!er) return;
  const rooms = P.rooms.filter((r) => r.zone === 'er' && r.space === 'er_platform' && r.walk !== false && !r.open && r.use !== 'shaft');
  if (!rooms.length) return;
  for (const r of rooms) if (r.level == null) r.level = er.levels.findIndex((y) => Math.abs(y - r.y) < 0.05);
  const queue = [];
  for (const e of erEquipment(ga, params)) for (let i = 0; i < e.n; i++) queue.push(e);
  packEngineRoomV2(P, rooms, queue, ctx);
}

// ------------------------------------------------------------------------------------------------ 3c. corridors, stairs, entrances
function dressCirculation(P, r, ctx) {
  P.zone = r.zone;
  const K = new Placer(P, r, ctx);
  const len = Math.max(r.x1 - r.x0, r.z1 - r.z0), long = r.x1 - r.x0 >= r.z1 - r.z0 ? ['n', 's'] : ['w', 'e'];
  const n = Math.max(1, Math.round(len / 10));
  for (let i = 0; i < n; i++) K.wall('fire_ext', { walls: long, at: (long[0] === 'n' ? r.x0 : r.z0) + (len * (i + 0.5)) / n, mountClear: true });
  if (len > 5) K.wall('notice_board', { walls: long });
  if (r.space === 'stair' || r.space === 'entrance') { K.wall('fire_plan', { walls: ['n', 's', 'e', 'w'] }); K.wall('muster_board', { walls: ['n', 's', 'e', 'w'] }); }
  if (r.space === 'entrance' || r.space === 'stair') for (const d of (r.doorList || []).filter((q) => q.kind === 'ext' || q.kind === 'door' || (r.space === 'stair' && q.kind === 'open'))) { const ns = d.side === 'n' || d.side === 's'; P.prop('k2', { item: 'exit_sign', x: r2(ns ? d.at : (d.side === 'w' ? r.x0 + 0.06 : r.x1 - 0.06)), y: r2(r.y + Math.min(2.08, r.h - 0.12)), z: r2(ns ? (d.side === 'n' ? r.z0 + 0.06 : r.z1 - 0.06) : d.at), rotY: { n: 0, s: Math.PI, w: Math.PI / 2, e: -Math.PI / 2 }[d.side], w: 0.35, d: 0.05, h: 0.15, room: r.id, var: 0 }); }
}

// ------------------------------------------------------------------------------------------------ transform
function transform(P, ga, opts) {
  const params = modelParams(ga.id) || modelParams(ga.model) || null;
  const ctx = { seed: params?.seed ?? 1, frame: frameSpacing(ga.L), params, ga };
  P.lights = []; P.emitters = [];
  // 1. house re-cut (GA layouts with a house)
  if (ga.house && (ga.layout === 'big' || ga.layout === 'roro')) recutHouse(P, ga);
  // 2. fine kinds + materials
  tagSpaces(P, params);
  // galley ↔ mess hatch walls
  const touchWall = (a, kinds) => { for (const b of P.rooms) { if (b === a || !kinds.includes(b.space) || Math.abs(b.y - a.y) > 0.05) continue; if (Math.abs(b.x1 - a.x0) < 0.03 && Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0) > 1.4) return 'w'; if (Math.abs(b.x0 - a.x1) < 0.03 && Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0) > 1.4) return 'e'; if (Math.abs(b.z1 - a.z0) < 0.03 && Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 1.4) return 'n'; if (Math.abs(b.z0 - a.z1) < 0.03 && Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 1.4) return 's'; } return null; };
  ctx.galleyWall = (r) => touchWall(r, ['galley', 'pantry']);
  ctx.messWall = (r) => touchWall(r, ['mess']);
  // 3. furnish: house spaces, ER enclosed rooms, the bridge, then the ER platforms
  const furnishable = P.rooms.filter((r) => r.space && !r.open && r.walk !== false && SCALE[r.space]?.kit && !['er_platform', 'bridge', 'corridor', 'stair', 'entrance', 'cargo', 'open_deck'].includes(r.space));
  // v1 furniture of the accommodation goes (the kits replace it); engine-room rooms keep theirs and get more
  clearRooms(P, furnishable.filter((r) => String(r.zone).startsWith('house') && !r.v2cleared));
  for (const r of furnishable) { P.zone = r.zone; try { furnishV2(P, r, ctx); } catch (e) { if (globalThis.__iv2strict) throw e; } }
  const br = ga.bridge ? P.byId(ga.bridge.room) : null;
  if (br) bridgeKit(P, ga, br, ctx);
  packEngineRoom(P, ga, params, ctx);
  for (const r of P.rooms) if (['corridor', 'stair', 'entrance'].includes(r.space) && !r.open && r.walk !== false) dressCirculation(P, r, ctx);
  // 4. runs in unlined spaces, light fixtures, sound emitters
  ctx.propsByRoom = new Map(); for (const p of P.props) if (p.t === 'k2' && p.room) { let l = ctx.propsByRoom.get(p.room); if (!l) { l = []; ctx.propsByRoom.set(p.room, l); } l.push(p); }
  for (const r of P.rooms) {
    if (r.open || r.walk === false || !r.space) continue;
    P.zone = r.zone;
    if (!r.lined && r.space !== 'cargo') overheadRuns(P, r, { frame: ctx.frame, sys: r.zone === 'er' ? ['fw', 'sw', 'fuel', 'lo', 'fire', 'air', 'steam'] : ['fire', 'fw', 'air'] });
    roomLights(P, r, ctx);
  }
  for (const r of P.rooms) if (r.open && r.walk !== false) roomLights(P, r, ctx);
  for (const p of P.props) {
    const em = p.t === 'k2' ? ITEMS[p.item]?.emit : p.t === 'me2s' || p.t === 'engine' ? { kind: 'me', level: 1 } : p.t === 'generator' ? { kind: 'genset', level: 0.8 } : p.t === 'steeringGear' ? { kind: 'hpu', level: 0.5 } : null;
    if (em) P.emitters.push({ room: p.room || null, kind: em.kind, x: r2(p.x ?? (p.x0 + p.x1) / 2), y: r2((p.y ?? 0) + 1), z: r2(p.z ?? (p.z0 + p.z1) / 2), level: em.level });
  }
  ctx.me = meDetail(ga);
  P.iv2 = { me: ctx.me, params: params ? { palette: params.palette, era: params.era, style: params.style } : null };
  // 5. Go-to points snapped again onto the furnished floor
  P.goto = [];
  P.hotspots = P.hotspots.filter((h) => !(h.kind === 'goto' && !h.decks && h.label === 'Go to… (quick travel)'));
  _internals.finishCommon(P, ga);
  void opts;
}

// ------------------------------------------------------------------------------------------------ v2 keys on the finished plan
function decorate(plan, P) {
  const zoneOf = new Map(plan.rooms.map((r) => [r.id, r.zone]));
  const lights = (P.lights || []).map((l) => ({ ...l, zone: zoneOf.get(l.room) || 'deck' }));
  const emitters = (P.emitters || []).map((e) => ({ ...e, zone: (e.room && zoneOf.get(e.room)) || 'er' }));
  const views = [];
  for (const r of plan.rooms) {
    if (!r.windows?.length || r.open) continue;
    if (r.space === 'bridge') views.push({ room: r.id, zones: plan.zones.filter((z) => z.id === 'deck' || z.id === 'fwd' || z.id === 'cargo').map((z) => z.id) });
    else if (r.space === 'ccr' || r.space === 'mess') views.push({ room: r.id, zones: plan.zones.some((z) => z.id === 'deck') ? ['deck'] : [] });
  }
  // detail chunks: ≤ 12 rooms or ≤ 150 m² per zone, rooms in deck order
  const chunks = [];
  const byZone = new Map();
  for (const r of plan.rooms) { if (!byZone.has(r.zone)) byZone.set(r.zone, []); byZone.get(r.zone).push(r); }
  for (const [zone, rs] of byZone) {
    rs.sort((a, b) => a.y - b.y || a.z0 - b.z0 || a.x0 - b.x0);
    let cur = null;
    for (const r of rs) {
      const a = (r.x1 - r.x0) * (r.z1 - r.z0);
      if (!cur || cur.rooms.length >= 12 || cur.area + a > 150 || Math.abs(cur.y - r.y) > 0.1) { cur = { id: `c${chunks.length}`, zone, rooms: [], area: 0, y: r.y }; chunks.push(cur); }
      cur.rooms.push(r.id); cur.area = r2(cur.area + a); r.chunk = cur.id;
    }
  }
  const roomById = new Map(plan.rooms.map((r) => [r.id, r]));
  // a big room (engine-room levels of large ships) is cut into 12 m detail cells, so the walker's surroundings stream
  const sub = new Map(), CELL = 12;
  for (const p of plan.props) {
    if (p.t !== 'k2' && p.t !== 'run') continue;
    const r = p.room && roomById.get(p.room); if (!r) continue;
    if ((r.x1 - r.x0) * (r.z1 - r.z0) <= 150) { p.chunk = r.chunk; continue; }
    const px = p.x ?? (p.pts ? (p.pts[0][0] + p.pts[p.pts.length - 1][0]) / 2 : (r.x0 + r.x1) / 2), pz = p.z ?? (p.pts ? (p.pts[0][2] + p.pts[p.pts.length - 1][2]) / 2 : (r.z0 + r.z1) / 2);
    const i = Math.floor((px - r.x0) / CELL), j = Math.floor((pz - r.z0) / CELL), id = `${r.chunk}.${i}.${j}`;
    if (!sub.has(id)) { const x0 = r.x0 + i * CELL, z0 = r.z0 + j * CELL; sub.set(id, { id, zone: r.zone, rooms: [], area: 0, y: r.y, center: { x: r2((x0 + Math.min(r.x1, x0 + CELL)) / 2), y: r.y, z: r2((z0 + Math.min(r.z1, z0 + CELL)) / 2) } }); }
    p.chunk = id;
  }
  for (const c of sub.values()) chunks.push(c);
  plan.v = 2; plan.lights = lights; plan.emitters = emitters; plan.views = views; plan.chunks = chunks.map(({ y, ...c }) => c); plan.iv2 = P.iv2 || null;
  return plan;
}
export const _gaplan2 = { transform, recutHouse, tagSpaces, packEngineRoom, bridgeKit, clearRooms };
