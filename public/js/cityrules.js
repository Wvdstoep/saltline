// City rules — pure helpers (no three.js, no DOM) shared by the building / vegetation mesh builder (citymesh.js, runs in
// the world-tile worker), the three.js side (cityscape.js) and the Node tests (test/cityrules.test.mjs).
//
//  * facade styles: what a wall looks like (window grid, floor height, lit-window share at night)
//  * building rules: a footprint + whatever is known (OSM tags, or the world tile's render height / estimate flag and
//    the land use under it) → style, wall (eave) height, roof shape and pitch, colours. Heights follow OSM: `height`,
//    else `building:levels` × 3.2 m (+ roof levels), else a default by building type; tile estimates (`e: 1`, the
//    OpenMapTiles 5 m default) are replaced by a type default varied per building (deterministic: the same footprint
//    always gives the same building on every client).
//  * LOD: what a world tile builds at each ring (near / mid / far) on desktop and phone.
// Everything here is plain data in / plain data out, so the inputs (packed footprints) can be cached on the device.

/** Facade style codes (vertex attribute `sty.x`; 0 = no facade: roofs, gables, plain surfaces). */
export const STYLE = { NONE: 0, HOUSE: 1, APARTMENT: 2, OFFICE: 3, INDUSTRIAL: 4, WAREHOUSE: 5, RETAIL: 6, CHURCH: 7, CIVIC: 8 };
/** Roof shape codes. */
export const ROOF = { FLAT: 0, GABLE: 1, HIP: 2, SKILLION: 3, PYRAMID: 4 };
export const LEVEL_M = 3.2;

/** Window grid per style: bay width (m), floor height (m), window box in the bay/floor cell (0..1), share lit at night,
 *  first floor offset (m). Mirrored by the facade shader in cityscape.js (keep the two in step). */
export const FACADE = {
  [STYLE.HOUSE]: { bay: 3.4, floor: 2.9, wx: [0.3, 0.7], wy: [0.32, 0.78], lit: 0.45, ground: 0.2 },
  [STYLE.APARTMENT]: { bay: 3.2, floor: 3.0, wx: [0.24, 0.76], wy: [0.3, 0.8], lit: 0.4, ground: 0.3 },
  [STYLE.OFFICE]: { bay: 1.6, floor: 3.6, wx: [0.06, 0.94], wy: [0.26, 0.95], lit: 0.3, ground: 0.0 },
  [STYLE.INDUSTRIAL]: { bay: 6.0, floor: 4.5, wx: [0.15, 0.85], wy: [0.55, 0.85], lit: 0.12, ground: 0.0 },
  [STYLE.WAREHOUSE]: { bay: 12.0, floor: 5.0, wx: [0.25, 0.75], wy: [0.0, 0.9], lit: 0.0, ground: 0.0 },
  [STYLE.RETAIL]: { bay: 4.0, floor: 4.0, wx: [0.08, 0.92], wy: [0.12, 0.85], lit: 0.5, ground: 0.0 },
  [STYLE.CHURCH]: { bay: 4.5, floor: 9.0, wx: [0.38, 0.62], wy: [0.2, 0.85], lit: 0.25, ground: 0.0 },
  [STYLE.CIVIC]: { bay: 3.6, floor: 4.0, wx: [0.22, 0.78], wy: [0.25, 0.85], lit: 0.3, ground: 0.0 },
};

