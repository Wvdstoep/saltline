// Harbour scenery from the server's geometry JSON (docs/V3-CONTRACTS.md §1): extruded quays and piers with bollards,
// fenders, mooring rings and a dark kerb, rubble breakwaters, floating pontoons on piles, extruded buildings with
// emissive window strips at night, storage tanks, gantry cranes, light towers that flash with their period, IALA buoys
// that ride the sea (userData.updateBuoys), berth number boards, street lamps, container stacks and the harbour name.
// Rings arrive in lat/lon and are converted with toLocal(lat, lon, geom.origin); main.js places the group at the origin.
// Without geometry (geom null / legacy OSM array) a compact quay at the harbour point is built instead — never a
// floating platform. Everything static is merged per material (models.js PartBuilder); userData.dispose() frees it all
// except the shared module palette.
import * as THREE from 'three';
import { toLocal } from '/shared/geo.js';
import { makeLabel, disposeGroup, buildPlatform } from './ship.js';
import { PartBuilder, hashStr, rng, cleanRing, ringArea, pointInRing, ringCentroid, ringBBox, extrudeRing, splitGroups, textTexture } from './models.js';
import { surfaceHeightAt } from './ocean.js';

export { buildPlatform };

// ----------------------------------------------------------------------------------------------- shared palette
const std = (color, extra = {}) => { const m = new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0.05, ...extra }); m.userData.shared = true; return m; };
const M = {
  concrete: std(0x8e8b84, { roughness: 0.95 }), wall: std(0x5f5c57, { roughness: 0.95 }), kerb: std(0x3d3b38), asphalt: std(0x4c4f52),
  rubble: std(0x5a5650, { roughness: 1 }), rock: std(0x4e4a45, { roughness: 1 }), pontoon: std(0xb9b2a4, { roughness: 0.8 }), pile: std(0x3a3632),
  steel: std(0x3b4a5a, { roughness: 0.6, metalness: 0.5 }), galv: std(0x9aa3ab, { roughness: 0.5, metalness: 0.6 }), rubber: std(0x15171a, { roughness: 1 }), bollard: std(0x1e2126, { roughness: 0.7, metalness: 0.4 }),
  craneRed: std(0xc8382b, { roughness: 0.6, metalness: 0.3 }), craneBlue: std(0x2457a8, { roughness: 0.6, metalness: 0.3 }), craneGrey: std(0x6f7781, { roughness: 0.6, metalness: 0.4 }),
  white: std(0xf2f2ee, { roughness: 0.7 }), red: std(0xd32f2f, { roughness: 0.6 }), green: std(0x2e7d32, { roughness: 0.6 }), yellow: std(0xf2c230, { roughness: 0.6 }), black: std(0x15161a, { roughness: 0.7 }),
  roof: std(0x4a4f55, { roughness: 0.95 }), tank: std(0xdcdcd6, { roughness: 0.55, metalness: 0.3 }), tankTop: std(0x8d9196, { roughness: 0.6, metalness: 0.3 }),
  lampPole: std(0x3a3f45, { roughness: 0.6, metalness: 0.5 }), board: std(0x10243f, { roughness: 0.6 }),
};
const WALLS = [std(0x9aa5ad), std(0xb8c0c5), std(0x7d8a93), std(0xc9a86a), std(0x6f8fa3), std(0xa3b1a0), std(0xd9d2c3), std(0x8c8378)];
const INDUSTRIAL = [std(0x6a6f74), std(0x5b5650), std(0x7a6e62), std(0x4f5b66)];
const CONT = [0xc0392b, 0x2980b9, 0x27ae60, 0xf39c12, 0x7f8c8d, 0xd35400].map((c) => std(c, { roughness: 0.7 }));

const QUAY_H = 2.65, BW_H = 3.6, PONT_H = 0.7, QUAY_BOTTOM = -3;
const CAPS = { bollards: 1500, fenders: 2500, rings: 1500, lamps: 250, rocks: 700, windows: 2600, buildings: 320, containers: 70 };

