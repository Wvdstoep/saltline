// The shipyard screen (docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §4.7, Lane B): Newbuild (designs × yards, configurator
// with a 3D turntable, order), Stock & resale, Second-hand (history drawer, paid inspection), My orders (progress,
// instalments, delivery), Sell / trade-in; compare up to 4; Jones Act and politics badges. Desktop (≥ 900 px): three
// panes; phone: one column, segmented control, filters in a bottom sheet, the configurator as a full-screen sheet with
// the turntable on top and a sticky order footer.
//
// Wiring (phase 2, docs/SHIPS-LANEB-PHASE2.md): main.js creates `app.yardUi = new YardUi(app)`; hud.js tabShipyard
// returns `this.app.yardUi.html(h, you)` and forwards clicks on `[data-act^="yard-"]` to `yardUi.action(act, el, e)`.
// Wire (§7.3): reads `harbor.yard` { here, local, stock, used, orders, tradeIn, sellValue, openOrders, maxOpen } and sends
// yard_order / yard_pay / yard_cancel / yard_deliver / yard_buy_stock / yard_inspect / yard_buy_used.
import { MODELS, YARD, YARD_COUNTRIES, parseVariant, defaultOpts, defaultLivery, registerHarbors, yardById, financing, classRow, localYard } from '../../shared/ships/index.js';
import * as F from './yardfmt.js';
import { YardPreview, yardThumb, cachedYardThumb } from './yardpreview.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SECTIONS = [['new', 'Newbuild', 'New'], ['stock', 'Stock & resale', 'Stock'], ['used', 'Second-hand', 'Used'], ['orders', 'My orders', 'Orders'], ['sell', 'Sell / trade-in', 'Sell']];
const KEYS = { n: 'new', u: 'used', o: 'orders' };
const REGISTRIES = ['PA', 'LR', 'MH', 'MT', 'BS', 'SG', 'NO', 'GB', 'NL', 'DE', 'US', 'JP', 'KR', 'CN'];
const tone = (t) => ({ blue: 'b-blue', cyan: 'b-cyan', green: 'b-green', red: 'b-red', amber: 'b-amber', muted: 'b-muted' }[t] || 'b-muted');
const badge = (b) => `<span class="ybadge ${tone(b.tone)}" title="${esc(b.title || b.text)}">${esc(b.short || b.text)}</span>`;

export class YardUi {
  constructor(app, opts = {}) {
    this.app = app;
    this.net = opts.net || app?.net || null;
    this.rerender = opts.rerender || (() => app?.hud?.renderTab?.('shipyard'));
    this.yardCheck = opts.yardCheck || null;               // politics R3 (client copy) — absent: every yard allowed
    this.confirm = opts.confirm || ((t) => (typeof window !== 'undefined' ? window.confirm(t) : true));
    this.phone = opts.phone ?? (typeof window !== 'undefined' && window.innerWidth < 900);
    this.preview = opts.preview || new YardPreview({ phone: this.phone, gaFn: opts.gaFn });
    this.sec = 'new';
    this.f = { type: 'all', size: 'all', cc: 'all', maxPrice: 0, afford: false, jones: false, maxH: 0, eco: 'all', sort: 'type', q: '' };
    this.sel = null;              // { model, opts, yard, preset, mark, name, registry, deliverTo, loan, slot }
    this.cmp = [];                // [{ key, title, variant, price, hours, resale, cond }]
    this.cmpOpen = false;
    this.sheet = null;            // phone: 'filters' | 'config'
    this.hist = new Set();        // open history drawers (listing ids)
    this.tradeIn = null;          // vesselId credited against the first instalment / the purchase
    this.registered = false;
    this.stats = { renders: 0 };
  }

  // ---------------------------------------------------------------------------------------------- render
  /** The whole Shipyard tab (HTML string). h = the harbour payload (h.yard per §7.3), you = the player. */
  html(h, you) {
    this._h = h; this._you = you;
    this.stats.renders++;
    if (!this.registered && this.app?.world?.harbors) { registerHarbors(this.app.world.harbors); this.registered = true; }
    const y = h?.yard || {};
    const counts = { used: (y.used || []).length, orders: (y.orders || []).filter((o) => ['ordered', 'building', 'launched', 'ready'].includes(o.state)).length, stock: (y.stock || []).length };
    const seg = `<div class="yseg" role="tablist" aria-label="Shipyard sections">${SECTIONS.map(([k, long, short]) => `<button role="tab" aria-selected="${this.sec === k}" class="${this.sec === k ? 'on' : ''}" data-act="yard-sec" data-sec="${k}"><span class="long">${long}</span><span class="short">${short}</span>${counts[k] ? `<i>${counts[k]}</i>` : ''}</button>`).join('')}</div>`;
    const head = `<div class="yhead"><div><h2>Shipyard — ${esc(h?.name || '')}</h2><p class="muted small">${y.here?.length ? `${y.here.length} yard${y.here.length > 1 ? 's' : ''} here` : 'Newbuilding office'}${y.local ? ' · local boatyard' : ''} · ${counts.orders} of ${y.maxOpen ?? YARD.MAX_OPEN_ORDERS ?? 4} order slots in use</p></div><div class="ycash">Credits <b>${esc(F.fmtCr(you?.money ?? 0))}</b></div></div>`;
    let body = '';
    try {
      switch (this.sec) {
        case 'stock': body = this.secStock(h, you); break;
        case 'used': body = this.secUsed(h, you); break;
        case 'orders': body = this.secOrders(h, you); break;
        case 'sell': body = this.secSell(h, you); break;
        default: body = this.secNew(h, you);
      }
    } catch (e) { console.error('[yard] render', e); body = `<div class="yempty">The shipyard could not be shown (${esc(e.message)}).</div>`; }
    const tray = this.cmp.length ? this.trayHTML() : '';
    const cmpBox = this.cmpOpen && this.cmp.length >= 2 ? this.compareHTML() : '';
    setTimeout(() => this.afterRender(), 0);
    return `<div class="yard${this.phone ? ' phone' : ''}" data-yard-root>${head}${seg}${body}${tray}${cmpBox}</div>`;
  }

