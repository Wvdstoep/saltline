# SALTLINE — Architecture Brief (prototype v0.1)

Saltline is a multiplayer 3D open-world maritime survival / trade / navigation sim running in the browser
(Three.js) against a Node.js authoritative-economy server (Express + ws). It is deployed on my-app.engineer
(App Runner, K3s). This brief is the ground truth that the GDD, the code and the tests are written against.

## 1. World model

* **Coordinates of truth are real WGS84 lat/lon (doubles) on the server and the wire.**
* The playable world is the real globe. Two raster layers are generated at server start from Natural Earth
  vector data (public domain) and cached to `data/cache/*.bin`:
  * `GLOBAL`: whole Earth, 0.05° cells (~5.5 km), from `ne_50m_land.geojson`.
  * `REGION`: North Sea / Channel / Skagerrak detail window lon −8…14, lat 48…62.5, 0.005° cells (~556 m),
    from `ne_10m_land.geojson` + `ne_10m_minor_islands.geojson`.
* Pipeline: GeoJSON polygons → scanline even-odd rasterisation into a Uint8 land mask → chamfer distance
  transform (cells to nearest coast, both directions) → synthetic bathymetry/topography:
  `h = land ? 3 + 8·d : −(2 + 6·d)` real metres (capped −200…+120). Harbours and river channels (Elbe,
  Scheldt, Thames, Humber, Nieuwe Waterweg, Göta älv, Oslofjord…) are carved as navigable water.
  Real GEBCO bathymetry is a drop-in replacement for the synthetic depth function (same tile API).
* Tile API: `GET /api/tile/{level}/{tx}/{ty}` → 65×65 Uint8 heights (`h_m = (v−110)·2`), 64 cells per edge
  with a 1-cell overlap so neighbouring meshes share an edge. Level 0 = GLOBAL, level 1 = REGION.
* Chart API: `GET /api/chart/world.png`, `GET /api/chart/region.png` (server-side PNG encoder, zlib) used by
  the in-game chart.
* **Rendering scale:** 1 game unit = 13 real metres for the world; ships are rendered at full real size.
  Kinematics run 39× real time (`MOTION_SCALE = 39`), which on a 1:13 world *looks* like ships moving ~3× real
  speed, while a Rotterdam→Hull leg (330 km) takes ~14 minutes at 20 kn. The sim clock also runs 39×
  (1 real second = 39 sim seconds) so fuel burn and wear are computed in realistic t/h and %/h.
* Client renders in a local tangent plane (equirectangular about a floating origin; origin re-centres when the
  player drifts > 20 km game units away) to keep float32 precision.
* Harbours: ~50 real-world harbours (lat/lon at the harbour entrance so they are navigable) in the detail
  region plus ~40 global ports. Each harbour has: fuel dock (price varies), repair yard, shipyard, job board,
  commodity market, optional black-market contact, port authority.
* OpenStreetMap extrusions: `scripts/fetch-osm.mjs` pulls building/industrial footprints within 1.5 km of each
  harbour from Overpass and caches them to `data/osm-harbors.json`; the client extrudes them as boxes around
  the pier. Procedural warehouses/cranes are the fallback when no OSM data is cached.
* Environment: global wind vector (slowly wandering), surface current field (analytic: North Sea cyclonic
  gyre, Channel eastward flow, Norwegian coastal current, plus global trade-wind/gulf-stream approximations).

## 2. Ship physics (shared/physics.js — identical code on server and client)

State: `lat, lon, hdg (deg), spd (kn), throttle (−0.6…1: the engine order telegraph, shared/telegraph.js; −0.6 = full astern), rudder (−1…1)`.
* Throttle and rudder are *commands* that the actuators follow with lag (rudder lag grows as condition drops).
* Target speed = `maxKn · throttle · (1 − 0.35·(1−cond) − 0.5·flooding − 0.15·loadFrac)`; speed follows with
  first-order lag (τ = 25 s) while gathering way ahead; slowing, stopping and going astern are propeller thrust against hull
  resistance with a per-class inertia (v0.5, shared/physics.js header): a coaster on STOP from full ahead drifts ~8 ship
  lengths, full astern stops her in ~3.3 lengths / ~90 s; astern top speed ≈ ½ ahead, rudder weaker astern, propeller walk.
