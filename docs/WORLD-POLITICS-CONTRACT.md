# Saltline — world politics: real rules per harbour, sanctions, war risk, flags and trade (build contract)

Status: **design only** (2026-10-09). Nothing here is built. Phase 1 is new files only (two parallel lanes, §8).
Phase 2 adds hooks to `server/game.js`, `server/fleet.js`, `server/captain.js`, `server.js`, `public/js/hud.js`,
`public/js/chart.js`, `public/js/hq.js` and `public/js/main.js`. Other agents are editing those files now, so phase 2
waits until they finish. Phase 2 is written out below as a hook table (§6.2).

Builds on: harbours with ISO country codes (`server/harbors.js`, `server/harbors-world.js`: 336 harbours, 124
countries); the supply/demand market (`server/economy.js` `localProfile`/`targetStock`/`tradeQuote`, `server/market.js`);
job generation (`generateJob`, `pickDestination`, `regenHarbor`); docking (`game.dock` → `finishDock`); the v6 office and
home harbour (`server/fleet.js` `homeMove`/`homeAction`, `shared/fleet.js` `FLEET.HOME_*`); hired captains
(`server/captain.js` `requestPlan`/`departureBlocked`, `captainRefusal`); the route planner's avoid discs
(`server/searoute.js planRoute opts.avoid`, `ROUTE.AVOID_MAX = 8`); the AIS MID → ISO flag table
(`server/ais/mid.js`). Planned systems it connects to: wave 2 company, bank and insurance (`docs/V5-WAVE2-DESIGN.md`
§3.1–3.4), v7 #1 career and reputation, and v7 #8 world events (`docs/V7-PLAN.md`).

---

## 1. What the player gets (plain words)

**The request:** "Make the world political, as it really is. Each harbour has its own rules based on how its country
works. Goods follow the real trade between countries. Add diplomatic contracts and agreements between countries. My home
harbour (my company's country and flag) has rules I must follow. Moving my home should have real requirements. Model
real conflicts: Russia is at war with Ukraine, so going to Odesa should be dangerous and expensive."

**Answer:**

* **Every harbour has a Rules tab.** It shows whether the port is *open*, *restricted* (for example a permit or a set
  route is needed) or *closed*. It also shows which sanctions apply **to you** there, the customs duty on each good you
  carry, the port-inspection regime and your chance of being inspected, whether the port is in an emission control
  area, and the war-risk insurance premium for your ship. Every line names its **source and date**, for example "Joint
  War Committee listed area, JWLA-0xx, dd Mon yyyy" or "Council Regulation (EU) No 833/2014, Art. 3g".
* **Your company has a country.** Your home harbour's country decides which sanctions you follow (EU, UK, US, UN and
  others) and which customs union you belong to. Each ship flies a **flag**, by default your home country's. The flag
  decides port bans, coastal trade rights (for example the Jones Act in the US or EU cabotage) and how hard port
  inspectors look at you. You can **re-flag** a ship to Panama, Liberia, the Marshall Islands, Malta and others. Each
  registry has its own requirements (who may own the ship, its age, the time it takes, the fees).
* **Moving your home is a real decision.** The move card lists what changes: the sanctions you follow before and after,
  the customs union, which ships must re-flag, the waiting time for company registration, and the cost. Existing
  contracts that the new country would not allow must be finished first.
* **Conflict areas work the way they do in real shipping.** Waters on the London insurance market's Joint War Committee
  list are drawn on the chart. Entering one costs an **additional war-risk premium** (a percentage of your hull value).
  Your crew earns **double pay** inside areas the seafarers' unions list as warlike. A small, tuned chance of an
  incident exists: a drifting mine, a missile or drone strike, or detention by a coastal state. **Crews are always
  safe** in this game; ships can be damaged or, rarely, lost. Some ports can only be reached on a **corridor route**,
  such as the Ukrainian Black Sea corridor to Odesa. Contracts there pay **two to three times** the usual rate, and the
  shipper refunds the war premium on delivery, as real charter parties do.
* **Going to Odesa** today means a "restricted" port, a corridor route from the Bosporus along the western Black Sea, a
  listed area with a premium of about 1 % of hull value per call, a small chance of mine or strike damage, and double
  crew pay. Russian Black Sea ports are listed areas too and use the **same mechanics**, with numbers taken from the
  same kinds of sources. On top of that, EU, UK and US companies face goods bans there under their own sanctions. A
  Russian-domiciled company faces the bans that EU, UK and US ports apply to Russian ships.
* **Trade follows real flows.** Prices and stocks lean on real export/import balances (UN Comtrade / CEPII BACI,
  condensed). Freight contracts go more often to the countries that really buy that good from the exporting country.
  Duties depend on real agreements: no customs inside the EU customs union, preferential rates inside FTAs (USMCA,
  ASEAN, Mercosur, UK–EU TCA…), and WTO MFN rates elsewhere.
* **New contract types:** humanitarian aid, grain-corridor runs, state charters (needs a good reputation with that
  country), sanction-compliant routes (for example "avoid the southern Red Sea": paid for the long way round the Cape,
  as real shippers did in 2024), and assisted departures (civilian evacuation runs) when the data marks one.
* **The chart** gets overlays for war-risk areas, emission control areas, piracy high-risk areas and corridors. Before
  any voyage or contract, a **risk check** lists every area on the route (km and hours inside), premiums, incident
  odds, emission-zone fuel cost, piracy, the destination's status, and anything that blocks you. Its button **Plan
  around listed areas** re-routes the voyage.
* **Your hired captains follow a risk policy** you set in the office: *avoid* (default), *cautious* or *accept*.
* **Reputation per country** grows with clean deliveries and humanitarian work. It drops with detentions and seizures.
  It unlocks state charters and shapes how often you are inspected.
* **Everything is data.** One versioned dataset with a "valid as of" date that the game shows, plus a script that
  validates it and reports what is out of date. When the world changes, the data is updated; the game code is not.

What it is **not**: no side-taking, no "good/evil" countries, no gameplay for evading sanctions, no playable military,
no casualties, no real people. Every country's own published measures go through the same mechanics (§2).

---

## 2. Principles (hard rules for the data, the code and the text)

| # | Principle | How it is enforced |
|---|---|---|
| P1 | **Sourced and dated.** Every rule, area, status, rate and flow comes from a named public source with a publication date. The game shows source + date wherever the rule shows. | Each record has a `src` (id into `sources.json`) and `asOf`. The validator rejects a record without them. The UI renders `src` + `asOf` on every line. |
| P2 | **Game numbers are labelled as such.** Credits, probabilities scaled for play, and time scaling are game rules. They are never presented as facts. | Each numeric field has `basis: 'source' \| 'game'`. The UI marks `game` values "Game rule" (small grey tag). |
| P3 | **Neutral and symmetric.** The same mechanics apply to every country. Each jurisdiction's measures are modelled from its own official publication when it is accessible, including measures by the EU, UK, US, UN, Russia, China, Iran and others. Areas are listed because a maritime source lists them, not because the game judges a side. | No per-country code paths. Everything is a table row. The text comes from fixed templates (§2.1). A test greps the dataset and templates for banned words. |
| P4 | **No sanctions-evasion gameplay.** A legal action that would break a sanction that applies to you is **blocked** with an explanation. It is never offered as a risky shortcut. The existing black market stays as it is, but it never sends contraband to, from or through a listed conflict area or a country under a UN arms embargo. | `tradeCheck` / `jobCheck` return `block`. `generateSmugglingJob` filters destinations (§6.2 hook H3). |
| P5 | **People are safe.** Incidents damage, delay, detain or (rarely) sink ships. Crew are always reported safe or evacuated. No injuries, deaths, hostages or ransom stories. | Incident templates only (§2.1). `sink()` is called with the reason `war_loss`, whose text says "crew evacuated safely". |
| P6 | **No real-person targeting.** No named living persons (officials, owners, captains) in data or text. Designated *vessels* or *companies* from real lists are **not** imported (they would point at real private parties). Only country × goods × flag-level rules are modelled. | Validator: no `person` fields. Regimes have no entity lists. |
| P7 | **Not advice.** Every Rules view ends with "Simplified for the game — not legal, compliance or navigation advice." | Fixed footer. |
| P8 | **Stale data is shown as stale, never silently dropped.** | `reviewBy` per record. Past it, the UI shows an amber "may be out of date" tag. War-risk and port status records review every 30 days, everything else every 365. |
| P9 | **Easy to update.** The data lives in small JSON files, one concern each. The code reads only the dataset. A refresh script reports what to check and validates the result. | §3.15. |

### 2.1 Wording templates (the only conflict texts the game prints)

| Situation | Template |
|---|---|
| Listed area chip | `Listed area — {areaName} ({srcShort}, {asOf})` |
| Conflict note on a country | `Armed conflict affecting shipping in {areaName} (source: {srcShort}, {asOf}).` (no attributions of blame, no adjectives) |
| Port status | `Open` · `Restricted — {reason}` · `Closed to merchant shipping — {reason}` with `reason` from a fixed list: `entry permit required`, `corridor route required`, `martial law in force`, `port operations suspended`, `access limited by {authority}` |
| Incident (mine) | `{ship} struck an underwater object believed to be a mine {where}. Crew safe. Hull −{n} %.` |
| Incident (projectile) | `{ship} was hit by an unidentified projectile {where}. Crew safe. Hull −{n} %.` |
| Incident (detention) | `{ship} was detained by coastal state authorities {where}. Crew safe. Expected release in {h} h.` |
| Total loss | `{ship} was abandoned after damage {where}. All crew evacuated safely.` |
| Sanction block | `Not allowed for your company: {measureText} ({srcShort}, {asOf}).` |
| Port refusal | `{harbour} port control refuses entry: {measureText} ({srcShort}).` |

Banned in data and templates (test `politics-wording`): `enemy`, `aggressor`, `terrorist`, `regime` (in prose; the
JSON key `regimes` is fine), `evil`, `heroic`, `glory`, `kill`, `dead`, `casualt`, `hostage`, `ransom`, `invader`,
`liberat`, plus the names of heads of state from a small list in the test. Area and country names follow the source's
own naming.

---

## 3. Data model

### 3.1 Files, versioning, size

All data is static JSON under **`shared/politics/`**. The client can fetch it (`/shared` is already served statically
by `server.js`), it is versioned with the code, and it is not under `data/`, which holds the runtime state and caches.

```
shared/politics/
  meta.json          { schema: 1, version: "2026.10.1", validAsOf: "2026-10-01", reviewBy: "2026-11-01", notes }
  sources.json       { [srcId]: { title, publisher, url, published: "YYYY-MM-DD", accessed: "YYYY-MM-DD", kind } }
  countries.json     { [cc]: Country }                       (all 124 harbour countries + bloc members needed by rules)
  ports.json         { [harborId]: PortOverride }            (only harbours that differ from their country's defaults)
  registries.json    { [registryId]: Registry }
  regimes.json       [ Regime ]                              (sanctions and port-entry measures)
  areas.json         [ Area ]                                (war-risk, warlike, piracy, ECA, corridor, warning; polygons)
  agreements.json    [ Agreement ]                           (customs unions, FTAs, cooperation arrangements)
  tariffs.json       { [cc]: { [good]: Rate } }              (WTO MFN simple averages per game good)
  trade.json         { year, unit: "USD m", flows: { [cc]: { [good]: Flow } } }   (server only)
  psc.json           { regimes: { [pscId]: PscRegime } }
shared/politics.js   pure rules (server, client and tests share it) — §8.1
scripts/politics/    validate.mjs, refresh.mjs, build-trade.mjs, build-discs.mjs (Node 20 built-ins only)
```

* **Size budget:** ≤ 400 KB raw for everything, ≤ 150 KB for what the client loads (all files except `trade.json`).
  Polygons ≤ 40 vertices, coordinates rounded to 0.01°. Trade flows: top 8 partners per (country, good). The validator
  fails if the budget is exceeded.
* **Versioning:** `meta.version` is `YYYY.MM.n`. Every data change bumps it. The server logs it at start-up, sends it in
  `/api/politics`, and the client shows it in the footer of the Rules tab and the Compliance panel. Saves store the
  version that was active when each contract was accepted (§4.17).
* **Effective dates:** every measure, area and status has `from` (and optionally `until`), as ISO dates. The game clock
  is real time (`simTime` = Unix seconds), so `isActive(rec, simTime)` compares directly. Future-dated records, such as
  an adopted ECA that is not yet in force, are kept and shown as "from {date}".

### 3.2 Record envelope (shared by every record)

```js
{ id: 'eu-ru-833-steel',          // stable, lowercase, [a-z0-9-]{3,48}
  src: ['eu-reg-833-2014'],       // ids into sources.json (≥ 1)
  asOf: '2026-10-01',             // date the maintainer checked it against the source
  reviewBy: '2026-11-01',         // conflict/status: asOf + 30 d; everything else: asOf + 365 d
  from: '2022-03-15', until: null,// in force (ISO dates; null = open-ended)
  basis: 'source',                // 'source' | 'game' — numbers the game tuned itself are 'game'
  verify: false,                  // seed rows from this document start true; the build lane clears it after checking
  note: 'short neutral note' }    // ≤ 140 chars, shown in tooltips
```