  // ---------------------------------------------------------------------------------------------- Newbuild
  secNew(h, you) {
    const ctx = { harbor: h?.id, yardCheck: this.yardCheck, money: you?.money ?? 0 };
    const cards = F.filterDesigns(this.f, ctx);
    if (!this.sel && cards.length && !this.phone) this.pick(cards[0].id, false);
    const filters = this.filtersHTML(cards.length);
    const list = cards.length ? `<div class="ycards">${cards.map((c) => this.designCardHTML(c)).join('')}</div>` : `<div class="yempty">No design matches these filters.</div>`;
    const conf = this.sel ? this.configHTML(h, you) : '<div class="yconf yempty">Pick a design to configure her.</div>';
    if (this.phone) {
      const fbtn = `<div class="ybar"><button data-act="yard-sheet" data-s="filters">Filters${this.activeFilters() ? ` · ${this.activeFilters()}` : ''}</button><select data-yf="sort" aria-label="Sort">${this.sortOpts()}</select></div>`;
      const sheet = this.sheet === 'filters' ? `<div class="ysheet bottom" role="dialog" aria-label="Filters"><div class="ysheetHead"><b>Filters</b><button data-act="yard-sheet" data-s="">Done</button></div>${filters}</div>`
        : this.sheet === 'config' && this.sel ? `<div class="ysheet full" role="dialog" aria-label="Configure"><div class="ysheetHead"><button data-act="yard-sheet" data-s="">← Designs</button><b>${esc(MODELS[this.sel.model].short)}</b><span></span></div>${conf}</div>` : '';
      return `${fbtn}${list}${sheet}`;
    }
    return `<div class="ypanes"><aside class="yfilters">${filters}</aside><section class="ylist">${list}</section><aside class="yconfWrap">${conf}</aside></div>`;
  }
  activeFilters() { const f = this.f; return ['type', 'size', 'cc', 'eco'].filter((k) => f[k] !== 'all').length + (f.afford ? 1 : 0) + (f.jones ? 1 : 0) + (f.maxPrice > 0 ? 1 : 0) + (f.maxH > 0 ? 1 : 0); }
  sortOpts() { return [['type', 'Type'], ['price', 'Price'], ['delivery', 'Delivery'], ['size', 'Size'], ['name', 'Name']].map(([v, t]) => `<option value="${v}"${this.f.sort === v ? ' selected' : ''}>Sort: ${t}</option>`).join(''); }
  filtersHTML(n) {
    const f = this.f;
    const opt = (v, t, cur) => `<option value="${esc(v)}"${String(cur) === String(v) ? ' selected' : ''}>${esc(t)}</option>`;
    return `<div class="yfgrid">
      <label>Type<select data-yf="type">${opt('all', 'Any type', f.type)}${F.TYPE_ORDER.map((t) => opt(t, F.TYPE_LABEL[t], f.type)).join('')}</select></label>
      <label>Size<select data-yf="size">${opt('all', 'Any size', f.size)}${F.SIZE_BUCKETS.map(([k, t]) => opt(k, t, f.size)).join('')}</select></label>
      <label>Yard country<select data-yf="cc">${opt('all', 'Any country', f.cc)}${F.builderCountries().map((c) => opt(c, `${F.flagOf(c)} ${F.countryName(c)}`, f.cc)).join('')}</select></label>
      <label>Price up to<input type="number" inputmode="numeric" min="0" step="100000" data-yf="maxPrice" value="${f.maxPrice || ''}" placeholder="any"></label>
      <label>Delivery within<input type="number" inputmode="numeric" min="0" step="12" data-yf="maxH" value="${f.maxH || ''}" placeholder="any (h)"></label>
      <label>Eco rating at least<select data-yf="eco">${opt('all', 'Any', f.eco)}${['A', 'B', 'C'].map((g) => opt(g, g, f.eco)).join('')}</select></label>
      <label class="ychk"><input type="checkbox" data-yf="afford"${f.afford ? ' checked' : ''}> I can pay the first instalment</label>
      <label class="ychk" title="Only US yards: a US-built ship under the US flag, owned by a US company, may trade between US ports"><input type="checkbox" data-yf="jones"${f.jones ? ' checked' : ''}> Jones Act eligible (US yards, price × 2)</label>
      ${this.phone ? '' : `<label>Sort<select data-yf="sort">${this.sortOpts()}</select></label>`}
      <label>Search<input type="search" data-yf="q" value="${esc(f.q)}" placeholder="name or class"></label>
      <p class="muted small">${n} design${n === 1 ? '' : 's'} · prices from the cheapest yard that can build her</p></div>`;
  }
  thumbImg(variant, o = {}) {
    const k = `${variant}`;
    const url = cachedYardThumb(variant, o);
    return `<img class="${o.cls || 'ythumb'}" alt="" loading="lazy" ${url ? `src="${url}"` : ''} data-ythumb="${esc(k)}" data-w="${o.w || 320}" data-h="${o.h || 200}" data-angle="${o.angle || 'quarter'}" data-stage="${o.stage ?? 1}"${o.livery ? ` data-livery="${esc(JSON.stringify(o.livery))}"` : ''}>`;
  }
  designCardHTML(c) {
    const on = this.sel?.model === c.id, inCmp = this.cmp.some((x) => x.key === `new:${c.id}`);
    return `<article class="ycard${on ? ' on' : ''}" data-act="yard-pick" data-model="${esc(c.id)}" tabindex="0" role="button" aria-pressed="${on}">
      <div class="ythumbBox">${this.thumbImg(c.id, { w: 320, h: 180 })}<span class="ytype">${esc(F.TYPE_LABEL[c.type] || c.type)}</span></div>
      <div class="ycardBody"><h3>${esc(c.name)}</h3><p class="muted small">${esc(c.size)}${c.sizeClass && !c.size.includes(c.sizeClass) ? ` · ${esc(c.sizeClass)}` : ''}</p>
        <div class="yprice"><b>from ${esc(F.fmtCr(c.from))}</b><span>${esc(F.fmtHours(c.fastestH))}</span><span class="yeco e${esc(c.eco)}" title="CII-style rating (game)">${esc(c.eco)}</span></div>
        <div class="ybadges">${c.badges.map(badge).join('')}${c.blocked ? `<span class="ybadge b-red">${c.blocked} yard${c.blocked > 1 ? 's' : ''} closed to you</span>` : ''}</div>
        <div class="ycardFoot"><button class="small${inCmp ? ' on' : ''}" data-act="yard-cmp" data-key="new:${esc(c.id)}">${inCmp ? 'Comparing' : 'Compare'}</button><button class="small primary" data-act="yard-pick" data-model="${esc(c.id)}" data-open="1">Configure</button></div></div></article>`;
  }
  pick(model, openSheet = true) {
    const m = MODELS[model]; if (!m) return;
    const keep = this.sel && this.sel.model === model ? this.sel : null;
    const rows = F.yardRows(model, { harbor: this._h?.id, yardCheck: this.yardCheck, here: this._h?.yard?.here });
    const yard = keep?.yard && rows.some((r) => r.yardId === keep.yard) ? keep.yard : (rows.find((r) => !r.blockedBy) || rows[0])?.yardId || null;
    this.sel = keep || { model, opts: defaultOpts(m), yard, preset: null, mark: '', name: '', registry: null, deliverTo: 'yard', loan: false, slot: 'normal', livery: defaultLivery(model) };
    this.sel.yard = yard;
    if (openSheet && this.phone) this.sheet = 'config';
  }
  /** the configured variant at the chosen yard (options the yard cannot build fall back, with reasons) */
  current() {
    const s = this.sel; if (!s) return null;
    // the options pick the yards: a yard that cannot build the chosen options gives way to the cheapest one that can
    const req = F.variantFor(s.model, s.opts, null);
    const rows = F.yardRows(req.variant, { harbor: this._h?.id, yardCheck: this.yardCheck, here: this._h?.yard?.here, jones: this.f.jones });
    if (rows.length && !rows.some((r) => r.yardId === s.yard && !r.blockedBy)) s.yard = (rows.find((r) => !r.blockedBy) || rows[0]).yardId;
    const v = F.variantFor(s.model, s.opts, rows.length ? s.yard : null);
    return { ...v, dropped: req.dropped.concat(v.dropped), model: s.model, yard: s.yard, rows };
  }
  configHTML(h, you) {
    const s = this.sel, m = MODELS[s.model], cur = this.current();
    const variant = cur.variant;
    const rows = cur.rows;
    const row = rows.find((r) => r.yardId === s.yard) || null;
    const tradeIn = this.tradeInCr();
    const sum = row && !row.blockedBy ? F.orderSummary(variant, s.yard, { tradeIn, slot: s.slot }) : null;
    const inst = sum ? F.instalmentRows(sum.price, s.yard, s.model, 0, variant) : [];
    const fin = row ? financing(s.yard, sum?.price || row.price) : null;
    const groups = F.optionGroups(s.model, s.opts, null);
    const yc = yardById(s.yard)?.cc;
    const reg = s.registry || (yc === 'US' ? 'US' : h?.country || yc || 'PA');
    const regs = [...new Set([reg, h?.country, yc, ...REGISTRIES].filter((c) => typeof c === 'string' && /^[A-Z]{2}$/.test(c)))];
    const row0 = classRow(variant);
    const lv = this.livery();
    const turn = `<div class="yturnWrap"><div class="yturn" data-yard-preview aria-label="3D preview — drag to rotate, wheel or pinch to zoom"></div>
      <div class="yturnBtns"><button class="small" data-act="yard-rot" data-d="-15" title="Rotate left ([)" aria-label="Rotate left">⟲</button><button class="small" data-act="yard-view" data-v="side">Side</button><button class="small" data-act="yard-view" data-v="quarter">¾</button><button class="small" data-act="yard-view" data-v="stern">Stern</button><button class="small" data-act="yard-view" data-v="top">Top</button><button class="small" data-act="yard-rot" data-d="15" title="Rotate right (])" aria-label="Rotate right">⟳</button></div></div>`;
    const yardList = `<div class="yyards" role="radiogroup" aria-label="Yard">${rows.length ? rows.map((r) => {
      const pb = F.politicsBadges({ cc: r.cc, blockText: r.blockText });
      return `<button class="yyard${r.yardId === s.yard ? ' on' : ''}${r.blockedBy ? ' blocked' : ''}" role="radio" aria-checked="${r.yardId === s.yard}" data-act="yard-yard" data-yard="${esc(r.yardId)}" ${r.blockedBy ? `title="${esc(r.blockText)}"` : ''}>
        <span class="yflag">${r.flag}</span><span class="yyn"><b>${esc(r.short)}${r.star ? ' <span class="ystar" title="Speciality: −3 % price, −10 % time">★</span>' : ''}${r.here ? ' <span class="yhere">here</span>' : ''}</b><small>${esc(r.country)} · ${esc(F.SCHEDULE_SHORT[r.schedule] || r.scheduleText)}</small>${pb.length ? `<span class="ybadges">${pb.map(badge).join('')}</span>` : ''}</span>
        <span class="yyp"><b>${esc(r.priceText)}</b><small>${esc(r.hoursText)}</small></span></button>`;
    }).join('') : '<p class="muted">No yard can build this design with these options.</p>'}</div>`;
    const optHTML = groups.map((g) => `<fieldset class="yopt"><legend>${esc(g.label)}</legend>${g.items.map((i) => `<label class="${i.ok ? '' : 'off'}" title="${esc(i.why || `price × ${(i.price ?? 1).toFixed(3)}${i.burn && i.burn !== 1 ? ` · fuel × ${i.burn.toFixed(2)}` : ''}`)}"><input type="${g.multi ? 'checkbox' : 'radio'}" name="yo-${g.group}" data-act="yard-opt" data-g="${g.group}" data-t="${esc(i.token ?? '')}"${i.on ? ' checked' : ''}${i.ok ? '' : ' disabled'}> ${esc(i.text)}${i.ok ? '' : ` <small class="why">${esc(i.why)}</small>`}</label>`).join('')}</fieldset>`).join('');
    const dropped = cur.dropped.length ? `<p class="ywarn">${cur.dropped.map((d) => esc(d.why)).join(' ')}</p>` : '';
    const livHTML = `<fieldset class="yopt ylivery"><legend>Livery</legend><div class="yswatches">${F.LIVERY_PRESETS.map((p) => `<button class="yswatch${s.preset === p.id ? ' on' : ''}" data-act="yard-livery" data-preset="${p.id}" title="${esc(p.name)}" aria-label="${esc(p.name)}"><i style="background:${F.hex6(p.hull)}"></i><i style="background:${F.hex6(p.house)}"></i><i style="background:${F.hex6(p.funnel)}"></i></button>`).join('')}</div>
      <div class="ycolors"><label>Hull<input type="color" data-yl="hull" value="${F.hex6(lv.hull)}"></label><label>Boot-top<input type="color" data-yl="boot" value="${F.hex6(lv.boot)}"></label><label>House<input type="color" data-yl="house" value="${F.hex6(lv.house)}"></label><label>Funnel<input type="color" data-yl="funnel" value="${F.hex6(lv.funnel)}"></label></div>
      <div class="yrow2"><label>Company mark<input type="text" maxlength="2" data-yl="mark" value="${esc(s.mark || '')}" placeholder="AB" autocapitalize="characters"></label><label>Name<input type="text" maxlength="24" data-yl="name" value="${esc(s.name || '')}" placeholder="her name"></label></div></fieldset>`;
    const flagHTML = `<label class="yline">Flag<select data-yc="registry">${regs.map((c) => `<option value="${c}"${c === reg ? ' selected' : ''}>${F.flagOf(c)} ${esc(F.countryName(c))}${c === h?.country ? ' (here)' : ''}</option>`).join('')}</select></label>
      ${yc === 'US' ? `<p class="ynote b-blue">US-built: under the US flag and owned by a US company she may trade between US ports. Re-flagging abroad loses that right for ever (46 U.S.C. §12132).</p>` : ''}`;
    const payHTML = sum ? `<table class="ypay"><thead><tr><th>Instalment</th><th>%</th><th>Due</th><th class="r">Credits</th></tr></thead><tbody>${inst.map((r) => `<tr><td>${esc(r.label)}</td><td>${r.pct}</td><td>${esc(r.atText)}</td><td class="r">${esc(r.crText)}</td></tr>`).join('')}</tbody></table>
      <label class="yline">Payment<select data-yc="loan"><option value="0"${!s.loan ? ' selected' : ''}>Cash</option>${fin ? `<option value="1"${s.loan ? ' selected' : ''}>Loan ${Math.round(fin.ltv * 100)} % over ${fin.years} y · ${esc(fin.name)}</option>` : ''}</select></label>` : '';
    const delHTML = `<fieldset class="yopt"><legend>Delivery</legend><label><input type="radio" name="yd" data-act="yard-del" data-to="yard"${s.deliverTo !== 'home' ? ' checked' : ''}> At the yard (${esc(yardById(s.yard)?.harbor || '')})</label><label><input type="radio" name="yd" data-act="yard-del" data-to="home"${s.deliverTo === 'home' ? ' checked' : ''}> Delivery crew to my home port</label>
      <label title="Skip the yard's backlog for 12 % more"><input type="checkbox" data-act="yard-slot"${s.slot === 'resale' ? ' checked' : ''}> Buy an earlier slot (resale, +12 %)</label></fieldset>`;
    const sheet = F.specSheet(variant, s.yard).map((sec) => `<details class="yspec"><summary>${esc(sec.title)}</summary><dl>${sec.rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></details>`).join('');
    const blocked = row?.blockedBy ? `<p class="ywarn">${esc(row.blockText)}</p>` : '';
    const canOrder = !!sum && (you?.money ?? 0) >= sum.dueNow && !row?.blockedBy;
    const foot = `<div class="yfoot"><div class="ysum">${sum ? `<span>Due now <b>${esc(sum.dueText)}</b></span><span>Total <b>${esc(sum.priceText)}</b></span><span>Delivery <b>${esc(sum.hoursText)}</b></span>` : '<span class="muted">Choose a yard</span>'}</div>
      <div class="ybtns"><button class="small" data-act="yard-cmp" data-key="cfg">Compare</button><button class="primary" data-act="yard-order" ${canOrder ? '' : 'disabled'} title="${sum && !canOrder ? esc(`You need ${F.fmtCr(sum.dueNow)} for the contract instalment.`) : ''}">Order — ${esc(sum ? sum.dueText : '—')}</button></div></div>`;
    return `<div class="yconf"><div class="yconfHead"><h3>${esc(m.refName.split(' (')[0])}</h3><p class="muted small">${esc(F.sizeLine(m))} · ${m.length} × ${m.beam} × ${m.draft} m · ${esc(m.engine.label)} · burn ${row0?.burn ?? m.burn} t/h · ref. ${esc(F.fmtUsd(m.usdM))}</p></div>
      ${turn}
      <div class="yacc">
        <details open class="ysec"><summary>Yard <span class="muted small">${rows.filter((r) => !r.blockedBy).length} can build her</span></summary>${yardList}${blocked}</details>
        <details ${this.phone ? '' : 'open'} class="ysec"><summary>Options</summary>${optHTML}${dropped}</details>
        <details ${this.phone ? '' : 'open'} class="ysec"><summary>Livery and name</summary>${livHTML}</details>
        <details ${this.phone ? '' : 'open'} class="ysec"><summary>Flag, payments and delivery</summary>${flagHTML}${payHTML}${delHTML}</details>
        <details class="ysec"><summary>Spec sheet</summary>${sheet}</details>
      </div>${foot}</div>`;
  }
  livery() {
    const s = this.sel; if (!s) return null;
    const base = s.livery || defaultLivery(s.model);
    const l = { ...base, mark: s.mark && /^[A-Z]{1,2}$/.test(s.mark) ? s.mark : null };
    l.nameColor = l.hull > 0x999999 ? 0x1b1b1b : 0xffffff;
    return l;
  }
  tradeInCr() { const t = (this._h?.yard?.tradeIn || []).find((x) => x.vesselId === this.tradeIn); return t ? t.cr : 0; }

