# Saltline — interiors v2: ships that look like ships inside (build contract IV2)

Design contract, 2026-10-09. Root: `/home/user/saltline` (live release). Design only — nothing here is built yet.
Functions are named by function and by the statement they sit next to, never by line number.

Read with: `docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md` §6 (the GA record, rules, room programme, interaction points,
budgets §6.6) and §7 (lanes, `GA_READY`), `docs/SHIPS-LANEC-PHASE2.md` (H10/H11 wiring, measured numbers),
`docs/SAILING-CONTRACT.md` §4.5–4.6 (SAILING **owns** the four sail classes' deck walker and interiors).

Tags, as in the YARD contract: **Source** = a real-world figure with its reference in §13 (*≈* = typical for the class,
to be checked by the data lane); **Game rule** = tuned for play, not a real-world claim.

Player report this answers: *"the interior of ships looks very poor — large empty spaces, not looking like the inside of
a ship at all. Each ship needs its own layout and a nice interior with much more detail, like the outside of the boats;
the inside walkable areas need to be done too."*

---

## 0. What the player gets

### 0.1 In plain words

- **Real scale.** Crew cabins of 7–12 m² with a bunk under the porthole, a desk, a wardrobe, a settee and a shower/toilet
  unit by the door. Corridors 1.0–1.2 m wide. Ceilings at 2.2 m with ceiling panels, light fittings and air diffusers;
  door sills you step over; steel doors with dogs on the open deck; sliding watertight doors below.
- **Dense, working spaces.** A bridge with a long console row (radars, ECDIS, conning display, autopilot, telegraph,
  VHF handsets), two chairs, an overhead instrument panel, a chart table with a lamp, a GMDSS station, wipers on the
  front windows. An engine room you squeeze through: catwalks between the main engine (cylinder covers, turbochargers,
  exhaust receiver), generators, purifiers, pumps, coolers, air receivers, tanks, pipes in colour-coded runs and cable
  trays overhead, an engine control room with its switchboard. Galleys with ranges, fridges and dishwashers; messes laid
  for the watch; a hospital, a laundry, a gym, stores, workshops, the steering gear room, a bosun store, mooring decks
  with windlasses, winches, bitts and fairleads.
- **Every type its own ship, every model its own numbers.** A bulk carrier is not a cruise ship with fewer decks: each
  generator type has a layout grammar (where the galley goes, how corridors run, what the bridge deck holds), and each
  model sets its own parameters (crew, engine, era, comfort, options) so a 1990s coaster and an eco Ultramax differ.
- **No more empty halls.** Every enclosed space obeys a maximum size and a fill rule; a public deck is a street of
  venues, not one 1,000 m² room; an engine-room platform is walkways round machinery, not a dance floor.
- **Light, materials, sound.** Procedural textures (lino, carpet, teak, chequer plate, gratings, laminate, veneer) from
  one small atlas; practical lights you can see, emergency lights and photoluminescent strips, day light through the
  windows and a red-lit bridge at night; each space sounds like itself (ECR hum, galley extractor, hydraulic whine).
- **Things to do.** Helm and telegraph from the console, VHF and GMDSS open the real radio panel, the ECR opens an engine
  panel, wing consoles give a berthing view, doors swing as you pass, ladders are climbed (not teleported), Go-to stays.
- **Phones keep up.** Same §6.6 budgets (≤ 60k triangles, ≤ 80 draw calls); the detail comes from an atlas, merged
  chunks, instancing and per-room detail streaming, not from more draw calls.

### 0.2 Today versus v2 (measured on the live tree, `planFromGA`, method in §8.2)

| Measure | Today (examples) | v2 target |
|---|---|---|
| Crew cabin floor (merchant) | coaster avg 23.2 m², bulker 23.1, ulcv24k 16.3, legacy `boxship` 45.6 (max 109.6) | ratings 7.5–9.5, officers 9.5–12.5 (+ wet unit 1.6–2.4); seniors' suites §2.1 |
| Clear height in the house | 2.68 m (tier 2.8 − 0.12, no deckhead lining) | 2.15–2.30 m lined, deck-to-deck kept (§2.3) |
| Furniture footprint / floor | cabins 13–18 %, messes 5–7 %, galleys 6–21 %, bridges 3–7 % (VLCC 277 m² bridge: 3 %), ER 2–12 % | §2.1 `fill` bands (cabins 30–55 %, messes 25–45 %, bridge 15–30 %, ER see §4.6) |
| Free floor within 2 m of furniture/equipment (walls do not count) | ER: ulcv24k 4 %, vlcc300 3 %, bulker 24 %; public venues: cruise230 36 %, ropax200 40 % | ≥ 90 % (public ≥ 85 %) |
| Largest empty disc (radius) | ER 13.5 m (ulcv24k), 12.1 m (vlcc300); public 11.2 m (cruise230), 12.7 m (ropax200); ferry restaurant 6.9 m | ≤ 0.9–2.0 m by space (§2.1), atrium ≤ 4.0 m |
| Largest single room (non-cargo) | 1,301 m² ER platform (ulcv24k), 1,023 m² venue (cruise230), 918 m² saloon (hsc112) | caps §2.1 (venue ≤ 450 m², ER platform split into ≤ 12 m bays) |
| Interior materials | ~30 flat colours, one moving point light + 0.12 emissive | 1 atlas (24–48 tiles), 5 materials, baked practical/daylight/emergency light |
| Interactions | telegraph / ECR / thrusters print `engineText()`; ladders teleport | §7 stations, panels, animated ladders and doors |

### 0.3 What does not change

- The **exterior** (shipgen.js, shipgeom.js, gaext.js) and the **GA macro** (`shared/ships/ga.js`: hull, house box and
  tier heights, ER box and levels, pax decks and towers, deck gear positions). v2 subdivides and furnishes *inside* the
  GA envelope, so walls still sit inside the plating and nothing outside moves.
- The **walker** (`walker.js`) and every existing walking/budget suite: `test/interior.test.mjs`,
  `interior-review.test.mjs`, `interiors2-walk.test.mjs`, `interiors2-budget.test.mjs`, `interiors2-ga.test.mjs` pass
  **unmodified** on v2 plans (§8.4).
- The Plan shape (`shipplan.js` header): v2 only adds keys (§9.4); the legacy `kind` enum stays.
- The four sail classes stay SAILING's: v2 offers them a detail pass (Lane S) that SAILING approves (§9.1, Q8).

---

## 1. Common ground

### 1.1 Why v1 looks empty (diagnosis that the rules below answer)

1. **Slot-sized rooms.** `ga.js ringHouse/spineHouse` cut bands 3.8 m deep (`RULES.ROOM_D`) into slots 3.6–4.4 m long
   (`splitEven`), corners take `dS + CW`, `assignSlots` merges neighbours for messes, and leftovers become furnished
   "Spare cabin"/"Store room" (`fillSpares`). Rooms are sized by the house box, not by what is in them.
2. **One to three items per room.** `gaplan.js furnish()` places a bunk (+ desk ≥ 9 m², + lockers ≥ 12 m²); a mess gets
   1–2 tables; a galley one counter and a range.
3. **Open-plan machinery spaces.** `planEngineRoom` makes each ER level full-width strips (wings + centre) and only adds
   the ME, three gensets, a boiler and enclosed ECR/purifier/workshop; everything else is grating.
4. **One room per block on passenger decks.** `paxDeckPlan` turns each span between two stair towers into one public room
   (`paxFurnish` scatters tables on a 3.2 × 3.0 m grid).
5. **Big bridges.** The bridge room is the full house width × the front band; a VLCC's is 277 m² with one console row.
6. **Flat look.** Uniform `MeshStandardMaterial` colours, no textures, no deckhead, walls run to deck-to-deck height.

### 1.2 Rules

1. **Pure planners.** Space planning (Lane A), machinery planning (Lane M) and kit placement (Lane K) are pure,
   deterministic (seed = FNV hash of the variant id, `models.js hashStr`), node-tested, no three.js/DOM.
2. **GA frozen.** v2 reads `generalArrangement()`; it never changes its macro geometry. New knowledge lives in new modules.
3. **Gate per generator.** `IV2_READY` (Set of gen keys) decides per generator; `planFromGA` dispatches to v2 only for
   ready gens; `?iv2=0` (and `app.iv2 = false`) forces v1 at runtime. v1 code stays as the fallback for one release.
4. **Existing suites unmodified** (§0.3). New suites are `test/iv2-*.test.mjs` (the `interiors2-*` names are taken).
5. **Budgets of §6.6 stand** (§6); any relaxation needs the reviewer's sign-off with numbers.
6. **No image assets.** Textures are procedural canvases built at runtime and cached.
7. **Real basis first.** Where a rule has a real basis (SOLAS, MLC, LL66, ISO, IMO noise code) the number follows it;
   otherwise it is a tagged Game rule.

### 1.3 Who owns what

| Area | Owner | IV2 relation |
|---|---|---|
| `shared/ships/ga.js`, `gaplan.js` v1 planners, `gaprops.js` | YARD Lane C | read-only for IV2 except hook HV1 (one dispatch line in `planFromGA`) |
| `public/js/interior.js` | YARD Lane C (H11) | IV2 hooks HV2–HV5 (a few lines each) |
| `shipgen.js`, `shipgeom.js`, `gaext.js`, `ship.js` | YARD Lane B | untouched |
| `walker.js` | YARD Lane C | untouched |
| Sail classes in `shipplan.js`, `yachtlooks.js`, `rigmesh.js` | SAILING | Lane S hook HV10 needs SAILING's approval |
| `sound.js`, `main.js` | shared | additive hooks HV6–HV9 |

### 1.4 Glossary

**Space** — a room of the v2 space plan with a fine kind (`space`, §2.1) besides the legacy `kind`. **Kit** — the
furnishing recipe of a space kind. **Item** — one piece of equipment/furniture in the item catalogue (§3.1). **Run** — a
linear overhead element (pipe, cable tray, duct, frame, stiffener, handrail). **Lined space** — has wall panels and a
false ceiling (accommodation); **unlined** — bare structure (ER, stores, steering, holds, car decks). **Chunk** — a
cluster of rooms rendered as one detail unit (§6.2). **Clear height** — floor to false ceiling (or to the lowest run in
an unlined space). **Deck-to-deck** — tier height of the GA.

---

## 2. Room scale and density

### 2.1 Space table `SCALE` (frozen keys; values tunable by the reviewer)

Areas exclude the en-suite wet unit unless noted. `emptyR` = largest empty disc radius allowed (§8.1 A3); `fill` =
furniture/equipment footprint ÷ floor (A4). MLC minima are hard floors (Source S20); everything else Game rule *≈* typical
newbuild practice.

| `space` | Area m² min / target / max | Clear h (m) | Floor | Wall | Ceiling | emptyR | fill | Notes |
|---|---|---|---|---|---|---|---|---|
| `cabin_rating` | max(MLC, 6.5) / 8.5 / 10.5 | 2.15–2.25 | vinyl | laminate | panel | 0.9 | 30–55 % | MLC 4.5 / 5.5 / 7.0 by GT (S20); wet unit 1.6–2.0 m² by the door |
| `cabin_officer` | max(MLC, 8.5) / 11 / 13 | 2.15–2.25 | vinyl / carpet (eco) | laminate | panel | 0.9 | 30–55 % | MLC 7.5 / 8.5 / 10.0; wet unit 2.0–2.4 m² |
| `suite_bed` + `suite_day` | 9.5–12 + 14–20 | 2.2–2.3 | carpet | laminate/veneer | panel | 1.2 | 25–45 % | master, chief engineer, chief officer (≥ 3,000 GT, S20), owner (≥ 5 tiers) |
| `cabin_pilot`, `cabin_super` | 7 / 8.5 / 10 | 2.15–2.25 | vinyl | laminate | panel | 0.9 | 30–55 % | |
| `cabin_small` (tug, trawler, pilot) | 3.5 / 5 / 7 (2–4 berths) | 1.95–2.1 | vinyl | laminate | panel | 0.7 | 40–65 % | headroom ≥ 2.03 where crew move freely (MLC A3.1 6(a)); below-deck small craft Game rule 1.95 |
| `cabin_ferry` | 6.5 / 8.5 / 10.5 (+ WC/shower 2.0) | 2.2 | carpet | laminate | panel | 0.9 | 30–55 % | 2–4 berths |
| `cabin_cruise_in` / `_out` / `_bal` | 13 / 14.5 / 16 · 15 / 17 / 20 · 16 / 18.5 / 22 (incl. bathroom 3.5–4) | 2.35–2.45 | carpet | veneer | panel | 1.0 | 30–50 % | *≈* mainstream cruise ships (S30) |
| `cabin_crew_pax` (cruise/ropax crew) | 7 / 8.5 / 10 (2 berths) | 2.15 | vinyl | laminate | panel | 0.8 | 35–60 % | |
| `cabin_yacht` / `owner_yacht` | 8 / 11 / 15 · 14 / L-scaled / 45 (incl. head) | 2.0–2.15 (below), 2.2–2.4 (main) | wood | veneer | panel | 1.0 / 1.4 | 30–50 % | owner target = clamp(0.45·L, 12, 45) |
| `vberth` | 3 / 4.5 / 7 | 1.85–2.0 | wood | veneer | panel | 0.6 | 45–75 % | triangular berth under a deck hatch |
| `corridor` (cargo crew) | width 1.0 / 1.1 / 1.2 | 2.10 | vinyl | laminate | panel | — | — | main fore-aft / stair lobby 1.2; dead end ≤ 7 m (§2.2) |
| `corridor_pax` | width 1.2 / 1.3 / 1.5 | 2.25 | carpet | veneer | panel | — | — | handrail one side; LLL strips (S19 II-2/13) |
| `crew_alley` (cruise I-95, ropax) | width 2.4 / 3.0 / 3.6 | 2.3 | vinyl (heavy) | painted steel | open runs | 1.6 | carts/racks ≥ 10 % | |
| `corridor_yacht`, `passage_small` | width 0.85 / 0.95 / 1.1 | 1.95–2.1 | wood | veneer | panel | — | — | walker band ≥ 0.35 m |
| `mess` | 1.2 m²/seat, 10 / — / 50 | 2.25 | vinyl | laminate | panel | 1.2 | 25–45 % | seats = berths of that mess + 2 |
| `galley` | 8 + 0.35/meal, 8 / — / 40 (cargo); pax: 0.25 m²/cover | 2.25 | quarry tile | stainless | panel | 1.0 | 35–60 % | serving hatch + door to the mess (§4.2) |
| `pantry`, `provisions_dry` | 3 / 8 / 14 | 2.2 | quarry tile | stainless / painted | panel | 0.8 | 40–70 % | |
| `cold_room` (×2–3: meat/fish, veg, dairy) | 2 / 4 / 8 each | 2.1 | aluminium chequer | insulated panel | panel | 0.6 | 40–70 % | 150 mm insulated door |
| `hospital` | 7 / 9 / 14 (+ bath 3) | 2.25 | vinyl | laminate | panel | 0.9 | 30–55 % | crew ≥ 15 (S20 A4.1); stretcher-width door 0.9 |
| `laundry`, `drying_room` | 5 / 8 / 12 · 3 / 4 / 6 | 2.2 | vinyl | laminate | panel | 0.8 | 35–60 % | |
| `gym`, `recreation`, `lounge_crew`, `library` | 10 / 16 / 28 | 2.25 | rubber / carpet | laminate | panel | 1.4 | 25–45 % | gym ≥ 10,000 GT (S20) |
| `changing_er` | 6 / 9 / 14 | 2.2 | vinyl | laminate | panel | 0.8 | 35–60 % | at the ER entrance; boot rack, shower, overall lockers |
| `office`, `cargo_office` | 6 / 9 / 14 | 2.25 | vinyl | laminate | panel | 0.9 | 30–55 % | |
| `ccr` | 12 / 18 / 30 | 2.3 | vinyl | laminate | panel | 1.2 | 25–45 % | windows over the cargo deck |
| `bridge` (wheelhouse) | depth 5.5 / 7 / 9 m; width = house | 2.4–2.6 | vinyl (dark) | laminate | panel | 2.0 | 15–30 % | walkway behind the console row 1.2–1.8 m (MSC/Circ.982, S31) |
| `chartroom`, `radio_room`, `electronics`, `battery` | 3 / 6 / 12 | 2.3 | vinyl | laminate | panel | 0.9 | 35–60 % | behind the wheelhouse |
| `ecr` | 16 + 1.0/MW, ≤ 70 | 2.4 | vinyl (antistatic) | laminate | panel | 1.5 | 20–40 % | |
| `workshop`, `spares`, `elec_store` | 8 / 18 / 45 | unlined | steel / epoxy | painted | open runs | 1.0 | 30–60 % | |
| `purifier_room` | 8 / 14 / 30 | unlined | grating | painted | open runs | 1.0 | 35–60 % | |
| `er_platform` (bay) | ≤ 12 m long per bay | ≥ 2.0 under runs | grating / chequer | painted | open runs | 1.6 (`overhaul` bay 2.5) | §4.6 | |
| `steering_gear` | room aft, as GA | unlined | chequer | painted | open runs | 1.4 | 25–50 % | |
| `pump_room`, `compressor_house`, `winch_room`, `azimuth_room`, `emerg_gen`, `co2_room`, `fan_room`, `ac_plant` | 4 / 12 / 40 | unlined | chequer / grating | painted | open runs | 1.2 | 30–60 % | |
| `bosun_store`, `paint_locker`, `rope_store` | 6 / 15 / 40 | unlined | chequer | painted | open runs | 1.2 | 30–60 % | forecastle / poop |
| `stair` (inside) | width 0.9 / 1.0 / 1.2 | — | vinyl + nosings | laminate | panel | — | — | 42° accommodation (GA `STAIR_DEG`) |
| `lobby_pax` (tower lobby) | 20 / 45 / 120 | 2.6–3.0 | carpet / stone | veneer | panel | 2.5 | ≥ 12 % | lift bank, deck plan, muster sign |
| `atrium` | as GA tower, multi-deck void | void | stone | veneer/glass | feature | 4.0 | feature items ≥ 6 | reception, grand stair, glass lifts |
| `restaurant` | 1.4 m²/seat, ≤ 450 | 2.7–3.0 | carpet | veneer | coffered | 1.8 | 30–50 % | galley behind (`galley_pax`) |
| `buffet`, `cafeteria` | 1.3 m²/seat, ≤ 450 | 2.7 | vinyl / tile | laminate | panel | 1.8 | 30–50 % | serving line ≥ 6 m |
| `bar`, `lounge_pax`, `casino`, `nightclub` | 1.6 m²/seat, ≤ 350 | 2.6–3.0 | carpet | veneer | coffered | 2.0 (dance floor exempt ≤ 25 m²) | 25–45 % | |
| `theatre` | 0.7 m²/seat + stage, ≤ 900 | 2 decks | carpet | fabric | dark | 1.2 | seats ≥ 55 % | raked rows |
| `shop` | 20 / 60 / 150 per unit | 2.7 | stone / vinyl | laminate | panel | 1.4 | 30–55 % | |
| `seats_lounge` (ferry/HSC) | 0.9 m²/seat, ≤ 400 | 2.5 | carpet | laminate | panel | 1.2 | 45–65 % | rows of reclining seats |
| `kids`, `spa`, `medical_pax` | 30 / 80 / 200 | 2.6 | rubber / tile | laminate | panel | 1.6 | 25–50 % | |
| `wc_block` (pax) | 1.6 m² per WC + 3 | 2.3 | tile | tile | panel | 0.8 | 35–60 % | per tower lobby on public decks |
| `saloon_yacht`, `skylounge` | 12 / 0.9·L / 70 | 2.1–2.4 | wood / carpet | veneer | panel | 1.4 | 30–50 % | |
| `galley_yacht`, `head` | 4 / 8 / 18 · 1.6 / 2.4 / 4 | 2.0–2.2 | tile | veneer | panel | 0.8 / 0.5 | 40–65 % | heads below 2.0 m² are kit blocks, not rooms (door ≥ 0.72 rule) |
| `wheelhouse_small` | as GA | 2.0–2.2 | vinyl | laminate | panel | 1.2 | 25–45 % | 360° windows on tugs |
| open decks, `cardeck`, `hold`, `tank`, `pen`, `hopper` | — | — | deck / teak / steel | — | — | exempt | detail density §8.1 A6 | cargo and weather spaces |

`deckH` (deck-to-deck, from the GA) is kept; `h` = clear height. The 0.3–0.6 m plenum above lined spaces is not drawn;
in unlined spaces `h` reaches the deck above and runs hang in it (§2.4).

### 2.2 Circulation rules (Game rule unless noted)

| Rule | Value | Basis |
|---|---|---|
| Every cabin door opens onto a corridor, lobby or (suites) its own day room | hard | practice |
| Dead-end corridor length | ≤ 7 m | SOLAS II-2/13.3.1.3 (passenger ships); applied to all (S19) |
| Escape from each accommodation tier | 2 routes: main stair + external stair/ladder to an open deck (one per tier side or aft face) | SOLAS II-2/13.3, 13.4 (S19) |
| Escape from the ER | 2: stair column + escape trunk ladder (GA `er.escape`) | SOLAS II-2/13.4.2 |
| Stair clear width | ≥ 0.8 m cargo, ≥ 0.9 m passenger | FSS Code ch. 13 *≈* (S32) |
| Corridor without a fire door | ≤ 40 m (pax: at every main vertical zone boundary, GA `pax.mvz`) | SOLAS II-2/9 (S19) |
| Doors | cabin 0.75–0.8, mess/galley/office 0.85–0.9, hospital 0.9, ER/WT 0.75–0.9, pax public 1.2 double | test floor 0.72 (`interior.test.mjs`) |
| Door sills | inside 0.05; wet units 0.10; weathertight to open deck 0.38; ER/steering WT 0.15–0.30 | LL66 Reg 12 (S33) for 380 mm |
| Lift | cargo ships with ≥ 6 house tiers; pax per tower | practice |
| Stair vs ladder | accommodation stair 42°; ER stair 55° (GA); inclined ladder 60–70° in ER bays, steering, pump room; vertical ladder in escape trunks, holds, masts, tank hatches (walker ladder links) | practice |

The walker is unchanged: sills are **visual** (frame + plate) and the avatar lifts its feet over them in `interior.js`
(visual y-bump ≤ sill height within 0.35 m of a door, Lane I) — no collision step.

### 2.3 Structure you see

- **Frame spacing** `s = min(0.85, 0.002 L + 0.48)` m (coaster 0.66, tug 32 m 0.54, Ultramax 0.85); web frames every
  4 frames; longitudinal deckhead stiffeners at 0.75 m on L ≥ 120 m, transverse beams below. *≈* class-rule standard
  spacing (S34). Frame numbers (`FR 42`) stencilled every 5th frame in unlined spaces, counted from the aft
  perpendicular (z = L/2 − 0.03 L).
- **Unlined spaces** show frames (flat-bar + flange, 2 boxes), brackets at the deck corners, deck girders, stiffeners on
  bulkheads; **lined spaces** show panel joints every 0.6 m, ceiling panels 0.6 × 0.6 with diffusers and fittings.
- **Hull side inside** (below the main deck): a sloping/curving inner shell is not lofted; the room wall stands
  `HULL_IN` inside the plating (as v1) and, in unlined spaces, carries frames every `s` so the hull shape reads.

### 2.4 Deckheads, floors, walls (per space, defaults in §2.1)

- **Runs (unlined):** cable trays (ladder type 0.3–0.6 m wide, cables drawn as a flat bundle), pipes Ø 0.05–0.4 with
  ISO 14726 colour bands (fuel brown, lube oil yellow, fresh water blue, sea water green, fire main red, steam silver,
  air light blue, bilge/sewage black — Source S35 *≈*), ventilation ducts (rectangular 0.4–1.2 m), hangers every 2 m.
  Corridors in lined spaces: none visible (false ceiling), except crew alleys (open runs).
- **Floors:** vinyl/lino (accommodation, grey/blue/beige by era), carpet (officers in eco era, pax), quarry tile
  (galley, provisions, wet units), aluminium chequer (cold rooms), steel chequer plate (stores, steering), gratings
  (ER walkways, catwalks), teak (yacht decks, pax promenades), epoxy (workshops), painted steel with lane markings (car
  decks), rubber (gym).
- **Walls:** laminate panels (white/cream/light grey), veneer (yacht/pax/suites), stainless (galley), tile (wet units),
  insulated panels (cold rooms), painted steel (unlined; ER light green/grey, stores grey).

### 2.5 Windows, portholes, views

- Window kinds: `window` (rect 0.8–1.2 × 0.9, house fronts/sides, one per cabin or office module, centred on the module),
  `porthole` (Ø 0.4, hull sides above the waterline, below the main deck; drawn as a square opening + round frame item),
  `bridge` (front/sides/rear, sill 1.0, head 2.35, mullions every 1.2–1.6 m, inclined 10–15° outward at the top on the
  front — the frame, not the walk wall), `door_glass` (balconies, yacht saloons).
- No openings below the waterline (y < 0.3) on any type; spaces there are `dark`.
- **Real view:** a room with windows lists `views` (zones seen through them, §6.2), which the renderer keeps at LOD1 so
  the bridge of a ULCV sees the container stacks and cranes, a CCR sees the manifold, a cabin sees the sea. The
  existing `setOcean` rule stays (ocean hidden only in windowless/below-waterline spaces).
- **Bridge front:** wipers (2–5 by width) and clear-view screens (≥ 1, spinning disc) animate when it rains
  (`app.wx.rain > 0.05`); sun visors; night: glass reflects the red/console glow (emissive tint).

---

## 3. Furnishing kits

### 3.1 Item catalogue (`public/js/iv2items.js`, data; frozen record shape)

```js
ITEMS[id] = { w, d, h,              // footprint and height (m) — the solid the walker meets
  wall: 'back'|'side'|null,         // must stand against a wall (which face)
  clear: { front, side },           // free floor it needs to be usable (also kept clear for the walker)
  solid: true|false|'low',          // 'low' = under 0.4 m (rugs, mats): no solid
  tris: [lod0, lod1],               // budget the renderer must meet (§6.3)
  tiles: [...atlas tile ids],       // materials it uses (§5.2)
  hot?: { kind, label, at: [dx, dz] }, // hotspot it carries (legacy kinds kept, §7)
  light?: { kind, y, lm }, emit?: { kind, level } }
```

Item ids are grouped below with typical dimensions (m, w × d × h; Game rule *≈* typical marine outfitting). Tri budgets
are LOD0/LOD1.

| Group | Items (w × d × h) | LOD0 / LOD1 tris |
|---|---|---|
| Berths & seating | `bunk` 2.0×0.9×0.6 (drawer base, mattress, lee board, reading light, curtain rail); `bunk2` two-tier ×1.6; `bed_double` 2.0×1.6; `bed_island` 2.1×1.9; `vberth` triangle 2.0×2.0; `settee` 1.8×0.7; `settee_L` 2.2×1.6; `armchair` 0.8; `chair` 0.5; `stool_bar`; `pilot_chair` 0.8×0.8×1.3 (pedestal, armrests, joystick pods); `bench_mess` 1.6×0.45; `seat_recliner` row 0.55/seat; `theatre_row` 0.55/seat | bunk 260/12, chairs 80/12 |
| Storage | `wardrobe` 0.6–1.2×0.6×2.0; `locker_tall` 0.4×0.5×1.9 (rows); `drawers` 0.8×0.5×0.8; `shelf_rack` 1.0–2.4×0.5×2.0 (with boxes); `cabinet_file`; `chart_drawers` 1.4×0.9×0.9; `bonded_cage`; `rope_reel` Ø1.2 | 120/12 |
| Tables & desks | `desk` 1.0–1.2×0.6 (chair, lamp, monitor, phone); `table_mess` 1.6–2.2×0.8 (fiddle rail, condiment rack); `table_round` Ø0.9–1.4; `coffee_table`; `dining_yacht` 2.4×1.1; `chart_table` 1.4×0.9×0.95 (lamp, drawers, chart); `workbench` 2.0×0.8 (vice, tools board) | 150/12 |
| Wet & galley | `wet_unit` 1.2–1.5×1.3–1.6×2.1 (enclosed module: door item, WC, basin, shower) ; `wc`, `basin`, `shower_tray`, `urinal`; `range` 1.2–1.8×0.9 (hot plates, oven, rail); `oven_combi` 0.9×0.8×1.8; `fryer`; `kettle_tilt`; `fridge_upright` 0.7×0.75×2.0; `freezer_chest`; `dishwasher_hood` 0.8×0.8×1.9; `sink_double`; `counter` with fiddle rail and drawers; `extractor_hood` (overhead run item); `serving_hatch`; `bain_marie`; `coffee_machine`; `buffet_island` 3–6×1.2; `bar_counter` | 160/12 |
| Bridge | `console_seg` 0.9–1.2 wide × 0.9 deep (sloped top, 1–2 screens: `radarX`, `radarS`, `ecdis`, `conning`, `autopilot`, `alarm`, `thruster`, `dp`); `steer_stand` 1.2–1.6 (wheel or tiller, rudder indicator, autopilot, mode switches, emergency steering); `telegraph_lever` (combinator) pair; `vhf_handset` (on console/wings); `overhead_panel` (rudder, ROT, heading, speed log, depth, wind, clock — 0.3 deep, hung at 2.1); `gmdss` 1.4×0.75 (VHF DSC, MF/HF, NAVTEX, Inmarsat-C, printer, EPIRB/SART brackets); `vdr_panel`; `fire_panel`; `bnwas`; `navlight_panel`; `wiper`; `clearview`; `sun_visor`; `pelorus` (wings); `wing_console` 0.7×0.6; `signal_lamp`; `binocular_rack`; `lifejacket_box`; `coffee_corner` | console_seg 420/16, steer_stand 600/20 |
| Engine room | `me2s_section` per cylinder (bedplate, A-frame, cylinder block, cylinder cover with exhaust valve actuator, indicator cock, HCU), `me2s_end` (thrust block, chain drive end, turning gear), `exh_receiver` (cylinder along the top), `turbo` (Ø 1.0–2.4: compressor + turbine casings, air filter silencer), `scav_cooler`, `me4s` inline/V (block, heads, rocker covers, TC, charge-air cooler, flywheel), `genset` (engine + alternator on a bedframe), `purifier` 0.9×0.9×1.4, `heater_skid`, `pump_v` (vertical, Ø0.4–1.0, motor on top), `pump_h`, `cooler_plate` 0.6×1.2×1.6, `air_compressor`, `air_receiver` (vertical Ø0.8×2.2), `fw_generator`, `sewage_plant`, `ows`, `incinerator`, `boiler_aux`, `hydrophore`, `fuel_module` 3×1.5×2.2, `tank_wall` (service/settling tank face with gauge glass and manhole), `msb_panel` 0.8×0.6×2.2 (meters, breakers), `mcc_panel`, `ecr_console` 2.4–3.6×0.9 (screens, mimic), `local_stand`, `lathe`, `drill_press`, `welding_bench`, `crane_rail` (overhead), `chain_block`, `spares_rack`, `fire_station` (hose box, extinguishers), `bilge_well_plate` | me2s_section 900/30, turbo 500/20, genset 900/24, pump 160/12 |
| Steering & aft | `steering_rotary` / `steering_ram` (rudder stock, tiller or rotary vane, 2 HPUs), `emerg_steer_panel`, `sound_powered_phone`, `pod_motor` (cruise/icebreaker), `z_drive_top` (tugs) | 700/24 |
| Deck machinery | `windlass` (gypsy, band brake, warping end, chain pipe, stopper), `mooring_winch` (split drum + rope), `capstan`, `bitt_double` 1.2×0.5×0.6, `fairlead_roller`, `chock_panama`, `chock_closed`, `rope_coil`, `anchor_light`, `bell`, `foremast`, `eta_tanker` (pick-up buoy box, chafing chain), `hose_crane`, `manifold_valves`, `crane_pedestal` (+ cab peek), `lifebuoy`, `fire_box`, `vent_mushroom`, `sounding_pipe`, `air_pipe_head`, `hatch_access` (raised, dogged) | windlass 900/30, bitt 120/8 |
| Cargo views | `hold_frames` (instanced), `hopper_slope`, `topside_tank`, `cell_guide`, `ladder_cage`, `bilge_well`, `cargo_heap` (from `you.cargo` kind: grain/coal/ore colour), `tank_long_stiff`, `heating_coil`, `membrane_panel` (corrugated stainless tile), `rsw_tank`, `fish_box_stack` | per m² §6.3 |
| Public & yacht | `reception_desk`, `glass_lift`, `grand_stair` (feature), `chandelier`, `planter`, `artwork`, `slot_row`, `gaming_table`, `stage`, `dance_floor` (low), `shop_gondola`, `till`, `play_soft`, `sun_lounger`, `pool_ladder`, `tv_lift`, `sideboard`, `wine_rack`, `vanity`, `sauna_bench`, `treadmill`, `bike`, `weights`, `massage_bed` | 120–400/12 |
| Safety & signs | `exit_sign` (green running man, emissive), `lll_strip` (photoluminescent, low), `fire_ext`, `fire_plan` (framed), `muster_board`, `deck_sign`, `frame_no`, `pipe_arrow`, `hazard_paint` (yellow/black), `first_aid_box`, `eyewash`, `sopep_locker` | ≤ 40 each |

### 3.2 Kits per space (Lane K; "must" items always, "fill" items until the fill band is met)

Placement order in every kit: (1) **circulation skeleton** — reserve a ≥ 0.75 m lane from each door to each hotspot
standing point and across the room's long axis (walker radius `R` 0.25 → ≥ 0.25 m band); (2) wall-bound musts; (3)
free-standing musts; (4) fill items by priority until `fill` ≥ band low and `emptyR` holds; (5) small dressing items
(no solid) and wall/overhead items. Items never cover a window by more than 30 % of its width, never stand in a door
approach (v1 `freeRect` rules kept), never in stair/landing reserves.

| Kit | Must | Fill (priority order) | Hotspots |
|---|---|---|---|
| `cabin_rating` / `cabin_officer` | wet unit at the door corner; bunk under the window (long wall); desk + chair; wardrobe | settee (officer), drawers, shelf, bin, lifejacket box, curtain, notice board, rug | `bunk` |
| `suite_*` | bed / desk / wardrobe (bed room); settee L + coffee table + 2 armchairs + desk + fridge (day room); connecting door | sideboard, TV, bookshelf, safe, plants | `bunk` |
| `cabin_small` / `vberth` | bunks (two-tier on tugs/trawlers), lockers per berth, hand holds | shelf, foul-weather hooks, dehumidifier | `bunk` |
| `mess` | tables with fixed benches/chairs (seats = berths + 2), serving hatch to galley, TV | coffee corner, water cooler, notice board, menu board, trays rack, fridge | — |
| `galley` | range (+ hood), oven, fridge ×2, freezer, dishwasher, double sink, counters on ≥ 2 walls (U/L), serving hatch | tilt kettle (crew ≥ 20), fryer, mixer, utensil rack, pot shelves, bins | `galley` |
| `provisions` / `cold_room` | shelf racks both sides | sacks, crates, hanging meat rails (cold), thermometer | — |
| `hospital` | hospital bed (centre-approachable), medicine cabinet, desk, basin, stretcher on wall | oxygen set, examination lamp, fridge | `hospital` |
| `laundry` | washers ×2, dryers ×2, folding table, ironing board | drying rack, sink | — |
| `gym` / `recreation` / `library` | treadmill, bike, weights, mat (gym); sofa, table, TV, games (rec); shelves, armchairs (library) | table tennis (rec ≥ 20 m²), dart board, plants | — |
| `changing_er` | lockers row ×(engine crew), bench, boot rack, shower, overall hooks | eyewash, PPE shelf | — |
| `office` / `cargo_office` | 2 desks, file cabinets, copier, safe | notice boards, chart of tank plan (CCR-adjacent) | — |
| `ccr` | cargo console (loading computer, mimic, valve remotes), IG/gas detection panel, ballast console, desk | printer, tank-gauging panel, chairs | `ccr` |
| `bridge` | console row across ≥ 60 % of the front: centre `steer_stand`, stbd radar X + conning + `telegraph_lever`, port radar S (≥ 3,000 GT) + ECDIS ×2, alarm/thruster panels; 2 `pilot_chair`; `overhead_panel`; `gmdss` aft port; `chart_table` aft stbd; `bnwas`, fire/VDR/nav-light panels on the rear wall; wipers/clear-views/visors; `vhf_handset` ×2 | coffee corner, binocular rack, lifejacket box, signal lamp locker, flag locker (if no flag room), plants (eco) | `helm`, `telegraph`, `whistle`, `radio`, `gmdss`, `chart`, wings: `thrusters` + `whistle` |
| `bridge_wing` | `wing_console` (engine, rudder, thrusters, VHF), `pelorus`, signal lamp | lifebuoy w/ light, window for the side view (enclosed) | `thrusters`, `whistle` |
| `wheelhouse_small` | helm seat(s), dash (2–4 MFD, throttles, joystick, VHF, autopilot), aft station on tugs/trawlers (ASD levers, winch controls), 360° windows (tugs) | chart table (≥ 18 m), sonar/sounder (fishing), coffee | `helm`, `radio`, `thrusters` (aft), `telegraph` (≥ 24 m) |
| `ecr` | `ecr_console` facing the ER window; `msb_panel` line (`2 + gens + 6` panels); AMS alarm/printer; chair ×2; desk | spares cabinet, A/C unit, telephone exchange, kettle | `ecr`, `engine` |
| `er_platform` (bay) | see §4.6 machinery packer | — | `engine` (local stand), `ladder` |
| `purifier_room` | purifiers (`hfo`: 2 FO + 1 LO; `mgo`/`lng`: 1 + 1), heaters, sludge tank face | tool board, drip trays | — |
| `workshop` | lathe, drill press, workbench + vice, welding bench, spares racks | grinder, tool boards, gas bottles (secured) | — |
| `steering_gear` | rudder stock + rotary vane/ram, 2 HPUs, emergency steering panel, sound-powered phone, rudder angle indicator | spares rack, oil drums | `steering` |
| `pump_room` (tankers, legacy rows) | cargo pump casings ×3 + stripping, bulkhead shaft seals, inclined ladders down 2 flats | gas detector, bilge alarm | `info` (enclosed-space sign) |
| `winch_room` (AHTS) | towing/anchor drums ×3, wire stoppers, control stand | spare wire reels | `winch` |
| `compressor_house` (LNG) | HD/LD compressors ×2+2, heaters, vaporiser | control panel | `info` |
| `bosun_store` | shelves, rope coils, paint drums, hatch + ladder from the forecastle | chain blocks, shackles box | `ladder` |
| `restaurant` | tables 2/4/6 at 1.4 m²/seat, waiter stations every 60 m², pass to galley, buffet (cafeteria) | planters, artwork, room dividers (every 12 m), wine rack | `info` |
| `bar` / `lounge_pax` / `casino` | bar counter + stools, seating clusters (sofa + 2 armchairs + table), stage (lounge ≥ 150 m²) | piano, slots rows / tables (casino), dividers | — |
| `theatre` | stage + proscenium, raked rows (0.9 m pitch), aisles 1.2 | sound desk, balcony rows (2-deck) | `info` |
| `shop` | gondolas at 1.6 pitch, till counter, wall shelving | displays, mannequins | — |
| `seats_lounge` | recliner rows at 1.0 pitch, aisles 1.0 every 8 seats | luggage racks, TV | — |
| `lobby_pax` / `atrium` | lift bank, deck plan board, muster sign, seating cluster (≥ 40 m²) | reception (atrium), grand stair, chandelier, planters, artwork, café counter | `goto`, `info` |
| `cabin_cruise_*` / `cabin_ferry` | bed(s), nightstands, desk/vanity + stool, wardrobe, bathroom block, sofa (≥ 15 m²), balcony door | TV, minibar, luggage, curtains | `bunk` |
| `crew_alley` | cart parking bays, cage pallets, notice boards, fire stations every 20 m | provision trolleys, laundry carts | — |
| `saloon_yacht` | settee L/U + coffee table, dining table + chairs (seats = guests), sideboard/bar, TV lift | plants, rugs, curtains, bookshelf | — |
| `galley_yacht` | U/L counter, hob, oven, fridge column, dishwasher, sink | dumbwaiter (≥ 45 m), crockery lockers | `galley` |
| `owner_yacht` / `cabin_yacht` | bed (island/double/twin), nightstands, vanity, wardrobe/walk-in, en-suite head (room ≥ 2.0 m², else block) | settee, desk, TV | `bunk` |
| `head` | WC, basin vanity, shower (≥ 2.4 m²) | towel rails, mirror cabinet | — |
| mooring deck (zone kit) | per GA `deck.mooring`: windlass/winches; bitts every 9 m along both sides from the fairlead lines; roller fairleads at the bulwark opposite each winch drum; Panama chocks fore and aft on the centreline; rope coils on gratings; bosun store hatch; foremast + anchor light + bell (fwd); ETA (tankers ≥ 20,000 dwt, S19 II-1/3-4) | vents, sounding pipes, air pipe heads every frame bay along the side | `winch` |
| open deck (strip kit) | per frame bay: air pipe heads, sounding caps; fire hydrant + hose box every 20 m; lifebuoys at 1 per 40 m per side (S19 III) | access hatches, deck lights | — |
| `hold` (walk) | frames, hopper/topside slopes (bulk), cell guides (container), cage ladder, bilge wells, floodlights ×2, cargo heap | — | `ladder` |
| `tank` (peek, §7.6) | longitudinals, webs, heating coils, ladders, sloped bottom (diorama, not walkable) | — | `peek` |

### 3.3 Template cache (speed)

Kit results are cached by `(kit, round(w, 0.1), round(d, 0.1), doorSide, doorAt-bucket, windowSides, params.style)` and
re-used (translated/rotated) for every identical room module — a VLCC's 30 near-identical cabins cost one solve. The
cache key and result are pure; the node test checks a cached placement equals a fresh one.

---

## 4. Layout grammar per type and parameters per model

### 4.1 The planner (Lane A, `shared/ships/gaspace.js`)

Input: the frozen GA (`ga.house.tiers` boxes and tier ys, `house.core`, `er.column` slot, casing, entrances, `ga.pax`,
`ga.small`, `ga.yachtAft`), the model and its variant options. Output: a `SpacePlan` (§9.3). Steps per accommodation
level:

1. **Fixed:** stair core (GA), lift shaft (§2.2), casing/uptake void (GA `casing` + funnel), ER entrance trunk (GA
   `erSlot`), external escape stair landing (§2.2) — these are `voids`/stairs, never furnished rooms.
2. **Corridor network** by house size (Game rule): house width `W < 9 m` → *single-loaded spine* (corridor on one side);
   `9 ≤ W < 16` → *double-loaded* (one fore-aft or athwartships corridor, modules both sides); `W ≥ 16` and depth ≥ 14
   → *ring* round a core whose faces are lined with service spaces (toilets, linen, AC/fan rooms, stores, lift). The
   grammar (§4.2) may force one (ferry crew decks: double-loaded; cruise cabin decks: two corridors with an inner band).
3. **Modules:** band depth from the programme (cabins 3.2–3.6 m incl. wet unit; messes/galley 4.0–5.5 m); module width =
   target area ÷ band depth, snapped to 0.05 m, so cabins meet §2.1 instead of the slot grid.
4. **Programme** (grammar §4.2, numbers from §2.1 and `ModelParams`), placed by **adjacency rules**:
   galley ↔ mess (shared wall with hatch), provisions/cold rooms ↔ galley (same deck, ≤ 12 m), changing room ↔ ER
   entrance, hospital ↔ stair (≤ 8 m, door 0.9), laundry ↔ ratings' cabins, master's cabin on the top accommodation tier
   starboard-forward, chief engineer port-forward, CCR on the main deck facing the cargo with windows, ship's office near
   the main entrance, bridge-deck spaces behind the wheelhouse (chartroom/radio, electronics, battery, pilot WC, pantry).
5. **Fillers** (no "spare" rooms): leftover module area goes to the tier's filler list in priority order (§4.2), then
   neighbours grow to their `max`, then a store (store kit, door, ≥ 35 % fill). A filler is only placed if its own
   §2.1 min is met.
6. **Score and choose.** Up to 12 variants (topology × module width {2.6 … 3.4} × filler order) are scored; the lowest
   wins, ties broken by variant index (deterministic):

```
score = 100·unreachable + 50·deadEndOver7m + 40·missingMust + 10·voidUnjustified_m² + 5·overCap_m²
      + 3·waste_m² + 2·Σ|area − target|/target + 1·adjacencyMisses
```

`waste` = floor not in any space or justified void; `voidUnjustified` = closed area without a door and without a void
reason. A plan with `unreachable > 0` or `missingMust > 0` throws in tests (and falls back to v1 at runtime).

### 4.2 Grammar per generator (signature spaces; `→` = adjacency)

| Gen | House topology | Tier programme (bottom → top) | Signature spaces and fillers | ER / machinery | Decks and cargo views |
|---|---|---|---|---|---|
| `aft_house_dry` | ring (W ≥ 16) else double-loaded | A: galley → messes (officers/crew ≥ 10 crew), provisions + cold rooms, changing → ER entrance, ship's office, CO₂ room (deck-side); B: ratings, laundry, hospital (≥ 15), gym/rec (≥ 10k GT); C: officers, library; D: seniors' suites, owner/pilot; nav: wheelhouse + chartroom/radio + electronics + battery + pilot WC | fillers: linen, AC room, fan room, bonded store, smoke room, cadet study, conference | 2-stroke (≥ 120 m) or 4-stroke; full ER packer (§4.6) | forecastle bosun store; poop mooring; hold walk; crane cab peek (geared); livestock: pens with feed/water lines |
| `aft_house_tanker` | as dry | + CCR on A deck forward-facing, cargo office; foam room, IG blower room in the casing | fillers + gas-detection store, sample locker (deck) | + pump room (legacy rows) or deep-well hydraulic power pack room; IG plant | catwalk, manifold platform with hose cranes, ETA aft and fwd (≥ 20k dwt), tank peek through a Butterworth/access hatch |
| `lng` | ring | + larger CCR (cargo + gas management), GCU control | — | 2 × 2-stroke DF, GVU rooms (gas valve units), N₂ generator | trunk deck walk, compressor house (walkable), dome peek (membrane tiles) |
| `container` | aft house double-loaded (feeders) or twin island (ULCV: accommodation house forward, ER + casing aft) | as dry; reefer electrician office | reefer monitoring panel in the ECR | 2-stroke, long shaft tunnel (twin island) | lashing bridge walk (lashing bars, twistlock bins), hold view with cell guides |
| `roro_pctc` | double-loaded forward house | as dry | lashing gear store, ramp control room (aft) | 2-stroke/DF low ER | car decks: lanes, vehicles, lashing points, deck fans, ramp control panels, stair doors |
| `ferry` | pax grammar §4.3 | crew deck: officers' cabins, crew mess, galley (crew), bridge forward | info desk, cafeteria, seats lounge, shop, kids, WC blocks per tower | 4-stroke × 2–4 / DE | car deck(s), outer promenade with lifeboats; `ferry50`: two wheelhouses, one saloon with benches |
| `cruise` | pax grammar §4.3 | crew decks (I-95 alley, crew cabins 2-berth, crew mess/bar, provisions, laundry, galleys under restaurants), public decks, cabin decks, lido | atrium, theatre forward, main dining aft, buffet on lido, spa, casino, shops street | DE gensets, pod rooms aft | lido pool, sun deck, boat deck promenade |
| `offshore` | forward house double-loaded | A: mess/galley/changing (big, PPE lockers, drying room), CCR-like `dp_room` (SOV: gangway control); B–C: 1–2 berth cabins (SOV technicians ×N), gym/cinema (SOV), hospital; nav: bridge with aft-facing DP console | AHTS winch room, SOV gangway tower room | DE or 4 × 4-stroke, thruster rooms fwd/aft | long aft deck: crash rails, tank hatches, stern roller/shark jaws (AHTS), tugger winches |
| `tug` | small grammar §4.4 | main: mess-galley, captain's cabin; below: 2–4 cabins | — | 2 × 4-stroke, Z-drive tops in the azimuth room | tow winch deck, staple, fenders |
| `fishing` | small grammar (≥ 60 m: double-loaded) | below/main: crew cabins (2–4 berths), mess-galley; wheelhouse with fishing electronics | factory80: processing deck (gutting tables, conveyors, plate freezers, packing), fishmeal plant (peek) | 4-stroke | fish hold/RSW tanks with boxes and ice, net drum, gantry, power block |
| `small_fast` | small grammar | wheelhouse seats; below: V-berth, head, crew cabin; CTV: passenger cabin (12 suspension seats, PPE lockers) | — | HS diesels/jets | transfer foredeck, pilot ladder area |
| `motor_yacht` | L < 30 small grammar; else yacht grammar §4.5 | lower: guest cabins en-suite, crew forward (crew mess → galley via pantry), laundry; main: saloon, dining, galley, owner's suite forward; upper: sky lounge, captain; nav: wheelhouse | beach club, tender garage, gym, cinema (giga) | 2 × 4-stroke / DE | flybridge/sun deck: helm, bar, sun pads; swim platform |
| `special` | as offshore | research: wet lab, dry lab, CTD hangar, moon pool room, scientists' cabins, conference; icebreaker: fwd + aft bridges, hangar, mission room; dredger: dredge control on the bridge aft side | sample freezers, workshop (science) | DE + pods; dredge pump room (peek) | A-frame deck, hopper view, helideck |

### 4.3 Passenger decks (ferry, cruise) — the "street" grammar

- Each public deck block between towers is cut into: a **main concourse** fore-aft (2.4–4.0 m wide, one side or centre),
  **venues** along it sized from seats (§2.1, `≤ 450 m²` restaurants, `≤ 350 m²` bars), **back of house** behind the
  venues on the inboard side (galley behind each restaurant, stores, crew service corridor linking towers), **WC blocks**
  and **lobbies** at each tower. A venue larger than its cap is split with a divider or a second venue.
- Venue list per type (`ModelParams.venues`, deterministic order from the seed): ferry — info desk, cafeteria,
  seats lounge, bar, shop, kids, restaurant, pet area, lorry drivers' lounge (ro-pax); cruise — atrium, main dining (2
  decks), specialty restaurants ×2–4, buffet (lido), theatre (2 decks, forward), bars ×3–6, casino, shops ×4–8, library,
  card room, spa/gym, kids club, art gallery, medical centre (crew deck 2).
