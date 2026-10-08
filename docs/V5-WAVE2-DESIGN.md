# Saltline v0.5 wave 2 — the company layer, fleet-ready (merged design)

Status: design, 2026-10-08. Nobody edits code from this document until their package (§9) starts.
Covers V5-PLAN items **9** (company, home harbour, bank, loans, insurance, books), **10** (crew), **20** (ship stats) and
**21** (spare parts and breakdowns), built so that V6-PLAN items **1–3** (office and boat storage, fleet at sea, switching,
HQ) are added later without changing the data model.

Read with: `docs/ARCHITECTURE.md`, `docs/V5-PLAN.md`, `docs/V6-PLAN.md`, `docs/V6-QUICK-CONTRACTS.md` (the quick v6 items
WARP-HARBOUR, TIME-MODEL, AUTOPILOT-CHARTS, WORLD-MARKET, which may merge before or after this wave), `docs/STATUS.md`.
Root: `/tmp/claude-0/-home-user/0e451cf3-a540-5510-b1a6-978d07bae2ed/scratchpad/saltline`.

Hard rules: production runs **Node 20** (no `node:sqlite`); **no new npm dependencies**; plain ESM; three.js r160 on the
client; the server is authoritative over money. Line numbers below refer to `server/game.js` as of 11:30 UTC today
(1,789 lines); they drift (at 12:03 the file had 1,794 lines and every site after `tugAssist` sat 4 lines lower), so every
hook is also named by function.

