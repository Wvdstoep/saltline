# Saltline v6 fleet — phase 2: the edits to existing files

Companion to `docs/V6-FLEET-CONTRACTS.md` (the spec). Phase 1 (2026-10-08) created only new files:

| New file | What |
|---|---|
| `shared/fleet.js` | §4, verbatim (frozen) |
| `server/vessel.js` | §3.2, verbatim |
| `server/fleet.js` | `Fleet`: index, migration (`adoptPlayer`, `afterLoad`, `createFirstVessel`), ledger (`book`, `charge`, drift, owed), office, buy/sell without trade-in, transfers, orders, switching, berths (`berthsTaken`, `berthUse`, `freeBerth`), hulls, `tick`, `daily`, `sinkVessel`, wire views (`viewFor`, `snapFull`, `youFields`, `harborFields`, `fleetView`), `stats`, `advance` (tests / debug) |
| `server/captain.js` | `setOrder`, `stepVessel`, `onArrived`, departures, arrivals (tugs → pilot fallback), contracts, holding, give way, storms, task text |
| `public/js/fleetfmt.js`, `public/js/fleet.js`, `public/js/hq.js`, `public/css/fleet.css` | Lane B client (not imported yet) |
| `docs/fixtures/fleet.sample.json` | written by `test/fleet-model.test.mjs` (deterministic) |
| `test/fleet-{shared,model,buy,office,switch,captain,perf,client}.test.mjs`, `test/fleet-helpers.mjs` | 80 tests: 64 run now, 16 marked `PHASE2` (skipped until the hooks below exist) |

Phase 2 = the hooks below, in this order, after the OSM/harbour agent has merged and `npm test` is green.
**Everything in steps 1–4 was applied to a scratch copy of the tree (game.js as of 2026-10-08 ~19:00 UTC) and verified:**
all 80 fleet tests pass with the `PHASE2` skips removed, and `game` (1 test edit, step 5), `jobs`, `tugs`, `tugs-review`,
`warp`, `timemodel`, `warp-harbour`, `express-safe`, `berthguide`, `market`, `telegraph`, `route-planner` stay green.
(`world-coverage` and `world-routes-draft` were not run.)

**Fast path:** `python3 <scratchpad>/fleetwire/apply-phase2.py <saltline root> --tests` applies steps 1–4 and the test
flip of step 5 (not the `game.test.mjs` edit). Every edit is anchored on an exact statement; a drifted anchor aborts with its
name and writes nothing. The code below is what it inserts, for review or by-hand application.
Scratchpad = `/tmp/claude-0/-home-user/0e451cf3-a540-5510-b1a6-978d07bae2ed/scratchpad`.

---

## 0. Before deploying (integrator, §3.4)

Copy `data/state.json` → `data/state.pre-v6-<iso>.json` before the first v6 start (v5 cannot read a v6 file). Release
note: to roll back, stop the server and restore that file; progress since the upgrade is lost.

## 1. `server/game.js` (§11.2) — by function and anchor statement

1. **imports** — after `import { lowWaterAt } from '../shared/tide.js';`
   ```js
   import { Fleet } from './fleet.js';                             // v6 fleet (docs/V6-FLEET-CONTRACTS.md)
   ```
2. **constructor** — between `this.eventSeq = 1;` and `this.loadState();`
   ```js
   this.routePlanner = opts.routePlanner || null;   // v6 fleet: captains plan their passages with the shared planner
   this.fleet = new Fleet(this);                   // v6 fleet: vessels, office, captains (before loadState)
   ```
3. **loadState**
   - players loop: `p.online = false; p.hail = null; p.fishing = false;` + `this.migratePlayer(p);` becomes
     ```js
     p.online = false; p.hail = null;
     this.fleet.adoptPlayer(p);                    // v6: ship fields move onto the vessel records
     p.fishing = false;
     this.migratePlayer(p);
     ```
     (`p.fishing = false` must come after `adoptPlayer`: before it, it would create a person-level key that adoption drops.)
   - after the `for (const p of this.players.values()) for (const j of p.jobs || []) maxJob = …` line:
     ```js
     for (const v of this.fleet.vessels.values()) for (const j of v.jobs || []) if (j && typeof j.id === 'string') maxJob = Math.max(maxJob, parseInt(j.id.slice(1), 36) + 1 || 1);
     ```
     (it scans the aboard ships again — harmless.)
   - after the market-drift line `if (Number.isFinite(savedAt)) { const hours = …; driftEconomy… }`:
     ```js
     this.fleet.afterLoad(savedAt);                  // v6: captained ships migrate, storage dates shift by the downtime
     ```
