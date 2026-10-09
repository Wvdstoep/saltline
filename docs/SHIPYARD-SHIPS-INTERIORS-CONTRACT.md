# Saltline — real ships, real shipyards, real cargo and walkable ships (build contract YARD)

Design contract, 2026-10-09. Root: `/tmp/claude-0/-home-user/0e451cf3-a540-5510-b1a6-978d07bae2ed/scratchpad/saltline`.
Functions are named by function and by the statement they sit next to, never by line number.

Read with: `docs/WORLD-POLITICS-CONTRACT.md` (§3.5 registries, §4.10 cabotage, §4.13 flags, §8.1 frozen interface,
Q3), `docs/SAILING-CONTRACT.md` (§1.3 ownership, §4.2 hull looks, §4.5 deck walker — it **owns** the four sail
classes), `docs/V5-WAVE2-DESIGN.md` (§3.6 `shared/shipstats.js`, §3.7 parts, the Vessel record, `shared/crew.js`),
`docs/V5-PLAN.md` items 5–8 and 20, `docs/V7-PLAN.md` items 1, 2, 5, 7, 9, `docs/V6-FLEET-CONTRACTS.md` (office,
storage, captains).

Every number is tagged. **Source** = a real-world figure with its reference in §13 (values marked *≈* are typical
figures for the class and must be checked by the data lane before the row's `verify` flag is cleared). **Game rule** =
a number tuned for play; it is not a real-world claim.

---

## 0. What the player gets

### 0.1 In plain words

- **About 76 real kinds of ship instead of 17.** Harbour tugs and ocean tugs, pilot boats, wind-farm crew boats,
  every kind of fishing boat (inshore crabber, beam trawler, stern trawler, longliner, purse seiner, factory
  trawler), offshore supply and anchor-handling ships, coasters and heavy-lift ships, container ships from a
  1,000-box feeder to a 24,000-box giant, bulk carriers from Handysize to the 400,000-tonne ore carriers, tankers from
  the harbour bunker tanker to the VLCC, LPG and LNG gas carriers, car carriers and ro-ro ships, island ferries,
  fast ferries and cruise ferries, expedition and big cruise ships, a research ship, a polar icebreaker, a dredger, a
  livestock carrier, and motor yachts from an 8.5 m RIB to a 100 m superyacht. Each has real measurements, real
  engine power, real fuel use, a real crew size and a realistic price. Your old ships stay exactly as they are; they
  are now listed as "classic" designs of their type.
- **Ships are built somewhere, and it matters.** Each shipyard is in a real country (South Korea, China, Japan,
  Germany, the Netherlands, Italy, Finland, Norway, France, Turkey, Vietnam, the Philippines, the USA and more). The
  country and the yard change the **price**, the **waiting time**, the **payment plan**, the **loan terms**, what the
  yard is **good at** (cruise ships in Germany, Finland, France and Italy; LNG carriers in Korea; bulk carriers in
  Japan and China; tugs in the Netherlands and Turkey; yachts in the Netherlands, Italy and Germany), the
  **resale value**, and the **politics**:
  - **US-built ships cost double** (Jones Act). Only a US-built ship, under the US flag, owned by a US company, may
    carry cargo or passengers between two US ports, dredge in US waters or fish in US waters. Such a ship keeps a
    premium value in US ports. If it is ever registered under a foreign flag, it loses that right for ever (as in
    US law).
  - Some yards are in countries under sanctions. If your company must follow those sanctions, you cannot order there,
    and the yard tells you why.
- **A real shipyard.** You pick a design, pick a yard (map and list, with price, delivery date, payment plan and
  speciality), choose options (engine and fuel: conventional, scrubber, LNG or methanol dual-fuel, battery hybrid;
  ice class; ship's cranes; energy-saving devices and rotor sails; economy/standard/premium finish), paint her (hull,
  boot-top, superstructure, funnel colours and your company mark) and name her. You pay a deposit and then
  instalments at steel cutting, keel laying, launch and delivery. You watch her being built on the world clock (with a
  live 3D preview that grows from blocks to a finished ship). At delivery she waits at the yard, or a delivery crew
  brings her to your home harbour. Ships in a yard's stock, and "resale" ships, can be bought at once for a premium.
- **A real second-hand market.** Every listing shows the year and yard she was built in, her flags over the years,
  the number of owners, the class society, the last dry-dock, port-inspection detentions, accidents, and her
  condition. You can pay for a **pre-purchase inspection** before you buy. Older ships are cheaper but wear faster.
- **Work that fits the ship.** A container ship carries containers, a tanker carries oil, a gas carrier carries gas,
  a car carrier carries cars; a bulk carrier never takes a box. The job board groups work by **what your ship can
  do**, and every other job shows a short reason ("needs a tanker with coated tanks", "draught 14.5 m, the berth at
  Hull has 12.0 m"). New kinds of work: container liner loops, bulk and tanker voyage charters, time charters,
  heavy-lift project cargo, car shipments, ferry timetables, cruises, anchor handling, standby, crew transfers to wind
  farms, harbour towage and salvage, bunker deliveries, launch services, dredging, survey lines, icebreaker escorts,
  fishing seasons with quotas, and for yachts: sailing lessons (with student levels and wind limits), day charters,
  skippered and bareboat charters, regattas, eco-tours and whale watching, and superyacht guest programmes.
- **Every ship can be walked like the real one.** Each type is generated from its real layout: a bridge with
  radars, chart screens (ECDIS), conning display, steering stand, engine telegraph, VHF and GMDSS radio and the
  bridge wings with their own controls; cabins, mess rooms, galley, day rooms, a hospital; an engine control room and
  an engine room with the main engine at its real size (a big container ship's engine is as tall as a five-storey
  house), generators, purifiers and the steering gear room; cargo holds, tank decks with the manifold, car decks,
  passenger decks; and the open decks with mooring winches, cranes, lifeboats and the funnel. Stairs, ladders and
  doors are where they would be. On the biggest ships a "Go to" list takes you to the bridge, engine room, bow or
  stern. It runs on phones.

### 0.2 What changes on screen

| Where | Today | After |
|---|---|---|
| Harbour → Shipyard tab | one list of 16 hulls, buy new / used / sell, compare 3 | **Newbuild** (designs × yards, configurator, order), **Stock & resale**, **Second-hand** (with history and inspection), **Orders** (progress, payments), **Sell / trade-in**, compare up to 4, 3D turntable, filters |
| HQ / office | fleet list | + order book (yard, hull number, progress bar, next instalment) |
| Job board | one list | grouped: *Your ship can do* · *Your fleet can do* · *Other work here* (each with "why not") and family filters |
| Walking aboard | generic house with bridge / mess / cabins / engine room | type-specific general arrangement, per-model engine room, real bridge consoles, quick "Go to" |

### 0.3 Controls added

| Action | Desktop | Phone |
|---|---|---|
| Open shipyard sections | tabs in the shipyard sheet; **N**/**U**/**O** jump to Newbuild/Used/Orders while the sheet is open | segmented control at the top |
| Rotate / zoom the 3D preview | drag / wheel; **[ ]** rotate 15° | one-finger drag / pinch |
| Compare | *Compare* on any card (max 4) | same |
| Go to (aboard) | **G** opens the Go-to list while walking (G keeps "go back aboard" meaning ashore) | *Go to* button in the walk HUD |
| Ladder | **E** at the foot or head (climb animation 1.5 s) | tap the ladder hotspot |

---

## 1. Common ground

### 1.1 Rules

- Node 20, plain ESM, no new dependencies, no build step; three.js r160 on the client. Tests: `node:test` +
  `node:assert/strict` in `test/*.test.mjs` (`npm test`). Game tests copy the `fakeSocket`/`join` helpers out of
  `test/game.test.mjs` (never import from another test).
- Everything that decides a price, a time, a value, an eligibility or a layout is **pure and deterministic** and lives
  in `shared/ships/`, `shared/cargo.js` and `shared/jobs/`, so the server, the client and the tests run the same code.
  Random draws (listings, delays) use a seeded RNG keyed by `(harbourId, slot, day)` or `(orderId)`; never
  `Math.random` in shared code.
- **Do not touch** (other agents are editing them now): `server/game.js`, `server.js`, `public/js/main.js`,
  `public/js/hud.js`, `server/harbors*.js`, the sailing client files (`rigcore.js`, `rigmesh.js`, `sailhud.js`,
  `sailfmt.js`, `yachtlooks.js`, `motion.js`, `touch.js`), the politics files (`shared/politics*`,
  `server/politics.js`, `public/js/politics.js`, `scripts/politics/*`), and anything under `data/`. Our changes to
  `game.js`, `main.js`, `hud.js`, `ship.js`, `shipplan.js`, `interior.js` are **hooks** listed in §7.4, applied only
  after the owners of those files have merged (phase 2 of each lane).
- Credits are not dollars. A ship's **game price follows what she can earn in the game** (cargo tonnes, passengers,
  bollard pull) with economies of scale; the real newbuild price is shown beside it as a reference. Formulas in §2.4.
- **Neutrality.** Yard and country attributes are factual (location, what they build, size limits, real payment
  practice and export-credit agencies) or explicit game rules about *spec tier* and *specialisation*. No yard or
  country gets a "bad quality" number. Real company names are used for yards whose operators are not on a sanctions
  list; yards in countries targeted by sanctions get a location name only (politics contract P6: no designated
  entities).

### 1.2 Who owns what (coordination with other contracts)

| Topic | Owner | This contract |
|---|---|---|
| Rigs, hull lines, deck plans, interiors of `sloop`, `ketch`, `catamaran`, `schooner` | SAILING (`yachtlooks.js`, `rigmesh.js`, `shipplan.js` SAIL part) | Lists them in the catalogue unchanged, gives them builders (§3.4) and liveries. The GA generator **delegates** `gen: 'sail'` to `yachtlooks.js`. No new sail models here (Q11). |
| `vessel.flag`, `flagWas`, `built`, `builtIn`, `psc`, `scrubber`, registries, cabotage checks, sanctions | POLITICS | Writes `built`, `builtIn`, `scrubber` at delivery / listing purchase (politics `healVesselPol` fills them only when missing). Requests three additions (§3.6 R1–R3). The US ×2.0 price lives **here** (`YARD_COUNTRIES.US.costIdx`); politics must not apply its own multiplier (its Q3 default is satisfied by this row). |
| Ship stats (air draft, thrusters, max Hs, hull strength, sfoc, reliability, comfort, eco, locker), parts, crew | WAVE 2 (`shared/shipstats.js`, `shared/parts.js`, `shared/crew.js`) | Each catalogue model carries the §3.6-wave-2 fields (`stats` block, §2.2), so `shipstats` reads `MODELS[id].stats` and keeps its own table only for the 17 legacy ids. Option deltas (§2.5) are applied by `effStats(vessel)` here, which `shipstats` calls. |
| Bank, loans | WAVE 2 (`server/bank.js`) | Asks for `bank.offerShipLoan` (§4.6); without it, orders are paid in cash. |
| Licences (V7 #1) | future | Job eligibility calls `licenceOk(vessel, need)` which returns `true` until licences exist. |

### 1.3 Glossary

LOA length over all · B beam · T design draught · DWT deadweight (t) · GT gross tonnage · TEU twenty-foot container ·
CEU car equivalent unit · lane m lane metres of vehicle deck · BP bollard pull (t) · MCR maximum continuous rating
(kW) · sfoc specific fuel oil consumption (g/kWh) · Cb block coefficient · Δ displacement (t) · DP dynamic
positioning · ECA emission control area · FSICR Finnish-Swedish ice class rules · PC IACS Polar Class ·
GA general arrangement.

---

## 2. Ship catalogue

### 2.1 Organisation

16 **types** (families), 76 **models**, each model with **options** (§2.5) that form **variants**. The full table is
Appendix A (generated by the reference script in Appendix B, so every derived column is consistent).

| Type (`type`) | Models (size order) | Market category (`cat`, unchanged meaning) |
|---|---|---|
| `workboat` | `ctv26`, `multicat27` | working |
| `tug` | `tug16`, `tug24`, `tug` ⓛ, `oceantug60` | working |
| `pilot` | `pilot14`, `pilot` ⓛ | working |
| `fishing` | `inshore15`, `beam40`, `trawler` ⓛ, `longliner50`, `seiner75`, `factory80` | working |
| `offshore` | `ahts70`, `psv` ⓛ, `psv90`, `ahts85`, `sov90` | working |
| `general` | `coaster` ⓛ, `shortsea88`, `gc120`, `mpp160`, `reefer150`, `livestock135` | cargo |
| `container` | `feeder1000`, `feeder` ⓛ, `feeder1700`, `subpmax2800`, `panamax4500`, `boxship` ⓛ, `neopmax14k`, `ulcv24k` | cargo |
| `bulk` | `bulker` ⓛ, `handy38`, `ultramax64`, `kamsarmax82`, `capesize180`, `newcastlemax208`, `vloc400` | cargo |
| `tanker` | `bunker85`, `chem13k`, `tanker` ⓛ, `mr50`, `lr1_75`, `aframax115`, `suezmax158`, `vlcc300` | cargo |
| `gas` | `lpg5k`, `lngbv7500`, `vlgc86k`, `lng174k` | cargo |
| `roro` | `roro3500`, `pctc7000` | cargo |
| `ferry` | `ferry50`, `ferry` ⓛ, `hsc112`, `ropax200` | passenger |
| `cruise` | `expedition105`, `cruise230`, `cruise330`, `cruise362` | passenger |
| `special` | `research75`, `icebreaker120`, `tshd100` | working |
| `motor_yacht` | `rib8`, `cruiser` ⓛ, `flybridge18`, `myacht` ⓛ, `explorer45`, `superyacht` ⓛ, `giga100` | motor yacht |
| `sail_yacht` | `sloop` ⓛ, `ketch` ⓛ, `catamaran` ⓛ, `schooner` ⓛ (SAILING owns) | sailing yacht |

ⓛ = one of today's 17 ids. **Save compatibility: every existing id is a model id with the same key.** Nothing is
renamed; `vessel.ship.cls` keeps working.

**Size names used in the UI** (Source: standard industry size bands, see §13 [S1], [S2]): Handysize 15–40k DWT,
Supramax/Ultramax 50–65k, Panamax/Kamsarmax 65–85k (beam ≤ 32.3 m for the old Panama locks), Capesize > 150k,
Newcastlemax ≈ 200–210k (largest for Newcastle NSW), VLOC > 250k; tankers MR 25–55k, LR1 55–80k, Aframax/LR2
80–120k, Suezmax 120–200k (largest laden through Suez), VLCC 200–320k; container Feeder < 3,000 TEU, Panamax (beam
32.3 m), Neo-Panamax (new locks: LOA ≤ 366 m, beam ≤ 51.25 m, draught ≤ 15.2 m TFW [S3]), ULCV > 14,500 TEU.

### 2.2 The `Model` record (`shared/ships/catalogue.js`, frozen shape)

```js
export const MODELS = {
  ultramax64: {
    id: 'ultramax64', type: 'bulk', cat: 'cargo', gen: 'aft_house_dry', base: 'bulker',      // base: legacy id used for any id-keyed fallback table
    name: 'Ultramax 64k, geared', short: 'Ultramax', size: 'Ultramax', era: 'eco',           // era: 'classic' (legacy ⓛ rows) | 'eco'
    // --- real-world reference (shown on the spec sheet) — Source ≈, verify ---
    length: 199.9, beam: 32.24, draft: 13.3, depth: 18.6, airDraft: 46, dwt: 64000, gt: 36000,
    units: { t: 57600, holds: 5, hatchW: 0.62 },                                             // capacity in its own units (§5.2)
    kW: 8600, engine: { kind: '2s', fuel: 'vlsfo', n: 1, label: '1x LS 2-stroke' }, sfoc: 165,
    svcKn: 13.5, maxKn: 14.5, crew: { min: 19, opt: 22 }, usdM: 36, buildMonths: 11,
    eq: ['cranes:4x36', 'grabs'], handling: ['bulk', 'breakbulk'],                           // §5.3
    // --- game row (the SHIP_CLASSES shape, so every consumer keeps working) ---
    displacement: 72439, capacity: 57600, pax: 0, fuelCap: 1165, burn: 1.419, price: 6950000,
    turnRate: 3.0, wearMul: 1.1, crewCost: 221, fishRate: 0, towPower: 0, hullColor: 0x7a2e2e,
    desc: 'The workhorse of the dry bulk trade: five holds and her own cranes, so she can work at small ports.',
    // --- wave-2 stats (V5-WAVE2 §3.6 columns) ---
    stats: { airDraft: 46, thrusters: null, maxHs: 8, hull: 0.78, ice: null, reliability: 1.0, comfort: 1, eco: 'B', locker: 12 },
    // --- shipyard ---
    options: ['scr', 'lng', 'meoh', 'i1c', 'i1b', 'i1a', 'gearless', 'esd', 'rot', 'eco', 'prem'],
    defaults: { engine: 'vlsfo', gear: 'geared' },
    builders: ['bulk'],                                                                       // yard capability tags (§3.3) that can build it
    minPort: 'regional', tags: ['geared'], hidden: false, verify: true,
  },
};
```

**Legacy rows (ⓛ) keep every game field exactly as today** (price, capacity, maxKn, burn, displacement, fuelCap,
crewCost, turnRate, wearMul, fishRate, towPower, pax, hullColor, desc, `sail`, `auxKn`) — the economy, physics, wave-2
tuning and saves depend on them. They gain only the reference fields, `era: 'classic'`, `type`, `gen`, `base`
(= own id), `stats`, `options`, `builders`. Where today's game number differs from the real class (e.g. the coaster's
1,200 t payload on a 90 m hull) the spec sheet shows "game payload" and the real DWT separately; Q4 asks whether to
rebalance later (default: no).

**New rows derive the game fields from the reference fields** with the formulas of §2.4 (Appendix B computes them;
`test/ships-catalogue.test.mjs` re-checks them).

### 2.3 Highlights of the catalogue (full table in Appendix A)

| Model | LOA × B × T (m) | Size | kW / kn | Crew | Ref. USD m (≈) | Game cr |
|---|---|---|---|---|---|---|
| `tug24` ASD harbour tug | 24.5 × 11.3 × 5.0 | BP 70 t | 4,480 / 12.5 | 3–4 | 8 | 256,000 |
| `ctv26` crew transfer catamaran | 26 × 10.4 × 1.7 | 12 technicians | 2,200 / 27 | 2–3 | 4.5 | 153,000 |
| `seiner75` pelagic purse seiner | 75 × 15.6 × 7.6 | RSW 2,500 m³ | 7,000 / 17 | 9–12 | 45 | 728,000 |
| `ahts85` anchor handler | 85 × 22 × 7.5 | BP 200 t | 17,000 / 16.5 | 18–25 | 55 | 1,450,000 |
| `mpp160` heavy-lift | 160 × 26 × 9.8 | 17,000 DWT, 2 × 350 t cranes | 9,000 / 16 | 14–18 | 40 | 3,150,000 |
| `feeder1700` | 172 × 27.2 × 9.8 | 1,700 TEU | 12,600 / 19.5 | 14–18 | 30 | 4,950,000 |
| `neopmax14k` | 366 × 51 × 15.2 | 14,000 TEU | 50,000 / 22.5 | 22–26 | 165 | 25,800,000 |
| `ulcv24k` | 399.9 × 61.5 × 16.5 | 24,000 TEU | 59,000 / 22.5 | 23–28 | 270 | 38,500,000 |
| `kamsarmax82` | 229 × 32.26 × 14.45 | 82,000 DWT | 9,800 / 14.5 | 19–22 | 37 | 8,580,000 |
| `vloc400` | 362 × 65 × 23 | 400,000 DWT | 29,000 / 15.5 | 24–28 | 130 | 33,000,000 |
| `mr50` | 183 × 32.2 × 13.3 | 50,000 DWT | 8,800 / 15 | 20–23 | 48 | 6,200,000 |
| `vlcc300` | 333 × 60 × 22.5 | 300,000 DWT | 25,000 / 15.5 | 25–28 | 128 | 28,400,000 |
| `lng174k` | 295 × 46.4 × 11.5 | 174,000 m³ | 26,000 / 19.5 | 26–30 | 255 | 22,300,000 |
| `pctc7000` | 200 × 38 × 10 | 7,000 CEU | 14,000 / 20 | 20–24 | 95 | 4,490,000 |
| `ropax200` cruise ferry | 200 × 31 × 6.8 | 1,800 pax, 2,800 lane m | 32,000 / 24 | 80–120 | 210 | 3,810,000 |
| `cruise362` mega cruise | 362 × 47 × 9.3 | 6,700 guests | 97,000 / 22 | 2,100–2,300 | 1,500 | 35,400,000 |
| `icebreaker120` | 128 × 24 × 8 | PC3, helideck | 20,000 / 16 | 35–45 | 340 | 7,490,000 |
| `giga100` | 100 × 16 × 4.6 | 36 guests | 9,000 / 20 | 35–45 | 300 | 23,300,000 |

### 2.4 Formulas for the game fields of new models (Game rule unless noted)

| Field | Formula | Notes |
|---|---|---|
| `burn` (t/h at MCR) | `kW × sfoc / 10⁶` | physical identity; e.g. `ultramax64` 8,600 × 165 / 10⁶ = **1.419** |
| `displacement` (t) | given (yachts, fast craft) or `0.97 × LOA × B × T × Cb × 1.025` | Cb by model (bulk 0.83–0.87, tanker 0.80–0.83, container 0.62–0.68, ferry 0.55–0.60, tug 0.50) |
| `capacity` (game payload t) | cargo types: `round(0.9 × DWT)`; others: the model's `cap` (hold, deck cargo) | 10 % of DWT is fuel, water, stores |
| `price` — cargo types | `130 × cap × (cap / 35,000)^−0.15 × typeMul` | typeMul: general 1.0 (mpp 1.4, reefer 1.6, livestock 1.6), container 1.8, bulk 1.0, tanker 1.1 (chemical 1.35), gas 1.8 (LNG 2.6), roro 1.9. Fitted to the legacy bulker (4.5 M) and tanker (4.2 M) |
| `price` — ferries and cruise | `1,750 × pax × (pax / 400)^−0.1 × typeMul` + for ro-pax `0.5 ×` the cargo formula on `lane m × 2.5 t` | typeMul ferry 1.0, HSC 1.6, cruise 4, expedition 8. Fitted to the legacy ferry (700k for 400 pax) |
| `price` — workboats, tugs, pilot, fishing, offshore, special | `0.157 × USD^0.9 × (fishing 0.6)` | fitted to legacy tug, psv, pilot (log-log) |
| `price` — motor yachts | `2.14 × USD^0.83` | fitted to legacy cruiser, myacht, superyacht |
| rounding | < 1 M → nearest 1,000; 1–10 M → nearest 10,000; > 10 M → nearest 100,000 | |
| `turnRate` (°/s) | `min(30, 5.5 × (90 / LOA)^0.75 × m)`, m: tug 2.0, workboat 1.6, offshore 1.3, else 1 | fits legacy feeder 3.75 vs 4, boxship 2.23 vs 2.2 |
| `crewCost` (cr/h under way) | `6 × crewOpt × (1 + GT/40,000)^0.8`; ferry/cruise: `6 × min(crewOpt, 40) × (…)^0.8 + 1.5 × max(0, crewOpt − 40)`; yachts `5 × (crewOpt − 1) × (…)^0.8` | wave 2 replaces with `crewDayCost` |
| `fuelCap` (t) | `rangeNm / svcKn × burn × 0.616` (0.56 = burn at 80 % throttle in `fuelBurnPerSimHour`, ×1.1 reserve) | range: ocean 16–22k nm, coastal 2.5–6k, harbour 0.5–2.5k |
| `wearMul` | bulk/tanker 1.1, container ≥ 10k TEU 1.2, fishing 1.2, fast craft 1.3, yachts 1.2–1.4, else 1.0 | |
| `fishRate` | inshore 1.0, beam 2.5, longliner 1.6, seiner 6.0, factory 5.0; non-fishing 0 | legacy rows keep their small values |
| `towPower` | `BP / 70` (BP in t) for tugs, AHTS, multicat, ocean tug | legacy tug = 1 (80 t BP real; kept) |

Sanity check every new merchant row (tested): the Admiralty coefficient `Δ^(2/3) × maxKn³ / kW` lies in 300–1,000
(Appendix A column `Cadm`), and the speed–length ratio is plausible (Froude number at service speed ≤ 0.30 for
displacement ships over 100 m).

### 2.5 Options and variants (`shared/ships/options.js`)

A **variant id** is `<model>` or `<model>~<token>.<token>…` with the tokens in canonical order
`engine, ice, gear, esd, rot, air, spec` (e.g. `ultramax64~lng.i1c.esd`). Only options that change play go into the
id; cosmetics (livery, name) do not. `SHIP_CLASSES[variantId]` resolves to the derived row (§7.2), so every consumer
of `SHIP_CLASSES[cls]` works for variants without change.

| Token | Option | Allowed on | Price × | Burn × (mass) | Fuel cost × per t | Effect | Basis |
|---|---|---|---|---|---|---|---|
| (none) | VLSFO/MGO conventional | all motor ships | 1 | 1 | 1 | — | — |
| `scr` | Exhaust-gas scrubber | GT ≥ 10,000, not cruise/ferry < 20k GT | 1.03 | 1.02 | 0.80 (burns HFO) | ECA surcharge exempt (`v.scrubber`, politics §4.8) | Source [S10] MARPOL VI reg. 4/14 |
| `lng` | LNG dual-fuel | GT ≥ 5,000 and yard has `lng` | 1.15 | 0.86 | 0.95 | eco +1 grade; ECA exempt; LNG bunkers only at harbours tagged `lng` (else runs on MGO ×1) | LHV LNG ≈ 49 vs VLSFO ≈ 41 MJ/kg [S11] |
| `meoh` | Methanol dual-fuel | GT ≥ 5,000 and yard has `meoh` | 1.12 | 2.10 | 0.65 | eco +2; ECA exempt; `fuelCap × 2.1` (tank volume) | LHV methanol ≈ 20 MJ/kg [S11] |
| `hyb` | Battery hybrid | workboat, tug, pilot, ferry, offshore, yachts, expedition | 1.08 | 0.88 below 50 % throttle, 1 above | 1 | eco +1; silent harbour mode (no engine sound ≤ 3 kn) | Game rule |
| `de` | Diesel-electric | where default is not DE: offshore, special, cruise | 1.06 | 0.92 below 60 % throttle, 1.03 above | 1 | redundancy: one generator failure costs only 25 % power (wave-2 parts) | Game rule |
| `i1c` `i1b` `i1a` `i1as` | FSICR ice class 1C/1B/1A/1A Super | displacement hulls ≥ 20 m | 1.02/1.04/1.07/1.12 | 1.01/1.02/1.03/1.05 | 1 | winter ice ports (§5.6), ice wear ×0.7/0.55/0.4/0.3 | Source [S12] |
| `pc6` `pc4` | IACS Polar Class 6 / 4 | expedition, research, explorer, icebreaker (default PC3) | 1.10/1.20 | 1.04/1.07 | 1 | polar areas and icebreaker escort jobs | Source [S13] |
| `geared` / `gearless` | Own cranes on / off | bulk ≤ Kamsarmax, feeders ≤ 1,700 TEU, general | geared 1.06 vs gearless | 1 | 1 | geared: capacity ×0.98, can work at harbours without shore cranes (§5.4) | Game rule |
| `esd` | Energy-saving pack (pre-swirl duct, PBCF, low-friction coating) | LOA ≥ 50 m | 1.015 | 0.95 | 1 | — | Game rule (vendor claims 3–8 %) |
| `rot` | Rotor sails (2–4 Flettner rotors) | tanker, bulk, roro, general ≥ 120 m | 1.03 | 0.85 + 0.15 × (1 − beam-wind factor), avg 0.93 | 1 | visible rotors; air draft +35 m | Game rule (published trials 5–25 %) |
| `air` | Air lubrication | container ≥ 2,800 TEU, LNG, PCTC, cruise | 1.02 | 0.95 | 1 | — | Game rule |
| `eco` / (std) / `prem` | Finish and equipment spec | all | 0.92 / 1 / 1.12 | 1 | 1 | reliability ×0.95/1/1.07, wearMul ×1.08/1/0.93, comfort −1/0/+1 (passenger types), resale ×0.95/1/1.05 | Game rule |

Burn and price multipliers multiply. Mutually exclusive groups: engine (`scr`,`lng`,`meoh`,`hyb`,`de`), ice
(`i1*`,`pc*`), gear, spec. The configurator greys out a token with the reason ("This yard does not build methanol
engines", "Ice class 1A Super needs a hull ≥ 20 m").

**Eco grade** (wave-2 `eco`, A best … E worst) starts at the model's `stats.eco` and moves `lng` +1, `meoh` +2, `hyb`
+1, `esd`/`rot`/`air` +1 together at most, clamped to A. The spec sheet labels it "CII-style rating (game)"; the real
IMO Carbon Intensity Indicator (MARPOL VI, from 2023 [S10]) is only the inspiration.

### 2.6 Port limits (Game rule, data-driven)

`maxLoa` by harbour size: minor 140 m, regional 250 m, major 366 m, mega 400 m; a harbour may override in
`shared/jobs/ports.js` (§5.6) with `maxLoa`, `maxDraft`, `vloc: true`, `lng: true`. The existing berth-water vs
draught check stays the final word at the berth. The shipyard and the job board warn ("Too long for Lowestoft
(140 m)"); docking is refused only by the berth check (no new refusal in phase 1).

---

## 3. Where ships are built: countries, yards and politics

### 3.1 Model (`shared/ships/yards.js`, pure data)

```js
export const YARD = {
  MONTH_H: 6,               // Game rule: one month of real build time = 6 hours on the world clock
  SPECIALIST_MONTHS: 0.9,   // a yard building its speciality: production months × 0.9 …
  SPECIALIST_PRICE: 0.97,   // … price × 0.97 …
  SPECIALIST_REL: 0.03,     // … reliability + 0.03
  STOCK_PREMIUM: 1.08,      // a finished stock hull, delivered at once
  RESALE_SLOT_PREMIUM: 1.12,// buy an earlier slot: skip the backlog
  ORDER_BACKLOG_M: 1,       // each open player order at a yard adds this many months to its backlog
  DELAY: [[0.7, 0], [0.2, 0.10], [0.1, 0.25]],   // seeded per order: share of production months added
  LD_PER_MONTH: 0.005,      // liquidated damages: yard credits 0.5 % of the price per month of delay, at delivery
  WARRANTY_H: 720,          // Game rule (real guarantee period is 12 months [S6])
  GRACE_H: 48,              // an instalment not paid within this is a buyer default
  CANCEL_REFUND: 0.8,       // buyer cancels: the first instalment is lost, later paid instalments come back × 0.8
  LOCAL_MAX_LOA: 30,        // local boatyards (every regional+ harbour) build up to this length
  INSPECT_FRAC: 0.002, INSPECT_MIN: 500, INSPECT_H: 2,
  JONES_PREMIUM: 1.6,       // value of a Jones-eligible ship when valued at a US harbour (Game rule)
};
export const SCHEDULES = {
  std5:  [['contract', 0.20], ['steel', 0.20], ['keel', 0.20], ['launch', 0.20], ['delivery', 0.20]],   // Source [S6]
  tail:  [['contract', 0.10], ['steel', 0.10], ['keel', 0.10], ['launch', 0.10], ['delivery', 0.60]],   // Source [S6] (verify)
  small: [['contract', 0.30], ['delivery', 0.70]],                                                       // Game rule
};
// milestone time = contract time + backlog months (steel cut = production start) + production share:
export const MILESTONE_AT = { contract: null, steel: 0, keel: 0.25, launch: 0.65, delivery: 1 };
```

`YARD_COUNTRIES[cc] = { name, costIdx, backlogM, speed, pay, eca: { name, ltv, years }, resale, src }` and
`YARDS[id] = { id, name, group?, cc, harbor, kind: 'major'|'specialist'|'yacht'|'local', builds: [tags],
spec: [tags], maxLoa, opts: ['lng','meoh','scr','hyb','de','rot','air','pc'], stockOf: [modelIds], src }`.

### 3.2 Builder countries (seed; costIdx, backlog, speed and resale are **Game rules** informed by the sources)

| cc | Country | costIdx | backlog (mo) | speed × | Payment | Export credit / ship finance (Source [S8]) | resale × | Real-world position (Source [S4][S5]) |
|---|---|---|---|---|---|---|---|---|
| KR | South Korea | **1.00** (reference) | 10 | 1.00 | std5 | KEXIM, K-SURE | 1.03 | 2nd largest builder by CGT; leader in LNG carriers and large container ships |
| CN | China | 0.90 | 6 | 1.00 | tail | CEXIM, Sinosure | 0.95 | largest builder (over half of world orders by CGT in recent years); all mainstream types, first domestic large cruise ship (2023) |
| JP | Japan | 1.02 | 8 | 0.95 | std5 | JBIC, NEXI | 1.05 | 3rd; bulk carriers, car carriers, chemical tankers, domestic ferries |
| TW | Taiwan | 1.00 | 6 | 1.00 | std5 | — | 1.00 | container ships |
| VN | Vietnam | 0.92 | 4 | 1.10 | std5 | — | 0.97 | product tankers, small bulkers, workboats |
| PH | Philippines | 0.92 | 4 | 1.10 | std5 | — | 0.97 | bulk carriers |
| SG | Singapore | 1.05 | 4 | 1.00 | std5 | — | 1.00 | offshore vessels and conversions |
| IN | India | 0.95 | 4 | 1.15 | std5 | India Exim Bank | 0.97 | workboats, small ferries |
| TR | Türkiye | 1.05 | 3 | 0.95 | std5 | Türk Eximbank | 1.00 | major tug exporter; fishing vessels, chemical tankers, ferries |
| PL | Poland | 1.15 | 4 | 1.05 | std5 | KUKE | 1.00 | ferries, offshore, hull blocks |
| RO | Romania | 1.05 | 4 | 1.05 | std5 | EximBank Romania | 1.00 | offshore and ferry hulls |
| DE | Germany | 1.40 | 6 | 1.00 | std5 | Euler Hermes (Federal export credit) | 1.03 | cruise ships, superyachts |
| NL | Netherlands | 1.30 | 3 | 0.95 | std5 | Atradius DSB | 1.03 | tugs and workboats, superyachts, dredgers |
| NO | Norway | 1.45 | 5 | 1.00 | std5 | Eksfin | 1.03 | offshore, fishing, expedition cruise |
| FI | Finland | 1.40 | 10 | 1.00 | std5 | Finnvera | 1.03 | cruise ships, ferries, icebreakers |
| FR | France | 1.40 | 12 | 1.00 | std5 | Bpifrance Assurance Export | 1.03 | cruise ships, fishing/workboats, sail yachts |
| IT | Italy | 1.35 | 12 | 1.00 | std5 | SACE | 1.03 | cruise ships, motor yachts |
| ES | Spain | 1.25 | 4 | 1.00 | std5 | CESCE | 1.00 | fishing vessels, tugs |
| DK | Denmark | 1.40 | 4 | 1.00 | std5 | EIFO | 1.00 | pelagic fishing vessels |
| SE | Sweden | 1.40 | 3 | 1.00 | small | EKN | 1.03 | sail yachts |
| GB | United Kingdom | 1.45 | 5 | 1.05 | std5 | UKEF | 1.03 | motor yachts, ferries, research ships |
| **US** | United States | **2.00** (Jones Act, player request; politics Q3) | 8 | 1.25 | std5 | **MARAD Title XI**: guarantee up to 87.5 % for up to 25 years, US-built ships only [S7] | 1.00 (× 1.6 at US harbours if Jones-eligible) | domestic Jones Act fleet; real US-built hulls cost several times the Asian price [S7] |
| RU | Russia | 1.10 | 8 | 1.20 | std5 | — | 0.95 | ice-class tankers; target of EU/UK/US measures (§3.6) |

Loan terms: ECA-backed loans follow the OECD Arrangement's Sector Understanding on Export Credits for Ships (max
80 % of the price, max 12 years) [S8]; China is not a party to the Arrangement, the game applies the same 80 %/12 y.
Title XI is the only domestic programme modelled. Loan **interest** comes from wave-2 `bank.js`.

### 3.3 Yard capability tags

`tug workboat pilot fishing offshore general container_s container_l bulk bulk_l tanker_s tanker_l chem gas_s vlgc lng
roro ferry hsc cruise expedition research icebreaker dredger yacht_s yacht_l sail`. Each model's `builders` lists the
tag it needs (container_s ≤ 3,000 TEU; bulk ≤ Kamsarmax; tanker_s ≤ LR1; yacht_s ≤ 30 m).

### 3.4 Yards (seed list, 60 + local boatyards; `harbor` = existing game harbour id used for delivery)

| id | Name (group) | cc | Delivery harbour | Builds | Speciality | Options |
|---|---|---|---|---|---|---|
| `hhi_ulsan` | HD Hyundai Heavy Industries, Ulsan | KR | `ulsan` | container_s/l, tanker_s/l, vlgc, lng, bulk_l, offshore | container_l, lng, tanker_l | lng meoh scr air rot |
| `hmd_ulsan` | HD Hyundai Mipo, Ulsan | KR | `ulsan` | tanker_s, chem, gas_s, container_s, roro | tanker_s, chem | lng meoh scr |
| `hanwha_okpo` | Hanwha Ocean, Okpo (Geoje) | KR | `busan` | lng, tanker_l, container_l, offshore | lng, tanker_l | lng meoh scr air |
| `samsung_geoje` | Samsung Heavy Industries, Geoje | KR | `busan` | lng, container_l, tanker_l, offshore | lng, container_l | lng meoh scr air rot |
| `hd_samho` | HD Hyundai Samho, Yeongam | KR | `gwangyang` | tanker_l, container_l, bulk_l, lng | tanker_l | lng scr |
| `hudong` | Hudong-Zhonghua (CSSC), Shanghai | CN | `shanghai` | lng, container_l, gas_s | lng | lng scr |
| `swb_shanghai` | Shanghai Waigaoqiao Shipbuilding (CSSC) | CN | `shanghai` | bulk_l, tanker_l, container_l, cruise | bulk_l | lng meoh scr |
| `jiangnan` | Jiangnan Shipyard (CSSC), Shanghai | CN | `shanghai` | vlgc, container_l, gas_s, research, icebreaker | vlgc | lng meoh scr |
| `dsic` | Dalian Shipbuilding (CSSC) | CN | `dalian` | tanker_l, container_l, bulk_l | tanker_l | lng meoh scr |
| `yzj` | Yangzijiang Shipbuilding, Jiangyin | CN | `shanghai` | container_s/l, bulk, bulk_l, tanker_s | container_s, bulk | lng meoh scr |
| `cosco_hi` | COSCO Shipping Heavy Industry, Nantong | CN | `ningbo` | bulk, bulk_l, roro, offshore | roro | lng scr |
| `gsi` | Guangzhou Shipyard International (CSSC) | CN | `guangzhou` | ferry, tanker_s, chem, roro | ferry | lng scr |
| `cmhi_weihai` | China Merchants Jinling, Weihai | CN | `qingdao` | ferry, roro | ferry | lng scr |
| `tsuneishi_zs` | Tsuneishi Shipbuilding, Zhoushan | CN | `ningbo` | bulk | bulk | scr |
| `imabari` | Imabari Shipbuilding, Marugame/Saijo | JP | `kobe` | bulk, bulk_l, container_l, roro | bulk, bulk_l | lng scr |
| `jmu_tsu` | Japan Marine United, Tsu | JP | `nagoya` | bulk_l, tanker_l, container_l | bulk_l | lng scr |
| `oshima` | Oshima Shipbuilding, Saikai | JP | `hakata` | bulk | bulk | scr |
| `tsuneishi_fk` | Tsuneishi Shipbuilding, Fukuyama | JP | `kobe` | bulk | bulk | scr |
| `mhi_shimo` | Mitsubishi Shipbuilding, Shimonoseki | JP | `hakata` | ferry, research | ferry | lng hyb |
| `csbc` | CSBC Corporation, Kaohsiung | TW | `kaohsiung` | container_s/l, bulk | container_s | lng meoh scr |
| `seatrium` | Seatrium, Singapore | SG | `singapore` | offshore, research | offshore | de hyb |
| `hd_vietnam` | HD Hyundai Vietnam Shipbuilding, Khanh Hoa | VN | `vung_tau` | tanker_s, bulk, container_s | tanker_s | scr |
| `damen_songcam` | Damen Song Cam, Haiphong | VN | `haiphong` | tug, workboat, pilot, general | tug | hyb |
| `tsuneishi_cebu` | Tsuneishi Heavy Industries, Cebu | PH | `cebu` | bulk | bulk | scr |
| `subic` | Subic Bay shipyard | PH | `subic` | bulk, tanker_s, container_s | — | scr |
| `cochin` | Cochin Shipyard, Kochi | IN | `kochi` | workboat, ferry, tug, offshore | ferry | hyb |
| `sanmar` | Sanmar Shipyards, Tuzla/Altınova | TR | `istanbul` | tug, workboat | tug | hyb |
| `tersan` | Tersan Shipyard, Yalova | TR | `istanbul` | fishing, ferry, offshore | fishing | hyb de |
| `remontowa` | Remontowa Shipbuilding, Gdańsk | PL | `gdansk` | ferry, offshore, tug | ferry | lng hyb de |
| `damen_galati` | Damen Shipyards Galați | RO | `constanta` | offshore, ferry, dredger | offshore | hyb de |
| `meyer_papenburg` | Meyer Werft, Papenburg | DE | `emden` | cruise, expedition, ferry | cruise | lng meoh air de |
| `lurssen` | Lürssen, Bremen | DE | `bremerhaven` | yacht_l | yacht_l | hyb de |
| `damen_gorinchem` | Damen Shipyards, Gorinchem | NL | `rotterdam` | tug, workboat, pilot, offshore, dredger, hsc, ferry | tug, workboat, pilot | hyb |
| `feadship` | Feadship (Royal Van Lent / De Vries) | NL | `ijmuiden` | yacht_l | yacht_l | hyb de |
| `oceanco` | Oceanco, Alblasserdam | NL | `rotterdam` | yacht_l | yacht_l | hyb de |
| `royal_huisman` | Royal Huisman, Vollenhove | NL | `harlingen` | sail, yacht_l | sail | hyb |
| `vard_norway` | Vard (Fincantieri), Brattvåg/Søviknes | NO | `bergen` | offshore, fishing, expedition, research | offshore, expedition | hyb de lng |
| `ulstein` | Ulstein Verft, Ulsteinvik | NO | `bergen` | offshore, expedition, research | offshore | hyb de |
| `meyer_turku` | Meyer Turku | FI | `turku` | cruise, ferry | cruise | lng meoh air de |
| `rmc` | Rauma Marine Constructions | FI | `turku` | ferry, icebreaker | ferry | lng hyb |
| `helsinki_sy` | Helsinki Shipyard | FI | `helsinki` | icebreaker, expedition, research | icebreaker | de hyb pc |
| `chantiers_atl` | Chantiers de l'Atlantique, Saint-Nazaire | FR | `saint_nazaire` | cruise, ferry | cruise | lng air de |
| `piriou` | Piriou, Concarneau | FR | `brest` | fishing, workboat, tug, research | fishing | hyb |
| `beneteau` | Groupe Beneteau, Vendée | FR | `saint_nazaire` | sail, yacht_s | sail | hyb |
| `fincantieri_mf` | Fincantieri, Monfalcone | IT | `trieste` | cruise | cruise | lng air de |
| `fincantieri_mg` | Fincantieri, Marghera | IT | `venice` | cruise, expedition | cruise | lng air de |
| `azimut_benetti` | Azimut-Benetti, Viareggio | IT | `livorno` | yacht_s, yacht_l | yacht_l | hyb |
| `ferretti` | Ferretti Group, La Spezia | IT | `la_spezia` | yacht_s | yacht_s | hyb |
| `armon` | Astilleros Armón, Vigo | ES | `vigo` | fishing, tug, offshore | fishing | hyb |
| `karstensens` | Karstensens Skibsværft, Skagen | DK | `frederikshavn` | fishing | fishing | hyb |
| `hallberg_rassy` | Hallberg-Rassy, Ellös | SE | `gothenburg` | sail | sail | — |
| `cammell_laird` | Cammell Laird, Birkenhead | GB | `liverpool` | ferry, research | research | hyb de |
| `princess` | Princess Yachts, Plymouth | GB | `plymouth` | yacht_s, yacht_l | yacht_s | hyb |
| `philly` | Philly Shipyard (Hanwha), Philadelphia | US | `new_york` | container_s/l, tanker_s | container_s | lng scr |
| `nassco` | General Dynamics NASSCO, San Diego | US | `san_diego` | tanker_s, roro, container_l | tanker_s | lng scr |
| `bollinger` | Bollinger Shipyards, Louisiana | US | `new_orleans` | offshore, tug, workboat | offshore | hyb |
| `eastern_sb` | Eastern Shipbuilding, Panama City FL | US | `tampa` | tug, offshore, fishing, ferry | tug | hyb |
| `conrad` | Conrad Shipyard, Morgan City | US | `new_orleans` | tug, ferry, gas_s, dredger | — | lng hyb |
| `vigor` | Vigor, Seattle/Portland | US | `seattle` | ferry, fishing, workboat | ferry | hyb |
| `ru_far_east` | Bolshoy Kamen yard (location name only, P6) | RU | `nakhodka` | tanker_l, gas_s, icebreaker | tanker_l | lng |
| `local:<harbour>` | "{Harbour} boatyard" (generated) | harbour's country | that harbour | yacht_s (≤ 24 m), `tug16`, `pilot14`, `inshore15`, `rib8` | — | hyb |

Each row carries `src` (the operator's site or a trade reference) and `verify: true`; the data lane checks names,
locations and what each yard builds today (yards change owners and close — e.g. a row is dropped if the yard no
longer builds that type) before clearing it. `maxLoa` per yard defaults to the largest model its tags allow.

### 3.5 The Jones Act and other build-country rules (what the game enforces)

| Rule | Real basis (Source [S7]) | Game effect | Owner |
|---|---|---|---|
| Coastwise trade (cargo) between US points | Merchant Marine Act 1920 §27, 46 U.S.C. §55102: US-built, US-documented (coastwise endorsement), owned by US citizens (46 U.S.C. §50501, 75 % for companies), US crew (46 U.S.C. §8103) | US domestic contract needs `builtIn: 'US'`, US flag, US home, never foreign-flagged (R1). Badge: "Jones Act: US-built, US-flag, US company" | POLITICS `jobCheck` (§4.10) with R1 |
| Passengers between US points | Passenger Vessel Services Act, 46 U.S.C. §55103 | same check for `passengers`, `cruise`, `ropax_route` jobs with both ends in the US | POLITICS |
| Loss of coastwise rights | 46 U.S.C. §12132: a vessel rebuilt abroad, or sold foreign / placed under a foreign registry, may not regain coastwise privileges (verify wording) | `vessel.hist.jonesLost = true` the moment the flag leaves US (politics `pol_reflag` callback) — permanent; the spec sheet says so before you re-flag | THIS (flag hook) + POLITICS (R1) |
| Dredging in US waters | Dredging Act, 46 U.S.C. §55109 | `dredge` jobs at US harbours need a Jones-eligible ship | THIS (job needs) via POLITICS R4 |
| Towing between US points | 46 U.S.C. §55111 | `towage`/`ocean_tow` with both ends US need Jones eligibility | POLITICS R4 |
| Fishing in the US EEZ | fishery endorsement, 46 U.S.C. §12113 (US-built, with narrow exceptions) | fishing grounds inside the US EEZ (grounds tagged `eez: 'US'`) need `builtIn: 'US'` and US flag | POLITICS R4 |
| US yard price | real US-built cost is several times the world price (CRS report R45725, MARAD) | `costIdx 2.0` (player request = politics Q3 default). Title XI financing for US-built ships | THIS |
| US value premium | scarcity of Jones-eligible tonnage | `marketValue × 1.6` when valued at a US harbour and `jonesOk(vessel)` | THIS |
| EU cabotage | Council Regulation (EEC) No 3577/92: flag of a member state; **no build requirement** | build country irrelevant (politics `bloc` rule) | POLITICS |
| Other national cabotage (JP, CN, IN, ID, BR …) | flag rules, not build rules | not affected by build country | POLITICS |

`jonesOk(vessel) = vessel.builtIn === 'US' && !vessel.hist?.jonesLost && !vessel.hist?.rebuiltAbroad` (pure, in
`shared/ships/index.js`; politics calls it from its national-rule check when R1 lands).

### 3.6 Requests to the politics contract (owner decides; until merged, these features are off)

| # | Request | Why | Fallback until merged |
|---|---|---|---|
| R1 | `cabotage.neverForeign: true` on `US`; national rule also requires `jonesOk(vessel)` | 46 U.S.C. §12132 | none (no cabotage at all until politics is live) |
| R2 | predicate `{ builtIn: ['CN'] }` in `matches()` and a measure kind `port_fee` (`feeCrPerGt`, ports, when) | USTR Section 301 action on China's maritime, logistics and shipbuilding sectors (2025): service fees at US ports on Chinese-built / -operated vessels, effective 14 Oct 2025; **suspended for one year from 10 Nov 2025** — verify status at build; seed as `inactive` unless the source says it is in force [S9] | not modelled |
| R3 | `yardCheck(ds, ctx, cc)` in `shared/politics.js` → `{ ok, block?: Reason }`; blocks when an active regime with personal scope binding the company targets `cc` with an `import_ban` covering goods `vessel` (new pseudo-good; until regimes list it, `machinery`) | ordering a ship from a yard in a country under measures the company must follow | `server/yard.js` treats every yard as allowed and shows no badge |
| R4 | `cabotage.dredging`, `cabotage.towing`, `cabotage.fishery: 'national_built'` for US; grounds/areas with `eez` | Dredging Act, §55111, §12113 | off |

Delivery at a yard whose harbour refuses the company's ship (`entryCheck`) is impossible: the order screen shows
"Delivery not possible at {harbour}: {reason}" and offers "delivery crew to {home}" only if the route avoids the
refusing ports (politics `avoidDiscs`).

### 3.7 Second-hand build countries

Listings draw the yard from `YARDS` that can build the model, weighted by `BUILD_SHARE[type][cc]` (Game rule seeded
from UNCTAD/Clarksons completion shares [S4]: e.g. bulk CN 0.55 JP 0.25 KR 0.05 PH 0.07 VN 0.05 other 0.03; LNG KR
0.75 CN 0.15 JP 0.10; cruise IT 0.35 DE 0.35 FR 0.20 FI 0.10; tug TR 0.25 NL/VN (Damen) 0.25 ES 0.10 US 0.10 CN 0.15
JP 0.10 other 0.05). At a **US harbour**, listings of Jones-relevant types (tug, workboat, offshore, tanker ≤ MR,
ferry, container ≤ 3,000 TEU, fishing) are US-built with probability 0.6 (Game rule), so US players can find
Jones-eligible tonnage at Jones prices. This replaces politics §4.10's 50 %-listing-country rule (POLITICS reads
`listing.hist.builtIn`).

---

## 4. The shipyard

### 4.1 Where you can do what

| Place | Newbuild order | Stock / resale (instant) | Second-hand | Sell / trade-in | Repaint / rename |
|---|---|---|---|---|---|
| A harbour with one or more yards (§3.4) | yes — any yard worldwide; that harbour's yards listed first | that harbour's yards' stock | yes | yes | yes |
| Any other harbour (regional+) | yes (the "newbuilding office" brokers any yard) + its **local boatyard** (≤ 30 m) | local boatyard stock | yes | yes | yes |
| Minor harbour | yes (office) | — | yes (2 listings) | yes | — |
| HQ / office screen | yes, and the order book | — | — | — | — |

Trade-in: only a ship docked in the harbour where you order or buy; her value is credited against the first
instalment(s), and the yard takes her at once (today's `tradeIn` box semantics are kept).

### 4.2 Price, time and payment (pure functions in `shared/ships/index.js`)

```
yardPrice(variantId, yardId)          = round1000( MODELS[m].price × costIdx(cc) × (specialist ? 0.97 : 1) × Π optionPrice )
stockPrice                            = round1000( yardPrice × 1.08 )        resaleSlotPrice = round1000( yardPrice × 1.12 )
productionMonths(m, yard)             = buildMonths(m) × speed(cc) × (specialist ? 0.9 : 1)
backlogMonths(yard, openOrders)       = (yard.backlogM ?? country.backlogM) + 1 × openOrdersAtYard   (0 with a resale slot)
deliveryH                             = (backlog + production × (1 + delayFrac)) × MONTH_H
milestone time                        = contract + backlog × MONTH_H + MILESTONE_AT[k] × production × (1 + delayFrac) × MONTH_H
instalments                           = SCHEDULES[country.pay | small if LOA < 30 m or local] × price (last one absorbs rounding)
```

`buildMonths` per model (Game rule from typical steel-cutting-to-delivery times [S6]): RIB 1, small yachts and
pilot boats 4–6, tugs 7, workboats 6, inshore fishing 5, fishing 10–16, offshore 14–16, general cargo 10–12, feeders
10–11, large container ships 14–16, ULCV 18, bulk 10–14, tankers 11–15, VLCC 15, LPG/VLGC 14–16, LNG 22, PCTC 15,
ferries 15–22, HSC 14, cruise 30–36, expedition 24, research 24, icebreaker 36, dredger 18, explorer yacht 24,
superyachts 30–42. (Stored per model in Appendix A's source data.)

**Worked examples (expected test values, §9):**

| Case | Calculation | Result |
|---|---|---|
| E1 `ultramax64` at `yzj` (CN, bulk specialist), standard | 6,950,000 × 0.90 × 0.97 | **6,067,000** cr; tail schedule 606,700 × 4 + **3,640,200** at delivery; (6 + 11 × 0.9) × 6 = **95.4 h** (steel 36.0 h, keel 50.85 h, launch 74.61 h, delivery 95.4 h, no delay) |
| E2 `ultramax64~lng.i1c.esd` at `imabari` (JP, bulk specialist) | 6,950,000 × 1.02 × 0.97 × 1.15 × 1.02 × 1.015 | **8,187,000** cr; burn 1.419 × 0.86 × 1.01 × 0.95 = **1.171** t/h; (8 + 11 × 0.95 × 0.9) × 6 = **104.43 h** |
| E3 `mr50` at `philly` (US, not specialist) | 6,200,000 × 2.00 | **12,400,000** cr; (8 + 12 × 1.25) × 6 = **138 h**; Title XI financing offered |
| E3b `mr50` at `hmd_ulsan` (KR, tanker_s specialist) | 6,200,000 × 1.00 × 0.97 | **6,014,000** cr; (10 + 12 × 0.9) × 6 = **124.8 h** |
| E4 `tug24` at `eastern_sb` (US, tug specialist) vs `sanmar` (TR, tug specialist) | 256,000 × 2.0 × 0.97 vs 256,000 × 1.05 × 0.97 | **497,000** vs **261,000** cr |
| E5 stock `tug24` at `damen_gorinchem` (NL, specialist) | 256,000 × 1.30 × 0.97 × 1.08 | **349,000** cr, delivered now |

### 4.3 Order life cycle (`server/yard.js`)

```
ordered ──steelAt──▶ building ──launchAt──▶ launched ──deliverAt──▶ ready ──(take delivery)──▶ delivered
   │  each milestone: instalment due → auto-paid from cash; short → warning, GRACE_H 48 h → defaulted
   └─ yard_cancel (any state before ready): first instalment lost, later paid instalments refunded × 0.8
```

- **Delay roll** at contract (seeded by order id): 70 % on time, 20 % +10 %, 10 % +25 % of production months;
  disclosed only when the ship is launched ("Sea trials found a problem: delivery moves to …"). Liquidated damages
  `0.5 % × price × delay months` credited with the delivery instalment.
- **Delivery**: when `ready`, the ship is created (`fleet.makeVessel`) docked at the yard's harbour, status active,
  captain idle, fuel 25 % (`FLEET.NEW_FUEL_FRAC`), `cond 100`, `hist` filled (§4.5), flag = the order's registry
  (politics `office.defaultRegistry` or the choice in the configurator). If the fleet is full (`MAX_VESSELS`), she waits
  at the yard (state `ready`) with storage fee `storageFeePerDay(model)`.
- **Delivery crew to your home** (option at order or when ready): a real-time voyage sailed by a hired captain
  (existing `captain` orders `home`), or **express delivery** priced like today's express passage
  (`SIM.EXPRESS_CR_PER_NM` × sea nm). The order screen shows both, with hours and cost.
- **Warranty**: for `WARRANTY_H` after delivery, wave-2 component breakdowns not caused by grounding, collision or
  over-revving are repaired free at any yard (ledger line "warranty"). Badge "Under warranty · 23 d left".
- **Open orders count toward `FLEET.MAX_VESSELS`** (vessels + open orders ≤ 8).
- **Financing**: if wave-2 `bank.offerShipLoan` exists, the configurator offers a loan of up to `eca.ltv` of the price
  for `eca.years` real years scaled by the bank's term rule (Title XI 87.5 %/25 y for US yards); instalments are then
  paid by the loan first. Without the bank, cash only.

### 4.4 Second-hand market

- **Listings per harbour** (Game rule): mega 8, major 6, regional 4, minor 2; refresh every `ECON.USED_REFRESH_H` (6 h)
  as today, seeded by `(harbourId, refresh index)`. Models are drawn from those allowed at that harbour (`maxLoa`,
  `minPort`) with weights from the harbour's tags (§5.6: an oil port lists tankers, a fishing port fishing boats, a
  marina yachts). One listing in four is a "bargain" (cond 35–55) and one in eight is "nearly new" (age ≤ 3).
- **Age** 0–28 years: `age = floor(28 × r^1.4)` (more young than old ships). Condition correlates:
  `cond = clamp(30, 100, 100 − 2.2 × age − 15 × r2)`.
- **History** (shown on the card, all generated deterministically): build year and yard (§3.7), hull number, class
  society (one of the IACS members ABS, BV, CCS, CRS, DNV, IRS, KR, LR, ClassNK, PRS, RINA, TL [S14]; RU-built ships
  may show RS, which left IACS in 2022), owners 1 + floor(age / 7 × r), flag history (1–4 entries drawn from the
  registries table, newest = current), last dry-dock (≤ 30 months ago; special survey every 5 years [S14]),
  port-inspection record over 3 years (inspections 0–9, detentions 0–2, more with age and low condition), incidents
  (0–2, more with age), main-engine running hours (`age × 6,000 × r`).
- **Price** `round(base × (0.4 + 0.45 × cond/100) × ageMul(age) × resale(builtIn) × (0.9 + 0.2 × r))` (today's
  formula × age × build country).
- **Condition is a range ±10 until inspected.** *Pre-purchase inspection*: fee `max(500, 0.2 % × price)`, takes
  `INSPECT_H` 2 h on the world clock; reveals the exact condition, every wave-2 component condition, survey due dates,
  and any hidden defect (one listing in six has one: e.g. "Main-engine turbocharger 22 %", which the price did not
  show). The report stays with the listing for the inspecting player.
- **Player listings** (later phase, V7 #9): `seller: playerId`, asking price, 24 h, broker fee 1 %.

### 4.5 Value (replaces `shipValue`, keeps its result for old ships)

```
marketValue(vessel, harborCc) = round( basePrice(variant) × 0.55 × (0.3 + 0.7 × cond/100) × ageMul × resale(builtIn) × specResale × jonesMul )
ageMul    = hist && !hist.estimated ? max(0.25, 1 − 0.03 × ageYears) : 1
resale    = YARD_COUNTRIES[builtIn]?.resale ?? 1          ('XX' unknown → 1)
jonesMul  = harborCc === 'US' && jonesOk(vessel) ? 1.6 : 1
```

`basePrice(variant)` is the KR-reference price with option multipliers (never the US ×2 or the yard's discounts): a
US-built ship sold abroad fetches the world price; in the US she keeps a premium. `shipValue(cls, cond)` stays as a
wrapper (`marketValue({ ship: { cls }, cond }, null)`), so politics `hullValue`, wave-2 `marketValue` and today's
trade-in/sell code see identical numbers for migrated ships.

Expected values: migrated coaster cond 78 → **55,836** (= today); new `mr50` KR-built, cond 100, age 0 →
6,200,000 × 0.55 × 1.03 = **3,512,300**; US-built Jones-eligible `tug24` cond 100 at New York → 256,000 × 0.55 × 1.6 =
**225,280**, at Rotterdam **140,800**.

### 4.6 The order and vessel records (frozen)

```js
Order = { id: 'o' + base36, v: 1, ownerId, model, variant, yard, opts: { engine, ice, gear, esd, rot, air, spec },
  livery: Livery, name, registry, hull: 'HN 1234', price, slot: 'normal'|'resale',
  schedule: [{ key, frac, cr, dueAt, paidAt: null|unixS }], createdAt, steelAt, launchAt, deliverAt, delayFrac, ldCr,
  state: 'ordered'|'building'|'launched'|'ready'|'delivered'|'cancelled'|'defaulted', deliverTo: 'yard'|'home',
  tradeIn: null|{ vesselId, cr }, loanId: null|string }
Livery = { hull: 0xRRGGBB, boot: 0xRRGGBB, house: 0xRRGGBB, funnel: 0xRRGGBB, band: null|0xRRGGBB, mark: null|'A'..'ZZ'|icon id, nameColor: 0xRRGGBB }
// vessel additions (fleet makeVessel / healVessel):
vessel.ship.cls  = variantId                                   // unchanged field; a model id or '<model>~tokens'
vessel.spec      = { v: 1, model, opts, livery }              // null on migrated ships → healVessel fills { model: baseOf(cls), opts: {}, livery: defaultLivery(cls) }
vessel.hist      = { v: 1, built, builtAt, yard, builtIn, hull, class, owners, lastDock, nextSpecial, incidents: [],
                     runHours, estimated, jonesLost: false, rebuiltAbroad: false, warrantyTo: 0 }
vessel.built / builtIn / scrubber                              // politics-owned fields, written here at creation
office.orders    = [Order]                                     // persisted with the office
```

### 4.7 Shipyard UI (`public/js/yardui.js`, `yardfmt.js`, `yardpreview.js`; one hook in `hud.js tabShipyard`)

**Desktop (≥ 900 px)**: the existing full-screen harbour sheet; the Shipyard tab becomes a three-pane layout.

```
┌ Shipyard — Rotterdam ───────────────────────────────────────────────────────────────────────────────┐
│ [Newbuild] [Stock & resale] [Second-hand 6] [My orders 2] [Sell / trade-in]       Credits 4,210,000 │
├ Filters ──────────┬ Designs (cards, 3 per row) ───────────────────────┬ Configurator ────────────────┤
│ Type ▾ Bulk       │ ┌──────────┐ Ultramax 64k  ┌──────────┐ Kamsarmax │  ⟲ 3D turntable (drag)        │
│ Size ▾ any        │ │ thumbnail│ 64,000 DWT    │ thumbnail│ 82,000 DWT│  Yard: [map pins ▾ list]      │
│ Price ≤ [____]    │ │          │ from 6.07 M   │          │ from 7.7 M│   Yangzijiang CN  6.07 M 95 h │
│ ☐ I can afford    │ └──────────┘ 95 h · eco B  └──────────┘           │   Imabari JP     6.88 M 104 h │
│ Country ▾ any     │                                                   │   Tsuneishi PH   6.20 M  89 h │
│ ☐ Jones-eligible  │                                                   │  Engine ○VLSFO ○Scrubber ●LNG │
│ Delivery ≤ [__] h │                                                   │  Ice ○— ●1C ○1B ○1A ○1A Super │
│ Eco ≥ ▾           │                                                   │  Cranes ●own ○none  ☑ ESD     │
│ Sort ▾ price      │                                                   │  Finish ○eco ●std ○premium    │
│                   │                                                   │  Livery ▣▣▣▣ mark [A]  Name [ ]│
│                   │                                                   │  Flag ▾ Netherlands (national) │
│                   │                                                   │  Pays: 10 % now, …, 60 % at    │
│                   │                                                   │  delivery · Loan ▾ 80 %/12 y   │
│                   │                                                   │  Delivery ●at yard ○home crew  │
│                   │                                                   │  [Compare] [Order — {due now}]  │
└───────────────────┴───────────────────────────────────────────────────┴───────────────────────────────┘
```

- Cards show the thumbnail (`thumbs.js` with the variant id and livery), name, size line, "from" price (cheapest
  allowed yard) and fastest delivery, eco grade, badges (Jones-eligible possible, ice class, geared, DP2).
- Yard list: each row has flag emoji, yard name, price, delivery hours, payment plan, speciality star, and a red
  reason when blocked (sanctions R3, "does not build this", "too long for this yard"). A small world map (the chart's
  base layer, pins per yard) can replace the list.
- **Spec sheet** (expand on a card): real reference (LOA, B, T, air draft, DWT, GT, TEU/m³/CEU/pax, kW, engine, crew,
  ref. price in USD), game numbers (capacity, speed, burn, range, crew cost, maintenance, dues), wave-2 stats bars,
  "What she can carry" (handling + units, §5.3), "What work she does" (job families, §5.5), "Where she fits" (port size
  and draught limits).
- **Compare** up to 4 (variants of the same model allowed): the existing compare overlay, rows from the spec sheet
  plus yard price, delivery and resale; best value per row highlighted.
- **My orders**: per order a progress bar with milestone ticks, next instalment and due time, preview at the current
  stage, Pay now / Cancel / Delivery options, warranty badge after delivery.
- **Second-hand**: cards with age, build country flag, condition range (or exact after inspection), price, and a
  history drawer (timeline: built → flags → incidents → last dock). Buttons: *Inspect (cost, 2 h)*, *Buy*, *Compare*.

**Phone (< 900 px)**: one column. Segmented control (Newbuild · Stock · Used · Orders · Sell); filters in a bottom
sheet; tapping a card opens the configurator as a full-screen sheet with the turntable on top (240 px tall, pauses when
scrolled away) and sections as accordions; a sticky footer shows "Due now / total / delivery" and the Order button.
Touch targets ≥ 44 px. No hover-only information.

**3D preview** (`yardpreview.js`): one shared WebGL renderer (`thumbs.js` studio pattern) drawing
`buildShip(variantId, name, seed, { livery, stage })` with `stage ∈ [0, 1]`: 0–0.25 hull blocks (bottom shell boxes
along the keel), 0.25–0.65 hull rising (local clipping plane at `y = −T + stage' × (T + deckY)`), 0.65–0.9 hull
complete, superstructure in grey primer, ≥ 0.9 full livery. Desktop 60 fps while dragging, 0 fps idle; phone 30 fps
cap, 1× pixel ratio, dispose on close.

**Repaint / rename** at any harbour with a yard or local boatyard: repaint `0.3 % × basePrice` (min 2,000), 6 h
alongside; rename free (the SHIP_NAME_RE rule).

---

## 5. Cargo and jobs that fit the ship

Today any hull takes any freight good (a container ship loads grain, a tanker loads machinery), and `hardReason`
checks only tonnes, berths and `needsCat`. This section gives every cargo a **handling class and unit**, every model
the **handling it offers**, and replaces the six generic job types with **families** that match real shipping work.

### 5.1 Cargo taxonomy (`shared/cargo.js`, pure)

| Good id | Name | Handling | Unit | t per unit (Game rule) | Market good today? | Fallback good for market/politics (until they list it) |
|---|---|---|---|---|---|---|
| `containers` | Containers (dry) | `box` | TEU | 12 | yes | — |
| `reefer_box` | Reefer containers | `box` + `plugs` | TEU | 14 | no | containers |
| `dg_box` | Dangerous-goods containers (IMDG) | `box` + `dg` | TEU | 12 | no | containers |
| `grain` | Grain | `bulk` | t | 1 | yes | — |
| `ore` | Iron ore | `bulk` (dense: heavy-cargo holds) | t | 1 | no | steel |
| `coal` | Coal | `bulk` | t | 1 | no | fuel |
| `steel` | Steel coils and beams | `breakbulk` or `bulk` | t | 1 | yes | — |
| `machinery` | Machinery (crated) | `breakbulk` or `box` (1 TEU = 12 t) | t | 1 | yes | — |
| `project` | Project / heavy-lift cargo | `heavy` (piece weight ≤ ship crane SWL × 2 in tandem, or port heavy crane) | t + pieces | 1 | no | machinery |
| `crude` | Crude oil | `liquid:crude` | t | 1 (m³ × 0.86) | no | fuel |
| `fuel` | Refined products / bunker fuel | `liquid:clean` | t | 1 | yes | — |
| `chemicals` | Chemicals | `liquid:chem` (segregations ≥ grades) | t | 1 | no | fuel |
| `lpg` | LPG | `gas:lpg` | m³ | 0.55 | no | fuel |
| `lng` | LNG | `gas:lng` | m³ | 0.45 | no | fuel |
| `vehicles` | New cars | `roro` | CEU | 1.5 | no | machinery |
| `trailers` | Trucks and trailers | `roro` | lane m | 2.2 | no | machinery |
| `livestock` | Livestock | `livestock` | head (cattle equivalent) | 0.5 | no | grain |
| `fruit` | Fruit and chilled food (pallets) | `reefer` or `box` + `plugs` | t | 1 | no | grain |
| `fish` | Fish | `fish` or `reefer` | t | 1 | yes | — |
| `supplies` | Offshore supplies | `deck` or `breakbulk` | t | 1 | yes | — |
| `spoil` | Dredged material | `hopper` | m³ | 1.6 | no | — |
| (passengers) | Passengers / guests / students / technicians | `pax` | pax | — | — | — |
| contraband (4) | as today | `box` or `breakbulk` | t | 1 | black market | — |

New goods are **contract cargo only** in phases 1–3 (no harbour stock, no market price); phase 4 can add them to the
market and politics lists them (`HS 26 ore, 2701 coal, 2709 crude, 28–29 chemicals, 271111 LNG, 271112–13 LPG,
87 vehicles, 01 livestock, 08 fruit`). Until then duty and sanctions use the fallback good.

### 5.2 What each hull offers (model fields)

```js
handling: ['box', 'bulk', 'breakbulk', 'heavy', 'liquid:clean', 'liquid:crude', 'liquid:chem', 'gas:lpg', 'gas:lng',
           'roro', 'reefer', 'livestock', 'fish', 'deck', 'hopper', 'pax'],
units:    { t, teu, plugs, ceu, lm, m3, head, pax, segregations, holds },
eq:       ['cranes:2x350', 'dg', 'grabs', 'hoseCranes', 'dp2', 'gangway', 'aframe', 'survey', 'towWinch', 'sternRoller',
           'fifi', 'tender', 'helideck', 'moonpool', 'rsw', 'freezer', 'factory', 'sail']
```

| Type | Handling (default) | Units example | Notes |
|---|---|---|---|
| container | box (+ dg, plugs) | `feeder1700`: teu 1,700, plugs 300 | ULCV plugs 1,000+; gearless unless `geared` |
| general | bulk, breakbulk, box (small) | `gc120`: t 7,200, teu 250, 2 × 40 t cranes | `mpp160` + heavy 2 × 350 t; `reefer150` reefer + plugs 300; `livestock135` livestock head 4,000 |
| bulk | bulk, breakbulk (steel only) | `ultramax64`: t 57,600, holds 5, 4 × 36 t cranes | Capesize+ need `bulk` terminals (§5.6); ore only on bulk ≥ Handysize |
| tanker | liquid:clean (coated), liquid:crude (Aframax+ and legacy `tanker`), liquid:chem (`chem13k` 14 segregations, `mr50` 6) | `vlcc300`: t 270,000 | dirty → clean needs tank cleaning (phase 4) |
| gas | gas:lpg (`lpg5k`, `vlgc86k`), gas:lng (`lng174k`, `lngbv7500`) | `lng174k`: m3 174,000 | LNG/LPG terminals only |
| roro | roro | `pctc7000`: ceu 7,000; `roro3500`: lm 3,500 + pax 12 | needs a ramp berth (tag `roro`) |
| ferry | pax + roro | `ropax200`: pax 1,800, lm 2,800 | `ferry50` ceu 40 |
| cruise | pax | `cruise330`: pax 4,000 | needs tag `cruise` (or tender at anchor at minor harbours) |
| fishing | fish (`rsw`/`freezer`) | `seiner75`: t 2,200 (RSW) | quality kept longer with RSW/freezer |
| offshore | deck, liquid:clean ≤ 1,000 t (fuel/brine below deck), pax (SOV 60) | `psv90`: t 4,500 | DP2, AHTS `towWinch`, `sternRoller` |
| tug / workboat | none (tow), deck (multicat 150 t), pax ≤ 12 (CTV) | | |
| special | research: pax 30, `aframe`, `survey`; icebreaker: helideck, pc; dredger: hopper m3 5,000 | | |
| yachts | pax (guests) | | ≤ 12 guests unless a passenger ship (SOLAS definition, [S17]) |
| legacy ⓛ | coaster: bulk, breakbulk, box 60; feeder: box 1,100; bulker: bulk, breakbulk; tanker: liquid:clean + crude; boxship: box 6,500; ferry: pax + roro lm 900; psv: deck + liquid:clean 1,000; trawler: fish; tug: none; pilot: pax 8; yachts: pax | | the coaster loses fuel cargo (Q5) |

### 5.3 Loading constraints

| Constraint | Rule | Phase |
|---|---|---|
| Handling | every cargo line needs one of its handling classes on the ship | 2 |
| Capacity per unit | `freeUnits(vessel, unit)`; mass also checked against `capacity` t | 2 |
| Mixed cargo | box + breakbulk + bulk may share a general-cargo ship by tonnes; tankers carry up to `segregations` grades; one gas grade at a time | 2 |
| Pax certificate | more than 12 passengers needs a passenger-type ship (SOLAS I/2 definition [S17]); industrial personnel on SOVs per the IP Code (SOLAS XV) [S17] | 2 |
| Draught | loaded draught `T × (0.6 + 0.4 × loadFrac)` (Game rule); the board shows "max load for this berth" = `((water − 0.3)/T − 0.6)/0.4 × capacity` | 3 |
| Length | `maxLoa` of every harbour in the job (§2.6) | 2 |
| Shore equipment | container lots at harbours without `container` tag (or minor) need a geared ship; tankers need `oil`/`products`/`chem` tags; gas needs `lng`/`lpg`; ro-ro needs `roro`; Capesize+ need `bulk_*`; livestock needs `livestock` | 2 |
| Heavy lift | each piece ≤ 2 × ship crane SWL, or both ports tagged `heavy` | 2 |
| Port time | handling rates × `PORT.TIME_SCALE` 0.1 (Game rule): 28 crane moves/h per crane (1 move = 1.6 TEU; cranes mega 4, major 3), grain 1,000 t/h, ore 6,000 t/h, coal 4,000 t/h, crude 10,000 m³/h, products 2,000 m³/h, LNG 12,000 m³/h, cars 300/h, livestock 1,000 head/h, pax 1,500/h. VLCC 300,000 t crude: 349,000 m³ / 10,000 × 0.1 = **3.5 h**; 5,000 TEU on a ULCV at a mega port: 3,125 moves / 112 × 0.1 = **2.8 h** | 4 (V7 #5); shown from phase 2 |
| Tank cleaning | crude → clean grades needs 12 h × 0.1 = 1.2 h at anchor + 0.2 % of ship value | 4 |

### 5.4 The job record (`shared/jobs/types.js`, frozen; JOB_GEN 8)

```js
Job = { id, gen: 8, type, family, title, from, to, legs: [harborId] | null,
  cargo: null | { good, unit, qty, t, grades?, pieces?: [t], reefer?, dg? }, pax: 0,
  needs: { handling: [..], eq: [..], unit, qty, minBp?, ice?, pc?, paxCert?, sail?, motor?, level?, maxWindKn?, jones? },
  steps: [Step], window: { readyAt, laycanTo, dueAt }, timetable?: [unixS],
  pay: { cr, perH?, bonus?: { kind, cr }, model: 'lump'|'hire'|'award' }, hours, ref, postedAt, expiresAt, legacy?: true }
Step = { k: 'load'|'discharge'|'board'|'land'|'sail'|'work'|'meet'|'tow'|'race'|'drill', at: harborId|{lat,lon,rM}|siteId,
         h?, maxKn?, minKn?, within?, count?, until?, label }
```

The **step runner** (`server/jobsx.js`) advances the first open step of each accepted job from three server hooks —
`onTick(actor)` (position, speed, time), `onDock(actor, harbour)`, `onAction(actor, 'job_step', jobId)` — and pays
on the last step. `work` = stay within `within` m of `at`, under `maxKn`, for `h` hours (standby, anchor handling,
dredging, CTD stations, fishing). `meet` = come within `within` m of a moving target under `maxKn` (pilot, towage,
bunkering, escort). The six legacy types keep their code paths in `game.js`; new families use only the runner.

### 5.5 Job families

Pay uses today's `PAY_PER_T_KM` 0.08 cr per t-km, harbour `SIZE_MULT`, and an economy of scale
`eos(t) = max(0.5, (t / 2,000)^−0.12)` (Game rule). km = sea km (planner) as today.

| Family (`type`) | Ships (handling / eq) | Steps | Pay driver (Game rule) | Size and duration | Where generated (tags §5.6) | Captains? |
|---|---|---|---|---|---|---|
| `freight` (legacy, kept) | breakbulk / bulk / box per good | load → sail → discharge | as today: `qty × km × 0.08 × (1–1.15) × size + 800` | 120–20,000 t | everywhere | yes |
| `box` container shipment | box (+plugs, dg) | load → sail → discharge | `TEU × 12 × km × 0.08 × 1.3 × eos` × reefer 1.4 / DG 1.3 | 20–3,000 TEU | `container`, majors | yes |
| `liner` service loop | box, LOA ≤ every port's limit | 3–6 calls in one region, each `load`+`discharge` box lots, timetable | Σ legs × 1.1, +10 % if every call within its 2 h window; 1–3 rotations | 300–8,000 TEU per call | hubs `container` (loop through regionals) | yes |
| `voyage` bulk / tanker / gas voyage charter | bulk, liquid:*, gas:* | (laycan) load → sail → discharge | `qty × km × 0.08 × goodMul × eos(qty)`; goodMul grain 0.75, coal 0.6, ore 0.5, steel 1.0, crude 0.55, products 0.75, chemicals 1.2, LPG 1.4, LNG 1.8, fruit 1.6, livestock 1.8 | `qty = U(0.9, 1.0) ×` a size band's capacity (Handysize … VLOC / MR … VLCC / VLGC / LNG) | `bulk_*`, `oil`, `products`, `chem`, `lng`, `lpg` | yes |
| `coa` contract of affreightment | as voyage | 2–4 voyages on one route | Σ × 1.05, bonus lost if any lifting misses its laycan | | same | yes |
| `tc` time charter | any cargo type | deliver at A → charterer's orders (auto voyages, no per-leg pay) → redeliver at B | hire `basePrice × 0.0025` per hour; charterer pays fuel and port costs; off-hire while broken down (wave 2) | 24–96 h | majors | yes |
| `project` heavy lift | heavy | load (pieces) → sail → discharge | `t × km × 0.08 × 2.5 × eos + 5,000 × pieces` | 1–6 pieces, 80–700 t each | `heavy` | no |
| `vehicles` | roro (ceu / lm) | load → sail → discharge | `CEU × 1.5 × km × 0.08 × 1.6 × eos` (lm × 2.2 t) | 200–7,000 CEU / 300–3,500 lm | `cars`, `roro` | yes |
| `ropax_route` ferry timetable | pax + roro | N crossings A↔B on a timetable | per crossing `pax × (25 + 0.35 km) + lm × 2.2 × km × 0.08 × 1.6`; +15 % when each departure is within 15 min | 2–6 crossings, route ≤ 600 km | `ferry` pairs | yes |
| `passengers` (legacy, kept) | pax | board → sail → land | as today | 4–400 pax | everywhere | yes |
| `cruise` | pax (passenger ship); expedition areas need PC/ice | 3–6 calls over 24–120 h, timetable | `guests × 20 × hours × (0.85 + 0.075 × comfort)`; expedition × 2 | guests 60–100 % of berths | `cruise`; polar/expedition from `ushuaia`, `nuuk`, `tromso`, `hobart` | no |
| `supply` (legacy, kept) | deck | load → platform → back | as today | 40–350 t | `offshore` | yes |
| `anchor` anchor handling / rig move | towWinch, sternRoller, BP ≥ 80/150 t | meet rig → work 2–6 h → tow ≤ 5 kn 20–150 km → work 2 h | `(km × 400 + workH × 2,500) × size` | | `offshore` | no |
| `standby` (ERRV) | offshore or tug ≥ 30 m | work: within 5 km of the platform for 12–48 h | 900 cr/h | | `offshore` | yes |
| `crewchange` wind farm / platform | pax ≤ 12 (CTV) or SOV with `gangway` | board → site → `drill` transfers (CTV: bow against the turbine < 2 kn, 2 min each) or `work` (SOV) → land | `techs × (60 + 0.8 km)` + SOV day rate 1,200 cr/h | 6–60 technicians | `windfarm`, `offshore` | yes (CTV) |
| `tow` (legacy casualty tow) | any; BP better | as today | as today | | everywhere | no |
| `towage` harbour assist | tug BP ≥ Δ/2,000 t | meet an arriving AI ship at the pilot station → `meet` alongside to the berth | `600 + 0.006 × Δ` | Δ of real/AI traffic | majors + megas | no |
| `ocean_tow` | tug/AHTS BP ≥ need | meet tow → tow ≤ 7 kn 200–3,000 km → deliver | `km × (200 + 2 × BPneed)` | | majors | no |
| `salvage` | tug/AHTS/oceantug | reach casualty (aground/drifting) → connect → tow to port of refuge | "no cure, no pay": `8–15 % × casualty value` on arrival, 0 if she sinks (Lloyd's Open Form, Salvage Convention 1989 Art. 13 [S15]); first to connect wins | | storms (weather) near coasts | no |
| `pilot_transfer` | pilot boat | V7 #2 (meet AIS ship, ladder) | V7 #2 | | pilot stations | no |
| `bunkering` | bunker85 (hoseCranes) / lngbv7500 for LNG-fuelled ships | load at terminal → meet ship at anchorage (≤ 100 m, ≤ 1 kn) → pump → back | `t × 25 + 1,500` | 300–3,000 t | `bunkers` hubs (Singapore, Fujairah, Rotterdam, Gibraltar, Algeciras, Panama, Las Palmas …) | yes |
| `launch` launch service | ≤ 30 m with pax | meet ship at anchorage → back | `400 + 25 × km` | 0.2–2 t + 1–6 pax | every harbour with an anchorage | yes |
| `dredge` | hopper | cycles: work ≤ 3 kn in the fairway box until full (hopper / 2,500 m³/h × 0.1 scale) → sail to dump circle → dump; 2–6 cycles | `2.5 cr × m³`; US harbours need Jones (R4) | | `dredge` | yes |
| `survey` | `survey` eq (research75, psv90, sov90) | run 2–8 parallel lines of 5–20 km at 4–6 kn | `300 × line km` | | `offshore`, `windfarm`, research ports | yes |
| `research` science cruise | research75 / icebreaker120 | board scientists → 3–6 `work` stations (≤ 1 kn, 1 h CTD cast) → land | `1,500 cr/h` + per station 3,000 | 10–30 scientists | research ports, polar | no |
| `escort` icebreaker escort | PC hull or ice 1A Super + BP | meet convoy at the ice edge → lead ≤ 10 kn with the convoy within 2 km for 50–400 km | `km × 180` | seasonal ice zones (§5.6) | `ice` | no |
| `fishing` (extended) | fish + gear | as today, with species, season and quota | as today × species price (cod 1.2, herring 0.6, mackerel 0.8, sole/plaice 1.8, crab 3.0, tuna 2.2 of 950 cr/t); without RSW/freezer value −2 %/h after 12 h | quota per company per ground per week (Game rule: 10 × hold of the best licensed boat) | `fishing` | yes |
| `lesson` sailing / powerboat lesson | sail (or motor yacht for powerboat L1–L2), berths ≥ students + 1 | board → `drill` tasks → land | per student L1 400, L2 700, L3 1,000, L4 1,500, +20 % if all tasks; refund and rep −5 on a safety failure (heel > 30° for 10 s, grounding, collision) | 1–5 students, 2–8 h | `marina` | no |
| `daycharter` | yacht, guests ≤ 12 | board → sail out (or sunset window) → back | `guests × 150–400` + tip 0–25 % by comfort (heel ≤ 20° sail, Hs ≤ 1.5 m motor) | 2–12 guests, 2–6 h | `marina` | no |
| `charter` (legacy skippered A→B, kept) | yacht or passenger | as today | as today | | everywhere | no |
| `bareboat` | your docked yacht at a `marina` | she is chartered out (status `chartered`, an AI skipper sails her nearby) | `basePrice × 0.0006` per hour; −0.5 cond per day; 5 % chance of a damage claim (deductible 2 % of value) | 24–168 h | `marina` | — |
| `regatta` | sail classes (divisions monohull / multihull) | `race`: start line window → marks → finish | entry 500 cr; purse = entries + 5,000; 50/30/20 %; corrected time = elapsed × TCF (TCF from the SAILING polar target speed at 12 kn TWS) | windward-leeward 2 × 2 nm or coastal 10–30 nm, start every 6 h | `marina` | no |
| `ecotour` eco-tour / whale watching | ≤ 12 guests (or passenger ship) | board → site area: ≤ 7 kn, keep ≥ 100 m from animals → back | `guests × 120` + sighting bonus 50 % (sighting chance by season) | 2–4 h | sites (§5.6) | no |
| `guests` superyacht programme | yacht_l with crew ≥ opt (wave 2), `tender` | 2–4 anchorages/ports over 24–72 h, `work` at anchor (tender runs) | `basePrice × 0.002` per hour + tips by comfort | 6–36 guests | `marina` in megas/majors | no |
| `smuggling` (kept) | box or breakbulk | as today | as today | | as today | no |

**Sailing lessons in detail.** Levels (game names inspired by RYA/ASA-style schemes, not their products): L1 Crew,
L2 Day Skipper, L3 Coastal, L4 Offshore. Wind limit (true wind): L1 14 kn, L2 18 kn, L3 24 kn, L4 30 kn; above it the
lesson cannot start and, under way, the students ask to go back (−50 % pay if you continue). Tasks from a pool:
tack × n, gybe × n, reef and shake out, heave-to (L2+), man-overboard drill (a dropped buoy marker: stop within 10 m
under 1 kn), pick up a mooring buoy, anchor (L2+), night passage between local sunset and sunrise (L3+), passage
≥ 20 nm (L3), 60 nm offshore (L4). **Request S1 to SAILING:** the sail state exposes counters
`v.sail.stats = { tacks, gybes, reefs, maxHeel10s }` (no physics change), which the lesson runner reads.

### 5.6 Harbour tags and sites (`shared/jobs/ports.js`, `shared/jobs/sites.js`, data)

Default tags by size: mega `container products roro bulk_grain heavy cruise marina bunkers`; major `container
products bulk_grain roro marina`; regional `products bulk_grain ferry marina fishing`; minor `fishing marina ferry`.
Seed overrides (each with `src`, `verify`):

| Tag | Seed harbours (game ids) |
|---|---|
| `bulk_ore` (+`vloc` where marked) | `port_hedland`, `dampier`, `itaguai`†, `vitoria`†, `sohar`†, `saldanha`, `narvik`, `sept_iles`, `qingdao`†, `dalian`† |
| `bulk_coal` | `newcastle_au`, `hay_point`, `gladstone`, `richards_bay`, `vancouver`, `nakhodka`, `balikpapan` |
| `bulk_grain` (extra) | `santos`, `paranagua`, `rio_grande`, `bahia_blanca`, `new_orleans`, `odesa`, `novorossiysk`, `constanta`, `vancouver` |
| `oil` (crude) | `ras_tanura`, `kharg`, `fujairah`, `novorossiysk`, `ust_luga`, `bonny`, `milford_haven`, `wilhelmshaven`, `rotterdam`, `corpus_christi`, `galveston`, `sohar`, `basra→umm_qasr` (Basra Oil Terminal is offshore; tag on the nearest game harbour) |
| `lng` | `ras_laffan`, `bintulu`, `hammerfest`, `gladstone`, `bonny`, `dampier`, `zeebrugge`, `rotterdam`, `galveston`, `ningbo`, `incheon`, `tokyo` |
| `lpg` | `ras_tanura`, `ras_laffan`, `houston→galveston`, `fujairah`, `ulsan` |
| `chem` | `rotterdam`, `antwerp`, `galveston`, `singapore`, `ulsan`, `ningbo` |
| `cars` | `zeebrugge`, `bremerhaven`, `southampton`, `antwerp`, `nagoya`, `ulsan`, `baltimore`, `los_angeles` |
| `cruise` | `southampton`, `barcelona`, `civitavecchia`, `piraeus`, `miami`, `kiel`, `copenhagen`, `bergen`, `palma`, `singapore`, `sydney`, `vancouver`, `ushuaia` |
| `offshore` | `aberdeen`, `stavanger`, `bergen`, `esbjerg`, `den_helder`, `galveston`, `new_orleans`, `kemaman`, `rio_de_janeiro`, `dampier` |
| `windfarm` (+ sites) | `esbjerg`, `eemshaven`, `ostend`, `lowestoft`, `immingham`, `cuxhaven`, `vlissingen` |
| `fishing` (extra) | `peterhead`, `lerwick`, `tromso`, `hammerfest`, `vigo`, `dutch_harbor`, `kodiak`, `nouadhibou`, `mar_del_plata`, `chimbote`, `torshavn`, `reykjavik`, `las_palmas`, `manta`, `petropavlovsk`, `harlingen`, `hirtshals`, `lowestoft` |
| `livestock` | `fremantle`, `darwin`, `broome` |
| `ice` (seasonal) | `lulea`, `helsinki`, `kotka`, `turku`, `st_petersburg`, `ust_luga`, `tallinn`, `quebec`, `sept_iles` |
| `heavy` | `rotterdam`, `antwerp`, `hamburg`, `bremerhaven`, `ulsan`, `busan`, `shanghai`, `singapore`, `galveston` |
| `bunkers` | `singapore`, `fujairah`, `rotterdam`, `gibraltar`, `algeciras`, `panama_colon`, `balboa`, `las_palmas`, `hong_kong`, `busan` |
| `dredge` | `rotterdam`, `antwerp`, `hamburg`, `new_orleans`, `shanghai`, `chittagong`, `haldia`, `buenos_aires` |

(`a→b` = the real port is not a game harbour; the tag goes on the nearest game harbour `b`.)

**Sites** (`sites.js`): wind farms (Hornsea, Dogger Bank, Borssele, Gemini, Horns Rev, Thanet, … positions from the
operators/national registers [S18], ≤ 0.01°), eco-tour areas (Reykjavík bay, Tromsø fjords (winter), Azores
(`ponta_delgada`), Canaries (`santa_cruz_tenerife`), Cape Town, Vancouver/Salish Sea (`vancouver`, `seattle`),
Hervey Bay (`brisbane`), Monterey Bay (`oakland`)) with season months, and **ice zones** (Gulf of Bothnia
Dec–Apr, Gulf of Finland Jan–Mar, Gulf of St Lawrence Jan–Mar; polygons ≤ 40 vertices) whose ports need ice class in
season: Bothnian ports ≥ 1A, others ≥ 1C (Game rule, inspired by the Finnish/Swedish winter traffic restrictions
[S12]); without it the job shows "Ice class 1A needed in season" and the escort family appears.

### 5.7 Generation (Game rule)

- Board size: mega **24**, major **16**, regional **10**, minor **6** (today 8/6/5/3). Smuggling as today.
- Family weights = size base + Σ tag weights. Size base: freight 3, passengers 2, charter 1, box 2 (mega/major),
  launch 1, tow 1. Tag weights: `container` box 4, liner 2, tc 1; `bulk_*` voyage 4, coa 1, tc 1; `oil`/`products`/
  `chem` voyage 4, coa 1, tc 1, bunkering 1 (with `bunkers` 3); `lng`/`lpg` voyage 2; `cars` vehicles 3; `roro`
  vehicles 1; `ferry` ropax_route 2, passengers 1; `cruise` cruise 2; `offshore` supply 3, anchor 1, standby 2,
  crewchange 1, survey 1; `windfarm` crewchange 3, survey 1; `fishing` fishing 4; `marina` lesson 3, daycharter 2,
  bareboat 1, regatta 1, ecotour 1 (at sites), guests 1 (mega/major); `heavy` project 2; `dredge` dredge 1;
  `ice` escort 1 (in season); `livestock` voyage(livestock) 2; majors/megas towage 2, ocean_tow 1.
- **Fit guarantee:** when a player's ship docks and fewer than **3** board jobs pass `canDo` for her, the generator
  adds up to 3 jobs of her families (from this harbour), so every ship always finds work.
- Destinations: existing `pickDestination` bands, filtered by the job's needs (tags at the other end, `maxLoa`,
  depth for the reference ship); a family with no valid destination is skipped.

### 5.8 Eligibility (`shared/jobs/eligibility.js`, pure) and the "why not"

`canDo(job, vessel, ctx) → { ok, why: Reason|null, all: [Reason] }`, checks in this order (first failure = `why`):
handling → equipment → free capacity in the job's unit → passenger certificate → length/draught at every port →
shore facilities → licence (stub `true`) → crew minimum (wave-2 stub) → politics `jobCheck` (when live) → weather
window → ship-hours feasibility (existing `estimateJob`). `hardReason(job, ship)` (jobtime.js) calls `canDo` for
JOB_GEN 8 jobs and keeps its current text for legacy jobs.

| Code | Text template (≤ 60 chars) |
|---|---|
| `handling` | `Needs {handling} — e.g. {suggest}` → "Needs crude tanks — e.g. Aframax, Suezmax, VLCC" |
| `eq` | `Needs {eq}` → "Needs 300 reefer plugs (you have 0)" |
| `cap` | `Needs {qty} {unit} ({free} free)` → "Needs 2,400 TEU (1,700 free)" |
| `paxcert` | `More than 12 guests needs a passenger ship` |
| `loa` | `{port} takes up to {n} m; you are {L} m` |
| `draft` | `{port}: {water} m at the berth, you draw {T} m` |
| `facility` | `{port} has no {facility}` / `No shore cranes at {port} — needs a geared ship` |
| `ice` | `Ice class {cls} needed at {port} in season` |
| `licence` / `crew` | `Needs a {licence} licence` / `Needs {n} crew ({m} aboard)` |
| `politics` | politics `reasonText` |
| `weather` | `Wind {n} kn — limit {m} kn for {level} students` |
| `time` | existing |

### 5.9 Job board UI (`public/js/jobboard.js`, one hook where `hud.js` renders the jobs tab)

- **Your ship can do** (sorted by estimated profit per hour = pay − fuel − crew − dues over the estimated hours),
  **Your fleet can do** (per eligible fleet ship nearby: "Assign to Kittiwake (captain)"), **Other work here**
  (collapsed, each card greyed with its `why` chip; tap shows `all` reasons).
- Family filter chips with counts (Cargo · Tankers & gas · Containers · Passengers · Offshore · Harbour · Fishing ·
  Yachts & sailing · Special). Unit-aware cards: "1,200 TEU · 300 reefer", "55,000 t grain", "174,000 m³ LNG",
  "6 crossings Dover ↔ Calais", "4 students · Level 2 · wind limit 18 kn".
- Steps preview on each card (icons: load, sail, work, meet, race) and the timetable for liner/ferry/cruise.
- Phone: same groups as accordions; chips scroll horizontally.

### 5.10 Market trading compatibility

Buying a market good into the hold (today any good on any ship) requires the good's handling: fuel → `liquid:clean`;
containers → `box`; grain → `bulk`; steel → `bulk`/`breakbulk`; machinery → `breakbulk`/`box`; fish → `fish`/`reefer`/
`breakbulk`; supplies → `deck`/`breakbulk`. Cargo already aboard stays sellable. Hook in `game.js` buy path (§7.4 H7).

---

## 6. Exterior models and walkable interiors: one parametric generator per ship type

### 6.1 Architecture

```
MODELS[id] + options + livery
        │
        ▼
shared/ships/ga.js  generalArrangement(variantId, { livery, stage })  →  GA (pure numbers, node-testable)
        │                                   │
        ▼                                   ▼
public/js/shipgen.js  buildFromGA(GA)      public/js/gaplan.js  planFromGA(GA) → the existing Plan shape (shipplan.js)
(three.js exterior, LODs)                  → walker.js WalkMap (unchanged) → interior.js draws rooms + new props
```

- **One GA drives both the outside and the inside**, so walls always sit inside the plating and windows line up
  (today `shipplan.js MERCHANT_HULL` mirrors `ship.js hullShape` by hand).
- 13 generators (`gen`): `aft_house_dry`, `aft_house_tanker`, `lng`, `container`, `roro_pctc`, `ferry`, `cruise`,
  `offshore`, `tug`, `fishing`, `small_fast`, `motor_yacht`, `special`; plus `sail` → delegated to SAILING
  (`yachtlooks.js`/`rigmesh.js`), untouched here. Legacy `BUILDERS` in `ship.js` stay as the fallback until a model's
  generator passes its tests (§9); `buildShip` picks `shipgen` when `GA_READY.has(gen)`.
- Every hull is **scale-correct** (1 unit = 1 m), from the model's real LOA, B, T, depth and Cb.

### 6.2 The GA record (frozen shape)

```js
GA = { id, gen, L, B, T, D, F, deckY, Cb,
  hull:  { bow: 'bulb'|'raked'|'axe'|'ice'|'tug'|'planing'|'wavepiercer'|'yacht', stern: 'transom'|'cruiser'|'ice'|'tug'|'ramp'|'yacht',
           bowFrac, sternW, sheerFwd, sheerAft, flare, bilgeR, mid: [z0, z1], fcsle: { len, h } | null, poop: { len, h } | null,
           bulwark: 0|1.1, twin: null | { hullB, gap } },
  house: { pos: 'aft'|'fwd'|'mid'|'twin', z0, z1, w, tiers: [{ id, y, h, use }], eyeY },
  bridge:{ y, z0, z1, wings: 'open'|'enclosed'|'none', wingTo, consoles: [Console], aftConsole: bool },
  casing:{ z0, z1, w }, funnel: { z, y, r, h, kind: 'single'|'twin'|'side'|'mast'|'none' },
  er:    { z0, z1, floorY, levels: [y], me: { kind: '2s'|'4s'|'de'|'hs'|'ob', n, len, w, h, xs: [x], z }, gens: { n, len, w, h },
           ecr: { level, side }, purifier: bool, boiler: bool, workshop: bool, steering: { z0, z1, y }, escape: { x, z }, shaft: { z0, z1 } | null },
  cargo: { kind: 'holds'|'bays'|'tanks'|'membrane'|'cardecks'|'paxdecks'|'deck'|'fishhold'|'hopper'|'pens'|'none', zones: [Zone] },
  deck:  { mooring: [{ z, kind, side }], cranes: [{ z, x, swl, boom, h }], boats: [{ kind: 'freefall'|'davit'|'rescue'|'raft'|'tender', z, x }],
           gangway, pilotLadder, aframe, sternRoller, heli, masts: [{ z, h }], rotors: [{ z, h, r }], hoseCranes, manifold: { z } | null },
  goto:  [{ id, label, x, y, z }], levels: [{ id, y, name }], livery, stage }
```

### 6.3 Rules every generator applies (real basis in brackets)

| Element | Rule | Basis |
|---|---|---|
| Freeboard / depth | `D` from the model (`depth`), else `T / ratio` (bulk 0.72, tanker 0.70, container 0.62, ferry 0.45, offshore 0.82, tug 0.80); `deckY = D − T` | load-line practice; Game rule ratios |
| Double bottom | `max(1.0, B / 20)` m (≤ 2.0) under the engine room and holds | SOLAS II-1/9 double-bottom height B/20 [S19] |
| Bridge eye height | the lowest `eyeY` so the view of the sea surface is not hidden for more than `min(2 × L, 500 m)` ahead of the bow over the highest forward obstruction (deck containers, cranes, forecastle) | SOLAS V/22 [S19] — this sets container stack heights and house height on container ships |
| Accommodation | one cabin per `crew.opt` + 2 (pilot, supernumerary); rating cabin floor ≥ 4.5 / 5.5 / 7.0 m² for < 3,000 / 3,000–10,000 / ≥ 10,000 GT; master, chief engineer and chief mate get a day room on ships ≥ 3,000 GT; a hospital when crew ≥ 15; mess rooms, galley, laundry, changing room by the ER entrance, a recreation room/gym ≥ 10,000 GT | MLC 2006 Standard A3.1 [S20] |
| Tier heights | 2.8 m merchant, 3.0 m offshore/ferry crew, 3.2 m passenger public decks, 2.5 m yachts below deck | Game rule (typical) |
| Tier use (aft house) | A (main deck): galley, messes, provisions (dry, cold, freezer), changing room, ship's office · B: ratings' cabins, laundry · C: officers · D: senior officers with day rooms, ship's office · E (≥ 5 tiers): pilot/owner cabins · bridge on top, compass deck above | typical merchant GA |
| Bridge consoles | centre: steering stand (wheel/tiller, autopilot, rudder indicator); starboard of centre: X-band radar, conning display, engine telegraph/combinator; port: S-band radar (≥ 3,000 GT), ECDIS × 2 (primary + backup); aft port: GMDSS station (VHF/MF/HF DSC, NAVTEX); aft starboard: chart table; overhead: rudder, ROT, heading, speed log, depth, wind, clock; BNWAS panel; alarm, fire and nav-light panels; VHF handsets at the console and both wings | SOLAS V/19 carriage requirements [S19]; bridge layout guidance MSC/Circ.982 |
| Bridge wings | reach the ship's side (`wingTo = B/2 − 0.3`) with wing consoles (engine, rudder, thrusters, VHF, whistle); enclosed on ice-class, cruise and ferries | berthing practice |
| Compass deck | magnetic compass (with periscope to the steering stand), radar scanners on the mast, EPIRB, antennas | SOLAS V/19.2.1.1 |
| Engine room | length `0.12 L` (2-stroke), `0.10 L` (DE), `0.18 L` small craft (min 4 m); levels every 4.5 m (≥ 100 m), 2.4 m small; main engine by kind: 2-stroke `len = 4 + 0.07√kW`, `w = 2 + 0.012√kW`, `h = 6 + 0.3·kW^⅓` (59,000 kW → 21.0 × 4.9 × 17.7 m; 8,600 kW → 10.5 × 3.1 × 12.2 m); 4-stroke per engine `len = 2 + 0.05√(kW/n)`, `h = 1.8 + 0.1·(kW/n)^⅓`; 3 generators (DE: 4–6 sized `kW/n`); ECR with switchboard on the upper platform; purifier room; aux boiler (≥ 5,000 kW); workshop; steering gear room aft above the rudder; emergency escape trunk (vertical ladder to the open deck); emergency generator room on deck | SOLAS II-2/13 (two means of escape), II-1/43 (emergency source) [S19]; dimensions Game rule fits |
| Lifesaving | free-fall lifeboat at the stern on bulk carriers, tankers, container ships; davit lifeboats + liferafts on ferries/cruise (boat deck on both sides); rescue boat; liferafts on yachts | SOLAS III/31 (free-fall on bulk carriers built from 2006) [S19] |
| Mooring | forecastle: 2 windlasses + 2 mooring winches; poop: 2–4 mooring winches; bitts, fairleads, Panama chocks; tugs: tow winch (fwd for ASD), staple | practice |
| Cargo deck | bulk: hatch covers with coamings and side walkways 1.2 m; container: bays per 40 ft (12.2 m + 0.8 m lashing bridge), rows `floor((B − 1.2)/2.55)`, tiers below/above from depth and eye height; tanker: catwalk, piping, manifold midships with hose cranes; LNG: trunk deck, domes, cargo compressor house; ro-ro: closed hull to the upper deck, stern quarter ramp; ferry: bow visor or doors + stern doors | practice; Game rule details |
| Funnel | over the casing; LNG and cruise twin uptakes; offshore/tugs side exhausts or twin stacks; ULCV/Neo-Panamax "twin island": house at 0.6–0.65 L from the stern, funnel aft | practice |

### 6.4 Room programme per generator (what you can walk)

| Gen | Hull / outside | House and decks | Engine room | Cargo space walk | Go-to points |
|---|---|---|---|---|---|
| `aft_house_dry` (general, bulk, reefer, livestock) | bulb (≥ 100 m), cruiser stern, forecastle; geared → cranes between hatches | aft house 5–7 tiers | 2-stroke (≥ 120 m) or 4-stroke | hold visit: hatch access ladder → tank top of one hold (dark, 2 floodlights); livestock: pen decks walkable | bridge, ECR, ER floor, mess, cabin, bow, stern, hold |
| `aft_house_tanker` (tankers, LPG) | bulb, cruiser stern, catwalk | aft house; CCR (cargo control room) on A deck | 2-stroke; pump room on older/legacy rows, deep-well pumps on new rows | enclosed tanks **not** enterable (sign "Enclosed space — entry permit and gas test needed", SOLAS XI-1/7); manifold platform | + manifold, CCR |
| `lng` | raked bulb, trunk deck, 4 tank domes | aft house, CCR | 2 × 2-stroke DF, twin skegs | trunk deck walk, compressor house | + compressor house |
| `container` | bulb, bays, lashing bridges; ≥ 14,000 TEU twin island | aft (feeders) or twin island | 2-stroke, long shaft tunnel on twin island | lashing bridge walk; hold view through an access hatch with cell guides | + lashing bridge |
| `roro_pctc` | box hull to the upper deck, stern ramp, side ramp (PCTC) | house forward on top | 2-stroke / DF | car decks (2–12, 1.8–5.2 m clear), internal ramps, vehicles as instanced solids from the cargo | + car deck |
| `ferry` (ferry50, ferry, hsc112 (twin hull), ropax200) | bow doors/visor, stern doors; double-ended for `ferry50` (bridges both ends) | car decks; passenger decks: reception, cafeteria, restaurant, bar, shop, cabins (ropax), outer promenade with lifeboats; crew decks | 4-stroke / DE (+ battery room) | car deck with lanes and lashing | + reception, car deck, boat deck |
| `cruise` | raked bow, balconies, lifeboat recesses, pool deck, funnel aft | deck stack (8–18 decks): crew decks low, public decks (atrium, theatre, restaurants), cabin decks (balcony/inside), lido/pool; **built per deck on demand** | DE gensets, pods (pod motor rooms aft) | — | + atrium, lido, theatre, cabin |
| `offshore` (PSV, AHTS, SOV, ocean tug) | forward house, X-bow option, long low aft deck with crash rails; AHTS stern roller, shark jaws, towing pins; SOV motion-compensated gangway | 3–5 tiers; bridge with **aft-facing console** over the deck | DE or 4 × 4-stroke; AHTS winch room with towing/anchor drums | aft deck, tank hatches | + aft console, winch room |
| `tug` | tug bow, heavy fendering, azimuth pods aft (ASD) | wheelhouse with all-round windows, forward and aft control stations, azimuth levers; mess/galley/cabins below | 2 × 4-stroke + Z-drives | tow winch deck | — (small) |
| `fishing` | high bow, stern ramp (trawlers), gantry, net drum; seiner: power block and net bin aft; longliner: hauling port on starboard side; beam trawler: two derricks midships | wheelhouse forward with fishing consoles (sonar, sounder) | 4-stroke | processing/factory deck (factory80), RSW tanks/freezer hold access | + factory deck |
| `small_fast` (pilot, CTV, RIB) | planing/wave-piercer; CTV bow fender for turbines | wheelhouse with seats, MFD × 2, throttles, joystick; cabin below | 2 × HS diesel / waterjets / outboards | CTV foredeck transfer area | — |
| `motor_yacht` | yacht lines; flybridge; explorer with ice bow and crane; superyacht with tender garage, beach club, helideck (`giga100`) | saloon, galley, owner's suite full beam, guest cabins, crew quarters forward, wheelhouse; sun deck | 2 × HS (small) / 2 × 4-stroke | tender garage | + saloon, owner's suite, beach club |
| `special` | research: A-frame aft, CTD hangar, moon pool, labs; icebreaker: ice bow, helideck, hangar; dredger: hopper, drag arm, gantries | labs (wet/dry), scientists' cabins; icebreaker 2 bridges (forward + aft) | DE + pods | hopper well view, A-frame deck | + labs, aft bridge |

### 6.5 Interaction points

Existing hotspot kinds keep working (`helm`, `engine`, `bunk`, `chart`, `radio`). New kinds:

| Kind | Where | Effect |
|---|---|---|
| `telegraph` | steering stand / wing consoles | opens today's telegraph (wave-1) |
| `thrusters` | wing consoles, aft console | thrusters/joystick panel (V7 own-power berthing; info text until then) |
| `gmdss` | GMDSS station | VHF ch 16 / DSC distress (V7 #3 SAR hook; today: radio chat) |
| `whistle` | steering stand, wings | sounds the horn (today's **Y**) |
| `ecr` | engine control room | wave-2 engine console (gauges, start/stop, generators, fuel transfer, bilge pumps) |
| `steering` | steering gear room | local steering (wave-2 parts: steering gear failure drill) |
| `ccr` | cargo control room | cargo progress (load/discharge, phase 4) |
| `crane`, `winch`, `gangway` | deck machinery | used by `project`, `anchor`, `crewchange` steps (`drill`) |
| `ladder` | holds, escape trunk, masts | climb (1.5 s animation) |
| `goto` | G / Go-to button | quick travel to `GA.goto` points (L > 60 m) |
| `galley`, `hospital`, `muster`, `lab` | rooms | info cards (crew morale / first aid / muster list / research jobs) |

### 6.6 Budgets (Game rule; tested in node with three.js where geometry is involved)

| Item | Desktop | Phone |
|---|---|---|
| Exterior LOD0 triangles (excluding cargo) | small craft ≤ 25k, workboats/fishing ≤ 40k, merchant ≤ 80k, cruise ≤ 120k | × 0.5 (cylinder segments 8 instead of 14, no railings below LOD0 distance) |
| Exterior draw calls (materials after `PartBuilder` merge) | ≤ 24 per ship | ≤ 16 |
| Container stacks | `InstancedMesh` per colour (8) for the 4 nearest bays; other bays one merged block per bay-row with a canvas texture | merged blocks only |
| LOD distances | LOD0 < max(150 m, 1.5 L); LOD1 (blocks, simple cranes) < max(2 km, 6 L); LOD2 silhouette ≤ 500 tris < 15 km; beyond: today's sprite/label | same |
| Build time | ≤ 25 ms for ≤ 200 m, ≤ 80 ms for ULCV/cruise (LOD1 first, LOD0 in idle chunks) | ≤ 60 / 200 ms |
| Interior (walking) | zone-based: current zone + neighbours (house, ER, cargo, forward); ≤ 200k tris, ≤ 200 draw calls | ≤ 60k tris, ≤ 80 draw calls; cruise: current deck ± 1 only; cabins `InstancedMesh` per furniture kind |
| `planFromGA` (node) | ≤ 30 ms per model (cruise per deck group) and ≤ 400 rooms per plan | same |

---

## 7. Lanes, files and frozen interfaces

### 7.1 Lanes (disjoint files; hooks in shared files land in phase 2 of each lane, after the files' current owners merge)

| Lane | Owns (create) | Edits (hooks only, §7.4) | Must not edit |
|---|---|---|---|
| **A — ships data + yard server** | `shared/ships/catalogue.js`, `shared/ships/options.js`, `shared/ships/yards.js`, `shared/ships/index.js`, `server/yard.js`, `scripts/ships/gen-catalogue.mjs` (reproduces Appendix A), `scripts/ships/validate.mjs`; tests `test/ships-catalogue`, `ships-options`, `ships-yard`, `ships-value`, `yard-server`, `ships-migration` `.test.mjs` | `shared/constants.js` (H1), `server/economy.js` (H8b), `server/fleet.js` (H8), `server/game.js` (H2–H4), `shared/fleet.js` (H8c) | `public/**`, `shared/jobs/**`, `shared/cargo.js` |
| **B — client models + shipyard UI** | `public/js/shipgen.js`, `public/js/yardui.js`, `public/js/yardfmt.js` (pure), `public/js/yardpreview.js`, `public/css/yard.css`; tests `test/shipgen.test.mjs` (three.js in node), `test/yardfmt.test.mjs` | `public/js/ship.js` (H9), `public/js/thumbs.js` (H9b), `public/js/hud.js` (H5), `public/js/main.js` (H13), `public/js/fleet.js` + `hq.js` (order book, H13b), `public/index.html` | `shared/**` except reading; `server/**` |
| **C — GA + interiors** | `shared/ships/ga.js`, `public/js/gaplan.js` (pure), tests `test/ga.test.mjs`, `test/gaplan-walk.test.mjs`, `test/interior-budget.test.mjs` | `public/js/shipplan.js` (H10), `public/js/interior.js` (H11), `public/js/walker.js` (ladder links only if unavoidable) | `server/**`, the sail parts of `shipplan.js` (SAILING) |
| **D — cargo + jobs** | `shared/cargo.js`, `shared/jobs/types.js`, `shared/jobs/catalogue.js`, `shared/jobs/eligibility.js`, `shared/jobs/ports.js`, `shared/jobs/sites.js`, `server/jobsx.js`, `public/js/jobboard.js`; tests `test/cargo-compat`, `jobs-gen`, `jobs-eligibility`, `jobs-runner`, `jobs-migration`, `jobboard` `.test.mjs` | `server/economy.js` `generateJob` (H6b), `shared/jobtime.js` (H6c), `server/game.js` (H6, H7), `shared/fleet.js` `CAPTAIN_JOB_TYPES` (H6d), `server/captain.js` (H6e), `public/js/hud.js` jobs tab (H5b) | `shared/ships/**` (reads only) |
| **Reviewer** | this document; changes frozen shapes; runs all suites at each merge | — | — |

### 7.2 Frozen interface — `shared/ships/index.js` (Lane A delivers the stubs at hour 0)

```js
export { MODELS } from './catalogue.js'; export { YARDS, YARD_COUNTRIES, YARD, SCHEDULES, MILESTONE_AT } from './yards.js';
export { OPTIONS, variantId, parseVariant } from './options.js';
export function modelOf(cls)                    /* Model | null — accepts model or variant ids */;
export function baseOf(cls)                     /* legacy id for id-keyed fallback tables ('ulcv24k' → 'boxship') */;
export function typeOf(cls)                     /* 'bulk' | … */;
export function genOf(cls)                      /* generator key */;
export function classRow(variantId)             /* the SHIP_CLASSES-shaped row with option deltas applied; cached */;
export function effStats(vessel)                /* wave-2 stats row with options and spec applied */;
export function optionAllowed(model, token, yardId) /* { ok, why? } */;
export function yardPrice(variantId, yardId)    /* int cr */;
export function stockPrice(variantId, yardId), resaleSlotPrice(variantId, yardId);
export function productionMonths(model, yardId), backlogMonths(yardId, openOrders), deliveryHours(variantId, yardId, openOrders, delayFrac = 0, slot = 'normal');
export function instalments(price, yardId, model) /* [{ key, frac, cr }] summing exactly to price */;
export function milestoneTimes(createdAt, variantId, yardId, openOrders, delayFrac, slot) /* { steel, keel, launch, delivery } unix s */;
export function yardsFor(variantId)             /* [{ yardId, price, hours, specialist, blockedBy? }] sorted by price */;
export function basePrice(variantId), marketValue(vessel, harborCc = null), listingPrice(model, cond, age, builtIn, r);
export function jonesOk(vessel);
export function makeListing(harbor, slot, refreshIdx, rnd) /* Listing (§4.4) */;
export function defaultLivery(cls), validLivery(l);
export const GA_READY /* Set of gen keys whose generator passed its tests (Lane C/B flip entries) */;
```

`shared/constants.js` after H1:

```js
import { legacyRows, classRow } from './ships/rows.js';   // rows.js: legacy rows (non-sail) + lazy variant rows, no constants import
const ROWS = { ...legacyRows, /* the four sail rows stay literal here (SAILING) */ sloop: {…}, ketch: {…}, catamaran: {…}, schooner: {…} };
export const SHIP_CLASSES = new Proxy(ROWS, {
  get: (t, k) => (typeof k === 'string' && !(k in t) ? classRow(k) ?? undefined : t[k]),   // model and variant ids resolve
  has: (t, k) => (k in t) || (typeof k === 'string' && !!classRow(k)),
});                                                                                          // enumeration = the 17 legacy ids only
```

`Object.keys/values(SHIP_CLASSES)` keeps returning the 17 legacy ids, so today's loops (shipyard list, used ships,
interior and telegraph tests) behave exactly as before; new code iterates `MODELS`.

### 7.3 Frozen interfaces — cargo, jobs, GA, wire

```js
// shared/cargo.js
export const CARGO /* §5.1 table */, HANDLING, UNITS;
export function handlingOf(cls)          /* [handling] incl. options (geared) */;
export function unitsOf(cls)             /* { t, teu, plugs, ceu, lm, m3, head, pax, segregations } */;
export function canLoad(good, cls)       /* { ok, why? } */;
export function freeUnits(vessel, unit)  /* number */;
export function toTonnes(good, qty)      /* number */;
// shared/jobs/eligibility.js
export function canDo(job, vessel, ctx)  /* { ok, why: Reason|null, all: [Reason] } — ctx: { harborById, tagsOf, politics?, weatherAt?, licenceOk?, crewOk?, simTime } */;
export function reasonText(reason)       /* string ≤ 60 chars */;
// shared/jobs/catalogue.js
export const FAMILIES /* { [type]: { label, group, unit, needs(job), steps(job), pay(job, env), hours(job, cls), captains: bool } } */;
// shared/ships/ga.js
export function generalArrangement(variantId, opts) /* GA (§6.2) */;
```

**Wire (client ↔ server):**

| Message | Shape |
|---|---|
| `harbor.yard` (in the `harbor` payload) | `{ here: [yardId], local: bool, stock: [{ id, yard, variant, price, livery }], used: [Listing], orders: [Order], tradeIn: int, sellValue: int }` (old `shipyard`/`used` fields kept for one release) |
| `you.orders` | `[Order]` (compact: id, model, yard, state, progress 0–1, next { key, cr, dueAt }) |
| actions | `yard_order { variant, yard, livery, name, registry, deliverTo, slot, tradeIn, loan }`, `yard_pay { orderId }`, `yard_cancel { orderId }`, `yard_deliver { orderId, to: 'home', express }`, `yard_buy_stock { stockId, tradeIn }`, `yard_inspect { listingId }`, `yard_buy_used { listingId, tradeIn }`, `yard_repaint { vesselId, livery }`, `yard_rename { vesselId, name }` |
| events | `yard` log lines: "Steel cut for HN 1234 (Ultramax 64k) at Yangzijiang — 606,700 cr paid", "Instalment due in 12 h", "Delivered", "Delay: delivery moves to …" |
| jobs | `harbor.jobs[]` now JOB_GEN 8 records (§5.4); `job_step { jobId }` action for `drill`/`work` confirmations |

Validation on the server: `variant` must parse and every option be allowed at that yard; `livery` colours 24-bit ints;
name `SHIP_NAME_RE`; `registry` allowed by politics (or the home country if politics is not live); rate limit as
`FLEET.ACTION_RATE`.

### 7.4 Hooks (exact places; each a few lines)

| # | File · function | Change | Lane |
|---|---|---|---|
| H1 | `shared/constants.js` `SHIP_CLASSES` | replace the 13 non-sail literal rows by `legacyRows` + the Proxy (§7.2); sail rows untouched | A |
| H2 | `server/game.js` `sendHarbor` | add `yard: this.yard.view(p, h)` next to `shipyard` | A |
| H3 | `server/game.js` action switch next to `case 'buy_ship'` | `case 'yard_order': … return this.yard.action(p, m)` for the nine actions | A |
| H4 | `server/game.js` tick (where `fleet` ticks) | `this.yard.tick(this.simTime)` once per second | A |
| H5 | `public/js/hud.js` `tabShipyard` | `if (this.app.yardUi) return this.app.yardUi.html(h, you);` + click delegation for `data-act^="yard-"` | B |
| H5b | `public/js/hud.js` jobs tab renderer | `if (this.app.jobBoard) return this.app.jobBoard.html(h, you);` | D |
| H6 | `server/game.js` tick / dock / action switch | `this.jobsx.onTick(p)`, `this.jobsx.onDock(p, h)`, `case 'job_step'` | D |
| H6b | `server/economy.js` `generateJob` | `JOB_GEN = 8`; family dispatch to `jobsx.generate(from, simTime, rnd, env)` for the new families; legacy branches kept | D |
| H6c | `shared/jobtime.js` `hardReason`, `needFor`, `budgetFor`, `refClassFor` | gen ≥ 8 → `canDo` / `FAMILIES[type].hours`; legacy unchanged | D |
| H6d/e | `shared/fleet.js` `CAPTAIN_JOB_TYPES`; `server/captain.js` job pick | add `box`, `voyage`, `coa`, `tc`, `vehicles`, `ropax_route`, `standby`, `crewchange`, `bunkering`, `launch`, `dredge`, `survey` | D |
| H7 | `server/game.js` market buy path | `canLoad(good, p.ship.cls)` before charging; message = reason text | D |
| H8 | `server/fleet.js` `makeVessel`, `healVessel`, `buyNew`, vessel-count check | `spec`, `hist`, politics fields at creation; `buyNew` new → stock purchase via `yard`; count `office.orders` open toward `MAX_VESSELS` | A |
| H8b | `server/economy.js` `shipValue`, `shipSpecs`, `generateUsedShips` | wrappers over `marketValue`, spec sheet from `MODELS`, listings from `makeListing` | A |
| H9 | `public/js/ship.js` `buildShip` | `GA_READY.has(genOf(cls)) ? buildFromGA(generalArrangement(cls, { livery }))` else `BUILDERS[cls] ?? BUILDERS[baseOf(cls)]` with `SHIP_CLASSES[cls]` dims; `hullMat` from livery | B |
| H9b | `public/js/thumbs.js` `keyOf` | include variant and livery hash; bump `VERSION` | B |
| H10 | `public/js/shipplan.js` `buildPlan`, `outlineHalf` | GA-ready → `planFromGA`; else `HOUSE[cls] ?? HOUSE[baseOf(cls)]`, `MERCHANT_HULL[baseOf(cls)]` | C |
| H11 | `public/js/interior.js` | `RPM[baseOf(cls)]`; new prop kinds and hotspots (§6.5); zone streaming; Go-to; ladder climb | C |
| H12 | id-keyed tables elsewhere: `public/js/ais.js` (`classForType`, `FAMILY`), `server/traffic.js`, `public/js/motion.js` (falls back by `cat` already) | read through `baseOf(cls)` | A (server) / B (client) |
| H13 | `public/js/main.js` | create `app.yardUi`, `app.jobBoard`; keys **G** (aboard), **N/U/O** (shipyard open) — checked free in the keydown handler at hook time | B |
| H13b | `public/js/fleet.js`, `public/js/hq.js` | order book rows | B |
| R1–R4 | politics (§3.6) | owner's decision | POLITICS |
| S1 | sailing state counters (§5.5) | owner's decision | SAILING |

---

## 8. Migration

| Item | Old | New | Rule |
|---|---|---|---|
| `ship.cls` on every save | 17 ids | unchanged (model ids) | no rename ever; variant ids only for new purchases |
| vessel `spec` | absent | `{ v: 1, model: cls, opts: {}, livery: defaultLivery(cls) }` | `healVessel` |
| vessel `hist` | absent | `{ v: 1, estimated: true, built: v.built ?? currentYear − round((100 − cond)/3.5), builtIn: v.builtIn ?? 'XX', yard: null, class: null, owners: 1, jonesLost: false }` | `healVessel`; `estimated` → `ageMul = 1`, `resale('XX') = 1`, so **every migrated ship keeps today's value** |
| `vessel.builtIn` | politics migration `'XX'` | kept | a US company's existing ships are **not** Jones-eligible (unknown build); stated in the release note |
| harbour `st.used` | `{ id, cls, cond, price, name, specs }` | Listing (§4.4) | set `st.usedAt = 0` on load → regenerated at the first visit |
| harbour jobs | `gen 7` | `gen 8` | existing `current(j)` drops `gen < JOB_GEN` from boards; **accepted** jobs keep running on the legacy code path (`legacy` derived from `gen < 8`) with no handling check |
| cargo stacks | `{ good, qty, … }` | `+ unit` (default `'t'`) | read-time default; cargo already aboard that the hull could not load now stays sellable |
| market buys | any good | `canLoad` check | from the release on |
| `office.orders` | absent | `[]` | `healOffice` |
| thumbs cache | `v4.2` | `v5.0` | key includes variant + livery |
| politics Q3 | "×2.0 in US harbours' yards" | `YARD_COUNTRIES.US.costIdx = 2.0` | politics must not multiply again |
| client/server skew | — | old `harbor.shipyard`/`used` fields kept one release | old clients still buy legacy hulls |

---

## 9. Tests with expected numbers

All tests are `node:test`; game tests use copied `fakeSocket`/`join` helpers. Numbers are from §2.4, §4.2, §4.5 and
§5.5 (recomputed by `scripts/ships/gen-catalogue.mjs`).

**Lane A**
1. `ships-catalogue.test.mjs` — 76 models; the 17 legacy rows' game fields deep-equal a fixture copy of today's
   `SHIP_CLASSES`; for every new row: `burn = kW × sfoc / 1e6` (±0.001: `ultramax64` **1.419**, `vlcc300` **4.05**,
   `lng174k` **4.29**); prices by formula (`ultramax64` **6,950,000**, `mr50` **6,200,000**, `vlcc300` **28,400,000**,
   `ulcv24k` **38,500,000**, `tug24` **256,000**, `cruise330` **22,200,000**, `ropax200` **3,810,000**, `giga100`
   **23,300,000**); `ultramax64` turnRate **3.0**, crewCost **221**, fuelCap **1,165**; size rules: beams ≤ 32.31 for
   `panamax4500`, `kamsarmax82`, `ultramax64`, `lr1_75`; `neopmax14k` LOA ≤ 366, B ≤ 51.25, T ≤ 15.2; L/B 3.5–9 for
   merchant monohulls; Admiralty coefficient 300–1,000 for cargo/ferry/cruise ≥ 100 m except `hsc112`; Froude number at
   service speed ≤ 0.30 for displacement ships ≥ 100 m; every `builders` tag is offered by ≥ 1 yard; every yard
   `harbor` exists; no `person` fields; sail rows untouched.
2. `ships-options.test.mjs` — `variantId('ultramax64', { engine: 'lng', ice: 'i1c', esd: true })` =
   **`'ultramax64~lng.i1c.esd'`**, round-trips through `parseVariant`; `SHIP_CLASSES['ultramax64~lng.i1c.esd'].burn`
   = **1.171**; `meoh` fuelCap = round(1,165 × 2.1) = **2,447**; two engine tokens → invalid (`undefined`);
   `Object.keys(SHIP_CLASSES).length` = **17**; `'tug24' in SHIP_CLASSES` true.
3. `ships-yard.test.mjs` — E1–E5 exactly (§4.2): **6,067,000** / instalments 606,700 × 4 + **3,640,200** / **95.4 h**
   with milestones **36.0 / 50.85 / 74.61 / 95.4 h**; E2 **8,187,000**, **104.43 h**; E3 **12,400,000**, **138 h**;
   E3b **6,014,000**, **124.8 h**; E4 **497,000** vs **261,000**; E5 stock **349,000**; local US boatyard `tug16` =
   67,000 × 2.0 = **134,000**; backlog +1 month per open order; delay distribution over 10,000 seeded ids within ±2 %
   of 70/20/10; a fake politics `yardCheck` blocking `RU` → `yardsFor('vlcc300')` marks `ru_far_east` blocked with
   the reason text; `instalments()` sums exactly to the price for 1,000 random prices.
4. `ships-value.test.mjs` — migrated coaster cond 78 → **55,836** (= today's `shipValue`); `mr50` KR-built age 0
   cond 100 → **3,512,300**; age 10 cond 80 → **2,114,405**; `ageMul` floors at 0.25 (age ≥ 25); US-built `tug24` at
   New York **225,280**, at Rotterdam **140,800**; after a re-flag to Panama and back to US → **140,800** at New York
   (`jonesLost`).
5. `yard-server.test.mjs` — order E1 with 1,000,000 cash: **606,700** charged at once (ledger `ships`); at 36 h
   another 606,700; at keel with too little cash → warning, 48 h later `defaulted`; cancel after three paid
   instalments refunds 2 × 606,700 × 0.8 = **970,720**; delivery creates a vessel `cls 'ultramax64'`,
   `builtIn 'CN'`, `hist.yard 'yzj'`, docked at `shanghai`, fuel 25 %; with a full fleet the order waits in `ready`
   and storage is charged; inspection of a 2,000,000 listing costs **4,000** and reveals the exact condition after
   2 h; a US company's `tug24` from `eastern_sb` is `jonesOk`, re-flagged → `jonesLost` stays true.
6. `ships-migration.test.mjs` — a v6/v7 save (coaster, boxship, sloop; used listings; gen-7 jobs, one accepted) loads;
   `spec`/`hist` healed; values unchanged; listings regenerated with history; the accepted job pays as before.

**Lane B**
7. `shipgen.test.mjs` (three.js in node) — for every `GA_READY` gen and each of its models: bounding-box length within
   ±1 % of LOA and beam within ±2 %; draft line at y = 0 (keel at −T ± 0.1); draw calls ≤ 24 (phone ≤ 16); LOD0
   triangles within §6.6; the same `(variant, seed, livery)` gives the same geometry hash; `stage 0.3` has no
   superstructure meshes; livery hull colour appears in the hull material.
8. `yardfmt.test.mjs` — price/time strings ("6.07 M cr", "95 h (4 d)"), instalment table rows, reasons, compare rows
   pick best values, filter logic (Jones-eligible filter keeps only US yards).

**Lane C**
9. `ga.test.mjs` — container models: blind distance ahead ≤ min(2 L, 500 m) at the computed eye height; cabins =
   `crew.opt + 2`; hospital iff crew ≥ 15 (`cruise330` yes, `tug24` no); `ulcv24k` main engine **21.0 × 4.9 × 17.7 m**
   and `ultramax64` **10.5 × 3.1 × 12.2 m**; the engine fits between double bottom and the main deck; double bottom
   `min(2, max(1, B/20))` (ulcv **2.0**, ultramax **1.61**); free-fall lifeboat on bulk/tanker/container, davits on
   ferry/cruise.
10. `gaplan-walk.test.mjs` — today's interior walk suite (rooms inside the hull, doorways, stairs level, every room and
    hotspot reachable from the bridge, bow-to-stern deck, stairs from an angle, random wandering) run for **every**
    model whose gen is GA-ready; every Go-to point stands on a walkable floor; ladders link their two levels; plan
    ≤ 30 ms and ≤ 400 rooms.
11. `interior-budget.test.mjs` — interior zone triangle and draw-call limits (§6.6) for the largest model per gen.

**Lane D**
12. `cargo-compat.test.mjs` — `canLoad('grain', 'boxship')` → `handling`; `containers`/`boxship` ok; `crude`/`mr50`
    refused, `crude`/`aframax115` ok; `lng`/`vlgc86k` refused; `vehicles`/`pctc7000` ok; `livestock` only
    `livestock135`; `fuel`/`coaster` refused; `toTonnes('lng', 174000)` = **78,300**.
13. `jobs-gen.test.mjs` — board sizes **24/16/10/6**; over 1,000 seeded boards: at `port_hedland` ≥ 40 % `voyage`
    (ore); at `peterhead` ≥ 40 % `fishing`; at `palma` ≥ 30 % yacht families; fit guarantee: a `pctc7000` docking at
    Rotterdam finds ≥ 3 eligible jobs; voyage quantities inside their band (Capesize 145,800–162,000 t); pay
    examples: grain 55,000 t over 3,000 km at a mega port = **6,651,434**; 1,000 TEU over 1,000 km = **1,006,553**;
    VLCC 270,000 t crude over 5,000 km = **32,972,084**; `tc` hire for `ultramax64` = **17,375 cr/h**; L2 lesson,
    3 students, all tasks = **2,520**; standby 24 h = **21,600**; salvage 10 % of 2,000,000 = **200,000**.
14. `jobs-eligibility.test.mjs` — exact reason strings for: handling ("Needs crude tanks — e.g. Aframax, Suezmax,
    VLCC"), plugs, capacity ("Needs 2,400 TEU (1,700 free)"), pax certificate, LOA at Lowestoft (140 m), draught,
    no shore cranes, ice class in season, weather (lesson wind 22 kn > 18 kn); order of checks.
15. `jobs-runner.test.mjs` (fakeSocket) — voyage: accept → dock at load port → sail → dock at discharge → paid once;
    standby: 12 h inside 5 km → paid 10,800, hours outside the radius do not count; crewchange `drill` transfers;
    lesson tasks counted from `v.sail.stats` (stubbed); captain runs a `voyage` offline.
16. `jobs-migration.test.mjs` — gen-7 board jobs replaced at the first regen; an accepted gen-7 `freight` of grain on a
    `boxship` still completes and pays.
17. `jobboard.test.mjs` — grouping (can do / fleet / other) and sorting by profit per hour; unit strings.

All existing suites stay green (`interior*.test.mjs`, `fleet-*.test.mjs`, `game.test.mjs`, `jobs.test.mjs`,
`market.test.mjs`, `telegraph.test.mjs`, sail suites).

---

## 10. Acceptance checklist

- [ ] The shipyard shows 76 designs grouped by type and size with real measurements and a reference USD price; old
      ships are listed as "classic" with unchanged game numbers.
- [ ] Ordering an Ultramax at Yangzijiang costs 6,067,000 cr, takes 95.4 h, and charges 10 % at contract, steel
      cutting, keel and launch and 60 % at delivery. An MR tanker costs 6,014,000 cr at Hyundai Mipo and
      12,400,000 cr (×2.0) at Philly Shipyard, where she is US-built and Jones-eligible.
- [ ] Options change price, fuel use and the variant id; a methanol ship carries 2.1× the fuel mass; an LNG ship
      bunkers LNG only at LNG harbours.
- [ ] Order progress, milestones, instalments, a missed instalment (48 h grace → default), cancellation refunds, a
      delay with liquidated damages, delivery at the yard or by a delivery crew, warranty badge.
- [ ] Stock hulls deliver at once for +8 %; a resale slot skips the backlog for +12 %.
- [ ] Second-hand listings show build year, yard, build country, flag history, class society, last dock, PSC record,
      incidents; condition is a range until a paid inspection; prices fall with age.
- [ ] A US company's US-built, US-flag ship takes Galveston → New Orleans freight (when politics R1 is live); after a
      re-flag abroad it never can again; a foreign-built ship cannot; a Jones-eligible ship is worth ×1.6 in US ports.
- [ ] With a sanction regime binding the company, a yard in the target country shows "Not allowed for your company"
      and cannot be ordered from (R3).
- [ ] A container ship cannot take grain; the job board groups "Your ship can do" / "Your fleet can do" / "Other
      work here" with a reason on every other card; every docked ship finds ≥ 3 jobs.
- [ ] New families work end to end: box, voyage, coa, tc, vehicles, ropax_route, standby, crewchange, bunkering,
      launch, lesson, daycharter (phase 2); the rest in phase 4.
- [ ] Walking a Kamsarmax: bridge with radars, ECDIS × 2, conning, steering stand, telegraph, VHF and GMDSS; open
      wings to the ship's side; five accommodation tiers with cabins, messes, galley, hospital, day rooms; engine room
      with a 2-stroke main engine at real size, generators, purifier room, ECR, steering gear room; hatch walkways,
      windlasses, free-fall lifeboat; Go-to works.
- [ ] A ULCV is a twin-island ship whose bridge sees over the boxes as SOLAS V/22 requires; a PCTC has walkable car
      decks; a cruise ship streams one deck at a time on a phone at ≥ 30 fps on a mid-range device.
- [ ] Sail classes unchanged (SAILING owns them); their builders and liveries appear in the shipyard.
- [ ] All tests in §9 and all existing suites pass; budgets in §6.6 hold.

---

## 11. Open questions (built with the default unless the product owner changes it)

| # | Question | Default |
|---|---|---|
| Q1 | Build time compression | `MONTH_H = 6` (a Capesize ≈ 4–5 days, a tug ≈ 2 days); stock/resale for instant buys |
| Q2 | Order from any harbour? | yes (newbuilding office); stock only where the yard is |
| Q3 | Open orders count toward `MAX_VESSELS`? | yes |
| Q4 | Rebalance the 17 legacy rows to real numbers? | no (economy and wave-2 tuning depend on them); revisit after wave 2 |
| Q5 | Coaster loses fuel cargo (dry-cargo ship) | yes; cargo aboard stays sellable |
| Q6 | New goods in harbour markets | phase 4, with politics listing them |
| Q7 | Real yard names | yes, except yards in countries targeted by sanctions (location names) |
| Q8 | Giant ships (VLOC, ULCV, mega cruise) for everyone? | yes, limited by price, ports and (later) licences |
| Q9 | Port handling time | shown from phase 2, enforced in phase 4 with `PORT.TIME_SCALE = 0.1` |
| Q10 | Player-to-player ship sales | later (V7 #9 auctions); the listing record already has `seller` |
| Q11 | New sail models | none here; SAILING owner decides |
| Q12 | Show yard delay risk before ordering? | no (real buyers learn at sea trials); LDs compensate |
| Q13 | US ×2.0 also at local US boatyards | yes |
| Q14 | Resale by build country (JP 1.05, KR/EU 1.03, CN/RU 0.95, VN/PH/IN 0.97) | yes, tunable |
| Q15 | Jones premium ×1.6 at US harbours | yes |
| Q16 | Fishing quotas per company | yes, 10 × hold of the best licensed boat per ground per week |
| Q17 | Bareboat damage risk | 5 % per charter, deductible 2 % of value |
| Q18 | Ice affects sailing physics? | no — access and jobs only |
| Q19 | Section 301 port fees on Chinese-built ships | `inactive` until the data lane verifies the status |
| Q20 | Enclosed tanks walkable? | no (permit sign), holds yes (ladder) |

---

## 12. Phased order (what ships first)

| Phase | Content | Lanes | Visible to players |
|---|---|---|---|
| **0 — hour 0** | frozen stubs: `shared/ships/index.js` signatures, `rows.js` legacy rows, `ga.js` stub (hull + house + funnel only), `cargo.js`, `jobs/types.js` | A, C, D | no |
| **1 — catalogue, yards, value** | full catalogue + options + yards + countries; yard server (orders, stock, listings, inspection, delivery); `marketValue`; migration; cargo taxonomy + `canDo` (not enforced); yard UI behind `?yard=1`; **interim visuals**: new models use their `base` builder and deck plan at their own dimensions (H9/H10 minimal); a model is purchasable only if the interim plan passes the walk suite (others `hidden`) | A, B, C (H10 minimal), D | behind flag |
| **2 — first release "v8 shipyard"** | hooks H1–H8, H13; new shipyard tab (newbuild, stock, used with history, orders, compare, turntable, phone layout); Jones Act price and value; compatible jobs with the new board; families `box`, `voyage`, `coa`, `tc`, `vehicles`, `ropax_route`, `standby`, `crewchange`, `bunkering`, `launch`, `lesson`, `daycharter`; market compatibility | A, B, D | **yes** |
| **3 — generator** | GA + `shipgen` + `gaplan` per gen in this order (most-owned first): `aft_house_dry`, `aft_house_tanker`, `container`, `tug`, `small_fast`, `offshore`, `fishing`, `ferry`, `roro_pctc`, `lng`, `motor_yacht`, `special`, `cruise`; each gen flips into `GA_READY` when its tests pass; hidden models unlock | B, C | per gen |
| **4 — depth** | remaining families (`liner`, `project`, `cruise`, `anchor`, `towage`, `ocean_tow`, `salvage`, `dredge`, `survey`, `research`, `escort`, `regatta`, `ecotour`, `guests`, `bareboat`), port time, draught by load, tank cleaning, new market goods, politics R1–R4 wiring, AIS ships drawn with catalogue models, player listings | A, B, D | yes |

---

## 13. Sources (real-world claims; the data lane fills `sources` entries with URL and access date)

- [S1] UNCTAD, *Review of Maritime Transport 2024* — fleet, size categories, shipbuilding by country.
- [S2] Clarksons Research, *Shipping Intelligence Network* — size definitions, newbuilding price indices (reference USD
  prices in Appendix A are ≈ 2024–25 levels; verify).
- [S3] Autoridad del Canal de Panamá — Neopanamax lock vessel limits (LOA 366 m, beam 51.25 m, TFW draught 15.2 m);
  Suez Canal Authority — maximum draught by beam.
- [S4] UNCTAD RMT 2024 and Clarksons — deliveries and order books by builder country (China, Korea, Japan shares).
- [S5] OECD Council Working Party on Shipbuilding (WP6) — *Shipbuilding market developments* reports.
- [S6] SAJ standard newbuilding contract form; BIMCO NEWBUILDCON (2007) — instalments, delay/liquidated damages,
  12-month guarantee period.
- [S7] 46 U.S.C. §§ 55102 (Jones Act), 55103 (PVSA), 55109 (Dredging Act), 55111 (towing), 12112, 12113, 12132,
  50501, 8103; Congressional Research Service R45725, *Shipping Under the Jones Act* (2019); MARAD Title XI Federal
  Ship Financing Program (46 U.S.C. ch. 537).
- [S8] OECD Arrangement on Officially Supported Export Credits, Sector Understanding on Export Credits for Ships;
  the export-credit agencies listed in §3.2 (official sites).
- [S9] USTR, Section 301 action on China's targeting of the maritime, logistics and shipbuilding sectors (Notice of
  Action, April 2025) and the suspension announced November 2025 — verify status at build.
- [S10] MARPOL Annex VI (regs. 4, 13, 14; CII reg. 28).
- [S11] IMO Fourth GHG Study 2020 / IMO LCA guidelines — fuel lower heating values.
- [S12] Finnish-Swedish Ice Class Rules (Traficom / Swedish Transport Agency) and winter navigation traffic
  restrictions (Finnish Transport Infrastructure Agency, Swedish Maritime Administration).
- [S13] IMO Polar Code (MSC.385(94), MEPC.264(68)); IACS UR I1–I3 (Polar Class).
- [S14] IACS member list; IACS statement on the Russian Maritime Register of Shipping (2022); IACS survey
  requirements (5-year special survey cycle).
- [S15] International Convention on Salvage 1989 (Art. 13); Lloyd's Open Form (LOF 2020).
- [S16] NOAA Fisheries and IWC whale-watching guidelines (approach distances).
- [S17] SOLAS I/2 (passenger ship: more than 12 passengers); SOLAS XV and the IP Code (MSC.527(106)).
- [S18] National offshore-wind registers and operator sites — wind-farm positions.
- [S19] SOLAS II-1/9, II-1/43, II-2/13, III/31, V/19, V/22; IMO MSC/Circ.982 (bridge design guidelines).
- [S20] ILO Maritime Labour Convention 2006, Regulation 3.1 / Standard A3.1.
- [S21] Owner/class public data for the size references (e.g. 24,000 TEU class 399.9 × 61.5 m; Valemax 362 × 65 m;
  Oasis-class 362 m) — verify each row's dimensions.

---

## Appendix A — Catalogue (generated; Lane A's `gen-catalogue.mjs` must reproduce it)

ⓛ = legacy id (game columns are today's values, reference columns added). Ref. USD m ≈ 2024–25 newbuild level
(Source ≈ [S2], verify). Game price, game cap, Δ, crewCost, turn and fuel follow §2.4 for new rows. `Cadm` =
Admiralty coefficient Δ^(2/3)·kn³/kW (sanity only). Sail classes (`sloop`, `ketch`, `catamaran`, `schooner`) are
not repeated here: their rows are SAILING's and stay as in `shared/constants.js`.

| id | Model | LOA×B×T m | DWT | GT | Capacity (real) | kn max/svc | kW · engine | sfoc | burn t/h | fuel t | crew min/opt | ref. newbuild USD m | **game price cr** | game cap t | Δ t | crewCost | turn | Cadm |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **workboat** |||||||||||||||||||
| `ctv26` | Crew transfer catamaran 26 m | 26×10.4×1.7 | 60 | 150 | 24 pax(ind.12) | 27/24 | 2,200 · 2x HS diesel, waterjets | 215 | 0.473 | 7.3 | 2/3 | 4.5 | **153,000** | 15 | 110 | 18 | 22.3 | 205 |
| `multicat27` | Multicat workboat 27 m | 27×12.5×2.6 | 300 | 350 | BP 30 t | 10.5/9 | 1,600 · 2x MS diesel, FP props | 210 | 0.336 | 57.5 | 3/5 | 6 | **198,000** | 150 | 541 | 30 | 21.7 | 48 |
| **tug** |||||||||||||||||||
| `tug16` | Line-handling pusher tug 16 m | 16×6.4×2.2 | 20 | 60 | BP 14 t | 10/9 | 900 · 2x HS diesel | 215 | 0.194 | 10.6 | 2/2 | 1.8 | **67,000** | 10 | 112 | 12 | 30 | 26 |
| `tug24` | ASD harbour tug 24 m | 24.5×11.3×5 | 140 | 250 | BP 70 t | 12.5/11 | 4,480 · 2x MS diesel, azimuth | 205 | 0.918 | 103 | 3/4 | 8 | **256,000** | 30 | 688 | 24 | 29.2 | 34 |
| `tug` ⓛ | ASD tug 32 m (legacy "Harbour tug") | 32×11×5 | 200 | 480 | BP 80 t | 13/11.5 | 5,300 · 2x MS diesel, azimuth | 205 | 0.45 | 60 | 4/6 | 10 | **320,000** | 50 | 700 | 45 | 23.9 | — |
| `oceantug60` | Ocean towing & salvage tug 60 m | 60×16.5×6.2 | 1,500 | 2,100 | BP 150 t | 16/13 | 10,000 · 2x MS diesel, CP props | 195 | 1.95 | 1,109 | 10/14 | 35 | **967,000** | 600 | 3,662 | 88 | 14.9 | 97 |
| **pilot** |||||||||||||||||||
| `pilot14` | Pilot boat 14 m | 14.5×4.6×1.3 | 2 | 30 | 6 pax | 25/22 | 900 · 2x HS diesel | 220 | 0.198 | 1.4 | 2/2 | 1.2 | **46,000** | 1 | 22 | 12 | 21.6 | 136 |
| `pilot` ⓛ | Pilot boat 18 m (legacy) | 18×5.5×1.8 | 4 | 50 | 8 pax | 26/22 | 1,300 · 2x HS diesel | 220 | 0.12 | 6 | 2/3 | 1.8 | **90,000** | 2 | 40 | 15 | 18.4 | — |
| **fishing** |||||||||||||||||||
| `inshore15` | Inshore trawler / crabber 15 m | 15×5.6×2.3 | 25 | 45 | hold 15 t | 9/8 | 300 · 1x HS diesel | 215 | 0.065 | 7.5 | 2/3 | 1.2 | **28,000** | 15 | 106 | 18 | 21.1 | 54 |
| `beam40` | Beam trawler 40 m | 42×9×4 | 350 | 450 | hold 120 t | 12.5/11 | 1,470 · 1x MS diesel, CP prop | 205 | 0.301 | 84.3 | 5/7 | 7.5 | **145,000** | 120 | 872 | 42 | 9.7 | 121 |
| `trawler` ⓛ | Stern trawler 45 m (legacy) | 45×10×4.2 | 600 | 1,000 | hold 300 t | 12/11 | 2,200 · 1x MS diesel | 205 | 0.5 | 40 | 6/10 | 10 | **180,000** | 300 | 900 | 35 | 9.2 | — |
| `longliner50` | Autoline longliner 50 m | 50×11.5×5.5 | 800 | 1,500 | frozen 500 t | 13/11 | 2,200 · 1x MS diesel, DE aux | 200 | 0.44 | 221.8 | 12/20 | 20 | **351,000** | 500 | 1,887 | 124 | 8.5 | 152 |
| `seiner75` | Pelagic purse seiner / trawler 75 m | 75×15.6×7.6 | 3,000 | 3,000 | RSW 2,500 m³ | 17/15 | 7,000 · 1x MS diesel, CP prop | 190 | 1.33 | 437 | 9/12 | 45 | **728,000** | 2,200 | 5,481 | 76 | 6.3 | 218 |
| `factory80` | Factory freezer trawler 81 m | 81×17×7 | 3,000 | 4,500 | frozen 1,800 t | 15.5/14 | 7,400 · 1x MS diesel, CP prop | 190 | 1.406 | 742 | 40/60 | 75 | **1,150,000** | 1,800 | 5,750 | 392 | 6 | 162 |
| **offshore** |||||||||||||||||||
| `ahts70` | Anchor-handling tug supply 70 m (80 t BP) | 70×16.5×6 | 2,500 | 2,500 | BP 80 t, deck 400 m² | 14/12 | 6,000 · 4x MS diesel, CP props | 200 | 1.2 | 370 | 12/15 | 25 | **715,000** | 1,500 | 4,685 | 94 | 8.6 | 128 |
| `psv` ⓛ | Platform supply vessel 85 m (legacy) | 85×20×6.5 | 4,500 | 3,600 | deck 900 m² | 14/12 | 7,000 · DE 4x gensets | 195 | 1.1 | 400 | 12/15 | 35 | **1,200,000** | 2,500 | 4,500 | 90 | 7.5 | — |
| `psv90` | Hybrid PSV 90 m (battery, DP2) | 90×19.5×7.4 | 5,300 | 4,700 | deck 1,000 m² | 14/12 | 7,400 · DE 4x DF gensets + battery | 185 | 1.369 | 351 | 12/16 | 42 | **1,140,000** | 4,500 | 9,297 | 105 | 7.2 | 164 |
| `ahts85` | Large AHTS 85 m (200 t BP) | 85×22×7.5 | 4,000 | 5,200 | BP 200 t | 16.5/13 | 17,000 · 4x MS diesel, CP props | 195 | 3.315 | 1,414 | 18/25 | 55 | **1,450,000** | 2,400 | 9,482 | 165 | 7.5 | 118 |
| `sov90` | Service operation vessel 90 m (walk-to-work) | 90×19.5×6.5 | 2,500 | 7,000 | 60 technicians, gangway | 13/12 | 8,000 · DE 4x gensets, DP2 | 190 | 1.52 | 390 | 20/25 | 60 | **1,570,000** | 1,000 | 7,712 | 171 | 7.2 | 107 |
| **general** |||||||||||||||||||
| `coaster` ⓛ | Coastal freighter 90 m (legacy, classic) | 90×14×5.5 | 3,700 | 2,500 | 1,200 t game payload | 14/12 | 1,800 · 1x MS diesel | 195 | 0.9 | 80 | 7/9 | 9 | **120,000** | 1,200 | 3,200 | 40 | 5.5 | — |
| `shortsea88` | Short-sea box-hold coaster 90 m (eco) | 89.9×12.5×5.6 | 3,800 | 2,600 | 4,900 m³ box hold | 12/11 | 1,500 · 1x MS diesel + shaft gen | 190 | 0.285 | 63.8 | 6/8 | 10 | **630,000** | 3,420 | 5,005 | 50 | 5.5 | 337 |
| `gc120` | General cargo / multipurpose 120 m | 120×16.8×7.5 | 8,000 | 5,600 | 2x 40 t cranes, 250 TEU | 13.5/12.5 | 3,200 · 1x MS diesel, CP prop | 190 | 0.608 | 180 | 10/13 | 18 | **1,190,000** | 7,200 | 12,026 | 87 | 4.4 | 404 |
| `mpp160` | Multipurpose heavy-lift 160 m | 160×26×9.8 | 17,000 | 13,000 | 2x 350 t cranes, 1,000 TEU | 16/15 | 9,000 · 1x LS 2-stroke | 175 | 1.575 | 776 | 14/18 | 40 | **3,150,000** | 15,300 | 30,806 | 135 | 3.6 | 447 |
| `reefer150` | Reefer ship 150 m (pallets + 300 FEU plugs) | 150×24×9.2 | 13,000 | 11,000 | 560,000 cu ft | 21/19.5 | 12,500 · 1x LS 2-stroke | 175 | 2.188 | 691 | 16/20 | 40 | **2,870,000** | 11,700 | 20,416 | 146 | 3.7 | 553 |
| `livestock135` | Livestock carrier 134 m (pens 8,000 m²) | 134×21×6.5 | 7,000 | 9,000 | 14,000 sheep or 4,000 cattle | 16/14 | 6,000 · 1x MS diesel | 185 | 1.11 | 391 | 25/35 | 45 | **1,690,000** | 6,300 | 12,730 | 247 | 4.1 | 372 |
| **container** |||||||||||||||||||
| `feeder1000` | Feeder 1,000 TEU 135 m | 134×22.5×7.6 | 13,000 | 9,900 | 1,000 TEU | 18.5/17 | 8,000 · 1x LS 2-stroke | 175 | 1.4 | 304 | 12/16 | 24 | **3,230,000** | 11,700 | 15,492 | 115 | 4.1 | 492 |
| `feeder` ⓛ | Container feeder 150 m (legacy) | 150×24×8.5 | 13,000 | 10,500 | 1,100 TEU | 20/17 | 17,000 · 1x LS 2-stroke | 180 | 3.2 | 300 | 13/17 | 26 | **950,000** | 4,000 | 14,000 | 120 | 3.7 | — |
| `feeder1700` | Feeder 1,700 TEU 172 m | 172×27.2×9.8 | 21,500 | 18,000 | 1,700 TEU, 300 reefer | 19.5/18 | 12,600 · 1x LS 2-stroke | 172 | 2.167 | 593 | 14/18 | 30 | **4,950,000** | 19,350 | 30,998 | 145 | 3.4 | 581 |
| `subpmax2800` | Sub-Panamax 2,800 TEU 200 m | 200×32.2×11.5 | 38,000 | 28,000 | 2,800 TEU | 21/19 | 20,000 · 1x LS 2-stroke | 168 | 3.36 | 1,525 | 16/20 | 42 | **8,030,000** | 34,200 | 48,599 | 183 | 3 | 617 |
| `panamax4500` | Panamax 4,500 TEU 294 m (classic) | 294×32.2×12.5 | 52,000 | 50,000 | 4,500 TEU | 24/21 | 36,000 · 1x LS 2-stroke | 170 | 6.12 | 3,231 | 20/24 | 60 | **10,500,000** | 46,800 | 72,946 | 275 | 2.3 | 670 |
| `boxship` ⓛ | Post-Panamax 6,500 TEU 300 m (legacy) | 300×43×14 | 80,000 | 75,000 | 6,500 TEU | 22/20 | 54,000 · 1x LS 2-stroke | 165 | 9 | 4,000 | 20/24 | 85 | **25,000,000** | 90,000 | 110,000 | 400 | 2.2 | — |
| `neopmax14k` | Neo-Panamax 14,000 TEU 366 m | 366×51×15.2 | 150,000 | 145,000 | 14,000 TEU, 1,000 reefer | 22.5/19 | 50,000 · 1x LS 2-stroke (LNG-ready) | 160 | 8 | 5,187 | 22/26 | 165 | **25,800,000** | 135,000 | 186,181 | 531 | 1.9 | 743 |
| `ulcv24k` | ULCV 24,000 TEU 400 m | 399.9×61.5×16.5 | 240,000 | 236,000 | 24,000 TEU | 22.5/17 | 59,000 · 1x LS 2-stroke (LNG DF) | 158 | 9.322 | 7,431 | 23/28 | 270 | **38,500,000** | 216,000 | 270,322 | 788 | 1.8 | 807 |
| **bulk** |||||||||||||||||||
| `bulker` ⓛ | Handysize bulk carrier 190 m (legacy, classic) | 190×30×10.5 | 35,000 | 22,000 | 5 holds, 4x30 t cranes | 14/13 | 16,500 · 1x LS 2-stroke | 170 | 2.8 | 900 | 18/21 | 30 | **4,500,000** | 35,000 | 40,000 | 180 | 3.1 | — |
| `handy38` | Handysize 38k eco, geared | 180×32×10.5 | 38,000 | 22,500 | 5 holds, 4x30 t cranes | 14.5/13.5 | 6,500 · 1x LS 2-stroke | 165 | 1.073 | 783 | 18/21 | 33 | **4,460,000** | 34,200 | 49,910 | 180 | 3.3 | 636 |
| `ultramax64` | Ultramax 64k, geared | 199.9×32.24×13.3 | 64,000 | 36,000 | 5 holds, 4x36 t cranes, grabs | 14.5/13.5 | 8,600 · 1x LS 2-stroke | 165 | 1.419 | 1,165 | 19/22 | 36 | **6,950,000** | 57,600 | 72,439 | 221 | 3 | 616 |
| `kamsarmax82` | Kamsarmax 82k, gearless | 229×32.26×14.45 | 82,000 | 44,000 | 7 holds | 14.5/13.5 | 9,800 · 1x LS 2-stroke | 165 | 1.617 | 1,328 | 19/22 | 37 | **8,580,000** | 73,800 | 91,277 | 239 | 2.7 | 631 |
| `capesize180` | Capesize 180k | 292×45×18.2 | 180,000 | 93,000 | 9 holds | 14.5/13 | 16,000 · 1x LS 2-stroke | 163 | 2.608 | 2,472 | 21/24 | 75 | **16,700,000** | 162,000 | 204,485 | 377 | 2.3 | 661 |
| `newcastlemax208` | Newcastlemax 208k | 299.9×50×18.4 | 208,000 | 107,000 | 9 holds | 14.5/12.5 | 16,500 · 1x LS 2-stroke (LNG DF option) | 163 | 2.69 | 2,651 | 21/24 | 80 | **18,900,000** | 187,200 | 235,917 | 408 | 2.2 | 705 |
| `vloc400` | VLOC 400k ore carrier | 362×65×23 | 400,000 | 200,000 | 7 ore holds | 15.5/14 | 29,000 · 1x LS 2-stroke | 163 | 4.727 | 4,576 | 24/28 | 130 | **33,000,000** | 360,000 | 468,128 | 704 | 1.9 | 774 |
| **tanker** |||||||||||||||||||
| `bunker85` | Bunker tanker 85 m | 85×15×5.6 | 4,500 | 3,000 | 5,200 m³, 2 hose cranes | 12/11 | 1,800 · 2x MS diesel | 200 | 0.36 | 50.4 | 8/10 | 12 | **800,000** | 4,050 | 5,679 | 64 | 5.7 | 306 |
| `chem13k` | Stainless chemical tanker 13k (IMO II) | 128×20.4×8.7 | 13,000 | 8,500 | 14 segregations | 14/13.5 | 5,000 · 1x MS diesel, CP prop | 185 | 0.925 | 422 | 14/17 | 30 | **2,660,000** | 11,700 | 18,069 | 119 | 4.2 | 378 |
| `tanker` ⓛ | Handy product tanker 180 m (legacy, classic) | 180×32×11 | 37,000 | 24,000 | coated, 12 tanks | 15/14 | 15,300 · 1x LS 2-stroke | 170 | 2.6 | 800 | 18/22 | 45 | **4,200,000** | 30,000 | 45,000 | 180 | 3.3 | — |
| `mr50` | MR product/chemical tanker 50k | 183×32.2×13.3 | 50,000 | 29,800 | IMO II/III, 12 tanks | 15/14 | 8,800 · 1x LS 2-stroke | 165 | 1.452 | 1,150 | 20/23 | 48 | **6,200,000** | 45,000 | 63,895 | 215 | 3.2 | 613 |
| `lr1_75` | LR1 product tanker 75k | 228×32.24×14.5 | 75,000 | 42,000 | 12 tanks | 15/14 | 11,000 · 1x LS 2-stroke | 165 | 1.815 | 1,437 | 21/24 | 58 | **8,750,000** | 67,500 | 87,957 | 256 | 2.7 | 607 |
| `aframax115` | Aframax / LR2 115k | 250×44×15 | 115,000 | 62,000 | 12 tanks | 15/14 | 14,000 · 1x LS 2-stroke | 163 | 2.282 | 2,008 | 22/25 | 72 | **12,600,000** | 103,500 | 136,163 | 317 | 2.6 | 638 |
| `suezmax158` | Suezmax 158k | 274×48×17 | 158,000 | 81,000 | 12 tanks | 15.5/14.5 | 17,000 · 1x LS 2-stroke | 163 | 2.771 | 2,354 | 23/26 | 86 | **16,500,000** | 142,200 | 184,508 | 378 | 2.4 | 710 |
| `vlcc300` | VLCC 300k | 333×60×22.5 | 300,000 | 160,000 | 17 tanks | 15.5/14 | 25,000 · 1x LS 2-stroke | 162 | 4.05 | 3,920 | 25/28 | 128 | **28,400,000** | 270,000 | 366,511 | 609 | 2.1 | 763 |
| **gas** |||||||||||||||||||
| `lpg5k` | Pressurised LPG carrier 5,000 m³ | 99.9×18×6.6 | 5,500 | 4,500 | 2 bilobe tanks | 14/13 | 3,500 · 1x MS diesel | 185 | 0.648 | 184 | 12/15 | 25 | **1,550,000** | 4,950 | 8,496 | 98 | 5.1 | 326 |
| `lngbv7500` | LNG bunkering vessel 7,500 m³ | 100×19.6×5.5 | 4,500 | 7,500 | 2 IMO type C tanks | 13/12 | 4,500 · DE DF gensets | 185 | 0.833 | 171 | 13/16 | 65 | **1,890,000** | 4,050 | 7,503 | 110 | 5.1 | 187 |
| `vlgc86k` | VLGC 86,000 m³ (LPG) | 230×36.6×11.4 | 55,000 | 48,000 | 4 type A tanks | 17/16 | 14,000 · 1x LS 2-stroke (LPG DF) | 165 | 2.31 | 1,601 | 22/25 | 115 | **11,000,000** | 49,500 | 74,422 | 282 | 2.7 | 621 |
| `lng174k` | LNG carrier 174,000 m³ (membrane) | 295×46.4×11.5 | 82,000 | 115,000 | 4 membrane tanks | 19.5/18 | 26,000 · 2x LS 2-stroke DF (ME-GA/X-DF) | 165 | 4.29 | 2,936 | 26/30 | 255 | **22,300,000** | 73,800 | 118,945 | 532 | 2.3 | 690 |
| **roro** |||||||||||||||||||
| `roro3500` | Ro-ro freight ferry 195 m (3,500 lane m) | 195×26.5×7 | 13,000 | 33,000 | 3,500 lane m, 12 drivers | 21/19 | 16,000 · 2x MS diesel, CP props | 185 | 2.96 | 384 | 18/22 | 80 | **3,410,000** | 11,700 | 21,579 | 214 | 3.1 | 449 |
| `pctc7000` | Car carrier PCTC 7,000 CEU (LNG DF) | 200×38×10 | 18,000 | 70,000 | 7,000 cars, 12 decks | 20/18.5 | 14,000 · 1x LS 2-stroke DF | 165 | 2.31 | 1,231 | 20/24 | 95 | **4,490,000** | 16,200 | 45,338 | 323 | 3 | 727 |
| **ferry** |||||||||||||||||||
| `ferry50` | Double-ended island ferry 50 m | 50×13.5×3 | 250 | 800 | 250 pax, 40 cars | 11.5/10 | 1,200 · 2x diesel-electric + battery | 205 | 0.246 | 7.6 | 5/7 | 14 | **459,000** | 150 | 1,107 | 43 | 8.5 | 136 |
| `ferry` ⓛ | RoPax ferry 120 m (legacy) | 120×22×6 | 3,000 | 10,000 | 400 pax, 900 lane m | 22/19 | 13,000 · 2x MS diesel | 190 | 2.6 | 200 | 25/35 | 60 | **700,000** | 500 | 9,000 | 150 | 4.4 | — |
| `hsc112` | High-speed catamaran 112 m | 112×30.5×3.9 | 900 | 10,800 | 1,000 pax, 200 cars | 37/35 | 36,400 · 4x HS diesel, waterjets | 205 | 7.462 | 79 | 22/30 | 110 | **2,550,000** | 500 | 2,800 | 218 | 4.7 | 276 |
| `ropax200` | Cruise ferry / ro-pax 200 m | 200×31×6.8 | 7,000 | 50,000 | 1,800 pax, 2,800 lane m | 24/22 | 32,000 · 4x MS diesel (LNG DF) | 185 | 5.92 | 497 | 80/120 | 210 | **3,810,000** | 7,000 | 25,151 | 579 | 3 | 371 |
| **cruise** |||||||||||||||||||
| `expedition105` | Polar expedition cruise ship 105 m (PC6) | 104.4×18×5.3 | 1,000 | 12,500 | 200 guests | 15/13 | 8,000 · DE gensets + battery, azipods | 195 | 1.56 | 591 | 100/120 | 140 | **3,000,000** | 500 | 6,140 | 418 | 4.9 | 141 |
| `cruise230` | Mid-size cruise ship 230 m | 230×28×7 | 6,000 | 55,000 | 1,250 guests | 21/19 | 25,000 · DE gensets, pods | 195 | 4.875 | 1,264 | 520/600 | 450 | **7,810,000** | 3,000 | 29,582 | 1319 | 2.7 | 354 |
| `cruise330` | Large cruise ship 330 m (LNG) | 330×42×8.8 | 11,000 | 180,000 | 4,000 guests | 22/19 | 62,000 · DE LNG DF gensets, pods | 185 | 11.47 | 2,975 | 1300/1500 | 1200 | **22,200,000** | 5,500 | 80,036 | 3129 | 2.1 | 319 |
| `cruise362` | Mega cruise ship 362 m | 362×47×9.3 | 15,000 | 236,000 | 6,700 guests | 22/20 | 97,000 · DE gensets, 3 pods | 195 | 18.915 | 4,661 | 2100/2300 | 1500 | **35,400,000** | 7,500 | 103,831 | 4515 | 1.9 | 243 |
| **special** |||||||||||||||||||
| `research75` | Oceanographic research vessel 75 m | 75×18×5.6 | 2,000 | 5,000 | 30 scientists, labs, A-frame | 14/12 | 6,000 · DE gensets, DP2, ice 1A | 190 | 1.14 | 702 | 18/22 | 90 | **2,260,000** | 500 | 4,510 | 145 | 6.3 | 125 |
| `icebreaker120` | Polar research icebreaker 128 m (PC3) | 128×24×8 | 4,000 | 15,000 | helideck, moon pool | 16/13 | 20,000 · DE gensets, 2 azipods | 195 | 3.9 | 3,696 | 35/45 | 340 | **7,490,000** | 1,500 | 14,661 | 348 | 4.2 | 123 |
| `tshd100` | Trailing suction hopper dredger 100 m | 100×21×7 | 8,000 | 5,500 | hopper 5,000 m³ | 13/12 | 8,000 · DE gensets (propulsion + dredge pumps) | 195 | 1.56 | 481 | 14/18 | 60 | **1,570,000** | 7,200 | 11,692 | 120 | 5.1 | 223 |
| **motor yacht** |||||||||||||||||||
| `rib8` | RIB tender / day boat 8.5 m | 8.5×2.9×0.6 | 0.5 | 3 | 8 seats | 45/35 | 336 · 2x outboard | 300 | 0.101 | 0.3 | 1/1 | 0.15 | **42,000** | 0.3 | 2.5 | 0 | 30 | 500 |
| `cruiser` ⓛ | Sports cruiser 12 m (legacy) | 12×3.8×1.1 | 1 | 15 | 6 guests | 30/24 | 600 · 2x sterndrive | 240 | 0.09 | 1.2 | 1/1 | 0.6 | **150,000** | 1 | 9 | 0 | 24.9 | — |
| `flybridge18` | Flybridge yacht 18 m | 18×5.2×1.5 | 3 | 50 | 8 guests | 32/26 | 1,800 · 2x HS diesel, shafts | 225 | 0.405 | 3.4 | 1/2 | 2.5 | **437,000** | 1 | 30 | 5 | 18.4 | 176 |
| `myacht` ⓛ | Motor yacht 24 m (legacy) | 24×6×1.8 | 8 | 100 | 10 guests | 26/21 | 2,600 · 2x HS diesel | 225 | 0.25 | 8 | 3/4 | 6 | **900,000** | 3 | 70 | 20 | 14.8 | — |
| `explorer45` | Explorer yacht 45 m (steel, ice-class) | 45×9.4×3 | 150 | 500 | 12 guests, tender crane | 15/12 | 1,500 · 2x MS diesel | 200 | 0.3 | 77 | 9/11 | 35 | **3,910,000** | 10 | 550 | 50 | 9.2 | 151 |
| `superyacht` ⓛ | Superyacht 70 m (legacy) | 70×12×3.6 | 300 | 1,800 | 24 guests | 18/15 | 4,600 · 2x MS diesel | 200 | 0.9 | 150 | 18/22 | 120 | **12,000,000** | 20 | 1,500 | 220 | 6.6 | — |
| `giga100` | Superyacht 100 m | 100×16×4.6 | 600 | 4,000 | 36 guests, helideck | 20/15 | 9,000 · 2x MS diesel + DE | 195 | 1.755 | 432 | 35/45 | 300 | **23,300,000** | 30 | 3,500 | 237 | 5.1 | 205 |
