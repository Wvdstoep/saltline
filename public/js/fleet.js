// v6 fleet, client (docs/V6-FLEET-CONTRACTS.md §9, §12): app.fleetUi. Holds the last `fleet` message, renders the
// harbour sheet's Office tab and the ship cards (shared with the HQ, public/js/hq.js), the top-bar fleet chip, the
// shipyard trade-in box, and every fleet dialog: take the helm (with what the ship you leave does), orders (sail to …,
// home, hold, contract board, lay up, stop), services, rename, cargo/contract transfer, confirms. Actions go out as
// `net.action(name, fields)`; buttons carry data-act="fl…" and reach sheetAction() from the HUD or the HQ.
import { ic } from './icons.js';
import { FLEET, validShipName } from '/shared/fleet.js';
import { SHIP_CLASSES, GOODS } from '/shared/constants.js';
import { serviceKn } from '/shared/rates.js';
import * as F from './fleetfmt.js';

function ensureCss(id, href) {
  if (document.getElementById(id)) return;
  const l = document.createElement('link'); l.id = id; l.rel = 'stylesheet'; l.href = href;
  document.head.appendChild(l);
}
const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ss = { get(k, d) { try { const v = sessionStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } } };
const clsName = (c) => SHIP_CLASSES[c]?.name || c;
const nowS = (app) => (Number.isFinite(app?.simTime) ? app.simTime : Date.now() / 1000);

/** One button: enabled when `can === true`, else disabled with the reason under it. */
function btn(act, label, can, attrs = '', cls = '') {
  const ok = can === true;
  const why = !ok && typeof can === 'string' ? `<small class="flWhy">${esc(can)}</small>` : '';
  return `<span class="flBtnWrap"><button class="${cls}" data-act="${act}" ${attrs}${ok ? '' : ' disabled aria-disabled="true"'}>${label}</button>${why}</span>`;
}
function bar(label, icon, f, tone, text) {
  return `<div class="flBar ${tone}" title="${esc(label)}"><span class="flBarL">${ic(icon)}<span>${esc(label)}</span></span><span class="flBarT"><i style="width:${Math.round(f * 100)}%"></i></span><b>${esc(text)}</b></div>`;
}

/**
 * A ship card (§9.2) for the HQ and the harbour Office tab. ctx = { now, harbors, thumb(cls, opts) → html, here?: true
 * (harbour sheet: "Go aboard (free)" + transfers), selected?: id }.
 */
export function cardHTML(v, ctx = {}) {
  const st = v.state, now = ctx.now ?? Date.now() / 1000;
  const thumb = ctx.thumb ? ctx.thumb(v.cls, { w: 176, h: 110, angle: 'quarter', wear: 1 - (v.cond ?? 100) / 100 }) : `<span class="flThumbPh">${ic('ship')}</span>`;
  const fuel = F.barOf(v.fuel, v.fuelCap), hull = F.barOf(v.cond, 100);
  const hold = v.capacity >= 5 ? F.barOf(v.cargoT, v.capacity) : null;
  const holdTxt = v.capacity >= 5 ? `${F.fmtT(v.cargoT)} / ${F.fmtT(v.capacity)}` : `${v.paxUsed}/${v.pax} pax`;
  const sel = ctx.selected === v.id ? ' sel' : '';
  const task = F.fmtTask(v, now);
  const why = v.task?.why && !['waiting', 'failed'].includes(v.task.phase) ? '' : '';
  const pos = F.fmtPos(v, ctx.harbors);
  const spd = st === 'at_sea' && Number.isFinite(v.spd) ? ` · ${v.spd.toFixed(1)} kn` : '';
  const cost = F.fmtCost(v.costNow);
  const helmLbl = v.can.helm === true ? (v.can.helmFee > 0 ? `${ic('ship')} Take the helm · ${F.fmtCr(v.can.helmFee)}` : `${ic('ship')} ${ctx.here ? 'Go aboard (free)' : 'Take the helm · free'}`) : `${ic('ship')} Take the helm`;
  let btns = '';
  if (v.aboard) {
    btns = `<span class="chip good">${ic('person')} You are aboard</span>${btn('flRename', `${ic('tag')} Rename`, true, `data-vid="${esc(v.id)}"`, 'small ghost')}`;
  } else {
    btns += btn('flHelm', helmLbl, v.can.helm, `data-vid="${esc(v.id)}"`, 'primary');
    if (v.status !== 'laidup') btns += btn('flOrders', `${ic('route')} Orders ${ic('chevronDown')}`, v.can.orders, `data-vid="${esc(v.id)}"`);
    if (v.harbor && v.status !== 'laidup') btns += btn('flSvc', `${ic('wrench')} Services ${ic('chevronDown')}`, v.can.services, `data-vid="${esc(v.id)}"`);
    if (ctx.here && v.harbor && v.status !== 'laidup') btns += btn('flTransfer', `${ic('crate')} Transfer…`, true, `data-vid="${esc(v.id)}"`);
    if (v.status === 'laidup') btns += btn('flRecom', `${ic('play')} Recommission · ${F.fmtCr(v.can.recommissionFee)}`, v.can.recommission, `data-vid="${esc(v.id)}"`);
    else if (v.harbor) btns += btn('flLayup', `${ic('anchor')} Lay up`, v.can.layUp, `data-vid="${esc(v.id)}"`);
    if (v.harbor) btns += btn('flSell', `${ic('coins')} ${v.can.sellValue > 0 ? `Sell · ${F.fmtCr(v.can.sellValue)}` : 'Scrap · 0 cr'}`, v.can.sell, `data-vid="${esc(v.id)}"`, 'ghost');
    btns += btn('flRename', `${ic('tag')} Rename`, true, `data-vid="${esc(v.id)}"`, 'ghost');
  }
  const jobs = (v.jobs || []).length ? `<ul class="flJobs">${v.jobs.map((j) => `<li>${ic('contract')}<span>${esc(j.title)}</span><b>${F.fmtCr(j.pay)}</b>${Number.isFinite(j.leftH) ? `<small class="${j.leftH < 2 ? 'bad' : ''}">${j.leftH < 0 ? 'late' : `${F.fmtDur(j.leftH * 3600)} left`}</small>` : ''}</li>`).join('')}</ul>` : '';
  void why;
  return `<article class="card flCard ${F.chipClass(st)}${sel}${v.aboard ? ' aboard' : ''}" data-vid="${esc(v.id)}">
    <div class="flTop">${thumb}<div class="flName"><b>${esc(v.name)}</b><small>${esc(v.clsName || clsName(v.cls))}</small></div><span class="chip flState ${F.chipClass(st)}">${esc(F.stateLabel(st))}</span></div>
    <div class="flTask">${esc(task)}${v.task?.why && ['waiting', 'failed'].includes(v.task.phase) ? '' : ''}</div>
    <div class="flPos">${ic('pin')}<span>${esc(pos)}${esc(spd)}</span><button class="iconBtn small flMapBtn" data-act="flMap" data-vid="${esc(v.id)}" title="Show on the map" aria-label="Show ${esc(v.name)} on the map">${ic('chart')}</button></div>
    <div class="flBars">${bar('Fuel', 'fuel', fuel.f, fuel.tone, `${Math.round(fuel.f * 100)} %`)}${bar('Hull', 'hull', hull.f, hull.tone, `${Math.round(v.cond)} %`)}${hold ? bar('Hold', 'crate', hold.f, 'good', holdTxt) : `<div class="flBar"><span class="flBarL">${ic('users')}<span>Berths</span></span><b>${esc(holdTxt)}</b></div>`}</div>
    ${jobs}
    <div class="flMoney"><span>Profit 7 d <b class="${v.profit.d7 >= 0 ? 'pos' : 'neg'}">${esc(F.fmtSigned(v.profit.d7))}</b></span><span class="muted">${esc(cost)}</span></div>
    <div class="flBtns">${btns}</div>
  </article>`;
}