4. **saveState** — in the players spread remove `fishing: false, ` (→ `({ ...p, hail: null, online: false, warp: 1, … })`);
   in `s` add `fleetSchema: 1,` (`savedAt: …, fleetSchema: 1, simTime: …`).
5. **findOrCreatePlayer** — the new-player literal loses the vessel keys; the first vessel is created right after:
   ```js
   p = {
     id: shortId(), token: token(), name: cleanName(name) || `Skipper-${Math.floor(Math.random() * 900 + 100)}`,
     createdAt: Date.now(), money: START_MONEY, wanted: 0, wantedAt: 0, convoyId: null, lastInspected: -1e9, lastSeen: Date.now(),
     stats: { delivered: 0, earned: 0, sunk: 0, inspected: 0, fined: 0, caught: 0, boarded: 0, pirated: 0, distanceKm: 0, collisions: 0 },
     shallowSince: 0, log: [],
     warp: 1, warpRouted: false, warpGraceUntil: 0, warpGraceFactor: 1, warpRun: null,
   };
   // v6: the ship fields of today's literal live on the first vessel (Sea Bee), same values
   this.fleet.createFirstVessel(p, { cls: 'coaster', spawn, berth, harbor: START_HARBOR });
   this.players.set(p.token, p); this.byId.set(p.id, p);
   ```
6. **startBerth** — the two lines `const used = new Map();` + `for (const q of this.players.values()) if (q.docked === h.id …) used.set(…);` →
   `const used = this.fleet.berthUse(h.id);`
7. **nearBerthFor** — `const occupied = new Set();` + its players loop → `const occupied = this.fleet.berthsTaken(harbor.id, p.vessel);`
8. **tugAssist** — `const taken = new Set();` + its players loop → `const taken = this.fleet.berthsTaken(harbor.id, p.vessel);`
   (behaviour note: today's loop ignored offline skippers' moored ships; `berthsTaken` counts every vessel — a captain
   or an offline skipper's ship really is lying there. No existing test depends on the old rule.)
9. **publicState** — after `tugs: tugsPublic(this, p),`: `vid: p.vessel?.id ?? null, vname: p.vessel?.name ?? null,`
10. **privateState** — before `convoy: …`: `...this.fleet.youFields(p),`
11. **send** — first statement `if (p.isActor) return;` · **event** — first statement
    `if (p.isActor) return this.fleet.actorEvent(p, kind, text, extra);` · **sendYou** — `if (p.isActor) return;` ·
    **sendHarbor** — first statement `if (p.isActor) return;`, and the harbour object gains, after `dockedPlayers: […]`,
    `...this.fleet.harborFields(p, h)`.
12. **disconnect** — after `this.cancelOffersOf(p);`: `this.fleet.unwatch(p);`
13. **onState** — first statement `if (m.vid != null && m.vid !== p.aboard) return;`
14. **onAction** — `case 'buy_ship': return this.fleet.buyShip(p, m);` · `case 'buy_used': return this.fleet.buyUsed(p, m);`
    (the routers call today's `this.buyShip(p, m.cls)` / `this.buyUsedShip(p, m.listingId)` when `m.tradeIn !== false`) ·
    `default: if (this.fleet.handles(a)) return this.fleet.onAction(p, m); this.event(p, 'warn', \`Unknown action ${a}\`);`
15. **undock** — `const fee = days * berthFeePerDay(p.ship.cls);` →
    `const fee = p.docked === this.fleet.homeOf(p) ? 0 : days * berthFeePerDay(p.ship.cls);`
16. **tick**
    - move the at-sea block — from `const s = p.ship, C = SHIP_CLASSES[s.cls];` through
      `for (const j of p.jobs) if (j.type === 'tow' && !j.spotOk && !j.pickedUp) this.ensureTowSpot(j);` — verbatim into a
      new method placed before `requestWeather` (comment `// Keep the weather cache warm…`):
      ```js
      // v6: one player's (or captain's) ship at sea for `simHours` of world time: crew wages (not for captains: the
      // fleet pays them in whole credits), fuel, wear, flooding and pumps, the catch, the tow hand-over.
      stepAtSea(p, simHours) {
        const s = p.ship, C = SHIP_CLASSES[s.cls];
        …the moved block, one indent level less…
      }
      ```
      and call `this.stepAtSea(p, simHours);` in its place (the wanted-decay line stays in the loop);
    - inside the moved block: `if (underway && C.crewCost) p.money = …` → `if (underway && C.crewCost && !p.isActor) p.money = …`;
    - after the player loop, before `this.updateCutters(dt);`: `this.fleet.tick(dt);`
17. **requestWeather** — after the `for (const p of this.byId.values()) { … }` that fills `ships`/`online`:
    `for (const s of this.fleet.weatherPoints(50)) ships.push(s);`
18. **expressOthers** — after `for (const w of this.wrecks || []) push(w, 60);`:
    `for (const o of this.fleet.hullsNear(lat, lon, rangeM, p.vessel)) out.push(o);`
19. **simulateOffline** — `p.voyage = null; s.throttle = 0;` → `p.voyage = null; s.throttle = 0; p.voyageEnd = 'arrived';`;
    in the shoal line `s.spd = 0; p.voyage = null;` → `s.spd = 0; p.voyage = null; p.voyageEnd = 'shoal';`
20. **broadcastSnapshot** — per socket:
    ```js
    const full = this.fleet.snapFull();   // before the loop: every 10th snapshot also lists moored/anchored/laid-up ships
    …
    const fl = p ? `,"fleet":${JSON.stringify(this.fleet.viewFor(p, full))}${full ? ',"fleetFull":true' : ''}` : '';
    ws.send(ai.length ? `${prefix},"ai":${JSON.stringify(ai)}${fl}}` : `${prefix},"ai":[]${fl}}`);
    ```