The validator **refuses a dataset with `verify: true` rows** unless it runs with `--allow-unverified`, which only the
test fixtures use. So no seed value from this document reaches players unchecked.

### 3.3 `countries.json` — Country

```js
'NL': {
  name: 'Netherlands', sovereign: 'NL',        // territories: GI→GB, FO/GL→DK, PR/GU→US, MQ/NC/PF→FR, CW→NL, HK→CN, FK→GB
  customs: 'EU',                               // customs territory id (an agreement id of kind 'customs_union'), or own cc
  follows: ['EU', 'UN'],                       // sanction authorities whose measures bind persons domiciled here
  psc: 'paris',                                // default PSC regime for its ports (ports.json may override per harbour)
  register: 'nl',                              // national registry id in registries.json (null if none modelled)
  cabotage: { rule: 'bloc', bloc: 'EU', cargo: true, passengers: true, src, asOf, ... },   // §3.13
  company: { formationDays: 3, local: 'none', basis: 'source'|'game', src, asOf },        // home move (§4.14)
  conflict: null | { areaIds: ['jwc-ua-ru-blacksea'], since: '2022-02-24', src, asOf },   // context line only
}
```

Territories have their own row because their customs and cabotage really differ. Gibraltar is outside the EU customs
territory. The Faroe Islands and Greenland are not in the EU. Martinique *is* in the EU customs territory. New
Caledonia, French Polynesia and Curaçao are not. Hong Kong is a separate customs territory. Puerto Rico and Guam fall
under US coastwise law. The validator checks that **every `country` used by `HARBORS` has a row** (124 today).

`follows` is how the home jurisdiction becomes sanctions applicability. The data says it plainly: for example, Norway
and Iceland have aligned with EU restrictive measures against Russia under their own national acts, so their rows say
`follows: ['NO', 'EU-aligned', 'UN']` and the matching `regimes` rows name the national act as the source. When a row
has no data, it holds `follows: ['UN']` only, with `basis: 'game'` and the note "national measures not modelled".

### 3.4 `ports.json` — PortOverride (only where a harbour differs)

```js
'odesa': {
  status: { value: 'restricted', reasons: ['corridor route required', 'martial law in force'], src, asOf, reviewBy, verify: true },
  entry:  { clearance: true, clearanceH: 2, validH: 72, corridor: 'ua-corridor',   // game-scaled hours (§4.1)
            deniedWhen: { flag: ['RU'] }, src, asOf },                              // only if the source says so
  services: { shipyard: true, fuel: true, market: true },                          // switch services off when the source says so
  psc: 'blacksea',                                                                   // override of country default
  programmes: ['ua-grain-corridor'],                                                // diplomatic contract programmes (§4.12)
  portIncident: { pCall: 0.015, basis: 'game', src: ['ukmto-advisories', 'reuters-odesa-port-strikes'] },  // §4.5
}
```

`status.value`: `open` (default for every harbour without a row), `restricted` (entry rules apply), or `closed` (dock
refused). A closed harbour stays on the chart in grey with the reason.

### 3.5 `registries.json` — Registry (flags)

```js
'lr': { name: 'Liberia', flag: 'LR', kind: 'open',                         // 'open' | 'national' | 'international' (second registers: NIS, DIS)
  owner: { rule: 'any' },                                                   // 'any' | { rule: 'home_in', cc: ['NL'] } | { rule: 'home_in_bloc', bloc: 'EU' } | { rule: 'any_with_agent', agentCrDay }
  age: { maxYears: null, inspectOverYears: 20 },                            // refuse registration above maxYears; special survey above inspectOverYears
  crew: { rule: 'any' },                                                    // 'any' | 'master_national' | 'officers_national' | 'crew_75_national'
  setupDays: 1, crewCostMul: 1.0,                                           // setupDays: source; crewCostMul: game
  fees: { initialCr: 2000, perTCr: 0.5, annualPerTCr: 0.2, basis: 'game' }, // per tonne of displacement
  src: ['lisr-requirements'], asOf, verify: true },
```

**Seed list (8 registries + the national ones), each to be checked on the registry's official site:**

| id | Flag | Kind | Owner rule (seed) | Age rule (seed) | Crew (seed) | Setup days (seed) | crewCostMul (game) |
|---|---|---|---|---|---|---|---|
| `pa` | Panama | open | any | special inspection > 20 y | any | 1 | 1.0 |
| `lr` | Liberia | open | any (via local corp. — modelled as `any`) | special evaluation > 20 y | any | 1 | 1.0 |
| `mh` | Marshall Islands | open | any (via local corp.) | special consideration > 20 y | any | 1 | 1.0 |
| `mt` | Malta | open, EU | `any_with_agent` (EU/EEA owner or resident agent) | approval needed > 25 y (seed) | any | 2 | 1.05 |
| `cy` | Cyprus | open, EU | `any_with_agent` | seed: survey > 17 y | any | 2 | 1.05 |
| `bs` | Bahamas | open | any (via local corp.) | special inspection > 12 y (seed) | any | 2 | 1.0 |
| `nis` | Norway (NIS) | international | `home_in_bloc: EEA` or agent | — | any (seed) | 5 | 1.15 |
| `dis` | Denmark (DIS) | international | `home_in_bloc: EU` | — | any (seed) | 5 | 1.15 |
| `national` (template) | home country | national | `home_in: [own cc]` (EU members: `home_in_bloc: EU`) | — | `master_national` | 10 | 1.25 |
| `us` | United States | national | `home_in: ['US']` (US-citizen company, 46 U.S.C. 50501) | — | `crew_75_national` (46 U.S.C. 8103) | 30 | 2.0 |

`crewCostMul` multiplies the class `crewCost` (the wage cost when you sail yourself and in `wageRateMcrH`). It is a
**game** number that stands in for the real cost of crew nationality rules. In wave 2, crew with nationalities can
replace it.

### 3.6 `regimes.json` — sanctions and port-entry measures

A **regime** is one legal instrument from one authority, holding one or more **measures**.

```js
{ id: 'eu-ru-833', authority: 'EU', title: 'Council Regulation (EU) No 833/2014 (as amended)', target: 'RU',
  src: ['eu-reg-833-2014', 'eu-sanctions-map'], asOf, reviewBy, from: '2014-07-31',
  measures: [
    { id: 'eu-ru-833-steel',  kind: 'import_ban', scope: 'personal+territorial', goods: ['steel'], origin: ['RU'], art: 'Art. 3g', from: '2022-03-15', enforce: 'block' },
    { id: 'eu-ru-833-mach',   kind: 'export_ban', scope: 'personal+territorial', goods: ['machinery'], to: ['RU'], art: 'Art. 3k (Annex XXIII)', from: '2022-04-08', enforce: 'block' },
    { id: 'eu-ru-833-oil',    kind: 'import_ban', scope: 'personal+territorial', goods: ['fuel'], origin: ['RU'], art: 'Art. 3m/3n', from: '2022-12-05', enforce: 'block',
      carriage: { allowedUnder: 'price_cap', note: 'transport to third countries only under the price cap' } },
    { id: 'eu-ru-833-port',   kind: 'port_ban', ports: { customs: ['EU'] }, when: { any: [ { flag: ['RU'] }, { flagWas: { cc: ['RU'], since: '2022-02-24' } } ] },
      art: 'Art. 3ea', from: '2022-04-16', enforce: 'refuse_entry' },
  ] }
```

**Measure kinds** (closed list, so the engine stays small):

| kind | Meaning | Checked in |
|---|---|---|
| `import_ban` | good × origin may not be bought (personal scope) or landed in the authority's territory (territorial scope) | `tradeCheck` buy/sell, `jobCheck` |
| `export_ban` | good may not be delivered or sold to country `to` (personal), or loaded in the territory for `to` (territorial) | `tradeCheck` sell, `jobCheck` |
| `service_ban` | persons of the authority may not carry good × origin (unless `allowedUnder`) | `jobCheck`, `tradeCheck` buy |
| `port_ban` | ports matching `ports` refuse vessels matching `when` | `entryCheck` |
| `entry_lockout` | after a matching call, ports `ports` refuse the vessel for `days` | `entryCheck`, `onDock` records the call |
| `tariff_add` | extra ad-valorem duty on good × origin into the territory | `tradeCheck` sell |
| `secondary` | exposure for *anyone* doing the listed action. On a later call at the authority's ports, a chance of seizure and designation | `onTrade`/`onDock` (§4.4 level 3) |
| `arms_embargo` | no contraband `weapons` job to, from or through the target; no state charter that carries machinery tagged dual-use | `jobCheck`, smuggling filter |

**`scope`:** `personal` binds companies whose `follows` contains the authority, and ships whose flag state follows it
(EU-flag ships are bound by EU law wherever they are). `territorial` binds anyone at a port of the authority's customs
territory. `personal+territorial` means both.

**Predicate language (`when`)** — JSON, evaluated by `matches(when, ctx)`:

```
{ all: [ … ] } | { any: [ … ] } | { not: … }
{ home: ['RU'] }                      company home country
{ follows: ['EU'] }                   company jurisdiction set contains
{ flag: ['RU'] }                      vessel flag now
{ flagWas: { cc: ['RU'], since: 'YYYY-MM-DD' } }   vessel flew it at any time since the date (flag history)
{ calledIn: { cc: ['CU'], days: 180, trade: true } } a call with cargo or contract work in that country within N real days (scaled, §4.1)
{ cargoOrigin: { cc: ['IR'], goods: ['fuel'] } }    such cargo aboard
{ designated: ['US'] }                company currently designated by that authority (§4.4)
```

**`enforce`:** `block` (the action is not possible), `refuse_entry` (the harbour master refuses to berth you),
`seize_on_entry` (cargo forfeited plus a fine if you dock with it), `designation` (secondary, §4.4). An optional
`windDownDays` (default 30) is how long contracts accepted before the measure started may still be finished (§4.17).

**Seed regimes (initial scope; every row starts `verify: true`):**

| id | Authority / instrument (source) | What the game models |
|---|---|---|
| `un-yemen` | UN Security Council res. 2216 (2015) and successors | arms embargo (targets named in the resolution, modelled as: no `weapons` contraband to YE) |
| `un-somalia` | UNSC res. 733 (1992), 2036 (2012) and successors | arms embargo; charcoal export ban (no game good — note only) |
| `un-libya` | UNSC res. 1970 (2011) and successors | arms embargo |
| `un-iran` | UNSC res. 2231 (2015) and its snapback provisions — **verify current status at build** | if in force: arms embargo + the listed goods mapped to `machinery` (dual-use) |
| `eu-ru-833` | Council Regulation (EU) No 833/2014 as amended | steel import ban (Art. 3g), machinery export ban (Annex XXIII scope, simplified), crude/products import ban + price-cap carriage (Art. 3m/3n), port ban on RU-flag and ex-RU-flag ships (Art. 3ea) |
| `uk-ru-2019` | The Russia (Sanctions) (EU Exit) Regulations 2019 as amended | port ban on RU-flag, RU-registered, and RU-owned/controlled ships (modelled as `flag: RU` or `home: RU`); iron/steel import ban; oil import ban + price-cap carriage; machinery export ban (simplified) |
| `us-ru-eo14068` / `us-ru-eo14071` | US Executive Orders 14068 (2022) and 14071 (2022), OFAC | import ban on RU-origin fish and seafood (EO 14068) and on energy products (EO 14066); price-cap carriage; US port ban on RU-flag/owned vessels (Federal Register notice of April 2022 — verify) |
| `ca-ru-sema` | Canada, Special Economic Measures (Russia) Regulations | port ban on RU vessels; steel import ban — verify scope |
| `ru-countermeasures` | Russian Federation Presidential Decree No. 560 (2014) as extended, and Government decree on food import restrictions | import ban on `fish` (and other agricultural goods; `grain` is not covered — verify) from countries listed in the decree (EU, US, CA, AU, NO, GB, …): territorial scope at RU ports |
| `us-cu-cacr` | US Cuban Assets Control Regulations, 31 CFR Part 515, incl. §515.207 | personal: US companies may not trade with CU; **entry_lockout**: a vessel that called in CU to load or discharge freight may not load or unload in a US port for 180 days |
| `us-ir-itsr` | US Iranian Transactions and Sanctions Regulations, 31 CFR Part 560; secondary sanctions on petroleum trade | personal: US companies may not trade with IR; **secondary**: anyone buying IR-origin `fuel` gets exposure (§4.4) |
| `eu-ir` / `uk-ir` | Council Regulation (EU) No 267/2012 as amended; UK Iran (Sanctions) Regulations — verify which goods bans are in force | arms embargo; dual-use machinery export ban |
| `us-ve` | US Venezuela-related sanctions (EO 13884 and others), OFAC — **verify current status** | personal: PdVSA-linked `fuel` purchases blocked, if still in force |
| `us-232-steel` | US Proclamations under Section 232 (steel) — **verify the rate in force at build** | `tariff_add` on `steel` into US customs territory (rate per origin from the proclamation) |

