// World market (docs/V6-QUICK-CONTRACTS.md §3.5, V6-PLAN item 7): a full-screen sheet with every harbour's prices,
// stock and 7-day sparklines, a trade-route finder for YOUR ship, and a price heat-map layer on the chart.
import { haversine } from '/shared/geo.js';
import { serviceKn } from '/shared/rates.js';
import { ic, GOOD_ICON } from './icons.js';

function ensureCss(id, href) {
  if (document.getElementById(id)) return;
  const l = document.createElement('link'); l.id = id; l.rel = 'stylesheet'; l.href = href;
  document.head.appendChild(l);
}
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—');
const fmt1 = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 1 }) : '—');
const fmtT = (t) => (t >= 100 ? `${fmt(t)} t` : `${fmt1(t)} t`);
const short = (name) => String(name || '').split(' (')[0];
const fmtH = (h) => (!Number.isFinite(h) ? '—' : h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${fmt1(Math.round(h * 10) / 10)} h` : `${fmt1(Math.round(h / 2.4) / 10)} d`);
const fmtKm = (km) => (km >= 100 ? `${fmt(km)} km` : `${fmt1(km)} km`);
const nm = (km) => fmt(km / 1.852);
const ago = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 3600)} h ago`; };
const store = { get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }, set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } } };

/** Net for an event line: to the 1,000 above 20,000 cr, else to the 10 (a 1,400 cr trade is not "≈ 1,000"). */
export const roundNet = (n) => (Math.abs(n) >= 20000 ? Math.round(n / 1000) * 1000 : Math.round(n / 10) * 10);
const SIZE_R = { minor: 5, regional: 7, major: 9, mega: 11 };
const LIMIT_TXT = { hold: 'your hold', stock: 'the stock here', cash: 'your money' };
const REFRESH_MS = 60000, HISTORY_MS = 600000;

