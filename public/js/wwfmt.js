// Bridges & locks — pure formatting and state helpers for the 3D layer and the HUD (docs/BRIDGES-LOCKS-VHF-CONTRACT.md
// §5.2, §5.5, lane C). No DOM, no three.js: Node tests import it directly. Also carries small local fallbacks of lane A's
// rules (clrNow, passVerdict, level physics, BPR signal mapping) so the client draws and judges correctly before
// shared/waterworks.js is wired; when it is, wwmesh / wwhud take lane A's functions through their `rules` option.

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const fin = (v) => v !== null && v !== '' && Number.isFinite(Number(v));
const MOVABLE = new Set(['bascule', 'bascule2', 'lift', 'swing', 'pontoon', 'draw', 'retract']);
export const AD_MARGIN = 0.30;                       // = shared/airdraft.js AD_MARGIN (schrikhoogte)
export const f1 = (v) => (Math.round(Number(v) * 10) / 10).toFixed(1);
export const f2 = (v) => (Math.round(Number(v) * 100) / 100).toFixed(2);

// ------------------------------------------------------------------------------------------------ boards (§5.2)
/** OpenSeaMap-style clearance board text: fixed "14.0", lift "3.6 / 24.0", bascule / swing "3.6 / –", estimate "≈ 2.5". */
export function boardText(span, e = 0) {
  if (!span) return '';
  const est = e === 2 ? '≈ ' : '';
  const c = fin(span.clr) ? f1(span.clr) : '–';
  if (!MOVABLE.has(span.mov)) return est + c;
  if (span.mov === 'lift' && fin(span.clrO) && Number(span.clrO) !== Infinity) return `${est}${c} / ${f1(span.clrO)}`;
  if (fin(span.clrO) && Number(span.clrO) !== Infinity) return `${est}${c} / ${f1(span.clrO)}`;
  return `${est}${c} / –`;
}
export const widthText = (w) => (fin(w) ? `↔ ${f1(w)}` : '');
/** The peilschaal reading: clearance now, rounded DOWN to 0.1 m (§4.3). */
export const gaugeReading = (v) => (fin(v) ? Math.floor(Number(v) * 10 + 1e-6) / 10 : null);

// ------------------------------------------------------------------------------------------------ time
/** Server times: epoch ms (> 1e12) or epoch s (> 1e9) → epoch ms. */
export const absMs = (t) => (!fin(t) ? null : t > 1e12 ? Number(t) : t > 1e9 ? Number(t) * 1000 : Number(t));
/** Durations: seconds; values ≥ 2000 are taken as milliseconds (no waterworks motion lasts 33 min). */
export const durS = (d) => (!fin(d) ? 0 : d >= 2000 ? d / 1000 : Number(d));
export function progress(st, now) {
  const t0 = absMs(st?.t0), d = durS(st?.dur);
  if (t0 == null || !(d > 0)) return 1;
  return clamp((now - t0) / (d * 1000), 0, 1);
}

