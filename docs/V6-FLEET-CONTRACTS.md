# Saltline v6 fleet — build contract (office, boat storage, several ships, captains, switching, HQ)

Design contract, 2026-10-08 (written 16:45–18:30 UTC). Covers V6-PLAN items **1** (home office and boat storage),
**2** (fleet at sea and switching ships) and **3** (HQ screen), moved up by the player ahead of v0.5 wave 2
(`docs/V7-PLAN.md` roadmap step 2). It builds a **minimal company core** (fleet, home harbour, small ledger) that wave 2
(`docs/V5-WAVE2-DESIGN.md`) extends with the company record, bank, crew market and parts instead of rewriting it (§15).

Root: `/tmp/claude-0/-home-user/0e451cf3-a540-5510-b1a6-978d07bae2ed/scratchpad/saltline`. Line numbers drift
(`server/game.js` had 2,055 lines at 16:50 and two other agents are editing it), so **every hook is named by function
and by the statement it sits next to**.

Read with: `docs/V6-PLAN.md` (items 1–3), `docs/V5-WAVE2-DESIGN.md` (§1 decisions, §3.1 storage, §4.2 vessel view and
actors, §6 persistence, §8 v6 extension points), `docs/V6-QUICK-CONTRACTS.md` (TIME-MODEL `shipTime`/`advanceShipClock`,
AUTOPILOT `/api/route` and `RoutePlanner`), `docs/V7-BATCH1-CONTRACTS.md` (contract style, the hook layer), `docs/ARCHITECTURE.md`.

| § | Content |
|---|---|
| 1 | What the player gets (plain English) |
| 2 | Decisions |
| 3 | Data model, ids, save format, migration, limits, money |
| 4 | `shared/fleet.js` — numbers and pure rules (verbatim, frozen) |
| 5 | Buying and selling without a forced trade-in |
| 6 | The office and boat storage |
| 7 | Fleet at sea: hired captains, orders, contracts, time, safety |
| 8 | Switching ships |
| 9 | HQ screen and the other client screens |
| 10 | Protocol (messages, actions, validation, rate limits, debug) |
| 11 | Server build: files, the `game.js` hook table, performance, security |
| 12 | Client build: files and edits |
| 13 | Lanes, frozen interface, timing |
| 14 | Tests (unit, with expected numbers) and browser scenarios |
| 15 | Compatibility and amendments to wave 2, v7 batch 1, quick v6 |
| 16 | Acceptance checklist |
| 17 | Defaults chosen for open questions; what is deferred |

---

## 1. What the player gets (plain English)

- **Buying a ship no longer takes your old one.** In the shipyard there is a box "Trade in my current ship". It is
  **off** by default. Leave it off and the new ship is delivered in this harbour, moored next to yours. You now own both.
  Tick it and it works like before (the old ship is traded in).
- **Your home harbour has an office.** Rotterdam to start (or the harbour you were in when v6 arrived). Open it from the
  harbour screen (tab **Office**) or walk ashore to the harbourmaster's building at home. You can move your home to
  another bigger harbour (the first move is free).
- **Boat storage.** At home you can **lay up** ships you do not use: they lie in the home basin (you see them in 3D), cost
  a small storage fee per day (a coaster: 32 cr) and no wages. Three places are free; you can buy more. **Recommission**
  a ship to use her again.
- **Go aboard another ship.** In the same harbour you just walk over (free). A ship somewhere else at sea: a launch or
  helicopter takes you (250 cr + 2 cr per km, never more than 5,000 cr). The camera, the helm, the HUD and the inside of
  the ship all move to her.
- **Your other ships really sail.** A hired captain sails every ship you are not aboard. Tell her what to do: sail to a
  harbour, come home, wait at anchor, lay up, or **take a contract** (freight, passengers, charters, fishing, platform
  supply). She plans a safe route over deep water, keeps clear of other ships, berths with the harbour tugs, delivers
  and gets paid. Captains cost wages (a coaster at sea: 60 cr per hour for captain and crew), fuel and harbour fees,
  just like when you sail.
- **Your ships live in real time.** Time warp speeds up only the ship you are on. Your other ships keep the real clock,
  so a 6-hour trip takes 6 real hours. That is fair: warp cannot cheat their contracts.
- **Everyone sees your fleet.** Other skippers see your ships with their name and yours: "Kittiwake · Ann".
- **The HQ screen (key O, or the fleet chip at the top).** A map with all your ships, their routes and arrival times;
  a card per ship (where, what she is doing, cargo, fuel, condition, profit); money for today and the last 7 days, per
  ship and in total; the office (home, storage, running costs); the ships' log. One tap: go aboard or give orders.
- **Your old save keeps working.** Your current ship becomes ship number one of your fleet, with its cargo and contracts.

---

## 2. Decisions

| # | Topic | Decision | Why |
|---|---|---|---|
| F1 | Where per-ship state lives | Every ship is a **Vessel** record; the player's ship fields (`p.ship`, `p.cargo`, `p.docked`, …, the `VESSEL_KEYS`) become **accessors** onto the vessel the person is aboard (wave 2 D1, built now). | One copy of the truth; every existing `game.js` method keeps working unchanged; switching is one assignment (`p.aboard = id`). |
| F2 | How a captain runs a ship | An **actor** (wave 2 §4.2 "actors", built now): an object with the same accessors, fixed to its vessel, whose `money` goes to the owner. The captain calls the existing methods (`undock`, `acceptJob`, `tugAssist`, `stepAssist`, `finishDock`, `deliverOffshore`, `buyFuel`, `repair`, `service`, `tow`, `setFishing`, `simulateOffline`, `advanceShipClock`) on the actor. | No second copy of the docking, contract, fee, fishing and voyage rules. |
| F3 | Company record | **Not in v6.** Money stays `p.money`; the office is `p.office` on the person; the fleet is `p.fleet`. Wave 2 moves them into `Company` (§15). | Smallest change now; wave 2's company/bank is a separate release. |
| F4 | Exact money | Every amount the fleet code charges or credits is a **safe integer**, posted through `fleet.book()`. The aboard ship's per-tick crew wage stays a float as today (wave 2 D4 converts it; changing it now breaks `test/timemodel.test.mjs` and `test/warp.test.mjs`). The ledger stores only integers (the aboard ship's float drift is carried in a remainder). | Exact fleet books without touching tested behaviour. |
| F5 | Captain wages | Integer accrual in milli-credits per hour × ms with the remainder carried (wave 2 D4), posted as soon as ≥ 1 cr is due. Rate: the class crew cost (`crewCost`, ×1.2 towing) while under way, plus a captain at 20 cr/h (12 cr/h under 30 m) whenever she is on duty; nothing while moored without orders or laid up. | Same labour cost as when you sail yourself, plus the captain you replace. |
| F6 | Bills the player cannot pay | Wages and storage are never refused: what cannot be paid becomes `office.owed` (integer, capped at 30 days of storage + wages), paid first from the next income. While anything is owed, no ship departs on a new order and no ship can be bought. Cash never goes below 0. | No negative money before wave 2's overdraft; no free lunch either. |
| F7 | Fleet size | **8 ships** per player, laid-up ones included. | Performance bound (§11.4) and wave 2's 8 storage slots. |
| F8 | Boat storage | Home harbour only; **3 slots free**, more at 40,000 cr each up to 8; fee `max(25, round(0.01 × displacement))` cr/day; recommission `max(100, round(0.002 × max(120,000, price)))` cr. | Wave 2 §3.1 numbers, so wave 2 inherits them unchanged. |
| F9 | Home harbour | Default: the harbour the player is docked in at migration, else Rotterdam (new players: Rotterdam). Must be `regional`, `major` or `mega`. First change free, later ones 25,000 cr and at most once per 7 days; refused while a ship is laid up at the old home. Home perk now: **no berth fee at home** (for every ship of yours). | Simple, useful, no conflict with wave 2's perks (which add to it). |
| F10 | Trade-in | Optional checkbox, **off** in the UI. The server keeps today's behaviour when the field is missing (`tradeIn !== false` = trade in), so old clients and old tests are unchanged. | The player's complaint; compatibility. |
| F11 | Delivery of a new ship | Moored in the yard's harbour at a free fitting berth (else the anchorage); fuel 25 % of her tanks. Optional "then sail her home" order in the same purchase. | No hidden teleports; the captain does the delivery voyage for real. |
| F12 | Selling a fleet ship | Any harbour (every harbour has a yard), moored, not the ship you are aboard, no cargo, no contracts, not under tugs: `shipValue(cls, cond)` (today's rule; the coaster's is 0 until wave 2 prices her, so she is "scrapped for 0 cr"). | One rule. |
| F13 | Switching | **One switch: go aboard ("Take the helm")**, anywhere. Free when she is in the same harbour or within 2 km; otherwise a transfer fee `min(5,000, round(250 + 2 × km))`. 10 s cooldown. Refused while the coast guard hails you, in the raft, under tug assist (either ship), when your ship is taking water (flooding ≥ 0.5), onto a laid-up or sunk ship, or onto someone else's ship. No separate camera-only "watch" mode in v6 (§17). | The player's wish ("switch and get the view of that boat") with the plan's "camera, HUD, helm and interior move"; one concept is easier to understand and to test. |
| F14 | The ship you leave | Keeps the order you give in the switch dialog. Without one: continue her offline-voyage route if she has one; else berth in the harbour she is in or within 5 km of; else **hold safely** (anchor at the nearest safe spot, the express passage's `findSafeSpot` rule). A tow on the line is finished (sail to the tow's port); fishing nets out with a fishing contract → keep fishing. | Never leaves a ship drifting onto land or into traffic. |
| F15 | Time and warp | Ships nobody is aboard run on **world time** (1×): clock, fuel, wear, wages, catch, contract hours. Warp affects only the ship you are aboard (as today). Fleet ships never block anybody's warp (like AI traffic). | Fair: warp cannot shorten a captain's contract; nothing changes for warping skippers. |
| F16 | What captains do | Freight, passengers, charters, fishing, platform supply: yes. Tow contracts: no (they finish a tow already on the line). Black-market jobs: never. Express passage: no. | The automatable jobs; no AI smuggling; tows need seamanship. |
| F17 | Berthing | With a built harbour map: the **harbour tugs** (the real water-only tug assist, visible to all), paid like a player pays. Fallback (no map, tugs refuse twice): a free fitting berth by the harbour pilot, else the harbour anchorage. | Re-uses wave 1's tugs; never through quays. |
| F18 | Visibility | Per socket, the fleet ships within 40 km (at most 60; ships under way first) in each snapshot, like the AI list; moored and laid-up ones at 1 Hz. The owner gets all own ships through the `fleet` message for the HQ. | Bandwidth bound per socket, independent of the world's fleet size. |
| F19 | Ledger | `p.office.book`: per UTC day (8 kept), per vessel, per category, integer credits. Enough for "today" and "7 days" per ship and in total. | Wave 2's real ledger replaces it. |
| F20 | Sinking of a fleet ship | Wreck with her cargo, contracts lost, ship gone from the fleet ("lost" list), crew taken off by lifeboat (text only, no raft for anybody). | No rescue mission for a person who is not there. |

---

## 3. Data model

### 3.1 Records

```ts
// The person (game.byId / game.players, saved in state.json players[]). Today's fields, minus VESSEL_KEYS, plus:
PlayerRecord = {
  id, token, name, createdAt, lastSeen, money /* number, as today */, wanted, wantedAt, convoyId, lastInspected,
  stats, log, contactSeen, warp, warpRouted, warpGraceUntil, warpGraceFactor, warpRun, …(other person fields as today),
  aboard: VesselId,                       // the vessel the person sails; always one of fleet[] with status 'active'
  fleet: [Vessel],                        // 1–8 vessels, the aboard one included (enumerable → saved by saveState's {...p})
  office: Office,
}
Office = {
  home: harborId, homeSetAt: 0 /* unix s of the last change */, homeMoves: 0,
  slots: 3,                               // boat storage places at home (3..8)
  owed: 0,                                // integer credits the office could not pay yet (F6)
  lastSwitchAt: 0,                        // ms, cooldown
  log: [{ t /* unix s */, kind: 'info'|'warn', text, vid }],     // ≤ 50, newest last
  book: { days: { 'YYYY-MM-DD': { [vid]: { [cat]: int } } }, rem: 0 /* float, aboard-ship drift not yet posted */ },
  lost: [{ id, name, cls, how: 'sold'|'scrapped'|'sunk'|'traded', at /* unix s */ }],  // ≤ 20
  unread: 0,                              // log lines since the HQ was last opened
}
Vessel = {
  id: VesselId, ownerId: playerId, name, status: 'active' | 'laidup',
  acquiredAt /* unix s */, acquiredPrice /* int */,
  // — the per-ship fields of today's player record, same names and meaning (VESSEL_KEYS, §3.2) —
  ship, cond, flooding, fuel, cargo, jobs, kits, docked, dockedAt, berth, assist, serviceDue, voyage, towing, fishing,
  fishInfo, sailsUp, lastValid, guideBerth, lowFuelWarned, condWarned, floodWarned, serviceWarned, fullWarned, shipTime,
  voyageEnd /* 'arrived' | 'shoal' | null — set by simulateOffline when it clears a voyage */,
  // — v6 —
  orders: null | Order,                   // the captain's current order (§7.2); null while aboard or idle
  cap: null | CaptainState,               // the captain's progress (§7.3); null while aboard
  pay: { rem: 0 },                        // wage accrual remainder (mcr·ms, < DEN_WAGE)
  laidUpAt: 0, storagePaidTo: 0,          // unix s
  stats: { delivered: 0, earned: 0, distanceKm: 0, sunk: 0, inspected: 0, fined: 0, caught: 0, boarded: 0, pirated: 0, collisions: 0 },
}
VesselId = 'v' + 8 hex (new) | 'v' + playerId (the migrated first ship)       // /^v[0-9a-z]{1,16}$/
```

The ship states shown to the player (`stateOf(v)`, §4): **`laid_up`** (status `laidup`), **`docked`** (moored or docked in
a harbour), **`anchored`** (captain phase `anchored` or `holding`), **`at_sea`** (everything else, tug assist included).
`sunk` and `sold` vessels leave `p.fleet` and appear only in `office.lost`.

Indexes (memory only, rebuilt on load and on every add/remove): `game.fleet.vessels: Map<VesselId, Vessel>` over all
players' vessels; `game.fleet.actors: Map<VesselId, Actor>` (made lazily). Runtime state that must not be saved (planner
requests in flight, accumulated far-tick time, give-way timers) lives in `game.fleet.rt: Map<VesselId, {...}>`.

### 3.2 The vessel view and actors — `server/vessel.js` (verbatim)

