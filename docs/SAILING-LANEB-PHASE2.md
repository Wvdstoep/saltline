# Saltline — real sailing, Lane B phase 2: wiring the client

Companion to `docs/SAILING-CONTRACT.md` (Lane B: §4 visuals, §5 HUD and controls, §3.7 sync, §4.5 deck plans) and to
Lane A's `docs/SAILING-PHASE2.md` (shared physics and server wiring). Phase 1 (2026-10-09) added **new files only**;
this document is the exact, ordered list of edits phase 2 makes to existing client files. Every edit is a **search
anchor** (unique text in the file today, never a line number) plus code ready to paste. The anchors in §3 were copied
verbatim from the tree by a script, and the whole set was applied mechanically to a scratch copy and tested (§4).

## 1. What phase 1 delivered (new files)

| file | what |
|---|---|
| `public/js/yachtlooks.js` | pure: per-class hull lines (sheer spline through the frozen mast feet, deck half-breadth, canoe-body / stem / counter profile, super-ellipse sections, raked or reverse transom), `hullStations`, `section`, `hullHalfAt`, `deckHeightAt`, `structureAt`, deck structures (`structures`, `deckOf`), colours (`LOOKS`), `deckOutlineHalf` (for `shipplan.js`), `yachtDims` |
| `public/js/rigcore.js` | pure: sails as (nu+1)×(nv+1) grids from `RIGS` + a RigView — luff on the mast aft face / on the stay (≤ 2 cm) / on the topmast, roach from the area factor, chord angle per row `δ(v) = angle + side·τ·v` (τ = shared `twistFor`), camber to leeward (c0 0.11–0.16, draft 35–40 %), luffing (front 35 % inverts + 3–6 Hz ripple), flogging (2–4 Hz, 0.08·chord, clew jerk), slab reefs (area ratio exact), roller furling (clew rolls to the luff), hoist / lower (gaff lowers onto the boom), topsails riding on the gaff peak; boom / gaff / club poses; standing rigging (shrouds via spreader tips, split backstay, runners, schooner ratlines / crosstrees / bobstay / whiskers / martingale); running rigging (sheets clew → lead → winch with catenary slack, lazy sheets, mainsheet to the traveller car, halyards, windward runner set up / leeward slack); telltales (3 pairs on headsails, 3 on the main leech; direction from `tt`); reef points; stowed cloth; critically damped spring + crash-jibe step; clearance helpers for the tests |
| `public/js/rigmesh.js` | three.js: `buildYacht(cls, opts)` → lofted hull with a stripe texture (antifouling, boot-top, topsides, cove line / grey band), deck (teak / non-slip texture, cockpit wells cut out), houses, cockpit, wheel (pedestal / bulkhead / spoked + wheel box), winches, tracks, travellers / horses, lifelines + pulpit / pushpit, bowsprits, channels + deadeyes + pin / fife rails, trailboards, keels / rudders; spars; cloth sails with per-class canvas (radial / cross-cut seams, battens, tapes, boltropes, UV strip, sail numbers); telltale ribbons (red to port, green to starboard), reef points; LOD: own ship full model, others ≤ 300 m lite hull + merged 6×8 cloth + lines, ≤ 2 km hull + 2-triangle sails + mast/headstay lines, beyond: hull only. Meshes flagged `walkHide` (deck, houses, deck gear — the deck plan draws them) or `keepWhileWalking` (hull, rig) |
| `public/js/sailfmt.js` | pure: advice line + level (texts and priority from shared `adviceFor`), state / telltale / % / heel / helm / hull-load colours, slider ↔ sheet / traveller mapping, green-tick crossing (haptic), Tack/Jibe label, `windRelSigned`, VMG / VMC, the key map (`keyAction`, `actionToCommand`, `trimAllCommand`) and the game's key list for the collision test |
| `public/js/sailhud.js` | DOM: `new SailHud(root, { onCommand, onManeuver, onToggle, phone, roundButtons })` — wind dial (AWA solid / TWA hollow needles, no-go wedge round the true wind, red / green close-hauled sectors, AWS / TWS / AWA / TWA / TWD), inclinometer (± 45°, green ≤ phiT, amber ≤ phiT + 8, red) + helm bar ("rounding up!"), catamaran hull-load bar, performance strip (STW, SOG, target, % of target, VMG / VMC, leeway), sail panel (helper Off · Hints · Auto, Trim all, Tack / Jibe, per sail: status dot, telltales, roll slider or Hoist / Lower with a crew progress bar, reef stepper, sheet slider with the good band and the green tick, traveller slider with its tick, heel / helm footer, advice line; *Auto* → "Take over the trim?" toast), phone bottom sheet (≤ 55 %, chips, one sail's big controls, ≥ 44 px targets, `navigator.vibrate(5)` on the tick); `handleKey(e)` for §0.2 |
| `public/js/sailshared.js` | re-exports of `shared/sail/*` for client files that tests load by rewriting `./x` imports (their rewrite does not know `/shared/sail/x`) |
| `public/css/sail.css` | the HUD styles (`sh-*`), desktop card and phone sheet, using the `style.css` tokens |
| `test/sailviz-geometry.test.mjs` | §6.4 B-1 (contract name `sail-client-geometry`): leeward side both tacks, camber to leeward, feet on booms, luffs on stays, mast feet on deck and clear of houses, boom sweep clearances, reef areas, cloth states, telltales, stowing, rv frames, standing rigging, springs, LOD grids |
| `test/sailviz-hud.test.mjs` | §6.4 B-3 (`sail-client-hud`): advice priority, sliders, colours, keys (no collisions), key → command, `windRel` sign fix, VMG / VMC |
| `test/sailviz-plan.test.mjs` | §6.4 B-2 (`sail-client-plan`): deck plans after SP1–SP11 — deck height = freeboard, cabins below the waterline, walk round every mast, helm, schooner doghouse at +4.4…+9.6 with the stairs inside. **Skips itself until shipplan.js is wired.** |

The harness that exercised all of it (live `stepSail`, wind slider, screenshots) is outside the tree:
`…/scratchpad/pw/sail/` (`server.mjs` port 3271, `index.html`, `harness.js`, `shoot.mjs`, `jobs-*.json`, `shots/`).

## 2. Order of work and dependencies

1. Lane A phase 2 first (`docs/SAILING-PHASE2.md`): `shared/physics.js` P1–P3 (the sail branch of `stepShip`), server
   `rig` / `rig_event` / `rv` (G1–G12). The client edits below work without them (the rig is local; `rv` is ignored by an
   old server), but the server only stores your sail state after G3.
2. `ship.js` (SJ1–SJ4) — every other client edit assumes `userData.setRig / updateRig`.
3. `shipplan.js` (SP1–SP11), `interior.js` (IN1–IN3), `test/interior.test.mjs` (TE1) — together, then run the interior
   suites and `test/sailviz-plan.test.mjs` (it switches on by itself).
4. `motion.js` (MO1–MO3), `net.js` (NE1–NE2), `touch.js` (TO1–TO3), `ais.js` (AI1), `sound.js` (SO1–SO3).
5. `autopilot.js` (AP1–AP5), `main.js` (MA1–MA20), `index.html` (IX1–IX2).
6. `node --test test/sail*.test.mjs test/interior*.test.mjs test/autopilot-review.test.mjs test/ais.test.mjs test/telegraph.test.mjs test/warp.test.mjs`,
   then the browser scenarios §6.5.

`main.js`, `hud.js`, `motion.js` and `sound.js` are being edited by other agents: every anchor is content, not a line;
if one moved, search for the anchor text — each is unique in today's file. `hud.js` needs **no** edit (the legacy
*Sails: set / furled* button stays and now drives the rig through `main.js` `setSails` → MA7; the panel button lives in
the sail HUD), `thumbs.js` needs none (`setSails(true, 62)` is a starboard close reach with the folded angle).

## 3. The edits

### 1. `public/js/ship.js`

**SJ1** — Imports. rigmesh.js / sailshared.js are the phase-1 files.

Anchor (insert **after** the anchor):

```js
import { surfaceHeightAt, oceanState } from './ocean2.js';
```

Code:

```js
import { buildYacht } from './rigmesh.js';                      // sailing yachts (docs/SAILING-CONTRACT.md §4)
import { autoTrimView } from './sailshared.js';
```

**SJ2** — The four sail builders (yachtHull + sailboatDeck + rig, catamaran hulls) become one builder. `yachtBuilder` is a function declaration (SJ3), hoisted, so the object literal can name it.

Anchor (**replace** the anchor text with):

