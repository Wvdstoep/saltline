# Saltline — world economy: real products, country production, harbour markets and trade requests (design contract)

Status: **DESIGN ONLY** (2026-10-09). Nothing here is built. This contract replaces the 7-good supply/demand market of
`server/economy.js` (docs/V3-CONTRACTS.md §3, V6-QUICK-CONTRACTS.md §3, V5-WAVE2-DESIGN.md §3.10) with a production and
demand economy. It builds on the cargo taxonomy (`shared/cargo.js`, SHIPYARD contract §5.1–§5.3), the job families
(`shared/jobs/*`, `server/jobsgen.js`), world politics (`shared/politics.js`, `shared/politics/*.json`), the world market
screen and trade finder (`server/market.js`, `public/js/market.js`), captains (`server/fleet.js`, `server/captain.js`)
and the inland harbours (`server/minorharbours.js`, `shared/mharbour.js inlandMarket`).

Player request (2026-10-09, verbatim): *"a much more expanded market with products and price changes, where each country
has its own products and prices, and other countries can't get these products and request to buy them — similar to how
Anno 1800 works."*

Numbers marked **(src)** come from the public statistics listed in §21. Numbers marked **(game)** are game rules
chosen for balance. Real-world figures are **references**: they set the shape of the game and are not quotes.
They are rounded and dated.

---

## 1. What the player gets (plain words)

* **About 80 real products instead of 7.** They come in ten categories: grains and feed; fertilisers; ores and minerals;
  coal; crude oil and refined fuels; gases; chilled and frozen food; container goods (from coffee and cocoa to
  electronics and medicines); breakbulk and project cargo (steel, copper, timber, wind-turbine parts); cars and trucks;
  and live animals. Each product has its real handling type, so you need the right ship. Iron ore needs bulk holds,
  LNG needs gas tanks, bananas need reefer holds or reefer plugs, and cars need a ro-ro deck. Each product also has
  its real trade unit (t, TEU, m³, CEU, head) and a value per tonne based on real prices.
* **Every country makes what it makes in the real world.** Brazil ships iron ore, soybeans, sugar, coffee, crude and
  chicken. Australia ships iron ore, coal and LNG. Saudi Arabia ships crude and LPG. The Netherlands ships flowers,
  machinery and refined fuels. China ships electronics, steel, furniture, toys and cars. Chile ships copper. Norway
  ships salmon. Côte d'Ivoire ships cocoa. Kenya ships tea and roses. Each country's profile comes from public trade
  statistics (§5), with sources named in the data.
* **What a country does not make, it cannot sell you.** You can buy a good only at harbours whose country produces it,
  or at a harbour that has more than it needs. Importing harbours keep their stock for their own use: they buy, they
  do not sell. Coffee is bought in Santos, Vitória, Ho Chi Minh/Vũng Tàu, Buenaventura or Mombasa, and is sold in
  Rotterdam, Hamburg, Trieste and New York.
* **Harbours post requests, as in Anno.** When a harbour runs short of an import, it posts a standing request on a
  shared board, for example "Rotterdam requests 2,400 t of green coffee — +27 % over market, 18 days". Every
  skipper sees the request. You can pledge part of it, and you are paid the locked price per tonne you deliver.
