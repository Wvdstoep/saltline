// Harbour scenery from the server's geometry JSON (docs/V3-CONTRACTS.md §1, V4 §4): extruded quays and piers with
// bollards, fenders, mooring rings and a dark kerb, rubble breakwaters, floating pontoons on piles, buildings with roof
// colours by kind and real window facades (one shared canvas texture pair: day facade + lit-window emissive map that
// glows at night), storage tanks, gantry cranes, light towers that flash with their period, IALA buoys that ride the
// sea (userData.updateBuoys), berth number boards, street lamps, container stacks and the harbour name.
// v0.4: the street layer (features.roads / areas / rails) is drawn as a cheap far LOD — flat land-use colours and road
// / rail ribbons draped on the patch ground — whenever the player is NOT ashore (ashore.js builds the detailed street
// world and calls userData.setAshore(true)); the land-use flats step aside once the street-level map drape of the
// patch is showing (terrain.js). The harbour label is sized like a real sign near by and clamped to a readable pixel
// size far away (makeLabel options).
// Rings arrive in lat/lon and are converted with toLocal(lat, lon, geom.origin); main.js places the group at the origin.
// Without geometry (geom null / legacy OSM array) a compact quay at the harbour point is built instead — never a
// floating platform. Everything static is merged per material (models.js PartBuilder); userData.dispose() frees it all
// except the shared module palette and textures.
import * as THREE from 'three';
import { toLocal, fromLocal } from '/shared/geo.js';
import { PATCH } from '/shared/constants.js';
import { makeLabel, disposeGroup, buildPlatform } from './ship.js';
import { PartBuilder, hashStr, rng, cleanRing, ringArea, pointInRing, ringCentroid, ringBBox, extrudeRing, splitGroups, textTexture } from './models.js';
import { surfaceHeightAt } from './ocean2.js';
import { patchHeightAt, patchMaskAt } from './harborgeom.js';
import { patchEntry, drapeState } from './terrain.js';

export { buildPlatform };

const MK = PATCH.MASK;

// ----------------------------------------------------------------------------------------------- shared palette
const std = (color, extra = {}) => { const m = new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0.05, ...extra }); m.userData.shared = true; return m; };
const M = {
  concrete: std(0x8e8b84, { roughness: 0.95 }), wall: std(0x5f5c57, { roughness: 0.95 }), kerb: std(0x3d3b38), asphalt: std(0x4c4f52),
  rubble: std(0x5a5650, { roughness: 1 }), rock: std(0x4e4a45, { roughness: 1 }), pontoon: std(0xb9b2a4, { roughness: 0.8 }), pile: std(0x3a3632),
  steel: std(0x3b4a5a, { roughness: 0.6, metalness: 0.5 }), galv: std(0x9aa3ab, { roughness: 0.5, metalness: 0.6 }), rubber: std(0x15171a, { roughness: 1 }), bollard: std(0x1e2126, { roughness: 0.7, metalness: 0.4 }),
  craneRed: std(0xc8382b, { roughness: 0.6, metalness: 0.3 }), craneBlue: std(0x2457a8, { roughness: 0.6, metalness: 0.3 }), craneGrey: std(0x6f7781, { roughness: 0.6, metalness: 0.4 }),
  white: std(0xf2f2ee, { roughness: 0.7 }), red: std(0xd32f2f, { roughness: 0.6 }), green: std(0x2e7d32, { roughness: 0.6 }), yellow: std(0xf2c230, { roughness: 0.6 }), black: std(0x15161a, { roughness: 0.7 }),
  roofEdge: std(0x3a3d41, { roughness: 0.85 }), tank: std(0xdcdcd6, { roughness: 0.55, metalness: 0.3 }), tankTop: std(0x8d9196, { roughness: 0.6, metalness: 0.3 }),
  lampPole: std(0x3a3f45, { roughness: 0.6, metalness: 0.5 }), board: std(0x10243f, { roughness: 0.6 }),
};
/** roof colours by building kind (flat roofs: metal sheet on sheds, bitumen / gravel / tiles on the rest) */
const ROOFS = {
  warehouse: [0xa3a9ad, 0x8796a3, 0x7f8f7a, 0xb0a79a, 0x9aa0a6].map((c) => std(c, { roughness: 0.55, metalness: 0.35 })),
  industrial: [0x6b6f73, 0x80776c, 0x5f676f, 0x76695c].map((c) => std(c, { roughness: 0.7, metalness: 0.25 })),
  small: [0x9b5a43, 0x7d4a3c, 0x8a4f3a, 0x4f555c, 0x5d6268].map((c) => std(c, { roughness: 0.85 })),
  large: [0x4a4f55, 0x585c60, 0x8c8a84, 0x6d7072, 0x55705a].map((c) => std(c, { roughness: 0.92 })),
};
const CONT = [0xc0392b, 0x2980b9, 0x27ae60, 0xf39c12, 0x7f8c8d, 0xd35400].map((c) => std(c, { roughness: 0.7 }));

const QUAY_H = 2.65, BW_H = 3.6, PONT_H = 0.7, QUAY_BOTTOM = -3;
const CAPS = { bollards: 1500, fenders: 2500, rings: 1500, lamps: 250, rocks: 700, buildings: 320, containers: 70, roofEdges: 2400 };
// facade textures: OFFICE covers 4 bays × 4 floors (3.2 m × 3.3 m each); SHED covers 4 bays (3 m) × the full wall height
const OFFICE_BAY = 3.2, OFFICE_FLOOR = 3.3, SHED_BAY = 3.0;

