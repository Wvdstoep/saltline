// The physics merge of the world layers (docs/WORLD-DETAIL-STREAMING.md §3.6): one object with the World surface that
// game.js, searoute.js, lanes.js, traffic.js and tugassist.js already use, answering from the finest layer in memory.
//
//   heightAt / depthAt / isWater:  D14 tile in memory → L1 region raster (inside it) → C11 tile in memory → L0 raster
//   landPenetration (geomFacade):  built harbour patch → D14 obstacle (patches keep precedence inside their footprint)
//
// With no tiles in memory (offline, tests) every answer is exactly the raster's: the stack never waits for the network.
// handleTileSwap() is the §3.6.4 grace rule server.js runs when a tile under a ship changes.
import { WT, WT_NAVIGABLE, cellOf, cellLatLon, tileSizeM, tileHeightAt } from '../shared/wtformat.js';
import { SHIP_CLASSES } from '../shared/constants.js';
import { haversine } from '../shared/geo.js';

export const SWAP_GRACE_MS = 30_000;
export const SWAP_MOVE_MAX_M = 300;

/** A World-compatible view over the raster `world` and the tile service `wt` (server/worldtiles.js instance). */
export function createWorldStack(world, { geom = null, wt = null } = {}) {
  const tileH = (lat, lon, z) => { if (!wt) return null; try { const h = wt.heightAt(lat, lon, { z }); return Number.isFinite(h) ? h : null; } catch { return null; } };
  const stack = {
    layers: world.layers, charts: world.charts,
    layerFor: (lat, lon) => world.layerFor(lat, lon),
    tile: (l, tx, ty) => world.tile(l, tx, ty), chartPNG: (l, s) => world.chartPNG(l, s),
    heightAt(lat, lon) {
      const h = tileH(lat, lon, WT.Z_DETAIL); if (h != null) return h;
      if (world.layers[1] && world.layers[1].contains(lat, lon)) return world.heightAt(lat, lon);
      const c = tileH(lat, lon, WT.Z_COAST); return c != null ? c : world.heightAt(lat, lon);
    },
    depthAt(lat, lon) { return -this.heightAt(lat, lon); },
    isWater(lat, lon) { return this.heightAt(lat, lon) < 0; },
    /** Nearest point deeper than 6 m: a D14 ring search (≤ maxCells × 10 m) when the tile is loaded, else the raster's. */
    nearestWater(lat, lon, maxCells = 20) {
      if (tileH(lat, lon, WT.Z_DETAIL) == null) return world.nearestWater(lat, lon, maxCells);
      const p = nearestDeep(wt, lat, lon, 6, maxCells * 10);
      return p || world.nearestWater(lat, lon, maxCells);
    },
    /** Which layer answers at lat/lon: 'patch' | 'd14' | 'region' | 'c11' | 'global' (HUD, tests). */
    detailAt(lat, lon) {
      try { if (geom?.patchHeightAt && geom.patchHeightAt(lat, lon) != null) return 'patch'; } catch { /* no patch */ }
      if (tileH(lat, lon, WT.Z_DETAIL) != null) return 'd14';
      if (world.layers[1] && world.layers[1].contains(lat, lon)) return 'region';
      if (tileH(lat, lon, WT.Z_COAST) != null) return 'c11';
      return 'global';
    },
    world,
  };
  return stack;
}

/**
 * Nearest D14 point (loaded tiles only) with depth ≥ minDepth within maxM, searched in square rings of cells around
 * lat/lon; { lat, lon, distM } or null.
 */
export function nearestDeep(wt, lat, lon, minDepth, maxM) {
  if (!wt) return null;
  const c = cellOf(WT.Z_DETAIL, lat, lon), N = WT.N, cellM = tileSizeM(WT.Z_DETAIL, lat) / N;
  const tiles = new Map();
  const tileOf = (tx, ty) => { const k = `${tx}/${ty}`; if (!tiles.has(k)) tiles.set(k, wt.get(WT.Z_DETAIL, tx, ty)); return tiles.get(k); };
  const R = Math.ceil(maxM / cellM), ci = Math.floor(c.u), cj = Math.floor(c.v);
  for (let r = 0; r <= R; r++) {
    let best = null, bd = Infinity;
    for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
      const d = Math.hypot(di, dj) * cellM; if (d > maxM || d >= bd) continue;
      const gi = ci + di, gj = cj + dj, tx = c.x + Math.floor(gi / N), ty = c.y + Math.floor(gj / N);
      const t = tileOf(tx, ty); if (!t) continue;
      const i = ((gi % N) + N) % N, j = ((gj % N) + N) % N;
      const navig = t.mask ? WT_NAVIGABLE[t.mask[j * N + i]] : !(t.flags & WT.FLAG.UNIFORM_LAND);
      if (!navig || -tileHeightAt(t, i + 0.5, j + 0.5) < minDepth) continue;
      bd = d; best = { tx, ty, i, j };
    }
    if (best) { const ll = cellLatLon(WT.Z_DETAIL, best.tx, best.ty, best.i, best.j); return { lat: ll.lat, lon: ll.lon, distM: Math.round(bd) }; }
  }
  return null;
}

/**
 * The harbour-geometry module as game.js sees it, with the tiles answering where no patch does:
 *  * landPenetration: the patch's answer when a built patch covers the point; else metres inside a D14 obstacle when
 *    > 0, else null (open D14 water is left to the stack's depth check rather than reported as "inside a patch, 0 m");
 *    null for 30 s after the tile under the point changed (§3.6.4 grace: no rejection, no grounding from a swap).
 *  * ensureHarbor: also waits (same cap) for the D14 tiles within 3 km of the harbour, so the express passage's safe-spot
 *    search sees the real coast (§3.6.2).
 *  * ensureWorld(lat, lon): the same wait for any point (phase 1b one-line game.js hook).
 */