export class FleetUi {
  constructor(app) {
    this.app = app;
    this.last = null;          // FleetView of the last `fleet` message
    this.board = null;         // the last `fleet_board` answer
    this.dlg = null;           // { kind, vid, … } of the open dialog
    this.tradeIn = ss.get('flTradeIn', false) === true;   // session only, never on by itself
    try { ensureCss('flCss', 'css/fleet.css'); this.inject(); } catch (e) { console.warn('[fleet] ui unavailable', e); }
  }

  // ---------------------------------------------------------------------------------------------- messages
  onFleet(view) {
    if (!view || !Array.isArray(view.vessels)) return;
    this.last = view;
    this.updateChip(this.app.you);
    const hud = this.app.hud;
    if (hud?.harborOpen?.() && hud.harborTab === 'office') hud.renderTab?.('office');
    if (this.dlg && this.dlg.live) this.renderDialog();
    else if (this.dlg && this.dlg.kind === 'helm') {   // phase 2: the switch cooldown ends / the fee changes while the dialog is open
      const v = this.vessel(this.dlg.vid), key = v ? `${v.can.helm}|${v.can.helmFee}` : '';
      if (key !== this.dlg.key) {
        const pick = $('flDlg')?.querySelector('input[name="leave"]:checked')?.value;
        this.dlg.key = key; this.renderDialog();
        const r = pick && $('flDlg')?.querySelector(`input[name="leave"][value="${pick}"]`); if (r) r.checked = true;
      }
    }
  }
  onBoard(m) { this.board = m; if (this.dlg && this.dlg.kind === 'board' && this.dlg.vid === m.vesselId) this.renderDialog(); }
  vessel(id) { return this.last?.vessels?.find((v) => v.id === id) || this.app.hud?.harborData?.fleetHere?.find?.((v) => v.id === id) || null; }
  aboardView() { return this.last?.vessels?.find((v) => v.aboard) || null; }
  harbors() { return this.app.world?.harbors || []; }
  act(name, fields = {}) { try { this.app.net?.action?.(name, fields); } catch (e) { console.warn('[fleet] send failed', e); } }
  thumb() { const h = this.app.hud; return h && typeof h.thumbHTML === 'function' ? (cls, o) => h.thumbHTML(cls, o) : null; }
  ctx(extra = {}) { return { now: nowS(this.app), harbors: this.harbors(), thumb: this.thumb(), ...extra }; }

  // ---------------------------------------------------------------------------------------------- chip, menu, fade
  inject() {
    const top = $('topbar');
    if (top && !$('fleetChip')) {
      const b = document.createElement('button'); b.id = 'fleetChip'; b.className = 'flChip'; b.title = 'Fleet HQ (O)';
      b.innerHTML = `${ic('anchor')}<span class="flChipT">1</span><i class="flDot hidden"></i>`;
      b.onclick = () => this.app.hq?.toggle?.();
      top.appendChild(b);
    }
    // the harbour sheet's Office tab: nav button before "Players", its section before #tab-players (§9.3)
    const nav = $('harborNav');
    if (nav && !nav.querySelector('button[data-tab="office"]')) {
      const b = document.createElement('button'); b.dataset.tab = 'office';
      b.innerHTML = `<span class="si">${ic('anchor')}</span><span class="lbl">Office</span><span class="sl">Office</span>`;
      nav.insertBefore(b, nav.querySelector('button[data-tab="players"]'));
    }
    const players = $('tab-players');
    if (players && !$('tab-office')) {
      const sec = document.createElement('section'); sec.className = 'tab hidden'; sec.id = 'tab-office';
      players.parentNode.insertBefore(sec, players);
    }
    const sheet = $('moreSheet');
    if (sheet && !$('btnFleet')) {
      const b = document.createElement('button'); b.id = 'btnFleet'; b.className = 'menuBtn';
      b.innerHTML = `<span class="si">${ic('anchor')}</span><span class="lbl">Fleet (O)</span>`;
      b.onclick = () => { this.app.hud?.closeMore?.(); this.app.hq?.open?.(); };
      sheet.insertBefore(b, $('btnHelp') || null);
    }
  }
  /** "⚓ 3 · 2 at sea" with a red dot for unread log lines. */
  updateChip(you) {
    const b = $('fleetChip'); if (!b) return;
    const fl = (you && you.fleet) || (this.last ? { n: this.last.n, atSea: this.last.vessels.filter((v) => v.state === 'at_sea').length, unread: this.last.unread } : null);
    if (!fl) return;
    const t = b.querySelector('.flChipT'); if (t) t.textContent = fl.atSea ? `${fl.n} · ${fl.atSea} at sea` : `${fl.n}`;
    b.querySelector('.flDot')?.classList.toggle('hidden', !(fl.unread > 0));
    b.classList.toggle('owed', (fl.owed || 0) > 0);
  }
  /** The 350 ms fade with "Taking the helm of Kittiwake — at sea 22 nm W of Texel" (§9.4). */
  switchFade(you) {
    let el = $('flFade');
    if (!el) { el = document.createElement('div'); el.id = 'flFade'; document.body.appendChild(el); }
    const v = this.last?.vessels?.find((x) => x.id === you?.aboard);
    const where = v ? F.fmtPos(v, this.harbors()) : '';
    el.innerHTML = `<div>${ic('ship')}<b>Taking the helm of ${esc(you?.vesselName || v?.name || 'your ship')}</b><small>${esc(where)}</small></div>`;
    el.classList.remove('out'); el.classList.add('on');
    clearTimeout(this._fadeT);
    this._fadeT = setTimeout(() => { el.classList.add('out'); this._fadeT = setTimeout(() => el.classList.remove('on', 'out'), 400); }, 1400);
  }

