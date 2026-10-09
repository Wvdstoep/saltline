// Saltline server: static client + world tile/chart API + WebSocket multiplayer shard.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { World, DATA_DIR } from './server/world.js';
import { carvingsForWorld, HARBORS } from './server/harbors.js';
import { Game } from './server/game.js';
import { yardsFor, parseVariant } from './shared/ships/index.js';   // SHIPYARD: yard list for one design (no politics: per-player blocks come with harbor.yard)
import { loadVtsFile } from './server/vhf.js';                           // VHF: VTS sectors (server/waterworks/vts-nl.json, else the lane B seed)
import { WT } from './shared/wtformat.js';                                     // BRIDGES & LOCKS: inland ends of /api/route
import { waterLevelAt } from './shared/waterlevel.js';
import { profileOf } from './shared/airdraft.js';
import { tileDepthSampler } from './server/minorharbours.js';                  // INLAND HARBOURS: berth depths from the tiles
import { lowWaterAt } from './shared/tide.js';
import { SIM, PATCH, SHIP_CLASSES } from './shared/constants.js';
import * as harborgeom from './server/harborgeom.js';
import { WeatherService } from './server/weather.js';
import { Traffic } from './server/traffic.js';
import { LANE_NODES } from './server/lanes.js';
import { planRoute, parseRouteQuery } from './server/searoute.js';                 // AUTOPILOT (planRoute stays for the fallback)
import { RoutePlanner } from './server/routeworker.js';                           // AUTOPILOT
import { RouteTable } from './server/routetable.js';                              // MARKET
import { PriceHistory, cachedSnapshot, routesHandler, historyAnswer } from './server/market.js'; // MARKET
import { tideAt } from './shared/tide.js';
import zlib from 'node:zlib';
import v8 from 'node:v8';
import { getTile } from './server/maptiles.js';
import { LiveAis } from './server/ais/index.js';
import * as worldtiles from './server/worldtiles.js';                                   // WORLD TILES (docs/WORLD-STREAMING-WIRING.md)
import { createWorldStack, geomFacade, handleTileSwap, guardGrounding, shipsOf } from './server/worldstack.js';
import { startPrefetch } from './server/wtprefetch.js';
import { tileFToLatLon } from './shared/wtformat.js';
import { haversine } from './shared/geo.js';
import { pruneRasterCache } from './server/world.js';
import { createMemGuard, LEVEL } from './server/memguard.js';
import { createQuayFinder } from './server/quays.js';                                   // DOCK ANYWHERE (docs/DOCK-ANYWHERE-CONTRACT.md)
import { attachFinder } from './server/quaygame.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const log = (...a) => console.log(new Date().toISOString(), ...a);

