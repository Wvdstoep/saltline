// VHF radio, server side (docs/BRIDGES-LOCKS-VHF-CONTRACT.md §6.3–6.5, lane B). Server-authoritative message routing:
// who hears a transmission (channel, dual watch, range from antenna heights and power), which station answers and what it
// says (bridges and locks through the lane A `ww` interface, VTS sectors from data, the coast guard, AI and fleet ships),
// operator timing (3–8 s), wrong channel / out of hours = silence (+ a tip after 2 unanswered calls), DSC distress.
// AIS ships are never made to speak: they are only named in VTS traffic lists.
//
// No Node-only imports at module level, so the browser harness can run it too (loadVtsFile imports node:fs lazily).
//
// Protocol (§8.2):
//   C→S action vhf_set {on, ch, dual, power: 'hi'|'lo', lang, vol, open}       → p.radio; `you.radio`; a `vhf_st` push
//   C→S action vhf_tx  {ch, to: stationId|playerId|name|null, phrase, args, text?}
//   C→S action dsc     {kind: 'distress'|'urgency'|'safety', nature?}
//   S→C vhf     {ch, from: {id, name, kind}, to: {id, name}|null, phrase, args, text, q, at, self?}
//   S→C vhf_st  {ch, stations: [StationRow], near: [NearRow], sector: {id, name, ch}|null, fallbackCh}   (every 3 s while the set is open)
//   S→C event   {kind: 'info', text, radio: true}   (tips: wrong channel, out of hours, out of range)
import {
  CH_DISTRESS, CH_DSC, CH_BRIDGE, CH_INLAND, CH_CG_WORK, CH_LIST, ANTENNA, RATE, DEFAULT_RADIO,
  isVoice, hears, applySet, effectivePower, rangeKm, quality, shipAntenna, distKm, ptOf, inHours, hhmm, replyDelayS,
  inPoly, centroid, bars, absMs, dirWordOf,
} from '../shared/vhf.js';
import { isPlayerPhrase, autoArgs, typeKeyOf } from '../shared/vhfphrases.js';

const NEAR_KM = 3;                 // context chips: bridges / locks within 3 km
const AI_CHS = [CH_DISTRESS, CH_BRIDGE, CH_INLAND];   // AI and fleet ships listen on 16, 13 and 10
const CG_CHS = [CH_DISTRESS, CH_CG_WORK];
const ST_PUSH_MS = 3000;
const MISS_TIP_AFTER = 2;
const KN_MS = 0.514444;

// ------------------------------------------------------------------------------------------------ data
/** Normalise a vts-*.json document: verified sectors become stations; unverified ones point at their nearest verified sector. */
export function loadVts(doc) {
  if (!doc || !Array.isArray(doc.sectors)) return { sectors: [], unverified: [], fallbackCh: CH_INLAND };
  const sectors = [], unverified = [];
  for (const s of doc.sectors) {
    if (!Array.isArray(s.poly) || s.poly.length < 3) continue;
    const e = { id: s.id, name: s.callName || s.name, ch: s.ch, chAlt: s.chAlt || [], role: s.role || 'sector', poly: s.poly, pos: centroid(s.poly) };
    if (s.verified === false || !isVoice(s.ch)) unverified.push(e); else sectors.push(e);
  }
  const sec = sectors.filter((s) => s.role === 'sector');
  for (const u of unverified) {
    let best = null, bd = Infinity;
    for (const s of sec) { const d = distKm(u.pos, s.pos); if (d < bd || (d === bd && s.id < best.id)) { bd = d; best = s; } }
    u.fallback = best ? best.id : null;
  }
  return { sectors, unverified, fallbackCh: doc.fallbackCh || CH_INLAND };
}
/** Read the first VTS file that exists (the radio seed with verified sectors wins; lane A's file is the fallback). Node only. */
export async function loadVtsFile(paths) {
  const fs = await import('node:fs');
  const url = await import('node:url');
  const here = url.fileURLToPath(new URL('.', import.meta.url));
  const list = paths || [`${here}vhfdata/vts-nl.json`, `${here}waterworks/vts-nl.json`];   // the radio seed has the verified Rotterdam sector channels; lane A's coarse file is the fallback
  for (const f of list) { try { return loadVts(JSON.parse(fs.readFileSync(f, 'utf8'))); } catch { /* next */ } }
  return loadVts(null);
}
let DN = null;
function countryName(code) {
  try { DN = DN || new Intl.DisplayNames(['en'], { type: 'region' }); return DN.of(String(code).toUpperCase()) || code; } catch { return code; }
}
/**
 * Coast-guard stations from harbour positions: one per ~60 km (greedy, harbours sorted by id so it is deterministic),
 * antenna 60 m, named "<country> Coastguard" ("Netherlands Coastguard" in NL waters).
 */