// ------------------------------------------------------------------------------------------------ bridge state → motion + lights
/** Open fraction of a movable span from its state {st, t0, dur} (§4.6): opening ramps 0→1, closing 1→0. */
export function spanFrac(ss, now) {
  if (!ss) return 0;
  switch (ss.st) {
    case 'opening': return progress(ss, now);
    case 'open': return 1;
    case 'closing': return 1 - progress(ss, now);
    default: return 0;      // closed, warn, out, noservice
  }
}
/** §4.9 game mapping. Tokens: r red, g green, y yellow, rv two reds one above the other. */
export const SIGNALS_LOCAL = {
  closed: ['r'], levelling: ['r'], closing: ['r'], warn: ['r', 'g'], opening: ['r', 'g'], open: ['g'],
  out: ['rv'], noservice: ['rv'], fixed: ['y'], fixedNarrow: ['y', 'y'],
};
/** Normalise server lights (['red','green'], 'rg', ['r','g'], {red:1, green:1}…) to tokens. */
export function normLights(l) {
  if (l == null) return null;
  if (typeof l === 'string') { const s = l.toLowerCase(); if (s === 'rv' || s.includes('vert') || s === 'rr_v') return ['rv']; return [...s.replace(/[^rgy]/g, '')]; }
  if (Array.isArray(l)) {
    const out = [];
    for (const x of l) { const s = String(x).toLowerCase(); if (s === 'rv' || s.includes('vert') || s === 'out') out.push('rv'); else if (s[0] === 'r') out.push('r'); else if (s[0] === 'g') out.push('g'); else if (s[0] === 'y' || s[0] === 'a') out.push('y'); }
    return out;
  }
  if (typeof l === 'object') { const out = []; for (let i = 0; i < (l.red | 0); i++) out.push('r'); for (let i = 0; i < (l.green | 0); i++) out.push('g'); for (let i = 0; i < (l.yellow | 0); i++) out.push('y'); if (l.vertical) return ['rv']; return out; }
  return null;
}
/** Lamp slots in a housing for the lights: L (left), R (right), B (below L), Y1 / Y2 (top). */
export function lampsFor(tokens) {
  const t = tokens || [], out = [];
  if (t.includes('rv')) return [{ slot: 'L', col: 'r' }, { slot: 'B', col: 'r' }];
  const r = t.filter((x) => x === 'r').length, g = t.filter((x) => x === 'g').length, y = t.filter((x) => x === 'y').length;
  if (r && g) { out.push({ slot: 'L', col: 'r' }, { slot: 'R', col: 'g' }); }
  else if (r) { out.push({ slot: 'L', col: 'r' }); if (r > 1) out.push({ slot: 'R', col: 'r' }); }
  else if (g) { out.push({ slot: 'R', col: 'g' }); if (g > 1) out.push({ slot: 'L', col: 'g' }); }
  if (y) { out.push({ slot: y > 1 ? 'Y1' : 'Y0', col: 'y' }); if (y > 1) out.push({ slot: 'Y2', col: 'y' }); }
  return out;
}
/** Lights of a bridge span face: server `sig` wins, else derived from the span state (§4.9). */
export function bridgeLights({ spanState, objState, sig, face, fixed = false, narrow = false }) {
  if (objState?.out) return ['rv'];
  const s = (sig || []).find((x) => x.face === face || x.face == null);
  const n = s ? normLights(s.lights) : null;
  if (n) return n;
  if (fixed) return narrow ? SIGNALS_LOCAL.fixedNarrow : SIGNALS_LOCAL.fixed;
  return SIGNALS_LOCAL[spanState?.st || 'closed'] || SIGNALS_LOCAL.closed;
}

// ------------------------------------------------------------------------------------------------ lock state
/** Chamber phase {st, side}: st may carry the side ('admit:1'), or the delta has `side` / `head`. */
export function chamberPhase(ch) {
  if (!ch) return { st: 'idle', side: 0 };
  let st = String(ch.st || 'idle'), side = fin(ch.side) ? Number(ch.side) : fin(ch.head) ? Number(ch.head) : 0;
  const m = /^([a-zA-Z_]+)[:(]?(\d)?\)?$/.exec(st);
  if (m) { st = m[1]; if (m[2] != null) side = Number(m[2]); }
  return { st, side };
}
/** Gate open fraction at head h (§4.8.2): admit / idle / release on that side open, closing → 1−p, opening → p. */
export function gateFrac(ch, head, now) {
  const { st, side } = chamberPhase(ch), p = progress(ch, now);
  switch (st) {
    case 'standsOpen': case 'open': return 1;
    case 'idle': case 'admit': case 'release': return head === side ? 1 : 0;
    case 'closing': return head === side ? 1 - p : 0;
    case 'opening': return head === side ? p : 0;
    default: return 0;   // levelling, turnaround, out
  }
}
export const G = 9.81;
/** §4.8.4 orifice levelling. μa default 0.7·A/400. */
export const levelTimeLocal = (A, mua, dh) => (dh > 0 ? (2 * A * Math.sqrt(dh)) / (mua * Math.sqrt(2 * G)) : 0);
export function levelAtLocal(A, mua, dh0, t) { const r = Math.sqrt(Math.max(0, dh0)) - (mua * Math.sqrt(2 * G) * t) / (2 * A); return r > 0 ? r * r : 0; }
/**
 * Chamber water level (y) now. levelling / turnaround: level1 − (level1 − level0)·(1 − t/T)² — the §4.8.4 curve
 * written with T = dur (server), else T from the orifice law with the chamber area. Before levelling level0, after level1.
 */