* Yaw rate = `turnRate · rudder · f(spd)` (no steerage way below ~1 kn), multiplied by a steering penalty
  from condition (<40 % → sluggish, lag up to 4 s) and flooding.
* Velocity = forward·spd + current + 2 % wind leeway. Position integrates in lat/lon using real metres.
* Grounding: depth under keel < draft → speed zeroed, condition −5, flooding +0.05 if cond < 20.
* Visual-only (client): Gerstner wave sampling at bow/stern/beam → heave/pitch/roll; flooding lowers the
  waterline and adds list; sinking animation when flooding ≥ 1.

Ship classes (prototype): `coaster` (starter, 90 m, 14 kn, 1 200 t, fuel 80 t), `trawler` (45 m, 12 kn,
300 t fish hold), `feeder` (150 m container feeder, 20 kn, 4 000 t, fuel 300 t), `ferry` (120 m, 22 kn,
400 pax, 500 t).

## 3. Survival loop (server-authoritative)

* Fuel burn (t per sim-hour) = `burn · (0.1 + 0.9·throttle³) · (1 + 0.4·loadFrac) · (1 + 0.3·headwind) ·
  (1 + 0.25·(1 − cond/100))`. Fuel bought at harbour fuel docks; price differs per harbour. Empty tank →
  drifting; "Call a tow" costs money and resets to the nearest harbour.
* Condition (0–100): decays per sim-hour while under way (`0.15 + 0.6·throttle² + 0.3·(wind/20)`), not at
  dock. Visual degradation on the client is driven by condition: rust streaks (noise mask), barnacle band at
  the waterline, darkened/pitted paint, flaking superstructure. Physics penalties: speed and steering lag.
* Condition 0 → flooding rises 2 %/sim-min; flooding ≥ 1 → **sunk**: a persistent wreck is created at the
  position carrying the cargo; the player respawns at the nearest harbour with insurance (−2 000 credits) or,
  if broke, a forced reset (rust-bucket coaster, 500 credits).
* Repairs at the yard: `(100 − cond) · 120` credits; emergency patch kit at sea: +15 cond, −30 % flooding.

## 4. Dual economy

* Legal jobs per harbour: freight (A→B, tonnes, pay by distance), passengers (needs pax capacity, deadline),
  fishing (go to a named fishing ground, fish while < 3 kn, deliver). Jobs regenerate on a sim-hour timer.
* Commodity market per harbour (fish, grain, steel, machinery, containers, fuel) with drifting prices; buy
  low / sell high; also the medium for player-to-player trade.
* Black market: a hidden contact (press "Look around" at the harbour; 70 % present) offers 1–3 smuggling
  runs paying 4–6× legal rates; cargo flagged `contraband`.
* Authority: AI coast-guard cutters patrol chokepoints (Dover Strait, Elbe mouth, Skagerrak, Maas approach…).
  Encounter → hail → 30 s to heave to (< 2 kn). Comply → inspection (roll vs wanted level). Contraband found →
  fine (2× cargo value + 5 000) if affordable, else **impound** (ship towed to nearest harbour, cargo
  confiscated); at wanted ≥ 2 → **forced reset**. Fleeing → wanted +1 and pursuit at 30 kn. Port authority
  inspects on docking (12 %, 25 % if wanted). Wanted level decays over sim-days.

## 5. Multiplayer

* One persistent shard per server process. WebSocket JSON protocol, 10 Hz snapshots of all ships and AI
  boats, 10 Hz client state uploads. Movement is client-simulated with server plausibility checks (speed cap,
  land check); economy, damage, law, trades, convoys, piracy are server-authoritative.
* Player identity: a random token in localStorage; the server persists all players, wrecks, harbour markets
  and job boards to `data/state.json` every 30 s and on shutdown.