/** Deterministic 0..1 hash of two numbers (footprint coordinates). */
export function hash01(a, b = 0) {
  let h = (Math.imul((a | 0) ^ 0x9e3779b9, 374761393) + Math.imul(b | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Parse an OSM length ("12", "12 m", "12.5m", "40'", "40 ft", "12,5") → metres, or NaN. */
export function parseLength(v) {
  if (v == null) return NaN;
  const s = String(v).trim().toLowerCase().replace(',', '.');
  const ft = /^(-?\d+(?:\.\d+)?)\s*(?:'|ft|feet)/.exec(s);
  if (ft) return Number(ft[1]) * 0.3048;
  const m = /^(-?\d+(?:\.\d+)?)/.exec(s);
  return m ? Number(m[1]) : NaN;
}

/** OSM `building=*` value → { style, h (default total height, m), roof (default shape) }. */
const TYPE_DEFAULTS = {
  house: [STYLE.HOUSE, 7, ROOF.GABLE], detached: [STYLE.HOUSE, 7, ROOF.GABLE], semidetached_house: [STYLE.HOUSE, 7.5, ROOF.GABLE],
  terrace: [STYLE.HOUSE, 9, ROOF.GABLE], bungalow: [STYLE.HOUSE, 4.5, ROOF.HIP], farm: [STYLE.HOUSE, 7, ROOF.GABLE], cabin: [STYLE.HOUSE, 4, ROOF.GABLE],
  hut: [STYLE.HOUSE, 3, ROOF.GABLE], static_caravan: [STYLE.HOUSE, 3, ROOF.FLAT],
  apartments: [STYLE.APARTMENT, 15, ROOF.FLAT], residential: [STYLE.APARTMENT, 12, ROOF.FLAT], dormitory: [STYLE.APARTMENT, 15, ROOF.FLAT], hotel: [STYLE.APARTMENT, 20, ROOF.FLAT],
  office: [STYLE.OFFICE, 18, ROOF.FLAT], commercial: [STYLE.RETAIL, 12, ROOF.FLAT], retail: [STYLE.RETAIL, 7, ROOF.FLAT], supermarket: [STYLE.RETAIL, 7, ROOF.FLAT],
  kiosk: [STYLE.RETAIL, 3, ROOF.FLAT],
  industrial: [STYLE.INDUSTRIAL, 9, ROOF.FLAT], factory: [STYLE.INDUSTRIAL, 12, ROOF.FLAT], manufacture: [STYLE.INDUSTRIAL, 12, ROOF.FLAT],
  warehouse: [STYLE.WAREHOUSE, 9, ROOF.FLAT], hangar: [STYLE.WAREHOUSE, 12, ROOF.FLAT], storage: [STYLE.WAREHOUSE, 8, ROOF.FLAT], shed: [STYLE.WAREHOUSE, 3.5, ROOF.SKILLION],
  barn: [STYLE.WAREHOUSE, 8, ROOF.GABLE], farm_auxiliary: [STYLE.WAREHOUSE, 6, ROOF.GABLE], greenhouse: [STYLE.WAREHOUSE, 4, ROOF.GABLE],
  garage: [STYLE.WAREHOUSE, 3, ROOF.FLAT], garages: [STYLE.WAREHOUSE, 3, ROOF.FLAT], carport: [STYLE.WAREHOUSE, 2.6, ROOF.FLAT], roof: [STYLE.WAREHOUSE, 5, ROOF.FLAT],
  service: [STYLE.INDUSTRIAL, 4, ROOF.FLAT], transformer_tower: [STYLE.INDUSTRIAL, 8, ROOF.FLAT],
  church: [STYLE.CHURCH, 20, ROOF.GABLE], cathedral: [STYLE.CHURCH, 30, ROOF.GABLE], chapel: [STYLE.CHURCH, 9, ROOF.GABLE], mosque: [STYLE.CHURCH, 15, ROOF.FLAT],
  temple: [STYLE.CHURCH, 12, ROOF.HIP], synagogue: [STYLE.CHURCH, 14, ROOF.FLAT],
  school: [STYLE.CIVIC, 10, ROOF.FLAT], university: [STYLE.CIVIC, 15, ROOF.FLAT], college: [STYLE.CIVIC, 12, ROOF.FLAT], hospital: [STYLE.CIVIC, 18, ROOF.FLAT],
  public: [STYLE.CIVIC, 12, ROOF.FLAT], civic: [STYLE.CIVIC, 12, ROOF.FLAT], government: [STYLE.CIVIC, 15, ROOF.FLAT], train_station: [STYLE.CIVIC, 12, ROOF.FLAT],
  transportation: [STYLE.CIVIC, 10, ROOF.FLAT], stadium: [STYLE.CIVIC, 20, ROOF.FLAT], sports_hall: [STYLE.CIVIC, 10, ROOF.FLAT],
  silo: [STYLE.INDUSTRIAL, 25, ROOF.FLAT], storage_tank: [STYLE.NONE, 15, ROOF.FLAT], ruins: [STYLE.NONE, 4, ROOF.FLAT],
};
const ROOF_TAG = { flat: ROOF.FLAT, gabled: ROOF.GABLE, gable: ROOF.GABLE, saltbox: ROOF.GABLE, gambrel: ROOF.GABLE, mansard: ROOF.HIP, hipped: ROOF.HIP, half_hipped: ROOF.HIP, 'side_hipped': ROOF.HIP, skillion: ROOF.SKILLION, lean_to: ROOF.SKILLION, pyramidal: ROOF.PYRAMID, dome: ROOF.PYRAMID, onion: ROOF.PYRAMID, round: ROOF.GABLE, sawtooth: ROOF.SKILLION };

/**
 * Building from OSM tags (harbour patches, overlay data, a device cache of raw OSM): { style, height, minHeight, eave,
 * roof, roofH, levels, tagged }. `area` (m²) refines untyped buildings (`building=yes`).
 */
export function buildingFromTags(tags = {}, area = 100, seed = 0) {
  const type = String(tags.building ?? tags['building:part'] ?? 'yes').toLowerCase();
  let [style, defH, roof] = TYPE_DEFAULTS[type] || untypedDefaults(area, seed);
  const levels = parseLength(tags['building:levels']), roofLevels = parseLength(tags['roof:levels']);
  const hTag = parseLength(tags.height), minH = Math.max(0, parseLength(tags.min_height) || (parseLength(tags['building:min_level']) * LEVEL_M) || 0);
  const roofTag = String(tags['roof:shape'] || '').toLowerCase();
  if (ROOF_TAG[roofTag] !== undefined) roof = ROOF_TAG[roofTag];
  let height, tagged = true;
  if (Number.isFinite(hTag) && hTag > 0) height = hTag;
  else if (Number.isFinite(levels) && levels > 0) height = levels * LEVEL_M + (Number.isFinite(roofLevels) && roofLevels > 0 ? roofLevels * LEVEL_M : roof !== ROOF.FLAT ? 2.5 : 0) + (style === STYLE.RETAIL || style === STYLE.CIVIC ? 1 : 0);
  else { height = defH * (0.9 + 0.2 * hash01(seed, 7)); tagged = false; }
  height = clampN(height, 2, 600);
  // a residential building that is clearly tall is an apartment block, whatever the default said
  if (style === STYLE.HOUSE && height > 14) style = STYLE.APARTMENT;
  const roofHTag = parseLength(tags['roof:height']);
  return finishShape({ style, height, minHeight: Math.min(minH, height - 1), roof, roofHTag, tagged, area, levels: Number.isFinite(levels) ? levels : null });
}
function untypedDefaults(area, seed) {
  if (area < 40) return [STYLE.WAREHOUSE, 3, ROOF.FLAT];                  // garden shed / garage
  if (area < 220) return [STYLE.HOUSE, 7, hash01(seed, 3) < 0.7 ? ROOF.GABLE : ROOF.HIP];
  if (area < 900) return [STYLE.APARTMENT, 12, ROOF.FLAT];
  return [STYLE.APARTMENT, 15, ROOF.FLAT];
}

/**
 * Building from a world-tile vector ({h, mh, k, e} — OpenMapTiles render height, land use kind, estimate flag) and its
 * footprint area (m²). Tagged heights are kept; estimates get a type default varied per building.
 */
export function buildingFromTile(b, area, seed = 0, lat = 50) {
  const k = String(b?.k || 'other'), est = !!b?.e;
  const h0 = Number(b?.h) || 8, mh = Math.max(0, Number(b?.mh) || 0);
  const r = hash01(seed, 11), r2 = hash01(seed, 23);
  let style, height;
  if (k === 'shed' || k === 'industrial') {
    style = area > 1500 || k === 'shed' ? STYLE.WAREHOUSE : STYLE.INDUSTRIAL;
    height = est ? clampN(6 + Math.sqrt(area) / 7 + r * 3, 6, 24) : h0;
  } else if (k === 'residential' || k === 'other') {
    const tall = !est && h0 > 14;
    if (!tall && area < (k === 'other' ? 200 : 230) && (est || h0 <= 12)) {
      style = area < 35 ? STYLE.WAREHOUSE : STYLE.HOUSE;
      height = est ? (area < 35 ? 2.8 + r : 6.2 + r * 2.2) : h0;
    } else {
      style = STYLE.APARTMENT;
      // floors by footprint: low-rise rows, mid-rise blocks, a few taller slabs (southern cities run a floor higher)
      const south = Math.abs(lat) < 45 ? 1 : 0;
      const floors = area < 500 ? 3 + Math.floor(r * 2) + south : area < 1500 ? 4 + Math.floor(r * 3) + south : 5 + Math.floor(r * 4) + (r2 < 0.12 ? 6 : 0);
      height = est ? floors * 3.0 + 0.8 : h0;
    }
  } else if (k === 'commercial') {
    if (!est && h0 >= 24) style = STYLE.OFFICE;
    else if (area > 2500) style = STYLE.RETAIL;
    else style = r < 0.45 ? STYLE.OFFICE : STYLE.APARTMENT;
    height = est ? (style === STYLE.RETAIL ? 7 + r * 5 : style === STYLE.OFFICE ? 12 + Math.floor(r2 * 5) * 3.6 : 10 + r * 9) : h0;
  } else {
    style = STYLE.APARTMENT; height = est ? 9 : h0;
  }
  if (!est && height >= 40 && style !== STYLE.WAREHOUSE) style = STYLE.OFFICE;
  height = clampN(height, 2.5, 600);
  let roof = ROOF.FLAT;
  if (style === STYLE.HOUSE) roof = r2 < 0.68 ? ROOF.GABLE : ROOF.HIP;
  else if (style === STYLE.WAREHOUSE && area < 35) roof = ROOF.SKILLION;
  else if (style === STYLE.APARTMENT && area < 600 && height < 16 && Math.abs(lat) > 40 && r2 < 0.5) roof = ROOF.GABLE;   // northern rows: pitched roofs
  return finishShape({ style, height, minHeight: Math.min(mh, height - 1), roof, roofHTag: NaN, tagged: !est, area, levels: null });
}

/** Wall (eave) height + roof rise: pitched roofs take part of the total height (the tag is the ridge height). */
function finishShape(o) {
  let roofH = 0;
  if (o.roof !== ROOF.FLAT) {
    const span = Math.sqrt(Math.max(1, o.area));        // ≈ the short side of a compact footprint
    roofH = Number.isFinite(o.roofHTag) && o.roofHTag > 0 ? o.roofHTag : clampN(span * (o.roof === ROOF.SKILLION ? 0.12 : 0.32), 0.8, o.style === STYLE.CHURCH ? 12 : 5);
    roofH = Math.min(roofH, Math.max(0.8, (o.height - o.minHeight) * 0.45));
  }
  const eave = Math.max(o.minHeight + 1.5, o.height - roofH);
  return { style: o.style, height: o.height, minHeight: Math.max(0, o.minHeight), eave, roof: o.roof, roofH: o.height - eave, tagged: o.tagged, levels: o.levels };
}
function clampN(v, a, b) { return v < a ? a : v > b ? b : v; }

// ------------------------------------------------------------------------------------------------ colours
/** Wall palettes per style (sRGB 0..1): north (brick, render) and south (pale render, stone). */
const WALLS = {
  north: {
    [STYLE.HOUSE]: [[0.55, 0.30, 0.22], [0.62, 0.38, 0.28], [0.80, 0.77, 0.70], [0.48, 0.28, 0.22], [0.86, 0.84, 0.78]],
    [STYLE.APARTMENT]: [[0.58, 0.36, 0.27], [0.72, 0.68, 0.60], [0.66, 0.60, 0.52], [0.50, 0.32, 0.26], [0.78, 0.76, 0.70]],
    [STYLE.OFFICE]: [[0.52, 0.58, 0.64], [0.62, 0.64, 0.66], [0.42, 0.48, 0.54], [0.70, 0.70, 0.68]],
    [STYLE.INDUSTRIAL]: [[0.60, 0.62, 0.62], [0.55, 0.50, 0.44], [0.66, 0.66, 0.62]],
    [STYLE.WAREHOUSE]: [[0.66, 0.70, 0.72], [0.56, 0.62, 0.68], [0.70, 0.68, 0.62], [0.46, 0.56, 0.62], [0.72, 0.72, 0.70]],
    [STYLE.RETAIL]: [[0.72, 0.70, 0.66], [0.62, 0.60, 0.58], [0.80, 0.78, 0.72]],
    [STYLE.CHURCH]: [[0.62, 0.58, 0.50], [0.52, 0.36, 0.28], [0.70, 0.67, 0.60]],
    [STYLE.CIVIC]: [[0.70, 0.66, 0.58], [0.60, 0.42, 0.32], [0.74, 0.72, 0.68]],
  },
  south: {
    [STYLE.HOUSE]: [[0.90, 0.86, 0.76], [0.86, 0.76, 0.60], [0.93, 0.92, 0.88], [0.82, 0.66, 0.50], [0.88, 0.80, 0.66]],
    [STYLE.APARTMENT]: [[0.86, 0.80, 0.70], [0.80, 0.72, 0.60], [0.90, 0.88, 0.82], [0.76, 0.62, 0.50], [0.84, 0.82, 0.76]],
    [STYLE.OFFICE]: [[0.56, 0.62, 0.68], [0.70, 0.72, 0.72], [0.46, 0.54, 0.60], [0.80, 0.78, 0.74]],
    [STYLE.INDUSTRIAL]: [[0.74, 0.72, 0.68], [0.66, 0.62, 0.56], [0.80, 0.78, 0.74]],
    [STYLE.WAREHOUSE]: [[0.80, 0.80, 0.78], [0.64, 0.70, 0.74], [0.82, 0.78, 0.70], [0.60, 0.66, 0.70]],
    [STYLE.RETAIL]: [[0.86, 0.84, 0.78], [0.76, 0.72, 0.66]],
    [STYLE.CHURCH]: [[0.88, 0.84, 0.74], [0.80, 0.72, 0.58]],
    [STYLE.CIVIC]: [[0.86, 0.82, 0.72], [0.80, 0.74, 0.62]],
  },
};
const ROOFS = {
  north: { pitched: [[0.50, 0.24, 0.18], [0.30, 0.30, 0.32], [0.42, 0.22, 0.18], [0.24, 0.25, 0.27], [0.56, 0.32, 0.22]], flat: [[0.36, 0.36, 0.36], [0.44, 0.43, 0.41], [0.30, 0.31, 0.33], [0.52, 0.52, 0.50]], metal: [[0.62, 0.66, 0.68], [0.52, 0.58, 0.62], [0.70, 0.70, 0.68], [0.44, 0.52, 0.46]] },
  south: { pitched: [[0.70, 0.36, 0.24], [0.64, 0.32, 0.22], [0.74, 0.44, 0.30], [0.58, 0.30, 0.22]], flat: [[0.74, 0.72, 0.68], [0.62, 0.60, 0.56], [0.82, 0.80, 0.76], [0.54, 0.52, 0.50]], metal: [[0.72, 0.74, 0.74], [0.62, 0.66, 0.70], [0.80, 0.78, 0.74]] },
};
/** { wall: [r,g,b], roof: [r,g,b] } for a building (deterministic per seed; `lat` picks the regional palette). */
export function buildingColours(style, roof, seed, lat = 50) {
  const zone = Math.abs(lat) < 44 ? 'south' : 'north';
  const W = WALLS[zone][style] || WALLS[zone][STYLE.APARTMENT];
  const r = hash01(seed, 31), r2 = hash01(seed, 37), k = 0.9 + 0.2 * hash01(seed, 41);
  const wall = W[Math.floor(r * W.length) % W.length].map((c) => Math.min(1, c * k));
  const R = ROOFS[zone];
  const set = roof !== ROOF.FLAT && style !== STYLE.WAREHOUSE ? R.pitched : style === STYLE.WAREHOUSE || style === STYLE.INDUSTRIAL ? R.metal : R.flat;
  const rf = set[Math.floor(r2 * set.length) % set.length].map((c) => c * (0.92 + 0.16 * hash01(seed, 43)));
  return { wall, roof: rf };
}

// ------------------------------------------------------------------------------------------------ LOD
/**
 * What a world tile builds at a ring. want: 'near' | 'mid' | 'far'; mobile: phone budgets (half density).
 * Returns { facades (window shader on walls), roofs (pitched roof geometry), minH (m, smaller buildings dropped),
 * maxBuildings, maxVerts, trees (cap, 0 = none), containers (stack cap) }.
 */
export function cityLod(want, mobile = false) {
  const D = {
    near: { facades: true, roofs: true, minH: 0, maxBuildings: 6000, maxVerts: 260000, trees: 6000, containers: 3500 },
    mid: { facades: true, roofs: true, minH: 0, maxBuildings: 5000, maxVerts: 200000, trees: 1500, containers: 2500 },
    far: { facades: true, roofs: false, minH: 6, maxBuildings: 2500, maxVerts: 90000, trees: 0, containers: 0 },
  };
  const P = {
    near: { facades: true, roofs: true, minH: 0, maxBuildings: 2500, maxVerts: 100000, trees: 2000, containers: 1200 },
    mid: { facades: true, roofs: false, minH: 5, maxBuildings: 1500, maxVerts: 60000, trees: 400, containers: 400 },
    far: { facades: true, roofs: false, minH: 9, maxBuildings: 700, maxVerts: 30000, trees: 0, containers: 0 },
  };
  const t = (mobile ? P : D)[want] || (mobile ? P : D).far;
  return { ...t };
}

/** Trees per 100 m² of a land class (world-tile area kinds); 0 = none. */
export const TREE_DENSITY = { wood: 1.1, grass: 0.12, residential: 0.1, commercial: 0.03, parking: 0.02, industrial: 0.01, port: 0, sand: 0, plain: 0.02 };
/** Tree kind for a spot: 0 broadleaf, 1 conifer, 2 palm (by latitude, land class and a 0..1 random). */
export function treeKind(lat, cls, r) {
  const a = Math.abs(lat);
  if (a < 30 && cls !== 'wood' && r < 0.55) return 2;
  const conifer = a > 55 ? 0.65 : a > 45 ? 0.35 : a > 35 ? 0.3 : 0.1;
  return r < conifer * (cls === 'wood' ? 1 : 0.5) ? 1 : 0;
}

/**
 * Is a satellite pixel (sRGB 0..255) a tree canopy? Dark, green-dominant and not grey: grass is lighter, water bluer,
 * roofs and roads grey. Returns 0..1 (confidence).
 */
export function canopyScore(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx < 18) return 0;                                   // black (no data / deep shadow)
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  if (lum > 120) return 0;                                 // bright: grass, sand, concrete
  if (g < r * 1.02 || g < b * 1.05) return 0;              // not green-dominant (water is blue, roofs grey/red)
  const sat = (mx - mn) / mx;
  if (sat < 0.12) return 0;
  return Math.min(1, ((120 - lum) / 70) * Math.min(1, (sat - 0.12) / 0.2));
}