export function chamberLevel(ch, now, { A = null, mua = null } = {}) {
  if (!ch) return 0;
  const l0 = fin(ch.level0) ? Number(ch.level0) : 0, l1 = fin(ch.level1) ? Number(ch.level1) : l0;
  const { st } = chamberPhase(ch);
  if (st === 'levelling' || st === 'turnaround') {
    const t0 = absMs(ch.t0), dh = Math.abs(l1 - l0);
    let T = durS(ch.dur);
    if (!(T > 0) && A) T = levelTimeLocal(A, mua || (0.7 * A) / 400, dh);
    if (t0 == null || !(T > 0)) return l1;
    const p = clamp((now - t0) / (T * 1000), 0, 1);
    return l1 - (l1 - l0) * (1 - p) * (1 - p);
  }
  if (st === 'opening' || st === 'release' || st === 'standsOpen') return l1;
  return l0;
}
/** Flow (0…1) through the culverts now (foam strength): derivative of the curve, normalised. */
export function chamberFlow(ch, now) {
  const { st } = chamberPhase(ch); if (st !== 'levelling' && st !== 'turnaround') return 0;
  const p = progress(ch, now); return p >= 1 ? 0 : 1 - p;
}
/** Lights on a lock head face (§4.8.3): face 'out' looks at ships waiting outside, 'in' at ships in the chamber. */
export function lockHeadLights(ch, head, face, out = false) {
  if (out || ch?.out) return ['rv'];
  const { st, side } = chamberPhase(ch);
  if (st === 'standsOpen') return ['g'];
  if (st === 'levelling' || st === 'turnaround' || st === 'closing') return ['r'];
  if (head !== side) return ['r'];
  if (st === 'admit') return face === 'out' ? ['g'] : ['r'];
  if (st === 'release') return face === 'in' ? ['g'] : ['r'];
  if (st === 'opening') return face === 'in' ? ['r', 'g'] : ['r'];
  if (st === 'idle') return face === 'out' ? ['r', 'g'] : ['r'];
  return ['r'];
}
const LOCK_WORDS = { idle: 'waiting', admit: 'entering — make fast', closing: 'gates closing', levelling: 'levelling', opening: 'gates opening', release: 'leaving', turnaround: 'empty turnaround', standsOpen: 'lock stands open', out: 'out of service' };
export function lockStateText(ch, now, sideNames = []) {
  const { st, side } = chamberPhase(ch), w = LOCK_WORDS[st] || st;
  const nm = sideNames[side] || (side ? 'head 1' : 'head 0');
  if (st === 'levelling' || st === 'turnaround') {
    const left = Math.max(0, Math.round((1 - progress(ch, now)) * durS(ch.dur)));
    const dh = Math.abs((Number(ch.level1) || 0) - (Number(ch.level0) || 0));
    return `${w} ${f2(dh)} m · ${fmtMinSec(left)} left`;
  }
  if (st === 'admit' || st === 'release' || st === 'idle' || st === 'opening' || st === 'closing') return `${w} (${nm} side)`;
  return w;
}
export const fmtMinSec = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

// ------------------------------------------------------------------------------------------------ clearance + verdict (local fallbacks)
/** clrNow(obj, i, {h, frac, off}) — §4.3; lift spans move continuously, others count as closed until fully open. */
export function clrNowLocal(obj, i, { h = 0, frac = 0, off = 0 } = {}) {
  const s = obj?.spans?.[i]; if (!s) return null;
  const clr = Number(s.clr), clrO = s.clrO == null ? null : Number(s.clrO);
  let base = clr;
  if (s.mov === 'lift' && clrO != null) base = clr + (clrO - clr) * clamp(frac, 0, 1);
  else if (MOVABLE.has(s.mov) && frac >= 0.999) base = clrO == null ? Infinity : clrO;
  return base + off - h;
}
/** passVerdict fallback (§4.5): air = {ad, need?, B?}; ctx = {h, off, Hs, frac, state}. */
export function verdictLocal(air, obj, i, ctx = {}) {
  const s = obj?.spans?.[i];
  if (!s || !air) return { verdict: 'under', need: null, clrNow: null, clrOpenNow: null, why: 'no data' };
  const h = ctx.h || 0, off = ctx.off || 0;
  const need = fin(air.need) ? Number(air.need) : Number(air.ad) + AD_MARGIN + 0.5 * (ctx.Hs || 0);
  const clrNow = clrNowLocal(obj, i, { h, frac: 0, off });
  const mov = MOVABLE.has(s.mov);
  const clrOpenNow = mov ? (s.clrO == null ? Infinity : Number(s.clrO) + off - h) : null;
  if (fin(air.B) && fin(s.w) && Number(air.B) + 1.0 > Number(s.w)) return { verdict: 'never', need, clrNow, clrOpenNow, why: 'too wide' };
  if (need <= clrNow) return { verdict: clrNow - need < 1.0 ? 'tight' : 'under', need, clrNow, clrOpenNow, why: '' };
  const st = ctx.state?.st;
  if (mov && need <= clrOpenNow && (ctx.frac ?? 0) >= 0.999) return { verdict: 'opening', open: true, need, clrNow, clrOpenNow, why: 'open now' };
  if (mov && need <= clrOpenNow) return st === 'out' || st === 'noservice' ? { verdict: 'closed', need, clrNow, clrOpenNow, why: st } : { verdict: 'opening', need, clrNow, clrOpenNow, why: '' };
  return { verdict: 'never', need, clrNow, clrOpenNow, why: mov ? 'too high even open' : 'too high' };
}
export const verdictClass = (v) => (v === 'under' ? 'ok' : v === 'tight' ? 'tight' : 'red');