* Interactions (within 150 game units or both docked at the same harbour): **trade** (offer goods for credits,
  accept/decline), **convoy** (invite/accept/leave; convoy members share radar contacts and halve boarding
  success against them), **board** (piracy: target < 6 kn, closing speed < 4 kn; 55 % success, −25 % if the
  target is escorted; steals half of each stack; boarder gains wanted +2), **salvage** wrecks (cargo recovery).
* Wrecks persist until salvaged or 48 sim-hours; everyone sees them on radar as grey ✕ blips.

## 6. Navigation UI

* Radar: circular 2D canvas, selectable range, blips: harbours (green ■), players (white ●, convoy cyan),
  coast guard (red ▲), wrecks (grey ✕), fishing grounds (blue ~), waypoint (yellow ◇). North-up, range rings.
* Telemetry: SOG (kn), COG/HDG, lat/lon (DMS), depth under keel, wind, current set/drift, fuel (t, %),
  condition, flooding, cargo (t / capacity), credits, wanted level, sim clock, ETA to waypoint.
* Chart (M): world/region PNG with harbours and contacts; click to set a waypoint; autopilot (P) steers to it.

## 7. Asset classes

Procedural (prototype): hulls, superstructures, containers, cranes, warehouses, piers, buoys, lighthouses,
coast-guard cutters, wreck markers, water shader, sky gradient, terrain vertex colouring. Production: PBR ship
kits with wear masks, harbour kits, vegetation cards, skybox HDRIs, audio.

---

# v0.2 addendum (real time, weather, market, interior)

## Scale and time
* **1 game unit = 1 real metre** (`GEO.SCALE = 1`) and **kinematics run in real time** (`SIM.MOTION_SCALE = 1`).
  The sim clock IS the wall clock (`simTime` = Unix seconds); day/night follows real local solar time.
* Voyages take as long as they really take. The crew keeps sailing an autopilot course while the skipper is
  offline (`action: set_voyage {lat, lon, throttle}` / `{clear: true}`; the server runs `stepShip` for offline
  players with a voyage and stops them on shoal water). The only way to skip ahead is a paid **express passage**
  (`action: express {lat, lon}`: `SIM.EXPRESS_CR_PER_NM` credits per nautical mile, plus the fuel and wear the leg
  would have cost; refused while hailed or docked).
* Interaction ranges (`INTERACT`) are metres now.

## Weather
* `game.weatherAt(lat, lon)` → `{ wind:{u,v,spd,dir}, sea (0..1), storm (0..1), rain (0..1) }`: the global
  wandering wind plus cyclonic storm cells (`storms[]`: `{id,name,lat,lon,radiusKm,intensity}`), which spawn,
  drift, peak and die over hours. Storms slow ships (`env.sea`), triple wear above 17 m/s, flood a failed hull
  faster, cut fishing, and are broadcast in every snapshot (`snap.storms`) and the player's `you.weather`.
* Client: `you.weather` drives sea state, spray/rain, sky, fog and lightning; chart/radar show storm cells.

## Ships and market
* 17 classes in `SHIP_CLASSES` with `cat` (cargo / working / passenger / motor yacht / sailing yacht), `crewCost`
  (credits per hour under way), `wearMul`, `towPower` (tugs) and `sail`/`auxKn` (sailing yachts drive through a
  polar in `shared/physics.js: sailPolar`; `action: sails {up}` furls/sets them; engine throttle is the auxiliary).
* Shipyard sells new hulls (`harbor.shipyard`, grouped by `cat`); each harbour also lists second-hand hulls
  (`harbor.used`: `{id, cls, cond, price}`, `action: buy_used {listingId}`); your current ship is traded in at
  `shipValue(cls, cond)`. Repairs cost `repairCostFor(cls, cond)` (scales with hull value); port dues scale with
  displacement and harbour class; crew wages are deducted per hour at sea.

