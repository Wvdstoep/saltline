// World politics, client lane: chart overlays (docs/WORLD-POLITICS-CONTRACT.md §5.2). War-risk areas (fill by tier),
// ECAs (green dashed), piracy areas (violet dotted), corridors (blue line with arrowheads every 80 px) and navigational
// warnings (grey hatched), drawn on the chart's 2D canvas in CSS pixels through `chart.project(lat, lon)`, the same
// projection the storms use. Also: label hit boxes, point hit-testing, the popover body and the legend/toggle row.
import * as F from './politicsfmt.js';
import { esc, srcTag, staleTag, gameTag } from './politicsview.js';
import { isActive, areasAt, warPremium, apPctOf, pDayOf, ecaCost } from '../../shared/politics.js';

const DRAW_ORDER = ['eca', 'piracy', 'warning', 'warlike', 'war_risk', 'corridor'];
let hatch = null;
function hatchPattern(g) {
  if (hatch !== null) return hatch || null;
  try {
    const c = typeof document !== 'undefined' ? document.createElement('canvas') : null;
    if (!c) { hatch = false; return null; }
    c.width = c.height = 8; const x = c.getContext('2d');
    x.strokeStyle = 'rgba(170,190,205,0.35)'; x.lineWidth = 1; x.beginPath(); x.moveTo(0, 8); x.lineTo(8, 0); x.moveTo(-2, 2); x.lineTo(2, -2); x.moveTo(6, 10); x.lineTo(10, 6); x.stroke();
    hatch = g.createPattern(c, 'repeat') || false;
  } catch { hatch = false; }
  return hatch || null;
}
/** Screen points of a [lon, lat] ring, unwrapped so consecutive points never jump a world width. */
function screenRing(chart, ring) {
  const S = chart.scale || 0, out = [];
  let prev = null;
  for (const [lo, la] of ring) {
    const p = chart.project(la, lo);
    if (prev && S) { while (p.x - prev.x > S / 2) p.x -= S; while (prev.x - p.x > S / 2) p.x += S; }
    out.push(p); prev = p;
  }
  return out;
}
function boxOf(pts) { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of pts) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; } return { x0, y0, x1, y1 }; }
function centroid(pts) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const f = pts[j].x * pts[i].y - pts[i].x * pts[j].y; a += f; cx += (pts[j].x + pts[i].x) * f; cy += (pts[j].y + pts[i].y) * f; }
  if (Math.abs(a) < 1e-6) { const b = boxOf(pts); return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 }; }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}
const visible = (b, W, H) => b.x1 >= -40 && b.x0 <= W + 40 && b.y1 >= -40 && b.y0 <= H + 40;
/** Active now, or a future-dated ECA (drawn faint, "from {date}"). */
export function shown(a, nowS) { return nowS == null || isActive(a, nowS) || (a.kind === 'eca' && a.from && a.from > F.isoOf(nowS)); }

function label(g, text, x, y, colour, hits, id, W, H) {
  if (x < 0 || x > W || y < 0 || y > H) return;                                                 // centroid off screen: no label
  g.font = '600 11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const w = g.measureText(text).width + 12, h = 18;
  const bx = Math.round(Math.max(4, Math.min(W - w - 4, x - w / 2))), by = Math.round(Math.max(4, Math.min(H - h - 4, y - h / 2)));
  if (hits.some((r) => bx < r.x + r.w && bx + w > r.x && by < r.y + r.h && by + h > r.y)) return;      // no overlapping labels
  g.fillStyle = 'rgba(6,16,27,0.82)'; g.strokeStyle = colour; g.lineWidth = 1; g.setLineDash([]);
  g.beginPath(); if (g.roundRect) g.roundRect(bx + 0.5, by + 0.5, w, h, 9); else g.rect(bx + 0.5, by + 0.5, w, h); g.fill(); g.stroke();
  g.fillStyle = colour; g.textBaseline = 'middle'; g.fillText(text, bx + 6, by + h / 2 + 1);
  hits.push({ x: bx, y: by, w, h, id });
}
function arrowheads(g, pts, every = 80) {
  let acc = every / 2;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], seg = Math.hypot(b.x - a.x, b.y - a.y); if (!(seg > 0)) continue;
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    while (acc <= seg) {
      const f = acc / seg, x = a.x + (b.x - a.x) * f, y = a.y + (b.y - a.y) * f;
      g.beginPath(); g.moveTo(x + Math.cos(ang) * 6, y + Math.sin(ang) * 6);
      g.lineTo(x + Math.cos(ang + 2.5) * 6, y + Math.sin(ang + 2.5) * 6); g.lineTo(x + Math.cos(ang - 2.5) * 6, y + Math.sin(ang - 2.5) * 6); g.closePath(); g.fill();
      acc += every;
    }
    acc -= seg;
  }
}

/**
 * Draw every visible politics area. layers: { warrisk, corridors, eca, piracy, warnings } booleans.
 * o: { nowS, highlight: areaId }. Returns the label hit boxes [{ x, y, w, h, id }] (CSS px).
 */
