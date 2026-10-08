// v6 fleet HQ (docs/V6-FLEET-CONTRACTS.md §9.1–9.2): app.hq. A full-screen sheet (#hqWrap, built at runtime) with a map
// of every ship of yours (HqMap: own canvas over /api/chart/world.png, routes, ETAs, home star), and the tabs Ships ·
// Money · Office · Log (phones: Map · Ships · Money · Office · Log at the bottom). Opening it sends hq_watch {on: true}
// so the server pushes `fleet` every second; closing sends {on: false}. Ship cards and dialogs come from fleet.js.
import { ic } from './icons.js';
import * as F from './fleetfmt.js';
import { cardHTML, esc } from './fleet.js';

function ensureCss(id, href) {
  if (document.getElementById(id)) return;
  const l = document.createElement('link'); l.id = id; l.rel = 'stylesheet'; l.href = href;
  document.head.appendChild(l);
}
const $ = (id) => document.getElementById(id);
const store = { get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } } };
const TABS = [['map', 'chart', 'Map'], ['ships', 'ship', 'Ships'], ['money', 'coins', 'Money'], ['office', 'anchor', 'Office'], ['log', 'list', 'Log']];
const REGION = { lonMin: -8, lonMax: 14, latMin: 48, latMax: 62.5 };   // LAYERS[1] of shared/constants.js
const D2R = Math.PI / 180;

