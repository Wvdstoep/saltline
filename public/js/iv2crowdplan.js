// Interiors v2 — the guests of a cruise ship: who is where, when (docs/CRUISE-CONTRACT.md §6). Pure and deterministic: no
// three.js, no DOM, no Math.random, no per-frame state. Everything is a function of (ship seed, room, slot, hour):
//
//   shipDensity(guests)           0.08 … 1 — how crowded the ship feels (150 guests: 0.19, 1,250: 0.44, 7,000+: 1)
//   occupancy(kind, hour)         0 … 1 — the share of a venue's places taken at a time of day (shows, meals, night clubs …)
//   spotsOfProp(prop)             the places an item offers (a dining set: 4 seats; a bar island: 2 barmen, 10 stools …)
//   crowdForRoom(plan, room, ctx) the agents of one room for an hour: seated / standing / dancing / swimming / lying /
//                                 performing / staff, plus the walkers and waiters that roam it
//   lookOf(seed, role)            a guest's or crew member's looks (skin, hair, clothes, height, build)
//   agentPose(agent, t)           position, heading and pose of an agent at time t (walkers follow their path analytically)
//   findPath(isFree, a, b, cell)  A* on a grid the host supplies (the walk map): waypoints from a to b
//   budgetFor(phone)              how many people are drawn: ≤ CROWD.max near the player, the rest not at all
// The renderer (iv2crowd.js) draws what this module decides; walking, sitting and swimming never touch the server.
import { ITEMS } from './iv2items.js';

