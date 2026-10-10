// World economy, client lane: the harbour sheet's Market tab (docs/WORLD-ECONOMY-CONTRACT.md §14.1, §14.3). Rendered by
// hud.js (tabMarket) from the `econ` block of the `harbor` message; the formatting lives in econfmt.js (pure).
import * as F from './econfmt.js';
import { ic, CAT_ICON, iconDataUrl } from './icons.js';
import { canLoad, CARGO, unitsOf, loadOption } from '../../shared/cargo.js';
import { CATS, catalogueOf } from '../../shared/econ/catalogue.js';
import { SEASONS } from '../../shared/econ/seasons.js';
import { bump, mmddDoy, ECON2X } from '../../shared/econ/model.js';

const $ = (id) => document.getElementById(id);
const store = { get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } } };
/** Regional-indicator flag for an ISO country code ('BR' → 🇧🇷). */
export function flagOf(cc) { return /^[A-Z]{2}$/.test(cc || '') ? String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : ''; }
const catIcon = (cat) => ic(CAT_ICON[cat] || 'crate');

export class EconView {
  constructor(hud) {
    this.hud = hud; this.app = hud.app;
    this.filter = null; this.search = ''; this.collapsed = new Set(store.get('ecCollapsed', []));
    this.detail = null; this.detailData = new Map(); this.sheetState = null; this.lastH = null; this.lastHid = null;
    try { this.injectIconCss(); } catch { /* no DOM (tests) */ }
  }
  /** Category icons as CSS backgrounds for the row and card badges (one rule per category). */
  injectIconCss() {
    if (typeof document === 'undefined' || document.getElementById('ecIconCss')) return;
    const s = document.createElement('style'); s.id = 'ecIconCss';
    s.textContent = CATS.map((c) => `.ecIcon[data-cat="${c.id}"],.ecReqIcon[data-cat="${c.id}"]{background-image:${iconDataUrl(CAT_ICON[c.id] || 'crate', '#8fd3ff')}}`).join('\n');
    document.head.appendChild(s);
  }
  /** Tonnes of `g` one trip of this class lifts (hold, the good's unit, reefer plugs). */
  tripT(cls, g, C) {
    const c = CARGO[g], u = unitsOf(cls); let t = C?.capacity || 0;
    if (c && c.unit !== 't' && u[c.unit] > 0) t = Math.min(t, u[c.unit] * c.tPer);
    if (loadOption(g, cls)?.plugs) t = Math.min(t, (u.plugs || 0) * 14);
    return Math.floor(t);
  }
  phone() { try { return window.matchMedia('(max-width: 640px)').matches || document.body.classList.contains('touch') && innerWidth < 760; } catch { return false; } }

  /** Stacks that may fill a request (§7.3): bought where the good is made or traded, or caught. */
  eligibleT(you, g) { return (you?.cargo || []).filter((c) => c.good === g && !c.jobId && (c.caught || c.srcRole === 'P' || c.srcRole === 'L')).reduce((s, c) => s + c.qty, 0); }
  haveT(you, g) { return (you?.cargo || []).filter((c) => c.good === g && !c.jobId).reduce((s, c) => s + c.qty, 0); }
  fit(cls, g, C = null) { const f = canLoad(g, cls); return f.ok ? { ok: true, ...(C ? { tripT: this.tripT(cls, g, C) } : {}) } : { ok: false, text: f.why?.text || 'Your ship cannot carry it' }; }
  freeT(you, C) { return Math.max(0, Math.floor((C?.capacity || 0) - (you?.cargo || []).reduce((s, c) => s + (c.qty || 0), 0))); }

