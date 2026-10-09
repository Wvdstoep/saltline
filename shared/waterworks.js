// Bridges, locks and inland rules (docs/BRIDGES-LOCKS-VHF-CONTRACT.md §4.2–§4.10). Pure functions shared by the server,
// client prediction and tests. Types (registry objects) are documented in the contract §4.2 (Bridge) and §4.8.1 (Lock).
import { datumOffset } from './waterlevel.js';
import { profileOf, airDraftNow, deckTiers, kTopRaised, cargoSplit, TEU_T, AD_MARGIN } from './airdraft.js';

const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
const G = 9.81;

// ------------------------------------------------------------------------------------------------ tables
/** CEMT classes: max length, beam, draught (m), standard bridge clearance (m). VIc beam 22.8 (or 34.2 for 2 × 3). */
export const CEMT = {
  I: { L: 38.5, B: 5.05, T: 2.5, H: 4.0, kind: 'spits' },
  II: { L: 55, B: 6.6, T: 2.5, H: 4.0, kind: 'kempenaar' },
  III: { L: 80, B: 8.2, T: 2.5, H: 4.0, kind: 'dortmunder' },
  IV: { L: 85, B: 9.5, T: 2.8, H: 5.25, kind: 'Rhine–Herne' },
  Va: { L: 110, B: 11.4, T: 3.5, H: 5.25, kind: 'large Rhine vessel' },
  Vb: { L: 185, B: 11.4, T: 4.0, H: 5.25, kind: 'push convoy 2 long' },
  VIa: { L: 110, B: 22.8, T: 4.0, H: 7.0, kind: '2 abreast' },
  VIb: { L: 195, B: 22.8, T: 4.0, H: 7.0, kind: '4-barge push' },
  VIc: { L: 280, B: 22.8, T: 4.0, H: 9.1, kind: '6-barge push' },
  VII: { L: 285, B: 34.2, T: 4.0, H: 9.1, kind: '9-barge push' },
};
export const CEMT_ORDER = ['0', 'I', 'II', 'III', 'IV', 'Va', 'Vb', 'VIa', 'VIb', 'VIc', 'VII'];

/** Signal lights (§4.9, game mapping; Q11: verify against BPR before release). */
export const SIGNALS = {
  red: ['red'], outOfService: ['red', 'red'], prepare: ['red', 'green'], go: ['green'], recommended: ['yellow'], recommendedOneWay: ['yellow', 'yellow'],
};
/** Numeric `mov` code of the tile vectors (§4.2): 0 fixed, 1 bascule, 2 lift, 3 swing, 4 pontoon, 5 other movable. */
export const MOV_CODE = { fixed: 0, bascule: 1, bascule2: 1, lift: 2, swing: 3, pontoon: 4, retract: 4, draw: 5 };
/** Warn (red-green, barriers) and opening / closing durations (s), §4.6. lift: move = lift height / 0.25 m/s. */
export const BRIDGE_DUR = { bascule: [60, 70], bascule2: [60, 80], swing: [60, 90], lift: [60, null], pontoon: [30, 60], retract: [30, 60], draw: [45, 45] };
export const LIFT_SPEED = 0.25;
export const REACTION = { manned: 120, remote: 300 };
export const BUNDLE_S = 360;                   // requests with ETA ≤ tOpen + 6 min ride the same opening
export const MAX_HOLD = { default: 360, liftPort: 1200 };
export const GATE_TIME = { mitre: 120, sector: 150, lift: 90, rolling: 180, drop: 60 };
export const LOCK_ENTRY_MAX = 600, LOCK_EXIT_MAX = 360, LOCK_TURNAROUND_WAIT = 300, LOCK_TURNAROUND_FILL = 0.6, ZERO_LIFT = 0.05;
export const PUSH_BUTTON_M = 300, REQUEST_RANGE_M = 3000;
export const FALLBACK = { fixedClr: 2.5, movableClr: 1.5, liftOpenAdd: 25, hours: [['06:00', '22:00']], sill: 2.5 };

export const isMovable = (span) => !!span && span.mov && span.mov !== 'fixed';
export const posOf = (obj) => obj.p || (obj.line ? [(obj.line[0][0] + obj.line[obj.line.length - 1][0]) / 2, (obj.line[0][1] + obj.line[obj.line.length - 1][1]) / 2] : [0, 0]);