export const CROWD = Object.freeze({
  desk: Object.freeze({ max: 110, radius: 24, polys: 110, calls: 11 }),
  phone: Object.freeze({ max: 32, radius: 12, polys: 100, calls: 6 }),
});
/** The budget of the renderer: people, radius (m) and pose meshes (draw calls) for desktop / phone. */
export const budgetFor = (phone) => (phone ? CROWD.phone : CROWD.desk);

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const r2 = (v) => Math.round(v * 100) / 100;
/** FNV-1a of a string. */
export function hashStr(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
/** Deterministic uniform [0, 1) from a few keys. */
export function hash01(...keys) { let h = 2166136261 >>> 0; for (const k of keys) { const s = String(k); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } h ^= 0x9e37; h = Math.imul(h, 2654435761) >>> 0; } h ^= h >>> 15; h = Math.imul(h, 2246822519) >>> 0; h ^= h >>> 13; return (h >>> 0) / 4294967296; }
export function rngOf(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ------------------------------------------------------------------------------------------------ density and time of day
/** How crowded the ship feels: the share of places taken scales with the guest list (a 7,000-guest ship is busy, a 150-guest one is quiet). */
export function shipDensity(guests) { return r2(clamp(0.08 + 0.92 * Math.pow(Math.max(0, guests) / 7000, 0.55), 0.08, 1)); }
/** Crew on show relative to a big ship (staff at bars, galleys, desks). */
export function crewDensity(crew) { return r2(clamp(0.3 + 0.7 * Math.pow(Math.max(0, crew) / 2300, 0.5), 0.3, 1)); }

// Venue kinds → [base, [peak hour, width h, amplitude] …]: a smooth day curve (times in ship's local hours).
const CURVES = {
  dining: [0.05, [[8, 1.2, 0.5], [12.8, 1.3, 0.7], [19.2, 1.8, 0.85]]],
  spec: [0.0, [[19.5, 1.6, 0.75], [13, 1.0, 0.3]]],
  buffet: [0.12, [[8, 1.5, 0.7], [13, 1.5, 0.85], [18.8, 1.2, 0.55]]],
  court: [0.18, [[12.5, 1.5, 0.65], [19, 1.5, 0.45]]],
  bar: [0.08, [[12, 1.5, 0.3], [17.5, 1.5, 0.5], [22, 2.2, 0.65]]],
  lounge: [0.1, [[15.5, 2, 0.4], [22, 2.5, 0.55]]],
  club: [0.0, [[0.5, 3, 0.85], [23.5, 2.5, 0.7]]],
  casino: [0.1, [[15, 3, 0.35], [22, 3, 0.8], [1, 2.5, 0.55]]],
  theatre: [0.0, [[18.7, 0.9, 0.92], [21.7, 0.9, 0.92]]],
  cinema: [0.0, [[15, 1.5, 0.55], [20, 2, 0.5]]],
  shop: [0.0, [[11, 2.5, 0.5], [16.5, 2.5, 0.6]]],
  spa: [0.04, [[10.5, 2.5, 0.6], [15.5, 2.5, 0.5]]],
  gym: [0.1, [[7, 1.2, 0.6], [17.5, 1.5, 0.55]]],
  kids: [0.0, [[10, 2, 0.6], [15.5, 2, 0.55]]],
  teens: [0.0, [[16, 2, 0.5], [21, 2, 0.5]]],
  pool: [0.0, [[13.2, 3.4, 1.0]]],
  sun: [0.0, [[13, 3.2, 0.75]]],
  sports: [0.0, [[10.5, 2, 0.6], [16, 2.5, 0.6]]],
  quiet: [0.05, [[15, 3, 0.35], [21, 2, 0.3]]],
  street: [0.1, [[10, 2.5, 0.55], [16, 3, 0.65], [20.5, 2.5, 0.7]]],
  corridor: [0.05, [[8, 1, 0.12], [18, 1.5, 0.15]]],
  galley: [0.15, [[7, 1.5, 0.8], [11.5, 2, 1], [17, 2.5, 1]]],
  crewmess: [0.08, [[7, 1.5, 0.5], [12, 1.2, 0.6], [19, 1.2, 0.6], [0, 1.2, 0.4]]],
  crewbar: [0.0, [[22, 3, 0.6]]],
  work: [0.35, [[10, 3, 0.5], [15, 3, 0.5]]],
  bridge: [1, []],
  prom: [0.0, [[11, 3, 0.5], [17, 2, 0.4]]],
};
const dh = (a, b) => { const d = Math.abs(a - b) % 24; return Math.min(d, 24 - d); };
/** The share (0…1) of a venue's places taken at `hour`. */
export function occupancy(kind, hour) {
  const c = CURVES[kind] || CURVES.quiet;
  let v = c[0];
  for (const [p, w, a] of c[1]) { const x = dh(hour, p) / w; v += a * Math.exp(-x * x); }
  return r2(clamp(v, 0, 1));
}
/** Is the main theatre's show on (so the audience applauds now and then and the stage is lit)? */
export function showOn(hour) { return dh(hour, 18.7) < 0.7 || dh(hour, 21.7) < 0.7; }

/** The venue kind (a key of CURVES) of a room. */
export function kindOfRoom(r) {
  const sp = r.space || '', v = r.venue || '';
  if (sp === 'restaurant') return v === 'spec' ? 'spec' : 'dining';
  if (sp === 'buffet') return 'buffet';
  if (sp === 'cafeteria') return 'court';
  if (sp === 'cafe') return 'bar';
  if (sp === 'bar') return 'bar';
  if (sp === 'lounge_pax') return v === 'solarium' ? 'spa' : 'lounge';
  if (sp === 'nightclub') return 'club';
  if (sp === 'casino') return 'casino';
  if (sp === 'theatre' || sp === 'theatre_balcony') return 'theatre';
  if (sp === 'cinema') return 'cinema';
  if (sp === 'shop' || sp === 'guest_services' || sp === 'art_gallery') return 'shop';
  if (sp === 'arcade') return 'teens';
  if (sp === 'spa') return 'spa';
  if (sp === 'gym_pax') return 'gym';
  if (sp === 'kids') return /Teen/.test(r.name || '') ? 'teens' : 'kids';
  if (sp === 'pool_deck' || sp === 'water_deck') return 'pool';
  if (sp === 'sun_deck') return 'sun';
  if (sp === 'sports_deck' || sp === 'ice_rink') return 'sports';
  if (sp === 'library_pax' || sp === 'card_room' || sp === 'conference_pax') return 'quiet';
  if (sp === 'promenade' || sp === 'atrium' || sp === 'atrium_gallery') return 'street';
  if (sp === 'corridor_pax') return 'corridor';
  if (sp === 'galley_pax' || sp === 'galley') return 'galley';
  if (sp === 'crew_mess' || sp === 'mess') return 'crewmess';
  if (sp === 'crew_bar') return 'crewbar';
  if (sp === 'crew_alley' || sp === 'laundry_pax' || sp === 'store_large' || sp === 'workshop_pax' || sp === 'plant_pax' || sp === 'office_pax' || sp === 'medical_ward' || sp === 'medical_pax') return 'work';
  if (sp === 'bridge') return 'bridge';
  if (sp === 'open_deck') return 'prom';
  return null;
}
/** Rooms whose people are crew (staff) rather than guests. */
export const isCrewRoom = (r) => ['galley_pax', 'galley', 'crew_mess', 'crew_bar', 'crew_alley', 'laundry_pax', 'store_large', 'workshop_pax', 'plant_pax', 'office_pax', 'medical_ward', 'medical_pax', 'bridge', 'mess'].includes(r.space);

// ------------------------------------------------------------------------------------------------ looks
export const SKINS = [0xf1c8a5, 0xe0b48f, 0xc68e63, 0x9a6640, 0x6e4529, 0xf5d6bc, 0xd9a67a, 0x8a5a3a];
export const HAIRS = [0x151210, 0x2a1d14, 0x4a3320, 0x8a6a3a, 0xc8a85a, 0x9a9a9a, 0xe0e0e0, 0x8a3a1a];
const DAY_TOPS = [0xf2f2ec, 0x2f6a9a, 0xd9534f, 0x5cb85c, 0xf0ad4e, 0x7d5ba6, 0x1f4e79, 0xe8c547, 0x3aa6a6, 0xf08cae, 0x8bc34a, 0xff7043];
const EVE_TOPS = [0x14213d, 0x6a1b3a, 0x1f3a2d, 0x2b2b3a, 0x7a2e2e, 0x3a2f5b, 0xe5e5e5, 0x0b3d5c, 0xa07a2b, 0x222222];
const BOTTOMS = [0x1f2a3a, 0x2a2a2a, 0x3b3f46, 0x4a3a2a, 0x23395b, 0xb7a98a, 0x5a5a5a, 0x6b7a8f];
const SWIM = [0xe53935, 0x1e88e5, 0xfdd835, 0x43a047, 0xff7043, 0x8e24aa, 0x00acc1, 0xf06292];
export const UNIFORMS = {
  waiter: { top: 0xf4f4f0, bottom: 0x1a1a1f }, barman: { top: 0xf4f4f0, bottom: 0x15151a }, cook: { top: 0xffffff, bottom: 0x3b3b44 }, officer: { top: 0xf4f4f0, bottom: 0x14213d },
  cleaner: { top: 0x2f6a9a, bottom: 0x23395b }, engineer: { top: 0xe6672b, bottom: 0xe6672b }, host: { top: 0x14213d, bottom: 0x14213d }, steward: { top: 0xf4f4f0, bottom: 0x14213d },
  dealer: { top: 0x6a1b3a, bottom: 0x15151a }, performer: { top: 0xc8a82b, bottom: 0x15151a }, nurse: { top: 0xdfeff2, bottom: 0xdfeff2 }, crew: { top: 0x2f6a9a, bottom: 0x23395b },
};
/**
 * A person's looks from a seed. role: 'guest' | 'kid' | 'swim' | a UNIFORMS key. evening = formal colours. → { skin, hair, top, bottom, h, w, shorts, sleeves, kid }
 * (colours are 0xRRGGBB; h / w are the height / width scales; shorts → bare shins; sleeves → bare forearms.)
 */
export function lookOf(seed, role = 'guest', evening = false) {
  const r = rngOf(seed ^ 0x51ed), pickA = (a) => a[Math.floor(r() * a.length)];
  const kid = role === 'kid', u = UNIFORMS[role];
  const skin = pickA(SKINS), old = r() < 0.2;
  const hair = old && r() < 0.6 ? pickA([0x9a9a9a, 0xe0e0e0]) : r() < 0.06 ? skin : pickA(HAIRS);
  let top, bottom, shorts = false, sleeves = false;
  if (u) { top = u.top; bottom = u.bottom; }
  else if (role === 'swim') { top = r() < 0.5 ? pickA(SWIM) : skin; bottom = pickA(SWIM); shorts = true; sleeves = true; }
  else { top = pickA(evening ? EVE_TOPS : DAY_TOPS); bottom = pickA(BOTTOMS); shorts = !evening && r() < 0.4; sleeves = !evening && r() < 0.45; }
  const h = kid ? 0.6 + r() * 0.18 : 0.93 + r() * 0.14, w = kid ? 0.78 + r() * 0.1 : 0.9 + r() * 0.26;
  return { skin, hair, top, bottom, h: r2(h), w: r2(w), shorts, sleeves, kid };
}

// ------------------------------------------------------------------------------------------------ spots of an item
const world = (p, lx, lz) => { const rot = p.rotY || 0, s = Math.sin(rot), c = Math.cos(rot); return [p.x + lx * c + lz * s, p.z - lx * s + lz * c]; };
/**
 * The places an item offers, in the ship frame: [{ k, x, z, y, yaw, item }]. Rows of seats (theatre_row / cinema_row) give a seat
 * every 0.55 m; everything else uses the item's own spots. kinds: sit stand bar lie dance swim play work.
 */
export function spotsOfProp(p) {
  const it = ITEMS[p.item]; if (!it) return [];
  const out = [], rot = p.rotY || 0, y = p.y || 0;
  const add = (k, lx, lz, yawL = 0, dy = 0) => { const [x, z] = world(p, lx, lz); out.push({ k, x: r2(x), z: r2(z), y: r2(y + dy), yaw: r2(rot + yawL), item: p.item }); };
  if (p.item === 'theatre_row' || p.item === 'cinema_row') {
    const w = p.w || it.w, n = Math.max(1, Math.floor(w / 0.55 + 1e-6));
    for (let i = 0; i < n; i++) add('sit', -w / 2 + (w * (i + 0.5)) / n, 0.1, 0, 0);
    return out;
  }
  if (p.item === 'bar_stools') { const w = p.w || it.w, n = Math.max(1, Math.round(w / 0.85)); for (let i = 0; i < n; i++) add('sit', -w / 2 + (w * (i + 0.5)) / n, 0, 0, 0); return out; }
  if (p.item === 'lounger_pair' || p.item === 'sun_lounger' || p.item === 'relax_lounger') { for (const s of it.spots || []) add(s[0], s[1], s[2], s[3]); return out; }
  for (const s of it.spots || []) add(s[0], s[1], s[2], s[3]);
  return out;
}

// ------------------------------------------------------------------------------------------------ the agents of a room
/** Which spot kinds a role plays: { pose, crew, role }. */
const KIND_ROLE = { sit: 'guest', stand: 'guest', bar: 'guest', lie: 'swim', dance: 'guest', swim: 'swim', play: 'performer', work: null };

/**
 * The agents of room `room` for ship `ctx` at `ctx.hour`: { id, role, look, mode, x, y, z, yaw, scale, room, path?, speed?, phase }.
 * ctx = { seed, hour, guests, crew, props (k2 props of the room), solids?, rnd? }. mode: 'sit' | 'stand' | 'bar' | 'lie' | 'dance' | 'swim'
 * | 'play' | 'work' | 'walk' | 'tray' | 'clean'.
 */
export function crowdForRoom(room, ctx) {
  const kind = kindOfRoom(room); if (!kind) return [];
  const hour = ctx.hour, dens = shipDensity(ctx.guests), cd = crewDensity(ctx.crew);
  const occ = occupancy(kind, hour), evening = hour >= 18 || hour < 5, show = kind === 'theatre' && showOn(hour);
  const out = [];
  const roomKey = `${ctx.seed}|${room.id}|${Math.floor(hour)}`;
  const crewRoom = isCrewRoom(room);
  const props = ctx.props || [];
  let n = 0;
  for (const p of props) {
    if (p.t !== 'k2') continue;
    for (const [si, s] of spotsOfProp(p).entries()) {
      const u = hash01(roomKey, p.x, p.z, si, s.item);
      let present = false, role = KIND_ROLE[s.k] ?? 'guest', mode = s.k;
      if (s.k === 'work') {
        // staff: barmen, cooks, dealers, hosts — fewer on a small ship, always some in a busy venue
        role = staffRole(room, p.item);
        present = u < Math.max(0.35, occ) * cd * (kind === 'bridge' ? 1 : 1.1);
      } else if (s.k === 'play') {
        present = show || (kind === 'club' && occ > 0.4) || (kind === 'lounge' && occ > 0.3 && u < 0.7) || (kind === 'bar' && occ > 0.35 && u < 0.5);
        role = 'performer';
      } else if (s.k === 'swim') present = u < occ * dens * 0.9;
      else if (s.k === 'lie') present = u < occ * dens * 1.15;
      else if (s.k === 'dance') present = u < occ * dens * 1.1 && (kind !== 'sports' || true);
      else present = u < occ * dens * (kind === 'theatre' ? 1.08 : 1);
      if (!present) continue;
      if (kind === 'kids' && s.k !== 'work') role = 'kid';
      if (crewRoom && s.k !== 'work') role = staffRole(room, p.item) || 'crew';
      if (mode === 'sit' && s.item && /bar_stools|slot_island|blackjack|poker/.test(s.item)) mode = 'sit';
      const id = `${room.id}:${n++}`;
      const lookRole = role === 'swim' || role === 'kid' || UNIFORMS[role] ? role : 'guest';
      out.push({ id, role, look: lookOf(hashStr(roomKey + id), lookRole, evening && lookRole === 'guest'), mode, x: s.x, y: s.y, z: s.z, yaw: s.yaw, room: room.id, kind, phase: hash01(id, 'ph') * 6.283, show });
    }
  }
  return out;
}
function staffRole(room, item) {
  if (room.space === 'bridge') return 'officer';
  if (/bar|piano/.test(item || '')) return 'barman';
  if (/roulette|blackjack|poker|cashier/.test(item || '')) return 'dealer';
  if (/galley|kitchen|oven|prep|dish/.test(item || '')) return 'cook';
  if (/host|reception|kiosk|queue/.test(item || '')) return 'host';
  if (room.space === 'medical_ward' || room.space === 'medical_pax') return 'nurse';
  if (/laundry|press/.test(item || '')) return 'crew';
  if (/massage|spa/.test(item || '')) return 'nurse';
  if (/buffet/.test(item || '')) return 'cook';
  return 'steward';
}

/** Roaming agents of a room (strollers, waiters, cleaners): need paths from the host's walk map; `count` of each is given. */
export function roamersFor(room, ctx) {
  const kind = kindOfRoom(room); if (!kind) return [];
  const hour = ctx.hour, dens = shipDensity(ctx.guests), cd = crewDensity(ctx.crew), occ = occupancy(kind, hour), evening = hour >= 18 || hour < 5;
  const A = (room.x1 - room.x0) * (room.z1 - room.z0), len = Math.max(room.x1 - room.x0, room.z1 - room.z0);
  const out = [], key = `${ctx.seed}|${room.id}|r|${Math.floor(hour)}`;
  const mk = (i, role, mode, speed) => { const id = `${room.id}:r${i}`; return { id, role, look: lookOf(hashStr(key + i), role, evening && role === 'guest'), mode, room: room.id, kind, speed, seedKey: `${key}|${i}`, phase: hash01(id, 'ph') * 6.283 }; };
  if (kind === 'street' || room.space === 'atrium_gallery') {
    const n = Math.round(clamp(A / 55, 1, 14) * occ * dens * 1.6);
    for (let i = 0; i < n; i++) out.push(mk(i, hash01(key, i, 'k') < 0.12 ? 'kid' : 'guest', 'walk', 0.9 + hash01(key, i, 's') * 0.7));
  } else if (kind === 'corridor') {
    const n = Math.round(clamp(len / 28, 0, 4) * occ * dens * 1.2 + (hash01(key, 'c') < 0.4 ? 1 : 0));
    for (let i = 0; i < n; i++) out.push(mk(i, i === 0 && hash01(key, 'st') < 0.5 ? 'steward' : 'guest', 'walk', 0.8 + hash01(key, i, 's') * 0.6));
  } else if (kind === 'pool' || kind === 'sun' || kind === 'sports' || kind === 'prom') {
    const n = Math.round(clamp(A / 120, 1, 9) * occ * dens * 1.2);
    for (let i = 0; i < n; i++) out.push(mk(i, 'swim', 'walk', 0.8 + hash01(key, i, 's') * 0.5));
  } else if (kind === 'dining' || kind === 'spec' || kind === 'buffet' || kind === 'court') {
    const n = Math.round(clamp(A / 110, 1, 6) * Math.max(0.25, occ) * cd * 1.2);
    for (let i = 0; i < n; i++) out.push(mk(i, 'waiter', 'tray', 0.8 + hash01(key, i, 's') * 0.4));
  } else if (kind === 'bar' || kind === 'lounge' || kind === 'club' || kind === 'casino') {
    const n = Math.round(clamp(A / 150, 0, 3) * Math.max(0.2, occ) * cd * 1.3);
    for (let i = 0; i < n; i++) out.push(mk(i, 'waiter', 'tray', 0.8 + hash01(key, i, 's') * 0.4));
  } else if (kind === 'galley' || kind === 'work') {
    const n = Math.round(clamp(A / 140, 0, 4) * occ * cd);
    for (let i = 0; i < n; i++) out.push(mk(i, kind === 'galley' ? 'cook' : 'crew', 'walk', 0.9 + hash01(key, i, 's') * 0.5));
  } else if (kind === 'shop' || kind === 'spa' || kind === 'gym') {
    const n = Math.round(clamp(A / 90, 0, 4) * occ * dens);
    for (let i = 0; i < n; i++) out.push(mk(i, 'guest', 'walk', 0.7 + hash01(key, i, 's') * 0.4));
  }
  if (kind === 'street' && hash01(key, 'cl') < 0.7) out.push(mk(99, 'cleaner', 'clean', 0.35));
  return out;
}

// ------------------------------------------------------------------------------------------------ paths (A*)
/**
 * A* on a grid. isFree(x, z) → bool tells whether a point can be stood on (the host binds the walk map); a and b are {x, z}; cell is
 * the grid step (m). Returns [{ x, z }…] from a to b (line-of-sight simplified) or null; the search is capped to `maxNodes`.
 */
export function findPath(isFree, a, b, cell = 0.5, maxNodes = 6000) {
  const key = (i, j) => i * 100003 + j, ci = (v) => Math.round(v / cell);
  const si = ci(a.x), sj = ci(a.z), gi = ci(b.x), gj = ci(b.z);
  if (si === gi && sj === gj) return [{ x: a.x, z: a.z }, { x: b.x, z: b.z }];
  const open = [[0, si, sj]], g = new Map([[key(si, sj), 0]]), from = new Map(), closed = new Set();
  let n = 0;
  const heap = open; // tiny binary heap
  const push = (e) => { heap.push(e); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  const D = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]];
  const h = (i, j) => Math.hypot(i - gi, j - gj);
  let found = false;
  while (heap.length && n++ < maxNodes) {
    const [, i, j] = pop(), k = key(i, j);
    if (closed.has(k)) continue; closed.add(k);
    if (i === gi && j === gj) { found = true; break; }
    for (const [di, dj, c] of D) {
      const ni = i + di, nj = j + dj, nk = key(ni, nj);
      if (closed.has(nk)) continue;
      if (!(ni === gi && nj === gj) && !isFree(ni * cell, nj * cell)) continue;
      if (di && dj && !(isFree((i + di) * cell, j * cell) && isFree(i * cell, (j + dj) * cell))) continue;   // no corner cutting
      const ng = g.get(k) + c;
      if (ng < (g.get(nk) ?? Infinity)) { g.set(nk, ng); from.set(nk, k); push([ng + h(ni, nj), ni, nj]); }
    }
  }
  if (!found) return null;
  const cells = []; let k = key(gi, gj);
  while (k !== undefined && k !== key(si, sj)) { const j = ((k % 100003) + 100003) % 100003, i = (k - j) / 100003; cells.push({ x: i * cell, z: (j > 50000 ? j - 100003 : j) * cell }); k = from.get(k); }
  cells.push({ x: si * cell, z: sj * cell }); cells.reverse();
  cells[0] = { x: a.x, z: a.z }; cells[cells.length - 1] = { x: b.x, z: b.z };
  // line-of-sight simplification
  const clear = (p, q) => { const d = Math.hypot(q.x - p.x, q.z - p.z), st = Math.max(1, Math.ceil(d / (cell * 0.6))); for (let t = 1; t < st; t++) if (!isFree(p.x + ((q.x - p.x) * t) / st, p.z + ((q.z - p.z) * t) / st)) return false; return true; };
  const out = [cells[0]]; let i = 0;
  while (i < cells.length - 1) { let j = cells.length - 1; while (j > i + 1 && !clear(cells[i], cells[j])) j--; out.push(cells[j]); i = j; }
  return out.map((p) => ({ x: r2(p.x), z: r2(p.z) }));
}
/** Total length and cumulative lengths of a polyline. */
export function pathLen(path) { const cum = [0]; for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z)); return { cum, total: cum[cum.length - 1] || 0 }; }
/** A point along a polyline that is walked there and back: distance s (any value) → { x, z, dx, dz, dir }. */
export function alongPath(path, cum, total, s) {
  if (!(total > 0.01)) return { x: path[0].x, z: path[0].z, dx: 0, dz: 1, dir: 1 };
  const m = ((s % (2 * total)) + 2 * total) % (2 * total), back = m > total, d = back ? 2 * total - m : m;
  let i = 1; while (i < cum.length - 1 && cum[i] < d) i++;
  const a = path[i - 1], b = path[i], seg = Math.max(1e-6, cum[i] - cum[i - 1]), t = (d - cum[i - 1]) / seg;
  const dx = (b.x - a.x) / seg, dz = (b.z - a.z) / seg;
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, dx: back ? -dx : dx, dz: back ? -dz : dz, dir: back ? -1 : 1 };
}