  render(h, you, C) {
    const e = h.econ; this.lastH = h;
    if (h.id !== this.lastHid) {   // a new harbour: start at the top with nothing filtered or open
      const first = this.lastHid != null; this.lastHid = h.id; this.detail = null; this.filter = null; this.sheetState = null;
      if (first) setTimeout(() => { const b = document.querySelector('#harborWrap .sheetBody, #harborWrap .hbBody'); if (b) b.scrollTop = 0; document.getElementById('tab-market')?.scrollTo?.(0, 0); }, 0);
    }
    if (!e || !Array.isArray(e.goods)) return '<p class="muted">Market data is loading…</p>';
    const phone = this.phone(), cls = you?.ship?.cls || 'coaster', freeT = this.freeT(you, C), shipName = C?.name || 'ship';
    // 1. country strip
    const ev = e.ev ? `<div class="ecBanner ecEv-${F.esc(e.ev.kind)}">${ic(e.ev.kind === 'storm' ? 'storm' : e.ev.kind === 'boom' || e.ev.kind === 'bust' ? 'info' : 'warning')}<span>${F.esc(e.ev.text || e.ev.kind)}</span></div>` : '';
    const strip = `<section class="ecCountry"><div class="ecFlagRow"><span class="ecFlag" aria-hidden="true">${flagOf(e.country)}</span><div><b>${F.esc(e.countryName || e.country)}</b><small>${F.esc(String(h.name || '').split(' (')[0])} · ${F.esc(h.size || '')} harbour</small></div>
        <div class="ecTopBtns"><button class="mkWorldBtn" data-act="worldMarket" data-sub="trades" data-h="${F.esc(h.id)}">${ic('route')}<span class="lbl">Trades from here</span></button><button class="mkWorldBtn" data-act="worldMarket">${ic('globe')}<span class="lbl">World market</span></button></div></div>
      ${F.chipRow('Made here', e.make, 'make')}${F.chipRow('Needed here', e.need, 'need')}${ev}</section>`;
    // 2. requests board
    const reqs = (e.requests || []).map((r) => F.requestCardHTML(r, { harborName: String(h.name || '').split(' (')[0], docked: you?.docked === h.id, eligibleT: this.eligibleT(you, r.good), fit: this.fit(cls, r.good, C), phone, shipName }));
    const board = reqs.length ? `<section class="ecReqs"><h3>${ic('bell')}Requests <small>${reqs.length} open — paid at a locked price per tonne delivered</small></h3><div class="ecReqList${phone ? ' carousel' : ''}">${reqs.join('')}</div></section>` : '';
    // 3. goods list, grouped by category
    const q = this.search.trim().toLowerCase();
    const rows = e.goods.filter((x) => (!this.filter || x.id === this.filter) && (!q || F.goodName(x.id).toLowerCase().includes(q) || x.id.includes(q)));
    const groups = CATS.map((c) => ({ c, xs: rows.filter((x) => F.catOf(x.id) === c.id) })).filter((g) => g.xs.length);
    const list = groups.map(({ c, xs }) => {
      const shut = this.collapsed.has(c.id) && !q && !this.filter;
      return `<section class="ecCat${shut ? ' shut' : ''}"><button class="ecCatHead" data-act="econ-cat" data-cat="${c.id}" aria-expanded="${shut ? 'false' : 'true'}">${catIcon(c.id)}<b>${F.esc(c.name)}</b><small>${xs.length}</small>${ic(shut ? 'chevronDown' : 'chevronUp')}</button>
        ${shut ? '' : xs.map((x) => F.goodRowHTML(x, { have: this.haveT(you, x.id), fit: this.fit(cls, x.id), money: you?.money ?? 0, freeT, phone, open: this.detail === x.id }) + (this.detail === x.id ? this.detailHTML(h, x) : '')).join('')}</section>`;
    }).join('');
    const tools = `<div class="ecTools"><label class="ecSearch">${ic('filter')}<input id="ecSearch" type="search" placeholder="Find a good" value="${F.esc(this.search)}" aria-label="Find a good"></label>${this.filter ? `<button class="ecChip on" data-act="econ-filter" data-good="${F.esc(this.filter)}">${F.esc(F.goodName(this.filter))} ${ic('close')}</button>` : ''}<span class="muted small">Hold free ${F.fmtN(freeT)} t · ${F.fmtN(you?.money)} cr</span></div>`;
    // unlisted cargo aboard: the general traders
    const unlisted = [...new Set((you?.cargo || []).filter((c) => !c.jobId && !c.contraband && CARGO[c.good]?.market && !e.goods.some((x) => x.id === c.good)).map((c) => c.good))];
    const dump = unlisted.length ? `<section class="ecDump"><h3>${ic('handshake')}General traders</h3>${unlisted.map((g) => `<div class="ecRow ecDumpRow"><div class="ecL1"><span class="ecName"><span class="ecIcon" data-cat="${F.esc(F.catOf(g))}"></span><span><b>${F.esc(F.goodName(g))}</b><small>${F.fmtN(this.haveT(you, g))} t aboard — not traded here</small></span></span><div class="ecPx"><span class="ecSell"><b>${F.fmtN(Math.round((h.econ.dump?.frac ?? 0.45) * (catalogueOf(g)?.base ?? 0)))}</b><small>cr/t</small></span></div></div><div class="ecTrade"><input type="number" min="1" value="${Math.floor(this.haveT(you, g))}" data-qty="${F.esc(g)}" aria-label="quantity"><button data-act="econ-sell" data-good="${F.esc(g)}">Sell</button></div></div>`).join('')}</section>` : '';
    const foot = `<p class="ecFoot muted small">Unlisted goods: general traders pay ${Math.round((e.dump?.frac ?? 0.45) * 100)} % of the world base (${F.fmtN(e.dump?.capT ?? 500)} t a day). Contract cargo cannot be sold.</p>`;
    return `<div class="ecTab${phone ? ' phone' : ''}">${strip}${board}${tools}<div class="ecList">${list || '<p class="muted">No good matches.</p>'}</div>${dump}${foot}</div>${this.sheetHTML()}`;
  }