  // ---------------------------------------------------------------------------------------------- Stock & resale
  secStock(h, you) {
    const stock = h?.yard?.stock || [];
    const t = this.tradeInCr();
    const cards = stock.map((s) => {
      const y = yardById(s.yard), m = MODELS[parseVariant(s.variant)?.model];
      const cost = s.price - t;
      return `<article class="ycard wide"><div class="ythumbBox">${this.thumbImg(s.variant, { w: 320, h: 180, livery: s.livery })}<span class="ytype">${esc(F.flagOf(y?.cc))} ${esc(F.yardShort(y))}</span></div>
        <div class="ycardBody"><h3>${esc(m?.refName.split(' (')[0] || s.name)}</h3><p class="muted small">${esc(m ? F.sizeLine(m) : '')} · finished hull, delivered now</p>
        <div class="yprice"><b>${esc(F.fmtCr(s.price))}</b><span>+${Math.round((YARD.STOCK_PREMIUM - 1) * 100)} % for delivery today</span></div>
        <div class="ybadges">${F.politicsBadges({ cc: y?.cc }).map(badge).join('')}</div>
        <div class="ycardFoot"><button class="small" data-act="yard-cmp" data-key="stock:${esc(s.id)}">Compare</button><button class="small primary" data-act="yard-buy-stock" data-id="${esc(s.id)}" ${(you?.money ?? 0) >= cost ? '' : 'disabled'}>Buy ${t ? `(${esc(F.fmtCr(cost))} after trade-in)` : ''}</button></div></div></article>`;
    }).join('');
    const local = h?.yard?.local ? `<p class="muted small">The ${esc(h.name)} boatyard builds boats up to ${YARD.LOCAL_MAX_LOA} m to order (Newbuild, pick “${esc(h.name)} boatyard”).</p>` : '';
    return `${this.tradeInBox(h)}${stock.length ? `<div class="ycards">${cards}</div>` : `<div class="yempty">No finished hulls at the yards here today — stock changes every few hours. Newbuild orders can buy an earlier slot (resale, +${Math.round((YARD.RESALE_SLOT_PREMIUM - 1) * 100)} %) instead.</div>`}${local}`;
  }
  tradeInBox(h) {
    const list = h?.yard?.tradeIn || [];
    if (!list.length) return '';
    return `<div class="ytrade"><b>Trade-in</b>${list.map((t) => `<label><input type="radio" name="ytr" data-act="yard-tradein" data-id="${esc(t.vesselId)}"${this.tradeIn === t.vesselId ? ' checked' : ''}> ${esc(t.name)} · ${esc(F.fmtCr(t.cr))}</label>`).join('')}<label><input type="radio" name="ytr" data-act="yard-tradein" data-id=""${!this.tradeIn ? ' checked' : ''}> none</label></div>`;
  }

