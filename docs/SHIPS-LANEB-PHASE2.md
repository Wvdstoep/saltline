# Lane B (ship exteriors + shipyard screen), phase 2: the hook edits to existing files

Contract: `docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md` (§4.7 shipyard UI, §6 generators, §6.6 budgets, §7.1 lanes, §7.4
hooks H5, H9, H9b, H12, H13, H13b, §9 tests 7–8). Lane A's wire and data: `docs/SHIPS-LANEA-PHASE2.md`.
Phase 1 added **new files only**. This page lists every edit to an existing file, each with its anchor (the statement it
sits next to) and code ready to paste. Apply them after the files' current owners (sailing wiring of `ship.js`,
`main.js`, `hud.js`) have merged; re-check each anchor first. No edit touches `shared/**`, `server/**` or `data/`.

## What phase 1 delivered (new files only)

| File | Contents |
|---|---|
| `public/js/shipgeom.js` | Pure hull geometry: `hullForm(ga)` (stem/stern contours per bow/stern kind, planform from Cb with entrance / parallel midbody / run, superellipse sections, sheer, flare, twin hulls, double-ended), `loftHull(ga, { lod })` → plain arrays (sides with boot-top / hull / band groups, deck, transom), `blockCoeff`, `waterplaneCoeff`, `bayStacks`, `triBudget`, `DRAW_CALLS`, `lodDistances` (§6.6) |
| `public/js/shipgen.js` | `buildFromGA(ga, opts)` → `{ group (THREE.LOD: LOD0 < max(150, 1.5 L), LOD1 < max(2 km, 6 L), LOD2 silhouette < 15 km), lods, info, mats }` for the 13 generators of §6.1 (`SHIPGEN_GENS`); `navLightSpots(ga)` (ship.js `ctx.lights` shape), `shipBounds`, `geometryHash`, `disposeShip`, `platformLen` |
| `public/js/gastub.js` | **Local stand-in** for Lane C's `shared/ships/ga.js` `generalArrangement(variantId, { livery, stage })`: the frozen §6.2 GA with every field the exterior needs, from the §6.3 rules (SOLAS V/22 eye height sets container-ship house heights, twin island ≥ 14,000 TEU, free-fall boats aft, davits on ferries/cruise, hatch/crane/tank/trunk layouts…) |
| `public/js/yardfmt.js` | Pure formatting / selection: `fmtCr` ("6.07 M cr"), `fmtHours` ("95 h (4 d)"), `designCard`, `filterDesigns` (type, size, yard country, price, afford, **Jones = US yards only**, delivery, eco, sort, search), `yardRows`, `optionGroups`, `variantFor` (options a yard cannot build fall back, with the reason), `instalmentRows`, `orderSummary`, `specSheet`, `compareRows` (best value per row), `orderView`, `listingCard`, `listingHistory`, `politicsBadges`, `LIVERY_PRESETS` |
| `public/js/yardpreview.js` | `YardPreview` (3D turntable: one shared WebGL renderer, drag / wheel / pinch, `[` `]` 15°, render on demand only, phone 30 fps cap and 1× pixel ratio, paused when scrolled away, `dispose()`), build stages (keel blocks → hull rising behind a local clipping plane in a building dock → primer → livery), `yardThumb` / `cachedYardThumb` (offscreen thumbnails, one per frame, cached by variant + livery + size + angle + stage) |
| `public/js/yardui.js` | `YardUi` — the Shipyard tab: Newbuild (filters · design cards · configurator: yards with price / delivery / payment plan / speciality ★ / politics badges, options, livery, mark, name, flag, payments table, loan, delivery, resale slot, spec sheet, Order), Stock & resale, Second-hand (condition range until inspected, PSC, owners, history drawer, Inspect, Buy), My orders (progress with milestone ticks, next instalment, Pay now, Cancel, delivery choice), Sell / trade-in, compare up to 4; phone layout. `orderBookHTML(orders, now)` for the office (H13b) |
| `public/css/yard.css` | Styles (tokens of `style.css`; phone ≤ 899 px: segmented control, bottom-sheet filters, full-screen configurator, 44 px targets) |
| `test/shipviz-geometry.test.mjs` | GA stub shape, SOLAS V/22 blind distance for every container ship, twin island, house heights, lifesaving, rotors; loft scale (LOA ±1 %, beam ±2 %, keel at −T), Cb of the loft vs the model, stems, symmetric double-ender, catamarans; stacks, LOD distances, budgets |
| `test/shipviz-build.test.mjs` | §9 test 7 with three.js in node for **every** motor model (72): bbox ±1 % / ±2 %, keel ±0.1 m, draw calls ≤ 24 (phone ≤ 16), LOD0 triangles within §6.6, phone lighter, LOD chain; determinism hash; livery colours in the hull / boot / funnel materials; build stages (0.1 blocks, 0.3 no superstructure + clip plane, 0.7 primer, 1.0 livery; cargo only when finished); the `makeMat` hook |
| `test/shipviz-yardfmt.test.mjs` | §9 test 8: strings, E1 instalment table (606,700 × 4 + 3,640,200 at 36 / 50.85 / 74.61 / 95.4 h), E3 (Philly 12.4 M, 138 h), Jones filter keeps only US yards, politics block reasons, methanol-at-Imabari reason, compare winners, orders (wire compact view and full record), listings (range → exact after inspection), livery presets, spec sheet |
| harness (scratchpad, not in the tree) | `pw/ships/` — `server.mjs` (ports 3310–3319), `gallery.html/js` (every model, grid or true-scale lineup, LOD, stages, phone geometry), `yard.html/js` (the real `YardUi` with a `harbor.yard` built from Lane A's functions), `shoot.mjs` (Playwright) |

Measured (node, desktop LOD0, excluding cargo): 3–17k triangles per ship (budgets 25k / 40k / 80k / 120k), 7–11 draw
calls (phone 7–11), LOD1 0.9–5k, LOD2 130–920 triangles; container stacks are one textured box per stack (ULCV 6.3k
triangles of cargo). Build 10–60 ms in node per ship (all three LODs).

### The GA: who produces it

Lane C owns `shared/ships/ga.js` (§7.1). Lane B consumed the spec with `public/js/gastub.js`. `buildFromGA` reads only
the frozen §6.2 fields plus **optional** extras listed below; when a GA lacks an extra, that detail is simply not drawn.
Frame convention assumed (the same as `ship.js`): x = starboard, y = up with 0 at the design waterline (keel −T),
z = aft with the LOA's bow end at −L/2; every `[z0, z1]` has z0 forward; `house.tiers[i].y` = floor height above the
waterline. **Requests to Lane C:** (a) confirm this frame; (b) emit the extras below from `generalArrangement` (they are
pure numbers and can be copied from the matching generator in `gastub.js`), or agree that Lane B moves `gastub.js` to
`shared/ships/gaext.js` in phase 3 (reviewer's consent; `shared/` must not import `public/`) and `ga.js` merges its
exterior fields. Until one of the two lands, H9 imports the stub.

Optional extras read by `shipgen.js` (all inside the frozen top-level keys):
`hull.draftHull` (hull-body draught when the catalogue draught is navigational, ASD tugs), `hull.doubleEnded`,
`hull.fender`, `hull.pushKnees`, `hull.tube` (RIB); `house.tiers[i].z0/z1/w` (per-tier steps), `house.tiers[i].use`
(`'bridge'`, `'balcony'`, `'public'`, … picks the facade band); `bridge.embedded`, `bridge.allRound`, `bridge.console`;
`cargo.hatchY`, `cargo.rows`, `cargo.slab`, `cargo.open`, `cargo.trailers`, zone fields (`w`, `coaming`, `tiersDeck`,
`rows`, `trunkH`, `shape`, `r`, `cy`, `domes`, `tiers`, `h`, `depth`); `deck.catwalk`, `compressor`, `breakwater`,
`towWinch`, `staple`, `sternRamp`, `sideRamp`, `heli`, `pool`, `flybridge`, `derricks`, `powerBlock`, `netBin`,
`haulingPort`, `potHauler`, `bowFender`, `dragArm`, `fifi`, `gangway`, `aframe.kind`, `swimPlatform`, `bowDoor`;
`boats[i].y`, `boats[i].big`, `boats[i].garage`, `masts[i].y`, `masts[i].arch`, `rotors[i].x`.

---

## H9 — `public/js/ship.js` · `buildShip` (exteriors from the generators)

Imports, directly after `import { autoTrimView } from './sailshared.js';`:

```js
import { buildFromGA } from './shipgen.js';                                      // SHIPYARD H9 (docs/SHIPS-LANEB-PHASE2.md)
import { generalArrangement as exteriorGA } from './gastub.js';                  // → '../../shared/ships/ga.js' once Lane C lands (same signature)
import { GA_READY, genOf, baseOf, defaultLivery } from '/shared/ships/index.js';
```

Directly after `function detRand(seed) { … }`:

```js
/** SHIPYARD H9: build the exterior from the general arrangement (shipgen.js) into ship.js' ctx, with wear materials */
function genBuilder(ctx, cls, opts = {}) {
  const ga = exteriorGA(cls, { livery: opts.livery || defaultLivery(cls), stage: opts.stage ?? 1 });
  const touch = typeof window !== 'undefined' && (('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0);
  const wear = {};
  const makeMat = (kind, color, p) => {
    if (!['hull', 'boot', 'band', 'deck', 'house'].includes(kind)) return new THREE.MeshStandardMaterial({ color, roughness: p.roughness ?? 0.6, metalness: p.metalness ?? 0.2, vertexColors: !!p.vertexColors, map: p.map || null, emissive: p.emissive ?? 0x000000, emissiveIntensity: p.emissiveIntensity ?? 0 });
    return (wear[kind] = makeWearMaterial(color, { roughness: p.roughness, metalness: p.metalness, extra: { map: p.map || null, vertexColors: !!p.vertexColors } }));
  };
  const r = buildFromGA(ga, { seed: ctx.seed ?? 1, phone: touch && window.innerWidth < 900, stage: opts.stage ?? 1, makeMat, decals: false });
  ctx.g.add(r.group);
  Object.assign(ctx, { deckY: ga.deckY, freeboard: ga.deckY, bowFrac: ga.hull.bowFrac, lights: r.info.lights, windowMat: r.mats.glass, shipgen: r });
  ctx.mats = Object.values(wear);                    // setWear / setFlood / setWaterY reach the generated hull, deck and houses
  ctx.crewSpots.push(...r.info.crewSpots);
  return r.info.labelY;
}
```

In `buildShip`, change the signature `export function buildShip(cls, name, seed = 1) {` to

```js
export function buildShip(cls, name, seed = 1, opts = {}) {   // SHIPYARD H9: opts { livery, stage, shipgen }
```

and replace the two lines

```js
  const C = SHIP_CLASSES[cls] || EXTRA_CLASSES[cls] || SHIP_CLASSES.coaster;
  const key = BUILDERS[cls] ? cls : 'coaster';
```

with

```js
  const C = SHIP_CLASSES[cls] || EXTRA_CLASSES[cls] || SHIP_CLASSES[baseOf(cls)] || SHIP_CLASSES.coaster;   // H1 resolves model and variant ids
  const gen = genOf(cls);
  const useGen = !!gen && gen !== 'sail' && (GA_READY.has(gen) || opts.shipgen === true);                       // §6.1: generator once its gen passed its tests
  const key = BUILDERS[cls] ? cls : BUILDERS[baseOf(cls)] ? baseOf(cls) : 'coaster';                            // interim: the base builder at the model's own dimensions
```

and in the builder call replace

```js
  try { labelY = BUILDERS[key](ctx); } catch (e) { console.warn('[ship] builder failed for', cls, e); labelY = ctx.deckY + 20; }
```

with

```js
  try { labelY = useGen ? genBuilder(ctx, cls, opts) : BUILDERS[key](ctx); } catch (e) { console.warn('[ship] builder failed for', cls, e); labelY = ctx.deckY + 20; }
```

and `const ctx = makeCtx(g, C, cls, seed);` stays; add `ctx.seed = seed;` on the next line. Everything after the builder
(crew figures, `ctx.pb.build(g)`, COLREGS lights from `ctx.lights`, bow strips from `ctx.bowFrac`, the wake,
`bakeShipPos(g)` — it traverses into the LOD levels —, `setLights` through `ctx.windowMat`) works unchanged.

Flipping a generator live is then one line per gen (phase 3, after its tests): `GA_READY.add('aft_house_dry')` — in
`shared/ships/index.js` (Lane A owns the Set) or at client start-up. Until then `?shipgen=1` can be honoured by the
caller passing `{ shipgen: true }` (e.g. from `main.js` `shipVisual` for testing).

**Livery on the ship in the world** (§4.6 `vessel.spec.livery`): where `main.js` calls `buildShip(cls, name, seed)` for the
own ship and fleet ships, pass `{ livery: vessel.spec?.livery }` as the fourth argument when it is known (the `you` and
`fleet` payloads carry `spec` after Lane A's H8).

## H9b — `public/js/thumbs.js` · cache key with variant and livery

Replace `const VERSION = 'v4.2';` with `const VERSION = 'v5.0';   // SHIPYARD H9b: key includes variant + livery`.

Replace `function keyOf(cls, w, h, angle, wear, scale) { return \`${VERSION}|${cls}|${w}x${h}@${scale}|${angle}|${wear.toFixed(1)}\`; }` with

```js
function keyOf(cls, w, h, angle, wear, scale, livery = null) { return `${VERSION}|${cls}|${w}x${h}@${scale}|${angle}|${wear.toFixed(1)}|${livery ? [livery.hull, livery.house, livery.funnel, livery.band ?? '-', livery.mark ?? '-'].join('.') : 'd'}`; }
```

In `normOpts`, add `livery: opts.livery || null` to the returned object, pass `o.livery` as the last argument of both
`keyOf(…)` calls (in `cachedThumb` and `shipThumb`), and in `renderShip` replace `ship = buildShip(job.cls, null, 7);` with
`ship = buildShip(job.cls, null, 7, { livery: job.livery });`. (The shipyard itself renders its thumbnails with
`yardpreview.js`; `thumbs.js` stays the source for every other screen.)

## H5 — `public/js/hud.js` · Shipyard tab

First line inside `tabShipyard(h, you, C) {`:

```js
    if (this.app.yardUi && h.yard) return this.app.yardUi.html(h, you);   // SHIPYARD H5: the new shipyard (yardui.js); old payloads keep the legacy tab
```

`sheetAction(act, el) {` → `sheetAction(act, el, e) {` (the two callers already pass the event), and as the first
statement of its body:

```js
    if (act && act.startsWith('yard-') && this.app.yardUi) return this.app.yardUi.action(act, el, e);   // SHIPYARD H5
```

In `hideHarbor()` append `this.app.yardUi?.close();` (frees the turntable's GL context when the sheet closes).

`<select>`/`<input>` changes inside the tab are handled by `yardUi` itself (it binds `change` / `input` on its own root);
`renderHarborTabs`' "do not rebuild under a focused input" rule protects the name and mark fields as it does today.

## H13 — `public/js/main.js` · create the UI, keys

Directly after `import('./hq.js').then((m) => { this.hq = new m.Hq(this); }).catch((e) => console.warn('[hq] unavailable', e));`:

```js
    this.yardUi = null;   // SHIPYARD H13: the shipyard screen (yardui.js); harbour sheet → Shipyard tab (hud.js H5)
    if (new URLSearchParams(location.search).get('yard') !== '0') import('./yardui.js').then((m) => { this.yardUi = new m.YardUi(this); }).catch((e) => console.warn('[yard] unavailable', e));
```

In `bindInput`'s keydown handler, directly after the `if (k === 'escape') { … }` block:

```js
      if (this.yardUi && this.hud.harborOpen() && this.hud.harborTab === 'shipyard' && this.yardUi.key(e)) { e.preventDefault(); return; }   // SHIPYARD H13: N / U / O sections, [ ] rotate the preview
```

(While the shipyard is open N, U, O and `[` `]` belong to it; everywhere else they keep their meanings: N tugs, U mute,
O fleet HQ, `[` `]` sail trim.) `yardUi` registers `welcome.world.harbors` with `shared/ships/index.js`
`registerHarbors` itself on first render (local boatyards need it); no edit in `onWelcome`.

## H13b — `public/js/hq.js` · order book in the office

Import, next to the other imports at the top: `import { orderBookHTML } from './yardui.js';   // SHIPYARD H13b`

In `shipsHTML(v)`, replace the closing `<div class="flCards">${v.vessels.map((x) => cardHTML(x, ctx)).join('')}</div></div>\`;` with

```js
      <div class="flCards">${v.vessels.map((x) => cardHTML(x, ctx)).join('')}</div>${orderBookHTML(this.app.you?.orders, this.now())}</div>`;
```

(`you.orders` is Lane A's compact §7.3 list; the rows show yard, hull number, progress with milestone ticks, next
instalment and when it is due.) `fleet.js` needs no edit: the harbour Office tab can call the same function if wanted.

## `public/index.html` · stylesheet

After `<link rel="stylesheet" href="css/sail.css">`:

```html
<link rel="stylesheet" href="css/yard.css">
```

## H12 (client) — id-keyed tables

`public/js/ais.js` (`classForType`, `FAMILY`) only ever produces the 17 legacy ids, so it needs no edit now; when AIS
traffic is drawn with catalogue models (phase 4) map through `baseOf(cls)`. `public/js/motion.js` falls back by `cat`
already. `ship.js` `BUILDERS` goes through `baseOf` in H9 above.

---

## Notes for the reviewer

1. **Sail classes** are never built here: `shipgen.js` has no `sail` generator, `gastub.js` returns `null` for them,
   and the preview / gallery load SAILING's `rigmesh.js` `buildYacht` lazily. Their shipyard cards, yards and liveries
   come from the catalogue like every other design.
2. **Yard blocks (politics R3)** are computed client-side by `yardsFor(..., { yardCheck })`; `YardUi` takes a
   `yardCheck(cc, yard)` option (absent → every yard allowed, as on the server). When politics exposes its client
   data, construct `new YardUi(app, { yardCheck })` in H13; the server re-checks every order anyway.
3. **Options vs yards**: the configurator evaluates options at model level; choosing one that the selected yard
   cannot build moves the selection to the cheapest yard that can (the list shows only those), and the order always
   carries a variant the yard can build (server re-validates).
4. **ASD tug draught**: the catalogue gives 5.0 m for `tug24` / `tug` (navigational, over the Z-drives) with 4.6 / 5.2 m
   depth. The stub keeps `T` (drives reach −T) but floats the hull body at `hull.draftHull = D − 1.1 m`, so the deck
   sits 1.1 m above the water as on real ASD tugs. Lane A may want to add a hull draught column; nothing else depends
   on it.
5. **Thumbnails**: the shipyard renders its own (variant + livery + build stage) with an offscreen renderer; the rest
   of the game keeps `thumbs.js` (H9b adds the livery to its key).
6. Phase-3 acceptance (§9 test 7) runs today for every motor model (`test/shipviz-build.test.mjs`), so each gen can be
   flipped into `GA_READY` as soon as Lane C's `gaplan` tests for it pass.
