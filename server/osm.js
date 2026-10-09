// OpenStreetMap harbour data (docs/V3-CONTRACTS.md §1): one Overpass request per harbour, a 30-day disk cache under
// data/osm/<id>.json, the coastline → land polygon closing algorithm, tag classification of the structures
// (quays, piers, breakwaters, pontoons, buildings, tanks, cranes, lights, IALA buoys) and the polygon utilities the
// rasteriser in ./harborgeom.js is built on. Nothing in this module throws on bad data or a dead network: fetches
// resolve to null, parsers skip what they cannot read.
//
// Frames: every lat/lon pair is [lat, lon]. "Map frame" means x = lon (east), y = lat (north) — orientation tests
// (counter-clockwise = positive area) are done in that frame, scaled by cos(lat) so areas come out in m².
import fs from 'node:fs';
import path from 'node:path';
import { GEO } from '../shared/constants.js';
import { DATA_DIR } from './paths.js';

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
export const USER_AGENT = 'Saltline/0.4 (harbour geometry; one request at a time)';
export const OSM_TTL_MS = 30 * 24 * 3600e3;          // re-fetch after 30 days
export const OSM_EMPTY_TTL_MS = 24 * 3600e3;         // an empty answer is retried after a day
export const DEFAULT_RADIUS_M = 3200;                // covers the 4.48 km patch square (half diagonal 3168 m)
export const DEFAULT_TIMEOUT_MS = 45_000;
export const BUILDING_CAP = 300;
// v0.4 (docs/V4-CONTRACTS.md §3): the street layer. Bump OSM_SCHEMA whenever the Overpass query gains data, so caches
// fetched by an older query are refreshed (they are still used as a fallback while Overpass is unreachable).
export const OSM_SCHEMA = 2;
export const ROAD_CAP = 1500;                        // highway ways kept per harbour (major classes first, then nearest)
export const SHOP_CAP = 300;                         // shop nodes kept per harbour (nearest first)
export const AREA_CAP = 400;                         // land use / park / wood / beach / parking areas kept (largest first)
export const PLACE_CAP = 120;                        // named shops / tourism / other amenities kept as street signs
export const ROAD_KINDS = ['motorway', 'primary', 'secondary', 'tertiary', 'residential', 'service', 'footway', 'track'];
export const AREA_KINDS = ['grass', 'park', 'wood', 'sand', 'industrial', 'residential', 'port', 'parking'];
export const POI_KINDS = ['harbourmaster', 'shipyard', 'chandler', 'fuel', 'market', 'bar', 'police', 'cafe'];
/** Default carriageway widths (m) by road kind when the way has no usable width / lanes tag. */
export const ROAD_WIDTH = { motorway: 20, primary: 12, secondary: 10, tertiary: 8, residential: 6.5, service: 4.5, footway: 2.5, track: 3 };

const D2R = Math.PI / 180;
let osmDir = path.join(DATA_DIR, 'osm');

/** Test hook: redirect the cache directory / endpoints. */
export function configureOSM({ dataDir, endpoints } = {}) {
  if (dataDir) osmDir = path.join(dataDir, 'osm');
  if (Array.isArray(endpoints) && endpoints.length) { OVERPASS_ENDPOINTS.length = 0; OVERPASS_ENDPOINTS.push(...endpoints); }
}
export function osmCachePath(id) { return path.join(osmDir, `${id}.json`); }

// ---------------------------------------------------------------------------------------------------------------
// Small geometry helpers (exported for the rasteriser and the tests)
// ---------------------------------------------------------------------------------------------------------------

export function round6(v) { return Math.round(v * 1e6) / 1e6; }
function round1(v) { return Math.round(v * 10) / 10; }

/** Local equirectangular frame about an origin: x east, z south, metres (same formulas as shared/constants PATCH). */
export function localFrame(originLat, originLon) {
  const kLon = GEO.M_PER_DEG_LON_EQ * Math.cos(originLat * D2R) || 1e-6;
  return {
    kLon,
    toXZ: (lat, lon) => [(lon - originLon) * kLon, -(lat - originLat) * GEO.M_PER_DEG_LAT],
    toLL: (x, z) => [originLat - z / GEO.M_PER_DEG_LAT, originLon + x / kLon],
  };
}

/** Axis-aligned lat/lon box of half size `halfM` metres about a point. */
export function bboxAround(lat, lon, halfM) {
  const dLat = halfM / GEO.M_PER_DEG_LAT, dLon = halfM / (GEO.M_PER_DEG_LON_EQ * Math.cos(lat * D2R) || 1e-6);
  return { latMin: lat - dLat, latMax: lat + dLat, lonMin: lon - dLon, lonMax: lon + dLon };
}

/** Signed area in m² of a [[lat,lon],...] ring (positive = counter-clockwise in the map frame = land on the left). */
export function ringSignedAreaM2(pts) {
  if (!Array.isArray(pts) || pts.length < 3) return 0;
  const lat0 = pts[0][0], lon0 = pts[0][1];
  const k = Math.cos(lat0 * D2R) * GEO.M_PER_DEG_LON_EQ;
  let sum = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const x1 = (a[1] - lon0) * k, y1 = (a[0] - lat0) * GEO.M_PER_DEG_LAT;
    const x2 = (b[1] - lon0) * k, y2 = (b[0] - lat0) * GEO.M_PER_DEG_LAT;
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}
export function ringAreaM2(pts) { return Math.abs(ringSignedAreaM2(pts)); }
export function ringIsCCW(pts) { return ringSignedAreaM2(pts) > 0; }

/** Even-odd point-in-ring test for [lat,lon] points and a [[lat,lon],...] ring (no repeated last point needed). */
export function pointInRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
    const yi = ring[i][0], xi = ring[i][1], yj = ring[j][0], xj = ring[j][1];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** Even-odd across several rings (islands inside lagoons inside land work out naturally). */
export function pointInRings(lat, lon, rings) {
  let c = 0;
  for (const r of rings) if (pointInRing(lat, lon, r)) c++;
  return (c & 1) === 1;
}

/** Centroid (mean of vertices) of a ring / polyline. */
export function centroid(pts) {
  let la = 0, lo = 0;
  for (const p of pts) { la += p[0]; lo += p[1]; }
  return pts.length ? [la / pts.length, lo / pts.length] : [0, 0];
}

