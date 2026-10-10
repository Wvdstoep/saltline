// Cruise ship deck layout (docs/CRUISE-CONTRACT.md §4). Pure and deterministic: no three.js, no DOM, no Math.random.
//
//   cruiseDeck(variantId | ga, deckId) → DeckSpec { deck, rooms, doors, links, voids, rails, meta }  (cached, frozen)
//   cruiseCounts(variantId)           → { cabins, byCategory, venues, … } of the whole ship (tests, spec sheet, jobs)
//   towerRect(ga, d, tower)           the stair tower / lobby rectangle of a deck (also used by gaplan.js planPax)
//
// The GA (ga.js) stays frozen: its hull, deck stack and stair towers are the envelope. This module cuts every deck of a
// cruise ship into real-scale spaces: a multi-deck atrium with galleries and a grand staircase, a theatre with a balcony,
// main dining rooms with their galley, a shopping street with bars, casino, nightclub and specialty restaurants, spa and
// fitness, kids' and teens' clubs, pool decks with slides and sports courts, crew spaces (galleys, provision stores,
// laundry, crew mess and bar, garbage room), and thousands of cabins in corridors (inside, ocean-view, balcony, suites,
// accessible). What a ship has comes from its programme (cruiseprofile.js); how it is arranged from its seed, so classes
// differ in layout, not only in scale.
//
// A room spec: { id, space, name, kind, use, x0, x1, z0, z1, y, h, open?, floor, wall, win: [{ side, from, to, bottom, top }],
// venue, balcony?, hw }. A door spec: { a, b, side, at, w, kind }. A link: { room, tower, end } = the room's `end` ('n' =
// its z0 edge, 's' = its z1 edge) touches that stair tower (gaplan.js opens it through the tower's walkway column).
import { generalArrangement, deckHalf, fitHalf, RULES, stairRun } from './ga.js';
import { cruiseProfile } from './cruiseprofile.js';
import { hashStr, rng } from './gaparams.js';

const r2 = (v) => Math.round(v * 100) / 100;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const { LAND } = RULES;
export const CABIN_W = 3.4, CREW_CABIN_W = 2.8, CORR_W = 1.6, STREET_HALF = 4.5, PROM_W = 2.4;

// ------------------------------------------------------------------------------------------------ geometry helpers
function halfFn(ga) {
  const X = ga.pax, B = ga.B;
  const minHb = (z0, z1) => { let m = Infinity; for (let i = 0; i <= 16; i++) m = Math.min(m, deckHalf(ga, Math.min(z0, z1) + (Math.abs(z1 - z0) * i) / 16)); return m; };
  const fit = (z0, z1, y, h) => (y >= ga.deckY - 0.05 ? Infinity : fitHalf(ga, z0, z1, y, Math.min(y + h, ga.deckY)) - 0.3);
  return (d, z0, z1) => {
    if (d.y < X.hullTop - 0.1) return Math.min(fit(z0, z1, d.y, d.h), B / 2 - 0.4);
    const m = minHb(z0, z1) - 0.3;
    return d.use === 'cabin' ? m - 1.5 : d.use === 'sun' || d.use === 'lido' ? m - 0.15 : m;
  };
}
/** The z span a deck's rooms cover (as gaplan.js planPax). */
export function deckSpan(ga, d) {
  const X = ga.pax, L = ga.L;
  if (d.y < X.hullTop - 0.1 || (d.use === 'crew' && d.y < X.hullTop + 3)) return [r2(-L * 0.4), r2(L * 0.4)];
  if (d.use === 'sun') return [r2(-L * 0.3), r2(L * 0.44)];
  return [r2(-L / 2 + 0.1 * L), r2(L / 2 - 0.06 * L)];
}
/** Cabin zone geometry at half-width hw: outer cabin depth, corridor width, and whether two corridors fit. */
export function cabinGeom(ga, d, hw) {
  const crew = d.use === 'crew';
  const dO = crew ? 3.6 : Math.min(5.6, Math.max(3.8, hw * 0.3)), cw = crew ? 1.3 : CORR_W;
  return { dO, cw, two: hw - dO - cw >= 3.4 + 2.2 };
}
const towerBase = (ga) => (ga.B > 26 ? 6.4 : ga.B > 16 ? 5.2 : 4.0);
/** The rectangle of a stair tower on deck d: { x0, x1, z0, z1, w }. */
export function towerRect(ga, d, t, half = halfFn(ga)) {
  const hw = half(d, t.z0, t.z1);
  let w = towerBase(ga);
  if (d.use === 'cabin' || d.use === 'crew') { const g = cabinGeom(ga, d, hw); w = g.two ? 2 * (hw - g.dO) : 2 * hw; }
  else if (d.use === 'public' || d.use === 'lido') w = Math.max(w, Math.min(2 * hw - 1, 12));
  w = r2(Math.min(2 * hw, w));
  return { id: t.id, x0: r2(-w / 2), x1: r2(w / 2), z0: t.z0, z1: t.z1, w };
}

/** Deck frame: the blocks between the stair towers and what each touches. */
export function deckFrame(ga, deckId) {
  const X = ga.pax, d = X.decks.find((q) => q.id === deckId); if (!d) return null;
  const half = halfFn(ga);
  let [z0, z1] = deckSpan(ga, d);
  const bridgeDeck = X.decks[X.bridgeDeck - 1];
  if (d.id === bridgeDeck.id) z0 = ga.bridge.z1;
  const ts = X.towers.filter((t) => t.z0 > z0 + 1 && t.z1 < z1 - 1);
  const towers = ts.map((t) => towerRect(ga, d, t, half));
  const blocks = []; let a = z0, prev = null;
  for (let i = 0; i <= ts.length; i++) {
    const t = ts[i], end = t ? t.z0 : z1;
    if (end - a > 1.5) blocks.push({ bi: blocks.length, z0: r2(a), z1: r2(end), fwd: prev ? prev.id : null, aft: t ? t.id : null, hw: r2(half(d, a, end)) });
    if (t) { a = t.z1; prev = t; }
  }
  const sameUse = X.decks.filter((q) => q.use === d.use);
  return { ga, d, X, half, z0, z1, towers, blocks, index: sameUse.indexOf(d), count: sameUse.length, prof: cruiseProfile(ga.model), seed: hashStr(`${ga.id}|${d.id}`) };
}

// ------------------------------------------------------------------------------------------------ spec builder
class SpecB {
  constructor(F) { this.F = F; this.d = F.d; this.rooms = []; this.doors = []; this.links = []; this.voids = []; this.rails = []; this.byId = new Map(); this.meta = {}; this.props = []; this.holes = []; }
  room(o) {
    const d = this.d, r = { kind: 'room', use: 'room', floor: 'carpet', wall: 'white', win: [], y: d.y, h: d.h, ...o };
    for (const k of ['x0', 'x1', 'z0', 'z1']) r[k] = r2(r[k]);
    if (r.x1 - r.x0 < 0.5 || r.z1 - r.z0 < 0.5) throw new Error(`[cruiselayout] ${this.F.ga.id}/${d.id}: room ${r.id} degenerate (${r.x0},${r.x1},${r.z0},${r.z1})`);
    if (this.byId.has(r.id)) throw new Error(`[cruiselayout] duplicate room ${r.id}`);
    this.rooms.push(r); this.byId.set(r.id, r);
    return r;
  }
  door(a, b, side, at, w = 1.0, kind = 'door', h = 2.05) { this.doors.push({ a: a.id ?? a, b: b ? (b.id ?? b) : null, side, at: r2(at), w: r2(w), kind, h }); }
  win(r, side, from, to, bottom = 0.9, top = 2.4) { if (to - from > 0.3) r.win.push({ side, from: r2(from), to: r2(to), bottom, top }); }
  link(r, end, tower) { if (tower) this.links.push({ room: r.id, tower, end }); }
  rail(pts) { this.rails.push(pts.map(([x, z]) => [r2(x), r2(z)])); }
  freeze() { return { deck: this.d.id, use: this.d.use, rooms: this.rooms, doors: this.doors, links: this.links, voids: this.voids, rails: this.rails, props: this.props, holes: this.holes, meta: this.meta }; }
}

