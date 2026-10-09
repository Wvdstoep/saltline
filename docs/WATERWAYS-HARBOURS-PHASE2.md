# Waterways lane D — inland harbours, marinas and inland contracts: phase 2 (integration hooks)

Status: phase 1 done (2026-10-09): **new files only**, `node --test test/inland-*.test.mjs` green (32 tests).
Contract: `docs/BRIDGES-LOCKS-VHF-CONTRACT.md` §7 (lane D), §9.4, §10.8. No existing file was edited; this document lists
the exact edits the integration pass (§9.6) makes. Every hook is inert when its object is missing (`SALTLINE_WW_OFF=1`
→ `game.mh = null`, all hooks below are `?.` calls), so no existing test changes.

## 0. What phase 1 delivered

| File | What |
|---|---|
| `shared/mharbour.js` | Pure rules: `classifyTags` / `classifyFis` (§7.3 tiers marina, passant, city, inland_port, fishing, ferry), `harboursFromOverlay(ov, {x12, y12, fis, named, townAt})` (one z12 square → harbour records: tagged seeds merged ≤ 150 m, pontoon / finger-pier clusters ≤ 120 m attach ≤ 250 m or become an **inferred** marina `e: 2`, services ≤ 300 m, quays, FIS ↔ OSM merge ≤ 150 m with the FIS id/name/numbers), `berthsOf` (numbered marina boxes on both sides of each pontoon, 8/10/12/15/20 m → 3.0/3.5/4.0/4.5/5.5 m; passant sides with rafting; place-count berths for FIS-only harbours), `boxFits` / `sideFits` / `fitSummary` / `depthOf`, `nightFee` (§7.5), `servicesOf`, `layerServices` (better-of with the dock-anywhere tier), `vhfOf` (data, else simulated ch 31 NL / ch 9 abroad), `subOf` (sub-harbour inside `PORT_RADIUS_KM`), `harbourCard`, `chartRow`, `markerSpec` (3D: hut + flag, sign, box posts, berth outlines for lane C's `public/js/mharbour.js`), `inlandMarket` (3–5 goods, ±6 %, 10 % stock; fish only at fishing harbours) |
| `server/minorharbours.js` | `createMinorHarbours(opts)`: per-square generation from the overlay (+ FIS), LRU ≤ 3,000 harbours, memguard (warm: no background squares, shed: only `keepSquares()`, critical: none), `ensureNear`, `near`, `harboursIn`, `inBbox` (chart, zoom ≥ 11), `sheet` (card on demand), `reach` (planInland, cached 10 min per profile × harbour), `harboursOn` (radio), `servicesAt` (berth services layer), `markers`, `shed`, `stats`; `diskOverlayReader(dataDir)` (read-only), `tileDepthSampler`, `shipDimsOf`, `squaresUnder` |
| `server/inlandjobs.js` | Families `barge_bulk`, `barge_container`, `barge_tanker`, `charter_day` (+ inland `lesson` tasks lock / bridge / box), `INLAND_TERMINALS` seed (7 NL terminals, `verify: true`), `generateInlandJob`, `boardFor(h, o)` (marina ≤ 4, passant ≤ 2, inland port ≤ 6), `inlandCanDo` (canDo + family hull + CEMT class of the route + best-case air draught under its fixed bridges + re-plan) |
| `server/inlandlink.js` | `loadLaneA()` → lane A's `shared/airdraft.js`, `shared/waterworks.js`, `server/inland.js` when present (verified: **all three are now merged and used**, `src: {air, cemt, plan}: 'laneA'`), else lane D stand-ins; `bestAirDraft` composer, `plannerShip`, stand-in `stubPlanInland` / `explainBlock` on a small graph format, `routeKm` / `routeHours` (lane A `distM` / `timeS` understood) |
| `shared/inlandshim.js` | Stand-in for lane A rules (§4.4 air draught with the explicit rows + barge rows, §4.10 CEMT table, `passVerdictLite`); reproduces every §10.1 number |
| `shared/ships/barges.js` | 8 barge models (Model shape, §2.4 formulas): `spits38` I, `kempenaar55` II, `dortmunder67` III, `rhk85` IV, `grk110` Va, `cbarge135` Vb (208 TEU, 4 tiers), `tbarge110` Va (2,800 m³), `push4` VIb; `BARGE_AD` air-draught rows (wheelhouse +5.5 m, masts +1.5 m), `withBarges(src)` ship source |
| `public/js/mhchart.js` | Chart layer `MHChartLayer` (`drawChartLayer`, `chartHits`, `card`), pure `symbolSpec`, `bboxKey`, `visibleRows`, `cardLines`, `cardHTML` |
| tests | `test/inland-classify`, `inland-fixture` (Rotterdam + Hamburg recorded overlays, Rotterdam z14 tiles), `inland-stream`, `inland-barges`, `inland-jobs`, `inland-chart`; fixtures `test/fixtures/mh/fis-harbours.json`, `test/fixtures/mh/graph.json` (both marked synthetic) |

Measured with lane A's shipped `server/waterworks/nl-fis.json.gz`: 994 FIS harbours (802 marina, 192 passant; 986 inside
the NL outline) in 359 z12 squares. Within 25 km of Amsterdam: 149 harbours, cards with real reachability
("With openings (1 lock, est. +21 min)", "No: Erasmusbrug Noord Rotterdam (too high)").

