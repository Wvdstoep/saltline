# World detail streaming — wiring (phase 1a server.js, phase 1b harborgeom / world)

> **Status 2026-10-08: wired.** server.js, harborgeom.js (`buildFromTiles`, `GEOM_VERSION = 6`, `rebuildFromTiles`) and
> world.js (`pruneRasterCache`) are in; tests in `test/wt-wiring.test.mjs`. Deviations from the paste-ins below: v5 patch
> files keep serving (marked stale) until the background rebuild replaces them (one harbour / 30 s, P4, never where an
> online ship or a sailing fleet ship is within 6 km, starts 3 min after boot); `/api/wt/at` also returns `phys` (stack
> height / layer and facade land penetration); the prune keeps the route table in use as well as the newest one.

Companion to `docs/WORLD-DETAIL-STREAMING.md` (the spec). Lane A's modules are built and tested **without touching any
existing file**; this page is the exact paste-in for the wiring step after the current deploy. Every anchor below is a
search string (other lanes are editing `server.js`, so line numbers would be stale).

Built in phase 1a (all new files):

| File | What |
|---|---|
| `shared/wtformat.js` | §3.2 verbatim (SLWT format, tile maths) |
| `server/mvt.js` | MVT decoder (never throws) |
| `server/wtsource.js` | OpenFreeMap (pinned) / Terrarium z9 / Overpass z12 overlay; breaker, negative cache, budgets, re-pin |
| `server/wtconvert.js`, `server/wtconvert-thread.js` | the converter (§3.4) and its worker (`convertJob` = the same pipeline inline) |
| `server/worldtiles.js` | memory LRU + disk LRU (pins, index) + priority build queue + sync queries + `serveTile` (HTTP answer) |
| `server/worldstack.js` | `createWorldStack`, `geomFacade`, `handleTileSwap` (§3.6.4), `guardGrounding` |
| `server/wtprefetch.js` | P1–P4 rings (§4.1) |
| `scripts/probe-world-sources.mjs`, `record-wt-fixtures.mjs`, `record-moored-fixture.mjs`, `wt-repin.mjs` | phase 0 / fixtures / operator |
| `test/{mvt,wtformat,wtconvert,worldtiles,worldstack,wt-ports}.test.mjs`, `test/fixtures/wt/**` | 55 tests (1 skipped until the moored-AIS fixture exists), real fixtures for 13 ports |

Offline (`SALTLINE_WT_OFFLINE=1`, or under `node --test`) nothing reaches the network and the stack answers exactly like
today's raster (snapshot test of 2 000 points + a built patch in `worldstack.test.mjs`).

---

## 1. server.js (phase 1a)

### 1.1 Imports — after `import { LiveAis } from './server/ais/index.js';`

```js
import * as worldtiles from './server/worldtiles.js';                                   // WORLD TILES (docs/WORLD-STREAMING-WIRING.md)
import { createWorldStack, geomFacade, handleTileSwap, guardGrounding } from './server/worldstack.js';
import { startPrefetch } from './server/wtprefetch.js';
import { tileFToLatLon } from './shared/wtformat.js';
import { haversine } from './shared/geo.js';
```

(`haversine` may already be imported by then — keep one.)

### 1.2 Stack + facade — replace the block from `const world = new World().load(carvingsForWorld(), log);` to the `game = new Game(...)` line

```js
const world = new World().load(carvingsForWorld(), log);
harborgeom.init(world);
// WORLD TILES: D14 / C11 detail from OpenFreeMap (docs/WORLD-DETAIL-STREAMING.md). `stack` answers like World from the
// finest layer in memory; `geom` is harborgeom with the tiles answering where no patch does. The raster `world` stays
// the input of the lane graph and the route planner (unchanged hashes, §6.2).
const wt = worldtiles.init({ log: (...a) => log('[wt]', ...a) });
const stack = createWorldStack(world, { geom: harborgeom, wt });
const geom = geomFacade(harborgeom, wt);
const weather = new WeatherService({ log });
let game = null;
const traffic = new Traffic(world, HARBORS, { log, weatherAt: (lat, lon) => (game ? game.weatherAt(lat, lon) : null) });
const routePlanner = new RoutePlanner({ world, graph: traffic.graph, geom: harborgeom, log });            // AUTOPILOT (raster planner; D14 ends in phase 2)
const routeTable = new RouteTable({ plan: (a, b, o) => routePlanner.plan(a, b, o, { priority: 'low' }), log }); // MARKET
game = new Game(stack, log, { weather, traffic, harborgeom: geom, routeTable });                       // WORLD TILES: stack + facade
```

