// World-tile prefetch (docs/WORLD-DETAIL-STREAMING.md §4.1): every 2 s, read-only over the game, feed the tile service
// so that detail is in memory before a ship or camera needs it.
//
//   P1  online ships: D14 within max(1.5 km, 180 s × speed), C11 within 30 km; heading cone to min(12 km, 600 s ×
//       speed), ±1.5 km wide
//   P2  autopilot routes of online players and hired-captain ships (D14 within 1 km of the next 30 min, C11 the next
//       3 h); harbours with an online player or a fleet ship within 50 km (D14 harbour core, pinned, + z12 overlay)
//   P3  offline players' ships: D14 within 1 km
//   P4  background warm-up, only with an empty queue and a healthy source: every harbour by size (C11 3×3, then the D14
//       children of mixed C11 tiles within 4 km of the anchor), one harbour per tick
//
// Requests are fire-and-forget (wt.request dedupes in-flight work; memory hits are cheap) and remembered for 60 s so a
// ring is not re-queued every tick. Never throws.
import os from 'node:os';
import { WT, tilesInRadius, tileKey, tileF, tileFToLatLon } from '../shared/wtformat.js';
import { haversine, destination } from '../shared/geo.js';
import { SHIP_CLASSES, GEO } from '../shared/constants.js';
import { HARBORS } from './harbors.js';
import { PRIO } from './worldtiles.js';
import { shipsOf } from './worldstack.js';

const SIZE_ORDER = { mega: 0, major: 1, regional: 2, minor: 3 };
export const PREFETCH = { TICK_MS: 2000, RECENT_MS: 60_000, NEAR_M: 1500, CONE_M: 12_000, CONE_HALF_M: 1500, C11_M: 30_000, HARBOR_NEAR_M: 50_000, HARBOR_CORE_M: 3200, OFFLINE_M: 1000, ROUTE_D14_S: 1800, ROUTE_C11_S: 3 * 3600, WARM_M: 4000, P4_DAILY: 30_000, MAX_QUEUE: 300 };

/** Points (lat, lon, metres along) of a voyage route from leg i on, up to `maxM`, sampled every `stepM`. */
function routeSamples(voyage, from, maxM, stepM = 800) {
  const pts = (voyage?.route || []).map((q) => (Array.isArray(q) ? { lat: q[0], lon: q[1] } : q)).filter((q) => q && Number.isFinite(q.lat) && Number.isFinite(q.lon));
  const out = [];
  let prev = from, along = 0;
  for (let k = Math.max(0, voyage?.i | 0); k < pts.length && along < maxM; k++) {
    const q = pts[k], L = haversine(prev.lat, prev.lon, q.lat, q.lon);
    for (let t = stepM; t < L && along + t < maxM; t += stepM) out.push({ lat: prev.lat + ((q.lat - prev.lat) * t) / L, lon: prev.lon + ((q.lon - prev.lon) * t) / L, d: along + t });
    along += L; prev = q;
    if (along < maxM) out.push({ lat: q.lat, lon: q.lon, d: along });
  }
  return out;
}

/**
 * startPrefetch({ game, wt, harbors = HARBORS, routePlanner, log, tickMs, loadavg, lagMs }) → { tick, stop, stats }.
 * `wt` is a server/worldtiles.js instance. loadavg / lagMs are injectable (tests).
 */
