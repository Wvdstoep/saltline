// Mooring in inland harbours and marinas (player report: "inland harbours show no docks"), the game side. The rules
// are shared/mhgeo.js (boxes, side berths, fees, services), the geometry is server/minorharbours.js geoOf (OSM pontoons
// or pontoons laid on the water from the tiles). Every function takes the Game (server/game.js) and a player.
//
//   mhNearBerth(game, p)  you.nearBerth for a box / visitor berth within 1.5 km (the berth guidance outline + card)
//   mhDock(game, p)       T / Moor: make fast in the box or at the side berth within 60 m (< 2 kn); first night paid
//   (cast off)            server/quaygame.js quayUndock — the berth is a dock-anywhere berth (`quay: true`, `mh: id`):
//                         the rest of the stay is paid, the ship starts 20 m out on the water side
//   (services)            server/quaygame.js quayGate → shared/mhgeo.js mhDenies / mhSurcharge (the harbour's own fuel
//                         berth / yard / market on top of the named harbour's dock-anywhere tier)
//
// The mooring is an ordinary docking at the LINKED named harbour (p.docked = its id) like a dock-anywhere quay, so the
// harbour sheet, fleet office, warp rules and saving work unchanged; p.berth.mh says which minor harbour.
import { SHIP_CLASSES } from '../shared/constants.js';
import { haversine, bearing } from '../shared/geo.js';
import { QUAY } from '../shared/quayrules.js';
import { MHG, boxWhy, sideWhy, moorPoint, sideSlot, mhServices, linkOf, feeFor, tierWord } from '../shared/mhgeo.js';
import { shipDimsOf } from './minorharbours.js';
import { pickGuideBerth } from './berthguide.js';
import { HARBORS } from './harbors.js';

const fmt = (n) => Math.round(n).toLocaleString('en-US');
const round1 = (v) => Math.round(v * 10) / 10;

/** Ship dimensions for the rules: the model when known (shipDimsOf), else the class row. */
export function dimsOf(cls) {
  const d = shipDimsOf(cls), C = SHIP_CLASSES[cls] || SHIP_CLASSES.coaster;
  return { ...d, L: d.L || C.length, B: d.B || C.beam, T: d.T || C.draft, disp: d.disp || C.displacement || 0, yacht: d.yacht ?? C.length <= 30 };
}
/** Boats moored in a minor harbour (other skippers): berth id → [{ id, B }]. */
export function occupantsOf(game, mhId, except = null) {
  const out = new Map();
  for (const q of game.byId?.values?.() || []) {
    if (q === except || !q.berth?.mh || q.berth.mh !== mhId) continue;
    const C = SHIP_CLASSES[q.ship?.cls] || {};
    const arr = out.get(q.berth.id) || []; arr.push({ id: q.id, B: C.beam || 3 }); out.set(q.berth.id, arr);
  }
  return out;
}
/** Every berth of the harbours within rKm, with where this ship would lie and why it would not fit: [{ h, e, b, at, why }]. */
export function berthsNear(game, p, rKm) {
  const s = p.ship, d = dimsOf(s.cls), out = [];
  let hs = []; try { hs = game.mh.near(s.lat, s.lon, rKm).filter((h) => h.tier !== 'ferry').slice(0, 4); } catch { hs = []; }
  for (const h of hs) {
    const e = game.mh.geoOf(h.id); if (!e?.geo || !e.berths?.list?.length) continue;
    const depth = game.mh.depthFor(e.geo), occ = occupantsOf(game, h.id, p);
    for (const b of e.berths.list) {
      if (b.est) continue;                                         // place-count berths (no geometry): nowhere to lie
      if (b.kind === 'box') {
        const at = moorPoint(b, d);
        out.push({ h, e, b, at, why: boxWhy(e.geo, b, d, { depth, occupied: occ.has(b.id) }) });
      } else if (b.a && b.b) {
        const rafted = occ.get(b.id) || [];
        const at = sideSlot(b, s, d, { rafted, quay: b.src === 'quay' });
        out.push({ h, e, b, at, why: sideWhy(e.geo, b, d, { depth, rafted: rafted.length }) });
      }
    }
  }
  return out;
}
const berthName = (b) => (b.kind === 'box' ? `Box ${b.no}` : b.src === 'quay' ? 'Visitor quay' : b.raft ? 'Visitor pontoon' : 'Pontoon');