To research before activation (dropped if they cannot be confirmed from an official text): port closures that one
Mediterranean state applies to another's vessels; a Red Sea shipping-targeting profile (§3.7 `profile`); Belarus
measures (no harbour in the game; transit relevance only); China export-control and countermeasure lists at goods level.

### 3.7 `areas.json` — Area (polygons)

```js
{ id: 'jwc-ua-ru-blacksea', kind: 'war_risk',          // 'war_risk' | 'warlike' | 'piracy' | 'eca' | 'corridor' | 'warning'
  name: 'Waters of Ukraine and Russia in the Black Sea and Sea of Azov',   // as the source names it
  poly: [[[lon, lat], …]],                               // one or more rings, ≤ 40 vertices each, 0.01° precision, closed
  bbox: [w, s, e, n],                                    // written by build-discs.mjs
  discs: [{ lat, lon, rKm }],                            // ≤ 3 covering discs for the route planner (build-discs.mjs)
  // war_risk
  tier: 4, apPct: 1.0, apBasis: 'source',                // additional premium, % of hull value per call/transit (≤ 7-day cover)
  pDay: 0.006, pBasis: 'game',                           // incident chance per day inside (game-tuned)
  mix: { mine: 0.5, projectile: 0.45, detention: 0.05 }, // incident type shares (game, informed by the advisories)
  profile: null,                                         // optional { when: Predicate, mul: 3, src } — only from an advisory that states it
  // warlike (IBF/JNG list): crewPayMul: 2 (IBF: 100 % bonus on basic wage in a warlike operations area)
  // piracy:  p100: 0.004 (chance per 100 km transited, game), kinds: { robbery: 0.7, repelled: 0.25, hijack: 0.05 }
  // eca:     sulphurPct: 0.10, nox: 'tier3'|null, from: '2025-05-01'
  // corridor: line: [[lon, lat], …], to: ['odesa'], escort: false, inspection: null | { at: 'istanbul', hours: 2 }
  // warning: text: 'GNSS interference reported', navarea: 'III'
  src: ['jwc-jwla-0xx', 'reuters-ap-ukraine'], asOf, reviewBy, from, verify: true }
```

**War-risk tiers** set the colour and the default numbers when a source gives only a listing:

| Tier | Typical real situation (examples) | `apPct` default (seed, verify) | `pDay` (game) | Contract pay multiplier `RISK_PAY` (game) |
|---|---|---|---|---|
| 1 | listed, low activity (parts of the Persian Gulf in calm periods, Gulf of Guinea coastal listing) | 0.05 % | 0.0002 | +10 % |
| 2 | elevated (Israel ports, Lebanon, Libya, Venezuela listings) | 0.2 % | 0.001 | +40 % |
| 3 | high: repeated attacks on merchant ships (southern Red Sea / Bab-el-Mandeb / Gulf of Aden in 2024; Russian Black Sea waters) | 0.7 % | 0.004 | +120 % |
| 4 | port in an active war zone with strikes on port areas (Ukrainian Black Sea ports) | 1.0 % | 0.006, plus `portIncident.pCall` 0.015 per call | +200 % |

`apPct` is a market rate. Each area stores **its own reported rate** with a dated source, such as market reporting by
Lloyd's List, Reuters or the broker circulars quoting them. The tier default is only a fallback. Real war premiums have
ranged from about 0.05 % (Gulf listings in quiet periods) to about 1 % of hull value (Ukraine 2023, Red Sea 2024) and
higher for some profiles. The build lane enters the rate that its source reports.

**Seed areas (all `verify: true`; geometry transcribed from the source):**

| id | kind | Source to transcribe | Seed numbers |
|---|---|---|---|
| `jwc-ua-ru-blacksea` | war_risk, tier 4 near Ukrainian ports / tier 3 elsewhere (two polygons) | JWC Listed Areas circular in force (JWLA-0xx) | Ukraine ports 1.0 % per call; RU Black Sea and Azov 0.7 % (seed) |
| `jwc-redsea-aden` | war_risk tier 3 | JWC JLA circular in force | 0.7 % per transit (2024 market reports) — verify current |
| `jwc-israel` | war_risk tier 2 | JWC | 0.2–0.5 % — verify |
| `jwc-gulf` | war_risk tier 1 | JWC (Persian Gulf and adjacent waters, Gulf of Oman west of the listed meridian) | 0.05–0.2 % — verify, spikes recorded as dated updates |
| `jwc-gulf-guinea`, `jwc-somalia`, `jwc-libya`, `jwc-venezuela`, `jwc-lebanon`, `jwc-yemen` | war_risk | JWC | tier per listing |
| `ibf-warlike-*` | warlike | IBF / Joint Negotiating Group warlike-operations area list in force | `crewPayMul: 2` |
| `hra-bmp` | piracy | BMP Maritime Security (industry guidance; successor of BMP5) high-risk / voluntary reporting area | p100 0.003 |
| `piracy-gog` | piracy | BMP West Africa / IMB PRC annual report (Gulf of Guinea) | p100 0.004 |
| `piracy-sgstrait` | piracy | IMB PRC annual report, ReCAAP ISC (Singapore Strait: mostly petty theft) | p100 0.002, kinds robbery 0.9 / repelled 0.1 |
| `eca-baltic`, `eca-northsea`, `eca-na`, `eca-uscarib`, `eca-med` | eca | MARPOL Annex VI, Regulation 14 and Appendix VII coordinates; Mediterranean SOx ECA in effect from **2025-05-01** | 0.10 % S; NOx Tier III for Baltic/North Sea (ships built from 2021) and North America/US Caribbean |
| `eca-canarctic`, `eca-norsea` | eca | IMO MEPC resolutions adopting the Canadian Arctic and Norwegian Sea ECAs (2025) — **verify the effective date** | `from` = effective date |
| `ua-corridor` | corridor | Ukrainian Navy / Ministry notices on the temporary Black Sea corridor (since Aug 2023), UKMTO advisories | `line` from the Bosporus northern entrance along the western Black Sea to Greater Odesa ports; `escort: false` |
| `irtc` | corridor | MSCHOA / UKMTO: Internationally Recommended Transit Corridor, Gulf of Aden | group-transit timing note |
| `gnss-baltic`, `gnss-emed`, `gnss-gulf`, `gnss-blacksea` | warning | NAVAREA warnings, national authority notices, EASA safety information bulletins | display only in phase 1 (§4.5) |

### 3.8 `agreements.json` — customs unions, FTAs, cooperation

```js
{ id: 'eu-cu', kind: 'customs_union', name: 'EU Customs Union', members: ['AT', 'BE', …, 'MQ'],   // territories listed explicitly
  partial: [{ cc: 'TR', goods: ['steel', 'machinery', 'containers'] }],     // EU–Türkiye customs union: industrial goods only
  dutyInside: 0, paperwork: 'none', src: ['eu-ucc-952-2013'], from: '1968-07-01' }
{ id: 'usmca', kind: 'fta', name: 'USMCA / CUSMA / T-MEC', members: ['US', 'CA', 'MX'], prefRate: 0, paperwork: 'origin_proof', goods: 'all', from: '2020-07-01' }
```

Seed rows (check membership and dates on the official texts): EU customs union (with the EU–TR partial union and the
EU–AD/SM unions as notes); EEA (EU + NO, IS, LI: an FTA for industrial goods and fish rules — mark fish `partial`);
UK–EU Trade and Cooperation Agreement (2021); USMCA (2020); ASEAN Trade in Goods Agreement (ATIGA); RCEP (2022); CPTPP
(including the UK from 2024-12-15 — verify); Mercosur (AR, BR, PY, UY customs union, with an imperfect common
external tariff — modelled as `customs_union` with a note); GCC Customs Union; SACU; EAEU; ECOWAS CET; AfCFTA
(`prefRate` only where the tariff schedules are in force — default `partial: []`, note "being phased in");
EU–Mercosur (if concluded but not in force: `from: null`, shown as "signed, not in force").

`kind: 'cooperation'` rows hold non-tariff arrangements that the contract types use, such as a grain-export
arrangement: `{ id: 'ua-grain-corridor', kind: 'cooperation', programme: {...} }` (§4.12). The Black Sea Grain
Initiative (Istanbul, July 2022 – July 2023) is kept as a **historical** row with `until: '2023-07-17'`, so the corridor
contract's info card can explain where the current arrangement comes from.

### 3.9 `tariffs.json` — WTO MFN duty per game good

`{ 'US': { grain: { rate: 0.035, basis: 'source', src: ['wto-wtp-2025'], asOf }, … } }`. The rate is the MFN applied
**simple average** of the WTO World Tariff Profiles product group that each game good maps to:

| Game good | WTO product group (World Tariff Profiles) |
|---|---|
| grain | Cereals and preparations |
| fish | Fish and fish products |
| steel | Minerals and metals |
| machinery | Non-electrical machinery (with electrical machinery averaged in, 50/50) |
| containers (general manufactured cargo) | Manufactures n.e.s. |
| fuel | Petroleum |
| supplies | not dutiable (offshore supply, no import) |

A country without a row has `rate: null`, shown as "duty not modelled (no data)", and charges nothing. That is honest
and safe.

### 3.10 `trade.json` — condensed real trade flows (server only)

```js
{ year: 2023, unit: 'USD m', src: ['cepii-baci-2025'], asOf,
  flows: { 'UA': { grain: { exp: 9800, imp: 120, top: [['ES', 0.14], ['CN', 0.12], ['TR', 0.09], …] }, … } } }
```

* Built by `scripts/politics/build-trade.mjs` from a **CEPII BACI** CSV (HS6 bilateral flows, harmonised from UN
  Comtrade). The maintainer downloads it. The script maps HS chapters to game goods (grain: HS 10 + 11 + 1201; fish:
  HS 03 + 1604/1605; steel: HS 72 + 73; machinery: HS 84 + 85; fuel: HS 27; containers: HS 39–40, 61–64, 94–96 as a
  manufactured-goods proxy). It keeps the top 8 partners per (exporter, good) as shares, plus totals. ~124 × 6 × 8
  entries, ≈ 60 KB.
* The numbers in the example above only show the shape. The real values come from the file.
* Tests use a fixture, never the real file (§7), so refreshing the data never breaks a test.

### 3.11 `psc.json` — port state control regimes

```js
{ regimes: {
  paris: { name: 'Paris MoU', members: ['BE','BG','CA','HR','CY','DK','EE','FI','FR','DE','GR','IS','IE','IT','LV','LT','MT','NL','NO','PL','PT','RO','SI','ES','SE','GB'],
           suspended: [{ cc: 'RU', from: '2022-03-??', src }],                       // Russian Federation membership suspended in 2022 — verify date
           lists: { year: 2025, white: [...], grey: [...], black: [...] , src: ['parismou-wgb-2025'] },   // annual White/Grey/Black list
           windowsH: { LRS: 900, SRS: 330, HRS: 165 }, pInspect: { LRS: 0.04, SRS: 0.12, HRS: 0.30 }, basis: 'game', src: ['parismou-nir'] },
  tokyo: { … }, blacksea: { … }, med: { … }, iomou: { … }, abuja: { … }, vinadelmar: { … }, caribbean: { … }, riyadh: { … },
  uscg: { name: 'US Coast Guard PSC', members: ['US','PR','GU'], lists: { targetedFlags: [...], src: ['uscg-psc-annual'] }, … } } }
```

Membership comes from each MoU's own site. The lists come from each regime's latest annual report (Paris MoU publishes
its White/Grey/Black list every year; USCG publishes its targeted flag list in its annual PSC report). Countries in two
regimes (CA, AU, RU…) get a per-harbour `psc` override in `ports.json` by ocean (e.g. `vancouver: tokyo`,
`halifax: paris`).

### 3.12 Cabotage (inside `countries.json`)

```js
cabotage: { rule: 'national' | 'bloc' | 'licence' | 'open' | 'nodata',
            bloc: 'EU',                         // rule 'bloc': any flag of the bloc
            builtIn: 'US',                      // US: coastwise vessels must be US-built (46 U.S.C. 55102)
            ownerHome: ['US'],                  // US: owned by US citizens (company home US)
            cargo: true, passengers: true,
            licence: { days: 3, feeCr: 2500 },  // rule 'licence' (e.g. Australia's temporary licences under the Coastal Trading Act 2012)
            territory: ['US', 'PR', 'GU'],      // domestic = from and to inside this set
            src, asOf, verify: true }
```

