// Touch helm (docs/V3-CONTRACTS.md §7, V4 §2): a vertical throttle lever (−30 … 100 % with a detent at 0), a horizontal
// rudder slider that auto-centres on release with the same rate limits as the keys, round STOP / autopilot buttons and a
// left-thumb virtual stick for walking (interior and ashore). Pointer events only, `touch-action: none` everywhere, no
// dependencies. Round buttons call `onAction(name)`, else an `on<Name>()` handler, else `window.app.hud.action(name)`.

export function isTouch() {
  try { return (window.matchMedia && matchMedia('(pointer: coarse)').matches) || navigator.maxTouchPoints > 1; } catch { return false; }
}

const THR_MIN = -0.3, THR_MAX = 1, THR_DETENT = 0.05;
const RUD_RATE = 1.4;      // rudder follows the finger at the keys' rate (units per second)
const RUD_RECENTRE = 2.5;  // exponential recentre rate on release (same as main.js)
const LABELS = { dock: 'Dock', chart: 'Chart', interior: 'Walk', camera: 'Cam', stop: 'STOP', auto: 'AP', ships: 'Ships', more: '…', ashore: 'Shore' };
const TITLES = { stop: 'All stop', auto: 'Autopilot (follow the route)', dock: 'Moor / harbour', chart: 'Chart', interior: 'Walk your ship', camera: 'Camera', ships: 'Ships nearby', ashore: 'Go ashore' };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class TouchHelm {
  /**
   * @param {HTMLElement} root  container (emptied and filled by the helm)
   * @param {object} handlers  { onThrottle(v), onRudder(v), onAllStop(), onAction(name), buttons?: string[] }
   */
  constructor(root, handlers = {}) {
    this.root = root; this.h = handlers;
    this.stick = { x: 0, y: 0, active: false };
    this.throttle = 0; this.rudder = 0; this.rudderTarget = 0;
    this.throttleActive = false; this.rudderActive = false; this.stickPointer = null;
    // The bottom bar of the HUD carries dock / chart / walk / camera; the helm keeps only the two helm buttons.
    this.buttons = handlers.buttons || ['stop', 'auto'];
    this.visible = true;
    this.build();
    this.lastT = performance.now();
    // A fixed 30 Hz timer, not rAF: the rudder must follow the finger at the same rate whatever the 3D frame rate is.
    this._timer = setInterval(() => this.loop(), 33);
  }

  // ------------------------------------------------------------------ DOM
  build() {
    const r = this.root; if (!r) return;
    r.innerHTML = '';
    r.classList.add('touchHelm');
    const mk = (cls, parent = r) => { const d = document.createElement('div'); d.className = cls; parent.appendChild(d); return d; };
    // throttle
    this.thr = mk('thThr'); this.thr.setAttribute('aria-label', 'Throttle');
    this.thrTrack = mk('thTrack', this.thr); this.thrFill = mk('thFill', this.thrTrack); this.thrDetent = mk('thDetent', this.thrTrack); this.thrKnob = mk('thKnob', this.thrTrack);
    this.thrVal = mk('thVal', this.thr); this.thrVal.textContent = '0 %';
    this.thrLbl = mk('thLbl', this.thr); this.thrLbl.textContent = 'THR';
    // rudder
    this.rud = mk('thRud'); this.rud.setAttribute('aria-label', 'Rudder');
    this.rudTrack = mk('thTrack', this.rud); this.rudCentre = mk('thCentre', this.rudTrack); this.rudFill = mk('thFill', this.rudTrack); this.rudKnob = mk('thKnob', this.rudTrack);
    this.rudVal = mk('thVal', this.rud); this.rudVal.textContent = 'rudder 0';
    // round buttons
    this.btns = mk('thBtns');
    this.renderButtons();
    // virtual stick (interior walker)
    this.stickEl = mk('thStick'); this.stickEl.classList.add('hidden');
    this.stickBase = mk('thStickBase', this.stickEl); this.stickNub = mk('thStickNub', this.stickBase);
    for (const el of [this.thr, this.rud, this.stickEl, this.btns]) { el.style.touchAction = 'none'; }
    this.bindThrottle(); this.bindRudder(); this.bindStick();
    this.renderThrottle(); this.renderRudder();
  }

  // ------------------------------------------------------------------ throttle lever
  bindThrottle() {
    const t = this.thrTrack;
    const valueAt = (clientY) => { const r = t.getBoundingClientRect(); const f = 1 - clamp((clientY - r.top) / Math.max(1, r.height), 0, 1); return THR_MIN + f * (THR_MAX - THR_MIN); };
    t.addEventListener('pointerdown', (e) => { e.preventDefault(); try { t.setPointerCapture(e.pointerId); } catch {} this.throttleActive = true; this.applyThrottle(valueAt(e.clientY)); });
    t.addEventListener('pointermove', (e) => { if (!this.throttleActive) return; e.preventDefault(); this.applyThrottle(valueAt(e.clientY)); });
    const end = () => { if (!this.throttleActive) return; this.throttleActive = false; this.applyThrottle(this.throttle, true); };
    t.addEventListener('pointerup', end); t.addEventListener('pointercancel', end); t.addEventListener('lostpointercapture', end);
  }
  applyThrottle(v, release = false) {
    v = clamp(v, THR_MIN, THR_MAX);
    if (Math.abs(v) < THR_DETENT) v = 0;                               // detent at 0 (stop)
    v = Math.round(v * 20) / 20;                                        // 5 % steps, like the keys' 10 % but finer
    const changed = v !== this.throttle;
    this.throttle = v; this.renderThrottle();
    if (changed || release) this.h.onThrottle?.(v);
  }
  /** External update (keys, Space, docking): only moves the lever when the finger is not on it. */
  setThrottle(v) { if (this.throttleActive || !Number.isFinite(v)) return; const nv = clamp(v, THR_MIN, THR_MAX); if (Math.abs(nv - this.throttle) < 1e-3) return; this.throttle = nv; this.renderThrottle(); }
  renderThrottle() {
    const f = (this.throttle - THR_MIN) / (THR_MAX - THR_MIN), f0 = (0 - THR_MIN) / (THR_MAX - THR_MIN);
    this.thrKnob.style.bottom = `calc(${(f * 100).toFixed(2)}% - 14px)`;
    this.thrDetent.style.bottom = `${(f0 * 100).toFixed(2)}%`;
    if (this.throttle >= 0) { this.thrFill.style.bottom = `${(f0 * 100).toFixed(2)}%`; this.thrFill.style.height = `${((f - f0) * 100).toFixed(2)}%`; this.thrFill.classList.remove('astern'); }
    else { this.thrFill.style.bottom = `${(f * 100).toFixed(2)}%`; this.thrFill.style.height = `${((f0 - f) * 100).toFixed(2)}%`; this.thrFill.classList.add('astern'); }
    this.thrVal.textContent = `${Math.round(this.throttle * 100)} %`;
    this.thr.classList.toggle('astern', this.throttle < 0);
  }

  // ------------------------------------------------------------------ rudder slider
  bindRudder() {
    const t = this.rudTrack;
    const valueAt = (clientX) => { const r = t.getBoundingClientRect(); return clamp(((clientX - r.left) / Math.max(1, r.width)) * 2 - 1, -1, 1); };
    t.addEventListener('pointerdown', (e) => { e.preventDefault(); try { t.setPointerCapture(e.pointerId); } catch {} this.rudderActive = true; this.rudderTarget = valueAt(e.clientX); });
    t.addEventListener('pointermove', (e) => { if (!this.rudderActive) return; e.preventDefault(); this.rudderTarget = valueAt(e.clientX); });
    const end = () => { if (!this.rudderActive) return; this.rudderActive = false; this.rudderTarget = 0; };
    t.addEventListener('pointerup', end); t.addEventListener('pointercancel', end); t.addEventListener('lostpointercapture', end);
  }
  /** External update (autopilot steering): only when the finger is off the slider and it is centred. */
  setRudder(v) { if (this.rudderActive || !Number.isFinite(v)) return; if (Math.abs(this.rudder) > 0.02 && Math.abs(v) < 0.02) return; this.rudder = clamp(v, -1, 1); this.renderRudder(); }
  renderRudder() {
    const r = this.rudder, pct = ((r + 1) / 2) * 100;
    this.rudKnob.style.left = `calc(${pct.toFixed(2)}% - 14px)`;
    if (r >= 0) { this.rudFill.style.left = '50%'; this.rudFill.style.width = `${(r * 50).toFixed(2)}%`; } else { this.rudFill.style.left = `${(50 + r * 50).toFixed(2)}%`; this.rudFill.style.width = `${(-r * 50).toFixed(2)}%`; }
    this.rudVal.textContent = r > 0.02 ? `stbd ${Math.round(r * 35)}°` : r < -0.02 ? `port ${Math.round(-r * 35)}°` : 'rudder 0';
  }

  // ------------------------------------------------------------------ virtual stick
  bindStick() {
    const z = this.stickEl, R = 46;
    const origin = { x: 0, y: 0 };
    const update = (e) => {
      const dx = e.clientX - origin.x, dy = e.clientY - origin.y;
      const d = Math.hypot(dx, dy), k = d > R ? R / d : 1;
      const x = (dx * k) / R, y = (-dy * k) / R;                        // y: up = forward
      this.stick.x = Math.abs(x) < 0.08 ? 0 : x; this.stick.y = Math.abs(y) < 0.08 ? 0 : y;
      this.stickNub.style.transform = `translate(${(dx * k).toFixed(1)}px, ${(dy * k).toFixed(1)}px)`;
    };
    z.addEventListener('pointerdown', (e) => {
      e.preventDefault(); if (this.stickPointer != null) return;
      try { z.setPointerCapture(e.pointerId); } catch {}
      this.stickPointer = e.pointerId; this.stick.active = true;
      const r = this.stickBase.getBoundingClientRect(); origin.x = r.left + r.width / 2; origin.y = r.top + r.height / 2;
      update(e);
    });
    z.addEventListener('pointermove', (e) => { if (e.pointerId !== this.stickPointer) return; e.preventDefault(); update(e); });
    const end = (e) => { if (e.pointerId !== this.stickPointer) return; this.stickPointer = null; this.stick.active = false; this.stick.x = 0; this.stick.y = 0; this.stickNub.style.transform = ''; };
    z.addEventListener('pointerup', end); z.addEventListener('pointercancel', end); z.addEventListener('lostpointercapture', end);
  }
  showStick(on) { this.stickEl?.classList.toggle('hidden', !on); if (!on) { this.stick.active = false; this.stick.x = this.stick.y = 0; this.stickPointer = null; } }

  // ------------------------------------------------------------------ round buttons
  renderButtons() {
    if (!this.btns) return;
    this.btns.innerHTML = '';
    for (const name of this.buttons) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'thBtn ' + name; b.dataset.action = name; b.textContent = LABELS[name] || name;
      b.title = TITLES[name] || name; b.setAttribute('aria-label', TITLES[name] || name);
      b.addEventListener('click', (e) => { e.preventDefault(); b.blur(); this.fire(name); });
      this.btns.appendChild(b);
    }
  }
  fire(name) {
    if (name === 'stop') { this.setThrottle(0); this.rudderTarget = 0; this.h.onAllStop?.(); return; }
    if (typeof this.h.onAction === 'function') return this.h.onAction(name);
    const fn = this.h['on' + cap(name)];
    if (typeof fn === 'function') return fn();
    try { window.app?.hud?.action?.(name); } catch (e) { console.warn('[touch] action failed', name, e); }
  }
  /** Replace the round buttons (names from LABELS). */
  setButtons(list) {
    const next = (Array.isArray(list) ? list : []).filter((n) => typeof n === 'string' && n);
    if (next.join() === this.buttons.join()) return;
    this.buttons = next; this.renderButtons();
  }
  /** Highlight a round button (e.g. the autopilot while it steers). */
  setButtonOn(name, on) { this.btns?.querySelector(`[data-action="${name}"]`)?.classList.toggle('on', !!on); }

  // ------------------------------------------------------------------ visibility / loop
  show(on) { this.visible = !!on; this.root?.classList.toggle('hidden', !on); }
  /** Hide the helm controls but keep the root (used while walking the interior). */
  setHelmVisible(on) { for (const el of [this.thr, this.rud, this.btns]) el?.classList.toggle('hidden', !on); }
  loop() {
    const now = performance.now(), dt = Math.min(0.25, (now - this.lastT) / 1000); this.lastT = now;
    if (!this.visible) return;
    const prev = this.rudder;
    if (this.rudderActive) {
      const d = this.rudderTarget - this.rudder;
      const step = RUD_RATE * dt;
      this.rudder = Math.abs(d) <= step ? this.rudderTarget : this.rudder + Math.sign(d) * step;
    } else if (this.rudder !== 0) {
      this.rudder += (0 - this.rudder) * Math.min(1, dt * RUD_RECENTRE);
      if (Math.abs(this.rudder) < 0.02) this.rudder = 0;
    }
    if (this.rudder !== prev || this.rudderActive) { this.renderRudder(); this.h.onRudder?.(this.rudder, this.rudderActive); }
  }
  dispose() { clearInterval(this._timer); if (this.root) this.root.innerHTML = ''; }
}
