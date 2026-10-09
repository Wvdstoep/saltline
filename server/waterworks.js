// Server-authoritative waterworks (docs/BRIDGES-LOCKS-VHF-CONTRACT.md §4.6–§4.8, §8.2): the registry of bridges and
// locks, movable-bridge scheduling with convoy bundling, lock cycles with chamber packing, strike checks and the
// `ww_static` / `ww` wire payloads. Rules live in shared/waterworks.js; this module holds state and time.
//
// createWaterworks(game, fis, opts)
//   game: optional; only `game.simTime` is read when opts.now is absent.
//   fis:  { bridges, locks } registry objects (server/fis.js loadFis()) or null.
//   opts: { now() → s, levels (levels-nl.json), aisIn(lockId, chamberId) → [{ id, x, y, l, w, kind }],
//           water(lat, lon, t) → h (override) }
import {
  bestSpan, passVerdict, scheduleOpen, spanTimes, bridgeStep, openFrac, spanSignal, isMovable, clrNow, objOffset, posOf,
  BUNDLE_S, MAX_HOLD, fitChamber, packChamber, queueOrder, queueFill, lockFee, lockStep, chamberLevel, lockSignals,
  ZERO_LIFT, LOCK_ENTRY_MAX, LOCK_TURNAROUND_WAIT, LOCK_TURNAROUND_FILL, GATE_TIME, levelTime, culvertMua, strikeOutcome,
  inHours, nextService, blockAt, REQUEST_RANGE_M, PUSH_BUTTON_M, closedState,
} from '../shared/waterworks.js';
import { waterLevelAt, sideLevel } from '../shared/waterlevel.js';
import { airDraftNow, profileOf } from '../shared/airdraft.js';
import { seamarkBridge, fallbackBridge } from '../shared/waterworks.js';

const D2R = Math.PI / 180;
const CELL = 0.05;                                   // spatial index cell (deg)
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
export const STRIKE_RANGE_M = 400, STATIC_RANGE_M = 8000, STRIKE_COOLDOWN_S = 60;

/** Local metric frame helpers. */
export function toXY(p, o) { return [(p[1] - o[1]) * 111320 * Math.cos(o[0] * D2R), (p[0] - o[0]) * 110540]; }
export function distM(a, b) { const [x, y] = toXY(a, b); return Math.hypot(x, y); }
function lineLen(pts) { let s = 0; for (let i = 1; i < pts.length; i++) s += distM(pts[i - 1], pts[i]); return s; }
/** Distance (m) from p to a polyline and the position along it. */
export function lineDist(pts, p) {
  let best = { d: Infinity, along: 0 }, acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const [bx, by] = toXY(pts[i], pts[i - 1]), [px, py] = toXY(p, pts[i - 1]);
    const L2 = bx * bx + by * by || 1, t = Math.max(0, Math.min(1, (px * bx + py * by) / L2)), seg = Math.sqrt(L2);
    const d = Math.hypot(px - t * bx, py - t * by);
    if (d < best.d) best = { d, along: acc + t * seg };
    acc += seg;
  }
  return best;
}

/** Ship view used by requests: { id, name, cls, kind, L, B, T, ad, need?, beam } from a game player or a plain object. */
export function shipView(p) {
  if (!p) return null;
  if (p.ship && p.ship.cls) {
    const prof = profileOf(p.ship.cls);
    const a = airDraftNow(p.ship.cls, { cargo: p.cargo || [], fuelT: p.fuel, ballastT: p.ship.ballastT || 0, fold: p.ship.fold || {} });
    const small = prof.type === 'sail_yacht' || prof.type === 'motor_yacht' || prof.length < 20;
    return { id: p.id, name: p.name || p.ship.name || p.id, cls: p.ship.cls, kind: prof.type === 'ferry' || prof.type === 'cruise' ? 'passenger' : small ? 'small' : 'commercial',
      L: prof.length, B: prof.beam, beam: prof.beam, T: a.T, ad: a.ad, need: a.need, lat: p.ship.lat, lon: p.ship.lon, sogKn: Math.abs(p.ship.spd || 0) };
  }
  return { beam: p.B ?? p.beam, ...p };
}