- Cabin decks: two corridors (§2.1 `corridor_pax`), outside/balcony cabins outboard, inside cabins back to back, a
  service band (linen, pantry) in the middle; cabin modules from §2.1 targets (cruise 2.9–3.4 m wide).
- Crew decks (cruise/ro-pax): `crew_alley` along one side over ≥ 60 % of the length; crew cabins, mess, bar, laundry,
  provisions; galleys stacked under restaurants.
- Room cap 400 per deck plan stays (§6.6): balconies are not walkable rooms (Q19).

### 4.4 Small craft (tug, pilot, CTV, fishing < 60 m, cruiser/flybridge yachts < 30 m)

v1 `ga.small` compartments stay the envelope; v2 subdivides each compartment: cabins in pairs with a passage
(`passage_small` 0.85–0.95), mess-galley as one space with a U settee and galley counter, heads as blocks or rooms
(≥ 2.0 m²), engine room with two engines, gensets, tanks, switchboard and a work bench, steering/azimuth room with drive
tops. Wheelhouse kit per §3.2. Every compartment meets `emptyR` 0.7–1.0.

### 4.5 Yachts ≥ 30 m

Lower deck: double-loaded guest corridor (0.95–1.1), en-suite cabins (§2.1), crew area forward behind a crew door
(crew mess → crew galley/pantry → dumbwaiter), laundry; main deck: saloon aft (glass doors to the aft deck), dining,
galley (service side), owner's suite forward (bed, dressing, en-suite, study ≥ 45 m); upper: sky lounge, captain's
cabin, office, wheelhouse; sun deck: bar, helm, jacuzzi (≥ 60 m), sun pads. Finishes: veneer walls, wood floors,
leather/fabric tiles; `ModelParams.style = 'yacht'`.

