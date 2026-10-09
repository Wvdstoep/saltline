// Drawing of the general-arrangement plans' new prop kinds (docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §6.4–6.6, Lane C),
// and zone streaming for big ships. interior.js calls drawGAProp() for prop kinds it does not know (hook H11) and, for
// plans with zones, buildZoned() instead of one merged group, so only the zone you stand in and its neighbours are drawn.
//
// Everything goes through the interior's PartBuilder (one merged mesh per material) — the budget in §6.6 counts on it.
import * as THREE from 'three';
import { PartBuilder } from './models.js';

export const GA_PROP_KINDS = new Set(['bconsole', 'gmdss', 'equip', 'wingConsole', 'compass', 'radarMast', 'me2s', 'steeringGear', 'shaft', 'windlass', 'mwinch',
  'lifeboat', 'liferaft', 'gangwayLadder', 'crane', 'holdShell', 'floodlight', 'ladder', 'bay', 'lashingBridge', 'tankHatch', 'dome', 'catwalk', 'trunk', 'pen',
  'escapeHatch', 'crashRail', 'sternRoller', 'sharkJaws', 'towPin', 'towWinch', 'gangwayTower', 'aframe', 'moonpool', 'helideck', 'netBin', 'powerBlock', 'hopper',
  'dragArm', 'davitGantry', 'conveyor', 'outboard', 'pushKnees', 'tugFender', 'derrick', 'potHauler', 'haulingPort', 'pilotRail', 'bowFender', 'swimPlatform',
  'tender', 'tenderGarage', 'stage', 'seatRow', 'chandelier', 'lifts', 'pool', 'lounger', 'balcony', 'lashPoint', 'carRamp', 'sternRampBig', 'sideRamp', 'block2', 'netBinPlain']);

/** Container boxes on deck: four liveries (one draw call each) keep a big boxship's deck zone inside the phone budget. */
const BAY_COLS = [0, 1, 2, 3];
function extraMats(M) {
  if (M._ga) return M._ga;
  const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.1, emissive: color, emissiveIntensity: 0.1, side: THREE.DoubleSide, ...extra });
  const X = {
    screen: std(0x10324f, { emissive: 0x1e5a8a, emissiveIntensity: 0.9, roughness: 0.3 }), radarScr: std(0x0b3d1c, { emissive: 0x23b04a, emissiveIntensity: 0.8 }),
    lifeboat: std(0xf06a12), water: new THREE.MeshStandardMaterial({ color: 0x2b8fb8, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.85 }),
    green2: std(0x2f6e4b), blue: std(0x1f4f8a), heli: std(0x3b4248), cream: std(0xe8e0c8), mud: std(0x6b5a3a),
  };
  // registered on the material set so Interior.dispose() frees them with the rest
  for (const [k, v] of Object.entries(X)) M[`ga_${k}`] = v;
  M._ga = X; Object.defineProperty(M, '_ga', { enumerable: false, value: X });
  return X;
}