export function geomFacade(geom, wt, { now = Date.now, ensureTimeoutMs = 8000 } = {}) {
  const facade = { ...geom };
  facade.landPenetration = (lat, lon) => {
    let v = null;
    try { v = geom.landPenetration(lat, lon); } catch { v = null; }
    if (v != null && Number.isFinite(v)) return v;
    if (!wt) return null;
    try {
      if (wt.swappedAt(lat, lon) > now() - SWAP_GRACE_MS) return null;
      const t = wt.landPenetration(lat, lon);
      return Number.isFinite(t) && t > 0 ? t : null;
    } catch { return null; }
  };
  if (typeof geom.ensureHarbor === 'function') {
    facade.ensureHarbor = async (id, opts) => {
      let pos = null;
      try { pos = (geom.geomHarbor && geom.geomHarbor(id)) || (geom.harborAnchor && geom.harborAnchor(id)) || null; } catch { pos = null; }
      const tiles = wt && pos ? wt.ensureAround(pos.lat, pos.lon, 3000, 0, { timeoutMs: ensureTimeoutMs }).catch(() => null) : null;
      const [g] = await Promise.all([geom.ensureHarbor(id, opts), tiles]);
      return g;
    };
  }
  facade.ensureWorld = (lat, lon, radiusM = 3000) => (wt ? wt.ensureAround(lat, lon, radiusM, 0, { timeoutMs: ensureTimeoutMs }) : Promise.resolve({ ready: 0, total: 0 }));
  facade.wt = wt;
  return facade;
}

/**
 * Ships a swap handler / the prefetcher look at: each player's own ship (`p.ship`, owner messages go to `p`) and every
 * other vessel of the v6 fleet (`game.fleet.vessels`: hired captains, laid-up ships), each once.
 * [{ s (ship: lat, lon, cls, spd, hdg), p (the player sailing her, or null), v (vessel record or null), online, docked, voyage }]
 */
export function shipsOf(game) {
  const out = [], seen = new Set();
  for (const p of game?.byId?.values?.() || []) {
    const s = p?.ship; if (!s || !Number.isFinite(s.lat) || !Number.isFinite(s.lon) || seen.has(s)) continue;
    seen.add(s); out.push({ s, p, v: null, online: !!p.online, docked: !!p.docked, voyage: p.voyage || null });
  }
  const vessels = game?.fleet?.vessels;
  if (vessels && typeof vessels.values === 'function') for (const v of vessels.values()) {
    const s = v?.ship; if (!s || !Number.isFinite(s.lat) || !Number.isFinite(s.lon) || seen.has(s)) continue;
    seen.add(s); out.push({ s, p: null, v, online: false, docked: !!v.docked, voyage: v.voyage || null });
  }
  return out;
}

/**
 * §3.6.4: a tile arrived or changed revision. Every ship inside it that now sits on an obstacle, or where the depth at
 * mean low water is less than its draught, is moved to the nearest water ≤ 300 m away with depth ≥ draught + 1 m (else
 * next to the nearest harbour), speed zeroed, `lastValid` reset, told why. Docked ships are not moved. No damage is ever
 * charged (the facade's grace window covers the grounding check). Returns [{ id, movedM }].
 */
export function handleTileSwap(game, stack, wt, ev) {
  const out = [];
  if (!game?.byId || !ev || ev.z !== WT.Z_DETAIL) return out;
  for (const { s, p, v, docked } of shipsOf(game)) {
    if (docked) continue;
    const c = cellOf(WT.Z_DETAIL, s.lat, s.lon);
    if (c.x !== ev.x || c.y !== ev.y) continue;
    const C = SHIP_CLASSES[s.cls] || { draft: 3 };
    let pen = null; try { pen = wt.landPenetration(s.lat, s.lon); } catch { pen = null; }
    const depth = stack.depthAt(s.lat, s.lon);
    if (!(pen > 0) && depth >= C.draft) continue;
    let to = nearestDeep(wt, s.lat, s.lon, C.draft + 1, SWAP_MOVE_MAX_M);
    if (!to && typeof game.nearestHarbor === 'function' && typeof game.spawnPointNear === 'function') {
      try { const { harbor } = game.nearestHarbor(s.lat, s.lon); if (harbor) to = game.spawnPointNear(harbor); } catch { to = null; }
    }
    if (!to) continue;
    const movedM = Math.round(haversine(s.lat, s.lon, to.lat, to.lon));
    s.lat = to.lat; s.lon = to.lon; s.spd = 0;
    if (p) {
      p.lastValid = { lat: to.lat, lon: to.lon }; p.shallowSince = 0;
      try { game.sendYou?.(p, { correction: true }); } catch { /* offline player */ }
      try { game.event?.(p, 'info', `Chart corrected: your position was moved ${movedM} m to open water.`); } catch { /* offline player */ }
    } else if (v) v.lastValid = { lat: to.lat, lon: to.lon };
    out.push({ id: p ? p.id : v?.id, fleet: !p, movedM });
  }
  return out;
}

/** Wrap game.grounding so no damage is charged within the swap grace window of the tile under the ship (server.js). */
export function guardGrounding(game, wt, { now = Date.now } = {}) {
  const orig = game.grounding.bind(game);
  game.grounding = (p) => {
    try { if (p?.ship && wt.swappedAt(p.ship.lat, p.ship.lon) > now() - SWAP_GRACE_MS) return; } catch { /* fall through */ }
    return orig(p);
  };
  return orig;
}
