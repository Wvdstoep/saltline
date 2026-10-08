# Build status (updated 2026-10-08 07:15 UTC)

## Live on the server
- **v0.4.1 contracts** — every job type works end to end and is guided in the world:
  - fishing catches add up (the 10 Hz server tick rounded each few-gram step back to zero, even at 400×); nets fish
    under 4 kn at twice the old rate (stern trawler on the Dogger Bank: 30 t/h);
  - tow casualties lie on open water deep enough for the hull, 6 km clear of harbours (old board jobs on land are
    moved once); pass the tow line within 300 m under 3 kn (J or the card button); the casualty follows astern on a
    hawser; harbour tugs take the tow over 4 km off the destination port and the contract pays there;
  - supply runs: crane transfer within 500 m of the platform under 3 kn (J);
  - contract card at sea (bottom centre on desktop, top on phones): next step, distance/bearing, time left, pay, ‹ ›
    between contracts, Route (server sea-route planner `/api/route`: straight over open water, else along the
    sea-lane graph, string-pulled, every leg water-checked) with the autopilot steering it;
  - in the world: light column + range ring on every target, the disabled ship with not-under-command lights and a
    hazard strobe, the tow and the trawl warps (also on other skippers' ships); targets on the radar (rim arrows when
    out of range) and the chart.
- **Sea state + sound** (8bb918b): spectral sea from the live wave/swell data, per-class ship motion, procedural
  sound (U toggles, Y horn), frame-rate governor for slow devices.
- **v0.4** (dd7cdab): time warp, full-screen harbour UI, going ashore, street-level map tiles.
- **Hotfix** (15e8415): real Port of Rotterdam waterways carved and dredged to 16 m.

## Built, not deployed yet
- `server/ais/*` + `public/js/ais.js` — live AIS (AISStream worldwide, key on the production server only, never in
  git; Digitraffic Baltic). Wiring still to do: `LiveAis` in server.js, `AisLayer` in main.js / chart / radar.
- `server/harbor-positions.js` — accurate harbour positions (audit to redo).

## Next (v0.5, see docs/V5-PLAN.md)
Berth guidance marker + fairway lines, engine telegraph with astern, tugs with water-only path planning and visible tug
boats, company / home harbour / loans / crew, open decks + realistic bridge instruments + stairs fix, per-class ship
models, accounts + onboarding (250k start, starter ship choice), ship stats and spare parts, world detail streaming
(inland waterways with buildings, bridges, locks) and all seamarks in 3D.