/** Drop vertices closer than `minSpacingM` to the previously kept one (the ring/polyline keeps its first point). */
export function simplifyRing(pts, minSpacingM = 3, closed = true) {
  if (!Array.isArray(pts) || pts.length < 3) return Array.isArray(pts) ? pts.slice() : [];
  const k = Math.cos(pts[0][0] * D2R) * GEO.M_PER_DEG_LON_EQ;
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = out[out.length - 1], b = pts[i];
    const dx = (b[1] - a[1]) * k, dy = (b[0] - a[0]) * GEO.M_PER_DEG_LAT;
    if (dx * dx + dy * dy >= minSpacingM * minSpacingM) out.push(b);
  }
  if (closed && out.length > 2) {
    const a = out[out.length - 1], b = out[0];
    const dx = (b[1] - a[1]) * k, dy = (b[0] - a[0]) * GEO.M_PER_DEG_LAT;
    if (dx * dx + dy * dy < minSpacingM * minSpacingM) out.pop();
  }
  return out.length >= (closed ? 3 : 2) ? out : pts.slice(0, closed ? 3 : 2);
}

/** Length of a [[lat,lon],...] polyline in metres. */
export function polylineLengthM(pts) {
  if (!Array.isArray(pts) || pts.length < 2) return 0;
  const k = Math.cos(pts[0][0] * D2R) * GEO.M_PER_DEG_LON_EQ;
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot((pts[i][1] - pts[i - 1][1]) * k, (pts[i][0] - pts[i - 1][0]) * GEO.M_PER_DEG_LAT);
  return s;
}

const inBox = (p, b) => p[0] >= b.latMin && p[0] <= b.latMax && p[1] >= b.lonMin && p[1] <= b.lonMax;

/**
 * Liang–Barsky: the parameter interval [t0, t1] of segment a→b inside the box, or null. Works in degrees.
 */
function clipSegment(a, b, box) {
  let t0 = 0, t1 = 1;
  const dy = b[0] - a[0], dx = b[1] - a[1];
  const checks = [[-dx, a[1] - box.lonMin], [dx, box.lonMax - a[1]], [-dy, a[0] - box.latMin], [dy, box.latMax - a[0]]];
  for (const [p, q] of checks) {
    if (p === 0) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return t0 <= t1 ? [t0, t1] : null;
}
const lerpPt = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/**
 * Clip an open polyline to a lat/lon box. Returns pieces `{pts, startOnBorder, endOnBorder}`; a piece that starts
 * or ends strictly inside the box (a data gap) is reported with the flag false.
 */
export function clipPolylineToBbox(pts, box) {
  const pieces = [];
  if (!Array.isArray(pts) || pts.length < 2) return pieces;
  let cur = null;
  const closeCur = (endOnBorder) => { if (cur && cur.pts.length >= 2) { cur.endOnBorder = endOnBorder; pieces.push(cur); } cur = null; };
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const aIn = inBox(a, box), bIn = inBox(b, box);
    if (aIn && bIn) {
      if (!cur) cur = { pts: [a], startOnBorder: i > 0 ? true : onBorder(a, box) };
      cur.pts.push(b);
      continue;
    }
    const t = clipSegment(a, b, box);
    if (!t) { continue; }
    if (aIn && !bIn) { if (!cur) cur = { pts: [a], startOnBorder: i > 0 ? true : onBorder(a, box) }; cur.pts.push(lerpPt(a, b, t[1])); closeCur(true); continue; }
    if (!aIn && bIn) { closeCur(true); cur = { pts: [lerpPt(a, b, t[0]), b], startOnBorder: true }; continue; }
    // both outside, crossing through
    closeCur(true);
    const p0 = lerpPt(a, b, t[0]), p1 = lerpPt(a, b, t[1]);
    if (p0[0] !== p1[0] || p0[1] !== p1[1]) pieces.push({ pts: [p0, p1], startOnBorder: true, endOnBorder: true });
  }
  closeCur(cur ? onBorder(cur.pts[cur.pts.length - 1], box) : false);
  return pieces;
}

function onBorder(p, b) {
  const eps = 1e-9;
  return Math.abs(p[0] - b.latMin) < eps || Math.abs(p[0] - b.latMax) < eps || Math.abs(p[1] - b.lonMin) < eps || Math.abs(p[1] - b.lonMax) < eps;
}

// ---------------------------------------------------------------------------------------------------------------
// Coastline closing — land is on the LEFT of a natural=coastline way
// ---------------------------------------------------------------------------------------------------------------

const keyOf = (p) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;

/** Join ways end-to-end (A ends where B starts) into chains; closed chains get `closed: true`. */
export function joinWays(ways) {
  const list = ways.filter((w) => Array.isArray(w) && w.length >= 2).map((w) => w.slice());
  const byStart = new Map();
  for (const w of list) { const k = keyOf(w[0]); if (!byStart.has(k)) byStart.set(k, []); byStart.get(k).push(w); }
  const used = new Set();
  const chains = [];
  // Start chains at ways whose start is not the end of another way, so a chain is walked from its true beginning.
  const endKeys = new Set(list.map((w) => keyOf(w[w.length - 1])));
  const starters = list.filter((w) => !endKeys.has(keyOf(w[0]))).concat(list);
  for (const start of starters) {
    if (used.has(start)) continue;
    used.add(start);
    const chain = start.slice();
    let guard = 0;
    while (guard++ < list.length + 1) {
      const k = keyOf(chain[chain.length - 1]);
      if (k === keyOf(chain[0]) && chain.length > 2) { chain.pop(); chains.push(Object.assign(chain, { closed: true })); chain.closed = true; break; }
      const nexts = (byStart.get(k) || []).filter((w) => !used.has(w));
      if (!nexts.length) { chains.push(Object.assign(chain, { closed: false })); break; }
      const w = nexts[0]; used.add(w);
      for (let i = 1; i < w.length; i++) chain.push(w[i]);
    }
  }
  return chains;
}

// Border parameter t ∈ [0, P): counter-clockwise from the SW corner (interior on the left): south edge eastward,
// east edge northward, north edge westward, west edge southward.
function borderParam(p, b) {
  const W = b.lonMax - b.lonMin, H = b.latMax - b.latMin;
  const dS = Math.abs(p[0] - b.latMin), dE = Math.abs(p[1] - b.lonMax), dN = Math.abs(p[0] - b.latMax), dW = Math.abs(p[1] - b.lonMin);
  const m = Math.min(dS, dE, dN, dW);
  if (m === dS) return clampT(p[1] - b.lonMin, W, H);
  if (m === dE) return clampT(W + (p[0] - b.latMin), W, H);
  if (m === dN) return clampT(W + H + (b.lonMax - p[1]), W, H);
  return clampT(2 * W + H + (b.latMax - p[0]), W, H);
}
function clampT(t, W, H) { const P = 2 * (W + H); return ((t % P) + P) % P; }
function cornersBetween(tA, tB, b) {
  const W = b.lonMax - b.lonMin, H = b.latMax - b.latMin;
  const corners = [[0, [b.latMin, b.lonMin]], [W, [b.latMin, b.lonMax]], [W + H, [b.latMax, b.lonMax]], [2 * W + H, [b.latMax, b.lonMin]]];
  const out = [];
  const between = (t) => (tA < tB ? t > tA && t < tB : t > tA || t < tB);
  // walk forward from tA: corners sorted by (t - tA) mod P
  const P = 2 * (W + H);
  corners.sort((u, v) => (((u[0] - tA) % P) + P) % P - (((v[0] - tA) % P) + P) % P);
  for (const [t, pt] of corners) if (between(t)) out.push(pt);
  return out;
}