/** Warn and move durations of a span (s). */
export function spanTimes(span) {
  const d = BRIDGE_DUR[span.mov] || [60, 70];
  let move = d[1];
  if (span.mov === 'lift') move = Math.ceil(((Number.isFinite(span.clrO) ? span.clrO : span.clr + FALLBACK.liftOpenAdd) - span.clr) / LIFT_SPEED - 1e-9);
  return { warn: d[0], move };
}

// ------------------------------------------------------------------------------------------------ clearance
/** Datum offset of an object (MHWS / LAT depend on its position). */
export function objOffset(obj) { const [la, lo] = posOf(obj); return datumOffset(obj.datum || 'NAP', la, lo, obj.kp); }

/** Clearance now (m) under span `spanIdx` at water height h (game frame) and open fraction frac (0 closed … 1 open).
 *  Lift spans move continuously; bascule / swing / other count as 0 until fully open. */
export function clrNow(obj, spanIdx, { h = 0, frac = 0, off } = {}) {
  const s = obj.spans[spanIdx]; if (!s) return 0;
  const o = Number.isFinite(off) ? off : objOffset(obj);
  let c;
  if (!(frac > 0) || !isMovable(s)) c = s.clr;
  else if (frac >= 1) c = s.clrO == null ? (s.mov === 'lift' ? s.clr : Infinity) : s.clrO;   // open bascule/swing/pontoon spans clear any air draught (FIS gives no open clearance)
  else if (s.mov === 'lift') c = s.clr + frac * ((Number.isFinite(s.clrO) ? s.clrO : s.clr) - s.clr);
  else c = 0;
  return c === Infinity ? Infinity : r3(c + o - h);
}
/** Peilschaal reading: clearance now of the closed span, rounded down to 0.1 m. */
export function gauge(obj, spanIdx, h) { return Math.floor(clrNow(obj, spanIdx, { h, frac: 0 }) * 10 + 1e-6) / 10; }
/** Board text (§5.2): fixed "14.0", lift "3.6 / 24.0", bascule/swing "3.6 / –", estimates "≈ 2.5". */
export function boardText(span, e = 0) {
  if (e === 2) return `≈ ${span.clr.toFixed(1)}`;
  if (!isMovable(span)) return span.clr.toFixed(1);
  return `${span.clr.toFixed(1)} / ${Number.isFinite(span.clrO) && span.clrO != null ? span.clrO.toFixed(1) : '–'}`;
}

/**
 * Passage verdict (§4.5). shipAir = { ad | need, beam, Hs? } (an airDraftNow result plus beam is fine).
 * ctx = { h, frac, out, noservice, nextService, Hs }.
 * → { verdict: 'under'|'tight'|'opening'|'never'|'closed', need, clrNow, clrOpenNow, why }
 */
export function passVerdict(shipAir, obj, spanIdx, ctx = {}) {
  const s = obj.spans[spanIdx];
  const Hs = ctx.Hs ?? shipAir.Hs ?? 0;
  const need = typeof shipAir.need === 'function' ? shipAir.need(Hs) : Number.isFinite(shipAir.need) ? shipAir.need : r3(shipAir.ad + AD_MARGIN + 0.5 * Hs);
  const off = objOffset(obj);
  const c = clrNow(obj, spanIdx, { h: ctx.h ?? 0, frac: 0, off });
  const cO = isMovable(s) ? clrNow(obj, spanIdx, { h: ctx.h ?? 0, frac: 1, off }) : null;
  const out = { need, clrNow: c, clrOpenNow: cO };
  if (Number.isFinite(shipAir.beam) && shipAir.beam + 1.0 > s.w) return { ...out, verdict: 'never', why: 'too wide' };
  if (need <= c) return { ...out, verdict: c - need < 1.0 ? 'tight' : 'under', why: null };
  if (!isMovable(s) || !(need <= cO)) return { ...out, verdict: 'never', why: isMovable(s) ? 'too high when open' : 'too high' };
  if (ctx.out || ctx.noservice) return { ...out, verdict: 'closed', why: ctx.out ? 'out of service' : 'outside hours', nextService: ctx.nextService ?? null };
  return { ...out, verdict: 'opening', why: null };
}
const RANK = { under: 0, tight: 1, opening: 2, closed: 3, never: 4 };
/** The best span for this ship (under < tight < opening < closed < never; ties: recommended, then widest). */
export function bestSpan(shipAir, obj, ctx = {}) {
  let best = null;
  obj.spans.forEach((s, i) => {
    const v = passVerdict(shipAir, obj, i, ctx);
    const k = RANK[v.verdict] * 1000 - (s.rec ? 500 : 0) - s.w;
    if (!best || k < best.k) best = { k, i, v };
  });
  return best ? { span: best.i, ...best.v } : null;
}

