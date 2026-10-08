// Engine order telegraph (docs/V5-PLAN.md item 3): the on-screen telegraph (desktop, above the radar), the order
// callout, the bell, and the telegraph dial on the interior bridge console. The orders and the throttle mapping live in
// shared/telegraph.js; the astern physics in shared/physics.js; the touch lever (touch.js) is the telegraph on phones.
//
//   app.telegraph = new Telegraph(app);
//   app.telegraph.step(+1 | -1)      // one order ahead / astern (W/S, ArrowUp/ArrowDown)
//   app.telegraph.order(thr)          // a given throttle (a click on an order)
//   app.telegraph.attachBridge(group, x, y, z, facing)   // interior.js: telegraph dial on the helm console
//
// It reads app.input.throttleCmd (the order) and app.ship.throttle (the engine's answer) on its own 10 Hz timer, so it
// works whatever changed the order (keys, touch lever, Space, the harbour resetting it) and whatever the frame rate is.
import * as THREE from 'three';
import { ORDERS, STOP_INDEX, THROTTLE_MIN, clampThrottle, orderIndex, orderFor, orderLabel, orderPosition, stepOrder, isAstern, calloutNote, motionHint } from '/shared/telegraph.js';

const RING_SETTLE_MS = 180;    // an order rings once it has stood this long (a finger sliding the lever rings once)
const STEP_REPEAT_MS = 140;    // key auto-repeat steps at most this often
const CALLOUT_MS = 1600;
const CALLOUT_NOTE_MS = 3500; // long enough to read the note (STOP: she carries her way; ASTERN brakes)

function ensureCss() {
  if (document.getElementById('tgCss')) return;
  const l = document.createElement('link'); l.id = 'tgCss'; l.rel = 'stylesheet'; l.href = 'css/telegraph.css';
  document.head.appendChild(l);
}
const zoneOf = (i) => (i === STOP_INDEX ? 'stop' : i > STOP_INDEX ? 'ahead' : 'astern');

export class Telegraph {
  constructor(app) {
    this.app = app;
    this.lastKey = null; this.keyAt = 0; this.rungKey = null; this.armed = false; this.lastStep = 0;
    this.bridge = null; this.lastBridgeDraw = 0;
    try { ensureCss(); this.build(); } catch (e) { console.warn('[telegraph] widget unavailable', e); }
    this._timer = setInterval(() => { try { this.update(); } catch (e) { console.warn('[telegraph] update', e); } }, 100);
  }

  // ------------------------------------------------------------------ commands
  canOrder() { const you = this.app.you; return !!(you && !you.docked && !you.assist && !this.app.ashore?.active); }
  /** One order ahead (+1) or astern (−1). Returns the new throttle command, or null when the helm is locked.
   *  repeat = a held key's auto-repeat (throttled to one order per STEP_REPEAT_MS); separate presses always step. */
  step(dir, repeat = false) {
    const now = performance.now();
    if (repeat && now - this.lastStep < STEP_REPEAT_MS) return this.app.input.throttleCmd;
    this.lastStep = now;
    return this.order(stepOrder(this.app.input.throttleCmd, dir));
  }
  /** Set the throttle command (any value in range; the nine orders are the usual ones). */
  order(thr) {
    const a = this.app;
    if (!this.canOrder()) { this.lockedHint(); return null; }
    a.manualHelm?.();
    a.input.throttleCmd = clampThrottle(thr);
    a.touchHelm?.setThrottle?.(a.input.throttleCmd);
    this.update();
    return a.input.throttleCmd;
  }
  lockedHint() {
    const you = this.app.you; if (!you) return;
    const now = performance.now(); if (now - (this._hintAt || 0) < 4000) return; this._hintAt = now;
    const text = you.docked ? 'Moored — cast off first (T) before you can ring an engine order.' : you.assist ? 'The tugs have her — engines stay stopped until they let go.' : '';
    if (text) this.app.hud?.event?.({ kind: 'info', text });
  }
  ring() {
    const snd = this.app.sound; if (!snd) return;
    try { snd.unlock?.(); snd.bell?.(2); } catch {}
  }