```js
// v6 fleet (docs/V6-FLEET-CONTRACTS.md §3.2): per-ship state lives on Vessel records; people and captains see it through
// accessors. Wave 2's company.js imports this file instead of defining its own (§15.1).
export const VESSEL_KEYS = ['ship', 'cond', 'flooding', 'fuel', 'cargo', 'jobs', 'kits', 'docked', 'dockedAt', 'berth', 'assist',
  'serviceDue', 'voyage', 'towing', 'fishing', 'fishInfo', 'sailsUp', 'lastValid', 'guideBerth', 'lowFuelWarned', 'condWarned',
  'floodWarned', 'serviceWarned', 'fullWarned', 'shipTime', 'voyageEnd'];
/** obj.vessel must resolve to a Vessel; each VESSEL_KEY of obj reads and writes that vessel. Non-enumerable: {...p} and
 *  JSON.stringify(p) never copy them. */
export function bindVesselView(obj) {
  for (const k of VESSEL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) delete obj[k];
    Object.defineProperty(obj, k, { configurable: true, enumerable: false, get() { return this.vessel[k]; }, set(x) { this.vessel[k] = x; } });
  }
}
/** A person: `vessel` = the one they are aboard. */
export function bindPlayer(p, fleet) {
  Object.defineProperty(p, 'vessel', { configurable: true, enumerable: false, get() { return fleet.vessels.get(this.aboard) || null; } });
  bindVesselView(p);
}
/** Move today's per-ship fields off an old player record into a new object (the first vessel). */
export function takeVesselFields(rec) {
  const out = {};
  for (const k of VESSEL_KEYS) if (Object.prototype.hasOwnProperty.call(rec, k)) { out[k] = rec[k]; delete rec[k]; }
  return out;
}
/** The hired captain of vessel v: runs the game's own methods for her. Never in game.byId, never saved. */
export function makeActor(fleet, v) {
  const game = fleet.game;
  const a = { id: v.id, isActor: true, online: false, hail: null, convoyId: null, wanted: 0, wantedAt: 0, lastInspected: -1e9,
    warp: 1, warpRouted: false, warpGraceUntil: 0, warpGraceFactor: 1, warpRun: null, contactSeen: null, rescue: null, log: [],
    _cat: null };                                   // ledger category hint for the next money change (§3.6)
  Object.defineProperty(a, 'vessel', { enumerable: false, value: v });
  Object.defineProperty(a, 'owner', { enumerable: false, get: () => game.byId.get(v.ownerId) || null });
  Object.defineProperty(a, 'name', { enumerable: false, get: () => v.name, set() {} });
  Object.defineProperty(a, 'stats', { enumerable: false, get: () => v.stats, set(x) { v.stats = x; } });
  Object.defineProperty(a, 'money', { enumerable: false, get: () => a.owner?.money ?? 0, set: (x) => fleet.actorMoney(a, x) });
  bindVesselView(a);
  return a;
}
```

Rules:
- **Production code never assigns a VESSEL_KEY on a person through a spread or a fresh literal** after binding (the
  `findOrCreatePlayer` literal no longer contains them, §11.2). Existing method bodies (`p.ship.lat = …`,
  `p.cargo = p.cargo.filter(…)`, `p.docked = null`) are unchanged and reach the vessel.
- `p.vessel` is never null for a person (invariant I2). The aboard vessel of an offline player is still sailed by
  today's offline-voyage code (`simulateOffline` from the player loop of `tick`), not by a captain.
- `fleet.actorMoney(a, x)`: `amt = Math.round(x − owner.money)`; if `amt === 0` return; `fleet.book(owner, v.id,
  amt > 0 ? 'income' : (a._cat || 'costs'), amt)` (book applies it). No owner (deleted player) → ignored.

### 3.3 Invariants (each has a test, §14)

| # | Invariant |
|---|---|
| I1 | Every vessel is in exactly one `p.fleet` and in `game.fleet.vessels`; `v.ownerId === p.id`; ids unique world-wide. |
| I2 | `p.aboard` is the id of an `active` vessel of `p.fleet`; a vessel is the aboard vessel of at most one person. |
| I3 | `p.fleet.length ≤ 8`; laid-up count ≤ `office.slots` ≤ 8. |
| I4 | `laidup` ⇒ docked at `office.home`, no cargo, no jobs, not aboard, `orders` and `cap` null, no assist. |
| I5 | Every `fleet.book()` amount is a safe integer ≠ 0; every `office.book.days` value is an integer; `office.owed` is a non-negative integer. |
| I6 | Cash (`p.money`) never goes below 0 through fleet code. |
| I7 | Only the aboard vessel of a connected person accepts `state` positions (`onState`); a captained vessel moves only in `fleet.tick`. |
| I8 | A vessel's `shipTime` never decreases; `pay.rem` is an integer in `[0, DEN_WAGE)`. |
| I9 | No captained ship's accepted position is on land or in water shallower than her draught (`simulateOffline`'s own check) and no berth holds two vessels when a free fitting berth existed. |

### 3.4 Save format (`data/state.json`, same file, same writer)

`saveState` keeps writing `players: [...]` with `{ ...p, hail: null, online: false, warp: 1, … }`; because `fleet` and
`office` are enumerable they are saved with the person, and the accessors are not. One top-level key is added:
`fleetSchema: 1`. A saved player:

```json
{ "id": "3fa9c2d1", "token": "…", "name": "Ann", "money": 84310, "aboard": "v3fa9c2d1",
  "fleet": [ { "id": "v3fa9c2d1", "ownerId": "3fa9c2d1", "name": "Sea Bee", "status": "active", "ship": { "cls": "coaster", "lat": 51.95, "lon": 4.05, "hdg": 87, "spd": 0, "throttle": 0, "rudder": 0 }, "cond": 92, "fuel": 61.2, "cargo": [], "jobs": [], "docked": "rotterdam", "orders": null, "cap": null, "pay": { "rem": 0 }, "shipTime": 1791456000.5, "…": "…" },
             { "id": "v81c0e7aa", "name": "Kittiwake", "status": "laidup", "…": "…" } ],
  "office": { "home": "rotterdam", "slots": 3, "owed": 0, "log": [], "book": { "days": {}, "rem": 0 }, "lost": [], "homeSetAt": 0, "homeMoves": 0, "lastSwitchAt": 0, "unread": 0 },
  "stats": { "…": 0 }, "log": [] }
```

Size: ~1.5 KB per vessel, 8 vessels max → a full fleet adds ≤ 12 KB per player. `saveState`'s `fishing: false`
override is **removed** from the spread (it would add a stray person key); the aboard ship's nets are hauled on load as
today (`loadState` sets `p.fishing = false`, which now reaches the vessel). Captained vessels keep `fishing` (their
captain re-checks the ground on the next step).

**Rollback:** v5 code reading a v6 file finds no `ship` on the person and crashes in `migratePlayer`. Before deploying,
the integrator copies `data/state.json` to `data/state.pre-v6-<iso>.json` (release note: to roll back, stop the server,
restore that file; progress since the upgrade is lost). `.gitignore` gains `data/state.pre-v6-*.json`.

### 3.5 Load and migration (`fleet.adoptPlayer(rec)` then today's `migratePlayer`)

For each saved player, in `loadState`'s player loop, **before** `this.migratePlayer(p)`:

1. **v6 record** (`Array.isArray(rec.fleet)`): drop stray own VESSEL_KEYS from the person (`takeVesselFields` result
   discarded); keep vessels with an object `ship` and a known `ship.cls`; set `v.ownerId = rec.id`; give a vessel with a
   missing, malformed or duplicate id a fresh one; cut to the first 8; `status` other than `laidup` → `active`; a
   `laidup` vessel not docked at home, or holding cargo/jobs, or beyond `office.slots` → `active`; if `aboard` is not an
   active vessel of the fleet → the first active one; none active → recommission the first (fee waived). Office fields
   defaulted (`slots` clamped 3..8, `owed` → non-negative integer, `log`/`lost` cut to their caps, `book.days` keeps the
   newest 8 days with integer values).
2. **Old record** (no `fleet`): `const v = { id: 'v' + rec.id (if /^[0-9a-z]{1,15}$/, else a fresh id), ownerId: rec.id,
   name: defaultShipName([]) /* "Sea Bee" */, status: 'active', acquiredAt: (rec.createdAt/1000 | simTime),
   acquiredPrice: 0, ...takeVesselFields(rec), orders: null, cap: null, pay: { rem: 0 }, laidUpAt: 0, storagePaidTo: 0,
   stats: { delivered: 0, earned: 0, distanceKm: 0 } }`; `rec.fleet = [v]`, `rec.aboard = v.id`,
   `rec.office = newOffice(home)` with `home = rec.docked` (read before step 2 moved it) if that harbour exists and its
   size is allowed, else `'rotterdam'`. Deterministic ids make a second load identical.
3. Bind (`bindPlayer`), index the vessels, then today's `migratePlayer(p)` runs unchanged through the accessors.

After the loop, `fleet.afterLoad(savedAtS)`:
- every vessel that is **not** an aboard vessel runs `this.migratePlayer(actor)` (the same defaults: service clock,
  ship clock, accepted-job due dates, an interrupted tug assist completed at its berth) and `actor.warp = 1`;
- the job-id sequence also scans fleet vessels' jobs (today's scan covers only `p.jobs` of the aboard ship);
- **downtime shift** (wave 2 D10): `storagePaidTo += (simTime − savedAt)` for laid-up vessels (nobody played while the
  server was down); clocks and wages need no shift (they advance by tick `dt` only);
- captains in phase `planning` go back to `idle` with their order kept: the next step re-plans.

### 3.6 Money and the small ledger (`fleet.book`)

```js
book(p, vid, cat, amt) {   // the ONLY way fleet code changes money
  if (!Number.isSafeInteger(amt) || amt === 0 || !LEDGER_CATS.includes(cat)) throw new Error(`book: bad ${cat} ${amt}`);
  p.money += amt; this.m0.set(p.id, (this.m0.get(p.id) ?? p.money - amt) + amt);   // keep the drift tracker in step
  const day = dayKey(this.game.simTime), d = (p.office.book.days[day] ||= {}), row = (d[vid] ||= {});
  row[cat] = (row[cat] || 0) + amt; this.pruneDays(p); this.dirty(p);
}
charge(p, vid, cat, amt) { // forced costs (wages, storage, owed): pay what the cash covers, the rest becomes owed (F6)
  const can = Math.min(amt, Math.max(0, Math.floor(p.money)));
  if (can > 0) this.book(p, vid, cat, -can);
  if (amt > can) p.office.owed = Math.min(this.owedCap(p), p.office.owed + (amt - can));
}
```

- **Fleet money sources:** purchases (`ships`), sales (`ships`), slot and home-move and recommission and transfer fees
  (`fees`), wages (`wages`), storage (`storage`), owed paid back (`arrears`), and everything a captain's actor does
  through the game's own methods (contract pay → `income`; fuel → `fuel`, dues/pilotage/berth → `port`, tugs → `tugs`,
  repair/service → `repairs`, tow → `tugs`; the captain sets `actor._cat` right before each call and clears it after).
- **The aboard ship** (the person sails; existing code changes `p.money` directly): once per tick `fleet.tick` books the
  drift `d = p.money − m0` to the aboard vessel: `rem += d; whole = Math.trunc(rem); if (whole) addDay(p, p.aboard,
  whole > 0 ? 'income' : 'costs', whole); rem −= whole;` (no change to `p.money`; `office.book.rem` holds the
  remainder). So per-ship income and costs cover the ship you sail too, in whole credits.
- **Owed:** each tick, if `office.owed > 0 && p.money ≥ 1`: `pay = min(owed, floor(p.money))`, `book(p, '_', 'arrears',
  −pay)`, `owed −= pay`. `owedCap(p)` = 30 × (storage fees per day of laid-up ships + 24 × current wage per hour of all
  captained ships).
- **Totals** (`totals()` in §4): `income` = Σ positive amounts outside `ships`; `costs` = Σ negative amounts outside
  `ships` (shown positive); `net = income − costs`; `ships` = net of `ships` (shown separately as "Ships bought/sold").
- The ledger is display data: losing it costs nothing. Wave 2 starts its real ledger fresh (§15.1).

### 3.7 Limits and anti-abuse

| Limit | Value | Where |
|---|---|---|
| Ships per player | 8 (laid-up included) | buy without trade-in refused at 8 |
| Laid-up ships | ≤ `office.slots` (3 free, buy up to 8 at 40,000 each) | lay up |
| Fleet actions | 10 per second, burst 20, per player (token bucket on the person, not saved); excess ignored silently | `fleet.onAction` |
| Route plans for fleet orders | 6 per minute per player; global planner queue full → the captain retries every 10 s ("waiting for the navigator") | captain |
| Switch | 10 s cooldown; refusals of F13 | `switch_ship` |
| Captains | no contraband, no tows (finish one on the line), no express passage; never hailed or inspected at sea; port inspections at the quay as today (they carry nothing illegal) | captain |
| Money | buying, slots, home moves and switch fees need cash ≥ price and `owed === 0` | all |
| Hold position from an order | within 200 km of the ship, on water deep enough at low water | `fleet_order hold` |

---

## 4. `shared/fleet.js` — numbers and pure rules (verbatim, frozen interface)

Written by Lane A on day 1 exactly as below; Lane B imports it read-only. A change needs both lanes' agreement and an
update of this section.