### 4.6 Machinery packer (Lane M, `shared/ships/gamach.js`)

1. **Main engine detail** `meDetail(ga)`: 2-stroke cylinders by kW per engine (<5,000: 5; <17,000: 6; <26,000: 7;
   <34,000: 8; <42,000: 9; <50,000: 10; <62,000: 11; else 12) and turbochargers (≤ 20 MW: 1; ≤ 45 MW: 2; else 3) —
   Game rule fitted to typical low-speed engine programmes (S36 *≈*); 4-stroke per engine: ≤ 2,000 kW L6, ≤ 3,500 L8,
   ≤ 4,500 L9, ≤ 9,000 V12, ≤ 13,000 V16, else V20. Expected: ultramax64 6 cyl / 1 TC, vlcc300 7 / 2, ulcv24k 11 / 3,
   capesize180 6 / 1, coaster L6, tug 2 × L8, ferry 2 × V12, ropax200 4 × V12. Engine block dims stay GA `meDims`.
2. **Equipment list** `erEquipment(ga, params)` (Game rule counts): gensets (GA), purifiers (§3.2), heaters, fuel
   module, pumps: SW cooling 2 (+1 if kW > 15,000), FW HT/LT 2+2, LO 2, ballast 2 (big, floor), bilge 1, fire 2, GS 1;
   coolers 2–4; air compressors 2 + receivers 2; FW generator; sewage plant; OWS; incinerator (≥ 3,000 GT); aux boiler
   (GA) + economiser in the casing; hydrophore; ER fans 2–4 (duct drops); tanks faces (service ×2, settling ×2, LO,
   sludge) on wing bulkheads; spares racks; fire stations; options: `scr` → scrubber + pumps in the casing, `lng`/`meoh`
   → GVU room + fuel prep skid, `esd` → none inside.