  // ------------------------------------------------------------------ DOM
  build() {
    const hud = document.getElementById('hud') || document.body;
    const w = document.createElement('section'); w.id = 'telegraph'; w.className = 'glass hidden'; w.setAttribute('aria-label', 'Engine order telegraph');
    w.innerHTML = `<div class="tgHead"><b>Telegraph</b><span class="tgKeys"><kbd>W</kbd><kbd>S</kbd></span></div>
      <div class="tgBody"><div class="tgZone ahead">AHEAD</div><div class="tgZone stop"></div><div class="tgZone astern">ASTERN</div><div class="tgRows"></div></div>
      <div class="tgFoot"><span class="tgDir">STOP</span><span class="tgSpd">0.0 kn</span></div>
      <div class="tgHint hidden"></div>`;
    const rows = w.querySelector('.tgRows');
    this.rows = [];
    // top row = full ahead … bottom row = full astern, like the lever on the touch helm
    for (let i = ORDERS.length - 1; i >= 0; i--) {
      const o = ORDERS[i], z = zoneOf(i);
      const b = document.createElement('button'); b.type = 'button'; b.className = `tgRow ${z}`; b.dataset.i = String(i);
      b.title = `${o.name}${i === STOP_INDEX ? ' (Space)' : ''}`;
      b.innerHTML = i === STOP_INDEX ? 'STOP' : `<span>${o.word === 'D.SLOW' ? 'DEAD SLOW' : o.word}</span><small>${i > STOP_INDEX ? Math.round(o.thr * 100) : Math.round((o.thr / THROTTLE_MIN) * 100)}%</small>`;
      b.addEventListener('click', (e) => { e.preventDefault(); b.blur(); this.order(o.thr); });
      rows.appendChild(b); this.rows[i] = b;
    }
    this.needle = document.createElement('i'); this.needle.className = 'tgNeedle'; this.needle.title = 'Engine answer'; rows.appendChild(this.needle);
    this.cmdMark = document.createElement('i'); this.cmdMark.className = 'tgCmd hidden'; rows.appendChild(this.cmdMark);
    // fine control: the wheel over the telegraph moves the order 5 % at a time
    w.addEventListener('wheel', (e) => { e.preventDefault(); e.stopPropagation(); const d = e.deltaY < 0 ? 0.05 : -0.05; this.order(Math.round((this.app.input.throttleCmd + d) * 20) / 20); }, { passive: false });
    hud.appendChild(w);
    this.el = w; this.rowsEl = rows; this.dirEl = w.querySelector('.tgDir'); this.spdEl = w.querySelector('.tgSpd'); this.hintEl = w.querySelector('.tgHint');
    const c = document.createElement('div'); c.id = 'tgCallout'; c.setAttribute('aria-live', 'polite'); hud.appendChild(c); this.callEl = c;
    // instrument strip: the throttle cell shows the order (hud.js writes it), the SOG cell gets an ASTERN tag
    const thrLbl = document.getElementById('tThr')?.closest('.cell')?.querySelector('label'); if (thrLbl) thrLbl.textContent = 'Telegraph';
    this.sogCell = document.getElementById('tSog')?.closest('.cell') || null;
    this.sogLbl = this.sogCell?.querySelector('label') || null;
  }
  /** Vertical position (px from the top of the rows) of a fractional order position (0 = full astern … 8 = full ahead). */
  rowY(pos) {
    const first = this.rows[ORDERS.length - 1], last = this.rows[0];
    if (!first || !last) return 0;
    const top = first.offsetTop + first.offsetHeight / 2, bot = last.offsetTop + last.offsetHeight / 2;
    return top + ((ORDERS.length - 1 - pos) / (ORDERS.length - 1)) * (bot - top);
  }
  callout(thr) {
    const el = this.callEl; if (!el) return;
    const i = orderIndex(thr); if (i < 0) return;
    const o = ORDERS[i], z = zoneOf(i);
    el.className = `${z} show`;
    const note = calloutNote(z, Number(this.app.ship?.spd) || 0);
    el.innerHTML = `${z === 'ahead' ? '▲ ' : z === 'astern' ? '▼ ' : ''}${o.name}${note ? `<small>${note}</small>` : ''}`;
    clearTimeout(this._callT); this._callT = setTimeout(() => el.classList.remove('show'), note.length > 20 ? CALLOUT_NOTE_MS : CALLOUT_MS);
  }