export function startPrefetch({ game, wt, harbors = HARBORS, log = () => {}, tickMs = PREFETCH.TICK_MS, loadavg = () => os.loadavg()[0], now = Date.now, timers = true } = {}) {
  const recent = new Map();     // 'prio:key' → time requested
  const st = { ticks: 0, requested: 0, warmHarbors: 0, overlays: 0, lagMs: 0, skippedP4: 0 };
  const warmOrder = harbors.slice().sort((a, b) => (SIZE_ORDER[a.size] ?? 4) - (SIZE_ORDER[b.size] ?? 4) || (a.id < b.id ? -1 : 1));
  let warmIdx = 0, timer = null, lastTick = 0;
  const overlayAsked = new Map();

  function ask(z, x, y, prio, d = 0, o = {}) {
    const k = `${prio}:${tileKey(z, x, y)}`, t = recent.get(k);
    if (t && now() - t < PREFETCH.RECENT_MS) return;
    recent.set(k, now()); st.requested++;
    wt.request(z, x, y, prio, { d, ...o }).catch(() => null);
  }
  function ring(z, lat, lon, r, prio, dBase = 0, o) { for (const t of tilesInRadius(z, lat, lon, r)) ask(z, t.x, t.y, prio, dBase + t.d, o); }

  function tick() {
    try {
      st.ticks++;
      const t0 = now();
      if (lastTick) st.lagMs = Math.max(0, t0 - lastTick - tickMs);
      lastTick = t0;
      for (const [k, t] of recent) if (t0 - t > PREFETCH.RECENT_MS) recent.delete(k);
      const ships = shipsOf(game);
      // P1: online ships, their surroundings and heading cone
      for (const { s, online, docked } of ships) {
        if (!online) continue;
        const v = Math.max(0, Number(s.spd) || 0) * GEO.KN_TO_MS;
        ring(WT.Z_DETAIL, s.lat, s.lon, Math.max(PREFETCH.NEAR_M, 180 * v), PRIO.P1);
        ring(WT.Z_COAST, s.lat, s.lon, PREFETCH.C11_M, PRIO.P1);
        if (!docked && v > 0.5 && Number.isFinite(s.hdg)) {
          const len = Math.min(PREFETCH.CONE_M, 600 * v);
          for (let d = 1000; d <= len; d += 1000) { const q = destination(s.lat, s.lon, s.hdg, d); ring(WT.Z_DETAIL, q.lat, q.lon, PREFETCH.CONE_HALF_M, PRIO.P1, d); }
        }
      }
      // P2: routes of online players and hired captains
      for (const { s, online, v, voyage, docked } of ships) {
        if (!voyage || docked || (!online && !v)) continue;
        const C = SHIP_CLASSES[s.cls] || SHIP_CLASSES.coaster, speed = Math.max(1, (Number(s.spd) || C.maxKn * 0.7) * GEO.KN_TO_MS);
        for (const q of routeSamples(voyage, s, speed * PREFETCH.ROUTE_D14_S)) ring(WT.Z_DETAIL, q.lat, q.lon, 1000, PRIO.P2, q.d);
        for (const q of routeSamples(voyage, s, speed * PREFETCH.ROUTE_C11_S, 8000)) ring(WT.Z_COAST, q.lat, q.lon, 1000, PRIO.P2, q.d);
      }
      // P2: harbours near online players and fleet ships (pinned rings + their z12 overlays)
      const active = ships.filter((e) => e.online || e.v);
      for (const h of harbors) {
        let near = Infinity;
        for (const e of active) { const d = haversine(e.s.lat, e.s.lon, h.lat, h.lon); if (d < near) near = d; }
        if (near > PREFETCH.HARBOR_NEAR_M) continue;
        ring(WT.Z_DETAIL, h.lat, h.lon, PREFETCH.HARBOR_CORE_M, PRIO.P2, near, { pin: true });
        if (wt.healthy() && typeof wt.requestOverlay === 'function') {
          const sq = new Set();
          for (const t of tilesInRadius(WT.Z_DETAIL, h.lat, h.lon, PREFETCH.HARBOR_CORE_M)) sq.add(`${t.x >> 2}/${t.y >> 2}`);
          for (const k of sq) {
            const t = overlayAsked.get(k); if (t && now() - t < 24 * 3600e3) continue;
            overlayAsked.set(k, now()); st.overlays++;
            const [x12, y12] = k.split('/').map(Number);
            wt.requestOverlay(x12, y12).catch(() => null);
          }
        }
      }
      // P3: offline players' ships (they may log in)
      for (const { s, online, p } of ships) if (p && !online) ring(WT.Z_DETAIL, s.lat, s.lon, PREFETCH.OFFLINE_M, PRIO.P3);
      // P4: warm-up, one harbour per tick, only when everything else is done and the box is idle
      const info = wt.sources?.sourceInfo?.() || {};
      if (wt.queued() === 0 && wt.healthy() && (info.today?.ofm ?? 0) < PREFETCH.P4_DAILY && st.lagMs <= 50 && loadavg() / os.cpus().length <= 0.75 && warmOrder.length) {
        const h = warmOrder[warmIdx % warmOrder.length]; warmIdx++; st.warmHarbors++;
        warmHarbor(h);
      } else st.skippedP4++;
    } catch (e) { try { log('[wt] prefetch tick failed', e?.message || e); } catch { /* never */ } }
  }
  /** C11 3×3 around the anchor, then the D14 children of the mixed C11 tiles within 4 km of it (uniform ones skip). */
  function warmHarbor(h) {
    const { fx, fy } = tileF(WT.Z_COAST, h.lat, h.lon), cx = Math.floor(fx), cy = Math.floor(fy);
    const parents = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) parents.push(wt.request(WT.Z_COAST, cx + dx, cy + dy, PRIO.P4, { pin: true }).then((t) => ({ t, x: cx + dx, y: cy + dy })).catch(() => null));
    Promise.all(parents).then((list) => {
      for (const it of list) {
        if (!it?.t || it.t.flags & WT.FLAG.UNIFORM) continue;
        for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) {
          const x = it.x * 8 + i, y = it.y * 8 + j, c = tileFToLatLon(WT.Z_DETAIL, x + 0.5, y + 0.5);
          const d = haversine(h.lat, h.lon, c.lat, c.lon);
          if (d <= PREFETCH.WARM_M + 1800) ask(WT.Z_DETAIL, x, y, PRIO.P4, d, { pin: true });
        }
      }
    }).catch(() => null);
  }
  if (timers) { timer = setInterval(tick, tickMs); timer.unref?.(); }
  if (current) current.stop();
  current = { tick, stop() { if (timer) clearInterval(timer); timer = null; if (current === this) current = null; }, stats: () => ({ ...st, recent: recent.size, warmIdx }) };
  return current;
}

let current = null;
/** One tick of the running prefetcher (the last startPrefetch); tests / manual nudges. */
export function prefetchTick() { current?.tick(); }