// MEMORY GUARD (server/memguard.js): rss against the container limit every 2 s. ≥ 50 % no background warm-up / patch
// rebuild, ≥ 65 % P3 paused, ≥ 75 % decoded tiles and harbour patches away from ships dropped (+ gc), ≥ 85 % only P0
// tile fetches. /api/health → mem. The tile, bathy and patch caches have fixed byte budgets on top of that.
const memGuard = createMemGuard({ log });
memGuard.start();
log(`[mem] limit ${Math.round(memGuard.limitBytes / 1048576)} MB (${memGuard.limitSource}), heap limit ${Math.round(v8.getHeapStatistics().heap_size_limit / 1048576)} MB, gc ${typeof globalThis.gc === 'function' ? 'exposed' : 'not exposed'}`);
const world = new World().load(carvingsForWorld(), log);
harborgeom.init(world);
// WORLD TILES: D14 / C11 detail from OpenFreeMap (docs/WORLD-DETAIL-STREAMING.md). `stack` answers like World from the
// finest layer in memory; `geom` is harborgeom with the tiles answering where no patch does. The raster `world` stays
// the input of the lane graph and the route planner (unchanged hashes, §6.2). SALTLINE_WT=0 switches the tiles off
// entirely (the game gets the raster and harborgeom themselves, /api/wt answers 404 fallback); SALTLINE_OFFLINE=1 or
// SALTLINE_WT_OFFLINE=1 never fetch (tiles already on disk keep serving). Cache: <data>/world, SALTLINE_WT_CACHE_MB (600).
const WT_ON = process.env.SALTLINE_WT !== '0';
const WT_OFFLINE = process.env.SALTLINE_OFFLINE === '1' || process.env.SALTLINE_WT_OFFLINE === '1';
const wt = WT_ON ? worldtiles.init({ offline: WT_OFFLINE, guard: memGuard, log: (...a) => log('[wt]', ...a) }) : worldtiles.disabledTiles();
if (WT_ON) harborgeom.configure({ wt });
const stack = WT_ON ? createWorldStack(world, { geom: harborgeom, wt }) : world;
const geom = WT_ON ? geomFacade(harborgeom, wt) : harborgeom;
log(`[wt] world tiles ${!WT_ON ? 'OFF (SALTLINE_WT=0)' : WT_OFFLINE ? 'offline (disk only)' : 'on'}${WT_ON ? `, disk cap ${Math.round(wt.capMB())} MB` : ''}`);
const weather = new WeatherService({ log });
let game = null;
const traffic = new Traffic(world, HARBORS, { log, weatherAt: (lat, lon) => (game ? game.weatherAt(lat, lon) : null) });
const routePlanner = new RoutePlanner({ world, graph: traffic.graph, geom: harborgeom, log });            // AUTOPILOT (route planner v2 off the main thread)
const routeTable = new RouteTable({ plan: (a, b, o) => routePlanner.plan(a, b, o, { priority: 'low' }), log }); // MARKET (harbour-to-harbour sea km)
pruneRasterCache(world, log, { keep: [routeTable.file] });   // WORLD TILES phase 1b: stale raster / sea-route caches (disk space)
const WW_ON = process.env.SALTLINE_WW_OFF !== '1';                                // BRIDGES & LOCKS / VHF / inland harbours (SALTLINE_WW_OFF=1 = off)
const vts = WW_ON ? await loadVtsFile() : null;                                  // VHF (§6.3)
game = new Game(stack, log, { weather, traffic, harborgeom: geom, routeTable, routePlanner, ...(WW_ON ? { vts, memGuard, maskAt: WT_ON ? (la, lo) => wt.maskAt(la, lo) : null } : {}) });     // MARKET adds routeTable; TIME reads it; v6 fleet: captains plan with routePlanner   // WORLD TILES: stack + facade
const priceHistory = new PriceHistory({ file: path.join(DATA_DIR, 'market-history.json'), log });           // MARKET
priceHistory.load(); priceHistory.maybeSample(game); routeTable.start();                                     // MARKET
setInterval(() => { try { priceHistory.maybeSample(game); } catch (e) { log('[market] sample failed', e.message); } }, 60000);
// Live AIS (AISStream worldwide with the key in data/secrets/aisstream.key or AISSTREAM_API_KEY; Digitraffic Baltic):
// where real ships are reported, the invented AI traffic steps aside so the two never overlap.
const liveAis = new LiveAis({ log, harbors: HARBORS });
liveAis.start();
game.aiFilter = (a) => !liveAis.covers(a.lat, a.lon);
game.liveAis = liveAis;                     // V7 step 0: the express passage keeps clear of live AIS vessels
// DOCK ANYWHERE: berths on every real quay, read from the D14 tiles already in memory near ships (never fetches by
// itself; a query with missing tiles asks for them at P1 and re-answers). Tiny caches, dropped on memguard shed.
if (WT_ON) {
  const wtGet = (z, x, y) => wt.get(z, x, y);
  attachFinder(game, createQuayFinder({ getTile: wtGet, harbors: HARBORS, guard: memGuard }), wtGet);
  if (game.mh && game.quayFinder?.sample) game.mh.setSampleDepth(tileDepthSampler(game.quayFinder.sample, lowWaterAt));   // INLAND HARBOURS
  game.quayEnsure = (lat, lon) => wt.ensureAround(lat, lon, 1700, worldtiles.PRIO.P1, { timeoutMs: 2500 });
}
// WORLD TILES §3.6.4: a tile that arrives / changes revision under a ship moves her to open water (≤ 300 m, depth ≥
// draught + 1 m), never damages her (grounding is ignored for 30 s), and tells clients near it to refetch (ETag changed).
let wtPrefetch = null;
if (WT_ON) {
  guardGrounding(game, wt);
  wt.onSwap((ev) => {
    try {
      handleTileSwap(game, stack, wt, ev);
      const c = tileFToLatLon(ev.z, ev.x + 0.5, ev.y + 0.5);
      const msg = JSON.stringify({ t: 'wt', k: ev.key, rev: ev.rev });
      for (const [id, ws] of game.sockets) {
        if (ws.readyState !== 1) continue;
        const p = game.byId.get(id); if (!p?.ship) continue;
        if (haversine(p.ship.lat, p.ship.lon, c.lat, c.lon) <= 6000) ws.send(msg);
      }
    } catch (e) { log('[wt] swap handler failed', e.message); }
  });
  wtPrefetch = startPrefetch({ game, wt, harbors: HARBORS, routePlanner, log, guard: memGuard });
  // Phase 1b: harbour patches rebuilt from the tiles (GEOM_VERSION 6) in the background, one harbour every 30 s, never
  // under a ship of an online player or a sailing fleet ship; the old patch serves until then. SALTLINE_WT_REBUILD=0 skips.
  if (!WT_OFFLINE && process.env.SALTLINE_WT_REBUILD !== '0') {
    const busy = (h) => shipsOf(game).some(({ s, online, v, docked }) => (online || (v && !docked)) && haversine(s.lat, s.lon, h.lat, h.lon) < 6000);
    const idle = () => memGuard.allowBackground() && wt.queued() === 0 && (wtPrefetch?.stats().lagMs ?? 0) <= 50;   // memory < 50 % only
    setTimeout(() => { if (wt.healthy()) harborgeom.rebuildFromTiles({ delayMs: Number(process.env.SALTLINE_WT_REBUILD_MS) || 30_000, busy, idle }).catch(() => {}); }, Number(process.env.SALTLINE_WT_REBUILD_START_MS) || 180_000).unref?.();
  }
}
// Harbour patches near ships that need them (online players, ships under way, sailing fleet ships) stay in memory and
// are loaded ahead; every other patch is evicted past its byte budget and re-read from disk when a query needs it.
const PATCH_NEAR_M = 15000;
const activeShips = () => shipsOf(game).filter(({ online, v, voyage, docked }) => online || (!docked && (v || voyage))).map(({ s }) => s);
const onlineShips = () => shipsOf(game).filter(({ online }) => online).map(({ s }) => s);
function patchResidency() {
  try {
    const ships = activeShips(), ids = [];
    if (ships.length) for (const h of harborgeom.patchList()) { for (const s of ships) if (Math.abs(s.lat - h.lat) < 0.2 && haversine(s.lat, s.lon, h.lat, h.lon) <= PATCH_NEAR_M) { ids.push(h.id); break; } }
    harborgeom.setResident(ids);
  } catch (e) { log('[geom] residency failed', e.message); }
}
setInterval(patchResidency, 10_000).unref?.();
memGuard.onShed(({ mode }) => {
  try {
    const keep = (mode === 'critical' ? onlineShips() : activeShips()).map((s) => ({ lat: s.lat, lon: s.lon }));
    const r = wt.shed ? wt.shed({ keep, keepM: 6000 }) : null;
    patchResidency();
    const n = harborgeom.trimPatches(0);
    log(`[mem] shed (${mode}): ${r ? r.dropped : 0} decoded tiles, ${n} harbour patches dropped; keeping ${keep.length} ships' surroundings`);
  } catch (e) { log('[mem] shed failed', e.message); }
});
function memReport() {
  const m = process.memoryUsage(), mb = (b) => Math.round(b / 1048576);
  const w = wt.stats(), g = harborgeom.stats();
  return { ...memGuard.stats(), heapUsedMB: mb(m.heapUsed), heapTotalMB: mb(m.heapTotal), externalMB: mb(m.external), arrayBuffersMB: mb(m.arrayBuffers), wtMemMB: w.memMB ?? 0, wtMemBudgetMB: w.memBudgetMB ?? 0, wtTiles: w.memTiles ?? 0, wtQueue: w.queue ?? 0, bathyMB: w.bathyMB ?? 0, patchesMB: g.memMB, patches: g.built, patchBudgetMB: g.budgetMB, converter: w.converter || null };
}
const MEMLOG_MS = Number(process.env.SALTLINE_MEMLOG_MS) || 10 * 60e3;
setInterval(() => { try { const r = memReport(); log(`[mem] ${r.level} rss ${r.rssMB}/${r.limitMB} MB · heap ${r.heapUsedMB} MB · ext ${r.externalMB} MB · tiles ${r.wtTiles} (${r.wtMemMB} MB) · patches ${r.patches} (${r.patchesMB} MB) · queue ${r.wtQueue}${game.ww ? ` · ww ${game.ww.objs.size} obj, shelter ${game.shelter?.stats().size ?? 0}` : ''}${game.mh ? ` · mh ${game.mh.stats().harbours} (${game.mh.stats().approxKB} KB)` : ''}`); } catch { /* never */ } }, MEMLOG_MS).unref?.();
const AIS_NEAR_M = 40000, AIS_NEAR_LIMIT = 200, AIS_PUSH_MS = 2000;
if (process.env.SALTLINE_PREFETCH === '1') harborgeom.prefetchAll({ delayMs: 1500 }).catch((e) => log('[geom] prefetch failed', e.message));

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => { res.setHeader('Cache-Control', req.path.startsWith('/api/tile') || req.path.startsWith('/api/chart') ? 'public, max-age=3600' : 'no-cache'); next(); });
app.use('/vendor', express.static(path.join(__dirname, 'node_modules', 'three', 'build')));
app.use('/shared', express.static(path.join(__dirname, 'shared'), { extensions: ['js'] }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/docs', express.static(path.join(__dirname, 'docs')));

app.get('/api/health', (req, res) => { const a = liveAis.stats(); res.json({ ok: true, players: [...game.byId.values()].filter((p) => p.online).length, simTime: Math.round(game.simTime), uptime: process.uptime(), ais: { vessels: a.vessels, offline: a.offline, sources: Object.fromEntries(Object.entries(a.sources).map(([k, v]) => [k, { enabled: !!v.enabled, connected: !!v.connected, msgs: v.msgs ?? 0 }])) }, route: routePlanner.stats(), quays: game.quayFinder ? game.quayFinder.stats() : null, wt: (() => { const s = wt.stats(); return s.disabled ? { disabled: true } : { fetched: s.fetched, failed: s.failed, queue: s.queue, diskMB: s.diskMB, capMB: s.capMB, memTiles: s.memTiles, pin: s.pin, built: s.built, swaps: s.swaps, offline: s.offline, healthy: s.healthy, today: s.today, converter: s.converter?.mode, geom: (({ tiles, stale, rebuild }) => ({ tiles, stale, rebuild }))(harborgeom.stats()) }; })(), market: { samples: priceHistory.samples, routes: routeTable.stats() }, rssMB: Math.round(process.memoryUsage().rss / 1048576), mem: memReport(), ...(game.mh ? { mh: game.mh.stats() } : {}) }); });
app.get('/api/world', (req, res) => res.json({ ...game.worldInfo(), lanes: LANE_NODES, patch: PATCH }));
// BRIDGES & LOCKS (docs/WATERWAYS-LANE1-PHASE2.md §4): registry objects near a point, one object with its live state
app.get('/api/ww', (req, res) => { const lat = +req.query.lat, lon = +req.query.lon, r = Math.min(15000, +req.query.r || 8000); if (!game.ww || !Number.isFinite(lat) || !Number.isFinite(lon)) return res.json({ objects: [] }); res.json({ objects: game.ww.statics(lat, lon, r), attribution: game.ww.attribution }); });
app.get('/api/ww/:id', (req, res) => { const o = game.ww?.get(req.params.id); if (!o) return res.status(404).end(); res.json({ object: game.ww.statics(...(o.p || [0, 0]), 1).find((x) => x.id === o.id) || o, state: game.ww.state(o.id) }); });
app.get('/api/politics', (req, res) => {          // world politics dataset for the client (docs/WORLD-POLITICS-PHASE2.md H24)
  if (!game.politics) return res.status(404).end();
  const c = game.politics.clientPayload();                     // everything except trade.json; ETag = dataset version
  if (req.headers['if-none-match'] === c.etag) return res.status(304).end();
  res.set({ ETag: c.etag, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }).send(c.json);
});
// v0.3: high-resolution harbour geometry (docs/V3-CONTRACTS.md §1). First build of a harbour may take a few seconds.
const validId = (id) => /^[a-z0-9_]{1,40}$/.test(id);
const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
app.get('/api/harbor/:id/geom', async (req, res) => {
  const id = req.params.id; if (!validId(id)) return res.status(400).end();
  try {
    const g = harborgeom.getHarborGeom(id) || (await withTimeout(harborgeom.ensureHarbor(id), 20000));
    if (!g) return res.status(404).json({ error: 'not available' });
    res.setHeader('Cache-Control', 'public, max-age=600'); res.json(g);
  } catch (e) { log('[geom] route error', e.message); res.status(500).end(); }
});
app.get('/api/harbor/:id/patch', async (req, res) => {
  const id = req.params.id; if (!validId(id)) return res.status(400).end();
  try {
    if (!harborgeom.getHarborPatch(id)) await withTimeout(harborgeom.ensureHarbor(id), 20000);
    const buf = harborgeom.getHarborPatch(id);
    if (!buf) return res.status(404).end();
    res.setHeader('Content-Type', 'application/octet-stream'); res.setHeader('Cache-Control', 'public, max-age=600');
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) { res.setHeader('Content-Encoding', 'gzip'); res.end(zlib.gzipSync(buf)); } else res.end(buf);
  } catch (e) { log('[geom] route error', e.message); res.status(500).end(); }
});
app.get('/api/weather', (req, res) => { const lat = +req.query.lat, lon = +req.query.lon; if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).end(); res.json(game.weatherAt(lat, lon)); });
app.get('/api/tide', (req, res) => { const lat = +req.query.lat, lon = +req.query.lon; if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).end(); res.json(tideAt(lat, lon, Date.now() / 1000)); });
app.get('/api/ai', (req, res) => res.json(traffic.all().filter((a) => !liveAis.covers(a.lat, a.lon))));
// Live AIS for the chart: every vessel in a box (decimated over the limit), and one vessel with its track.
app.get('/api/ais', (req, res) => {
  const b = String(req.query.bbox || '').split(',').map(Number);
  if (b.length !== 4 || !b.every(Number.isFinite) || b[0] >= b[2] || Math.abs(b[0]) > 90 || Math.abs(b[2]) > 90) return res.status(400).json({ error: 'bbox=latMin,lonMin,latMax,lonMax' });
  const limit = Math.max(1, Math.min(2000, Number(req.query.limit) || 2000));
  try { res.json({ time: Date.now(), ships: liveAis.bbox(b[0], b[1], b[2], b[3], { limit }) }); } catch (e) { log('[ais] bbox failed', e.message); res.status(500).end(); }
});
app.get('/api/ais/:mmsi', (req, res) => {
  const m = Number(String(req.params.mmsi).replace(/^ais/, ''));
  if (!Number.isInteger(m) || m <= 0) return res.status(400).end();
  const v = liveAis.get(m); if (!v) return res.status(404).end();
  res.json(v);
});
// v0.4: cached map tile proxy (OSM raster + OpenSeaMap seamarks) for the chart and the street-level terrain drape
app.get('/api/maptile/:layer/:z/:x/:y.png', async (req, res) => {
  const { layer } = req.params; const [z, x, y] = [req.params.z, req.params.x, req.params.y].map((v) => (/^\d{1,7}$/.test(v) ? +v : NaN));
  if (!['osm', 'seamark'].includes(layer) || ![z, x, y].every(Number.isInteger) || z < 2 || z > 18 || x >= 2 ** z || y >= 2 ** z) return res.status(400).end();
  try {
    const t = await getTile(layer, z, x, y);
    // Not available right now (upstream unreachable / backing off, or no such tile): 204 + no-store, so the browser
    // asks again later and does not log a console error per tile; the chart and the drape treat it as a miss.
    if (!t) { res.setHeader('Cache-Control', 'no-store'); return res.status(204).end(); }
    res.setHeader('Content-Type', t.type || 'image/png'); res.setHeader('Cache-Control', 'public, max-age=86400'); res.end(t.buf);
  } catch (e) { res.status(502).end(); }
});
// WORLD TILES (§3.5): the gzip'd SLWT bytes; a missing tile joins the queue at P0 and the request waits ≤ 6 s (503 +
// Retry-After after that), 404 + X-WT: fallback when the source is down / tiles are off and nothing is cached (the
// client keeps the coarse world). `meta` and `at` must stay before the :z/:x/:y route.
app.get('/api/wt/meta', (req, res) => res.json(wt.meta()));
app.get('/api/wt/at', (req, res) => {
  const lat = +req.query.lat, lon = +req.query.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return res.status(400).end();
  // debug: the tile cell plus what the game's physics sees there (stack height / layer, facade land penetration)
  const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : v ?? null);
  let phys = null;
  try { phys = { h: r2(stack.heightAt(lat, lon)), detail: stack.detailAt ? stack.detailAt(lat, lon) : 'raster', pen: r2(geom.landPenetration(lat, lon)) }; } catch { phys = null; }
  res.json({ ...(wt.debugAt(lat, lon) || {}), phys });
});
app.get('/api/wt/:z/:x/:y', async (req, res) => {
  const [z, x, y] = [req.params.z, req.params.x, req.params.y].map((v) => (/^\d{1,7}$/.test(v) ? +v : NaN));
  const a = await wt.serveTile(z, x, y, { ifNoneMatch: req.headers['if-none-match'] || null });
  for (const [k, v] of Object.entries(a.headers)) res.setHeader(k, v);
  res.status(a.status);
  if (a.body) res.end(a.body); else res.end();
});
app.get('/api/tile/:level/:tx/:ty', (req, res) => {
  const [level, tx, ty] = [req.params.level, req.params.tx, req.params.ty].map((v) => (/^\d{1,5}$/.test(v) ? +v : NaN));
  if (![level, tx, ty].every(Number.isInteger)) return res.status(400).end();
  const t = world.tile(level, tx, ty);
  if (!t) return res.status(404).end();
  res.setHeader('Content-Type', 'application/octet-stream');
  res.end(Buffer.from(t.buffer, t.byteOffset, t.byteLength));
});
app.get('/api/chart/world.png', (req, res) => { res.setHeader('Content-Type', 'image/png'); res.end(world.chartPNG(0, 4)); });
app.get('/api/chart/region.png', (req, res) => { res.setHeader('Content-Type', 'image/png'); res.end(world.chartPNG(1, 4)); });
app.get('/api/height', (req, res) => res.json({ h: world.heightAt(+req.query.lat, +req.query.lon) }));
app.get('/api/osm', (req, res) => {
  const f = path.join(DATA_DIR, 'osm-harbors.json');
  if (!fs.existsSync(f)) return res.json({ harbors: {} });
  res.setHeader('Content-Type', 'application/json'); fs.createReadStream(f).pipe(res);
});
app.get('/api/jobs', (req, res) => res.json(game.publicJobs()));
app.get('/api/yard/quote', (req, res) => {   // SHIPYARD §4.7: [{ yardId, name, cc, price, hours, specialist, schedule }]
  const variant = String(req.query.variant || '').slice(0, 96);
  if (!parseVariant(variant)) return res.status(400).json({ error: 'unknown design' });
  res.json(yardsFor(variant, { harbor: typeof req.query.harbor === 'string' ? req.query.harbor.slice(0, 64) : null }));
});
// Sea route planner v2 (docs/V6-QUICK-CONTRACTS.md §4.5): over water deep enough for the class's draught at low water,
// out of / into built harbour patches along the fairway, the Dover TSS lanes the right way, round the given storm discs.
// /api/route?from=lat,lon&to=lat,lon[&harbor=id][&cls=class][&wp=lat,lon;…][&avoid=lat,lon,radiusKm[,name];…]
const routeHits = new Map();
// BRIDGES & LOCKS (§5): a route starting or ending on inland water (river / lock / dock cell, or a canal pound) is planned
// through the inland graph joined to the sea route at the sea gates.
const inlandEnds = (from, to, C, cls) => {
  const inl = (pt) => { const m = WT_ON ? wt.maskAt(pt.lat, pt.lon) : null; return m === WT.MASK.RIVER || m === WT.MASK.LOCK || m === WT.MASK.DOCK || waterLevelAt(pt.lat, pt.lon, 0, { levels: game.levels }).ref === 'canal'; };
  const f = inl(from), t = inl(to); if (!f && !t) return null;
  const prof = cls ? profileOf(cls) : null;
  return { from: f, to: t, ship: { L: C?.length || 0, B: C?.beam || 0, T: C?.draft || 0, need: (prof ? prof.kTop - prof.tDesign : 0) + 0.3, sail: !!C?.sail, kn: C?.maxKn ? 0.8 * C.maxKn : 8 } };
};
setInterval(() => routeHits.clear(), 60000).unref?.();
app.get('/api/route', async (req, res) => {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '?';
  const hits = (routeHits.get(ip) || 0) + 1; routeHits.set(ip, hits);
  if (hits > 30) return res.status(429).json({ error: 'too many route requests — try again in a minute' });
  const q = parseRouteQuery(req.query);
  if (!q.ok) return res.status(400).json({ error: q.error });
  if (routePlanner.full()) return res.status(503).json({ error: 'route planner busy' });
  const C = q.cls ? SHIP_CLASSES[q.cls] : null;
  try { if (q.toHarbor && !harborgeom.getHarborPatch(q.toHarbor)) await withTimeout(harborgeom.ensureHarbor(q.toHarbor), 3000); } catch { /* plan without the patch */ }
  if (WT_ON) { try { await withTimeout(Promise.all([wt.ensureAround(q.from.lat, q.from.lon, 4000, worldtiles.PRIO.P0, { timeoutMs: 3000 }), wt.ensureAround(q.to.lat, q.to.lon, 4000, worldtiles.PRIO.P0, { timeoutMs: 3000 })]), 3000); } catch { /* plan on the raster */ } }   // WORLD TILES §3.6.2
  let r = null;
  try {
    r = await routePlanner.plan(q.from, q.to, { toHarbor: q.toHarbor, draft: C ? C.draft : 0, beam: C ? C.beam : 0, length: C ? C.length : 0, wp: q.wp, avoid: q.avoid, simTime: Date.now() / 1000, ...(game.ww && !(q.wp && q.wp.length) ? { inland: inlandEnds(q.from, q.to, C, q.cls) } : {}) }, { priority: 'high' });
  } catch (e) { log('[route] failed', e.message); }
  if (!r) return res.status(routePlanner.full() ? 503 : 404).json({ error: routePlanner.full() ? 'route planner busy' : 'no sea route found' });
  res.json(r);
});
// World market (docs/V6-QUICK-CONTRACTS.md §3.4): every harbour's prices, the hourly price history, the trade finder.
app.get('/api/market', (req, res) => res.json(cachedSnapshot(game)));
// INLAND HARBOURS (§7.5): chart rows in a bbox (zoom ≥ 11) and the card on demand (fit / fee / reach for ?player=)
app.get('/api/mh', (req, res) => {
  const b = String(req.query.bbox || '').split(',').map(Number);
  if (!game.mh || b.length !== 4 || !b.every(Number.isFinite)) return res.json({ harbours: [] });
  res.json({ harbours: game.mh.inBbox(b, Number(req.query.z) || 11) });
});
app.get('/api/mh/:id', (req, res) => {
  const p = req.query.player ? game.byId.get(String(req.query.player)) : null;
  let card = null; try { card = game.mh?.sheet(String(req.params.id), p?.ship ? { cls: p.ship.cls, lat: p.ship.lat, lon: p.ship.lon, cargo: p.cargo } : null); } catch (e) { log('[mh] card failed', e.message); }
  return card ? res.json(card) : res.status(404).json({ error: 'unknown harbour' });
});
app.get('/api/market/history', (req, res) => { const a = historyAnswer(priceHistory, req.query); res.status(a.status).json(a.body); });
app.get('/api/market/routes', routesHandler({ game, routeTable }));
app.get('/api/players', (req, res) => res.json([...game.byId.values()].filter((p) => p.online).map((p) => game.publicState(p))));
app.get('/api/fleetstats', (req, res) => res.json(game.fleet.stats()));   // v6 fleet: counts only (no private data)

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });

wss.on('connection', (ws, req) => {
  let player = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (!player) {
      if (m.t !== 'hello') return;
      player = game.connect(ws, m.token, m.name);
      if (WT_ON && player?.ship) wt.ensureAround(player.ship.lat, player.ship.lon, 1500, worldtiles.PRIO.P0, { timeoutMs: 8000 }).catch(() => null);   // WORLD TILES: the swap rule moves her if she now sits on land
      return;
    }
    switch (m.t) {
      case 'state': game.onState(player, m); break;
      case 'action': game.onAction(player, m); break;
      case 'chat': game.onChat(player, m.text); break;
      case 'ping': ws.send(JSON.stringify({ t: 'pong', c: m.c, time: Date.now() })); break;
    }
  });
  ws.on('close', () => { if (player && game.sockets.get(player.id) === ws) game.disconnect(player); });
  ws.on('error', (e) => log('[ws] error', e.message));
});

setInterval(() => {
  for (const ws of wss.clients) { if (ws.isAlive === false) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); }
}, 30000);

// Live AIS push: AISStream follows the online skippers; each one gets the real ships within 40 km every 2 s.
setInterval(() => {
  try {
    const online = [...game.byId.values()].filter((p) => p.online);
    liveAis.setInterest(online.map((p) => ({ lat: p.ship.lat, lon: p.ship.lon })));
    const time = Date.now();
    for (const [id, ws] of game.sockets) {
      if (ws.readyState !== 1) continue;
      const p = game.byId.get(id); if (!p) continue;
      ws.send(JSON.stringify({ t: 'ais', time, ships: liveAis.near(p.ship.lat, p.ship.lon, AIS_NEAR_M, { limit: AIS_NEAR_LIMIT }) }));
    }
  } catch (e) { log('[ais] push failed', e.message); }
}, AIS_PUSH_MS);

