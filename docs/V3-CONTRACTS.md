# Saltline v0.3 — build contracts (v0.2 client + v3 harbours/weather/traffic)

This document is the single source of truth for the parallel build. Every agent reads it fully before editing.
Each file has exactly ONE owner. Never edit a file you do not own; if you need something from another file,
code against the contract below and note the dependency in your final report.

Project root (edit here): `/tmp/claude-0/-home-user/0e451cf3-a540-5510-b1a6-978d07bae2ed/scratchpad/saltline`
Run tests: `npm test` (node --test). Start locally: `PORT=3100 node server.js`. Node 22 locally, Node 20 in
production — no Node 22-only APIs. ESM everywhere. No new npm dependencies. The local container has NO
internet to Overpass / Open-Meteo / tile servers (production has) — code must degrade gracefully and tests
must mock network calls.

Existing conventions you must keep: 1 unit = 1 metre (`GEO.SCALE = 1`), local frame x = east, z = south
(`toLocal/fromLocal` in `shared/geo.js`), floating origin in `main.js` (`app.origin`, `app.place()`), sim time =
Unix seconds (`app.simTime`), heights in metres (negative = water depth), `encodeHeight/decodeHeight` for the
coarse tiles, three r160 via the importmap name `three`, shared modules served at `/shared/*`.

## File ownership

| Agent | Owns (create or edit) |
|---|---|
| S1 harbour-geometry | `server/osm.js`, `server/harborgeom.js`, `scripts/fetch-osm.mjs`, `test/harborgeom.test.mjs`, `test/osm-parse.test.mjs` |
| S2 environment | `server/weather.js`, `shared/tide.js`, `server/traffic.js`, `server/lanes.js`, `test/env.test.mjs` |
| S3 game-integration | `server/game.js`, `server/economy.js`, `server/harbors.js` (data only), `test/game.test.mjs`, `test/world.test.mjs`, `shared/constants.js` (add only, never rename/remove), `shared/physics.js` |
| C1 render | `public/js/ocean.js`, `public/js/weather.js`, `public/js/ship.js`, `public/js/harbor.js`, `public/js/models.js` (optional helper) |
| C2 ui | `public/js/chart.js`, `public/js/touch.js`, `public/js/hud.js`, `public/index.html`, `public/css/style.css` |
| C3 core | `public/js/main.js`, `public/js/interior.js`, `public/js/terrain.js`, `public/js/net.js`, `public/js/collision.js`, `public/js/harborgeom.js` |
| orchestrator | `server.js`, `docs/*`, `package.json` |

`server.js` already wires the routes listed below against the stub modules; S1/S2 replace the stub bodies and
keep the exported names and signatures.

## 1. Harbour geometry (S1) — `server/harborgeom.js`, `server/osm.js`

Goal: every harbour gets a local high-resolution "patch" (land/water/structure raster at 10 m) plus vector
features, derived from OpenStreetMap when reachable and from a procedural generator anchored to the coast
otherwise. The old floating "platform" harbour is gone.

### Local frame of a patch
Origin = the harbour's `lat/lon` from `server/harbors.js`. Cell (i, j), i east, j south, 0 ≤ i,j < n:
`x = (i + 0.5 - n/2) * res`, `z = (j + 0.5 - n/2) * res` metres; `lat = originLat - z / GEO.M_PER_DEG_LAT`,
`lon = originLon + x / (GEO.M_PER_DEG_LON_EQ * cos(originLat))`. Default `n = 448`, `res = 10` (4.48 km square).
Both sides use exactly these formulas (helper `patchCellToLatLon` / `latLonToPatchCell` live in `shared/constants.js`
— S3 adds them, see §6; until then inline the formula).

### Mask codes (Uint8)
0 water, 1 land, 2 quay/pier/jetty (hard structure, walkable, mooring possible), 3 breakwater/groyne (rubble, no
mooring), 4 pontoon/marina (floating, small craft mooring), 5 fairway/dredged channel (water), 6 shallows/beach/slipway
(water but depth < 2 m). Obstacles for ships are 1, 2, 3, 4. Water is 0, 5, 6.

### Heights (Uint8, patch encoding)
`h = (v - 128) * 0.25` metres (range −32 … +31.75). Water: depth −3 m at the shore line falling to −(3 + 0.08·d) with
d = distance to the nearest obstacle in metres, capped at −18 m; fairway cells −14 m minimum; shallows −1 m. Land:
+1.5 m at the shore, rising with distance to +12 m max (buildings are vectors, not raster). Quay 2.5 m,
breakwater 3.5 m, pontoon 0.6 m.

### Binary patch (`GET /api/harbor/:id/patch`, `application/octet-stream`, gzip when the client accepts it)
Little-endian: `'SLHP'` (4 bytes) · u8 version = 1 · u8 flags (bit0 = synthetic) · u16 n · f32 res ·
f64 originLat · f64 originLon · u8 heights[n·n] · u8 mask[n·n]. Row j = 0 is the NORTH edge.

