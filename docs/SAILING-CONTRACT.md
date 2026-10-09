# Saltline — real sailing: build contract (SAIL)

Design contract, 2026-10-09. Two parallel build lanes with disjoint files (**Lane A**: shared physics, server,
offline voyages, captains, tests; **Lane B**: ship models, deck walker, HUD and controls, client prediction hook-up,
browser scenarios) plus a **reviewer**. Root:
`/tmp/claude-0/-home-user/0e451cf3-a540-5510-b1a6-978d07bae2ed/scratchpad/saltline`. Functions are named by function
and by the statement they sit next to, never by line number.

Every number in §2.12, §6.4 and Appendix B was produced by the reference model in **Appendix A** (run on 2026-10-09:
VPP polars for the four classes, then a 10 Hz time-domain run of each polar point with the auto-trim controller —
all 60 checked points land within ±3.5 % of the polar). Lane A ports Appendix A into the `shared/sail/` modules
without changing equations or constants; if a constant has to move, the reviewer re-runs Appendix A and updates the
tables in the same commit.

Read with: `docs/ARCHITECTURE.md`, `docs/V4-CONTRACTS.md` §1 (time warp), `docs/V6-FLEET-CONTRACTS.md` §7 (captains),
`docs/V6-QUICK-CONTRACTS.md` §4 (autopilot) and §5 (ship clock), `docs/V5-PLAN.md` items 6–7 (walkable ship).

---

## 0. What the player gets

### 0.1 In plain words

- **Four new sailing boats, each one different and built like the real thing.**
  - *Sloop 11 m* — a modern cruiser: one tall aluminium mast, a mainsail and a big genoa (front sail) that rolls up.
  - *Ketch 16 m* — a strong ocean boat: two masts, a short bowsprit, two front sails (yankee and staysail), main and mizzen.
  - *Catamaran 14 m* — two hulls, a wide square-top mainsail, a small front jib, and a big light-wind sail (code 0).
  - *Classic schooner 35 m* — wooden gaff schooner: two masts with topmasts, a 7 m bowsprit, seven sails in tan canvas.
- **Every part is there:** masts, booms, gaffs, spreaders, stays and shrouds, sheets (ropes) to winches, traveller,
  wheel, keel and rudder. Masts stand clear of the deckhouses; you can walk around them on deck.
- **The sails do what real sails do.** They always sit on the side away from the wind. They fill and curve with the
  wind, shake (luff) when they are let out too far, flap hard when you point into the wind, and stall when they are
  pulled in too tight. Little ribbons (telltales) on the sails show you if your trim is good.
- **The wind really drives the boat.** You feel the *apparent wind* (the wind you feel on deck, from the true wind and
  your own speed). You cannot sail straight into the wind: closer than about 40–50° the boat gets slow, and closer than
  about 30° the sails just flap. The boat is fastest with the wind from the side.
- **Too much sail in strong wind is bad.** The boat leans over (heels) more, the helm gets heavy, she turns into the
  wind by herself (rounds up) and gets **slower**. Make the sails smaller (reef, roll up the genoa) and she stands up
  and goes **faster**. Pull the sails in or let them out to the right angle and you get the best speed.
- **You can handle the sails like on a real boat:** pull in or let out each sheet, move the traveller, reef the main,
  roll the front sail in or out, raise or lower each sail, tack (turn through the wind) and jibe (turn with the wind
  behind). A crew helper can do it for you: **Off**, **Hints** (the default: green marks show the best setting) or
  **Auto** (the crew trims and reefs for you).
- **New instruments:** a wind dial (true and apparent wind, the no-go zone), a heel meter, and the target speed for
  this wind (how fast the boat *should* go), so you can see how well you sail.
- Other players see your boat lean and your sails set the way you trimmed them.

### 0.2 Controls