**Not in this wave** (so nobody looks for them here): V5 item 18 (accounts, passwords, sessions; the player record keeps
its token and the store's layout leaves room for an accounts file later), item 19's landing page and guided first voyage
(the founding card and the HQ checklist are in), item 20's cargo-handling time (cargo still loads and discharges at once;
it needs port work on the ship's clock, a v6 follow-up together with V6-QUICK §7.1), and item 21's spare-part weight
(spares take locker slots, not tonnes: the heaviest set weighs under 1 % of any hold). V5 item 10's visible crew aboard is
in (§9.2 W2-UI `crewnpc.js`).

Revised 12:30 UTC after a completeness and conflict review against the code (wave 1 included) and
`docs/V6-QUICK-CONTRACTS.md`: earning-power balance gate (§3.10), parked-ship clock (§4.4), berth billing, forced-reset
landing, tug occupancy, client limit clamp, crew NPCs, `.gitignore`, the missing test migrations (§9.5), and the
open questions for the player (§11).

---

## 0. Verdict on the two designs

Two designs were submitted: **A (player-first)** and **B (systems-first)**. Both arrived truncated (A stops inside its
migration section, B inside its captain section), so neither had a build plan or a complete test plan; this document
supplies both.

### 0.1 Scores (1 = poor, 5 = excellent)

| Criterion | A | B | Deciding facts |
|---|---|---|---|
| Fit with the real code | 3 | 4 | B's money-site table matches `game.js` line for line; A's "24 sites" is really 26 assignments on 25 lines. A's accessor plan fits the code best, but A ignores the contracted `shared/rates.js` service speed and the `p.shipTime` clock. B's plan rewrites ~60 method signatures in the file that wave 1 and quick-v6 are editing, and its `noPropulsion` trick breaks steering (0.2). |
| Server model: correctness and simplicity | 3 | 4 | B: integer credits, exact accrual, warp-invariant seeded failures, written invariants. Heavier than needed (double entry, BigInt interest, numeric rating, business and restructured loans). A: simple, but float cash is not exact across tick rates, and its lay-up rules contradict its wage rules. A correctly spots that `Math.max(0, p.money − fee)` creates money once overdrafts exist. |
| Player experience (desktop and mobile) | 5 | 2 | A: readability rules, first-hour script, founding card, HQ tabs, failure card with three fixes, switching table, phone layouts. B: a "basic HQ", onboarding out of scope, almost nothing for phones. |
| Economy realism and balance | 2 | 3 | A: crew 4× today's cost without retuning contract pay leaves a median 400 t coaster run near break-even (0.3); a 420k coaster triples every coaster's repair and service bill and needs a 7-day lock because the starter is priced below its own sale value. B: anchored to today's scale, but its per-class pay scale makes the same deckhand cost 4× more on a boxship; its coaster has a book value but still cannot be bought (price 0); default at day 8 is harsh with real-time 30-day months. |
| Persistence safety on Node 20 | 2 | 4 | A: per-company files written in staggered batches, so a crash can half-write a player-to-player trade; no cross-file atomicity. B: one atomic snapshot plus an append-only JSONL ledger with byte offsets, gzip backups. B's 400-day per-company books cache would bloat the snapshot. |
| Ability to build in parallel | 4 | 3 | A: package list, fixture contract, accessors keep `game.js` churn small. B: phase A is new files only (good), but its own refactor serialises everything behind `game.js` and forces every test off the facade. |
| Test plan | 3 | 4 | B: 12 invariants, source-grep tests, exactness and seeded-failure tests. A: a few strong ideas ("no `other` ledger line may remain", 10 Hz = 1 Hz wear), the rest cut off. |
| **Total (of 35)** | **22** | **24** | |

**Base: B** (the server model: integer money, settlement, deterministic parts, single-snapshot persistence, invariants).
**Grafted from A:** the refactor strategy (player as a view onto the vessel, actors for v6) in place of B's method
rewrite; the whole player-facing layer; the 5-role crew model and its tables; home perks; lay-up; jury-rig; automatic
surveys; letter ratings; the affordability rule; the secured starter loan; the 30-day default timeline.

### 0.2 Claims checked against the files

| Claim | From | Verdict | Evidence |
|---|---|---|---|
| `game.js` touches `p.ship` ~149, `p.money` 52, `p.cargo` 57, `p.docked` 54 times | A | Close | grep `[pq].ship` 157, `.money` 52, `cargo` 61, `docked` 60. The point stands: an accessor view avoids hundreds of edits. |
| 24 money sites in `game.js` | A | Wrong | 26 assignments on 25 lines (583, 584, 593, 639, 704, 716, 736, 749, 751, 757, 799, 862, 881, 896, 923, 954, 984, 993, 1001, 1114, 1304 ×2, 1515, 1536, 1585, 1728). |
| Money-site table with line numbers (41 `.money` mentions) | B | Correct | Every line in B's table matches the current file, including the reads at 623, 714, 734, 746, 756, 879, 921, 1294, 1528, 1581, 1727 and `you.money` at 306. |
| `#ctxStack`, `#hbThumb`, `#hbName`, `#hbClass`, `#telemetry`, compare tray | A | Correct | `public/index.html` lines 53–54, 78, 114; `compareWrap`, `hud.renderCompare`. |
| `myMesh.userData.setLights(false)` | A | Correct | `public/js/ship.js:990`. |
| `sound.event?.('alarm')` | A | Wrong | `SoundEngine.event` knows `anchor, collision, creak, grounding, splash, thunder, tug`; an `alarm` kind must be added (§9, W2-CLIENT). |
| Coaster `price` 0 → 420,000 | A | Harmful | `hullBasis = max(120000, price)` drives `repairCostFor` and `serviceCostFor`: every coaster owner's repair and service bills ×3.5. |
| Coaster `listPrice` 120,000 while `SHIP_CLASSES.coaster.price` stays 0 | B | Incoherent | The shipyard lists `price > 0` only, `generateUsedShips` filters `price > 0`, `shipValue(coaster) = 0`: a coaster could be mortgaged but never bought or sold. |
| Ops in `server/tugassist.js` keyed by `p.id`; `tickTugs` looks up `game.byId \|\| game.players` | B | Correct | `tugassist.js:168`, `:408`; `test/tugs.test.mjs` calls `tugOp(` 11 times. |
| `noPropulsion` via `env.fuelEmpty = true` | B | Wrong | `stepShip` sets `rudderCmd = 0` when `fuelEmpty` (`shared/physics.js`): an engine failure would also kill steering. Use a throttle clamp (§4.5). |
| Ship's clock `vessel.clock { ms, underwayMs }` | B | Conflicts | `docs/V6-QUICK-CONTRACTS.md` §5.2 already contracts `p.shipTime` (float seconds) and `p.warpRun`. |
| Service speed 0.75 × maxKn (B), per-class table e.g. coaster 12 kn (A) | A, B | Conflict | `shared/rates.js` (contracted, tests assert 11.2 kn for the coaster) uses 0.8 × maxKn. |
| Berth occupancy for fleet ships | A, B | B only | `startBerth` and `nearBerthFor` count `this.players` only; docked fleet ships would be invisible to guidance. B flags it; A does not. |
| Tests set `p.money` directly | both | Correct | `test/*.mjs` assign `p.money` in 20+ places; both keep a setter. |
| Wage float per tick (line 1114) | both | Correct | `p.money = Math.max(0, p.money − C.crewCost × hrs × …)`. |

### 0.3 What the merge takes, drops and changes

- **From B (base):** integer credits; voluntary / scheduled / forced charge modes; integer wage accrual with carried
  remainder; settlement that is lazy and idempotent; timers shifted forward after downtime; the component catalogue of
  V5 item 21 with cumulative-hazard failures drawn from a per-vessel seed; `shared/limits.js` (fixed, §4.5); one atomic
  snapshot plus append-only ledger files with committed byte offsets; invariants and source-grep tests; anti-cheat and
  ownership checks; major-damage insurance claims; the money-site table.
- **From A (grafts):** player object as a view onto the aboard vessel (accessors), actors for v6; every screen, the
  readability rules, the first-hour script and the phone rules; provisional company plus founding card; 5 crew roles
  with integer stars, per-ship fatigue, per-person morale, traits, the effect table; home perks; lay-up at home with
  storage slots; jury-rig; automatic class surveys on docking; letter ratings A–D; the income-based affordability rule;
  the starter loan secured on the starter ship; arrears alerts on days 0/7/14/21/28 and default at 30 days; the
  `berthed` message that shows moored ships in 3D.
- **Changed from both:** one labour market with realistic wages (neither A's 4× nor B's per-class scale); coaster
  price 120,000 in `SHIP_CLASSES` (buyable, maintenance unchanged); starters priced by the used-ship formula (no lock
  needed); single-entry ledger lines instead of double entry; loans on a schedule instead of continuous BigInt
  accrual; the ship's clock is the contracted `shipTime`; components grouped into A's systems for display.
- **Dropped:** business loans, restructured loans and numeric credit scores (B); the office crew pool (B); per-tick
  ledger merges and float cash (A); per-company save files (A); the starter-ship lock and the starter-price exploit (A);
  remote crew agencies, broker, captain AI (v6).

---

## 1. Decisions (each disagreement resolved)

| # | Topic | A | B | Merged | Why |
|---|---|---|---|---|---|
| D1 | How per-ship state leaves the player | Accessors on the player onto `p.vessel` | Rewrite methods to take `v`, facade for tests only | **Accessors** (`bindVesselView`, §4.2). Method bodies in `game.js` stay; v6 runs captained ships through "actors" with the same accessors. | Smallest diff in the file two other teams edit; existing tests keep working; no second copy of the docking/contract rules. |
| D2 | Cash | Float `company.cash` | Ledger balance, double entry | **Integer `company.cash`**, changed only by `book()` (§4.3). Single-entry lines with categories; paired lines share a `ref`. | Exact and auditable (invariant: `cash = Σ lines`) without an account layer that has no second party in this game. |
| D3 | Charge modes | Voluntary needs `cash ≥ cost` | Voluntary within overdraft headroom | **B**: voluntary allowed down to `−odLimit`; scheduled the same, else "missed"; forced always. | A broke ship in port must still be able to buy fuel; that is what an overdraft is for. Rating D sets the limit to 0, which is the spending freeze. |
| D4 | Wages | Float per ship-hour, merged lines | Integer mcr/h × ms, remainder carried | **B's accrual**, settled when a full ship-hour is accrued or the rate changes (§4.3). | Exact at any tick rate and warp (V6 item 5); no settle on clock boundaries, so tests are deterministic. |
| D5 | Wage level | 4× today (coaster 3,870 cr/day) | Per-class scale = today's `crewCost` | **One labour market** (deckhand 130, cook 160, mate 300, engineer 330, captain 450 cr/day at 3★); coaster optimal crew 1,180/day = 1.23× today; knob `CREW.WAGE_SCALE` (§3.5). | Realistic money (1 cr ≈ 1 €: fuel is already 650 cr/t), keeps the median coaster voyage profitable while contract pay is not retuned, same person costs the same on every ship. |
| D6 | Loans | Annuity `r = APR/12`, ceil | Annuity `r = APR × 30/365`, continuous BigInt accrual | **Schedule** with `r = APR × 30/365` (30-day world months), rounded, last instalment clears; interest only on due dates; pro-rata interest for early repayment. | Consistent with 30-day months; no continuous accrual needed. |
| D7 | Products | Starter, mortgage, overdraft | + business loans, restructured loans | **Starter (secured on the starter ship), mortgage, overdraft.** | Fewer screens; mortgages cover "amount, APR, term". |
| D8 | Credit rating | Letters A–D, streaks | Score 0–1000, bands A–E | **Letters A–D** | Readable; one rule each for up and down. |
| D9 | Default timeline | Arrears, default at 30 days | Default day 8, repossess day 22 | **Late days 0–29 with alerts; default and repossession at day 30** (or a second missed instalment, or 30 days over the overdraft limit). | Months are real time; a week away must not cost a ship. |
| D10 | Downtime | Catch up missed dues by date | Shift all world-clock timers by the gap | **B**: shift (§3.9). | Nobody played during the outage; matches TIME-MODEL (budgets pause while the server is down). |
| D11 | Persistence | Split files, dirty-only, staggered | One snapshot + JSONL ledger with offsets | **B**, with small in-memory books (last 100 lines, 35 days, months) (§6). | One commit point; crash-consistent across companies; snapshot stays ~10 KB per company. |
| D12 | Coaster price | 420,000 | 120,000 (book only) | **`SHIP_CLASSES.coaster.price = 120,000`** | Equals today's `hullBasis` floor: repair and service unchanged; coasters become buyable, sellable and used-listed. |
| D13 | Starter prices | Below market (needs a 7-day lock) | — | **Used-ship formula** `price × (0.4 + 0.45 × cond/100)`, rounded to 1,000 | Always above the yard's buying price: nothing to farm, no lock. |
| D14 | Components | 7–12 systems, minor/major | ~30 components, one effect each | **B's components (the V5 item 21 tree), shown grouped into A's systems** (§3.7). | Faithful to the plan, still readable: the UI shows 7–10 system rows, each expands. |
| D15 | Failure draw | Bernoulli per tick | Cumulative-hazard threshold, seeded | **B** | Exact, warp-invariant, reproducible in tests. |
| D16 | Engine failure effect | `thrMax 0, thrMin 0` | `env.fuelEmpty = true` | **A** (throttle clamp) | `fuelEmpty` also zeroes the rudder in `stepShip`. |
| D17 | Fixing | Fit / jury-rig / tow; overhaul | Fit at sea; yard fit | **Fit spare, jury-rig (A), tow, yard overhaul (instant), service (+30)** | Every breakdown has a no-spare way home. |
| D18 | Crew roles | 5 (captain, mate, engineer, cook, deckhand) | 6 (+ steward), float skill with XP | **A's 5 roles, integer 1–5★, no XP in wave 2** | Readable; cooks cover hotel staff on passenger ships. |
| D19 | Docked wages | Day 1 full, days 2–7 30 %, then 0 | 100 % for 24 h, then 25 % forever | **Day 1 full, then 30 % standby; 0 while laid up or while the owner has been offline > 7 days** | Keeps lay-up worth something (A's rule made lay-up cost more than it saved) and still protects absent players. |
| D20 | Insurance cover | Total loss only | Total loss + major damage, waiting period | **B's cover, A's rate** (1.5 %/year base) | Collisions and groundings are the common losses; total loss alone is rarely used. |
| D21 | Surveys | Automatic on docking at major ports | Manual, critical components | **Automatic (A), critical-component rule (B)** | No extra click; clear pass rule. |
| D22 | Ship's clock | ship-hours from `hrs` | `vessel.clock` integer ms | **`shipTime`** (V6-QUICK §5.2), moved onto the vessel by the accessor list | Already contracted; tests assert it. |
| D23 | Service speed | per-class table | 0.75 × maxKn | **`serviceKn()` from `shared/rates.js`** | Contracted; the market and contract estimates already use it. |
| D24 | Wanted level | on the player | on the company | **on the player** | No churn; the person did it; it moves with them when they switch ships. |
| D25 | Onboarding | Founding card in wave 2 | Out of scope (hook only) | **Provisional company for every new player + founding card** (no landing page, no accounts, no guided voyage) | The company needs a name, colours and a home; the 25k start no longer fits the new running costs. |
| D26 | Fleet at sea in wave 2 | v6 | captains sail the legacy voyage | **v6.** In wave 2 only the ship you are aboard ever leaves harbour (offline legacy voyages included). | No fleet tick, no captain AI, no new movement code in wave 2; the data model is already fleet-shaped. |

---

## 2. What the player sees and does

### 2.1 Readability rules (every screen)

1. **Cost before commitment.** Every button that spends shows the amount: "Hire · 480 cr fee + 160 cr/day",
   "Take loan · 24 × 4,310 cr".
2. **One status line per ship**, always *what she is doing · where · next event and when · money at stake*:
   "Freight 400 t grain → IJmuiden · 52°06′N 4°02′E · ETA 14:20 UTC (6 h 10 min) · 9,000 cr".
3. **Every modifier names its cause:** "Speed −4 %: 1 deckhand short." "Parts wear ×1.3: crew exhausted."
4. **Nothing blocks without a fix button:** "Cannot cast off: no engineer aboard → [Hire engineer]".
5. **Alerts are actionable:** each alert row carries one button ("Fit spare", "Pay now", "Show", "Hire").
6. **The log names the money category:** "−484 cr port dues".
7. **Phones get every feature** as full-screen sheets with bottom tabs, targets ≥ 44 px, no sideways scroll, legible at
   360 px; numbers with `toLocaleString('en-US')` as the HUD does.

### 2.2 The first hour

| Time | The player… | Screen | Teaches |
|---|---|---|---|
| 0:00 | Every new player already owns a provisional company ("Ann Shipping", home Rotterdam, a 78 % coaster, cash 160,000). The founding card opens on first connect: name, hull and funnel colours (live swatch), home harbour (7 pins), starter ship (6 cards), optional starter loan "+150,000 cr now · 12 × 12,904 cr from 07 Nov". [Found company] or [Later]. | Founding card (§2.4.1) | Capital, home perks, ship stats, loans |
| 0:02 | Moored at home. Top bar: company chip "■ Ann Shipping · 160,000 cr" with a bell. HQ checklist: hire a crew member, first delivery, buy a spare, look at the bank. | Top bar, HQ | Where the company lives |
| 0:04 | Harbour → Crew. The coaster has her minimum crew (Engineer ★★★ 330 cr/day, 2 deckhands ★★ 105 cr/day). Hires a cook ★★★ (160 cr/day, fee 480): morale target +5. | Crew tab (§2.4.4) | Slots, wages, morale |
| 0:07 | Accepts "Freight 400 t grain to IJmuiden · 9,000 cr", Route, casts off with tugs, follows the berth guidance out. | Existing | The company layer stays out of the way |
| 0:10–0:35 | Sails, warps. Moors at IJmuiden: "+9,000 cr contract", "−484 cr port dues". HQ: "This week +7,240 cr". | Log, chip | Profit = income − running costs |
| 0:40 | Services → Chandler: buys fuel injectors (OEM 480 / aftermarket 264). Ship card → Systems: "Main engine 94 % · 1 spare aboard · locker 1/8". | Chandler (§2.4.5) | Spares, OEM vs aftermarket |
| 0:50 | Bank: mortgage slider for a used trawler at 138,000: "41,400 down + 24 × 4,310 cr (6.75 %)". | Bank (§2.4.3) | Leverage |
| ~1:00 | Buys the trawler "into the fleet". She lies at the quay: "[Hire minimum crew · 3 people · fees 1,770 cr]". [Take command] switches to her in this harbour; the coaster stays moored on standby wages, or is laid up at home. | Shipyard, Crew, HQ Fleet | The fleet loop |
| 2–6 h of play | First breakdown: "MAIN ENGINE — fuel injectors failed. Power limited to 80 %." [Fit spare · ~1 h · 95 %] [Jury-rig · ~3 h · 50 %] [Call tow · 11,000 cr]. | Failure card (§2.4.6) | Maintenance matters |

The loop: earn with your ship, borrow to grow, buy a second ship, staff it, switch to whichever ship has the best
contract here, watch the books. The tensions: instalments against cash flow, OEM against aftermarket, skilled crew
against wages, insurance or not, laying up against keeping a ship ready. (v6 adds sending ships out under captains.)

### 2.3 Always on screen

- **Company chip** (created at runtime by `public/js/company/hq.js`, inserted left of `.tbShip` in `#topbar`): 12 px
  swatch in hull/funnel colours, company name (desktop only), cash. Negative cash is red: "−12,400 cr (overdraft)".
  Alert badge. Tap or **O** opens the HQ. The existing `#hbMoney` stat keeps showing `you.money` (= company cash).
- **Ship chip** (`#hbThumb`, `#hbName`, `#hbClass`): the vessel name; class and company underneath.
- **Failure card** in `#ctxStack`, above the contract card, only while a component is failed or being fitted. On
  phones the contract card collapses to a one-line pill while it shows.
- **Instrument strip** additions inside `#telemetry`: `SYS` ("Engine 64 %" amber, "FAILED" red) and `CREW`
  ("4/6 · tired"). The radar draws "RADAR FAULT" or "NO POWER" when `you.limits.radar === false`; the autopilot switches
  off with a reason when `you.limits.autopilot === false`.

### 2.4 Screens

Style: the v0.4 sheet components and `style.css` tokens; new CSS in `public/css/company.css` injected at runtime
(the `ensureCss` pattern of `public/js/telegraph.js`). No edits to `index.html` or `style.css`.

#### 2.4.1 Founding card (new players; once for migrated players)

```
┌ Found your shipping company ─────────────────────────────────────────┐
│ Name   [ Kraan & Zonen Shipping         ]  (3–32 chars, unique)       │
│ Colours  hull ●●●●●●●●●●●●  funnel ●●●●●●●●●●●●   [swatch preview]    │
│ Home harbour [Rotterdam ✓ Antwerp Hamburg Felixstowe Gothenburg …]   │
│   Free mooring · port dues −50 % · fuel −5 % · yard and parts −10 %   │
│ Starter ship (capital 250,000 cr)                                     │
│  [img] Coastal freighter 78 %  90,000   Freight ≤ 1,200 t   ▮▮▮▯▯     │
│  [img] Stern trawler     82 % 138,000   Fishing 6 t/h       ▮▮▯▯▯     │
│  [img] Harbour tug       75 % 236,000   Tows, no speed loss           │
│  [img] Pilot boat        90 %  72,000   26 kn, water-taxi charters    │
│  [img] Sports cruiser    80 % 114,000   30 kn, 6 guests               │
│  [img] Sloop 11 m        85 %  47,000   Sails; tiny costs             │
│ Ship name [ Sea Bee ]                                                 │
│ ☐ Starter loan +150,000 cr · 6.0 % · 12 × 12,904 cr from 07 Nov       │
│ Cash after founding: 160,000 cr                                       │
│                                    [ Found company and go aboard ]    │
└───────────────────────────────────────────────────────────────────────┘
```

Starter cards show what each ship earns per ship hour at its best work (the §3.10 table, computed in the browser from
the shared functions), so nobody picks a ship that cannot pay her way. Today the pilot boat cannot take charters
(charters need a yacht or a passenger ship, `needsCat`) and loses money on passenger runs (−16 cr per ship hour); wave 2
lets her take charters as a water taxi (§3.10: ~850 cr per ship hour). The trawler's catch reads 6 t/h on the Dogger
Bank after the §3.10 retune (30 t/h before it).
Phones: three steps (Name and colours → Home → Ship and loan). The game stays playable without the card (the
provisional company is complete). Migrated players see a pre-filled card headed "Your coaster is now the first ship of
your company" with no starter list; they may change name, colours and home once for free.

#### 2.4.2 Company HQ (full-screen sheet; key **O**; also a button in the More sheet)

Desktop: nav rail. Phones: bottom tabs. **Overview · Fleet · Bank · Crew · Books · Office.** Works docked or at sea.

```
Overview
┌───────────────────────────────────────────────────────────────────────┐
│ ■ Kraan & Zonen Shipping · home Rotterdam · rating B                  │
│ Cash 84,310 cr   Net worth 212,000 cr   This week +7,240 cr ▂▃▅▂▆▇▅   │
├ Needs you ────────────────────────────────────────────────────────────┤
│ ⚠ Sea Bee: fuel injectors failed, 22 nm W of Texel          [Show]    │
│ ⓘ Loan instalment 12,904 cr due Thu 07 Nov (in 3 d)         [Bank]    │
│ ⓘ Kittiwake needs crew (2 of 3) at Rotterdam                [Hire]    │
├ Fleet ────────────────────────────────────────────────────────────────┤
│ [img] Sea Bee   You are aboard · at sea · IJmuiden ETA 14:20 ▮fuel ▮hull│
│ [img] Kittiwake Moored · Rotterdam · standby crew            +0 cr 7 d │
├ Getting started (2/4) ────────────────────────────────────────────────┤
│ ✓ Hire crew  ✓ First delivery  ☐ Buy a spare  ☐ Visit the bank        │
└───────────────────────────────────────────────────────────────────────┘
```

- **Fleet:** one card per vessel: thumb, name, class, status chip, status line, position line, bars (fuel, hull,
  worst system, crew have/opt and morale, cargo), "Profit 7 d: +18,400 cr", buttons **[Take command]** (only when
  allowed, else the reason), **[Ship card]**, **[Lay up]**/**[Recommission]**, **[Sell · 55,836 cr]**, **[Rename]**.
- **Bank:** §2.4.3. **Crew:** every vessel's roster (moves only between ships in the same harbour).
- **Books:** this month's P&L against last month by category; profit per ship (7 d, 30 d); daily net bars for 35 days
  (canvas, no library); balance sheet (assets, liabilities, net worth); ledger list with month / ship / category
  filters and paging (`ledger` action); CSV export built in the browser (Blob download).
- **Office:** home harbour card and perks; storage slots with laid-up ships ([Recommission · 180 cr], [Sell]);
  [Buy storage slot · 40,000 cr]; name and colour editor; [Move home… · 50,000 cr].

#### 2.4.3 Bank

```
Accounts   Cash 84,310 · Overdraft limit 25,000 (unused) · 18 % on overdraft
Rating B — 6.5 % base. 3 more on-time instalments → A (5.0 %).
Loans
  Starter loan   ▮▮▮▯▯▯▯▯▯▯▯▯ 3/12 paid · balance 113,327 · next 12,904 on Thu 07 Nov  [Repay…]
New loan
  Ship mortgage  collateral [Kittiwake ▾]  market value 138,420 · max 96,894 (70 %)
  Amount ──●────── 96,600    Term (6) (12) [24] (36) (60)
  6.75 % · 24 × 4,310 cr · total interest 6,841 cr   [schedule ▾]   [Take loan]
Insurance
  Sea Bee    ✓ insured · value 90,120 · 113 cr/month · deductible 4,506
  Kittiwake  ☐ not insured · would cost 173 cr/month                 [Insure]
```

Quotes are computed in the browser with `shared/finance.js` (the server's own math) and re-checked by the server.
The shipyard's buy buttons offer **[Buy into fleet]**, **[Trade in]** (today's behaviour) and **[Finance 70 %]**.

#### 2.4.4 Crew (harbour sheet tab "Crew"; also HQ → Crew)

```
Your ships here                               Crew market · Rotterdam (new faces 18:00)
Sea Bee (coaster) — 4/6 · morale 72 · rested   [Engineer] ★★★★ Ingrid Berg (NO) "Tinkerer"
  Master   You                                   asks 450 cr/day · fee 1,350   [Hire for Sea Bee ▾]
  Mate     — empty (optional)  [Hire…]          [Captain] ★★★ Piet Jansen (NL)  (fleet work, v6)
  Engineer ★★★ Jan de Vries 330/day ▮▮▮▮▯ [Move][Dismiss · 2,310]
  Cook     ★★★ Ana Costa 160/day ▮▮▮▮▮
  Deck ×2  ★★ … ★★ …  1 optional slot free
  Effects: parts wear ×1.00 (engineer ★★★) · speed −4 % (1 deckhand short)
```

Empty **required** slots are red ("Required to sail"). [Hire…] on a slot filters the market to that role. Hiring
needs the vessel docked in this harbour. **[Hire minimum crew]** fills every missing required slot with the cheapest
candidates; a role the market lacks comes from an agency (2★, wage +25 %, fee doubled).

#### 2.4.5 Ship card, compare, systems, chandler and yard

- One modal for the ship you are aboard, any fleet ship, shipyard listings and starter offers: image, name, class,
  market value and yard price; stat bars in groups (§3.6) normalised within the category (toggle "compare to all");
  equipment chips. Owned ships add **Systems** (one row per system with the worst component's condition; expands to
  components with condition bar, status OK / worn / FAILED / jury-rigged / fitting 1 h 20 m left, spares aboard OEM and
  aftermarket, locker "3/8"), **Crew** summary and **Survey** ("due 06 Jan", or "DETAINED: steering gear 18 % < 25 %").
- **Compare:** up to 3 ships side by side in the existing compare tray, rows from `shared/shipstats.js`.
- **Services tab** gains *Chandler & yard*: per component [Buy spare OEM 480 · aftermarket 264] (stock shown),
  [Overhaul · 672 cr] (instant), [Fit spare] (ship time; works in port too), [Renew antifouling]. Existing cards stay:
  *Planned maintenance* (`service`, now also +30 to engine, power, pumps, nav and deck components) and *Repair yard*
  (hull).

#### 2.4.6 The breakdown moment (failure card)

```
┌ ⚠ MAIN ENGINE — fuel injectors failed ──────────────────────────────┐
│ Power limited to 80 % · fuel +8 %.                                   │
│ Spare aboard: Fuel injectors (OEM) ×1                                │
│ [Fit spare · ~1 h ship time · 95 %] [Jury-rig · ~3 h · 50 %] [Call tow · 11,000 cr] │
└──────────────────────────────────────────────────────────────────────┘
```

A new failure drops warp to 1× (the existing `dropWarp`), plays `sound.event('alarm')`, logs a red event and raises an
HQ alert. While fitting, the card shows progress on the ship's clock; the existing warp rules apply (up to 20× without a
route). Engine and drive work stops the engine (the card says so; the ship drifts). Yard-only components show
[Call tow] and "Make for a yard: <nearest major port, distance>".

#### 2.4.7 Switching ships ("Take command") — wave 2: same harbour only

Allowed when the ship you are aboard is moored and the target is moored in the same harbour, active (not laid up), not
under tug assist; 10 s cooldown. Buttons on the fleet card and in the harbour sheet's Crew tab ("Ships here"). A 350 ms
fade with "Taking command of Kittiwake — moored at Rotterdam".

| Moves with you | Stays with the ship | Company-wide |
|---|---|---|
| Camera (re-sized), HUD, telegraph (Stop), touch helm, interior (rebuilt for the class), your avatar, wanted level, your stats, log and chat | Position, berth, cargo, contracts, fuel, hull, components, spares, crew, fatigue, ship's clock (`shipTime`), service due date | Cash, loans, insurance, alerts, ledger |
| Reset: warp 1×, autopilot off, route cleared, convoy left, movement budget and shallow timer reset | | |

v6 adds switching to ships at sea (§8).

### 2.5 Phones

HQ, Crew and the ship card are full-screen sheets with bottom tabs (the harbour-sheet component). The company chip
collapses to swatch and cash. Fleet cards in one column, order buttons full width at 48 px. The failure card sits at
the top like the job card. The mortgage amount is an `input[type=range]` with a large thumb; terms are chips. The More
sheet gains **Company (O)**, created at runtime.

---

## 3. Rules and numbers

All numbers live in shared modules (§9) so the client shows exactly what the server charges. A **month is 30 days**
(2,592,000 s) on the world clock; days are UTC. Money is integer credits.

### 3.1 Company, founding, home, storage

| Rule | Value |
|---|---|
| Founding capital | 250,000 cr (ledger `capital`), replaces `START_MONEY = 25000` |
| Provisional company (every new player) | name "`<player>` Shipping" (dedupe " II", " III"), home Rotterdam, colours from a hash of the id, starter coaster 78 % bought for 90,000, minimum crew hired free at 3★ engineer / 2★ deckhands ("founding crew"), `founding: true`, cash 160,000 |
| Starter offers (used-ship formula, rounded to 1,000) | coaster 78 % 90,000 · trawler 82 % 138,000 · tug 75 % 236,000 · pilot 90 % 72,000 · cruiser 80 % 114,000 · sloop 85 % 47,000. The yard would pay 55,836 / 86,526 / 145,200 / 46,035 / 70,950 / 29,535 for them, so a starter can never be sold at a profit. |
| `found_company` while `founding` | rename, colours, home (the ship moves to a free fitting berth there), starter swap (refund the starter's price, buy the new one; refused with contracts or cargo aboard), optional starter loan (once). The swap re-staffs the founding crew to the new class's **minimum** for free (no fees, no severance): a pilot boat, cruiser or sloop has no required crew and only one optional slot, so the three-person coaster crew would otherwise keep drawing 540 cr/day on a ship that needs none of them, beyond her slot count. `founding` ends on the first cast-off or on [Found company]. |
| Coaster | `SHIP_CLASSES.coaster.price` 0 → **120,000** (= today's `hullBasis` floor; repair and service unchanged). The coaster appears in the shipyard and the used lists; `shipValue(coaster, 100)` = 66,000. |
| Home perks | moored free (berth fee 0 for every company ship at home), port dues −50 %, fuel −5 %, yard work and chandler −10 % |
| Founding homes | `rotterdam, antwerp, hamburg, felixstowe, gothenburg, bergen, aberdeen` |
| Move home | 50,000 cr, once per 7 days, to any `major` or `mega` port or a founding home; refused while any ship is laid up |
| Storage (lay-up) | at home only; 3 slots free, more at 40,000 each up to 8; fee `max(25, round(0.01 × displacement))` cr/day (coaster 32, feeder 140, boxship 1,100) |
| Laid-up ship | docked at home, no jobs, no cargo, not the ship you are aboard; no wages (crew stays, morale −1/day, floor 50); insurance × 0.25; no wear, no survey clock, no berth fee. Recommission: instant, 0.2 % of market value. |
| Names | company `^[\p{L}\p{N} &'.\-]{3,32}$`u, unique case-insensitively; `short` ≤ 12 chars for labels (default: the first word); vessel 2–24 chars, unique in the company; default names from a list (Sea Bee, Kittiwake, North Star, Grey Gull, Dogger Lass, Morning Tide, …) |
| Colours | `hull`, `funnel`, `band` each one of 12 palette values: navy `#1d3557`, black `#1b1b1b`, green `#1f4d3a`, red `#8b1e1e`, grey `#5b6770`, white `#e9ecef`, blue `#2463b0`, orange `#d9531e`, teal `#0f6e6e`, maroon `#5a1a2b`, sand `#c2a878`, yellow `#e8a317` |
| Young-company trade cap | a company younger than 7 days cannot send or accept player trade offers above 50,000 cr (stops new accounts funnelling capital) |

**Market value** `marketValue(cls, ci) = round(price × (0.4 + 0.45 × ci/100))` (the used-listing formula without
noise), with condition index `ci = 0.6 × hull + 0.4 × mean(component condition)`. Used for collateral, insurance,
the balance sheet and repossession sales. The yard's buying price stays `shipValue(cls, hull)` (today's rule) and both
are shown: "Market value 90,120 · yard pays 55,836".

### 3.2 Money: modes and categories

| Mode | Used for | Rule |
|---|---|---|
| voluntary `charge` | fuel, repairs, service, overhaul, parts, kits, tugs (player), express, goods, ships, slots, recommission, hire fees | posts if `cash − amt ≥ −odLimit`; else posts nothing, returns `null`, the caller says why. Partial fuel and repair fills use `available = cash + odLimit`. |
| scheduled `chargeDue` | instalments, premiums, storage | same headroom rule; on refusal the caller records a missed payment |
| forced `chargeForced` | wages, port dues, pilotage, berth, survey, fines, cancellation fees, tows, severance, late fees, overdraft interest | always posts, may go below `−odLimit` (arrears) |
| `credit` | contract pay, sales, claims, loan drawdowns | |
| `transfer` | player-to-player trades | voluntary for the payer; two lines sharing a `ref` |

**Behaviour change:** today `Math.max(0, p.money − fee)` silently forgives fees when a player is broke; with an
overdraft the same line would *create* money (cash −5,000 → 0). Every such clamp is removed; forced charges post in
full and the overdraft/default process is the safety net. The tow fee is rescaled at the same time, because the old
clamp hid a formula left over from the 13 m world unit: `towFee(distM) = min(50,000, 3,000 + round(0.2 × distM))`
(40 km → 11,000; it was 83,000, capped at the player's cash).

**Categories** (`cat`, with optional `sub`):

| Group (P&L) | Categories |
|---|---|
| Income | `contract`, `trade_sale`, `p2p_sale`, `claim` |
| Operating | `fuel`, `wages`, `crew_fees` (hire, severance), `port` (sub `dues`/`pilotage`/`berth`), `tugs` (sub `assist`/`tow`), `storage`, `repair` (sub `hull`/`service`/`overhaul`/`coating`), `parts` (spares, kits), `insurance`, `express`, `survey` |
| Cost of goods | `trade_buy`, `p2p_buy` |
| Finance | `interest` (sub `loan`/`overdraft`), `bank_fees` (late fees) |
| Other | `fines` (sub `fine`/`cancel`/`seizure`), `write_off` (debt forgiven, positive) |
| Capital (not P&L) | `capital` (founding capital, founder grant, opening balance), `ship_buy`, `ship_sale`, `loan_in`, `loan_out` (principal) |
| Never in production | `adjust` (direct `p.money =` writes from tests/admin; `/api/health` reports their count) |

**P&L** = income − operating − cost of goods − finance + other. **Balance sheet:** assets = max(cash, 0) + Σ market
value of active and laid-up ships (loaners excluded) + spares at 50 % of OEM price + free cargo at 80 % of the goods'
base price; liabilities = Σ loan balances + interest accrued since the last due date + max(−cash, 0) + unsettled
wages; equity (net worth) = assets − liabilities.

### 3.3 Bank

| Item | Rule |
|---|---|
| Rating | A / B / C / D, start B (new and migrated). Base APR A 5.0 %, B 6.5 %, C 9.0 %, D no new credit. +1 step (max A) after 6 consecutive on-time instalments with no arrears; −1 step for each instalment that goes late; D on default, no credit for 60 days, then C. |
| APR | `base(rating) + 0.25 % × (termMonths − 12)/12` for terms > 12. Mortgage terms 6, 12, 24, 36, 60 months. |
| Starter loan | 150,000 at 6.0 %, 12 months, once, only while `founding`; secured on the starter ship (loan-to-value waived); exempt from the affordability rule |
| Ship mortgage | secured on one vessel (owned, or bought in the same action); ≤ 70 % of market value (or of the purchase price); min 10,000; one per vessel; insurance compulsory while it runs |
| Affordability | Σ monthly instalments after the new loan ≤ max(20,000, 40 % of the trailing 30-day `contract` income) |
| Instalment | `r = APR × 30/365`; `A = round(P·r / (1 − (1+r)^−n))`; interest `round(balance × r)`, principal = A − interest; the last instalment is `balance + interest`. Due dates `startedAt + k × 30 d`. Two lines per instalment: `interest/loan` and `loan_out`. |
| Early repayment | any amount at any time: interest accrued since the last due date `round(balance × APR × elapsed / 365 d)`, then principal; no fee; the instalment is recomputed over the remaining months |
| Overdraft | automatic. Limit `clamp(10 % × fleet market value, 25,000, 2,000,000)`, recomputed daily; 0 at rating D. 18 % APR on the negative balance, accrued with an integer remainder (§4.3), posted at each UTC midnight. |
| Late | if `chargeDue` refuses on the due date: late fee 2 % of the instalment (min 100) once, retry at every settlement, alerts on days 0, 7, 14, 21, 28 |
| Default | 30 days late, or a second instalment missed, or cash below `−odLimit` for 30 days |
| Repossession (at default) | mortgage or starter loan: its collateral; overdraft default: ships in order laid-up → lowest market value not aboard → the ship you are aboard, until cash ≥ 0. Sold at 60 % of market value (`ship_sale`), proceeds pay the loan (`loan_out`) and fees; surplus to cash; a shortfall is written off (`write_off`). Contract deliveries due at that harbour are paid first; contract cargo goes back; crew discharged with severance. A ship at sea is flagged and seized at its next docking, or towed in (forced tow fee) after 72 h. |
| Empty fleet | after a sinking, seizure or repossession the yard lends a **tired coaster (60 %)**: it cannot be sold, mortgaged or insured, and goes back free the moment the company buys another ship. If the company is then in default with negative cash, the remaining debt is written off (`write_off`), cash set to 0, rating D for 60 days ("bankruptcy"). |

Worked example — starter loan 150,000 at 6.0 % for 12 months, drawn 08 Oct 10:00 UTC:

| # | Due | Payment | Interest | Principal | Balance |
|---|---|---|---|---|---|
| 1 | 07 Nov 10:00 | 12,904 | 740 | 12,164 | 137,836 |
| 2 | 07 Dec 10:00 | 12,904 | 680 | 12,224 | 125,612 |
| 3 | 06 Jan 10:00 | 12,904 | 619 | 12,285 | 113,327 |
| 12 | 04 Sep 10:00 | 12,907 | — | — | 0 |

Total interest 4,851. Other reference values (tests assert them): coaster mortgage 63,000 at 6.5 % × 12 → 5,434;
trawler 96,600 at 6.75 % × 24 → 4,310 (interest 6,841); feeder 665,000 at 7.0 % × 36 → 20,504 (interest 73,151);
overdraft −12,400 for 30 days → 183 cr.

### 3.4 Insurance (hull and machinery, per ship)

| Item | Value |
|---|---|
| Premium | `round(rate × marketValue / 12)` per month, billed in advance on the world clock (`chargeDue`); rate 1.5 %/year, tankers 2.0 %, motor and sailing yachts 1.2 % |
| Modifiers | × (1 + 0.25 × claims in the last 365 d), cap × 2; × 0.25 while laid up |
| Deductible | max(2,000, 5 % of insured value) — replaces today's flat 2,000 "insurance excess" |
| Total loss (sinking) | pays value − deductible; a mortgage on the ship is paid off first, the rest to cash; no payout if cover started < 7 days ago |
| Major damage | collision and grounding damage within one hour summed per ship; ≥ 10 hull points → a claim note on the ship; the next hull repair within 30 days is credited (repair cost of those points − deductible, if positive) |
| Not covered | wear, components, cargo, fines, seizure |
| Default | new ships insured (opt out in the Bank tab); migrated ships insured; mortgaged ships cannot opt out |
| Suspended | premium refused (retried at each settlement), or class survey > 30 days overdue: "Cover suspended" — no claims until it resumes |

Examples: coaster 78 % (value 90,120): 113 cr/month, deductible 4,506. Feeder 100 % (807,500): 1,009 cr/month,
deductible 40,375.

### 3.5 Crew

**Roles:** captain, mate, engineer, cook, deckhand. You are the unpaid master of the ship you are aboard and count as
3★ for the roles you cover. A hired captain aboard your ship fills a mate slot (captains run ships without you from
v6). Skill 1–5★.

| Role | Wage/day at 3★ | Affects |
|---|---|---|
| Captain | 450 | fleet work without you (v6); counts as mate while you are aboard |
| Mate | 300 | wear on steering and nav; watches (fatigue) |
| Engineer | 330 | wear and hazard on engine, drive, power, pumps; fuel; fitting time and success |
| Cook | 160 | morale |
| Deckhand | 130 | wear on deck, gear and rig |

Wage = `base × skillMul × ask × CREW.WAGE_SCALE`, rounded to 5; skillMul 1★ 0.6, 2★ 0.8, 3★ 1.0, 4★ 1.35, 5★ 1.8;
ask 0.9–1.15 (grumblers 10 % less); `WAGE_SCALE = 1.0`. Hire fee 3 days' wage; severance 7 days' wage.

**Requirements** (mate / engineer / cook / deckhands; the master is extra), with cost per day at 3★:

| Class | Minimum | Optimal | Min/day | Opt/day | Today's `crewCost`/day |
|---|---|---|---|---|---|
| coaster | 0/1/0/2 | 1/1/1/3 | 590 | 1,180 | 960 |
| feeder | 1/1/1/3 | 2/2/1/5 | 1,180 | 2,070 | 2,880 |
| bulker, tanker | 1/2/1/4 | 2/3/1/7 | 1,640 | 2,660 | 4,320 |
| boxship | 2/2/1/5 | 3/4/2/9 | 2,070 | 3,710 | 9,600 |
| trawler | 0/1/0/2 | 1/1/1/4 | 590 | 1,310 | 840 |
| tug | 0/1/0/1 | 1/1/0/2 | 460 | 890 | 1,080 |
| psv | 1/1/1/2 | 2/2/1/4 | 1,050 | 1,940 | 2,160 |
| pilot | 0/0/0/0 | 0/0/0/1 | 0 | 130 | 360 |
| ferry | 1/2/2/4 | 2/3/4/10 | 1,800 | 3,530 | 3,600 |
| myacht | 0/0/0/1 | 1/1/1/2 | 130 | 1,050 | 480 |
| superyacht | 1/1/2/3 | 2/2/3/6 | 1,340 | 2,520 | 5,280 |
| schooner | 0/0/0/2 | 1/1/1/4 | 260 | 1,310 | 1,440 |
| cruiser, sloop, ketch, catamaran | 0/0/0/0 | 0/0/0/1 | 0 | 130 | 0 |

Balance check for freight only — fishing and goods trading earn far more and are handled in §3.10
(coaster, 400 t over 300 km at service speed, 15.2 h): pay 10,400; fuel 5,661; crew at optimal 749
(today 609); hull repair 1,115; dues and berth ~600 → about 2,000 profit (A's wages would leave ~300). A full 1,100 t
load pays 27,200 for 16.8 h. Contract pay is not retuned in this wave; `WAGE_SCALE` is the knob for the retune.

**When wages accrue** (§4.3 explains the mechanics):

| Ship state | Rate |
|---|---|
| At sea (you aboard, online or on an offline voyage) | full, per ship-hour (× warp, as today) × 1.2 while towing (existing rule) |
| Moored, first 24 h of the stay (world clock) | full |
| Moored after 24 h | 30 % standby |
| Laid up | 0 |
| Owner offline for more than 7 days | 0 (unpaid shore leave) until the owner's next login |

**Below minimum crew** `undock` is refused with the missing roles and a [Hire] button. Between minimum and optimal,
`maxThrottle = max(0.85, 1 − 0.04 × missing optimal slots)` and fatigue builds.

**Fatigue** (per ship, 0–100): at sea per ship-hour `+1.5 × shortFrac + 0.6 × storm`, or `−0.4` when fully crewed and
storm < 0.3 (`shortFrac` = missing optimal slots / optimal slots); moored −10 per world hour. Above 70: wear × 1.3,
hazard × 1.5, morale target −20.

**Morale** (per person, 0–100, start 70) drifts 20 % per UTC day toward the target: 65; cook +5 × (best cook skill − 2),
−10 if the class wants a cook and has none; pay ±15 × clamp((wage / fair wage − 1) × 2, −1, 1); −20 when fatigue > 70;
−10 when hull < 40; traits ±5; +5 per delivery in the last 48 h (cap +15); −10 per failure in the last 48 h. Morale
< 40: effective skill −1. Morale < 25: a 25 % chance per UTC day to quit at the next docking, with an alert the day
before (drawn from the vessel's seeded RNG).

**Effect table** (engineer for engine/drive/power/pumps; mate for steering/nav; mean deckhand skill for deck/gear/rig;
"none" = no one in the role; you count as 3★ for roles your class does not require):

| Effective skill | Wear | Hazard | Fuel | Fit time | Fit success |
|---|---|---|---|---|---|
| none | × 1.6 | × 1.2 | +6 % | × 2.0 | −25 % |
| 1★ | × 1.30 | × 1.1 | +4 % | × 1.6 | −16 % |
| 2★ | × 1.15 | × 1.05 | +2 % | × 1.3 | −8 % |
| 3★ | × 1.00 | × 1.0 | 0 | × 1.0 | 0 |
| 4★ | × 0.88 | × 0.95 | −2 % | × 0.85 | +3 % |
| 5★ | × 0.75 | × 0.9 | −4 % | × 0.7 | +6 % |

**Traits** (40 % of candidates): steady (hazard −10 %), frugal (fuel −2 %), tinkerer (fit time −25 %, jury-rig 65 %),
cheerful (morale target +5), grumbler (morale target −5, asks 10 % less), stormproof (heavy-weather wear −15 %).

**Crew market** per harbour: mega 10, major 8, regional 6, minor 4 candidates; roles 15 % captain, 15 % mate, 20 %
engineer, 10 % cook, 40 % deckhand; skill 20/30/30/15/5 % for 1–5★ (5★ only at mega and major ports); names and
nationality from the harbour's country (30 % foreign). Generated from seed `harborId + ':' + floor(now / 6 h)`, so it is
deterministic and shared; a hire removes the candidate for everyone (`harborState.crewTaken = { idx, ids }`).

### 3.6 Ship stats (V5 item 20) — `shared/shipstats.js`

Derived values are functions, not stored. Service speed and fuel at service speed come from `shared/rates.js`
(`serviceKn`, `serviceBurnTph`; throttle 0.8).

| Class | Air draft m | Thrusters | Max Hs m | Hull strength | Ice | sfoc g/kWh | Reliability | Comfort | Eco | Locker | Equipment |
|---|---|---|---|---|---|---|---|---|---|---|---|
| coaster | 28 | bow | 5 | 0.60 | — | 195 | 0.9 | 1 | D | 8 | 2 deck cranes |
| feeder | 38 | bow | 7 | 0.65 | 1C | 180 | 1.0 | 1 | C | 10 | gearless, 285 TEU |
| bulker | 45 | — | 8 | 0.75 | 1C | 170 | 1.0 | 1 | D | 12 | cranes 4 × 30 t |
| tanker | 44 | — | 8 | 0.80 | 1B | 170 | 1.0 | 1 | C | 12 | cargo pumps |
| boxship | 60 | bow | 9 | 0.80 | — | 165 | 1.1 | 1 | B | 16 | gearless, 6,430 TEU |
| trawler | 18 | bow | 6 | 0.70 | 1C | 205 | 0.95 | 1 | D | 6 | trawl winch, fish hold |
| tug | 17 | azimuth | 5 | 0.85 | 1C | 200 | 1.1 | 1 | C | 6 | tow winch, FiFi |
| psv | 25 | DP2 | 9 | 0.80 | 1B | 190 | 1.1 | 2 | B | 10 | deck crane, DP |
| pilot | 6 | twin screw | 4.5 | 0.55 | — | 220 | 1.0 | 2 | C | 3 | — |
| ferry | 32 | bow + stern | 6 | 0.65 | 1C | 185 | 1.0 | 3 | C | 12 | vehicle ramps |
| cruiser | 4 | bow | 1.5 | 0.35 | — | 240 | 0.9 | 3 | E | 2 | — |
| myacht | 8 | bow + stern | 3 | 0.45 | — | 225 | 1.0 | 4 | D | 3 | — |
| superyacht | 22 | bow + stern | 5 | 0.60 | — | 200 | 1.05 | 5 | E | 8 | tender crane |
| sloop | 16 | — | 4 | 0.50 | — | 250 | 1.0 | 2 | A | 1 | sails |
| ketch | 20 | — | 6 | 0.55 | — | 250 | 1.0 | 3 | A | 2 | sails |
| catamaran | 21 | twin screw | 4 | 0.45 | — | 250 | 1.0 | 4 | A | 2 | sails |
| schooner | 38 | — | 5 | 0.55 | — | 230 | 0.85 | 5 | B | 4 | sails |

Derived: power kW = `burn × 10^6 / sfoc` (coaster 4,615); range nm = `fuelCap / serviceBurnTph × serviceKn` (sailing
yachts: engine only, shown "∞ under sail · 119 nm on the engine"; coaster 1,775, feeder 2,675, boxship 13,948);
fuel cr/day at 650 cr/t (coaster 7,874); crew min/opt and cr/day (§3.5); maintenance cr/day = Σ components
`wear%/h × 12 h × 0.8 × OEM price / 100` + service/30; manoeuvrability = `turnRate` normalised + 0.15 per thruster
set; market value and yard price. Each row has `bar ∈ [0, 1]` normalised within `cat`, and `better: 'high'|'low'`.

**Wired in this wave:** hull strength → collision and grounding damage × `1.3 − 0.6 × hull`; seakeeping → above
`maxHs` hull and steering wear × `1 + 2 × (waveH − maxHs)/maxHs`; eco → port dues in the North Sea box
(`inDetailRegion`, server/lanes.js; `ecoDuesMul` in `shared/shipstats.js` uses the identical `LAYERS[1]` box) A −15 %, B −8 %, C 0, D +5 %, E +10 %; comfort → passenger and charter pay ×
`(0.85 + 0.075 × comfort)` applied at acceptance; reliability → hazard ÷ reliability; locker → spares capacity.
Air draft and thrusters are display-only until bridges (item 16) and own-power berthing.

### 3.7 Components, wear, breakdowns, fixing, surveys (V5 item 21) — `shared/parts.js`, `server/parts.js`

**Catalogue.** OEM price = `priceFrac × hullBasis(cls)` (coaster figures in brackets); aftermarket 55 %. Tier = the
smallest harbour that stocks it (1 minor, 2 regional, 3 major, 4 mega). "yard" = cannot be fitted at sea.
✓ = critical for the class survey.

| key | System | MTBF h | Wear %/h | priceFrac (coaster) | Fit h | Where | Tier | ✓ | Failure effect |
|---|---|---|---|---|---|---|---|---|---|
| `engine.injectors` | Main engine | 1,500 | 0.06 | 0.004 (480) | 1 | sea | 1 | | maxThrottle 0.8, fuel × 1.08 |
| `engine.fuelpump` | Main engine | 2,500 | 0.04 | 0.006 (720) | 2 | sea | 2 | | no propulsion (throttle held at 0) |
| `engine.turbo` | Main engine | 3,000 | 0.03 | 0.020 (2,400) | 6 | sea | 3 | | maxThrottle 0.5 |
| `engine.heads` | Main engine | 4,000 | 0.025 | 0.015 (1,800) | 10 | sea | 3 | | maxThrottle 0.65, fuel × 1.05 |
| `drive.gearbox` | Gearbox & shaft | 6,000 | 0.015 | 0.030 (3,600) | — | yard | 4 | | no propulsion |
| `drive.seal` | Gearbox & shaft | 4,000 | 0.025 | 0.005 (600) | — | yard | 2 | | leak 0.35 flooding/ship-h (a patch kit halves it) |
| `drive.propeller` | Gearbox & shaft | 10,000 | 0.008 | 0.015 (1,800) | — | yard | 3 | | maxThrottle 0.75 |
| `steering.gear` | Steering | 5,000 | 0.02 | 0.008 (960) | 4 | sea | 2 | ✓ | rudder jammed; after 0.5 ship-h emergency steering, rudder × 0.3 |
| `steering.thruster` | Steering | 3,000 | 0.02 | 0.012 (1,440) | 6 | sea | 3 | | hulls ≥ 60 m may berth only with tugs |
| `power.gen1`, `power.gen2` | Power | 2,500 | 0.04 | 0.020 (2,400) | 5 | sea | 2 | ✓ | one: warning only; both: blackout |
| `power.switchboard` | Power | 8,000 | 0.01 | 0.003 (360) | 2 | sea | 2 | ✓ | blackout |
| `nav.radar` | Navigation | 4,000 | 0.02 | 0.004 (480) | 1 | sea | 2 | | radar off |
| `nav.gps` | Navigation | 8,000 | 0.01 | 0.002 (240) | 0.5 | sea | 1 | ✓ | autopilot off |
| `nav.ais` | Navigation | 8,000 | 0.01 | 0.0015 (180) | 0.5 | sea | 1 | ✓ | survey only |
| `nav.vhf` | Navigation | 10,000 | 0.01 | 0.001 (120) | 0.5 | sea | 1 | ✓ | cannot call tugs |
| `nav.dp` (psv) | Navigation | 3,000 | 0.02 | 0.030 | 2 | sea | 3 | | platform transfer needs < 1.5 kn (else < 3 kn) |
| `pumps.bilge` | Pumps | 4,000 | 0.02 | 0.003 (360) | 2 | sea | 1 | ✓ | no pumping out (the −0.3/h pump-out stops) |
| `pumps.ballast` | Pumps | 5,000 | 0.015 | 0.003 (360) | 2 | sea | 2 | | maxThrottle 0.95 (list) |
| `pumps.fire` | Pumps | 6,000 | 0.01 | 0.003 (360) | 2 | sea | 1 | ✓ | survey only |
| `hull.coating` | Hull | — | 0.02 | 0.010 (1,200) | — | yard | 1 | | continuous: maxThrottle ≤ 1 − 0.08(1 − c/100), fuel × (1 + 0.10(1 − c/100)) |
| `deck.windlass` | Deck | 5,000 | 0.01 | 0.005 (600) | 4 | sea | 2 | | survey only (anchoring comes with v6 "hold") |
| `deck.winches` | Deck | 5,000 | 0.01 | 0.005 (600) | 4 | sea | 2 | | hulls ≥ 30 m may berth only with tugs |
| `deck.hatches` (cargo classes) | Deck | 6,000 | 0.01 | 0.003 (360) | 3 | sea | 2 | | sea > 0.5: free cargo −0.5 %/ship-h |
| `deck.crane` (coaster, bulker, psv) | Deck | 3,000 | 0.03 | 0.025 (3,000) | — | yard | 3 | | offshore supply transfer refused |
| `deck.ramp` (ferry) | Deck | 4,000 | 0.015 | 0.020 | — | yard | 3 | | passenger and charter contracts refused |
| `gear.trawl` (trawler) | Gear | 800 fishing-h | 0.10 | 0.008 | 2 | sea | 1 | | catch × 0.5 |
| `gear.trawlwinch` (trawler) | Gear | 3,000 fishing-h | 0.04 | 0.012 | 6 | sea | 2 | | nets cannot be used |
| `gear.towwinch` (tug, psv) | Gear | 3,000 towing-h | 0.04 | 0.015 | 6 | sea | 3 | | tow pickup refused; a tow on the line parts (the job continues) |
| `rig.sails` (sailing) | Rig | 2,000 sail-h | 0.03 × wind/10 | 0.050 | 2 | sea | 2 | | sails cannot be set |
| `rig.standing` (sailing) | Rig | 8,000 | 0.008 | 0.040 | — | yard | 3 | ✓ | dismasted: sails cannot be set |

`componentsFor(cls)`: motor ships get engine, drive, steering.gear, power, nav (radar, gps, ais, vhf), pumps, hull,
deck.windlass, deck.winches; plus thruster where the stats table lists one; hatches on cargo classes; crane, ramp, DP,
trawl, tow winch as noted; gen2 on ships ≥ 30 m. Motor yachts drop hatches and fire pump (cruiser also radar and gen2).
Sailing yachts: engine.injectors, engine.fuelpump, drive.*, steering.gear, power.gen1, nav.gps, nav.ais, nav.vhf,
pumps.bilge, hull.coating, deck.windlass, rig.*. The set is reconciled lazily (a class change adds missing components
at 100; extra ones are kept but ignored), so tests that set `p.ship.cls` keep working.

**Load `L` per ship-hour:** engine and drive `0.4 + 0.8 × thr²` while |throttle| > 0.03, plus 1.0 after 30 ship-min at
≥ 0.95 (over-revving), else 0; steering `1 + 2 × sea²` at sea; power, nav, pumps, coating 1 at sea; deck 0.5 at sea and
winches/windlass −0.3 per mooring; thruster 1 within 4 km of a harbour anchor at ≤ 6 kn, else 0.1; gear only while
fishing/towing; rig only with sails set (× wind/10). **Docked or laid up: no wear and no failures.**

**Wear:** `c −= wearPerH × L × crewWear × fatigueMul × serviceWearMul(serviceDue) × class wearMul × hrs`, float,
floor 0, never rounded in the tick. `hrs` is the tick's ship-hours (the same `dt × warp / 3600` that advances `shipTime`).

**Failure (cumulative hazard, B):** `λ = PARTS.HAZARD_SCALE / (MTBF × reliability) × (1 + 9 × (1 − c/100)²) × Lλ ×
(aftermarket ? 1.6 : 1) × crewHazard × fatigueHazard × serviceWearMul`, with `Lλ = L` for engine and drive and
`max(L, 0.3)` otherwise at sea; `z += λ × hrs`; the part fails when `z ≥ zl`, `zl = −ln(1 − u)` drawn from the vessel's
RNG (`mulberry32(v.rng)`) when the part is fitted or overhauled. `c ≤ 0` fails at once. `HAZARD_SCALE = 0.5`. On failure
`c −= 10`. Expected (coaster, all components at the same condition, service throttle 0.8, open sea, calm, OEM, 3★
crew): system MTBF ≈ 370 ship-h at c = 100 (3.5 % chance of a failure on a 13 h voyage), ≈ 204 h at 70 (6.2 %),
≈ 114 h at 50 (10.8 %), ≈ 68 h at 30 (17.3 %). With warp a player sails 20–100 ship-hours per real hour, so a
well-kept coaster sees a failure every 4–18 real hours of warped sailing; most are minor (injectors, one generator,
nav). The same failure happens at the same ship-time at any tick rate and warp.

**Fixing:**
- **Fit spare** (`part_fit {key, mode: 'oem'|'aft'}`): at sea for "sea" parts, or in port; needs the spare aboard and
  an engineer (or you, on classes with no required engineer). Takes `fitH × fitTimeMul` ship-hours, counted down on the
  ship's clock; engine/drive work holds the throttle at 0. Success chance OEM 0.95 / aftermarket 0.85 plus the skill
  adjustment (§3.5), cap 0.99, rolled from the vessel RNG at the end. Success: `c` = 100 (OEM) or 90 (aftermarket),
  `z = 0`, new `zl`. Failure: the spare is used up, the fault remains; try again.
- **Jury-rig** (`part_fit {key, mode: 'jury'}`, no spare, sea parts only): 3 × fit time; success 50 % (65 % with a
  tinkerer); success clears the fault with `c = 15` and a `jury` flag (fails the survey; high hazard). Failure: try again.
- **Call tow** (existing `tow` action, new fee §3.2).
- **Yard overhaul** (`yard_overhaul {key}`, docked, any harbour): instant, guaranteed, `c = 100`, `z = 0`; cost
  `round(OEM × (0.4 + (failed ? 1 : 0.8 × (100 − c)/100)))`, −10 % at home. Failed injectors on a coaster: 672.
- **Planned maintenance** (existing `service`, 1 % of hullBasis): also +30 to engine, power, pumps, nav and deck
  components (cap 100), `z = 0` for them, and resets `serviceDue` (still on the world clock, 30 days).
- **Antifouling** (`coating_renew`): price only, back to 100.
- **Hull:** existing `repair` (plus the major-damage claim credit, §3.4).

**Chandler** (`harborState.chandler`, from seed `harborId + ':' + floor(now / 6 h)`): every component with
tier ≤ harbour tier, 1–4 units OEM and 1–4 aftermarket; price × 1.10 at minor and regional ports, × 0.90 at home.
Purchases decrement a per-refresh `taken` map. The locker holds `locker` spares (stats table); spares have no mass.

**Class survey:** every 90 world days. Automatic on docking at a major or mega port within 30 days either side of
the due date, or at any port once overdue. Fee 0.2 % of hullBasis (min 500, `survey`). Pass: hull ≥ 40, every critical
component ≥ 25 and neither failed nor jury-rigged. Fail → **detained**: `undock` refused with the list of fixes; a free
re-survey runs after any yard work at that port. More than 30 days overdue → insurance suspended. Laid-up ships: the
clock pauses; recommissioning surveys if due within 30 days.

### 3.8 What costs money, by ship state

| | At sea | Moored | Laid up |
|---|---|---|---|
| Fuel | burned per ship-hour | — | — |
| Wages | full, per ship-hour | first 24 h full, then 30 % | 0 |
| Berth | — | per started day (billed daily; 0 at home) | — |
| Storage | — | — | per day |
| Insurance | monthly | monthly | monthly × 0.25 |
| Wear and failures | components and hull | none | none |
| Loans, overdraft | world clock, whatever the ship does | | |

### 3.9 Downtime

On load, if `now − savedAt > 10 min`, every world-clock company timer is shifted forward by the gap: `loan.nextDue`,
`loan.lateSince`, `company.od.lastAt`, `company.od.overSince`, `company.noCreditUntil`, `vessel.policy.nextBill`,
`vessel.storagePaidTo`, `vessel.clockAt`, `vessel.dockedAt`, `vessel.survey.due`, `vessel.serviceDue`, alert
schedules. Ships do not move during downtime (unchanged). Markets keep drifting (unchanged).

### 3.10 Earning power and the balance gate

Loans, wages, insurance and lay-up only matter while money is not trivially easy. §3.5 checked freight; with today's
numbers the money is in fishing and goods trading, which make every wave-2 cost irrelevant: a trawler starter nets ~9,000
cr per ship hour, repays the 150,000 starter loan in about one real hour at 20× and buys a feeder in an evening.

Net credits per **ship hour** for the starters' best work (service speed, optimal crew at §3.5 wages, fuel 650 cr/t,
hull wear at repair cost, dues; computed from the current formulas during the review, recomputed by the gate test):

| Ship · work | Today | After the retune |
|---|---|---|
| Coaster · freight 400 t × 300 km (median contract) | 142 | 142 |
| Coaster · freight 1,100 t × 300 km (full hold) | 956 | 956 |
| Coaster · fishing contract 100 t, Southern Bight | 3,073 | 546 |
| Trawler · fishing contract 100 t, Southern Bight | 9,181 | 3,021 |
| Trawler · 300 t caught, sold at Rotterdam | 9,732 | 2,520 |
| Coaster · steel trade 1,200 t, 410 km, 18 % price gap (V6-QUICK §3.3 example) | 7,183 | 1,740 |
| Tug · tow contract, 150 km | 2,185 | 2,185 |
| Sports cruiser · charter, 6 guests, 200 km | 754 | 754 |
| Pilot boat · 8 passengers, 200 km / charter as water taxi | −16 / not allowed | −16 / 853 |
| Sloop · charter, 4 guests, 200 km | 68 | 68 |

**What wave 2 changes** (W2-SERVER, in the same commit as `test/balance.test.mjs`):
1. **Catch rate:** `RATES.FISH_T_PER_H` 10 → **2** in `shared/rates.js` (through the integrator; if TIME-MODEL has not
   merged yet, also `FISH_RATE_T_PER_H` in `server/game.js`). Trawler 6 t/h on the Dogger Bank, 4.2 t/h on the Southern
   Bight; coaster 0.84 t/h (a freighter is not a fishing boat). TIME-MODEL's generator keeps every contract feasible for
   its rated ship at any rate, so this changes durations (a 100 t trawler job is ~29 ship hours, ~1.5 real hours at
   20×), not feasibility.
2. **Trading:** `TRADE.SPREAD` 0 → **0.01**, `TRADE.IMPACT` false → **true** in `server/economy.js` (V6-QUICK §3.3), and
   `tradeGoods` prices every buy and sell with `tradeQuote` (§4.8). Selling 300 t of fish at Rotterdam then fetches 96 %
   of the posted price; a 1,200 t steel cargo moves both harbours' prices. The World market shows two prices.
3. **Pilot boat as water taxi:** charters accept `cls === 'pilot'` besides `needsCat` (game.js `acceptJob`; TIME-MODEL's
   `hardReason` in `shared/jobtime.js` gets the same exception, §7.2).

**The gate** (`test/balance.test.mjs`, W2-SERVER): recomputes the table from the shared functions with fixed scenarios
(crafted stocks, no RNG) and asserts (a) coaster median freight > 0; (b) every starter's best work earns more than 0
(the sloop is the slow, cheap hobby choice at 68); (c) no starter's best work > 3.5 × the coaster's full-hold freight
(956 → 3,346). It prints the table so a retune shows its effect. With today's numbers (a) holds and (b) (pilot boat) and
(c) (trawler, trade) fail — that is the point: wave 2 does not ship until they pass. After the retune: trawler 3,021 (3.2×), steel trade 1,740 (1.8×), tug 2,185 (2.3×). Starter loan
check after the retune: a coaster player covers the 12,904 cr instalment with 1–5 real hours of play a month at 20×, a
trawler player with about 15 minutes.

---

## 4. Server model

### 4.1 Records (all JSON)

```js
Company = {
  id: 'co' + 8 hex | 'co' + playerId (migrated), ownerId, name, short, colors: { hull, funnel, band },
  home: harborId, founded: unixS, founding: true | 'migrated' | false, homeMovedAt: 0,
  cash: 0,                              // integer credits; < 0 = overdraft or arrears
  rating: 'A'|'B'|'C'|'D', ratingStreak: 0, noCreditUntil: 0,
  od: { limit: 25000, num: 0, owed: 0, lastAt: unixMs, overSince: 0 },   // overdraft accrual (§4.3)
  loans: [Loan], fleet: [Vessel], lost: [VesselSummary × ≤ 20],
  office: { slots: 3 },
  claims: [unixS],                      // insurance claims, last 365 d
  alerts: [Alert × ≤ 50], checklist: { crew, delivery, spare, bank },
  ledger: { seq: 0, tail: [LedgerLine × ≤ 100], days: { 'YYYY-MM-DD': { [cat]: int } } /* 35 d */,
            months: { 'YYYY-MM': { [cat]: int } }, files: { 'YYYY-MM': bytes } /* committed offsets */ },
  lastSlowAt: unixMs, lastSeenOwner: unixMs, schema: 2,
}
Vessel = {
  id: 'v' + 8 hex | 'v' + playerId, companyId, name, cls, builtAt, acquiredAt, acquiredPrice,
  status: 'active'|'laidup'|'sunk'|'sold'|'seized'|'repossessed', loaner: false, rng: uint32,
  // — the per-ship fields of today's player record, same names (VESSEL_KEYS) —
  ship, cond, flooding, fuel, cargo, jobs, kits, docked, dockedAt, berth, assist, serviceDue, voyage, towing, fishing,
  fishInfo, sailsUp, lastValid, guideBerth, lowFuelWarned, condWarned, floodWarned, serviceWarned, fullWarned, shipTime,
  // — new —
  crew: [Crew], fatigue: 0, pay: { rate: 0 /* mcr/h */, ms: 0, rem: 0 },
  parts: { [key]: { c: 100, z: 0, zl: 1.37, q: 'oem'|'aft', h: 0, failed: null | { at: shipTime, jury: false }, hiThrMin: 0 } },
  spares: { [key]: { oem: 0, aft: 0 } },
  fitting: null | { key, mode: 'oem'|'aft'|'jury', leftH, needH },
  damage: [{ t: unixS, pts }],          // last 30 days, for major-damage claims
  claimNote: null | { pts, until },
  survey: { due: unixS, detained: null | { since, fixes: [...] } },
  insured: true, policy: { since: unixS, nextBill: unixS, suspended: false },
  mortgage: loanId | null, berthPaidDays: 0, clockAt: unixMs, storagePaidTo: unixS, laidUpAt: 0, repo: null | { since },
  orders: null,                         // v6 (§8); always null in wave 2
  stats: { delivered: 0, earned: 0, distanceKm: 0 },
}
Crew = { id: 'k' + 8 hex, name, nat, role: 'captain'|'mate'|'engineer'|'cook'|'deck', skill: 1..5, wage /* cr/day */,
         trait: null | 'steady'|'frugal'|'tinkerer'|'cheerful'|'grumbler'|'stormproof', morale: 70, hiredAt, quitWarned: false }