// ------------------------------------------------------------------------------------------------ poses over time
export const POSES = ['stand', 'walkA', 'walkB', 'sit', 'clapA', 'clapB', 'danceA', 'danceB', 'lie', 'swim', 'tray'];
/** The pose meshes drawn on a phone (the others alias onto them): fewer draw calls. */
export const PHONE_ALIAS = { clapA: 'sit', clapB: 'sit', danceB: 'danceA', walkB: 'walkA', tray: 'stand' };
/** The theatre applauds for 6 s in every 70. */
export const applauding = (t, phase) => ((t + phase * 11) % 70) > 64;
/**
 * Pose of an agent at time t (seconds): { pose, x, y, z, yaw (rad, 0 = facing +z of the ship frame), bob }. Walkers
 * (agent.path with agent.cum / agent.total) are moved along their path; seated / standing guests breathe and turn their
 * heads now and then; a performer plays, a dancer alternates two poses at 2 Hz.
 */
export function agentPose(a, t) {
  const ph = a.phase || 0;
  switch (a.mode) {
    case 'sit': {
      const clap = a.show && applauding(t, ph) ? ((Math.floor(t * 3 + ph) & 1) ? 'clapA' : 'clapB') : 'sit';
      return { pose: clap, x: a.x, y: a.y, z: a.z, yaw: a.yaw + Math.sin(t * 0.37 + ph) * 0.12, bob: 0 };
    }
    case 'stand': case 'bar': case 'work':
      return { pose: a.show && a.mode === 'stand' && applauding(t, ph) ? 'clapA' : 'stand', x: a.x, y: a.y, z: a.z, yaw: a.yaw + Math.sin(t * 0.29 + ph) * 0.18, bob: Math.sin(t * 1.3 + ph) * 0.004 };
    case 'lie': return { pose: 'lie', x: a.x, y: a.y, z: a.z, yaw: a.yaw, bob: 0 };
    case 'swim': return { pose: 'swim', x: a.x + Math.sin(t * 0.21 + ph) * 0.7, y: a.y, z: a.z + Math.cos(t * 0.17 + ph * 1.3) * 0.6, yaw: a.yaw + t * 0.15, bob: Math.sin(t * 1.1 + ph) * 0.05 };
    case 'dance': return { pose: ((Math.floor(t * 2 + ph) & 1) ? 'danceA' : 'danceB'), x: a.x + Math.sin(t * 0.5 + ph) * 0.25, y: a.y, z: a.z + Math.cos(t * 0.4 + ph) * 0.25, yaw: a.yaw + Math.sin(t * 0.6 + ph) * 0.8, bob: Math.abs(Math.sin(t * 4 + ph)) * 0.03 };
    case 'play': return { pose: (Math.floor(t * 2.5 + ph) & 1) ? 'danceA' : 'stand', x: a.x, y: a.y + (a.item === 'band_stage' ? 0.45 : 0), z: a.z, yaw: a.yaw, bob: 0 };
    case 'walk': case 'tray': case 'clean': {
      if (!a.path) return { pose: 'stand', x: a.x ?? 0, y: a.y ?? 0, z: a.z ?? 0, yaw: a.yaw ?? 0, bob: 0 };
      const s = (a.s0 || 0) + t * (a.speed || 1), P = alongPath(a.path, a.cum, a.total, s), step = Math.floor(s * 2.4) & 1;
      return { pose: a.mode === 'tray' ? 'tray' : step ? 'walkA' : 'walkB', x: P.x, y: a.y, z: P.z, yaw: Math.atan2(P.dx, P.dz), bob: Math.abs(Math.sin(s * 2.4 * Math.PI)) * 0.025 };
    }
    default: return { pose: 'stand', x: a.x, y: a.y, z: a.z, yaw: a.yaw || 0, bob: 0 };
  }
}
/**
 * Reaction to the player standing at (px, pz): within 3 m a standing or seated guest turns to look (yaw eased toward the player,
 * capped at 100° from where they face), and a walker within 1.2 m ahead steps aside (0.55 m to the side of its path) and slows.
 * Returns { yaw, dx, dz, slow }.
 */