// ------------------------------------------------------------------------------------------------ hours (local time)
const FMT = new Map();
function fmtFor(tz) {
  if (!FMT.has(tz)) FMT.set(tz, new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit' }));
  return FMT.get(tz);
}
const DOW = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
/** Local weekday (1 = Mon … 7 = Sun) and minute of day at epoch seconds t. */
export function localTime(t, tz = 'Europe/Amsterdam') {
  const parts = fmtFor(tz).formatToParts(new Date(t * 1000));
  const g = (k) => parts.find((p) => p.type === k)?.value;
  return { dow: DOW[g('weekday')], min: Number(g('hour')) * 60 + Number(g('minute')), sec: Math.floor(t) % 60 };
}
export const hm = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
export const hhmm = (min) => `${String(Math.floor(((min % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(((min % 60) + 60) % 60).padStart(2, '0')}`;
/** Epoch seconds of local minute-of-day `m` on the day `dayOff` days after t's local day. */
function atLocal(t, tz, dayOff, m) { const L = localTime(t, tz); return Math.floor(t) - L.sec + ((dayOff * 1440 + m - L.min) * 60); }
export function inHours(hours, t) {
  if (!hours) return true;
  const L = localTime(t, hours.tz);
  return (hours.week[L.dow - 1] || []).some(([a, b]) => L.min >= hm(a) && L.min < hm(b));
}
/** Next start of service after t → { t, hhmm } (null if never within 8 days). */
export function nextService(hours, t) {
  if (!hours) return { t, hhmm: hhmm(localTime(t).min) };
  const L = localTime(t, hours.tz);
  for (let d = 0; d < 8; d++) {
    const dow = ((L.dow - 1 + d) % 7);
    for (const [a] of hours.week[dow] || []) {
      const m = hm(a); if (d === 0 && m <= L.min) continue;
      return { t: atLocal(t, hours.tz, d, m), hhmm: a };
    }
  }
  return null;
}
/** Is t inside the night-on-request window? */
export function inNightWindow(hours, t) {
  const n = hours && hours.onRequestNight; if (!n) return false;
  const m = localTime(t, hours.tz).min, a = hm(n.from), b = hm(n.to);
  return a <= b ? m >= a && m < b : m >= a || m < b;
}
/** The block in force at t for this traffic kind → { block, until } | null. */
export function blockAt(blocks, t, kind = 'commercial', tz = 'Europe/Amsterdam') {
  if (!blocks || !blocks.length) return null;
  const L = localTime(t, tz);
  for (const b of blocks) {
    if (b.only && b.only !== kind) continue;
    if (b.days && !b.days.includes(L.dow)) continue;
    const a = hm(b.from), e = hm(b.to);
    if (L.min >= a && L.min < e) return { block: b, until: atLocal(t, tz, 0, e) };
  }
  return null;
}
/** Round t up to the next opening slot (rail bridges / slot schedules). */
export function nextSlot(slots, t, tz = 'Europe/Amsterdam') {
  if (!slots || !(slots.every > 0)) return t;
  const L = localTime(t, tz);
  const exact = L.sec === 0 && (((L.min - (slots.at || 0)) % slots.every) + slots.every) % slots.every === 0;
  if (exact) return t;
  const k = Math.floor((L.min - (slots.at || 0)) / slots.every) + 1;
  return atLocal(t, tz, 0, (slots.at || 0) + k * slots.every);
}

/**
 * When can this span open for a request made at `now`? (§4.6 scheduling)
 * → { ok: true, tOpen, why?: 'notice'|'block'|'slot' } | { ok: false, reason: 'hours', next: 'HH:MM', tNext }
 */
export function scheduleOpen(obj, now, { kind = 'commercial', reaction } = {}) {
  const tz = obj.hours?.tz || 'Europe/Amsterdam';
  const react = reaction ?? obj.reaction ?? (obj.remote ? REACTION.remote : REACTION.manned);
  let t = now + react, why = null;
  if (obj.hours && !inHours(obj.hours, now)) {
    if (inNightWindow(obj.hours, now)) { t = Math.max(t, now + obj.hours.onRequestNight.noticeMin * 60); why = 'notice'; }
    else { const n = nextService(obj.hours, now); return { ok: false, reason: 'hours', next: n ? n.hhmm : null, tNext: n ? n.t : null }; }
  }
  for (let i = 0; i < 6; i++) {
    const t0 = t;
    const b = blockAt(obj.blocks, t, kind, tz); if (b) { t = b.until; why = 'block'; }
    const s = nextSlot(obj.slots, t, tz); if (s !== t) { t = s; why = why || 'slot'; }
    if (t === t0) break;
  }
  return { ok: true, tOpen: t, why };
}

// ------------------------------------------------------------------------------------------------ bridge state machine
/** Initial span state. */
export const closedState = () => ({ st: 'closed', t0: 0, dur: 0, tOpen: null });
/**
 * Advance a movable span's state to `now` (§4.6). s = { st, t0, dur, tOpen, holdMax? }.
 * ctx = { allPassed, blockStarts, outUntil }. Pure: returns a new state; `events` lists transitions (for radio lines).
 */
export function bridgeStep(span, s, now, ctx = {}) {
  const { warn, move } = spanTimes(span);
  let x = { ...s }; const events = [];
  const go = (st, t0, dur) => { x = { ...x, st, t0, dur }; events.push({ st, t: t0 }); };
  for (let guard = 0; guard < 8; guard++) {
    if (x.st === 'out') { if (ctx.outUntil != null && now >= ctx.outUntil) { go('closed', ctx.outUntil, 0); x.tOpen = null; continue; } break; }
    if (x.st === 'closed' && x.tOpen != null && now >= x.tOpen) { go('warn', x.tOpen, warn); continue; }
    if (x.st === 'warn' && now >= x.t0 + x.dur) { go('opening', x.t0 + x.dur, move); continue; }
    if (x.st === 'opening' && now >= x.t0 + x.dur) { go('open', x.t0 + x.dur, x.holdMax || MAX_HOLD.default); continue; }
    if (x.st === 'open') {
      const end = x.t0 + x.dur;
      if (ctx.allPassed || ctx.blockStarts || now >= end) { go('closing', Math.min(now, end), move); continue; }
      break;
    }
    if (x.st === 'closing' && now >= x.t0 + x.dur) { go('closed', x.t0 + x.dur, 0); x.tOpen = null; continue; }
    break;
  }
  return { state: x, events };
}
/** Open fraction of a span state at `now` (clients animate the same way). */
export function openFrac(s, now) {
  const f = s.dur > 0 ? Math.max(0, Math.min(1, (now - s.t0) / s.dur)) : 1;
  if (s.st === 'opening') return f;
  if (s.st === 'open') return 1;
  if (s.st === 'closing') return 1 - f;
  return 0;
}
/** Lights shown at a span for its state (§4.9). */
export function spanSignal(span, s) {
  if (!isMovable(span)) return span.rec ? (span.w < 2 * (11.4 + 3) ? SIGNALS.recommendedOneWay : SIGNALS.recommended) : [];
  switch (s.st) {
    case 'out': case 'noservice': return SIGNALS.outOfService;
    case 'warn': case 'opening': return SIGNALS.prepare;
    case 'open': return SIGNALS.go;
    default: return SIGNALS.red;
  }
}

// ------------------------------------------------------------------------------------------------ locks
/** Effective culvert area × discharge coefficient (m²): default 0.7 × A / 400, data overrides. */
export const culvertMua = (ch) => (Number.isFinite(ch.culvert) ? ch.culvert : (0.7 * ch.len * ch.wid) / 400);
/** Levelling time (s) for head dh through orifice flow: T = 2A√Δh / (μa√(2g)). */
export function levelTime(A, mua, dh) { return (2 * A * Math.sqrt(Math.abs(dh))) / (mua * Math.sqrt(2 * G)); }
/** Remaining head (m) after t seconds: (√Δh0 − μa√(2g) t / (2A))². */
export function levelAt(A, mua, dh0, t) {
  const s = Math.sqrt(Math.abs(dh0)) - (mua * Math.sqrt(2 * G) * Math.max(0, t)) / (2 * A);
  return s > 0 ? s * s : 0;
}
/** Sill depth at the low side (m): the smaller sill below the side reference level + (low level − reference). */
export function sillDepth(ch, dLow = 0) {
  const s = [ch.sillUp, ch.sillDn].filter(Number.isFinite);
  return (s.length ? Math.min(...s) : FALLBACK.sill) + dLow;
}
/** Fit test (§4.8.5). ship = { L, B, T, need? }; ctx = { dLow, headClr } (headClr = max clearance a lock-head passage offers). */
export function fitChamber(ch, ship, ctx = {}) {
  if (ship.L + 5 > ch.len) return { ok: false, why: 'length' };
  if (ship.B + 1.0 > ch.wid) return { ok: false, why: 'beam' };
  if (ship.T + Math.max(0.3, 0.05 * ship.T) > sillDepth(ch, ctx.dLow || 0) + 1e-9) return { ok: false, why: 'draught' };
  if (Number.isFinite(ctx.headClr) && Number.isFinite(ship.need) && ship.need > ctx.headClr) return { ok: false, why: 'air draught' };
  return { ok: true };
}
const SMALL = new Set(['small', 'yacht', 'sail', 'motor']);
const isSmall = (s) => SMALL.has(s.kind);
/** Queue order: registration time, priority passenger/ferry → commercial → small (§4.8.5). */
export function queueOrder(ships) {
  const pr = (s) => (s.kind === 'passenger' ? 0 : isSmall(s) ? 2 : 1);
  return ships.slice().sort((a, b) => pr(a) - pr(b) || (a.at ?? 0) - (b.at ?? 0) || String(a.id).localeCompare(String(b.id)));
}
/**
 * Deterministic chamber packing (§4.8.5). ships in queue order [{ id, L, B, kind }]; opts.occupants: rectangles already in the
 * chamber [{ id, x, y, l, w, kind }] (AIS ships, from their reported positions, x along from the entry head, y from the
 * entering ship's starboard wall). → { placed: [{ id, x, y, l, w }], waiting: [id] }
 * Rectangles: (L + 3) × (B + 0.6), the width capped at the usable width for ships that passed the fit test.
 */
export function packChamber(chamber, ships, opts = {}) {
  const Lu = chamber.len - 5, Wu = chamber.wid - 1.0, eps = 1e-6;
  const occ = (opts.occupants || []).map((o) => ({ ...o, small: isSmall(o), occupant: true }));
  const placed = [], waiting = [];
  let commercialBlocked = false;
  const all = () => occ.concat(placed);
  const overlap = (a, b) => a.x < b.x + b.l - eps && b.x < a.x + a.l - eps && a.y < b.y + b.w - eps && b.y < a.y + a.w - eps;
  const xOverlap = (a, b) => a.x < b.x + b.l - eps && b.x < a.x + a.l - eps;
  for (const s of ships) {
    const small = isSmall(s);
    if (!small && commercialBlocked) { waiting.push(s.id); continue; }
    const r = { id: s.id, l: s.L + 3, w: Math.min(s.B + 0.6, Wu), small };
    const xs = [...new Set([0, ...all().map((o) => o.x + o.l)])].sort((a, b) => a - b);
    let spot = null;
    for (const x of xs) {
      if (x + r.l > Lu + eps) continue;
      const ys = [0, ...[...new Set(all().map((o) => o.y + o.w))].sort((a, b) => a - b), Wu - r.w];
      for (const y of ys) {
        if (y < -eps || y + r.w > Wu + eps) continue;
        const c = { ...r, x, y };
        if (all().some((o) => overlap(c, o))) continue;
        if (small) {
          if (all().some((o) => !o.small && xOverlap(c, o))) continue;               // never abreast of a commercial ship
          const wall = y < eps || Math.abs(y + r.w - Wu) < eps;
          const raft = all().some((o) => o.small && xOverlap(c, o) && (Math.abs(o.y + o.w - y) < eps || Math.abs(y + r.w - o.y) < eps));
          if (!wall && !raft) continue;
        }
        spot = c; break;
      }
      if (spot) break;
    }
    if (spot) placed.push(spot);
    else { waiting.push(s.id); if (!small) commercialBlocked = true; }
  }
  return { placed: placed.map(({ id, x, y, l, w }) => ({ id, x: r2(x), y: r2(y), l: r2(l), w: r2(w) })), waiting };
}
/** Fraction of the usable chamber area a queue would fill. */
export function queueFill(chamber, ships) {
  const A = (chamber.len - 5) * (chamber.wid - 1);
  return ships.reduce((a, s) => a + (s.L + 3) * Math.min(s.B + 0.6, chamber.wid - 1), 0) / A;
}

/** Lock fee (cr, §4.8.6). ship = { L, kind }. */
export function lockFee(lock, ship) {
  if (lock.operator === 'RWS' || lock.operator === 'Port of Rotterdam') return 0;
  const small = isSmall(ship);
  if (lock.fee && typeof lock.fee === 'object') { const v = small ? lock.fee.small : lock.fee.commercial; if (Number.isFinite(v)) return v; }
  if (Number.isFinite(lock.fee)) return lock.fee;
  return small ? 6 : Math.round(0.5 * ship.L);
}

/**
 * Pure chamber cycle step (§4.8.2). cs = { st, side, t0, dur, level0, level1, plan, empty }. Timed transitions only;
 * starting `admit` / a turnaround is the server's call. ctx = { allFast, allLeft, levels: [h side0, h side1] (now),
 * gate (s), extra: { closing, opening } (lock-head bridge time added to the gate time) }.
 */
export function lockStep(ch, cs, now, ctx = {}) {
  let x = { ...cs }; const events = [];
  const gate = ctx.gate ?? GATE_TIME[ch.gates?.[0]?.type] ?? GATE_TIME.mitre;
  const go = (st, t0, dur, more = {}) => { x = { ...x, st, t0, dur, ...more }; events.push({ st, t: t0 }); };
  const A = ch.len * ch.wid, mua = culvertMua(ch);
  for (let guard = 0; guard < 8; guard++) {
    const end = x.t0 + x.dur;
    if (x.st === 'admit' && (ctx.allFast || now >= end)) { go('closing', Math.min(now, end), gate + (ctx.extra?.closing || 0), { dropped: !ctx.allFast }); continue; }
    if (x.st === 'closing' && now >= end) {
      const l0 = ctx.levels ? ctx.levels[x.side] : x.level0, l1 = ctx.levels ? ctx.levels[1 - x.side] : x.level1;
      go('levelling', end, Math.ceil(levelTime(A, mua, l1 - l0)), { level0: l0, level1: l1 }); continue;
    }
    if (x.st === 'levelling' && now >= end) { go('opening', end, gate + (ctx.extra?.opening || 0)); continue; }
    if (x.st === 'opening' && now >= end) {
      if (x.empty) { go('idle', end, 0, { side: 1 - x.side, plan: [], empty: false }); continue; }
      go('release', end, LOCK_EXIT_MAX); continue;
    }
    if (x.st === 'release' && (ctx.allLeft || now >= end)) { go('idle', Math.min(now, end), 0, { side: 1 - x.side, plan: [] }); continue; }
    break;
  }
  return { state: x, events };
}
/** Chamber water level at `now` (game frame). levels = [side0 h, side1 h] now. */
export function chamberLevel(ch, cs, now, levels) {
  if (cs.st === 'levelling') {
    const A = ch.len * ch.wid, dh = levelAt(A, culvertMua(ch), cs.level1 - cs.level0, now - cs.t0);
    return cs.level1 - Math.sign(cs.level1 - cs.level0) * dh;
  }
  if (cs.st === 'opening' || cs.st === 'release') return levels[1 - cs.side];
  return levels[cs.side];
}
/** Lights at the two heads (§4.8.3): [head0, head1]. */
export function lockSignals(cs) {
  const R = SIGNALS.red, Gr = SIGNALS.go;
  if (cs.st === 'standsopen') return [Gr, Gr];
  if (cs.st === 'out') return [SIGNALS.outOfService, SIGNALS.outOfService];
  const at = (side, light) => (side === 0 ? [light, R] : [R, light]);
  if (cs.st === 'admit') return at(cs.side, Gr);
  if (cs.st === 'release') return at(1 - cs.side, Gr);
  if (cs.st === 'idle' && cs.prepare) return at(cs.side, SIGNALS.prepare);
  return [R, R];
}
/**
 * Lock-head bridges with `pairedWith` never open at the same time (§4.8.7). needs = [{ ship, bridge, from, to }] in plan
 * order (seconds the bridge must be open). → { ok: [need], deferred: [ship] }.
 */
export function pairedPlan(needs, pairs) {
  const ok = [], deferred = [];
  for (const n of needs) {
    const other = pairs[n.bridge];
    if (other && ok.some((o) => o.bridge === other && o.from < n.to && n.from < o.to)) deferred.push(n.ship);
    else ok.push(n);
  }
  return { ok, deferred };
}

// ------------------------------------------------------------------------------------------------ strikes (§4.7)
/**
 * Consequences of a ship whose top reaches the deck. ship = { cls, cargo, fuelT, ballastT, fold, sogKn, Hs };
 * bridge = { kind }, clr = clearance now at the contact point. → null (no contact) or
 * { overlap, part: 'rig'|'antenna'|'mast'|'wheelhouse'|'containers', dismast, antennaMul, radarOff, condLoss, stop, injury,
 *   teuLost, cargoLostT, pollutionFine, outMin, fee, after: { ad } }
 */
export function strikeOutcome(ship, bridge, clr) {
  const p = profileOf(ship.cls);
  const v = Math.max(0, ship.sogKn || 0), Hs = ship.Hs || 0;
  const st = { cargo: ship.cargo, fuelT: ship.fuelT, ballastT: ship.ballastT, fold: ship.fold };
  const a0 = airDraftNow(ship.cls, st);
  const overlap = r3(a0.ad + 0.5 * Hs - clr);
  if (!(overlap > 0)) return null;
  const res = { overlap, part: null, dismast: false, antennaMul: 1, radarOff: false, condLoss: 0, stop: false, injury: false, teuLost: 0, cargoLostT: 0, pollutionFine: 0 };
  if (p.sail) {
    if (overlap < 0.3 && v < 2) { res.part = 'antenna'; res.antennaMul = 0.3; }
    else { res.part = 'rig'; res.dismast = true; res.antennaMul = 0.3; }
  } else {
    let cargo = ship.cargo, a = a0;
    // containers: the top tier goes overboard while the stack is the highest point and still hits
    while (a.deckTiers > 0 && a.stackTop >= kTopRaised(p, ship.fold) && a.stackTop - a.T + 0.5 * Hs > clr) {
      const { box } = cargoSplit(cargo);
      const teu = Math.ceil(box / TEU_T - 1e-9), deckTeu = teu - p.holdTeu;
      const lose = Math.min(p.deckSlots, deckTeu - (a.deckTiers - 1) * p.deckSlots);
      res.teuLost += lose; res.cargoLostT += lose * TEU_T; res.part = 'containers';
      cargo = removeBoxes(cargo, lose * TEU_T);
      a = airDraftNow(ship.cls, { ...st, cargo });
    }
    res.pollutionFine = 2000 * res.teuLost;
    const ov2 = r3(a.ad + 0.5 * Hs - clr);
    if (ov2 > 0) {
      if (ov2 > 2) { res.part = 'wheelhouse'; res.condLoss = r3(0.05 * ov2 * (v / 4)); res.stop = true; res.injury = true; res.radarOff = true; res.antennaMul = 0.3; }
      else { res.part = res.part || 'mast'; res.radarOff = true; res.antennaMul = 0.3; res.condLoss = r3(0.02 * ov2); }
    }
    res.after = { ad: a.ad, cargo };
  }
  res.outMin = overlap > 0.5 ? r1(30 * Math.min(4, overlap)) : 0;
  res.fee = Math.round(20000 * overlap * Math.max(1, v) * (bridge && bridge.kind === 'foot' ? 0.3 : 1));
  return res;
}
function removeBoxes(cargo, t) {
  if (Array.isArray(cargo)) {
    let left = t; const out = [];
    for (const c of cargo.slice().reverse()) {
      if (left > 0 && ['containers', 'reefer_box', 'dg_box'].includes(c.good)) { const k = Math.min(c.qty, left); left -= k; if (c.qty - k > 0) out.push({ ...c, qty: c.qty - k }); }
      else out.push(c);
    }
    return out.reverse();
  }
  if (cargo && typeof cargo === 'object') {
    const o = { ...cargo }; let left = t;
    for (const g of ['containers', 'reefer_box', 'dg_box']) if (o[g] > 0 && left > 0) { const k = Math.min(o[g], left); o[g] -= k; left -= k; }
    return o;
  }
  return cargo;
}

// ------------------------------------------------------------------------------------------------ misc
/** Tile-vector light copy of a bridge (converter v2, §4.2). */
export function vectorCopy(b) {
  const s = b.spans.find((x) => x.rec) || b.spans[0];
  return { id: b.id, clr: s.clr, clrO: s.clrO === Infinity ? -1 : s.clrO, wO: s.w, mov: MOV_CODE[s.mov] ?? 5, e: b.e, datum: b.datum, sp: [Math.round(s.a * 10), Math.round(s.b * 10)] };
}
export { deckTiers };

// ------------------------------------------------------------------------------------------------ OSM / converter v2 helpers
/** KEEP_TAGS for the overlay (OV_SCHEMA 2): today's set + the seamark bridge keys, bridge / lock / CEMT / radio / harbour keys
 *  (§7.1, §8.1). `maxheight` stays kept (lock gates use it) but is NEVER a water clearance (see seamarkBridge). */
export const WW_KEEP_TAGS = /^(man_made|floating|waterway|lock|name|height|width|diameter|crane:type|seamark:type|seamark:.*(colour|character|period|category|minimum_depth|clearance_height|height|range)|seamark:bridge:.*|depth|maxdraught|maxheight|maxlength|maxwidth|bridge|bridge:movable|bridge:structure|layer|CEMT|vhf|lock_name|lock_ref|operator|opening_hours|ele|leisure|mooring|harbour|seamark:harbour:.*|seamark:small_craft_facility:.*|seamark:radio_station:.*|website|capacity|fee)$/;
const SEAMARK_MOV = { fixed: 'fixed', opening: 'bascule', lifting: 'lift', bascule: 'bascule', swing: 'swing', pontoon: 'pontoon', drawbridge: 'draw', transporter: 'retract', retractable: 'retract', submersible: 'retract' };
const OSM_MOV = { bascule: 'bascule', lift: 'lift', swing: 'swing', drawbridge: 'draw', transporter: 'retract', retractable: 'retract', submersible: 'retract', pontoon: 'pontoon' };
const numTag = (v) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : null; };
/**
 * Clearances from OpenSeaMap / OSM tags of a bridge node or way. Water clearance only from seamark:bridge:clearance_height*
 * (or a `maxheight` tagged on the WATERWAY way, `onWaterway: true`); a road `maxheight` is ignored (§2.3).
 * → { mov, clr, clrO, wO, e: 1 } | null when no clearance tag.
 */