Unchanged on purpose (the fleet runs them through actors): `buyShip`, `buyUsedShip`, `sellShip`, `sink`, `finishRescue`,
`forcedReset`, the warp section, `advanceShipClock`, `shipRate`, `acceptJob`, `deliverJobs`, `payJob`, `finishDock`,
`moorAt`, `setDocked`, `dock`, `tow`, `deliverOffshore`, `setFishing`, `stepAssist`, `migratePlayer`.

## 2. `server/tugassist.js` — `tickTugs`

`const p = game.byId?.get(op.pid) || game.players?.get(op.pid);` →
`const p = game.byId?.get(op.pid) || game.players?.get(op.pid) || game.fleet?.actorById?.(op.pid) || null;`
(verified by the phase-2 test "a captain berths with the cached Rotterdam tugs": the op is never sent home early.)

## 3. `server.js`

- `game = new Game(world, log, { weather, traffic, harborgeom, routeTable });` → `{ weather, traffic, harborgeom, routeTable, routePlanner }`
  (`routePlanner` is already constructed two lines above).
- after the `/api/players` route: `app.get('/api/fleetstats', (req, res) => res.json(game.fleet.stats()));`
- `SALTLINE_DEBUG=1` enables `fleet_debug` (money / place / advance / storm); nothing else to wire.

## 4. `.gitignore`

Add `data/state.pre-v6-*.json`.

## 5. Tests

- In every `test/fleet-*.test.mjs`: `const PHASE2 = { skip: 'needs game.js wiring (phase 2)' };` → `const PHASE2 = {};`
  (the Rotterdam-tug test additionally skips itself when `data/geom/rotterdam.*` is missing, the `haveRot` pattern).
- **One existing test changes** — `test/game.test.mjs` "berth fee per started day on undock, pilotage …, service resets
  the wear ramp": the skipper undocks at Rotterdam, which is now her home (F9: no berth fee at home). After
  `const g = mkGame(); g.rnd = () => 0.99; const { p, ws } = join(g, 'Gi'); p.money = 100000;` add
  ```js
  p.office.home = 'hamburg'; // v6: no berth fee at home — this test is about the fee, so her office is elsewhere
  ```
- Then `node --test test/fleet-*.test.mjs` (80 pass) and `npm test`.

## 6. Client (Lane B, §12.2) — `public/js/*`

fleet.js already provides everything the screens need (`FleetUi`: `onFleet`, `onBoard`, `tabOffice`, `sheetAction`,
`updateChip`, `switchFade`, `tradeInBoxHTML`, `netPrice`, `buyBlocked`, `buy`, `drawChartLayer`, `chartHits`,
`chartPopup`, `shipsListHTML`; it injects the top-bar chip `#fleetChip`, the More-sheet button and the harbour sheet's
Office nav button + `<section id="tab-office">` itself). The HQ is `app.hq` (`open`, `close`, `toggle`, `onFleet`, `focus`).

### `main.js`

