// HUD: top bar, telemetry, event log, radar, chart, harbour panel, ships list, hail banner, trade/convoy prompts.
import { fmtDMS, bearing, unitsBetween, haversine } from '/shared/geo.js';
import { GOODS, SHIP_CLASSES, LAYERS, GEO } from '/shared/constants.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const RANGES_KM = [2, 5, 10, 20, 50, 100, 250, 1000];

export class Hud {
  constructor(app) {
    this.app = app;
    this.rangeIdx = 2;
    this.chartMode = 'region';
    this.chartImg = { region: null, world: null };
    this.logEntries = [];
    this.harborTab = 'jobs';
    this.harborData = null;
    this.bind();
  }
  bind() {
    const a = this.app;
    $('startBtn').onclick = () => a.start($('nameInput').value.trim());
    $('nameInput').onkeydown = (e) => { if (e.key === 'Enter') a.start($('nameInput').value.trim()); };
    try { $('nameInput').value = localStorage.getItem('saltline.name') || ''; } catch {}
    document.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => $(b.dataset.close).classList.add('hidden'); });
    $('btnDock').onclick = () => a.toggleDock();
    $('btnUndock').onclick = () => a.toggleDock();
    $('btnChart').onclick = () => this.toggleChart();
    $('btnShips').onclick = () => this.toggleShips();
    $('btnFish').onclick = () => a.net.action('fish', { on: !a.you?.fishing });
    $('btnPatch').onclick = () => a.net.action('patch');
    $('btnAuto').onclick = () => a.toggleAutopilot();
    $('btnTow').onclick = () => { if (confirm('Call a tow to the nearest harbour? It costs money and ends the voyage.')) a.net.action('tow'); };
    $('btnHelp').onclick = () => $('helpWrap').classList.toggle('hidden');
    document.querySelectorAll('#radarCtl button').forEach((b) => { b.onclick = () => { this.rangeIdx = Math.max(0, Math.min(RANGES_KM.length - 1, this.rangeIdx + (b.dataset.r === '+' ? 1 : -1))); $('radarRange').textContent = RANGES_KM[this.rangeIdx] + ' km'; }; });
    $('chart').onclick = (e) => this.chartClick(e);
    document.querySelectorAll('.tabs button').forEach((b) => { b.onclick = () => this.showTab(b.dataset.tab); });
    $('chatInput').onkeydown = (e) => {
      if (e.key === 'Enter') { const t = $('chatInput').value.trim(); if (t) a.net.chat(t); $('chatInput').value = ''; $('chatInput').blur(); }
      if (e.key === 'Escape') $('chatInput').blur();
      e.stopPropagation();
    };
  }
  setStatus(t) { $('connStatus').textContent = t; }
  showWelcome(show) { $('welcome').classList.toggle('hidden', !show); $('hud').classList.toggle('hidden', show); }
  anyOverlayOpen() { return ['chartWrap', 'harborWrap', 'shipsWrap', 'helpWrap'].some((id) => !$(id).classList.contains('hidden')); }
  closeOverlays() { for (const id of ['chartWrap', 'shipsWrap', 'helpWrap']) $(id).classList.add('hidden'); }

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
    const C = SHIP_CLASSES[you.ship.cls];
    $('hbName').textContent = `${you.name} · ${C.name}`;
    $('hbMoney').textContent = fmt(you.money) + ' cr';
    $('hbFuel').textContent = `${you.fuel.toFixed(1)} / ${C.fuelCap} t`;
    $('hbFuel').style.color = you.fuel < C.fuelCap * 0.1 ? 'var(--red)' : '';
    $('hbCond').textContent = `${Math.round(you.cond)} %`;
    $('hbCond').style.color = you.cond < 30 ? 'var(--red)' : you.cond < 60 ? 'var(--accent)' : '';
    const mass = you.cargo.reduce((s, c) => s + c.qty, 0);
    const contra = you.cargo.some((c) => c.contraband);
    $('hbCargo').textContent = `${Math.round(mass)} / ${C.capacity} t${contra ? ' ⚠' : ''}`;
    $('hbCargo').style.color = contra ? '#b07cff' : '';
    $('hbWanted').textContent = you.wanted ? '★'.repeat(you.wanted) : 'clean';
    $('hbWanted').style.color = you.wanted ? 'var(--red)' : '';
    if (snap) {
      const st = snap.simTime || 0;
      const day = Math.floor(st / 86400) + 1, hh = Math.floor((st % 86400) / 3600), mm = Math.floor((st % 3600) / 60);
      $('hbClock').textContent = `Day ${day} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
      $('hbWind').textContent = `${snap.wind.dir}° ${snap.wind.spd.toFixed(0)} m/s`;
    }
    $('hbPing').textContent = latency + ' ms';
    $('hbOnline').textContent = `${onlineCount} online`;
    $('btnFish').classList.toggle('on', !!you.fishing);
    $('btnPatch').textContent = `Kit (K) ×${you.kits || 0}`;
    $('btnDock').textContent = you.docked ? 'Cast off (T)' : 'Dock (T)';
    $('btnTow').classList.toggle('hidden', !!you.docked);
  }
  updateTelemetry(ship, info) {
    $('tSog').textContent = Math.abs(ship.spd).toFixed(1);
    $('tHdg').textContent = String(Math.round(ship.hdg) % 360).padStart(3, '0');
    $('tLat').textContent = fmtDMS(ship.lat, true); $('tLon').textContent = fmtDMS(ship.lon, false);
    $('tDepth').textContent = info.depth == null ? '—' : info.depth > 199 ? '>200' : info.depth.toFixed(1);
    $('tDepth').parentElement.style.color = info.depth != null && info.depth < info.draft + 3 ? 'var(--red)' : '';
    $('tCur').textContent = info.current ? `${Math.round(info.current.set)}° ${info.current.drift.toFixed(1)} kn` : '—';
    $('tThr').textContent = Math.round(ship.throttleCmd * 100) + '%'; $('tRud').textContent = ship.rudder > 0.05 ? `S${Math.round(ship.rudder * 35)}` : ship.rudder < -0.05 ? `P${Math.round(-ship.rudder * 35)}` : '0';
    $('tFlood').textContent = Math.round(info.flooding * 100) + '%'; $('tFlood').style.color = info.flooding > 0.05 ? 'var(--red)' : '';
    $('tNear').textContent = info.nearest ? `${info.nearest.name.split(' (')[0]} ${info.nearest.dist}` : '—';
    $('tWp').textContent = info.wp ? `${info.wp.dist} brg ${String(Math.round(info.wp.brg)).padStart(3, '0')}°${info.autopilot ? ' AP' : ''}` : 'none';
    $('tEta').textContent = info.wp ? info.wp.eta : '—';
    $('tJobs').textContent = info.jobs; $('tStatus').textContent = info.status;
    const thr = ship.throttle; $('barThr').style.width = Math.max(0, thr) * 100 + '%'; $('barThr').style.background = thr < 0 ? 'var(--accent)' : 'var(--green)';
    $('barRud').style.left = ship.rudder >= 0 ? '50%' : 50 + ship.rudder * 50 + '%'; $('barRud').style.width = Math.abs(ship.rudder) * 50 + '%';
    $('btnAuto').classList.toggle('on', !!info.autopilot);
  }

  // ---------------------------------------------------------------- radar
  drawRadar(me, contacts, now) {
    const cv = $('radar'), ctx = cv.getContext('2d'), W = cv.width, R = W / 2;
    const rangeU = (RANGES_KM[this.rangeIdx] * 1000) / GEO.SCALE;
    const k = (R - 6) / rangeU;
    ctx.clearRect(0, 0, W, W);
    ctx.save(); ctx.translate(R, R);
    ctx.strokeStyle = 'rgba(90,214,255,0.18)'; ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i++) { ctx.beginPath(); ctx.arc(0, 0, ((R - 6) * i) / 3, 0, Math.PI * 2); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(0, -R + 6); ctx.lineTo(0, R - 6); ctx.moveTo(-R + 6, 0); ctx.lineTo(R - 6, 0); ctx.stroke();
    // sweep
    const sw = ((now / 2500) % 1) * Math.PI * 2;
    const grad = ctx.createConicGradient ? ctx.createConicGradient(sw - Math.PI / 2, 0, 0) : null;
    if (grad) { grad.addColorStop(0, 'rgba(90,214,255,0.0)'); grad.addColorStop(0.85, 'rgba(90,214,255,0.0)'); grad.addColorStop(1, 'rgba(90,214,255,0.25)'); ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(0, 0, R - 6, 0, Math.PI * 2); ctx.fill(); }
    // heading line
    const h = (me.hdg * Math.PI) / 180;
    ctx.strokeStyle = 'rgba(242,177,52,0.8)'; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.sin(h) * (R - 6), -Math.cos(h) * (R - 6)); ctx.stroke();
    ctx.font = '10px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const c of contacts) {
      const d = unitsBetween(me.lat, me.lon, c.lat, c.lon);
      if (d > rangeU * 1.02) continue;
      const b = (bearing(me.lat, me.lon, c.lat, c.lon) * Math.PI) / 180;
      const x = Math.sin(b) * d * k, y = -Math.cos(b) * d * k;
      ctx.fillStyle = c.color; ctx.strokeStyle = c.color;
      if (c.kind === 'harbor') { ctx.fillRect(x - 3.5, y - 3.5, 7, 7); ctx.fillStyle = 'rgba(200,240,255,0.8)'; if (rangeU < 12000 || c.size === 'mega') ctx.fillText(c.label, x, y - 9); }
      else if (c.kind === 'cutter') { ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y + 4); ctx.lineTo(x - 5, y + 4); ctx.closePath(); ctx.fill(); }
      else if (c.kind === 'wreck') { ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x - 4, y - 4); ctx.lineTo(x + 4, y + 4); ctx.moveTo(x + 4, y - 4); ctx.lineTo(x - 4, y + 4); ctx.stroke(); }
      else if (c.kind === 'ground') { ctx.beginPath(); ctx.arc(x, y, Math.max(4, c.radiusU * k), 0, Math.PI * 2); ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]); }
      else if (c.kind === 'wp') { ctx.beginPath(); ctx.moveTo(x, y - 6); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 6); ctx.lineTo(x - 6, y); ctx.closePath(); ctx.stroke(); }
      else { ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill(); if (c.hdg != null) { const hh = (c.hdg * Math.PI) / 180; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.sin(hh) * 9, y - Math.cos(hh) * 9); ctx.stroke(); } ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fillText(c.label, x, y - 9); }
    }
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(0, -6); ctx.lineTo(4, 5); ctx.lineTo(-4, 5); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  // ---------------------------------------------------------------- chart
  toggleChart() {
    const w = $('chartWrap');
    if (w.classList.contains('hidden')) { this.closeOverlays(); w.classList.remove('hidden'); this.chartMode = this.app.inRegion() ? 'region' : 'world'; this.drawChart(); } else w.classList.add('hidden');
  }
  chartOpen() { return !$('chartWrap').classList.contains('hidden'); }
  chartBounds() { return this.chartMode === 'region' ? LAYERS[1] : LAYERS[0]; }
  chartXY(lat, lon, W, H) { const b = this.chartBounds(); return { x: ((lon - b.lonMin) / (b.lonMax - b.lonMin)) * W, y: ((b.latMax - lat) / (b.latMax - b.latMin)) * H }; }
  drawChart() {
    const cv = $('chart'), ctx = cv.getContext('2d');
    const b = this.chartBounds();
    const aspect = (b.lonMax - b.lonMin) / (b.latMax - b.latMin) * (this.chartMode === 'region' ? Math.cos((55 * Math.PI) / 180) * 1.0 : 1);
    cv.width = 1100; cv.height = Math.round(1100 / (this.chartMode === 'region' ? 1100 / 725 : 2));
    const W = cv.width, H = cv.height;
    const img = this.chartImg[this.chartMode];
    if (!img) {
      const im = new Image(); im.onload = () => { this.chartImg[this.chartMode] = im; if (this.chartOpen()) this.drawChart(); };
      im.src = `/api/chart/${this.chartMode}.png`;
      ctx.fillStyle = '#0a2238'; ctx.fillRect(0, 0, W, H); ctx.fillStyle = '#9ad7ff'; ctx.font = '16px sans-serif'; ctx.fillText('Loading chart…', 20, 30);
    } else ctx.drawImage(img, 0, 0, W, H);
    const a = this.app;
    ctx.font = '11px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (const g of a.world.fishing) {
      const p = this.chartXY(g.lat, g.lon, W, H); const rpx = (g.radiusKm / 111) / (b.latMax - b.latMin) * H;
      ctx.strokeStyle = 'rgba(120,200,255,0.7)'; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(4, rpx), 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      if (this.chartMode === 'region' || g.radiusKm > 150) { ctx.fillStyle = 'rgba(160,220,255,0.9)'; ctx.fillText('~ ' + g.name, p.x + 6, p.y); }
    }
    for (const h of a.world.harbors) {
      if (this.chartMode === 'region' && !(h.lat >= b.latMin && h.lat < b.latMax && h.lon >= b.lonMin && h.lon < b.lonMax)) continue;
      const p = this.chartXY(h.lat, h.lon, W, H);
      ctx.fillStyle = '#58d68d'; ctx.fillRect(p.x - 3, p.y - 3, 6, 6);
      if (this.chartMode === 'region' || h.size === 'mega' || h.size === 'major') { ctx.fillStyle = '#eaffea'; ctx.fillText(h.name.split(' (')[0], p.x + 6, p.y); }
    }
    for (const w of a.wrecks) { const p = this.chartXY(w.lat, w.lon, W, H); ctx.strokeStyle = '#ccc'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(p.x - 4, p.y - 4); ctx.lineTo(p.x + 4, p.y + 4); ctx.moveTo(p.x + 4, p.y - 4); ctx.lineTo(p.x - 4, p.y + 4); ctx.stroke(); }
    for (const c of a.cutters.values()) { const p = this.chartXY(c.cur.lat, c.cur.lon, W, H); ctx.fillStyle = '#ff6b6b'; ctx.beginPath(); ctx.moveTo(p.x, p.y - 5); ctx.lineTo(p.x + 5, p.y + 4); ctx.lineTo(p.x - 5, p.y + 4); ctx.closePath(); ctx.fill(); }
    for (const o of a.others.values()) { const p = this.chartXY(o.cur.lat, o.cur.lon, W, H); ctx.fillStyle = o.convoyId && o.convoyId === a.you?.convoyId ? '#5ad6ff' : '#fff'; ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#fff'; ctx.fillText(o.name, p.x + 6, p.y); }
    if (a.waypoint) { const p = this.chartXY(a.waypoint.lat, a.waypoint.lon, W, H); ctx.strokeStyle = '#f2b134'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(p.x, p.y - 8); ctx.lineTo(p.x + 8, p.y); ctx.lineTo(p.x, p.y + 8); ctx.lineTo(p.x - 8, p.y); ctx.closePath(); ctx.stroke(); }
    if (a.ship) {
      const p = this.chartXY(a.ship.lat, a.ship.lon, W, H); const hh = (a.ship.hdg * Math.PI) / 180;
      if (a.waypoint) { const q = this.chartXY(a.waypoint.lat, a.waypoint.lon, W, H); ctx.strokeStyle = 'rgba(242,177,52,0.6)'; ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke(); ctx.setLineDash([]); }
      ctx.fillStyle = '#f2b134'; ctx.beginPath(); ctx.moveTo(p.x + Math.sin(hh) * 9, p.y - Math.cos(hh) * 9); ctx.lineTo(p.x + Math.sin(hh + 2.5) * 7, p.y - Math.cos(hh + 2.5) * 7); ctx.lineTo(p.x + Math.sin(hh - 2.5) * 7, p.y - Math.cos(hh - 2.5) * 7); ctx.closePath(); ctx.fill();
    }
    $('chartInfo').textContent = `${this.chartMode === 'region' ? 'North Sea detail chart (Natural Earth 10 m)' : 'World chart (Natural Earth 50 m)'} · ${a.world.harbors.length} harbours · press R to switch`;
  }
  chartClick(e) {
    const cv = $('chart'), r = cv.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * cv.width, py = ((e.clientY - r.top) / r.height) * cv.height;
    const b = this.chartBounds();
    const lon = b.lonMin + (px / cv.width) * (b.lonMax - b.lonMin), lat = b.latMax - (py / cv.height) * (b.latMax - b.latMin);
    this.app.setWaypoint(lat, lon);
    this.drawChart();
  }

  // ---------------------------------------------------------------- harbour panel
  showHarbor(h) {
    this.harborData = h;
    $('hName').textContent = h.name; $('hSub').textContent = `${h.country} · ${h.size} port · fuel ${fmt(h.fuelPrice)} cr/t`;
    this.closeOverlays(); $('harborWrap').classList.remove('hidden');
    this.renderHarborTabs();
  }
  hideHarbor() { $('harborWrap').classList.add('hidden'); }
  harborOpen() { return !$('harborWrap').classList.contains('hidden'); }
  showTab(t) { this.harborTab = t; document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t)); document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('hidden', el.id !== 'tab-' + t)); }
  renderHarborTabs() {
    const h = this.harborData, you = this.app.you, net = this.app.net; if (!h || !you) return;
    const C = SHIP_CLASSES[you.ship.cls];
    const mass = you.cargo.reduce((s, c) => s + c.qty, 0);
    const hname = (id) => this.app.world.harbors.find((x) => x.id === id)?.name || id;
    const jobRow = (j, shady) => {
      const dl = Math.max(0, (j.deadline - this.app.simTime) / 3600);
      const can = j.type === 'passengers' ? you.jobs.filter((x) => x.type === 'passengers').reduce((s, x) => s + x.pax, 0) + j.pax <= C.pax : j.type === 'fishing' ? true : mass + j.qty <= C.capacity;
      return `<tr><td><span class="pill ${shady ? 'bad' : j.type === 'fishing' ? 'good' : ''}">${j.type}</span>${j.title}</td><td class="num">${j.distKm ? j.distKm + ' km' : '—'}</td><td class="num">${dl.toFixed(0)} h</td><td class="num"><b>${fmt(j.pay)}</b></td><td><button data-job="${j.id}" ${can ? '' : 'disabled title="no room"'}>Accept</button></td></tr>`;
    };
    $('tab-jobs').innerHTML = `<p class="muted">Deliveries complete automatically when you dock at the destination. Hold ${mass}/${C.capacity} t · berths ${C.pax}.</p>
      <table><tr><th>Contract</th><th class="num">Dist</th><th class="num">Deadline</th><th class="num">Pay (cr)</th><th></th></tr>${h.jobs.map((j) => jobRow(j, false)).join('')}</table>
      <h4 style="margin:14px 0 4px">Your contracts</h4>${you.jobs.length ? `<table>${you.jobs.map((j) => `<tr><td>${j.title}</td><td>${hname(j.to)}</td><td class="num">${fmt(j.pay)}</td><td><button data-abandon="${j.id}">Abandon</button></td></tr>`).join('')}</table>` : '<p class="muted">None.</p>'}`;
    const fuelNeed = Math.max(0, C.fuelCap - you.fuel);
    $('tab-services').innerHTML = `<div class="grid">
      <div class="box"><h4>Fuel dock</h4><p>Bunker fuel <b>${fmt(h.fuelPrice)} cr/t</b>. Tank ${you.fuel.toFixed(1)} / ${C.fuelCap} t.</p>
        <div class="inline"><button data-fuel="${fuelNeed}">Fill up (${fmt(fuelNeed * h.fuelPrice)} cr)</button><button data-fuel="${Math.min(fuelNeed, 10)}">+10 t</button><button data-fuel="${Math.min(fuelNeed, 25)}">+25 t</button></div></div>
      <div class="box"><h4>Repair yard</h4><p>Condition <b>${Math.round(you.cond)} %</b>${you.flooding > 0 ? ` · flooding ${Math.round(you.flooding * 100)} % (pumped out at the quay)` : ''}.</p>
        <div class="inline"><button data-repair="1" ${h.repairCost > 0 ? '' : 'disabled'}>Overhaul (${fmt(h.repairCost)} cr)</button><button data-kit="1">Damage-control kit (2,500 cr) · have ${you.kits || 0}</button></div></div>
      <div class="box"><h4>Cargo aboard</h4>${you.cargo.length ? `<table>${you.cargo.map((c) => `<tr><td>${GOODS[c.good].name}${c.contraband ? ' <span class="pill bad">contraband</span>' : ''}${c.jobId ? ' <span class="pill">contract</span>' : ''}</td><td class="num">${c.qty} t</td><td><button data-dump="${c.good}">Dump</button></td></tr>`).join('')}</table>` : '<p class="muted">Empty hold.</p>'}</div>
    </div>`;
    $('tab-market').innerHTML = `<p class="muted">Prices drift with supply and demand. Buying raises the local price; selling lowers it. Contract cargo cannot be sold.</p>
      <table><tr><th>Commodity</th><th class="num">Price cr/t</th><th class="num">Aboard</th><th>Trade</th></tr>${Object.entries(h.market).map(([g, p]) => { const have = you.cargo.filter((c) => c.good === g && !c.jobId).reduce((s, c) => s + c.qty, 0); return `<tr><td>${GOODS[g].name}</td><td class="num">${fmt(p)}</td><td class="num">${have}</td><td class="inline"><input type="number" min="1" value="100" data-qty="${g}"><button data-buy="${g}">Buy</button><button data-sell="${g}" ${have ? '' : 'disabled'}>Sell</button></td></tr>`; }).join('')}</table>`;
    $('tab-shady').innerHTML = !h.contactLooked ? `<p>Wander the quays and see who wants to talk.</p><button data-look="1">Look around</button>` : h.contact ? `<p><b>${h.contact.name}</b> keeps their voice low. Illegal cargo pays five times the going rate — if the coast guard does not find it.</p><table>${h.contact.jobs.map((j) => jobRow(j, true)).join('')}</table>` : '<p class="muted">Nobody here wants to talk business today. Try another harbour.</p>';
    $('tab-players').innerHTML = h.dockedPlayers.length ? `<table>${h.dockedPlayers.map((p) => `<tr><td>${p.name}</td><td>${this.playerActions(p.id)}</td></tr>`).join('')}</table>` : '<p class="muted">No other skippers are docked here right now.</p>';
    $('tab-shipyard').innerHTML = `<table><tr><th>Class</th><th>Spec</th><th class="num">Price</th><th></th></tr>${h.shipyard.map((s) => { const c = SHIP_CLASSES[s.id]; return `<tr><td><b>${s.name}</b><br><span class="muted">${s.desc}</span></td><td>${c.length} m · ${c.maxKn} kn · ${c.capacity} t · ${c.pax} pax · ${c.fuelCap} t fuel</td><td class="num">${fmt(s.price)}</td><td><button data-ship="${s.id}" ${you.ship.cls === s.id ? 'disabled' : ''}>${you.ship.cls === s.id ? 'Owned' : 'Buy'}</button></td></tr>`; }).join('')}</table><p class="muted">Trade-in: half of your current ship's price, scaled by condition.</p>`;
    const root = $('harborWrap');
    root.querySelectorAll('[data-job]').forEach((b) => (b.onclick = () => net.action('accept_job', { jobId: b.dataset.job })));
    root.querySelectorAll('[data-abandon]').forEach((b) => (b.onclick = () => net.action('abandon_job', { jobId: b.dataset.abandon })));
    root.querySelectorAll('[data-fuel]').forEach((b) => (b.onclick = () => net.action('buy_fuel', { t: +b.dataset.fuel })));
    root.querySelectorAll('[data-repair]').forEach((b) => (b.onclick = () => net.action('repair')));
    root.querySelectorAll('[data-kit]').forEach((b) => (b.onclick = () => net.action('buy_kit')));
    root.querySelectorAll('[data-dump]').forEach((b) => (b.onclick = () => { if (confirm('Dump this cargo overboard?')) net.action('dump_cargo', { good: b.dataset.dump }); }));
    root.querySelectorAll('[data-buy]').forEach((b) => (b.onclick = () => net.action('buy_goods', { good: b.dataset.buy, qty: +root.querySelector(`[data-qty="${b.dataset.buy}"]`).value })));
    root.querySelectorAll('[data-sell]').forEach((b) => (b.onclick = () => net.action('sell_goods', { good: b.dataset.sell, qty: +root.querySelector(`[data-qty="${b.dataset.sell}"]`).value })));
    root.querySelectorAll('[data-look]').forEach((b) => (b.onclick = () => net.action('lookaround')));
    root.querySelectorAll('[data-ship]').forEach((b) => (b.onclick = () => { if (confirm('Buy this ship? Your current ship is traded in.')) net.action('buy_ship', { cls: b.dataset.ship }); }));
    this.bindPlayerActions(root);
    this.showTab(this.harborTab);
  }
  playerActions(id) {
    return `<span class="inline"><button data-trade="${id}">Trade</button><button data-convoy="${id}">Convoy</button><button data-board="${id}" class="danger">Board</button></span>`;
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
    const a = this.app, me = a.ship;
    const rows = [...a.others.values()].map((o) => ({ o, d: unitsBetween(me.lat, me.lon, o.cur.lat, o.cur.lon) })).sort((x, y) => x.d - y.d);
    $('shipsList').innerHTML = rows.length ? `<table><tr><th>Skipper</th><th>Ship</th><th class="num">Range</th><th class="num">Speed</th><th>Status</th><th></th></tr>${rows.map(({ o, d }) => `<tr><td>${o.name}${o.convoyId && o.convoyId === a.you?.convoyId ? ' <span class="pill">convoy</span>' : ''}${o.wanted ? ' <span class="pill bad">wanted</span>' : ''}</td><td>${SHIP_CLASSES[o.cls]?.name || o.cls}</td><td class="num">${(d * GEO.SCALE / 1000).toFixed(1)} km</td><td class="num">${o.cur.spd.toFixed(1)} kn</td><td>${o.docked ? 'docked' : o.sinking ? 'SINKING' : 'at sea'}</td><td>${this.playerActions(o.id)}</td></tr>`).join('')}</table>` : '<p class="muted">No other ships online right now. Share the link — everyone sails the same ocean.</p>';
    if (a.you?.convoy) $('shipsList').innerHTML += `<p>Your convoy: ${a.you.convoy.members.map((m) => m.name).join(', ')} <button id="leaveConvoy">Leave convoy</button></p>`;
    this.bindPlayerActions($('shipsWrap'));
    const lc = $('leaveConvoy'); if (lc) lc.onclick = () => a.net.action('convoy_leave');
  }

  // ---------------------------------------------------------------- hail banner, prompts
  updateHail(you, now) {
    const el = $('hail');
    if (!you?.hail) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const left = Math.max(0, Math.ceil((you.hail.until - now) / 1000));
    if (you.hail.state === 'hailed') el.innerHTML = `COAST GUARD: HEAVE TO<small>${you.hail.cutter} · slow below 2 kn · ${left} s</small>`;
    else if (you.hail.state === 'inspecting') el.innerHTML = `INSPECTION IN PROGRESS<small>${you.hail.cutter} is searching the holds</small>`;
    else el.innerHTML = `PURSUIT<small>${you.hail.cutter} is chasing you at 30 kn — outrun them or get caught</small>`;
  }
  prompt(id, html, buttons) {
    const d = document.createElement('div'); d.className = 'prompt'; d.dataset.id = id; d.innerHTML = html + '<div class="inline"></div>';
    for (const b of buttons) { const btn = document.createElement('button'); btn.textContent = b.label; if (b.primary) btn.className = 'primary'; btn.onclick = () => { b.fn(); d.remove(); }; d.querySelector('.inline').appendChild(btn); }
    $('prompts').appendChild(d);
    setTimeout(() => d.remove(), 60000);
  }
}