  // ---------------------------------------------------------------------------------------------- Second-hand
  secUsed(h, you) {
    const now = this.now();
    const used = (h?.yard?.used || []).map((l) => ({ l, c: F.listingCard(l, now) }));
    if (!used.length) return `<div class="yempty">No second-hand ships listed here right now; listings refresh every ${6} hours.</div>`;
    const t = this.tradeInCr();
    return `${this.tradeInBox(h)}<div class="ycards">${used.map(({ l, c }) => {
      const open = this.hist.has(c.id);
      const pb = F.politicsBadges({ cc: c.builtIn, jonesLost: c.jonesLost });
      const insp = l.report || l.condExact != null;
      return `<article class="ycard wide used"><div class="ythumbBox">${this.thumbImg(c.variant, { w: 320, h: 180 })}<span class="ytype">${c.flag} built ${c.built}</span>${c.inspected ? '<span class="ycheck">inspected</span>' : ''}</div>
        <div class="ycardBody"><h3>${esc(c.title)}</h3> <p class="muted small">${c.age} year${c.age === 1 ? '' : 's'} · ${esc(c.country)}-built · ${c.owners} owner${c.owners > 1 ? 's' : ''} · class ${esc(c.cls || '—')}</p>
        <div class="ycond"><span>Condition <b>${esc(c.condText)}</b>${c.inspected ? '' : ' <small>(estimate until inspected)</small>'}</span><span class="ymeter"><i style="left:${c.inspected ? c.cond : l.condLo}%;width:${c.inspected ? 1 : Math.max(1, l.condHi - l.condLo)}%"></i></span></div>
        <div class="yprice"><b>${esc(c.priceText)}</b><span>PSC: ${esc(c.psc)}</span></div>
        ${c.defect ? `<p class="ywarn">Surveyor: ${esc(c.defect)}</p>` : ''}
        <div class="ybadges">${pb.map(badge).join('')}${c.flags.length > 1 ? `<span class="ybadge b-muted">${c.flags.length} flags</span>` : ''}</div>
        ${open ? `<ol class="yhist">${c.history.map((e) => `<li class="k-${e.kind}"><b>${e.year}</b> ${esc(e.text)}</li>`).join('')}</ol>` : ''}
        <div class="ycardFoot"><button class="small" data-act="yard-hist" data-id="${esc(c.id)}" aria-expanded="${open}">${open ? 'Hide history' : 'History'}</button>
          <button class="small" data-act="yard-inspect" data-id="${esc(c.id)}" ${insp ? 'disabled' : ''} title="A surveyor reports the exact condition and hidden defects in ${YARD.INSPECT_H} h">${insp ? 'Inspected' : `Inspect · ${esc(c.feeText)} · ${YARD.INSPECT_H} h`}</button>
          <button class="small" data-act="yard-cmp" data-key="used:${esc(c.id)}">Compare</button>
          <button class="small primary" data-act="yard-buy-used" data-id="${esc(c.id)}" ${(you?.money ?? 0) >= c.price - t ? '' : 'disabled'}>Buy</button></div></div></article>`;
    }).join('')}</div>`;
  }