1. **constructor** — after the `tugs.js` import:
   ```js
   // v6 fleet (fleet.js, hq.js): harbour Office tab, fleet dialogs, the top-bar chip and the Fleet HQ (O)
   this.fleetShips = new Map();   // snap.fleet (FleetPublic): fleet ships near you, drawn like AI traffic
   import('./fleet.js').then((m) => { this.fleetUi = new m.FleetUi(this); }).catch((e) => console.warn('[fleet] unavailable', e));
   import('./hq.js').then((m) => { this.hq = new m.Hq(this); }).catch((e) => console.warn('[hq] unavailable', e));
   ```
2. **onMessage**
   ```js
   case 'you': this.onYou(m.you, false, !!m.correction, !!m.switched); break;
   case 'fleet': this.fleetUi?.onFleet(m.fleet); this.hq?.onFleet(m.fleet); break;
   case 'fleet_board': this.fleetUi?.onBoard(m); break;
   ```
3. **onYou(you, first, correction, switched)**
   - after `this.you = you;`: `this.net.vid = you.aboard;`
   - `hard` gains `|| (!!prev && prev.aboard !== you.aboard)`;
   - the mesh rebuild condition `if (!this.myMesh || prev?.ship.cls !== s.cls)` gains `|| prev?.aboard !== you.aboard`
     (camera re-sized there already: `this.cam.dist = camDistFor(this.shipLength())`);
   - at the end:
     ```js
     if (switched) {   // v6 §8.4: a new ship under you
       if (this.interior.active) this.interior.exit();
       if (this.ashore?.active) this.ashore.exit?.();
       this.clearRoute(); this.autopilot = false; this.warp = 1;      // the server already reset warp; no event
       this.input.throttleCmd = 0; this.input.rudderCmd = 0; this.touchHelm?.setThrottle?.(0);
       this.fleetUi?.switchFade(you);
       if (you.docked) this.net.action('dock');                       // a fresh harbour sheet for her harbour
     }
     ```
4. **onSnap** — after the AI block: `if (Array.isArray(m.fleet)) this.syncFleet(m.fleet, !!m.fleetFull, now);` and the new method:
   ```js
   /** v6: fleet ships (snap.fleet) drawn and interpolated like AI traffic; labels "<ship> · <owner>" / "· yours" / "· laid up". */
   syncFleet(list, full, now) {
     const seen = new Set();
     for (const f of list) {
       seen.add(f.id);
       const own = f.ownerId === this.you?.id, cls = SHIP_CLASSES[f.cls] ? f.cls : 'coaster';
       const label = `${f.name} · ${f.state === 'laid_up' ? 'laid up' : own ? 'yours' : f.owner}`;
       let o = this.fleetShips.get(f.id);
       if (!o) { o = { id: f.id, cls, mesh: buildShip(cls, label, hashStr(f.id) % 97 + 1), samples: [], cur: { lat: f.lat, lon: f.lon, hdg: f.hdg, spd: f.spd }, vis: { heave: 0, pitch: 0, roll: 0 }, label }; this.scene.add(o.mesh); this.fleetShips.set(f.id, o); }
       else if (o.cls !== cls) { this.drop(o.mesh); o.cls = cls; o.mesh = buildShip(cls, label, 5); this.scene.add(o.mesh); }
       if (o.label !== label) { o.label = label; o.mesh.userData.label?.userData.setText(label); }
       Object.assign(o, { name: f.name, owner: f.owner, ownerId: f.ownerId, state: f.state, cond: f.cond, fishing: !!f.fishing, towing: !!f.towing, towCls: f.towCls || null });
       o.mesh.userData.setWear?.(1 - (f.cond ?? 100) / 100);
       o.samples.push({ t: now, lat: f.lat, lon: f.lon, hdg: f.hdg, spd: f.spd }); if (o.samples.length > 4) o.samples.shift();
     }
     for (const [id, o] of this.fleetShips) if (!seen.has(id) && (full || o.state === 'at_sea')) { this.drop(o.mesh); this.fleetShips.delete(id); }
   }
   ```
   and in the frame loop next to `for (const a of this.ai.values()) { this.interp(a, now); this.shipVisual(…) }`:
   `for (const f of this.fleetShips.values()) { this.interp(f, now); this.shipVisual(f.mesh, f.cur.lat, f.cur.lon, f.cur.hdg, f.state === 'at_sea' ? f.cur.spd : 0, f.vis, 0, dt, f.state !== 'at_sea'); }`;
   add `...this.fleetShips.values()` to the recentre wake loop and the lights loop (the two `[...this.others.values(), …, ...this.ai.values()]` lists).