export function react(a, pose, px, pz) {
  const dx = px - pose.x, dz = pz - pose.z, d = Math.hypot(dx, dz);
  const out = { yaw: pose.yaw, dx: 0, dz: 0, slow: 1 };
  if (d > 3.2 || d < 0.05) return out;
  const want = Math.atan2(dx, dz);
  if (a.mode === 'walk' || a.mode === 'tray' || a.mode === 'clean') {
    if (d < 1.3) { const side = Math.sign(Math.sin(pose.yaw - want)) || 1, k = (1.3 - d) / 1.3; out.dx = Math.cos(pose.yaw) * -side * 0.55 * k; out.dz = -Math.sin(pose.yaw) * -side * 0.55 * k; out.slow = 0.4; }
    else if (d < 2.2) out.yaw = pose.yaw + angleDiff(pose.yaw, want) * 0.35;
    return out;
  }
  if (a.mode === 'swim' || a.mode === 'lie') return out;
  const diff = angleDiff(pose.yaw, want), k = clamp(1 - (d - 1.0) / 2.2, 0, 1);
  out.yaw = pose.yaw + clamp(diff, -1.75, 1.75) * k * 0.8;
  return out;
}
export function angleDiff(a, b) { let d = (b - a) % (2 * Math.PI); if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; return d; }