// ------------------------------------------------------------------------------------------------ venue catalogue
// space = SCALE kind; area = [min, target, max] m²; win = has windows on the outer wall; names are picked by the seed.
export const VENUE = {
  shop: { space: 'shop', name: ['Duty-free shop', 'Boutique', 'Jewellery & watches', 'Fashion & accessories', 'Gift shop', 'Perfume & cosmetics', 'Sundries', 'Spirits & tobacco'], area: [60, 85, 140], win: false },
  bar: { space: 'bar', name: ['Harbour Bar', 'Piano Bar', 'Sky Pub', 'Cocktail Lounge', 'Sports Bar', 'Wine Bar', 'Brewhouse', 'Jazz Bar', 'Rooftop Bar'], area: [110, 170, 250], win: true },
  cafe: { space: 'cafe', name: ['Coffee House', 'Bakery Café', 'Gelato & Crêpes', 'Tea Room'], area: [70, 100, 150], win: true },
  lounge: { space: 'lounge_pax', name: ['Observation Lounge', 'Grand Lounge', 'Panorama Lounge', 'Starlight Lounge'], area: [160, 230, 320], win: true },
  casino: { space: 'casino', name: ['Casino'], area: [260, 330, 350], win: false },
  club: { space: 'nightclub', name: ['Nightclub', 'Dance Club', 'Late Lounge'], area: [230, 300, 350], win: false },
  spec: { space: 'restaurant', name: ['Steakhouse', 'Italian Trattoria', 'Sushi & Teppanyaki', 'Seafood Grill', 'French Bistro', 'Asian Kitchen', 'Chef\'s Table', 'Tapas Room'], area: [180, 260, 400], win: true },
  guest_services: { space: 'guest_services', name: ['Guest Services & Shore Excursions'], area: [60, 85, 130], win: false },
  art_gallery: { space: 'art_gallery', name: ['Art Gallery', 'Auction Gallery'], area: [70, 100, 150], win: false },
  photo_gallery: { space: 'shop', name: ['Photo Gallery'], area: [50, 75, 110], win: false },
  arcade: { space: 'arcade', name: ['Arcade'], area: [90, 130, 180], win: false },
  library: { space: 'library_pax', name: ['Library', 'Reading Room'], area: [90, 130, 200], win: true },
  card_room: { space: 'card_room', name: ['Card Room', 'Games Room'], area: [60, 90, 140], win: true },
  cinema: { space: 'cinema', name: ['Cinema', 'Cinema Under the Stars'], area: [150, 210, 280], win: false },
  kids: { space: 'kids', name: ['Kids\' Club'], area: [140, 190, 250], win: true },
  teens: { space: 'kids', name: ['Teen Lounge'], area: [100, 150, 200], win: true },
  medical: { space: 'medical_ward', name: ['Medical Centre'], area: [90, 120, 170], win: false },
  conference: { space: 'conference_pax', name: ['Conference Centre'], area: [90, 130, 200], win: false },
  spa: { space: 'spa', name: ['Spa & Thermal Suite'], area: [220, 300, 380], win: true },
  fitness: { space: 'gym_pax', name: ['Fitness Centre'], area: [250, 330, 420], win: true },
  solarium: { space: 'lounge_pax', name: ['Solarium'], area: [150, 220, 300], win: true },
  buffet: { space: 'buffet', name: ['Buffet Restaurant'], area: [320, 400, 450], win: true },
  court: { space: 'cafeteria', name: ['Food Court', 'Street Food Market'], area: [200, 280, 400], win: true },
  rink: { space: 'ice_rink', name: ['Ice Rink'], area: [330, 400, 480], win: false },
  lecture: { space: 'lounge_pax', name: ['Lecture Hall'], area: [100, 150, 240], win: true },
  mud_room: { space: 'store_large', name: ['Mud Room & Zodiac Station'], area: [60, 100, 160], win: false },
  science: { space: 'lab', name: ['Science Lab'], area: [40, 70, 120], win: false },
};
const pickName = (kind, seed, n = 0) => { const a = VENUE[kind].name; return a[(seed + n * 7) % a.length]; };

// ------------------------------------------------------------------------------------------------ public decks
/** Queue of venue kinds for the street/band slots of public deck pi (of np): important ones first, fillers after. */
function venueQueue(prof, pi, np, seed) {
  const V = prof.venues, ext = new Set(prof.extras), q = [];
  const bars = V.bar, shops = V.shop;
  const share = (n, a, b) => Math.max(0, Math.round(n * (np === 1 ? 1 : np === 2 ? (pi === 0 ? a : b) : pi === 0 ? a : pi === 1 ? b : 1 - a - b + 0)));
  const weave = (...lists) => { const out = []; const L = lists.map((l) => [...l]); while (L.some((l) => l.length)) for (const l of L) if (l.length) out.push(l.shift()); return out; };
  const rep = (k, n) => Array.from({ length: Math.max(0, n) }, () => k);
  if (np === 1) return weave(['guest_services'], rep('lounge', V.lounge), rep('cafe', 1), rep('bar', bars), rep('shop', shops), [...ext].filter((e) => ['library', 'card_room', 'art_gallery', 'observation', 'panorama_lounge'].includes(e)).map((e) => (e === 'observation' || e === 'panorama_lounge' ? 'lounge' : e)), rep('medical', 1), rep('spec', V.spec));
  if (pi === 0) return weave(['guest_services'], rep('cafe', Math.max(1, V.main ? 1 : 0)), rep('shop', share(shops, 0.6, 0.6)), rep('bar', share(bars, 0.4, 0.4)), [...ext].includes('art_gallery') ? ['art_gallery', 'photo_gallery'] : ['photo_gallery'], [...ext].includes('arcade') ? ['arcade'] : [], rep('medical', 1));
  if (pi === 1) return weave(V.casino ? ['casino'] : [], rep('spec', Math.ceil(V.spec * (np === 2 ? 1 : 0.6))), rep('club', Math.ceil(V.club * (np === 2 ? 1 : 0.5))), rep('bar', share(bars, 0.6, 0.6) - (np === 2 ? 0 : 0) + (np === 2 ? 0 : 0)), rep('shop', Math.max(0, shops - share(shops, 0.6, 0.6))), rep('lounge', Math.ceil(V.lounge / 2)), np === 2 ? [...ext].filter((e) => ['library', 'card_room', 'cinema'].includes(e)) : []);
  // the top public deck: family and quiet venues
  return weave(ext.has('ice_rink') && prof.stack[3] < 2 ? ['rink'] : [], rep('kids', V.kids), rep('teens', V.teens), [...ext].includes('cinema') ? ['cinema'] : [], rep('spec', Math.floor(V.spec * 0.4)), rep('club', Math.floor(V.club * 0.5)), [...ext].includes('library') ? ['library'] : [], [...ext].includes('card_room') ? ['card_room'] : [], rep('lounge', Math.floor(V.lounge / 2)), rep('conference', 1), rep('bar', Math.max(0, bars - share(bars, 0.4, 0.4) - share(bars, 0.6, 0.6))), seed ? [] : []);
}
const FILL = ['lounge', 'bar', 'shop', 'cafe', 'lounge', 'bar'];