/** Draw one new-kind prop. Returns true when handled. ctx: { g, pb, M, plan } as interior.js passes it. */
export function drawGAProp(ctx, p) {
  const { pb, M } = ctx, X = extraMats(M);
  const lbox = (w, h, d, mat, lx, ly, lz, rotY, ox, oy, oz) => { const c = Math.cos(rotY), s = Math.sin(rotY); pb.box(w, h, d, mat, ox + lx * c + lz * s, oy + ly, oz - lx * s + lz * c, 0, rotY, 0); };
  switch (p.t) {
    case 'bconsole': {
      const w = p.x1 - p.x0, d = p.z1 - p.z0, cx = (p.x0 + p.x1) / 2, cz = (p.z0 + p.z1) / 2;
      pb.box(w, 1.0, d, M.console, cx, p.y + 0.5, cz); pb.box(w, 0.06, d + 0.1, M.dark, cx, p.y + 1.03, cz, -0.18, 0, 0);
      for (const s of p.screens || []) { const sw = Math.min(s.w, 0.9); pb.box(sw + 0.06, sw * 0.62 + 0.06, 0.04, M.dark, s.x, p.y + 1.36, cz - 0.2, -0.35, 0, 0); pb.box(sw, sw * 0.62, 0.02, s.kind === 'radar' ? X.radarScr : X.screen, s.x, p.y + 1.37, cz - 0.165, -0.35, 0, 0); }
      return true;
    }
    case 'gmdss': lbox(1.3, 0.8, 0.7, M.console, 0, 0.4, 0, p.rotY, p.x, p.y, p.z); lbox(1.2, 0.5, 0.06, X.screen, 0, 1.1, -0.3, p.rotY, p.x, p.y, p.z); lbox(0.3, 0.12, 0.2, M.dark, -0.4, 0.86, 0.1, p.rotY, p.x, p.y, p.z); return true;
    case 'wingConsole': pb.box(0.6, 1.1, 0.6, M.console, p.x, p.y + 0.55, p.z); pb.box(0.5, 0.3, 0.04, X.screen, p.x, p.y + 1.25, p.z + 0.2, -0.4, 0, 0); return true;
    case 'compass': pb.cyl(0.25, 1.1, M.wood, p.x, p.y + 0.55, p.z, 0.2, 10); pb.sphere(0.22, M.rail, p.x, p.y + 1.25, p.z, 10); return true;
    case 'radarMast': {
      pb.cyl(0.18, p.h, M.white, p.x, p.y + p.h / 2, p.z, 0.12, 8);
      for (let i = 0; i < (p.bands || 1); i++) { const y = p.y + p.h * (0.55 + i * 0.3); pb.box(i ? 3.2 : 2.4, 0.18, 0.3, M.white, p.x, y + 0.25, p.z + (i ? -0.3 : 0.3)); pb.cyl(0.15, 0.4, M.dark, p.x, y, p.z + (i ? -0.3 : 0.3), 0.15, 8); }
      pb.box(1.6, 0.08, 0.08, M.yellow, p.x, p.y + p.h - 0.4, p.z); pb.sphere(0.12, M.white, p.x + 0.8, p.y + p.h - 0.25, p.z, 6);
      return true;
    }
    case 'me2s': {
      // a slow-speed two-stroke: bedplate, A-frames, the cylinder block, covers, exhaust receiver and turbochargers
      const { x, y, z, len, w, h } = p, n = Math.max(4, Math.min(12, Math.round(len / 1.6)));
      pb.box(w + 0.6, 1.2, len + 0.4, M.dark, x, y + 0.6, z);
      pb.box(w, h * 0.45, len, M.engine, x, y + 1.2 + h * 0.225, z);
      pb.box(w * 0.82, h * 0.32, len * 0.96, M.engine, x, y + 1.2 + h * 0.45 + h * 0.16, z);
      for (let i = 0; i < n; i++) { const cz = z - len / 2 + ((i + 0.5) * len) / n; pb.cyl(w * 0.28, 0.5, M.steel, x, y + 1.2 + h * 0.77 + 0.25, cz, w * 0.28, 10); pb.rod(x, y + 1.2 + h * 0.77 + 0.5, cz, x + w * 0.55, y + h * 0.95, cz, w * 0.08, M.steel, 6); }
      pb.cyl(w * 0.32, len * 0.9, M.steel, x + w * 0.6, y + h * 0.95, z, w * 0.32, 12, Math.PI / 2, 0, 0);
      pb.cyl(w * 0.45, w * 0.7, M.steel, x + w * 0.6, y + h * 0.95, z - len / 2 - w * 0.2, w * 0.38, 14, Math.PI / 2, 0, 0);
      // walkway gratings round the engine at each platform it passes
      for (let yy = y + 3.6; yy < y + h - 1; yy += 3.4) { pb.box(w + 1.2, 0.05, len + 1.2, M.grating, x, yy, z); }
      return true;
    }
    case 'steeringGear': pb.box(p.w, 0.9, p.d, p.pods ? M.yellow : M.engine, p.x, p.y + 0.45, p.z); pb.cyl(Math.min(p.w, p.d) * 0.22, 1.4, M.steel, p.x, p.y + 0.7, p.z, Math.min(p.w, p.d) * 0.22, 12); for (const s of [-1, 1]) pb.cyl(0.14, p.w * 0.8, M.rail, p.x + s * 0.0, p.y + 0.95, p.z + s * p.d * 0.3, 0.14, 8, 0, 0, Math.PI / 2); return true;
    case 'shaft': pb.cyl(p.r, p.z1 - p.z0, M.steel, p.x, p.y, (p.z0 + p.z1) / 2, p.r, 12, Math.PI / 2, 0, 0); for (let z = p.z0 + 3; z < p.z1; z += 6) pb.box(0.8, 0.7, 0.6, M.yellow, p.x, p.y - 0.35, z); return true;
    case 'windlass': case 'mwinch': {
      pb.box(p.w, 0.5, p.d, M.dark, p.x, p.y + 0.25, p.z);
      pb.cyl(p.d * 0.3, p.w * 0.9, p.t === 'windlass' ? M.green : M.yellow, p.x, p.y + 0.8, p.z, p.d * 0.3, 12, 0, 0, Math.PI / 2);
      if (p.t === 'windlass') { pb.cyl(0.35, 0.25, M.dark, p.x - p.side * (p.w / 2 + 0.1), p.y + 0.8, p.z, 0.35, 12, 0, 0, Math.PI / 2); pb.rod(p.x, p.y + 0.5, p.z - p.d / 2, p.x + p.side * 0.6, p.y + 0.1, p.z - p.d * 2.2, 0.06, M.dark, 4); }
      return true;
    }
    case 'lifeboat': {
      const L = p.len, side = p.side || 1;
      if (p.kind === 'freefall') {
        pb.box(3.4, 0.25, L + 1.4, M.steel, p.x, p.y - 0.35, p.z, -0.55, 0, 0);
        for (const s of [-1, 1]) pb.rod(p.x + s * 1.6, p.yDeck ?? p.y - 3, p.z - L / 2, p.x + s * 1.6, p.y - 0.3, p.z - L / 2, 0.12, M.steel, 6), pb.rod(p.x + s * 1.6, p.yDeck ?? p.y - 3, p.z + L / 2, p.x + s * 1.6, p.y - 0.3 - L * 0.6, p.z + L / 2, 0.12, M.steel, 6);
        pb.box(2.8, 2.2, L, X.lifeboat, p.x, p.y + 0.9, p.z, -0.55, 0, 0); pb.box(2.0, 0.7, L * 0.55, M.white, p.x, p.y + 2.1, p.z - L * 0.1, -0.55, 0, 0);
      } else if (p.kind === 'raft') { pb.cyl(0.38, 1.4, M.white, p.x, p.y + 0.6, p.z, 0.38, 10, 0, 0, Math.PI / 2); }
      else {
        pb.box(2.4, 1.6, L, p.kind === 'tender' ? M.white : X.lifeboat, p.x, p.y, p.z); pb.box(1.8, 0.6, L * 0.6, M.white, p.x, p.y + 1.0, p.z);
        if (p.kind !== 'tender') for (const s of [-1, 1]) { pb.rod(p.x - side * 1.6, p.y - 2.2, p.z + s * L * 0.4, p.x - side * 1.6, p.y + 1.6, p.z + s * L * 0.4, 0.12, M.steel, 6); pb.rod(p.x - side * 1.6, p.y + 1.6, p.z + s * L * 0.4, p.x, p.y + 1.9, p.z + s * L * 0.4, 0.1, M.steel, 6); }
      }
      return true;
    }
    case 'liferaft': pb.cyl(0.38, 1.4, M.white, p.x, p.y + 1.2, p.z, 0.38, 10, 0, 0, Math.PI / 2); pb.box(0.3, 1.0, 1.6, M.steel, p.x, p.y + 0.5, p.z); return true;
    case 'gangwayLadder': pb.box(0.9, 0.15, 5, M.rail, p.x + p.side * 0.6, p.y - 0.3, p.z, 0.6 * p.side, 0, 0); return true;
    case 'crane': {
      const ped = p.ped || 2, h = p.h;
      if (p.hose) { pb.cyl(0.35, h, M.yellow, p.x, p.y + h / 2, p.z, 0.3, 10); pb.rod(p.x, p.y + h, p.z, p.x - Math.sign(p.x || 1) * 0.5, p.y + h + 2, p.z + p.boom * 0.6, 0.15, M.yellow, 6); return true; }
      pb.cyl(ped * 0.45, h * 0.55, M.yellow, p.x, p.y + h * 0.275, p.z, ped * 0.42, 12);
      pb.box(ped * 1.2, h * 0.25, ped * 1.4, M.yellow, p.x, p.y + h * 0.68, p.z); pb.box(ped * 0.5, ped * 0.4, 0.05, M.glass, p.x + ped * 0.3, p.y + h * 0.75, p.z - ped * 0.7);
      const bx = p.x, by = p.y + h * 0.7, bz = p.z - 0.2; const ang = 0.45, ex = bx, ey = by + Math.sin(ang) * p.boom, ez = bz - Math.cos(ang) * p.boom;
      pb.rod(bx, by, bz, ex, ey, ez, Math.max(0.18, ped * 0.1), M.yellow, 6); pb.rod(ex, ey, ez, ex, ey - 4, ez, 0.03, M.dark, 4);
      return true;
    }
    case 'holdShell': {
      const w = p.x1 - p.x0, d = p.z1 - p.z0, cx = (p.x0 + p.x1) / 2, cz = (p.z0 + p.z1) / 2;
      if (p.hopper) { for (const s of [-1, 1]) pb.box(w * 0.18, 0.1, d, M.wallSteel, cx + s * w * 0.5, p.y + w * 0.12, cz, 0, 0, s * 0.85); }
      if (p.cells) { const rows = Math.max(2, p.rows || 6), pitch = (p.hatchW || w) / rows; for (let i = 0; i <= rows; i++) { const x = -((p.hatchW || w) / 2) + i * pitch; for (const z of [p.z0 + 0.15, p.z1 - 0.15]) pb.box(0.12, p.h, 0.12, M.yellow, x, p.y + p.h / 2, z); } }
      if (p.fish) { for (let x = p.x0 + 0.6; x < p.x1 - 0.4; x += 0.9) for (let z = p.z0 + 0.6; z < p.z1 - 0.4; z += 1.2) pb.box(0.7, 0.3, 0.5, X.blue, x, p.y + 0.15, z); }
      return true;
    }
    case 'floodlight': pb.box(0.4, 0.25, 0.2, M.light, p.x, p.y, p.z); return true;
    case 'ladder': { const y0 = p.y0, y1 = p.y1, n = Math.max(3, Math.round((y1 - y0) / 0.3)); for (const s of [-0.22, 0.22]) pb.rod(p.x + s, y0, p.z, p.x + s, y1 + 1.0, p.z, 0.025, p.hold ? M.yellow : M.rail, 4); for (let i = 1; i < n; i++) pb.box(0.44, 0.03, 0.03, M.rail, p.x, y0 + ((y1 - y0) * i) / n, p.z); return true; }
    case 'bay': {
      const rows = p.rows, pitch = (p.x1 - p.x0) / rows, d = p.z1 - p.z0, cz = (p.z0 + p.z1) / 2;
      pb.box(p.x1 - p.x0, p.coaming, d, M.hatch, (p.x0 + p.x1) / 2, p.y + p.coaming / 2, cz);
      let s = (p.seed * 9301 + 49297) % 233280;
      for (let r = 0; r < rows; r++) { s = (s * 9301 + 49297) % 233280; const top = Math.max(1, p.tiers - (s % 4 === 0 ? 1 : 0)); const mat = M.boxes[BAY_COLS[s % BAY_COLS.length]]; pb.box(pitch - 0.08, top * 2.59 - 0.05, d, mat, p.x0 + pitch * (r + 0.5), p.y + p.coaming + (top * 2.59) / 2, cz); }
      return true;
    }
    case 'lashingBridge': for (let t = 0; t < (p.tiers || 2); t++) pb.box(p.x1 - p.x0, 0.06, 0.8, M.grating, (p.x0 + p.x1) / 2, p.y + t * 2.6, p.z); for (let x = p.x0; x <= p.x1; x += 5) pb.box(0.15, (p.tiers || 2) * 2.6, 0.15, M.yellow, x, p.y + (p.tiers || 2) * 1.3, p.z); return true;
    case 'tankHatch': pb.cyl(0.45, 0.5, M.steel, p.x, p.y + 0.25, p.z, 0.45, 10); pb.cyl(0.5, 0.08, M.red, p.x, p.y + 0.54, p.z, 0.5, 10); return true;
    case 'dome': pb.cyl(p.r, p.h, M.steel, p.x, p.y + p.h / 2, p.z, p.r * 0.85, 14); pb.cyl(0.25, 1.4, M.white, p.x, p.y + p.h + 0.7, p.z, 0.2, 8); return true;
    case 'catwalk': pb.box(p.x1 - p.x0, 0.06, p.z1 - p.z0, M.grating, (p.x0 + p.x1) / 2, p.y - 0.03, (p.z0 + p.z1) / 2); for (let z = p.z0 + 1; z < p.z1; z += 6) pb.box(0.15, p.y - 0.2, 0.15, M.steel, (p.x0 + p.x1) / 2, (p.y - 0.2) / 2 + 0.1, z); return true;
    case 'trunk': pb.box(p.x1 - p.x0, p.y1 - p.y0, p.z1 - p.z0, M.wallSteel, (p.x0 + p.x1) / 2, (p.y0 + p.y1) / 2, (p.z0 + p.z1) / 2); return true;
    case 'pen': { const w = p.x1 - p.x0, d = p.z1 - p.z0, cx = (p.x0 + p.x1) / 2, cz = (p.z0 + p.z1) / 2; for (const [x, z, ww, dd] of [[cx, p.z0, w, 0.05], [cx, p.z1, w, 0.05], [p.x0, cz, 0.05, d], [p.x1, cz, 0.05, d]]) pb.box(ww, 1.3, dd, M.rail, x, p.y + 0.65, z); for (let i = 0; i < 3 + p.animals; i++) pb.box(0.6, 0.9, 1.5, i % 2 ? X.cream : M.wood, p.x0 + 0.6 + ((i * 1.3) % (w - 1.2)), p.y + 0.6, p.z0 + 1 + ((i * 1.7) % (d - 2))); return true; }
    case 'escapeHatch': pb.box(0.9, 0.5, 0.9, M.steel, p.x, p.y + 0.25, p.z); return true;
    case 'crashRail': for (let i = 0; i < p.pts.length; i++) { const [x, z] = p.pts[i]; pb.box(0.25, p.h, 0.25, M.yellow, x, p.y + p.h / 2, z); if (i) { const [x0, z0] = p.pts[i - 1]; pb.rod(x0, p.y + p.h, z0, x, p.y + p.h, z, 0.08, M.yellow, 4); } } return true;
    case 'sternRoller': pb.cyl(0.9, p.w, M.steel, 0, p.y - 0.2, p.z, 0.9, 14, 0, 0, Math.PI / 2); return true;
    case 'sharkJaws': for (const s of [-1, 1]) pb.box(0.35, 0.6, 0.8, M.yellow, s * 0.5, p.y + 0.3, p.z); return true;
    case 'towPin': pb.cyl(0.18, 1.0, M.yellow, p.x, p.y + 0.5, p.z, 0.18, 8); return true;
    case 'towWinch': { const n = p.drums || 1; pb.box(p.w, 0.5, p.d, M.dark, p.x, p.y + 0.25, p.z); for (let i = 0; i < n; i++) pb.cyl(p.d * 0.32, p.w / n - 0.2, i % 2 ? M.engine : M.yellow, p.x - p.w / 2 + (p.w / n) * (i + 0.5), p.y + p.d * 0.45, p.z, p.d * 0.32, 14, 0, 0, Math.PI / 2); return true; }
    case 'gangwayTower': { pb.box(p.w, p.top - p.y, p.d, M.yellow, p.x, (p.y + p.top) / 2, p.z); pb.box(1.2, 0.6, p.len, M.rail, p.x - p.side * 0.5, p.top + 0.6, p.z - p.len / 2 + 1, 0, 0, 0); return true; }
    case 'aframe': for (const s of [-1, 1]) pb.rod(s * p.w / 2, p.y, p.z, s * p.w * 0.4, p.y + p.h, p.z + 1.4, 0.28, M.orange, 8); pb.rod(-p.w * 0.4, p.y + p.h, p.z + 1.4, p.w * 0.4, p.y + p.h, p.z + 1.4, 0.28, M.orange, 8); return true;
    case 'moonpool': pb.box(p.w, 1.0, p.d, M.yellow, p.x, p.y + 0.5, p.z); pb.box(p.w - 0.3, 0.02, p.d - 0.3, X.water, p.x, p.y + 0.1, p.z); return true;
    case 'helideck': { const g = new THREE.Mesh(new THREE.CircleGeometry(p.r, 24), X.heli); g.rotation.x = -Math.PI / 2; g.position.set(p.x, p.y + 0.02, p.z); ctx.g.add(g); pb.box(p.r * 0.7, 0.02, 0.35, M.white, p.x, p.y + 0.04, p.z); pb.box(0.35, 0.02, p.r * 0.7, M.white, p.x - p.r * 0.17, p.y + 0.04, p.z); pb.box(0.35, 0.02, p.r * 0.7, M.white, p.x + p.r * 0.17, p.y + 0.04, p.z); return true; }
    case 'netBin': pb.box(p.x1 - p.x0, p.h, p.z1 - p.z0, M.steel, (p.x0 + p.x1) / 2, p.y + p.h / 2, (p.z0 + p.z1) / 2); pb.box(p.x1 - p.x0 - 0.3, 0.4, p.z1 - p.z0 - 0.3, M.net, (p.x0 + p.x1) / 2, p.y + p.h + 0.1, (p.z0 + p.z1) / 2); return true;
    case 'powerBlock': pb.rod(p.x, p.y, p.z, p.x, p.y + p.h, p.z + 2, 0.2, M.orange, 6); pb.cyl(0.6, 0.4, M.dark, p.x, p.y + p.h, p.z + 2, 0.6, 12, 0, 0, Math.PI / 2); return true;
    case 'hopper': { const w = p.x1 - p.x0, d = p.z1 - p.z0, cx = (p.x0 + p.x1) / 2, cz = (p.z0 + p.z1) / 2; for (const [x, z, ww, dd] of [[cx, p.z0, w, 0.3], [cx, p.z1, w, 0.3], [p.x0, cz, 0.3, d], [p.x1, cz, 0.3, d]]) pb.box(ww, p.h, dd, M.wallSteel, x, p.y + p.h / 2, z); pb.box(w - 0.4, 0.02, d - 0.4, X.mud, cx, p.y - 0.6, cz); return true; }
    case 'dragArm': pb.rod(p.x, p.y - 0.5, p.z0, p.x + p.side * 0.4, p.y - 0.8, p.z1, 0.45, M.steel, 10); return true;
    case 'davitGantry': pb.box(p.w, p.h, p.d, M.orange, p.x, p.y + p.h / 2, p.z); return true;
    case 'conveyor': pb.box(p.x1 - p.x0, 0.9, p.z1 - p.z0, M.rail, (p.x0 + p.x1) / 2, p.y + 0.45, (p.z0 + p.z1) / 2); return true;
    case 'outboard': for (let i = 0; i < p.n; i++) { const x = (i - (p.n - 1) / 2) * 0.7; pb.box(0.5, 1.1, 0.6, M.white, x, p.y - 0.1, p.z + 0.3); pb.box(0.15, 0.8, 0.25, M.dark, x, p.y - 0.95, p.z + 0.35); } return true;
    case 'pushKnees': for (const s of [-1, 1]) pb.box(0.4, 2.2, 0.8, M.dark, s * p.w / 2, p.y + 0.6, p.z + 0.2); return true;
    case 'tugFender': return true;   // the exterior hull model carries the fendering
    case 'derrick': pb.rod(p.x, p.y, p.z, p.x + p.side * p.len * 0.6, p.y + 4, p.z, 0.16, M.orange, 6); return true;
    case 'potHauler': pb.cyl(0.25, 1.2, M.dark, p.x, p.y + 0.6, p.z, 0.2, 8); pb.cyl(0.3, 0.2, M.yellow, p.x, p.y + 1.25, p.z, 0.3, 12, 0, 0, Math.PI / 2); return true;
    case 'haulingPort': pb.box(0.2, 1.4, 1.4, M.dark, p.x - 0.1, p.y + 0.7, p.z); return true;
    case 'pilotRail': return true;
    case 'bowFender': pb.box(p.w, 1.0, 0.8, M.dark, 0, p.y - 0.3, p.z - 0.2); return true;
    case 'swimPlatform': pb.box(p.w, 0.15, 1.6, M.teak, 0, p.y, p.z + 0.8); return true;
    case 'tender': pb.box(1.6, 0.8, p.len, M.white, p.x, p.y + 0.4, p.z); return true;
    case 'tenderGarage': pb.box(p.x1 - p.x0, 1.2, p.z1 - p.z0 - 0.6, M.white, (p.x0 + p.x1) / 2, p.y + 0.6, (p.z0 + p.z1) / 2); return true;
    case 'stage': pb.box(p.x1 - p.x0, p.h, p.z1 - p.z0, M.wood, (p.x0 + p.x1) / 2, p.y + p.h / 2, (p.z0 + p.z1) / 2); pb.box(p.x1 - p.x0, 4, 0.1, M.fabric2, (p.x0 + p.x1) / 2, p.y + 2, p.z0 + 0.05); return true;
    case 'seatRow': pb.box(p.x1 - p.x0, 0.45, 0.55, p.recline ? M.fabric : M.fabric2, (p.x0 + p.x1) / 2, p.y + 0.23, p.z); pb.box(p.x1 - p.x0, 0.6, 0.1, p.recline ? M.fabric : M.fabric2, (p.x0 + p.x1) / 2, p.y + 0.7, p.z + 0.28); return true;
    case 'chandelier': pb.sphere(0.6, M.light, p.x, p.y - 0.6, p.z, 10); return true;
    case 'lifts': pb.box(p.x1 - p.x0, p.h, p.z1 - p.z0, M.wallSteel, (p.x0 + p.x1) / 2, p.y + p.h / 2, (p.z0 + p.z1) / 2); for (let z = p.z0 + 0.65; z < p.z1 - 0.5; z += 1.3) pb.box(0.04, 2.1, 1.0, M.rail, p.x0 - 0.02, p.y + 1.05, z); return true;
    case 'pool': pb.box(p.x1 - p.x0, 0.7, p.z1 - p.z0, M.white, (p.x0 + p.x1) / 2, p.y + 0.35, (p.z0 + p.z1) / 2); pb.box(p.x1 - p.x0 - 0.3, 0.05, p.z1 - p.z0 - 0.3, X.water, (p.x0 + p.x1) / 2, p.y + 0.6, (p.z0 + p.z1) / 2); return true;
    case 'lounger': pb.box(0.7, 0.35, 1.8, M.white, p.x, p.y + 0.2, p.z); return true;
    case 'balcony': { const x = p.x + p.side * p.d / 2; pb.box(p.d, 0.06, p.z1 - p.z0, M.teak, x, p.y + 0.03, (p.z0 + p.z1) / 2); pb.box(0.04, 1.0, p.z1 - p.z0 - 0.1, M.glass, p.x + p.side * p.d, p.y + 0.5, (p.z0 + p.z1) / 2); pb.box(p.d, 2.2, 0.06, M.white, x, p.y + 1.1, p.z1); return true; }
    case 'lashPoint': return true;
    case 'carRamp': { const ang = Math.atan2(p.rise, p.len) * (p.up === 'n' ? 1 : -1); pb.box(p.w, 0.12, Math.hypot(p.rise, p.len), M.steelFloor, p.x, p.y + p.rise / 2 - 0.08, p.z, ang, 0, 0); return true; }
    case 'sternRampBig': pb.box(p.w, 0.3, 10, M.steel, p.quarter ? 4 : 0, p.y + 2, p.z + 2, -1.2, p.quarter ? -0.6 : 0, 0); return true;
    case 'sideRamp': return true;
    case 'equip': return drawEquip(pb, M, X, p);
    default: return false;
  }
}