```js
// v6 fleet, office and boat storage (docs/V6-FLEET-CONTRACTS.md §4). Numbers and pure rules shared by the server
// (server/fleet.js, server/captain.js) and the client (public/js/fleet.js, public/js/hq.js). Plain ESM, no DOM, no state.
import { SHIP_CLASSES } from './constants.js';

export const FLEET = {
  MAX_VESSELS: 8,
  SLOTS_FREE: 3, SLOTS_MAX: 8, SLOT_PRICE: 40000,
  STORAGE_MIN_CR_DAY: 25, STORAGE_PER_T_DAY: 0.01,
  RECOMMISSION_MIN_CR: 100, RECOMMISSION_FRAC: 0.002, HULL_BASIS_MIN: 120000,
  HOME_SIZES: ['regional', 'major', 'mega'], HOME_MOVE_CR: 25000, HOME_MOVE_COOLDOWN_S: 7 * 86400,
  SWITCH_COOLDOWN_MS: 10000, SWITCH_FREE_M: 2000, TRANSFER_BASE_CR: 250, TRANSFER_CR_PER_KM: 2, TRANSFER_MAX_CR: 5000,
  NO_SWITCH_FLOODING: 0.5,
  CAPTAIN_CR_H: 20, CAPTAIN_SMALL_CR_H: 12, SMALL_LENGTH_M: 30, TOW_CREW_MUL: 1.2,
  DEN_WAGE: 3600000000,             // (milli-credits per hour) × ms → credits
  NEW_FUEL_FRAC: 0.25,
  SERVICE_THROTTLE: 0.8, TRAWL_KN: 3,
  NEAR_M: 40000, FAR_EVERY: 10, SUBSTEP_S: 0.5,
  VIEW_RANGE_M: 40000, VIEW_MAX: 60, VIEW_MOVING_MAX: 40, VIEW_FULL_EVERY: 10,
  ARRIVE_M: 1200, ARRIVE_KN: 6, HARBOUR_ZONE_M: 5000,
  HOLD_NEAR_M: 300, HOLD_SEARCH_M: [3000, 10000], HOLD_MAX_KM: 200, ANCHOR_MAX_DEPTH_M: 80, HOLD_THROTTLE: 0.1,
  DEPART_STORM: 0.6, DEPART_WIND_MS: 20, DEPART_WIND_SMALL_MS: 14, WEATHER_RECHECK_S: 600,
  MIN_COND_DEPART: 30, ABORT_COND: 20,
  FUEL_RESERVE: 1.25, FUEL_RESERVE_H: 2,
  GIVE_WAY_CHECK_S: 1, GIVE_WAY_CONE_DEG: 40, GIVE_WAY_TURN_DEG: 30, GIVE_WAY_S: 30, GIVE_WAY_THR: 0.3, GIVE_WAY_STOP_S: 120,
  REPLAN_TRIES: 2, PLANS_PER_MIN: 6, PLAN_RETRY_S: 10, STORM_REPLAN_S: 600,
  OWNER_AWAY_S: 7 * 86400, OWED_CAP_DAYS: 30,
  LEDGER_DAYS: 8, LOG_MAX: 50, LOST_MAX: 20,
  ACTION_RATE: 10, ACTION_BURST: 20,
  NAMES: ['Sea Bee', 'Kittiwake', 'North Star', 'Grey Gull', 'Dogger Lass', 'Morning Tide', 'Silver Herring', 'Puffin',
    'Westerly', 'Good Hope', 'Storm Petrel', 'Harbour Light'],
};
export const VESSEL_ID_RE = /^v[0-9a-z]{1,16}$/;
export const JOB_ID_RE = /^j[0-9a-z]{1,16}$/;
export const SHIP_NAME_RE = /^[\p{L}\p{N} '.\-]{2,24}$/u;
export const ORDER_TYPES = ['sail_to', 'home', 'hold', 'route', 'contract', 'stop'];
export const STATES = ['laid_up', 'docked', 'at_sea', 'anchored'];
export const LEDGER_CATS = ['income', 'costs', 'fuel', 'port', 'tugs', 'repairs', 'wages', 'storage', 'fees', 'arrears', 'ships'];
export const CAPTAIN_JOB_TYPES = ['freight', 'passengers', 'charter', 'fishing', 'supply'];

const cls = (c) => SHIP_CLASSES[c] || SHIP_CLASSES.coaster;
const r5 = (v) => Math.round(v * 1e5) / 1e5;

export function storageFeePerDay(c) { return Math.max(FLEET.STORAGE_MIN_CR_DAY, Math.round(FLEET.STORAGE_PER_T_DAY * cls(c).displacement)); }
export function recommissionFee(c) { return Math.max(FLEET.RECOMMISSION_MIN_CR, Math.round(FLEET.RECOMMISSION_FRAC * Math.max(FLEET.HULL_BASIS_MIN, cls(c).price || 0))); }
/** Launch / helicopter transfer to a ship `distM` metres away: free within SWITCH_FREE_M. */
export function transferFee(distM) {
  if (!(distM > FLEET.SWITCH_FREE_M)) return 0;
  return Math.min(FLEET.TRANSFER_MAX_CR, Math.round(FLEET.TRANSFER_BASE_CR + (FLEET.TRANSFER_CR_PER_KM * distM) / 1000));
}
export function captainCrH(c) { return cls(c).length < FLEET.SMALL_LENGTH_M ? FLEET.CAPTAIN_SMALL_CR_H : FLEET.CAPTAIN_CR_H; }
/** Wage rate (milli-credits per hour) of a captained ship. duty: 'underway' | 'duty' | 'off'. */
export function wageRateMcrH(c, duty, towing = false) {
  const cap = captainCrH(c) * 1000;
  if (duty === 'underway') return Math.round((cls(c).crewCost || 0) * (towing ? FLEET.TOW_CREW_MUL : 1) * 1000) + cap;
  return duty === 'duty' ? cap : 0;
}
/** Integer wage accrual: adds rate × ms to pay.rem and returns the whole credits now due (remainder carried). */
export function accrueWage(pay, rateMcrH, ms) {
  const m = Math.round(ms);
  if (!(rateMcrH > 0) || !(m > 0)) return 0;
  const total = rateMcrH * m + (pay.rem || 0);
  const cr = Math.floor(total / FLEET.DEN_WAGE);
  pay.rem = total - cr * FLEET.DEN_WAGE;
  return cr;
}
export function validShipName(s) { const n = String(s ?? '').replace(/\s+/g, ' ').trim(); return SHIP_NAME_RE.test(n) ? n : null; }
/** First default name not in `taken` (case-insensitive); then "Sea Bee 2", "Kittiwake 2", … */
export function defaultShipName(taken) {
  const t = new Set([...(taken || [])].map((x) => String(x).toLowerCase()));
  for (let k = 1; k < 100; k++) for (const n of FLEET.NAMES) { const name = k === 1 ? n : `${n} ${k}`; if (!t.has(name.toLowerCase())) return name; }
  return 'Vessel';
}
export function homeAllowed(h) { return !!h && FLEET.HOME_SIZES.includes(h.size); }
export function stateOf(v) {
  if (v.status === 'laidup') return 'laid_up';
  if (v.docked) return 'docked';
  const ph = v.cap && v.cap.phase;
  return ph === 'anchored' || ph === 'holding' ? 'anchored' : 'at_sea';
}
export function dayKey(unixS) { return new Date(Math.floor(unixS) * 1000).toISOString().slice(0, 10); }
/** The n UTC day keys ending today, oldest first. */
export function lastDays(unixS, n = 7) { const out = []; for (let i = n - 1; i >= 0; i--) out.push(dayKey(unixS - i * 86400)); return out; }
/** Ledger totals over `keys` (day keys) of book.days, for one vessel or all. */
export function totals(days, keys, vid = null) {
  const t = { income: 0, costs: 0, net: 0, ships: 0, byCat: {} };
  for (const k of keys) for (const [v, cats] of Object.entries((days && days[k]) || {})) {
    if (vid && v !== vid) continue;
    for (const [cat, amt] of Object.entries(cats)) {
      t.byCat[cat] = (t.byCat[cat] || 0) + amt;
      if (cat === 'ships') t.ships += amt; else if (amt > 0) t.income += amt; else t.costs -= amt;
    }
  }
  t.net = t.income - t.costs;
  return t;
}
/** Validate and normalise an order from the wire. isHarbor(id) → bool. → { ok: true, order } | { ok: false, why }. */
export function normalizeOrder(o, isHarbor) {
  if (!o || typeof o !== 'object' || !ORDER_TYPES.includes(o.type)) return { ok: false, why: 'Unknown order.' };
  const pick = (v, allowed, d) => (allowed.includes(v) ? v : d);
  const ll = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 85 && Math.abs(lon) <= 180;
  switch (o.type) {
    case 'sail_to':
      if (typeof o.harbor !== 'string' || !isHarbor(o.harbor)) return { ok: false, why: 'Pick a harbour to sail to.' };
      return { ok: true, order: { type: 'sail_to', harbor: o.harbor, then: pick(o.then, ['moor', 'lay_up', 'hold'], 'moor') } };
    case 'home': return { ok: true, order: { type: 'home', then: pick(o.then, ['moor', 'lay_up'], 'moor') } };
    case 'hold': {
      if (o.lat == null && o.lon == null) return { ok: true, order: { type: 'hold' } };
      const lat = Number(o.lat), lon = Number(o.lon);
      if (!ll(lat, lon)) return { ok: false, why: 'That position is not on the chart.' };
      return { ok: true, order: { type: 'hold', lat: r5(lat), lon: r5(lon) } };
    }
    case 'route': {
      const r = o.route;
      if (!Array.isArray(r) || r.length < 1 || r.length > 250) return { ok: false, why: 'A route needs 1–250 waypoints.' };
      const pts = [];
      for (const p of r) {
        const lat = Number(Array.isArray(p) ? p[0] : p && p.lat), lon = Number(Array.isArray(p) ? p[1] : p && p.lon);
        if (!ll(lat, lon)) return { ok: false, why: 'A waypoint is not on the chart.' };
        pts.push([r5(lat), r5(lon)]);
      }
      const harbor = typeof o.harbor === 'string' && isHarbor(o.harbor) ? o.harbor : null;
      return { ok: true, order: { type: 'route', route: pts, harbor, then: pick(o.then, ['moor', 'hold'], harbor ? 'moor' : 'hold') } };
    }
    case 'contract': {
      const jobId = o.jobId == null ? null : String(o.jobId);
      if (jobId !== null && !JOB_ID_RE.test(jobId)) return { ok: false, why: 'Unknown contract.' };
      return { ok: true, order: { type: 'contract', jobId, then: pick(o.then, ['stay', 'home'], 'stay') } };
    }
    default: return { ok: true, order: { type: 'stop' } };
  }
}
```

Reference numbers (asserted in `test/fleet-shared.test.mjs`): storage per day coaster **32**, trawler **25**, feeder
**140**, bulker **400**, boxship **1,100**, sloop **25**; recommission coaster **240**, trawler **360**, pilot boat
**240**, boxship **50,000**; transfer fee 1.5 km **0**, 100 km **450**, 150 km **550**, 2,375 km **5,000**, 6,000 km
**5,000**; wage rates (cr/h = mcr/h ÷ 1000) under way coaster **60**, trawler **55**, pilot boat **27**, sloop **12**,
boxship **420**, coaster towing **68**; on duty coaster **20**, sloop **12**; accrual of a 60 cr/h rate:
36,000 × 100 ms → **60 cr, rem 0**; 3,600 × 1,000 ms → **60 cr, rem 0**; 599 × 100 ms → **0 cr**, the 600th → **1 cr**;
`defaultShipName(['Sea Bee'])` = **'Kittiwake'**; `defaultShipName(FLEET.NAMES)` = **'Sea Bee 2'**.

---

## 5. Buying and selling without a forced trade-in

### 5.1 `buy_ship { cls, tradeIn?, name?, sendHome? }` and `buy_used { listingId, tradeIn?, name?, sendHome? }`

- `tradeIn !== false` (field missing or true): **today's code path unchanged** (`game.buyShip(p, cls)` /
  `game.buyUsedShip(p, listingId)`): the class of the aboard vessel changes, cost = price − trade-in. Then a line
  `lost.push({ how: 'traded' … })` records the old hull for the HQ. The ledger books the drift as usual (aboard).
- `tradeIn === false` (`fleet.buyNew(p, m)` / `fleet.buyUsed(p, m)`):
  1. aboard ship docked (as today); `owed === 0` else "Settle the office's unpaid bills first (X cr)."; fleet size < 8
     else "Your fleet is full (8 ships). Sell or trade in a ship first."; class purchasable (`price > 0`) / listing
     exists; `Math.floor(p.money) ≥ price` else "A Stern trawler costs 180,000 cr. You have 25,000."
  2. `book(p, newId, 'ships', −price)`.
  3. New vessel: `id` fresh, `name = validShipName(m.name) ?? defaultShipName(fleet names)` (a name already in the
     fleet → default), `ship: { cls, lat, lon, hdg, spd: 0, throttle: 0, rudder: 0 }` at `fleet.freeBerth(h, cls)`
     (§6.6) — `moorAt`-equivalent fields (`docked = h.id`, `dockedAt = simTime`, `berth`), `cond` 100 (used: listing
     `cond`), `fuel = round1(0.25 × fuelCap)`, `cargo []`, `jobs []`, `kits 0`, `flooding 0`, `sailsUp true`,
     `serviceDue` as today's two methods set it, `shipTime = simTime`, `acquiredAt`, `acquiredPrice = price`, `status
     'active'`. A used listing is removed from the board (`st.used`).
  4. `sendHome: true` and `h.id !== office.home` → `fleet_order { type: 'home' }` for her at once.
  5. Event "Took delivery of a Stern trawler, **Kittiwake**, moored at Rotterdam, Waalhaven 3. Your Coastal freighter
     stays yours." → `sendYou`, `sendHarbor`, `fleet` message.
- The aboard ship is not touched; the player stays aboard her. Going aboard the new ship is the switch (§8, free here).

### 5.2 `fleet_sell { vesselId }`

Owner, not aboard, `docked` (any harbour; a laid-up ship counts, she lies at home), no cargo, no jobs, no assist. Price `shipValue(cls, cond)` from `server/economy.js` (read-only import). Charges first:
the berth days not yet billed (`max(1, ceil((now − dockedAt)/1 d)) × berthFeePerDay`, 0 at home) booked `port`.
Then `book(p, v.id, 'ships', +value)` when value > 0; vessel removed from `p.fleet` and the index; `lost.push({ how:
value > 0 ? 'sold' : 'scrapped' })`. Event "Sold Kittiwake (Stern trawler, 100 %) for 99,000 cr." / "Scrapped Sea Bee
(the yard pays nothing for a coaster)." The legacy `sell_ship` (aboard ship → pilot boat) is unchanged.

### 5.3 Shipyard data (no new harbour fields needed beyond §6.5)

The client computes "net" from the checkbox: off → `price`; on → `price − tradeIn` (both already in the payload).
`harbor.fleetFull` disables "Buy" with the reason when the box is off.

---

## 6. The office and boat storage

### 6.1 Where

- **Harbour sheet tab "Office"** in every harbour (Lane B adds it at runtime): at home the full office; elsewhere
  "Ships here" and "Make <harbour> your home". Data comes with the `harbor` message (§6.5) and the `fleet` message.
- **Ashore:** at the home harbour the harbourmaster's door says "Harbourmaster & your office" and opens the Office tab
  (one condition in `public/js/ashore.js`, §12).
- **HQ → Office** (§9) shows the same data anywhere.

### 6.2 Lay up — `fleet_layup { vesselId }`

Allowed when: owner; not aboard; `docked === office.home`; no cargo; no jobs; no assist; laid-up count < `slots`.
Effect: `status 'laidup'`, `orders null`, `cap null`, `laidUpAt = storagePaidTo = simTime`; the ship stays at her berth
in the home basin (visible in 3D, label "· laid up"). Refusals name the fix: "Lay up only at your home harbour,
Rotterdam.", "Unload her first (120 t aboard).", "Finish or hand over her contracts first.", "Boat storage is full (3 of
3). Buy a place for 40,000 cr or recommission a ship."

### 6.3 Recommission — `fleet_recommission { vesselId }`

Owner, laid up. Fee `recommissionFee(cls)` (`fees`, voluntary: needs cash and `owed === 0`). Effect: `status
'active'`, captain idle, ship moored where she lies. A laid-up ship's clock stops while laid up (`advanceShipClock` is
not called for her) and her storage fee runs instead of wages.

### 6.4 Storage fee, slots, home

- **Daily pass** (`fleet.daily(now)`, from `fleet.tick` once a minute): for each laid-up vessel, `days =
  floor((now − storagePaidTo) / 86400)`; if `days ≥ 1`: `charge(p, v.id, 'storage', days × storageFeePerDay(cls))`,
  `storagePaidTo += days × 86400`. Recommission or sale charges the started day (`ceil`, at least 0) first.
- **`fleet_slot {}`**: aboard ship docked at home; `slots < 8`; 40,000 cr (`fees`); `slots++`.
- **`fleet_home { harbor }`**: the aboard ship is docked at `harbor`; `homeAllowed(h)`; not already home; no laid-up
  ship; first move (`homeMoves === 0`) free, else `simTime − homeSetAt ≥ 7 d` and 25,000 cr (`fees`). Sets `home`,
  `homeSetAt`, `homeMoves++`. Refusals: "Rotterdam is already your home.", "Small ports cannot host an office — pick a
  regional, major or mega port.", "Recommission or sell your laid-up ships first.", "You moved your office 2 days ago —
  next move possible in 5 days."
- **Home perk:** berth fee 0 at home (`undock` and §5.2) for every ship of the owner, the aboard one included.

### 6.5 `harbor` payload additions (`sendHarbor`, via `...fleet.harborFields(p, h)`)

```js
office: { isHome: boolean, home, homeName, slots, slotsMax: 8, slotPrice: 40000, used /* laid up */, storagePerDay /* Σ */,
          homeMove: { allowed: true | 'reason', cost } },
