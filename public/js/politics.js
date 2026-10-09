// World politics, client lane (docs/WORLD-POLITICS-CONTRACT.md §5, §6.1): app.politics = new PoliticsUi(app).
// Loads the dataset (/api/politics with ETag, falling back to /shared/politics/*.json), keeps the politics parts of the
// server messages (you.pol, harbor.rules, fleet.compliance, pol_home_plan), and renders: the harbour sheet's Rules tab,
// the contract badges, the chart overlays + legend + popovers, the voyage risk check sheet, the HQ Compliance panel,
// the move-home card and the re-flag picker. Every action goes to the server as a `pol_*` action (§6.3); the server
// re-checks everything. Phase 2 hooks: docs/WORLD-POLITICS-CLIENT-PHASE2.md.
import { loadDataset, makeCtx, harbourRules, riskCheck, jobCheck, avoidDiscs } from '../../shared/politics.js';
import { SHIP_CLASSES } from '../../shared/constants.js';
import * as F from './politicsfmt.js';
import * as V from './politicsview.js';
import * as C from './politicschart.js';

export const PARTS = ['meta', 'sources', 'countries', 'ports', 'registries', 'regimes', 'areas', 'agreements', 'tariffs', 'psc'];
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const $ = (id) => (typeof document !== 'undefined' ? document.getElementById(id) : null);
function ensureCss(id, href) {
  if (typeof document === 'undefined' || document.getElementById(id)) return;
  const l = document.createElement('link'); l.id = id; l.rel = 'stylesheet'; l.href = href; document.head.appendChild(l);
}
const short = (n) => String(n || '').split(' (')[0];

export class PoliticsUi {
  /** opts: { cssHref, noInject, fetch } */
  constructor(app, opts = {}) {
    this.app = app; this.opts = opts;
    this.parts = null; this.ds = null; this.etag = null; this._hkey = '';
    this.rules = null; this.rulesFor = null; this.pol = null; this.compliance = null; this.plan = null;
    this.layers = { ...Object.fromEntries(F.CHART_LAYERS.map((L) => [L.id, L.on])), ...store.get('polLayers', {}) };
    this.legendCollapsed = store.get('polLegendC', null);
    this.hits = []; this.risk = null; this.modal = null; this.highlight = null;
    try { ensureCss('polCss', opts.cssHref || '/css/politics.css'); if (!opts.noInject) this.inject(); this.bind(); } catch (e) { console.warn('[politics] ui unavailable', e); }
  }

