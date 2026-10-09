// Berth guidance in the harbour (V5-PLAN item 2): "it is hard to see where I have to be in the harbour".
// The target is the berth the server reports in `you.nearBerth` (server/berthguide.js: the nearest berth that fits the
// ship, sticky, reported from ~6 km out). In 3D:
//   • a glowing outline on the water at the berth, the size of YOUR ship (length × beam), aligned with the quay, a soft
//     fill, chevrons on the approach side and a floating board with the berth name on a pole; a light column marks it
//     from far away;
//   • a LEADING LINE from the ship (or the harbour entrance when the ship is still outside the 4.5 km harbour patch) to
//     the berth that only crosses water: A* over the harbour patch the collisions use (app.geoms entry: mask + SDF +
//     heights; berthplan.js), clearance half the beam + 10 m, avoids water shallower than the draught, prefers the
//     fairway, ends one ship length astern of the berth so the last leg runs along the quay; re-planned at most every 2 s;
//     drawn as a dashed glowing ribbon riding the waves, dashes flowing toward the berth;
//   • within 5 km of the harbour: the fairway edges and centre line on the water and the lateral buoy lines (red / green)
//     from the harbour geometry's fairway and its buoys (no fairway data → only the leading line).
// HUD (hud.showBerth calls renderCard): big distance along the line, the course to steer with a turn arrow, berth name,
// water depth against the draught, speed advice, a mini top-down plan of the harbour; Moor / Tugs stay as before.
// Leaving a harbour you just cast off from, the line and outline wait until you head back in (no line pointing back).
// Beyond 2.5 km the guidance only appears when you head for the harbour, have a route or a contract there, so sailing past
// a port along the coast does not pop a card up (on phones it would cover the contract card).
import * as THREE from 'three';
import { SHIP_CLASSES, GEO, INTERACT, latLonToPatchCell } from '/shared/constants.js';
import { normDeg, angleDiff } from '/shared/geo.js';
import { surfaceHeightAt } from './ocean2.js';
import { makeLabel } from './ship.js';
import { ic } from './icons.js';
import * as BP from './berthplan.js';

const D2R = Math.PI / 180;
const REPLAN_MS = 2000;          // never plan more often than this (off the line: every 2 s)
const REPLAN_IDLE_MS = 10000;    // on the line: refresh this often …
const REPLAN_MOVE_M = 25;        // … once the ship has moved this far since the last plan
const LANES_M = 5000;            // fairway lanes and buoy lines show within this of the harbour
const WAVE_NEAR_M = 650;         // ribbon vertices this close to the camera ride the waves; further out they lie at tide level
const FLOAT_Y = 0.35;            // ribbons float this far above the surface
const LINE_STEP_M = 8;           // leading line resampling
const MAX_LINE_PTS = 900;
const DEPART_RESUME_M = 150;     // leaving a harbour: guidance resumes once you are this much closer than your furthest point
const NEAR_ALWAYS_M = 2500;      // the card always shows this close to the berth; further out only when heading in, routed there or on contract
const INTEREST_HOLD_MS = 20000;  // … and keeps showing this long after the last time one of those held
const FAIR_HALF = { mega: 60, major: 50, regional: 45, minor: 40 }; // server/harborgeom.js SIZES.fairHalf
const COL = { line: 0xffd34a, fit: 0x4fe39a, nofit: 0xf2a134, lane: 0xe6f2ff, red: 0xff4a4a, green: 0x3fe07a };
const fmtD = (m) => (!Number.isFinite(m) ? '—' : m >= 10000 ? `${Math.round(m / 1000)} km` : m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.max(0, Math.round(m))} m`);
const pad3 = (n) => String(Math.round(normDeg(n)) % 360).padStart(3, '0');

// ------------------------------------------------------------------------------------------------ ribbon (dashed, floating)
const RIB_VERT = /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const RIB_FRAG = /* glsl */`uniform vec3 uColor; uniform float uTime, uOpacity, uDash, uSpeed, uFill, uDuty;
varying vec2 vUv;
void main() {
  float across = abs(vUv.y * 2.0 - 1.0);
  float core = 1.0 - smoothstep(0.45, 1.0, across);
  float ph = fract((vUv.x + uTime * uSpeed) / uDash);
  float dash = smoothstep(0.0, 0.05, ph) * (1.0 - smoothstep(uDuty, uDuty + 0.05, ph));
  float a = uOpacity * mix(uFill, 1.0, dash) * core;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor * (0.85 + 0.6 * (1.0 - across)), a);
}`;
function ribbonMaterial(color, { opacity = 0.9, dash = 18, speed = 6, fill = 0.12, duty = 0.55 } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uTime: { value: 0 }, uOpacity: { value: opacity }, uDash: { value: dash }, uSpeed: { value: speed }, uFill: { value: fill }, uDuty: { value: duty } },
    vertexShader: RIB_VERT, fragmentShader: RIB_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
}
/** A flat strip along a polyline of {x, z, u} (u = distance coordinate for the dash pattern), riding the waves. */
class Ribbon {
  constructor(maxPts, material, { width = 3.5, widthK = 0.008, widthMax = 8, closed = false } = {}) {
    this.max = maxPts; this.width = width; this.widthK = widthK; this.widthMax = widthMax; this.closed = closed;
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(maxPts * 2 * 3); this.uv = new Float32Array(maxPts * 2 * 2);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2).setUsage(THREE.DynamicDrawUsage));
    const idx = new Uint32Array((maxPts - 1) * 6);
    for (let i = 0; i < maxPts - 1; i++) { const a = i * 2; idx.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], i * 6); }
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(g, material); this.mesh.frustumCulled = false; this.mesh.renderOrder = 6;
    this.pts = []; this.ys = new Float32Array(maxPts);
  }
  setPoints(pts) { this.pts = pts.length > this.max ? pts.slice(0, this.max) : pts; }
  /** Lay the strip: per-vertex wave height near the camera (world = group offset + local), width growing with distance. */
  update(gx, gz, cam, time, level, flat = false) {
    const P = this.pts, n = P.length, pos = this.pos, uv = this.uv;
    if (n < 2) { this.mesh.geometry.setDrawRange(0, 0); return; }
    for (let k = 0; k < n; k++) {
      const p = P[k], wx = gx + p.x, wz = gz + p.z;
      const dc = Math.hypot(wx - cam.x, wz - cam.z, cam.y - level);
      const y = flat ? level : dc < WAVE_NEAR_M ? surfaceHeightAt(wx, wz, time) : level;
      // tangent: neighbours (miter on the joins of closed outlines)
      const a = P[k > 0 ? k - 1 : (this.closed ? n - 2 : 0)], b = P[k < n - 1 ? k + 1 : (this.closed ? 1 : n - 1)];
      let tx = b.x - a.x, tz = b.z - a.z; const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
      let miter = 1;
      if (k > 0 && k < n - 1 || this.closed) {
        const ax = p.x - a.x, az = p.z - a.z, al = Math.hypot(ax, az) || 1;
        const cosHalf = Math.abs((ax / al) * tx + (az / al) * tz); miter = Math.min(2, 1 / Math.max(0.5, cosHalf));
      }
      const w = Math.min(this.widthMax, Math.max(this.width, dc * this.widthK)) * 0.5 * miter;
      const nx = -tz * w, nz = tx * w, o = k * 6, yy = y + FLOAT_Y;
      pos[o] = p.x + nx; pos[o + 1] = yy; pos[o + 2] = p.z + nz;
      pos[o + 3] = p.x - nx; pos[o + 4] = yy; pos[o + 5] = p.z - nz;
      const q = k * 4; uv[q] = p.u; uv[q + 1] = 0; uv[q + 2] = p.u; uv[q + 3] = 1;
    }
    const g = this.mesh.geometry;
    g.attributes.position.needsUpdate = true; g.attributes.uv.needsUpdate = true;
    g.setDrawRange(0, (n - 1) * 6);
  }
  dispose() { this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}

// ------------------------------------------------------------------------------------------------ beacon column (seen from afar)
const BEAM_VERT = /* glsl */`varying float vY; void main() { vY = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const BEAM_FRAG = /* glsl */`uniform vec3 uColor; uniform float uOpacity; varying float vY;
void main() { float a = uOpacity * pow(1.0 - vY, 1.5); gl_FragColor = vec4(uColor * (0.7 + 0.7 * (1.0 - vY)), a); }`;

/** Flat chevron on the water pointing local −z (the berth axis group turns −z to the approach heading). */
function chevronGeometry(w, depth, thick) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, -depth / 2); s.lineTo(0, depth / 2); s.lineTo(w / 2, -depth / 2);
  s.lineTo(w / 2 - thick, -depth / 2); s.lineTo(0, depth / 2 - thick * 1.3); s.lineTo(-w / 2 + thick, -depth / 2); s.closePath();
  const g = new THREE.ShapeGeometry(s); g.rotateX(-Math.PI / 2); // shape +y → local −z: the tip points along the approach heading
  return g;
}