## 1. Ships catalogue and air draught (do first)

**1.1 `shared/ships/index.js`** — after the line `import { classRow, priceBasis } from './rows.js';`:

```js
import { BARGE_MODELS } from './barges.js';                                     // inland barges (BRIDGES-LOCKS-VHF §7.6)
```

and replace the line `export { MODELS, MODEL_IDS, LEGACY_ROWS, SAIL_IDS, TYPE_CAT } from './catalogue.js';` with:

```js
export { LEGACY_ROWS, SAIL_IDS, TYPE_CAT } from './catalogue.js';
export const MODELS = Object.freeze({ ...CAT_MODELS, ...BARGE_MODELS });
export const MODEL_IDS = Object.keys(MODELS);
export { BARGE_MODELS, BARGE_IDS, BARGE_AD, bargeCemt } from './barges.js';
```

and change the first import to `import { MODELS as CAT_MODELS, MODEL_IDS as CAT_IDS, LEGACY_ROWS, SAIL_IDS, TYPE_CAT } from './catalogue.js';`
(every later use of `MODELS` in index.js then sees the barges). `test/ships-catalogue.test.mjs` counts `catalogue.js MODELS`
(76) and is unaffected. Yard capability: barges use `builders: ['inland']` — add `'inland'` to the `builds` list of the
Dutch / German inland yards in `shared/ships/yards.js` (ships lane owner decides which), else they are local-yard only.

**1.2 `shared/airdraft.js`** (lane A) knows only catalogue models. In `server/game.js` next to the other imports:

```js
import { registerProfiles } from '../shared/airdraft.js';
import { BARGE_AD } from '../shared/ships/barges.js';
registerProfiles(BARGE_AD);                                                       // barge air-draught rows (§7.6)
```

(after 1.1, `profileOf('grk110')` reads capacity / fuel from the merged MODELS; before 1.1 it would fall back to the coaster.)

## 2. `server/game.js`

**2.1 Import** — after the line `import { quayQuery, quayDock, … } from './quaygame.js'; // DOCK ANYWHERE`:

```js
import { createMinorHarbours, diskOverlayReader, tileDepthSampler, squaresUnder } from './minorharbours.js';   // inland harbours (§7)
import { boardFor as mhBoardFor, INLAND_TERMINALS } from './inlandjobs.js';
import { loadLaneA, stubLaneA } from './inlandlink.js';
import { DATA_DIR } from './world.js';
```