Only two arguments change versus today: `new Game(stack, …)` and `harborgeom: geom`. Keep whatever else other lanes
added to the `Game` options object.

### 1.3 Swap handler, grounding grace, prefetch — after `game.liveAis = liveAis;`

```js
// WORLD TILES §3.6.4: a tile that arrives / changes revision under a ship moves her to open water (≤ 300 m, depth ≥
// draught + 1 m), never damages her (grounding is ignored for 30 s), and tells clients near it to refetch (ETag changed).
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
const wtPrefetch = startPrefetch({ game, wt, harbors: HARBORS, routePlanner, log });
```

### 1.4 Routes — before `app.get('/api/tile/:level/:tx/:ty', …)`

```js
// WORLD TILES (§3.5): the gzip'd SLWT bytes; a missing tile joins the queue at P0 and the request waits ≤ 6 s (503 +
// Retry-After after that), 404 + X-WT: fallback when the source is down and nothing is cached (the client keeps the
// coarse world). `meta` and `at` must stay before the :z/:x/:y route.
app.get('/api/wt/meta', (req, res) => res.json(wt.meta()));
app.get('/api/wt/at', (req, res) => {
  const lat = +req.query.lat, lon = +req.query.lon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return res.status(400).end();
  res.json(wt.debugAt(lat, lon) || {});
});
app.get('/api/wt/:z/:x/:y', async (req, res) => {
  const [z, x, y] = [req.params.z, req.params.x, req.params.y].map((v) => (/^\d{1,7}$/.test(v) ? +v : NaN));
  const a = await wt.serveTile(z, x, y, { ifNoneMatch: req.headers['if-none-match'] || null });
  for (const [k, v] of Object.entries(a.headers)) res.setHeader(k, v);
  res.status(a.status);
  if (a.body) res.end(a.body); else res.end();
});
```

The global `Cache-Control` middleware sets `no-cache` for `/api/wt/*` already; `serveTile` sets it explicitly too.

### 1.5 `/api/route` — make the planner see the real coast at both ends (§3.6.2)

Find `try { if (q.toHarbor && !harborgeom.getHarborPatch(q.toHarbor)) await withTimeout(harborgeom.ensureHarbor(q.toHarbor), 3000); } catch { /* plan without the patch */ }`
and add right after it:

```js
  try { await withTimeout(Promise.all([wt.ensureAround(q.from.lat, q.from.lon, 4000, worldtiles.PRIO.P0, { timeoutMs: 3000 }), wt.ensureAround(q.to.lat, q.to.lon, 4000, worldtiles.PRIO.P0, { timeoutMs: 3000 })]), 3000); } catch { /* plan on the raster */ }
```

(Phase 1a plans on the raster as before; the wait makes the stack-based checks after planning and phase 2's worker
buffers deterministic. It costs nothing when the tiles are in memory.)

### 1.6 Login: the ship's own tiles at P0 (§6.1)

In `wss.on('connection', …)`, replace `player = game.connect(ws, m.token, m.name);` with

```js
      player = game.connect(ws, m.token, m.name);
      if (player?.ship) wt.ensureAround(player.ship.lat, player.ship.lon, 1500, worldtiles.PRIO.P0, { timeoutMs: 8000 }).catch(() => null);   // WORLD TILES: the swap rule moves her if she now sits on land
```

### 1.7 Health and shutdown

In `/api/health`'s object add (next to `route:`):

```js
wt: (() => { const s = wt.stats(); return { fetched: s.fetched, failed: s.failed, queue: s.queue, diskMB: s.diskMB, memTiles: s.memTiles, pin: s.pin, built: s.built, swaps: s.swaps, converter: s.converter?.mode }; })(),
```

In `saveAll(why)` add `try { wt.flushIndex(); } catch { /* best effort */ }`, and in the signal handler next to
`routePlanner?.close();` add `try { wtPrefetch?.stop(); wt.close(); } catch {}`.

### 1.8 Environment