// ------------------------------------------------------------------------------------------------ mini plan
const PLAN_COL = { water: [13, 42, 64], fairway: [19, 64, 94], shallow: [32, 92, 104], land: [52, 66, 50], quay: [140, 145, 152], breakwater: [110, 116, 122], pontoon: [140, 110, 74] };
const PLAN_BASE = new WeakMap();
function planBase(entry) {
  let c = PLAN_BASE.get(entry); if (c) return c;
  const n = entry.n; c = document.createElement('canvas'); c.width = n; c.height = n;
  const x = c.getContext('2d'), img = x.createImageData(n, n), d = img.data;
  const pick = [PLAN_COL.water, PLAN_COL.land, PLAN_COL.quay, PLAN_COL.breakwater, PLAN_COL.pontoon, PLAN_COL.fairway, PLAN_COL.shallow];
  for (let k = 0; k < n * n; k++) { const col = pick[entry.mask[k]] || PLAN_COL.water; d[k * 4] = col[0]; d[k * 4 + 1] = col[1]; d[k * 4 + 2] = col[2]; d[k * 4 + 3] = 255; }
  x.putImageData(img, 0, 0); PLAN_BASE.set(entry, c); return c;
}

export class BerthGuide {
  constructor(app) {
    this.app = app;
    this.group = new THREE.Group(); this.group.name = 'berthGuide'; app.scene.add(this.group);
    this.frame = null;            // { lat, lon, k (m per deg lon), entry } — local metres of every object here
    this.target = null;           // { key, nb, x, z, hdg, len, beam, cls, fits }
    this.plan = null;             // { key, pts (smoothed, local m), line (resampled), length, approachHdg, shallow, ok, at, from }
    this.info = null;             // per-frame numbers for the card
    this.marker = null; this.lanes = null; this.depart = null; this.lastDocked = undefined;
    this.lineMat = ribbonMaterial(COL.line, { opacity: 0.95, dash: 22, speed: 9, fill: 0.18, duty: 0.55 });
    this.line = new Ribbon(MAX_LINE_PTS, this.lineMat, { width: 3.5, widthK: 0.009, widthMax: 30 });
    this.line.mesh.visible = false; this.group.add(this.line.mesh);
    this.cardAt = 0; this.planAt = 0; this.planMs = [];
  }

  // ---------------------------------------------------------------- frame helpers
  xz(lat, lon) { const f = this.frame; return { x: (lon - f.lon) * f.k, z: -(lat - f.lat) * GEO.M_PER_DEG_LAT }; }
  setFrame(lat, lon, entry) {
    if (this.frame && this.frame.lat === lat && this.frame.lon === lon && this.frame.entry === entry) return false;
    this.frame = { lat, lon, k: GEO.M_PER_DEG_LON_EQ * Math.cos(lat * D2R), entry };
    return true;
  }