/** Extend an endpoint that lies strictly inside the box to the border along the last segment direction. */
function extendToBorder(from, to, box) {
  // ray from `from` through `to`, beyond `to`
  const dy = to[0] - from[0], dx = to[1] - from[1];
  if (dx === 0 && dy === 0) return nearestBorderPoint(to, box);
  let tBest = Infinity;
  const cand = [];
  if (dx > 0) cand.push((box.lonMax - to[1]) / dx); else if (dx < 0) cand.push((box.lonMin - to[1]) / dx);
  if (dy > 0) cand.push((box.latMax - to[0]) / dy); else if (dy < 0) cand.push((box.latMin - to[0]) / dy);
  for (const t of cand) if (t >= 0 && t < tBest) tBest = t;
  if (!Number.isFinite(tBest)) return nearestBorderPoint(to, box);
  return [to[0] + dy * tBest, to[1] + dx * tBest];
}
function nearestBorderPoint(p, b) {
  const c = [[Math.abs(p[0] - b.latMin), [b.latMin, p[1]]], [Math.abs(p[0] - b.latMax), [b.latMax, p[1]]],
    [Math.abs(p[1] - b.lonMin), [p[0], b.lonMin]], [Math.abs(p[1] - b.lonMax), [p[0], b.lonMax]]];
  c.sort((u, v) => u[0] - v[0]);
  return c[0][1];
}

/**
 * Close OSM coastline ways against a bbox and return land polygons as [[lat,lon],...] rings (fill them even-odd:
 * islands are counter-clockwise rings, lagoons clockwise rings, and both may nest).
 *   ways: [[[lat,lon],…], …] in way direction (land on the left)
 *   bbox: {latMin, latMax, lonMin, lonMax}
 *   opts.defaultLand: what the bbox is when no coastline crosses it and no ring tells us (default false = water)
 */
export function landPolygonsFromCoastline(ways, bbox, opts = {}) {
  const box = bbox;
  if (!box || !(box.latMax > box.latMin) || !(box.lonMax > box.lonMin)) return [];
  const chains = joinWays(Array.isArray(ways) ? ways : []);
  const pieces = [];
  const rings = [];
  for (const chain of chains) {
    if (chain.closed) {
      const allIn = chain.every((p) => inBox(p, box));
      if (allIn) { if (chain.length >= 3) rings.push(chain.slice()); continue; }
      // rotate so the chain starts at a vertex outside the box, then clip as an open polyline
      let k = chain.findIndex((p) => !inBox(p, box));
      if (k < 0) k = 0;
      const rotated = chain.slice(k).concat(chain.slice(0, k + 1));
      for (const pc of clipPolylineToBbox(rotated, box)) pieces.push(pc);
    } else {
      for (const pc of clipPolylineToBbox(chain, box)) pieces.push(pc);
    }
  }
  // repair pieces whose ends are inside the box (missing ways): extend them to the border
  for (const pc of pieces) {
    if (!pc.startOnBorder && pc.pts.length >= 2) pc.pts.unshift(extendToBorder(pc.pts[1], pc.pts[0], box));
    if (!pc.endOnBorder && pc.pts.length >= 2) pc.pts.push(extendToBorder(pc.pts[pc.pts.length - 2], pc.pts[pc.pts.length - 1], box));
    pc.tStart = borderParam(pc.pts[0], box);
    pc.tEnd = borderParam(pc.pts[pc.pts.length - 1], box);
  }
  const out = [];
  if (pieces.length) {
    const sorted = pieces.slice().sort((a, b) => a.tStart - b.tStart);
    const visited = new Set();
    for (const first of sorted) {
      if (visited.has(first)) continue;
      const poly = [];
      let cur = first, guard = 0;
      while (guard++ <= sorted.length) {
        visited.add(cur);
        for (const p of cur.pts) poly.push(p);
        // next piece: the first start strictly after cur.tEnd, cyclically
        let next = null;
        for (const q of sorted) if (q.tStart > cur.tEnd + 1e-12) { next = q; break; }
        if (!next) next = sorted[0];
        for (const c of cornersBetween(cur.tEnd, next.tStart, box)) poly.push(c);
        if (next === first || visited.has(next)) break;
        cur = next;
      }
      if (poly.length >= 3) out.push(dedupeRing(poly));
    }
  } else {
    // no coastline crosses the bbox: closed rings tell us the background (a lagoon implies land around it)
    let background = typeof opts.defaultLand === 'boolean' ? opts.defaultLand : false;
    if (rings.some((r) => !ringIsCCW(r))) background = true;
    else if (rings.length && rings.every((r) => ringIsCCW(r)) && typeof opts.defaultLand !== 'boolean') background = false;
    if (background) out.push([[box.latMin, box.lonMin], [box.latMin, box.lonMax], [box.latMax, box.lonMax], [box.latMax, box.lonMin]]);
  }
  for (const r of rings) out.push(dedupeRing(r));
  return out.filter((r) => r.length >= 3);
}

