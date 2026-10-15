// Walking people (docs/V4-CONTRACTS.md §3): the player's crew member, shared by the ship interior (interior.js) and
// the harbour on foot (ashore.js), and a cheap instanced crowd of pedestrians for the ashore world.
//
// makeAvatar(opts) → THREE.Group facing −z at rotation.y = 0, feet at y = 0, 1.75 m tall. Its limbs swing from hip /
// shoulder pivots; userData.animate(dt, moving, running) advances the gait and returns the vertical bob (metres) the
// caller adds to the group's height. userData.dispose() frees the materials and geometries it owns.
//
// Crowd(count) → one InstancedMesh per body part (torso, head, two legs, two arms; six draw calls for the whole crowd)
// with per-instance colours; set(i, x, y, z, yaw, phase, moving) poses one pedestrian, commit() uploads the matrices.
import * as THREE from 'three';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * A crew member in a high-visibility jacket.
 * opts: { jacket, trousers, skin, cap, boots, stripe (bool, reflective band), scale }
 */
export function makeAvatar(opts = {}) {
  const o = { jacket: 0x0c1524, trousers: 0x0c1524, skin: 0xdfb490, cap: 0x0c1524, boots: 0x111114, gold: 0xf2d060, scale: 1, ...opts };
  const g = new THREE.Group(); g.name = 'captain';
  const mats = [];
  const mat = (color, extra = {}) => { const m = new THREE.MeshStandardMaterial({ color, roughness: 0.75, ...extra }); mats.push(m); return m; };

  const jacketMat = mat(o.jacket, { roughness: 0.65 });
  const trousersMat = mat(o.trousers, { roughness: 0.70 });
  const skinMat = mat(o.skin, { roughness: 0.75 });
  const shoesMat = mat(o.boots, { roughness: 0.30, metalness: 0.15 });
  const goldMat = mat(o.gold, { metalness: 0.95, roughness: 0.25 });
  const whiteMat = mat(0xf8f8fc, { roughness: 0.60 });
  const blackMat = mat(0x141416, { roughness: 0.40 });

  const body = new THREE.Group(); body.name = 'body'; g.add(body);

  // 1. Tailored Naval Double-Breasted Officer Jacket
  const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.19, 0.58, 16), jacketMat);
  torso.scale.set(1.0, 1.0, 0.72);
  torso.position.y = 1.18;
  body.add(torso);

  // White collared shirt & black tie insert
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.10, 0.08, 12), whiteMat);
  collar.position.set(0, 1.45, 0.02);
  body.add(collar);
  const tie = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.22, 0.015), blackMat);
  tie.position.set(0, 1.34, 0.10);
  body.add(tie);

  // Double-breasted gold anchor buttons (2 rows of 3 buttons)
  for (const bx of [-0.065, 0.065]) {
    for (let by = 0; by < 3; by++) {
      const btn = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.008, 10), goldMat);
      btn.rotation.x = Math.PI / 2;
      btn.position.set(bx, 1.08 + by * 0.10, 0.13);
      body.add(btn);
    }
  }

  // Gold Bullion Epaulettes on shoulders
  for (const sx of [-0.23, 0.23]) {
    const ep = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.025, 0.065), goldMat);
    ep.position.set(sx, 1.45, 0);
    body.add(ep);
  }

  // 2. Sculpted Head
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.115, 16, 12), skinMat);
  head.scale.set(0.95, 1.08, 0.98);
  head.position.y = 1.62;
  body.add(head);

  // 3. Officer Peaked Service Cap
  const capGroup = new THREE.Group();
  capGroup.position.set(0, 1.67, 0);
  // Cap crown (navy flare)
  const capCrown = new THREE.Mesh(new THREE.CylinderGeometry(0.145, 0.12, 0.07, 16), jacketMat);
  capCrown.position.y = 0.035;
  capGroup.add(capCrown);
  // Gold cap band
  const capBand = new THREE.Mesh(new THREE.CylinderGeometry(0.122, 0.122, 0.025, 16, 1, true), goldMat);
  capBand.position.y = 0.01;
  capGroup.add(capBand);
  // Gold naval crest/badge
  const capBadge = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.008, 10), goldMat);
  capBadge.rotation.x = Math.PI / 2;
  capBadge.position.set(0, 0.035, 0.14);
  capGroup.add(capBadge);
  // Polished black visor with gold oak leaf embroidery (scrambled eggs)
  const visor = new THREE.Mesh(new THREE.CylinderGeometry(0.135, 0.135, 0.015, 16, 1, false, 0, Math.PI), blackMat);
  visor.rotation.x = 0.35;
  visor.position.set(0, -0.01, 0.06);
  capGroup.add(visor);
  const visorOak = new THREE.Mesh(new THREE.CylinderGeometry(0.138, 0.138, 0.018, 16, 1, true, 0.2, Math.PI - 0.4), goldMat);
  visorOak.rotation.x = 0.35;
  visorOak.position.set(0, -0.008, 0.06);
  capGroup.add(visorOak);
  body.add(capGroup);

  // 4. Limbs & Rank Braid (4 Gold stripes on sleeves)
  const limb = (r, len, m, x, y) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.95, r * 0.85, len, 12), m);
    mesh.position.y = -len / 2;
    pivot.add(mesh);
    body.add(pivot);
    return pivot;
  };

  const legL = limb(0.088, 0.62, trousersMat, -0.11, 0.88);
  const legR = limb(0.088, 0.62, trousersMat, 0.11, 0.88);
  const armL = limb(0.065, 0.48, jacketMat, -0.26, 1.42);
  const armR = limb(0.065, 0.48, jacketMat, 0.26, 1.42);

  // Shoes (Polished leather oxfords)
  for (const leg of [legL, legR]) {
    const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.075, 0.22), shoesMat);
    shoe.position.set(0, -0.63, 0.02);
    leg.add(shoe);
  }

  // Arms: White cuffs, Hands, and 4 Gold Captain Rank Stripes
  for (const arm of [armL, armR]) {
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), skinMat);
    hand.position.set(0, -0.52, 0);
    arm.add(hand);
    // White shirt cuff peek
    const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.056, 0.056, 0.015, 12), whiteMat);
    cuff.position.set(0, -0.47, 0);
    arm.add(cuff);
    // 4 Gold Captain Stripes
    for (let s = 0; s < 4; s++) {
      const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.058, 0.008, 12, 1, true), goldMat);
      stripe.position.set(0, -0.44 + s * 0.016, 0);
      arm.add(stripe);
    }
  }

  g.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
  if (o.scale !== 1) g.scale.setScalar(o.scale);

  let walkT = 0;
  g.userData = {
    legL, legR, armL, armR, body,
    animate(dt, moving, running) {
      dt = clamp(Number(dt) || 0, 0, 0.25);
      walkT += moving ? dt * (running ? 11 : 7) : 0;
      const swing = moving ? Math.sin(walkT) * (running ? 0.7 : 0.45) : 0;
      const k = Math.min(1, dt * 12);
      legL.rotation.x += (swing - legL.rotation.x) * k; legR.rotation.x += (-swing - legR.rotation.x) * k;
      armL.rotation.x += (-swing * 0.8 - armL.rotation.x) * k; armR.rotation.x += (swing * 0.8 - armR.rotation.x) * k;
      body.rotation.x += ((moving && running ? 0.12 : 0) - body.rotation.x) * k;
      return moving ? Math.abs(Math.sin(walkT)) * (running ? 0.05 : 0.03) : 0;
    },
    dispose() {
      g.traverse((m) => { if (m.isMesh) m.geometry.dispose(); });
      for (const m of mats) m.dispose();
    },
  };
  return g;
}

