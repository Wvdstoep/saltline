// Hostile AI ships, client layer (docs/HOSTILE-AI-CONTRACT.md R14): the risk chip in the top bar, the warning banner with the
// defence buttons, the 3D units from snap.hostiles (skiffs, patrol craft, warships built by ship.js), muzzle flashes / splashes /
// hits, the radar and chart markers and the sound cues. Loaded lazily by main.js; every entry point is wrapped so a problem here
// never takes the helm down.
import { ShipSmoke } from './shipsmoke.js';
import * as THREE from 'three';
import { buildShip } from './ship.js';
import { ic } from './icons.js';
import { unitLabel, unitColor, bannerModel, bannerHTML, chipModel, riskBlockHTML, expressWarning } from './hostilefmt.js';
import { HOSTILE_TEXT } from '/shared/hostile.js';
import { routeExposure } from '/shared/politics.js';

const $ = (id) => document.getElementById(id);
const hashStr = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); };
const MAX_FX = 10;

export class HostileLayer {
  constructor(app) {
    this.app = app;
    this.units = new Map();      // id → { id, k, f, mesh, samples, cur, vis, fireStamp }
    this.fx = [];                // live effects
    this.pool = [];
    this.lastBanner = ''; this.lastChip = ''; this.alertUntil = 0;
    this.shape = {}; this.smokeFx = null; this.boarders = null; this.hitUntil = 0; this.bino = null;
    this.inject();
  }
  inject() {
    if (!$('hostileCss')) { const l = document.createElement('link'); l.id = 'hostileCss'; l.rel = 'stylesheet'; l.href = 'css/hostile.css'; document.head.appendChild(l); }
    const top = $('topbar');
    if (top && !$('riskChip')) {
      const b = document.createElement('button'); b.id = 'riskChip'; b.className = 'hxChip'; b.type = 'button';
      b.innerHTML = `${ic('warning')}<span class="hxChipT">Risk OFF</span>`;
      b.onclick = () => this.toggle();
      top.appendChild(b);
    }
    if (!$('hostileBanner')) {
      const d = document.createElement('div'); d.id = 'hostileBanner'; d.className = 'hidden'; d.setAttribute('role', 'alert');
      d.addEventListener('click', (e) => { const b = e.target.closest?.('[data-hx]'); if (!b || b.disabled) return; if (b.dataset.hx === 'client_bino') this.toggleBino(); else this.app.net.action(b.dataset.hx); });
      document.body.appendChild(d);
    }
  }
  get on() { return !!this.app.you?.risk?.on; }
  /** The chip / the risk check button: ask once (what can happen), then tell the server. */
  toggle(want = !this.on) {
    if (want && !this.on) { let ok = true; try { ok = confirm(HOSTILE_TEXT.warn + '\n\nAccept the risk?'); } catch { /* no dialogs: accept */ } if (!ok) return; }
    this.app.net.action('risk_set', { on: want });
  }

  // ---------------------------------------------------------------------------------------------- snapshot → units
  sync(list, now) {
    if (!Array.isArray(list)) list = [];
    const seen = new Set();
    for (const u of list) {
      if (!u || !u.id || !Number.isFinite(u.lat) || !Number.isFinite(u.lon)) continue;
      seen.add(u.id);
      const label = unitLabel(u);
      let o = this.units.get(u.id);
      if (!o) {
        o = { id: u.id, k: u.k, f: u.f, label, mesh: buildShip(u.k, label, hashStr(u.id) % 97 + 1), samples: [], cur: { lat: u.lat, lon: u.lon, hdg: u.hdg, spd: u.spd }, vis: { heave: 0, pitch: 0, roll: 0 }, fireStamp: 0, warp: 1 };
        this.app.scene.add(o.mesh); o.mesh.userData.setLights?.(!!this.app.lightsOn); this.units.set(u.id, o);
        if (u.f !== 'friend') this.contactAlert(u);
      }
      if (o.label !== label) { o.label = label; o.mesh.userData.label?.userData.setText(label); }
      Object.assign(o, { f: u.f, st: u.st, ident: !!u.ident, name: u.name || null, bd: !!u.bd });
      o.samples.push({ t: now, lat: u.lat, lon: u.lon, hdg: u.hdg, spd: u.spd }); if (o.samples.length > 4) o.samples.shift();
      if (u.fire && Number.isFinite(u.fireAge)) {
        const stamp = Math.round((now - u.fireAge) / 50);
        if (stamp !== o.fireStamp) { o.fireStamp = stamp; this.shoot(o, u.fire); }
      }
    }
    for (const [id, o] of this.units) if (!seen.has(id)) { this.app.drop(o.mesh); this.units.delete(id); }
  }
  contactAlert(u) {
    this.alertUntil = performance.now() + 8000;
    try { this.app.sound?.event('alarm', 0.8); } catch { /* sound is optional */ }
    this.app.flash?.();
  }