/** Block types along a public deck, fwd → aft. */
export function publicTemplate(prof, nb) {
  const t = new Array(nb).fill('street');
  if (nb >= 2) { t[nb - 1] = 'dining'; if (prof.theatre.decks) t[0] = 'theatre'; }
  const mid = []; for (let i = 0; i < nb; i++) if (t[i] === 'street') mid.push(i);
  const a = Math.min(prof.atria.length, mid.length);
  const picks = [];
  for (let k = 0; k < a; k++) picks.push(mid[Math.min(mid.length - 1, Math.floor(((k + 0.5) * mid.length) / a))]);
  picks.forEach((bi, k) => { t[bi] = `atrium:${k}`; });
  if (nb === 1) t[0] = 'street';
  return t;
}

function bandFill(S, F, queue, side, x0, x1, z0, z1, streetId, opts = {}) {
  const depth = x1 - x0, len = z1 - z0, out = [];
  if (depth < 4 || len < 5) return out;
  const items = [];
  const want = (k) => { const a = VENUE[k].area; return { k, lo: clamp(a[0] / depth, 5.5, 30), w: clamp(a[1] / depth, 5.5, 26), hi: clamp(a[2] / depth, 6, 30) }; };
  let sum = 0;
  while (sum < len - 4 && items.length < 14) {
    const k = queue.next(); const it = want(k);
    if (items.length && sum + it.lo > len + 1) { queue.back(k); break; }
    items.push(it); sum += it.w;
  }
  if (!items.length) items.push(want('lounge'));
  // scale to the band: widths inside [lo, hi]; leftover becomes a filler venue
  let tot = items.reduce((s, i) => s + i.w, 0);
  for (let pass = 0; pass < 6 && Math.abs(tot - len) > 0.05; pass++) {
    const f = len / tot;
    for (const i of items) i.w = clamp(i.w * f, i.lo, i.hi);
    tot = items.reduce((s, i) => s + i.w, 0);
    if (tot < len - 0.05 && items.every((i) => i.w >= i.hi - 1e-6)) { items.push(want(FILL[items.length % FILL.length])); tot = items.reduce((s, i) => s + i.w, 0); }
    if (tot > len + 0.05 && items.every((i) => i.w <= i.lo + 1e-6) && items.length > 1) { const rm = items.pop(); queue.back(rm.k); tot = items.reduce((s, i) => s + i.w, 0); }
  }
  const k = len / tot; let z = z0;
  items.forEach((it, i) => {
    const za = z, zb = i === items.length - 1 ? z1 : r2(z + it.w * k); z = zb;
    const V = VENUE[it.k], id = `${opts.id}-${side < 0 ? 'p' : 's'}${i}`;
    const r = S.room({ id, space: V.space, venue: it.k, name: pickName(it.k, F.seed + (opts.bi || 0) * 3 + i + (side < 0 ? 0 : 5), i), kind: 'mess', use: it.k, x0: side < 0 ? x0 : x0, x1, z0: za, z1: zb, floor: 'carpet', wall: 'white', hw: x1 });
    if (V.win && opts.outer) S.win(r, side < 0 ? 'w' : 'e', za + 0.6, zb - 0.6, 0.9, 2.4);
    const at = (za + zb) / 2 + (i % 2 ? 0.4 : -0.4);
    S.door(r, streetId, side < 0 ? 'e' : 'w', clamp(at, za + 0.8, zb - 0.8), it.k === 'casino' || it.k === 'club' || it.k === 'spec' ? 2.0 : it.k === 'shop' ? 1.8 : 1.5, 'open');
    out.push(r);
  });
  return out;
}
function mkQueue(list, fill) {
  const l = [...list]; let n = 0;
  return { next() { return l.length ? l.shift() : fill[n++ % fill.length]; }, back(k) { if (!FILL.includes(k) || l.length) l.unshift(k); else n = Math.max(0, n - 1); } };
}

function publicDeck(F) {
  const { d, ga, prof, blocks, X } = F, S = new SpecB(F);
  const np = prof.stack.public, pi = F.index, nb = blocks.length;
  const tmpl = publicTemplate(prof, nb), isBoat = X.boatDeck === d.id;
  const queue = mkQueue(venueQueue(prof, pi, np, F.seed), FILL);
  const dup = X.decks[X.decks.indexOf(d) + 1];
  const H3 = (n) => { const up = X.decks[X.decks.indexOf(d) + n]; return up ? r2(up.y - d.y - 0.12) : r2(d.h * n); };
  S.meta.template = tmpl; S.meta.boat = isBoat;
  blocks.forEach((blk, bi) => {
    const hw = blk.hw, hwi = r2(hw - (isBoat && hw > 6 ? PROM_W : 0)), id = `${d.id}-b${bi}`, type = tmpl[bi];
    if (hw < 5) return;
    const link = (r, which = 'both') => { if (which !== 's') S.link(r, 'n', blk.fwd); if (which !== 'n') S.link(r, 's', blk.aft); };
    const proms = () => {
      if (!(isBoat && hw > 6)) return;
      for (const s of [-1, 1]) {
        const pr = S.room({ id: `${id}-prom-${s < 0 ? 'p' : 's'}`, space: 'open_deck', kind: 'deck', use: 'promenade', name: `Promenade (${s < 0 ? 'port' : 'starboard'})`, open: true, x0: s < 0 ? -hw : hwi, x1: s < 0 ? -hwi : hw, z0: blk.z0, z1: blk.z1, floor: 'teak', h: 2.4 });
        pr.inset = s < 0 ? { w: 0.15, e: 0.25, n: 0, s: 0 } : { e: 0.15, w: 0.25, n: 0, s: 0 };
        S.rail([[s * hw, blk.z0], [s * hw, blk.z1]]);
        // every room along this side opens onto the open promenade deck (lifeboat embarkation, fresh air)
        for (const q of S.rooms) {
          if (q.open || q.z0 < blk.z0 - 0.01 || q.z1 > blk.z1 + 0.01 || !q.id.startsWith(id)) continue;
          if (s < 0 ? Math.abs(q.x0 + hwi) < 0.02 : Math.abs(q.x1 - hwi) < 0.02) S.door(q, pr, s < 0 ? 'w' : 'e', (q.z0 + q.z1) / 2, 1.4, 'ext');
        }
      }
    };
    if (type === 'theatre') return theatreBlock(S, F, blk, hwi, id, pi, np, queue, proms, link, H3);
    if (type === 'dining') return diningBlock(S, F, blk, hwi, id, pi, np, queue, proms, link);
    if (type.startsWith('atrium')) {
      const ai = Number(type.split(':')[1]), A = prof.atria[ai];
      if (A && pi < A.decks && hwi - 6 >= 5) return atriumBlock(S, F, blk, hwi, id, pi, A, ai, queue, proms, link, H3);
    }
    // street block: a promenade down the middle, venues either side
    const SH = hwi > 17 ? 5.5 : hwi > 9 ? STREET_HALF : Math.max(2.5, hwi * 0.25);
    const st = S.room({ id: `${id}-street`, space: 'promenade', venue: 'street', name: pi === 0 ? 'Promenade' : `Promenade (${d.name.split(' (')[0]})`, kind: 'passage', use: 'promenade', x0: -SH, x1: SH, z0: blk.z0, z1: blk.z1, floor: 'carpet', wall: 'white', h: d.h });
    link(st);
    for (const s of [-1, 1]) {
      const made = bandFill(S, F, queue, s, s < 0 ? -hwi : SH, s < 0 ? -SH : hwi, blk.z0, blk.z1, st.id, { id, bi, outer: true });
      if (!made.length) { if (s < 0) st.x0 = -hwi; else st.x1 = hwi; }   // nothing to put beside a small ship's street: it takes the width (and meets the open decks)
    }
    proms();
  });
  return S;
}