```js
  sloop(ctx) { yachtHull(ctx); sailboatDeck(ctx, 0.15); return rig(ctx, [{ z: -ctx.L * 0.12, h: ctx.L * 1.3, boom: ctx.L * 0.38, jib: true }]); },
  ketch(ctx) { yachtHull(ctx); sailboatDeck(ctx, 0.18); return rig(ctx, [{ z: -ctx.L * 0.15, h: ctx.L * 1.2, boom: ctx.L * 0.34, jib: true }, { z: ctx.L * 0.3, h: ctx.L * 0.8, boom: ctx.L * 0.24, jib: false }]); },
  schooner(ctx) {
    yachtHull(ctx);
    const { L, B, deckY, box, rod, pb } = ctx;
    // deckhouses, wheel, bowsprit
    box(B * 0.5, 1.0, L * 0.14, ctx.superMat, 0, deckY + 0.5, L * 0.14); box(B * 0.45, 0.9, L * 0.1, ctx.superMat, 0, deckY + 0.45, -L * 0.2);
    pb.geo(new THREE.TorusGeometry(0.6, 0.05, 5, 12), P.teak, 0, deckY + 1.1, L * 0.36, 0, 0, 0); rod(0, deckY, L * 0.36, 0, deckY + 1.1, L * 0.36, 0.06, P.steel);
    rod(0, deckY + 0.3, -L / 2 + 1, 0, deckY + 0.9, -L / 2 - L * 0.12, 0.12, P.teak);
    ctx.bowsprit = { x: 0, y: deckY + 0.9, z: -L / 2 - L * 0.12 };
    ctx.hullRail(yachtShape(L, B), deckY + 0.2, 0.5);
    return rig(ctx, [{ z: -L * 0.22, h: L * 0.7, boom: L * 0.3, jib: true, gaff: true }, { z: L * 0.12, h: L * 0.82, boom: L * 0.36, jib: false, gaff: true }]);
  },
  catamaran(ctx) {
    const { g, L, B, deckY, draft, freeboard, hullMat, deckMat, box, win, pb } = ctx;
    // twin hulls + bridge deck + cabin + trampoline
    for (const side of [-1, 1]) {
      const h = extrudeHull(yachtShape(L, B * 0.2), freeboard + draft * 0.5, [deckMat, hullMat], -draft * 0.5, false); h.position.x = side * B * 0.4; g.add(h);
      pb.box(0.2, draft * 0.5, L * 0.18, hullMat, side * B * 0.4, -draft * 0.7, L * 0.05);
      pb.box(0.1, draft * 0.5, draft * 0.5, hullMat, side * B * 0.4, -draft * 0.4, L / 2 - 1);
    }
    box(B * 0.84, 0.5, L * 0.6, ctx.superMat, 0, freeboard - 0.1, L * 0.08);
    box(B * 0.6, 1.9, L * 0.34, ctx.superMat, 0, freeboard + 1.1, L * 0.02);
    win(B * 0.56, 0.7, 0, freeboard + 1.5, L * 0.02 - L * 0.17 - 0.02); win(L * 0.3, 0.6, -B * 0.3 - 0.02, freeboard + 1.5, L * 0.02, Math.PI / 2); win(L * 0.3, 0.6, B * 0.3 + 0.02, freeboard + 1.5, L * 0.02, Math.PI / 2);
    box(B * 0.66, 0.2, L * 0.38, ctx.superMat, 0, freeboard + 2.1, L * 0.02);
    box(B * 0.5, 0.9, L * 0.12, ctx.superMat, 0, freeboard + 0.6, L * 0.3); // cockpit seats
    const tramp = new THREE.Mesh(new THREE.PlaneGeometry(B * 0.66, L * 0.26), P.tramp); tramp.rotation.x = -Math.PI / 2; tramp.position.set(0, freeboard - 0.05, -L * 0.33); g.add(tramp);
    ctx.rail([[-B * 0.4, -L * 0.45], [-B * 0.4, L * 0.4]], freeboard + 0.1); ctx.rail([[B * 0.4, -L * 0.45], [B * 0.4, L * 0.4]], freeboard + 0.1);
    ctx.crewSpots.push([B * 0.15, freeboard + 0.4, L * 0.3]);
    ctx.deckY = freeboard + 0.3; ctx.bowFrac = 0.42;
    return rig(ctx, [{ z: -L * 0.05, h: L * 1.25, boom: L * 0.36, jib: true, foot: freeboard + 2.2 }]);
  },
```

Replacement:

```js
  // sailing yachts (docs/SAILING-CONTRACT.md §4): hull lines, deck layout, rig and cloth sails from rigmesh.js
  sloop: yachtBuilder, ketch: yachtBuilder, catamaran: yachtBuilder, schooner: yachtBuilder,
```

**SJ3** — sailboatDeck() and rig() are deleted (contract §4.1); yachtBuilder takes their place.

Anchor (**replace** the anchor text with):

```js
/** cabin trunk, cockpit, lifelines for monohull sailing yachts */
function sailboatDeck(ctx, trunkFrac) {
  const { L, B, deckY, box, win, pb } = ctx;
  box(B * 0.6, 0.8, L * 0.34, ctx.superMat, 0, deckY + 0.3, -L * 0.05);
  win(L * 0.26, 0.3, -B * 0.3 - 0.02, deckY + 0.45, -L * 0.05, Math.PI / 2); win(L * 0.26, 0.3, B * 0.3 + 0.02, deckY + 0.45, -L * 0.05, Math.PI / 2);
  box(B * 0.56, 0.35, L * 0.1, ctx.superMat, 0, deckY + 0.85, -L * 0.08, -0.35, 0, 0); // sprayhood
  box(B * 0.5, 0.5, L * 0.22, P.teak, 0, deckY + 0.15, L * 0.25); // cockpit seats
  pb.geo(new THREE.TorusGeometry(B * 0.16, 0.035, 5, 16), P.steel, 0, deckY + 0.9, L * 0.34, 0, 0, 0); // wheel
  pb.rod(0, deckY, L * 0.34, 0, deckY + 0.9, L * 0.34, 0.05, P.steel);
  ctx.hullRail(yachtShape(L, B), deckY + 0.1, 0.45);
  ctx.crewSpots.push([0, deckY + 0.05, L * 0.34 + 0.65]); // at the wheel
  void trunkFrac;
}

/** masts, booms, standing rigging and sails. Each spec: {z, h (mast height above deck), boom, jib, gaff?, foot?} */
function rig(ctx, specs) {
  const { g, L, B, deckY, pb } = ctx;
  let topY = deckY;
  const sails = ctx.sails;
  specs.forEach((s, i) => {
    const foot = s.foot ?? deckY;
    const mastTop = foot + s.h, boomY = foot + 1.6;
    pb.cyl(0.11 + L * 0.004, s.h, P.steel, 0, foot + s.h / 2, s.z, 0.06 + L * 0.002, 8);
    pb.box(0.12, 0.08, B * 0.5, P.steel, 0, foot + s.h * 0.6, s.z); // spreaders
    // standing rigging: shrouds via the spreader tips, forestay to the bow (or bowsprit), backstay to the stern
    const bowZ = ctx.bowsprit ? ctx.bowsprit.z : -L / 2 + 0.3, bowY = ctx.bowsprit ? ctx.bowsprit.y : deckY + 0.2;
    for (const side of [-1, 1]) { pb.rod(side * B * 0.46, deckY + 0.1, s.z + 0.4, side * B * 0.25, foot + s.h * 0.6, s.z, 0.02, P.dark, 4); pb.rod(side * B * 0.25, foot + s.h * 0.6, s.z, 0, mastTop - 0.3, s.z, 0.02, P.dark, 4); }
    if (i === 0) pb.rod(0, bowY, bowZ, 0, mastTop - 0.2, s.z, 0.025, P.dark, 4);
    if (i === specs.length - 1) pb.rod(0, deckY + 0.3, L / 2 - 0.4, 0, mastTop - 0.4, s.z, 0.025, P.dark, 4);
    if (i > 0) pb.rod(0, (specs[i - 1].foot ?? deckY) + specs[i - 1].h * 0.98, specs[i - 1].z, 0, mastTop - 0.5, s.z, 0.02, P.dark, 4); // triatic
    // boom + mainsail pivot at the mast
    const pivot = new THREE.Group(); pivot.position.set(0, 0, s.z); g.add(pivot);
    const boomMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.07 + L * 0.002, 0.07 + L * 0.002, s.boom, 8), P.steel);
    boomMesh.rotation.x = Math.PI / 2; boomMesh.position.set(0, boomY, s.boom / 2); pivot.add(boomMesh);
    const cover = new THREE.Mesh(new THREE.BoxGeometry(0.35 + L * 0.006, 0.4 + L * 0.008, s.boom * 0.9), P.sailCover); cover.position.set(0, boomY + 0.25, s.boom * 0.48); pivot.add(cover);
    // mainsail: triangle (or gaff quad) with a convex leech, in the pivot's YZ plane
    const shape = new THREE.Shape();
    const headY = s.gaff ? mastTop - s.h * 0.1 : mastTop - 0.3;
    shape.moveTo(0, boomY); shape.lineTo(s.boom * 0.97, boomY);
    if (s.gaff) { shape.quadraticCurveTo(s.boom * 0.9, (boomY + headY) / 2 + 1, s.boom * 0.55, headY + s.h * 0.08); shape.lineTo(0, headY); }
    else shape.quadraticCurveTo(s.boom * 0.72, (boomY + headY) / 2, 0, headY);
    shape.closePath();
    const sailGeo = new THREE.ShapeGeometry(shape, 6); sailGeo.rotateY(-Math.PI / 2); // shape x → +z (aft), y stays up
    const main = new THREE.Mesh(sailGeo, P.sail); pivot.add(main);
    if (s.gaff) { const gaff = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, s.boom * 0.6, 6), P.steel); gaff.position.set(0, headY + s.h * 0.04, s.boom * 0.28); gaff.rotation.x = Math.PI / 2 - 0.25; pivot.add(gaff); }
    sails.push({ kind: 'main', pivot, mesh: main, cover, boomY, headY });
    if (s.jib) {
      const jp = new THREE.Group(); jp.position.set(0, 0, bowZ); g.add(jp);
      const js = new THREE.Shape(); const jh = mastTop - 0.9, jfoot = s.z - bowZ;
      js.moveTo(0, bowY + 0.2); js.lineTo(jfoot * 0.86, bowY + 0.3); js.quadraticCurveTo(jfoot * 0.5, (bowY + jh) / 2 + 0.5, 0.05, jh); js.closePath();
      const jg = new THREE.ShapeGeometry(js, 6); jg.rotateY(-Math.PI / 2);
      const jib = new THREE.Mesh(jg, P.sail); jp.add(jib);
      // furled jib: a roll along the forestay (cylinder axis Y → rotate it onto the bow→masthead direction)
      const flen = Math.hypot(jfoot, jh - bowY);
      const furl = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, flen, 6), P.sailCover);
      furl.position.set(0, (bowY + jh) / 2, jfoot / 2);
      furl.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, jh - bowY, jfoot).normalize());
      jp.add(furl);
      sails.push({ kind: 'jib', pivot: jp, mesh: jib, cover: furl, boomY: bowY, headY: jh });
    }
    topY = Math.max(topY, mastTop);
    if (i === 0) ctx.lights = { x: B * 0.42, y: deckY + 0.6, z: -L * 0.2, mastY: mastTop + 0.2, mastZ: s.z, fore: null, stern: { y: deckY + 0.6, z: L / 2 - 0.3 } };
  });
  return topY + 3;
}
```