  // ---------------------------------------------------------------------------------------------- per frame
  update(dt, now) {
    for (const o of this.units.values()) {
      this.app.interp(o, now);
      this.app.shipVisual(o.mesh, o.cur.lat, o.cur.lon, o.cur.hdg, o.cur.spd, o.vis, 0, dt, false);
      o.mesh.userData.setLights?.(!!this.app.lightsOn);
    }
    this.aimGuns(dt);
    this.stepFx(dt);
    try { this.ownSmoke(dt, now); this.boarding(now); this.stepBino(); } catch (e) { if (!this.warned) { this.warned = true; console.warn('[hostile] fx failed', e); } }
    if (now - (this.lastUi || 0) > 250) { this.lastUi = now; this.renderUi(now); }
  }
  renderUi(now) {
    const you = this.app.you;
    const chip = $('riskChip');
    if (chip) {
      const m = chipModel(you?.risk), key = `${m.on}|${m.text}`;
      if (key !== this.lastChip) { this.lastChip = key; chip.classList.toggle('on', m.on); chip.title = m.title; const t = chip.querySelector('.hxChipT'); if (t) t.textContent = m.text; }
      chip.classList.toggle('alert', now < this.alertUntil || !!you?.hostile);
    }
    const el = $('hostileBanner'); if (!el) return;
    const model = bannerModel(you?.hostile, you?.money);
    if (!model || this.app.interior?.active || this.app.ashore?.active) { if (this.lastBanner !== '') { this.lastBanner = ''; el.classList.add('hidden'); el.innerHTML = ''; } return; }
    const html = bannerHTML(model);
    if (html !== this.lastBanner) { this.lastBanner = html; el.innerHTML = html; }
    el.className = model.tone === 'navy' ? 'navy' : '';
  }