function drawEquip(pb, M, X, p) {
  const w = p.x1 - p.x0, d = p.z1 - p.z0, cx = (p.x0 + p.x1) / 2, cz = (p.z0 + p.z1) / 2, y = p.y, h = p.h || 1;
  const body = { range: M.steel, tv: M.dark, treadmill: M.dark, bike: M.dark, weights: M.dark, medcab: M.white, washer: M.white, dryer: M.white, cabinet: M.steel, shelves: M.steel, wc: M.white, rack: M.dark, ccr: M.console, switchboard: X.green2, purifier: M.engine, lathe: M.engine, bench: M.wood, boiler: M.red, compressor: M.engine, sonar: M.console, mfd: M.console, panel: M.console, epirb: M.orange, filleter: M.rail, freezer: M.white }[p.kind] || M.steel;
  switch (p.kind) {
    case 'tv': pb.box(w, 0.7, 0.06, X.screen, cx, y + 1.2, cz); return true;
    case 'treadmill': pb.box(w, 0.25, d, M.dark, cx, y + 0.12, cz); pb.box(w, 1.1, 0.1, M.rail, cx, y + 0.65, p.z0 + 0.1); return true;
    case 'bike': pb.box(0.3, 0.9, d, M.dark, cx, y + 0.45, cz); return true;
    case 'weights': pb.box(w, 0.4, d, M.dark, cx, y + 0.2, cz); pb.rod(p.x0, y + 1.1, cz, p.x1, y + 1.1, cz, 0.03, M.rail, 4); return true;
    case 'wc': pb.box(w, h, d, M.white, cx, y + h / 2, cz); return true;
    case 'shelves': case 'rack': case 'cabinet': case 'medcab': pb.box(w, h, d, body, cx, y + h / 2, cz); for (let yy = y + 0.5; yy < y + h; yy += 0.5) pb.box(w + 0.02, 0.03, d + 0.02, M.dark, cx, yy, cz); return true;
    case 'ccr': case 'sonar': case 'mfd': case 'panel': pb.box(w, Math.min(1.0, h), d, body, cx, y + Math.min(1.0, h) / 2, cz); pb.box(w * 0.9, 0.5, 0.05, X.screen, cx, y + 1.3, cz + (p.rotY === Math.PI ? -1 : 1) * (d / 2 - 0.05), -0.2, p.rotY || 0, 0); return true;
    case 'switchboard': pb.box(w, h, d, body, cx, y + h / 2, cz); for (let i = 0; i < Math.max(2, Math.round(Math.max(w, d) / 0.6)); i++) pb.box(0.06, 0.06, 0.02, i % 3 ? M.green : M.red, cx, y + 1.5, cz); return true;
    case 'purifier': pb.cyl(Math.min(w, d) * 0.35, h * 0.7, body, cx, y + h * 0.35, cz, Math.min(w, d) * 0.3, 12); pb.box(w, 0.2, d, M.dark, cx, y + 0.1, cz); return true;
    case 'boiler': pb.cyl(Math.min(w, d) * 0.48, h, body, cx, y + h / 2, cz, Math.min(w, d) * 0.48, 14); pb.cyl(0.2, 1.5, M.steel, cx, y + h + 0.75, cz, 0.2, 8); return true;
    case 'range': pb.box(w, 0.9, d, body, cx, y + 0.45, cz); pb.box(w * 0.9, 0.04, d * 0.8, M.dark, cx, y + 0.92, cz); return true;
    case 'epirb': pb.cyl(0.08, 0.5, M.orange, cx, y + 0.25, cz, 0.06, 8); return true;
    default: pb.box(w, h, d, body, cx, y + h / 2, cz); return true;
  }
}

