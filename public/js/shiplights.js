// public/js/shiplights.js - the own ship's deck floodlights and bridge searchlight (Shift+L, or the More-menu button):
// real three.js SpotLights on the ship builder's fixtures (ship.userData.lightFixtures: flood / search, ship frame,
// forward = -z; the searchlight's `node` is the pitch group that aims), a visible beam cone for the searchlight whose
// brightness follows the fog / rain in the air (clear air shows almost no beam), and the light list for the sea
// (ocean.setSpotLights([{ pos, dir, color, cone, range }]) up to 2, world coordinates, display-radiance colour).
// Phones: the floodlight only, no beam cone. The SpotLights exist from the start with intensity 0 (adding lights
// later would recompile every lit shader); app.toggleWorkLights (main.js, ship builder) calls app.onWorkLights(on, mesh).
import * as THREE from 'three';

const BEAM_VERT = /* glsl */`
varying float vT; varying float vR;
void main() { vT = uv.y; vR = uv.x; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const BEAM_FRAG = /* glsl */`
varying float vT; varying float vR; uniform vec3 uCol; uniform float uI;
void main() {
  float along = (1.0 - vT) * exp(-vT * 2.2);                 // bright at the lamp, fading down the beam
  float edge = 1.0 - smoothstep(0.55, 1.0, abs(vR * 2.0 - 1.0));
  float a = uI * along * (0.35 + 0.65 * edge);
  if (a < 0.003) discard;
  gl_FragColor = vec4(uCol * a, 1.0);
}`;

export class ShipLights {
  constructor(app) {
    this.app = app; this.on = false; this.mesh = null;
    this.phone = !!app.skySys?.phone;
    this.spots = [];
    const n = this.phone ? 1 : 2;
    for (let i = 0; i < n; i++) {
      const s = new THREE.SpotLight(0xfff1cc, 0, 120, 0.75, 0.5, 1.2);
      s.name = 'shipWorkLight' + i; s.visible = true;
      app.scene.add(s); app.scene.add(s.target);
      this.spots.push(s);
    }
    this.beamU = { uCol: { value: new THREE.Color(0xfff8e8) }, uI: { value: 0 } };
    if (!this.phone) {
      const g = new THREE.CylinderGeometry(0.4, 14, 1, 24, 1, true); g.translate(0, -0.5, 0); g.rotateX(-Math.PI / 2);   // along -z, apex at the lamp
      this.beam = new THREE.Mesh(g, new THREE.ShaderMaterial({ uniforms: this.beamU, vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false }));
      this.beam.frustumCulled = false; this.beam.renderOrder = 4; this.beam.visible = false;
    }
    app.onWorkLights = (on, mesh) => this.set(on, mesh);
    this.addButton();
    this._v = new THREE.Vector3(); this._d = new THREE.Vector3(); this._q = new THREE.Quaternion();
  }
  addButton() {
    try {
      const sheet = document.getElementById('moreSheet'); if (!sheet || document.getElementById('btnWorkLights')) return;
      const b = document.createElement('button'); b.id = 'btnWorkLights'; b.className = 'menuBtn'; b.title = 'Deck floodlights and searchlight (Shift+L)';
      b.innerHTML = '<span class="si" data-icon="sun"></span><span class="lbl">Deck lights (Shift+L)</span>';
      b.addEventListener('click', (e) => { e.stopPropagation(); const on = this.app.toggleWorkLights ? this.app.toggleWorkLights() : this.set(!this.on, this.app.myMesh); b.classList.toggle('on', !!on); this.app.hud?.closeMore?.(); });
      const after = document.getElementById('btnSound'); if (after) after.after(b); else sheet.appendChild(b);
      this.app.hud?.setIcon?.(b.querySelector('.si'), 'sun');
    } catch { /* no DOM */ }
  }
  /** On / off for a ship mesh: attaches the SpotLights to its fixtures (ship builder) or, without fixtures, to a default spot on the bridge top. */
  set(on, mesh) {
    this.on = !!on; this.mesh = mesh || this.app.myMesh || null;
    const fx = (this.mesh?.userData?.lightFixtures || []).slice();
    const search = fx.find((f) => f.kind === 'search'), floods = fx.filter((f) => f.kind === 'flood');
    const L = this.app.shipLength?.() || 60;
    const list = [];
    if (search) list.push(search);
    if (floods[0]) list.push(floods[0]);
    if (!list.length && this.mesh) list.push({ kind: 'search', pos: [0, Math.max(6, L * 0.14), -L * 0.1], dir: [0, -0.25, -1], cone: 0.09, colour: 0xfff8e8, range: Math.max(300, L * 6), node: null }, { kind: 'flood', pos: [0, Math.max(5, L * 0.12), -L * 0.12], dir: [0, -0.8, -0.6], cone: 0.75, colour: 0xfff1cc, range: L * 1.5, node: null });
    this.fixtures = list;
    for (let i = 0; i < this.spots.length; i++) {
      const s = this.spots[i], f = list[i];
      if (!this.on || !f || !this.mesh) { s.intensity = 0; continue; }
      s.color.set(f.colour || 0xfff1cc); s.angle = Math.min(1.2, f.cone || 0.5); s.distance = f.range || 200; s.penumbra = f.kind === 'search' ? 0.25 : 0.6;
      s.decay = 1.0;
      // three.js physical spot: intensity in candela-ish display units; a searchlight is tight and strong, a flood wide and soft
      s.intensity = f.kind === 'search' ? 900 : 260;
      s.userData.fixture = f;
    }
    if (this.beam) { if (this.beam.parent) this.beam.parent.remove(this.beam); this.beam.visible = false; }
    if (this.on && search && this.beam && this.mesh) {
      const host = search.node || this.mesh;
      host.add(this.beam);
      if (search.node) this.beam.position.set(0, 0, 0); else { this.beam.position.set(search.pos[0], search.pos[1], search.pos[2]); this.beam.lookAt(this._v.set(search.pos[0] + search.dir[0], search.pos[1] + search.dir[1], search.pos[2] + search.dir[2])); }
      this.beam.visible = true;
    }
    return this.on;
  }
  /** Per frame: lights follow the ship, beam brightness follows the air, the sea gets the light list. */
  update(dt, sky, ocean) {
    if (!this.on || !this.mesh) { ocean?.setSpotLights?.([]); return; }
    const list = [];
    for (const s of this.spots) {
      const f = s.userData.fixture; if (!f || s.intensity <= 0) continue;
      const host = f.node || this.mesh;
      host.updateMatrixWorld?.(true);
      if (f.node) { this._v.set(0, 0, 0); this._d.set(0, 0, -1); } else { this._v.set(f.pos[0], f.pos[1], f.pos[2]); this._d.set(f.dir[0], f.dir[1], f.dir[2]); }
      host.localToWorld(this._v); this._d.transformDirection(host.matrixWorld).normalize();
      s.position.copy(this._v); s.target.position.copy(this._v).addScaledVector(this._d, 50);
      list.push({ pos: this._v.clone(), dir: this._d.clone(), color: s.color.clone().multiplyScalar(f.kind === 'search' ? 1.0 : 0.5), cone: Math.cos(s.angle), range: s.distance });
    }
    ocean?.setSpotLights?.(list);
    if (this.beam?.visible) {
      const w = sky?.weather || {}, vis = Number.isFinite(w.visibility) ? w.visibility : 20000;
      const air = Math.min(1, 3.912 * 120 / Math.max(vis, 50)) + 0.25 * (w.rain || 0);   // what the air itself lights up
      const night = sky?.night ?? 1;
      const f = this.fixtures?.find((x) => x.kind === 'search');
      this.beam.scale.set(1, 1, Math.min(400, (f?.range || 300) * 0.6));
      this.beamU.uI.value = 0.9 * night * (0.06 + 0.94 * air);
    }
  }
}
