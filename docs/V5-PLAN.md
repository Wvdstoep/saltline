# Saltline v0.5 — plan (player feedback after playing v0.3, 2026-10-07)

v0.4 (in progress) delivers: time warp, full-screen panels with ship images, going ashore in the real harbour,
street-level map drape, COLREGS lights. v0.5 adds everything below. The detailed file-ownership contract is written
when v0.4 lands (`docs/V5-CONTRACTS.md`), because it builds on v0.4's actual APIs.

## Feedback → work items

| # | Player said | Work |
|---|---|---|
| 1 | Harbour points on the map are not accurate (Lowestoft marker ~1 km offshore) | Audit every harbour from OpenSeaMap `seamark:type=harbour` + quays (running now → `server/harbor-positions.js`); apply to `HARBORS`, add `entrance`; chart/radar/labels use them. |
| 2 | Hard to see where to go inside the harbour; small text is not enough | 3D berth marker (glowing outline on the water at the target berth + floating number board + approach arrow), leading line from the entrance to the berth drawn on the water, fairway / channel lanes and lateral buoy line visible on the water when within 5 km; HUD guidance card with big distance/bearing and a mini harbour plan. |
| 3 | No reverse option | Engine order telegraph (Full / Half / Slow / Dead slow ahead, Stop, Dead slow / Slow / Half / Full astern) on screen, on the bridge in the interior, and on touch; astern power to −60 %; propeller walk; S/down steps the telegraph. |
| 4 | Tugs pass through where I grounded; tugs not visible | Server path planning on the patch SDF (A* over water cells with clearance ≥ half beam + margin), tug assist follows that path at realistic speed; 1–2 visible tug models made fast with lines, pushing/pulling with physics (thrust vectors, ship yaws/drifts realistically, tug wash); tugs return to their base afterwards; also visible for other players' assists. |
| 5 | Ship models must each have their own realistic design | Per-class model pass with real proportions and details for all 17 classes (+ cutter, tug, pilot, lifeboat, helicopter): hull shape lines, sheer, bulbous bows, deckhouses, cranes, hatch covers, container bays, lifeboats/davits, masts, radar, funnels in liveries; LODs. |
| 6 | Walking on stairs does not work (walks into the wall) | Fix interior ramps/stairs and doorways (collision corridor, landing alignment); add tests for walkable paths bridge ↔ passage ↔ mess ↔ engine room. |
| 7 | No engine room / can't go on deck | Walkable open decks (main deck, forecastle, poop, bridge wings, ladders between them and the interior), engine room reachable for every class, plus cargo hold access, galley, cabins; all inside the moving ship (rides the waves). |
| 8 | Bridge must be realistic with live options | Live instruments: radar/ECDIS screen with the real chart, conning display, engine telegraph, rudder angle indicator, gyro/magnetic compass, speed log, echo sounder, wind instrument, VHF with channel selector, alarm panel, steering mode (hand/autopilot/track), whistle button. Engine room: live gauges, start/stop, generators, fuel transfer, bilge pumps (fight flooding), damage control. |
| 9 | Loans with interest and monthly payments, real economics, company with home harbour | Company: name, home harbour, logo colour, fleet (several ships, one sailed by you, others hire AI captains on contracts), bank: loans (amount, APR, term) with monthly (real-time) instalments, overdraft, interest, default → repossession; ship mortgages; insurance premiums; operating costs ledger; profit & loss and balance sheet screens. |
| 10 | Hire workers on the ship | Crew market per harbour: captain, officers, engineer, cook, deckhands with skills, wages, morale and fatigue; minimum crew per class; crew affects maintenance, fuel efficiency, safety, cargo speed; visible crew members walking aboard (NPC avatars in the interior and on deck). |
| 11 | Going ashore must be seamless in the same world | (v0.4 builds on the existing harbour scene; v0.5 polishes: gangway animation, walking off the ship onto the quay without a load/cut, other players visible on foot.) |
| 12 | Make inside the ship and the harbour super realistic | Materials (PBR textures generated procedurally on canvas: steel plate, non-slip deck paint, rust streaks, wood, linoleum), lighting (room lights, night red lighting on the bridge), props; harbour: real building heights/roof shapes, street furniture, cranes animated, moving traffic. |
| 13 | Sound makes it much better | Procedural WebAudio engine (running now → `public/js/sound.js`), wired to engine rpm, sea, wind, rain, harbour ambience, horn, footsteps, UI. |
| 14 | Scale (v0.4 item 2) | Lower priority now (the new harbours look right); keep the camera/label sizing work. |

