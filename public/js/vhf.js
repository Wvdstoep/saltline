// VHF radio — client UI (docs/BRIDGES-LOCKS-VHF-CONTRACT.md §1.1, §6.6, lane B).
// Desktop: a handset panel (radio front with a 7-segment channel display and a channel knob, DW 16, Hi/Lo, volume,
// stations in range on the tuned channel, call-by-name, context-sorted phrases with a filled-in preview, free text, PTT,
// a covered DISTRESS button, the log) plus a small status chip. Phone: a handset button that opens a bottom sheet
// (channel wheel, preset + context chips, station chips, phrase chips, big PTT, log).
// Keys (main.js forwards keydown/keyup, see docs/WATERWAYS-RADIO-PHASE2.md): E open/close · Shift+E dual watch ·
// [ ] channel · digits + Enter tune · Tab cycle stations · ↑/↓ phrases · hold Z = PTT (release sends) · Enter sends ·
// Shift+Z call the bridge / lock ahead · Esc close.
// The server is authoritative: this module only sends vhf_set / vhf_tx / dsc and shows what arrives (`vhf`, `vhf_st`).
import { CH_DISTRESS, CH_DSC, stepChannel, isVoice, applySet, DEFAULT_RADIO } from '../../shared/vhf.js';
import { langFor, PHRASE_LABEL } from '../../shared/vhfphrases.js';
import { esc, chLabel, powerLabel, logEntry, previewText, phraseRows, chips, quickCall, stationRows, nextTarget, parseDigits, knobAngle, playSeconds, barsText } from './vhffmt.js';
import { RadioSound } from './radiosound.js';

const HANDSET_SVG = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2.5v4.5"/><rect x="6.5" y="7" width="10" height="14.5" rx="2.2"/><rect x="8.6" y="9.3" width="5.8" height="3.6" rx=".6"/><path d="M9 15.5h5M9 18h5"/></svg>';
const KIND_LABEL = { bridge: 'Bridge', lock: 'Lock', vts: 'VTS', cg: 'Coastguard', ship: 'Ship', player: 'Player', harbour: 'Harbour' };
const DSC_HOLD_MS = 3000;
const MAX_LOG = 80;

const h = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

export class Vhf {
  /**
   * @param {object} o { net: {action(name, extra)}, root?: HTMLElement, phone?: boolean, sound?: RadioSound, voices?: boolean,
   *                     shipInfo?: (you) => {L, B, type, where}, uiLang?: string, now?: () => ms }
   */
  constructor(o = {}) {
    this.net = o.net; this.root = o.root || document.body; this.phone = !!o.phone;
    this.sound = o.sound || new RadioSound({ voices: o.voices !== false });
    this.shipInfo = o.shipInfo || (() => ({}));
    this.uiLang = o.uiLang || (globalThis.navigator?.language || 'en');
    this.now = o.now || (() => Date.now());
    this.isOpen = false;
    this.radio = { ...DEFAULT_RADIO };
    this.you = null;
    this.st = { ch: 16, stations: [], near: [], sector: null, fallbackCh: null };
    this.target = null; this.phraseIdx = 0; this.digits = ''; this.digitsT = 0;
    this.tx = false; this.busyUntil = 0; this.log = []; this.unread = 0;
    this.dscCover = false; this.dscHold = null; this.side = 'port';
    this.build();
    this.renderAll();
  }

  // ---------------------------------------------------------------- state from the server
  onYou(you) {
    this.you = you;
    if (you?.radio) { this.radio = { ...this.radio, ...you.radio }; }
    this.renderFront(); this.renderPreview(); this.renderMini();
  }
  /** Handle a server message; true when it was a radio message. */
  onMessage(m) {
    if (!m || typeof m !== 'object') return false;
    if (m.t === 'vhf_st') { this.st = { ...this.st, ...m }; this.renderChips(); this.renderStations(); this.renderPhrases(); this.renderFront(); return true; }
    if (m.t === 'vhf') { this.receive(m); return true; }
    return false;
  }
  lang() { return langFor(this.radio.lang, { inlandNL: !!this.radio.inland, uiLang: this.uiLang }); }
  receive(m) {
    const e = logEntry(m, { lang: this.lang() });
    this.log.push(e); if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
    if (!this.isOpen && !e.self) this.unread++;
    if (!e.self) {
      const s = this.sound, dur = playSeconds(e.text);
      this.busyUntil = this.now() + dur * 1000;
      if (e.dsc) s.alarm();
      else {
        s.squelchOpen(); s.bed(e.q, dur);
        if (e.op) s.speak(e.text, { lang: this.lang(), seed: m.from?.id || '' });
        clearTimeout(this._tailT);
        this._tailT = setTimeout(() => { s.tail(); if (e.op) s.pip(); this.renderFront(); }, dur * 1000);
      }
      this.flashMini(e);
    }
    this.renderLog(); this.renderFront(); this.renderMini();
  }

