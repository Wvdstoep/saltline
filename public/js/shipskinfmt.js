// Ship exterior skin: pure layout maths and presets (no three.js, no DOM — node tests in test/shipskin.test.mjs).
// public/js/shipskin.js turns these numbers into shader uniforms and canvas textures. Everything is in METRES in the
// ship frame (x starboard, y up with 0 at the design waterline, z aft, bow at −L/2), so a 400 m container ship and a
// 20 m tug get plates, letters and draft marks of their real size from the same code.

const clamp = (lo, hi, v) => Math.max(lo, Math.min(hi, v));
const r3 = (v) => Math.round(v * 1000) / 1000;

/** Surface presets (PBR): painted steel, bare steel, aluminium, GRP gelcoat, teak, canvas, glass, rubber, rope. */
export const PRESETS = {
  paint: { roughness: 0.5, metalness: 0.0, clearcoat: 0.2, clearcoatRoughness: 0.3, envMapIntensity: 1.0 },     // fresh hull paint
  housePaint: { roughness: 0.55, metalness: 0.0, envMapIntensity: 0.8 },
  deckPaint: { roughness: 0.9, metalness: 0.0, envMapIntensity: 0.45 },                                            // non-slip deck coating
  fittings: { roughness: 0.6, metalness: 0.05, envMapIntensity: 0.7 },                                            // painted gear, hatch covers, cranes
  bareSteel: { roughness: 0.4, metalness: 0.9, envMapIntensity: 1.0 },
  aluminium: { roughness: 0.35, metalness: 0.85, envMapIntensity: 1.0 },
  gelcoat: { roughness: 0.3, metalness: 0.0, clearcoat: 0.6, clearcoatRoughness: 0.12, envMapIntensity: 1.0 },   // GRP / faired yacht hull
  teak: { roughness: 0.82, metalness: 0.0, envMapIntensity: 0.4 },
  canvas: { roughness: 0.95, metalness: 0.0, envMapIntensity: 0.3 },
  glass: { roughness: 0.06, metalness: 0.35, envMapIntensity: 1.3 },
  rubber: { roughness: 0.95, metalness: 0.0, envMapIntensity: 0.2 },
  rope: { roughness: 1.0, metalness: 0.0, envMapIntensity: 0.2 },
  funnel: { roughness: 0.5, metalness: 0.0, envMapIntensity: 0.8 },
};

/** Material kind (shipgen / ship.js makeMat key) → shader skin id (SKIN_KIND define). 0 = no skin shader. */
export const SKIN_KIND = { hull: 1, boot: 1, band: 1, hullX: 1, deck: 2, house: 3, funnel: 4, paint: 5, metal: 5 };
export function skinKindOf(kind) { return SKIN_KIND[kind] || 0; }

/** Hull finish: 0 painted steel (plates, welds, rust), 1 faired yacht hull (gelcoat / fairing compound, no seams). */
export function hullModeOf(gen) { return gen === 'motor_yacht' || gen === 'small_fast' || gen === 'sail' ? 1 : 0; }
/** Deck finish: 0 steel with non-slip coating and walkways, 1 laid teak. */
export function deckModeOf(gen, deckHex) { return gen === 'motor_yacht' || gen === 'sail' || deckHex === 0xb08a5a ? 1 : 0; }

/**
 * Plate layout of a steel hull (m): strake height (horizontal seams), butt spacing (vertical seams), seam strength,
 * scupper spacing along the deck edge. Real plates are ~2–3 m × 6–12 m whatever the ship, a little smaller on small craft.
 */
export function plateGrid(L, mode = 0) {
  if (mode === 1) return { strake: 0, butt: 0, seam: 0, scupper: 0 };
  const strake = r3(clamp(1.4, 3.0, 1.2 + 0.006 * L));
  const butt = r3(clamp(4.5, 12, 3.5 + 0.03 * L));
  const seam = L < 25 ? 0.6 : 1;
  const scupper = r3(clamp(5, 18, 0.055 * L));
  return { strake, butt, seam, scupper };
}