  // ---------------------------------------------------------------------------------------------- dataset
  async load(url = '/api/politics') {
    const f = this.opts.fetch || (typeof fetch !== 'undefined' ? fetch : null); if (!f) return null;
    try {
      const r = await f(url, { headers: this.etag ? { 'If-None-Match': this.etag } : {} });
      if (r.status === 304 && this.parts) return this.ds;
      if (r.ok) { this.etag = r.headers?.get?.('ETag') || null; this.setParts(await r.json()); return this.ds; }
    } catch { /* fall back to the static files */ }
    try {
      const got = await Promise.all(PARTS.map((k) => f(`/shared/politics/${k}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null)));
      if (got[0]) { this.setParts(Object.fromEntries(PARTS.map((k, i) => [k, got[i]]))); return this.ds; }
    } catch (e) { console.warn('[politics] dataset unavailable', e); }
    return null;
  }
  setParts(parts) { this.parts = parts; this._hkey = ''; this.dataset(); this.refresh(); }
  /** The indexed dataset with the world's harbour table (rebuilt when the harbour list arrives or changes). */
  dataset() {
    if (!this.parts) return null;
    const hs = this.app.world?.harbors || [], key = `${hs.length}|${hs[0]?.id || ''}`;
    if (!this.ds || key !== this._hkey) { this._hkey = key; this.ds = loadDataset({ ...this.parts, harbors: hs.map((h) => ({ id: h.id, name: h.name, country: h.country, lat: h.lat, lon: h.lon, size: h.size })) }); }
    return this.ds;
  }
  now() { return Number.isFinite(this.app.simTime) && this.app.simTime > 1e9 ? this.app.simTime : Date.now() / 1000; }
  phone() { return typeof window !== 'undefined' && (document.body.classList.contains('touch') || window.innerWidth < 700); }
  net(action, fields = {}) { try { this.app.net?.action?.(action, fields); } catch (e) { console.warn('[politics] send failed', e); } }

  // ---------------------------------------------------------------------------------------------- messages
  onYou(you) { if (you && 'pol' in you) this.pol = you.pol; }
  onHarbor(h) { this.rules = h?.rules ?? null; this.rulesFor = h?.id || null; }
  onFleet(view) {
    if (!view || !('compliance' in view)) return;
    this.compliance = view.compliance;
    if (this.modal?.kind === 'reflag') this.renderModal();
    if (this.app.hq?.isOpen?.() && this.app.hq.tab === 'rules') this.app.hq.render?.();
  }
  onMessage(m) {
    if (m?.t !== 'pol_home_plan') return false;
    this.plan = m.plan; if (this.modal?.kind === 'move') this.renderModal();
    return true;
  }
  /** The company/ship context for client-side previews (the server re-checks every action). */
  ctx() {
    const ds = this.dataset(), you = this.app.you, c = this.pol?.ctx || {};
    if (!ds) return null;
    return makeCtx(ds, { home: c.home ?? null, flag: c.flag ?? c.home ?? null, rep: c.rep || {}, clearance: this.pol?.clearance || {}, cargo: you?.cargo || [], simTime: this.now() });
  }
  vessel() { const you = this.app.you; return you ? { cls: you.ship?.cls || 'coaster', cond: Number.isFinite(you.cond) ? you.cond : 100, built: you.built, psc: you.psc } : null; }
  refresh() {
    const hud = this.app.hud;
    if (hud?.harborOpen?.() && hud.harborTab === 'rules') hud.renderTab?.('rules');
    if (this.app.hq?.isOpen?.() && this.app.hq.tab === 'rules') this.app.hq.render?.(true);
    this.app.hud?.chart?.requestDraw?.();
    this.opts.onRefresh?.();
  }

  // ---------------------------------------------------------------------------------------------- harbour sheet (H25)
  /** The rules for harbour `h`: the server's harbor.rules, else a preview computed here. */
  rulesOf(h) {
    if (h?.rules) return { rules: h.rules, preview: false };
    if (this.rules && this.rulesFor === h?.id) return { rules: this.rules, preview: false };
    const ds = this.dataset(), ctx = this.ctx();
    if (!ds || !ctx || !h || !ds.harbors[h.id]) return { rules: null, preview: false };
    return { rules: harbourRules(ds, ctx, h.id, this.vessel()), preview: true };
  }
  quickTile(h) { const { rules } = this.rulesOf(h); const q = F.quickTile(rules); return [q.tab, 'flag', q.title, q.sub, q.tone]; }
  bannerChips(h) { return V.bannerChipsHTML(this.rulesOf(h).rules); }
  rulesTabHTML(h, you = this.app.you) {
    const { rules, preview } = this.rulesOf(h), ds = this.dataset(), ctx = this.ctx();
    const extra = ds && ctx && h && ds.harbors[h.id] ? V.sellBlocks(ds, ctx, h.id) : [];
    return V.rulesTabHTML(rules, { ds, nowS: this.now(), phone: this.phone(), harborName: short(h?.name), company: you?.company || you?.name, extraBlocked: extra, preview, money: you?.money });
  }
  /** Client-side jobCheck for a board job (badge text; the Accept button is disabled when it blocks). */
  checkJob(job) { const ds = this.dataset(), ctx = this.ctx(); if (!ds || !ctx || !job) return null; try { return jobCheck(ds, ctx, job, this.vessel()); } catch { return null; } }
  badgesFor(job) { return V.jobExtrasHTML(job, this.checkJob(job), { ds: this.dataset() }); }
  blockedWhy(job) { const c = this.checkJob(job); return c && c.ok === false ? F.reasonLine(c.block) : null; }
  contractCardHTML(job) {
    const ds = this.dataset(), hs = this.app.world?.harbors || [], name = (id) => short(hs.find((x) => x.id === id)?.name || id);
    const areas = [...(job.pol?.areas || [])];
    return V.contractCardHTML(job, { ds, check: this.checkJob(job), fromName: name(job.from), toName: name(job.to), rep: this.pol?.ctx?.rep || {}, nowS: this.now(), policyText: ds ? V.policyVerdict(ds, this.compliance?.riskPolicy || 'avoid', areas, job.type) : null });
  }

  // ---------------------------------------------------------------------------------------------- chart (H26)
  drawChartLayers(chart, g) {
    const ds = this.dataset(); if (!ds) { this.hits = []; return; }
    this.hits = C.drawAreas(chart, g, ds, this.layers, { nowS: this.now(), highlight: this.highlight });
    this.syncLegend(chart);
  }
  /** A tap on an area label (any mode) or inside an area (select mode): the popover. Returns true when handled. */
  chartClick(chart, x, y, { selectMode = chart.mode === 'select' } = {}) {
    const ds = this.dataset(); if (!ds) return false;
    const onLabel = this.hits.some((h) => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h);
    if (!onLabel && !selectMode) return false;
    const areas = C.areasUnder(chart, ds, this.layers, x, y, { nowS: this.now(), hits: onLabel ? this.hits : [] });
    if (!areas.length) return false;
    const ll = chart.unproject(x, y);
    chart.openPopup(ll.lat, ll.lon, (head, body) => {
      const b = document.createElement('b'); b.textContent = areas.length > 1 ? `${areas.length} areas here` : F.areaLabel(areas[0]); head.appendChild(b);
      body.insertAdjacentHTML('beforeend', this.popoverHTML(areas));
    });
    return true;
  }
  /** Extra rows for the chart's point popup (select mode / long press). */
  pointPopupRows(lat, lon, body) {
    const ds = this.dataset(); if (!ds || !body) return;
    const areas = C.areasUnder({ unproject: () => ({ lat, lon }), project: () => ({ x: -1e6, y: -1e6 }) }, ds, this.layers, 0, 0, { nowS: this.now() });
    if (areas.length) body.insertAdjacentHTML('beforeend', this.popoverHTML(areas));
  }
  popoverHTML(areas) { const you = this.app.you; return C.popoverHTML(areas, { ds: this.dataset(), nowS: this.now(), cls: you?.ship?.cls, cond: you?.cond, shipName: you?.vesselName || 'your ship' }); }
  setLayer(id, on) {
    if (!(id in this.layers)) return;
    this.layers[id] = !!on; store.set('polLayers', this.layers);
    this.app.hud?.chart?.requestDraw?.(); this.opts.onRefresh?.();
    this.syncLegend(null, true);
  }
  legendHTML() { const c = this.legendCollapsed ?? this.phone(); return C.legendHTML(this.layers, { collapsed: c }); }
  syncLegend(chart, force = false) {
    const body = chart?.body || $('chart')?.parentElement; if (!body || typeof document === 'undefined') return;
    let el = body.querySelector(':scope > .polLegendWrap');
    if (!el) { el = document.createElement('div'); el.className = 'polLegendWrap'; body.appendChild(el); force = true; }
    const key = JSON.stringify([this.layers, this.legendCollapsed ?? this.phone()]);
    if (force || el.dataset.k !== key) { el.dataset.k = key; el.innerHTML = this.legendHTML(); }
  }
  showOnChart(areaId) {
    const ds = this.dataset(), a = ds?.areaById?.[areaId], hud = this.app.hud; if (!a) return;
    const [w, s, e, n] = a.bbox, span = Math.max(e - w, n - s, 0.5);
    this.highlight = areaId; this.layers[F.layerOfKind(a.kind)] = true;
    hud?.hideHarbor?.(); hud?.openChart?.();
    hud?.chart?.setCenter?.((s + n) / 2, (w + e) / 2, Math.max(3, Math.min(9, Math.log2(360 / span) + 0.5)));
    setTimeout(() => { if (this.highlight === areaId) { this.highlight = null; hud?.chart?.requestDraw?.(); } }, 6000);
  }

  // ---------------------------------------------------------------------------------------------- risk check (H28)
  /**
   * Show the voyage risk check. a: { from: {lat, lon}, points: [[lat, lon]…] | [{lat, lon}…], toHarbor, job, title,
   * toName, speedKn, contract, onGo(), onPlanAround(discs) }
   */
  showRiskCheck(a) {
    const ds = this.dataset(), ctx = this.ctx(), you = this.app.you;
    if (!ds || !ctx) { a.onGo?.(); return null; }
    const v = this.vessel() || { cls: 'coaster', cond: 100 }, Cc = SHIP_CLASSES[v.cls] || SHIP_CLASSES.coaster;
    const pts = (a.points || []).map((p) => (Array.isArray(p) ? p : [p.lat, p.lon]));
    const speedKn = a.speedKn || Math.round(Cc.maxKn * 0.85 * 10) / 10;
    const report = riskCheck(ds, ctx, { route: { from: a.from, points: pts }, speedKn, cls: v.cls, cond: v.cond, job: a.job || null, toHarbor: a.toHarbor || null, vessel: v });
    const areaIds = report.lines.map((l) => l.id).concat(a.toHarbor ? [] : []);
    const policyText = V.policyVerdict(ds, this.compliance?.riskPolicy || 'avoid', areaIds, a.job?.type);
    const toId = a.toHarbor, clearance = toId ? ((this.pol?.clearance?.[toId] || 0) > this.now() ? 'valid' : (this.pol?.clearancePending?.[toId] || 0) > this.now() ? 'pending' : null) : null;
    this.risk = { ...a, report, speedKn };
    const html = V.riskCheckHTML(report, {
      ds, nowS: this.now(), title: a.title, toName: a.toName, contract: !!a.contract, refunded: (a.job?.pol?.tier || 0) > 0 || !!a.job?.pol?.refundPremium,
      clearance, policy: a.showPolicy === false ? null : this.compliance?.riskPolicy || 'avoid', policyText, phone: this.phone(),
      ecaCostCr: V.ecaCostFor(report, v.cls, speedKn, v.cond), coverAreas: V.coverAreas(ds, report, v.cls, v.cond),
    });
    this.mountSheet('polRiskWrap', html);
    void you;
    return report;
  }
  /** After the planner laid a contract route (main.js routeToJob): check it before engaging the autopilot. */
  checkPlannedRoute({ job = null, harbor = null, title = '', contract = true, engage = true } = {}) {
    const a = this.app, s = a.ship, pts = (a.route || []).map((p) => [p.lat, p.lon]);
    if (!s || !pts.length) return null;
    const hs = a.world?.harbors || [], to = harbor ? hs.find((x) => x.id === harbor) : null, from = job ? hs.find((x) => x.id === job.from) : null;
    return this.showRiskCheck({
      from: { lat: s.lat, lon: s.lon }, points: pts, toHarbor: harbor, job, contract, toName: short(to?.name), title: title || `${short(from?.name || 'here')} → ${short(to?.name || 'destination')}`,
      onGo: () => { if (engage) a.pilot?.engage?.(true); },
      onPlanAround: (discs) => a.pilot?.planTo?.({ lat: to?.lat ?? pts[pts.length - 1][0], lon: to?.lon ?? pts[pts.length - 1][1], harbor, label: 'around listed areas', avoid: discs.map((d) => ({ lat: d.lat, lon: d.lon, radiusKm: d.radiusM / 1000, name: d.name })), engage: false })
        .then((r) => { if (r?.ok) this.checkPlannedRoute({ job, harbor, title, contract, engage }); }),
    });
  }
  closeRisk() { const el = $('polRiskWrap'); if (el) { el.classList.add('hidden'); el.innerHTML = ''; } this.risk = null; }

  // ---------------------------------------------------------------------------------------------- HQ Compliance (H27)
  complianceTabHTML(view = this.compliance) {
    const ds = this.dataset(), you = this.app.you, hs = this.app.world?.harbors || [];
    const homeId = you?.home || null, homeH = hs.find((x) => x.id === homeId);
    const dockedH = you?.docked ? hs.find((x) => x.id === you.docked) : null;
    const ships = {}; for (const v of this.app.fleetUi?.last?.vessels || []) ships[v.id] = { cls: v.cls, cond: v.cond, name: v.name };
    const pendingH = view?.pending ? hs.find((x) => x.id === view.pending.harbor) : null;
    return V.complianceHTML(view, { ds, nowS: this.now(), ctx: this.ctx(), home: { id: homeId, name: short(you?.homeName || homeH?.name), cc: this.pol?.ctx?.home || homeH?.country }, docked: dockedH ? { id: dockedH.id, name: short(dockedH.name) } : null, ships, phone: this.phone(), pendingName: short(pendingH?.name) });
  }

  // ---------------------------------------------------------------------------------------------- modals (move home, re-flag)
  openMoveHome(harbor) { this.plan = null; this.modal = { kind: 'move', harbor }; this.renderModal(); this.net('pol_home_plan', { harbor }); }
  openReflag(vid) { this.modal = { kind: 'reflag', vid }; this.renderModal(); }
  renderModal() {
    const m = this.modal; if (!m) return;
    const ds = this.dataset(), hs = this.app.world?.harbors || [], now = this.now(), you = this.app.you;
    let html = '';
    if (m.kind === 'move') {
      const to = hs.find((x) => x.id === m.harbor);
      html = V.moveHomeHTML(this.plan ? { ...this.plan, homeBefore: this.pol?.ctx?.home } : null, { ds, nowS: now, toName: short(to?.name), money: you?.money });
    } else if (m.kind === 'reflag') {
      const f = (this.compliance?.flags || []).find((x) => x.id === m.vid) || { id: m.vid, flag: null };
      const fv = this.app.fleetUi?.last?.vessels?.find((x) => x.id === m.vid);
      const homeCc = this.pol?.ctx?.home;
      const opts = ds && homeCc ? V.reflagOptions(ds, homeCc, { cls: fv?.cls || you?.ship?.cls || 'coaster', built: f.built }, now) : [];
      html = V.reflagHTML({ id: f.id, name: f.name || fv?.name, flag: f.flag }, opts, { ds, nowS: now, homeCc });
    }
    this.mountSheet('polModal', html);
  }
  closeModal() { this.modal = null; const el = $('polModal'); if (el) { el.classList.add('hidden'); el.innerHTML = ''; } }
  mountSheet(id, html) {
    if (typeof document === 'undefined') return;
    let el = $(id);
    if (!el) { el = document.createElement('div'); el.id = id; el.className = 'polOverlay hidden'; document.body.appendChild(el); el.addEventListener('click', (e) => { if (e.target === el) (id === 'polModal' ? this.closeModal() : this.closeRisk()); }); }
    el.innerHTML = html; el.classList.remove('hidden');
    el.querySelector('button.primary:not([disabled])')?.focus?.({ preventScroll: true });
  }

  // ---------------------------------------------------------------------------------------------- DOM: nav, events
  inject() {
    if (typeof document === 'undefined') return;
    const nav = $('harborNav');
    if (nav && !nav.querySelector('button[data-tab="rules"]')) {
      const b = document.createElement('button'); b.dataset.tab = 'rules';
      b.innerHTML = `<span class="si">${V.SCALE_SVG}</span><span class="lbl">Rules</span><span class="sl">Rules</span>`;
      const market = nav.querySelector('button[data-tab="market"]');
      nav.insertBefore(b, market ? market.nextSibling : null);
    }
    const mk = $('tab-market');
    if (mk && !$('tab-rules')) { const sec = document.createElement('section'); sec.className = 'tab hidden'; sec.id = 'tab-rules'; mk.parentNode.insertBefore(sec, mk.nextSibling); }
  }
  bind() {
    if (typeof document === 'undefined' || this._bound) return;
    this._bound = true;
    document.addEventListener('click', (e) => {
      const el = e.target.closest?.('[data-pol]');
      if (!el || el.disabled) return;
      if (el.tagName === 'A' || el.tagName === 'BUTTON') e.preventDefault();
      this.act(el.dataset.pol, el);
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (this.modal) { this.closeModal(); e.stopPropagation(); } else if (this.risk) { this.closeRisk(); e.stopPropagation(); } } }, true);
  }
  act(name, el) {
    const d = el?.dataset || {};
    switch (name) {
      case 'src': {
        const root = el.closest('.tab, .polHq, .polOverlay, .polHarness, #hqBody') || document;
        const li = root.querySelector(`#polsrc-${CSS.escape(d.src)}`) || document.getElementById(`polsrc-${d.src}`);
        if (li) { const det = li.closest('details'); if (det) det.open = true; li.scrollIntoView({ block: 'center', behavior: 'smooth' }); li.classList.remove('flash'); void li.offsetWidth; li.classList.add('flash'); return; }
        const url = this.dataset()?.sources?.[d.src]?.url;                       // a panel without a source list (popover, modal)
        if (url && /^https?:\/\//.test(url)) window.open(url, '_blank', 'noopener,noreferrer');
        return;
      }
      case 'clearance': return this.net('pol_clearance', { harbor: d.harbor });
      case 'showCorridor': return this.showOnChart(d.area);
      case 'guards': return this.net('pol_guards', { areaId: d.area, days: 1 });
      case 'licence': return this.net('pol_licence', { cc: d.cc });
      case 'policy': if (this.compliance) this.compliance = { ...this.compliance, riskPolicy: d.policy }; this.net('pol_policy', { riskPolicy: d.policy }); return this.refresh();
      case 'warCover': if (this.compliance) this.compliance = { ...this.compliance, warCover: d.mode }; this.net('pol_policy', { warCover: d.mode }); return this.refresh();
      case 'homePlan': return this.openMoveHome(d.harbor);
      case 'homeStart': this.net('pol_home_start', { harbor: d.harbor }); return this.closeModal();
      case 'homeCancel': return this.net('pol_home_cancel', {});
      case 'reflagOpen': return this.openReflag(d.vid);
      case 'reflag': this.net('pol_reflag', { vesselId: d.vid || null, registry: d.reg }); return this.closeModal();
      case 'closeModal': return this.closeModal();
      case 'closeRisk': return this.closeRisk();
      case 'cover': for (const id of String(d.areas || '').split(',').filter(Boolean)) this.net('pol_cover', { areaId: id }); el.disabled = true; el.textContent = 'War cover requested'; return;
      case 'go': { const r = this.risk; this.closeRisk(); r?.onGo?.(); return; }
      case 'planAround': {
        const r = this.risk, ds = this.dataset(); if (!r || !ds) return;
        const end = r.toHarbor ? ds.harbors[r.toHarbor] : null, last = (r.points || []).slice(-1)[0];
        const to = end || (last ? { lat: Array.isArray(last) ? last[0] : last.lat, lon: Array.isArray(last) ? last[1] : last.lon } : null);
        const discs = avoidDiscs(ds, 'avoid', r.from, to, 8);
        this.closeRisk(); r.onPlanAround?.(discs);
        return;
      }
      case 'riskJob': {
        const h = this.app.hud?.harborData, job = (h?.jobs || []).find((j) => j.id === d.job) || (this.opts.jobs || []).find((j) => j.id === d.job);
        const hs = this.app.world?.harbors || [], fr = hs.find((x) => x.id === job?.from), to = hs.find((x) => x.id === job?.to);
        if (!job || !fr || !to) return;
        return this.showRiskCheck({ from: { lat: fr.lat, lon: fr.lon }, points: [[to.lat, to.lon]], toHarbor: to.id, job, contract: true, title: `${short(fr.name)} → ${short(to.name)} (direct line)`, toName: short(to.name), onGo: () => {} });
      }
      case 'layer': return this.setLayer(d.layer, !this.layers[d.layer]);
      case 'legend': this.legendCollapsed = !(this.legendCollapsed ?? this.phone()); store.set('polLegendC', this.legendCollapsed); return this.syncLegend(null, true);
      default:
    }
  }
}
