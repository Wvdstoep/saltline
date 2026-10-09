// Inland harbours and marinas in 3D — pure geometry (no three.js, no DOM; test/inland-3d.test.mjs imports it). Built
// from a geo record (GET /api/mh/geo, shared/mhgeo.js geoRecord) with the same layout the server moors against
// (shared/mhgeo.js layoutOf): floating pontoons with their finger piers, piles holding them, gangways to the bank, quay
// walls with bollards, the harbour-master hut with its flag on the bank, the fuel berth. public/js/mharbour.js wraps the
// arrays into meshes, places them and adds the sprites (sign, box numbers).
//
// Frame: metres from the anchor (wwgeom.js llToLocal: x east, z south), y up. Two meshes:
//   float  — pontoons / fingers / fuel pump, y = 0 at the water surface (the group rides the water level);
//   fixed  — piles, gangways, quay walls, hut, flag, y = 0 at model MSL (the tiles' datum).
import { Geo, pbox, beam, cyl, llToLocal } from './wwgeom.js';
import { layoutOf, MHG } from '../../shared/mhgeo.js';

export const MHLOD = { NONE: 0, MID: 1, FULL: 2 };
const hex = (h) => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
export const MHCOL = {
  deck: hex(0xb9b2a4), deckEdge: hex(0x8d877b), float: hex(0x3c4248), finger: hex(0xaaa395), pile: hex(0x3a3632), pileCap: hex(0xe8e8e0),
  quay: hex(0xb3aea4), quayDk: hex(0x7f7a72), bollard: hex(0x2a2a2a), house: hex(0xe7e1d2), roof: hex(0x2f5d8a), door: hex(0x5a3f2a), glass: hex(0x2b4250),
  pole: hex(0xf2f2f2), flag: hex(0xff7a1a), fuel: hex(0xc0392b), pump: hex(0xe8c440), gang: hex(0x7d7464), rail: hex(0x9a958c),
};
/** Rough triangle counts per LOD (planning before a build). */
export function estTris(geo, lod) {
  const np = (geo.pont || []).length, nq = (geo.quay || []).length, places = Number(geo.cap ?? geo.places) || 40;
  if (lod === MHLOD.NONE) return 0;
  return lod === MHLOD.MID ? 24 * np + 12 * nq + places * 6 + 60 : 36 * np + 60 * nq + places * 60 + 400;
}
const unit = (a, b) => { const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1; return { t: [dx / L, dz / L], L }; };

/**
 * Build the meshes of one harbour. opts: { lod, anchor {lat, lon} (default the harbour point), heightAt(lat, lon) → ground y | null,
 * lay (a layoutOf result to reuse) }. → { float, fixed, labels: [{ kind, text, pos: [x, y, z], fixed }], tris, lay, anchor }
 */
