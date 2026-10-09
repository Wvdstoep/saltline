# Saltline — bridges & locks in 3D + HUD (lane C) phase 2: the hook edits

Status: **phase 1 done** (2026-10-09), new files only. This file lists the exact edits the integration pass (§9.6 of
`docs/BRIDGES-LOCKS-VHF-CONTRACT.md`) makes to existing files to switch the 3D waterworks and their HUD on. Every edit is
additive. Without `ww_static` messages (registry off, `SALTLINE_WW_OFF=1`) the layer draws nothing and the game is unchanged.

## 1. What phase 1 shipped (new files)

| File | What |
|---|---|
| `public/js/wwgeom.js` | **pure** builders (no three.js, Node-testable): `buildBridge(obj, opts)` / `buildLock(obj, opts)` → `{static, moving: [part], boards, gauges, signals, query, cut, tris}`; `partPose(part, frac)`; `undersideAt` (deck underside over a point, with live span fractions); `overlayStrip` (air-draught band); `bridgesAhead` (heading-ray crossings); `planLod` (§5.3 LOD + triangle budget); `drawnSpans` (merges FIS's overlapping spans); `datumOffset`; `bridgeFromVector` (D14 v2 tile-vector fallback); `BUDGET3D` |
| `public/js/wwfmt.js` | pure strings + state: OpenSeaMap board text (`boardText`, `widthText`), gauge reading (floor 0.1), `spanFrac`, BPR lights (`bridgeLights`, `lockHeadLights`, `lampsFor`, `SIGNALS_LOCAL`), lock phase / `gateFrac` / `chamberLevel` (§4.8.4 curve) / `chamberFlow`, local fallbacks `clrNowLocal`, `verdictLocal`, `levelTimeLocal`, `levelAtLocal`; HUD strings `fmtAir`, `fmtStrip`, `hoursToday`, `blocksText`, `datumNote`, `kindText`, `srcText`; SVG `sideViewSvg` (to scale) and `lockPlanSvg` |
| `public/js/wwmesh.js` | `WwMesh`: three.js layer in its own scene group (never discarded inside harbour patches): registry objects + `ww` deltas, LOD / build queue (≤ `buildsPerFrame`, ≤ `buildMs`), merged static mesh per object + one node per moving part, bascule / double bascule / draw (leaf + balance beam) / lift (span + cables) / swing / pontoon / retract, lock gates (mitre, sector, lift, rolling, drop), chamber water riding `level(t)` with floating bollards and culvert foam, BPR lamps + glow sprites, board + peilschaal canvas textures (LRU), live gauge reading tag, air-draught overlay band, `pick`, `cutouts`, `chamberLevelAt`, `objectsAhead`, `clrNow`, `lineNear`, `knownIds` |
| `public/js/wwhud.js` | `WwHud`: AIR chip + next-3 strip (green / amber / red, "open · go" while an opened span is open), air-draught card (`;`: AIR / draught / need, live gauge of the next bridge with margin, to-scale side view, ballast bar + Fill/Empty/Stop, fold buttons, overlay toggle), bridge card (spans with clearance now closed/open + datum note, state, channel, hours today, blocks, slots, next opening, queue, out of service, "Call on ch X"), lock card (sides, channel, hours, fee, per chamber size/sill, cycle state with time left, live level, levels + lift, queue, your number, slot plan) — desktop card / phone bottom sheet |
| `public/css/ww.css` | styles (style.css tokens) |
| `test/ww3d-geometry.test.mjs`, `test/ww3d-fmt.test.mjs`, `test/fixtures/ww3d/rotterdam.json` | 20 tests (§10.7 1–7 plus §10.2.1–4 / §10.3.1 numbers on the 3D side); fixture = 55 real FIS objects around Rozenburg / Botlek (lane A's pack, CC0) |

Harness: `scratchpad/pw/ww3d/` (`node make-fixture.mjs` → `fixture.json` + the test fixture from lane A's `server/waterworks/nl-fis.json.gz` via `server/fis.js loadFis`;
`node serve.mjs` on 3340–3349; `node shots.mjs` → `shots/d*.png`, `shots/p*.png`). Real `WwMesh` + `WwHud` on the real FIS
objects, driven by lane A's real rules (`/shared/waterworks.js` `clrNow` / `passVerdict` / `objOffset`, `/shared/airdraft.js`
`airPublic` / `profileOf`) and a scripted `ww` delta stream: Rozenburgsesluis (outer-head bascule opening, lock cycle admit →
closing → levelling 1.80 m in 346 s → opening → release with a sloop rising −1.20 → +0.60, inner-head bascule opening, the
fixed rail bridge over the lock), Calandbrug (truss lift span 11.7 → 49.7 + the absorbed 80 m fixed passage), Botlekbrug
(two overlapping lift entries drawn as one wide span; coaster with the wheelhouse up, red overlay, lifting, green),
Havenspoorbrug Maassluis (swing) and Doenbrug (bascule + fixed span). `?phone=1` phone budgets + sheet; `?seed=1` draws the
lock-head bridges as the contract seed (lift 3.6 / 24.0) instead of the FIS truth.

### 1.1 Data notes found while building (for lane A / the integrator)

* **The Rozenburgsesluis head bridges are bascules** (FIS: 3.6 closed, `clrO: null`, 24 m wide, VHF 22, paired). The
  "3.6 / 24.0" OpenSeaMap label is clearance / *width*, so the contract's lift seed (§4.8.1) is superseded: the 3D board reads
  "3.6 / –" with a separate "↔ 24.0" width board.
* **Lane A bug to fix:** for movable spans FIS gives `clrO: null`, and `shared/waterworks.js clrNow(obj, i, {frac: 1})` then returns the
  *closed* clearance (`s.clrO == null ? s.clr`). `passVerdict` therefore says `never` for a 17 m sloop at every bascule or swing
  bridge. §3.6 says these open to unlimited height. Either the unpacker or `clrNow` should map `null` → `Infinity` for bascule /
  bascule2 / swing / pontoon / retract / draw. The harness normalises this before handing objects to the rules, and
  `wwfmt.clrNowLocal` already reads `null` as unlimited.
* FIS lists the **"Havenspoorlijn over Rozenburgsesluis" as fixed, 14.0 m** over the chamber, so a 17 m sloop gets `never`
  there (red "no pass" chip). Check against reality before players hit it.
* FIS lines are synthetic (`lineSrc: 'synthetic'`, from point + bearing + length) and every FIS bridge is `kind: 'road'`,
  `deckW: 12`, `structure: 'girder'`: the OSM join (§3.5) must supply rail / truss / width or the Calandbrug draws as a road
  bridge without its truss.
* FIS often lists **overlapping spans** (Calandbrug: lift 54.9–100.9 inside fixed 43–123; Botlekbrug: two lift entries at the
  same place). `drawnSpans` merges them (movable, recommended, widest first); a same-type overlap is drawn as one wider deck.

### 1.2 Assumptions about lane A's interfaces (check when wiring)

* `ww_static.objects[]` are §4.2 Bridge / §4.8.1 Lock objects exactly as `server/fis.js unpackBridge / unpackLock` return them
  (+ `rev`). Locks are recognised by `chambers`.
* `ww` delta: `{id, spans: [{i, st, t0, dur}], sig?: [{face, span?, lights}], chambers: [{id, st, side, t0, dur, level0, level1, plan, queue}], out?, next?, queue?}`.
  * `t0` epoch ms (epoch s accepted), `dur` seconds (≥ 2000 is read as ms).
  * **Chamber `side`**: the head the phase concerns (admit / closing: entry side s; opening / release: the exit side;
    idle: the side whose gates stand open). `st: 'admit:1'` is accepted too. `level0` = level at the start of the phase,
    `level1` = target (both equal outside levelling). During `levelling` the client draws `level1 − (level1 − level0)(1 − t/dur)²`.
  * `sig[].lights` may be `['red','green']`, `'rg'`, `{red: 1, green: 1}` or `['rv']` (two reds vertical); without `sig` the
    lights are derived from the span / chamber state (§4.9 table, `wwfmt.SIGNALS_LOCAL`).
* `you.air = {ad, T, kTop, ballastT, ballastTarget, fold, deckTiers, need}`; `fold[part] = 1` means **lowered**.
  `you.nextObjects` (≤ 3, `{id, name, verdict, clrNow, clrOpenNow, need, dist, vhf, span}`) is used when present; otherwise
  `WwMesh.objectsAhead` computes it client-side with lane A's `passVerdict` (or the local fallback).
* `shared/waterworks.js` `clrNow(obj, i, {h, frac})` / `passVerdict(air, obj, i, ctx)` and `shared/waterlevel.js` datum
  offsets are injected (`ww.setRules(mod)`, `datumOffset`), so visual clearance = physics clearance.

## 2. `public/index.html`

**2.1 Styles** — after `<link rel="stylesheet" href="css/sail.css">` (after the radio's `css/vhf.css` if that is wired first):

```html
<link rel="stylesheet" href="css/ww.css">
```

**2.2 Help** — in `#helpWrap`, after the "Navigation" card (`<article class="card"><h3><span class="si" data-icon="chart"></span>Navigation</h3>…</article>`):

```html
        <article class="card"><h3><span class="si" data-icon="chart"></span>Bridges &amp; locks</h3><p>The <b>AIR</b> chip (top left) shows your air draught and the next three bridges: green you pass with margin, amber under 1 m, red you need an opening or cannot pass. Press <kbd>;</kbd> (phone: tap the chip) for the air-draught card: the clearance now, a side view to scale, ballast and folding. Click or tap a bridge or lock for its card. Boards read closed / open clearance ("3.6 / 24.0") and width; the gauge on the pier reads the clearance at today's water.</p></article>
```

No other markup: `WwHud` builds its own DOM at the end of `<body>`.

## 3. `public/js/main.js`

**3.1 Import** — after `import { SailHud } from './sailhud.js';`:

```js
import { WwMesh } from './wwmesh.js';                                  // bridges & locks 3D (docs/BRIDGES-LOCKS-VHF-CONTRACT.md §5)
import { WwHud } from './wwhud.js';
```

**3.2 Construct** — after the sail HUD block, i.e. after `} catch (e) { console.warn('[sail] HUD unavailable', e); }` (and after the
radio's `this.vhf = …` block if present):

```js
    try {   // bridges & locks: own scene group (not cut by harbour patches), AIR chip + cards
      this.wwMesh = new WwMesh({ parent: this.scene, origin: this.origin, phone: isTouch(), now: () => Date.now() + (this.clockOffset || 0),
        heightAt: (lat, lon) => this.terrain.heightAt(lat, lon), meanWater: 0 });
      this.wwHud = new WwHud({ ww: this.wwMesh, net: this.net, phone: isTouch(), vhf: () => this.vhf, clock: () => Date.now() + (this.clockOffset || 0),
        lengthOf: (c) => SHIP_CLASSES[c]?.length, shipKind: (c) => (rigOf(c) ? 'sail' : SHIP_CLASSES[c]?.cat === 'cargo' ? 'cargo' : 'motor') });
      import('/shared/waterworks.js').then((m) => this.wwMesh.setRules(m)).catch(() => {});                       // lane A rules (optional)
      import('/shared/airdraft.js').then((m) => { this.wwHud.o.profileOf = m.profileOf; }).catch(() => {});
    } catch (e) { console.warn('[ww] unavailable', e); this.wwMesh = null; this.wwHud = null; }
```

(If lane A exports a datum function, pass `datumOffset: (obj) => …` to `WwMesh` too; the default handles NAP / MSL / KP.)

**3.3 Messages** — in `onMessage(m)`, before `case 'chat': this.hud.chat(m); break;`:

```js
      case 'ww_static': this.wwMesh?.setStatics(m.objects || []); break;  // bridges & locks near us (§8.2)
      case 'ww': this.wwMesh?.applyDelta(m); break;                       // span / chamber state, signals, outages
```

**3.4 `you`** — in `onYou(...)`, after `this.net.vid = you.aboard ?? null;`:

```js
    if (you.water && Number.isFinite(you.water.h)) this.wwMesh?.setWater(you.water.h); else this.wwMesh?.setWater(this.tideLevel);
    if (this.wwMesh && (!this.wwQueryAt || haversine(this.wwQueryAt.lat, this.wwQueryAt.lon, you.ship.lat, you.ship.lon) > 2000)) {
      this.wwQueryAt = { lat: you.ship.lat, lon: you.ship.lon };                              // ask for statics every 2 km
      this.net.action('ww_query', { lat: you.ship.lat, lon: you.ship.lon, r: isTouch() ? 5 : 8 });
    }
```

(Skip the query block if lane A pushes `ww_static` by itself.)

**3.5 Origin** — in the recentre code, after `this.terrain.setOrigin(this.origin);`:

```js
    this.wwMesh?.setOrigin(this.origin);
```

**3.6 Keys** — in the keydown listener, after `if (this.interior.active && this.interior.handleKey(e)) return;` and before the
sailing-keys line (`;` is free; Esc also closes the card):

```js
      if (!this.ashore?.active && this.wwHud?.handleKey(e)) return;     // ; air-draught card · Esc closes the bridge / lock card
```

**3.7 Pick** — in `pickAt(cx, cy)`, replace the last line
`if (v) this.hud.showAisCard?.(this.aisLayer.info(v), v); else this.hud.showAisCard?.(null);` by:

```js
    if (v) { this.hud.showAisCard?.(this.aisLayer.info(v), v); return; }
    this.hud.showAisCard?.(null);
    const w = this.wwMesh?.pick(rc); if (w) this.wwHud?.openObject(w.id);   // tap / click a bridge or lock → its card
```

**3.8 Frame** — in `loop()`, after
`try { this.tugLayer?.update(dt, now); } catch (e) { … }`:

```js
    try { this.wwMesh?.update(dt, { lat: this.ship.lat, lon: this.ship.lon }); } catch (e) { if (!this.wwWarned) { this.wwWarned = true; console.warn('[ww] update failed', e); } }
```

**3.9 HUD tick** — at the end of `updateHud(now)` (before the chart line):

```js
    if (this.wwHud) {
      this.wwHud.show(!this.ashore?.active && !this.interior.active);
      const sea = this.wx?.waveH ?? 0, C2 = SHIP_CLASSES[s.cls] || {};
      this.wwHud.update(you, { lat: s.lat, lon: s.lon, hdg: s.hdg, h: you.water?.h ?? this.tideLevel, Hs: sea, beam: C2.beam || 8 });
    }
```

**3.10 Ships ride the chamber** — in `shipVisual(...)`, replace
`mesh.position.y = r.heave + this.tideLevel - flooding * (ud.freeboard + 2) - sink;` by:

```js
    const lockLvl = this.wwMesh?.chamberLevelAt(lat, lon);                                   // in a lock chamber: ride its level (§5.4)
    mesh.position.y = r.heave + (lockLvl ?? this.tideLevel) - flooding * (ud.freeboard + 2) - sink;
```

**3.11 Night** — in `updateDayNight(dt)`, after `const night = 1 - day; this.night = night;`:

```js
    this.wwMesh?.setNight(night);                                                            // signal glow size
```

**3.12 Ocean cut-outs** — in `loop()`, right after the 3.8 line:

```js
    if (this.wwMesh && now - (this.lastCut || 0) > 500) { this.lastCut = now; this.ocean.setCutouts?.(this.wwMesh.cutouts().map((c) => c.ring.map(([la, lo]) => { const p = toLocal(la, lo, this.origin); return [p.x, p.z]; }))); }
```

## 4. `public/js/hud.js`

**4.1 Escape closes the card** — in `transientOpen()` add `|| !!this.app?.wwHud?.isOpen` to the returned expression, and as the
first line of `closeOverlays()`:

```js
    this.app?.wwHud?.close();                                            // bridge / lock / air-draught card
```

(`Hud` keeps `app` from its constructor; if the field is named differently, use that.)

**4.2 Chart layer (optional, §5.5)** — in the chart draw routine, after the harbour markers: for each `o` of
`this.app.wwMesh?.objects() || []` with `o.line`, draw the line in red if `verdict === 'never'`, amber if `'opening'`
(verdicts from `this.app.wwHud.ahead` / `you.nextObjects`), else grey, with `boardText(o.spans[0], o.e)` as the label
(`import { boardText } from './wwfmt.js'`). Locks: a small chamber rectangle at `anchorOf(o)`.

## 5. Terrain: `public/js/wtiles.js` + `public/js/wtmesh.js` (D14 slab only as fallback)

**5.1 `wtmesh.js`** — in `buildStructures(tile, opts)`, the bridges loop: replace
`    if (!br.p || br.p.length < 4) continue;` by:

```js
    if (!br.p || br.p.length < 4) continue;
    if (br.id != null && opts.skipIds && (opts.skipIds.has ? opts.skipIds.has(br.id) : opts.skipIds.includes(br.id))) continue;   // drawn by wwmesh
```

**5.2 `wtiles.js`** — in `buildOpts(e)`, after the line
`const o = { lod: e.lod, structures: e.z === WT.Z_DETAIL, maxBuildings: this.B.buildings, maxVerts: this.B.structVerts, minBuildingH: far ? 6 : 0 };`:

```js
    if (this.skipIds?.size) o.skipIds = [...this.skipIds];              // registry bridges (wwmesh) — structured-clone friendly
```

and add a method next to `setPatchBoxes`:

```js
  /** Bridge ids drawn by wwmesh (registry): their D14 slabs are skipped on the next (re)build of a tile. */
  setSkipIds(ids) { const k = [...ids].sort().join('|'); if (k === this.skipKey) return; this.skipKey = k; this.skipIds = new Set(ids); }
```

**5.3 `terrain.js`** — after `this.wtiles?.setOrigin(origin);` nothing changes; in `main.js` 3.3 add after `setStatics`:
`this.terrain.wtiles?.setSkipIds?.(this.wwMesh.knownIds());`. Tiles already built keep their slab until their next rebuild (ETag push
or LOD change); acceptable for one pass, or force with the existing rebuild path if the integrator prefers.

**5.4 Tile fallbacks (optional)** — where `wtiles.js` receives a built tile with `vectors.bridges` of converter v2, call
`app.wwMesh.setFallbacks(list.map((b) => bridgeFromVector(b, t.z, t.x, t.y)).filter(Boolean))` (import from `./wwgeom.js`);
registry objects always win over fallbacks.

## 6. `public/js/harbor.js` (patch road ribbons over registry bridges)

**6.1** — `buildHarbor(harbor, geom)` gains an optional third parameter `opts = {}` and the roads loop

`  for (const r of roads) { const st = ROAD_LOD[r.kind]; addRibbon(fr, r.pts, (r.width || st.w) / 2, st.y, st.c, ground, r.bridge); }`

becomes:

```js
  for (const r of roads) {
    if (r.bridge && opts.skipNear && geom?.origin && r.pts.some((p) => { const ll = fromLocalXZ(geom.origin, p.x, p.z); return opts.skipNear(ll.lat, ll.lon); })) continue;   // drawn by wwmesh
    const st = ROAD_LOD[r.kind]; addRibbon(fr, r.pts, (r.width || st.w) / 2, st.y, st.c, ground, r.bridge);
  }
```

with `fromLocalXZ` = the file's existing local → lat/lon helper (or `fromLocal` from `/shared/geo.js`). In `main.js`, the two
`buildHarbor(h, entry.geom)` calls pass `{ skipNear: (lat, lon) => !!this.wwMesh?.lineNear(lat, lon, 20) }`.

## 7. `public/js/ocean2.js` (no ocean inside lock chambers)

**7.1 Uniforms** — in the constructor, immediately before
`this.material = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, fog: true });`:

```js
    this.uniforms.uCutN = { value: 0 };                                   // lock chambers (wwmesh.cutouts): up to 8 quads, world xz
    this.uniforms.uCutA = { value: Array.from({ length: 8 }, () => new THREE.Vector4()) };   // p0.xz, p1.xz
    this.uniforms.uCutB = { value: Array.from({ length: 8 }, () => new THREE.Vector4()) };   // p2.xz, p3.xz
```

and in that same line change `fragmentShader: FRAG` to `fragmentShader: FRAG.replace('void main() {', CUT_GLSL + 'void main() {\n  if (inCut(vWorld.xz)) discard;')`,
with at module level (after the `FRAG` constant):

```js
const CUT_GLSL = /* glsl */`uniform int uCutN; uniform vec4 uCutA[8]; uniform vec4 uCutB[8];
float side(vec2 a, vec2 b, vec2 p) { return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x); }
bool inCut(vec2 p) { for (int i = 0; i < 8; i++) { if (i >= uCutN) break; vec2 a = uCutA[i].xy, b = uCutA[i].zw, c = uCutB[i].xy, d = uCutB[i].zw;
  float s0 = side(a, b, p), s1 = side(b, c, p), s2 = side(c, d, p), s3 = side(d, a, p);
  if ((s0 >= 0.0 && s1 >= 0.0 && s2 >= 0.0 && s3 >= 0.0) || (s0 <= 0.0 && s1 <= 0.0 && s2 <= 0.0 && s3 <= 0.0)) return true; } return false; }
`;
```

**7.2 Method** — next to `setLevel(y)`:

```js
  /** Lock chamber footprints in world xz (4 points each): the ocean is not drawn there (the chamber water mesh is). */
  setCutouts(quads = []) {
    const u = this.uniforms; u.uCutN.value = Math.min(8, quads.length);
    quads.slice(0, 8).forEach((q, i) => { u.uCutA.value[i].set(q[0][0], q[0][1], q[1][0], q[1][1]); u.uCutB.value[i].set(q[2][0], q[2][1], q[3][0], q[3][1]); });
  }
```

(`vWorld` is the fragment's existing world-position varying; if it is camera-relative in this build, subtract the same offset
from the quads in 3.12.)

## 8. Server side (lane A wiring, for reference)

`ww_query {lat, lon, r}` → `ww_static {objects}` within 8 km (phone 5 km), cached client-side by `id + rev`; `ww` deltas for objects
within 15 km. Nothing in lane C reads other server state.

## 9. Checks after wiring

* `npm test` green (20 `ww3d-*` tests plus everything else; no existing test changed).
* Rozenburg in the browser: the Calandbrug has its truss span and lattice towers; the head bridges carry their boards; the gauge tag
  reads the clearance at today's water; no bridge is "only pillars"; the D14 slab under registry bridges is gone after a tile rebuild.
* A lock cycle: gates swing, the chamber water and the ship ride the level, foam during levelling, signals red → red+green → green.
* Budgets: `app.wwMesh.stats` ≤ 200 k tris desktop / 60 k phone, ≤ 80 / 30 objects, ≤ 64 / 24 textures.
* `;` toggles the air-draught card; Esc closes it; taps on bridges open their card on the phone (sheet).
