// Contracts at sea: where each accepted job wants the skipper next (jobTargets) and how that looks in the world
// (JobLayer): a light column + range ring on every target, the disabled vessel waiting for a tow (not-under-command
// lights, hazard strobe, lying beam-on), the tow line and the casualty following astern once it is passed (own ship
// and other skippers), and the trawl warps while the nets are out.
import * as THREE from 'three';
import { SHIP_CLASSES, GOODS, INTERACT } from '/shared/constants.js';
import { haversine, bearing, destination, normDeg } from '/shared/geo.js';
import { buildShip, makeLabel } from './ship.js';
import { catchRate } from '/shared/rates.js';
import { fmtRealHM } from '/shared/jobtime.js';

const D2R = Math.PI / 180;
export const JOB_COLOR = { freight: '#5ad6ff', passengers: '#4fd18b', charter: '#b892ff', fishing: '#4fc3f7', supply: '#ffb35c', tow: '#ff7043', smuggling: '#c792ea' };
const TOW_LEN_M = 140;                 // hawser length astern of the towing ship's stern
const BEACON_MAX_M = 80000;            // light columns are drawn up to this far away
const fmtD = (m) => (m >= 10000 ? `${Math.round(m / 1000)} km` : m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
const fmtT = (t) => `${t >= 100 ? Math.round(t) : (Math.round(t * 10) / 10).toLocaleString('en-US')} t`;
const pad3 = (n) => String(Math.round(normDeg(n)) % 360).padStart(3, '0');
const shortName = (s) => String(s || '').split(' (')[0];

/** Compact card title: 'Tow · stern trawler → IJmuiden', 'Freight · 400 t grain → Hamburg' … */
export function jobShortTitle(j, harbors = []) {
  if (Array.isArray(j.steps) && j.title) return j.title;   // step-runner jobs (JOB_GEN 8) carry their own title and units
  const to = shortName(harbors.find((h) => h.id === j.to)?.name || j.to).split(' / ')[0];
  const good = GOODS[j.good]?.name.toLowerCase() || j.good;
  switch (j.type) {
    case 'tow': return `Tow · ${SHIP_CLASSES[j.victimCls]?.name.toLowerCase() || 'casualty'} → ${to}`;
    case 'supply': return `Supply · ${fmtT(j.qty)} → ${shortName(j.platformName || 'platform')}`;
    case 'fishing': return `Fishing · ${fmtT(j.qty)} from the ${shortName(j.groundName || 'bank')}`;
    case 'passengers': return `Ferry · ${j.pax} passengers → ${to}`;
    case 'charter': return `Charter · ${j.pax} guests → ${to}`;
    case 'smuggling': return `Run · ${fmtT(j.qty)} ${good} → ${to}`;
    default: return `Freight · ${fmtT(j.qty)} ${good} → ${to}`;
  }
}
/** Caught fish aboard (not contract cargo). */
export function caughtFish(you) { return (you?.cargo || []).filter((c) => c.good === 'fish' && c.caught && !c.jobId).reduce((s, c) => s + (+c.qty || 0), 0); }

/**
 * One entry per accepted contract: what to do next and where. Fields: job, type, color, kind ('harbor' | 'casualty' |
 * 'platform' | 'ground'), lat, lon, name, title, step (one line), distM, brg, rangeM (ring radius, or 0), action (null or
 * { id, label, enabled, why }), towing, leftS (V6 item 5: seconds of SHIP time left — dueShip − app.shipTimeNow(), may be
 * negative; deadlineS is the same number, kept for older callers).
 */
export function jobTargets(app) {
  const you = app.you, s = app.ship; if (!you || !s) return [];
  const out = [];
  const harbors = app.world?.harbors || [];
  const spd = Math.abs(s.spd || 0);
  const shipNow = app.shipTimeNow ? app.shipTimeNow() : (app.simTime || Date.now() / 1000);
  for (const j of you.jobs || []) {
    const leftS = Number.isFinite(j.dueShip) ? j.dueShip - shipNow : Number.isFinite(j.deadline) ? j.deadline - (app.simTime || Date.now() / 1000) : NaN;
    const t = { job: j, type: j.type, color: JOB_COLOR[j.type] || '#f2b134', kind: 'harbor', lat: NaN, lon: NaN, name: '', title: jobShortTitle(j, harbors), step: '', rangeM: 0, action: null, towing: false, leftS, deadlineS: leftS };
    const toH = harbors.find((h) => h.id === j.to);
    const toHarbor = () => { if (!toH) return false; const a = app.harborAnchor ? app.harborAnchor(toH) : toH; t.kind = 'harbor'; t.lat = a.lat; t.lon = a.lon; t.name = shortName(toH.name); return true; };
    if (j.type === 'tow') {
      const victim = SHIP_CLASSES[j.victimCls]?.name.toLowerCase() || 'disabled vessel';
      if (you.towing === j.id) {
        t.towing = true; toHarbor();
        t.step = `Tow the ${victim} to ${t.name} — harbour tugs take over ${fmtD(INTERACT.TOW_HANDOVER_M || 4000)} off the port`;
        t.rangeM = INTERACT.TOW_HANDOVER_M || 4000;
      } else if (j.at && Number.isFinite(j.at.lat)) {
        t.kind = 'casualty'; t.lat = j.at.lat; t.lon = j.at.lon; t.name = `Disabled ${victim}`;
        t.rangeM = INTERACT.TOW_RANGE_U || 300;
        t.step = `Find the disabled ${victim}, come within ${t.rangeM} m under 3 kn and pass the tow line`;
        t.action = { id: 'tow_pickup', label: 'Pass tow line', enabled: false, why: '' };
      }
    } else if (j.type === 'supply') {
      if (j.at && Number.isFinite(j.at.lat)) {
        t.kind = 'platform'; t.lat = j.at.lat; t.lon = j.at.lon; t.name = shortName(j.platformName || 'Platform');
        t.rangeM = INTERACT.PLATFORM_RANGE_U || 500;
        t.step = `Bring ${fmtT(j.qty)} of supplies to ${t.name}; hold station within ${t.rangeM} m under 3 kn for the crane`;
        t.action = { id: 'deliver_offshore', label: 'Crane transfer', enabled: false, why: '' };
      }
    } else if (j.type === 'fishing') {
      const have = caughtFish(you);
      const g = (app.world?.fishing || []).find((x) => x.id === j.ground);
      if (have + 1e-6 < j.qty && g) {
        t.kind = 'ground'; t.lat = g.lat; t.lon = g.lon; t.name = shortName(g.name); t.rangeM = g.radiusKm * 1000;
        const inside = haversine(s.lat, s.lon, g.lat, g.lon) <= t.rangeM;
        const left = Math.max(0, j.qty - have);
        const rate = you.fishInfo?.rate || catchRate(s.cls || you.ship?.cls, g.richness); // t per SHIP hour (V6 item 5)
        t.step = you.fishing
          ? `Fishing ${fmtT(have)} of ${fmtT(j.qty)}${rate > 0 ? ` · ${(Math.round(rate * 10) / 10).toLocaleString('en-US')} t/h — about ${fmtHours(left / rate)} at 1×` : ''}${you.fishInfo?.tooFast ? ' · too fast for the nets' : ''}`
          : inside ? `On the ${t.name}: nets out (F) and trawl under ${INTERACT.FISH_MAX_KN || 4} kn — ${fmtT(have)} of ${fmtT(j.qty)}` : `Sail to the ${t.name} and fish ${fmtT(j.qty)} (${fmtT(have)} aboard)`;
        if (inside && !you.fishing) t.action = { id: 'fish', label: 'Nets out', enabled: spd < (INTERACT.FISH_MAX_KN || 4), why: spd < (INTERACT.FISH_MAX_KN || 4) ? '' : `slow below ${INTERACT.FISH_MAX_KN || 4} kn` };
        else if (inside && you.fishing) t.action = { id: 'fish_off', label: 'Haul nets', enabled: true, why: '' };
      } else {
        toHarbor();
        t.step = `Land ${fmtT(Math.min(have, j.qty))} of fish at ${t.name}`;
      }
    } else if (j.stepInfo) {                                   // step-runner jobs (JOB_GEN 8): the server says where and what
      const si = j.stepInfo;
      const sh = si.at ? harbors.find((h) => h.id === si.at) : null;
      if (sh) { const a = app.harborAnchor ? app.harborAnchor(sh) : sh; t.kind = 'harbor'; t.lat = a.lat; t.lon = a.lon; t.name = shortName(sh.name); }
      else if (si.spot && Number.isFinite(si.spot.lat)) { t.kind = 'spot'; t.lat = si.spot.lat; t.lon = si.spot.lon; t.rangeM = si.spot.rM || 0; t.name = si.label || 'Work site'; }
      else { t.kind = 'here'; t.lat = s.lat; t.lon = s.lon; t.name = si.label || ''; }
      t.step = si.text;
      if (si.act === 'job_step') {
        const near = !si.spot || haversine(s.lat, s.lon, si.spot.lat, si.spot.lon) <= (si.spot.rM || 500), slow = si.maxKn == null || spd <= si.maxKn;
        t.action = { id: 'job_step', label: si.btn || 'Confirm', enabled: near && slow, why: !near ? `${fmtD(haversine(s.lat, s.lon, si.spot.lat, si.spot.lon) - (si.spot.rM || 500))} to go` : !slow ? `slow below ${si.maxKn} kn` : '' };
      }
    } else {
      toHarbor();
      const step = Array.isArray(j.steps) ? j.steps[j.prog?.i ?? 0] : null;   // step-runner jobs: the current step's own label
      if (step?.label) { t.step = step.label; } else {
      const what = j.pax ? `${j.pax} ${j.type === 'charter' ? 'charter guests' : 'passengers'}` : `${fmtT(j.qty)} of ${GOODS[j.good]?.name.toLowerCase() || j.good}`;
      t.step = `${j.type === 'smuggling' ? 'Run' : 'Deliver'} ${what} to ${t.name} — moor there to unload`;
      }
    }
    if (!Number.isFinite(t.lat)) continue;
    t.distM = haversine(s.lat, s.lon, t.lat, t.lon); t.brg = bearing(s.lat, s.lon, t.lat, t.lon);
    if (t.action && (t.action.id === 'tow_pickup' || t.action.id === 'deliver_offshore')) {
      const near = t.distM <= t.rangeM, slow = spd <= 3;
      t.action.enabled = near && slow && !you.docked && !(t.action.id === 'tow_pickup' && you.towing);
      t.action.why = you.towing && t.action.id === 'tow_pickup' ? 'one tow at a time' : !near ? `${fmtD(t.distM - t.rangeM)} to go` : !slow ? 'slow below 3 kn' : '';
    }
    out.push(t);
  }
  // most urgent first: an action you can take now, then the nearest target
  out.sort((a, b) => (b.action?.enabled ? 1 : 0) - (a.action?.enabled ? 1 : 0) || a.distM - b.distM);
  return out;
}
export function fmtHours(h) { if (!Number.isFinite(h) || h <= 0) return '—'; if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`; if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)} h`; return `${Math.round(h / 24)} days`; }
/** Ship time left on a contract: '21 h 10 min left', and while warped '21 h 10 min left · ≈ 1 h 4 m at 20×'. */
export function fmtLeft(sec, warp = 1) {
  if (!Number.isFinite(sec)) return '—';
  if (sec < 0) return 'overdue — half pay';
  const min = Math.floor(sec / 60), h = Math.floor(min / 60);
  const txt = h < 1 ? `${Math.max(1, min)} min left` : h < 48 ? `${h} h ${String(min % 60).padStart(2, '0')} min left` : `${Math.floor(h / 24)} d ${h % 24} h left`; // never round up (68 h ≠ '3 days')
  return warp > 1 ? `${txt} · ≈ ${fmtRealHM(sec / 3600 / warp)} at ${warp}×` : txt;
}
/** Distance and bearing to the target ('' on a fishing bank you are already on). */
export function jobWhere(t) {
  if (!Number.isFinite(t.distM)) return '';
  if (t.kind === 'here') return '';
  if (t.kind === 'spot' && t.distM <= t.rangeM) return 'on the spot';
  if (t.kind === 'ground') return t.distM > t.rangeM ? `${fmtD(t.distM - t.rangeM)} · ${pad3(t.brg)}°` : 'on the bank';
  return `${fmtD(t.distM)} · ${pad3(t.brg)}°`;
}

// ------------------------------------------------------------------------------------------------ 3D
const BEAM_VERT = /* glsl */`varying float vY; void main() { vY = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const BEAM_FRAG = /* glsl */`uniform vec3 uColor; uniform float uOpacity; varying float vY;
void main() { float a = uOpacity * pow(1.0 - vY, 1.6); gl_FragColor = vec4(uColor * (0.6 + 0.8 * (1.0 - vY)), a); }`;

function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(255,255,255,0.8)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.userData.shared = true; return t;
}
let GLOW = null;
function glowSprite(color, size) {
  GLOW = GLOW || glowTexture();
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: GLOW, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
  s.scale.set(size, size, 1); return s;
}

function makeBeacon(color, label) {
  const g = new THREE.Group();
  const geo = new THREE.CylinderGeometry(1, 1, 1, 20, 1, true); geo.translate(0, 0.5, 0);
  const beam = new THREE.Mesh(geo, new THREE.ShaderMaterial({ uniforms: { uColor: { value: new THREE.Color(color) }, uOpacity: { value: 0.5 } }, vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false }));
  beam.frustumCulled = false; beam.renderOrder = 4; g.add(beam);
  const ringGeo = new THREE.RingGeometry(0.985, 1, 128); ringGeo.rotateX(-Math.PI / 2);
  const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide, fog: false }));
  ring.renderOrder = 4; ring.visible = false; g.add(ring);
  const lbl = makeLabel(label, color, 34, { height: 6, minPx: 24, maxPx: 34 }); g.add(lbl);
  g.userData = { beam, ring, lbl, label, dispose() { geo.dispose(); beam.material.dispose(); ringGeo.dispose(); ring.material.dispose(); lbl.material.map?.dispose(); lbl.material.dispose(); } };
  return g;
}

/** A casualty (or a tow astern): the ship model + NUC lights + strobe. Kept in lat/lon, placed every frame. */
function makeCasualty(cls, name) {
  const mesh = buildShip(SHIP_CLASSES[cls] ? cls : 'trawler', name, 23);
  const ud = mesh.userData;
  const mastY = (ud.freeboard || 2) + Math.max(5, (ud.length || 30) * 0.14);
  const nuc1 = glowSprite(0xff2a1a, 3.2), nuc2 = glowSprite(0xff2a1a, 3.2);  // two all-round red, vertical (COLREGS 27)
  nuc1.position.set(0, mastY, 0); nuc2.position.set(0, mastY + 2.2, 0);
  const strobe = glowSprite(0xffa040, 9); strobe.position.set(0, mastY + 4, 0);
  mesh.add(nuc1, nuc2, strobe);
  return { mesh, nuc: [nuc1, nuc2], strobe, vis: { heave: 0, pitch: 0, roll: 0 }, lat: NaN, lon: NaN, hdg: 0, cls };
}

/** The hawser: two crossed ribbons (flat + upright) along a catenary, so it reads from above and from the side. */
const TOW_W = 0.7;
function makeTowLine() {
  const n = 28, geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 4 * 3), 3));
  const idx = [];
  for (let r = 0; r < 2; r++) for (let i = 0; i < n - 1; i++) { const a = r * n * 2 + i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  geo.setIndex(idx);
  const line = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xe8c547, side: THREE.DoubleSide }));
  line.frustumCulled = false; line.userData.n = n;
  return line;
}

function makeNets(L, B, deckY) {
  const g = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({ color: 0x2b2b2b });
  for (const side of [-1, 1]) {
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(side * B * 0.32, deckY, L * 0.48), new THREE.Vector3(side * B * 0.9, -2, L * 0.5 + 90), new THREE.Vector3(side * B * 1.2, -18, L * 0.5 + 170)]);
    g.add(new THREE.Line(geo, mat));
  }
  const buoy = new THREE.Mesh(new THREE.SphereGeometry(0.8, 10, 8), new THREE.MeshStandardMaterial({ color: 0xff6a00, emissive: 0x331000 }));
  buoy.position.set(0, 0.3, L * 0.5 + 120); g.add(buoy);
  g.visible = false;
  g.userData.dispose = () => { mat.dispose(); buoy.geometry.dispose(); buoy.material.dispose(); g.children.forEach((c) => c.geometry?.dispose()); };
  return g;
}

export class JobLayer {
  constructor(app) {
    this.app = app;
    this.group = new THREE.Group(); app.scene.add(this.group);
    this.beacons = new Map();    // key → beacon group
    this.casualties = new Map(); // key (job id, or 'p:' + player id) → casualty
    this.lines = new Map();      // key → tow line
    this.targets = [];
  }
  setTargets(targets) { this.targets = targets || []; }
  /** Per frame (after the ships are placed): beacons, casualties waiting, tows astern, nets. */
  update(dt) {
    const app = this.app, you = app.you, s = app.ship;
    if (!you || !s || !app.myMesh) return;
    const t = app.time || 0, night = app.night || 0;
    const seen = new Set();
    // ---- beacons
    for (const tg of this.targets) {
      const key = `${tg.job.id}:${tg.kind}`;
      if (tg.kind === 'ground' && tg.distM <= tg.rangeM) continue;          // on the bank: the HUD says so
      if (tg.kind === 'here') continue;                                      // a runner step with no place (hire hours, drills): no beacon
      if (tg.distM > BEACON_MAX_M || (tg.kind === 'harbor' && tg.distM < 1200)) continue; // berth guidance takes over
      seen.add(key);
      let b = this.beacons.get(key);
      const base = this.labelFor(tg);
      if (!b || b.userData.label !== base) { if (b) this.dropBeacon(key); b = makeBeacon(tg.color, base); this.beacons.set(key, b); this.group.add(b); }
      app.place(b, tg.lat, tg.lon, app.tideLevel || 0);
      const d = tg.distM, ud = b.userData;
      if (t - (ud.textAt ?? -9) > 1) { ud.textAt = t; ud.lbl.userData.setText?.(`${base} · ${fmtD(d)}`); }
      const H = Math.max(160, Math.min(2400, d * 0.06)), R = Math.max(3, d * 0.0028);
      ud.beam.scale.set(R, H, R);
      ud.beam.material.uniforms.uOpacity.value = (0.35 + 0.25 * Math.sin(t * 2.2)) * Math.min(1, d / 400 + 0.2) * (0.7 + 0.3 * night);
      ud.lbl.position.set(0, Math.min(H * 0.55, 60 + d * 0.01), 0);
      const showRing = tg.rangeM > 0 && tg.rangeM < 6000 && d < 12000;
      ud.ring.visible = showRing;
      if (showRing) { const k = 1 + 0.02 * Math.sin(t * 3); ud.ring.scale.set(tg.rangeM * k, 1, tg.rangeM * k); ud.ring.position.y = 0.6; }
    }
    for (const key of [...this.beacons.keys()]) if (!seen.has(key)) this.dropBeacon(key);
    // ---- casualties: waiting at their position, or astern of the towing ship (own and other skippers)
    const want = new Map();
    for (const j of you.jobs || []) if (j.type === 'tow' && j.at && Number.isFinite(j.at.lat)) {
      const astern = you.towing === j.id;
      const d = haversine(s.lat, s.lon, j.at.lat, j.at.lon);
      if (astern || d < 25000) want.set(j.id, { cls: j.victimCls, at: j.at, tower: astern ? { mesh: app.myMesh, lat: s.lat, lon: s.lon, hdg: s.hdg, spd: s.spd } : null, name: `${SHIP_CLASSES[j.victimCls]?.name || 'Casualty'} · ${astern ? 'in tow' : 'not under command'}` });
    }
    for (const o of app.others?.values?.() || []) if (o.towCls && o.cur) want.set(`p:${o.id}`, { cls: o.towCls, at: null, tower: { mesh: o.mesh, lat: o.cur.lat, lon: o.cur.lon, hdg: o.cur.hdg, spd: o.cur.spd }, name: `${SHIP_CLASSES[o.towCls]?.name || 'Casualty'} · in tow` });
    for (const [key, w] of want) {
      let c = this.casualties.get(key);
      if (!c || c.cls !== w.cls) { if (c) this.dropCasualty(key); c = makeCasualty(w.cls, w.name); this.casualties.set(key, c); this.group.add(c.mesh); }
      if (c.mesh.userData.label && c.labelText !== w.name) { c.mesh.userData.label.userData.setText?.(w.name); c.labelText = w.name; }
      if (w.tower) this.followAstern(key, c, w.tower, dt);
      else {
        // lying stopped, beam-on to the wind, yawing a little
        c.lat = w.at.lat; c.lon = w.at.lon;
        const windFrom = app.localWind?.dir ?? app.wind?.dir ?? 240;
        c.hdg = normDeg(windFrom + 90 + 6 * Math.sin(t * 0.13 + 1.3));
        const ln = this.lines.get(key); if (ln) { this.group.remove(ln); ln.geometry.dispose(); ln.material.dispose(); this.lines.delete(key); }
      }
      app.shipVisual(c.mesh, c.lat, c.lon, c.hdg, w.tower ? w.tower.spd : 0, c.vis, w.tower ? 0.05 : 0.14, dt, false);
      c.mesh.userData.setLights?.(night);
      const nucK = 0.25 + 0.75 * night; for (const n of c.nuc) n.material.opacity = nucK;
      c.strobe.material.opacity = (Math.sin(t * 5.2) > 0.82 ? 1 : 0.0) * (w.tower ? 0 : 1);
      if (w.tower) this.drawLine(key, w.tower.mesh, c);
    }
    for (const key of [...this.casualties.keys()]) if (!want.has(key)) this.dropCasualty(key);
    // ---- nets: own ship and others with their nets out
    this.nets(app.myMesh, !!you.fishing && !you.docked);
    for (const o of app.others?.values?.() || []) this.nets(o.mesh, !!o.fishing && !o.docked);
  }
  labelFor(tg) { return tg.kind === 'casualty' ? 'Casualty' : tg.towing ? `Tow to ${tg.name}` : tg.name; }
  /** The casualty follows the stern at the hawser length like a weight on a rope (no slack held, swings in turns). */
  followAstern(key, c, tw, dt) {
    const L = tw.mesh?.userData?.length || 60;
    const stern = destination(tw.lat, tw.lon, normDeg(tw.hdg + 180), L / 2);
    const Lc = SHIP_CLASSES[c.cls]?.length || 30;
    if (!Number.isFinite(c.lat) || haversine(c.lat, c.lon, stern.lat, stern.lon) > 2000) { // first frame / teleport: lay it out astern
      const p = destination(stern.lat, stern.lon, normDeg(tw.hdg + 180), TOW_LEN_M + Lc / 2); c.lat = p.lat; c.lon = p.lon; c.hdg = tw.hdg;
    }
    const bow = destination(c.lat, c.lon, c.hdg, Lc / 2);
    const dist = haversine(bow.lat, bow.lon, stern.lat, stern.lon);
    if (dist > TOW_LEN_M) { // pulled: the bow moves straight toward the stern until the hawser is at length
      const brg = bearing(bow.lat, bow.lon, stern.lat, stern.lon);
      const nb = destination(bow.lat, bow.lon, brg, dist - TOW_LEN_M);
      c.hdg = normDeg(c.hdg + THREE.MathUtils.clamp(((brg - c.hdg + 540) % 360) - 180, -40 * dt, 40 * dt));
      const nc = destination(nb.lat, nb.lon, normDeg(c.hdg + 180), Lc / 2); c.lat = nc.lat; c.lon = nc.lon;
    }
    c.slack = THREE.MathUtils.clamp(1 - (dist - TOW_LEN_M * 0.92) / (TOW_LEN_M * 0.08), 0, 1);
  }
  drawLine(key, towMesh, c) {
    let ln = this.lines.get(key);
    if (!ln) { ln = makeTowLine(); this.lines.set(key, ln); this.group.add(ln); }
    towMesh.updateMatrixWorld(); c.mesh.updateMatrixWorld();
    const a = new THREE.Vector3(0, (towMesh.userData.freeboard || 2) + 0.5, (towMesh.userData.length || 40) * 0.5).applyMatrix4(towMesh.matrixWorld);
    const b = new THREE.Vector3(0, (c.mesh.userData.freeboard || 2) + 0.3, -(c.mesh.userData.length || 30) * 0.5).applyMatrix4(c.mesh.matrixWorld);
    const pos = ln.geometry.attributes.position, n = ln.userData.n;
    const sag = 1 + 4 * (c.slack ?? 0.5); // a slack hawser dips toward the water, a taut one runs nearly straight
    const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz) || 1, px = (-dz / L) * TOW_W / 2, pz = (dx / L) * TOW_W / 2;
    for (let i = 0; i < n; i++) {
      const f = i / (n - 1);
      const x = a.x + dx * f, y = a.y + (b.y - a.y) * f - sag * 4 * f * (1 - f), z = a.z + dz * f;
      pos.setXYZ(i * 2, x - px, y, z - pz); pos.setXYZ(i * 2 + 1, x + px, y, z + pz);                 // flat ribbon
      pos.setXYZ(n * 2 + i * 2, x, y - TOW_W / 2, z); pos.setXYZ(n * 2 + i * 2 + 1, x, y + TOW_W / 2, z); // upright ribbon
    }
    pos.needsUpdate = true; ln.geometry.computeBoundingSphere();
  }
  nets(mesh, on) {
    if (!mesh) return;
    const ud = mesh.userData;
    if (!on) { if (ud.jobNets) ud.jobNets.visible = false; return; }
    if (!ud.jobNets) { ud.jobNets = makeNets(ud.length || 40, ud.beam || 8, (ud.freeboard || 2) + 0.5); mesh.add(ud.jobNets); }
    ud.jobNets.visible = true;
  }
  dropBeacon(key) { const b = this.beacons.get(key); if (!b) return; this.group.remove(b); b.userData.dispose(); this.beacons.delete(key); }
  dropCasualty(key) {
    const c = this.casualties.get(key); if (!c) return;
    this.group.remove(c.mesh); if (c.mesh.userData.wakeGroup?.parent) c.mesh.userData.wakeGroup.parent.remove(c.mesh.userData.wakeGroup); c.mesh.userData.dispose?.();
    for (const sp of [...c.nuc, c.strobe]) sp.material.dispose();
    this.casualties.delete(key);
    const ln = this.lines.get(key); if (ln) { this.group.remove(ln); ln.geometry.dispose(); ln.material.dispose(); this.lines.delete(key); }
  }
  /** The casualty of the player's own tow job as a world position (for collision / camera checks), or null. */
  casualtyOf(jobId) { const c = this.casualties.get(jobId); return c && Number.isFinite(c.lat) ? { lat: c.lat, lon: c.lon, hdg: c.hdg } : null; }
}
