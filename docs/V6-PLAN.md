# Saltline v6 — plan (player wish list, 2026-10-08)

v6 builds on v0.5's company layer (wave 2: company, home harbour, bank, crew, ship stats, spare parts). Wave 2 is
therefore designed with a **fleet** from the start (a company owns several ships), so v6 extends it instead of
rewriting it.

## Wish list → work items

| # | Player said | Work |
|---|---|---|
| 1 | The home harbour needs its own office with boat storage where I can swap boats when I buy more | **Company office** in the home harbour (a building you can walk into ashore, and a tab in the harbour sheet): the fleet list, the **boat storage** (laid-up ships in the home basin, visible in the 3D harbour, no crew wages, small storage fee), swap which ship you sail (your character walks over; cargo/contracts stay with their ship), buy/sell/lay up/recommission. |
| 2 | Multiple ships sailing on the map; switch between them and get the view of the ship I'm on | **Fleet at sea:** every owned ship that is not laid up is a real ship in the world, sailed by its hired captain on autopilot along a planned route (the same server simulation offline voyages use today) or doing contracts it was given. **Switch ship:** the camera, HUD, helm and interior move to that ship; the one you leave continues under its captain. Other players see all of them. Limits: crew and captain needed per ship (wave 2 crew market). |
| 3 | A home view with all ships, economics and office data, where I can switch ships | **Company HQ screen** (full screen, also on mobile): world map with all your ships and their routes/ETAs, per-ship cards (position, task, cargo, fuel, condition, crew, profit this week), company economics (cash, loans, monthly instalments, income/costs ledger, profit & loss, balance sheet, fleet value), office data (home harbour, reputation, storage). One tap on a ship = switch to it (item 2) or give it orders (sail to, take contract, return home, lay up). |
| 4 | The autopilot must know the sea charts instead of steering a straight line | **Chart-aware autopilot:** every route (chart route, job Route button, fleet orders) is planned over water with the server route planner (today: sea-lane graph + land check, `/api/route`), extended with the ship's **draught** (keel clearance on the depth model at low tide), harbour patches (10 m data), **traffic separation schemes** (keep to the right lane), fairways and channels on approach, and live re-planning when the route is blocked (shallows ahead, storm). The autopilot slows for harbour approaches and hands over to berth guidance / tugs. |
| 5 | Fishing jobs are not accurate: 100 t in 21 h, but I catch 4 t per hour; in fast forward I catch faster but the minutes still go slow — not reality. Make it precise and correct | See **Time model** below. Contracts become feasible by construction and show the time they need with your ship. |
| 6 | Time warp should work in harbours, limited to 5× | Warp up to **5× inside harbours** (berthing approach, waiting for the tide, moored with the engine off); 20× and more stay open-water only. The berth guidance, tugs and collision keep working at 5×. |
| 7 | A world market: which harbour has which prices for buying and selling | **World market screen:** every harbour's buy/sell prices and stock per good (live, from the supply/demand model), sortable, on a map layer (price heat map per good), price history sparklines, and a **trade route finder** (best margin per tonne-km for your ship's hold, including fuel and port dues). |

## Time model (item 5) — one clock for the world, one for your ship

What happens today: the world clock (top bar) is real UTC, shared by all players, the real tides, the live weather and
the live AIS ships. Time warp makes only *your ship* run faster: fuel, wages, wear and the catch run ×5 / ×20 / ×100,
but the clock you look at does not, and contract deadlines count world time. Fishing contracts are generated per
harbour without looking at any ship: 20–140 t with 18–48 h to deliver, while a coaster on the Southern Bight catches
0.6 × 0.7 × 10 = **4.2 t/h** — 100 t needs 24 h of fishing, so a 21 h contract is impossible at 1× and trivial at 20×.

The fix:
1. **Ship's clock.** Every ship keeps its own elapsed time that runs at the warp factor. The HUD shows it next to
   the world clock while warping ("ship time +6 h 20 m, 20×"), so the minutes visibly fly by.
2. **Contract time on the ship's clock.** A contract's deadline is a budget of *ship hours* (sailing / fishing time),
   counted down on the ship's clock: warp no longer cheats a deadline, it only saves you real waiting time. Docked
   time counts at 1×.
3. **Feasible contracts.** Quantities and time budgets are generated from realistic rates (fishing: ground richness ×
   typical gear; freight: distance at a service speed) with margin, and each contract card shows **"with your ship:
   ~24 h fishing (≈ 1 h 12 m at 20×)"**, greyed out with the reason when your ship cannot make it.
4. **Exact accumulation.** All per-tick quantities (catch, fuel, wear, wages, interest) accumulate in full precision
   and round only for display (the v0.4.1 fishing fix applied everywhere), with tests at the real 10 Hz tick.
5. Tides, weather and AIS stay on the real world clock (they are real data); a warped ship sees them as they are now.

## Dependencies and order
- v0.5 wave 1 (telegraph, berth guidance, tugs, interior) — building.
- Quick v6 items that need no company layer and can ship right after wave 1: **warp 5× in harbours (6)**, **world
  market screen (7)**, **chart-aware autopilot first step (4: route planner for every route + draught)**, **feasible
  contracts and the ship's clock (5)**.
- v0.5 wave 2 (company, home harbour, bank, crew, stats, spare parts) built fleet-ready, then v6 **office + boat
  storage (1)**, **fleet at sea + switching (2)** and **HQ screen (3)** on top of it.