Loan = { id: 'L' + 8 hex, kind: 'starter'|'mortgage', vesselId, principal, balance, aprBps, months, instalment,
         startedAt /* ms */, nextDue /* ms */, paid: 0, lateSince: 0, lateFeeFor: 0, status: 'active'|'repaid'|'default' }
LedgerLine = { s /* seq */, t /* unixS */, cat, sub?, amt /* signed int */, v? /* vesselId */, ref?, memo, by /* 'sys'|playerId */ }
Alert = { id, t, level: 'info'|'warn'|'bad', kind, text, vesselId?, act?: { label, action, args }, ack: false }
PlayerRecord = { id, token, name, createdAt, lastSeen, companyId, aboard /* vesselId */, wanted, wantedAt, lastInspected,
                 stats, log, contactSeen, rescue, convoyId, warpRun, schema: 2 }
```

Fields that stay on the player (person or connection): `id, token, name, createdAt, lastSeen, online, lastTick, wanted,
wantedAt, convoyId, lastInspected, stats, log, contactSeen, hail, inRange, lastHailAt, rescue, lastBoard, warp,
warpRouted, warpGraceUntil, warpGraceFactor, warpRun, moveBudget, lastState, rejects, lastLandWarn, lastCollision,
lastGrounding, shallowSince, fishSentAt`. Transient ones are reset on load and on switching, as today.

`game.companies: Map<id, Company>`, `game.vessels: Map<id, Vessel>` (active and laid-up), both rebuilt on load.

### 4.2 The vessel view (graft from A) — `server/company.js`

```js
export const VESSEL_KEYS = ['ship','cond','flooding','fuel','cargo','jobs','kits','docked','dockedAt','berth','assist',
  'serviceDue','voyage','towing','fishing','fishInfo','sailsUp','lastValid','guideBerth','lowFuelWarned','condWarned',
  'floodWarned','serviceWarned','fullWarned','shipTime'];