/**
 * you.nearBerth for an inland harbour: the nearest fitting free box / side berth within MHG.GUIDE_KM (sticky like the
 * harbour berths), else the nearest with `why`. null when there is none. Shape = game.nearBerthFor plus { mh: true, fee }.
 */
export function mhNearBerth(game, p) {
  if (!game.mh || p.docked || !p.ship) return null;
  const s = p.ship;
  const rows = berthsNear(game, p, MHG.GUIDE_KM);
  if (!rows.length) return null;
  const byKey = new Map(rows.map((r) => [r.b.id, r]));
  const prevId = p.mhGuide?.harbor ? p.mhGuide.id : null;
  let g = null;
  try {
    g = pickGuideBerth({ berths: rows.map((r) => ({ id: r.b.id, lat: r.at.lat, lon: r.at.lon, hdg: r.at.hdg })), lat: s.lat, lon: s.lon, why: (b) => byKey.get(b.id)?.why || null, prevId, spdKn: Math.abs(s.spd || 0) });
  } catch { g = null; }
  if (!g || !(g.distM <= MHG.GUIDE_KM * 1000)) return null;
  const r = byKey.get(g.berth.id), h = r.e.geo, d = dimsOf(s.cls), link = linkOf(h, HARBORS);
  if (g.fits) p.mhGuide = { harbor: h.id, id: r.b.id };
  const fee = feeFor(h, d, link), depth = game.mh.depthFor(h);
  return {
    id: r.b.id, name: `${berthName(r.b)} · ${h.name}`, harbor: h.id, harborName: h.name, mh: true, tier: h.tier, tierLabel: tierWord(h),
    distM: Math.round(g.distM), brg: Math.round(bearing(s.lat, s.lon, r.at.lat, r.at.lon)), hdg: Math.round(r.at.hdg), lat: r.at.lat, lon: r.at.lon,
    depth: depth.m, depthSrc: depth.src, water: depth.m, length: r.b.kind === 'box' ? r.b.len : Math.round(r.b.lenM), kind: r.b.kind, box: r.b.kind === 'box' ? { no: r.b.no, len: r.b.len, w: r.b.w } : null,
    fits: g.fits, why: g.why || null, contract: false, fee: fee.perNight, feeText: fee.perNight ? `${fmt(fee.perNight)} cr per night (${fee.basis})` : 'no fee',
  };
}

/** The berth record of a minor-harbour mooring (saved with the player like a dock-anywhere berth). */
function berthRecord(game, p, r, link, fee, paid) {
  const h = r.e.geo, d = dimsOf(p.ship.cls), svc = mhServices(h, link.tier);
  return {
    quay: true, v: QUAY.VERSION, mh: h.id, mhName: h.name, mhTier: h.tier, kind: r.b.kind, id: r.b.id, run: null, no: r.b.no ?? null,
    name: `${berthName(r.b)} · ${h.name}`, cls: r.b.kind === 'box' ? 'marina' : 'pontoon', harbor: link.harbor ? link.harbor.id : null,
    tier: link.tier, hdKm: link.dKm, lat: r.at.lat, lon: r.at.lon, hdg: r.at.hdg, wb: r.at.wb, off: 0,
    depth: game.mh.depthFor(h).m, length: r.b.kind === 'box' ? r.b.len : Math.round(r.b.lenM), slotLen: round1(d.L), perDay: fee.perNight, feeBasis: fee.basis,
    paid: paid || 0, since: game.simTime, svc, yacht: !!d.yacht,
  };
}