/**
 * Build the interior split into zone groups (plan.zones) — each zone its own PartBuilder (one merged mesh per material)
 * — and return { groups: Map(zoneId → Group) }. draw(ctx, item) is the Interior's own draw dispatch for rooms / stairs /
 * props / rails restricted to one zone. Interior.update() then shows the zone you stand in and its neighbours only.
 */
export function buildZoned(interior, plan, g) {
  const groups = new Map();
  const zones = plan.zones?.length ? plan.zones.map((z) => z.id) : ['all'];
  const zoneOf = (o) => o.zone || 'deck';
  for (const zid of zones) {
    const zg = new THREE.Group(); zg.name = `zone:${zid}`;
    const pb = new PartBuilder();
    const sub = {
      ...plan,
      rooms: plan.rooms.filter((r) => zoneOf(r) === zid), stairs: plan.stairs.filter((s) => zoneOf(s) === zid),
      deck: zid === 'deck' || zones.length === 1 ? plan.deck : { ...plan.deck, polys: [] },
    };
    const ctx = { g: zg, M: interior.mats, pb, plan: sub };
    drawRoomsZone(interior, ctx, plan, zid);
    interior.drawStairs(ctx);
    if (sub.deck.polys.length) interior.drawDeck(ctx);
    for (const p of plan.props) if (zoneOf(p) === zid) { try { interior.drawProp(ctx, p); } catch (e) { console.warn('[interior] prop', p.t, e); } }
    for (const r of plan.rails) if (zoneOf(r) === zid) interior.drawRail(ctx, r.pts, r.y);
    pb.build(zg);
    g.add(zg); groups.set(zid, zg);
  }
  return groups;
}
/**
 * Which zone groups to show for the walker in `zoneId` (§6.6): itself and its `near` neighbours. Desktop adds the open
 * decks and up to three house tiers either way (zones sharing a `group`); phones keep to the zone and its neighbours,
 * and on passenger ships to the current deck ± 1.
 */