export function drawAreas(chart, g, ds, layers, o = {}) {
  const hits = [], labels = [];
  if (!ds || !g || !chart?.project) return hits;
  const W = chart.W, H = chart.H, now = o.nowS ?? null;
  g.save();
  for (const kind of DRAW_ORDER) {
    const st = F.AREA_STYLE[kind];
    if (!layers?.[st.layer]) continue;
    for (const a of ds.areas) {
      if (a.kind !== kind || !shown(a, now)) continue;
      const future = now != null && !isActive(a, now);
      const hi = o.highlight === a.id;
      if (kind === 'corridor') {
        const line = a.line || [];
        if (line.length < 2) continue;
        const pts = screenRing(chart, line), b = boxOf(pts);
        if (!visible(b, W, H)) continue;
        g.setLineDash([]); g.lineJoin = 'round'; g.lineCap = 'round';
        g.strokeStyle = 'rgba(6,16,27,0.7)'; g.lineWidth = hi ? 6 : 5; g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.stroke();
        g.strokeStyle = st.stroke; g.lineWidth = hi ? 3 : 2; g.stroke();
        g.fillStyle = st.stroke; arrowheads(g, pts, 80);
        const mid = pts[Math.floor(pts.length / 2)];
        if (Math.max(b.x1 - b.x0, b.y1 - b.y0) > 50) labels.push([F.areaLabel(a), mid.x + 46, mid.y, st.stroke, a.id]);
        continue;
      }
      let best = null;
      const rings = a.poly.map((r) => screenRing(chart, r));
      const boxes = rings.map(boxOf);
      if (!boxes.some((b) => visible(b, W, H))) continue;
      g.beginPath();
      for (const pts of rings) { pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.closePath(); }
      rings.forEach((pts, i) => { const b = boxes[i], s = (b.x1 - b.x0) * (b.y1 - b.y0); if (!best || s > best.s) best = { pts, b, s }; });
      let colour = st.stroke;
      if (kind === 'war_risk') {
        const c = F.tierColour(a.tier); colour = c.text;
        g.fillStyle = hi ? c.fill.replace(/[\d.]+\)$/, `${Math.min(0.4, c.alpha * 1.8).toFixed(2)})`) : c.fill; g.fill('evenodd');
        g.setLineDash([]); g.strokeStyle = c.stroke; g.lineWidth = hi ? 2 : 1; g.stroke();
      } else if (kind === 'warning') {
        const pat = hatchPattern(g); if (pat) { g.fillStyle = pat; g.fill('evenodd'); }
        g.setLineDash(st.dash); g.strokeStyle = 'rgba(159,179,196,0.7)'; g.lineWidth = 1; g.stroke();
      } else {
        if (kind === 'warlike') { g.fillStyle = 'rgba(255,159,67,0.06)'; g.fill('evenodd'); }
        g.setLineDash(st.dash); g.strokeStyle = future ? 'rgba(79,209,139,0.45)' : st.stroke; g.lineWidth = hi ? 2.5 : kind === 'piracy' ? 2 : 1.5; g.lineCap = kind === 'piracy' ? 'round' : 'butt'; g.stroke();
      }
      if (best && Math.max(best.b.x1 - best.b.x0, best.b.y1 - best.b.y0) > 44) {
        const c = centroid(best.pts);
        const txt = future ? `${F.areaLabel(a)} from ${F.fmtDate(a.from).slice(3)}` : F.areaLabel(a);
        labels.push([txt, c.x, c.y, kind === 'warning' ? '#c3d5e3' : colour, a.id]);
      }
    }
  }
  const rank = (id) => ({ war_risk: 0, corridor: 1, warlike: 2, piracy: 3, warning: 4, eca: 5 }[ds.areaById[id]?.kind] ?? 9) * 10 - (ds.areaById[id]?.tier || 0);
  labels.sort((p, q) => rank(p[4]) - rank(q[4]));
  for (const [txt, x, y, colour, id] of labels) label(g, txt, x, y, colour, hits, id, W, H);   // after every shape; higher tiers win overlaps
  g.restore();
  return hits;
}

function segDist(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / l2)) : 0;
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}
/** Areas under a chart point (visible layers only): polygons containing it, corridors within `tolPx`, label boxes. */
export function areasUnder(chart, ds, layers, x, y, { nowS = null, hits = [], tolPx = 12 } = {}) {
  if (!ds) return [];
  const ll = chart.unproject(x, y), out = new Map();
  const onLayer = (a) => layers?.[F.layerOfKind(a.kind)] && shown(a, nowS);
  for (const h of hits) if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) { const a = ds.areaById[h.id]; if (a && onLayer(a)) out.set(a.id, a); }
  for (const a of areasAt(ds, ll.lat, ll.lon)) if (onLayer(a)) out.set(a.id, a);
  for (const a of ds.areas) {
    if (a.kind !== 'corridor' || !onLayer(a) || !(a.line || []).length) continue;
    const pts = screenRing(chart, a.line);
    for (let i = 1; i < pts.length; i++) if (segDist(x, y, pts[i - 1], pts[i]) <= tolPx) { out.set(a.id, a); break; }
  }
  const rank = { war_risk: 0, corridor: 1, warlike: 2, piracy: 3, eca: 4, warning: 5 };
  return [...out.values()].sort((p, q) => rank[p.kind] - rank[q.kind] || (q.tier || 0) - (p.tier || 0));
}