| Variable | Default | Effect |
|---|---|---|
| `SALTLINE_WT_OFFLINE=1` | off | no upstream at all; disk keeps serving; game = today's behaviour |
| `SALTLINE_WT_CONC` | 4 | OpenFreeMap requests in flight (0 = stop fetching, the "kill the upstream" scenario §5.3-8) |
| `SALTLINE_WT_CACHE_MB` | **600** (was 1536: production has ≈ 1.5 GB free) | disk cap for tiles + overlays + bathy under `<data>/world` (LRU 95 % → 85 %, pinned harbour rings ≤ 25 %) |
| `SALTLINE_WT_RESERVE_MB` | 400 | the cap also shrinks to (tile bytes + free space − reserve), re-checked every 60 s, floor 32 MB |
| `SALTLINE_WT=0` | on | tiles switched off entirely: the game gets the raster `world` and `harborgeom` themselves, `/api/wt/*` → 404 `X-WT: fallback`, no prefetch, no rebuild, nothing under `<data>/world` |
| `SALTLINE_OFFLINE=1` | off | implies `SALTLINE_WT_OFFLINE=1` (and harborgeom never builds from tiles) |
| `SALTLINE_WT_REBUILD=0` | on | skip the phase 1b background rebuild of harbour patches from tiles |
| `SALTLINE_WT_OFM_BASE`, `SALTLINE_WT_TERRARIUM_BASE`, `SALTLINE_WT_OVERPASS` | public hosts | upstream base URLs (local stub / mirror; boot checks against `test/fixtures/wt`) |
| `SALTLINE_MEM_LIMIT_MB` | cgroup `memory.max` → v1 `limit_in_bytes` → `os.totalmem()` | memory limit the guard (`server/memguard.js`) measures rss against: ≥ 50 % no warm-up / patch rebuild, ≥ 65 % P3 paused, ≥ 75 % decoded tiles + patches away from ships dropped (+ `gc()`), ≥ 85 % only P0; `/api/health` → `mem` |
| `SALTLINE_WT_MEM_MB` | 64 | byte budget of decoded D14/C11 tiles in memory (only P0–P2 work fills it; P3/P4 go to disk only) |
| `SALTLINE_PATCH_MEM_MB` | 48 | byte budget of built harbour patches in memory; patches within 15 km of an active ship are pinned, the rest reload from `data/geom` on demand |
| `SALTLINE_WT_WORKER_HEAP_MB` / `SALTLINE_ROUTE_WORKER_HEAP_MB` | 96 / 256 | `resourceLimits` heap caps of the converter / route-planner workers (an OOM kills the worker, which restarts) |
| `SALTLINE_WT_WARM_MS`, `SALTLINE_WT_REBUILD_MS`, `SALTLINE_WT_REBUILD_START_MS` | 15 s, 30 s, 180 s | gap between warm-up harbours (one at a time, one sweep / 24 h), between patch rebuilds, delay before the first rebuild |
| `SALTLINE_MEMLOG_MS` | 10 min | period of the `[mem]` summary log line |

`npm start` runs `MALLOC_ARENA_MAX=2 node --max-old-space-size=448 --expose-gc server.js` (main-thread V8 heap capped for a 1 GiB pod; `gc` for the guard; 2 glibc malloc arenas: ≈ 40 MB less rss with the worker threads in the soak, no effect on musl).

### 1.9 After deploy (phase 0 leftovers on production)

```bash
node scripts/probe-world-sources.mjs --overpass          # quick health of the three sources
node scripts/wt-repin.mjs                                 # shows the pin (pinned automatically on first use)
node scripts/record-moored-fixture.mjs --base http://localhost:3000   # moored-AIS fixture (needs the live AIS store)
node scripts/record-wt-fixtures.mjs --ring 0 --tiles … --slim /tmp/wt-slim --check   # extend tile fixtures under the vessels it prints
```

---

## 2. Phase 1b

### 2.1 `server/world.js` — `pruneRasterCache()` (the 813 MB leak, §3.5)

In `World.load`, record the files used: add `this.cacheFiles = [];` at the top of `load`, and `this.cacheFiles.push(cacheFile);`
right after the `const cacheFile = …` line. Then add:

```js
/**
 * Delete raster cache files this World did not load (old carvings / versions) and every sea-routes file but the newest.
 * Call once from server.js after `new World().load(...)`. Never throws; returns { removed, freedMB }.
 */
export function pruneRasterCache(world, log = console.log) {
  const dir = path.join(DATA_DIR, 'cache');
  const keep = new Set((world.cacheFiles || []).map((f) => path.basename(f)));
  let removed = 0, freed = 0;
  try {
    if (!keep.size) return { removed, freedMB: 0 };   // never prune before a successful load
    const files = fs.readdirSync(dir);
    const routes = files.filter((f) => /^sea-routes-v\d+-[0-9a-f]+\.json$/.test(f)).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    const drop = files.filter((f) => /^(global|region)-[\d.]+-v\d+-[0-9a-f]+\.bin$/.test(f) && !keep.has(f)).concat(routes.slice(1).map((r) => r.f));
    for (const f of drop) { try { const p = path.join(dir, f); freed += fs.statSync(p).size; fs.unlinkSync(p); removed++; } catch { /* in use / gone */ } }
    if (removed) log(`[world] pruned ${removed} stale cache files (${Math.round(freed / 1048576)} MB)`);
  } catch { /* no cache dir */ }
  return { removed, freedMB: Math.round(freed / 1048576) };
}
```