fleetHere: [VesselView],            // the owner's vessels docked in this harbour, aboard one first (VesselView §10.3)
fleetFull: boolean, fleetN: int,
```

### 6.6 Berths for fleet ships (`fleet.berthsTaken`, `fleet.freeBerth`)

- `berthsTaken(harborId, exceptVessel) → Set<berthId>`: berths of **all** vessels docked there (every player's aboard
  ship, fleet ships, laid-up ships) plus the berth of every running tug assist into that harbour. Replaces the three
  player-only loops in `startBerth` (as a use count), `nearBerthFor` (occupied set) and `tugAssist` (taken set) —
  behaviour for a world without fleets is identical (tests unchanged).
- `freeBerth(h, cls)`: the least used fitting berth not taken, nearest the anchor (today's `startBerth` rule); none →
  a **lay-by spot**: `findSafeSpot(harbourAnchor, { draft, length, depthLW: game.depthAtLowWater, others:
  fleet.hullsNear(…), maxRadiusM: 1500 })` with `berth: null` (docked at the anchorage, like a harbour without a map);
  none → the anchor point itself.

### 6.7 Transfers between ships in the same harbour

- `fleet_transfer { fromId, toId, good, qty }`: both owned, both docked in the same harbour (either may be aboard),
  neither laid up; `good` a known good; free cargo only (`!jobId`); `qty` finite > 0, ≤ what `from` has of it (caught
  fish keeps `caught: true`), ≤ free hold of `to` (`capacity − cargoMass`), rounded to 0.1 t for caught fish, whole
  tonnes otherwise. Contraband moves too (it is the player's own business ashore). No fee.
- `fleet_move_job { jobId, fromId, toId }`: same harbour; moves the accepted job and its contract cargo stack (`jobId`
  matches) together. Checks for `to`: `hardReason(job, { cls, holdFreeT, paxFree })` from `shared/jobtime.js`,
  pax berths, `needsCat`; a tow on the line or a supply already delivered cannot move. The job's `dueShip` is rebased:
  `dueShip = to.shipTime + (job.dueShip − from.shipTime)` (the time left carries over).

---

## 7. Fleet at sea: hired captains

### 7.1 Who sails what

| Vessel | Sailed by |
|---|---|
| aboard ship of an online person | the person's client (as today) |
| aboard ship of an offline person | today's offline voyage (`simulateOffline` from the player loop) — unchanged |
| any other `active` vessel | her **captain** (`captain.stepVessel`, from `fleet.tick`) |
| `laidup` vessel | nobody (storage fee only) |

### 7.2 Orders — `fleet_order { vesselId, order }` (shapes in §4 `normalizeOrder`)

| Order | Meaning | Ends |
|---|---|---|
| `sail_to { harbor, then: 'moor'|'lay_up'|'hold' }` | plan a route to the harbour, sail it, berth (§7.5) | moored (then `lay_up` at home only; `hold` = anchor off the harbour instead of berthing) |
| `home { then }` | `sail_to` the office's home | as above |
| `hold { lat?, lon? }` | anchor or keep station at the nearest safe spot to the point (default: here) | stays until the next order |
| `route { route, harbor?, then }` | sail the given waypoints (the player's own route when leaving a ship) | `then` |
| `contract { jobId?, then: 'stay'|'home' }` | do the contract(s) aboard: one job, or all of them in order of the nearest destination (`jobId` null) | after the last delivery: stay moored there, or `home` |
| `stop` | at sea → `hold` here; docked → idle (planning cancelled) | — |

Accepting work: **`fleet_accept { vesselId, jobId, then? }`** — the vessel is docked (any harbour); the job is on that
harbour's board (not the black-market contact); type in `CAPTAIN_JOB_TYPES`; then the game's own `acceptJob(actor,
jobId)` (same capacity, pax, category checks and texts; feasibility warning kept) and, if it succeeded, `orders =
{ type: 'contract', jobId, then }`. **`fleet_board { vesselId }`** asks for that harbour's board as the vessel would see
it (answer `fleet_board`, §10.2), so the HQ can give a contract to a ship in another harbour.

Order validation besides the shape: owner; vessel active, not aboard; `sail_to`/`home` with `then: 'lay_up'` only to
the home; `hold` within 200 km; `contract` with a jobId the vessel holds (or any job when null); while `owed > 0`, orders
that need a departure are refused ("Settle the office's unpaid bills first."), `hold` and `stop` are always allowed.
A new order replaces the old one; a captain in the middle of a tug assist finishes it first.

### 7.3 Captain state (`v.cap`, saved) and the step (`server/captain.js`)

```ts
CaptainState = { phase: 'idle'|'planning'|'waiting'|'sailing'|'arriving'|'fishing'|'transfer'|'anchored'|'holding'|'failed',
  why: string|null,                       // shown on the ship card ("waiting for weather: gale at Rotterdam")
  since: unixS, target: { harbor?, lat?, lon?, kind: 'harbor'|'ground'|'platform'|'spot'|'route' } | null,
  route: [[lat, lon]] | null,             // what she sails now (also v.voyage.route, see below)
  routeKm, etaS: unixS|null, tries: 0, nextAt: 0, holdAt: { lat, lon } | null, jobId: string|null, stormIds: { [id]: unixS } }
```

`captain.stepVessel(fleet, v, dt)` (dt = world seconds since her last step, §11.4):

1. `actor = fleet.actorOf(v)`; `game.advanceShipClock(actor, dt)` (rate 1: the actor is offline; due-date events go to
   the owner).
2. **Wages:** `duty` = `'off'` when docked without an order (`phase idle`) or laid up; `'duty'` when anchored, waiting,
   planning at sea, or under tugs; `'underway'` when `|throttle| > 0.03 || |spd| > 0.5` (today's `underway` test, which
   also covers holding on the engine and trawling). `cr = accrueWage(v.pay, wageRateMcrH(cls, duty, !!v.towing),
   dt × 1000)`; `cr > 0` → `charge(owner, v.id, 'wages', cr)`.
3. Under tug assist (`v.assist`): `game.stepAssist(actor, dt)`; if she is now docked → `onArrived(v)`. Return.
4. Docked: the docked phases (idle / planning / waiting / departing, §7.4). Return.
5. At sea: `flooding ≥ 1` → `fleet.sinkVessel(v)` (§7.10). `anchored` → position fixed (spd 0, throttle 0); `holding`
   → position fixed, `ship.throttle = 0.1` (fuel and wear through step 6). `sailing`/`fishing`/`transfer` → the voyage
   step: set `v.voyage = { route, i, throttle, harbor, setAt }` from `cap` when missing, give way (§7.8), then in
   substeps of ≤ 0.5 s `game.simulateOffline(actor, h)`; `v.voyageEnd` tells `'arrived'` (last waypoint within 400 m)
   or `'shoal'`. Then `game.stepAtSea(actor, dt / 3600)` (§11.2: fuel, wear, flooding/pumps, catch, tow hand-over) once
   per step with the whole `dt`.
6. Checks after moving, in order: fuel 0 → `actor._cat = 'tugs'; game.tow(actor)` (towed to the nearest harbour, as a
   player's "call a tow"; order kept and resumed from there); `cond < 20` and not already making for a harbour →
   order replaced by `sail_to <nearest harbour> then moor` with a warn event; arrival test (§7.5); fishing test (§7.6);
   platform test (§7.6); `voyageEnd === 'shoal'` → re-plan from here (`tries ≤ 2`), else `hold` here with a warn event.

### 7.4 Departure (docked phases)

When an order needs the ship to leave (`sail_to`, `home`, `route`, `contract`, a `hold` elsewhere):
1. **Plan** (`phase 'planning'`): `game.routePlanner.plan({lat, lon} of the ship, target, { toHarbor, draft, beam,
   length, avoid: storms ≥ 0.6 near the route, simTime }, { priority: 'high' })` (RouteV2 `points`). Per-player limit 6
   plans per minute; a null answer with the queue full → retry in 10 s ("waiting for the navigator"); null otherwise →
   `phase 'failed'`, why "No sea route found to Hamburg for her 5.5 m draught." and an event. Targets: harbour → its
   anchor with `toHarbor`; fishing ground → the ground point nearest the ship at 0.4 × radius in from the edge; platform →
   300 m from it on the side facing the ship; hold spot → the spot.
2. **Weather:** at the berth `storm ≥ 0.6`, or wind ≥ 20 m/s (≥ 14 m/s under 30 m length) → `phase 'waiting'`, why
   "waiting for weather (gale force 9 at Rotterdam)", re-check every 600 s of world time.
3. **Condition:** `cond < 30` → `phase 'failed'`, why "Hull at 24 % — repair her before she sails" (HQ → Services).
4. **Fuel:** need = `serviceBurnTph(cls, load) × routeKm / (serviceKn(cls, load) × 1.852) × 1.25 + serviceBurnTph × 2`
   (`shared/rates.js`); short → `actor._cat = 'fuel'; game.buyFuel(actor, min(fuelCap, need × 1.1) − fuel)`; still
   short → `failed` with "needs 18.2 t of fuel, has 6.0 t and the office cannot pay for bunkers (7,800 cr)". Sailing
   yachts need no fuel.
5. **Bills:** `owed > 0` → `waiting`, why "unpaid bills".
6. **Cast off:** `actor._cat = 'port'; game.undock(actor)` (berth fee, 0 at home; the undock point 20 m off the berth);
   `cap.route = plan.points` (the planner already starts at the berth and leaves the harbour along the fairway),
   `phase 'sailing'`, `v.voyage = { route, i: 0, throttle: 0.8, harbor: toHarbor, setAt }`, event "Kittiwake: cast off
   from Rotterdam for Hamburg, 412 km, ETA Thu 14:20 UTC."

ETA: remaining route km / `serviceKn(cls, load)` from now, refreshed every 60 s while sailing.

### 7.5 Arrival and berthing

While sailing to a harbour: `haversine(ship, harbourAnchor) ≤ 1,200 m && |spd| ≤ 6 kn`, or `voyageEnd === 'arrived'`
within 5 km of that anchor →
1. built map with berths: `actor._cat = 'tugs'; game.tugAssist(actor)` (the real tug assist: water-only path, visible
   tugs, fee). Assist started → `phase 'arriving'`; the berth comes through `finishDock` (§7.3 step 3 → `onArrived`).
2. tugs refuse (no path, cannot pay, too far): one more try after sailing to `harbourAim` (the express passage's approach
   point 1.5–2 km out), then the **pilot fallback**: `freeBerth(h, cls)` → `game.moorAt(actor, h, b)` (or
   `setDocked(actor, h.id, null)` at a lay-by spot) and `actor._cat = 'port'; game.finishDock(actor, h)`.
3. no built map: stop, then `game.dock(actor)` (today's legacy rule within 450 m under 3 kn); refused → pilot fallback.

`onArrived(v)`: `finishDock` already delivered the contracts for this port and charged dues/pilotage (through the
actor). Then by order: `contract` with jobs left → next job (departure §7.4); done → `then` (`stay` → idle; `home` →
`home` order); `sail_to … then lay_up` at home → lay up (§6.2, skipped with a reason if a slot is missing); otherwise
idle. Event "Kittiwake: moored at Hamburg, Burchardkai 2. Delivered: Freight 400 t of Grain to Hamburg — +18,240 cr."

### 7.6 Contracts by type

| Type | What the captain does | Delivered by |
|---|---|---|
| freight, passengers, charter | §7.4 → sail to `job.to` → §7.5 | `finishDock` → `deliverJobs` → `payJob` (today's code, late = half pay on her clock) |
| fishing | sail to the ground (§7.4 target); on arrival `game.setFishing(actor, true)`, `phase 'fishing'`, voyage = a loop of 4 waypoints on a circle of 0.4 × the ground radius round the ground's centre (restarted whenever it ends), throttle `throttleCap(3, maxKn)` (`public/js/pilotcore.js`, import-free) so she trawls at about 3 kn (< 4 kn); the catch comes from `stepAtSea` (rate `catchRate(cls, richness)`, ×0.4 in a storm) | when caught fish aboard ≥ `job.qty` or the hold is full or the clock left < (sea km back / service speed) × 1.2 h: nets in, sail to `job.to`, `finishDock` → `deliverJobs` (pays `min(1, have/qty)`) |
| supply | sail to 300 m off the platform; `phase 'transfer'`: hold (position fixed, spd 0) 60 s of world time, then `actor._cat = null; game.deliverOffshore(actor, jobId)` (needs < 500 m, < 3 kn — both true) | pays at the platform; then `then` (default: back to `job.from` and moor) |
| tow (already on the line when you left her) | sail to `job.to`; `checkTowHandover` (inside `stepAtSea`) pays at 4 km off the port; then berth | today's hand-over |
| tow (not picked up), contraband | refused at `fleet_accept` and at `fleet_move_job` ("Captains do not take tows — sail her yourself.", "No captain will carry that.") | — |

Progress events: fishing every 25 % of the contract quantity; "2 h of ship time left" and "Deadline passed" (from
`advanceShipClock`, routed to the owner with the ship's name).

### 7.7 Holding safely (`hold`, the default for a ship you leave at sea)

`holdSpot(v, aim)` = `findSafeSpot(aim, { draft, length, depthLW: game.depthAtLowWater, others: fleet.hullsNear(aim,
25 km, v), maxRadiusM: 3,000 })`, then 10,000 m; none → aim at the nearest harbour's `harbourAim` and sail there. Spot
within 300 m → stay; else a direct leg when `landOnLeg(world, ship, spot)` (from `server/searoute.js`) is false, else a
planned route. At the spot: depth at low water ≤ 80 m → **anchored** (no engine); deeper → **holding** (station-keeping
on the engine at throttle 0.1: fuel and under-way wages). Event "Kittiwake: at anchor 3.1 km SW of Texel lightship, 24 m
of water." The spot is the express passage's safe spot: draught + 3 m at low water, a clear circle of one ship length,
no other hull within max(300 m, 2 lengths).

### 7.8 Keeping clear of other ships and of land

- **Land:** routes from the draught-aware planner; `simulateOffline`'s own check stops her before water shallower than
  her draught (then re-plan, §7.3 step 6); give-way and hold legs are water-checked (`landOnLeg`) before use.
- **Ships** (checked once per world second per moving captained ship): hulls within `separation(L) + their length / 2`
  (`server/safespot.js`) among online players' ships, other fleet ships (`fleet.hullsNear`), AI traffic
  (`game.aiNear`), live AIS (`game.liveAis?.near(lat, lon, 3000, { limit: 20 })`) and cutters, inside ±40° of her heading
  → give way: insert one waypoint at `destination(ship, hdg + 30°, max(800 m, 6 L))` ahead of `voyage.i` (port side
  −30° if the starboard point fails the land check; both fail → throttle 0.05 until clear, at most 120 s), cap
  `voyage.throttle` at 0.3 for 30 s. She then rejoins her route at the next waypoint.
- **Players** remain responsible for their own helm: the client collision resolver includes fleet ships (§12), so a
  player cannot sail through them.

### 7.9 Time and warp (precise rules)

1. A captained vessel's clock, fuel, wear, wages, catch and contract hours run at **world time** (`shipRate(actor) = 1`
   because actors are offline; `stepAtSea(actor, dt/3600)` with `warpOf(actor) = 1`).
2. The aboard ship runs at the person's warp (today's rules, WARP-HARBOUR and TIME-MODEL unchanged).
3. Taking the helm of a ship resets warp to 1× (`resetWarp`); you may then warp *her* under the normal rules. Leaving her
   hands her back to world time; nothing carries over.
4. Fleet ships are not "other skippers" for warp (`nearestOtherSkipper` counts online persons only — unchanged), and they
   do not stop anybody's warp. They count as hulls for the express passage's safe arrival (`expressOthers`, §11.2).
5. Contracts accepted for a captain show "Captain: ~24 h (real time)" — `estimateJob(job, { cls, …, warp: 1 })`.
6. Server downtime: nothing moves, clocks and wages stop, storage dates shift (§3.5). Same as offline voyages today.

### 7.10 Condition, fuel, weather, sinking, an absent owner

- At sea in a storm cell ≥ 0.6 on the remaining route (`stormOnRoute` from `public/js/pilotcore.js` over
  `game.stormsPublic()`, checked every 60 s): re-plan with that storm as an `avoid` disc, once per storm per 600 s; inside
  a storm the captain caps throttle at 0.5.
- `fleet.sinkVessel(v)`: wreck `{ id, lat, lon, cargo, owner: ownerName, cls, simTime, time }` when cargo, broadcast
  `wrecks`; "Shipping news: Ann's Stern trawler Kittiwake went down at 54.21, 3.05. Her crew was taken off by the
  lifeboat."; `stats.sunk++` on the vessel; vessel removed; `lost.push({ how: 'sunk' })`; event `warn`. The person is
  not involved (never aboard).
- Owner offline > 7 days (`lastSeen`): orders still finish; ships that end up `anchored`/`holding` with no order sail to
  the nearest harbour and moor (wages stop); idle docked ships cost nothing. On the owner's return the HQ log lists what
  happened.

### 7.11 Events (the ships' log)

`game.event(actor, kind, text, extra)` → `fleet.actorEvent(actor, kind, text, extra)`: line `"<ship name>: <text>"`
appended to `office.log` (≤ 50) and `office.unread++`; then, unless `kind === 'info'` and the text matches
`/^(Port dues|Pilotage|Berth fee|Bunkered|Cast off from)/` (quiet bookkeeping lines that the captain summarises himself),
`game.event(owner, kind, line, { ...extra, vesselId, vesselName, fleet: true })` (the person's log, live to the HUD if
online). The captain's own events (departures, arrivals, holds, waits, refusals, progress) use the same path.

---

## 8. Switching ships — `switch_ship { vesselId, leave?: Order }`

### 8.1 Checks (in this order; each refusal is a `warn` event naming the fix)

| Check | Refusal text |
|---|---|
| owner of `vesselId` | "That is not your ship." |
| target `active` | "Kittiwake is laid up — recommission her first." |
| target ≠ aboard | (ignored silently) |
| `now − office.lastSwitchAt ≥ 10 s` | "One moment — the launch is still coming back." |
| not hailed (`p.hail`) | "Not with the coast guard on the radio." |
| not in the raft / sinking (`p.rescue`, `flooding ≥ 1`) | "You are in the life raft." |
| aboard ship not under tugs, target not under tugs | "The tugs have her — wait until she is alongside." |
| aboard ship `flooding < 0.5` | "Not now — she is taking water. Patch the hull (K) first." |
| fee = `docked same harbour ? 0 : transferFee(haversine(aboard ship, target))`; cash ≥ fee, `owed === 0` if fee > 0 | "A launch out to Kittiwake (182 km) costs 614 cr. You have 300." |

### 8.2 Effect

1. Fee > 0 → `book(p, target.id, 'fees', −fee)`.
2. **The ship you leave** (`old`): `old.orders` = the validated `leave` order, else the default (F14):
   docked → idle; `old.towing` → `sail_to job.to`; fishing with a fishing contract aboard → `contract { jobId }` (she
   keeps trawling); `old.voyage?.route` → `route { route: remaining waypoints, harbor: voyage.harbor }`; within 5 km of a
   harbour anchor → `sail_to that harbour then moor`; else `hold` here. `old.cap = { phase: docked ? 'idle' :
   'sailing'|'holding'… }` set by `captain.setOrder(old, order)`. Her current speed and heading carry over (no stop).
3. **The ship you board** (`target`): `orders = null`, `cap = null`, her `voyage` kept (the client may show it as a route;
   the autopilot stays off).
4. Person: `p.aboard = target.id`; `office.lastSwitchAt = now`; reset `moveBudget = null`, `lastState = now`,
   `rejects = 0`, `shallowSince = 0`, `lastValid = target position`; `resetWarp(p)`; `convoyLeave(p, true)`;
   `p.hail` stays null; `contactSeen = null`.
5. Messages: `you` with `{ correction: true, switched: true }`; `harbor` if the target is docked; `fleet`; broadcast
   nothing special (the next snapshot shows the person on the new ship and the old ship in the fleet lists). Event "You
   took the helm of Kittiwake — at sea 22 nm W of Texel. Sea Bee holds at anchor off Hook of Holland under her captain."

### 8.3 What moves and what stays

| Moves with you | Stays with the ship | Office (all ships) |
|---|---|---|
| camera (re-sized), HUD, helm/telegraph (Stop), touch helm, interior (rebuilt for the class), avatar, wanted level, your stats, log, chat, warp (reset to 1×) | position, berth, cargo, contracts, fuel, hull, kits, ship's clock, service date, her voyage/route, tow line, nets | cash, home, storage, ledger, ships' log |

### 8.4 Mid-manoeuvre rules (client and server)

- Ashore or below decks: the client leaves the walker first (`app.ashore.exit` / `app.interior.exit`), then sends the
  switch. The server does not care where the avatar stands.
- At sea with an autopilot route: the switch dialog pre-selects "Continue the route to <harbour>" and sends
  `leave: { type: 'route', route: app.route (≤ 250 points), harbor }`.
- Nets out: default keeps fishing (with a fishing contract) or hauls them (`setFishing(actor, false)`) without one.
- Docking under your own power inside a harbour (within 5 km of the anchor): default "berth in <harbour>" (the captain
  calls the tugs).
- `state` messages carry `vid` (§10.1); the server drops states for any other vessel than `p.aboard`, so states the
  client sent before it heard of the switch never move the new ship.

---

## 9. HQ screen and the other client screens

### 9.1 Entry points

- **Key O** (free today; wave 2 uses the same key for the same screen) and a **top-bar chip** `#fleetChip` "⚓ 3 ·
  2 at sea" with a red dot when `you.fleet.unread > 0`; also a "Fleet (O)" button in the More sheet on phones.
