# Saltline v6 — quick items: build contract (V6-PLAN items 4, 5, 6, 7)

Design contract, 2026-10-08. Covers the v6 items that need no company layer:

| § | Package | V6 item | One line |
|---|---|---|---|
| 2 | **WARP-HARBOUR** | 6 | Time warp up to 5× inside harbours (moored, under tugs, approaching, waiting); 20× and above stay open-water only. |
| 3 | **WORLD-MARKET** | 7 | `/api/market*` endpoints, hourly price history, a trade-route finder, and a full-screen World market sheet + chart heat-map layer. |
| 4 | **AUTOPILOT-CHARTS** | 4 (first step) | Every route is planned over water for the ship's draught at low water, with harbour patches and the Dover TSS; live re-planning; the autopilot slows for the harbour and hands over to berth guidance. |
| 5 | **TIME-MODEL** | 5 | A ship's clock per player, contract time as ship hours, feasible contracts with a per-ship estimate on every card, the ship clock on the HUD, exact per-tick accounting proven at 10 Hz. |

§1 is common ground for all four (rules, file ownership, the one shared helper module). §6 is the integration
plan. §7 lists the decisions the product owner should confirm; §8 the questions only the player can answer. Each
package can be built by one engineer in parallel with the others; the hook table in §1.3 says exactly which functions
each package may edit in shared files.

Revised 2026-10-08 12:30 UTC after a completeness and conflict review against the code (wave 1 included) and
docs/V5-WAVE2-DESIGN.md: wave-1 timing gate (§1.1, §6.1), the phone warp control (§2.5), `tradeQuote` (§3.3), the range
flag and limiter of the trade finder, storm re-planning (§4), the parked-ship clock and the merged tick line (§5),
test tolerances (§5.8), one shutdown block (§6.2).

---

## 1. Common ground

### 1.1 Rules for every package

- **Production runs Node 20.** Plain ESM, `node:` built-ins only (`fs`, `path`, `crypto`, `zlib`, `worker_threads`). No new
  npm dependency and no `node:sqlite`. Server persistence is a JSON file written to `<file>.tmp` and renamed (the
  `Game.saveState` pattern).
