# Saltline v0.4 — build contracts (time warp, UI/UX overhaul, go ashore, street-level map)

Single source of truth for the parallel v0.4 build. Read it fully, then `docs/V3-CONTRACTS.md` (still valid) and
`docs/ARCHITECTURE.md`. Each file has exactly ONE owner; never edit another agent's file — code against this contract
and use optional chaining (`app.foo?.()`) for anything another agent adds. Project root:
`/tmp/claude-0/-home-user/0e451cf3-a540-5510-b1a6-978d07bae2ed/scratchpad/saltline`. No git, no new npm deps, Node 20,
plain ESM, three r160 via the importmap name `three` (only `three.module.min.js` is served — no `three/addons`).
Tests: `npm test`. Local server: `PORT=<port> node server.js`. Playwright + Chromium: `../pw/` (see `../pw/interior.mjs`
for the launch flags and login flow). The local container has NO internet (tile servers, Overpass, Open-Meteo); production has.

## Ownership

| Agent | Owns |
|---|---|
| W warp | `server/game.js`, `shared/constants.js` (add only), `shared/physics.js`, `test/game.test.mjs`, new `test/warp.test.mjs` |
| U ui | `public/js/hud.js`, `public/js/chart.js`, `public/js/touch.js`, `public/index.html`, `public/css/style.css`, new `public/js/thumbs.js`, new `public/js/icons.js` |
| A ashore | new `public/js/ashore.js`, new `public/js/avatar.js`, `public/js/interior.js`, `server/osm.js`, `server/harborgeom.js`, `test/osm-parse.test.mjs` |
| T terrain | `public/js/terrain.js`, `public/js/harbor.js`, `public/js/ship.js`, `public/js/ocean.js`, `public/js/weather.js`, new `server/maptiles.js`, new `test/maptiles.test.mjs` |
| C core | `public/js/main.js`, `public/js/net.js`, `public/js/collision.js`, `public/js/harborgeom.js` |
| orchestrator | `server.js`, `docs/*`, `package.json` |

## 1. Time warp (fast-forward) — W (server) + C (client) + U (HUD)

The world clock stays real time for everyone; warp only speeds up YOUR ship (motion + fuel + wear + wages + fishing
scale with the factor). Levels `WARP.LEVELS = [1, 5, 20, 100, 400]` added to `shared/constants.js` together with
`WARP = { LEVELS, MIN_LAND_M: 3000 /* >5× needs this much water ahead */, PLAYER_RADIUS_M: 20000, HARBOR_RADIUS_M: 4000, MAX_STORM: 0.6, MAX_NO_ROUTE: 20 }`.

Server (W):
- action `set_warp {factor}`: factor must be in LEVELS. Refused (event 'warn' with the reason) when docked, assisted,
  hailed, in a rescue, out of fuel, flooding > 0.2, within `HARBOR_RADIUS_M` of a harbour anchor, another ONLINE player
  within `PLAYER_RADIUS_M`, storm > `MAX_STORM`, or factor > `MAX_NO_ROUTE` without `m.route` (array of ≥ 1 `{lat,lon}`
  the client is following — the server only checks it is non-empty and finite). Accepted → `p.warp = factor`, event 'info'.
- Every tick while `p.warp > 1`: auto-drop to 1 (event 'warn' with the reason) when any of the above conditions becomes
  true, or when `world.depthAt` at the point `MIN_LAND_M` ahead along the heading is < draft + 2 (land/shallows ahead).
- Distance budget in `onState` × `p.warp`; consumption (`fuel`, `cond` wear, crew wages, fishing catch) × `p.warp`.
- `you.warp` (number), `publicState.warp`, `worldInfo().warp = WARP`. Persist `p.warp = 1` on load (never resume warped).
- Tests in `test/warp.test.mjs`: accept/refuse matrix, budget scaling, consumption scaling, auto-drop near harbour and
  near land ahead, drop on hail.

Client (C, main.js): `app.warp` mirrors `you.warp`; `simulate(dt)` integrates `dt × app.warp` (keep substeps ≤ 0.05 s of
SIM time each, cap 400 substeps/frame; at 400× use the route/autopilot only, ignore manual rudder); keys `.` / `,` step
warp up/down via `app.setWarp(factor)` → `net.action('set_warp', {factor, route})`; `app.setWarp(1)` on any manual
throttle/rudder key at > 20×; when the server's `you.warp` drops, the client follows immediately. Camera: at > 20× move to
a higher chase position automatically. Interpolation of OTHER warped ships already works from snapshots (they just move fast).

HUD (U): warp control (◀◀ 1× ▶▶ with the level, also on touch), banner "Time warp 100× — ETA 3 h 12 min real → 1 min 55 s",
calls `app.setWarp?.(f)`, reads `app.warp`/`you.warp`.

## 2. UI/UX overhaul — U

Goals: modern, full-screen, visual. Panels become full-screen sheets with a left navigation rail (icons + labels) on
desktop and a bottom tab bar on mobile; sticky header with harbour/ship name, money and a close button; cards instead of
tables; consistent design tokens (CSS variables) in a dark nautical theme with good contrast; 8 px spacing grid; system
font stack + tabular numbers; focus states; ≥ 44 px touch targets; smooth 150 ms transitions; no horizontal scroll.