// ----------------------------------------------------------------------------------------------- facade textures
/** One shared pair per style: `map` (white wall + glazing, tinted by the material colour) and `lit` (warm windows). */
const FACADE = {};
function facade(style) {
  if (FACADE[style]) return FACADE[style];
  const S = 512, r = rng(style === 'office' ? 9001 : 4242);
  const mk = () => { const c = document.createElement('canvas'); c.width = c.height = S; return { c, x: c.getContext('2d') }; };
  const day = mk(), lit = mk();
  day.x.fillStyle = '#f4f2ee'; day.x.fillRect(0, 0, S, S);
  lit.x.fillStyle = '#000'; lit.x.fillRect(0, 0, S, S);
  if (style === 'office') {
    const bw = S / 4, fh = S / 4;
    for (let f = 0; f < 4; f++) {
      // floor slab line
      day.x.fillStyle = 'rgba(0,0,0,0.10)'; day.x.fillRect(0, f * fh, S, 5);
      for (let b = 0; b < 4; b++) {
        const x0 = b * bw + bw * 0.14, y0 = f * fh + fh * 0.22, w = bw * 0.72, h = fh * 0.56;
        const g = day.x.createLinearGradient(0, y0, 0, y0 + h);
        g.addColorStop(0, '#2b4258'); g.addColorStop(1, '#1a2b3b');
        day.x.fillStyle = g; day.x.fillRect(x0, y0, w, h);
        day.x.fillStyle = 'rgba(255,255,255,0.14)'; day.x.fillRect(x0 + 3, y0 + 3, w * 0.35, h - 6);          // sky glint
        const blind = r();
        if (blind > 0.72) { day.x.fillStyle = 'rgba(225,220,205,0.85)'; day.x.fillRect(x0, y0, w, h * (0.25 + 0.5 * r())); }
        day.x.strokeStyle = '#6b6e72'; day.x.lineWidth = 4; day.x.strokeRect(x0, y0, w, h);
        day.x.beginPath(); day.x.moveTo(x0 + w / 2, y0); day.x.lineTo(x0 + w / 2, y0 + h); day.x.stroke();      // mullion
        day.x.fillStyle = 'rgba(0,0,0,0.18)'; day.x.fillRect(x0 - 2, y0 + h, w + 4, 6);                           // sill shadow
        if (r() < 0.42) { const warm = 200 + Math.floor(r() * 55); lit.x.fillStyle = `rgb(255,${warm},${Math.floor(warm * 0.62)})`; lit.x.fillRect(x0 + 2, y0 + 2, w - 4, h - 4); }
      }
    }
  } else {
    // corrugated cladding (vertical ribs), a band of high windows under the eaves, roller doors in some bays
    for (let x = 0; x < S; x += 8) { day.x.fillStyle = x % 16 === 0 ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.12)'; day.x.fillRect(x, 0, 4, S); }
    day.x.fillStyle = 'rgba(0,0,0,0.16)'; day.x.fillRect(0, 0, S, 10);                                          // eaves
    const bw = S / 4;
    for (let b = 0; b < 4; b++) {
      const x0 = b * bw + bw * 0.12, w = bw * 0.76, y0 = S * 0.08, h = S * 0.09;
      day.x.fillStyle = '#2a3b4a'; day.x.fillRect(x0, y0, w, h);
      day.x.strokeStyle = '#7a7d80'; day.x.lineWidth = 3; day.x.strokeRect(x0, y0, w, h);
      if (r() < 0.5) { lit.x.fillStyle = 'rgb(255,226,170)'; lit.x.fillRect(x0 + 2, y0 + 2, w - 4, h - 4); }
      if (b === 1 || b === 3) { // roller door
        const dx = b * bw + bw * 0.15, dw = bw * 0.7, dy = S * 0.55;
        day.x.fillStyle = '#8f9396'; day.x.fillRect(dx, dy, dw, S - dy);
        for (let y = dy; y < S; y += 10) { day.x.fillStyle = 'rgba(0,0,0,0.16)'; day.x.fillRect(dx, y, dw, 3); }
        day.x.strokeStyle = '#4a4d50'; day.x.lineWidth = 5; day.x.strokeRect(dx, dy, dw, S - dy);
      }
    }
    day.x.fillStyle = 'rgba(0,0,0,0.22)'; day.x.fillRect(0, S - 14, S, 14);                                     // plinth
  }
  const tex = (c, srgb) => { const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4; if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.userData.shared = true; return t; };
  FACADE[style] = { map: tex(day.c, true), lit: tex(lit.c, true) };
  return FACADE[style];
}
/** wall materials: shared, textured, emissive windows driven by setNight (all harbours share the night value) */
const WALL_MATS = [];
function wallMat(color, style) {
  const f = facade(style);
  const m = std(color, { map: f.map, emissiveMap: f.lit, emissive: new THREE.Color(0xffd9a0), emissiveIntensity: 0, roughness: style === 'office' ? 0.7 : 0.6, metalness: style === 'office' ? 0.1 : 0.25 });
  WALL_MATS.push(m);
  return m;
}
let WALLS = null, SHEDS = null;
function wallPalettes() {
  if (!WALLS) {
    WALLS = [0xd9d4ca, 0xc9c2b4, 0xb8c0c5, 0xc9a86a, 0xa9b4bb, 0xd2c3a8, 0xbfae9a, 0x9fa9a0].map((c) => wallMat(c, 'office'));
    SHEDS = [0x9aa5ad, 0x7d8a93, 0x6f8fa3, 0xa3b1a0, 0x8c8378, 0x6a6f74, 0xb7b9b4].map((c) => wallMat(c, 'shed'));
  }
  return { WALLS, SHEDS };
}

// ----------------------------------------------------------------------------------------------- scene description
function cleanLine(pts, o) {
  if (!Array.isArray(pts)) return null;
  const out = [];
  for (const p of pts) {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const l = toLocal(p[0], p[1], o), last = out[out.length - 1];
    if (last && Math.hypot(last.x - l.x, last.z - l.z) < 0.3) continue;
    out.push({ x: l.x, z: l.z });
  }
  return out.length >= 2 ? out : null;
}
/** Converts the geometry JSON into local-frame rings and points. Every feature is cleaned/validated; bad ones are skipped. */
function sceneFromGeom(geom) {
  const o = geom.origin, F = geom.features || {};
  const ring = (pts) => { if (!Array.isArray(pts)) return null; const loc = []; for (const p of pts) { if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue; const l = toLocal(p[0], p[1], o); loc.push({ x: l.x, z: l.z }); } return cleanRing(loc); };
  const pt = (f) => { const l = toLocal(f.lat, f.lon, o); return { x: l.x, z: l.z }; };
  const rings = (list) => { const out = []; for (const f of list || []) { try { const r = ring(f?.pts); if (r) out.push(r); } catch { /* skip */ } } return out; };
  const S = { quays: rings(F.quays), piers: rings(F.piers), breakwaters: rings(F.breakwaters), pontoons: rings(F.pontoons), buildings: [], tanks: [], cranes: [], lights: [], buoys: [], berths: [], anchor: null, fairway: [], roads: [], areas: [], rails: [] };
  for (const b of (F.buildings || []).slice(0, CAPS.buildings)) { try { const r = ring(b?.pts); if (!r) continue; S.buildings.push({ ring: r, height: Number.isFinite(b.height) ? b.height : 8, kind: b.kind || 'building', base: Number.isFinite(b.base) ? b.base : null }); } catch { /* skip */ } }
  for (const t of F.tanks || []) { try { if (!Number.isFinite(t?.lat) || !Number.isFinite(t?.lon)) continue; S.tanks.push({ ...pt(t), radius: Number.isFinite(t.radius) ? t.radius : 12, height: Number.isFinite(t.height) ? t.height : 12 }); } catch { /* skip */ } }
  for (const c of F.cranes || []) { try { if (!Number.isFinite(c?.lat) || !Number.isFinite(c?.lon)) continue; S.cranes.push({ ...pt(c), hdg: Number.isFinite(c.hdg) ? c.hdg : 0 }); } catch { /* skip */ } }
  for (const l of F.lights || []) { try { if (!Number.isFinite(l?.lat) || !Number.isFinite(l?.lon)) continue; S.lights.push({ ...pt(l), height: Number.isFinite(l.height) ? l.height : 12, color: l.color || '#ffffff', period: Number.isFinite(l.period) ? l.period : 0 }); } catch { /* skip */ } }
  for (const b of F.buoys || []) { try { if (!Number.isFinite(b?.lat) || !Number.isFinite(b?.lon)) continue; S.buoys.push({ ...pt(b), kind: b.kind || 'special', color: b.color, shape: b.shape }); } catch { /* skip */ } }
  for (const b of geom.berths || []) { try { if (!Number.isFinite(b?.lat) || !Number.isFinite(b?.lon)) continue; S.berths.push({ ...pt(b), hdg: Number.isFinite(b.hdg) ? b.hdg : 0, name: b.name || b.id || 'Berth', id: b.id, length: b.length, depth: b.depth, kind: b.kind }); } catch { /* skip */ } }
  for (const r of (F.roads || []).slice(0, 2000)) { try { const pts = cleanLine(r?.pts, o); if (pts) S.roads.push({ pts, kind: ROAD_LOD[r.kind] ? r.kind : 'residential', width: Number.isFinite(r.width) && r.width > 0 ? Math.min(40, r.width) : null, bridge: !!r.bridge }); } catch { /* skip */ } }
  for (const a of (F.areas || []).slice(0, 600)) { try { const r = ring(a?.pts); if (r) S.areas.push({ ring: r, kind: AREA_LOD[a.kind] ? a.kind : 'industrial' }); } catch { /* skip */ } }
  for (const r of (F.rails || []).slice(0, 300)) { try { const pts = cleanLine(r?.pts, o); if (pts) S.rails.push({ pts }); } catch { /* skip */ } }
  if (geom.anchor && Number.isFinite(geom.anchor.lat)) S.anchor = pt(geom.anchor);
  return S;
}
/** Legacy fallback: a compact quay at the harbour point (ships lie alongside at the point itself). */
function legacyScene(harbor) {
  const big = harbor.size === 'mega' ? 1.5 : harbor.size === 'major' ? 1.25 : harbor.size === 'minor' ? 0.75 : 1;
  const QL = 140 * big, QW = 34, QZ = -26 - QW / 2; // quay face 26 m north of the point: the widest hull still clears it
  const quay = [{ x: -QL / 2, z: QZ - QW / 2 }, { x: QL / 2, z: QZ - QW / 2 }, { x: QL / 2, z: QZ + QW / 2 }, { x: -QL / 2, z: QZ + QW / 2 }];
  const shedW = 36 * big, shedD = 14;
  const shed = [{ x: -QL / 2 + 12, z: QZ - 12 }, { x: -QL / 2 + 12 + shedW, z: QZ - 12 }, { x: -QL / 2 + 12 + shedW, z: QZ - 12 + shedD }, { x: -QL / 2 + 12, z: QZ - 12 + shedD }];
  return {
    quays: [quay], piers: [], breakwaters: [], pontoons: [], buildings: [{ ring: shed, height: 7, kind: 'warehouse', base: QUAY_H }], tanks: [],
    cranes: big >= 1 ? [{ x: QL * 0.25, z: QZ, hdg: 180 }] : [], lights: [{ x: QL / 2 + 10, z: QZ - 4, height: 11, color: '#ffffff', period: 4 }],
    buoys: [{ x: -90, z: 110, kind: 'lateral_port' }, { x: 90, z: 110, kind: 'lateral_starboard' }],
    berths: [{ x: 0, z: QZ + QW / 2 + 12, hdg: 90, name: 'Berth 1', id: `${harbor.id}-b1` }], anchor: { x: 0, z: 0 }, fairway: [], roads: [], areas: [], rails: [],
  };
}