Replacement:

```js
/**
 * Sailing yachts (docs/SAILING-CONTRACT.md §4.1–§4.2): lofted hull, deck layout, spars, rigging and sails from rigmesh.js
 * (three.js) on top of yachtlooks.js / rigcore.js (pure). The hull is drawn with this ship's own wear-shaded material
 * (white base colour + the class stripe texture: antifouling, boot-top, topsides, cove line), so setWear / setFlood /
 * setWaterY and the shipPos bake work as for every hull. Replaces sailboatDeck() and rig() (deleted).
 */
function yachtBuilder(ctx) {
  const touch = typeof window !== 'undefined' && (('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0);
  const y = buildYacht(ctx.cls, {
    touch,
    makeHullMat: (c, o) => { const m = ctx.hullMat; m.color.set(c); m.map = o.map; m.roughness = 0.38; m.metalness = 0.08; m.needsUpdate = true; return m; },
  });
  ctx.g.add(y.group);
  ctx.yacht = y;
  Object.assign(ctx, { deckY: y.dims.deckY, freeboard: y.dims.freeboard, B: y.dims.B, bowFrac: 0.42, lights: y.lights });
  ctx.crewSpots.push(y.crewSpot);
  return y.labelY;
}
```

**SJ4** — buildShip: setRig / setSails / updateRig for the yachts. The signed fold inside setSails is the "sails into the wind" fix for every caller (§1.2 item 1): 0…360 input from old callers maps to the same side as a signed one.

Anchor (**replace** the anchor text with):

```js
  if (ctx.sails.length) g.userData.setSails(true, 90);
```

Replacement:

```js
  if (ctx.yacht) {                                   // sailing yachts: the RigView API (§4.1); setSails kept for ais.js / thumbs.js
    const y = ctx.yacht;
    g.userData.yacht = y; g.userData.isSail = true;
    /** view = RigView (rigViewOf / unpackRigView / autoTrimView), extra = { aws, flags, sides: {id: ±1}, snap } */
    g.userData.setRig = (view, extra) => { if (!view || !Array.isArray(view.sails)) return; y.setRig(view, extra); lightState.underSail = view.sails.some((s) => s.hoist > 0.05); };
    /** legacy: sails up / down sheeted to the relative wind — any range (signed −180…180 or 0…360; + / 0…180 = from starboard) */
    g.userData.setSails = (up, windRelDeg) => {
      const r = Number.isFinite(windRelDeg) ? windRelDeg : 90, signed = ((((r % 360) + 540) % 360) - 180) || 0;
      const v = autoTrimView(cls, signed, 8);
      if (up === false) for (const s of v.sails) { s.hoist = 0; s.state = 5; }
      g.userData.setRig(v, { aws: 8 });
    };
    /** per frame (main.js shipVisual): springs, cloth, LOD — opts { camera, time, own, touch } */
    g.userData.updateRig = (dt, o) => y.update(dt, o);
    g.userData.setSails(true, 90);
  } else if (ctx.sails.length) g.userData.setSails(true, 90);
```


### 2. `public/js/shipplan.js`

**SP1** — Imports (both pure: the node tests keep importing shipplan.js directly).

Anchor (insert **before** the anchor):

```js
export const R = 0.25;          // walker radius: keeps the body off walls, rails and furniture
```

Code:

```js
import { deckOutlineHalf, yachtDims, structures as yachtStructures, deckOf as yachtDeckOf } from './yachtlooks.js';   // sailing yachts (docs/SAILING-CONTRACT.md §4.5)
import { rigOf } from '../../shared/sail/rigs.js';
```

**SP2** — The monohull yachts use the real deck line of the new model (walls stay inside the plating).

Anchor (**replace** the anchor text with):

```js
export function outlineHalf(cls, L, B) {
  const hb = B / 2, hl = L / 2, pts = [];
```

Replacement:

```js
export function outlineHalf(cls, L, B) {
  if (cls === 'sloop' || cls === 'ketch' || cls === 'schooner') return deckOutlineHalf(cls, 40);   // the lofted yacht hulls (yachtlooks.js)
  const hb = B / 2, hl = L / 2, pts = [];
```

**SP3** — shipDims: the yachts' real freeboard even without a mesh (the node tests build plans from SHIP_CLASSES alone).

Anchor (**replace** the anchor text with):

```js
  const F = ud.freeboard || C.freeboard || Math.max(3, L * 0.045);
```

Replacement:

```js
  const Y = yachtDims(C.id), F = ud.freeboard || (Y ? Y.freeboard : 0) || C.freeboard || Math.max(3, L * 0.045);   // yachts: the §4.2 freeboard (1.25 / 1.45 / 1.9 bridge deck / 1.7)
```

**SP4** — The old fraction table put the schooner's mainmast inside the walk-in doghouse (§1.2 item 2); the new one is computed. The schooner doghouse lands at z +4.4…+9.6 (0.126…0.274 L), cockpit +10.8…+14.4, wheel 0.36 L.

Anchor (**replace** the anchor text with):

```js
const SAIL = {
  sloop: { masts: [-0.12], cockpit: [0.1, 0.45], wheel: 0.34, roof: [-0.24, 0.1] },
  ketch: { masts: [-0.15, 0.3], cockpit: [0.1, 0.45], wheel: 0.34, roof: [-0.24, 0.1] },
  schooner: { masts: [-0.22, 0.12], cockpit: [0.24, 0.46], wheel: 0.36, roof: [0.05, 0.22], doghouse: true },
};
```

Replacement:

```js
/** Yacht deck layout from the model (yachtlooks.js) and the rig (shared/sail/rigs.js): masts, cockpit, wheel, coachroof /
 *  doghouse, the schooner's forward house — so the walker, the rig and the hull agree (§4.5). Fractions of L as before. */
function sailLayout(cls) {
  const R = rigOf(cls), L = R.loa, st = yachtStructures(cls), D = yachtDeckOf(cls);
  const find = (k) => st.find((s) => s.kind === k);
  const ck = find('cockpit'), helm = find('helm');
  const house = cls === 'schooner' ? find('doghouse') : find('coachroof'), dog = cls === 'ketch' ? find('doghouse') : null;
  return {
    masts: R.spars.masts.map((m) => ({ z: m.z, r: m.d0 / 2, h: (m.topmast || m.top) - D.deckY })),
    cockpit: [ck.z0 / L, Math.max(helm ? helm.z1 : ck.z1, R.spars.wheel.at[2] + 1.4) / L], wheel: R.spars.wheel.at[2] / L,   // the helmsman stands aft of the wheel
    roof: [house.z0 / L, (dog ? dog.z1 : house.z1) / L], roofH: Math.max(0.45, (dog ? dog.top : house.top) - D.deckY - 0.05),
    doghouse: cls === 'schooner',
    houses: cls === 'schooner' ? st.filter((s) => s.kind === 'house') : [],   // (the windlass stays a model detail: the foredeck is narrow there)
  };
}
const SAIL = { sloop: sailLayout('sloop'), ketch: sailLayout('ketch'), schooner: sailLayout('schooner') };
```

**SP5** — planSail: cabin sole yD − 2.05 (with the old 3 m freeboard the cabins had 2.1 m; with 1.25 m they would have 0.4 m).

Anchor (**replace** the anchor text with):

```js
  P.style = 'yacht';
  const yC = r2(Math.max(0.75, yD - 2.25)), hC = r2(yD - yC - 0.12);
```

Replacement:

```js
  P.style = 'yacht';
  const yC = r2(yD - 2.05), hC = r2(yD - yC - 0.12);   // §4.5: real yacht freeboard → cabin soles below the waterline (1.9 m headroom)
```

**SP6** — Masts at the rig's z with a solid of radius + 0.15 (the walker circles them); `real: true` = the yacht's own mast stays visible while walking (interior.js IN3). The schooner's forward house becomes a solid (drawn as a low house).

Anchor (**replace** the anchor text with):

```js
  for (const m of S.masts) { const z = m * L; P.prop('mast', { x: 0, z, y: yD, h: L * 1.1, r: 0.12 + L * 0.004, sail: true }); P.solid(-0.2, 0.2, z - 0.2, z + 0.2, yD, 12, 'mast'); }
```