/** x of the aisles of a theatre of half-width T (3 sections with two aisles, or 2 with one in the middle): doors line up with them. */
export function theatreAisles(T) { const W = 2 * T; if (W < 20) return [0]; const secW = (W - 2.0 - 2.8) / 3; return [-(secW / 2 + 0.7), secW / 2 + 0.7]; }
function theatreBlock(S, F, blk, hwi, id, pi, np, queue, proms, link, H3) {
  const { prof, d } = F, len = blk.z1 - blk.z0, small = prof.theatre.decks === 1 || np === 1;
  const T = hwi - 5 >= 4 ? Math.min(hwi - 5, 15) : hwi;   // narrow ships: the show lounge takes the whole width
  const two = prof.theatre.decks === 2 && np >= 2;
  const tz = small ? len : Math.min(len - 6, Math.max(18, 880 / (2 * T)));
  const zt = r2(blk.z0 + tz);
  if (pi === 0 || (small && pi === 0)) {
    const th = S.room({ id: `${id}-theatre`, space: 'theatre', venue: 'theatre', name: small ? 'Show Lounge' : 'Main Theatre', kind: 'mess', use: 'theatre', x0: -T, x1: T, z0: blk.z0, z1: zt, floor: 'carpet', wall: 'white', h: two ? H3(2) : d.h, hw: T, tall: two ? 2 : 1 });
    S.meta.theatre = { x: T, z0: blk.z0, z1: zt, balcony: two };
    let foyer = null;
    if (!small && blk.z1 - zt >= 5) {
      foyer = S.room({ id: `${id}-foyer`, space: 'lounge_pax', venue: 'foyer', name: 'Theatre Foyer & Bar', kind: 'mess', use: 'foyer', x0: -hwi, x1: hwi, z0: zt, z1: blk.z1, floor: 'carpet', wall: 'white', hw: hwi });
      for (const ax of theatreAisles(T)) S.door(th, foyer, 's', ax, 2.4, 'open');
      link(foyer, 's');
      if (hwi > 8) { S.win(foyer, 'w', zt + 0.6, blk.z1 - 0.6); S.win(foyer, 'e', zt + 0.6, blk.z1 - 0.6); }
    } else link(th, 's');
    // bands beside the theatre: backstage (port) and a bar (starboard); venues continue the street feel
    if (hwi - T >= 5) for (const s of [-1, 1]) {
      const x0 = s < 0 ? -hwi : T, x1 = s < 0 ? -T : hwi;
      const kind = s < 0 ? 'bar' : queue.next();
      const k = ['shop', 'bar', 'lounge', 'cafe', 'spec', 'guest_services', 'club'].includes(kind) ? kind : 'bar';
      if (s > 0 && kind !== k) queue.back(kind);
      const r = S.room({ id: `${id}-side-${s < 0 ? 'p' : 's'}`, space: VENUE[k].space, venue: k, name: s < 0 ? 'Theatre Bar' : pickName(k, F.seed, 1), kind: 'mess', use: k, x0, x1, z0: blk.z0, z1: zt, floor: 'carpet', wall: 'white', hw: x1 });
      if (VENUE[k].win) S.win(r, s < 0 ? 'w' : 'e', blk.z0 + 0.6, zt - 0.6);
      S.door(r, foyer || th, foyer ? 's' : s < 0 ? 'e' : 'w', foyer ? (r.x0 + r.x1) / 2 : (blk.z0 + zt) / 2, 1.6, 'open');   // at the middle of the band's width, inside its own wall
      if (!foyer) { /* the side room opens onto the theatre */ }
    }
    proms();
  } else if (two && pi === 1) {
    // the balcony: the rear 45 % of the theatre, a void over the front; the foyer level continues
    const bz = r2(blk.z0 + (zt - blk.z0) * 0.55);
    const bal = S.room({ id: `${id}-balcony`, space: 'theatre_balcony', venue: 'theatre_balcony', name: 'Theatre Balcony', kind: 'mess', use: 'theatre', x0: -T, x1: T, z0: bz, z1: zt, floor: 'carpet', wall: 'white', hw: T });
    S.voids.push({ id: `${id}-void`, x0: -T, x1: T, z0: blk.z0, z1: bz, why: 'theatre' });
    S.rail([[-T, bz], [T, bz]]);
    S.rail([[-T, blk.z0], [-T, bz]]); S.rail([[T, blk.z0], [T, bz]]);
    const lounge = blk.z1 - zt >= 5 ? S.room({ id: `${id}-foyer`, space: 'lounge_pax', venue: 'lounge', name: 'Upper Foyer & Lounge', kind: 'mess', use: 'foyer', x0: -hwi, x1: hwi, z0: zt, z1: blk.z1, floor: 'carpet', wall: 'white', hw: hwi }) : null;
    if (lounge) { for (const ax of theatreAisles(T)) S.door(bal, lounge, 's', ax, 2.4, 'open'); link(lounge, 's'); if (hwi > 8) { S.win(lounge, 'w', zt + 0.6, blk.z1 - 0.6); S.win(lounge, 'e', zt + 0.6, blk.z1 - 0.6); } } else link(bal, 's');
    // side bands at the balcony level (fore of the void: beside it)
    if (hwi - T >= 5) for (const s of [-1, 1]) {
      const k = queue.next(); const okk = ['shop', 'bar', 'lounge', 'cafe', 'spec', 'club', 'kids', 'teens', 'library', 'card_room', 'cinema'].includes(k); if (!okk) queue.back(k); const kk = okk ? k : 'lounge';   // a venue that does not belong here goes back for the street
      const r = S.room({ id: `${id}-side-${s < 0 ? 'p' : 's'}`, space: VENUE[kk].space, venue: kk, name: pickName(kk, F.seed, 2), kind: 'mess', use: kk, x0: s < 0 ? -hwi : T, x1: s < 0 ? -T : hwi, z0: blk.z0, z1: zt, floor: 'carpet', wall: 'white', hw: hwi });
      if (VENUE[kk].win) S.win(r, s < 0 ? 'w' : 'e', blk.z0 + 0.6, zt - 0.6);
      S.door(r, lounge || bal, lounge ? 's' : s < 0 ? 'e' : 'w', lounge ? (r.x0 + r.x1) / 2 : (bz + zt) / 2, 1.6, 'open');
    }
  } else {
    // other public decks over the theatre: a lounge cluster across the block
    const st = S.room({ id: `${id}-street`, space: 'promenade', venue: 'street', name: 'Promenade', kind: 'passage', use: 'promenade', x0: -STREET_HALF, x1: STREET_HALF, z0: blk.z0, z1: blk.z1, floor: 'carpet', wall: 'white', h: d.h });
    link(st);
    for (const s of [-1, 1]) bandFill(S, F, queue, s, s < 0 ? -hwi : STREET_HALF, s < 0 ? -STREET_HALF : hwi, blk.z0, blk.z1, st.id, { id, bi: 90, outer: true });
  }
}

