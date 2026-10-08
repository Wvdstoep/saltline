# Saltline v7 — plan (gameplay depth, 2026-10-08)

The player asked for everything below ("proceed with all of it"). v7 adds what is still missing as *gameplay* on top of
the planned systems (v0.5 waves 2–4: company, loans, crew, ship stats, spare parts, accounts, onboarding, ship models,
inland waterways, seamarks; v6: office, fleet switching, HQ view, chart autopilot, ship's clock, harbour warp, world
market).

## Items

| # | Item | What the player gets | Builds on |
|---|---|---|---|
| 1 | **Career and reputation** | Captain's licences earned by sailing (sea time, tonnage, incidents): Day skipper → Coastal master → Master <3,000 GT → Master unlimited; bigger ships need the licence, not only the money. Reputation per harbour and per shipper (contracts delivered on time, cargo intact, incidents) unlocks better contracts and discounts. Milestones and achievements with a logbook. | wave 2 company (ledger, contract history) |
| 2 | **Skill-graded harbour work** | **Docking score** on every mooring (contact speed, distance off the berth, angle, time, tugs used) with a grade and a small bonus/reputation. **Anchoring**: drop/weigh anchor, swing circle, anchor watch, the anchor drags in strong wind/current on bad holding ground. **Pilot jobs on real AIS ships**: from a pilot boat, meet a real vessel arriving over live AIS at the pilot station, match its speed, board (pilot ladder) and earn the pilotage fee. | wave 1 telegraph/berth guidance; live AIS |
| 3 | **Emergencies and rescue (SAR)** | Distress calls near you (sinking yacht, fire aboard, man overboard, engine failure in a storm) with a position, time limit and reward/reputation; rescue the crew (approach, recover survivors, land them). Aboard your own ship: engine-room fire and flooding emergencies the crew fights (damage control in the walkable ship). | wave 1 interior; wave 2 parts/crew |
| 4 | **Sailing together** | Friends join **your** ship as crew (helm, engine room, lookout/radio) with shared control rules; shared companies (partners); VHF radio channels heard only within range (ch 16 distress, port control, ship-to-ship). | wave 3 accounts; v6 fleet |
| 5 | **Real cargo work** | Loading/discharge takes time at the cranes (per port equipment, own cranes faster); stability: overloading or badly placed cargo makes the ship list and, past the limit, capsize; heavy weather damages cargo; fish spoils without cold storage; hazardous cargo rules. | wave 2 ship stats |
| 6 | **Rules of the sea** | AI and AIS ships follow COLREGS (who gives way, crossing/head-on/overtaking), you must too (collision-risk warnings, CPA alarm); sound signals; traffic-separation-scheme fines; call port control on VHF before entering (berth assignment, waiting at anchor when the port is busy). | v6 chart autopilot (TSS lanes); live AIS |
| 7 | **Upgrades and your own look** | Upgrades: engines, bow/stern thrusters (berthing without tugs), cranes, ice class, scrubbers, fish hold refrigeration, extra fuel tanks; livery editor (company colours on hull and funnel), ship names; newbuild orders at shipyards with a build time; second-hand trading with other players. | wave 2 stats/parts; v6 office |
| 8 | **Living world and events** | Sailing races / regattas for yachts on set courses; world events (storm season, port strikes, a canal closed for days, piracy hotspots, ice in the Baltic winter) that move prices and routes; leaderboards (richest company, best docking, longest voyage); daily and weekly challenges. | v6 world market |
| 9 | **Smaller items** | Harbour passport (a stamp per visited port); wildlife (dolphins, whales), famous wrecks to discover, lighthouses with their real light characters; photo mode and docking replay; difficulty settings (arcade/realistic handling, damage strength, assists); ship auctions between players; fuel planning (fuel prices per port, low-emission zones, bunkering at sea). | various |

## Roadmap (everything still to build, in order)

0. **Fixes first** (player reports, 2026-10-08):
   - express passage: always arrive on open water with room around the hull (depth ≥ draught + 3 m at low tide incl.
     harbour maps, a clear circle of one ship length, away from other ships; harbours: 1.5–2 km out on the approach);
   - big ports are inaccurate in 3D (Antwerp: moored AIS ships float in open water, quays/docks missing or offset, the
     river shape is coarse): carve the real OSM waterways and docks into the world raster like the Rotterdam fix, and
     cover the whole port area (Antwerp is ~20 km long) with harbour maps instead of one 4.5 km patch;
   - **every port worldwide carved from OSM** (player, 2026-10-08): after the big-port fix, run the same OSM waterway/dock
     carving + multi-patch harbour maps automatically for every harbour in the world list (Overpass per port bbox, cached
     compactly in the repo, rebuilt in the background so start-up stays fast), not only the ~10 big European ports;
   - **market exploit** (player, 2026-10-08): buying a harbour out at the old price and selling straight back at the
     risen price printed money — FIXED: every trade is priced over the stock it moves (impact) with a 2 % spread;
   - **world coverage**: harbours (hundreds worldwide), fishing grounds, offshore platforms, sea lanes, live weather and a
     finer coastline beyond the North Sea.
1. **v6 quick items** — DEPLOYED 2026-10-08 15:05 UTC: harbour warp 5×, ship's clock + feasible contracts, chart-aware autopilot, world
   market (docs/V6-QUICK-CONTRACTS.md).
2. **v6 office, boat storage and fleet — moved up by the player (2026-10-08 16:40 UTC)**: boat storage and swap in the
   home-harbour office, buying without a forced trade-in, several ships working on the water under hired captains,
   switching ships, HQ screen (docs/V6-FLEET-CONTRACTS.md). Builds a minimal company/home-harbour core that wave 2
   extends. Then the OSM carve for every port worldwide.
3. **v0.5 wave 2 + v7 batch 1** (parallel lanes, disjoint files): company, home harbour, bank and loans, crew, ship stats,
   spare parts (docs/V5-WAVE2-DESIGN.md) **with** v7 #2 (docking score, anchoring, pilot jobs on AIS ships) and the
   harbour passport.
4. **v7 #1 career and reputation** (licences, reputation, achievements).
5. **v0.5 wave 3 + v7 batch 2**: accounts and onboarding, bridge instruments and engine-room controls, per-class ship
   models **with** v7 #3 emergencies/SAR and #7 upgrades and liveries.
6. **v7 batch 3**: #4 sailing together (needs accounts), #5 real cargo work, #6 rules of the sea.
7. **v0.5 wave 4 + v7 batch 4**: inland waterways, bridges and locks, all seamarks in 3D, accurate harbour positions,
   realism pass **with** #8 living world/events and the remaining smaller items.

Each step: build contract → parallel build lanes → adversarial review + fix → end-to-end check → deploy.