  // ---------------------------------------------------------------------------------------------- chart (M) layer and lists
  /** Chart layer `fleet` (§9.4): your ships from the last `fleet` message (routes, ETA), others' fleet ships from
   *  app.fleetShips (snap.fleet). chart.js calls it like the market layer: `this.app.fleetUi?.drawChartLayer(this, this.ctx)`. */
  drawChartLayer(chart, g) {
    const v = this.last, now = nowS(this.app);
    g.save(); g.textBaseline = 'middle'; g.font = '600 11px system-ui, sans-serif';
    const vis = (p) => p.x > -40 && p.y > -40 && p.x < chart.W + 40 && p.y < chart.H + 40;
    for (const s of this.app.fleetShips?.values?.() || []) {
      if (s.ownerId === this.app.you?.id) continue;
      const c = s.cur || s, p = chart.project(c.lat, c.lon); if (!vis(p)) continue;
      g.fillStyle = 'rgba(200, 214, 226, 0.85)'; g.beginPath(); g.arc(p.x, p.y, 4, 0, Math.PI * 2); g.fill();
      if (chart.zoom >= 8) { g.fillStyle = 'rgba(220, 232, 242, 0.85)'; g.fillText(`${s.name} · ${s.owner}`, p.x + 7, p.y); }
    }
    for (const s of v?.vessels || []) {
      if (s.aboard) continue;                                   // your own ship is drawn by the chart itself
      const col = F.stateColor(s.state), p = chart.project(s.lat, s.lon);
      if (s.route && s.route.length) {
        g.save(); g.strokeStyle = col; g.lineWidth = 2; g.setLineDash([6, 5]); g.beginPath(); g.moveTo(p.x, p.y);
        for (const q of s.route) { const r = chart.project(q[0], q[1]); g.lineTo(r.x, r.y); }
        g.stroke(); g.restore();
        const e = s.route[s.route.length - 1], ep = chart.project(e[0], e[1]);
        if (Number.isFinite(s.task?.etaS) && vis(ep)) { g.fillStyle = col; g.fillText(`ETA ${F.fmtEta(s.task.etaS, now)}`, ep.x + 6, ep.y - 10); }
      }
      if (!vis(p)) continue;
      g.save(); g.translate(p.x, p.y); g.rotate(((s.hdg || 0) * Math.PI) / 180);
      g.beginPath(); g.moveTo(0, -9); g.lineTo(6, 7); g.lineTo(0, 3.5); g.lineTo(-6, 7); g.closePath();
      g.fillStyle = col; g.fill(); g.lineWidth = 1.5; g.strokeStyle = '#06111c'; g.stroke(); g.restore();
      g.fillStyle = '#e8f1f8'; g.fillText(`${s.name}${s.state === 'laid_up' ? ' (laid up)' : ''}`, p.x + 9, p.y);
    }
    g.restore();
  }
  /** chart.hitShip: `consider(lat, lon, obj)` for every fleet ship on the chart. */
  chartHits(consider) {
    for (const s of this.last?.vessels || []) if (!s.aboard) consider(s.lat, s.lon, { kind: 'fleet', text: `${s.name} · yours · ${F.stateLabel(s.state)}`, data: s });
    for (const s of this.app.fleetShips?.values?.() || []) { if (s.ownerId === this.app.you?.id) continue; const c = s.cur || s; consider(c.lat, c.lon, { kind: 'fleet', text: `${s.name} · ${s.owner}`, data: s }); }
  }
  /** chart.showShipPopup for a fleet ship: text lines, and (own ship) an "Open in HQ" button. */
  chartPopup(hit, body) {
    const d = hit.data, own = !!d.task;
    const lines = own ? [`${d.clsName} · yours · ${F.stateLabel(d.state)}`, F.fmtTask(d, nowS(this.app)), F.fmtPos(d, this.harbors())]
      : [`${clsName(d.cls)} · ${d.owner}'s fleet · ${F.stateLabel(d.state)}`];
    for (const l of lines.filter(Boolean)) { const p = document.createElement('div'); p.textContent = l; body.appendChild(p); }
    if (own) { const b = document.createElement('button'); b.className = 'small primary'; b.textContent = 'Open in HQ'; b.onclick = () => { this.app.hq?.open?.('ships'); this.app.hq?.focus?.(d.id); }; body.appendChild(b); }
  }
  /** The Ships list (Tab): "Fleet ships" near you — no Board / Trade / Convoy buttons. */
  shipsListHTML(km) {
    const a = this.app, me = a.ship; if (!me) return '';
    const list = [...(a.fleetShips?.values?.() || [])].map((s) => ({ s, c: s.cur || s })).map((x) => ({ ...x, d: F.haversineM(me.lat, me.lon, x.c.lat, x.c.lon) })).sort((x, y) => x.d - y.d);
    if (!list.length) return '';
    const th = this.thumb();
    return `<h3 class="subHead">${ic('anchor')}Fleet ships</h3><div class="cards wide">${list.map(({ s, d }) => `<article class="card vesselCard">${th ? th(s.cls, { w: 264, h: 192, angle: 'quarter', wear: 1 - (s.cond ?? 100) / 100 }) : ''}
      <div class="vb"><b>${esc(s.name)}</b><small>${esc(clsName(s.cls))} · ${s.ownerId === a.you?.id ? 'yours' : esc(s.owner)}</small>
      <div class="vstats"><span>${km ? km(d) : F.fmtKm(d)}</span><span>${(s.cur?.spd ?? s.spd ?? 0).toFixed(1)} kn</span><span>${esc(F.stateLabel(s.state).toLowerCase())}</span></div></div></article>`).join('')}</div>`;
  }

