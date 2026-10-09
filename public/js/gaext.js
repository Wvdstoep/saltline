// SHIPYARD H9: the exterior GA — Lane C's real general arrangement (shared/ships/ga.js) in the shape Lane B's generators
// (shipgen.js) read. docs/SHIPS-LANEB-PHASE2.md "The GA: who produces it" / docs/SHIPS-LANEC-PHASE2.md.
//
// Both lanes use the same frame (x starboard, y up with 0 at the waterline, z aft, bow at −L/2), so no coordinate
// conversion is needed; the records differ in shape and in a few numbers. Rule: everything the walkable deck plan
// (gaplan.js) is built from comes from ga.js — main dimensions, deck height, hull-body draught (Tk), the hull lines
// (hull.halfAt → ga.js hullHalf, so the plan's deck edge is the exterior's deck edge), house / tiers / bridge, funnel,
// casing, hatches and bays, cranes, boats, masts, mooring. Purely exterior detail that ga.js does not carry (livery
// resolution, stem / stern contour kinds, bulwarks, fenders, workboat gear, pools, cargo stacks of gas carriers, …) comes
// from the stub generator (gastub.js), which stays the fallback when ga.js throws for a model.
import { generalArrangement as planGA, hullHalf } from '../../shared/ships/ga.js';
import { generalArrangement as stubGA } from './gastub.js';

const r2 = (v) => Math.round(v * 100) / 100;
const TIER_USE = { main: 'mess', accom: 'cabins', ccr: 'ccr', officers: 'officers', public: 'public', lido: 'lido', crew: 'cabins' };
const CACHE = new Map();

/** Exterior GA of a model / variant id (null for sail classes and unknown ids). Same signature as ga.js. */
export function exteriorGA(cls, opts = {}) {
  const key = `${cls}|${opts.stage ?? 1}|${opts.livery ? JSON.stringify(opts.livery) : ''}`;
  if (CACHE.has(key)) return CACHE.get(key);
  const s = stubGA(cls, opts);
  let out = s;
  if (s) {
    let g = null;
    try { g = planGA(cls, opts); } catch (e) { console.warn('[gaext] ga.js failed, using the stub exterior for', cls, e); }
    if (g && g.gen !== 'sail') {
      try { out = merge(s, g); } catch (e) { console.warn('[gaext] merge failed for', cls, e); out = s; }
    }
  }
  if (CACHE.size > 200) CACHE.clear();
  CACHE.set(key, out);
  return out;
}

function merge(s, g) {
  const big = g.layout !== 'small';
  const out = { ...s, L: g.L, B: g.B, T: g.T, D: g.D, F: g.F, deckY: g.deckY, Cb: g.Cb, levels: g.levels, goto: g.goto, planGA: g };
  // hull: ga.js lines (breadth everywhere, deck edge, midbody, forecastle, hull-body draught); the stub's contour kinds
  const twin = g.hull.twin ? { hullB: g.hull.twin.hullB, gap: g.hull.twin.gap } : null;
  out.hull = { ...s.hull, mid: g.hull.mid, bowFrac: g.hull.bowFrac, fcsle: g.hull.fcsle, poop: g.hull.poop, twin, draftHull: g.Tk,
    ...(g.hull.bow === 'ice' ? { bow: 'ice' } : s.hull.bow === 'axe' ? { bow: g.hull.bow } : {}),   // an X-bow rakes the deck aft of the LOA end; the plan's deck runs to it
    ...(big ? { sheerFwd: 0, sheerAft: 0 } : {}),                    // big ships: flat main deck, as walked
    halfAt: twin ? null : (z, y) => hullHalf(g, z, y) };
  houseOf(out, s, g);
  // funnel / casing
  const f = g.funnel;
  if (f && f.kind !== 'none' && f.h > 0) out.funnel = { z: f.z, y: f.y, r: f.r, h: f.h, kind: f.kind === 'twin' && Math.abs(f.x || 0) > 0.5 ? (out.house ? 'side' : 'single') : f.kind };
  else if (f && f.kind === 'none') out.funnel = { z: 0, y: 0, r: 0, h: 0, kind: 'none' };
  if (g.casing) out.casing = { z0: g.casing.z0, z1: g.casing.z1, w: g.casing.w };
  out.cargo = cargoOf(s, g);
  out.deck = deckOf(out.deck, s, g);
  return out;
}