export function bindVesselView(obj) {          // obj.vessel = the aboard Vessel
  for (const k of VESSEL_KEYS) Object.defineProperty(obj, k, { configurable: true, enumerable: false,
    get() { return this.vessel[k]; }, set(x) { this.vessel[k] = x; } });
}
export function bindCompany(obj, game) {        // p.company, p.vessel are non-enumerable getters; p.money is the facade
  Object.defineProperty(obj, 'company', { configurable: true, enumerable: false, get() { return game.companies.get(this.companyId); } });
  Object.defineProperty(obj, 'vessel',  { configurable: true, enumerable: false, get() { return game.vessels.get(this.aboard) || this._sunk; } });
  Object.defineProperty(obj, 'money', { configurable: true, enumerable: false,
    get() { return this.company.cash; },
    set(x) { const d = Math.round(x) - this.company.cash; if (d) book(this.company, d, 'adjust', { memo: 'direct set' }); } });
}
```

- `game.js` method bodies keep reading and writing `p.ship`, `p.cargo`, `p.docked`, …; they now reach the vessel.
  `saveState`'s `{...p}` and `JSON.stringify(p)` never serialise the accessors (non-enumerable).
- `shipTime` is in the list so TIME-MODEL's `p.shipTime` (V6-QUICK §5.2) lives on the vessel whether TIME merges before
  or after this wave; `warpRun` stays on the player (it is the helm session).
- `p._sunk` (non-enumerable) holds a sunk vessel while the person is in the raft, so the rescue code can still read
  `p.ship`.
- Switching = settle wages on both ships, `p.aboard = target.id`, reset `moveBudget, lastState, rejects, shallowSince`,
  `resetWarp(p)`, `convoyLeave(p, true)`, send `you` with `correction: true`, `harbor`, `company`.
- **Production code must not write `.money`.** Source-grep test: no `\.money\s*([-+*/]?=)` in `server/*.js` outside
  `company.js`. Tests may keep setting `p.money` (it books `adjust`).
- **Actors (v6, not built now):** `makeActor(game, company, vessel)` returns `{ id: vessel.id, name: vessel.name,
  isActor: true, online: false, hail: null, convoyId: null, wanted: 0, warp: 1, stats: vessel.stats, log: [] }` with
  `bindVesselView` and a fixed `vessel`/`company`. The existing `undock`, `acceptJob`, `deliverJobs`, `payJob`, `moorAt`,
  `finishDock`, `buyFuel` then run captained ships unchanged; `send`/`sendYou`/`sendHarbor` return early for actors and
  `event` routes to the company log (§8).

### 4.3 Money — `server/ledger.js`

```js
export function book(co, amt, cat, { sub, v, ref, memo = '', by = 'sys', t = nowS() } = {}) // → LedgerLine
  // throws unless Number.isSafeInteger(amt) && amt !== 0 && CATS[cat]; co.cash += amt; ledger seq/tail/days/months;
  // pushes to co.ledgerPending (non-enumerable, flushed by the store); marks the company dirty for a `company` message
export function headroom(co)            // co.cash + odLimit(co)   (odLimit 0 at rating D)
export function charge(co, amt, cat, o)        // voluntary: posts −amt if co.cash − amt ≥ −odLimit(co), else null
export function chargeDue(co, amt, cat, o)     // scheduled: same rule, else null (caller records a miss)
export function chargeForced(co, amt, cat, o)  // always posts −amt
export function credit(co, amt, cat, o)        // posts +amt
export function transfer(from, to, amt, catFrom, catTo, o) // voluntary for `from`; two lines with one ref
// wages: integer accrual, remainder carried (B)
export const DEN_WAGE = 3_600_000_000;          // (mcr/h) × ms → cr
export function addWageTime(pay, ms)            // pay.ms += ms (ms integer)
export function settleWages(pay)                // → whole credits; pay.rem keeps the remainder; pay.ms = 0
// overdraft: integer accrual in ≤ 60 s chunks, no BigInt needed (2e6 cr × 1800 bps × 60,000 ms = 2.2e14 < 2^53)
export const DEN_INT = 10_000 * 365 * 86_400_000; // bps × ms → one year = 3.1536e14
export function accrueOverdraft(od, cash, aprBps, nowMs)   // adds to od.num, moves whole credits to od.owed
```

- **Wage accrual.** At sea (the aboard ship, in `tick`): `addWageTime(v.pay, Math.round(dt × 1000) × shipRate)` where
  `shipRate` is the warp factor (TIME-MODEL's `shipRate(p)` once merged). Under tug assist the tick `continue`s after
  `stepAssist`, before the at-sea code, so the same one line also goes into that branch (with TIME-MODEL `shipRate`
  includes the tug op's clock rate: the crew works the whole compressed assist). Moored ships (any ship, in `companyTick`):
  world ms since the last pass. `v.pay.rate` (mcr/h) = Σ crew `round(wage × 1000 / 24)` × state factor (1, 0.3, 0; × 1.2
  while towing). Settle when `pay.ms ≥ 3,600,000` and before any rate change (dock, undock, hire, fire, move, switch,
  lay-up, recommission, sale, the 24-hour standby step, owner presence change); post with `chargeForced(…, 'wages',
  { v })`. 36,000 ticks of 100 ms and 3,600 ticks of 1 s post the same credits and carry the same remainder.
- **Ledger tail and archive.** `tail` keeps the last 100 lines for the HQ; every line also goes to the per-company
  monthly JSONL archive at the next save (§6); the `ledger` action reads the archive for older months. The HQ groups
  consecutive lines of the same category, ship and day ("Wages · Sea Bee · today −312 cr · 14 entries").

### 4.4 Settlement — `server/bank.js` (pure functions over company, vessels, `nowMs`, rng; return lines and alerts)

`game.companyTick(nowMs)` runs `ceil(N / 100)` companies per server tick, so each company is settled every ~10 s;
it also runs on every bank action and on load. Each pass, in order (idempotent: every counter moves in the same
synchronous step as its line; a second pass at the same `now` posts nothing; at most 400 due dates per pass):

1. **Overdraft:** `accrueOverdraft` from `od.lastAt` to now; at each UTC midnight crossed post `od.owed` as
   `interest/overdraft` (forced). Track `overSince` while `cash < −od.limit`.
2. **Loans:** for each active loan, while `nextDue ≤ now`: instalment `k` (interest + principal, last clears) via
   `chargeDue`; paid → `paid++`, `nextDue += 30 d`, streak +1, `lateSince = 0`; refused → if not late yet:
   `lateSince = nextDue`, late fee (forced, once per instalment), rating −1, alert; stop (retried next pass).
3. **Premiums:** each insured vessel, while `policy.nextBill ≤ now`: `chargeDue` the premium (re-valued), else
   `suspended = true` and alert; `nextBill += 30 d`.
4. **Storage and berth:** laid-up: whole days since `storagePaidTo` × fee (`chargeDue`; refused → forced at the next
   pass, alert). Moored away from home: `vessel.berthPaidDays` counts the days already billed for this stay (reset to 0
   whenever `dockedAt` is set); each pass bills `floor((now − dockedAt) / 1 d) − berthPaidDays` days × `berthFeePerDay`
   (forced) and adds them; `undock` bills `max(1, ceil((now − dockedAt) / 1 d)) − berthPaidDays` (never negative). So a
   stay still costs exactly today's `max(1, ceil(…))` days in total, and a test that sets `p.dockedAt` back two days still
   sees 3 days billed. (An earlier draft had a separate `berthFrom`; it is not needed.)
5. **Moored crew:** wage accrual (§4.3), fatigue −10/h, 24-hour standby step.
   **Ships nobody is aboard keep their clock:** for every active vessel without a player aboard (moored fleet ships, an
   offline owner's ship), `v.shipTime += (now − v.clockAt) / 1000` and `v.clockAt = now` (rate 1, world time; the
   downtime shift moves `clockAt` like the other timers). Contracts stay with their ship (§2.4.7), so without this a
   contract parked on a second ship would never run late. TIME-MODEL's "2 h of ship time left" and "Deadline passed"
   events for such a vessel become company alerts (`kind: 'deadline'`, act "Show"). Laid-up ships hold no contracts (I10)
   and are skipped. The aboard ship's clock stays with TIME-MODEL's `advanceShipClock`.
6. **Daily (UTC midnight crossed):** morale drift and quit draws, rating streak check, overdraft limit, survey window
   alerts, `damage` pruning, owner-away check (`lastSeenOwner` > 7 d → shore leave).
7. **State machine:** default triggers (§3.3) → repossession → empty-fleet loaner → bankruptcy write-off.

### 4.5 Limits pipeline — `shared/limits.js` (no change to `shared/physics.js`)

```js
export const NO_LIMITS = { maxThrottle: 1, minThrottle: THROTTLE_MIN, rudderMul: 1, rudderStuck: null, fuelMul: 1,
  leakPerH: 0, pumps: true, radar: true, autopilot: true, lights: true, vhf: true, moorNeedsTugs: false, crane: true,
  ramp: true, fishMul: 1, nets: true, tow: true, sails: true, wetCargo: false, dpKn: 3, why: [] };
export function limitsOf(vessel, crewFx, { lengthM }) // folds failures, jury flags, coating, short-handed throttle → limits
export function applyLimits(input, env, L) {          // mutates; called right before stepShip on server AND client
  if (!L) return;
  input.throttleCmd = Math.max(L.minThrottle, Math.min(L.maxThrottle, input.throttleCmd));
  if (L.rudderStuck != null) input.rudderCmd = L.rudderStuck; else input.rudderCmd *= L.rudderMul;
  if (!L.sails) env.sailsUp = false;
}
```

"No propulsion" is `maxThrottle = minThrottle = 0` — the rudder still works with way on, and sails still drive a
sailing yacht. Blackout = radar, autopilot, lights and pumps off, `rudderMul 0.3`, `maxThrottle 0.6`. Where applied:
server `onState` clamps `s.throttle` to `[minThrottle, maxThrottle]` and the movement budget uses
`maxKn × min(1, maxThrottle + 0.1)`; server `simulateOffline` calls `applyLimits` before `stepShip`; the server tick
applies `fuelMul × crew fuel` to the burn, `leakPerH × hrs` to flooding, skips the pump-out when `!pumps`, applies
`fishMul`/`nets` to the catch and `wetCargo`; the client `simulate()` calls `applyLimits(cmd, env, you.limits)` before
each `stepShip` and switches the autopilot off (with an event) when `autopilot` is false; actions check `vhf`
(tug_assist), `moorNeedsTugs` (dock), `crane` and `dpKn` (deliver_offshore), `ramp` (accept_job), `nets` (fish), `tow`
(tow_pickup).

### 4.6 Ticks and cost

| Work | Where | Rate | Cost |
|---|---|---|---|
| Aboard ship at sea: fuel, hull wear (existing), components, fatigue, wage time, limits | `game.tick` player loop | 10 Hz | ~4 µs per ship more than today |
| Companies: settlement, moored ships, daily | `game.companyTick` | each company every ~10 s | < 0.1 ms per company |
| `berthed` per socket | `broadcastSnapshot` | every 2 s | one scan of `game.vessels` per socket (fine below ~5,000 ships; grid index in v6) |
| Save | `saveState` | every 30 s | stringify ~40 ms at 1,000 companies (~12 MB) |

### 4.7 Invariants (each has a test)

| # | Invariant |
|---|---|
| I1 | Every vessel has exactly one company; active and laid-up vessels are in `game.vessels` |
| I2 | A player is aboard exactly one vessel of their own company; a vessel has at most one player aboard |
| I3 | Only the aboard vessel of a connected player accepts `state` positions |
| I4 | `company.cash` = Σ of the company's ledger lines (tail + archive), exactly |
| I5 | Cash changes only through `book()` (source grep: no `.money =` writes, no `Math.max(0, p.money` in `server/`) |
| I6 | Every booked amount is a safe integer ≠ 0 |
| I7 | `shipTime` and `pay.ms` never decrease; `pay.rem < DEN_WAGE` |
| I8 | A crew member is on exactly one vessel of the company |
| I9 | A mortgaged vessel is sold or traded in only when the proceeds clear the loan first |
| I10 | `laidup` ⇒ docked at home, no cargo, no jobs, not aboard, not ticked |
| I11 | `months` and `days` totals equal the sums of the lines they cover (rebuildable from the archive) |
| I12 | Each committed snapshot's `ledger.files` offsets equal the archive file lengths after load |

### 4.8 Changes to `game.js` behaviour (by function)

Money sites (B's verified table; every one goes through §4.3):

| Function (lines) | Today | New |
|---|---|---|
| `finishDock` (583, 584) | dues, pilotage clamped at 0 | `chargeForced` `port/dues` (home −50 %, eco modifier), `port/pilotage` |
| `undock` (593) | berth fee clamped | `chargeForced` `port/berth` for the unbilled days (home 0) |
| `tugAssist` (623, 639) | refuse if unaffordable, then `-=` | `charge` `tugs/assist`; refused → the same message with the headroom |
| `sellShip` (704) | `+= value` | `credit` `ship_sale`; vessel becomes the yard's pilot boat as today |
| `service` (714–716) | | `charge` `repair/service` + components +30 |
| `buyFuel` (734–736) | partial fill from money | `charge` `fuel`; partial fill from `headroom`; home −5 % |
| `repair` (746–751) | partial when short | `charge` `repair/hull`; partial from `headroom`; claim credit (§3.4) |
| `buyKit` (756–757) | | `charge` `parts` |
| `abandonJob` (798–799) | `min(money, 10 %)` | `chargeForced` `fines/cancel` (full 10 %) |
| `payJob` (862), `deliverOffshore` (1515) | `+= pay` | `credit` `contract` |
| `tradeGoods` (879–881, 896) | qty from money, whole action at the pre-trade price | price from `tradeQuote` (V6-QUICK §3.3, impact + 1 % spread from §3.10): buying takes the largest integer qty ≤ min(asked, free hold, stock) whose `tradeQuote(…, 'buy').total` fits `headroom` (binary search, ≤ 14 steps); `charge` `trade_buy` of that integer total; selling `credit`s `trade_sale` of `tradeQuote(…, 'sell').total` (an integer also for fractional caught fish) |
| `buyShip` (921–923), `buyUsedShip` (1581–1585) | trade-in replace | `mode: 'tradein'` (default, today's behaviour, `charge` `ship_buy` + `credit` `ship_sale`) or `'fleet'` (new vessel moored here); optional mortgage |
| `tow` (953–954) | `min(money, …)` | `chargeForced` `tugs/tow` with `towFee` |
| `inspect` (983–984) | fine if affordable | `chargeForced` `fines/fine` |
| `impound` (993) | all credits seized | `chargeForced` fine in full; the vessel is detained until `cash ≥ −odLimit` |
| `forcedReset` (1001) | money = 500, rust-bucket coaster | the vessel is **seized** (status `seized`, jobs and cargo gone, crew discharged with severance); cash untouched; wanted 0. The person lands like `finishRescue`: aboard a company ship moored at that harbour, else moved free to the nearest moored company ship, else the loaner coaster (empty fleet). `dropWarp` (WARP-HARBOUR's line) stays the first statement. |
| `tick` (1114) | float wages per tick | wage accrual (§4.3) |
| `tradeAccept` (1294, 1304) | | `transfer` `p2p_buy`/`p2p_sale`; young-company cap |
| `expressPassage` (1528, 1536) | | `charge` `express` |
| `finishRescue` (1727–1728) | 2,000 excess for a coaster | insurance claim on sinking; landing: aboard a company ship moored at the rescue harbour, else moved to the nearest moored company ship (free transfer), else the loaner coaster |
| `privateState` (306) | `money: p.money` | unchanged key, now the company's cash |

**Trade-ins stay in place.** The legacy `sell_ship` and `buy_ship`/`buy_used` with `mode: 'tradein'` change the class
of the *same* vessel record, exactly as today's code mutates `p.ship.cls`: id, name, crew, ship's clock and berth stay;
components are reconciled to the new class (new hull at 100, used hull at its listing condition); spares for parts the
new class lacks are kept and shown as "not fitted to this ship". A mortgage on the old hull is paid off from the sale
proceeds first, and the trade is refused if they do not cover it (I9).

Other behaviour: `undock` refuses when laid up, detained or below minimum crew, and ends `founding`; `dock` refuses
own-power berthing when `moorNeedsTugs`; `collision`/`grounding` multiply damage by the hull factor, record `damage`,
and grounding costs the propeller 15 points; `sink` sets the vessel `sunk`, files the claim, discharges the crew with
severance, keeps it in `p._sunk` until landing; `acceptJob` applies the comfort pay factor and the ramp check;
`startBerth`, `nearBerthFor` and the `taken` set in `tugAssist` count occupancy over all moored vessels
(`game.berthOccupancy(harborId, exceptVessel)`; `tugAssist` also keeps today's rule that a berth another ship is being
brought into is taken), so the tugs never put a ship on top of a moored fleet ship; `acceptJob` lets a pilot boat take
charters as a water taxi (§3.10); `simulateOffline` stops engines with a log line ("The crew stopped: no GPS — the
autopilot cannot hold the course.") when `limits.autopilot` is false.

---

## 5. Protocol (existing WebSocket; `net.action(name, fields)` sends fields at the top level of the message)

### 5.1 `you` additions (`privateState`)

```js
vesselId, vesselName, companyId,
company: { id, name, short, colors, home, cash, odLimit, rating, unread, founding },
limits: { …§4.5… },                                     // NO_LIMITS when nothing applies
systems: { worst: { key, system, name, c }, failed: [{ key, name, text, at, jury }],
           fitting: null | { key, name, mode, leftH, pct }, spares: { used, slots }, coating },
crew: { have, min, opt, missing: ['engineer'], morale, fatigue, wagesPerDay, canSail, why },
crewList: [{ id, name, role, skill }],                  // the aboard vessel's crew, for the figures below decks (crewnpc.js)
survey: { due, overdue, detained: null | { fixes: [...] } },
```

`money` stays (= company cash) for old clients and tests.

### 5.2 Public views

- `publicState(p)` gains `vid, vname, co: { id, short, hull, funnel }`; others label the ship "Sea Bee · Kraan".
- **`{ t: 'berthed', ships }`** every 2 s per socket: moored vessels within 12 km that are not under an online helm
  (fleet ships, laid-up ships, offline players' ships): `{ id: 'v…', name, cls, lat, lon, hdg, laidUp, co: { short,
  hull, funnel } }`, at most 60, nearest first. The client draws them as moored ships and adds them to its collision
  set. Player ids are 8 hex characters and vessel ids start with `v`, so they never collide.

### 5.3 `company` message (owner only)

`{ t: 'company', company: CompanyView }` on connect, at most every 2 s while dirty, and every 2 s while the client has
sent `hq_watch {on: true}`.

```js
CompanyView = { id, name, short, colors, home, founded, founding, cash, rating, ratingStreak, noCreditUntil,
  od: { limit, used, apr }, netWorth, fleetValue, week: { profit, days: [7 ints] },
  loans: [{ id, kind, vesselId, balance, aprBps, months, instalment, paid, nextDue, status, late }],
  fleet: [VesselView], office: { slots, used, slotPrice }, alerts: [Alert], checklist,
  pnl: { month: { [cat]: int }, last: { [cat]: int } }, balance: { assets, liabilities, equity, lines },
  days: [{ day, net }] /* 35 */, ledgerRecent: [LedgerLine × 30] }