// ----------------------------------------------------------------------------------------------- ground
/**
 * Ground sampler in the harbour frame: (x, z) → { h (m), mask }. Uses the patch the terrain meshed for this harbour
 * (exact heights and mask), else an estimate (+1.5 m at the quays rising slowly inland; mask = land).
 */
function makeGround(geom, harbor, hardPts) {
  const id = geom?.id ?? harbor?.id;
  const e = id != null ? patchEntry(id) : null;
  const o = geom?.origin;
  if (e && o && Math.abs(e.origin.lat - o.lat) < 1e-6 && Math.abs(e.origin.lon - o.lon) < 1e-6) {
    return (x, z) => {
      const ll = fromLocal(x, z, o);
      const h = patchHeightAt(e, ll.lat, ll.lon), m = patchMaskAt(e, ll.lat, ll.lon);
      return { h: h == null ? estimateGround(x, z, hardPts) : h, mask: m == null ? MK.LAND : m };
    };
  }
  return (x, z) => ({ h: estimateGround(x, z, hardPts), mask: MK.LAND });
}
function estimateGround(x, z, hardPts) {
  let d2 = Infinity;
  for (const p of hardPts) { const dx = p.x - x, dz = p.z - z, q = dx * dx + dz * dz; if (q < d2) d2 = q; }
  const d = Math.sqrt(d2);
  return Number.isFinite(d) ? Math.min(11, 1.5 + d * 0.012) : 2;
}
/** walking-surface height: the extruded quay / pontoon tops where the mask says so, else the terrain */
function surfaceAt(ground, x, z) {
  const g = ground(x, z);
  if (g.mask === MK.QUAY) return { h: Math.max(g.h, QUAY_H), mask: g.mask };
  if (g.mask === MK.PONTOON) return { h: Math.max(g.h, PONT_H), mask: g.mask };
  if (g.mask === MK.BREAKWATER) return { h: Math.max(g.h, BW_H), mask: g.mask };
  return g;
}
const isWaterCode = (m) => m === MK.WATER || m === MK.FAIRWAY || m === MK.SHALLOW;

// ----------------------------------------------------------------------------------------------- feature renderers
/** inward unit normal of edge i of a ring (tested against the polygon so winding does not matter) */
function edgeFrames(ring) {
  const n = ring.length, out = [];
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n], dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
    if (len < 0.5) continue;
    const ux = dx / len, uz = dz / len;
    let nx = -uz, nz = ux;
    if (sign === 0) { const mx = (a.x + b.x) / 2 + nx * 1.2, mz = (a.z + b.z) / 2 + nz * 1.2; sign = pointInRing(mx, mz, ring) ? 1 : -1; }
    nx *= sign; nz *= sign;
    out.push({ ax: a.x, az: a.z, ux, uz, nx, nz, len });
  }
  return out;
}
/** walk the ring edges and call fn(x, z, ux, uz, nx, nz) every `step` metres (phase offset `off`) */
function alongEdges(frames, step, off, fn, budget) {
  if (!(step > 0)) return;
  let start = 0, next = off;
  for (const e of frames) {
    while (next < start + e.len) {
      const d = next - start;
      if (d >= 0) { fn(e.ax + e.ux * d, e.az + e.uz * d, e.ux, e.uz, e.nx, e.nz); if (--budget.left <= 0) return; }
      next += step;
    }
    start += e.len;
  }
}