export class Hq {
  constructor(app) {
    this.app = app;
    this.view = null; this.tab = store.get('hqTab', 'ships'); this.sel = null; this.htmlCache = {};
    this.map = null; this.built = false;
    try { ensureCss('flCss', 'css/fleet.css'); } catch (e) { console.warn('[hq] css', e); }
    window.addEventListener('resize', () => { if (this.isOpen()) { this.layout(); this.render(true); } });
  }
  mobile() { return document.body.classList.contains('touch') || window.innerWidth < 900; }
  isOpen() { return !!$('hqWrap') && !$('hqWrap').classList.contains('hidden'); }
  toggle() { if (this.isOpen()) this.close(); else this.open(); }
  open(tab) {
    this.build();
    this.app.hud?.closeOverlays?.();
    $('hqWrap').classList.remove('hidden');
    document.body.classList.add('hqOpen');
    if (tab) this.setTab(tab, false);
    else if (!this.mobile() && this.tab === 'map') this.tab = 'ships';
    this.layout();
    this.app.net?.action?.('hq_watch', { on: true });
    if (this.tab === 'log') this.seen();
    this.render(true);
    this.map.fitAll();
  }
  close() {
    if (!this.isOpen()) return;
    $('hqWrap').classList.add('hidden');
    document.body.classList.remove('hqOpen');
    this.app.net?.action?.('hq_watch', { on: false });
  }
  onFleet(view) {
    if (!view || !Array.isArray(view.vessels)) return;
    const first = !this.view;
    this.view = view;
    if (!this.isOpen()) return;
    this.render();
    if (first) this.map?.fitAll();
  }
  seen() { if ((this.view?.unread || 0) > 0) { this.app.net?.action?.('fleet_seen', {}); this.view.unread = 0; } }
  /** Select a ship: highlight the card (Ships tab) and centre the map. */
  focus(vid) {
    this.sel = vid;
    const v = this.view?.vessels.find((x) => x.id === vid);
    if (v && this.map) this.map.centre(v.lat, v.lon);
    if (!this.mobile()) this.setTab('ships');
    this.render(true);
    if (!this.mobile() || this.tab === 'ships') setTimeout(() => $('hqBody')?.querySelector(`.flCard[data-vid="${CSS.escape(vid)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 30);
  }
  setTab(t, render = true) {
    if (!TABS.some(([k]) => k === t)) t = 'ships';
    if (t === 'map' && !this.mobile()) t = 'ships';
    this.tab = t; store.set('hqTab', t);
    if (t === 'log') this.seen();
    if (render) { this.layout(); this.render(true); }
  }

  // ---------------------------------------------------------------------------------------------- DOM
  build() {
    if (this.built && $('hqWrap')) return;
    const w = document.createElement('div');
    w.id = 'hqWrap'; w.className = 'sheet hidden'; w.setAttribute('role', 'dialog'); w.setAttribute('aria-label', 'Fleet HQ');
    w.innerHTML = `<header class="sheetHead hqHead"><span class="sheetIcon">${ic('anchor')}</span>
        <div class="sheetTitle"><b>Fleet HQ</b><small id="hqSub"></small></div>
        <div class="hqStats" id="hqStats"></div>
        <button class="close" id="hqClose" aria-label="Close (Esc)">${ic('close')}</button></header>
      <div class="hqMain" id="hqMain">
        <section class="hqMapPane" id="hqMapPane"><canvas id="hqMap" aria-label="Map of your fleet"></canvas>
          <div class="hqMapCtl"><button class="iconBtn" data-hq="zin" aria-label="Zoom in">${ic('plus')}</button><button class="iconBtn" data-hq="zout" aria-label="Zoom out">${ic('minus')}</button><button class="iconBtn" data-hq="fit" aria-label="Show all ships">${ic('expand')}</button></div>
          <div class="hqLegend"><span><i style="background:${F.stateColor('at_sea')}"></i>At sea</span><span><i style="background:${F.stateColor('anchored')}"></i>Anchored</span><span><i style="background:${F.stateColor('docked')}"></i>Moored</span><span><i style="background:${F.stateColor('laid_up')}"></i>Laid up</span></div></section>
        <section class="hqSide"><nav class="hqTabs" id="hqTabs" role="tablist"></nav><div class="hqBody" id="hqBody"></div></section>
      </div>`;
    document.body.appendChild(w);
    this.built = true;
    $('hqClose').onclick = () => this.close();
    w.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !this.app.fleetUi?.isDialogOpen?.()) { e.stopPropagation(); this.close(); } });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.isOpen() && !this.app.fleetUi?.isDialogOpen?.()) this.close(); });
    $('hqTabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) this.setTab(b.dataset.tab); });
    w.addEventListener('click', (e) => {
      const hq = e.target.closest('[data-hq]');
      if (hq) return this.hqAction(hq.dataset.hq, hq);
      const el = e.target.closest('[data-act]');
      if (el && !el.disabled && w.contains(el)) {
        if (el.dataset.act === 'flMap') { e.preventDefault(); if (this.mobile()) this.setTab('map'); this.focus(el.dataset.vid); return; }
        if (!this.app.fleetUi?.sheetAction(el.dataset.act, el)) this.fallbackAction(el.dataset.act, el);
      }
    });
    this.map = new HqMap($('hqMap'), this);
  }
  hqAction(k, el) {
    if (k === 'zin') this.map.zoom(1.6); else if (k === 'zout') this.map.zoom(1 / 1.6); else if (k === 'fit') this.map.fitAll();
    else if (k === 'logShip') { if (this.mobile()) this.setTab('map'); this.focus(el.dataset.vid); }
  }
  /** Without fleet.js (it failed to load) the HQ still lets you take the helm. */
  fallbackAction(act, el) { if (act === 'flHelm') this.app.net?.action?.('switch_ship', { vesselId: el.dataset.vid }); }
  layout() {
    const w = $('hqWrap'); if (!w) return;
    const m = this.mobile();
    w.classList.toggle('hqMobile', m);
    w.classList.toggle('showMap', m && this.tab === 'map');
    const tabs = TABS.filter(([k]) => m || k !== 'map');
    const unread = this.view?.unread || 0;
    $('hqTabs').innerHTML = tabs.map(([k, icon, label]) => `<button data-tab="${k}" role="tab" aria-selected="${this.tab === k}" class="${this.tab === k ? 'on' : ''}">${ic(icon)}<span>${label}</span>${k === 'log' && unread ? `<em class="badge">${unread}</em>` : ''}</button>`).join('');
    this.map?.resize();
  }

  // ---------------------------------------------------------------------------------------------- render
  render(force = false) {
    if (!$('hqWrap')) return;
    const v = this.view;
    const now = this.now();
    if (!v) { $('hqBody').innerHTML = `<div class="empty">${ic('hourglass')}<span>Waiting for the office…</span></div>`; return; }
    const atSea = v.vessels.filter((x) => x.state === 'at_sea').length;
    $('hqSub').textContent = `home ${F.shortName(v.homeName)} · ${v.n} ship${v.n > 1 ? 's' : ''}${atSea ? ` · ${atSea} at sea` : ''}`;
    const t = v.money.today, d7 = v.money.d7;
    const stats = `<span class="hqStat">${ic('coins')}<b>${F.fmtCr(v.cash)}</b></span>${v.owed > 0 ? `<span class="hqStat bad" title="Unpaid office bills">${ic('warning')}owed <b>${F.fmtCr(v.owed)}</b></span>` : ''}
      <span class="hqStat"><small>today</small><b class="${t.net >= 0 ? 'pos' : 'neg'}">${F.fmtSigned(t.net)}</b></span><span class="hqStat"><small>7 days</small><b class="${d7.net >= 0 ? 'pos' : 'neg'}">${F.fmtSigned(d7.net)}</b></span>`;
    this.put('hqStats', stats, force);
    const tabBadge = $('hqTabs')?.querySelector('button[data-tab="log"] .badge');
    if ((v.unread || 0) > 0 !== !!tabBadge) this.layout();
    let html = '';
    switch (this.tab) {
      case 'map': html = this.mapSideHTML(v, now); break;
      case 'money': html = this.moneyHTML(v, now); break;
      case 'office': html = this.officeHTML(v, now); break;
      case 'log': html = this.logHTML(v, now); break;
      default: html = this.shipsHTML(v, now);
    }
    if (this.put('hqBody', html, force)) this.app.hud?.hydrateThumbs?.($('hqBody'));
    this.map?.draw();
  }
  /** innerHTML only when it changed (the server pushes once a second): keeps scroll, focus and hover. */
  put(id, html, force) {
    if (!force && this.htmlCache[id] === html) return false;
    this.htmlCache[id] = html;
    const el = $(id); if (!el) return false;
    const top = el.scrollTop; el.innerHTML = html; el.scrollTop = top;
    return true;
  }
  now() { return Number.isFinite(this.app.simTime) ? this.app.simTime : Date.now() / 1000; }
  harbors() { return this.app.world?.harbors || []; }
  ctx() { const h = this.app.hud; return { now: this.now(), harbors: this.harbors(), thumb: h && typeof h.thumbHTML === 'function' ? (c, o) => h.thumbHTML(c, o) : null, selected: this.sel }; }
  shipsHTML(v) {
    const ctx = this.ctx();
    return `<div class="hqSec"><div class="hqSecH"><h2>${ic('ship')} Ships <small class="muted">${v.n} of ${v.max}</small></h2><span class="muted small">running now ${F.fmtN(v.costPerH)} cr/h${v.storagePerDay ? ` · storage ${F.fmtN(v.storagePerDay)} cr/day` : ''}</span></div>
      <div class="flCards">${v.vessels.map((x) => cardHTML(x, ctx)).join('')}</div></div>`;
  }
  mapSideHTML(v, now) {
    const s = this.sel && v.vessels.find((x) => x.id === this.sel);
    return s ? `<div class="hqMapCard">${cardHTML(s, this.ctx())}</div>` : `<p class="muted small hqHint">${ic('pointer')} Tap a ship for her card.</p>${void now || ''}`;
  }
  moneyHTML(v) {
    const m = v.money, t = m.today, d7 = m.d7;
    const tile = (label, val, cls = '') => `<div class="hqTile ${cls}"><small>${label}</small><b>${val}</b></div>`;
    const maxAbs = Math.max(1, ...m.days.map((d) => Math.abs(d.net)));
    const W = 320, H = 120, bw = 30, gap = (W - 7 * bw) / 8, mid = H / 2;
    const bars = m.days.map((d, i) => {
      const hgt = Math.max(1, (Math.abs(d.net) / maxAbs) * (mid - 14)), x = gap + i * (bw + gap), y = d.net >= 0 ? mid - hgt : mid;
      const day = new Date(d.day + 'T12:00:00Z').toUTCString().slice(0, 3);
      return `<g><title>${esc(`${d.day}: income ${F.fmtCr(d.income)}, costs ${F.fmtCr(d.costs)}, profit ${F.fmtSigned(d.net)}`)}</title><rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw}" height="${hgt.toFixed(1)}" rx="3" class="${d.net >= 0 ? 'pos' : 'neg'}"/><text x="${(x + bw / 2).toFixed(1)}" y="${H - 2}" text-anchor="middle">${day}</text></g>`;
    }).join('');
    const chart = `<svg class="hqChart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Profit per day, last 7 days"><line x1="0" x2="${W}" y1="${mid}" y2="${mid}" class="axis"/>${bars}</svg>`;
    const names = Object.fromEntries(v.vessels.map((x) => [x.id, x.name]));
    for (const l of m.lost || []) if (!names[l.id]) names[l.id] = `${l.name} (${l.how})`;
    const rows = Object.entries(m.perShip || {}).map(([id, p]) => `<tr><td>${esc(names[id] || id)}</td><td class="num">${F.fmtSigned(p.today.income)}</td><td class="num">${F.fmtSigned(-p.today.costs)}</td><td class="num"><b class="${p.today.net >= 0 ? 'pos' : 'neg'}">${F.fmtSigned(p.today.net)}</b></td><td class="num">${F.fmtSigned(p.d7.income)}</td><td class="num">${F.fmtSigned(-p.d7.costs)}</td><td class="num"><b class="${p.d7.net >= 0 ? 'pos' : 'neg'}">${F.fmtSigned(p.d7.net)}</b></td></tr>`).join('');
    const cats = Object.entries(d7.byCat || {}).filter(([c, a]) => c !== 'ships' && c !== 'income' && a < 0).sort((a, b) => a[1] - b[1]);
    const catMax = Math.max(1, ...cats.map(([, a]) => -a));
    const catRows = cats.map(([c, a]) => `<li><span>${esc(F.CAT_LABEL[c] || c)}</span><i style="width:${Math.round((-a / catMax) * 100)}%"></i><b>${F.fmtCr(-a)}</b></li>`).join('');
    return `<div class="hqSec"><div class="hqSecH"><h2>${ic('coins')} Money</h2><span class="muted small">whole credits, UTC days</span></div>
      <div class="hqTiles">${tile('Cash', F.fmtCr(v.cash))}${tile('Owed', F.fmtCr(v.owed), v.owed > 0 ? 'bad' : '')}${tile('Today income', F.fmtCr(t.income))}${tile('Today costs', F.fmtCr(t.costs))}${tile('Today profit', F.fmtSigned(t.net), t.net >= 0 ? 'pos' : 'neg')}
        ${tile('7 days income', F.fmtCr(d7.income))}${tile('7 days costs', F.fmtCr(d7.costs))}${tile('7 days profit', F.fmtSigned(d7.net), d7.net >= 0 ? 'pos' : 'neg')}${tile('Ships bought / sold (7 d)', F.fmtSigned(d7.ships))}</div>
      ${v.owed > 0 ? `<p class="flWarn">${ic('warning')} The office owes ${F.fmtCr(v.owed)}. It is paid first from the next income; until then no ship departs on a new order and no ship can be bought.</p>` : ''}
      <h3 class="subHead">${ic('chart')} Profit per day</h3>${chart}
      <h3 class="subHead">${ic('ship')} Per ship</h3>
      <div class="hqTableWrap"><table class="hqTable"><thead><tr><th>Ship</th><th class="num">Income today</th><th class="num">Costs today</th><th class="num">Profit today</th><th class="num">Income 7 d</th><th class="num">Costs 7 d</th><th class="num">Profit 7 d</th></tr></thead><tbody>${rows}</tbody></table></div>
      <h3 class="subHead">${ic('list')} Costs by kind, 7 days</h3><ul class="hqCats">${catRows || '<li class="muted">No costs this week.</li>'}</ul></div>`;
  }
  officeHTML(v, now) {
    const laid = v.vessels.filter((x) => x.status === 'laidup');
    const cells = [];
    for (let i = 0; i < v.slotsMax; i++) {
      const s = laid[i];
      if (i < v.slots) cells.push(s ? `<div class="flSlot used"><b>${esc(s.name)}</b><small>${esc(s.clsName)} · ${F.fmtCr(s.costNow?.crPerDay)}/day</small></div>` : '<div class="flSlot free"><small>Free place</small></div>');
      else cells.push(`<div class="flSlot locked"><small>${ic('plus')}</small></div>`);
    }
    const docked = this.app.you?.docked;
    const homeHere = docked && docked !== v.home;
    const hm = v.homeMove || {};
    const canSlot = this.app.you?.docked === v.home ? (v.slots < v.slotsMax ? (v.cash >= v.slotPrice ? true : `You have ${F.fmtCr(v.cash)}.`) : 'Storage is at its maximum.') : `Buy places at ${F.shortName(v.homeName)}, moored there.`;
    const hereName = homeHere ? F.shortName(this.harbors().find((h) => h.id === docked)?.name || docked) : '';
    const homeBtn = homeHere ? `<span class="flBtnWrap"><button data-act="flHomeSet" data-h="${esc(docked)}"${hm.allowed === true ? '' : ' disabled'}>${ic('star')} Make ${esc(hereName)} your home${hm.cost ? ` · ${F.fmtCr(hm.cost)}` : ' · free'}</button>${hm.allowed === true ? '' : `<small class="flWhy">${esc(hm.allowed)}</small>`}</span>` : `<small class="muted">Moor in another regional, major or mega port to move your office there.</small>`;
    const lost = (v.money.lost || []).slice().reverse().map((l) => `<li><b>${esc(l.name)}</b><span class="muted">${esc(l.cls)} · ${esc(l.how)} · ${F.fmtAgo(l.at, now)}</span></li>`).join('');
    return `<div class="hqSec"><div class="hqSecH"><h2>${ic('anchor')} Office</h2></div>
      <div class="hqGrid2"><div class="card"><h3>${ic('star')} Home · ${esc(F.shortName(v.homeName))}</h3><p class="muted">Your office and boat storage. Your ships pay no berth fees here.</p><div class="flBtns">${homeBtn}</div></div>
        <div class="card"><h3>${ic('gauge')} Running costs now</h3><dl class="kv"><dt>Captains and crews</dt><dd>${F.fmtN(v.costPerH)} cr/h</dd><dt>Boat storage</dt><dd>${F.fmtN(v.storagePerDay)} cr/day</dd><dt>Fleet value</dt><dd>${F.fmtCr(v.value)}</dd><dt>Ships</dt><dd>${v.n} of ${v.max}</dd></dl></div></div>
      <div class="card flStorage"><h3>${ic('hold')} Boat storage <small class="muted">${v.used} of ${v.slots} places used</small></h3><div class="flSlots">${cells.join('')}</div>
        <div class="flBtns"><span class="flBtnWrap"><button data-act="flSlot"${canSlot === true ? '' : ' disabled'}>${ic('plus')} Buy a place · ${F.fmtCr(v.slotPrice)}</button>${canSlot === true ? '' : `<small class="flWhy">${esc(canSlot)}</small>`}</span></div></div>
      <h3 class="subHead">${ic('list')} Ships sold, scrapped, traded or lost</h3><ul class="hqLost">${lost || '<li class="muted">None yet.</li>'}</ul></div>`;
  }
  logHTML(v, now) {
    const rows = (v.log || []).slice().reverse().map((l) => {
      const s = l.vid && v.vessels.find((x) => x.id === l.vid);
      const chip = s ? `<button class="chip ghost hqLogShip" data-hq="logShip" data-vid="${esc(s.id)}">${esc(s.name)}</button>` : '';
      const text = s && l.text.startsWith(`${s.name}: `) ? l.text.slice(s.name.length + 2) : l.text;
      return `<li class="${l.kind === 'warn' ? 'warn' : ''}"><time>${esc(F.fmtAgo(l.t, now))}</time>${chip}<span>${esc(text)}</span></li>`;
    }).join('');
    return `<div class="hqSec"><div class="hqSecH"><h2>${ic('list')} Ships' log</h2><span class="muted small">newest first</span></div><ul class="hqLog">${rows || '<li class="muted">Nothing yet.</li>'}</ul></div>`;
  }
}