/** Weathering 0..1 (rust streaks, waterline staining, dull paint) from hull condition % and age in years. */
export function weathering({ cond = 100, ageYears = null, seed = 0 } = {}) {
  const c = clamp(0, 100, Number.isFinite(cond) ? cond : 100);
  // unknown age: a deterministic 3–18 years from the seed, so traffic varies but one ship always looks the same
  const age = Number.isFinite(ageYears) && ageYears >= 0 ? ageYears : 3 + ((((seed >>> 0) * 2654435761) >>> 0) % 1000) / 1000 * 15;
  const fromAge = clamp(0, 0.75, age / 28);
  const fromCond = clamp(0, 1, (100 - c) / 60);
  return r3(clamp(0, 1, 0.12 + 0.55 * fromAge + 0.45 * fromCond - (age < 1.5 && c > 95 ? 0.12 : 0)));
}

/** Letter cap height (m) of the bow name: ~0.25 m on a RIB, ~2.4 m on a VLCC. */
export function capHeight(L, deckY) { return r3(clamp(0.2, 2.4, 0.006 * L + 0.12 * Math.max(0.5, deckY))); }

/**
 * Where the name goes. dims { L, B, deckY, bootH, zStemAt(y) → z of the stem at height y (optional), zAftAt(y) (optional),
 * transomHalf (m, optional) }, tex { aspect: canvas W / H, fill: drawn text width / canvas W, rows: 2 (name, port) }.
 * Returns { bow: { zc, yc, w, h }, stern: { zt, yc, w, h } } in metres; w = h = 0 when there is no room. The texture's
 * top row holds the name (bow and stern), the bottom row the port of registry (stern only).
 */
export function nameLayout(dims, tex = {}) {
  const { L, B, deckY } = dims, bootH = dims.bootH ?? 0.4;
  const aspect = tex.aspect || 4, fill = clamp(0.05, 1, tex.fill ?? 0.8), rows = tex.rows || 2;
  const cap = capHeight(L, deckY);
  // one row is cap / 0.62 high (font size ≈ row height, caps ≈ 0.62 of it); the texture holds `rows` rows
  let rowH = cap / 0.62;
  const room = deckY - 0.25 - Math.max(bootH + 0.25, 0.4);       // between boot top and the deck edge
  if (rowH > room * 0.8) rowH = Math.max(0, room * 0.8);
  const out = { bow: { zc: 0, yc: 0, w: 0, h: 0 }, stern: { zt: L / 2, yc: 0, w: 0, h: 0 } };
  if (rowH < 0.12) return out;
  const texH = rowH * rows, texW = texH * aspect, textW = texW * fill;
  // bow: the name row's centre a little below the deck edge, its forward end a few letters aft of the stem
  const yRow = deckY - 0.25 - rowH * 0.6;
  const yc = yRow - (rows - 1) * rowH / 2;                         // texture centre (the name is the TOP row)
  const zStem = typeof dims.zStemAt === 'function' ? dims.zStemAt(yRow) : -L / 2 + 0.03 * L;
  const zStart = zStem + Math.max(0.05 * L, 1.2 * cap);
  out.bow = { zc: r3(zStart + textW / 2), yc: r3(yc), w: r3(texW), h: r3(texH) };
  // stern: centred on the transom, half way up the freeboard, no wider than ~80 % of the transom
  const half = dims.transomHalf ?? B * 0.4;
  let sw = texW, sh = texH;
  if (textW > half * 1.6) { const k = (half * 1.6) / textW; sw *= k; sh *= k; }
  const syc = Math.max(bootH + sh / 2 + 0.2, deckY * 0.55);
  if (half > 0.5 && syc + sh / 2 < deckY) out.stern = { zt: r3(typeof dims.zAftAt === 'function' ? dims.zAftAt(syc) : L / 2), yc: r3(syc), w: r3(sw), h: r3(sh) };
  return out;
}

/** Draft-mark stations (z) and the highest mark (m above keel): forward near the stem, amidships, aft near the stern. */
export function draftStations(dims) {
  const { L, T, deckY } = dims;
  const zF = typeof dims.zStemAt === 'function' ? dims.zStemAt(0) + Math.max(0.6, 0.015 * L) : -L / 2 + 0.08 * L;
  const zA = typeof dims.zAftAt === 'function' ? dims.zAftAt(0) - Math.max(0.6, 0.02 * L) : L / 2 - 0.06 * L;
  return { zF: r3(zF), zM: 0, zA: r3(zA), top: r3(Math.min(T + deckY * 0.6, T + 4)) };
}

/**
 * Draft mark at a height above the keel (JS twin of the shader): marks are 0.1 m numerals every 0.2 m — the even
 * decimetres show 2 4 6 8, each whole metre shows "<n>M". Returns the label printed in the 0.2 m slot that contains
 * `yk`, or '' between numerals.
 */
