// Harbour scenery: quay platform, pier, warehouses (OpenStreetMap footprints when cached, procedural otherwise),
// container cranes, lighthouse, channel buoys, name label. Built lazily within view range.
import * as THREE from 'three';
import { makeLabel, disposeGroup } from './ship.js';

const concrete = new THREE.MeshStandardMaterial({ color: 0x8e8b84, roughness: 0.95 });
const asphalt = new THREE.MeshStandardMaterial({ color: 0x4c4f52, roughness: 0.95 });
const steel = new THREE.MeshStandardMaterial({ color: 0x3b4a5a, roughness: 0.6, metalness: 0.5 });
const craneRed = new THREE.MeshStandardMaterial({ color: 0xc8382b, roughness: 0.6, metalness: 0.3 });
const craneBlue = new THREE.MeshStandardMaterial({ color: 0x2457a8, roughness: 0.6, metalness: 0.3 });
const white = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.7 });
// module-level palette shared by every harbour: userData.dispose() must leave these alone
for (const m of [concrete, asphalt, steel, craneRed, craneBlue, white]) m.userData.shared = true;
const WH_COLORS = [0x9aa5ad, 0xb8c0c5, 0x7d8a93, 0xc9a86a, 0x6f8fa3, 0xa3b1a0];

function box(w, h, d, mat, x, y, z) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); return m; }
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) { let s = seed || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

/** @param harbor {id,name,country,size,lat,lon} @param osm optional array of {kind,height,pts:[[lat,lon]]} */
export function buildHarbor(harbor, osm) {
  const g = new THREE.Group();
  const r = rng(hashStr(harbor.id));
  const big = harbor.size === 'mega' ? 1.35 : harbor.size === 'major' ? 1.15 : harbor.size === 'minor' ? 0.75 : 1;
  const PW = 640 * big, PD = 360 * big, PZ = -330 * big; // platform centre north of the dock point
  g.add(box(PW, 6, PD, concrete, 0, 1, PZ));
  g.add(box(PW - 20, 0.6, PD - 20, asphalt, 0, 4.2, PZ));
  // Pier reaching towards the dock point
  const PX = 30; // pier runs alongside the dock point so ships lie against it
  g.add(box(26, 5, 230 * big, concrete, PX, 0.5, PZ + PD / 2 + 115 * big - 10));
  for (let i = 0; i < 6; i++) g.add(box(2, 6, 2, steel, PX + (i % 2 ? 14 : -14), 3, PZ + PD / 2 + 30 + i * 36 * big));
  // Buildings
  const south = PZ + PD / 2, north = PZ - PD / 2;
  let placed = 0;
  if (osm && osm.length) {
    const mPerUnit = 4; // OSM metres → game units around the harbour point (compressed to fit the platform)
    for (const f of osm.slice(0, 160)) {
      if (f.kind === 'industrial') continue;
      let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
      for (const p of f.pts) { minLat = Math.min(minLat, p[0]); maxLat = Math.max(maxLat, p[0]); minLon = Math.min(minLon, p[1]); maxLon = Math.max(maxLon, p[1]); }
      const cLat = (minLat + maxLat) / 2, cLon = (minLon + maxLon) / 2;
      const k = Math.cos((harbor.lat * Math.PI) / 180);
      const x = ((cLon - harbor.lon) * 111320 * k) / mPerUnit, z = (-(cLat - harbor.lat) * 110574) / mPerUnit;
      const w = Math.max(6, ((maxLon - minLon) * 111320 * k) / mPerUnit), d = Math.max(6, ((maxLat - minLat) * 110574) / mPerUnit);
      if (Math.abs(x) > PW / 2 - w / 2 || z + PZ * 0 > south - d / 2 - 40 || z < north + d / 2) continue;
      const h = f.kind === 'pier' ? 2 : Math.min(60, Math.max(4, (f.height || 8) * 0.8));
      const mat = new THREE.MeshStandardMaterial({ color: WH_COLORS[Math.floor(r() * WH_COLORS.length)], roughness: 0.85 });
      g.add(box(w, h, d, mat, x, 4.5 + h / 2, z));
      placed++;
    }
  }
  if (placed < 4) {
    const n = Math.round(5 * big + r() * 4);
    for (let i = 0; i < n; i++) {
      const w = 40 + r() * 70, d = 25 + r() * 60, h = 8 + r() * 14;
      const x = -PW / 2 + 40 + r() * (PW - 80), z = north + 30 + r() * (PD - 150);
      const mat = new THREE.MeshStandardMaterial({ color: WH_COLORS[Math.floor(r() * WH_COLORS.length)], roughness: 0.85 });
      g.add(box(w, h, d, mat, x, 4.5 + h / 2, z));
      g.add(box(w * 1.02, 1.2, d * 1.02, new THREE.MeshStandardMaterial({ color: 0x5b6670, roughness: 0.9 }), x, 4.5 + h + 0.6, z));
    }
    // container stacks
    for (let i = 0; i < 10 * big; i++) {
      const mat = new THREE.MeshStandardMaterial({ color: [0xc0392b, 0x2980b9, 0x27ae60, 0xf39c12, 0x7f8c8d][Math.floor(r() * 5)], roughness: 0.7 });
      g.add(box(12, 2.6 * (1 + Math.floor(r() * 3)), 2.5, mat, -PW / 2 + 60 + r() * (PW - 120), 4.5 + 1.3, south - 60 - r() * 60));
    }
  }
  // Container cranes along the south edge
  const nc = harbor.size === 'mega' ? 5 : harbor.size === 'major' ? 3 : harbor.size === 'regional' ? 2 : 1;
  for (let i = 0; i < nc; i++) {
    const x = -PW / 2 + 120 + i * ((PW - 240) / Math.max(1, nc - 1)) + (nc === 1 ? (PW - 240) / 2 : 0);
    const mat = r() < 0.5 ? craneRed : craneBlue;
    const z = south - 22, H = 55;
    g.add(box(3, H, 3, mat, x - 14, 4.5 + H / 2, z - 10)); g.add(box(3, H, 3, mat, x + 14, 4.5 + H / 2, z - 10));
    g.add(box(3, H, 3, mat, x - 14, 4.5 + H / 2, z + 10)); g.add(box(3, H, 3, mat, x + 14, 4.5 + H / 2, z + 10));
    g.add(box(34, 3, 24, mat, x, 4.5 + H, z));
    g.add(box(6, 3, 120, mat, x, 4.5 + H + 2, z + 30)); // boom out over the water
    g.add(box(10, 2, 10, steel, x, 4.5 + H - 6, z + 50));
  }
  // Lighthouse at the SE corner
  const lh = new THREE.Mesh(new THREE.CylinderGeometry(3, 4.5, 28, 12), white); lh.position.set(PW / 2 - 30, 4.5 + 14, south - 30); g.add(lh);
  // Emissive lamp only: a PointLight per harbour would change NUM_POINT_LIGHTS as harbours load/unload and force every
  // lit shader to recompile. main.js drives the glow via userData.setNight(night 0..1); lampPos is exposed in case a
  // fixed pool of scene lights wants to sit on the nearest lighthouses.
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xfff1a8, emissive: 0xffd080, emissiveIntensity: 3 });
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(2.2, 10, 10), lampMat);
  lamp.position.set(PW / 2 - 30, 4.5 + 29, south - 30); g.add(lamp);
  g.userData.lampPos = lamp.position.clone();
  g.userData.setNight = (n) => { lampMat.emissiveIntensity = 0.8 + 4.2 * THREE.MathUtils.clamp(n, 0, 1); };
  // Channel buoys around the dock point
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const b = new THREE.Mesh(new THREE.ConeGeometry(2.2, 6, 8), new THREE.MeshStandardMaterial({ color: i % 2 ? 0xd32f2f : 0x2e7d32, roughness: 0.6 }));
    b.position.set(Math.cos(a) * 170, 2, Math.sin(a) * 170 + 40); g.add(b);
  }
  const label = makeLabel(`${harbor.name} (${harbor.country})`, '#ffd877', 34); label.position.set(0, 110, PZ); label.scale.set(140, 26, 1); g.add(label);
  g.userData.harbor = harbor;
  g.userData.dispose = () => disposeGroup(g);
  return g;
}

export function buildFishingMarker(ground) {
  const g = new THREE.Group();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const b = new THREE.Mesh(new THREE.SphereGeometry(2, 8, 8), new THREE.MeshStandardMaterial({ color: 0xffa726, roughness: 0.6 }));
    b.position.set(Math.cos(a) * 120, 1, Math.sin(a) * 120); g.add(b);
  }
  const l = makeLabel(`Fishing ground: ${ground.name}`, '#9ad7ff', 30); l.position.set(0, 40, 0); l.scale.set(120, 22, 1); g.add(l);
  g.userData.dispose = () => disposeGroup(g);
  return g;
}