function atriumBlock(S, F, blk, hwi, id, pi, A, ai, queue, proms, link, H3) {
  const { d, prof } = F, ax = Math.min(hwi - 6, ai === 0 ? 12 : 10), len = blk.z1 - blk.z0;
  const gal = 3.0;
  S.meta.atria = (S.meta.atria || []).concat([{ id, name: A.name, x: ax, z0: blk.z0, z1: blk.z1, decks: A.decks, pi }]);
  if (pi === 0) {
    const at = S.room({ id: `${id}-atrium`, space: 'atrium', venue: 'atrium', name: A.name, kind: 'mess', use: 'atrium', x0: -ax, x1: ax, z0: blk.z0, z1: blk.z1, floor: 'stone', wall: 'white', h: H3(A.decks), hw: ax, tall: A.decks, atriumIndex: ai });
    link(at);
    for (const s of [-1, 1]) bandFill(S, F, queue, s, s < 0 ? -hwi : ax, s < 0 ? -ax : hwi, blk.z0, blk.z1, at.id, { id, bi: 40 + ai, outer: true });
  } else {
    // gallery ring on the upper decks: two long strips and two end strips round the void
    const strips = [
      { t: 'p', x0: -ax, x1: -ax + gal, z0: blk.z0, z1: blk.z1 }, { t: 's', x0: ax - gal, x1: ax, z0: blk.z0, z1: blk.z1 },
      { t: 'f', x0: -ax + gal, x1: ax - gal, z0: blk.z0, z1: blk.z0 + gal }, { t: 'a', x0: -ax + gal, x1: ax - gal, z0: blk.z1 - gal, z1: blk.z1 },
    ];
    const rooms = strips.map((q) => S.room({ id: `${id}-gal-${q.t}`, space: 'atrium_gallery', venue: 'gallery', name: `${A.name} gallery`, kind: 'mess', use: 'gallery', ...q, floor: 'stone', wall: 'white', hw: ax }));
    const [gp, gs, gf, ga_] = rooms;
    S.door(gf, gp, 'w', blk.z0 + gal / 2, gal - 0.6, 'open'); S.door(gf, gs, 'e', blk.z0 + gal / 2, gal - 0.6, 'open');
    S.door(ga_, gp, 'w', blk.z1 - gal / 2, gal - 0.6, 'open'); S.door(ga_, gs, 'e', blk.z1 - gal / 2, gal - 0.6, 'open');
    link(ga_, 's'); link(gf, 'n');
    link(gp, 'n'); link(gs, 'n'); link(gp, 's'); link(gs, 's');
    S.voids.push({ id: `${id}-void`, x0: -ax + gal, x1: ax - gal, z0: blk.z0 + gal, z1: blk.z1 - gal, why: 'atrium' });
    S.rail([[-ax + gal, blk.z0 + gal], [ax - gal, blk.z0 + gal], [ax - gal, blk.z1 - gal], [-ax + gal, blk.z1 - gal], [-ax + gal, blk.z0 + gal]]);
    // venues beside the atrium at this level
    for (const s of [-1, 1]) {
      const strip = s < 0 ? gp : gs;
      const rs = bandFill(S, F, queue, s, s < 0 ? -hwi : ax, s < 0 ? -ax : hwi, blk.z0, blk.z1, strip.id, { id, bi: 40 + ai, outer: true });
      void rs;
    }
  }
  proms();
}

function diningBlock(S, F, blk, hwi, id, pi, np, queue, proms, link) {
  const { prof, d } = F;
  const mains = prof.dining.main, fullDining = pi === 0 || (pi === 1 && mains >= 2 && np >= 2);
  if (!fullDining) {
    const st = S.room({ id: `${id}-street`, space: 'promenade', venue: 'street', name: 'Promenade', kind: 'passage', use: 'promenade', x0: -STREET_HALF, x1: STREET_HALF, z0: blk.z0, z1: blk.z1, floor: 'carpet', wall: 'white', h: d.h });
    link(st);
    for (const s of [-1, 1]) bandFill(S, F, queue, s, s < 0 ? -hwi : STREET_HALF, s < 0 ? -STREET_HALF : hwi, blk.z0, blk.z1, st.id, { id, bi: 70, outer: true });
    proms(); return;
  }
  const len = blk.z1 - blk.z0, GX = Math.min(6, hwi * 0.3), fo = Math.min(7, len * 0.18);
  const f0 = S.room({ id: `${id}-foyer-a`, space: 'guest_services', venue: 'dining_foyer', name: 'Dining Room Foyer', kind: 'passage', use: 'foyer', x0: -GX, x1: GX, z0: blk.z0, z1: blk.z0 + fo, floor: 'carpet', wall: 'white' });
  const f1 = S.room({ id: `${id}-foyer-b`, space: 'guest_services', venue: 'dining_foyer', name: 'Dining Room Foyer', kind: 'passage', use: 'foyer', x0: -GX, x1: GX, z0: blk.z1 - fo, z1: blk.z1, floor: 'carpet', wall: 'white' });
  const gal = S.room({ id: `${id}-galley`, space: 'galley_pax', venue: 'galley', name: pi === 0 ? 'Main Galley' : 'Upper Galley', kind: 'mess', use: 'galley', x0: -GX, x1: GX, z0: blk.z0 + fo, z1: blk.z1 - fo, floor: 'lino', wall: 'white' });
  link(f0, 'n'); link(f1, 's');
  S.door(f0, gal, 's', 0, 1.4, 'door'); S.door(f1, gal, 'n', 0, 1.4, 'door');
  const zm = r2(blk.z0 + len / 2), names = pi === 0 ? ['Main Dining Room', 'Dining Room'] : ['Upper Dining Room', 'Deck Dining Room'];
  const mk = (s, fa, i) => {
    const za = fa ? blk.z0 : zm, zb = fa ? zm : blk.z1;
    const r = S.room({ id: `${id}-dining-${s < 0 ? 'p' : 's'}${i}`, space: 'restaurant', venue: 'dining', name: `${names[(F.seed + i) % 2]} ${['Aft', 'Fore'][fa ? 1 : 0]}`.replace(/ (Aft|Fore)$/, s < 0 ? ' (port)' : ' (starboard)') + (i ? ' II' : ''), kind: 'mess', use: 'dining', x0: s < 0 ? -hwi : GX, x1: s < 0 ? -GX : hwi, z0: za, z1: zb, floor: 'carpet', wall: 'white', hw: hwi });
    S.win(r, s < 0 ? 'w' : 'e', za + 0.6, zb - 0.6);
    // public door from the foyer at its end, service door from the galley at the middle
    const ft = fa ? f0 : f1;
    S.door(r, ft, s < 0 ? 'e' : 'w', fa ? blk.z0 + fo / 2 : blk.z1 - fo / 2, 2.4, 'open');
    S.door(r, gal, s < 0 ? 'e' : 'w', fa ? clamp(zm - 3, blk.z0 + fo + 1, zm) : clamp(zm + 3, zm, blk.z1 - fo - 1), 1.4, 'door');
    return r;
  };
  for (const s of [-1, 1]) { mk(s, true, 0); mk(s, false, 1); }
  proms();
}