export function visibleZones(plan, zoneId, phone = false) {
  const z = plan.zones?.find((q) => q.id === zoneId);
  if (!z) return new Set(plan.zones?.map((q) => q.id) || []);
  const out = new Set([zoneId]);
  const deckOf = (id) => (id.startsWith('deck:') ? id.slice(5).split('.')[0] : null);
  if (!phone || !zoneId.startsWith('deck:')) for (const n of z.near) out.add(n);
  else for (const n of z.near) if (!n.startsWith('deck:') || deckOf(n) === deckOf(zoneId)) out.add(n);   // phones: this deck's sections only
  if (phone) return out;
  if (z.group) {
    const g = plan.zones.filter((q) => q.group === z.group).sort((p, q) => p.y0 - q.y0), k = g.indexOf(z);
    for (let i = Math.max(0, k - 3); i <= Math.min(g.length - 1, k + 3); i++) out.add(g[i].id);
  }
  if (zoneId !== 'deck' && plan.zones.some((q) => q.id === 'deck') && !zoneId.startsWith('deck:')) out.add('deck');
  return out;
}

/** Interior.drawRooms for the rooms of one zone (openings of doors from other zones still cut their walls). */
function drawRoomsZone(I, { pb, M }, plan, zid) {
  const byId = new Map(plan.rooms.map((r) => [r.id, r]));
  const inZone = (r) => r && (r.zone || 'deck') === zid;
  const ops = new Map();
  const push = (id, side, o) => { const k = id + ':' + side; let l = ops.get(k); if (!l) { l = []; ops.set(k, l); } l.push(o); };
  const edge = (r, side) => ({ n: r.z0, s: r.z1, w: r.x0, e: r.x1 })[side];
  for (const d of plan.doors) {
    const a = byId.get(d.a), b = d.b ? byId.get(d.b) : null;
    if (!a) continue;
    if (inZone(a)) { push(a.id, d.side, { from: d.at - d.w / 2, to: d.at + d.w / 2, bottom: 0, top: d.h }); I.drawDoor(pb, M, a, d); }
    const opp = { n: 's', s: 'n', e: 'w', w: 'e' }[d.side];
    if (inZone(b) && !b.open && Math.abs(edge(a, d.side) - edge(b, opp)) < 0.06) push(b.id, opp, { from: d.at - d.w / 2, to: d.at + d.w / 2, bottom: 0, top: d.h });
  }
  // back-to-back partitions (cabin rows, cabins on a corridor): a side is left out when a neighbour's wall on the same
  // boundary covers it whole (that wall carries the door openings of both rooms); equal pairs keep the first room's
  const zr = plan.rooms.filter((r) => inZone(r) && !r.open), idx = new Map(zr.map((r, i) => [r, i]));
  const opp = { n: 's', s: 'n', e: 'w', w: 'e' };
  const covered = (r, side) => {
    if (r.windows.some((w) => w.side === side)) return false;
    const n = side === 'n' || side === 's', c = edge(r, side), f = n ? r.x0 : r.z0, t = n ? r.x1 : r.z1;
    for (const o of zr) {
      if (o === r || !o.walls[opp[side]] || Math.abs(o.y - r.y) > 0.02 || o.h + 0.05 < r.h || Math.abs(edge(o, opp[side]) - c) > 0.02) continue;
      const of = n ? o.x0 : o.z0, ot = n ? o.x1 : o.z1;
      if (of > f + 0.02 || ot < t - 0.02) continue;
      const equal = Math.abs(of - f) < 0.02 && Math.abs(ot - t) < 0.02;
      if (equal && (covered2.get(o.id + ':' + opp[side]) || idx.get(o) > idx.get(r))) continue;
      covered2.set(r.id + ':' + side, true);
      return true;
    }
    return false;
  };
  const covered2 = new Map();
  for (const r of plan.rooms) {
    if (!inZone(r)) continue;
    for (const w of r.windows) push(r.id, w.side, { from: w.from, to: w.to, bottom: w.bottom, top: w.top, glass: true });
    const fm = I.floorMat(r.floor);
    if (r.drawFloor !== false && !(r.open && !r.drawFloor)) for (const q of rectMinusHoles({ x0: r.x0, x1: r.x1, z0: r.z0, z1: r.z1 }, r.floorHoles)) pb.box(q.x1 - q.x0, 0.06, q.z1 - q.z0, fm, (q.x0 + q.x1) / 2, r.y - 0.03, (q.z0 + q.z1) / 2);
    if (r.open) continue;
    if (r.ceiling !== false) {
      for (const q of rectMinusHoles({ x0: r.x0, x1: r.x1, z0: r.z0, z1: r.z1 }, r.ceilHoles)) pb.box(q.x1 - q.x0, 0.06, q.z1 - q.z0, M.ceil, (q.x0 + q.x1) / 2, r.y + r.h + 0.03, (q.z0 + q.z1) / 2);
      const lw = Math.min(1.2, (r.x1 - r.x0) * 0.4), lz = Math.min(0.3, (r.z1 - r.z0) * 0.2), cx = (r.x0 + r.x1) / 2, cz = (r.z0 + r.z1) / 2;
      if (!r.ceilHoles.some((h) => cx > h.x0 - lw && cx < h.x1 + lw && cz > h.z0 - lz && cz < h.z1 + lz)) pb.box(lw, 0.04, lz, M.light, cx, r.y + r.h - 0.02, cz);
    }
    const wallH = r.h + 0.1, wm = I.wallMat(r.wall);
    const sides = { n: ['x', r.z0 + 0.05, r.x0, r.x1], s: ['x', r.z1 - 0.05, r.x0, r.x1], w: ['z', r.x0 + 0.05, r.z0, r.z1], e: ['z', r.x1 - 0.05, r.z0, r.z1] };
    for (const [side, [axis, c, from, to]] of Object.entries(sides)) {
      if (!r.walls[side]) continue;
      if (covered(r, side)) continue;   // the neighbour's wall (drawn on the boundary) already closes this side
      I.wall(pb, M, axis, c, from, to, r.y, wallH, ops.get(r.id + ':' + side), wm);
    }
  }
}
function rectMinusHoles(r, holes) {
  let rects = [r];
  for (const h of holes || []) {
    const next = [];
    for (const q of rects) {
      const ix0 = Math.max(q.x0, h.x0), ix1 = Math.min(q.x1, h.x1), iz0 = Math.max(q.z0, h.z0), iz1 = Math.min(q.z1, h.z1);
      if (ix1 - ix0 <= 0.01 || iz1 - iz0 <= 0.01) { next.push(q); continue; }
      if (ix0 - q.x0 > 0.01) next.push({ x0: q.x0, x1: ix0, z0: q.z0, z1: q.z1 });
      if (q.x1 - ix1 > 0.01) next.push({ x0: ix1, x1: q.x1, z0: q.z0, z1: q.z1 });
      if (iz0 - q.z0 > 0.01) next.push({ x0: ix0, x1: ix1, z0: q.z0, z1: iz0 });
      if (q.z1 - iz1 > 0.01) next.push({ x0: ix0, x1: ix1, z0: iz1, z1: q.z1 });
    }
    rects = next;
  }
  return rects;
}