/**
 * T / Moor near an inland harbour: make fast in the nearest box / side berth within MHG.MOOR_M (60 m) of where the hull would
 * lie, under MHG.MOOR_KN. Returns false when no such berth is near (the caller carries on with harbour berths and quays),
 * true when it handled the request (moored, or told the skipper why not).
 */
export function mhDock(game, p) {
  if (!game.mh || p.docked || p.assist || !p.ship || p.flooding >= 1 || p.rescue) return false;
  const s = p.ship;
  const rows = berthsNear(game, p, 0.6).map((r) => ({ ...r, dist: haversine(s.lat, s.lon, r.at.lat, r.at.lon) })).filter((r) => r.dist <= MHG.MOOR_M).sort((a, b) => a.dist - b.dist);
  if (!rows.length) return false;
  const pick = rows.find((r) => !r.why && r.b.id === p.mhGuide?.id) || rows.find((r) => !r.why) || null;   // the guided box first
  if (!pick) { game.event(p, 'warn', rows[0].why); return true; }
  if (Math.abs(s.spd || 0) > MHG.MOOR_KN) { game.event(p, 'warn', `Slow below ${MHG.MOOR_KN} kn to make fast in ${berthName(pick.b).toLowerCase()}.`); return true; }
  if (p.hail) { game.event(p, 'law', 'Nobody takes your lines: the coast guard has ordered you to heave to first.'); return true; }
  const h = pick.e.geo, d = dimsOf(s.cls), link = linkOf(h, HARBORS), fee = feeFor(h, d, link);
  if (link.harbor && game.politics) { const e = game.politics.entryCheck(p, link.harbor); if (e.refuse) { game.event(p, 'law', e.text); return true; } }
  if (p.money < fee.perNight) { game.event(p, 'warn', `${h.name} wants the first night (${fmt(fee.perNight)} cr) when your lines go ashore. You have ${fmt(p.money)} cr.`); return true; }
  game.dropWarp?.(p, 'Alongside.', false);
  s.lat = pick.at.lat; s.lon = pick.at.lon; s.hdg = pick.at.hdg;
  p.lastValid = { lat: s.lat, lon: s.lon };
  const paid = Math.min(fee.perNight, Math.max(0, p.money));
  const berth = berthRecord(game, p, pick, link, fee, paid);
  game.setDocked(p, link.harbor ? link.harbor.id : null, berth);
  p.money = Math.max(0, p.money - paid);
  p.mhGuide = null;
  if (p.cond > 0) p.flooding = 0;
  game.event(p, 'info', `Moored: ${berth.name} (${tierWord(h).toLowerCase()}). ${fee.perNight ? `${fmt(fee.perNight)} cr per night — first night paid (${fmt(paid)} cr), the rest when you cast off.` : 'No berth fee.'}`);
  const sv = berth.svc, have = [sv.water && 'water', sv.power && 'power', sv.fuel != null && (sv.from?.fuel === 'minor' && !(sv.fuel > 1) ? 'fuel berth' : 'fuel by truck'), sv.repair != null && 'repairs', sv.market && 'market'].filter(Boolean);
  game.event(p, 'info', have.length ? `${h.name}: ${have.join(', ')}.` : `${h.name}: no services here — only the berth.`);
  // lessons: "moor in a box" drill (server/inlandjobs.js INLAND_LESSON_TASKS.box)
  if (berth.kind === 'box') for (const j of p.jobs || []) { const st = j.steps?.[j.prog?.i]; if (st?.k === 'drill' && st.action === 'box_moor') { try { game.jobsx?.advance?.(p, j, { kind: 'action' }); } catch { /* lesson bookkeeping only */ } } }
  game.sendYou(p);
  game.send(p, { t: 'mh_moored', id: h.id, berth: berth.id });
  return true;
}
/** Is this berth a minor-harbour berth? (quayUndock wording) */
export const isMhBerth = (b) => !!(b && b.quay && b.mh);