// ------------------------------------------------------------------------------------------------ lido and sun decks
function openDeck(F, lido) {
  const { d, prof, blocks, X } = F, S = new SpecB(F), li = F.index;
  const nb = blocks.length;
  // block roles fwd → aft
  const kinds = new Array(nb).fill('pool');
  const second = li > 0;
  if (lido) {
    if (!second) {
      if (nb >= 2) { kinds[0] = 'spa'; kinds[nb - 1] = 'buffet'; }
      if (nb >= 4) kinds[nb - 2] = 'sports';
      if (nb >= 5 && prof.venues.slide) kinds[nb - 3] = 'waterpark';
    } else {
      kinds.fill('sports'); kinds[0] = 'rink'; if (nb >= 3) { kinds[1] = 'waterpark'; kinds[nb - 1] = 'buffet2'; }
    }
  } else {
    kinds.fill('sun'); if (nb >= 2) kinds[nb - 1] = 'climb'; if (nb >= 3) kinds[0] = 'solarium';
  }
  const queue = mkQueue(lido ? (second ? ['bar', 'bar', 'lounge'] : ['bar', 'lounge', 'bar']) : ['bar', 'lounge'], ['bar', 'lounge']);
  S.meta.kinds = kinds;
  blocks.forEach((blk, bi) => {
    const hw = blk.hw, id = `${d.id}-b${bi}`, type = kinds[bi];
    if (hw < 4) return;
    const link = (r) => { S.link(r, 'n', blk.fwd); S.link(r, 's', blk.aft); };
    if (type === 'spa' || type === 'buffet' || type === 'buffet2' || type === 'rink') {
      const st = S.room({ id: `${id}-street`, space: 'promenade', venue: 'street', name: type === 'spa' ? 'Spa Promenade' : type === 'rink' ? 'Rink Promenade' : 'Marketplace', kind: 'passage', use: 'promenade', x0: -3, x1: 3, z0: blk.z0, z1: blk.z1, floor: 'carpet', wall: 'white', h: d.h });
      link(st);
      const hwi = hw;
      const lists = { spa: ['spa', 'fitness'], buffet: ['buffet', 'court'], buffet2: ['court', 'bar'], rink: ['rink', 'bar'] }[type];
      const q = mkQueue(lists.slice(), FILL);
      if (type === 'rink') {
        // the rink fills the port side; a bar and kids' play on the starboard
        const L = blk.z1 - blk.z0;
        const r = S.room({ id: `${id}-p0`, space: 'ice_rink', venue: 'rink', name: 'Ice Rink', kind: 'mess', use: 'rink', x0: -hwi, x1: -3, z0: blk.z0, z1: blk.z1, floor: 'carpet', wall: 'white', hw: hwi, h: d.h });
        S.door(r, st, 'e', blk.z0 + L / 2, 2.4, 'open');
        bandFill(S, F, mkQueue(['bar', 'lounge', 'arcade'], FILL), 1, 3, hwi, blk.z0, blk.z1, st.id, { id, bi, outer: true });
      } else for (const s of [-1, 1]) bandFill(S, F, q, s, s < 0 ? -hwi : 3, s < 0 ? -3 : hwi, blk.z0, blk.z1, st.id, { id, bi, outer: true });
      return;
    }
    // open-air block: one room with pools / courts / slides (kit decides)
    const hwo = hw;
    const r = S.room({ id: `${id}-open`, space: lido ? (type === 'waterpark' ? 'water_deck' : type === 'sports' ? 'sports_deck' : 'pool_deck') : 'sun_deck', venue: type, name: { pool: 'Pool Deck', waterpark: 'Water Park', sports: 'Sports Deck', sun: 'Sun Deck', climb: 'Climbing Wall & Rope Course', solarium: 'Sun Terrace' }[type] || 'Open Deck', kind: 'deck', use: lido ? 'pool' : 'sundeck', open: true, x0: -hwo, x1: hwo, z0: blk.z0, z1: blk.z1, floor: 'teak', h: 2.4, hw: hwo });
    r.inset = { n: 0.25, s: 0.25, e: 0.15, w: 0.15 };
    link(r);
    S.rail([[-hwo, blk.z0], [-hwo, blk.z1]]); S.rail([[hwo, blk.z0], [hwo, blk.z1]]);
  });
  void X; void prof;
  return S;
}

