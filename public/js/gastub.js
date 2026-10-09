// Local stand-in for Lane C's `shared/ships/ga.js` generalArrangement() (docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §6.1,
// §6.2 frozen GA shape, §6.3 rules). Lane B (exterior generators, shipgen.js) consumes the GA record only; Lane C owns
// the real one (with the full room programme). This stub fills every field the exterior needs from the §6.3 rules and
// leaves the interior-only fields minimal. When `shared/ships/ga.js` exists the callers use it instead (see
// docs/SHIPS-LANEB-PHASE2.md, H9); shipgen.js reads nothing beyond the frozen shape (plus MODELS for equipment).
//
// Frame (the same as public/js/ship.js): x = starboard, y = up with y = 0 at the design waterline (keel at y = −T),
// z = aft, bow end of the LOA at z = −L/2 and stern end at z = +L/2. Every z-range is [z0, z1] with z0 < z1 (z0 = the
// forward edge). `house.tiers[i].y` is the tier's floor height above the waterline.
// Pure: no three.js, no DOM.
import { MODELS, parseVariant, defaultLivery, validLivery } from '../../shared/ships/index.js';

const r2 = (v) => Math.round(v * 100) / 100;
const clamp = (lo, hi, v) => Math.max(lo, Math.min(hi, v));
const TIER = { merchant: 2.8, offshore: 3.0, pax: 3.2, yacht: 2.6 };          // §6.3 tier heights (Game rule)
const D_RATIO = { bulk: 0.72, tanker: 0.70, gas: 0.70, container: 0.62, ferry: 0.45, offshore: 0.82, tug: 0.80 };
const CB_DEF = { aft_house_dry: 0.8, aft_house_tanker: 0.8, lng: 0.75, container: 0.66, roro_pctc: 0.6, ferry: 0.58, cruise: 0.64,
  offshore: 0.68, tug: 0.52, fishing: 0.58, small_fast: 0.42, motor_yacht: 0.45, special: 0.62 };
/** container stack heights on deck by size (Game rule from typical classes) */
function deckTiersFor(teu) { return teu < 600 ? 2 : teu < 1500 ? 4 : teu < 3000 ? 5 : teu < 5000 ? 6 : teu < 8000 ? 7 : teu < 16000 ? 9 : 10; }

/** Blind distance ahead of the bow (m) for an eye at (zEye, eyeY) over an obstruction top (zObs, hObs), SOLAS V/22. */
export function blindDistance(zBow, zEye, eyeY, zObs, hObs) {
  if (hObs >= eyeY) return Infinity;
  const dEyeObs = zEye - zObs;                      // obstruction lies forward of the eye (smaller z)
  if (dEyeObs <= 0) return 0;
  const dSea = dEyeObs * eyeY / (eyeY - hObs);      // distance from the eye where the sight line meets the sea
  return Math.max(0, dSea - (zEye - zBow));
}
export const blindLimit = (L) => Math.min(2 * L, 500);

function tiers(n, y0, h, uses = []) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ id: String.fromCharCode(65 + i), y: r2(y0 + i * h), h, use: uses[i] || (i === 0 ? 'mess' : 'cabins') });
  return out;
}
/** main engine block dims (§6.3 fits) */
function meDims(kind, kW, n) {
  if (kind === '2s') return { len: r2(4 + 0.07 * Math.sqrt(kW)), w: r2(2 + 0.012 * Math.sqrt(kW)), h: r2(6 + 0.3 * Math.cbrt(kW)) };
  const k = kW / Math.max(1, n);
  return { len: r2(2 + 0.05 * Math.sqrt(k)), w: r2(1 + 0.02 * Math.sqrt(k)), h: r2(1.8 + 0.1 * Math.cbrt(k)) };
}

/**
 * The general arrangement of a model or variant. opts: { livery, stage (0..1 build progress) }.
 * Returns null for unknown ids and for the four sail classes (gen 'sail' is delegated to SAILING's yachtlooks.js).
 */
export function generalArrangement(variantId, opts = {}) {
  const pv = parseVariant(variantId);
  if (!pv) return null;
  const m = MODELS[pv.model];
  if (!m || m.gen === 'sail') return null;
  const tok = new Set(pv.tokens);
  const L = m.length, B = m.beam, T = m.draft;
  const D = m.depth ?? r2(T / (D_RATIO[m.type] || 0.7));
  // azimuth (ASD) tugs: the catalogue draught is the navigational draught over the Z-drives; the hull body is shallower
  const azi = m.gen === 'tug' && /azimuth/.test(m.engine.label) && D - T < 1.2;
  const Th = azi ? r2(Math.min(T, D - 1.1)) : T;
  const F = r2(D - Th), deckY = F;
  const Cb = m.Cb ?? CB_DEF[m.gen] ?? 0.7;
  const livery = validLivery(opts.livery) || defaultLivery(variantId);
  const iceTok = [...tok].find((t) => /^i1|^pc/.test(t)) || m.ice || (m.id === 'icebreaker120' ? 'pc3' : null);
  const ga = {
    id: variantId, model: m.id, gen: m.gen, L, B, T, D, F, deckY, Cb,
    hull: { bow: L >= 100 ? 'bulb' : 'raked', stern: 'cruiser', bowFrac: 0.3, sternW: 0.55, sheerFwd: r2(0.012 * L), sheerAft: r2(0.004 * L), flare: 0.3, bilgeR: r2(Math.min(2.5, B * 0.06)),
      mid: [0, 0], fcsle: null, poop: null, bulwark: 0, twin: null, draftHull: Th },
    house: null, bridge: null, casing: null, funnel: null, er: null,
    cargo: { kind: 'none', zones: [] },
    deck: { mooring: [], cranes: [], boats: [], gangway: null, pilotLadder: true, aframe: null, sternRoller: null, heli: null, masts: [], rotors: [], hoseCranes: [], manifold: null },
    goto: [], levels: [], livery, stage: clamp(0, 1, Number.isFinite(opts.stage) ? opts.stage : 1),
    ice: iceTok,
  };
  const H = ga.hull;
  // parallel midbody (Game rule fit: fuller ships have a longer one)
  const pm = clamp(0, 0.62, (Cb - 0.55) * 2.1);
  H.mid = [r2(-L * pm * 0.42), r2(L * pm * 0.58)];
  H.bowFrac = r2(clamp(0.12, 0.5, (1 - pm) * 0.5));
  const G = GENS[m.gen] || GENS.aft_house_dry;
  G(ga, m, tok);
  if (iceTok && H.bow !== 'ice' && /^pc|i1as|i1a$/.test(iceTok) && ['offshore', 'special', 'cruise', 'motor_yacht'].includes(m.type)) H.bow = 'ice';
  finishCommon(ga, m, tok);
  return ga;
}