**2.2 Construct** — after `this.loadState();` (constructor, before `this.initHarbors();`; lane A's block from
docs/WATERWAYS-LANE1-PHASE2.md §3b — `this.wwOn`, `this.levels`, `this.ww` — runs earlier, after `this.routePlanner = …`):

```js
    // lane A data for lane D: the FIS tourist harbours (994) and the game-side inland graph for the harbour card's reach
    // (the route worker builds its own copy, docs/WATERWAYS-LANE1-PHASE2.md §5)
    this.mhFis = this.wwOn ? (opts.fis !== undefined ? opts.fis : loadFis()) : null;
    this.inlandGraph = this.mhFis ? buildGraph(this.mhFis, { levels: this.levels }) : null;   // ≈ 1 s once at start
    // INLAND HARBOURS (§7): generated per z12 square from the overlay as ships sail; ≤ 3,000 in memory
    this.mh = process.env.SALTLINE_WW_OFF === '1' ? null : createMinorHarbours({
      named: HARBORS, fis: this.mhFis, graph: this.inlandGraph, guard: opts.memGuard || null, lane: stubLaneA(),
      readOverlay: opts.readOverlay || diskOverlayReader(DATA_DIR),
      keepSquares: () => squaresUnder([...this.byId.values()].filter((p) => p.online && p.ship).map((p) => p.ship), 25),
      sampleDepth: opts.quaySample ? tileDepthSampler(opts.quaySample, lowWaterAt) : null,
      market: (id) => { try { return marketSnapshot(this).harbors.find((h) => h.id === id) || null; } catch { return null; } },
      jobs: (h) => (this.mhBoards?.get(h.id) || null),
      log: (...a) => this.log(...a),
    });
    this.mhBoards = new Map();                                                    // minor harbour id → board (regenerated every 24 h)
    loadLaneA().then((l) => this.mh?.setLane(l)).catch(() => {});
```