3. **Bays:** each ER level is cut into bays ≤ 12 m along z (web-frame aligned). Walkways: 1.0–1.2 m both sides of the ME
   on every level, a cross walkway every bay, 0.8 m branches to every item's `clear.front`; the stair column and escape
   trunk landings reserved. Everything else in a bay is **machinery** (items packed against bulkheads first, then
   islands) or **void** (no floor: a `cut` with railings, where nothing fits and the space is open to the level below).
   No bare grating floor bigger than `emptyR` 1.6 m except one `overhaul` area per ER (≤ 3 × 4 m beside the ME, with
   the overhead crane hook and a spare cylinder cover).
4. **Runs:** a pipe rack along each wing deckhead and over the ME top platform; every pumped item gets 1–3 L-shaped
   connections to the nearest rack (system by item: fuel brown, LO yellow, FW blue, SW green, fire red, air light blue,
   steam silver); cable trays over walkways; ducts from fans. Hard limits: runs never below `y + 2.0` over a walkway.
5. **ECR, purifier room, workshop, steering, shaft tunnel, escape trunk** keep GA positions; their kits from §3.2.
6. **Holds/tanks/pump rooms** (views): §3.2 kits; hold walk stays the v1 ladder link; tanks are peek dioramas.

### 4.7 Model parameters (`ModelParams`, Lane A `gaparams.js`; derived, then per-model overrides)