  // ---------------------------------------------------------------- actions
  setRadio(patch) {
    this.radio = applySet(this.radio, patch);
    this.net?.action('vhf_set', patch);
    this.renderFront(); this.renderChips(); this.renderStations(); this.renderPreview(); this.renderMini();
  }
  setChannel(ch) {
    if (!isVoice(ch)) { this.flashLcd(ch === CH_DSC ? 'DSC ONLY' : 'NO CH'); return; }
    if (ch !== this.radio.ch) { this.st = { ...this.st, ch, stations: [] }; if (this.target && this.target.kind !== 'player' && !this.st.near.some((n) => n.id === this.target.id)) this.target = null; }
    this.setRadio({ ch });
  }
  step(dir) { this.setChannel(stepChannel(this.radio.ch, dir)); }
  toggleDual() { this.setRadio({ dual: !this.radio.dual }); }
  togglePower() { this.setRadio({ power: this.radio.power === 'lo' ? 'hi' : 'lo' }); }
  open(v = true) {
    if (v === this.isOpen) return;
    this.isOpen = v; this.sound.unlock();
    if (v) this.unread = 0;
    this.panel.classList.toggle('hidden', !v);
    this.panel.setAttribute('aria-hidden', String(!v));
    this.net?.action('vhf_set', { open: v });
    this.radio.open = v;
    if (v) { this.renderAll(); if (!this.phone) this.panel.focus?.({ preventScroll: true }); }
    this.renderMini();
  }
  toggle() { this.open(!this.isOpen); }
  phrases() { return phraseRows({ target: this.target, near: this.st.near[0] || null, ch: this.radio.ch }, this.lang()); }
  selectPhrase(id) { const i = this.phrases().findIndex((r) => r.id === id); if (i >= 0) this.phraseIdx = i; this.renderPhrases(); this.renderPreview(); }
  selectTarget(t) {
    const cur = this.phrases()[this.phraseIdx]?.id;
    this.target = t ? { id: t.id, name: t.name, kind: t.kind } : null;
    if (this.inTarget) this.inTarget.value = t ? t.name : '';
    this.phraseIdx = 0;                                                  // context-sorted list: the best phrase is first again
    if (cur === 'ack' || cur === 'say_again') this.selectPhrase(cur);
    this.renderStations(); this.renderPhrases(); this.renderPreview(); this.renderFront();
  }
  useChip(c) {
    if (c.ch && c.ch !== this.radio.ch) this.setChannel(c.ch);
    if (c.to) this.selectTarget(c.to);
    if (c.phrase) this.selectPhrase(c.phrase);
    this.renderChips();
  }
  quick() {
    const q = quickCall(this.st.near);
    if (!this.isOpen) this.open(true);
    if (!q) { this.flashLcd('NO STN'); return; }
    this.useChip(q);
  }
  /** Build the transmission from the current selection and send it. */
  send() {
    const text = (this.inFree?.value || '').trim();
    const row = this.phrases()[this.phraseIdx];
    if (!text && !row) return;
    const to = this.target ? this.target.id : (this.inTarget?.value.trim() || null);
    const m = { ch: this.radio.ch, to };
    if (text) m.text = text.slice(0, 120); else { m.phrase = row.id; m.args = { side: this.side }; }
    this.net?.action('vhf_tx', m);
    if (text && this.inFree) this.inFree.value = '';
    this.sound.tail();
    this.lastSent = m;
    this.renderPreview();
  }
  pttDown() { if (this.tx) return; this.tx = true; this.sound.unlock(); this.sound.key(); this.renderFront(); this.pttBtns.forEach((b) => b.classList.add('on')); }
  pttUp(send = true) { if (!this.tx) return; this.tx = false; this.pttBtns.forEach((b) => b.classList.remove('on')); this.renderFront(); if (send) this.send(); }
  // DISTRESS: lift the cover, then hold 3 s
  dscDown() {
    if (!this.dscCover) { this.dscCover = true; this.renderDsc(); clearTimeout(this._coverT); this._coverT = setTimeout(() => { this.dscCover = false; this.renderDsc(); }, 10000); return; }
    const t0 = this.now();
    this.dscHold = { t0 };
    const tick = () => {
      if (!this.dscHold || this.dscHold.t0 !== t0) return;
      const f = Math.min(1, (this.now() - t0) / DSC_HOLD_MS);
      this.dscBtns.forEach((b) => b.style.setProperty('--hold', f.toFixed(3)));
      if (f >= 1) { this.dscHold = null; this.dscCover = false; this.net?.action('dsc', { kind: 'distress', nature: 'undesignated' }); this.sound.alarm(); this.renderDsc(); return; }
      this._dscRaf = requestAnimationFrame(tick);
    };
    tick();
  }
  dscUp() { if (this.dscHold) { this.dscHold = null; cancelAnimationFrame(this._dscRaf); this.dscBtns.forEach((b) => b.style.setProperty('--hold', '0')); } }