export function draftGlyphAt(yk) {
  if (!(yk >= 0)) return '';
  const slot = Math.floor(yk * 5 + 1e-6), fy = yk * 5 - slot;
  if (fy >= 0.5) return '';
  const metre = Math.floor(slot / 5), dec = slot % 5;
  return dec === 0 ? `${metre}M` : String(dec * 2);
}

/** Walkway paint for a deck colour: green on red-brown tanker / bulker decks, light grey-green elsewhere. */
export function walkwayFor(deckHex, gen) {
  const r = (deckHex >> 16) & 255, g = (deckHex >> 8) & 255;
  if (r > g + 25) return 0x3f6e4c;                // red / brown deck → green lanes
  if (gen === 'lng') return 0x8a9a8c;
  return 0x4f7a5a;
}

/** Deck lanes (walkways along the parallel midbody): { z0, z1, inset, width } (width 0 = none). */
export function deckLanes({ L, B, zMid0, zMid1, houseZ0 = null, houseZ1 = null, aftHouse = true }) {
  if (L < 60 || B < 10) return { z0: 0, z1: 0, inset: 0, width: 0 };
  let z0 = Math.min(zMid0, zMid1), z1 = Math.max(zMid0, zMid1);
  if (houseZ0 != null && aftHouse) z1 = Math.min(z1, houseZ0 - 1);
  if (houseZ1 != null && !aftHouse) z0 = Math.max(z0, houseZ1 + 1);
  if (z1 - z0 < 10) return { z0: 0, z1: 0, inset: 0, width: 0 };
  return { z0: r3(z0), z1: r3(z1), inset: r3(clamp(0.6, 1.2, B * 0.02)), width: r3(clamp(0.8, 1.4, B * 0.03)) };
}

/** Texture sizes per device: lettering canvas, facade atlas. */
export function texSizes(phone, own = false) {
  if (phone) return { letterW: 512, letterH: 128, facade: 512 };
  return { letterW: own ? 2048 : 1024, letterH: own ? 512 : 256, facade: 1024 };
}

/** Cache key of a lettering texture: same name, port, colour and size → the same canvas. */
export function letteringKey(name, port, colorHex, w, h) {
  const n = String(name || '').trim().toUpperCase(), p = String(port || '').trim().toUpperCase();
  return `${n}|${p}|${((colorHex >>> 0) & 0xffffff).toString(16).padStart(6, '0')}|${w}x${h}`;
}

/** Draft-mark / name colour that reads on a hull colour: white on dark paint, near-black on light paint. */
export function markColorFor(hullHex) {
  const r = (hullHex >> 16) & 255, g = (hullHex >> 8) & 255, b = hullHex & 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 150 ? 0x1b1b1b : 0xf4f4f0;
}

/** Normalised luminance check used by tests and the funnel mark fallback. */
export function isLight(hex) { return markColorFor(hex) === 0x1b1b1b; }

/**
 * A made-up operator look for AI traffic without a livery: a funnel band and one or two letters on the funnel, picked
 * from the seed (fictional, never a real company). Returns a livery patch { funnel, funnelBand, mark } (funnelBand is
 * painted on the funnel only, unlike livery.band which also runs along the hull).
 */
const TRAFFIC_FUNNELS = [[0x1d2a3a, 0xe8e8e2], [0x222222, 0xc8302a], [0xb5302a, 0xf2f2ee], [0x2d5d8a, 0xf2f2ee], [0xf2f2ee, 0x1f4f8f],
  [0x2a5a3a, 0xf2c230], [0x222222, 0xf2c230], [0xd9822b, 0x1b1b1b], [0x5a6470, 0xffffff], [0x1b3f6b, 0xd9b44a]];
const TRAFFIC_MARKS = ['A', 'N', 'K', 'S', 'M', 'T', 'H', 'V', 'B', 'O', 'NS', 'TK', 'AM', 'HL', 'SC'];
export function trafficLivery(seed) {
  const s = ((seed >>> 0) * 2246822519) >>> 0;
  const [funnel, funnelBand] = TRAFFIC_FUNNELS[s % TRAFFIC_FUNNELS.length];
  const mark = TRAFFIC_MARKS[(s >>> 8) % TRAFFIC_MARKS.length];
  return { funnel, funnelBand, mark };
}
