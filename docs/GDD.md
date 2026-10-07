# SALTLINE — Game Design Document & Technical Implementation Plan

**Version:** 1.0 (written against Prototype v0.1 — see `docs/ARCHITECTURE.md`)
**Genre:** Multiplayer 3D open-world maritime survival, trade and navigation simulation
**Platform:** Browser (Three.js / WebGL2) + Node.js authoritative-economy server (Express + ws), deployed on my-app.engineer (App Runner, K3s)
**Tone reference:** the visual weight and "heavy steel" physics feel of *World of Warships*, applied to a non-combat-first world of freight, fuel, weather, rust and the law.

> **Reading guide.** Everything marked **[Prototype v0.1]** is implemented in the current build and is the contract the code and tests are written against. Everything marked **[Roadmap]** is not in the build and is specified here as concrete engineering steps. Where a formula is given, it is the formula in `shared/` or `server/`, not an aspiration.

---

## Vision statement

Saltline is a game about *keeping a ship alive on a real ocean*. There is no arcade respawn loop: the sea is the real sea, the harbours are real harbours with their real approaches, fuel costs money, steel rusts, and the coast guard is not a cutscene. Players earn their living by moving things from one real port to another, legally or otherwise, and share one persistent ocean with every other player on the shard. The three design pillars that every system must serve are:

1. **Weight.** Ships accelerate, turn and stop like thousands of tonnes of steel. Nothing is instant.
2. **Consequence.** Fuel, wear, cargo, fines and wrecks persist. A ship that sinks stays on the seabed for everyone.
3. **Truth.** The world is the real globe. Rotterdam is at 51°57′N 004°03′E and the Dover Strait is as narrow as it really is.

---

# Part A — Technical Systems

## A1. Real-World Geospatial Environment

### A1.1 Coordinate model and the continuous globe

**[Prototype v0.1]** The coordinates of truth are real WGS84 latitude/longitude as IEEE doubles, on the server and on the wire. There is no "game map" that approximates the Earth; the playable world *is* the globe, continuous across the antimeridian (`wrapLon`) and clamped at the poles (`clampLat`). All distance, bearing and speed calculations in `shared/geo.js` use real metres (`M_PER_DEG_LAT = 110 574`, `M_PER_DEG_LON_EQ = 111 320 · cos φ`).

Two scale decisions make a real-size ocean playable in a session:

| Quantity | Value | Why |
|---|---|---|
| World render scale | 1 game unit = 13 real metres | Compresses the ocean so coastlines, harbours and other players are visible on screen without destroying the sense of distance |
| Ship render scale | 1 game unit = 1 metre (full real size) | A 150 m feeder reads as a 150 m feeder; cranes, containers and piers are built at the same scale |
| Kinematic time scale | `MOTION_SCALE = 39` sim-s per real-s | On a 1:13 world a ship *looks* like it moves ~3× real speed; a Rotterdam→Hull leg (330 km) takes ~14 real minutes at 20 kn |
| Clock scale | `CLOCK_SCALE = 39` | Fuel burn, wear, markets, wanted decay and job timers tick in realistic t/h and %/h on the sim clock (1 sim-hour ≈ 92 real seconds; 1 sim-day ≈ 37 real minutes) |

**[Roadmap]** Scale factors remain constants in `shared/constants.js` so that a dedicated "1:1 realism" shard can be launched with `SCALE = 1`, `MOTION_SCALE = 1` and no code changes.

### A1.2 Data ingestion pipeline

**[Prototype v0.1] — Natural Earth → raster land mask → distance transform → synthetic bathymetry.**

```
ne_50m_land.geojson ─┐
                     ├─► scanline even-odd rasteriser ─► Uint8 land mask ─► chamfer distance transform (3-4) ─► height field ─► data/cache/*.bin
ne_10m_land.geojson ─┤                                     (1 = land)         d = cells to nearest coast         h(d, land)
ne_10m_minor_islands ┘                                                        (both directions)
```

Two raster layers are generated at server start (`scripts/build-world.mjs`, also run on first boot) and cached:

| Layer | Level | Window | Cell size | Grid | Source |
|---|---|---|---|---|---|
| `GLOBAL` | 0 | lon −180…180, lat −90…90 | 0.05° (~5.5 km) | 7 200 × 3 600 = 25.9 M cells | `ne_50m_land` |
| `REGION` | 1 | lon −8…14, lat 48…62.5 (North Sea / Channel / Skagerrak) | 0.005° (~556 m) | 4 400 × 2 900 = 12.8 M cells | `ne_10m_land` + `ne_10m_minor_islands` |

Step detail:

1. **Rasterisation.** Every polygon ring (including holes, so inland seas such as the IJsselmeer come out as water when present in the lake layer) is scan-converted with the even-odd rule into a `Uint8Array` land mask at the layer's cell size. Antimeridian-crossing rings are split before rasterising.
2. **Distance transform.** A two-pass chamfer (3-4) transform yields, for every cell, the distance in cells to the nearest coastline — measured into the sea for water cells and into the land for land cells. This single pass gives both a bathymetry proxy and a topography proxy.
3. **Synthetic height.** `h = land ? 3 + 8·d : −(2 + 6·d)` in real metres, capped to −200…+120. At REGION resolution this gives −8 m one cell offshore, −62 m ten cells (5.6 km) out, and the −200 m cap at ~18 km — a credible continental-shelf profile for the North Sea without any external bathymetry.
4. **Harbour and channel carving.** Because the Natural Earth coastline closes estuaries and ports, navigable water is explicitly carved: a list of polylines with width and target depth (Elbe to Hamburg, Scheldt to Antwerp, Thames to Tilbury, Humber to Hull/Immingham, Nieuwe Waterweg to Rotterdam, Göta älv to Gothenburg, the Oslofjord, Kiel Canal approaches and ~50 harbour basins) is rasterised into the mask with `land = 0` and `h = −(channelDepth)`. Every harbour point is placed **at the harbour entrance**, so a ship can always reach the dock radius (`DOCK_RADIUS_U = 220` game units) from open water.

**[Roadmap] — GEBCO bathymetry (M2).** The synthetic depth function is a plug-in behind the tile API. Replacement plan:

* Download GEBCO_2024 (15 arc-second, ~7.5 GB NetCDF). Reproject to the two layer grids with GDAL (`gdalwarp -r average` for GLOBAL, `-r bilinear` for REGION), producing Int16 metres.
* Composite: `h = gebco(cell)` where GEBCO is valid; keep the carved channel depths as a minimum-depth override so harbours remain navigable where GEBCO shows mudflats; keep the Natural Earth land mask as the authority on *where land is* (GEBCO's zero contour and NE's coastline disagree by up to one cell).
* Add real tidal height from a harmonic model (M2, S2, N2, K1, O1 constituents per region) so that depth under keel varies with the sim clock. Drying heights in the Wadden Sea become a real hazard.