- HQ is a full-screen sheet (`#hqWrap`, created at runtime) that closes with Esc / ✕ / the chip; opening it sends
  `hq_watch { on: true }` (closing: `false`); the server then pushes `fleet` every second.

### 9.2 Layout

Desktop (≥ 900 px): map left (≈ 60 %), right column with tabs **Ships · Money · Office · Log**. Phones (`body.touch` or
< 900 px): one column, bottom tabs **Map · Ships · Money · Office · Log**, cards one per row, buttons full width, 48 px
high; no horizontal scroll at 390 px.

```
┌ Fleet HQ · home Rotterdam · cash 84,310 cr · today +6,120 cr · 7 days +31,400 cr ─────────────── ✕ ┐
│ ┌ map ─────────────────────────────┐  [Ships] Money  Office  Log                                   │
│ │  ◆ Sea Bee (you)                 │  ┌───────────────────────────────────────────────────────────┐ │
│ │     ⋯⋯⋯⋯▶ Kittiwake  ETA 14:20   │  │ [img] Kittiwake · Stern trawler           At sea          │ │
│ │  ▪ Puffin (laid up)              │  │ Fishing on the Dogger Bank · 18.4 of 30 t · 6 h 10 m left │ │
│ │                                  │  │ 54.21° N 3.05° E · 112 km NE of IJmuiden · 3.0 kn          │ │
│ └──────────────────────────────────┘  │ fuel ▮▮▮▮▯ 72 %  hull ▮▮▮▮▮ 94 %  hold 18/300 t            │ │
│                                       │ Profit 7 d +12,800 cr · now 55 cr/h                         │ │
│                                       │ [Take the helm · 614 cr] [Orders ▾] [Log]                   │ │
│                                       └───────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Map** (`HqMap` in `public/js/hq.js`, its own canvas): equirectangular base `/api/chart/world.png` (or
  `/api/chart/region.png` when all ships lie in the region window, `LAYERS[1]`), auto-fit to all own ships + home
  (padding 15 %, min span 2°), pinch/wheel zoom and drag. Own ships: triangles by heading in state colours (at sea teal,
  anchored amber, docked blue, laid up grey), the aboard ship a larger diamond; routes as dashed lines (`route` of
  VesselView) with an end flag and "ETA hh:mm" label; home harbour star. Tap a ship → its card (Ships tab) scrolls into
  view and highlights.
- **Ship card** (one per vessel, aboard first, then active by name, then laid up): thumbnail (`hud.thumbHTML(cls, …)`),
  name, class, state chip, task line (`task.text`, e.g. "Freight 400 t Grain → Hamburg · ETA Thu 14:20"), position
  line (`fmtPos` in `fleetfmt.js`: "112 km NE of IJmuiden" / "Moored at Rotterdam, Waalhaven 3"), bars (fuel %,
  condition %, hold t/capacity or pax), "Profit 7 d", current running cost "now 55 cr/h" or "storage 32 cr/day".
  Buttons from `can` (§10.3): **Take the helm** (free / fee), **Orders ▾** (Sail to… with a searchable harbour list and
  an ETA estimate `seaKm ≈ gc × 1.25` at `serviceKn`; Return home; Hold here; Take a contract → board list from
  `fleet_board`; Lay up; Stop), **Services ▾** when docked (Bunker to full, Repair, Service — `fleet_service`),
  **Rename**, **Lay up / Recommission · 240 cr**, **Sell · 99,000 cr**. A disabled button shows its reason under it.
- **Money:** cash, owed (red when > 0), today and 7 days: income, costs, profit; ships bought/sold separately; a
  7-bar chart of daily profit (canvas, no library); table per ship (today / 7 days: income, costs, profit); costs by
  category for 7 days.
- **Office:** home card (name, "Make <harbour> your home" when the aboard ship is docked at an allowed harbour, with
  cost/cooldown); storage: slots grid (laid-up ships with their fee, empty slots, "Buy a place · 40,000 cr"); running
  costs now (Σ wages per hour, Σ storage per day); fleet value (Σ `shipValue`); ships lost/sold (last 20).
- **Log:** `office.log`, newest first, ship name chips; tap → the ship on the map. Opening the Log tab sends
  `fleet_seen {}` (unread → 0).

### 9.3 Harbour sheet

- **Office tab** (`tab-office`, nav button inserted before "Players" at runtime; `TABS` gains `'office'`): at home —
  "Your office · Rotterdam", storage slots, ships here; elsewhere — ships here and the home-move card. Ship cards here
  add **Go aboard (free)**, **Transfer cargo…** (dialog: from/to ships here, free cargo with quantities, "Move contract
  to…"), and the same orders/services.
- **Shipyard:** a checkbox above the cards "Trade in my current ship (worth X cr)", unchecked by default (remembered in
  `localStorage` per session only — never on by itself); with it off the cards show the full price, "Buy new" confirms
  "Buy a new Stern trawler for 180,000 cr? She will be delivered here. Your Coastal freighter stays yours." with an extra
  checkbox "Then send her home to Rotterdam" when not at home; with it on, today's texts. `fleetFull` disables buying
  with "Fleet full (8 ships)".

### 9.4 3D and the chart

- Fleet ships from `snap.fleet` are drawn like AI traffic (`buildShip(cls, label, seed)`), labels `"<ship> · <owner>"`,
  own ships `"<ship> · yours"` in a lighter label colour; laid-up ships `"<ship> · laid up"`. They are in the collision
  set (`collisionOthers`, skipped when docked or laid up, like docked players today), on the radar, and in the Ships list
  (Tab) under a new heading "Fleet ships" without Board/Trade/Convoy buttons.
- Chart (M): layer `fleet` (on by default) draws the own fleet from the last `fleet` message (positions, routes, ETAs)
  and other owners' fleet ships from `snap.fleet`; the popup of a fleet ship shows owner, state and (own) "Open in HQ".
- Tugs of a fleet ship's assist come in `snap.fleet[].tugs` and are drawn by the tug layer (§12).
- **Switch effect:** a 350 ms fade with "Taking the helm of Kittiwake — at sea 22 nm W of Texel", then the camera at
  `camDistFor(length)`.

---

## 10. Protocol

`net.action(name, fields)` sends `{ ...fields, t: 'action', action: name }` (today's format).

### 10.1 Client → server

| Action / message | Fields | Where allowed | Answer |
|---|---|---|---|
| `state` (existing) | `+ vid` (the client's `you.aboard`) | — | dropped when `vid` is given and ≠ `p.aboard` |
| `buy_ship` (existing) | `cls, tradeIn?: boolean, name?: string, sendHome?: boolean` | aboard ship docked | `you`, `harbor`, `fleet`, event |
| `buy_used` (existing) | `listingId, tradeIn?, name?, sendHome?` | same | same |
| `switch_ship` | `vesselId, leave?: Order` | §8.1 | `you {switched, correction}`, `harbor`?, `fleet`, event |
| `fleet_order` | `vesselId, order: Order` | §7.2 | `fleet`, event |
| `fleet_accept` | `vesselId, jobId, then?: 'stay'|'home'` | vessel docked, job on that board | `fleet`, `harbor` (if the person is docked there), event |
| `fleet_board` | `vesselId` | vessel docked | `fleet_board` |
| `fleet_service` | `vesselId, what: 'fuel'|'repair'|'service', tonnes?` | vessel docked, not aboard | `fleet`, event (the game's own `buyFuel`/`repair`/`service` on the actor) |
| `fleet_rename` | `vesselId, name` | any own vessel (the aboard one too) | `fleet`, `you`, event |
| `fleet_layup`, `fleet_recommission` | `vesselId` | §6.2, §6.3 | `fleet`, `harbor`, event |
| `fleet_sell` | `vesselId` | §5.2 | `fleet`, `harbor`, `you`, event |
| `fleet_transfer` | `fromId, toId, good, qty` | §6.7 | `fleet`, `you`, `harbor`, event |
| `fleet_move_job` | `jobId, fromId, toId` | §6.7 | same |
| `fleet_slot` | — | docked at home | `fleet`, `harbor` |
| `fleet_home` | `harbor` | docked there | `fleet`, `harbor`, `you` |
| `hq_watch` | `on: boolean` | any | `fleet` now and every 1 s while on |
| `fleet_seen` | — | any | `unread = 0` |
| `fleet_debug` | `op: 'money' {amount} | 'place' {vesselId, lat, lon} | 'advance' {vesselId, seconds ≤ 86400} | 'storm' {lat, lon, radiusKm, intensity}` | only with `SALTLINE_DEBUG=1`, else "Unknown action" | `fleet` |

### 10.2 Server → client

| Message | Shape |
|---|---|
| `you` additions (`privateState`) | `aboard: VesselId, vesselName, home, homeName, fleet: { n, atSea, laidUp, owed, unread }` |
| `you` after a switch | `{ t: 'you', you, correction: true, switched: true }` |
| `publicState` additions (snap.players) | `vid, vname` |
| `snap` per socket | `fleet: [FleetPublic]` (≤ 60 within 40 km, moving first, ≤ 40 moving), `fleetFull: true` on every 10th snapshot (then the list also holds the docked, anchored and laid-up ones) |
| `fleet` (owner only) | `{ t: 'fleet', fleet: FleetView }` — on connect, after every fleet action, at most every 2 s when something changed, every 1 s while `hq_watch` |
| `fleet_board` | `{ t: 'fleet_board', vesselId, harbor, harborName, jobs: [publicJob + { est: estimateJob(job, vessel at 1×), why: hardReason | captainRefusal | null }] }` |
| `event` | existing; fleet lines add `vesselId, vesselName, fleet: true` |
| `harbor` additions | §6.5 |

### 10.3 Shapes

```ts
FleetPublic = { id: VesselId, name, owner /* person's name */, ownerId, cls, lat, lon, hdg, spd, state /* STATES */,
                cond, fishing, towing, towCls, tugs?: TugWire[] }      // rounded like publicState (6 / 1 / 1 decimals)