(`lowWaterAt` from `../shared/tide.js`, `marketSnapshot` from `./market.js`, `buildGraph` from `./inland.js` — add them to the
imports if absent; `loadFis` is already imported by lane A's wiring.)

**2.3 Radio** — in lane B's `createRadio(this, this.ww || null, { … })` options (docs/WATERWAYS-RADIO-PHASE2.md §2.2), add:

```js
      harboursOn: (ch, lat, lon) => this.mh?.harboursOn(ch, lat, lon) || [],    // harbour masters (§6.3), ch 31 simulated in NL
```

(lane B already maps them to `kind: 'harbour'` and answers `op_hm_goahead`.)

**2.4 Tick** — in `tick(dt)`, after `this.fleet.tick(dt);`:

```js
    if (this.mh && (this._mhAt = (this._mhAt || 0) + dt) >= 10) {              // every 10 s: squares around every ship
      this._mhAt = 0;
      for (const p of this.byId.values()) if (p.ship) this.mh.ensureNear(p.ship.lat, p.ship.lon, 25, { background: !p.online }).catch(() => {});
      // (offline ships at memguard ≥ warm are refused inside ensureNear)
    }
```

**2.5 Actions** — in `onAction`, before `case 'rename': …`:

```js
        case 'mh_query': { const b = String(m.bbox || '').split(',').map(Number); if (this.mh && b.length === 4 && b.every(Number.isFinite)) this.send(p, { t: 'mh_list', harbours: this.mh.inBbox(b, Number(m.z) || 11) }); return; }
```

**2.6 Boards** — a minor harbour board is made when its card is first opened (and every 24 h), in a new method next to
`publicJobs()`:

```js
  mhBoard(h) {
    const b = this.mhBoards.get(h.id);
    if (b && b.at > this.simTime - 86400) return b.jobs;
    const ports = [...INLAND_TERMINALS, ...this.mh.near(h.lat, h.lon, 400).filter((x) => x.tier !== 'ferry')];
    const jobs = mhBoardFor(h, { rnd: Math.random, simTime: this.simTime, ports, graph: this.inlandGraph, lane: this.mh.lane() });
    this.mhBoards.set(h.id, { at: this.simTime, jobs });
    return jobs;
  }
```

and change the `jobs:` option of 2.2 to `jobs: (h) => this.mhBoard(h)`. Accepting a minor-harbour job goes through the
existing `accept_job` path once `findJob` also searches `this.mhBoards` (one line in `acceptJob`:
`|| [...this.mhBoards.values()].flatMap((b) => b.jobs).find((j) => j.id === jobId)`). Eligibility: where `acceptJob`
calls `canDo` for JOB_GEN 8 jobs, use `job.inland ? inlandCanDo(job, p, { ...ctx, lane: this.mh.lane(), graph: this.inlandGraph }) : canDo(...)`.

**2.7 Docking in a minor harbour** — the JobsX step runner (docs/JOBS-LANED-PHASE2.md) resolves `at` ids with
`env.harborById(id)`; give it minor harbours too: `harborById: (id) => harborById(id) || (id?.startsWith('mh:') ? this.mh?.get(id) || INLAND_TERMINALS.find((t) => t.id === id) : null)`,
and when a ship makes fast at a quay / box whose `servicesAt(lat, lon).harbour` is set, call `this.jobsx?.onDock(p, thatHarbour.id)`
in `quayDock` right after the existing `onDock` call for the linked named harbour. Lesson drills count the new actions
`lock_pass` (on lock release with `p.lockStay`), `bridge_req` (lane B `vhf_tx` phrase `req_open` answered with
`op_br_wait`/`op_br_opening`) and `box_moor` (quay dock at a `kind: 'box'` berth).

**2.8 Berth fees and services at minor harbours** — in `server/quaygame.js quayDock`, after the fee is computed:

```js
  const mhs = game.mh?.servicesAt(fit.slot.lat, fit.slot.lon, run.tier);
  if (mhs?.harbour) { const h = game.mh.get(mhs.harbour.id); const fee = nightFee(h, shipDimsOf(s.cls)); if (fee.perNight > 0 && h.tier !== 'inland_port') perDay = fee.perNight; berth.mh = h.id; }
```

and in `quayGate`, before refusing a service, accept it when `layerServices` gives it (`fuel`/`repair` multiplier from
`servicesAt`, market `small`/`fish` through `inlandMarket`). `berth.mh` is saved with dock-anywhere's berth record (§8.3).

**2.9 `you`** — in `privateState(p)`, after `...this.fleet.youFields(p),`:

```js
      mhNear: this.mh && p.ship ? this.mh.near(p.ship.lat, p.ship.lon, 3).slice(0, 3).map((h) => ({ id: h.id, name: h.name, tier: h.tier, vhf: h.vhf })) : undefined,
```

## 3. `server.js`

After `app.get('/api/market', (req, res) => res.json(cachedSnapshot(game)));`:

```js
// INLAND HARBOURS (§7.5): chart rows in a bbox (zoom ≥ 11) and the card on demand (fit / fee / reach for ?player=)
app.get('/api/mh', (req, res) => {
  const b = String(req.query.bbox || '').split(',').map(Number);
  if (!game.mh || b.length !== 4 || !b.every(Number.isFinite)) return res.json({ harbours: [] });
  res.json({ harbours: game.mh.inBbox(b, Number(req.query.z) || 11) });
});
app.get('/api/mh/:id', (req, res) => {
  const p = req.query.player ? game.byId.get(String(req.query.player)) : null;
  const card = game.mh?.sheet(String(req.params.id), p?.ship ? { cls: p.ship.cls, lat: p.ship.lat, lon: p.ship.lon, cargo: p.cargo } : null);
  return card ? res.json(card) : res.status(404).json({ error: 'unknown harbour' });
});
```

Pass `memGuard` in the `new Game(stack, log, { … })` options (anchor `game = new Game(stack, log, { weather, traffic, harborgeom: geom, routeTable, routePlanner });`,
add `memGuard`), and after `attachFinder(...)` (line `attachFinder(game, createQuayFinder({ getTile: wtGet, … }), wtGet);`):

```js
  if (game.mh && game.quayFinder?.sample) game.mh.setSampleDepth(tileDepthSampler(game.quayFinder.sample, lowWaterAt));
```

(or pass `sampleDepth` at construction as in 2.2). Health: add `mh: game.mh ? game.mh.stats() : null` to `/api/health`.
Attribution: the HUD line gains "Harbours NL: © Rijkswaterstaat / Vaarweginformatie.nl (CC0)" next to lane A's.

**Overlay (lane A owns `server/wtsource.js`)**: add the §7.1 clauses to `overlayQuery` —
`nwr["leisure"="marina"](${b});nwr["mooring"](${b});nwr["seamark:type"="small_craft_facility"](${b});nwr["harbour"="yes"](${b});nwr["waterway"="fuel"](${b});nwr["landuse"="port"](${b});`
— keep them in `overlayKind` (return `'harbour'` for `leisure=marina | harbour=yes | landuse=port | mooring=* |
seamark:type=small_craft_facility | waterway=fuel`, so `compactOverlay` keeps them), and extend `KEEP_TAGS` with
`leisure|mooring|harbour|landuse|industrial|capacity|fee|operator|website|vhf|maxlength|maxwidth|maxdraught|CEMT|seamark:harbour:.*|seamark:small_craft_facility:.*|seamark:radio_station:.*`.
`harboursFromOverlay` classifies by tags, not by `k`, so v1 and v2 overlays both work (v1 gives only pontoon-cluster and
small-craft-tag harbours, as the Rotterdam fixture test shows).

## 4. `public/js/chart.js`

**4.1 Layer flag** — in the constructor's `this.layers = { … fleet: true }`, add `mh: true` after `fleet: true`.

**4.2 Draw** — in `draw()`, after the line `if (this.layers.fleet) this.app.fleetUi?.drawChartLayer(this, this.ctx);`:

```js
    if (this.layers.mh) this.app.mhLayer?.drawChartLayer(this, this.ctx);   // inland harbours (§7.5): zoom ≥ 11
```

**4.3 Hits** — in `hitShip`, after `if (this.layers.fleet) this.app.fleetUi?.chartHits(consider); // v6 fleet ships`:

```js
    if (this.layers.mh) this.app.mhLayer?.chartHits(consider);
```

and in `showShipPopup(hit)` (the popup for a hit): `if (hit.kind === 'mh') return this.app.hud?.openMinorHarbour?.(hit.data.id);` as its first line.

## 5. `public/js/main.js`

After `this.fleetUi = null; this.hq = null;`:

```js
    this.mhLayer = null;
    import('./mhchart.js').then((m) => { this.mhLayer = new m.MHChartLayer(this, { fetchImpl: (u) => fetch(u + (u.includes('/api/mh/') ? `?player=${encodeURIComponent(this.you?.id || '')}` : '')).then((r) => r.json()) }); }).catch((e) => console.warn('[mh] unavailable', e));
```

Lane C's `public/js/mharbour.js` 3D markers: instantiate next to `WwMesh` and feed it `markerSpec` objects from a
`GET /api/mh/:id/markers` (add `app.get('/api/mh/:id/markers', (req, res) => res.json(game.mh?.get(req.params.id) ? markerSpec(game.mh.get(req.params.id)) : null))`
to §3) for harbours within 3 km (`you.mhNear`).

## 6. `public/js/hud.js`

**6.1 Import** — after `import { TIER_TABS, SERVICE_TIERS, quayDenies } from '/shared/quayrules.js'; // DOCK ANYWHERE`:

```js
import { cardHTML as mhCardHTML, berthsHTML as mhBerthsHTML } from './mhchart.js';   // inland harbour card (§7.5)
```

**6.2 Open a minor harbour** — new method next to `tabOverview(h, you, C)`:

```js
  async openMinorHarbour(id) {
    const c = await this.app.mhLayer?.card(id); if (!c) return;
    this.mhCard = c;
    this.harborData = { name: c.name, country: c.sub ? '' : 'NL', size: c.tierLabel, mh: c, jobs: c.jobs || [], dockedPlayers: [] };
    this.harborTab = 'overview';
    this.showHarbor(this.harborData);                                             // the existing harbour-sheet frame (hud.js showHarbor)
  }
```

**6.3 Tabs per tier** — in `renderHarbor`, after the line `const qTabs = h.quay ? TIER_TABS[h.quay.tier] || ['overview'] : null;` replace the
`qTabs` usage with `const tabs = h.mh ? h.mh.tabs : qTabs;` (the card carries its own tab list: marina overview / berths /
services / jobs / weather …), and in `renderTab` add before `case 'overview':`

```js
        case 'overview': if (h.mh) { html = mhCardHTML(h.mh); break; } html = this.tabOverview(h, you, C); break;
```

(replacing the existing `overview` case), plus `case 'berths': html = h.mh ? mhBerthsHTML(h.mh) : ''; break;` — the berths tab
lists `card.berths.sizes` / `card.berths.list` (`mhchart.js berthsHTML`, green when the box takes your ship). The jobs tab
reuses `tabJobs` with `h.jobs = card.jobs`. Buttons in the card: `[data-tune]` → `this.app.vhf?.tune(+ch)`;
`[data-named]` → open that named harbour's sheet.

## 7. Jobs engine registration (`shared/jobs/catalogue.js`, `server/jobsgen.js`, jobs lane owner)

* `shared/jobs/catalogue.js FAMILIES`: add the four `INLAND_FAMILIES` records (`F('Barge cargo', 'cargo', 't', true, 2)` etc.
  with `fit` from `server/inlandjobs.js`; or import them there — the fits are pure).
* `server/jobsgen.js weightsFor`: named harbours tagged `container`/`bulk_grain`/`products` **and** on the inland graph
  (lane A `graph.gates` nearest gate ≤ 30 km) get `barge_container` 2, `barge_bulk` 2, `barge_tanker` 1; `generateFamilyJob`
  dispatches those types to `generateInlandJob(from, type, env.inland)` (env.inland = `{ ports, graph, lane }`).
* `LESSON_TASKS` gains `INLAND_LESSON_TASKS` for lessons posted at minor marinas (already used by `inlandjobs.js`).

## 8. Open points for review

1. **Kempenaar beam**: the contract row says 7.2 m; the CEMT II beam (which the kempenaar defines) is 6.6 m — built as 6.6 m.
2. **Container barges with deck tiers cannot lower the wheelhouse** under the §4.4 fold rule (stack top > lowered eye + 1 m),
   so a laden container barge needs ≈ 8.3–8.8 m (it is routed via openings). Real barges duck the wheelhouse briefly; if
   wanted, give `cbarge135` a fold exemption (lane A `canFold`) or a camera rule.
3. **Default depths are conservative**: passantenhaven 1.8 m (§3.6) refuses a 1.9 m sloop; marinas use a small-craft ukc
   (5 %, ≥ 0.1 m) so the sloop fits 2.0 m. Sampled D14 depth is used only when deeper than the default (z9 bathymetry is
   too coarse in small basins).
4. **Inferred marinas** (≥ 2 pontoons in a ≤ 120 m cluster, ≥ 3 features or ≥ 150 m) are flagged `e: 2` / "est.": in the
   fixtures they find real pontoon clusters (Hoek van Holland, Hamburg Elbe banks) but some may be club or ferry
   landings. Named ferry / terminal pontoons and museum hulks are excluded.
5. `INLAND_TERMINALS` positions are approximate (`verify: true`) until lane A's FIS `terminal` entities are shipped.
6. Unrelated to lane D but seen while testing: `test/vhf-server.test.mjs` "loadVtsFile prefers lane A
   server/waterworks/vts-nl.json" now fails (expects ≥ 5 sectors) since lane A added its own `vts-nl.json` — lanes A/B to reconcile.