```js
ModelParams = { id, gen, seed,
  style: 'merchant'|'offshore'|'fishing'|'pax'|'yacht'|'small',
  era: 'classic'|'eco', comfort: number /* model.stats.comfort */, premium: bool /* 'prem' option */,
  palette: 'classic_beige'|'classic_green'|'eco_grey'|'eco_blue'|'yacht_oak'|'yacht_walnut'|'pax_warm'|'pax_cool',
  crew: { officers, ratings, seniors: [...], messes: 1|2, washrooms: 'ensuite'|'shared' },
  cabin: { rating: m², officer: m², moduleW: m },     // from GT (MLC), comfort, era, house width
  topology: 'auto'|'ring'|'double'|'spine',
  lift: bool, gym: bool, hospital: bool, pool: bool,   // crew opt, GT, pax
  me: meDetail(ga), fuel: 'hfo'|'mgo'|'lng'|'meoh', scrubber: bool, ice: bool /* heated wing doors, enclosed wings */,
  venues: [...], seatsPerCover, berthsPerCrewCabin: 1|2|4,
  fillers: [...] /* per tier, priority */ }
```

Derivation (Game rule): `era classic` → shared washrooms for ratings when crew ≥ 12 (one per tier: 2 WC + 2 showers),
green or beige lino, wood-grain laminate; `eco` → all en-suite, grey vinyl, white laminate, LED panels; `premium` →
carpet for officers, veneer in suites, +10 % cabin area (≤ max); `comfort` > 1 → +1 lounge filler. Overrides in
`IV2_OVERRIDES[modelId]` (data lane may edit): e.g. `giga100` cinema + spa, `research75` lab list, `icebreaker120` aft
bridge + hangar, `ferry50` double-ended, `factory80` factory line length.