* **Prices move for reasons you can see.** Prices change with harvests (Brazil's coffee crop in the southern winter,
  the northern wheat harvest in August), winter heating demand (LNG, coal and gas oil in the northern winter), holiday
  buying (toys, electronics and chocolate before December; roses before Valentine's Day), strikes, storms, and
  sanctions or port closures from world politics. Each good has a 7-day sparkline, a 30-day chart, a trend arrow and
  a one-line reason ("harvest in", "winter demand", "strike at Santos").
* **Processing chains create follow-on demand.** Steel ports need iron ore and coking coal. Refineries need crude and
  ship petrol, diesel, jet fuel, naphtha and fuel oil. Cocoa ports need cocoa beans, sugar and milk powder and ship
  chocolate. Soy crushers need beans and ship meal and oil. A steel port without ore makes less steel, so steel
  prices rise there and it posts an ore request.
* **The market screen tells a story.** Each harbour tab shows what this country makes, what it needs, the requests
  board, and price history. The world map can colour every harbour for one good: where it is made, where it is
  scarce, and where requests are open.

---

## 2. What exists today (read before building)

| Piece | Today | Kept / changed |
|---|---|---|
| `shared/constants.js GOODS` | 7 market goods (`fish 700, grain 260, steel 900, machinery 3200, containers 2100, fuel 650, supplies 1800` cr/t) + 4 contraband | **ids and bases kept** (save + test anchor); the catalogue (§4) adds about 73 goods; `GOODS` is generated from the catalogue |
| `shared/cargo.js CARGO` | 25 cargo goods with handling options, unit, tPer; `market: true` on the 7; `fallback` for the rest | rows added for new goods; `market: true` for every catalogue good; `marketGoodOf` keeps working (fallback only for job-only goods: `reefer_box`, `dg_box`, `fruit`, `spoil`) |
| `server/economy.js` | `stock`/`target` per harbour × good; `priceOf = base × local × clamp(0.55, 1.9, √(target/stock))`; drift 5 %/h to target; `COUNTRY_PROFILE` (42 countries × 7 goods); `TRADE = { SPREAD 0.02, IMPACT true, STEPS 8 }` | `priceOf` gets a new formula (§6.6); drift becomes production − consumption + AI shipping (§6.4); `COUNTRY_PROFILE` becomes the fallback for countries with no profile row; `TRADE` is unchanged (the exploit fix stays, §11) |
| `server/market.js` | snapshot of every harbour × 7 goods; hourly history 7 days (`data/market-history.json`, about 0.5 MB); trade finder with real costs; `from=all` scans the 80 nearest harbours | snapshot split per good / per harbour (§15); history in a compact binary ring (§13); finder only scans goods the origin can sell, and gains a requests mode |
| `server/game.js tradeGoods` | buy/sell at the docked harbour, capped at 5,000 t, `canLoad` check, politics `onTrade`, stacks merged by `origin` | adds the reserve rule (§6.8), the stack `src`, a fallback buyer for unlisted goods (§6.9), and request delivery (§7) |
| `shared/politics.js` | `tradeCheck` / `dutyFor` per good (legacy ids); `tariffs.json` empty; `trade.json` not yet built (`setTradeProfile` hook H5 waits for it) | measures match new goods through `polGroup` (§9.3); tariffs are added to the landed price; `trade.json` keeps feeding destination weights |
| `server/jobsgen.js` | `EXPORT_TAG`, `EXPORTERS` (crude, LNG, LPG terminals), `IMPORT_OK`; `shared/jobs/ports.js TAG_SEEDS` | exporters and importers of voyage goods come from econ roles (§9.2); tags stay for berth and family rules |
| `server/minorharbours.js` + `shared/mharbour.js inlandMarket` | inland card shows 3–5 random goods from the parent named harbour (display) | the goods are picked by role from the parent's listing; small trades go through the parent's pool (§9.6) |
| Captains | orders `sail_to, home, hold, route, contract, stop`; no market trading | new order `trade_run` (§9.5) |
| Harbours | 336 named harbours in 124 countries (30 mega, 113 major, 132 regional, 61 minor) | unchanged; every harbour country gets a profile row or a regional template (§5.4) |

---

## 3. Principles (hard rules)

| # | Rule |
|---|---|
| E1 | **Data, not code paths.** Every country, product, season, chain and site is a table row. There are no per-country `if`s (same as politics P3). |
| E2 | **Real-world grounded and labelled.** Every profile row has `src` ids and `asOf`. `basis: 'source'` means it is backed by a named statistic. `basis: 'game'` means it is a game simplification. `verify: true` means it is plausible but not yet checked against the source (shown in the debug view only, never to players). |
| E3 | **Scarcity is real.** A harbour whose country does not produce a good never generates it. Its stock comes only from deliveries: players, captains, and the abstract AI shipping term. |
| E4 | **No money printers.** Any loop of buy and sell actions that starts and ends at the same harbour, or between harbours with no sea passage between them, loses money (§11). Tests prove it. |
| E5 | **Compact.** Only listed goods have state (about 28 per harbour on average, at most 32). Derived numbers live in typed arrays and are not saved. History is quantised to 16 bits (§13). |
| E6 | **Legacy ids are permanent.** `fish, grain, steel, machinery, containers, fuel, supplies` keep their ids and bases. Every cargo stack, contract and save that uses them keeps working. |
| E7 | **Pure rules shared by server and client.** Price, flow, season, request and chain formulas live in `shared/econ/model.js` (browser-safe, no I/O). The server is the authority, and the client uses the same code for previews. |
| E8 | **Plain words in the UI.** The UI uses no economics jargon: "Made here", "Needed here", "Short", "Glut", "Harvest in", "Winter demand", "Request". |

---

## 4. Product catalogue (`shared/econ/catalogue.js`)

### 4.1 Row shape

```js
{ id, name, cat, unit, tPer, refUsdT, base, S, fmul, perishH, hs, polGroup, icon, legacy? }
```

* `id`: the CARGO id. A good that already has a cargo row uses that id (`ore`, `coal`, `crude`, `chemicals`, `lpg`,
  `lng`, `vehicles`, `trailers`, `livestock`, `project`, `fish`, `supplies`).
* `unit`, `tPer`: same meaning as `shared/cargo.js` (§5.1). **The economy runs in tonnes**: stock, price and quotes
  are per tonne. Units are a display and hold-fit layer: the UI shows "cr/TEU", "cr/m³", "cr/CEU" or "cr/head" as
  `price × tPer`, and the buy dialog fits the quantity with `freeUnits(vessel, unit)`.
* `refUsdT`: the real reference value in USD per tonne (approximate, 2024–25 levels, §21).
* `base`: the game base in cr/t. **Rule:** `base = refUsdT` when `refUsdT ≤ 1,000`, else
  `round(1,000 × √(refUsdT / 1,000))`, capped at 8,000. The 7 legacy goods keep their bases (E6). The rule
  compresses high values so that a hold of electronics is not worth 40 holds of grain.
* `S`: price swing amplitude (§6.6). Volatile perishables and commodities have a high S; manufactured goods have a low S.
* `fmul`: freight multiplier for the landed price (§6.6). It matches the job pay multipliers in
  `shared/jobs/catalogue.js PAY.GOOD_MUL / BOX_MUL / REEFER_MUL / VEHICLE_MUL / PROJECT_MUL`, so trading and
  contracts pay on the same scale.
* `perishH`: hours before a reefer or livestock stack loses value. It is `null` for most goods. Spoilage (open
  question Q4, default OFF) is a hook only.
* `hs`: HS codes for the BACI build script (§5.5).
* `polGroup`: the legacy good that politics measures and tariffs match until they list the new id (§9.3).

### 4.2 The catalogue (80 goods)

Handling uses the `shared/cargo.js HANDLING` keys. `S` and `fmul` are the game's values.

**Grains, feed, softs in bulk (11)**

| id | name | handling (opts) | unit | ref USD/t | base | S | fmul | polGroup |
|---|---|---|---|---|---|---|---|---|
| `grain` *(legacy)* | Wheat | bulk | t | 230 | **260** | 0.35 | 0.75 | grain |
| `maize` | Maize (corn) | bulk | t | 200 | 200 | 0.35 | 0.75 | grain |
| `soybeans` | Soybeans | bulk | t | 400 | 400 | 0.30 | 0.75 | grain |
| `rice` | Rice | bulk, box | t | 480 | 480 | 0.30 | 0.75 | grain |
| `barley` | Barley | bulk | t | 220 | 220 | 0.35 | 0.75 | grain |
| `sugar` | Raw sugar | bulk | t | 440 | 440 | 0.35 | 0.75 | grain |
| `soymeal` | Soybean meal | bulk | t | 330 | 330 | 0.30 | 0.75 | grain |
| `urea` | Urea fertiliser | bulk | t | 350 | 350 | 0.35 | 0.75 | grain |
| `potash` | Potash | bulk | t | 300 | 300 | 0.25 | 0.6 | grain |
| `phosphate` | Phosphate rock | bulk | t | 150 | 150 | 0.25 | 0.5 | grain |
| `pellets` | Wood pellets | bulk | t | 200 | 200 | 0.25 | 0.6 | grain |

**Ores, minerals, coal (10)**

| id | name | handling | unit | ref | base | S | fmul | polGroup |
|---|---|---|---|---|---|---|---|---|
| `ore` | Iron ore | bulk | t | 100 | 100 | 0.35 | 0.5 | steel |
| `coal` | Thermal coal | bulk | t | 120 | 120 | 0.40 | 0.6 | fuel |
| `cokingcoal` | Coking coal | bulk | t | 220 | 220 | 0.40 | 0.6 | steel |
| `bauxite` | Bauxite | bulk | t | 70 | 70 | 0.25 | 0.5 | steel |
| `alumina` | Alumina | bulk | t | 450 | 450 | 0.35 | 0.6 | steel |
| `copperconc` | Copper concentrate | bulk | t | 2,500 | 1,581 | 0.30 | 0.6 | steel |
| `nickelore` | Nickel ore | bulk | t | 50 | 50 | 0.30 | 0.5 | steel |
| `manganese` | Manganese ore | bulk | t | 200 | 200 | 0.30 | 0.5 | steel |
| `clinker` | Cement clinker | bulk | t | 50 | 50 | 0.20 | 0.5 | steel |
| `salt` | Salt | bulk | t | 50 | 50 | 0.15 | 0.5 | grain |

**Crude, refined fuels, liquid chemicals and oils (11)**

| id | name | handling | unit | ref | base | S | fmul | polGroup |
|---|---|---|---|---|---|---|---|---|
| `crude` | Crude oil | liquid:crude | t | 550 | 550 | 0.30 | 0.55 | fuel |
| `fuel` *(legacy)* | Gas oil / diesel (bunker grade) | liquid:clean | t | 700 | **650** | 0.10 | 0.75 | fuel |
| `gasoline` | Petrol | liquid:clean | t | 750 | 750 | 0.25 | 0.75 | fuel |
| `jet` | Jet fuel | liquid:clean | t | 720 | 720 | 0.25 | 0.75 | fuel |
| `naphtha` | Naphtha | liquid:clean | t | 650 | 650 | 0.25 | 0.75 | fuel |
| `fueloil` | Heavy fuel oil | liquid:crude, liquid:clean | t | 450 | 450 | 0.25 | 0.6 | fuel |
| `chemicals` | Bulk chemicals | liquid:chem | t | 900 | 900 | 0.20 | 1.2 | fuel |
| `methanol` | Methanol | liquid:chem | t | 350 | 350 | 0.25 | 1.2 | fuel |
| `palmoil` | Palm oil | liquid:chem, liquid:clean | t | 950 | 950 | 0.30 | 1.0 | grain |
| `vegoil` | Vegetable oils (soy, sunflower, rapeseed) | liquid:chem, liquid:clean | t | 1,000 | 1,000 | 0.30 | 1.0 | grain |
| `ethanol` | Ethanol | liquid:chem | t | 600 | 600 | 0.25 | 1.2 | fuel |

The `fuel` swing is held at S 0.10 because the bunker price (`game.fuelPrice`) reads `market.fuel`. Running costs
must stay predictable (§10).

**Gases (3)**

| id | name | handling | unit | tPer | ref | base | S | fmul | polGroup |
|---|---|---|---|---|---|---|---|---|---|
| `lng` | LNG | gas:lng | m³ | 0.45 | 570 | 570 | 0.40 | 1.8 | fuel |
| `lpg` | LPG | gas:lpg | m³ | 0.55 | 600 | 600 | 0.35 | 1.4 | fuel |
| `ammonia` | Ammonia | gas:lpg | m³ | 0.68 | 400 | 400 | 0.35 | 1.4 | fuel |

**Chilled and frozen food, flowers (13)** — handling `reefer`, or `box` with plugs (one plug per 14 t, the `reefer_box`
rule). `fish` keeps `fish, reefer, breakbulk`.

| id | name | ref | base | S | fmul | polGroup |
|---|---|---|---|---|---|---|
| `fish` *(legacy)* | Fish (pelagic and whitefish, landed) | 1,000 | **700** | 0.30 | 1.6 | fish |
| `salmon` | Salmon (fresh/frozen) | 8,000 | 2,828 | 0.35 | 1.6 | fish |
| `shrimp` | Shrimp (frozen) | 8,000 | 2,828 | 0.30 | 1.6 | fish |
| `tuna` | Tuna (frozen) | 1,700 | 1,304 | 0.30 | 1.6 | fish |
| `bananas` | Bananas | 1,100 | 1,049 | 0.40 | 1.6 | grain |
| `citrus` | Citrus fruit | 900 | 900 | 0.45 | 1.6 | grain |
| `apples` | Apples, pears and grapes | 1,100 | 1,049 | 0.40 | 1.6 | grain |
| `avocados` | Avocados | 2,500 | 1,581 | 0.45 | 1.6 | grain |
| `beef` | Beef (frozen) | 5,000 | 2,236 | 0.30 | 1.6 | grain |
| `pork` | Pork (frozen) | 2,500 | 1,581 | 0.30 | 1.6 | grain |
| `poultry` | Poultry (frozen) | 2,000 | 1,414 | 0.30 | 1.6 | grain |
| `cheese` | Cheese and butter | 4,500 | 2,121 | 0.20 | 1.6 | grain |
| `flowers` | Cut flowers | 6,000 | 2,449 | 0.50 | 1.6 | grain |

**Container goods (17)** — handling `box` (TEU, 12 t per TEU), plus `breakbulk` where noted.

| id | name | ref | base | S | fmul | polGroup |
|---|---|---|---|---|---|---|
| `containers` *(legacy)* | Mixed consumer goods | 6,000 | **2,100** | 0.12 | 1.3 | containers |
| `electronics` | Electronics | 40,000 | 6,325 | 0.12 | 1.3 | machinery |
| `garments` | Clothing and footwear | 15,000 | 3,873 | 0.15 | 1.3 | containers |
| `furniture` | Furniture | 3,000 | 1,732 | 0.12 | 1.3 | containers |
| `toys` | Toys and games | 8,000 | 2,828 | 0.15 | 1.3 | containers |
| `coffee` | Green coffee | 5,500 | 2,345 | 0.15 | 1.3 | grain |
| `cocoa` | Cocoa beans | 7,000 | 2,646 | 0.20 | 1.3 | grain |
| `tea` | Tea | 3,000 | 1,732 | 0.15 | 1.3 | grain |
| `cotton` | Raw cotton (box, breakbulk) | 1,600 | 1,265 | 0.20 | 1.3 | grain |
| `rubber` | Natural rubber (box, breakbulk) | 1,800 | 1,342 | 0.25 | 1.3 | containers |
| `wine` | Wine | 4,000 | 2,000 | 0.15 | 1.3 | containers |
| `spirits` | Whisky, cognac and rum | 12,000 | 3,464 | 0.12 | 1.3 | containers |
| `chocolate` | Chocolate | 9,000 | 3,000 | 0.15 | 1.3 | containers |
| `pharma` | Medicines | 60,000 | 7,746 | 0.10 | 1.3 | machinery |
| `autoparts` | Car parts | 8,000 | 2,828 | 0.12 | 1.3 | machinery |
| `polymers` | Plastics (polymer pellets) | 1,100 | 1,049 | 0.20 | 1.3 | containers |
| `milkpowder` | Milk powder | 3,500 | 1,871 | 0.20 | 1.3 | grain |

**Breakbulk and project cargo (9)**

| id | name | handling | ref | base | S | fmul | polGroup |
|---|---|---|---|---|---|---|---|
| `steel` *(legacy)* | Steel coils | breakbulk, bulk | 650 | **900** | 0.25 | 1.0 | steel |
| `pipes` | Steel pipe and sections | breakbulk | 1,200 | 1,095 | 0.20 | 1.0 | steel |
| `copper` | Copper cathode | breakbulk, box | 9,500 | 3,082 | 0.20 | 1.0 | steel |
| `aluminium` | Aluminium ingots | breakbulk, box | 2,500 | 1,581 | 0.20 | 1.0 | steel |
| `lumber` | Sawn timber | breakbulk | 450 | 450 | 0.25 | 1.0 | containers |
| `logs` | Logs | breakbulk, bulk | 150 | 150 | 0.25 | 0.75 | containers |
| `pulp` | Wood pulp | breakbulk | 700 | 700 | 0.25 | 1.0 | containers |
| `machinery` *(legacy)* | Machinery | breakbulk, box | 10,000 | **3,200** | 0.10 | 1.0 | machinery |
| `project` | Project cargo (transformers, turbine parts) | heavy | 16,000 | 4,000 | 0.10 | 2.5 | machinery |

**Vehicles (3)**

| id | name | handling | unit | tPer | ref | base | S | fmul | polGroup |
|---|---|---|---|---|---|---|---|---|---|
| `vehicles` | New cars | roro | ceu | 1.5 | 20,000 | 4,472 | 0.12 | 1.6 | machinery |
| `trailers` | Trucks and trailers | roro | lm | 2.2 | 5,000 | 2,236 | 0.12 | 1.6 | machinery |
| `tractors` | Farm and construction machines | roro, heavy | ceu | 4.0 | 8,000 | 2,828 | 0.12 | 1.6 | machinery |

**Live animals (2)**

| id | name | handling | unit | tPer | ref | base | S | fmul | polGroup |
|---|---|---|---|---|---|---|---|---|---|
| `livestock` | Live cattle | livestock | head | 0.5 | 2,700 | 1,643 | 0.25 | 1.8 | grain |
| `sheep` | Live sheep | livestock | head | 0.05 | 3,000 | 1,732 | 0.25 | 1.8 | grain |

**Offshore (1)**: `supplies` *(legacy)* Offshore supplies, deck/breakbulk, base **1,800**, S 0.10, fmul 1.0.

Total: 11 + 10 + 11 + 3 + 13 + 17 + 9 + 3 + 2 + 1 = **80 market goods**, plus the 4 contraband goods (unchanged,
not on markets). Job-only cargo ids stay as they are: `reefer_box`, `dg_box`, `fruit` (its `fallback` becomes
`bananas`), and `spoil`.

### 4.3 Categories (`CATS`, display order and icon)

`grains` (wheat ear), `fert` (sack), `ores` (rock), `energy` (drop), `gas` (flame), `reefer` (snowflake), `box`
(container), `breakbulk` (girder), `vehicles` (car), `animals` (cow), `offshore` (rig). The client maps these in
`public/js/icons.js` `CAT_ICON`. A good with no own icon uses its category icon.

---

## 5. Country production and demand profiles

### 5.1 Data (`shared/econ/countries.json`, browser-safe, ≤ 60 KB)

```js
{ "BR": { "make": { "ore": 1, "soybeans": 1, "crude": 1, "sugar": 1, "coffee": 1, "poultry": 1, "beef": 1, "soymeal": 1,
                    "pulp": 1, "maize": 2, "cotton": 2, "citrus": 2, "ethanol": 2, "steel": 3, "vehicles": 3 },
          "need": { "urea": 1, "potash": 1, "fuel": 2, "grain": 2, "electronics": 2, "machinery": 2, "lng": 3 },
          "src": ["mdic-2024", "datamar-2025", "oec-bra"], "asOf": "2026-10-09", "basis": "source", "verify": false },
  … }
```

* `make[good] = tier`. Tier 1 is a top world exporter (about ≥ 10 % of world exports, or a top-3 exporter). Tier 2
  is a significant exporter (3–10 %). Tier 3 is a minor but real exporter (1–3 %, or exports exceed imports).
* `need[good] = tier`. Tier 1 is a major importer (≥ 5 % of world imports, or the good is essential and not produced).
  Tier 2 is a regular importer. Tier 3 is a small or seasonal importer.
* A good in both `make` and `need` is a contradiction, and the validator rejects it. Re-export hubs use `hub` (§5.3).
* `sites`: processing sites are in `shared/econ/sites.json` (§8.2), not here.

### 5.2 Seed table (the main producers; the full file covers all 124 harbour countries)

Tiers are shown as `good¹ good² good³`. Sources are listed in §21. Rows marked † are `verify: true` (plausible, not yet
checked against the cited statistic).

| cc | Makes (export specialisation) | Needs (imports) | Key sources |
|---|---|---|---|
| **AU** | ore¹ coal¹ cokingcoal¹ lng¹ grain¹ bauxite¹ alumina¹ beef² livestock² sheep² barley² manganese² wine³ | fuel¹ vehicles¹ electronics¹ garments² machinery² containers² | DISR REQ 2024 (iron ore ≈ A$141 bn 2023/24; mineral resources 59 % of exports); IGU 2025 (LNG 81.0 Mt, 2nd) |
| **BR** | ore¹ soybeans¹ crude¹ sugar¹ coffee¹ poultry¹ beef¹ soymeal¹ pulp¹ cotton² maize² citrus² ethanol² steel³ vehicles³ | urea¹ potash¹ fuel² grain² electronics² machinery² | MDIC/Datamar 2024 (crude ≈ US$ 44.8 bn, first time top; soybeans ≈ US$ 43 bn); TradeInt (ores ≈ US$ 35 bn) |
| **CN** | electronics¹ garments¹ furniture¹ toys¹ containers¹ steel¹ pipes¹ machinery¹ vehicles¹ autoparts² aluminium² tea² polymers³ | ore¹ soybeans¹ crude¹ lng¹ copperconc¹ bauxite¹ nickelore¹ manganese¹ cokingcoal² coal² logs² pulp² beef² barley² lpg² maize³ | OEC/BACI †, USGS MCS 2025 |
| **US** | lng¹ soybeans¹ maize¹ crude¹ lpg¹ fuel¹ gasoline¹ ethanol¹ cotton¹ polymers¹ pellets¹ grain² poultry² cokingcoal² pharma² machinery² pork² | vehicles¹ electronics¹ garments¹ furniture¹ toys¹ coffee¹ bananas¹ avocados¹ shrimp¹ wine² spirits² salmon² pharma³ | IGU 2025 (LNG 88.4 Mt, 21.5 %, top exporter); EIA 2025 |
| **SA** | crude¹ lpg¹ polymers¹ fuel² methanol² urea² | barley¹ rice¹ poultry¹ sheep¹ vehicles¹ machinery² electronics² containers² | OEC †, JODI † |
| **QA** | lng¹ lpg¹ urea² polymers² | grain¹ rice¹ poultry¹ vehicles¹ containers¹ | IGU 2025 (77.2 Mt, 3rd) |
| **AE** | crude¹ aluminium¹ fuel² | grain¹ rice¹ poultry¹ vehicles¹ electronics² machinery² | EGA annual report † |
| **NL** | flowers¹ machinery¹ fuel¹ cheese² chocolate² polymers² pharma³ | coffee¹ cocoa¹ crude¹ soybeans² bananas² palmoil² ore² cokingcoal² electronics² garments² | Trend Economy HS 0603 (NL ≈ 47 % of world cut-flower exports 2023); CBS † |
| **DE** | vehicles¹ machinery¹ pharma¹ autoparts¹ chemicals¹ steel² polymers² pork² | crude¹ lng¹ coffee¹ ore¹ cokingcoal¹ garments¹ electronics¹ cocoa² bananas² | Destatis † |
| **NO** | salmon¹ crude¹ lng¹ fish¹ aluminium² | vehicles¹ electronics² grain² bananas² citrus² garments² steel² | NSC 2025 (salmon NOK 122.9 bn, 1.26 Mt, record 2024); Equinor † |
| **CL** | copper¹ copperconc¹ salmon¹ wine¹ pulp¹ avocados² apples² lumber² fish³ | crude¹ fuel¹ vehicles¹ electronics² beef² grain² | USGS 2025 (Chile ≈ 24 % of mined copper 2024, #1) |
| **PE** | copperconc¹ fish¹ avocados¹ citrus² coffee³ | fuel¹ grain¹ vehicles² soymeal² | USGS †, ProHass † |
| **CI** | cocoa¹ rubber¹ bananas² palmoil³ coffee³ crude³ | rice¹ fuel¹ grain² fish² vehicles² machinery² | Statista/ICCO (≈ ⅓ – 45 % of world cocoa) |
| **GH** | cocoa¹ crude² | rice¹ fuel¹ poultry¹ grain² vehicles² | ICCO † (2nd, ≈ 15–20 %) |
| **ID** | coal¹ palmoil¹ rubber² coffee² lng² garments² shrimp³ cocoa³ | grain¹ fuel¹ sugar¹ soybeans² crude² machinery² | MPOB/S&P (ID + MY ≈ 85 % of palm-oil trade); IEA coal † |
| **MY** | palmoil¹ lng¹ electronics¹ rubber² polymers² | grain¹ rice² beef² vehicles² | MPOB/S&P (MY ≈ 23 % production, 30 % exports) |
| **VN** | electronics¹ garments¹ coffee¹ rice¹ furniture¹ shrimp² | cotton¹ polymers¹ fuel¹ machinery² steel² | ICO † (robusta #1) |
| **TH** | rice¹ sugar¹ rubber¹ tuna¹ vehicles² electronics² poultry² | crude¹ lng² machinery² | USDA † |
| **IN** | rice¹ pharma¹ fuel¹ shrimp¹ garments² steel² tea² sugar² aluminium² cotton³ ore³ | crude¹ coal¹ cokingcoal¹ lng¹ palmoil¹ vegoil¹ urea¹ potash¹ lpg¹ electronics¹ machinery² | USDA †, PPAC † |
| **RU** | crude¹ fuel¹ grain¹ coal¹ urea¹ potash¹ lumber² logs² fish² steel² aluminium² lng² vegoil² | vehicles¹ electronics¹ machinery¹ bananas¹ citrus² garments² pharma² coffee² | USDA (wheat #1 exporter) †; trade under sanctions (§9.3) |
| **UA** | maize¹ grain¹ vegoil¹ barley² ore² steel³ | fuel¹ vehicles² machinery² electronics² | USDA † (sunflower oil #1) |
| **AR** | soymeal¹ vegoil¹ maize¹ beef¹ grain² barley² shrimp² wine³ | fuel² lng² vehicles² electronics² machinery² | USDA † (soymeal/soy oil #1) |
| **CA** | potash¹ lumber¹ pulp¹ grain¹ vegoil¹ cokingcoal¹ crude² fish² aluminium² lng³ | bananas¹ citrus¹ garments¹ electronics¹ coffee² | NRCan †, USGS † (potash #1) |
| **JP** | vehicles¹ machinery¹ autoparts¹ steel¹ electronics² spirits³ | crude¹ lng¹ coal¹ ore¹ cokingcoal¹ grain¹ maize¹ beef¹ bananas¹ copperconc¹ garments¹ salmon² shrimp² soybeans² logs² | IGU 2025 † (top-2 LNG importer) |
| **KR** | vehicles¹ electronics¹ steel¹ polymers¹ fuel¹ autoparts¹ machinery² | crude¹ lng¹ coal¹ cokingcoal¹ ore¹ maize¹ grain¹ beef² | KITA † |
| **GB** | spirits¹ pharma² machinery² vehicles² salmon² fish² crude³ | wine¹ bananas¹ garments¹ electronics¹ lumber¹ citrus² lng² fuel² steel² | SWA † (Scotch) |
| **FR** | wine¹ spirits¹ grain¹ barley¹ cheese² pharma² machinery² vehicles³ | crude¹ coffee¹ electronics¹ garments¹ lng² bananas² fuel² cocoa³ | FranceAgriMer † |
| **IT** | machinery¹ wine¹ cheese² pharma² furniture² garments² | crude¹ lng¹ coffee¹ grain² ore² | ISTAT † |
| **ES** | citrus¹ vehicles¹ vegoil¹ pork¹ wine² fish³ | crude¹ lng¹ soybeans¹ maize¹ coffee² | ICEX † (citrus #1 fresh exporter) |
| **BE** | pharma¹ chocolate¹ polymers² chemicals² | crude¹ lng² cocoa² coffee² | NBB † |
| **DK** | pork¹ fish¹ project¹ pharma² cheese³ | fuel² vehicles² electronics² | DST † (wind blades and nacelles from Esbjerg) |
| **EG** | citrus¹ urea¹ lng³ | grain¹ maize¹ vegoil¹ vehicles² beef² fuel² | USDA † (largest wheat importer; largest orange exporter) |
| **MA** | phosphate¹ vehicles¹ citrus² fish² | fuel¹ grain¹ lpg² | OCP †, USGS † |
| **ZA** | coal¹ manganese¹ citrus¹ ore² vehicles² wine² apples² | fuel¹ rice¹ grain² electronics² poultry² | USGS † (manganese #1) |
| **NG** | crude¹ lng¹ urea³ | fuel¹ grain¹ rice² vehicles² machinery² electronics² | IGU † |
| **KE** | tea¹ flowers¹ avocados² coffee³ | fuel¹ grain¹ palmoil¹ vehicles² steel² | KFC †, Tea Board † |
| **TW** | electronics¹ polymers² machinery² steel³ | crude¹ lng¹ coal¹ ore¹ soybeans¹ maize¹ grain² | MOF † |
| **SG** | fuel¹ polymers¹ electronics² pharma² chemicals² | crude¹ grain¹ rice¹ poultry¹ vehicles² (hub) | EDB † |
| **PH** | nickelore¹ bananas¹ electronics¹ copper³ | rice¹ grain¹ fuel¹ coal² pork² poultry² | USGS † (largest nickel-ore exporter; Indonesia bans raw ore export since 2020) |
| **NZ** | milkpowder¹ cheese¹ logs¹ apples² beef² sheep³ | fuel¹ vehicles¹ electronics² machinery² | Stats NZ † |
| **MX** | vehicles¹ avocados¹ autoparts¹ crude² electronics² spirits² machinery² | maize¹ fuel¹ lpg¹ pork¹ soybeans² poultry² | INEGI † |
| **CO** | coffee¹ flowers¹ coal¹ crude² bananas² avocados³ | maize¹ grain² soymeal² fuel² vehicles² | Trend Economy (cut flowers #2, ≈ 20 %) |
| **EC** | bananas¹ shrimp¹ cocoa² crude² tuna² flowers² | fuel¹ grain² vehicles² | Banco Central †, ICCO † |
| **CR / GT / HN** | bananas¹ coffee² sugar² (GT) palmoil² (GT) | fuel¹ grain¹ maize² | FAO † |
| **TT** | ammonia¹ methanol¹ lng¹ | grain¹ rice² vehicles² | †, Atlantic LNG |
| **JM** | bauxite¹ alumina¹ | fuel¹ grain¹ | USGS † |
| **MR** | ore¹ fish¹ | grain¹ fuel¹ rice¹ | SNIM † |
| **SO / SD** | sheep¹ livestock² cotton³ (SD) | grain¹ fuel¹ rice¹ | FAO † |
| **IR** | crude¹ methanol¹ polymers² urea² | grain¹ maize¹ soymeal¹ vegoil¹ (sanctions §9.3) | † |
| **OM / KW / IQ / BH** | crude¹ (OM KW IQ) lng² (OM) urea² (OM) methanol² (OM) aluminium¹ (BH) fuel² (KW) | grain¹ rice¹ poultry¹ vehicles¹ | † |
| **JO** | phosphate¹ potash¹ | grain¹ fuel¹ | † (Aqaba) |
| **PK / BD / KH** | garments¹ rice² (PK) cotton³ (PK) | cotton¹ grain¹ lng¹ palmoil¹ fuel¹ | BGMEA †, PBS † |
| **LK** | tea¹ garments² rubber³ | fuel¹ grain¹ sugar¹ | Tea Board † |
| **IE** | pharma¹ beef² cheese² milkpowder² spirits³ | fuel¹ grain² electronics² | CSO † |
| **SE / FI** | lumber¹ pulp¹ ore¹ (SE) machinery² steel³ vehicles³ (SE) | crude¹ fuel² bananas² electronics² | † (LKAB: Luleå, Narvik) |
| **PL** | furniture¹ poultry¹ machinery³ | crude¹ lng² soymeal² | GUS † |
| **TR** | garments¹ steel¹ vehicles² citrus² furniture³ | ore¹ coal¹ crude¹ lng¹ vegoil¹ grain¹ cotton² soybeans² | TÜİK † |
| **LV / EE / LT** | pellets¹ lumber² fuel² (LT) | crude² lng² fuel² | † |
| **RO / BG** | maize¹ (RO) grain² vegoil² | fuel¹ electronics² | † |
| **GR** | fish² fuel² vegoil³ | crude¹ lng² grain² | † |
| **DZ** | lng¹ crude² lpg² urea³ | grain¹ milkpowder¹ vegoil¹ | † |
| **UY** | beef¹ pulp¹ soybeans² rice² milkpowder² | fuel¹ vehicles² | Uruguay XXI † |
| **PR** | pharma¹ | fuel¹ grain¹ (US customs, §9.3) | † |
| **GA / CG / CM** | manganese¹ (GA) lumber¹ (GA, log export ban since 2010) crude¹ (CG) crude² (GA) logs² (CG CM) cocoa² (CM) | grain¹ fuel¹ rice¹ | † |
| **NC** | nickelore¹ | fuel¹ grain¹ vehicles² | USGS † |
| **SC / MV / FJ / PF / WS** | tuna¹ (SC) tuna² (MV) sugar³ (FJ) fish³ | fuel¹ grain¹ rice¹ containers¹ poultry² | † |
| **FO / IS / GL / FK** | salmon¹ (FO) fish¹ aluminium¹ (IS) | fuel¹ grain¹ vehicles² containers² | † |
| **VE / GY** | crude¹ | grain¹ fuel¹ vehicles² | † (VE under sanctions) |
| **CU** | sugar³ spirits³ | fuel¹ grain¹ rice¹ poultry¹ (sanctions) | † |
| **MZ / TZ / MG / MU / NA / AO / BJ / TG / LR / SL / SN / CV / DJ** | coal¹ aluminium² (MZ) crude¹ (AO) ore³ (LR SL) rubber² (LR) fish² (NA SN) sugar³ (MU) | fuel¹ grain¹ rice¹ vehicles² | † |
| **HK / PA / BS / GI / MT / CY / LB / IL / HR / CW / DO / MQ / BN / TL / PG / MM / YE** | HK PA BS GI MT: `hub` (§5.3); IL pharma² electronics³; BN lng²; PG lng² logs²; DO bananas³; MQ bananas²; MM rice³ | per regional template (§5.4) | † |

Facts used in the table (all labelled in `sources.json`): Australia's live sheep export by sea ends on 1 May 2028
(Export Control Amendment, 2024). `sheep²` is kept for AU, and `until: "2028-05-01"` is set on that row
(`isActive` from politics). Indonesia's raw nickel-ore export ban (2020) is why `nickelore` comes from PH and NC.
Gabon's log export ban (2010) is why GA has `lumber`, not `logs`.

### 5.3 Hubs

`hub: ["containers", "electronics", "garments", "fuel", …]` (HK, SG, PA, BS, GI, MT, NL for `fuel`, AE for
`containers`). A hub good has role `L` (balanced, §6.1) with stock ×1.5. Hubs neither make nor need the good, but
they trade it both ways. This keeps the real transhipment ports useful without letting them out-produce makers.

### 5.4 Regional templates (countries with no row, and every listed staple)

`shared/econ/countries.json` `"_templates"` gives each `region` a default needs list, and every country row names its
`region`. Regions: `eu, med, mena, ssa, sasia, easia, sea, oceania_island, latam, nam, arctic`. Example:
`oceania_island: need { fuel:1, grain:1, rice:2, containers:1, vehicles:2, poultry:2, machinery:3 }, make { fish:3 }`.
Each country always gets the **staples** if no row mentions them: `fuel` (every harbour, because the bunker price
reads it), `containers`, `machinery`, `steel`, `grain` and `fish`. Each staple is `need³` unless the country makes it.
`supplies` is listed only within 450 km of a platform (as `platformsFor`), with role `L`.

### 5.5 Refresh script (`scripts/econ/build-profiles.mjs`, optional, maintainer-run)

The script uses the same input as politics' `build-trade.mjs`: a CEPII BACI CSV (HS6 bilateral flows, harmonised from
UN Comtrade). It streams the file and maps HS codes to goods through `catalogue.hs`. It derives tiers as follows:

* `make` tier 1: world export share ≥ 10 % or exporter rank ≤ 3. Tier 2: 3–10 %. Tier 3: 1–3 % with exports > imports.
* `need` tier 1: world import share ≥ 5 %. Tier 2: 2–5 %. Tier 3: net importer otherwise.

It writes a diff against `countries.json`, and never overwrites hand rows with `basis: 'source'` without
`--force`. The seed file is hand-curated today. Running the script is follow-up work and is not needed for the first
release.

---

## 6. Harbour markets

### 6.1 Roles and listing

For each harbour `h` and good `g`, `roleOf(ds, h, g)` returns:

| role | when | b (balance) | buyable above (reserve) | stock × |
|---|---|---|---|---|
| `P` (made here) | country `make[g]` and the harbour exports it (§6.2) | tier 1 → **+1.0**, tier 2 → **+0.75**, tier 3 → **+0.5** | 0.2 n | 1.5 |
| `L` (traded) | hub good, a staple the country neither makes nor needs, `supplies` | **0** | 0.6 n | 1.0 |
| `I` (needed here) | country `need[g]`, or a chain input at a site (§8) | tier 1 → **−0.6**, tier 2 → **−0.45**, tier 3 → **−0.3**; site input → **−0.45** | 1.0 n (sells only its surplus) | 0.7 |
| `null` (not listed) | everything else | — | not buyable | — |

**Listing** is every good with a role, sorted by category and then id. It holds at most **32** goods. When there are
more, the good with the smallest `|b| × base` is dropped first, but the 7 legacy goods and the chain goods are never
dropped. An average harbour lists about 28 goods: 336 × 28 ≈ 9,400 market rows worldwide.

### 6.2 Which harbours of a producing country export a good

Not every harbour of Brazil ships iron ore. A `P` good is exported only where the harbour fits, using
`shared/econ/sites.json` `exportVia`:

* **Bulk minerals, coal, crude, LNG, LPG and ammonia** ship only from listed terminals. The list is seeded from
  `shared/jobs/ports.js TAG_SEEDS` (`bulk_ore`, `bulk_coal`, `oil`, `lng`, `lpg`), `server/jobsgen.js EXPORTERS`, and
  additions such as `ore: [..., 'itaqui', 'nouadhibou', 'lulea']`,
  `bauxite: ['kingston', 'gladstone', 'belem']`, `nickelore: ['manila', 'noumea']`, `manganese: ['richards_bay',
  'owendo', 'darwin']`, `phosphate: ['casablanca', 'aqaba']`, `potash: ['vancouver', 'aqaba', 'st_petersburg']`.
  Harbours of a producer country that are not on the list get role `L` for that good.
* **Every other `P` good** (grain, food, box goods, breakbulk, vehicles) ships from every harbour of the country of
  size ≥ `regional`. `minor` harbours get `P` only for `fish`, `salmon`, `shrimp`, `tuna` and `bananas`.
* **Inland-producing landlocked goods** are out of scope. Only countries with harbours have profiles.

### 6.3 Normal stock `n`

`n = BASE_N[g] × SIZE[size] × roleStock` (rounded, minimum 20 t), where
`SIZE = { mega: 1, major: 0.5, regional: 0.22, minor: 0.08 }` (today's `SIZE_STOCK`) and `roleStock` is 1.5, 1.0 or
0.7 (§6.1).

`BASE_N` (t, mega harbour, game): legacy targets kept (`fish 2,500, grain 30,000, steel 15,000, machinery 4,000,
containers 25,000, fuel 20,000, supplies 3,000`). By category: bulk grains and fertiliser 30,000; ore 400,000; coal
and cokingcoal 250,000; bauxite 200,000; other ores 60,000; crude 300,000; refined and chemicals 20,000; gases 60,000;
reefer 3,000 (flowers 800); box goods 4,000 (electronics and pharma 1,500); breakbulk 15,000 (copper and aluminium
6,000; project 800); vehicles 6,000; livestock 1,500. Chain inputs at sites get the `n` the chain sets (§8.3).

### 6.4 Flows: production, consumption, AI shipping

Per listed good, per hour (all in t/h, derived, not saved):

```
C = consumption:  role P or L:  n / COVER_H                      (COVER_H = 120 h: normal stock = 5 days of use)
                  role I:      −EQ_K × b × R × n                 (EQ_K = 0.8, R = 0.03 /h)
P = production:   role P:      C + EQ_K × b × R × n
                  role L or I: 0           (chain outputs: §8)
AI shipping:      R × (n − s)              (ships of the rest of the world; R = 0.03 /h)

ds/dt = P × fP − C × fC + R × rMul × (n − s)
```

* With every multiplier at 1, the equilibrium is **`s* = n × (1 + EQ_K × b)`**. Tier-1 makers sit at 1.8 n (glut,
  cheap). Tier-1 importers sit at 0.52 n (short, dear). Balanced harbours sit at n.
* `fP`, `fC` are the season multipliers (§6.5) × event multipliers (§6.7). `rMul` is the AI-shipping multiplier
  (storms, strikes, sanctions, ice).
* **Step (closed form, exact for constant multipliers):**
  `s(t + h) = s_eq + (s − s_eq) × (1 − R')^h`, where `R' = R × rMul` and
  `s_eq = n + (P × fP − C × fC) / R'`; `s` is floored at 0. With `rMul = 0` (port shut):
  `s(t + h) = max(0, s + h × (P × fP − C × fC))`.
* The server steps every listed good once a minute (`driftMarkets`, today's hook) and after loading (≤ 48 h, today's
  bound). The noise term of today (`±1 %·target·h`) stays, scaled to `0.01 × n × min(24, h) × (rnd − 0.5)`.

### 6.5 Seasons (`shared/econ/seasons.js`)

A season is `{ good, side: 'P'|'C', peak: 'MM-DD', W: days, A, hemi: true|false, cc?: [..] }`. The multiplier is:

```
m    = 4W / (365π)                     (mean of the bump over a year)
d    = circular day distance |doy − peakDoy| on a 365-day year (29 Feb counts as 28 Feb)
bump = d < W ? cos(π d / (2W)) : 0
f    = max(0.2, (1 − A·m) + A·bump)     → yearly mean exactly 1 (production or demand is moved in time, not created)
```

When `hemi` is true and the harbour's `lat < 0`, the peak moves by 182 days. Rows with `cc` apply only to those
countries and override the generic row for that good. Seed rows (game, timed from crop calendars):

| good | side | peak | W | A | hemi | cc / note |
|---|---|---|---|---|---|---|
| grain | P | 08-01 | 60 | 2.0 | yes | northern harvest; AU/AR get the 182-day shift → 31 Jan |
| maize | P | 10-15 | 60 | 2.0 | yes | BR safrinha override `cc: [BR] peak 07-15` |
| soybeans | P | 10-15 | 60 | 2.0 | no | `cc: [BR, AR, UY] peak 04-01` |
| coffee | P | 07-15 | 75 | 1.5 | no | `cc: [BR]`; `cc: [VN] peak 12-15`; CO has no season row (two crops) |
| cocoa | P | 12-01 | 75 | 1.5 | no | `cc: [CI, GH, CM]` main crop |
| sugar | P | 08-01 | 90 | 1.2 | no | `cc: [BR]`; `cc: [TH, IN] peak 02-01` |
| citrus | P | 01-15 | 60 | 1.5 | yes | southern makers (ZA, CL, PE, AR) → mid July |
| apples | P | 10-01 | 50 | 1.5 | yes | |
| fuel, coal, lng, lpg, fueloil | C | 01-15 | 75 | 0.6 | yes | heating, only at harbours with `|lat| ≥ 30` |
| toys, electronics, spirits, chocolate, wine, garments | C | 11-25 | 40 | 1.0 | no | year-end holiday buying, importers only |
| flowers | C | 02-07 | 10 | 1.5 | no | Valentine's Day |
| flowers | C | 05-05 | 10 | 0.8 | no | Mother's Day (most markets) |
| ore, coal | P | 07-20 | 60 | −0.6 | no | `cc: [IN]` monsoon loading slowdown |

**Ice:** harbours with the `ice` tag (`TAG_SEEDS.ice`) get `rMul × 0.5` and `fP × 0.6` from 01-01 to 03-31 (game).

Seasons are shown in the UI as one line: "Harvest in (peak 1 Aug)", "Winter demand", "Holiday buying",
"Monsoon slowdown".

### 6.6 Price

```
price(h, g) = max(1, round(base × local × (1 + land + σ)))

land = role P: −EXPORT_DISC (0.10)
       role L: 0
       role I: min(LAND_MAX (0.8), FREIGHT_TKM (0.06) × fmul × seaKm(nearest maker) / base + dutyRate)
σ    = S × clamp(SIG_LO (−0.8), SIG_HI (1.5), ln(n / s))          (n, s floored at 1)
local = seeded 0.97 … 1.03 per (harbour, good)                    (mulberry32 of `${h.id}:${g}`, today's seededRnd)
```

* **Landed price (import parity).** An importer pays roughly what it costs to bring the good from the nearest real
  maker. `seaKm(nearest maker)` is the smallest `routeTable.estimateKm` (else great-circle × `RATES.DETOUR` 1.25) to a
  harbour with role `P` for `g` that this harbour's authority does not ban (§9.3). It is computed once per
  (harbour, good) per dataset version and cached in an `Int32Array`. `0.06 cr/t·km` is 75 % of the contract rate
  (`PAY.PER_T_KM` 0.08), so trading earns about what a contract earns, plus or minus the scarcity term (§10).
* **σ, the scarcity term.** `ln(n / s)` is positive when the harbour is short and negative when it is glutted.
  `S` scales it per good: bananas and citrus swing hard (0.40–0.45), medicines and machinery barely move (0.10).
* **Duty.** `dutyRate` is the WTO MFN rate from `tariffs.json` for (country, good or polGroup). It is 0 today because
  the file is empty. The rate is part of the landed price because real import prices include duty. Customs still
  charges the duty to the seller on sale (politics §4.9), so the price makes up for it.
* `market[g]` = `price` (unchanged meaning). `tradeQuote` is unchanged: 8-step impact over the stock it moves and a
  2 % spread (E4).

### 6.7 Events

`server/worldecon.js` holds at most one active event per harbour (`st.ev = { kind, from, until, src? }`, saved):

| kind | trigger | effect | text |
|---|---|---|---|
| `strike` | game: per harbour per day `p = 0.002 (mega), 0.0015 (major), 0.001 (regional), 0 (minor)`; lasts 24–72 h | the harbour's market is closed to players; `rMul = 0` (nothing in or out); P and C continue, so makers pile up (cheap afterwards) and importers run dry (requests) | "Dock strike — market closed until 14:00" |
| `storm` | a storm from `server/stormfield.js` / `realstorms.js` whose radius covers the harbour | `rMul × 0.3`; trading stays open | "Storm — few ships arriving" |
| `closed` | politics `portStatus = closed` | like strike, with no end until politics changes; requests are frozen (deadlines pause) | politics text (§2.1 of the politics contract) |
| `restricted` | politics `restricted` | `rMul × 0.6` | politics text |
| `sanction` | derived from politics measures each dataset load (§9.3) | landed price uses the nearest maker that is **not** banned; when every maker within 5,000 km is banned, `rMul × 0.5` for that good | "Imports from RU restricted (EU)" |
| `boom` / `bust` | game: per country per 30 days, `p = 0.05` each for one random `make` good; lasts 7 days | `fP × 1.5` / `fP × 0.4` for that good in all of that country's harbours | "Bumper crop in Brazil" / "Mine outage in Chile" |

Events are announced in the harbour's news line and on the world-market screen ("What moved today").

### 6.8 Who can buy what (scarcity and reserve)

* **Buyable quantity** = `max(0, floor(s − reserve))` (§6.1). At a `P` harbour you can buy almost all of it. At an
  `L` harbour you can buy the part above 0.6 n. At an `I` harbour you can buy only what lies **above** normal (a glut
  that players delivered), so importers do not re-export.
* `tradeGoods` buy clamps `qty` to the buyable quantity. The warning reads: "Rotterdam does not sell coffee — it
  imports it. Coffee is made in Brazil, Vietnam, Colombia, Ethiopia… (Market → map)."
* Selling is allowed for any listed good. Unlisted goods are covered by §6.9.

### 6.9 Unlisted goods (the fallback buyer)

A player who arrives with a good the harbour does not list can still sell it to "general traders" at
**`DUMP_FRAC (0.45) × base`** per tonne. The cap is 500 t per good per harbour per 24 h, shared by all players and
not touching any stock. The UI marks it "Not traded here — general traders pay 45 % of the world base." 0.45 is below
the cheapest possible maker price (`base × (1 − 0.10 − 0.8 × S_max 0.5) = 0.5 × base`), so this rule can never be
used to make money from buying.

### 6.10 Price signals

* **Trend arrow** (today's `marketTrend`): the expected price direction from `s` versus `s_eq` (not `n`), with a
  `TREND_BAND` of 0.05.
* **24 h change** in %: from the history ring.
* **Reason chip:** the strongest current driver: season (`|f − 1| ≥ 0.25`), event, "short" (`s/n < 0.6`),
  "glut" (`s/n > 1.6`), or "request open".
* **History:** hourly for 7 days and 6-hourly for 30 days (§13).

---

## 7. Requests (Anno-style standing demand orders)

### 7.1 When a harbour posts one

On every regen (today's `regenHarbor`, every 2 h) and on every market step, for each listed good with role `I` (or a
chain input) where `r = s / n < REQ_R (0.6)`:

* if the harbour has fewer than `REQ_MAX[size] = { mega: 6, major: 4, regional: 3, minor: 1 }` open requests and none
  for this good, it posts one. Candidates are taken in ascending `r`, ties by higher `base`.

### 7.2 Terms (`requestTerms`, pure)

```
premium  = min(0.40, 0.15 + 0.25 × (1 − r / REQ_R))
unit     = round(price_now × (1 + premium))                          locked at posting (cr/t)
qty      = roundLot(min(n − s, REQ_QMAX[size]))   REQ_QMAX = { mega: 20,000, major: 8,000, regional: 3,000, minor: 800 } t
deadline = clamp(24, 720, round(1.5 × seaKm(nearest maker) / (13 × 1.852) + 24)) hours  (13 kn reference ship, world clock)
bonus    = 5 % of the request's total value, split pro rata among deliverers when it is completed in full before the deadline
```

`roundLot` rounds down to 100 t for bulk, liquids and gases, 12 t (1 TEU) for box goods, 14 t (1 reefer TEU) for
reefer, 1.5 t (1 CEU) for cars, and to whole head for animals. The minimum is 1 lot. A request below 1 lot is not
posted.

Record (saved in `st.req`, at most 6 per harbour, about 200 B each):

```js
{ id: 'q1a2b', good, qty, done: 0, unit, premium, postedAt, dueAt, r0, pledges: [{ pid, qty, until }], by: { [pid]: t } }
```

### 7.3 Delivering

* Action `deliver_request { reqId, qty }` while docked at that harbour. It moves the player's non-contract stacks of
  `good` (FIFO) into the request, up to `qty − done`. It pays `unit × t − duty − fees` (politics `onTrade` sell path:
  duty per stack origin, blocks apply). It adds the tonnes to the harbour stock (`s += t`), which lowers the market
  price as any sale would. The request price stays locked.
* **Eligible stacks:** `stack.src` (the harbour where the stack was bought, landed from fishing, or loaded from a
  chain) must be a harbour where the good had role `P` or `L` at purchase time, or a catch. A stack bought at an
  importer's surplus can be sold on the market but cannot fill a request. Contract cargo (`jobId`) never counts.
* **Pledges:** `pledge_request { reqId, qty }` reserves part of the remaining quantity for one player until
  `until = now + min(remaining deadline, estimated passage × 1.5 + 12 h)`. Each player can hold at most one pledge per
  request. The sum of pledges cannot exceed what remains. Pledged tonnes cannot be delivered by others until the
  pledge lapses. A lapsed pledge costs nothing (open question Q6).
* **Closing:** the request closes when `done ≥ qty`, at the deadline, or when the market recovers (`r > 0.9`) and no
  live pledge is left. A recovered request with live pledges stays open until those pledges lapse.
* **Reputation:** each delivery of at least 1 lot counts as `REP.deliver` (+1, capped by politics `deliverCapDay`)
  in that country.

### 7.4 Requests on boards and in the finder

* The **requests board** (§14.1) lists all of a harbour's requests. The world map shows bell markers.
* The **job board** marks any voyage job whose destination has an open request for its good. The job's pay is
  unchanged. The badge reads "Destination also requests this good."
* The **trade finder** gains `mode=requests` (§9.4).

---

## 8. Processing chains

### 8.1 Recipes (`shared/econ/chains.js`, data)

Input t per 1 t of output (game, rounded from industry averages):

| chain | inputs | outputs (t per 1 t of main input or output) | sites (harbour ids, `verify: true` unless noted) |
|---|---|---|---|
| `steel` | ore 1.6 + cokingcoal 0.75 | steel 1.0 | ijmuiden (Tata Steel), dunkirk (ArcelorMittal), taranto, gwangyang (POSCO), nagoya, shanghai, tianjin, visakhapatnam (RINL), vitoria (Tubarão), mersin |
| `refinery` | crude 1.0 | gasoline 0.30, fuel 0.35, jet 0.10, naphtha 0.08, fueloil 0.12 (yield 0.95) | rotterdam, antwerp, milford_haven, sines, algeciras, cartagena_es, singapore, ulsan, yanbu, ras_tanura, mundra (Jamnagar), galveston, corpus_christi, ningbo, kuwait |
| `cocoa` | cocoa 0.4 + sugar 0.35 + milkpowder 0.15 | chocolate 1.0 | ijmuiden (Amsterdam), hamburg, antwerp |
| `soycrush` | soybeans 1.0 | soymeal 0.79, vegoil 0.19 | buenos_aires, paranagua, new_orleans, rotterdam, qingdao, dalian, tianjin |
| `alumina` | bauxite 2.5 | alumina 1.0 | gladstone, fremantle, belem |
| `smelter` | alumina 1.93 | aluminium 1.0 | dubai_jebel_ali, sohar, bahrain, gladstone |
| `copper` | copperconc 3.5 | copper 1.0 | huelva, antofagasta, ningbo |
| `ammonia` | lng 0.75 t | ammonia 1.0 | doha, port_of_spain, dammam |
| `urea` | ammonia 0.57 | urea 1.0 | doha, dammam, port_of_spain |
| `pulp` | logs 3.5 | pulp 1.0 | vitoria, kotka, talcahuano, vancouver |
| `crackers` | naphtha 1.25 | polymers 1.0 | antwerp, singapore, ulsan, dammam, galveston |
| `cars` | steel 0.8 + autoparts 0.35 + polymers 0.15 | vehicles 1.0 (t) | nagoya, ulsan, bremerhaven, shanghai, veracruz |
| `garments` | cotton 1.2 | garments 1.0 | chittagong, vung_tau |

### 8.2 Sites (`shared/econ/sites.json`)

`{ id, chain, harbor, cap: 'P tier of the output' (1–3), src, verify }`. A site makes its outputs `P` at that harbour,
whether or not the country `make` row lists them. It makes its inputs `I` with `b = −0.45`. A harbour can host
several sites. Outputs from several chains add up.

### 8.3 Chain flows

For a site with main output `o` at nominal rate `P_o` (the `P` of §6.4 for its tier):

```
fill_i  = min(1, s_i / (0.5 × n_i))                       per input i
k       = 0.25 + 0.75 × min_i(fill_i)                     (25 % runs on long-term contracts the game does not show)
P_o'    = P_o × k × fP(o) × eventMul
C_i     = ratio_i × P_o'                                  (input consumption)
n_i     = ratio_i × P_o / (0.36 × R)                      (input normal stock: AI shipping holds s_i* = 0.64 n_i)
```

With inputs at equilibrium (`s_i = 0.64 n_i`, so `fill = 1`), the site runs at full rate. If AI imports fall away
(sanction, strike, storm), inputs drop below half of normal and `k` falls, so less output is made. The output's stock
falls, its price rises, and an input request opens (`r < 0.6`). This is the Anno loop.

Example (IJmuiden, major, steel tier 1): `n_steel = 15,000 × 0.5 × 1.5 = 11,250`, `P_steel = 363.75 t/h`;
`C_ore = 582 t/h`, `n_ore = 53,889`; `C_coking = 272.8125 t/h`, `n_coking = 25,260`. At ore stock 0.25 n:
`k = 0.625`.

---

## 9. Integration

### 9.1 Cargo compatibility (`shared/cargo.js`)

* Add a `CARGO` row for every new catalogue good, with the handling options of §4.2, its unit and tPer. Set
  `market: true` on all 80 goods. `fruit` keeps `market: false, fallback: 'bananas'`; `livestock` keeps its id
  (live cattle).
* Buying in the market uses the existing `canLoad(good, cls)` and adds a unit-aware capacity check:
  `maxQty = min(freeUnits(vessel, 't') , fromTonnes→toTonnes(freeUnits(vessel, unit)))`, with plugs for reefer-in-box
  (`ceil(t / 14)` plugs). Mixed holds are allowed as today: one handling type per stack, and liquids need a free
  segregation (`unitsOf(cls).segregations`). That is a new check: a tanker with 1 segregation can carry one liquid
  good at a time (Q8).
* The "why not" chip (`handlingText`) is reused verbatim in the market rows: "Needs LNG tanks — e.g. LNG carrier,
  LNG bunker vessel."

### 9.2 Jobs (`server/jobsgen.js`, `shared/jobs/catalogue.js`)

* `EXPORTERS` / `EXPORT_TAG` / `IMPORT_OK` stay as **fallbacks**. When the econ dataset is loaded, `exportsGood(h, g)`
  returns `roleOf(h, g).role === 'P'`, and `IMPORT_OK[g](h)` returns `role === 'I' || role === 'L'`. Voyage jobs
  therefore follow the same map the market shows.
* Voyage goods widen from `EXPORT_TAG` keys to every bulk, liquid or gas catalogue good. `PAY.GOOD_MUL` gains each new
  good's `fmul` (one table, so trading and contracts agree).
* Legacy freight (`LEGAL_GOODS`) picks the good from the origin's `P` listing (weighted by `b × base`), falling back
  to today's 4 goods. The destination weight (politics `destWeight`) is unchanged.
* `demandBonus(st, good)` keeps its formula (destination short → up to +30 %).
* Fishing landings go into the `fish` stock as today (`st.stock.fish += …`). Stacks landed from the nets get
  `src: <harbour of landing>, caught: true` (eligible for requests).

### 9.3 Politics

* **Matching new goods to existing measures:** `goodsMatch(m, good)` in `shared/politics.js` becomes
  `!m.goods || m.goods.includes(good) || m.goods.includes(polGroupOf(good))`. Example: the US secondary measure on
  Iranian `fuel` covers `crude`, `lng`, `lpg` and `methanol` of Iranian origin. The EU import ban on Russian `steel`
  covers `pipes`, `ore` and `cokingcoal` of Russian origin until the data lists exact goods. The politics data lane
  replaces polGroup matches with explicit goods over time (`verify` flag).
* **Who can be the "nearest maker":** for importer `h` in authority territory T, a maker country `o` is skipped for
  good `g` when an `import_ban` with territorial scope, active, matches `(g, o)` in T. Personal bans do not change
  prices (prices are shared by everyone). They only block the individual buy or sell (`tradeCheck`, today).
* **Tariffs:** `tariffs.json` rows (`{ cc: { good|polGroup: { rate } } }`) feed `dutyRate` in the landed price
  (§6.6) and `dutyFor` on sale (today). Both read the same row.
* **Trade flows (`trade.json`, H5):** `setTradeProfile` is retired for prices; the econ profiles replace it.
  `tradeShare` / `destWeight` stay for job destinations.
* **Sanctioned producers keep producing.** RU, IR and VE still have makers and markets. Whether a given player may buy
  there is decided by `tradeCheck` (P4: no evasion gameplay; the block text explains why). The black market is
  unchanged.
* **Port closed** → event `closed` (§6.7).

### 9.4 World market screen and trade finder (`server/market.js`)

* `rowsFrom` scans only goods the origin can sell (`buyable ≥ 1`): on average 6–8 per origin instead of every good.
  Destinations are harbours that list the good. `from=all` keeps the 80-nearest cap.
* The **expected sell price on arrival** uses `expectedStockAfter`, now the §6.4 closed form with the season
  multipliers at arrival time.
* **Requests mode** (`mode=requests`): one row per open request reachable by the ship (`canLoad`), sourced from the
  cheapest maker within the deadline at service speed:
  `net = unit × qty − buy − costs`. The row shows "fills x of y t" and the deadline margin.
* Each row gains `why` (the reason chip of the destination) and `role` (`P→I`, `P→L`, `L→I`).
* The cache, the rate limit (30 a minute per IP) and the 30 s answer cache are unchanged.

### 9.5 Captains (`shared/fleet.js`, `server/captain.js`, `server/fleet.js`)

New order type **`trade_run`**:

```js
{ type: 'trade_run', good, buyAt: harborId, maxBuy: cr/t, qty, sellAt: harborId | null, reqId: string | null, minSell: cr/t, then: 'moor'|'hold' }
```

1. The captain sails to `buyAt` and buys up to `qty` at `≤ maxBuy`, from the owner's company cash. Politics
   `tradeCheck` and the captain's risk policy apply. The check is `canLoad`.
2. The captain sails to `sellAt` and sells at `≥ minSell`, or delivers to `reqId` (pledging on departure).
3. If the limits are not met, the captain moors and reports ("Coffee at Santos is 2,140 cr/t — over your limit of
   2,000. Waiting for orders."). There is no silent loss.

The fleet UI's "Plan from World market" button fills the order from a finder row (`tradePlan`, today's chip).
Captains do not invent trades on their own (Q7).

### 9.6 Inland harbours (`shared/mharbour.js inlandMarket`, `server/minorharbours.js`)

* Instead of picking random goods, the pool is the parent named harbour's listed goods with role `I` or `L` that are
  in categories `grains, reefer, box, energy`. This covers local towns' food, fuel and shop goods. Fishing-tier
  harbours list `fish` only (as today).
* Shown price = parent price × `(1 ± MH.MARKET_SPREAD 0.06)` (today). Shown stock = `MARKET_STOCK_FRAC 0.1 × n`
  (today).
* **Trading** (new, small): buy and sell go against the **parent's** stock with the extra 6 % spread, capped at
  **200 t per player per inland harbour per 24 h**. Inland harbours hold no state of their own, as today, and never
  post requests. Inland harbours are generated per z12 square and held in an LRU of at most 3,000, so they must stay
  stateless (memory guard).

### 9.7 AI traffic (`server/traffic.js`)

The `R` term is the abstract world fleet. AI ships are visual only. As flavour, an AI cargo ship's label reads a good
from its origin's `P` listing that matches its class ("bulk carrier — iron ore, Port Hedland → Qingdao"). AI ships
never move stock directly (no double counting; Q9).

### 9.8 Bunkers and running costs

`game.fuelPrice(h) = market.fuel × h.fuelMul` is unchanged. With `S = 0.10` and the heating season
(`A = 0.6` on C), the bunker price moves about ±15 %. Every class's running cost moves with it, so the finder already
prices it in.

---

## 10. Balancing targets

**Reference rule:** the landed term pays `0.06 cr/t·km × fmul`, which is 75 % of the contract rate (0.08) before the
economy-of-scale factor. Trade margins between a maker and an importer therefore track contract pay. The scarcity
term (σ) and requests add or remove up to about 40 %.

Gross landed ceiling per ship-hour at service speed, laden (`hold × kn × 0.8 × 0.85 × 1.852 × 0.06 × fmul`), next to
the equivalent voyage-contract pay (`… × 0.08 × fmul × eos(hold)`):

| class | hold (t) | km/h laden | typical good (fmul) | landed ceiling cr/h | contract cr/h |
|---|---|---|---|---|---|
| coaster | 1,200 | 17.6 | box goods (1.3) | 1,650 | 2,339 |
| feeder | 4,000 | 25.2 | box goods (1.3) | 7,858 | 9,642 |
| bulker | 35,000 | 17.6 | grain (0.75) | 27,769 | 26,262 |
| tanker | 30,000 | 18.9 | gas oil (0.75) | 25,502 | 24,569 |
| boxship | 90,000 | 27.7 | box goods (1.3) | 194,496 | 164,234 |
| trawler | 300 | 15.1 | fish reefer (1.6) | 435 | 729 |
| psv | 2,500 | 17.6 | breakbulk (1.0) | 2,645 | 3,433 |

**Targets (acceptance, measured by the balance test on the seeded world, §17):**

* T1: for each cargo class, the **median net cr per ship-hour of the top 5 finder rows** (default sort, `from=all`,
  full cash) is between **0.5× and 1.1×** the median contract pay per ship-hour on that class's boards. Big hulls are
  held back by stock depth (impact), not by caps. If a class is out of band, the levers are `BASE_N` and `S`. Never
  add a per-class special case.
* T2: a **request** row's net per ship-hour is between **1.0× and 1.5×** the plain trade on the same route: requests
  are the best-paid trading, but not a jackpot.
* T3: **same-harbour round trip** (buy q, sell q back at once) always loses at least the spread: on the fixture it
  loses 92,400 cr on 1,200 t of coffee (§17).
* T4: the **bunker price** stays within ±25 % of `GOODS.fuel.base × fuelMul` at every harbour over a simulated year.
* T5: **no listed good sits at the clamp for more than 10 % of a simulated year** at any harbour (σ hitting +1.5 or −0.8),
  with no players. The model must breathe on its own.

---

## 11. Anti-exploit rules

| # | Exploit | Rule |
|---|---|---|
| X1 | Buy a harbour out at the pre-trade price, sell straight back (V7 bug 2026-10-08) | **stays fixed**: `TRADE.IMPACT` + `SPREAD 0.02`; the round trip loses about 4 % (§17 T3) |
| X2 | Buy cheap surplus at an importer, sell at a neighbouring importer | reserve = n at `I` harbours (§6.8); such stacks cannot fill requests (§7.3) |
| X3 | Dump unlisted goods to general traders | 45 % of base < the cheapest maker price (§6.9); cap 500 t per day |
| X4 | Fill a request with goods bought at the same harbour or at an importer | `stack.src` eligibility (§7.3) |
| X5 | Pledge-blocking (pledge everything and never come) | one pledge per player per request; pledge length tied to the ETA; pledges ≤ remaining; repeated lapses (3 within 7 days) block new pledges for 24 h |
| X6 | Inland harbour as a free second market | trades go against the parent's stock + 6 % spread, 200 t per day cap (§9.6) |
| X7 | Wash trading between two of your own ships, or by captain at the same harbour | ship-to-ship trades (`trade_offer`) do not touch markets; a captain's `trade_run` uses the same `tradeGoods` path as the player (impact + spread) |
| X8 | Abusing the season forecast | seasons are public and smooth (yearly mean 1). Gains are bounded by σ's clamp and impact. Buying ahead of a season is intended gameplay |
| X9 | Strike timing (buy a maker's pile right after a strike) | intended gameplay; the post-strike glut is bounded by `s_eq` and σ ≥ −0.8 S |
| X10 | Request bonus farming with 1-lot deliveries | the 5 % bonus is pro rata by tonnes and paid only on completion in full |

---

## 12. Save migration (`econSchema: 2`)

* `saveState` adds `econSchema: 2`. Per harbour it saves `st.stock` (listed goods only, integers), `st.target`
  (kept as the field name for normal `n`, rewritten on load from data, so it is informational), `st.market`, `st.req`
  and `st.ev`. Flows, roles, landed fractions and sites are **derived** in `WorldEcon` (typed arrays) and never saved.
* **Old saves (no `econSchema`):** for each legacy good, `s_new = round(s_old / t_old × n_new)`. This preserves how
  short or long the harbour was. Example: steel 9,800 / 15,000 with `n_new` 7,500 → **4,900**. New goods start at
  `s_eq × (0.85 + 0.3 × rnd)` (seeded per harbour). No open requests are carried over. Stocks of goods that are no
  longer listed at a harbour are dropped.
* **Cargo stacks:** unchanged. `src` is missing on old stacks, so they are treated as ineligible for requests (they can
  still be sold on the market). Healed in `migrateActor` with `src: null`.
* **Price history v1** (`data/market-history.json`): converted once to the v2 binary ring (legacy 7 goods kept,
  quantised), then renamed `.v1.bak`. An unreadable file starts empty with one log line (today's behaviour).
* **Dataset version:** `econVersion` (from `shared/econ/meta.json`) is stored. When it changes, `n`, roles, landed
  fractions and sites are rebuilt, and stocks are rescaled with the same ratio rule. Requests for goods that become
  unlisted are closed, and their pledges released.
* Nothing throws. A harbour state that fails migration re-initialises at equilibrium, with one log line.

---

## 13. Performance and memory (server heap `--max-old-space-size=448`, `server/memguard.js`)

| item | size | notes |
|---|---|---|
| catalogue + profiles + seasons + chains + sites | ≈ 120 KB raw (client loads it once, cached by ETag) | `shared/econ/*` |
| per listed good state (`s`, `n`, price) in plain objects | ≈ 9,400 × 3 numbers | already the shape of `st.stock/target/market` today (7 goods → about 28) |
| derived flows (`P, C, s_eq, land, local`) | `Float32Array(9,400 × 5)` ≈ 190 KB | rebuilt on load and on dataset change |
| requests | ≤ 336 × 6 × 200 B ≈ 0.4 MB worst case | |
| **price history** | `Uint16Array` index rings: hourly 168 + 6-hourly 120 per listing → 9,400 × 288 × 2 B ≈ **5.4 MB** | `idx = min(65535, round(price / base × 10,000))`; decode `round(idx × base / 10,000)` |
| history file | `data/market-history.bin` (JSON header line + raw rings), written atomically on the hour | replaces the 0.5 MB JSON; about 5.4 MB on disk |

* **Memory guard:** at `shed`, the 6-hourly ring is written to disk and dropped from memory (reloaded at `ok`). At
  `critical`, history sampling pauses. Market stepping never pauses: it is O(9,400) arithmetic per minute, under
  2 ms.
* **Snapshot size:** the old all-harbours × all-goods snapshot would be about 560 KB with 80 goods, which is too big
  for phones. The API is split (§15). The legacy `/api/market` keeps the 7 legacy goods only.
* **Trade finder:** at most 8 sellable goods per origin × 80 nearest destinations, with the price-bound early exit
  of today. A `from=all` scan stays under 200 ms (test with timing guard: < 400 ms on CI).

---

## 14. UI

### 14.1 Harbour sheet — "Market" tab (redesign; `public/js/econview.js`, used by `hud.js`)

Top to bottom:

1. **Country strip:** flag, country name, and two chip rows: **Made here** (P goods, tier-1 first, with the category
   icon) and **Needed here** (I goods). Tapping a chip filters the list below. A strike, closure or storm shows as a
   banner with the reason text and the end time.
2. **Requests board** (when any are open): cards sorted by premium. Each card shows the good icon and name, "2,400 t
   (200 TEU)", a progress bar (done, pledged, open), the locked price and **+27 %**, the deadline as "18 d 4 h", the
   nearest maker ("from Santos, 6,700 nm"), and your hold fit ("Your Feeder can carry it ✓" or the handling chip).
   Buttons: **Deliver** (when docked and holding eligible cargo), **Pledge…**, **Plan route** (opens the finder in
   requests mode).
3. **Goods list**, grouped by category with collapsible headers and a search field. Each row shows:
   * the icon, the name, and the role badge (`Made here` green / `Traded` grey / `Needed` orange);
   * the buy price (only if buyable; otherwise "Not sold here") and the sell price, in cr/t with the natural unit below
     ("≈ 28,140 cr/TEU");
   * a **sparkline** (7 d, 72 × 20; today's `sparkline()`), the trend arrow, 24 h %, and the reason chip;
   * a stock bar: the stock against normal, with a marker at the equilibrium;
   * the handling chip when your ship cannot carry it (from `canLoad`);
   * quantity input with **Buy** / **Sell** (today's controls), and **Max** fills `min(hold fit, buyable, cash)`.
4. A **footer** line: "Unlisted goods: general traders pay 45 % of base (500 t a day)".

Tapping a row opens a **detail panel** with a 30-day chart (6-hourly), a season strip (12 months, the bump shaded),
the 5 cheapest makers and 5 best buyers with distance, and the open requests for this good worldwide.

### 14.2 World market screen (`public/js/market.js`)

* A **good picker** (category tabs, then goods) replaces the 7 fixed columns. The table shows one good across all
  harbours, from `/api/market/good/:g`: harbour, country, role, buy, sell, stock against normal, sparkline, 24 h %.
* **Map overlays** on the chart (`public/js/chart.js` hook, layer `econ`):
  * **Producers:** green triangles sized by tier.
  * **Scarce:** orange to red circles by `s/n`.
  * **Requests:** bell markers with the premium.
  * **Price heat:** today's `heatColor` against the median.
  * A legend at the bottom left, toggled from the layers menu ("Market: coffee — makers, scarce, requests").
* A **"What moved today"** strip: the 5 biggest 24 h movers worldwide, with their reason chips.
* The **trade finder** (today's) adds the `Trades / Requests` toggle and the reason chip and role columns.

### 14.3 Phone layout (390 × 844)

* The harbour market tab becomes a single column. The country strip chips scroll sideways. The requests board is a
  horizontal carousel of cards (one card is 85 % wide). The goods list rows use two lines (name and prices on line 1;
  sparkline 56 × 16, trend and stock bar on line 2). Buy and sell open a bottom sheet with the quantity slider and Max.
* The world market opens as a full-screen sheet with the good picker as a sticky top bar. The map overlay toggle is
  one button. The finder results are cards, not a table.
* Tap targets are at least 44 px. Every number shown in a card is also available as text (no hover-only data).

### 14.4 Wording (E8)

Use "Made here", "Needed here", "Traded here", "Short", "Glut", "Harvest in", "Winter demand", "Holiday buying",
"Dock strike", "Storm", "Request", "Pledge", "Deliver", "Not sold here — imported", and "General traders pay 45 %".
Numbers use the existing `fmt` helpers. Sources appear only in the detail panel's "About this data" line (e.g. "Profile:
OEC/BACI 2023, USGS MCS 2025 — simplified for the game").

---

## 15. Protocol and API

| endpoint / message | shape | cache |
|---|---|---|
| `GET /api/econ/data` | `{ v, catalogue, cats, countries, seasons, chains, sites, sources }` | ETag; immutable per `econVersion` |
| `GET /api/market` | **legacy, unchanged shape**, 7 legacy goods only, `v: 2` added | 5 s (today) |
| `GET /api/market/good/:good` | `{ good, simTime, rows: [[hId, role, buy, sell, stock, n, trend, d24, reqId?]] }` (arrays, about 336 × 9) | 10 s per good |
| `GET /api/market/harbor/:id` | `{ id, country, make[], need[], ev, requests[], goods: [{ id, role, buy, sell, buyable, stock, n, sEq, trend, d24, why, hist7: [] }] }` | 10 s per harbour |
| `GET /api/market/requests?near=lat,lon&good=&limit=` | open requests, nearest first (≤ 100) | 30 s |
| `GET /api/market/history?good=&harbor=&days=1..30` | today's shape; `days > 7` returns the 6-hourly ring | — |
| `GET /api/market/routes` | today's query + `mode=trades|requests` | today |
| WS `buy_goods` / `sell_goods` | unchanged | — |
| WS `deliver_request { reqId, qty }`, `pledge_request { reqId, qty }`, `unpledge_request { reqId }` | new | — |
| WS `harbor` payload (`sendHarbor`) | adds `econ: { make, need, ev, requests }`; `market` keeps every listed good | — |
| fleet `fleet_order` | adds `trade_run` (§9.5) | — |

---

## 16. Build plan — five lanes with disjoint files

### 16.1 Frozen interface (`shared/econ/model.js`; Lane A ships stubs on day 0, then all lanes code against it)

```js
export const ECON2 = { R: 0.03, COVER_H: 120, EQ_K: 0.8, EXPORT_DISC: 0.10, LAND_MAX: 0.8, FREIGHT_TKM: 0.06,
  SIG_LO: -0.8, SIG_HI: 1.5, REQ_R: 0.6, REQ_PREM_MIN: 0.15, REQ_PREM_K: 0.25, REQ_PREM_MAX: 0.40, REQ_KN: 13,
  REQ_MIN_H: 24, REQ_MAX_H: 720, REQ_BONUS: 0.05, DUMP_FRAC: 0.45, DUMP_CAP_T: 500, MAX_LISTED: 32,
  RESERVE: { P: 0.2, L: 0.6, I: 1.0 }, ROLE_STOCK: { P: 1.5, L: 1.0, I: 0.7 }, CHAIN_K0: 0.25, CHAIN_FILL: 0.5, INPUT_EQ: 0.36,
  HIST_HOURLY: 168, HIST_6H: 120, INLAND_CAP_T: 200 /* per player per inland harbour per 24 h */, STRIKE_P: { mega: 0.002, major: 0.0015, regional: 0.001, minor: 0 } };
export function loadEcon(parts) /* { catalogue, countries, seasons, chains, sites, meta } → EconDs (frozen, indexed) */;
export function catalogueOf(id) /* row | null */;
export function roleOf(eds, harbor, good) /* { role: 'P'|'L'|'I'|null, tier, b, site?: chainId } */;
export function listingOf(eds, harbor) /* good ids, ≤ 32, stable order */;
export function normalOf(eds, harbor, good) /* n (t) */;
export function flowsOf(eds, harbor, good) /* { P, C, sEq } at multipliers 1 */;
export function seasonMul(eds, harbor, good, side, simTime) /* f */;
export function bump(A, W, peakDoy, doy) /* the §6.5 formula */;
export function stepStock(s, { n, P, C, R }, { fP, fC, rMul }, hours) /* new s, closed form */;
export function sigma(S, n, s) /* σ */;
export function unitPrice({ base, local, role, S, land, n, s }) /* int cr/t */;
export function landFrac({ role, base, fmul, seaKm, dutyRate }) /* land */;
export function buyable(role, s, n) /* t */;
export function dumpPrice(base) /* cr/t */;
export function requestTerms({ r, price, seaKm, size, n, s, good }) /* { premium, unit, qty, deadlineH } | null */;
export function chainK(fills) /* k */;
export function chainNormalInput(ratio, Pout) /* n_i */;
export function histEncode(price, base) /* uint16 */;  export function histDecode(idx, base) /* int */;
export function migrateStock(sOld, tOld, nNew) /* int */;
```

Server object (Lane B, consumed by C, D, E): `game.econ = new WorldEcon(game, eds)` with
`listing(hId)`, `harborView(hId)`, `goodView(g)`, `requests(filter)`, `deliver(actor, reqId, qty)`,
`pledge(actor, reqId, qty)`, `unpledge(actor, reqId)`, `step(hours)`, `onStorm(hIds, until)`, `onPolitics()`,
`expectedStock(h, g, hours)`, `nearestMakerKm(h, g)`, `stackSrcOk(stack, h, g)`.

### 16.2 Lanes

| lane | owns (disjoint files) | delivers |
|---|---|---|
| **A — data and pure rules** | `shared/econ/catalogue.js`, `shared/econ/model.js`, `shared/econ/seasons.js`, `shared/econ/chains.js`, `shared/econ/countries.json`, `shared/econ/sites.json`, `shared/econ/sources.json`, `shared/econ/meta.json`, `shared/cargo.js` (new CARGO rows), `shared/constants.js` (`GOODS` generated from the catalogue, legacy rows identical), `scripts/econ/validate.mjs`, `scripts/econ/build-profiles.mjs`, `test/econ-data.test.mjs`, `test/econ-model.test.mjs` | catalogue (80), profiles for every harbour country, seasons, chains, sites, validator, frozen interface |
| **B — server simulation** | `server/worldecon.js` (new), `server/economy.js`, `server/game.js` (econ hooks only: init, drift, tradeGoods, deliver/pledge actions, save/load), `shared/politics.js` (`goodsMatch` polGroup only), `test/econ-sim.test.mjs`, `test/econ-requests.test.mjs`, `test/econ-migration.test.mjs`, `test/econ-exploit.test.mjs` | stepping, events, requests, chains, reserve, dump rule, migration |
| **C — market API, finder, history, inland** | `server/market.js`, `server.js` (routes only), `server/minorharbours.js`, `shared/mharbour.js` (`inlandMarket` only), `test/market.test.mjs` (update legacy numbers), `test/econ-api.test.mjs`, `test/econ-history.test.mjs`, `test/econ-balance.test.mjs` | split API, binary history, finder requests mode, inland trading |
| **D — client** | `public/js/econview.js` (new), `public/js/econfmt.js` (new, pure), `public/js/market.js`, `public/js/hud.js` (market-tab section only), `public/js/icons.js`, `public/js/chart.js` (econ layer hook only), `public/css/econ.css` (new), `test/econui-fmt.test.mjs`, `test/econui-render.test.mjs` | §14 desktop and phone |
| **E — fleet and jobs** | `shared/fleet.js` (`trade_run`), `server/captain.js`, `server/fleet.js`, `public/js/fleet.js` (order form), `server/jobsgen.js`, `shared/jobs/catalogue.js` (`GOOD_MUL` rows), `test/econ-fleet.test.mjs`, `test/jobs2-*.test.mjs` updates | captains' trade runs, jobs follow roles |

Order: A day 0 stubs → B, C, D, E in parallel → B ↔ C integration (finder on live `WorldEcon`) → D on the real API →
balance pass (C's balance test, levers in A's data) → deploy behind `ECON_V2=1` for one day on the live release, then
default on.

---

## 17. Tests (`node --test`, files in `test/`; numbers asserted exactly)

**econ-model.test.mjs (Lane A; inputs given explicitly, independent of the data files)**

* `sigma(0.35, n, s)` with `s/n = 0.2 → 0.5250` (clamped at +1.5), `0.52 → 0.2289`, `1 → 0`, `1.8 → −0.2057`,
  `2.5 → −0.2800` (clamped at −0.8); 4-decimal rounding.
* `unitPrice({ base 2345, local 1, role 'P', S 0.15, n 12,000, s 21,600 }) === 1904` (coffee at Santos).
* `landFrac({ role 'I', base 2345, fmul 1.3, seaKm 12,500 }) ≈ 0.41578` and
  `unitPrice({ base 2345, local 1, role 'I', S 0.15, land that, n 2,800, s 1,456 }) === 3550` (coffee at Rotterdam).
* Iron ore: `unitPrice(P, base 100, S 0.35, r 1.8) === 69`. Importer at 7,500 km, fmul 0.5, r 0.52: `land` is clamped
  to 0.8, so the price is `=== 203`.
* Flows with `n = 10,000`: `b 1 → C 83.33, P 323.33, sEq 18,000`; `b 0.75 → P 263.33, sEq 16,000`;
  `b 0.5 → P 203.33, sEq 14,000`; `b 0 → P = C = 83.33, sEq 10,000`; `b −0.3 → C 72, sEq 7,600`;
  `b −0.45 → C 108, sEq 6,400`; `b −0.6 → C 144, sEq 5,200` (2 decimals).
* `stepStock(5,000, { n 10,000, P 0, C 144, R 0.03 }, { fP 1, fC 1, rMul 1 }, 24) → 5,103.7` (1 decimal). With `rMul 0`, 24 h:
  `max(0, 5,000 − 24 × 144) = 1,544`.
* Seasons (`bump`, 4 decimals): wheat `A 2, W 60, peak 1 Aug`: 1 Aug **2.5814**, 1 Sep **1.9581**, 1 Feb **0.5814**,
  yearly mean **1.0000**. Holiday `A 1, W 40, peak 25 Nov`: **1.8605**, 20 Dec **1.4160**, 1 Mar **0.8605**.
  Valentine `A 1.5, W 10, peak 7 Feb`: **2.4477**, 1 Jun **0.9477**. Heating `A 0.6, W 75, peak 15 Jan`: **1.4430**,
  15 Jul **0.8430**. Monsoon `A −0.6, W 60, peak 20 Jul`: **0.5256**, 1 Jan **1.1256**. A southern-hemisphere
  harbour's wheat peaks on 31 Jan.
* `requestTerms`: premium for `r 0.3 → 0.275`, `0.52 → 0.1833`, `0.1 → 0.3583`, `0 → 0.40`; `deadlineH` for
  `seaKm 12,500 → 720` (capped), `500 → 55`; `qty` rounds down to lots (1,250 t bulk → 1,200; 130 t box → 120;
  10 t reefer → null).
* `chainK`: fills `[0.5 (s = 0.25 n)] → 0.625`, `[1.28 (s = 0.64 n)] → 1`, `[1, 0.2] → 0.4`;
  `chainNormalInput(1.6, 363.75) → 53,889`, `(0.75, 363.75) → 25,260` (rounded).
* `dumpPrice(2345) === 1055`; `buyable('I', 6,000, 5,000) === 1,000`; `buyable('I', 4,000, 5,000) === 0`;
  `buyable('P', 21,600, 12,000) === 19,200`.
* `histEncode(3550, 2345) === 15139`, `histDecode(15139, 2345) === 3550`; `histEncode(69, 100) === 6900`;
  `histEncode(1e9, 1) === 65535`.
* `migrateStock(9,800, 15,000, 7,500) === 4,900`.

**econ-data.test.mjs (Lane A)**

* The catalogue has ≥ 60 market goods (80 at release). Every id has a `CARGO` row with `market: true`. Every `opts.h`
  is a `HANDLING` key, and every `unit` is a `UNITS` key. The 7 legacy goods have their exact legacy bases.
* `base` follows the §4.1 rule for every non-legacy row (`refUsdT 5,500 → 2,345`; `40,000 → 6,325`; `60,000 → 7,746`).
* Every harbour country (124) resolves to a profile or a template. No good is in both `make` and `need`. Every `src`
  id resolves in `sources.json`. Every site harbour id exists. Every chain good exists.
* Roles on the real data: Santos `coffee` → `P` tier 1; Rotterdam `coffee` → `I`; Port Hedland `ore` → `P`; Qingdao
  `ore` → `I`; Ras Laffan `lng` → `P`; Tokyo `lng` → `I`; Bergen `salmon` → `P`; Abidjan `cocoa` → `P`; Antofagasta
  `copper` → `P`; IJmuiden `ore` → `I` (site input), `steel` → `P`; Santos `ore` → `L` (not an ore terminal).
* Every harbour lists `fuel` and lists ≤ 32 goods. The listing mean over 336 harbours is between 20 and 32.
* The validator script exits with 0 on the repository data and 1 on each of 6 broken fixtures.

**econ-sim.test.mjs, econ-requests.test.mjs, econ-exploit.test.mjs, econ-migration.test.mjs (Lane B)**

* With no players, after 30 simulated days every harbour × good is within 5 % of `s_eq × seasonal shift` (seeded
  world, noise on). T5: under 10 % of hours at a clamp, over 365 days.
* Strike: the market is closed, `rMul` is 0, and an importer's stock falls by `24 × C × fC` per day.
* A storm covering Rotterdam multiplies `R` by 0.3 for its duration.
* Fixture for exact quotes (coffee, local 1): buy 1,200 t at Santos (`n 12,000, s 21,600`) → `unit 1,952`, `total
  2,342,400`; selling straight back → `total 2,250,000`; round-trip loss **−92,400**. Selling 1,200 t at the Rotterdam
  fixture (`n 2,800, s 1,456`) → `unit 3,365`, `total 4,038,000`.
* Request posts at `r < 0.6` only, at most `REQ_MAX` per harbour. Deliveries pay the locked price. Pledges reserve.
  The bonus is paid pro rata on completion only. An ineligible `src` is refused with its text. Contract cargo is
  refused.
* The reserve blocks buying at an importer below normal. The dump buyer pays 1,055 cr/t for coffee and stops at
  500 t a day.
* A sanction fixture: an EU territorial import ban on RU `steel` → Rotterdam's nearest steel maker skips RU harbours
  (its landed fraction rises), and `rMul × 0.5` applies when no other maker is within 5,000 km.
* Migration: an old save (7 goods) loads. Steel 9,800 / 15,000 becomes 4,900 at `n 7,500`. New goods start within
  0.85–1.15 × `s_eq`. No exception on 50 random corrupt harbour states.

**econ-api.test.mjs, econ-history.test.mjs, econ-balance.test.mjs, market.test.mjs (Lane C)**

* `/api/market` keeps the legacy shape and goods. `/api/market/good/coffee` has one row per listing harbour.
  `/api/market/harbor/rotterdam` includes requests and make/need lists. 400 on unknown ids.
* History: the binary ring round-trips, `days=30` returns 6-hourly samples, a v1 JSON converts, and corrupt input
  starts empty. The memory of the full rings is ≤ 6 MB (`byteLength` sum).
* Finder: `mode=requests` rows reach only `canLoad` hulls, and the deadline is honoured at service speed. The `from=all`
  scan completes in < 400 ms on the seeded world.
* Balance (T1, T2) per cargo class on the seeded world (fixed seed 20261009).
* `market.test.mjs`: the v6 exploit baseline and the wave-2 impact checks stay. Legacy price-band assertions move to
  the new clamp (σ bounds instead of 0.55/1.9).

**econui-*.test.mjs (Lane D)** — pure formatting: unit prices (`cr/TEU = cr/t × 12`), deadline text (`"18 d 4 h"`),
role badges, reason chips, sparkline (exists), and the request card HTML snapshot (desktop and 390 px class).

**econ-fleet.test.mjs (Lane E)** — `normalizeOrder` accepts or rejects `trade_run`. A captain buys within limits,
waits when over the limit, sells or delivers, and politics blocks are respected. Voyage jobs come from `P` harbours
and go to `I` or `L` harbours.

---

## 18. Acceptance checklist (desktop 1440 × 900 and phone 390 × 844, two players with different homes)

1. [ ] Rotterdam's Market tab shows "Made here: flowers, machinery, refined fuels…" and "Needed here: coffee, cocoa,
   crude…". Coffee says "Not sold here — imported" and offers Sell only.
2. [ ] Santos sells coffee, soybeans, sugar and chicken. A coaster buying coffee sees the price rise with quantity
   (impact) and the 2 % spread.
3. [ ] An immediate same-harbour round trip loses money every time (any good, any harbour).
4. [ ] A request appears at a short importer within one regen (≤ 2 h), with premium, quantity, deadline and nearest
   maker. A second player sees the same card. A pledge from player A reduces what player B can deliver.
5. [ ] Delivering eligible coffee pays the locked price, lowers Rotterdam's market price, and updates the progress
   bar for both players. Completing the request pays the 5 % bonus pro rata.
6. [ ] A stack bought at an importer's surplus cannot fill a request. The refusal text says why.
7. [ ] The world-market map for `coffee` shows producers (BR, VN, CO, KE as listed), scarce importers and
   request bells. The legend toggles. The overlay also works on the phone.
8. [ ] The sparkline (7 d), the 30-day chart, the trend arrow, 24 h % and the reason chip ("Harvest in", "Winter
   demand", "Dock strike") are visible on a row and in the detail panel.
9. [ ] A forced strike at Santos closes its market, piles up coffee there and drains importers. Prices recover after
   the strike.
10. [ ] A ship that cannot carry a good (a tanker and bananas) sees the handling chip with suggested ships. Buy is
    disabled with the reason.
11. [ ] A politics fixture with a ban (e.g. an EU home buying RU-origin steel) is blocked with the politics text. The
    world price at Rotterdam reflects the next-nearest maker.
12. [ ] IJmuiden's steel output falls when ore is cut off (forced sanction fixture), its steel price rises, and an
    ore request opens.
13. [ ] A captain's `trade_run` from the finder plan buys, sails, and sells or delivers, and reports in the fleet log.
14. [ ] An inland harbour's market shows food, fuel and shop goods from its parent. A 200 t trade works, and the cap
    message appears after that.
15. [ ] An old save loads with no errors. Cargo stacks and contracts are intact, and legacy goods keep their
    relative scarcity.
16. [ ] The server's memory after 24 h with history is ≤ the pre-change baseline + 8 MB. Markets keep stepping at
    `shed`. `/api/market/good/:g` stays under 40 KB gzip.
17. [ ] On the phone, every control is reachable with the thumb, nothing scrolls sideways except the chip rows and
    the requests carousel, and buy and sell work from the bottom sheet.

---

## 19. Open questions (built with the default unless the product owner changes it)

| # | Question | Default |
|---|---|---|
| Q1 | Should credits stay compressed above 1,000 USD/t (√ rule), or follow real values? | √ rule; legacy bases unchanged |
| Q2 | Should importers sell nothing at all, even above normal? | they sell only their surplus above normal (X2 still holds) |
| Q3 | Should real-time seasons follow the real calendar, or a compressed game year? | real calendar (the world clock is real time) |
| Q4 | Spoilage of reefer and livestock cargo over `perishH`? | OFF (hook only); reefer handling is the gate |
| Q5 | Should players be able to build or own processing plants (Anno production)? | no, out of scope; chains are world-owned |
| Q6 | A penalty for lapsed pledges? | none, except the 3-lapse cooldown (X5) |
| Q7 | Should captains find trades by themselves ("auto-trader")? | no; the player sets a `trade_run` (a follow-up could add a repeat flag) |
| Q8 | Several liquid goods in one tanker (segregations)? | yes, up to `unitsOf.segregations`; older tankers have 1 |
| Q9 | Should AI ships physically carry stock between harbours? | no; abstract `R` (performance and no double counting) |
| Q10 | Ramadan, Lunar New Year and other moving-date demand peaks? | not in v1; a `dates` table per year later |
| Q11 | Should real export restrictions (e.g. India's 2023 rice export curbs) become events from the politics data? | yes, through `export_ban` measures with `territorial` scope (data lane), no new code |
| Q12 | Show the source citations to players? | only in the detail panel's "About this data" line |
| Q13 | Should the 500 t/day dump cap be per player or shared? | shared per harbour (simpler; no alt-account farming) |
| Q14 | Should the 80-good catalogue grow later (e.g. LNG bunkering, hydrogen, methanol fuel)? | yes; add rows in the data only (E1) |

---

## 20. Main decisions (summary)

1. **80 real goods** in 10 categories, each with a real handling type and unit from `shared/cargo.js`. The economy
   runs in tonnes, and units are a display and hold-fit layer. The **7 legacy ids and bases are frozen**. High values
   are compressed with a √ rule.
2. **Country roles from real export/import specialisation** (seed table from OEC/BACI, USGS, IGU, NSC, ICCO,
   MPOB and others, with sources labelled; `verify` where not yet checked). Each harbour × good is **P / L / I / not
   listed**. Bulk exports ship only from real terminals. At most 32 goods per harbour.
3. **Scarcity is enforced by a reserve.** Importers keep their stock and sell only surplus above normal, so
   "other countries can't get these products" holds without blocking anyone from selling.
4. **One flow model:** production − consumption + AI shipping toward normal, with a closed-form step. The equilibrium
   is set by a balance `b`: makers sit at 1.8 n, tier-1 importers at 0.52 n.
5. **Price = base × (1 + landed + σ):** an importer pays the freight from the nearest allowed maker (0.06 cr/t·km ×
   fmul, 75 % of contract pay) plus a log-scarcity term with per-good swing `S`. Trading pays like contracts, and
   prices make sense at a glance.
6. **Seasons** are smooth bumps with a yearly mean of exactly 1 (harvests, winter heating, holidays, Valentine's Day,
   monsoon, ice). **Events:** strikes, storms, politics closures and sanctions, booms and busts.
7. **Anno requests:** importers post standing orders when short (`s/n < 0.6`), with a locked premium of 15–40 %, a
   deadline from the real distance to the nearest maker, pledges, and a completion bonus. Eligibility rules stop
   laundering.
8. **13 processing chains** (steel, refinery, cocoa, soy crush, alumina, smelter, copper, ammonia, urea, pulp,
   crackers, cars, garments) at real industrial ports. When an input runs short, output falls, prices rise and
   requests open.
9. **Integration without new code paths:** cargo `canLoad` and units, jobs following roles, politics through
   `polGroup` and landed prices, a finder with requests mode, a captain `trade_run` order, and inland harbours as
   stateless windows on the parent's pool.
10. **Compact and safe:** derived data lives in typed arrays and is not saved; history is a 16-bit ring of about
    5.4 MB with memguard shedding; the API is split per good and per harbour; the old exploit stays fixed; old saves
    migrate by keeping their scarcity ratio.

---

## 21. Sources (labels used in `shared/econ/sources.json`; accessed 2026-10-09)

| id | what it supports | reference |
|---|---|---|
| `mdic-2024` / `datamar-2025` | Brazil 2024: crude ≈ US$ 44.8 bn, first time top export; soybeans ≈ US$ 43 bn | [Datamar News — Oil becomes Brazil's top export](https://datamarnews.com/noticias/oil-becomes-brazils-top-export-challenging-lulas-environmental-agenda/); [Datamar — Oil set to top Brazilian exports in 2024](https://datamarnews.com/noticias/oil-set-to-top-brazilian-exports-in-2024/); [TradeInt — Top Brazil exports 2024–25](https://tradeint.com/insights/top-10-brazil-exports-by-country-2024-2025/) |
| `disr-req-2024` | Australia: iron ore ≈ A$141 bn (2023/24); mineral resources 59 % of exports | [DISR — Commodity markets stabilising (2024)](https://www.industry.gov.au/news/commodity-markets-stabilising-following-disruptions-2024); [Nasdaq — Australia's most valuable mineral exports](https://www.nasdaq.com/articles/australias-5-most-valuable-mineral-exports) |
| `igu-2025` | LNG 2024: US 88.4 Mt (21.5 %), AU 81.0 Mt, QA 77.2 Mt; world ≈ 414 Mt (Kpler) | [Gulf Times — IGU: Qatar 18.8 % of LNG exports 2024](https://www.gulf-times.com/article/705813/business/qatar-accounts-for-188-share-of-global-lng-exports-in-2024-igu); [JPT — US top LNG exporter 2024 (EIA)](https://jpt.spe.org/us-ranked-as-worlds-top-lng-exporter-in-2024-eia-reports); [MEES — Global LNG trade 2024](https://www.mees.com/2025/1/3/opec/global-lng-trade-us-extends-lead-for-2024-set-to-pull-further-ahead-for-2025-with-30mn-ty-start-ups/2f611910-c9d5-11ef-ad8d-25218fdec5ad) |
| `usgs-chile-2024` | Chile ≈ 24 % of world mined copper 2024 (#1); DRC, Peru next | [USGS — Chile country profile](https://www.usgs.gov/centers/national-minerals-information-center/chile); [Plusmining — Chile's share 30 % → 24 %](https://plusmining.com/en/2025/02/24/chiles-share-in-the-global-copper-market-drops-from-30-to-24-in-a-decade/); [Nasdaq — Top copper producers](https://www.nasdaq.com/articles/top-10-copper-producers-by-country-updated-2024) |
| `nsc-2025` | Norway 2024: salmon NOK 122.9 bn, 1.26 Mt, 70 % of seafood exports | [Norwegian Seafood Council — 2024 best year ever](https://seafood.mynewsdesk.com/pressreleases/2024-was-the-best-year-ever-for-norwegian-seafood-exports-3362349); [SeafoodSource](https://www.seafoodsource.com/news/supply-trade/norway-posted-highest-seafood-export-value-ever-in-2024) |
| `cocoa-2024` | Côte d'Ivoire ≈ ⅓ (Statista) to 40–45 % (industry) of world cocoa; Ghana usually 2nd (≈ 15–20 %) | [Statista — cocoa bean production by country](https://www.statista.com/statistics/263855/cocoa-bean-production-worldwide-by-region); [Cocoa Diaries](https://cocoadiaries.substack.com/p/part-2-the-bitter-sweet-numbers-cococ); [Intelpoint — cocoa producers](https://intelpoint.co/blogs/top-cocoa-producing-countries-trends/) |
| `mpob-2024` | Malaysia ≈ 23 % of palm-oil production and 30 % of exports; ID + MY ≈ 85 % of trade | [S&P Global — tight palm oil supplies 2024 (MPOB)](https://www.spglobal.com/commodityinsights/en/market-insights/latest-news/agriculture/011124-tight-palm-oil-supplies-to-support-prices-in-2024-mpob); [Statista — palm oil production](https://statista.com/statistics/613471/palm-oil-production-volume-worldwide) |
| `te-hs0603-2023` | Cut flowers 2023: NL ≈ 47 % of world exports, Colombia ≈ 20 % | [Trend Economy — HS 0603 world exports](https://trendeconomy.com/data/commodity_h2/0603); [Skyminder — Netherlands cut flowers](https://www.skyminder.com/blog/analysis-studies/fresh-cut-flowers-a-look-at-the-netherlands-trade/); [Hortipoint — Rabobank floriculture map](https://hortipoint.nl/bloemenblad/rabobank-dutch-share-in-global-cutflower-export-wil-drop) |
| `cepii-baci` | refresh source for all tiers (HS6 bilateral, harmonised UN Comtrade) | shared with politics `build-trade.mjs` (politics contract §3.10) |
| `oec-*` | country export baskets (seed rows marked †) | oec.world country profiles (to verify per row) |

Rows marked † in §5.2 are `verify: true` in the data until the data lane checks them against the cited statistic.
The game never shows an unverified row's source to players.