Seed: US (Jones Act, Merchant Marine Act 1920 §27, 46 U.S.C. §55102; passengers: Passenger Vessel Services Act, 46
U.S.C. §55103) `national` + `builtIn` + `ownerHome`, territory US+PR+GU (verify Guam); EU members `bloc: EU` (Council
Regulation (EEC) No 3577/92); CN `national`; JP `national`; BR `national` with a licence route under the BR do Mar law
(2022) — verify; AU `licence`; CA `national` with a waiver licence (Coasting Trade Act) — `licence`; RU `national`
(Merchant Shipping Code, Art. 4); IN — verify (relaxed for some cargo since 2018); ID `national` (Shipping Law
17/2008). Everything else `nodata`, which the game treats as open and shows as "cabotage not modelled".

### 3.13 Initial dataset scope (what is in version 2026.10.1)

* **Every harbour country (124):** a `countries.json` row with `customs`, `follows` (at least `UN`), `psc`,
  `register`, and `cabotage` (`nodata` when unknown). This is enough for every harbour to show a Rules tab.
* **Full detail (seed tables above) for ~35 countries** where the game's traffic and the request's examples are: the
  North Sea detail region (NL, BE, FR, GB, IE, DE, DK, SE, NO, IS), the Baltic (PL, FI, LT, LV, EE, RU), the Black Sea
  (UA, RU, RO, BG, TR), the Red Sea and Gulf (EG, SA, YE, DJ, SD, IL, JO, OM, AE, IR, IQ, KW, QA, BH), and US, CA, CN,
  SG, PA, CU, VE.
* **Areas:** the JWC listing in force (all areas that touch a game harbour or sea lane), the IBF warlike list, the piracy
  areas above, all ECAs, two corridors (Ukraine and the IRTC), four GNSS warnings.
* **Regimes:** the seed table in §3.6. **Agreements:** the seed list in §3.8. **Tariffs:** the ~35 detail countries.
  **Trade:** all countries available in BACI.
* **Staying small:** goods are the game's 7 goods, not HS codes; country-level rules only, no entity lists; polygons
  capped at 40 vertices; top 8 trade partners; one record per instrument with a short `art` reference instead of
  copied legal text.

### 3.14 Keeping it current — `scripts/politics/`

| Script | What it does |
|---|---|
| `validate.mjs [--allow-unverified]` | Schema check of every file. Checks that every source id resolves, that dates are ISO, and that `asOf ≤ today`. Polygons must be closed, non-self-intersecting (O(n²) test, n ≤ 40), counter-clockwise outer rings, and ≤ 40 vertices. Every harbour country has a row. Every `members`/`cc` is a known ISO code (cross-checked against `server/ais/mid.js` plus a small built-in list for non-maritime states). Country ids exist. Tiers 1–4 only. Shares in `trade` sum to ≤ 1. Checks the size budget, refuses `verify: true` rows, and refuses banned words (§2.1). Exit code 1 on any error. |
| `refresh.mjs [--links] [--stale] [--bump]` | `--stale`: lists every record past `reviewBy`, conflict records first. `--links`: HEAD/GET every source URL (Node `fetch`, 10 s timeout) and lists dead ones. `--bump`: sets `meta.version` to the next `YYYY.MM.n` and `validAsOf` to today. It never edits rules by itself: legal texts, JWC circulars and insurer rates need a human to read them. |
| `build-trade.mjs <baci.csv> [--year 2023]` | Streams the CSV line by line (no dependencies), maps HS → goods, writes `trade.json`, and prints the top movers against the previous file. |
| `build-discs.mjs` | For each area: bbox, and up to 3 covering discs (greedy: the minimum enclosing circle of the polygon; if r > 600 km, split along the longer bbox axis, recurse to depth 2) for the route planner's avoid discs (`rKm` ≤ 600 to fit `parseRouteQuery`). |

Maintainer checklist per update (also printed by `refresh.mjs --stale`): (1) the JWC circular in force; (2) the IBF
warlike list; (3) UKMTO / JMIC / MSCHOA advisories for port status and corridors; (4) the EU Sanctions Map, the UK
sanctions list guidance (OFSI/OTSI), OFAC programme pages and UN Security Council sanctions committees, for the goods
measures in the seed table; (5) the Paris and Tokyo MoU annual flag lists (in summer); (6) WTO World Tariff Profiles
(yearly); (7) the BACI release (yearly); (8) IMO MEPC outcomes for ECAs. Then run `validate.mjs` and `--bump`.

---

## 4. Gameplay rules

### 4.1 Constants (`shared/politics.js`, `POL`)

```js
export const POL = {
  DAY_TO_H: 1,              // one real-world day of paperwork/waiting = one game hour (world clock). Scales registry setup,
                            // company formation, detention, lockouts, wind-down. Voyages themselves stay real-time.
  COVER_MAX_H: 168,         // one war-cover purchase covers one entry until exit, at most 7 days (the market's 7-day period)
  RISK_PAY: { 1: 0.10, 2: 0.40, 3: 1.20, 4: 2.00 },
  TIER_AP: { 1: 0.0005, 2: 0.002, 3: 0.007, 4: 0.010 },      // fallback fraction of hull value
  TIER_PDAY: { 1: 0.0002, 2: 0.001, 3: 0.004, 4: 0.006 },
  OUTCOME: { minor: [0.70, 8], major: [0.95, 30], loss: [1.00, 100] },   // cumulative share, hull points lost
  MAJOR_CARGO_LOSS: 0.25,
  DETENTION_H: [6, 24],     // war-risk detention by a coastal state (uniform)
  PIRACY_MIT: { speedKn: 18, speedMul: 0.3, convoyMul: 0.5, guardsMul: 0.2, guardsCrPerDay: 2500, guardsMin: 1500 },
  HIJACK_H: 12, HIJACK_COST_FRAC: 0.05,        // held 12 h; costs 5 % of hull value (covered when war cover is active)
  ROBBERY_FRAC: 0.02, ROBBERY_MAX: 5000,       // stores/cash taken
  PSC_POINTS_HRS: 4, PSC_DETAIN: [[80, 0.02], [60, 0.06], [40, 0.15], [0, 0.40]],
  PSC_RELEASE_COND: 60, PSC_MIN_HOLD_H: 1, PSC_FEE: 1500,
  ECA_SURCHARGE: 0.35,      // extra fuel cost per tonne burned inside an SOx ECA, × GOODS.fuel.base (650) = 227.5 cr/t
  CUSTOMS_FEE: { none: 0, origin_proof: 50, mfn: 150 },
  SEIZE_FINE_MULT: 2, SEIZE_FINE_MIN: 10000,
  DESIGNATION_P: 0.25, DESIGNATION_DAYS: 30, EXPOSURE_DAYS: 365,
  REP: { min: -100, max: 100, deliver: 1, deliverCapDay: 2, humanitarian: 5, charter: 3, late: -1,
         detention: -5, detentionRegime: -2, seizure: -20, breach: -5, charterMin: 20, trusted: 40, watched: -30, banned: -60, banDays: 7 },
  WIND_DOWN_DAYS: 30, FRUSTRATION_PAY: 0.25,
  CLEARANCE_H: 2, CLEARANCE_VALID_H: 72,
  FORMATION_FEE: 5000, AGE_YEARS_PER_COND: 3.5,
};
```

Every value here is `basis: 'game'` unless the dataset overrides it with a sourced number (`apPct`, `crewPayMul`,
`setupDays`, `formationDays`, MFN rates, cabotage, measures).

### 4.2 Who must follow what (jurisdiction)

`ctxOf(player | actor, vessel)` → `Ctx`:

```js
{ home: 'NL',                                  // country of office.home (harborById(office.home).country)
  follows: Set(['EU', 'UN']),                  // countries[home].follows ∪ countries[flag].follows for flag-state rules
  flag: 'NL', flagWas: [{ cc, from, until }],  // vessel.flag + history
  customs: 'EU',                               // countries[home].customs
  rep: { … }, designated: { US: untilS }, exposure: [{ auth, at }], lockouts: [{ ports: {...}, until }],
  calls: [{ cc, at, trade }],                  // last 40 calls (for calledIn predicates)
  simTime }
```

* **Company (personal) measures** bind via `countries[home].follows`.
* **Flag-state measures** bind via the vessel's flag: an EU-flag ship is bound by EU measures even if the company is
  domiciled elsewhere (`personal` scope: `follows(home) ∪ follows(flag)`).
* **Territorial measures** bind anyone at a port of that customs territory.
* **UN measures** bind everyone.

### 4.3 Checks (all pure functions in `shared/politics.js`; the server is the authority, the client uses the same code for previews)

| When | Function | Blocks / does |
|---|---|---|
| Buying goods (`tradeGoods` buy) | `tradeCheck(ds, ctx, { harbor, good, side: 'buy' })` | `import_ban` / `service_ban` (personal) on good × origin = harbour country; `export_ban` (territorial) is not checked at purchase |
| Selling goods (`tradeGoods` sell) | `tradeCheck(… side: 'sell', origin)` | `import_ban` (territorial at this port; personal too); `export_ban` (personal: selling to this country); returns duty (§4.9) |
| Accepting a contract | `jobCheck(ds, ctx, job)` | import/export/service bans on (job.good, origin = from-country, destination = to-country); `port_ban` / `entry_lockout` at the destination that would refuse this vessel; destination `closed`; cabotage (§4.10); `arms_embargo`; job `needs` (rep, flag). Warnings (not blocks): war-risk areas and premiums, corridor required, ECA, piracy, PSC regime |
| Docking (before mooring in `dock()` / quay docking) | `entryCheck(ds, ctx, harbor)` | `closed` → refuse; `port_ban` → refuse; `entry_lockout` → refuse; restricted without clearance → refuse with "request clearance" |
| Docked (`finishDock`) | `politics.onDock(p, h)` | records the call; `seize_on_entry` cargo; PSC roll; port incident roll (tier-4 ports); secondary designation roll; war-cover refund on delivery |
| At sea (1 Hz per ship) | `politics.stepSea(p, hrs)` | area entry/exit → cover purchase / IBF wage multiplier / incident rolls / ECA surcharge / piracy rolls / mustAvoid breach tracking |
| Express passage | `politics.expressCheck(p, route)` | refuses ending inside a tier ≥ 3 area; rolls the integrated exposure once |
| Captain order / contract | `captainRefusal(job, ctx)` (extended) + `riskPolicyAllows` | §4.16 |

### 4.4 Consequences ladder

| Level | Trigger | What happens | Numbers |
|---|---|---|---|
| 0 — blocked | Any legal action that breaks a measure that applies to you (P4) | The button is disabled with the reason, source and date. If sent anyway, the server answers with a `law` event. Nothing else happens. | — |
| 1 — refused entry | Port ban, closed port, Cuba lockout, restricted port without clearance, company banned by low reputation | `dock()` refuses before mooring. No dues. The pre-voyage check warned you. | — |
| 2 — seizure on entry | You dock with cargo that the port's territory bans by origin (e.g. you legally bought RU-origin fuel as a non-EU company and dock in Rotterdam with it). The risk check and the Rules tab both warn first. | Cargo forfeited. Fine = max(`SEIZE_FINE_MIN`, `SEIZE_FINE_MULT` × cargo value at the local price). Unpaid → the existing `impound()`. Rep −20 in that country. | coaster with 500 t fuel at 650 cr/t: 325,000 value → fine 650,000 |
| 2 — PSC detention | §4.7 | Held until hull ≥ 60 % and ≥ 1 h, fee 1,500 | — |
| 3 — designation (secondary) | You performed an action with a `secondary` measure (exposure recorded for 365 real days, scaled) and you dock in that authority's territory | Roll `DESIGNATION_P` = 25 % once per exposure. On a hit: matching cargo seized as in level 2, the company is **designated** for 30 days (scaled → 30 h): refused entry at all that authority's ports, and `bankFlags()` reports `designated:US` (wave 2 bank: no new credit). | — |
| 4 — reputation ban | rep ≤ −60 in a country | Refused entry at that country's ports for 7 game days. Rep recovers +1 per real day toward 0. | — |

**Bank hook (wave 2, later):** `politics.bankFlags(office)` → `['designated:US', 'seizure_30d', 'detentions_3']`. Wave
2's bank reads it: designated → no new credit; a seizure in the last 30 days → rating −1 step. Nothing in this
contract changes money flows of the bank itself.

### 4.5 War risk

**Cover (the additional premium).**

* `hullValue(cls, cond) = round(hullBasis(cls) × (0.4 + 0.45 × cond / 100))`. This is wave 2's `marketValue` without
  components, and it uses `economy.hullBasis`, so the coaster is valued at 120,000. Examples: coaster at 78 % → 90,120;
  feeder at 100 % → 807,500; tanker at 100 % → 3,570,000.
* `warPremium(area, cls, cond) = round(hullValue × apPct / 100)`. Coaster at 78 % into a 1.0 % area → **901 cr**. Feeder
  through a 0.7 % area → **5,653 cr**. Tanker through 0.7 % → **24,990 cr**. Booked to the ledger category `fees`, with
  the line text "War risk additional premium — {area} ({srcShort})".
