// HUD (docs/V4-CONTRACTS.md §1–§3, V3 §7): compact glass top bar with the ship image, instrument strip, radar, action dock,
// time-warp control + banner, berth / fishing cards, weather panel, the full-screen harbour sheet (nav rail on desktop,
// bottom tabs on phones; overview, contracts, job boards, market, shipyard with images + compare, services, black
// market, players), the ships list, chart (delegated to chart.js), rescue / hail / prompts, interior and ashore HUDs and
// the touch layout. Every method name main.js / interior.js / chart.js / ashore.js call is kept.
import { fmtDMS, bearing, unitsBetween, haversine, fmtDistance } from '/shared/geo.js';
import * as K from '/shared/constants.js';
import { fuelBurnPerSimHour } from '/shared/physics.js';
import { orderLabel, isAstern, THROTTLE_MIN } from '/shared/telegraph.js';
import { Chart, fetchJobs, cachedJobs, collectAi, collectRescues, collectStorms, fmtDur, fmtClock } from './chart.js';
import { isTouch, TouchHelm } from './touch.js';
import { ICON, ic, GOOD_ICON, JOB_ICON, CAT_ICON, iconDataUrl } from './icons.js';
import { jobWhere, fmtLeft, JOB_COLOR } from './jobs.js';
import { estimateJob, hardReason, fmtShipH, JOBTIME } from '/shared/jobtime.js'; // V6 item 5: contract hours on the ship's clock

const { GOODS, SHIP_CLASSES, GEO, SIM, INTERACT } = K;
const $ = (id) => document.getElementById(id);
const fmt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—');
const fmt1 = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 1 }) : '—');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pad2 = (n) => String(n).padStart(2, '0');
const pad3 = (n) => String(Math.round(n) % 360).padStart(3, '0');
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const short = (name) => String(name || '').split(' (')[0];
const setText = (el, t) => { if (el && el.textContent !== t) el.textContent = t; };
const setLbl = (id, t) => { const el = typeof id === 'string' ? $(id) : id; if (!el) return; const l = el.querySelector('.lbl'); setText(l || el, t); };
const RANGES_KM = [2, 5, 10, 20, 50, 100, 250, 1000];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CATS = ['cargo', 'working', 'passenger', 'motor yacht', 'sailing yacht'];
const CAT_LABEL = { cargo: 'Cargo', working: 'Working', passenger: 'Passenger', 'motor yacht': 'Motor yachts', 'sailing yacht': 'Sailing yachts' };
const TABS = ['overview', 'jobs', 'boards', 'market', 'shipyard', 'services', 'shady', 'players'];
const TAB_ALIAS = { info: 'overview', port: 'overview', harbour: 'overview', harbor: 'overview', contracts: 'jobs', contract: 'jobs', harbourmaster: 'jobs', harbormaster: 'jobs', job: 'jobs',
  board: 'boards', jobboards: 'boards', yard: 'shipyard', ships: 'shipyard', ship: 'shipyard', chandler: 'services', fuel: 'services', repair: 'services', service: 'services',
  bar: 'shady', blackmarket: 'shady', black: 'shady', look: 'shady', lookaround: 'shady', crew: 'players', skippers: 'players' };
const JOB_LABEL = { freight: 'Freight', passengers: 'Passengers', charter: 'Charter', fishing: 'Fishing', supply: 'Offshore supply', tow: 'Tow', smuggling: 'Smuggling' };
const NM = 1852;
const DEFAULT_WARP = [1, 5, 20, 100, 400];

export function fmtUTC(sec) {
  if (!(sec > 1e9)) return '—';
  const d = new Date(sec * 1000);
  return `${DAYS[d.getUTCDay()]} ${pad2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}
/** Duration with seconds for short spans: '45 s', '1 min 55 s', '3 h 12 min', '2 d 4 h'. */
export function fmtDurS(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s`;
  if (sec < 600) { const m = Math.floor(sec / 60), s = Math.round(sec % 60); return s ? `${m} min ${s} s` : `${m} min`; }
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${pad2(m % 60)} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}
/** Douglas sea state word from the significant wave height (m). */
export function seaStateWord(h) {
  return h < 0.1 ? 'calm' : h < 0.5 ? 'smooth' : h < 1.25 ? 'slight' : h < 2.5 ? 'moderate' : h < 4 ? 'rough' : h < 6 ? 'very rough' : h < 9 ? 'high' : h < 14 ? 'very high' : 'phenomenal';
}
export function beaufort(ms) { const t = [0.3, 1.6, 3.4, 5.5, 8, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7]; let b = 0; while (b < t.length && ms >= t[b]) b++; return b; }
/** Accept the v0.2 compact weather, the flat wire shape ({windDir, windSpd, waveH, …}) and the nested v0.3 shape. */
export function normWeather(w) {
  if (!w) return null;
  const wind = w.wind ? { spd: w.wind.spd ?? 0, dir: w.wind.dir ?? 0, gust: w.wind.gust } : { spd: w.windSpd ?? 0, dir: w.windDir ?? 0, gust: w.gust };
  const waves = w.waves && Number.isFinite(w.waves.height) ? w.waves
    : Number.isFinite(w.waveH) ? { height: w.waveH, dir: w.waveDir ?? wind.dir, period: w.wavePeriod ?? null }
      : { height: Math.round((w.sea ?? 0) * 6 * 10) / 10, dir: wind.dir, period: null };
  const swell = w.swell || (Number.isFinite(w.swellH) ? { height: w.swellH, dir: w.swellDir, period: w.swellPeriod } : null);
  return { wind, waves, swell, sea: w.sea ?? Math.min(1, waves.height / 6), storm: w.storm ?? 0, rain: w.rain ?? 0, visibility: w.visibility, pressure: w.pressure, temp: w.temp, cloud: w.cloud, source: w.source || 'synthetic' };
}
/** Ship specs from a shipyard entry or the class table. */
function specsOf(id, entry) {
  const C = SHIP_CLASSES[id] || {}, s = entry?.specs || {};
  const pick = (k) => (s[k] ?? C[k]);
  return { id, name: C.name || entry?.name || id, cat: entry?.cat || C.cat, desc: entry?.desc || C.desc || '', length: pick('length'), beam: pick('beam'), draft: pick('draft'), maxKn: pick('maxKn'),
    capacity: pick('capacity'), pax: pick('pax'), fuelCap: pick('fuelCap'), burn: pick('burn'), crewCost: pick('crewCost') ?? 0, price: entry?.price ?? pick('price'), displacement: pick('displacement'),
    sail: !!(s.sail ?? C.sail), auxKn: C.auxKn, towPower: s.towPower ?? C.towPower ?? 0, fishRate: C.fishRate ?? 0 };
}
function rangeNmOf(sp) { if (sp.sail) return Infinity; return sp.burn > 0 ? (sp.fuelCap / sp.burn) * sp.maxKn : 0; }
const fmtT = (t) => (t >= 100 ? `${fmt(t)} t` : `${fmt1(t)} t`);

// ship images are optional (WebGL in a second context); the HUD keeps working with icon placeholders without them
let thumbsP = null, thumbsM = null;
function thumbs() {
  if (!thumbsP) thumbsP = import('./thumbs.js').then((m) => (thumbsM = m)).catch((e) => { console.warn('[hud] ship images unavailable', e); return null; });
  return thumbsP;
}

export class Hud {
  constructor(app) {
    this.app = app;
    this.rangeIdx = 2;
    this.headingUp = false;
    this.chartMode = 'region';
    this._chartModeSeen = 'region';
    this.logEntries = [];
    this.harborTab = 'jobs';
    this.harborData = null;
    this.harborDirty = false; // a harbour re-render was skipped because the player was typing in the panel
    this._stale = new Set(TABS);
    this._pendingTab = null;
    this.yardMode = 'new'; this.yardCat = 'all'; this.compare = [];
    this.openBoards = null;
    this.touch = isTouch();
    this.interiorOn = false; this.ashoreOn = false;
    this.rescueStart = null;
    this._ownHelm = null;
    this.chart = new Chart(app, $('chart'), $('chartInfo'));
    if (this.touch) document.body.classList.add('touch');
    document.documentElement.style.setProperty('--ph', iconDataUrl('ship', '#4f6f88'));
    this.hydrateIcons(document);
    this.bind();
    if (this.touch) this.bindTouchLayout();
    this.initWelcome();
    thumbs();
    // main.js builds its TouchHelm right after constructing the HUD: adopt it once the App constructor has finished
    queueMicrotask(() => this.adoptHelm());
  }

  // ------------------------------------------------------------------ small DOM helpers
  hydrateIcons(root) {
    for (const el of root.querySelectorAll('[data-icon]')) {
      const name = el.dataset.icon;
      if (el.dataset.iconed === name) continue;
      el.innerHTML = ICON[name] || ICON.info; el.dataset.iconed = name;
    }
  }
  setIcon(el, name) { if (el && el.dataset.iconed !== name) { el.innerHTML = ICON[name] || ICON.info; el.dataset.iconed = name; el.dataset.icon = name; } }
  thumbKey(cls, o) { return `${cls}|${o.w}|${o.h}|${o.angle}|${(+o.wear || 0).toFixed(1)}`; }
  /** <span class="thumbBox"><img></span> for a ship class; filled from the cache now or by hydrateThumbs() later. */
  thumbHTML(cls, opts = {}, extra = '') {
    const o = { w: opts.w || 320, h: opts.h || 200, angle: opts.angle || 'quarter', wear: Math.round(clamp01(opts.wear || 0) * 10) / 10 };
    const key = this.thumbKey(cls, o);
    const hit = thumbsM?.cachedThumb?.(cls, o) || null;
    return `<span class="thumbBox ${extra}${hit ? ' loaded' : ''}">${opts.inner || ''}<img alt="${esc(SHIP_CLASSES[cls]?.name || cls)}" draggable="false" data-tkey="${esc(key)}"${hit ? ` src="${hit}" class="loaded"` : ''}></span>`;
  }
  hydrateThumbs(root) {
    const imgs = root.querySelectorAll('img[data-tkey]:not(.loaded)');
    if (!imgs.length) return;
    const keys = new Set([...imgs].map((i) => i.dataset.tkey));
    thumbs().then((m) => {
      if (!m) return;
      for (const key of keys) {
        const [cls, w, h, angle, wear] = key.split('|');
        m.shipThumb(cls, { w: +w, h: +h, angle, wear: +wear }).then((url) => { if (url) this.applyThumb(key, url); });
      }
    });
  }
  applyThumb(key, url) {
    for (const img of document.querySelectorAll('img[data-tkey]')) {
      if (img.dataset.tkey !== key || img.classList.contains('loaded')) continue;
      img.src = url; img.classList.add('loaded'); img.parentElement?.classList.add('loaded');
    }
  }
  /** Point an existing <img> at a ship image (top bar chip). */
  setImgThumb(img, cls, opts) {
    if (!img) return;
    img.classList.remove('loaded'); img.parentElement?.classList.remove('loaded');
    const want = cls; img.dataset.want = want;
    thumbs().then((m) => m?.shipThumb(cls, { ...opts, priority: true })).then((url) => {
      if (!url || img.dataset.want !== want) return;
      img.src = url; img.classList.add('loaded'); img.parentElement?.classList.add('loaded');
    });
  }

  // ------------------------------------------------------------------ welcome
  initWelcome() {
    const list = $('featureList');
    if (list) {
      const F = [
        ['globe', 'The real Earth, 1:1', 'Every coast, harbour and sea lane at true scale.'],
        ['ffwd', 'Real time + time warp', 'Voyages take as long as they really do — warp up to 400× on open water.'],
        ['wind', 'Live weather & tides', 'Real wind and waves, harmonic tides and tidal streams.'],
        ['walk', 'Walk the harbour', 'Go ashore: harbourmaster, shipyard, chandler, market, bar.'],
        ['coins', 'Trade & contracts', 'Freight, charters, fishing, tows — or smuggling.'],
        ['users', 'One shared ocean', 'Convoys, cargo trades, piracy and the coast guard.'],
      ];
      list.innerHTML = F.map(([i, t, d]) => `<li><span class="si">${ICON[i]}</span><span><b>${t}</b>${d}</span></li>`).join('');
    }
    const hero = $('heroShip');
    if (hero) {
      const pool = ['schooner', 'feeder', 'ferry', 'psv', 'myacht', 'superyacht', 'tug', 'coaster', 'ketch'];
      const cls = pool[Math.floor(Math.random() * pool.length)];
      const w = this.touch ? 640 : 760, h = this.touch ? 360 : 475;
      thumbs().then((m) => m?.shipThumb(cls, { w, h, angle: 'hero', priority: true })).then((url) => { if (url) { hero.src = url; hero.alt = SHIP_CLASSES[cls]?.name || ''; hero.classList.add('loaded'); } });
    }
  }

