# Lane C, phase 2 — wiring the general-arrangement interiors into the game

Contract: `docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md` §6 (GA + interiors), hooks **H10** (`shipplan.js`) and **H11**
(`interior.js`), plus the G key in `main.js` (§1 controls table). Phase 1 shipped new files only; this page lists the
exact edits to the three existing files. The reference implementation of every hook is the standalone harness
(`scratchpad/pw/interiors/harness.js`, class `GAInterior`), which runs the game's own `Interior` with these hooks applied.

## 1. What phase 1 delivered (new files only)

| File | What |
|---|---|
| `shared/ships/ga.js` | **Frozen, pure** general-arrangement module (contract §6 assigns it to Lane C). `generalArrangement(variantId, { livery, stage })` → deep-frozen, cached record: hull lines, decks, house tiers with sized rooms, bridge, engine room, cargo, lifesaving, mooring, Go-to seeds. One record drives both the exterior (Lane B `shipgen`) and the deck plan. Rules: SOLAS V/22 eye height, SOLAS II-1/9 double bottom (B/20, 1–2 m), MLC A3.1 cabin areas, hospital at ≥ 15 crew, SOLAS III/31 lifesaving (free-fall boats on bulk/tanker/box, davits on passenger ships), SOLAS V/19 bridge equipment, engine sizes §6.3. Sail classes return `{ gen: 'sail', delegate: 'sailing' }` and are never planned here. |
| `public/js/gaplan.js` | Pure `planFromGA(gaOrId, { deck })` → a plan in the `shipplan.js` shape plus the additive keys `zones`, `goto`, `links`, `deckGroup`; `room.zone`, `prop.zone`, … |
| `public/js/gaprops.js` | Drawing of the new prop kinds (`GA_PROP_KINDS`, `drawGAProp`), zone-split building (`buildZoned`), `visibleZones`, and the phase-2 behaviour helpers `gaInteract`, `openGotoMenu`, `gotoPoint`, `gaZoneUpdate`. |
| `test/interiors2-ga.test.mjs` | 12 rule tests on the GA records. |
| `test/interiors2-walk.test.mjs` | Walk suite for all 72 non-sail models + every cruise / ro-pax deck plan + game-movement walks (spawn → engine → open deck → helm) for a representative of each generator. |
| `test/interiors2-budget.test.mjs` | §6.6 budgets: `planFromGA` time and ≤ 400 rooms; per-zone triangles / draw calls built with three.js and the game's own `Interior` drawing (desktop ≤ 200k / 200, phone ≤ 60k / 80). |

Plan additions the hooks rely on:

- `plan.zones = [{ id, name, y0, y1, near: [zoneId], group? }]`. Tall houses (≥ 4 tiers) stream per tier
  (`house`, `house:1` …, `group: 'house'`); cruise / ro-pax deck plans stream per tower section
  (`deck:d8`, `deck:d8.s1` …, `group: 'deck:d8'`).
- `plan.goto = [{ id, label, x, y, z, deck? }]` — `deck` set when the point lies on a deck that is not loaded.
- `plan.deckGroup` — the deck a per-deck plan was built for (cruise ships, big ro-pax), else `null`.
- `room.deck` on tower landings of the neighbour decks (walking onto one reloads that deck).
- Hotspot kinds: `helm`, `engine`, `chart`, `radio`, `bunk` (existing) and `telegraph`, `thrusters`, `whistle`,
  `gmdss`, `ecr`, `steering`, `ccr`, `crane`, `winch`, `gangway`, `galley`, `hospital`, `muster`, `lab`, `info`,
  `ladder` (`to: {x,y,z}`), `goto` (`decks: [{id,label,y}]` on lifts).

## 2. Turning it on: `GA_READY`

`shared/ships/index.js` exports `GA_READY = new Set()`. A gen flips in when its tests pass (contract §10 phase 3 order).
All 13 Lane-C generators pass the walk and budget suites today, so for interiors alone every gen could flip; the flip is
shared with Lane B (exterior), so flip a gen only when `shipgen` for it is green too:

```js
// shared/ships/index.js — replace
export const GA_READY = new Set();
// with (one entry per gen whose GA + shipgen + gaplan tests pass)
export const GA_READY = new Set(['aft_house_dry', 'aft_house_tanker', 'container', 'tug', 'small_fast', 'offshore', 'fishing', 'ferry', 'roro_pctc', 'lng', 'motor_yacht', 'special', 'cruise']);
```

Legacy classes (`bulker`, `tanker`, …) and the four sail classes have no gen in `GA_READY` and keep today's plans.

## 3. H10 — `public/js/shipplan.js`

The sail parts stay untouched (SAILING owns them); only the entry point and `outlineHalf` gain a GA branch.

**3a. Imports.** Anchor (line 21):

```js
import { rigOf } from '../../shared/sail/rigs.js';
```

Add after it:

```js
import { planFromGA } from './gaplan.js';
import { generalArrangement, outlineHalf as gaOutlineHalf } from '../../shared/ships/ga.js';
import { GA_READY, genOf } from '../../shared/ships/index.js';
/** True when this class (catalogue model / variant id) is planned from its general arrangement (Lane C). */
export const gaPlanned = (cls) => GA_READY.has(genOf(cls));
```

**3b. `outlineHalf`.** Anchor:

```js
export function outlineHalf(cls, L, B) {
  if (cls === 'sloop' || cls === 'ketch' || cls === 'schooner') return deckOutlineHalf(cls, 40);   // the lofted yacht hulls (yachtlooks.js)
```

Insert as the next line:

```js
  if (gaPlanned(cls)) { const ga = generalArrangement(cls); if (ga && ga.gen !== 'sail') return gaOutlineHalf(ga, 72); }
```

**3c. `buildPlan`.** Anchor:

```js
export function buildPlan(cls, C, ud = {}) {
  const d = shipDims(C, ud);
```

Replace those two lines with:

```js
export function buildPlan(cls, C, ud = {}, opts = {}) {
  // Lane C: catalogue models whose gen is GA-ready get the general-arrangement plan (same record as the exterior);
  // opts.deck picks the deck of a cruise ship / big ro-pax (one deck plus the stair landings of its neighbours)
  if (gaPlanned(cls)) { const p = planFromGA(cls, { deck: opts.deck || null }); if (p) return p; }
  const d = shipDims(C, ud);
```

Nothing else in `shipplan.js` changes. `walker.js` needs no change: ladders are hotspots with a `to` point, handled in
`interior.js`.

## 4. H11 — `public/js/interior.js`

**4a. Imports.** Anchor (line 16):

```js
import { WalkMap, stairEnds } from './walker.js';
```

Add after it:

```js
import { drawGAProp, GA_PROP_KINDS, buildZoned, gaInteract, gaZoneUpdate, openGotoMenu } from './gaprops.js';
import { baseOf } from '/shared/ships/index.js';
```

**4b. RPM by base class** (catalogue models resolve to their base row). Two anchors:

```js
    const rpm = Math.round(rpmFraction(thr) * (RPM[you.ship.cls] || 900) * (you.fuelEmpty ? 0 : 1));
```
→
```js
    const rpm = Math.round(rpmFraction(thr) * (RPM[you.ship.cls] || RPM[baseOf(you.ship.cls)] || 900) * (you.fuelEmpty ? 0 : 1));
```
and
```js
    const C = SHIP_CLASSES[you?.ship.cls] || SHIP_CLASSES.coaster, rpmMax = RPM[you?.ship.cls] || 900;
```
→
```js
    const C = SHIP_CLASSES[you?.ship.cls] || SHIP_CLASSES.coaster, rpmMax = RPM[you?.ship.cls] || RPM[baseOf(you?.ship.cls)] || 900;
```

**4c. `build()` — per-deck plans and zone-split drawing.** Anchor:

```js
    try { plan = buildPlan(cls, C, mesh.userData); } catch (e) { console.warn('[interior] plan failed, using the coaster plan', e); plan = buildPlan('coaster', SHIP_CLASSES.coaster, {}); }
```
→
```js
    if (this.deckCls !== cls) { this.deck = null; this.deckCls = cls; }   // a new ship starts on its bridge deck
    try { plan = buildPlan(cls, C, mesh.userData, { deck: this.deck }); } catch (e) { console.warn('[interior] plan failed, using the coaster plan', e); plan = buildPlan('coaster', SHIP_CLASSES.coaster, {}); }
```

Then anchor (the drawing block in the same method):

```js
    this.pb = new PartBuilder();
    const ctx = { g, M: this.mats, pb: this.pb, plan };
    this.drawDeck(ctx);
    this.drawRooms(ctx);
    this.drawStairs(ctx);
    for (const p of plan.props) { try { this.drawProp(ctx, p); } catch (e) { console.warn('[interior] prop', p.t, e); } }
    for (const r of plan.rails) this.drawRail(ctx, r.pts, r.y);
    this.pb.build(g);
    this.pb = null;
```
→
```js
    this.zoneGroups = null;
    if (plan.zones?.length) this.zoneGroups = buildZoned(this, plan, g);   // GA plans: one group per zone (§6.6 streaming)
    else {
      this.pb = new PartBuilder();
      const ctx = { g, M: this.mats, pb: this.pb, plan };
      this.drawDeck(ctx);
      this.drawRooms(ctx);
      this.drawStairs(ctx);
      for (const p of plan.props) { try { this.drawProp(ctx, p); } catch (e) { console.warn('[interior] prop', p.t, e); } }
      for (const r of plan.rails) this.drawRail(ctx, r.pts, r.y);
      this.pb.build(g);
      this.pb = null;
    }
```

`buildZoned` calls this instance's `drawRooms`-equivalent (its own zone-aware version that also merges back-to-back
partitions), `drawStairs`, `drawDeck`, `drawProp` and `drawRail` with a per-zone `PartBuilder`.