* **When it is charged:** on entry into a `war_risk` polygon, or at departure if the ship starts inside one. Cover lasts
  until exit, or `COVER_MAX_H` (168 h), after which it is charged again. Each area is charged separately; one area
  covers both directions of one transit.
* **Office setting `warCover`:** `auto` (default: charged silently with an event line) or `ask` (a card appears at the
  boundary: [Buy cover x cr] [Sail uninsured]). After 10 minutes of world clock without an answer, you sail uninsured.
  Captains always buy cover (§4.16).
* **Effect of cover:** incident hull damage is credited at the next repair within 30 days (repair price of those points,
  minus nothing — war cover has no deductible in v1). A total loss pays `hullValue` to cash. Hijack costs are paid.
  **Without cover**, you pay everything. If wave 2 insurance lands first, war cover becomes an add-on to its hull
  policy (same numbers; its deductible rules then apply).
* **Refund by the shipper:** contracts with `job.pol.tier > 0` refund the premiums paid for that voyage's areas when you
  deliver. Real voyage charter war clauses (BIMCO VOYWAR) put the additional premium on the charterer. Shown on the
  contract card: "War premium refunded on delivery".

**Crew pay in warlike areas.** Inside an `warlike` polygon, the crew part of the wage is multiplied by `crewPayMul`
(2.0). This applies to the class `crewCost` when you sail yourself (`stepAtSea`) and to the crew part of
`wageRateMcrH` for captained ships. The captain's own rate is unchanged. Event: "IBF warlike operations area: crew on
double basic pay (IBF/JNG list, {asOf})."

**Incidents at sea.**

* `pHour = 1 − (1 − pDay × profileMul) ^ (1/24)`, rolled every ship-hour slice inside the area (`hrs` from `stepAtSea`,
  so warp does not dodge it). Over a whole transit, `P = 1 − (1 − pDay×mul)^days`.
* Feeder at 18 kn across 1,100 km of a tier-3 area: 1,100 / 33.336 km/h = 33.0 h = 1.375 days →
  `P = 1 − 0.996^1.375 = 0.55 %`. With a sourced profile multiplier of 3: `1 − 0.988^1.375 = 1.65 %`.
* Incident type: drawn from `mix`. Outcome: `r < 0.70` minor (hull −8), `< 0.95` major (hull −30, 25 % of each
  non-contract cargo stack lost, contract cargo short-delivered), else total loss (`sink(p, 'war_loss')`, crew
  evacuated, the existing rescue/landing flow). A detention holds the ship `DETENTION_H` 6–24 h at her position
  (`p.held = { until, why }`: engine locked, warp off), then releases her.
* **Port incident** (tier-4 ports with `portIncident`): one roll on `finishDock` with `pCall` (seed 1.5 %), same
  outcome table. Seed basis: thousands of calls through the Ukrainian corridor since August 2023 against a few dozen
  reported ship-damage incidents (UKMTO / press reports) give well under 1 % per call. The game rounds up to 1.5 % so
  the risk is felt, and labels it "Game rule".

**Corridors.** A port with `entry.corridor` needs the corridor route:

* **Clearance:** a [Request clearance] button (Rules tab of the port, and on the contract card). It is issued after
  `CLEARANCE_H` = 2 h of world clock, valid 72 h, refused if `deniedWhen` matches. Without clearance, the port refuses
  entry (level 1).
* **Route:** the route planner gets the corridor `line` as user waypoints (`opts.wp`, ≤ 50 points), so the ship follows
  it. Leaving the corridor by more than 10 km while inside the war-risk area multiplies `pDay` by 3 for mines (`mix.mine`
  share only) and shows "Off the corridor — mine risk higher (advisory {src})".
* **Inspection:** if the corridor has `inspection`, the ship must stop within 3 km of the inspection point for
  `inspection.hours`. This exists for historical/fixture use; the current Ukrainian corridor seed has `inspection: null`.

**GNSS warnings** (phase 1: display only): a chart overlay and a Rules line "GNSS interference reported in this area
({src}, {asOf}) — cross-check position by radar". A later phase can add position jitter to the chart (open question
Q6).

### 4.6 Piracy

* Inside a `piracy` polygon, per km sailed: `P(100 km) = p100 × mitigations`. Rolled per km step, with
  `p_km = 1 − (1 − p100×mit)^(km/100)`. 600 km of the Gulf of Guinea at p100 0.004, no mitigation: `1 − 0.996^6 =
  2.38 %`.
* Mitigations (multiply): speed ≥ 18 kn ×0.3 (industry guidance: few successful boardings of fast ships); in a convoy
  (existing `convoyId`) ×0.5; armed guards ×0.2. Guards are bought in the Rules tab of the last port before the area,
  at `max(1500, 2500 × planned days in area)` cr, for one transit.
* Outcomes from `kinds`: **robbery** (stores/cash taken: `min(5000, 2 % of cash)`, crew safe), **repelled** (hull −3,
  rep +1 with the coastal state for reporting), **hijack** (ship held 12 h, costs 5 % of hull value, paid by war cover
  if active; text: "Ship held; released after 12 h. Crew safe."). No ransom or hostage wording (P5).
* Captains: §4.16. NPC piracy is an abstract roll; player-against-player boarding (`game.board`) is unchanged.

### 4.7 Port state control

* **Regime** = `ports[h].psc ?? countries[h.country].psc`. No regime: no PSC.
* **Ship age:** new field `vessel.built` (year). New ships: the current year. Used listings: `year − round((100 −
  cond) / 3.5)`. Migration: the same formula on the current `cond`, clamped 0–30 years.
* **Risk points:** age > 12 y +1; tanker/bulker/ferry and age > 12 y +1; flag on the regime's black list +2, grey list
  +1, not listed +1, white 0; hull < 60 % +1; company detentions in this regime in the last 30 days: ≥1 +1, ≥3 +2.
* **Profile:** `HRS` if points ≥ 4; `LRS` if points = 0 and the flag is white and the company has no detention ever;
  otherwise `SRS`.
* **Inspection** on `finishDock`: none if the last inspection in this regime was within `windowsH[profile]` (LRS 900 h,
  SRS 330 h, HRS 165 h of world clock, scaled from the real 24–36 / 10–12 / 5–6 month windows). Otherwise roll
  `pInspect[profile]` (LRS 4 %, SRS 12 %, HRS 30 %). This roll is separate from the existing contraband port inspection
  (`LAW.PORT_INSPECT_CHANCE`), which stays.
* **Detention** given inspection: by hull condition, ≥ 80 → 2 %, ≥ 60 → 6 %, ≥ 40 → 15 %, below → 40 % (Paris MoU
  average detention rate is a few percent of inspections; the game skews it by condition). Detained: the ship cannot
  undock until hull ≥ 60 % (repair in the yard) and ≥ 1 h has passed. Fee 1,500 cr. Rep −5 in that country, −2 in the
  other members of the regime. Logged in the Compliance panel (real regimes publish detention lists).
* Starter coaster (NL flag, white list — verify, 6 years, 78 %, no history): 0 points → LRS → 4 % per call, and 2 %
  detention given inspection.

### 4.8 Emission control areas

* Inside an `eca` polygon with `sulphurPct ≤ 0.10` and `from ≤ now`: every tonne of fuel burned costs an extra
  `ECA_SURCHARGE × GOODS.fuel.base` = 227.5 cr/t (MGO instead of VLSFO; booked to `fuel` as "ECA fuel switch"). Ships
  with a scrubber (v7 #7 upgrade flag `v.scrubber`) are exempt. Example: 2.0 t burned inside → 455 cr.
* The fuel the ship carries is not split into two grades (no new tanks). The surcharge is the whole model.
* NOx Tier III: shown on the Rules tab only ("applies to engines installed on ships built from {year}"). No cost in v1.
* Note: the default start region (North Sea) is an ECA, so every new player pays this from the first voyage. The
  surcharge is small next to contract pay (a coaster burns roughly 1–2 t per 100 km at service speed). Open question Q1
  covers switching it off.

### 4.9 Customs and duties

* **Origin** is a new field on cargo stacks. Bought goods: the harbour's country. Fish you caught yourself: **the
  vessel's flag** (the real "wholly obtained" rule for sea fishing: the catch takes the flag state's origin). Contract
  cargo: the job's from-country (the shipper clears it; you pay no duty). Legacy stacks: `origin: null` = "origin
  unknown", which pays the MFN rate and is never sanction-matched.
* Stacks merge only with the same `good` and `origin` (`tradeGoods` buy changes its `find`). Selling consumes stacks
  first-in-first-out, with duty per stack.
* **Duty on a spot sale** of a stack of origin `o` at a harbour of country `d`:
  * same customs territory, or both in one `customs_union` covering the good → **0**, fee 0;
  * an FTA in force covering both and the good → `prefRate` (usually 0), fee `origin_proof` 50 cr;
  * otherwise → MFN `tariffs[d][good].rate` (null → 0, shown "not modelled"), plus any active `tariff_add` for origin `o`,
    and fee `mfn` 150 cr.
* `duty = round(saleValue × rate)`, where `saleValue = tradeQuote(…'sell').total`. The proceeds line reads "Sold … —
  duty {n} cr ({agreement or 'WTO MFN'}, {srcShort})". Fixture example: 1,000 t steel at 900 cr/t, MFN 5 % → duty
  45,000, fee 150 → net 854,850.
* Buying is duty-free (export duties are not modelled).

### 4.10 Cabotage

* A contract is **domestic** when from and to lie in the same `cabotage.territory` (default: the country itself; for a
  `bloc` rule, a domestic leg inside any member state). Contract generation tags it `job.pol.cab = '<cc>'`.
* `rule: 'national'`: needs vessel flag = that country, plus `builtIn` (if set) = `vessel.builtIn`, plus company `home`
  in `ownerHome` (if set). `bloc`: flag in the bloc. `licence`: allowed after buying a licence in the Rules tab
  (`licence.days` × `DAY_TO_H` hours to issue, `feeCr`). `open`/`nodata`: allowed.
* `vessel.builtIn` (new): the shipyard harbour's country for new ships; for used listings, the listing harbour's
  country with 50 % probability, else a draw from a builders table in the dataset (`countries.json` meta
  `shipbuilders: [['CN', 0.5], ['KR', 0.28], ['JP', 0.15], ['other', 0.07]]`, source UNCTAD Review of Maritime
  Transport — verify shares); migration `'XX'` (unknown, i.e. foreign).
* Jones Act consequence: a US company needs a US-built, US-flag ship for US domestic contracts. New ships bought in a US
  harbour's shipyard are US-built. Open question Q3: should US yards charge more (real US-built hulls cost several
  times more)? Default: ×2.0, game rule.

### 4.11 Economy weighted by real trade

* **Price profile:** `localProfile` uses `trade.json` when the country has data for the good:
  `b = (exp − imp) / (exp + imp)`, `m = clamp(0.75, 1.25, 1 − 0.25 × b)`. Example: exp 900, imp 100 → b 0.8 → m 0.80.
  Exp 0, imp 500 → m 1.25. No data → today's `COUNTRY_PROFILE` value (unchanged fallback). Size and noise
  multipliers stay as they are, so `targetStock` follows automatically.
* **Freight destinations:** `pickDestination` keeps its distance bands (`DEST_BANDS`). Inside the chosen band, each
  candidate harbour gets the weight `w = 1 + 6 × share(fromCountry → destCountry, good)`; share 0.3 → w 2.8. The weight
  is 0 when the destination is `closed`, or a UN measure blocks the good between the two countries. The good is chosen
  first (today it is chosen after the destination; the order flips for freight, and the generator gets an
  `env.destWeight(fromId, toId, good)` hook).
* **Contracts that personal measures block for some players stay on the board.** Boards are shared by everyone, so a
  job carries `job.pol` tags and the board shows "Not for your company: …" per player (§5.1).
* **Risk premium in pay:** jobs whose planned route crosses, or whose destination lies in, a `war_risk` area get `pay ×=
  1 + RISK_PAY[maxTier]`. Base 100,000 → tier 1 110,000, tier 2 140,000, tier 3 220,000, tier 4 300,000. This is applied
  in `rateJob`'s caller via `env.riskOf(fromId, toId)`, which uses the area discs crossed by the great-circle/route-table
  path (cached per harbour pair per dataset version).

### 4.12 Diplomatic contract types (`server/politicsjobs.js`, appended in `regenHarbor`)

0–2 per regen per harbour, only where the dataset defines a programme or a need. All are new `job.type` values that
reuse existing delivery mechanics (cargo or passengers), so `deliverJobs` handles them unchanged.