VesselView = {
  id, name, cls, clsName, status: 'active'|'laidup', state, aboard: boolean,
  lat, lon, hdg, spd, harbor: id|null, harborName, berthName,
  fuel, fuelCap, cond, flooding, cargoT, capacity, pax, paxUsed,
  cargo: [{ good, qty, jobId, caught }], jobs: [{ id, type, title, to, toName, pay, dueShip, leftH }],
  shipTime, order: Order | null,
  task: { phase, text, why, etaS: unixS | null, leftKm: number | null, target: { harbor?, lat?, lon?, kind } | null },
  route: [[lat, lon]] | null,                       // remaining waypoints, decimated to ≤ 40
  costNow: { kind: 'wages'|'storage'|'none', crPerH, crPerDay },
  value /* shipValue */, profit: { today: int, d7: int },
  can: { helm: true|string, helmFee: int, orders: true|string, contract: true|string, layUp: true|string,
         recommission: true|string, recommissionFee: int, sell: true|string, sellValue: int, services: true|string, rename: true },
}
FleetView = {
  home, homeName, slots, slotsMax, slotPrice, used, max: 8, n, cash: int /* floor(p.money) */, owed,
  value, costPerH, storagePerDay, unread,
  homeMove: { allowed: true|string, cost },
  vessels: [VesselView],
  money: { today: Totals, d7: Totals, days: [{ day, income, costs, net }] /* 7, oldest first */,
           perShip: { [vid]: { today: Totals, d7: Totals } }, lost: [{ id, name, cls, how, at }] },
  log: [{ t, kind, text, vid }],
}
Totals = { income, costs, net, ships, byCat: { [cat]: int } }
```

`docs/fixtures/fleet.sample.json` = `{ you, fleet: FleetView, harbor: { ...harbour payload with §6.5 }, snapFleet:
[FleetPublic], board: fleet_board }` written by `test/fleet-model.test.mjs` (Lane A) from a 3-ship fleet (aboard
coaster at Rotterdam, trawler fishing on the Dogger Bank with a route, laid-up pilot boat). The client loads it with
`?fixture=fleet` in development (Lane B).

### 10.4 Validation and security

- Every fleet action: `p` is the socket's person (server.js already binds sockets to persons); ids match `VESSEL_ID_RE`
  / `JOB_ID_RE` and resolve through `game.fleet.vessels` to a vessel with `ownerId === p.id` (else "That is not your
  ship."); numbers `Number.isFinite`, in range; strings type-checked and length-limited before any regex; `good` must be
  an own key of `GOODS`; `harbor` must be a `HARBORS` id; orders through `normalizeOrder`. A malformed payload never
  throws out of `onAction` (the existing try/catch stays as the last net).
- Rate limit per person (token bucket 10/s, burst 20) on all `fleet_*`, `switch_ship`, `hq_watch`.
- Actors never appear in `game.byId`/`game.players`, so `board`, `trade_offer`, `convoy_invite`, hails and inspections
  at sea can never target them; `sendYou`/`sendHarbor`/`send` return early for actors.
- `fleet_debug` exists only when `process.env.SALTLINE_DEBUG === '1'`.
- The `fleet` message is sent only to the owner's socket; `FleetPublic` carries no cargo, money or contracts.

---

## 11. Server build

### 11.1 New files (Lane A)

| File | Content |
|---|---|
| `shared/fleet.js` | §4, verbatim |
| `server/vessel.js` | §3.2, verbatim |
| `server/fleet.js` | `export class Fleet` — index (`vessels`, `actors`, `rt`, `m0`), `adoptPlayer`, `afterLoad`, `createFirstVessel`, `actorOf`, `actorMoney`, `book`, `charge`, `actorEvent`, `onAction`/`handles`, `buyNew`, `buyUsed`, `buyShip`/`buyUsed` routers, sell, lay-up, recommission, slot, home, rename, transfer, move-job, services, board, `switchShip`, `berthsTaken`, `berthUse`, `freeBerth`, `hullsNear`, `homeOf`, `harborFields`, `youFields`, `viewFor` (snapshot), `fleetView`, `weatherPoints`, `tick`, `daily`, `sinkVessel`, `unwatch`, `stats` |
| `server/captain.js` | `setOrder`, `stepVessel`, `onArrived`, `planLeg`, `holdSpot`, `giveWay`, `fishLoop`, departure checks, task text |
| tests | §14.1 |

`game.fleet = new Fleet(game)` is the only instance; `server/fleet.js` imports `server/vessel.js`, `server/captain.js`,
`shared/fleet.js`, `shared/rates.js`, `shared/jobtime.js`, `server/safespot.js` (`findSafeSpot`, `harbourAim`,
`separation`), `server/searoute.js` (`landOnLeg`), `server/economy.js` (`shipValue`, `berthFeePerDay`, `cargoMass`,
`publicJob` — read-only), `server/harbors.js` (`HARBORS`, `harborById`, `FISHING_GROUNDS`, `PLATFORMS` — read-only),
`public/js/pilotcore.js` (`throttleCap`, `stormOnRoute` — import-free, read-only).

### 11.2 `server/game.js` hook table (Lane A; by function and statement)

| Function | Change |
|---|---|
| imports | `import { Fleet } from './fleet.js';` |
| `constructor` | `this.routePlanner = opts.routePlanner || null;` and `this.fleet = new Fleet(this);` directly **before** `this.loadState();` |
| `loadState` | in the players loop, before `this.migratePlayer(p)`: `this.fleet.adoptPlayer(p);`; the `maxJob` scan adds `for (const v of this.fleet.vessels.values()) for (const j of v.jobs || []) …` (same expression); after the convoy loop: `this.fleet.afterLoad(savedAt);` (savedAt as computed for the market drift) |
| `saveState` | remove `fishing: false` from the per-player spread; add `fleetSchema: 1` to `s` |
| `findOrCreatePlayer` | the new-player literal loses the VESSEL_KEYS (`ship, cond, flooding, fuel, cargo, kits, jobs, docked, dockedAt, berth, assist, serviceDue, lastValid, shipTime`) and keeps the person fields; right after it: `this.fleet.createFirstVessel(p, { cls: 'coaster', spawn, berth });` (creates the vessel with exactly those values, `p.fleet`, `p.aboard`, `p.office` with home `START_HARBOR`, binds) — then `players.set`/`byId.set` as today |
| `startBerth` | the `used` map ← `this.fleet.berthUse(h.id)` |
| `nearBerthFor` | `occupied` ← `this.fleet.berthsTaken(harbor.id, p.vessel)` |
| `tugAssist` | `taken` ← `this.fleet.berthsTaken(harbor.id, p.vessel)` (assists included) |
| `publicState` | add `vid: p.vessel?.id ?? null, vname: p.vessel?.name ?? null` |
| `privateState` | add `...this.fleet.youFields(p)` |
| `send`, `sendYou`, `sendHarbor` | first statement `if (p.isActor) return;` |
| `event` | first statement `if (p.isActor) return this.fleet.actorEvent(p, kind, text, extra);` |
| `sendHarbor` | harbour object gains `...this.fleet.harborFields(p, h)` |
| `disconnect` | `this.fleet.unwatch(p);` |
| `onState` | first statement `if (m.vid != null && m.vid !== p.aboard) return;` |
| `onAction` | `case 'buy_ship': return this.fleet.buyShip(p, m);` `case 'buy_used': return this.fleet.buyUsed(p, m);` (the routers call today's `this.buyShip(p, m.cls)` / `this.buyUsedShip(p, m.listingId)` when `m.tradeIn !== false`); `default:` becomes `default: if (this.fleet.handles(a)) return this.fleet.onAction(p, m); this.event(p, 'warn', \`Unknown action ${a}\`);` |
| `undock` | `const fee = …` → `const fee = p.docked === this.fleet.homeOf(p) ? 0 : days * berthFeePerDay(p.ship.cls);` |
| `tick` | (1) **move** the at-sea block — from `const s = p.ship, C = SHIP_CLASSES[s.cls];` through the `ensureTowSpot` loop — verbatim into a new method `stepAtSea(p, simHours)` and call `this.stepAtSea(p, simHours);` in its place (the wanted-decay line stays in the loop); (2) inside `stepAtSea`, the crew-wage line becomes `if (underway && C.crewCost && !p.isActor) …`; (3) after the player loop, before `this.updateCutters(dt)`: `this.fleet.tick(dt);` |
| `requestWeather` | after collecting `ships`: `for (const s of this.fleet.weatherPoints(50)) ships.push(s);` |
| `expressOthers` | after the players loop: `for (const o of this.fleet.hullsNear(lat, lon, rangeM, p.vessel)) out.push(o);` (`{lat, lon, len}`) |
| `simulateOffline` | `p.voyageEnd = 'arrived';` next to `p.voyage = null; s.throttle = 0;` and `p.voyageEnd = 'shoal';` next to the shoal `p.voyage = null` |
| `broadcastSnapshot` | per socket, after `ai`: `"fleet":${JSON.stringify(this.fleet.viewFor(p, full))}` and `,"fleetFull":true` when `full` (`full` = every 10th call, counted in the fleet) |

Unchanged on purpose: `buyShip`, `buyUsedShip`, `sellShip`, `sink`, `finishRescue`, `forcedReset`, the warp section,
`advanceShipClock`, `shipRate`, `acceptJob`, `deliverJobs`, `payJob`, `finishDock`, `moorAt`, `setDocked`, `dock`,
`tow`, `deliverOffshore`, `setFishing`, `stepAssist`, `migratePlayer` — the fleet runs them through actors.

### 11.3 Other existing files (Lane A)

| File | Change |
|---|---|
| `server/tugassist.js` `tickTugs` | `const p = game.byId?.get(op.pid) || game.players?.get(op.pid);` → `const p = game.byId?.get(op.pid) || game.players?.get(op.pid) || game.fleet?.actorById?.(op.pid) || null;` (a captain's assist keeps its tugs) |
| `server.js` | `new Game(world, log, { weather, traffic, harborgeom, routeTable })` → `{ weather, traffic, harborgeom, routeTable, routePlanner }`; one route after `/api/players`: `app.get('/api/fleetstats', (req, res) => res.json(game.fleet.stats()));` (`/api/health` is not touched) |
| `.gitignore` | `data/state.pre-v6-*.json` |

### 11.4 Performance

- **Stepping cadence** (`fleet.tick(dt)`): a grid (0.5° cells) of online persons' ship positions is built once per
  tick. A captained vessel that is moving, under tugs, or within 40 km of an online person is stepped **every tick**
  with that tick's `dt`; every other one accumulates `dt` and is stepped when `(index % 10) === (tickNo % 10)`
  (≈ 1 Hz with `dt ≈ 1 s`, substeps ≤ 0.5 s). Docked idle and laid-up vessels cost one wage/clock line in their bucket.
- **Budget:** 1,000 captained vessels at sea far from everyone: mean `fleet.tick` ≤ **4 ms** per 100 ms tick on the
  dev box (≈ 100 stepped per tick × ~30 µs); 100 near vessels add ≤ 3 ms. Measured by `test/fleet-perf.test.mjs`
  (asserts a lenient 15 ms so CI noise does not fail it; prints the real figure for the reviewer).
- **Snapshots:** the fleet grid for `viewFor` is built once per `broadcastSnapshot` call (≤ 2 ms at 5,000 vessels); per
  socket a cell query, distance filter, sort, cut to 60 (≤ 40 moving). Moored/anchored/laid-up entries only every 10th
  snapshot. At 60 entries × ~140 B the worst case is ~8 KB per snapshot per socket, similar to today's AI list.
- **HQ:** the `fleet` message (≤ 8 vessels, routes ≤ 40 points) is ≤ 12 KB, only to watching owners at 1 Hz.
- **Planner:** fleet plans use the shared worker queue (`priority: 'high'`, 6 per minute per person); a full queue
  delays a departure, never the tick.
- **Weather:** `weatherPoints(50)` adds at most 50 fleet positions per 30-s sweep (round-robin), within the existing
  WeatherService dedup and rate limits.

### 11.5 Security (server checklist)

Ownership on every vessel id; actors unreachable from player-targeted actions; no money from a client number (prices,
fees and quantities are recomputed on the server); integer booking with `Number.isSafeInteger`; no new HTTP endpoint
returns private data (`/api/fleetstats` returns counts only: `{ vessels, captained, atSea, laidUp, stepsPerTick,
meanTickMs }`); debug actions gated by the environment; rate limits (§10.4).

---

## 12. Client build (Lane B)

### 12.1 New files

| File | Content |
|---|---|
| `public/js/fleet.js` | `export class FleetUi` (`app.fleetUi`): handles `fleet`, `fleet_board`, fleet `event`s; the harbour **Office tab** renderer (`tabOffice(h, you)`), its nav button and `<section id="tab-office" class="tab">` created at runtime; dialogs (switch with "the ship you leave", orders, harbour picker, contract board, transfer, rename, confirm texts); the top-bar chip; the shipyard checkbox helper; `sheetAction` delegate for actions starting with `fl` |
| `public/js/hq.js` | `export class Hq` (`app.hq`): the full-screen HQ (§9.2), `HqMap` canvas, tabs, `hq_watch` on open/close, key handling inside |
| `public/js/fleetfmt.js` | import-free, DOM-free helpers used by both modules and Node tests: `fmtPos(view, harbors)`, `fmtTask(view)`, `fmtEta(unixS, nowS)`, `stateLabel(state)`, `chipClass(state)`, `decimate(route, n)`, `fitBounds(points, padFrac, minSpanDeg)` |
| `public/css/fleet.css` | styles for both (injected with a private `ensureCss(id, href)` like `public/js/market.js`) |
| `test/fleet-client.test.mjs` | Node tests of `fleetfmt.js` and `shared/fleet.js` formatting cases the UI relies on |

Both modules load like `market.js`: `import('./fleet.js').then((m) => { this.fleetUi = new m.FleetUi(this); }).catch(…)`,
same for `hq.js`; a module that fails to load costs only its feature.

### 12.2 Edits to existing client files

| File: function | Change |
|---|---|
| `main.js` constructor | the two dynamic imports above; `this.fleetShips = new Map()` |
| `main.js` `onMessage` | `case 'fleet': this.fleetUi?.onFleet(m.fleet); this.hq?.onFleet(m.fleet); break;` `case 'fleet_board': this.fleetUi?.onBoard(m); break;` |
| `main.js` `onYou` | `hard` also when `prev && prev.aboard !== you.aboard`; the mesh rebuild condition also when `prev?.aboard !== you.aboard`; on `switched`: `this.interior.active && this.interior.exit()`, ashore exit, `this.clearRoute()`, `this.autopilot = false`, `this.setWarp(1)` silently, telegraph to Stop, `this.fleetUi?.switchFade(you)`, and `if (you.docked) this.net.action('dock')` (fresh harbour sheet) |
| `main.js` `onSnap` | after the AI block: `this.syncFleet(m.fleet, !!m.fleetFull, now)` — a new method like `upsertAi` (labels §9.4, `owner === you.id` → "· yours"); on a full snapshot drop entries not in the list, otherwise drop only `at_sea` entries not seen |
| `main.js` `upsertOther` | when `o.vid !== p.vid` (the person switched ships): rebuild the mesh and reset `samples` (no glide across the map); label `"<name> — <vname>"` when `vname` |
| `main.js` `collisionOthers` | `for (const f of this.fleetShips.values()) { if (f.state === 'docked' || f.state === 'laid_up') continue; push(f, SHIP_CLASSES[f.cls] || f.mesh.userData); }` |
| `main.js` `bindInput` keydown | `if (k === 'o') return this.hq?.toggle();` next to the `'l'` line |
| `main.js` `drawRadar` / contacts | fleet ships as contacts like AI |
| `net.js` `sendState` | add `vid: this.vid` (set by `main.js onYou`: `this.net.vid = you.aboard`) |
| `hud.js` | `TABS` gains `'office'` (and `TAB_ALIAS.office/fleet/storage → 'office'`); `renderTab` `case 'office': html = this.app.fleetUi ? this.app.fleetUi.tabOffice(h, you) : ''; break;`; `sheetAction` `default: if (act.startsWith('fl')) return this.app.fleetUi?.sheetAction(act, el);`; `tabShipyard`/`shipCard`: the checkbox, net price and confirm texts from `fleetUi` (§9.3); `case 'ship'`/`'used'` send `tradeIn`, `sendHome`; `renderShips`: "Fleet ships" section (no Board/Trade/Convoy) |
| `hud.js` `updateTop` | `this.app.fleetUi?.updateChip(you)` |
| `chart.js` | `layers.fleet = true`; `draw()` → `if (this.layers.fleet) this.drawFleet();` (own fleet routes + markers from `app.fleetUi.last`, others from `app.fleetShips`); `hitShip` / `showShipPopup` for fleet entries |
| `tugs.js` `onMessage` | the snap line also iterates `m.fleet || []` (`p.id` = vessel id as the tug owner) |
| `ashore.js` | at the home harbour (`app.you.home === entry id`), the harbourmaster door's label reads "Harbourmaster & your office" and opens tab `'office'` |

Not touched by Lane B: `public/index.html`, `public/css/style.css` (runtime DOM and its own CSS), any `server/*`,
`shared/*`.

---

## 13. Lanes, frozen interface, timing

### 13.1 Ownership (disjoint)

| Lane | Owns (creates or edits) | Reads only |
|---|---|---|
| **A — server model, captains, persistence, tests** | `shared/fleet.js`, `server/vessel.js`, `server/fleet.js`, `server/captain.js`, `server/game.js` (§11.2 only), `server/tugassist.js` (one line), `server.js` (two lines), `.gitignore` (one line), `test/fleet-shared.test.mjs`, `test/fleet-model.test.mjs`, `test/fleet-buy.test.mjs`, `test/fleet-office.test.mjs`, `test/fleet-switch.test.mjs`, `test/fleet-captain.test.mjs`, `test/fleet-perf.test.mjs`, `docs/fixtures/fleet.sample.json` | everything else |
| **B — client office, HQ, switching UI, browser scenarios** | `public/js/fleet.js`, `public/js/hq.js`, `public/js/fleetfmt.js`, `public/css/fleet.css`, `public/js/main.js`, `public/js/hud.js`, `public/js/chart.js`, `public/js/net.js`, `public/js/tugs.js`, `public/js/ashore.js` (§12.2 only), `test/fleet-client.test.mjs`, browser scripts outside the repo in the scratchpad `pw/fleet-*.mjs` | `shared/fleet.js`, the fixture, everything else |
| integrator / reviewers | `docs/STATUS.md`, `docs/ARCHITECTURE.md` (v6 fleet addendum), the release note | all |

### 13.2 The frozen interface

1. `shared/fleet.js` (§4) — exact code.
2. Message and action shapes (§10), `VesselView`/`FleetView`/`FleetPublic` field names and meanings.
3. `docs/fixtures/fleet.sample.json` — Lane A writes it on day 1 from the test (§10.3); Lane B builds against it with
   `?fixture=fleet` until Lane A's server is in. If Lane A must add a field, it may (additive only); renaming or removing
   needs both lanes and an update here.

### 13.3 Timing

| Phase | When | What |
|---|---|---|
| A | now | **new files only**: Lane A `shared/fleet.js` (first, verbatim), `server/vessel.js`, `server/fleet.js`, `server/captain.js` and the tests that need no `game.js` hook (shared, vessel view on a plain object, ledger, order validation, `freeBerth`/`holdSpot` with fakes); Lane B `fleet.js`, `hq.js`, `fleetfmt.js`, `fleet.css`, `test/fleet-client.test.mjs`, against the fixture |
| B | after the two agents now editing `server/game.js`, `server/economy.js`, `server/harbors*.js`, `server/world.js`, `server/harborgeom.js` have merged and `npm test` is green | Lane A: the §11.2/§11.3 edits in one pass, then the game-level tests; Lane B: the §12.2 edits (only client files, so it may run in parallel with Lane A's phase B) |
| C | both merged, `npm test` green | browser scenarios (§14.2), adversarial review against §16, fixes, integrator docs, state backup (§3.4), one push, one deploy |

---

## 14. Tests

General rules (as in V6-QUICK §1.1 and V7-BATCH1 §1.1): `node:test` + `node:assert/strict`, files `test/*.test.mjs`;
Game tests use `stateFile: '/nonexistent/saltline-fleet-<name>.json'`, stub `g.saveState = () => {}`, set `g.rnd = () =>
0.5`, drive `g.tick(…)`; copy helpers (`fakeSocket`, `join`, `mkBerth`, `fakeGeom`, `fakeTraffic` from
`test/game.test.mjs`; `atSea` from `test/jobs.test.mjs`), never import across test files. Captain tests pass either
`routePlanner: new RoutePlanner({ world, graph: buildGraph(world), inline: true })` or a fake `{ plan: async (from, to)
=> ({ points: [[from.lat, from.lon], [to.lat, to.lon]], distM }) , full: () => false }` over open water; long voyages
use `fleet.advance(v, seconds)` (a test helper on `Fleet` that calls `captain.stepVessel` in 1-s steps) instead of
millions of `g.tick`s. **The whole existing suite passes unchanged** (the accessor design keeps `p.ship`, `p.money`,
old-format state files and `saveState` round trips working); if a test must change, Lane A names it in its report with
the reason.

### 14.1 Unit and game tests (Lane A) with expected numbers

**`test/fleet-shared.test.mjs`** — every reference number of §4; `normalizeOrder`: unknown type, `sail_to` to an
unknown harbour, `hold` with NaN, `route` with 0 / 251 points, a `{lat, lon}` waypoint form, `contract` with
`jobId: '<script>'` → refusals with the texts of §4; `accrueWage` remainder after 7 × 100 ms at 60,000 mcr/h is
`42,000,000`; `totals` over a two-day book with `ships` kept apart; `stateOf` for the four states.

**`test/fleet-model.test.mjs`**
1. New player: `p.fleet.length === 1`, `VESSEL_ID_RE.test(p.aboard)`, `p.vessel === p.fleet[0]`, `p.ship ===
   p.fleet[0].ship`, `p.office.home === 'rotterdam'`, `slots 3`, `p.fleet[0].name === 'Sea Bee'`;
   `Object.keys(p)` contains none of `VESSEL_KEYS`; `JSON.parse(JSON.stringify(p)).fleet[0].ship.cls === 'coaster'`.
2. The old v0.3 state file of `test/game.test.mjs` (player `p1`, docked Rotterdam, money 1000): loads with
   `p.aboard === 'vp1'`, `fleet.length 1`, cargo/fuel/cond equal the file's, `office.home 'rotterdam'`; saved and loaded
   again: identical ids, no person-level `ship` key in the file.
3. v6 round trip: 3 vessels (aboard trawler at sea, coaster docked at Rotterdam, laid-up pilot boat) → save → load:
   `p.aboard` and `p.ship.cls === 'trawler'`, laid-up status kept, `storagePaidTo` shifted by the downtime (savedAt set
   2 h back in the file → +7,200 s ± 2).
4. Healing: a v6 record with `aboard` pointing at a laid-up vessel → aboard = first active; a duplicate vessel id →
   fresh id; 10 vessels → 8; a laid-up vessel away from home → active.
5. Ledger: `book` throws on 1.5, 0, NaN and an unknown category; `charge` with cash 30 and amount 50 → cash 0,
   `owed 20`; next income of 100 (actor money set) → after one tick owed 0, cash 80, `arrears −20` on the day.
6. Drift booking: the aboard ship earns 9,000 through `payJob` and spends 538 in dues → today's book for her: `income
   9000`, `costs −538` (whole credits).
7. Writes `docs/fixtures/fleet.sample.json` (§10.3) and checks it has every `VesselView` key.

**`test/fleet-buy.test.mjs`** (Rotterdam, `p.money = 200000`)
1. `buy_ship { cls: 'trawler', tradeIn: false }` → `p.money === 20000`, fleet 2, the new vessel docked `rotterdam`,
   `cls 'trawler'`, `cond 100`, `fuel 10`, `name 'Kittiwake'`, aboard unchanged (`p.ship.cls === 'coaster'`); book:
   `ships −180000`.
2. `buy_ship { cls: 'trawler' }` (no field) → today's trade-in: `p.money === 200000 − 180000 + 0` (coaster trade-in 0),
   fleet 1, `p.ship.cls === 'trawler'`.
3. `buy_used { listingId, tradeIn: false }` → money − listing price; listing gone from `st.used`; vessel `cond` =
   listing `cond`.
4. Fleet of 8 → `buy_ship … tradeIn: false` refused "Your fleet is full (8 ships). Sell or trade in a ship first.",
   money unchanged.
5. `owed > 0` → refused.
6. With a fake geometry of two fitting berths, both taken by the aboard ship and one fleet ship → the third purchase
   lies at a lay-by spot (`berth null`, `spotProblem(...) === null`).
7. `fleet_sell` the trawler (cond 100, docked at home) → `+99000`, vessel gone, `lost[0].how 'sold'`; the aboard ship
   → refused; with 5 t of grain aboard → refused; the coaster (not aboard) → `+0`, `how 'scrapped'`; a trawler moored
   2 days and 1 hour at IJmuiden → berth fee `3 × 18 = 54` (`berthFeePerDay('trawler') = round(900 × 0.02) = 18`,
   started days) charged first.

**`test/fleet-office.test.mjs`**
1. Lay up the coaster at Rotterdam (not aboard, empty) → `laidup`; `storagePaidTo` set 3 days back → after `fleet.daily`
   cash −96 exactly, `storage −96` booked; a 4th lay-up with 3 slots → refused with the slot text; `fleet_slot` →
   −40,000, `slots 4`.
2. Lay up at IJmuiden → "Lay up only at your home harbour, Rotterdam."; with cargo → refused; with a job → refused.
3. Recommission coaster → −240; trawler → −360.
4. Home: docked at Hamburg (major) → first move free, `home 'hamburg'`; a second move 2 days later → refused with
   "next move possible in 5 days"; 8 days later → −25,000; a `minor` harbour → refused; a laid-up ship at the old home →
   refused.
5. Berth fee at home is 0 on `undock` for the aboard ship and for a fleet ship; at IJmuiden 1 day for a coaster = 64.
6. Rename: `'  Grey   Gull '` → `'Grey Gull'`; `'X'`, a 25-char name, `'<b>'` and a duplicate (case-insensitive) → refused.
7. Transfer 100 t grain aboard coaster → docked trawler (300 t hold): exact stacks; 400 t → refused (hold); trawler at
   IJmuiden → refused (not the same harbour); contract cargo via `fleet_transfer` → refused; `fleet_move_job` moves the
   freight job and its 100 t stack, `dueShip` rebased by the clocks' difference.

**`test/fleet-switch.test.mjs`**
1. Same harbour: `switch_ship` to the moored trawler → free, `p.aboard` changed, `p.ship.cls 'trawler'`, last `you` has
   `switched: true, correction: true`, `p.warp 1`; a second switch 5 s later → cooldown text; after 10 s allowed.
2. Remote: the trawler placed at sea exactly 100.000 km due west of the aboard ship → fee **450**, money −450, booked
   `fees −450` to the trawler.
3. Leaving at sea with no order and no route, 30 km off the coast → the old ship gets `hold`; after
   `fleet.advance(old, 600)` she is `anchored` or `holding` at a spot with `spotProblem(...) === null` (fake `depthLW`)
   and ≥ `separation(L)` from every other hull.
4. Leaving within 5 km of IJmuiden's anchor → `sail_to ijmuiden then moor`; leaving with `leave: { type: 'home' }` →
   `home`; leaving with a route of 3 waypoints → `route`.
5. Leaving with a tow on the line → `sail_to job.to`; with nets out and a fishing contract → `contract`.
6. Refusals: hailed; in the raft; aboard ship under tug assist; target under tug assist; target laid up; aboard ship
   flooding 0.6; another player's vessel id → "That is not your ship." (and the same id in `fleet_order`, `fleet_sell`,
   `fleet_rename`, `fleet_layup`, `fleet_transfer` → same refusal, nothing changed).
7. `state` with `vid` of the old ship after a switch → ignored (`p.ship` position unchanged, no rejection counted).

**`test/fleet-captain.test.mjs`**
1. Wages: a coaster under way for 3,600 one-second steps → `wages −60` exactly; anchored 3,600 s → `−20`; docked idle →
   0; towing → `−68`.
2. World time: owner aboard ship at 100× warp for 600 ticks of 0.1 s; a captained ship's `shipTime` advanced by exactly
   60 s (± 1e-6) and her fuel by her 1× burn.
3. `sail_to` over open water with the fake planner from 20 km off IJmuiden (no harbour map) → arrives, docked
   `ijmuiden` (legacy dock or pilot fallback), money change = −(dues 461) − wages posted (= the ledger's `wages` sum);
   every position sampled after each step has `world.depthAt + lowWater ≥ draft` or `landPenetration === 0`.
4. Freight end to end: `fleet_accept` a planted freight job (Rotterdam → IJmuiden, 100 t grain, pay 9,000) for the
   moored coaster with the inline planner → `fleet.advance` until docked at IJmuiden (≤ 8 h world) → cash `+9000 − 461
   − wages − tugs/port as booked` and the ledger's `income` for her today is 9,000; the job is gone; event "Delivered".
5. Fishing: a trawler with a 30 t fishing contract placed on the Dogger Bank with nets out → after 3,600 s of steps she
   holds 30 t ± 0.5 (30 t/h), hauls, sails for the contract port; speed while trawling stayed < 4 kn.
6. Supply: a PSV with a supply job 300 m off its platform → after 60 s paid, cargo gone.
7. Give way: two captained coasters on reciprocal courses 4 km apart on the same line → their distance never falls
   below `clearRadius(90) = 150 m` and both reach their destinations.
8. Weather: `weatherAt` stubbed to `storm 0.8` at the berth → `phase 'waiting'` with the gale text; stub cleared →
   departs after the next re-check (advance 600 s).
9. Fuel: 2 t aboard, route needs 18 t, cash 0 → `failed` with the fuel text; cash 50,000 → bunkered, cost =
   `round(t × fuelPrice)` booked `fuel`.
10. Fuel exhausted at sea → towed to the nearest harbour, cost `min(cash, 3000 + 2 × units)` booked `tugs`.
11. `cond` 19 at sea → order replaced by the nearest harbour.
12. Sinking: `flooding 1` → vessel gone, wreck with her cargo, `lost` entry `sunk`, the aboard ship untouched.
13. Owner `lastSeen` 8 days ago, a ship anchored with no order → she sails to the nearest harbour and moors.
14. Snapshot: owner B online 10 km from A's anchored trawler → B's snapshot `fleet` holds it with `owner 'Ann'`,
    `state 'anchored'` on a full snapshot; A's own aboard ship is never in anybody's `fleet` list; 70 fleet ships within
    40 km → 60 entries, moving ones first.
15. Tug assist by a captain into a harbour with the cached Rotterdam geometry (skip when `data/geom/rotterdam.*` is
    missing, the `haveRot` pattern): `tickTugs` keeps her op (not `startReturn`), she ends moored at a berth no other
    vessel holds.
16. Rate limit: 25 `fleet_rename` in one second → at most 20 applied; malformed payloads (`vesselId: 5`, `order: 'x'`,
    `qty: 'Infinity'`, `route` of 300 points) → warn events, no throw, no state change.

**`test/fleet-perf.test.mjs`** — 300 captained ships at sea in the Atlantic, one online player in Rotterdam: per tick at
most `ceil(300 / 10) + near` vessels stepped; mean `fleet.tick` over 200 ticks printed and `< 15 ms`.

**`test/fleet-client.test.mjs`** (Lane B) — `fmtPos` ("112 km NE of IJmuiden", "Moored at Rotterdam, Waalhaven 3",
"Laid up at Rotterdam"), `fmtEta` (today → "14:20 UTC", other day → "Thu 14:20 UTC", null → "—"), `fitBounds` with one
ship (min span 2°), `decimate` keeps first and last.

### 14.2 Browser scenarios (Lane B, Playwright, scratchpad `pw/fleet-*.mjs`)

Server: copy `data/` without `state.json` to the scratchpad `fleet-data/`, run `SALTLINE_DATA=<that dir>
SALTLINE_DEBUG=1 PORT=3221 node server.js` (ports 3220–3229 only), chromium with the swiftshader flags of the existing
`pw/*.mjs`; desktop 1440×900 and phone 390×844 (`hasTouch`). Each scenario collects page errors and console errors
(none allowed except the known tile-proxy noise).

| # | Scenario | Expected |
|---|---|---|
| S1 | New skipper at Rotterdam, `fleet_debug money 300000`, Shipyard | the trade-in box is unchecked; trawler card shows 180,000 cr; Buy → confirm text says "Your Coastal freighter stays yours" → header cash 120,000 cr; Office tab lists 2 ships; `app.fleetShips` has the trawler (docked) within 1 km and her mesh is in the scene |
| S2 | Office → trawler → Go aboard (free) | within 2 s `app.you.ship.cls === 'trawler'`, `app.you.aboard` changed, `app.cam.dist === camDistFor(45)`; the coaster now in `app.fleetShips`; I opens the trawler interior; no "Position corrected" event in the next 10 s |
| S3 | Lay up the coaster | card "Laid up · 32 cr/day", storage 1/3, 3D label ends "· laid up" |
| S4 | `fleet_debug place` the coaster at sea 100 km W; HQ (O) | the map shows both ships and home; the coaster card "At sea"; Take the helm shows the fee = `transferFee(distance)` and cash drops by it; the view jumps there; the trawler is listed docked |
| S5 | Back aboard the trawler at Rotterdam; give the coaster `sail_to ijmuiden`; `fleet_debug advance` 6 h | HQ log "Sea Bee: moored at IJmuiden …"; card "Moored at IJmuiden"; route line gone; Money tab costs > 0 for her today |
| S6 | Captain contract: Office at Rotterdam → trawler → Take a contract (board) → a freight/fishing job; advance until done | log "Delivered … +X cr"; cash increased by X minus the costs listed; Money tab today income ≥ X for her |
| S7 | Aboard at sea with an autopilot route, switch to a docked ship; dialog pre-selects "Continue the route" | the ship left keeps moving along the route (positions in `snap.fleet` change), arrives later (advance) |
| S8 | Two browsers, B 10 km from A's anchored ship | B sees "Sea Bee · Ann" in 3D and in the Ships list under "Fleet ships" without Board/Trade buttons; B collides with her hull (client resolver) instead of passing through |
| S9 | Phone 390×844 | HQ opens from the chip; bottom tabs; ship card buttons ≥ 44 px high; no horizontal scroll (`document.documentElement.scrollWidth ≤ 390`); the Office tab in the harbour sheet is usable; the switch dialog fits |
| S10 | Reload the page while aboard the trawler | comes back aboard the trawler, fleet intact, HQ money unchanged |

---

## 15. Compatibility and amendments

### 15.1 Wave 2 (`docs/V5-WAVE2-DESIGN.md`) — what changes there when it is built after v6

| # | Wave 2 item | Amendment |
|---|---|---|
| W1 | §4.2 `VESSEL_KEYS`, `bindVesselView`, actors | come from `server/vessel.js` (v6); `company.js` imports them; `VESSEL_KEYS` includes `voyageEnd`. `bindCompany` adds `company` and the `money` facade on top of `bindPlayer`. |
| W2 | §4.1 `Vessel` | gains `companyId` in migration; keeps `ownerId` (the person who commands). `orders`, `cap`, `pay.rem`, `laidUpAt`, `storagePaidTo`, `status` keep v6 meaning; wave 2's `pay.rate/ms` become derived from the crew roster. |
| W3 | §6.4 `migrateV1toV2` | reads `players[].fleet`, `aboard`, `office`: `company.fleet = fleet`, `company.home = office.home` (v6 homes are accepted even outside the founding-home list), `company.office.slots = office.slots`, `owed` → a `capital`-free negative opening line (`adjust`), `office.log` → alerts (info), `office.book` dropped. |
| W4 | §3.1 storage, recommission | numbers already identical (F8). |
| W5 | §3.1 move home 50,000, major/mega only | v6: first move free, then 25,000, regional and up; wave 2 may raise later moves but must keep existing homes. |
| W6 | §2.4.7 switching "same harbour only", D26 | superseded: v6 switches anywhere (F13); wave 2 adds crew checks (a ship below minimum crew cannot be boarded at sea). |
| W7 | §5.2 `berthed` message | replaced by v6 `snap.fleet` (it already holds moored and laid-up ships). |
| W8 | §4.3 wages | wave 2's crew wages replace `wageRateMcrH` for captained ships and convert the aboard ship's float wages (then updating `test/timemodel.test.mjs` and `test/warp.test.mjs` as its §9.5 says). |
| W9 | §8 extension points | built here: `controllerOf` = §7.1, actors, orders, fleet tick, HQ map; `work` (auto-pick contracts) stays for later. |
| W10 | `p.money` | stays the person's cash in v6; wave 2's facade moves it to `company.cash`; `fleet.book()` then calls `ledger.book()` with the same categories (`income` → `contract`/`trade_sale` by memo). |

### 15.2 v7 batch 1 (`docs/V7-BATCH1-CONTRACTS.md`)

- The v7 hook wrapper (`wrapAll`) must skip handlers for actors: first line of `v7advised`:
  `if (args[0] && args[0].isActor) return orig(...args);` — so DOCK, PASSPORT, ANCHOR and PILOT never score, stamp or
  anchor a captain. (Amendment to V7 §1.5's verbatim code.)
- ANCHOR's per-person `anchor` stays per person; a fleet ship at anchor uses the v6 captain phase, not v7's anchor
  physics. When v7 ANCHOR merges, `switch_ship` refuses while the aboard ship is anchored by v7 ("Weigh anchor first
  (Q)") — one before-advice line in ANCHOR's install.

### 15.3 Quick v6 (merged)

- TIME-MODEL: `advanceShipClock`/`shipRate` used as is for actors (rate 1). TIME-MODEL's tests are unchanged.
- WARP-HARBOUR: unchanged; fleet ships are not skippers for warp.
- AUTOPILOT-CHARTS: `RoutePlanner` reused through `game.routePlanner`; `/api/route` unchanged.
- WORLD-MARKET: unchanged.

### 15.4 The agents editing now

The OSM/harbour work in `server/game.js`, `economy.js`, `harbors*.js`, `world.js`, `harborgeom.js` merges first.
v6 edits only the `game.js` statements of §11.2 and reads the others; Lane A rebases its phase-B edits on the merged
tree and re-runs `npm test` before pushing.

---

## 16. Acceptance checklist (reviewer ticks each with evidence: test name, screenshot or log line)

**Model and save**
- [ ] A1 New players get a fleet of one ("Sea Bee"), home Rotterdam, 3 storage slots.
- [ ] A2 An old state file loads: the old ship is fleet ship #1 with its cargo, contracts, fuel, condition, clock; a second load is identical.
- [ ] A3 v6 save/load round trip keeps every vessel, the aboard ship, laid-up status, the office and the ledger.
- [ ] A4 No person-level `ship`/`cargo`/… key in the saved file; `fleetSchema: 1` present; pre-v6 backup step in the release note.
- [ ] A5 The whole existing `npm test` suite passes (count before/after reported), plus all `test/fleet-*.test.mjs`.

**Buying, selling, office**
- [ ] B1 Buying with the box off keeps the old ship; the new one is moored in this harbour with 25 % fuel; money exact.
- [ ] B2 Buying with the box on (or an old client without the field) trades in as before.
- [ ] B3 Fleet of 8 refuses; owed bills refuse.
- [ ] B4 Selling a fleet ship pays `shipValue`; the coaster is scrapped for 0; the aboard ship cannot be sold this way.
- [ ] B5 Lay up only at home, empty, within slots; storage fee per day exact; recommission fee exact; slots purchasable to 8.
- [ ] B6 Home move rules (free first, 25,000 later, 7 days, regional+, not with laid-up ships); no berth fee at home.
- [ ] B7 Cargo and contract transfer between ships in one harbour, with capacity checks and the clock rebased.
- [ ] B8 Laid-up and fleet ships are visible in the 3D home basin with their labels.

**Captains**
- [ ] C1 Orders sail_to / home / hold / route / contract / stop work and show their task, route and ETA in the HQ.
- [ ] C2 Routes are planned for the ship's draught; no sampled position on land or in water shallower than her draught.
- [ ] C3 Berthing through the real tugs where a harbour map exists; no two ships on one berth when a free one exists.
- [ ] C4 Freight, passengers, charter, fishing and supply contracts are delivered and paid; tows and contraband refused.
- [ ] C5 Wages, fuel, wear, dues, tugs and storage are charged in whole credits and appear per ship in the ledger.
- [ ] C6 Fleet ships run on world time; the owner's warp does not change their clocks or rates.
- [ ] C7 Captains wait for weather, refuse to sail below 30 % hull, abort to a harbour below 20 %, bunker when needed, call a tow when the tanks are empty, keep clear of other hulls.
- [ ] C8 A ship left at sea without orders holds at a safe spot (express-passage rule) — never drifts.
- [ ] C9 A sinking fleet ship leaves a wreck and a log line; the person is unaffected.

**Switching**
- [ ] D1 Same-harbour swap is free and instant; remote switch charges the transfer fee; cooldown 10 s.
- [ ] D2 Every refusal of §8.1 fires with its text; ownership is checked on every fleet action.
- [ ] D3 Camera, HUD, helm, telegraph, interior and warp reset to the new ship; no position corrections after the switch.
- [ ] D4 The ship left keeps the chosen order (route, home, hold, fishing, tow finish).
- [ ] D5 Other players see the switch without a glide across the map.

**HQ and multiplayer**
- [ ] E1 O and the chip open the HQ; map with all own ships, routes and ETAs; cards with position, task, cargo, fuel, condition, profit.
- [ ] E2 Money tab: cash, owed, today and 7 days per ship and in total, ships bought/sold apart; numbers equal the server ledger.
- [ ] E3 Office tab and the harbour-sheet Office tab; ashore "Harbourmaster & your office" at home.
- [ ] E4 Phone 390×844: usable, no horizontal scroll, buttons ≥ 44 px.
- [ ] E5 Other players see fleet ships with "<ship> · <owner>", collide with them, cannot board or trade with them.

**Performance and security**
- [ ] F1 `fleet-perf` figure reported (target ≤ 4 ms per tick at 1,000 far ships); snapshot per socket ≤ 60 fleet entries.
- [ ] F2 Rate limits; malformed payloads never throw; debug actions absent without `SALTLINE_DEBUG=1`.
- [ ] F3 `fleet` messages go only to the owner; `FleetPublic` has no cargo, money or contracts.

---

## 17. Defaults chosen for open questions, and what is deferred

| Question | Default built |
|---|---|
| "Swap only in the same harbour, or switch view anywhere?" | **Both in one:** going aboard works anywhere; free in the same harbour (or within 2 km), else a transfer fee capped at 5,000 cr. |
| A camera-only "watch" of a ship without taking the helm | **Deferred** (v6.1): the HQ map shows every ship; taking the helm gives the 3D view. |
| Trade-in default | **Off** in the UI; the server's default for old clients stays "trade in". |
| Where a bought ship is delivered | **In the yard's harbour**; "then send her home" is one tick box (the captain sails her for real). |
| Captain wages | crew cost of the class (as when you sail) + captain 20 cr/h (12 under 30 m); only while on duty. |
| Max ships / storage | 8 ships; 3 free storage places, 40,000 cr each up to 8. |
| Home harbour | Where you are at migration (if regional or bigger), else Rotterdam; first move free. |
| What captains may do | freight, passengers, charters, fishing, supply; finish a tow on the line; no new tows, no smuggling, no express. |
| Unpaid bills | carried as "owed" (no negative cash); no departures or purchases until paid. |
| The coaster's value | still 0 (scrap) until wave 2 prices her at 120,000. |

**Deferred (not in this release):** watch mode; standing "work" orders (captains pick contracts themselves); crew
market, captain skills, morale (wave 2); company name/colours, bank, loans, insurance (wave 2); captains doing tows and
express passages; fuel transfer between ships; selling ships to other players; fleet ships of offline owners showing on
the chart beyond 40 km for other players; v7 anchoring physics for fleet ships.