// ------------------------------------------------------------------------------------------------ phase-2 behaviour (H11)
const KIND_TEXT = {
  steering: 'Steering gear — two hydraulic pumps, rudder angle indicator; emergency steering from here by telephone to the bridge.',
  ccr: 'Cargo control — tank levels, valves, pumps and the loading computer (stability and stress).',
  crane: 'Crane control — slew, luff and hoist; check the SWL plate before every lift.',
  winch: 'Mooring winch — brake and clutch; keep clear of the bight of the line.',
  gangway: 'Gangway / pilot ladder — check the lifebuoy and the light before anyone uses it.',
  galley: 'Galley — ranges, ovens and the provision stores; the cook feeds every watch.',
  hospital: 'Ship’s hospital — berth, medicine chest and the radio-medical advice number (MLC A4.1).',
  muster: 'Muster station — lifejackets, the station bill and your lifeboat number.',
  lab: 'Laboratory — wet and dry labs, sample freezers and the winch control for the instruments.',
  info: '',
};
/** E on a hotspot kind the general-arrangement plans add (ladders, Go-to, bridge and engine gear). True when handled. */
export function gaInteract(I, h) {
  const app = I.app, ev = (text, kind = 'info') => app.hud?.event?.({ kind, text });
  switch (h.kind) {
    case 'ladder': if (h.to) { I.placeAt({ ...h.to, yaw: I.yaw }); ev(h.label.replace(/^Climb (up|down): ?/, 'You climb $1 — ')); } return true;
    case 'goto': openGotoMenu(I, h.decks ? h.decks.filter((d) => d.id !== I.plan?.deckGroup).map((d) => ({ id: `deck:${d.id}`, label: d.label, deck: d.id })) : null); return true;
    case 'telegraph': case 'thrusters': case 'ecr': ev(`${h.label}. ${I.engineText()}`); return true;
    case 'whistle': app.sound?.unlock?.(); app.sound?.horn?.('long'); ev('One prolonged blast.'); return true;
    case 'gmdss': { const el = document.getElementById('chatInput'); if (el) { el.focus(); ev('GMDSS console: VHF DSC on channel 70, MF/HF and Inmarsat-C. Type your message, Enter to transmit.'); } return true; }
    default:
      if (h.kind in KIND_TEXT) { ev(KIND_TEXT[h.kind] || h.label); return true; }
      return false;
  }
}
/** The Go-to list (G, or the Go-to hotspot): the plan's goto points, or the decks a lift reaches. */
export function openGotoMenu(I, entries = null) {
  const list = entries || (I.plan?.goto || []).map((g) => ({ ...g }));
  if (!list.length) return false;
  let ov = document.getElementById('interiorGoto');
  if (!ov) {
    ov = document.createElement('div'); ov.id = 'interiorGoto';
    ov.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);max-height:70vh;overflow:auto;min-width:min(320px,calc(100vw - 32px));padding:10px;background:rgba(4,12,20,.92);border:1px solid rgba(140,190,230,.45);border-radius:12px;z-index:17;font:15px "Segoe UI",system-ui,sans-serif;color:#dbe9f4';
    document.body.appendChild(ov);
  }
  ov.textContent = '';
  const close = () => { ov.style.display = 'none'; };
  const head = document.createElement('div'); head.textContent = 'Go to…'; head.style.cssText = 'font-weight:600;margin:2px 4px 8px'; ov.appendChild(head);
  for (const g of list) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = g.label;
    b.style.cssText = 'display:block;width:100%;min-height:44px;margin:4px 0;padding:8px 12px;text-align:left;border-radius:8px;border:1px solid rgba(140,190,230,.3);background:rgba(20,40,60,.8);color:inherit;font:inherit;cursor:pointer';
    b.addEventListener('click', (e) => { e.stopPropagation(); close(); gotoPoint(I, g); });
    ov.appendChild(b);
  }
  const x = document.createElement('button'); x.type = 'button'; x.textContent = 'Cancel'; x.style.cssText = 'display:block;width:100%;min-height:44px;margin-top:8px;border-radius:8px;border:0;background:transparent;color:#9fb8cc;font:inherit;cursor:pointer';
  x.addEventListener('click', (e) => { e.stopPropagation(); close(); }); ov.appendChild(x);
  ov.style.display = 'block';
  I.unlock?.();
  return true;
}
/**
 * Travel to a Go-to point. A point on a deck that is not loaded (cruise ships, big ro-pax: `deck`) reloads that deck's
 * plan first (I.deck, then I.build()) and stands on the same point there.
 */