  // ---------------------------------------------------------------------------------------------- harbour sheet: Office tab
  /** The harbour sheet's Office tab (§9.3): at home the office and storage; elsewhere ships here and the home move. */
  tabOffice(h, you) {
    if (!h) return '';
    const o = h.office || {}, here = h.fleetHere || [], cash = Math.floor(you?.money ?? this.last?.cash ?? 0);
    const name = F.shortName(h.name), home = F.shortName(o.homeName || o.home);
    let html = `<div class="secHead"><div><h2>${ic('anchor')} ${o.isHome ? `Your office · ${esc(name)}` : `Ships here · ${esc(name)}`}</h2>
      <p>${o.isHome ? 'Lay up ships you do not use, buy storage places and send your captains out from here. No berth fees at home.' : `Your office is at ${esc(home)}. Ships of yours moored here are listed below.`}</p></div>
      <div class="tools"><button data-act="flOpenHq">${ic('chart')} Fleet HQ (O)</button></div></div>`;
    if (o.isHome) html += this.storageHTML(o, cash, h);
    html += `<h3 class="subHead">${ic('ship')} Your ships in ${esc(name)} <small class="muted">${here.length}</small></h3>`;
    html += here.length ? `<div class="flCards">${here.map((v) => cardHTML(v, this.ctx({ here: true }))).join('')}</div>` : `<div class="empty">${ic('anchor')}<span>No ship of yours is moored here.</span></div>`;
    if (!o.isHome) html += this.homeMoveHTML(h, o);
    html += `<p class="muted small flFoot">${esc(`${h.fleetN ?? this.last?.n ?? 1} of ${FLEET.MAX_VESSELS} ships in your fleet.`)}${h.fleetFull ? ' Your fleet is full — sell or trade in a ship before buying another.' : ''}</p>`;
    return html;
  }
  storageHTML(o, cash, h) {
    const laid = (this.last?.vessels || h?.fleetHere || []).filter((v) => v.status === 'laidup');
    const cells = [];
    for (let i = 0; i < o.slotsMax; i++) {
      const v = laid[i];
      if (i < o.slots) cells.push(v ? `<div class="flSlot used"><b>${esc(v.name)}</b><small>${esc(clsName(v.cls))} · ${F.fmtCr(v.costNow?.crPerDay)}/day</small></div>` : `<div class="flSlot free"><small>Free place</small></div>`);
      else cells.push(`<div class="flSlot locked"><small>${ic('plus')}</small></div>`);
    }
    const canBuy = o.slots < o.slotsMax ? (cash >= o.slotPrice ? true : `You have ${F.fmtCr(cash)}.`) : 'Storage is at its maximum.';
    return `<div class="card flStorage"><h3>${ic('hold')} Boat storage <small class="muted">${o.used} of ${o.slots} places used · ${F.fmtCr(o.storagePerDay)}/day</small></h3>
      <div class="flSlots">${cells.join('')}</div>
      <div class="flBtns">${btn('flSlot', `${ic('plus')} Buy a place · ${F.fmtCr(o.slotPrice)}`, canBuy)}</div></div>`;
  }
  homeMoveHTML(h, o) {
    const hm = o.homeMove || { allowed: 'Not possible here.', cost: 0 };
    return `<div class="card flHomeCard"><h3>${ic('star')} Make ${esc(F.shortName(h.name))} your home</h3>
      <p>Your office and boat storage move here; your ships pay no berth fees at home. ${hm.cost ? `Moving costs ${F.fmtCr(hm.cost)}.` : 'The first move is free.'}</p>
      <div class="flBtns">${btn('flHomeSet', `${ic('star')} Move the office here${hm.cost ? ` · ${F.fmtCr(hm.cost)}` : ''}`, hm.allowed, `data-h="${esc(h.id)}"`)}</div></div>`;
  }

  // ---------------------------------------------------------------------------------------------- shipyard (§9.3)
  /** The "Trade in my current ship" box above the shipyard cards (unchecked unless the skipper ticked it this session). */
  tradeInBoxHTML(h) {
    const worth = F.fmtCr(h?.tradeIn ?? 0);
    return `<label class="flTradeIn"><input type="checkbox" data-act="flTradeInToggle"${this.tradeIn ? ' checked' : ''}> <span>Trade in my current ship <small class="muted">(worth ${esc(worth)})</small></span></label>
      ${h?.fleetFull && !this.tradeIn ? `<p class="flWarn">${ic('warning')} Fleet full (${FLEET.MAX_VESSELS} ships) — tick the box to trade in, or sell a ship first.</p>` : ''}`;
  }
  /** What the card shows: the full price with the box off, price − trade-in with it on. */
  netPrice(price, h) { return this.tradeIn ? Math.max(0, price - (h?.tradeIn ?? 0)) : price; }
  buyBlocked(h) { return !this.tradeIn && h?.fleetFull ? `Fleet full (${FLEET.MAX_VESSELS} ships)` : null; }
  confirmBuyText(className, price, h, you, used = false) {
    const mine = clsName(you?.ship?.cls);
    if (this.tradeIn) return `Buy ${used ? 'this second-hand' : 'a new'} ${className} for ${F.fmtCr(this.netPrice(price, h))} after trading in your ${mine}?`;
    return `Buy ${used ? 'this second-hand' : 'a new'} ${className} for ${F.fmtCr(price)}? She will be delivered here. Your ${mine} stays yours.`;
  }
  /** Fields for buy_ship / buy_used. */
  buyFields(sendHome = false) { return this.tradeIn ? { tradeIn: true } : { tradeIn: false, sendHome: !!sendHome }; }
  /** The shipyard buy flow: confirm (with "Then send her home" when away from home), then send. */
  buy(kind, idOrCls, price, className, h, you) {
    const homeAway = !this.tradeIn && this.app.you?.home && h && this.app.you.home !== h.id;
    this.confirm(this.confirmBuyText(className, price, h, you, kind === 'used'), (form) => {
      const f = this.buyFields(form?.sendHome);
      if (kind === 'used') this.act('buy_used', { listingId: idOrCls, ...f }); else this.act('buy_ship', { cls: idOrCls, ...f });
    }, { ok: 'Buy', extra: homeAway ? `<label class="flCheck"><input type="checkbox" name="sendHome"> Then send her home to ${esc(F.shortName(this.app.you.homeName))}</label>` : '' });
  }

