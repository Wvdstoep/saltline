// Inland harbours on the chart and the harbour card text (docs/BRIDGES-LOCKS-VHF-CONTRACT.md §7.5, lane D client side).
// OpenSeaMap-style symbols (marina: yacht in a circle; passant: blue "P"; inland port: anchor; fishing: fish; city: quay
// bollard; ferry: small ferry), shown at chart zoom ≥ 11 from GET /api/mh?bbox. Hooked into public/js/chart.js like the
// fleet layer (docs/WATERWAYS-HARBOURS-PHASE2.md §4): `this.app.mhLayer?.drawChartLayer(this, this.ctx)` and `chartHits`.
// The pure parts (bboxKey, visibleRows, symbolSpec, cardLines, cardHTML) are tested in node (test/inland-chart.test.mjs).
// The 3D harbours are public/js/mharbour.js (shared/mhgeo.js layouts); from zoom 14 the chart draws their pontoons and quays.
import { MH, TIERS } from '../../shared/mharbour.js';
import { segmentsOf } from '../../shared/mhgeo.js';

/** Chart zoom from which the harbour plans (pontoons, quays) are drawn. */
export const OUTLINE_ZOOM = 14;

export const SYM_COLORS = { marina: '#c2187a', passant: '#1f5fbf', city: '#5a6b7a', anchor: '#7a3fbf', fish: '#1f8a5a', ferry: '#8a6d1f' };
/** Drawing recipe of a symbol (the canvas code below follows it; tests check it): { shape, color, glyph, r }. */
export function symbolSpec(sym, { est = false } = {}) {
  const color = SYM_COLORS[sym] || SYM_COLORS.passant;
  const glyph = { marina: 'yacht', passant: 'P', city: 'bollard', anchor: 'anchor', fish: 'fish', ferry: 'ferry' }[sym] || 'P';
  return { shape: sym === 'passant' ? 'square' : 'circle', color, glyph, r: 7, dashed: !!est };
}
/** The bbox the layer asks for (rounded to 0.01° so panning reuses answers) → { key, s, w, n, e } | null below zoom 11. */
export function bboxKey(tl, br, zoom) {
  if (zoom < MH.CHART_MIN_ZOOM) return null;
  const f = (v, up) => (up ? Math.ceil(v * 100 - 1e-6) : Math.floor(v * 100 + 1e-6)) / 100;
  const s = f(br.lat, false), n = f(tl.lat, true), w = f(tl.lon, false), e = f(br.lon, true);
  return { key: `${s},${w},${n},${e}`, s, w, n, e };
}
/** Rows on screen; sub-harbours of a named harbour are drawn only at zoom ≥ 12 (the named harbour's symbol covers them below). */
export function visibleRows(rows, zoom, onScreen = () => true) {
  if (zoom < MH.CHART_MIN_ZOOM) return [];
  return (rows || []).filter((r) => (zoom >= 12 || !r.sub) && onScreen(r));
}
/** Plain lines of a card (the hover popup and the phone sheet header). */
export function cardLines(c) {
  if (!c) return [];
  const out = [`${c.name} · ${c.tierLabel}${c.est ? ' (est.)' : ''}`];
  if (c.vhf) out.push(c.vhf.text);
  out.push(`Depth ${c.depth?.text ?? '?'}`);
  if (c.fit) out.push(c.fit.text);
  if (c.fee) out.push(c.fee.text);
  if (c.reach) out.push(`Reachable: ${c.reach.text}`);
  if (c.berths?.rafting) out.push(c.berths.rafting);
  for (const n of c.notes || []) out.push(n);
  return out;
}
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
/** The overview tab of the harbour sheet (HTML string; the sheet frame and tabs are hud.js's). */
export function cardHTML(c) {
  if (!c) return '<div class="mh-card">Unknown harbour.</div>';
  const svc = c.services || {}, chips = [];
  if (svc.water) chips.push('Water'); if (svc.power) chips.push('Power'); if (svc.fuel) chips.push(svc.fuelMul > 1 ? `Fuel (truck ×${svc.fuelMul})` : 'Fuel');
  if (svc.repair) chips.push(`Repairs ×${svc.repair.mul}${svc.repair.yachtsOnly ? ' (yachts)' : ''}`); if (svc.slipway) chips.push('Slipway');
  if (svc.market) chips.push(svc.market === 'fish' ? 'Fish market' : 'Small market');
  const sizes = (c.berths?.sizes || []).map((s) => `${s.n} × ${s.len} m`).join(', ');
  return `<div class="mh-card"><h3>${esc(c.name)}</h3><div class="mh-tier">${esc(c.tierLabel)}${c.est ? ' · est.' : ''}</div>`
    + `<ul>${cardLines(c).slice(1).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`
    + `<div class="mh-berths">${esc(c.berths?.total ?? 0)} berths${sizes ? ` (${esc(sizes)})` : ''}</div>`
    + (chips.length ? `<div class="mh-svc">${chips.map((x) => `<span class="chip">${esc(x)}</span>`).join('')}</div>` : '')
    + (c.namedSheet ? `<button data-named="${esc(c.sub?.id)}">Open ${esc(c.sub?.name)}</button>` : '')
    + (c.vhf?.ch ? `<button data-tune="${esc(c.vhf.ch)}">Call on ch ${esc(c.vhf.ch)}</button>` : '') + '</div>';
}