// ------------------------------------------------------------------------------------------------ HUD strings
/** "AIR 8.62 m · draught 4.08 m" */
export function fmtAir(air) {
  if (!air || !fin(air.ad)) return 'AIR —';
  return `AIR ${f2(air.ad)} m` + (fin(air.T) ? ` · draught ${f2(air.T)} m` : '');
}
export function fmtDist(m) { return !fin(m) ? '' : m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`; }
/** The next-3 strip: items {name, verdict, clrNow, clrOpenNow, need, dist, vhf, id} → chips. */
export function fmtStrip(items = []) {
  return items.slice(0, 3).map((it) => {
    const cls = it.open ? 'ok' : verdictClass(it.verdict);
    const name = shortName(it.name || 'Bridge');
    let text;
    if (it.verdict === 'under' || it.verdict === 'tight') text = `${f1(it.clrNow)} m`;
    else if (it.verdict === 'opening' && it.open) text = 'open · go';
    else if (it.verdict === 'opening') text = it.vhf ? `opening · ch ${it.vhf}` : 'opening';
    else if (it.verdict === 'closed') text = 'closed';
    else text = 'no pass';
    const margin = fin(it.clrNow) && fin(it.need) ? it.clrNow - it.need : null;
    const title = `${it.name}: ${it.verdict}${margin != null && Number.isFinite(margin) ? ` (margin ${margin >= 0 ? '+' : ''}${f1(margin)} m)` : ''}`;
    return { id: it.id, cls, name, text, sub: fmtDist(it.dist), title };
  });
}
export function shortName(n) {
  return String(n).replace(/^Brug over (de |het )?/i, '').replace(/\s*\(.*\)\s*$/, '').replace(/^Spoorbrug over /i, '').slice(0, 22);
}
export const SRC_TEXT = { 0: 'official (RWS)', 1: 'OpenSeaMap', 2: 'est.' };
export const srcText = (o) => (o?.src === 'fis' && !o?.e ? 'official (RWS)' : o?.e === 2 ? 'est.' : o?.src === 'osm' ? 'OpenSeaMap' : SRC_TEXT[o?.e ?? 2]);
export const MOV_TEXT = { fixed: 'fixed', bascule: 'bascule', bascule2: 'double bascule', lift: 'lift', swing: 'swing', pontoon: 'pontoon', draw: 'drawbridge', retract: 'retractable' };
export function kindText(o) {
  const m = [...new Set((o?.spans || []).map((s) => s.mov))].filter((x) => x !== 'fixed');
  const k = o?.kind === 'rail' ? 'rail bridge' : o?.kind === 'foot' ? 'footbridge' : 'bridge';
  return m.length ? `${m.map((x) => MOV_TEXT[x] || x).join(' + ')} ${k}` : `fixed ${k}`;
}
/** "14.0 m above NAP; water +1.2 → 12.8 m" */
export function datumNote(obj, span, h, clrNow) {
  const d = obj?.datum || 'NAP', sign = h >= 0 ? '+' : '−';
  return `${f1(span.clr)} m above ${d}; water ${sign}${f1(Math.abs(h))} → ${f1(clrNow)} m`;
}
const DAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** Weekday index 0 = Monday in a time zone, and HH:MM. */
export function localDay(date, tz = 'Europe/Amsterdam') {
  try {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
    const wd = p.find((x) => x.type === 'weekday')?.value, hh = p.find((x) => x.type === 'hour')?.value, mm = p.find((x) => x.type === 'minute')?.value;
    return { day: Math.max(0, DAY.indexOf(wd)), hhmm: `${hh === '24' ? '00' : hh}:${mm}` };
  } catch { const d = new Date(date); return { day: (d.getUTCDay() + 6) % 7, hhmm: d.toISOString().slice(11, 16) }; }
}
/** Hours today: "24 h", "06:00–22:00", "on request (60 min notice)", "no service". */
export function hoursToday(hours, date = Date.now()) {
  if (!hours) return 'on request';
  const { day } = localDay(new Date(date), hours.tz || 'Europe/Amsterdam');
  const w = hours.week?.[day] || [];
  if (w.length === 1 && w[0][0] === '00:00' && (w[0][1] === '24:00' || w[0][1] === '23:59')) return '24 h';
  const txt = w.map(([a, b]) => `${a}–${b}`).join(', ');
  const night = hours.onRequestNight ? `on request${hours.onRequestNight.noticeMin ? ` (${hours.onRequestNight.noticeMin} min notice)` : ''}` : '';
  if (!txt) return night || 'no service';
  return night ? `${txt}; else ${night}` : txt;
}
export function blocksText(blocks = []) {
  return blocks.map((b) => `${(b.days || []).length === 5 && b.days[0] === 1 ? 'Mon–Fri' : (b.days || []).map((d) => DAY[(d + 6) % 7]).join(' ')} ${b.from}–${b.to}${b.why ? ` (${b.why})` : ''}`);
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
export { esc };

// ------------------------------------------------------------------------------------------------ SVG views
/**
 * To-scale side view (§5.5): the bridge deck in section at its clearance now, the waterline, and the ship's silhouette at
 * its current air draught approaching from the left; the dashed `need` line is red when it is above the underside.
 * opts: { clrNow, clrOpenNow, th, deckW, ship: {ad, need, L, kind: 'sail'|'motor'|'cargo', tiers}, mov, frac, w, W, H }
 */
export function sideViewSvg(o) {
  const W = o.W || 340, H = o.H || 150, pad = 14;
  const ship = o.ship || {}, ad = fin(ship.ad) ? Number(ship.ad) : 0, need = fin(ship.need) ? Number(ship.need) : ad + AD_MARGIN;
  const L = clamp(fin(ship.L) ? Number(ship.L) : 20, 5, 400), deckW = clamp(fin(o.deckW) ? o.deckW : 12, 4, 60), th = fin(o.th) ? o.th : 1.5;
  const clr = fin(o.clrNow) ? Number(o.clrNow) : null, clrO = fin(o.clrOpenNow) && o.clrOpenNow !== Infinity ? Number(o.clrOpenNow) : null;
  const topM = Math.max(ad, need, (clr ?? 0) + th, (clrO ?? 0) + th, 4) * 1.12 + 1;
  const spanM = L + 8 + deckW + 6;
  const k = Math.min((W - 2 * pad) / spanM, (H - 2 * pad - 10) / topM);
  const wy = H - pad - 8;                                              // waterline (px)
  const Y = (m) => wy - m * k, X0 = pad + (W - 2 * pad - spanM * k) / 2;
  const xb = X0 + (L + 8) * k, xs = X0;                                // bridge left edge, ship stern
  const red = clr != null && need > clr;
  const out = [`<svg class="ww-side" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Side view to scale">`];
  out.push(`<rect x="0" y="${wy}" width="${W}" height="${H - wy}" fill="#123a52"/>`, `<line x1="0" x2="${W}" y1="${wy}" y2="${wy}" stroke="#5ad6ff" stroke-width="1"/>`);
  // bridge: deck section (closed / now) + ghost of the open span, pier below
  if (clr != null) {
    out.push(`<rect x="${xb}" y="${Y(clr + th)}" width="${deckW * k}" height="${th * k}" fill="#8f8a82" stroke="#c9c3b8" stroke-width="0.8"/>`);
    out.push(`<rect x="${xb + deckW * k * 0.35}" y="${Y(clr)}" width="${deckW * k * 0.3}" height="${clr * k}" fill="rgba(143,138,130,0.25)"/>`);
    out.push(`<text x="${xb + deckW * k + 3}" y="${Y(clr) + 4}" class="ww-svg-t">${f1(clr)} m</text>`);
  }
  if (clrO != null && (clr == null || Math.abs(clrO - clr) > 0.5)) out.push(`<rect x="${xb}" y="${Y(clrO + th)}" width="${deckW * k}" height="${th * k}" fill="none" stroke="#9fb5c8" stroke-dasharray="3 2"/>`, `<text x="${xb + deckW * k + 3}" y="${Y(clrO) + 4}" class="ww-svg-t">open ${f1(clrO)}</text>`);
  else if (o.mov && o.mov !== 'fixed' && o.mov !== 'lift') out.push(`<text x="${xb}" y="${pad + 4}" class="ww-svg-t">opens fully</text>`);
  // ship silhouette
  const hf = Math.min(Math.max(1, 0.08 * L), ad * 0.35), x = (m) => xs + m * k;
  const hull = `${x(0)},${Y(hf)} ${x(L * 0.92)},${Y(hf)} ${x(L)},${Y(hf + 0.6)} ${x(L * 0.97)},${Y(-0.3)} ${x(L * 0.05)},${Y(-0.3)}`;
  out.push(`<polygon points="${hull}" fill="#e8e2d6" stroke="#20242a" stroke-width="0.8"/>`);
  if (ship.kind === 'sail') {
    const mx = x(L * 0.42);
    out.push(`<line x1="${mx}" x2="${mx}" y1="${Y(hf)}" y2="${Y(ad)}" stroke="#e8e2d6" stroke-width="1.6"/>`);
    out.push(`<polygon points="${mx + 1},${Y(ad - 0.6)} ${mx + 1},${Y(hf + 1.2)} ${x(L * 0.9)},${Y(hf + 1.2)}" fill="rgba(232,226,214,0.55)"/>`);
  } else {
    const tiers = clamp(Number(ship.tiers) || 0, 0, 8), mastH = Math.min(3, ad * 0.15), sup = Math.max(hf + 1, ad - mastH);
    if (tiers) out.push(`<rect x="${x(L * 0.3)}" y="${Y(hf + tiers * 2.59)}" width="${L * 0.5 * k}" height="${tiers * 2.59 * k}" fill="#c0563c"/>`);
    out.push(`<rect x="${x(L * 0.04)}" y="${Y(sup)}" width="${Math.max(3, L * 0.16 * k)}" height="${(sup - hf) * k}" fill="#f2f2f2" stroke="#20242a" stroke-width="0.6"/>`);
    out.push(`<line x1="${x(L * 0.1)}" x2="${x(L * 0.1)}" y1="${Y(sup)}" y2="${Y(ad)}" stroke="#f2f2f2" stroke-width="1.4"/>`);
  }
  const lc = red ? '#ff6b6b' : '#4fd18b';
  out.push(`<line x1="${xs}" x2="${xb + deckW * k}" y1="${Y(need)}" y2="${Y(need)}" stroke="${lc}" stroke-width="1.2" stroke-dasharray="5 3"/>`);
  out.push(`<text x="${xs}" y="${Y(need) - 3}" class="ww-svg-t" fill="${lc}">need ${f1(need)} m</text>`);
  out.push(`<text x="${pad}" y="${H - 3}" class="ww-svg-s">to scale · waterline now</text></svg>`);
  return out.join('');
}
/** Plan view of a chamber with the planned ship rectangles (lock card slot preview). x along from head 0, y across. */
export function lockPlanSvg(ch, plan = [], youId = null, W = 320) {
  const len = Number(ch?.len) || 100, wid = Number(ch?.wid) || 12, pad = 8;
  const k = (W - 2 * pad) / len, H = Math.max(40, wid * k + 2 * pad);
  const out = [`<svg class="ww-plan" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Chamber plan">`,
    `<rect x="${pad}" y="${pad}" width="${len * k}" height="${wid * k}" fill="#123a52" stroke="#8f8a82" stroke-width="2"/>`];
  for (const p of plan) {
    const you = p.ship === youId || p.id === youId;
    const x = pad + (Number(p.x) || 0) * k, y = pad + (Number(p.y) || 0) * k, w = (Number(p.L) || 10) * k, h = (Number(p.B) || 4) * k;
    out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" fill="${you ? '#f2b134' : '#c3d5e3'}" opacity="0.9"><title>${esc(p.name || p.ship || '')}</title></rect>`);
  }
  out.push('</svg>');
  return out.join('');
}