VesselView = { id, name, cls, status, aboard, loaner, lat, lon, hdg, spd, docked, harborName, berthName, laidUp,
  statusLine, posLine, fuel, fuelCap, cond, ci, systemsWorst, failed, crew: { have, min, opt, morale, fatigue },
  cargoT, capacity, jobs: [{ id, title, pay, to }], value, yardValue, insured, premium, mortgage, profit7d, profit30d,
  survey, canSwitch: true | 'reason' }
```

`docs/fixtures/company.sample.json` (written by W2-COMPANY on day 1, regenerated by its tests) is the contract the
client package builds against; the client loads it with `?fixture=company` in development.

`{ t: 'ledger', month, lines, totals, page, pages }` answers the `ledger` action (50 lines a page).
`{ t: 'alert', alert }` pushes a new alert (the HQ bell); events about the aboard ship stay `event`.

### 5.4 `harbor` payload additions (`sendHarbor`)

```js
crew: [{ id, name, nat, role, skill, wage, fee, trait }], crewNext /* unixS */,
chandler: [{ key, name, system, oem: { price, stock }, aft: { price, stock } }], lockerFree,
yard: [{ key, name, c, failed, cost }], coatingCost,
office: null | { home: true, slots, used, storage: [VesselView] },
fleetHere: [VesselView], perks: null | { fuelMul, duesMul, yardMul, freeBerth }, survey: { due, fee },
starters: null | [{ cls, cond, price }]   // only while founding
```

### 5.5 Actions

Every payload is validated (strings, owned ids, finite in-range numbers); every refusal sends a `warn` event naming the
fix. The new actions share a per-player token bucket (10/s, burst 20).

| Action | Fields | Where | Notes |
|---|---|---|---|
| `found_company` | `name, colors, home, starter, shipName, starterLoan` | docked, while founding | §3.1 |
| `rename_company`, `set_colors`, `rename_ship` | `name` / `colors` / `vesselId, name` | anywhere | unique names |
| `move_home` | `harbor` | docked | 50,000, 7-day cooldown, no laid-up ships |
| `buy_slot` | — | docked at home | 40,000 |
| `lay_up`, `recommission` | `vesselId` | vessel moored at home | §3.1 |
| `buy_ship` | `cls, mode: 'tradein'\|'fleet', name?, finance?: { months }` | docked | default `tradein` |
| `buy_used` | `listingId, mode, name?, finance?` | docked | |
| `sell_vessel` | `vesselId` | vessel moored, no jobs or cargo, not the only active ship | mortgage paid from proceeds, else refused; crew severance |
| `switch_ship` | `vesselId` | §2.4.7 | |
| `loan_take` | `vesselId, amount, months` | anywhere | server re-quotes; refused with the rule that failed |
| `loan_repay` | `loanId, amount: number\|'all'` | anywhere | |
| `insure` | `vesselId, on` | anywhere | not off while mortgaged |
| `crew_hire` | `candidateId, vesselId` | vessel moored in this harbour | fee 3 d |
| `crew_hire_min` | `vesselId` | same | agency fallback |
| `crew_fire`, `crew_move` | `crewId` / `crewId, vesselId` | same harbour | severance 7 d / free |
| `parts_buy` | `key, q: 'oem'\|'aft', n` | docked | locker and stock limits |
| `part_fit` | `key, mode: 'oem'\|'aft'\|'jury'` | aboard | §3.7 |
| `yard_overhaul`, `coating_renew` | `key` / — | docked | |
| `ledger` | `month, vesselId?, cat?, page` | anywhere | reply `ledger` |
| `hq_watch`, `alert_ack` | `on` / `ids` | anywhere | |
| `debug_fail` | `key` | only with `SALTLINE_DEBUG=1` | for browser checks |

v6 adds `fleet_order {vesselId, order}` and `switch_ship` to ships at sea (§8).

---

## 6. Persistence on Node 20 (no dependencies) — `server/store.js`

### 6.1 Layout (the directory of `stateFile`, so tests keep passing their own path)

```
data/
  state.json                     schema 2: { schema, savedAt, simTime, wind, storms, wrecks, harbors, players, companies }
  state.json.bak                 the previous committed snapshot
  ledger/<companyId>/<YYYY-MM>.jsonl   append-only ledger lines (one JSON object per line)
  backups/hourly/state-<YYYY-MM-DDTHH>.json.gz    24 kept
  backups/daily/state-<YYYY-MM-DD>.json.gz        14 kept
  backups/pre-v2-<iso>.json      the v1 file before migration (kept forever)