| Type (`job.type`) | Where it appears | Cargo / pax | Requirements | Pay |
|---|---|---|---|---|
| `aid` — humanitarian aid | Harbours of `ports[h].needs` (data: a dated appeal from a UN agency or the IFRC naming the port as a humanitarian entry point), offered at major/mega ports within 5,000 km | `grain` or `supplies`, 250–2,500 t | none beyond normal checks; captains may take it | freight formula × (1 + RISK_PAY[tier]) × 1.1; rep +5 with the destination country |
| `corridor` — grain corridor run | Ports in a cooperation programme (`ua-grain-corridor`: from Greater Odesa to the programme's destination list) | `grain`, 2,500–20,000 t | clearance for the port; corridor route; no `deniedWhen` match | freight × (1 + RISK_PAY[4]); premium refunded |
| `state` — state charter | Mega/major harbours of countries where your rep ≥ 20 | the country's top export good (from `trade.json`) to its top partner within range | rep ≥ `charterMin`; flag not under that country's port ban; `follows` has no measure against the destination | freight × 1.25; rep +3 |
| `avoid` — sanction-compliant route | Freight whose shortest route crosses a tier ≥ 3 area | as freight | `mustAvoid: [areaIds]` | paid on the avoiding route's sea km (e.g. via the Cape of Good Hope instead of Suez). Entering an avoided area halves the pay and costs rep −5 with the shipper's country. |
| `evac` — assisted departure | Only when `ports[h].evacuation` is set by a dated source (the real dataset may have none) | passengers 50–400 (needs `pax`) | passenger ships; clearance if restricted | pax formula × 3; time window 24 h ship time |

Text examples: "Humanitarian cargo: 1,200 t grain to Port Sudan (needs listed by {src}, {asOf})"; "Grain corridor:
8,000 t grain Odesa → Istanbul (Ukrainian corridor, clearance required)". No organisation is named as the shipper; the
source is cited as the reason the need exists.

### 4.13 Flags and re-flagging

* `vessel.flag = { cc, registry, since }`, `vessel.flagWas = [{ cc, from, until }]` (kept 10). New ships: the company's
  `office.defaultRegistry` (default: the home country's national register, if `registries` has it and the owner rule
  holds; else `pa`).
* **Re-flag** (`pol_reflag { vesselId, registry }`), allowed when the ship is docked or anchored, not detained, and not
  designated:
  * checks the registry's `owner` rule against the company home, and `age.maxYears` against `vessel.built`. If over
    `inspectOverYears`, an extra fee of 1 % of hullBasis is charged (special survey);
  * costs `initialCr + perTCr × displacement`. Coaster in `lr`: 2,000 + 0.5 × 3,200 = **3,600 cr**;
  * takes `setupDays × DAY_TO_H` hours. Liberia 1 h; a national register 10 h; the US 30 h. The ship can work
    meanwhile; the new flag takes effect at the end;
  * the old flag goes to `flagWas` (this matters for `flagWas` predicates such as EU Art. 3ea).
* Annual tonnage tax: `annualPerTCr × displacement / 365` per day, booked daily to `fees` (coaster lr: 0.2 × 3,200 /
  365 = 1.75 cr/day).

### 4.14 Moving home (re-domiciling the company)

Extends `fleet.homeMove(p, h)`, which already checks: moored there, port size, laid-up ships, cooldown, bills, cost.
New steps, all shown on one card (§5.4):

1. **Effects preview:** the sanction authorities followed before → after, customs union before → after, cabotage
   access gained/lost, the PSC regime at home, and reputation carried over (it is per country, so it does not change).
2. **Registry consequences:** ships whose registry `owner` rule fails with the new home must re-flag. Each one is listed
   with its cheapest allowed registry and that registry's cost. The move pays for them and starts each re-flag.
3. **Open contracts:** any accepted contract (yours or a captain's) that `jobCheck` would block under the new ctx must be
   finished or abandoned first. They are listed.
4. **Destination checks:** the target harbour's port is `open` and you are not refused entry there. Home cannot be in a
   `closed` port.
5. **Cost:** today's `HOME_MOVE_CR` (first move free, then 25,000) + `FORMATION_FEE` 5,000 (game) + compulsory re-flags.
6. **Waiting time:** `countries[cc].company.formationDays × DAY_TO_H` hours (seed default 5 → 5 h). During it,
   `office.pol.pending = { harbor, readyAt }`. The old jurisdiction applies and ships keep working. [Cancel] refunds 50 %
   of the formation fee. At `readyAt`, the move completes (existing `homeAction` effects) and the event names the
   jurisdictions now followed.
7. `local` rule from data (`local_agent` / `local_director`): an extra daily fee (`agentCrDay`, game, seed 50 cr/day)
   while the home stays there. `local_majority` (a foreign-ownership cap) blocks the move with the source cited, unless
   the data marks an exception for shipping.

The home's country then becomes the company country: the HQ title shows the flag, and new ships default to its
register.

### 4.15 Reputation per country

`office.pol.rep[cc]`, an integer from −100 to 100, starts at 0.

* Changes: on-time delivery to or from cc +1 (at most +2 per country per real day); `aid` +5; `state` +3; late −1;
  PSC detention −5 (−2 in other regime members); seizure −20; `avoid` breach −5 (shipper country). It recovers
  toward 0 by 1 per real day when negative.
* Effects: ≥ 20 → state charters; ≥ 40 → "trusted operator": customs fee waived (modelled on authorised-economic-operator
  schemes, game rule); ≤ −30 → PSC inspection chance ×1.5 in that country; ≤ −60 → refused entry for 7 game days.
* v7 #1 (career and reputation) may own the storage later: everything goes through `repOf(office, cc)` /
  `bumpRep(office, cc, n, why)`, so the storage can move without touching callers.
* Reputation reflects dealings with port and customs authorities, never political alignment (UI wording: "Standing
  with {country} port authorities").

### 4.16 Captains' risk policy (fleet)

`office.pol.riskPolicy ∈ { 'avoid' (default), 'cautious', 'accept' }`, set in the Compliance panel.

| Policy | Contracts captains accept | Routing | Cover / guards |
|---|---|---|---|
| avoid | none whose destination or planned route lies in a war-risk area or piracy area; none with `job.type` in `corridor`, `evac` | plans with the discs of all war-risk and piracy areas within the route's bbox (≤ 8 discs, nearest first) | — |
| cautious | tier ≤ 2 areas; piracy areas with guards | discs of tier ≥ 3 areas | cover always; guards auto-bought (if cash allows, else refuses) |
| accept | anything not blocked by sanctions, port status or entry rules | corridor waypoints when required; no war discs | cover always; guards auto-bought |

`captainRefusal(job)` → `captainRefusal(job, ctx, policy)`. The old one-argument call keeps working (no politics
checks). Refusal text: "Your risk policy is 'avoid': no captain sails into {area}." Departure (`departureBlocked`) also
checks the destination's entry rules and clearance, and requests clearance automatically for `accept`.

### 4.17 When the data changes during play

* On load, and when the server picks up a new dataset version, `politics.reconcile()` runs:
  * accepted contracts that are now blocked: if `acceptedAt` is before the new measure's `from`, they may be finished
    within `windDownDays × DAY_TO_H` hours (default 30 h), shown as "Wind-down until {time}";
  * after that, or when the destination becomes `closed`: the contract is cancelled without the cancellation fee, the
    contract cargo goes back, and `FRUSTRATION_PAY` (25 % of pay) is paid;
  * ships moored in a newly closed port may stay and leave freely.
* Each accepted job stores `job.pol.ver` (dataset version at acceptance) for this.

---

## 5. UI

### 5.1 Harbour sheet — "Rules" tab

A quick tile in the overview (`hud.js` `quick` list): `['rules', 'scale', 'Rules', '{status} · {pscName}{ · ECA}{ ·
War risk x %}']`. The tile is amber if restricted or listed, red if closed. A chip in the banner next to the country
chip shows the status, with a "Listed area" chip if one applies. Tab order: after Contracts and Market.

Cards (top to bottom; each line ends with a small `ⓘ {srcShort} · {asOf}`; clicking it opens the source list at that
entry):

1. **Port status:** Open / Restricted / Closed, the reasons, clearance state ("Clearance valid until 14:20" or [Request
   clearance]), corridor ([Show on chart]).
2. **For your company:** "{Company} · home {country} · follows {EU, UN} · ship flag {flag}". Lists what is blocked here
   *for you*: "Buy: steel (EU 833/2014 Art. 3g)", "Sell: machinery". It lists cargo aboard that would be seized here,
   in red. If designated or reputation-banned, a red banner.
3. **Customs and duties:** customs territory and the agreement with your home; a table of the goods you carry: origin →
   rate → fee (e.g. "steel · CN · 5.0 % MFN · 150 cr").
4. **Port state control:** regime name, your ship's profile and points (expandable list of points), inspection chance
   now, detention chance at the current hull, last inspection.
5. **Environment:** in ECA (SOx 0.10 %, NOx Tier III note), surcharge per tonne.
6. **Security:** war-risk area and premium **for this ship** (number), incident chance per call or day, IBF warlike
   (crew pay ×2), piracy area and guards [Hire guards x cr], up to 3 navigational warnings.
7. **Coastal trade:** "Domestic contracts here: allowed / need {flag}, US-built, US company".
8. **Sources:** the dataset version, "valid as of {date}", and each source used on this sheet (title, publisher, date,
   link opening in a new tab). Stale entries show an amber tag. Footer P7.

**Contract board badges** (Contracts tab and the world boards): `War risk T4 · +200 %`, `Corridor`, `Premium refunded`,
`Not for your company — {short reason}` (the Accept button is disabled with a tooltip), `Cabotage: {flag} only`,
`Avoid {area}`. The badge text comes from `jobCheck` run in the client with the player's ctx (sent in `you.pol.ctx`).

### 5.2 Chart overlays

New layers in `chart.js` `this.layers`: `warrisk` (on), `corridors` (on), `eca` (off), `piracy` (off), `warnings`
(off). They appear in the layer menu under "Rules & risk". Drawing (canvas, in world → screen projection as the storms
are drawn):

* war risk: fill red-orange, alpha 0.08 / 0.12 / 0.16 / 0.20 by tier, 1 px outline, a label at the polygon's centroid
  ("Listed area · T3");
* ECA: green dashed outline, no fill, label "ECA";
* piracy: violet dotted outline, label "Piracy HRA";
* corridors: blue 2 px line with arrowheads every 80 px;
* warnings: grey hatched.

Tap or click inside a polygon: a popover with the name, source and date, and the premium for your ship.

### 5.3 Pre-voyage risk check

Wherever a route is planned (contract card Route, chart route, fleet order, express passage), the client calls
`riskCheck(ds, ctx, { route, speedKn, cls, cond, job, toHarbor })` (pure, shared). The result appears as a card (a
bottom sheet on phones):

```
Voyage risk check — Istanbul → Odesa                      dataset 2026.10.1 · valid as of 01 Oct 2026
● Destination: Restricted — corridor route required, clearance: not requested   [Request clearance]
● Listed area: Black Sea (UA) T4 · 412 km · 13 h · premium 901 cr (refunded by shipper) · incident ≈ 0.3 % at sea + 1.5 % in port
● Crew: IBF warlike area — crew pay ×2 for ~13 h (coaster: +520 cr)
● ECA: none on this route
● Piracy: none
● Port state control at Odesa: Black Sea MoU · your profile SRS · inspection 12 %
✖ Blockers: none
[Plan around listed areas]  [Buy war cover now]  [Go]
```

Blockers (sanctions, closed port, port ban, lockout, cabotage) show in red and disable [Go] for contracts. For
free sailing, [Go] stays enabled; the port will refuse entry. "Plan around listed areas" re-plans with the area discs as
`avoid` (route planner, §6.4).

### 5.4 Company "Compliance" panel (HQ)

A new HQ tab `['rules', 'scale', 'Rules']` after Office (`hq.js TABS`). Sections:

1. **Jurisdiction:** home harbour, country, flag, `follows`, customs union, cabotage rights. [Move home…] opens the move
   card (§4.14) when moored in another port.
2. **Fleet flags:** one row per ship with flag, registry, built year, PSC profile per regime visited, and [Re-flag…]
   (registry picker: requirements met ✓/✖, cost, time).
3. **Risk policy:** captains avoid / cautious / accept; war cover auto / ask.
4. **Standing with port authorities:** top and bottom 8 countries as bars (−100…100), with effects reached ("state
   charters", "trusted operator", "watched", "banned until …").
5. **Records:** detentions, refused entries, seizures, designations, lockouts with expiry (the last 20).
6. **Dataset:** version, valid as of, review status, the sources list.

### 5.5 Phones (390 × 844)

* The Rules tab cards stack as an accordion. Only Port status and For your company are open by default; the source
  links sit at the end of each card.
* The risk check is a full-height bottom sheet with sticky buttons. Blockers come first.
* Chart overlays: toggles live in the existing layers sheet; the legend is a collapsible chip row at the top. Polygon
  popovers become a bottom sheet.
* Compliance panel: HQ phone tabs become Map · Ships · Money · Office · Rules · Log (6 icons; labels hidden under 360 px).
* All tap targets ≥ 44 px; text ≥ 14 px; colour is never the only signal (icons ● ✖ and words too).

---

## 6. Integration with existing code

### 6.1 New modules (phase 1)

| File | Lane | Content |
|---|---|---|
| `shared/politics.js` | A | `POL`, `loadDataset`, predicates, geometry (point-in-polygon with bbox prefilter; a 1° grid index built at load), `ctx` helpers, `tradeCheck`, `jobCheck`, `entryCheck`, `harbourRules`, `routeExposure`, `riskCheck`, `warPremium`, `hullValue`, `pscProfile`, `pscChance`, `dutyFor`, `avoidDiscs`, `reasonText` (§8.1) |
| `shared/politics/*.json` | A | dataset (§3) |
| `server/politics.js` | A | `class Politics` bound to a game: loads the dataset (fs, sync at start), `ctxOf`, `onDock`, `stepSea`, `onTrade`, `onAccept`, `reconcile`, `dailyTick`, `harbourPayload`, `officeView`, `bankFlags`, `jobEnvHooks()`, action handlers `pol_*`, migration helpers `healOfficePol` / `healVesselPol` |
| `server/politicsjobs.js` | A | `diplomaticJobs(ds, harbor, simTime, rnd, env)` (§4.12); uses `nextJobId` and `rateJob` semantics from `economy.js` (export `rateJob` in phase 2, or copy its 8 lines) |
| `scripts/politics/*.mjs` | A | §3.14 |
| `public/js/politics.js` | B | `PoliticsUi`: dataset fetch + cache (`/api/politics`, ETag), `rulesTabHTML(h, you)`, `badgesFor(job, you)`, `drawChartLayers(chart, ctx)`, `riskCheckCard(report)`, `complianceTabHTML(view)`, `moveHomeCard`, `reflagCard` |
| `public/js/politicsfmt.js` | B | pure formatters (no DOM) for tests: `fmtPct`, `fmtSrc`, `statusChip`, `tierColour`, `reasonLine` |
| `public/css/politics.css` | B | styles (light/dark tokens like the other sheets) |

### 6.2 Phase 2 hook table (after the other agents' edits land; each hook is a few lines)

| # | File · function | Hook |
|---|---|---|
| H1 | `server/game.js` constructor | `this.politics = new Politics(this, opts.politicsDir)` (tests pass a fixture dir) |
| H2 | `game.regenHarbor` | after the job loop: `st.jobs.push(...diplomaticJobs(...))` (bounded to jobCountFor + 2); tag each job with `this.politics.tagJob(j)` (`job.pol = { tier, areas, cab, mustAvoid, ver }`) |
| H3 | `economy.generateSmugglingJob` | `env.contrabandOk?.(from, dest, good)`: false for listed areas and arms-embargo targets (P4) |
| H4 | `economy.generateJob` / `pickDestination` | `env.destWeight(fromId, toId, good)`, `env.riskOf(fromId, toId)` (§4.11); the good is picked before the destination for freight |
| H5 | `economy.localProfile` | `COUNTRY_PROFILE` fallback after `tradeProfile(harbor.country, g)` from `trade.json` (server-only import guarded: `economy.js` takes an injected `setTradeProfile(fn)` so it stays pure) |
| H6 | `game.acceptJob` | before cargo is loaded: `const c = this.politics.onAccept(p, job); if (c.block) return this.event(p, 'law', c.text)` |
| H7 | `game.tradeGoods` | buy: `onTrade(p, h, good, 'buy')` block → return; set `origin` on the stack, merge by origin. Sell: per stack `dutyFor` → subtract from proceeds, event line |
| H8 | `game.dock` and `quayDock` (`server/quaygame.js`) | before `moorAt`/`setDocked`: `const e = this.politics.entryCheck(p, harbor); if (e.refuse) return this.event(p, 'law', e.text)` |
| H9 | `game.finishDock` | after the contraband inspection: `this.politics.onDock(p, harbor)` (calls, seizure, PSC, port incident, designation, premium refund on delivered jobs) |
| H10 | `game.undock` | `if (p.held && p.held.until > simTime) return warn` (detention / PSC hold) |
| H11 | `game.stepAtSea` | `this.politics.stepSea(p, hrs, burnT)` after the fuel burn (needs the tonnes burned this step: return it from the burn line) |
| H12 | `game.payJob` | `this.politics.onPaid(p, j, late)` → rep, refund of war premium; `mustAvoid` breach halves the pay before the bonus |
| H13 | `game.sendHarbor` | add `rules: this.politics.harbourPayload(p, h)` |
| H14 | `game.privateState` | add `pol: this.politics.youView(p)` (`{ ctx (public parts), inAreas, cover, held, clearance }`) |
| H15 | `game.onAction` | `case 'pol_*': return this.politics.onAction(p, m)` (actions §6.3) |
| H16 | `game.loadState` / `migratePlayer` / `saveState` | `this.politics.migrate(p)`; `polSchema: 1` in the save |
| H17 | `game.expressPassage` | `const x = this.politics.expressCheck(p, route); if (x.refuse) …` |
| H18 | `server/fleet.js homeMove/homeAction` | merge `this.game.politics.homeMovePlan(p, h)` into the result (§4.14). `homeAction` starts `pending` instead of switching immediately when `formationDays > 0` |
| H19 | `server/fleet.js captainRefusal` + callers (lines with `captainRefusal(job)`) | pass `(job, game.politics.ctxOf(owner, v), office.pol.riskPolicy)` |
| H20 | `server/captain.js requestPlan` | `avoid: [...(tgt.avoid || stormsNear(...)), ...g.politics.avoidDiscs(policy, from, to)].slice(0, 8)`; `wp` = corridor line when the target port needs it |
| H21 | `server/captain.js departureBlocked` | the destination's entry check / clearance; for `accept`, request clearance and wait |
| H22 | `server/fleet.js` daily settlement | `politics.dailyTick(p)`: tonnage tax, agent fee, rep recovery, expiry of lockouts/designations |
| H23 | `server/market.js rowsFrom` | optional query `home=NL&flag=NL`: drop rows that `tradeCheck` blocks (public data only) |
| H24 | `server.js` | `app.get('/api/politics', …)` → the client subset with an ETag (`meta.version`); `app.get('/api/politics/check', …)` is **not** needed (the check is client-side + server re-checks) |
| H25 | `public/js/hud.js renderTab` / `quick` / `quayfmt.js TAB_LABEL` | `case 'rules': html = this.politics.rulesTabHTML(h, you)`; the quick tile; label `rules: 'Rules'` |
| H26 | `public/js/chart.js` | layers `warrisk, corridors, eca, piracy, warnings`; draw after storms: `this.app.politics?.drawChartLayers(this, this.ctx)` |
| H27 | `public/js/hq.js TABS` | `['rules', 'scale', 'Rules']` → `politics.complianceTabHTML` |
| H28 | `public/js/main.js` | construct `PoliticsUi`, load the dataset on connect; hand route results to `riskCheckCard` before engaging the autopilot on a contract route |
| H29 | `public/js/jobs.js` / contract card | `politics.badgesFor(job, you)` |

### 6.3 Protocol

* `harbor.rules`: `HarbourRules` = `{ status, entry, clearance, you: { home, follows, flag, blocked: [{ side, good,
  reason }], seizable: [{ good, origin, reason }] }, customs: { territory, agreement, rows: [{ good, origin, rate, fee,
  basis, src }] }, psc: { regime, profile, points: [{ why, n }], pInspect, pDetain, last }, eca, security: { areas: [{
  id, name, tier, premium, pDay, warlike }], piracy, warnings }, cabotage, sources: [{ id, title, publisher,
  published, url, stale }], version, validAsOf }`.
* `you.pol`: `{ ctx: { home, follows, flag, customs, rep }, inAreas: [ids], cover: { [areaId]: untilS }, held: null |
  { until, why }, clearance: { [harborId]: untilS }, pending: null | { harbor, readyAt } }`.
* `fleet` message: `compliance` = the `officeView` (policy, flags, rep, records).
* Jobs: `publicJob` passes `pol` (tier, areas, cab, mustAvoid, type extras).
* Actions (`net.action`): `pol_policy { riskPolicy?, warCover? }`, `pol_cover { areaId }`, `pol_cover_skip { areaId }`,
  `pol_guards { harborId? }`, `pol_clearance { harbor }`, `pol_licence { cc }`, `pol_reflag { vesselId, registry }`,
  `pol_home_plan { harbor }` → `pol_home_plan` reply message, `pol_home_start { harbor }`, `pol_home_cancel`. Rate limit:
  the fleet's action bucket.
* Events: kind `law` (blocks, refusals, seizure, PSC), new kind `risk` (cover, incidents, warlike, piracy) with an amber
  style.

### 6.4 Route planner

v1 uses the existing disc avoidance (`opts.avoid`, ≤ 8 discs, padded × 1.25). The discs come from
`build-discs.mjs`. `avoidDiscs(policy, from, to)` returns the discs of areas whose bbox meets the route bbox, nearest
first, capped so that storm discs + politics discs ≤ 8 (storms first; a storm is an immediate hazard). If a disc
contains the start or the end, the planner already skips it and warns. The politics check adds its own line ("the
destination is inside the listed area"). There is no change to `searoute.js` in v1. v2 (optional): polygon avoidance
in `makeCtx` for tighter routes along the edge of the Red Sea area.

### 6.5 Save migration (`polSchema: 1`; old saves have none of these fields; nothing ever throws)

| Record | New field | Default for old saves |
|---|---|---|
| `office` | `pol = { v: 1, rep: {}, riskPolicy: 'avoid', warCover: 'auto', defaultRegistry: null, records: [], lockouts: [], designated: {}, exposure: [], calls: [], clearance: {}, licences: {}, pending: null, cover: {} }` | as shown |
| vessel | `flag = { cc: homeCountry, registry: 'national:<cc>', since: 0 }`, `flagWas: []`, `built: year − round((100 − cond)/3.5)` (0–30 y), `builtIn: 'XX'`, `psc: { last: {}, detentions: [] }`, `held: null`, `scrubber: false` | grandfathered: no re-flag is forced until the home moves |
| cargo stack | `origin` | `null` (unknown origin: MFN duty, never sanction-matched) |
| accepted job | `pol` | absent → grandfathered: only entry refusals and closures apply (wind-down from the load time) |
| harbour board jobs | `pol` | tagged on the next regen (boards regenerate within 2 h; `initHarbors` force-regens anyway) |

`healOffice`/`healVessel` in `fleet.js` call `politics.healOfficePol` / `healVesselPol` (H16/H18). Wrong types are
reset to defaults. Unknown country codes in `rep` are dropped.

---

## 7. Tests (Node `node --test`, files in `test/`; numbers are asserted exactly)

All rule tests run on **`test/fixtures/politics/`**, a small fake dataset (countries `XA`, `XB`, `XC`, harbours mapped
by a test harbour list, areas as simple squares). Refreshing the real data never changes them. Only `politics-data`
reads the real dataset, and it checks structure, never values.

| File | Asserts |
|---|---|
| `politics-data.test.mjs` | the real dataset passes `validate.mjs` (no `verify: true`); every `HARBORS` country has a row (124); every area has ≥ 1 source and an `asOf`; client subset ≤ 150 KB; no banned words |
| `politics-rules.test.mjs` | `hullValue('coaster', 78) === 90120`; `hullValue('feeder', 100) === 807500`; `hullValue('tanker', 100) === 3570000`; `warPremium(area apPct 1.0, coaster 78) === 901`; `(0.7, feeder 100) === 5653`; `(0.7, tanker 100) === 24990`; tier-1 fallback `(0.05, feeder 100) === 404`; `riskPay(100000, 4) === 300000`, tier 3 → 220000, tier 2 → 140000, tier 1 → 110000; transit `P(pDay 0.004, 1100 km, 18 kn)` ≈ 0.005495 (±1e-6), with mul 3 ≈ 0.016461; piracy `P(p100 0.004, 600 km)` ≈ 0.023761, with speed ≥ 18 kn ≈ 0.007178; ECA surcharge 2.0 t → 455; duty 1,000 t × 900 at 5 % MFN → 45,000 + 150 fee; same goods inside a customs union → 0 + 0; FTA → 0 + 50; trade profile exp 900/imp 100 → 0.80, exp 0/imp 500 → 1.25; destination weight share 0.3 → 2.8 |
| `politics-predicates.test.mjs` | `flagWas` since a date (re-flagged before the date → no match; after → match); `calledIn` 180 days with `DAY_TO_H` → a lockout of 648,000 s; `any`/`all`/`not`; personal vs territorial scope (an XA company at an XB port with an XB territorial ban → blocked; an XC company at an XC port with XA personal measures → not blocked) |
| `politics-psc.test.mjs` | starter (age 6, white, 78 %, clean) → 0 points, LRS, 0.04, detention 0.02; tanker age 15, grey, 55 %, 1 detention → 5 points, HRS, 0.30, detention 0.15 → 0.045 combined; inside the window → 0 |
| `politics-engine.test.mjs` | with a fake game (`test/fleet-helpers.mjs` style): a closed port refuses `dock`; Cuba-style lockout refuses a call 10 h after, allows after 180 h; a seizure on entry fines max(10000, 2 × value); a detained ship cannot undock below 60 %; an incident with an injected rnd (0.001, then 0.5) → major: hull −30, 25 % of the free cargo lost; total loss calls `sink` with `war_loss` and the text contains "evacuated safely"; premium refunded on delivery; IBF ×2 crew cost inside warlike; captain policy `avoid` refuses a tier-4 job; reconcile: a job accepted before a new measure gets wind-down to accept + 30 h, then frustration pay 25 % |
| `politics-home.test.mjs` | the move plan lists the follows before/after, the ships needing re-flag with cost (coaster → `lr` 3,600), blocking contracts; pending completes at `readyAt`; cancel refunds 2,500; a `closed` target → refused |
| `politics-migration.test.mjs` | a v6 save without politics fields loads; office.pol defaults; vessel flag = home country; `built` from cond 78 → current year − 6; cargo origin null pays MFN and is never seized; old accepted jobs grandfathered |
| `politics-wording.test.mjs` | every template rendered with fixture data has no banned word; every incident text contains "Crew safe" or "evacuated safely" |
| `politics-client.test.mjs` | `politicsfmt`: tier colours, `fmtSrc({ publisher, published })` → "JWC · 01 Oct 2026", stale tag after `reviewBy`, status chip classes |

Existing tests that change in phase 2 (same commit as the hooks): `jobs.test.mjs` (the freight good is picked before
the destination → seeded expectations update), `market.test.mjs` (`localProfile` with a trade fixture; without
`trade.json` injected it is unchanged), `fleet-office.test.mjs` (`homeMove` result gains `plan`; the old fields stay).

---

## 8. Build plan — two parallel lanes with a frozen interface

### 8.1 Frozen interface (`shared/politics.js`; both lanes code against this; changes need both lanes' agreement)

```js
export const POL;                                              // §4.1
export function loadDataset(parts) /* { meta, sources, countries, ports, registries, regimes, areas, agreements, tariffs, psc, trade? } → Dataset (indexed, frozen) */;
export function isActive(rec, simTime) /* bool */;
export function makeCtx(ds, { homeHarbor, flag, flagWas, rep, designated, exposure, lockouts, calls, clearance, licences, simTime }) /* Ctx */;
export function matches(when, ctx) /* bool */;
export function hullValue(cls, cond) /* int */;
export function warPremium(area, cls, cond) /* int */;
export function riskPay(pay, tier) /* int */;
export function areasAt(ds, lat, lon, kinds = null) /* Area[] */;
export function routeExposure(ds, from, pts, speedKn) /* { areas: [{ id, kind, tier, km, h }], ecaKm, piracyKm, warlikeH } */;
export function transitChance(pDay, km, speedKn, mul = 1) /* 0..1 */;
export function piracyChance(p100, km, { speedKn, convoy, guards }) /* 0..1 */;
export function tradeCheck(ds, ctx, { harbor, good, side, origin }) /* { ok, block?: Reason, warn: Reason[] } */;
export function dutyFor(ds, ctx, { harbor, good, origin, value }) /* { rate, duty, fee, basis, via: agreementId|'mfn'|'none', src } */;
export function jobCheck(ds, ctx, job, vessel) /* { ok, block?: Reason, warn: Reason[], tags } */;
export function entryCheck(ds, ctx, harbor, vessel) /* { ok, refuse?: Reason, needs?: 'clearance'|'corridor' } */;
export function pscProfile(ds, regimeId, vessel, ctx) /* { profile, points: [{ why, n }] } */;
export function pscChance(ds, regimeId, vessel, ctx, simTime) /* { pInspect, pDetain } */;
export function harbourRules(ds, ctx, harbor, vessel) /* HarbourRules (§6.3) */;
export function riskCheck(ds, ctx, { route, speedKn, cls, cond, job, toHarbor, vessel }) /* RiskReport */;
export function avoidDiscs(ds, policy, from, to, max) /* [{ lat, lon, radiusM, name }] */;
export function reasonText(reason) /* string, §2.1 templates */;
// Reason = { code, measureId?, areaId?, text, src: [srcId], asOf }
```

The server engine interface (`server/politics.js`, lane A, used by phase 2 hooks) is the method list in §6.2. The
client depends only on `shared/politics.js`, the `harbor.rules` / `you.pol` / `fleet.compliance` shapes (§6.3) and the
`/api/politics` payload (`{ meta, sources, countries, ports, registries, regimes, areas, agreements, tariffs, psc }`).

### 8.2 Lanes

* **Lane A — data + server** (new files only): `shared/politics.js`, `shared/politics/*.json` (seed → verified),
  `server/politics.js`, `server/politicsjobs.js`, `scripts/politics/*`, all tests except the client one,
  `test/fixtures/politics/*`. **Data step first:** build the 124-country baseline, then the detail rows. Every seed row
  in this document is checked against its source and either confirmed (`verify: false` with `asOf`), corrected, or
  dropped.
* **Lane B — client** (new files only): `public/js/politics.js`, `public/js/politicsfmt.js`, `public/css/politics.css`,
  `test/politics-client.test.mjs`. It develops against `test/fixtures/politics/` served by a small static stub, and the
  frozen shapes.
* **Phase 2 (one agent, after the other agents' edits to game.js/server.js/main.js/hud.js are merged):** hooks H1–H29,
  updated existing tests, browser check.
* Order inside phase 2: H16 (migration) → H1, H13, H14, H24, H25 (read-only views) → H6–H12 (enforcement) → H2–H5
  (economy) → H18–H22 (fleet) → H26–H29 (client extras).

### 8.3 Acceptance checklist (desktop 1440 × 900 and phone 390 × 844, two players with different homes)

- [ ] `node scripts/politics/validate.mjs` passes on the shipped dataset; no `verify: true`; size budget met.
- [ ] Every harbour's Rules tab opens. Every line shows a source and date; game rules carry the "Game rule" tag; the
      footer disclaimer shows.
- [ ] Odesa shows "Restricted — corridor route required"; docking without clearance is refused; after clearance and the
      corridor route, docking works; a coaster at 78 % pays 901 cr premium on entering the listed area, and it is
      refunded on delivering a corridor contract.
- [ ] Crew pay doubles inside the IBF warlike area (ledger shows it), and returns to normal on exit.
- [ ] Player A (home Rotterdam, NL): cannot buy steel at Ust-Luga (EU 833/2014 Art. 3g shown). Player B (home in a
      country without such measures in the dataset): can, and is warned that EU ports will seize it; docking in
      Rotterdam with it seizes it and fines max(10,000, 2 × value).
- [ ] An RU-flag ship is refused at Rotterdam and Felixstowe (EU Art. 3ea / UK regs) and accepted at Istanbul. A ship
      re-flagged from RU after 2022-02-24 is still refused in the EU (`flagWas`).
- [ ] After a trading call at Havana, US ports refuse the ship for 180 h; then they accept it.
- [ ] US domestic contract (e.g. Galveston → New Orleans) needs a US-flag, US-built ship and a US home; the badge says so.
- [ ] Duty: selling CN-origin steel in a fixture MFN port charges the duty and the 150 cr fee; NL → DE steel pays 0.
- [ ] PSC: a 15-year-old tanker at 55 % in a grey-list flag gets HRS; detention holds it until repaired.
- [ ] ECA surcharge appears on the ledger in the North Sea; not in the open Atlantic.
- [ ] Chart layers draw, toggle, and show popovers with the source; the phone layout works.
- [ ] Risk check card appears before a contract route; "Plan around listed areas" re-routes (Red Sea → via the Cape).
- [ ] Captain with policy "avoid" refuses a corridor contract; with "accept" requests clearance, buys cover, follows the
      corridor.
- [ ] Moving home NL → US: the plan lists follows EU → US, re-flags, cost, 5 h wait; contracts incompatible block it.
- [ ] Loading an old save works; old contracts finish; no errors in the server log.
- [ ] Wording test passes; incident texts all say crew safe/evacuated.
- [ ] The dataset version and "valid as of" show in the Rules tab footer and the Compliance panel.

---

## 9. Open questions (built with the default unless the product owner changes it)

| # | Question | Default |
|---|---|---|
| Q1 | ECA fuel surcharge from day one in the North Sea start region? | Yes, 0.35 × fuel base (227.5 cr/t), shown on the ledger; a server flag `POL.ECA_ON` can switch it off |
| Q2 | Can a player sail uninsured into a listed area? | Yes (`warCover: ask` → "Sail uninsured"); captains never |
| Q3 | US-built premium in US shipyards (Jones Act realism)? | ×2.0 price for new ships in US harbours' yards, game rule |
| Q4 | Time scale for paperwork (registries, company formation, lockouts)? | 1 real day = 1 game hour (`DAY_TO_H = 1`) |
| Q5 | Total loss from war incidents at all? | Yes, 5 % of incidents (≈ 0.03 % per tier-4 day); crew always evacuated |
| Q6 | GNSS interference as a gameplay effect (position jitter on the chart)? | Display only in v1 |
| Q7 | Allow homes in any country, including those under broad sanctions by others? | Yes. The game models that country's own rules and the measures others apply to it (P3) |
| Q8 | Show conflict context lines on country rows ("Armed conflict affecting shipping in …")? | Yes, one neutral sourced line, no more |
| Q9 | Who maintains the data, and how often? | Conflict/status monthly (30-day `reviewBy`), the rest yearly; `refresh.mjs --stale` in the monthly checklist |
| Q10 | Should contracts blocked for a player be hidden instead of badged? | Badged and disabled (players see why the world works this way) |
| Q11 | Black-market contraband to sanctioned (but not conflict) countries? | Allowed as today, except conflict areas and UN arms-embargo targets (P4) |
| Q12 | Reputation storage when v7 #1 lands | v7 #1 takes over storage behind `repOf`/`bumpRep` |

---

## 10. Main decisions (summary)

1. **One versioned dataset in `shared/politics/`** (meta, sources, countries, ports, registries, regimes, areas,
   agreements, tariffs, trade, psc). Every record carries source ids, an `asOf` and a `reviewBy`. `basis: 'game'` marks
   tuned numbers. Seed rows from this document ship only after verification (the validator refuses `verify: true`).
2. **Jurisdiction = company home country (personal measures) ∪ ship's flag state ∪ the port's territory (territorial)
   ∪ UN.** A small JSON predicate language (`home`, `flag`, `flagWas`, `calledIn`, `cargoOrigin`, `designated`) and
   eight measure kinds cover EU/UK/US/UN/Russian measures, the Cuba 180-day rule, port bans and secondary sanctions with
   no per-country code.
3. **Sanctions-breaking actions are blocked, never offered as a gamble.** Consequences come from realistic paths:
   refused entry, seizure on entry for cargo that a port's territory bans, PSC detention, secondary designation, and
   reputation bans.
4. **War risk modelled like the insurance market:** JWC-listed polygons with a per-call/transit additional premium (%
   of hull value, refunded by shippers per VOYWAR practice), IBF warlike double crew pay, game-tuned incident odds by
   tier (mine/projectile/detention; crews always safe), corridor routes with clearance, and contract pay +10 % to +200 %
   by tier. Odesa is restricted, corridor-only, tier 4. Russian Black Sea ports use the same mechanics.
5. **PSC, ECA, piracy, cabotage and customs use real structures:** MoU risk profiles and windows, White/Grey/Black flag
   lists, MARPOL ECA polygons with an MGO surcharge, BMP/IMB piracy areas with speed/convoy/guards mitigations, the
   Jones Act and EU cabotage, customs unions/FTAs/WTO MFN by game good, and cargo origin (caught fish takes the flag's
   origin).
6. **Trade realism without bloat:** BACI flows condensed to the top 8 partners per country × good drive price profiles
   and freight destination weights. The old table remains as a fallback.
7. **Five diplomatic contract types** (aid, corridor, state charter, avoid-route, assisted departure), driven by dated
   data, reusing existing delivery mechanics.
8. **Flags and moving home are real decisions:** registries with owner/age/crew rules and setup times, re-flag costs,
   flag history; a moving-home plan with jurisdiction diff, compulsory re-flags, formation wait and blocked contracts.
9. **Time scale** of one real day of paperwork = one game hour, so real-world waiting times stay proportional but
   playable.
10. **Build:** phase 1 = new files in two lanes against a frozen `shared/politics.js` interface. Phase 2 = 29 small hooks
    after the other agents finish. The route planner is reused through avoid discs and corridor waypoints, with no
    change to `searoute.js`. The save migration is additive and grandfathers old contracts.
