# Build status (updated 2026-10-07 20:45 UTC)

## Live on the server
- **v0.4** (commit dd7cdab): time warp, full-screen harbour UI with rendered ship pictures, going ashore in the real
  harbour, map tile proxy + street-level imagery, COLREGS lights, real wind waves / currents / sea temperature fetched.
- **Hotfix** (15e8415): real Port of Rotterdam waterways carved into the world raster and dredged to 16 m.
- **v0.3**: harbours from OpenStreetMap with berths and collision, tug assist, tides, live weather, 90 AI ships,
  walkable interior with third-person crew member.

## Built but not wired yet (in the session scratchpad, next deploy)
- `public/js/sound.js` — procedural WebAudio engine (engine by rpm/class, sea, wind, rain, harbour, horn, footsteps, UI).
- `public/js/ais.js` — client layer for live AIS ships at real size with smooth dead reckoning and info cards.

## Still building when this was written
- `server/ais/*` — live AIS ingestion: AISStream.io (worldwide; key stored on the production server in
  `data/secrets/aisstream.key`, never in git; verified 1,876 ships in 30 s for the North Sea) + Fintraffic Digitraffic
  (Baltic, open data). Wiring: `LiveAis` in server.js → per-socket `ais` messages + `/api/ais`; switch synthetic AI off
  where `covers()` is true; `AisLayer` in main.js, chart, radar, collision.
- `server/harbor-positions.js` — accurate harbour positions from OpenSeaMap/OSM for all 86 harbours (apply to HARBORS).
- `public/js/ocean2.js` + `public/js/motion.js` — realistic sea state from live wave/swell data (spectral cascades,
  dense near grid, breaking whitecaps, spray) and per-class ship motion; swap the ocean import in main.js, use motion.js
  in shipVisual, pass `windWaves`/`current`/`sst` through `game.weatherAt`, harbour shelter from the patch SDF.

## Next (v0.5, see docs/V5-PLAN.md)
Berth guidance marker + fairway lines, engine telegraph with astern, tugs with water-only path planning and visible tug
boats, company / home harbour / loans / crew, open decks + realistic bridge instruments + stairs fix, per-class ship
models, accounts + onboarding (250k start, starter ship choice), ship stats and spare parts, world detail streaming
(inland waterways with buildings, bridges, locks) and all seamarks in 3D.