Replacement:

```js
  for (const m of S.masts) { const z = m.z, r = m.r + 0.15; P.prop('mast', { x: 0, z, y: yD, h: m.h, r: m.r, sail: true, real: true }); P.solid(-r, r, z - r, z + r, yD, 12, 'mast'); }
  for (const h of S.houses) { P.solid(-h.half, h.half, h.z0, h.z1, yD, Math.max(0.5, h.top - yD), h.id); if (h.kind === 'house') P.prop('coachroof', { x0: -h.half, x1: h.half, z0: h.z0, z1: h.z1, y: yD, h: h.top - yD }); }
```

**SP7** — Coachroof at the model's height (sloop 0.5 m, ketch doghouse 0.95 m over the deck).

Anchor (**replace** the anchor text with):

```js
    P.prop('coachroof', { x0: -rw, x1: rw, z0: rz0, z1: rz1, y: yD, h: 0.6, hatch: { x0: -sw / 2, x1: sw / 2, z0: sz0, z1: rz1 } });
    if (rw > g + 0.05) { P.solid(-rw, -g, rz0, rz1, yD, 0.6, 'coachroof'); P.solid(g, rw, rz0, rz1, yD, 0.6, 'coachroof'); }
    P.solid(-rw, rw, rz0, sz0 - R - 0.05, yD, 0.6, 'coachroof');
```

Replacement:

```js
    P.prop('coachroof', { x0: -rw, x1: rw, z0: rz0, z1: rz1, y: yD, h: S.roofH, hatch: { x0: -sw / 2, x1: sw / 2, z0: sz0, z1: rz1 } });
    if (rw > g + 0.05) { P.solid(-rw, -g, rz0, rz1, yD, S.roofH, 'coachroof'); P.solid(g, rw, rz0, rz1, yD, S.roofH, 'coachroof'); }
    P.solid(-rw, rw, rz0, sz0 - R - 0.05, yD, S.roofH, 'coachroof');
```

**SP8** — planCat: the catamaran's own hull line (was the sloop's outline squeezed to B·0.2).

Anchor (**replace** the anchor text with):

```js
  const hull = outlineHalf('sloop', L, B * 0.2);
  const hullHalf = (z0, z1) => minHalf(hull, Math.min(z0, z1), Math.max(z0, z1));
  P.half = outlineHalf('sloop', L, B * 0.2);
```

Replacement:

```js
  const hull = deckOutlineHalf('catamaran', 40);              // one hull of the lofted model (yachtlooks.js), centred at x = 0
  const hullHalf = (z0, z1) => minHalf(hull, Math.min(z0, z1), Math.max(z0, z1));
  P.half = hull;
```

**SP9** — planCat: hull rooms under the 1.9 m bridge deck.

Anchor (**replace** the anchor text with):

```js
  P.deck.polys = [[[-px, pz0], [px, pz0], [px, pz1], [-px, pz1]], fullOutline(hull, -hx), fullOutline(hull, hx)];
  const yC = r2(Math.max(0.75, yD - 2.25)), hC = r2(yD - yC - 0.12);
```

Replacement:

```js
  P.deck.polys = [[[-px, pz0], [px, pz0], [px, pz1], [-px, pz1]], fullOutline(hull, -hx), fullOutline(hull, hx)];
  const yC = r2(yD - 2.05), hC = r2(yD - yC - 0.12);   // §4.5: hull soles just above the canoe bottom (bridge deck 1.9 → −0.1)
```

**SP10** — planCat: mast prop and solid at the rig's z −2.7 (= saloon front − 0.6).

Anchor (**replace** the anchor text with):

```js
  P.prop('mast', { x: 0, z: sz0 - 0.6, y: yD + 2.1, h: L * 1.05, r: 0.13, sail: true });
```

Replacement:

```js
  { const m = rigOf('catamaran').spars.masts[0], r = m.d0 / 2 + 0.15;   // the rig's mast on the bridge deck, 0.6 m ahead of the saloon (§4.5)
    P.prop('mast', { x: 0, z: m.z, y: yD, h: m.top - yD, r: m.d0 / 2, sail: true, real: true }); P.solid(-r, r, m.z - r, m.z + r, yD, 12, 'mast'); }
```

**SP11** — Helm spot inside the cockpit for the short sloop cockpit (wheel at z 4.1, deck ends at the reverse transom).

Anchor (**replace** the anchor text with):

```js
  P.hot('helm', 'Take the helm', 0, yD, wz + 0.7, 1.4); P.helm = { x: 0, y: yD, z: wz + 0.7 };
```

Replacement:

```js
  const hz = Math.min(wz + 0.7, cz1 - 0.55);                   // the sloop's open transom: the helmsman stands just aft of the wheel
  P.hot('helm', 'Take the helm', 0, yD, hz, 1.4); P.helm = { x: 0, y: yD, z: hz };
```


### 3. `test/interior.test.mjs`

**TE1** — The one expectation that encodes the old room heights (§4.5 allows updating exactly these).

Anchor (**replace** the anchor text with):

```js
    assert.ok(eng.y >= 0.7, `${cls}: engine room floor ${eng.y} is under the waterline (the sea would show inside)`);
```

Replacement:

```js
    // sailing yachts (docs/SAILING-CONTRACT.md §4.5): real freeboard → soles below the waterline; interior.js hides the sea there
    if (!['sloop', 'ketch', 'schooner', 'catamaran'].includes(cls)) assert.ok(eng.y >= 0.7, `${cls}: engine room floor ${eng.y} is under the waterline (the sea would show inside)`);
    else assert.ok(eng.y < 0.1 && eng.y > -1.0, `${cls}: yacht engine room floor ${eng.y} (below the waterline, above the keel)`);
```


### 4. `public/js/interior.js`

**IN1** — hideExterior: keep the yacht's rig (flag keepWhileWalking) instead of the ShapeGeometry test; hide only the deck / deck-house meshes rigmesh flags walkHide (§4.5).

Anchor (**replace** the anchor text with):

```js
      if (!c.isMesh && hasSail(c)) continue; // sails on their booms
```

Replacement:

```js
      if (c.userData.keepWhileWalking) continue;
      if (c.userData.yacht || String(c.name || '').startsWith('yacht:')) {   // sailing yachts (rigmesh.js): the plan draws deck + houses; hull and rig stay
        for (const k of c.children) if (k.userData.walkHide && k.visible) { k.visible = false; this.hidden.push(k); }
        continue;
      }
      if (!c.isMesh && hasSail(c)) continue; // sails on their booms
```

**IN2** — Ocean hidden while the camera is in a closed room whose floor is below y 0.1.

Anchor (**replace** the anchor text with):

```js
    this.setOcean(!(camRoom && camRoom.dark));
```

Replacement:

```js
    this.setOcean(!(camRoom && (camRoom.dark || (!camRoom.open && camRoom.y < 0.1))));   // §4.5: cabin soles below the waterline — the sea would show through the floor
```

**IN3** — Yacht masts: the real rig mast stays visible while walking (no second cylinder).

Anchor (**replace** the anchor text with):

```js
      case 'mast': { pb.cyl(p.r, p.h,
```

Replacement:

```js
      case 'mast': { if (p.real) return; pb.cyl(p.r, p.h,
```


### 5. `public/js/motion.js`

**MO1** — Steady heel of sail classes = the physics heel (own ship: rig.heel; others: rv / autoTrimView), replacing the windHeel·(U/12)² formula; waves still add roll on top.

Anchor (**replace** the anchor text with):

```js
  if (st.sail && ctx.sails !== false) heel = Math.min(25, st.windHeel * (U / 12) * (U / 12)) * D2R * Math.sign(sinRb) * Math.pow(Math.abs(sinRb), 0.6) * (U > 13 ? Math.pow(13 / U, 1.5) : 1);
```

Replacement:

```js
  const physHeel = st.sail && Number.isFinite(ctx.heelDeg);   // sailing physics heel (rig.heel / rv), + = starboard rail down (§4.4)
  if (physHeel) heel = -ctx.heelDeg * D2R;                   // roll > 0 = heeled to port
  else if (st.sail && ctx.sails !== false) heel = Math.min(25, st.windHeel * (U / 12) * (U / 12)) * D2R * Math.sign(sinRb) * Math.pow(Math.abs(sinRb), 0.6) * (U > 13 ? Math.pow(13 / U, 1.5) : 1);
```

**MO2** — No second gust kick on the physics heel.

Anchor (**replace** the anchor text with):

```js
  if (Ug > U) {
```

Replacement:

```js
  if (Ug > U && !physHeel) {                                 // the sail physics already has its gusts
```

**MO3** — The ±0.5 rad clamp would cut a 33° knock-down to 29°.

Anchor (**replace** the anchor text with):

```js
  heel = Math.max(-0.5, Math.min(0.5, heel));
```

Replacement:

```js
  heel = physHeel ? Math.max(-1.2, Math.min(1.2, heel)) : Math.max(-0.5, Math.min(0.5, heel));   // an overpowered yacht heels past 30°
```


### 6. `public/js/main.js`

**MA1** — Imports.

Anchor (insert **after** the anchor):

```js
import { Autopilot } from './autopilot.js'; // v6 chart-aware autopilot (docs/V6-QUICK-CONTRACTS.md §4.6)
```

Code:

```js
import { SailHud } from './sailhud.js';                        // sailing (docs/SAILING-CONTRACT.md §5)
import { windRelSigned } from './sailfmt.js';
import { rigOf, normalizeRig, applyRigCommand, rigViewOf, unpackRigView, trimInfo, beginManeuver, maneuverStep, authOf, windOverWater } from './sailshared.js';
```

**MA2** — Module helpers.

Anchor (insert **after** the anchor):

```js
const { buildShip, buildWreck } = ShipMod;
```

Code:

```js
/** sailing: the RigView extras for the renderer — apparent wind (flutter), crash-jibe flag, each sail's side */
const rigExtra = (rig) => ({ aws: rig.aws, flags: rig.flags, sides: Object.fromEntries(Object.entries(rig.sails).map(([k, v]) => [k, v.side])) });
/** sailing: merge rig commands queued between two sends (later values win per field and per sail) */
function mergeRigCmd(a, b) {
  if (!a) return JSON.parse(JSON.stringify(b));
  const out = { ...a, ...b };
  if (a.sails || b.sails) { out.sails = { ...(a.sails || {}) }; for (const [id, o] of Object.entries(b.sails || {})) out.sails[id] = { ...(out.sails[id] || {}), ...o }; }
  return out;
}
/** sailing (§5.6): area-weighted flogging / luffing cloth 0…1 for the sound */
function sailFlogOf(s) {
  const R = s?.rig && rigOf(s.cls); if (!R) return 0;
  let a = 0, f = 0;
  for (const d of R.sails) { const t = s.rig.sails[d.id]; if (!t || !(t.hoist > 0.05)) continue; a += d.A * t.hoist; f += d.A * t.hoist * (t.state === 2 ? 1 : t.state === 1 ? 0.35 : 0); }
  return a > 0 ? Math.min(1, f / a) : 0;
}
```

**MA3** — Constructor: the sail HUD.

Anchor (**replace** the anchor text with):

```js
    this.touchHelm = null;
    window.addEventListener('resize', () => this.resize()); this.resize();
```

Replacement:

```js
    this.touchHelm = null;
    // sailing (docs/SAILING-CONTRACT.md §5): instruments + sail panel / phone sheet. Rig commands are applied locally at once
    // (optimistic) and sent at ≤ 4 Hz with a trailing send for sliders (rigCommand)
    this.sailHud = null; this.rigOut = { at: 0, cmd: null, timer: 0 }; this.sailMan = null;
    try {
      const el = document.getElementById('sailhud');
      if (el) this.sailHud = new SailHud(el, { phone: isTouch(), roundButtons: false, onCommand: (cmd) => this.rigCommand(cmd), onManeuver: (k) => this.startManeuver(k), onToggle: (open) => this.touchHelm?.setButtonOn?.('sails', open) });
    } catch (e) { console.warn('[sail] HUD unavailable', e); }
    window.addEventListener('resize', () => this.resize()); this.resize();
```

**MA4** — onYou: own copy of the rig (the spread would share the object with `you`).

Anchor (insert **after** the anchor):

```js
      this.ship = { ...s, throttleCmd: hard ? s.throttle : this.input.throttleCmd, rudderCmd: hard ? 0 : this.input.rudderCmd };
```

Code:

```js
      if (rigOf(s.cls)) this.ship.rig = normalizeRig(s.cls, s.rig, you.sailsUp);   // sailing: the server's rig on a hard sync / correction only; local commands win otherwise (§5.7)
```

**MA5** — New hull: the sail HUD and the phone's Sails / Tack round buttons follow the class.

Anchor (insert **after** the anchor):

```js
        this.myMesh = buildShip(s.cls, you.name, 7); this.scene.add(this.myMesh);
```

Code:

```js
        this.sailHud?.setClass(s.cls); this.touchHelm?.setButtons?.(rigOf(s.cls) ? ['stop', 'auto', 'sails', 'tack'] : ['stop', 'auto']);
```

**MA6** — Keys. After the chart's R (the chart keeps R while it is open) and before the ashore / helm keys.

Anchor (insert **after** the anchor):

```js
      if (k === 'r' && this.hud.chartOpen()) { this.hud.chartMode = this.hud.chartMode === 'region' ? 'world' : 'region'; this.hud.drawChart(); return; }
```

Code:

```js
      if (!this.ashore?.active && this.sailHud?.handleKey(e)) return;   // sailing keys (§0.2): Q Shift+Q 1–7 Shift+1–7 [ ] Ctrl+[ ] = - R Shift+R Z
```

**MA7** — The old Sails: set / furled button drives the rig (all working sails up / all down).

Anchor (**replace** the anchor text with):

```js
    this.myMesh?.userData.setSails?.(up, this.windRel());
```

Replacement:

```js
    if (this.ship?.rig && rigOf(this.ship.cls)) applyRigCommand(this.ship.cls, this.ship.rig, { all: up ? 'set' : 'furl' });   // the server maps the legacy action onto the rig too (§3.4)
    else this.myMesh?.userData.setSails?.(up, this.windRel());
```

**MA8** — The windRel sign bug.

Anchor (**replace** the anchor text with):

```js
  /** Relative wind angle in degrees (0 = on the bow, 90 = from starboard). */
  windRel() { const w = this.localWind || this.wind; const from = Number.isFinite(w?.dir) ? w.dir : normDeg((Math.atan2(-(w?.u || 0), -(w?.v || 0)) * 180) / Math.PI); return normDeg(from - (this.ship?.hdg || 0)); }
```

Replacement:

```js
  /** Relative wind angle in degrees, signed −180…180: + = from starboard, − = from port (§1.2 item 1: it was 0…360, so
   *  setSails' `rel > 0` sent the boom to port for every wind — to windward with the wind from port). */
  windRel() { const w = this.localWind || this.wind; const from = Number.isFinite(w?.dir) ? w.dir : normDeg((Math.atan2(-(w?.u || 0), -(w?.v || 0)) * 180) / Math.PI); return windRelSigned(from, this.ship?.hdg || 0); }
```

**MA9** — New methods.

Anchor (insert **before** the anchor):

```js
  toggleAutopilot() { return this.pilot.engage(!this.autopilot); }
```

Code:

```js
  // ------------------------------------------------------------------ sailing (docs/SAILING-CONTRACT.md §3.4, §5)
  /** A rig command (HUD, keys, autopilot): applied locally at once, sent to the server at ≤ 4 Hz with a trailing send. */
  rigCommand(cmd) {
    const s = this.ship; if (!s?.rig || !rigOf(s.cls) || !cmd) return;
    const r = applyRigCommand(s.cls, s.rig, cmd);
    if (!r.ok) { this.hud.event({ kind: 'warn', text: r.why }); return; }
    const o = this.rigOut;
    o.cmd = mergeRigCmd(o.cmd, cmd);
    const flush = () => { if (o.cmd) { this.net.action('rig', { cmd: o.cmd }); o.cmd = null; o.at = performance.now(); } o.timer = 0; };
    const wait = 250 - (performance.now() - o.at);
    if (wait <= 0) flush(); else if (!o.timer) o.timer = setTimeout(flush, wait);
    if (cmd.all !== undefined && this.you) { this.you.sailsUp = cmd.all === 'set'; this.hud.setSailsButton?.(true, this.you.sailsUp); }
  }
  /** Z / the Tack-Jibe button: the helm swings her to the mirrored true wind angle, the crew handles the sheets (§5.7). */
  startManeuver(kind) {
    const s = this.ship; if (!s?.rig || !rigOf(s.cls) || this.you?.docked) return;
    if (this.autopilot && this.route.length) { this.hud.event({ kind: 'info', text: 'The autopilot tacks on its own — switch it off (P) to tack by hand.' }); return; }
    const ww = windOverWater({ wind: this.localWind || this.wind, current: currentAt(s.lat, s.lon, this.simTime), tideStream: this.tide?.stream || null });
    this.sailMan = {}; beginManeuver(s.cls, { hdg: s.hdg, twd: ww.twd, nowS: this.simTime }, this.sailMan, kind);
    this.rigCommand({ maneuver: this.sailMan.man });
    this.hud.event({ kind: 'info', text: this.sailMan.man === 'tack' ? 'Ready about — helm\'s a-lee!' : 'Stand by to jibe — jibe-o!' });
  }
  maneuverHelm(s) {
    const r = maneuverStep({ hdg: s.hdg, tack: s.rig.tack, helm: s.rig.helm, auth: authOf(s.rig.heel) }, this.sailMan);
    this.input.rudderCmd = r.rudderCmd;
    if (r.done || this.input.left || this.input.right) { this.sailMan = null; if (r.done) this.input.rudderCmd = 0; }
  }
  /** Physics events (rig.ev) → the server: crash jibe (damage only with the helper off, server side), catamaran strain. */
  drainRigEvents() {
    const ev = this.ship?.rig?.ev; if (!ev || !ev.length) return;
    for (const e of ev.splice(0)) {
      if (e.kind === 'crash_jibe') { this.net.action('rig_event', { kind: 'crash_jibe', aws: e.aws }); this.sound?.event('jibe_bang', Math.min(1, (e.aws || 6) / 15)); this.hud.event({ kind: 'warn', text: 'Crash jibe! The boom slammed across.' }); }
      else if (e.kind === 'strain') this.net.action('rig_event', { kind: 'strain' });
    }
  }
  /** Sail HUD at 10 Hz: instruments, panel, the phone's Tack / Jibe label. */
  updateSailHud(now) {
    if (!this.sailHud || now - (this.sailHudAt || 0) < 100) return; this.sailHudAt = now;
    const s = this.ship; if (!s?.rig || !rigOf(s.cls)) return;
    const wp = this.autopilot && this.route[0];
    const twd = windOverWater({ wind: this.localWind || this.wind, current: currentAt(s.lat, s.lon, this.simTime), tideStream: this.tide?.stream || null }).twd;
    this.sailHud.update(trimInfo(s.cls, s, null), { stwKn: s.spd, sogKn: s.spd, cogDeg: normDeg(s.hdg + (s.rig.leeway || 0)), brgDeg: wp ? bearing(s.lat, s.lon, wp.lat, wp.lon) : undefined, leewayDeg: s.rig.leeway, twdDeg: twd });
    this.touchHelm?.setButtonLabel?.('tack', Math.abs(s.rig.twa) < 90 ? 'Tack' : 'Jibe');
  }
  /** Others' and fleet ships' rigs (§3.7): rv from the snapshot at ≤ 15 Hz, else trimmed to the local wind (autoTrimView). */
  updateOtherRigs(now) {
    const w = this.localWind || this.wind, from = Number.isFinite(w?.dir) ? w.dir : normDeg((Math.atan2(-(w?.u || 0), -(w?.v || 0)) * 180) / Math.PI);
    for (const o of [...this.others.values(), ...this.fleetShips.values()]) {
      const ud = o.mesh?.userData; if (!ud?.setRig || now - (o.rigAt || 0) < 66) continue;
      o.rigAt = now;
      const v = o.rv ? unpackRigView(o.cls, o.rv) : null;
      if (v) { ud.setRig(v, { aws: w?.spd || 8 }); o.vis.heelDeg = v.heel; }
      else if (now - (o.sailsAt || 0) > 500) { o.sailsAt = now; ud.setSails(!o.docked && o.state !== 'docked' && o.state !== 'laid_up', windRelSigned(from, o.cur?.hdg || 0)); o.vis.heelDeg = undefined; }
    }
  }
```