**[Prototype v0.1] — OpenStreetMap extrusions.** `scripts/fetch-osm.mjs` queries Overpass for `building=*`, `landuse=industrial`, `landuse=port`, `man_made=pier|crane|storage_tank` within 1.5 km of each harbour point and caches simplified footprints (Douglas–Peucker, 5 m tolerance) with a height estimate (`building:levels × 3.2 m`, else tag-based defaults: tank 18 m, warehouse 12 m, crane 45 m) to `data/osm-harbors.json`. The client extrudes footprints as flat-shaded boxes in the harbour's local tangent plane. When no OSM data is cached for a harbour, the procedural warehouse/crane/pier kit is placed around the pier instead.

**[Roadmap] — OSM at M2:** add `natural=coastline` ways for a vector shoreline at REGION level (replacing the staircase of 556 m cells with a true polyline within 5 km of harbours), `seamark:*` tags for real buoys, beacons and light characteristics, and `waterway=river` centrelines for the channel-carving list so that new regions need no hand-authored polylines.

### A1.3 Tile and chart APIs

**[Prototype v0.1]**

| Endpoint | Returns | Notes |
|---|---|---|
| `GET /api/tile/{level}/{tx}/{ty}` | 65 × 65 `Uint8` heights, `h_m = (v − 110) · 2` | 64 cells per edge plus a 1-cell overlap so neighbouring meshes share an edge (no cracks). 4 225 bytes, cache-forever headers, ETag. Level 0 tile = 3.2°, level 1 tile = 0.32° |
| `GET /api/chart/world.png` | Equirectangular chart of the GLOBAL layer | Server-side PNG encoder (zlib), palette: deep/shallow/land/harbour |
| `GET /api/chart/region.png` | Chart of the REGION layer | Same encoder, 1 px per cell |
| `GET /api/harbors` | Harbour list with lat/lon, services, OSM availability | Static per boot |

The client keeps a 5 × 5 ring of level-1 tiles around the player (≈ 1.6° square) and a 3 × 3 ring of level-0 tiles for the horizon; each tile is a 64 × 64 quad grid with vertex colours derived from height (sand → grass → rock) and a `depth` vertex attribute consumed by the water shader for shoreline foam and colour.

**[Roadmap]** Level 2 (0.001°, ~111 m) tiles generated on demand from GEBCO + OSM coastline for the 2 km around each harbour; CDN-fronted tile cache; GPU displacement with a clipmap instead of discrete tiles.

### A1.4 Projection and floating origin

**[Prototype v0.1]** The client renders in a **local tangent plane**: an equirectangular projection about a floating origin `(lat₀, lon₀)` with `x = (lon − lon₀) · M_PER_DEG_LON_EQ · cos lat₀ / SCALE` and `z = −(lat − lat₀) · M_PER_DEG_LAT / SCALE`. When the player drifts more than `ORIGIN_RESHIFT_UNITS = 20 000` game units (260 km of real sea) from the origin, the origin is re-centred on the player and every scene object is re-projected in one frame. This keeps float32 vertex precision below 2 mm anywhere on Earth and avoids the "jitter at 1 000 km" problem of a single world-space origin.

**[Roadmap]** Switch to a true ellipsoidal ECEF model with the tangent plane computed from the local normal, so that the horizon curves correctly at render distances above 50 km and polar regions project without distortion.

### A1.5 Environment

**[Prototype v0.1]** A global wind vector that wanders slowly (Ornstein–Uhlenbeck on direction and speed, 0–22 m/s) and an **analytic surface current field** `currentAt(lat, lon, t)` with: the North Sea cyclonic gyre about 56°N 3°E (0.25 m/s), the eastward Channel stream with a semi-diurnal tidal component (0.35 ± 0.5 m/s), the Norwegian coastal current (0.3 m/s north), a crude Gulf Stream (0.6 m/s), equatorial westward drift and the Antarctic Circumpolar Current. Currents are identical on client and server because the function lives in `shared/physics.js`.

**[Roadmap]** Replace the analytic field with a gridded 0.25° field from Copernicus Marine (CMEMS) surface currents and ERA5 10 m winds, resampled to a 6-sim-hour cadence; ship the field as a 2-channel R8G8 texture per tile so the client can sample it in the vertex shader for wave direction.

### A1.6 Spatial navigation UI specification

**[Prototype v0.1]** Three instruments, all drawn on 2D canvases layered over the WebGL view.

**Radar (bottom-left, 260 px).** North-up, centred on own ship, with range rings. Range selectable 2 / 5 / 12 / 30 / 80 nm (keys `[` `]`).

| Blip | Glyph | Colour | Source |
|---|---|---|---|
| Harbour | ■ | green `#3ad27a` | static harbour list |
| Other player | ● | white | `snap` |
| Convoy member | ● | cyan `#4fd8ff` | `snap` + convoy roster |
| Coast-guard cutter | ▲ | red `#ff4d4d` | `snap` (AI boats) |
| Wreck | ✕ | grey `#9a9a9a` | `snap.wrecks` |
| Fishing ground | ~ | blue `#4a8cff` | static |
| Active waypoint | ◇ | yellow `#ffd43b` | local |
| Own heading line | — | white | local |

Convoy members' radar contacts are merged into the member's own radar (shared contacts), so a convoy sees further than any single ship.

**Telemetry strip (top).** Fields, in order, with formats:

| Field | Format | Example |
|---|---|---|
| SOG | `0.0 kn` | `13.6 kn` |
| COG / HDG | `000° / 000°` | `047° / 044°` |
| Position | DMS, `DD°MM′SS.s″ N DDD°MM′SS.s″ E` (toggle to decimal degrees `51.95389, 4.04722` with `G`) | `51°57′14.0″N 004°02′50.0″E` |
| Depth under keel | `0.0 m`, turns amber < 3 m, red < 1 m | `12.4 m` |
| Wind | `ddd°/ss m/s` (from) | `230°/11 m/s` |
| Current | `set ddd° drift s.s kn` | `set 085° drift 0.7 kn` |
| Fuel | `tt.t t (pp %)`, amber < 20 %, red < 8 % | `31.2 t (39 %)` |
| Condition | `pp %` with the degradation stage name | `58 % — Weathered` |
| Flooding | `pp %` (hidden unless > 0) | `12 %` |
| Cargo | `tttt / cccc t` | `840 / 1200 t` |
| Credits | `¤ n,nnn` | `¤ 14,250` |
| Wanted | `☆☆☆` → `★★☆` | |
| Sim clock | `Day d HH:MM` | `Day 3 14:20` |
| ETA to waypoint | `hh:mm sim (mm:ss real)` | `03:40 sim (05:38 real)` |

**Chart (key `M`).** Full-screen overlay showing `world.png` or `region.png` with harbours, own ship, convoy, contacts, wrecks and fishing grounds. Click to set a waypoint; `P` toggles the autopilot which steers a great-circle course to it (rudder PD controller on bearing error, throttle unchanged). Range/bearing from own ship to the cursor is shown live.

**[Roadmap]** ECDIS-style vector chart with depth contours and seamarks; route planning with multiple waypoints and fuel-to-destination estimate; AIS-style target list with CPA/TCPA; a 3D compass rose on the bridge.

---

## A2. Physical Survival & Boat Maintenance

### A2.1 Ship physics (shared)