  // ------------------------------------------------------------------ bindings
  bind() {
    const a = this.app;
    $('startBtn').onclick = () => a.start($('nameInput').value.trim());
    $('nameInput').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); a.start($('nameInput').value.trim()); } };
    try { $('nameInput').value = localStorage.getItem('saltline.name') || ''; } catch { /* private mode */ }
    document.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => { const id = b.dataset.close; if (id === 'chartWrap') this.chart.close(); else if (id === 'harborWrap') this.hideHarbor(); else $(id).classList.add('hidden'); }; });
    // A clicked button would otherwise keep keyboard focus, and Space ('all stop') would re-fire it.
    document.addEventListener('click', (e) => { const b = e.target.closest?.('button'); if (b) b.blur(); });
    // close the More menu when tapping elsewhere
    document.addEventListener('pointerdown', (e) => { const s = $('moreSheet'); if (s?.classList.contains('open') && !s.contains(e.target) && !$('btnMore')?.contains(e.target)) s.classList.remove('open'); });
    const hw = $('harborWrap');
    hw.addEventListener('click', (e) => {
      const actEl = e.target.closest?.('[data-act]');
      if (actEl && hw.contains(actEl) && !actEl.disabled) this.sheetAction(actEl.dataset.act, actEl, e);
      const btn = e.target.closest?.('button'); if (!btn) return;
      const ae = document.activeElement; // clicking any harbour button ends text entry in the panel (Safari keeps inputs focused)
      if (ae && ae !== document.body && hw.contains(ae) && ae.tagName === 'INPUT') ae.blur();
      if (this.harborDirty) this.renderHarborTabs();
    });
    hw.addEventListener('input', (e) => this.sheetInput(e.target));
    hw.addEventListener('focusout', (e) => { if (this.harborDirty && !(e.relatedTarget && hw.contains(e.relatedTarget))) setTimeout(() => { if (this.harborDirty && !hw.contains(document.activeElement)) this.renderHarborTabs(); }, 0); });
    hw.addEventListener('keydown', (e) => { if (e.target.tagName === 'INPUT') { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); } });
    $('harborNav').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) this.showTab(b.dataset.tab); });
    $('shipsWrap').addEventListener('click', (e) => { const el = e.target.closest?.('[data-act]'); if (el && !el.disabled) this.sheetAction(el.dataset.act, el, e); });
    const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
    on('btnDock', () => a.toggleDock());
    on('btnCastOff', () => a.castOff());
    on('btnUndock', () => a.castOff());
    on('btnAshore', () => this.toggleAshore());
    on('btnAshoreH', () => this.toggleAshore());
    on('btnAboard', () => this.toggleAshore());
    on('btnAshoreOffice', () => this.openHarborTab('overview'));
    on('btnChart', () => this.toggleChart());
    on('btnShips', () => this.toggleShips());
    on('btnFish', () => { a.net.action('fish', { on: !a.you?.fishing }); this.closeMore(); });
    on('btnPatch', () => { a.net.action('patch'); this.closeMore(); });
    on('btnAuto', () => { a.toggleAutopilot(); this.closeMore(); });
    on('btnTow', () => { this.closeMore(); if (confirm('Call a tow to the nearest harbour? It costs money and ends the voyage.')) a.net.action('tow'); });
    on('btnHelp', () => { this.closeMore(); this.toggleHelp(); });
    on('btnInterior', () => this.toggleInterior());
    on('btnWalkMore', () => { this.closeMore(); this.toggleInterior(); });
    on('btnChatMore', () => { this.closeMore(); document.body.classList.add('chatOn'); setTimeout(() => $('chatInput')?.focus(), 30); });
    $('chatInput').addEventListener('blur', () => document.body.classList.remove('chatOn'));
    $('chatInput').addEventListener('focus', () => { if (this.touch) document.body.classList.add('chatOn'); });
    on('btnDeck', () => this.toggleInterior());
    on('btnCamera', () => { this.cycleCamera(); this.closeMore(); });
    on('btnSails', () => { const up = a.you?.sailsUp !== false; if (typeof a.setSails === 'function') a.setSails(!up); else a.net.action('sails', { up: !up }); this.closeMore(); });
    on('btnWeather', () => { this.closeMore(); this.toggleWeather(); });
    on('weatherClose', () => $('weatherPanel').classList.add('hidden'));
    on('btnMore', () => this.toggleMore());
    on('btnMoor', () => a.toggleDock());
    on('aisCardClose', () => this.showAisCard(null));
    on('jobPrev', () => this.cycleJob(-1));
    on('jobNext', () => this.cycleJob(1));
    on('btnJobRoute', () => { const t = this.jobShown; if (t) a.routeToJob?.(t); });
    on('btnJobAct', () => { const t = this.jobShown; if (t) a.jobAction?.(t); });
    on('btnTugs', () => { if (typeof a.requestTugs === 'function') return a.requestTugs(); const c = this.tugCost(); if (confirm(`Request tug assistance for ${fmt(c)} cr? The tugs bring you alongside the nearest berth.`)) a.net.action('tug_assist'); });
    on('telToggle', () => {
      const t = $('telemetry'); t.classList.toggle('collapsed'); const open = !t.classList.contains('collapsed');
      document.body.classList.toggle('telOpen', open);
      // on a phone the expanded instruments sit over the helm: fold them away again after a while
      clearTimeout(this._telTimer);
      if (open && this.touch) this._telTimer = setTimeout(() => { t.classList.add('collapsed'); document.body.classList.remove('telOpen'); }, 12000);
    });
    on('radarHU', () => { this.headingUp = !this.headingUp; $('radarHU').textContent = this.headingUp ? 'H↑' : 'N↑'; $('radarHU').classList.toggle('on', this.headingUp); });
    on('warpDown', () => this.stepWarp(-1));
    on('warpUp', () => this.stepWarp(1));
    document.querySelectorAll('#radarCtl button[data-r]').forEach((b) => { b.onclick = () => { this.rangeIdx = Math.max(0, Math.min(RANGES_KM.length - 1, this.rangeIdx + (b.dataset.r === '+' ? 1 : -1))); $('radarRange').textContent = RANGES_KM[this.rangeIdx] + ' km'; }; });
    $('chatInput').onkeydown = (e) => {
      if (e.key === 'Enter') { const t = $('chatInput').value.trim(); if (t) a.net.chat(t); $('chatInput').value = ''; $('chatInput').blur(); }
      if (e.key === 'Escape') $('chatInput').blur();
      e.stopPropagation();
    };
    // the instrument strip starts slim on every screen; the chevron expands it
    $('telemetry')?.classList.add('collapsed');
    // refresh the ships list while it is open
    setInterval(() => { if (!$('shipsWrap').classList.contains('hidden')) this.renderShips(); }, 4000);
  }
  /** body.touch: secondary buttons move into the "More" sheet; labels get shorter; the TouchHelm drives the input state. */
  bindTouchLayout() {
    const sheet = $('moreSheet');
    if (sheet) {
      for (const id of ['btnAuto', 'btnCamera', 'btnWeather', 'btnCastOff']) {
        const b = $(id); if (!b) continue;
        b.classList.remove('dockBtn'); b.classList.add('menuBtn');
        sheet.insertBefore(b, sheet.firstChild);
      }
    }
    for (const [id, t] of [['btnChart', 'Chart'], ['btnShips', 'Ships'], ['btnInterior', 'Walk'], ['btnCamera', 'Camera'], ['btnFish', 'Fish'], ['btnAuto', 'Autopilot'], ['btnHelp', 'Help'], ['btnWeather', 'Weather'], ['btnDeck', 'Stop walking'], ['btnAboard', 'Back aboard'], ['btnAshore', 'Ashore'], ['btnPatch', 'Kit'], ['btnCastOff', 'Cast off']]) setLbl(id, t);
  }
  /** Use main.js's TouchHelm when it exists (one helm, one DOM); otherwise build our own. */
  adoptHelm() {
    if (!this.touch) return;
    const a = this.app;
    let h = a.touchHelm;
    if (!h) {
      const root = $('touchHelm'); if (!root) return;
      h = this._ownHelm = new TouchHelm(root, {
        buttons: ['stop', 'auto'],
        onThrottle: (v) => { if (a.you?.docked || a.you?.assist) { h.setThrottle(0); return; } a.input.throttleCmd = v; },
        onRudder: (v, active) => { if (a.you?.docked || a.you?.assist) return; a.input.rudderCmd = v; a.input.rudderHold = !!active && Math.abs(v) > 0.01; if (active && Math.abs(v) > 0.05) a.autopilot = false; },
        onAllStop: () => { a.input.throttleCmd = 0; a.input.rudderCmd = 0; a.autopilot = false; },
        onAction: (name) => this.action(name),
      });
    } else {
      h.setButtons?.(['stop', 'auto']);
      if (h.h && typeof h.h.onAction !== 'function') h.h.onAction = (name) => this.action(name);
    }
    this.syncModes();
  }
  get helm() { return this.app.touchHelm || this._ownHelm || null; }
  action(name) {
    const a = this.app;
    switch (name) {
      case 'dock': return a.toggleDock();
      case 'chart': return this.toggleChart();
      case 'ships': return this.toggleShips();
      case 'interior': return this.toggleInterior();
      case 'ashore': return this.toggleAshore();
      case 'camera': return this.cycleCamera();
      case 'auto': return a.toggleAutopilot();
      case 'more': return this.toggleMore();
      case 'stop': a.input.throttleCmd = 0; a.input.rudderCmd = 0; a.autopilot = false; return;
      case 'warpUp': return this.stepWarp(1);
      case 'warpDown': return this.stepWarp(-1);
    }
  }
  toggleMore() {
    const s = $('moreSheet'); if (!s) return;
    const open = !s.classList.contains('open');
    if (open && !this.touch) { // anchor the popover above the More button, inside the viewport
      const r = $('btnMore').getBoundingClientRect(), w = Math.max(220, s.offsetWidth || 220);
      const cx = Math.min(innerWidth - w / 2 - 8, Math.max(w / 2 + 8, r.left + r.width / 2));
      s.style.left = cx + 'px'; s.style.bottom = (innerHeight - r.top + 8) + 'px';
    }
    s.classList.toggle('open', open);
  }
  closeMore() { $('moreSheet')?.classList.remove('open'); }
  toggleHelp() { const w = $('helpWrap'); const show = w.classList.contains('hidden'); if (show) this.closeOverlays(); w.classList.toggle('hidden', !show); }
  toggleInterior() {
    const a = this.app;
    if (this.ashoreOn || a.ashore?.active) return this.event({ kind: 'warn', text: 'Go back aboard first (G).' });
    if (typeof a.toggleInterior === 'function') a.toggleInterior();
    else if (a.interior) { if (a.interior.active) a.interior.exit(); else a.interior.enter(); }
    if (a.interior) this.showInterior(!!a.interior.active);
  }
  /** "Go ashore" / "Back aboard" (docs/V4-CONTRACTS.md §3): main.js owns the switch; the HUD follows `app.ashore.active`. */
  toggleAshore() {
    const a = this.app;
    if (!a.ashore?.active && !a.you?.docked) return this.event({ kind: 'warn', text: 'Moor at a berth first, then go ashore.' });
    if (a.interior?.active) { if (typeof a.toggleInterior === 'function') a.toggleInterior(); else a.interior.exit(); this.showInterior(false); }
    let res;
    if (typeof a.toggleAshore === 'function') res = a.toggleAshore();
    else if (a.ashore) res = a.ashore.active ? a.ashore.exit() : a.ashore.enter(a.you.docked);
    else return this.event({ kind: 'warn', text: 'Going ashore is not available yet in this harbour.' });
    if (res && typeof res.then === 'function') res.then((ok) => { if (ok === false) this.event({ kind: 'warn', text: 'The quay is not ready to walk yet — try again in a moment.' }); this.syncModes(); }).catch(() => this.syncModes());
    setTimeout(() => this.syncModes(), 30);
  }
  cycleCamera() { const a = this.app; if (typeof a.cycleCamera === 'function') a.cycleCamera(); else if (a.cam) a.cam.mode = (a.cam.mode + 1) % 3; }

  setStatus(t) { $('connStatus').textContent = t; }
  /** Connection pill in the HUD top bar: 'connected' | 'disconnected' | 'replaced'. */
  setConn(s) {
    const el = $('connPill'); if (!el) return;
    el.classList.toggle('hidden', s === 'connected');
    el.textContent = s === 'replaced' ? 'offline — logged in elsewhere' : 'offline — reconnecting';
  }
  showWelcome(show) { $('welcome').classList.toggle('hidden', !show); $('hud').classList.toggle('hidden', show); if (!show) this.syncModes(); }
  anyOverlayOpen() { return ['chartWrap', 'harborWrap', 'shipsWrap', 'helpWrap', 'marketWrap'].some((id) => $(id) && !$(id).classList.contains('hidden')); }
  transientOpen() {
    return ['chartWrap', 'shipsWrap', 'helpWrap', 'compareWrap', 'aisCardWrap', 'marketWrap'].some((id) => $(id) && !$(id).classList.contains('hidden')) || !!$('moreSheet')?.classList.contains('open')
      || (this.touch && !$('weatherPanel')?.classList.contains('hidden'));
  }
  /** Live AIS vessel card: `html` from AisLayer.info() (already escaped), or null to close. */
  showAisCard(html) {
    const w = $('aisCardWrap'); if (!w) return;
    if (!html) { w.classList.add('hidden'); return; }
    $('aisCardBody').innerHTML = html; w.classList.remove('hidden'); this.hydrateIcons(w);
  }
  closeOverlays() {
    $('aisCardWrap')?.classList.add('hidden');
    this.chart.close();
    for (const id of ['shipsWrap', 'helpWrap', 'compareWrap', 'marketWrap']) $(id)?.classList.add('hidden');
    this.closeMore();
    if (this.touch) $('weatherPanel')?.classList.add('hidden');
  }

  // ---------------------------------------------------------------- log / chat / alerts
  event(ev) {
    const d = document.createElement('div');
    d.className = `ev ${ev.kind || 'info'}`; d.textContent = ev.text;
    $('log').appendChild(d);
    this.logEntries.push({ el: d, t: performance.now() });
    const max = this.touch ? 3 : 7;
    while (this.logEntries.length > max) this.logEntries.shift().el.remove();
  }
  tickLog(now) {
    for (const e of [...this.logEntries]) {
      const age = now - e.t;
      if (age > 25000) { e.el.remove(); this.logEntries.splice(this.logEntries.indexOf(e), 1); } else if (age > 24000) e.el.classList.add('fade');
    }
  }
  chat(m) {
    const d = document.createElement('div');
    d.innerHTML = '<b></b> '; d.querySelector('b').textContent = m.from + ':'; d.append(document.createTextNode(m.text));
    $('chat').prepend(d);
    while ($('chat').children.length > 40) $('chat').lastChild.remove();
    if (this.touch) this.event({ kind: 'info', text: `${m.from}: ${m.text}` });
  }
  alert(id, text, cls = '') {
    let el = document.querySelector(`#alerts [data-id="${id}"]`);
    if (!el) { el = document.createElement('div'); el.dataset.id = id; $('alerts').appendChild(el); }
    el.className = `alert ${cls}`; setText(el, text);
  }
  clearAlert(id) { document.querySelector(`#alerts [data-id="${id}"]`)?.remove(); }

  // ---------------------------------------------------------------- modes (docked / interior / ashore / warp)
  /** Body classes and button states that follow the game state; cheap, called from updateTop and on mode switches. */
  syncModes() {
    const a = this.app, you = a.you, b = document.body;
    const docked = !!you?.docked, ashore = a.ashore ? !!a.ashore.active : this.ashoreOn;
    if (ashore !== this.ashoreOn) this.showAshore(ashore);
    this.adoptViewButtons();
    b.classList.toggle('docked', docked);
    $('btnAshore')?.classList.toggle('hidden', !docked && !ashore);
    setLbl('btnAshore', ashore ? (this.touch ? 'Aboard' : 'Back aboard') : (this.touch ? 'Ashore' : 'Go ashore'));
    const ah = $('btnAshoreH'); if (ah) { ah.classList.toggle('hidden', !docked); setLbl(ah, ashore ? 'Back aboard' : 'Go ashore'); }
    $('btnCastOff')?.classList.toggle('hidden', !docked);
    $('btnTow')?.classList.toggle('hidden', docked);
    $('btnAuto')?.classList.toggle('hidden', docked);
    if (!this.touch) $('btnCamera')?.classList.toggle('hidden', docked);
    const h = this.helm;
    if (h) {
      const walking = this.interiorOn || ashore;
      h.setHelmVisible?.(!walking && !docked);
      h.showStick?.(walking);
    }
  }
  /** interior.js / ashore.js each create a first/third-person toggle: dock it into our HUD rows so nothing overlaps. */
  adoptViewButtons() {
    const iv = $('interiorView'), ir = $('interiorRow'); if (iv && ir && iv.parentElement !== ir) ir.appendChild(iv);
    const av = $('ashoreView'), ar = $('ashoreRow'); if (av && ar && av.parentElement !== ar) ar.insertBefore(av, $('btnAshoreOffice'));
  }
  showAshore(on) {
    this.ashoreOn = !!on;
    document.body.classList.toggle('ashore', !!on);
    $('ashoreHud')?.classList.toggle('hidden', !on);
    if (on) { this.hideHarbor(); this.closeOverlays(); this.showAshoreHint(''); }
    this.syncModes();
  }
  /** One-line hint while ashore: nearest point of interest and distance (ashore.js). */
  showAshoreHint(text) {
    const el = $('ashoreHintText'); if (!el) return;
    setText(el, text || (this.touch ? 'Walk to a lit sign · tap to go in' : 'Walk to a lit sign (harbourmaster, shipyard, chandler, market, bar) · E to go in · G to go back aboard'));
  }

  // ---------------------------------------------------------------- time warp (docs/V4-CONTRACTS.md §1)
  warpLevels() { const L = this.app.world?.warp?.LEVELS || K.WARP?.LEVELS; return Array.isArray(L) && L.length ? L : DEFAULT_WARP; }
  currentWarp() { const w = Number(this.app.warp ?? this.app.you?.warp ?? 1); return w > 0 ? w : 1; }
  stepWarp(dir) {
    const a = this.app, you = a.you; if (!you) return;
    const L = this.warpLevels(), cur = this.currentWarp();
    let i = L.indexOf(cur); if (i < 0) i = L.reduce((bi, v, k) => (Math.abs(v - cur) < Math.abs(L[bi] - cur) ? k : bi), 0);
    const next = L[Math.max(0, Math.min(L.length - 1, i + dir))];
    if (next === cur) return;
    if (typeof a.setWarp === 'function') a.setWarp(next);
    else a.net.action('set_warp', { factor: next, route: (a.route || []).map((p) => ({ lat: p.lat, lon: p.lon })) });
  }
  routeRemainingM() {
    const s = this.app.ship, r = this.app.route || []; if (!s || !r.length) return 0;
    let m = 0, prev = s; for (const p of r) { m += haversine(prev.lat, prev.lon, p.lat, p.lon); prev = p; } return m;
  }
  updateWarp(you) {
    const a = this.app, ctl = $('warpCtl'), banner = $('warpBanner'); if (!ctl) return;
    // V6 item 6 (docs/V6-QUICK-CONTRACTS.md §2.5): the control also shows moored and under tugs (≤ 5× in harbours);
    // css/warpharbour.css brings it back on phones while moored and gives the harbour look
    if (!this._whCss) { this._whCss = true; if (!document.getElementById('whCss')) { const l = document.createElement('link'); l.id = 'whCss'; l.rel = 'stylesheet'; l.href = 'css/warpharbour.css'; document.head.appendChild(l); } }
    const show = !!you && !you.rescue && !this.interiorOn && !this.ashoreOn;
    ctl.classList.toggle('hidden', !show);
    const w = this.currentWarp(), L = this.warpLevels();
    const lim = you?.warpLimit || null, hb = lim?.harbour || null;
    setText($('warpLevel'), `${w}×`);
    setText(ctl.querySelector('.warpLevel small'), hb ? 'Harbour' : 'Warp');
    ctl.classList.toggle('active', w > 1);
    ctl.classList.toggle('harbour', !!hb);
    const blocked = !!(you?.hail || you?.rescue || (you?.fuelEmpty && !you?.docked && !you?.assist));
    $('warpDown').disabled = w <= L[0];
    $('warpUp').disabled = w >= L[L.length - 1] || blocked || !!(lim && w >= lim.max);
    $('warpUp').title = lim?.reason || 'Faster (.)';
    const on = show && w > 1;
    banner.classList.toggle('hidden', !on);
    document.body.classList.toggle('warpOn', on);
    if (!on) return;
    let txt;
    if (you.docked) txt = `Moored at ${w}× — the ship's clock (and contract hours) run ${w}×; the tide and the harbour stay real time.`;
    else if (you.assist) {
      const left = Math.max(0, Math.round(((Number(you.assist.until) || 0) - Date.now()) / 1000));
      txt = `Tugs at ${w}× — the tow runs ${w}× faster · ${Math.floor(left / 60)}:${pad2(left % 60)} to go`;
    } else {
      const s = a.ship, v = s ? Math.abs(s.spd) * GEO.KN_TO_MS : 0;
      const dist = this.routeRemainingM();
      txt = hb ? `Harbour ${w}× — berth guidance, tugs and collisions work as normal` : `Time warp ${w}×`;
      if (dist > 0 && v > 0.3) { const real = dist / v; txt += ` — ETA ${fmtDurS(real)} real → ${fmtDurS(real / w)}`; }
      else if (!hb) txt += ` — 1 min here is ${fmtDurS(60 * w)} at sea`;
    }
    setText($('warpBannerText'), txt);
  }

  // ---------------------------------------------------------------- top + telemetry
  updateTop(you, snap, onlineCount, latency) {
    if (!you) return;
    const a = this.app, C = SHIP_CLASSES[you.ship.cls] || SHIP_CLASSES.coaster;
    setText($('hbName'), you.name); setText($('hbClass'), C.name);
    if (this._thumbCls !== you.ship.cls) { this._thumbCls = you.ship.cls; this.setImgThumb($('hbThumb'), you.ship.cls, { w: 116, h: 72, angle: 'side' }); }
    setText($('hbMoney'), fmt(you.money) + ' cr');
    const fuelFrac = C.fuelCap > 0 ? you.fuel / C.fuelCap : 0;
    setText($('hbFuel'), `${you.fuel.toFixed(C.fuelCap < 10 ? 2 : 1)} t`);
    const fb = $('hbFuelBar'); if (fb) { fb.style.width = `${Math.round(clamp01(fuelFrac) * 100)}%`; fb.style.background = fuelFrac < 0.1 ? 'var(--red)' : fuelFrac < 0.25 ? 'var(--accent)' : 'var(--green)'; }
    $('hbFuel').style.color = fuelFrac < 0.1 ? 'var(--red)' : '';
    setText($('hbCond'), `${Math.round(you.cond)} %`);
    const cb = $('hbCondBar'); if (cb) { cb.style.width = `${Math.round(clamp01(you.cond / 100) * 100)}%`; cb.style.background = you.cond < 30 ? 'var(--red)' : you.cond < 60 ? 'var(--accent)' : 'var(--green)'; }
    $('hbCond').style.color = you.cond < 30 ? 'var(--red)' : '';
    const mass = you.cargo.reduce((s, c) => s + c.qty, 0);
    const contra = you.cargo.some((c) => c.contraband);
    setText($('hbCargo'), `${fmt(mass)} / ${fmt(C.capacity)} t${contra ? ' ⚠' : ''}`);
    $('hbCargo').style.color = contra ? 'var(--violet)' : '';
    setText($('hbWanted'), you.wanted ? '★'.repeat(Math.min(5, you.wanted)) : 'clean');
    $('hbWanted').style.color = you.wanted ? 'var(--red)' : '';
    $('hbWanted').closest('.stat')?.classList.toggle('wantedOn', !!you.wanted);
    const simTime = snap?.simTime ?? a.simTime;
    // V6 item 5: the ship's clock. While warping (and 15 s after) a "Ship · 20×  +6 h 20 m" stat sits next to the world
    // clock (phones: the clock stat itself switches to ship time); the offset counts from where warp began.
    const shipNow = a.shipTimeNow ? a.shipTimeNow() : 0, nowMs = performance.now(), run = a.shipClock?.warpRun;
    if (a.warp > 1 && shipNow > 0) {
      if (!this._shipRun || this._shipRun.until) this._shipRun = { start: run?.shipStart ?? shipNow, until: 0, warp: a.warp };
      if (run && Number.isFinite(run.shipStart) && run.shipStart <= shipNow) this._shipRun.start = run.shipStart;
      this._shipRun.warp = a.warp; this._shipRun.off = Math.max(0, shipNow - this._shipRun.start);
    } else if (this._shipRun && !this._shipRun.until) this._shipRun.until = nowMs + 15000;
    const sr = this._shipRun && (!this._shipRun.until || nowMs < this._shipRun.until) ? this._shipRun : null;
    if (!sr && this._shipRun?.until) this._shipRun = null;
    if (!this._tmCss) { this._tmCss = true; if (!document.getElementById('tmCss')) { const l = document.createElement('link'); l.id = 'tmCss'; l.rel = 'stylesheet'; l.href = 'css/timemodel.css'; document.head.appendChild(l); } }
    const clk = document.querySelector('.clockStat');
    let shipStat = $('hbShip');
    if (!shipStat && clk) {
      shipStat = document.createElement('div'); shipStat.id = 'hbShip'; shipStat.className = 'stat shipClockStat hidden';
      shipStat.innerHTML = `<span class="si">${ic('clock')}</span><span class="sv"><small id="hbShipLbl">Ship</small><b id="hbShipVal">—</b></span>`;
      clk.after(shipStat);
    }
    const offTxt = (sec, phone) => { const m = Math.floor(sec / 60), h = Math.floor(m / 60); return phone ? `ship +${h}:${pad2(m % 60)}` : `+${h} h ${pad2(m % 60)} m`; }; // phones hide the small label: say it in the value
    const phone = !!this.touch;
    if (sr) {
      const lbl = `Ship · ${sr.until ? '1×' : `${sr.warp}×`}`, tip = `Your ship's clock: ${offTxt(sr.off, false).slice(1)} of ship time since you started warping. Contract hours count on it; the tide and the world clock run in real time.`;
      if (phone) { setText($('hbDate'), lbl); setText($('hbClock'), offTxt(sr.off, true)); clk?.classList.add('shipMode'); if (clk && clk.title !== tip) clk.title = tip; shipStat?.classList.add('hidden'); }
      else if (shipStat) { shipStat.classList.remove('hidden'); setText($('hbShipLbl'), lbl); setText($('hbShipVal'), offTxt(sr.off, false)); if (shipStat.title !== tip) shipStat.title = tip; shipStat.classList.toggle('done', !!sr.until); clk?.classList.remove('shipMode'); }
    } else { shipStat?.classList.add('hidden'); if (clk?.classList.contains('shipMode')) { clk.classList.remove('shipMode'); clk.title = 'Real UTC date and time'; } }
    if (simTime > 1e9 && !(sr && phone)) { const d = new Date(simTime * 1000); setText($('hbDate'), `${DAYS[d.getUTCDay()]} ${pad2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]}`); setText($('hbClock'), `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`); }
    const wind = snap?.wind;
    if (wind && Number.isFinite(+wind.spd)) {
      setText($('hbWind'), this.touch ? `${(+wind.spd).toFixed(0)} m/s` : `${pad3(wind.dir ?? 0)}° ${(+wind.spd).toFixed(0)} m/s`);
      const arr = $('hbWindArrow'); const rot = `rotate(${Math.round(wind.dir ?? 0)}deg)`; if (arr && arr.style.transform !== rot) arr.style.transform = rot;
      arr?.setAttribute('title', `Wind from ${pad3(wind.dir ?? 0)}° · force ${beaufort(+wind.spd)}`);
    }
    const tide = you.tide;
    if (tide && Number.isFinite(tide.height)) { const th = Math.abs(tide.height) < 0.05 ? 0 : tide.height; setText($('hbTide'), `${th > 0 ? '+' : th < 0 ? '−' : ''}${Math.abs(th).toFixed(1)} m ${tide.state === 'flood' ? '↑' : '↓'}`); }
    setText($('hbPing'), `${latency ?? 0} ms`);
    setText($('hbOnline'), `${onlineCount} online`);
    // action dock
    $('btnFish')?.classList.toggle('on', !!you.fishing);
    setLbl('btnPatch', `${this.touch ? 'Kit' : 'Kit (K)'} ×${you.kits || 0}`);
    const moored = !!you.docked;
    const nearMoor = !moored && you.nearBerth && you.nearBerth.distM <= (INTERACT.BERTH_RANGE_U || 60);
    setLbl('btnDock', moored ? (this.harborOpen() ? 'Cast off' : 'Harbour') : nearMoor ? 'Moor' : 'Dock');
    this.setIcon($('btnDock')?.querySelector('.si'), moored ? (this.harborOpen() ? 'logout' : 'anchor') : 'anchor');
    $('btnDock')?.classList.toggle('attention', !!nearMoor);
    $('btnInterior')?.classList.toggle('on', !!this.interiorOn);
    this.setSailsButton(!!C.sail, you.sailsUp !== false);
    this.syncModes();
    this.updateWarp(you);
    if (this.harborOpen()) setText($('hMoney')?.querySelector('.mv'), fmt(you.money) + ' cr');
    // panels that follow `you` even when main.js does not call them explicitly
    this.showFishing(you.fishing ? you.fishInfo || { ground: '—', rate: 0, caught: 0, tooFast: false } : null);
    this.showRescue(you.rescue || null);
    this.showBerth(you.nearBerth || null, you.berth || null, you.assist || null, this.tugCost());
    if (!$('weatherPanel').classList.contains('hidden') && performance.now() - (this._wxAt || 0) > 1000) { this._wxAt = performance.now(); this.renderWeather(you.weather, you.tide); }
  }
  tugCost() { const you = this.app.you; const h = this.harborData; if (Number.isFinite(you?.tugCost)) return you.tugCost; if (Number.isFinite(h?.tugCost)) return h.tugCost; const C = you ? SHIP_CLASSES[you.ship.cls] : null; return C ? Math.max(400, Math.round(C.displacement * 0.35)) : 400; }
  /** Range estimate at the current throttle: (fuel / burn per hour) × SOG, in nm; null when stopped. */
  rangeNm(you) {
    const s = this.app.ship; if (!s || !you) return null;
    const C = SHIP_CLASSES[s.cls] || SHIP_CLASSES.coaster;
    const load = you.cargo.reduce((a, c) => a + c.qty, 0) / Math.max(1, C.capacity);
    const burn = fuelBurnPerSimHour(s.cls, s.throttle, load, 0, you.cond);
    const sog = Math.abs(s.spd);
    if (burn <= 1e-6) return C.sail && sog > 0.3 ? Infinity : null;
    if (sog < 0.3) return null;
    return (you.fuel / burn) * sog;
  }
  updateTelemetry(ship, info) {
    const you = this.app.you, C = SHIP_CLASSES[ship.cls] || SHIP_CLASSES.coaster;
    setText($('tSog'), Math.abs(ship.spd).toFixed(1));
    setText($('tHdg'), pad3(ship.hdg));
    setText($('tLat'), fmtDMS(ship.lat, true)); setText($('tLon'), fmtDMS(ship.lon, false));
    const tide = info.tide || you?.tide || null;
    setText($('tDepth'), info.depth == null ? '—' : info.depth > 199 ? '>200' : info.depth.toFixed(1));
    $('tDepth').parentElement.style.color = info.depth != null && info.depth < info.draft + 3 ? 'var(--red)' : '';
    setText($('tCur'), info.current ? `${pad3(info.current.set)}° ${info.current.drift.toFixed(1)} kn` : '—');
    const thrCmd = this.app.input?.throttleCmd ?? ship.throttleCmd ?? ship.throttle;
    setText($('tThr'), orderLabel(thrCmd, { short: true })); $('tThr').classList.add('tgOrder'); $('tThr').classList.toggle('astern', isAstern(thrCmd)); setText($('tRud'), ship.rudder > 0.05 ? `S${Math.round(ship.rudder * 35)}°` : ship.rudder < -0.05 ? `P${Math.round(-ship.rudder * 35)}°` : '0°');
    if (you) {
      const range = this.rangeNm(you);
      setText($('tFuel'), `${you.fuel.toFixed(C.fuelCap < 10 ? 2 : 1)} t`); $('tFuel').style.color = you.fuel < C.fuelCap * 0.1 ? 'var(--red)' : '';
      setText($('tRange'), range == null ? '—' : range === Infinity ? '∞ sail' : `${range >= 100 ? fmt(range) : range.toFixed(1)} nm`);
      const wx = normWeather(info.weather || you.weather);
      if (wx) {
        setText($('tWind'), `${pad3(wx.wind.dir)}° ${wx.wind.spd.toFixed(0)} m/s${wx.wind.gust ? ` g${wx.wind.gust.toFixed(0)}` : ''}`);
        setText($('tSea'), `${seaStateWord(wx.waves.height)} ${wx.waves.height.toFixed(1)} m`);
        $('tSea').style.color = wx.storm > 0.5 ? 'var(--red)' : wx.storm > 0.2 ? 'var(--accent)' : '';
      }
    }
    if (tide && Number.isFinite(tide.height)) setText($('tTide'), `${tide.height >= 0 ? '+' : ''}${tide.height.toFixed(1)} m ${tide.state === 'flood' ? '↑' : '↓'}${tide.rate != null ? ` ${Math.abs(tide.rate).toFixed(1)} m/h` : ''}`);
    else setText($('tTide'), '—');
    setText($('tFlood'), Math.round(info.flooding * 100) + '%'); $('tFlood').style.color = info.flooding > 0.05 ? 'var(--red)' : '';
    setText($('tNear'), info.nearest ? `${info.nearest.dist} ${short(info.nearest.name)}` : '—'); // distance first: a long name truncates, not the range
    setText($('tWp'), info.wp ? `${info.wp.dist} ${pad3(info.wp.brg)}°${info.autopilot ? ' AP' : ''}` : 'none');
    setText($('tEta'), info.wp ? info.wp.eta : '—');
    setText($('tJobs'), String(info.jobs)); setText($('tStatus'), info.status);
    const thr = ship.throttle; $('barThr').style.width = Math.min(1, thr < 0 ? thr / THROTTLE_MIN : thr) * 100 + '%'; $('barThr').style.background = thr < 0 ? 'var(--accent)' : 'var(--green)';
    $('barRud').style.left = ship.rudder >= 0 ? '50%' : 50 + ship.rudder * 50 + '%'; $('barRud').style.width = Math.abs(ship.rudder) * 50 + '%';
    $('btnAuto')?.classList.toggle('on', !!info.autopilot);
    const h = this.helm;
    if (h) { h.setThrottle?.(thrCmd); if (info.autopilot) h.setRudder?.(this.app.input?.rudderCmd ?? ship.rudder); h.setButtonOn?.('auto', !!info.autopilot); }
  }

  // ---------------------------------------------------------------- context cards and panels
  openChart() { if (!this.chart.isOpen()) this.toggleChart(); }
  showFishing(info) {
    const el = $('fishPanel'); if (!el) return;
    document.body.classList.toggle('fishOn', !!info);
    if (!info) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    setText($('fishGround'), info.ground || '—');
    setText($('fishRate'), `${(info.rate || 0).toFixed(1)} t/h`);
    setText($('fishCaught'), `${(info.caught || 0) >= 100 ? Math.round(info.caught) : (+info.caught || 0).toFixed(1)} t`);
    const w = $('fishWarn'); w.classList.toggle('hidden', !info.tooFast); setText(w, info.tooFast ? `Too fast — trawl under ${K.INTERACT.FISH_MAX_KN || 4} kn to fish` : '');
  }
  // ---------------------------------------------------------------- contract card (next step of the accepted jobs)
  cycleJob(d) {
    const ts = this.jobTargets || []; if (ts.length < 2) return;
    const i = Math.max(0, ts.findIndex((t) => t.job.id === this.jobFocus));
    this.jobFocus = ts[(i + d + ts.length) % ts.length].job.id; this.jobPinned = performance.now();
    this.showJobs(ts);
  }
  /** targets from jobs.js jobTargets(): the focused one (or the most urgent) on the card, ‹ › cycles the rest. */
  showJobs(targets) {
    const el = $('jobLine'); if (!el) return;
    this.jobTargets = targets || [];
    const you = this.app.you;
    const on = !!(this.jobTargets.length && you && !you.docked && !you.assist && !you.rescue && !this.ashoreOn);
    el.classList.toggle('hidden', !on); document.body.classList.toggle('jobOn', on);
    if (!on) { this.jobShown = null; return; }
    // an action that is possible right now takes the card unless the skipper picked a contract a moment ago
    const ts = this.jobTargets, act = ts.find((t) => t.action?.enabled);
    let t = ts.find((x) => x.job.id === this.jobFocus);
    if (!t || (act && act !== t && performance.now() - (this.jobPinned || 0) > 20000)) t = act || t || ts[0];
    this.jobFocus = t.job.id; this.jobShown = t;
    const i = ts.indexOf(t);
    el.style.setProperty('--job', t.color || JOB_COLOR[t.type] || '#f2b134');
    this.setIcon($('jobIc'), JOB_ICON[t.type] || 'contract');
    setText($('jobTitle'), t.title || t.type);
    setText($('jobPay'), `${fmt(t.job.pay)} cr`);
    setText($('jobStep'), t.step);
    setText($('jobWhere'), jobWhere(t));
    const leftS = t.leftS ?? t.deadlineS; const left = fmtLeft(leftS, this.app.warp || 1); setText($('jobLeft'), left); $('jobLeft').classList.toggle('late', leftS < 0); // V6 item 5: ship time
    $('jobNav').classList.toggle('hidden', ts.length < 2); setText($('jobIdx'), `${i + 1}/${ts.length}`);
    const b = $('btnJobAct');
    if (t.action) {
      b.classList.remove('hidden'); b.disabled = !t.action.enabled;
      setLbl(b, `${t.action.label}${this.touch ? '' : ' (J)'}`);
      b.title = t.action.enabled ? `${t.action.label} now` : t.action.why || '';
      b.classList.toggle('attention', !!t.action.enabled);
    } else b.classList.add('hidden');
    const r = $('btnJobRoute'); const routed = this.app.route?.length && this.app.route.at(-1) && Math.abs(this.app.route.at(-1).lat - t.lat) < 1e-4 && Math.abs(this.app.route.at(-1).lon - t.lon) < 1e-4;
    r.classList.toggle('on', !!routed); setLbl(r, routed ? 'On course' : 'Route');
  }
  toggleWeather() { const p = $('weatherPanel'); p.classList.toggle('hidden'); if (!p.classList.contains('hidden')) { this._wxAt = performance.now(); this.renderWeather(this.app.you?.weather || this.app.wx, this.app.you?.tide || this.app.tide); } }
  /** main.js calls this every HUD tick: only render while the panel is visible, at most once a second. */
  showWeather(wxRaw, tide) {
    const p = $('weatherPanel'); if (!p || p.classList.contains('hidden')) return;
    const now = performance.now(); if (now - (this._wxAt || 0) < 1000) return;
    this._wxAt = now; this.renderWeather(wxRaw, tide);
  }
  renderWeather(wxRaw, tide) {
    const el = $('weatherBody'); if (!el) return;
    const wx = normWeather(wxRaw);
    const now = this.app.simTime || Date.now() / 1000;
    const tiles = [];
    const tile = (icon, label, big, sub, wide) => tiles.push(`<div class="wxTile${wide ? ' wide' : ''}"><label>${ic(icon)}${esc(label)}</label><b>${esc(big)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</div>`);
    if (wx) {
      tile('wind', 'Wind', `${pad3(wx.wind.dir)}° · ${wx.wind.spd.toFixed(1)} m/s`, `force ${beaufort(wx.wind.spd)}${wx.wind.gust ? ` · gusts ${wx.wind.gust.toFixed(0)} m/s` : ''}`);
      tile('wave', 'Sea state', `${seaStateWord(wx.waves.height)}`, `${wx.waves.height.toFixed(1)} m${wx.waves.period ? ` / ${wx.waves.period.toFixed(0)} s` : ''}${wx.waves.dir != null ? ` from ${pad3(wx.waves.dir)}°` : ''}`);
      if (wx.swell && Number.isFinite(wx.swell.height)) tile('wave', 'Swell', `${wx.swell.height.toFixed(1)} m`, `${wx.swell.period ? `${wx.swell.period.toFixed(0)} s` : ''}${wx.swell.dir != null ? ` from ${pad3(wx.swell.dir)}°` : ''}`);
      if (Number.isFinite(wx.visibility)) tile(wx.visibility < 4000 ? 'visibility' : 'eye', 'Visibility', wx.visibility >= 10000 ? 'good' : wx.visibility >= 4000 ? 'moderate' : wx.visibility >= 1000 ? 'poor' : 'fog', wx.visibility >= 1000 ? `${(wx.visibility / 1000).toFixed(wx.visibility >= 10000 ? 0 : 1)} km` : `${Math.round(wx.visibility)} m`);
      if (Number.isFinite(wx.pressure)) tile('pressure', 'Pressure', `${wx.pressure.toFixed(0)} hPa`, '');
      if (Number.isFinite(wx.temp)) tile('thermo', 'Air', `${wx.temp.toFixed(0)} °C`, Number.isFinite(wx.cloud) ? `cloud ${Math.round(wx.cloud * 100)} %` : '');
      if (wx.rain > 0.05 || wx.storm > 0.1) tile('storm', 'Weather', wx.storm > 0.6 ? 'STORM' : wx.storm > 0.2 ? 'gale' : 'showers', `rain ${Math.round(wx.rain * 100)} %`);
    } else tile('cloud', 'Weather', 'no data yet', '', true);
    if (tide && Number.isFinite(tide.height)) {
      tile('tide', 'Tide', `${tide.height >= 0 ? '+' : ''}${tide.height.toFixed(2)} m · ${tide.state === 'flood' ? 'rising' : 'falling'}`, `${Math.abs(tide.rate ?? 0).toFixed(2)} m/h${Number.isFinite(tide.range) ? ` · range ${tide.range.toFixed(1)} m` : ''}`, true);
      if (tide.nextHigh) tile('clock', 'High / low water', `HW ${fmtClock(tide.nextHigh)} · LW ${fmtClock(tide.nextLow)}`, `in ${fmtDur(tide.nextHigh - now)} / ${fmtDur(tide.nextLow - now)}`, true);
      if (tide.stream) { const kn = Math.hypot(tide.stream.u, tide.stream.v) / GEO.KN_TO_MS; const set = ((Math.atan2(tide.stream.u, tide.stream.v) * 180) / Math.PI + 360) % 360; tile('compass', 'Tidal stream', kn > 0.05 ? `${kn.toFixed(1)} kn` : 'slack', kn > 0.05 ? `setting ${pad3(set)}°` : ''); }
    }
    el.innerHTML = `<div class="wxGrid">${tiles.join('')}</div><div class="wxSrc">${wx?.source === 'open-meteo' ? 'Open-Meteo live observation' : 'Simulated weather (no live data here)'}</div>`;
  }
  showRescue(r) {
    const el = $('rescueWrap'); if (!el) return;
    if (!r) { el.classList.add('hidden'); this.rescueStart = null; return; }
    if (el.classList.contains('hidden')) { el.classList.remove('hidden'); this.hydrateIcons(el); }
    const now = Date.now() + (this.app.clockOffset || 0);
    if (!this.rescueStart || this.rescueStart.id !== r.id) this.rescueStart = { id: r.id, t: now };
    const from = short(r.harborName || this.app.world?.harbors?.find((h) => h.id === r.harbor)?.name) || 'the coast';
    const left = Math.max(0, (r.eta - now) / 1000), total = Math.max(1, (r.eta - this.rescueStart.t) / 1000);
    setText($('rescueText'), `You are in the life raft — ${r.kind === 'helicopter' ? 'SAR helicopter' : 'lifeboat'} from ${from}, ETA ${pad2(Math.floor(left / 60))}:${pad2(Math.floor(left % 60))}`);
    $('rescueBar').style.width = `${Math.round((1 - Math.min(1, left / total)) * 100)}%`;
  }
  showBerth(nearBerth, berth, assist, tugCost) {
    const el = $('berthLine'); if (!el) return;
    const you = this.app.you, s = this.app.ship;
    const txt = $('berthText'), moor = $('btnMoor'), tugs = $('btnTugs');
    // guide: the berth the guidance card (berthguide.js renderCard: distance / steer / depth / advice / mini plan) leads to
    const show = (on, guide = null) => { el.classList.toggle('hidden', !on); document.body.classList.toggle('berthOn', !!on); this.app.berthGuide?.renderCard?.(el, guide); };
    if (this.ashoreOn) { show(false); return; }
    if (assist) { show(true); setText(txt, `Tugs bringing you alongside ${assist.berthName || (assist.berthId ? 'berth ' + String(assist.berthId).split('-b')[1] : 'the berth')}…`); moor.classList.add('hidden'); tugs.classList.add('hidden'); return; }
    if (berth || you?.docked) { show(false); return; }
    if (!nearBerth || this.app.berthGuide?.wants?.(nearBerth) === false) { show(false); return; } // sailing past a harbour: no card
    show(true, nearBerth);
    const spd = s ? Math.abs(s.spd) : 99;
    const inRange = nearBerth.distM <= (INTERACT.BERTH_RANGE_U || 60) && spd <= 2, tugRange = nearBerth.distM <= (INTERACT.TUG_RANGE_U || 1500) && spd <= 6;
    setText(txt, `${nearBerth.name || nearBerth.id} · ${nearBerth.distM >= 1000 ? (nearBerth.distM / 1000).toFixed(1) + ' km' : Math.round(nearBerth.distM) + ' m'} · ${pad3(nearBerth.brg ?? 0)}° · depth ${Number.isFinite(nearBerth.depth) ? nearBerth.depth.toFixed(0) + ' m' : '—'}${Number.isFinite(nearBerth.length) ? ` · ${Math.round(nearBerth.length)} m quay` : ''}`);
    moor.classList.remove('hidden'); moor.disabled = !inRange; moor.title = inRange ? 'Make fast at this berth' : 'Within 60 m and under 2 kn';
    setText(moor, this.touch ? 'Moor' : 'Moor (T)');
    tugs.classList.remove('hidden'); tugs.disabled = !tugRange || !!you?.hail; setText(tugs, `Tugs · ${fmt(tugCost)} cr`); tugs.title = tugRange ? 'Tugs take you alongside in 45 s' : 'Within 1.5 km of the harbour, under 6 kn';
  }
  /**
   * The voyage line (AUTOPILOT, docs/V6-QUICK-CONTRACTS.md §4.6): the points being plotted on the chart, else the ship's
   * route — for a planned route also the draught it was planned for and its warnings
   * (`2 wp · 184 nm · ETA 19 h 10 min · planned for 5.5 m · ⚠ 1 tidal leg`). Set voyage sends the whole route.
   */
  showVoyage(route, etaSec, expressCost) {
    const el = $('voyageLine'); if (!el) return;
    const a = this.app;
    const editing = (this.chart?.route?.length || 0) > 0;
    const pts = editing ? this.chart.getRoute() : a.route?.length ? a.route : route || [];
    if (!pts.length) { el.classList.add('hidden'); el.innerHTML = ''; this._voyKey = ''; return; }
    el.classList.remove('hidden');
    const last = pts[pts.length - 1];
    const st = this.chart?.routeStats ? this.chart.routeStats(pts) : null;
    const s = a.ship; let nm = 0, prev = s ? { lat: s.lat, lon: s.lon } : null;
    for (const p of pts) { if (prev) nm += haversine(prev.lat, prev.lon, p.lat, p.lon) / NM; prev = p; }
    const eta = st ? st.etaSec : etaSec;
    const cost = Math.round(nm * SIM.EXPRESS_CR_PER_NM);
    const meta = !editing ? a.routeMeta : null;
    const tidal = (meta?.warnings || []).filter((w) => w.kind === 'no_draught_route').length;
    const otherW = (meta?.warnings || []).length - tidal;
    const key = `${editing ? 'e' : 'r'}|${pts.length}|${nm.toFixed(1)}|${Math.round((eta || 0) / 60)}|${a.autopilot ? 1 : 0}|${meta ? meta.plannedAt : 0}`;
    if (key === this._voyKey) return;
    this._voyKey = key;
    const plan = editing ? '<span class="chip">straight · Sail route plans it</span>'
      : meta ? `<span class="chip good" title="Planned over water at least ${esc(String(Math.round((meta.draft + (meta.ukcM || 0)) * 10) / 10))} m deep at low water">planned for ${esc(String(meta.draft))} m</span>${tidal ? `<span class="chip warn" title="${esc((meta.warnings || []).filter((w) => w.kind === 'no_draught_route').map((w) => w.text).join(' · '))}">⚠ ${tidal} tidal leg${tidal > 1 ? 's' : ''}</span>` : ''}${otherW ? `<span class="chip warn" title="${esc((meta.warnings || []).filter((w) => w.kind !== 'no_draught_route').map((w) => w.text).join(' · '))}">⚠ ${otherW}</span>` : ''}`
      : '<span class="chip">straight</span>';
    el.innerHTML = `<span class="vsum">${ic('route')}<span>${pts.length} wp · ${nm.toFixed(1)} nm · ETA ${esc(fmtDur(eta))}</span>${plan}${a.autopilot ? '<span class="chip good">autopilot</span>' : ''}</span>
      <button id="voySail" class="primary">${ic('play')}<span class="lbl">${!editing && a.autopilot ? 'Sailing' : 'Sail route'}</span></button><button id="voyExpress">${ic('ffwd')}<span class="lbl">Express ${fmt(cost)} cr</span></button><button id="voySet" title="The crew keeps sailing this route while you are offline">${ic('clock')}<span class="lbl">Set voyage</span></button>`;
    $('voySail').onclick = () => { if (editing || !a.pilot) this.chart.sailRoute(); else if (!a.autopilot) a.pilot.engage(true); };
    $('voyExpress').onclick = () => { if (a.you?.docked) return this.event({ kind: 'warn', text: 'Cast off first — express passages start at sea.' }); if (confirm(`Express passage to the last waypoint: ${fmt(cost)} cr plus the fuel and wear of the leg. Go?`)) a.net.action('express', { lat: last.lat, lon: last.lon }); };
    $('voySet').onclick = () => {
      const order = Number.isFinite(a.pilot?.order) && a.autopilot ? a.pilot.order : a.input?.throttleCmd;
      const throttle = order > 0.05 ? Math.round(order * 100) / 100 : 0.7;
      const r = pts.slice(0, 250).map((p) => [Math.round(p.lat * 1e5) / 1e5, Math.round(p.lon * 1e5) / 1e5]);
      a.net.action('set_voyage', { route: r, throttle, ...(meta?.dest?.harbor ? { harbor: meta.dest.harbor } : {}) });
    };
  }
  showInterior(on) {
    this.interiorOn = !!on;
    document.body.classList.toggle('interior', !!on);
    $('interiorHud')?.classList.toggle('hidden', !on);
    $('btnInterior')?.classList.toggle('on', !!on);
    if (on) { this.closeMore(); this.setInteriorHint(this.touch ? 'Stick to walk · drag the right half to look · tap things to use them' : 'WASD to walk · Shift runs · E to use · V first / third person · Esc releases the mouse'); }
    this.syncModes();
  }
  setInteriorHint(text) { const el = $('interiorHint'); if (el) el.textContent = text || ''; }
  setSailsButton(isSail, up) {
    const b = $('btnSails'); if (!b) return;
    b.classList.toggle('hidden', !isSail);
    setLbl(b, up ? 'Sails: set' : 'Sails: furled');
    b.classList.toggle('on', !!up);
  }

  // ---------------------------------------------------------------- radar
  drawRadar(me, contacts, now) {
    const cv = $('radar'), ctx = cv.getContext('2d');
    const css = cv.clientWidth || 214, dpr = Math.min(3, window.devicePixelRatio || 1);
    if (css < 10) return;
    const px = Math.round(css * dpr);
    if (cv.width !== px) { cv.width = px; cv.height = px; }
    const W = css, R = W / 2;
    const rangeU = (RANGES_KM[this.rangeIdx] * 1000) / GEO.SCALE;
    const k = (R - 6) / rangeU;
    const rot = this.headingUp ? -me.hdg : 0;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, W);
    ctx.save(); ctx.translate(R, R);
    ctx.strokeStyle = 'rgba(90,214,255,0.16)'; ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i++) { ctx.beginPath(); ctx.arc(0, 0, ((R - 6) * i) / 3, 0, Math.PI * 2); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(0, -R + 6); ctx.lineTo(0, R - 6); ctx.moveTo(-R + 6, 0); ctx.lineTo(R - 6, 0); ctx.stroke();
    const sw = ((now / 2500) % 1) * Math.PI * 2;
    const grad = ctx.createConicGradient ? ctx.createConicGradient(sw - Math.PI / 2, 0, 0) : null;
    if (grad) { grad.addColorStop(0, 'rgba(90,214,255,0.0)'); grad.addColorStop(0.85, 'rgba(90,214,255,0.0)'); grad.addColorStop(1, 'rgba(90,214,255,0.25)'); ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(0, 0, R - 6, 0, Math.PI * 2); ctx.fill(); }
    const h = ((me.hdg + rot) * Math.PI) / 180;
    ctx.strokeStyle = 'rgba(242,177,52,0.8)'; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.sin(h) * (R - 6), -Math.cos(h) * (R - 6)); ctx.stroke();
    if (this.headingUp) { const n = (rot * Math.PI) / 180; ctx.fillStyle = '#9ad7ff'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('N', Math.sin(n) * (R - 14), -Math.cos(n) * (R - 14)); }
    const small = W < 170;
    ctx.font = (small ? '9px' : '10px') + ' system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const all = [...contacts];
    const a = this.app;
    if (!all.some((c) => c.kind === 'ai')) for (const s of collectAi(a)) all.push({ kind: 'ai', lat: s.lat, lon: s.lon, hdg: s.hdg, color: '#9aa3ab', label: s.name });
    if (!all.some((c) => c.kind === 'platform')) for (const p of a.world?.platforms || []) all.push({ kind: 'platform', lat: p.lat, lon: p.lon, color: '#ffb35c', label: p.name });
    if (!all.some((c) => c.kind === 'storm')) for (const s of collectStorms(a)) all.push({ kind: 'storm', lat: s.lat, lon: s.lon, color: 'rgba(255,100,100,0.7)', radiusU: (s.radiusKm * 1000) / GEO.SCALE, label: s.name });
    if (!all.some((c) => c.kind === 'rescue')) for (const r of collectRescues(a)) all.push({ kind: 'rescue', lat: r.lat, lon: r.lon, color: '#ff9f43', label: 'SAR' });
    const nb = a.you?.nearBerth; if (nb && Number.isFinite(nb.lat) && !all.some((c) => c.kind === 'berth')) all.push({ kind: 'berth', lat: nb.lat, lon: nb.lon, color: '#f2b134', label: nb.name || 'berth' });
    else if (nb && !Number.isFinite(nb.lat) && Number.isFinite(nb.brg) && Number.isFinite(nb.distM)) all.push({ kind: 'berth', polar: { brg: nb.brg, d: nb.distM / GEO.SCALE }, color: '#f2b134', label: nb.name || 'berth' });
    for (const c of all) {
      const d = c.polar ? c.polar.d : unitsBetween(me.lat, me.lon, c.lat, c.lon);
      if (c.kind === 'job' && d - (c.radiusU || 0) > rangeU * 0.94) { // out of range: an arrowhead on the rim points to it
        const bj = ((bearing(me.lat, me.lon, c.lat, c.lon) + rot) * Math.PI) / 180, rr = R - 10;
        const ex = Math.sin(bj) * rr, ey = -Math.cos(bj) * rr;
        ctx.fillStyle = c.color; ctx.beginPath(); ctx.moveTo(ex + Math.sin(bj) * 7, ey - Math.cos(bj) * 7); ctx.lineTo(ex + Math.sin(bj + 2.4) * 6, ey - Math.cos(bj + 2.4) * 6); ctx.lineTo(ex + Math.sin(bj - 2.4) * 6, ey - Math.cos(bj - 2.4) * 6); ctx.closePath(); ctx.fill();
        continue;
      }
      if (d > rangeU * 1.02 && !(c.kind === 'storm' && d - (c.radiusU || 0) < rangeU)) continue;
      const brg = c.polar ? c.polar.brg : bearing(me.lat, me.lon, c.lat, c.lon);
      const b = ((brg + rot) * Math.PI) / 180;
      const x = Math.sin(b) * d * k, y = -Math.cos(b) * d * k;
      ctx.fillStyle = c.color; ctx.strokeStyle = c.color; ctx.lineWidth = 1;
      if (c.kind === 'harbor') { ctx.fillRect(x - 3.5, y - 3.5, 7, 7); ctx.fillStyle = 'rgba(200,240,255,0.8)'; if ((rangeU < 12000 || c.size === 'mega') && !small) ctx.fillText(c.label, x, y - 9); }
      else if (c.kind === 'cutter') { ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y + 4); ctx.lineTo(x - 5, y + 4); ctx.closePath(); ctx.fill(); }
      else if (c.kind === 'wreck') { ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x - 4, y - 4); ctx.lineTo(x + 4, y + 4); ctx.moveTo(x + 4, y - 4); ctx.lineTo(x - 4, y + 4); ctx.stroke(); }
      else if (c.kind === 'ground') { ctx.beginPath(); ctx.arc(x, y, Math.max(4, c.radiusU * k), 0, Math.PI * 2); ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]); }
      else if (c.kind === 'storm') { ctx.beginPath(); ctx.arc(x, y, Math.max(5, (c.radiusU || 0) * k), 0, Math.PI * 2); ctx.setLineDash([4, 3]); ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = 'rgba(255,100,100,0.08)'; ctx.fill(); }
      else if (c.kind === 'wp') { ctx.beginPath(); ctx.moveTo(x, y - 6); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 6); ctx.lineTo(x - 6, y); ctx.closePath(); ctx.stroke(); }
      else if (c.kind === 'berth') { ctx.lineWidth = 2; ctx.strokeRect(x - 4, y - 4, 8, 8); ctx.beginPath(); ctx.moveTo(x - 6, y); ctx.lineTo(x + 6, y); ctx.stroke(); if (!small) { ctx.fillStyle = '#ffd98a'; ctx.fillText(c.label, x, y - 9); } }
      else if (c.kind === 'platform') { ctx.beginPath(); ctx.moveTo(x - 4, y + 4); ctx.lineTo(x, y - 5); ctx.lineTo(x + 4, y + 4); ctx.closePath(); ctx.stroke(); }
      else if (c.kind === 'rescue') { ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.stroke(); }
      else if (c.kind === 'job') {
        if (c.radiusU) { ctx.beginPath(); ctx.arc(x, y, Math.max(5, c.radiusU * k), 0, Math.PI * 2); ctx.setLineDash([2, 3]); ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]); }
        ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.arc(x, y, 1.8, 0, Math.PI * 2); ctx.fill();
        if (!small) { ctx.fillStyle = c.color; ctx.fillText(c.label, x, y - 11); }
      }
      else if (c.kind === 'ai') {
        const hh = ((c.hdg ?? 0) + rot) * (Math.PI / 180);
        ctx.beginPath(); ctx.moveTo(x + Math.sin(hh) * 5, y - Math.cos(hh) * 5); ctx.lineTo(x + Math.sin(hh + 2.5) * 4, y - Math.cos(hh + 2.5) * 4); ctx.lineTo(x + Math.sin(hh - 2.5) * 4, y - Math.cos(hh - 2.5) * 4); ctx.closePath(); ctx.fill();
        if (rangeU <= 10000 && !small) { ctx.fillStyle = 'rgba(200,200,200,0.7)'; ctx.fillText(c.label, x, y - 8); }
      }
      else { ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill(); if (c.hdg != null) { const hh = ((c.hdg + rot) * Math.PI) / 180; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.sin(hh) * 9, y - Math.cos(hh) * 9); ctx.stroke(); } ctx.fillStyle = 'rgba(255,255,255,0.85)'; if (!small) ctx.fillText(c.label, x, y - 9); }
    }
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(Math.sin(h) * 6, -Math.cos(h) * 6); ctx.lineTo(Math.sin(h + 2.6) * 5.5, -Math.cos(h + 2.6) * 5.5); ctx.lineTo(Math.sin(h - 2.6) * 5.5, -Math.cos(h - 2.6) * 5.5); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  // ---------------------------------------------------------------- chart (delegated to Chart)
  toggleChart() {
    if (!this.chart.isOpen()) { this.closeOverlays(); this.chartMode = this.app.inRegion?.() ? 'region' : 'world'; this._chartModeSeen = this.chartMode; this.chart.open(); }
    else this.chart.close();
  }
  chartOpen() { return this.chart.isOpen(); }
  drawChart() {
    if (this._chartModeSeen !== this.chartMode) { // R toggled region/world in main.js: jump between the ship and the whole world
      this._chartModeSeen = this.chartMode;
      if (this.chartMode === 'world') this.chart.setCenter(30, 0, 2); else this.chart.centerOnShip();
    }
    this.chart.draw();
  }
  chartClick() {}

  // ---------------------------------------------------------------- harbour sheet
  showHarbor(h) {
    const wasOpen = this.harborOpen(), same = this.harborData?.id === h.id;
    this.harborData = h;
    if (this._pendingTab) { this.harborTab = this._pendingTab; this._pendingTab = null; }
    else if (!wasOpen && !same) { this.harborTab = 'overview'; this.compare = []; this.yardMode = 'new'; this.openBoards = null; }
    if (!wasOpen) { this.closeOverlays(); $('harborWrap').classList.remove('hidden'); this.hydrateIcons($('harborWrap')); }
    this.renderHarborTabs();
  }
  hideHarbor() { $('harborWrap').classList.add('hidden'); $('compareWrap')?.classList.add('hidden'); }
  harborOpen() { return !$('harborWrap').classList.contains('hidden'); }
  /** Open the harbour sheet at a section (also from the ashore world: harbourmaster → 'jobs', shipyard → 'shipyard', …). */
  openHarborTab(tab) {
    const t = this.normTab(tab), a = this.app, you = a.you;
    this.harborTab = t;
    if (!you?.docked) { this.event({ kind: 'warn', text: 'Moor at a berth first — the harbour offices deal with ships alongside.' }); return false; }
    if (this.harborData && this.harborData.id === you.docked) {
      if (!this.harborOpen()) { this.closeOverlays(); $('harborWrap').classList.remove('hidden'); this.hydrateIcons($('harborWrap')); this.renderHarborTabs(); }
      this.showTab(t);
      return true;
    }
    this._pendingTab = t;
    a.net?.action?.('dock'); // the server answers a docked player's 'dock' with the harbour payload → showHarbor
    return true;
  }
  normTab(t) { const k = String(t || '').toLowerCase().replace(/[^a-z]/g, ''); return TABS.includes(k) ? k : TAB_ALIAS[k] || 'overview'; }
  showTab(t) {
    t = this.normTab(t); this.harborTab = t;
    document.querySelectorAll('#harborNav button[data-tab]').forEach((b) => { const on = b.dataset.tab === t; b.classList.toggle('on', on); if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    document.querySelectorAll('#harborBody > .tab').forEach((el) => el.classList.toggle('hidden', el.id !== 'tab-' + t));
    if (this._stale.has(t) || t === 'boards') this.renderTab(t);
    const nav = $('harborNav')?.querySelector('button.on'); if (nav && this.touch) nav.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }
  // V6 item 5: a board offer shows its budget of ship hours ('26 h'); an accepted contract the ship time left ('21 h 10 min').
  deadline(j) {
    if (Number.isFinite(j.dueShip)) { const s = this.deadlineSec(j); if (s < 0) return 'overdue'; const m = Math.floor(s / 60), h = Math.floor(m / 60); return h < 1 ? `${Math.max(1, m)} min` : h < 48 ? `${h} h ${pad2(m % 60)} min` : `${Math.floor(h / 24)} d ${h % 24} h`; } // never round up: 68 h is 2 d 20 h, not '3 days'
    if (Number.isFinite(j.hours)) return fmtShipH(j.hours);
    const dl = (j.deadline - (this.app.simTime || Date.now() / 1000)); return dl < 0 ? 'expired' : dl < 48 * 3600 ? `${Math.floor(dl / 3600)} h` : `${Math.floor(dl / 86400)} d`;
  }
  deadlineSec(j) {
    if (Number.isFinite(j.dueShip)) return j.dueShip - (this.app.shipTimeNow ? this.app.shipTimeNow() : this.app.simTime || Date.now() / 1000);
    if (Number.isFinite(j.hours)) return j.hours * 3600;
    return j.deadline - (this.app.simTime || Date.now() / 1000);
  }
  /** The time estimate for a contract with the current ship (shared/jobtime.js): ok / too slow, label, why. */
  jobEst(j, you, C, mass) {
    const paxUsed = (you.jobs || []).filter((x) => x.pax).reduce((s, x) => s + x.pax, 0);
    const richness = j.richness ?? this.app.world?.fishing?.find((g) => g.id === j.ground)?.richness;
    return estimateJob(richness != null ? { ...j, richness } : j, { cls: you.ship.cls, holdFreeT: C.capacity - mass, paxFree: C.pax - paxUsed, warp: JOBTIME.SHOW_WARP });
  }
  payPerT(j) { return j.qty ? fmt(j.pay / j.qty) : j.pax ? fmt(j.pay / j.pax) + '/pax' : '—'; }
  /** Why the current ship cannot take a contract, or null. */
  whyNot(j, you, C, mass) {
    const used = (you.jobs || []).filter((x) => x.pax).reduce((s, x) => s + x.pax, 0);
    return hardReason(j, { cls: C.id || you.ship.cls, holdFreeT: C.capacity - mass, paxFree: C.pax - used }); // V6 item 5: shared/jobtime.js, same texts
  }
  hname(id) { return this.app.world?.harbors?.find((x) => x.id === id)?.name || id || '—'; }
  renderHarborTabs() {
    const h = this.harborData, you = this.app.you; if (!h || !you) return;
    const root = $('harborWrap'), ae = document.activeElement;
    // Never rebuild the panel under the player's fingers: a focused quantity box would lose its value and focus
    // (and the next keystrokes would become hotkeys). Mark it dirty; the click/focusout handlers catch up.
    if (ae && ae.tagName === 'INPUT' && root.contains(ae)) { this.harborDirty = true; return; }
    this.harborDirty = false;
    const C = SHIP_CLASSES[you.ship.cls] || SHIP_CLASSES.coaster;
    setText($('hName'), h.name);
    const berth = you.berth || h.berth;
    setText($('hSub'), `${h.country} · ${h.size} port${berth ? ` · ${berth.name || berth.id}` : ''} · ${C.name}`);
    const hm = $('hMoney'); if (hm) { if (!hm.querySelector('.mv')) hm.innerHTML = `${ic('coins')}<span class="mv"></span>`; setText(hm.querySelector('.mv'), fmt(you.money) + ' cr'); }
    setText($('navJobs'), h.jobs?.length ? String(h.jobs.length) : '');
    setText($('navPlayers'), h.dockedPlayers?.length ? String(h.dockedPlayers.length) : '');
    $('btnAshoreH')?.classList.toggle('hidden', !you.docked);
    this._stale = new Set(TABS);
    this.showTab(this.harborTab); // renders the visible section; the others render when opened
    if (!$('compareWrap').classList.contains('hidden')) this.renderCompare();
  }
  renderTab(t) {
    const el = $('tab-' + t); if (!el) return;
    const h = this.harborData, you = this.app.you; if (!h || !you) return;
    const C = SHIP_CLASSES[you.ship.cls] || SHIP_CLASSES.coaster;
    const qty = {}; el.querySelectorAll('[data-qty]').forEach((i) => { qty[i.dataset.qty] = i.value; }); // typed quantities survive the rebuild
    let html = '';
    try {
      switch (t) {
        case 'overview': html = this.tabOverview(h, you, C); break;
        case 'jobs': html = this.tabJobs(h, you, C); break;
        case 'boards': html = this.tabBoards(you, C); break;
        case 'market': html = this.tabMarket(h, you, C); break;
        case 'shipyard': html = this.tabShipyard(h, you, C); break;
        case 'services': html = this.tabServices(h, you, C); break;
        case 'shady': html = this.tabShady(h, you, C); break;
        case 'players': html = this.tabPlayers(h); break;
      }
    } catch (e) { console.error('[hud] render', t, e); html = `<div class="empty">${ic('warning')}<span>This section could not be shown (${esc(e.message)}).</span></div>`; }
    el.innerHTML = html;
    el.querySelectorAll('[data-qty]').forEach((i) => { if (qty[i.dataset.qty] != null && i.type !== 'range') i.value = qty[i.dataset.qty]; this.sheetInput(i); });
    this.hydrateThumbs(el);
    if (t === 'overview') this.loadBanner(h);
    this._stale.delete(t);
  }
  loadBanner(h) {
    const img = $('hBanner'); if (!img || img.classList.contains('loaded')) return;
    thumbs().then((m) => { const url = m?.harborBanner?.(h, { w: 1240, h: 340 }); const el = $('hBanner'); if (url && el && el.dataset.h === h.id) { el.src = url; el.classList.add('loaded'); } });
  }

  // -------- overview
  tabOverview(h, you, C) {
    const berth = you.berth || h.berth;
    const mass = you.cargo.reduce((s, c) => s + c.qty, 0);
    const bannerUrl = thumbsM?.harborBanner?.(h, { w: 1240, h: 340 }) || null;
    const wx = normWeather(you.weather), tide = you.tide;
    const berths = h.berths || [];
    const maxLen = Math.max(100, ...berths.map((b) => b.length || 0)), maxDepth = Math.max(10, ...berths.map((b) => b.depth || 0));
    const fuelNeed = Math.max(0, C.fuelCap - you.fuel);
    const usedN = (h.used || []).length, newN = (h.shipyard || []).length;
    const bestSell = (() => { const have = you.cargo.filter((c) => !c.jobId && h.market?.[c.good]); if (!have.length) return null; const c = have.sort((x, y) => h.market[y.good] * y.qty - h.market[x.good] * x.qty)[0]; return `${GOODS[c.good]?.name || c.good} · ${fmt(h.market[c.good])} cr/t`; })();
    const fees = h.fees || {};
    const quick = [
      ['jobs', 'contract', 'Contracts', `${h.jobs?.length || 0} on the board`],
      ['market', 'market', 'Market', bestSell ? `sell ${bestSell}` : `${Object.keys(h.market || {}).length} commodities`],
      ['shipyard', 'shipyard', 'Shipyard', `${newN} new · ${usedN} used`],
      ['services', 'wrench', 'Services', `fuel ${fmt(h.fuelPrice)} cr/t · hull ${Math.round(you.cond)} %`],
      ['boards', 'board', 'Job boards', 'every harbour'],
      ['shady', 'mask', 'Black market', h.contactLooked ? (h.contact ? 'contact found' : 'nobody today') : 'look around'],
    ];
    const ashoreBtn = you.docked ? `<button data-act="ashore">${ic('walk')}<b>${this.ashoreOn ? 'Back aboard' : 'Go ashore'}</b><small>walk the real quay</small></button>` : '';
    return `<div class="banner"><img id="hBanner" data-h="${esc(h.id)}" alt=""${bannerUrl ? ` src="${bannerUrl}" class="loaded"` : ''}>
        <div class="bannerTxt"><div><h2>${esc(short(h.name))}</h2><div class="chips"><span class="chip">${ic('flag')}${esc(h.country)}</span><span class="chip">${ic('anchor')}${esc(h.size)} port</span>${h.geomSource ? `<span class="chip">${ic('chart')}${h.geomSource === 'osm' ? 'OSM survey' : 'synthetic chart'}</span>` : ''}</div></div>
        ${berth ? `<span class="chip good">${ic('pier')}moored · ${esc(berth.name || berth.id)}</span>` : ''}</div></div>
      <div class="quick">${quick.map(([tab, i, t, s]) => `<button data-act="tab" data-tab="${tab}">${ic(i)}<b>${t}</b><small>${esc(s)}</small></button>`).join('')}${ashoreBtn}</div>
      <div class="cards">
        <article class="card"><h3>${ic('ship')}Your ship</h3>
          <div class="myShip">${this.thumbHTML(you.ship.cls, { w: 264, h: 164, angle: 'quarter', wear: 1 - you.cond / 100 })}
            <div><b>${esc(C.name)}</b><div class="muted small">${C.length} m · ${fmtT(C.capacity)} · ${C.pax} berths</div></div></div>
          <div class="gaugeRow"><label>Fuel</label><span class="meter ${you.fuel < C.fuelCap * 0.25 ? 'warn' : 'good'}"><i style="width:${Math.round(clamp01(you.fuel / C.fuelCap) * 100)}%"></i></span><b>${you.fuel.toFixed(C.fuelCap < 10 ? 2 : 1)} t</b></div>
          <div class="gaugeRow"><label>Hull</label><span class="meter ${you.cond < 30 ? 'bad' : you.cond < 60 ? 'warn' : 'good'}"><i style="width:${Math.round(you.cond)}%"></i></span><b>${Math.round(you.cond)} %</b></div>
          <div class="gaugeRow"><label>Cargo</label><span class="meter"><i style="width:${Math.round(clamp01(mass / Math.max(0.001, C.capacity)) * 100)}%"></i></span><b>${fmtT(mass)}</b></div>
          <div class="btnRow" style="margin-top:8px"><button data-act="fuel" data-t="${fuelNeed}" ${fuelNeed > 0.05 ? '' : 'disabled'}>${ic('fuel')}Fill up · ${fmt(fuelNeed * h.fuelPrice)} cr</button><button data-act="repair" ${h.repairCost > 0 ? '' : 'disabled'}>${ic('wrench')}Repair · ${fmt(h.repairCost)} cr</button></div>
        </article>
        <article class="card"><h3>${ic('anchor')}Harbour</h3><dl class="kv">
          <dt>Port</dt><dd>${esc(h.name)}</dd><dt>Country</dt><dd>${esc(h.country)}</dd><dt>Class</dt><dd>${esc(h.size)} port</dd>
          <dt>Anchorage</dt><dd>${h.anchor ? `${fmtDMS(h.anchor.lat, true)} ${fmtDMS(h.anchor.lon, false)}` : 'harbour entrance'}</dd>
          <dt>Bunker fuel</dt><dd>${fmt(h.fuelPrice)} cr/t</dd><dt>Tugs</dt><dd>${fmt(h.tugCost ?? this.tugCost())} cr</dd>
          <dt>Skippers here</dt><dd>${h.dockedPlayers?.length || 0}</dd></dl></article>
        <article class="card"><h3>${ic('coins')}Fees for your ship</h3><dl class="kv">
          <dt>Port dues</dt><dd>${fees.dues != null ? fmt(fees.dues) + ' cr' : '—'}</dd><dt>Berth / day</dt><dd>${fees.berthPerDay != null ? fmt(fees.berthPerDay) + ' cr' : '—'}</dd>
          <dt>Pilotage</dt><dd>${fees.pilotage ? fmt(fees.pilotage) + ' cr' : 'not required'}</dd><dt>Yard service</dt><dd>${fees.service != null ? fmt(fees.service) + ' cr' : '—'}</dd></dl>
          <p class="muted small" style="margin:8px 0 0">Dues on arrival, berth fee per started 24 h when you cast off.</p></article>
        <article class="card"><h3>${ic('wind')}Weather &amp; tide</h3><dl class="kv">
          ${wx ? `<dt>Wind</dt><dd>${pad3(wx.wind.dir)}° ${wx.wind.spd.toFixed(0)} m/s · F${beaufort(wx.wind.spd)}</dd><dt>Sea</dt><dd>${seaStateWord(wx.waves.height)} ${wx.waves.height.toFixed(1)} m</dd>` : '<dt>Weather</dt><dd>—</dd>'}
          ${tide && Number.isFinite(tide.height) ? `<dt>Tide</dt><dd>${tide.height >= 0 ? '+' : ''}${tide.height.toFixed(1)} m ${tide.state === 'flood' ? 'rising' : 'falling'}</dd>${tide.nextHigh ? `<dt>High water</dt><dd>${fmtClock(tide.nextHigh)} UTC</dd><dt>Low water</dt><dd>${fmtClock(tide.nextLow)} UTC</dd>` : ''}` : ''}</dl></article>
        <article class="card" style="grid-column: 1 / -1"><h3>${ic('pier')}Berths</h3>${berths.length ? `<div class="berthList">${berths.map((b) => `<div class="berthRow${berth?.id === b.id ? ' mine' : ''}"><div><b>${esc(b.name || b.id)}</b> <span class="muted small">${esc(b.kind || 'quay')}${b.maxLength ? ` · ships ≤ ${Math.round(b.maxLength)} m` : ''}</span></div>
            <div class="num">${Math.round(b.length)} m<span class="meter"><i style="width:${Math.round((b.length / maxLen) * 100)}%"></i></span></div><div class="num">${(+b.depth).toFixed(1)} m<span class="meter good"><i style="width:${Math.round(clamp01(b.depth / maxDepth) * 100)}%"></i></span></div></div>`).join('')}</div>`
            : '<p class="muted">No berth survey for this harbour yet — moor anywhere inside the breakwaters.</p>'}</article>
      </div>`;
  }

  // -------- contracts
  routeOf(j, fromHarbor) {
    const here = short(fromHarbor?.name || this.hname(j.from)), to = short(j.toName || this.hname(j.to));
    if (j.type === 'fishing') return [j.groundName || 'fishing ground', here];
    if (j.type === 'supply') return [here, j.platformName || 'offshore platform'];
    if (j.type === 'tow') return [j.at ? `${j.at.lat.toFixed(2)}°, ${j.at.lon.toFixed(2)}°` : 'casualty', to];
    return [here, to];
  }
  cargoOf(j) {
    if (j.pax) return `${fmt(j.pax)} passengers`;
    if (j.type === 'tow') return `tow a ${SHIP_CLASSES[j.victimCls]?.name?.toLowerCase() || 'disabled vessel'}`;
    if (j.qty) return `${fmtT(j.qty)} ${GOODS[j.good]?.name?.toLowerCase() || j.good || 'cargo'}`;
    return '';
  }
  jobCard(j, fromHarbor, you, C, mass, shady) {
    const why = this.whyNot(j, you, C, mass);
    const type = shady || j.contraband ? 'smuggling' : j.type;
    const [a, b] = this.routeOf(j, fromHarbor);
    const dl = this.deadlineSec(j);
    const per = j.qty ? `${fmt(j.pay / j.qty)} cr/t` : j.pax ? `${fmt(j.pay / j.pax)} cr/pax` : '';
    // V6 item 5: the budget is ship hours; the estimate says what it takes with YOUR ship; too slow → greyed, "Accept anyway"
    const est = this.jobEst(j, you, C, mass), slow = !why && !est.ok;
    const refName = j.ref?.cls && SHIP_CLASSES[j.ref.cls] ? SHIP_CLASSES[j.ref.cls].name.toLowerCase() : '';
    const budget = Number.isFinite(j.hours) ? `${j.hours} h of ship time` : 'Time allowed';
    const chipTip = `${budget}: counted on your ship's clock — time warp saves you real waiting, it does not shorten the contract.`;
    const eligTxt = why || (slow ? `${est.why.charAt(0).toUpperCase()}${est.why.slice(1)}${refName ? ` · rated for a ${refName}` : ''}` : 'Fits your ship and its time');
    return `<article class="card jobCard t-${esc(type)}${slow ? ' tooSlow' : ''}">
      <div class="jobTop"><span class="jobType">${ic(JOB_ICON[type] || 'contract')}${esc(JOB_LABEL[type] || type)}</span><span class="chip ${dl < 0 ? 'bad' : slow ? 'warn' : 'ghost'}" title="${esc(chipTip)}">${ic('clock')}${this.deadline(j)}</span></div>
      <h4>${esc(j.title || `${JOB_LABEL[j.type] || j.type} to ${b}`)}</h4>
      <div class="route">${ic('pin')}<b>${esc(a)}</b>${ic('arrowRight')}<b>${esc(b)}</b>${j.distKm ? `<span class="muted">· ${fmt(j.distKm)} km</span>` : ''}</div>
      ${est.label && !why ? `<div class="estLine ${est.ok ? 'ok' : 'slow'}" title="${esc(`Ship hours with your ${C.name.toLowerCase()} at service speed; the contract allows ${budget.replace(' of ship time', '')}.`)}">${ic('clock')}<span>${esc(est.label.split(' (≈')[0])}${est.label.includes(' (≈') ? ` <span class="estReal">(≈${esc(est.label.split(' (≈')[1])}</span>` : ''}</span></div>` : ''}
      <div class="muted small">${esc(this.cargoOf(j))}${j.needsCat ? ' · needs a yacht or ferry' : ''}</div>
      <div class="payRow"><span class="pay">${fmt(j.pay)}<small>cr</small></span><span class="perT">${per}</span></div>
      <div class="elig ${why ? 'bad' : slow ? 'slow' : 'ok'}">${ic(why ? 'x' : slow ? 'clock' : 'check')}${esc(eligTxt)}</div>
      <div class="actions"><button class="${why || slow ? '' : 'primary'}" data-act="accept" data-job="${esc(j.id)}"${slow ? ` data-slow="1" data-need="${esc(fmtShipH(est.needH))}" data-budget="${esc(String(est.budgetH))}"` : ''} ${why ? `disabled title="${esc(why)}"` : ''}>${slow ? 'Accept anyway' : 'Accept'}</button></div>
    </article>`;
  }
  tabJobs(h, you, C) {
    const mass = you.cargo.reduce((s, c) => s + c.qty, 0);
    const mine = you.jobs || [];
    const paxUsed = mine.filter((x) => x.pax).reduce((s, x) => s + x.pax, 0);
    const rank = (j) => (this.whyNot(j, you, C, mass) ? 2 : this.jobEst(j, you, C, mass).ok ? 0 : 1); // fits, too slow, cannot
    const jobs = [...(h.jobs || [])].sort((x, y) => rank(x) - rank(y) || y.pay - x.pay);
    return `<div class="secHead"><div><h2>${ic('contract')}Contracts</h2><p>Deliveries complete automatically when you moor at the destination. Hold ${fmtT(mass)} / ${fmtT(C.capacity)} · ${Math.max(0, C.pax - paxUsed)} of ${C.pax} berths free.</p></div>
        <div class="tools"><span class="chip">${jobs.length} on the board</span></div></div>
      ${jobs.length ? `<div class="cards">${jobs.map((j) => this.jobCard(j, h, you, C, mass, false)).join('')}</div>` : `<div class="empty">${ic('contract')}<span>The board is empty right now — new contracts are posted every hour.</span></div>`}
      <h3 class="subHead">${ic('list')}Your contracts${mine.length ? ` · ${fmt(mine.reduce((s, j) => s + j.pay, 0))} cr outstanding` : ''}</h3>
      ${mine.length ? `<div class="mineList">${mine.map((j) => { const st = this.mineStatus(j, you); return `<div class="mineRow">${ic(JOB_ICON[j.contraband ? 'smuggling' : j.type] || 'contract')}<div class="t"><b>${esc(j.title)}</b><small>to ${esc(short(this.hname(j.to)))} · <span class="${this.deadlineSec(j) < 0 ? 'down' : ''}" title="Counted on your ship's clock">${this.deadline(j)}${this.deadlineSec(j) < 0 ? ' — half pay' : ' left (ship time)'}</span>${st.text ? ` · <span class="${st.ready ? 'up' : 'down'}">${esc(st.text)}</span>` : ''}</small></div><span class="p">${fmt(j.pay)} cr</span>${st.here ? `<button class="small primary" data-act="deliver" data-job="${esc(j.id)}">Deliver</button>` : ''}<button class="small danger" data-act="abandon" data-job="${esc(j.id)}">Abandon</button></div>`; }).join('')}</div>`
        : `<div class="empty">${ic('crate')}<span>No contracts aboard. Take one above, or look at every harbour's board in <i>Job boards</i>.</span></div>`}`;
  }

  /** One line on an accepted contract: can it be delivered here, and what is still missing. */
  mineStatus(j, you) {
    const here = !!you.docked && j.to === you.docked;
    if (j.type === 'fishing') {
      const have = (you.cargo || []).filter((c) => c.good === 'fish' && c.caught && !c.jobId).reduce((s, c) => s + (+c.qty || 0), 0);
      const ready = have >= j.qty * 0.25;
      return { here, ready, text: `${fmt1(Math.min(have, j.qty))} of ${fmtT(j.qty)} caught${ready && here ? ' — ready to deliver' : ''}` };
    }
    if (j.type === 'tow') return { here, ready: you.towing === j.id, text: you.towing === j.id ? 'in tow' : 'casualty not picked up yet' };
    if (j.type === 'supply') return { here: false, ready: false, text: `deliver at ${j.platformName || 'the platform'} (at sea)` };
    return { here, ready: here, text: here ? 'ready to deliver' : '' };
  }
  // -------- job boards (every harbour)
  tabBoards(you, C) {
    const data = cachedJobs();
    if (!data) { fetchJobs().then(() => { if (this.harborOpen() && this.harborTab === 'boards') this.renderTab('boards'); }); return `<div class="empty">${ic('board')}<span>Loading every harbour's job board…</span></div>`; }
    const me = this.app.ship, mass = you.cargo.reduce((s, c) => s + c.qty, 0);
    const rows = data.harbors.map((e) => { const h = this.app.world.harbors.find((x) => x.id === e.id) || e.harbor; if (!h) return null; const d = me ? haversine(me.lat, me.lon, h.lat, h.lon) : 0; return { e, h, d }; }).filter((r) => r && r.e.jobs.length).sort((a, b) => a.d - b.d);
    if (!this.openBoards) this.openBoards = new Set(rows.slice(0, 2).map((r) => r.e.id));
    const total = data.harbors.reduce((s, e) => s + e.jobs.length, 0);
    return `<div class="secHead"><div><h2>${ic('board')}Job boards</h2><p>Every harbour's contracts, nearest first (${total} in total). Contracts are taken at the harbour that posts them. Updated ${Math.max(0, Math.round((Date.now() - data.time) / 1000))} s ago.</p></div></div>
      <div class="boardList">${rows.map(({ e, h, d }) => {
        const open = this.openBoards.has(e.id);
        const best = Math.max(...e.jobs.map((j) => j.pay));
        return `<div class="boardCard${open ? ' open' : ''}"><div class="boardHead" data-act="boardToggle" data-id="${esc(e.id)}" role="button" tabindex="0" aria-expanded="${open}">
            <span class="goodIcon">${ic('anchor')}</span><div class="bh"><b>${esc(short(h.name))}</b><small>${me ? `${fmtDistance(d)} · ${pad3(bearing(me.lat, me.lon, h.lat, h.lon))}°` : ''} · fuel ${fmt(e.fuel)} cr/t · best ${fmt(best)} cr</small></div>
            <span class="cnt">${e.jobs.length}</span><button class="small" data-act="chartAt" data-lat="${h.lat}" data-lon="${h.lon}" title="Show on the chart">${ic('chart')}<span class="lbl">Chart</span></button><span class="chev">${ic('chevronDown')}</span></div>
          <div class="boardJobs">${e.jobs.map((j) => { const why = this.whyNot(j, you, C, mass); const [ra, rb] = this.routeOf(j, h); const type = j.type; return `<div class="miniJob">${ic(JOB_ICON[type] || 'contract')}<div class="t"><div>${esc(j.title || `${JOB_LABEL[type]} to ${rb}`)}</div><small>${esc(ra)} → ${esc(rb)}${j.distKm ? ` · ${fmt(j.distKm)} km` : ''} · ${this.deadline(j)}${why ? ` · <span class="down">${esc(why)}</span>` : (() => { const est = this.jobEst(j, you, C, mass); return est.ok ? ` · <span class="up" title="${esc(est.label)}">ok</span>` : ` · <span class="down" title="${esc(`${est.why}. ${est.label}`)}">too slow</span>`; })()}</small></div><div class="p">${fmt(j.pay)} cr<small>${this.payPerT(j)}${j.qty ? '/t' : ''}</small></div></div>`; }).join('')}</div></div>`;
      }).join('')}</div>`;
  }

  // -------- market
  tabMarket(h, you, C) {
    const econ = h.econ || null;
    // V6 item 7: the World market's trade plan shows on that good's card at the buying and at the selling harbour
    const tp = this.app.tradePlan;
    const planChip = (g) => !tp || tp.good !== g || (tp.from !== h.id && tp.to !== h.id) ? '' : `<div class="mkPlanChip">${ic('contract')}<span>${tp.from === h.id ? `Planned: buy ${fmtT(tp.qty)} ${esc((GOODS[g]?.name || g).toLowerCase())}` : `Planned: sell here ≈ ${fmt(tp.sellArrive)} cr/t`}</span><button data-act="worldMarket" data-sub="unplan" aria-label="Clear the trade plan" title="Clear the plan">${ic('close')}</button></div>`;
    const mass = you.cargo.reduce((s, c) => s + c.qty, 0), free = Math.max(0, C.capacity - mass);
    const cards = Object.entries(h.market || {}).map(([g, p]) => {
      const G = GOODS[g] || { name: g };
      const have = you.cargo.filter((c) => c.good === g && !c.jobId).reduce((s, c) => s + c.qty, 0);
      const st = econ?.stock?.[g], tg = econ?.target?.[g];
      const tr = econ?.trend?.[g] ?? 0;
      const ratio = st != null && tg > 0 ? st / tg : null;
      const level = ratio == null ? '' : ratio < 0.6 ? 'short — sells high' : ratio > 1.6 ? 'glut — buys cheap' : 'normal';
      const maxBuy = Math.max(0, Math.min(Math.floor(free), p > 0 ? Math.floor(you.money / p) : 0, st != null ? Math.floor(st) : Infinity));
      const impact = (() => { if (!(st > 0)) return ''; const q = Math.min(st * 0.5, 100); const up = (Math.sqrt(st / Math.max(1, st - q)) - 1) * 100; return `+${up.toFixed(1)} % per ${Math.round(q)} t bought`; })();
      return `<article class="card goodCard${G.contraband ? ' contra' : ''}">
        <div class="goodTop"><span class="goodIcon">${ic(GOOD_ICON[g] || 'crate')}</span><div class="goodName"><b>${esc(G.name)}</b><small>${have ? `${fmtT(have)} aboard` : 'none aboard'}</small></div>
          <div class="price"><b>${fmt(p)}</b><small>cr/t</small> <span class="trend ${tr > 0 ? 'up' : tr < 0 ? 'down' : 'flat'}">${ic(tr > 0 ? 'trendUp' : tr < 0 ? 'trendDown' : 'trendFlat')}</span></div></div>
        ${st != null ? `<div class="stockRow"><span>Stock ${fmtT(st)}${tg ? ` · normal ${fmtT(tg)}` : ''}</span><span class="${ratio < 0.6 ? 'up' : ratio > 1.6 ? 'down' : ''}">${level}</span><span class="meter ${ratio < 0.6 ? 'bad' : ratio > 1.6 ? 'warn' : 'good'}"><i style="width:${Math.round(clamp01((ratio ?? 1) / 2) * 100)}%"></i></span></div>` : ''}
        <div class="stepper"><button data-act="qty" data-good="${esc(g)}" data-d="-10" aria-label="Less">${ic('minus')}</button><input type="number" inputmode="numeric" min="1" step="1" value="100" data-qty="${esc(g)}" data-price="${p}" aria-label="${esc(G.name)} quantity in tonnes"><button data-act="qty" data-good="${esc(g)}" data-d="10" aria-label="More">${ic('plus')}</button></div>
        <div class="presets"><button data-act="qtySet" data-good="${esc(g)}" data-v="10">10 t</button><button data-act="qtySet" data-good="${esc(g)}" data-v="100">100 t</button><button data-act="qtySet" data-good="${esc(g)}" data-v="${maxBuy}" ${maxBuy > 0 ? '' : 'disabled'} title="As much as fits in the hold and your purse">Max ${fmt(maxBuy)}</button><button data-act="qtySet" data-good="${esc(g)}" data-v="${have}" ${have ? '' : 'disabled'}>All aboard</button></div>
        <div class="tradeNote" data-cost="${esc(g)}"></div>
        <div class="tradeBtns"><button class="primary" data-act="buy" data-good="${esc(g)}">Buy</button><button data-act="sell" data-good="${esc(g)}" ${have ? '' : 'disabled'}>Sell</button></div>
        ${impact ? `<div class="muted small">${impact}</div>` : ''}
        ${planChip(g)}
      </article>`;
    });
    return `<div class="secHead"><div><h2>${ic('market')}Market</h2><p>Prices follow supply and demand: buying draws down the stock and raises the price, selling lowers it; stocks drift back toward normal over hours. Contract cargo cannot be sold. Hold free: ${fmtT(free)}.</p></div>
        <div class="inline"><button class="mkWorldBtn" data-act="worldMarket" data-sub="trades" data-h="${esc(h.id)}" title="Best trades from here for your ship">${ic('route')}<span class="lbl">Trades from here</span></button><button class="mkWorldBtn" data-act="worldMarket" title="Every harbour's prices (L)">${ic('globe')}<span class="lbl">World market</span></button></div></div>
      <div class="cards">${cards.join('')}</div>`;
  }

  // -------- shipyard
  specBars(sp) {
    const r = rangeNmOf(sp);
    const bars = [
      ['Speed', clamp01(sp.maxKn / 30), `${sp.maxKn} kn`, ''],
      ['Capacity', clamp01(Math.log10(1 + sp.capacity) / Math.log10(1 + 90000)), sp.pax > sp.capacity * 2 ? `${fmt(sp.pax)} pax` : fmtT(sp.capacity), ''],
      ['Range', r === Infinity ? 1 : clamp01(Math.log10(Math.max(1, r) / 100) / 2), r === Infinity ? '∞ sail' : `${fmt(r)} nm`, ''],
      ['Crew', clamp01(Math.max(0.02, sp.crewCost / 400)), sp.crewCost ? `${fmt(sp.crewCost)} cr/h` : 'none', 'cost'],
    ];
    return `<div class="specs">${bars.map(([l, f, v, c]) => `<div class="spec ${c}"><label>${l}</label><span class="meter"><i style="width:${Math.round(f * 100)}%"></i></span><span class="v">${v}</span></div>`).join('')}</div>`;
  }
  shipCard({ id, entry, used, you, tradeIn }) {
    const sp = specsOf(id, entry);
    const own = !used && you.ship.cls === id;
    const price = used ? used.price : sp.price;
    const net = price - tradeIn;
    const afford = you.money >= net;
    const cmpKey = used ? `used:${used.id}` : `new:${id}`;
    const inCmp = this.compare.includes(cmpKey);
    const wear = used ? 1 - used.cond / 100 : 0;
    const catTag = `<span class="chip catTag">${ic(CAT_ICON[sp.cat] || 'ship')}${esc(CAT_LABEL[sp.cat] || sp.cat || '')}</span>`;
    const ownTag = own ? '<span class="chip good ownTag">your ship</span>' : used ? `<span class="chip ${used.cond < 50 ? 'bad' : 'amber'} ownTag">${used.cond} % hull</span>` : '';
    return `<article class="card shipCard">
      ${this.thumbHTML(id, { w: 360, h: 225, angle: 'quarter', wear, inner: catTag + ownTag })}
      <div class="shipBody">
        <div class="shipName"><h3>${esc(used?.name || sp.name)}</h3><span class="p">${fmt(price)} cr</span></div>
        <p class="desc">${esc(sp.desc)}</p>
        <div class="dims"><span>${ic('ship')}${sp.length} × ${sp.beam} m</span><span>${ic('arrowDown')}draft ${sp.draft} m</span><span>${ic('users')}${sp.pax} pax</span><span>${ic('fuel')}${sp.burn} t/h</span></div>
        ${this.specBars(sp)}
        ${used ? `<div class="spec cond"><label>Condition</label><span class="meter ${used.cond < 50 ? 'bad' : used.cond < 70 ? 'warn' : 'good'}"><i style="width:${used.cond}%"></i></span><span class="v">${used.cond} %</span></div>` : ''}
        <div class="netLine">${tradeIn > 0 ? `Net after trade-in <b>${fmt(net)} cr</b>` : 'No trade-in value'}${!afford && !own ? ` · <span class="down">${fmt(net - you.money)} cr short</span>` : ''}</div>
        <div class="shipFoot"><button class="cmp${inCmp ? ' on' : ''}" data-act="compare" data-key="${esc(cmpKey)}" title="Compare up to 3 ships side by side">${ic('compare')}<span class="lbl">${inCmp ? 'Comparing' : 'Compare'}</span></button>
          ${own ? '<button disabled>Owned</button>' : used ? `<button class="primary" data-act="used" data-id="${esc(used.id)}" ${afford ? '' : 'disabled'}>Buy used</button>` : `<button class="primary" data-act="ship" data-cls="${esc(id)}" ${afford ? '' : 'disabled'}>Buy new</button>`}</div>
      </div></article>`;
  }
  tabShipyard(h, you, C) {
    const tradeIn = Number.isFinite(h.tradeIn) ? h.tradeIn : h.shipyard?.[0]?.tradeIn ?? 0;
    const sellValue = Number.isFinite(h.sellValue) ? h.sellValue : tradeIn;
    const yard = h.shipyard || [], used = h.used || [];
    const catOf = (id, e) => e?.cat || SHIP_CLASSES[id]?.cat;
    const mode = this.yardMode;
    const cats = CATS.filter((c) => (mode === 'used' ? used.some((u) => catOf(u.cls) === c) : yard.some((s) => catOf(s.id, s) === c)));
    if (this.yardCat !== 'all' && !cats.includes(this.yardCat)) this.yardCat = 'all';
    const seg = `<div class="seg" role="tablist"><button data-act="yardMode" data-mode="new" class="${mode === 'new' ? 'on' : ''}"><span class="long">New hulls</span><span class="short">New</span> · ${yard.length}</button><button data-act="yardMode" data-mode="used" class="${mode === 'used' ? 'on' : ''}"><span class="long">Second-hand</span><span class="short">Used</span> · ${used.length}</button><button data-act="yardMode" data-mode="sell" class="${mode === 'sell' ? 'on' : ''}"><span class="long">Sell yours</span><span class="short">Sell</span></button></div>`;
    const chips = mode === 'sell' ? '' : `<div class="chips"><button class="chipBtn${this.yardCat === 'all' ? ' on' : ''}" data-act="yardCat" data-cat="all">${ic('grid')}All</button>${cats.map((c) => `<button class="chipBtn${this.yardCat === c ? ' on' : ''}" data-act="yardCat" data-cat="${esc(c)}">${ic(CAT_ICON[c] || 'ship')}${esc(CAT_LABEL[c] || c)}</button>`).join('')}</div>`;
    let body = '';
    if (mode === 'sell') {
      const sp = specsOf(you.ship.cls);
      body = `<div class="cards wide"><article class="card shipCard">${this.thumbHTML(you.ship.cls, { w: 360, h: 225, angle: 'quarter', wear: 1 - you.cond / 100, inner: '<span class="chip good ownTag">your ship</span>' })}
          <div class="shipBody"><div class="shipName"><h3>${esc(C.name)}</h3><span class="p">${fmt(sellValue)} cr</span></div>
          <p class="desc">Condition ${Math.round(you.cond)} %. The yard pays the value shown, or credits it as trade-in when you buy another hull.</p>
          ${this.specBars(sp)}
          <div class="spec cond"><label>Condition</label><span class="meter ${you.cond < 50 ? 'bad' : you.cond < 70 ? 'warn' : 'good'}"><i style="width:${Math.round(you.cond)}%"></i></span><span class="v">${Math.round(you.cond)} %</span></div>
          <div class="shipFoot" style="grid-template-columns:1fr"><button class="danger" data-act="sellship" ${sellValue > 0 ? '' : 'disabled'}>${ic('tag')}Sell for ${fmt(sellValue)} cr</button></div>
          <p class="muted small" style="margin:0">Selling without buying leaves you with a pilot boat to get around in.</p></div></article></div>`;
    } else if (mode === 'used') {
      const list = used.filter((u) => this.yardCat === 'all' || catOf(u.cls) === this.yardCat);
      body = list.length ? `<div class="cards wide">${list.map((u) => this.shipCard({ id: u.cls, entry: { specs: u.specs, name: u.name }, used: u, you, tradeIn })).join('')}</div>`
        : `<div class="empty">${ic('shipyard')}<span>No second-hand hulls on offer right now; listings refresh every few hours.</span></div>`;
    } else {
      const list = yard.filter((s) => this.yardCat === 'all' || catOf(s.id, s) === this.yardCat).sort((a, b) => a.price - b.price);
      body = `<div class="cards wide">${list.map((s) => this.shipCard({ id: s.id, entry: s, used: null, you, tradeIn })).join('')}</div>`;
    }
    const tray = this.compare.length ? `<div class="compareTray"><b>${ic('compare')} Compare ${this.compare.length}/3</b><div class="slots">${this.compare.map((k) => { const it = this.compareItem(k); return it ? `<span class="slot">${this.thumbHTML(it.id, { w: 88, h: 56, angle: 'side', wear: it.wear })}${esc(it.name)}<button class="iconBtn small" data-act="compare" data-key="${esc(k)}" aria-label="Remove">${ic('x')}</button></span>` : ''; }).join('')}</div>
        <button data-act="compareClear">Clear</button><button class="primary" data-act="compareOpen" ${this.compare.length < 2 ? 'disabled title="Pick at least two ships"' : ''}>Compare side by side</button></div>` : '';
    return `<div class="secHead"><div><h2>${ic('shipyard')}Shipyard</h2><p>Your ${esc(C.name)} (${Math.round(you.cond)} %) is worth <b>${fmt(tradeIn)} cr</b> — traded in automatically when you buy. Credits: <b>${fmt(you.money)} cr</b>.</p></div></div>
      <div class="yardBar">${seg}${chips}</div>${body}${tray}`;
  }
  compareItem(key) {
    const h = this.harborData; if (!h) return null;
    const [kind, id] = key.split(':');
    if (kind === 'used') { const u = (h.used || []).find((x) => x.id === id); if (!u) return null; const sp = specsOf(u.cls, { specs: u.specs }); return { key, id: u.cls, name: u.name || sp.name, sp, price: u.price, cond: u.cond, wear: 1 - u.cond / 100, used: true }; }
    const e = (h.shipyard || []).find((s) => s.id === id); const sp = specsOf(id, e); return { key, id, name: sp.name, sp, price: e?.price ?? sp.price, cond: 100, wear: 0, used: false };
  }
  renderCompare() {
    const wrap = $('compareWrap'); if (!wrap) return;
    const items = this.compare.map((k) => this.compareItem(k)).filter(Boolean);
    if (items.length < 2) { wrap.classList.add('hidden'); return; }
    const rows = [
      ['Price', (it) => it.price, (v) => `${fmt(v)} cr`, 'min'],
      ['Condition', (it) => it.cond, (v) => `${v} %`, 'max'],
      ['Speed', (it) => it.sp.maxKn, (v) => `${v} kn`, 'max'],
      ['Capacity', (it) => it.sp.capacity, (v) => fmtT(v), 'max'],
      ['Passengers', (it) => it.sp.pax, (v) => fmt(v), 'max'],
      ['Range', (it) => rangeNmOf(it.sp), (v) => (v === Infinity ? '∞ sail' : `${fmt(v)} nm`), 'max'],
      ['Fuel tank', (it) => it.sp.fuelCap, (v) => fmtT(v), 'max'],
      ['Burn', (it) => it.sp.burn, (v) => `${v} t/h`, 'min'],
      ['Crew cost', (it) => it.sp.crewCost, (v) => (v ? `${fmt(v)} cr/h` : 'none'), 'min'],
      ['Length', (it) => it.sp.length, (v) => `${v} m`, ''],
      ['Draft', (it) => it.sp.draft, (v) => `${v} m`, 'min'],
      ['Displacement', (it) => it.sp.displacement, (v) => fmtT(v), ''],
    ];
    const best = rows.map(([, f, , mode]) => { if (!mode) return null; const vs = items.map(f); return mode === 'min' ? Math.min(...vs) : Math.max(...vs); });
    const isBest = (i, f, it) => { const v = f(it); return best[i] != null && v === best[i] && items.some((o) => f(o) !== v); };
    const buyBtn = (it) => (it.used ? `<button class="primary${this.touch ? '' : ' block'}" data-act="used" data-id="${esc(it.key.split(':')[1])}">Buy used</button>` : this.app.you?.ship.cls === it.id ? `<button class="${this.touch ? '' : 'block'}" disabled>Owned</button>` : `<button class="primary${this.touch ? '' : ' block'}" data-act="ship" data-cls="${esc(it.id)}">Buy new</button>`);
    const head = `<header class="sheetHead"><span class="sheetIcon">${ic('compare')}</span><div class="sheetTitle"><b>Compare ships</b><small>Best value in each row marked ★</small></div><button class="iconBtn close" data-act="compareClose" aria-label="Close">${ic('close')}</button></header>`;
    if (this.touch) { // phones: one table, ships as columns, so every value lines up and nothing scrolls sideways
      wrap.innerHTML = `<div class="compareBox">${head}<div class="cmpTable" style="grid-template-columns: 84px repeat(${items.length}, minmax(0, 1fr))">
        <div class="ct-h"></div>${items.map((it) => `<div class="ct-h">${this.thumbHTML(it.id, { w: 200, h: 125, angle: 'quarter', wear: it.wear })}<b>${esc(it.name)}</b><small class="muted">${it.used ? 'used' : 'new'}</small></div>`).join('')}
        ${rows.map(([label, f, show], i) => `<div class="ct-l">${label}</div>${items.map((it) => `<div class="ct-v${isBest(i, f, it) ? ' best' : ''}">${show(f(it))}</div>`).join('')}`).join('')}
        <div class="ct-b"></div>${items.map((it) => `<div class="ct-b">${buyBtn(it)}</div>`).join('')}</div></div>`;
      wrap.classList.remove('hidden');
      this.hydrateThumbs(wrap);
      return;
    }
    wrap.innerHTML = `<div class="compareBox">${head}
      <div class="compareGrid" style="grid-template-columns: repeat(${items.length}, minmax(220px, 1fr))">${items.map((it) => `<div class="cmpCol">${this.thumbHTML(it.id, { w: 320, h: 200, angle: 'quarter', wear: it.wear })}<div class="cmpBody"><h3>${esc(it.name)}</h3><div class="muted small">${it.used ? 'second-hand' : 'new'} · ${esc(CAT_LABEL[it.sp.cat] || it.sp.cat || '')}</div>
        ${rows.map(([label, f, show], i) => `<div class="cmpRow"><span>${label}</span><b class="${isBest(i, f, it) ? 'best' : ''}">${show(f(it))}</b></div>`).join('')}
        <div style="margin-top:8px">${buyBtn(it)}</div></div></div>`).join('')}</div></div>`;
    wrap.classList.remove('hidden');
    this.hydrateThumbs(wrap);
  }

  // -------- services
  tabServices(h, you, C) {
    const fuelNeed = Math.max(0, C.fuelCap - you.fuel);
    const step = C.fuelCap < 10 ? 0.1 : 1;
    const maxAff = h.fuelPrice > 0 ? Math.min(fuelNeed, Math.floor((you.money / h.fuelPrice) / step) * step) : fuelNeed;
    const def = Math.max(0, Math.round(maxAff / step) * step);
    const servicePrice = Number.isFinite(h.servicePrice) ? h.servicePrice : Number.isFinite(h.fees?.service) ? h.fees.service : Math.round(Math.max(120000, C.price) * 0.01);
    const due = you.serviceDue ?? h.serviceDue;
    const now = this.app.simTime || Date.now() / 1000;
    const dueTxt = due == null ? 'not yet tracked' : due > 1e9 ? (due - now > 0 ? `due in ${Math.ceil((due - now) / 86400)} d` : `overdue by ${Math.ceil((now - due) / 86400)} d`) : due > 0 ? `due in ${Math.ceil(due)} d` : 'overdue';
    const overdue = /overdue/.test(dueTxt);
    const pct = (v) => Math.round(clamp01(v) * 100);
    return `<div class="secHead"><div><h2>${ic('wrench')}Services</h2><p>Fuel dock, repair yard and chandlery. Credits: <b>${fmt(you.money)} cr</b>.</p></div></div>
      <div class="cards">
        <article class="card svcCard"><h3>${ic('fuel')}Fuel dock <span class="chip amber" style="margin-left:auto">${fmt(h.fuelPrice)} cr/t</span></h3>
          <div class="tank"><i style="width:${pct(you.fuel / C.fuelCap)}%"></i><i class="add" id="fuelAdd" style="left:${pct(you.fuel / C.fuelCap)}%;width:0"></i><span>${you.fuel.toFixed(C.fuelCap < 10 ? 2 : 1)} / ${C.fuelCap} t</span></div>
          ${fuelNeed > step / 2 ? `<input type="range" id="fuelSlider" data-qty="__fuel" min="0" max="${fuelNeed.toFixed(step < 1 ? 1 : 0)}" step="${step}" value="${def}" aria-label="Fuel to bunker in tonnes" data-price="${h.fuelPrice}" data-cap="${C.fuelCap}" data-have="${you.fuel}">
          <div class="buyLine"><span id="fuelQty">+${def} t</span><b id="fuelCost">${fmt(def * h.fuelPrice)} cr</b></div>
          <div class="btnRow"><button class="primary" data-act="fuelBuy">Bunker</button><button data-act="fuel" data-t="${fuelNeed}">Fill up · ${fmt(fuelNeed * h.fuelPrice)} cr</button></div>` : '<div class="elig ok">' + ic('check') + 'Tanks are full.</div>'}
        </article>
        <article class="card svcCard"><h3>${ic('wrench')}Repair yard</h3>
          <div class="gaugeRow"><label>Hull</label><span class="meter ${you.cond < 30 ? 'bad' : you.cond < 60 ? 'warn' : 'good'}"><i style="width:${Math.round(you.cond)}%"></i></span><b>${Math.round(you.cond)} %</b></div>
          ${you.flooding > 0 ? `<div class="elig bad">${ic('warning')}Flooding ${Math.round(you.flooding * 100)} % — pumped out at the quay</div>` : ''}
          <button class="${h.repairCost > 0 ? 'primary' : ''}" data-act="repair" ${h.repairCost > 0 ? '' : 'disabled'}>${h.repairCost > 0 ? `Overhaul to 100 % · ${fmt(h.repairCost)} cr` : 'Hull in perfect condition'}</button>
        </article>
        <article class="card svcCard"><h3>${ic('gauge')}Maintenance</h3>
          <p style="margin:0">Yard service (1 % of the hull) — <b class="${overdue ? 'down' : ''}">${esc(dueTxt)}</b>. Without a service every 30 days of sailing the wear rate climbs up to +60 %.</p>
          <button data-act="service" class="${overdue ? 'primary' : ''}">Service · ${fmt(servicePrice)} cr</button>
        </article>
        <article class="card svcCard"><h3>${ic('kit')}Chandlery</h3>
          <p style="margin:0">Damage-control kit: +15 % hull and pumps out 30 % of the water at sea (K). You carry <b>${you.kits || 0}</b>.</p>
          <button data-act="kit">Buy kit · 2,500 cr</button>
        </article>
        <article class="card svcCard" style="grid-column: 1 / -1"><h3>${ic('crate')}Cargo aboard</h3>
          ${you.cargo.length ? `<div class="cargoList">${you.cargo.map((c) => `<div class="cargoRow">${ic(GOOD_ICON[c.good] || 'crate')}<span>${esc(GOODS[c.good]?.name || c.good)}${c.contraband ? '<span class="chip bad">contraband</span>' : ''}${c.jobId ? '<span class="chip">contract</span>' : ''}${c.caught ? '<span class="chip good">caught</span>' : ''}</span><b class="num">${fmtT(c.qty)}</b><button class="small danger" data-act="dump" data-good="${esc(c.good)}">Dump</button></div>`).join('')}</div>` : '<p class="muted" style="margin:0">Empty hold.</p>'}
        </article>
      </div>`;
  }

  // -------- black market, players
  tabShady(h, you, C) {
    const mass = you.cargo.reduce((s, c) => s + c.qty, 0);
    const head = `<div class="secHead"><div><h2>${ic('mask')}Black market</h2><p>Somebody in the harbour bar always knows somebody. Illegal cargo pays five times the going rate — if the coast guard does not find it.</p></div></div>`;
    if (!h.contactLooked) return head + `<article class="card" style="max-width:560px"><h3>${ic('eye')}Look around</h3><p>Wander the quays and the bar and see who wants to talk. It costs nothing to look.</p><button class="primary" data-act="look">${ic('eye')}Look around</button></article>`;
    if (!h.contact) return head + `<div class="empty">${ic('mask')}<span>Nobody here wants to talk business today. Try another harbour.</span></div>`;
    return head + `<article class="card personCard" style="margin-bottom:12px"><span class="avatar" style="background:var(--violet-soft);color:var(--violet)">${ic('mask')}</span><div class="pc"><b>${esc(h.contact.name)}</b><small>keeps their voice low · ${h.contact.jobs.length} run${h.contact.jobs.length === 1 ? '' : 's'} on offer</small></div></article>
      <div class="cards">${h.contact.jobs.map((j) => this.jobCard(j, h, you, C, mass, true)).join('')}</div>`;
  }
  tabPlayers(h) {
    const list = h.dockedPlayers || [];
    return `<div class="secHead"><div><h2>${ic('users')}Skippers in port</h2><p>Trade cargo, form a convoy (escorts halve boarding odds) — or board them, which makes you wanted.</p></div></div>
      ${list.length ? `<div class="cards">${list.map((p) => `<article class="card"><div class="personCard"><span class="avatar">${esc((p.name || '?').charAt(0).toUpperCase())}</span><div class="pc"><b>${esc(p.name)}</b><small>moored here</small></div></div><div class="actRow" style="margin-top:12px">${this.playerActions(p.id)}</div></article>`).join('')}</div>`
        : `<div class="empty">${ic('users')}<span>No other skippers are moored here right now.</span></div>`}`;
  }
  playerActions(id) {
    return `<button data-act="trade" data-id="${esc(id)}">${ic('handshake')}Trade</button><button data-act="convoy" data-id="${esc(id)}">${ic('users')}Convoy</button><button data-act="boardShip" data-id="${esc(id)}" class="danger">${ic('skull')}Board</button>`;
  }
  bindPlayerActions() { /* delegated: see sheetAction() */ }
  tradeDialog(targetId) {
    const you = this.app.you;
    const free = you.cargo.filter((c) => !c.jobId);
    if (!free.length) return this.event({ kind: 'warn', text: 'You have no free (non-contract) cargo to offer.' });
    const good = prompt(`Offer which commodity? (${free.map((c) => `${c.good}:${c.qty}t`).join(', ')})`, free[0].good);
    if (!good || !GOODS[good]) return;
    const qty = +prompt('Quantity (t)?', String(Math.min(100, free.find((c) => c.good === good)?.qty || 0)));
    const price = +prompt('Total price (cr)?', String(Math.round(qty * GOODS[good].base * 0.9)));
    if (!(qty > 0) || !(price >= 0)) return;
    this.app.net.action('trade_offer', { toId: targetId, good, qty, price });
  }

  // -------- delegated actions and live inputs
  sheetAction(act, el) {
    const a = this.app, net = a.net, you = a.you, root = $('harborWrap');
    const qtyInput = (g) => root.querySelector(`input[data-qty="${CSS.escape(g)}"]`);
    switch (act) {
      case 'tab': return this.showTab(el.dataset.tab);
      case 'worldMarket': // V6 item 7: the World market sheet; data-sub="unplan" clears the trade plan chip
        if (el.dataset.sub === 'unplan') { if (a.market) a.market.clearPlan(); else { a.tradePlan = null; this.renderHarborTabs(); } return; }
        if (el.dataset.sub === 'trades') return a.market?.tradesFrom(el.dataset.h);
        return a.market?.open('prices');
      case 'accept':
        // V6 item 5: a contract your ship cannot make in time is still yours to take — after one honest question
        if (el.dataset.slow && !confirm(`Your ship needs ~${el.dataset.need}, the contract allows ${el.dataset.budget} h of ship time. Late delivery pays half. Accept anyway?`)) return;
        return net.action('accept_job', { jobId: el.dataset.job });
      case 'deliver': net.action('deliver_jobs'); return;
      case 'abandon': if (confirm('Abandon this contract? Cargo is returned or dumped and a 10 % fee is charged.')) net.action('abandon_job', { jobId: el.dataset.job }); return;
      case 'fuel': return net.action('buy_fuel', { tonnes: +el.dataset.t });
      case 'fuelBuy': { const v = +($('fuelSlider')?.value || 0); if (v > 0) net.action('buy_fuel', { tonnes: v }); else this.event({ kind: 'warn', text: 'Slide to choose how much fuel to bunker.' }); return; }
      case 'repair': return net.action('repair');
      case 'service': return net.action('service');
      case 'kit': return net.action('buy_kit');
      case 'dump': if (confirm('Dump this cargo overboard?')) net.action('dump_cargo', { good: el.dataset.good }); return;
      case 'qty': { const i = qtyInput(el.dataset.good); if (i) { i.value = String(Math.max(1, Math.round((+i.value || 0) + +el.dataset.d))); this.sheetInput(i); } return; }
      case 'qtySet': { const i = qtyInput(el.dataset.good); if (i) { i.value = String(Math.max(1, Math.floor(+el.dataset.v || 1))); this.sheetInput(i); } return; }
      case 'buy': { const q = Math.floor(+(qtyInput(el.dataset.good)?.value || 0)); if (q > 0) net.action('buy_goods', { good: el.dataset.good, qty: q }); return; }
      case 'sell': {
        const q = Math.floor(+(qtyInput(el.dataset.good)?.value || 0)); if (!(q > 0)) return;
        const fj = el.dataset.good === 'fish' ? (this.app.you?.jobs || []).find((x) => x.type === 'fishing') : null;
        if (fj && !confirm(`This fish is for your contract "${fj.title}" (deliver it with the Deliver button under Contracts). Sell it on the market anyway?`)) return;
        net.action('sell_goods', { good: el.dataset.good, qty: q }); return;
      }
      case 'look': return net.action('lookaround');
      case 'yardMode': this.yardMode = el.dataset.mode; this.yardCat = 'all'; return this.renderTab('shipyard');
      case 'yardCat': this.yardCat = el.dataset.cat; return this.renderTab('shipyard');
      case 'compare': {
        const k = el.dataset.key, i = this.compare.indexOf(k);
        if (i >= 0) this.compare.splice(i, 1); else { if (this.compare.length >= 3) this.compare.shift(); this.compare.push(k); }
        this.renderTab('shipyard');
        if (!$('compareWrap').classList.contains('hidden')) this.renderCompare();
        return;
      }
      case 'compareOpen': return this.renderCompare();
      case 'compareClear': this.compare = []; $('compareWrap').classList.add('hidden'); return this.renderTab('shipyard');
      case 'compareClose': return $('compareWrap').classList.add('hidden');
      case 'ship': { const C = SHIP_CLASSES[el.dataset.cls]; if (confirm(`Buy a new ${C?.name || el.dataset.cls}? Your current ship is traded in.`)) { net.action('buy_ship', { cls: el.dataset.cls }); $('compareWrap').classList.add('hidden'); } return; }
      case 'used': if (confirm('Buy this second-hand hull? Your current ship is traded in.')) { net.action('buy_used', { listingId: el.dataset.id }); $('compareWrap').classList.add('hidden'); } return;
      case 'sellship': { const v = this.harborData?.sellValue ?? this.harborData?.tradeIn ?? 0; if (confirm(`Sell your ${SHIP_CLASSES[you.ship.cls]?.name || 'ship'} for ${fmt(v)} cr? You will be left with a pilot boat.`)) net.action('sell_ship'); return; }
      case 'chartAt': { const lat = +el.dataset.lat, lon = +el.dataset.lon; this.openChart(); this.chart.setCenter(lat, lon, 10); return; }
      case 'boardToggle': { if (!this.openBoards) this.openBoards = new Set(); const id = el.dataset.id; if (this.openBoards.has(id)) this.openBoards.delete(id); else this.openBoards.add(id); const card = el.closest('.boardCard'); card?.classList.toggle('open', this.openBoards.has(id)); el.setAttribute('aria-expanded', String(this.openBoards.has(id))); return; }
      case 'trade': return this.tradeDialog(el.dataset.id);
      case 'convoy': return net.action('convoy_invite', { targetId: el.dataset.id });
      case 'boardShip': if (confirm('Board this ship? Piracy makes you wanted.')) net.action('board', { targetId: el.dataset.id }); return;
      case 'leaveConvoy': return net.action('convoy_leave');
      case 'ashore': return this.toggleAshore();
      case 'castoff': return a.castOff();
    }
  }
  /** Live previews for quantity boxes and the fuel slider (no re-render). */
  sheetInput(i) {
    if (!i || !i.dataset) return;
    if (i.id === 'fuelSlider') {
      const v = +i.value || 0, price = +i.dataset.price || 0, cap = +i.dataset.cap || 1, have = +i.dataset.have || 0;
      const max = +i.max || 1; i.style.setProperty('--pct', `${Math.round((v / max) * 100)}%`);
      setText($('fuelQty'), `+${v.toFixed(cap < 10 ? 1 : 0)} t`); setText($('fuelCost'), `${fmt(v * price)} cr`);
      const add = $('fuelAdd'); if (add) { add.style.left = `${Math.round(clamp01(have / cap) * 100)}%`; add.style.width = `${Math.round(clamp01(v / cap) * 100)}%`; }
      return;
    }
    const g = i.dataset.qty; if (!g || g.startsWith('__')) return;
    const note = $('harborWrap').querySelector(`[data-cost="${CSS.escape(g)}"]`); if (!note) return;
    const q = Math.max(0, Math.floor(+i.value || 0)), p = +i.dataset.price || 0;
    setText(note, q > 0 ? `${fmt(q)} t ≈ ${fmt(q * p)} cr at today's price` : 'Enter a quantity');
  }

  // ---------------------------------------------------------------- ships list
  toggleShips() {
    const w = $('shipsWrap');
    if (!w.classList.contains('hidden')) return w.classList.add('hidden');
    this.closeOverlays(); w.classList.remove('hidden'); this.hydrateIcons(w); this.renderShips();
  }
  renderShips() {
    const a = this.app, me = a.ship; if (!me) return;
    const body = $('shipsList'); const scroll = body.parentElement?.scrollTop || 0;
    const km = (d) => `${((d * GEO.SCALE) / 1000).toFixed(1)} km`;
    const rows = [...a.others.values()].map((o) => ({ o, d: unitsBetween(me.lat, me.lon, o.cur.lat, o.cur.lon) })).sort((x, y) => x.d - y.d);
    const ai = collectAi(a).map((s) => ({ s, d: unitsBetween(me.lat, me.lon, s.lat, s.lon) })).sort((x, y) => x.d - y.d).slice(0, 60);
    setText($('shipsSub'), `${rows.length} skipper${rows.length === 1 ? '' : 's'} online · ${ai.length} AIS contact${ai.length === 1 ? '' : 's'} within 40 km`);
    const etaTxt = (s) => (s.eta ? fmtClock(s.eta > 1e11 ? s.eta / 1000 : s.eta) + ' UTC' : '—');
    let html = `<div class="secHead"><div><h2>${ic('users')}Skippers</h2></div></div>`;
    html += rows.length ? `<div class="cards wide">${rows.map(({ o, d }) => `<article class="card vesselCard">${this.thumbHTML(o.cls, { w: 264, h: 192, angle: 'quarter', wear: 1 - (o.cond ?? 100) / 100 })}
        <div class="vb"><b>${esc(o.name)}</b><small>${esc(SHIP_CLASSES[o.cls]?.name || o.cls)}${o.convoyId && o.convoyId === a.you?.convoyId ? ' · convoy' : ''}</small>
        <div class="vstats"><span>${km(d)}</span><span>${(o.cur.spd ?? 0).toFixed(1)} kn</span><span>${o.docked ? 'moored' : o.sinking ? 'SINKING' : o.offline ? 'crew sailing' : 'at sea'}</span></div>
        <div class="chips">${o.wanted ? '<span class="chip bad">wanted</span>' : ''}${o.convoyId && o.convoyId === a.you?.convoyId ? '<span class="chip">convoy</span>' : ''}</div>
        <div class="actRow">${this.playerActions(o.id)}</div></div></article>`).join('')}</div>`
      : `<div class="empty">${ic('users')}<span>No other skippers online right now. Share the link — everyone sails the same ocean.</span></div>`;
    if (a.you?.convoy) html += `<div class="card" style="margin-top:12px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">${ic('users')}<span>Your convoy: ${a.you.convoy.members.map((m) => esc(m.name)).join(', ')}</span><button data-act="leaveConvoy" style="margin-left:auto">Leave convoy</button></div>`;
    html += `<h3 class="subHead">${ic('radar')}Shipping traffic (AIS)</h3>`;
    html += ai.length ? `<div class="cards wide">${ai.map(({ s, d }) => `<article class="card vesselCard">${this.thumbHTML(SHIP_CLASSES[s.cls] ? s.cls : 'coaster', { w: 264, h: 192, angle: 'quarter' })}
        <div class="vb"><b>${esc(s.name)}${s.flag ? ` <span class="muted small">${esc(s.flag)}</span>` : ''}</b><small>${esc(SHIP_CLASSES[s.cls]?.name || s.cls || 'vessel')}</small>
        <div class="vstats"><span>${km(d)}</span><span>${(+s.spd || 0).toFixed(1)} kn</span></div>
        <small>${s.state === 'moored' ? 'moored' : s.state === 'anchored' ? 'at anchor' : `→ ${esc(short(s.destName || s.dest || '—'))} · ETA ${etaTxt(s)}`}</small></div></article>`).join('')}</div>`
      : `<div class="empty">${ic('radar')}<span>No AIS traffic within 40 km.</span></div>`;
    body.innerHTML = html;
    this.hydrateThumbs(body);
    if (body.parentElement) body.parentElement.scrollTop = scroll;
  }

  // ---------------------------------------------------------------- hail banner, prompts
  updateHail(you, now) {
    const el = $('hail');
    if (!you?.hail) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const left = Math.max(0, Math.ceil((you.hail.until - now) / 1000));
    let html;
    if (you.hail.state === 'hailed') html = `COAST GUARD: HEAVE TO<small>${esc(you.hail.cutter)} · slow below 2 kn · ${left} s</small>`;
    else if (you.hail.state === 'inspecting') html = `INSPECTION IN PROGRESS<small>${esc(you.hail.cutter)} is searching the holds</small>`;
    else html = `PURSUIT<small>${esc(you.hail.cutter)} is chasing you at 30 kn — outrun them or get caught</small>`;
    if (el.innerHTML !== html) el.innerHTML = html;
  }
  prompt(id, html, buttons) {
    const d = document.createElement('div'); d.className = 'prompt'; d.dataset.id = id; d.innerHTML = html + '<div class="inline"></div>';
    for (const b of buttons) { const btn = document.createElement('button'); btn.textContent = b.label; if (b.primary) btn.className = 'primary'; btn.onclick = () => { b.fn(); d.remove(); }; d.querySelector('.inline').appendChild(btn); }
    $('prompts').appendChild(d);
    setTimeout(() => d.remove(), 60000);
  }
}