### Geometry JSON (`GET /api/harbor/:id/geom`)
```
{ id, name, source: 'osm'|'synthetic', origin: {lat, lon}, anchor: {lat, lon},   // anchor = guaranteed water, ≥ 40 m from any obstacle
  n, res, radiusM,
  berths: [{ id: 'rotterdam-b1', name: 'Berth 1', lat, lon, hdg, length, depth, kind: 'quay'|'pontoon', maxLength }],
  fairway: [[lat, lon], ...],                                  // centre line from the anchor to open water (≥ 2 points)
  features: {
    quays: [{ pts: [[lat, lon], ...] }], piers: [{ pts }], breakwaters: [{ pts }], pontoons: [{ pts }],
    buildings: [{ pts, height, kind: 'warehouse'|'industrial'|'building'|'tank' }],
    cranes: [{ lat, lon, hdg }], lights: [{ lat, lon, height, color: '#ffffff', period }],
    buoys: [{ lat, lon, kind: 'lateral_port'|'lateral_starboard'|'cardinal_n'|'cardinal_e'|'cardinal_s'|'cardinal_w'|'safe_water'|'special'|'isolated_danger', color, shape: 'can'|'cone'|'pillar'|'spar'|'sphere' }],
    tanks: [{ lat, lon, radius, height }]
  } }
```
Rings are closed polygons without the repeated last point, lat/lon with 6 decimals. Keep the JSON under ~400 KB
(cap buildings at 300 largest, simplify rings to ≥ 3 m vertex spacing).

Berths: centre of a straight mooring line, `hdg` = direction a ship lies along it (either way is fine, the client
picks the closer), `lat/lon` placed 12 m off the quay face into the water, `length` of the straight quay run,
`depth` of the water there. Generate from quay/pier edges (mask 2 adjacent to water) and pontoon edges (kind
'pontoon', small craft only). 6–30 berths per harbour, longest and deepest first. Every harbour must have ≥ 2
berths with length ≥ 120 m and depth ≥ 8 m (dredge in the raster if OSM does not give it — the game needs them).

### OSM (server/osm.js)
`fetchHarborOSM(harbor, {radiusM, timeoutMs, fetchImpl})` → `{fetchedAt, radiusM, coastline:[[[lat,lon],…]], features:[…raw tagged ways/nodes…]}` or `null`
on any failure (never throws). Query Overpass (`overpass-api.de`, fall back `overpass.kumi.systems`): `natural=coastline`
ways (with full node geometry, `out geom`), `man_made` in pier|breakwater|groyne|quay|jetty|lighthouse|crane|storage_tank,
`waterway=dock`, `leisure=marina`, `landuse` in port|industrial|harbour, `seamark:type=*` nodes/ways, `building=*` ways
(largest 300 by area). One request per harbour, User-Agent `Saltline/0.3 (harbour geometry; one request at a time)`.
Disk cache `data/osm/<id>.json` with `fetchedAt`; re-fetch after 30 days. `loadCachedOSM(id)` sync.

`landPolygonsFromCoastline(ways, bbox)` — close OSM coastline ways against a bbox (land is on the LEFT of a coastline
way): clip every way to the bbox; closed rings inside are islands (land) ; open pieces start/end on the bbox border;
walk the border counter-clockwise (interior on the left) from each piece's end to the next piece's start to build
land polygons. If no coastline crosses the bbox, the whole bbox is land or water: decide with `world.isWater(originLat, originLon)`
(S1 receives the `world` in `init(world)`). Must be tested with synthetic fixtures (an island, a straight coast, a bay).

### Rasteriser (server/harborgeom.js)
Exports (all names fixed):
- `init(world)` — called once from server.js. Starts the lazy builder; never blocks.
- `getHarborGeom(id)` → geometry JSON or `null` if not built yet (sync).
- `getHarborPatch(id)` → `Buffer` or `null` (sync).
- `ensureHarbor(id)` → `Promise<geom|null>`; builds (fetching OSM if allowed) and caches in memory and on disk
  (`data/geom/<id>.json` + `data/geom/<id>.bin`, with a `version` field; bump `GEOM_VERSION` whenever the generator changes).
  `server.js` awaits this in the two routes with a 20 s cap, so a first request may be slow; later ones are instant.
- `landPenetration(lat, lon)` → metres inside an obstacle (mask 1–4) for the covering patch; `0` when in water; `null` when
  no built patch covers the point. Use the SDF (chamfer distance transform over the mask, in metres). Fast (< 50 µs).