export function seamarkBridge(tags = {}, { onWaterway = false } = {}) {
  const cat = String(tags['seamark:bridge:category'] || '').split(';')[0];
  const mov = SEAMARK_MOV[cat] || OSM_MOV[tags['bridge:movable']] || (cat ? 'fixed' : tags['bridge:movable'] ? 'bascule' : 'fixed');
  const clrC = numTag(tags['seamark:bridge:clearance_height_closed']), clrO = numTag(tags['seamark:bridge:clearance_height_open']);
  let clr = clrC ?? numTag(tags['seamark:bridge:clearance_height']);
  if (clr == null && onWaterway) clr = numTag(tags.maxheight);
  if (clr == null) return null;
  const wO = numTag(tags['seamark:bridge:clearance_width']);
  return { mov, clr, clrO: mov === 'fixed' ? null : clrO ?? (mov === 'lift' ? clr + FALLBACK.liftOpenAdd : Infinity), wO, e: 1 };
}
/** §3.6 conservative fallbacks. → { clr, clrO, w, e: 2 } */
export function fallbackBridge({ roadClass = '', waterW = 0, cemt = null, mov = 'fixed' } = {}) {
  const big = /motorway|trunk|rail/.test(roadClass);
  let clr = mov !== 'fixed' ? FALLBACK.movableClr : big && waterW > 300 ? 25 : big && waterW > 100 ? 7.0 : FALLBACK.fixedClr;
  if (mov === 'fixed' && cemt && CEMT[cemt]) clr = Math.min(clr, CEMT[cemt].H);
  const clrO = mov === 'fixed' ? null : mov === 'lift' ? clr + FALLBACK.liftOpenAdd : Infinity;
  const w = mov === 'fixed' ? waterW * 0.8 : Math.min(40, waterW * 0.8);
  return { clr, clrO, w: r1(w), e: 2 };
}
/** Converter v2 vector record (§4.2) for an OFM/OSM bridge line plus an optional joined seamark node's tags. */
export function bridgeVector(base, seamarkTags = null, ctx = {}) {
  const sm = seamarkTags ? seamarkBridge(seamarkTags) : null;
  const fb = sm ? null : fallbackBridge({ roadClass: base.cls, waterW: ctx.waterW, cemt: ctx.cemt, mov: OSM_MOV[base.movable] || 'fixed' });
  const v = sm || fb;
  const mov = sm ? sm.mov : OSM_MOV[base.movable] || 'fixed';
  return { ...base, clr: v.clr, deck: v.clr + 1.5, clrO: v.clrO === Infinity ? -1 : v.clrO, wO: sm ? sm.wO : fb.w, mov: MOV_CODE[mov] ?? 5, e: v.e, datum: ctx.datum || null, id: base.id || null };
}