`server.js`, right after `const world = new World().load(carvingsForWorld(), log);`:
`pruneRasterCache(world, log);` (import it from `./server/world.js`). The route worker loads the same carvings → the same
files, so it is never pruned away from under it. Check first which file the lanes / sea-route cache really writes
(`grep -n "sea-routes" server/*.js`) and adjust the second pattern if its name differs.

### 2.2 `server/harborgeom.js` — `buildFromTiles` + `GEOM_VERSION = 6`

Paste next to `buildFromOSM` (it uses the module's own `newCtx`, `finishBuild`, `mulberry32`, `hashString`, `SIZES`,
`osm`, mask constants):

```js
import { WT, cellOf as wtCellOf, tileFToLatLon, tileSizeM, tileHeightAt, tileMaskAt } from '../shared/wtformat.js';

/** D14 mask code → patch mask code (patches have no DOCK / RIVER / LOCK / BUILDING: water stays water, buildings land). */
const WT_TO_PATCH = [WATER, LAND, QUAY, BREAKWATER, PONTOON, FAIRWAY, SHALLOW, WATER, WATER, WATER, LAND];

/**
 * Raster + features from decoded D14 tiles (docs/WORLD-DETAIL-STREAMING.md §6.3): the 448² × 10 m mask is the D14 mask
 * resampled at the cell centres, the dredge layer the D14 depth (so the patch is never shallower than the tile), mooring
 * faces from the tile quays (OSM + derived), structures / buildings / tanks / cranes from the tile vectors. The street
 * layer, lights and buoys still come from the cached Overpass answer (`osmData`, optional). The berth, fairway, anchor
 * and dredge steps after it are finishBuild's, unchanged. `tiles`: Map('x/y' → decoded z14 tile) covering the patch.
 * Returns {geom, heights, mask, sdf} or null when a tile under the patch is missing.
 */
export function buildFromTiles(harbor, tiles, osmData = null, w = world) {
  const ctx = newCtx(harbor, 'tiles');
  const { n, mask } = ctx;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const [lat, lon] = ctx.frame.toLL((i + 0.5 - n / 2) * ctx.res, (j + 0.5 - n / 2) * ctx.res);
    const c = wtCellOf(14, lat, lon), t = tiles.get(`${c.x}/${c.y}`);
    if (!t) return null;
    const k = j * n + i, m = tileMaskAt(t, c.u, c.v);
    mask[k] = WT_TO_PATCH[m] ?? LAND;
    const h = tileHeightAt(t, c.u, c.v);
    if (IS_WATER[mask[k]] && h < 0) ctx.dredge[k] = -h;
  }
  // vectors: tile-local decimetres → lat/lon → patch metres
  const seen = new Set();
  for (const [key, t] of tiles) {
    const [tx, ty] = key.split('/').map(Number), sizeM = tileSizeM(14, tileFToLatLon(14, tx + 0.5, ty + 0.5).lat), v = t.vectors;
    if (!v) continue;
    const LL = (x, z) => { const p = tileFToLatLon(14, tx + x / 10 / sizeM, ty + z / 10 / sizeM); return [Math.round(p.lat * 1e6) / 1e6, Math.round(p.lon * 1e6) / 1e6]; };
    const pts = (flat) => { const o = []; for (let i = 0; i + 1 < flat.length; i += 2) o.push(LL(flat[i], flat[i + 1])); return o; };
    const inside = (ll) => { const [x, z] = ctx.frame.toXZ(ll[0], ll[1]); return Math.abs(x) < ctx.half && Math.abs(z) < ctx.half; };
    for (const q of v.quays || []) {
      const ll = pts(q.p); if (!ll.some(inside)) continue;
      const xz = ll.map((p) => ctx.frame.toXZ(p[0], p[1]));
      for (let i = 0; i + 1 < xz.length; i++) ctx.faces.push({ ax: xz[i][0], az: xz[i][1], bx: xz[i + 1][0], bz: xz[i + 1][1], kind: 'quay', side: null });
      ctx.features.quays.push({ pts: ll });
    }
    for (const p of v.piers || []) { const ll = pts(p.r); if (ll.some(inside)) ctx.features.piers.push({ pts: ll }); }
    for (const b of v.breakwaters || []) { const ll = pts(b.r); if (ll.some(inside)) ctx.features.breakwaters.push({ pts: ll }); }
    for (const p of v.pontoons || []) { const ll = pts(p.r); if (ll.some(inside)) ctx.features.pontoons.push({ pts: ll }); }
    for (const b of v.buildings || []) { const ll = pts(b.r); if (!ll.some(inside)) continue; const id = ll[0].join(','); if (seen.has(id)) continue; seen.add(id); ctx.features.buildings.push({ pts: ll, height: b.h, kind: b.k === 'shed' ? 'industrial' : b.k }); }
    for (const tk of v.tanks || []) { const ll = LL(tk.x, tk.z); if (inside(ll)) ctx.features.tanks.push({ lat: ll[0], lon: ll[1], radius: tk.r / 10, height: tk.h }); }
    for (const c of v.cranes || []) { const ll = LL(c.x, c.z); if (inside(ll)) (ctx.osmCranes ||= []).push({ lat: ll[0], lon: ll[1], hdg: c.hdg }); }
  }
  const cls = osmData ? osm.classifyFeatures(osmData.features || [], { lat: harbor.lat, lon: harbor.lon }) : null;
  ctx.street = cls ? { roads: cls.roads, areas: cls.areas, rails: cls.rails, pois: cls.pois, places: cls.places, hasStreets: osm.osmHasStreets(osmData) } : { roads: [], areas: [], rails: [], pois: [], places: [], hasStreets: false };
  if (cls) { for (const l of cls.lights) ctx.features.lights.push(l); for (const b of cls.buoys) ctx.features.buoys.push({ lat: b.lat, lon: b.lon, kind: b.kind, color: b.color, color2: b.color2, shape: b.shape }); }
  ctx.anchorPref = [0, 0];
  ctx.synthBuoys = ctx.features.buoys.length < 2;
  const S = SIZES[harbor.size] || SIZES.regional;
  ctx.fairwayHalf = S.fairHalf; ctx.fairwayDepth = S.fairDepth;
  ctx.rnd = mulberry32(hashString(harbor.id) ^ 0x9e3779b9);
  return finishBuild(ctx, w);
}
```