**[Prototype v0.1]** `shared/physics.js` is identical on the server (plausibility checks, AI boats) and the client (simulation). State: `lat, lon, hdg (°), spd (kn), throttle (−0.3…1), rudder (−1…1)`, plus the commanded values. Per step (`dt` real seconds):

1. **Actuator lag.** `steerPenalty = 1 − 0.6·(1−cond)^1.5 − 0.5·flooding`; `rudderRate = 1 / (1.2 + 3·(1 − steerPenalty))` per second. Throttle slews at 0.25/s. An empty tank forces both commands to 0.
2. **Speed.** `target = maxKn · throttle · (1 − 0.35·(1−cond) − 0.5·flooding − 0.15·loadFrac)`, first-order lag with τ = 25 s accelerating, 45 s decelerating.
3. **Yaw.** `yawRate = turnRate · rudder · min(1, |spd| / (0.5·maxKn)) · max(0.15, steerPenalty)` — no steerage way below ~1 kn.
4. **Velocity.** forward·spd + current + 2 % wind leeway; position integrates in lat/lon using real metres, scaled by `MOTION_SCALE`.
5. **Grounding.** Water depth < draft → `grounded`: speed zeroed, condition −5, flooding +0.05 if condition < 20.
6. **Client-only visuals.** Gerstner wave height sampled at bow, stern and both beams → heave, pitch and roll; flooding lowers the waterline and adds list; sinking animation when flooding ≥ 1.

| Class | Length | Max | Turn rate | Displacement | Capacity | Pax | Fuel | Burn (t/sim-h @100 %) | Price |
|---|---|---|---|---|---|---|---|---|---|
| `coaster` (starter) | 90 m | 14 kn | 5.5°/s | 3 200 t | 1 200 t | 12 | 80 t | 0.9 | 0 |
| `trawler` | 45 m | 12 kn | 8°/s | 900 t | 300 t fish | 4 | 40 t | 0.5 | 180 000 |
| `feeder` | 150 m | 20 kn | 4°/s | 14 000 t | 4 000 t | 8 | 300 t | 3.2 | 950 000 |
| `ferry` | 120 m | 22 kn | 5°/s | 9 000 t | 500 t | 400 | 200 t | 2.6 | 700 000 |

### A2.2 Fuel economy

**[Prototype v0.1]** Burn in tonnes per **sim-hour**:

```
burn_t_h = burn · (0.1 + 0.9·throttle³) · (1 + 0.4·loadFrac) · (1 + 0.3·headwind) · (1 + 0.25·(1 − cond/100))
```

where `headwind ∈ 0…1` is `headwindFactor(hdg, wind)` (1 = straight into a 20 m/s wind) and `loadFrac = cargo / capacity`. The cubic throttle term is the propeller law: half throttle burns 21 % of full-throttle fuel. The server integrates this on its 10 Hz tick using the sim clock; the client shows a prediction.

**Worked examples**

| Ship | Throttle | Load | Headwind | Cond | Burn (t/sim-h) | Speed | Range on full tank |
|---|---|---|---|---|---|---|---|
| coaster | 0.8 | 50 % | 0.5 | 70 % | 0.9·0.561·1.2·1.15·1.075 = **0.75** | 14·0.8·(1−0.105−0.075) = 9.2 kn | 80 / 0.75 = 107 sim-h ≈ 980 nm ≈ 2.7 real h |
| coaster | 0.5 | 0 % | 0 | 100 % | 0.9·0.2125 = **0.19** | 7.0 kn | 420 sim-h ≈ 2 940 nm |
| feeder | 1.0 | 75 % | 0 | 90 % | 3.2·1.0·1.3·1.025 = **4.26** | 20·(1−0.035−0.1125) = 17.1 kn | 70 sim-h ≈ 1 200 nm |
| ferry | 1.0 | 20 % | 1.0 | 100 % | 2.6·1.08·1.3 = **3.65** | 21.3 kn | 55 sim-h ≈ 1 170 nm |

**Rotterdam → Hull (178 nm) in the loaded feeder:** 10.4 sim-h (≈ 16 real minutes), 44.5 t of fuel ≈ ¤ 28 900 at the base price of ¤ 650/t.

**Fuel purchase.** Only at harbour fuel docks. Each harbour has its own price: `price = 650 · regionFactor · (1 + 0.15·sin(drift))`, with Rotterdam/Antwerp the cheapest in the region (bunkering hubs, factor 0.9) and small Norwegian ports the dearest (1.35). The player chooses tonnes to buy; weight affects `loadFrac`-independent displacement only in the roadmap. Running dry at sea → the ship drifts on current and leeway with rudder dead. **Call a tow** (`¤ 1 500 + 12 · nm` to the nearest harbour) resets position to that harbour with 5 t in the tank.

**[Roadmap]** Separate heavy-fuel/diesel grades with price and condition effects; ECA zones (North Sea is a real emission-control area) where HFO use attracts fines; fuel weight included in displacement and draft.

### A2.3 Wear-and-tear system

**[Prototype v0.1]** Condition 0–100 decays per sim-hour **while under way** (not at dock):

```
wear_pts_h = 0.15 + 0.6·throttle² + 0.3·min(2, windSpeed/20)
```

A coaster cruising at 0.8 throttle in a 10 m/s breeze loses 0.69 pts/h ≈ 6 pts per 20-minute real session leg; running flat out through a gale loses 1.35 pts/h, i.e. 100 → 0 in about 1.9 real hours of unbroken abuse. Grounding costs 5 points instantly. Repairs at any harbour repair yard cost `(100 − cond) · 120` credits (full restore from 40 %: ¤ 7 200). An emergency patch kit (¤ 900, carried, max 2) gives +15 condition and −30 % flooding at sea.

**Visual degradation stages** (client, driven by `cond`; all masks are procedural noise in the hull shader in the prototype, authored wear masks in production):

| Stage | Condition | Hull & deck | Waterline | Superstructure | Audio |
|---|---|---|---|---|---|
| Shipshape | 100–80 | Clean paint, full specular | Clean boot-topping | Clean | Engine smooth |
| Weathered | 80–60 | Rust streaks below scuppers, hawse pipes and hatch corners (streak mask, 15 % coverage) | Thin green slime band | Faded paint, chalking | — |
| Neglected | 60–40 | Streaks widen, pitting on bulwarks (mask 40 %), paint darkens | Barnacle band 0.6 m, visibly rough | Flaking paint cards, rust on rails | Occasional metallic groan |
| Rotten | 40–20 | Large rust plates, orange bloom on 60 % of plating, deck timbers grey and split | Thick barnacle/weed band 1.2 m | Broken windows, missing panels, cranes seized | Steering "clunk" on rudder |
| Derelict | 20–0 | Holed plating decals, exposed frames, rotting wood | Weed trails streaming | Soot, hanging cables | Bilge pump alarm when flooding > 0 |

**Physics penalties** (from `stepShip`):

