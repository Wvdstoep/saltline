// Inland harbours and marinas everywhere, server side (docs/BRIDGES-LOCKS-VHF-CONTRACT.md §7.2, lane D).
// Harbours are generated per z12 square from that square's Overpass overlay (shared/mharbour.js harboursFromOverlay)
// plus the NL FIS tourist harbours that fall in it, when the overlay is available, and cached with the square.
// Never all at once: an LRU of squares holds ≤ MH.MAX_IN_MEMORY (3,000) harbours (≈ 1 KB each). server/memguard.js:
//   warm (≥ 1)   no new squares for background requests (offline ships, prefetch)
//   shed (≥ 3)   drop every square not under an online player's ship (keepSquares callback)
//   critical (4) no new squares at all
// The NL FIS harbour list is small (≈ 1,200) and indexed by square at construction: always available.
// Cards (`sheet`) are built on demand; reachability (planInland) is run lazily for the selected harbour only and cached
// 10 min per (ship profile, harbour). Never throws to callers.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { MH, harboursFromOverlay, harbourCard, chartRow, markerSpec, reachOf, sqOf, vhfOf, layerServices, inlandMarket, depthOf } from '../shared/mharbour.js';
import { tilesInRadius, WT_NAVIGABLE } from '../shared/wtformat.js';
import { distM } from '../shared/quayrules.js';
import { stubLaneA, plannerShip } from './inlandlink.js';
import { modelOf, rowOf, isYacht, isSail } from '../shared/jobs/shipview.js';

const Z12 = 12;

/** Dimensions of a ship class for fit / fees / planning: { cls, L, B, T, disp, yacht, sail, cemt }. */
export function shipDimsOf(cls) {
  const m = modelOf(cls), r = rowOf(cls) || {};
  return { cls, L: m?.length ?? r.length ?? 0, B: m?.beam ?? r.beam ?? 0, T: m?.draft ?? r.draft ?? 0, disp: m?.displacement ?? r.displacement ?? 0, yacht: isYacht(cls), sail: isSail(cls), cemt: m?.cemt ?? null };
}
/**
 * Depth sampler over the D14 tiles in memory (server/quays.js makeSampler): the median low-water depth of the navigable
 * cells on a 3 × 3 grid (20 m apart) around the point; null when the tiles are not loaded or no cell is water.
 */
export function tileDepthSampler(sample, lowWater) {
  return (lat, lon) => {
    const k = 111320 * Math.cos((lat * Math.PI) / 180), out = [];
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      let s = null; try { s = sample(lat + (i * 20) / 111320, lon + (j * 20) / k); } catch { s = null; }
      if (s && WT_NAVIGABLE[s.mask] === 1) out.push(Math.round((-s.h + lowWater(lat, lon)) * 10) / 10);
    }
    if (!out.length) return null;
    out.sort((a, b) => a - b);
    return out[Math.floor(out.length / 2)];
  };
}
/** Default overlay reader: the world-tile cache file <dataDir>/world/overlay/x/y.json.gz (read only), null when absent. */
export function diskOverlayReader(dataDir) {
  return async (x, y) => {
    try { const b = await fs.promises.readFile(path.join(dataDir, 'world', 'overlay', String(x), `${y}.json.gz`)); return JSON.parse(zlib.gunzipSync(b).toString('utf8')); } catch { return null; }
  };
}

/**
 * createMinorHarbours(opts) → mh
 *   named         the 336 named harbours (server/harbors.js HARBORS): sub-harbour links
 *   readOverlay   async (x12, y12) → compact overlay | null (default: none; server.js passes diskOverlayReader(DATA_DIR))
 *   fis           lane A's unpacked registry ({ harbours: [{ id, name, p, long, short, fuel }] }) | null
 *   guard         memguard (optional);  keepSquares() → Set('x/y') under online ships (shed)
 *   lane          loadLaneA() / stubLaneA() result (air draught + planInland);  graph  the inland graph for planInland
 *   sampleDepth   (lat, lon) → depth m at low water | null (tiles in memory; optional)
 *   market        (namedId) → marketSnapshot row | null;  jobs (h) → board | null;  townAt (lat, lon) → { name, km } | null
 *   max, now (ms), log
 */