// ------------------------------------------------------------------------------------------------ selection and budget
/**
 * Choose the agents drawn this frame: those within the budget's radius of (px, pz) in the walker's deck band, nearest first, at
 * most budget.max. `poses` = parallel array of current poses. → indices into agents.
 */
export function selectAgents(agents, poses, px, pz, py, budget) {
  const cand = [];
  for (let i = 0; i < agents.length; i++) {
    const p = poses[i]; if (!p) continue;
    if (Math.abs(p.y - py) > 1.2) continue;
    const d = Math.hypot(p.x - px, p.z - pz);
    if (d <= budget.radius) cand.push([d, i]);
  }
  cand.sort((a, b) => a[0] - b[0]);
  return cand.slice(0, budget.max).map((c) => c[1]);
}
/** Triangle estimate of `n` people on a desktop / phone build (≈ 100 per person). */
export const crowdTris = (n) => n * 100;
/** The local hour on the ship from the world clock (UTC seconds) and longitude (°). */
export function localHour(simTime, lon = 0) { return ((((simTime || 0) / 3600 + lon / 15) % 24) + 24) % 24; }

// ------------------------------------------------------------------------------------------------ pose meshes
// One shared mesh per pose, made of boxes (12 triangles each, 7-10 boxes: ≈ 85-120 per person). part: 0 skin, 1 hair, 2 top,
// 3 legs, 4 arms, 5 prop (tray). Heights are for a 1.7 m adult facing +z; instances scale it. A box is [part, w, h, d, x, y, z,
// rx, hang]: hang → hung from (x, y, z) at its top end and swung by rx about x; else centred there (rx about its centre).
const BX = (part, w, h, d, x, y, z, rx = 0, hang = false) => [part, w, h, d, x, y, z, rx, hang ? 1 : 0];
const HEAD = (y, z = 0) => [BX(0, 0.2, 0.24, 0.22, 0, y + 0.12, z), BX(1, 0.225, 0.15, 0.17, 0, y + 0.19, z - 0.03)];   // hair: the crown and the back of the head, so a person has a front
const STAND = (legL, legR, armL, armR, extra = []) => [
  BX(3, 0.15, 0.82, 0.17, -0.1, 0.82, 0, legL, true), BX(3, 0.15, 0.82, 0.17, 0.1, 0.82, 0, legR, true), BX(2, 0.42, 0.6, 0.24, 0, 1.12, 0),
  ...HEAD(1.42), BX(4, 0.1, 0.58, 0.12, -0.26, 1.4, 0, armL, true), BX(4, 0.1, 0.58, 0.12, 0.26, 1.4, 0, armR, true), ...extra];