  // -------- detail panel (§14.1): 30-day chart, season strip, makers and buyers, requests worldwide
  detailHTML(h, x) {
    const d = this.detailData.get(`${h.id}:${x.id}`);
    if (!d) { this.loadDetail(h, x.id); return `<div class="ecDetail"><p class="muted small">Loading history…</p></div>`; }
    const hs = this.app.world?.harbors || [], byId = new Map(hs.map((v) => [v.id, v]));
    const km = (a) => (a && h ? Math.round(this.gc(h, a) * ECON2X.DETOUR) : null);
    const rows = (d.good?.rows || []).map((r) => ({ id: r[0], role: r[1], buy: r[2], sell: r[3], stock: r[4], n: r[5], h: byId.get(r[0]) })).filter((r) => r.h && r.id !== h.id);
    const makers = rows.filter((r) => r.role === 'P').sort((a, b) => a.buy - b.buy).slice(0, 5);
    const buyers = rows.filter((r) => r.role !== 'P').sort((a, b) => b.sell - a.sell).slice(0, 5);
    const li = (r, v) => `<li><span>${flagOf(r.h.country)} ${F.esc(String(r.h.name).split(' (')[0])}</span><b>${F.fmtN(v)}</b><small>${F.fmtN((km(r.h) || 0) / 1.852)} nm</small></li>`;
    const nowM = new Date((this.app.simTime || Date.now() / 1000) * 1000).getUTCMonth();
    const reqs = (d.reqs?.requests || []).slice(0, 6);
    const ab = this.lastH?.econ?.about;
    return `<div class="ecDetail" data-detail="${F.esc(x.id)}">
      <div class="ecDetailGrid"><div><h4>30 days</h4>${F.chartSvg(d.hist?.series || [])}</div><div><h4>Season</h4>${F.seasonStrip(this.seasonMonths(h, x.id, x.role), nowM)}<p class="muted small">${x.why?.text ? `Now: ${F.esc(x.why.text)}` : 'No season or event moving this price now.'}</p></div></div>
      <div class="ecDetailGrid"><div><h4>Cheapest makers</h4><ol class="ecList5">${makers.map((r) => li(r, r.buy)).join('') || '<li class="muted">none listed</li>'}</ol></div><div><h4>Best buyers</h4><ol class="ecList5">${buyers.map((r) => li(r, r.sell)).join('') || '<li class="muted">none listed</li>'}</ol></div></div>
      ${reqs.length ? `<h4>Open requests for ${F.esc(F.goodName(x.id).toLowerCase())}</h4><ul class="ecList5">${reqs.map((r) => `<li><span>${F.esc(r.harborName)}</span><b>${F.premiumText(r.premium)}</b><small>${F.fmtN(r.open)} t · ${F.deadlineText(r.leftH)}</small></li>`).join('')}</ul>` : ''}
      ${x.maker ? `<p class="muted small">Nearest maker: ${F.esc(x.maker.name)}, ${F.fmtN(x.maker.km / 1.852)} nm — the price here includes the freight from there.</p>` : ''}
      <p class="ecAbout muted small">About this data: ${ab ? `profile ${F.esc((ab.src || []).join(', ') || 'game')}${ab.verify ? ' (to verify)' : ''}, as of ${F.esc(ab.asOf || '')}` : 'game'} — simplified for the game.</p>
    </div>`;
  }
  gc(a, b) { const R = 6371, r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r; const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.min(1, Math.sqrt(x))); }
  /** Season multiplier per month (15th) for this harbour and good (P side for makers, C side for everyone). */
  seasonMonths(h, g, role) {
    const rows = SEASONS.filter((r) => r.good === g && (r.side === 'C' || role === 'P'));
    const own = rows.filter((r) => r.cc?.includes(h.country)), use = own.length ? own : rows.filter((r) => !r.cc);
    return Array.from({ length: 12 }, (_, m) => {
      const doy = mmddDoy(`${m + 1}-15`); let f = 1;
      for (const r of use) { if (r.latMin && Math.abs(h.lat) < r.latMin) continue; if (r.importers && role !== 'I') continue; let pk = mmddDoy(r.peak); if (r.hemi && h.lat < 0) pk = (pk + ECON2X.HEMI_SHIFT) % 365; f *= bump(r.A, r.W, pk, doy); }
      return f;
    });
  }
  async loadDetail(h, g) {
    const key = `${h.id}:${g}`; if (this.detailData.has(key) || this.loading === key) return;
    this.loading = key;
    const j = (u) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const [hist, good, reqs] = await Promise.all([j(`/api/market/history?good=${g}&harbor=${h.id}&days=30`), j(`/api/market/good/${g}`), j(`/api/market/requests?good=${g}&limit=20`)]);
    this.detailData.set(key, { hist, good, reqs }); this.loading = null;
    if (this.detail === g) this.rerender();
  }
  rerender() { const keep = $('harborWrap')?.querySelector('.sheetBody, .hbBody'); const y = keep?.scrollTop; this.hud.renderTab?.('market'); if (keep && y != null) keep.scrollTop = y; }

  // -------- bottom sheet (phone buy / sell, and the pledge on every screen size)
  sheetHTML() {
    const s = this.sheetState; if (!s) return '';
    const word = s.kind === 'pledge' ? 'Pledge' : s.kind === 'buy' ? 'Buy' : 'Sell';
    return `<div class="ecSheetBack" data-act="econ-sheetClose"></div><div class="ecSheet" role="dialog" aria-label="${word} ${F.esc(F.goodName(s.good))}">
      <h3>${word} ${F.esc(F.goodName(s.good).toLowerCase())}</h3><p class="muted small">${F.esc(s.note || '')}</p>
      <div class="ecSheetQty"><input type="range" id="ecSheetRange" min="${s.min}" max="${Math.max(s.min, s.max)}" step="${s.step}" value="${s.v}" aria-label="Quantity"><output id="ecSheetOut">${F.qtyText(s.v, s.good)}</output></div>
      <div class="ecSheetBtns"><button data-act="econ-sheetMax">Max ${F.fmtN(s.max)} t</button><button data-act="econ-sheetClose">Cancel</button><button class="primary" data-act="econ-sheetOk">${word}</button></div></div>`;
  }
  openSheet(st) { this.sheetState = st; this.rerender(); }

  // -------- actions (routed from hud.js: every data-act starting with "econ-")
  action(act, el) {
    const a = this.app, net = a.net, you = a.you, h = this.lastH, root = $('harborWrap');
    const qtyOf = (g) => Math.floor(+(root?.querySelector(`input[data-qty="${CSS.escape(g)}"]`)?.value || 0));
    const g = el.dataset.good;
    switch (act) {
      case 'econ-filter': this.filter = this.filter === g ? null : g; this.detail = null; return this.rerender();
      case 'econ-cat': { const c = el.dataset.cat; if (this.collapsed.has(c)) this.collapsed.delete(c); else this.collapsed.add(c); store.set('ecCollapsed', [...this.collapsed]); return this.rerender(); }
      case 'econ-detail': this.detail = this.detail === g ? null : g; return this.rerender();
      case 'econ-max': { const i = root?.querySelector(`input[data-qty="${CSS.escape(g)}"]`); if (i) i.value = String(Math.max(1, Math.floor(+el.dataset.v || 1))); return; }
      case 'econ-buy': case 'econ-sell': {
        const buying = act === 'econ-buy', x = h?.econ?.goods?.find((r) => r.id === g);
        if (this.phone()) {
          const C = a.world?.classes?.[you?.ship?.cls] || null, have = Math.floor(this.haveT(you, g));
          const max = buying ? Math.max(0, Math.floor(Math.min(x?.buyable ?? 0, this.freeT(you, C), x?.buy > 0 ? (you?.money ?? 0) / (x.buy * 1.02) : 0))) : have;
          if (!(max >= 1)) return this.hud.event?.({ kind: 'warn', text: buying ? 'Nothing you can buy here right now (stock, hold or money).' : 'Nothing to sell.' });
          return this.openSheet({ kind: buying ? 'buy' : 'sell', good: g, min: 1, max, step: 1, v: Math.min(max, Math.max(1, Math.min(100, max))), note: buying ? `${F.fmtN(x?.buy)} cr/t for the first tonne — the price rises as you buy.` : `${F.fmtN(x?.sell ?? 0)} cr/t for the first tonne.` });
        }
        const q = qtyOf(g); if (!(q > 0)) return;
        return net.action(buying ? 'buy_goods' : 'sell_goods', { good: g, qty: q });
      }
      case 'econ-pledge': {
        const r = h?.econ?.requests?.find((x) => x.id === el.dataset.req); if (!r) return;
        const lot = Math.max(1, Math.round(r.open >= 12 ? 1 : 1));
        return this.openSheet({ kind: 'pledge', req: r.id, good: r.good, min: Math.min(lot, r.open), max: Math.floor(r.open), step: 1, v: Math.floor(r.open), note: `Reserve part of ${F.qtyText(r.qty, r.good)} for your ship until she can get here. ${F.fmtN(r.unit)} cr/t locked.` });
      }
      case 'econ-deliver': return net.action('deliver_request', { reqId: el.dataset.req });
      case 'econ-plan': return a.market?.requestsFor?.(g);
      case 'econ-sheetClose': this.sheetState = null; return this.rerender();
      case 'econ-sheetMax': { const s = this.sheetState; if (s) { s.v = s.max; this.rerender(); } return; }
      case 'econ-sheetOk': {
        const s = this.sheetState; if (!s) return;
        const v = Math.floor(+($('ecSheetRange')?.value ?? s.v)); this.sheetState = null;
        if (s.kind === 'pledge') net.action('pledge_request', { reqId: s.req, qty: v });
        else net.action(s.kind === 'buy' ? 'buy_goods' : 'sell_goods', { good: s.good, qty: v });
        return this.rerender();
      }
    }
  }
  /** Live inputs (search field, sheet slider). Returns true when handled. */
  input(el) {
    if (el.id === 'ecSearch') { this.search = el.value; const pos = el.selectionStart; this.rerender(); const n = $('ecSearch'); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch { /* type=search */ } } return true; }
    if (el.id === 'ecSheetRange' && this.sheetState) { this.sheetState.v = +el.value; const o = $('ecSheetOut'); if (o) o.textContent = F.qtyText(+el.value, this.sheetState.good); return true; }
    return false;
  }
}