/** Popover body (DOM string) for the areas under a tap. o: { ds, nowS, cls, cond, shipName } */
export function popoverHTML(areas, o = {}) {
  const ds = o.ds, now = o.nowS;
  return `<div class="polPop">${areas.map((a) => {
    const st = F.AREA_STYLE[a.kind] || {}, S = srcTag(ds, a.src, a.asOf, now, a);
    let body = '';
    if (a.kind === 'war_risk') {
      const prem = o.cls ? warPremium(a, o.cls, o.cond ?? 100) : null;
      body = `<dl class="kv"><dt>Additional premium</dt><dd>${esc(F.fmtPct(apPctOf(a), { pct: true }))} of hull value${a.apBasis === 'game' ? ` ${gameTag()}` : ''}</dd>${prem != null ? `<dt>For ${esc(o.shipName || 'your ship')}</dt><dd>${esc(F.fmtCr(prem))} per call / transit</dd>` : ''}<dt>Incident chance</dt><dd>≈ ${esc(F.fmtPct(pDayOf(a)))} per day ${gameTag()}</dd></dl>`;
    } else if (a.kind === 'eca') {
      const inForce = now == null || isActive(a, now);
      body = `<dl class="kv"><dt>Sulphur limit</dt><dd>${esc(String(a.sulphurPct ?? 0.1))} %</dd><dt>In force</dt><dd>${inForce ? `since ${esc(F.fmtDate(a.from))}` : `from ${esc(F.fmtDate(a.from))}`}</dd>${a.nox ? `<dt>NOx</dt><dd>Tier III (new engines)</dd>` : ''}<dt>Fuel switch</dt><dd>+${esc(F.fmtCr(ecaCost(1)))}/t ${gameTag()}</dd></dl>`;
    } else if (a.kind === 'piracy') {
      body = `<dl class="kv"><dt>Incident chance</dt><dd>≈ ${esc(F.fmtPct(a.p100))} per 100 km ${gameTag()}</dd><dt>Lower it</dt><dd>≥ 18 kn, convoy, guards</dd></dl>`;
    } else if (a.kind === 'corridor') {
      body = `<p class="polNote">Ports on this corridor need the corridor route and entry clearance${(a.to || []).length ? ` (${esc((a.to || []).map((id) => (ds?.harbors?.[id]?.name || id).split(' (')[0]).join(', '))})` : ''}.</p>`;
    } else if (a.kind === 'warning') {
      body = `<p class="polNote">${esc(a.text || 'GNSS interference reported')} — cross-check position by radar.</p>`;
    } else if (a.kind === 'warlike') body = '<p class="polNote">IBF warlike operations area: crew on double basic pay inside.</p>';
    if (a.note) body += `<p class="polNote muted">${esc(a.note)}</p>`;
    return `<section class="polPopA k-${esc(a.kind)}"><div class="polPopH"><span class="chip ${a.kind === 'war_risk' ? (a.tier >= 3 ? 'bad' : 'warn') : a.kind === 'eca' ? 'good' : a.kind === 'piracy' ? 'violet' : 'ghost'}">${esc(F.areaLabel(a))}</span><b>${esc(a.name)}</b></div>${body}<div class="polPopS">${S || staleTag(a, now)}</div></section>`;
  }).join('')}</div>`;
}

/** Legend + toggles (chip row; collapsible on phones). layers: { id: bool }. */
export function legendHTML(layers, { collapsed = false } = {}) {
  const sw = (L) => {
    const kind = L.kinds[0], st = F.AREA_STYLE[kind];
    if (kind === 'war_risk') return '<i class="polSw" style="background:linear-gradient(90deg,rgba(255,96,64,.2),rgba(255,96,64,.5));border-color:#ff7850"></i>';
    if (kind === 'corridor') return '<i class="polSw line" style="border-color:#5ad6ff"></i>';
    return `<i class="polSw" style="border-color:${st.stroke};border-style:${kind === 'piracy' ? 'dotted' : 'dashed'}"></i>`;
  };
  return `<div class="polLegend${collapsed ? ' collapsed' : ''}" role="group" aria-label="Rules and risk layers">
    <button type="button" class="polLegT" data-pol="legend" aria-expanded="${!collapsed}">Rules &amp; risk</button>
    ${F.CHART_LAYERS.map((L) => `<button type="button" class="polLegB${layers?.[L.id] ? ' on' : ''}" data-pol="layer" data-layer="${L.id}" aria-pressed="${!!layers?.[L.id]}">${sw(L)}<span>${esc(L.label)}</span></button>`).join('')}
  </div>`;
}