export function createMinorHarbours(opts = {}) {
  const named = opts.named || [];
  const max = opts.max ?? MH.MAX_IN_MEMORY;
  const now = opts.now || Date.now;
  const log = opts.log || (() => {});
  const guard = opts.guard || null;
  let lane = opts.lane || stubLaneA();
  const level = () => { try { return guard ? guard.level() : 0; } catch { return 0; } };
  // FIS harbours by square (small, always loaded)
  const fisBySq = new Map();
  for (const f of opts.fis?.harbours || []) { const p = f.p || [f.lat, f.lon]; if (!Number.isFinite(p?.[0])) continue; const k = sqOf(p[0], p[1]); if (!fisBySq.has(k)) fisBySq.set(k, []); fisBySq.get(k).push(f); }
  const squares = new Map();       // 'x/y' → { ids: [id], full: bool, at }  (insertion order = LRU order)
  const byId = new Map();          // id → record
  const inflight = new Map();
  const reachCache = new Map();    // `${profile}|${id}` → { at, reach }
  const st = { ingested: 0, evicted: 0, overlayMisses: 0, denied: 0, sheets: 0, reach: 0, reachHits: 0 };
  let total = 0;

  function touch(k) { const s = squares.get(k); if (s) { squares.delete(k); squares.set(k, s); } }
  function drop(k) {
    const s = squares.get(k); if (!s) return;
    for (const id of s.ids) { byId.delete(id); total--; }
    squares.delete(k); st.evicted++;
  }
  function evict(keep = null) {
    for (const k of [...squares.keys()]) { if (total <= max) break; if (keep && keep.has(k)) continue; drop(k); }
  }
  /** Generate and cache one square from its overlay (null overlay → FIS harbours only, marked not full). */
  function ingest(x, y, overlay) {
    const k = `${x}/${y}`;
    let recs = [];
    try { recs = harboursFromOverlay(overlay || { f: [] }, { x12: x, y12: y, fis: fisBySq.get(k) || [], named, townAt: opts.townAt }); } catch (e) { log(`[mh] square ${k}: ${e.stack || e}`); recs = []; }
    if (squares.has(k)) drop(k);
    const ids = [];
    for (const r of recs) { if (byId.has(r.id)) continue; byId.set(r.id, r); ids.push(r.id); total++; }
    squares.set(k, { ids, full: !!overlay, at: now() });
    st.ingested++;
    evict(new Set([k]));
    return ids.length;
  }
  function squaresNear(lat, lon, rKm) { return tilesInRadius(Z12, lat, lon, rKm * 1000).map((t) => `${t.x}/${t.y}`); }
  /**
   * Make sure the squares within rKm of a point are generated. background = an offline ship / prefetch (refused at
   * memguard warm and above). Resolves to { ready, total, denied }.
   */
  async function ensureNear(lat, lon, rKm = MH.NEAR_KM, { background = false } = {}) {
    const keys = squaresNear(lat, lon, rKm), lv = level();
    let denied = 0;
    const jobs = [];
    for (const k of keys) {
      const s = squares.get(k);
      if (s && (s.full || !opts.readOverlay)) { touch(k); continue; }
      if (lv >= 4 || (background && lv >= 1)) { denied++; st.denied++; continue; }
      if (inflight.has(k)) { jobs.push(inflight.get(k)); continue; }
      const [x, y] = k.split('/').map(Number);
      const p = (async () => {
        let ov = null;
        try { ov = opts.readOverlay ? await opts.readOverlay(x, y) : null; } catch { ov = null; }
        if (!ov) st.overlayMisses++;
        if (!ov && squares.get(k)) return;                       // keep what we have (FIS-only), try again later
        ingest(x, y, ov);
      })().finally(() => inflight.delete(k));
      inflight.set(k, p); jobs.push(p);
    }
    await Promise.all(jobs);
    return { ready: keys.filter((k) => squares.has(k)).length, total: keys.length, denied };
  }
  /** Harbours of a square (cached, else FIS-only built now). */
  function harboursIn(x, y) {
    const k = `${x}/${y}`;
    if (!squares.has(k) && fisBySq.has(k) && level() < 4) ingest(x, y, null);
    const s = squares.get(k); if (!s) return [];
    touch(k);
    return s.ids.map((id) => byId.get(id)).filter(Boolean);
  }
  /** Harbours within rKm of a point (memory only), nearest first. */
  function near(lat, lon, rKm = MH.NEAR_KM) {
    const out = [];
    for (const k of squaresNear(lat, lon, rKm)) { const [x, y] = k.split('/').map(Number); for (const h of harboursIn(x, y)) { const d = distM(lat, lon, h.lat, h.lon); if (d <= rKm * 1000) out.push({ h, d }); } }
    return out.sort((a, b) => a.d - b.d || (a.h.id < b.h.id ? -1 : 1)).map((o) => o.h);
  }
  /** Chart rows inside a bbox [s, w, n, e] at a chart zoom (§7.5: zoom ≥ 11), memory only. */
  function inBbox([s, w, n, e], zoom = 11) {
    if (zoom < MH.CHART_MIN_ZOOM) return [];
    const out = [];
    for (const h of byId.values()) if (h.lat >= s && h.lat <= n && h.lon >= w && h.lon <= e) out.push(chartRow(h));
    out.sort((a, b) => (a.id < b.id ? -1 : 1));
    return out.slice(0, MH.CHART_MAX_ROWS);
  }
  const get = (id) => byId.get(id) || null;

  // ------------------------------------------------------------------ reachability (§7.4)
  function profileKey(dims, air) { return `${dims.cls}|${(air?.need ?? 0).toFixed(1)}|${(air?.T ?? dims.T).toFixed(1)}`; }
  /** Reach of harbour h for a ship at (lat, lon): cached 10 min per (profile, harbour). air = lane A airDraftNow result (optional). */
  function reach(h, ship, air = null) {
    const dims = shipDimsOf(ship.cls);
    const a = air || (() => { try { return lane.bestAirDraft(ship.cls, { cargo: ship.cargo || [] }); } catch { return null; } })();
    const key = profileKey(dims, a) + '|' + h.id, c = reachCache.get(key), t = now();
    if (c && t - c.at < MH.REACH_TTL_S * 1000) { st.reachHits++; return c.reach; }
    let r;
    if (!opts.graph || !lane.planInland) r = reachOf(null, { available: false });
    else {
      const ps = plannerShip(dims, a ? { ad: a.ad, need: typeof a.need === 'function' ? a.need(0) : a.need, T: a.T } : null);
      let route = null;
      try { route = lane.planInland(opts.graph, { lat: ship.lat, lon: ship.lon }, { lat: h.lat, lon: h.lon }, ps, Math.round(t / 1000)); } catch (e) { log(`[mh] planInland: ${e.message}`); route = null; }
      let blocked = null;
      if (!route) { try { blocked = route?.blocked || (lane.explain ? lane.explain(opts.graph, { lat: ship.lat, lon: ship.lon }, { lat: h.lat, lon: h.lon }, ps) : null); } catch { blocked = null; } }
      r = reachOf(route, { blocked });
    }
    st.reach++;
    reachCache.set(key, { at: t, reach: r });
    if (reachCache.size > 2000) reachCache.delete(reachCache.keys().next().value);
    return r;
  }

  // ------------------------------------------------------------------ card
  /** GET /api/mh/:id: the card on demand. ship = { cls, lat, lon, cargo } | null. */
  function sheet(id, ship = null) {
    const h = get(id); if (!h) return null;
    st.sheets++;
    let sampled = null; try { sampled = opts.sampleDepth ? opts.sampleDepth(h.lat, h.lon) : null; } catch { sampled = null; }
    const ctx = { depth: depthOf(h, { sampled }) };
    if (ship?.cls) { ctx.ship = shipDimsOf(ship.cls); ctx.link = h.link ? { size: named.find((n) => n.id === h.link.id)?.size, tier: h.sub ? 'port' : 'none' } : null; }
    if (ship && Number.isFinite(ship.lat)) ctx.reach = reach(h, ship);
    if (h.tier === 'inland_port' || h.tier === 'fishing') {
      const from = h.sub?.id || h.link?.id;
      try { const row = from && opts.market ? opts.market(from) : null; ctx.market = row ? inlandMarket(h, row) : null; } catch { ctx.market = null; }
    }
    try { ctx.jobs = opts.jobs ? opts.jobs(h) : null; } catch { ctx.jobs = null; }
    const card = harbourCard(h, ctx);
    if (h.sub) card.namedSheet = `/api/harbor/${h.sub.id}`;
    return card;
  }
  /** Radio (server/vhf.js opts.harboursOn): harbour masters on channel ch within 30 km. */
  function harboursOn(ch, lat, lon) {
    const out = [];
    for (const h of near(lat, lon, 30)) { const v = vhfOf(h); if (v.ch == null || (ch != null && v.ch !== ch)) continue; out.push({ id: h.id, name: `${h.name} harbour master`, kind: 'harbour', ch: v.ch, pos: [h.lat, h.lon], sim: v.sim, hours: null }); }
    return out;
  }
  /** The berth's services layer: the minor harbour within 1 km on top of the named harbour's dock-anywhere tier. */
  function servicesAt(lat, lon, quayTier = 'none') {
    const h = near(lat, lon, 1)[0] || null;
    return { harbour: h ? { id: h.id, name: h.name, tier: h.tier } : null, ...layerServices(h, quayTier) };
  }
  function markers(lat, lon, rKm = 3) { return near(lat, lon, rKm).map((h) => markerSpec(h)); }
  /** memguard shed: keep only the squares under online ships. */
  function shed() {
    let keep = null; try { keep = opts.keepSquares ? opts.keepSquares() : null; } catch { keep = null; }
    for (const k of [...squares.keys()]) if (!keep || !keep.has(k)) drop(k);
    reachCache.clear();
  }
  if (guard && typeof guard.onShed === 'function') guard.onShed(() => shed());

  return {
    ingest, ensureNear, harboursIn, near, inBbox, get, sheet, reach, harboursOn, servicesAt, markers, shed,
    setLane(l) { if (l) { lane = l; reachCache.clear(); } }, lane: () => lane, setSampleDepth(fn) { opts.sampleDepth = typeof fn === 'function' ? fn : null; },
    squaresNear, size: () => total, squareCount: () => squares.size, hasSquare: (x, y) => squares.has(`${x}/${y}`),
    stats: () => ({ ...st, harbours: total, squares: squares.size, fisSquares: fisBySq.size, approxKB: Math.round(total * 1.0) }),
  };
}
/** Squares (z12 keys) under a list of ship positions: what `keepSquares` returns for the online players. */
export function squaresUnder(points, rKm = 0) {
  const out = new Set();
  for (const p of points || []) { if (!Number.isFinite(p?.lat)) continue; out.add(sqOf(p.lat, p.lon)); if (rKm > 0) for (const t of tilesInRadius(Z12, p.lat, p.lon, rKm * 1000)) out.add(`${t.x}/${t.y}`); }
  return out;
}