Then:

* `GEOM_VERSION = 6` (old patch files are rebuilt; until then the old patch keeps serving — see below).
* `configure(opts)` gains `wt` (`if (opts.wt) cfg.wt = opts.wt;`), and `server.js` calls `harborgeom.configure({ wt })`
  right after `worldtiles.init`.
* In `buildHarbor(h, opts)`, before the OSM / synthetic branch:

```js
  if (cfg.wt && !cfg.offline) {
    const r = await cfg.wt.ensureAround(h.lat, h.lon, (PATCH_N * PATCH_RES) / 2 * Math.SQRT2 + 100, 0, { timeoutMs: 8000 });
    if (r.ready === r.total && r.total) {
      const tiles = new Map();
      for (const t of tilesInRadius(14, h.lat, h.lon, (PATCH_N * PATCH_RES) / 2 * Math.SQRT2 + 100)) { const d = cfg.wt.get(14, t.x, t.y); if (d) tiles.set(`${t.x}/${t.y}`, d); }
      const built = buildFromTiles(h, tiles, osm.loadCachedOSM(h.id));
      if (built) { const e = makeEntry(h, built, 'tiles'); setEntry(e); saveGeomCache(e); return e.geom; }
    }
  }
```

  (`tilesInRadius` from `shared/wtformat.js`; source `'tiles'` must be accepted where `loadGeomCache` maps
  `meta.source === 'osm' ? 'osm' : 'synthetic'` → change to `['osm', 'tiles'].includes(meta.source) ? meta.source : 'synthetic'`.
  `loadGeomCache` rejects a v6 file without POIs unless `sub`: keep that rule only for `source === 'osm'`, since a
  tile-built patch without a cached Overpass answer legitimately has no street layer.)