  // ---------------------------------------------------------------------------------------------- actions
  /** data-act="fl…" from the harbour sheet, the HQ or a fleet dialog. Returns true when handled. */
  sheetAction(act, el) {
    const vid = el?.dataset?.vid, v = vid ? this.vessel(vid) : null;
    switch (act) {
      case 'flOpenHq': this.app.hq?.open?.(); return true;
      case 'flMap': if (this.app.hq) { this.app.hq.open?.('map'); this.app.hq.focus?.(vid); } return true;
      case 'flHelm': return this.openDialog({ kind: 'helm', vid }), true;
      case 'flHelmGo': return this.helmGo(), true;
      case 'flOrders': return this.openDialog({ kind: 'orders', vid }), true;
      case 'flSail': return this.openDialog({ kind: 'sail', vid, q: '' }), true;
      case 'flSailTo': this.act('fleet_order', { vesselId: vid, order: { type: 'sail_to', harbor: el.dataset.h, then: el.dataset.then || 'moor' } }); this.closeDialog(); return true;
      case 'flHome': this.act('fleet_order', { vesselId: vid, order: { type: 'home', then: el.dataset.then || 'moor' } }); this.closeDialog(); return true;
      case 'flHold': this.act('fleet_order', { vesselId: vid, order: { type: 'hold' } }); this.closeDialog(); return true;
      case 'flStop': this.act('fleet_order', { vesselId: vid, order: { type: 'stop' } }); this.closeDialog(); return true;
      case 'flWork': this.act('fleet_order', { vesselId: vid, order: { type: 'contract', jobId: null, then: el.dataset.then || 'stay' } }); this.closeDialog(); return true;
      case 'flTradeRun': {   // world economy §9.5: the World market's plan as a captain's trade_run (limits: +5 % buy, −5 % sale)
        const t = this.app.tradePlan; if (!t) return true;
        this.act('fleet_order', { vesselId: vid, order: { type: 'trade_run', good: t.good, buyAt: t.from, maxBuy: Math.round(t.buy * 1.05), qty: Math.round(t.qty), sellAt: t.reqId ? null : t.to, reqId: t.reqId || null, minSell: t.reqId ? 0 : Math.round((t.sellArrive || 0) * 0.95), then: 'moor' } });
        this.closeDialog(); return true;
      }
      case 'flBoard': this.board = null; this.act('fleet_board', { vesselId: vid }); this.openDialog({ kind: 'board', vid }); return true;
      case 'flAccept': this.act('fleet_accept', { vesselId: vid, jobId: el.dataset.jid, then: el.dataset.then || 'stay' }); this.closeDialog(); return true;
      case 'flSvc': return this.openDialog({ kind: 'services', vid }), true;
      case 'flSvcDo': this.act('fleet_service', { vesselId: vid, what: el.dataset.what }); this.closeDialog(); return true;
      case 'flRename': return this.openDialog({ kind: 'rename', vid }), true;
      case 'flRenameGo': return this.renameGo(), true;
      case 'flLayup': this.act('fleet_layup', { vesselId: vid }); this.closeDialog(); return true;
      case 'flRecom': if (v) this.confirm(`Recommission ${v.name} for ${F.fmtCr(v.can.recommissionFee)}? Her captain comes aboard and wages start when she sails.`, () => this.act('fleet_recommission', { vesselId: vid }), { ok: 'Recommission' }); return true;
      case 'flSell': if (v) this.confirm(v.can.sellValue > 0 ? `Sell ${v.name} (${v.clsName}, ${v.cond} %) for ${F.fmtCr(v.can.sellValue)}?` : `Scrap ${v.name}? The yard pays nothing for a ${String(v.clsName).toLowerCase()}.`, () => this.act('fleet_sell', { vesselId: vid }), { ok: v.can.sellValue > 0 ? 'Sell' : 'Scrap', danger: true }); return true;
      case 'flTransfer': return this.openDialog({ kind: 'transfer', vid }), true;
      case 'flTransferGo': return this.transferGo(el), true;
      case 'flMoveJob': this.act('fleet_move_job', { jobId: el.dataset.jid, fromId: el.dataset.from, toId: el.dataset.to }); this.closeDialog(); return true;
      case 'flSlot': { const o = this.app.hud?.harborData?.office || this.last; this.confirm(`Buy a boat storage place at ${F.shortName(this.last?.homeName || this.app.you?.homeName || 'home')} for ${F.fmtCr(o?.slotPrice ?? FLEET.SLOT_PRICE)}?`, () => this.act('fleet_slot', {}), { ok: 'Buy' }); return true; }
      case 'flHomeSet': this.confirm(`Move your office to ${F.shortName(this.harbors().find((x) => x.id === el.dataset.h)?.name || el.dataset.h)}?`, () => this.act('fleet_home', { harbor: el.dataset.h }), { ok: 'Move' }); return true;
      case 'flTradeInToggle': this.tradeIn = !!el.checked; ss.set('flTradeIn', this.tradeIn); this.app.hud?.renderTab?.('shipyard'); return true;
      case 'flClose': this.closeDialog(); return true;
      case 'flConfirmOk': { const cb = this._confirmCb; const form = this.formValues(); this.closeDialog(); cb?.(form); return true; }
      default: return false;
    }
  }
  formValues() { const out = {}; for (const i of $('flDlg')?.querySelectorAll('input, select') || []) out[i.name || i.id] = i.type === 'checkbox' ? i.checked : i.value; return out; }