// ------------------------------------------------------------------------------------------------ helpers per gen
function bridgeOn(ga, house, { wings = 'open', wingTo = null, len = null, aftConsole = false, w = null } = {}) {
  const top = house.tiers[house.tiers.length - 1];
  const y = r2(top.y + top.h);
  const bl = len ?? Math.min(house.z1 - house.z0, Math.max(6, (house.z1 - house.z0) * 0.65));
  ga.bridge = { y, z0: house.z0, z1: r2(house.z0 + bl), w: w ?? house.w, h: 3.0, wings, wingTo: wingTo ?? r2(ga.B / 2 - 0.3), aftConsole,
    consoles: [{ id: 'steering', x: 0, z: house.z0 + 1.6 }, { id: 'radarX', x: 1.4, z: house.z0 + 1.6 }, { id: 'radarS', x: -1.4, z: house.z0 + 1.6 }, { id: 'ecdis', x: -2.6, z: house.z0 + 1.6 }, { id: 'gmdss', x: -2.4, z: house.z0 + bl - 1.4 }] };
  house.eyeY = r2(y + 1.7);
}
function aftHouse(ga, m, { tierN, len, w, poopLen, tierH = TIER.merchant, uses }) {
  const L = ga.L;
  const z1 = r2(L / 2 - poopLen);
  const house = { pos: 'aft', z0: r2(z1 - len), z1, w: r2(w), tiers: tiers(tierN, ga.deckY, tierH, uses), eyeY: 0 };
  ga.house = house;
  bridgeOn(ga, house, { len: Math.max(7, len * 0.7), wings: ga.ice ? 'enclosed' : 'open' });
  return house;
}
function stackFunnel(ga, { z, kind = 'single', r: r0 = null, h = null, top = null }) {
  const house = ga.house;
  const r = r0 ?? r2(clamp(0.8, 7, ga.B * 0.09));
  const yb = ga.bridge ? ga.bridge.y : ga.deckY + 4;
  const hh = h ?? r2(Math.max(3, (yb - ga.deckY) * 0.42 + 3));
  ga.funnel = { z: r2(z), y: r2(top ?? (yb + 3.2 - hh * 0.55)), r, h: hh, kind };
  ga.casing = { z0: r2(z - r * 1.4), z1: r2(z + r * 1.4), w: r2(r * 2.4) };
  void house;
}
function erFor(ga, m, lenFrac) {
  const L = ga.L, len = Math.max(4, L * lenFrac);
  const z1 = r2(L / 2 - Math.max(2, L * 0.06)), z0 = r2(z1 - len);
  const db = r2(clamp(1.0, 2.0, ga.B / 20));
  const me = meDims(m.engine.kind, m.kW, m.engine.n);
  ga.er = { z0, z1, floorY: r2(-ga.T + db), levels: [], me: { kind: m.engine.kind, n: m.engine.n, ...me, xs: m.engine.n > 1 ? [-ga.B * 0.18, ga.B * 0.18].map(r2) : [0], z: r2((z0 + z1) / 2) },
    gens: { n: 3, len: 3.5, w: 1.6, h: 2.4 }, ecr: { level: 1, side: 'port' }, purifier: true, boiler: m.kW >= 5000, workshop: true,
    steering: { z0: r2(L / 2 - L * 0.05), z1: r2(L / 2 - 1), y: r2(ga.deckY - 3) }, escape: { x: r2(ga.B * 0.3), z: r2(z1 - 2) }, shaft: null };
  for (let y = ga.er.floorY + 4.5; y < ga.deckY - 1; y += 4.5) ga.er.levels.push(r2(y));
}
function mooringEnds(ga) {
  const L = ga.L, fy = ga.hull.fcsle ? ga.hull.fcsle.h : 0;
  ga.deck.mooring.push({ z: r2(-L / 2 + Math.max(2, L * 0.035)), kind: 'windlass', side: 'both', y: r2(ga.deckY + fy) });
  if (L > 60) ga.deck.mooring.push({ z: r2(-L / 2 + L * 0.06), kind: 'winch', side: 'both', y: r2(ga.deckY + fy) });
  ga.deck.mooring.push({ z: r2(L / 2 - Math.max(2, L * 0.03)), kind: 'winch', side: 'both', y: r2(ga.deckY + (ga.hull.poop ? ga.hull.poop.h : 0)) });
}

