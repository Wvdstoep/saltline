// World economy, client lane: pure formatters and HTML builders (docs/WORLD-ECONOMY-CONTRACT.md §14). DOM-free so Node
// tests import it directly (test/econui-fmt.test.mjs, test/econui-render.test.mjs). Plain words only (rule E8).
import { catalogueOf, CATS, CATALOGUE } from '../../shared/econ/catalogue.js';
export { catalogueOf, CATS, CATALOGUE };   // one import path for the client modules (market.js)

export const fmtN = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—');
export const fmtCr = (n) => `${fmtN(n)} cr`;
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const UNIT_WORD = { teu: 'TEU', ceu: 'CEU', m3: 'm³', lm: 'lane m', head: 'head', t: 't' };

export function goodName(g) { return catalogueOf(g)?.name || g; }
export function catOf(g) { return catalogueOf(g)?.cat || 'box'; }
export function catName(id) { return CATS.find((c) => c.id === id)?.name || id; }
/** The natural trade unit of a good: { unit, word, tPer }. */
export function unitOf(g) { const r = catalogueOf(g); const unit = r?.unit || 't'; return { unit, word: UNIT_WORD[unit] || unit, tPer: r?.tPer || 1 }; }
/** cr/t → the natural unit's price: "≈ 28,140 cr/TEU" (cr/TEU = cr/t × 12); '' for goods traded in tonnes. */
export function perUnitText(crT, g) { const u = unitOf(g); return u.unit === 't' || !Number.isFinite(crT) ? '' : `≈ ${fmtN(crT * u.tPer)} cr/${u.word}`; }
/** Tonnes with the natural unit: "2,400 t (200 TEU)". */
export function qtyText(t, g) { const u = unitOf(g); const s = `${fmtN(t)} t`; return u.unit === 't' ? s : `${s} (${fmtN(t / u.tPer)} ${u.word})`; }
/** Hours → "18 d 4 h", "5 h 20 min", "40 min"; ≤ 0 → "due". */
export function deadlineText(hours) {
  if (!(hours > 0)) return 'due';
  const m = Math.round(hours * 60), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return mm ? `${h} h ${mm} min` : `${h} h`;
  return `${mm} min`;
}
/** Role badge (§14.1): Made here (green) / Traded (grey) / Needed (orange). */
export const ROLE_BADGE = { P: { text: 'Made here', cls: 'ecRoleP' }, L: { text: 'Traded', cls: 'ecRoleL' }, I: { text: 'Needed', cls: 'ecRoleI' } };
export function roleBadge(role) { const b = ROLE_BADGE[role]; return b ? `<span class="ecRole ${b.cls}">${b.text}</span>` : ''; }
/** Reason chip from the server's `why` ({ code, text }). */
export function reasonChip(why) { return why && why.text ? `<span class="ecWhy ecWhy-${esc(why.code)}">${esc(why.text)}</span>` : ''; }
export function trendWord(t) { return t > 0 ? 'rising' : t < 0 ? 'falling' : 'steady'; }
export function d24Text(d) { return Number.isFinite(d) ? `${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(d).toFixed(1)} %` : '—'; }
/** Premium as "+27 %". */
export function premiumText(p) { return `+${Math.round((Number(p) || 0) * 100)} %`; }