## Contracts (all types, with earnings, visible for every harbour at `GET /api/jobs`)
`freight` (A→B tonnes), `passengers`, `charter` (needs a yacht or ferry, `needsCat`), `fishing` (catch on a named
ground; only *caught* fish count — `cargo[].caught`), `supply` (load offshore supplies, hold station within
`PLATFORM_RANGE_U` of a real platform from `PLATFORMS`, `action: deliver_offshore {jobId}`), `tow` (a disabled
vessel at `job.at`; `action: tow_pickup {jobId}` within `TOW_RANGE_U` at < 3 kn; towing cuts speed by a third
unless you are a tug, burns 30 % more fuel; paid on docking at `job.to`), `smuggling` (black market).
Contract cargo is never sellable; abandoning returns/dumps it and charges a 10 % fee. Short deliveries pay pro rata.

## Sinking and rescue
Flooding ≥ 1 → wreck (cargo persists for salvage) → the player is **adrift** (`you.rescue`): the nearest
harbour launches a lifeboat (25 kn, < 40 km) or a SAR helicopter (150 kn), visible to everyone (`snap.rescues`),
capped at 25 minutes. On arrival the player lands at that harbour with the insurance coaster (or a forced reset).

## Fishing telemetry
`you.fishInfo = { ground, rate (t/h), caught (t this haul), tooFast }` while nets are out.

## Anti-cheat
Movement plausibility is a distance budget (max speed × elapsed, capped at 5 s of banked distance); every
rejection answers with `{t:'you', correction:true}` which the client must snap to. All numeric fields are
sanitised; prototype keys are rejected as goods; hails cannot be escaped by docking, towing or disconnecting.

# v0.3 addendum (real harbours, environment, traffic, interior, chart, mobile)

Contract reference: `docs/V3-CONTRACTS.md` (file ownership, byte layouts, message shapes).

## Harbour geometry (`server/osm.js`, `server/harborgeom.js`, client `harborgeom.js`)
Every harbour gets a local **patch**: a 448 × 448 raster at 10 m (4.5 km square) in a metre frame centred on the
harbour point (x east, z south; `patchCellToLatLon/latLonToPatchCell` in `shared/constants.js`). Two Uint8 planes:
heights (`h = (v − 128) × 0.25 m`) and a **mask** (water, land, quay/pier, breakwater, pontoon, fairway, shallows).
Served as `GET /api/harbor/:id/patch` (binary `SLHP`, gzip) and `GET /api/harbor/:id/geom` (vector features:
quays, piers, breakwaters, pontoons, buildings with heights, tanks, cranes, lights, IALA buoys, berths, fairway, anchor).
Source: OpenStreetMap through Overpass when reachable (coastline ways closed against the patch bbox — land on
the left of the way — plus `man_made`, `waterway=dock`, `leisure=marina`, `seamark:*`, `building`), cached in
`data/osm/*.json` and `data/geom/*` ; otherwise a deterministic **synthetic** harbour anchored to the Natural-Earth
coast (breakwaters, quays cut into the land, dredged basin, fairway, warehouses, lighthouse, lateral buoys).
`scripts/fetch-osm.mjs` prefetches all harbours (run on the production box; the dev container has no Overpass access).

The client decodes the patch, builds a **signed distance field** from the mask (chamfer transform, metres) and
uses it for hull collision (`collision.js`: hull sample points pushed out along the SDF gradient, inward velocity
removed, damage reported with `action: collision {speedKn, kind}`), for depth under keel and for the
high-resolution terrain mesh (`terrain.addPatch`; the coarse tiles are sunk under the patch footprint, the same
trick as the region cut-out). `harbor.js` extrudes the vector features; the old floating platform is gone.

## Berthing and tugs
`dock` now means **moor at a berth**: within 60 m of a berth at ≤ 2 kn the ship is snapped alongside
(`you.berth`). `you.nearBerth` gives distance/bearing to the nearest berth within 2.5 km. `tug_assist` (within
1.5 km of the anchor, ≤ 6 kn, paid by displacement) has the server walk the ship to the berth over 45 s
(`you.assist`; the client suspends its own simulation). Casting off spawns 20 m off the berth face. Harbours
without built geometry fall back to the v0.2 radius rule. Fees: port dues (dock), pilotage for > 90 m hulls at
mega/major ports, berth fee per started day (undock), yard `service` every 30 sailing days or wear climbs.