/** The berths tab: box sizes (with fit for your ship when the card has one) or the quay sides. */
export function berthsHTML(c, ship = null) {
  const b = c?.berths; if (!b) return '';
  const fitBox = (s) => !ship || (ship.L <= s.len + 1.5 && ship.B <= s.w - 0.4);
  const rows = b.kind === 'box'
    ? b.sizes.map((s) => `<tr class="${fitBox(s) ? 'fit' : 'nofit'}"><td>${esc(s.n)}</td><td>${esc(s.len)} × ${esc(s.w)} m boxes</td></tr>`)
    : b.list.map((s) => `<tr><td>${esc(s.places)}</td><td>${esc(Math.round(s.lenM))} m ${s.raft ? 'visitor quay (rafting)' : 'quay'}</td></tr>`);
  return `<table class="mh-berths"><tr><th>Places</th><th>Berth</th></tr>${rows.join('')}</table>${b.rafting ? `<p>${esc(b.rafting)}</p>` : ''}${c.fit ? `<p>${esc(c.fit.text)}</p>` : ''}`;
}

/** The chart layer (browser). app: { chart?, vhf?, hud? }. fetchImpl injectable for tests. */
export class MHChartLayer {
  constructor(app, { fetchImpl = (u) => fetch(u).then((r) => r.json()) } = {}) {
    this.app = app; this.fetchImpl = fetchImpl; this.rows = []; this.key = null; this.busy = false; this.at = 0;
  }
  /** Ask the server for the view's harbours when the bbox changed (or every 30 s). */
  refresh(chart) {
    const b = bboxKey(chart.unproject(0, 0), chart.unproject(chart.W, chart.H), chart.zoom);
    if (!b) { this.rows = []; this.key = null; return; }
    if (this.busy || (b.key === this.key && Date.now() - this.at < 30000)) return;
    this.busy = true; this.key = b.key; this.at = Date.now();
    this.fetchImpl(`/api/mh?bbox=${b.key}&z=${Math.floor(chart.zoom)}`).then((j) => { this.rows = j?.harbours || []; if (j?.pending) this.at = Date.now() - 28000; chart.requestDraw?.(); }).catch(() => {}).finally(() => { this.busy = false; });
  }
  drawChartLayer(chart, g) {
    this.refresh(chart);
    const vis = visibleRows(this.rows, chart.zoom);
    this.drawOutlines(chart, g, vis);
    g.save(); g.font = '600 10px system-ui, sans-serif'; g.textBaseline = 'middle';
    for (const r of vis) {
      const p = chart.project(r.lat, r.lon); if (p.x < -20 || p.y < -20 || p.x > chart.W + 20 || p.y > chart.H + 20) continue;
      const s = symbolSpec(r.sym, { est: r.est });
      g.beginPath();
      if (s.shape === 'square') g.rect(p.x - s.r, p.y - s.r, 2 * s.r, 2 * s.r); else g.arc(p.x, p.y, s.r, 0, Math.PI * 2);
      g.fillStyle = '#ffffff'; g.fill(); g.lineWidth = 1.6; g.strokeStyle = s.color; if (s.dashed) g.setLineDash([2, 2]); g.stroke(); g.setLineDash([]);
      g.fillStyle = s.color; g.textAlign = 'center';
      g.fillText({ yacht: '⛵', P: 'P', bollard: '⊥', anchor: '⚓', fish: '≻', ferry: '⛴' }[s.glyph] || 'P', p.x, p.y + 0.5);
      if (chart.zoom >= 13) { g.textAlign = 'left'; g.fillStyle = '#e8f1f8'; g.fillText(`${r.name}${r.vhf ? ` · ch ${r.vhf}` : ''}`, p.x + s.r + 4, p.y); }
    }
    g.restore();
  }
  /**
   * Harbour plans at chart zoom ≥ OUTLINE_ZOOM: pontoons, finger piers, quays and gangways (public/js/mharbour.js layouts;
   * the geometry of harbours in view is asked for when it is not loaded yet), box outlines from zoom 16.
   */
  drawOutlines(chart, g, vis) {
    const mh = this.app.mharbour; if (!mh || chart.zoom < OUTLINE_ZOOM) return 0;
    const onScreen = vis.filter((r) => { const p = chart.project(r.lat, r.lon); return p.x > -200 && p.y > -200 && p.x < chart.W + 200 && p.y < chart.H + 200; });
    if (onScreen.length && onScreen.length <= 16) mh.fetchIds?.(onScreen.map((r) => r.id));
    const p0 = chart.unproject(0, 0), p1 = chart.unproject(100, 0), mPerPx = Math.max(1e-6, Math.abs(p1.lon - p0.lon) * 111320 * Math.cos(((p0.lat || 0) * Math.PI) / 180) / 100);
    let n = 0;
    g.save(); g.lineCap = 'butt';
    for (const { lay } of mh.layouts?.() || []) {
      if (chart.zoom >= 16) {
        g.strokeStyle = 'rgba(232,241,248,0.35)'; g.lineWidth = 1;
        for (const b of lay.boxes) { g.beginPath(); b.c.forEach((c, i) => { const p = chart.project(c[0], c[1]); if (i) g.lineTo(p.x, p.y); else g.moveTo(p.x, p.y); }); g.closePath(); g.stroke(); }
      }
      for (const s of segmentsOf(lay)) {
        if (s.k === 'finger' && s.w / mPerPx < 0.4) continue;
        const a = chart.project(s.a[0], s.a[1]), b = chart.project(s.b[0], s.b[1]);
        if (Math.max(a.x, b.x) < -20 || Math.max(a.y, b.y) < -20 || Math.min(a.x, b.x) > chart.W + 20 || Math.min(a.y, b.y) > chart.H + 20) continue;
        g.strokeStyle = s.k === 'quay' ? '#b8bcb2' : s.k === 'gang' ? '#a89c84' : '#e4ddcf';
        g.lineWidth = Math.max(s.k === 'finger' ? 0.8 : 1.6, s.w / mPerPx);
        g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); n++;
      }
      if (lay.fuel && chart.zoom >= 15) { const p = chart.project(lay.fuel.lat, lay.fuel.lon); g.fillStyle = '#ffd166'; g.font = '700 9px system-ui, sans-serif'; g.textAlign = 'center'; g.fillText('F', p.x, p.y - 6); }
    }
    g.restore();
    return n;
  }
  chartHits(consider) { for (const r of this.rows) consider(r.lat, r.lon, { kind: 'mh', text: `${r.name} · ${TIERS[r.tier]?.label || r.tier}${r.vhf ? ` · ch ${r.vhf}` : ''}`, data: r }); }
  /** Open the card (GET /api/mh/:id) → card JSON. */
  card(id) { return this.fetchImpl(`/api/mh/${encodeURIComponent(id)}`); }
}