export function buildMinorHarbour(geo, opts = {}) {
  const lod = opts.lod ?? MHLOD.FULL, anchor = opts.anchor || { lat: geo.lat, lon: geo.lon };
  const lay = opts.lay || layoutOf(geo);
  const L = (p) => llToLocal(anchor, p[0], p[1]);
  const ground = (p, d = 1.2) => { const v = opts.heightAt ? opts.heightAt(p[0], p[1]) : null; return Number.isFinite(v) ? Math.max(0.3, Math.min(6, v)) : d; };
  const F = new Geo(), X = new Geo(), labels = [];
  const full = lod >= MHLOD.FULL;
  // ---- floating pontoons: a dark float body, the deck slab on top (lighter edge strips at full detail)
  for (const d of lay.decks) {
    const a = L(d.a), b = L(d.b), { t, L: len } = unit(a, b), cx = (a[0] + b[0]) / 2, cz = (a[1] + b[1]) / 2, hw = d.w / 2;
    pbox(F, cx, cz, t, len / 2, hw - 0.1, -0.35, 0.26, MHCOL.float, ['-v']);
    pbox(F, cx, cz, t, len / 2 + 0.05, hw, 0.26, 0.42, MHCOL.deck, ['-v']);
    if (full) for (const s of [-1, 1]) pbox(F, cx - t[1] * s * (hw - 0.08), cz + t[0] * s * (hw - 0.08), t, len / 2, 0.08, 0.42, 0.47, MHCOL.deckEdge, ['-v']);
  }
  for (const f of lay.fingers) {
    const a = L(f.a), b = L(f.b), { t, L: len } = unit(a, b), cx = (a[0] + b[0]) / 2, cz = (a[1] + b[1]) / 2;
    pbox(F, cx, cz, t, len / 2, f.w / 2, full ? -0.2 : 0.05, 0.36, MHCOL.finger, ['-v']);
  }
  // ---- piles (box posts, guide piles) — full detail only
  if (full) for (const p of lay.piles) { const [x, z] = L(p); cyl(X, x, z, 0.17, -1.5, 2.7, 7, MHCOL.pile, false); cyl(X, x, z, 0.19, 2.7, 2.85, 7, MHCOL.pileCap, true); }
  // ---- gangways from the pontoon roots to the bank
  for (const g of lay.gang) {
    const a = L(g.a), b = L(g.b), yb = ground(g.b, 1.4);
    beam(X, [a[0], 0.5, a[1]], [b[0], yb + 0.15, b[1]], g.w, 0.18, MHCOL.gang);
    if (full) for (const s of [-1, 1]) { const { t } = unit(a, b), o = [-t[1] * s * (g.w / 2), t[0] * s * (g.w / 2)]; beam(X, [a[0] + o[0], 1.45, a[1] + o[1]], [b[0] + o[0], yb + 1.1, b[1] + o[1]], 0.06, 0.06, MHCOL.rail); }
  }
  // ---- quay walls with bollards
  for (const q of lay.quays) {
    const a = L(q.a), b = L(q.b), { t, L: len } = unit(a, b), cx = (a[0] + b[0]) / 2, cz = (a[1] + b[1]) / 2;
    pbox(X, cx, cz, t, len / 2, q.w / 2, -2, 1.3, MHCOL.quay, ['-v']);
    if (full) {
      pbox(X, cx, cz, t, len / 2, 0.15, 1.3, 1.45, MHCOL.quayDk, ['-v']);
      const n = Math.floor(len / 12);
      for (let i = 1; i < n; i++) { const s = -len / 2 + (len * i) / n; cyl(X, cx + t[0] * s, cz + t[1] * s, 0.18, 1.3, 1.85, 8, MHCOL.bollard, true); }
    }
  }
  // ---- harbour-master hut with a flag, on the bank
  if (lay.hut) {
    const [x, z] = L([lay.hut.lat, lay.hut.lon]), y = ground([lay.hut.lat, lay.hut.lon], 1.2), yaw = (lay.hut.hdg || 0) * Math.PI / 180;
    const t = [Math.sin(yaw), -Math.cos(yaw)];               // facing direction in x / z (north = −z)
    const side = [-t[1], t[0]];
    pbox(X, x, z, side, 3.2, 2.2, y - 0.6, y + 2.8, MHCOL.house);
    // gable roof (ridge along the side axis)
    const r0 = y + 2.8, r1 = y + 4.1, p = (s, n, yy) => [x + side[0] * s + t[0] * n, yy, z + side[1] * s + t[1] * n];
    X.quad(p(-3.5, 0, r1), p(3.5, 0, r1), p(3.5, 2.5, r0), p(-3.5, 2.5, r0), MHCOL.roof);       // normals up and out
    X.quad(p(3.5, 0, r1), p(-3.5, 0, r1), p(-3.5, -2.5, r0), p(3.5, -2.5, r0), MHCOL.roof);
    X.tri(p(-3.2, 2.2, r0), p(-3.2, 0, r1), p(-3.2, -2.2, r0), MHCOL.house); X.tri(p(3.2, -2.2, r0), p(3.2, 0, r1), p(3.2, 2.2, r0), MHCOL.house);
    if (full) {
      pbox(X, x + t[0] * 2.22, z + t[1] * 2.22, side, 0.5, 0.03, y, y + 2.1, MHCOL.door);                          // door to the water
      pbox(X, x + t[0] * 2.22 + side[0] * 1.8, z + t[1] * 2.22 + side[1] * 1.8, side, 0.9, 0.03, y + 1.0, y + 2.1, MHCOL.glass);
    }
    const fx = x + side[0] * 5 + t[0] * 1.5, fz = z + side[1] * 5 + t[1] * 1.5;
    cyl(X, fx, fz, 0.07, y - 0.3, y + 8.5, 6, MHCOL.pole, true);
    if (full) X.quad([fx, y + 8.4, fz], [fx + side[0] * 1.6, y + 8.4, fz + side[1] * 1.6], [fx + side[0] * 1.6, y + 7.4, fz + side[1] * 1.6], [fx, y + 7.4, fz], MHCOL.flag);
    labels.push({ kind: 'hut', text: geo.sign || geo.name, pos: [x, y + 5.2, z], fixed: true });
    if (Number.isInteger(geo.vhf) || geo.tier === 'marina') labels.push({ kind: 'vhf', text: `Harbour master${Number.isInteger(geo.vhf) ? ` · ch ${geo.vhf}` : ''}`, pos: [x, y + 3.6, z], fixed: true, small: true });
  }
  // ---- fuel berth: pump and a red housing at the pontoon end
  if (lay.fuel) {
    const [x, z] = L([lay.fuel.lat, lay.fuel.lon]), yaw = (lay.fuel.hdg || 0) * Math.PI / 180, t = [Math.sin(yaw), -Math.cos(yaw)];
    pbox(F, x, z, t, 4, 2.2, -0.35, 0.42, MHCOL.deck, ['-v']);                                                        // the T-head
    pbox(F, x, z, t, 0.4, 0.3, 0.42, 1.9, MHCOL.pump);
    pbox(F, x - t[0] * 1.6, z - t[1] * 1.6, t, 0.9, 0.7, 0.42, 2.4, MHCOL.fuel);
    labels.push({ kind: 'fuel', text: 'FUEL', pos: [x, 3.2, z], fixed: false });
  }
  const float = F.out(), fixed = X.out();
  return { float, fixed, labels, tris: float.tris + fixed.tris, lay, anchor, lod };
}
/** Plan LOD per harbour by distance (m) within a budget: nearest first, FULL inside rFull, MID to rMax, none beyond or over budget. */
export function planMhLod(items, B) {
  const order = items.map((it, i) => ({ ...it, i })).sort((a, b) => a.dist - b.dist || a.i - b.i);
  const out = new Array(items.length).fill(MHLOD.NONE);
  let n = 0, tris = 0;
  for (const it of order) {
    if (it.dist > B.rMax || n >= B.harbours) continue;
    let lod = it.dist <= B.rFull ? MHLOD.FULL : MHLOD.MID;
    if (lod === MHLOD.FULL && tris + (it.tris?.[MHLOD.FULL] ?? it.est?.[MHLOD.FULL] ?? 0) > B.tris) lod = MHLOD.MID;
    const t = it.tris?.[lod] ?? it.est?.[lod] ?? 0;
    if (tris + t > B.tris) continue;
    out[it.i] = lod; tris += t; n++;
  }
  return out;
}
export { MHG };