---

## 5. Lighting, materials, sound

### 5.1 Lighting

- **Fixtures** are plan data (`plan.lights`, §9.4) placed by kits: accommodation ceiling panels (cabins 1 + bed light +
  desk lamp; corridors 1 per 2.4 m; messes 1 per 6 m²), galley/stores sealed fittings, ER IP-rated linear fittings 1 per
  3 m of walkway + floodlights over the ME top, bridge dimmable white + red night lights + chart lamp, deck floodlights,
  stair lights per landing. **Emergency** (`em: true`): ≥ 1 per 10 m of corridor/walkway, every stair landing, ECR,
  bridge, steering gear; **exit signs** at every stair door and escape route turn; **LLL** strips along pax corridors
  and stairs (S19 II-2/13.3.2.5.1). Target illuminance *≈* cabins 150 lx, corridors 100, galley 300, ER 200, ECR 300,
  bridge day 300 / night red ≤ 10 (Game rule mapped to bake strength).
- **Bake (pure, `iv2light.js`):** per vertex, three channels: practical `P`, daylight `D`, emergency `E`, from the
  fixtures of the vertex's own room plus 25 % bleed through open doors; daylight from window area ÷ floor area with
  distance falloff from each window. No dynamic shadows.
- **Modes** (uniforms on the opaque materials): `col × (ambient + uLights·P + uDay·D + uEmerg·E)`.
  `uDay` = `app.dayK × (1 − 0.6·app.gloomK)` (HV8); **night**: corridors at 50 %, cabins on, bridge practicals 0 and red
  night lights on, screens to the night palette (ECDIS/radar dark), ER unchanged; **emergency** (blackout: `you.cond < 10`
  or `you.fuelEmpty` underway, sinking, abandon) → `uLights 0`, `uEmerg 1`, LLL emissive, exit signs bright, screens
  off except UPS (GMDSS, ECDIS 1). The v1 walker point light stays at 35 % (HV5) to model the torch/eye adaptation.

### 5.2 Materials and textures

- **One atlas** (`iv2atlas.js`): canvas 1024² desktop / 512² phone, 64 tiles of 128² / 64² with 4 px gutters, built
  once per session (≤ 40 ms desktop, ≤ 25 ms phone, time-sliced), mipmapped. Tiles (≥ 40): lino ×4 palettes, vinyl
  plank, carpet ×4 (cruise corridor pattern, cabin, officer, theatre), quarry tile, wet tile, stone, teak deck, chequer
  plate, grating, epoxy, rubber, laminate ×3 (joints every 0.6 m), veneer ×3, stainless, insulated panel, painted steel
  ×4 (ER green, grey, white, red/yellow safety), ceiling panel (diffuser), console face, screen-off, signage
  (exit/deck/fire plan/muster/frame numbers/pipe arrows), hazard stripes, fabric ×3, leather.
- **Five materials** shared by every zone: `opaque` (MeshStandard, rough 0.8, atlas + vertex colour + light uniforms),
  `metal` (rough 0.45, metalness 0.4, same atlas), `emissive` (screens, light diffusers, exit signs; MeshBasic with
  atlas), `glass` (v1 glass), `cutout` (alphaTest: railings infill, grating see-through on catwalks over voids, cable
  tray ladders).
- **UVs:** world-scaled (`uv` in tile-world units) + per-vertex `aTile` (tile rect) wrapped in the shader
  (`onBeforeCompile`, three 0.160), so floors/walls of any size repeat inside their tile.

### 5.3 Sound zones

- Each room carries `acoustic` ∈ {`bridge`, `engine`, `ecr`, `cabin`, `mess`, `galley`, `passage`, `stair`, `public`,
  `cardeck`, `hold`, `steering`, `workshop`, `wet`, `deck`}. HV6 maps it into `soundState.room`; HV7 adds the missing
  `ENV` presets in `sound.js` (ECR: aircon + alarm beeps, galley: extractor + clatter, public: murmur/music bed,
  cardeck/hold: long reverb + lashing creak, steering: hydraulic whine, workshop: ER muffled, wet: small reverb) and
  `SURF` `carpet`, `vinyl`, `chequer` for footsteps by `room.floor`.
- **Emitters** (`plan.emitters`: ME, gensets, purifiers, fans, steering HPU, galley hood, bridge equipment) give
  `soundState.engNear` (0–1 from distance to the nearest ME/genset emitter, 12 m falloff) and a per-room hum level.
- Levels follow the IMO noise code bands *≈* (S37): ER manned ≤ 90 dB(A) (mapped to full engine bed), ECR 75,
  workshops 85, galley 75, bridge 65, mess 60, cabins 55 — as relative gains, not absolute output.

---

## 6. Performance

### 6.1 Budgets (§6.6 unchanged; v2 targets inside them)

| Item | §6.6 limit (unchanged) | v2 target | How |
|---|---|---|---|
| Interior visible set, desktop | ≤ 200k tris, ≤ 200 draw calls | ≤ 160k, ≤ 90 | 5 materials per zone shell; detail chunks |
| Interior visible set, phone | ≤ 60k tris, ≤ 80 draw calls | ≤ 55k, ≤ 40 | shells of current + neighbour zones, ≤ 4 detail chunks |
| `planFromGA` per model | ≤ 30 ms (test slack 4×) and ≤ 400 rooms | median ≤ 30 ms; worst (ulcv24k, vloc400, cruise public deck) ≤ 90 ms on the reference box; ≤ 400 rooms | template cache §3.3; pure data only |
| Geometry build | — (new) | shell ≤ 25 ms per zone; detail chunk ≤ 4 ms per frame slice desktop, 3 ms phone (idle-sliced) | lazy per chunk |
| Texture memory | — (new) | atlas ≤ 5.6 MB desktop (1024² + mips), ≤ 1.4 MB phone | one atlas |
| Light bake | — (new) | ≤ 2 ms per chunk | pure, per-vertex, ≤ 8 fixtures per room |

### 6.2 Streaming and LOD

- **Zones** stay v1's (`house`, `house:k`, `er`, `deck`, `fwd`, `deck:<id>.s<k>`) with `visibleZones()` unchanged.
- **Shell** per zone (always when the zone is visible): floors, walls, ceilings, door frames, windows, stairs, LOD1 of
  items with `h ≥ 1.2` (boxes ≤ 12 tris), big machinery at LOD1, runs over walkways at LOD1 (single box per rack).
- **Chunks** (≤ 12 rooms or ≤ 150 m² of floor, or one ER bay per level): LOD0 detail. Active chunks = the walker's
  chunk + chunks sharing an open door with it + (desktop) chunks within 15 m in the same zone. Phone ≤ 4, desktop ≤ 10.
- **Window views**: zones listed in the walker room's `views` render their shell (LOD1) even if not in
  `visibleZones()` (the bridge sees `deck` and `fwd`), capped at 15k tris phone.
- **Instancing:** an item kind repeated ≥ 16 times in one zone LOD0 set (cruise cabins, theatre seats, frames, bitts,
  lockers) is one `InstancedMesh` on the shared material; ≤ 8 instanced kinds per zone on phones.
- **Distance LOD inside big spaces** (car decks, ER, holds): chunks farther than 25 m (phone 15 m) from the camera use
  their LOD1 representation even when active.

### 6.3 Per-kit triangle budgets (renderer must meet; node test sums them)

Cabin ≤ 1.6k tris LOD0, mess ≤ 3k, galley ≤ 4k, bridge (whole) ≤ 14k, ECR ≤ 5k, ER bay ≤ 9k (ME section counted per
cylinder ≤ 900), steering ≤ 3k, mooring deck ≤ 6k per end, public venue ≤ 8k per 100 m², cabin corridor ≤ 0.3k per
10 m, unlined deckhead runs ≤ 1.5k per 100 m².

---

## 7. Interactions

| Hotspot kind (legacy kept) | v2 behaviour (Lane I, `iv2interact.js`, called before `gaInteract` by HV4) |
|---|---|
| `helm` | unchanged (helm mode) |
| `telegraph` | takes the helm mode at the telegraph pose (W/S give telegraph orders through `app.telegraph`, the bridge dial is focused); E/Esc leaves |
| `radio` (VHF handset) | `app.vhf.open(true)` and unlocks the pointer; fallback: today's chat focus |
| `gmdss` | `app.vhf.setChannel(16)`, open; the DSC distress button stays the VHF panel's guarded control (no automatic distress) |
| `ecr`, `engine` | opens the **engine panel** (`iv2panel.js`): rpm, load, fuel tank, consumption, cooling/LO temps (derived), generators online, bilge level, alarms list; read-only until wave-2 engine controls exist (then the same panel hosts them) |
| `thrusters` (wings, aft station) | **station mode** `wing`/`aft`: helm controls with the camera at the console looking along the ship's side (port/stbd) or aft; joystick hint text |
| `whistle` | unchanged |
| `ladder` | animated climb (1.5 s ease along the ladder axis, hands-on-rungs bob, footsteps on steel), cancel with movement keys before half-way |
| `goto` | unchanged menu + 0.3 s fade |
| `peek` (new) | look-only camera at a hatch/manhole/crane cab looking into a tank, hold or pump room diorama; E/Esc back |
| `bunk`, `chart`, `galley`, `hospital`, `muster`, `lab`, `steering`, `ccr`, `winch`, `crane`, `info` | unchanged texts (§6.5) |
| doors (no hotspot) | leaves swing/slide open when the walker is within 1.2 m and close 2 s after; watertight sliders show an amber light + beep; walking never blocked |

Station/peek modes reuse the `atHelm` pattern: `I.station = { kind, pose }`, movement keys go to `main.js` drive
controls only for `helm`/`telegraph`/`wing`/`aft`.

---

## 8. Acceptance

### 8.1 Metrics (Lane T `test/iv2-acceptance.test.mjs`, every model of every flipped gen; cruise/ro-pax every deck plan)

Measured on the furnished plan with a 0.25 m grid over each room's free floor (floor minus solids footprints, minus
`cuts`). "Measured spaces" = enclosed, walkable, not `open`, not in {`corridor*`, `stair`, `lobby_pax` < 20 m², cargo
and weather spaces}.