| Condition | Speed factor `1 − 0.35(1−cond)` | Steering factor `1 − 0.6(1−cond)^1.5` | Rudder full-travel time | Fuel factor `1 + 0.25(1−cond)` |
|---|---|---|---|---|
| 100 % | 1.00 | 1.00 | 1.2 s | 1.00 |
| 60 % | 0.86 | 0.85 | 1.7 s | 1.10 |
| 40 % | 0.79 | 0.72 | 2.0 s | 1.15 |
| 20 % | 0.72 | 0.57 | 2.5 s | 1.20 |
| 0 % | 0.65 | 0.40 | 3.0 s (4.0 s with full flooding) | 1.25 |

Below 40 % the ship is noticeably sluggish; below 20 % every grounding starts a leak.

**[Roadmap]** Per-subsystem condition (hull, engine, steering gear, pumps) with separate repair line items; weather exposure accumulating per plate so rust appears where spray hits; dry-dock queue times so repairs are not instant.

### A2.4 Sinking mechanics

**[Prototype v0.1] — Flooding and buoyancy model.**

* When `cond = 0`, flooding rises 2 % per sim-minute (≈ 1.3 real minutes from first leak to loss), and faster if the ship keeps grounding. Patch kits are the only at-sea remedy; a repair yard is the real fix.
* Flooding feeds back into physics immediately: −50 % target speed at full flooding and halved steering authority (see the formulas above), so a flooding ship cannot outrun its fate.
* Client buoyancy: the hull's rest height is lowered by `flooding · freeboard` and a list of up to 18° is applied around the longitudinal axis (sign fixed per ship so cargo appears to have shifted); wave response gains +40 % roll amplitude as metacentric height drops.
* `flooding ≥ 1` → **sunk** (server-authoritative event): the client plays a 20-second bow-up settling animation and fade; the server creates a **persistent wreck** at the position carrying the entire cargo manifest, removes the player's ship, and respawns the player at the nearest harbour under one of two outcomes:
  * **Insurance** — ¤ 2 000 deducted; the same class is returned at 35 % condition, empty tank 20 %, empty hold.
  * **Forced reset** — if credits < 2 000: a rust-bucket coaster (25 % condition) and ¤ 500.
* Wrecks persist for 48 sim-hours (≈ 74 real minutes) or until salvaged, are visible to everyone as grey ✕ blips, and can be salvaged by any player within `SALVAGE_RANGE_U = 100` — including the owner, which is the intended "go back for your cargo" loop.

**[Roadmap]** Compartment-based flooding (bow/mid/stern tanks) with trim and progressive flooding through bulkheads; wrecks that settle on real GEBCO bathymetry with a visible mast above water in shallow seas; diver salvage minigame.

---

## A3. The Dual Economy

### A3.1 Legal jobs