  // ---------------------------------------------------------------- keys
  /** keydown from main.js (before the sailing keys). true = consumed. */
  handleKey(e) {
    const k = String(e.key || '').toLowerCase();
    if (k === 'e' && !e.ctrlKey && !e.altKey && !e.metaKey) { if (e.shiftKey) this.toggleDual(); else this.toggle(); e.preventDefault?.(); return true; }
    if (k === 'z' && e.shiftKey) { this.quick(); e.preventDefault?.(); return true; }
    if (!this.isOpen) return false;
    if (k === 'escape') { this.open(false); return true; }
    if (k === '[' || k === '{' || e.code === 'BracketLeft') { this.step(-1); e.preventDefault?.(); return true; }
    if (k === ']' || k === '}' || e.code === 'BracketRight') { this.step(1); e.preventDefault?.(); return true; }
    if (/^[0-9]$/.test(k)) { this.digits = (this.digits + k).slice(-2); this.digitsT = this.now(); this.renderFront(); e.preventDefault?.(); return true; }
    if (k === 'backspace' && this.digits) { this.digits = ''; this.renderFront(); return true; }
    if (k === 'enter') {
      if (this.digits) { const ch = parseDigits(this.digits); this.digits = ''; if (ch) this.setChannel(ch); else this.flashLcd('NO CH'); }
      else this.send();
      e.preventDefault?.(); return true;
    }
    if (k === 'tab') { const t = nextTarget(this.st.stations, this.target?.id, e.shiftKey ? -1 : 1); if (t) this.selectTarget(t); e.preventDefault?.(); return true; }
    if (k === 'arrowup' || k === 'arrowdown') { const n = this.phrases().length; this.phraseIdx = (this.phraseIdx + (k === 'arrowup' ? -1 : 1) + n) % n; this.renderPhrases(); this.renderPreview(); e.preventDefault?.(); return true; }
    if (k === 'arrowleft' || k === 'arrowright') { if (['pass_port', 'pass_stbd', 'overtake'].includes(this.phrases()[this.phraseIdx]?.id)) { this.side = k === 'arrowleft' ? 'port' : 'stbd'; this.renderPreview(); } e.preventDefault?.(); return true; }
    if (k === 'z') { if (!e.repeat) this.pttDown(); e.preventDefault?.(); return true; }
    return false;
  }
  handleKeyUp(e) {
    const k = String(e.key || '').toLowerCase();
    if (k === 'z' && this.tx) { this.pttUp(true); return true; }
    return false;
  }

