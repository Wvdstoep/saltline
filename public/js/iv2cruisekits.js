// Interiors v2 — furnishing kits for cruise ships (docs/CRUISE-CONTRACT.md §4). Pure: no three.js, no DOM. Same contract as
// iv2kits.js: a kit gets the room's Placer K (occupancy grid, doors and hotspots kept clear) and places items; it returns
// { fill, dress } for the generic fill loop. Public venues are laid out on lattices with real aisles (dining sets every
// 3.2 × 3.0 m, theatre rows every 1.05 m), so a restaurant, a casino or a theatre looks full without one draw call per
// chair: the composite items (dining_set4, theatre_row …) carry their chairs. K.noCheck skips the walk check while a
// lattice is placed; the kit checks the whole room once at the end and drops the fewest items that cut the walk.
import { ITEMS, venueHot } from './iv2items.js';
import { SCALE } from '../../shared/ships/gaspace.js';

const r2 = (v) => Math.round(v * 100) / 100;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const doorSides = (K) => new Set(K.doors.map((d) => d.side));
const notDoor = (K, list) => list.filter((s) => !doorSides(K).has(s)).concat(list.filter((s) => doorSides(K).has(s)));
const winSides = (r) => [...new Set((r.windows || []).map((w) => w.side))];
const hashS = (s) => { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; };
const mulb = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

/** Put item `id` centred at (cx, cz) turned by rot (quarter turns swap w / d). */
function putAt(K, id, cx, cz, rot = 0, o = {}) {
  const it = ITEMS[id]; if (!it) return null;
  const w = o.w ?? it.w, d = o.d ?? it.d, sw = Math.abs(Math.sin(rot)) > 0.5 ? d : w, sd = Math.abs(Math.sin(rot)) > 0.5 ? w : d;
  return K.put(id, { x0: cx - sw / 2, x1: cx + sw / 2, z0: cz - sd / 2, z1: cz + sd / 2 }, rot, { ...o, w, d });
}
/** A lattice of `id` over [x0,x1]×[z0,z1] with pitch (px, pz); `skip(cx, cz, i, j)` drops cells. → count placed. */
function lattice(K, id, x0, x1, z0, z1, px, pz, o = {}, rot = 0, skip = null) {
  const nx = Math.max(0, Math.floor((x1 - x0) / px)), nz = Math.max(0, Math.floor((z1 - z0) / pz)); let n = 0;
  const ox = x0 + (x1 - x0 - nx * px) / 2 + px / 2, oz = z0 + (z1 - z0 - nz * pz) / 2 + pz / 2;
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const cx = ox + i * px, cz = oz + j * pz;
    if (skip && skip(cx, cz, i, j)) continue;
    if (putAt(K, id, cx, cz, rot, typeof o === 'function' ? o(i, j, n) : o)) n++;
  }
  return n;
}
/** Loungers over every free part of an open deck, with a 1.4 m lane every 4th row and 5th column so the deck stays walkable. */
function scatterLoungers(K, id = 'lounger_pair', pitch = 2.6, x0 = null, x1 = null, z0 = null, z1 = null) {
  const r = K.r, X0 = x0 ?? r.x0 + 1.0, X1 = x1 ?? r.x1 - 1.0, Z0 = z0 ?? r.z0 + 1.0, Z1 = z1 ?? r.z1 - 1.0;
  lattice(K, id, X0, X1, Z0, Z1, pitch, pitch, { hot: false }, 0, (cx, cz, i, j) => j % 4 === 3 || i % 6 === 5);
  // a place to rest in is marked in the lanes between the rows (hotspot `v:lounger`): free by construction, and not a per-item walk check
  const nx = Math.max(0, Math.floor((X1 - X0) / pitch)), nz = Math.max(0, Math.floor((Z1 - Z0) / pitch));
  const ox = X0 + (X1 - X0 - nx * pitch) / 2 + pitch / 2, oz = Z0 + (Z1 - Z0 - nz * pitch) / 2 + pitch / 2, hs = venueHot('lounger');
  for (let j = 3; j < nz; j += 4) for (let i = 1; i < nx; i += 7) { const x = ox + i * pitch, z = oz + j * pitch; if (K.walkableAt(x, z)) K.P.hot(hs.kind, hs.label, r2(x), K.y, r2(z), 1.3); }
}
/** Run `f` with the walk check off, then restore the walk once for the whole room. */
function bulk(K, f) {
  const prev = K.noCheck; K.noCheck = true;
  try { f(); } finally { K.noCheck = prev; }
  if (!K.connected()) K.repair(0);
}
const inner = (K, m = 0.6) => ({ x0: K.r.x0 + m, x1: K.r.x1 - m, z0: K.r.z0 + m, z1: K.r.z1 - m });
const curtainsFor = (K) => {
  const r = K.r;
  for (const w of r.windows || []) {
    const ns = w.side === 'n' || w.side === 's', c = { n: r.z0 + 0.1, s: r.z1 - 0.1, w: r.x0 + 0.1, e: r.x1 - 0.1 }[w.side], rot = { n: 0, s: Math.PI, w: Math.PI / 2, e: -Math.PI / 2 }[w.side];
    for (const u of [w.from - 0.12, w.to + 0.12]) K.P.prop('k2', { item: 'curtain', x: r2(ns ? u : c), y: r2(r.y + w.bottom - 0.05), z: r2(ns ? c : u), rotY: rot, w: 0.35, d: 0.08, h: r2(w.top - w.bottom + 0.15), room: r.id, var: 0 });
  }
};
/** Items along every wall that has no door or window row: one every `pitch` m. */
function perimeter(K, id, pitch, o = {}) {
  const r = K.r, ds = doorSides(K);
  for (const s of ['n', 's', 'e', 'w']) {
    if (ds.has(s) && !o.doors) continue;
    const along = s === 'n' || s === 's', lo = along ? r.x0 : r.z0, len = along ? r.x1 - r.x0 : r.z1 - r.z0;
    for (let u = 1.2; u < len - 1.2; u += pitch) K.wall(id, { walls: [s], at: lo + u, ...o });
  }
}
const info = (K, label, x, z, rr = 1.4) => { if (K.walkableAt(x, z)) K.P.hot('info', label, x, K.r.y, z, rr); };