  // ------------------------------------------------------------------ loop (10 Hz)
  update() {
    const a = this.app, you = a.you, s = a.ship;
    const cmd = clampThrottle(a.input?.throttleCmd ?? 0), actual = clampThrottle(s?.throttle ?? 0);
    const live = !!(a.started && you && s);
    const docked = !!you?.docked, assist = !!you?.assist;
    // visibility: at sea on deck, or at the helm below decks (body.tgHelm)
    document.body.classList.toggle('tgHelm', !!(a.interior?.active && a.interior?.atHelm));
    // making sternway: the SOG cell reads ASTERN (amber) instead of SOG
    const sternway = live && !docked && (Number(s?.spd) || 0) < -0.05;
    this.sogCell?.classList.toggle('tgAstern', sternway);
    if (this.sogLbl && this.sogLbl.textContent !== (sternway ? 'Astern' : 'SOG')) this.sogLbl.textContent = sternway ? 'Astern' : 'SOG';
    if (this.el) {
      const show = live && !docked && !assist && !a.ashore?.active && (!a.interior?.active || a.interior?.atHelm);
      this.el.classList.toggle('hidden', !show);
      if (show) this.render(cmd, actual, s);
    }
    // bell + callout once a new order has stood RING_SETTLE_MS
    const i = orderIndex(cmd), key = i >= 0 ? `o${i}` : `f${Math.round(cmd * 20)}`, now = performance.now();
    if (!live || docked || assist) { this.lastKey = this.rungKey = key; this.armed = false; return this.drawBridge(cmd, actual, s); }
    if (!this.armed) { this.armed = true; this.lastKey = this.rungKey = key; }
    if (key !== this.lastKey) { this.lastKey = key; this.keyAt = now; }
    else if (key !== this.rungKey && now - this.keyAt >= RING_SETTLE_MS) {
      this.rungKey = key;
      if (i >= 0) { this.ring(); this.callout(cmd); }
    }
    this.drawBridge(cmd, actual, s);
  }
  render(cmd, actual, s) {
    const i = orderIndex(cmd), pending = Math.abs(actual - cmd) > 0.02;
    for (let k = 0; k < this.rows.length; k++) { const r = this.rows[k]; if (!r) continue; const on = k === i; r.classList.toggle('on', on); r.classList.toggle('pending', on && pending); r.setAttribute('aria-pressed', on ? 'true' : 'false'); }
    this.needle.style.top = `${this.rowY(orderPosition(actual)).toFixed(1)}px`;
    this.cmdMark.classList.toggle('hidden', i >= 0);
    if (i < 0) this.cmdMark.style.top = `${this.rowY(orderPosition(cmd)).toFixed(1)}px`;
    const spd = Number(s?.spd) || 0, astern = spd < -0.05, ahead = spd > 0.05;
    this.el.classList.toggle('astern', astern || (isAstern(cmd) && !ahead)); this.el.classList.toggle('ahead', ahead && !isAstern(cmd));
    const dir = i >= 0 ? ORDERS[i].name : orderLabel(cmd);
    if (this.dirEl.textContent !== dir.toUpperCase()) this.dirEl.textContent = dir.toUpperCase();
    const sp = `${astern ? '◀ ' : ''}${Math.abs(spd).toFixed(1)} kn`;
    if (this.spdEl.textContent !== sp) this.spdEl.textContent = sp;
    this.el.title = pending ? 'The engine room is answering the order…' : '';
    // STOP only stops the engine: say so while she still carries way, and that ASTERN is the brake
    const hint = motionHint(cmd, actual, spd);
    if (this.hintEl) { this.hintEl.classList.toggle('hidden', !hint); if (hint && this.hintEl.textContent !== hint) this.hintEl.textContent = hint; }
  }