  /** Per frame (after the ships are placed). */
  update(dt, now) {
    const app = this.app, you = app.you, s = app.ship;
    const t = app.time || 0;
    this.lineMat.uniforms.uTime.value = t;
    if (!you || !s) { this.hideAll(); return; }
    this.trackDeparture(you);
    const ashore = !!app.ashore?.active;
    const nb = you.nearBerth;
    const entryFor = (id) => (id ? app.geoms?.get?.(id) || null : null);
    // ---- frame: the harbour patch origin when its geometry is loaded (the patch frame), else the berth itself
    let entry = nb ? entryFor(nb.harbor) : null;
    if (!entry && !nb) entry = this.nearestEntry();
    let moved = false;
    if (entry) moved = this.setFrame(entry.origin.lat, entry.origin.lon, entry);
    else if (nb && Number.isFinite(nb.lat)) moved = this.setFrame(nb.lat, nb.lon, null);
    else { this.hideAll(); return; }
    if (moved) { this.target = null; this.plan = null; this.disposeMarker(); this.disposeLanes(); } // everything here lives in the frame
    app.place(this.group, this.frame.lat, this.frame.lon, 0);
    const gx = this.group.position.x, gz = this.group.position.z, cam = app.camera.position, level = app.tideLevel || 0;
    // ---- lanes (fairway + buoy lines) within 5 km of the harbour, at sea
    this.updateLanes(entry, you, s, ashore, gx, gz, cam, t, level);
    // ---- berth guidance
    const active = !!nb && Number.isFinite(nb.lat) && !you.docked && !ashore && !you.rescue && this.updateInterest(nb, entry, s, now);
    if (!active) { this.hideTarget(); this.info = null; return; }
    const C = SHIP_CLASSES[s.cls] || SHIP_CLASSES.coaster;
    const key = `${nb.harbor}|${nb.id}|${s.cls}`;
    if (!this.target || this.target.key !== key) this.setTarget(key, nb, C);
    const T = this.target; T.nb = nb; T.fits = nb.fits !== false;
    const me = this.xz(s.lat, s.lon);
    const departing = !!this.depart;
    // plan
    if (entry && !you.assist && !departing) {
      const moved = this.plan ? Math.hypot(me.x - this.plan.from.x, me.z - this.plan.from.z) : Infinity;
      const age = now - this.planAt;
      const off = this.plan ? BP.projectOnPolyline(this.plan.pts, me).dist : Infinity;
      // the drawn line is trimmed to the ship every frame, so a new plan is only needed for a new target, once the ship is
      // well off the line (≥ 2 s apart), or now and then after it has moved (tide, berths taken)
      if (!this.plan || this.plan.key !== key || (age > REPLAN_MS && off > Math.max(40, C.beam + 30)) || (age > REPLAN_IDLE_MS && moved > REPLAN_MOVE_M)) this.replan(entry, me, C, now);
    } else if (!entry) this.plan = null;
    // numbers for the card
    this.info = this.measure(me, s, C, nb, departing);
    // 3D
    const showLine = !!this.plan && !you.assist && !departing && this.info.remaining > 25;
    this.drawLine(showLine, me, gx, gz, cam, t, level);
    this.drawMarker(gx, gz, cam, t, level, departing, now);
  }

  /** Is the skipper making for this harbour? (near, on contract, routed there, or heading for its entrance) — sticky for 20 s. */
  updateInterest(nb, entry, s, now) {
    const I = this.interest && this.interest.harbor === nb.harbor ? this.interest : (this.interest = { harbor: nb.harbor, until: 0, on: false });
    const b = this.xz(nb.lat, nb.lon), me = this.xz(s.lat, s.lon);
    let on = Math.hypot(b.x - me.x, b.z - me.z) <= NEAR_ALWAYS_M || !!nb.contract || !!this.app.you?.assist;
    const route = this.app.route || [], end = route.length ? route[route.length - 1] : null;
    if (!on && end) { const e = this.xz(end.lat, end.lon); on = Math.hypot(e.x - b.x, e.z - b.z) < 4000; }
    if (!on && Math.abs(s.spd || 0) > 1.5) { // heading for the harbour entrance (the fairway's outer end), else the berth
      const fw = entry?.geom?.fairway, o = Array.isArray(fw) && fw.length >= 2 ? fw[fw.length - 1] : null;
      const aim = o ? this.xz(o[0], o[1]) : b;
      on = Math.abs(angleDiff(s.hdg, BP.bearingXZ(aim.x - me.x, aim.z - me.z))) < 50;
    }
    if (on) I.until = now + INTEREST_HOLD_MS;
    I.on = on || now < I.until;
    return I.on;
  }
  /** hud.showBerth: false when the card should stay hidden for this berth (sailing past the harbour). */
  wants(nb) { return !nb || !this.interest || this.interest.harbor !== nb.harbor ? true : this.interest.on; }

  hideAll() { this.hideTarget(); if (this.lanes) this.lanes.group.visible = false; this.info = null; }
  hideTarget() {
    this.line.mesh.visible = false;
    if (this.marker) this.marker.group.visible = false;
  }
  nearestEntry() {
    const s = this.app.ship; let best = null, bd = LANES_M + 3000;
    for (const e of this.app.geoms?.entries?.values?.() || []) {
      const a = e.geom?.anchor || e.origin; const c = latLonToPatchCell(s.lat, s.lon, e.n, e.res, a.lat, a.lon);
      const d = Math.hypot((c.i - e.n / 2) * e.res, (c.j - e.n / 2) * e.res); if (d < bd) { bd = d; best = e; }
    }
    return best;
  }
  /** Leaving the harbour you just cast off from: no line pointing back at the berth until you head in again. */
  trackDeparture(you) {
    const docked = you.docked || null, nb = you.nearBerth;
    this.depart = BP.departureStep(this.depart, { prevDocked: this.lastDocked, docked, nbHarbor: nb?.harbor, contract: !!nb?.contract, remaining: this.info?.remaining ?? nb?.distM }, DEPART_RESUME_M);
    this.lastDocked = docked;
  }