// ------------------------------------------------------------------------------------------------ staterooms
function cabinPaxKit(K) {
  const r = K.r, kind = r.space, suite = kind === 'cabin_cruise_suite', acc = kind === 'cabin_cruise_acc';
  const ds = doorSides(K), wins = winSides(r), W = r.x1 - r.x0, D = r.z1 - r.z0;
  // the bathroom module by the door
  const ws = suite ? { w: 1.5, d: 1.8 } : acc ? { w: 1.6, d: 1.7 } : { w: 1.3, d: 1.5 };
  K.wall('wet_unit', { ...ws, walls: [...ds, ...notDoor(K, ['n', 's', 'e', 'w'])], at: 'door', front: 0.6 });
  const long = W >= D ? ['n', 's'] : ['w', 'e'];
  const bed = K.wall(suite ? 'bed_island' : 'bed_queen', { walls: [...long.filter((s) => !ds.has(s)), ...notDoor(K, ['n', 's', 'e', 'w'])], at: 'center', avoidWindows: false, hotLabel: 'Rest in your stateroom' });
  const vanity = K.wall('vanity', { walls: [...wins.filter((s) => !ds.has(s)), ...notDoor(K, ['e', 'w', 'n', 's'])], at: 'center', front: 0.5 });
  if (vanity) { const it = ITEMS.chair, pp = { x: (vanity.q.x0 + vanity.q.x1) / 2, z: (vanity.q.z0 + vanity.q.z1) / 2 }; void it; void pp; }
  K.wall('wardrobe', { w: suite ? 1.6 : 1.0, walls: notDoor(K, ['n', 's', 'e', 'w']), at: 'door' });
  if (suite) {
    const s = K.wall('settee_L', { walls: notDoor(K, ['s', 'n', 'w', 'e']), front: 0.8 });
    if (s) K.wall('coffee_table', { walls: [s.side] });
    K.wall('sideboard', { walls: notDoor(K, ['n', 'e', 'w', 's']) });
    K.wall('bookshelf', { walls: notDoor(K, ['e', 'w', 'n', 's']) });
    K.freeAt('armchair', K.center().x, K.center().z, { maxTries: 60 }); K.freeAt('armchair', K.center().x + 0.9, K.center().z + 0.4, { maxTries: 60 });
    K.wall('tv', { walls: notDoor(K, ['n', 's', 'e', 'w']) });
  } else {
    const s = K.wall('sofa_bed', { walls: notDoor(K, ['s', 'n', 'w', 'e']), front: 0.7 });
    if (s) K.wall('coffee_table', { w: 0.8, d: 0.5, walls: [s.side] });
    K.wall('minibar', { walls: notDoor(K, ['n', 'e', 's', 'w']) });
  }
  K.wall('tv', { walls: notDoor(K, ['n', 's', 'e', 'w']) });
  K.wall('mirror', { walls: notDoor(K, ['n', 's', 'e', 'w']) });
  K.wall('bin', { walls: notDoor(K, ['e', 'w', 'n', 's']) });
  curtainsFor(K);
  const c = K.center(); K.freeAt('rug', c.x, c.z, { maxTries: 30 });
  void bed;
  return { fill: suite ? ['armchair', 'plant', 'drawers', 'chair'] : ['plant', 'drawers', 'chair', 'armchair'], dress: ['artwork', 'artwork', 'notice_board'] };
}

// ------------------------------------------------------------------------------------------------ circulation: street, atrium, galleries
function streetKit(K, ctx) {
  const r = K.r, W = r.x1 - r.x0, D = r.z1 - r.z0, rg = mulb((ctx.seed || 1) + hashS(r.id)), alongZ = D >= W;
  const len = alongZ ? D : W, cw = alongZ ? (r.x0 + r.x1) / 2 : (r.z0 + r.z1) / 2;
  const u0 = alongZ ? r.z0 : r.x0;
  const pos = (u, v) => (alongZ ? [cw + v, u] : [u, cw + v]);
  bulk(K, () => {
    // lamp posts every 9 m along both edges, planters and palms between, a bench pair every 18 m
    const half = (alongZ ? W : D) / 2;
    const e = Math.max(0.8, half - 0.9);
    for (let u = u0 + 3; u < u0 + len - 2; u += 9) { const [x, z] = pos(u, (Math.floor((u - u0) / 9) % 2 ? e : -e)); putAt(K, 'street_lamp', x, z, 0); }
    for (let u = u0 + 5; u < u0 + len - 2; u += 5.5) { const side = Math.floor((u - u0) / 5.5) % 2 ? -1 : 1; const [x, z] = pos(u, side * e); putAt(K, ['palm', 'planter', 'bench_pax', 'planter'][Math.floor(u / 5.5) % 4], x, z, alongZ ? (side > 0 ? Math.PI / 2 : -Math.PI / 2) : (side > 0 ? Math.PI : 0)); }
    for (let u = u0 + 9; u < u0 + len - 4; u += 28) { const side = Math.floor((u - u0) / 18) % 2 ? 1 : -1; const [x, z] = pos(u, side * (e - 0.7)); putAt(K, 'bench_pax', x, z, alongZ ? (side > 0 ? Math.PI / 2 : -Math.PI / 2) : (side > 0 ? Math.PI : 0)); }
    if (half >= 4 && len > 24) { const [x, z] = pos(u0 + len / 2, 0); putAt(K, rg() < 0.5 ? 'kiosk' : 'fountain', x, z, 0); }
    // island features down the middle line every ~7 m, so no stretch of the street is bare
    for (let u = u0 + 4.5; u < u0 + len - 3; u += 7) { if (Math.abs(u - (u0 + len / 2)) < 4 && half >= 4 && len > 24) continue; const [x, z] = pos(u, 0); putAt(K, ['planter', 'bench_pax', 'palm', 'display_table'][Math.floor(u / 7) % 4], x, z, alongZ ? Math.PI / 2 : 0); }
  });
  // venue signs over every entrance on the street's walls
  for (const d of K.doors) {
    if (d.side === 'n' || d.side === 's') continue;
    const x = d.side === 'w' ? r.x0 + 0.08 : r.x1 - 0.08, rot = d.side === 'w' ? Math.PI / 2 : -Math.PI / 2;
    K.P.prop('k2', { item: 'hanging_sign', x: r2(x), y: r2(r.y + 2.4), z: r2(d.at), rotY: rot, w: 1.8, d: 0.08, h: 0.5, room: r.id, var: hashS(r.id + d.at) % 4 });
  }
  K.wall('info_screen', { walls: ['w', 'e'] });
  perimeter(K, 'artwork', 2.6, { doors: true });
  return { fill: ['planter', 'palm'], dress: ['fire_ext', 'notice_board'] };
}
function atriumKit(K, ctx) {
  const r = K.r, W = r.x1 - r.x0, D = r.z1 - r.z0, cx = (r.x0 + r.x1) / 2, rg = mulb((ctx.seed || 1) + hashS(r.id));
  const ai = r.atriumIndex || 0, decks = r.tall || 3;
  if (W < 9) return { fill: ['planter', 'palm'], dress: [] };
  bulk(K, () => {
    // the grand staircase against the fore wall, two glass lifts beside it
    const st = putAt(K, 'grand_stair', cx, r.z0 + 3.7, 0, { w: Math.min(5.0, W - 6), d: 6.0, h: Math.min(3.3, r.h / decks) });
    for (const sx of [-1, 1]) putAt(K, 'glass_lift', cx + sx * Math.min(5.6, W / 2 - 1.8), r.z0 + 1.6, 0, { h: Math.min(r.h - 0.2, 9.8) });
    // a feature in the middle of the floor: fountain, sculpture or a grove of palms
    const feat = ['fountain', 'sculpture', 'palm'][(ai + (ctx.seed || 0)) % 3];
    putAt(K, feat, cx, (r.z0 + r.z1) / 2, 0, feat === 'palm' ? { w: 1.4, d: 1.4 } : {});
    for (const sx of [-1, 1]) for (const f of [0.28, 0.72]) putAt(K, 'palm', cx + sx * (W / 2 - 1.2), r.z0 + D * f, 0);
    // seating: lounge sets either side of the feature, a piano bar on one side
    const zs = [r.z0 + D * 0.38, r.z0 + D * 0.62, r.z0 + D * 0.84];
    zs.forEach((z, k) => { for (const sx of [-1, 1]) putAt(K, k === 1 && sx > 0 ? 'piano_bar' : 'lounge_set', cx + sx * (W / 2 - 4.2), z, sx > 0 ? -Math.PI / 2 : Math.PI / 2); });
    // balcony fronts of the galleries on the decks above, along both side walls (levels 2 and 3)
    for (let lv = 1; lv < decks; lv++) for (const sx of [-1, 1]) for (let z = r.z0 + 6; z < r.z1 - 6; z += 10) K.P.prop('k2', { item: 'atrium_balcony', x: r2(cx + sx * (W / 2 - 3.0)), y: r2(r.y + lv * (r.h / decks)), z: r2(z + 5), rotY: sx > 0 ? -Math.PI / 2 : Math.PI / 2, w: 10, d: 1.1, h: 1.0, room: r.id, var: 0 });
    for (const z of [r.z0 + D * 0.3, r.z0 + D * 0.7]) K.P.prop('k2', { item: 'chandelier', x: r2(cx), y: r2(r.y + Math.min(r.h - 3.2, 6.8)), z: r2(z), rotY: 0, w: 3.4, d: 3.4, h: 2.6, room: r.id, var: 0 });
    void st;
  });
  K.wall('reception_long', { walls: ['s'], at: 'center', w: 5.0 });
  K.wall('info_screen', { walls: ['n', 's'] });
  const pz = r.z1 - 3; info(K, `${r.name} — the heart of the ship`, cx + 3.5, pz);
  void rg;
  return { fill: ['planter', 'palm', 'bench_pax'], dress: [] };
}
function galleryKit(K, ctx) {
  const r = K.r, W = r.x1 - r.x0, D = r.z1 - r.z0, rg = mulb((ctx.seed || 1) + hashS(r.id)), alongZ = D >= W;
  bulk(K, () => {
    const len = alongZ ? D : W;
    for (let u = 1.6; u < len - 0.8; u += 2.7) {
      const x = alongZ ? (r.x0 + r.x1) / 2 : r.x0 + u, z = alongZ ? r.z0 + u : (r.z0 + r.z1) / 2;
      putAt(K, rg() < 0.4 ? 'bench_pax' : rg() < 0.5 ? 'planter' : 'palm', x, z, alongZ ? Math.PI / 2 : 0);
    }
  });
  perimeter(K, 'artwork', 2.6, { doors: true });
  return { fill: ['planter'], dress: [] };
}