  // ---------------------------------------------------------------------------------------------- Orders
  secOrders(h) {
    const now = this.now();
    const orders = (h?.yard?.orders || this._you?.orders || []).map((o) => ({ o, v: F.orderView(o, now) }));
    if (!orders.length) return `<div class="yempty">No ships on order. Orders appear here with their build progress, instalments and delivery.</div>`;
    return `<div class="yorders">${orders.map(({ o, v }) => `<article class="yorder${v.open ? '' : ' done'}">
      <div class="ythumbBox">${this.thumbImg(o.variant, { w: 240, h: 150, stage: Math.round(v.stage * 20) / 20, livery: o.livery, angle: 'quarter' })}</div>
      <div class="yorderBody"><div class="yorderHead"><h3>${esc(v.title)}</h3><span class="ystate s-${esc(v.state)}">${esc(v.stateText)}</span></div>
        <p class="muted small">${esc(v.model)} · ${v.flag} ${esc(v.yard)} · ${esc(v.priceText)}${v.delayed ? ' · <span class="down">delayed (yard pays damages)</span>' : ''}</p>
        <div class="yprog" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(v.progress * 100)}"><i style="width:${Math.round(v.progress * 100)}%"></i>${v.ticks.map((t) => `<b class="${t.paid ? 'paid' : ''}" style="left:${Math.round(t.at * 100)}%" title="${esc(t.label)}"></b>`).join('')}</div>
        <div class="yticks">${v.ticks.map((t) => `<span style="left:${Math.round(t.at * 100)}%">${esc(t.label)}</span>`).join('')}</div>
        <p class="small">${v.next ? `Next: <b>${esc(v.next.label)}</b> ${esc(v.next.crText)} — <span class="${v.next.overdue ? 'down' : ''}">${esc(v.next.dueText)}</span>` : 'Fully paid.'}${v.deliverText && v.open ? ` · delivery ${esc(v.deliverText)}` : ''}</p>
        ${v.open ? `<div class="ycardFoot">${v.next ? `<button class="small primary" data-act="yard-pay" data-id="${esc(o.id)}">Pay now · ${esc(v.next.crText)}</button>` : ''}
          <select data-act-change="yard-deliver" data-id="${esc(o.id)}" aria-label="Delivery"><option value="yard"${o.deliverTo !== 'home' ? ' selected' : ''}>Hand over at the yard</option><option value="home"${o.deliverTo === 'home' ? ' selected' : ''}>Delivery crew home</option><option value="express">Express delivery home</option></select>
          <button class="small danger" data-act="yard-cancel" data-id="${esc(o.id)}" title="The first instalment is lost; later paid instalments come back × ${YARD.CANCEL_REFUND}">Cancel</button></div>` : ''}</div></article>`).join('')}</div>`;
  }

  // ---------------------------------------------------------------------------------------------- Sell / trade-in
  secSell(h, you) {
    const list = h?.yard?.tradeIn || [];
    const sell = h?.yard?.sellValue ?? h?.sellValue ?? 0;
    return `<div class="ysell"><p>The yard values your ships at the price below (age, condition, build country${h?.country === 'US' ? ', and the Jones Act premium in US ports' : ''}). Pick one as a trade-in for an order or a purchase, or sell the one you are aboard.</p>
      ${list.length ? `<div class="ycards">${list.map((t) => `<article class="ycard wide"><div class="ythumbBox">${this.thumbImg(t.cls, { w: 320, h: 180 })}</div><div class="ycardBody"><h3>${esc(t.name)}</h3><p class="muted small">${esc(MODELS[parseVariant(t.cls)?.model]?.refName || t.cls)}</p>
        <div class="yprice"><b>${esc(F.fmtCr(t.cr))}</b></div><div class="ycardFoot"><button class="small${this.tradeIn === t.vesselId ? ' on' : ''}" data-act="yard-tradein" data-id="${esc(t.vesselId)}">${this.tradeIn === t.vesselId ? 'Trade-in ✓' : 'Use as trade-in'}</button></div></div></article>`).join('')}</div>` : '<div class="yempty">No ship of yours is moored here and free to trade in (unloaded, no contracts, not the one you are aboard).</div>'}
      <div class="ycardFoot"><button class="danger" data-act="yard-sell" ${sell > 0 ? '' : 'disabled'}>Sell the ship I am aboard · ${esc(F.fmtCr(sell))}</button></div></div>`;
  }

  // ---------------------------------------------------------------------------------------------- compare
  cmpItem(key) {
    const h = this._h, y = h?.yard || {};
    const [kind, id] = key.split(':');
    if (kind === 'used') { const l = (y.used || []).find((x) => x.id === id); if (!l) return null; const c = F.listingCard(l); return { key, title: `${c.short} (${c.age} y)`, variant: l.cls, price: l.price, hours: null, resale: YARD_COUNTRIES[c.builtIn]?.resale ?? 1, cond: c.cond ?? Math.round((l.condLo + l.condHi) / 2) }; }
    if (kind === 'stock') { const s = (y.stock || []).find((x) => x.id === id); if (!s) return null; return { key, title: `${MODELS[parseVariant(s.variant).model].short} (stock)`, variant: s.variant, price: s.price, hours: null, resale: YARD_COUNTRIES[yardById(s.yard)?.cc]?.resale ?? 1 }; }
    const variant = kind === 'cfg' ? this.current()?.variant : id;
    const yardId = kind === 'cfg' ? this.sel?.yard : null;
    const rows = F.yardRows(variant, { harbor: h?.id, yardCheck: this.yardCheck });
    const r = (yardId && rows.find((x) => x.yardId === yardId)) || rows.find((x) => !x.blockedBy);
    if (!r) return null;
    return { key: kind === 'cfg' ? `cfg:${variant}@${r.yardId}` : key, title: `${MODELS[parseVariant(variant).model].short}${kind === 'cfg' ? ` · ${F.yardShort(r.yardId)}` : ''}`, variant, price: r.price, hours: r.hours, resale: r.resale };
  }
  toggleCmp(key) {
    const it = this.cmpItem(key); if (!it) return;
    const i = this.cmp.findIndex((x) => x.key === it.key);
    if (i >= 0) this.cmp.splice(i, 1); else { if (this.cmp.length >= 4) this.cmp.shift(); this.cmp.push(it); }
    if (this.cmp.length < 2) this.cmpOpen = false;
  }
  trayHTML() {
    return `<div class="ytray"><b>Compare ${this.cmp.length}/4</b><div class="yslots">${this.cmp.map((c) => `<span class="yslot">${esc(c.title)}<button class="iconBtn small" data-act="yard-cmp-rm" data-key="${esc(c.key)}" aria-label="Remove ${esc(c.title)}">×</button></span>`).join('')}</div><button class="small" data-act="yard-cmp-clear">Clear</button><button class="small primary" data-act="yard-cmp-open" ${this.cmp.length < 2 ? 'disabled title="Pick at least two"' : ''}>Compare side by side</button></div>`;
  }
  compareHTML() {
    const t = F.compareRows(this.cmp);
    return `<div class="ycmp" role="dialog" aria-label="Compare ships"><div class="ycmpBox"><div class="ysheetHead"><b>Compare</b><span class="muted small">best value in each row marked ★</span><button data-act="yard-cmp-close">Close</button></div>
      <div class="ycmpScroll"><table><thead><tr><th></th>${this.cmp.map((c) => `<th>${this.thumbImg(c.variant, { w: 200, h: 120, angle: 'side', cls: 'ycmpImg' })}<span>${esc(c.title)}</span></th>`).join('')}</tr></thead>
      <tbody>${t.rows.map((r) => `<tr><th>${esc(r.label)}</th>${r.values.map((v, i) => `<td class="${r.best === i ? 'best' : ''}">${esc(v)}${r.best === i ? ' ★' : ''}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div></div>`;
  }

  // ---------------------------------------------------------------------------------------------- after render: preview, thumbs, inputs
  root() { return typeof document !== 'undefined' ? document.querySelector('[data-yard-root]') : null; }
  afterRender() {
    const root = this.root(); if (!root) return;
    if (!root.dataset.bound) {
      root.dataset.bound = '1';
      root.addEventListener('change', (e) => this.onChange(e));
      root.addEventListener('input', (e) => { if (e.target.matches?.('input[type=color]')) this.onChange(e); });
      root.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches?.('[data-act="yard-pick"]')) { e.preventDefault(); this.action('yard-pick', e.target, e); } });
    }
    const host = root.querySelector('[data-yard-preview]');
    const cur = this.current();
    if (host && cur) { this.preview.mount(host); this.preview.show(cur.variant, { livery: this.livery(), name: this.sel.name || '', stage: 1 }); }
    const imgs = [...root.querySelectorAll('img[data-ythumb]:not([src])')];
    const load = (img) => {
      const o = { w: +img.dataset.w, h: +img.dataset.h, angle: img.dataset.angle, stage: +img.dataset.stage, livery: img.dataset.livery ? JSON.parse(img.dataset.livery) : null };
      yardThumb(img.dataset.ythumb, o).then((url) => { if (url && img.isConnected) img.src = url; });
    };
    if (typeof IntersectionObserver === 'function') {
      this.io?.disconnect();
      this.io = new IntersectionObserver((es) => { for (const e of es) if (e.isIntersecting) { this.io.unobserve(e.target); load(e.target); } }, { rootMargin: '200px' });
      for (const img of imgs) this.io.observe(img);
    } else imgs.forEach(load);
  }
  onChange(e) {
    const el = e.target;
    if (el.dataset.yf) {
      const k = el.dataset.yf;
      this.f[k] = el.type === 'checkbox' ? el.checked : ['maxPrice', 'maxH'].includes(k) ? Math.max(0, Number(el.value) || 0) : el.value;
      if (k === 'jones' && this.sel) this.pick(this.sel.model, false);
      return this.rerender();
    }
    if (el.dataset.yl && this.sel) {
      const k = el.dataset.yl;
      if (k === 'mark') this.sel.mark = el.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2);
      else if (k === 'name') this.sel.name = el.value.slice(0, 24);
      else { const v = F.parseHex(el.value); if (v != null) { this.sel.livery = { ...(this.sel.livery || defaultLivery(this.sel.model)), [k]: v }; this.sel.preset = null; } }
      if (e.type === 'input') { const cur = this.current(); if (cur) this.preview.show(cur.variant, { livery: this.livery(), name: this.sel.name || '', stage: 1 }); return; }
      return this.rerender();
    }
    if (el.dataset.yc && this.sel) {
      if (el.dataset.yc === 'registry') this.sel.registry = el.value;
      if (el.dataset.yc === 'loan') this.sel.loan = el.value === '1';
      return this.rerender();
    }
    if (el.dataset.actChange === 'yard-deliver') {
      const v = el.value;
      this.send('yard_deliver', { orderId: el.dataset.id, to: v === 'yard' ? 'yard' : 'home', express: v === 'express' });
    }
  }

  // ---------------------------------------------------------------------------------------------- actions
  now() { return Math.floor(this.app?.simTime || Date.now() / 1000); }
  send(action, extra) { if (this.net?.action) this.net.action(action, extra); else console.info('[yard] action', action, extra); }
  /** click delegation from hud.js: act = data-act (always starts with 'yard-') */
  action(act, el, e) {
    const d = el?.dataset || {};
    switch (act) {
      case 'yard-sec': this.sec = d.sec || 'new'; this.sheet = null; break;
      case 'yard-sheet': this.sheet = d.s || null; if (!this.sheet) this.preview.dispose(); break;
      case 'yard-pick': if (e?.target?.closest?.('[data-act="yard-cmp"]')) return; this.pick(d.model, true); break;
      case 'yard-yard': if (this.sel) this.sel.yard = d.yard; break;
      case 'yard-opt': {
        if (!this.sel) return;
        const g = d.g, t = d.t || null, o = this.sel.opts;
        if (['esd', 'rot', 'air'].includes(g)) o[g] = !o[g]; else o[g] = t === '' ? null : t;
        if (g === 'spec' && !t) o.spec = 'std';
        break;
      }
      case 'yard-livery': if (this.sel) { this.sel.preset = d.preset; this.sel.livery = F.liveryFrom(d.preset, this.sel.mark, this.sel.livery); } break;
      case 'yard-del': if (this.sel) this.sel.deliverTo = d.to === 'home' ? 'home' : 'yard'; break;
      case 'yard-slot': if (this.sel) this.sel.slot = this.sel.slot === 'resale' ? 'normal' : 'resale'; break;
      case 'yard-rot': this.preview.rotate(Number(d.d) || 15); return;
      case 'yard-view': this.preview.setView(d.v); return;
      case 'yard-cmp': this.toggleCmp(d.key); break;
      case 'yard-cmp-rm': { const i = this.cmp.findIndex((x) => x.key === d.key); if (i >= 0) this.cmp.splice(i, 1); if (this.cmp.length < 2) this.cmpOpen = false; break; }
      case 'yard-cmp-open': this.cmpOpen = this.cmp.length >= 2; break;
      case 'yard-cmp-close': this.cmpOpen = false; break;
      case 'yard-cmp-clear': this.cmp = []; this.cmpOpen = false; break;
      case 'yard-hist': if (this.hist.has(d.id)) this.hist.delete(d.id); else this.hist.add(d.id); break;
      case 'yard-tradein': this.tradeIn = d.id || null; if (this.tradeIn && this.tradeIn === this._lastTrade && el?.tagName === 'BUTTON') this.tradeIn = null; this._lastTrade = this.tradeIn; break;
      case 'yard-order': return this.order();
      case 'yard-buy-stock': { const s = (this._h?.yard?.stock || []).find((x) => x.id === d.id); if (!s) return; if (this.confirm(`Buy this finished ${MODELS[parseVariant(s.variant).model].short} for ${F.fmtCr(s.price)}?`)) this.send('yard_buy_stock', { stockId: s.id, tradeIn: this.tradeIn || null, livery: this.sel?.model === s.variant ? this.livery() : null }); return; }
      case 'yard-inspect': { const l = (this._h?.yard?.used || []).find((x) => x.id === d.id); if (!l) return; this.send('yard_inspect', { listingId: l.id }); return; }
      case 'yard-buy-used': { const l = (this._h?.yard?.used || []).find((x) => x.id === d.id); if (!l) return; const c = F.listingCard(l); if (this.confirm(`Buy the ${c.age}-year-old ${c.title} for ${c.priceText}?${c.inspected ? '' : ' She has not been inspected.'}`)) this.send('yard_buy_used', { listingId: l.id, tradeIn: this.tradeIn || null }); return; }
      case 'yard-pay': this.send('yard_pay', { orderId: d.id }); return;
      case 'yard-cancel': if (this.confirm('Cancel this order? The contract instalment is lost; later paid instalments come back at 80 %.')) this.send('yard_cancel', { orderId: d.id }); return;
      case 'yard-sell': if (this.confirm('Sell the ship you are aboard?')) this.send('sell_ship'); return;
      default: return;
    }
    this.rerender();
  }
  order() {
    const s = this.sel; if (!s) return;
    const cur = this.current();
    const sum = F.orderSummary(cur.variant, s.yard, { tradeIn: this.tradeInCr(), slot: s.slot }); if (!sum) return;
    const y = yardById(s.yard);
    if (!this.confirm(`Order a ${MODELS[s.model].short} at ${y?.name || s.yard} for ${sum.priceText}? ${sum.dueText} is due now, delivery in ${sum.hoursText}.`)) return;
    this.send('yard_order', { variant: cur.variant, yard: s.yard, livery: this.livery(), name: s.name || null, registry: s.registry || null, deliverTo: s.deliverTo, slot: s.slot, tradeIn: this.tradeIn || null, loan: !!s.loan });
    this.sec = 'orders'; this.sheet = null; this.rerender();
  }
  /** keys while the shipyard is open: N / U / O jump to Newbuild / Used / Orders, [ ] rotate the preview. true = handled. */
  key(e) {
    if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return false;
    const k = e.key?.toLowerCase();
    if (KEYS[k] && !e.ctrlKey && !e.metaKey && !e.altKey) { this.sec = KEYS[k]; this.sheet = null; this.rerender(); return true; }
    if (e.key === '[') { this.preview.rotate(-15); return true; }
    if (e.key === ']') { this.preview.rotate(15); return true; }
    return false;
  }
  /** the harbour sheet closed: free the GL context */
  close() { this.preview.dispose(); this.io?.disconnect(); this.sheet = null; }
}
/**
 * The office order book (H13b, hq.js / fleet.js): one row per open order — yard, hull number, progress bar with
 * milestone ticks, next instalment and when it is due. `orders` = you.orders (compact, §7.3) or harbor.yard.orders.
 */
export function orderBookHTML(orders, now) {
  const open = (orders || []).filter((o) => o && ['ordered', 'building', 'launched', 'ready'].includes(o.state));
  if (!open.length) return '';
  return `<div class="yorderBook"><h3>Order book <small class="muted">${open.length} on order</small></h3>${open.map((o) => { const v = F.orderView(o, now); return `<div class="yobRow"><span class="yobName"><b>${esc(v.title)}</b><small>${v.flag} ${esc(v.yard)} · ${esc(v.stateText)}</small></span>
    <span class="yprog small" role="progressbar" aria-valuenow="${Math.round(v.progress * 100)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${Math.round(v.progress * 100)}%"></i>${v.ticks.map((t) => `<b class="${t.paid ? 'paid' : ''}" style="left:${Math.round(t.at * 100)}%"></b>`).join('')}</span>
    <span class="yobNext">${v.next ? `${esc(v.next.label)} ${esc(v.next.crText)} <small class="${v.next.overdue ? 'down' : 'muted'}">${esc(v.next.dueText)}</small>` : '<small class="muted">paid</small>'}</span></div>`; }).join('')}</div>`;
}
export { localYard };