| Action | Desktop | Phone / tablet |
|---|---|---|
| Open / close the sail panel | **Q** (or the *Sails* button) | *Sails* round button on the helm |
| Crew helper Off / Hints / Auto | **Shift+Q** cycles; segmented control in the panel | segmented control at the top of the sail sheet |
| Select a sail | **1 … 7** (front to back) | tap the sail chip |
| Pull in / let out the selected sheet | **]** / **[** (Shift = fine steps) | drag the sheet slider (green tick = best) |
| All sheets together | **Ctrl+]** / **Ctrl+[** | *Trim all* button (sets every sheet to the green tick once) |
| Traveller up / down (main, mizzen) | **=** / **-** | small traveller slider under the main's sheet |
| Reef one more / shake out one reef | **R** / **Shift+R** | *Reef −/+* stepper |
| Raise / lower (or roll out / roll in) the selected sail | **Shift+1 … Shift+7** | *Hoist* / *Lower* button (furling sails: slider 0–100 %) |
| All sails up / all down | the old *Sails: set / furled* button (kept) | same button in the *…* sheet |
| Tack or jibe (crew does it, you watch) | **Z** | *Tack* / *Jibe* button next to *STOP* / *AP* |
| Steer, engine | unchanged (A/D, W/S, telegraph) | unchanged (rudder slider, lever) |

Keys **Q Z R 1–7 [ ] - =** are free today (checked against `main.js` keydown). **R** keeps its chart meaning while the
chart is open (the chart handler runs first).

---

## 1. Common ground

### 1.1 Rules

- Node 20, plain ESM, no new dependencies, no build step; three.js r160 on the client. Tests: `node:test` +
  `node:assert/strict` in `test/*.test.mjs` (`npm test`). Game tests use the `fakeSocket`/`join` helpers copied out of
  `test/game.test.mjs` (never imported from another test).
- **Everything the physics needs is pure and deterministic** (no `Math.random`, no `Date.now`, no DOM) and lives in
  `shared/sail/` so the server, the client prediction, offline voyages, captains, the autopilot and the tests run the
  same code. Gusts use the world sim time (`env.simTime`) and a position hash, never a random source.
- **Do not touch** (another agent is editing them now): `server/worldtiles.js`, `server/wtsource.js`,
  `server/wtconvert*.js`, `server/wtprefetch.js`, `server/harborgeom.js`, `server.js`, `package.json`. Never touch
  `data/`. No git operations by the lanes; the reviewer merges.
- Units: SI inside the sail modules (m, s, N, kg); knots and degrees at the interfaces that already use them
  (`s.spd` kn, `s.hdg` °). 1 game unit = 1 m. Ship frame: x to starboard, y up (0 = waterline), z aft (bow at −L/2).
- Engine ships are untouched: every change in `shared/physics.js` sits behind `if (C.sail)`.

### 1.2 Why it looks and feels wrong today (code findings)

1. **Sails point into the wind.** `main.js` `windRel()` returns `normDeg(from − hdg)`, i.e. 0…360. `ship.js`
   `setSails()` takes `side = rel > 0 ? -1 : 1`, so the side is −1 for every wind but dead ahead: the boom always goes
   to port. With the wind from port (rel 181–359°) the sails stand to windward. `ais.js` passes the same 0…360 value.
   The sheeting angle itself is right (`a = |((rel+540)%360) − 180|` folds correctly).
2. **Sails inside the deckhouse (schooner).** `ship.js` `BUILDERS.schooner` puts deckhouse boxes at z = L·0.14 ± L·0.07
   (2.45…7.35 m) and z = −L·0.2 ± L·0.05 (−8.75…−5.25 m) while `rig()` puts the masts at z = L·0.12 = 4.2 m and
   z = −L·0.22 = −7.7 m: both masts, both booms (at deck + 1.6 m) and both sail feet stand inside the houses. The deck
   plan (`shipplan.js` `SAIL.schooner`, doghouse roof 0.05…0.22·L = 1.75…7.7 m) has the mainmast's 12 m `solid`
   inside the walk-in doghouse.
3. **Poor quality.** Freeboard is `C.freeboard || max(3, 0.045·L)` → a 3 m-high topside on the 11 m sloop, 16 m ketch
   and catamaran (real: 1.2–1.5 m). Sails are flat single `ShapeGeometry` triangles with no camber, one boom height
   (deck + 1.6 m) for every class, no staysails/topsails/flying jib, gaff drawn as a stick, no sheets, no winches,
   one generic `yachtShape` hull for every monohull, catamaran mast at z = −0.05·L in `ship.js` but −0.15·L − 0.6 in
   the deck plan.
4. **No sailing physics.** `shared/physics.js` `sailPolar()` is a fixed curve of true wind angle × `min(1.1, spd/9)`
   (× 0.6 above 22 m/s); no apparent wind, no heel, no leeway, no trim, no reefing, `sailsUp` is one boolean. Heel in
   `motion.js` is cosmetic (`windHeel·(U/12)²`, eased above 13 m/s). The autopilot, captains and offline voyages steer
   straight at the waypoint, so a sailing yacht with an upwind leg stops dead in the no-go zone. Other players always
   see the default sail angle (`buildShip` calls `setSails(true, 90)` once; only the own ship is updated).

### 1.3 Lanes and file ownership

| Lane | Owns (create / edit) | Must not edit |
|---|---|---|
| **A — physics & server** | NEW `shared/sail/rigs.js`, `shared/sail/state.js`, `shared/sail/aero.js`, `shared/sail/hydro.js`, `shared/sail/sailphys.js`, `shared/sail/trim.js`, `shared/sail/polar.js`, `shared/sail/polars.gen.js` (generated), `shared/sail/tactics.js`, `scripts/gen-polars.mjs`; EDIT `shared/physics.js` (sail branch of `stepShip`, `sailPolar` kept as a wrapper), `server/game.js`, `server/fleet.js`, `server/captain.js`; NEW tests `test/sail-*.test.mjs` listed in §6.4 (A) | anything under `public/`, `shared/constants.js` (read only), files in §1.1 "do not touch" |
| **B — client** | NEW `public/js/rigcore.js` (pure geometry, node-testable), `public/js/rigmesh.js` (three.js rig + cloth), `public/js/sailhud.js` (DOM panel + instruments), `public/js/sailfmt.js` (pure formatters/advice), `public/js/yachtlooks.js` (pure per-class hull lines, deck layout, colours); EDIT `public/js/ship.js`, `public/js/shipplan.js`, `public/js/interior.js`, `public/js/motion.js`, `public/js/main.js`, `public/js/net.js`, `public/js/hud.js`, `public/js/touch.js`, `public/js/autopilot.js`, `public/js/ais.js`, `public/js/thumbs.js`, `public/js/sound.js`, `public/index.html`, `public/css/*`; NEW tests `test/sail-client-*.test.mjs` (§6.4 B) | `shared/**`, `server/**` |
| **Reviewer** | `docs/SAILING-CONTRACT.md` (tables if constants change), `docs/STATUS.md` line | code (findings go back to the owning lane) |

Shared tests that already exist and must stay green (both lanes run the whole suite): `test/telegraph.test.mjs`
(astern ratio for every class with `env.sailsUp: false`), `test/warp.test.mjs` (sloop under sail warps without fuel;
`sailsUp = false` refuses), `test/interior*.test.mjs`, `test/fleet-*.test.mjs`, `test/timemodel.test.mjs`.

### 1.4 The frozen interface (Lane A delivers these first; Lane B codes against them from hour 0)

Lane A's **first commit** is `shared/sail/rigs.js` (verbatim data of §2.4 + Appendix A `TYPES`), `shared/sail/state.js`
and stub `shared/sail/trim.js` / `polar.js` exporting the signatures below (stubs may return plausible constants).
Signatures and shapes are frozen; only the reviewer changes them.

```js
// shared/sail/rigs.js — data only (+ tiny helpers)
export const SAIL_TYPES;            // { main, gaff, genoa, jib, stay, topsail, mizzen, code0 } → { clmax, as, cd0, tw0 } (Appendix A TYPES)
export const RIGS;                  // { sloop, ketch, catamaran, schooner } → Rig (§2.4)
export function rigOf(cls);         // Rig | null (null for engine classes)
export function sailIds(cls);       // ['genoa', 'main'] … in RIGS order (front to back) — the order of rv and of the HUD rows
export function sailArea(rig, id, hoist = 1, reef = 0);   // m² (A · reef factor · hoist), furl handled by the caller (hoist = unrolled fraction)

// shared/sail/state.js — the rig state on the ship (saved, sent in `you`), commands, the compact view for others
export const RIG_SCHEMA = 1;
export const AUTO = ['off', 'hint', 'full'];
export function defaultRig(cls, { hoisted = false, auto = 'hint' } = {});   // → RigState | null
export function ensureRig(ship, legacySailsUp);  // creates/repairs ship.rig for ship.cls (rig.cls mismatch → new rig); returns ship.rig | null
export function normalizeRig(cls, rig, legacySailsUp); // clamp/repair a saved or received rig; never throws
export function anyHoisted(rig);                 // true when any sail has hoist > 0.05 or hoistCmd > 0
export function applyRigCommand(cls, rig, cmd);  // validates + applies a client command (§3.4) → { ok: true } | { ok: false, why }
export function applyPlan(cls, rig, level);      // set hoistCmd/reefCmd for plan level (crew preset), returns rig
export function packRigView(cls, rig);           // → int[] (§3.7 "rv")
export function unpackRigView(cls, rv);          // → RigView | null (validated)
export function rigViewOf(cls, rig);             // RigState → RigView (own ship rendering)

// shared/sail/trim.js
export function trimInfo(cls, ship, env);        // → TrimInfo (§3.3) for the HUD (pure, cheap; uses the last step's diagnostics in ship.rig)
export function autoTrimView(cls, awaDeg, awsMs); // → RigView for ships without a rig state (AIS sail boats, thumbnails, legacy setSails)
// shared/sail/polar.js
export function polarSpeed(cls, twsKn, twaDeg);  // → { kn, heel, leeway, level } (bilinear in polars.gen.js; |twa| folded to 0…180)
export function bestVmg(cls, twsKn);             // → { up: { twa, kn, vmg }, down: { twa, kn, vmg } }
export function noGoDeg(cls, twsKn);             // → the HUD no-go half-angle = bestVmg(...).up.twa − 5
export function maxSpeedKn(cls);                 // RIGS[cls].vmaxKn (server move budget, speed clamps)
// shared/sail/tactics.js
export function sailCourse(cls, q, mem);         // § 3.5 → { hdg, maneuver: null | 'tack' | 'jibe', helmFF }
```

Types (JSDoc in `state.js`):

```js
/** RigState — ship.rig (saved in vessel.ship, sent in `you`). All angles degrees, all fractions 0…1. */
{ v: 1, cls: 'sloop', auto: 'hint',            // crew helper level
  lv: 0, lvAt: 0,                               // plan level last applied by the crew (auto 'full') and sim time of it
  d: 0,                                         // depower 0…0.9 (auto-trim controller memory)
  heel: 0, leeway: 0, helm: 0,                  // physics output: heel + = starboard rail down; leeway + = moving to starboard of the heading; helm = weather-helm load (1 = full rudder)
  awa: 0, aws: 0, twa: 0, tws: 0,               // apparent / true wind over the water: angle signed (+ = from starboard), speed m/s
  tack: 1, irons: 0, jibe: 0,                   // +1 starboard tack (wind from starboard) / −1 port; seconds in irons; sim time of the last jibe
  flags: 0,                                     // bit 0 by-the-lee, 1 rounding up, 2 hull flying (cat), 3 overpowered, 4 crash jibe this step
  sails: { [id]: {
    hoist: 1, hoistCmd: 1,                      // furling sails: unrolled fraction; others: hoisted fraction (0 or 1 when idle)
    reef: 0, reefCmd: 0,                        // slab reef 0…reefs.length
    sheet: 0.3, sheetCmd: 0.3,                  // 0 = hard in … 1 = all out (maps to the chord angle §2.3.4)
    trav: 0, travCmd: 0,                        // −1 car to windward … +1 to leeward (boomed sails only; others 0)
    side: -1,                                   // −1 clew/boom to port, +1 to starboard (always to leeward unless backed / by the lee)
    angle: -20,                                 // chord angle at the foot, signed by side (deg) — what the boom shows
    state: 0,                                   // 0 drawing, 1 luffing, 2 flogging, 3 stalled, 4 crew working on it, 5 down
    tt: 0,                                      // telltales: 2 bits per band (bottom, middle, top): 0 streaming, 1 windward lifting, 2 leeward stalling
    work: 0, job: null } } }                    // crew job seconds left; 'hoist' | 'lower' | 'reef' | 'shake' | null

/** RigView — what a renderer needs (own ship from RigState, others from rv) */
{ heel, sails: [{ id, hoist, reef, angle, state, tt }] }   // RIGS order

/** TrimInfo — HUD */
{ tws, twa, aws, awa, twsKn, targetKn, pct, vmg, heel, heelT, helm, noGo, advice: { key, text } | null,
  sails: [{ id, name, state, tt, sheet, sheetOpt, sheetLo, sheetHi, trav, travOpt, reef, reefs, hoist, canFurl, work, job }] }
```

### 1.5 Order of work

1. **A1** (first 1–2 h): `rigs.js`, `state.js`, stubs of `trim.js`, `polar.js`, `tactics.js`; `test/sail-state.test.mjs`.
2. In parallel: **A2** physics (`aero/hydro/sailphys`, `physics.js` hook), **A3** polar generator + tables, **A4**
   server/captain/offline; **B1** rig geometry + meshes, **B2** hull looks + deck plans, **B3** HUD/controls,
   **B4** prediction hook-up and multiplayer view, **B5** freeboard/interior.
3. Integration (§6.3): reviewer runs `npm test`, the browser scenarios (§6.5), the acceptance list (§6.6).

---

## 2. Physics model (Lane A)

### 2.1 Conventions

- **TWA, AWA signed**: `angleDiff(hdg, windFrom)` (−180…180], **+ = wind over the starboard side** (starboard tack,
  `tack = +1`). The aerodynamics work on |angle| (0…180) and the result is mirrored by `tack`.
- **Heel** `rig.heel` + = starboard rail down. Wind from starboard heels to port → `rig.heel = −tack·φ` (φ ≥ 0 is the
  magnitude). `motion.js` convention is roll > 0 = heeled to port, so **roll = −heel·π/180**.
- **Leeway** `rig.leeway` + = moving to starboard of the heading; `rig.leeway = −tack·λ`; course through the water =
  `hdg + rig.leeway`.
- **Sail side** −1 = boom/clew to port. Normal sailing: `side = −tack`.
- `s.spd` stays the speed through the water along the heading (kn); position integration adds leeway and current.

### 2.2 Wind

1. **True wind over the ground** `env.wind {u, v}` m/s at 10 m (weather, unchanged). **Over the water**:
   `W = wind − current − tideStream` (vectors). `tws = |W|`, `twd = atan2(−W.u, −W.v)` (from), `twa = angleDiff(hdg, twd)`.
   This is the "wind including current": a 2 kn tide against the wind adds 2 kn of true wind over the water.
2. **Gusts** (game only; tests pass `env.gusts = false`): `g = 1 + G·(0.55 sin(2πt/17 + p1) + 0.30 sin(2πt/41 + p2) +
   0.15 sin(2πt/97 + p3))`, `G = clamp(0.5·(gust/spd − 1), 0, 0.25)`, `t = env.simTime`, phases `p1..p3` from an integer
   hash of `(round(lat·10), round(lon·10))`. `tws10 = g·|W|`.
3. **Gradient**: wind at height z (m above the waterline) `tws(z) = tws10·(max(z, 1)/10)^0.13`.
4. **Apparent wind per band** (boat velocity through the water V at leeway λ):
   `ax = tws(z)·cos|twa| + V·cos λ`, `ay = tws(z)·sin|twa| − V·sin λ`, `aws = hypot(ax, ay)`, `awa = atan2(ay, ax)`.
5. **Heeled sail plane** (Kerwin): `β = atan2(sin awa·cos φ, cos awa)`, `aws_e = aws·√(cos²awa + sin²awa·cos²φ)`. With
   the cos φ inside the dynamic pressure this gives the classic "≈ cos² φ" loss of drive and heeling force.

### 2.3 Sail aerodynamics

**2.3.1 Bands.** Each hoisted sail is evaluated at three heights η = 1/6, 1/2, 5/6 of its (reefed) luff span, with area
weights 5/9, 3/9, 1/9 for triangles and 0.40, 0.33, 0.27 for gaff quadrilaterals. The span is `y0 … y0 + (y1 − y0)·√r`
for a reef factor r. One aerodynamic evaluation = 3 bands × sails (sloop 6, schooner 21 band evaluations).

**2.3.2 Angle of attack** per band: `α = β − (δ + τ·η) − dw·sstep(70, 40, awa)` where δ is the chord angle at the foot
(from sheet and traveller, §2.3.4), τ the twist, `dw` the downwash from sails ahead (5° behind a hoisted headsail,
3° behind another boomed sail; headsails have none; fades out between AWA 40° and 70°).

**2.3.3 Coefficients** (`coeffs(type, α)`, Appendix A): α ≤ 0 → flogging `cl = 0, cd = cd0 + 0.10`; 0 < α < 6° →
luffing ramp; 6° ≤ α ≤ αs → `cl = clmax·sin(π/2·α/αs)`, `cd = cd0 + 0.05·cl²`; beyond αs a smoothstep over 25° to the
flat plate `cl = 1.3 sin α cos α`, `cd = 1.3 sin² α + cd0` (stalled when the blend > 0.25). Per type:

| type | clmax | αs (°) | cd0 | base twist τ0 (°) | used for |
|---|---|---|---|---|---|
| main | 1.50 | 20 | 0.030 | 6 | sloop, ketch, catamaran mainsail |
| gaff | 1.32 | 22 | 0.055 | 12 | schooner fore and main |
| genoa | 1.65 | 18 | 0.028 | 8 | sloop genoa |
| jib | 1.60 | 18 | 0.030 | 8 | yankee, cat jib, schooner jib and flying jib |
| stay | 1.50 | 18 | 0.032 | 8 | staysails |
| topsail | 1.25 | 20 | 0.055 | 8 | schooner gaff topsails |
| mizzen | 1.45 | 20 | 0.032 | 6 | ketch mizzen |
| code0 | 1.75 | 28 | 0.040 | 10 | catamaran code 0 (light-wind reaching sail) |

Modifiers: rolled-in fraction f → `cl·(1 − 0.3 f)` (a part-furled sail is a poor shape) and area `·(1 − f)` — for
furling sails the state's `hoist` is the unrolled fraction u and enters only as f = 1 − u; reef n →
`cl·(1 − 0.04 n)`, area · reef factor; partly hoisted h (non-furling sails) → `cl·h²` (a half-hoisted sail is a bag), area · h. **Wind
shadow** of the main on headsails and sails flagged `blank` (schooner fore and fore topsail): apparent wind speed ×
`(1 − 0.65·sstep(110, 170, awa))` (so the pressure × its square), the loss quartered when |twa| > 160° (wing-on-wing). **Slatting** in light air and a
sea: when aws < 4 m/s and waveH > 0.5 m, `cl·(1 − 0.15·min(1, waveH))` and the state shows luffing.

**2.3.4 Sheet, traveller, twist.** Each sail has `dmin`, `dmax` (§2.4). Boomed sails: traveller car angle
`δcar = travMin + (trav + 1)/2·(travMax − travMin)`, chord angle `δ = δcar + sheet·(dmax − δcar)`; twist
`τ = τ0 + 8·clamp((δ − δcar)/20, 0, 1)` — easing the sheet opens the leech, moving the car does not. Headsails (and the
schooner topsails): `δ = dmin + sheet·(dmax − dmin)`, `τ = τ0 + 6·clamp((δ − dmin)/25, 0, 1)`. Inverse (for the HUD and
auto-trim): `sheet = (δ − δcar)/(dmax − δcar)` clamped.

**2.3.5 Forces.** Per band with weight w and area A: `q = ½ρa(aws_e·blank)²·A·w`, drive `fx = q(cl sin β − cd cos β)`,
heeling force normal to the mast `fn = q(cl cos β + cd sin β)`. Sums: `Fx`, `Fn`, heeling moment
`HM = Σ fn·(z + zclr)`, yaw moment about the centre of lateral resistance `Mz = Σ fn·cos φ·(zc − xclr)` (zc = the sail's
area centroid along the ship, + aft). Windage of hull, rig and crew: `q = ½ρa·aws(6 m)²·Apar·0.9` along the apparent wind
(drag on `Fx`, side on `Fn`, lever `fb + 2 + zclr`).

**2.3.6 Sail state and telltales** (for the HUD, the renderer and `rv`): per band `0` streaming (6° ≤ α ≤ αs), `1`
windward telltale lifting (α < 6°: sheet in / bear away), `2` leeward telltale stalling (α > αs: ease / head up). Sail
state from the middle band: drawing 0, luffing 1 (0 < α < 6), flogging 2 (α ≤ 0), stalled 3 (blend > 0.25), crew
working 4 (job running), down 5.

### 2.4 Rigs per class (frozen data; Lane A copies into `shared/sail/rigs.js`)

The sail classes in `shared/constants.js` are exactly **sloop, ketch, catamaran, schooner** (`sail: true`). There is no
square-rigger; none is added. `C.length` stays LOA (hull without bowsprit); `C.maxKn` stays the economy rating
(`shared/rates.js` `serviceKn`), the physics uses the rig.

**Hull and stability** (Appendix A field names). LWL waterline length (m), T draught, disp displacement (t), GM
metacentric height (m), AVS angle of vanishing stability (°), Sw wetted area (m²), Alat lateral area of keel + canoe
body + rudder (m²), ARk effective keel aspect ratio, bK effective keel span (m), Ar rudder area (m²), br rudder span,
zr rudder position (ship z), zclr CLR depth (heel lever addition, m), xclr CLR position (ship z), Apar windage area (m²),
rr residuary-resistance family, fb deck height (m), phiT the crew's target heel (°), turn = `C.turnRate`, tauPhi heel
lag (s), vmaxKn absolute speed cap, crew = parallel crew jobs.

| | sloop 11 m | ketch 16 m | catamaran 14 m | schooner 35 m |
|---|---|---|---|---|
| type | modern 9/10 fractional cruiser, fin + bulb keel, spade rudder | blue-water cutter-ketch, long fin keel, skeg rudder, 1.1 m bowsprit | cruising cat, mini keels, twin spade rudders, code 0 on a short bowsprit | classic gaff schooner with topmasts, long keel, 7.2 m bowsprit |
| LWL / T / disp | 9.7 / 1.9 / 6.0 | 13.4 / 2.3 / 18 | 13.6 / 1.3 / 12 | 26.5 / 3.5 / 180 |
| hull speed 2.43√LWL kn | 7.6 | 8.9 | 9.0 (slender hulls pass it) | 12.5 |
| stability | GM 1.45, AVS 120 | GM 1.5, AVS 125 | hulls ±3.0 m, KG 2.4, flies at 5° | GM 1.35, AVS 115 |
| Sw / Alat / ARk / bK | 25 / 2.9 / 1.6 / 2.85 | 40 / 6.5 / 1.0 / 3.2 | 42 / 8.2 / 0.7 / 2.2 | 175 / 48 / 0.7 / 4.55 |
| Ar / br / zr | 0.55 / 1.35 / 4.3 | 1.0 / 1.5 / 6.6 | 0.9 (two) / 1.0 / 6.3 | 4.2 / 2.6 / 15.2 |
| zclr / xclr | 0.8 / 0.0 | 1.0 / 0.0 | 0.6 / −0.4 | 1.5 / 2.1 |
| Apar / rr / fb | 8 / mod / 1.25 | 13 / heavy / 1.45 | 30 / cat / 1.9 (bridge deck; hull decks 1.35) | 70 / heavy / 1.7 |
| phiT / turn / tauPhi | 22 / 22 / 1.5 | 20 / 16 / 2 | 4 / 18 / 1.5 | 18 / 9 / 3 |
| vmaxKn / crew | 12 / 1 | 13 / 1 | 18 / 1 | 15 / 2 |
| working sail area | 67 m² (main 32, genoa 35) | 119 m² | 105 m² (+ code 0 72) | 578 m² (all seven) |

**Sails** — points `[z, y]` in the ship's centre plane, tack → head → clew (gaff sails: tack → throat → peak → clew);
the area is the polygon × `roach`. Exact data in Appendix A `RIGS`; summary:

| class | sail (RIGS order = rv order) | type | area m² | reefs (area factor) | furler | dmin…dmax | traveller | plan levels it is in |
|---|---|---|---|---|---|---|---|---|
| sloop | genoa | genoa | 35.1 | — | roller | 12…75 | — | all (L1 25 % rolled, L2 50 %, L3 75 %) |
| | main | main | 32.3 | 0.78, 0.58 | — | −3…80 | −3…+12 | all (L1 reef 1, L2–L3 reef 2) |
| ketch | yankee | jib | 34.3 | — | roller | 13…75 | — | L0, L1 (30 % rolled) |
| | stay | stay | 23.7 | — | hanked | 11…70 | — | all |
| | main | main | 42.9 | 0.78, 0.58 | — | −3…80 | −3…+12 | L0, L1 r1, L2 r2 (down in L3) |
| | mizzen | mizzen | 18.2 | 0.75 | — | −2…80 | −2…+10 | all (L2–L3 reef 1) |
| catamaran | code0 | code0 | 71.8 | — | roller | 20…95 | — | L0 only (light air, TWS ≤ 14 kn) |
| | jib | jib | 33.0 | — | roller (self-tacking) | 12…60 | — | L1–L3 (L3 40 % rolled) |
| | main | main | 72.0 | 0.75, 0.55, 0.38 | — | −3…75 | −3…+15 | all (L2 r1, L3 r2) |
| schooner | flyjib | jib | 45.8 | — | hanked | 14…70 | — | L0 |
| | jib | jib | 70.6 | — | hanked | 13…70 | — | L0–L2 |
| | stay | stay | 43.9 | — | club-footed | 12…70 | — | all |
| | fore | gaff | 118.8 | 0.78 | — | 0…80 | 0…+6 (deck horse) | all (L3 r1) |
| | foretop | topsail | 27.8 | — | — | 4…80 (follows the fore gaff) | — | L0 |
| | main | gaff | 219.4 | 0.78, 0.60 | — | 0…80 | 0…+8 (stern horse) | all (L2 r1, L3 r2) |
| | maintop | topsail | 51.6 | — | — | 4…80 | — | L0 |

**Plan levels** (crew presets; the auto-trim picks the polar's best allowed level, §3.3): sloop L0 ≤ 24 kn true,
L1 ≥ 14, L2 ≥ 20, L3 ≥ 28; ketch L0 ≤ 24, L1 ≥ 14, L2 ≥ 20 (yankee down, main r2, mizzen r1), L3 ≥ 30 (staysail +
reefed mizzen, "jib and jigger"); catamaran L0 ≤ 14 (code 0 + main), L1 ≤ 20, L2 16…28 (main r1), L3 ≥ 22 (main r2,
jib 40 % rolled); schooner L0 ≤ 18 (all seven), L1 ≤ 26 (no topsails, no flying jib), L2 ≥ 16 (+ main r1), L3 ≥ 22
(jib down, main r2, fore r1). The catamaran is not heel-limited, so its levels are by wind speed (how real crews reef
cats); monohulls also depower by heel (§3.3).

**Spars, stays and deck fittings** (ship frame `[x, y, z]`; frozen so the physics, the renderer and the deck walker
agree). `rigs.js` exports them as `RIGS[cls].spars`:

| | sloop | ketch | catamaran | schooner |
|---|---|---|---|---|
| masts (z; foot y → top y; Ø at foot → top) | main z −1.3; 1.80 (on the coachroof) → 16.2; 0.20 → 0.12 alu | main z −2.6; 1.55 (deck) → 18.85; 0.22 → 0.13; mizzen z +4.0; 1.40 → 13.7; 0.15 → 0.09 | main z −2.7; 1.90 (bridge deck, 0.6 m ahead of the saloon) → 22.2; 0.24 → 0.14 | fore z −7.7; 1.82 → cap 22.0, topmast → 28.2; 0.42 → 0.28 / 0.20 → 0.10 wood; main z +2.8; 1.70 → cap 26.0, topmast → 33.2; 0.48 → 0.32 / 0.22 → 0.11 |
| booms (gooseneck `[z, y]`, length, rise to clew) | main [−1.3, 3.15], 4.45, +0.15 | main [−2.6, 3.45], 5.2, +0.15; mizzen [4.0, 3.65], 3.4, +0.15 | main [−2.7, 4.5], 6.4, +0.1 | fore [−7.4, 3.9], 9.2, +0.4; main [3.1, 4.3], 14.1, +0.6; staysail club [−17.2, 2.4] → [−10.4, 2.9] |
| gaffs (throat → peak) | — | — | — | fore [−7.4, 17.2] → [−1.6, 21.6]; main [3.1, 20.3] → [12.0, 25.7] |
| spreaders (y, half-span, sweep °) | 6.6 / 1.25 / 20; 11.3 / 0.85 / 20 | main 7.6 / 1.4 / 0; 13.0 / 0.95 / 0; mizzen 9.0 / 0.9 / 0 | 9.5 / 1.5 / 25; 15.5 / 1.0 / 25 | crosstrees fore 21.0 / 1.8; main 25.3 / 2.0 |
| shroud chainplates | x ±1.55, y 1.30, z −0.95 | main x ±2.15, z −2.6; mizzen x ±1.75, z +4.1 | hull insides x ±2.35, y 1.4, z −2.2 | channels at the caprail x ±3.65, y 2.35: fore z −8.4/−7.7/−7.0, main z +2.1/+2.8/+3.5 (deadeyes, ratlines on the lower shrouds) |
| head stays (luff = stay) | forestay [0, 1.65, −5.35] → [0, 15.2, −1.3] (furler foil) | yankee stay bowsprit tip [0, 2.0, −9.0] → masthead; inner forestay [0, 1.75, −6.4] → [0, 13.8, −2.6] + running backstays to [±2.0, 1.5, 4.8] | forestay crossbeam [0, 2.0, −6.2] → [0, 19.2, −2.75]; code 0 bowsprit [0, 2.1, −7.6] → masthead | staysail stem head [0, 2.4, −17.2] → [0, 16.0, −7.7]; jib [0, 2.8, −21.0] → [0, 21.5, −7.7]; flying jib [0, 3.2, −24.0] → [0, 27.0, −7.7] |
| other stays | backstay masthead → [0, 1.15, 5.45] (split to the quarters) | triatic main masthead → mizzen masthead; mizzen backstays → [±1.6, 1.45, 7.6] | — (swept spreaders, diamonds) | spring stay fore cap → main hounds; main topmast stay → fore cap; main running backstays → [±3.3, 2.3, 9.0]; topmast backstays → [±3.4, 2.2, 6.0]; bobstay, whisker stays, dolphin striker |
| bowsprit | — | [0, 1.8, −7.9] → [0, 2.0, −9.1] with pulpit | longeron [0, 2.0, −6.2] → [0, 2.1, −7.6] | heel [0, 2.5, −14.5], stem [−17.0], tip [0, 3.1, −24.5]; martingale [0, 1.2, −20.5] |
| traveller / horse (z, y, half-width) | 3.0, 0.85 (cockpit sole), 0.95 | main on the coachroof aft end 1.6, 2.45, 0.9; mizzen on the stern rail 7.5, 1.5, 0.7 | hardtop aft edge 3.6, 4.05, 2.2 | fore horse 1.6, 1.95, 1.3; main horse 16.6, 2.1, 2.0 |
| headsail sheet leads → winches | tracks x ±1.45, z −0.6…+0.6; primaries [±1.35, 1.75, 2.3]; halyard winches [±0.55, 1.85, 1.4] | yankee [±1.85, 2.0, 2.4], staysail [±1.6, 2.0, 2.0] | self-tacker track z −3.2, y 2.0, ±1.2; winches on the coachroof [±1.0, 4.0, 2.7] | sheets to pin rails and bitts (no winches; tackles with blocks) |
| wheel (hub `[x, y, z]`, radius) | [0, 1.75, 4.1], 0.50, pedestal | [0, 2.35, 5.4], 0.60 | [2.2, 2.6, 2.9], 0.40 (starboard helm bulkhead) | [0, 2.75, 12.6], 0.75, wooden spokes on a wheel box |
| keel / rudder (visual) | fin root chord 1.6 → tip 1.1, y −0.5 → −1.5, swept 15°, LE at z −0.6; bulb y −1.5 … −1.9, length 2.2; spade rudder z 4.3, 1.35 × 0.42 | long fin z −2.4 … +1.8, to y −2.3, bulb-less; skeg + rudder z 6.2 … 7.0 | mini keels chord 2.0, 0.7 below the hulls at z +0.6; rudders z 6.0, 0.45 m² each | full keel z −10 … +8 to y −3.5, rudder on the sternpost z 12.5 … 15.2 |

### 2.5 Hull hydrodynamics

- **Friction** (ITTC-57): `Re = V·0.7·LWL/ν`, `cf = 0.075/(log10(max(Re, 1e5)) − 2)²`, `Rf = ½ρw V² Sw cf·1.12`.
- **Wave making** (residuary): `Rr = disp·g·r(Fn)`, `Fn = V/√(g·LWL)` (hull speed ≈ Fn 0.40), `r` by linear interpolation
  in the family table (Appendix A `RR`: `mod` sloop, `heavy` ketch and schooner, `cat` slender twin hulls without the
  hump). Beyond the last point the last slope continues.
- **Heel drag**: `(Rf + Rr)·(1 + 0.5(φ/30)² + 2.0·max(0, (φ − 25)/20)²)` (deck edge and transom immersion).
- **Leeway and keel**: lift slope `cla = 2π·ARk/(ARk + 2)`; `q = ½ρw·max(V, 0.5)²`; `λ = Fs/(q·Alat·cla)` (Fs = horizontal
  sail side force `Fn cos φ`). The keel stalls at 10°: side force capacity `q·Alat·cla·10°`; above it the boat slips
  sideways — `λ = 10 + min(20, (λlin − 10)/2)` with an extra drag `q·Alat·sin²(3·excess)`. **Induced drag** of the keel
  `Ri = Fk²/(q·π·(bK cos φ)²)` (heel shortens the effective span).
- **Rudder and weather helm**: yaw moment that wants to turn the bow to windward
  `Mw = Mz + sin φ·(Fx·zCE + 0.13·½ρw V²·LWL·Alat)` (drive offset to leeward + hull asymmetry). Rudder capacity
  `LrMax = q·Ar·1.2` at lever `zr − xclr`; **helm load** `H = Mw/(LrMax·(zr − xclr))` (1 = the rudder at its stall
  limit). Rudder lift is capped at `LrMax`; its drag `Lr²/(q π br²) + q·Ar·0.5·max(0, δr − 12°)²` (δr from the lift
  slope 2π·3/5, rad²).
- **Seaway**: the existing `speedPenalty` (condition, flooding, load, sea, `waveSpeedLoss`) becomes a resistance factor
  `R·1/speedPenalty²` for sail classes (so the steady speed falls by the same fraction as an engine ship's).

### 2.6 Heel and righting moment

- Monohull `RM(φ) = disp·g·max(−0.2, GM sin φ·(1 − (φ/AVS)²)·(1 + 0.35 sin² φ))`. Catamaran
  `RM(φ) = disp·g·(hs cos φ·min(1, φ/φfly) − (φ > φfly ? KG sin φ : 0))` (stiff until the windward hull lifts at 5°).
- **Equilibrium** each step without extra aero calls: with `HM0` at the current φ, solve `HM0·cos²φ'/cos²φ = RM(φ')` by
  4 Newton steps (numeric slope over 0.5°), clamp 0…80°, then lag: `φ += (φt − φ)(1 − e^(−dt/tauPhi))`.
- **Catamaran hull flying**: `HM/RMmax ≥ 0.70` → flag *hull flying* (HUD warning "Windward hull lifting — ease the
  sheets"); `≥ 0.85` → the crew eases every sheet to 1 for 5 s in **all** helper levels (no capsize in the game) and
  the auto level steps up one plan level; `≥ 1.0` for 2 s → cond −1 (gear strain) and the same release.
  Reference: plain sail at 60° true reaches 0.56 of RMmax in 25 kn, 0.70 in 30 kn, 0.85 in 35 kn.

### 2.7 Steering under sail

- Legacy yaw (`stepShip`) stays: `turnRate·rudder·steer·(way + wash)`. For sail classes the rudder term is multiplied
  by the **rudder authority** `auth(φ) = cos φ·(1 − 0.7·sstep(30, 50, φ))` (ventilation past 30°), and the sail adds
  **`+tack·turnRate·way·clamp(H, −1.5, 1.5)`** (positive H turns the bow towards the wind). H is smoothed with
  `H += (Ht − H)·min(1, dt/1.0)`.
- **Rounding up / broach** is emergent: when `H > auth·|rudder available|` she luffs even against full opposite helm,
  the sails luff, the heel drops and she can bear away again. The flag `rounding up` is set while the boat turns to
  windward against ≥ 0.8 opposite rudder.
- **In irons**: |awa| < 25° and STW < 1 kn for 3 s → the crew backs the headsail: yaw `−tack_prev·0.12·turnRate`°/s
  away from the wind until |awa| > 40°.
- **Helm feed-forward** for every automatic helm (client autopilot, captains, offline voyage, Tack/Jibe button):
  `rudderCmd = clamp(angleDiff(hdg, want)/25 + tack·H/max(auth, 0.2), −1, 1)` (`sailCourse()` returns `helmFF`).
  A human feels the weather helm (the HUD helm bar, §5.3); the autopilot does not wander off course.

### 2.8 Tack and jibe

- **Side flip through the wind (tack)**: when `side == tack` (sail on the windward side) and |awa| < 100°, the sail
  flips to `−tack` (the clew/boom crosses gently while luffing); the renderer animates it (§4.5). Speed loss through the
  tack is emergent (flogging + low |awa|).
- **Jibe**: running with the wind crossing the stern, a boomed sail stays on its side until the boat is by the lee
  by more than 8° (`side == tack` and |awa| ≥ 100° and `180 − |awa| > 8`), then it crosses. **Controlled** if its chord
  angle |δ| ≤ 25° at that moment (sheet hauled in, or the crew did it: helper *hint/full* and the Z button centre the
  booms when |awa| > 150° and the helm is turning through the stern). Otherwise **crash jibe**: flag bit 4, a yaw kick
  of 10° towards the wind, a heel kick of 8° to the new leeward side, and — **only with helper *off*** — damage
  `cond −min(3, 0.2 + 0.08·(aws − 6))·A_main/30` points (aws m/s; nothing below 6 m/s). Helper *hint* warns at 5° by the
  lee ("By the lee — jibe risk!").
- Headsails flip whenever `side == tack` (the crew releases the old sheet) except the self-tacking cat jib, which flips
  without crew work.

### 2.9 Engine, motorsailing, astern

- Ahead (throttle ≥ 0 and V ≥ 0): engine force `Fe = Rcalm(Ve)·bollard(u)/bollard(ue)`, `Ve = targetFrac(throttle)·
  auxKn·speedPenalty` (m/s), `Rcalm(V)` = §2.5 resistance at φ = 0 with no side force, `u = V/Ve`, `bollard` as in
  `physics.js`. With every sail down and no wind this reproduces the legacy steady state exactly (auxKn at full ahead);
  with sails up it adds to the sail drive (**motorsailing**: the HUD target speed is the polar, the engine makes up
  the rest; motorsailing upwind lets her point higher because the boat speed raises the apparent wind angle less).
- Astern (throttle < 0 or V < −0.1 kn): the legacy longitudinal model (`targetFrac·auxF`) unchanged; sails give no
  drive (they luff), heel and windage still apply. `test/telegraph.test.mjs` stays green.
- Fuel: `fuelBurnPerSimHour` unchanged (sail classes burn nothing below 5 % throttle).

### 2.10 Integration

**Full path** (`sailphys.js` `stepSail`, called from `stepShip` for `C.sail` after the actuators, before the yaw):

1. `ensureRig(s, env.sailsUp)`; if `env.sailsUp === false` every sail is treated as down (legacy master switch).
2. Wind over the water (§2.2) → `tws10`, `twa`, `tack`.
3. Crew work (§3.2): advance jobs, move `sheet → sheetCmd`, `trav → travCmd` at winch rates, `hoist → hoistCmd`.
4. Auto-trim (helper *full*, or warp > 20×): set commands (§3.3). Helper *hint/full* also runs the jibe guard.
5. One aero evaluation at (V, λ, φ) → `Fx, Fn, HM, Mz`, band states.
6. Heel (§2.6), leeway (`λ += (λt − λ)·min(1, dt/1.0)`), helm load (§2.5/2.7), flags, side flips (§2.8).
7. Surge, **semi-implicit**: `V ← V + dt·(Fx + Fe − R(V))/(m + dt·max(0, R′(V)))`, `m = 1.08·disp`, `R′` by a 0.05 m/s
   difference. Unconditionally stable for a resistance that grows with speed. `s.spd = V/0.514444`, clamped to
   `[−0.6·auxKn, vmaxKn·1.1]`.
8. Write `rig.heel/leeway/helm/awa/aws/twa/tws`, per-sail `angle/state/tt`.

Then `stepShip` integrates yaw (§2.7) and position: velocity through the water along `hdg + rig.leeway` plus current
and tide; **the `0.02·wind` drift is not added for sail classes** (leeway replaces it).

**Fast path** (polar table, no aero): used when `dt > 0.25 s`, when `env.fast === true` (server offline voyages and
captains always), or when the client warp is above 20×. The crew applies the table's plan level instantly, sheets come
from `autoTrimView`, `Vt = polarSpeed(cls, twsKn, twa).kn·speedPenalty` (motorsailing: `Vt = (Vs³ + Ve³)^(1/3)`),
`V += (Vt − V)(1 − e^(−dt/τV))` with `τV` = 10 s sloop, 15 s ketch, 10 s catamaran, 30 s schooner; heel and leeway
from the table (heel capped at `phiT`), helm 0. Passing through the no-go zone the table speed is ~0, so a tack costs
speed in the fast path too.

**Where each path runs**: client prediction ≤ 20× → full path (substeps ≤ `SUBSTEP_S` 0.05 s); client > 20× → fast
path; server `simulateOffline` (offline skippers' voyages) and captains (`captain.js` via `simulateOffline`, 0.5 s
near / 1 s far substeps) → fast path. Online skippers are simulated by their own client (the server only checks the
movement budget), as today.

**Stability and guards**: `dt` is already clamped to ≤ 1 s by `stepShip`; dynamic pressures floor V at 0.5 m/s in
the keel and rudder terms; every smoothing uses `min(1, dt/τ)` or `1 − e^(−dt/τ)`; any non-finite intermediate →
keep the previous `V` (or 0), φ = 0, λ = 0, H = 0 and continue (count `rig.nan`, test asserts it stays 0). The reference
full path was run at dt 0.1, 0.5 and 1.0 s with identical steady states (sloop 12 kn/45°: 6.46 kn, ~20° heel).

**Cost** (Node, reference code): full step 30 µs sloop, ~90 µs schooner; fast step < 3 µs. At 20× with 60 fps the
client runs ~7 substeps/frame → < 1 ms (schooner), < 3 ms on a phone.

### 2.11 Polar tables, VMG, no-go

- `scripts/gen-polars.mjs` runs the steady-state solver (Appendix A `polarPoint`: heel by bisection, leeway by fixed
  point, speed = largest root of drive − resistance, plan levels allowed at that wind × trim factor k ∈ {0.8, 0.95,
  1.1}, best speed wins) on the grid **TWS 0, 2, … 40 kn × TWA 0, 5, … 180°** for the four classes and writes
  `shared/sail/polars.gen.js`: `export const POLARS = { sloop: { tws: [...], twa: [...], kn: Int16Array-as-array (kn·100),
  heel (°·10, capped at phiT), lee (°·10), lv } … }` (~40 kB). It must import the same `aero/hydro` modules as the game.
  Runtime ≈ 4 × 21 × 37 points × 0.3 s ≈ 15 min (dev script, not at startup).
- `polarSpeed` = bilinear interpolation; `bestVmg` scans TWA 0…90 / 90…180 at 1° on the interpolated table.
- **No-go**: the physics gives no drive below about 25° (sloop), 27° (ketch), 32° (schooner), 35° (catamaran) true
  in 12 kn; the useful close-hauled angle is the best-VMG angle 40–55° (table below). The HUD shades
  `noGoDeg = bestVmg.up.twa − 5` as the no-go zone.

### 2.12 Realism targets (the numbers the tests check)

Polar speeds (kn) at the requested points, from Appendix B (auto-trim, best plan level; heel in brackets where it
matters):

| class | TWS | 45° | 60° | 90° | 120° | 150° |
|---|---|---|---|---|---|---|
| sloop 11 m | 6 | 4.4 | 5.5 | 6.0 | 5.2 | 2.9 |
| | 12 | 6.5 (19°) | 7.1 | 7.8 | 7.4 | 5.5 |
| | 20 | 6.7 (L1) | 7.6 (L1) | 9.0 | 9.4 | 7.5 |
| ketch 16 m | 6 | 4.5 | 5.7 | 6.1 | 5.3 | 3.0 |
| | 12 | 7.0 (13°) | 7.9 | 8.2 | 7.9 | 5.7 |
| | 20 | 7.8 | 8.5 | 9.7 | 9.5 | 7.9 |
| catamaran 14 m | 6 | 0.0 (no-go in 6 kn) | 4.5 | 5.7 | 5.1 | 2.9 |
| | 12 | 5.1 | 7.2 | 8.8 | 8.0 | 5.4 |
| | 20 | 6.8 | 9.4 | 11.8 | 10.4 | 7.7 |
| schooner 35 m | 6 | 4.0 | 5.5 | 6.3 | 5.3 | 3.0 |
| | 12 | 7.0 (9°) | 8.6 | 9.6 | 8.9 | 6.0 |
| | 20 | 8.4 (L2, 14°) | 10.0 (L2) | 11.4 (L1) | 11.3 | 9.1 |

Plausibility against real boats (white sails, no spinnaker): an 11 m cruiser's ORC polar at 12 kn is ≈ 6.2–6.6 kn at
45°, 7.0–7.4 kn reaching, 5.5–6 kn at 150°; a 35 m gaff schooner reaches 9–10 kn in 12 kn and 12–13 kn in a blow. The
downwind numbers are low-ish because no spinnaker is modelled (open question §6.7).

**Time-domain check** (§6.4 A-5): every point above, sailed from 70 % of the polar speed at 10 Hz with helper *full*,
averages within **±10 %** of the polar over the last 120 s (reference run: worst −2.7 %, catamaran 20/45; schooner
12/150 +3.5 %).

**Best VMG upwind** (true wind angle, VMG kn) — the "no-go ~35–45°" check:

| class | 6 kn | 12 kn | 20 kn | 25 kn |
|---|---|---|---|---|
| sloop | 50° (3.1) | 40° (4.6) | 40° (4.8) | 45° (4.7) |
| ketch | 45° (3.2) | 40° (5.0) | 40° (5.6) | 40° (5.6) |
| catamaran | 55° (2.3) | 50° (3.8) | 50° (5.1) | 55° (5.2) |
| schooner | 50° (3.1) | 50° (5.0) | 45° (5.9) | 45° (6.0) |

**Overpowered** (25 kn true, 60°, time domain from 70 % of polar, 1,200 s): full working sail with the sheets trimmed
for maximum power vs the polar's reefed level with auto-trim:

| class | full sail, max-power trim | full sail, helper *full* (depowers by trim) | reefed (polar level) |
|---|---|---|---|
| sloop | **1.5 kn, heel 33°, rounds up (TWA falls to 26°)** | 7.7 kn, 22° | **7.6 kn, 22°** (L2) |
| ketch | **6.4 kn, 34°, rounds up (39°)** | 8.7 kn, 20° | **8.7 kn, 20°** (L1) |
| schooner | **6.0 kn, 23°, rounds up (34°)** | 10.2 kn, 18° | **10.4 kn, 18°** (L2) |
| catamaran | 11.7 kn, 3.1° (stiff; HM 0.56 of RMmax) | — | 9.9 kn (L2): cats reef by wind for safety, §2.6 |

At 20 kn/60° the sloop with full sail and max-power trim makes 5.2 kn at 34° heel against 7.6 kn reefed (L1).

---

## 3. Controls, state, protocol

### 3.1 State lives in `ship.rig`

`ship.rig` (§1.4) travels with the ship object everywhere it already goes: saved in `vessel.ship` in the state file,
sent in `you.ship` (`privateState` spreads `p.ship`), copied by the client into `this.ship`, used by captains and offline
voyages. `ensureRig` repairs it lazily, so a class change (buying, switching, a fresh `newShipState`) never leaves a
stale rig: `rig.cls !== ship.cls` → new default rig.

### 3.2 Crew work and winches (deterministic, sim seconds)

| job | time | crew |
|---|---|---|
| hoist a sail | `6 + 0.22·A` s (sloop main 13 s, schooner main 54 s); lower: half | occupies one crew slot |
| reef one step / shake out | `15 + 0.25·A` s (sloop main 23 s, schooner main 70 s); the sail's drive × 0.4 meanwhile (state 4) | one slot |
| roll a furling sail in / out | rate `1/(4 + 0.12·A)` per s (genoa 35 m² ≈ 8 s end to end) | none (a winch) |
| sheet / traveller | sheet rate `clamp(0.35/√(A/30), 0.04, 0.6)` per s (sloop main 0.34, schooner main 0.13); traveller 0.5 per s | none |

Crew slots: `RIGS[cls].crew` (1; schooner 2); jobs queue in command order. Under warp > 20× and in the fast path jobs
complete instantly ("the crew had time").

### 3.3 Crew helper levels (`rig.auto`)

- **off** — nothing automatic except the physics. Crash jibes possible.
- **hint** (default for every rig) — the player trims; `trimInfo` computes the optimum (sheet/trav at α = 0.95·αs at the
  middle band, the "green tick"), a good range (α between 6° and αs) and one advice line; the jibe guard centres the
  booms on a jibe; no damage from an uncontrolled jibe.
- **full** — every step: sheets and travellers at the optimum with the depower controller
  `d ← clamp(d + dt·0.08·(φ − phiT)/5, 0, 0.9)` and target `α = 0.95·αs·(1 − d)` (the traveller drops first: the car
  takes the chord angle up to `travMax`, the sheet the rest); plan level = the polar table's `lv` for the current
  TWS/TWA, changed only after it has differed for 30 s and ≥ 90 s after the last change, plus an emergency step up when
  heel > phiT + 10° for 10 s; catamaran hull-flying rule (§2.6); light sails (code 0, topsails, flying jib) only when
  the level sets them. **The autopilot, captains, offline voyages and warp > 20× always run with *full*** (the saved
  level is not changed).

`trimInfo` advice keys and texts (basic English; Lane B shows them; first matching wins): `irons` "In irons — the
crew backs the jib.", `bylee` "By the lee — jibe risk!", `nogo` "Too close to the wind — bear away.", `roundup` "Too
much sail — she rounds up. Reef or ease the main.", `flying` "Windward hull lifting — ease the sheets!", `heel`
"Heeling too much — ease the traveller or reef.", `luff:<id>` "Pull in the <name> — it is shaking.", `stall:<id>` "Ease
the <name> — it is stalled.", `reef_out` "Light wind — shake out the reef.", `good` "Good trim."

### 3.4 Commands and validation

Client → server: `{ t: 'action', action: 'rig', cmd }` with any of

```js
{ auto: 'off' | 'hint' | 'full',
  all: 'set' | 'furl',                 // all working sails up (plan L0 without light sails) / all down — the old Sails button
  plan: 0 | 1 | 2 | 3,                 // apply a crew preset (reef levels)
  maneuver: 'tack' | 'jibe',           // the Z button: recorded for the helper (jibe guard) — steering is client-side
  sails: { [id]: { hoist?: number, reef?: int, sheet?: number, trav?: number } } }
```

`applyRigCommand(cls, rig, cmd)` (shared, used by the server and optimistically by the client): unknown class or sail
id → `{ok:false, why:'No such sail.'}`; numbers must be finite → clamp `sheet`/`hoist` to 0…1, `trav` to −1…1, `reef`
integer 0…reefs.length (sails without reefs: only 0); `hoist` of a non-furling sail is rounded to 0/1; light sails can
be hoisted by hand at any wind; `auto` from the enum. Commands set `*Cmd` fields only (the crew and winches move the
actual values). The legacy `action: 'sails', up` maps to `all: up ? 'set' : 'furl'` and keeps `p.sailsUp` (§3.6).

Server rules (`server/game.js` `onAction`): only for sail classes; rate limit 20 `rig` messages per second per person
(extra dropped silently); allowed while docked (sails are ignored alongside) but **under tug assist** the server sets
`all: 'furl'` once when the assist begins (event "The crew furls the sails for the tow."). No `sendYou` per command
(the client is optimistic); a refused command gets `event warn` with `why`.

Client → server, inside the existing `state` message at most every 500 ms: `rv: int[]` (§3.7). Server validates
length (`1 + 5·n`), integers, ranges (heel ±800, hoist 0…100, reef 0…3, angle ±100, state 0…5, tt 0…63) and stores
`p.rv` (not saved).

Crash jibe report: client → `{ action: 'rig_event', kind: 'crash_jibe', aws }` → server applies the damage of §2.8 only
when the stored `rig.auto === 'off'`, at most once per 10 s, `aws` clamped to 0…40.

### 3.5 Autopilot, captains, offline voyages: tactics

`sailCourse(cls, q, mem)` with `q = { hdg, brg, distM, twd, twsKn, stwKn, helm, auth, tack, nowS, xtM }` (bearing to the
waypoint, true wind from-direction over the water, cross-track from the leg in m, + = right of the leg) and a small
memory object `mem` (`{ tack, since, man }`, kept by the caller: `autopilot.js` instance; `voyage.sail` on the vessel
for offline/captains — saved, tiny):

- `up = bestVmg(cls, tws).up.twa`, `dn = bestVmg(cls, tws).down.twa`; `off = angleDiff(twd, brg)`.
- **Beating** when `|off| < up`: steer `hdg = normDeg(twd − mem.tack·up)` (starboard tack: wind over the starboard
  bow, TWA = +up). Tack when
  (a) the other tack's heading points within 5° of the bearing or past it (layline), or (b) `|xt| > max(500, 0.3·distM,
  3·L)` on the side the current tack carries her towards, and the leg has lasted ≥ 60 s (sim). Hysteresis 3°.
- **Running** when `|off| > dn`: the same with `dn` (gybing downwind), `maneuver: 'jibe'`.
- **Otherwise** steer `brg`.
- **Build speed**: if STW < 40 % of the polar speed for the wanted heading and `|twa| < 60°`, steer `twa = 60°` on the
  current tack until it recovers.
- Returns `{ hdg, maneuver, helmFF: tack·helm/max(auth, 0.2) }`.

Callers: client `autopilot.js` `step()` (Lane B) and `main.js` `autopilotStep` fallback; server `simulateOffline`
(Lane A) — used whenever the class is a sail class and any sail is set; the rudder is
`clamp(angleDiff(hdg, want)/25 + helmFF, −1, 1)`. Arrival, reach radii and storms are unchanged.

**Harbour approach** (speed bands of `PILOT.BANDS`): at the 2,500 m band the crew furls everything and the engine takes
over at the band throttle (client autopilot with helper ≠ off, offline voyages, captains). Captains already switch to
`pilotStep` inside a patch; they furl when entering it. Departure (`castOff`) hoists the plan level for the current wind
once she is clear of the patch. The existing warning "Furl the sails for the harbour approach…" stays for helper *off*.

**Warp**: the server's warp refusal "out of fuel" (`warpBlock`) keeps its rule `!(C.sail && p.sailsUp !== false)` and
additionally requires `anyHoisted(ship.rig)`. ETA estimates (`serviceKn`) are unchanged (§6.7).

### 3.6 Save format and migration

- `ship.rig` is the save format (schema `v: 1`). Existing saves have no rig. `server/fleet.js` `healVessel` (every
  saved vessel) and `makeVessel` call `ensureRig(v.ship, v.sailsUp)`: a vessel **at sea** with `sailsUp !== false` gets
  plan L0 hoisted (her sails were set), a **docked / laid-up** one gets everything down; `auto: 'hint'`.
- `sailsUp` stays in `VESSEL_KEYS` as the legacy master switch: after every rig command the server sets
  `v.sailsUp = anyHoisted(rig)`; `env.sailsUp === false` still means "no sail drive" in `stepShip` (tests rely on it).
- Rigs of non-sail classes are deleted by `ensureRig`. A rig from a newer schema (`v > 1`) is replaced by a default
  (never throws; logged once).

### 3.7 Multiplayer sync

- **`rv`** (rig view, ints): `[heel·10, …per sail in RIGS order: hoist% (0…100), reef (0…3), angle (° signed, + = clew to
  starboard), state (0…5), tt (0…63)]` — sloop 11 ints, schooner 36.
- Online skippers: their client sends `rv` in `state` (≤ 2 Hz); the server puts `p.rv` into `publicState` (snap
  `players[]`). Ships the server moves (offline voyages, captains): the server builds `rv` with
  `packRigView(cls, ship.rig)` once a second (the fast path writes the rig's angles from `autoTrimView`) and puts it into `publicState` / `fleet.viewFor` entries.
- Receivers (`main.js` others, `fleetShips`) call `mesh.userData.setRig(unpackRigView(cls, rv))`; without `rv` (old
  server, AIS) they use `autoTrimView(cls, awa, aws)` from the local wind. Heel from `rv` feeds `motion.js` for others.
- The own ship renders `rigViewOf(cls, this.ship.rig)` every frame (no network).

### 3.8 Server edits (Lane A, exact places)

- `server/game.js` `onAction`: add `case 'rig'` and `case 'rig_event'`; `case 'sails'` maps to the rig (§3.4).
- `onState`: per-second budget uses `max(C.maxKn, maxSpeedKn(cls))·1.35` for sail classes; the speed clamp
  `C.maxKn·1.1` → `max(C.maxKn, maxSpeedKn(cls))·1.1`; accept `m.rv` (validated, ≤ 2 Hz).
- `publicState`: `rv` for sail classes (online: `p.rv`; offline/actors: built from the ship).
- `simulateOffline`: env gets `fast: true, simTime: this.simTime, gusts: false`; steering via `sailCourse` for sail
  classes with sails set; harbour-band furl (§3.5).
- `tugAssist` begin: `applyRigCommand(cls, rig, { all: 'furl' })` + event.
- `warpBlock`: §3.5.
- `server/fleet.js`: `makeVessel` / `healVessel` → `ensureRig`; `viewFor` entries get `rv` for sail classes.
- `server/captain.js` `sail()` / `castOff()` / `pilotStep()`: hoist plan at departure, furl in the patch (through
  `applyPlan`/`applyRigCommand`), nothing else (steering already goes through `simulateOffline`).

---

## 4. Visuals (Lane B)

### 4.1 What changes

- `ship.js`: the four sail builders call `buildYacht(ctx, cls)` (new, in `rigmesh.js` + `yachtlooks.js`) instead of
  `yachtHull` + `sailboatDeck` + `rig()`. The old `rig()` and `sailboatDeck()` are deleted. The group keeps its userData
  API; new: **`setRig(view)`**; **`setSails(up, windRelDeg)` stays** for `ais.js`/`thumbs.js` and maps to
  `setRig(autoTrimView(cls, signedRel, 8))` with `signedRel = ((rel + 540) % 360) − 180` (+ = from starboard) — this alone
  fixes the "sails into the wind" bug for every caller; `main.js` `windRel()` is changed to return the signed value too.
- `isSail`, `lightState.underSail` unchanged (any hoisted sail = under sail: no masthead light).

### 4.2 Hull looks per class (`yachtlooks.js`, pure data + outline functions shared with `shipplan.js`)

| | sloop | ketch | catamaran | schooner |
|---|---|---|---|---|
| deck height (freeboard) | 1.25 mid, bow 1.45, stern 1.15 | 1.45, bow 1.75, stern 1.35 | hull decks 1.35, bridge deck 1.9, underside 0.9 | 1.7, bow 2.3, stern 1.9; bulwark 0.6 + varnished caprail |
| bow / stern | near-plumb stem (5° rake), open reverse transom with swim platform, transom 0.75·B | spoon bow 1.6 m overhang, short counter, bowsprit with pulpit | vertical bows, stepped reverse transoms | clipper bow 3.5 m overhang with trailboards, long counter stern 5 m |
| max beam (z) | 3.6 at z +0.6 | 4.6 at +0.5 | 7.5 overall, hulls 1.5 | 7.5 at +1.0 |
| colours | hull `C.hullColor` navy, white boot-top, light-grey non-slip deck, white coachroof, teak cockpit, silver spars, white Dacron sails with navy UV strip on the genoa, "SL 11" on the main | maroon hull, gold cove line, teak deck, varnished trim, cream-painted spars, cream Dacron, burgundy canvas | white hulls with a grey band and black window strips, black trampoline, dark-grey (carbon look) mast and boom, white sails, blue lazy bag | `C.hullColor` dark varnish brown with a gold cove line and white boot-top, teak deck, varnished spruce spars with white mastheads and black ironwork, tan canvas sails with cross-cut seams and boltropes |
| deck structures (z extents; x half-width; top y) | coachroof −3.0…+1.6, ±1.0 (±0.8 forward), 1.80, mast stands on it; sprayhood; cockpit +1.6…+4.6 | coachroof −2.0…+0.6 ±1.3 top 2.15 + doghouse +0.6…+1.8 top 2.45; cockpit +1.8…+3.8; mizzen between cockpit and helm; helm station +4.4…+6.8 | saloon −2.1…+2.66, ±2.55, roof 3.9; hardtop over the cockpit +2.66…+5.0 at 4.0; trampoline −6.2…−2.1 | forward deckhouse/skylight −4.6…−0.8, ±1.6, top 2.6; doghouse +4.4…+9.6, ±1.9, top 3.05 (walk-in, companion stairs); sunken helm cockpit +10.8…+14.4; windlass −15.6; pin rails at the shrouds |

**Clearance rules** (Lane B test `sail-client-geometry`): every mast foot is ≥ 0.4 m clear of every deckhouse/doghouse
footprint unless the rig puts it *on* that roof (sloop coachroof, flagged `onRoof`); every boom at every swing angle
clears every deck structure top by ≥ 1.0 m and the deck by ≥ 1.9 m along walkable deck (people walk under booms) — the
schooner's fore boom at 3.9 m over a 1.82 m deck is the tightest (2.1 m); no sail foot or clew below its boom's
gooseneck height.

### 4.3 Rig builder (`rigcore.js` pure + `rigmesh.js` three.js)

- `rigcore.js` (no three.js): from `RIGS[cls]` + a `RigView` it computes, per sail, a vertex grid in the ship frame:
  `u` 0…1 luff → leech, `v` 0…1 foot → head; triangles: own ship 10 × 14, others ≤ 300 m 6 × 8, far 1 × 1; gaff quads
  12 × 14. Luff follows the mast aft face (mainsails, gaff sails on hoops) or the stay (headsails, straight with 0.3 %
  sag); head on the gaff for gaff sails; foot on the boom (or loose from tack to clew for headsails/loose-footed).
  Chord angle at height v: `δ(v) = angle + side·τ·v`, rotation about the luff. **Camber** depth `c = c0·fill` with
  `c0` 0.11 main, 0.13 headsails, 0.12 gaff, 0.16 code 0; draft position 40 % (main) / 35 % (headsails); profile
  `c·4u(1 − u)·(1 + 0.3(1 − 2u))`, always on the **leeward** side (`−side`… i.e. bulging away from the wind). `fill` = 1
  drawing/stalled, 0.4 luffing, flogging uses the flutter below.
- **Luff and flog** (deterministic, time-based): luffing → the front 35 % inverts with amplitude `0.05·chord·(1 − α/6)`
  and a 3–6 Hz ripple travelling aft; flogging → the whole sail ripples at 2–4 Hz, amplitude `0.08·chord`, the clew
  jerks ±0.2 m. Frequencies scale with `aws`.
- Reefed main: the area below the reef line is a bundled roll on the boom (radius ∝ reefed area), reef points drawn as
  small dots on each reef line (instanced quads). Rolled headsail: a cylinder on the stay with radius ∝ rolled area;
  lowered gaff sails: gaff down on the boom, lazy jacks. Hoisting animates `hoist`.
- Canvas texture per class (generated once on a canvas, shared): panel seams (cross-cut, horizontal for classic,
  radial for modern), batten pockets (mains), luff/leech tapes, sail number, UV strip. `MeshStandardMaterial`
  double-sided, roughness 0.85.
- **Lines**: standing rigging (shrouds, stays, backstays, triatic, bobstay) as one merged `LineSegments` per ship
  beyond 40 m from the camera; within 40 m thin merged cylinders (Ø 8–14 mm sloop … 22 mm schooner). Running rigging:
  per sail one dynamic polyline sheet clew → lead → winch (3–5 points, catenary sag when eased), mainsheet boom →
  traveller car (the car slides with `trav`), halyards along the mast. Blocks as small boxes, winches as short
  cylinders with a drum, the wheel with spokes (schooner) or a stainless rim (others), pedestal/binnacle.
- **Telltales**: headsails three pairs on the luff at 25/50/75 % (both sides), main three on the leech (at the batten
  ends); 0.25 m ribbons whose direction follows the band's `tt` (streaming aft along the chord; lifting/twirling up for
  windward luff; drooping and curling for leeward stall). Shown within 60 m of the camera only.

### 4.4 Animation

- Sail and boom angle follow the view's `angle` with a critically damped spring (ω = 3 rad/s ≤ 16 m LOA, 1.5 rad/s
  schooner), so a tack looks like a tack. A crash jibe (flag bit 4) bypasses the spring: the boom crosses at 180°/s,
  then a 0.5 s overshoot wobble; sound event `jibe_bang`.
- Heel: the physics heel goes to `motion.js` as the steady heel for sail classes (`ctx.heelDeg`), replacing the
  `windHeel·(U/12)²` formula; waves still add roll on top. Other ships: heel from `rv`, else from `autoTrimView`.
- Sheets go slack/taut with `sheet`; halyard slap optional.

### 4.5 Deck walker and interior (`shipplan.js`, `interior.js`)

- `shipplan.js` `SAIL` table is replaced by data from `yachtlooks.js` (deck structures, cockpit, wheel) and
  `RIGS[cls].spars.masts` (mast z, radius): every mast gets a `solid` of radius + 0.15 and the `mast` prop at the real
  height. The schooner's walk-in doghouse moves to z +4.4…+9.6 (fractions 0.126…0.274), cockpit/helm to +10.8…+14.4,
  wheel 0.36·L; the forward deckhouse −4.6…−0.8 is a solid with a skylight. The catamaran mast prop stays at
  saloon front − 0.6 m (= z −2.7, now equal to the rig).
- Lower freeboard (§4.2) means cabin soles below the waterline for sloop/ketch/schooner: cabin `y = yD − 2.05`
  (headroom 1.9 m + sole), and `interior.js` hides the ocean while the camera is inside any non-open room whose floor
  is below y 0.1 (portholes show fog-coloured glass there). `test/interior*.test.mjs` walk-throughs must stay green; only
  expectations that encode the old room heights/positions for these classes may be updated.
- `interior.js` `hideExterior`: keep the rig group (flag `userData.keepWhileWalking`) instead of the
  `ShapeGeometry` test (the new sails are `BufferGeometry`).

### 4.6 LOD and budget

| | own ship | others ≤ 300 m | 300 m – 2 km | > 2 km |
|---|---|---|---|---|
| sails | full grid, every frame | 6 × 8, 15 Hz update | 2 triangles per sail, angle only | merged into the hull sprite/label distance rules |
| rigging | cylinders within 40 m, lines beyond; sheets dynamic | lines (merged), sheets static | mast + forestay lines | none |
| telltales | ≤ 60 m | ≤ 60 m | no | no |
| budget | ≤ 14 k triangles, ≤ 40 draw calls (schooner), ≤ 0.6 ms/frame CPU on a mid phone | ≤ 3 k tris, ≤ 12 calls | ≤ 200 tris, ≤ 4 calls | — |

Phones (`isTouch()`): own grid 8 × 10, no rigging cylinders, telltales on the own ship only.

### 4.7 Other users

`ais.js` (`setSails` with a signed angle, or `setRig(autoTrimView(...))`), `thumbs.js` (`setSails(true, 62)` keeps
working: close reach, starboard tack), `sound.js` (§5.6).

---

## 5. HUD and controls (Lane B)

### 5.1 Wind instrument

A round dial (desktop 128 px, phone 76 px) under the compass: boat outline pointing up; **AWA** solid needle and **TWA**
hollow needle; shaded **no-go wedge** ±`noGoDeg` around the true wind; red/green close-hauled sectors (AWA 20–60° port /
starboard); readouts AWS / TWS (kn), AWA / TWA (°), TWD (° true). Hidden for engine classes.

### 5.2 Performance strip (next to the speed readout)

STW, SOG, **Target** `polarSpeed(cls, tws, |twa|).kn` and `% of target` (green ≥ 95 %, amber 80–95, red < 80), **VMG** to
the wind (`STW·cos twa`) or **VMC** to the active waypoint when a route is set (`SOG·cos(COG − brg)`), leeway (°).

### 5.3 Heel and helm

Arc gauge ±45° with the needle at `rig.heel`, green ≤ phiT, amber ≤ phiT + 8, red beyond; below it the **helm bar**
(|H| 0…1.5, red > 1 with "rounding up!"). Catamaran: the arc is replaced by a *hull load* bar (HM/RMmax, warning at 0.7).

### 5.4 Sail panel

Desktop: glass card, bottom right, 340 px wide, toggled by **Q** or the *Sails* button. Header: helper segmented
control **Off · Hints · Auto**, *Trim all*, *Tack*/*Jibe* (label by |twa| < 90° / ≥ 90°). One row per sail (front to
back, `sailIds(cls)`): name, status dot (green drawing, amber luffing, red stalled/flogging, blue crew working, grey
down), hoist control (furlers: 0–100 % slider; others: *Hoist*/*Lower* button with a progress bar while `work > 0`),
reef stepper (when the sail has reefs), **sheet slider** (left "in", right "out") with the green optimum tick
(`sheetOpt`) and the good band (`sheetLo…sheetHi`), three telltale icons (bottom/middle/top), and for boomed sails a
small **traveller slider** with its tick. Footer: heel and helm mini bars, the advice line. In *Auto* the sliders show
the crew's settings and are disabled (touching one switches to *Hints* after a confirm toast "Take over the trim?").

### 5.5 Phone layout

Wind dial + heel gauge stacked top-right (76 px). Touch helm gets two round buttons for sail classes: **Sails** (opens a
bottom sheet ≤ 55 % of the height) and **Tack**/**Jibe** (contextual). The sheet: helper segmented control and *Trim
all* on top, a row of sail chips (tap to select; the chip colour is the status), then big controls for the selected
sail: sheet slider full width with the tick (light haptic tick via `navigator.vibrate(5)` when crossing the optimum,
if available), traveller slider, *Hoist/Lower* (or roll slider), *Reef −/+*. Thumb targets ≥ 44 px. The advice line
sits above the chips.

### 5.6 Sound hooks (`sound.js`)

Luffing/flogging noise (sum over sails of area × flog/luff amount, pitched by aws), winch clicks while a sheet is moving,
rig creak ∝ heel, `jibe_bang` on crash jibes. All through the existing `soundState`; `windRelDeg` becomes the signed AWA.

### 5.7 Client wiring (`main.js`, `net.js`, `autopilot.js`)

- `simulate()` env adds `simTime: this.simTime`, `gusts: true`; the rig lives in `this.ship.rig` (from `you` on hard
  sync only; local commands win otherwise).
- Commands: UI → `applyRigCommand` locally (optimistic) → `net.action('rig', { cmd })`, throttled to 4 Hz with a trailing
  send for sliders.
- `net.sendState(s)` adds `rv: packRigView(cls, s.rig)` every 500 ms.
- Others: `onSnap` stores `rv`; `shipVisual` calls `setRig(unpackRigView(...))` at ≤ 15 Hz.
- `autopilot.js` `step()`: for sail classes with sails set, the bearing goes through `sailCourse` (§3.5) and the rudder
  gets `helmFF`; harbour furl at the 2,500 m band (§3.5). The Z button runs a one-off manoeuvre through the same
  function (`mem.man`), steering until |hdg − target| < 5°.
- `main.js` `windRel()` returns signed −180…180 (fixes `setSails` callers and `soundState.windRelDeg`).

---

## 6. Lanes, tests, acceptance

### 6.1 Lane A — tasks

| # | task | files |
|---|---|---|
| A1 | frozen interface: `rigs.js` (Appendix A data + §2.4 spars), `state.js` (rig state, commands, rv), stubs | `shared/sail/rigs.js`, `state.js`, stubs |
| A2 | physics: `aero.js` (coeffs, bands, forces), `hydro.js` (resistance, keel, rudder, RM), `sailphys.js` (`stepSail` full + fast path, crew, jibe, flags), `trim.js` (`trimInfo`, auto-trim controller, `autoTrimView`), hook in `physics.js` `stepShip` (`if (C.sail)`), `sailPolar` kept (returns `polarSpeed(...).kn / C.maxKn` for old callers) | `shared/sail/*.js`, `shared/physics.js` |
| A3 | polar generator + generated tables + `polar.js` | `scripts/gen-polars.mjs`, `shared/sail/polars.gen.js`, `shared/sail/polar.js` |
| A4 | tactics | `shared/sail/tactics.js` |
| A5 | server: actions, state/rv, budget, offline voyages, tug furl, warp, migration, fleet view, captains | `server/game.js`, `server/fleet.js`, `server/captain.js` |
| A6 | tests §6.4 A | `test/sail-*.test.mjs` |

### 6.2 Lane B — tasks

| # | task | files |
|---|---|---|
| B1 | `rigcore.js` geometry (sails, booms, gaffs, lines from `RIGS` + `RigView`), `rigmesh.js` meshes, cloth animation, LOD | `public/js/rigcore.js`, `public/js/rigmesh.js` |
| B2 | hull looks per class + deck structures (`yachtlooks.js`), `ship.js` builders, `setRig`, `setSails` compat | `public/js/yachtlooks.js`, `public/js/ship.js` |
| B3 | HUD: wind dial, performance strip, heel/helm, sail panel, phone sheet, keys, touch buttons | `public/js/sailhud.js`, `public/js/sailfmt.js`, `public/js/hud.js`, `public/js/touch.js`, `public/js/main.js`, `public/index.html`, `public/css/*` |
| B4 | prediction & sync: env, commands, rv send/receive, others' `setRig`, autopilot tactics + harbour furl, motion heel, ais/thumbs, sound | `public/js/main.js`, `public/js/net.js`, `public/js/autopilot.js`, `public/js/motion.js`, `public/js/ais.js`, `public/js/thumbs.js`, `public/js/sound.js` |
| B5 | deck plans + interior (masts from `RIGS`, schooner layout, lower freeboard, ocean hiding, `keepWhileWalking`) | `public/js/shipplan.js`, `public/js/interior.js` |
| B6 | tests §6.4 B + browser scenarios §6.5 | `test/sail-client-*.test.mjs` |

### 6.3 Reviewer

Runs `npm test` after each lane's milestone and at the end; diff-reads the physics port against Appendix A (same
constants and order of operations; numbers in §2.12 reproduced by `test/sail-polar.test.mjs`); runs the browser
scenarios on desktop and a phone viewport; checks §6.6; checks no file of §1.1 "do not touch" changed; updates
`docs/STATUS.md` with one line.

### 6.4 Tests with expected numbers

Tolerances: polar table vs Appendix B ±0.15 kn; time domain vs polar ±10 %; heel ±3°; angles ±5°.

**Lane A**

1. `sail-state.test.mjs` — `defaultRig` for each class has the §2.4 sail ids in order; `normalizeRig` repairs NaN,
   out-of-range and unknown sails; `applyRigCommand` clamps (sheet 1.7 → 1, reef 5 → max, hoist 0.4 on a non-furler →
   0), rejects unknown ids; `packRigView`/`unpackRigView` round-trip for all four classes (sloop length 11, schooner 36);
   `ensureRig` on an old vessel at sea with `sailsUp` true → L0 hoisted, docked → all down; class change → new rig.
2. `sail-aero.test.mjs` — `coeffs`: α ≤ 0 → cl 0 (flogging), α = αs → clmax, α = 90° → cd ≈ 1.3 + cd0, cl ≈ 0; a sloop
   genoa sheeted to dmin at AWA 15° is luffing, at AWA 40° with sheet 0 stalled; apparent wind: TWS 10 m/s, TWA 90°,
   V 3 m/s → AWA 73.3° ± 0.2, AWS 10.44 ± 0.05 (no leeway, at 10 m); the wind over the water with a 1 m/s current from
   ahead adds 1 m/s to TWS at TWA 0; Kerwin: AWA 30°, φ 30° → β 26.6°.
3. `sail-hydro.test.mjs` — calm-water resistance upright with no side force: sloop 6 kn 0.62 kN ± 10 % (5 kn 0.38 kN),
   ketch 6 kn 1.03 kN ± 10 %, schooner 10 kn 16.3 kN ± 10 %; Fn 0.40 at 7.57 kn for the sloop; `RM(sloop, 20°)` =
   6000·9.81·0.502 = 29.5 kN·m ± 2 %;
   catamaran `RM` max at 5° = 12000·9.81·2.99 ± 1 %; keel stall: leeway ≤ 30° for any side force.
4. `sail-polar.test.mjs` — `polars.gen.js` matches Appendix B (±0.15 kn) at every TWS 6/12/20/25 × TWA 45/60/90/120/150
   point; regenerating 6 sample points with the solver gives the stored value ±0.05 kn; best VMG angles per §2.12 (±5°);
   `noGoDeg` sloop 12 kn = 35 ± 5, catamaran 12 kn = 45 ± 5; speed at TWA 25° in 12 kn < 0.2 kn for all four classes.
5. `sail-dynamics.test.mjs` — **the §2.12 time-domain check**: for each class × TWS 6/12/20 × TWA 45/60/90/120/150,
   `stepShip` (full path, dt 0.1, `gusts:false`, helper *full*, autopilot-style helm with `helmFF` holding the TWA) from
   70 % of the polar speed for 900 s (schooner 1,500 s): mean STW over the last 120 s within ±10 % of the polar
   (catamaran 6/45: < 1 kn). Same at dt 0.5 and 1.0 for sloop 12/45 (equal within 1 %). Heel sloop 12/45 = 20 ± 3°,
   schooner 12/45 = 9 ± 3°, catamaran ≤ 3°. **Overpowered**: §2.12 table — full sail max-power trim at 25 kn/60° gives
   heel ≥ reefed heel + 4° and mean speed ≤ 0.85 × reefed speed for sloop, ketch, schooner, with at least one
   round-up (TWA falls ≥ 15° below the set course); sloop 20/60 full ≤ 0.85 × L1. **Start from rest** at 12 kn/60°
   reaches ≥ 90 % of polar within 120 s (sloop, ketch, catamaran) / 240 s (schooner) (reference: 60 s / 120 s).
   **Tack**: sloop 12 kn, from starboard close-hauled (45°) with Z → steady on port close-hauled within 30 s, minimum
   STW during the tack between 20 % and 90 % of the polar, back to ≥ 80 % within 60 s, every sail `side` flipped. **Jibe**: helper *off*, main sheet out (δ 75°), turning through the stern at 15 kn → flag crash jibe
   and `rig_event` damage > 0; helper *hint* → controlled, no damage. **Engine**: all sails down, no wind → full ahead
   steady STW = auxKn ± 0.05; motorsailing upwind (throttle 0.5, sails L0, 12 kn, 45°) faster than sails alone.
   **Stability**: 10,000 random-but-seeded (LCG) envs (TWS 0–45 kn, any TWA, dt 0.01–1 s, random commands) → no NaN, |V| ≤
   vmaxKn·1.1, |heel| ≤ 80, `rig.nan` 0. **Fast path**: 1 s steps reach the table speed (±3 %) after 5·τV.
6. `sail-tactics.test.mjs` — waypoint 10 nm dead upwind: `sailCourse` alternates tacks at ±bestVmg angle, cross-track
   stays within max(500 m, 0.3·dist), ≥ 60 s legs; offline voyage (`g.simulateOffline` with `fast:true`) sloop 12 kn
   reaches a waypoint 5 nm dead upwind in ≤ 1.5 × (5 nm / VMG 4.6 kn) ≈ 1.63 h of sim time; downwind 5 nm at 180°
   gybes at ~165°; a reach goes straight. Captain (`fleet-captain` style) sails a schooner to a harbour upwind and arrives.
7. `sail-server.test.mjs` — `rig` action validation and rate limit; `sails` legacy action; tug assist furls; warp
   refusal with all sails down and no fuel; move budget accepts a sloop at 11 kn and a catamaran at 15 kn (rejects 25 kn);
   `rv` accepted/validated and present in `publicState`; save → load round trip keeps `ship.rig`; old save without rig
   migrates (§3.6); crash jibe damage only with `auto: 'off'`, ≤ once per 10 s.
8. Existing suites stay green (telegraph astern ratio for sail classes with `sailsUp:false`; warp sloop rules).

**Lane B** (pure modules, node)

1. `sail-client-geometry.test.mjs` — `rigcore`: every sail's vertices lie on the leeward side for both tacks (signed
   x of the leech × side > 0 for angle ≠ 0); camber bulges to leeward; sail feet at their boom heights; masts not inside
   any deck structure (except `onRoof`); boom swing 0…dmax clears deck structures by ≥ 1.0 m and walkable deck by ≥ 1.9 m;
   reefed main area ratio matches the reef factor ± 5 %; the luff of every headsail lies on its stay (≤ 2 cm).
2. `sail-client-plan.test.mjs` — deck plans for the four classes: walkable loop around every mast (both sides),
   helm reachable, schooner doghouse at z +4.4…+9.6 with stairs inside, no mast `solid` inside a room; the existing
   interior walk-throughs pass.
3. `sail-client-hud.test.mjs` — `sailfmt`: advice priority (irons > by-the-lee > no-go > round-up > hull flying > heel >
   luff > stall > reef out > good); slider ↔ sheet mapping; `% of target` colours; keys map (Q, Shift+Q, 1–7, [ ], Ctrl+[ ],
   - =, R, Shift+R, Shift+digit, Z) without colliding with existing keys; `windRel` signed fix (wind from port → negative).

### 6.5 Browser scenarios (Lane B runs, reviewer repeats; desktop 1440×900 and phone 390×844)

1. Sloop, 12 kn, starboard tack close-hauled: sails to port, boom over the port quarter, telltales streaming, heel
   ~20° to port, target % ≥ 95 with *Auto*. Turn to port tack: sails swing across, heel flips.
2. Same, *Hints*: ease the genoa far out → amber, windward telltales lift, advice "Pull in the genoa — it is shaking.";
   pull hard in on a reach → red "stalled". Use the green ticks → green.
3. Sloop, 25 kn, full sail, *Off*, sheets in: heel > 30°, helm bar red, she rounds up repeatedly; reef twice → she
   stands up and goes faster.
4. Schooner: masts and booms clear of the deckhouses from the chase cam and while walking; walk all round both masts;
   seven sails up in 10 kn; topsails come down when *Auto* sees 20 kn.
5. Jibe in 15 kn with *Off* and the main eased: crash jibe, bang, damage event; with *Hints*: controlled.
6. Autopilot route straight upwind 3 nm: she tacks on her own and arrives; harbour band → sails furled, engine on.
7. Two browsers: player B sees player A's sails on the correct side, angle following A's trim, heel matching.
8. Phone: Sails sheet, chips, slider ticks, Tack button; everything reachable with one thumb; 60 fps target on the
   own schooner (≥ 30 fps on a mid phone).
9. Catamaran 25 kn with full sail: "Windward hull lifting" and the crew eases; *Auto* reefs.

### 6.6 Acceptance checklist

- [ ] Sails are on the leeward side in every case (own ship, others, AIS boats, thumbnails); the boom crosses on tacks
      and jibes.
- [ ] No mast, boom or sail intersects a deckhouse on any of the four classes; the walker can circle every mast.
- [ ] Each class has its own hull lines, deck layout, rig and colours (§4.2); bowsprits on ketch and schooner; gaffs
      and topsails on the schooner; code 0 on the catamaran.
- [ ] Sails fill with camber, luff, flog and stall visibly; telltales follow the trim.
- [ ] Physics: §2.12 tables reproduced by the tests; overpowered = more heel and less speed; reefing restores speed;
      best VMG upwind 40–55°.
- [ ] Controls work on desktop and phone (§0.2); *Hints* is the default; *Auto* trims and reefs.
- [ ] Autopilot, captains and offline voyages tack upwind and furl for the harbour.
- [ ] Old saves load; sail state persists; other players see your trim and heel.
- [ ] Engine ships unchanged; full test suite green; no file in §1.1 "do not touch" changed.
- [ ] Performance budget §4.6 met on a phone profile.

### 6.7 Defaults for open questions (built as written unless the product owner says otherwise)

| question | default |
|---|---|
| Spinnaker / gennaker downwind? | Not in v1 (white sails + catamaran code 0 only). Downwind speeds are white-sail numbers. |
| Capsize / dismasting? | No. Catamaran hull flying → forced sheet release + small cond loss; monohulls round up. Gear failure later. |
| Change `C.maxKn` / economy speeds? | No. `maxKn` stays the economy rating; `serviceKn` for sail classes unchanged (0.6·maxKn ≥ auxKn). Polar-based ETAs later. |
| Gusts in the game? | On (deterministic, ±≤ 25 % of the mean, from the weather's gust ratio); off in tests. |
| Helper default | *Hints* for every player and every migrated rig. |
| Crash jibe damage | Only with helper *off*; ≤ 3 condition points. |
| Square-rigger | None (no such class exists). |
| Heave-to / backed jib | Not modelled as a control; in irons the crew backs the jib automatically. |
| Racing, laylines on the chart | Later (V7 item 8 regattas). The tactics code is reusable for laylines. |
| Interior below the waterline | Yes (real yacht layout, §4.5); fallback if the interior suite cannot be kept green: keep deck heights in the deck plan only (model freeboard still lowered) — reviewer decides. |

### 6.8 Risks

- **Interior tests** after the freeboard change (B5) — do B5 last; it does not block B1–B4.
- **Polar generation time** (~15 min) — run once per constant change; the test regenerates only 6 points.
- **Client prediction drift** for others' view — the own ship is authoritative locally; others only see `rv`, so
  drift cannot move ships.
- **Server load** — online ships are not simulated by the server; offline/captain ships use the fast path (< 3 µs).
- **Weather helm feel** too strong for casual players — *Hints* shows the helm bar and the autopilot uses `helmFF`;
  the constant 0.13 (hull asymmetry) is the knob.

---

## Appendix A — reference implementation (`ref.mjs`, 2026-10-09)

Pure ESM, the source of every number in this contract (sails listed front to back = `sailIds` order; the order
does not change any result). Lane A ports it into `shared/sail/aero.js` (`TYPES`, `coeffs`,
`aero`), `hydro.js` (`RR`, `RM`, `hull`), `polar.js` + `scripts/gen-polars.mjs` (`evalV`, `solve`, `trimmed`,
`polarPoint`), `trim.js` (`trimDelta`, `twistFor`, `autoTrimSail`), `rigs.js` (`RIGS`, `planState`, `plansAt`) and
uses `sim()` as the model for `stepSail` and the time-domain test. `sim()` simplifies two things the game does fully:
the course keeper holds a fixed TWA (the game steers a heading through `sailCourse`) and TWA is clamped to 0…180 (the
game uses signed angles and handles the jibe, §2.8).

```js
// Saltline sailing — reference model (the numbers in docs/SAILING-CONTRACT.md come from this file).
// SI units inside (m, s, N, kg); angles in degrees at the interfaces. Pure, deterministic.
export const RA = 1.225, RW = 1025, G = 9.81, NU = 1.19e-6, KN = 0.514444, D2R = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lerpT = (T, x) => { if (x <= T[0][0]) return T[0][1]; for (let i = 1; i < T.length; i++) if (x <= T[i][0]) { const [x0, y0] = T[i - 1], [x1, y1] = T[i]; return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0); } const [xa, ya] = T[T.length - 2], [xb, yb] = T[T.length - 1]; return yb + ((yb - ya) * (x - xb)) / (xb - xa); };

// ---- sail section types: clmax, stall AoA (deg), parasitic cd0, base twist (deg, foot→head)
export const TYPES = {
  main:    { clmax: 1.50, as: 20, cd0: 0.030, tw0: 6 },
  gaff:    { clmax: 1.32, as: 22, cd0: 0.055, tw0: 12 },
  genoa:   { clmax: 1.65, as: 18, cd0: 0.028, tw0: 8 },
  jib:     { clmax: 1.60, as: 18, cd0: 0.030, tw0: 8 },
  stay:    { clmax: 1.50, as: 18, cd0: 0.032, tw0: 8 },
  topsail: { clmax: 1.25, as: 20, cd0: 0.055, tw0: 8 },
  mizzen:  { clmax: 1.45, as: 20, cd0: 0.032, tw0: 6 },
  code0:   { clmax: 1.75, as: 28, cd0: 0.040, tw0: 10 },
};
export const A_LUFF = 6;       // below this AoA the luff lifts (partial luffing); <= 0 flogging
export const K_IND = 0.05;     // quadratic (induced) sail drag
export const RR = { // residuary resistance / weight vs Froude number
  mod:   [[0, 0], [0.15, 0.0002], [0.20, 0.0006], [0.25, 0.0014], [0.30, 0.0030], [0.35, 0.0068], [0.40, 0.0200], [0.45, 0.0400], [0.50, 0.0650], [0.55, 0.0850], [0.60, 0.1050], [0.70, 0.1400]],
  heavy: [[0, 0], [0.15, 0.0003], [0.20, 0.0008], [0.25, 0.0018], [0.30, 0.0040], [0.35, 0.0092], [0.40, 0.0260], [0.45, 0.0480], [0.50, 0.0750], [0.55, 0.0980], [0.60, 0.1200], [0.70, 0.1600]],
  cat:   [[0, 0], [0.15, 0.0008], [0.20, 0.0022], [0.25, 0.0055], [0.30, 0.0120], [0.35, 0.0220], [0.40, 0.0340], [0.45, 0.0450], [0.50, 0.0550], [0.60, 0.0680], [0.70, 0.0780], [0.80, 0.0860], [1.00, 0.1000]],
};

// ---- rigs: ship frame (x stbd, y up from waterline, z aft; bow at -L/2). Sail pts [z, y]: tack, head, clew (+ peak for gaff: tack, throat, peak, clew)
const poly = (P) => { let a = 0, cz = 0, cy = 0; for (let i = 0; i < P.length; i++) { const [z0, y0] = P[i], [z1, y1] = P[(i + 1) % P.length]; const c = z0 * y1 - z1 * y0; a += c; cz += (z0 + z1) * c; cy += (y0 + y1) * c; } a /= 2; return { A: Math.abs(a), zc: cz / (6 * a), yc: cy / (6 * a) }; };
function mk(r) { for (const s of r.sails) { const g = poly(s.pts); s.A = g.A * (s.roach || 1); s.zc = g.zc; s.yc = g.yc; s.y0 = Math.min(...s.pts.map((p) => p[1])); s.y1 = Math.max(...s.pts.map((p) => p[1])); } return r; }
export const RIGS = {
  sloop: mk({ LWL: 9.7, T: 1.9, disp: 6.0, GM: 1.45, AVS: 120, Sw: 25, Alat: 2.9, ARk: 1.6, bK: 2.85, Ar: 0.55, br: 1.35, zr: 4.3, zclr: 0.8, xclr: 0.0, Apar: 8, rr: 'mod', fb: 1.25, phiT: 22, turn: 22, tauPhi: 1.5,
    sails: [
      { id: 'genoa', type: 'genoa', pts: [[-5.35, 1.65], [-1.45, 15.0], [0.0, 1.95]], furl: true, dmin: 12, dmax: 75, head: true },
      { id: 'main', type: 'main', pts: [[-1.3, 3.15], [-1.3, 15.9], [3.1, 3.3]], roach: 1.15, reefs: [0.78, 0.58], dmin: -3, dmax: 80, travMin: -3, travMax: 12 },
    ],
    plans: [{ maxTws: 24, set: {} }, { minTws: 14, set: { main: { reef: 1 }, genoa: { furl: 0.25 } } }, { minTws: 20, set: { main: { reef: 2 }, genoa: { furl: 0.5 } } }, { minTws: 28, set: { main: { reef: 2 }, genoa: { furl: 0.75 } } }] }),
  ketch: mk({ LWL: 13.4, T: 2.3, disp: 18, GM: 1.5, AVS: 125, Sw: 40, Alat: 6.5, ARk: 1.0, bK: 3.2, Ar: 1.0, br: 1.5, zr: 6.6, zclr: 1.0, xclr: 0.0, Apar: 13, rr: 'heavy', fb: 1.45, phiT: 20, turn: 16, tauPhi: 2,
    sails: [
      { id: 'yankee', type: 'jib', pts: [[-9.0, 2.0], [-2.75, 18.4], [-3.6, 5.2]], furl: true, dmin: 13, dmax: 75, head: true },
      { id: 'stay', type: 'stay', pts: [[-6.4, 1.75], [-2.75, 13.8], [-2.3, 2.3]], dmin: 11, dmax: 70, head: true },
      { id: 'main', type: 'main', pts: [[-2.6, 3.45], [-2.6, 18.45], [2.6, 3.6]], roach: 1.1, reefs: [0.78, 0.58], dmin: -3, dmax: 80, travMin: -3, travMax: 12 },
      { id: 'mizzen', type: 'mizzen', pts: [[4.0, 3.65], [4.0, 13.4], [7.4, 3.8]], roach: 1.1, reefs: [0.75], dmin: -2, dmax: 80, travMin: -2, travMax: 10 },
    ],
    plans: [{ maxTws: 24, set: {} }, { minTws: 14, set: { yankee: { furl: 0.3 }, main: { reef: 1 } } }, { minTws: 20, set: { yankee: { hoist: 0 }, main: { reef: 2 }, mizzen: { reef: 1 } } }, { minTws: 30, set: { yankee: { hoist: 0 }, main: { hoist: 0 }, mizzen: { reef: 1 } } }] }),
  catamaran: mk({ cat: true, hs: 3.0, phiFly: 5, KG: 2.4, LWL: 13.6, T: 1.3, disp: 12, GM: 30, AVS: 90, Sw: 42, Alat: 8.2, ARk: 0.7, bK: 2.2, Ar: 0.9, br: 1.0, zr: 6.3, zclr: 0.6, xclr: -0.4, Apar: 30, rr: 'cat', fb: 1.9, phiT: 4, turn: 18, tauPhi: 1.5,
    sails: [
      { id: 'code0', type: 'code0', light: true, pts: [[-7.6, 2.1], [-2.75, 21.2], [0.2, 3.2]], furl: true, dmin: 20, dmax: 95, head: true },
      { id: 'jib', type: 'jib', pts: [[-6.2, 2.0], [-2.8, 19.0], [-2.2, 2.6]], furl: true, dmin: 12, dmax: 60, head: true },
      { id: 'main', type: 'main', pts: [[-2.7, 4.5], [-2.7, 21.8], [3.7, 4.6]], roach: 1.3, reefs: [0.75, 0.55, 0.38], dmin: -3, dmax: 75, travMin: -3, travMax: 15 },
    ],
    plans: [{ maxTws: 14, set: { code0: { hoist: 1 }, jib: { hoist: 0 } } }, { maxTws: 20, set: {} }, { minTws: 16, maxTws: 28, set: { main: { reef: 1 } } }, { minTws: 22, set: { main: { reef: 2 }, jib: { furl: 0.4 } } }] }),
  schooner: mk({ LWL: 26.5, T: 3.5, disp: 180, GM: 1.35, AVS: 115, Sw: 175, Alat: 48, ARk: 0.7, bK: 4.55, Ar: 4.2, br: 2.6, zr: 15.2, zclr: 1.5, xclr: 2.1, Apar: 70, rr: 'heavy', fb: 1.7, phiT: 18, turn: 9, tauPhi: 3,
    sails: [
      { id: 'flyjib', type: 'jib', light: true, pts: [[-24.0, 3.2], [-7.7, 27.0], [-17.0, 7.8]], dmin: 14, dmax: 70, head: true },
      { id: 'jib', type: 'jib', pts: [[-21.0, 2.8], [-7.7, 21.5], [-12.6, 4.0]], dmin: 13, dmax: 70, head: true },
      { id: 'stay', type: 'stay', pts: [[-17.2, 2.4], [-7.7, 16.0], [-10.4, 2.9]], dmin: 12, dmax: 70, head: true },
      { id: 'fore', type: 'gaff', blank: true, pts: [[-7.4, 3.9], [-7.4, 17.2], [-1.6, 21.6], [1.8, 4.3]], reefs: [0.78], dmin: 0, dmax: 80, travMin: 0, travMax: 6 },
      { id: 'foretop', type: 'topsail', light: true, blank: true, pts: [[-7.4, 17.4], [-7.4, 27.5], [-1.9, 21.4]], dmin: 4, dmax: 80, travMax: 4 },
      { id: 'main', type: 'gaff', pts: [[3.1, 4.3], [3.1, 20.3], [12.0, 25.7], [17.2, 4.9]], reefs: [0.78, 0.6], dmin: 0, dmax: 80, travMin: 0, travMax: 8 },
      { id: 'maintop', type: 'topsail', light: true, pts: [[3.1, 20.5], [3.1, 32.5], [11.7, 25.4]], dmin: 4, dmax: 80, travMax: 4 },
    ],
    plans: [{ maxTws: 18, set: {} }, { maxTws: 26, set: { flyjib: { hoist: 0 }, foretop: { hoist: 0 }, maintop: { hoist: 0 } } }, { minTws: 16, set: { flyjib: { hoist: 0 }, foretop: { hoist: 0 }, maintop: { hoist: 0 }, main: { reef: 1 } } }, { minTws: 22, set: { flyjib: { hoist: 0 }, foretop: { hoist: 0 }, maintop: { hoist: 0 }, jib: { hoist: 0 }, main: { reef: 2 }, fore: { reef: 1 } } }] }),
};
/** sail settings for plan level `lv`: {id: {hoist, reef, furl, delta, twist}}; light sails only when the plan sets them */
export function planState(rig, lv) {
  const ss = {}, set = rig.plans[lv].set;
  for (const s of rig.sails) { const o = set[s.id] || {}; ss[s.id] = { hoist: o.hoist ?? (s.light ? 0 : 1), reef: o.reef || 0, furl: o.furl || 0, delta: 25, twist: TYPES[s.type].tw0 }; }
  return ss;
}
export const plansAt = (rig, twsKn) => rig.plans.map((p, i) => i).filter((i) => twsKn >= (rig.plans[i].minTws ?? 0) && twsKn <= (rig.plans[i].maxTws ?? 99));

// ---- sail coefficients vs angle of attack (deg)
export function coeffs(t, a) {
  const T = TYPES[t];
  const clAt = (x) => T.clmax * Math.sin((Math.PI / 2) * Math.min(1, x / T.as));
  if (a <= 0) return { cl: 0, cd: 0.10 + T.cd0, st: 2 };                                   // flogging
  if (a < A_LUFF) { const f = a / A_LUFF, cl = clAt(A_LUFF) * f; return { cl, cd: T.cd0 + 0.06 * (1 - f) + K_IND * cl * cl, st: 1 }; } // luffing
  if (a <= T.as) { const cl = clAt(a); return { cl, cd: T.cd0 + K_IND * cl * cl, st: 0 }; }
  const w = sstep(T.as, T.as + 25, a), ar = a * D2R;                                     // stall → flat plate
  const clfp = 1.3 * Math.sin(ar) * Math.cos(ar), cdfp = 1.3 * Math.sin(ar) ** 2 + T.cd0, cds = T.cd0 + K_IND * T.clmax ** 2;
  return { cl: T.clmax + (clfp - T.clmax) * w, cd: cds + (cdfp - cds) * w, st: w > 0.25 ? 3 : 0 };
}
const BANDS_TRI = [[1 / 6, 5 / 9], [1 / 2, 3 / 9], [5 / 6, 1 / 9]], BANDS_QUAD = [[1 / 6, 0.4], [1 / 2, 0.33], [5 / 6, 0.27]];

// ---- aerodynamic forces. tws10 = true wind over the water at 10 m (m/s), twa (deg 0..180), V (m/s), lam leeway (deg), phi heel (deg)
export function aero(rig, ss, tws10, twa, V, lam, phi) {
  let Fx = 0, Fn = 0, HM = 0, Mz = 0;
  const bands = [], cphi = Math.cos(phi * D2R);
  for (const s of rig.sails) {
    const st = ss[s.id]; if (!st || st.hoist <= 0) continue;
    // downwash: a sail sets in the turned-down flow behind a headsail (5°) / another boomed sail (3°) ahead of it
    let dw = 0;
    if (!s.head) { for (const o of rig.sails) if (o !== s && ss[o.id]?.hoist > 0.5 && o.zc < s.zc) dw = Math.max(dw, o.head ? 5 : 3); }
    const red = st.reef ? s.reefs[st.reef - 1] : 1;
    const area = s.A * red * (1 - (st.furl || 0)) * st.hoist;
    const y0 = s.y0, y1 = s.y0 + (s.y1 - s.y0) * Math.sqrt(red);
    for (const [eta, w] of s.type === 'gaff' ? BANDS_QUAD : BANDS_TRI) {
      const z = y0 + eta * (y1 - y0);
      const tw = tws10 * Math.pow(Math.max(z, 1) / 10, 0.13);                              // wind gradient
      const ax = tw * Math.cos(twa * D2R) + V * Math.cos(lam * D2R), ay = tw * Math.sin(twa * D2R) - V * Math.sin(lam * D2R);
      const aws = Math.hypot(ax, ay), awa = Math.atan2(ay, ax) / D2R;
      const be = Math.atan2(Math.sin(awa * D2R) * cphi, Math.cos(awa * D2R)) / D2R;          // heeled (Kerwin) angle
      const awse = aws * Math.sqrt(Math.cos(awa * D2R) ** 2 + (Math.sin(awa * D2R) * cphi) ** 2);
      const blank = s.head || s.blank ? 1 - 0.65 * sstep(110, 170, awa) * (twa > 160 ? 0.25 : 1) : 1; // main's wind shadow; wing-on-wing past 160
      const al = be - (st.delta + st.twist * eta) - dw * sstep(70, 40, awa);
      let { cl, cd, st: state } = coeffs(s.type, al);
      if (st.furl) cl *= 1 - 0.3 * st.furl;
      if (st.reef) cl *= 1 - 0.04 * st.reef;
      if (st.hoist < 1) cl *= st.hoist * st.hoist;
      const q = 0.5 * RA * (awse * blank) ** 2 * area * w;
      const fx = q * (cl * Math.sin(be * D2R) - cd * Math.cos(be * D2R)), fn = q * (cl * Math.cos(be * D2R) + cd * Math.sin(be * D2R));
      Fx += fx; Fn += fn; HM += fn * (z + rig.zclr); Mz += fn * cphi * (s.zc - rig.xclr);
      if (eta === 0.5) bands.push({ id: s.id, alpha: al, be, awa, aws, state });
    }
  }
  { // hull + rig windage at 6 m
    const tw = tws10 * Math.pow(0.6, 0.13), ax = tw * Math.cos(twa * D2R) + V, ay = tw * Math.sin(twa * D2R), aws = Math.hypot(ax, ay), q = 0.5 * RA * aws * aws * rig.Apar * 0.9;
    Fx -= (q * ax) / aws; Fn += (q * ay) / aws; HM += ((q * ay) / aws) * (rig.fb + 2 + rig.zclr);
  }
  return { Fx, Fn, HM, Mz, bands };
}
// ---- righting moment (N·m) at heel phi (deg)
export function RM(rig, phi) {
  const p = phi * D2R;
  if (rig.cat) return rig.disp * 1000 * G * (rig.hs * Math.cos(p) * Math.min(1, phi / rig.phiFly) - (phi > rig.phiFly ? rig.KG * Math.sin(p) : 0));
  return rig.disp * 1000 * G * Math.max(-0.2, rig.GM * Math.sin(p) * (1 - (phi / rig.AVS) ** 2) * (1 + 0.35 * Math.sin(p) ** 2));
}
// ---- hull: resistance, leeway, helm. Fs = horizontal sail side force (N), Mz = sail yaw moment about the CLR, zce = CE height
export function hull(rig, V, phi, Fs, Mz, Fx, zce) {
  const Vr = Math.max(V, 0.05), q = 0.5 * RW * Math.max(V, 0.5) ** 2;
  const Re = Vr * 0.7 * rig.LWL / NU, cf = 0.075 / (Math.log10(Math.max(Re, 1e5)) - 2) ** 2;
  const Fr = Vr / Math.sqrt(G * rig.LWL);
  const Rf = 0.5 * RW * Vr * Vr * rig.Sw * cf * 1.12, Rr = rig.disp * 1000 * G * lerpT(RR[rig.rr], Fr);
  const hf = 1 + 0.5 * (phi / 30) ** 2 + 2.0 * Math.max(0, (phi - 25) / 20) ** 2;          // heel drag
  const be = rig.bK * Math.cos(phi * D2R), cla = (2 * Math.PI * rig.ARk) / (rig.ARk + 2), LS = 10;
  const lamLin = Fs / (q * rig.Alat * cla) / D2R, FsK = Math.min(Fs, q * rig.Alat * cla * LS * D2R);
  let Ri = (FsK * FsK) / (q * Math.PI * be * be), lam = lamLin;
  if (lamLin > LS) { const ex = Math.min(20, (lamLin - LS) * 0.5); lam = LS + ex; Ri += q * rig.Alat * Math.sin(ex * D2R * 3) ** 2; } // keel stall: side-slip
  const Mw = Mz + Math.sin(phi * D2R) * (Fx * zce + 0.13 * 0.5 * RW * V * V * rig.LWL * rig.Alat); // weather helm (+ = luffs up)
  const lr = rig.zr - rig.xclr, LrMax = q * rig.Ar * 1.2, Hl = Mw / (LrMax * lr);
  const Lr = Math.sign(Mw) * Math.min(Math.abs(Mw / lr), LrMax), dr = Lr / (q * rig.Ar * ((2 * Math.PI * 3) / 5)) / D2R;
  const Rrud = (Lr * Lr) / (q * Math.PI * rig.br * rig.br) + q * rig.Ar * 0.5 * Math.max(0, Math.abs(dr) - 12) ** 2 * D2R * D2R;
  return { R: (Rf + Rr) * hf + Ri + Rrud, Rf, Rr, Ri, Rrud, lam, dr, Hl, Fr };
}
// ---- steady state (VPP): heel by bisection, leeway by fixed point, speed = largest root of drive − resistance
function evalV(rig, ss, tws10, twa, V) {
  let lam = 3, phi = 0, a, h;
  for (let it = 0; it < 5; it++) {
    let lo = 0, hi = rig.cat ? 30 : 75;
    for (let k = 0; k < 16; k++) { const m = (lo + hi) / 2; if (aero(rig, ss, tws10, twa, V, lam, m).HM > RM(rig, m)) lo = m; else hi = m; }
    phi = (lo + hi) / 2; a = aero(rig, ss, tws10, twa, V, lam, phi);
    h = hull(rig, V, phi, a.Fn * Math.cos(phi * D2R), a.Mz, a.Fx, a.HM / Math.max(a.Fn, 1e-6) - rig.zclr); lam = h.lam;
  }
  return { f: a.Fx - h.R, V, phi, lam, dr: h.dr, Hl: h.Hl, bands: a.bands };
}
export function solve(rig, ss, tws10, twa) {
  let prev = evalV(rig, ss, tws10, twa, 12.5);
  for (let V = 12.0; V >= 0.05; V -= 0.5) {
    const cur = evalV(rig, ss, tws10, twa, V);
    if (cur.f > 0 && prev.f <= 0) { let lo = V, hi = V + 0.5, r = cur; for (let k = 0; k < 12; k++) { const m = (lo + hi) / 2; r = evalV(rig, ss, tws10, twa, m); if (r.f > 0) lo = m; else hi = m; } return r; }
    prev = cur;
  }
  const r = evalV(rig, ss, tws10, twa, 0.05); r.V = 0; return r;
}
// ---- trim rule (auto-trim): chord angle at the foot = heeled AWA at mid height − target AoA − half the twist
export const trimDelta = (s, be, aT, twist) => clamp(be - aT - twist * 0.5, s.dmin, s.dmax);
/** twist (deg, foot→head) for a chord angle at the foot: easing a sheet opens the leech; the traveller car does not */
export function twistFor(s, delta, car = Math.min(delta, s.travMax ?? 12)) {
  const T = TYPES[s.type];
  return s.head ? T.tw0 + 6 * clamp((delta - s.dmin) / 25, 0, 1) : T.tw0 + 8 * clamp((delta - car) / 20, 0, 1);
}
/** auto-trim one sail: target AoA aT at mid height → {delta, twist} (two passes because twist depends on delta) */
export function autoTrimSail(s, be, aT) {
  let tw = twistFor(s, s.dmin), d = trimDelta(s, be, aT, tw);
  tw = twistFor(s, d); d = trimDelta(s, be, aT, tw); return { delta: d, twist: twistFor(s, d) };
}
export function trimmed(rig, tws10, twa, lv, k) {
  const ss = planState(rig, lv); let r;
  for (let it = 0; it < 4; it++) { r = solve(rig, ss, tws10, twa); for (const b of r.bands) { const s = rig.sails.find((x) => x.id === b.id); Object.assign(ss[b.id], autoTrimSail(s, b.be, k * TYPES[s.type].as)); } }
  return { ...r, ss };
}
/** polar point: best plan level allowed at this wind × trim factor k ∈ {0.8, 0.95, 1.1} */
export function polarPoint(cls, twsKn, twa) {
  const rig = RIGS[cls]; let b = null;
  for (const lv of plansAt(rig, twsKn)) for (const k of [0.8, 0.95, 1.1]) { const r = trimmed(rig, twsKn * KN, twa, lv, k); if (!b || r.V > b.V) b = { ...r, lv, k }; }
  return b;
}

// ---- time domain (one aero evaluation per step)
export function sim(cls, twsKn, twa0, o = {}) {
  const rig = RIGS[cls], tws = twsKn * KN, dt = o.dt || 0.1, T = o.T || 900, m = rig.disp * 1000 * 1.08;
  const ss = planState(rig, o.lv ?? 0);
  { const a0 = aero(rig, ss, tws, twa0, o.V0 ?? 0.5, 0, 0); for (const b of a0.bands) Object.assign(ss[b.id], autoTrimSail(rig.sails.find((x) => x.id === b.id), b.be, 0.95 * TYPES[rig.sails.find((x) => x.id === b.id).type].as)); } // trimmed before the first step
  let V = o.V0 ?? 0.5, phi = 0, lam = 0, H = 0, off = 0, d = 0, acc = 0, accPhi = 0, n = 0, minTwa = 999, ru = 0, wasRU = false, irons = 0;
  for (let t = 0; t < T; t += dt) {
    const twa = clamp(twa0 + off, 0, 180);
    const a = aero(rig, ss, tws, twa, V, lam, phi);
    const kT = o.trim === 'max' ? 0.95 : 0.95 * (1 - d);
    for (const b of a.bands) { const s = rig.sails.find((x) => x.id === b.id); Object.assign(ss[b.id], autoTrimSail(s, b.be, kT * TYPES[s.type].as)); }
    if (o.trim !== 'max') d = clamp(d + dt * 0.08 * (phi - rig.phiT) / 5, 0, 0.9);              // depower controller on heel
    let pt = phi; const hm0 = a.HM, c0 = Math.cos(phi * D2R) ** 2;                           // heel target: HM ∝ cos²φ
    for (let k = 0; k < 4; k++) { const g = (hm0 * Math.cos(pt * D2R) ** 2) / c0 - RM(rig, pt), dg = ((hm0 * Math.cos((pt + 0.5) * D2R) ** 2) / c0 - RM(rig, pt + 0.5) - g) / 0.5; pt = clamp(pt - g / Math.min(dg, -1), 0, 80); }
    phi += (pt - phi) * (1 - Math.exp(-dt / rig.tauPhi));
    const zce = a.HM / Math.max(a.Fn, 1e-6) - rig.zclr, Fs = a.Fn * Math.cos(phi * D2R);
    const h = hull(rig, V, phi, Fs, a.Mz, a.Fx, zce), h2 = hull(rig, V + 0.05, phi, Fs, a.Mz, a.Fx, zce);
    lam += (h.lam - lam) * Math.min(1, dt / 1.0);
    V = Math.max(0, V + (dt * (a.Fx - h.R)) / (m + dt * Math.max(0, (h2.R - h.R) / 0.05)));     // semi-implicit surge
    H += (h.Hl - H) * Math.min(1, dt / 1.0);
    const auth = Math.cos(phi * D2R) * (1 - 0.7 * sstep(30, 50, phi));
    const rud = clamp(-off / 25 + H / Math.max(auth, 0.2), -1, 1);                           // course keeper with helm feed-forward
    const way = Math.min(1, V / (0.5 * 2.43 * Math.sqrt(rig.LWL) * KN));
    let yaw = rig.turn * way * (auth * rud - clamp(H, -1.5, 1.5));                           // + = bears away (TWA grows)
    if (twa < 25 && V < 1 * KN) { irons += dt; if (irons > 3) yaw += 2.5; } else irons = 0;     // in irons: crew backs the jib
    off += yaw * dt;
    const r = off < -8; if (r && !wasRU) ru++; wasRU = r;
    if (t > T - 120) { acc += V; accPhi += phi; n++; minTwa = Math.min(minTwa, twa); }
  }
  return { kn: acc / n / KN, heel: accPhi / n, minTwa, roundUps: ru };
}
```

## Appendix B — polar tables (reference run 2026-10-09)

Generated with `polarPoint` (Appendix A) on the grid below; `polars.gen.js` covers TWS 0–40 kn × TWA 0–180° in 5° steps.
Cell = boat speed (kn) / heel (°, VPP value before the crew's heel cap) / plan level chosen. Leeway at 12 kn is 4–5° close-hauled (catamaran 6–7°),
2° on a beam reach.

**Sloop 11 m** — boat speed kn / heel ° / plan level (auto-trim), by true wind speed (rows) and true wind angle (columns)

| TWS \ TWA | 25 | 30 | 35 | 40 | 45 | 50 | 55 | 60 | 75 | 90 | 105 | 120 | 135 | 150 | 165 | 180 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 6 kn | 0.0/2/L0 | 2.3/3/L0 | 3.2/5/L0 | 3.9/5/L0 | 4.4/6/L0 | 4.8/7/L0 | 5.2/7/L0 | 5.5/7/L0 | 5.9/7/L0 | 6.0/5/L0 | 5.8/3/L0 | 5.2/1/L0 | 4.4/0/L0 | 2.9/0/L0 | 2.9/0/L0 | 1.6/0/L0 |
| 12 kn | 0.0/8/L0 | 4.1/13/L0 | 5.3/16/L0 | 6.0/18/L0 | 6.5/19/L0 | 6.8/20/L0 | 6.9/21/L0 | 7.1/19/L0 | 7.6/16/L0 | 7.8/11/L0 | 7.7/7/L0 | 7.4/3/L0 | 6.9/0/L0 | 5.5/0/L0 | 5.5/0/L0 | 2.8/0/L0 |
| 20 kn | 1.4/23/L0 | 4.6/27/L0 | 5.7/24/L1 | 6.3/26/L1 | 6.7/28/L1 | 7.0/27/L1 | 7.3/26/L1 | 7.6/24/L1 | 8.2/27/L0 | 9.0/19/L0 | 9.5/11/L0 | 9.4/3/L0 | 7.8/0/L0 | 7.5/1/L0 | 7.6/1/L0 | 4.6/0/L0 |
| 25 kn | 1.4/25/L1 | 4.3/28/L1 | 5.2/23/L2 | 6.1/25/L2 | 6.7/25/L2 | 7.0/25/L2 | 7.3/23/L2 | 7.6/22/L2 | 8.5/26/L1 | 9.3/18/L1 | 10.0/10/L1 | 9.8/1/L1 | 8.4/0/L1 | 7.9/2/L1 | 8.2/2/L1 | 5.3/0/L1 |

Best VMG: 6 kn: up 50° (3.12 kn), down 135° (3.09 kn); 12 kn: up 40° (4.58 kn), down 165° (5.36 kn); 20 kn: up 40° (4.84 kn), down 165° (7.35 kn); 25 kn: up 45° (4.74 kn), down 165° (7.87 kn).

**Ketch 16 m** — boat speed kn / heel ° / plan level (auto-trim), by true wind speed (rows) and true wind angle (columns)

| TWS \ TWA | 25 | 30 | 35 | 40 | 45 | 50 | 55 | 60 | 75 | 90 | 105 | 120 | 135 | 150 | 165 | 180 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 6 kn | 0.0/1/L0 | 0.0/2/L0 | 3.2/3/L0 | 3.9/3/L0 | 4.5/4/L0 | 5.0/4/L0 | 5.3/5/L0 | 5.7/5/L0 | 6.0/4/L0 | 6.1/3/L0 | 5.8/2/L0 | 5.3/1/L0 | 4.5/0/L0 | 3.0/0/L0 | 3.0/0/L0 | 1.5/0/L0 |
| 12 kn | 0.0/5/L0 | 4.3/8/L0 | 5.7/11/L0 | 6.5/12/L0 | 7.0/13/L0 | 7.4/14/L0 | 7.7/14/L0 | 7.9/14/L0 | 8.1/11/L0 | 8.2/7/L0 | 8.1/4/L0 | 7.9/2/L0 | 5.8/0/L0 | 5.7/0/L0 | 5.7/0/L0 | 2.5/0/L0 |
| 20 kn | 1.4/16/L0 | 5.3/20/L0 | 6.7/22/L0 | 7.3/24/L0 | 7.8/26/L0 | 8.0/25/L0 | 8.3/24/L0 | 8.5/23/L0 | 9.2/20/L0 | 9.7/14/L0 | 9.8/7/L0 | 9.5/2/L0 | 8.0/0/L0 | 7.9/1/L0 | 8.0/1/L0 | 4.3/0/L0 |
| 25 kn | 1.5/19/L1 | 5.5/21/L1 | 6.6/25/L1 | 7.3/27/L1 | 7.8/28/L1 | 8.1/27/L1 | 8.4/26/L1 | 8.7/24/L1 | 9.4/20/L1 | 10.1/14/L1 | 10.3/7/L1 | 10.1/1/L1 | 8.9/0/L1 | 8.4/1/L1 | 8.6/1/L1 | 5.1/0/L1 |

Best VMG: 6 kn: up 45° (3.2 kn), down 135° (3.16 kn); 12 kn: up 40° (4.95 kn), down 165° (5.48 kn); 20 kn: up 40° (5.59 kn), down 165° (7.72 kn); 25 kn: up 40° (5.56 kn), down 165° (8.28 kn).

**Catamaran 14 m** — boat speed kn / heel ° / plan level (auto-trim), by true wind speed (rows) and true wind angle (columns)

| TWS \ TWA | 25 | 30 | 35 | 40 | 45 | 50 | 55 | 60 | 75 | 90 | 105 | 120 | 135 | 150 | 165 | 180 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 6 kn | 0.0/0/L0 | 0.0/0/L0 | 0.0/0/L0 | 0.0/0/L0 | 0.0/0/L0 | 3.6/0/L1 | 4.0/0/L0 | 4.5/0/L0 | 5.3/0/L0 | 5.7/0/L0 | 5.6/0/L0 | 5.1/0/L0 | 4.5/0/L0 | 2.9/0/L1 | 3.0/0/L0 | 1.7/0/L1 |
| 12 kn | 0.0/0/L0 | 0.0/0/L0 | 1.1/1/L1 | 3.9/1/L1 | 5.1/1/L1 | 6.0/1/L0 | 6.7/1/L0 | 7.2/1/L0 | 8.3/1/L0 | 8.8/1/L0 | 8.5/1/L0 | 8.0/0/L0 | 7.2/0/L0 | 5.4/0/L1 | 5.6/0/L0 | 3.6/0/L1 |
| 20 kn | 1.1/1/L1 | 1.5/2/L1 | 1.8/2/L1 | 6.0/2/L1 | 6.8/2/L1 | 7.9/2/L1 | 8.7/2/L1 | 9.4/2/L1 | 11.2/2/L1 | 11.8/1/L1 | 11.5/1/L1 | 10.4/0/L1 | 8.3/0/L1 | 7.7/0/L1 | 7.8/0/L1 | 4.2/0/L1 |
| 25 kn | 1.0/2/L2 | 1.5/2/L2 | 1.9/2/L2 | 2.1/2/L2 | 7.0/2/L2 | 8.0/2/L2 | 9.1/2/L2 | 10.1/2/L2 | 12.7/2/L2 | 13.7/1/L2 | 13.4/1/L2 | 11.6/0/L2 | 9.0/0/L2 | 8.6/0/L2 | 8.8/0/L2 | 5.0/0/L2 |

Best VMG: 6 kn: up 55° (2.32 kn), down 135° (3.22 kn); 12 kn: up 50° (3.83 kn), down 165° (5.42 kn); 20 kn: up 50° (5.07 kn), down 165° (7.56 kn); 25 kn: up 55° (5.2 kn), down 165° (8.54 kn).

**Classic schooner 35 m** — boat speed kn / heel ° / plan level (auto-trim), by true wind speed (rows) and true wind angle (columns)

| TWS \ TWA | 25 | 30 | 35 | 40 | 45 | 50 | 55 | 60 | 75 | 90 | 105 | 120 | 135 | 150 | 165 | 180 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 6 kn | 0.0/1/L0 | 0.0/1/L0 | 0.0/1/L0 | 3.2/2/L0 | 4.0/2/L0 | 4.7/3/L0 | 5.2/3/L0 | 5.5/3/L0 | 6.2/3/L0 | 6.3/2/L0 | 6.0/1/L0 | 5.3/1/L0 | 4.5/0/L0 | 3.0/0/L0 | 3.0/0/L0 | 1.2/0/L0 |
| 12 kn | 0.0/4/L0 | 0.0/4/L0 | 4.6/6/L0 | 6.0/8/L0 | 7.0/9/L0 | 7.7/10/L0 | 8.2/10/L0 | 8.6/9/L0 | 9.4/8/L0 | 9.6/6/L0 | 9.5/3/L0 | 8.9/1/L0 | 8.0/0/L0 | 6.0/0/L0 | 6.1/0/L0 | 2.5/0/L0 |
| 20 kn | 0.0/10/L1 | 1.3/12/L1 | 4.6/15/L1 | 7.4/13/L2 | 8.4/14/L2 | 9.1/14/L2 | 9.6/14/L2 | 10.0/15/L2 | 11.0/12/L2 | 11.4/10/L1 | 11.5/6/L1 | 11.3/2/L1 | 8.5/0/L1 | 9.1/0/L1 | 9.2/0/L1 | 4.4/0/L1 |
| 25 kn | 1.1/14/L1 | 1.6/18/L1 | 5.1/19/L2 | 7.3/19/L2 | 8.5/20/L2 | 9.4/20/L2 | 9.9/19/L2 | 10.4/18/L2 | 11.3/15/L2 | 11.9/13/L1 | 12.3/7/L1 | 12.2/2/L1 | 10.0/0/L1 | 10.4/0/L1 | 10.6/0/L1 | 5.4/0/L1 |

Best VMG: 6 kn: up 50° (3.05 kn), down 135° (3.19 kn); 12 kn: up 50° (4.96 kn), down 165° (5.87 kn); 20 kn: up 45° (5.93 kn), down 165° (8.92 kn); 25 kn: up 45° (6.02 kn), down 165° (10.23 kn).