**MA10** — simulate(): the sail env (shared/sail/sailphys.js reads simTime, gusts, warp, crewAuto).

Anchor (**replace** the anchor text with):

```js
      fuelEmpty: you.fuelEmpty, grounded: false,
    };
```

Replacement:

```js
      fuelEmpty: you.fuelEmpty, grounded: false,
      simTime: this.simTime, gusts: true, warp,                                // sailing: gust phase, warp (> 20× → the fast path)
      crewAuto: this.autopilot && this.route.length ? 'full' : undefined,      // §3.3: the autopilot sails with the crew on Auto
    };
```

**MA11** — simulate(): the autopilot gets the substep (its sailing clock), the Z manoeuvre steers.

Anchor (**replace** the anchor text with):

```js
      if (this.autopilot && this.route.length) { if (!this.autopilotStep(s, C)) this.input.rudderCmd = 0; }
```

Replacement:

```js
      if (this.autopilot && this.route.length) { if (!this.autopilotStep(s, C, h)) this.input.rudderCmd = 0; }
      else if (this.sailMan && s.rig) this.maneuverHelm(s);                      // the Z button: tack / jibe (§5.7)
```

**MA12** — simulate(): rig events after the substeps.

Anchor (insert **after** the anchor):

```js
    if (aground) this.onGrounding(aground.bump);
```

Code:

```js
    this.drainRigEvents();
```

**MA13** — Pass the substep through.

Anchor (**replace** the anchor text with):

```js
  autopilotStep(s, C) {
    if (this.pilot) return this.pilot.step(s, C);
```

Replacement:

```js
  autopilotStep(s, C, dt) {
    if (this.pilot) return this.pilot.step(s, C, dt);
```

**MA14** — shipVisual: the steady heel from the sail physics (own) or rv (others).

Anchor (insert **after** the anchor):

```js
    ctx.sails = own ? this.you?.sailsUp !== false : true;
```

Code:

```js
    ctx.heelDeg = own ? (this.ship?.rig ? this.ship.rig.heel : undefined) : vis.heelDeg;   // sailing: the physics heel (motion.js MO1)
```

**MA15** — shipVisual: animate the rig of every yacht in view.

Anchor (insert **before** the anchor):

```js
    mesh.userData.setWake?.(Math.abs(spd) / 10);
```

Code:

```js
    ud.updateRig?.(dt, { camera: this.camera, time: this.time, own, touch: document.body.classList.contains('touch') });   // sailing: cloth, springs, LOD
```

**MA16** — loop(): own rig every frame, HUD, others' rigs.

Anchor (**replace** the anchor text with):

```js
    if (this.myMesh.userData.setSails && now - this.lastSails > 500) { this.lastSails = now; this.myMesh.userData.setSails(this.you.sailsUp !== false, this.windRel()); }
```

Replacement:

```js
    if (this.myMesh.userData.setRig && this.ship.rig) this.myMesh.userData.setRig(rigViewOf(this.ship.cls, this.ship.rig), rigExtra(this.ship.rig));   // own ship: the live rig every frame (§3.7)
    else if (this.myMesh.userData.setSails && now - this.lastSails > 500) { this.lastSails = now; this.myMesh.userData.setSails(this.you.sailsUp !== false, this.windRel()); }
    this.updateSailHud(now);
    this.updateOtherRigs(now);
```

**MA17** — upsertOther: keep the snapshot's rv.

Anchor (insert **after** the anchor):

```js
    o.mesh.userData.setWear(1 - p.cond / 100); o.mesh.userData.setFlood(p.flooding);
```

Code:

```js
    o.rv = Array.isArray(p.rv) ? p.rv : null;                                 // sailing: rig view (§3.7)
```

**MA18** — syncFleet: same for fleet ships.

Anchor (insert **after** the anchor):

```js
      o.mesh.userData.setWear?.(1 - (f.cond ?? 100) / 100);
```

Code:

```js
      o.rv = Array.isArray(f.rv) ? f.rv : null;                               // sailing: fleet ships carry rv too
```

**MA19** — Touch helm: Sails and Tack / Jibe round buttons.

Anchor (**replace** the anchor text with):

```js
        onDock: () => this.toggleDock(), onChart: () => this.hud.toggleChart(), onInterior: () => this.toggleInterior(), onCamera: () => this.cycleCamera(), onAshore: () => this.toggleAshore(),
```

Replacement:

```js
        onDock: () => this.toggleDock(), onChart: () => this.hud.toggleChart(), onInterior: () => this.toggleInterior(), onCamera: () => this.cycleCamera(), onAshore: () => this.toggleAshore(),
        onSails: () => this.sailHud?.toggle(), onTack: () => this.sailHud?.maneuver(),   // sailing round buttons (§5.5)
```

**MA20** — Sound state (windRelDeg is already signed here: angleDiff).

Anchor (insert **after** the anchor):

```js
    st.windSpd = wspd; st.windRelDeg = angleDiff(s.hdg, wdir);
```

Code:

```js
    st.sailFlog = sailFlogOf(s);                                            // sailing (§5.6): flapping cloth
```


### 7. `public/js/net.js`

**NE1** — Import.

Anchor (insert **before** the anchor):

```js
const TOKEN_KEY = 'saltline.token';
```

Code:

```js
import { packRigView } from './sailshared.js';               // sailing: the rig view in `state` (docs/SAILING-CONTRACT.md §3.7)
```

**NE2** — rv every 500 ms.

Anchor (**replace** the anchor text with):

```js
    this.send({ t: 'state', lat: s.lat, lon: s.lon, hdg: s.hdg, spd: s.spd, throttle: s.throttle, rudder: s.rudder, vid: this.vid ?? null }); // v6: vid set by main.js onYou
```

Replacement:

```js
    const st = { t: 'state', lat: s.lat, lon: s.lon, hdg: s.hdg, spd: s.spd, throttle: s.throttle, rudder: s.rudder, vid: this.vid ?? null }; // v6: vid set by main.js onYou
    if (s.rig && now - (this.lastRv || 0) >= 500) { const rv = packRigView(s.cls, s.rig); if (rv) { st.rv = rv; this.lastRv = now; } }   // ≤ 2 Hz
    this.send(st);
```


### 8. `public/js/touch.js`

**TO1** — Sail round buttons.

Anchor (**replace** the anchor text with):

```js
const LABELS = { dock: 'Dock', chart: 'Chart', interior: 'Walk', camera: 'Cam', stop: 'STOP', auto: 'AP', ships: 'Ships', more: '…', ashore: 'Shore' };
```

Replacement:

```js
const LABELS = { dock: 'Dock', chart: 'Chart', interior: 'Walk', camera: 'Cam', stop: 'STOP', auto: 'AP', ships: 'Ships', more: '…', ashore: 'Shore', sails: 'Sails', tack: 'Tack' };
```

**TO2**

Anchor (**replace** the anchor text with):

```js
const TITLES = { stop: 'All stop', auto: 'Autopilot (follow the route)', dock: 'Moor / harbour', chart: 'Chart', interior: 'Walk your ship', camera: 'Camera', ships: 'Ships nearby', ashore: 'Go ashore' };
```

Replacement:

```js
const TITLES = { stop: 'All stop', auto: 'Autopilot (follow the route)', dock: 'Moor / harbour', chart: 'Chart', interior: 'Walk your ship', camera: 'Camera', ships: 'Ships nearby', ashore: 'Go ashore', sails: 'Sails: trim, reef, hoist', tack: 'Tack / jibe' };
```