5. **upsertOther** — a skipper who switched ships must not glide across the map:
   `} else if (o.cls !== p.cls) {` → `} else if (o.cls !== p.cls || (p.vid && o.vid && o.vid !== p.vid)) {` and inside that branch add `o.samples = [];`;
   after it: `o.vid = p.vid;` and when `p.vname` changes `o.mesh.userData.label?.userData.setText(p.vname ? \`${p.name} — ${p.vname}\` : p.name)`.
6. **collisionOthers** — `for (const f of this.fleetShips.values()) { if (f.state === 'docked' || f.state === 'laid_up') continue; push(f, SHIP_CLASSES[f.cls] || f.mesh.userData); }`
7. **bindInput** keydown — next to `if (k === 'l') return this.market?.toggle();`: `if (k === 'o') return this.hq?.toggle();`
8. **drawRadar** — after the AI contacts:
   `for (const f of this.fleetShips.values()) contacts.push({ kind: 'ai', lat: f.cur.lat, lon: f.cur.lon, hdg: f.cur.hdg, spd: f.cur.spd, color: f.ownerId === this.you?.id ? '#6fe3d6' : '#c8d6e2', label: f.name, state: f.state === 'at_sea' ? 'underway' : 'moored' });`

### `net.js` — `sendState`

`this.send({ t: 'state', lat: …, rudder: s.rudder });` → add `vid: this.vid` (set by `main.js onYou`).

### `hud.js`

1. `const TABS = [... 'shady', 'players'];` → insert `'office'` before `'players'`; `TAB_ALIAS` gains `office: 'office', fleet: 'office', storage: 'office'`.
2. **renderTab** — `case 'office': html = this.app.fleetUi ? this.app.fleetUi.tabOffice(h, you) : ''; break;`
3. **sheetAction** — after `case 'castoff': return a.castOff();`: `default: if (act && act.startsWith('fl')) return this.app.fleetUi?.sheetAction(act, el);`
4. **tabShipyard** — after `<div class="yardBar">${seg}${chips}</div>` insert `${this.app.fleetUi?.tradeInBoxHTML(h) || ''}`; the header
   sentence "traded in automatically when you buy" → "…when you tick the box below" (`fleetUi.tradeIn`).
5. **shipCard** — `const net = price - tradeIn;` → `const net = this.app.fleetUi ? this.app.fleetUi.netPrice(price, this.harborData) : price - tradeIn;`;
   the net line shows `Net after trade-in` only when `this.app.fleetUi?.tradeIn`; the Buy buttons are also disabled with
   the title `this.app.fleetUi?.buyBlocked(this.harborData)` when it returns a reason.
6. **sheetAction** `case 'ship'` / `case 'used'` — first line:
   `if (a.fleetUi) { const C = SHIP_CLASSES[el.dataset.cls]; a.fleetUi.buy('new', el.dataset.cls, C?.price ?? 0, C?.name || el.dataset.cls, this.harborData, you); $('compareWrap').classList.add('hidden'); return; }`
   and for used: `const l = (this.harborData?.used || []).find((x) => x.id === el.dataset.id); a.fleetUi.buy('used', el.dataset.id, l?.price ?? 0, l?.name || 'hull', this.harborData, you);`
7. **renderShips** — before ``html += `<h3 class="subHead">${ic('radar')}Shipping traffic (AIS)</h3>`;`` add
   `html += this.app.fleetUi?.shipsListHTML?.(km) || '';` (the "Fleet ships" section, no Board/Trade/Convoy).
8. **updateTop** — at the end: `this.app.fleetUi?.updateChip(you);`
9. `closeOverlays()` — add `this.app.hq?.close?.();` so the HQ closes like the other sheets.

### `chart.js`

1. `this.layers = { …, market: false }` → add `fleet: true`.
2. **draw** — after `if (this.layers.ships) this.drawShips();`: `if (this.layers.fleet) this.app.fleetUi?.drawChartLayer(this, this.ctx);`
3. **hitShip** — before `return best;`: `if (this.layers.fleet) this.app.fleetUi?.chartHits(consider);`
4. **showShipPopup** — first line inside the `openPopup` callback after the title: `if (hit.kind === 'fleet') { this.app.fleetUi?.chartPopup(hit, body); return; }`
   (and a layer toggle button "Fleet" next to the market one, if the layer menu lists layers by hand).

### `tugs.js` — `onMessage`