// ----------------------------------------------------------------------------------------------- scene description
/** Converts the geometry JSON into local-frame rings and points. Every feature is cleaned/validated; bad ones are skipped. */
function sceneFromGeom(geom) {
  const o = geom.origin, F = geom.features || {};
  const ring = (pts) => { if (!Array.isArray(pts)) return null; const loc = []; for (const p of pts) { if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue; const l = toLocal(p[0], p[1], o); loc.push({ x: l.x, z: l.z }); } return cleanRing(loc); };
  const pt = (f) => { const l = toLocal(f.lat, f.lon, o); return { x: l.x, z: l.z }; };
  const rings = (list) => { const out = []; for (const f of list || []) { try { const r = ring(f?.pts); if (r) out.push(r); } catch { /* skip */ } } return out; };
  const S = { quays: rings(F.quays), piers: rings(F.piers), breakwaters: rings(F.breakwaters), pontoons: rings(F.pontoons), buildings: [], tanks: [], cranes: [], lights: [], buoys: [], berths: [], anchor: null, fairway: [] };
  for (const b of (F.buildings || []).slice(0, CAPS.buildings)) { try { const r = ring(b?.pts); if (!r) continue; S.buildings.push({ ring: r, height: Number.isFinite(b.height) ? b.height : 8, kind: b.kind || 'building', base: Number.isFinite(b.base) ? b.base : null }); } catch { /* skip */ } }
  for (const t of F.tanks || []) { try { if (!Number.isFinite(t?.lat) || !Number.isFinite(t?.lon)) continue; S.tanks.push({ ...pt(t), radius: Number.isFinite(t.radius) ? t.radius : 12, height: Number.isFinite(t.height) ? t.height : 12 }); } catch { /* skip */ } }
  for (const c of F.cranes || []) { try { if (!Number.isFinite(c?.lat) || !Number.isFinite(c?.lon)) continue; S.cranes.push({ ...pt(c), hdg: Number.isFinite(c.hdg) ? c.hdg : 0 }); } catch { /* skip */ } }
  for (const l of F.lights || []) { try { if (!Number.isFinite(l?.lat) || !Number.isFinite(l?.lon)) continue; S.lights.push({ ...pt(l), height: Number.isFinite(l.height) ? l.height : 12, color: l.color || '#ffffff', period: Number.isFinite(l.period) ? l.period : 0 }); } catch { /* skip */ } }
  for (const b of F.buoys || []) { try { if (!Number.isFinite(b?.lat) || !Number.isFinite(b?.lon)) continue; S.buoys.push({ ...pt(b), kind: b.kind || 'special', color: b.color, shape: b.shape }); } catch { /* skip */ } }
  for (const b of geom.berths || []) { try { if (!Number.isFinite(b?.lat) || !Number.isFinite(b?.lon)) continue; S.berths.push({ ...pt(b), hdg: Number.isFinite(b.hdg) ? b.hdg : 0, name: b.name || b.id || 'Berth', id: b.id, length: b.length, depth: b.depth, kind: b.kind }); } catch { /* skip */ } }
  if (geom.anchor && Number.isFinite(geom.anchor.lat)) S.anchor = pt(geom.anchor);
  return S;
}
/** Legacy fallback: a compact quay at the harbour point (ships lie alongside at the point itself). */
function legacyScene(harbor) {
  const big = harbor.size === 'mega' ? 1.5 : harbor.size === 'major' ? 1.25 : harbor.size === 'minor' ? 0.75 : 1;
  const QL = 140 * big, QW = 34, QZ = -14 - QW / 2;
  const quay = [{ x: -QL / 2, z: QZ - QW / 2 }, { x: QL / 2, z: QZ - QW / 2 }, { x: QL / 2, z: QZ + QW / 2 }, { x: -QL / 2, z: QZ + QW / 2 }];
  const shedW = 36 * big, shedD = 14;
  const shed = [{ x: -QL / 2 + 12, z: QZ - 12 }, { x: -QL / 2 + 12 + shedW, z: QZ - 12 }, { x: -QL / 2 + 12 + shedW, z: QZ - 12 + shedD }, { x: -QL / 2 + 12, z: QZ - 12 + shedD }];
  return {
    quays: [quay], piers: [], breakwaters: [], pontoons: [], buildings: [{ ring: shed, height: 7, kind: 'warehouse', base: 0 }], tanks: [],
    cranes: big >= 1 ? [{ x: QL * 0.25, z: QZ, hdg: 180 }] : [], lights: [{ x: QL / 2 + 10, z: QZ - 4, height: 11, color: '#ffffff', period: 4 }],
    buoys: [{ x: -90, z: 110, kind: 'lateral_port' }, { x: 90, z: 110, kind: 'lateral_starboard' }],
    berths: [{ x: 0, z: QZ + QW / 2 + 12, hdg: 90, name: 'Berth 1', id: `${harbor.id}-b1` }], anchor: { x: 0, z: 0 }, fairway: [],
  };
}

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
  let acc = -off, used = 0;
  for (const e of frames) {
    let d = acc;
    while (d + step <= e.len || (d <= e.len && d >= 0 && step <= 0)) {
      d += step; if (d < 0) continue; if (d > e.len) break;
      fn(e.ax + e.ux * d, e.az + e.uz * d, e.ux, e.uz, e.nx, e.nz);
      if (++used >= budget.left) { budget.left = 0; return used; }
    }
    acc = d - e.len;
  }
  budget.left -= used;
  return used;
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
/** estimated ground height under a footprint: +1.5 m at the quays rising slowly inland (buildings are vectors, the raster is C3's) */
function groundAt(x, z, hardPts) {
  let d2 = Infinity;
  for (const p of hardPts) { const dx = p.x - x, dz = p.z - z, q = dx * dx + dz * dz; if (q < d2) d2 = q; }
  const d = Math.sqrt(d2);
  return Number.isFinite(d) ? Math.min(11, 1.5 + d * 0.012) : 2;
}
function addBuilding(pb, b, r, hardPts, counters) {
  const base = b.base ?? groundAt(...(() => { const c = ringCentroid(b.ring); return [c.x, c.z]; })(), hardPts);
  const h = THREE.MathUtils.clamp(b.height, 3, 90);
  const top = base + h;
  const geo = extrudeRing(b.ring, -2, top);
  if (!geo) return;
  const [caps, walls] = splitGroups(geo);
  const wall = b.kind === 'industrial' ? INDUSTRIAL[Math.floor(r() * INDUSTRIAL.length)] : WALLS[Math.floor(r() * WALLS.length)];
  if (caps) pb.geo(caps, M.roof); if (walls) pb.geo(walls, wall);
  // roof furniture on bigger buildings
  const area = Math.abs(ringArea(b.ring));
  if (area > 600 && h > 5) { const c = ringCentroid(b.ring); pb.box(2.2 + r() * 2, 1.4, 1.6 + r(), M.galv, c.x, top + 0.7, c.z); if (area > 2500) pb.cyl(0.6, 2.2, M.galv, c.x + 6, top + 1.1, c.z - 4, 0.6, 8); }
  // window strips per floor on long walls
  if (h >= 5 && counters.windows.left > 0) {
    const frames = edgeFrames(b.ring);
    const floors = Math.min(12, Math.floor((h - 1.2) / 3.3));
    for (const e of frames) {
      if (e.len < 9) continue;
      const cx = e.ax + e.ux * e.len / 2 - e.nx * 0.09, cz = e.az + e.uz * e.len / 2 - e.nz * 0.09, ry = -Math.atan2(e.uz, e.ux);
      for (let f = 0; f < floors; f++) {
        if (counters.windows.left <= 0) return;
        pb.box(e.len * 0.72, 0.9, 0.08, counters.windowMat, cx, base + 1.9 + f * 3.3, cz, 0, ry, 0);
        counters.windows.left--;
      }
    }
  }
}
function addTank(pb, t, hardPts) {
  const base = groundAt(t.x, t.z, hardPts), rad = THREE.MathUtils.clamp(t.radius, 3, 60), h = THREE.MathUtils.clamp(t.height, 3, 40);
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
  const base = l.onWater ? 0 : QUAY_H;
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

// ----------------------------------------------------------------------------------------------- buildHarbor
/** @param harbor {id,name,country,size,lat,lon} @param geom geometry JSON (§1) or null / legacy OSM array → compact fallback */
export function buildHarbor(harbor, geom) {
  const g = new THREE.Group();
  const r = rng(hashStr(String(harbor?.id || harbor?.name || 'harbour')));
  const valid = geom && !Array.isArray(geom) && geom.origin && Number.isFinite(geom.origin.lat) && (geom.features || geom.berths);
  let S;
  try { S = valid ? sceneFromGeom(geom) : legacyScene(harbor || {}); } catch (e) { console.warn('[harbor] geometry rejected, using fallback', e); S = legacyScene(harbor || {}); }
  const pb = new PartBuilder();
  const windowMat = new THREE.MeshStandardMaterial({ color: 0x1b3650, roughness: 0.3, metalness: 0.5, emissive: 0xffd890, emissiveIntensity: 0 });
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xfff1a8, emissive: 0xffd080, emissiveIntensity: 0.3 });
  const counters = { bollards: { left: CAPS.bollards }, fenders: { left: CAPS.fenders }, rings: { left: CAPS.rings }, lamps: { left: CAPS.lamps }, rocks: { left: CAPS.rocks }, piles: { left: 1200 }, cleats: { left: 1500 }, windows: { left: CAPS.windows }, containers: { left: CAPS.containers }, lights: [], windowMat, lampMat };
  const hardRings = [...S.quays, ...S.piers, ...S.pontoons];
  const hardPts = []; for (const ring of [...S.quays, ...S.piers]) for (let i = 0; i < ring.length; i += 2) hardPts.push(ring[i]);
  for (const ring of S.quays) { try { addHardRing(pb, ring, QUAY_H, counters); addContainerStacks(pb, ring, r, counters); } catch (e) { console.warn('[harbor] quay skipped', e); } }
  for (const ring of S.piers) { try { addHardRing(pb, ring, QUAY_H, counters, { pier: true }); } catch (e) { console.warn('[harbor] pier skipped', e); } }
  for (const ring of S.breakwaters) { try { addBreakwater(pb, ring, counters, r); } catch (e) { console.warn('[harbor] breakwater skipped', e); } }
  for (const ring of S.pontoons) { try { addPontoon(pb, ring, counters); } catch (e) { console.warn('[harbor] pontoon skipped', e); } }
  for (const b of S.buildings) {
    try {
      if (b.kind === 'tank') { const c = ringCentroid(b.ring); let rad = 0; for (const p of b.ring) rad += Math.hypot(p.x - c.x, p.z - c.z); addTank(pb, { x: c.x, z: c.z, radius: rad / b.ring.length, height: b.height }, hardPts); }
      else addBuilding(pb, b, r, hardPts, counters);
    } catch (e) { console.warn('[harbor] building skipped', e); }
  }
  for (const t of S.tanks) { try { addTank(pb, t, hardPts); } catch (e) { console.warn('[harbor] tank skipped', e); } }
  pb.build(g);
  const craneMat = r() < 0.5 ? M.craneRed : M.craneBlue;
  for (const c of S.cranes.slice(0, 14)) { try { addGantryCrane(g, c, craneMat); } catch (e) { console.warn('[harbor] crane skipped', e); } }
  for (const l of S.lights.slice(0, 40)) { try { addLight(g, { ...l, onWater: !hardRings.some((ring) => pointInRing(l.x, l.z, ring)) && S.breakwaters.every((ring) => !pointInRing(l.x, l.z, ring)) ? false : false }, counters); } catch (e) { console.warn('[harbor] light skipped', e); } }
  const buoys = [];
  for (const b of S.buoys.slice(0, 80)) { try { buoys.push(addBuoy(g, b)); } catch (e) { console.warn('[harbor] buoy skipped', e); } }
  for (const b of S.berths.slice(0, 40)) { try { addBerthBoard(g, b, hardRings); } catch (e) { console.warn('[harbor] berth board skipped', e); } }
  // harbour name: the FIRST sprite child (main.js toggles it by camera distance)
  const label = makeLabel(`${harbor?.name || 'Harbour'}${harbor?.country ? ` (${harbor.country})` : ''}`, '#ffd877', 34);
  label.position.set(S.anchor ? S.anchor.x * 0.3 : 0, 80, S.anchor ? S.anchor.z * 0.3 : 0); label.scale.set(140, 26, 1); g.add(label);
  const lights = counters.lights;
  g.userData.harbor = harbor; g.userData.geom = valid ? geom : null; g.userData.label = label;
  g.userData.buoys = buoys;
  g.userData.lampPos = lights.length ? lights[0].pos.clone() : null;
  /** night 0..1, time (s): light towers flash with their period, windows and street lamps glow */
  g.userData.setNight = (night, time = 0) => {
    const n = THREE.MathUtils.clamp(night, 0, 1);
    windowMat.emissiveIntensity = 1.6 * n; lampMat.emissiveIntensity = 0.3 + 3.5 * n;
    for (const l of lights) {
      const on = l.period > 0 ? ((time / l.period + l.phase) % 1) < 0.28 : true;
      l.mat.emissiveIntensity = on ? 0.6 + 5 * n : 0.08;
    }
    for (const b of buoys) if (b.userData.lamp) b.userData.lamp.material.emissiveIntensity = 0.3 + 2.5 * n * (((time * 0.7 + b.userData.phase) % 1) < 0.5 ? 1 : 0.15);
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
  g.userData.dispose = () => { windowMat.dispose(); lampMat.dispose(); for (const l of lights) l.mat.dispose(); disposeGroup(g); };
  return g;
}

export function buildFishingMarker(ground) {
  const g = new THREE.Group();
  const pb = new PartBuilder();
  const mat = new THREE.MeshStandardMaterial({ color: 0xffa726, roughness: 0.6 });
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; pb.sphere(2, mat, Math.cos(a) * 120, 1, Math.sin(a) * 120, 8); pb.cyl(0.2, 3, mat, Math.cos(a) * 120, 3, Math.sin(a) * 120, 0.2, 6); }
  pb.build(g);
  const l = makeLabel(`Fishing ground: ${ground?.name || ''}`, '#9ad7ff', 30); l.position.set(0, 40, 0); l.scale.set(120, 22, 1); g.add(l);
  g.userData.dispose = () => disposeGroup(g);
  return g;
}