- **Client** is three.js r160 as plain ESM, no build step. Logic that tests must reach goes either in `shared/` (served at
  `/shared`, importable by Node and the browser) or in an import-free client module like `public/js/berthplan.js`
  (Node cannot resolve the browser's `/shared/…` paths).
- **Tests** are `node:test` + `node:assert/strict` files `test/*.test.mjs` (`npm test` picks new files up by the glob).
  Game tests construct `new Game(world, () => {}, { stateFile: '/nonexistent/…' })`, stub `g.saveState = () => {}`, set
  `g.rnd = () => 0.5` and drive the real tick `g.tick(0.1)`. Copy helpers (`fakeSocket`, `join`, `atSea`, `patchGeom`,
  `synthPatch`) from `test/warp.test.mjs` / `test/tugs.test.mjs`; never import from another test file. Tests that need the
  cached real harbour geometry skip when `data/geom/rotterdam.{json,bin}` is missing (the `haveRot` pattern in
  `test/tugs.test.mjs`).
- **Wave 1 is being built in this tree right now.** These files are **read-only** for all four packages:
  `shared/physics.js`, `shared/telegraph.js`, `public/js/telegraph.js`, `public/js/berthguide.js`, `public/js/berthplan.js`,
  `server/berthguide.js`, `server/tugpath.js`, `server/tugassist.js`, `public/js/tugs.js`, `public/js/interior.js`,
  `public/js/walker.js`, `public/js/shipplan.js`, `public/css/telegraph.css`, `public/css/berthguide.css`, and the wave-1
  tests `test/telegraph.test.mjs`, `test/berthguide.test.mjs`, `test/tugs.test.mjs`, `test/tugs-review.test.mjs`,
  `test/wave1-review.test.mjs`, `test/interior.test.mjs`, `test/interior-review.test.mjs` and any later `*-review` test of
  wave 1 (copy helpers out of them, never edit them). Use only the exports
  listed in §1.2. If one of them must change, ask the integrator.
- **Timing.** Wave 1 also edits shared files: at 12:03 UTC on 8 Oct its agents were still changing `server/game.js`,
  `server/tugassist.js`, `public/js/interior.js` and the tug tests (`public/js/main.js` 11:41, `public/js/hud.js` 10:22);
  the full suite was green then (220 of 220). So every package writes its **new files and new tests now**, and starts its
  edits to existing shared files (the hook table §1.3: `server/game.js`, `server/economy.js`, `server.js`,
  `shared/constants.js`, `shared/tide.js`, `public/js/main.js`, `hud.js`, `chart.js`, `jobs.js`, `.gitignore`) only after
  wave 1 is merged and `npm test` is green, rebased on that merge.
- **Never edit** `docs/*.md` other than through the integrator, `public/index.html` (all new DOM in this contract is
  created at runtime) or `public/css/style.css` (each package that needs CSS ships its own file). `ensureCss` in
  `public/js/telegraph.js` is a private four-line function, not an export: each package copies it into its own module
  with its own link id and href. This contract writes such a copy as `ensureCss(id, href)`.
- Player-facing text: plain English, numbers formatted like the rest of the HUD (`fmt`, `fmtDistance`, `fmtDur`).

### 1.2 Wave-1 APIs used (read-only)

| API | File | Used by | Contract relied on |
|---|---|---|---|
| `stepTugAssist(game, p, dt)` | server/tugassist.js | WARP | Clamps `dt` to 5 s, advances the assist op by `dt × op.rate`, rewrites `p.assist.until`; returns `false` when the player has no planned op. |
| `tugOp(game, pid)` | server/tugassist.js | TIME | Returns the op (or null); `op.rate` ≥ 1 is the op-clock compression (the assist is shown in ≤ 240 s real time). |
| `gridFromPatch(buf)`, `toXZ`, `toLL`, `inGrid`, `clearanceAt`, `bedAt`, `hullRule`, `route(grid, rule, from, to, opts)`, `TUGPATH` | server/tugpath.js | AUTOPILOT | Water-only A* on a harbour patch with clearance ≥ half beam + margin and bed ≤ tide − draught − 0.5 m. |
| `app.berthGuide.plan` `{ ok, pts, length, approachHdg }`, `app.berthGuide.info` `{ remaining, steer, adv: { maxKn, text }, planned }`, `app.berthGuide.wants(nb)` | public/js/berthguide.js | AUTOPILOT | The leading line to `you.nearBerth`, re-planned by the guide itself; `info.steer` is the course to steer (look-ahead 1.5 ship lengths), `info.adv.maxKn` the pilot's speed advice. |
| `speedAdvice(distM)` | public/js/berthplan.js | AUTOPILOT | `{maxKn, text}` bands 60 / 300 / 1000 / 2500 m. |
| `fuelBurnPerSimHour`, `wearPerSimHour` | shared/physics.js | TIME, MARKET, (rates.js) | Unchanged formulas. |
| `ORDERS`, `clampThrottle`, `orderLabel` | shared/telegraph.js | AUTOPILOT | Throttle −0.6 … 1. |

### 1.3 File ownership and hook points

New files belong to one package only. In shared files each package edits **only** the functions listed against it.
"+" = new code added inside that function; "→" = lines changed. Anything not listed here is out of bounds.

**server/game.js**

| Function / place | Package | Change |
|---|---|---|
| imports | all | each adds its own import line(s) only |
| `constructor` | TIME | + `this.routeTable = opts.routeTable \|\| null;` |
| `migratePlayer` | TIME | + ship clock, accepted-job migration, `warpRun = null` |
| `findOrCreatePlayer` | TIME | + `shipTime: this.simTime` on new players |
| `initHarbors`, `regenHarbor`, `jobEnv` | TIME | legacy board jobs dropped; expiry filter; `env.seaKm` |
| `privateState` | TIME | + `shipTime`, `shipRate`, `warpRun` (the existing `warpLimit` key stays; its value is WARP's) |
| `setDocked` | WARP | → no longer drops warp |
| `tow` | WARP + TIME | WARP: explicit `dropWarp` as the first statement after the hail check; TIME: one ship-clock line after `cost` |
| `impound`, `forcedReset`, `finishRescue` | WARP | + explicit `dropWarp(p, 'In harbour.', false)` before `setDocked` |
| `stepAssist` | WARP | → warp-scaled assist |
| `acceptJob`, `payJob`, `deliverOffshore`, `expressPassage` | TIME | ship-hour deadlines; express advances the clock |
| `tick` per-player loop | TIME | + `this.advanceShipClock(p, dt)` right after the `checkWarp` line; the fishing rate reads `catchRate`; the deadline line moves into `advanceShipClock` |
| warp section `warpOf` … `warpLimit` | WARP | new `harbourZone`, `capWarp`; changed `warpConditions`, `warpBlock`, `checkWarp`, `warpLimit`, the accept text in `setWarp` |
| `setVoyage`, `simulateOffline` | AUTOPILOT | route-following offline voyages |
| new methods `advanceShipClock`, `shipRate`, `migrateAcceptedJob` | TIME | |

**Other shared files**

| File | Package: functions |
|---|---|
| shared/constants.js | WARP: `WARP.HARBOR_MAX`, `WARP.HARBOR_PLAYER_M` (§2.3). Nobody else. |
| shared/tide.js | AUTOPILOT: appends `export function lowWaterAt(lat, lon)` (§4.3). Nobody else. |
| shared/rates.js (new) | Created verbatim from §1.5 by whichever package lands first; nobody changes it afterwards without the integrator. |
| server/economy.js | TIME: `generateJob`, `generateSmugglingJob`, `publicJob`, the local `hoursFor` (removed). MARKET: appends `TRADE` and `tradeQuote` at the end of the file, verbatim from §3.3 (if wave 2's W2-SERVER lands first it appends the same text; the merge is trivial). Nothing else. |
| server/searoute.js | AUTOPILOT only. Everyone else calls `planRoute` with the v2 options (§4.3). |
| server.js | AUTOPILOT: `/api/route` handler, `RoutePlanner` construction. MARKET: `/api/market*`, `RouteTable`, `PriceHistory`, the history interval, `routeTable` in the `new Game(…)` options. The shutdown handlers (`SIGINT`/`SIGTERM` and `uncaughtException`) are written once, exactly as in §6.2, by whichever of MARKET, AUTOPILOT or wave 2's W2-SERVER merges last; each earlier one adds only its own call. The final block is fixed in §6.2. |
| public/js/main.js | WARP: `stepWarp`, `setWarp`, `syncWarp`, first lines of `toggleAshore`. AUTOPILOT: constructor (`this.pilot`), `autopilotStep` (delegate), `routeToJob` (delegate), `toggleAutopilot`, `setRoute`, `clearRoute`, one call in `updateHud`. TIME: `onYou` (+1 line), new method `shipTimeNow()`. MARKET: constructor (dynamic import), one key line in `bindInput` (`l`), placed directly before `if (this.ashore?.active) return;` (wave 2's `o` key goes on the line after it). |
| public/js/hud.js | WARP: `updateWarp`, `stepWarp`. TIME: `updateTop` (clock part only), `deadline`, `deadlineSec`, `whyNot`, `jobCard`, `tabJobs`, `tabBoards`, `showJobs` (the `jobLeft` line), `sheetAction` case `'accept'`. MARKET: `tabMarket`, `anyOverlayOpen`, `transientOpen`, `closeOverlays`, `sheetAction` new case `'worldMarket'`. AUTOPILOT: `showVoyage`. |
| public/js/chart.js | AUTOPILOT: `sailRoute`, `clearRoute`, `routeStats`, `drawRoute`. MARKET: the `this.layers` object literal (+ `market: false`), one call in `draw()`, one call at the end of `showHarborPopup`. TIME: `jobRows`. |
| public/js/jobs.js | TIME only. |
| .gitignore | MARKET: + `data/market-history.json`. |
| public/css/ (new files) | WARP: `warpharbour.css`. MARKET: `market.css`. TIME: `timemodel.css`. |

### 1.4 Constants added

| Name | Value | Owner | File |
|---|---|---|---|
| `WARP.HARBOR_MAX` | 5 | WARP | shared/constants.js |
| `WARP.HARBOR_PLAYER_M` | 1500 | WARP | shared/constants.js |
| `RATES` | §1.5 | (shared) | shared/rates.js |
| `JOBTIME` | §5.4 | TIME | shared/jobtime.js |
| `ROUTE`, `PLANNER_VERSION` | §4.3 | AUTOPILOT | server/searoute.js |
| `PILOT` | §4.6 | AUTOPILOT | public/js/pilotcore.js |
| `MARKET` | §3.3 | MARKET | server/market.js |
| `TRADE` | §3.3 (`SPREAD 0`, `IMPACT false`, `STEPS 8`) | MARKET writes it; wave 2 changes the two values (V5-WAVE2 §3.10) | server/economy.js |

### 1.5 shared/rates.js — the shared rate helpers (verbatim)

TIME-MODEL, WORLD-MARKET and AUTOPILOT all need "service speed", "fuel at service speed" and "catch rate". This file is
written **exactly** as below by whichever package needs it first; if two packages both create it, the contents are
identical and the merge is trivial. Additions after that go through the integrator.

```js
// Realistic rates shared by contracts (shared/jobtime.js), the world market (server/market.js) and the autopilot.
// docs/V6-QUICK-CONTRACTS.md §1.5. Plain ESM, browser-safe, no DOM, no state.
import { SHIP_CLASSES } from './constants.js';
import { fuelBurnPerSimHour, wearPerSimHour } from './physics.js';

export const RATES = {
  SERVICE_THROTTLE: 0.8,  // service speed = 80 % throttle (the express passage already uses 0.8)
  FISH_T_PER_H: 10,       // nets: t/h = class fishRate × ground richness × this (was server/game.js FISH_RATE_T_PER_H)
  DETOUR: 1.25,           // sea km ≈ great-circle km × this when no planned distance is known
  KMH_PER_KN: 1.852,
  NOMINAL_WIND_MS: 8,     // wind used for wear estimates
};
const clamp01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0);
export function shipClass(cls) { return SHIP_CLASSES[cls] || SHIP_CLASSES.coaster; }
/** Service speed (kn): 80 % of max for engine ships, 60 % of hull speed for sailing yachts (at least the engine's auxKn);
 *  15 % less fully laden (the load term of shared/physics.js speedPenalty). */
export function serviceKn(cls, loadFrac = 0) {
  const C = shipClass(cls);
  const kn = C.sail ? Math.max(C.auxKn || 5, 0.6 * C.maxKn) : C.maxKn * RATES.SERVICE_THROTTLE;
  return kn * (1 - 0.15 * clamp01(loadFrac));
}
/** Nets: tonnes per hour of trawling for a class on a ground of `richness` (storm factor applied by the caller). */
export function catchRate(cls, richness = 1) { const C = SHIP_CLASSES[cls]; return C ? (C.fishRate || 0) * (Number(richness) || 0) * RATES.FISH_T_PER_H : 0; }
/** Hours to cover `km` at `kn`. */
export function kmHours(km, kn) { return kn > 0 && km >= 0 ? km / (kn * RATES.KMH_PER_KN) : Infinity; }
/** Fuel (t/h) at service throttle; sailing yachts sail (0). */
export function serviceBurnTph(cls, loadFrac = 0) { const C = shipClass(cls); return C.sail ? 0 : fuelBurnPerSimHour(C.id, RATES.SERVICE_THROTTLE, clamp01(loadFrac), 0, 100); }
/** Hull condition points lost per hour at service throttle in a nominal breeze. */
export function serviceWearPerH(cls) { return wearPerSimHour(RATES.SERVICE_THROTTLE, RATES.NOMINAL_WIND_MS, shipClass(cls).wearMul); }
```

Reference numbers (tests in §5.8 assert them): coaster `serviceKn` 11.2 kn empty, 9.52 kn full; trawler 9.6 kn empty;
coaster `catchRate` on the Southern Bight (richness 0.7) = 4.2 t/h, trawler on the Dogger Bank = 30 t/h; coaster
`serviceBurnTph` empty = 0.9 × (0.1 + 0.9 × 0.8³) = 0.5047 t/h.

---

## 2. WARP-HARBOUR (V6-PLAN item 6)

### 2.1 Goal, in the player's words

"I can fast-forward the slow part in harbour: creeping in to the berth at 4 knots, the tugs pushing me alongside, sitting
at the quay. Five times is the most I get inside a harbour, and everything still works — the berth line, the tugs, the
bumps against the quay. Out at sea 20×, 100× and 400× work as before; if I come back in at 100× it steps down to 5×
instead of stopping dead."

### 2.2 Behaviour

**Harbour zone** (new term). A ship is *in a harbour zone* when any of these holds, checked in this order:

| kind | condition |
|---|---|
| `moored` | `p.docked` |
| `tugs` | `p.assist` |
| `near` | within `WARP.HARBOR_RADIUS_M` (4000 m, unchanged value) of the nearest harbour **anchor** (`game.nearestHarbor`) |
| `patch` | `game.landPenetration(lat, lon) !== null` (a built 10 m harbour patch covers the position); the harbour is the nearest one |

**Levels.** Inside a harbour zone the highest level is `WARP.HARBOR_MAX` = 5. Outside, the v0.4 rules are unchanged
(≤ 20× without a route, land/shallows look-ahead above 5×, 20 km from other skippers, …). `WARP.HARBOR_RADIUS_M` changes
meaning: it used to forbid warp near a harbour; now it caps it at 5×.

**What still stops warp inside a harbour** (`warpConditions`, in this order — the first reason found is shown):

| State | Blocks warp | Ignored |
|---|---|---|
| any | offline; coast-guard hail; life raft (`p.rescue` or flooding ≥ 1) | |
| moored or under tugs | — (nothing else) | fuel, flooding, storm, other skippers |
| under way / stopped / anchored in the zone | out of fuel (unless a sailing yacht with sails set); flooding > `WARP.MAX_FLOODING`; another online skipper **under way** (not docked, not offline, not in a raft) within `WARP.HARBOR_PLAYER_M` = 1500 m; storm index > `WARP.MAX_STORM` | other skippers moored, or further than 1.5 km |
| open water | unchanged (other skippers within 20 km, storm, fuel, flooding) | |

**Entering a harbour zone while above 5×** steps the level **down to 5×** (`capWarp`), with the event
`Time warp 100× → 5×: Rotterdam (Maasvlakte) is 3.9 km away — 5× at most inside harbours.` It does not drop to 1×.
The route flag (`p.warpRouted`) is kept so the skipper can step back up after leaving the zone.

**What the ship does at 5× in harbour.**
- Moored: nothing aboard is consumed while docked (unchanged: the tick skips docked ships). The ship's clock runs 5×
  (TIME-MODEL: contract hours run 5× too). The tide, the market and the berth fee stay on the world clock.
- Under tugs: the tug op runs 5× faster (§2.4 `stepAssist`); the HUD countdown shows the real-time remaining.
- Under way: the client integrates `dt × 5` exactly as in open water (substeps ≤ 0.05 s sim time, keel check every
  substep); collision against the patch SDF (`resolveShip`) and ship–ship contacts work as at 1× (ship–ship is resolved up
  to 20×). **Damage is computed from the ship's speed in knots, not × warp, so a bump at 5× hurts exactly like at 1×.**
  Any counted contact (≥ `FEES.COLLISION_MIN_KN`) and any grounding still drop warp to 1× (unchanged rule).
- Berth guidance: unchanged; it re-plans on real time and distance, its speed advice is in knots.
- Casting off at 5× keeps 5× (`undock` does not touch warp).

**Teleports still drop to 1×**: call a tow, impound, forced reset, rescue landing, sinking — each calls `dropWarp`
explicitly now (they used to rely on `setDocked`).

**Going ashore** drops warp to 1× on the client (`'Going ashore — time warp off.'`): the skipper walking the quay must
not burn contract hours 5×.

### 2.3 Constants (shared/constants.js, `WARP`)

```js
  HARBOR_RADIUS_M: 4000,     // within this of a harbour anchor the cap is HARBOR_MAX (v0.4: no warp at all)
  HARBOR_MAX: 5,             // highest level inside a harbour zone: moored, under tugs, near an anchor, on a built patch
  HARBOR_PLAYER_M: 1500,     // in a harbour zone another skipper under way this close stops warp (open water: PLAYER_RADIUS_M)
```

Update the comment of `HARBOR_RADIUS_M` in place; add the two keys after it. `worldInfo().warp` carries them to the client
automatically.

### 2.4 Server API (server/game.js, warp section)

```js
/** null, or { harbor (HARBORS entry), distM (m to its anchor; 0 moored), kind: 'moored'|'tugs'|'near'|'patch' }. */
harbourZone(p)
/** Text for a zone: 'moored in Rotterdam (Maasvlakte)' | 'under tow by the Rotterdam (Maasvlakte) tugs' |
 *  'Rotterdam (Maasvlakte) is 3.0 km away' (dist1). */
zoneWhere(zone)
/** Step DOWN to `to` (never up): p.warp = to, startGrace(p, was), warn event `Time warp ${was}× → ${to}×: ${reason}`,
 *  sendYou. Returns true when it changed the level. p.warpRouted unchanged. */
capWarp(p, to, reason)
```

Changed:

```js
warpConditions(p)   // §2.2 table; returns a lower-case reason or null. New reason in a zone (under way):
                    // `${name} is ${dist1(d)} away — in harbour, warp needs ${km1(WARP.HARBOR_PLAYER_M)} km between you and other skippers under way.`
warpBlock(p, f, routed) {
  const why = this.warpConditions(p); if (why) return why;
  const zone = this.harbourZone(p);
  if (zone && f > WARP.HARBOR_MAX) return `${this.zoneWhere(zone)} — inside harbours time warp is limited to ${WARP.HARBOR_MAX}×.`;
  /* unchanged: route above MAX_NO_ROUTE, land/shallows ahead above LAND_CHECK_ABOVE */
}
checkWarp(p) {      // every tick while p.warp !== 1 (already called before the docked/assist `continue`s in tick)
  const f = this.warpOf(p); if (f <= 1) { p.warp = 1; return; }
  const cond = this.warpConditions(p); if (cond) return void this.dropWarp(p, capitalise(cond));
  const zone = this.harbourZone(p);
  if (zone && f > WARP.HARBOR_MAX) return void this.capWarp(p, WARP.HARBOR_MAX, `${this.zoneWhere(zone)} — ${WARP.HARBOR_MAX}× at most inside harbours.`);
  const why = this.warpBlock(p, f, !!p.warpRouted); if (why) this.dropWarp(p, capitalise(why));
}
warpLimit(p)        // { max, reason, routeAbove } as today; inside a zone:
                    // { max: 5, reason: 'Moored in Rotterdam (Maasvlakte) — 5× at most inside harbours.', routeAbove: 20,
                    //   harbour: { id, name, distM (rounded), kind } }
                    // The `harbour` key is OMITTED outside a zone (keeps today's deepEqual tests valid).
setWarp(p, m)       // logic unchanged; the accept text inside a zone is
                    // `Time warp 5× in Rotterdam (Maasvlakte): your ship's clock runs 5 times faster — fuel, wear, wages and
                    //  contract hours too. The tide and everything ashore stay in real time.`
setDocked(p, id, berth)   // the dropWarp line is removed; nothing else changes
```

Explicit drops (first statement before `setDocked`): `tow` (after the hail check), `impound`, `forcedReset`,
`finishRescue`: `this.dropWarp(p, 'In harbour.', false);` — the same reason text as before, so the existing
"a tow puts the ship in harbour" assertion keeps matching.

`stepAssist(p, dt)`:

```js
stepAssist(p, dt = 0.1) {
  const w = this.warpOf(p);
  if (p.assist?.opId && stepTugAssist(this, p, dt * w)) {           // planned path + visible tugs, w× faster
    if (p.assist && w > 1) { const now = Date.now(); p.assist.until = now + Math.max(0, p.assist.until - now) / w; }
    return;
  }
  if (w > 1 && p.assist) { const extra = dt * 1000 * (w - 1); p.assist.start -= extra; p.assist.until -= extra; } // legacy walk
  /* … the existing legacy body unchanged … */
}
```

(The legacy walk keeps its wall-clock fields so `test/game.test.mjs` can keep setting `p.assist.start/until`; shifting both
back by `extra` advances its progress `w` times faster.) `tickTugs` (tugs sailing home) stays at real time.

Message shapes: unchanged (`you.warp`, `you.warpLimit`, snapshot `players[].warp`); `warpLimit.harbour` is new and optional.

### 2.5 Client

**public/js/main.js**
- `stepWarp(dir)`: remove the `you.docked` refusal. When `dir > 0`, `you.warpLimit?.harbour` is set and the current level
  is ≥ `WARP.HARBOR_MAX` → `hud.event({ kind: 'warn', text: 'Inside harbours time warp is limited to 5×.' })`, return false.
- `setWarp(f, note)`: replace the `you.docked` refusal by the same harbour check (`f > WARP.HARBOR_MAX && you.warpLimit?.harbour`).
  The route requirement above 20× stays.
- `syncWarp(serverWarp, you)`: `let w = you?.rescue ? 1 : serverWarp;` (docked and assisted ships may be warped).
- `toggleAshore()`: first statement when going ashore: `if (this.warp > 1) this.setWarp(1, 'Going ashore — time warp off.');`
- `simulate()` is unchanged: docked → no simulation; assist → `followServer` (the server moves the ship 5× faster).

**public/js/hud.js**
- `updateWarp(you)`:
  - show the control when `you && !you.rescue && !interiorOn && !ashoreOn` (docked and under tugs included);
  - `lim = you.warpLimit`; `blocked = !!(you.hail || you.rescue || (you.fuelEmpty && !you.docked && !you.assist))`;
  - `warpUp.disabled = w >= L.at(-1) || blocked || (lim && w >= lim.max)`; `warpUp.title = lim?.reason || 'Faster (.)'`;
  - inside a zone the small label above the level (`#warpCtl .warpLevel small`) reads `Harbour` instead of `Warp` and the
    control gets class `harbour`;
  - **phones:** `public/css/style.css:757` has `body.touch.docked #warpCtl { display: none; }`, so without an override a
    moored phone player can never see the control. WARP ships **public/css/warpharbour.css** (link id `whCss`, injected by
    a private `ensureCss` copy on `updateWarp`'s first call) with `body.touch.docked #warpCtl:not(.hidden) { display: flex; }`,
    the `#warpCtl.harbour` look (amber border `rgba(242,177,52,.55)`, label colour `var(--accent-2)`), and
    `body.touch.docked #warpCtl { bottom: calc(var(--bar) + var(--sab) + 12px); }` (the touch helm sliders are hidden while
    moored, so the control sits just above the action bar instead of floating 266 px up);
  - banner text in a zone: moored → `Moored at 5× — the ship's clock (and contract hours) run 5×; the tide and the harbour stay real time.`;
    tugs → `Tugs at 5× — the tow runs 5× faster · ${m:ss} to go`; under way → `Harbour 5× — berth guidance, tugs and collisions work as normal` + the ETA part as today.
- `stepWarp(dir)`: remove the docked refusal (it delegates to `app.setWarp`).

### 2.6 Edge cases

| Case | Behaviour |
|---|---|
| 100× on a route, entering the 4 km circle | `capWarp` → 5×, route kept, autopilot keeps steering. |
| Moored at 5×, then cast off | stays 5×; zone rules (fuel, other skippers within 1.5 km, storm) apply from the next tick. |
| Moored at 5× and out of fuel | allowed; casting off with no fuel drops to 1× on the next tick ("out of fuel"). |
| Another skipper casts off from the next berth | they are under way within 1.5 km → your warp (under way) drops to 1×; if you are moored nothing happens. |
| Busy start harbour (Rotterdam) | moored skippers never block; only ones manoeuvring within 1.5 km. |
| Tug assist at 5× | the op runs `dt × 5` per tick; `stepTugAssist` clamps `dt` to 5 s, so even 400× could not over-step (but 400× is impossible here). |
| Legacy assist (no patch) at 5× | progress 5× via the start/until shift; ends with `moorAt` + `finishDock` exactly as before. |
| Hail while moored | impossible (cutters only hail ships at sea); a hail at sea drops warp as before. |
| Contact at 0.3 kn at 5× | below `COLLISION_MIN_KN`, no drop, no damage (fenders). |
| Sinking, express passage | unchanged (sink drops; express is refused while docked as before). |
| Reconnect / restart | always 1× (unchanged `resetWarp` / `migratePlayer`). |

### 2.7 Tests

New file **test/warp-harbour.test.mjs** (Rotterdam, `g.rnd = () => 0.5`):

1. *Moored:* a new player (docked at Rotterdam) — `set_warp 5` accepted; `set_warp 20` refused with
   `/refused: moored in Rotterdam \(Maasvlakte\) — inside harbours time warp is limited to 5×/`; `you.warpLimit` deepEquals
   `{ max: 5, reason: 'Moored in Rotterdam (Maasvlakte) — 5× at most inside harbours.', routeAbove: 20, harbour: { id: 'rotterdam', name: 'Rotterdam (Maasvlakte)', distM: 0, kind: 'moored' } }`.
   Fuel 0 while moored: 5× still accepted. A synthetic storm cell over the harbour: 5× still accepted.
2. *Cast off at 5× keeps 5×:* `undock` → `p.warp === 5`; 10 ticks in the zone → still 5.
3. *Approach cap:* ship 3 km west of the anchor (fake geom as in `test/warp.test.mjs`), heading 090: 5× accepted, 20×
   refused `/is 3\.0 km away — inside harbours time warp is limited to 5×/`. At 5 km: 20× accepted; move to 3.5 km, tick →
   `p.warp === 5`, event `/Time warp 20× → 5×: .* 5× at most inside harbours/`, `p.warpRouted` unchanged, and the movement
   budget keeps 20× for `GRACE_MS` (a 400 m / 2 s jump accepted).
4. *Built patch counts:* a fake geom whose `landPenetration` returns 0 at a point 5 km from the anchor → zone `patch`, 20× refused.
5. *Other skippers in the zone:* B under way 1.2 km away → A (under way, 3 km from the anchor) refused
   `/is 1\.2 km away — in harbour, warp needs 1\.5 km/`;
   B moored → accepted; B under way 1.8 km away → accepted; A moored while B under way 300 m away → accepted.
6. *Tugs at 5×* (the `synthPatch` + `patchGeom` harbour of `test/tugs.test.mjs`, copied): two identical games, coaster
   800 m from the berth, `tug_assist`; game A at 1×, game B at 5×. Tick both at 0.1 s until docked. Ticks(B) ×5 within ±15 %
   of ticks(A); both moored at the same berth; B's `you.assist.until − Date.now()` during the tow ≤ A's / 4.
7. *Legacy assist at 5×* (fake geom with berths, no patch): with `start/until` 45 s apart, ticks to completion at 5× ≈ 1/5 of 1×.
8. *Teleports drop to 1×:* tow, impound (contraband + no money), forced reset, rescue landing — each from 5× → `p.warp === 1`
   with an event `/In harbour/`.
9. *Contacts:* moored at 5× → no change; under way at 5× in the zone, `collision {speedKn: 1}` → 1× (`/Contact with the quay/`);
   damage equals the damage of the same report at 1×.
10. *Consumption while moored at 5×:* 600 ticks → fuel, cond, money unchanged.

Update **test/warp.test.mjs** (owned by this package for the duration):
- "refused when docked, under tugs, …": docked → 5× accepted, 20× refused `/limited to 5×/`; with the assist object → 5×
  accepted, 20× refused `/limited to 5×/`; the hail / raft / fuel / flooding lines stay.
- "refused within 4 km of a harbour anchor …": at 3 km → 5× accepted, 20× refused with the new text.
- "auto-drop near a harbour …": the harbour part expects the cap: `p.warp === 5`, event `/\(20× → 5×\)/` — write a
  `capped(re, from)` helper beside `dropped`. "5× is allowed close to land" stays. The tow line keeps `dropped(/In harbour/, 20)`.
- "you.warpLimit …": docked expectation → the moored object of test 1 above.

### 2.8 Browser checks

1. Desktop, start harbour: moored at Rotterdam, press `.` → the control reads `Harbour 5×`, banner "Moored at 5× …"; press
   `.` again → warn "Inside harbours time warp is limited to 5×." and the button is disabled with that tooltip.
2. Cast off at 5×, follow the berth line out: the ship moves visibly faster, the leading line keeps up, the telegraph and
   astern work; bump a quay deliberately at > 1 kn → "Time warp off (5× → 1×): Contact with the quay."
3. Request tugs, press `.` → tugs and ship move 5× faster, the assist countdown drops 5× faster, she is moored at the berth.
4. Sail out past 4 km, raise to 20×, then turn back: at 4 km the level steps to 5× with the event; it never shows 1× in between.
5. Phone (390 × 844, `body.touch`): the warp control is visible while moored (the `warpharbour.css` override beats
   `style.css:757`), sits above the action bar, is hidden again while the full-screen harbour sheet is open, and the
   banner does not cover the contract card.
6. Two browsers: skipper B manoeuvring within 1.5 km stops A's harbour warp with the reason; B moored does not.

---

## 3. WORLD-MARKET (V6-PLAN item 7)

### 3.1 Goal, in the player's words

"One screen shows what every harbour pays and asks for every good, how much it has, and how the price moved this week.
On the chart I can colour the harbours by the price of one good. And it tells me which trade pays best for MY ship —
hold, fuel at service speed, port dues, pilotage, the real sea distance — and lays the route when I tap Plan."

### 3.2 Data model facts (existing, do not change)

- Per harbour `game.harbors[id]`: `stock[g]`, `target[g]` (t), `market[g]` (cr/t) for every `MARKET_GOODS` good (fish,
  grain, steel, machinery, containers, fuel, supplies — 7 goods; 86 harbours → 602 series).
- `market[g] = priceOf(h, g, stock, target) = base × localProfile × clamp(0.55, 1.9, √(target/stock))`, refreshed by
  `refreshPrices` on every trade and by `driftMarkets` once a minute; stock drifts `ECON.DRIFT_PER_H` = 5 %/h toward target.
- **Buy and sell use the same price today**, and a whole `buy_goods`/`sell_goods` action executes at the pre-trade price
  (`tradeGoods`). The API below carries `buy` and `sell` separately and reads every price through **one function,
  `tradeQuote` (§3.3)**, whose defaults reproduce today's rule exactly. With today's rule a full coaster hold earns
  ~175,000 cr on one good trade (~7,200 cr per ship hour, 7.5× a full freight contract), which makes wave 2's bank and
  crew costs meaningless; wave 2 therefore switches on price impact and a 1 % spread by changing the two `TRADE` values
  (V5-WAVE2 §3.10), and `tradeGoods`, the snapshot and the finder all follow without further edits. See §7 and §8.
- Bunker price at the fuel dock is `game.fuelPrice(h)` = `market.fuel × h.fuelMul` (the `fuel` market good is cargo).

### 3.3 Server: new file server/market.js

```js
export const MARKET = {
  SAMPLE_S: 3600,        // price history: one sample per harbour × good every hour (on the hour)
  KEEP: 168,             // … kept 7 days (ring); ~0.5 MB JSON for 602 series
  SNAPSHOT_MS: 5000,     // /api/market is cached this long
  ROUTES_LIMIT: 20, ROUTES_LIMIT_MAX: 50,
  BERTH_DAYS: 1,         // berth fee days counted at the destination
};
export function marketSnapshot(game) → Snapshot                 // pure read of game.harbors; never mutates
export function expectedStockAfter(st, good, hours) → t          // deterministic part of driftEconomy
export function expectedPriceAfter(harbor, st, good, hours) → cr/t // priceOf(harbor, good, expectedStockAfter(…), target)
export function findTrades(game, routeTable, q) → TradesResult   // pure given its inputs
export function parseRoutesQuery(query) → { ok: true, q } | { ok: false, error }
export class PriceHistory { … }                                   // below
```

`expectedStockAfter(st, g, h) = t + (s − t) × (1 − ECON.DRIFT_PER_H)^h` (s = stock now, t = target; noise ignored).

**`tradeQuote` — appended to server/economy.js verbatim** (by MARKET, or by wave 2's W2-SERVER if it lands first; the
two texts are identical). It is the only place that turns stock into a trade price; `findTrades`, `marketSnapshot` and,
from wave 2, `game.tradeGoods` call it.

```js
// docs/V6-QUICK-CONTRACTS.md §3.3: what a trade of `qty` t costs or pays. Defaults = the v0.4 rule (one price per good,
// the whole action at the pre-trade price). Wave 2 sets SPREAD 0.01 and IMPACT true (docs/V5-WAVE2-DESIGN.md §3.10).
export const TRADE = { SPREAD: 0, IMPACT: false, STEPS: 8 };
/** side 'buy' | 'sell'. Returns { unit (integer cr/t), total (integer cr) }. With IMPACT the unit price is the mean of the
 *  price at STEPS points spread over the stock change the trade causes (buying lowers the stock, selling raises it). */
export function tradeQuote(harbor, st, good, qty, side) {
  const q = Math.max(0, Number(qty) || 0), s0 = st.stock?.[good] ?? 0, t = st.target?.[good] ?? 1, dir = side === 'buy' ? -1 : 1;
  let mid = priceOf(harbor, good, s0, t);
  if (TRADE.IMPACT && q > 0) {
    let sum = 0;
    for (let k = 0; k < TRADE.STEPS; k++) sum += priceOf(harbor, good, Math.max(0, s0 + dir * q * (k + 0.5) / TRADE.STEPS), t);
    mid = sum / TRADE.STEPS;
  }
  const unit = Math.max(1, Math.round(mid * (side === 'buy' ? 1 + TRADE.SPREAD : 1 - TRADE.SPREAD)));
  return { unit, total: Math.round(unit * q) };
}
```

With the defaults `tradeQuote(h, st, g, q, side).unit === st.market[g]` for every q (both are `priceOf` at the current
stock). `total` is always an integer, also for fractional caught fish (wave 2's ledger only books integers).

**Snapshot** (`GET /api/market`):

```json
{ "time": 1791460000000, "simTime": 1791460000,
  "goods": [{ "id": "fish", "name": "Fish", "base": 700 }, …7],
  "harbors": [{ "id": "rotterdam", "name": "Rotterdam (Maasvlakte)", "country": "NL", "size": "mega", "lat": 51.98, "lon": 4.03,
                "anchor": { "lat": 51.9817, "lon": 4.0372 }, "fuel": 612,
                "goods": { "fish": { "buy": 655, "sell": 655, "stock": 2310, "target": 2500, "trend": 0 }, …7 } }, …86] }
```

`buy` = `tradeQuote(h, st, g, 1, 'buy').unit`, `sell` = `tradeQuote(h, st, g, 1, 'sell').unit` (integers, cr/t; equal to
`market[g]` while `TRADE.SPREAD` is 0), `stock`/`target` integers (t), `trend` = `marketTrend(st)[g]` (−1 / 0 / +1).
`anchor` from `game.harborAnchor(h)`. Cached for `SNAPSHOT_MS`.

**PriceHistory** (`data/market-history.json`):

```js
new PriceHistory({ file, log, keep = MARKET.KEEP, sampleS = MARKET.SAMPLE_S })
load()                         // missing → empty; corrupt / wrong shape → empty + one log line; never throws
save()                         // tmp + rename; never throws
maybeSample(game, nowS)        // samples when floor(nowS / sampleS) > the last sampled slot; returns true when it did
sample(game, nowS)             // appends slot time floor(nowS/sampleS)×sampleS and market[g] of every harbour × good, trims to keep, saves
forGood(good, days = 7)        // { good, sampleS, times: [s…], series: { harborId: [cr/t | null …] } }
forHarbor(id, days = 7)        // { harbor, sampleS, times, series: { good: [cr/t | null …] } }
```

File shape: `{ "v": 1, "sampleS": 3600, "times": [s…], "series": { "<harborId>": { "<good>": [int|null…] } } }`; every
series array has `times.length` entries (null = no sample for that slot, e.g. a harbour added later). Gaps from server
downtime stay gaps (the slot time is stored; nothing is invented). Load drops unknown harbours/goods and pads/trims
mismatched arrays. Sampling: server.js calls `maybeSample` once at start and every 60 s (so a sample lands within a minute
of each hour); saved after every sample and on SIGINT/SIGTERM.

**RouteTable** — new file **server/routetable.js** (harbour-to-harbour sea distances, also used by TIME-MODEL):

```js
export const ROUTE_TABLE = { VERSION: 1, SAVE_EVERY: 50 };
export function routesKey(extra = '') → hex          // FNV-1a over HARBORS (id, lat, lon), LANE_NODES, LANE_EDGES,
                                                     // carvingsForWorld(), PLANNER_VERSION (server/searoute.js, default 1) + extra
export class RouteTable {
  constructor({ harbors = HARBORS, plan = null, dir = path.join(DATA_DIR, 'cache'), log = () => {} })
  seaKm(a, b)      → km | null       // planned sea distance (unordered pair), null = not known yet or unreachable
  reachable(a, b)  → true | false | undefined
  estimateKm(a, b) → { km, est } | null   // planned km (est false) | great circle × RATES.DETOUR (est true) | null = known unreachable
  start()          // background warm-up: every unknown pair, nearest first, ONE plan call at a time, low priority
  stats()          → { pairs, known, unreachable, pending, building }
}
```

- `plan(fromHarbor, toHarbor, opts)` is injected and returns a Promise of a `planRoute` result (or null). In production it
  is `routePlanner.plan(a, b, { toHarbor: b.id }, { priority: 'low' })` (AUTOPILOT §4.4: runs in a worker thread). Without
  `plan` the table only answers from its file and `estimateKm` falls back to great circle × 1.25.
- Unordered pair key `"${min}|${max}"` (string compare); the plan is made from min to max with `toHarbor: max`.
  Stored km rounded to 0.1; `-1` = no route.
- File `data/cache/sea-routes-v1-<routesKey>.json` = `{ v, key, builtAt, pairs: { "a|b": km | -1 } }`, saved every
  `SAVE_EVERY` new pairs and when the warm-up completes. A different key (harbours, lanes, carvings or planner changed) →
  rebuilt from scratch.
- **Cost (measured on this tree, 2026-10-08):** world cache load 105 ms, lane graph 196 ms; Rotterdam → all 85 harbours
  7.5 s (median 8 ms, p90 371 ms, max 875 ms, 2 unreachable); random pairs 239 ms average (8 of 200 unreachable);
  sea/great-circle ratio median 1.17, p90 2.56, max 5.08. The full table (3,655 pairs) is ~15 min of one worker core,
  once; it must never run on the main thread.

**Trade finder** (`findTrades(game, routeTable, q)`), q from `parseRoutesQuery`:

| param | meaning | default / validation |
|---|---|---|
| `from` | harbour id or `all` | required; unknown → 400 |
| `cls` | ship class | required; must be a `SHIP_CLASSES` key |
| `hold` | free hold, t | `capacity`; 0 < hold ≤ capacity |
| `cash` | credits available for the purchase | Infinity; ≥ 0 |
| `good` | restrict to one market good | all `MARKET_GOODS` |
| `limit` | rows | 20, max 50 |
| `sort` | `tkm` (margin per tonne-km, default) \| `hour` (net per ship hour) \| `net` | `tkm` |

For every origin A (`from`, or every harbour for `all`), destination B ≠ A, good g with `stock_A ≥ 1`:

```
qty      = largest integer ≤ min(hold, stock_A) with tradeQuote(A, st_A, g, qty, 'buy').total ≤ cash
           (binary search, ≤ 14 steps; equals floor(min(hold, stock_A, cash / buy_A)) while TRADE.IMPACT is false;
            skip if qty < 1)
limitedBy = 'hold' | 'stock' | 'cash'                               (the term that set qty; ties → hold, stock, cash)
dist     = routeTable.estimateKm(A, B)                              (skip if null = unreachable)
load     = qty / capacity
kn       = serviceKn(cls, load)                    hours = kmHours(dist.km, kn)
fuelT    = serviceBurnTph(cls, load) × hours       fuelCr = fuelT × game.fuelPrice(A)
wagesCr  = C.crewCost × hours
wearCr   = serviceWearPerH(cls) × hours × repairCostFor(cls, 99)    (repair cost of one condition point)
duesCr   = portDues(cls, B)      pilotCr = pilotageFee(cls, B)      berthCr = berthFeePerDay(cls) × MARKET.BERTH_DAYS
buy      = tradeQuote(A, st_A, g, qty, 'buy')                       (unit and total for the whole hold)
sellNow  = sell_B (1 t quote)   stB' = { ...st_B, stock: { [g]: expectedStockAfter(st_B, g, hours) } }
sellQ    = tradeQuote(B, stB', g, qty, 'sell')                      sellArrive = sellQ.unit
revenue  = sellQ.total          cost = buy.total + fuelCr + wagesCr + wearCr + duesCr + pilotCr + berthCr
net      = revenue − cost                                            (skip if net ≤ 0)
perTkm   = net / (qty × dist.km)       perHour = net / (hours + 1)   (+1 h casting off and berthing)
bunker   = fuelT > 0.9 × C.fuelCap ? ceil(fuelT / (0.9 × C.fuelCap)) − 1 : 0   (bunkering stops needed on the way)
```

A row whose `bunker` > 0 is kept (the fuel is already costed) but carries `bunker: n`; the card says
`⚠ Beyond your range: about n bunkering stop(s) on the way` (the planner does not route via fuel docks yet). Without
this flag `from=all` happily offered a coaster (80 t, ~1,000 nm on a full tank) trades to Singapore.

`from=all`: the best row per origin, then the top `limit` overall (no positioning leg is charged; each row carries
`fromDistKm` from the request's `lat,lon` when given). Sorted by `sort` descending; ties by `net`.

**Trades result** (`GET /api/market/routes?…`):

```json
{ "time": 1791460000000, "from": "rotterdam", "cls": "coaster", "hold": 1200, "cash": 1000000,
  "assumptions": { "throttle": 0.8, "serviceKnEmpty": 11.2, "wageCrPerH": 40, "berthDays": 1, "pricing": "tradeQuote (spread 0, impact off); destination stock drifts toward normal while you sail", "spread": 0, "impact": false },
  "trades": [{ "good": "steel", "from": "rotterdam", "fromName": "Rotterdam (Maasvlakte)", "to": "hull", "toName": "Hull",
               "qty": 1200, "limitedBy": "hold", "buy": 846, "sellNow": 1012, "sellArrive": 1003, "distKm": 410.0, "distEst": false,
               "hours": 23.25, "fuelT": 16.4,
               "costs": { "goods": 1015200, "fuel": 10055, "wages": 930, "wear": 1703, "dues": 461, "pilotage": 0, "berth": 64 },
               "revenue": 1203600, "net": 175187, "netPerT": 146.0, "perTkm": 0.356, "perHour": 7224,
               "stockFrom": 9800, "stockTo": 4100, "targetTo": 5200, "bunker": 0 }] }
```

Illustration of the arithmetic only (prices and the 410 km sea distance invented — the great circle is 349 km; coaster
full: 9.52 kn → 23.25 h; fuel 0.7066 t/h × 23.25 h at 612 cr/t; wear 0.654 points/h × 112 cr/point; dues at a major port 3,200 t × 0.12 × 1.2). `limitedBy` is `hold`,
`stock` or `cash`. Rows with `net ≤ 0` are omitted. Test numbers come from fixtures (§3.7).

### 3.4 HTTP endpoints (server.js)

| Route | Answer | Errors |
|---|---|---|
| `GET /api/market` | Snapshot (§3.3) | — |
| `GET /api/market/history?good=<g>&days=<1..7>` | `history.forGood` | 400 unknown good |
| `GET /api/market/history?harbor=<id>&days=<1..7>` | `history.forHarbor` | 400 unknown harbour / neither param |
| `GET /api/market/routes?from=&cls=&hold=&cash=&good=&limit=&sort=&lat=&lon=` | Trades result (`from=all` scores ~51,000 origin × destination × good rows: the answer is cached 30 s per exact query string) | 400 `{error}` from `parseRoutesQuery`; 429 above 30 requests a minute per IP (the same in-memory limiter as `/api/route`, §4.5) |
| `GET /api/health` | + `market: { samples, routes: routeTable.stats() }` | — |

All `Cache-Control: no-cache` (the global middleware already does this for `/api/*` except tiles/charts).

### 3.5 Client: new files public/js/market.js + public/css/market.css

`public/js/main.js` constructor (one line, like `berthguide.js`):
`import('./market.js').then((m) => { this.market = new m.WorldMarket(this); }).catch((e) => console.warn('[market] unavailable', e));`
`bindInput`: before `if (this.ashore?.active) return;` add `if (k === 'l') return this.market?.toggle();`.

```js
export class WorldMarket {
  constructor(app)              // ensureCss('mkCss', 'css/market.css'); injects a "World market (L)" menuBtn into #moreSheet
                                // and a "Market" toolBtn into #chartTools (toggles the chart layer)
  toggle(); open(tab = 'prices'); close(); isOpen()
  refresh(force)                // GET /api/market (≤ every 60 s while the sheet or the chart layer is open)
  history(good)                 // GET /api/market/history?good= (cached 10 min per good)
  findTrades(opts)              // GET /api/market/routes with cls/hold/cash from app.you (hold = capacity − cargo mass, cash = money)
  planTrade(t)                  // §3.5.4
  drawLayer(chart, ctx)         // §3.5.3, called by chart.draw()
  popupRows(h, body)            // §3.5.3, called at the end of chart.showHarborPopup()
}
```

**3.5.1 The sheet** — a `<div id="marketWrap" class="sheet hidden">` built once on first open with the existing
`.sheetHead / .sheetMain / .sheetNav / .sheetBody` structure, so desktop gets the nav rail and phones (`body.touch`) the
bottom tabs for free. Head: icon `market`, title "World market", sub "86 harbours · 7 goods · updated 12 s ago", close
button (`data-close="marketWrap"`). Tabs: **Prices** · **Routes** · **Map** (Map opens the chart with the layer and closes
the sheet). hud.js: `anyOverlayOpen`, `transientOpen` and `closeOverlays` list `marketWrap` (Escape closes it); the
harbour Market tab header gets a `World market` button (`data-act="worldMarket"` → `app.market?.open('prices')`).

**3.5.2 Prices tab**
- Good chips (7, scrollable on phones) + "All goods"; a search box (harbour or country); a region toggle
  (North Sea detail region / world).
- Desktop table columns: Harbour · Country · Good · **Buy** · **Sell** · Stock (bar against "normal", label short / normal /
  glut as in `tabMarket`) · Trend (arrow) · **7-day sparkline** · Distance from you · actions (`Chart`, `Trades from here`).
  While every `buy === sell` the two price columns render as one "Price (buy = sell)" column; they split automatically
  when any harbour has a spread (wave 2 sets a 1 % spread, so from then on the player sees a buying and a selling price,
  as V6-PLAN item 7 asks). The Routes tab's cost lines name the impact: "1,200 t at 882 cr/t (the first tonne 846)".
- Sort: click a header (harbour A–Z, good, price, stock ratio, distance); one more click reverses; the sort is kept per
  session in `localStorage` (try/catch).
- One good selected: 86 rows. "All goods": 602 rows; sparklines render only for rows in view (`IntersectionObserver`).
- Sparkline: inline SVG 72 × 20 px, polyline of the history plus the live price as the last point, a dot at the end
  coloured by trend; `null` slots break the line; tooltip "7 days: low 612 · high 701 · now 655 cr/t".
- Phones (`body.touch` or width < 720 px): rows become cards (harbour, price big, stock bar, sparkline, chevron to the
  actions); sort is a `<select>`; no horizontal scroll at 390 px.

**3.5.3 Chart layer** — chart.js: `this.layers` gains `market: false`; `draw()` calls
`if (this.layers.market) this.app.market?.drawLayer(this, this.ctx);` right after `drawHarbors()`; `showHarborPopup`
ends with `this.app.market?.popupRows?.(h, body);`. `drawLayer` paints one disc per harbour in view (radius 5 / 7 / 9 /
11 px for minor / regional / major / mega) coloured by `r = price / median(price of that good over all harbours)` on a
diverging scale: r ≤ 0.8 teal `#2a9d8f` (cheap — buy here) → r = 1 grey `#9aa3ab` → r ≥ 1.25 orange `#f4a261` → r ≥ 1.5
red `#e76f51` (dear — sell here); the price is drawn next to the disc at zoom ≥ 6; a legend card bottom-left with the
good selector ("Fish · median 702 cr/t · cheap ← → dear"). `popupRows(h, body)` appends a table of the 7 goods with
buy / sell / stock and a "Trades from here" button.

**3.5.4 Routes tab and "plan this trade"**
- Origin: the docked harbour, else the nearest harbour (selectable); "Anywhere" = `from=all`. Sort toggle: per tonne-km
  (default) / per hour / total. Each card: good, A → B, qty (limited by hold / stock / cash — the limiting factor is
  named), buy → sell (now and expected on arrival), distance (`≈` when estimated), hours at service speed, a cost
  breakdown (goods, fuel, wages, wear, dues, pilotage, berth), net, per t·km, per hour.
- **Plan this trade**: `app.tradePlan = { good, from, to, qty, buy, sellArrive, net, createdAt }` (kept in `localStorage`);
  if docked at A → lay the route A → B; else lay the route to A first. Routing calls
  `app.pilot.planTo({ lat, lon, harbor })` (AUTOPILOT §4.6) and falls back to
  `app.routeToJob({ kind: 'harbor', lat, lon, job: { to: harbor } })` when `app.pilot` is absent. Event:
  `Plan: buy 1,200 t steel at Rotterdam (846 cr/t), sell at Hull ≈ 1,003 cr/t — net ≈ 175,000 cr. Route laid: 221 nm, ~23 h.`
  The harbour Market tab shows a "Planned: buy 1,200 t steel" chip on that good's card while docked at A, and
  "Planned: sell here" at B. Clearing: a ✕ on the chip.

### 3.6 Edge cases

| Case | Behaviour |
|---|---|
| Route table still warming | `distEst: true`, distance shown "≈ 341 km"; the row is kept. |
| Known unreachable pair | omitted. |
| Stock < 1 t at A | no row for that good. |
| Cash 0 | no rows; the tab says "No money to buy cargo". |
| Pilot boat / yachts (capacity ≤ 3 t) | rows exist but tiny; the tab hints "Your hold carries 2 t". |
| Same harbour | never A = B. |
| Contract cargo aboard | `hold` = capacity − all cargo (contract cargo occupies the hold). |
| History file missing / corrupt | empty history, sparklines show only the live price; log once. |
| New harbour added to HARBORS | its series start null-padded. |
| Server down 10 h | 10 missing slots stay missing; the sparkline shows the gap. |
| Wave 2 switches on impact and spread | only the two `TRADE` values change; `tradeGoods` (wave 2 makes it call `tradeQuote`), the snapshot and the finder follow. The Prices tab then shows Buy and Sell as two columns (§3.5.2). |
| Trade longer than the tank | row kept with `bunker: n` and the range warning; costs already include all the fuel. |
| Fractional caught fish sold | `tradeQuote(...).total` is rounded to whole credits. |

### 3.7 Tests — new file test/market.test.mjs

1. *Snapshot:* every harbour × every `MARKET_GOODS` good present; `buy === sell === st.market[g]`; stock/target/trend
   match `game.harbors`; `fuel === game.fuelPrice(h)`; a GET does not mutate `game.harbors` (deep-equal before/after).
2. *Expected price:* `expectedStockAfter` equals `driftEconomy` with `rnd = () => 0.5` (noise term zero) for 1, 6, 24 h
   within 1 t; `expectedPriceAfter` = `priceOf` of it.
3. *History sampling:* inject `nowS`; two calls in the same hour sample once; 200 hourly samples keep 168; `times` strictly
   increasing; a 10-hour gap leaves no invented slots; save → new instance load → identical; a corrupt file → empty
   history, no throw; an unknown harbour in the file is dropped; `forGood('fish', 1)` returns ≤ 24 slots.
4. *Trade maths* with a fake route table (`{ estimateKm: () => ({ km: 300, est: false }) }`) and crafted stocks: qty is
   min(hold, stock, cash / buy) — one case each; fuel, wages, wear, dues, pilotage, berth equal the economy functions
   (feeder at a mega port pays pilotage; coaster does not); `revenue` uses `sellArrive`; rows with net ≤ 0 are absent;
   `sort=tkm|hour|net` orders correctly; `limit` respected; `from=all` returns ≤ one row per origin.
5. *Unreachable / estimated:* `estimateKm → null` omits; `est: true` keeps the row with `distEst: true`.
6. *RouteTable:* with an injected synchronous-promise plan over 4 harbours: `start()` fills 6 pairs, stores -1 for a
   null plan, `seaKm` is symmetric, the file round-trips, a different `routesKey` ignores the old file, `estimateKm`
   before warm-up = great circle × 1.25 with `est: true`. A real `planRoute` for rotterdam|ijmuiden gives the same km.
7. *Query parsing:* missing `from`/`cls` → error; unknown good → error; `limit=500` → 50; `hold` above capacity → capacity.
8. *tradeQuote:* with the defaults, for every harbour × good and q ∈ {1, 100, 5000}, `unit === st.market[g]` and
   `total === unit × q`; `total` is an integer for q = 123.4. With `TRADE.IMPACT = true` (set and restored inside the
   test): a buy's unit price rises with q, a sell's falls, and q = 0 gives the 1 t price; with `SPREAD = 0.01`, buy > sell
   for the same stock. A crafted steel case (A: stock 9,800 / target 15,000; B: stock 4,100 / target 6,960; coaster 1,200 t)
   gives a net per ship hour under 2,000 with impact + 1 % spread and over 7,000 with the defaults (the balance numbers of
   V5-WAVE2 §3.10). The cash-limited quantity search returns the largest affordable integer.
9. *Range flag:* a coaster row whose `fuelT` is 1.5 × 0.9 × 80 t carries `bunker: 1`; a 100 t row carries `bunker: 0`.
10. *Limiter and cache:* the 31st request from one IP within a minute answers 429; two identical `from=all` queries
   within 30 s run `findTrades` once (spy on it).

### 3.8 Browser checks

1. Desktop: `L` opens the World market; Fish selected; sort by price both ways; Steel; "All goods" scrolls smoothly and
   sparklines appear as rows come into view; the sheet's age line updates.
2. Map tab: the chart opens with coloured harbour discs; legend shows the median; switching the good recolours; tapping a
   harbour shows the 7-good table in its popup.
3. Routes tab docked at Rotterdam with a coaster: rows explain the limiting factor ("limited by your 25,000 cr"); after
   buying the cash limit changes on refresh. Plan this trade → route on the chart, event line, chip in the harbour Market tab.
4. Phone 390 × 844 and 844 × 390: bottom tabs, card rows, no horizontal scroll, Escape/close works, the chart legend fits.
5. Restart the server: sparklines keep their history; `/api/health` shows `market.routes` progress.

---

## 4. AUTOPILOT-CHARTS (V6-PLAN item 4, first step)

### 4.1 Goal, in the player's words

"When I plot a route on the chart or press Route on a contract, the crew plans it over water deep enough for my ship at
low tide, round sandbanks, out of the harbour along the fairway and through the Dover Strait in the right lane. If
shallows show up ahead, or a storm lies across the route, the course is re-planned and I'm told. Coming in, the autopilot slows down and hands me over to the
berth line, stopping off the berth so I can moor or call the tugs. The crew sails the same planned route when I log off."

### 4.2 Planner rules

- **Draught.** A sample is deep enough when `depthLW ≥ draft + ukc`, `ukc = max(WARP.KEEL_MARGIN_M (2 m), 0.1 × draft)`
  and `depthLW = baseDepth + lowWaterAt(lat, lon)` (negative). `baseDepth` = the harbour patch bed (`−bedAt`) where a built
  patch covers the point, else `world.depthAt`. Planning with the same 2 m margin as the warp look-ahead means a planned
  route never trips the warp shallows check for its own draught.
- **Low water** = mean low water springs of the tide model: `lowWaterAt(lat, lon) = −1.33 × m2(region)` (M2 + S2
  amplitudes; Humber −3.06 m, Southern North Sea −1.06 m, Baltic −0.07 m, open ocean −1.06 m).
- **Sampling:** every `ROUTE.STEP_M` = 400 m outside patches; inside a patch every `ROUTE.PATCH_STEP_M` = 25 m, and there
  the clearance (`clearanceAt`) must also be ≥ half beam + 4 m.
- **End slack:** within `ROUTE.SLACK_M` = 3000 m of a route end that is a harbour **without** a built patch only water is
  checked (`world.isWater`), as in v1. Ends with a built patch need no slack (the patch is accurate).
- **Harbour exit:** when `from` lies on a built patch (`landPenetration !== null`, nearest harbour with a patch within
  3.5 km), the first segment is `tugpath.route(grid, hullRule({ beam, draft, tide: tide now, margin: 10 }), shipXZ,
  exitXZ, { radius: max(40, 0.9 L) })` to the **outer end of that harbour's fairway** (`geom.fairway.at(-1)`; the anchor
  when there is no fairway). No path with margin 10 → retry margin 4 → else a straight segment with warning
  `harbour_exit_unplanned`. The segment is reduced to ≤ 30 points (Douglas–Peucker, 5 m, every kept segment re-checked).
- **Harbour approach:** when `toHarbor` has a built patch, the open-water route ends at its fairway's outer end (the
  **approach point**, mark `approach`) — berth guidance takes over from there (§4.6). Without a patch it ends at `to` as
  today, with mark `approach` on the last point when `toHarbor` is given.
- **Graph:** v1's lane graph (`traffic.graph`: nodes, adj). v2 runs its own Dijkstra over `graph.adj` (lanes.js stays
  untouched) with (a) edges whose minimum `depthLW` is below the need removed — per-edge minimum depth sampled every
  `ROUTE.EDGE_STEP_M` = 1000 m once per graph and cached (harbour links skip their first/last 3 km, canal edges are
  never depth-checked); (b) TSS rules; (c) the v1 harbour-node penalty (60 km).
- **TSS (traffic separation schemes)** — new file **server/tss.js**:
  ```js
  export const TSS = [
    { id: 'dover', name: 'Dover Strait TSS', lanes: [
      { node: 'dover_tss_ne', flow: 45,  name: 'north-east-bound lane' },
      { node: 'dover_tss_sw', flow: 225, name: 'south-west-bound lane' } ] },
  ];
  export const TSS_RULE = { AGAINST_DEG: 120, RADIUS_M: 5000 };
  export function laneOf(nodeId) → lane | null
  export function edgeAllowed(graph, aId, bId) → boolean   // false when a or b is a lane node and |angleDiff(bearing(a→b), flow)| > 120°
  export function legViolates(a, b) → lane | null          // a straight leg passing within 5 km of a lane node against its flow
  ```
  Only the Dover pair has real lanes in `server/lanes.js`; the other `tss`-kind nodes are single junctions and get no
  direction ("where present"). Crossing at right angles stays allowed (|Δ| ≤ 120°). String-pulling never removes a lane
  node (like canal points) and no direct or pulled leg may `legViolates`. More schemes are data-only additions later.
- **Storm avoidance** (V6-PLAN item 4, "live re-planning when the route is blocked (… storm)"): `opts.avoid` is a list of
  at most `ROUTE.AVOID_MAX` = 8 discs `{ lat, lon, radiusM }`. Each disc is inflated by `ROUTE.AVOID_PAD` = 1.25 (storm
  cells drift 4–12 m/s). For this plan only, a direct leg, a lane edge or a string-pulled leg whose closest approach to a
  disc centre is under its inflated radius is not used; a route end inside a disc is allowed (you may be in the storm
  already). So that open water always offers a way round (the lane graph alone may not), each disc adds 8 temporary
  ring nodes at 1.35 × its inflated radius, on water only, linked to their ring neighbours and to the route ends and lane
  nodes within 150 km by water-checked legs that respect every disc; the Dijkstra runs over graph + ring nodes and
  string-pulling may drop ring nodes like any other. If nothing avoids the discs, plan again without them and add warning
  `storm_unavoidable`
  `{ text: 'No way round storm <name>' }`. The disc list comes from the client (it knows `snap.storms`); the server
  planner has no weather of its own.
- **No deep-enough route:** plan again water-only (draft 0) and return it with warning `no_draught_route`
  `{ depthM: shallowest depthLW on it, needM }` so the skipper sees "tidal passage" instead of no route at all.
- **User waypoints** (`wp`): planned leg by leg (ship → wp1 → … → to). A waypoint on land or in water too shallow is
  moved to the nearest deep-enough water within 2 km (`world.nearestWater` then outward rings) with warning `wp_moved`; if
  none, the leg is planned to the original point water-only with `no_draught_route`.
- **Output size:** ≤ `ROUTE.MAX_POINTS` = 250 points (the `set_warp` route limit).

### 4.3 server/searoute.js v2 (AUTOPILOT owns)

```js
export const PLANNER_VERSION = 2;
export const ROUTE = { STEP_M: 400, PATCH_STEP_M: 25, SLACK_M: 3000, EDGE_STEP_M: 1000, UKC_MIN_M: 2, UKC_FRAC: 0.1,
                       PATCH_MARGIN_M: 10, PATCH_MARGIN_MIN_M: 4, PATCH_CLEAR_M: 4, WP_SNAP_M: 2000, MAX_POINTS: 250,
                       AVOID_MAX: 8, AVOID_PAD: 1.25 };
export function landOnLeg(world, a, b, slackA, slackB)            // unchanged (v1 callers and tests)
export function planRoute(world, graph, from, to, opts = {}) → RouteV2 | null
// opts: { toHarbor = null, draft = 0, beam = 0, ukc = null, tss = true, wp = [], avoid = [], simTime = Date.now()/1000,
//         geom = null }   geom: { getHarborPatch(id), getHarborGeom(id), harborAnchor(id), landPenetration(lat, lon) }
//         avoid: [{ lat, lon, radiusM, name? }] ≤ ROUTE.AVOID_MAX (storm discs, §4.2)
export function parseRouteQuery(query) → { ok: true, from, to, toHarbor, cls, wp, avoid } | { ok: false, error }
```

Backward compatible: with `draft = 0` and no `geom`/`wp`, results equal v1 except that TSS lanes are respected
(`tss: false` restores v1 exactly). `RouteTable` (§3.3) calls it this way.

```ts
RouteV2 = {
  planner: 2,
  points: [[lat, lon], …],          // excluding the start, ≤ 250, rounded to 1e-6
  distM: number, via: 'direct' | 'lanes' | 'harbour' | 'mixed',
  legs: [{ from: number, to: number, distM: number, via: string }],   // one per requested leg; indices into points (from −1 = start)
  marks: [{ i: number, kind: 'patch_exit' | 'tss' | 'approach' | 'canal', name?: string, harbor?: string, flow?: number }],
  approach: { harbor: string, lat: number, lon: number } | null,
  draft: number, ukcM: number, minDepthM: number | null,             // shallowest depthLW sampled outside the slack
  warnings: [{ i: number, kind: 'no_draught_route' | 'wp_moved' | 'harbour_exit_unplanned' | 'storm_unavoidable', text: string, depthM?: number, needM?: number }],
}
```

shared/tide.js (append only): `export function lowWaterAt(lat, lon) { return -1.33 * regionOf(lat, lon).m2; }`.

### 4.4 Planning off the main thread — new files server/routeworker.js + server/routeworker-thread.js

A long route takes up to ~0.9 s of CPU (measured, §3.3); on the main thread that freezes the 10 Hz tick for everyone.

```js
export class RoutePlanner {
  constructor({ world, graph, geom, log, inline = false, timeoutMs = 8000, maxQueue = 50 })
  plan(from, to, opts = {}, { priority = 'high' } = {}) → Promise<RouteV2 | null>  // null on no route, timeout or worker error
  stats() → { queued, inFlight, done, failed, restarts, avgMs }
  close()
}
```

- `inline: true` (tests) calls `planRoute` synchronously and resolves.
- Otherwise one `Worker` runs `routeworker-thread.js`: it loads `new World().load(carvingsForWorld())` (the cached raster,
  ~40 MB more memory) and `buildGraph(world)` once, then answers messages one at a time.
- Main → worker `{ id, from, to, opts (no functions), ends: [{ id, patch: Uint8Array, fairway, anchor }] }` — the patch
  buffers and fairway of built harbours within 3.5 km of `from` and of `toHarbor` (copied; the worker caches by id + length).
  Worker → main `{ id, ok: true, result }` or `{ id, ok: false, error }`.
- Queue: high-priority requests (skippers) before low (route table); FIFO within a priority; `maxQueue` reached →
  `plan` resolves null with `stats().failed++` and `/api/route` answers 503.
- Timeout `timeoutMs` → resolve null, terminate and restart the worker; a crashed worker restarts after 1 s (at most once
  per 10 s; otherwise fall back to `inline` with a log line).

### 4.5 HTTP: `GET /api/route` (server.js, replaces the v1 handler)

`/api/route?from=lat,lon&to=lat,lon[&harbor=<id>][&cls=<class>][&wp=lat,lon;lat,lon;…][&avoid=lat,lon,radiusKm;…]`

- `cls` → `draft`/`beam` from `SHIP_CLASSES`; unknown class → 400; no `cls` → v1 behaviour (draft 0).
- `wp`: ≤ 50 points. `harbor` must be a harbour id when given. `avoid`: ≤ 8 discs, radius 1–600 km (else 400).
- 200 `RouteV2`; 400 `{ error }`; 404 `{ error: 'no sea route found' }`; 429 when one IP makes more than 30 requests a
  minute (in-memory Map, swept every minute); 503 `{ error: 'route planner busy' }`.

### 4.6 Client: new files public/js/autopilot.js + public/js/pilotcore.js

**pilotcore.js** — import-free, Node-testable (like `berthplan.js`):

```js
export const PILOT = {
  BANDS: [[1000, 4], [2500, 6], [5000, 10]],  // harbour speed limits: within m of the nearest anchor → max kn
  MIN_THR: 0.12,
  HANDOVER_M: 400,           // at max(this, 3 L) from the approach point → berth mode
  STOP_M: 120,               // berth mode stops at max(this, 1.5 L) from the berth
  LOOK_S: 90,                // look ahead this many REAL seconds of travel …
  LOOK_MIN_M: 1500, LOOK_MAX_M: 12000, LOOK_MAX_SAMPLES: 240, LOOK_STEP_M: 50,
  UKC_LIVE_M: 1.0,           // live check uses the current tide, so a smaller margin than planning
  OFF_ROUTE_M: 500,          // re-plan when further than max(this, 5 L) off the current leg
  REPLAN_MIN_MS: 20000, CHECK_MS: 1000,
  STORM_MIN: 0.6,            // storm cells at or above this intensity are avoided (= WARP.MAX_STORM, where warp stops)
  STORM_HORIZON_H: 6, STORM_HORIZON_MIN_M: 30000,   // look this far along the remaining route: max(30 km, 6 ship hours at SOG)
  STORM_REPLAN_MS: 600000,   // one storm re-plan per storm id per 10 minutes (real time)
};
export function speedCapKn(distAnchorM)                        → kn | Infinity
export function throttleCap(capKn, maxKn)                      → clamp(capKn / maxKn, MIN_THR, 1)   (Infinity → 1)
export function lookAheadM(spdKn, warp)                        → clamp(|spd| × 0.514444 × warp × LOOK_S, LOOK_MIN_M, LOOK_MAX_M)
export function firstShoal(ship, route, maxM, depthFn, needM)  → { distM, depthM, lat, lon } | null   // depthFn(lat, lon) → m | null (unknown: skipped)
export function offRouteM(ship, route)                         → m (cross-track distance to the leg ship → route[0])
export function shouldReplan(state, nowMs, { shoal, offM, L }) → boolean   // rate-limited, never while a plan is in flight
export function handoverStep({ remainingToApproachM, L, guideReady, guideRemainingM, mode }) → 'route' | 'berth' | 'stop'
export function stormOnRoute(ship, route, storms, { minIntensity = PILOT.STORM_MIN, horizonM }) → { storm, distM } | null
//   storms: app.storms ({ id, name, lat, lon, radiusKm, intensity }); the first storm, along the remaining route within
//   horizonM, whose disc (radiusKm × 1000) a leg passes through, and the route distance to where it does
```

Steady-state speed with `throttleCap` never exceeds the cap (the physics target is `throttle × maxKn × penalty ≤ cap`).

**autopilot.js**

```js
export class Autopilot {
  constructor(app)
  engage(on)                                        // P (main.toggleAutopilot delegates); remembers the skipper's order
  planTo({ lat, lon, harbor = null, label = '' })   // → Promise<{ ok, distM, warnings }>; job Route button, trade plans
  planVia(points, { label = 'chart route' } = {})   // chart "Sail route": user waypoints → wp=
  step(s, C)                                        // per simulation substep (main.autopilotStep delegates): steer + speed; false = finished
  update(nowMs)                                     // per HUD tick: look-ahead (every CHECK_MS), re-plan, handover state, notices
  clear()                                           // route cleared / docked / tugs / ashore
}
```

State on the app: `app.route` stays the single source of truth (array of `{ lat, lon }`; points may now carry
`mark` and `name` — `setRoute` keeps those two props; `set_warp` still sends lat/lon only). New `app.routeMeta =
{ v: 2, dest: { lat, lon, harbor }, distM, draft, warnings, plannedAt, label, via: [user waypoints] }` (null when the
route was not planned, e.g. a raw `setWaypoint`).

Planning: `GET /api/route` with `cls = app.you.ship.cls`, `from` = the ship, `harbor` for harbour targets, `wp` for chart
waypoints. On 200: `app.setRoute(points with marks)`, `app.routeMeta = …`, event
`Route planned for your 5.5 m draught: 184 nm via the Dover Strait (south-west-bound lane), 2 waypoints.` plus one line per
warning. On failure: keep the old route (or lay the straight legs as v1 did) and say so: `Route planner unreachable —
sailing straight legs. Watch the depth.`

Steering and speed in `step(s, C)` (every substep):
- **route mode** — steer for `route[0]` exactly as today's `autopilotStep` (rudder = angleDiff / 25, amidships going
  astern; reach radius max(300, 3 L), last max(200, 2 L)).
- **speed** — `cap = speedCapKn(distance to the nearest harbour anchor)`; in berth mode `min(cap, berthGuide.info.adv.maxKn)`.
  `app.input.throttleCmd = min(this.order, throttleCap(cap, C.maxKn))` where `this.order` is the skipper's last telegraph
  order (if `input.throttleCmd` differs from what the pilot wrote last time, the skipper changed it: adopt it as the new
  order). The telegraph widget therefore shows the pilot's reduced order. Turning the autopilot off leaves the throttle
  where it is (no surprise acceleration).
- **handover** — when the last route point is an `approach` mark and the ship is within `max(HANDOVER_M, 3 L)` of it:
  if `app.berthGuide?.plan?.ok` and `you.nearBerth?.fits` and the guide `wants` it → **berth mode**: rudder from
  `angleDiff(s.hdg, app.berthGuide.info.steer) / 25`, speed cap from the guide's advice; at
  `info.remaining ≤ max(STOP_M, 1.5 L)` → order STOP (throttle 0), autopilot off, route cleared, event
  `Off Berth 3: engines stopped — moor (T) under 2 kn, or call tugs (N).` Otherwise (no patch, no fitting berth) → at the
  approach point order STOP, autopilot off, event `Harbour approach reached off Hull — the autopilot stops here. Follow the
  berth guidance in or call tugs (N).`
- **leaving harbour** — no special mode: the bands cap the speed until 5 km out, then the skipper's order applies.

Live re-planning in `update(now)` every `CHECK_MS` while the autopilot steers a planned route:
`depthFn = (lat, lon) => { const h = app.terrain.heightAt(lat, lon); return h == null ? null : -h + app.tideLevel; }` (the
loaded terrain including harbour patches — what `keelCheck` uses), `need = draft + UKC_LIVE_M`, distance
`lookAheadM(spd, app.warp)`. A shoal ahead (not within the last 300 m of the destination) or `offRouteM > max(500, 5 L)`
→ `planTo(the same destination, harbour and remaining user waypoints)` (rate-limited by `shouldReplan`). On success:
event `Re-planned: shallows 3.2 m (you need 6.5 m) 1.4 km ahead — new route 42.1 nm (+1.3 nm).` and the chart's route
flashes for 2 s. If the new route still meets the shoal within 300 m, or planning fails while the shoal is under
1.5 × look-ahead → order STOP, autopilot off, alert `Autopilot stopped: shallows ahead and no way round found — take the
helm.` Warp drops follow from the existing client grounding / server look-ahead rules.

Storms, in the same `update(now)` pass: `stormOnRoute(ship, app.route, app.storms, { horizonM: max(STORM_HORIZON_MIN_M,
STORM_HORIZON_H × SOG m/h) })`. A hit not re-planned for that storm id within `STORM_REPLAN_MS` → `planTo(the same
destination, harbour and remaining user waypoints, avoid: every storm ≥ STORM_MIN within 1,000 km)`. On success: event
`Re-planned round storm Babet (61 nm ahead): new route 212 nm (+18 nm).`; with `storm_unavoidable` (or the ship already
inside the disc) the route is kept and the event says `Storm Babet lies across the route 34 nm ahead and there is no way
round — heave to, ride it out or turn back.` The autopilot keeps steering; inside the storm warp drops by the existing
storm rule. Storm re-plans share the `shouldReplan` rate limit with shoal re-plans.

**Hooks in main.js** (AUTOPILOT): `this.pilot = new Autopilot(this)` after `this.jobLayer`; `autopilotStep(s, C)` body →
`return this.pilot.step(s, C);`; `routeToJob(t)` → `this.pilot.planTo({ lat, lon (near edge of a bank as today), harbor })`;
`toggleAutopilot()` → `this.pilot.engage(!this.autopilot)`; `setRoute` keeps `mark`/`name`; `clearRoute` → also
`this.pilot.clear(); this.routeMeta = null;`; `updateHud` → `this.pilot.update(now)`.

**chart.js** (AUTOPILOT):
- `sailRoute()`: the editing buffer becomes the user waypoints: `const via = this.getRoute(); this.route = [];
  this.app.pilot ? this.app.pilot.planVia(via) : (old behaviour)`.
- `drawRoute()`: the planned route `app.route` solid green 2.5 px from the ship; `routeMeta.via` as numbered amber
  diamonds; `approach` mark as an anchor glyph with "berth guidance" at zoom ≥ 9; the TSS lane stretch as blue chevrons in
  the flow direction; warnings as red "!" markers with their text on hover/tap; the editing buffer (while plotting) as today.
- `routeStats()`: distance from `app.route` (planned), speed from SOG when under way else `serviceKn(cls, load)` (rates.js).
- `clearRoute()`: also clears the via markers.

**hud.js `showVoyage`** (AUTOPILOT): `2 wp · 184 nm · ETA 19 h 10 min · planned for 5.5 m · ⚠ 1 tidal leg`; "Set voyage"
sends the route (§4.7).

### 4.7 Offline voyages follow the route (server/game.js, AUTOPILOT)

- `setVoyage(p, m)`: new form `{ action: 'set_voyage', route: [[lat, lon], …] (validWarpRoute, ≤ 250), throttle, harbor? }`;
  legacy `{ lat, lon, throttle }` = a one-point route. Stored `p.voyage = { route, i: 0, throttle (0.1…1, default 0.7),
  harbor: id|null, setAt }`. A saved legacy voyage `{lat, lon}` is normalised on first use. Event:
  `Course laid in: 3 waypoints, 184 nm to the approach off Hull. The crew keeps sailing it while you are away.`
- `simulateOffline(p, dt)`: steer for `route[i]`; advance `i` within max(300, 3 L) (last: 400 m); throttle =
  `min(v.throttle, speed band of the nearest anchor / maxKn)` (same bands as `PILOT.BANDS`, duplicated server-side as a
  constant in game.js); the shoal stop is unchanged; at the end the log line names the harbour approach when `harbor` is
  set: `The crew reached the approach off Hull and stopped engines.`
- The client "Set voyage" button sends `{ route: app.route (lat/lon), throttle: current order or 0.7, harbor: routeMeta.dest.harbor }`.

### 4.8 Edge cases

| Case | Behaviour |
|---|---|
| Boxship (14 m) to Hull | Humber at MLWS has < 16 + ukc m → `no_draught_route` warning "tidal passage: 12.9 m at low water, you need 16 m"; the route is still laid. |
| Pilot boat (1.8 m) | almost every route is the v1 route. |
| Start not on a patch but inside an estuary | the coarse raster near coasts may read land → v1 end slack applies only for harbour ends without patches. |
| Ship already past the approach point | handover triggers at once (distance check uses the remaining route). |
| Berth guidance not loaded (module failed) | stop at the approach point and hand over. |
| Skipper presses A/D or Space | autopilot off (unchanged); throttle stays. |
| Skipper rings a new order while the pilot caps | the new order becomes `this.order`; the cap still applies inside 5 km. |
| Sailing yacht with sails set in harbour | throttle cap has no effect on sail power: event once `Furl the sails for the harbour approach — the autopilot cannot slow a ship under sail.` |
| Route request while the previous is in flight | the older answer is discarded (request sequence number). |
| Route cleared while re-planning | the answer is discarded. |
| Class changed (bought a ship) | `routeMeta` dropped; the next engage re-plans. |
| 400× on a planned route | the planner guarantees depth at the warp margin along every leg; legs turning near a cape may still trip the heading-based warp look-ahead (v0.4 behaviour, see §7). |
| Worker down | inline fallback (main thread) with a log line; tests always run inline. |
| Storm cell drifts back onto the new route | the next check re-plans again after `STORM_REPLAN_MS`; never more often. |
| Storm over the destination harbour | route ends inside the disc are allowed; the route is laid with the warning, no detour loop. |
| Storm cells vs real weather | `snap.storms` carries the game's storm cells (`game.storms`), which are drawn on the chart and avoided even where real Open-Meteo data drives the local wind (`weatherAt` uses the cells only without real data). Real gales have no cell, so they are not avoided; the warp storm rule still uses the local wind. |

### 4.9 Tests

New file **test/route-planner.test.mjs** (real world raster; `RoutePlanner({ inline: true })` unless stated):
1. *v1 compatibility:* `planRoute(world, graph, from, to, { toHarbor, tss: false })` for the three cases of the existing
   "sea routes" test equals the v1 `via`, points and `distM`. The existing test in `test/jobs.test.mjs` stays untouched and green.
2. *Draught invariant:* find two points programmatically — scan west from the Dutch coast at lat 52.20 and 52.80 for the
   first water sample with `world.depthAt` between 8 and 10 m. Pilot boat → `via: 'direct'`. Boxship → every 400 m sample
   of every leg (outside end slack) has `depthAt + lowWaterAt ≥ 14 + 2` **or** the result carries `no_draught_route`.
   For 5 random North-Sea harbour pairs × coaster the same invariant holds.
3. *TSS:* Rotterdam → Plymouth passes within 1 km of `dover_tss_sw` and not within 3 km of `dover_tss_ne`; Plymouth →
   Rotterdam the reverse; no leg of either `legViolates`; marks contain `{ kind: 'tss' }`; with `tss: false` the
   lane choice is free.
4. *Harbour patch ends* (skip without cached Rotterdam geometry; `harborgeom.init(world)` + `ensureHarbor('rotterdam')` from
   disk): from a Rotterdam berth for a coaster → the first segment's points all have `clearanceAt ≥ 7 + 4` and
   `bedAt ≤ tide − 5.5`; a `patch_exit` mark; to Rotterdam from 30 km out with `toHarbor` → the last point equals the
   fairway's outer end (±1 m) and `approach` is set.
5. *Waypoints:* `wp` with one point on land → moved to water (≤ 2 km) with `wp_moved`; `legs.length === wp.length + 1`.
6. *lowWaterAt:* Humber −3.06, Baltic −0.07, always ≤ 0.
7. *parseRouteQuery:* bad numbers, > 50 waypoints, more than 8 `avoid` discs, a radius outside 1–600 km, unknown class
   and unknown harbour → errors.
7a. *Storm avoidance:* `OPEN_A` → `OPEN_B` (the open-sea pair of `test/warp.test.mjs`) with a 30 km disc on the midpoint:
   no leg comes within 37.5 km of its centre and `distM` grows; a 400 km disc covering both ends → the direct route with
   `storm_unavoidable`; `avoid: []` equals the plan without the option.
8. *Worker* (real worker, 30 s test timeout): worker and inline give the same `distM` for rotterdam→hamburg and
   oslo→rotterdam; with 5 low-priority jobs queued a high one resolves first; `timeoutMs: 1` → null and `restarts ≥ 1`;
   `maxQueue: 1` → the overflow resolves null.

New file **test/pilot.test.mjs** (imports `public/js/pilotcore.js`):
speed bands (999 m → 4, 1001 → 6, 5001 → Infinity); `throttleCap(4, 14) = 0.2857…`, `throttleCap(1, 26) = 0.12`;
`lookAheadM(10, 1) = 1500`, `(14, 400) = 12000`; `firstShoal` finds the first sample below need across a two-leg route,
skips `null` depths, returns null when all deep; `offRouteM`; `shouldReplan` honours `REPLAN_MIN_MS` and the in-flight
flag; `handoverStep` matrix (far → route; within 3 L + guide ready → berth; guide not ready → stop; berth remaining ≤ 1.5 L → stop);
`stormOnRoute` finds a disc crossing the second leg at the right route distance, ignores cells below `STORM_MIN` and
beyond the horizon, and returns null for an empty storm list.

Game tests (append to test/route-planner.test.mjs): an offline coaster with a 3-point route round the Hook of Holland
(points from a real `planRoute`) reaches the last point without the "shoal water" stop; the legacy `{lat, lon}` voyage still
works; inside 2.5 km of an anchor the offline throttle is ≤ 6 / 14.

### 4.10 Browser checks

1. Chart: plot two waypoints with North Holland between them → Sail route → a green planned route round Den Helder,
   amber via diamonds, event "Route planned for your 5.5 m draught …".
2. Contract Route button from Rotterdam to Hamburg → the route leaves along the Rotterdam fairway, follows the lanes and
   the Elbe channel; within 5 km of Hamburg the telegraph steps down (10 → 6 → 4 kn), the autopilot switches to the
   berth line at the approach point and stops off the berth with the event; Moor (T) works.
3. Rotterdam → Plymouth: the route uses the south-west-bound Dover lane (chevrons on the chart).
4. Drag the ship (warp 20×) onto a leg that grazes a shallow (plot a manual waypoint close to a sandbank and sail it):
   "Re-planned: shallows …" appears and the line on the chart changes.
5. 400× on a planned North Sea route: no grounding, no warp drop for shallows on straight legs.
6. Set voyage, close the tab, reopen 10 minutes later: the ship followed the planned waypoints (track on the chart).
6a. While a storm cell shows on the chart (synthetic cells spawn about every 5 hours over the North Sea), plot a route
   through it: within the horizon the event "Re-planned round storm …" appears and the chart line bends round the disc.
7. Phone: voyage line, chart markers and the berth hand-over event fit at 390 px.

---

## 5. TIME-MODEL (V6-PLAN item 5)

### 5.1 Goal, in the player's words

"My ship has its own clock. When I fast-forward, the ship clock on the HUD visibly races, and contract time counts on
that clock — warping saves me real waiting, it doesn't cheat the deadline. Contracts on the board are possible: each card
tells me how long it will take *my* ship ('~24 h fishing (≈ 1 h 12 m at 20×)') and greys out the ones I can't make,
saying why. Fuel, wear, wages and the catch add up exactly, whatever the warp."

### 5.2 The ship's clock

`p.shipTime` — seconds (float64), monotonic, per player. It starts equal to the world clock (`game.simTime`) when the
player is created or first migrated, then advances every server tick:

`p.shipTime += dt × shipRate(p)` for **every** player (online or offline, docked or at sea), right after `checkWarp` in
the tick loop — before any `continue`.

| Situation | `shipRate(p)` | Notes |
|---|---|---|
| online at sea, 1× | 1 | |
| online at sea, warped | `warpOf(p)` (5 … 400) | the same factor that already scales fuel, wear, wages, catch, flooding |
| moored, not warped | 1 | docked time counts at 1× (V6-PLAN §5.2) |
| moored, warped (WARP-HARBOUR) | `warpOf(p)` (≤ 5) | contract hours run 5× too; §7 |
| under tugs | `warpOf(p) × op.rate` (`tugOp(game, p.id).rate`, else 1) | the assist is time-compressed on screen; the ship really spent that time |
| life raft / rescue | 1 | |
| offline, idle (docked or drifting) | 1 | logging off does not stop the clock |
| offline voyage | 1 | offline voyages are real time (`resetWarp` on disconnect) |
| server down | 0 | nobody experienced it: budgets pause during downtime (the world-clock deadlines of v0.4 ran on) |
| express passage | + the passage hours at once | `expressPassage` already charges `hours` of fuel and wear |
| call a tow | + tow hours at once: `min(48, distM / (8 kn) / 3600)` | |

**With wave 2 (fleet):** `shipTime` moves onto the vessel (V5-WAVE2 §4.2) and this tick only advances the clock of the
vessel a player is aboard. A ship nobody is aboard keeps her contracts (V5-WAVE2 §2.4.7), so her clock must not stop, or a
contract parked on her would never run late: wave 2's `companyTick` advances every active vessel without a player aboard
at rate 1 by the world time since its last pass and raises the same deadline events as company alerts (V5-WAVE2 §4.4
step 5). Laid-up vessels hold no contracts (their clock may stop).

Ship time on the wire (`privateState`): `shipTime` (rounded to 0.1 s), `shipRate`, `warpRun`
(`{ shipStart, worldStart }` while warped, null at 1×). `warpRun` is set inside `advanceShipClock` when
`warpOf(p) > 1 && !p.warpRun` and cleared when `warpOf(p) === 1` — no edits in the warp section. Saved in state.json with
the player; `migratePlayer` resets `warpRun = null`.

### 5.3 Contract time as ship hours

**Board job** (generated; `st.jobs`, `st.contact.jobs`, `publicJob`):

| field | meaning |
|---|---|
| `hours` | the budget in **ship hours** (integer ≥ `JOBTIME.MIN_HOURS`) |
| `postedAt`, `expiresAt` | world seconds; the offer leaves the board at `expiresAt` = `postedAt + JOBTIME.BOARD_TTL_H × 3600` (24 h) |
| `ref` | `{ cls, margin }` — the reference ship the budget was rated for and the margin used |
| `seaKm` | freight / passengers / charter / smuggling: sea km from → to (route table, else great circle × 1.25) |
| `groundKm`, `richness` | fishing: sea km from the harbour to the near edge of the ground (one way); ground richness |
| `platformKm` | supply: sea km harbour → platform (one way) |
| `towKm` | tow: `{ toCasualty, toDest }` sea km |
| `deadline` | **removed** on new jobs |

**Accepted job** (`p.jobs`): the board fields plus `acceptedAt` (world s), `acceptedShip`, **`dueShip`** (ship s) =
`p.shipTime + hours × 3600` at acceptance. Late ⇔ `p.shipTime > j.dueShip` (half pay, unchanged rule).

**Legacy jobs** (tests and old state files carry `deadline`, world seconds):
- accepting a legacy board job: `hours = max(1, (deadline − simTime) / 3600)`;
- `migrateAcceptedJob(p, j)` (from `migratePlayer`, and lazily from `advanceShipClock` for any job without `dueShip`):
  `dueShip = p.shipTime + (deadline − simTime)` (negative remainder = already late; `expiredWarned` kept),
  `hours = round((deadline − (acceptedAt ?? simTime)) / 3600)` (≥ 1), `acceptedShip = p.shipTime`, delete `deadline`;
  a job with neither field gets 24 h;
- `initHarbors`: board and contact jobs without `hours` are dropped before `regenHarbor(h, st, true)` refills the board;
- `regenHarbor` keeps a job while `(j.expiresAt ?? j.deadline) > simTime` (so tests that push legacy jobs keep working).

Deadline events move into `advanceShipClock` (they now fire for docked and offline players too):
`Deadline passed: … (half pay on delivery).` once; new: `2 h of ship time left: …` once when `dueShip − shipTime < 7200`.

### 5.4 Feasible contracts — new file shared/jobtime.js (TIME-MODEL)

```js
import { SHIP_CLASSES } from './constants.js';
import { RATES, serviceKn, catchRate, kmHours, shipClass } from './rates.js';
export const JOBTIME = {
  MARGIN_MIN: 1.4, MARGIN_MAX: 1.8,     // budget = need(reference ship) × margin + fixed hours
  FIXED_H: { freight: 4, passengers: 3, charter: 3, supply: 3, tow: 4, smuggling: 4, fishing: 2 },
  PORT_H: 1,                             // casting off + coming alongside in every harbour-to-harbour need
  CRANE_H: 0.5, TOWLINE_H: 0.5,
  MIN_HOURS: 4, BOARD_TTL_H: 24,
  SHOW_WARP: 20,                         // the card's "(≈ … at 20×)" — WARP.MAX_NO_ROUTE, the highest level without a route
  FISH_REF: [['trawler', 0.55], ['coaster', 0.45]],
};
export function refClassFor(job, rnd)  → cls       // fishing: FISH_REF by rnd; freight/smuggling: coaster ≤ 1200 t, feeder ≤ 4000 t,
                                                   // else bulker; passengers: coaster ≤ 12 pax else ferry; charter: sloop;
                                                   // supply: psv; tow: tug
export function needFor(job, cls) → { workH, sailH, needH }
export function budgetFor(job, cls, margin) → hours = max(MIN_HOURS, ceil(needFor(job, cls).needH × margin + FIXED_H[type]))
export function hardReason(job, ship) → string | null      // can never take it (texts of today's hud.whyNot)
export function estimateJob(job, ship) → Estimate
export function fmtShipH(h), fmtRealHM(h), jobLabel(need, warp)
```

`needFor(job, cls)` (C = `shipClass(cls)`):

| type | workH | sailH | needH |
|---|---|---|---|
| fishing | `qty / catchRate(cls, richness)` (∞ when 0) | `2 × groundKm / (serviceKn(cls, 0.5 × qty / C.capacity) × 1.852)` | work + sail |
| freight, smuggling | 0 | `kmHours(seaKm, serviceKn(cls, qty / C.capacity))` | sail + PORT_H |
| passengers, charter | 0 | `kmHours(seaKm, serviceKn(cls, 0))` | sail + PORT_H |
| supply | CRANE_H | `2 × kmHours(platformKm, serviceKn(cls, 0.5))` | work + sail |
| tow | TOWLINE_H | `kmHours(towKm.toCasualty, serviceKn(cls)) + kmHours(towKm.toDest, serviceKn(cls) × (C.towPower ? 0.95 : 0.65))` | work + sail |

Missing distances (legacy jobs): `seaKm = distKm × RATES.DETOUR`; fishing without `groundKm` → sail 0; tow/supply
without `towKm`/`platformKm` → `distKm × DETOUR` as the whole sail.

`hardReason(job, ship)` — `ship = { cls, holdFreeT, paxFree }`, checked in this order, same texts as `hud.whyNot` today:
needs category → `needs a yacht or ferry`; pax → `needs ${pax} berths (${free} free)`; fishing: `fishRate` 0 →
`this hull cannot fish`, qty > capacity → `hold too small for ${qty} t`; freight-like qty > hold free →
`needs ${qty} t of hold (${free} t free)`.

```ts
Estimate = { ok: boolean, hard: string | null, why: string | null, workH, sailH, needH,
             budgetH: number, slackH: number, warp: number, label: string }
// ship = { cls, holdFreeT, paxFree, budgetH? (default job.hours; accepted jobs pass (dueShip − shipNow)/3600), warp? (SHOW_WARP) }
// ok = !hard && needH ≤ budgetH
// why = hard || (!ok ? `too slow for your ship: needs ~${fmtShipH(needH)}, the contract allows ${budgetH} h` : null)
```

**Label format** (exact; tests use these vectors):
- `fmtShipH(h)`: `< 1` → `${round(h × 60)} min` (≥ 1); `< 10` → one decimal, trailing `.0` dropped (`3.5 h`, `4 h`);
  else `${round(h)} h`. `dispH(h)` = the value that string shows.
- `fmtRealHM(h)`: m = round(h × 60); `< 60` → `${m} m`; else `${floor(m / 60)} h ${m % 60} m` (no zero padding).
- fishing: `with your ship: ~${fmtShipH(workH)} fishing` + (sailH ≥ 0.5 ? ` + ${fmtShipH(sailH)} sailing` : '') +
  ` (≈ ${fmtRealHM((dispH(workH) + (sailH ≥ 0.5 ? dispH(sailH) : 0)) / warp)} at ${warp}×)`
- others: `with your ship: ~${fmtShipH(needH)} ${type === 'tow' ? 'towing' : 'sailing'} (≈ ${fmtRealHM(dispH(needH) / warp)} at ${warp}×)`
- Vectors: coaster, Southern Bight (richness 0.7), 100 t, `groundKm` 0 → `with your ship: ~24 h fishing (≈ 1 h 12 m at 20×)`;
  the same with `groundKm` 20.61 (sail 2.00 h) → `with your ship: ~24 h fishing + 2 h sailing (≈ 1 h 18 m at 20×)`.

**Generation** (server/economy.js, TIME-MODEL): every generator sets the §5.3 fields; `generateJob(from, simTime, rnd,
forceType, env)` keeps its signature; `env.seaKm(fromId, toId) → km | null` is new and optional:

```
fishing     qty = round5(20 + rnd × 120) (unchanged); ground as today; groundKm = max(0, gcKm(from, g) − g.radiusKm) × DETOUR
freight     qty as today; seaKm = env.seaKm?.(from.id, dest.id) ?? dest.d × DETOUR
passengers, charter, smuggling: seaKm likewise; supply: platformKm = d × DETOUR; tow: towKm from the casualty spot
then        ref = refClassFor(job, rnd); margin = MARGIN_MIN + rnd × (MARGIN_MAX − MARGIN_MIN)
            hours = budgetFor(job, ref, margin); ref = { cls, margin: round2(margin) }
            postedAt = simTime; expiresAt = simTime + BOARD_TTL_H × 3600
pay         unchanged formulas (§7)
```

Worked example (the player's complaint, V6-PLAN item 5): from Rotterdam the near edge of the Southern Bight is
72.8 − 45 = 27.8 km great circle → `groundKm` 34.7. A 100 t job rated for a trawler (30 × 0.7 = 21 t/h → 4.8 h fishing
+ 4.0 h sailing = 8.8 h) gets a budget of 15–18 h. A coaster needs 23.8 h fishing + 3.4 h sailing = 27.2 h → greyed
"too slow for your ship: needs ~27 h, the contract allows 15 h". The same job rated for a coaster gets 41–51 h and the
coaster card reads "with your ship: ~24 h fishing + 3.4 h sailing (≈ 1 h 22 m at 20×)".

`publicJob(j)` returns the §5.3 board fields (`hours, postedAt, expiresAt, ref, seaKm, groundKm, richness, platformKm,
towKm`) instead of `deadline`.

### 5.5 Server hooks (server/game.js, TIME-MODEL)

```js
shipRate(p)                    // §5.2 table
advanceShipClock(p, dt)        // shipTime += dt × shipRate; warpRun bookkeeping; migrateAcceptedJob for jobs without dueShip;
                               // the 2-hour and deadline-passed events
migrateAcceptedJob(p, j)       // §5.3
jobEnv()                       // + seaKm: (a, b) => this.routeTable?.seaKm?.(a, b) ?? null   (never throws)
acceptJob(p, jobId)            // hard checks unchanged (same messages); then
                               //   est = estimateJob(job, { cls, holdFreeT, paxFree }); push
                               //   { ...job, hours, acceptedAt: simTime, acceptedShip: p.shipTime, dueShip: p.shipTime + hours × 3600 }
                               //   (deadline deleted on the copy); if !est.ok → warn event `Tight: ${est.why}. Late delivery pays half.`
payJob(p, j, frac, harbor)     // late = p.shipTime > (j.dueShip ?? Infinity)
deliverOffshore(p, jobId)      // same late rule
expressPassage(p, lat, lon)    // + p.shipTime += hours × 3600; event adds "(ship's clock +5.2 h)"
tow(p)                         // + p.shipTime += min(48, units / (8 × GEO.KN_TO_MS) / 3600) × 3600; event adds "(3.1 h under tow)"
tick                           // + advanceShipClock(p, dt) after checkWarp; fishing: rate = catchRate(s.cls, g.richness) × (storm > 0.5 ? 0.4 : 1)
                               //   (same numbers; FISH_RATE_T_PER_H removed in favour of RATES.FISH_T_PER_H); the old deadline line removed
                               //   Wave 2 edits the same statement (crew/gear limits); the merged form, whoever lands second:
                               //   const rate = catchRate(s.cls, g.richness) * (wx.storm > 0.5 ? 0.4 : 1) * (L.nets ? L.fishMul : 0);
                               //   with L = this.limitsFor(p) (wave 2; NO_LIMITS before it)
privateState(p)                // + shipTime, shipRate, warpRun
```

### 5.6 Exact accumulation

Every per-tick quantity is derived from the same `hrs = dt × warp / 3600` that advances the ship clock, kept in full
float64 precision and rounded only for display. Audit result on this tree: fuel (`p.fuel`), hull wear (`p.cond`), crew
wages (`p.money`), flooding and pump-out (`p.flooding`) and the catch (`fishInfo.caughtRaw`, `stack.qty`) are already
unrounded per tick (the v0.4.1 fix). This package proves it with tests at the real 10 Hz tick (§5.8) and keeps it true:
no new `Math.round` on a stored quantity inside `tick`. Known limit: `server.js` caps the tick `dt` at 1 s, so an
event-loop stall longer than 1 s loses accounting time and ship time equally (consistent, not exact wall time; §7).

### 5.7 Client

- **main.js** `onYou`: `this.shipClock = { t: Number(you.shipTime) || 0, rate: Number(you.shipRate) || 1, at: performance.now(), warpRun: you.warpRun || null };`
  new method `shipTimeNow()` = `t + (now − at) / 1000 × (you.assist ? rate : (this.warp || 1))` (smooth between the 1 Hz `you`).
- **HUD ship clock** (`hud.updateTop`, clock part): a stat `#hbShip` (class `stat shipClockStat`) is created once and
  inserted after `.clockStat`. Shown while `app.warp > 1` and for 15 s after warp ends: label `Ship · 20×`, value
  `+6 h 20 m` = `shipTimeNow() − warpRun.shipStart`, title "Your ship's clock: 6 h 20 m of ship time since you started
  warping. Contract hours count on it; the tide and the world clock run in real time." Updated every HUD tick (~8 Hz), so
  at 20× the minutes advance every 3 s. On phones (`body.touch`) the world clock stat itself switches to the ship clock
  while warping (`hbDate` = `Ship · 20×`, `hbClock` = `+6:20`) instead of adding a stat. CSS in
  `public/css/timemodel.css`, injected with `ensureCss('tmCss', 'css/timemodel.css')`.
- **Contract cards** (hud.js `jobCard`): the clock chip shows the budget `26 h`; below the route line an estimate line
  `est.label` (green when ok). `!est.ok && !est.hard` → card class `tooSlow` (greyed: opacity .55, `filter: grayscale(.6)`),
  the eligibility line shows `est.why` plus "rated for a stern trawler" from `j.ref.cls`, the button reads
  `Accept anyway` and `sheetAction('accept')` confirms: `Your ship needs ~27 h, the contract allows 15 h of ship time. Late delivery pays half. Accept anyway?`.
  `est.hard` → disabled as today. `whyNot` delegates to `hardReason` (same texts).
- **Your contracts** (`tabJobs` rows) and **Job boards** (`tabBoards`): `21 h 10 min left (ship time)` from `dueShip −
  shipTimeNow()`; board rows show `26 h` and `ok` / `too slow` with the label in the tooltip.
- **Contract card at sea** (jobs.js + `hud.showJobs`): `t.leftS = j.dueShip − app.shipTimeNow()` replaces `deadlineS`;
  `fmtLeft` → `21 h 10 min left` and, when warped, `· ≈ 1 h 4 m at 20×`; fishing's step text keeps
  `about N h at 1×` using `catchRate`. A red `late` style below 0 as today.
- **chart.js `jobRows`**: the "Deadline" column becomes "Time" with `26 h`.

### 5.8 Tests — new file test/timemodel.test.mjs

1. *rates.js / jobtime.js numbers:* §1.5 reference numbers; the two label vectors of §5.4 exactly; `fmtShipH` (0.5 → `30 min`,
   3.5 → `3.5 h`, 4.0 → `4 h`, 23.8 → `24 h`), `fmtRealHM` (1.2 → `1 h 12 m`, 0.55 → `33 m`).
2. *Generation is feasible by construction:* 3,000 jobs from 10 harbours with a seeded rnd: every job has integer
   `hours ≥ 4`, `expiresAt − postedAt = 86400`, no `deadline`; `estimateJob(job, { cls: job.ref.cls, holdFreeT: ∞, paxFree: ∞ }).ok`;
   `hours ≥ needFor(job, ref).needH × 1.4`; fishing qty within 20…140; `env.seaKm` stub returning 500 km for one pair is used.
3. *The player's case:* coaster, Southern Bight (richness 0.7), 100 t, `groundKm` 34.7: budget 15 h → `ok === false`,
   why `/too slow for your ship: needs ~27 h, the contract allows 15 h/`; budget 45 h → ok; a trawler on 15 h → ok.
4. *Ship clock at 10 Hz* (coaster at OPEN_A, throttle 1, a route for levels above 20×): for each level L in 1, 5, 20, 100,
   400 run N = 3600 / L ticks of 0.1 s (400×: 9 ticks) → `shipTime` advanced N × 0.1 × L = 360 s within ±1e-3 s. (Not
   1e-6: `shipTime` is an epoch-sized float64, ~1.8e9 s, whose step is 2.4e-7 s; 3,600 additions of 0.1 s drift by up to
   0.34 ms, measured over 50 random start times. A millisecond is far below anything a deadline compares.)
   Docked: 1×. Docked at 5× (only when `WARP.HARBOR_MAX` exists): 5×. Offline idle: 1×. Offline voyage: 1×. Rescue: 1×.
   A tug assist whose op has `rate = 3` (set on `tugOp(g, p.id)`): 3×.
5. *Exact accounting per ship hour:* for L in 5, 20, 100, 400 run 36000 / L ticks (one ship hour; 1×: 3,600 ticks = 6 ship
   minutes, compared per hour): fuel burned = `fuelBurnPerSimHour(…)`, wear = `wearPerSimHour(…) × serviceWearMul(…)`,
   wages = `crewCost` per ship hour (relative error < 1e-7, identical at every level: `p.money` ≈ 25,000 has a float step
   of 3.6e-12, so 3,600 subtractions of ~0.001 cr can be off by ~1e-9 relative in the worst case); a trawler fishing on
   the Dogger Bank catches `catchRate('trawler', 1)` t per ship hour (30 t today) at every level (±1e-9 relative, the
   catch starts at 0); flooding pump-out −0.3 per ship hour.
6. *Deadlines on the ship clock:* accept a 10 h freight job (crafted with `hours: 10`), sail at 100× (with a route) for
   3,590 ticks of 0.1 s (9 h 58 m 20 s of ship time), set 1×, move to the destination and dock → full pay; the same in a
   second game with 3,610 ticks (10 h 1 m 40 s) → half pay. At 1×, 9 ship hours later the same delivery is on time.
7. *Legacy acceptance and migration:* accepting a test-style job with `deadline: simTime + 36000` gives `hours === 10`,
   `dueShip − shipTime === 36000` (±1); a state file with an accepted legacy job (`deadline` 5 h ahead) and legacy board jobs
   → after load `shipTime === simTime` (±1 s), the job has `dueShip` 5 h ahead, no `deadline`; every board job has `hours`.
8. *Express and tow advance the clock* by the charged hours.
9. *publicJob shape:* has `hours, expiresAt, postedAt, ref` and per-type distance fields; no `deadline`. Update the
   assertion in `test/game.test.mjs` "public job boards carry …" (the key list: `deadline` → `hours`, `expiresAt`).
10. *Events:* `2 h of ship time left` fires once; `Deadline passed` fires once, also for a docked player.

### 5.9 Browser checks

1. Docked at Rotterdam with the starter coaster: every fishing card shows "with your ship: …"; trawler-rated tight ones
   are greyed with "too slow for your ship … rated for a stern trawler"; Accept anyway asks first.
2. Accept a feasible fishing job, sail out, warp 20×: the ship clock stat appears ("Ship · 20×", "+0 h 01 m" ticking up a
   minute every 3 s); the contract card's time left drops 20× faster and shows "≈ … at 20×".
3. Drop to 1×: the ship clock stays visible 15 s with the final offset, then hides.
4. Express passage: the contract card's time left drops by the passage hours.
5. Phone portrait: the clock stat switches to ship time while warping; cards show the estimate line without overflow.

---

## 6. Integration

### 6.1 Order

Gate: no package merges an edit to an existing shared file before wave 1 is merged and `npm test` is green (§1.1); new
files and their tests may be written and reviewed before that. After the gate, any order works with the hook table (§1.3);
this order minimises rebases:
1. **WARP-HARBOUR** — small, game.js warp section + constants + main/hud warp functions; updates `test/warp.test.mjs`.
2. **TIME-MODEL** — creates `shared/rates.js` (if not there) and `shared/jobtime.js`; game.js/economy.js changes; uses
   `WARP.HARBOR_MAX` in one guarded test.
3. **AUTOPILOT-CHARTS** — searoute v2, tss.js, the worker, tide `lowWaterAt`, client autopilot, offline voyages.
4. **WORLD-MARKET** — market.js, routetable.js, the sheet; at this point server.js wires `RouteTable` to `RoutePlanner`.

Run `npm test` after each merge. Then the browser checks of all four packages on the integrated build (desktop and phone),
then the integrator updates `docs/ARCHITECTURE.md` (v6 addendum: harbour warp, ship's clock, contract hours, route
planner v2 + worker, market endpoints and files) and `docs/STATUS.md`.

### 6.2 server.js final shape (the lines the packages add)

```js
import { RoutePlanner } from './server/routeworker.js';                         // AUTOPILOT
import { parseRouteQuery } from './server/searoute.js';                         // AUTOPILOT (planRoute import stays for the fallback)
import { RouteTable } from './server/routetable.js';                            // MARKET
import { PriceHistory, marketSnapshot, findTrades, parseRoutesQuery } from './server/market.js'; // MARKET

const traffic = new Traffic(world, HARBORS, { … });                             // unchanged
const routePlanner = new RoutePlanner({ world, graph: traffic.graph, geom: harborgeom, log });            // AUTOPILOT
const routeTable = new RouteTable({ plan: (a, b, o) => routePlanner.plan(a, b, o, { priority: 'low' }), log }); // MARKET
game = new Game(world, log, { weather, traffic, harborgeom, routeTable });     // MARKET adds routeTable; TIME reads it
const priceHistory = new PriceHistory({ file: path.join(DATA_DIR, 'market-history.json'), log });           // MARKET
priceHistory.load(); priceHistory.maybeSample(game); routeTable.start();                                     // MARKET
setInterval(() => { try { priceHistory.maybeSample(game); } catch (e) { log('[market] sample failed', e.message); } }, 60000);
// … /api/route (AUTOPILOT §4.5), /api/market* (MARKET §3.4) …
// Shutdown: ONE handler pair, written by whichever of MARKET / AUTOPILOT / wave 2 (W2-SERVER) merges last; earlier
// packages add only their own call. `{ sync: true }` is wave 2's synchronous save (V5-WAVE2 §6.2); before wave 2,
// saveState ignores the argument.
function saveAll(why) {
  log(why);
  try { game.saveState({ sync: true }); } catch (e) { log('[save] state failed', e.message); }
  try { priceHistory?.save(); } catch (e) { log('[save] market history failed', e.message); }
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { saveAll('shutting down, saving state'); try { routePlanner?.close(); } catch {} process.exit(0); });
process.on('uncaughtException', (e) => { log('[fatal] uncaught', e.stack || e); saveAll('saving after an uncaught exception'); });
```

If AUTOPILOT is not merged yet, MARKET passes `plan: null` (the table answers estimates only); never
`planRoute` on the main thread for the bulk table. The same `saveAll` text appears in V5-WAVE2 §7.2.

### 6.3 Cross-package checks after integration

- Approach Rotterdam on a planned route at 100×: WARP caps to 5× at 4 km, AUTOPILOT slows and hands over to the berth
  line, TIME's ship clock rate drops from 100 to 5 on the HUD.
- Plan a market trade (MARKET → AUTOPILOT `planTo`), sail it at 20×: contract-free, the route avoids shallows; the
  trade's hours estimate matches the HUD ETA within 15 %.
- A fishing contract accepted at 1×, fished at 20×: delivery on time iff the ship hours used ≤ budget.
- `npm test` green; `/api/health` shows the planner stats and route-table progress; memory (`rssMB`) rises by ≤ 80 MB.

---

## 7. Decisions for the product owner (built as written unless changed)

1. **Moored and stationary warp.** V6 item 6 asks for 5× "moored with the engine off" and "waiting for the tide"; item 5
   keeps the tide on the real world clock and counts contract time on the ship's clock. So warping while moored or waiting
   saves nothing today (no port process runs on ship time yet) and burns contract hours 5× faster. This contract allows it
   (the warp level then persists through mooring and casting off) and says so on the banner. Alternative: keep the ship
   clock at 1× while docked whatever the level. Revisit when wave 2 adds ship-time port work (repairs, loading, crew rest).
2. **One price per good — for now.** This package keeps buy = sell and a whole trade at the pre-trade price, but reads
   every price through `tradeQuote` (§3.3). Today a full coaster hold earns ~7,200 cr per ship hour on a good trade
   (7.5× a full freight contract); wave 2, which adds loans and crew wages, turns on price impact and a 1 % spread
   (~1,700 cr per ship hour on the same trade) by changing `TRADE.SPREAD` and `TRADE.IMPACT` (V5-WAVE2 §3.10).
3. **Contract pay is unchanged**; only time budgets became realistic. Tight budgets do not pay more.
4. **The yard-service interval stays on the world clock** (30 days); moving maintenance to ship running hours belongs to
   wave 2's spare parts.
5. **Low water = mean low water springs** (1.33 × M2 amplitude). Deep-draught ships into the Humber/Elbe get a "tidal
   passage" warning rather than no route.
6. **TSS:** only the Dover Strait pair exists in the lane data; more schemes need real lane coordinates (data-only).
7. **The warp land look-ahead is heading-based** (v0.4); at 100–400× a planned leg that turns close to a cape can still
   drop warp. A route-aware look-ahead needs the server to keep the route (out of scope here).
8. **The route table** costs ~15 min of one worker core once per world/lane change; until then market distances and job
   budgets use great circle × 1.25 (p90 of the real ratio is 2.56, so some early budgets are tight).
9. **Tick `dt` is capped at 1 s** in server.js; long stalls lose ship time and consumption alike.
10. **The catch rate is a wave-2 decision.** This package keeps `RATES.FISH_T_PER_H = 10` (the rates the player has
   seen: coaster 4.2 t/h on the Southern Bight, trawler 30 t/h on the Dogger Bank) and makes contracts feasible for them.
   At these rates a trawler nets ~9,000 cr per ship hour, ten times the best freight run; wave 2 lowers the knob to 2
   behind a balance test (V5-WAVE2 §3.10), which changes the reference numbers of §1.5, the label vectors of §5.4 and
   the fishing tests; V5-WAVE2 §9.5 lists them.
11. **Storms are avoided only as the game's storm cells** (`snap.storms`), not as real gales from the weather service.

## 8. Open questions for the player

1. **Warp while moored:** should the ship's clock, and with it contract hours, run 5× faster while you sit moored at
   5× (built: yes — it only saves real waiting time, e.g. for repairs in wave 2), or stay at real time whenever you are
   alongside, as the v6 plan's "docked time counts at 1×" says (then moored warp changes nothing yet)?
2. **Trading:** should every harbour show one price per good, with a whole hold traded at that price (today: a good
   trade earns about 7× a freight contract), or a separate buying and selling price where big cargoes move the price
   against you (wave 2 default: trading earns about as much as freight)?
3. **Contracts your ship cannot finish in time:** show them greyed out with the reason and an "Accept anyway" button
   (built), or hide them from the board?