// ------------------------------------------------------------------------------------------------ cabin decks
function cabinDeck(F, crew) {
  const { ga, d, prof, blocks, X } = F, S = new SpecB(F), rg = rng(F.seed);
  const cabW = crew ? CREW_CABIN_W : CABIN_W;
  const cabIdx = F.index, cabN = F.count, topDeck = !crew && cabIdx >= cabN - 2;
  const weight = (i) => 0.35 + 1.3 * (cabN > 1 ? i / (cabN - 1) : 0.5);
  const suitePct = crew ? 0 : clamp(prof.cabins.suite / Math.max(1, prof.cabins.total) * (weight(cabIdx) / ((weight(0) + weight(cabN - 1)) / 2)) * 100 * 1.6, 0, 60);
  // the lowest cabin decks have ocean-view (fixed window) staterooms, the rest balconies, as many as the class mix says
  const lowOut = crew ? 0 : Math.round(cabN * (prof.cabins.out / Math.max(1, prof.cabins.out + prof.cabins.bal)));
  const serviceRole = (bi) => (crew ? crewRole(F, bi, blocks.length) : 'cabins');
  let nCab = 0; const cat = { in: 0, out: 0, bal: 0, suite: 0, acc: 0 };
  blocks.forEach((blk, bi) => {
    const hw = blk.hw, id = `${d.id}-b${bi}`;
    if (hw < 1.6) return;
    const role = serviceRole(bi);
    const link = (r) => { S.link(r, 'n', blk.fwd); S.link(r, 's', blk.aft); };
    if (role !== 'cabins') { crewServiceBlock(S, F, blk, role, id, (r, end) => { if (!end) link(r); else S.link(r, end, end === 'n' ? blk.fwd : blk.aft); }); return; }
    const { dO, cw, two } = cabinGeom(ga, d, hw);
    const z0 = blk.z0, z1 = blk.z1;
    const n = Math.max(1, Math.floor((z1 - z0) / cabW));
    const zs = []; for (let i = 0; i < n; i++) zs.push([z0 + ((z1 - z0) * i) / n, z0 + ((z1 - z0) * (i + 1)) / n]);
    const balconyDeck = d.y >= X.hullTop - 0.01 && (crew || cabIdx >= lowOut);
    const outerCat = crew ? 'crew' : balconyDeck ? 'bal' : 'out';
    const mkCab = (sfx, sp, x0, x1, za, zb, name, extra = {}) => S.room({ id: `${id}-${sfx}`, space: sp, kind: 'cabin', use: 'cabin', name, x0, x1, z0: za, z1: zb, floor: 'carpet', wall: 'white', berth: crew ? 2 : 2, ...extra });
    const spOf = { crew: 'cabin_crew_pax', bal: 'cabin_cruise_bal', out: 'cabin_cruise_out', in: 'cabin_cruise_in', suite: 'cabin_cruise_suite', acc: 'cabin_cruise_acc' };
    const nameOf = { crew: 'Crew cabin', bal: 'Balcony stateroom', out: 'Ocean-view stateroom', in: 'Inside stateroom', suite: 'Suite', acc: 'Accessible balcony stateroom' };
    // the stair down to the engine room comes up here on deck 1
    const ent = crew && d === X.decks[0] ? erSlots(ga, d, zs, z0, z1) : null;
    if (two) {
      const cx = hw - dO - cw, ci = Math.min(4.6, cx - 1.1), cen = cx - ci;
      const corr = [-1, 1].map((s) => S.room({ id: `${id}-cor-${s < 0 ? 'p' : 's'}`, space: crew ? 'corridor_pax' : 'corridor_pax', kind: 'passage', use: 'corridor', name: `Corridor (${d.name})`, x0: s < 0 ? -(hw - dO) : cx, x1: s < 0 ? -cx : hw - dO, z0, z1, floor: 'carpet', wall: 'white' }));
      for (const c of corr) link(c);
      for (let i = 0; i < n; i++) {
        const [a, b] = zs[i];
        for (const s of [-1, 1]) {
          const ox0 = s < 0 ? -hw : hw - dO, ox1 = s < 0 ? -(hw - dO) : hw;
          // suites take two slots on the outer row; the first slot after a tower on each side is accessible
          let c = outerCat, wide = 1;
          if (!crew) {
            const pair = i % 2 === 0 && i + 1 < n;
            if (pair && rg() * 100 < suitePct * (topDeck ? 1.2 : 0.6)) { c = 'suite'; wide = 2; }
            else if (i === 0 && s < 0 && cabIdx % 2 === 0) c = 'acc';
          }
          if (s < 0 && wide === 2 || s > 0 && wide === 2) { /* suite spans two slots */ }
          const key = `o${s < 0 ? 'p' : 's'}${i}`;
          if (S.byId.has(`${id}-${key}`)) continue;
          const bEnd = wide === 2 ? zs[i + 1][1] : b;
          const oc = mkCab(key, spOf[c], ox0, ox1, a, bEnd, nameOf[c], { cat: c, door: 'in' });
          S.door(oc, corr[s < 0 ? 0 : 1], s < 0 ? 'e' : 'w', (a + bEnd) / 2 + (c === 'suite' ? 0 : 0.6 * (i % 2 ? 1 : -1) * Math.min(1, (b - a) / 2 - 0.6)), c === 'acc' ? 1.0 : 0.85);
          S.win(oc, s < 0 ? 'w' : 'e', a + 0.4, bEnd - 0.4, balconyDeck && !crew ? 0.1 : 1.0, 2.3);
          if (balconyDeck && !crew) oc.balcony = { side: s, z0: a, z1: bEnd };
          cat[c] = (cat[c] || 0) + 1; nCab++;
          if (wide === 2) {
            // the second slot of the suite is the same room: mark it taken so the loop skips it
            S.byId.set(`${id}-o${s < 0 ? 'p' : 's'}${i + 1}`, oc);
          }
        }
      }
      // inner rows, back to back; the port rows over the engine room give way to the crew stair on deck 1
      for (let i = 0; i < n; i++) {
        const [a, b] = zs[i];
        for (const s of [-1, 1]) {
          if (ci < 2.4) continue;
          if (s < 0 && ent && i >= ent[0] && i <= ent[1]) {
            if (i === ent[0]) { const st = S.room({ id: `${id}-erstair`, space: 'entrance', kind: 'stairs', use: 'er_entrance', name: 'Crew stair to the engine room', x0: -cx, x1: -cen, z0: a, z1: zs[ent[1]][1], floor: 'lino', wall: 'white' }); S.door(st, corr[0], 'w', zs[ent[1]][1] - 0.9, 0.9); }
            continue;
          }
          const ic = mkCab(`i${s < 0 ? 'p' : 's'}${i}`, crew ? 'cabin_crew_pax' : 'cabin_cruise_in', s < 0 ? -cx : cen, s < 0 ? -cen : cx, a, b, crew ? 'Crew cabin' : 'Inside stateroom', { cat: crew ? 'crew' : 'in' });
          S.door(ic, corr[s < 0 ? 0 : 1], s < 0 ? 'w' : 'e', (a + b) / 2 - 0.6 * (i % 2 ? 1 : -1) * Math.min(1, (b - a) / 2 - 0.6), 0.85);
          cat[crew ? 'crew' : 'in']++; nCab++;
        }
      }
      if (cen > 0.6) {   // the service core between the inner rows: a crew passage tower to tower, stores either side
        const pw = Math.min(cen, 1.0);
        const sv = S.room({ id: `${id}-service`, space: 'crew_alley', kind: 'passage', use: 'service', name: 'Crew service passage', x0: -pw, x1: pw, z0, z1, floor: 'lino', wall: 'white' });
        link(sv);
        if (cen - pw > 0.6) for (const s of [-1, 1]) S.room({ id: `${id}-store-${s < 0 ? 'p' : 's'}`, space: 'store_gen', kind: 'store', use: 'service', name: s < 0 ? 'Linen & laundry store' : 'Pantry & provisions store', x0: s < 0 ? -cen : pw, x1: s < 0 ? -pw : cen, z0, z1, walk: false });
      }
    } else {
      // single corridor, cabins either side (narrow ships): deep cabins, the larger ones suites
      const corr = S.room({ id: `${id}-cor`, space: 'corridor_pax', kind: 'passage', use: 'corridor', name: `Corridor (${d.name})`, x0: -cw / 2, x1: cw / 2, z0, z1, floor: 'carpet', wall: 'white' });
      link(corr);
      for (let i = 0; i < n; i++) {
        const [a, b] = zs[i];
        for (const s of [-1, 1]) {
          const x0 = s < 0 ? -hw : cw / 2, x1 = s < 0 ? -cw / 2 : hw;
          if (x1 - x0 < 1.6) continue;
          if (s < 0 && ent && i >= ent[0] && i <= ent[1]) {
            if (i === ent[0]) { const st = S.room({ id: `${id}-erstair`, space: 'entrance', kind: 'stairs', use: 'er_entrance', name: 'Crew stair to the engine room', x0, x1, z0: a, z1: zs[ent[1]][1], floor: 'lino', wall: 'white' }); S.door(st, corr, 'e', zs[ent[1]][1] - 0.9, 0.9); }
            continue;
          }
          const depth = x1 - x0;
          let c = outerCat;
          if (!crew) { if (depth >= 6.2 && topDeck) c = 'suite'; else if (i === 0 && s < 0 && cabIdx % 2 === 0) c = 'acc'; }
          const cc = mkCab(`c${s < 0 ? 'p' : 's'}${i}`, spOf[c], x0, x1, a, b, nameOf[c], { cat: c });
          S.door(cc, corr, s < 0 ? 'e' : 'w', (a + b) / 2, c === 'acc' ? 1.0 : 0.85);
          S.win(cc, s < 0 ? 'w' : 'e', a + 0.4, b - 0.4, balconyDeck && !crew ? 0.1 : 1.0, 2.2);
          if (balconyDeck && !crew) cc.balcony = { side: s, z0: a, z1: b };
          cat[c] = (cat[c] || 0) + 1; nCab++;
        }
      }
    }
  });
  S.meta.cabins = nCab; S.meta.cat = cat;
  return S;
}
/** Which slots (indices of zs) over the engine room give way to the crew stair (as gaplan.js erEntranceSlots). */
function erSlots(ga, d, zs, z0, z1) {
  const er = ga.er;
  if (!er || ga.hull?.twin || !(er.z0 < z1 && er.z1 > z0)) return null;
  const need = 2 * LAND + stairRun(d.y - er.floorY, 52) + 0.4;
  const i0 = zs.findIndex(([, b]) => b > er.z0 + 1);
  if (i0 < 0) return null;
  for (let i1 = i0; i1 < zs.length; i1++) { const za = Math.max(er.z0 + 0.1, zs[i0][0] + 0.1); if (Math.min(zs[i1][1], er.z1 - 1) - za >= need) return [i0, i1]; }
  return null;
}