  // ---------------------------------------------------------------- DOM
  build() {
    // status chip (desktop) / handset button (phone)
    this.mini = h('button', `vhf-mini${this.phone ? ' vhf-handset' : ''}`);
    this.mini.type = 'button';
    this.mini.setAttribute('aria-label', 'VHF radio (E)');
    this.mini.onclick = () => this.toggle();
    this.ticker = h('div', 'vhf-ticker hidden'); this.ticker.setAttribute('aria-live', 'polite');
    this.root.append(this.mini, this.ticker);
    const p = this.panel = h('div', `vhf ${this.phone ? 'vhf-phone' : 'vhf-desk'} hidden`);
    p.setAttribute('role', 'dialog'); p.setAttribute('aria-label', 'VHF radio'); p.tabIndex = -1;
    if (this.phone) {
      p.innerHTML = `
        <div class="vhf-grab" aria-hidden="true"></div>
        <div class="vhf-head">
          <div class="vhf-lcd vhf-lcd-s"></div>
          <div class="vhf-headbtns"><button data-act="dual" class="vhf-tg">DW 16</button><button data-act="power" class="vhf-tg">HI</button><button data-act="close" class="iconBtn" aria-label="Close">×</button></div>
        </div>
        <div class="vhf-wheel" role="listbox" aria-label="Channel wheel"></div>
        <div class="vhf-chips"></div>
        <div class="vhf-stations vhf-st-chips"></div>
        <div class="vhf-phrases vhf-ph-chips" role="listbox" aria-label="Phrases"></div>
        <div class="vhf-preview"></div>
        <div class="vhf-log" aria-live="polite"></div>
        <div class="vhf-bottom">
          <div class="vhf-dscwrap"></div>
          <button class="vhf-ptt" data-ptt><span class="ptt-big">PTT</span><span class="ptt-sub">hold · release to send</span></button>
        </div>`;
    } else {
      p.innerHTML = `
        <div class="vhf-l">
          <div class="vhf-front">
            <div class="vhf-top"><span class="vhf-brand">SALTLINE · VHF/DSC</span><button data-act="close" class="iconBtn" aria-label="Close (E)">×</button></div>
            <div class="vhf-body">
              <div class="vhf-lcd"></div>
              <div class="vhf-knobcol">
                <div class="vhf-knob" data-knob title="Channel: drag, wheel, or [ / ]"><div class="knob-cap"><div class="knob-ind"></div></div></div>
                <div class="knob-btns"><button data-act="chdn" aria-label="Channel down">[</button><button data-act="chup" aria-label="Channel up">]</button></div>
              </div>
            </div>
            <div class="vhf-keys">
              <button data-act="ch16" title="16 / 9">16/9</button>
              <button data-act="dual" class="vhf-tg" title="Dual watch 16 (Shift+E)">DW</button>
              <button data-act="power" class="vhf-tg" title="25 W / 1 W">HI</button>
              <label class="vhf-vol">VOL <input type="range" min="0" max="100" data-vol aria-label="Volume"></label>
            </div>
          </div>
          <section class="vhf-sec"><h4 class="vhf-h4" data-sth></h4><ul class="vhf-stations"></ul></section>
          <section class="vhf-sec vhf-logsec"><h4 class="vhf-h4">Log</h4><div class="vhf-log" aria-live="polite"></div></section>
        </div>
        <div class="vhf-r">
          <div class="vhf-chips"></div>
          <label class="vhf-call">Call <input type="text" class="vhf-to" list="vhfNames" placeholder="All stations — or type a name" autocomplete="off" spellcheck="false"></label>
          <datalist id="vhfNames"></datalist>
          <ul class="vhf-phrases" role="listbox" aria-label="Phrases (↑/↓)"></ul>
          <div class="vhf-preview"></div>
          <input type="text" class="vhf-free" maxlength="120" placeholder="Free text to players (Enter sends)" autocomplete="off">
          <div class="vhf-bottom">
            <button class="vhf-ptt" data-ptt><span class="ptt-big">PTT</span><span class="ptt-sub">hold <kbd>Z</kbd> · <kbd>Enter</kbd></span></button>
            <div class="vhf-dscwrap"></div>
          </div>
          <div class="vhf-help"><kbd>E</kbd> radio · <kbd>[</kbd><kbd>]</kbd> channel · digits+<kbd>Enter</kbd> tune · <kbd>Tab</kbd> station · <kbd>↑</kbd><kbd>↓</kbd> phrase · <kbd>Shift+E</kbd> DW · <kbd>Shift+Z</kbd> call ahead</div>
        </div>`;
    }
    this.root.append(p);
    const q = (s) => p.querySelector(s);
    this.lcd = q('.vhf-lcd'); this.knob = q('[data-knob]'); this.elChips = q('.vhf-chips'); this.elStations = q('.vhf-stations');
    this.elPhrases = q('.vhf-phrases'); this.elPreview = q('.vhf-preview'); this.elLog = q('.vhf-log'); this.elWheel = q('.vhf-wheel');
    this.inTarget = q('.vhf-to'); this.inFree = q('.vhf-free'); this.dl = q('#vhfNames'); this.sth = q('[data-sth]'); this.vol = q('[data-vol]');
    this.pttBtns = [...p.querySelectorAll('[data-ptt]')];
    // DISTRESS: covered red button
    this.dscBtns = [];
    for (const w of p.querySelectorAll('.vhf-dscwrap')) {
      const b = h('button', 'vhf-dsc', '<span class="dsc-cover"><span>DISTRESS</span></span><span class="dsc-face">DISTRESS<small>hold 3 s</small></span>');
      b.type = 'button'; b.setAttribute('aria-label', 'DSC distress: lift the cover, then hold 3 seconds');
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); this.dscDown(); });
      for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => this.dscUp());
      w.append(b); this.dscBtns.push(b);
    }
    // PTT: hold, release to send
    for (const b of this.pttBtns) {
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); try { b.setPointerCapture(e.pointerId); } catch { /* */ } this.pttDown(); });
      b.addEventListener('pointerup', () => this.pttUp(true));
      b.addEventListener('pointercancel', () => this.pttUp(false));
      b.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); this.send(); } });
    }
    p.addEventListener('click', (e) => {
      const a = e.target.closest('[data-act]'); if (!a) return;
      const act = a.dataset.act;
      if (act === 'close') this.open(false);
      else if (act === 'chup') this.step(1);
      else if (act === 'chdn') this.step(-1);
      else if (act === 'ch16') this.setChannel(this.radio.ch === CH_DISTRESS ? 9 : CH_DISTRESS);
      else if (act === 'dual') this.toggleDual();
      else if (act === 'power') this.togglePower();
      else if (act === 'chip') { const c = this._chips?.find((x) => x.key === a.dataset.key); if (c) this.useChip(c); }
      else if (act === 'st') { const s = this.st.stations.find((x) => x.id === a.dataset.id); if (s && !s.silent) this.selectTarget(this.target?.id === s.id ? null : s); }
      else if (act === 'ph') { this.phraseIdx = Number(a.dataset.i) || 0; this.renderPhrases(); this.renderPreview(); }
      else if (act === 'side') { this.side = this.side === 'port' ? 'stbd' : 'port'; this.renderPreview(); }
      else if (act === 'wch') this.setChannel(Number(a.dataset.ch));
    });
    if (this.vol) { this.vol.value = String(Math.round((this.radio.vol ?? 0.8) * 100)); this.vol.oninput = () => { const v = Number(this.vol.value) / 100; this.sound.setVolume(v); this.radio.vol = v; }; this.vol.onchange = () => this.net?.action('vhf_set', { vol: Number(this.vol.value) / 100 }); }
    if (this.inTarget) {
      this.inTarget.addEventListener('input', () => {
        const v = this.inTarget.value.trim().toLowerCase();
        const s = [...this.st.stations, ...this.st.near].find((x) => x.name.toLowerCase() === v);
        this.target = s ? { id: s.id, name: s.name, kind: s.kind } : null;
        this.renderStations(); this.renderPhrases(); this.renderPreview();
      });
      this.inTarget.addEventListener('keydown', (e) => {
        if (['Enter', 'Escape', 'Tab'].includes(e.key)) e.stopPropagation();      // the window key handler must not see these
        if (e.key === 'Enter') { e.preventDefault(); this.send(); }
        else if (e.key === 'Escape') this.inTarget.blur();
        else if (e.key === 'Tab') { e.preventDefault(); const t = nextTarget(this.st.stations, this.target?.id, e.shiftKey ? -1 : 1); if (t) this.selectTarget(t); }
      });
    }
    if (this.inFree) {
      this.inFree.addEventListener('input', () => this.renderPreview());
      this.inFree.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); this.send(); } else if (e.key === 'Escape') this.inFree.blur(); });
    }
    if (this.knob) this.bindKnob(this.knob);
    if (this.elWheel) this.bindWheel(this.elWheel);
  }
  bindKnob(k) {
    k.addEventListener('wheel', (e) => { e.preventDefault(); this.step(e.deltaY > 0 ? -1 : 1); }, { passive: false });
    let drag = null;
    k.addEventListener('pointerdown', (e) => { drag = { y: e.clientY, x: e.clientX, acc: 0 }; try { k.setPointerCapture(e.pointerId); } catch { /* */ } });
    k.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const d = (drag.y - e.clientY) + (e.clientX - drag.x); drag.y = e.clientY; drag.x = e.clientX; drag.acc += d;
      while (drag.acc > 14) { drag.acc -= 14; this.step(1); }
      while (drag.acc < -14) { drag.acc += 14; this.step(-1); }
    });
    k.addEventListener('pointerup', () => { drag = null; });
    k.addEventListener('dblclick', () => this.setChannel(CH_DISTRESS));
  }
  bindWheel(w) {
    // a horizontal strip of channel numbers with snap; the centred one is tuned when the swipe settles
    let t = null;
    w.addEventListener('scroll', () => {
      if (this._wheelSetting) return;
      clearTimeout(t);
      t = setTimeout(() => {
        const mid = w.scrollLeft + w.clientWidth / 2;
        let best = null, bd = Infinity;
        for (const b of w.children) { const c = b.offsetLeft + b.offsetWidth / 2; if (Math.abs(c - mid) < bd) { bd = Math.abs(c - mid); best = b; } }
        const ch = Number(best?.dataset.ch);
        if (ch && ch !== this.radio.ch) this.setChannel(ch);
      }, 160);
    }, { passive: true });
  }

  // ---------------------------------------------------------------- render
  renderAll() { this.renderFront(); this.renderChips(); this.renderStations(); this.renderPhrases(); this.renderPreview(); this.renderLog(); this.renderDsc(); this.renderMini(); this.renderWheel(); }
  flashLcd(text) { this._flash = { text, until: this.now() + 1400 }; this.renderFront(); clearTimeout(this._flashT); this._flashT = setTimeout(() => this.renderFront(), 1500); }
  renderFront() {
    if (!this.lcd) return;
    const r = this.radio, L = chLabel(r.ch), t = this.now();
    const busy = t < this.busyUntil, flash = this._flash && t < this._flash.until ? this._flash.text : null;
    const digits = this.digits ? this.digits.padStart(2, '-') : L.num;
    const tgt = this.target ? `→ ${esc(this.target.name)}${this.targetBars() != null ? ` <span class="lcd-bars">${barsText(this.targetBars())}</span>` : ''}` : '→ all stations';
    this.lcd.className = `vhf-lcd${this.phone ? ' vhf-lcd-s' : ''}${r.on ? '' : ' off'}`;
    this.lcd.innerHTML = `
      <div class="lcd-row"><span class="lcd-tag${r.dual ? ' on' : ''}">DW 16</span><span class="lcd-tag on" title="${esc(powerLabel(r))}">${esc(powerLabel(r, true))}</span><span class="lcd-tag tx${this.tx ? ' on' : ''}">TX</span><span class="lcd-tag busy${busy ? ' on' : ''}">BUSY</span><span class="lcd-tag on">${this.lang().toUpperCase()}</span></div>
      <div class="lcd-main"><div class="lcd-ch${this.digits ? ' entry' : ''}"><span class="lcd-ghost">88</span><span class="lcd-num">${esc(flash ? '--' : digits)}</span></div>
        <div class="lcd-side"><span class="lcd-dup">${L.duplex ? 'DUP' : 'SIM'}</span><span class="lcd-name">${esc(flash || L.name)}</span><span class="lcd-tgt">${tgt}</span></div></div>`;
    if (this.knob) this.knob.querySelector('.knob-cap').style.transform = `rotate(${knobAngle(r.ch)}deg)`;
    for (const b of this.panel.querySelectorAll('[data-act="dual"]')) { b.classList.toggle('on', !!r.dual); b.setAttribute('aria-pressed', String(!!r.dual)); }
    for (const b of this.panel.querySelectorAll('[data-act="power"]')) { const lo = r.power === 'lo'; b.textContent = lo ? 'LO 1 W' : 'HI 25 W'; b.classList.toggle('on', lo); }
    if (this.sth) this.sth.innerHTML = `On ch ${esc(L.num)} · in range <span class="muted">${this.st.stations.length}</span>`;
    this.renderWheel();
  }
  targetBars() { const s = this.st.stations.find((x) => x.id === this.target?.id); return s ? s.bars : null; }
  renderWheel() {
    const w = this.elWheel; if (!w) return;
    if (!w.childElementCount) {
      const all = []; for (let c = 1; c <= 88; c++) if (isVoice(c)) all.push(c);
      w.innerHTML = all.map((c) => `<button data-act="wch" data-ch="${c}" role="option">${String(c).padStart(2, '0')}</button>`).join('');
    }
    for (const b of w.children) b.classList.toggle('on', Number(b.dataset.ch) === this.radio.ch);
    const cur = w.querySelector('.on');
    if (cur && this.isOpen) { this._wheelSetting = true; w.scrollLeft = cur.offsetLeft - w.clientWidth / 2 + cur.offsetWidth / 2; setTimeout(() => { this._wheelSetting = false; }, 60); }
  }
  renderChips() {
    if (!this.elChips) return;
    this._chips = chips({ near: this.st.near, sector: this.st.sector, fallbackCh: this.st.fallbackCh, ch: this.radio.ch });
    this.elChips.innerHTML = this._chips.map((c) => `<button data-act="chip" data-key="${esc(c.key)}" class="vhf-chip k-${c.kind}${c.hot ? ' hot' : ''}${c.on ? ' on' : ''}${c.preset ? ' preset' : ''}${c.silent ? ' silent' : ''}">${c.preset ? `ch ${esc(c.label)}` : esc(c.label)}</button>`).join('');
  }
  renderStations() {
    const el = this.elStations; if (!el) return;
    const rows = stationRows(this.st.stations, this.target?.id);
    if (!rows.length) { el.innerHTML = `<${this.phone ? 'div' : 'li'} class="vhf-empty muted">Nobody in range on ch ${esc(chLabel(this.radio.ch).num)}${this.st.near.length ? ` — try ${esc(this.st.near.map((n) => `${n.name}: ch ${n.ch}`).join(', '))}` : ''}</${this.phone ? 'div' : 'li'}>`; }
    else if (this.phone) el.innerHTML = rows.map((s) => `<button data-act="st" data-id="${esc(s.id)}" class="vhf-stc k-${s.kind}${s.sel ? ' sel' : ''}${s.silent ? ' silent' : ''}"><span class="stc-bars b${s.bars}"><i></i><i></i><i></i><i></i></span>${esc(s.name)}${s.silent ? ' <small>silent</small>' : ''}</button>`).join('');
    else el.innerHTML = rows.map((s) => `<li><button data-act="st" data-id="${esc(s.id)}" class="vhf-st k-${s.kind}${s.sel ? ' sel' : ''}${s.silent ? ' silent' : ''}" ${s.silent ? 'aria-disabled="true"' : ''}><span class="st-kind">${esc(KIND_LABEL[s.kind] || s.kind)}</span><span class="st-name">${esc(s.name)}</span>${s.silent ? `<span class="st-why">silent: ${esc(s.why || 'out of hours')}</span>` : ''}<span class="stc-bars b${s.bars}" aria-label="signal ${s.bars} of 4"><i></i><i></i><i></i><i></i></span></button></li>`).join('');
    if (this.dl) this.dl.innerHTML = [...this.st.stations, ...this.st.near].map((s) => `<option value="${esc(s.name)}">`).join('');
  }
  renderPhrases() {
    const el = this.elPhrases; if (!el) return;
    const rows = this.phrases();
    if (this.phraseIdx >= rows.length) this.phraseIdx = 0;
    if (this.phone) el.innerHTML = rows.filter((r) => !['mayday'].includes(r.id)).map((r, i) => `<button data-act="ph" data-i="${i}" class="vhf-phc${i === this.phraseIdx ? ' sel' : ''}${r.id === 'req_open' || r.id === 'req_lock' ? ' hot' : ''}" role="option" aria-selected="${i === this.phraseIdx}">${esc(r.label)}</button>`).join('');
    else el.innerHTML = rows.map((r, i) => `<li><button data-act="ph" data-i="${i}" class="vhf-ph${i === this.phraseIdx ? ' sel' : ''}" role="option" aria-selected="${i === this.phraseIdx}">${esc(r.label)}</button></li>`).join('');
    el.querySelector('.sel')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }
  renderPreview() {
    const el = this.elPreview; if (!el) return;
    const text = this.inFree?.value.trim() || '';
    const row = this.phrases()[this.phraseIdx];
    const info = this.shipInfo(this.you) || {};
    const pv = previewText({ phrase: row?.id, text, target: this.target, you: this.you || {}, info, lang: this.lang(), args: { side: this.side } });
    const sideBtn = row?.id === 'overtake' ?` <button data-act="side" class="vhf-side">${this.side === 'port' ? 'port side' : 'starboard side'} ⇄</button>` : '';
    el.innerHTML = `<span class="pv-ch">ch ${esc(chLabel(this.radio.ch).num)}</span> ${esc(pv)}${sideBtn}`;
  }
  renderLog() {
    const el = this.elLog; if (!el) return;
    if (!this.log.length) { el.innerHTML = '<div class="vhf-empty muted">Listening… transmissions on your channel (and 16 on dual watch) appear here.</div>'; return; }
    el.innerHTML = this.log.map((e) => `<div class="vhf-msg k-${e.fromKind}${e.self ? ' self' : ''}${e.garbled ? ' garbled' : ''}${e.dsc ? ' dsc' : ''}">
      <div class="msg-h"><span class="msg-ch">${e.dsc ? 'DSC' : `ch ${esc(String(e.ch).padStart(2, '0'))}`}</span><b>${esc(e.self ? 'You' : e.from)}</b>${e.to ? `<span class="msg-to">→ ${esc(e.to)}</span>` : ''}<span class="msg-t">${esc(e.time)}</span>${e.self ? '' : `<span class="stc-bars b${e.bars}"><i></i><i></i><i></i><i></i></span>`}</div>
      <div class="msg-x">${esc(e.text)}</div></div>`).join('');
    el.scrollTop = el.scrollHeight;
  }
  renderDsc() {
    for (const b of this.dscBtns || []) { b.classList.toggle('open', this.dscCover); b.style.setProperty('--hold', '0'); }
  }
  renderMini() {
    const r = this.radio, L = chLabel(r.ch);
    this.mini.classList.toggle('active', this.isOpen);
    this.mini.innerHTML = this.phone
      ? `${HANDSET_SVG}<span class="mini-ch">${esc(L.num)}</span>${this.unread ? `<span class="mini-badge">${this.unread}</span>` : ''}`
      : `${HANDSET_SVG}<span class="mini-ch">ch ${esc(L.num)}</span>${r.dual ? '<span class="mini-dw">DW</span>' : ''}${this.unread ? `<span class="mini-badge">${this.unread}</span>` : ''}<kbd>E</kbd>`;
  }
  flashMini(e) {
    if (this.isOpen) return;
    this.ticker.innerHTML = `<b>${esc(e.from)}</b> <span class="muted">ch ${esc(String(e.ch))}</span> ${esc(e.text)}`;
    this.ticker.classList.remove('hidden');
    clearTimeout(this._tickT); this._tickT = setTimeout(() => this.ticker.classList.add('hidden'), 7000);
  }
  /** Labels of the phrase list (for tests / the harness). */
  phraseLabels() { return this.phrases().map((r) => (PHRASE_LABEL[this.lang()] || PHRASE_LABEL.en)[r.id]); }
}
