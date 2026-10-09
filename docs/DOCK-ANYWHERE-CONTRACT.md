# Saltline — dock anywhere (moor at any real quay in the world)

Status: **phase 1 built** (2026-10-09): new files only, tested on the recorded Rotterdam tiles. Phase 2 (wiring into
`game.js`, `server.js`, `main.js`, `hud.js`) is written out, ready to paste, in `docs/DOCK-ANYWHERE-PHASE2.md`.
Builds on: `docs/WORLD-DETAIL-STREAMING.md` (D14 tiles with quay edges, piers, pontoons, bridges, locks, cranes; its
"Phase 3 — any-quay mooring" item is this feature), `server/berthguide.js` / `game.dock` / `tugAssist` (harbour berths).

---

## 1. What the player gets (plain words)

**The request:** "I sailed the container ship inland near Rotterdam, outside the harbour, and found a long quay wall. I
want to moor anywhere there is a real quay, if my ship fits, see that I have to pay to lie there, and still use the
harbour's services. Everywhere in the world."

**Answer:**

* Press **Q** (or the **Quays** button) anywhere near the coast. The game looks at the real map around your ship (the
  same OpenStreetMap quays, piers and pontoons you see drawn) and lists every quay within 1.5 km.
* For each quay a card shows: its **name and kind** (commercial terminal, industrial quay, city quay, marina pontoon,
  quay wall), its **length** and the **water depth at low tide**, each against what *your* ship needs, the **price per
  day**, and the nearest harbour with the **services** that reach this quay. A quay that does not fit says why: too
  short, too shallow, too narrow, a ship already lies there, under a bridge, in a lock, on the fairway.
* On the water you see a **green outline the size of your ship** where she will lie (amber when she does not fit) and a
  light column marking it from afar. Step through the quays with ‹ ›.
* Come alongside (within 40 m of the outline, under 2 kn, lined up with the quay within 25°) and press **Moor here**.
  Big ships near a port can call **tugs** instead. The **first day is paid** when your lines go ashore; the rest when
  you cast off (per started day). A container ship at a Maasvlakte terminal pays 4 125 cr/day; at an industrial quay
  outside the port 1 760 cr/day; a yacht at least 25 cr/day.