  // ---------------------------------------------------------------- planning
  setTarget(key, nb, C) {
    const p = this.xz(nb.lat, nb.lon);
    this.target = { key, nb, x: p.x, z: p.z, hdg: Number(nb.hdg) || 0, len: C.length, beam: C.beam, cls: C.id, fits: nb.fits !== false };
    this.plan = null; this.planAt = 0;
    this.buildMarker();
  }
  replan(entry, me, C, now) {
    const T = this.target, n = entry.n, res = entry.res;
    const t0 = performance.now();
    const cellOf = (p) => ({ i: p.x / res + n / 2, j: p.z / res + n / 2 });
    const xzOf = (c) => ({ x: (c.i - n / 2) * res, z: (c.j - n / 2) * res });
    const grid = entry; // { n, res, mask, sdf, heights }
    const halfBeam = C.beam / 2, tideH = Number(this.app.tide?.height) || 0;
    const sCell = cellOf(me), bCell = cellOf(T);
    const inside = BP.inGrid(grid, sCell.i, sCell.j, 1);
    let start = sCell;
    if (!inside) start = this.entryCell(entry, sCell, halfBeam + 10) || sCell;
    // the last leg runs along the quay from one ship length astern — unless the ship is already about that close
    const closeIn = Math.hypot(T.x - me.x, T.z - me.z) < C.length * 1.5;
    const pre = !closeIn && BP.inGrid(grid, bCell.i, bCell.j) ? BP.preBerthPoint(grid, bCell, T.hdg, C.length, halfBeam, start) : null;
    const goal = pre || bCell;
    let r = null;
    if (BP.inGrid(grid, start.i, start.j) && BP.inGrid(grid, goal.i, goal.j)) {
      try { r = BP.planPath(grid, start, goal, { halfBeam, clearance: halfBeam + 10, draft: Math.max(0.1, C.draft - tideH), freeR: Math.max(40, C.length * 0.6 + 20) }); }
      catch (e) { console.warn('[berthguide] plan failed', e); r = null; }
    }
    const cells = r ? r.points.slice() : [start, goal];
    if (!inside) cells.unshift(sCell);
    if (pre) cells.push(bCell);
    const pts = cells.map(xzOf);
    pts[0] = { x: me.x, z: me.z };
    pts[pts.length - 1] = { x: T.x, z: T.z };
    const L = BP.polyLength(pts);
    const step = Math.max(LINE_STEP_M, L / (MAX_LINE_PTS - 100));
    const line = BP.densify(pts, step);
    // approach heading: along the berth axis, the way the last leg runs in
    const a = pts[Math.max(0, pts.length - 2)], b = pts[pts.length - 1];
    const lastBrg = BP.bearingXZ(b.x - a.x, b.z - a.z);
    const approachHdg = pre ? normDeg(T.hdg + (pre.sign > 0 ? 0 : 180)) : (Math.abs(angleDiff(lastBrg, T.hdg)) <= 90 ? T.hdg : normDeg(T.hdg + 180));
    this.plan = { key: T.key, pts, line, length: L, approachHdg, shallow: !!r?.shallow, ok: !!r, from: { x: me.x, z: me.z }, minClear: r?.minClearM ?? null };
    this.planAt = now;
    const ms = performance.now() - t0; this.planMs.push(ms); if (this.planMs.length > 20) this.planMs.shift();
    if (!this.loggedPlan) { this.loggedPlan = true; console.info(`[berthguide] ${T.nb.name}: ${r ? 'water route' : 'straight (no route)'} ${Math.round(L)} m, ${pts.length} pts, planned in ${ms.toFixed(1)} ms`); }
    if (this.marker) this.orientMarker();
  }
  /** Where a ship outside the patch enters it: the outer end of the fairway (else the nearest open border water). */
  entryCell(entry, sCell, clr) {
    const fw = entry.geom?.fairway;
    if (Array.isArray(fw) && fw.length >= 2) {
      for (let k = fw.length - 1; k >= 0; k--) {
        const p = fw[k], c = latLonToPatchCell(p[0], p[1], entry.n, entry.res, entry.origin.lat, entry.origin.lon);
        if (BP.inGrid(entry, c.i, c.j, 2)) return c;
      }
    }
    return BP.entryFromOutside(entry, sCell, clr);
  }
  measure(me, s, C, nb, departing) {
    const T = this.target, P = this.plan;
    const straight = Math.hypot(T.x - me.x, T.z - me.z);
    let remaining = straight, off = 0, steer = BP.bearingXZ(T.x - me.x, T.z - me.z);
    if (P && P.pts.length >= 2) {
      const pr = BP.projectOnPolyline(P.pts, me);
      remaining = Math.max(0, P.length - pr.along) + pr.dist; off = pr.dist;
      const look = BP.pointAlong(P.pts, pr.along + Math.max(120, 1.5 * C.length));
      if (look && Math.hypot(look.x - me.x, look.z - me.z) > 5) steer = BP.bearingXZ(look.x - me.x, look.z - me.z);
    }
    if (remaining < 80) { // the last bit: line up with the quay — either way round (port or starboard side to), whichever she already points
      steer = P ? P.approachHdg : T.hdg;
      if (Math.abs(angleDiff(s.hdg, steer)) > 90) steer = normDeg(steer + 180);
    }
    const turn = angleDiff(s.hdg, steer);
    const spd = Math.abs(s.spd || 0);
    const adv = BP.speedAdvice(remaining);
    const water = Number.isFinite(nb.water) ? nb.water : Number.isFinite(nb.depth) ? nb.depth + (Number(this.app.tide?.height) || 0) : null;
    return { remaining, straight, off, steer, turn, spd, adv, water, draft: C.draft, departing, shallow: !!P?.shallow, planned: !!P?.ok };
  }

  // ---------------------------------------------------------------- 3D: leading line
  drawLine(show, me, gx, gz, cam, t, level) {
    const P = this.plan;
    if (!show || !P) { this.line.mesh.visible = false; return; }
    const pr = BP.projectOnPolyline(P.pts, me);
    const rem = Math.max(0, P.length - pr.along);
    // pooled vertex objects: this runs every frame with up to MAX_LINE_PTS points (no garbage per frame)
    const out = this._lineBuf || (this._lineBuf = []); let n = 0;
    const put = (x, z, u) => { const o = out[n] || (out[n] = { x: 0, z: 0, u: 0 }); o.x = x; o.z = z; o.u = u; n++; };
    const C = this.target;
    // start a little ahead of the bow so the line reads as "go this way" and does not hide under the hull
    const bowAhead = Math.min(C.len * 0.55, Math.max(0, rem - 10));
    const startS = pr.along + (pr.dist < C.beam ? bowAhead : 0);
    const first = BP.pointAlong(P.pts, startS);
    if (pr.dist >= C.beam) put(me.x, me.z, rem + pr.dist);
    put(first.x, first.z, P.length - startS);
    for (let k = 0; k < P.line.length && n < MAX_LINE_PTS; k++) { const q = P.line[k]; if (q.s > startS + 2) put(q.x, q.z, P.length - q.s); }
    out.length = n;
    if (n < 2) { this.line.mesh.visible = false; return; }
    this.line.setPoints(out);
    this.line.update(gx, gz, cam, t, level);
    this.line.mesh.visible = true;
  }