// ------------------------------------------------------------------------------------------------- instanced crowd
const JACKETS = [0x2f4a7a, 0x7a2f3a, 0x3a6a3a, 0x8a8a8a, 0x1d1d1d, 0xc9a227, 0x5a3a7a, 0x2a7a8a, 0xb85c1e, 0xe8e8e8, 0x4b5d23, 0x6b4a2b];
const TROUSERS = [0x1f2a3a, 0x2a2a2a, 0x3b3f46, 0x4a3a2a, 0x23395b, 0x5a5a5a];
const SKINS = [0xf1c8a5, 0xe0b48f, 0xc68e63, 0x9a6640, 0x6e4529, 0xf5d6bc];

export class Crowd {
  /** @param count number of pedestrians (instances), @param seed deterministic colours */
  constructor(count, seed = 1) {
    this.count = Math.max(0, count | 0);
    this.group = new THREE.Group(); this.group.name = 'crowd';
    let s = (seed >>> 0) || 1;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const part = (geo, color) => {
      const m = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.8 }), Math.max(1, this.count));
      m.count = this.count; m.frustumCulled = false; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(m); return m;
    };
    // geometries are built around their pivots so one matrix per part does the pose
    const torsoG = new THREE.CapsuleGeometry(0.2, 0.42, 3, 8);
    const headG = new THREE.SphereGeometry(0.12, 10, 8);
    const legG = new THREE.CapsuleGeometry(0.085, 0.62, 3, 6); legG.translate(0, -0.395, 0);
    const armG = new THREE.CapsuleGeometry(0.06, 0.48, 3, 6); armG.translate(0, -0.3, 0);
    this.torso = part(torsoG, 0xffffff); this.head = part(headG, 0xffffff);
    this.legL = part(legG, 0xffffff); this.legR = part(legG, 0xffffff);
    this.armL = part(armG, 0xffffff); this.armR = part(armG, 0xffffff);
    const c = new THREE.Color();
    for (let i = 0; i < this.count; i++) {
      const jk = JACKETS[Math.floor(rnd() * JACKETS.length)], tr = TROUSERS[Math.floor(rnd() * TROUSERS.length)], sk = SKINS[Math.floor(rnd() * SKINS.length)];
      this.torso.setColorAt(i, c.setHex(jk)); this.armL.setColorAt(i, c.setHex(jk)); this.armR.setColorAt(i, c.setHex(jk));
      this.legL.setColorAt(i, c.setHex(tr)); this.legR.setColorAt(i, c.setHex(tr)); this.head.setColorAt(i, c.setHex(sk));
    }
    for (const m of this.parts()) if (m.instanceColor) m.instanceColor.needsUpdate = true;
    this.scales = new Float32Array(this.count).map(() => 0.92 + rnd() * 0.16);
    this._base = new THREE.Matrix4(); this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._e = new THREE.Euler();
    this._p = new THREE.Vector3(); this._s = new THREE.Vector3();
  }
  parts() { return [this.torso, this.head, this.legL, this.legR, this.armL, this.armR]; }
  /** Pose pedestrian i: feet at (x, y, z), facing yaw (rad, 0 = −z), gait phase (rad), moving (bool). */
  set(i, x, y, z, yaw, phase, moving = true) {
    if (i < 0 || i >= this.count) return;
    const sc = this.scales[i];
    this._base.compose(this._p.set(x, y, z), this._q.setFromEuler(this._e.set(0, yaw, 0)), this._s.set(sc, sc, sc));
    const swing = moving ? Math.sin(phase) * 0.45 : 0;
    const bob = moving ? Math.abs(Math.sin(phase)) * 0.03 : 0;
    const local = (mesh, lx, ly, rx) => {
      this._m.compose(this._p.set(lx, ly + bob, 0), this._q.setFromEuler(this._e.set(rx, 0, 0)), this._s.set(1, 1, 1));
      this._m.premultiply(this._base);
      mesh.setMatrixAt(i, this._m);
    };
    local(this.torso, 0, 1.2, 0); local(this.head, 0, 1.62, 0);
    local(this.legL, -0.1, 0.86, swing); local(this.legR, 0.1, 0.86, -swing);
    local(this.armL, -0.27, 1.43, -swing * 0.8); local(this.armR, 0.27, 1.43, swing * 0.8);
  }
  /** Hide pedestrian i (scaled to zero). */
  hide(i) { if (i < 0 || i >= this.count) return; this._m.makeScale(0, 0, 0); for (const m of this.parts()) m.setMatrixAt(i, this._m); }
  commit() { for (const m of this.parts()) m.instanceMatrix.needsUpdate = true; }
  dispose() {
    this.group.parent?.remove(this.group);
    const geos = new Set();
    for (const m of this.parts()) { geos.add(m.geometry); m.material.dispose(); m.dispose?.(); }
    for (const g of geos) g.dispose();
  }
}