function addHardRing(pb, ring, top, counters, { pier = false } = {}) {
  const geo = extrudeRing(ring, QUAY_BOTTOM, top);
  if (!geo) return;
  const [caps, walls] = splitGroups(geo);
  if (caps) pb.geo(caps, M.concrete); if (walls) pb.geo(walls, M.wall);
  const frames = edgeFrames(ring);
  // dark kerb strip along the top edge
  for (const e of frames) { const cx = e.ax + e.ux * e.len / 2 + e.nx * 0.3, cz = e.az + e.uz * e.len / 2 + e.nz * 0.3; pb.box(e.len, 0.14, 0.6, M.kerb, cx, top + 0.07, cz, 0, -Math.atan2(e.uz, e.ux), 0); }
  // bollards every 25 m, mooring rings in between, fenders every 12 m, street lamps every 60 m (quays only)
  alongEdges(frames, 25, 12.5, (x, z, ux, uz, nx, nz) => { pb.cyl(0.3, 0.9, M.bollard, x + nx * 1.1, top + 0.45, z + nz * 1.1, 0.36, 8); pb.cyl(0.42, 0.14, M.bollard, x + nx * 1.1, top + 0.95, z + nz * 1.1, 0.42, 8); }, counters.bollards);
  alongEdges(frames, 25, 0, (x, z, ux, uz, nx, nz) => { pb.geo(new THREE.TorusGeometry(0.32, 0.06, 5, 10), M.bollard, x - nx * 0.12, top - 0.6, z - nz * 0.12, 0, -Math.atan2(uz, ux), 0); }, counters.rings);
  alongEdges(frames, 12, 6, (x, z, ux, uz, nx, nz) => { pb.box(1.2, 1.8, 0.5, M.rubber, x - nx * 0.3, top - 1.0, z - nz * 0.3, 0, -Math.atan2(uz, ux), 0); }, counters.fenders);
  if (!pier) alongEdges(frames, 60, 30, (x, z, ux, uz, nx, nz) => { const lx = x + nx * 3.2, lz = z + nz * 3.2; pb.cyl(0.12, 7, M.lampPole, lx, top + 3.5, lz, 0.09, 6); pb.box(0.9, 0.3, 0.5, M.lampPole, lx - nx * 0.4, top + 7.1, lz - nz * 0.4, 0, -Math.atan2(uz, ux), 0); pb.sphere(0.22, counters.lampMat, lx - nx * 0.6, top + 6.9, lz - nz * 0.6, 6); }, counters.lamps);
}
function addBreakwater(pb, ring, counters, r) {
  const geo = extrudeRing(ring, -4, BW_H, { jitter: 0.9 });
  if (!geo) return;
  pb.geo(geo, M.rubble);
  const frames = edgeFrames(ring);
  alongEdges(frames, 6, 3, (x, z, ux, uz, nx, nz) => { const s = 0.9 + r() * 0.9; pb.geo(new THREE.DodecahedronGeometry(s, 0), M.rock, x + nx * (0.8 + r() * 2.5), BW_H - 0.3 + r() * 0.4, z + nz * (0.8 + r() * 2.5), r() * 3, r() * 3, r() * 3); }, counters.rocks);
}
function addPontoon(pb, ring, counters) {
  const geo = extrudeRing(ring, 0.1, PONT_H);
  if (!geo) return;
  pb.geo(geo, M.pontoon);
  const frames = edgeFrames(ring);
  alongEdges(frames, 10, 5, (x, z, ux, uz, nx, nz) => { pb.cyl(0.24, 4.2, M.pile, x - nx * 0.45, 0.6, z - nz * 0.45, 0.24, 7); }, counters.piles);
  alongEdges(frames, 5, 2.5, (x, z, ux, uz, nx, nz) => { pb.box(0.35, 0.12, 0.18, M.galv, x + nx * 0.25, PONT_H + 0.06, z + nz * 0.25, 0, -Math.atan2(uz, ux), 0); }, counters.cleats);
}
/** walls of a footprint from y0 to y1 with facade UVs (u along the perimeter, v up), faces pointing outwards */
function wallGeometry(ring, y0, y1, uScale, vBase, vScale) {
  const n = ring.length;
  const flip = ringArea(ring) > 0; // positive area: (-dz, dx) of each edge points inwards → reverse the edges
  const pos = [], nrm = [], uv = [];
  let cum = 0;
  for (let i = 0; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n];
    const len = Math.hypot(q.x - p.x, q.z - p.z);
    if (len < 0.05) continue;
    const uP = cum / uScale, uQ = (cum + len) / uScale; cum += len;
    const [a, b, ua, ub] = flip ? [q, p, uQ, uP] : [p, q, uP, uQ];
    const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz), nx = -dz / l, nz = dx / l;
    const v0 = (y0 - vBase) / vScale, v1 = (y1 - vBase) / vScale;
    // two triangles: (a0, b0, b1), (a0, b1, a1) — counter-clockwise seen from outside
    pos.push(a.x, y0, a.z, b.x, y0, b.z, b.x, y1, b.z, a.x, y0, a.z, b.x, y1, b.z, a.x, y1, a.z);
    for (let k = 0; k < 6; k++) nrm.push(nx, 0, nz);
    uv.push(ua, v0, ub, v0, ub, v1, ua, v0, ub, v1, ua, v1);
  }
  if (!pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}