/** The HQ map: equirectangular, lon scaled by cos(lat) at the centre; world.png (region.png inside the North Sea window). */
export class HqMap {
  constructor(canvas, hq) {
    this.c = canvas; this.hq = hq; this.ctx = canvas.getContext('2d');
    this.cLat = 54; this.cLon = 4; this.scale = 60;        // px per degree of latitude (CSS px)
    this.img = { world: loadImg('/api/chart/world.png'), region: loadImg('/api/chart/region.png') };
    for (const k of ['world', 'region']) this.img[k].onload = () => this.draw();
    this.pointers = new Map(); this.hit = [];
    this.bind();
    // the pane changes size with the window, the tab (phones) and when fleet.css arrives after the first layout
    if (typeof ResizeObserver === 'function') { this.ro = new ResizeObserver(() => { const r = canvas.getBoundingClientRect(); if (Math.abs(r.width - (this.w || 0)) > 0.5 || Math.abs(r.height - (this.h || 0)) > 0.5) { this.resize(); if (!this.userMoved) this.fitAll(); } }); this.ro.observe(canvas.parentElement || canvas); }
  }
  resize() {
    const r = this.c.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
    if (r.width < 2 || r.height < 2) return;
    this.w = r.width; this.h = r.height;
    this.c.width = Math.round(r.width * dpr); this.c.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }
  k() { return Math.max(0.05, Math.cos(this.cLat * D2R)); }
  toXY(lat, lon) { let dl = lon - this.cLon; if (dl > 180) dl -= 360; if (dl < -180) dl += 360; return [this.w / 2 + dl * this.scale * this.k(), this.h / 2 - (lat - this.cLat) * this.scale]; }
  toLL(x, y) { return { lat: this.cLat - (y - this.h / 2) / this.scale, lon: this.cLon + (x - this.w / 2) / (this.scale * this.k()) }; }
  points() {
    const v = this.hq.view; if (!v) return [];
    const pts = [];
    for (const s of v.vessels) { pts.push([s.lat, s.lon]); for (const q of s.route || []) pts.push(q); }
    const home = this.hq.harbors().find((h) => h.id === v.home); if (home) pts.push([home.lat, home.lon]);
    return pts;
  }
  fitAll() {
    if (!this.w) this.resize();
    if (!this.w) return;
    const b = F.fitBounds(this.points(), 0.15, 2);
    this.cLat = (b.latMin + b.latMax) / 2; this.cLon = (b.lonMin + b.lonMax) / 2;
    const k = this.k();
    this.scale = Math.max(2, Math.min(this.h / (b.latMax - b.latMin), this.w / ((b.lonMax - b.lonMin) * k)));
    this.userMoved = false;
    this.draw();
  }
  centre(lat, lon) { if (Number.isFinite(lat)) { this.userMoved = true; this.cLat = lat; this.cLon = lon; this.scale = Math.max(this.scale, 40); this.draw(); } }
  zoom(f, x = this.w / 2, y = this.h / 2) {
    this.userMoved = true;
    const before = this.toLL(x, y);
    this.scale = Math.max(1.5, Math.min(4000, this.scale * f));
    const after = this.toLL(x, y);
    this.cLat += before.lat - after.lat; this.cLon += before.lon - after.lon;
    this.cLat = Math.max(-80, Math.min(80, this.cLat));
    this.draw();
  }
  bind() {
    const c = this.c;
    c.addEventListener('wheel', (e) => { e.preventDefault(); const r = c.getBoundingClientRect(); this.zoom(e.deltaY < 0 ? 1.25 : 0.8, e.clientX - r.left, e.clientY - r.top); }, { passive: false });
    c.addEventListener('pointerdown', (e) => { c.setPointerCapture(e.pointerId); this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t: Date.now() }); });
    c.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId); if (!p) return;
      if (this.pointers.size === 1) {
        const dx = e.clientX - p.x, dy = e.clientY - p.y;
        this.cLat = Math.max(-80, Math.min(80, this.cLat + dy / this.scale)); this.cLon -= dx / (this.scale * this.k()); if (dx || dy) this.userMoved = true;
        p.x = e.clientX; p.y = e.clientY; this.draw();
      } else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const d0 = Math.hypot(a.x - b.x, a.y - b.y);
        p.x = e.clientX; p.y = e.clientY;
        const d1 = Math.hypot(a.x - b.x, a.y - b.y);
        if (d0 > 10) { const r = c.getBoundingClientRect(); this.zoom(d1 / d0, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top); }
      }
    });
    const up = (e) => {
      const p = this.pointers.get(e.pointerId); this.pointers.delete(e.pointerId);
      if (p && Math.hypot(e.clientX - p.x0, e.clientY - p.y0) < 6 && Date.now() - p.t < 400) {
        const r = c.getBoundingClientRect(); this.tap(e.clientX - r.left, e.clientY - r.top);
      }
    };
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', (e) => this.pointers.delete(e.pointerId));
  }
  tap(x, y) {
    let best = null, bd = 22;
    for (const h of this.hit) { const d = Math.hypot(h.x - x, h.y - y); if (d < bd) { bd = d; best = h; } }
    if (best) this.hq.focus(best.id);
  }
  draw() {
    if (!this.w) return;
    const g = this.ctx, W = this.w, H = this.h;
    g.fillStyle = '#0b2236'; g.fillRect(0, 0, W, H);
    // the chart image
    const tl = this.toLL(0, 0), br = this.toLL(W, H);
    const inRegion = tl.lat <= REGION.latMax && br.lat >= REGION.latMin && tl.lon >= REGION.lonMin && br.lon <= REGION.lonMax;
    const useReg = inRegion && this.img.region.complete && this.img.region.naturalWidth > 0;
    const im = useReg ? this.img.region : this.img.world;
    if (im.complete && im.naturalWidth > 0) {
      const ext = useReg ? REGION : { lonMin: -180, lonMax: 180, latMin: -90, latMax: 90 };
      const iw = im.naturalWidth, ih = im.naturalHeight;
      const lon0 = Math.max(ext.lonMin, tl.lon), lon1 = Math.min(ext.lonMax, br.lon), lat1 = Math.min(ext.latMax, tl.lat), lat0 = Math.max(ext.latMin, br.lat);
      if (lon1 > lon0 && lat1 > lat0) {
        const sx = ((lon0 - ext.lonMin) / (ext.lonMax - ext.lonMin)) * iw, sw = ((lon1 - lon0) / (ext.lonMax - ext.lonMin)) * iw;
        const sy = ((ext.latMax - lat1) / (ext.latMax - ext.latMin)) * ih, sh = ((lat1 - lat0) / (ext.latMax - ext.latMin)) * ih;
        const [dx0, dy0] = this.toXY(lat1, lon0), [dx1, dy1] = this.toXY(lat0, lon1);
        g.imageSmoothingEnabled = true;
        try { g.drawImage(im, sx, sy, Math.max(0.5, sw), Math.max(0.5, sh), dx0, dy0, dx1 - dx0, dy1 - dy0); } catch { /* not decoded yet */ }
        g.fillStyle = 'rgba(6, 22, 38, 0.5)'; g.fillRect(0, 0, W, H);
      }
    }
    this.graticule(tl, br);
    const v = this.hq.view; this.hit = [];
    if (!v) return;
    const harbors = this.hq.harbors();
    // harbours (dots), the home star
    g.font = '11px system-ui, sans-serif'; g.textBaseline = 'middle';
    if (this.scale > 25) for (const h of harbors) { const [x, y] = this.toXY(h.lat, h.lon); if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue; g.fillStyle = 'rgba(200, 220, 235, 0.55)'; g.beginPath(); g.arc(x, y, 2.2, 0, Math.PI * 2); g.fill(); if (this.scale > 70) { g.fillStyle = 'rgba(200, 220, 235, 0.65)'; g.fillText(F.shortName(h.name), x + 5, y); } }
    const home = harbors.find((h) => h.id === v.home);
    if (home) { const [x, y] = this.toXY(home.lat, home.lon); star(g, x, y, 10, '#ffd27a'); g.font = '600 11px system-ui, sans-serif'; const t = `${F.shortName(home.name)} · home`, tw = g.measureText(t).width; label(g, t, x - tw / 2, y + 20, '#ffd27a', true, 11); }
    // routes
    for (const s of v.vessels) {
      if (!s.route || !s.route.length) continue;
      const col = F.stateColor(s.state);
      g.save(); g.strokeStyle = col; g.globalAlpha = 0.9; g.lineWidth = 2; g.setLineDash([6, 5]);
      g.beginPath(); let [x, y] = this.toXY(s.lat, s.lon); g.moveTo(x, y);
      for (const q of s.route) { [x, y] = this.toXY(q[0], q[1]); g.lineTo(x, y); }
      g.stroke(); g.restore();
      const end = s.route[s.route.length - 1], [ex, ey] = this.toXY(end[0], end[1]);
      flag(g, ex, ey, col);
      if (Number.isFinite(s.task?.etaS)) label(g, `ETA ${F.fmtHm(s.task.etaS)}`, ex + 8, ey - 14, col);
    }
    // ships: laid up and moored under the ships at sea
    const order = [...v.vessels].sort((a, b) => (a.aboard - b.aboard) || (a.state === 'at_sea') - (b.state === 'at_sea'));
    const cells = new Map(), placed = [];
    for (const s of order) {                // ships in one harbour: markers side by side, labels stacked to the right
      const [x0, y0] = this.toXY(s.lat, s.lon);
      const key = `${Math.round(x0 / 16)},${Math.round(y0 / 16)}`;
      let c = cells.get(key); if (!c) cells.set(key, (c = { x: x0, y: y0, n: 0 }));
      placed.push({ s, x: c.x + c.n * 12, y: c.y, cell: c, i: c.n++ });
    }
    for (const q of placed) {
      const s = q.s, col = F.stateColor(s.state);
      if (this.hq.sel === s.id) { g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.arc(q.x, q.y, 14, 0, Math.PI * 2); g.stroke(); }
      if (s.aboard) diamond(g, q.x, q.y, 9, col); else if (s.state === 'at_sea') tri(g, q.x, q.y, 8, s.hdg || 0, col); else dot(g, q.x, q.y, 6, col);
      this.hit.push({ id: s.id, x: q.x, y: q.y });
    }
    for (const q of placed) {
      const s = q.s, c = q.cell, ly = c.y - (c.n - 1 - q.i) * 18;   // stacked upwards: the home label sits below the marker
      label(g, `${s.name}${s.aboard ? ' (you)' : s.state === 'laid_up' ? ' (laid up)' : ''}`, c.x + 6 + c.n * 12, ly, s.aboard ? '#ffffff' : '#dbe8f2', true);
    }
  }
  graticule(tl, br) {
    const g = this.ctx, span = tl.lat - br.lat;
    const step = span > 120 ? 30 : span > 50 ? 10 : span > 20 ? 5 : span > 8 ? 2 : span > 3 ? 1 : 0.5;
    g.strokeStyle = 'rgba(150, 195, 230, 0.10)'; g.lineWidth = 1; g.fillStyle = 'rgba(150, 195, 230, 0.45)'; g.font = '10px system-ui, sans-serif';
    for (let lat = Math.ceil(br.lat / step) * step; lat <= tl.lat; lat += step) { const [, y] = this.toXY(lat, this.cLon); g.beginPath(); g.moveTo(0, y); g.lineTo(this.w, y); g.stroke(); g.fillText(`${Math.abs(lat)}°${lat >= 0 ? 'N' : 'S'}`, 4, y - 6); }
    for (let lon = Math.ceil(tl.lon / step) * step; lon <= br.lon; lon += step) { const [x] = this.toXY(this.cLat, lon); g.beginPath(); g.moveTo(x, 0); g.lineTo(x, this.h); g.stroke(); g.fillText(`${Math.abs(lon)}°${lon >= 0 ? 'E' : 'W'}`, x + 3, this.h - 6); }
  }
}