// ------------------------------------------------------------------------------------------------ theatre, cinema
function theatreKit(K, ctx) {
  const r = K.r, W = r.x1 - r.x0, D = r.z1 - r.z0, cx = (r.x0 + r.x1) / 2, tall = r.tall === 2;
  const sw = W - 2.0, sd = Math.min(7.5, D * 0.22);
  bulk(K, () => {
    putAt(K, 'band_stage', cx, r.z0 + sd / 2 + 0.1, 0, { w: sw, d: sd, h: 1.1, front: 0 });
    K.P.prop('k2', { item: 'stage_rig', x: r2(cx), y: r2(r.y + Math.min(r.h - 1.2, 5.4)), z: r2(r.z0 + sd + 0.5), rotY: 0, w: sw, d: 1.0, h: 0.3, room: r.id, var: 0 });
    // seating sections: left / centre / right with 1.4 m aisles, rows every 1.05 m behind the stage apron
    const secs = W >= 20 ? 3 : 2, aisle = 1.4, usable = W - 2.0 - aisle * (secs - 1), secW = usable / secs;
    const zA = r.z0 + sd + 1.5, zB = r.z1 - 1.5;
    for (let s = 0; s < secs; s++) {
      const x0 = r.x0 + 1.0 + s * (secW + aisle);
      for (let z = zA; z + 0.95 <= zB; z += 1.05) putAt(K, 'theatre_row', x0 + secW / 2, z + 0.5, Math.PI, { w: secW, d: 0.95, front: 0 });
    }
    if (tall) K.P.prop('k2', { item: 'theatre_balcony', x: r2(cx), y: r2(r.y + 3.2), z: r2(r.z1 - Math.min(9, D * 0.3)), rotY: 0, w: r2(W - 0.6), d: r2(Math.min(15, D * 0.5)), h: 0.5, room: r.id, var: 0 });
  });
  for (const side of ['w', 'e']) K.wall('curtain', { walls: [side], w: 0.4, h: 4, avoidWindows: false, at: r.z0 + 1 });
  info(K, `${r.name} — tonight: the production show`, cx, r.z1 - 1.7);
  return { fill: [], dress: [] };
}
function theatreBalconyKit(K) {
  const r = K.r, W = r.x1 - r.x0, D = r.z1 - r.z0, secs = W >= 20 ? 3 : 2, aisle = 1.4, secW = (W - 2.0 - aisle * (secs - 1)) / secs;
  bulk(K, () => {
    for (let s = 0; s < secs; s++) { const x0 = r.x0 + 1.0 + s * (secW + aisle); for (let z = r.z0 + 1.8; z + 1.0 <= r.z1 - 1.6; z += 1.05) putAt(K, 'theatre_row', x0 + secW / 2, z + 0.5, Math.PI, { w: secW, d: 0.95, front: 0 }); }
  });
  void D;
  return { fill: [], dress: [] };
}
function cinemaKit(K) {
  const r = K.r, W = r.x1 - r.x0, cx = (r.x0 + r.x1) / 2;
  bulk(K, () => {
    K.wall('cinema_screen', { w: Math.min(9, W - 1.6), walls: ['n'], at: 'center', avoidWindows: false });
    const secW = (W - 2.0 - 1.2) / 2;
    for (let s = 0; s < 2; s++) for (let z = r.z0 + 2.4; z + 1.3 <= r.z1 - 2.0; z += 1.4) putAt(K, 'cinema_row', r.x0 + 1.0 + s * (secW + 1.2) + secW / 2, z + 0.65, Math.PI, { w: secW, d: 1.3, front: 0 });
    K.wall('counter', { walls: ['s'], w: 2.4, at: 'end' });
  });
  void cx;
  return { fill: [], dress: [] };
}