/** flat roof cap at height y (triangulated footprint, facing up) */
function roofGeometry(ring, y) {
  const shape = new THREE.Shape();
  shape.moveTo(ring[0].x, -ring[0].z);
  for (let i = 1; i < ring.length; i++) shape.lineTo(ring[i].x, -ring[i].z);
  shape.closePath();
  const g = new THREE.ShapeGeometry(shape);
  if (!g.attributes.position || g.attributes.position.count < 3) { g.dispose(); return null; }
  g.rotateX(-Math.PI / 2); g.translate(0, y, 0);
  return g;
}
function addBuilding(pb, b, r, ground, counters) {
  const cen = ringCentroid(b.ring);
  // ground under the footprint: mean of the patch heights at the corners and the centre (walls reach 2.5 m below it)
  let base = b.base;
  if (base == null) {
    let sum = 0, cnt = 0;
    const step = Math.max(1, Math.floor(b.ring.length / 8));
    for (let i = 0; i < b.ring.length; i += step) { sum += surfaceAt(ground, b.ring[i].x, b.ring[i].z).h; cnt++; }
    sum += surfaceAt(ground, cen.x, cen.z).h; cnt++;
    base = sum / cnt;
  }
  const h = THREE.MathUtils.clamp(b.height, 3, 90);
  const top = base + h;
  const area = Math.abs(ringArea(b.ring));
  const shed = b.kind === 'warehouse' || b.kind === 'industrial';
  const { WALLS: offices, SHEDS: sheds } = wallPalettes();
  const wall = shed ? sheds[Math.floor(r() * sheds.length)] : offices[Math.floor(r() * offices.length)];
  const walls = shed ? wallGeometry(b.ring, base - 2.5, top, SHED_BAY * 4, base - 2.5, h + 2.5) : wallGeometry(b.ring, base - 2.5, top, OFFICE_BAY * 4, base, OFFICE_FLOOR * 4);
  if (!walls) return;
  pb.geo(walls, wall);
  const roofs = b.kind === 'warehouse' ? ROOFS.warehouse : b.kind === 'industrial' ? ROOFS.industrial : area < 380 ? ROOFS.small : ROOFS.large;
  const roof = roofGeometry(b.ring, top);
  if (roof) pb.geo(roof, roofs[Math.floor(r() * roofs.length)]);
  // roof edge (coping) so the roof reads as a lid, not a paper sheet
  if (counters.roofEdges.left > 0) {
    for (const e of edgeFrames(b.ring)) {
      if (counters.roofEdges.left-- <= 0) break;
      pb.box(e.len + 0.3, 0.45, 0.35, M.roofEdge, e.ax + e.ux * e.len / 2 + e.nx * 0.15, top + 0.2, e.az + e.uz * e.len / 2 + e.nz * 0.15, 0, -Math.atan2(e.uz, e.ux), 0);
    }
  }
  // roof furniture on bigger buildings
  if (area > 600 && h > 5) { pb.box(2.2 + r() * 2, 1.4, 1.6 + r(), M.galv, cen.x, top + 0.7, cen.z); if (area > 2500) pb.cyl(0.6, 2.2, M.galv, cen.x + 6, top + 1.1, cen.z - 4, 0.6, 8); }
}
function addTank(pb, t, ground) {
  const base = surfaceAt(ground, t.x, t.z).h, rad = THREE.MathUtils.clamp(t.radius, 3, 60), h = THREE.MathUtils.clamp(t.height, 3, 40);
  pb.cyl(rad, h + base + 1, M.tank, t.x, (h + base + 1) / 2 - 1, t.z, rad, 20);
  pb.cyl(rad * 1.02, 0.5, M.tankTop, t.x, base + h + 0.2, t.z, rad * 0.9, 20);
  pb.geo(new THREE.TorusGeometry(rad * 0.98, 0.18, 5, 24), M.tankTop, t.x, base + h * 0.5, t.z, Math.PI / 2, 0, 0);
  pb.cyl(0.4, h, M.galv, t.x + rad * 0.8, base + h / 2, t.z + rad * 0.6, 0.4, 6);
}
/** gantry container crane; hdg = direction the boom points (out over the water) */
function addGantryCrane(g, c, mat) {
  const cg = new THREE.Group(); cg.position.set(c.x, QUAY_H, c.z); cg.rotation.y = -(c.hdg * Math.PI) / 180;
  const pb = new PartBuilder();
  const H = 46;
  for (const x of [-12, 12]) for (const z of [-8, 8]) { pb.box(2.2, H, 2.2, mat, x, H / 2, z); }
  for (const z of [-8, 8]) { pb.box(26, 2.4, 2.4, mat, 0, H - 1.2, z); pb.box(26, 1.6, 1.6, mat, 0, 12, z); pb.rod(-12, 12, z, 12, H - 2, z, 0.35, mat, 6); }
  for (const x of [-12, 12]) pb.box(2.2, 2.4, 18, mat, x, H - 1.2, 0);
  pb.box(6, 2.4, 92, mat, 0, H + 1.2, -22); // boom: back-reach +24 → waterside −68
  pb.box(6, 1.8, 24, mat, 0, H + 1.2, 22);
  pb.box(8, 6, 10, M.craneGrey, 0, H + 5.4, 10); // machinery house
  pb.rod(0, H + 2.4, 20, 0, H + 20, 0, 0.6, mat, 6); pb.rod(0, H + 20, 0, 0, H + 2.4, -60, 0.18, M.galv, 4); pb.rod(0, H + 20, 0, 0, H + 2.4, 22, 0.18, M.galv, 4); // A-frame + stays
  pb.box(3, 2, 4, M.craneGrey, 0, H - 1.5, -34); pb.rod(0, H - 2.5, -34, 0, H - 14, -34, 0.08, M.galv, 4); pb.box(2.6, 1.0, 12.4, M.galv, 0, H - 14.5, -34); // trolley + spreader
  for (const x of [-12, 12]) for (const z of [-8, 8]) pb.box(3.2, 1.6, 3.2, M.craneGrey, x, 0.8, z);
  pb.box(0.4, 0.4, 0.4, M.red, 0, H + 21, 0);
  pb.build(cg);
  g.add(cg);
}
function addLight(g, l, counters) {
  const lg = new THREE.Group(); lg.position.set(l.x, 0, l.z);
  const pb = new PartBuilder();
  const h = THREE.MathUtils.clamp(l.height, 3, 70);
  // a light that stands in open water (fairway beacon) gets a pile base at sea level; others sit on the quay/breakwater top
  const base = l.onWater ? 0.6 : QUAY_H;
  if (l.onWater) pb.cyl(1.6, 4.6, M.pile, 0, -1.7, 0, 1.6, 10);
  const big = h > 14;
  pb.cyl(big ? 2.6 : 1.1, h, M.white, 0, base + h / 2, 0, big ? 1.7 : 0.8, 12);
  pb.cyl(big ? 1.8 : 0.9, Math.max(1, h * 0.14), M.red, 0, base + h - h * 0.07, 0, big ? 1.75 : 0.85, 12);
  pb.cyl(big ? 2.2 : 1.2, 0.4, M.galv, 0, base + h + 0.2, 0, big ? 2.2 : 1.2, 12);
  pb.cyl(big ? 1.2 : 0.7, 2.0, M.galv, 0, base + h + 1.4, 0, big ? 1.1 : 0.6, 10);
  pb.cone(big ? 1.6 : 0.9, 1.2, M.red, 0, base + h + 3.0, 0, 10);
  if (big) { for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; pb.cyl(0.07, 1.1, M.galv, Math.cos(a) * 2.1, base + h + 0.95, Math.sin(a) * 2.1, 0.07, 4); } pb.geo(new THREE.TorusGeometry(2.1, 0.06, 4, 16), M.galv, 0, base + h + 1.5, 0, Math.PI / 2, 0, 0); }
  pb.build(lg);
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xfff6d0, emissive: new THREE.Color(l.color || '#ffffff'), emissiveIntensity: 0.6, roughness: 0.3 });
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(big ? 0.9 : 0.5, 10, 8), lampMat); lamp.position.set(0, base + h + 1.4, 0); lg.add(lamp);
  g.add(lg);
  counters.lights.push({ mat: lampMat, period: l.period > 0 ? l.period : 0, phase: (l.x * 0.37 + l.z * 0.11) % 1, pos: new THREE.Vector3(l.x, base + h + 1.4, l.z) });
}
/** IALA buoy: float/body by shape, colour bands and topmark by kind. Returns a group (bobbed by updateBuoys). */
function addBuoy(g, b) {
  const bg = new THREE.Group(); bg.position.set(b.x, 0, b.z);
  const pb = new PartBuilder();
  const kind = b.kind || 'special';
  const col = (hex) => { if (!hex) return null; const m = new THREE.MeshStandardMaterial({ color: new THREE.Color(hex), roughness: 0.6 }); return m; };
  const custom = b.color && !/lateral|cardinal|safe|isolated/.test(kind) ? col(b.color) : null;
  const bands = { lateral_port: [M.red], lateral_starboard: [M.green], cardinal_n: [M.yellow, M.black], cardinal_s: [M.black, M.yellow], cardinal_e: [M.black, M.yellow, M.black], cardinal_w: [M.yellow, M.black, M.yellow], safe_water: [M.red, M.white], isolated_danger: [M.black, M.red, M.black], special: [custom || M.yellow] }[kind] || [custom || M.yellow];
  const shape = b.shape || { lateral_port: 'can', lateral_starboard: 'cone', safe_water: 'sphere', special: 'can' }[kind] || 'pillar';
  const bodyH = shape === 'spar' ? 5 : shape === 'pillar' ? 4.5 : 2.4;
  // float + body in bands (bottom → top)
  pb.cyl(1.4, 0.7, M.black, 0, 0.1, 0, 1.4, 12);
  const n = bands.length;
  for (let i = 0; i < n; i++) {
    const y0 = 0.45 + (bodyH * i) / n, hh = bodyH / n, mat = bands[i];
    if (shape === 'can') pb.cyl(1.0, hh, mat, 0, y0 + hh / 2, 0, 1.0, 12);
    else if (shape === 'cone') pb.cyl(1.1 - (1.1 * i) / n, hh, mat, 0, y0 + hh / 2, 0, Math.max(0.15, 1.1 - (1.1 * (i + 1)) / n), 12);
    else if (shape === 'sphere') pb.sphere(1.2, mat, 0, 1.6, 0, 12);
    else if (shape === 'spar') pb.cyl(0.35, hh, mat, 0, y0 + hh / 2, 0, 0.3, 8);
    else { if (i === 0) pb.cyl(1.2, 1.0, mat, 0, 0.95, 0, 1.2, 12); for (let k = 0; k < 4; k++) { const a = (k / 4) * Math.PI * 2 + Math.PI / 4; pb.rod(Math.cos(a) * 0.9, 0.5 + (i === 0 ? 0.9 : y0), Math.sin(a) * 0.9, Math.cos(a) * 0.5, y0 + hh, Math.sin(a) * 0.5, 0.06, mat, 4); } }
    if (shape === 'sphere') break;
  }
  const topY = shape === 'sphere' ? 2.9 : 0.5 + bodyH + 0.2;
  // topmarks
  if (kind.startsWith('cardinal')) {
    const up = (y) => pb.cone(0.5, 0.9, M.black, 0, y, 0, 8), down = (y) => pb.cone(0.5, 0.9, M.black, 0, y, 0, 8, Math.PI, 0, 0);
    if (kind === 'cardinal_n') { up(topY + 0.5); up(topY + 1.6); } else if (kind === 'cardinal_s') { down(topY + 0.5); down(topY + 1.6); }
    else if (kind === 'cardinal_e') { down(topY + 0.5); up(topY + 1.6); } else { up(topY + 0.5); down(topY + 1.6); }
    pb.cyl(0.05, 2.2, M.galv, 0, topY + 1.0, 0, 0.05, 4);
  } else if (kind === 'isolated_danger') { pb.sphere(0.45, M.black, 0, topY + 0.5, 0, 8); pb.sphere(0.45, M.black, 0, topY + 1.5, 0, 8); pb.cyl(0.05, 2.0, M.galv, 0, topY + 1.0, 0, 0.05, 4); }
  else if (kind === 'safe_water') { pb.sphere(0.5, M.red, 0, topY + 0.6, 0, 8); }
  else if (kind === 'lateral_port' && shape !== 'can') { pb.cyl(0.45, 0.8, M.red, 0, topY + 0.5, 0, 0.45, 8); }
  else if (kind === 'lateral_starboard' && shape !== 'cone') { pb.cone(0.5, 0.9, M.green, 0, topY + 0.5, 0, 8); }
  else if (kind === 'special') { pb.box(1.0, 0.18, 0.18, M.yellow, 0, topY + 0.6, 0, 0, 0, Math.PI / 4); pb.box(1.0, 0.18, 0.18, M.yellow, 0, topY + 0.6, 0, 0, 0, -Math.PI / 4); }
  pb.build(bg);
  const lightCol = kind === 'lateral_port' ? 0xff3030 : kind === 'lateral_starboard' ? 0x30ff50 : kind === 'special' ? 0xffd040 : 0xffffff;
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), new THREE.MeshStandardMaterial({ color: lightCol, emissive: lightCol, emissiveIntensity: 1.2 }));
  lamp.position.set(0, topY + (kind.startsWith('cardinal') || kind === 'isolated_danger' ? 2.4 : 1.2), 0); bg.add(lamp);
  bg.userData.phase = (b.x * 0.013 + b.z * 0.021) % (Math.PI * 2); bg.userData.lamp = lamp; bg.userData.kind = kind;
  g.add(bg);
  return bg;
}
function addBerthBoard(g, berth, hardRings) {
  const hdg = (berth.hdg * Math.PI) / 180, ux = Math.sin(hdg), uz = -Math.cos(hdg);
  const cands = [[-uz, ux], [uz, -ux]];
  let nx = cands[0][0], nz = cands[0][1], found = false;
  for (const [cx, cz] of cands) { const px = berth.x + cx * 13.5, pz = berth.z + cz * 13.5; if (hardRings.some((r) => pointInRing(px, pz, r))) { nx = cx; nz = cz; found = true; break; } }
  if (!found) { nx = cands[0][0]; nz = cands[0][1]; }
  const bx = berth.x + nx * 14.6, bz = berth.z + nz * 14.6, top = berth.kind === 'pontoon' ? PONT_H : QUAY_H;
  const num = (String(berth.name || '').match(/\d+/) || [String(berth.id || '').replace(/.*-b?/, '')])[0] || '?';
  const tex = textTexture(num, { sub: berth.name && /\d/.test(berth.name) ? null : berth.name });
  const board = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.6), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, side: THREE.DoubleSide }));
  board.position.set(bx, top + 3.3, bz); board.rotation.y = Math.atan2(-nx, -nz); // face the water (-n)
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 3.2, 6), M.lampPole); post.position.set(bx, top + 1.6, bz);
  g.add(board, post);
  return board;
}
function addContainerStacks(pb, ring, r, counters) {
  const area = Math.abs(ringArea(ring)); if (area < 6000 || counters.containers.left <= 0) return;
  const bb = ringBBox(ring), frames = edgeFrames(ring);
  const want = Math.min(counters.containers.left, Math.max(2, Math.round(area / 5000)));
  let placed = 0;
  for (let tries = 0; tries < want * 10 && placed < want; tries++) {
    const x = bb.x0 + r() * (bb.x1 - bb.x0), z = bb.z0 + r() * (bb.z1 - bb.z0);
    if (!pointInRing(x, z, ring)) continue;
    let near = null, nd = Infinity;
    for (const e of frames) { const t = THREE.MathUtils.clamp(((x - e.ax) * e.ux + (z - e.az) * e.uz), 0, e.len); const dx = x - (e.ax + e.ux * t), dz = z - (e.az + e.uz * t), d = Math.hypot(dx, dz); if (d < nd) { nd = d; near = e; } }
    if (nd < 9 || !near) continue;
    const ry = -Math.atan2(near.uz, near.ux);
    const tiers = 1 + Math.floor(r() * 3), cols = 1 + Math.floor(r() * 3);
    for (let c = 0; c < cols; c++) for (let t = 0; t < tiers; t++) { const ox = -near.nx * c * 2.7, oz = -near.nz * c * 2.7; pb.box(12.2, 2.59, 2.44, CONT[Math.floor(r() * CONT.length)], x + ox, QUAY_H + 1.3 + t * 2.59, z + oz, 0, ry, 0); }
    placed++;
  }
  counters.containers.left -= placed;
}