- `nearestBerth(harborId, lat, lon)` → `{berth, distM, brg}` or `null`.
- `harborAnchor(id)` → `{lat, lon}` (anchor when built, else the harbour's own point).
- `sdfAt(id, lat, lon)` → signed distance in metres (negative inside obstacles), or `null`.
- `prefetchAll({delayMs})` → builds every harbour sequentially (used by `scripts/fetch-osm.mjs` and at startup when
  `process.env.SALTLINE_PREFETCH === '1'`); logs progress; never throws.
- `buildSynthetic(harbor, world)` → `{geom, heights, mask}` deterministic (seeded by id) procedural harbour anchored to
  the real coast: sample the world raster on the patch grid (bilinear `world.heightAt`), upsample, smooth the coast,
  then add: a main breakwater arm (3 ring points, 400–1200 m by size), a lee breakwater, two to five straight quays cut
  INTO the land along the coast (basin dredged to −10 … −14 m), a fairway from the anchor to open water (sample along
  increasing distance until the world depth > 15 m or 3 km), warehouses as rectangles behind the quays, a lighthouse
  at the breakwater head, lateral buoys (red to port when entering, green to starboard) along the fairway every 250 m.
  If the harbour point is on land in the world raster (it happens: several harbour points are up rivers), find the nearest
  world water and shift the ANCHOR there, keep the origin.
- `buildFromOSM(harbor, osm, world)` → same shape. Mask from: coastline land polygons (1) ∪ piers/quays/jetties (2) ∪
  breakwaters/groynes (3) ∪ marina pontoons (4); docks and marinas water (0/5); fairway from the anchor along the deepest
  water to the patch edge (5). Buildings → `features.buildings` (extrude heights from `height`, `building:levels`×3.2, default 8).
  Lights from `man_made=lighthouse` + `seamark:type=light_*`; buoys from `seamark:type=buoy_*`/`beacon_*` with IALA colours.
  Cranes from `man_made=crane`, else 1–5 synthetic cranes along the longest quay by harbour size. If OSM gives
  fewer than 2 usable berths, dredge/add synthetic quays so the guarantee above holds.
- `GEOM_VERSION`, `PATCH_N`, `PATCH_RES`, `MASK` enum export.

`scripts/fetch-osm.mjs` becomes a thin CLI over `prefetchAll` (`--only id1,id2`, `--delay ms`, `--force`), writing
`data/osm/*.json` and `data/geom/*`. Keep `test/osm-parse.test.mjs` passing (update it to the new parser).

## 2. Environment (S2) — `server/weather.js`, `shared/tide.js`, `server/traffic.js`, `server/lanes.js`

### Weather (`server/weather.js`)
Open-Meteo, no key. `forecast`: `https://api.open-meteo.com/v1/forecast?latitude&longitude&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl,temperature_2m,precipitation,visibility,cloud_cover&wind_speed_unit=ms`
and `marine`: `https://marine-api.open-meteo.com/v1/marine?latitude&longitude&current=wave_height,wave_direction,wave_period,swell_wave_height,swell_wave_direction,swell_wave_period`.
Exports:
- `class WeatherService { constructor({fetchImpl, log, cellDeg = 0.5, ttlMs = 20*60e3, maxConcurrent = 2}) }`
- `sample(lat, lon)` sync → `{ wind: {spd (m/s), dir (FROM, deg), gust}, waves: {height, dir, period}, swell: {height, dir, period}, pressure, temp, precip, visibility (m), cloud (0..1), fetchedAt, source: 'open-meteo' }`
  for the nearest cached cell within 1.0°; `null` otherwise. Never throws.
- `request(lat, lon)` → schedules a fetch for the cell if missing/stale (dedup, concurrency-limited, exponential backoff
  after failures, at most 60 requests/min). Returns nothing.
- `tick()` — call every server tick; services the queue; also prefetches the region grid (lat 50..61 step 2, lon −6..12
  step 3 = 42 cells) lazily, one every 2 s, when `enabled`.
- `enabled` false when `process.env.SALTLINE_OFFLINE === '1'` or after 5 consecutive network failures (re-tries every 10 min).
- `stats()` → `{cells, inflight, failures, enabled}`.

### Tide (`shared/tide.js`, browser-safe, no imports except `./constants.js`)
`tideAt(lat, lon, tSec)` → `{ height (m, relative to mean sea level), rate (m/h, + = flood), stream: {u, v} (m/s surface
tidal stream), range (m, spring-neap modulated), phase (0..1 of the M2 cycle), state: 'flood'|'ebb', nextHigh: tSec, nextLow: tSec }`.
Constituents M2 (12.4206 h), S2 (12 h), N2 (12.658 h), K1 (23.934 h), O1 (25.819 h). Amplitudes by region table:
Bristol Channel/Channel Islands M2 3.5 m, English Channel 2.2, southern North Sea (Dutch/Belgian/Thames) 1.2, German
Bight 1.4, Humber/Wash 2.3, Scottish east coast 1.5, Skagerrak/Kattegat 0.15, Baltic 0.05, Norwegian coast 0.6,
Irish Sea 2.5, Atlantic Europe 1.5, default ocean 0.8. Phase lag = f(lon, region) so high water progresses realistically
(roughly +1 h per 100 km along the Dutch coast northward). S2 amplitude = 0.33·M2, N2 = 0.19·M2, K1 = 0.08·M2 (0.4 m in the
Pacific/Gulf), O1 = 0.06·M2. Stream: up to 1.0 m/s in the Channel/Dover, 0.6 Dutch coast, 1.5 Pentland-ish, 0.2 open
sea; direction along the coast (use a small table of coast orientations) with the sign following `rate`. Deterministic,
pure, ~µs.

### AI traffic (`server/traffic.js`, `server/lanes.js`)
`server/lanes.js`: a hand-written graph of sea-lane nodes for the detail region (≥ 40 nodes: Dover Strait TSS both
lanes, Maas approach, Noord Hinder, Texel, German Bight / Elbe approach, Skagen, Kattegat, Oslofjord, Scottish east
coast, Humber, Thames, Southampton approach, Channel west, Irish Sea, Pentland/Shetland) and ~25 global ocean nodes
(Biscay, Gibraltar, Canaries, Cape Town, Suez approach, Singapore, Panama, Cape Horn, US east coast, Gulf of Mexico,
Japan, Australia…). Each harbour links to its nearest 1–3 nodes. Edges are straight; at init every edge is checked
with `world.isWater` at 2 km steps and dropped if it crosses land (log the count). Export `LANE_NODES`, `LANE_EDGES`,
`buildGraph(world)` → `{nodes, adj, route(fromHarborId, toHarborId) → [[lat,lon],…] | null}` (Dijkstra).

`server/traffic.js`: `class Traffic { constructor(world, harbors, {count = 90, rnd, log}) ; tick(dt) ; near(lat, lon, rangeM) → AiPublic[] ; all() }`.
AiPublic = `{ id: 'ai…', name, cls (a SHIP_CLASSES id; weight cargo/working/ferry/yacht), flag (ISO-2), lat, lon, hdg, spd (kn), dest (harbour id), destName, state: 'underway'|'moored'|'anchored', eta (Unix s) }`.
Ships pick a route harbour→harbour, move at 0.7–0.95 × maxKn (lower in storms via a provided `weatherAt` callback),
turn smoothly (turnRate), moor for 1–6 real hours (positioned at the harbour anchor, `state:'moored'`; 2–5 ships per mega
port at any time), anchor for a while outside busy ports. Deterministic given `rnd`. 60 % of the fleet in the detail
region. Position updates are cheap (90 ships × 10 Hz is fine). Names from a list of plausible ship names + flags.
`near()` must be O(n) and allocation-light.

## 3. Game integration (S3) — `server/game.js`, `server/economy.js`, `shared/constants.js`, `shared/physics.js`

server.js constructs: `const weather = new WeatherService({log}); const traffic = new Traffic(world, HARBORS, {log, weatherAt: (lat, lon) => game.weatherAt(lat, lon)}); const game = new Game(world, log, { weather, traffic, harborgeom });`
(`harborgeom` = the module namespace `import * as harborgeom from './server/harborgeom.js'`). Game must work when any of
them is missing (tests construct `new Game(world, log, {stateFile})`).

### Weather
`weatherAt(lat, lon)` → keep the shape and ADD fields: `{ wind: {u, v, spd, dir, gust}, sea (0..1), storm (0..1), rain (0..1),
waves: {height, dir, period}, swell: {height, dir, period}, visibility (m), pressure, temp, cloud, source }`.
Real data from `weather.sample()` when available (call `weather.request()` for every online player's cell and every
harbour cell lazily), otherwise the synthetic wind. **Superseded (sea-state update):** the game's storm cells are
overlaid on real AND synthetic data (server/stormfield.js — cyclonic wind, gusts, fetch/duration-grown sea, swell
ahead of the track, rain bands, pressure, visibility; `stormId/stormName/stormKind` name the dominant cell); real
severe-weather areas (server/realstorms.js, Bft 8+ or Hs ≥ 4 m, kind 'real' in `storms`) are overlaid on the synthetic
fallback only. With real data `storm` ≥ clamp((windSpd − 14)/12) and `rain` from precip. `sea` from wave height:
`min(1, waves.height / 6)`. `you.weather` adds `bft`, `seaState`/`seaWord` (WMO/Douglas by Hs, shared/seastate.js).
The global `this.wind` random walk is only the fallback.

### Tide
`you.tide = tideAt(lat, lon, simTime)` (rounded) every `sendYou`. `env.current` for offline simulation and cutters =
`currentAt + tide.stream`. Depth under keel on the server (`onState` shallow check) uses `world.depthAt + tide.height`.

### AI traffic in snapshots
`snapshot()` keeps the common part; `broadcastSnapshot()` sends per socket `{...common, ai: traffic.near(p.lat, p.lon, 40000)}`
(serialize the common part once as a string prefix and append per player, or just JSON.stringify per player —
player counts are small). `GET /api/ai` → `traffic.all()`.

### Harbour geometry, berthing, tugs
- `harborAnchor(h)` = `harborgeom.harborAnchor(h.id)`; `spawnPointNear`, `nearestHarbor`, docking range checks and
  cutters/rescues/AI use the ANCHOR, not the raw harbour point.
- `dock(p)`: allowed when (a) `nearestBerth` exists and `distM ≤ 60` and `|spd| ≤ 2` → moored at that berth: snap
  `p.ship.lat/lon` to the berth point and `hdg` to the berth heading (closest of hdg / hdg+180 to the ship's heading),
  `p.berth = {harbor, id, name}`; or (b) no geometry built for that harbour yet → legacy rule (≤ INTERACT.DOCK_RADIUS_U of
  the anchor and ≤ 3 kn). Otherwise explain: 'Come alongside a berth (within 60 m, under 2 kn) or request tugs.'
- `tug_assist` action: within 1500 m of the anchor, `|spd| ≤ 6`, not hailed; cost `max(400, displacement × 0.35)` cr;
  sets `p.assist = {harbor, berthId, until: now + 45 s, from: {lat, lon}}`; in `tick`, while assisting the server moves the
  ship linearly from `from` to the berth (client ignores its own simulation while `you.assist`), then docks it (same as a).
- `undock(p)`: spawn 25 m off the berth face into the water (use `berth.hdg + 90°` toward the deeper side; S1's berth
  point is already 12 m off the face — go 20 m further out), heading = berth heading; legacy harbours spawn at the anchor.
- `you.berth`, `you.assist`, `you.nearBerth = {id, name, harbor, distM, brg, hdg, depth, length}` (nearest berth within 2500 m,
  else null) are added to `privateState`.
- Harbour payload adds `berths` (list), `anchor`, `tugCost`, `fees: {dues, berthPerDay}`, `econ` (below).
- `onState`: `harborgeom.landPenetration(lat, lon) > 0.5` → reject the state and send a correction (same path as the
  budget rejection). Rate-limit the 'warn' event.
- `collision` action `{speedKn, kind: 'quay'|'ship'|'breakwater'}` from the client (rate-limited 1/3 s): cond −= clamp(speedKn × 0.9, 0.5, 12)
  (× 0.6 for 'ship'), flooding += 0.05 when speedKn > 8; event text. Also `stats.collisions++`.

### Economy (server/economy.js, game.js)
- Markets get supply/demand: per harbour `stock[g]` (t) and `target[g]`; price = `GOODS[g].base × local × clamp(0.55, 1.9, (target/stock)^0.5)`;
  player buy: stock −= qty; sell: stock += qty; drift 5 %/h toward target; `local` from harbour size and a per-harbour
  seeded profile (industrial ports import grain/export steel etc. — a simple table by country/size is fine). Contract pay
  adds a demand bonus at the destination. `harbor.econ = { stock, target, trend: {g: -1|0|1} }` in the harbour payload.
- Ship market: `buy_ship` and `buy_used` keep working; ADD `sell_ship` (sell the current hull for `shipValue`, the player
  receives a free 'pilot' boat if nothing else is bought — i.e. money += value − 0, cls → 'pilot' with cond 60 — so the
  market is a real buy/sell market); used listings refresh every 6 h with 1–4 hulls; `shipyard` payload adds `cat` and
  `specs` (length, beam, draft, maxKn, capacity, pax, fuelCap, burn, crewCost, price) per class.
- Realistic harbour fees: port dues on dock (existing), berth fee per started 24 h while docked (displacement × 0.02 cr,
  charged on undock), pilotage for ships > 90 m at mega/major ports (displacement × 0.05, charged on dock), bunker price
  varies ±15 % by harbour (exists), repair cost scales with displacement (exists via price). Maintenance: a `service`
  action at the yard (cost 1 % of hull price) that resets `p.serviceDue`; without service every 30 days of sailing
  the wear multiplier climbs 2 %/day up to +60 %.
- `publicJobs()` adds `pay`, `payPerT`, `type`, `distKm`, `to`, `toName`, `deadline`, `needsCat`, `good`, `qty`, `pax` for every job and
  `harbor: {id, name, lat, lon, size}` so the chart can draw job boards.

### Constants (shared/constants.js, add only)
`PATCH = { N: 448, RES: 10, H_OFFSET: 128, H_STEP: 0.25, MASK: { WATER: 0, LAND: 1, QUAY: 2, BREAKWATER: 3, PONTOON: 4, FAIRWAY: 5, SHALLOW: 6 } }`,
`encodePatchHeight(h)`, `decodePatchHeight(v)`, `patchCellToLatLon(i, j, n, res, originLat, originLon)`,
`latLonToPatchCell(lat, lon, n, res, originLat, originLon)` → `{i, j}` (continuous, un-rounded),
`INTERACT.BERTH_RANGE_U = 60`, `INTERACT.TUG_RANGE_U = 1500`, `LAW` unchanged, `SIM.AI_RANGE_U = 40000`.
`shared/physics.js`: add optional `env.tideStream {u, v}` added to the current, `env.waveH` reduces speed up to 25 % at 6 m
head seas; keep everything else.

### Tests
Every new branch gets a test in `test/game.test.mjs` / `test/env.test.mjs` / `test/harborgeom.test.mjs`: berthing accept/reject,
tug assist completes, land penetration rejection, collision damage clamp, sell_ship, supply/demand price moves, berth fee,
tide monotonic phases, lane route exists Rotterdam→Hull and Rotterdam→Hamburg, weather sample fallback, synthetic harbour
has ≥ 2 big berths and an anchor in water, OSM coastline closing fixtures, patch binary round-trip.

## 4. Server routes (orchestrator, already in server.js)
- `GET /api/harbor/:id/geom` → JSON or 404 (awaits `ensureHarbor` up to 20 s)
- `GET /api/harbor/:id/patch` → binary (gzip if accepted)
- `GET /api/weather?lat=&lon=` → `game.weatherAt`
- `GET /api/tide?lat=&lon=` → `tideAt`
- `GET /api/ai` → `traffic.all()`
- `GET /api/jobs`, `/api/world`, `/api/tile/...`, `/api/chart/...` unchanged
- `/api/world` adds `lanes: LANE_NODES` (for the chart) and `patch: PATCH`.

## 5. Client — common

### Messages (WebSocket)
- `snap`: `{t:'snap', time, simTime, wind, players, cutters, storms, rescues, ai: AiPublic[]}`
- `you`: `privateState` + `tide`, `weather` (extended), `berth`, `assist`, `nearBerth`, `serviceDue`
- `harbor`: + `berths`, `anchor`, `tugCost`, `fees`, `econ`, `shipyard[].specs`, `shipyard[].cat`, `used`, `tradeIn`
- Actions: `tug_assist`, `collision {speedKn, kind}`, `sell_ship`, `service`, plus all existing ones.

### `public/js/harborgeom.js` (C3)
`class HarborGeomSet { constructor() ; async load(harborId) → entry|null ; unload(id) ; get(id) ; nearest(lat, lon) → entry|null ; sdfAt(lat, lon) → {d, gx, gz, entry} | null ; heightAt(lat, lon) → m|null ; maskAt(lat, lon) → code|null }`.
`entry = { id, geom (JSON above), n, res, origin, heights: Uint8Array, mask: Uint8Array, sdf: Float32Array (metres, negative inside obstacles), bbox }`.
The SDF is computed client-side with a two-pass chamfer (3-4 or exact-ish) from the mask, in metres. `sdfAt` is bilinear
and returns the gradient (unit, pointing OUT of obstacles). All lat/lon ↔ cell conversions use the §1 formulas.

### `public/js/collision.js` (C3)
`resolveShip(ship, cls, geoms, dt, others)` — hull sample points (bow, stern, 2 × midships, 4 quarter points) in metres from the
ship's lat/lon/hdg; for each point with `sdf.d < 0`: push the ship out along the gradient by `-d` (apply to lat/lon), remove the
velocity component into the wall, scale speed by 0.4, and return `{hit: true, speedKn, kind}` once per contact (rate-limited by the
caller). Also ship–ship: oriented bounding boxes vs. `others` (players + AI) → push apart, `kind:'ship'`. The ship must NEVER end up
inside an obstacle after this call, even when starting inside (iterate up to 4 times, last resort: move to the last known water position).
Wind/current pushing a stopped ship against a quay must result in the ship resting against it, not passing through.

### `public/js/terrain.js` (C3)
Keep the API (`update`, `setOrigin`, `heightAt`, `version`, `group`) and ADD `addPatch(entry)` / `removePatch(id)`: a high-res
mesh for the patch (full res on desktop, half res when `navigator.hardwareConcurrency ≤ 4` or touch), coloured by mask (quay concrete
0x8e8b84, breakwater 0x5a5650, pontoon 0xb9b2a4, land sand→grass, water bed tones), placed in the floating-origin frame; coarse
tiles have the vertices inside a patch footprint sunk to −260 (same trick as the region cut-out, recompute when patches change).
`heightAt` consults patches first (via the entry's bilinear `heights`), then tiles.

### `public/js/main.js` (C3) — orchestration duties
- Loads harbour geometry (`HarborGeomSet.load`) when within 12 km of a harbour, unloads beyond 16 km; calls `terrain.addPatch`,
  `buildHarbor(h, entry.geom)`, keeps `app.geoms`.
- Every frame after `stepShip`: `resolveShip` against `app.geoms` and others/AI; on `hit` send `collision` (≤ 1 per 3 s) and flash.
  While `you.assist` is set: no local simulation; lerp the visual to the server positions. While `you.berth`: docked.
- Tide: `ocean.setLevel(you.tide.height)`; depth telemetry = `-(terrainHeight) + tide.height`; `env.tideStream` into physics.
- Weather: `ocean.setSea(you.weather)`, `weatherFx.set(you.weather)`, fog distance from visibility, storm darkening.
- AI ships from `snap.ai`: same interpolation as other players, `buildShip(cls, name, seed)`; labels show `name · dest`.
- Rescues from `snap.rescues`: `buildRescue(kind)` moving craft; while `you.rescue`: raft camera + HUD overlay via `hud.showRescue`.
- Platforms: `buildPlatform(p)` within 15 km.
- Interior: `I` key / `btnInterior` toggles `interior.enter()/exit()`; interior camera owned by `Interior`.
- Routes: `app.route = [{lat, lon}, …]` from the chart; autopilot follows waypoints in order; `setRoute(points)`, `clearRoute()`;
  express passage / set voyage prompts come from the HUD (C2) and call `net.action('express', {lat, lon})` / `set_voyage`.
- Touch: `TouchHelm` drives `input.throttleCmd/rudderCmd`; pinch on the canvas zooms the camera; one-finger drag orbits.
- Sails: `S` while on a sail ship? No — use `btnSails` (C2) → `net.action('sails', {up})` and `mesh.userData.setSails(up, windRel)`.
- Real date: `hud.updateTop(you, snap, …)` gets `simTime` (Unix s) — C2 renders `Wed 07 Oct 15:42 UTC`.
- Keep every existing feature (trade, convoy, boarding, salvage, fishing, towing, hail banner, prompts, chat).

### `public/js/net.js` (C3)
Unchanged protocol; add `onReconnect` resend of `hello` (exists) and a `binary` fetch helper `fetchPatch(id)` if convenient.

### `public/js/interior.js` (C3)
`class Interior { constructor(app) ; enter() ; exit() ; get active ; update(dt) ; handleKey(e) ; dispose() }`. Builds a walkable
interior as a child group of `app.myMesh` (so it inherits heave/pitch/roll): bridge (helm console with wheel, throttle lever,
radar screen (canvas texture mirroring the HUD radar), chart table, windows all round at the real bridge height), passage, engine
room (engine block sized by class, gauges with needles for rpm/fuel/temperature driven by `you`), crew cabins with bunks (2–8 by
`pax`), mess/lounge with table, sofa, galley; sailing yachts get a saloon + V-berth + cockpit. First-person: eye height 1.65 m,
pointer-lock mouse look on desktop, touch: left half virtual stick (move) right half drag (look) — read `touch.js`'s
`TouchHelm.stick` if present. Room AABB collision, doors. Hotspots (E / tap): helm → steer from the bridge (controls stay the
same keys), engine panel → shows status text, bunk → 'You rest for a while' (no time skip; real time), chart table → `hud.openChart()`,
radio → focus chat. `exit()` restores the chase camera. Hide the ship's name label while inside.

## 6. Client — render (C1)

### `public/js/ocean.js`
Keep `Ocean(scene)`, `setWind(ms)`, `setSun(dir, color, night, skyTop, skyHorizon)`, `update(time, cx, cz, dt)`, `rebuildDepth(...)`,
`heightAt(x, z, time)`, `WAVES`, `waveHeight`. ADD `setSea({windSpd, windDir, waveH, waveDir, wavePeriod, swellH, swellDir, swellPeriod})`,
`setLevel(y)` (tide: moves both meshes), `setRain(r)`. Realism: 8 Gerstner components whose directions cluster around
`waveDir` (wind sea) + 2 long swell components along `swellDir`; amplitudes scale to the significant wave height (sum ≈ waveH/2);
steepness ≤ 0.6 with amplitude-weighted Q; procedural normal detail (two scrolling noise octaves) in the fragment shader; Schlick
fresnel; sun specular lobe with roughness from wind; sky reflection; subsurface on crests; whitecaps above wind 8 m/s; shore foam
from the depth texture; rain ripples when `uRain > 0`; horizon blending into the fog; night darkening. The CPU `heightAt` must
match the GPU displacement (same component table, Gerstner vertical part). Target: 60 fps on a mid laptop, the near mesh at
≤ 180×180 segments; far ring kept.

### `public/js/weather.js` (new)
`class WeatherFX { constructor(scene, camera) ; set({rain, storm, cloud, visibility, windSpd, windDir, night}) ; update(dt, camPos, time) ; flash() ; dispose() }`.
Cloud layer (a large alpha-noise shader plane at 1500 m moving with the wind, cover from `cloud`), rain streaks (Points around the
camera, falling with wind drift, density from `rain`), lightning (random `flash()` when `storm > 0.6`: sky + hemisphere light pulse),
fog density is set by main.js (`scene.fog.near/far` from `visibility`), spray/mist near the horizon in storms (optional).

### `public/js/ship.js`
Keep every existing export and the `userData` API (`cls, length, beam, draft, freeboard, mats, wake, label, beacon, setWear, setFlood,
setWaterY, setWake, dispose`). ADD `userData.updateWake(dt, worldPos: Vector3, hdgRad, spdKn)` — a trailing foam ribbon (ring buffer of
≤ 48 points, fades over ~25 s, width grows from beam×0.9 to beam×3, alpha falls with age and rises with speed; alpha-noise texture
generated once on a canvas), a bow-wave foam strip and Kelvin V lines; the ribbon lives in `scene` (world space) not in the ship
group: `userData.wakeGroup` that main.js adds to the scene once (`app.scene.add(mesh.userData.wakeGroup)`) and that `dispose()` removes.
`userData.setSails(up, windRelDeg)` for sail classes (mainsail/jib triangles sheet to the wind angle; furled when down).
`userData.setLights(night)` nav lights emissive. Better models for all 17 classes + `cutter` + `lifeboat` + `helicopter` + `derelict`:
bulker (5 hatches, 4 deck cranes), tanker (catwalk, manifold, pipes), boxship (stacks to 7 high, bridge aft, bow thruster marks),
tug (fenders, winch, tall bridge), psv (forward bridge, long low deck with pipes), pilot boat (small, orange), ferry (3 decks, funnel),
cruiser (windscreen, open cockpit), myacht (flybridge, radar arch), superyacht (4 tiers, helipad, tender), sloop/ketch/catamaran/schooner
(masts, booms, standing rigging as thin cylinders, sails), lifeboat (orange RIB/all-weather boat), helicopter (fuselage, main rotor
spins via `userData.setRotor(t)`, skids), derelict (listing hull, no lights). `buildRescue(kind)` → lifeboat|helicopter group,
`buildPlatform(platform)` → offshore platform (4 jacket legs, deck, modules, flare stack with emissive flame, helideck, name label),
`buildWreck(cls)` stays. Keep draw calls sane: merge static boxes per material where easy (`BufferGeometryUtils` from
`three/addons` is NOT available — `/vendor` serves only `three.module.min.js`; write a tiny merge helper or keep meshes separate).

### `public/js/harbor.js`
`buildHarbor(harbor, geom)` now receives the geometry JSON (§1) or `null` (legacy fallback = a compact version of the old scenery,
but NEVER a floating platform: a small quay ring at the anchor only). Convert rings with `toLocal(lat, lon, geom.origin)` and
position the group at the harbour ORIGIN (main.js does `place(group, geom.origin.lat, geom.origin.lon)`). Render: quays/piers as
extruded shapes 2.5 m high (concrete, dark edge strip, bollards every 25 m, rubber fenders, mooring rings), breakwaters as
rubble (irregular dark extrusion 3.5 m), pontoons (light grey, 0.6 m, with posts), buildings (extruded footprints, roofs, a few
window strips emissive at night), tanks (cylinders), cranes (gantry cranes at `cranes` with hdg), lights (towers with an emissive
lamp that flashes with `period` at night via `setNight(n, time)`), buoys (IALA shapes/colours, bobbing is done by main.js via
`userData.buoys` list of meshes + `userData.updateBuoys(time)`), berth number boards at each berth, harbour name label, a few
street lamps. `buildFishingMarker` kept. Export `buildPlatform` re-exported from ship.js or defined here (ONE definition; C1 decides and
documents it in the report — main.js imports `buildPlatform` from `./harbor.js`).

## 7. Client — UI (C2)

### `public/js/chart.js` (new)
`class Chart { constructor(app, canvasEl, infoEl) ; open() ; close() ; isOpen() ; draw() ; setCenter(lat, lon, zoom) ; centerOnShip() ;
getRoute() ; clearRoute() ; setLayer(name, on) }`. Web Mercator; zoom 2 … 16 (zoom 2 = world); pan by drag / touch, zoom by wheel /
pinch / buttons; `draw()` renders: base = our chart PNGs (`/api/chart/world.png` and `region.png` placed by their LAYERS bounds —
note they are equirectangular: warp per row or just draw at zoom < 7 where the error is tolerable); at zoom ≥ 7 OSM raster tiles
`https://tile.openstreetmap.org/{z}/{x}/{y}.png` (cache Image objects, ≤ 256 cached, attribution "© OpenStreetMap contributors" drawn in
the corner) and the OpenSeaMap seamark overlay `https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png` (toggle, default on);
overlays: harbours (icon by size + name; click → job board popup with every job: type pill, title, pay, pay/t, distance, deadline,
'needs yacht/ferry'), job markers (from `/api/jobs` refreshed every 60 s while open), fishing grounds (dashed circles),
platforms, storms (translucent discs with the name + intensity), AI ships (small grey triangles with course vector, name on hover),
players (white), convoy mates (cyan), cutters (red), wrecks (×), rescues, your ship (yellow with heading + 6 nm vector) + track,
route (waypoint markers numbered, legs, total nm, ETA at current SOG), lanes faint (from `world.lanes`), lat/lon + depth of the
cursor (depth via `/api/height?lat&lon` debounced 300 ms), scale bar, tide at the cursor (`/api/tide`) in the info line.
Interaction: click/tap = select (harbour popup or ship info); click/tap on empty water in ROUTE mode (default) = append waypoint;
right-click / long-press on a waypoint = remove; buttons: `+ − ⌖ (centre) Route/Select mode toggle, Clear route, Sail route (→ app.setRoute + autopilot), Seamarks toggle, Base toggle`.
Mobile: everything by touch; buttons ≥ 44 px. Keep `M` to toggle. The old `drawChart`/`chartClick` in hud.js delegate to this class.

### `public/js/touch.js` (new)
`isTouch()`, `class TouchHelm { constructor(root, {onThrottle, onRudder, onAllStop}) ; setThrottle(v) ; setRudder(v) ; show(on) ; stick }`:
throttle = vertical slider (−30 … 100 %, detents at 0, snaps display), rudder = horizontal slider that auto-centres on release
(rate-limited to the same feel as the keys), big round buttons for Dock/Chart/Interior/Camera, `stick` = a left-thumb virtual
joystick object `{x, y, active}` used by the interior walker. Uses pointer events, `touch-action: none`.

### `public/js/hud.js`
Keep every existing method name used by main.js (`setStatus, setConn, showWelcome, anyOverlayOpen, transientOpen, closeOverlays, event,
tickLog, chat, alert, clearAlert, updateTop, updateTelemetry, drawRadar, toggleChart, chartOpen, drawChart, showHarbor, hideHarbor,
harborOpen, renderHarborTabs, toggleShips, updateHail, prompt, harborDirty, chartMode`). `toggleChart/chartOpen/drawChart` delegate to
`Chart`. ADD: `openChart()`, `showFishing(info|null)` (ground, rate t/h, caught t, 'too fast, slow under 3 kn'), `showWeather(wx, tide)`
(wind/gust, sea state word + wave height/period, visibility, pressure, temp, tide height/rate/next HW-LW, stream), `showRescue(r|null)`
(full-screen soft overlay: 'You are in the life raft — lifeboat from X, ETA mm:ss' with a progress bar), `showBerth(nearBerth, berth, assist, tugCost)`
(berth guidance line in the telemetry: 'Berth 3 · 240 m · 085° · depth 9 m' + buttons 'Moor (T)' / 'Request tugs (N cr)' enabled only when
in range), `showVoyage(route, eta, expressCost)` ('Sail route', 'Express passage N cr' → confirm → `net.action('express', {lat, lon})` of the
final waypoint, 'Set voyage' (offline sailing) → `set_voyage {lat, lon}`), `showInterior(on)` (hides the helm HUD bits and shows 'Back on deck (I)'),
`setSailsButton(isSail, up)`. Telemetry: fix the first-character clipping (the `<b>` elements need `overflow: visible`/min-width or a grid
with `minmax(0,1fr)`), fuel shown in t with range estimate `(fuel / burnPerHour) × SOG` nm, real date/time `Wed 07 Oct 15:42 UTC` from
`simTime` (Unix s) plus local sunrise/sunset not required. Harbour panel tabs: Contracts (with earnings, pay/t, deadline in h or d, type pills,
'needs yacht/ferry', why you cannot take it), **Job boards** (every harbour's jobs from `/api/jobs`, sorted by distance from here, with
'Chart' link that opens the chart centred there), Fuel & yard (+ 'Service (1 % of hull) — due in N days'), Market (stock, trend arrows,
buy/sell with impact note), Ship market (New: grouped by category working/cargo/passenger/motor yacht/sailing yacht with full specs; Used:
condition, price; 'Sell current ship (value N)'), Look around, Players here, Harbour info (berths with length/depth, fees, tug cost, anchor).
Ships list (Tab) includes AI ships with dest/ETA. Radar: AI ships grey, add the nearBerth marker, heading-up option toggle.

### `public/index.html`, `public/css/style.css`
Add the DOM for everything above; `#chartWrap` becomes full-screen with a toolbar; `#interiorHud`; `#rescueWrap`; `#weatherPanel`;
`#fishPanel`; `#berthLine`; `#touchHelm`. Mobile/touch: `body.touch` layout — bottom action bar of ≥ 44 px buttons (Dock, Chart, Ships,
Interior, Camera, More…), telemetry collapsed to 2 rows with a tap to expand, radar 150 px, panels full-screen with a sticky header and a
close button, `100dvh`, `env(safe-area-inset-*)`, no horizontal scroll, inputs ≥ 16 px font (iOS zoom), `touch-action: none` on the
canvas, landscape and portrait both usable. Update the welcome help text (real time, 1:1 world, berthing, interior, chart).

## 8. Reporting
Each agent ends with a structured report: files written, exports/API added, deviations from this contract (if any, with
the reason), known gaps, and the exact test command(s) it ran with their result.