After the `players` line: `if (m.t === 'snap') for (const f of m.fleet || []) if (Array.isArray(f.tugs)) for (const t of f.tugs) this.upsert(f.id, t, now);`

### `ashore.js`

At the POI build `const info = POI_INFO[P.kind]; if (!info) continue;` →
```js
const info = P.kind === 'harbourmaster' && this.app.you?.home === this.harborId ? HOME_OFFICE : POI_INFO[P.kind]; if (!info) continue;
```
with, next to `POI_INFO`:
```js
const HOME_OFFICE = { ...POI_INFO.harbourmaster, tab: 'office', label: 'Harbourmaster & your office — contracts, boards and your fleet', short: 'Harbourmaster & your office' };
```
(`interact()` already opens `p.info.tab`.)

### Fixture mode (§10.3, optional)

`?fixture=fleet` for development: in `main.js onWelcome`, when `new URLSearchParams(location.search).get('fixture') === 'fleet'`,
`fetch('/docs/fixtures/fleet.sample.json').then((r) => r.json()).then((fx) => { this.fleetUi?.onFleet(fx.fleet); this.hq?.onFleet(fx.fleet); })`.
The standalone page `<scratchpad>/pw/fleet-www/hq-test.html` (served by `pw/fleet-static.mjs` on port 3226, screenshots by
`pw/fleet-shots.mjs desktop|mobile`) renders the HQ and the Office tab from the fixture without the game.

## 7. Decisions taken in phase 1 (and where the contract was read loosely)

1. **Stepping cadence (§11.4):** "moving" ships far from everyone are bucketed like idle ones (stepped every 10th tick
   with the accumulated dt); only ships under tugs or within 40 km of an online skipper step every tick. That is the
   only reading consistent with the budget (≈ 100 stepped per tick for 1,000 far ships) and with `fleet-perf`.
2. **Perf:** real game, 300 far ships: 3.0–3.9 ms mean `fleet.tick`; 1,000 far ships: **7.4 ms** (target 4 ms). The cost
   is `shared/tide.js tideAt` inside `simulateOffline`, called once per 0.5 s substep. With 1 s substeps for far ships the
   1,000-ship figure is 4.6 ms. Kept 0.5 s (contract); options: let far ships use 1 s substeps, or cache `tideAt` per
   0.1° cell and minute in `simulateOffline`.
3. **Give way reach:** `separation(L) + their length / 2` **plus 40 s of her own way** (≈ 230 m at 11 kn): with the bare
   separation two 11-kn coasters on reciprocal courses close the 345 m in ~30 s, too late for a 30° turn to keep 150 m.
4. **Ledger categories through actors:** `actor._cat` may be a list consumed one cost at a time — `tow` books
   `['tugs', 'port']` (the tow, then the dues of the arrival `finishDock` charges); `stepAssist` runs with `'port'` so the
   dues at the end of a captain's tug assist are not "costs".
5. **Cash never below 0 via actors:** `actorMoney` clamps a rounded debit to `-floor(money)` (a fractional balance
   could otherwise go to −0.4).
6. **`owedCap`** is at least the bill being charged now (else a ship that just went idle would wipe her own last wage bill).
7. **Drift booking** books the net of a tick: delivery pay and port dues in the same `finishDock` show as one income line
   for the aboard ship (display data, §3.6).
8. **Launch vs helicopter** text: launch up to 200 km, helicopter beyond (the contract's example is a launch at 182 km).
9. **Fishing haul:** when the time left forces her home short of the quantity, the job gets `capHaul: true` so the next
   target is the port, not the ground again.
10. **Absent owner (§7.10):** applies to anchored/holding ships whose order is `hold` (the default when you leave a ship).
11. **Contraband:** a captain refuses to depart with contraband aboard (`fleet_order` and the departure check), so port
    inspections of captained ships never find any.
12. **`task.text`** carries no ETA; the client appends "· ETA Thu 14:20 UTC" from `task.etaS` (`fleetfmt.fmtTask`).
13. **Fixture:** 4 ships (the contract's 3 + a feeder on passage to Hamburg with freight, for the route/ETA drawing); additive.
14. **Money chart** is inline SVG (crisper on phones, re-rendered with the rest of the tab) rather than a canvas.
15. `test/fleet-helpers.mjs` (FakeGame) is a helper module shared by the fleet tests (not a `*.test.mjs` file).
16. `fleet.advance(v, s)` moves `game.simTime` along (tests); the `fleet_debug advance` action passes `{ clock: false }`
    so the live world clock is not touched.