- `public/js/thumbs.js`: `export async function shipThumb(cls, {w = 320, h = 200, angle = 'quarter'} = {}) → dataURL`
  renders `buildShip(cls)` (import from `./ship.js`) with ONE shared offscreen `THREE.WebGLRenderer` (alpha, preserveDrawingBuffer)
  + studio lights + a gradient water plane, camera framed to the ship's length; caches by key in memory and
  `sessionStorage`; renders lazily (one per animation frame) so opening the shipyard never stalls. Also
  `harborBanner(harbor) → dataURL` (a stylised skyline/silhouette canvas drawing from the harbour name/size; no network).
- `public/js/icons.js`: inline SVG icon set (anchor, ship, fuel, wrench, chart, crate, coins, person, warning, wind,
  wave, tide, clock, star, cargo types) as strings: `export const ICON = { anchor: '<svg…>', … }`.
- Harbour panel sections: Overview (banner, harbour info, fees, berths, weather/tide), Contracts (job cards with type
  icon, route "Rotterdam → Hull 230 km", pay big, pay/t, deadline, eligibility chip, Accept), Job boards (all harbours),
  Market (goods cards with price, stock bar, trend arrow, quantity stepper, buy/sell), Shipyard (NEW: category filter
  chips + grid of ship cards with `shipThumb` image, price, spec bars for speed/capacity/range/crew cost, "Compare" up to
  3 side by side, Buy; USED: same cards with condition bar; SELL current ship card), Services (fuel slider, repair,
  service, kits), Black market (Look around), Players.
- `hud.openHarborTab(tab)`: shows the harbour panel at a section (tabs: `overview|jobs|boards|market|shipyard|services|shady|players`);
  must work when called from the ashore world (§3). Keep every method main.js uses (V3 list) plus `openChart()`,
  `showFishing`, `showWeather`, `showRescue`, `showBerth`, `showVoyage`, `showInterior`, `setSailsButton`.
- HUD in game: compact glass top bar (ship image chip via `shipThumb`, money, fuel gauge, hull gauge, cargo, wanted,
  UTC time, wind/tide mini widgets), telemetry as a slim bottom-left instrument strip, radar bottom-right, action dock
  bottom-centre with icons; everything collapses gracefully on mobile (body.touch).
- Ships list (Tab): cards with thumbs, AI ships too.
- Keep chart.js working; restyle its toolbar to the new tokens and make it full-screen. Map tiles must come from the
  server proxy `/api/maptile/osm/{z}/{x}/{y}.png` and `/api/maptile/seamark/{z}/{x}/{y}.png` (§4) instead of the
  public servers.
- Welcome screen: hero with a rendered ship, name input, short feature list.

## 3. Go ashore — A (client world + server data), C wires, U opens panels

When docked, the player can **go ashore** (`G` key / "Go ashore" button) and walk around the real harbour as the crew
member (third person, same controls as the interior: WASD/stick, mouse/drag look, Shift run, E/tap use, wheel zoom,
`G` or "Back aboard" to return). The harbour is its own small world built from the v3 geometry + new street data.

Server (A, `server/osm.js` + `server/harborgeom.js`, bump `GEOM_VERSION`):
- Overpass query adds `way["highway"](around)` (cap 1500 ways, keep `highway`, `name`), `way["landuse"]`,
  `way["leisure"~"park|garden"]`, `way["natural"~"wood|scrub|grassland|beach|sand"]`, `node["amenity"~"bar|pub|restaurant|cafe|fuel|police|harbourmaster"]`,
  `node["shop"]` (cap 300), `node["tourism"]`, `way["railway"="rail"]`.
- `geom.features` adds: `roads: [{ pts, kind: 'motorway'|'primary'|'secondary'|'tertiary'|'residential'|'service'|'footway'|'track', width (m), name }]`,
  `areas: [{ pts, kind: 'grass'|'park'|'wood'|'sand'|'industrial'|'residential'|'port'|'parking' }]`, `rails: [{ pts }]`,
  `pois: [{ id, kind: 'harbourmaster'|'shipyard'|'chandler'|'fuel'|'market'|'bar'|'police'|'cafe', name, lat, lon, door: {lat, lon}, building: index into buildings | -1 }]`.
  The six game POIs MUST always exist: `harbourmaster` (contracts + job boards), `shipyard` (ship market), `chandler`
  (repairs, service, kits), `fuel` (fuel dock — on the quay next to a berth), `market` (commodities warehouse), `bar`
  (black market). Use real OSM amenities/buildings when present (closest suitable building to the berths), otherwise
  assign them to the buildings nearest the main berths (synthetic harbours too). `door` = point on the building edge
  facing the nearest road/quay, on land.
- Synthetic harbours also get a road network (a quay road along the quays, connector roads to the patch edge, a few
  streets in a grid behind the warehouses) and areas, so every harbour is walkable.
- Tests: POIs always present (6 kinds), doors on land, roads parse from fixtures.