// ------------------------------------------------------------------------------------------------ crew decks
/** What each block of a crew deck is: stores, galleys, mess and bar, laundry, medical, or crew cabins. */
function crewRole(F, bi, nb) {
  const ci = F.index, prof = F.prof;
  const plan = [
    ['stores', 'laundry', 'cabins', 'cabins', 'cabins', 'cabins', 'cabins'],
    ['stores', 'social', 'galley', 'cabins', 'cabins', 'cabins', 'cabins'],
    ['medical', 'admin', 'cabins', 'cabins', 'cabins', 'cabins', 'cabins'],
  ][ci % 3];
  if (bi === nb - 1 && ci === 0) return 'cabins';   // the crew stair down to the engine room comes up in the last block of deck 1
  if (prof.cls === 'river' || prof.cls === 'expedition') return ci === 0 ? (['cabins', 'galley', 'cabins', 'cabins'][bi] || 'cabins') : (['cabins', 'stores', 'cabins', 'cabins'][bi] || 'cabins');
  if (nb <= 3) return ci === 1 && bi === 0 ? 'galley' : ci === 0 && bi === 1 ? 'stores' : 'cabins';
  return plan[bi] || 'cabins';
}
const CREW_ROOMS = {
  stores: [['store_large', 'Provision store', 'provisions'], ['store_large', 'Cold rooms', 'cold'], ['store_large', 'Dry & beverage store', 'dry'], ['store_large', 'Garbage & recycling room', 'garbage'], ['store_large', 'Bonded store', 'bonded']],
  laundry: [['laundry_pax', 'Laundry', 'laundry'], ['store_large', 'Linen store', 'linen'], ['workshop_pax', 'Workshop', 'workshop'], ['plant_pax', 'Air-conditioning plant', 'ac']],
  social: [['crew_mess', 'Crew mess', 'crew_mess'], ['crew_bar', 'Crew bar', 'crew_bar'], ['crew_mess', 'Officers\' mess', 'officer_mess'], ['gym_pax', 'Crew gym', 'gym'], ['office_pax', 'Crew office', 'office']],
  galley: [['galley_pax', 'Main galley', 'galley'], ['galley_pax', 'Bakery & pastry', 'bakery'], ['galley_pax', 'Crew galley', 'galley'], ['store_large', 'Butcher & fish prep', 'prep']],
  medical: [['medical_ward', 'Medical Centre', 'medical'], ['medical_ward', 'Infirmary', 'infirmary'], ['office_pax', 'Purser\'s office', 'office'], ['store_large', 'Pharmacy', 'pharmacy']],
  admin: [['office_pax', 'Security office', 'office'], ['office_pax', 'Human resources', 'office'], ['conference_pax', 'Crew training room', 'training'], ['crew_bar', 'Crew lounge', 'lounge'], ['laundry_pax', 'Laundry', 'laundry']],
};
function crewServiceBlock(S, F, blk, role, id, link) {
  const hw = blk.hw, d = F.d, list = CREW_ROOMS[role] || CREW_ROOMS.stores;
  if (hw < 7.5) {   // small ships: the galley and the crew mess side by side, straight off the stair towers
    const zm = r2((blk.z0 + blk.z1) / 2);
    const g = S.room({ id: `${id}-galley`, space: role === 'galley' ? 'galley' : 'store_large', venue: role === 'galley' ? 'galley' : 'dry', name: role === 'galley' ? 'Galley' : 'Provision store', kind: role === 'galley' ? 'mess' : 'store', use: role === 'galley' ? 'galley' : 'stores', x0: -hw, x1: hw, z0: blk.z0, z1: zm, floor: 'lino', wall: 'white' });
    const m = S.room({ id: `${id}-mess`, space: role === 'galley' ? 'mess' : 'store_large', venue: role === 'galley' ? 'crew_mess' : 'cold', name: role === 'galley' ? 'Crew mess' : 'Cold rooms', kind: role === 'galley' ? 'mess' : 'store', use: role === 'galley' ? 'mess' : 'stores', x0: -hw, x1: hw, z0: zm, z1: blk.z1, floor: 'lino', wall: 'white' });
    S.door(g, m, 's', 0, 1.0, 'door'); link(g, 'n'); link(m, 's');
    return;
  }
  const AW = 1.6;   // crew alley half-width: a wide service spine tower to tower
  const al = S.room({ id: `${id}-alley`, space: 'crew_alley', kind: 'passage', use: 'service', name: `Crew alley (${d.name})`, x0: -AW, x1: AW, z0: blk.z0, z1: blk.z1, floor: 'lino', wall: 'white' });
  link(al);
  // a satellite galley at the aft end of the starboard band (room service for the cabin decks): small, so the galley kit's bands hold
  const satellite = role === 'galley' && hw > 7.5 && blk.z1 - blk.z0 > 20;
  if (satellite) {
    const rs = S.room({ id: `${id}-rsgalley`, space: 'galley', venue: 'rsgalley', name: 'Room-service galley', kind: 'mess', use: 'rsgalley', x0: AW, x1: AW + 5.6, z0: blk.z1 - 6.4, z1: blk.z1, floor: 'lino', wall: 'white' });
    S.door(rs, al, 'w', rs.z0 + 2.2, 1.0, 'door');
    const st = S.room({ id: `${id}-rsstore`, space: 'store_large', venue: 'dry', name: 'Beverage & dry store', kind: 'store', use: 'dry', x0: AW + 5.6, x1: hw, z0: blk.z1 - 6.4, z1: blk.z1, floor: 'lino', wall: 'white' });
    S.door(st, rs, 'w', st.z0 + 3.2, 1.0, 'door');
  }
  for (const s of [-1, 1]) {
    const x0 = s < 0 ? -hw : AW, x1 = s < 0 ? -AW : hw, depth = x1 - x0;
    if (depth < 3) continue;
    const zEnd = satellite && s > 0 ? blk.z1 - 6.4 : blk.z1, len = zEnd - blk.z0;
    if (len < 6) continue;
    // 1–4 rooms along the side: each about 14–26 m long
    const n = clamp(Math.round(len / 18), 1, 4);
    for (let i = 0; i < n; i++) {
      const za = blk.z0 + (len * i) / n, zb = i === n - 1 ? zEnd : blk.z0 + (len * (i + 1)) / n;
      const [sp, nm, tag] = list[(i + (s < 0 ? 0 : 2) + F.seed) % list.length];
      const space = SCALE_CREW[sp] ? sp : 'store_gen';
      const r = S.room({ id: `${id}-${s < 0 ? 'p' : 's'}${i}`, space, venue: tag, name: nm, kind: space === 'crew_mess' || space === 'crew_bar' || space === 'galley_pax' ? 'mess' : space === 'medical_ward' ? 'cabin' : 'store', use: tag, x0, x1, z0: za, z1: zb, floor: 'lino', wall: 'white', hw: x1 });
      S.door(r, al, s < 0 ? 'e' : 'w', (za + zb) / 2 + (i % 2 ? 0.8 : -0.8), 1.4, 'door');
    }
  }
}
const SCALE_CREW = { store_large: 1, laundry_pax: 1, workshop_pax: 1, plant_pax: 1, crew_mess: 1, crew_bar: 1, gym_pax: 1, office_pax: 1, galley_pax: 1, medical_ward: 1, conference_pax: 1 };

// ------------------------------------------------------------------------------------------------ entry points
const cache = new Map();
export function cruiseDeck(gaOrId, deckId) {
  const ga = typeof gaOrId === 'string' ? generalArrangement(gaOrId) : gaOrId;
  if (!ga?.pax || ga.type !== 'cruise') return null;
  const key = `${ga.id}|${deckId}`;
  if (cache.has(key)) return cache.get(key);
  const F = deckFrame(ga, deckId); if (!F || !F.prof) return null;
  let S;
  switch (F.d.use) {
    case 'public': S = publicDeck(F); break;
    case 'lido': S = openDeck(F, true); break;
    case 'sun': S = openDeck(F, false); break;
    case 'crew': S = cabinDeck(F, true); break;
    case 'cabin': S = cabinDeck(F, false); break;
    default: S = new SpecB(F);
  }
  const out = deepFreeze({ ...S.freeze(), frame: { z0: F.z0, z1: F.z1, blocks: F.blocks, towers: F.towers } });
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  cache.set(key, out);
  return out;
}
/** Whole-ship counts: cabins by category, rooms by space, venues by kind (builds every deck once; for tests and tools). */
export function cruiseCounts(variantId) {
  const ga = generalArrangement(variantId); if (!ga?.pax || ga.type !== 'cruise') return null;
  const out = { cabins: 0, byCat: { in: 0, out: 0, bal: 0, suite: 0, acc: 0, crew: 0 }, venues: {}, spaces: {}, rooms: 0, decks: {} };
  for (const d of ga.pax.decks) {
    const spec = cruiseDeck(ga, d.id); if (!spec) continue;
    out.decks[d.id] = { use: d.use, rooms: spec.rooms.length, cabins: spec.meta.cabins || 0 };
    out.rooms += spec.rooms.length;
    for (const r of spec.rooms) { out.spaces[r.space] = (out.spaces[r.space] || 0) + 1; if (r.venue) out.venues[r.venue] = (out.venues[r.venue] || 0) + 1; }
    if (spec.meta.cat) for (const [k, v] of Object.entries(spec.meta.cat)) { out.byCat[k] = (out.byCat[k] || 0) + v; if (k !== 'crew') out.cabins += v; }
  }
  return out;
}
function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; }