/** Separating-axis test of two rectangles { c: [x, y], ux: [x, y] (unit along), hl, hw } in metres. */
export function rectsOverlap(a, b) {
  const axes = [a.ux, [-a.ux[1], a.ux[0]], b.ux, [-b.ux[1], b.ux[0]]];
  const proj = (r, ax) => { const c = r.c[0] * ax[0] + r.c[1] * ax[1]; const e = Math.abs(r.hl * (r.ux[0] * ax[0] + r.ux[1] * ax[1])) + Math.abs(r.hw * (-r.ux[1] * ax[0] + r.ux[0] * ax[1])); return [c - e, c + e]; };
  for (const ax of axes) { const [a0, a1] = proj(a, ax), [b0, b1] = proj(b, ax); if (a1 < b0 || b1 < a0) return false; }
  return true;
}

export function createWaterworks(game, fis, opts = {}) {
  const now = opts.now || (() => (game && Number.isFinite(game.simTime) ? game.simTime : Date.now() / 1000));
  const objs = new Map(), grid = new Map();
  const bstate = new Map();          // bridge id → { spans: [spanState], plans: [[plan]], out, rev }
  const lstate = new Map();          // lock id → { chambers: [chamberState], rev }
  const stays = new Map();           // ship id → { lockId, chamber, slot, side }
  const lastSide = new Map();        // `${shipId}|${bridgeId}` → sign of the ship relative to the deck line
  const cooldown = new Map();
  const listeners = [];
  const outages = {};
  const emit = (e) => { for (const f of listeners) { try { f(e); } catch { /* listener errors never break the tick */ } } };

  // ---------------------------------------------------------------------------------------------- registry
  function index(o) {
    const [la, lo] = posOf(o);
    const k = `${Math.floor(la / CELL)}:${Math.floor(lo / CELL)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(o.id);
  }
  function add(list, kind) {
    for (const o of list || []) {
      const x = { ...o, type: kind };
      objs.set(x.id, x); index(x);
      if (kind === 'bridge') bstate.set(x.id, { spans: x.spans.map(() => closedState()), plans: x.spans.map(() => []), out: null, rev: 0 });
      else lstate.set(x.id, { rev: 0, chambers: x.chambers.map(() => ({ st: 'idle', side: 0, t0: now(), dur: 0, plan: [], queue: [[], []], waitSince: null })) });
    }
  }
  if (fis) { add(fis.bridges, 'bridge'); add(fis.locks, 'lock'); }

  function near(lat, lon, rM) {
    const out = [], dc = Math.ceil(rM / 111000 / CELL) + 1, ci = Math.floor(lat / CELL), cj = Math.floor(lon / CELL);
    for (let i = ci - dc; i <= ci + dc; i++) for (let j = cj - dc; j <= cj + dc; j++) for (const id of grid.get(`${i}:${j}`) || []) {
      const o = objs.get(id); if (o && distM(posOf(o), [lat, lon]) <= rM) out.push(o);
    }
    return out;
  }
  const waterAt = (lat, lon, t) => (opts.water ? opts.water(lat, lon, t) : waterLevelAt(lat, lon, t, { levels: opts.levels }).h);
  const levelsOf = (lock, t) => lock.sides.map((s) => sideLevel(s.level, lock.p[0], lock.p[1], t));

  // ---------------------------------------------------------------------------------------------- bridges
  const planEnd = (span, plan) => { const { warn, move } = spanTimes(span); return plan.tOpen + warn + move + (plan.holdMax || MAX_HOLD.default) + move; };
  function holdMaxOf(obj, span) { return span.mov === 'lift' && /Port/.test(obj.operator || '') ? MAX_HOLD.liftPort : MAX_HOLD.default; }

  /** Request an opening. ship: shipView-able; etaS: seconds from now (min 60). */
  function request(id, ship0, etaS = 60, { button = false } = {}) {
    const obj = objs.get(id); const ship = shipView(ship0);
    if (!obj || obj.type !== 'bridge') return { ok: false, reason: 'unknown' };
    const st = bstate.get(id), t = now();
    if (obj.lockId) return { ok: false, reason: 'lock', lockId: obj.lockId };
    if (st.out && st.out.until > t) return { ok: false, reason: 'out', until: st.out.until, why: st.out.why };
    if (ship.lat != null && ship.lon != null) {
      const d = distM([ship.lat, ship.lon], posOf(obj));
      if (d > (button ? PUSH_BUTTON_M : REQUEST_RANGE_M)) return { ok: false, reason: 'range', distM: Math.round(d) };
    }
    const [la, lo] = posOf(obj);
    const h = waterAt(la, lo, t);
    const best = bestSpan(ship, obj, { h });
    if (!best) return { ok: false, reason: 'unknown' };
    if (best.verdict === 'under' || best.verdict === 'tight') return { ok: true, verdict: best.verdict, n: 0, span: best.span, clrNow: best.clrNow };
    if (best.verdict === 'never') return { ok: false, reason: 'never', verdict: 'never', why: best.why, clrOpenNow: best.clrOpenNow };
    const si = best.span, span = obj.spans[si], plans = st.plans[si], ss = st.spans[si];
    const eta = t + Math.max(60, etaS || 60);
    let plan = null;
    for (const p of plans) {
      const active = p === plans[0] ? ['closed', 'warn', 'opening', 'open'].includes(ss.st) : true;
      if (active && eta <= p.tOpen + BUNDLE_S && !p.ships.some((s) => s.id === ship.id)) { plan = p; break; }
      if (p.ships.some((s) => s.id === ship.id)) { plan = p; break; }
    }
    let why = null;
    if (!plan) {
      const sch = scheduleOpen(obj, t, { kind: ship.kind === 'small' ? 'small' : 'commercial' });
      if (!sch.ok) return { ok: false, reason: sch.reason, next: sch.next, tNext: sch.tNext, verdict: 'closed' };
      let tOpen = sch.tOpen; why = sch.why;
      const last = plans[plans.length - 1];
      if (last) tOpen = Math.max(tOpen, planEnd(span, last));
      plan = { tOpen, ships: [], holdMax: holdMaxOf(obj, span) };
      plans.push(plan);
      if (plans.length === 1) { st.spans[si] = { ...ss, tOpen, holdMax: plan.holdMax }; }
      st.rev++;
    }
    if (!plan.ships.some((s) => s.id === ship.id)) plan.ships.push({ id: ship.id, name: ship.name, eta, passed: false });
    let n = 0; for (const p of plans) { for (const s of p.ships) { n++; if (s.id === ship.id) break; } if (p === plan) break; }
    return { ok: true, verdict: 'opening', n, tOpen: plan.tOpen, span: si, why };
  }
  function passed(id, shipId) {
    const st = bstate.get(id); if (!st) return;
    for (const plans of st.plans) for (const p of plans) for (const s of p.ships) if (s.id === shipId) s.passed = true;
  }
  function tickBridge(obj, st, t) {
    if (st.out && t >= st.out.until) { st.out = null; delete outages[obj.id]; st.spans = st.spans.map(() => closedState()); st.rev++; emit({ type: 'closed', id: obj.id, t }); }
    obj.spans.forEach((span, i) => {
      if (!isMovable(span) || st.out) return;
      const plans = st.plans[i], plan = plans[0];
      const blk = !!blockAt(obj.blocks, t, 'commercial', obj.hours?.tz);
      const { state, events } = bridgeStep(span, st.spans[i], t, { allPassed: !!plan && plan.ships.length > 0 && plan.ships.every((s) => s.passed), blockStarts: blk });
      st.spans[i] = state;
      for (const e of events) {
        st.rev++;
        emit({ type: e.st === 'closed' ? 'closed' : e.st, id: obj.id, span: i, t: e.t, ships: plan ? plan.ships.map((s) => s.id) : [] });
        if (e.st === 'closed' && plan) {
          for (const s of plan.ships) if (!s.passed) emit({ type: 'missed', id: obj.id, span: i, ship: s.id, t: e.t });
          plans.shift();
          if (plans[0]) st.spans[i] = { ...st.spans[i], tOpen: Math.max(plans[0].tOpen, e.t), holdMax: plans[0].holdMax };
        }
      }
    });
  }

  // ---------------------------------------------------------------------------------------------- locks
  function chamberFor(lock, ship, t) {
    const lv = levelsOf(lock, t), low = Math.min(...lv);
    let best = null;
    lock.chambers.forEach((ch, i) => {
      const okKind = ship.kind === 'small' ? true : ch.kind !== 'small';
      if (!okKind) return;
      const f = fitChamber(ch, ship, { dLow: low });
      if (!f.ok) { if (!best) best = { i: -1, why: f.why }; return; }
      const pref = ship.kind === 'small' ? (ch.kind === 'small' ? 0 : 1) : 0;
      if (!best || best.i < 0 || pref < best.pref) best = { i, pref };
    });
    return best || { i: -1, why: 'no chamber' };
  }
  function cycleEstimate(lock, ch, t) {
    const lv = levelsOf(lock, t), gate = GATE_TIME[ch.gates?.[0]?.type] || GATE_TIME.mitre;
    return Math.round(2 * gate + levelTime(ch.len * ch.wid, culvertMua(ch), lv[0] - lv[1]) + 360);
  }
  /** Register for a lock passage from `side` (0 = outer / lower name side, 1 = inner). */
  function registerLock(id, ship0, side = 0) {
    const lock = objs.get(id); const ship = shipView(ship0);
    if (!lock || lock.type !== 'lock') return { ok: false, reason: 'unknown' };
    const t = now();
    if (lock.hours && !inHours(lock.hours, t)) { const n = nextService(lock.hours, t); return { ok: false, reason: 'hours', next: n && n.hhmm }; }
    const c = chamberFor(lock, ship, t);
    if (c.i < 0) return { ok: false, reason: 'fit', why: c.why };
    const L = lstate.get(id), cs = L.chambers[c.i], ch = lock.chambers[c.i];
    const fee = lockFee(lock, ship);
    if (cs.st === 'standsopen') return { ok: true, chamber: ch.id, n: 0, tCycle: 0, fee, standsOpen: true };
    const q = cs.queue[side];
    if (!q.some((s) => s.id === ship.id) && !cs.plan.some((s) => s.id === ship.id)) q.push({ id: ship.id, name: ship.name, L: ship.L, B: ship.B, T: ship.T, kind: ship.kind, at: t, need: typeof ship.need === 'function' ? ship.need(0) : ship.need });
    if (cs.st === 'idle' && cs.side !== side && cs.waitSince == null) cs.waitSince = t;
    const order = queueOrder(q); const n = order.findIndex((s) => s.id === ship.id) + 1;
    const cyc = cycleEstimate(lock, ch, t);
    const remaining = cs.st === 'idle' ? (cs.side === side ? 0 : cyc) : Math.max(0, cs.t0 + cs.dur - t) + cyc;
    L.rev++;
    return { ok: true, chamber: ch.id, n, tCycle: Math.round(remaining), fee };
  }
  function makeFast(id, shipId) {
    const L = lstate.get(id); if (!L) return false;
    for (const cs of L.chambers) for (const s of cs.plan) if (s.id === shipId && (cs.st === 'admit')) { s.fast = true; L.rev++; return true; }
    return false;
  }
  function leave(id, shipId) {
    const L = lstate.get(id); if (!L) return false;
    for (const cs of L.chambers) for (const s of cs.plan) if (s.id === shipId) { s.left = true; stays.delete(shipId); L.rev++; return true; }
    return false;
  }
  function headBridges(lock, head) { return (lock.bridges || []).map((b) => objs.get(b)).filter((b) => b && b.head === head && b.spans.some(isMovable)); }
  function setBridge(b, open, t) {
    const st = bstate.get(b.id); if (!st) return;
    b.spans.forEach((s, i) => {
      if (!isMovable(s)) return;
      const cur = st.spans[i];
      if (open && (cur.st === 'closed' || cur.st === 'closing')) st.spans[i] = { st: 'warn', t0: t, dur: spanTimes(s).warn, tOpen: t, holdMax: 3600 };
      if (!open && (cur.st === 'open' || cur.st === 'opening' || cur.st === 'warn')) st.spans[i] = { st: 'closing', t0: t, dur: spanTimes(s).move, tOpen: null };
      st.rev++;
    });
  }
  const bridgeClosed = (b) => bstate.get(b.id).spans.every((s) => s.st === 'closed');
  function startAdmit(lock, ch, ci, cs, t) {
    const s = cs.side, q = queueOrder(cs.queue[s]);
    const occupants = opts.aisIn ? opts.aisIn(lock.id, ch.id) || [] : [];
    const { placed } = packChamber(ch, q, { occupants });
    if (!placed.length) return false;
    // lock-head bridge on head s: opened only if a planned ship needs it; never both of a pair at once (§4.8.7)
    const hb = headBridges(lock, s);
    const lv = levelsOf(lock, t);
    const plan = [];
    let needBridge = false;
    for (const pl of placed) {
      const ship = q.find((x) => x.id === pl.id);
      const needs = hb.some((b) => b.spans.every((sp, i) => !(Number.isFinite(ship.need) && ship.need <= clrNow(b, i, { h: lv[s] }))));
      if (needs && hb.some((b) => b.pairedWith && !bridgeClosed(objs.get(b.pairedWith)))) continue;   // deferred: stays queued
      if (needs) needBridge = true;
      plan.push({ id: pl.id, name: ship.name, x: pl.x, y: pl.y, l: pl.l, w: pl.w, fast: false, left: false });
    }
    if (!plan.length) return false;
    cs.queue[s] = cs.queue[s].filter((x) => !plan.some((p) => p.id === x.id));
    if (needBridge) for (const b of hb) setBridge(b, true, t);
    Object.assign(cs, { st: 'admit', t0: t, dur: LOCK_ENTRY_MAX, plan, empty: false, bridgeHead: needBridge ? s : null, waitSince: null });
    for (const p of plan) stays.set(p.id, { lockId: lock.id, chamber: ch.id, slot: { x: p.x, y: p.y }, side: 1 - s });
    emit({ type: 'admit', id: lock.id, chamber: ch.id, side: s, ships: plan.map((p) => p.id), t });
    return true;
  }
  function tickLock(lock, L, t) {
    const lv = levelsOf(lock, t);
    lock.chambers.forEach((ch, ci) => {
      const cs = L.chambers[ci];
      const zero = Math.abs(lv[0] - lv[1]) < ZERO_LIFT;
      if (cs.st === 'idle' && zero) { Object.assign(cs, { st: 'standsopen', t0: t, dur: 0 }); L.rev++; emit({ type: 'standsopen', id: lock.id, chamber: ch.id, t }); }
      else if (cs.st === 'standsopen' && !zero && Math.abs(lv[0] - lv[1]) >= 2 * ZERO_LIFT) { Object.assign(cs, { st: 'idle', t0: t }); L.rev++; }
      if (cs.st === 'standsopen') { cs.queue = [[], []]; return; }
      if (cs.st === 'idle') {
        if (cs.queue[cs.side].length) { if (startAdmit(lock, ch, ci, cs, t)) L.rev++; }
        else if (cs.queue[1 - cs.side].length) {
          if (cs.waitSince == null) cs.waitSince = t;
          if (t - cs.waitSince >= LOCK_TURNAROUND_WAIT || queueFill(ch, cs.queue[1 - cs.side]) >= LOCK_TURNAROUND_FILL) {
            Object.assign(cs, { st: 'closing', t0: t, dur: GATE_TIME[ch.gates?.[0]?.type] || GATE_TIME.mitre, plan: [], empty: true, waitSince: null });
            L.rev++; emit({ type: 'turnaround', id: lock.id, chamber: ch.id, t });
          }
        }
        return;
      }
      const prev = cs.st;
      const { state, events } = lockStep(ch, cs, t, { allFast: cs.plan.length > 0 && cs.plan.every((p) => p.fast), allLeft: cs.plan.every((p) => p.left), levels: lv });
      Object.assign(cs, state);
      for (const e of events) {
        L.rev++;
        if (prev === 'admit' && e.st === 'closing') {
          const lost = cs.plan.filter((p) => !p.fast);
          for (const p of lost) { stays.delete(p.id); emit({ type: 'lost_turn', id: lock.id, chamber: ch.id, ship: p.id, t: e.t }); }
          cs.plan = cs.plan.filter((p) => p.fast);
          if (cs.bridgeHead != null) for (const b of headBridges(lock, cs.bridgeHead)) setBridge(b, false, e.t);
        }
        if (e.st === 'opening' && !cs.empty) {
          const head = 1 - cs.side, hb = headBridges(lock, head);
          const need = cs.plan.some((p) => { const q = p.need; return hb.some((b) => b.spans.every((sp, i) => !(Number.isFinite(q) && q <= clrNow(b, i, { h: lv[head] })))); });
          if (need) { for (const b of hb) setBridge(b, true, e.t); cs.bridgeHead = head; } else cs.bridgeHead = null;
        }
        if (e.st === 'idle') {
          if (cs.bridgeHead != null) for (const b of headBridges(lock, cs.bridgeHead)) setBridge(b, false, e.t);
          cs.bridgeHead = null;
          for (const p of state.plan || []) stays.delete(p.id);
        }
        emit({ type: e.st === 'levelling' ? 'levelling' : e.st, id: lock.id, chamber: ch.id, t: e.t, dh: e.st === 'levelling' ? r2(Math.abs(cs.level1 - cs.level0)) : undefined, dur: e.st === 'levelling' ? cs.dur : undefined });
      }
      if (cs.st === 'idle') { for (const p of cs.plan || []) stays.delete(p.id); cs.plan = []; }
    });
  }

  // ---------------------------------------------------------------------------------------------- tick, strikes
  function tick() {
    const t = now();
    for (const [id, st] of bstate) { const o = objs.get(id); if (!o.lockId || st.out) tickBridge(o, st, t); else tickHead(o, st, t); }
    for (const [id, L] of lstate) tickLock(objs.get(id), L, t);
  }
  function tickHead(o, st, t) {   // lock-operated bridges: timed transitions only
    o.spans.forEach((span, i) => {
      if (!isMovable(span)) return;
      const { state, events } = bridgeStep(span, st.spans[i], t, {});
      st.spans[i] = { ...state, tOpen: null };
      for (const e of events) { st.rev++; emit({ type: e.st, id: o.id, span: i, t: e.t }); }
    });
  }

  /** Per tick, per ship under way: bridge-line crossings (for `passed`) and strikes (§4.7). → strike | null */
  function strikeCheck(p) {
    if (!p || !p.ship) return null;
    const t = now(), pos = [p.ship.lat, p.ship.lon];
    const prof = profileOf(p.ship.cls);
    let result = null;
    for (const o of near(pos[0], pos[1], STRIKE_RANGE_M + 200)) {
      if (o.type !== 'bridge' || !o.line) continue;
      const a = o.line[0], b = o.line[o.line.length - 1];
      const [bx, by] = toXY(b, a), len = Math.hypot(bx, by) || 1, ux = [bx / len, by / len];
      const [sx, sy] = toXY(pos, a);
      const along = sx * ux[0] + sy * ux[1], across = -sx * ux[1] + sy * ux[0];
      const key = `${p.id}|${o.id}`, sign = Math.sign(across) || 1, prev = lastSide.get(key);
      lastSide.set(key, sign);
      if (prev && prev !== sign && along >= -20 && along <= len + 20) passed(o.id, p.id);
      const hdg = (p.ship.hdg || 0) * D2R;
      const ship = { c: [sx, sy], ux: [Math.sin(hdg), Math.cos(hdg)], hl: prof.length / 2, hw: prof.beam / 2 };
      const deck = { c: [bx / 2, by / 2], ux, hl: len / 2, hw: (o.deckW || 12) / 2 };
      if (!rectsOverlap(ship, deck)) continue;
      if ((cooldown.get(key) || 0) > t) continue;
      const si = o.spans.findIndex((s) => along >= s.a && along <= s.b);
      if (si < 0) { cooldown.set(key, t + STRIKE_COOLDOWN_S); result = { id: o.id, part: 'pier', overlap: null, damage: null, fee: 0 }; break; }
      const st = bstate.get(o.id);
      const h = waterAt(pos[0], pos[1], t);
      const clr = clrNow(o, si, { h, frac: openFrac(st.spans[si], t) });
      const out = strikeOutcome({ cls: p.ship.cls, cargo: p.cargo || [], fuelT: p.fuel, ballastT: p.ship.ballastT || 0, fold: p.ship.fold || {}, sogKn: Math.abs(p.ship.spd || 0), Hs: p.Hs || 0 }, o, clr);
      if (!out) continue;
      cooldown.set(key, t + STRIKE_COOLDOWN_S);
      if (out.outMin > 0) setOut(o.id, t + out.outMin * 60, 'bridge strike');
      result = { id: o.id, part: out.part, overlap: out.overlap, damage: out, fee: out.fee };
      emit({ type: 'strike', id: o.id, ship: p.id, part: out.part, overlap: out.overlap, t });
      break;
    }
    return result;
  }
  function setOut(id, until, why) {
    const st = bstate.get(id); if (!st) return;
    st.out = { until, why }; outages[id] = { until, why };
    st.spans = st.spans.map((s) => ({ ...s, st: 'out', t0: now(), dur: 0 }));
    for (const plans of st.plans) plans.length = 0;
    st.rev++; emit({ type: 'out', id, until, why });
  }

  // ---------------------------------------------------------------------------------------------- join (§3.5)
  /**
   * Join OSM / OFM bridge lines to the registry: lines = [{ id: 'osm:w123' | 'ofm:14/x/y:i', pts: [[lat, lon]…], kind, structure?,
   * tags?, waterW?, cemt? }]. A FIS bridge takes the nearest line within 60 m of its point (FIS numbers win; the line, kind and
   * structure come from OSM); spans keep their place by projecting their synthetic midpoints onto the new line. Lines that
   * join nothing become OSM/OFM objects (seamark tags, else the §3.6 fallbacks, e: 2). → { joined, added }
   */
  function joinLines(lines) {
    let joined = 0, added = 0;
    const used = new Set();
    for (const o of objs.values()) {
      if (o.type !== 'bridge' || o.src !== 'fis' || o.lineSrc !== 'synthetic') continue;
      let best = null;
      for (const l of lines) {
        if (used.has(l.id)) continue;
        const d = lineDist(l.pts, o.p);
        if (d.d <= 60 && (!best || d.d < best.d.d || (d.d === best.d.d && String(l.id) < String(best.l.id)))) best = { l, d };
      }
      if (!best) continue;
      used.add(best.l.id);
      const a0 = o.line[0], b0 = o.line[o.line.length - 1];
      const mid = (s) => { const f = ((s.a + s.b) / 2) / Math.max(1, distM(a0, b0)); return [a0[0] + (b0[0] - a0[0]) * f, a0[1] + (b0[1] - a0[1]) * f]; };
      const spans = o.spans.map((s) => { const m = lineDist(best.l.pts, mid(s)).along; return { ...s, a: r2(m - s.w / 2), b: r2(m + s.w / 2) }; });
      Object.assign(o, { line: best.l.pts, lineSrc: String(best.l.id).split(':')[0], kind: best.l.kind || o.kind, structure: best.l.structure || o.structure, spans, joined: best.l.id });
      joined++;
    }
    for (const l of lines) {
      if (used.has(l.id) || objs.has(l.id)) continue;
      const sm = l.tags ? seamarkBridge(l.tags) : null;
      const mov = sm ? sm.mov : 'fixed';
      const v = sm || fallbackBridge({ roadClass: l.cls || '', waterW: l.waterW || 0, cemt: l.cemt, mov });
      const len = lineLen(l.pts), w = sm && sm.wO ? sm.wO : v.w || Math.max(6, len - 40);
      const p = l.pts[Math.floor(l.pts.length / 2)];
      add([{ id: l.id, name: (l.tags && l.tags.name) || null, kind: l.kind || 'road', src: String(l.id).split(':')[0], e: v.e, p, line: l.pts, lineSrc: String(l.id).split(':')[0], deckW: l.deckW || 12,
        structure: l.structure || 'girder', spans: [{ id: 0, a: r2(len / 2 - w / 2), b: r2(len / 2 + w / 2), mov, clr: v.clr, clrO: v.clrO, w: r2(w), hinge: null, pivot: mov === 'swing' ? 0.5 : null, rec: 1 }],
        datum: l.datum || 'MHWS', kp: null, vhf: l.tags && Number(l.tags.vhf) > 0 ? Number(l.tags.vhf) : null, call: mov === 'fixed' ? 'none' : l.tags && l.tags.vhf ? 'vhf' : 'button',
        hours: null, blocks: [], slots: null, lockId: null, pairedWith: null, fee: 0, notes: [], operator: null }], 'bridge');
      added++;
    }
    return { joined, added };
  }

  // ---------------------------------------------------------------------------------------------- wire
  function statics(lat, lon, r = STATIC_RANGE_M) { return near(lat, lon, r).map(compactStatic); }
  function compactStatic(o) {
    const { type, ...rest } = o;
    const x = { ...rest, kind: type === 'lock' ? 'lock' : o.kind, t: type };
    if (type === 'bridge') x.spans = o.spans.map((s) => ({ ...s, clrO: s.clrO === Infinity ? -1 : s.clrO }));
    return x;
  }
  function state(id) {
    const o = objs.get(id); if (!o) return null;
    const t = now();
    if (o.type === 'bridge') {
      const st = bstate.get(id);
      const spans = st.spans.map((s, i) => ({ i, st: s.st, t0: s.t0, dur: s.dur, frac: r2(openFrac(s, t)), tOpen: s.tOpen ?? null, queue: st.plans[i].reduce((a, p) => a + p.ships.length, 0) }));
      return { id, rev: st.rev, st: spans.some((s) => s.st !== 'closed') ? 'active' : 'closed', spans, sig: o.spans.map((sp, i) => ({ face: i, lights: spanSignal(sp, st.spans[i]) })), ...(st.out ? { out: st.out } : {}) };
    }
    const L = lstate.get(id), lv = levelsOf(o, t);
    return {
      id, rev: L.rev, levels: lv.map(r2),
      chambers: L.chambers.map((cs, i) => ({ id: o.chambers[i].id, st: cs.st, side: cs.side, t0: cs.t0, dur: cs.dur, level0: r2(cs.level0 ?? lv[cs.side]), level1: r2(cs.level1 ?? lv[1 - cs.side]),
        level: r2(chamberLevel(o.chambers[i], cs, t, lv)), sig: lockSignals(cs), plan: cs.plan.map((p) => ({ ship: p.id, x: p.x, y: p.y, L: p.l, B: p.w, fast: !!p.fast })),
        queue: [0, 1].flatMap((sd) => queueOrder(cs.queue[sd]).map((s, k) => ({ name: s.name, kind: s.kind, n: k + 1, side: sd }))) })),
    };
  }
  function stationsOn(ch, lat, lon, rM = 40000) {
    return near(lat, lon, rM).filter((o) => o.vhf === ch && o.call === 'vhf' && !o.lockId).map((o) => ({
      id: o.id, kind: o.type, callName: o.callName || o.name, ch: o.vhf, pos: posOf(o), h: 15, hours: o.hours || null, inHours: inHours(o.hours, now()),
    }));
  }
  function lockStay(shipId) {
    const s = stays.get(shipId); if (!s) return null;
    const o = objs.get(s.lockId), L = lstate.get(s.lockId), ci = o.chambers.findIndex((c) => c.id === s.chamber);
    return { ...s, y: r2(chamberLevel(o.chambers[ci], L.chambers[ci], now(), levelsOf(o, now()))) };
  }
  /** Air-draught verdicts for the next objects ahead (HUD strip). */
  function verdicts(ship0, lat, lon, rM = 3000) {
    const ship = shipView(ship0), t = now();
    return near(lat, lon, rM).filter((o) => o.type === 'bridge').map((o) => {
      const [la, lo] = posOf(o), b = bestSpan(ship, o, { h: waterAt(la, lo, t), out: !!bstate.get(o.id).out });
      return { id: o.id, name: o.name, distM: Math.round(distM([lat, lon], [la, lo])), verdict: b.verdict, need: b.need, clrNow: b.clrNow, clrOpenNow: b.clrOpenNow, vhf: o.vhf };
    }).sort((a, b) => a.distM - b.distM);
  }

  return {
    objs, add: (list, kind) => add(list, kind), joinLines, get: (id) => objs.get(id), near, statics, state, stationsOn,
    request, passed, registerLock, makeFast, leave, lockStay, tick, strikeCheck, setOut, verdicts,
    onEvent: (fn) => { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
    toSave: () => ({ v: 1, outages: { ...outages } }),
    load: (s) => { if (s && s.outages) for (const [id, o] of Object.entries(s.outages)) if (o.until > now()) setOut(id, o.until, o.why); },
    verdictAt: (ship, id, ctx = {}) => { const o = objs.get(id); if (!o) return null; const [la, lo] = posOf(o); return bestSpan(shipView(ship), o, { h: waterAt(la, lo, now()), ...ctx }); },
    attribution: fis && fis.attribution ? fis.attribution : null,
    _debug: { bstate, lstate, objOffset, passVerdict },
  };
}