// ------------------------------------------------------------------------------------------------ dining
function restaurantKit(K, ctx) {
  const r = K.r, W = r.x1 - r.x0, D = r.z1 - r.z0, venue = r.venue || 'dining', wins = winSides(r), rg = mulb((ctx.seed || 1) + hashS(r.id));
  const buffet = r.space === 'buffet', court = r.space === 'cafeteria';
  K.wall('host_stand', { walls: notDoor(K, ['n', 's', 'e', 'w']), at: 'door' });
  const m = inner(K, 0.9);
  bulk(K, () => {
    if (buffet) {
      // two serving lines across the middle with queues on both sides; salad bars at the wall
      const cx = (r.x0 + r.x1) / 2;
      for (const f of [0.35, 0.65]) putAt(K, 'buffet_line', cx, r.z0 + D * f, 0, { w: Math.min(6, W * 0.4) });
      K.wall('salad_bar', { walls: ['n', 's'], at: 'center' });
    } else if (court) {
      // food stalls round the walls, tables in the middle
      for (const side of ['n', 's']) for (let k = 0; k < 4; k++) K.wall('kiosk', { walls: [side], at: r.x0 + 1.4 + k * Math.max(3.2, (W - 3) / 4), w: 2.2, d: 1.5 });
    }
    // booths along the window walls, then a lattice of sets (a lattice cell is a table with its chairs)
    for (const s of wins.slice(0, 2)) { const along = s === 'n' || s === 's'; const len = along ? W : D; const rot = { n: 0, s: Math.PI, w: Math.PI / 2, e: -Math.PI / 2 }[s]; void rot; for (let u = 1.6; u + 2.4 < len - 1.2; u += 2.9) K.wall(venue === 'spec' ? 'booth4' : 'booth4', { walls: [s], at: (along ? r.x0 : r.z0) + u, avoidWindows: false, front: 0.1 }); }
    const pitchX = court ? 2.9 : 3.2, pitchZ = court ? 2.9 : 3.0;
    const set = court ? 'dining_set4' : venue === 'spec' ? (rg() < 0.5 ? 'dining_set2' : 'dining_set4') : 'dining_set4';
    const x0 = m.x0 + (wins.includes('w') ? 2.0 : 0), x1 = m.x1 - (wins.includes('e') ? 2.0 : 0), z0 = m.z0 + (wins.includes('n') ? 2.0 : 0), z1 = m.z1 - (wins.includes('s') ? 2.0 : 0);
    lattice(K, set, x0, x1, z0, z1, pitchX, pitchZ, {}, 0, (cx, cz, i, j) => (i % 3 === 2 && !court) || (j % 4 === 3 && false));
    K.wall('trolley', { walls: notDoor(K, ['n', 's', 'e', 'w']) });
  });
  return { fill: ['dining_set2', 'planter', 'palm'], dress: ['artwork', 'artwork'] };
}
function galleyPaxKit(K, ctx) {
  const r = K.r, W = r.x1 - r.x0, D = r.z1 - r.z0, cx = (r.x0 + r.x1) / 2;
  bulk(K, () => {
    // cooking lines along the long walls, work islands over the rest of the floor with 1.6 m lanes between them
    const alongZ = D >= W;
    for (const side of alongZ ? ['w', 'e'] : ['n', 's']) {
      for (let k = 0; k < 7; k++) K.wall(k % 3 === 0 ? 'oven_bank' : k % 3 === 1 ? 'range' : 'fridge_upright', { walls: [side], at: (alongZ ? r.z0 : r.x0) + 1.0 + k * 3.4, front: 0.9 });
    }
    const m = inner(K, 2.6);
    lattice(K, 'kitchen_island', m.x0, m.x1, m.z0, m.z1, 6.4, 3.8, { w: 4.8 }, alongZ ? Math.PI / 2 : 0);
    K.wall('dish_conveyor', { walls: alongZ ? ['n', 's'] : ['w', 'e'], at: 'end' });
    K.wall('sink_double', { walls: notDoor(K, ['n', 's', 'e', 'w']) }); K.wall('serving_hatch', { walls: notDoor(K, ['w', 'e', 'n', 's']) });
    perimeter(K, 'prep_table', 5.5, { doors: false });
  });
  void cx; void ctx;
  return { fill: ['prep_table', 'trolley', 'fridge_upright', 'bin_big'], dress: ['fire_ext'] };
}