function houseOf(out, s, g) {
  const gb = g.bridge;
  if (g.house && g.house.tiers.length) { // merchant / offshore / ro-ro: aft or forward house, the nav tier on top
    const H = g.house, ts = H.tiers;
    const tiers = [];
    ts.forEach((t, i) => {
      const h = r2((ts[i + 1] ? ts[i + 1].y : t.y + t.h + 0.12) - t.y);
      if (t.use === 'bridge') { if (gb && gb.z1 < H.z1 - 1) tiers.push({ id: t.id, y: t.y, h, use: 'cabins', z0: gb.z1, z1: H.z1 }); return; }
      tiers.push({ id: t.id, y: t.y, h, use: TIER_USE[t.use] || 'cabins' });
    });
    out.house = { pos: H.pos, z0: H.z0, z1: H.z1, w: H.w, tiers, eyeY: H.eyeY };
    if (gb) out.bridge = { ...(s.bridge || {}), y: gb.y, h: gb.h, z0: gb.z0, z1: gb.z1, w: r2(gb.x1 - gb.x0), wings: gb.wings, wingTo: gb.wingTo, aftConsole: !!gb.aftConsole, consoles: gb.consoles, embedded: false };
    return;
  }
  if (g.pax) { // ferries and cruise ships: the passenger decks above the hull deck are the tiers; the bridge is embedded
    const H = g.house, decks = g.pax.decks.filter((d) => d.y >= g.deckY - 0.01 && d.use !== 'car' && d.use !== 'sun');
    const cruise = g.type === 'cruise', tiers = [];
    decks.forEach((d, i) => {
      const h = r2((decks[i + 1] ? decks[i + 1].y : d.y + d.h + 0.12) - d.y);
      const z0 = d.zones?.length ? Math.min(...d.zones.map((q) => q.z0)) : H.z0, z1 = d.zones?.length ? Math.max(...d.zones.map((q) => q.z1)) : H.z1;
      const use = d.use === 'cabin' ? (cruise ? 'balcony' : 'cabins') : TIER_USE[d.use] || 'cabins';
      if (gb && d.id === gb.deck) {
        tiers.push({ id: `${d.id}b`, y: d.y, h, use: 'bridge', z0: Math.min(z0, gb.z0), z1: gb.z1 });
        if (z1 > gb.z1 + 1) tiers.push({ id: d.id, y: d.y, h, use, z0: gb.z1, z1 });
      } else tiers.push({ id: d.id, y: d.y, h, use, z0, z1 });
    });
    out.house = { pos: 'mid', z0: H.z0, z1: H.z1, w: H.w, tiers, eyeY: H.eyeY };
    if (gb) out.bridge = { y: gb.y, h: gb.h, z0: gb.z0, z1: gb.z1, w: H.w, wings: gb.wings, wingTo: gb.wingTo, aftConsole: !!gb.aftConsole, embedded: true };
    const lido = g.pax.decks.find((d) => d.use === 'lido');
    if (s.deck.pool && lido) out.deck = { ...s.deck, pool: { ...s.deck.pool, y: lido.y } };
    return;
  }
  const sm = g.small, dh = sm?.dh;
  if (!sm || !dh || !gb) return;   // RIB: the stub's centre console
  const A = { id: 'A', y: g.deckY, h: r2(dh.h + 0.1), use: g.gen === 'motor_yacht' ? 'saloon' : 'mess' };
  out.house = { pos: s.house?.pos || 'fwd', z0: dh.z0, z1: dh.z1, w: dh.w, tiers: [A], eyeY: r2(gb.y + 1.6) };
  const w = r2(gb.x1 - gb.x0);
  if (sm.wh === 'front') { // wheelhouse at the front of the main-deck deckhouse
    out.house.tiers = [{ ...A, id: 'Ab', use: 'bridge', z0: dh.z0, z1: gb.z1 }, ...(dh.z1 > gb.z1 + 0.5 ? [{ ...A, z0: gb.z1, z1: dh.z1 }] : [])];
    out.bridge = { y: gb.y, h: gb.h, z0: gb.z0, z1: gb.z1, w: dh.w, wings: 'none', wingTo: 0, aftConsole: !!gb.aftConsole, embedded: true };
  } else if (sm.wh === 'flybridge') {
    out.bridge = { y: gb.y, h: gb.h, z0: gb.z0, z1: gb.z1, w, wings: 'none', wingTo: 0, aftConsole: false, embedded: true };
    out.deck = { ...s.deck, flybridge: { z0: gb.z0, z1: Math.max(gb.z1 + 2, gb.z0 + (dh.z1 - dh.z0) * 0.6), y: gb.y } };
  } else if (sm.wh === 'console') {
    // keep the stub's console
  } else {
    out.bridge = { ...(s.bridge || {}), y: gb.y, h: gb.h, z0: gb.z0, z1: gb.z1, w, wings: gb.wings || 'none', wingTo: gb.wingTo || 0, aftConsole: !!gb.aftConsole, embedded: false, allRound: s.bridge?.allRound ?? true };
  }
}

