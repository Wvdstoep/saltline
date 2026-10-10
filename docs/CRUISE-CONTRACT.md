# Saltline — cruise ships: sizes, prices, jobs, interiors v2, crowds (build contract CRUISE)

Branch `int-cruise`, 2026-10-10. Player report: *"cruise ships are far from realistic — make them truly huge, realistic cruise
ships with lots of entertainment on board, a complete large design, and realistic prices."* Then: *"the guests on board
enjoying the cruise are the most important part."* Tags as in the YARD contract: **Source** = real-world figure, **Game
rule** = tuned for play. Real-world figures are typical for the class, with made-up names (no brands).

## 1. Line-up (shared/ships/catalogue.js)

| id | class | LOA × B × T m | GT | guests | crew (min/opt) | kW | ref. USD m | game price |
|---|---|---|---|---|---|---|---|---|
| `rivercruise110` (new) | river / coastal | 110 × 11.4 × 1.7 | 4,200 | 150 | 40/48 | 1,800 | 38 | 5.85 M |
| `boutique125` (new) | boutique yacht cruiser | 125 × 19 × 4.8 | 11,500 | 280 | 150/200 | 9,000 | 330 | 50.8 M |
| `expedition105` | expedition (PC6) | 104.4 × 18 × 5.3 | 12,500 | 200 | 100/120 | 8,000 | 200 | 30.8 M |
| `cruise230` | mid-size | 230 × 28 × 7 | 55,000 | 1,250 | 520/600 | 25,000 | 520 | 80.0 M |
| `cruise285` (new) | premium | 285 × 36 × 8.1 | 125,000 | 2,900 | 900/1,050 | 45,000 | 800 | 123.1 M |
| `cruise330` | large (LNG) | 330 × 42 × 8.8 | 180,000 | 4,000 | 1,300/1,500 | 62,000 | 1,000 | 153.8 M |
| `cruise362` | mega | 362 × 47 × 9.3 | 236,000 | 6,700 | 2,100/2,300 | 97,000 | 1,500 | 230.8 M |
| `cruise370` (new) | world's largest (LNG) | 370 × 48.5 × 9.5 | 250,000 | 7,600 | 2,250/2,400 | 100,000 | 2,000 | 307.7 M |

Existing ids keep working (saves, ghost ships, jobs). Their game price changes (old: 3.0 / 7.8 / 22.2 / 35.4 M), so a saved
ship keeps its id and is valued at the new price (`shipValue` = f(price, condition)); nobody lost a ship, trade-in is higher.

## 2. Prices, and why