// ------------------------------------------------------------------------------------------------ bars, clubs, casino
function barKit(K, ctx) {
  const r = K.r, W = r.x1 - r.x0, D = r.z1 - r.z0, venue = r.venue || 'bar', rg = mulb((ctx.seed || 1) + hashS(r.id));
  const club = r.space === 'nightclub', cafe = r.space === 'cafe', lounge = r.space === 'lounge_pax';
  const wins = winSides(r), ds = doorSides(K);
  const walls = notDoor(K, ['n', 's', 'e', 'w']).filter((s) => !wins.includes(s));
  bulk(K, () => {
    if (club) {
      const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
      putAt(K, 'dance_floor', cx, cz, 0, { w: Math.min(8, W - 8), d: Math.min(8, D - 6) });
      K.wall('dj_booth', { walls: notDoor(K, ['n', 's', 'e', 'w']), at: 'center' });
      K.wall('bar_counter', { w: Math.min(6, W * 0.5), walls: walls.length ? walls : ['s'], at: 'center', front: 1.0 });
      K.P.prop('k2', { item: 'stage_rig', x: r2(cx), y: r2(r.y + Math.min(r.h - 1.2, 2.7)), z: r2(cz), rotY: 0, w: Math.min(8, W - 4), d: 1.0, h: 0.3, room: r.id, var: 0 });
      lattice(K, 'high_table', r.x0 + 1.0, r.x1 - 1.0, r.z0 + 1.0, r.z1 - 1.0, 3.0, 3.0, {}, 0, (x, z) => Math.abs(x - cx) < Math.min(8, W - 8) / 2 + 1.6 && Math.abs(z - cz) < Math.min(8, D - 6) / 2 + 1.6);
      lattice(K, 'lounge_set', r.x0 + 1.0, r.x1 - 1.0, r.z0 + 1.0, r.z1 - 1.0, 4.6, 4.0, {}, 0, (x, z) => Math.abs(x - cx) < Math.min(8, W - 8) / 2 + 3.2 && Math.abs(z - cz) < Math.min(8, D - 6) / 2 + 3.2);
    } else if (cafe) {
      K.wall('bar_counter', { w: Math.min(5, W * 0.5), walls: walls.length ? walls : ['s'], at: 'center', front: 1.0 });
      K.wall('display_case', { walls: walls.length ? walls : ['n'], at: 'end' }); K.wall('coffee_machine', { walls: walls.length ? walls : ['s'], at: 'start' });
      const m = inner(K, 1.2);
      lattice(K, 'dining_set2', m.x0, m.x1, m.z0 + 1.4, m.z1, 2.4, 2.4);
    } else {
      const piano = venue === 'bar' && /Piano|Jazz/.test(r.name);
      if (piano) putAt(K, 'piano_bar', (r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2, 0);
      else if (W >= 9 && D >= 9 && rg() < 0.6) putAt(K, 'bar_island', (r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2, 0, { w: Math.min(5, W - 6), d: 2.4 });
      else { const b = K.wall('bar_counter', { w: Math.min(6, W * 0.6), walls: walls.length ? walls : ['s'], at: 'center', front: 1.0 }); if (b) { const s = b.side; const q = b.q; const along = s === 'n' || s === 's'; const cx = (q.x0 + q.x1) / 2, cz = (q.z0 + q.z1) / 2; putAt(K, 'bar_stools', along ? cx : s === 'w' ? q.x1 + 0.45 : q.x0 - 0.45, along ? (s === 'n' ? q.z1 + 0.45 : q.z0 - 0.45) : cz, along ? 0 : Math.PI / 2, { w: Math.min(4, Math.max(q.x1 - q.x0, q.z1 - q.z0)) }); } }
      if (lounge && rg() < 0.7) putAt(K, 'band_stage', (r.x0 + r.x1) / 2, r.z0 + 2.2, 0, { w: Math.min(6, W - 4), d: 3.0 });
      const m = inner(K, 1.3);
      const cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
      const hole = !piano && W >= 9 && D >= 9 && (lounge || rg() < 0.5);
      if (hole) putAt(K, lounge ? 'piano_bar' : 'bar_island', cx, cz, 0, lounge ? {} : { w: Math.min(5, W - 6), d: 2.4 });
      lattice(K, lounge ? 'lounge_set' : (rg() < 0.5 ? 'lounge_set' : 'high_table'), m.x0, m.x1, m.z0, m.z1, lounge ? 4.2 : 3.6, lounge ? 3.8 : 3.4, {}, 0, (x, z) => (piano || hole || (W >= 9 && D >= 9)) && Math.abs(x - cx) < 3.6 && Math.abs(z - cz) < 3.4);
    }
  });
  perimeter(K, club ? 'planter' : 'bench_pax', 4.5);
  void ds;
  return { fill: ['high_table', 'planter', 'bench_pax'], dress: ['artwork', 'artwork'] };
}
function casinoKit(K, ctx) {
  const r = K.r, W = r.x1 - r.x0, D = r.z1 - r.z0, rg = mulb((ctx.seed || 1) + hashS(r.id));
  bulk(K, () => {
    K.wall('cashier_cage', { walls: notDoor(K, ['n', 's', 'e', 'w']), at: 'door', w: 3.4 });
    K.wall('bar_counter', { w: Math.min(5, W * 0.4), walls: notDoor(K, ['s', 'n', 'e', 'w']), at: 'end', front: 1.0 });
    const m = inner(K, 1.4), long = D > W * 1.25;
    // slot islands in one half, tables in the other (side by side in a wide room, end to end in a long one), a lane between
    const mid = long ? r.z0 + D * 0.5 : r.x0 + W * 0.52;
    const T = long ? { x0: m.x0, x1: m.x1, z0: mid + 1.0, z1: m.z1 } : { x0: mid + 1.0, x1: m.x1, z0: m.z0 + 1.2, z1: m.z1 };
    if (long) lattice(K, 'slot_island', m.x0, m.x1, m.z0 + 1.2, mid - 1.0, 3.8, 3.4); else lattice(K, 'slot_island', m.x0, mid - 1.0, m.z0 + 1.2, m.z1, 3.8, 3.4);
    const tables = ['blackjack', 'roulette', 'poker_table', 'baccarat_table', 'blackjack', 'roulette'];
    const nx = Math.max(0, Math.floor((T.x1 - T.x0) / 4.2)), nz = Math.max(0, Math.floor((T.z1 - T.z0) / 3.6));
    const ox = T.x0 + ((T.x1 - T.x0) - nx * 4.2) / 2 + 2.1, oz = T.z0 + ((T.z1 - T.z0) - nz * 3.6) / 2 + 1.8;
    let k = Math.floor(rg() * 3);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) putAt(K, tables[k++ % tables.length], ox + i * 4.2, oz + j * 3.6, 0);
    void rg;
  });
  return { fill: ['slot_island', 'blackjack', 'palm'], dress: ['artwork'] };
}

// ------------------------------------------------------------------------------------------------ shops, services, games, kids, spa
function shopKit(K, ctx) {
  const r = K.r, W = r.x1 - r.x0, rg = mulb((ctx.seed || 1) + hashS(r.id));
  K.wall('till', { walls: notDoor(K, ['n', 's', 'e', 'w']), at: 'door', front: 0.9 });
  bulk(K, () => {
    for (const s of ['n', 's', 'e', 'w']) { if (K.doors.some((d) => d.side === s)) continue; const along = s === 'n' || s === 's'; const len = along ? W : r.z1 - r.z0; for (let u = 0.8; u + 2.4 < len - 0.8; u += 2.5) K.wall('shop_wall', { walls: [s], at: (along ? r.x0 : r.z0) + u, front: 0.8 }); }
    const m = inner(K, 1.2);
    lattice(K, rg() < 0.5 ? 'display_case' : 'shop_gondola', m.x0, m.x1, m.z0 + 1.0, m.z1, 3.0, 2.8);
  });
  return { fill: ['display_table', 'display_case'], dress: ['artwork'] };
}
function guestServicesKit(K, ctx) {
  const r = K.r, W = r.x1 - r.x0, D = r.z1 - r.z0;
  const dining = r.venue === 'dining_foyer';
  if (dining) { bulk(K, () => { K.wall('host_stand', { walls: notDoor(K, ['n', 's', 'e', 'w']), at: 'center' }); K.wall('bench_pax', { walls: ['w', 'e'] }); K.wall('bench_pax', { walls: ['e', 'w'] }); K.wall('planter', { walls: ['n', 's'] }); K.wall('planter', { walls: ['s', 'n'] }); }); return { fill: ['planter', 'palm'], dress: ['artwork'] }; }
  bulk(K, () => {
    K.wall('reception_long', { w: Math.min(6, W - 2), walls: notDoor(K, ['n', 's', 'w', 'e']), at: 'center' });
    K.wall('queue_posts', { walls: notDoor(K, ['s', 'n']), at: 'center' });
    K.wall('info_screen', { walls: ['w', 'e', 'n', 's'] }); K.wall('kiosk', { walls: notDoor(K, ['w', 'e']), at: 'end' });
    lattice(K, 'bench_pax', r.x0 + 1, r.x1 - 1, r.z0 + D * 0.55, r.z1 - 0.8, 3.0, 2.4);
  });
  return { fill: ['planter', 'bench_pax'], dress: ['artwork', 'notice_board'] };
}
function artGalleryKit(K) {
  const r = K.r;
  bulk(K, () => {
    for (const s of notDoor(K, ['n', 's', 'e', 'w'])) { const along = s === 'n' || s === 's'; const len = along ? r.x1 - r.x0 : r.z1 - r.z0; for (let u = 0.8; u + 2.6 < len - 0.6; u += 3.0) K.wall('art_big', { walls: [s], at: (along ? r.x0 : r.z0) + u, w: 2.6, avoidWindows: false }); }
    const m = inner(K, 1.5); lattice(K, 'art_plinth', m.x0, m.x1, m.z0, m.z1, 3.2, 3.0);
    K.wall('reception_desk', { w: 2.4, walls: notDoor(K, ['n', 's', 'e', 'w']), at: 'door' });
  });
  return { fill: ['bench_pax', 'planter'], dress: [] };
}
function arcadeKit(K) {
  const r = K.r;
  bulk(K, () => {
    for (const s of notDoor(K, ['n', 's', 'e', 'w'])) { const along = s === 'n' || s === 's'; const len = along ? r.x1 - r.x0 : r.z1 - r.z0; for (let u = 0.8; u + 3 < len - 0.6; u += 3.1) K.wall('arcade_row', { walls: [s], at: (along ? r.x0 : r.z0) + u, front: 0.8 }); }
    const m = inner(K, 2.0); lattice(K, 'air_hockey', m.x0, m.x1, m.z0, m.z1, 3.4, 2.8);
    K.wall('bar_counter', { w: 3.0, walls: notDoor(K, ['s', 'n']), at: 'end', front: 1.0 });
  });
  return { fill: ['billiard', 'bench_pax'], dress: [] };
}
function cardRoomKit(K) {
  const r = K.r, m = inner(K, 1.0);
  bulk(K, () => { lattice(K, 'card_set', m.x0, m.x1, m.z0, m.z1, 2.8, 2.7); K.wall('bar_counter', { w: 2.8, walls: notDoor(K, ['s', 'n', 'e', 'w']), at: 'end', front: 1.0 }); K.wall('bookshelf', { walls: notDoor(K, ['e', 'w']) }); });
  void r;
  return { fill: ['card_set', 'planter'], dress: ['artwork'] };
}
function libraryPaxKit(K) {
  const r = K.r, m = inner(K, 1.0);
  bulk(K, () => {
    for (const s of notDoor(K, ['n', 's', 'e', 'w'])) { const along = s === 'n' || s === 's'; const len = along ? r.x1 - r.x0 : r.z1 - r.z0; for (let u = 0.6; u + 1.2 < len - 0.6; u += 1.3) K.wall('bookshelf', { walls: [s], at: (along ? r.x0 : r.z0) + u, front: 0.6 }); }
    lattice(K, 'reading_table', m.x0 + 0.8, m.x1 - 0.8, m.z0 + 0.8, m.z1 - 0.8, 3.4, 3.2);
    K.wall('armchair', { walls: notDoor(K, ['w', 'e']) });
  });
  return { fill: ['armchair', 'planter'], dress: [] };
}
function kidsKit(K, ctx) {
  const r = K.r, m = inner(K, 1.0), teen = /Teen/.test(r.name), W = r.x1 - r.x0;
  bulk(K, () => {
    if (teen) {
      for (const s of notDoor(K, ['n', 's', 'e', 'w'])) K.wall('arcade_row', { walls: [s], at: 'center', front: 0.8 });
      K.wall('billiard', { walls: [], at: 'center' }); lattice(K, 'lounge_set', m.x0 + 0.8, m.x1 - 0.8, m.z0 + 2.2, m.z1 - 0.8, 4.2, 3.8);
      K.wall('tv', { walls: ['n', 's'] });
    } else {
      lattice(K, 'ball_pit', m.x0, m.x1, m.z0, m.z1, 4.0, 4.0, {}, 0, (x, z, i, j) => (i + j) % 2 === 1);
      lattice(K, 'kids_table', m.x0, m.x1, m.z0, m.z1, 4.0, 4.0, {}, 0, (x, z, i, j) => (i + j) % 2 === 0);
      K.wall('bookshelf', { walls: notDoor(K, ['n', 's', 'e', 'w']) }); K.wall('play_soft', { walls: notDoor(K, ['s', 'n']) });
    }
    K.wall('reception_desk', { w: 2.0, walls: notDoor(K, ['n', 's', 'e', 'w']), at: 'door' });
  });
  void W; void ctx;
  return { fill: ['play_soft', 'kids_table', 'plant'], dress: ['artwork', 'artwork'] };
}
function spaKit(K) {
  const r = K.r, W = r.x1 - r.x0, D = r.z1 - r.z0, m = inner(K, 1.2);
  bulk(K, () => {
    K.wall('reception_desk', { w: 3.0, walls: notDoor(K, ['n', 's', 'e', 'w']), at: 'door' });
    // treatment rooms are open cubicles along the long wall; thermal suite: pool, saunas and loungers
    const alongX = W >= D; const walls = notDoor(K, alongX ? ['n', 's'] : ['w', 'e']);
    for (const s of walls.slice(0, 2)) { const len = alongX ? W : D; for (let u = 2.4; u + 2.2 < len - 1; u += 2.9) { K.wall('massage_bed', { walls: [s], at: (alongX ? r.x0 : r.z0) + u, front: 0.9 }); } }
    putAt(K, 'thermal_pool', (r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2, 0);
    for (const sx of [-1, 1]) putAt(K, 'sauna', (r.x0 + r.x1) / 2 + sx * 4.4, (r.z0 + r.z1) / 2 - 3.8, 0);
    lattice(K, 'relax_lounger', m.x0 + 1, m.x1 - 1, m.z0 + 2, m.z1 - 1, 1.6, 2.4, {}, 0, (x, z) => Math.abs(x - (r.x0 + r.x1) / 2) < 4 && Math.abs(z - (r.z0 + r.z1) / 2) < 4);
  });
  return { fill: ['plant', 'palm', 'relax_lounger'], dress: ['artwork'] };
}
function gymPaxKit(K) {
  const r = K.r, W = r.x1 - r.x0, D = r.z1 - r.z0, m = inner(K, 1.0);
  bulk(K, () => {
    const alongX = W >= D;
    for (const s of notDoor(K, alongX ? ['n', 's'] : ['w', 'e']).slice(0, 2)) { const len = alongX ? W : D; for (let u = 1.0; u + 1.1 < len - 1; u += 1.2) K.wall('treadmill', { walls: [s], at: (alongX ? r.x0 : r.z0) + u, front: 0.8 }); }
    lattice(K, 'bike', m.x0 + 1.4, m.x1 - 1.4, m.z0 + 3.6, m.z1 - 3.6, 1.0, 1.6, {}, 0, (x, z, i, j) => j % 3 === 2);
    lattice(K, 'weights', m.x0 + 1.4, m.x1 - 1.4, m.z0 + 3.6, m.z1 - 3.6, 2.4, 3.4, {}, 0, (x, z, i, j) => j % 3 !== 2 && false);
    lattice(K, 'yoga_mat', m.x0 + 1.4, m.x1 - 1.4, r.z1 - 3.6, r.z1 - 1.2, 2.4, 1.6);
    K.wall('weights', { walls: notDoor(K, ['e', 'w']), at: 'start' }); K.wall('rack_dumbbell', { walls: notDoor(K, ['e', 'w', 'n', 's']) });
    putAt(K, 'yoga_mat', (r.x0 + r.x1) / 2, r.z1 - 2.2, 0); putAt(K, 'yoga_mat', (r.x0 + r.x1) / 2 + 2.4, r.z1 - 2.2, 0);
    K.wall('water_cooler', { walls: notDoor(K, ['n', 's', 'e', 'w']) });
  });
  return { fill: ['weights', 'treadmill', 'bike'], dress: ['tv'] };
}
function iceRinkKit(K) {
  const r = K.r, W = r.x1 - r.x0, D = r.z1 - r.z0;
  bulk(K, () => {
    putAt(K, 'rink_ice', (r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2, 0, { w: Math.min(24, W - 3), d: Math.min(14, D - 3) });
    K.wall('bench_pax', { walls: ['n', 's'] }); K.wall('bench_pax', { walls: ['s', 'n'], at: 'end' }); K.wall('locker_row', { walls: notDoor(K, ['e', 'w']) });
  });
  return { fill: ['bench_pax'], dress: [] };
}

// ------------------------------------------------------------------------------------------------ crew and service
function crewMessKit(K, ctx) {
  const r = K.r, m = inner(K, 1.0), officer = /Officer/.test(r.name);
  bulk(K, () => {
    K.wall('buffet_line', { w: Math.min(5, r.x1 - r.x0 - 2), walls: notDoor(K, ['n', 's', 'e', 'w']), at: 'center', front: 1.0 });
    lattice(K, officer ? 'dining_set4' : 'crew_table', m.x0, m.x1, m.z0 + 2.4, m.z1, officer ? 3.2 : 3.0, officer ? 3.0 : 2.5);
    K.wall('coffee_corner', { walls: notDoor(K, ['e', 'w']) }); K.wall('tv', { walls: ['n', 's', 'e', 'w'] });
  });
  void ctx;
  return { fill: ['crew_table', 'plant'], dress: ['notice_board'] };
}
function crewBarKit(K) {
  const r = K.r, m = inner(K, 1.2);
  bulk(K, () => { K.wall('bar_counter', { w: Math.min(5, r.x1 - r.x0 - 2), walls: notDoor(K, ['n', 's', 'e', 'w']), at: 'center', front: 1.0 }); lattice(K, 'lounge_set', m.x0, m.x1, m.z0 + 1.6, m.z1, 4.4, 3.8); K.wall('tv', { walls: ['n', 's'] }); });
  return { fill: ['high_table', 'plant'], dress: ['notice_board'] };
}
function storeLargeKit(K, ctx) {
  const r = K.r, m = inner(K, 0.8), rg = mulb((ctx.seed || 1) + hashS(r.id));
  bulk(K, () => {
    const garb = /Garbage/.test(r.name);
    if (garb) { K.wall('compactor', { walls: notDoor(K, ['n', 's', 'e', 'w']), at: 'center' }); lattice(K, 'bin_big', m.x0, m.x1, m.z0, m.z1, 2.2, 2.0, {}, 0); return; }
    lattice(K, 'shelf_rack', m.x0, m.x1, m.z0, m.z1, 3.6, 2.1, { w: 3.2, d: 0.7 }, 0, (x, z, i, j) => false);
    lattice(K, rg() < 0.5 ? 'pallet_stack' : 'crate_stack', m.x0 + 1.0, m.x1 - 1.0, m.z0, m.z1, 3.6, 2.1, {}, 0, (x, z, i, j) => true);
  });
  return { fill: ['crate_stack', 'drum_stack'], dress: ['fire_ext'] };
}
function laundryPaxKit(K) {
  const r = K.r, m = inner(K, 1.0);
  bulk(K, () => {
    for (const s of notDoor(K, ['n', 's', 'e', 'w']).slice(0, 2)) { const along = s === 'n' || s === 's'; const len = along ? r.x1 - r.x0 : r.z1 - r.z0; for (let u = 0.8; u + 1.4 < len - 0.6; u += 1.5) { K.wall('washer', { walls: [s], at: (along ? r.x0 : r.z0) + u, w: 1.3, d: 1.2, h: 1.4 }); } }
    lattice(K, 'laundry_press', m.x0 + 1.5, m.x1 - 1.5, m.z0 + 2.8, m.z1 - 1.2, 3.6, 2.6);
    K.wall('ironing_board', { walls: notDoor(K, ['e', 'w', 'n', 's']) }); K.wall('shelf_rack', { walls: notDoor(K, ['e', 'w']) });
  });
  return { fill: ['trolley', 'crate_stack'], dress: [] };
}

// ------------------------------------------------------------------------------------------------ open decks
function poolDeckKit(K, ctx) {
  const r = K.r, W = r.x1 - r.x0, D = r.z1 - r.z0, cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2, rg = mulb((ctx.seed || 1) + hashS(r.id));
  const pw = Math.min(11, W * 0.5), pd = Math.min(5.6, D * 0.3);
  bulk(K, () => {
    // the main pool with two hot tubs, a pool bar, and rows of loungers either side
    putAt(K, 'pool_water', cx, cz, 0, { w: pw, d: pd, front: 0.8 });
    putAt(K, 'hot_tub', cx - pw / 2 - 2.6, cz, 0); putAt(K, 'hot_tub', cx + pw / 2 + 2.6, cz, 0);
    putAt(K, 'pool_bar', cx, r.z1 - 3.0, 0, { rot: 0 });
    const pz0 = cz - pd / 2 - 1.2, pz1 = cz + pd / 2 + 1.2;
    scatterLoungers(K, 'lounger_pair', 2.6, r.x0 + 1.0, r.x1 - 1.0, r.z0 + 1.2, pz0);
    scatterLoungers(K, 'lounger_pair', 2.6, r.x0 + 1.0, r.x1 - 1.0, pz1, r.z1 - 5.6);
    for (let z = r.z0 + 6; z < r.z1 - 4; z += 9) { putAt(K, 'palm', r.x0 + 1.2, z, 0); putAt(K, 'palm', r.x1 - 1.2, z, 0); }
    for (let i = 0; i < 4; i++) { const x = r.x0 + 2.0 + ((W - 4) * (i + 0.5)) / 4, z = r.z0 + 2.4; K.P.prop('k2', { item: 'parasol', x: r2(x), y: r2(r.y), z: r2(z), rotY: 0, w: 2.6, d: 2.6, h: 2.5, room: r.id, var: 0 }); }
    for (const sx of [-1, 1]) K.wall('planter', { walls: [sx < 0 ? 'w' : 'e'], at: 'center' });
    if (rg() < 0.5) K.P.prop('k2', { item: 'movie_screen', x: r2(cx), y: r2(r.y + 0.2), z: r2(r.z0 + 0.4), rotY: 0, w: 7.5, d: 0.4, h: 4.0, room: r.id, var: 0 });
  });
  info(K, 'Pool deck — sun, swimming and the poolside bar', cx + pw / 2 + 1.0, cz + pd / 2 + 1.6);
  return { fill: [], dress: [] };
}
function waterDeckKit(K, ctx) {
  const r = K.r, W = r.x1 - r.x0, D = r.z1 - r.z0, cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
  bulk(K, () => {
    // slide towers aft with their tubes running forward into the splash pool
    const towers = clamp(Math.floor((W - 4) / 5), 1, 4);
    for (let i = 0; i < towers; i++) {
      const x = r.x0 + 3 + ((W - 6) * (i + 0.5)) / towers, tz = r.z1 - 3;
      putAt(K, 'slide_tower', x, tz, 0);
      K.P.prop('k2', { item: 'slide_run', x: r2(x), y: r2(r.y), z: r2(tz - 9), rotY: 0, w: 3, d: 14, h: 8, room: r.id, var: i });
    }
    putAt(K, 'pool_water', cx, cz - 2, 0, { w: Math.min(12, W - 4), d: Math.min(6, D * 0.28) });
    putAt(K, 'hot_tub', cx - 8, cz + 4, 0); putAt(K, 'hot_tub', cx + 8, cz + 4, 0);
    lattice(K, 'lounger_pair', r.x0 + 1.0, r.x1 - 1.0, r.z0 + 1.2, r.z0 + 5.0, 2.6, 2.6);
    putAt(K, 'pool_water', cx, r.z0 + D * 0.78, 0, { w: Math.min(10, W - 6), d: 5 });
    putAt(K, 'pool_bar', cx, r.z0 + D * 0.62, 0);
    for (let x = r.x0 + 4; x < r.x1 - 3; x += 8) K.P.prop('k2', { item: 'parasol', x: r2(x), y: r2(r.y), z: r2(r.z0 + D * 0.5), rotY: 0, w: 2.6, d: 2.6, h: 2.5, room: r.id, var: 0 });
    scatterLoungers(K);
    for (let z = r.z0 + 4; z < r.z1 - 3; z += 9) { putAt(K, 'palm', r.x0 + 1.2, z, 0); putAt(K, 'palm', r.x1 - 1.2, z, 0); }
  });
  return { fill: [], dress: [] };
}
function sportsDeckKit(K, ctx) {
  const r = K.r, W = r.x1 - r.x0, D = r.z1 - r.z0, cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2, rg = mulb((ctx.seed || 1) + hashS(r.id));
  const mini = rg() < 0.5;
  bulk(K, () => {
    putAt(K, 'sports_court', cx, cz, 0, { w: Math.min(15, W - 4), d: Math.min(8, D * 0.35) });
    for (const sx of [-1, 1]) K.P.prop('k2', { item: 'hoop', x: r2(cx + sx * (Math.min(15, W - 4) / 2 - 0.5)), y: r2(r.y), z: r2(cz), rotY: sx > 0 ? -Math.PI / 2 : Math.PI / 2, w: 1.0, d: 0.8, h: 3.4, room: r.id, var: 0 });
    if (mini) for (let i = 0; i < 3; i++) putAt(K, 'mini_golf', cx - 4 + i * 4, r.z0 + 3.0, 0, { w: 3.6, d: 2.4 });
    putAt(K, 'climb_wall', cx - 6, r.z1 - 1.2, 0, { w: 6, h: 9 });
    putAt(K, 'rope_course', cx + 4, r.z1 - 4.5, 0);
    lattice(K, 'lounger_pair', r.x0 + 1.0, r.x1 - 1.0, r.z1 - 8.0, r.z1 - 1.0, 2.6, 2.6, {}, 0, (x) => x > cx - 9 && x < cx + 9);
    for (const sx of [-1, 1]) K.wall('bench_pax', { walls: [sx < 0 ? 'w' : 'e'], at: 'center' });
    // a second court, benches round the edge, loungers in every free corner
    putAt(K, 'sports_court', cx, r.z0 + D * 0.82, 0, { w: Math.min(12, W - 6), d: 6 });
    for (const sz of [-1, 1]) for (let x = r.x0 + 3; x < r.x1 - 2; x += 5) K.wall('bench_pax', { walls: [sz < 0 ? 'n' : 's'], at: x });
    scatterLoungers(K);
    for (let z = r.z0 + 5; z < r.z1 - 3; z += 9) { putAt(K, 'palm', r.x0 + 1.2, z, 0); putAt(K, 'palm', r.x1 - 1.2, z, 0); }
  });
  return { fill: [], dress: [] };
}
function sunDeckKit(K, ctx) {
  const r = K.r, W = r.x1 - r.x0, D = r.z1 - r.z0, cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2, rg = mulb((ctx.seed || 1) + hashS(r.id));
  const kind = r.venue;
  bulk(K, () => {
    if (kind === 'solarium') { K.P.prop('k2', { item: 'sun_dome', x: r2(cx), y: r2(r.y), z: r2(cz), rotY: 0, w: 8, d: 8, h: 3.2, room: r.id, var: 0 }); putAt(K, 'hot_tub', cx, cz, 0); lattice(K, 'lounger_pair', r.x0 + 1, r.x1 - 1, r.z0 + 1, r.z1 - 1, 2.6, 2.6, {}, 0, (x, z) => Math.hypot(x - cx, z - cz) < 5); return; }
    if (kind === 'climb') { putAt(K, 'climb_wall', cx - 4, r.z1 - 1.0, 0, { w: 6, h: 9 }); putAt(K, 'rope_course', cx + 3, cz, 0); K.P.prop('k2', { item: 'zip_cable', x: r2(cx), y: r2(r.y), z: r2(r.z0 + 3), rotY: Math.PI / 2, w: Math.min(28, D - 4), d: 0.2, h: 6, room: r.id, var: 0 }); lattice(K, 'lounger_pair', r.x0 + 1, r.x1 - 1, r.z0 + 1, r.z1 - 5, 2.6, 2.6, {}, 0, (x) => Math.abs(x - cx) < 6); return; }
    // sun deck: jogging track round the edge, loungers in rows, a pool bar, mini golf or a court
    putAt(K, 'pool_water', cx, cz, 0, { w: Math.min(9, W - 6), d: 4.4 });
    putAt(K, 'pool_bar', cx, cz + 5, 0);
    lattice(K, 'lounger_pair', r.x0 + 1.5, r.x1 - 1.5, r.z0 + 1.2, cz - 3.2, 2.6, 2.6);
    lattice(K, 'lounger_pair', r.x0 + 1.5, r.x1 - 1.5, cz + 7.5, r.z1 - 1.2, 2.6, 2.6);
    if (rg() < 0.5) putAt(K, 'mini_golf', cx, r.z0 + 3.0, 0, { w: 6, d: 2.4 });
  });
  return { fill: [], dress: [] };
}

// ---- scalable versions of the small-ship kits (medical centre, conference, workshop, plant, office)
function medicalPaxKit(K) {
  const r = K.r, m = inner(K, 0.9);
  bulk(K, () => {
    K.wall('reception_desk', { w: 2.4, walls: notDoor(K, ['n', 's', 'e', 'w']), at: 'door' });
    lattice(K, 'hospital_bed', m.x0, m.x1, m.z0 + 1.6, m.z1, 3.2, 2.8);
    for (let k = 0; k < 3; k++) K.wall('medicine_cab', { walls: notDoor(K, ['n', 's', 'e', 'w']) });
    K.wall('desk_office', { walls: notDoor(K, ['e', 'w', 'n', 's']) }); K.wall('first_aid_box', { walls: ['n', 's', 'e', 'w'] });
  });
  void r;
  return { fill: ['hospital_bed', 'medicine_cab', 'chair'], dress: ['first_aid_box'] };
}
function conferencePaxKit(K) {
  const m = inner(K, 1.0);
  bulk(K, () => {
    K.wall('tv', { w: 1.8, walls: notDoor(K, ['n', 's']), at: 'center' }); K.wall('sideboard', { walls: notDoor(K, ['e', 'w']) });
    lattice(K, 'reading_table', m.x0, m.x1, m.z0 + 1.2, m.z1, 3.2, 2.8);
  });
  return { fill: ['plant', 'chair'], dress: ['artwork'] };
}
function workshopPaxKit(K) {
  const r = K.r, m = inner(K, 1.0), bench = ['workbench', 'lathe', 'drill_press', 'welding_bench'];
  bulk(K, () => {
    for (const s of notDoor(K, ['n', 's', 'e', 'w'])) { const along = s === 'n' || s === 's'; const len = along ? r.x1 - r.x0 : r.z1 - r.z0; let k = 0; for (let u = 0.8; u + 2.0 < len - 0.8; u += 2.3) K.wall(bench[k++ % 4], { walls: [s], at: (along ? r.x0 : r.z0) + u, front: 0.9 }); }
    lattice(K, 'spares_rack', m.x0 + 2.2, m.x1 - 2.2, m.z0 + 2.4, m.z1 - 2.4, 3.2, 3.4);
  });
  return { fill: ['spares_rack', 'crate_stack'], dress: ['fire_ext'] };
}
function plantPaxKit(K) {
  const m = inner(K, 1.2), ids = ['skid', 'fuel_module', 'boiler_aux', 'air_compressor', 'cooler_plate'];
  bulk(K, () => {
    let k = 0;
    for (let z = m.z0; z + 2.4 <= m.z1; z += 3.2) for (let x = m.x0; x + 3.0 <= m.x1; x += 3.8) { const id = ids[k++ % ids.length]; putAt(K, id, x + 1.5, z + 1.2, 0); }
  });
  return { fill: ['air_receiver', 'pump_v'], dress: ['fire_ext'] };
}
function officePaxKit(K) {
  const m = inner(K, 0.9);
  bulk(K, () => { lattice(K, 'desk_set', m.x0, m.x1, m.z0, m.z1, 2.8, 2.6); K.wall('cabinet_file', { walls: notDoor(K, ['n', 's', 'e', 'w']) }); K.wall('printer', { walls: notDoor(K, ['e', 'w']) }); K.wall('notice_board', { walls: ['n', 's'] }); });
  return { fill: ['plant', 'cabinet_file'], dress: ['notice_board'] };
}

export const CRUISE_KITS = {
  cabin_pax: cabinPaxKit, street: streetKit, atrium: atriumKit, gallery: galleryKit, theatre: theatreKit, theatre_balcony: theatreBalconyKit, cinema: cinemaKit,
  restaurant: restaurantKit, galley_pax: galleyPaxKit, bar: barKit, cafe: barKit, club: barKit, casino: casinoKit, shop: shopKit, guest_services: guestServicesKit,
  art_gallery: artGalleryKit, arcade: arcadeKit, card_room: cardRoomKit, library_pax: libraryPaxKit, kids: kidsKit, spa: spaKit, gym_pax: gymPaxKit, ice_rink: iceRinkKit,
  medical_pax: medicalPaxKit, conference_pax: conferencePaxKit, workshop_pax: workshopPaxKit, plant_pax: plantPaxKit, office_pax: officePaxKit,
  crew_mess: crewMessKit, crew_bar: crewBarKit, store_large: storeLargeKit, laundry_pax: laundryPaxKit,
  pool_deck: poolDeckKit, water_deck: waterDeckKit, sports_deck: sportsDeckKit, sun_deck: sunDeckKit,
};
void SCALE;