// ------------------------------------------------------------------------------------------------ the generators
const GENS = {
  aft_house_dry(ga, m, tok) {
    const { L, B } = ga, H = ga.hull;
    H.bow = L >= 100 ? 'bulb' : 'raked'; H.stern = L >= 100 ? 'cruiser' : 'transom'; H.sternW = L >= 100 ? 0.5 : 0.8;
    H.fcsle = { len: r2(L * (L > 150 ? 0.085 : 0.1)), h: 2.6 }; H.bulwark = 1.1;
    H.poop = null;
    const tierN = L < 100 ? 3 : L < 140 ? 4 : L < 200 ? 5 : L < 260 ? 6 : 7;
    const house = aftHouse(ga, m, { tierN, len: r2(clamp(10, 34, L * 0.08)), w: B * (L < 100 ? 0.7 : 0.82), poopLen: r2(Math.max(5, L * 0.06)),
      uses: ['mess', 'cabins', 'officers', 'senior', 'pilot', 'senior', 'senior'] });
    stackFunnel(ga, { z: house.z1 - Math.min(5, (house.z1 - house.z0) * 0.25), r: r2(clamp(1, 4.5, B * 0.08)) });
    erFor(ga, m, m.engine.kind === '2s' ? 0.12 : 0.15);
    const holds = m.units.holds || (L < 95 ? 2 : L < 130 ? 3 : L < 170 ? 4 : L < 205 ? 5 : L < 240 ? 7 : L < 330 ? 9 : 7);
    const za = r2(-L / 2 + H.fcsle.len + 2), zb = r2(house.z0 - Math.max(3, L * 0.02));
    const hl = (zb - za) / holds;
    const box = ['coaster', 'shortsea88', 'gc120', 'mpp160'].includes(m.id);
    const hatchW = r2(B * (box ? 0.8 : m.units.hatchW || (m.id === 'vloc400' ? 0.42 : 0.56)));
    if (m.id === 'livestock135') {
      ga.cargo = { kind: 'pens', zones: [{ id: 'pens', z0: za, z1: zb, w: r2(B - 1.6), tiers: 4, h: 2.4 }] };
    } else {
      ga.cargo = { kind: 'holds', zones: [] };
      for (let i = 0; i < holds; i++) ga.cargo.zones.push({ id: `hold${i + 1}`, z0: r2(za + hl * i + hl * (box ? 0.04 : 0.12)), z1: r2(za + hl * (i + 1) - hl * (box ? 0.04 : 0.12)), w: hatchW, coaming: box ? 1.4 : 1.8 });
    }
    // cranes between hatches (geared), heavy-lift pair on the port side (mpp160)
    const geared = tok.has('geared') || (!tok.has('gearless') && m.defaults.gear === 'geared');
    const ceq = (m.eq.find((e) => e.startsWith('cranes:')) || '').split(':')[1];
    const [cn, swl] = ceq ? ceq.split('x').map(Number) : [L < 100 ? 1 : 2, 25];
    if (geared && m.id !== 'livestock135') {
      if (m.id === 'mpp160') for (let i = 0; i < cn; i++) ga.deck.cranes.push({ z: r2(za + (zb - za) * (i === 0 ? 0.3 : 0.62)), x: r2(-B / 2 + 3.2), swl, boom: r2(L * 0.24), h: 14 });
      else {
        const gaps = holds - 1;
        for (let i = 0; i < Math.min(cn, Math.max(1, gaps)); i++) {
          const gi = gaps <= cn ? i + 1 : Math.round((i + 1) * holds / (cn + 1));
          ga.deck.cranes.push({ z: r2(za + hl * gi), x: 0, swl, boom: r2(clamp(14, 30, B * 0.85)), h: r2(clamp(6, 13, B * 0.3)) });
        }
      }
    }
    if (tok.has('rot')) { const n = L < 180 ? 2 : 4; for (let i = 0; i < n; i++) ga.deck.rotors.push({ z: r2(za + 6 + i * 0.5 * hl * 1.0), x: r2((i % 2 ? 1 : -1) * (B / 2 - 3.2)), h: 30, r: 2.5 }); }
    ga.deck.boats.push(L >= 100 ? { kind: 'freefall', z: r2(house.z1 + 2.4), x: 0, y: r2(ga.deckY + 2.8 * 1.2) } : { kind: 'davit', z: r2(house.z0 + 3), x: r2(B / 2 - 0.6), y: r2(ga.deckY + 2.8) });
    ga.deck.boats.push({ kind: 'rescue', z: r2(house.z0 + 2), x: r2(-(B / 2 - 0.8)), y: r2(ga.deckY + 2.8) });
    ga.deck.masts.push({ z: r2(-L / 2 + Math.max(4, L * 0.04)), h: r2(clamp(6, 14, L * 0.05)), y: r2(ga.deckY + H.fcsle.h) });
  },

  aft_house_tanker(ga, m, tok) {
    const { L, B } = ga, H = ga.hull;
    H.bow = L >= 100 ? 'bulb' : 'raked'; H.stern = L >= 100 ? 'cruiser' : 'transom'; H.sternW = L >= 100 ? 0.5 : 0.8;
    H.fcsle = { len: r2(L * 0.08), h: 2.6 }; H.bulwark = 0;
    const tierN = L < 100 ? 4 : L < 160 ? 5 : L < 250 ? 6 : 7;
    const house = aftHouse(ga, m, { tierN, len: r2(clamp(10, 30, L * 0.075)), w: B * 0.8, poopLen: r2(Math.max(5, L * 0.055)), uses: ['ccr', 'cabins', 'officers', 'senior', 'pilot', 'senior', 'senior'] });
    stackFunnel(ga, { z: house.z1 - Math.min(5, (house.z1 - house.z0) * 0.25), r: r2(clamp(1, 4.5, B * 0.075)) });
    erFor(ga, m, m.engine.kind === '2s' ? 0.12 : 0.15);
    const za = r2(-L / 2 + H.fcsle.len + 1.5), zb = r2(house.z0 - 3);
    const gas = m.type === 'gas';
    if (m.id === 'lpg5k' || m.id === 'lngbv7500') {
      // pressurised / type C cylinders: half above the main deck (§6.4 aft_house_tanker, LPG)
      const n = 2, gap = 2.5, tl = (zb - za - gap * (n - 1) - 4) / n, r = r2(Math.min(B * 0.36, 7.5));
      ga.cargo = { kind: 'tanks', zones: [] };
      for (let i = 0; i < n; i++) ga.cargo.zones.push({ id: `tank${i + 1}`, z0: r2(za + 2 + i * (tl + gap)), z1: r2(za + 2 + i * (tl + gap) + tl), w: r2(2 * r), shape: m.id === 'lpg5k' ? 'bilobe' : 'cyl', r, cy: r2(ga.deckY + r * (m.id === 'lpg5k' ? 0.25 : -0.1)) });
    } else {
      const n = m.units.segregations ? Math.min(7, Math.ceil(m.units.segregations / 2)) : L < 150 ? 5 : 6;
      const tl = (zb - za) / n;
      ga.cargo = { kind: 'tanks', zones: [] };
      for (let i = 0; i < n; i++) ga.cargo.zones.push({ id: `cot${i + 1}`, z0: r2(za + tl * i), z1: r2(za + tl * (i + 1)), w: r2(B - 2), domes: gas });
    }
    const mz = r2((za + zb) / 2 + 2);
    ga.deck.manifold = { z: mz };
    const hcn = Number((m.eq.find((e) => e.startsWith('hoseCranes')) || 'hoseCranes:1').split(':')[1]) || 1;
    ga.deck.hoseCranes = hcn >= 2 ? [{ z: mz, x: r2(-B * 0.3) }, { z: mz, x: r2(B * 0.3) }] : [{ z: mz - 3, x: 0 }];
    if (gas && m.id === 'vlgc86k') ga.deck.compressor = { z0: r2(house.z0 - 16), z1: r2(house.z0 - 5), w: r2(B * 0.4) };
    if (tok.has('rot')) { const n = L < 200 ? 2 : 4; for (let i = 0; i < n; i++) ga.deck.rotors.push({ z: r2(za + 4 + i * 9), x: 0, h: 30, r: 2.5 }); }
    ga.deck.boats.push(L >= 100 ? { kind: 'freefall', z: r2(house.z1 + 2.4), x: 0, y: r2(ga.deckY + 2.8 * 1.2) } : { kind: 'davit', z: r2(house.z0 + 3), x: r2(B / 2 - 0.6), y: r2(ga.deckY + 2.8) });
    ga.deck.boats.push({ kind: 'rescue', z: r2(house.z0 + 2), x: r2(-(B / 2 - 0.8)), y: r2(ga.deckY + 2.8) });
    ga.deck.masts.push({ z: r2(-L / 2 + Math.max(4, L * 0.04)), h: r2(clamp(6, 14, L * 0.05)), y: r2(ga.deckY + H.fcsle.h) });
    ga.deck.catwalk = { z0: za, z1: zb, x: r2(gas ? 0 : B * 0.12), h: 2.2 };
  },

  lng(ga, m) {
    const { L, B } = ga, H = ga.hull;
    H.bow = 'bulb'; H.stern = 'cruiser'; H.sternW = 0.5; H.fcsle = { len: r2(L * 0.07), h: 3.0 }; H.sheerFwd = r2(L * 0.006);
    const house = aftHouse(ga, m, { tierN: 6, len: r2(L * 0.065), w: B * 0.78, poopLen: r2(L * 0.05), uses: ['ccr', 'cabins', 'officers', 'senior', 'pilot', 'senior'] });
    stackFunnel(ga, { z: house.z1 - 4, kind: 'twin', r: r2(B * 0.045) });
    erFor(ga, m, 0.12);
    const za = r2(-L / 2 + H.fcsle.len + 2), zb = r2(house.z0 - 4), n = 4, gap = 3, tl = (zb - za - gap * (n - 1)) / n;
    ga.cargo = { kind: 'membrane', zones: [] };
    for (let i = 0; i < n; i++) ga.cargo.zones.push({ id: `tank${i + 1}`, z0: r2(za + i * (tl + gap)), z1: r2(za + i * (tl + gap) + tl), w: r2(B * 0.74), trunkH: 3.6 });
    ga.deck.compressor = { z0: r2(za + 2 * (tl + gap) - gap - 9), z1: r2(za + 2 * (tl + gap) - gap + 0.5), w: r2(B * 0.3), onTrunk: true };
    ga.deck.manifold = { z: r2((za + zb) / 2) };
    ga.deck.hoseCranes = [{ z: r2((za + zb) / 2 - 6), x: r2(-B * 0.32) }, { z: r2((za + zb) / 2 - 6), x: r2(B * 0.32) }];
    ga.deck.boats.push({ kind: 'freefall', z: r2(house.z1 + 2.4), x: 0, y: r2(ga.deckY + 3.4) }, { kind: 'rescue', z: r2(house.z0 + 2), x: r2(-(B / 2 - 0.8)), y: r2(ga.deckY + 2.8) });
    ga.deck.masts.push({ z: r2(-L / 2 + L * 0.03), h: 14, y: r2(ga.deckY + 3) });
    ga.deck.catwalk = { z0: za, z1: zb, x: 0, h: 4.2 };
  },

  container(ga, m, tok) {
    const { L, B, D } = ga, H = ga.hull, teu = m.units.teu || 1000;
    H.bow = 'bulb'; H.stern = 'cruiser'; H.sternW = 0.62; H.fcsle = { len: r2(L * 0.075), h: 3.0 }; H.flare = 0.55; H.sheerFwd = r2(L * 0.006);
    const twin = teu >= 14000;
    const rows = Math.floor((B - 1.2) / 2.55);
    const tiersHold = Math.max(2, Math.floor((D - clamp(1, 2, B / 20) - 1.5) / 2.59));
    let deckT = deckTiersFor(teu);
    const bayP = 13.0;                              // 40 ft bay + lashing bridge (§6.3)
    const poopLen = r2(Math.max(5, L * 0.035));
    const hlen = r2(clamp(10, 22, L * 0.045));
    const hw = r2(B * (twin ? 0.62 : 0.72));
    let house, zones = [];
    const hatchY = ga.deckY + 1.6;
    const mk = (z0, n, cap = deckT) => { for (let i = 0; i < n; i++) zones.push({ id: `bay${zones.length + 1}`, z0: r2(z0 + i * bayP), z1: r2(z0 + i * bayP + 12.2), rows, tiersHold, tiersDeck: cap }); return z0 + n * bayP; };
    const zFwd = -L / 2 + H.fcsle.len + 1.5;
    if (twin) {
      // twin island: house about 0.62 L from the stern, engine casing + funnel aft (§6.3)
      const hz0 = r2(L / 2 - 0.64 * L);
      const nF = Math.floor((hz0 - 1 - zFwd) / bayP);
      house = { pos: 'mid', z0: hz0, z1: r2(hz0 + hlen), w: hw, tiers: [], eyeY: 0 };
      const casZ = r2(L / 2 - L * 0.16);
      const nM = Math.floor((casZ - 9 - (house.z1 + 1)) / bayP);
      const nA = Math.floor((L / 2 - poopLen - (casZ + 9)) / bayP);
      mk(hz0 - 1 - nF * bayP, nF);
      mk(house.z1 + 1, nM);
      mk(casZ + 9, nA);
      ga.casing = { z0: r2(casZ - 8), z1: r2(casZ + 8), w: r2(B * 0.3) };
      ga.funnel = { z: casZ, y: 0, r: r2(B * 0.07), h: 0, kind: 'single' };
    } else {
      const aftBays = teu >= 2800 ? (teu >= 4000 ? 3 : 2) : 0;
      const hz1 = r2(L / 2 - poopLen - aftBays * bayP - 1);
      house = { pos: 'aft', z0: r2(hz1 - hlen), z1: hz1, w: hw, tiers: [], eyeY: 0 };
      const nF = Math.floor((house.z0 - 1 - zFwd) / bayP);
      mk(house.z0 - 1 - nF * bayP, nF);
      if (aftBays) mk(hz1 + 1, aftBays);
    }
    // the SOLAS V/22 eye-height rule sets the house height: lowest tier count whose eye sees past the stacks ahead
    const fwd = zones.filter((z) => z.z1 <= house.z0);
    const lim = blindLimit(L);
    let n = 4, eyeY = 0;
    for (; n <= 16; n++) {
      eyeY = ga.deckY + n * TIER.merchant + 1.7;   // = bridgeOn's eye: bridge floor on the top tier + 1.7 m
      const ok = fwd.every((z) => blindDistance(-L / 2, house.z0 + 2, eyeY, z.z0, hatchY + z.tiersDeck * 2.59) <= lim);
      if (ok) break;
    }
    // fore-most bays drop a tier or two (bow flare and the same sight line)
    if (fwd.length > 2) { fwd[0].tiersDeck = Math.max(1, deckT - 2); fwd[1].tiersDeck = Math.max(1, deckT - 1); }
    house.tiers = tiers(n, ga.deckY, TIER.merchant, ['mess', 'cabins', 'cabins', 'officers', 'officers', 'senior', 'senior', 'pilot']);
    ga.house = house;
    bridgeOn(ga, house, { len: Math.min(hlen, 9) });
    if (!twin) stackFunnel(ga, { z: house.z1 - 3.2, r: r2(clamp(1.4, 5, B * 0.075)) });
    else { ga.funnel.y = r2(ga.deckY + 12); ga.funnel.h = r2(Math.max(16, deckT * 2.59 + 6)); }
    ga.cargo = { kind: 'bays', zones, rows, hatchY: r2(hatchY) };
    erFor(ga, m, 0.12);
    if (twin) ga.er.shaft = { z0: r2(house.z1), z1: ga.er.z0 };
    const geared = tok.has('geared');
    if (geared) { const gz = zones.filter((z) => z.z1 <= house.z0); for (let i = 1; i < gz.length; i += Math.max(2, Math.ceil(gz.length / 3))) ga.deck.cranes.push({ z: r2(gz[i].z0 - 0.4), x: r2(B / 2 - 2.2), swl: 40, boom: 28, h: 12 }); }
    ga.deck.boats.push({ kind: 'freefall', z: r2((twin ? house.z1 : house.z1) + 2.4), x: 0, y: r2(ga.deckY + 3.0) }, { kind: 'rescue', z: r2(house.z0 + 2), x: r2(-(B / 2 - 0.8)), y: r2(ga.deckY + 2.8) });
    ga.deck.masts.push({ z: r2(-L / 2 + L * 0.03), h: 12, y: r2(ga.deckY + 3) });
    ga.deck.breakwater = { z: r2(zFwd - 0.6), h: r2(Math.min(8, deckT * 2.59 * 0.45)) };
  },

  roro_pctc(ga, m) {
    const { L, B } = ga, H = ga.hull, pctc = m.id === 'pctc7000';
    H.bow = 'bulb'; H.stern = 'transom'; H.sternW = 0.92; H.flare = pctc ? 0.95 : 0.45; H.sheerFwd = 0; H.sheerAft = 0;
    const box = { z0: r2(-L / 2 + L * (pctc ? 0.035 : 0.05)), z1: r2(L / 2 - (pctc ? 1.5 : L * 0.12)) };
    // ro-ro: the hull is closed to the upper deck; the 'house' is the bridge block forward on top
    const topY = ga.deckY;
    const house = { pos: 'fwd', z0: r2(box.z0 + (pctc ? 2 : 10)), z1: r2(box.z0 + (pctc ? 14 : 30)), w: r2(B * (pctc ? 0.98 : 0.86)),
      tiers: tiers(pctc ? 1 : 3, topY, TIER.merchant, ['officers', 'cabins', 'senior']), eyeY: 0 };
    ga.house = house;
    bridgeOn(ga, house, { len: pctc ? 9 : 11, wings: 'enclosed', wingTo: r2(B / 2 - 0.3) });
    ga.cargo = { kind: 'cardecks', zones: [{ id: 'cardecks', z0: box.z0, z1: box.z1, decks: pctc ? 12 : 4, clear: pctc ? 1.9 : 5.0, topY }] , box, slab: pctc };
    stackFunnel(ga, { z: r2(L / 2 - L * 0.12), r: r2(B * 0.06), top: topY + (pctc ? 3 : 8) });
    ga.funnel.h = pctc ? 9 : 10;
    erFor(ga, m, 0.12);
    ga.deck.sternRamp = { z: r2(L / 2), w: r2(pctc ? 7 : 16), len: r2(pctc ? 30 : 18), side: pctc ? 'quarter' : 'centre' };
    if (pctc) ga.deck.sideRamp = { z: r2(L * 0.05), x: r2(B / 2), len: 14 };
    ga.deck.boats.push({ kind: 'freefall', z: r2(L / 2 - 3), x: 0, y: r2(topY + 1.5) }, { kind: 'rescue', z: r2(house.z1 + 3), x: r2(B / 2 - 2), y: r2(topY + 0.5) });
    if (!pctc) ga.cargo.trailers = { z0: r2(house.z1 + 6), z1: r2(L / 2 - L * 0.17), y: r2(topY) };
  },

  ferry(ga, m) {
    const { L, B } = ga, H = ga.hull;
    const de = m.id === 'ferry50', hsc = m.id === 'hsc112', big = m.id === 'ropax200';
    H.bow = hsc ? 'wavepiercer' : de ? 'raked' : 'bulb'; H.stern = 'transom'; H.sternW = de ? 0.9 : 0.85; H.flare = 0.4;
    if (de) { H.doubleEnded = true; H.sheerFwd = 0.4; H.sheerAft = 0.4; }
    if (hsc) H.twin = { hullB: r2(B * 0.2), gap: r2(B * 0.6) };
    // car deck (closed hull up to the vehicle deck), passenger decks above, bridge forward
    const carTop = hsc ? ga.deckY : de ? ga.deckY + 5.0 : ga.deckY;
    const nPax = de ? 1 : hsc ? 2 : big ? 6 : 4;
    const z0 = r2(-L / 2 + L * (de ? 0.28 : hsc ? 0.14 : 0.13)), z1 = r2(L / 2 - L * (de ? 0.28 : hsc ? 0.12 : 0.06));
    const uses = de ? ['lounge'] : hsc ? ['lounge', 'lounge'] : big ? ['cabins', 'cabins', 'public', 'public', 'cabins', 'crew'] : ['public', 'public', 'cabins', 'crew'];
    const house = { pos: 'mid', z0, z1, w: r2(hsc ? B * 0.92 : B * (de ? 0.62 : 0.94)), tiers: tiers(nPax, carTop, TIER.pax, uses), eyeY: 0, carTop: r2(carTop) };
    ga.house = house;
    bridgeOn(ga, house, { len: de ? 5 : 10, wings: big || m.id === 'ferry' ? 'enclosed' : 'open', w: de ? r2(B * 0.42) : null });
    if (de) { ga.bridge.z0 = r2(-4); ga.bridge.z1 = r2(4); ga.bridge.twoWay = true; }
    ga.cargo = { kind: 'cardecks', zones: [{ id: 'car', z0: r2(-L / 2 + 3), z1: r2(L / 2 - 3), decks: big ? 2 : 1, clear: 5, topY: r2(carTop) }], open: de };
    if (!de) stackFunnel(ga, { z: r2(z1 - L * 0.12), kind: hsc ? 'twin' : 'single', r: r2(B * 0.07), top: r2(house.tiers[house.tiers.length - 1].y + TIER.pax + 2) });
    else ga.funnel = { z: 0, y: r2(carTop + TIER.pax + 0.5), r: 0.5, h: 4, kind: 'twin' };
    if (!hsc && !de) ga.funnel.h = r2(Math.max(7, B * 0.3));
    erFor(ga, m, 0.15);
    // davit lifeboats on both sides of the boat deck (SOLAS III/31); liferafts on small ferries
    const bd = house.tiers[Math.min(1, house.tiers.length - 1)];
    const nb = big ? 4 : m.id === 'ferry' ? 2 : 0;
    for (let i = 0; i < nb; i++) for (const s of [-1, 1]) ga.deck.boats.push({ kind: 'davit', z: r2(z0 + (z1 - z0) * (0.3 + i * 0.14)), x: r2(s * (house.w / 2 - 0.4)), y: r2(bd.y + 1.4), recess: true });
    if (!nb) for (const s of [-1, 1]) ga.deck.boats.push({ kind: 'raft', z: r2((z0 + z1) / 2), x: r2(s * (house.w / 2 + 0.2)), y: r2(house.tiers[0].y + 1.2) });
    ga.deck.bowDoor = !hsc; ga.deck.sternDoor = true;
  },

  cruise(ga, m) {
    const { L, B } = ga, H = ga.hull, exp = m.id === 'expedition105';
    H.bow = exp ? 'axe' : 'bulb'; H.stern = 'transom'; H.sternW = 0.8; H.flare = 0.5; H.sheerFwd = 0; H.sheerAft = 0;
    const decks = exp ? 6 : m.id === 'cruise230' ? 9 : m.id === 'cruise330' ? 14 : 16;
    const z0 = r2(-L / 2 + L * (exp ? 0.12 : 0.1)), z1 = r2(L / 2 - L * 0.025);
    const uses = [];
    for (let i = 0; i < decks; i++) uses.push(i < 2 ? 'public' : i === decks - 1 ? 'lido' : i >= decks - 3 && !exp ? 'public' : 'balcony');
    const house = { pos: 'mid', z0, z1, w: r2(B * 0.98), tiers: tiers(decks, ga.deckY, TIER.pax, uses), eyeY: 0 };
    ga.house = house;
    // bridge two decks below the top, as on most cruise ships, wings to the side
    const bi = Math.max(2, decks - (exp ? 2 : 4));
    house.tiers[bi].use = 'bridge';
    ga.bridge = { y: house.tiers[bi].y, z0: r2(z0 - 1), z1: r2(z0 + 9), w: house.w, h: TIER.pax, wings: 'enclosed', wingTo: r2(B / 2 - 0.3), aftConsole: false, consoles: [], embedded: true };
    house.eyeY = r2(ga.bridge.y + 1.7);
    const topY = house.tiers[decks - 1].y + TIER.pax;
    stackFunnel(ga, { z: r2(z1 - L * (exp ? 0.32 : 0.22)), kind: exp ? 'single' : 'twin', r: r2(B * (exp ? 0.09 : 0.12)), top: topY - 1 });
    ga.funnel.h = r2(exp ? 6 : Math.max(11, B * 0.36));
    ga.cargo = { kind: 'paxdecks', zones: [] };
    erFor(ga, m, 0.1);
    // lifeboats in a recess along the lower public deck (both sides)
    const lb = house.tiers[1];
    const nb = exp ? 2 : Math.round(L / 32);
    if (!exp) { lb.w = r2(B - 2 * (2 * 1.8 + 1.4)); lb.use = 'public'; }
    for (let i = 0; i < nb; i++) for (const s of [-1, 1]) ga.deck.boats.push({ kind: exp ? 'tender' : 'davit', z: r2(z0 + 20 + i * ((z1 - z0) * 0.62) / Math.max(1, nb - 1)), x: r2(s * (B / 2 - 2.3)), y: r2(lb.y + 1.9), recess: true, big: !exp });
    ga.deck.pool = { z0: r2(z0 + (z1 - z0) * 0.35), z1: r2(z0 + (z1 - z0) * 0.55), y: r2(topY) };
    if (exp) { ga.deck.heli = { z: r2(z1 - 12), y: r2(house.tiers[decks - 2].y + TIER.pax), r: 8 }; ga.deck.pool = null; }
  },

  offshore(ga, m) {
    const { L, B } = ga, H = ga.hull;
    const axe = ['psv90', 'sov90'].includes(m.id);
    H.bow = axe ? 'axe' : 'raked'; H.stern = 'transom'; H.sternW = 0.94; H.flare = 0.35; H.sheerFwd = r2(L * (axe ? 0.03 : 0.045)); H.sheerAft = 0;
    H.fcsle = axe ? null : { len: r2(L * 0.32), h: 2.6 }; H.bulwark = 1.1;
    const tierN = m.id === 'sov90' ? 6 : m.id === 'ahts85' ? 5 : 4;
    const hz0 = r2(-L / 2 + L * (axe ? 0.04 : 0.07));
    const house = { pos: 'fwd', z0: hz0, z1: r2(hz0 + L * (m.id === 'sov90' ? 0.42 : 0.28)), w: r2(B * 0.96), tiers: tiers(tierN, ga.deckY + (axe ? 0 : 2.6), TIER.offshore, ['mess', 'cabins', 'cabins', 'officers', 'cabins', 'officers']), eyeY: 0 };
    ga.house = house;
    bridgeOn(ga, house, { len: 9, wings: 'enclosed', aftConsole: true });
    ga.funnel = { z: r2(house.z1 - 2), y: r2(house.tiers[1].y), r: 0.9, h: r2(ga.bridge.y + 3 - house.tiers[1].y), kind: 'side' };
    ga.casing = { z0: r2(house.z1 - 4), z1: house.z1, w: 2 };
    ga.cargo = { kind: 'deck', zones: [{ id: 'aftdeck', z0: r2(house.z1 + 2), z1: r2(L / 2 - 1.5), w: r2(B - 2.4) }] };
    erFor(ga, m, 0.18);
    if (m.eq.includes('sternRoller')) ga.deck.sternRoller = { z: r2(L / 2 - 0.6), w: r2(B * 0.3) };
    if (m.eq.includes('towWinch')) ga.deck.towWinch = { z: r2(house.z1 + 1), w: r2(B * 0.45) };
    if (m.id === 'sov90') ga.deck.gangway = { z: r2(house.z1 + 8), x: r2(B * 0.25), h: 12, len: 24 };
    ga.deck.boats.push({ kind: 'rescue', z: r2(house.z1 - 6), x: r2(B / 2 - 0.9), y: r2(house.tiers[1].y) }, { kind: 'raft', z: r2(house.z1 - 10), x: r2(-(B / 2 - 0.5)), y: r2(house.tiers[1].y) });
    if (m.id === 'sov90') ga.deck.heli = null;
    if (m.eq.includes('survey') || m.id.startsWith('psv')) ga.deck.cranes.push({ z: r2(L / 2 - 10), x: r2(-(B / 2 - 2)), swl: 10, boom: 14, h: 4 });
  },

  tug(ga, m) {
    const { L, B } = ga, H = ga.hull, ocean = m.id === 'oceantug60', multi = m.id === 'multicat27', pusher = m.id === 'tug16';
    H.bow = multi || pusher ? 'raked' : 'tug'; H.stern = multi ? 'transom' : 'tug'; H.sternW = multi ? 0.95 : 0.7;
    H.sheerFwd = r2(L * (multi ? 0.01 : 0.05)); H.sheerAft = 0; H.flare = 0.6; H.bulwark = multi ? 0.9 : 1.0;
    H.fender = !multi; H.pushKnees = pusher;
    if (ocean) H.fcsle = { len: r2(L * 0.38), h: 2.6 };
    const hz0 = ocean ? r2(-L / 2 + L * 0.1) : multi ? r2(-L / 2 + L * 0.12) : r2(-L / 2 + L * 0.3);
    const hl = ocean ? L * 0.28 : multi ? L * 0.22 : L * 0.34;
    const tierN = ocean ? 3 : multi ? 1 : pusher ? 0 : 1;
    const house = { pos: 'fwd', z0: hz0, z1: r2(hz0 + hl), w: r2(B * (multi ? 0.45 : 0.6)), tiers: tiers(tierN, ga.deckY + (ocean ? 2.6 : 0), multi || ocean ? TIER.offshore : 2.4, ['mess', 'cabins', 'officers']), eyeY: 0 };
    ga.house = house;
    const wl = Math.min(hl * 0.7, ocean ? 8 : 4.5);
    if (!tierN) { house.tiers = []; ga.bridge = { y: r2(ga.deckY), z0: hz0, z1: r2(hz0 + wl), w: house.w, h: 2.4, wings: 'none', wingTo: 0, aftConsole: true, consoles: [] }; house.eyeY = r2(ga.deckY + 1.7); }
    else bridgeOn(ga, house, { len: wl, wings: ocean ? 'enclosed' : 'none', aftConsole: true, w: r2(house.w * (ocean ? 1 : 0.92)) });
    ga.bridge.allRound = true;
    ga.funnel = { z: r2(house.z1 - 1), y: r2(ga.deckY + 1), r: r2(Math.max(0.25, B * 0.025)), h: r2(ga.bridge.y + 2.5 - ga.deckY), kind: 'side' };
    ga.cargo = { kind: multi ? 'deck' : 'none', zones: multi ? [{ id: 'deck', z0: r2(house.z1 + 1), z1: r2(L / 2 - 1), w: r2(B - 1.4) }] : [] };
    erFor(ga, m, 0.3);
    if (!pusher) ga.deck.towWinch = { z: ocean ? r2(house.z1 + 2) : multi ? r2(house.z1 + 1.5) : r2(hz0 - 2.5), w: r2(B * (ocean ? 0.45 : 0.32)), fwd: !ocean && !multi };
    if (ocean) ga.deck.sternRoller = { z: r2(L / 2 - 0.5), w: r2(B * 0.25) };
    if (!ocean && !multi && !pusher) ga.deck.staple = { z: r2(L / 2 - L * 0.12), w: r2(B * 0.6) };
    if (multi) ga.deck.cranes.push({ z: r2(house.z1 + 3), x: r2(-(B / 2 - 1.6)), swl: 25, boom: 9, h: 2.5 });
    if (m.eq.includes('fifi')) ga.deck.fifi = { z: r2(house.z0 + 1), y: r2(ga.bridge.y + 3.2) };
    ga.deck.boats.push({ kind: 'raft', z: r2(house.z1 - 0.8), x: r2(house.w / 2 + 0.25), y: r2(house.tiers[0]?.y ?? ga.deckY) });
  },

  fishing(ga, m) {
    const { L, B } = ga, H = ga.hull;
    H.bow = L >= 60 ? 'bulb' : 'raked'; H.stern = ['trawler', 'factory80'].includes(m.id) ? 'ramp' : 'transom'; H.sternW = 0.85; H.flare = 0.5;
    H.sheerFwd = r2(L * 0.05); H.sheerAft = r2(L * 0.01); H.bulwark = 1.2;
    if (L > 30) H.fcsle = { len: r2(L * 0.32), h: r2(Math.min(2.6, 0.9 + L * 0.02)) };
    const inshore = m.id === 'inshore15';
    const tierN = inshore ? 1 : m.id === 'factory80' ? 4 : L > 60 ? 3 : 2;
    const hz0 = r2(-L / 2 + L * (inshore ? 0.3 : 0.12));
    const house = { pos: 'fwd', z0: hz0, z1: r2(hz0 + L * (inshore ? 0.22 : 0.25)), w: r2(B * (inshore ? 0.55 : 0.82)), tiers: tiers(tierN, ga.deckY + (H.fcsle ? H.fcsle.h : 0), inshore ? 2.2 : TIER.merchant, ['mess', 'cabins', 'officers', 'cabins']), eyeY: 0 };
    ga.house = house;
    bridgeOn(ga, house, { len: Math.min(house.z1 - house.z0, inshore ? 3.2 : 7), wings: 'enclosed', aftConsole: true, w: r2(house.w * (inshore ? 1 : 0.9)) });
    ga.funnel = { z: r2(house.z1 - 1), y: r2(house.tiers[0].y), r: r2(clamp(0.25, 1.1, B * 0.05)), h: r2(ga.bridge.y + 3 - house.tiers[0].y), kind: inshore ? 'mast' : 'single' };
    ga.cargo = { kind: 'fishhold', zones: [{ id: 'hold', z0: r2(house.z1 + 2), z1: r2(L / 2 - L * 0.12), w: r2(B * 0.5) }] };
    erFor(ga, m, 0.2);
    if (m.id === 'trawler' || m.id === 'factory80') ga.deck.aframe = { z: r2(L / 2 - 2), h: r2(Math.min(12, B * 0.8)), w: r2(B * 0.75), kind: 'gantry' };
    if (m.id === 'beam40') ga.deck.derricks = { z: r2(-L / 2 + L * 0.5), len: r2(B * 1.25) };
    if (m.id === 'seiner75') { ga.deck.powerBlock = { z: r2(L / 2 - L * 0.18), h: 12 }; ga.deck.netBin = { z0: r2(L / 2 - L * 0.15), z1: r2(L / 2 - 1.5) }; }
    if (m.id === 'longliner50') ga.deck.haulingPort = { z: r2(-L / 2 + L * 0.42), side: 1 };
    if (inshore) ga.deck.potHauler = { z: r2(hz0 + L * 0.3), side: 1 };
    ga.deck.masts.push({ z: r2(house.z0 + 1), h: r2(Math.min(10, 3 + L * 0.1)), y: r2(ga.bridge.y + 3) });
    ga.deck.boats.push({ kind: 'raft', z: r2(house.z1 - 0.8), x: r2(house.w / 2 + 0.25), y: r2(ga.bridge.y) });
  },

  small_fast(ga, m) {
    const { L, B } = ga, H = ga.hull, ctv = m.id === 'ctv26';
    H.bow = ctv ? 'wavepiercer' : 'planing'; H.stern = 'transom'; H.sternW = 0.92; H.flare = 0.3; H.sheerFwd = r2(L * 0.03); H.sheerAft = 0;
    if (ctv) H.twin = { hullB: r2(B * 0.28), gap: r2(B * 0.44) };
    H.fender = true;
    const hz0 = r2(-L / 2 + L * (ctv ? 0.26 : 0.32));
    const house = { pos: 'fwd', z0: hz0, z1: r2(hz0 + L * (ctv ? 0.3 : 0.32)), w: r2(B * (ctv ? 0.7 : 0.66)), tiers: ctv ? tiers(1, ga.deckY, 2.4, ['mess']) : [], eyeY: 0 };
    ga.house = house;
    ga.bridge = { y: r2(ctv ? ga.deckY + 2.4 : ga.deckY), z0: ctv ? r2(hz0 + 1) : hz0, z1: r2(ctv ? hz0 + 6 : house.z1), w: r2(house.w * (ctv ? 0.85 : 1)), h: 2.2, wings: 'none', wingTo: 0, aftConsole: false, consoles: [], allRound: true };
    house.eyeY = r2(ga.bridge.y + 1.6);
    ga.funnel = { z: r2(house.z1 - 0.6), y: r2(ga.bridge.y), r: 0.15, h: 2.6, kind: 'mast' };
    ga.cargo = { kind: ctv ? 'deck' : 'none', zones: ctv ? [{ id: 'foredeck', z0: r2(-L / 2 + 2), z1: r2(hz0 - 0.5), w: r2(B * 0.7) }] : [] };
    erFor(ga, m, 0.25);
    ga.deck.masts.push({ z: r2(house.z0 + (house.z1 - house.z0) * 0.6), h: 2.2, y: r2(ga.bridge.y + ga.bridge.h) });
    if (ctv) ga.deck.bowFender = { w: r2(B * 0.62) };
  },

  motor_yacht(ga, m) {
    const { L, B } = ga, H = ga.hull, rib = m.id === 'rib8', expl = m.id === 'explorer45';
    H.bow = expl ? 'ice' : L < 30 ? 'planing' : 'yacht'; H.stern = 'yacht'; H.sternW = 0.84; H.flare = 0.5; H.sheerFwd = r2(L * (L < 30 ? 0.035 : 0.02)); H.sheerAft = 0;
    H.bulwark = L >= 40 ? 1.0 : 0;
    if (rib) H.tube = true;
    const decks = rib ? 0 : L < 14 ? 1 : L < 20 ? 2 : L < 30 ? 2 : L < 50 ? 3 : L < 80 ? 3 : 4;
    const z0 = r2(-L / 2 + L * (L < 20 ? 0.3 : 0.24)), z1 = r2(L / 2 - L * (L < 20 ? 0.18 : 0.12));
    const tl = [];
    for (let i = 0; i < decks; i++) {
      // each deck steps back and narrows (Game rule of the classic wedding-cake profile)
      const zi0 = r2(z0 + (z1 - z0) * (0.04 + i * 0.1)), zi1 = r2(z1 - (z1 - z0) * (i * 0.12));
      const th = L < 14 ? 1.5 : L < 30 ? 2.3 : TIER.yacht;
      tl.push({ id: String.fromCharCode(65 + i), y: r2(ga.deckY + i * th), h: th, use: L < 14 ? 'windscreen' : i === 0 ? 'saloon' : i === decks - 1 && L >= 18 ? 'sundeck' : 'owner', z0: zi0, z1: zi1, w: r2(B * (0.86 - i * 0.05)) });
    }
    const house = { pos: 'mid', z0, z1, w: r2(B * 0.86), tiers: tl, eyeY: 0 };
    ga.house = house;
    if (rib) { ga.bridge = { y: r2(ga.deckY - 0.3), z0: r2(-0.6), z1: r2(0.6), w: 1.1, h: 1.1, wings: 'none', wingTo: 0, aftConsole: false, consoles: [], console: true }; house.eyeY = r2(ga.deckY + 1.3); }
    else {
      const bi = Math.min(decks - 1, decks >= 3 ? decks - 2 : decks - 1);
      const t = tl[bi];
      ga.bridge = { y: t.y, z0: t.z0, z1: r2(t.z0 + Math.min(6, (t.z1 - t.z0) * 0.35)), w: t.w, h: t.h, wings: L >= 40 ? 'enclosed' : 'none', wingTo: r2(B / 2 - 0.3), aftConsole: false, consoles: [], embedded: true };
      if (L >= 30) t.use = 'bridge';
      house.eyeY = r2(t.y + 1.6);
      if (L >= 14 && L < 30) ga.deck.flybridge = { y: r2(tl[decks - 1].y + tl[decks - 1].h), z0: tl[decks - 1].z0, z1: tl[decks - 1].z1 };
    }
    ga.funnel = expl ? { z: r2(z1 - L * 0.12), y: r2(ga.deckY + decks * TIER.yacht - 1), r: 0.7, h: 3, kind: 'single' } : { z: 0, y: 0, r: 0, h: 0, kind: 'none' };
    ga.cargo = { kind: 'none', zones: [] };
    erFor(ga, m, 0.2);
    if (!rib && L >= 12) ga.deck.masts.push({ z: r2(ga.bridge.z0 + 3), h: r2(Math.min(6, 1 + L * 0.06)), y: r2(tl[decks - 1].y + tl[decks - 1].h), arch: L < 40 });
    if (m.eq.includes('tender') || L >= 40) ga.deck.boats.push({ kind: 'tender', z: r2(expl ? L / 2 - L * 0.17 : z1 - 2), x: 0, y: r2(expl ? ga.deckY + 0.2 : tl[Math.max(0, decks - 1)].y + TIER.yacht + 0.1), garage: !expl });
    if (expl) ga.deck.cranes.push({ z: r2(L / 2 - L * 0.1), x: r2(B / 2 - 1.4), swl: 5, boom: 9, h: 2 });
    if (m.eq.includes('helideck')) ga.deck.heli = { z: r2(-L / 2 + L * 0.17), y: r2(ga.deckY + 3.0), r: r2(B * 0.45) };
    ga.deck.swimPlatform = !rib && L >= 12;
  },

  special(ga, m) {
    const { L, B } = ga, H = ga.hull;
    if (m.id === 'icebreaker120') {
      H.bow = 'ice'; H.stern = 'ice'; H.sternW = 0.75; H.flare = 0.2; H.sheerFwd = 1.5; H.fcsle = { len: r2(L * 0.42), h: 2.8 };
      const hz0 = r2(-L / 2 + L * 0.2);
      const house = { pos: 'fwd', z0: hz0, z1: r2(hz0 + L * 0.3), w: r2(B * 0.86), tiers: tiers(6, ga.deckY + 2.8, TIER.offshore, ['mess', 'labs', 'cabins', 'cabins', 'officers', 'senior']), eyeY: 0 };
      ga.house = house; bridgeOn(ga, house, { len: 10, wings: 'enclosed', aftConsole: true });
      stackFunnel(ga, { z: r2(house.z1 - 6), kind: 'twin', r: r2(B * 0.05), top: ga.bridge.y + 1 });
      ga.funnel.h = 9;
      ga.deck.heli = { z: r2(house.z1 + 10), y: r2(house.tiers[2].y), r: 11, hangar: { z0: r2(house.z1), z1: r2(house.z1 + 2) } };
      ga.deck.aframe = { z: r2(L / 2 - 2), h: 9, w: r2(B * 0.5), kind: 'aframe' };
      ga.deck.cranes.push({ z: r2(hz0 - 6), x: r2(B / 2 - 3), swl: 25, boom: 18, h: 4 });
      ga.cargo = { kind: 'deck', zones: [{ id: 'aft', z0: r2(house.z1 + 22), z1: r2(L / 2 - 4), w: r2(B - 3) }] };
    } else if (m.id === 'research75') {
      H.bow = 'raked'; H.stern = 'transom'; H.sternW = 0.92; H.sheerFwd = r2(L * 0.04); H.fcsle = { len: r2(L * 0.45), h: 2.6 };
      const hz0 = r2(-L / 2 + L * 0.09);
      const house = { pos: 'fwd', z0: hz0, z1: r2(hz0 + L * 0.42), w: r2(B * 0.92), tiers: tiers(4, ga.deckY + 2.6, TIER.offshore, ['labs', 'cabins', 'cabins', 'officers']), eyeY: 0 };
      ga.house = house; bridgeOn(ga, house, { len: 9, wings: 'enclosed', aftConsole: true });
      stackFunnel(ga, { z: r2(house.z1 - 7), r: r2(B * 0.07), top: ga.bridge.y + 0.5 });
      ga.funnel.h = 7;
      ga.deck.aframe = { z: r2(L / 2 - 1.5), h: 9, w: r2(B * 0.6), kind: 'aframe' };
      ga.deck.cranes.push({ z: r2(house.z1 + 4), x: r2(B / 2 - 2), swl: 10, boom: 14, h: 3 });
      ga.cargo = { kind: 'deck', zones: [{ id: 'aft', z0: r2(house.z1 + 2), z1: r2(L / 2 - 2), w: r2(B - 3) }] };
    } else {   // tshd100 trailing suction hopper dredger
      H.bow = 'raked'; H.stern = 'transom'; H.sternW = 0.9; H.fcsle = { len: r2(L * 0.12), h: 2.6 }; H.bulwark = 1.1;
      const hz0 = r2(-L / 2 + L * 0.03);
      const house = { pos: 'fwd', z0: hz0, z1: r2(hz0 + L * 0.14), w: r2(B * 0.8), tiers: tiers(4, ga.deckY + 2.6, TIER.merchant, ['mess', 'cabins', 'officers', 'senior']), eyeY: 0 };
      ga.house = house; bridgeOn(ga, house, { len: 8, wings: 'open', aftConsole: true });
      stackFunnel(ga, { z: r2(L / 2 - L * 0.12), r: r2(B * 0.06), top: ga.deckY + 14 });
      ga.funnel.h = 8;
      ga.cargo = { kind: 'hopper', zones: [{ id: 'hopper', z0: r2(house.z1 + 6), z1: r2(L / 2 - L * 0.22), w: r2(B * 0.62), depth: r2(ga.D - 2) }] };
      ga.deck.dragArm = { z0: r2(house.z1 + 8), z1: r2(L / 2 - L * 0.16), side: 1 };
    }
    erFor(ga, m, 0.1);
    ga.deck.boats.push({ kind: 'rescue', z: r2(ga.house.z1 - 4), x: r2(B / 2 - 0.9), y: r2(ga.house.tiers[1].y) });
    ga.deck.masts.push({ z: r2(ga.bridge.z0 + 3), h: 6, y: r2(ga.bridge.y + ga.bridge.h) });
  },
};