Client (A):
- `public/js/avatar.js`: `export function makeAvatar(opts) → THREE.Group` with `userData.animate(dt, moving, running)`
  (move `Interior.makeAvatar` here; interior.js imports it).
- `public/js/ashore.js`: `export class Ashore { constructor(app) ; async enter(harborId) → boolean ; exit() ; get active ; update(dt) ; handleKey(e) → boolean ; dispose() }`.
  `enter` requires `app.you.docked === harborId` and the harbour entry in `app.geoms` (load it if missing); builds an
  on-foot layer ON TOP of the existing harbour scene (terrain patch + `buildHarbor` group stay): street ribbons from
  `roads` (width by kind, asphalt/paving materials, lane markings on primary roads), areas (grass/park/sand/parking
  flats), rail tracks, street lamps along roads, benches, bollards along quays, a few parked cars/containers (instanced),
  POI signs (glowing sprites with icon + name above each door, visible from 200 m), and NPC pedestrians (10–30
  instanced simple avatars walking along roads, cheap). Spawns the avatar on the quay next to the player's berth facing
  the ship. Walk collision: the patch mask (only LAND/QUAY/PONTOON walkable; water and breakwater edges block) +
  building footprints (point-in-polygon against `features.buildings` near the avatar, use a 50 m spatial grid). Ground
  height from the patch heights. Camera: third person (dist 3–12 m, wheel/pinch zoom), first person toggle with V,
  never inside buildings (pull the camera in when a footprint is between camera and avatar).
  Interactions (E / tap when within 6 m of a `door`): harbourmaster → `app.hud.openHarborTab('jobs')`, shipyard →
  `'shipyard'`, chandler → `'services'`, fuel → `'services'`, market → `'market'`, bar → `'shady'`; walking up to
  another docked player's ship → prompt "Trade / Convoy" via existing actions. Your own ship's gangway (berth point) →
  "Go aboard" = `exit()`. HUD hint line shows the nearest POI name and distance.
  On `exit()` remove everything the ashore layer added and restore the chase/berth camera.
- `interior.js`: use `avatar.js`; nothing else changes.

C (main.js) wiring: `app.ashore = new Ashore(this)`; `G` key and `app.toggleAshore()`; while ashore the ship stays docked,
no ship simulation, `ashore.update(dt)` owns the camera (like the interior), the interior and ashore are mutually
exclusive; casting off is refused while ashore ("Go aboard first"). U: "Go ashore" / "Back aboard" button visible when
docked (`app.toggleAshore?.()`), POI hint display via `hud.showAshoreHint?.(text)` (U implements it).

## 4. Street-level map & scale — T

- `server/maptiles.js`: `export async function getTile(layer, z, x, y) → { buf, type } | null` with layers `osm`
  (`https://tile.openstreetmap.org`) and `seamark` (`https://tiles.openseamap.org/seamark`); disk cache
  `data/tiles/<layer>/<z>/<x>/<y>.png` (30 days), in-memory LRU (500 tiles), max 2 concurrent upstream requests,
  User-Agent `Saltline/0.4 (+https://github.com/Wvdstoep/saltline)`, zoom 2..18, validate integers, never throws;
  negative cache 10 min for failures; transparent 1×1 PNG on seamark 404. Orchestrator wires
  `GET /api/maptile/:layer/:z/:x/:y.png` (already present in server.js as of this contract, calling `getTile`).
  Tests with a mocked fetch.
- `terrain.js`: drape map imagery on land: for each harbour patch mesh, fetch the z16 (desktop) / z15 (touch) tiles
  covering the patch through `/api/maptile/osm/...`, composite them on a canvas into one texture per patch, and use it as
  the patch land colour (UV from lat/lon Web Mercator; water cells keep the procedural seabed colour; blend 85 % tile /
  15 % slope shading). Coarse region tiles (level 1) get a z11–12 drape the same way for land vertices only, loaded
  lazily within 30 km. If tiles fail (offline), keep the current vertex colours. This puts real streets, parks and
  buildings' footprints under the 3D harbour — street-level.
- Scale: ships are already 1:1 metres; the "too big near land" impression comes from the 550 m coarse coast. Inside a
  patch the coast is 10 m and real; make the patch coverage bigger for mega/major ports (n = 640 → 6.4 km) only if A
  agrees — NOT in this build (keep n = 448). Instead: fade the coarse region coastline under the patch (already sunk),
  add a soft shoreline foam band from the patch SDF, and reduce harbour label/sprite sizes to real-world sizes.
  Default chase camera: distance = max(60, 2.6 × ship length), pitch 0.32 (C applies; T documents the numbers).
- `harbor.js`: render `roads`/`areas` only as a far LOD (thin lines/flat colours) when NOT ashore (cheap), buildings
  with roof colours by kind and window textures (one shared canvas texture), cranes, lights, buoys as before.
- `ship.js`: navigation lights per COLREGS (masthead white 225°, sidelights 112.5°, stern light 135° — as small emissive
  sprites with correct arcs), a deck-crew-sized scale reference (handrails 1.1 m) on all hulls; keep every v3 export.

## 5. Reporting
Return: files written, API added, deviations, gaps, exact test commands and results.