function loadImg(src) { const i = new Image(); i.decoding = 'async'; i.src = src; return i; }
function tri(g, x, y, r, hdg, col) {
  const a = hdg * D2R;
  g.save(); g.translate(x, y); g.rotate(a);
  g.beginPath(); g.moveTo(0, -r * 1.3); g.lineTo(r * 0.8, r); g.lineTo(0, r * 0.5); g.lineTo(-r * 0.8, r); g.closePath();
  g.fillStyle = col; g.fill(); g.lineWidth = 1.5; g.strokeStyle = '#06111c'; g.stroke(); g.restore();
}
function diamond(g, x, y, r, col) { g.beginPath(); g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y); g.closePath(); g.fillStyle = col; g.fill(); g.lineWidth = 2; g.strokeStyle = '#ffffff'; g.stroke(); }
function dot(g, x, y, r, col) { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fillStyle = col; g.fill(); g.lineWidth = 1.5; g.strokeStyle = '#06111c'; g.stroke(); }
function star(g, x, y, r, col) { g.beginPath(); for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.45 : r; g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); } g.closePath(); g.fillStyle = col; g.fill(); g.lineWidth = 1; g.strokeStyle = '#201500'; g.stroke(); }
function flag(g, x, y, col) { g.strokeStyle = col; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x, y); g.lineTo(x, y - 14); g.stroke(); g.fillStyle = col; g.beginPath(); g.moveTo(x, y - 14); g.lineTo(x + 9, y - 11); g.lineTo(x, y - 8); g.closePath(); g.fill(); }
function label(g, text, x, y, col, bold = false, px = 12) {
  g.font = `${bold ? '600 ' : ''}${px}px system-ui, sans-serif`; g.textBaseline = 'middle';
  const w = g.measureText(text).width;
  g.fillStyle = 'rgba(6, 17, 28, 0.78)'; g.fillRect(x - 3, y - 8, w + 6, 16);
  g.fillStyle = col; g.fillText(text, x, y);
}