| # | Metric | Pass |
|---|---|---|
| A1 | Scale: area within §2.1 `[min, max]`, clear height within band, corridor widths, door widths ≥ 0.72, MLC minima | 100 % of rooms (MLC hard) |
| A2 | **No big empty space:** share of free floor within 2.0 m of a furniture/equipment solid (walls do not count; wall-mounted items count) | every measured room ≥ 80 %; area-weighted per ship ≥ 90 % (public venues ≥ 85 %, ER levels ≥ 90 %) |
| A3 | Largest empty disc radius (to solids or walls) | ≤ §2.1 `emptyR` per room; exemptions only `atrium`, `dance_floor`, `overhaul`, gym mat (each listed in `room.exempt` with its own cap) |
| A4 | Fill ratio (footprint ÷ floor) | inside the §2.1 band per kit |
| A5 | Waste: unassigned + unjustified void area per accommodation level | ≤ 8 %; zero rooms named "Spare cabin"/"Store room" without a kit |
| A6 | Detail density: items per room and runs in unlined spaces | cabins ≥ 7 items; messes ≥ seats + 4; ER ≥ 1.5 items per 10 m² of bay; every unlined room has frames + ≥ 1 run; open decks ≥ 1 item per 12 m of side |
| A7 | Lighting: ≥ 1 practical per room; emergency per §5.1; exit sign at every stair door | 100 % |
| A8 | Circulation: dead ends ≤ 7 m, two escapes per accommodation tier, ER two escapes | 100 % |
| A9 | Budgets §6 | per §6.1 |
| A10 | Existing suites (§0.3) unmodified and green with `IV2_READY` = all gens | green |

### 8.2 Baseline method (reproducible, Lane T `scripts/interiors/metrics.mjs`)

The numbers in §0.2 come from `planFromGA(id)` on the live tree: per room, free-floor cells (0.25–0.5 m) excluding
solids whose span overlaps `[y + 0.05, y + 1.7]`; distance to the nearest solid footprint (A2) and min(distance to
solid, distance to wall) (A3); fill = Σ solid footprint ∩ room ÷ room area. The script prints today/v2 side by side
per model and writes `docs/interiors-v2/metrics.md` (generated, not hand-edited).

### 8.3 Screenshots per type

Lane T builds `public/iv2view.html` + `public/js/iv2view.js`: an offline viewer (no server; a stub app with scene,
camera, a flat ocean, sun from a `?t=` hour) that builds `Interior` for `?model=<id>` and places the camera at a named
shot. Shot list per generator (13) and per sail class (4), day and night (`&light=night`), phone aspect where marked:

`bridge` (from behind the chairs), `bridge_night`, `wing`, `corridor`, `cabin_rating`, `suite_day`, `mess`, `galley`,
`ecr`, `er_floor_me` (crankcase doors and pumps), `er_top` (cylinder covers, turbochargers), `purifiers`,
`steering`, `fcsle_mooring`, `poop_mooring`, plus per type: `ccr`, `manifold`, `tank_peek` (tankers/LNG),
`compressor` (LNG), `lashing_bridge`, `hold` (container/bulk), `cardeck` (ro-ro/ferry), `atrium`, `restaurant`,
`theatre`, `cabin_corridor`, `balcony_cabin`, `crew_alley` (cruise), `cafeteria`, `seats` (ferry/HSC), `winch_room`,
`dp_console` (offshore), `wheelhouse_360` (tug), `factory` (factory80), `wheelhouse_seats` (pilot/CTV), `saloon`,
`owner_suite`, `beach_club` (yachts), `lab`, `aft_bridge` (special), `vberth`, `saloon_sail`, `nav_station` (sail).
Captures go to `docs/interiors-v2/shots/<gen>/<shot>.png` (reviewer, manual browser capture — no headless browser in the
tree, Q7); `scripts/interiors/plansvg.mjs` writes top-down SVG plans per model/level with an A2/A3 heat overlay to
`docs/interiors-v2/plans/` for CI review without a browser. Review checklist per shot: no room reads as empty from the
door, ceiling and deckhead detail visible, materials per §2.4, lights on/off per mode, window view present.

### 8.4 Walking tests unchanged

The existing walk/budget/GA suites run unmodified with `IV2_READY` complete. `interior.test.mjs` iterates the legacy
ids through `buildPlan` → v2 plans for GA-ready gens: room kinds `bridge/passage/mess/engine/deck` remain present (legacy
`kind` kept; fine kind in `space`), the ER first `kind: 'engine'` room stays `dark` and holds a legacy `console` prop,
doorways stay ≥ 0.72 with level floors, the third-person camera rule holds with the denser furniture (kits keep their
circulation skeleton).

---

## 9. Lanes, files and frozen interfaces

### 9.1 Lanes (disjoint files; hooks land in phase 2 of each lane, after the lane's own tests are green)