  // ---------------------------------------------------------------------------------------------- effects
  fxMesh(kind) {
    let m = this.pool.find((x) => x.userData.kind === kind);
    if (m) { this.pool.splice(this.pool.indexOf(m), 1); return m; }
    if (kind === 'flash') m = new THREE.Mesh(new THREE.SphereGeometry(1.5, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffd36b, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
    else if (kind === 'splash') m = new THREE.Mesh(new THREE.ConeGeometry(1.6, 7, 10, 1, true), new THREE.MeshBasicMaterial({ color: 0xe9f6ff, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }));
    else m = new THREE.Mesh(new THREE.SphereGeometry(1.2, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff8a2a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    m.userData.kind = kind; m.frustumCulled = false;
    return m;
  }
  addFx(kind, x, y, z, life) {
    if (this.fx.length >= MAX_FX) { const old = this.fx.shift(); this.app.scene.remove(old.mesh); this.pool.push(old.mesh); }
    const mesh = this.fxMesh(kind); mesh.position.set(x, y, z); mesh.scale.setScalar(1); mesh.material.opacity = kind === 'splash' ? 0.8 : 0.95;
    this.app.scene.add(mesh); this.fx.push({ mesh, kind, t: 0, life });
  }
  stepFx(dt) {
    for (const f of [...this.fx]) {
      f.t += dt; const u = f.t / f.life;
      if (u >= 1) { this.app.scene.remove(f.mesh); this.pool.push(f.mesh); this.fx.splice(this.fx.indexOf(f), 1); continue; }
      if (f.kind === 'tracer') { f.mesh.material.opacity = 0.95 * (1 - u); continue; }
      if (f.kind === 'flash') { f.mesh.scale.setScalar(1 + u * 1.6); f.mesh.material.opacity = 0.95 * (1 - u); }
      else if (f.kind === 'splash') { f.mesh.scale.set(1 + u * 1.4, 0.4 + u * 1.2, 1 + u * 1.4); f.mesh.position.y = 1.5 + u * 2; f.mesh.material.opacity = 0.8 * (1 - u); }
      else { f.mesh.scale.setScalar(1 + u * 2.2); f.mesh.material.opacity = 0.9 * (1 - u); }
    }
  }
  /** A unit fired: muzzle flash at its bow, then a splash near our ship (miss / warning) or a hit on the hull; plus the sound. */
  shoot(o, kind) {
    const a = this.app, m = o.mesh; if (!m || !a.myMesh) return;
    const h = (o.cur.hdg * Math.PI) / 180, gun = m.userData.gun;
    let mx, my, mz;
    if (gun) { const v = new THREE.Vector3(0, 0.1, -(m.userData.gunLen || 3)); gun.localToWorld(v); mx = v.x; my = v.y; mz = v.z; }
    else { const bow = (m.userData.length || 10) * 0.35; mx = m.position.x + Math.sin(h) * bow; my = m.position.y + 2.2; mz = m.position.z - Math.cos(h) * bow; }
    this.addFx('flash', mx, my, mz, 0.18);
    const me = a.myMesh.position, ang = (hashStr(o.id + o.fireStamp) % 360) * Math.PI / 180, L = a.myMesh.userData.length || 50;
    let tx, ty, tz;
    if (kind === 'hit') { tx = me.x + Math.sin(ang) * 3; ty = me.y + 3; tz = me.z + (((hashStr(o.id + o.fireStamp) >> 3) % 100) / 100 - 0.5) * L * 0.7; this.addFx('hit', tx, ty, tz, 0.5); this.hitUntil = performance.now() + 9000; }
    else { const r = kind === 'warning' ? 90 : 35; tx = me.x + Math.sin(ang) * r; ty = me.y; tz = me.z + Math.cos(ang) * r; this.addFx('splash', tx, ty, tz, 1.1); if (kind !== 'warning') this.addFx('splash', tx + 8, ty, tz - 6, 0.9); }
    if (o.k === 'skiff' || o.k === 'patrol' || o.k === 'rib') this.tracer(mx, my, mz, tx, ty + (kind === 'hit' ? 0 : 1), tz);
    try { a.sound?.event('shot', o.k === 'skiff' ? 0.15 : o.k === 'patrol' ? 0.5 : 0.85); } catch { /* optional */ }
  }
  tracer(ax, ay, az, bx, by, bz) {
    if (this.fx.length >= MAX_FX + 4) return;
    let m = this.pool.find((x) => x.userData.kind === 'tracer');
    if (m) this.pool.splice(this.pool.indexOf(m), 1);
    else { const g = new THREE.CylinderGeometry(0.12, 0.12, 1, 4); g.rotateX(Math.PI / 2); m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false })); m.userData.kind = 'tracer'; m.frustumCulled = false; }
    const len = Math.hypot(bx - ax, by - ay, bz - az) || 1;
    m.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2); m.scale.set(1, 1, len); m.lookAt(bx, by, bz); m.material.opacity = 0.95;
    this.app.scene.add(m); this.fx.push({ mesh: m, kind: 'tracer', t: 0, life: 0.14 });
  }
  /** Warship guns turn to their target: the gun group (ship.js userData.gun) follows the bearing to our ship. */
  aimGuns(dt) {
    const me = this.app.myMesh; if (!me) return;
    for (const o of this.units.values()) {
      const gun = o.mesh.userData.gun; if (!gun) continue;
      const dx = me.position.x - o.mesh.position.x, dz = me.position.z - o.mesh.position.z;
      const want = -(Math.atan2(dx, -dz) - (o.cur.hdg * Math.PI) / 180);
      let d = want - gun.rotation.y; d = Math.atan2(Math.sin(d), Math.cos(d));
      gun.rotation.y += Math.max(-1.6 * dt, Math.min(1.6 * dt, d));
    }
  }
  /** Smoke (and fire below 45 % hull) over our own ship: grows with the damage, flares on every hit, heavy while she goes down. */
  ownSmoke(dt, now) {
    const a = this.app, me = a.myMesh, you = a.you; if (!me || !you) return;
    const dmg = Math.max(0, Math.min(1, (70 - (you.cond ?? 100)) / 70)), sinking = (you.flooding || 0) >= 0.2 || !!you.rescue;
    const power = Math.max(dmg, now < this.hitUntil ? 0.35 : 0, sinking ? 0.9 : 0);
    if (!this.smokeFx) { if (power <= 0.05) return; this.smokeFx = new ShipSmoke(a.scene); }
    const fire = (you.cond ?? 100) < 45 || sinking;
    const w = a.localWind || a.wind || {}, wu = Number.isFinite(w.u) ? w.u : 0, wv = Number.isFinite(w.v) ? w.v : 0;
    this.smokeFx.update(dt, { x: me.position.x, y: me.position.y + (me.userData.freeboard || 4), z: me.position.z, hdg: ((you.ship?.hdg ?? 0) * Math.PI) / 180, L: me.userData.length || 60, wind: { u: wu, v: wv } }, power, fire, 1 - (a.night || 0));
  }
  /** Boarders on our deck while a unit reports a boarding party (`bd`): dark figures swaying by the rail where the ladder lands. */
  boarding(now) {
    const me = this.app.myMesh, any = [...this.units.values()].some((o) => o.bd);
    if (!any || !me) { if (this.boarders) { me?.remove(this.boarders); this.boarders = null; } return; }
    if (!this.boarders) {
      const g = new THREE.Group(), L = me.userData.length || 50, B = me.userData.beam || 10;
      const mat = new THREE.MeshStandardMaterial({ color: 0x1d2128, roughness: 0.9 }), skin = new THREE.MeshStandardMaterial({ color: 0xc99a74, roughness: 0.9 });
      for (let i = 0; i < 4; i++) {
        const f = new THREE.Group(), body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.8, 2, 6), mat), head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 6, 5), skin);
        body.position.y = 0.9; head.position.y = 1.75; f.add(body, head);
        f.position.set(B / 2 - 1.1 - (i % 2) * 1.2, (me.userData.freeboard || 3) + 0.05, -L * 0.1 + i * 2.4); f.userData.i = i; g.add(f);
      }
      me.add(g); this.boarders = g;
    }
    this.boarders.children.forEach((f, i) => { f.position.x += Math.sin(now / 300 + i * 1.7) * 0.004; f.rotation.y = Math.sin(now / 500 + i) * 0.6; f.children[0].rotation.z = Math.sin(now / 200 + i) * 0.12; });
  }
  /** Binoculars: bridge view, narrow field, aimed at the nearest hostile unit (toggle from the banner). */
  toggleBino() {
    const a = this.app;
    if (this.bino) { a.camera.fov = this.bino.fov; a.camera.updateProjectionMatrix(); a.cam.mode = this.bino.mode; a.cam.free = false; this.bino = null; return; }
    if (!this.units.size) return;
    this.bino = { fov: a.camera.fov, mode: a.cam.mode }; a.camera.fov = 9; a.camera.updateProjectionMatrix(); a.cam.mode = 2;
  }
  stepBino() {
    if (!this.bino) return;
    const a = this.app, s = a.ship; let best = null, bd = Infinity;
    for (const o of this.units.values()) { const d = Math.hypot(o.cur.lat - s.lat, (o.cur.lon - s.lon) * Math.cos(s.lat * Math.PI / 180)); if (d < bd) { bd = d; best = o; } }
    if (!best) return this.toggleBino();
    const brg = Math.atan2((best.cur.lon - s.lon) * Math.cos(s.lat * Math.PI / 180), best.cur.lat - s.lat);
    a.cam.free = true; a.cam.lastDrag = performance.now(); a.cam.look = brg - (s.hdg * Math.PI) / 180;
    a.camera.fov = Math.max(5, Math.min(18, 2 + bd * 110574 / 400));   // closer craft need a wider view
    a.camera.updateProjectionMatrix();
  }
  /** Server-pushed effects without a unit (a mine blast). */
  onFx(m) {
    const a = this.app, me = a.myMesh; if (!me) return;
    if (m.kind === 'blast') {
      this.addFx('splash', me.position.x + 12, me.position.y, me.position.z - 4, 1.6); this.addFx('hit', me.position.x + 10, me.position.y + 2, me.position.z - 4, 0.9);
      this.addFx('splash', me.position.x + 18, me.position.y, me.position.z + 6, 1.3); this.hitUntil = performance.now() + 9000;
      try { a.sound?.event('collision', 0.9); } catch { /* optional */ }
    }
  }

  // ---------------------------------------------------------------------------------------------- radar and chart
  radarContacts() {
    const out = [];
    for (const o of this.units.values()) out.push({ kind: 'hostile', lat: o.cur.lat, lon: o.cur.lon, hdg: o.cur.hdg, color: unitColor(o), label: o.label, f: o.f, ident: !!o.ident });
    return out;
  }
  /** Chart layer: red markers (blue-green for a friendly patrol), the label once identified; called from chart.js drawShips. */
  drawChart(chart) {
    const ctx = chart.ctx;
    for (const o of this.units.values()) {
      const c = o.cur, p = chart.project(c.lat, c.lon); if (!chart.onScreen(p)) continue;
      chart.drawTriangle(p, c.hdg ?? 0, 7, unitColor(o), 'rgba(40,0,0,0.9)');
      ctx.strokeStyle = unitColor(o); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(p.x, p.y, 11, 0, Math.PI * 2); ctx.stroke();
      if (chart.zoom >= 7) { ctx.font = '11px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#ffb0a8'; ctx.fillText(o.label, p.x + 14, p.y); }
    }
  }
  chartHits(consider) {
    for (const o of this.units.values()) consider(o.cur.lat, o.cur.lon, { kind: 'hostile', text: `${o.label}${o.st ? ` · ${o.st}` : ''}`, data: o });
  }

  // ---------------------------------------------------------------------------------------------- route warnings
  /** Risk lines (piracy / war_risk) for a route, for the warning in the express confirmation. */
  routeLines(points) {
    try {
      const ds = this.app.politics?.dataset?.(), s = this.app.ship; if (!ds || !s) return [];
      const pts = points.map((p) => (Array.isArray(p) ? p : [p.lat, p.lon]));
      return routeExposure(ds, { lat: s.lat, lon: s.lon }, pts, 12, Date.now() / 1000).areas.filter((a) => a.kind === 'piracy' || a.kind === 'war_risk').map((a) => ({ kind: a.kind, id: a.id, name: ds.areaById?.[a.id]?.name || a.id }));
    } catch { return []; }
  }
  expressWarning(points) { return expressWarning(this.on, this.routeLines(points)); }
  riskBlock(lines) { return riskBlockHTML(this.on, lines); }
  dispose() { for (const o of this.units.values()) this.app.drop(o.mesh); this.units.clear(); this.smokeFx?.dispose(); this.smokeFx = null; }
}
