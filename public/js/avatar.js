// Walking people (docs/V4-CONTRACTS.md §3): the player's crew member, shared by the ship interior (interior.js) and
// the harbour on foot (ashore.js), and the crowd of pedestrians for the ashore world. Both now come from the shared
// people system (people.js); this file keeps the old API so the walk modes did not have to change.
//
// makeAvatar(opts) → THREE.Group facing −z at rotation.y = 0, feet at y = 0, ~1.76 m tall: the captain as a skinned
// mesh (navy double-breasted uniform, epaulettes, peaked cap). userData.animate(dt, moving, running) advances the
// gait / idle breathing and returns the extra bob (0: the gait carries its own), userData.look(yawRel, pitch) turns the
// head toward where the camera looks, userData.dispose() frees what it owns.
//
// Crowd(count, seed) → ONE instanced, VAT-animated mesh (people.js PeopleCrowd, LOD1, lit by the scene) in street
// clothes; set(i, x, y, z, yaw, phase, moving) poses one pedestrian (yaw 0 = facing −z, phase in radians, one gait
// cycle per 2π), hide(i), commit() uploads.
import * as THREE from 'three';
import { makeCaptain, PeopleCrowd, lookFor } from './people.js';

/** The player's crew member (the captain). opts: { look, seed, scale, lod } (people.js makePerson). */
export function makeAvatar(opts = {}) { return makeCaptain(opts); }

const TURN = Math.PI;   // the walk modes' yaw 0 faces −z, people.js faces +z
export class Crowd {
  /** @param count number of pedestrians (instances), @param seed deterministic looks */
  constructor(count, seed = 1) {
    this.count = Math.max(0, count | 0);
    this.group = new THREE.Group(); this.group.name = 'crowd';
    this.people = new PeopleCrowd(Math.max(1, this.count), { lod: 1, lit: 'standard', name: 'crowd:people' });
    this.group.add(this.people.mesh);
    this.looks = []; this.scales = new Float32Array(this.count);
    for (let i = 0; i < this.count; i++) { const L = lookFor('street', ((seed >>> 0) * 31 + i * 7919) >>> 0); this.looks.push(L); this.scales[i] = L.h; }
    this.hidden = new Uint8Array(this.count);
    this._m = new THREE.Matrix4().makeScale(0, 0, 0);
  }
  parts() { return [this.people.mesh]; }
  /** Pose pedestrian i: feet at (x, y, z), facing yaw (rad, 0 = −z), gait phase (rad), moving (bool). */
  set(i, x, y, z, yaw, phase, moving = true) {
    if (i < 0 || i >= this.count) return;
    const L = this.looks[i], h = L.h, w = L.w * h;
    this.hidden[i] = 0;
    this.people.set(i, x, y, z, yaw + TURN, [w, h, w * 0.95], L, moving ? 'walk' : 'idle', moving ? phase / (Math.PI * 2) : (phase * 0.05) % 1, 0, 1);
  }
  /** Hide pedestrian i (scaled to zero). */
  hide(i) { if (i < 0 || i >= this.count) return; this.hidden[i] = 1; this.people.mesh.setMatrixAt(i, this._m); }
  commit() { this.people.commit(this.count); }
  dispose() { this.group.parent?.remove(this.group); this.people.dispose(); }
}