// ----------------------------------------------------------------------------------------------- street layer (far LOD)
/** road kinds → default width (m), lift above the ground (m) and colour; draw order follows the lift */
const ROAD_LOD = {
  motorway: { w: 14, y: 0.42, c: 0x4a4d52 }, primary: { w: 10, y: 0.4, c: 0x4f5256 }, secondary: { w: 8, y: 0.39, c: 0x55585c },
  tertiary: { w: 7, y: 0.38, c: 0x5a5d61 }, residential: { w: 6, y: 0.37, c: 0x606367 }, service: { w: 4.5, y: 0.36, c: 0x696b6e },
  footway: { w: 2.5, y: 0.35, c: 0x9d968a }, track: { w: 3, y: 0.34, c: 0x8b7d65 },
};
const AREA_LOD = {
  grass: { c: 0x6f9c46, y: 0.22 }, park: { c: 0x5e9a40, y: 0.24 }, wood: { c: 0x4b7234, y: 0.26 }, sand: { c: 0xdcc99c, y: 0.2 },
  industrial: { c: 0x8c8780, y: 0.14 }, residential: { c: 0xa69e91, y: 0.12 }, port: { c: 0x8b8882, y: 0.16 }, parking: { c: 0x5a5d61, y: 0.28 },
};
const RAIL_LOD = { w: 3.2, y: 0.45, c: 0x5e5850, steel: 0x8f9499 };
let _lodMats = null;
function lodMaterials() {
  if (!_lodMats) {
    const mk = (factor, units) => { const m = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: factor, polygonOffsetUnits: units }); m.userData.shared = true; return m; };
    _lodMats = { areas: mk(-1, -4), roads: mk(-2, -8) };
  }
  return _lodMats;
}
/** collects flat triangles (x, y, z) with a colour; emits one non-indexed geometry with up-facing normals */
class FlatBuilder {
  constructor() { this.pos = []; this.col = []; this.c = new THREE.Color(); }
  tri(a, b, c, hex) {
    // keep every triangle counter-clockwise seen from above (normal +y)
    const cross = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
    if (cross > 0) [b, c] = [c, b];
    this.pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    this.c.setHex(hex);
    for (let k = 0; k < 3; k++) this.col.push(this.c.r, this.c.g, this.c.b);
  }
  build(mat) {
    if (!this.pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    const n = new Float32Array(this.pos.length); for (let i = 1; i < n.length; i += 3) n[i] = 1;
    g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat);
    m.frustumCulled = true;
    return m;
  }
}
/** land-use polygons: triangulated, big triangles split so the flat follows the ground */
function addAreas(fb, areas, ground) {
  let budget = 60000;
  for (const a of areas) {
    const st = AREA_LOD[a.kind] || AREA_LOD.industrial;
    let tris;
    try {
      const contour = a.ring.map((p) => new THREE.Vector2(p.x, p.z));
      tris = THREE.ShapeUtils.triangulateShape(contour, []).map(([i, j, k]) => [a.ring[i], a.ring[j], a.ring[k]]);
    } catch { continue; }
    const out = [];
    const split = (t, depth) => {
      const [p, q, r] = t;
      const lpq = Math.hypot(p.x - q.x, p.z - q.z), lqr = Math.hypot(q.x - r.x, q.z - r.z), lrp = Math.hypot(r.x - p.x, r.z - p.z);
      if (depth >= 6 || Math.max(lpq, lqr, lrp) <= 30) { out.push(t); return; }
      if (lpq >= lqr && lpq >= lrp) { const m = { x: (p.x + q.x) / 2, z: (p.z + q.z) / 2 }; split([p, m, r], depth + 1); split([m, q, r], depth + 1); }
      else if (lqr >= lrp) { const m = { x: (q.x + r.x) / 2, z: (q.z + r.z) / 2 }; split([p, q, m], depth + 1); split([p, m, r], depth + 1); }
      else { const m = { x: (r.x + p.x) / 2, z: (r.z + p.z) / 2 }; split([p, q, m], depth + 1); split([m, q, r], depth + 1); }
    };
    for (const t of tris) split(t, 0);
    const hc = new Map();
    const lift = (p) => { const k = `${p.x.toFixed(2)},${p.z.toFixed(2)}`; let v = hc.get(k); if (!v) { const g = surfaceAt(ground, p.x, p.z); v = { x: p.x, y: Math.max(0.05, g.h) + st.y, z: p.z, wet: isWaterCode(g.mask) }; hc.set(k, v); } return v; };
    for (const t of out) {
      if (--budget <= 0) return;
      const a = lift(t[0]), b = lift(t[1]), c = lift(t[2]);
      if (a.wet || b.wet || c.wet) continue; // land use never paints over a basin
      fb.tri(a, b, c, st.c);
    }
  }
}
/** a ribbon of half-width hw along a polyline, resampled every ≤ step m, on the ground (+lift); water gaps skipped
 *  unless `bridge` (deck interpolated between the banks, at least 5 m above the water) */
