// Cruise ship decks → GPlan (docs/CRUISE-CONTRACT.md §4). shared/ships/cruiselayout.js decides WHAT each deck holds (rooms,
// doors, voids); this module turns that spec into rooms, doors, windows, rails and the boat-deck gear of a GPlan, so the
// walker, the v2 kits and the renderer see ordinary rooms. Only used for interiors v2 (opts.iv2 from gaplan2.js planV2); the
// v1 pax planner (gaplan.js paxDeckPlan) stays as the ?iv2=0 fallback.
import { cruiseDeck } from '../../shared/ships/cruiselayout.js';

const r2 = (v) => Math.round(v * 100) / 100;

/** Build deck `d` of cruise ship `ga` into P; `tw` = Map(tower id → tower room). → the rooms made (deckRooms). */
export function cruiseDeckPlan(P, ga, d, tw) {
  const spec = cruiseDeck(ga, d.id);
  if (!spec) return [];
  const made = new Map(), out = [];
  for (const s of spec.rooms) {
    const o = { id: s.id, kind: s.kind, use: s.use, space: s.space, name: s.name, x0: s.x0, x1: s.x1, z0: s.z0, z1: s.z1, y: d.y, h: s.h ?? d.h, floor: s.floor, wall: s.wall, deck: d.id };
    if (s.venue) o.venue = s.venue;
    if (s.open) { o.open = true; o.drawFloor = true; if (s.inset) o.inset = s.inset; }
    if (s.walk === false) o.walk = false;
    if (s.kind === 'cabin') o.berth = 1;
    if (s.cat) o.cat = s.cat;
    if (s.tall) o.tall = s.tall;
    if (s.atriumIndex != null) o.atriumIndex = s.atriumIndex;
    const r = P.room(o);
    for (const w of s.win) P.window(r, w.side, w.from, w.to, w.bottom, w.top);
    if (s.balcony) P.prop('balcony', { x: s.balcony.side < 0 ? s.x0 : s.x1, y: d.y, z0: s.balcony.z0, z1: s.balcony.z1, side: s.balcony.side, d: 1.4 });
    made.set(s.id, r); out.push(r);
  }
  for (const dd of spec.doors) {
    const a = made.get(dd.a), b = dd.b ? made.get(dd.b) : null; if (!a || (dd.b && !b)) continue;
    if (dd.kind === 'open') P.opening(a, b, dd.side, dd.at, dd.w); else P.door(a, b, dd.side, dd.at, dd.w, dd.h, dd.kind);
  }
  // the tower ends: through the walkway column of the stairwell (as gaplan.js paxDeckPlan link)
  for (const l of spec.links) {
    const r = made.get(l.room), t = tw.get(l.tower); if (!r || !t) continue;
    const z = l.end === 'n' ? r.z0 : r.z1;
    if (Math.abs((l.end === 'n' ? t.z1 : t.z0) - z) > 0.02) continue;
    const lo = Math.max(r.x0, t.x0), hi = Math.min(r.x1, t.x1);
    if (hi - lo < 1.0) continue;
    const wx0 = t.x0 + 1.5, wx1 = t.x1 - 2.0, a = Math.max(lo, wx0) + 0.1, b = Math.min(hi, wx1) - 0.1;
    if (b - a >= 0.9) P.opening(r, t, l.end, r2((a + b) / 2), r2(Math.min(2.4, b - a)));
    else if (hi - lo >= 1.05) P.door(r, t, l.end, r2((lo + hi) / 2), r2(Math.min(0.95, hi - lo - 0.1)));
  }
  for (const pts of spec.rails) P.rail(pts, d.y);
  // the boat deck: lifeboats along both sides, muster stations
  if (ga.pax.boatDeck === d.id) for (const b of ga.deck.boats.filter((q) => q.deck === d.id)) {
    P.prop('lifeboat', { kind: b.kind, x: b.x, y: b.y, z: b.z, len: b.kind === 'davit' ? Math.min(14, ga.L * 0.04) : 3, side: b.side });
    const pr = P.openAt(b.side * (Math.abs(b.x) - 1.9), b.z, d.y);
    if (pr && b.kind === 'davit') P.hot('muster', 'Lifeboat muster station', b.side * (Math.abs(b.x) - 2.4), d.y, b.z, 1.3);
  }
  return out;
}