| Lane | Owns (create) | Hooks (edit, §9.5) | Must not edit |
|---|---|---|---|
| **A — space planner** | `shared/ships/gaspace.js` (planner, `SCALE`, `IV2_READY`), `shared/ships/gagrammar.js` (§4.2–4.5 data), `shared/ships/gaparams.js` (§4.7 + `IV2_OVERRIDES`); tests `test/iv2-space.test.mjs`, `test/iv2-params.test.mjs` | — | `ga.js`, `public/**` |
| **M — machinery & deck** | `shared/ships/gamach.js` (meDetail, erEquipment, packer, deck gear placement, holds/tanks views, frame spacing); test `test/iv2-mach.test.mjs` | — | `ga.js`, `public/**` |
| **K — kits & plan assembly** | `public/js/gaplan2.js` (SpacePlan + MachPlan → Plan v2 using `gaplan.js _internals`), `public/js/iv2kits.js` (kits, runs, lights, emitters placement), `public/js/iv2items.js` (§3.1 data); tests `test/iv2-kits.test.mjs`, `test/iv2-plan.test.mjs` | HV1 (`gaplan.js planFromGA`) | `walker.js`, `ga.js`, renderer files |
| **R — renderer** | `public/js/iv2draw.js` (item geometry factories LOD0/LOD1, shells, chunks, instancing, window views), `public/js/iv2atlas.js`, `public/js/iv2light.js` (pure bake); tests `test/iv2-render-budget.test.mjs`, `test/iv2-light.test.mjs` | HV2, HV3a, HV5 (`interior.js`), HV8, HV9 (`main.js`) | planners |
| **I — interactions & sound** | `public/js/iv2interact.js` (stations, peek, ladder climb, door animator, sill bump), `public/js/iv2panel.js` (+ `public/css/iv2.css`); test `test/iv2-interact.test.mjs` | HV3b, HV4 (`interior.js`), HV6 (`main.js`), HV7 (`sound.js`) | planners, renderer |
| **S — sail detail (SAILING approves)** | `public/js/iv2sail.js` (detail kits for sloop/ketch/catamaran/schooner inside SAILING's rooms; heads/nav stations as blocks); test `test/iv2-sail.test.mjs` | HV10 (`shipplan.js buildPlan`, sail branch) | `yachtlooks.js`, `rigmesh.js`, room geometry of `planSail`/`planCat` |
| **T — acceptance & tools** | `test/iv2-acceptance.test.mjs`, `scripts/interiors/metrics.mjs`, `scripts/interiors/plansvg.mjs`, `public/iv2view.html`, `public/js/iv2view.js` | — | product code |
| **Reviewer** | this document; changes frozen shapes; flips `IV2_READY` entries; runs all suites at each merge | — | — |

Hour 0: Lane A ships `spacePlan()` returning the v1 rooms of `ga.house`/`ga.pax`/`ga.small` re-typed as Spaces (no
subdivision), Lane M ships `machineryPlan()` returning v1's ER description, Lane K ships `planV2()` producing a Plan
equal to v1 plus `v: 2` and empty `lights/emitters`, Lane R ships the atlas materials drawing legacy prop kinds, so every
lane can work against real data from the first day.

### 9.2 Frozen interfaces — pure modules

```js
// shared/ships/gaspace.js (A)
export const IV2_VERSION = 1;
export const IV2_GENS;                       // the 13 GA gens
export const IV2_READY;                      // Set<gen>; reviewer flips per gen (§12)
export const SCALE, SPACE_KINDS;             // §2.1
export function spacePlan(variantId, opts = {}) /* SpacePlan, frozen, cached by `${variantId}|${opts.deck ?? ''}` */;
export function scoreSpace(sp)               /* { score, waste, voidUnjustified, deadEnds, unreachable, overCap, missingMust } */;
// shared/ships/gaparams.js (A)
export function modelParams(variantId)       /* ModelParams §4.7, frozen, cached */;
export const IV2_OVERRIDES;
// shared/ships/gamach.js (M)
export function frameSpacing(L)              /* m, §2.3 */;
export function meDetail(ga)                 /* { kind, n, cyl, tc, layout: 'inline'|'V', parts } */;
export function erEquipment(ga, params)      /* [{ item, n, sys, level?, near? }] before placement */;
export function machineryPlan(variantId, opts = {}) /* MachPlan, frozen, cached */;
// public/js/iv2kits.js (K)
export const KITS;                           // { [kitId]: { space: [...], must, fill, band, emptyR, place(K, room, ctx) } }
export function furnishV2(P, room, ctx)      /* writes props/solids/hotspots/lights/emitters into P; returns { fill, emptyR } */;
export function overheadRuns(P, room, ctx)   /* frames, stiffeners, pipes, trays, ducts */;
// public/js/iv2items.js (K)
export const ITEMS;                          // §3.1
// public/js/gaplan2.js (K)
export function planV2(ga, opts = {})        /* Plan v2 (§9.4) */;
// public/js/iv2light.js (R, pure)
export function bakeLight(pos, nrm, roomIdx, rooms, lights, windows) /* Float32Array(3 × n): P, D, E */;
```

### 9.3 Frozen record shapes

```js
SpacePlan = { v: 1, id, gen, params /* ModelParams */,
  levels: [{ id, y, deckH, name, use }],
  rooms:  [Space], doors: [Door], stairs: [/* v1 stair shape */], links: [/* v1 ladder links */],
  voids:  [{ id, level, x0, x1, z0, z1, why: 'casing'|'uptake'|'trunk'|'lift'|'duct'|'tank'|'hull'|'atrium' }],
  graph:  { nodes: [roomId], edges: [[a, b, doorIdx]] }, goto: [/* GA seeds re-targeted to v2 rooms */] }
Space = { id, level, kind /* legacy enum */, space /* SPACE_KINDS */, name, x0, x1, z0, z1, y, h, deckH,
  lined, floor, wall, ceil: 'panel'|'coffered'|'open'|'grating'|'feature', acoustic, zone,
  win: [{ side, kind: 'window'|'porthole'|'bridge'|'door_glass', from, to, bottom, top }],
  kit, kitOpts, role?, berth, officer, exempt?: [{ kind, cap }], tags: [] }
Door = { a, b, side, at, w, h, kind /* v1: door|open|ext|watertight */, leaf: 'swing'|'slide'|'double'|'glass'|'none',
  sill, fire: null|'A60'|'A0'|'B15', auto: true }
MachPlan = { er: { bays: [{ level, z0, z1, walk: [rect], voids: [rect] }], equip: [Equip], runs: [Run], overhaul },
  deck: { gear: [Equip] }, views: { holds: [...], tanks: [{ peek: { x, y, z, yaw, pitch }, box }] } }
Equip = { id, item, x, y, z, rotY, w, d, h, sys: [], level, hot?: { kind, label } }
Run   = { kind: 'pipe'|'tray'|'duct'|'frame'|'stiff'|'rail', sys?, pts: [[x, y, z]], r?, w?, h?, room }
```

### 9.4 Plan v2 additive keys (consumers that do not know them ignore them)

`plan.v = 2`; rooms gain `space, deckH, lined, ceil, acoustic, chunk, exempt, mat: { floor, wall, ceil }` (atlas tile
ids) — `h` becomes the clear height; doors gain `leaf, sill, fire, auto`; props gain kinds `{ t: 'k2', item, x, y, z,
rotY, w?, d?, h?, var, room, chunk }` and `{ t: 'run', … Run }` (legacy prop kinds `helm, bconsole, console, bunk, chart,
radio, gmdss, …` are still emitted where tests or v1 code look for them); `plan.lights = [{ id, room, kind:
'panel'|'strip'|'spot'|'flood'|'bulkhead'|'red'|'exit'|'lll', x, y, z, len?, axis?, lm, em, night:
'on'|'dim'|'off'|'red' }]`; `plan.emitters = [{ room, kind, x, y, z, level }]`; `plan.views = [{ room, zones: [] }]`;
`plan.chunks = [{ id, zone, rooms: [], area }]`; hotspot kind `peek` with `pose`.

### 9.5 Hooks (exact places; each a few lines)

| # | File · function | Change | Lane |
|---|---|---|---|
| HV1 | `public/js/gaplan.js` `planFromGA`, right after the GA is resolved | `if (ga.gen !== 'sail' && IV2_READY.has(ga.gen) && opts.v !== 1 && globalThis.__iv2 !== false) return planV2(ga, opts);` | K |
| HV2 | `public/js/interior.js` `build()`, where `buildZoned` is called | `plan.v === 2 ? buildInteriorV2(this, plan, g, { phone }) : buildZoned(this, plan, g)` | R |
| HV3a | `interior.js` `update()`, after `gaZoneUpdate` | `this.v2?.frame(this, dt)` (chunks, light mode, wipers) | R |
| HV3b | `interior.js` `update()`, after the avatar is placed | `iv2Frame(this, dt)` (door animator, ladder climb, sill bump) | I |
| HV4 | `interior.js` `interact()`, before `gaInteract` | `if (this.plan?.v === 2 && iv2Interact(this, h)) return;` | I |
| HV5 | `interior.js` `update()`, lamp block | `* (this.plan?.v === 2 ? 0.35 : 1)` on `this.light.intensity` | R |
| HV6 | `public/js/main.js` `updateSound`, room mapping | `if (r?.acoustic) room = r.acoustic; st.engNear = I.v2?.engNear ?? null;` footstep surface from `r.floor` | I |
| HV7 | `public/js/sound.js` `ENV`, `SURF`, `envKey` | additive presets/surfaces (§5.3); `engNear` scales the engine bed | I |
| HV8 | `main.js` sun block | `this.dayK = day; this.gloomK = gloom;` | R |
| HV9 | `main.js` constructor (URL params) | `?iv2=0` → `globalThis.__iv2 = false; this.iv2 = false` | R |
| HV10 | `public/js/shipplan.js` `buildPlan`, sail/cat branch before `P.finish()` | `if (IV2_SAIL.has(cls)) furnishSailV2(P, cls);` — **SAILING approval required** | S |

---

## 10. Tests with expected numbers

| Suite | Checks (expected values) |
|---|---|
| `iv2-space` (A) | every non-sail model: `scoreSpace().unreachable === 0`, `missingMust === 0`, dead ends ≤ 7 m, 2 escapes per tier; cabin areas: ultramax64 (36,000 GT) ratings ∈ [7.0, 10.5] (MLC 7.0), officers ∈ [10.0, 13] (MLC 10.0); coaster (2,500 GT) ratings ∈ [6.5, 10.5] (MLC 4.5); clear heights 2.15–2.30 in lined spaces; no room above its §2.1 max; waste ≤ 8 %; determinism (same frozen object; same JSON for two calls) and variant (`ultramax64~lng.i1c.esd`) resolves; cruise/ro-pax every deck plan ≤ 400 rooms |
| `iv2-params` (A) | `era` classic + crew ≥ 12 → `washrooms: 'shared'`; eco → `'ensuite'`; `prem` → carpet officers, +10 % area; overrides applied (giga100 cinema) |
| `iv2-mach` (M) | `frameSpacing(90) = 0.66`, `(199.9) = 0.85`, `(32) = 0.544`; `meDetail`: ultramax64 6 cyl / 1 TC, vlcc300 7 / 2, ulcv24k 11 / 3, capesize180 6 / 1, coaster L6, tug 2 × L8, ferry 2 × V12, ropax200 4 × V12; every ER: no bare floor disc > 1.6 m except `overhaul` ≤ 2.5; every item's `clear.front` reachable; runs ≥ y + 2.0 over walkways; equipment counts per §4.6 |
| `iv2-kits` (K) | each kit over a grid of room sizes (min…max of §2.1, 0.2 m steps, all door sides): fill within band, `emptyR` holds, door approaches and window rules respected, hotspot standing points standable (`WalkMap`), circulation lane exists; template cache equals fresh placement; tri budget sum per kit ≤ §6.3 |
| `iv2-plan` (K) | Plan v2 shape (§9.4) for every model; legacy kinds present; `lights` ≥ 1 per room; emergency rules (§5.1); `planFromGA` median ≤ 30 ms, worst ≤ 90 ms (same 4× slack as the YARD suite) |
| `iv2-render-budget` (R) | three.js in node with the game's `Interior` (pattern of `interiors2-budget`): every standable zone, desktop ≤ 160k/90 and phone ≤ 55k/40 with chunks + window views; atlas tile count ≥ 40; ≤ 5 materials; geometry shell ≤ 25 ms |
| `iv2-light` (R) | bake: a lit cabin vertex P > 0, a windowless store D = 0, emergency-only corridor E > 0 and P(night) per mode table; deterministic |
| `iv2-interact` (I) | fake app: telegraph → helm mode, radio → `vhf.open(true)`, gmdss → channel 16, ecr → panel shown, ladder climb ends at `to` in 1.5 ± 0.1 s, door animator state machine, peek enter/exit restores the walker |
| `iv2-sail` (S) | sloop/ketch/catamaran/schooner: kits inside SAILING rooms, no new walls; `interior.test.mjs` green |
| `iv2-acceptance` (T) | §8.1 A1–A9 for every model of every gen in `IV2_READY` (all four sail classes when Lane S is merged) and prints the §0.2 table |
| existing | `interior`, `interior-review`, `interiors2-walk`, `interiors2-budget`, `interiors2-ga` — **unmodified, green** |

---

## 11. Open questions (built with the default unless the product owner changes it)

| # | Question | Default |
|---|---|---|
| Q1 | Change the GA house/room geometry in `ga.js` instead of subdividing inside it? | No — GA frozen; `interiors2-ga` and the exterior stay untouched |
| Q2 | Closable doors that block walking? | No — auto-opening visual leaves |
| Q3 | Real sill steps in the walker? | No — visual sill + avatar foot lift; walker unchanged |
| Q4 | Lifts on cargo ships? | Yes from 6 house tiers: a lift void + Go-to entries per tier |
| Q5 | Shared washrooms on classic-era ships? | Yes for ratings when crew ≥ 12 (era realism) |
| Q6 | Draw the external escape stairs on the exterior too? | Not in IV2; offered to YARD Lane B as a later request |
| Q7 | Automated screenshots? | No headless browser in the tree: manual capture via `iv2view.html`; SVG plans in CI |
| Q8 | Sail classes' layout (rooms) changes? | Detail kits only; heads/nav stations as blocks; room changes only if SAILING asks |
| Q9 | Image textures? | No — procedural atlas only |
| Q10 | Dynamic shadows? | No — baked vertex light |
| Q11 | Cargo visible in holds? | Yes: `cargo_heap` from `you.cargo` kind and fill level (grain/coal/ore/fertiliser colours), empty otherwise |
| Q12 | Crew NPCs? | Out of scope; seats and bunks leave room for them later |
| Q13 | Rain on windows? | Bridge wipers + clear-views animate; no droplet shader |
| Q14 | Emergency lighting trigger? | Blackout states of §5.1; a manual "drill" toggle in the engine panel |
| Q15 | Raise the 400-rooms cap? | No — wet units/heads < 2.0 m² are blocks, balconies not rooms, ER bays are rooms only when walkable |
| Q16 | Phone atlas size? | 512² (64 px tiles) |
| Q17 | Who edits `IV2_OVERRIDES`? | Data lane, through review |
| Q18 | Per-model random variation? | Seeded by variant id (palette shade, item variants, poster/signage text); same ship looks the same for everyone |
| Q19 | Walkable cruise balconies? | No (room cap); visible through the glass door |
| Q20 | Engine panel controls before wave-2 engine systems? | Read-only gauges; drill toggle only |

---

## 12. Phased order (what ships first)

1. **P0 (hour 0):** stubs of §9.1, frozen shapes, `iv2view.html` skeleton, metrics script on v1 (prints §0.2).
2. **P1:** `aft_house_dry`, `aft_house_tanker`, `container`, `lng` — house grammar, bridge kit, ER packer, ECR,
   steering, mooring decks, hold/tank views, atlas + lighting + chunks. Flip these four gens.
3. **P2:** `offshore`, `special`, `roro_pctc`, `tug`, `fishing`, `small_fast` — offshore/workboat grammars, winch
   rooms, wheelhouses, factory deck. Flip.
4. **P3:** `ferry`, `cruise`, `motor_yacht` — street grammar, venues, cabin decks, crew alleys, yacht grammar. Flip.
5. **P4:** interactions polish (stations, panel, peek), sound zones, Lane S sail detail (with SAILING), screenshots
   reviewed, v1 interior planners marked deprecated (removal next release).

Each flip requires: the gen's models pass `iv2-*` and the existing suites; reviewer has the gen's screenshots.

---

## 13. Sources (real-world claims; the data lane fills URLs and access dates)

| Ref | Source | Used for |
|---|---|---|
| S19 | SOLAS 1974 as amended: II-1/3-4 (emergency towing, tankers ≥ 20,000 dwt), II-1/9 (double bottom), II-1/13 (watertight doors), II-2/9 (main vertical zones), II-2/13 (means of escape, dead ends, low-location lighting), III (lifebuoys, lifesaving), V/19, V/22 | §2.2, §3.2, §5.1 |
| S20 | Maritime Labour Convention 2006, Standard A3.1 (cabin floor areas by GT, headroom ≥ 203 cm, hospital ≥ 15 crew, recreational facilities), A4.1 (medical care) | §2.1, §3.2 |
| S30 | Cruise line deck plans / stateroom areas of mainstream ships (inside ~14–15 m², balcony ~16–20 m²) *≈* | §2.1 cruise cabins |
| S31 | IMO MSC/Circ.982 (bridge design, equipment and arrangement); ISO 8468 (ship's bridge layout) | bridge kit, walkway behind consoles |
| S32 | IMO FSS Code ch. 13 (means of escape: stair and corridor widths) *≈* | §2.2 |
| S33 | International Convention on Load Lines 1966, Reg. 12 (doors, 380 mm sills) | §2.2 sills |
| S34 | Classification society hull rules, standard frame spacing `0.002 L + 0.48 m` *≈* | §2.3 |
| S35 | ISO 14726 (identification colours for piping systems) *≈* | §2.4 |
| S36 | Low-speed two-stroke engine programmes (cylinders, power per cylinder, turbochargers) *≈* | §4.6 |
| S37 | IMO Code on Noise Levels on Board Ships, MSC.337(91) (limits by space) *≈* | §5.3 |