const SIT = (armL, armR) => [
  BX(3, 0.15, 0.17, 0.44, -0.1, 0.52, 0.17), BX(3, 0.15, 0.17, 0.44, 0.1, 0.52, 0.17), BX(3, 0.13, 0.46, 0.14, -0.1, 0.25, 0.4), BX(3, 0.13, 0.46, 0.14, 0.1, 0.25, 0.4),
  BX(2, 0.42, 0.6, 0.24, 0, 0.8, -0.02), ...HEAD(1.1, -0.02), BX(4, 0.1, 0.52, 0.12, -0.26, 1.07, -0.02, armL, true), BX(4, 0.1, 0.52, 0.12, 0.26, 1.07, -0.02, armR, true)];
const LY = 0.36;   // lounger surface
export const PARTS = Object.freeze({
  stand: STAND(0, 0, 0.05, -0.05),
  walkA: STAND(-0.5, 0.5, 0.45, -0.45), walkB: STAND(0.5, -0.5, -0.45, 0.45),
  tray: STAND(0.12, -0.12, 0.08, -1.5, [BX(5, 0.34, 0.03, 0.26, 0.2, 1.37, 0.55)]),
  sit: SIT(-0.9, -0.9), clapA: SIT(-1.55, -1.55), clapB: SIT(-1.2, -1.9),
  danceA: STAND(-0.3, 0.3, -2.7, -2.7), danceB: STAND(0.3, -0.3, -2.7, -0.5),
  lie: [BX(3, 0.15, 0.14, 0.8, -0.09, LY + 0.1, 0.56), BX(3, 0.15, 0.14, 0.8, 0.09, LY + 0.1, 0.56), BX(2, 0.42, 0.22, 0.6, 0, LY + 0.12, -0.15),
    BX(0, 0.2, 0.22, 0.24, 0, LY + 0.14, -0.57), BX(1, 0.22, 0.1, 0.1, 0, LY + 0.2, -0.64), BX(4, 0.1, 0.1, 0.55, -0.27, LY + 0.1, -0.1), BX(4, 0.1, 0.1, 0.55, 0.27, LY + 0.1, -0.1)],
  swim: [BX(2, 0.42, 0.22, 0.55, 0, 0.0, -0.05), BX(0, 0.2, 0.22, 0.22, 0, 0.12, 0.34), BX(1, 0.22, 0.1, 0.22, 0, 0.2, 0.34), BX(4, 0.1, 0.1, 0.6, -0.27, 0.0, 0.42), BX(4, 0.1, 0.1, 0.5, 0.27, 0.05, -0.3)],
});
/** Boxes (hence 12 triangles each) in a pose mesh. */
export const poseBoxes = (pose) => (PARTS[pose] || PARTS.stand).length;
/** Triangles of a person in `pose`. */
export const poseTris = (pose) => poseBoxes(pose) * 12;
/** The pose meshes a build draws: all of POSES on a desktop, the aliased subset on a phone. */
export const posesFor = (phone) => (phone ? POSES.filter((p) => !PHONE_ALIAS[p]) : POSES.slice());
/** The pose to draw for an agent (clapping on its feet means cheering with the arms up). */
export function drawnPose(a, pose, phone) {
  let p = pose;
  if ((p === 'clapA' || p === 'clapB') && a.mode !== 'sit') p = 'danceA';
  return phone ? (PHONE_ALIAS[p] || p) : p;
}