function dedupeRing(pts) {
  const out = [];
  for (const p of pts) { const l = out[out.length - 1]; if (!l || Math.abs(l[0] - p[0]) > 1e-10 || Math.abs(l[1] - p[1]) > 1e-10) out.push([p[0], p[1]]); }
  if (out.length > 1 && Math.abs(out[0][0] - out[out.length - 1][0]) < 1e-10 && Math.abs(out[0][1] - out[out.length - 1][1]) < 1e-10) out.pop();
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Tag parsing
// ---------------------------------------------------------------------------------------------------------------

/** "12", "12.5 m", "12,5", "40 ft", "30'", "30'6\"" → metres (1 decimal); null when absent / unusable. */
export function parseLength(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase().replace(',', '.');
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(m|metres?|meters?|ft|feet|')?\s*(?:(\d+(?:\.\d+)?)\s*(?:in|inch|inches|"))?\s*$/);
  if (!m) return null;
  let v = parseFloat(m[1]);
  if (m[2] === 'ft' || m[2] === 'feet' || m[2] === "'") v = (v + (m[3] ? parseFloat(m[3]) / 12 : 0)) * 0.3048;
  else if (m[3]) return null;
  return Number.isFinite(v) && v > 0 ? round1(v) : null;
}
/** height tag, else building:levels × 3.2, else 8 m. */
export function parseHeight(tags = {}, fallback = 8) {
  const h = parseLength(tags.height);
  if (h) return h;
  const levels = parseFloat(String(tags['building:levels'] ?? '').replace(',', '.'));
  if (Number.isFinite(levels) && levels > 0) return round1(levels * 3.2);
  return fallback;
}

const HIGHWAY_RE = '^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|road|residential|living_street|service|pedestrian|footway|path|cycleway|steps|bridleway|track)$';

export function buildOverpassQuery(lat, lon, radiusM = DEFAULT_RADIUS_M, timeoutS = 60) {
  const at = `around:${Math.round(radiusM)},${Number(lat).toFixed(6)},${Number(lon).toFixed(6)}`;
  return [
    `[out:json][timeout:${Math.round(timeoutS)}][maxsize:268435456];`,
    '(',
    `  way["natural"="coastline"](${at});`,
    `  way["man_made"~"^(pier|breakwater|groyne|quay|jetty|lighthouse|crane|storage_tank|pontoon)$"](${at});`,
    `  node["man_made"~"^(lighthouse|crane|storage_tank)$"](${at});`,
    `  way["waterway"="dock"](${at});`,
    `  relation["waterway"="dock"](${at});`,
    `  way["leisure"="marina"](${at});`,
    `  way["landuse"](${at});`,
    `  way["natural"="water"](${at});`,
    `  nwr["seamark:type"](${at});`,
    `  way["building"](${at});`,
    // v0.4 street layer: roads, rails, green / sand / parking areas, and the amenities the ashore world turns into doors
    `  way["highway"~"${HIGHWAY_RE}"](${at});`,
    `  way["railway"="rail"](${at});`,
    `  way["leisure"~"^(park|garden)$"](${at});`,
    `  way["natural"~"^(wood|scrub|grassland|heath|beach|sand)$"](${at});`,
    `  way["amenity"="parking"](${at});`,
    `  nwr["amenity"~"^(bar|pub|restaurant|cafe|fuel|police|harbourmaster|marketplace)$"](${at});`,
    `  nwr["industrial"="shipyard"](${at});`,
    `  nwr["craft"~"^(boatbuilder|shipwright|sailmaker)$"](${at});`,
    `  nwr["waterway"="fuel"](${at});`,
    `  node["shop"](${at});`,
    `  node["tourism"](${at});`,
    ');',
    'out geom;',
  ].join('\n');
}

// Overpass `out geom`: way.geometry = [{lat,lon},...]; relation.members[].geometry likewise.
function geomToPts(geometry) {
  const pts = [];
  if (!Array.isArray(geometry)) return pts;
  for (const p of geometry) {
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    const q = [round6(p.lat), round6(p.lon)];
    const l = pts[pts.length - 1];
    if (!l || l[0] !== q[0] || l[1] !== q[1]) pts.push(q);
  }
  return pts;
}
function isClosedPts(pts) { return pts.length >= 4 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]; }

const NATURAL_AREAS = new Set(['wood', 'scrub', 'grassland', 'heath', 'beach', 'sand']);
const RELEVANT = (t) => t && (t.natural === 'coastline' || t.natural === 'water' || t.man_made || t.waterway === 'dock' || t.leisure === 'marina' || t.landuse || t['seamark:type'] || t.building
  || t.highway || t.railway === 'rail' || NATURAL_AREAS.has(t.natural) || t.leisure === 'park' || t.leisure === 'garden'
  || t.amenity || t.shop || t.tourism || t.industrial === 'shipyard' || t.craft || t.waterway === 'fuel');

/** Rank of an OSM highway value for the road cap (lower = kept first); null for values the street layer ignores. */
export function highwayRank(hw) {
  switch (String(hw || '')) {
    case 'motorway': case 'motorway_link': case 'trunk': case 'trunk_link': return 0;
    case 'primary': case 'primary_link': return 1;
    case 'secondary': case 'secondary_link': return 2;
    case 'tertiary': case 'tertiary_link': case 'unclassified': case 'road': return 3;
    case 'residential': case 'living_street': return 4;
    case 'service': return 5;
    case 'pedestrian': case 'footway': case 'path': case 'cycleway': case 'steps': case 'bridleway': return 6;
    case 'track': return 7;
    default: return null;
  }
}
/** True for tags the ashore world turns into a door (amenity/shop/craft/industrial match one of POI_KINDS). */
const isPoiTagged = (t) => !!poiKindOf(t || {});

/** Squared distance in m² from a [lat,lon] point to the nearest vertex of a polyline / ring (cheap ranking metric). */
function nearestVertexD2(pts, lat, lon) {
  const k = Math.cos(lat * D2R) * GEO.M_PER_DEG_LON_EQ;
  let best = Infinity;
  for (const p of pts) { const dx = (p[1] - lon) * k, dy = (p[0] - lat) * GEO.M_PER_DEG_LAT, d = dx * dx + dy * dy; if (d < best) best = d; }
  return best;
}

/**
 * Overpass JSON → { coastline: [[[lat,lon],…]], features: [raw tagged ways/nodes] }. Ways keep `geometry` as
 * [[lat,lon],…] (closing point removed, `closed` flag set), nodes keep lat/lon. Relations are flattened into their
 * outer rings. Caps: buildings to the `buildingCap` largest by footprint (buildings tagged as a game amenity first),
 * highway ways to `roadCap` (major classes first, then nearest to `origin` {lat, lon} when given, else longest), shop
 * nodes to `shopCap` (nearest first).
 */
export function parseOverpass(json, { buildingCap = BUILDING_CAP, roadCap = ROAD_CAP, shopCap = SHOP_CAP, origin = null } = {}) {
  const coastline = [];
  const features = [];
  const buildings = [];
  const roads = [];
  const shops = [];
  const elements = Array.isArray(json?.elements) ? json.elements : [];
  const oLat = Number.isFinite(origin?.lat) ? origin.lat : null, oLon = Number.isFinite(origin?.lon) ? origin.lon : null;
  const pushWay = (id, tags, pts, closedHint) => {
    if (!tags || pts.length < 2) return;
    const closed = closedHint || isClosedPts(pts);
    const geometry = closed && isClosedPts(pts) ? pts.slice(0, -1) : pts;
    if (tags.natural === 'coastline') { coastline.push(closed ? geometry.concat([geometry[0]]) : geometry); return; }
    if (!RELEVANT(tags)) return;
    const el = { type: 'way', id, tags: compactTags(tags), geometry, closed };
    if (tags.building && tags.building !== 'no' && !tags.man_made) {
      if (closed && geometry.length >= 3) { el.area = Math.round(ringAreaM2(geometry)); el.poi = isPoiTagged(tags); buildings.push(el); }
      return;
    }
    if (tags.highway && !tags.man_made) {
      if (tags.area === 'yes') { if (closed && geometry.length >= 3) features.push(el); return; }   // paved squares → areas
      const rank = highwayRank(tags.highway);
      if (rank == null) return;
      el.rank = rank;
      el.d2 = oLat != null ? nearestVertexD2(geometry, oLat, oLon) : -polylineLengthM(geometry);
      roads.push(el);
      return;
    }
    features.push(el);
  };
  for (const el of elements) {
    if (!el || typeof el !== 'object') continue;
    if (el.type === 'node') {
      if (!el.tags || !RELEVANT(el.tags) || !Number.isFinite(el.lat) || !Number.isFinite(el.lon)) continue;
      const node = { type: 'node', id: el.id, tags: compactTags(el.tags), lat: round6(el.lat), lon: round6(el.lon) };
      if (el.tags.shop && !isPoiTagged(el.tags)) {
        node.d2 = oLat != null ? nearestVertexD2([[node.lat, node.lon]], oLat, oLon) : 0;
        shops.push(node);
        continue;
      }
      features.push(node);
    } else if (el.type === 'way') {
      pushWay(el.id, el.tags, geomToPts(el.geometry), false);
    } else if (el.type === 'relation' && Array.isArray(el.members) && el.tags) {
      const outers = el.members.filter((m) => m && m.type === 'way' && (m.role === 'outer' || !m.role) && Array.isArray(m.geometry)).map((m) => geomToPts(m.geometry));
      for (const chain of joinWays(outers)) {
        if (chain.closed && chain.length >= 3) pushWay(el.id, el.tags, chain.concat([chain[0]]), true);
        else if (!chain.closed && chain.length >= 2 && el.tags.natural === 'coastline') coastline.push(chain.slice());
      }
    }
  }
  buildings.sort((a, b) => (b.poi - a.poi) || (b.area - a.area));
  for (const b of buildings.slice(0, buildingCap)) { delete b.poi; features.push(b); }
  roads.sort((a, b) => (a.rank - b.rank) || (a.d2 - b.d2));
  for (const r of roads.slice(0, Math.max(0, roadCap))) { delete r.rank; delete r.d2; features.push(r); }
  shops.sort((a, b) => a.d2 - b.d2);
  for (const s of shops.slice(0, Math.max(0, shopCap))) { delete s.d2; features.push(s); }
  return { coastline, features };
}

const KEEP_TAGS = ['natural', 'water', 'man_made', 'waterway', 'leisure', 'landuse', 'building', 'height', 'building:levels', 'name', 'width', 'area',
  'floating', 'crane:type', 'seamark:type', 'seamark:name', 'amenity', 'mooring', 'diameter', 'content',
  'highway', 'railway', 'lanes', 'bridge', 'tunnel', 'layer', 'service', 'ref', 'shop', 'tourism', 'craft', 'industrial', 'brand', 'operator'];
function compactTags(tags) {
  const out = {};
  for (const k of Object.keys(tags)) if (KEEP_TAGS.includes(k) || k.startsWith('seamark:')) out[k] = tags[k];
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Feature classification (quays, piers, breakwaters, pontoons, docks, marinas, land use, buildings, tanks, cranes,
// lights, buoys)
// ---------------------------------------------------------------------------------------------------------------

/** IALA region B (red to starboard when entering) = the Americas, Japan, Korea, the Philippines. */
export function ialaRegion(lat, lon) {
  if (lon < -30 && lon > -170) return 'B';
  if (lon >= 123 && lon <= 150 && lat >= 24 && lat <= 46) return 'B';   // Japan
  if (lon >= 124 && lon <= 132 && lat >= 33 && lat <= 39) return 'B';   // Korea
  if (lon >= 116 && lon <= 127 && lat >= 4 && lat <= 21) return 'B';    // Philippines
  return 'A';
}
export const BUOY_COLORS = { red: '#e02020', green: '#20b040', yellow: '#ffd200', black: '#101010', white: '#f4f4f4' };
const SHAPE_MAP = { can: 'can', cylindrical: 'can', conical: 'cone', cone: 'cone', pillar: 'pillar', spar: 'spar', spherical: 'sphere', sphere: 'sphere', barrel: 'can', 'super-buoy': 'pillar', tower: 'pillar', stake: 'spar', pole: 'spar', lattice: 'pillar', cairn: 'pillar' };

/** seamark:type = buoy_… or beacon_… → {kind, color, color2, shape} (IALA colours by region when untagged). */
export function classifyBuoy(tags, lat, lon) {
  const type = String(tags['seamark:type'] || '');
  const m = type.match(/^(buoy|beacon)_(lateral|cardinal|safe_water|special_purpose|isolated_danger|installation)$/);
  if (!m) return null;
  const sub = `seamark:${type}:`;
  const cat = String(tags[`${sub}category`] || '').toLowerCase();
  const colourTag = String(tags[`${sub}colour`] || '').toLowerCase();
  const shapeTag = String(tags[`${sub}shape`] || '').toLowerCase();
  const region = ialaRegion(lat, lon);
  let kind, color, color2 = null, shape;
  switch (m[2]) {
    case 'lateral': {
      let port = cat.includes('port') && !cat.includes('preferred_channel_starboard');
      if (cat.includes('preferred_channel_port')) port = false; // preferred channel to port → starboard-hand mark
      if (!cat) port = colourTag.startsWith(region === 'A' ? 'red' : 'green');
      kind = port ? 'lateral_port' : 'lateral_starboard';
      const redPort = region === 'A';
      color = (port === redPort) ? BUOY_COLORS.red : BUOY_COLORS.green;
      shape = SHAPE_MAP[shapeTag] || (port ? 'can' : 'cone');
      break;
    }
    case 'cardinal': {
      const dir = ['north', 'east', 'south', 'west'].find((d) => cat.startsWith(d)) || 'north';
      kind = `cardinal_${dir[0]}`;
      color = dir === 'north' || dir === 'east' ? BUOY_COLORS.black : BUOY_COLORS.yellow;
      color2 = dir === 'north' || dir === 'east' ? BUOY_COLORS.yellow : BUOY_COLORS.black;
      shape = SHAPE_MAP[shapeTag] || 'pillar';
      break;
    }
    case 'safe_water': kind = 'safe_water'; color = BUOY_COLORS.red; color2 = BUOY_COLORS.white; shape = SHAPE_MAP[shapeTag] || 'sphere'; break;
    case 'isolated_danger': kind = 'isolated_danger'; color = BUOY_COLORS.black; color2 = BUOY_COLORS.red; shape = SHAPE_MAP[shapeTag] || 'pillar'; break;
    default: kind = 'special'; color = BUOY_COLORS.yellow; shape = SHAPE_MAP[shapeTag] || 'can';
  }
  return { kind, color, color2, shape };
}

function lightFrom(tags, fallbackHeight) {
  const col = String(tags['seamark:light:colour'] || tags['seamark:light:1:colour'] || 'white').toLowerCase();
  const color = col.startsWith('red') ? BUOY_COLORS.red : col.startsWith('green') ? BUOY_COLORS.green : col.startsWith('yellow') || col.startsWith('orange') ? BUOY_COLORS.yellow : '#ffffff';
  const period = parseFloat(tags['seamark:light:period'] || tags['seamark:light:1:period']);
  const height = parseFloat(tags['seamark:light:height'] || tags['seamark:light:1:height']) || parseLength(tags.height) || fallbackHeight;
  return { height: round1(height), color, period: Number.isFinite(period) && period > 0 ? period : 5 };
}

/** Direction (deg, 0 = north, clockwise) of the longest side of a ring, or null. */
function longestEdgeBearing(pts) {
  if (!pts || pts.length < 2) return null;
  const k = Math.cos(pts[0][0] * D2R) * GEO.M_PER_DEG_LON_EQ;
  let best = -1, brg = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const dx = (b[1] - a[1]) * k, dy = (b[0] - a[0]) * GEO.M_PER_DEG_LAT, L = dx * dx + dy * dy;
    if (L > best) { best = L; brg = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360; }
  }
  return brg;
}

// ---------------------------------------------------------------------------------------------------------------
// v0.4 street layer classification: roads, areas, rails, game POIs (doors) and decorative street signs (places)
// ---------------------------------------------------------------------------------------------------------------
const HM_RE = /harbou?r[ _-]?master|havenmeester|havendienst|hafenmeister|hafenamt|havnefoged|havnekontor|hamnkapten|hamnkontor|capitainerie|capitaneria|port authority|port office|havenkantoor/i;
const SHIPYARD_RE = /shipyard|dockyard|scheepswerf|\bwerf\b|werft|værft|verft|varv|chantier naval|astillero|cantiere|boatyard|jachtwerf/i;
const CHANDLER_RE = /chandler|scheepsbehoeften|schiffsausrüster|skipshandel|shipshandel|watersport|bootsbedarf|marine supplies/i;
const isTunnel = (t) => t.tunnel != null && t.tunnel !== 'no' && t.tunnel !== 'building_passage';
const isBridge = (t) => t.bridge != null && t.bridge !== 'no';

/** OSM highway tags → {kind (ROAD_KINDS), width (m)} for the street layer, or null for values it ignores. */
export function roadKindOf(tags = {}) {
  const hw = String(tags.highway || '');
  const rank = highwayRank(hw);
  if (rank == null) return null;
  const kind = ROAD_KINDS[rank];
  let width = parseLength(tags.width);
  if (!(width >= 1.2 && width <= 45)) {
    const lanes = parseInt(tags.lanes, 10);
    if (Number.isFinite(lanes) && lanes >= 1 && lanes <= 10 && rank <= 5) width = lanes * 3.3 + (rank <= 3 ? 1 : 0.5);
    else width = ROAD_WIDTH[kind];
    if (/_link$/.test(hw)) width = Math.min(width, 6.5);
    if (hw === 'pedestrian') width = 6;
    else if (hw === 'cycleway') width = 2.5;
    else if (hw === 'path' || hw === 'steps' || hw === 'bridleway') width = Math.min(width, 2);
    else if (hw === 'living_street') width = 5.5;
    if (hw === 'service' && /parking_aisle|driveway|drive-through/.test(String(tags.service || ''))) width = Math.min(width, 4);
  }
  return { kind, width: round1(width) };
}

/** Closed-way tags → AREA_KINDS value, or null (water, basins and unknown land use are not drawn). */
export function areaKindOf(tags = {}) {
  const lu = tags.landuse, le = tags.leisure, na = tags.natural, am = tags.amenity;
  if (am === 'parking' || (tags.highway && tags.area === 'yes')) return 'parking';
  if (le === 'park' || le === 'garden' || lu === 'recreation_ground' || lu === 'village_green' || lu === 'cemetery') return 'park';
  if (na === 'wood' || na === 'scrub' || lu === 'forest') return 'wood';
  if (na === 'beach' || na === 'sand') return 'sand';
  if (na === 'grassland' || na === 'heath' || /^(grass|meadow|farmland|orchard|allotments|vineyard|greenfield|plant_nursery|flowerbed)$/.test(lu || '')) return 'grass';
  if (lu === 'port' || lu === 'harbour') return 'port';
  if (/^(industrial|railway|construction|brownfield|depot|landfill|quarry)$/.test(lu || '')) return 'industrial';
  if (/^(residential|commercial|retail|education|institutional|military|religious|farmyard)$/.test(lu || '')) return 'residential';
  return null;
}

/** Tags → the game POI kind (POI_KINDS) the ashore world can open a harbour panel for, or null. */
export function poiKindOf(tags = {}) {
  const a = String(tags.amenity || ''), s = String(tags.shop || ''), c = String(tags.craft || ''), name = String(tags.name || '');
  if (a === 'harbourmaster' || /harbour_?master/i.test(String(tags['seamark:harbour:category'] || '')) || (name && HM_RE.test(name))) return 'harbourmaster';
  if (a === 'fuel' || tags.waterway === 'fuel') return 'fuel';
  if (a === 'police') return 'police';
  if (a === 'bar' || a === 'pub') return 'bar';
  if (a === 'cafe' || a === 'restaurant') return 'cafe';
  if (tags.industrial === 'shipyard' || c === 'boatbuilder' || c === 'shipwright' || (name && SHIPYARD_RE.test(name) && (tags.building || tags.landuse || tags.man_made || tags.industrial))) return 'shipyard';
  if (s === 'boat' || s === 'ship_chandler' || s === 'marine' || s === 'fishing' || c === 'sailmaker' || (name && CHANDLER_RE.test(name) && (s || tags.building))) return 'chandler';
  if (a === 'marketplace' || s === 'wholesale' || s === 'seafood' || s === 'fishmonger') return 'market';
  return null;
}

/** Named shop / tourism / amenity nodes that are not game POIs → a street sign {kind, sub, name}, or null. */
function placeOf(tags) {
  const name = String(tags.name || '').trim();
  if (!name || name.length > 48) return null;
  if (tags.shop) return { kind: 'shop', sub: String(tags.shop), name };
  if (tags.tourism && !/^(information|viewpoint|artwork|picnic_site|camp_pitch|yes)$/.test(String(tags.tourism))) return { kind: 'tourism', sub: String(tags.tourism), name };
  if (tags.amenity && /^(bank|pharmacy|post_office|fast_food|ice_cream|ferry_terminal|townhall|library|theatre|cinema|hospital|clinic|bus_station|car_rental|bicycle_rental)$/.test(String(tags.amenity))) return { kind: 'amenity', sub: String(tags.amenity), name };
  return null;
}

/**
 * Raw tagged elements → structured feature lists (all in lat/lon):
 *   quays/piers/breakwaters/pontoons: [{pts, closed, width}]   (closed = ring; open = centre line with a width)
 *   docks/marinas/landuse: [{pts}] rings
 *   buildings: [{pts, height, kind, area, poi?}], tanks: [{lat, lon, radius, height}], cranes: [{lat, lon, hdg}],
 *   lights: [{lat, lon, height, color, period}], buoys: [{lat, lon, kind, color, color2, shape}]
 *   v0.4: roads: [{pts, kind, width, name, bridge}], areas: [{pts, kind}], rails: [{pts, bridge}],
 *         pois: [{kind, name, lat, lon, ring|null, building}], places: [{kind, sub, name, lat, lon}]
 * `origin` ({lat, lon}, optional) ranks the capped lists (places nearest first).
 */
export function classifyFeatures(features, origin = null) {
  const out = { quays: [], piers: [], breakwaters: [], pontoons: [], docks: [], marinas: [], landuse: [], water: [], buildings: [], tanks: [], cranes: [], lights: [], buoys: [],
    roads: [], areas: [], rails: [], pois: [], places: [] };
  const marinaRings = [];
  const list = Array.isArray(features) ? features : [];
  for (const el of list) if (el?.type === 'way' && el.closed && el.tags?.leisure === 'marina' && el.geometry?.length >= 3) marinaRings.push(el.geometry);
  for (const el of list) {
    const t = el?.tags; if (!t) continue;
    if (el.type === 'node') {
      const lat = el.lat, lon = el.lon;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const st = String(t['seamark:type'] || '');
      const pk = poiKindOf(t);
      if (pk) out.pois.push({ kind: pk, name: String(t.name || '').slice(0, 60), lat, lon, ring: null, building: false });
      else { const pl = placeOf(t); if (pl) out.places.push({ ...pl, lat, lon }); }
      const buoy = classifyBuoy(t, lat, lon);
      if (buoy) { out.buoys.push({ lat, lon, ...buoy }); continue; }
      if (t.man_made === 'lighthouse' || /^light(_major|_minor|_vessel|_float)?$/.test(st)) { out.lights.push({ lat, lon, ...lightFrom(t, t.man_made === 'lighthouse' ? 15 : 8) }); continue; }
      if (t.man_made === 'crane') { out.cranes.push({ lat, lon, hdg: 0 }); continue; }
      if (t.man_made === 'storage_tank') { out.tanks.push({ lat, lon, radius: parseLength(t.diameter) ? parseLength(t.diameter) / 2 : 10, height: parseHeight(t, 12) }); continue; }
      continue;
    }
    const pts = el.geometry; if (!Array.isArray(pts) || pts.length < 2) continue;
    const closed = !!el.closed && pts.length >= 3;
    const width = parseLength(t.width);
    const st = String(t['seamark:type'] || '');
    const mm = t.man_made;
    // ---- v0.4 street layer (a way can be a road AND a structure, e.g. a pier tagged highway=footway)
    if (t.highway && t.area !== 'yes' && !isTunnel(t)) {
      const r = roadKindOf(t);
      if (r) out.roads.push({ pts, kind: r.kind, width: r.width, name: String(t.name || t.ref || '').slice(0, 60), bridge: isBridge(t) });
    }
    if (t.railway === 'rail') { if (!isTunnel(t)) out.rails.push({ pts, bridge: isBridge(t) }); continue; }
    const ak = closed ? areaKindOf(t) : null;
    if (ak) out.areas.push({ pts, kind: ak, area: Math.round(ringAreaM2(pts)) });
    const pk = poiKindOf(t);
    if (pk) { const c = centroid(pts); out.pois.push({ kind: pk, name: String(t.name || '').slice(0, 60), lat: round6(c[0]), lon: round6(c[1]), ring: closed ? pts : null, building: !!(t.building && t.building !== 'no') }); }
    if (t.building && t.building !== 'no' && !mm) {
      if (!closed) continue;
      const b = String(t.building).toLowerCase();
      const kind = b === 'storage_tank' || b === 'silo' ? 'tank' : /warehouse|hangar|shed/.test(b) ? 'warehouse' : /industrial|factory|manufacture|works/.test(b) ? 'industrial' : 'building';
      const area = el.area || Math.round(ringAreaM2(pts));
      if (kind === 'tank') { const c = centroid(pts); out.tanks.push({ lat: c[0], lon: c[1], radius: round1(Math.sqrt(area / Math.PI)), height: parseHeight(t, 12) }); continue; }
      out.buildings.push({ pts, height: parseHeight(t, 8), kind, area, poi: !!pk });
      continue;
    }
    if (mm === 'storage_tank' || st === 'tank') {
      if (!closed) continue;
      const c = centroid(pts), area = ringAreaM2(pts);
      out.tanks.push({ lat: c[0], lon: c[1], radius: round1(Math.max(3, Math.sqrt(area / Math.PI))), height: parseHeight(t, 12) });
      continue;
    }
    if (mm === 'lighthouse' || /^light(_major|_minor)?$/.test(st)) { const c = centroid(pts); out.lights.push({ lat: c[0], lon: c[1], ...lightFrom(t, 15) }); continue; }
    if (mm === 'crane') { const c = centroid(pts); out.cranes.push({ lat: c[0], lon: c[1], hdg: Math.round(longestEdgeBearing(pts) ?? 0) }); continue; }
    const floating = t.floating === 'yes' || mm === 'pontoon' || st === 'pontoon' || st === 'mooring';
    const insideMarina = closed ? false : marinaRings.some((r) => pointInRing(pts[0][0], pts[0][1], r));
    if (mm === 'pier' || mm === 'jetty' || mm === 'quay' || mm === 'pontoon' || st === 'pontoon') {
      const rec = { pts, closed, width: width || (mm === 'quay' ? 10 : floating ? 3 : 6) };
      if (floating || (mm !== 'quay' && insideMarina)) out.pontoons.push(rec);
      else if (mm === 'quay') out.quays.push(rec);
      else out.piers.push(rec);
      continue;
    }
    if (mm === 'breakwater' || mm === 'groyne' || st === 'breakwater' || st === 'groyne' || /^(shoreline_construction)$/.test(st)) { out.breakwaters.push({ pts, closed, width: width || (mm === 'groyne' ? 8 : 14) }); continue; }
    if (t.waterway === 'dock' && closed) { out.docks.push({ pts }); continue; }
    if (t.natural === 'water' && closed) { out.water.push({ pts }); continue; }
    if (t.leisure === 'marina' && closed) { out.marinas.push({ pts }); continue; }
    if ((t.landuse === 'port' || t.landuse === 'industrial') && closed) { out.landuse.push({ pts }); continue; }
    if (/^(buoy|beacon)_/.test(st)) { const c = centroid(pts); const b = classifyBuoy(t, c[0], c[1]); if (b) out.buoys.push({ lat: c[0], lon: c[1], ...b }); }
  }
  // buildings that carry a game amenity survive the cap; the rest are the largest footprints
  out.buildings.sort((a, b) => ((b.poi ? 1 : 0) - (a.poi ? 1 : 0)) || (b.area - a.area));
  if (out.buildings.length > BUILDING_CAP) out.buildings.length = BUILDING_CAP;
  out.areas.sort((a, b) => b.area - a.area);
  if (out.areas.length > AREA_CAP) out.areas.length = AREA_CAP;
  if (out.roads.length > ROAD_CAP) {
    out.roads.sort((a, b) => ROAD_KINDS.indexOf(a.kind) - ROAD_KINDS.indexOf(b.kind));
    out.roads.length = ROAD_CAP;
  }
  if (origin && Number.isFinite(origin.lat) && Number.isFinite(origin.lon)) {
    const d2 = (p) => nearestVertexD2([[p.lat, p.lon]], origin.lat, origin.lon);
    out.places.sort((a, b) => d2(a) - d2(b));
    out.pois.sort((a, b) => d2(a) - d2(b));
  }
  if (out.places.length > PLACE_CAP) out.places.length = PLACE_CAP;
  if (out.pois.length > 200) out.pois.length = 200;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Disk cache
// ---------------------------------------------------------------------------------------------------------------

/** Sync read of data/osm/<id>.json → the cached payload (any age) or null. */
/**
 * The cached Overpass answer of a harbour, or null. With `harbor` ({lat, lon, prev?}) a cache fetched round another
 * centre is not used: its `center` is > 300 m away, or it has no `center` and the harbour was moved (`prev`, the
 * harbour position audit) — the street layer would belong to the old spot.
 */
export function loadCachedOSM(id, harbor = null) {
  try {
    const f = osmCachePath(id);
    if (!fs.existsSync(f)) return null;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!j || typeof j !== 'object' || !Array.isArray(j.features) || !Array.isArray(j.coastline)) return null;
    if (harbor && Number.isFinite(harbor.lat)) {
      const c = j.center;
      if (c && Number.isFinite(c.lat) ? Math.hypot(c.lat - harbor.lat, (c.lon - harbor.lon) * Math.cos((harbor.lat * Math.PI) / 180)) * 111320 > 300 : !!harbor.prev) return null;
    }
    return j;
  } catch { return null; }
}
/** True when the payload came from the current Overpass query (older caches lack the street layer). */
export function osmHasStreets(osm) { return !!osm && (osm.schema || 1) >= OSM_SCHEMA; }
export function isOSMFresh(osm, now = Date.now()) {
  if (!osm || !Number.isFinite(osm.fetchedAt)) return false;
  if (!osmHasStreets(osm)) return false;
  const empty = osm.coastline.length === 0 && osm.features.length === 0;
  return now - osm.fetchedAt < (empty ? OSM_EMPTY_TTL_MS : OSM_TTL_MS);
}
export function saveCachedOSM(id, payload) {
  try {
    fs.mkdirSync(osmDir, { recursive: true });
    const f = osmCachePath(id), tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, f);
    return true;
  } catch { return false; }
}

// ---------------------------------------------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------------------------------------------

async function postOverpass(endpoint, query, timeoutMs, fetchImpl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT, Accept: 'application/json' },
      body: 'data=' + encodeURIComponent(query),
      signal: ctrl.signal,
    });
    if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : 'no response'}`);
    const json = await res.json();
    if (json?.remark && /error|timed out|out of memory|runtime error/i.test(json.remark)) throw new Error(`Overpass remark: ${json.remark}`);
    if (!json || !Array.isArray(json.elements)) throw new Error('malformed Overpass response');
    return json;
  } catch (err) {
    throw err?.name === 'AbortError' ? new Error(`timeout after ${timeoutMs} ms`) : err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch (or reuse a fresh cache of) the OSM data around a harbour. Resolves
 * `{id, schema, fetchedAt, radiusM, endpoint, coastline, features}` or null on any failure — never throws. A cache
 * written by an older query (schema < OSM_SCHEMA) is refetched, and returned as-is when the network fails.
 *   opts: radiusM, timeoutMs, fetchImpl (default global fetch), force (ignore a fresh cache), log, endpoints
 */
export async function fetchHarborOSM(harbor, opts = {}) {
  try {
    if (!harbor || !harbor.id || !Number.isFinite(harbor.lat) || !Number.isFinite(harbor.lon)) return null;
    const radiusM = Number.isFinite(opts.radiusM) ? opts.radiusM : DEFAULT_RADIUS_M;
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    const log = typeof opts.log === 'function' ? opts.log : () => {};
    if (!opts.force) {
      const cached = loadCachedOSM(harbor.id, harbor);
      if (cached && isOSMFresh(cached) && cached.radiusM >= radiusM - 1) return cached;
    }
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') return staleFallback(harbor);
    const endpoints = Array.isArray(opts.endpoints) && opts.endpoints.length ? opts.endpoints : OVERPASS_ENDPOINTS;
    const query = buildOverpassQuery(harbor.lat, harbor.lon, radiusM, Math.max(10, Math.min(180, timeoutMs / 1000)));
    let lastErr = null;
    for (let attempt = 0; attempt < endpoints.length; attempt++) {
      const endpoint = endpoints[attempt];
      try {
        const json = await postOverpass(endpoint, query, timeoutMs, fetchImpl);
        const { coastline, features } = parseOverpass(json, { buildingCap: opts.buildingCap, origin: { lat: harbor.lat, lon: harbor.lon } });
        const payload = { id: harbor.id, schema: OSM_SCHEMA, fetchedAt: Date.now(), radiusM, endpoint, center: { lat: harbor.lat, lon: harbor.lon }, coastline, features };
        saveCachedOSM(harbor.id, payload);
        return payload;
      } catch (err) {
        lastErr = err;
        log(`[osm] ${harbor.id}: ${hostOf(endpoint)} failed: ${err?.message || err}`);
      }
    }
    void lastErr;
    return staleFallback(harbor);
  } catch {
    return null;
  }
}

function staleFallback(harbor) { const c = loadCachedOSM(harbor.id, harbor); return c || null; }
function hostOf(url) { try { return new URL(url).host; } catch { return String(url); } }
