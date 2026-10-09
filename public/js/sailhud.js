// Saltline sailing HUD (docs/SAILING-CONTRACT.md §5): wind instrument (true / apparent, no-go wedge), heel gauge + helm
// bar (catamaran: hull load), performance strip (STW, SOG, target, % of target, VMG/VMC, leeway) and the sail panel
// (desktop card toggled by Q; phone bottom sheet with sail chips). Styles: public/css/sail.css (sh-*).
// The HUD never changes the rig itself: it emits rig commands (§3.4) through opts.onCommand(cmd) — the caller applies
// them optimistically (applyRigCommand) and sends them (net.action('rig', { cmd }), throttled) — and manoeuvres through
// opts.onManeuver('tack' | 'jibe'). Feed it every frame (or at ~10 Hz) with update(trimInfo(cls, ship), extra).
import { rigOf } from '../../shared/sail/rigs.js';
import {
  stateColor, ttCodes, TT_TEXT, STATE_NAMES, pctColor, heelZone, helmZone, loadZone, sheetToSlider, sliderToSheet, travToSlider, sliderToTrav,
  tickPct, crossedOptimum, maneuverFor, maneuverLabel, AUTO_LABEL, fmtKn, fmtDeg, fmtSide, fmtPct, vmgInfo, adviceLevel, keyAction, actionToCommand,
  trimAllCommand, SLIDER_MAX, sailChips,
} from './sailfmt.js';