## Order
1. v0.4 lands → integrate → deploy.
2. v0.5 contract → parallel build (navigation & berth guidance + telegraph; tugs & path planning; economy/company/loans/crew;
   interior & decks & bridge instruments; ship models; sound wiring & harbour realism) → integrate → deploy.

---

# Additions (second feedback round)

| # | Player said | Work |
|---|---|---|
| 15 | Rotterdam: the chart shows an open route but the game says aground and I cannot leave the harbour | **Hotfix deployed (15e8415):** the coarse world raster predates Maasvlakte 2 and is too coarse for the canals, so ships ran aground as soon as they left the 4.5 km harbour patch. The real Port of Rotterdam waterways (OSM centrelines) are now carved and dredged to 16 m. Permanent fix = item 16. |
| 16 | Sailing inland (Netherlands) should show realistic buildings, bridges etc. like the harbour | **World detail streaming:** the harbour-patch pipeline generalised to a global grid of ~4.5 km OSM tiles built on demand around every ship (coastline + inland water polygons, docks, quays, buildings with heights/roof shapes, bridges, locks, seamarks). The client keeps a 3×3 window loaded; grounding and collision use the 10 m data everywhere a tile exists (coarse raster only far away). **Bridges** have real clearance (`seamark:bridge:clearance_height`/`maxheight`) checked against the ship's air draft; movable bridges open on request after a wait; **locks** cycle (wait, enter, level change, exit). Inland rules: CEMT class limits, speed limits, river current from flow direction. |
| 17 | The chart shows the buoys; show the real water markers in 3D | All OpenSeaMap seamarks in the loaded tiles rendered in 3D: IALA lateral/cardinal/isolated danger/safe water/special buoys and beacons with correct shapes, colours and topmarks, bobbing on the waves; lights with their real character (e.g. `Fl(2)R.5s`) flashing at night; leading lights and sector lights; also on the radar and as AIS aids to navigation. |
| 18 | Auth system: name-only login — where is the data stored? | Today: a random token in the browser's localStorage identifies the player; everything is stored server-side in `data/state.json` (lost browser storage = lost account, no password). Plan below. |
| 19 | Onboarding: new users get more money and choose a starter ship in that price range | Plan below. |
| 20 | A richer set of ship stats | Plan below. |
| 21 | Each ship has its own spare parts that wear and break over time or by misuse | Plan below. |

## Accounts and storage (item 18)
- **Sign-up / log-in** with e-mail + password (hashed with scrypt, per-user salt; never stored in plain text) or **continue as guest** (current behaviour) that can be claimed later by adding e-mail + password.
- **Sessions:** random 256-bit session id in an `HttpOnly; Secure; SameSite=Lax` cookie (not readable by page scripts), stored hashed server-side, 30-day sliding expiry, "log out everywhere". The WebSocket authenticates with the same cookie on upgrade.
- **Protection:** login rate limiting per IP and per account with backoff, minimum password length 10, generic error messages, CSRF protection on form posts, account deletion.
- **Recovery:** a one-time recovery code shown at sign-up (works without e-mail); e-mail verification and password reset once a mail provider is connected.
- **Storage:** move from one JSON file to an embedded SQLite database (tables: users, sessions, companies, ships, ship_parts, crew, loans, ledger, contracts, events) with migrations and daily backups. Existing players are migrated as guest accounts and can claim them.