/** r = price / median → diverging colour: teal (cheap) … grey … orange … red (dear). */
export function heatColor(r) {
  const stops = [[0.8, [42, 157, 143]], [1, [154, 163, 171]], [1.25, [244, 162, 97]], [1.5, [231, 111, 81]]];
  if (!(r > stops[0][0])) return '#2a9d8f';
  if (r >= 1.5) return '#e76f51';
  for (let i = 1; i < stops.length; i++) {
    if (r <= stops[i][0]) {
      const [r0, c0] = stops[i - 1], [r1, c1] = stops[i], f = (r - r0) / (r1 - r0);
      return `rgb(${c0.map((c, k) => Math.round(c + (c1[k] - c) * f)).join(',')})`;
    }
  }
  return '#e76f51';
}
export function median(vals) { const v = vals.filter(Number.isFinite).sort((a, b) => a - b); if (!v.length) return NaN; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; }
/** Inline SVG sparkline (72 × 20): history with null gaps + the live price as the last point; dot coloured by trend. */
export function sparkline(hist, live, trend) {
  const vals = [...(hist || []), live];
  const fin = vals.filter(Number.isFinite);
  if (!fin.length) return '';
  const lo = Math.min(...fin), hi = Math.max(...fin), W = 72, H = 20, n = vals.length;
  const x = (i) => (n === 1 ? W - 3 : 2 + (i / (n - 1)) * (W - 5)), y = (v) => (hi === lo ? H / 2 : 2 + (1 - (v - lo) / (hi - lo)) * (H - 4));
  const segs = []; let cur = [];
  vals.forEach((v, i) => { if (Number.isFinite(v)) cur.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`); else if (cur.length) { segs.push(cur); cur = []; } });
  if (cur.length) segs.push(cur);
  const col = trend > 0 ? '#e76f51' : trend < 0 ? '#2a9d8f' : '#9aa3ab';
  const lines = segs.map((s) => (s.length > 1 ? `<polyline points="${s.join(' ')}"/>` : '')).join('');
  const days = hist && hist.length ? Math.max(1, Math.round(hist.length / 24)) : 0;
  const tip = `${days ? `${days} day${days > 1 ? 's' : ''}` : 'now'}: low ${fmt(lo)} · high ${fmt(hi)} · now ${fmt(live)} cr/t`;
  return `<svg class="mkSpark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(tip)}"><title>${esc(tip)}</title>${lines}<circle cx="${x(n - 1).toFixed(1)}" cy="${y(live).toFixed(1)}" r="2.4" fill="${col}"/></svg>`;
}

export class WorldMarket {
  constructor(app) {
    this.app = app;
    this.snap = null; this.snapAt = 0; this.loading = null;
    this.hist = new Map();          // good → { at, data }
    this.tab = 'prices';
    this.good = store.get('mkGood', 'fish');      // selected good ('all' for every good)
    this.layerGood = this.good === 'all' ? 'fish' : this.good;
    this.query = ''; this.region = store.get('mkRegion', 'world');
    this.sort = store.get('mkSort', { key: 'harbor', dir: 1 });
    this.routes = { from: null, sort: 'tkm', data: null, loading: false, error: '' };
    this.app.tradePlan = store.get('mkPlan', null);
    try { ensureCss('mkCss', 'css/market.css'); this.inject(); } catch (e) { console.warn('[market] ui unavailable', e); }
    setInterval(() => this.tick(), 5000);
  }

  // ---------------------------------------------------------------------------------------------- entry points
  inject() {
    const sheet = $('moreSheet');
    if (sheet && !$('btnWorldMarket')) {
      const b = document.createElement('button'); b.id = 'btnWorldMarket'; b.className = 'menuBtn';
      b.innerHTML = `<span class="si">${ic('market')}</span><span class="lbl">World market (L)</span>`;
      b.onclick = () => { this.app.hud?.closeMore?.(); this.open('prices'); };
      sheet.insertBefore(b, $('btnHelp') || null);
    }
    const tools = $('chartTools');
    if (tools && !$('chartMarketBtn')) {
      const b = document.createElement('button'); b.id = 'chartMarketBtn'; b.className = 'toolBtn'; b.title = 'Colour the harbours by the price of one good';
      b.innerHTML = `<span class="si">${ic('market')}</span><span class="lbl">Market</span>`;
      b.onclick = () => this.setLayer(!this.layerOn());
      tools.appendChild(b);
    }
  }
  chart() { return this.app.hud?.chart || null; }
  layerOn() { return !!this.chart()?.layers?.market; }
  setLayer(on) {
    const c = this.chart(); if (!c) return;
    if (c.layers && !('market' in c.layers)) c.layers.market = false;
    c.layers.market = !!on;
    $('chartMarketBtn')?.classList.toggle('on', !!on);
    if (on) this.refresh();
    this.syncLegend();
    c.requestDraw?.();
  }
  isOpen() { return !!$('marketWrap') && !$('marketWrap').classList.contains('hidden'); }
  toggle() { if (this.isOpen()) this.close(); else this.open(this.tab || 'prices'); }
  open(tab = 'prices') {
    if (tab === 'map') return this.openMap();
    this.build();
    this.app.hud?.closeOverlays?.();
    $('marketWrap').classList.remove('hidden');
    this.showTab(tab);
    this.refresh();
  }
  close() { $('marketWrap')?.classList.add('hidden'); }
  openMap(good = null, at = null) {
    if (good && good !== 'all') this.layerGood = good;
    this.close();
    const hud = this.app.hud;
    if (hud && !hud.chartOpen?.()) hud.toggleChart?.();
    this.setLayer(true);
    if (at) this.chart()?.setCenter?.(at.lat, at.lon, Math.max(this.chart().zoom, 7));
  }
  tick() {
    const live = this.isOpen() || (this.layerOn() && this.app.hud?.chartOpen?.());
    if (live && Date.now() - this.snapAt > REFRESH_MS) this.refresh();
    if (this.isOpen()) this.renderSub();
  }

  // ---------------------------------------------------------------------------------------------- data
  async refresh(force = false) {
    if (!force && this.snap && Date.now() - this.snapAt < REFRESH_MS) return this.snap;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      try {
        const r = await fetch('/api/market');
        if (r.ok) { this.snap = await r.json(); this.snapAt = Date.now(); this.byId = new Map(this.snap.harbors.map((h) => [h.id, h])); }
      } catch { /* keep the old snapshot */ }
      this.loading = null;
      if (this.isOpen()) this.render();
      if (this.layerOn()) { this.syncLegend(); this.chart()?.requestDraw?.(); }
      return this.snap;
    })();
    return this.loading;
  }
  async history(good) {
    const c = this.hist.get(good);
    if (c && (c.data || c.p) && Date.now() - c.at < HISTORY_MS) return c.data || c.p;
    const p = fetch(`/api/market/history?good=${encodeURIComponent(good)}&days=7`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
      .then((data) => { this.hist.set(good, { at: Date.now(), data }); return data; });
    this.hist.set(good, { at: Date.now(), p });
    return p;
  }
  histFor(good, id) { return this.hist.get(good)?.data?.series?.[id] || null; }
  you() { return this.app.you || null; }
  cls() { return this.you()?.ship?.cls || this.app.ship?.cls || 'coaster'; }
  capacity() { return this.app.world?.classes?.[this.cls()]?.capacity ?? 0; }
  freeHold() { const y = this.you(); const mass = (y?.cargo || []).reduce((s, c) => s + (c.qty || 0), 0); return Math.max(0, Math.floor(this.capacity() - mass)); }
  async findTrades(opts = {}) {
    const y = this.you(), s = this.app.ship;
    const q = new URLSearchParams({ from: opts.from || 'all', cls: this.cls(), hold: String(Math.max(1, this.freeHold())), cash: String(Math.max(0, Math.floor(y?.money ?? 0))), sort: opts.sort || 'tkm', limit: '20' });
    if (s && Number.isFinite(s.lat)) { q.set('lat', s.lat.toFixed(3)); q.set('lon', s.lon.toFixed(3)); }
    const r = await fetch(`/api/market/routes?${q}`);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(r.status === 429 ? 'Too many searches — try again in a minute.' : body.error || `HTTP ${r.status}`);
    return body;
  }

  // ---------------------------------------------------------------------------------------------- the sheet
  build() {
    if ($('marketWrap')) return;
    const w = document.createElement('div');
    w.id = 'marketWrap'; w.className = 'sheet hidden'; w.setAttribute('role', 'dialog'); w.setAttribute('aria-label', 'World market');
    const nav = [['prices', 'market', 'Prices', 'Prices'], ['routes', 'route', 'Trade routes', 'Routes'], ['map', 'chart', 'Map', 'Map']];
    w.innerHTML = `<header class="sheetHead"><span class="sheetIcon">${ic('market')}</span><div class="sheetTitle"><b>World market</b><small id="mkSub">loading…</small></div>
        <button class="iconBtn close" data-mk="close" aria-label="Close world market" title="Close (Esc)">${ic('close')}</button></header>
      <div class="sheetMain"><nav class="sheetNav" id="mkNav" aria-label="World market sections">${nav.map(([t, i, l, s]) => `<button data-mk-tab="${t}"><span class="si">${ic(i)}</span><span class="lbl">${l}</span><span class="sl">${s}</span></button>`).join('')}</nav>
        <div class="sheetBody" id="mkBody"><section class="tab" id="mk-prices"></section><section class="tab hidden" id="mk-routes"></section></div></div>`;
    document.body.appendChild(w);
    w.addEventListener('click', (e) => this.onClick(e));
    w.addEventListener('input', (e) => { if (e.target.id === 'mkSearch') { this.query = e.target.value; this.renderRows(); } });
    w.addEventListener('change', (e) => this.onChange(e));
    w.addEventListener('keydown', (e) => { if (e.key === 'Escape') { this.close(); e.stopPropagation(); } });
  }
  showTab(t) {
    if (t === 'map') return this.openMap(this.good);
    this.tab = t;
    for (const b of document.querySelectorAll('#mkNav [data-mk-tab]')) b.classList.toggle('on', b.dataset.mkTab === t);
    $('mk-prices').classList.toggle('hidden', t !== 'prices'); $('mk-routes').classList.toggle('hidden', t !== 'routes');
    this.render();
    if (t === 'routes' && !this.routes.data && !this.routes.loading) this.loadRoutes();
  }
  renderSub() {
    const el = $('mkSub'); if (!el) return;
    el.textContent = this.snap ? `${this.snap.harbors.length} harbours · ${this.snap.goods.length} goods · updated ${ago(Date.now() - this.snapAt)}` : 'loading…';
  }
  render() {
    if (!$('marketWrap')) return;
    this.renderSub();
    if (this.tab === 'routes') this.renderRoutes(); else this.renderPrices();
  }
  narrow() { return document.body.classList.contains('touch') || innerWidth < 720; }

  // -------- prices
  renderPrices() {
    const el = $('mk-prices'); if (!el) return;
    if (!this.snap) { el.innerHTML = '<p class="muted">Loading prices…</p>'; return; }
    const goods = this.snap.goods;
    const chips = [['all', 'All goods', 'grid'], ...goods.map((g) => [g.id, g.name, GOOD_ICON[g.id] || 'crate'])]
      .map(([id, name, i]) => `<button class="mkChip${this.good === id ? ' on' : ''}" data-mk="good" data-good="${esc(id)}">${ic(i)}<span>${esc(name)}</span></button>`).join('');
    const sortOpts = [['harbor', 'Harbour A–Z'], ['country', 'Country'], ['good', 'Good'], ['price', 'Price'], ['stock', 'Stock vs normal'], ['dist', 'Distance from you']];
    el.innerHTML = `<div class="mkControls">
        <div class="mkChips" role="tablist" aria-label="Goods">${chips}</div>
        <div class="mkTools">
          <label class="mkSearch">${ic('filter')}<input id="mkSearch" type="search" placeholder="Harbour or country" value="${esc(this.query)}" aria-label="Filter harbours"></label>
          <div class="mkSeg" role="group" aria-label="Region"><button data-mk="region" data-v="region" class="${this.region === 'region' ? 'on' : ''}">North Sea</button><button data-mk="region" data-v="world" class="${this.region !== 'region' ? 'on' : ''}">World</button></div>
          <label class="mkSortSel">Sort <select id="mkSortSel">${sortOpts.map(([k, l]) => `<option value="${k}"${this.sort.key === k ? ' selected' : ''}>${l}</option>`).join('')}</select>
            <button class="mkDir" data-mk="dir" aria-label="Reverse the order" title="Reverse">${ic(this.sort.dir > 0 ? 'arrowDown' : 'arrowUp')}</button></label>
        </div>
        <p class="mkNote muted" id="mkNote"></p>
      </div>
      <div id="mkRows" class="mkRows"></div>`;
    this.renderRows();
    const need = this.good === 'all' ? goods.map((g) => g.id) : [this.good];
    Promise.all(need.map((g) => this.history(g))).then(() => this.fillSparks(true));
  }
  rowsData() {
    const s = this.app.ship, q = this.query.trim().toLowerCase();
    const L = this.app.world?.layers?.[1];
    const inRegion = (h) => !L || (h.lat >= L.latMin && h.lat < L.latMax && h.lon >= L.lonMin && h.lon < L.lonMax);
    const goods = this.good === 'all' ? this.snap.goods.map((g) => g.id) : [this.good];
    const rows = [];
    for (const h of this.snap.harbors) {
      if (this.region === 'region' && !inRegion(h)) continue;
      if (q && !h.name.toLowerCase().includes(q) && !String(h.country).toLowerCase().includes(q) && !h.id.includes(q)) continue;
      const dist = s && Number.isFinite(s.lat) ? haversine(s.lat, s.lon, h.lat, h.lon) / 1000 : null;
      for (const g of goods) { const x = h.goods[g]; if (x) rows.push({ h, g, x, dist, ratio: x.stock != null && x.target > 0 ? x.stock / x.target : null }); }
    }
    const k = this.sort.key, d = this.sort.dir;
    const val = { harbor: (r) => r.h.name, country: (r) => r.h.country + r.h.name, good: (r) => r.g, price: (r) => r.x.buy, stock: (r) => r.ratio ?? 0, dist: (r) => r.dist ?? 1e9 }[k] || ((r) => r.h.name);
    rows.sort((a, b) => { const va = val(a), vb = val(b); const c = typeof va === 'string' ? va.localeCompare(vb) : va - vb; return (c || a.h.name.localeCompare(b.h.name) || a.g.localeCompare(b.g)) * d; });
    return rows;
  }
  stockCell(r) {
    const { x, ratio } = r;
    if (ratio == null) return '<span class="muted">—</span>';
    const lvl = ratio < 0.6 ? 'short' : ratio > 1.6 ? 'glut' : 'normal', cls = ratio < 0.6 ? 'bad' : ratio > 1.6 ? 'warn' : 'good';
    return `<div class="mkStock" title="Stock ${fmtT(x.stock)} · normal ${fmtT(x.target)}"><span class="meter ${cls}"><i style="width:${Math.round(Math.min(1, ratio / 2) * 100)}%"></i></span><small>${fmtT(x.stock)} · <b class="${cls}">${lvl}</b></small></div>`;
  }
  trendIcon(t) { return `<span class="trend ${t > 0 ? 'up' : t < 0 ? 'down' : 'flat'}" title="${t > 0 ? 'price rising' : t < 0 ? 'price falling' : 'steady'}">${ic(t > 0 ? 'trendUp' : t < 0 ? 'trendDown' : 'trendFlat')}</span>`; }
  renderRows() {
    const box = $('mkRows'); if (!box || !this.snap) return;
    const rows = this.rowsData();
    const split = this.snap.harbors.some((h) => Object.values(h.goods).some((x) => x.buy !== x.sell));
    const gname = (g) => this.snap.goods.find((x) => x.id === g)?.name || g;
    const docked = this.you()?.docked;
    const note = $('mkNote');
    if (note) note.textContent = `${rows.length} row${rows.length === 1 ? '' : 's'}${this.good !== 'all' ? ` · median ${fmt(median(this.snap.harbors.map((h) => h.goods[this.good]?.buy)))} cr/t` : ''}${split ? '' : ' · buying and selling price are the same today'} · prices in cr per tonne`;
    if (!rows.length) { box.innerHTML = '<p class="muted mkEmpty">No harbour matches.</p>'; return; }
    const acts = (r) => `<button class="mkAct" data-mk="chart" data-h="${esc(r.h.id)}" data-good="${esc(r.g)}" title="Show on the chart">${ic('chart')}<span>Chart</span></button><button class="mkAct" data-mk="tradesFrom" data-h="${esc(r.h.id)}" title="Best trades from this harbour">${ic('route')}<span>Trades</span></button>`;
    if (this.narrow()) {
      box.className = 'mkRows cards';
      box.innerHTML = rows.map((r) => `<article class="mkCard${docked === r.h.id ? ' here' : ''}" data-spark="${esc(r.g)}|${esc(r.h.id)}">
          <div class="mkCardTop"><span class="mkGood">${ic(GOOD_ICON[r.g] || 'crate')}</span><div class="mkCardName"><b>${esc(short(r.h.name))}</b><small>${esc(r.h.country)}${this.good === 'all' ? ` · ${esc(gname(r.g))}` : ''}${r.dist != null ? ` · ${fmtKm(r.dist)}` : ''}${docked === r.h.id ? ' · you are here' : ''}</small></div>
            <div class="mkPrice"><b>${fmt(r.x.buy)}</b>${split ? `<small>sell ${fmt(r.x.sell)}</small>` : '<small>cr/t</small>'}</div>${this.trendIcon(r.x.trend)}</div>
          <div class="mkCardMid">${this.stockCell(r)}<span class="mkSparkCell"></span></div>
          <div class="mkCardActs">${acts(r)}</div></article>`).join('');
    } else {
      box.className = 'mkRows';
      const th = (k, l, cls = '') => `<th class="${cls}${this.sort.key === k ? ' sorted' : ''}" data-mk="sort" data-k="${k}" tabindex="0" aria-sort="${this.sort.key === k ? (this.sort.dir > 0 ? 'ascending' : 'descending') : 'none'}">${l}${this.sort.key === k ? (this.sort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
      box.innerHTML = `<table class="mkTable"><thead><tr>${th('harbor', 'Harbour')}${th('country', 'Country')}${th('good', 'Good')}${split ? th('price', 'Buy', 'num') + '<th class="num">Sell</th>' : th('price', 'Price <small>(buy = sell)</small>', 'num')}${th('stock', 'Stock')}<th>Trend</th><th>7 days</th>${th('dist', 'Distance', 'num')}<th></th></tr></thead><tbody>
        ${rows.map((r) => `<tr class="${docked === r.h.id ? 'here' : ''}" data-spark="${esc(r.g)}|${esc(r.h.id)}"><td><b>${esc(short(r.h.name))}</b>${docked === r.h.id ? ' <span class="chip good">here</span>' : ''}</td><td>${esc(r.h.country)}</td><td class="mkG">${ic(GOOD_ICON[r.g] || 'crate')}${esc(gname(r.g))}</td>
          <td class="num"><b>${fmt(r.x.buy)}</b></td>${split ? `<td class="num">${fmt(r.x.sell)}</td>` : ''}<td>${this.stockCell(r)}</td><td>${this.trendIcon(r.x.trend)}</td><td class="mkSparkCell"></td><td class="num">${r.dist != null ? fmtKm(r.dist) : '—'}</td><td class="mkActs">${acts(r)}</td></tr>`).join('')}</tbody></table>`;
    }
    this.fillSparks(false);
  }
  /** Sparklines only for rows in view (IntersectionObserver); `again` re-fills rows already drawn (history arrived). */
  fillSparks(again) {
    const box = $('mkRows'); if (!box) return;
    this.io?.disconnect();
    const draw = (el) => {
      const [g, id] = el.dataset.spark.split('|');
      const x = this.byId?.get(id)?.goods?.[g]; if (!x) return;
      const cell = el.querySelector('.mkSparkCell'); if (!cell) return;
      cell.innerHTML = sparkline(this.histFor(g, id), x.buy, x.trend); el.dataset.drawn = this.hist.get(g)?.data ? '2' : '1';
    };
    const els = box.querySelectorAll('[data-spark]');
    if (typeof IntersectionObserver !== 'function') { els.forEach(draw); return; }
    this.io = new IntersectionObserver((ents) => { for (const e of ents) if (e.isIntersecting && e.target.dataset.drawn !== '2') draw(e.target); }, { root: $('mkBody'), rootMargin: '200px' });
    els.forEach((el) => { if (again && el.dataset.drawn === '1') el.dataset.drawn = ''; this.io.observe(el); });
  }

  // -------- routes
  originDefault() {
    const y = this.you(); if (y?.docked) return y.docked;
    const s = this.app.ship, hs = this.app.world?.harbors || [];
    if (!s) return 'all';
    let best = null, bd = Infinity;
    for (const h of hs) { const d = haversine(s.lat, s.lon, h.lat, h.lon); if (d < bd) { bd = d; best = h; } }
    return best ? best.id : 'all';
  }
  async loadRoutes() {
    const R = this.routes;
    if (!R.from) R.from = this.originDefault();
    R.loading = true; R.error = ''; this.renderRoutes();
    // a full hold has nothing to trade with: no 1 t "trades" (the server needs hold > 0)
    if (this.freeHold() < 1) { R.data = { trades: [], cash: this.you()?.money ?? 0 }; R.loading = false; R.at = Date.now(); if (this.isOpen()) this.renderRoutes(); return; }
    try { R.data = await this.findTrades({ from: R.from, sort: R.sort }); } catch (e) { R.error = e.message || 'Trade search failed.'; }
    R.loading = false; R.at = Date.now();
    if (this.isOpen()) this.renderRoutes();
  }
  renderRoutes() {
    const el = $('mk-routes'); if (!el) return;
    const R = this.routes, y = this.you(), s = this.app.ship;
    if (!R.from) R.from = this.originDefault();
    const hs = [...(this.app.world?.harbors || [])].map((h) => ({ h, d: s ? haversine(s.lat, s.lon, h.lat, h.lon) : 0 })).sort((a, b) => a.d - b.d);
    const cap = this.capacity(), free = this.freeHold(), money = Math.floor(y?.money ?? 0);
    const shipName = this.app.world?.classes?.[this.cls()]?.name || 'your ship';
    const hint = [];
    if (cap <= 3) hint.push(`Your hold carries ${fmtT(cap)} — trading needs a cargo ship.`);
    else if (free < 1) hint.push('Your hold is full — sell or deliver cargo first.');
    if (money < 1) hint.push('No money to buy cargo.');
    const head = `<div class="mkControls">
        <div class="mkTools">
          <label class="mkSortSel">From <select id="mkFrom"><option value="all"${R.from === 'all' ? ' selected' : ''}>Anywhere (best start)</option>${hs.map(({ h, d }) => `<option value="${esc(h.id)}"${R.from === h.id ? ' selected' : ''}>${esc(short(h.name))}${y?.docked === h.id ? ' (docked)' : s ? ` · ${fmtKm(d / 1000)}` : ''}</option>`).join('')}</select></label>
          <div class="mkSeg" role="group" aria-label="Sort trades"><button data-mk="rsort" data-v="tkm" class="${R.sort === 'tkm' ? 'on' : ''}">per t·km</button><button data-mk="rsort" data-v="hour" class="${R.sort === 'hour' ? 'on' : ''}">per hour</button><button data-mk="rsort" data-v="net" class="${R.sort === 'net' ? 'on' : ''}">total</button></div>
          <button class="mkAct" data-mk="rrefresh">${ic('rewind')}<span>Refresh</span></button>
        </div>
        <p class="mkNote muted">${esc(shipName)} · hold free ${fmtT(free)} of ${fmtT(cap)} · ${fmt(money)} cr · service speed ${fmt1(serviceKn(this.cls(), 0))} kn empty. Costs: fuel at service speed, wages, wear, port dues, pilotage and one berth day. Prices on arrival allow for the stock drifting back to normal.${R.at ? ` Searched ${ago(Date.now() - R.at)}.` : ''}</p>
        ${hint.length ? `<p class="mkHint">${ic('info')}${esc(hint.join(' '))}</p>` : ''}
        ${this.planChip()}
      </div>`;
    let body = '';
    if (R.loading && !R.data) body = '<p class="muted">Finding the best trades for your ship…</p>';
    else if (R.error) body = `<p class="mkHint bad">${ic('warning')}${esc(R.error)}</p>`;
    else if (R.data && !R.data.trades.length) body = `<p class="muted mkEmpty">${money < 1 ? 'No money to buy cargo.' : free < 1 ? 'No room in the hold.' : 'No profitable trade from here right now — try another harbour or “Anywhere”.'}</p>`;
    else if (R.data) body = `<div class="mkTrades">${R.data.trades.map((t, i) => this.tradeCard(t, i)).join('')}</div>`;
    el.innerHTML = head + body;
  }
  limitText(t) {
    if (t.limitedBy === 'cash') return `limited by your ${fmt(this.routes.data?.cash ?? this.you()?.money)} cr`;
    if (t.limitedBy === 'stock') return `limited by the stock at ${short(t.fromName)} (${fmtT(t.stockFrom)})`;
    return `limited by your hold (${fmtT(t.qty)})`;
  }
  tradeCard(t, i) {
    const gname = this.snap?.goods?.find((g) => g.id === t.good)?.name || t.good;
    const c = t.costs, avg = t.buy !== t.buyFirst ? ` (the first tonne ${fmt(t.buyFirst)})` : '';
    const lines = [['Goods', `${fmtT(t.qty)} at ${fmt(t.buy)} cr/t${avg}`, c.goods], ['Fuel', `${fmt1(t.fuelT)} t`, c.fuel], ['Wages', fmtH(t.hours), c.wages], ['Wear', 'hull', c.wear], ['Port dues', short(t.toName), c.dues], ['Pilotage', c.pilotage ? 'compulsory' : 'none', c.pilotage], ['Berth', '1 day', c.berth]];
    return `<article class="card mkTrade">
      <div class="mkTradeTop"><span class="mkGood">${ic(GOOD_ICON[t.good] || 'crate')}</span><div><b>${esc(gname)}</b>: ${esc(short(t.fromName))} → ${esc(short(t.toName))}<small>${fmtT(t.qty)} · ${esc(this.limitText(t))}${Number.isFinite(t.fromDistKm) && t.from !== this.you()?.docked ? ` · start ${fmtKm(t.fromDistKm)} from you` : ''}</small></div>
        <div class="mkNet"><b>+${fmt(t.net)} cr</b><small>${fmt(t.perHour)} cr/h · ${fmt1(t.perTkm)} cr/t·km</small></div></div>
      <div class="mkFacts"><span>${ic('coins')}buy <b>${fmt(t.buy)}</b> → sell <b>${fmt(t.sellArrive)}</b> cr/t <small>(now ${fmt(t.sellNow)})</small></span><span>${ic('route')}${t.distEst ? '≈ ' : ''}${fmtKm(t.distKm)} · ${nm(t.distKm)} nm</span><span>${ic('clock')}${fmtH(t.hours)} at service speed</span></div>
      ${t.bunker > 0 ? `<p class="mkHint warn">${ic('warning')}Beyond your range: about ${t.bunker} bunkering stop${t.bunker > 1 ? 's' : ''} on the way (the fuel is already costed).</p>` : ''}
      <details class="mkCosts"><summary>Costs ${fmt(Object.values(c).reduce((s, v) => s + v, 0))} cr · revenue ${fmt(t.revenue)} cr</summary><table>${lines.map(([l, d, v]) => `<tr><td>${l}</td><td class="muted">${esc(d)}</td><td class="num">${fmt(v)} cr</td></tr>`).join('')}<tr class="tot"><td>Net</td><td class="muted">${fmt1(t.netPerT)} cr/t</td><td class="num">${fmt(t.net)} cr</td></tr></table></details>
      <div class="mkTradeActs"><button class="primary" data-mk="plan" data-i="${i}">${ic('route')}<span>Plan this trade</span></button></div>
    </article>`;
  }
  planChip() {
    const p = this.app.tradePlan; if (!p) return '';
    const gname = this.snap?.goods?.find((g) => g.id === p.good)?.name || p.good;
    return `<div class="mkPlan">${ic('contract')}<span>Planned: buy ${fmtT(p.qty)} ${esc(gname.toLowerCase())} at ${esc(short(p.fromName || p.from))}, sell at ${esc(short(p.toName || p.to))} ≈ ${fmt(p.sellArrive)} cr/t</span><button class="iconBtn" data-mk="unplan" aria-label="Clear the trade plan" title="Clear the plan">${ic('close')}</button></div>`;
  }
  async planTrade(t) {
    const a = this.app, y = this.you();
    const plan = { good: t.good, from: t.from, fromName: t.fromName, to: t.to, toName: t.toName, qty: t.qty, buy: t.buy, sellArrive: t.sellArrive, net: t.net, createdAt: Date.now() };
    a.tradePlan = plan; store.set('mkPlan', plan);
    const atA = y?.docked === t.from;
    const destId = atA ? t.to : t.from;
    const dest = this.byId?.get(destId) || a.world?.harbors?.find((h) => h.id === destId);
    const gname = (this.snap?.goods?.find((g) => g.id === t.good)?.name || t.good).toLowerCase();
    const head = `Plan: buy ${fmt(t.qty)} t ${gname} at ${short(t.fromName)} (${fmt(t.buy)} cr/t), sell at ${short(t.toName)} ≈ ${fmt(t.sellArrive)} cr/t — net ≈ ${fmt(roundNet(t.net))} cr.`;
    this.close();
    if (!dest) { a.hud?.event?.({ kind: 'info', text: head }); return; }
    const to = dest.anchor || dest;
    let res = null;
    try {
      if (a.pilot?.planTo) res = await a.pilot.planTo({ lat: to.lat, lon: to.lon, harbor: destId, label: atA ? `trade: ${short(t.toName)}` : `trade: ${short(t.fromName)}`, engage: false });
      else await a.routeToJob?.({ kind: 'harbor', lat: to.lat, lon: to.lon, name: short(dest.name), job: { to: destId } });
    } catch (e) { console.warn('[market] route failed', e); }
    const km = res?.distM > 0 ? res.distM / 1000 : null;
    const load = atA ? t.qty / Math.max(1, this.capacity()) : 0;
    const hours = km ? km / (serviceKn(this.cls(), load) * 1.852) : null;
    const routeTxt = km ? ` Route laid${atA ? '' : ` to ${short(t.fromName)} first`}: ${nm(km)} nm, ~${fmtH(hours)}.` : atA ? '' : ` Sail to ${short(t.fromName)} first to buy.`;
    a.hud?.event?.({ kind: 'info', text: head + routeTxt });
    const hud = a.hud;
    if (hud && !hud.chartOpen?.()) hud.toggleChart?.();
    const s = a.ship, c = this.chart();
    if (c && s && km) { // frame the whole leg
      const mid = { lat: (s.lat + to.lat) / 2, lon: (s.lon + to.lon) / 2 };
      const gcKm = Math.max(5, haversine(s.lat, s.lon, to.lat, to.lon) / 1000);
      const z = Math.log2((0.55 * Math.min(c.W || innerWidth, c.H || innerHeight) * 40075) / (256 * gcKm * Math.cos(mid.lat * Math.PI / 180)));
      c.setCenter(mid.lat, mid.lon, Math.max(3, Math.min(11, z)));
    }
    a.hud?.renderHarborTabs?.();
  }
  clearPlan() { this.app.tradePlan = null; store.set('mkPlan', null); if (this.isOpen()) this.render(); this.app.hud?.renderHarborTabs?.(); }

  // ---------------------------------------------------------------------------------------------- events
  onClick(e) {
    const tabBtn = e.target.closest('[data-mk-tab]'); if (tabBtn) return this.showTab(tabBtn.dataset.mkTab);
    const el = e.target.closest('[data-mk]'); if (!el) return;
    const d = el.dataset;
    switch (d.mk) {
      case 'close': return this.close();
      case 'good': this.good = d.good; if (d.good !== 'all') this.layerGood = d.good; store.set('mkGood', this.good); return this.renderPrices();
      case 'region': this.region = d.v; store.set('mkRegion', this.region); return this.renderRows();
      case 'dir': this.sort.dir = -this.sort.dir; store.set('mkSort', this.sort); return this.renderPrices();
      case 'sort': if (this.sort.key === d.k) this.sort.dir = -this.sort.dir; else this.sort = { key: d.k, dir: d.k === 'price' || d.k === 'stock' ? -1 : 1 }; store.set('mkSort', this.sort); return this.renderPrices();
      case 'chart': { const h = this.byId?.get(d.h); return this.openMap(d.good, h); }
      case 'tradesFrom': this.routes.from = d.h; this.routes.data = null; this.showTab('routes'); return;
      case 'rsort': this.routes.sort = d.v; return this.loadRoutes();
      case 'rrefresh': return this.loadRoutes();
      case 'plan': { const t = this.routes.data?.trades?.[+d.i]; if (t) this.planTrade(t); return; }
      case 'unplan': return this.clearPlan();
    }
  }
  onChange(e) {
    if (e.target.id === 'mkSortSel') { const k = e.target.value; this.sort = { key: k, dir: k === 'price' || k === 'stock' ? -1 : 1 }; store.set('mkSort', this.sort); this.renderPrices(); }
    if (e.target.id === 'mkFrom') { this.routes.from = e.target.value; this.routes.data = null; this.loadRoutes(); }
  }
  /** From the harbour sheet: open the routes tab with this harbour as the origin. */
  tradesFrom(id) { this.routes.from = id; this.routes.data = null; this.open('routes'); }

  // ---------------------------------------------------------------------------------------------- chart layer
  syncLegend() {
    const body = document.querySelector('#chartWrap .chartBody'); if (!body) return;
    let lg = $('mkLegend');
    const on = this.layerOn();
    $('chartMarketBtn')?.classList.toggle('on', on);
    if (!on) { lg?.classList.add('hidden'); return; }
    if (!lg) {
      lg = document.createElement('div'); lg.id = 'mkLegend'; lg.className = 'glass';
      lg.addEventListener('change', (e) => { if (e.target.id === 'mkLegendGood') { this.layerGood = e.target.value; this.syncLegend(); this.chart()?.requestDraw?.(); } });
      lg.addEventListener('click', (e) => { if (e.target.closest('[data-mk="layerOff"]')) this.setLayer(false); });
      body.appendChild(lg);
    }
    lg.classList.remove('hidden');
    const goods = this.snap?.goods || [];
    const med = this.snap ? median(this.snap.harbors.map((h) => h.goods[this.layerGood]?.buy)) : NaN;
    const name = goods.find((g) => g.id === this.layerGood)?.name || this.layerGood;
    lg.innerHTML = `<div class="mkLgTop"><select id="mkLegendGood" aria-label="Good">${goods.map((g) => `<option value="${g.id}"${g.id === this.layerGood ? ' selected' : ''}>${esc(g.name)}</option>`).join('') || `<option>${esc(name)}</option>`}</select>
      <button class="iconBtn" data-mk="layerOff" aria-label="Hide the market layer" title="Hide">${ic('close')}</button></div>
      <div class="mkLgMed">${esc(name)} · median ${fmt(med)} cr/t</div>
      <div class="mkLgBar"><i></i></div><div class="mkLgEnds"><span>cheap — buy</span><span>dear — sell</span></div>`;
  }
  drawLayer(chart, ctx) {
    if (!this.snap) { this.refresh(); return; }
    if (!$('mkLegend') || $('mkLegend').classList.contains('hidden') || $('mkLegendGood')?.value !== this.layerGood) this.syncLegend();
    const g = this.layerGood, med = median(this.snap.harbors.map((h) => h.goods[g]?.buy));
    if (!(med > 0)) return;
    ctx.save();
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    for (const h of this.snap.harbors) {
      const x = h.goods[g]; if (!x) continue;
      const p = chart.project(h.lat, h.lon);
      if (p.x < -20 || p.y < -20 || p.x > chart.W + 20 || p.y > chart.H + 20) continue;
      const r = SIZE_R[h.size] || 6;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = heatColor(x.buy / med); ctx.globalAlpha = 0.92; ctx.fill(); ctx.globalAlpha = 1;
      ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(4,12,20,0.85)'; ctx.stroke();
      if (chart.zoom >= 6) {
        const t = fmt(x.buy); ctx.font = 'bold 11px sans-serif';
        const tw = ctx.measureText(t).width;
        ctx.fillStyle = 'rgba(4,12,20,0.72)'; ctx.fillRect(p.x + r + 3, p.y + 6, tw + 6, 15);
        ctx.fillStyle = '#ffffff'; ctx.fillText(t, p.x + r + 6, p.y + 13.5);
      }
    }
    ctx.restore();
  }
  popupRows(h, body) {
    const e = this.byId?.get(h.id);
    const box = document.createElement('div'); box.className = 'mkPop';
    if (!e) { box.innerHTML = '<p class="muted">Loading market prices…</p>'; body.appendChild(box); this.refresh().then(() => { if (this.byId?.get(h.id)) { box.remove(); this.popupRows(h, body); } }); return; }
    const split = Object.values(e.goods).some((x) => x.buy !== x.sell);
    const rows = (this.snap?.goods || []).map((g) => { const x = e.goods[g.id]; return x ? `<tr${this.layerOn() && g.id === this.layerGood ? ' class="sel"' : ''}><td>${esc(g.name)}</td><td class="num">${fmt(x.buy)}</td>${split ? `<td class="num">${fmt(x.sell)}</td>` : ''}<td class="num">${fmtT(x.stock)}</td></tr>` : ''; }).join('');
    box.innerHTML = `<table><tr><th>Market</th><th class="num">${split ? 'Buy' : 'cr/t'}</th>${split ? '<th class="num">Sell</th>' : ''}<th class="num">Stock</th></tr>${rows}</table>`;
    const b = document.createElement('button'); b.className = 'mkAct'; b.innerHTML = `${ic('route')}<span>Trades from here</span>`;
    b.onclick = () => { this.chart()?.hidePopup?.(); this.tradesFrom(h.id); };
    box.appendChild(b);
    body.appendChild(box);
  }
}