* Background rebuild at P4: `prefetchAll` already walks `patchList()` one harbour at a time; with `GEOM_VERSION = 6`
  every cache miss goes through `buildHarbor`, i.e. through the tiles. Run it from `server.js` when the tile source is
  healthy: `if (wt.healthy()) harborgeom.prefetchAll({ delayMs: 4000 }).catch(() => {});` (it skips built entries).
* Offline (`SALTLINE_OFFLINE=1` / tests) the branch is skipped: `buildFromOSM` / `buildSynthetic` stay the fallbacks, so
  the existing harbour tests are unchanged.

### 2.3 `server/game.js` (optional one line)

If the express passage should also wait for tiles when every destination patch is already built, next to
`const need = this.expressPatchesToBuild(lat, lon);` add `this.geom?.ensureWorld?.(lat, lon);` (the facade's
`ensureWorld` waits ≤ 8 s for the D14 ring; the existing `Promise.all` over `need` does not have to await it because the
safe-spot search reads whatever is in memory, but awaiting it is equally fine:
`Promise.all([...need.map(...), this.geom?.ensureWorld?.(lat, lon)])`).

---

## 3. Spec decisions taken in phase 1a (review these)

1. **Fixture points corrected.** 21 of the 28 §5.2 coordinates did not hold on the real data (e.g. 51.905, 4.17 lies
   south of the Nieuwe Waterweg). The recorder's corrector moved each failing point to the nearest cell that passes
   (water: navigable, depth ≥ need + 0.5 m, ≥ 2 cells off obstacles; yards: port / industrial land ≥ 150 m from
   water), all ≤ 1.3 km; `points.json` keeps the design's coordinates as `orig` and the test fails if a point drifts more
   than 1.5 km. The corrected Rotterdam "Nieuwe Waterweg" point is a dock (bigports oracle kind 3), not the waterway.
2. **Port water floor** (new depth rule 5b, `PORT_FLOOR`): inside a port area, sea and river water keeps deepening along
   the shore ramp `0.5 + 0.15 d` down to mega 15 / major 13 / regional 9 / minor 5 m. Without it channels where
   Terrarium is void or a land DEM (Ambrose, Kill van Kull, Santos, Houston, Durban) could never reach their depths.
   Lake-class water is excluded (the Brielse Meer inside Rotterdam's port radius stays a shallow lake).
3. **Docks by context**: OpenFreeMap classes most Rotterdam basins as `lake`. Inside a port area, water inside port land
   and lake-class water within 300 m of port land become DOCK; a bigports DOCK kind upgrades WATER to DOCK in the guard.
4. **Port context** comes from the game's harbours *and* the AIS gazetteer (`server/ais/ports.js`, ~1 100 real ports with
   in-port radii): size = nearest game harbour within 25 km, else sized by the gazetteer radius; port area = harbour
   radius by size (mega 12, major 8, regional 5, minor 3 km) or the gazetteer radius.
5. **`render_height` 5 / `render_min_height` 0** is OpenMapTiles' default for untagged buildings → treated as an estimate
   (`e: 1`, kind/footprint rule). Building kind comes from the land use under the footprint (OFM has no building type).
6. **Facade `landPenetration`** returns the D14 penetration only when > 0 and `null` in open D14 water (not 0): `game.onState`
   treats a non-null answer as "inside a patch, skip the depth check", and in D14 water the depth check (on the stack) is
   wanted.
7. **Uniform tiles** require the whole work grid incl. the 4-cell buffer to be uniform, otherwise a coast just across the
   edge would be flattened away (seam test).
8. **Big-port oracle** is measured on the recorded tiles inside each core box (the full Antwerp core is ≈ 150 tiles);
   result without the guard: Rotterdam 94.5 %, Antwerp 98.6 %, Hamburg 98.1 %, Gothenburg 95.0 %.
9. **Fixtures are slimmed MVTs** (`record-wt-fixtures.mjs --slim`): only water, river / canal waterways, land use, sand,
   piers / bridges (+ buildings for Rotterdam) — still valid MVT, ≈ 4× smaller; the raw tiles are not committed.
10. **Moored-AIS fixture not recorded**: the live app is not reachable from the workspace container (localhost, the
    cluster service and the public URL all refused). `record-moored-fixture.mjs` and the test are ready; the test skips
    until `test/fixtures/wt/moored.json` exists.
11. **Overpass** refused connections from the workspace during recording (overpass-api.de: connection refused,
    kumi: 500) after 8 successful z12 overlays (Rotterdam 3, Hamburg 2, New York 2, Singapore 1). Worth checking on the
    app host too: the harbour patches use the same endpoints.