The whole game's money scale is below reality for hulls: `ulcv24k` costs 38.5 M against about 250 M in reality (1/6.5).
Cruise ships had been priced by `paxPrice` at 1/57 of reality. Rule now: **price = reference newbuild USD / 6.5**
(`DERIVE.CRUISE_DIV`, `cruisePrice(usdM)` in catalogue.js). A mega cruise ship is 6.0 × an `ulcv24k`, the 370 m ship 8.0 ×,
the 330 m ship 4.0 (the user's 5–8 × band for the mega ships), expedition and boutique ships tens of millions.
Cruise ships are therefore clearly the most expensive ships in the game (the next, `ulcv24k`, is 38.5 M).

What scales with price on its own (no code change): yard service 1 % of the price per 30 days, repair cost (6 % of the price at
0 % condition), resale/trade-in, yard instalments and finance. Port dues, berth, pilotage and tugs scale with displacement
(`FEES`), fuel with `burn`. Insurance is a flat 2,000 cr rescue replacement in this game (no per-ship premium exists), not changed.

Wages: `crewCostOf('cruise')` = `CRUISE_WAGE (3.5) × crewOpt × √(1 + GT/150,000)` cr/h under way (was `6×40×f + 1.5×(crew−40)`
and now covers the full hotel complement). Provisioning, commissions and agent costs are netted off the charter fee (§3).
Result per model: see the economy table in §3 (payback 120–330 operating days, i.e. profitable, not a money printer).

## 3. Cruise jobs and income (shared/jobs/cruises.js, server/jobsgen.js `B.cruise`, server/jobsx.js)

**Itineraries** (`ITINERARIES`, 17 real-style routes; no Russian ports, politics): Western / Eastern Mediterranean, East / West
Caribbean, Baltic capitals, Norwegian fjords, Iceland, Atlantic islands, Alaska, South America, four polar expedition routes
(Antarctic, Greenland, Svalbard, subantarctic: landings at sites, no harbour call) and three one-way world-cruise legs (21 / 18 / 21
nights, only for ships with ≥ 800 guests). `callsOf` drops a call the ship cannot use, the home port is never a call, fewer than
2 calls → the cruise is not offered.

**Job shape (JOB_GEN 8 runner, no new step kinds).** `B.cruise` builds board steps: sail to a call and dock, `work` step for the
guests ashore (8–10 h port stay), sea days between, and the way home (or not for world legs). The guest count is the ship's
(occupancy 75–100 % of the berths); the cruise is offered from a harbour only if the ship's L / draught pass the port limits
(`fits`) and, above 250 m, the harbour has a cruise terminal (`ports.js` tag `cruise`, via `portsOf`, which now counts the call
ports of sail / work steps).

**Income** (`cruiseIncome`): ticket = guests × hours × `CRUISE_FARE[class]` (cr per guest-hour net of provisioning and commissions:
river 18, boutique 40, expedition 36, mid 16, premium 12, large 10.5, mega and giga 9.4) and onboard = guests × hours ×
`onboardIndex` (0.5 × the sum of `VENUE_SPEND` of every venue the ship really has: a casino 0.9, spa 0.6, club 0.25, specialty
restaurant 0.2 … per guest-hour). A bigger, better equipped ship therefore earns more per head and far more in total; the
ticket is fixed by the class the cruise was sold for. Payback per ship 112–250 operating days (see §2).

**Penalties** (`CRUISE_RULES`, `settleAmount` case `cruise`): each call reached after its timetable −8 % (max −48 %), rough seas
(share of sailing in Hs > 1.5 m × 20 %, at most −20 %), hull condition lost −2 % per point over 1 % (max −50 %), the whole cruise
over its allowed hours −25 %; a clean cruise (no late call, hull undamaged) +6 %. The generic late penalty is off for cruises
(they have their own). Tests: `test/cruise-jobs.test.mjs` (8), `test/jobs2-*` still pass.

## 4. Interiors v2 for cruise (`cruise` in IV2_READY)

`cruise` joined `IV2_READY` once every deck of all 8 models passed the walk, acceptance and budget tests; `?iv2=0` still falls back
to the v1 plan. Layout is pure and seeded (`shared/ships/cruiselayout.js`, programme from `shared/ships/cruiseprofile.js`,
instantiated by `public/js/gacruise.js`, kits in `public/js/iv2cruisekits.js`; ~100 new items in `iv2items.js` / shapes in `iv2draw.js`).

* **Decks:** crew decks (galleys, provisions, crew mess and bar, laundry, medical, ECR, workshops, crew cabins in alleys), public
  decks (theatre one or two decks high with balcony, one to three multi-deck atria / promenades with gallery rings, restaurants
  with their galleys, specialty restaurants, buffet, food courts, bars and pubs, casino, night club, spa and gym, kids and
  teens clubs, shops, art / photo gallery, library, card room, cinema, arcade, guest services, boat / tender station with
  lifeboat muster points), cabin decks (corridors of all categories: inside, outside, balcony, suites, accessible; as many cabins
  as `ceil(guests / 2.3)`), lido and sun decks (pools, hot tubs, slides, loungers, bars, court, mini-golf, climbing wall, rope
  course, ice rink and surf simulator on the biggest ships) and the bridge deck (bridge with enclosed wings, ECR at the bottom).
* **Scaling with guests:** `cruiseProfile` grows bars / shops / specialty restaurants with the guest list (design point ± 50 %),
  so the 7,600-guest ship carries more of everything than the 1,250-guest one; a 150-guest river ship has a panoramic lounge,
  library and bike store and no casino.
* **Budgets:** the walkable plan is built lazily per deck (≤ 400 rooms per deck plan, 77 rooms on a typical public deck); the
  scenes measured in the viewer: theatre 23k tris / 40 calls, corridor 39k / 37, promenade 29k / 48-56 with the crowd (limits
  160k / 90 desktop, 55k / 40 phone). No big empty spaces (iv2 packer rules); metrics A1–A8 hold for every deck.
* **Tests:** `test/iv2-*.test.mjs`, `interiors2-*.test.mjs` all include the cruise ids; crowd tests in `test/cruise-crowd.test.mjs`.

## 5. Exterior and class variety

* **Exterior (public/js/shipgen.js `buildLido`)** the lido tier is no longer a solid box: an open teak deck with glass wind-screens,
  the pool with coaming, hot tubs, rows of loungers (≈ guests / 24, at most 300), pool bar pavilion, slide tower with three
  spiral tubes (when the class has slides), court, mini-golf, rope course, climbing wall, aqua theatre, a sun-deck lounge under
  the funnel and a crow's nest forward, all by the class's extras. Cruise lifeboats / tenders hang outboard of the boat deck (24
  on the 362 m ship) instead of inside the hull. The funnel stands on the lido slab. Cost: +10k triangles on the 362 m ship
  (36k of 120k), no new draw call (parts merge by material).
* **Variety per class** (`cruiseprofile.js` ROWS, seeds from the model id): deck stack (river 1 / 1 / 2 / 0 / 1 … giga 3 / 3 / 11 / 2 /
  1 crew / public / cabin / lido / sun decks), atria (none, 1 'salon stair', 1 atrium, 2 or 3 multi-deck voids with their own
  names: Royal Promenade, Grand Atrium, Central Park, Boardwalk), theatre decks, number of dining rooms, venue set and extras per
  class (expedition: lecture hall, mud room, Zodiac station, science lab; mega: ice rink, rope course, aqua theatre, zip line;
  giga: surf simulator, water park), decor theme (wood / yacht / expedition / classic / premium / resort).

## 6. Living guests (public/js/iv2crowd.js, iv2crowdplan.js, iv2crowd sound in sound.js)

Walk mode on a v2 cruise plan is populated; `?crowd=0` switches it off (and v1 plans / other ships never get it). Client side only,
deterministic from the ship's seed and the ship's clock (`app.shipTimeNow()` + longitude → local hour), nothing sent to the server.

* **Who is where (pure, `iv2crowdplan.js`):** each venue kind has an occupancy curve over the day (`occupancy`: restaurants peak at
  8, 12:50 and 19:15, the theatre at the 18:40 and 21:40 shows, pool and sun decks at 13:00, club and casino at night, galley
  and crew mess at their service times); `shipDensity(guests)` scales it (150 guests 0.19, 1,250 0.44, 7,000+ 1) and
  `crewDensity` the staff. Every item carries its `spots` (a theatre row seats a person every 0.55 m, dining sets 2–6, bar islands
  2 barmen and 10 stools, blackjack dealer and 3 players, loungers lie, pools swim, the dance floor dances, band stage plays …);
  a spot is taken if a hash of (ship seed, room, hour, spot) is below the occupancy: the same ship at the same hour always
  shows the same people.
* **Roles:** guests (kids in the kids' club, swimmers in swimwear, evening clothes after 18:00), uniformed crew (waiters with trays
  who walk, barmen, cooks, dealers, hosts, nurses, officers on the bridge, cleaners on the promenade, performers on stage and in
  the club), strollers on promenades and in atria and corridors, queues at buffets and guest services.
* **Behaviour:** walkers follow an A* path on the player's own WalkMap (`findPath` + `standAt`), turn and slow down for the
  player and step aside within 1.3 m; seated and standing guests turn their heads to the player within 3 m; the theatre audience
  applauds for 6 s in every 70 and during the shows; dancers alternate two poses; swimmers drift.
* **Budget (`budgetFor`):** at most 110 people within 24 m on a desktop (32 within 12 m on a phone), drawn in 11 / 6 instanced
  meshes (one per pose, ~85–110 triangles per person: ≤ 12k triangles, ≤ 11 draw calls desktop; ≤ 3.5k, ≤ 6 phone), per-instance
  colours (skin, hair, top, legs, arms) picked in one shader, so there are only the 11 meshes and one material for any number of
  looks. Rooms get their people only within 28 m of the player (≤ 14 rooms at a time), dropped when far; paths are computed two per
  0.6 s tick. The visible crowd grows with the guest count (tested: the 6,700-guest ship's promenade holds more people than the 280-guest one's).
* **Sound (`sound.js _ctlCrowd`):** `soundMix(kind, hour, nearby)` → murmur / music / splash; a single `crowd` ambience voice
  with ≤ 5 processing nodes (band-passed noise bed, two oscillators through a low-pass for the room's music: slow chords in the
  theatre and lounges, a 124 bpm pulse in the club, bright blips in the casino, and high-passed noise for pool splashing), created
  only while heard, on the ambience bus (the engine's `maxNodes` rules apply).
* **Tests:** `test/cruise-crowd.test.mjs` (21): density, occupancy curves, spots, theatre scaling with guests, looks, determinism,
  roamers, budget (110 / 32, ≤ 11 / 6 meshes, ≤ 120 tris per pose), selection, A*, behaviour, sound mix, and the renderer in
  node (theatre with the show on, phone cap, same ship same hour same people, walkers move on real routes).

## 7. Everything aboard is usable: casino, venues, guest rating

Player request: *"everything on board must be usable by the captain when walking through the ship, not just decoration."* Furniture
items carry a hotspot `v:<kind>` (`shared/ships/cruisesat.js` `ITEM_KIND`, `public/js/iv2items.js` `HOT_ITEMS`); E (or a tap on the touch
button) opens a small panel (`public/js/iv2games.js`, fetched when the first one is used, so nothing is built or kept in memory until
then). One panel at a time; the walker is frozen while it is open (`I.modal`); Esc / E / × closes it. All panels work with touch:
44 px targets, full width on a phone, no hover, no keyboard.

**Casino (server authoritative: `server/casino.js`, rules in `shared/casino.js`).** The client sends a bet or a decision; the server
checks it against the player's credits and the table limits of the ship's class (`LIMITS`: mid 5–500, premium 10–1,000, large
10–2,000, mega 25–5,000, giga 25–10,000 cr; ships without a casino refuse everything), rolls with `crypto.randomBytes`, pays and
books. The client never sends a result, a balance or a card: forged fields are ignored (tested). Credits only, no real money.

| game | rules | house edge (tested) |
|---|---|---|
| roulette | European wheel, one zero; straight 35:1, split 17, street 11, corner 8, line 5, dozen / column 2, even-money 1; bets 1–40 per spin | 2.70 % (exact, every bet type) |
| blackjack | endless shoe, dealer stands on all 17s and peeks, naturals 3:2, double on two cards, one split (split aces one card), no insurance | ≈ 5.6 % mimicking the dealer; ≈ 0.5 % with basic strategy |
| baccarat | standard tableau; player 1:1, banker 0.95:1 (5 % commission), tie 8:1 | banker 1.06 %, player 1.24 %, tie ≈ 14.4 % |
| slot machine | 5 reels × 3 rows, 10 lines, wild, 3+ scatters = 10 / 15 / 20 free spins paying ×2, bet = line bet × 10 | exact enumeration 95.8 % return (hit rate 45 %, bonus every ≈ 29 spins) |
| Texas hold'em | you and three guests, limit betting (bet u on preflop / flop, 2u on turn / river, one bet and one raise per round), ante u = table minimum, guests play by hand strength | 5 % rake (max 3u) paid to the house |

Round state of blackjack and poker lives on the server (the hole card and the guests' cards are never sent before they are
shown; an abandoned round is stood / folded after 10 minutes, so credits never hang). **Responsible play** (`PLAY_RULES`): at least
0.5 s between bets, at most 90 a minute, at most 40 roulette bets per spin, a session losing more than 6 × the table maximum within an
hour is cooled off for 10 minutes (the casino says so plainly), the balance can never go negative, whole credits only.
**Books:** the casino is the ship's, so what the captain wins or loses is the house's loss or revenue: every round's net goes to the
company's fleet ledger day book (income when the captain wins, costs when he loses; the purse is the one purse) and to
`p.stats.casino = { wagered, returned, rounds }` (the casino's own account: house = wagered − returned). The guests' play is the
casino line of the onboard spending (§3). Tests: `test/cruise-casino.test.mjs` (15: payout tables, exact edges, dealer rules, hand
ranks, pot conservation, limits, balances, rate limit, cooling-off, forged messages, books, idle rounds).

**Venues (server `server/venues.js`, menus in `shared/ships/cruisesat.js` `MENUS`).** `{ action: 'venue', kind, option }`: the server
looks the option up in the menu of what *this ship* has (`menuFor`: a river ship has no slide or rink), charges the price, marks the
captain as seen at that venue and answers with a text. Bar (coffee … champagne), main dining and specialty restaurant (48 cr), buffet,
theatre (pick a show; ice show only on ships with a rink; the audience rating is rolled on the server), cinema, loungers (relax),
hot tub, pool, water slide and zip line (a short camera ride), spa (sauna, massage, facial), gym / yoga, shops (postcards … a
watch), the art gallery (look, or bid at the auction: 55 % worth 0.4 ×, 35 % 1 ×, 10 % 3 × the bid: 87 % back), library, arcade
(reaction mini game), mini-golf, climbing wall, rope course, ice rink, sports court, surf simulator (timing mini game: the score is
shown, it pays nothing), the kids' club, the cashier. The mini games are client side by design: they never move credits.

**Guest rating (`guestScore`, shown at guest services and on the bridge line).** 1–5 stars from 45 % attractions (nine groups: dining,
bars, shows, pool and sun, wellness, family, shopping, sports, culture; each covered against what the ship's guest count asks for),
20 % crew service (the ship serviced), 15 % hull, 20 % the captain seen about the ship (distinct venues used in the last ship-day,
six for the maximum). It scales the cruise pay: `payMul` = 1 + 0.5 (score − 0.8) clamped 0.8–1.1 on the ticket and `spendMul`
0.75–1.12 on the onboard spending (`jobsx` settle, `env.guest`); a ship in good order whose captain is never seen scores ≈ 0.8 and
pays exactly as before, a captain who walks the ship earns up to +10 %, a neglected ship loses up to 20 %. The settlement note says
how the guests rated the cruise. Tests: `test/cruise-venues.test.mjs`, `test/cruise-jobs.test.mjs`.

**Open:** craps, bowling, photo studio sittings and a theatre seat view are not built; baccarat, poker and the venues are menu / panel
based (no 3D animation of the dealer), the slide is a camera glide, not a tube.