/** Sparkline SVG (desktop 72 × 20, phone 56 × 16): the series oldest → newest, the last point marked. */
export function sparkSvg(series, { w = 72, h = 20, trend = 0, label = '' } = {}) {
  const vals = (series || []).map((v) => (Number.isFinite(v) ? v : null));
  const fin = vals.filter((v) => v != null);
  if (fin.length < 2) return `<svg class="ecSpark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="no history yet"><path d="M2 ${h / 2}H${w - 2}" class="ecSparkNone"/></svg>`;
  const lo = Math.min(...fin), hi = Math.max(...fin), n = vals.length;
  const x = (i) => 2 + (i / (n - 1)) * (w - 5), y = (v) => (hi === lo ? h / 2 : 2 + (1 - (v - lo) / (hi - lo)) * (h - 4));
  const segs = []; let cur = [];
  vals.forEach((v, i) => { if (v != null) cur.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`); else if (cur.length) { segs.push(cur); cur = []; } });
  if (cur.length) segs.push(cur);
  const last = fin[fin.length - 1], li = vals.lastIndexOf(last);
  const tip = label || `low ${fmtN(lo)} · high ${fmtN(hi)} · now ${fmtN(last)} cr/t`;
  return `<svg class="ecSpark ${trend > 0 ? 'up' : trend < 0 ? 'down' : ''}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(tip)}"><title>${esc(tip)}</title>${segs.map((s) => (s.length > 1 ? `<polyline points="${s.join(' ')}"/>` : '')).join('')}<circle cx="${x(li).toFixed(1)}" cy="${y(last).toFixed(1)}" r="2.2"/></svg>`;
}
/** Stock bar: stock against normal (0 … 2 n), a marker at the equilibrium. */
export function stockBar(s, n, sEq) {
  const f = (v) => Math.max(0, Math.min(100, (v / Math.max(1, 2 * n)) * 100)).toFixed(0);
  const r = n > 0 ? s / n : 1, cls = r < 0.6 ? 'short' : r > 1.6 ? 'glut' : 'ok';
  return `<span class="ecStock ${cls}" title="Stock ${fmtN(s)} t · normal ${fmtN(n)} t${sEq != null ? ` · settles near ${fmtN(sEq)} t` : ''}"><i style="width:${f(s)}%"></i><b class="ecNorm" style="left:50%"></b>${sEq != null ? `<b class="ecEq" style="left:${f(sEq)}%"></b>` : ''}</span>`;
}
/** Chips "Made here" / "Needed here" (tier 1 first). */
export function chipRow(title, items, kind) {
  if (!items?.length) return '';
  return `<div class="ecChips ecChips-${kind}"><span class="ecChipsHead">${esc(title)}</span><div class="ecChipScroll">${items.map((x) => `<button type="button" class="ecChip t${x.tier || 3}" data-act="econ-filter" data-good="${esc(x.good)}" title="${esc(goodName(x.good))}${x.site ? ' — for the local plant' : ''}">${esc(goodName(x.good))}</button>`).join('')}</div></div>`;
}

/**
 * A request card (§14.1). req: the server's public request; ctx: { harborName, docked: bool (alongside there),
 * eligibleT: tonnes of eligible cargo aboard, fit: { ok, text }, phone, shipName }.
 */
export function requestCardHTML(req, ctx = {}) {
  const g = req.good, name = goodName(g), qty = req.qty, done = req.done || 0, pledged = req.pledged || 0;
  const pct = (v) => Math.max(0, Math.min(100, (v / Math.max(1, qty)) * 100)).toFixed(1);
  const mine = req.mine ? `<span class="ecMine">You pledged ${fmtN(req.mine.qty)} t</span>` : '';
  const maker = req.maker ? `from ${esc(req.maker.name)}, ${fmtN(req.maker.km / 1.852)} nm` : 'no maker in reach';
  const fit = ctx.fit ? (ctx.fit.ok ? `<span class="ecFit ok">Your ${esc(ctx.shipName || 'ship')} can carry it ✓${ctx.fit.tripT > 0 && ctx.fit.tripT < req.open ? ` (${fmtN(ctx.fit.tripT)} t a trip)` : ''}</span>` : `<span class="ecFit no">${esc(ctx.fit.text || 'Your ship cannot carry it')}</span>`) : '';
  const canDeliver = ctx.docked && ctx.eligibleT > 0;
  return `<article class="ecReq${ctx.phone ? ' phone' : ''}" data-req="${esc(req.id)}">
  <header><span class="ecReqIcon" data-cat="${esc(catOf(g))}"></span><div><b>${esc(name)}</b><small>${esc(ctx.harborName || req.harborName || '')} requests ${qtyText(qty, g)}</small></div><span class="ecPrem">${premiumText(req.premium)}</span></header>
  <div class="ecProg" role="img" aria-label="${fmtN(done)} t delivered, ${fmtN(pledged)} t pledged, ${fmtN(req.open)} t open"><i class="d" style="width:${pct(done)}%"></i><i class="p" style="width:${pct(pledged)}%"></i></div>
  <div class="ecReqNums"><span>${fmtN(done)} t delivered · ${fmtN(pledged)} t pledged · <b>${fmtN(req.open)} t open</b></span></div>
  <div class="ecReqNums"><span><b>${fmtN(req.unit)}</b> cr/t locked${perUnitText(req.unit, g) ? ` (${perUnitText(req.unit, g)})` : ''}</span><span class="ecDue">${deadlineText(req.leftH)} left</span></div>
  <div class="ecReqNums"><span>${maker}</span>${mine}</div>
  ${fit ? `<div class="ecReqFit">${fit}</div>` : ''}
  <div class="ecReqBtns">${canDeliver ? `<button class="primary" data-act="econ-deliver" data-req="${esc(req.id)}">Deliver ${fmtN(Math.min(ctx.eligibleT, req.open + (req.mine?.qty || 0)))} t</button>` : ''}<button data-act="econ-pledge" data-req="${esc(req.id)}" data-open="${req.open}" ${req.open > 0 ? '' : 'disabled'}>Pledge…</button><button data-act="econ-plan" data-good="${esc(g)}">Plan route</button></div>
</article>`;
}

/**
 * One goods-list row (§14.1, phone: two lines). x: the server's goods row; ctx: { have (t aboard), fit: { ok, text },
 * money, freeT, phone, open (detail open) }.
 */
export function goodRowHTML(x, ctx = {}) {
  const g = x.id, name = goodName(g), phone = !!ctx.phone;
  const buyTxt = x.buyable >= 1 ? `<b>${fmtN(x.buy)}</b><small>cr/t</small>` : `<span class="ecNotSold">${x.role === 'I' ? 'Not sold here — imported' : 'Sold out'}</span>`;
  const unitLine = perUnitText(x.buyable >= 1 ? x.buy : x.sell, g);
  const maxBuy = Math.max(0, Math.floor(Math.min(x.buyable || 0, ctx.freeT ?? Infinity, x.buy > 0 ? (ctx.money ?? 0) / (x.buy * 1.02) : 0)));
  const have = ctx.have || 0;
  const spark = sparkSvg(x.hist7, phone ? { w: 56, h: 16, trend: x.trend } : { trend: x.trend });
  const fitChip = ctx.fit && !ctx.fit.ok ? `<span class="ecFit no" title="${esc(ctx.fit.text)}">${esc(ctx.fit.text)}</span>` : '';
  const arrow = `<span class="ecTrend ${x.trend > 0 ? 'up' : x.trend < 0 ? 'down' : 'flat'}" title="price ${trendWord(x.trend)}">${x.trend > 0 ? '▲' : x.trend < 0 ? '▼' : '▶'}</span>`;
  return `<div class="ecRow${ctx.open ? ' open' : ''}" data-good="${esc(g)}" data-cat="${esc(catOf(g))}">
  <div class="ecL1"><button class="ecName" data-act="econ-detail" data-good="${esc(g)}" aria-expanded="${ctx.open ? 'true' : 'false'}"><span class="ecIcon" data-cat="${esc(catOf(g))}"></span><span><b>${esc(name)}</b>${roleBadge(x.role)}${have ? `<small>${fmtN(have)} t aboard</small>` : ''}</span></button>
    <div class="ecPx"><span class="ecBuy" title="Buy">${buyTxt}</span><span class="ecSell" title="Sell"><b>${fmtN(x.sell)}</b><small>sell</small></span>${unitLine ? `<small class="ecUnit">${unitLine}</small>` : ''}</div></div>
  <div class="ecL2">${spark}${arrow}<span class="ecD24">${d24Text(x.d24)}</span>${reasonChip(x.why)}${stockBar(x.stock, x.n, x.sEq)}${fitChip}</div>
  <div class="ecTrade"><input type="number" inputmode="numeric" min="1" step="1" value="${Math.max(1, Math.min(100, maxBuy || have || 100))}" data-qty="${esc(g)}" aria-label="${esc(name)} quantity in tonnes">
    <button data-act="econ-max" data-good="${esc(g)}" data-v="${maxBuy}" ${maxBuy > 0 ? '' : 'disabled'} title="As much as fits, is for sale and you can pay">Max</button>
    <button class="primary" data-act="econ-buy" data-good="${esc(g)}" ${x.buyable >= 1 && (!ctx.fit || ctx.fit.ok) ? '' : 'disabled'} title="${esc(x.buyable >= 1 ? (ctx.fit && !ctx.fit.ok ? ctx.fit.text : 'Buy') : 'Not sold here')}">Buy</button>
    <button data-act="econ-sell" data-good="${esc(g)}" ${have > 0 ? '' : 'disabled'}>Sell</button></div>
</div>`;
}

/** Season strip: 12 months, the bump months shaded (f > 1.05), the current month outlined. */
export function seasonStrip(fByMonth, nowMonth) {
  const M = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
  return `<div class="ecSeason" role="img" aria-label="season">${M.map((m, i) => { const f = fByMonth?.[i] ?? 1; return `<span class="${f > 1.05 ? 'hi' : f < 0.95 ? 'lo' : ''}${i === nowMonth ? ' now' : ''}" title="${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][i]}: ×${f.toFixed(2)}">${m}</span>`; }).join('')}</div>`;
}
/** Line chart SVG for the 30-day history (6-hourly). */
export function chartSvg(series, { w = 320, h = 90 } = {}) {
  const fin = (series || []).filter(Number.isFinite);
  if (fin.length < 2) return '<p class="muted small">Not enough history yet — prices are sampled every hour.</p>';
  const lo = Math.min(...fin), hi = Math.max(...fin), n = series.length;
  const x = (i) => 30 + (i / (n - 1)) * (w - 34), y = (v) => (hi === lo ? h / 2 : 6 + (1 - (v - lo) / (hi - lo)) * (h - 16));
  const pts = series.map((v, i) => (Number.isFinite(v) ? `${x(i).toFixed(1)},${y(v).toFixed(1)}` : null)).filter(Boolean).join(' ');
  return `<svg class="ecChart" viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="30 days: low ${fmtN(lo)}, high ${fmtN(hi)} cr/t"><text x="2" y="12">${fmtN(hi)}</text><text x="2" y="${h - 4}">${fmtN(lo)}</text><polyline points="${pts}"/></svg>`;
}