**[Prototype v0.1]** Every harbour has a job board regenerated on a sim-hour timer (3–8 open jobs, biased towards the harbour's trade profile: Hull offers fishing and grain, Rotterdam containers and machinery, Bergen passengers and fish).

| Type | Requirement | Generation | Payout (credits) | Failure |
|---|---|---|---|---|
| **Freight** | Cargo capacity ≥ tonnes | Destination drawn from harbours 40–600 nm away; tonnes 20–90 % of the board's class target; goods by profile | `tonnes · (3 + 0.15·dist_nm) · goodsFactor` (grain 1.0, steel 1.1, machinery 1.3, containers 1.4) | None (cargo kept and sellable at the market) |
| **Passengers** | `pax` capacity ≥ count | 10–380 pax, destinations 30–400 nm; deadline `1.6 · dist / maxKn` sim-hours from pickup | `pax · (40 + 1.1·dist_nm)`; −50 % if late | Late beyond 2× deadline: pax disembark at the next harbour, no pay |
| **Fishing** | Fishing permit (free) | A named fishing ground (Dogger Bank, Fladen, Viking Bank, Skagerrak deep…) within `FISH_RADIUS_U = 1 200`; fish accrues at `fishRate` t/sim-min while SOG < 3 kn inside the ground | Market price at delivery (`fish` base ¤ 1 400/t, drifting ±25 %) | Fish spoil 2 %/sim-h after 24 sim-h |

**Worked payouts:** 1 000 t of grain Rotterdam→Hull in the coaster pays ¤ 29 700; fuel ≈ ¤ 9 900, wear ≈ ¤ 1 400 → net ≈ ¤ 18 000 for 20 real minutes. The same leg with 3 000 t of containers in the feeder pays ¤ 124 700 for ≈ ¤ 30 000 in costs. A full trawler hold (300 t) sells for ≈ ¤ 420 000 but takes 100 sim-minutes of trawling plus the transit.

**Commodity market.** Each harbour holds a stock and price for fish, grain, steel, machinery, containers and fuel. Prices drift with a mean-reverting random walk around the good's base and respond to player sales (−3 % per 100 t sold, recovering over 6 sim-hours). This is also the medium of player-to-player trade (A4.6).

### A3.2 The black market

**[Prototype v0.1]** While docked, **Look around** (`L`) spends 10 sim-minutes and reveals a hidden contact with 70 % probability (seeded per harbour per sim-day, so the same contact is there for everyone that day). The contact offers 1–3 smuggling runs: cigarettes, crated weapons, narcotics or looted antiquities, 5–120 t, to a destination 60–500 nm away, paying **4–6× the legal freight rate** for the same tonnes and distance. Accepting loads cargo flagged `contraband: true`; the flag is on the server-side manifest only — other players cannot see it, but inspections can.

Contraband can also be **sold at the destination contact** rather than delivered, or dumped at sea (`Jettison`, which spawns a floating cargo entity that any player can recover for 15 sim-minutes — and which the coast guard will trace to the wanted level of whoever dropped it if they are within hail range).

**[Roadmap]** Reputation with factions (dockers' union, syndicates, customs) gating better contacts; informants who sell patrol positions; harbours with corrupt port authorities (bribe instead of fine).

### A3.3 The authority system

**[Prototype v0.1]** AI coast-guard cutters (30 kn, server-simulated with the shared physics) patrol chokepoints: Dover Strait, the Elbe mouth, the Skagerrak, the Maas approach, the Texel gap, the Humber, the Sound. Each runs a state machine per nearby player:

```
PATROL ──(player within HAIL_RANGE 500 u, not recently inspected)──► HAIL (30 s timer, "Heave to")
  │                                                                     │
  │                       ┌── SOG < 2 kn before timer ──────────────────┤
  │                       ▼                                             └── timer expires / player accelerates ──► PURSUIT (120 s at 30 kn, wanted +1)
  │                  INSPECTION (roll vs wanted)                                 │                              │
  │                       │                                            caught (within 120 u) ──► INSPECTION      escaped ──► PATROL (wanted stays +1)
  │          ┌────────────┼────────────────┐
  │        skip         clean          contraband found
  │        (RELEASE)   (RELEASE,         │
  │                     "cleared" tag,   ├── wanted < 2 and credits ≥ fine ──► FINE
  │                     immune 2 sim-h)  ├── wanted < 2 and credits < fine ──► IMPOUND
  │                                      └── wanted ≥ 2 ───────────────────► FORCED RESET
  └──────────────────────────────────────────────────────────────────────────────────────────────► PATROL
```

**Probability tables**

| Wanted level | Chance the cutter actually searches after you heave to (`INSPECT_CHANCE`) | Port authority inspection on docking |
|---|---|---|
| ☆☆☆ (0) | 15 % | 12 % |
| ★☆☆ (1) | 60 % | 25 % |
| ★★☆ (2) | 85 % | 25 % |
| ★★★ (3) | 100 % | 25 % |

A search always finds contraband if present (there is no hiding mechanic in the prototype). A clean ship is tagged `cleared` and ignored by all cutters for 2 sim-hours.

**Punishments**

| Outcome | Condition | Effect |
|---|---|---|
| **Fine** | contraband found, wanted < 2, affordable | `FINE_MULT · cargoValue + FINE_FLAT = 2 × contraband value + ¤ 5 000`; contraband confiscated; wanted +1 |
| **Impound** | contraband found, wanted < 2, fine not affordable | Ship towed to the nearest harbour, **all** cargo confiscated, ship released only after paying `max(¤ 2 000, 25 % of the fine)`; until then the player may walk the harbour and trade but not sail; wanted +1 |
| **Forced reset** | contraband found at wanted ≥ 2 (`IMPOUND_RESET_WANTED`) | Ship and cargo seized permanently; the player restarts in a rust-bucket coaster with ¤ 500 at the nearest harbour; wanted → 0 |
| **Flight** | leaving hail range or exceeding 2 kn after the timer | wanted +1, pursuit; if caught the inspection is forced (100 %) |
| **Piracy** | boarding another player | wanted +2 (A4.7) |

**Wanted level** (0–3) decays by one level every `WANTED_DECAY_SIM_HOURS = 24` (≈ 37 real minutes) of **sailing or docked time** — not while impounded. The telemetry strip shows it as stars; cutters out of hail range do not know your level (no global APB).

**[Roadmap]** Hidden compartments (capacity vs detection trade-off), sniffer-dog and X-ray inspection tiers per harbour, bribery with a corruption index per port, AI customs launches that shadow suspicious courses, and a court/appeal interface for impound.

---

## A4. Multiplayer Infrastructure

### A4.1 Architecture

**[Prototype v0.1]**

```
Browser (Three.js)                    Node.js process (one shard)
┌───────────────────────┐   wss://    ┌───────────────────────────────────────┐
│ shared/physics.js     │◄──────────►│ ws server (10 Hz snap)  ─┐             │
│ local sim @ 60 Hz     │  JSON      │ express (tiles, charts,  │ world state │
│ radar / telemetry UI  │            │   harbours, static)      │  players    │
│ interpolation buffer  │            │ economy / law / AI boats │  AI boats   │
│ (100 ms)              │            │ plausibility checks      │  wrecks     │
└───────────────────────┘            │ persistence (30 s)  ─────┘  markets   │
                                     └──────────────┬────────────────────────┘
                                                    ▼
                                            data/state.json
                                            data/cache/*.bin
```

* **Movement is client-simulated.** The client runs `stepShip` at render rate and uploads its state at `CLIENT_STATE_HZ = 10`. The server accepts the upload if it passes **plausibility checks**: implied speed over ground ≤ `maxKn · 1.15 + |current|`, the new position is water (land mask lookup), the delta since the last upload is ≤ 2 s of max speed, and throttle/rudder are in range. A failed check snaps the client back with a `you` message.
* **Everything else is server-authoritative**: fuel, condition, flooding, cargo, credits, jobs, markets, black market, inspections, wanted, trades, convoys, boarding, salvage, wrecks and AI cutters.
* **Snapshots** go out at `SNAPSHOT_HZ = 10` with every ship and AI boat in the shard (no interest management yet); the client interpolates remote ships 100 ms behind the latest snapshot and dead-reckons through dropped packets.

### A4.2 Protocol

**[Prototype v0.1]** JSON text frames over WebSocket. Every message is `{ t: "<type>", ...payload }`.

| Direction | Type | Payload | Rate / trigger |
|---|---|---|---|
| C→S | `hello` | `{ token, name, version }` — token is a random 128-bit id from `localStorage` | On connect |
| C→S | `state` | `{ lat, lon, hdg, spd, throttle, rudder, seq }` | 10 Hz while sailing |
| C→S | `action` | `{ a: "dock" \| "undock" \| "buy_fuel" \| "repair" \| "buy_ship" \| "take_job" \| "deliver" \| "market_buy" \| "market_sell" \| "look_around" \| "take_smuggle" \| "jettison" \| "patch" \| "tow" \| "waypoint" \| "trade_offer" \| "trade_accept" \| "trade_decline" \| "convoy_invite" \| "convoy_accept" \| "convoy_leave" \| "board" \| "salvage", ...args }` | On input |
| C→S | `chat` | `{ msg, scope: "global" \| "harbor" \| "convoy" }` | On input, rate-limited 1/s |
| S→C | `welcome` | `{ id, you, harbors[], fishingGrounds[], simTime, constantsHash }` | Once after `hello` |
| S→C | `snap` | `{ simTime, ships: [{ id, name, cls, lat, lon, hdg, spd, cond, flooding, convoy }], ai: [{ id, kind, lat, lon, hdg }], wrecks: [{ id, lat, lon, age }] }` | 10 Hz |
| S→C | `you` | Private full state: `{ fuel, cond, flooding, cargo{}, credits, wanted, jobs[], docked, impounded, convoy, snapBack? }` | 2 Hz, or immediately after any action / correction |
| S→C | `event` | `{ kind: "hail" \| "inspected" \| "fine" \| "impound" \| "reset" \| "grounded" \| "sunk" \| "boarded" \| "salvaged" \| "job_done" \| "chat", ... }` | As they happen |
| S→C | `harbor` | `{ id, fuelPrice, market{}, jobs[], contact? }` | On dock, and on change while docked |
| S→C | `trade` | `{ from, offer{ goods{}, credits }, state: "pending" \| "accepted" \| "declined" \| "expired" }` | On trade activity |

The `constantsHash` lets the client refuse to play against a server with different `shared/` constants — the physics must match on both sides for plausibility checks to be fair.

**[Roadmap]** Binary snapshots (MessagePack or a hand-packed `Float32`/`Int16` layout: 22 bytes per ship instead of ~160 bytes JSON), delta compression against the last acknowledged snapshot, and `state` messages carrying the input history for server replay (A4.4).

### A4.3 Tick rates and time

| Loop | Rate | Owner |
|---|---|---|
| Client render + local physics | 60 Hz (rAF, `dt` clamped ≤ 100 ms) | Client |
| Client state upload | 10 Hz | Client |
| Server world tick (AI, fuel, wear, law, timers) | 10 Hz | Server |
| Snapshot broadcast | 10 Hz | Server |
| Private `you` refresh | 2 Hz | Server |
| Markets, job boards | once per sim-hour (≈ 92 real s) | Server |
| Persistence flush | every 30 real s and on `SIGTERM` | Server |

The sim clock is the server's; `welcome` and every `snap` carry `simTime` so the client's clock never drifts more than one snapshot.

### A4.4 Persistence model

**[Prototype v0.1]** A single JSON document, `data/state.json`, holds every player (keyed by token: name, ship, position, fuel, condition, flooding, cargo manifest, credits, wanted, active jobs, convoy, impound state, last-seen), every wreck, every harbour's market and job board, and the sim clock. It is written atomically (write temp, rename) every 30 s and on shutdown. Offline players are kept docked (if they were docked) or left at anchor at their last position with the engine stopped, where they still exist as a ship (and a boarding target) — logging out at sea is a risk by design.

**[Roadmap] (M1→M4)**
* Move to PostgreSQL: `players`, `ships`, `cargo_items`, `wrecks`, `harbor_markets`, `jobs`, `events` (append-only audit log); the JSON file becomes a dev-mode adapter behind the same `Store` interface.
* Redis for hot ship state and pub/sub between shards.
* Account system (OAuth) replacing the localStorage token, with the token migrated into the account on first login.

### A4.5 Sharding and interest management — roadmap

**[Prototype v0.1]** One persistent shard per server process; every client receives every ship.

**[Roadmap] (M4)**
1. **Interest management first.** Partition the globe into 1° × 1° cells; each client subscribes to the 3 × 3 cells around it plus the cells of its convoy members. Snapshot size then scales with local density, not shard population. Radar range (max 80 nm) stays within the subscribed area.
2. **Region shards.** Shard by sea area (North Sea, Baltic, Mediterranean…), each a process owning the players whose position is in its polygon; a handover protocol transfers the player record through Redis when a ship crosses the boundary (the client reconnects to the new shard's URL from the `handover` message, with the ship frozen for < 1 s).
3. **Harbour instancing.** Harbours are the hot spots; a harbour with > 60 docked players spawns a second instance of its dock area (the sea outside stays one instance).
4. **Gateway.** A WebSocket gateway terminates TLS, authenticates tokens, and routes to shards; the K3s deployment on my-app.engineer runs one Deployment per region shard behind the gateway Service.

### A4.6 Player-to-player trading

**[Prototype v0.1]** Within `TRADE_RANGE_U = 150` game units at sea, or when both players are docked at the same harbour, a player sends `trade_offer` with a bundle of goods and/or credits and a requested bundle. The server escrows the offered items, shows the offer to the counterparty for 60 real seconds, and on `trade_accept` validates capacity and credits on both sides and swaps atomically. Contraband can be traded; its flag travels with it. Convoy chat and global chat are the negotiation channel.

**[Roadmap]** Harbour auction house with buy/sell orders settled by the market engine, contracts that pay a convoy escort on arrival, and a reputation ledger visible in the harbour.

### A4.7 Convoys, piracy and interception

**[Prototype v0.1]**

* **Convoy.** `convoy_invite` within 150 u, `convoy_accept`, `convoy_leave`. Members share radar contacts, see each other as cyan, have a convoy chat scope, and are counted as **escorted** when any other member is within `CONVOY_ESCORT_U = 400`. Boarding success against an escorted target is reduced by 25 points (from 55 % to 30 %).
* **Boarding (piracy).** `board` requires the target within `BOARD_RANGE_U = 120`, target SOG < 6 kn and closing speed < 4 kn — so a pirate must first force the victim to slow (by blocking a channel, by social engineering, or by catching a ship that has run out of fuel or is grounded). The server rolls **55 %** success (30 % if escorted). On success half of each cargo stack moves to the boarder (capacity permitting); on failure nothing happens but the target receives a `boarded` event with the attacker's name. Either way the boarder gains **wanted +2**, which at the 85–100 % inspection tier makes the next cutter encounter decisive. A boarded player can `board` back under the same rules.
* **Interception.** There is no weapon system in the prototype; interception is a physics problem: a feeder cannot stop a trawler, but a trawler can sit across the Nieuwe Waterweg.

**[Roadmap]** Grapple/line-throwing mini-game replacing the flat roll; cargo-specific loot weights; bounty board where victims post rewards for a pirate's wanted level; tug and salvage-licence classes with a legal counter-piracy role; non-lethal deterrents (water cannon, LRAD) as equipment.

### A4.8 Persistence of sinking ships and lost cargo

**[Prototype v0.1]** A `sunk` event is only ever generated by the server (flooding is server-authoritative), so there is one truth about where a wreck is. The wreck record `{ id, lat, lon, cls, owner, cargo{}, createdSim, salvagedBy? }` lives in `state.json` and in every `snap`, is salvageable by anyone within 100 u (`salvage` moves cargo to the salvor up to capacity, repeatable until empty), and expires after 48 sim-hours. Jettisoned cargo is a short-lived (15 sim-min) float with the same salvage rule. Because wrecks are broadcast on radar as grey ✕ blips, a sinking is a social event: salvors converge, and so do the cutters if the wreck is carrying contraband (salvaging contraband from a wreck inherits the flag).

**[Roadmap]** Wreck ownership window (owner-only salvage for the first 6 sim-hours unless the owner is reset); wreck charts sold by harbours; wreck clutter limit per cell with the oldest removed.

### A4.9 Anti-cheat — roadmap

**[Prototype v0.1]** Plausibility checks on uploaded state (speed, land, delta, ranges) and server authority over everything that touches credits.

**[Roadmap]**
* **M1 — server-authoritative movement.** Clients send inputs (`throttleCmd`, `rudderCmd`, `seq`) instead of positions; the server runs `stepShip` for every player at 10 Hz and sends corrections; the client predicts with the same shared code and reconciles by replaying unacknowledged inputs. This removes teleport, speed and land cheats outright.
* Server-side rate limits and schema validation (`ajv`) on every message; replay protection via `seq`.
* Statistical fraud detection on the economy log (impossible profit per sim-hour, trade loops between alt accounts).
* Signed client build hash in `hello`; session tokens bound to an account.

---

# Part B — Gameplay Loops

## B1. Core loop

```
             ┌──────────────────────────────────────────────────────────────────┐
             ▼                                                                  │
   DOCK ─► refuel / repair / sell ─► take job (legal or black-market) ─► load cargo
                                                                                │
   deliver ◄─ dock at destination ◄─ navigate: weather, current, depth, traffic, law, pirates ◄─┘
      │
      ├─ paid ─► credits ─► better ship / bigger loads / riskier runs ─► (loop)
      └─ failed: fine / impound / boarded / grounded / sunk ─► recover ─► (loop at a lower rung)
```

Every loop iteration is a **voyage**. The three resources that drain during a voyage — fuel, condition and (if things go wrong) hull integrity — are only restored at a harbour, so the harbour is the heartbeat of the game and the sea between harbours is where decisions are made.

## B2. Session loop (one sitting, 30–90 real minutes)

1. **Arrive** (0–2 min): the player spawns where they logged out — docked, or at anchor at sea. Read the telemetry, check fuel and condition, open the chart.
2. **Plan** (2–5 min): pick jobs on the board that chain together (freight out, fish on the way back; passengers if the deadline fits the session). Compare fuel price here vs the destination. Look around for a contact if the wanted level is clean.
3. **Voyage** (10–25 min per leg at prototype scale): leave harbour, set waypoint, manage throttle against fuel and wear, respond to hails, weather, convoy chat, other players.
4. **Arrive and settle** (3–5 min): dock, deliver, sell, repair what the budget allows, refuel enough for the next leg plus a margin.
5. **Leave safe**: log out docked (cannot be boarded) or accept the risk of anchoring at sea for a better position tomorrow.

## B3. Minute-to-minute

* Throttle discipline: cubic fuel law means 80 % throttle costs half the fuel of 100 % for 20 % less speed; the player feels this in the fuel gauge every minute.
* Steering with lag: a 90 m coaster needs the rudder early and centred early; a rotten ship needs it earlier still.
* Depth watch: amber/red depth-under-keel in estuaries; a grounding is −5 condition and a leak if neglected.
* Weather: a headwind adds 30 % to burn and 0.3/h to wear; running with the wind is money.
* Contacts: a red ▲ ahead in the Dover Strait with narcotics aboard is a decision — heave to (15 % search at ☆☆☆) or run (guaranteed ★ and a 30 kn pursuit).
* Social: a white ● closing from astern at 20 kn when you are doing 5 kn across the Humber bar is a threat; a cyan ● is a friend.

## B4. Hour-to-hour

* Chaining jobs into a route (triangle trades) and timing passenger deadlines.
* Building a fuel/repair budget: the player who repairs at 60 % pays ¤ 4 800 and keeps 85 % steering; the player who waits to 20 % pays ¤ 9 600 and risks the leak.
* Convoy formation for the chokepoints, cargo pooling trades at anchor outside a harbour, salvage runs to fresh wrecks.
* Working the wanted level down (24 sim-hours ≈ 37 min per star) before docking at a port known for inspections.

## B5. Risk/reward matrix

| Activity | Typical net per leg (coaster → feeder) | Capital at risk | Law risk | Player risk | Skill demanded |
|---|---|---|---|---|---|
| Grain/steel freight | ¤ 18 k → ¤ 95 k | cargo value only (low) | none | low (cheap loot) | navigation, fuel budgeting |
| Container/machinery freight | ¤ 25 k → ¤ 125 k | medium | none | medium (valuable loot) | same + scheduling |
| Passengers (ferry) | ¤ 20 k → ¤ 60 k | none | none | low | speed vs fuel, deadlines |
| Fishing (trawler) | ¤ 50 k–¤ 400 k per hold | fish spoil | none | medium (slow, loaded, far from port) | patience, ground choice |
| Smuggling | 4–6× freight (¤ 100 k → ¤ 600 k) | fine = 2× cargo + ¤ 5 k; impound; reset | high at chokepoints | high (pirates know what a quiet ship avoiding Dover is carrying) | route choice, nerve |
| Piracy | half a victim's hold | wanted +2 → near-certain inspection | very high | retaliation, convoys | positioning, timing |
| Salvage | whatever sank | fuel only | inherits contraband flag | contested by other salvors | speed to the wreck |

## B6. Progression — ship classes

| Rung | Ship | Unlock | What changes |
|---|---|---|---|
| 0 | Rust-bucket coaster (25 %) + ¤ 500 | forced reset / broke | survival: one short freight job pays for fuel and a patch kit |
| 1 | Coaster (starter) | new player | 1 200 t, 14 kn, 80 t fuel; learns every system |
| 2 | Trawler | ¤ 180 000 | fishing income 5× the coaster's rate; nimble (8°/s) for estuaries and escape |
| 3 | Ferry | ¤ 700 000 | 400 pax, 22 kn; fastest hull in the game — the smuggler's and the escort's choice |
| 4 | Feeder | ¤ 950 000 | 4 000 t, 300 t fuel; long container runs; deep draft (8.5 m) locks it out of shallow harbours |

Ships are bought at any shipyard; the old ship is traded in at `0.6 · price · cond/100`. Players may own one ship in the prototype. **[Roadmap]**: fleets with hired AI captains, ship upgrades (bow thruster: steerage below 1 kn; bigger tanks; cargo cranes for ports without; hidden compartments), tug, salvage vessel, bulk carrier, tanker, cruise ship.

## B7. Failure states and recovery

| Failure | Cause | Immediate effect | Recovery path |
|---|---|---|---|
| Out of fuel | burn > plan | drift on current, no steering | buy fuel from a passing player (trade), or **tow** (¤ 1 500 + ¤ 12/nm) |
| Grounded | depth < draft | stopped, −5 cond, leak if cond < 20 | reverse throttle (−0.3) off the bank; patch kit if leaking |
| Rotten (cond < 20) | neglect | 72 % speed, 2.5 s rudder, every grounding leaks | reach any yard; repair costs ≤ ¤ 9 600 |
| Flooding | cond 0 | sinks in ≈ 50 sim-min | patch kit (+15 cond stops the leak, −30 % flooding) then limp to a yard |
| Sunk | flooding ≥ 1 | wreck with cargo; insurance −¤ 2 000 or forced reset | go back and salvage your own wreck before the 48 sim-hour expiry |
| Fined | contraband, wanted < 2 | −(2× cargo + ¤ 5 000), wanted +1 | legal runs until the stars decay |
| Impounded | fine unaffordable | ship locked at harbour, cargo gone | pay the release (≥ ¤ 2 000) — trade at the harbour, or ask the convoy |
| Forced reset | contraband at ★★☆+ or sunk while broke | rung 0 | one short freight job; the game is designed so a rust-bucket can still earn |
| Boarded | pirates | lose half of each stack | board back, convoy up, report (roadmap: bounty) |

Every failure leaves the player with a ship and a job board within reach; there is no permadeath, but there is real loss.

---

# Part C — Required Asset Classes

| Class | Prototype v0.1 (procedural) | Production pipeline |
|---|---|---|
| **Ships** (4 classes + cutter) | Hull from a lofted spline (length/beam/draft from `SHIP_CLASSES`), box superstructure, funnel, mast, container stacks as instanced boxes, trawler gantry; flat colours; wear masks from 3D noise in the shader | Blender → glTF 2.0 PBR kits at 3 LODs (60 k / 15 k / 2 k tris), 4 K albedo/normal/ORM, **authored wear masks** (rust streak, barnacle band, flaking, holes) packed in a second texture set; skeletal props (radar, cranes, doors); class-specific hull-wake and bow-spray emitters |
| **Harbour kits** | Pier, bollards, warehouses, cranes, tanks, fuel dock, lighthouse and buoys as parametric boxes/cylinders placed around the harbour point; OSM footprints extruded as boxes | Modular kit (quay sections, fenders, cranes with animation, sheds, silos, ro-ro ramps, cold stores, fish market, customs house, black-market alley dressing); OSM footprints become kit selection + extrusion with roof types; vegetation cards; decals for port names |
| **Environment** | Heightfield tiles with vertex colours; water shader (Gerstner waves, depth-tinted colour, foam at shore); sky gradient; wind-driven whitecap density; fog by visibility | GEBCO + OSM tiles with splat-mapped PBR terrain; FFT ocean with foam/spray; HDRI skyboxes per weather state; volumetric clouds; rain/snow particle systems; night lighting for harbours and ships (nav lights per COLREGS) |
| **UI** | Canvas radar, telemetry strip, chart overlay, harbour panels (fuel, yard, shipyard, job board, market, contact), trade dialog, convoy roster, chat, event toasts | Design system (type ramp, dark bridge theme), ECDIS chart tiles, 3D bridge instruments, localisation (EN/NL/DE/NO/DA/SV to start), controller mapping |
| **Audio** | None in v0.1 (silent build) | Engine loops per class with RPM and condition layers; hull groans by condition stage; bilge alarm; wind/sea beds by wind speed and wave height; harbour ambience; VHF hail voice lines (coast guard, port authority); UI clicks; sinking sequence |
| **VFX** | Wake quad, simple foam texture at bow, flooding list, sinking sink-and-fade | Wake/kelvin pattern, bow spray, funnel smoke (fuel grade & condition), rain streaks, spray on the camera, inspection searchlight, boarding grapple, wreck bubbles/oil sheen |
| **Data assets** | `ne_50m_land`, `ne_10m_land`, `ne_10m_minor_islands`, `ne_10m_lakes` GeoJSON (public domain); harbour table (~90 entries, lat/lon at entrance, services, price factors); channel polylines; fishing grounds; patrol areas; `data/osm-harbors.json` cache | GEBCO 2024 grid; OSM coastline/seamarks/rivers extracts (ODbL attribution in-game); CMEMS currents and ERA5 winds; tidal constituents; a harbour database of 1 000+ ports with berth depths and services from the World Port Index (public domain) |

**Asset governance:** everything in the prototype renders from `shared/constants.js` and the harbour table, so adding a ship class or harbour is a data change. The production pipeline must keep that property: glTF kits are referenced by class id, harbour kits by harbour id, and the fallback procedural generator stays in the build so a missing asset never blocks a harbour from being navigable.

---

# Part D — Implementation Plan

## D1. Milestones

| Milestone | Scope | Exit criteria | Tech stack |
|---|---|---|---|
| **M0 — Prototype v0.1 (as built)** | Everything in Part A marked [Prototype v0.1]: real-globe raster world from Natural Earth, two layers, tile/chart APIs, channel carving, ~90 harbours, OSM extrusion cache, floating-origin client, shared physics, fuel/wear/flooding/sinking, legal jobs, markets, black market, cutters and port authority, wanted level, JSON WebSocket protocol at 10 Hz, trade/convoy/boarding/salvage, wreck persistence, JSON state file, radar/telemetry/chart UI | Two browsers on the public URL can see each other, trade, convoy and board; a ship can be run to 0 condition and sunk; the wreck survives a server restart; `npm test` passes the physics, raster, economy and law suites | Node ≥ 20 ESM, Express 4, `ws` 8, Three.js (CDN), plain ESM `shared/`, `node --test`; deployed on my-app.engineer App Runner (K3s), single container, persistent volume for `data/` |
| **M1 — Server-authoritative movement** | Clients send inputs with `seq`; server steps every ship at 10 Hz with `shared/physics.js`; client prediction + reconciliation; binary delta snapshots; schema validation; rate limiting; account login (OAuth) with token migration; PostgreSQL store behind the `Store` interface | No position can be set by a client; a 200 ms RTT player steers without visible rubber-banding; load test 200 ships per shard at 10 Hz under 40 % CPU | Add `ajv`, `msgpackr`, `pg` (+ `node-pg-migrate`), `ioredis`; k6 for load tests; Playwright for a two-client E2E |
| **M2 — GEBCO + OSM** | GEBCO 2024 reprojected into both layers (GDAL), level-2 harbour tiles, OSM coastline/seamarks/rivers extracts, automated channel carving from `waterway=river`, tidal harmonic model, CMEMS/ERA5 environment grids, ECDIS-style chart with contours | Depth under keel matches published chart datum within 2 m at 20 reference harbours; Wadden Sea dries at low water; every harbour in the World Port Index subset is reachable | GDAL/OGR in a build container, Python 3.12 (`rasterio`, `osmium`, `pyproj`) for offline ETL, tiles published to object storage with a CDN; Overpass replaced by planet extracts via `osmium` |
| **M3 — PBR assets** | glTF ship kits with authored wear masks at 3 LODs, harbour modular kit, FFT ocean, HDRI skies, weather states, audio layers, VFX, COLREGS lights, UI design system, localisation | 60 fps at 1080p on an RTX 3060-class GPU with 50 ships in view; condition stages read correctly at 200 m; audio reacts to throttle, condition and weather | Blender 4 + Substance for authoring, `gltf-transform` for optimisation (Draco/KTX2), Three.js post-processing (bloom, SSAO, TAA), Web Audio graph, Howler for one-shots |
| **M4 — Sharding** | Interest management (1° cells), region shards with handover via Redis, harbour instancing, WebSocket gateway with TLS and auth, observability | 2 000 concurrent players across 5 region shards with < 120 ms p95 snapshot latency; a Dover→Calais crossing changes shard without a visible pause | K3s Deployments per shard + gateway Service on my-app.engineer, Redis cluster, PostgreSQL with read replicas, Prometheus + Grafana, OpenTelemetry traces, structured logs |

## D2. Cross-cutting engineering practice

* **One physics file.** `shared/physics.js` and `shared/constants.js` are the only places kinematics and tuning live; the `constantsHash` handshake guarantees client and server agree. Any formula in this GDD that changes must change there and here in the same commit.
* **Tests as the contract.** `node --test test/` covers: rasteriser (even-odd with holes, antimeridian split), distance transform symmetry, tile overlap, physics determinism (same inputs → same state on both sides), fuel/wear formulas against the worked tables in A2, job payout formulas, the authority state machine (every transition and every row of the punishment table), trade atomicity, boarding rules, wreck lifecycle, and persistence round-trip. New systems arrive with their tests.
* **Data-driven content.** Harbours, channels, fishing grounds, patrol areas, goods and ship classes are tables; the roadmap adds a content editor on top of the same JSON.
* **Deployment.** The app is deployed on my-app.engineer; `npm start` builds the world caches on first boot (≈ 40 s for both layers) and serves immediately after. M1+ adds migrations on boot and a health endpoint reporting the shard's player count, tick time and persistence lag.

## D3. Open design questions (to resolve before M1)

1. Should the sim-clock compression (39×) apply to passenger deadlines as it does to fuel, or should deadlines be expressed in real minutes for clarity in the UI? (Current answer: sim-hours, shown with a real-time equivalent.)
2. Should wrecks be salvageable by their owner first (ownership window) or remain first-come to keep the social event? (Current answer: first-come; revisit with telemetry.)
3. Is a flat 55 % boarding roll acceptable through M1, or does piracy need a skill layer before accounts arrive and griefing gets persistent? (Current answer: add the bounty board in M1.)

---

*End of document. Prototype v0.1 sources: `shared/constants.js`, `shared/physics.js`, `shared/geo.js`, `docs/ARCHITECTURE.md`.*