**TO3**

Anchor (insert **after** the anchor):

```js
  setButtonOn(name, on) { this.btns?.querySelector(`[data-action="${name}"]`)?.classList.toggle('on', !!on); }
```

Code:

```js
  /** Relabel a round button (the contextual Tack / Jibe). */
  setButtonLabel(name, text) { const b = this.btns?.querySelector(`[data-action="${name}"]`); if (b && b.textContent !== text) b.textContent = text; }
```


### 9. `public/js/autopilot.js`

**AP1** — Imports (./sailshared.js so test/autopilot-review.test.mjs keeps loading the file).

Anchor (insert **after** the anchor):

```js
import { PILOT, speedCapKn, throttleCap, lookAheadM, firstShoal, offRouteM, shouldReplan, handoverStep, stormOnRoute } from './pilotcore.js';
```

Code:

```js
import { rigOf, anyHoisted, sailCourse, authOf, crossTrackM, HARBOUR_FURL_M, departurePlan, windOverWater, SAIL_KN } from './sailshared.js';   // sailing (docs/SAILING-CONTRACT.md §3.5)
import { currentAt } from '/shared/physics.js';
```

**AP2**

Anchor (**replace** the anchor text with):

```js
  step(s, C) {
    const a = this.app, r = a.route;
```

Replacement:

```js
  step(s, C, dt = 0.05) {
    const a = this.app, r = a.route;
    this.sailClock = (this.sailClock || 0) + (Number(dt) || 0);              // sailing: the ship's own clock for the tactics' leg timers
```

**AP3** — Route mode steering through sailCourse when she is sailing.

Anchor (**replace** the anchor text with):

```js
    a.input.rudderCmd = s.spd < -0.3 ? 0 : clamp(angleDiff(s.hdg, brg) / 25, -1, 1); // going astern the rudder works backwards: amidships
```

Replacement:

```js
    const sailRud = this.sailRudder(s, C, brg, wp);                           // sailing: tack / gybe up- and downwind (§3.5)
    a.input.rudderCmd = s.spd < -0.3 ? 0 : sailRud ?? clamp(angleDiff(s.hdg, brg) / 25, -1, 1); // going astern the rudder works backwards: amidships
```

**AP4** — New method (the leg starts at legFrom, the previous waypoint; the first leg at where she engaged).

Anchor (insert **before** the anchor):

```js
  // ---------------------------------------------------------------------------------------------- steering
```

Code:

```js
  /** Sailing (§3.5): the rudder for a sail class with a sail set — beats / runs in tacks with the helm feed-forward; null = engine steering. */
  sailRudder(s, C, brg, wp) {
    const a = this.app, rig = s.rig;
    if (!C.sail || !rig || !rigOf(s.cls) || !anyHoisted(rig) || a.you?.sailsUp === false || s.spd < -0.3) return null;
    const ww = windOverWater({ wind: a.localWind || a.wind, current: currentAt(s.lat, s.lon, a.simTime), tideStream: a.tide?.stream || null });
    const from = this.legFrom || this.sailFrom || (this.sailFrom = { lat: s.lat, lon: s.lon });
    const mem = this.sailMem || (this.sailMem = {});
    const q = { hdg: s.hdg, brg, distM: haversine(s.lat, s.lon, wp.lat, wp.lon), twd: ww.twd, twsKn: ww.tws / SAIL_KN, stwKn: s.spd, helm: rig.helm, auth: authOf(rig.heel), tack: rig.tack, nowS: this.sailClock, xtM: crossTrackM(s.lat, s.lon, from.lat, from.lon, wp.lat, wp.lon) };
    const out = sailCourse(s.cls, q, mem);
    if (out.maneuver && out.maneuver !== this.sailManeuver) a.rigCommand?.({ maneuver: out.maneuver });   // the crew stands by (jibe guard)
    this.sailManeuver = out.maneuver;
    return clamp(angleDiff(s.hdg, out.hdg) / 25 + out.helmFF, -1, 1);
  }
```

**AP5** — Harbour band furl (helper ≠ off) and the hoist when clear again; with helper off the old warning stays.

Anchor (**replace** the anchor text with):

```js
    if (C.sail && you.sailsUp !== false && Number.isFinite(speedCapKn(best))) {
      if (!this.sailWarned) { this.sailWarned = true; a.hud.event({ kind: 'warn', text: 'Furl the sails for the harbour approach — the autopilot cannot slow a ship under sail.' }); }
    }
```

Replacement:

```js
    const rig = a.ship?.rig && rigOf(a.ship.cls) ? a.ship.rig : null;
    if (C.sail && you.sailsUp !== false && Number.isFinite(speedCapKn(best))) {
      if (rig && rig.auto !== 'off' && best <= HARBOUR_FURL_M) {          // §3.5: the crew furls at the 2,500 m band, the engine takes over at the band throttle
        if (anyHoisted(rig)) { a.rigCommand?.({ all: 'furl' }); this.furledForHarbour = true; a.hud.event({ kind: 'info', text: 'The crew furls the sails for the harbour approach — engine on.' }); }
      } else if (!this.sailWarned) { this.sailWarned = true; a.hud.event({ kind: 'warn', text: 'Furl the sails for the harbour approach — the autopilot cannot slow a ship under sail.' }); }
    }
    if (rig && this.furledForHarbour && best > HARBOUR_FURL_M + 300 && !anyHoisted(rig)) {   // clear of the harbour again: hoist the plan for this wind
      const ww = windOverWater({ wind: a.localWind || a.wind, current: null, tideStream: null }), wp = a.route[0];
      const twa = wp ? angleDiff(bearing(s.lat, s.lon, wp.lat, wp.lon), ww.twd) : 90;
      a.rigCommand?.(departurePlan(a.ship.cls, ww.tws / SAIL_KN, twa)); this.furledForHarbour = false;
      a.hud.event({ kind: 'info', text: 'Clear of the harbour — the crew sets sail.' });
    }
```


### 10. `public/js/ais.js`

**AI1** — AIS sail boats: the signed relative wind (setSails folds any range now, this keeps the intent explicit).

Anchor (**replace** the anchor text with):

```js
      ud.setSails(sailing, wf == null ? 90 : normDeg(wf - v.hdg));
```

Replacement:

```js
      ud.setSails(sailing, wf == null ? 90 : angleDiff(v.hdg, wf));          // signed relative wind (+ = from starboard): sails to leeward
```


### 11. `public/js/sound.js`

**SO1** — Sound state sanitiser.

Anchor (insert **after** the anchor):

```js
  o.windRelDeg = fin(s.windRelDeg);
```

Code:

```js
  o.sailFlog = clamp(fin(s.sailFlog), 0, 1);                                // sailing: flapping / luffing cloth (area-weighted) 0…1
```

**SO2** — Crash-jibe bang (the collision thud, lighter).

Anchor (insert **after** the anchor):

```js
        case 'creak': return !!this._creak(k);
```

Code:

```js
        case 'jibe_bang': return this._gap('jibe', 1.5) && !!this._collision(Math.min(1, 0.35 + 0.5 * k), env);   // sailing: crash jibe
```

**SO3** — Flapping sails modulate the wind voice.

Anchor (**replace** the anchor text with):

```js
    this._set(v.out.gain, lvl, 0.25);
```

Replacement:

```js
    const flog = s.sailFlog > 0.02 ? s.sailFlog * (0.5 + 0.5 * Math.sin(this.ctx.currentTime * 2 * Math.PI * (2.5 + aw / 8))) : 0;   // sailing: cloth flapping at 2–4 Hz
    this._set(v.out.gain, lvl * (1 + 1.6 * flog) + 0.02 * flog, flog ? 0.03 : 0.25);
```


### 12. `public/index.html`

**IX1** — The sail HUD stylesheet (phase-1 file).

Anchor (insert **after** the anchor):

```html
<link rel="stylesheet" href="css/berthguide.css">
```

Code:

```html
<link rel="stylesheet" href="css/sail.css">
```

**IX2** — The HUD root.

Anchor (insert **after** the anchor):

```html
  <div id="touchHelm" aria-label="Touch helm"></div>
```

Code:

```html
  <!-- Sailing instruments + sail panel / phone sheet: filled by sailhud.js (hidden for engine classes) -->
  <div id="sailhud" class="hidden" aria-label="Sailing instruments and sail trim"></div>
```


## 4. Validation (2026-10-09, scratch copy with every edit above applied)

- All 58 edits applied mechanically (each anchor found exactly once) by `…/scratchpad/laneb/gen_phase2.py apply <tree>`
  (the same script wrote §3 from the live files: `gen_phase2.py doc <tree> <out.md>`); `node --check` on every edited file.