// ------------------------------------------------------------------------------------------------ the sound of a room
/**
 * What the player hears of the crowd, from the people drawn around them: { murmur, music, splash, kind } all 0…1.
 * `near` counts agents by mode within 12 m; kind = the room's kindOfRoom; hour as for occupancy.
 */
export function soundMix(kind, hour, near) {
  const n = near || {}, talk = (n.sit || 0) + (n.stand || 0) + (n.bar || 0) + (n.walk || 0) + (n.tray || 0), dance = n.dance || 0, swim = (n.swim || 0) + (n.lie || 0) * 0.2;
  const murmur = clamp(Math.pow(talk / 40, 0.6) * 0.85 + Math.pow(dance / 20, 0.6) * 0.3, 0, 1);
  const live = kind === 'theatre' ? (showOn(hour) ? 1 : 0.05) : kind === 'club' ? (dance > 0 ? 1 : 0.3) : kind === 'bar' ? 0.5 : kind === 'casino' ? 0.7 : kind === 'dining' || kind === 'spec' ? 0.3 : kind === 'pool' || kind === 'sun' || kind === 'street' ? 0.35 : kind === 'lounge' ? 0.55 : 0;
  return { murmur: r2(murmur), music: r2(clamp(live * (0.25 + 0.75 * Math.min(1, (talk + dance) / 18)), 0, 1)), splash: r2(clamp(Math.pow(swim / 8, 0.6), 0, 1)), kind: kind || '' };
}
