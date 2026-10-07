// HUD: top bar, telemetry, event log, radar, chart (delegated to Chart), harbour panel, ships list, hail banner, prompts,
// weather / fishing / rescue / berth / voyage / interior panels and the touch layout (docs/V3-CONTRACTS.md §7).
import { fmtDMS, bearing, unitsBetween, haversine, fmtDistance } from '/shared/geo.js';
import { GOODS, SHIP_CLASSES, GEO, SIM, INTERACT } from '/shared/constants.js';
import { fuelBurnPerSimHour } from '/shared/physics.js';
import { Chart, fetchJobs, cachedJobs, collectAi, collectRescues, collectStorms, fmtDur, fmtClock } from './chart.js';
import { isTouch, TouchHelm } from './touch.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pad2 = (n) => String(n).padStart(2, '0');
const RANGES_KM = [2, 5, 10, 20, 50, 100, 250, 1000];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CATS = ['working', 'cargo', 'passenger', 'motor yacht', 'sailing yacht'];
const NM = 1852;

export function fmtUTC(sec) {
  if (!(sec > 1e9)) return '—';
  const d = new Date(sec * 1000);
  return `${DAYS[d.getUTCDay()]} ${pad2(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}
/** Douglas sea state word from the significant wave height (m). */
export function seaStateWord(h) {
  return h < 0.1 ? 'calm' : h < 0.5 ? 'smooth' : h < 1.25 ? 'slight' : h < 2.5 ? 'moderate' : h < 4 ? 'rough' : h < 6 ? 'very rough' : h < 9 ? 'high' : h < 14 ? 'very high' : 'phenomenal';
}
export function beaufort(ms) { const t = [0.3, 1.6, 3.4, 5.5, 8, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7]; let b = 0; while (b < t.length && ms >= t[b]) b++; return b; }
/** Accept both the v0.2 compact weather ({windDir, windSpd, sea, storm, rain}) and the v0.3 extended shape. */
export function normWeather(w) {
  if (!w) return null;
  const wind = w.wind ? { spd: w.wind.spd ?? 0, dir: w.wind.dir ?? 0, gust: w.wind.gust } : { spd: w.windSpd ?? 0, dir: w.windDir ?? 0, gust: undefined };
  const waves = w.waves && Number.isFinite(w.waves.height) ? w.waves : { height: Math.round((w.sea ?? 0) * 6 * 10) / 10, dir: wind.dir, period: null };
  return { wind, waves, swell: w.swell || null, sea: w.sea ?? Math.min(1, waves.height / 6), storm: w.storm ?? 0, rain: w.rain ?? 0, visibility: w.visibility, pressure: w.pressure, temp: w.temp, cloud: w.cloud, source: w.source || 'synthetic' };
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
    this.touch = isTouch();
    this.interiorOn = false;
    this.rescueStart = null;
    this.chart = new Chart(app, $('chart'), $('chartInfo'));
    if (this.touch) document.body.classList.add('touch');
    this.bind();
    if (this.touch) this.bindTouchLayout();
  }
  bind() {
    const a = this.app;
    $('startBtn').onclick = () => a.start($('nameInput').value.trim());
    $('nameInput').onkeydown = (e) => { if (e.key === 'Enter') a.start($('nameInput').value.trim()); };
    try { $('nameInput').value = localStorage.getItem('saltline.name') || ''; } catch {}
    document.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => { const id = b.dataset.close; if (id === 'chartWrap') this.chart.close(); else $(id).classList.add('hidden'); }; });
    // A clicked button would otherwise keep keyboard focus, and Space ('all stop') would re-fire it.
    document.addEventListener('click', (e) => { const b = e.target.closest?.('button'); if (b) b.blur(); });
    const hw = $('harborWrap');
    hw.addEventListener('click', (e) => {
      if (!e.target.closest?.('button')) return;
      const ae = document.activeElement; // clicking any harbour button ends text entry in the panel (Safari keeps inputs focused)
      if (ae && ae !== document.body && hw.contains(ae)) ae.blur();
      if (this.harborDirty) this.renderHarborTabs();
    });
    hw.addEventListener('focusout', (e) => { if (this.harborDirty && !(e.relatedTarget && hw.contains(e.relatedTarget))) this.renderHarborTabs(); });
    const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
    on('btnDock', () => a.toggleDock());
    on('btnCastOff', () => a.castOff());
    on('btnUndock', () => a.castOff());
    on('btnChart', () => this.toggleChart());
    on('btnShips', () => this.toggleShips());
    on('btnFish', () => a.net.action('fish', { on: !a.you?.fishing }));
    on('btnPatch', () => a.net.action('patch'));
    on('btnAuto', () => a.toggleAutopilot());
    on('btnTow', () => { if (confirm('Call a tow to the nearest harbour? It costs money and ends the voyage.')) a.net.action('tow'); });
    on('btnHelp', () => $('helpWrap').classList.toggle('hidden'));
    on('btnInterior', () => this.toggleInterior());
    on('btnDeck', () => this.toggleInterior());
    on('btnCamera', () => this.cycleCamera());
    on('btnSails', () => { const up = a.you?.sailsUp !== false; a.net.action('sails', { up: !up }); });
    on('btnWeather', () => this.toggleWeather());
    on('weatherClose', () => $('weatherPanel').classList.add('hidden'));
    on('btnMore', () => $('moreSheet')?.classList.toggle('open'));
    on('btnMoor', () => a.toggleDock());
    on('btnTugs', () => { const c = this.tugCost(); if (confirm(`Request tug assistance for ${fmt(c)} cr? The tugs bring you alongside the nearest berth.`)) a.net.action('tug_assist'); });
    on('telToggle', () => $('telemetry').classList.toggle('collapsed'));
    on('radarHU', () => { this.headingUp = !this.headingUp; $('radarHU').textContent = this.headingUp ? 'H↑' : 'N↑'; $('radarHU').classList.toggle('on', this.headingUp); });
    document.querySelectorAll('#radarCtl button[data-r]').forEach((b) => { b.onclick = () => { this.rangeIdx = Math.max(0, Math.min(RANGES_KM.length - 1, this.rangeIdx + (b.dataset.r === '+' ? 1 : -1))); $('radarRange').textContent = RANGES_KM[this.rangeIdx] + ' km'; }; });
    document.querySelectorAll('.tabs button').forEach((b) => { b.onclick = () => this.showTab(b.dataset.tab); });
    $('chatInput').onkeydown = (e) => {
      if (e.key === 'Enter') { const t = $('chatInput').value.trim(); if (t) a.net.chat(t); $('chatInput').value = ''; $('chatInput').blur(); }
      if (e.key === 'Escape') $('chatInput').blur();
      e.stopPropagation();
    };
  }
  /** body.touch: secondary buttons move into the "More…" sheet; the TouchHelm drives the input state. */
  bindTouchLayout() {
    const a = this.app;
    const sheet = $('moreSheet');
    if (sheet) for (const id of ['btnFish', 'btnPatch', 'btnAuto', 'btnSails', 'btnWeather', 'btnTow', 'btnHelp', 'btnCastOff']) { const b = $(id); if (b) sheet.appendChild(b); }
    sheet?.addEventListener('click', (e) => { if (e.target.closest('button')) sheet.classList.remove('open'); });
    $('telemetry')?.classList.add('collapsed');
    const root = $('touchHelm');
    if (root) {
      this.touchHelm = new TouchHelm(root, {
        buttons: ['stop', 'auto'],
        onThrottle: (v) => { if (a.you?.docked) { this.touchHelm.setThrottle(0); return; } a.input.throttleCmd = v; },
        onRudder: (v, active) => { if (a.you?.docked) return; a.input.rudderCmd = v; if (active && Math.abs(v) > 0.05) a.autopilot = false; },
        onAllStop: () => { a.input.throttleCmd = 0; a.input.rudderCmd = 0; a.autopilot = false; },
        onAction: (name) => this.action(name),
      });
    }
  }
  action(name) {
    const a = this.app;
    switch (name) {
      case 'dock': return a.toggleDock();
      case 'chart': return this.toggleChart();
      case 'ships': return this.toggleShips();
      case 'interior': return this.toggleInterior();
      case 'camera': return this.cycleCamera();
      case 'auto': return a.toggleAutopilot();
      case 'more': return $('moreSheet')?.classList.toggle('open');
    }
  }
  toggleInterior() {
    const a = this.app;
    if (typeof a.toggleInterior === 'function') return a.toggleInterior();
    if (a.interior) { if (a.interior.active) a.interior.exit(); else a.interior.enter(); this.showInterior(!!a.interior.active); }
  }
  cycleCamera() { const a = this.app; if (typeof a.cycleCamera === 'function') a.cycleCamera(); else if (a.cam) a.cam.mode = (a.cam.mode + 1) % 3; }

  setStatus(t) { $('connStatus').textContent = t; }
  /** Connection pill in the HUD top bar: 'connected' | 'disconnected' | 'replaced'. */
  setConn(s) {
    const el = $('connPill'); if (!el) return;
    el.classList.toggle('hidden', s === 'connected');
    el.textContent = s === 'replaced' ? 'offline — logged in elsewhere' : 'offline — reconnecting';
  }
  showWelcome(show) { $('welcome').classList.toggle('hidden', !show); $('hud').classList.toggle('hidden', show); }
  anyOverlayOpen() { return ['chartWrap', 'harborWrap', 'shipsWrap', 'helpWrap'].some((id) => !$(id).classList.contains('hidden')); }
  transientOpen() { return ['chartWrap', 'shipsWrap', 'helpWrap'].some((id) => !$(id).classList.contains('hidden')); }
  closeOverlays() { this.chart.close(); for (const id of ['shipsWrap', 'helpWrap']) $(id).classList.add('hidden'); $('moreSheet')?.classList.remove('open'); }

  // ---------------------------------------------------------------- log / chat / alerts
  event(ev) {
    const d = document.createElement('div');
    d.className = `ev ${ev.kind || 'info'}`; d.textContent = ev.text;
    $('log').appendChild(d);
    this.logEntries.push({ el: d, t: performance.now() });
    while (this.logEntries.length > 8) this.logEntries.shift().el.remove();
  }
  tickLog(now) { for (const e of [...this.logEntries]) if (now - e.t > 25000) { e.el.remove(); this.logEntries.shift(); } }
  chat(m) {
    const d = document.createElement('div');
    d.innerHTML = `<b></b> `; d.querySelector('b').textContent = m.from + ':'; d.append(document.createTextNode(m.text));
    $('chat').prepend(d);
    while ($('chat').children.length > 40) $('chat').lastChild.remove();
  }
  alert(id, text, cls = '') {
    let el = document.querySelector(`#alerts [data-id="${id}"]`);
    if (!el) { el = document.createElement('div'); el.dataset.id = id; $('alerts').appendChild(el); }
    el.className = `alert ${cls}`; el.textContent = text;
  }
  clearAlert(id) { document.querySelector(`#alerts [data-id="${id}"]`)?.remove(); }

  // ---------------------------------------------------------------- top + telemetry
  updateTop(you, snap, onlineCount, latency) {
    if (!you) return;
    const C = SHIP_CLASSES[you.ship.cls] || SHIP_CLASSES.coaster;
    $('hbName').textContent = `${you.name} · ${C.name}`;
    $('hbMoney').textContent = fmt(you.money) + ' cr';
    const range = this.rangeNm(you);
    $('hbFuel').textContent = `${you.fuel.toFixed(C.fuelCap < 10 ? 2 : 1)} / ${C.fuelCap} t${range != null ? ` · ${range >= 100 ? range.toFixed(0) : range.toFixed(1)} nm` : ''}`;
    $('hbFuel').style.color = you.fuel < C.fuelCap * 0.1 ? 'var(--red)' : '';
    $('hbCond').textContent = `${Math.round(you.cond)} %`;
    $('hbCond').style.color = you.cond < 30 ? 'var(--red)' : you.cond < 60 ? 'var(--accent)' : '';
    const mass = you.cargo.reduce((s, c) => s + c.qty, 0);
    const contra = you.cargo.some((c) => c.contraband);
    $('hbCargo').textContent = `${Math.round(mass)} / ${C.capacity} t${contra ? ' ⚠' : ''}`;
    $('hbCargo').style.color = contra ? '#b07cff' : '';
    $('hbWanted').textContent = you.wanted ? '★'.repeat(you.wanted) : 'clean';
    $('hbWanted').style.color = you.wanted ? 'var(--red)' : '';
    const simTime = snap?.simTime ?? this.app.simTime;
    $('hbClock').textContent = fmtUTC(simTime);
    if (snap?.wind) $('hbWind').textContent = `${Math.round(snap.wind.dir)}° ${(+snap.wind.spd).toFixed(0)} m/s`;
    $('hbPing').textContent = latency + ' ms';
    $('hbOnline').textContent = `${onlineCount} online`;
    $('btnFish').classList.toggle('on', !!you.fishing);
    $('btnPatch').textContent = `Kit (K) ×${you.kits || 0}`;
    const moored = !!you.docked;
    $('btnDock').textContent = moored ? (this.harborOpen() ? 'Cast off (T)' : 'Harbour (T)') : you.nearBerth && you.nearBerth.distM <= (INTERACT.BERTH_RANGE_U || 60) ? 'Moor (T)' : 'Dock (T)';
    $('btnCastOff').classList.toggle('hidden', !moored);
    $('btnTow').classList.toggle('hidden', moored);
    $('btnInterior')?.classList.toggle('on', !!this.interiorOn);
    this.setSailsButton(!!C.sail, you.sailsUp !== false);
    // panels that follow `you` even when main.js does not call them explicitly
    this.showFishing(you.fishing ? you.fishInfo || { ground: '—', rate: 0, caught: 0, tooFast: false } : null);
    this.showRescue(you.rescue || null);
    this.showBerth(you.nearBerth || null, you.berth || null, you.assist || null, this.tugCost());
    if (!$('weatherPanel').classList.contains('hidden')) this.showWeather(you.weather, you.tide);
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
    $('tSog').textContent = Math.abs(ship.spd).toFixed(1);
    $('tHdg').textContent = String(Math.round(ship.hdg) % 360).padStart(3, '0');
    $('tLat').textContent = fmtDMS(ship.lat, true); $('tLon').textContent = fmtDMS(ship.lon, false);
    const tide = info.tide || you?.tide || null;
    $('tDepth').textContent = info.depth == null ? '—' : info.depth > 199 ? '>200' : info.depth.toFixed(1);
    $('tDepth').parentElement.style.color = info.depth != null && info.depth < info.draft + 3 ? 'var(--red)' : '';
    $('tCur').textContent = info.current ? `${String(Math.round(info.current.set)).padStart(3, '0')}° ${info.current.drift.toFixed(1)} kn` : '—';
    const thrCmd = this.app.input?.throttleCmd ?? ship.throttleCmd ?? ship.throttle;
    $('tThr').textContent = Math.round(thrCmd * 100) + '%'; $('tRud').textContent = ship.rudder > 0.05 ? `S${Math.round(ship.rudder * 35)}` : ship.rudder < -0.05 ? `P${Math.round(-ship.rudder * 35)}` : '0';
    if (you) {
      const range = this.rangeNm(you);
      $('tFuel').textContent = `${you.fuel.toFixed(C.fuelCap < 10 ? 2 : 1)} t`; $('tFuel').style.color = you.fuel < C.fuelCap * 0.1 ? 'var(--red)' : '';
      $('tRange').textContent = range == null ? '—' : range === Infinity ? '∞ (sail)' : `${range >= 100 ? range.toFixed(0) : range.toFixed(1)} nm`;
      const wx = normWeather(info.weather || you.weather);
      if (wx) {
        $('tWind').textContent = `${String(Math.round(wx.wind.dir)).padStart(3, '0')}° ${wx.wind.spd.toFixed(0)} m/s${wx.wind.gust ? ` g${wx.wind.gust.toFixed(0)}` : ''}`;
        $('tSea').textContent = `${seaStateWord(wx.waves.height)} ${wx.waves.height.toFixed(1)} m`;
        $('tSea').style.color = wx.storm > 0.5 ? 'var(--red)' : wx.storm > 0.2 ? 'var(--accent)' : '';
      }
    }
    if (tide && Number.isFinite(tide.height)) { $('tTide').textContent = `${tide.height >= 0 ? '+' : ''}${tide.height.toFixed(1)} m ${tide.state === 'flood' ? '↑' : '↓'}${tide.rate != null ? ` ${Math.abs(tide.rate).toFixed(1)} m/h` : ''}`; }
    else $('tTide').textContent = '—';
    $('tFlood').textContent = Math.round(info.flooding * 100) + '%'; $('tFlood').style.color = info.flooding > 0.05 ? 'var(--red)' : '';
    $('tNear').textContent = info.nearest ? `${info.nearest.dist} ${info.nearest.name.split(' (')[0]}` : '—'; // distance first: a long name truncates, not the range
    $('tWp').textContent = info.wp ? `${info.wp.dist} ${String(Math.round(info.wp.brg)).padStart(3, '0')}°${info.autopilot ? ' AP' : ''}` : 'none';
    $('tEta').textContent = info.wp ? info.wp.eta : '—';
    $('tJobs').textContent = info.jobs; $('tStatus').textContent = info.status;
    const thr = ship.throttle; $('barThr').style.width = Math.max(0, thr) * 100 + '%'; $('barThr').style.background = thr < 0 ? 'var(--accent)' : 'var(--green)';
    $('barRud').style.left = ship.rudder >= 0 ? '50%' : 50 + ship.rudder * 50 + '%'; $('barRud').style.width = Math.abs(ship.rudder) * 50 + '%';
    $('btnAuto').classList.toggle('on', !!info.autopilot);
    if (this.touchHelm) { this.touchHelm.setThrottle(thrCmd); if (info.autopilot) this.touchHelm.setRudder(this.app.input?.rudderCmd ?? ship.rudder); }
  }

  // ---------------------------------------------------------------- new v0.3 panels
  openChart() { if (!this.chart.isOpen()) this.toggleChart(); }
  showFishing(info) {
    const el = $('fishPanel'); if (!el) return;
    if (!info) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    $('fishGround').textContent = info.ground || '—';
    $('fishRate').textContent = `${(info.rate || 0).toFixed(1)} t/h`;
    $('fishCaught').textContent = `${Math.round(info.caught || 0)} t`;
    const w = $('fishWarn'); w.classList.toggle('hidden', !info.tooFast); w.textContent = info.tooFast ? 'Too fast — slow under 3 kn' : '';
  }
  toggleWeather() { const p = $('weatherPanel'); p.classList.toggle('hidden'); if (!p.classList.contains('hidden')) this.showWeather(this.app.you?.weather, this.app.you?.tide); }
  showWeather(wxRaw, tide) {
    const el = $('weatherBody'); if (!el) return;
    const wx = normWeather(wxRaw);
    const now = this.app.simTime || Date.now() / 1000;
    const rows = [];
    if (wx) {
      rows.push(['Wind', `${String(Math.round(wx.wind.dir)).padStart(3, '0')}° ${wx.wind.spd.toFixed(1)} m/s · F${beaufort(wx.wind.spd)}${wx.wind.gust ? ` · gusts ${wx.wind.gust.toFixed(0)} m/s` : ''}`]);
      rows.push(['Sea state', `${seaStateWord(wx.waves.height)} · ${wx.waves.height.toFixed(1)} m${wx.waves.period ? ` / ${wx.waves.period.toFixed(0)} s` : ''}${wx.waves.dir != null ? ` from ${String(Math.round(wx.waves.dir)).padStart(3, '0')}°` : ''}`]);
      if (wx.swell && Number.isFinite(wx.swell.height)) rows.push(['Swell', `${wx.swell.height.toFixed(1)} m${wx.swell.period ? ` / ${wx.swell.period.toFixed(0)} s` : ''}${wx.swell.dir != null ? ` from ${String(Math.round(wx.swell.dir)).padStart(3, '0')}°` : ''}`]);
      if (Number.isFinite(wx.visibility)) rows.push(['Visibility', wx.visibility >= 10000 ? `good · ${(wx.visibility / 1000).toFixed(0)} km` : wx.visibility >= 4000 ? `moderate · ${(wx.visibility / 1000).toFixed(1)} km` : wx.visibility >= 1000 ? `poor · ${(wx.visibility / 1000).toFixed(1)} km` : `fog · ${Math.round(wx.visibility)} m`]);
      if (Number.isFinite(wx.pressure)) rows.push(['Pressure', `${wx.pressure.toFixed(0)} hPa`]);
      if (Number.isFinite(wx.temp)) rows.push(['Air', `${wx.temp.toFixed(0)} °C${Number.isFinite(wx.cloud) ? ` · cloud ${Math.round(wx.cloud * 100)} %` : ''}`]);
      if (wx.rain > 0.05 || wx.storm > 0.1) rows.push(['Weather', `${wx.storm > 0.6 ? 'STORM' : wx.storm > 0.2 ? 'gale' : 'showers'} · rain ${Math.round(wx.rain * 100)} %`]);
    } else rows.push(['Weather', 'no data yet']);
    if (tide && Number.isFinite(tide.height)) {
      rows.push(['Tide', `${tide.height >= 0 ? '+' : ''}${tide.height.toFixed(2)} m · ${tide.state === 'flood' ? 'rising' : 'falling'} ${Math.abs(tide.rate ?? 0).toFixed(2)} m/h${Number.isFinite(tide.range) ? ` · range ${tide.range.toFixed(1)} m` : ''}`]);
      if (tide.nextHigh) rows.push(['Next', `HW ${fmtClock(tide.nextHigh)} (${fmtDur(tide.nextHigh - now)}) · LW ${fmtClock(tide.nextLow)} (${fmtDur(tide.nextLow - now)})`]);
      if (tide.stream) { const kn = Math.hypot(tide.stream.u, tide.stream.v) / GEO.KN_TO_MS; const set = ((Math.atan2(tide.stream.u, tide.stream.v) * 180) / Math.PI + 360) % 360; rows.push(['Stream', kn > 0.05 ? `${kn.toFixed(1)} kn setting ${String(Math.round(set)).padStart(3, '0')}°` : 'slack']); }
    }
    rows.push(['Source', wx?.source === 'open-meteo' ? 'Open-Meteo live observation' : 'simulated']);
    el.innerHTML = `<table>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`).join('')}</table>`;
  }
  showRescue(r) {
    const el = $('rescueWrap'); if (!el) return;
    if (!r) { el.classList.add('hidden'); this.rescueStart = null; return; }
    el.classList.remove('hidden');
    const now = Date.now() + (this.app.clockOffset || 0);
    if (!this.rescueStart || this.rescueStart.id !== r.id) this.rescueStart = { id: r.id, t: now };
    const from = this.app.world?.harbors?.find((h) => h.id === r.harbor)?.name?.split(' (')[0] || 'the coast';
    const left = Math.max(0, (r.eta - now) / 1000), total = Math.max(1, (r.eta - this.rescueStart.t) / 1000);
    $('rescueText').textContent = `You are in the life raft — ${r.kind === 'helicopter' ? 'SAR helicopter' : 'lifeboat'} from ${from}, ETA ${pad2(Math.floor(left / 60))}:${pad2(Math.floor(left % 60))}`;
    $('rescueBar').style.width = `${Math.round((1 - Math.min(1, left / total)) * 100)}%`;
  }
  showBerth(nearBerth, berth, assist, tugCost) {
    const el = $('berthLine'); if (!el) return;
    const you = this.app.you, s = this.app.ship;
    const txt = $('berthText'), moor = $('btnMoor'), tugs = $('btnTugs');
    if (assist) { el.classList.remove('hidden'); txt.textContent = `Tugs bringing you alongside ${assist.berthId ? 'berth ' + String(assist.berthId).split('-b')[1] : 'the berth'}…`; moor.classList.add('hidden'); tugs.classList.add('hidden'); return; }
    if (berth) { el.classList.remove('hidden'); txt.textContent = `Moored at ${berth.name || berth.id} · Cast off (T)`; moor.classList.add('hidden'); tugs.classList.add('hidden'); return; }
    if (!nearBerth || you?.docked) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const spd = s ? Math.abs(s.spd) : 99;
    const inRange = nearBerth.distM <= (INTERACT.BERTH_RANGE_U || 60) && spd <= 2, tugRange = nearBerth.distM <= (INTERACT.TUG_RANGE_U || 1500) && spd <= 6;
    txt.textContent = `${nearBerth.name || nearBerth.id} · ${nearBerth.distM >= 1000 ? (nearBerth.distM / 1000).toFixed(1) + ' km' : Math.round(nearBerth.distM) + ' m'} · ${String(Math.round(nearBerth.brg ?? 0)).padStart(3, '0')}° · depth ${Number.isFinite(nearBerth.depth) ? nearBerth.depth.toFixed(0) + ' m' : '—'}${Number.isFinite(nearBerth.length) ? ` · ${Math.round(nearBerth.length)} m` : ''}`;
    moor.classList.remove('hidden'); moor.disabled = !inRange; moor.title = inRange ? 'Make fast at this berth' : 'Within 60 m and under 2 kn';
    tugs.classList.remove('hidden'); tugs.disabled = !tugRange || !!you?.hail; tugs.textContent = `Request tugs (${fmt(tugCost)} cr)`; tugs.title = tugRange ? 'Tugs take you alongside in 45 s' : 'Within 1.5 km of the harbour, under 6 kn';
  }
  showVoyage(route, etaSec, expressCost) {
    const el = $('voyageLine'); if (!el) return;
    const a = this.app, pts = route || [];
    if (!pts.length) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    el.classList.remove('hidden');
    const last = pts[pts.length - 1];
    const s = a.ship; let nm = 0, prev = s ? { lat: s.lat, lon: s.lon } : null;
    for (const p of pts) { if (prev) nm += haversine(prev.lat, prev.lon, p.lat, p.lon) / NM; prev = p; }
    const cost = Number.isFinite(expressCost) ? expressCost : Math.round(nm * SIM.EXPRESS_CR_PER_NM);
    el.innerHTML = `<span>${pts.length} wp · ${nm.toFixed(1)} nm · ETA ${esc(fmtDur(etaSec))}${a.autopilot ? ' <span class="pill good">autopilot</span>' : ''}</span>
      <button id="voySail" class="primary">Sail route</button><button id="voyExpress">Express passage ${fmt(cost)} cr</button><button id="voySet">Set voyage</button>`;
    $('voySail').onclick = () => this.chart.sailRoute();
    $('voyExpress').onclick = () => { if (a.you?.docked) return this.event({ kind: 'warn', text: 'Cast off first — express passages start at sea.' }); if (confirm(`Express passage to the last waypoint: ${fmt(cost)} cr plus the fuel and wear of the leg. Go?`)) a.net.action('express', { lat: last.lat, lon: last.lon }); };
    $('voySet').onclick = () => { a.net.action('set_voyage', { lat: last.lat, lon: last.lon, throttle: 0.7 }); this.event({ kind: 'info', text: 'Voyage set: the crew keeps sailing to the last waypoint while you are away.' }); };
  }
  showInterior(on) {
    this.interiorOn = !!on;
    document.body.classList.toggle('interior', !!on);
    $('interiorHud')?.classList.toggle('hidden', !on);
    $('btnInterior')?.classList.toggle('on', !!on);
    if (this.touchHelm) { this.touchHelm.setHelmVisible(!on); this.touchHelm.showStick(!!on); }
  }
  setInteriorHint(text) { const el = $('interiorHint'); if (el) el.textContent = text || ''; }
  setSailsButton(isSail, up) {
    const b = $('btnSails'); if (!b) return;
    b.classList.toggle('hidden', !isSail);
    b.textContent = up ? 'Sails: set' : 'Sails: furled';
    b.classList.toggle('on', !!up);
  }

  // ---------------------------------------------------------------- radar
  drawRadar(me, contacts, now) {
    const cv = $('radar'), ctx = cv.getContext('2d');
    const css = cv.clientWidth || 260, dpr = Math.min(3, window.devicePixelRatio || 1);
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
    ctx.strokeStyle = 'rgba(90,214,255,0.18)'; ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i++) { ctx.beginPath(); ctx.arc(0, 0, ((R - 6) * i) / 3, 0, Math.PI * 2); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(0, -R + 6); ctx.lineTo(0, R - 6); ctx.moveTo(-R + 6, 0); ctx.lineTo(R - 6, 0); ctx.stroke();
    // sweep
    const sw = ((now / 2500) % 1) * Math.PI * 2;
    const grad = ctx.createConicGradient ? ctx.createConicGradient(sw - Math.PI / 2, 0, 0) : null;
    if (grad) { grad.addColorStop(0, 'rgba(90,214,255,0.0)'); grad.addColorStop(0.85, 'rgba(90,214,255,0.0)'); grad.addColorStop(1, 'rgba(90,214,255,0.25)'); ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(0, 0, R - 6, 0, Math.PI * 2); ctx.fill(); }
    // north mark when heading-up, heading line when north-up
    const h = ((me.hdg + rot) * Math.PI) / 180;
    ctx.strokeStyle = 'rgba(242,177,52,0.8)'; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.sin(h) * (R - 6), -Math.cos(h) * (R - 6)); ctx.stroke();
    if (this.headingUp) { const n = (rot * Math.PI) / 180; ctx.fillStyle = '#9ad7ff'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('N', Math.sin(n) * (R - 14), -Math.cos(n) * (R - 14)); }
    const small = W < 200;
    ctx.font = (small ? '9px' : '10px') + ' monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
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

  // ---------------------------------------------------------------- harbour panel
  showHarbor(h) {
    this.harborData = h;
    $('hName').textContent = h.name; $('hSub').textContent = `${h.country} · ${h.size} port · fuel ${fmt(h.fuelPrice)} cr/t${this.app.you?.berth ? ` · ${this.app.you.berth.name || this.app.you.berth.id}` : ''}`;
    this.closeOverlays(); $('harborWrap').classList.remove('hidden');
    this.renderHarborTabs();
  }
  hideHarbor() { $('harborWrap').classList.add('hidden'); }
  harborOpen() { return !$('harborWrap').classList.contains('hidden'); }
  showTab(t) { this.harborTab = t; document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t)); document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('hidden', el.id !== 'tab-' + t)); if (t === 'boards') this.renderBoards(); }
  deadline(j) { const dl = (j.deadline - (this.app.simTime || Date.now() / 1000)); return dl < 0 ? 'expired' : dl < 48 * 3600 ? `${Math.floor(dl / 3600)} h` : `${Math.floor(dl / 86400)} d`; }
  payPerT(j) { return j.qty ? fmt(j.pay / j.qty) : j.pax ? fmt(j.pay / j.pax) + '/pax' : '—'; }
  /** Why the current ship cannot take a contract, or null. */
  whyNot(j, you, C, mass) {
    if (j.needsCat && !j.needsCat.includes(C.cat)) return `needs ${j.needsCat.includes('passenger') ? 'a yacht or ferry' : 'a yacht'}`;
    if (j.type === 'passengers' || j.type === 'charter') { const used = you.jobs.filter((x) => x.pax).reduce((s, x) => s + x.pax, 0); if (used + (j.pax || 0) > C.pax) return `needs ${j.pax} berths (${Math.max(0, C.pax - used)} free)`; return null; }
    if (j.type === 'fishing') { if (!(C.fishRate > 0)) return 'this hull cannot fish'; if (j.qty > C.capacity) return `hold too small for ${j.qty} t`; return null; }
    if (j.type === 'tow') return null;
    if (j.qty && mass + j.qty > C.capacity) return `needs ${j.qty} t of hold (${Math.max(0, Math.round(C.capacity - mass))} t free)`;
    return null;
  }
  renderHarborTabs() {
    const h = this.harborData, you = this.app.you, net = this.app.net; if (!h || !you) return;
    const root = $('harborWrap'), ae = document.activeElement;
    // Never rebuild the panel under the player's fingers: a focused quantity box would lose its value and focus
    // (and the next keystrokes would become hotkeys). Mark it dirty; the click/focusout handlers catch up.
    if (ae && ae.tagName === 'INPUT' && root.contains(ae)) { this.harborDirty = true; return; }
    this.harborDirty = false;
    const qty = {}; root.querySelectorAll('[data-qty]').forEach((i) => { qty[i.dataset.qty] = i.value; }); // typed quantities survive the rebuild
    const C = SHIP_CLASSES[you.ship.cls] || SHIP_CLASSES.coaster;
    const mass = you.cargo.reduce((s, c) => s + c.qty, 0);
    const hname = (id) => this.app.world.harbors.find((x) => x.id === id)?.name || id;
    const pill = (j, shady) => `<span class="pill ${shady || j.contraband ? 'bad' : j.type === 'fishing' ? 'good' : j.type === 'charter' || j.type === 'passengers' ? 'pax' : ''}">${esc(j.type)}</span>`;
    const jobRow = (j, shady) => {
      const why = this.whyNot(j, you, C, mass);
      const needs = j.needsCat ? ` <span class="pill ${j.needsCat.includes(C.cat) ? '' : 'bad'}">needs yacht or ferry</span>` : '';
      return `<tr><td>${pill(j, shady)}${esc(j.title)}${needs}${why ? `<div class="muted small">${esc(why)}</div>` : ''}</td><td class="num">${j.distKm ? j.distKm + ' km' : '—'}</td><td class="num">${this.deadline(j)}</td><td class="num"><b>${fmt(j.pay)}</b><div class="muted small">${this.payPerT(j)}/t</div></td><td><button data-job="${esc(j.id)}" ${why ? `disabled title="${esc(why)}"` : ''}>Accept</button></td></tr>`;
    };
    const mine = you.jobs;
    $('tab-jobs').innerHTML = `<p class="muted">Deliveries complete automatically when you dock at the destination. Hold ${Math.round(mass)}/${C.capacity} t · berths ${C.pax}.</p>
      <table><tr><th>Contract</th><th class="num">Dist</th><th class="num">Deadline</th><th class="num">Pay (cr)</th><th></th></tr>${h.jobs.map((j) => jobRow(j, false)).join('')}</table>
      <h4 style="margin:14px 0 4px">Your contracts${mine.length ? ` · ${fmt(mine.reduce((s, j) => s + j.pay, 0))} cr outstanding` : ''}</h4>${mine.length ? `<table><tr><th>Contract</th><th>To</th><th class="num">Deadline</th><th class="num">Pay</th><th></th></tr>${mine.map((j) => `<tr><td>${pill(j, j.contraband)}${esc(j.title)}</td><td>${esc(hname(j.to).split(' (')[0])}</td><td class="num">${this.deadline(j)}</td><td class="num">${fmt(j.pay)}</td><td><button data-abandon="${esc(j.id)}">Abandon</button></td></tr>`).join('')}</table>` : '<p class="muted">None.</p>'}`;
    // fuel & yard + service
    const fuelNeed = Math.max(0, C.fuelCap - you.fuel);
    const hullBasis = Math.max(120000, C.price);
    const servicePrice = Number.isFinite(h.servicePrice) ? h.servicePrice : Math.round(hullBasis * 0.01);
    const due = you.serviceDue;
    const dueTxt = due == null ? 'not yet tracked' : due > 1e9 ? (due - (this.app.simTime || Date.now() / 1000) > 0 ? `due in ${Math.ceil((due - this.app.simTime) / 86400)} d` : `overdue by ${Math.ceil((this.app.simTime - due) / 86400)} d`) : due > 0 ? `due in ${Math.ceil(due)} d` : 'overdue';
    const fees = h.fees ? `<p class="muted small">Port dues ${fmt(h.fees.dues)} cr · berth ${fmt(h.fees.berthPerDay)} cr per started day${h.fees.pilotage ? ` · pilotage ${fmt(h.fees.pilotage)} cr` : ''}</p>` : '';
    $('tab-services').innerHTML = `<div class="grid">
      <div class="box"><h4>Fuel dock</h4><p>Bunker fuel <b>${fmt(h.fuelPrice)} cr/t</b>. Tank ${you.fuel.toFixed(C.fuelCap < 10 ? 2 : 1)} / ${C.fuelCap} t.</p>
        <div class="inline"><button data-fuel="${fuelNeed}">Fill up (${fmt(fuelNeed * h.fuelPrice)} cr)</button><button data-fuel="${Math.min(fuelNeed, 10)}">+10 t</button><button data-fuel="${Math.min(fuelNeed, 25)}">+25 t</button></div></div>
      <div class="box"><h4>Repair yard</h4><p>Condition <b>${Math.round(you.cond)} %</b>${you.flooding > 0 ? ` · flooding ${Math.round(you.flooding * 100)} % (pumped out at the quay)` : ''}.</p>
        <div class="inline"><button data-repair="1" ${h.repairCost > 0 ? '' : 'disabled'}>Overhaul (${fmt(h.repairCost)} cr)</button><button data-kit="1">Damage-control kit (2,500 cr) · have ${you.kits || 0}</button></div>
        <p class="muted small">Service (1 % of hull · ${fmt(servicePrice)} cr) — ${dueTxt}. Without a service every 30 days of sailing the wear rate climbs up to +60 %.</p>
        <div class="inline"><button data-service="1">Service (${fmt(servicePrice)} cr)</button></div>${fees}</div>
      <div class="box"><h4>Cargo aboard</h4>${you.cargo.length ? `<table>${you.cargo.map((c) => `<tr><td>${GOODS[c.good]?.name || esc(c.good)}${c.contraband ? ' <span class="pill bad">contraband</span>' : ''}${c.jobId ? ' <span class="pill">contract</span>' : ''}${c.caught ? ' <span class="pill good">caught</span>' : ''}</td><td class="num">${c.qty} t</td><td><button data-dump="${esc(c.good)}">Dump</button></td></tr>`).join('')}</table>` : '<p class="muted">Empty hold.</p>'}</div>
    </div>`;
    // market with supply / demand
    const econ = h.econ || null;
    const trendArrow = (g) => { const t = econ?.trend?.[g]; return t > 0 ? '<span class="up">▲</span>' : t < 0 ? '<span class="down">▼</span>' : '<span class="muted">▬</span>'; };
    const impact = (g) => { const st = econ?.stock?.[g]; if (!(st > 0)) return ''; const q = Math.min(st * 0.5, 100); const up = (Math.sqrt(st / Math.max(1, st - q)) - 1) * 100; return `<div class="muted small">+${up.toFixed(1)} % per ${Math.round(q)} t bought</div>`; };
    $('tab-market').innerHTML = `<p class="muted">Prices follow supply and demand: buying draws down the stock and raises the price, selling lowers it; stocks drift back toward normal over hours. Contract cargo cannot be sold.</p>
      <table><tr><th>Commodity</th><th class="num">Price cr/t</th>${econ ? '<th class="num">Stock</th>' : ''}<th class="num">Aboard</th><th>Trade</th></tr>${Object.entries(h.market).map(([g, p]) => { const have = you.cargo.filter((c) => c.good === g && !c.jobId).reduce((s, c) => s + c.qty, 0); return `<tr><td>${GOODS[g]?.name || esc(g)}${impact(g)}</td><td class="num">${fmt(p)} ${trendArrow(g)}</td>${econ ? `<td class="num">${econ.stock?.[g] != null ? fmt(econ.stock[g]) + ' t' : '—'}</td>` : ''}<td class="num">${have}</td><td class="inline"><input type="number" min="1" value="100" data-qty="${esc(g)}"><button data-buy="${esc(g)}">Buy</button><button data-sell="${esc(g)}" ${have ? '' : 'disabled'}>Sell</button></td></tr>`; }).join('')}</table>`;
    $('tab-shady').innerHTML = !h.contactLooked ? `<p>Wander the quays and see who wants to talk.</p><button data-look="1">Look around</button>` : h.contact ? `<p><b>${esc(h.contact.name)}</b> keeps their voice low. Illegal cargo pays five times the going rate — if the coast guard does not find it.</p><table>${h.contact.jobs.map((j) => jobRow(j, true)).join('')}</table>` : '<p class="muted">Nobody here wants to talk business today. Try another harbour.</p>';
    $('tab-players').innerHTML = h.dockedPlayers.length ? `<table>${h.dockedPlayers.map((p) => `<tr><td>${esc(p.name)}</td><td>${this.playerActions(p.id)}</td></tr>`).join('')}</table>` : '<p class="muted">No other skippers are docked here right now.</p>';
    // ship market: new by category, used, sell
    const tradeIn = Number.isFinite(h.tradeIn) ? h.tradeIn : h.shipyard?.[0]?.tradeIn ?? 0;
    const spec = (s) => { const c = s.specs || SHIP_CLASSES[s.id] || {}; return `${c.length} × ${c.beam} m · draft ${c.draft} m · ${c.maxKn} kn${c.sail || SHIP_CLASSES[s.id]?.sail ? ' (sail)' : ''} · ${c.capacity} t · ${c.pax} pax · fuel ${c.fuelCap} t · ${c.burn} t/h · crew ${c.crewCost} cr/h`; };
    const groups = CATS.map((cat) => ({ cat, ships: (h.shipyard || []).filter((s) => (s.cat || SHIP_CLASSES[s.id]?.cat) === cat) })).filter((g) => g.ships.length);
    const newRows = groups.map((g) => `<tr class="cat"><th colspan="4">${esc(g.cat)}</th></tr>${g.ships.map((s) => { const own = you.ship.cls === s.id; const net = s.price - tradeIn; return `<tr><td><b>${esc(s.name)}</b><br><span class="muted">${esc(s.desc || '')}</span></td><td class="small">${spec(s)}</td><td class="num">${fmt(s.price)}<div class="muted small">net ${fmt(net)}</div></td><td><button data-ship="${esc(s.id)}" ${own ? 'disabled' : ''}>${own ? 'Owned' : 'Buy'}</button></td></tr>`; }).join('')}`).join('');
    const usedRows = (h.used || []).map((u) => { const c = SHIP_CLASSES[u.cls]; return `<tr><td><b>${esc(u.name || c?.name || u.cls)}</b><br><span class="muted small">${c ? spec({ id: u.cls }) : ''}</span></td><td class="num">${u.cond} %</td><td class="num">${fmt(u.price)}<div class="muted small">net ${fmt(u.price - tradeIn)}</div></td><td><button data-used="${esc(u.id)}">Buy</button></td></tr>`; }).join('');
    $('tab-shipyard').innerHTML = `<div class="box"><h4>Your ship</h4><p><b>${esc(C.name)}</b> · ${Math.round(you.cond)} % · value <b>${fmt(tradeIn)} cr</b> (traded in when you buy, or sold outright).</p><div class="inline"><button data-sellship="1" class="danger">Sell current ship (${fmt(tradeIn)} cr)</button></div><p class="muted small">Selling without buying leaves you with a pilot boat to get around in.</p></div>
      <h4 style="margin:14px 0 4px">New hulls</h4><table class="yard"><tr><th>Class</th><th>Specs</th><th class="num">Price</th><th></th></tr>${newRows}</table>
      <h4 style="margin:14px 0 4px">Second-hand</h4>${usedRows ? `<table><tr><th>Hull</th><th class="num">Condition</th><th class="num">Price</th><th></th></tr>${usedRows}</table>` : '<p class="muted">No used hulls on offer right now; listings refresh every few hours.</p>'}`;
    // harbour info
    const berths = h.berths || [];
    const anchor = h.anchor || null;
    $('tab-info').innerHTML = `<div class="grid">
      <div class="box"><h4>Port</h4><p><b>${esc(h.name)}</b> · ${esc(h.country)} · ${esc(h.size)} port${you.berth ? `<br>You are moored at <b>${esc(you.berth.name || you.berth.id)}</b>.` : ''}</p>
        <p class="muted small">${anchor ? `Anchorage ${fmtDMS(anchor.lat, true)} ${fmtDMS(anchor.lon, false)}` : 'Anchorage at the harbour entrance'}${Number.isFinite(h.tugCost) ? ` · tugs ${fmt(h.tugCost)} cr` : ''} · fuel ${fmt(h.fuelPrice)} cr/t</p>
        ${h.fees ? `<p class="small">Port dues <b>${fmt(h.fees.dues)}</b> cr on arrival · berth <b>${fmt(h.fees.berthPerDay)}</b> cr per started 24 h${h.fees.pilotage ? ` · pilotage <b>${fmt(h.fees.pilotage)}</b> cr` : ''}</p>` : '<p class="muted small">Port dues scale with displacement and port class; berth fees are charged per started day on casting off.</p>'}</div>
      <div class="box"><h4>Berths</h4>${berths.length ? `<table><tr><th>Berth</th><th class="num">Length</th><th class="num">Depth</th><th>Type</th></tr>${berths.map((b) => `<tr${you.berth?.id === b.id ? ' class="mine"' : ''}><td>${esc(b.name || b.id)}</td><td class="num">${Math.round(b.length)} m</td><td class="num">${(+b.depth).toFixed(1)} m</td><td>${esc(b.kind || 'quay')}${b.maxLength ? ` · ships ≤ ${Math.round(b.maxLength)} m` : ''}</td></tr>`).join('')}</table>` : '<p class="muted">No berth survey for this harbour yet — moor anywhere inside the breakwaters.</p>'}</div>
    </div>`;
    root.querySelectorAll('[data-qty]').forEach((i) => { if (qty[i.dataset.qty] != null) i.value = qty[i.dataset.qty]; });
    root.querySelectorAll('[data-job]').forEach((b) => (b.onclick = () => net.action('accept_job', { jobId: b.dataset.job })));
    root.querySelectorAll('[data-abandon]').forEach((b) => (b.onclick = () => net.action('abandon_job', { jobId: b.dataset.abandon })));
    root.querySelectorAll('[data-fuel]').forEach((b) => (b.onclick = () => net.action('buy_fuel', { tonnes: +b.dataset.fuel })));
    root.querySelectorAll('[data-repair]').forEach((b) => (b.onclick = () => net.action('repair')));
    root.querySelectorAll('[data-service]').forEach((b) => (b.onclick = () => net.action('service')));
    root.querySelectorAll('[data-kit]').forEach((b) => (b.onclick = () => net.action('buy_kit')));
    root.querySelectorAll('[data-dump]').forEach((b) => (b.onclick = () => { if (confirm('Dump this cargo overboard?')) net.action('dump_cargo', { good: b.dataset.dump }); }));
    root.querySelectorAll('[data-buy]').forEach((b) => (b.onclick = () => net.action('buy_goods', { good: b.dataset.buy, qty: +root.querySelector(`[data-qty="${b.dataset.buy}"]`).value })));
    root.querySelectorAll('[data-sell]').forEach((b) => (b.onclick = () => net.action('sell_goods', { good: b.dataset.sell, qty: +root.querySelector(`[data-qty="${b.dataset.sell}"]`).value })));
    root.querySelectorAll('[data-look]').forEach((b) => (b.onclick = () => net.action('lookaround')));
    root.querySelectorAll('[data-ship]').forEach((b) => (b.onclick = () => { if (confirm('Buy this ship? Your current ship is traded in.')) net.action('buy_ship', { cls: b.dataset.ship }); }));
    root.querySelectorAll('[data-used]').forEach((b) => (b.onclick = () => { if (confirm('Buy this second-hand hull? Your current ship is traded in.')) net.action('buy_used', { listingId: b.dataset.used }); }));
    root.querySelectorAll('[data-sellship]').forEach((b) => (b.onclick = () => { if (confirm(`Sell your ${C.name} for ${fmt(tradeIn)} cr? You will be left with a pilot boat.`)) net.action('sell_ship'); }));
    this.bindPlayerActions(root);
    this.showTab(this.harborTab);
  }
  /** Job boards tab: every harbour's contracts from /api/jobs, nearest first, with a 'Chart' link. */
  renderBoards() {
    const el = $('tab-boards'); if (!el) return;
    const data = cachedJobs();
    if (!data) { el.innerHTML = '<p class="muted">Loading job boards…</p>'; fetchJobs().then(() => { if (this.harborOpen() && this.harborTab === 'boards') this.renderBoards(); }); return; }
    const me = this.app.ship, you = this.app.you, C = you ? SHIP_CLASSES[you.ship.cls] || SHIP_CLASSES.coaster : SHIP_CLASSES.coaster;
    const mass = you ? you.cargo.reduce((s, c) => s + c.qty, 0) : 0;
    const rows = data.harbors.map((e) => { const h = this.app.world.harbors.find((x) => x.id === e.id) || e.harbor; if (!h) return null; const d = me ? haversine(me.lat, me.lon, h.lat, h.lon) : 0; return { e, h, d }; }).filter((r) => r && r.e.jobs.length).sort((a, b) => a.d - b.d);
    const nm = (m) => fmtDistance(m);
    el.innerHTML = `<p class="muted">Every harbour's board, nearest first (${data.harbors.reduce((s, e) => s + e.jobs.length, 0)} contracts). Contracts are taken at the harbour that posts them. Refreshed ${Math.round((Date.now() - data.time) / 1000)} s ago.</p>` +
      rows.map(({ e, h, d }) => `<div class="box board"><h4>${esc(h.name)} <span class="muted">· ${me ? nm(d) + ' ' + String(Math.round(bearing(me.lat, me.lon, h.lat, h.lon))).padStart(3, '0') + '°' : ''} · fuel ${fmt(e.fuel)} cr/t</span><button class="small" data-chart="${h.lat},${h.lon}">Chart</button></h4>
        <table><tr><th>Contract</th><th class="num">Pay</th><th class="num">Pay/t</th><th class="num">Dist</th><th class="num">Deadline</th></tr>${e.jobs.map((j) => { const why = you ? this.whyNot(j, you, C, mass) : null; return `<tr><td><span class="pill ${j.type === 'fishing' ? 'good' : j.type === 'charter' || j.type === 'passengers' ? 'pax' : ''}">${esc(j.type)}</span>${esc(j.title)}${j.needsCat ? ` <span class="pill ${j.needsCat.includes(C.cat) ? '' : 'bad'}">needs yacht or ferry</span>` : ''}${why ? `<div class="muted small">${esc(why)}</div>` : ''}</td><td class="num">${fmt(j.pay)}</td><td class="num">${this.payPerT(j)}</td><td class="num">${j.distKm ? j.distKm + ' km' : '—'}</td><td class="num">${this.deadline(j)}</td></tr>`; }).join('')}</table></div>`).join('');
    el.querySelectorAll('[data-chart]').forEach((b) => (b.onclick = () => { const [lat, lon] = b.dataset.chart.split(',').map(Number); this.openChart(); this.chart.setCenter(lat, lon, 10); }));
  }
  playerActions(id) {
    return `<span class="inline"><button data-trade="${esc(id)}">Trade</button><button data-convoy="${esc(id)}">Convoy</button><button data-board="${esc(id)}" class="danger">Board</button></span>`;
  }
  bindPlayerActions(root) {
    const net = this.app.net;
    root.querySelectorAll('[data-convoy]').forEach((b) => (b.onclick = () => net.action('convoy_invite', { targetId: b.dataset.convoy })));
    root.querySelectorAll('[data-board]').forEach((b) => (b.onclick = () => { if (confirm('Board this ship? Piracy makes you wanted.')) net.action('board', { targetId: b.dataset.board }); }));
    root.querySelectorAll('[data-trade]').forEach((b) => (b.onclick = () => this.tradeDialog(b.dataset.trade)));
  }
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

  // ---------------------------------------------------------------- ships list
  toggleShips() {
    const w = $('shipsWrap');
    if (!w.classList.contains('hidden')) return w.classList.add('hidden');
    this.closeOverlays(); w.classList.remove('hidden'); this.renderShips();
  }
  renderShips() {
    const a = this.app, me = a.ship; if (!me) return;
    const rows = [...a.others.values()].map((o) => ({ o, d: unitsBetween(me.lat, me.lon, o.cur.lat, o.cur.lon) })).sort((x, y) => x.d - y.d);
    const km = (d) => `${(d * GEO.SCALE / 1000).toFixed(1)} km`;
    let html = rows.length ? `<h4>Skippers</h4><table><tr><th>Skipper</th><th>Ship</th><th class="num">Range</th><th class="num">Speed</th><th>Status</th><th></th></tr>${rows.map(({ o, d }) => `<tr><td>${esc(o.name)}${o.convoyId && o.convoyId === a.you?.convoyId ? ' <span class="pill">convoy</span>' : ''}${o.wanted ? ' <span class="pill bad">wanted</span>' : ''}</td><td>${SHIP_CLASSES[o.cls]?.name || esc(o.cls)}</td><td class="num">${km(d)}</td><td class="num">${o.cur.spd.toFixed(1)} kn</td><td>${o.docked ? 'docked' : o.sinking ? 'SINKING' : 'at sea'}</td><td>${this.playerActions(o.id)}</td></tr>`).join('')}</table>` : '<p class="muted">No other skippers online right now. Share the link — everyone sails the same ocean.</p>';
    if (a.you?.convoy) html += `<p>Your convoy: ${a.you.convoy.members.map((m) => esc(m.name)).join(', ')} <button id="leaveConvoy">Leave convoy</button></p>`;
    const ai = collectAi(a).map((s) => ({ s, d: unitsBetween(me.lat, me.lon, s.lat, s.lon) })).sort((x, y) => x.d - y.d);
    const etaTxt = (s) => s.eta ? fmtClock(s.eta > 1e11 ? s.eta / 1000 : s.eta) + ' UTC' : '—';
    if (ai.length) html += `<h4 style="margin-top:14px">Shipping traffic (AIS)</h4><table><tr><th>Vessel</th><th>Class</th><th class="num">Range</th><th class="num">Speed</th><th>Destination</th><th class="num">ETA</th></tr>${ai.slice(0, 60).map(({ s, d }) => `<tr><td>${esc(s.name)}${s.flag ? ` <span class="muted small">${esc(s.flag)}</span>` : ''}</td><td>${SHIP_CLASSES[s.cls]?.name || esc(s.cls || '')}</td><td class="num">${km(d)}</td><td class="num">${(+s.spd || 0).toFixed(1)} kn</td><td>${s.state === 'moored' ? 'moored' : s.state === 'anchored' ? 'at anchor' : esc(s.destName || s.dest || '—')}</td><td class="num">${etaTxt(s)}</td></tr>`).join('')}</table>`;
    else html += '<p class="muted small" style="margin-top:12px">No AIS traffic within 40 km.</p>';
    $('shipsList').innerHTML = html;
    this.bindPlayerActions($('shipsWrap'));
    const lc = $('leaveConvoy'); if (lc) lc.onclick = () => a.net.action('convoy_leave');
  }

  // ---------------------------------------------------------------- hail banner, prompts
  updateHail(you, now) {
    const el = $('hail');
    if (!you?.hail) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const left = Math.max(0, Math.ceil((you.hail.until - now) / 1000));
    if (you.hail.state === 'hailed') el.innerHTML = `COAST GUARD: HEAVE TO<small>${esc(you.hail.cutter)} · slow below 2 kn · ${left} s</small>`;
    else if (you.hail.state === 'inspecting') el.innerHTML = `INSPECTION IN PROGRESS<small>${esc(you.hail.cutter)} is searching the holds</small>`;
    else el.innerHTML = `PURSUIT<small>${esc(you.hail.cutter)} is chasing you at 30 kn — outrun them or get caught</small>`;
  }
  prompt(id, html, buttons) {
    const d = document.createElement('div'); d.className = 'prompt'; d.dataset.id = id; d.innerHTML = html + '<div class="inline"></div>';
    for (const b of buttons) { const btn = document.createElement('button'); btn.textContent = b.label; if (b.primary) btn.className = 'primary'; btn.onclick = () => { b.fn(); d.remove(); }; d.querySelector('.inline').appendChild(btn); }
    $('prompts').appendChild(d);
    setTimeout(() => d.remove(), 60000);
  }
}