**v0.5 tugs** (`server/tugpath.js`, `server/tugassist.js`, client `public/js/tugs.js`): the assist follows a water-only
path — A* over the harbour patch with centre clearance ≥ half beam + 10 m and keel depth (heights + tide − draught − 0.5 m),
string-pulled, corners rounded, bow/stern swept clear, ending with a run parallel to the quay and a sideways push onto
the berth; no such path → refused, nothing charged (no built patch → the old straight walk). 1 tug under 60 m, 2 above
(bow + stern on lines, pushing on the outboard side at the end) sail out from the nearest tug station and home again;
~4 kn in the basins, ~1 kn over the last 150 m; the assist clock is fast-forwarded (`you.assist.rate`, ≤ 5×) to keep it
under ~4 minutes. Tug positions: `you.assist.tugs` and `snap.players[].tugs` (`{id, lat, lon, hdg, spd, mode
transit|tow|push, thrust, line: [fwd, stbd] | null, end, ff?}`; `ff` = fast-forward factor while the assist runs, so the
client draws the wake for the real speed), also `you.assist.phase/phaseText`. The tugs sail home in real time; the tug
assist prefers a free berth (no skipper lying at it or being brought to it); watchdogs make the tugs fast if they cannot
reach their station alongside, and finish an assist that overruns 15 min at its berth.

## Environment
* **Weather** — Open-Meteo forecast + marine endpoints per 0.5° cell, 20-minute TTL, concurrency-limited,
  offline-safe (`server/weather.js`); `game.weatherAt` merges it with the synthetic storm cells (only when no real
  data). `you.weather` carries wind/gust, waves, swell, visibility, pressure, temperature, cloud, source.
* **Tide** — `shared/tide.js`: M2/S2/N2/K1/O1 harmonics with a regional amplitude table and coast-following phase;
  `you.tide = {height, rate, stream, nextHigh, nextLow}`; the ocean mesh rides the tide, depth under keel includes
  it, the tidal stream is added to the surface current for every simulation (client, server offline voyages, AI).
* **AI traffic** — `server/lanes.js` sea-lane graph (land-checked edges, Dijkstra) and `server/traffic.js`
  (~90 ships with classes, flags, destinations, mooring/anchoring states); snapshots are per-socket with
  `ai: traffic.near(lat, lon, 40 km)`; `GET /api/ai` lists everything. The client renders them with the same
  models and ship–ship collision applies.

## Client
* **Ocean** — 8 wind-sea Gerstner components clustered on the wave direction + 2 swell components scaled to
  the significant wave height, procedural normal detail, Schlick fresnel, roughness-dependent specular, whitecaps,
  shore foam, rain ripples; `setSea`, `setLevel` (tide), `setRain`. **Weather FX** — cloud layer, rain streaks,
  lightning. **Ships** — all 17 classes + cutter, lifeboat, helicopter, derelict; world-space foam wake ribbon;
  sails that sheet to the wind; nav lights; offshore platforms.
* **Interior** (`interior.js`) — walkable bridge, passage, engine room, cabins, mess; first person with pointer
  lock or touch; hotspots (helm, engine panel, bunk, chart table, radio). Child of the ship group, so it rides the sea.
* **Chart** (`chart.js`) — Web Mercator, pan/zoom/pinch, OSM raster + OpenSeaMap seamarks at zoom ≥ 7 (fetched
  by the player's browser), every job board, AI/players/cutters/storms/rescues, routes with ETA, lanes, cursor
  lat/lon/depth/tide.
* **Mobile** — `touch.js` virtual helm (throttle and rudder sliders, big buttons, interior stick), `body.touch`
  layout with a bottom action bar, full-screen panels, safe-area insets, pinch camera zoom.

## Not in v0.3 (roadmap)
Real bathymetry (EMODnet/GEBCO) under the synthetic depth model; GLTF ship models; fully server-authoritative
movement (the server validates distance budgets and land penetration, the client still integrates); COLREGS
behaviour for AI traffic; AI captains that trade on the markets.