let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(1, (now - last) / 1000); last = now;
  try { weather.tick(); } catch (e) { log('[weather] tick error', e.message); }
  try { traffic.tick(dt); } catch (e) { log('[traffic] tick error', e.stack || e); }
  try { game.tick(dt); } catch (e) { log('[game] tick error', e.stack || e); }
}, 1000 / SIM.SERVER_TICK_HZ);
setInterval(() => { try { game.broadcastSnapshot(); } catch (e) { log('[game] snapshot error', e.stack || e); } }, 1000 / SIM.SNAPSHOT_HZ);

// Shutdown: ONE handler pair (docs/V6-QUICK-CONTRACTS.md §6.2). `{ sync: true }` is wave 2's synchronous save; before
// wave 2, saveState ignores the argument.
function saveAll(why) {
  log(why);
  try { game.saveState({ sync: true }); } catch (e) { log('[save] state failed', e.message); }
  try { priceHistory?.save(); } catch (e) { log('[save] market history failed', e.message); }
  try { wt.flushIndex(); } catch { /* best effort */ }
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { saveAll('shutting down, saving state'); try { routePlanner?.close(); } catch {} try { wtPrefetch?.stop(); harborgeom.stopRebuild(); wt.close(); } catch {} process.exit(0); });
process.on('uncaughtException', (e) => { log('[fatal] uncaught', e.stack || e); saveAll('saving after an uncaught exception'); });
process.on('unhandledRejection', (e) => log('[warn] unhandled rejection', e));

server.listen(PORT, () => log(`Saltline shard listening on :${PORT} — ${HARBORS.length} harbours, sim time ${Math.round(game.simTime)} s`));