  // ---------------------------------------------------------------- 3D: berth marker
  buildMarker() {
    this.disposeMarker();
    const T = this.target, L = T.len + 6, B = T.beam + 4;
    const g = new THREE.Group(); g.name = 'berthMarker';
    const col = T.fits ? COL.fit : COL.nofit;
    // outline: a closed ribbon around L × B, resampled so it rides the swell
    const ring = [[-B / 2, -L / 2], [B / 2, -L / 2], [B / 2, L / 2], [-B / 2, L / 2], [-B / 2, -L / 2]].map(([x, z]) => ({ x, z }));
    const ringPts = BP.densify(ring, 6).map((p) => ({ x: p.x, z: p.z, u: p.s }));
    const outlineMat = ribbonMaterial(col, { opacity: 1, dash: 12, speed: 3, fill: 0.55, duty: 0.7 });
    const outline = new Ribbon(ringPts.length + 1, outlineMat, { width: 2.2, widthK: 0.006, widthMax: 10, closed: true });
    outline.setPoints(ringPts);
    // a soft fill inside the outline (pulses brighter once you are alongside and slow enough to moor)
    const fillMat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide });
    const fill = new THREE.Mesh(new THREE.PlaneGeometry(B, L).rotateX(-Math.PI / 2), fillMat); fill.renderOrder = 5;
    // chevrons on the approach side (laid out in the berth's own frame: −z = the approach heading)
    const chevMat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide });
    const cw = Math.max(6, T.beam * 0.9), cd = Math.max(4, T.beam * 0.45);
    const chevGeo = chevronGeometry(cw, cd, Math.max(1.2, cw * 0.14));
    const chevs = [];
    for (let k = 0; k < 3; k++) { const m = new THREE.Mesh(chevGeo, chevMat.clone()); m.renderOrder = 6; m.position.set(0, 0, L / 2 + 8 + k * (cd + 6)); chevs.push(m); }
    // a solid arrow head inside the outline at the bow end
    const head = new THREE.Mesh(chevronGeometry(B * 0.7, Math.min(L * 0.25, B * 0.6), B * 0.7 * 0.16), chevMat.clone()); head.position.set(0, 0, -L / 2 + Math.min(L * 0.25, B * 0.6) * 0.6 + 2); head.renderOrder = 6;
    const axis = new THREE.Group(); axis.add(fill, outline.mesh, ...chevs, head);
    // board on a pole + light column
    const poleH = Math.max(14, Math.min(40, T.len * 0.25 + 10));
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, poleH, 8).translate(0, poleH / 2, 0), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.85, depthWrite: false }));
    const board = makeLabel(this.boardText(), T.fits ? '#8dffc0' : '#ffd08a', 40, { height: 7, minPx: 26, maxPx: 40 });
    board.position.set(0, poleH, 0); board.renderOrder = 9;
    const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 20, 1, true).translate(0, 0.5, 0);
    const beam = new THREE.Mesh(beamGeo, new THREE.ShaderMaterial({ uniforms: { uColor: { value: new THREE.Color(col) }, uOpacity: { value: 0.4 } }, vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    beam.frustumCulled = false; beam.renderOrder = 4;
    g.add(axis, pole, board, beam);
    this.group.add(g);
    this.marker = { group: g, axis, outline, outlineMat, fill, fillMat, chevs, head, pole, board, beam, poleH, L, B, text: this.boardText(), fits: T.fits };
    this.orientMarker();
  }
  boardText() { const nb = this.target?.nb; return nb ? `${nb.name || 'Berth'}${nb.fits === false ? ' · does not fit' : ''}` : 'Berth'; }
  orientMarker() {
    const M = this.marker, T = this.target; if (!M || !T) return;
    const hdg = this.plan ? this.plan.approachHdg : T.hdg;
    M.group.position.set(T.x, 0, T.z);
    M.axis.rotation.set(0, -hdg * D2R, 0); // local −z → the approach heading
  }
  drawMarker(gx, gz, cam, t, level, departing, now) {
    const M = this.marker, T = this.target; if (!M || !T) return;
    if (M.fits !== T.fits || M.text !== this.boardText()) { this.buildMarker(); return this.drawMarker(gx, gz, cam, t, level, departing, now); }
    M.group.visible = true;
    this.orientMarker();
    const wx = gx + T.x, wz = gz + T.z;
    const y = surfaceHeightAt(wx, wz, t);
    const info = this.info || {}, d = info.remaining ?? 1e9;
    const interior = !!this.app.interior?.active;
    // berths lie in sheltered water: the whole marker sits on the surface at the berth (outline flat, width by distance)
    M.axis.position.y = y;
    M.fill.position.y = 0.2; for (const c of M.chevs) c.position.y = FLOAT_Y; M.head.position.y = FLOAT_Y;
    M.outline.update(wx, wz, cam, t, 0, true);
    const pulse = 0.5 + 0.5 * Math.sin(t * 2.4);
    const close = d <= (INTERACT.BERTH_RANGE_U || 60) && (info.spd ?? 9) <= 2;
    M.fillMat.opacity = departing ? 0.06 : close ? 0.22 + 0.2 * pulse : 0.1 + 0.08 * pulse;
    M.outlineMat.uniforms.uOpacity.value = departing ? 0.45 : 1;
    M.outlineMat.uniforms.uTime.value = t;
    M.chevs.forEach((c, k) => { c.visible = !departing; c.material.opacity = 0.25 + 0.75 * Math.max(0, Math.sin(t * 3 + k * 0.9)); }); // the outer one lights first: flowing in
    M.head.visible = !departing; M.head.material.opacity = 0.55 + 0.3 * pulse;
    M.pole.position.y = y; M.board.position.y = y + M.poleH;
    M.pole.visible = M.board.visible = !interior || d > 200;
    // light column: tall and visible from far out, gone when close
    const H = Math.max(80, Math.min(1600, d * 0.08)), R = Math.max(2.5, d * 0.003);
    M.beam.visible = d > 350 && !departing;
    M.beam.scale.set(R, H, R); M.beam.position.y = y;
    M.beam.material.uniforms.uOpacity.value = (0.3 + 0.18 * Math.sin(t * 2.2)) * Math.min(1, (d - 350) / 600);
  }
  disposeMarker() {
    const M = this.marker; if (!M) return;
    this.group.remove(M.group);
    M.group.traverse((o) => { if (o.isSprite) { o.material.map?.dispose(); o.material.dispose(); } else if (o.isMesh) { o.geometry?.dispose(); o.material?.dispose?.(); } });
    this.marker = null;
  }

  // ---------------------------------------------------------------- 3D: fairway lanes + buoy lines
  updateLanes(entry, you, s, ashore, gx, gz, cam, t, level) {
    if (!entry) { if (this.lanes) this.lanes.group.visible = false; return; }
    if (!this.lanes || this.lanes.entry !== entry) { this.disposeLanes(); this.lanes = this.buildLanes(entry); }
    const Ln = this.lanes; if (!Ln) return;
    const a = entry.geom?.anchor || entry.origin, me = this.xz(s.lat, s.lon), ap = this.xz(a.lat, a.lon);
    const d = Math.hypot(me.x - ap.x, me.z - ap.z);
    const on = !you.docked && !ashore && !you.rescue && d < LANES_M;
    Ln.group.visible = on;
    if (!on) return;
    const fade = Math.min(1, (LANES_M - d) / 800);
    for (const r of Ln.ribbons) { r.mesh.material.uniforms.uTime.value = t; r.mesh.material.uniforms.uOpacity.value = r.baseOpacity * fade; }
    // ride the waves; ribbons far from the camera only need a refresh now and then
    Ln.tick = (Ln.tick + 1) % 4;
    Ln.ribbons.forEach((r, k) => { if (k % 4 === Ln.tick || r.nearCam) r.update(gx, gz, cam, t, level); });
    for (const r of Ln.ribbons) { const c = r.center; r.nearCam = c && Math.hypot(gx + c.x - cam.x, gz + c.z - cam.z) < WAVE_NEAR_M + r.radius; }
  }
  buildLanes(entry) {
    const fw = entry.geom?.fairway;
    if (!Array.isArray(fw) || fw.length < 2) return null;
    const pts = fw.map((p) => this.xz(p[0], p[1]));
    const group = new THREE.Group(); group.name = 'fairwayLanes'; this.group.add(group);
    const half = this.fairwayHalf(entry, pts);
    const ribbons = [];
    const add = (poly, color, opts, ribOpts) => {
      if (poly.length < 2) return;
      const rs = BP.densify(poly, 10).map((p) => ({ x: p.x, z: p.z, u: p.s }));
      const r = new Ribbon(rs.length, ribbonMaterial(color, opts), ribOpts);
      r.setPoints(rs); r.baseOpacity = opts.opacity;
      let cx = 0, cz = 0; for (const p of rs) { cx += p.x; cz += p.z; } cx /= rs.length; cz /= rs.length;
      r.center = { x: cx, z: cz }; r.radius = Math.max(...rs.map((p) => Math.hypot(p.x - cx, p.z - cz)));
      group.add(r.mesh); ribbons.push(r);
    };
    // the fairway runs from the anchor (inside) out to sea; skip its first leg inside the basin (anchor → entrance)
    const lane = pts.length > 2 ? pts.slice(1) : pts;
    const edge = (sign) => offsetPolyline(lane, sign * half);
    add(edge(1), COL.lane, { opacity: 0.6, dash: 16, speed: 0, fill: 0.0, duty: 0.55 }, { width: 1.6, widthK: 0.004, widthMax: 14 });
    add(edge(-1), COL.lane, { opacity: 0.6, dash: 16, speed: 0, fill: 0.0, duty: 0.55 }, { width: 1.6, widthK: 0.004, widthMax: 14 });
    add(lane, COL.lane, { opacity: 0.32, dash: 40, speed: 0, fill: 0.0, duty: 0.35 }, { width: 1.0, widthK: 0.003, widthMax: 10 });
    // lateral buoy lines: same-side buoys in order along the fairway, joined while they are < 700 m apart
    const buoys = (entry.geom?.features?.buoys || []).filter((b) => b && Number.isFinite(b.lat) && /lateral_(port|starboard)/.test(b.kind || ''));
    for (const side of ['lateral_port', 'lateral_starboard']) {
      const list = buoys.filter((b) => b.kind === side).map((b) => { const p = this.xz(b.lat, b.lon); const pr = BP.projectOnPolyline(pts, p); return { ...p, along: pr.along, off: pr.dist, color: b.color }; })
        .filter((b) => b.off < 600).sort((x, y) => x.along - y.along);
      let run = [];
      const flush = () => { if (run.length >= 2) add(run, colorOf(run[0].color, side), { opacity: 0.85, dash: 10, speed: 0, fill: 0.5, duty: 0.6 }, { width: 1.3, widthK: 0.004, widthMax: 12 }); run = []; };
      for (const b of list) { if (run.length && Math.hypot(b.x - run[run.length - 1].x, b.z - run[run.length - 1].z) > 700) flush(); run.push(b); }
      flush();
    }
    return { entry, group, ribbons, tick: 0, half };
  }
  /** Fairway half-width from the mask (median of perpendicular probes), else the harbour-size default. */
  fairwayHalf(entry, pts) {
    const size = this.app.world?.harbors?.find?.((h) => h.id === entry.id)?.size;
    const def = FAIR_HALF[size] ?? 45, n = entry.n, res = entry.res, widths = [];
    const maskAt = (x, z) => { const i = Math.floor(x / res + n / 2), j = Math.floor(z / res + n / 2); return i < 0 || j < 0 || i >= n || j >= n ? -1 : entry.mask[j * n + i]; };
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k], b = pts[k + 1], L = Math.hypot(b.x - a.x, b.z - a.z); if (L < 30) continue;
      const ux = (b.x - a.x) / L, uz = (b.z - a.z) / L;
      for (let f = 0.25; f < 1; f += 0.25) {
        const cx = a.x + (b.x - a.x) * f, cz = a.z + (b.z - a.z) * f;
        if (maskAt(cx, cz) !== BP.MASK.FAIRWAY) continue;
        const side = (sg) => { let w = 0; while (w < 200 && maskAt(cx - uz * sg * (w + 5), cz + ux * sg * (w + 5)) === BP.MASK.FAIRWAY) w += 5; return w; };
        const l = side(1), r = side(-1); if (l > 0 && r > 0 && l < 200 && r < 200) widths.push((l + r) / 2);
      }
    }
    if (widths.length < 2) return def;
    widths.sort((x, y) => x - y);
    const med = widths[widths.length >> 1];
    return med >= 15 ? Math.min(med + 5, def * 1.5) : def;
  }
  disposeLanes() { const Ln = this.lanes; if (!Ln) return; this.group.remove(Ln.group); for (const r of Ln.ribbons) r.dispose(); this.lanes = null; }

  // ---------------------------------------------------------------- HUD card
  /**
   * hud.showBerth hook: nb = the berth being guided to (null: the card shows something else or hides). Builds the guidance
   * layout inside #berthLine once (class `bg` switches the plain text line off) and refreshes it.
   */
  renderCard(el, nb) {
    if (!el) return;
    const info = this.info, on = !!nb && !!info && !!this.target;
    el.classList.toggle('bg', on);
    if (!on) return;
    let c = el.querySelector('.bgCard');
    if (!c) {
      c = document.createElement('div'); c.className = 'bgCard';
      c.innerHTML = `<canvas class="bgPlan" width="240" height="240" aria-label="Harbour plan: your ship, the berth and the leading line"></canvas>
        <div class="bgMain">
          <div class="bgHead"><span class="bgName"></span><span class="bgChip hidden"></span></div>
          <div class="bgBig"><b class="bgDist">—</b><span class="bgSteer"><span class="bgArrow">${ic('arrowUp')}</span><span class="bgSteerTxt"></span></span></div>
          <div class="bgFacts"></div>
          <div class="bgAdvice"></div>
        </div>`;
      el.insertBefore(c, el.querySelector('.berthBtns'));
      this.card = { root: c, plan: c.querySelector('.bgPlan'), name: c.querySelector('.bgName'), chip: c.querySelector('.bgChip'), dist: c.querySelector('.bgDist'), arrow: c.querySelector('.bgArrow'), steer: c.querySelector('.bgSteerTxt'), facts: c.querySelector('.bgFacts'), advice: c.querySelector('.bgAdvice') };
    }
    const K = this.card, set = (e, t) => { if (e && e.textContent !== t) e.textContent = t; };
    const harbor = String(nb.harborName || '').split(' (')[0];
    set(K.name, `${nb.name || 'Berth'}${harbor ? ' · ' + harbor : ''}`);
    K.chip.classList.toggle('hidden', !nb.contract); set(K.chip, 'contract');
    set(K.dist, fmtD(info.remaining));
    const t = Math.round(info.turn), turnTxt = info.departing ? '' : Math.abs(t) < 5 ? 'on course' : `${this.app.hud?.touch ? '' : 'turn '}${t < 0 ? 'left' : 'right'} ${Math.abs(t)}°`;
    set(K.steer, info.departing ? `bears ${pad3(nb.brg ?? info.steer)}°` : `${this.app.hud?.touch ? '' : 'steer '}${pad3(info.steer)}° · ${turnTxt}`);
    K.arrow.style.transform = `rotate(${info.departing ? 0 : t}deg)`;
    K.arrow.classList.toggle('ok', Math.abs(t) < 5);
    const water = info.water, okDepth = water == null || water >= info.draft + (nb.mh ? Math.max(0.1, 0.05 * info.draft) : 0.3);   // marinas: small-craft clearance (shared/mharbour.js ukcFor)
    set(K.facts, `${water == null ? 'Depth —' : `Water ${water.toFixed(1)} m${nb.depthSrc === 'est.' ? ' (est.)' : ''}`} · you draw ${info.draft} m${okDepth ? '' : ' — too shallow'}${nb.box ? ` · ${nb.box.len} × ${nb.box.w} m box` : Number.isFinite(nb.length) ? ` · ${Math.round(nb.length)} m quay` : ''}${nb.mh && nb.fee ? ` · ${nb.fee} cr/night` : ''}`);
    K.facts.classList.toggle('bad', !okDepth);
    // advice: the one thing to do now
    let adv, cls;
    if (nb.fits === false) { adv = nb.why || 'No berth here takes your ship.'; cls = 'bad'; }
    else if (info.departing) { adv = 'Leaving harbour: follow the fairway out. The guide comes back when you head in.'; cls = ''; }
    else if (info.remaining <= (INTERACT.BERTH_RANGE_U || 60) && info.spd <= 2) { adv = this.app.hud?.touch ? 'Alongside: tap Moor' : 'Alongside: press Moor (T)'; cls = 'good'; }
    else if (info.spd > info.adv.maxKn + 0.3) { adv = `${info.adv.text} (now ${info.spd.toFixed(1)} kn)`; cls = 'warn'; }
    else if (info.off > Math.max(40, this.target.beam * 2 + 20)) { adv = `${fmtD(info.off)} off the leading line: steer ${pad3(info.steer)}°`; cls = 'warn'; }
    else if (info.shallow) { adv = 'Shallow water on the way: go slow and watch the depth'; cls = 'warn'; }
    else { adv = info.remaining > 300 ? `Follow the yellow line · ${info.adv.text.toLowerCase()}` : info.adv.text; cls = ''; }
    set(K.advice, adv); K.advice.className = `bgAdvice ${cls}`;
    const now = performance.now();
    if (now - this.cardAt > 250) { this.cardAt = now; try { this.drawPlan(K.plan); } catch (e) { if (!this.planWarned) { this.planWarned = true; console.warn('[berthguide] plan draw failed', e); } } }
  }
  /** Mini top-down harbour plan, north up: quays and land from the patch mask, the leading line, the berth, your ship. */
  drawPlan(cv) {
    const T = this.target, s = this.app.ship; if (!cv || !T || !s || !this.frame) return;
    const r = cv.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.max(48, Math.round((r.width || 120) * dpr)); if (cv.width !== W) { cv.width = W; cv.height = W; }
    const x = cv.getContext('2d'); if (!x) return;
    const me = this.xz(s.lat, s.lon);
    const cx = (me.x + T.x) / 2, cz = (me.z + T.z) / 2;
    const ext = Math.max(320, Math.min(9000, Math.max(Math.abs(me.x - T.x), Math.abs(me.z - T.z)) * 1.35 + 160));
    const k = W / ext, X = (px) => (px - cx) * k + W / 2, Z = (pz) => (pz - cz) * k + W / 2;
    x.fillStyle = `rgb(${PLAN_COL.water.join(',')})`; x.fillRect(0, 0, W, W);
    const e = this.frame.entry;
    if (e) {
      const base = planBase(e), half = (e.n * e.res) / 2;
      // source rect of the view in patch pixels, clipped to the image (and the destination with it)
      let sx0 = (cx - ext / 2 + half) / e.res, sz0 = (cz - ext / 2 + half) / e.res, sx1 = sx0 + ext / e.res, sz1 = sz0 + ext / e.res;
      const cx0 = Math.max(0, sx0), cz0 = Math.max(0, sz0), cx1 = Math.min(e.n, sx1), cz1 = Math.min(e.n, sz1);
      if (cx1 > cx0 && cz1 > cz0) {
        const dx0 = ((cx0 - sx0) / (sx1 - sx0)) * W, dz0 = ((cz0 - sz0) / (sz1 - sz0)) * W, dx1 = ((cx1 - sx0) / (sx1 - sx0)) * W, dz1 = ((cz1 - sz0) / (sz1 - sz0)) * W;
        x.imageSmoothingEnabled = ext > e.n * e.res * 0.4;
        x.drawImage(base, cx0, cz0, cx1 - cx0, cz1 - cz0, dx0, dz0, dx1 - dx0, dz1 - dz0);
      }
    } else {
      // no harbour patch (inland harbours, quays): land from the world tiles in memory, re-rastered at most once a second
      const land = this.tileLand(cx, cz, ext);
      if (land) { x.imageSmoothingEnabled = false; x.drawImage(land, 0, 0, W, W); }
    }
    // inland harbours (mharbour.js): pontoons, finger piers, quays and gangways at their real width
    const segs = this.app.mharbour?.segmentsNear?.(s.lat, s.lon, ext) || [];
    if (segs.length) {
      x.save(); x.lineCap = 'butt';
      for (const g of segs) {
        const a = this.xz(g.a[0], g.a[1]), b = this.xz(g.b[0], g.b[1]);
        x.strokeStyle = g.k === 'quay' ? `rgb(${PLAN_COL.quay.join(',')})` : g.k === 'gang' ? '#a89c84' : '#d8d2c4';
        x.lineWidth = Math.max(g.k === 'finger' ? 0.6 : 1.2, g.w * k);
        x.beginPath(); x.moveTo(X(a.x), Z(a.z)); x.lineTo(X(b.x), Z(b.z)); x.stroke();
      }
      x.restore();
    }
    // leading line
    const P = this.plan;
    if (P && P.pts.length >= 2 && !this.depart) {
      x.save(); x.strokeStyle = '#ffd34a'; x.lineWidth = Math.max(1.5, W / 90); x.setLineDash([W / 30, W / 50]); x.lineCap = 'round';
      x.beginPath(); P.pts.forEach((p, i) => (i ? x.lineTo(X(p.x), Z(p.z)) : x.moveTo(X(p.x), Z(p.z)))); x.stroke(); x.restore();
    }
    // berth: the ship-size box, at least a few pixels
    const box = (px, pz, hdg, L, B, fill, stroke, bow) => {
      x.save(); x.translate(X(px), Z(pz)); x.rotate(hdg * D2R);
      const l = Math.max(W / 22, L * k), b = Math.max(W / 60, B * k);
      x.beginPath();
      if (bow) { x.moveTo(0, -l / 2); x.lineTo(b / 2, -l / 2 + b * 0.7); x.lineTo(b / 2, l / 2); x.lineTo(-b / 2, l / 2); x.lineTo(-b / 2, -l / 2 + b * 0.7); x.closePath(); }
      else x.rect(-b / 2, -l / 2, b, l);
      x.fillStyle = fill; x.fill(); x.lineWidth = Math.max(1, W / 120); x.strokeStyle = stroke; x.stroke(); x.restore();
    };
    const pulse = 0.55 + 0.45 * Math.sin(performance.now() / 300);
    box(T.x, T.z, P ? P.approachHdg : T.hdg, T.len, T.beam, `rgba(79,227,154,${0.25 + 0.3 * pulse})`, T.fits ? '#4fe39a' : '#f2a134', false);
    box(me.x, me.z, s.hdg, T.len, T.beam, '#ffffff', '#0b1a26', true);
    // north + scale
    x.fillStyle = 'rgba(255,255,255,0.75)'; x.font = `600 ${Math.round(W / 11)}px system-ui, sans-serif`; x.textAlign = 'center'; x.textBaseline = 'top';
    x.fillText('N', W - W / 12, W / 40);
    const bar = niceScale(ext / 4), bw = bar * k;
    x.fillRect(W / 20, W - W / 14, bw, Math.max(1, W / 120)); x.textAlign = 'left'; x.textBaseline = 'bottom'; x.font = `${Math.round(W / 13)}px system-ui, sans-serif`;
    x.fillText(bar >= 1000 ? `${bar / 1000} km` : `${bar} m`, W / 20, W - W / 12);
  }

  /** 64 × 64 land / water raster of the plan's view from the world tiles (app.terrain.wtiles.maskAt), cached ~1 s. */
  tileLand(cx, cz, ext) {
    const wt = this.app.terrain?.wtiles; if (!wt?.maskAt || !this.frame) return null;
    const now = performance.now(), key = `${Math.round(cx / 20)}|${Math.round(cz / 20)}|${Math.round(ext / 20)}`;
    if (this._land && (this._land.key === key || now - this._land.at < 1000)) return this._land.cv;
    const N = 64, cv = this._land?.cv || document.createElement('canvas'); cv.width = N; cv.height = N;
    const g = cv.getContext('2d'), img = g.createImageData(N, N), f = this.frame;
    let known = 0;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const px = cx - ext / 2 + ((i + 0.5) * ext) / N, pz = cz - ext / 2 + ((j + 0.5) * ext) / N;
      let m = null; try { m = wt.maskAt(f.lat - pz / GEO.M_PER_DEG_LAT, f.lon + px / f.k); } catch { m = null; }
      const o = (j * N + i) * 4;
      if (m == null) { img.data[o + 3] = 0; continue; }
      known++;
      const c = m === 0 || m === 5 || m === 6 || m === 7 || m === 8 || m === 9 ? (m === 5 ? PLAN_COL.fairway : PLAN_COL.water) : m === 2 || m === 3 ? PLAN_COL.quay : m === 4 ? PLAN_COL.pontoon : PLAN_COL.land;
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    this._land = { key, at: now, cv };
    return known ? cv : null;
  }
  /** Debug / test hook: the current plan in lat/lon plus timings. */
  debug() {
    const P = this.plan, f = this.frame; if (!f) return null;
    const ll = (p) => ({ lat: f.lat - p.z / GEO.M_PER_DEG_LAT, lon: f.lon + p.x / f.k });
    return { target: this.target ? { id: this.target.nb.id, name: this.target.nb.name, fits: this.target.fits } : null, info: this.info, depart: this.depart,
      plan: P ? { ok: P.ok, length: Math.round(P.length), pts: P.pts.map(ll), approachHdg: P.approachHdg, shallow: P.shallow, minClear: P.minClear } : null,
      planMs: this.planMs.slice(), lanes: this.lanes ? { ribbons: this.lanes.ribbons.length, half: this.lanes.half, visible: this.lanes.group.visible } : null,
      lineVisible: this.line.mesh.visible, markerVisible: !!this.marker?.group.visible };
  }
  dispose() { this.disposeMarker(); this.disposeLanes(); this.line.dispose(); this.app.scene.remove(this.group); }
}

function offsetPolyline(pts, d) {
  const out = [];
  for (let k = 0; k < pts.length; k++) {
    const a = pts[Math.max(0, k - 1)], b = pts[Math.min(pts.length - 1, k + 1)];
    let tx = b.x - a.x, tz = b.z - a.z; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    out.push({ x: pts[k].x - tz * d, z: pts[k].z + tx * d });
  }
  return out;
}
function colorOf(c, side) { try { if (c) return new THREE.Color(c).getHex(); } catch { /* fall through */ } return side === 'lateral_port' ? COL.red : COL.green; }
function niceScale(m) { const p = 10 ** Math.floor(Math.log10(Math.max(1, m))); const f = m / p; return (f >= 5 ? 5 : f >= 2 ? 2 : 1) * p; }