const D2R = Math.PI / 180;
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined) e.textContent = txt; return e; };
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class SailHud {
  /** root: element to fill (position: fixed children). opts { onCommand(cmd), onManeuver(kind), phone, roundButtons (default true) } */
  constructor(root, opts = {}) {
    this.root = root; this.opts = opts;
    this.cls = null; this.info = null; this.extra = {}; this.sel = 0; this.open = false; this.phone = !!opts.phone;
    this.drag = new Set(); this.rows = []; this.lastSheet = {};
    root.classList.add('sh-root');
    root.classList.toggle('sh-phone', this.phone);
    // instruments
    this.inst = el('div', 'sh-inst glass');
    this.wind = el('canvas', 'sh-wind'); this.heel = el('canvas', 'sh-heel');
    this.perf = el('div', 'sh-perf');
    this.inst.append(this.wind, this.heel, this.perf);
    // panel
    this.panel = el('section', 'sh-panel glass hidden'); this.panel.setAttribute('aria-label', 'Sails');
    this.toast = el('div', 'sh-toast hidden');
    // phone round buttons (touch.js mounts them next to STOP / AP in phase 2; here they live in the root)
    this.touchButtons = el('div', 'sh-roundbar');
    this.btnSails = el('button', 'sh-round', 'Sails'); this.btnSails.title = 'Sails (Q)';
    this.btnMan = el('button', 'sh-round sh-man', 'Tack'); this.btnMan.title = 'Tack / jibe (Z)';
    this.touchButtons.append(this.btnSails, this.btnMan);
    this.btnSails.addEventListener('click', () => this.toggle());
    this.btnMan.addEventListener('click', () => this.maneuver());
    // desktop: a small "Sails (Q)" button under the instruments opens the panel (the legacy Sails set / furled button stays)
    this.btnPanel = el('button', 'sh-panelbtn', 'Sails  Q'); this.btnPanel.title = 'Sail trim panel (Q)';
    this.btnPanel.addEventListener('click', () => this.toggle());
    this.inst.append(this.btnPanel);
    root.append(this.inst, this.panel, this.toast);
    if (opts.roundButtons !== false) root.append(this.touchButtons);    // phase 2: touch.js carries Sails / Tack instead
    this.setPhone(this.phone);
  }
  setPhone(on) {
    this.phone = !!on; this.root.classList.toggle('sh-phone', this.phone);
    const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    const wpx = this.phone ? 76 : 128, hpx = this.phone ? 76 : 96;
    this.wind.width = wpx * dpr; this.wind.height = wpx * dpr; this.wind.style.width = this.wind.style.height = wpx + 'px';
    this.heel.width = (this.phone ? 76 : 128) * dpr; this.heel.height = hpx * dpr; this.heel.style.width = (this.phone ? 76 : 128) + 'px'; this.heel.style.height = hpx + 'px';
    this.dpr = dpr;
    if (this.cls) this.build();
  }
  /** Sail class (null / engine class hides everything). */
  setClass(cls) {
    const R = rigOf(cls);
    this.cls = R ? cls : null; this.sel = 0;
    this.root.classList.toggle('hidden', !R);
    if (R) this.build();
  }
  isOpen() { return this.open; }
  toggle(on = !this.open) { this.open = !!on; this.panel.classList.toggle('hidden', !this.open); this.root.classList.toggle('sh-open', this.open); this.btnSails.classList.toggle('on', this.open); this.btnPanel?.classList.toggle('on', this.open); this.opts.onToggle?.(this.open); if (this.open) this.render(); }
  cmd(c) { if (c && this.opts.onCommand) this.opts.onCommand(c); }
  maneuver() { const k = maneuverFor(this.info?.twa ?? 0); this.cmd({ maneuver: k }); this.opts.onManeuver?.(k); }
  /** Keyboard (§0.2). Returns true when the key was a sail key and was handled. */
  handleKey(e) {
    if (!this.cls) return false;
    const act = keyAction(e); if (!act) return false;
    const r = actionToCommand(act, this.info, this.sel);
    if (!r) return true;
    if (r.ui === 'panel') this.toggle();
    else if (r.ui === 'select') { this.sel = r.i; if (!this.open) this.toggle(true); this.render(); }
    if (r.maneuver) this.opts.onManeuver?.(r.maneuver);
    if (r.cmd) { if (this.info?.auto === 'full' && (act.type === 'sheet' || act.type === 'sheetAll' || act.type === 'trav')) { this.confirmTakeover(r.cmd); return true; } this.cmd(r.cmd); }
    e.preventDefault?.();
    return true;
  }
  confirmTakeover(then) {
    this.toast.innerHTML = '';
    const yes = el('button', 'primary', 'Take over'), no = el('button', '', 'Keep Auto');
    this.toast.append(el('span', '', 'Take over the trim?'), yes, no);
    this.toast.classList.remove('hidden');
    yes.onclick = () => { this.cmd({ auto: 'hint' }); if (then) this.cmd(then); this.toast.classList.add('hidden'); };
    no.onclick = () => this.toast.classList.add('hidden');
    clearTimeout(this._tt); this._tt = setTimeout(() => this.toast.classList.add('hidden'), 6000);
  }
  // ---------------------------------------------------------------- panel DOM
  build() {
    const p = this.panel; p.innerHTML = '';
    const head = el('div', 'sh-head');
    const seg = el('div', 'sh-seg'); seg.setAttribute('role', 'radiogroup'); seg.setAttribute('aria-label', 'Crew helper');
    this.segBtns = {};
    for (const k of ['off', 'hint', 'full']) { const b = el('button', '', AUTO_LABEL[k]); b.setAttribute('role', 'radio'); b.onclick = () => this.cmd({ auto: k }); seg.append(b); this.segBtns[k] = b; }
    const trimAll = el('button', 'sh-trimall', 'Trim all'); trimAll.title = 'Every sheet to its green tick (Ctrl+] / Ctrl+[ step all)';
    trimAll.onclick = () => { if (this.info) { if (this.info.auto === 'full') this.confirmTakeover(trimAllCommand(this.info)); else this.cmd(trimAllCommand(this.info)); } };
    this.manBtn = el('button', 'sh-manbtn', 'Tack'); this.manBtn.title = 'Tack / jibe (Z)'; this.manBtn.onclick = () => this.maneuver();
    const close = el('button', 'iconBtn sh-close', '×'); close.setAttribute('aria-label', 'Close'); close.onclick = () => this.toggle(false);
    head.append(seg, trimAll, this.manBtn, close);
    this.advice = el('div', 'sh-advice');
    this.chips = el('div', 'sh-chips');
    this.list = el('div', 'sh-list');
    const foot = el('div', 'sh-foot');
    this.footHeel = el('div', 'sh-mini'); this.footHelm = el('div', 'sh-mini');
    foot.append(this.footHeel, this.footHelm);
    p.append(head, this.advice, this.chips, this.list, foot);
    // rows (desktop: every sail; phone: the selected one, chips select)
    this.rows = [];
    const chips = sailChips(this.cls);
    for (const c of chips) {
      const chip = el('button', 'sh-chip', c.name); chip.onclick = () => { this.sel = c.i; this.render(); };
      this.chips.append(chip);
      this.rows.push(this.buildRow(c, chip));
    }
    this.render();
  }
  buildRow(c, chip) {
    const R = rigOf(this.cls), def = R.byId[c.id];
    const row = el('div', 'sh-row'); row.dataset.id = c.id;
    const top = el('div', 'sh-rowtop');
    const dot = el('i', 'sh-dot'); const name = el('b', 'sh-name', def.name); const key = el('kbd', '', c.key);
    const state = el('span', 'sh-state');
    const tts = el('span', 'sh-tts'); const ttI = [0, 1, 2].map(() => { const t = el('i', 'sh-tt'); tts.prepend(t); return t; });
    tts.title = 'Telltales (top / middle / bottom)';
    top.append(dot, name, key, state, tts);
    // hoist: furlers a 0–100 % roll slider, others Hoist / Lower with a progress bar
    const hoist = el('div', 'sh-hoist');
    let roll = null, hbtn = null, hbar = null;
    if (def.furl) {
      roll = el('input', 'sh-roll'); roll.type = 'range'; roll.min = 0; roll.max = 100; roll.step = 1; roll.title = 'Rolled out (%)';
      roll.addEventListener('pointerdown', () => this.drag.add(roll)); roll.addEventListener('pointerup', () => this.drag.delete(roll)); roll.addEventListener('change', () => this.drag.delete(roll));
      roll.addEventListener('input', () => this.cmd({ sails: { [c.id]: { hoist: Number(roll.value) / 100 } } }));
      hoist.append(el('small', '', 'Roll'), roll);
    } else {
      hbtn = el('button', 'sh-hbtn', 'Hoist'); hbar = el('i', 'sh-hbar'); hbtn.append(hbar);
      hbtn.onclick = () => { const r = this.info?.sails.find((x) => x.id === c.id); if (r) this.cmd({ sails: { [c.id]: { hoist: r.hoist > 0.5 || r.job === 'hoist' ? 0 : 1 } } }); };
      hoist.append(hbtn);
    }
    // reef stepper
    let reef = null;
    if (def.reefs.length) {
      reef = el('span', 'sh-reef');
      const m = el('button', '', '−'), n = el('b', '', '0'), pl = el('button', '', '+');
      m.title = 'Shake out a reef (Shift+R)'; pl.title = 'Reef (R)';
      m.onclick = () => { const r = this.info?.sails.find((x) => x.id === c.id); if (r) this.cmd({ sails: { [c.id]: { reef: clamp(r.reef - 1, 0, r.reefs) } } }); };
      pl.onclick = () => { const r = this.info?.sails.find((x) => x.id === c.id); if (r) this.cmd({ sails: { [c.id]: { reef: clamp(r.reef + 1, 0, r.reefs) } } }); };
      reef.append(el('small', '', 'Reef'), m, n, pl); reef.num = n;
      hoist.append(reef);
    }
    // sheet slider with the good band and the green tick
    const sheetWrap = el('div', 'sh-slider');
    const lab = el('div', 'sh-slab'); lab.append(el('small', '', 'in'), el('small', 'sh-sname', 'sheet'), el('small', '', 'out'));
    const track = el('div', 'sh-track'); const band = el('i', 'sh-band'); const tick = el('i', 'sh-tick');
    const sheet = el('input', 'sh-range'); sheet.type = 'range'; sheet.min = 0; sheet.max = SLIDER_MAX; sheet.step = 1; sheet.setAttribute('aria-label', `${def.name} sheet`);
    track.append(band, tick, sheet);
    sheetWrap.append(lab, track);
    const onSheet = () => {
      const r = this.info?.sails.find((x) => x.id === c.id); const v = sliderToSheet(sheet.value);
      if (r && this.phone && crossedOptimum(this.lastSheet[c.id] ?? r.sheet, v, r.sheetOpt)) { try { navigator.vibrate?.(5); } catch { /* no haptics */ } }
      this.lastSheet[c.id] = v;
      if (this.info?.auto === 'full') { this.confirmTakeover({ sails: { [c.id]: { sheet: v } } }); return; }
      this.cmd({ sails: { [c.id]: { sheet: v } } });
    };
    sheet.addEventListener('pointerdown', () => this.drag.add(sheet)); sheet.addEventListener('pointerup', () => this.drag.delete(sheet)); sheet.addEventListener('change', () => this.drag.delete(sheet));
    sheet.addEventListener('input', onSheet);
    // traveller (boomed sails)
    let trav = null, travTick = null;
    if (def.boom) {
      const tw = el('div', 'sh-slider sh-trav');
      const tl = el('div', 'sh-slab'); tl.append(el('small', '', 'up'), el('small', 'sh-sname', 'traveller'), el('small', '', 'down'));
      const tt = el('div', 'sh-track sh-tracksm'); travTick = el('i', 'sh-tick');
      trav = el('input', 'sh-range'); trav.type = 'range'; trav.min = 0; trav.max = SLIDER_MAX; trav.step = 1; trav.setAttribute('aria-label', `${def.name} traveller`);
      trav.addEventListener('pointerdown', () => this.drag.add(trav)); trav.addEventListener('pointerup', () => this.drag.delete(trav)); trav.addEventListener('change', () => this.drag.delete(trav));
      trav.addEventListener('input', () => { const v = sliderToTrav(trav.value); if (this.info?.auto === 'full') { this.confirmTakeover({ sails: { [c.id]: { trav: v } } }); return; } this.cmd({ sails: { [c.id]: { trav: v } } }); });
      tt.append(travTick, trav); tw.append(tl, tt); sheetWrap.append(tw);
    }
    row.append(top, hoist, sheetWrap);
    this.list.append(row);
    return { id: c.id, i: c.i, def, row, chip, dot, state, ttI, roll, hbtn, hbar, reef, sheet, band, tick, trav, travTick };
  }
  /** Feed the HUD. info = trimInfo(cls, ship) (null hides); extra = { stwKn, sogKn, cogDeg, brgDeg, leewayDeg, twdDeg } */
  update(info, extra = {}) {
    this.info = info; this.extra = extra || {};
    if (!this.cls || !info) return;
    this.drawWind(); this.drawHeel(); this.renderPerf();
    const lbl = maneuverLabel(info.twa); this.btnMan.textContent = lbl; if (this.manBtn) this.manBtn.textContent = lbl;
    if (this.open) this.render();
  }
  render() {
    const info = this.info; if (!info || !this.rows.length) return;
    for (const k in this.segBtns) { const on = info.auto === k; this.segBtns[k].classList.toggle('on', on); this.segBtns[k].setAttribute('aria-checked', on); }
    const a = info.advice;
    this.advice.textContent = a ? a.text : 'All sails are down.';
    this.advice.className = 'sh-advice ' + (a ? adviceLevel(a.key) : 'info');
    const auto = info.auto === 'full';
    this.sel = clamp(this.sel, 0, this.rows.length - 1);
    for (const r of this.rows) {
      const s = info.sails.find((x) => x.id === r.id); if (!s) continue;
      const col = stateColor(s.state);
      r.dot.className = 'sh-dot ' + col; r.chip.className = 'sh-chip ' + col + (r.i === this.sel ? ' sel' : '');
      r.state.textContent = s.job ? `crew: ${s.job}…` : STATE_NAMES[s.state] || '';
      const tt = ttCodes(s.tt);
      r.ttI.forEach((t, k) => { const c = s.state === 5 ? -1 : tt[k]; t.className = 'sh-tt ' + (c < 0 ? 'off' : ['ok', 'lift', 'stall'][c]); t.title = c < 0 ? 'down' : TT_TEXT[c]; });
      r.row.classList.toggle('sel', r.i === this.sel); r.row.classList.toggle('down', s.hoist <= 0.02 && !s.job);
      if (r.roll && !this.drag.has(r.roll)) { r.roll.value = Math.round(s.hoist * 100); r.roll.style.setProperty('--pct', `${Math.round(s.hoist * 100)}%`); }
      if (r.hbtn) { r.hbtn.firstChild.textContent = s.hoist > 0.5 || s.job === 'hoist' ? 'Lower' : 'Hoist'; r.hbar.style.width = s.job ? `${Math.round(100 * (s.job === 'lower' ? 1 - s.hoist : s.hoist))}%` : '0'; r.hbtn.classList.toggle('busy', !!s.job); }
      if (r.reef) r.reef.num.textContent = `${s.reef}/${s.reefs}`;
      if (!this.drag.has(r.sheet)) r.sheet.value = sheetToSlider(s.sheet);
      r.sheet.disabled = false; r.sheet.classList.toggle('auto', auto);
      r.band.style.left = `${tickPct(Math.min(s.sheetLo, s.sheetHi))}%`; r.band.style.width = `${Math.max(1, tickPct(Math.abs(s.sheetHi - s.sheetLo)))}%`;
      r.tick.style.left = `${tickPct(s.sheetOpt)}%`;
      if (r.trav) { if (!this.drag.has(r.trav)) r.trav.value = travToSlider(s.trav); r.travTick.style.left = `${(travToSlider(s.travOpt) / SLIDER_MAX) * 100}%`; r.trav.classList.toggle('auto', auto); }
    }
    const R = rigOf(this.cls);
    const hz = R.cat ? loadZone(info.load) : heelZone(info.heel, info.heelT);
    this.footHeel.innerHTML = R.cat ? `<small>Hull load</small><b class="${hz}">${Math.round((info.load || 0) * 100)}%</b><i class="sh-bar"><i class="${hz}" style="width:${clamp((info.load || 0) / 1, 0, 1) * 100}%"></i></i>`
      : `<small>Heel</small><b class="${hz}">${Math.abs(info.heel).toFixed(0)}°${info.heel > 0.5 ? ' S' : info.heel < -0.5 ? ' P' : ''}</b><i class="sh-bar"><i class="${hz}" style="width:${clamp(Math.abs(info.heel) / 45, 0, 1) * 100}%"></i></i>`;
    const hl = helmZone(info.helm);
    this.footHelm.innerHTML = `<small>Helm</small><b class="${hl}">${hl === 'red' ? 'rounding up!' : Math.abs(info.helm).toFixed(2)}</b><i class="sh-bar"><i class="${hl}" style="width:${clamp(Math.abs(info.helm) / 1.5, 0, 1) * 100}%"></i></i>`;
  }
  renderPerf() {
    const i = this.info, x = this.extra;
    const stw = Number.isFinite(x.stwKn) ? x.stwKn : 0, sog = Number.isFinite(x.sogKn) ? x.sogKn : stw;
    const v = vmgInfo({ stwKn: stw, sogKn: sog, twaDeg: i.twa, cogDeg: x.cogDeg, brgDeg: x.brgDeg });
    const pc = pctColor(i.pct);
    const cell = (l, val, u, cls = '') => `<div class="sh-cell ${cls}"><label>${l}</label><b>${val}<u>${u}</u></b></div>`;
    this.perf.innerHTML = cell('STW', fmtKn(stw), 'kn') + cell('SOG', fmtKn(sog), 'kn') + cell('Target', fmtKn(i.targetKn), 'kn')
      + cell('of target', fmtPct(i.pct), '', pc) + cell(v.label, fmtKn(v.kn), 'kn') + cell('Leeway', Number.isFinite(x.leewayDeg) ? Math.abs(x.leewayDeg).toFixed(1) : '—', '°');
  }
  // ---------------------------------------------------------------- canvases
  drawWind() {
    const c = this.wind, g = c.getContext('2d'), i = this.info, d = this.dpr, W = c.width, cx = W / 2, cy = W / 2, r = W / 2 - 3 * d;
    const css = getComputedStyle(this.root);
    g.clearRect(0, 0, W, W);
    g.fillStyle = 'rgba(6,17,28,0.82)'; g.beginPath(); g.arc(cx, cy, r, 0, 2 * Math.PI); g.fill();
    const ang = (deg) => (deg - 90) * D2R;   // 0° = up (the bow)
    // close-hauled sectors (AWA 20–60°): red to port, green to starboard
    for (const [a0, a1, col] of [[-60, -20, 'rgba(255,90,90,0.55)'], [20, 60, 'rgba(79,209,139,0.55)']]) { g.strokeStyle = col; g.lineWidth = 5 * d; g.beginPath(); g.arc(cx, cy, r - 4 * d, ang(a0), ang(a1)); g.stroke(); }
    // no-go wedge around the true wind
    if (i.noGo > 0 && i.tws > 0.3) { g.fillStyle = 'rgba(255,255,255,0.10)'; g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, r - 9 * d, ang(i.twa - i.noGo), ang(i.twa + i.noGo)); g.closePath(); g.fill(); }
    // ticks
    g.strokeStyle = 'rgba(200,220,235,0.5)'; g.lineWidth = 1 * d;
    for (let a = 0; a < 360; a += 10) { const k = a % 30 === 0 ? 7 : 3.5; g.beginPath(); g.moveTo(cx + Math.cos(ang(a)) * (r - 1 * d), cy + Math.sin(ang(a)) * (r - 1 * d)); g.lineTo(cx + Math.cos(ang(a)) * (r - k * d), cy + Math.sin(ang(a)) * (r - k * d)); g.stroke(); }
    // boat outline (bow up)
    const bl = r * 0.42, bw = r * 0.15;
    g.fillStyle = 'rgba(232,241,248,0.22)'; g.strokeStyle = 'rgba(232,241,248,0.7)'; g.lineWidth = 1.2 * d;
    g.beginPath(); g.moveTo(cx, cy - bl); g.quadraticCurveTo(cx + bw * 1.2, cy - bl * 0.2, cx + bw * 0.8, cy + bl * 0.75); g.lineTo(cx - bw * 0.8, cy + bl * 0.75); g.quadraticCurveTo(cx - bw * 1.2, cy - bl * 0.2, cx, cy - bl); g.fill(); g.stroke();
    // needles: TWA hollow, AWA solid (pointing to where the wind comes FROM)
    const needle = (deg, solid, col) => {
      const a = ang(deg), tip = r - 10 * d, tail = r * 0.18, w = 5 * d;
      const tx = cx + Math.cos(a) * tip, ty = cy + Math.sin(a) * tip, bx = cx + Math.cos(a) * tail, by = cy + Math.sin(a) * tail;
      const nx = -Math.sin(a) * w, ny = Math.cos(a) * w;
      g.beginPath(); g.moveTo(tx, ty); g.lineTo(bx + nx, by + ny); g.lineTo(bx - nx, by - ny); g.closePath();
      if (solid) { g.fillStyle = col; g.fill(); } else { g.strokeStyle = col; g.lineWidth = 1.6 * d; g.stroke(); }
    };
    if (i.tws > 0.3) needle(i.twa, false, '#5ad6ff');
    if (i.aws > 0.3) needle(i.awa, true, '#f2b134');
    // readouts
    g.fillStyle = '#e8f1f8'; g.textAlign = 'center';
    const kn = (v) => (v / 0.514444).toFixed(this.phone ? 0 : 1);
    if (this.phone) {
      g.font = `600 ${11 * d}px system-ui`; g.fillText(`${kn(i.aws)}`, cx, cy + r * 0.62);
    } else {
      g.font = `600 ${11 * d}px system-ui`; g.fillStyle = '#f2b134'; g.fillText(`A ${kn(i.aws)} kn ${fmtSide(i.awa)}`, cx, cy + r * 0.52);
      g.fillStyle = '#5ad6ff'; g.fillText(`T ${kn(i.tws)} kn ${fmtSide(i.twa)}`, cx, cy + r * 0.69);
      if (Number.isFinite(this.extra.twdDeg)) { g.fillStyle = 'rgba(232,241,248,0.75)'; g.font = `500 ${9.5 * d}px system-ui`; g.fillText(`TWD ${fmtDeg(this.extra.twdDeg)}`, cx, cy - r * 0.58); }
    }
    void css;
  }
  drawHeel() {
    const c = this.heel, g = c.getContext('2d'), i = this.info, d = this.dpr, W = c.width, Hh = c.height, R = rigOf(this.cls);
    g.clearRect(0, 0, W, Hh);
    g.fillStyle = 'rgba(6,17,28,0.82)'; g.beginPath(); g.roundRect ? g.roundRect(0, 0, W, Hh, 10 * d) : g.rect(0, 0, W, Hh); g.fill();
    const cx = W / 2, cy = Hh * 0.25;
    const colOf = (z) => (z === 'green' ? '#4fd18b' : z === 'amber' ? '#f2b134' : '#ff6b6b');
    if (R.cat) {
      const l = clamp(i.load || 0, 0, 1.2), z = loadZone(l);
      g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(8 * d, cy + 6 * d, W - 16 * d, 9 * d);
      g.fillStyle = colOf(z); g.fillRect(8 * d, cy + 6 * d, (W - 16 * d) * clamp(l, 0, 1), 9 * d);
      g.fillStyle = '#ff6b6b'; g.fillRect(8 * d + (W - 16 * d) * 0.7, cy + 3 * d, 1.5 * d, 15 * d);
      g.fillStyle = '#e8f1f8'; g.font = `600 ${10 * d}px system-ui`; g.textAlign = 'center'; g.fillText(`hull load ${Math.round((i.load || 0) * 100)}%`, cx, cy + 30 * d);
    } else {
      // inclinometer: a hull section + mast leaning with the heel (+ = starboard rail down → leans right) under a ±45° scale
      const px = cx, py = Hh * (this.phone ? 0.66 : 0.7), rr = Math.min(W * 0.4, py - 6 * d);
      const zone = (a0, a1, col) => { g.strokeStyle = col; g.lineWidth = 5 * d; g.beginPath(); g.arc(px, py, rr, (-90 + a0) * D2R, (-90 + a1) * D2R); g.stroke(); };
      const T = i.heelT;
      zone(-T, T, 'rgba(79,209,139,0.6)'); zone(T, T + 8, 'rgba(242,177,52,0.75)'); zone(-T - 8, -T, 'rgba(242,177,52,0.75)'); zone(T + 8, 45, 'rgba(255,107,107,0.75)'); zone(-45, -T - 8, 'rgba(255,107,107,0.75)');
      const h = clamp(i.heel, -45, 45) * D2R;
      g.save(); g.translate(px, py); g.rotate(h);
      g.fillStyle = 'rgba(232,241,248,0.85)'; g.beginPath(); g.moveTo(-rr * 0.32, -2 * d); g.quadraticCurveTo(-rr * 0.3, rr * 0.2, 0, rr * 0.24); g.quadraticCurveTo(rr * 0.3, rr * 0.2, rr * 0.32, -2 * d); g.closePath(); g.fill();
      g.strokeStyle = '#e8f1f8'; g.lineWidth = 2 * d; g.beginPath(); g.moveTo(0, -2 * d); g.lineTo(0, -rr + 3 * d); g.stroke();
      g.restore();
      g.fillStyle = colOf(heelZone(i.heel, T)); g.font = `700 ${(this.phone ? 11 : 13) * d}px system-ui`; g.textAlign = 'right';
      g.fillText(`${Math.abs(i.heel).toFixed(0)}°`, W - 7 * d, (this.phone ? 13 : 16) * d);
      if (!this.phone) { g.fillStyle = 'rgba(232,241,248,0.6)'; g.font = `600 ${9.5 * d}px system-ui`; g.textAlign = 'left'; g.fillText('heel', 8 * d, 14 * d); }
    }
    // helm bar
    const hy = Hh - (this.phone ? 13 : 18) * d, hz = helmZone(i.helm), hw = W - 16 * d, f = clamp(Math.abs(i.helm) / 1.5, 0, 1);
    g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(8 * d, hy, hw, 6 * d);
    g.fillStyle = colOf(hz); g.fillRect(8 * d, hy, hw * f, 6 * d);
    g.fillStyle = 'rgba(255,255,255,0.6)'; g.fillRect(8 * d + hw / 1.5, hy - 2 * d, 1.2 * d, 10 * d);
    if (!this.phone) { g.fillStyle = hz === 'red' ? '#ff6b6b' : 'rgba(232,241,248,0.7)'; g.font = `600 ${9.5 * d}px system-ui`; g.textAlign = 'left'; g.fillText(hz === 'red' ? 'helm — rounding up!' : 'helm', 8 * d, hy - 4 * d); }
  }
  destroy() { this.root.innerHTML = ''; this.root.classList.remove('sh-root', 'sh-phone'); }
}