- `node --test` on the patched copy: `sail-*` (Lane A), `sailviz-*` (incl. `sailviz-plan`, un-skipped: 3/3),
  `interior`, `interior-review`, `autopilot-review` (loads the patched `autopilot.js` through its import rewrite),
  `ais`, `telegraph`, `warp`, `timemodel`, `fleet-client`, `pilot`, `berthguide`, `game`: **259 pass, 0 fail** (11 skipped: Lane A's own phase-2 tests waiting for P1–G12)
  (`warp` needs `data/` world files: copied read-only into the scratch tree).
- Browser smoke (patched `ship.js` through the real module graph, swiftshader): `buildShip` for sloop, ketch,
  catamaran, schooner and a coaster; no errors; `setSails(true, 270)` (legacy 0…360 value, wind from port) puts every
  sail to **starboard**; an `rv` round trip (`packRigView` → `unpackRigView` → `setRig`) renders on the received side;
  `freeboard` 1.25 / 1.45 / 1.9 / 1.7, catamaran beam 7.5; screenshot `pw/sail/shots/desk-phase2-smoke-shipjs-lineup.png`.

## 5. Measured (phase 1, harness)

| | sloop | ketch | catamaran | schooner | contract §4.6 |
|---|---|---|---|---|---|
| own ship (desktop, ≤ 40 m) | 7.6 k tris, 22 calls | 8.8 k, 24 | 11.3 k, 28 | 12.4 k, 32 | ≤ 14 k, ≤ 40 |
| own rig update (springs + cloth + lines), headless CPU | 0.6–0.8 ms | 0.6 ms | 0.3 ms | 0.6–1.2 ms | ≤ 0.6 ms mid phone (phones use the 8 × 10 grid, no cylinders) |
| other ship ≤ 300 m | 684 tris, 5 calls | 876, 5 | 1300, 6 | 1296, 8 | ≤ 3 k, ≤ 12 |
| 300 m – 2 km | 126, 4 | 130, 4 | 198, 4 | 136, 4 | ≤ 200, ≤ 4 |

Clearances (rigcore `mastClearances` / `boomSweep`, boom axis over the structure top / the walkable deck, every swing
angle to dmax both sides): sloop main 1.12 m over the sprayhood, 1.90 m over the side deck abeam of the mast; ketch main
1.09 over the doghouse, 1.90 over the deck, mizzen 2.25; catamaran 0.58 over the hardtop / saloon roof, 2.6 over the
bridge deck; schooner fore 1.43 over the forward house, 2.09 over the deck (the contract's "tightest, 2.1 m"), main 1.31
over the doghouse. Mast feet to the nearest house: ketch main 0.49 m, catamaran 0.48 m, schooner main 1.36 m (it was
*inside* the doghouse), fore 2.89 m; the sloop's mast stands on the coachroof (`onRoof`).

## 6. API for the phase-2 callers

- `ship.js` group `userData` (yachts): `isSail`, `yacht` (the rigmesh object), **`setRig(view, extra)`** (`view` =
  RigView from `rigViewOf` / `unpackRigView` / `autoTrimView`; `extra` = `{ aws, flags, sides: {id: ±1}, snap }` — `flags`
  bit 4 = crash jibe: the boom crosses at 180°/s then wobbles; `snap` = no animation (teleport); the first view after
  building always snaps), **`setSails(up, rel)`** (legacy, any angle range), **`updateRig(dt, { camera, time, own, touch })`**
  every frame (picks the LOD from the camera distance; `own` = the full model). Also `yacht.stats()` (triangles / calls)
  and `yacht.frame` (the last rigcore frame: booms, sheets, telltales …).
- `SailHud`: `setClass(cls)`, `update(trimInfo, { stwKn, sogKn, cogDeg, brgDeg, leewayDeg, twdDeg })` (10 Hz is
  plenty), `toggle(open?)`, `isOpen()`, `maneuver()`, `handleKey(e)` → true when consumed, `setPhone(bool)`.
- `sailfmt`: `keyAction`, `actionToCommand`, `trimAllCommand`, `adviceOf`, `windRelSigned`, zones / colours, sliders.
- `rigcore` (pure, node): `rigFrame(cls, view, { t, aws, angles })`, `sailParams`, `sailPoint`, `sailGrid`,
  `telltales`, `reefPoints`, `stowedOf`, `standingRigging`, `boomPose`, `springStep`, `crashStep`, `mastClearances`,
  `boomSweep`. `yachtlooks` (pure): `deckHeightAt`, `structures`, `deckOutlineHalf`, `yachtDims`, `LOOKS`.

## 7. Contract notes (deviations found while building; numbers of §2 unchanged)

1. **Catamaran boom over the saloon roof.** With the frozen boom (gooseneck y 4.5) and the §4.2 roof (3.9) the boom
   clears the saloon roof / hardtop by 0.58 m, not 1.0 m — as on real cruising cats (nobody stands there under sail).
   The test asks ≥ 0.5 m for the catamaran's roofs, ≥ 1.0 m for every monohull house.
2. **Clearances are measured from the boom axis** (gooseneck height − deck height), which is how the contract's own
   example ("3.9 m over a 1.82 m deck … 2.1 m") is computed.
3. **Deck heights at the masts** follow the frozen mast feet (ketch 1.55 / 1.40, schooner 1.82 / 1.70): the sheer lines
   are splines through them (schooner 2.3 at the bow, 1.62 lowest at z +3, 1.9 at the stern; ketch 1.75 / 1.45 / 1.36;
   sloop 1.45 / 1.25 / 1.15). Mid-ship freeboards are the §4.2 values.
4. **Bobstay and whiskers**: the frozen ends ([0, 0.3, −17.0], [±1.9, 2.5, −17.5]) lie 3 m ahead of the 3.5 m clipper
   stem; the renderer snaps them onto the stem / bow (rigcore `onHull`). The split backstay lands on the reverse transom.
5. **Schooner rudder** is drawn on the sternpost at z +12.0…+12.9 under the counter (the physics' `zr` 15.2 lies under
   the counter, in the air); visual only.
6. **Schooner topsails / flying jib**: Lane A note 2 (L0 has no light sails) — the screenshots hoist them by hand.
7. **Catamaran deck**: hull decks 1.35 forward rising to the 1.9 bridge-deck level at z −3.1 (one flush deck aft, as
   on real cruising cats); trampoline at 1.55 (−6.2…−3.1; the saloon front is −2.1, the mast stands on the bridge deck
   at −2.7). The deck plan keeps its foredeck at bridge-deck height (the walker on the net floats 0.4 m) — a stair
   down to the net would need a plan rework; reviewer's call.
8. **Cabin soles** `yD − 2.05` (§4.5): sloop −0.75, ketch −0.55, schooner −0.30, catamaran hulls −0.10. The sloop's
   sole is below its 0.5 m canoe body (in the model it would sit in the keel sump) — invisible from inside; IN2 hides the
   sea in closed rooms below y 0.1.
9. **Test names**: `test/sailviz-*.test.mjs` (as the lead asked) for the contract's `test/sail-client-*`.
10. **Telltales** are red to port and green to starboard (the real convention), so a windward / leeward ribbon changes
    colour with the tack; the main carries leech telltales only (§4.3).
11. **Sail numbers** are painted mirrored in the texture so they read correctly from starboard (one cloth, both faces).
12. **Twist beyond the shrouds**: Lane A's `twistFor` gives a fully eased gaff sail 20° of twist (δ 80 → 100° at the
    head); the renderer stops each row at `dmax + 8°` (the shrouds) so the peak never swings forward of the beam.

## 8. Lane A finding (for the reviewer)

**Helm spike when the sail side force crosses zero.** `sailphys.js` full path: `zce = a.HM / Math.max(a.Fn, 1e-6) −
R.zclr`, then `hull(… Fx, zce)` uses `Fx·zce` in the weather-helm moment. When `Fn` passes through ~0 (head to wind in
every tack, dead downwind in a jibe) `HM` does not (windage has its own lever), so `zce` → ±∞ for one step and the
smoothed helm `H` jumps to thousands (harness: sloop tacking at 12 kn, H = 7,091 one step after TWA ≈ 0; ketch
jibing, H = −198). The yaw term clamps H to ±1.5, but H then needs ~8 s (τ = 1 s) to decay, so a boat that has just
tacked is pushed hard for seconds and the HUD helm bar reads "rounding up!". The steady states (polars, VPP) are
unaffected (they always have a large `Fn`). Suggested fix (one line, game step only):
`const zce = clamp(a.HM / Math.max(a.Fn, 1e-6) - R.zclr, 0, R.spars.masts.reduce((m, x) => Math.max(m, x.topmast || x.top), 0));`
(and the same clamp in `vpp.js evalV` if the reviewer wants both paths identical).

Also seen: a catamaran started **from rest** close-hauled (12 kn, 50°, plan L0 with the code 0) settles on the low
root (1.6 kn, large lee helm) — physically right (a cat must bear away to build speed); the tactics' "build speed" rule
covers the autopilot, a human bears away. The harness starts every scenario at 80 % of the polar speed.

## 9. Harness and screenshots (phase 1)

`node …/scratchpad/pw/sail/server.mjs 3271` serves `public/` at `/`, `shared/` at `/shared`, three at `/vendor` and the
harness at `/harness/` (port 3270–3279 only; `server.mjs 3272 <tree>` serves another tree, e.g. the phase-2 scratch copy).
`JOBS="$(cat jobs-all-desk.json)" node shoot.mjs 3271` writes `shots/desk-*.png` (1440×900), `jobs-phone.json`
→ `shots/phone-*.png` (390×844 @2x). The page runs `stepSail` live (20 Hz substeps), a wind slider (TWS / TWA), helper
level, scenarios (close-hauled, beam reach, run, overpowered with a free helm — she rounds up, luffing, flogging,
reefed), Tack / Jibe (the wind swings through the bow / stern; the physics flips the sails, the springs swing the
booms), cameras (quarter, lee, bow, aft, top, deck, sails); `window.H` drives it (`setup`, `advance`, `frames`,
`maneuver`, `lod`, `others`).