  // ---------------------------------------------------------------------------------------------- dialogs
  ensureDialog() {
    let w = $('flDlg');
    if (w) return w;
    w = document.createElement('div'); w.id = 'flDlg'; w.className = 'flDlgWrap hidden';
    w.innerHTML = '<div class="flDlg" role="dialog" aria-modal="true" aria-labelledby="flDlgT"></div>';
    w.addEventListener('click', (e) => {
      if (e.target === w) return this.closeDialog();
      const el = e.target.closest('[data-act]');
      if (el && !el.disabled && el.tagName !== 'INPUT') this.sheetAction(el.dataset.act, el);
    });
    w.addEventListener('input', (e) => { if (e.target.id === 'flSailQ' && this.dlg) { this.dlg.q = e.target.value; this.renderDialog(true); } });
    w.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); this.closeDialog(); }
      if (e.key === 'Enter' && e.target.id === 'flRenameIn') this.renameGo();
    });
    document.body.appendChild(w);
    return w;
  }
  openDialog(d) { this.dlg = d; if (d.kind === 'helm') { const v = this.vessel(d.vid); d.key = v ? `${v.can.helm}|${v.can.helmFee}` : ''; } this.ensureDialog().classList.remove('hidden'); this.renderDialog(); }
  closeDialog() { this.dlg = null; this._confirmCb = null; $('flDlg')?.classList.add('hidden'); }
  isDialogOpen() { return !!this.dlg; }
  confirm(text, cb, o = {}) {
    this._confirmCb = cb;
    this.openDialog({ kind: 'confirm', text, ok: o.ok || 'OK', danger: !!o.danger, extra: o.extra || '' });
  }
  renderDialog(keepInput = false) {
    const w = this.ensureDialog(), box = w.querySelector('.flDlg'), d = this.dlg;
    if (!d) return;
    const v = d.vid ? this.vessel(d.vid) : null;
    const head = (title, sub = '') => `<header class="flDlgH"><div><b id="flDlgT">${title}</b>${sub ? `<small>${sub}</small>` : ''}</div><button class="iconBtn close" data-act="flClose" aria-label="Close">${ic('close')}</button></header>`;
    let html = '';
    switch (d.kind) {
      case 'confirm':
        html = head('Please confirm') + `<div class="flDlgB"><p>${esc(d.text)}</p>${d.extra}</div><footer class="flDlgF"><button data-act="flClose">Cancel</button><button class="${d.danger ? 'danger' : 'primary'}" data-act="flConfirmOk">${esc(d.ok)}</button></footer>`;
        break;
      case 'helm': html = this.helmDialog(v, head); break;
      case 'orders': html = this.ordersDialog(v, head); break;
      case 'sail': {
        if (keepInput) { const list = box.querySelector('.flPick'); if (list) { list.innerHTML = this.harbourRows(v, d.q); return; } }
        html = head(`Sail to… <small class="muted">${esc(v?.name || '')}</small>`) + `<div class="flDlgB"><label class="flSearch">${ic('filter')}<input id="flSailQ" type="search" placeholder="Harbour or country" value="${esc(d.q || '')}" autocomplete="off"></label><ul class="flPick">${this.harbourRows(v, d.q)}</ul></div>`;
        break;
      }
      case 'board': html = this.boardDialog(v, head); break;
      case 'services': html = head(`Services · ${esc(v?.name || '')}`, esc(F.fmtPos(v || {}, this.harbors()))) + `<div class="flDlgB flMenu">
          ${btn('flSvcDo', `${ic('fuel')} Bunker to full <small>${v ? `${Math.round((v.fuel / v.fuelCap) * 100)} % now` : ''}</small>`, v?.can.services ?? 'No ship.', `data-vid="${esc(d.vid)}" data-what="fuel"`, 'block')}
          ${btn('flSvcDo', `${ic('wrench')} Repair the hull <small>${v ? `${v.cond} %` : ''}</small>`, v?.can.services ?? 'No ship.', `data-vid="${esc(d.vid)}" data-what="repair"`, 'block')}
          ${btn('flSvcDo', `${ic('kit')} Yard service <small>resets the wear clock</small>`, v?.can.services ?? 'No ship.', `data-vid="${esc(d.vid)}" data-what="service"`, 'block')}</div>`; break;
      case 'rename': html = head(`Rename ${esc(v?.name || '')}`) + `<div class="flDlgB"><label class="flField"><span>New name</span><input id="flRenameIn" maxlength="24" value="${esc(v?.name || '')}" autocomplete="off"></label><small class="muted">2–24 letters or digits; spaces, ' . - allowed. Unique in your fleet.</small><p class="flErr hidden" id="flRenameErr"></p></div><footer class="flDlgF"><button data-act="flClose">Cancel</button><button class="primary" data-act="flRenameGo" data-vid="${esc(d.vid)}">Rename</button></footer>`; break;
      case 'transfer': html = this.transferDialog(v, head); break;
      default: html = head('Fleet');
    }
    box.innerHTML = html;
    this.app.hud?.hydrateIcons?.(box);
    if (d.kind === 'rename') setTimeout(() => $('flRenameIn')?.select(), 0);
    if (d.kind === 'sail') setTimeout(() => $('flSailQ')?.focus(), 0);
  }
  /** Take the helm (§8): fee, and what the ship you leave does. */
  helmDialog(v, head) {
    if (!v) return head('Take the helm') + '<div class="flDlgB"><p>That ship is not in your fleet.</p></div>';
    const cur = this.aboardView(), app = this.app;
    const fee = v.can.helmFee || 0;
    const opts = [];
    const route = Array.isArray(app.route) && app.route.length ? app.route : null;
    const routeH = app.routeMeta?.dest?.harbor || null;
    if (cur && cur.harbor) opts.push({ id: 'stay', label: `Stays moored at ${F.shortName(cur.harborName)}`, order: null });
    else {
      if (route) opts.push({ id: 'route', label: `Continue the route${routeH ? ` to ${F.shortName(this.harbors().find((h) => h.id === routeH)?.name || routeH)}` : ''}`, order: { type: 'route', route: route.slice(0, 250).map((p) => (Array.isArray(p) ? [p[0], p[1]] : [p.lat, p.lon])), harbor: routeH || undefined } });
      const near = cur ? F.nearestHarbour(cur.lat, cur.lon, this.harbors()) : null;
      if (near && near.distM <= FLEET.HARBOUR_ZONE_M) opts.push({ id: 'berth', label: `Berth in ${F.shortName(near.h.name)} (the captain calls the tugs)`, order: { type: 'sail_to', harbor: near.h.id, then: 'moor' } });
      opts.push({ id: 'hold', label: 'Hold here — anchor at a safe spot', order: { type: 'hold' } });
    }
    if (cur && this.last?.home && cur.harbor !== this.last.home) opts.push({ id: 'home', label: `Return home to ${F.shortName(this.last.homeName)}`, order: { type: 'home' } });
    this._leaveOpts = opts;
    const pick = opts[0]?.id;
    const where = F.fmtPos(v, this.harbors());
    const feeTxt = fee > 0 ? `A ${fee >= FLEET.TRANSFER_MAX_CR || (v.lat != null && cur && F.haversineM(cur.lat, cur.lon, v.lat, v.lon) > 200000) ? 'helicopter' : 'launch'} takes you out: <b>${F.fmtCr(fee)}</b>.` : 'She is close by — no transfer fee.';
    return head(`Take the helm of ${esc(v.name)}`, esc(`${v.clsName} · ${where}`)) + `<div class="flDlgB">
      <p>${feeTxt} Camera, helm, HUD and the inside of the ship move to her; time warp goes back to 1×.</p>
      ${cur ? `<fieldset class="flLeave"><legend>${esc(cur.name)}, the ship you leave</legend>${opts.map((o) => `<label><input type="radio" name="leave" value="${o.id}"${o.id === pick ? ' checked' : ''}> ${esc(o.label)}</label>`).join('')}</fieldset>` : ''}
      ${v.can.helm !== true ? `<p class="flErr">${esc(v.can.helm)}</p>` : ''}</div>
      <footer class="flDlgF"><button data-act="flClose">Cancel</button><button class="primary" data-act="flHelmGo" data-vid="${esc(v.id)}"${v.can.helm === true ? '' : ' disabled'}>${ic('ship')} Take the helm${fee ? ` · ${F.fmtCr(fee)}` : ''}</button></footer>`;
  }
  helmGo() {
    const d = this.dlg; if (!d) return;
    const pick = $('flDlg')?.querySelector('input[name="leave"]:checked')?.value;
    const o = (this._leaveOpts || []).find((x) => x.id === pick);
    const fields = { vesselId: d.vid };
    if (o && o.order) fields.leave = o.order;
    // walking about: leave the walker first (§8.4)
    try { if (this.app.interior?.active) this.app.interior.exit?.(); } catch { /* not aboard below decks */ }
    try { if (this.app.ashore?.active) this.app.ashore.exit?.(); } catch { /* not ashore */ }
    this.act('switch_ship', fields);
    this.closeDialog();
  }
  ordersDialog(v, head) {
    if (!v) return head('Orders');
    const home = this.last?.home, atHome = v.harbor && v.harbor === home;
    const rows = [
      btn('flSail', `${ic('route')} Sail to… <small>pick a harbour</small>`, v.can.orders, `data-vid="${esc(v.id)}"`, 'block'),
      !atHome ? btn('flHome', `${ic('star')} Return home <small>${esc(F.shortName(this.last?.homeName || ''))}</small>`, v.can.orders, `data-vid="${esc(v.id)}"`, 'block') : '',
      !atHome && v.status === 'active' ? btn('flHome', `${ic('hold')} Sail home and lay up`, v.can.orders, `data-vid="${esc(v.id)}" data-then="lay_up"`, 'block') : '',
      v.harbor ? '' : btn('flHold', `${ic('anchor')} Hold here <small>anchor at a safe spot</small>`, v.can.orders, `data-vid="${esc(v.id)}"`, 'block'),
      v.harbor ? btn('flBoard', `${ic('contract')} Take a contract… <small>${esc(F.shortName(v.harborName))} board</small>`, v.can.contract, `data-vid="${esc(v.id)}"`, 'block') : '',
      (v.jobs || []).length ? btn('flWork', `${ic('crate')} Work through her contracts`, v.can.orders, `data-vid="${esc(v.id)}"`, 'block') : '',
      this.app.tradePlan ? btn('flTradeRun', `${ic('market')} Run the planned trade <small>${esc(F.shortName(this.app.tradePlan.fromName || this.app.tradePlan.from))} → ${esc(F.shortName(this.app.tradePlan.toName || this.app.tradePlan.to))}</small>`, v.can.orders, `data-vid="${esc(v.id)}"`, 'block') : '',   // world economy §9.5
      atHome ? btn('flLayup', `${ic('hold')} Lay up here`, v.can.layUp, `data-vid="${esc(v.id)}"`, 'block') : '',
      btn('flStop', `${ic('pause')} Stop <small>${v.harbor ? 'stay moored' : 'hold where she is'}</small>`, v.can.orders, `data-vid="${esc(v.id)}"`, 'block ghost'),
    ].join('');
    return head(`Orders · ${esc(v.name)}`, esc(F.fmtTask(v, nowS(this.app)) || F.fmtPos(v, this.harbors()))) + `<div class="flDlgB flMenu">${rows}</div>`;
  }
  harbourRows(v, q = '') {
    const list = this.harbors(), needle = String(q || '').trim().toLowerCase();
    const kn = serviceKn(v?.cls || 'coaster', v && v.capacity ? v.cargoT / v.capacity : 0);
    const rows = list.filter((h) => h.id !== v?.harbor && (!needle || h.name.toLowerCase().includes(needle) || String(h.country || '').toLowerCase() === needle))
      .map((h) => ({ h, e: v ? F.etaEstimate(v.lat, v.lon, h.lat, h.lon, kn) : { km: NaN, h: NaN } }))
      .sort((a, b) => a.e.km - b.e.km).slice(0, 40);
    if (!rows.length) return `<li class="muted">No harbour matches “${esc(q)}”.</li>`;
    const home = this.last?.home;
    return rows.map(({ h, e }) => `<li><div><b>${esc(F.shortName(h.name))}</b><small>${esc(h.country || '')} · ${esc(h.size || '')}${h.id === home ? ' · home' : ''}</small></div><span class="muted">≈ ${F.fmtN(e.km)} km · ${F.fmtDur(e.h * 3600)}</span>
      <span class="flPickB"><button class="small primary" data-act="flSailTo" data-vid="${esc(v?.id)}" data-h="${esc(h.id)}">Sail</button>${h.id === home ? `<button class="small" data-act="flSailTo" data-vid="${esc(v?.id)}" data-h="${esc(h.id)}" data-then="lay_up">and lay up</button>` : ''}</span></li>`).join('');
  }
  boardDialog(v, head) {
    const b = this.board && this.board.vesselId === v?.id ? this.board : null;
    const body = !b ? `<div class="empty">${ic('hourglass')}<span>Asking the harbour master for the board…</span></div>`
      : !b.jobs.length ? `<div class="empty">${ic('board')}<span>Nothing on the board at ${esc(F.shortName(b.harborName))} right now.</span></div>`
        : `<ul class="flBoard">${b.jobs.map((j) => {
          const why = j.why || (j.est && !j.est.ok ? j.est.why : null);
          const eh = j.est && Number.isFinite(j.est.needH) ? `Captain: ~${F.fmtDur(j.est.needH * 3600)} (real time)` : '';
          return `<li class="${j.why ? 'off' : ''}"><div class="flBoardT"><b>${esc(j.title)}</b><small class="muted">${esc([j.toName ? `to ${F.shortName(j.toName)}` : '', j.hours ? `${j.hours} h allowed` : '', eh].filter(Boolean).join(' · '))}</small>${why ? `<small class="${j.why ? 'bad' : 'warn'}">${esc(why)}</small>` : ''}</div>
            <b class="flPay">${F.fmtCr(j.pay)}</b>${btn('flAccept', 'Give to her', j.why ? false : true, `data-vid="${esc(v.id)}" data-jid="${esc(j.id)}"`, 'small primary')}</li>`;
        }).join('')}</ul>`;
    return head(`Take a contract · ${esc(v?.name || '')}`, b ? esc(`${F.shortName(b.harborName)} board · tows and smuggling are not for captains`) : '') + `<div class="flDlgB">${body}</div>`;
  }
  renameGo() {
    const d = this.dlg; if (!d) return;
    const name = validShipName($('flRenameIn')?.value);
    const err = $('flRenameErr');
    if (!name) { if (err) { err.textContent = "Ship names are 2–24 letters or digits (spaces, ' . - allowed)."; err.classList.remove('hidden'); } return; }
    if ((this.last?.vessels || []).some((x) => x.id !== d.vid && x.name.toLowerCase() === name.toLowerCase())) { if (err) { err.textContent = `You already have a ship called ${name}.`; err.classList.remove('hidden'); } return; }
    this.act('fleet_rename', { vesselId: d.vid, name });
    this.closeDialog();
  }
  /** Transfer cargo / move a contract between two ships moored in the same harbour (§6.7). */
  transferDialog(v, head) {
    if (!v) return head('Transfer');
    const others = (this.last?.vessels || []).filter((x) => x.id !== v.id && x.harbor && x.harbor === v.harbor && x.status === 'active');
    if (!others.length) return head(`Transfer · ${esc(v.name)}`) + `<div class="flDlgB"><div class="empty">${ic('crate')}<span>No other ship of yours is moored in ${esc(F.shortName(v.harborName))}.</span></div></div>`;
    const free = (v.cargo || []).filter((c) => !c.jobId);
    const opt = (x) => `<option value="${esc(x.id)}">${esc(x.name)} (${F.fmtT(Math.max(0, x.capacity - x.cargoT))} free)</option>`;
    const goods = free.length ? `<div class="flXfer"><label class="flField"><span>Cargo</span><select name="good">${free.map((c) => `<option value="${esc(c.good)}">${esc(GOODS[c.good]?.name || c.good)}${c.caught ? ' (caught)' : ''} · ${F.fmtT(c.qty)}</option>`).join('')}</select></label>
        <label class="flField"><span>Tonnes</span><input name="qty" type="number" min="0.1" step="0.1" value="${esc(Math.floor(free[0].qty))}"></label>
        <label class="flField"><span>To</span><select name="to">${others.map(opt).join('')}</select></label>
        <button class="primary" data-act="flTransferGo" data-vid="${esc(v.id)}">${ic('arrowRight')} Move cargo</button></div>` : `<p class="muted">${esc(v.name)} carries no free cargo.</p>`;
    const jobs = (v.jobs || []).length ? `<h4>Move a contract</h4><ul class="flBoard">${v.jobs.map((j) => `<li><div class="flBoardT"><b>${esc(j.title)}</b><small class="muted">${Number.isFinite(j.leftH) ? `${F.fmtDur(j.leftH * 3600)} left` : ''}</small></div><span class="flPickB">${others.map((x) => `<button class="small" data-act="flMoveJob" data-jid="${esc(j.id)}" data-from="${esc(v.id)}" data-to="${esc(x.id)}">to ${esc(x.name)}</button>`).join('')}</span></li>`).join('')}</ul>` : '';
    return head(`Transfer from ${esc(v.name)}`, esc(`in ${F.shortName(v.harborName)} · no fee`)) + `<div class="flDlgB">${goods}${jobs}</div>`;
  }
  transferGo(el) {
    const f = this.formValues(), qty = Number(f.qty);
    if (!f.good || !f.to || !(qty > 0)) return;
    this.act('fleet_transfer', { fromId: el.dataset.vid, toId: f.to, good: f.good, qty });
    this.closeDialog();
  }
}