## Onboarding (item 19)
1. Landing page: hero render of a ship, "Start your shipping company" / "Log in".
2. Sign up or play as guest.
3. **Found your company:** name, house colours (hull + funnel livery), **home harbour** chosen on a map from starter-friendly ports (Rotterdam, Antwerp, Hamburg, Felixstowe, Gothenburg, Bergen, Aberdeen…). Home harbour: free berth, cheaper fuel and repairs, local reputation, the company office (ashore).
4. **Starting capital 250,000 cr** (was 25,000) plus an optional starter loan offer (150,000 cr, 6 % APR, 12 monthly instalments).
5. **Choose a starter ship** from ships priced up to the capital: second-hand coaster, stern trawler, pilot boat, harbour tug, sloop, motor yacht — each shown with its picture, stats card and what it is good at.
6. **Guided first voyage** (skippable, rewarded): cast off with tugs → follow the berth marker / fairway → first short contract (e.g. Rotterdam → IJmuiden) → time warp in open water → moor at the destination → buy a spare part → hire a crew member → open the bank.
7. Contextual tips and a help centre afterwards.

## Ship stats (item 20)
Every class gets a stats card (bars, normalised per category, with a compare view):

| Stat | Meaning | Gameplay effect |
|---|---|---|
| Service / max speed (kn) | cruising and flat-out speed | voyage time; max speed costs fuel and wear |
| Capacity (t / TEU / passengers) | what she carries | earnings per trip |
| Range (nm) | fuel tank ÷ burn at service speed | route planning, bunkering stops |
| Fuel efficiency (t/h, g/kWh) | consumption curve | operating cost |
| Draft / air draft (m) | depth below / height above water | which ports, rivers and bridges she can use |
| Length / beam (m) | size | lock and berth limits, tug requirement |
| Manoeuvrability | turn rate, bow/stern thrusters | berthing without tugs |
| Seakeeping (max safe sea state) | storm behaviour | speed loss, cargo damage, wear in heavy weather |
| Hull strength / ice class | structural margin | grounding and collision damage, ice routes |
| Reliability (MTBF) | base failure rate of components | breakdowns at sea |
| Maintenance cost (cr/day) | upkeep | operating cost |
| Crew (minimum / optimal) | people needed | wages; under-crewed ships wear faster and are slower |
| Cargo handling | own cranes / ramps / pumps | load and discharge time where ports lack equipment |
| Comfort / passenger rating | accommodation quality | charter and ferry pay |
| Equipment | fishing gear, towing winch, DP, firefighting | which contracts are open to her |
| Eco rating | emissions class | port fee discounts in emission-controlled areas |
| Resale value / depreciation | value over time and condition | trading ships |

## Spare parts and breakdowns (item 21)
- Each ship has a component tree: **main engine** (injectors, turbocharger, fuel pumps, cylinder heads), **gearbox**, **shaft & propeller** (shaft seal, blades), **rudder & steering gear**, **bow thruster**, **generators**, **switchboard**, **navigation electronics** (radar, GPS/ECDIS, AIS, VHF), **pumps** (bilge, ballast, fire), **hull plating & coating**, **deck machinery** (windlass, mooring winches, cranes, hatch seals), plus class-specific parts (trawl and winch for trawlers, tow hook and winch for tugs, sails/rigging/winches for sailing yachts, ramps for ferries).
- **Wear** by running hours × load, faster with over-revving (long periods at 100 %), heavy weather slamming, groundings and collisions, overloading, bad fuel, skipped maintenance; a skilled engineer slows it.
- **Failures** follow a rising failure rate as condition drops and have real effects: engine derating or stop, loss of steering (drift), blackout (instruments off), shaft-seal leak (flooding), radar off, crane out of service (slow cargo).
- **Parts** are bought at chandlers (price and availability by port size; OEM vs cheaper aftermarket quality), carried aboard (weight and space), fitted at sea by the crew (time and skill) or at a yard (faster, guaranteed). Periodic class surveys require minimum conditions or the ship is detained.