**4d. `dispose()`** — anchor:

```js
    this.builtFor = null; this.builtCls = null;
  }
  build() {
```
→
```js
    this.builtFor = null; this.builtCls = null; this.zoneGroups = null;
  }
  build() {
```

**4e. `drawProp` — new kinds.** Anchor (first lines of the method):

```js
  drawProp(ctx, p) {
    const { g, pb, M, plan } = ctx;
```
→
```js
  drawProp(ctx, p) {
    if (GA_PROP_KINDS.has(p.t) && drawGAProp(ctx, p)) return;   // Lane C prop kinds (consoles, ME, winches, cranes …)
    const { g, pb, M, plan } = ctx;
```

**4f. `interact()` — ladders, Go-to and the new consoles.** Anchor:

```js
    const h = this.nearHotspot; if (!h) return;
    const app = this.app, you = app.you;
```
→
```js
    const h = this.nearHotspot; if (!h) return;
    if (gaInteract(this, h)) return;   // ladder climb, Go-to / lift, telegraph, thrusters, whistle, GMDSS, ECR, info points
    const app = this.app, you = app.you;
```

`gaInteract` returns `false` for the existing kinds (`helm`, `engine`, `bunk`, `chart`, `radio`), so the switch below
keeps handling them.

**4g. `update()` — zone visibility and per-deck reload.** Anchor (the hotspot block in `update`):

```js
    // ---- hotspots
    let best = null, bd = 1e9;
```
Insert before it:

```js
    // ---- zone streaming (GA plans): the zone you stand in and its neighbours; a tower landing of a neighbour deck
    // reloads that deck's plan (cruise ships, big ro-pax)
    if (this.zoneGroups) gaZoneUpdate(this, this.isTouch || window.innerWidth < 900);
```

**4h. Go-to entry point** (used by the G key and a HUD button). Add a method next to `interact()`:

```js
  /** G / Go-to button: the quick-travel list of this ship (L > 60 m). False when the ship has none. */
  openGoto() { if (!this._active || this.atHelm || !this.plan?.goto?.length) return false; return openGotoMenu(this); }
```

For touch, add a *Go to* button beside the existing view button in the constructor (anchor
`document.body.appendChild(this.viewBtn);`), shown only while walking a ship with `plan.goto.length`:

```js
    this.gotoBtn = document.createElement('button'); this.gotoBtn.id = 'interiorGotoBtn'; this.gotoBtn.type = 'button'; this.gotoBtn.textContent = 'Go to…';
    this.gotoBtn.style.cssText = this.viewBtn.style.cssText.replace('top:calc(64px', 'top:calc(116px');
    this.gotoBtn.addEventListener('click', (e) => { e.stopPropagation(); this.openGoto(); this.gotoBtn.blur(); });
    document.body.appendChild(this.gotoBtn);
```

and in `updateViewBtn()` (anchor `this.viewBtn.style.display = this._active ? 'block' : 'none'; }`) hide it with the view
button: insert `if (this.gotoBtn && !this._active) this.gotoBtn.style.display = 'none';` before the closing `}`.
`gaZoneUpdate` shows it every frame while walking a ship that has a Go-to list (and hides it at the helm).

## 5. `public/js/main.js` — the G key

G already means "go ashore / back aboard"; while walking a ship with a Go-to list it opens the list instead
(contract §1). Anchor (in `bindInput`):

```js
      if (k === 'g') return this.toggleAshore();
```
→
```js
      if (k === 'g') { if (this.interior.active && this.interior.openGoto?.()) return; return this.toggleAshore(); }
```

## 6. Checks after wiring

```
node --test test/interiors2-*.test.mjs        # GA rules, walk suite, budgets (≈ 6 min together on a loaded 4-core box)
node --test test/interior*.test.mjs           # the existing interior suites must stay green (legacy plans untouched)
```

Then in the browser walk one ship per gen: bridge (helm, telegraph, whistle, GMDSS), down the stair column to the
engine room (local control stand / ECR), out on deck (mooring winch, lifeboat / muster), G → bow → stern, and on a
cruise ship ride a lift to another deck and walk up a tower stair onto the next deck (it reloads).

## 7. Numbers (phase 1, node, 4-core box under load ~13)

- Rooms per plan: max 389 (ulcv24k), cruise deck plans ≤ 320.
- `planFromGA` CPU time (best of three): most models 5–30 ms; the very largest (vloc400, ulcv24k, pctc7000, cruise
  public decks) 30–55 ms on this loaded box. The budget test fails above 4 × 30 ms (`GA_PLAN_SLACK`); plans are
  deterministic per variant and deck, so `build()` may cache them by `cls|deck` if a device shows a hitch.
- Interior geometry, worst zone a walker can stand in: desktop ≤ 95k tris / ≤ 140 draw calls; phone ≤ 60k tris /
  ≤ 77 draw calls (ulcv24k house bottom tier; vlcc300 59k).