export function coastStationsFrom(harbors = [], spacingKm = 60) {
  const out = [];
  const hs = [...harbors].filter((h) => Number.isFinite(h.lat) && Number.isFinite(h.lon)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const h of hs) {
    const pos = [h.lat, h.lon];
    if (out.some((s) => distKm(s.pos, pos) < spacingKm)) continue;
    out.push({ id: `cg:${h.id}`, name: `${countryName(h.country || '')} Coastguard`.trim(), kind: 'cg', chs: CG_CHS, pos, h: ANTENNA.cg, country: h.country });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ the radio
export function createRadio(game, ww, opts = {}) {
  const now = opts.now || (() => Date.now());
  const vts = opts.vts && opts.vts.sectors && opts.vts.unverified ? opts.vts : loadVts(opts.vts || null);
  const coast = opts.coast || coastStationsFrom(opts.harbors || []);
  const listeners = new Map();          // event name → [fn]
  const queue = [];                     // scheduled transmissions {at, fn}
  const known = new Map();              // station id → last station record seen (for ww announcements)
  let lastPush = 0;

  const emit = (name, data) => { for (const fn of listeners.get(name) || []) { try { fn(data); } catch (e) { game.log?.(`[vhf] ${name} listener: ${e.stack || e}`); } } };
  const players = () => [...(game.byId?.values?.() || [])].filter((p) => p && p.online && !p.isActor && p.ship);
  const radioOf = (p) => (p.radio = applySet(p.radio || DEFAULT_RADIO, {}));
  const posOf = (p) => [p.ship.lat, p.ship.lon];
  const inland = (pt) => { try { return !!opts.isInland?.(pt[0], pt[1]); } catch { return false; } };
  const damaged = (p) => { try { return opts.antennaDamaged ? !!opts.antennaDamaged(p) : !!(p.antennaDmg || p.ship?.antennaDmg); } catch { return false; } };
  /** The ship's own numbers for phrases and ww requests. */
  function shipOf(p) {
    let a = null; try { a = opts.airOf?.(p) || null; } catch { a = null; }
    const s = p.ship || {};
    return {
      id: p.id, name: p.name, cls: s.cls, lat: s.lat, lon: s.lon, hdg: s.hdg, spd: s.spd, isPlayer: true,
      ad: a?.ad ?? s.ad ?? p.air?.ad ?? null, need: needOf(a?.need ?? p.air?.need), T: a?.T ?? s.T ?? null, L: a?.L ?? s.L ?? null, B: a?.B ?? s.B ?? null,
      type: a?.type ?? s.type ?? typeKeyOf(s.cls), where: placeOf(posOf(p)), dest: s.destName || p.voyage?.toName || null,
    };
  }
  function placeOf(pt) { try { return opts.placeName?.(pt[0], pt[1]) || 'approach'; } catch { return 'approach'; } }
  const antennaOf = (p) => shipAntenna(shipOf(p).ad);

  // ---------------------------------------------------------------- stations
  function normWw(s, ch) {
    const pos = ptOf(s.pos || s);
    if (!pos) return null;
    const st = {
      id: s.id, name: s.callName || s.name || s.id, kind: s.kind || (s.chambers || s.lock ? 'lock' : 'bridge'), chs: [s.ch ?? s.vhf ?? ch], pos,
      h: s.h || ANTENNA.bridge, hours: s.hours || null, open: typeof s.open === 'boolean' ? s.open : null, bridges: s.bridges || null, lockId: s.lockId || null, ref: s,
    };
    known.set(st.id, st);
    return st;
  }
  function wwOn(ch, pt) {
    if (!ww?.stationsOn) return [];
    let a = []; try { a = ww.stationsOn(ch, pt[0], pt[1]) || []; } catch (e) { game.log?.(`[vhf] stationsOn: ${e.message}`); }
    return a.map((s) => normWw(s, ch)).filter(Boolean);
  }
  function vtsOn(ch) {
    return vts.sectors.filter((s) => s.ch === ch || s.chAlt.includes(ch)).map((s) => ({ id: s.id, name: s.name, kind: 'vts', chs: [s.ch, ...s.chAlt], pos: s.pos, h: ANTENNA.vts, role: s.role }));
  }
  function aiShipsNear(pt, rangeM) {
    let a = [];
    try {
      a = opts.shipsNear ? opts.shipsNear(pt[0], pt[1], rangeM) : (game.traffic?.near?.(pt[0], pt[1], rangeM) || []);
    } catch { a = []; }
    // AIS ships are real vessels: never stations, whatever an adapter hands us
    return a.filter((s) => s && !s.ais && !String(s.id).startsWith('ais')).map((s) => ({ id: s.id, name: s.name, kind: 'ship', chs: AI_CHS, pos: [s.lat, s.lon], h: shipAntenna(s.ad ?? 15), hdg: s.hdg }));
  }
  /** Every station that could be called from pt on channel ch (range not yet applied). */
  function stationsOn(ch, pt) {
    const out = [...wwOn(ch, pt), ...vtsOn(ch)];
    if (CG_CHS.includes(ch)) out.push(...coast.filter((c) => distKm(c.pos, pt) < 150));
    if (AI_CHS.includes(ch)) out.push(...aiShipsNear(pt, 40000));
    try { if (opts.harboursOn) out.push(...(opts.harboursOn(ch, pt[0], pt[1]) || []).map((h) => ({ kind: 'harbour', chs: [ch], h: ANTENNA.harbour, ...h, pos: ptOf(h.pos || h) }))); } catch { /* optional */ }
    return out;
  }
  /** Stations near pt on any channel (bridges, locks, VTS, CG): for call-by-name and the context chips. */
  function stationsAll(pt) {
    const seen = new Map();
    const add = (s) => { if (s && !seen.has(s.id)) seen.set(s.id, s); };
    if (ww?.stationsOn) {
      let any = null; try { any = ww.stationsOn(null, pt[0], pt[1]); } catch { any = null; }   // null = every channel, when lane A supports it
      if (Array.isArray(any) && any.length) any.forEach((s) => add(normWw(s, s.ch ?? s.vhf)));
      else for (const ch of CH_LIST) if (ch !== CH_DSC) wwOn(ch, pt).forEach(add);
    }
    vts.sectors.forEach((s) => add({ id: s.id, name: s.name, kind: 'vts', chs: [s.ch, ...s.chAlt], pos: s.pos, h: ANTENNA.vts, role: s.role }));
    coast.filter((c) => distKm(c.pos, pt) < 150).forEach(add);
    aiShipsNear(pt, 40000).forEach(add);
    return [...seen.values()];
  }
  function openNow(st, t) {
    if (st.open === false) return { open: false, next: null, text: 'closed' };
    if (st.open === true) return { open: true };
    return inHours(st.hours, t);
  }
  /** The VTS sector a point lies in (verified; an unverified polygon maps to its nearest verified sector). */
  function sectorAt(pt) {
    const s = vts.sectors.find((x) => x.role === 'sector' && inPoly(pt, x.poly));
    if (s) return s;
    const u = vts.unverified.find((x) => inPoly(pt, x.poly));
    return u && u.fallback ? vts.sectors.find((x) => x.id === u.fallback) || null : null;
  }
  const inPortArea = (pt) => vts.sectors.some((x) => x.role !== 'sector' && inPoly(pt, x.poly)) || !!sectorAt(pt);

  // ---------------------------------------------------------------- reception
  /** q of a transmission from player p (tx power, inland 1 W rule) at a point with antenna h2. */
  function qFromPlayer(p, ch, pt2, h2) {
    const pt = posOf(p), r = radioOf(p);
    const range = rangeKm({ h1: antennaOf(p), h2, power: effectivePower(ch, r.power, inland(pt)), damaged: damaged(p) });
    return quality(distKm(pt, pt2), range);
  }
  /** q of a station transmission (25 W) at player p. */
  function qFromStation(st, p) {
    const range = rangeKm({ h1: st.h || ANTENNA.bridge, h2: antennaOf(p), power: 'hi', damaged: damaged(p) });
    return quality(distKm(st.pos, posOf(p)), range);
  }
  const r2 = (q) => Math.round(Math.max(0, Math.min(1, q)) * 100) / 100;
  function deliver(p, msg) { game.send(p, msg); }

  /** A transmission by a station on ch: every online player tuned (or dual-watching 16) and in range gets it. */
  function stationTx(st, ch, phrase, args, toP) {
    const at = now();
    for (const q of players()) {
      if (!hears(radioOf(q), ch)) continue;
      const qq = qFromStation(st, q);
      if (qq <= 0) continue;
      deliver(q, { t: 'vhf', ch, from: { id: st.id, name: st.name, kind: st.kind }, to: toP ? { id: toP.id, name: toP.name } : null, phrase, args, text: null, q: r2(qq), at });
    }
    emit('tx', { from: st.id, ch, phrase, args, to: toP?.id || null, at });
  }
  function schedule(delayS, fn) { queue.push({ at: now() + delayS * 1000, fn }); queue.sort((a, b) => a.at - b.at); }
  const reply = (st, ch, toP, phrase, args, extraS = 0) => schedule(replyDelayS(st.id, Math.floor(now() / 60000)) + extraS, () => stationTx(st, ch, phrase, { ship: toP.name, st: st.name, ...args }, toP));

  // ---------------------------------------------------------------- misses and tips
  function miss(p, st, why, ch) {
    const key = st ? st.id : '?';
    const m = p.radioMiss && p.radioMiss.key === key ? p.radioMiss : (p.radioMiss = { key, n: 0 });
    m.n++;
    emit('miss', { player: p.id, station: key, why, n: m.n });
    if (m.n < MISS_TIP_AFTER || !st) return;
    let text;
    if (why === 'channel') text = `No answer from ${st.name} on channel ${ch}. ${st.name} works channel ${st.chs[0]}.`;
    else if (why === 'hours') { const h = openNow(st, now()); text = `${st.name}: out of service hours (${h.text || '—'}).${h.next ? ` Service resumes ${h.next}.` : ''}`; }
    else if (why === 'range') text = `No answer from ${st.name}: out of radio range.`;
    else text = `No answer from ${st.name}.`;
    game.event?.(p, 'info', text, { radio: true });
    emit('tip', { player: p.id, text });
    m.n = 0;
  }

  // ---------------------------------------------------------------- responders
  function etaS(p, st) {
    const d = distKm(posOf(p), st.pos) * 1000, v = Math.max(0.5, Number(p.ship.spd) || 0) * KN_MS;
    return Math.max(60, d / v);
  }
  function bridgeReply(p, st, ch, bridgeId) {
    const ship = shipOf(p);
    let r; try { r = ww.request(bridgeId, ship, etaS(p, st)); } catch (e) { game.log?.(`[vhf] ww.request: ${e.stack || e}`); r = { ok: false, reason: 'error' }; }
    r = r || { ok: false, reason: 'error' };
    const t = now(), tz = st.hours?.tz || 'Europe/Amsterdam';
    const tOpen = absMs(r.tOpen, t);
    const v = r.verdict;
    if (r.reason === 'hours' || v === 'closed' && r.reason !== 'block' && r.reason !== 'out') {
      if (r.night || r.onRequest) return reply(st, ch, p, 'op_br_night', { hhmm: r.next || (tOpen ? hhmm(tOpen, tz) : '?') });
      return miss(p, st, 'hours', ch);                                     // realistic: no answer out of hours
    }
    if (r.reason === 'out') return reply(st, ch, p, 'op_br_out', { hhmm: r.until ? hhmm(absMs(r.until, t), tz) : '?' });
    if (r.reason === 'far') return reply(st, ch, p, 'op_br_far', {});
    if (v === 'under') return reply(st, ch, p, Number.isFinite(r.clrNow) ? 'op_br_under' : 'op_br_under_nc', { clr: r.clrNow });
    if (v === 'never') return reply(st, ch, p, 'op_br_never', { clrO: r.clrOpenNow ?? r.clrO ?? '?', alt: r.alt || altOf(p, st) });
    if (r.reason === 'block' || r.block) return reply(st, ch, p, 'op_br_block', { hhmm: tOpen ? hhmm(tOpen, tz) : r.next || '?', why: r.why || 'rush', where: r.where || 'approach' });
    if (!r.ok) return reply(st, ch, p, 'op_unable', {});
    const inMin = tOpen ? Math.max(1, Math.round((tOpen - t) / 60000)) : 0;
    if (!tOpen || tOpen - t < 30000) return reply(st, ch, p, 'op_br_opening', {});
    return reply(st, ch, p, 'op_br_wait', { in: inMin, hhmm: hhmm(tOpen, tz), n: r.n ?? 1, where: r.where || 'waiting' });
  }
  function altOf(p, st) { try { return opts.altRoute?.(p, st.id) || 'another route'; } catch { return 'another route'; } }
  function lockReply(p, st, ch) {
    const ship = shipOf(p);
    let r; try { r = ww.registerLock(st.id, ship, sideOf(p, st)); } catch (e) { game.log?.(`[vhf] ww.registerLock: ${e.stack || e}`); r = { ok: false, reason: 'error' }; }
    r = r || { ok: false };
    if (r.reason === 'hours') return miss(p, st, 'hours', ch);
    if (!r.ok) return reply(st, ch, p, r.reason === 'fit' ? 'op_lk_nofit' : 'op_unable', { why: r.why || '?' });
    const t = now(), tc = absMs(r.tCycle, t);
    reply(st, ch, p, 'op_lk_queue', { n: r.n ?? 1, chamber: r.chamber ?? 'A', dir: ship.hdg != null ? dirWordOf(ship.hdg) : 'north', in: tc ? Math.max(1, Math.round((tc - t) / 60000)) : 0, side: r.side || 'stbd', where: r.where || 'waiting' });
    if (r.fee > 0) reply(st, ch, p, 'op_lk_fee', { fee: r.fee }, 4);
  }
  function sideOf(p, st) {
    const s = st.ref || {};
    if (Number.isInteger(p.lockSide)) return p.lockSide;
    const axis = s.axis || s.chambers?.[0]?.axis;
    if (Array.isArray(axis) && axis.length === 2) return distKm(posOf(p), axis[0]) <= distKm(posOf(p), axis[1]) ? 0 : 1;
    return null;
  }
  function nearestBridgeOf(p, st) {
    const ids = st.bridges || st.ref?.bridges || [];
    if (!ids.length) return null;
    if (ids.length === 1 || !ww?.statics) return ids[0];
    let best = ids[0], bd = Infinity;
    try {
      const objs = ww.statics(st.pos[0], st.pos[1], 2) || [];
      for (const id of ids) { const o = objs.find((x) => x.id === id); const pt = o?.line ? o.line[Math.floor(o.line.length / 2)] : null; if (pt) { const d = distKm(posOf(p), pt); if (d < bd) { bd = d; best = id; } } }
    } catch { /* first */ }
    return best;
  }
  function trafficNear(p, km = 3) {
    const pt = posOf(p), names = [];
    for (const q of players()) if (q !== p && distKm(pt, posOf(q)) <= km) names.push({ n: q.name, d: distKm(pt, posOf(q)) });
    for (const s of aiShipsNear(pt, km * 1000)) names.push({ n: s.name, d: distKm(pt, s.pos) });
    try { for (const a of opts.aisNear?.(pt[0], pt[1], km * 1000) || []) if (a?.name) names.push({ n: a.name, d: distKm(pt, [a.lat, a.lon]) }); } catch { /* optional */ }
    return names.sort((a, b) => a.d - b.d).slice(0, 3).map((x) => x.n);
  }
  /** The station's answer to a player's phrase (heard, right channel, in hours). */
  function respond(p, st, ch, phrase, args) {
    if (phrase === 'ack' || phrase === 'securite') return;
    if (st.kind === 'cg') {
      if (phrase === 'mayday') return distressFlow(p, st, args.nature);
      if (phrase === 'panpan') return reply(st, CH_DISTRESS, p, 'op_cg_ack', {});
      if (ch === CH_DISTRESS) return reply(st, ch, p, 'op_cg_switch', { y: CH_CG_WORK });
      if (phrase === 'radio_check') return reply(st, ch, p, 'op_cg_check', { q: Math.max(1, Math.round(qFromPlayer(p, ch, st.pos, st.h) * 5)) });
      return reply(st, ch, p, 'op_cg_goahead', {});
    }
    if (st.kind === 'ship') {
      if (ch === CH_DISTRESS) return reply(st, ch, p, 'ai_switch', { y: inland(posOf(p)) ? CH_INLAND : CH_BRIDGE });
      if (phrase === 'pass_port') return reply(st, ch, p, 'ai_pass_port', {});
      if (phrase === 'pass_stbd') return reply(st, ch, p, 'ai_pass_stbd', {});
      if (phrase === 'overtake') return reply(st, ch, p, 'ai_overtake', { side: args.side || 'port' });
      if (phrase === 'radio_check') return reply(st, ch, p, 'ai_check', { q: Math.max(1, Math.round(qFromPlayer(p, ch, st.pos, st.h) * 5)) });
      if (phrase === 'say_again') return;
      return reply(st, ch, p, 'ai_goahead', {});
    }
    if (st.kind === 'vts') {
      if (st.role === 'sector') {
        const sec = sectorAt(posOf(p));
        if (sec && sec.id !== st.id) return reply(st, ch, p, 'op_vts_redirect', { x: sec.name, y: sec.ch });
      }
      if (phrase === 'vts_report') return reply(st, ch, p, 'op_vts_ack', { dir: args.dir, dest: args.dest, traffic: trafficNear(p) });
      return reply(st, ch, p, 'op_vts_goahead', {});
    }
    if (st.kind === 'bridge') {
      if (phrase === 'req_open' || phrase === 'req_lock') return bridgeReply(p, st, ch, st.id);
      return reply(st, ch, p, 'op_hm_goahead', {});
    }
    if (st.kind === 'lock') {
      if (phrase === 'req_lock') return lockReply(p, st, ch);
      if (phrase === 'req_open') { const b = nearestBridgeOf(p, st); return b ? bridgeReply(p, st, ch, b) : lockReply(p, st, ch); }
      return reply(st, ch, p, 'op_hm_goahead', {});
    }
    return reply(st, ch, p, 'op_hm_goahead', {});
  }

  // ---------------------------------------------------------------- distress
  function nearestCg(pt) {
    let best = null, bd = Infinity;
    for (const c of coast) { const d = distKm(c.pos, pt); if (d < bd) { bd = d; best = c; } }
    return best || { id: 'cg:generic', name: 'Coastguard', kind: 'cg', chs: CG_CHS, pos: pt, h: ANTENNA.cg };
  }
  function distressFlow(p, cg, nature) {
    const pt = posOf(p), t = now();
    reply(cg, CH_DISTRESS, p, 'op_cg_mayday', {});
    if (p.isActor) return;
    const text = `Mayday relay: ${p.name} reports ${nature && nature !== 'undesignated' ? String(nature).replace(/_/g, ' ') : 'distress'} at ${pt[0].toFixed(2)}, ${pt[1].toFixed(2)}. ${cg.name} coordinating.`;
    try { game.broadcast?.({ t: 'chat', from: 'Coastguard', id: 'sys', text, time: t }); } catch { /* */ }
    emit('sar_alert', { player: p.id, name: p.name, lat: pt[0], lon: pt[1], nature: nature || 'undesignated', cg: cg.id, at: t });
  }

  // ---------------------------------------------------------------- target resolution
  function resolveTarget(p, to, ch) {
    if (to == null || to === '') return null;
    const key = typeof to === 'object' ? to.id : String(to);
    const lc = String(typeof to === 'object' ? (to.name || to.id) : to).trim().toLowerCase();
    for (const q of players()) if (q !== p && (q.id === key || q.name.toLowerCase() === lc)) return { kind: 'player', p: q, id: q.id, name: q.name };
    const pt = posOf(p);
    const pool = [...stationsOn(ch, pt), ...stationsAll(pt)];
    // by id, else by name: several stations can share a name ("Netherlands Coastguard") → the nearest one on this channel first
    const byName = pool.filter((s) => String(s.name).toLowerCase() === lc)
      .sort((a, b) => (b.chs.includes(ch) - a.chs.includes(ch)) || distKm(pt, a.pos) - distKm(pt, b.pos));
    const st = pool.find((s) => s.id === key) || byName[0];
    return st ? { kind: 'station', st, id: st.id, name: st.name } : null;
  }

  // ---------------------------------------------------------------- the API
  const api = {
    vts, coast, sectorAt, inPortArea,
    on(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); return api; },
    /** vhf_set. */
    set(p, m = {}) {
      const before = radioOf(p);
      p.radio = applySet(before, m);
      if (!(m.ch == null || isVoice(Number(m.ch)))) game.event?.(p, 'info', `Channel ${m.ch} is DSC only — no voice.`, { radio: true });
      if (p.radio.open) api.pushStations(p);
      return p.radio;
    },
    /** you.radio */
    youFields(p) {
      const r = radioOf(p), pt = p.ship ? posOf(p) : null, inl = pt ? inland(pt) : false;
      return { on: r.on, ch: r.ch, dual: r.dual, power: r.power, powerEff: effectivePower(r.ch, r.power, inl), inland: inl, lang: r.lang, vol: r.vol, dmg: damaged(p) };
    },
    /** Station list on the tuned channel + context rows (any channel, ≤ 3 km) for the panel. */
    stationsFor(p) {
      const r = radioOf(p), pt = posOf(p), t = now(), ch = r.ch;
      const rows = [];
      for (const st of stationsOn(ch, pt)) {
        const q = qFromStation(st, p);
        if (q <= 0) continue;
        const h = openNow(st, t);
        rows.push({ id: st.id, name: st.name, kind: st.kind, ch, q: r2(q), bars: bars(q), silent: !h.open, why: h.open ? null : `out of hours${h.next ? ` until ${h.next}` : ''}` });
      }
      for (const q of players()) {
        if (q === p || !hears(radioOf(q), ch)) continue;
        const qq = qFromPlayer(p, ch, posOf(q), antennaOf(q));
        if (qq > 0) rows.push({ id: q.id, name: q.name, kind: 'player', ch, q: r2(qq), bars: bars(qq), silent: false, why: null });
      }
      rows.sort((a, b) => b.q - a.q);
      const near = [];
      for (const st of stationsAll(pt)) {
        if (st.kind !== 'bridge' && st.kind !== 'lock') continue;
        const d = distKm(pt, st.pos);
        if (d <= NEAR_KM) near.push({ id: st.id, name: st.name, kind: st.kind, ch: st.chs[0], distKm: Math.round(d * 100) / 100, silent: !openNow(st, t).open });
      }
      near.sort((a, b) => a.distKm - b.distKm);
      const sec = sectorAt(pt);
      return { ch, stations: rows.slice(0, 24), near: near.slice(0, 4), sector: sec ? { id: sec.id, name: sec.name, ch: sec.ch } : null, fallbackCh: inPortArea(pt) ? vts.fallbackCh : null };
    },
    pushStations(p) { if (!p.isActor) game.send(p, { t: 'vhf_st', ...api.stationsFor(p) }); },
    /** vhf_tx → { ok, why?, to? } */
    tx(p, m = {}) {
      const r = radioOf(p), t = now();
      if (!r.on) return { ok: false, why: 'off' };
      if (!p.ship) return { ok: false, why: 'noship' };
      if (m.ch != null && Number(m.ch) !== r.ch) { if (!isVoice(Number(m.ch))) return { ok: false, why: 'channel' }; p.radio = applySet(r, { ch: Number(m.ch) }); }
      const ch = p.radio.ch;
      const free = typeof m.text === 'string' && m.text.trim() !== '';
      const gap = free ? RATE.textMs : RATE.phraseMs;
      if (p.radioLastTx && t - p.radioLastTx < gap) return { ok: false, why: 'rate' };
      let text = null, phrase = null;
      if (free) {
        text = String(m.text).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, RATE.textMax).trim();
        try { if (opts.clean) text = opts.clean(text); } catch { /* keep */ }
        if (!text) return { ok: false, why: 'empty' };
      } else {
        phrase = String(m.phrase || '');
        if (!isPlayerPhrase(phrase)) return { ok: false, why: 'phrase' };
      }
      p.radioLastTx = t;
      const target = resolveTarget(p, m.to, ch);
      const user = m.args && typeof m.args === 'object' ? m.args : {};
      const args = phrase ? autoArgs(shipOf(p), { dest: clip(user.dest), side: user.side === 'stbd' ? 'stbd' : user.side === 'port' ? 'port' : null, nature: clip(user.nature), pob: Number.isFinite(+user.pob) ? Math.max(1, Math.min(9999, Math.round(+user.pob))) : null }) : {};
      if (phrase) args.to = target ? target.name : (clip(typeof m.to === 'string' ? m.to : null) || 'All stations');
      const msg = { t: 'vhf', ch, from: { id: p.id, name: p.name, kind: 'player' }, to: target ? { id: target.id, name: target.name } : null, phrase, args, text, at: t };
      // 1. receivers: players with the channel tuned (or 16 on dual watch) and in range; the sender gets the echo
      deliver(p, { ...msg, q: 1, self: true });
      for (const q of players()) {
        if (q === p || !hears(radioOf(q), ch)) continue;
        const qq = qFromPlayer(p, ch, posOf(q), antennaOf(q));
        if (qq > 0) deliver(q, { ...msg, q: r2(qq) });
      }
      emit('tx', { from: p.id, ch, phrase, args, text, to: target?.id || null, at: t });
      // 2. responders
      if (phrase === 'mayday' && (!target || target.st?.kind === 'cg') && (ch === CH_DISTRESS)) { distressFlow(p, target?.st || nearestCg(posOf(p)), args.nature); return { ok: true, to: target?.id || null }; }
      if (phrase === 'panpan' && !target && ch === CH_DISTRESS) { const cg = nearestCg(posOf(p)); if (qFromPlayer(p, ch, cg.pos, cg.h) > 0) reply(cg, ch, p, 'op_cg_ack', {}); return { ok: true, to: null }; }
      if (!target || target.kind !== 'station' || !phrase) return { ok: true, to: target?.id || null };
      const st = target.st;
      if (!st.chs.includes(ch)) { miss(p, st, 'channel', ch); return { ok: true, to: st.id, answered: false, why: 'channel' }; }
      if (qFromPlayer(p, ch, st.pos, st.h) <= 0) { miss(p, st, 'range', ch); return { ok: true, to: st.id, answered: false, why: 'range' }; }
      if (!openNow(st, t).open) { miss(p, st, 'hours', ch); return { ok: true, to: st.id, answered: false, why: 'hours' }; }
      p.radioMiss = null;
      respond(p, st, ch, phrase, args);
      return { ok: true, to: st.id, answered: true };
    },
    /** dsc {kind, nature} */
    dsc(p, m = {}) {
      const kind = m.kind === 'urgency' || m.kind === 'safety' ? m.kind : 'distress';
      const t = now();
      if (p.radioLastDsc && t - p.radioLastDsc < RATE.dscMs) return { ok: false, why: 'rate' };
      p.radioLastDsc = t;
      const pt = posOf(p), cg = nearestCg(pt), nature = clip(m.nature) || 'undesignated';
      const args = { me: p.name, kind, pos: pt, nature };
      // every set with power on decodes the DSC alert (ch 70 is watched permanently), in range of the sender
      for (const q of players()) {
        if (q !== p && !radioOf(q).on) continue;
        const qq = q === p ? 1 : qFromPlayer(p, CH_DSC, posOf(q), antennaOf(q));
        if (qq > 0) deliver(q, { t: 'vhf', ch: CH_DSC, from: { id: p.id, name: p.name, kind: 'player' }, to: null, phrase: 'dsc_alert', args, text: null, q: r2(qq), at: t, dsc: kind, self: q === p || undefined });
      }
      if (kind === 'distress') distressFlow(p, cg, nature);
      else reply(cg, CH_DISTRESS, p, 'op_cg_ack', {});
      return { ok: true, cg: cg.id };
    },
    /** Announcements from the waterworks state machines (lane A `ww.onEvent`). */
    announce(ev) {
      const e = ev || {};
      const st = known.get(e.id) || known.get(e.lockId) || (e.callName ? { id: e.id, name: e.callName, kind: e.kind || 'bridge', chs: [e.ch ?? e.vhf], pos: ptOf(e.pos) || [0, 0], h: ANTENNA.bridge } : null);
      if (!st || !isVoice(st.chs[0])) return;
      const ch = st.chs[0];
      const ids = Array.isArray(e.ships) ? e.ships : Array.isArray(e.plan) ? e.plan.map((x) => x.ship ?? x.id) : [];
      const ps = ids.map((id) => game.byId?.get?.(id)).filter((p) => p && p.online && !p.isActor);
      const type = e.type || e.kind || e.st;
      const one = (phrase, args) => schedule(1, () => stationTx(st, ch, phrase, { st: st.name, ...args }, null));
      const each = (phrase, argsOf) => ps.forEach((p, i) => schedule(1 + i * 2, () => stationTx(st, ch, phrase, { ship: p.name, st: st.name, ...(argsOf ? argsOf(p, i) : {}) }, p)));
      switch (type) {
        case 'opening': return each('op_br_opening');
        case 'closed': return ps.length ? one('op_br_closed', {}) : undefined;
        case 'missed': return each('op_br_missed');
        case 'admit': return each('op_lk_enter', (p) => { const pl = (e.plan || []).find((x) => (x.ship ?? x.id) === p.id) || {}; return { side: pl.side || 'stbd', slot: Math.round(pl.x ?? pl.slot ?? 0), head: pl.head || 'upper' }; });
        case 'closing': return one('op_lk_closing', {});
        case 'levelling': return one('op_lk_level', { dh: e.dh ?? e.dh0 ?? 0, min: Math.max(1, Math.round((e.dur ?? 60) / 60)) });
        case 'release': case 'opening_gates': return one('op_lk_leave', {});
        case 'lost': return each('op_lk_lost');
        default: return undefined;
      }
    },
    /** Deliver scheduled replies; push station lists to open sets every 3 s. */
    tick() {
      const t = now();
      while (queue.length && queue[0].at <= t) { const it = queue.shift(); try { it.fn(); } catch (e) { game.log?.(`[vhf] reply: ${e.stack || e}`); } }
      if (t - lastPush >= ST_PUSH_MS) {
        lastPush = t;
        for (const p of players()) if (p.radio?.open && p.radio.on) { try { api.pushStations(p); } catch (e) { game.log?.(`[vhf] stations: ${e.message}`); } }
      }
    },
    pending: () => queue.length,
    /** Action router for game.onAction: returns true when the action was a radio action. */
    onAction(p, m) {
      switch (m.action) {
        case 'vhf_set': api.set(p, m); game.sendYou?.(p); return true;
        case 'vhf_tx': { const r = api.tx(p, m); if (!r.ok && r.why === 'rate') game.event?.(p, 'info', 'Radio: wait a moment before transmitting again.', { radio: true }); return true; }
        case 'dsc': { const r = api.dsc(p, m); if (r.ok) game.event?.(p, 'warn', `DSC ${m.kind || 'distress'} alert sent. Stay on channel 16.`, { radio: true }); return true; }
        default: return false;
      }
    },
  };
  if (ww?.onEvent) { try { ww.onEvent((a, b) => api.announce(typeof a === 'string' ? { type: a, ...(b || {}) } : a)); } catch (e) { game.log?.(`[vhf] ww.onEvent: ${e.message}`); } }
  return api;
}
/** lane A's airDraftNow gives `need(Hs)` as a function; `you.air.need` is a number. Hs 0 here: ww adds the heave itself. */
function needOf(n) { try { return typeof n === 'function' ? n(0) : Number.isFinite(n) ? n : null; } catch { return null; } }
function clip(s) { return typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 40).trim() || null : null; }