function cargoOf(s, g) {
  const c = g.cargo, dy = g.deckY;
  if (!c || !c.zones?.length) return s.cargo;
  if (c.kind === 'holds' && c.zones.every((z) => z.hatch)) return { ...s.cargo, kind: 'holds', zones: c.zones.map((z, i) => ({ id: `hold${i + 1}`, z0: z.hatch.z0, z1: z.hatch.z1, w: z.hatch.w, coaming: z.hatch.h })) };
  if (c.kind === 'bays' && s.cargo.kind === 'bays') return { ...s.cargo, zones: c.zones.map((z, i) => ({ id: `bay${i + 1}`, z0: z.z0, z1: z.z1, rows: z.rows, tiersHold: z.below, tiersDeck: z.tiers })) };
  if (c.kind === 'membrane' && c.trunk && s.cargo.kind === 'membrane') return { ...s.cargo, zones: c.zones.map((z, i) => ({ id: `tank${i + 1}`, z0: z.z0, z1: z.z1, w: c.trunk.w, trunkH: r2(Math.max(1, c.trunk.y - dy)) })) };
  if (c.kind === 'deck' && s.cargo.kind === 'deck') return { ...s.cargo, zones: c.zones.map((z, i) => ({ id: `deck${i + 1}`, z0: z.z0, z1: z.z1, w: z.w })) };
  return s.cargo;   // tanks, gas tanks, car decks, pens, hopper, fish hold: the stub's exterior forms
}

function deckOf(base, s, g) {
  const d = { ...base }, k = g.deck, dy = g.deckY;
  const knuckle = ['offshore', 'tug', 'motor_yacht', 'special'].includes(g.gen);
  // shipgen stows a deck crane's jib forward along the centreline: keep the stowed jib over the hull (short ships)
  const stow = (c) => (c.swl >= 200 || knuckle ? c.boom : r2(Math.max(4, Math.min(c.boom, (c.z - 1.6 + g.L / 2 - 2) / Math.cos(0.25)))));
  if (k.cranes?.length || s.deck.cranes.length) d.cranes = k.cranes.map((c) => ({ z: c.z, x: c.x, swl: c.swl, boom: stow(c), h: c.h, ped: c.ped }));
  d.swimPlatform = null;   // ga.js runs the hull and the walkable deck to the transom (no platform inside the LOA)
  if (k.boats?.length) d.boats = k.boats.map((b) => ({ ...b }));
  if (k.masts?.length) d.masts = k.masts.map((m) => ({ ...m }));
  if (k.mooring?.length) { const seen = new Set(); d.mooring = k.mooring.filter((m) => { const q = `${m.kind}|${m.z}`; if (seen.has(q)) return false; seen.add(q); return true; }).map((m) => ({ z: m.z, kind: m.kind, side: 'both', y: m.y })); }
  if (k.manifold) d.manifold = { ...k.manifold };
  if (k.hoseCranes?.length) d.hoseCranes = k.hoseCranes.map((h) => ({ ...h }));
  if (k.catwalk && s.deck.catwalk) d.catwalk = { ...s.deck.catwalk, z0: k.catwalk.z0, z1: k.catwalk.z1, x: k.catwalk.x, h: r2(Math.max(0.6, k.catwalk.y - dy)) };
  if (k.heli && s.deck.heli) d.heli = { ...s.deck.heli, z: k.heli.z, r: k.heli.r };
  if (d.pool) d.pool = { ...d.pool };
  return d;
}