function addRibbon(fb, pts, hw, lift, hex, ground, bridge, step = 20) {
  const S = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1], L = Math.hypot(b.x - a.x, b.z - a.z);
    if (L < 0.01) continue;
    const k = Math.max(1, Math.ceil(L / step));
    for (let s = S.length ? 1 : 0; s <= k; s++) S.push({ x: a.x + ((b.x - a.x) * s) / k, z: a.z + ((b.z - a.z) * s) / k });
  }
  if (S.length < 2) return;
  for (const p of S) { const g = surfaceAt(ground, p.x, p.z); p.h = g.h; p.wet = isWaterCode(g.mask); }
  if (bridge) {
    // deck over the wet run: linear between the dry ends, never lower than 5 m
    let i = 0;
    while (i < S.length) {
      if (!S[i].wet) { i++; continue; }
      let j = i; while (j < S.length && S[j].wet) j++;
      const h0 = i > 0 ? S[i - 1].h : j < S.length ? S[j].h : 5, h1 = j < S.length ? S[j].h : h0;
      for (let k = i; k < j; k++) { const t = (k - i + 1) / (j - i + 1); S[k].h = Math.max(5, h0 + (h1 - h0) * t); S[k].wet = false; }
      i = j;
    }
  }
  // mitred left normals
  for (let i = 0; i < S.length; i++) {
    const p = S[Math.max(0, i - 1)], q = S[Math.min(S.length - 1, i + 1)];
    let tx = q.x - p.x, tz = q.z - p.z; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    S[i].nx = tz; S[i].nz = -tx;
  }
  for (let i = 0; i + 1 < S.length; i++) {
    const a = S[i], b = S[i + 1];
    if (a.wet || b.wet) continue;
    const ya = Math.max(0.05, a.h) + lift, yb = Math.max(0.05, b.h) + lift;
    const al = { x: a.x + a.nx * hw, y: ya, z: a.z + a.nz * hw }, ar = { x: a.x - a.nx * hw, y: ya, z: a.z - a.nz * hw };
    const bl = { x: b.x + b.nx * hw, y: yb, z: b.z + b.nz * hw }, br = { x: b.x - b.nx * hw, y: yb, z: b.z - b.nz * hw };
    fb.tri(al, ar, bl, hex); fb.tri(ar, br, bl, hex);
  }
}
/** far-LOD street layer: { group, areas, roads } or null when the geometry has no street data */
function buildStreetsLod(S, ground) {
  if (!S.roads.length && !S.areas.length && !S.rails.length) return null;
  const mats = lodMaterials();
  const group = new THREE.Group(); group.name = 'streets-lod';
  const fa = new FlatBuilder();
  addAreas(fa, S.areas, ground);
  const areas = fa.build(mats.areas);
  if (areas) { areas.renderOrder = 0; group.add(areas); }
  const fr = new FlatBuilder();
  // wide classes first so junctions of narrow roads draw on top of the main road
  const roads = [...S.roads].sort((a, b) => (ROAD_LOD[a.kind].y - ROAD_LOD[b.kind].y));
  for (const r of roads) { const st = ROAD_LOD[r.kind]; addRibbon(fr, r.pts, (r.width || st.w) / 2, st.y, st.c, ground, r.bridge); }
  for (const r of S.rails) { addRibbon(fr, r.pts, RAIL_LOD.w / 2, RAIL_LOD.y, RAIL_LOD.c, ground, false); for (const off of [-0.72, 0.72]) addRibbon(fr, offsetLine(r.pts, off), 0.09, RAIL_LOD.y + 0.12, RAIL_LOD.steel, ground, false); }
  const roadMesh = fr.build(mats.roads);
  if (roadMesh) { roadMesh.renderOrder = 0; group.add(roadMesh); }
  return { group, areas, roads: roadMesh };
}
function offsetLine(pts, d) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[Math.max(0, i - 1)], q = pts[Math.min(pts.length - 1, i + 1)];
    let tx = q.x - p.x, tz = q.z - p.z; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    out.push({ x: pts[i].x + tz * d, z: pts[i].z - tx * d });
  }
  return out;
}