```

Today's `.gitignore` covers `data/state.json` and `data/state.json.tmp` only. W2-STORE adds `data/state.json.bak`,
`data/state.json.tmp-*`, `data/ledger/` and `data/backups/` in the same commit as `store.js`: they hold every player's
books and must never be committed by an `add -A`.

### 6.2 Save cycle (`game.saveState({ sync })`, every 30 s and on shutdown)

1. **Ledger first:** for each company with pending lines, `appendFileSync` them to the month file of each line's
   timestamp, `fsyncSync`, and set `company.ledger.files[month] = new size`.
2. **Snapshot:** `JSON.stringify` the whole state synchronously (a consistent cut), then write `state.json.tmp-<pid>`,
   `fsync`, `rename(state.json → state.json.bak)`, `rename(tmp → state.json)`, `fsync` the directory (wrapped in try).
   Periodic saves write asynchronously (`fs.promises`, one save in flight); `SIGINT`/`SIGTERM`/`uncaughtException` save
   synchronously.
3. If step 2 fails, the appended lines stay; the next successful snapshot's offsets include them.

### 6.3 Load

1. Read `state.json`; on a parse error or missing file, `state.json.bak`; then the newest hourly backup. Log the source.
   Delete stray `*.tmp-*`.
2. Run migrations in order (`MIGRATIONS = [{ from: 1, to: 2, run: migrateV1toV2 }]`); refuse to start (without
   writing) on a schema newer than the code knows.
3. **Truncate the ledger to the committed offsets:** for each company, truncate each month file in `ledger.files` to
   its recorded length and delete month files newer than the newest recorded month. Lines written for a snapshot that
   never committed disappear, so I4 holds after a crash.
4. Build `companies`, `vessels`, bind players (§4.2), then the existing `migratePlayer` per player, then the downtime
   shift (§3.9).

### 6.4 Migration v1 → v2 (`migrateV1toV2` in `server/company.js`, run by the store)

For each v1 player: company `'co' + p.id` named "`<player>` Shipping" (dedupe), home = `p.docked` if it is a founding
home else Rotterdam, `founding: 'migrated'`, rating B, colours from the id hash; ledger `capital` "Opening balance"
`round(p.money)` and `capital` "Founder's grant" `max(25,000, 160,000 − round(p.money))` (tops every migrated player
up to a new company's cash after its starter). Vessel `'v' + p.id` with every `VESSEL_KEYS` field copied, a default
name, components at `c = 70 + 0.25 × cond`, minimum crew hired free at 3★, insured, survey due in 90 days,
`shipTime = p.shipTime ?? simTime`. The player record keeps the person fields plus `companyId`, `aboard`. Deterministic
ids make the step idempotent. The v1 file is copied to `backups/pre-v2-<iso>.json` before anything is written.

**Rollback:** v1 code cannot read schema 2. To roll back, stop the server and restore `backups/pre-v2-<iso>.json` as
`state.json` (progress since the upgrade is lost). Say so in the release note.

### 6.5 Size and health

~3–5 KB per vessel, ~10 KB per company with its 100-line tail: 1,000 companies ≈ 12 MB, stringify ≈ 40 ms every 30 s.
Above ~25 MB, split companies into per-company files committed through a manifest (not built now). Backups use async
`zlib.gzip`. `/api/health` gains `companies`, `vessels: { active, laidup }`, `save: { lastOkAt, lastMs, bytes, failures }`,
`adjustLines` (must stay 0 in production).

---

## 7. Compatibility

### 7.1 Wave 1 (being finished in this tree)

Read-only for this wave until wave 1 is merged and `npm test` is green: `shared/physics.js`, `shared/telegraph.js`,
`public/js/telegraph.js`, `public/css/telegraph.css`, `public/js/berthguide.js`, `public/js/berthplan.js`,
`public/css/berthguide.css`, `server/berthguide.js`, `server/tugpath.js`, `server/tugassist.js`, `public/js/tugs.js`,
`public/js/interior.js`, `public/js/walker.js`, `public/js/shipplan.js` and their tests. This wave needs no change in any
of them: tug ops stay keyed by the player id (only aboard ships are assisted in wave 2), `pickGuideBerth` already takes
an `occupied` set, limits are applied by callers. v6 needs one line in `tickTugs` (look up `game.shipById(pid)` so
captained ships keep their tugs) — §8.

**Where wave 1 stands (12:06 UTC, 8 Oct):** all four parts are in the tree and wired — the telegraph (keys, touch lever,
bridge dial), berth guidance (`main.js` loads `berthguide.js`), the tug paths and visible tugs (`tugassist.js`, `tugs.js`),
and the interior stairs — and the full suite passes (220 of 220, none skipped). It is in its review-and-fix pass: its
agents changed `server/game.js` at 12:02, `server/tugassist.js` at 11:57, `public/js/interior.js` and the tug review tests
at 12:03, and during this review (12:10–12:35) `public/js/walker.js`, `public/js/interior.js` and a new
`test/interior-review.test.mjs` (read-only for this wave too). `docs/STATUS.md` (07:15) does not list wave 1 yet. Phase B therefore still waits for the merge; phase A (new files
only) is unaffected.

### 7.2 Quick v6 packages (`docs/V6-QUICK-CONTRACTS.md`)

| Package | Interaction | Rule |
|---|---|---|
| TIME-MODEL | `p.shipTime`, `shipRate(p)`, `advanceShipClock`, `shared/rates.js`, `shared/jobtime.js` | `shipTime` is in `VESSEL_KEYS`; wages at sea use `shipRate(p)` when it exists, else `warpOf(p)`. Its test 5 asserts "wages = `crewCost` per ship hour": W2-SERVER replaces that line with "wages posted per ship hour = `pay.rate` / 1000 credits, identical at every level (exact integers)". If `shared/rates.js` does not exist yet, W2-SHIPS creates it verbatim from V6-QUICK §1.5. The clock of ships nobody is aboard advances in `companyTick` (§4.4 step 5). The fishing statement in `tick` is edited by both; the merged form is `const rate = catchRate(s.cls, g.richness) * (wx.storm > 0.5 ? 0.4 : 1) * (L.nets ? L.fishMul : 0);` with `L = this.limitsFor(p)`. W2-SERVER changes `RATES.FISH_T_PER_H` to 2 (§3.10) and adds the pilot-boat charter exception to `hardReason` (one condition). |
| WARP-HARBOUR | moored warp ≤ 5×; explicit `dropWarp` in `tow`, `impound`, `forcedReset`, `finishRescue` | Moored wages run on the world clock (warping in port costs nothing extra); fitting in port runs on the ship's clock (5× faster). Its test 10 ("600 ticks moored: money unchanged") holds because settlement waits for a full accrued hour. Its `dropWarp` stays the first statement of `forcedReset` and `finishRescue`, before wave 2 moves the person to another vessel. |
| AUTOPILOT-CHARTS | owns `setVoyage`, `simulateOffline`, `app.pilot` | W2-SERVER adds one `applyLimits` line before its `stepShip` call and the "no GPS" stop (§4.8), whichever version is merged. On the client a failed GPS / blackout turns the autopilot off through `this.pilot?.engage(false)` when AUTOPILOT has merged (else `this.autopilot = false`), so the pilot's own state stays consistent. |
| WORLD-MARKET | trade finder costs; `tradeQuote` / `TRADE` in `server/economy.js` | After both merge, the MARKET owner swaps in `crewDayCost(cls, 'opt') / 24` from `shared/crew.js` for `C.crewCost` and multiplies dues by `ecoDuesMul(cls, harbor)` from `shared/shipstats.js` (the class-only part of §3.6; home perks depend on the company and are not in the anonymous finder) — two lines. The client's `findTrades` passes `cash = you.company.cash + you.company.odLimit` (the headroom a voluntary purchase may use). W2-SERVER flips `TRADE.SPREAD`/`TRADE.IMPACT` (§3.10); if MARKET has not merged, W2-SERVER appends `TRADE` and `tradeQuote` to `server/economy.js` verbatim from V6-QUICK §3.3. |
| server.js (all) | shutdown handlers | One `saveAll` block, verbatim from V6-QUICK §6.2, written by whichever of MARKET, AUTOPILOT and W2-SERVER merges last; `game.saveState({ sync: true })` is wave 2's synchronous save. |

In `game.js` functions both contracts touch (`tick`, `migratePlayer`, `findOrCreatePlayer`, `privateState`,
`acceptJob`, `payJob`, `deliverOffshore`, `expressPassage`, `tow`, `impound`, `forcedReset`, `finishRescue`,
`simulateOffline`), wave-2 edits are additive lines or the money lines of §4.8; whoever merges second keeps the other's
lines.

---

## 8. v6 extension points (no model change)

- **Who sails a ship:** `controllerOf(v)` = `'player'` (an online player aboard) | `'captain'` (no player, `orders` set,
  a captain in the crew, or a legacy `goto`) | `'none'` (frozen at sea, wages accrue). Derived, never stored.
- **Actors** (§4.2) run the existing docking, contract and bunkering methods for captained ships; `game.event` on an
  actor appends to the company log and sends `{ t: 'fleet_event', vesselId, vesselName, kind, text, time }` to an online
  owner.
- **Orders** (`vessel.orders`): `{ type: 'goto', lat, lon, thr }`, `{ type: 'sail_to', harbor, then: 'moor'|'lay_up'|
  'hold' }`, `{ type: 'hold' }`, `{ type: 'contract', jobId }`, `{ type: 'work', types, maxKm }`, `{ type: 'home', then }`.
  Routes from `planRoute` (or the AUTOPILOT worker), patch paths from `tugpath.route`, berthing through the existing
  tug assist (with the `tickTugs` lookup fix).
- **Fleet tick:** vessels not under an online helm step at 10 Hz within 40 km of an online player, 1 Hz otherwise,
  round-robin; `applyLimits`, `tickParts`, wage time per ship-ms; `snap.fleet` per socket (like `ai`) and
  `GET /api/ships` for the world map.
- **Switching anywhere:** leaving a ship at sea asks what she does next (continue route / return home / hold); a launch
  transfer fee `min(5,000, 250 + 2 × km)` outside the current harbour.
- **HQ map:** routes and ETAs from `orders`; office building ashore at home.

---

## 9. Build plan

### 9.1 Order

| Phase | When | Packages | Rule |
|---|---|---|---|
| A | now, in parallel with the end of wave 1 | W2-STORE, W2-BANK, W2-CREW, W2-SHIPS, W2-COMPANY, W2-UI | **new files only**; pure modules with their own tests; nothing imports them from existing code yet |
| B | after wave 1 is merged and `npm test` is green; rebase on any merged quick-v6 package | W2-SERVER, then W2-CLIENT (W2-CLIENT may start on the fixture while W2-SERVER runs) | the only packages that edit existing files, through the hook tables below |
| C | after B | integration checks (§9.6), docs update by the integrator (ARCHITECTURE v0.5 addendum, STATUS), one push, one deploy |

Dependencies inside phase A: W2-COMPANY imports the other three server modules; it starts against the signatures in this
document and runs its full tests once they land. W2-UI imports `shared/finance.js`, `shared/crew.js`,
`shared/shipstats.js`, `shared/parts.js` the same way.

General rules (as in V6-QUICK §1.1): `node:test` + `node:assert/strict` files in `test/`; Game tests use
`stateFile: '/nonexistent/…'`, stub `saveState`, set `g.rnd`, drive `g.tick(0.1)`; copy helpers, never import across
test files; client logic that tests must reach lives in `shared/` or in import-free client modules; new DOM is created
at runtime; each client package injects its own CSS file.

### 9.2 Packages

#### W2-STORE — persistence
- **Owns:** `server/store.js`, `test/store.test.mjs`, the four `.gitignore` lines of §6.1.
- **API:** `new Store({ stateFile, log, now })`; `readState() → { json, source }`; `writeState(obj, { sync }) →
  Promise|{ bytes, ms }`; `appendLedger(companyId, lines) → { [month]: bytes }`; `truncateLedger(companyId, files)`;
  `readLedger(companyId, month, { vesselId, cat, page, size }) → { lines, pages, totals }`; `runMigrations(json,
  MIGRATIONS) → json` (+ pre-migration backup once); `backupMaybe(now)` (async gzip, pruning); `stats()`.
- **Tests:** round trip; `.bak` holds the previous snapshot; a stray `*.tmp-*` is ignored and removed; corrupt
  `state.json` falls back to `.bak`, then to the newest backup; ledger appended beyond the committed offsets is
  truncated on load and a newer month file is deleted; `readLedger` paging and filters; migrations run in order, refuse a
  newer schema without writing, write the pre-v2 backup once; hourly/daily naming and pruning with a fake clock, gzip
  readable with `zlib.gunzipSync`; directory fsync errors are swallowed; a 12 MB synthetic state writes without
  throwing (log the time, no hard bound).

#### W2-BANK — money, bank, insurance
- **Owns:** `shared/finance.js` (APR, annuity, schedule, quote, premium, deductible, market value — browser-safe),
  `server/ledger.js` (§4.3), `server/bank.js` (§4.4: `settle(co, vessels, nowMs, rng) → { lines, alerts, events }`,
  `quoteMortgage`, `takeLoan`, `repayLoan`, `odLimit`, `insure`, `claimTotalLoss`, `claimDamage`, `repossess`),
  `scripts/ledger-report.mjs` (reads the archive, prints money in and out per category per day, checks I4),
  `test/ledger.test.mjs`, `test/bank.test.mjs`.
- **Tests:** `book` rejects non-integers, NaN, 0 and unknown categories; `charge` refuses beyond headroom without
  posting; `chargeForced` always posts; `transfer` makes two lines with one ref; a 10,000-step random scenario keeps
  I4 and I11; wages: 36,000 × 100 ms vs 3,600 × 1 s at warp 1/5/20/100/400 post identical credits and remainders;
  overdraft: 10 s vs 60 s settlement cadence gives identical daily interest; schedules: starter 12,904 (last 12,907,
  interest 4,851, rows of §3.3), coaster 63,000 → 5,434, trawler 96,600 → 4,310, feeder 665,000 → 20,504; due dates
  every 30 days; late fee 2 % once, alerts days 0/7/14/21/28, default at day 30 and at a second miss, repossession at
  60 % with surplus and write-off cases, rating D and 60-day credit stop; affordability rule; early repayment pro-rata
  and re-amortised; insurance premiums and deductibles of §3.4, 7-day waiting period, suspended cover pays nothing,
  mortgaged ships cannot opt out, major-damage claim summed within an hour; settle twice at the same `now` posts
  nothing; 3 overdue months processed in order; downtime shift moves every listed timer.

#### W2-CREW — crew
- **Owns:** `shared/crew.js` (roles, base wages, skill multipliers, `REQUIREMENTS`, `crewDayCost(cls, 'min'|'opt')`,
  `effects(vessel, { playerAboard })`, `maxThrottleFor`, traits), `server/crew.js` (`marketFor(harbor, now, taken)`,
  `hire`, `hireMinimum`, `fire`, `move`, `wageRate(vessel, state)`, `fatigueStep(vessel, hrs, wx)`, `dailyMorale(vessel,
  rng, now)`), `test/crew.test.mjs`.
- **Tests:** the §3.5 tables (coaster minimum engineer + 2 deckhands; optimal 1,180/day; skill multipliers); market
  size by harbour size, deterministic per 6-hour window, 5★ only at mega/major, a hire hides the candidate for everyone;
  fees 3 d and severance 7 d; minimum-crew check with the player as master; a captain aboard with the player fills a
  mate slot; short-handed throttle (coaster one deckhand short → 0.96, floor 0.85); fatigue per ship-hour and in port;
  morale drift, quit draws reproducible with a seeded RNG and the warning a day before; effect table values; wage state
  factors (sea 1, moored ≤ 24 h 1, after 0.3, laid up 0, owner away > 7 d 0, towing 1.2).

#### W2-SHIPS — stats, components, limits
- **Owns:** `shared/shipstats.js` (§3.6 table and derived functions, `marketValue`, `hullFactor`, bars,
  `ecoDuesMul(cls, harbor)` — the eco factor of §3.6 inside `LAYERS[1]` of `shared/constants.js`, the same box as
  `inDetailRegion` in `server/lanes.js`, which a browser-safe module cannot import),
  `shared/parts.js` (catalogue, `componentsFor`, prices, systems grouping), `shared/limits.js` (§4.5),
  `server/parts.js` (`ensureParts(v)`, `tickParts(v, s)`, `startFit`, `stepFit`, `overhaulCost`, `chandlerFor(harbor,
  now, taken)`, `surveyOnDock(v, harbor, now)`, `onCollision`, `onGrounding`), `shared/rates.js` only if absent (verbatim
  from V6-QUICK §1.5), `test/shipstats.test.mjs`, `test/parts.test.mjs`.
- **Tests:** coaster power 4,615 kW, range 1,775 nm, service 11.2 kn from `rates.js`; bars in [0, 1] per category;
  `marketValue` and `hullFactor`; `componentsFor` sets (coaster has crane, hatches, thruster; ferry ramp; tug tow winch;
  sloop rig, no gen2); wear at 10 Hz vs 1 Hz within 1e-9; the same failure ship-time at 10 Hz and 1 Hz from one seed (±1
  tick); coaster system MTBF at 100 % (the §3.7 reference conditions) in [340, 400] ship-h; condition multiplier 3.25 at 50 %; failure effects → limits
  (fuel pump → max = min = 0; steering → stuck, then × 0.3 after 0.5 h; one generator → nothing; both → blackout; seal →
  leak; coating → throttle and fuel); `applyLimits` never sets `env.fuelEmpty` and a ship with a failed fuel pump still
  turns with way on through the real `stepShip`; fitting counts down on ship-hours, success roll reproducible, spare
  consumed on failure; jury-rig `c = 15` and survey fail; overhaul cost formula; service +30; chandler deterministic,
  tiers by harbour size; survey pass, fail, detention and release.

#### W2-COMPANY — company core and actions
- **Owns:** `server/company.js` (records, `VESSEL_KEYS`, `bindVesselView`, `bindCompany`, `foundProvisional`,
  `foundCompany`, `makeVessel`, `migrateV1toV2`, `buyVessel`, `sellVessel`, `layUp`, `recommission`, `switchShip`,
  `loanerFor`, `companyTick(game, co, nowMs)` orchestrating bank/crew/parts, `companyView`, `vesselView`, `statusLine`,
  `alerts`, `fillMinimumCrew(vessel)` for tests), `server/companyactions.js` (`handleCompanyAction(game, p, m) → boolean`, validation, ownership, token
  bucket), `docs/fixtures/company.sample.json`, `test/company.test.mjs`.
- **Tests:** provisional company (cash 160,000; lines `capital` +250,000, `ship_buy` −90,000; minimum crew; founding);
  `found_company` (unique name, palette, home move, starter swap with refund, starter loan once, founding ends on
  undock); accessors (`p.ship === p.vessel.ship`; writes reach the vessel; `{...p}` and `JSON.stringify(p)` carry no
  vessel fields; switching swaps them all); `p.money =` books `adjust`; fleet purchase moored here with no crew, trade-in
  mode equals today's behaviour; finance at purchase (70 %, insurance forced on); switching rules and resets, 10 s
  cooldown; lay-up and recommission rules, storage per day, slots; sale with and without a mortgage, severance;
  migration of the v1 fixture used by `test/game.test.mjs` (ids, grant top-up, berth and stats preserved, idempotent);
  `companyView` keys equal the fixture's; status lines for at sea / moored / laid up; ownership refusals; rate limit.

#### W2-UI — client screens (new files only)
- **Owns:** `public/js/company/hq.js` (`export class CompanyUI { constructor(app); onCompany(view); onLedger(m);
  onAlert(a); onYou(you, prev); open(tab); close(); isOpen(); updateChip(you); updateStrip(you); tabCrew(h, you);
  servicesExtra(h, you); buyButtons(entry, h, you); syncBerthed(ships); sheetAction(act, el) → boolean }`),
  `public/js/company/founding.js`, `public/js/company/shipcard.js` (ship card, systems, compare rows),
  `public/js/company/failure.js` (failure card), `public/js/company/view.js` (import-free: money format, status line,
  alert order, CSV builder, quote text, `crewStations(rooms, crew)`), `public/css/company.css`,
  `public/js/company/crewnpc.js`, `test/companyui.test.mjs` (tests `view.js` and `shared/finance.js` quotes; Node cannot
  load the browser modules).
- **Crew aboard you can see** (V5-PLAN item 10, "visible crew members walking aboard"): `export class CrewNpcs {
  constructor(app); sync(crew, cls); dispose() }` puts one `makeAvatar()` figure (`public/js/avatar.js`) per crew member
  of the ship you are aboard into `app.interior.group`, at a station picked by the pure `crewStations(rooms, crew)` from
  wave 1's `app.interior.rooms` (`{ id, kind, x0, x1, z0, z1, y }`): engineer → a `kind: 'engine'` room, mate and captain
  → `'bridge'`, cook → `'mess'` (the galley), deckhands → `'deck'` rooms; each figure stands 0.8 m inside a room corner
  that is not within 1.2 m of a doorway or a stair band, faces the room centre, sways idly, and has a name label
  ("Ingrid · engineer ★★★★"). Rebuilt when `app.interior.builtCls` or the crew list changes; at most 12 figures. Read-only
  use of the interior (no edit to `interior.js`); the figures do not block the walker (they stand clear of the walk
  bands), and they are only drawn while the interior is (deck figures from the chase camera are a later polish).
- **Tests:** "−12,400 cr (overdraft)"; status line examples; quote text equals the bank's numbers; CSV escaping
  (commas, quotes, newlines); alert ordering (bad → warn → info, newest first); `crewStations` on a fake room list puts
  every role in its room kind, keeps 1.2 m from doorways and stair bands, never puts two figures closer than 0.6 m, and
  falls back to the nearest room of any kind when the class has no galley (yachts).
- **Browser checks (fixture mode, desktop 1440×900 and phone 390×844):** founding card in one step on desktop, three
  on the phone; HQ tabs render from the fixture with no horizontal scroll at 360 px; the chip collapses to swatch and
  cash; bank slider and term chips update the quote; failure card above the contract card, which collapses to a pill
  on the phone; ship card systems expand.

#### W2-SERVER — server integration (phase B)
- **Owns edits to:** `server/game.js` (hook table §9.3), `server.js` (`/api/health` fields, the shared `saveAll`
  shutdown block of V6-QUICK §6.2, unchanged otherwise), `shared/constants.js` (`SHIP_CLASSES.coaster.price = 120000`
  only), `server/economy.js` (the two `TRADE` values; the verbatim `tradeQuote` append if WORLD-MARKET has not merged),
  `shared/rates.js` (`FISH_T_PER_H` 10 → 2, through the integrator), `shared/jobtime.js` (the pilot-boat charter
  exception in `hardReason`, after TIME-MODEL merges), the existing test files listed in §9.5, new `test/wave2.test.mjs`
  and `test/balance.test.mjs` (§3.10).
- **Tests (`test/wave2.test.mjs`):** end to end — new player founds, accepts the planted freight job, casts off, docks
  at IJmuiden, is paid (`contract`), pays dues (`port/dues`), and `cash = Σ lines`; the old money-printing case (cash
  −5,000, dock at IJmuiden → dues 461 × 1.05 (eco class D) make it −5,484, not 0); at-sea `debug_fail engine.fuelpump` → `you.limits` max = min = 0, warp dropped,
  `onState` throttle clamped, fit with a spare clears it after the right ship-hours; sinking an insured mortgaged ship →
  mortgage cleared first, rest credited, landing aboard the other moored ship; switching in harbour → `you.vesselId`
  changes, the old ship counts as an occupied berth in `nearBerthFor`; save → simulated crash after ledger append →
  load truncates and I4 holds; schema-2 round trip; downtime shift on load; `berthed` contains moored fleet ships within
  12 km; exactness at 10 Hz for wages, fuel and wear at every warp level; a contract left on a moored second ship runs
  late on world time while you sail the first (its `shipTime` advanced by `companyTick`, a `deadline` alert raised once);
  away from home `dockedAt` set back 2 days → 2 days billed by settlement, 1 more on undock (3 in total), at home 0;
  a forced reset with a second ship moored elsewhere lands the person aboard her (no loaner); the tugs never pick the berth
  a moored fleet ship lies at while a free fitting berth exists; buying 1,200 t costs `tradeQuote(…).total` (an integer,
  above 1,200 × the posted price with impact on), selling 123.4 t of caught fish credits an integer; a pilot boat accepts
  a charter, a coaster does not; an offline voyage with a failed GPS stops with the log line; `test/balance.test.mjs`
  green; `npm test` fully green.

#### W2-CLIENT — client integration (phase B)
- **Owns edits to:** `public/js/main.js`, `public/js/hud.js`, `public/js/sound.js` (hook table §9.4); the
  `crewnpc.js` wiring is one constructor line and one `onYou` line.
- **Browser checks (live server, desktop and phone):** see §9.6.

### 9.3 `server/game.js` hook table (W2-SERVER)

| Function / place | Change |
|---|---|
| imports | + `company.js`, `companyactions.js`, `ledger.js`, `bank.js`, `crew.js`, `parts.js`, `shared/limits.js`, `store.js` |
| `constructor` | + `this.companies = new Map(); this.vessels = new Map(); this.store = new Store({ stateFile: this.stateFile, log })` before `loadState` |
| `loadState` | → `store.readState` + migrations + ledger truncation + build companies/vessels + bind players; then the existing `migratePlayer` loop, convoy rebuild, market drift; + downtime shift |
| `saveState` | → §6.2 (`{ sync }` option) |
| `findOrCreatePlayer` | person fields on the player; ship fields to the vessel via `foundProvisional` (TIME's `shipTime` line moves into the vessel factory) |
| `startBerth`, `nearBerthFor`, `tugAssist` (its `taken` set) | occupancy loop → `this.berthOccupancy(harborId, exceptVessel)`; `tugAssist` keeps adding berths other ships are being brought into |
| `publicState`, `privateState` | + §5.1, §5.2 fields |
| `sendHarbor`, `feesFor`, `fuelPrice`, `repairCost` | + §5.4 payload; home and eco multipliers |
| `connect`, `disconnect` | + `sendCompany(p)`; `company.lastSeenOwner`; wage settle on presence change |
| `onState` | + throttle clamp and budget factor from `you.limits` |
| `onAction` | + before `default`: `if (handleCompanyAction(this, p, m)) return;`; `buy_ship`, `buy_used` pass `m` through |
| `dock`, `tugAssist`, `acceptJob`, `setFishing`, `towPickup`, `deliverOffshore` | + the limit checks of §4.5; `acceptJob` also lets `cls === 'pilot'` take charters (§3.10) |
| `finishDock`, `undock`, `service`, `buyFuel`, `repair`, `buyKit`, `abandonJob`, `payJob`, `tradeGoods`, `buyShip`, `buyUsedShip`, `sellShip`, `tow`, `inspect`, `impound`, `forcedReset`, `tradeAccept`, `deliverOffshore`, `expressPassage`, `finishRescue` | money lines → §4.8; `finishDock` + survey, crew quits, mooring wear; `undock` + checks |
| `collision`, `grounding`, `sink` | + hull factor, damage record, propeller, claim, crew discharge |
| `tick` | line 1114 → wage time (also one line in the assist branch, §4.3); the fishing statement → the merged form of §7.2; + `tickParts`, fatigue, fitting progress, limits on fuel/flooding/pumps/wet cargo; + `this.companyTick(Date.now())` once per tick (settlement, moored crew, and the clock of ships nobody is aboard, §4.4) |
| `simulateOffline` | + `applyLimits` before `stepShip`; stop with a log line when `limits.autopilot` is false (§4.8) |
| `broadcastSnapshot` | + every 2 s per socket `{ t: 'berthed', ships }` |
| new methods | `berthOccupancy`, `sendCompany`, `companyTick`, `limitsFor(p)`, `shipById(id)` (player by id, else null in wave 2) |

### 9.4 Client hook table (W2-CLIENT)

| File: function | Change |
|---|---|
| `main.js` constructor | `import('./company/hq.js')` → `this.company = new CompanyUI(this)` in try/catch (like the telegraph); `import('./company/crewnpc.js')` → `this.crewNpcs = new CrewNpcs(this)` the same way |
| `main.js` `onMessage` | + cases `company`, `ledger`, `alert`, `berthed` → `this.company?.…` |
| `main.js` `onYou` | hard snap and mesh rebuild also when `prev?.vesselId !== you.vesselId`; label = `you.vesselName`; `this.company?.onYou(you, prev)`; `this.crewNpcs?.sync(you.crewList, you.ship.cls)` (`you.crewList` = `[{ id, name, role, skill }]` of the aboard vessel, added to §5.1) |
| `main.js` `simulate` | `applyLimits(cmd, env, you.limits)` **inside the substep loop, right after `cmd.throttleCmd = this.input.throttleCmd; cmd.rudderCmd = …`** and before `stepShip`. It clamps the per-substep copy `cmd`, never `this.input`: the telegraph keeps showing the order the skipper rang, and AUTOPILOT's order adoption (which compares `input.throttleCmd` with what it wrote last) is not fooled into adopting the clamped value. Autopilot off with an event when `you.limits?.autopilot === false` — through `this.pilot?.engage(false)` when AUTOPILOT has merged, else `this.autopilot = false` |
| `main.js` `bindInput` | key `o` → `this.company?.open()`, on the line after MARKET's `l` key, before `if (this.ashore?.active) return;` (the HQ opens ashore too) |
| `main.js` collision set | include `berthed` meshes (via `this.company.berthedMeshes()`) |
| `hud.js` `TABS`, `TAB_ALIAS`, `renderTab` | + `'crew'` after `'services'` → `this.app.company?.tabCrew(h, you)` |
| `hud.js` `tabServices`, `tabShipyard`, `tabOverview` | append `servicesExtra`; buy buttons from `buyButtons`; a Crew tile |
| `hud.js` `updateTop`, `updateTelemetry` | `this.app.company?.updateChip(you)`, `updateStrip(you)` |
| `hud.js` `drawRadar` | "RADAR FAULT" / "NO POWER" overlay when `you.limits.radar === false` |
| `hud.js` `sheetAction` | default → `if (this.app.company?.sheetAction(act, el)) return;` |
| `hud.js` `anyOverlayOpen`, `transientOpen`, `closeOverlays` | include the HQ sheet `#hqWrap` and the founding card `#foundWrap` (additive next to MARKET's `#marketWrap`) |
| `sound.js` `event` | + `case 'alarm'` (engine-room alarm, two-tone) |

