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
  const o = { jacket: 0xff7a1a, trousers: 0x1f2a3a, skin: 0xe0b48f, cap: 0x14305a, boots: 0x222222, stripe: true, scale: 1, ...opts };
  const g = new THREE.Group(); g.name = 'crew';
  const mats = [];
  const mat = (color, extra = {}) => { const m = new THREE.MeshStandardMaterial({ color, roughness: 0.75, ...extra }); mats.push(m); return m; };
  const jacket = mat(o.jacket, { roughness: 0.7 }), trousers = mat(o.trousers, { roughness: 0.8 }), skin = mat(o.skin, { roughness: 0.8 }), boots = mat(o.boots, { roughness: 0.9 });
  const body = new THREE.Group(); body.name = 'body'; g.add(body);
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.42, 4, 10), jacket); torso.position.y = 1.2; body.add(torso);
  if (o.stripe) {
    const stripe = mat(0xd8e0e6, { roughness: 0.4, metalness: 0.4, emissive: 0x333333 });
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.205, 0.205, 0.05, 14), stripe); band.position.y = 1.12; body.add(band);
  }
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 14, 10), skin); head.position.y = 1.62; body.add(head);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.125, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat(o.cap, { roughness: 0.8 })); cap.position.y = 1.66; body.add(cap);
  const peak = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.015, 0.09), cap.material); peak.position.set(0, 1.665, -0.13); body.add(peak);
  const limb = (r, len, m, x, y) => { const pivot = new THREE.Group(); pivot.position.set(x, y, 0); const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 3, 8), m); mesh.position.y = -len / 2 - r; pivot.add(mesh); body.add(pivot); return pivot; };
  const legL = limb(0.085, 0.62, trousers, -0.1, 0.86), legR = limb(0.085, 0.62, trousers, 0.1, 0.86);
  const armL = limb(0.06, 0.48, jacket, -0.27, 1.43), armR = limb(0.06, 0.48, jacket, 0.27, 1.43);
  for (const leg of [legL, legR]) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.08, 0.24), boots); b.position.set(0, -0.85, -0.05); leg.add(b); }
  for (const arm of [armL, armR]) { const h = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 6), skin); h.position.y = -0.64; arm.add(h); }
  g.traverse((m) => { if (m.isMesh) { m.castShadow = false; m.receiveShadow = false; } });
  if (o.scale !== 1) g.scale.setScalar(o.scale);
  let walkT = 0;
  g.userData = {
    legL, legR, armL, armR, body,
    /** Advance the gait; returns the bob (m) to add to the group's y. Limbs ease back to rest when standing. */
    animate(dt, moving, running) {
      dt = clamp(Number(dt) || 0, 0, 0.25);
      walkT += moving ? dt * (running ? 11 : 7) : 0;
      const swing = moving ? Math.sin(walkT) * (running ? 0.7 : 0.45) : 0;
      const k = Math.min(1, dt * 12);
      legL.rotation.x += (swing - legL.rotation.x) * k; legR.rotation.x += (-swing - legR.rotation.x) * k;
      armL.rotation.x += (-swing * 0.8 - armL.rotation.x) * k; armR.rotation.x += (swing * 0.8 - armR.rotation.x) * k;
      body.rotation.x += ((moving && running ? 0.12 : 0) - body.rotation.x) * k;   // lean into a run
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