// ----------------------------------------------------------------------------------------------- buildHarbor
/** @param harbor {id,name,country,size,lat,lon} @param geom geometry JSON (§1) or null / legacy OSM array → compact fallback */
export function buildHarbor(harbor, geom) {
  const g = new THREE.Group();
  const r = rng(hashStr(String(harbor?.id || harbor?.name || 'harbour')));
  const valid = geom && !Array.isArray(geom) && geom.origin && Number.isFinite(geom.origin.lat) && (geom.features || geom.berths);
  let S;
  try { S = valid ? sceneFromGeom(geom) : legacyScene(harbor || {}); } catch (e) { console.warn('[harbor] geometry rejected, using fallback', e); S = legacyScene(harbor || {}); }
  const pb = new PartBuilder();
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xfff1a8, emissive: 0xffd080, emissiveIntensity: 0.3 });
  const counters = { bollards: { left: CAPS.bollards }, fenders: { left: CAPS.fenders }, rings: { left: CAPS.rings }, lamps: { left: CAPS.lamps }, rocks: { left: CAPS.rocks }, piles: { left: 1200 }, cleats: { left: 1500 }, roofEdges: { left: CAPS.roofEdges }, containers: { left: CAPS.containers }, lights: [], lampMat };
  const hardRings = [...S.quays, ...S.piers, ...S.pontoons];
  const hardPts = []; for (const ring of [...S.quays, ...S.piers]) for (let i = 0; i < ring.length; i += 2) hardPts.push(ring[i]);
  const ground = valid ? makeGround(geom, harbor, hardPts) : (x, z) => ({ h: estimateGround(x, z, hardPts), mask: MK.LAND });
  for (const ring of S.quays) { try { addHardRing(pb, ring, QUAY_H, counters); addContainerStacks(pb, ring, r, counters); } catch (e) { console.warn('[harbor] quay skipped', e); } }
  for (const ring of S.piers) { try { addHardRing(pb, ring, QUAY_H, counters, { pier: true }); } catch (e) { console.warn('[harbor] pier skipped', e); } }
  for (const ring of S.breakwaters) { try { addBreakwater(pb, ring, counters, r); } catch (e) { console.warn('[harbor] breakwater skipped', e); } }
  for (const ring of S.pontoons) { try { addPontoon(pb, ring, counters); } catch (e) { console.warn('[harbor] pontoon skipped', e); } }
  for (const b of S.buildings) {
    try {
      if (b.kind === 'tank') { const c = ringCentroid(b.ring); let rad = 0; for (const p of b.ring) rad += Math.hypot(p.x - c.x, p.z - c.z); addTank(pb, { x: c.x, z: c.z, radius: rad / b.ring.length, height: b.height }, ground); }
      else addBuilding(pb, b, r, ground, counters);
    } catch (e) { console.warn('[harbor] building skipped', e); }
  }
  for (const t of S.tanks) { try { addTank(pb, t, ground); } catch (e) { console.warn('[harbor] tank skipped', e); } }
  pb.build(g);
  const craneMat = r() < 0.5 ? M.craneRed : M.craneBlue;
  for (const c of S.cranes.slice(0, 14)) { try { addGantryCrane(g, c, craneMat); } catch (e) { console.warn('[harbor] crane skipped', e); } }
  for (const l of S.lights.slice(0, 40)) {
    try {
      const onStructure = hardRings.some((ring) => pointInRing(l.x, l.z, ring)) || S.breakwaters.some((ring) => pointInRing(l.x, l.z, ring));
      addLight(g, { ...l, onWater: !onStructure && valid }, counters);
    } catch (e) { console.warn('[harbor] light skipped', e); }
  }
  const buoys = [];
  for (const b of S.buoys.slice(0, 80)) { try { buoys.push(addBuoy(g, b)); } catch (e) { console.warn('[harbor] buoy skipped', e); } }
  for (const b of S.berths.slice(0, 40)) { try { addBerthBoard(g, b, hardRings); } catch (e) { console.warn('[harbor] berth board skipped', e); } }
  // street layer as a far LOD (hidden while ashore; the land-use flats step aside once the map drape shows)
  let streets = null;
  try { streets = buildStreetsLod(S, ground); } catch (e) { console.warn('[harbor] street layer skipped', e); streets = null; }
  if (streets) g.add(streets.group);
  // harbour name: the FIRST sprite child (main.js toggles it by camera distance). A real sign is ~6 m tall; far away the
  // board keeps 30–44 px so it stays readable without towering over the port.
  const label = makeLabel(`${harbor?.name || 'Harbour'}${harbor?.country ? ` (${harbor.country})` : ''}`, '#ffd877', 34, { height: 6, minPx: 30, maxPx: 44 });
  label.position.set(S.anchor ? S.anchor.x * 0.3 : 0, 34, S.anchor ? S.anchor.z * 0.3 : 0); g.add(label);
  const lights = counters.lights;
  const harborId = geom?.id ?? harbor?.id;
  let ashore = false;
  g.userData.harbor = harbor; g.userData.geom = valid ? geom : null; g.userData.label = label;
  g.userData.buoys = buoys; g.userData.streets = streets;
  g.userData.lampPos = lights.length ? lights[0].pos.clone() : null;
  const syncStreets = () => {
    if (!streets) return;
    streets.group.visible = !ashore;
    if (streets.areas) streets.areas.visible = !ashore && drapeState(harborId).state !== 'ready';
  };
  /** ashore.js: true while the detailed on-foot street world is built on top (the far LOD steps aside) */
  g.userData.setAshore = (on) => { ashore = !!on; syncStreets(); };
  /** night 0..1, time (s): light towers flash with their period, windows and street lamps glow */
  g.userData.setNight = (night, time = 0) => {
    const n = THREE.MathUtils.clamp(night, 0, 1);
    for (const m of WALL_MATS) m.emissiveIntensity = 1.5 * n;
    lampMat.emissiveIntensity = 0.3 + 3.5 * n;
    for (const l of lights) {
      const on = l.period > 0 ? ((time / l.period + l.phase) % 1) < 0.28 : true;
      l.mat.emissiveIntensity = on ? 0.6 + 5 * n : 0.08;
    }
    for (const b of buoys) if (b.userData.lamp) b.userData.lamp.material.emissiveIntensity = 0.3 + 2.5 * n * (((time * 0.7 + b.userData.phase) % 1) < 0.5 ? 1 : 0.15);
    syncStreets();
  };
  /** buoys ride the sea surface (tide + waves) with a little extra bob and tilt */
  g.userData.updateBuoys = (time) => {
    for (const b of buoys) {
      const wx = g.position.x + b.position.x, wz = g.position.z + b.position.z;
      const y = surfaceHeightAt(wx, wz, time);
      b.position.y = y - 0.25 + 0.12 * Math.sin(time * 1.3 + b.userData.phase);
      b.rotation.x = 0.06 * Math.sin(time * 0.9 + b.userData.phase); b.rotation.z = 0.06 * Math.cos(time * 1.1 + b.userData.phase * 1.7);
    }
  };
  g.userData.dispose = () => { lampMat.dispose(); for (const l of lights) l.mat.dispose(); disposeGroup(g); };
  syncStreets();
  return g;
}

export function buildFishingMarker(ground) {
  const g = new THREE.Group();
  const pb = new PartBuilder();
  const mat = new THREE.MeshStandardMaterial({ color: 0xffa726, roughness: 0.6 });
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; pb.sphere(2, mat, Math.cos(a) * 120, 1, Math.sin(a) * 120, 8); pb.cyl(0.2, 3, mat, Math.cos(a) * 120, 3, Math.sin(a) * 120, 0.2, 6); }
  pb.build(g);
  const l = makeLabel(`Fishing ground: ${ground?.name || ''}`, '#9ad7ff', 30, { height: 5, minPx: 26, maxPx: 36 }); l.position.set(0, 14, 0); g.add(l);
  g.userData.dispose = () => disposeGroup(g);
  return g;
}
