# Build status — v0.3 (written 2026-10-07 16:52 UTC, mid-build)

The v0.3 build runs as six parallel agents against `docs/V3-CONTRACTS.md`. This file records what has landed
so the work can be finished from any machine if the session ends.

## Landed (complete, tests green: `npm test` = 49 pass)
- `server/harborgeom.js`, `server/osm.js` — OSM + synthetic harbour patches, berths, SDF, binary patch API
- `server/game.js`, `server/economy.js`, `shared/physics.js`, `shared/constants.js` — berthing, tugs, tide,
  weather merge, per-socket AI snapshots, supply/demand markets, sell_ship, service, fees, collision action
- `server/lanes.js` — sea-lane graph with land-checked edges and Dijkstra routing
- `public/js/ocean.js`, `public/js/weather.js`, `public/js/ship.js`, `public/js/models.js`, `public/js/harbor.js`
  — realistic water, weather FX, all ship models + wake, OSM-based harbour rendering
- `public/js/chart.js`, `public/js/touch.js`, `public/js/hud.js`, `public/index.html`, `public/css/style.css`
  — interactive Mercator chart with OSM/OpenSeaMap tiles and job boards, touch helm, mobile layout, new panels
- `public/js/harborgeom.js`, `public/js/collision.js`, `public/js/terrain.js`, `public/js/net.js`,
  `public/js/interior.js` — client SDF, hull collision, patch terrain, walkable interior
- `server.js` routes: `/api/harbor/:id/geom|patch`, `/api/weather`, `/api/tide`, `/api/ai`

## Still stubs at the time of writing (agents were mid-write)
- `server/weather.js` (Open-Meteo service), `server/traffic.js` (AI ships), `shared/tide.js` (harmonic tide)
  — the stubs return safe fallbacks so the server runs without them.
- `public/js/main.js` — the orchestration (§5 of the contract) that wires geometry loading, collision, assist,
  tide/weather, AI ships, interior toggle, routes, touch helm. **Until this lands the client cannot berth:
  the server's new `dock` rule needs the client to come alongside a berth (`you.nearBerth`) or call `tug_assist`.**
- `scripts/fetch-osm.mjs` — to be rewritten as a thin CLI over `harborgeom.prefetchAll`.

## How to finish and deploy
1. Complete the files above per `docs/V3-CONTRACTS.md` (every signature is fixed there).
2. `npm test`; `PORT=3100 node server.js`; run `../pw/test-v3.mjs` (Playwright scenario in the session scratchpad)
   or the equivalent manual checks: login, cast off, sail, hit a quay (must stop, not pass through), moor at a
   berth (T within 60 m under 2 kn) or `tug_assist`, chart zoom, interior (I), mobile viewport.
3. Push to `main`; on the my-app.engineer workspace: `cd saltline-app && git pull --ff-only && npm install &&
   node scripts/build-world.mjs && node scripts/fetch-osm.mjs` (background, Overpass is reachable there), then
   redeploy `saltline` (`node server.js`, port 3000, workdir `saltline-app`).