function finishCommon(ga, m) {
  const { L, B } = ga;
  if (!ga.funnel) ga.funnel = { z: 0, y: 0, r: 0, h: 0, kind: 'none' };
  if (!ga.casing) ga.casing = { z0: ga.funnel.z - 1, z1: ga.funnel.z + 1, w: 2 };
  if (!ga.deck.mooring.length) mooringEnds(ga);
  ga.levels = [{ id: 'tanktop', y: r2(-ga.T + clamp(1, 2, B / 20)), name: 'Tank top' }, { id: 'main', y: ga.deckY, name: 'Main deck' }];
  for (const t of ga.house?.tiers || []) ga.levels.push({ id: t.id, y: t.y, name: `${t.id} deck` });
  if (ga.bridge) ga.levels.push({ id: 'bridge', y: ga.bridge.y, name: 'Bridge' });
  if (L > 60) {
    ga.goto = [
      { id: 'bridge', label: 'Bridge', x: 0, y: ga.bridge.y, z: r2((ga.bridge.z0 + ga.bridge.z1) / 2) },
      { id: 'bow', label: 'Bow', x: 0, y: r2(ga.deckY + (ga.hull.fcsle?.h || 0)), z: r2(-L / 2 + L * 0.05) },
      { id: 'stern', label: 'Stern', x: 0, y: ga.deckY, z: r2(L / 2 - L * 0.03) },
      { id: 'er', label: 'Engine room', x: 0, y: ga.er.floorY, z: ga.er.me.z },
    ];
  }
  void m;
}

/** Height of the highest point above the waterline (air draft of the GA, for tests and the spec sheet). */
export function gaAirDraft(ga) {
  let top = ga.deckY;
  if (ga.bridge) top = Math.max(top, ga.bridge.y + ga.bridge.h + 4);
  if (ga.funnel && ga.funnel.kind !== 'none') top = Math.max(top, ga.funnel.y + ga.funnel.h);
  for (const r of ga.deck.rotors) top = Math.max(top, ga.deckY + r.h);
  return r2(top);
}