### 9.5 Existing tests that change (W2-SERVER, same commit as the code)

| Test | Change |
|---|---|
| `game.test.mjs` "new players spawn docked at Rotterdam…" | `p.money` 25,000 → 160,000; company and vessel exist |
| `game.test.mjs` inspection / forced reset | `p.money === 500` → the vessel is seized, the player is aboard a loaner coaster, cash unchanged, wanted 0 |
| `game.test.mjs` sinking and rescue (two tests) | landing gives the loaner coaster (no 2,000 excess); insured ships pay the claim |
| `game.test.mjs` service unaffordable (`p.money = 0`) and tug unaffordable (`p.money = 10`) | with overdraft headroom both are now charged into the overdraft; assert that, and add the refusal case with rating D (limit 0) |
| `game.test.mjs` old state file round trip | the v1 file migrates to schema 2; berth, stats and `serviceDue` survive through the accessors; save/load again |
| `timemodel.test.mjs` test 5 (if merged) | wage line as in §7.2 |
| tests that set `p.ship.cls` to a class with a larger minimum crew and then cast off | call `fillMinimumCrew(p.vessel)` (exported from `company.js` for tests) |
| `warp.test.mjs` "fuel, hull wear, crew wages and the fishing catch scale with the factor" | wages settle per full accrued ship hour, so after one 1 s tick `p.money` has not moved at 1× or 100×: compare accrued wage time instead, `b.p.vessel.pay.ms === 100 × a.p.vessel.pay.ms` (exact integers). After the catch-rate retune the fishing part expects 0.3 t at 1× and 30 t at 100× (was 1.5 / 150). WARP-HARBOUR owns this file while it is merging; W2-SERVER edits it after. |
| `game.test.mjs` "accepting freight loads cargo, delivering … pays", "supply and demand … demand bonus", "berth fee per started day …, pilotage …, service …" | dues now carry the eco factor (coaster class D +5 % in the North Sea box) and the home perks (Rotterdam is every new company's home: dues −50 %, berth free, yard −10 %). Assert against `g.feesFor(p, h).dues` / `.pilotage` / `.berthPerDay` instead of `portDues` / `pilotageFee` / `berthFeePerDay`, and run the berth-fee and service part away from home (`p.company.home = 'antwerp'` first) so the 3-day and 1-day berth bills and the full service price are still tested. |
| `jobs.test.mjs` "fishing at the real 10 Hz tick adds up", "a fishing contract completes …" (after the catch-rate retune) | coaster on the Dogger Bank 1.2 t/h: 3,000 ticks → 0.1 t (was 0.5; the wire still rounds to 0.1); the trawler contract (qty 2 t, 6 t/h) needs ≥ 0.5 t caught: 3,200 ticks (320 s → 0.53 t) instead of 2,500 (0.42 t would no longer deliver). |
| `timemodel.test.mjs` (if merged, after the retune) | §1.5 reference numbers: coaster `catchRate` on the Southern Bight 0.84 t/h, trawler on the Dogger Bank 6 t/h. Label vectors: `with your ship: ~119 h fishing (≈ 5 h 57 m at 20×)` and `with your ship: ~119 h fishing + 2 h sailing (≈ 6 h 3 m at 20×)`. Test 3: the coaster now needs ~122 h (budget 130 h → ok, 45 h → too slow); the trawler needs ~28 h (budget 30 h → ok, 15 h → too slow). |

### 9.6 Integration and browser checks (phase C, desktop 1440×900 and phone 390×844, two players)

1. New player: founding card; choose Hamburg and the trawler (138,000); take the starter loan. The HQ shows cash
   262,000 (250,000 − 138,000 + 150,000; 112,000 without the loan), the ship moored at Hamburg, the loan schedule
   starting in 30 days, and the ledger lines `capital` +250,000, `ship_buy` −90,000 (provisional coaster),
   `ship_sale` +90,000 (its refund), `ship_buy` −138,000, `loan_in` +150,000.
2. Deliver the planted freight job: log lines with categories, chip and Books update; P&L shows contract, port, fuel.
3. `SALTLINE_DEBUG=1`, `debug_fail engine.injectors` at sea: failure card, alarm, warp drops; fit the spare at 20×; the
   SYS stat clears. `debug_fail power.switchboard`: radar shows NO POWER, autopilot switches off, nav lights off.
4. Buy a second ship into the fleet, hire minimum crew, Take command: camera, HUD, telegraph and interior move; the
   first ship stays visible at her berth (`berthed`); the second player sees both ships moored with company labels.
5. Lay up the first ship at home; recommission; storage and recommission lines in the ledger.
6. Bank: mortgage quote equals the server's; take it; the schedule lists the due dates; repay part; insurance toggle
   refused on the mortgaged ship.
7. Phone: every HQ tab at 360 px without sideways scroll; founding in three steps; failure card on top, contract pill.
8. Restart the server mid-session: same cash, loans, crew, ledger; `/api/health` shows `adjustLines: 0`.
9. `npm test` green; `/api/health` save time < 100 ms.
10. Go below on the provisional coaster: the engineer stands in the engine room and two deckhands on deck, clear of the
   stairs; hire a cook → a figure appears in the galley; Take command of the second ship → the figures are hers.
11. Trade: buy 1,200 t of steel at Rotterdam → the event names the average price, above the posted one; sell it at the
   destination → below the posted price; with WORLD-MARKET merged the Prices tab shows separate Buy and Sell columns.
   Founding card on a phone: every starter card shows its earning line from §3.10 without overflow at 360 px.

---

## 10. Decisions for the product owner (built as written unless changed)

1. **Wage level.** Built at one realistic labour market (coaster crew 1.23× today). Raise `CREW.WAGE_SCALE` together
   with a contract-pay retune if crew should bite harder.
2. **Coaster price 120,000.** Cheap for a 90 m ship, but it keeps every repair and service bill as it is. A higher
   price means a maintenance rebalance.
3. **Default at 30 days** with real-time months: generous on purpose. Shorter makes the bank scarier for absent
   players.
4. **Founder's grant** tops migrated players up to 160,000 cash (minimum 25,000).
5. **Captains appear in the crew market in wave 2** but only fill a mate slot until v6 lets them sail alone.
6. **Tow fee rescaled** to `min(50,000, 3,000 + 0.2 cr/m)`; the old formula (2 cr per metre) was hidden by the cash clamp.
7. **Balance retune** (§3.10): catch rate ÷ 5 (`RATES.FISH_T_PER_H` 2), trades priced along the curve with a 1 % spread,
   the pilot boat allowed charters as a water taxi; the gate test keeps every starter's best work within 3.5× a full
   freight run. Section 11 asks the player about the taste side.

## 11. Open questions for the player

1. **How rich should fishing be?** Today a stern trawler nets about 9,000 credits per hour at sea — ten times a full
   freight run — and pays off the starter loan in about an hour of play. Wave 2 is built with a fifth of today's catch
   (trawler 6 t/h on the Dogger Bank, a coaster 0.8 t/h), so a trawler earns about three times a freighter and loans,
   crew and insurance matter. Keep that, or bring back the big catches?
2. **Should a long break cost you a ship?** Loan instalments and insurance run on real days whether you play or not;
   thirty days behind, the bank takes the mortgaged ship (built). Or should the company's bills pause while you are away
   for more than a week, the way the crew's wages already do?
3. **How much should the crew matter?** Built: a full crew costs about 7 % of a typical freight contract's pay (749 of
   10,400 cr on a 400 t, 300 km run), and a missing deckhand costs you a few percent of speed. Should crew instead be a
   big, felt cost with big effects (skilled engineers halving breakdowns, a missing cook souring everyone), with
   contract pay raised to match?
