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

State: `lat, lon, hdg (deg), spd (kn), throttle (−0.3…1), rudder (−1…1)`.
* Throttle and rudder are *commands* that the actuators follow with lag (rudder lag grows as condition drops).
* Target speed = `maxKn · throttle · (1 − 0.35·(1−cond) − 0.5·flooding − 0.15·loadFrac)`; speed follows with
  first-order lag (τ = 25 s accelerating, 45 s decelerating).
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