export function gotoPoint(I, g) {
  if (g.deck && g.deck !== I.plan?.deckGroup) {
    I.deck = g.deck; I.build(); if (!I.group) return false;
    I.group.visible = true; I.hideExterior?.(I.app.myMesh);
    const here = g.id.startsWith('deck:') ? null : I.plan.goto.find((q) => q.id === g.id && !q.deck);
    const land = here || I.plan.hotspots.find((h) => h.kind === 'goto' && h.decks) || I.plan.spawn;
    I.placeAt({ x: land.x, y: land.y, z: land.z, yaw: I.yaw });
    return true;
  }
  I.placeAt({ x: g.x, y: g.y, z: g.z, yaw: I.yaw });
  return true;
}
/**
 * Per frame (after Interior.update): show the zone groups around the walker, and on per-deck plans reload the deck
 * the walker has climbed onto (a tower landing that belongs to a neighbour deck). Returns the room.
 */
export function gaZoneUpdate(I, phone) {
  if (!I.zoneGroups || !I.map) return null;
  const room = I.map.roomAt(I.pos.x, I.pos.z, I.y);
  const vis = visibleZones(I.plan, room?.zone || 'deck', phone);
  for (const [id, zg] of I.zoneGroups) zg.visible = vis.has(id);
  if (I.gotoBtn) { const want = I.plan.goto?.length && !I.atHelm ? 'block' : 'none'; if (I.gotoBtn.style.display !== want) I.gotoBtn.style.display = want; }
  if (I.plan.deckGroup && room?.deck && room.deck !== I.plan.deckGroup && room.kind === 'stairs') {
    const st = { ...I.st }, yaw = I.yaw;
    I.deck = room.deck; I.build(); if (I.group) { I.group.visible = true; I.hideExterior?.(I.app.myMesh); I.placeAt({ ...st, yaw }); }
  }
  return room;
}