  // ------------------------------------------------------------------ bridge console dial (interior)
  /** Called by interior.js while it builds the helm console: a telegraph dial standing next to the throttle lever. */
  attachBridge(group, x, y, z, facing = -1) {
    const cv = document.createElement('canvas'); cv.width = cv.height = 256;
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5), new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide }));
    mesh.position.set(x, y, z - facing * 0.06); mesh.rotation.x = facing * -0.35; if (facing > 0) mesh.rotation.y = Math.PI;
    mesh.name = 'telegraphDial';
    group.add(mesh);
    this.bridge = { cv, ctx: cv.getContext('2d'), tex, mesh, key: '' };
    this.drawBridge(clampThrottle(this.app.input?.throttleCmd ?? 0), clampThrottle(this.app.ship?.throttle ?? 0), this.app.ship, true);
    return mesh;
  }
  drawBridge(cmd, actual, s, force = false) {
    const B = this.bridge; if (!B || (!force && !this.app.interior?.active)) return;
    const key = `${cmd.toFixed(3)}|${actual.toFixed(2)}`;
    if (!force && key === B.key) return;
    B.key = key;
    const c = B.ctx, W = 256, cx = 128, cy = 136, R = 112;
    c.clearRect(0, 0, W, W);
    // brass bezel + face
    c.beginPath(); c.arc(cx, cy, R + 10, 0, Math.PI * 2); c.fillStyle = '#9c7a33'; c.fill();
    c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.fillStyle = '#f1ead8'; c.fill();
    const ang = (pos) => ((-90 + (pos - STOP_INDEX) * 30) * Math.PI) / 180; // STOP at the top, ahead clockwise, astern anticlockwise
    // sectors
    for (let i = 0; i < ORDERS.length; i++) {
      const a0 = ang(i - 0.5), a1 = ang(i + 0.5), z = zoneOf(i), on = orderIndex(cmd) === i;
      c.beginPath(); c.moveTo(cx, cy); c.arc(cx, cy, R - 4, a0, a1); c.closePath();
      c.fillStyle = on ? (z === 'ahead' ? '#2f9e5f' : z === 'astern' ? '#d88a12' : '#c0392b') : z === 'ahead' ? '#dfeee3' : z === 'astern' ? '#f6e3c2' : '#f4d6d2';
      c.fill(); c.strokeStyle = '#6b5a35'; c.lineWidth = 1.5; c.stroke();
      const am = ang(i), tr = R - 30;
      c.save(); c.translate(cx + Math.cos(am) * tr, cy + Math.sin(am) * tr); c.rotate(am + Math.PI / 2 + (Math.sin(am) > 0.3 ? Math.PI : 0));
      c.fillStyle = on ? '#fff' : '#2a2216'; c.font = 'bold 17px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(ORDERS[i].word === 'D.SLOW' ? 'D.SL' : ORDERS[i].word, 0, 0); c.restore();
    }
    c.fillStyle = '#2a2216'; c.font = 'bold 13px sans-serif'; c.textAlign = 'center';
    c.fillText('AHEAD', cx + 70, cy + 70); c.fillText('ASTERN', cx - 70, cy + 70);
    // order handle (red) and engine answer (black)
    const needle = (pos, len, width, col) => { const a = ang(pos); c.strokeStyle = col; c.lineWidth = width; c.lineCap = 'round'; c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len); c.stroke(); };
    needle(orderPosition(actual), R - 46, 4, '#1b1b1b');
    needle(orderPosition(cmd), R - 18, 7, '#b0261c');
    c.beginPath(); c.arc(cx, cy, 11, 0, Math.PI * 2); c.fillStyle = '#9c7a33'; c.fill();
    // order name under the hub
    const o = orderFor(cmd);
    c.fillStyle = isAstern(cmd) ? '#a65f00' : '#1b1b1b'; c.font = 'bold 22px sans-serif';
    c.fillText(o ? o.name.toUpperCase() : orderLabel(cmd).toUpperCase(), cx, cy + 38);
    B.tex.needsUpdate = true;
  }
  dispose() { clearInterval(this._timer); this.el?.remove(); this.callEl?.remove(); }
}