* While moored, the **harbour sheet of the nearest harbour** opens from the quay panel. What it offers depends on the
  distance:
  * **in port** (inside the harbour's port limits: 12 km for mega ports, 8 / 5 / 3 km for major / regional / minor):
    everything, exactly as at the harbour berths (port dues and pilotage too);
  * **up to 25 km**: market and fuel **by truck** (+6 % / +12 %), repairs by a **mobile crew** (+25 %), the office,
    contracts can be taken (but delivered only at the harbour); **no shipyard, no yard service, no back room**;
  * **up to 60 km**: fuel by truck (+25 %, ≤ 150 t) and the fleet office by phone;
  * **further**: you can only lie there.
* Other skippers see your ship moored at the quay, and nobody (players, your fleet, AI or live AIS ships lying there) can
  be moored on top of another ship: the free part of the quay is offered instead, or the quay says "Occupied".
* It works the same everywhere in the world, offline from the tile cache too, and two players always see the same quays.

---

## 2. Data: where the berths come from

Inputs are the decoded D14 world tiles (`shared/wtformat.js`) the server already keeps in memory near ships
(`server/worldtiles.js get`): vectors `quays` (overlay `man_made=quay` + derived quay edges), `piers` (ring edges),
`pontoons`, `bridges`, `locks`, `cranes`, `tanks`, `areas`, and the mask / height grid.

```
tile vectors ──► face segments, clipped to their OWN tile square (no duplicates across tiles)        per tile, cached
3×3 tiles   ──► chain → straight pieces → oriented (water on the right, by the mask 6 m each side)
            ──► walls: pieces grown along a best-fit line (direction ≤ 25°, every point ≤ 8 m, gaps ≤ 60 m)
            ──► snap each wall to the real land→water edge in the mask (±12 m scan every 10 m, refit)
            ──► runs (≤ 1 200 m, split equally), OWNED by the tile holding the midpoint                per tile, cached
            ──► per run: depth profile every 10 m at 4/10/18/28/40/55 m off the face (low water), cuts, class
```

* **Depth at low water** = −tile height + `lowWaterAt(lat, lon)` (= `game.depthAtLowWater`).
* **Cuts** (no berth on that 10 m step): bridge within width/2 + 15 m, lock (mask LOCK or lock ring), FAIRWAY mask within
  18 m of the face; at query time also harbour-patch berths (their own Moor/Tugs flow wins) and an optional restricted-area
  predicate.
* **Class**: pontoon → marina; STS crane within 80 m → terminal; crane / port land use → terminal (≥ 10 m deep) else
  industrial; tanks / industrial land use → industrial; residential / commercial → city; else quay wall.
* **Linked harbour**: the nearest of the 336 game harbours (great circle, ties by id) → tier by distance (§3.4).
* **Determinism**: the runs are a pure function of the 3×3 tiles' content (signature = contentHash + rev of each);
  ids `q<x>.<y>.<i>` are stable for the same tiles. Every player gets the same runs.
* Straight derived quay data is a staircase of short pieces with gaps (the converter keeps straight raster runs ≥ 30 m);
  the wall growing + mask snapping turn e.g. the Maasvlakte terminal into one 800 m wall (test).

## 3. Rules (`shared/quayrules.js` — server, client and tests use the same numbers)

### 3.1 Fit

| Need | Rule | Container ship (300 × 43 m, 14 m) |
|---|---|---|
| length | hull + max(10 m, 10 %) | 330 m |
| depth at low water | draught + max(0.3 m, 5 %) | 14.7 m |
| clear width | beam + 6 m (offsets inside it must be water) | 49 m (offsets 4…40 m) |
| pontoons | small craft only (≤ 30 m) | — |

A step fails the depth only at the face band (≤ 10 m) for ≤ 2 steps between good ones → a **notch** (raster stairs along
a sloping wall), not a break. The **slot** is the free stretch of `length` nearest the ship along the quay (centre on a
5 m grid); the ship lies 1.5 m (fenders) + beam/2 off the face, heading along the quay the way she already points.

Why-not order: small craft pontoon → blocked (bridge / lock / fairway / harbour berth / restricted) → too short → too
narrow → too shallow ("in places" when part of it is deep) → occupied (name of the nearest hull lying there).

### 3.2 Occupancy

Hulls: skippers' ships (online or not), fleet vessels, AI traffic that is moored / stopped / anchored or < 0.5 kn, live
AIS vessels the same (their reported length/beam). A hull blocks [along ± (projected half length) ± 8 m] when its near
side comes inside the strip this ship needs. Free stretches are what remains.

### 3.3 Price

```
perDay = max(25, round(baseBerthFee(cls) × CLASS_MUL[quay class] × portMul × homeMul))
baseBerthFee = round(displacement × FEES.BERTH_PER_T_DAY)          (= server/economy.js berthFeePerDay)
CLASS_MUL    terminal 1.5 · industrial 1.0 · city 1.3 · marina 1.2 · quay wall 0.9
portMul      in port: mega 1.25 · major 1.1 · regional 1.0 · minor 0.9;   outside the port limits: 0.8
homeMul      0.5 at your fleet's home port (in port only)
stay         perDay × started days (≥ 1); day 1 paid on mooring, the balance on casting off
in port      + port dues and pilotage exactly as at harbour berths (economy.portDues / pilotageFee)
tugs         harbour tug rate (economy.tugCostFor); × 1.5 outside the port limits
```

Exact examples (tested): container ship, terminal, mega port **4 125**; at home **2 063**; industrial quay outside the
port **1 760**; feeder, city quay, regional port **364**; coaster, quay wall, minor port **52**; sloop at a marina **25**;
2.5 days at 4 125 = **12 375**, balance after day 1 **8 250**.

### 3.4 Services (tier = distance from the quay to the linked harbour)

| tier | distance | market | fuel | repairs | yard service | shipyard | office | contracts | back room | tugs | dues |
|---|---|---|---|---|---|---|---|---|---|---|---|
| port | ≤ port limits | ×1 | ×1 | ×1 | ×1 | yes | yes | take + deliver | yes | yes | yes |
| near | ≤ 25 km | truck ×1.06 (buy and sell) | truck ×1.12, ≤ 400 t | mobile ×1.25 | — | — | phone | take only | — | mega/major ports | — |
| remote | ≤ 60 km | — | truck ×1.25, ≤ 150 t | — | — | — | phone | — | — | — | — |
| none | further | — | — | — | — | — | — | — | — | — | — |

Surcharges are charged on the money that changed hands in the normal harbour action (`quaySurcharge`). Fleet actions
that need the ship *in* the harbour (`switch_ship`, `fleet_slot`, `fleet_home`) work at port-tier quays only; every
other fleet / HQ action works from anywhere, as at sea (`ACTION_SERVICE`). Going ashore
(the harbour walk) is never possible from a quay. Harbour-sheet tabs per tier: `TIER_TABS`.

### 3.5 Making fast

`quay_dock`: ship centre within **40 m** of the berth line and within max(30 m, L/4) of the slot centre along the quay,
under **2 kn**, heading within **25°** of the quay either way; not hailed; money ≥ day 1. `quay_tugs`: within **1.5 km**,
under **6 kn**, tugs available for the tier (§3.4), a straight line of navigable water (± half beam) from the ship to the
slot, money ≥ tug fee + day 1; the tugs walk her in over 45 s (the legacy assist walk); at the end the quay is re-fitted.

## 4. Server

### 4.1 Modules (phase 1, built)

| File | Exports | Notes |
|---|---|---|
| `shared/quayrules.js` | `QUAY`, `QUAY_CLASSES`, `SERVICE_TIERS`, `TIER_TABS`, `ACTION_SERVICE`, `neededLength/Depth/Width`, `offsetsFor`, `serviceTier`, `linkHarbour`, `tugsAvailable`, `quayTugCost`, `baseBerthFee`, `quayFeePerDay`, `daysAlongside`, `stayFee`, `balanceDue`, `serviceMul`, `quayDenies`, `quaySurcharge`, `approachWhy` | pure, no deps beyond `constants.js` |
| `server/quays.js` | `createQuayFinder({getTile, harbors, guard})` → `{runsFor(x, y), runsNear(lat, lon, r, maxNew), stats, clear}`, `queryQuays`, `fitRun`, `dockCheck`, `tugCheck`, `occupiedIntervals`, `collectOccupants(game, …)`, `quayBerth`, `quayUndockPoint`, `quayName`, `runFrame`, `runPoint`, `makeSampler`, `straightWater`, geometry helpers | pure; tiles via the injected sync `getTile` |
| `server/quaygame.js` | `attachFinder`, `quayQuery`, `quayDock`, `quayTugs`, `quayAssistDone`, `quayUndock`, `quayGate`, `quayMigrate`, `quayPublic`, `quayHarbourInfo`, `quayAllowsAshore`, `harbourBerthsNear`, `fitOpts` | the game glue; game.js only calls these |

**Memory** (`server/memguard.js`): two count-capped LRUs — tile features ≤ 48, runs ≤ 64 tiles (a few KB each, < 1 MB
together); at **shed** both are dropped (`onShed`) and capped at 8 / 16; at **critical** no new tile is analysed (the
query answers `busy`, cached tiles still answer). No tile is ever fetched by the finder; `quayQuery` asks
`game.quayEnsure` (→ `wt.ensureAround(…, P1, 2.5 s)`) only when tiles are missing and re-answers when they arrive.
**CPU**: ≈ 30 ms per newly analysed tile (3×3 features, sampling); a query analyses at most **6** new tiles (nearest
first), the rest are `pending` and come with the next query (the card re-asks every 2 s). Cached queries ≈ 1 ms.

### 4.2 Protocol

Client → server (actions, `net.action(name, extra)`):

| action | payload | answer |
|---|---|---|
| `quay_query` | — (the server uses the ship's own position) | `{ t: 'quays', list: [Candidate], missing, pending, busy, ms }` (≤ 1 / s) |
| `quay_dock` | `{ id }` (run id; the server re-fits the slot) | `you` (docked) + `harbor` + events + `{ t: 'quays', list: [], dockedAt }`; or an event `warn` with the reason |
| `quay_tugs` | `{ id }` | `you` with `assist` (berthName = quay name), moored at the end |
| `undock` | — | existing action; at a quay the balance is charged and she starts 20 m out |

**Candidate** (`server/quays.js candidate`):

```text
{ id: 'q8376.5415.15', slotId: 'q8376.5415.15@300' | null, name: 'Terminal U9 · Rotterdam', cls, clsName,
  lenM, usableM, needM, depthLW, needDepth, fits, why, occupiedBy: {id, name, kind} | null, distM,
  face: { a: {lat, lon}, b: {lat, lon}, hdg (a→b), wb (bearing into the water) },
  slot: { lat, lon, hdg, len, beam, a: {lat, lon}, b: {lat, lon} } | null,
  perDay, harbor: { id, name, size, distKm } | null, tier, services: SERVICE_TIERS[tier], tabs: TIER_TABS[tier],
  tugs: bool, tugCost }
```

**Saved berth** (`p.berth`, `quayBerth`): `{ quay: true, v, id (slot id), run, name, cls, harbor, tier, hdKm, lat, lon,
hdg, wb, off, depth, length, slotLen, perDay, paid, since (simTime), a, b }` with `p.docked = harbor` (the linked
harbour), so the harbour sheet, office, warp and saving work unchanged. A docked ship is never moved by tile swaps
(WORLD-DETAIL §3.6.4); at cast-off she goes 20 m out along `wb`.

**Public** (`publicState.quay`): `{ name, cls }` while moored at a quay — other skippers' labels say where she lies.

## 5. Client (phase 1, built)

| File | Role |
|---|---|
| `public/js/quayfmt.js` | pure: `cardModel`, `cardHTML`, `mooredModel`, `mooredHTML`, `serviceRows`, `pickCandidate`, `slotOutline`, `faceFrame`, `facePoint` |
| `public/js/quayui.js` | `class QuayUI(app)`: `toggle()` (Q), `onQuays(msg)`, `update(dt, now)` (outline + card refresh), buttons `moor` / `tugs` / `prev` / `next` / `tab:<id>` (→ `hud.openHarborTab`) / `castoff` (→ `undock`) |
| `public/css/quay.css` | card styles (loaded by quayui.js itself) |

3D: the whole quay face as a white line, the slot footprint (fill + outline) green / amber, chevrons on the water side
every 40 m, a light column on the slot centre; placed in the face's frame at tide level + 0.4 m.

## 6. Tests (phase 1)

* `test/quays.test.mjs` — rules and exact price math; staircase merging; **Rotterdam fixtures**: > 300 runs, ≥ 10 runs
  ≥ 300 m, water 8 m off / land 8 m behind ≥ 85 % of steps, all classes present, deterministic; a 300 m container ship
  fits only at a handful of long deep terminal walls (each fitting slot ≥ 330 m, ≥ 14.7 m at LW), not at the shallow river
  quay, not at the narrow-basin pier ("Too narrow … 49 m"); occupied by an AIS vessel → refused, a coaster still fits
  clear of her, far hulls and ships under way do not count; harbour berths and restricted areas cut; query list order,
  price, tier, tabs; analysis budget (`pending`) converges to the same answer; dock / tug checks; saved berth; cast-off
  point; memguard shed / critical; occupant collection.
* `test/quaygame.test.mjs` — query → dock → 2.5 days → cast off with exact money (day 1 + dues + pilotage, then 8 250);
  refusals (speed, money, hail, occupied by another skipper); tugs incl. restart; service gates (refused, trucking +6 %,
  fuel cap, office by phone, harbour berths untouched).
* `test/quayui.test.mjs` — card model / HTML (escaping, buttons, disabled tabs), outline geometry, moored panel.

## 7. Open points / defaults chosen

| # | Question | Default |
|---|---|---|
| Q1 | Quays inside harbour patches | offered too, except within 35 m of a patch berth (those keep Moor/Tugs) |
| Q2 | Contract delivery at a near quay | no — deliver at the harbour (keeps routes meaningful) |
| Q3 | Fixture coverage | Rotterdam only in the tests; the 12 other recorded ports work the same (no port-specific code) |
| Q4 | Bridges' air draft | a berth never sits within width/2 + 15 m of a bridge; air draft on the route is WORLD-DETAIL phase 3 |
| Q5 | Restricted areas (naval bases, ferry berths) | hook `game.quayForbidden(lat, lon)`; no data source yet |
| Q6 | Tug paths to quays | straight-line walk with a water check; planned paths (`tugassist.js`) need a patch — later |
