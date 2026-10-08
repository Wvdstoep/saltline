# Saltline v7 batch 1 — build contract (docking score, anchoring, pilot jobs on live AIS, harbour passport)

Design contract, 2026-10-08 (written 14:00–15:00 UTC). Covers V7-PLAN item **2** (skill-graded harbour work) and the
**harbour passport** of item 9. Built in parallel with v0.5 wave 2 (`docs/V5-WAVE2-DESIGN.md`) after the v6 quick items
(`docs/V6-QUICK-CONTRACTS.md`) have merged.

| § | Package | One line |
|---|---|---|
| 2 | **DOCK** (docking score) | Every mooring under your own power is graded A+…F from the server's own samples (contact speed, distance off the berth, angle, time from 300 m, clean approach, engine orders); a results card with the parts, a small bonus, a personal best per harbour and a replay of the approach on the mini harbour plan. Tug assists show as "assisted". |
| 3 | **ANCHOR** (anchoring + seamarks) | Drop and weigh anchor (Q / button) in water up to 60 m when slow; the ship lies to her chain and swings with wind and tide; holding against load by bottom type and scope; the anchor drags in a blow with an alarm and a drag track; anchor watch; 5× warp at anchor; no wages, fuel or wear for a ship lying at anchor with the engine stopped; anchorages and pilot stations from OSM seamarks (synthetic where OSM has none) on the chart. |
| 4 | **PILOT** (pilot jobs on live AIS) | A pilot boat near a pilot station is offered real ships arriving over live AIS (class A, > 80 m, under way, bound for that harbour). Intercept her before she passes the station, come alongside on her lee side, match course and speed for 30 s while the pilot climbs the ladder, earn the pilotage fee. One pilot per ship; no AIS, no jobs. |
| 5 | **PASSPORT** | A stamp per harbour you arrive in (moored, docked or landed), with harbour, country, date and first ship; a passport page with counts and four badges (5 / 25 / all 86 harbours, all 41 countries). Stored per person, not per ship. |

§1 is common ground (rules, timing against the two other trees, file ownership, the hook layer, money, saved state,
protocol). §6 is the integration plan, §7 the decisions built as written, §8 the questions only the player can answer.

**Critic pass (2026-10-08, 15:00–16:00 UTC) — what changed against the first draft.** (1) The 26 inline hooks in
functions wave 2 and v6 also edit are replaced by around-advice from two new hook files (§1.5, §1.6): v7 now edits no
function of another tree. (2) v7's saved data moved into its own file (§1.8), so no wave 2 file (`VESSEL_KEYS`,
`PlayerRecord`) has to change. (3) Anchoring was unplayable near most harbours: the synthetic sea bed is 155 m deep 6 km
off the Maas; charted anchorages now carry a charted depth, small craft carry 60 m of chain, and the current load uses a
ship lying head to the stream (§3.2). (4) Pilot jobs compared speed through the water with AIS speed over ground and
assumed 22 kn in any sea; both fixed, plus the job's ship is always sent to her pilot boat (§4.2). (5) The docking
score's anti-cheat speed now removes the current, so a ship lying still in a tidal basin is not marked as hitting the quay
at 1.5 kn (§2.2). Smaller fixes are marked in place.

Root: `/tmp/claude-0/-home-user/0e451cf3-a540-5510-b1a6-978d07bae2ed/scratchpad/saltline`. Line numbers drift (the
TIME-MODEL merge moved `server/game.js` from 1,884 to 1,958 lines during this design); **every hook is named by
function and by the statement it sits next to**, never by line number.

Read with: `docs/V7-PLAN.md`, `docs/V5-WAVE2-DESIGN.md` (§4.2 vessel view, §4.3 ledger, §9 build plan),
`docs/V6-QUICK-CONTRACTS.md` (§1.3 ownership, §2 WARP-HARBOUR, §5 TIME-MODEL), `docs/ARCHITECTURE.md`, `docs/STATUS.md`.

---

## 1. Common ground

### 1.1 Rules for every package

- **Node 20, no new npm dependencies, no `node:sqlite`.** Plain ESM, `node:` built-ins only. Server persistence stays
  the game's state file (today `data/state.json` via `Game.saveState`; after wave 2 its store). Caches go to their own
  files under `DATA_DIR` (written to `<file>.<pid>.tmp` and renamed, the `saveCachedOSM` pattern).
- **Client:** three.js r160, plain ESM, no build step. Logic the tests must reach lives in `shared/` (served at `/shared`,
  importable by Node and the browser) or in an import-free client module (the `public/js/berthplan.js` pattern).
- **Tests:** `node:test` + `node:assert/strict`, files `test/*.test.mjs` (picked up by `npm test`'s glob). Game tests
  construct `new Game(world, () => {}, { stateFile: '/nonexistent/saltline-<name>-state.json', … })`, stub
  `g.saveState = () => {}`, set `g.rnd = () => 0.5` (no hails, no inspections, no storms) and drive `g.tick(0.1)`.
  Copy helpers out of the existing tests — `fakeSocket`, `join`, `mkBerth`, `fakeGeom`, `fakeTraffic` from
  `test/game.test.mjs`; `atSea` from `test/jobs.test.mjs` or `test/timemodel.test.mjs`; `synthPatch`, `patchGeom` from
  `test/tugs.test.mjs` — never import from another test file. Game-level v7 tests call `installV7(g, { packages, ais })`
  **after** stubbing `g.saveState` and `g.rnd` (§1.5). Tests that
  need the cached Rotterdam geometry skip when `data/geom/rotterdam.{json,bin}` is missing (the `haveRot` pattern).
- **Never edit** `docs/*.md` (the integrator updates ARCHITECTURE and STATUS), `public/index.html` (all new DOM is
  created at runtime) or `public/css/style.css` (each package ships its own CSS file and injects it with a private copy
  of the four-line `ensureCss(id, href)` from `public/js/telegraph.js`).
- **No edits in another tree's functions.** v7 reaches into `game.js`, `main.js`, `hud.js` and `chart.js` only through
  the advice layer of §1.5/§1.6; a handler that throws is logged once and skipped, a package that failed to install or
  load is simply absent, and the host method always runs. Client modules load with the `import().then().catch()`
  pattern of `berthguide.js` and `tugs.js`.
- **Player-facing text:** plain English, numbers like the rest of the HUD (`toLocaleString('en-US')`, `fmtDistance`,
  `°` true bearings padded to three digits, knots with one decimal). Every refusal says what to do instead.
- **Server-authoritative:** scores, anchor positions, drag, offers, boarding and money are decided on the server. The
  client draws and predicts.

### 1.2 Timing: three trees in one working copy

| Tree | State on 8 Oct 14:00 UTC | Rule for v7 batch 1 |
|---|---|---|
| v0.5 wave 1 (telegraph, berth guidance, tugs, interior) | merged and deployed | its files are ordinary shared files now; v7 touches only the lines in §1.5/§1.6 |
| v6 quick items | WARP-HARBOUR and AUTOPILOT-CHARTS merged; TIME-MODEL merging now (`advanceShipClock` landed in `game.js` at 13:58); WORLD-MARKET not yet | **Phase B of v7 starts only after all four v6 packages are merged and `npm test` is green.** v7 edits functions v6 owned (the warp section, `setVoyage`); they are free once v6 has merged. |
| v0.5 wave 2 (company, bank, crew, ships, parts, store) | design done; phase A (new files) about to start | built **in parallel** with v7. Wave 2's phase B edits `server/game.js`, `server.js`, `main.js`, `hud.js`, `sound.js`. v7 edits **no function** wave 2 edits (§1.5): its only lines in those files are new top-level statements in `server.js` and the last line of `main.js` (§1.6). |

Phases (the wave 2 pattern):

| Phase | When | What |
|---|---|---|
| A | now | **New files only** (§1.4) with their own unit tests, including the two hook files (integrator, verbatim §1.5/§1.6). Nothing in the existing code imports them yet. Modules are constructed by the tests themselves; game-level tests call `installV7` with an explicit `packages` list. |
| B | after v6 quick is merged and green; independent of wave 2 | One package at a time in the order **PASSPORT → DOCK → ANCHOR → PILOT** (smallest first; ANCHOR brings the seamark index PILOT's boarding points come from): its import line and entry in `PACKAGES` (server/v7hooks.js), its direct edits of §1.6. The first package also adds the two core lines to `server.js` and the last line of `main.js`. Each package runs `npm test` before the next merges. |
| C | after B (and after wave 2's phase B, if it lands the same day) | `test/v7-integration.test.mjs`, the cross-package checks (§6.3), the wave 2 cross-checks (§6.4), browser checks, docs by the integrator, one push, one deploy. |

**Order against wave 2's phase B: none needed.** The two trees share no function, so their phase B steps may run at
the same time in the same working copy. The one order-dependent line is the money fallback of §1.7 (the integrator
deletes it when W2-SERVER merges). Phase C runs after both. The v6 gate stays: v7 advises v6 methods (the warp section,
`setVoyage`, `setWarp`, `updateWarp`, chart `draw`), so their final names and arguments must be merged first.

### 1.3 Existing APIs used (read-only)

| API | File | Used by | Contract relied on |
|---|---|---|---|
| `dock(p)`, `finishDock(p, harbor)`, `moorAt(p, harbor, b)`, `setDocked(p, id, berth)` | server/game.js | DOCK, ANCHOR, PASSPORT | `dock` decides the berth, then `moorAt` snaps the ship to the berth point (the snap destroys the approach position, so DOCK captures before it). Every arrival (manual, tug assist, legacy walk, tow) ends in `finishDock`; impound, forced reset and rescue landing call `setDocked` only. |
| `tugAssist(p)`, `stepTugAssist(game, p, dt)` | game.js, tugassist.js | DOCK | the assist sets `p.assist` in `tugAssist`; arrival goes through `game.finishDock`. |
| `collision(p, m)`, `grounding(p)` | game.js | DOCK, PILOT | counted contacts only (≥ `FEES.COLLISION_MIN_KN`, rate-limited 3 s / 4 s). |
| `onState(p, m)` | game.js | DOCK, ANCHOR | the accepted position, heading, speed (through the water) and **actual** throttle of the client's ship at ~10 Hz; rejected states return early. |
| `p.shipTime`, `shipRate(p)` | game.js (TIME-MODEL) | DOCK | the ship's clock in seconds; runs `warp` times faster when warped. Fallback `Date.now() / 1000` if absent. |
| warp section: `warpOf`, `warpConditions`, `warpBlock`, `checkWarp`, `capWarp`, `dropWarp`, `warpLimit`, `harbourZone`, `nearestOtherSkipper` | game.js (WARP-HARBOUR) | ANCHOR, PILOT | as merged; ANCHOR adds lines (§3.4). |
| `weatherAt(lat, lon)` → `{ wind: {u, v, spd, dir}, waves: {height, dir}, storm, … }`, `currentAtPos(lat, lon)` → `{u, v}` (current + tidal stream) | game.js | ANCHOR | the same environment the client's `stepShip` gets. |
| `world.depthAt(lat, lon)` (m, positive = water), `world.isWater`, `landPenetration(lat, lon)` (null off-patch, 0 in water, > 0 m inside an obstacle), `geom.maskAt(id, lat, lon)`, `geom.getHarborPatch(id)`, `geom.getHarborGeom(id)` (`anchor`, `fairway`, `berths`) | world.js, harborgeom.js | ANCHOR, DOCK | as today. |
| `gridFromPatch(buf)`, `toXZ`, `inGrid`, `bedAt` | server/tugpath.js | ANCHOR | the patch bed height (negative under water) for depth on a built patch. |
| `stepShip(s, input, env, dt)` | shared/physics.js | ANCHOR | **unchanged.** The anchor is a constraint applied after it (§3.3). Velocity = forward·spd + current + tidal stream + 2 % wind. |
| `THROTTLE_MIN`, `ORDERS` | shared/telegraph.js | DOCK, ANCHOR | −0.6 … 1. |
| `LiveAis.near(lat, lon, rangeM, { limit })` → AisPublic[] dead-reckoned to now, nearest first; `get(mmsi)`; `offline`; `store.size`; `store.upsertPosition/upsertStatic` (debug only) | server/ais/index.js, store.js | PILOT | AisPublic fields: `id ('ais'+mmsi), mmsi, name, cls, flag, lat, lon, sog, cog, hdg, nav (text; 'class B' for class-B transponders), navStatus (0–15 / null), length, beam, draught, off ([m ahead, m to starboard] of the hull centre from the antenna) , dest (a HARBORS id when the destination resolves to a game harbour), destName, t (ms of the last report)`. Dead reckoning is capped at 180 s. |
| `app.aisLayer.others({ rangeM })`, `contacts()`, `info(v)` | public/js/ais.js | PILOT | real hulls at real size for collisions, radar and the info card. |
| `app.berthGuide.info`, `app.geoms.get(id)` (entry: `n, res, mask, origin`) | berthguide.js, harborgeom.js | DOCK | the mini plan's patch raster. |
| `planBase(entry)`, `PLAN_COL` | public/js/berthguide.js | DOCK | **one new export line** (§1.6), no behaviour change. |
| `app.pilot.engage(false)` (the autopilot — not the pilot jobs!) | public/js/autopilot.js | ANCHOR | switches the autopilot off when the anchor goes down. |
| `waveSpeedLoss(hdg, waveH, waveDir)` | shared/physics.js | PILOT | the same wave speed loss `stepShip` applies (for the pilot boat's reachable speed, §4.2). |
| `app.hud.chart`: `layers`, `ctx`, `project(lat, lon)`, `mPerPx(lat)`, `zoom`, `ensurePopup()` (popup body `.popBody`) | public/js/chart.js | ANCHOR, PILOT | chart drawing from the `draw` after-advice (there is no `chart.drawAnchor`; ANCHOR draws its own glyph). |
| `hud.event`, `hud.alert/clearAlert`, `hud.prompt`, `sound.event('anchor')`, `sound.ui('cash' / 'warn' / 'open')` | hud.js, sound.js | all | as today. `sound.event('alarm')` exists once wave 2's W2-CLIENT has merged; until then `sound.ui('warn')`. |

### 1.4 File ownership — new files

Each new file belongs to exactly one package. None of these names exists in the tree, in wave 2's plan or in v6's.

| Package | Server | Shared (browser-safe, no DOM) | Client | Tests and data |
|---|---|---|---|---|
| DOCK | `server/dockscore.js` | `shared/dockscore.js` | `public/js/dockcard.js`, `public/css/dockscore.css` | `test/dockscore.test.mjs` |
| ANCHOR | `server/anchorage.js`, `server/seamarks.js`, `scripts/fetch-seamarks.mjs` | `shared/anchor.js` | `public/js/anchor.js`, `public/css/anchor.css` | `test/anchor.test.mjs`, `test/seamarks.test.mjs`, `test/fixtures/seamarks/overpass-sample.json`; cache dir `data/seamarks/` |
| PILOT | `server/pilotage.js` | `shared/pilotmath.js` | `public/js/pilotjobs.js`, `public/css/pilotjobs.css` | `test/pilotage.test.mjs` |
| PASSPORT | `server/passport.js` | `shared/passport.js` | `public/js/passport.js`, `public/css/passport.css` | `test/passport.test.mjs`, `docs/fixtures/passport.sample.json` (written by the test, read by `?fixture=passport`) |
| (shared, verbatim §1.7) | `server/v7money.js` | | | — created by whichever of DOCK / PILOT lands first |
| integrator (core, phase A) | `server/v7hooks.js` (§1.5) | | `public/js/v7hooks.js` (§1.6) | `test/v7hooks.test.mjs`; phase C `test/v7-integration.test.mjs` |

Instance names (chosen to avoid the existing `app.pilot` = autopilot): server `game.v7hooks`, `game.dockScore`,
`game.anchors`, `game.seamarks`, `game.pilotage`, `game.passports`, `game.ais`; client `app.v7hooks`, `app.dockCard`,
`app.anchorUi`, `app.pilotJobs`, `app.passportUi`. Installers: `installDock` (server/dockscore.js), `installPassport`
(server/passport.js), `installPilot` (server/pilotage.js), `installAnchor` (server/anchorage.js); client
`installDockCard`, `installPassportUi`, `installPilotJobs`, `installAnchorUi` in the four client modules.

### 1.5 Hooks without edits — `server/v7hooks.js` (around-advice)

**Rule: no function is edited by two trees.** Wave 2's phase B edits the `game.js` functions of V5-WAVE2 §9.3 and §4.8
(constructor, `loadState`, `saveState`, `findOrCreatePlayer`, `connect`, `disconnect`, `onState`, `onAction`, `dock`,
`finishDock`, `undock`, `tugAssist`, `collision`, `grounding`, `setFishing`, `tick`, `sink`, `expressPassage`,
`privateState`, `publicState`, `sendHarbor`, `finishRescue`, every money site, …) and the `main.js` / `hud.js` /
`sound.js` functions of §9.4. The v6 packages own the warp section, `setDocked`, `setVoyage`, `tow`, `stepAssist`,
`main.js` `stepWarp`/`setWarp`, `hud.js` `updateWarp`, and chart.js `layers` / `draw()` / `showHarborPopup`
(V6-QUICK §1.3). **v7 edits none of these functions, in any phase.** (The first draft of this contract had 26 inline
hooks with "merge rules" for the functions both trees edit; that is exactly the collision the parallel plan forbids, and
a one-line v7 insert in a function wave 2 is rewriting at the same time breaks either agent's exact-string edits.)

Instead every v7 behaviour inside those functions enters through **around-advice**: at start-up `installV7(game, …)`
replaces each advised method **on the instance** with a wrapper that runs the packages' `before` handlers, then the
original method (whatever wave 2 or v6 made of it), then the `after` handlers. v7 depends only on the method names,
their arguments and the few fields in the "relies on" column below. Internal calls (`this.finishDock(…)`,
`this.checkWarp(p)`) and `server/tugassist.js` (`game.moorAt`, `game.finishDock`) resolve to the instance property and go
through the wrapper. `server/game.js` itself gets **no v7 line at all** — wave 2 and v6 can merge before, after or while
v7 merges.

`server/v7hooks.js` — written by the integrator in phase A, verbatim; afterwards each package adds only its own import
line and its own `PACKAGES` entry, in its phase B step:

```js
// v7 batch 1 — the hook layer (docs/V7-BATCH1-CONTRACTS.md §1.5). v7 never edits a Game method; it advises them.
import fs from 'node:fs';
import path from 'node:path';
// phase B: each package adds ONE import line above and ONE entry here. Order = handler order (see below).
export const PACKAGES = [
  // ['dock', installDock], ['passport', installPassport], ['pilot', installPilot], ['anchor', installAnchor],
];
export const STOP = Symbol('v7.stop');
export const stop = (value) => ({ [STOP]: true, value });
/** The saved v7 fields of a person: one non-enumerable object, so neither saveState's {...p} nor wave 2's PlayerRecord
 *  serialise it — v7 keeps it in its own file (§1.8). */
export function v7of(p) {
  if (!Object.prototype.hasOwnProperty.call(p, 'v7')) Object.defineProperty(p, 'v7', { value: {}, writable: true, enumerable: false, configurable: true });
  return p.v7;
}
// Advised Game methods → what the wrapper records before the original runs (`pre` for the after handlers).
export const ADVISED = {
  connect: null, onState: null, onAction: null, setDocked: null, moorAt: null, dock: null, finishDock: null,
  tugAssist: (p) => p.assist || null, collision: (p) => p.lastCollision || 0, grounding: (p) => p.lastGrounding || 0,
  setFishing: null, expressPassage: null, setVoyage: null, sink: null, finishRescue: null, tick: null,
  privateState: null, publicState: null, sendHarbor: null, saveState: null,
  warpConditions: null, warpBlock: null, checkWarp: null, warpLimit: null,
};
export class V7Hooks {
  constructor(game, log) {
    this.game = game; this.log = log; this.h = { before: {}, after: {} }; this.running = new Map();
    this.failed = new Set(); this.fields = new Map(); this.harborFns = []; this.rate = new Map();
  }
  on(when, method, fn, { first = false } = {}) {
    if (!(method in ADVISED)) throw new Error(`v7: ${method} is not an advised method`);
    const l = (this.h[when][method] ||= []); if (first) l.unshift(fn); else l.push(fn);
  }
  /** A v7 action: handled here, never reaches the game's switch; ≤ 5 v7 actions per second per player. */
  action(name, fn) {
    this.on('before', 'onAction', (p, m) => {
      if (m?.action !== name) return undefined;
      if (this.allow(p)) { try { fn(p, m); } catch (e) { this.fail(`action ${name}`, e); this.game.event(p, 'warn', 'That did not work.'); } }
      return stop();
    });
  }
  allow(p) { const now = Date.now(), r = this.rate.get(p.id) || { t: now, n: 0 }; if (now - r.t >= 1000) { r.t = now; r.n = 0; } r.n++; this.rate.set(p.id, r); return r.n <= 5; }
  active(method) { return this.running.get(method); }      // first argument of `method` while its original runs
  field(key, heal) { this.fields.set(key, heal); }          // saved person field: heal(value, p) → value to keep, or null
  harbor(fn) { this.harborFns.push(fn); }                   // fn(p, harborId) → fields merged into `harbor_v7`
  fail(where, e) { if (!this.failed.has(where)) { this.failed.add(where); this.log(`[v7] ${where} advice failed: ${e?.stack || e}`); } }
  sendHarborV7(p) {
    const id = p.docked; if (!id) return;
    const out = { t: 'harbor_v7', harbor: id };
    for (const fn of this.harborFns) { try { Object.assign(out, fn(p, id)); } catch (e) { this.fail('harbor_v7', e); } }
    this.game.send(p, out);
  }
  wrapAll() {
    const hooks = this, game = this.game;
    for (const name of Object.keys(ADVISED)) {
      if (typeof game[name] !== 'function') continue;
      const orig = game[name].bind(game), preOf = ADVISED[name];
      game[name] = function v7advised(...args) {
        for (const fn of hooks.h.before[name] || []) {
          let r; try { r = fn(...args); } catch (e) { hooks.fail(name, e); continue; }
          if (r && r[STOP]) return r.value;
        }
        const pre = preOf ? preOf(args[0]) : undefined;
        const outer = !hooks.running.has(name); if (outer) hooks.running.set(name, args[0]);
        let result;
        try { result = orig(...args); } finally { if (outer) hooks.running.delete(name); }
        for (const fn of hooks.h.after[name] || []) {
          try { const r = fn({ result, pre }, ...args); if (r !== undefined) result = r; } catch (e) { hooks.fail(name, e); }
        }
        return result;
      };
    }
  }
  file() { return path.join(path.dirname(this.game.stateFile), 'v7state.json'); }
  load() {
    let data = null; try { data = JSON.parse(fs.readFileSync(this.file(), 'utf8')); } catch { return 0; }
    let n = 0;
    for (const [id, rec] of Object.entries((data && data.players) || {})) {
      const p = this.game.byId.get(id); if (!p || !rec || typeof rec !== 'object') continue;
      for (const [k, heal] of this.fields) {
        if (!(k in rec)) continue;
        let v = null; try { v = heal(rec[k], p); } catch { v = null; }
        if (v != null) { v7of(p)[k] = v; n++; }
      }
    }
    return n;
  }
  save({ sync = false } = {}) {
    const f = this.file();
    if (!fs.existsSync(path.dirname(f))) return false;     // tests run with /nonexistent/… state files
    const players = {};
    for (const p of this.game.byId.values()) {
      const v = p.v7; if (!v) continue;
      const rec = {}; for (const k of this.fields.keys()) if (v[k] != null) rec[k] = v[k];
      if (Object.keys(rec).length) players[p.id] = rec;
    }
    const body = JSON.stringify({ schema: 1, savedAt: Date.now(), players }), tmp = `${f}.${process.pid}.tmp`;
    if (sync) { fs.writeFileSync(tmp, body); fs.renameSync(tmp, f); return true; }
    fs.promises.writeFile(tmp, body).then(() => fs.promises.rename(tmp, f)).catch((e) => this.log(`[v7] save failed: ${e.message}`));
    return true;
  }
}
export function installV7(game, { ais = null, log = game.log || console.log, packages = PACKAGES } = {}) {
  if (game.v7hooks) return game.v7hooks;
  const hooks = new V7Hooks(game, log);
  game.v7hooks = hooks; game.ais = ais;
  for (const [name, install] of packages) { try { install(game, hooks); } catch (e) { log(`[v7] ${name} not installed: ${e?.stack || e}`); } }
  hooks.on('after', 'sendHarbor', (x, p) => hooks.sendHarborV7(p));
  hooks.on('after', 'finishDock', (x, p) => hooks.sendHarborV7(p));   // registered last: runs after DOCK and PASSPORT
  hooks.on('after', 'saveState', (x, o) => hooks.save({ sync: !!(o && o.sync) }));
  hooks.load();
  hooks.wrapAll();
  return hooks;
}
```

**Handler contract.**
- `hooks.on('before', method, fn)`: `fn(...args)`; return `undefined` to continue, `stop(value)` to skip the original
  (the wrapper returns `value`, and no after handler runs). `{ first: true }` puts a handler at the front.
- `hooks.on('after', method, fn)`: `fn({ result, pre }, ...args)`; a non-`undefined` return replaces the result (used by
  `privateState`, `publicState` and nothing else). `pre` is what `ADVISED[method]` recorded before the original ran.
- `hooks.active('dock') === p` is true only while the original `dock(p)` runs (DOCK captures in `moorAt` only then).
- A throwing handler is logged once per method and skipped; the host method always runs. A package whose `install`
  throws is skipped with a log line; the others still install.
- Each package module exports `installX(game, hooks)`, which constructs its desk(s) on `game`, registers its saved
  fields (`hooks.field`), its harbour fields (`hooks.harbor`), its actions (`hooks.action`) and its advice.
- **Handler order = `PACKAGES` order: DOCK, PASSPORT, PILOT, ANCHOR.** DOCK before PASSPORT puts the docking card before
  the stamp after `finishDock`; PILOT before ANCHOR puts "pilot job — real time only" ahead of the anchor's warp rules.
  This is independent of the phase-B **merge** order (PASSPORT → DOCK → ANCHOR → PILOT, §6.1).

**Tests.** Unit tests construct the desks directly (phase A). Game-level tests call `installV7(g, { ais, packages: [
['dock', installDock]] })` **after** `g.saveState = () => {}` and `g.rnd = …` (a stub set after the install would
replace the wrapper). Existing tests never call `installV7`, so wave 1, wave 2 and v6 tests are unaffected by v7.
`test/v7hooks.test.mjs` (integrator, phase A) covers the core: before/after order, `stop`, `active`, a throwing handler
isolated, `pre` for `collision`, the action rate limit (6th action in 1 s ignored), `save`/`load` round trip in a temp
dir, `save` skipped for a `/nonexistent/` state file, and a `PACKAGES` entry whose install throws.

**Advice table (server).** The G numbers of the first draft are kept so §2–§6 still refer to them.

| # | Advice | Pkg | Handler | Relies on |
|---|---|---|---|---|
| G1 | — | — | `game.js` gets no import; `server/v7hooks.js` imports the packages | — |
| G2 | `installV7` | each | DOCK `game.dockScore = new DockScore(game)`; PASSPORT `game.passports = new PassportDesk(game)`; PILOT `game.pilotage = new PilotDesk(game)`; ANCHOR `game.seamarks = new SeamarkIndex({ world: game.world, geom: game.geom, log })`, `game.anchors = new Anchorage(game)`; core `game.ais = opts.ais` | `game.world`, `game.geom`, `game.stateFile`, `game.byId` |
| G3 | `connect` after | PASSPORT | `passports.backfill(result)` | `connect` returns the player |
| G4 | `onState` before | ANCHOR | `if (anchors.rejectState(p, +m.lat, wrapLon(+m.lon), Date.now())) return stop();` (does nothing unless anchored, at sea, not under tugs) | — |
| G5 | `onState` after | DOCK | `dockScore.sample(p, Date.now())` when the state was **accepted**: `!p.docked && !p.assist && !(p.flooding >= 1) && !p.rejects && Number.isFinite(+m.lat) && Number.isFinite(+m.lon)` | `p.rejects` is reset to 0 on accept and incremented on every rejection |
| G6 | `onAction` before | each | `hooks.action('anchor', …)`, `'dock_last'`, `'pilot_accept'`, `'pilot_cancel'`, `'passport'`, debug `'debug_anchor'`, `'debug_pilot_vessel'` (each refuses unless `process.env.SALTLINE_DEBUG === '1'`) | `m.action` |
| G7 | `setDocked` after | ANCHOR | `anchors.clear(p)` — every arrival, tow, impound, reset and rescue landing goes through it | — |
| G8 | `dock` before | ANCHOR | anchored and not docked → `game.event(p, 'warn', 'Weigh anchor first (Q), then come alongside.'); return stop();` | — |
| G9 | `moorAt` before | DOCK | `if (hooks.active('dock') === p) dockScore.capture(p, harbor, b);` — before the snap; tug, legacy-walk and load-time moorings are not captured | `moorAt(p, harbor, b)` |
| G10 | `finishDock` after | DOCK, PASSPORT | `dockScore.arrived(p, harbor)`; `passports.arrived(p, harbor, p.berth ? 'moored' : 'docked')`; then the core's `harbor_v7` | runs after dues, pilotage and (wave 2) survey; `p.berth` |
| G11 | `tugAssist` before | ANCHOR | anchored → `'Weigh anchor first (Q) — the tugs cannot take an anchored ship.'`, `stop()` | — |
| G12 | `tugAssist` after | DOCK | `if (!pre && p.assist) dockScore.assisted(p, p.assist.harbor, p.assist.cost);` | `p.assist.{harbor, cost}` (set by today's code and kept by wave 2's `charge` rewrite) |
| G13 | `collision` after | DOCK, PILOT | counted = `p.lastCollision !== pre`; `kind = m.kind === 'ship' \|\| m.kind === 'breakwater' ? m.kind : 'quay'`; `kn = Math.min(60, Math.abs(+m.speedKn) \|\| 0)`; → `dockScore.contact(p, kind, kn)`, `pilotage.contact(p, kind, kn)` | `p.lastCollision` set only for a counted contact |
| G14 | `grounding` after | DOCK | counted = `p.lastGrounding !== pre` → `dockScore.contact(p, 'ground', 0)` | `p.lastGrounding` |
| G15 | `setFishing` before | ANCHOR | `on && anchored` → `'Weigh anchor first (Q) — the nets need way on.'`, `stop()` | — |
| G16 | `tick` after | PILOT | `pilotage.tick(Date.now())` | — |
| G17 | `tick` after | ANCHOR | `anchors.tickAll(dt)` — every player with an anchor who is not docked, not under tugs, not in the raft (online or offline) | — |
| G18 | *(dropped)* | — | Not needed: today's `underway` test (`|throttle| > 0.03 \|\| |spd| > 0.5`, speed through the water) is already false for a ship lying to her anchor with the engine stopped, so she pays no wages, no hull wear and no fuel. With the engine turning ("steaming to the anchor") she pays all three, as she should. Wave 2's wage state at anchor: §3.8 | — |
| G19 | `sink` after | ANCHOR | `anchors.clear(p)` | — |
| G20 | `warpConditions`, `warpBlock`, `checkWarp`, `warpLimit` before | PILOT, ANCHOR | §3.4 (PILOT's handler runs first) | `warpOf`, `dropWarp`, `capWarp`, `harbourZone`, `weatherAt` (called, not edited) |
| G21 | `expressPassage` before | ANCHOR | anchored → `'Weigh anchor first (Q).'`, `stop()` | — |
| G22 | `setVoyage` before | ANCHOR | `anchored && !m.clear` → `'Weigh anchor first (Q) — the crew cannot sail her at anchor.'`, `stop()` | — |
| G23 | `privateState` after | ANCHOR, PILOT | `result.anchor = anchors.view(p); result.pilotage = pilotage.view(p);` | returns a fresh object |
| G24 | `publicState` after | ANCHOR | `result.anchored = !!p.v7?.anchor;` | returns a fresh object |
| G25 | `sendHarbor` after | core (+ DOCK, PASSPORT, ANCHOR via `hooks.harbor`) | `{ t: 'harbor_v7', harbor, dockBest, dockLast, stamp, anchorage }` right after the `harbor` message (§1.9) | `p.docked` |
| G26 | `finishRescue` before | PASSPORT | `passports.arrived(p, harborById(r.from), 'landed')` — before wave 2's landing may move the person to another harbour | `finishRescue(p, r)`, `r.from` |
| G27 | `saveState` after | core | `hooks.save({ sync })` — v7's own file, §1.8 | `saveState({ sync })` (wave 2) or `saveState()` |

"anchored" = `!!p.v7?.anchor`. In the rest of this document `p.anchor`, `p.passport`, `p.dockBest`, `p.dockLast`,
`p.dockLog` and `p.dockBonusAt` are shorthand for `p.v7.anchor` … `p.v7.dockBonusAt`.

Nothing in `undock`, `tow`, `impound`, `forcedReset`, `simulateOffline`, `buyShip`, `sellShip`, `loadState` or
`migratePlayer` is advised.

### 1.6 Client hooks and the few direct edits

**Client hook layer — `public/js/v7hooks.js`** (integrator, phase A, new file). Loaded by **one line appended after
`window.app = new App();`** at the end of `public/js/main.js` (a top-level statement, inside no function):

```js
import('./v7hooks.js').then((m) => m.installV7Client(window.app)).catch((e) => console.warn('[v7] unavailable', e));
```

`installV7Client(app)` creates `app.v7hooks` with the same `on(when, target, method, fn, { first })` / `stop(value)`
semantics as the server (targets `'app'`, `'hud'` = `app.hud`, `'chart'` = `app.hud.chart`, `'ais'` = `app.aisLayer`;
each (target, method) is wrapped once, on the instance, the first time a handler is registered), then imports the four
client modules with the berthguide pattern — `import('./dockcard.js').then((m) => { app.dockCard = m.installDockCard(app,
app.v7hooks); }).catch((e) => console.warn('[dockcard] unavailable', e))`, likewise `app.passportUi` (`./passport.js`),
`app.pilotJobs` (`./pilotjobs.js`), `app.anchorUi` (`./anchor.js`) — all four listed from phase A; a module not
merged yet only logs the warning. The core itself handles `harbor_v7` (it must not be
lost while a module is still loading) and the per-frame dispatch. A module that fails to load costs only its feature.

| # | Advice | Pkg | Handler |
|---|---|---|---|
| C1 | `app.onMessage` before | core, DOCK, PASSPORT | core: `harbor_v7` → `Object.assign(app.hud.harborData, fields)` when `harborData?.id === m.harbor`, keep a copy in `app.v7Harbor`, `app.hud.renderHarborTabs()` if the sheet is open, `stop()`. DOCK `dock_score` → `dockCard.onResult(m.result)`; PASSPORT `passport` → `onPassport(m.passport)`, `stamp` → `onStamp(m)`; each `stop()` |
| C2 | `app.onYou` after | ANCHOR, PILOT | `anchorUi.onYou(app.you, pre)`, `pilotJobs.onYou(app.you, pre)`; `pre` = `app.you` recorded before the original ran |
| C3 | `app.loop` before | core | for each loaded module with `update`: `update(dt, now)` with the core's own `dt` (`performance.now()` difference, ≤ 0.25 s), each in `try … catch` warning once — replaces the four guarded lines the first draft put into `loop` |
| C4 | `app.simulate` before | ANCHOR | while `you.anchor` and not docked: `app.input.throttleCmd = clamp(app.input.throttleCmd, ANCHOR.THR_MIN, ANCHOR.THR_MAX)` and `app.touchHelm?.setThrottle?.(…)` when it changed — at anchor the telegraph only rings slow astern … slow ahead (the autopilot is off at anchor, so wave 2's warning about adopting clamped orders does not apply) |
| C5 | `app.simulate` after | ANCHOR | while `you.anchor`: `constrainToAnchor(app.ship, anchorUi.anchorNow(you.anchor), C, dt × warp)` once per frame (§3.2). The state `simulate` already sent this frame is at most one frame of drift outside the circle (centimetres; the server tolerates 60 m) |
| C6 | `app.setWarp` before | ANCHOR | `f > ANCHOR.WARP_MAX && app.you?.warpLimit?.anchor` → `hud.event({ kind: 'warn', text: 'At anchor time warp is limited to 5×.' })`, `stop(false)` (`stepWarp` calls `this.setWarp`, so it is covered) |
| C7 | `ais.others` after | PILOT | `result.map((v) => pilotJobs.soften(v))` (§4.5) |
| C8 | `hud.drawRadar` before | ANCHOR, PILOT | push `anchorUi.radarContacts()` and `pilotJobs.radarContacts()` into the `contacts` argument (wave 2's fault overlay runs inside the original, unchanged) |
| C9 | `hud.updateWarp` after | ANCHOR | when `you.warpLimit?.anchor`: label `Anchor`, class `harbour` on `#warpCtl`, and `#warpUp.disabled = w >= lim.max` (an anchored ship with empty tanks may warp) |
| C10 | `hud.anyOverlayOpen` after (PASSPORT), `hud.transientOpen` after (DOCK, PASSPORT) | DOCK, PASSPORT | `result \|\| isOpen()` of `#passportWrap` / `#dockCardWrap` |
| C11 | `hud.closeOverlays` after | DOCK, PASSPORT | close their own overlay |
| C12 | `hud.sheetAction` before | DOCK, PASSPORT, ANCHOR | `dockReplay`, `passport`, `anchorageChart` → handle, `stop()` |
| C13 | `hud.tabOverview` after | DOCK, PASSPORT, ANCHOR | `return result + '<div class="cards v7cards">' + dockCard.overviewCard(h, you) + passportUi.overviewCard(h, you) + anchorUi.overviewCard(h, you) + '</div>'` (each may return `''`). The Harbour card's existing "Anchorage" row (the harbour anchor point) is left alone; ANCHOR's card is titled "Anchorages nearby" |
| C14 | `chart.draw` after | ANCHOR, PILOT | `if (chart.layers.anchorages) anchorUi.drawChart(chart, chart.ctx)`; `if (chart.layers.pilot) pilotJobs.drawChart(chart, chart.ctx)`. The installer adds `anchorages: true, pilot: true` to `chart.layers` at runtime (`setLayer` accepts any existing key) |
| C15 | `chart.showHarborPopup` after | ANCHOR | `anchorUi.popupRows(h, chart.ensurePopup().querySelector('.popBody'))` |
| C16 | own `keydown` listener | ANCHOR | `q` → `anchorUi.toggle()`; ignored unless `app.started`, when typing in an input/textarea/contenteditable, with Ctrl/Meta/Alt, ashore or below decks (`app.ashore?.active`, `app.interior?.active`). `q` is free today; the help sheet gets its row at runtime |

**Direct edits** (functions nobody else owns, or new top-level statements):

| File: place | Pkg | Change |
|---|---|---|
| `server.js`: imports | core | `import { installV7 } from './server/v7hooks.js';` |
| `server.js`: directly after `game.aiFilter = (a) => !liveAis.covers(a.lat, a.lon);` | core | `installV7(game, { ais: liveAis, log });` — the v7 file is read here, after `loadState` ran in the constructor |
| `server.js`: after the `SALTLINE_PREFETCH` line | ANCHOR | `game.seamarks?.enableFetch(); if (process.env.SALTLINE_PREFETCH === '1') game.seamarks?.prefetchAll({ delayMs: 3000 }).catch((e) => log('[seamarks] prefetch failed', e.message));` |
| `server.js`: new routes after `/api/jobs` | ANCHOR, core | `GET /api/seamarks` (§3.6); `GET /api/v7` → `{ pilotage: game.pilotage?.stats?.() ?? null, seamarks: game.seamarks?.stats?.() ?? null, anchors: game.anchors?.stats?.() ?? null, dock: game.dockScore?.stats?.() ?? null, failed: [...(game.v7hooks?.failed ?? [])] }`. `/api/health` is **not** touched (wave 2 and MARKET edit that one-line statement) |
| `server.js`: the live-AIS push interval, the `ws.send(… liveAis.near(…) …)` statement | PILOT | `const ships = liveAis.near(p.ship.lat, p.ship.lon, AIS_NEAR_M, { limit: AIS_NEAR_LIMIT }); game.pilotage?.addJobVessel?.(p, ships); ws.send(JSON.stringify({ t: 'ais', time, ships }));` — the job's ship is always in her pilot boat's AIS list, even when 200 nearer vessels lie in the port (§4.8) |
| `public/js/main.js`: after `window.app = new App();` | core | the one `import('./v7hooks.js')` line above |
| `public/js/collision.js` `resolveShip`, the other-ships loop and the ships block | PILOT | soft contact (§4.5) — nobody else edits this file |
| `public/js/berthguide.js`, end of file | DOCK | `export { planBase, PLAN_COL };` |
| `.gitignore` | ANCHOR, core | `data/seamarks/`; `data/v7state.json*` |

Not touched by v7: every function of `server/game.js`, `public/js/main.js` except its last line, `public/js/hud.js`,
`public/js/chart.js`, `public/js/sound.js`, `shared/physics.js`, `shared/telegraph.js`, `shared/constants.js`,
`server/tugassist.js`, `server/tugpath.js`, `server/ais/*`, `public/js/interior.js`, `public/index.html`, `style.css`,
and every wave 2 file (`server/company.js`, `ledger.js`, `store.js`, …).

### 1.7 `server/v7money.js` — the one place v7 pays a player (verbatim)

DOCK (bonus) and PILOT (pilotage fee) pay credits. Whichever lands first writes this file exactly:

```js
// v7 batch 1: the one place v7 code pays a player (docs/V7-BATCH1-CONTRACTS.md §1.7).
const ledger = await import('./ledger.js').catch(() => null);   // wave 2's ledger, once its file exists (phase A)
export function creditPlayer(game, p, amount, sub, memo) {
  const amt = Math.round(Number(amount));
  if (!(amt > 0) || !p) return 0;
  if (ledger?.credit && p.company) ledger.credit(p.company, amt, 'contract', { sub, memo, v: p.vessel?.id });
  else p.money += amt;                                            // before wave 2 only: deleted when W2-SERVER merges (§6.4)
  p.stats = p.stats || {}; p.stats.earned = (p.stats.earned || 0) + amt;
  return amt;
}
```

`sub` is `'docking'` or `'pilotage'`. Both are earnings from work, so wave 2's P&L shows them under `contract` income
(no new ledger category; `book()` validates `cat` only). `p.company` exists only after W2-SERVER's phase B; until then
the purse is `p.money`, even if `server/ledger.js` (wave 2 phase A) is already in the tree.

**Wave 2's source-grep test** (V5-WAVE2 §4.2: no `.money` writes in `server/*.js` outside `company.js`) would flag the
`else` line. The fallback line is deleted — leaving `if (ledger?.credit && p.company) … ;` with no `else` — by the
**integrator in the same commit that merges W2-SERVER's phase B** if v7's DOCK or PILOT merged first, or never written at
all if W2-SERVER merged first. It is the only v7 line that depends on the merge order, and no wave 2 file changes.

### 1.8 Saved state — v7's own file, `v7state.json`

v7 adds **no field to the game's state file** and edits no save, load or migration code. All saved v7 data of a person
lives in the non-enumerable object `p.v7` (`v7of(p)`, §1.5): today's `saveState` (`{ ...p }`) and wave 2's explicit
`PlayerRecord` never serialise it. `installV7` reads it once from `v7state.json` in the directory of `game.stateFile`
(`data/v7state.json` in production) after the game's own `loadState`; the core writes it after every `saveState` (every
30 s and, synchronously, at shutdown through wave 2's / v6's `saveState({ sync: true })`), to `<file>.<pid>.tmp` then
renamed. So there is no schema bump, no `VESSEL_KEYS` or `PlayerRecord` change in wave 2's files, and wave 2 may merge
before, after or between the v7 packages.

```ts
// data/v7state.json
{ schema: 1, savedAt: unixMs, players: { [playerId]: { passport?, dockBest?, dockLast?, dockLog?, dockBonusAt?, anchor? } } }
```

| Key in `p.v7` | Owner | Shape | Size | Heal on load (`hooks.field(key, heal)`) |
|---|---|---|---|---|
| `passport` | PASSPORT | `{ v: 1, stamps: { [harborId]: Stamp }, badges: { [badgeId]: unixS } }` | ≤ 86 × ~90 B | drop stamps without a finite `first`; unknown harbour ids kept (§5.2) |
| `dockBest` | DOCK | `{ [harborId]: { s, g, at, cls, berth } }` | ≤ 86 × ~60 B | drop entries without an integer `s` in 0–100 |
| `dockLast` | DOCK | the last DockResult, compact track included (§2.5) | ≤ 5 KB | null unless `kind` and `harbor` are strings and `track` is an array |
| `dockLog` | DOCK | last 30 `{ h, s, g, at, cls, k }` (for v7 item 1) | ≤ 1.5 KB | keep the last 30 well-formed rows |
| `dockBonusAt` | DOCK | `{ [harborId]: unixS }` | small | drop non-finite values |
| `anchor` | ANCHOR | §3.2 `AnchorState` | ~0.6 KB | null without finite `lat, lon, chain, depth`, with an unknown `state`, or when the player is docked or in the raft |

Counters stay in `p.stats` (`moorings`, `mooringsGraded`, `pilotJobs`, `pilotMissed`, `pilotEarned`, `anchorDrags`):
small integers created lazily (`(p.stats.x || 0) + 1`), persisted by both today's state file and wave 2's
`PlayerRecord.stats`; `migratePlayer`'s stats list is not edited.

Never saved (module memory, keyed by player id): the docking sample ring and pending capture, pilot offers and jobs, the
anchor tick accumulator, the stamp animation queue. A restart loses a running pilot job (nothing paid, nothing owed) and
the replay of an approach not yet finished.

**Consistency.** The two files are written at the same moment; a crash between them loses at most 30 s of v7 data. A
combination that cannot be true (an anchor on a docked player) is healed on load. Player ids survive wave 2's
`migrateV1toV2`, so the v7 file needs no migration. The anchor is per person in this batch: wave 2 switches ships only
in harbour, where no ship is at anchor. Fleet ships left at anchor (v6 office) are out of scope; v6 will key `anchor`
by vessel id in this same file.

**Rollback.** Older code ignores `v7state.json`. A ship saved at anchor and loaded by older code is simply stopped at sea
where she lay.

### 1.9 Protocol summary

`net.action(name, fields)` sends `{ ...fields, t: 'action', action: name }`.

| Direction | Message | Pkg |
|---|---|---|
| server → client | `you.anchor: AnchorView \| null` (1 Hz with `you`) | ANCHOR |
| server → client | `you.pilotage: PilotView \| null` (null unless the ship is a pilot boat or a job runs) | PILOT |
| server → client | `snap.players[].anchored: boolean` | ANCHOR |
| server → client | `{ t: 'harbor_v7', harbor, dockBest, dockLast, stamp, anchorage }` right after every `harbor` message and at the end of every arrival (the `harbor` payload itself is wave 2's to change) | core: DOCK, PASSPORT, ANCHOR |
| server → client | `{ t: 'dock_score', result: DockResult }` once per arrival that has a card | DOCK |
| server → client | `{ t: 'passport', passport: PassportView }` (answer to `passport {}`) | PASSPORT |
| server → client | `{ t: 'stamp', stamp: StampView, isNew: boolean, newBadges: [BadgeView] }` on arrival | PASSPORT |
| server → client | `ais.ships` always includes the pilot job's vessel for her pilot boat | PILOT |
| client → server | `anchor { op: 'drop' \| 'weigh' \| 'veer' }` | ANCHOR |
| client → server | `dock_last {}` → `dock_score` with `p.dockLast` (for Replay) | DOCK |
| client → server | `pilot_accept { offerId }`, `pilot_cancel {}` | PILOT |
| client → server | `passport {}` (view) · `passport { op: 'ashore' }` (the skipper walked ashore here) | PASSPORT |
| client → server | debug only: `debug_anchor { loadMul }`, `debug_pilot_vessel {}` | ANCHOR, PILOT |
| HTTP | `GET /api/seamarks?bbox=latMin,lonMin,latMax,lonMax`; `GET /api/v7` (module stats) | ANCHOR, core |

New actions share one per-player limit (`hooks.allow`): at most 5 v7 actions per second, excess ignored silently.

---

## 2. DOCK — docking score

### 2.1 Goal, in the player's words

"When I bring her alongside myself I get a grade, like a driving test: how fast I touched, how far off the berth I
ended, how straight I lay against the quay, how long the last 300 metres took, whether I bumped anything, and whether I
used the engine properly — astern to take the way off, stopped at the end. A good one pays a small bonus. Each harbour
remembers my best, and I can watch my approach again on the little harbour plan. If the tugs did it, it just says
assisted."

### 2.2 What is scored

**When.** A mooring through `dock()` at a berth of a built harbour (`berth` chosen) is **graded**. A tug assist (manual
`tug_assist`, planned path or legacy walk) is **assisted**: a card with no grade. A legacy docking without berth geometry,
a tow, an impound, a forced reset and a rescue landing have **no card**.

**Samples (server-authoritative).** `DockScore.sample(p, nowMs)` runs at the end of every accepted `onState` and keeps a
ring of the ship's own server-side state: `{ ts (p.shipTime), wall (nowMs), lat, lon, hdg, spd, thr (p.ship.throttle) }`.
A sample is stored when ≥ `SAMPLE_MIN_S` (0.5 s) of real time has passed **and** (≥ `SAMPLE_MOVE_M` (5 m) moved or
≥ `SAMPLE_MAX_S` (2 s) passed). Ring size `RING` = 900 (30 min at a crawl, 15 min at 10 kn, 7.5 min at 20 kn or under warp — always more than the
1,500 m window). The ring is cleared when
the gap to the previous sample exceeds `GAP_RESET_S` (60 s real: the ship was docked, offline or under tugs), while
`p.anchor` is set (anchored time is not an approach), and after every `capture`. Contacts and groundings
(`contact(p, kind, kn)`) go into a second ring of `{ ts, kind, kn }` (≤ 50).

**Capture.** `capture(p, harbor, berth)` runs from the `moorAt` before-advice (G9) **only while `dock(p)` is running**
(`hooks.active('dock') === p`), i.e. after all of `dock()`'s checks and before `moorAt` snaps the ship. Tug assists,
the legacy walk and the load-time completion in `migratePlayer` call `moorAt` outside `dock()` and are never captured.
It freezes the moor state `{ ts, lat, lon, hdg, spd, thr }` from `p.ship` and `p.shipTime`, computes the derived contact
speed (below), and stores `{ harbor, berth, samples, contacts, moor, derivedKn }` as the pending capture for `arrived`.

**Window.** The approach starts at the last sample further than `TRACK_FROM_M` (1,500 m) from the berth point (or the
first sample in the ring). The **300 m mark** is the first sample after which the ship stays within `APPROACH_M` (300 m)
of the berth point; without one, the first sample of the window.

**Contact speed** = max(|`moor.spd`| (the reported speed through the water), `derivedKn`), where `derivedKn` is the
speed **through the water** implied by the positions: the displacement of the samples in the last `DERIVED_WINDOW_S`
(4 s of ship time) ÷ their ship-time span, minus the drift the client's `stepShip` adds (`game.currentAtPos` = current +
tidal stream, plus 0.02 × `game.weatherAt().wind`), as a vector, in knots (null with fewer than two samples there). A
client that reports 0.2 kn while its positions move at 1.5 kn through the water scores 1.5 kn; a ship lying still in a
0.8 m/s tidal stream (Rotterdam's basins get the full Southern North Sea stream in the client physics) scores ≈ 0, not
1.6 kn.

**Parts** (`shared/dockscore.js`, `scoreMooring`; points are kept to one decimal, the total is rounded half up):

| Part | Measure | Full marks | Zero | Points |
|---|---|---|---|---|
| Speed at contact | contact speed (kn) | ≤ 0.3 | ≥ 2.0 | 35 × clamp((2.0 − v) / 1.7, 0, 1) |
| Distance off the berth | lateral offset `lat` of the ship's centre from the berth line (the line through the berth point at the berth heading), along offset `al` from the berth point | `lat ≤ tol`, `al ≤ allow` | error ≥ 50 m | 20 × clamp(1 − (max(0, lat − tol) + 0.5 × max(0, al − allow)) / 50, 0, 1), `tol = max(5, beam / 4)`, `allow = max(10, (berth.length − L) / 2)` |
| Angle to the quay | `a = min(abs(Δ), 180 − abs(Δ))`, Δ = angleDiff(ship hdg, berth hdg) | ≤ 3° | ≥ 30° | 15 × clamp(1 − (a − 3) / 27, 0, 1) |
| Time from 300 m | ship-time from the 300 m mark to the capture, `t` | ≤ par | ≥ 3 × par | 10 × clamp(1 − (t − par) / (2 × par), 0, 1), `par = 240 + 1.5 × L` s (coaster 375 s, feeder 465 s, boxship 690 s, pilot boat 267 s) |
| Clean approach | contacts in the window | none | — | 10 − Σ deductions, min 0: quay 4, breakwater 6, ship 10, grounding 10 |
| Engine orders | from the samples | — | — | 4 if `abs(moor.thr) ≤ 0.15` (stopped or dead slow at contact) + 4 if astern (`thr ≤ −0.05`) was used inside 300 m **or** the speed never exceeded 3 kn inside 300 m + 2 if `moor.spd ≥ −0.3` (no sternway at contact) |

The berth outline the guidance draws is centred on the berth point and sized to the ship, so the offset is measured
against what the skipper sees; `tol` absorbs the fact that a beamy hull cannot reach the outline's centre line.

**Grade** (`GRADES`): A+ ≥ 95, A ≥ 88, B ≥ 75, C ≥ 60, D ≥ 45, F below. **Caps** (applied after the bands): any contact
≥ `HEAVY_KN` (3 kn) in the window → at most **D** ("heavy contact"); any grounding in the window → at most **C**.

**Worked example** (a test vector). Coaster at a 395 m berth: reported 0.4 kn, derived 0.45 → speed 31.9; 7 m off the
line (tol 5), 30 m along (allow 152.5) → offset 19.2; 4° → angle 14.4; 450 s from 300 m (par 375) → time 9.0; one quay
bump at 0.6 kn → clean 6.0; throttle 0 at contact, astern used after 3.6 kn inside 300 m, no sternway → engine 10.
Total 90.5 → **91, A**. Bonus 160 × 0.75 = **120 cr**.

**Bonus** = round(clamp(0.05 × displacement, 150, 1500) × mul), `mul` A+ 1, A 0.75, B 0.5, C 0.25, D/F 0 (coaster A+
160, feeder A+ 700, boxship A+ 1,500, pilot boat A+ 150). Paid through `creditPlayer(…, 'docking', 'Docking bonus …')`
at most once per harbour per `BONUS_WINDOW_S` (6 h, `p.dockBonusAt[h]`) — personal bests still update every time. The
card says why when no bonus is paid ("Bonus already paid here in the last 6 h").

**Personal best** per harbour (`p.dockBest[h]`): replaced when the new score is strictly higher. The card shows the best
before this mooring and a "New personal best" ribbon. **Log**: every graded or assisted arrival appends to `p.dockLog`
(last 30). **Hooks for v7 item 1**: `export const DOCK_HOOKS = []` in `server/dockscore.js`; after each result
`for (const f of DOCK_HOOKS) try { f(game, p, result); } catch {}`. Wave 2 has no reputation (its credit rating is about
loans); career and reputation is v7 item 1, which registers here. Nothing is registered in this batch.

**Assisted** card (marked by `assisted(p, harborId, cost)` from the `tugAssist` after-advice, G12 — the cost is taken
there because `setDocked` clears `p.assist` before the arrival): `kind: 'assisted'`, `score: null`, the time from 300 m
(from the ring, when it has the samples), the tug cost, the note "Brought alongside by
the tugs — no grade. Moor under your own power for a score.", the personal best, no bonus. `stats.moorings` counts every
card; `stats.mooringsGraded` the graded ones.

### 2.3 Constants and pure API — `shared/dockscore.js`

```js
export const DOCK = {
  WEIGHTS: { speed: 35, offset: 20, angle: 15, time: 10, clean: 10, engine: 10 },
  SPEED_FULL_KN: 0.3, SPEED_ZERO_KN: 2.0,
  OFFSET_TOL_MIN_M: 5, OFFSET_TOL_BEAM: 0.25, OFFSET_ZERO_M: 50, ALONG_WEIGHT: 0.5, ALONG_ALLOW_MIN_M: 10,
  ANGLE_FULL_DEG: 3, ANGLE_ZERO_DEG: 30,
  APPROACH_M: 300, PAR_BASE_S: 240, PAR_PER_M_S: 1.5, TIME_ZERO_MUL: 3,
  CONTACT_PTS: { quay: 4, breakwater: 6, ship: 10, ground: 10 }, HEAVY_KN: 3, CAP_HEAVY: 'D', CAP_GROUND: 'C',
  ENGINE: { stopped: 4, astern: 4, noSternway: 2 }, THR_STOPPED: 0.15, THR_ASTERN: -0.05, NEED_ASTERN_KN: 3, STERNWAY_KN: 0.3,
  GRADES: [['A+', 95], ['A', 88], ['B', 75], ['C', 60], ['D', 45], ['F', 0]],
  BONUS_MUL: { 'A+': 1, A: 0.75, B: 0.5, C: 0.25, D: 0, F: 0 }, BONUS_PER_T: 0.05, BONUS_MIN: 150, BONUS_MAX: 1500, BONUS_WINDOW_S: 21600,
  TRACK_FROM_M: 1500, TRACK_MAX_PTS: 150, TRACK_TAIL_S: 20,
  SAMPLE_MIN_S: 0.5, SAMPLE_MAX_S: 2, SAMPLE_MOVE_M: 5, RING: 900, GAP_RESET_S: 60, DERIVED_WINDOW_S: 4,
};
export function parTimeS(cls)                             // 240 + 1.5 × length
export function gradeFor(score, caps = [])                // band, then caps
export function bonusFor(cls, grade)                      // credits (integer)
export function berthFrame(berth)                         // { toXZ(lat, lon) → [x east, z south] m, lineOffset(lat, lon) → { lat, al } }
export function scoreMooring({ cls, berth, samples, contacts, moor, derivedKn })
  // → { score: int, grade, caps: [string], contactKn, parts: [{ key, label, value, unit, pts, max, note }], window: { from, mark300 } }
export function compactTrack(samples, berth, max = DOCK.TRACK_MAX_PTS)
  // → [[x, z, hdg, spd10, thr100, t], …] ints, metres from the berth point, t = ship seconds from the first point;
  //   decimated evenly but every sample of the last TRACK_TAIL_S kept
export function expandTrack(track, berth)                 // → [{ lat, lon, hdg, spd, thr, t }]
```

Part labels and notes (exact, the card shows them): `Speed at contact` "0.4 kn"; `Distance off the berth` "7 m off the
line" (+ " · 35 m past the berth end" when `al > allow`); `Angle to the quay` "4°"; `Time from 300 m` "7 min 30 s (par
6 min 15 s)"; `Clean approach` "no contact" / "1 bump with the quay (0.6 kn)"; `Engine orders` one of "stopped at
contact, astern to take the way off" / "engine still ahead at contact" / "sternway at contact" / "no astern after 3.6 kn
inside 300 m".

### 2.4 Server — `server/dockscore.js`

```js
export const DOCK_HOOKS = [];
export class DockScore {
  constructor(game)
  sample(p, nowMs)                 // G5: ring of accepted states (rules in §2.2); cheap: no harbour lookups
  contact(p, kind, kn)             // G13/G14: kind 'quay' | 'breakwater' | 'ship' | 'ground'
  capture(p, harbor, berth)        // G9: freeze the approach before moorAt
  assisted(p, harborId, cost)      // G12: mark the next arrival at this harbour as assisted, with the tug cost (30 min)
  arrived(p, harbor)               // G10: score (or assisted card), bonus, best, log, DOCK_HOOKS, send dock_score; clears marks
  sendLast(p)                      // `dock_last`: resend p.dockLast as dock_score (replay) or warn "No mooring on record yet."
  bestAt(p, harborId)              // { s, g, at, cls, berth } | null
  lastSummary(p)                   // { harbor, s, g, kind, at } | null (the harbour sheet's Replay row)
  stats()                          // { rings, results, graded, avgScore }
}
export function installDock(game, hooks)  // G2, G5, G6 (dock_last), G9, G10, G12–G14; 4 × hooks.field; hooks.harbor → { dockBest, dockLast }
```

`arrived` with a capture whose harbour differs from `harbor` (should not happen) or older than 60 s is ignored. A
forced reset inside `finishDock`'s inspection still produces the card (the mooring happened).

### 2.5 Messages

```ts
DockResult = {
  id: string, kind: 'manual' | 'assisted', harbor: string, harborName: string,
  berth: { id, name, lat, lon, hdg, length }, cls: string, at: number /* unixS */,
  score: number | null, grade: 'A+'|'A'|'B'|'C'|'D'|'F' | null, caps: string[], contactKn: number | null,
  parts: [{ key: 'speed'|'offset'|'angle'|'time'|'clean'|'engine', label, value: number, unit, pts: number, max: number, note: string }],
  timeS: number | null, parS: number | null,
  tugCost: number | null,                           // assisted only: what the tugs charged
  bonus: number, bonusWhy: string | null,           // e.g. 'Bonus already paid here in the last 6 h'
  best: { s, g, at, cls } | null, newBest: boolean,
  track: [[x, z, hdg, spd10, thr100, t], …],       // ≤ 150 points, berth-relative
  marks: [{ i: number, kind: 'r300' | 'contact' | 'ground' | 'astern' }],
}
```

Sent as `{ t: 'dock_score', result }` after the arrival events (dues, pilotage, deliveries). `p.dockLast` stores the same
object. `harbor_v7` fields: `dockBest` (`bestAt`) and `dockLast` (`lastSummary`).

### 2.6 Client — `public/js/dockcard.js`, `public/css/dockscore.css`

```js
export class DockCard {
  constructor(app)                 // ensureCss('dsCss', 'css/dockscore.css'); builds #dockCardWrap once, hidden
  onResult(r)                      // open the card; sound.ui('cash') when bonus > 0
  open(r); close(); isOpen()
  replay(); replayLast()           // replayLast: net.action('dock_last') then replay on arrival
  overviewCard(h, you)             // harbour Overview card: best here, last mooring, [Replay]
}
export function installDockCard(app, hooks)  // C1 dock_score, C10 transientOpen, C11, C12 dockReplay, C13 → returns the DockCard
```

**Results card** (`#dockCardWrap`, glass, not a full-screen sheet):
- Desktop (1440×900): centred above the bottom bar, 560 px wide. Left: the grade letter 64 px (A+/A gold `#f2c94c`, B
  green, C amber, D/F red), "91 / 100", harbour and berth, the ribbon "New personal best" or "Best here: A 93 (coaster,
  6 Oct)". Middle: the six parts as rows — label, note, a 6 px bar (pts/max), "31.9 / 35". Right: the replay canvas
  240 × 240. Footer: "+120 cr docking bonus" (or `bonusWhy`), buttons **Replay** and **Close**.
- Phone (390×844, `body.touch`): a bottom sheet, full width, `max-height: 70vh`, scrolls inside; the grade and score in a
  header row; parts as a two-column grid (label + points); canvas 160 × 160 under the parts; buttons ≥ 44 px. No
  horizontal scroll at 360 px.
- Closes after 30 s without interaction, on Escape (`closeOverlays`), or on Close. A new result replaces the old one.
- Assisted card: header "Assisted", the note, the time from 300 m and the tug cost line, the replay canvas, no parts.

**Replay canvas.** Background = `planBase(entry)` of `app.geoms.get(result.harbor)` (exported from `berthguide.js`, the
patch mask in the mini plan's colours), drawn in the berth frame north-up, view = bounding box of the track plus 80 m,
at least 300 m. Over it: the 300 m circle around the berth (thin dashed white), the berth box (ship size, green outline),
the track as a polyline coloured by speed (≤ 1 kn green `#4fe39a`, ≤ 3 kn amber `#f2b134`, above red `#ff5a5a`), red ✕ at
contacts and groundings, a small blue tick where astern was first used, the final ship box. **Replay** animates a ship box
along the track over `min(8 s, real duration)` with a clock "−4:20" (ship time before contact). Without a loaded patch:
plain water colour with the berth box.

**Overview card** (harbour sheet): "Mooring here" — best "A 93 · coaster · 6 Oct", last "B 78 · today" with **Replay**
(`data-act="dockReplay"`), or "No mooring graded here yet — come alongside under your own power for a score."

### 2.7 Edge cases

| Case | Behaviour |
|---|---|
| Cast off and re-moor at the next berth within a minute | the ring restarts at the gap rule only after 60 s; the approach is the samples since undock; time from 300 m counts from undock. |
| Autopilot berth mode stopped her off the berth, skipper moors | graded normally (the last 1.5 lengths and the contact are the skipper's). |
| Warp 5× during the approach | everything is in ship time (`p.shipTime`): same score as at 1×. |
| Client sends few states (lag) | fewer samples; derived speed null → reported speed is used; time part from the samples present. |
| Strong tidal stream in the basin, ship stopped through the water | derived speed subtracts the stream: ≈ 0 kn, full speed points. |
| Wave 2 refuses own-power berthing (`moorNeedsTugs`) | `moorAt` is never reached in that `dock()`; no capture, no card. |
| Moored at the legacy anchor rule (no berths) | no card; passport stamp only. |
| Two dock actions in one tick | the second returns early (`p.docked` → `sendHarbor`); one card. |
| Server restart mid-approach | ring lost; the next mooring is scored from the samples after the restart. |
| Heavy contact at 4 kn in the window | grade capped at D; clean part loses the deduction; the contact itself already cost hull as today. |
| Tug assist cancelled by a restart (`migratePlayer` completes it) | `finishDock` runs with no mark and no capture → no card. |
| Bonus with wave 2 and cash in overdraft | `credit` always posts; no difference. |

### 2.8 Tests — `test/dockscore.test.mjs`

1. *Pure scoring:* the worked example of §2.2 exactly (each part to 0.1, total 91, A, bonus 120). Perfect approach
   (0.2 kn, on the line, 1°, under par, no contact, astern after 4 kn) → 100, A+. Speed 2.0 kn → 0 speed points; 1.15 kn
   → 17.5. Offset at tol → 20; tol + 50 → 0; along past `allow` counts half. Angle 183° = 3° → full. Time 3 × par → 0.
   Heavy contact 3.2 kn with 92 points → D. A grounding with 90 points → C. Grade band edges 95/88/75/60/45.
2. *Engine part:* thr 0.3 at contact → no "stopped" points; max 2.5 kn inside 300 m and no astern → astern points
   awarded; max 4 kn and no astern → none; spd −0.5 at contact → no sternway points.
3. *Track:* `compactTrack` of 600 samples → ≤ 150 points, the last 20 s complete, first point at the 1,500 m mark;
   `expandTrack(compactTrack(x))` within 1 m / 1° / 0.1 kn of the originals kept.
4. *Server sampling* (Game with `fakeGeom` + `mkBerth` from `test/game.test.mjs`): calling `sample` at 10 Hz for 60 s at
   1 kn stores ≤ 1 sample per 0.5 s and ≥ 1 per 2 s; a 61 s gap clears the ring; samples while `p.anchor` is set are
   not kept.
5. *End to end* (`installV7(g, { packages: [['dock', installDock]] })` after the stubs): undock; an approach of 40 states from 900 m to the berth (set `p.ship`, `p.shipTime`, call `sample`
   with increasing `nowMs`), ending 6 m off the line at 0.4 kn, throttle 0 → `dock` → a `dock_score` message with
   `kind: 'manual'`, the parts, `money` changed by exactly `bonus − g.feesFor(p, h).dues − pilotage` (`g.rnd = () => 0.99`:
   no inspection), `p.dockBest.rotterdam.s` equal to the score, `p.dockLog` length 1, the `dock_score` message sent after
   the "Port dues" event.
   Undock and moor again 1 min later with a better approach → new best, **no** second bonus (`bonusWhy` set).
6. *Lying client:* reported `spd` 0.2 but the last 4 s of samples move 3 m/s (current stubbed to 0) → `contactKn` ≈ 5.8
   → 0 speed points. *Tidal basin:* `g.currentAtPos = () => ({ u: 0.8, v: 0 })`, samples drifting 0.8 m/s east, reported
   `spd` 0.1 → `contactKn` ≤ 0.2 → full speed points.
7. *Assisted:* `tug_assist` with `fakeGeom` (legacy walk), tick to the berth → a `dock_score` with `kind: 'assisted'`,
   `score: null`, `tugCost` equal to the tug charge, no money change from the card, and no capture (the walk's `moorAt`
   runs outside `dock()`). A tow → no `dock_score`. A `dock()` refused by the hail check → no capture.
8. *Persistence:* with a state file in a temp dir, `g.saveState()` writes `v7state.json`; a new Game + `installV7`
   restores `dockBest`, `dockLast` (track intact), `dockLog`, `dockBonusAt`; none of them appears in `state.json`;
   `dock_last` resends the stored result.
9. *Hooks:* a function pushed to `DOCK_HOOKS` receives `(game, p, result)` once per card; a throwing hook does not stop
   the card.

### 2.9 Browser checks

1. Desktop, Rotterdam, coaster: cast off, follow the berth line round to another berth, slow to dead slow, a touch of
   half astern inside 300 m, stop, moor (T) at ~0.3 kn → the card shows A or A+, six parts, the bonus line; the money
   chip rises by the bonus; Replay draws the patch, the track turning green as she slows, and animates the ship box.
2. Bump the quay at ~1.5 kn first, then moor → "1 bump with the quay (1.5 kn)" and the clean part shows 6/10; at 3.5 kn
   the grade is capped at D with the cap named.
3. Moor again within 6 h → "Bonus already paid here in the last 6 h"; the personal best ribbon only when higher.
4. Request tugs → the Assisted card, no grade.
5. Harbour sheet Overview → "Mooring here" card with best and last; Replay reopens the card with the animation.
6. Phone (390×844): the card is a bottom sheet, scrolls, nothing overflows at 360 px; Close is reachable with a thumb;
   the card does not cover the Moor/Tugs buttons after closing.
7. Warp 5× for the approach: same scoring behaviour (time part in ship time).

---

## 3. ANCHOR — anchoring (with the seamark index)

### 3.1 Goal, in the player's words

"I can stop anywhere it is shallow enough and drop the hook. The chain runs out, she falls back and lies to it, and when
the tide turns she swings round. I see my swing circle and an anchor watch circle. In a gale on bad ground she drags:
an alarm goes off, I see the track she drags, and I can pay out more chain, use the engine to take the strain or heave
up and find better holding. The chart shows the real anchorages, where the holding is good. Waiting at anchor costs no
fuel and no wear, and I can wait at 5×."

### 3.2 Rules and numbers

**Who may drop anchor** (`anchor {op: 'drop'}`), checked in this order, each refusal with its text:

| Check | Refusal |
|---|---|
| not docked, not under tugs, not in the raft | (silently ignored) |
| not towing (`p.towing`) | "Slip the tow first — you cannot anchor with a casualty on the line." |
| nets in (`!p.fishing`) | "Haul in the nets first (F)." |
| sails furled on a sailing yacht (`p.sailsUp === false` or not a sail class) | "Hand the sails first — she would sail over her own anchor." |
| speed through the water `abs(p.ship.spd) ≤ MAX_DROP_KN` (1.5) | "Too fast to let go — slow below 1.5 kn (you make 3.2 kn)." |
| depth at the bow point (§3.3 `bowPoint`) ≥ draught + `MIN_UKC_M` (1) | "Too shallow to anchor: 4.1 m of water, you draw 5.5 m." |
| depth ≤ `maxDepthM(C)` | "Too deep to anchor here: 84 m of water — your 270 m of chain holds in 60 m at most. The charted anchorages (magenta on the chart) have 20 m." |
| not on a fairway cell of a built patch (`geom.maskAt = FAIRWAY`; harborgeom paints every dock basin as FAIRWAY too, so this also refuses anchoring inside the port's basins) | "Not in the fairway or the harbour basins — anchor outside, clear of the channel." |
| swing room: no point of the swing circle (16 points, radius `swingRadiusM`) inside land or a quay on a built patch (`landPenetration > 0`) | "Not enough swing room: the quay is within your 138 m swing circle." |

**Depth for anchoring** (`anchorDepthAt(lat, lon)` in `server/anchorage.js`, the same rule in the client's button
hint): on a built patch the patch bed + tide; **inside a charted anchorage** (OSM or synthetic, `seamarks.anchorageAt`)
`min(world.depthAt, area.depthM) + tide` with `area.depthM` = `ANCHOR.ANCHORAGE_DEPTH_M` (20 m) unless OSM tags a depth;
elsewhere `world.depthAt + tide`. Why: the synthetic sea bed (`heightFromDistance` in `server/world.js`: 4 m + 8 m per
coarse cell from the coast) is 60 m deep 2–4 km off any coast and 155 m 6 km west of the Maas entrance, so without the
charted depth every real anchorage (20–30 m in reality) would refuse a coaster. Anchorages are where real ships anchor;
the chart and the card say "charted 20 m" there. Real bathymetry (wave 4) removes the special case.

Warnings (anchoring still happens): shallower water than draught + 1 m at low water somewhere on the swing circle
(coarse raster, `world.depthAt + lowWaterAt`); another ship's anchor within 300 m; inside 1 km of a harbour approach line
(seamark index) — "You are anchored in the approach to Rotterdam — other ships will have to go round you."

On drop: the autopilot and any offline voyage are switched off (`p.voyage = null`), warp above 5× steps down to 5×
(`capWarp`), `sound.event('anchor')` on the client, event "Let go the anchor in 24 m, sand. Paying out 120 m of chain
(scope 5)."

**AnchorState** (`p.anchor`, saved):

```ts
AnchorState = {
  lat, lon,                    // the anchor on the seabed (server truth; moves when dragging)
  dropLat, dropLon,            // where she let go (watch circle centre; drag track start)
  at: number,                  // unixS let go (standby wage clock with wave 2)
  depth: number,               // water at the anchor when let go, tide included (m)
  chain: number, target: number, chainMax: number,  // m out now, m to pay out to, m carried
  state: 'paying' | 'holding' | 'dragging' | 'weighing',
  ground: 'mud'|'sand'|'clay'|'gravel'|'rock'|'weed', groundSrc: 'osm'|'anchorage'|'default', area: string | null,
  load: number, hold: number,  // kN, last computed
  dragM: number,               // metres the anchor has moved from where it bit
  track: [[lat, lon, t], …],   // anchor path while dragging, ≤ 60 points ≥ 10 m apart
  alarmed: boolean, crewHelp: number /* offline re-anchors */,
}
```

**Chain, depth, swing** (`shared/anchor.js`):

| Quantity | Formula | Coaster | Pilot boat | Feeder | Boxship | Sloop |
|---|---|---|---|---|---|---|
| chain carried `chainMaxM` | clamp(round(3 × L), 60, 385) (small craft carry chain + rode) | 270 m | 60 m | 385 m | 385 m | 60 m |
| deepest anchorage `maxDepthM` | min(60, chainMax / 4) | 60 m | 15 m | 60 m | 60 m | 15 m |
| chain let go `defaultChainM(depth)` | clamp(round(5 × depth), max(25, 3 × depth), chainMax) | 20 m → 100 m | 10 m → 50 m | | | |
| swing radius (ship centre) `swingRadiusM` | √max(0, chain² − depth²) × 0.95 + L/2 | 20 m: 138 m | 10 m: 56 m | 20 m: 168 m | 20 m: 243 m | 8 m: 43 m |
| watch circle | swing radius + max(25, 0.15 × swing), centred on the drop point | 163 m | 81 m | 193 m | 279 m | 68 m |

Pay-out runs at `PAY_MS` 3 m/s of ship time (100 m in 33 s), weighing at `HEAVE_MS` 1 m/s (`'weighing'`: chain shrinks,
the constraint radius with it, so she is drawn up to her anchor). The anchor is aweigh when chain ≤ depth + 2 m:
`p.anchor = null`, event "Anchor aweigh — she is free to manoeuvre." **Veer** (`op: 'veer'`): + one shackle (27.5 m) up
to `chainMax`, state `'paying'` until out, event "Veered one shackle: 147 m out (scope 6.1)." While `'paying'` holding
scales with the chain out (`chain / target`); while `'weighing'` there is no drag computation and no alarm.

**Holding.** `holdingKN(C, ground, scope) = anchorMassT(C) × 9.81 × k(ground) × hhp × fs`:
- anchor mass `anchorMassT = 0.007 × displacement^(2/3)` t (coaster 1.52 t, pilot boat 82 kg, feeder 4.07 t,
  boxship 16.1 t, sloop 23 kg — real stockless anchors for ships, HHP anchors for small craft);
- `k`: mud 4, sand 6, clay 7, gravel 4.5, rock 1.5, weed 2.5; a charted anchorage without a seabed tag counts as
  "mud and sand (charted anchorage)" k 6.5;
- `hhp` = 4 for hulls under 40 m (modern high-holding-power anchors), else 1;
- scope factor `fs = clamp((scope − 2) / 3, 0.2, 1.2)` with `scope = chain / depthNow` (depthNow = the anchor's depth with
  the tide now: a rising tide shortens the scope).

**Ground** (decided once when the anchor bites, and again where a dragging anchor bites anew; deterministic so every
skipper finds the same bottom): `game.seamarks.seabedAt` — an OSM `seabed_area` polygon containing the anchor gives its
surface (`groundSrc: 'osm'`); else `anchorageAt` — a charted anchorage gives k 6.5 (`'anchorage'`); else
`defaultGround(lat, lon, depth)` (`'default'`) — a hash of the 0.01° cell (FNV-1a of
`"${floor(lat×100)},${floor(lon×100)}"` → u ∈ [0, 1)) picks from a table by depth: < 15 m sand .50 mud .20 gravel .15
clay .05 weed .07 rock .03; 15–40 m sand .40 mud .35 clay .12 gravel .08 weed .02 rock .03; > 40 m mud .55 clay .20 sand
.15 gravel .05 rock .05 (cumulative in that order).

**Load** (`envLoad`, kN, a vector east/north; the same environment as `stepShip`):
- wind: `0.5 × 1.225 × A_w × V² / 1000` along the wind, `A_w = 1.5 × B × clamp(0.11 L + 2, 2, 30)` m² (coaster 250 m²);
- current (current + tidal stream, `currentAtPos`): `0.5 × 1025 × 0.06 × A_c × Vc² / 1000`, `A_c = L × draught` — a ship
  lying head to the stream (longitudinal coefficient 0.06 on the underwater side area; coaster 15.2 kN per (m/s)²). The
  first draft used 0.6 on 1.5 × B × draught (35.5 kN per (m/s)²): a coaster then dragged in **calm** weather in every
  spring stream above 1.6 m/s — the Dover Strait, the Channel Islands, Pentland — and on mud off Rotterdam in a force 5;
  anchors would have dragged nearly always where the tide runs;
- waves: `0.1 × B × Hs²` along the wave direction (from `weatherAt().waves`);
- engine: `−thrustFullKN(C) × throttle` along the bow (`thrustFullKN = 0.25 × displacement^(2/3)`; coaster 54 kN at full),
  so "steaming to the anchor" takes the strain;
- total `|F| × (1 + 0.08 × Hs)` (snatch loads).

Reference loads (wind m/s, current 0.5 m/s, Hs m — all aligned) against holding at scope 5:

| Class | F6 (12, 1.5) | F7 (15, 2.5) | F8 (20, 3) | F9 (24, 4) | sand | mud | rock |
|---|---|---|---|---|---|---|---|
| coaster | 32.5 | 56.4 | 96.3 | 151.0 | 89.5 | 59.6 | 22.4 |
| feeder | 82.8 | 139.9 | 241.3 | 373.8 | 239.3 | 159.6 | 59.8 |
| boxship | 238.1 | 391.0 | 675.9 | 1,034.6 | 945.9 | 630.6 | 236.5 |
| pilot boat | 4.9 | 9.9 | 16.4 | 27.2 | 19.3 | 12.9 | 4.8 |
| sloop | 2.8 | 5.8 | 9.5 | 15.9 | 5.4 | 3.6 | 1.4 |

(Charted anchorage, k 6.5: coaster 96.9, feeder 259.3, boxship 1,024.7 kN.) So a coaster holds in sand and, just, in mud
to force 7 and drags in force 8 (on mud by a wide margin); on rock from force 6; in a charted anchorage she holds in
force 8 and drags in force 9. In force 8 on sand, veering to scope 7 (fs 1.2 → 107.4 kN) or slow ahead (−24.4 kN of
strain before the snatch factor: (77.6 − 24.4) × 1.24 = 66.0 kN) each hold her; in force 9 (raw 114.4 kN) even both
together do not ((114.4 − 24.4) × 1.32 = 118.8 > 107.4) — find better holding or heave up and ride it out at sea. A
container ship's windage drags her on mud in force 8. Tide alone: a coaster in a calm 2 m/s spring stream (Dover
Strait) loads 67.7 kN — she holds on sand, drags on mud. Dragging is therefore an event of gales, poor ground and the
strongest streams, never the normal state, and never impossible (the debug `loadMul` forces it for checks).

**Drag.** Every server pass (≥ 1 s real) for an anchored ship in `'holding'`, `'dragging'` or `'paying'`:
`load = |envLoad| × (debug loadMul)`, `hold = holdingKN(…)`.
- `load > hold` → `'dragging'`: the anchor moves along the load direction at `dragSpeedMS = clamp(0.6 × (load / hold − 1),
  0.05, 1.2)` m/s of ship time (coaster in force 8 on sand 0.05 m/s, the minimum; force 9 ≈ 0.41 m/s ≈ 0.8 kn); `dragM` grows; the
  anchor track gains a point every 10 m.
- `'dragging'` and `load < 0.9 × hold` for 10 ship-seconds → the anchor bites again: `'holding'` at its new place.
- **Alarm** once per drag episode when `dragM ≥ DRAG_ALARM_M` (20 m): event `warn` "ANCHOR DRAGGING — 23 m from where she
  bit, 0.9 kn towards the north-east. Veer chain, use the engine or heave up."; warp drops to 1× (`dropWarp(p, 'Anchor
  dragging.')`); `stats.anchorDrags++`. The client sounds the alarm (§3.7).

**The ship at anchor (client).** `constrainToAnchor(s, a, C, dt)` once per frame from the `simulate` after-advice (C5,
`dt` = frame time × warp; at ≤ 5× the drift per frame is centimetres, so per-substep application is not needed): with `R = swingRadius`
(chain interpolated during paying/weighing), when the ship's centre is further than R from the anchor it is moved back
onto the circle along the anchor bearing and the outward part of its velocity removed (`s.spd` × max(0, cos of the angle
between the bow and the anchor bearing) when the bow points away); when taut (distance ≥ 0.97 R) she weathervanes: the
heading turns towards the bearing ship → anchor at up to `YAW_DPS` 1.5°/s of ship time. With `stepShip`'s own drift
(current + tidal stream + 2 % wind) she falls back down-stream and lies to her chain; when the stream turns she drifts
across the circle and swings round. The engine order at anchor is clamped to [`THR_MIN` −0.3, `THR_MAX` 0.45] (slow
astern … slow ahead) on the telegraph itself (C4); the server does not trust it and computes the engine strain from the
reported throttle clamped the same way.

**Server checks.** `rejectState(p, lat, lon)`: a state further than `R + 60 m` from the server anchor (R with the
chain out) is rejected with a correction (`sendYou(p, { correction: true })`) and the ship is put at the equilibrium point
(anchor + R along the drift direction); warning rate-limited to one per 10 s ("Position corrected: she cannot be further
than her chain from the anchor.").

**Not under way.** No hook needed (G18 dropped): a ship lying to her anchor has throttle 0 and ≈ 0 speed through the
water, so today's `tick` already charges no fuel (`|throttle| > 0.01`), no hull wear and no wages (`underway` false).
With the engine turning she pays fuel, wear and wages like any ship under way. The ship's clock runs at the warp level
(TIME's `shipRate`, unchanged). `constrainToAnchor` must not leave `s.spd` above 0.5 kn while she merely swings: it
removes the outward part of the velocity and lets `stepShip`'s drag decay the rest.

**Offline at anchor (the anchor watch crew).** `Anchorage.tick` keeps computing load and drag for offline skippers at
1 Hz of real time. The ship is placed at the equilibrium point (anchor + R along the drift direction of current, tidal
stream and 2 % wind; heading towards the anchor). When she drags: (1) the crew veers to `chainMax` (once); (2) if she
still drags and water shallower than draught + 1 m lies within R + 2 L down-wind of the anchor (8 samples along the load
direction) and there is fuel, the crew heaves up and re-lets go at the drop point (`crewHelp++`, fuel − half an hour at
slow ahead, log line "The anchor watch found her dragging towards the shallows off Hook of Holland and re-anchored at
51.98° N 3.95° E."); (3) without fuel she keeps dragging; when the equilibrium point is shallower than the draught she is
aground: `grounding(p)` **once per drag episode** (the existing −5 % hull), the anchor stops dragging and she lies
aground until the skipper returns (no further damage; §8 asks whether a storm should be allowed to do more).

**Warp at anchor** (G20, §3.4, all through before-advice on WARP-HARBOUR's methods): 5× at most (`ANCHOR.WARP_MAX`), with or without a route; fuel is not needed; only
skippers **under way** (not anchored, not moored) within 1.5 km (`WARP.HARBOR_PLAYER_M`) stop it, inside or outside a
harbour zone; flooding, storms, hails and the raft stop it as everywhere. A drag alarm drops it to 1×.

### 3.3 Pure API — `shared/anchor.js`

```js
export const ANCHOR = {
  MAX_DEPTH_M: 60, MIN_SCOPE: 4, MIN_UKC_M: 1, MAX_DROP_KN: 1.5, SCOPE: 5, MIN_CHAIN_M: 25, CHAIN_PER_L: 3, CHAIN_MIN_M: 60, CHAIN_MAX_M: 385,
  ANCHORAGE_DEPTH_M: 20,
  SHACKLE_M: 27.5, PAY_MS: 3, HEAVE_MS: 1, AWEIGH_EXTRA_M: 2, CATENARY: 0.95,
  MASS_K: 0.007, HHP_BELOW_M: 40, HHP_MUL: 4, THRUST_K: 0.25,
  WIND_CD_AREA: 1.5, CURRENT_CD: 0.06 /* on L × draught */, WAVE_K: 0.1, SNATCH_K: 0.08,
  DRAG_K: 0.6, DRAG_MIN_MS: 0.05, DRAG_MAX_MS: 1.2, REBITE_FRAC: 0.9, REBITE_S: 10, DRAG_ALARM_M: 20, TRACK_STEP_M: 10, TRACK_MAX: 60,
  WATCH_MIN_M: 25, WATCH_FRAC: 0.15, REJECT_TOL_M: 60, YAW_DPS: 1.5, TAUT: 0.97,
  THR_MIN: -0.3, THR_MAX: 0.45, WARP_MAX: 5, OTHER_ANCHOR_WARN_M: 300, APPROACH_WARN_M: 1000,
};
export const GROUNDS = { mud: { name: 'Mud', k: 4 }, sand: { name: 'Sand', k: 6 }, clay: { name: 'Clay', k: 7 },
  gravel: { name: 'Gravel', k: 4.5 }, rock: { name: 'Rock', k: 1.5 }, weed: { name: 'Weed', k: 2.5 },
  anchorage: { name: 'Mud and sand (charted anchorage)', k: 6.5 } };
export function chainMaxM(C) / maxDepthM(C) / anchorMassT(C) / windageM2(C) / currentAreaM2(C) / thrustFullKN(C)
export function defaultChainM(C, depthM)
export function swingRadiusM(C, chainM, depthM)
export function watchRadiusM(C, chainM, depthM)
export function bowPoint(s, C)                                      // { lat, lon } L/2 ahead of the centre
export function holdingKN(C, groundKey, scope)
export function envLoad(C, { wind, current, waveH, waveDir }, hdgDeg, throttle) // → { e, n, kN, dirDeg } (kN east/north; dirDeg = where the load pushes)
export function dragSpeedMS(loadKN, holdKN)
export function defaultGround(lat, lon, depthM)                     // the hash table above
export function driftDir(env)                                       // bearing the ship drifts to: current + tide stream + 0.02 × wind
export function constrainToAnchor(s, a, C, dt)                      // mutates s; → { taut, distM }
```

Browser-safe (imports `shared/constants.js`, `shared/geo.js` only). The client imports it statically.

### 3.4 Server — `server/anchorage.js` and the warp advice

```js
export class Anchorage {
  constructor(game)
  action(p, m)                      // op 'drop' | 'weigh' | 'veer'; anything else → warn "Anchor: drop, weigh or veer."
  drop(p); weigh(p); veer(p)
  tickAll(dt)                       // G17 (tick after-advice): tick(p, dt) for every anchored player not docked / under tugs / in the raft
  tick(p, dt)                       // work at ≥ 1 s real intervals: chain pay-out / heave, load, hold, drag, alarm,
                                    //   offline crew, equilibrium (offline)
  clear(p)                          // G7, G19: p.v7.anchor = null (no event; setDocked and sink explain themselves)
  rejectState(p, lat, lon, nowMs)   // G4 → true when the state was rejected and corrected
  anchorDepthAt(lat, lon)           // §3.2 "Depth for anchoring" → { depth, src: 'patch' | 'anchorage' | 'world', area }
  warpConditions(p)                 // G20, for anchored ships only (below)
  view(p)                           // AnchorView | null
  debug(p, m)                       // SALTLINE_DEBUG only: { loadMul } multiplies this player's load (0.1–10) until weighed
  stats()                           // { anchored, dragging, crewHelps }
}
export function installAnchor(game, hooks)   // G2 (SeamarkIndex + Anchorage), G4, G6 (anchor, debug_anchor), G7, G8, G11, G15, G17, G19–G24; hooks.field('anchor'); hooks.harbor → { anchorage }
```

Patch depth: `−bedAt(grid, ...toXZ(grid, lat, lon)) + tide` with `grid = gridFromPatch(geom.getHarborPatch(id))`
(cached per harbour in a WeakMap keyed by the patch buffer); the patch wins wherever it covers the point
(`landPenetration !== null`).

**Warp advice (G20).** WARP-HARBOUR's methods are not edited; `installAnchor` and `installPilot` register before-advice
(PILOT is installed first, so its handler runs first):

```js
// PILOT
hooks.on('before', 'warpConditions', (p) => { const r = game.pilotage.warpReason(p); return r ? stop(r) : undefined; });
// ANCHOR — every handler is a no-op unless the ship is anchored
const anchored = (p) => !!p.v7?.anchor && !p.docked && !p.assist;
hooks.on('before', 'warpConditions', (p) => (anchored(p) ? stop(game.anchors.warpConditions(p)) : undefined));
hooks.on('before', 'warpBlock', (p, f) => {
  if (!anchored(p)) return undefined;
  const why = game.warpConditions(p);              // advised: PILOT, then the anchor's conditions
  return stop(why || (f > ANCHOR.WARP_MAX ? `at anchor time warp is limited to ${ANCHOR.WARP_MAX}× — the anchor watch has to see her drag.` : null));
});
hooks.on('before', 'checkWarp', (p) => {
  if (!anchored(p)) return undefined;
  const f = game.warpOf(p); if (f <= 1) return stop();
  const why = game.warpConditions(p);
  if (why) game.dropWarp(p, cap(why)); else if (f > ANCHOR.WARP_MAX) game.capWarp(p, ANCHOR.WARP_MAX, `At anchor — ${ANCHOR.WARP_MAX}× at most.`);
  return stop();
});
hooks.on('before', 'warpLimit', (p) => {
  if (!anchored(p)) return undefined;
  const why = game.warpConditions(p), z = game.harbourZone(p);
  const harbour = z ? { id: z.harbor.id, name: z.harbor.name, distM: Math.round(z.distM), kind: z.kind } : null;
  return stop({ max: why ? 1 : ANCHOR.WARP_MAX, reason: why ? cap(why) : `At anchor — ${ANCHOR.WARP_MAX}× at most.`,
                routeAbove: WARP.MAX_NO_ROUTE, anchor: true, ...(harbour ? { harbour } : {}) });
});
```

`Anchorage.warpConditions(p)` (anchored ships only) in this order: offline → `'you are offline.'`; hailed → `'the coast
guard is hailing you.'`; raft → `'you are in the life raft.'`; `p.flooding > WARP.MAX_FLOODING` → the same text as
WARP's; another online skipper **under way** (not docked, not in the raft, not anchored) within `WARP.HARBOR_PLAYER_M`
(own loop over `game.byId`, the shape of `nearestOtherSkipper`) → `'Ann is 900 m away and under way — at anchor, warp needs
1.5 km between you and ships under way.'`; `weatherAt().storm > WARP.MAX_STORM` → WARP's storm text; else null. No fuel
check (no engine is needed at anchor), no land look-ahead (≤ 5×), no route rule (5 ≤ 20). `cap` is a private copy of
`capitalise`. The `anchor` key appears in `warpLimit` only while anchored, so WARP's `deepEqual` tests stay valid.

### 3.5 The seamark index — `server/seamarks.js`

Anchorages, seabed areas and pilot boarding points lie outside the 3.2 km harbour OSM query (`buildOverpassQuery`), so
the index has its own query, cache and synthetic fallback. Used by ANCHOR (anchorages, ground, approach warnings, the
chart) and PILOT (boarding points).

```js
export const SEAMARKS = { RADIUS_M: 25000, TTL_MS: 30 * 864e5, EMPTY_TTL_MS: 864e5, SCHEMA: 1, TYPES: ['anchorage', 'anchor_berth', 'pilot_boarding', 'seabed_area'],
  BP_MIN_M: 3000, BP_MAX_M: 30000, SYN_BP_KM: [10, 9, 11, 8, 12], SYN_BP_MIN_DEPTH: 15,
  SYN_ANCH_KM: [6, 5, 7, 4, 8, 10, 12], SYN_ANCH_OFF_KM: [2, -2, 3, -3, 1.5, -1.5], SYN_ANCH_R_M: 1200, SYN_ANCH_MIN_DEPTH: 15 };
export function buildSeamarkQuery(lat, lon, radiusM = SEAMARKS.RADIUS_M)
  // `[out:json][timeout:60];(nwr["seamark:type"~"^(anchorage|anchor_berth|pilot_boarding|seabed_area)$"](around:R,lat,lon););out geom;`
export function parseSeamarks(json)
  // → { anchorages: [{ id, name, ring: [[lat, lon]] | null, lat, lon, radiusM, category, depthM }], berths: [{ id, name, lat, lon, radiusM }],
  //     pilot: [{ id, name, lat, lon }], seabed: [{ ring, surface }] }   (ways/relations → rings; nodes → points;
  //     anchor_berth nodes become 150 m discs; seabed surface from `seamark:seabed_area:surface`, first value of a ';' list;
  //     depthM = a numeric `seamark:anchorage:depth` / `depth` tag clamped to 5–40, else ANCHOR.ANCHORAGE_DEPTH_M (20))
export class SeamarkIndex {
  constructor({ world, geom, log, dir = path.join(DATA_DIR, 'seamarks'), fetchImpl = globalThis.fetch })
  enableFetch()                        // server.js only: stale or missing caches are refreshed in the background, one request at a time
  forHarbor(id)                        // { harbor, source: 'osm'|'synthetic'|'mixed', anchorages, berths, pilot, seabed, approach: { lat, lon, brg } , at }
                                       // sync: cache file if present (any age), else synthetic; never blocks on the network
  boardingPoint(id)                    // { lat, lon, name, source } — the nearest OSM pilot_boarding 3–30 km from the harbour anchor, else synthetic
  anchorageAt(lat, lon)                // { harborId, id, name, approx, depthM } | null (point in ring or disc; harbours within 40 km checked)
  seabedAt(lat, lon)                   // { surface, source: 'osm' } | null
  approachNear(lat, lon, maxM)         // { harborId, distM } — distance to the segment harbour anchor → boarding point
  summaryFor(id)                       // { name, distM, brg, approx } of the nearest anchorage (harbour sheet)
  inBbox(latMin, lonMin, latMax, lonMax) // harbours within the box + 30 km: [{ id, name, source, anchorages, pilot }]
  async prefetchAll({ delayMs })       // every harbour, oldest cache first (scripts/fetch-seamarks.mjs calls this)
  stats()                              // { cached, synthetic, fetching, failures, lastFetchAt }
}
```

**Synthetic** (deterministic, computed lazily per harbour and memoised): the approach bearing is harbour anchor → the
fairway's outer end (`geom.fairway.at(-1)`) when the harbour is built, else the bearing of the deepest of 16 rays sampled
every 500 m to 10 km (`world.depthAt`). Boarding point: the first distance in `SYN_BP_KM` along the approach from the
fairway end (or the anchor) whose `world.depthAt ≥ 15 m`, else the deepest of them; name "<harbour> pilot station".
Anchorage: the first (distance, offset) pair from `SYN_ANCH_KM × SYN_ANCH_OFF_KM` (km along the approach, km to the side)
whose centre and 8 points at 1,200 m are all water with `world.depthAt ≥ 15 m` (navigable for every class, draught ≤ 14 m),
outside every built patch (`landPenetration === null`), and whose centre is ≥ 2 km from the approach line; a 1,200 m
disc named "<harbour> outer anchorage", `approx: true`, `depthM: 20` (the charted depth of §3.2). The first draft asked
for 12–40 m of *world* depth on the whole disc: the synthetic bed passes 12–40 m in a band only about 1 km wide along the
coast, so a 2.4 km disc almost never fitted and most harbours would have had no anchorage at all. No candidate (an
enclosed harbour such as Shanghai) → no synthetic anchorage; the harbour sheet then says "No charted anchorage nearby".

**Cache:** `data/seamarks/<harborId>.json` = `{ schema, fetchedAt, radiusM, data: parseSeamarks(raw) }`, written to
`<file>.<pid>.tmp` and renamed; `.gitignore` gets `data/seamarks/`. Fetching uses the `OVERPASS_ENDPOINTS` and
`USER_AGENT` of `server/osm.js` (imported), one request at a time, 45 s timeout, an empty answer retried after a day, a
failure backs off 10 minutes. The dev container has no Overpass access: run `node scripts/fetch-seamarks.mjs` on the
production box (it calls `prefetchAll` and prints a line per harbour).

### 3.6 Messages and HTTP

```ts
AnchorView = { lat, lon, dropLat, dropLon, state, chain, target, chainMax, depth, depthNow, scope,
               radiusM, watchM, ground, groundName, groundSrc, area: string | null,
               load: number, hold: number, ratio: number /* load / hold */, dragM, dragKn: number, track: [[lat, lon]], crewHelp }
```

`publicState(p).anchored` (true while anchored). `anchor { op }` actions. Events as quoted in §3.2.

`GET /api/seamarks?bbox=latMin,lonMin,latMax,lonMax` → `{ time, harbors: [{ id, name, source, anchorages: [{ id, name,
ring | null, lat, lon, radiusM, category, approx, depthM }], pilot: { lat, lon, name, source } | null }] }`; 400 on a bad box or a
box larger than 30° × 60°; `Cache-Control: public, max-age=600`.

### 3.7 Client — `public/js/anchor.js`, `public/css/anchor.css`

```js
export class AnchorUI {
  constructor(app)              // ensureCss('anCss', 'css/anchor.css'); an "Anchor (Q)" dockBtn before #btnMore on desktop,
                                // a menuBtn in #moreSheet on touch; the anchor card in #ctxStack (hidden)
  toggle()                      // Q / button: drop when free, weigh when anchored, nothing while weighing (event "Heaving up — 42 m to go.")
  onYou(you, prev)              // card, button label, autopilot off on drop (this.app.pilot?.engage(false)), alarm on a new drag episode
  anchorNow(a)                  // the anchor with the chain interpolated between 1 Hz updates (pay-out / heave rates)
  update(dt, now)               // 3D: chain, anchor ball / light, swing and watch rings, drag track; others' anchor balls
  drawChart(chart, ctx)         // anchorages, your anchor, swing + watch circles, drag track
  popupRows(h, body)            // chart harbour popup: anchorage name, distance, holding; pilot station
  radarContacts()               // [{ kind: 'job', lat, lon, color: '#c58cff', label: 'Anchor', radiusU: watchM }] (GEO.SCALE = 1: units are metres)
  showAnchorage(harborId)       // open the chart centred on that harbour's anchorage
  overviewCard(h, you)          // harbour Overview card "Anchorages nearby": name, distance and bearing, holding, "approximate" when synthetic, [Show on chart]
}
export function installAnchorUi(app, hooks)   // C2, C4, C5, C6, C8, C9, C12 anchorageChart, C13, C14, C15, C16 → returns the AnchorUI
```

- **Button** "Anchor" (icon `anchor`): hidden while docked or under tugs; disabled with the reason in its title when the
  client can already tell (speed > 1.5 kn, depth from `app.terrain.heightAt` + tide — or the charted 20 m inside an
  anchorage known from `/api/seamarks` — outside the limits); the server decides. Anchored: "Weigh"; weighing:
  "Heaving…" (disabled). The existing Dock button also uses the `anchor` icon, so the Anchor button always shows its
  text label, also on desktop.
- **Key Q:** AnchorUI's own `keydown` listener (C16), not a line in `bindInput` (wave 2 edits that function).
- **Anchor card** (`#anchorCard`, a `ctxCard`): header "At anchor · Maas outer anchorage" (or the position), facts
  "Sand · 120 m in 24 m · scope 5.0", a load bar (green < 60 %, amber < 90 %, red ≥ 90 %) "Load 35 % of holding", the
  watch plot (canvas 96 px: watch circle, swing circle, anchor, the last 10 minutes of the ship's track — the GPS anchor
  alarm every sailor knows), buttons **Veer chain** and **Weigh**. Dragging: the card turns red, "DRAGGING · 23 m ·
  0.9 kn NE", the alarm (`sound.event('alarm')` if wave 2 has merged, else `sound.ui('warn')`) repeats every 10 s until
  the load drops below holding or the skipper presses **Silence**.
- **Phones:** the card collapses to a one-line pill "⚓ Holding · 35 %" (44 px) unless dragging; pills stack under the one
  expanded card (priority in §6.3). Buttons ≥ 44 px. Dropping the hook must not need two taps into the More sheet at the
  moment it matters (a drifting ship with an empty tank): while at sea under 1.5 kn, not docked, not under tugs and in
  anchorable water by the client's estimate, a pill "⚓ Anchor here" (44 px) shows in the pill slot and drops the anchor
  on tap; the More-sheet button stays for the other cases.
- **3D:** a chain line from the bow (deck height) down to the water at 6 % of R towards the anchor; an anchor ball (black
  sphere, radius 0.3 + 0.004 L m) above the bow by day and an all-round white light by night (`app.night > 0.5`), also on
  other skippers' ships with `anchored`; the swing circle (thin dashed white ring at tide level) and the watch circle
  (amber, red while dragging) while the camera is above 40 m or the chart is closed; the drag track (red line through
  `track`).
- **Chart** (drawn from the `chart.draw` after-advice, C14, on top of the other layers): anchorages as dashed magenta
  outlines (`#c45ab3`, the chart symbol colour) with a small anchor glyph AnchorUI draws itself (chart.js has no anchor
  symbol) at zoom ≥ 7, the name at zoom ≥ 9 and "(approximate)" for synthetic ones; pilot stations as a
  magenta circle with "Pilots" (also drawn by PILOT for its job, §4.6); your anchor, swing and watch circles, the drag
  track. Data from `/api/seamarks` for the visible box, refetched when the view moves more than half its size, cached
  10 minutes per rounded box.
- **Warp UI:** `setWarp` (and through it `stepWarp`) refuses above 5× at anchor (`you.warpLimit.anchor`) with "At anchor
  time warp is limited to 5×." (C6); the warp control's label reads "Anchor" (C9).
- **Simulation:** the telegraph clamp before `simulate` (C4) and `constrainToAnchor` once per frame after it (C5).

### 3.8 With wave 2

- No wave 2 file changes: the anchor lives in `p.v7` and v7's own file (§1.8), not in `VESSEL_KEYS`.
- **Wages** (phase C, by the integrator, after both trees have merged — the only v7-motivated line in a wave 2 function,
  written serially when nobody else edits it): wave 2 accrues wages at sea whether the ship moves or not, so an anchored
  ship would pay the full sea rate forever. The integrator changes the at-sea wage state in wave 2's `tick` to
  `p.v7?.anchor ? 'moored' : 'sea'` (moored = full for the first 24 h counted from `anchor.at`, then 30 % standby) and
  adds "anchor let go / aweigh" to wave 2's settle-before-rate-change list by calling wave 2's settle from the `anchor`
  action. Until then an anchored ship pays sea wages — the same as moored for the first 24 h.
- Limits: wave 2's `applyLimits` clamps the per-substep `cmd` inside `simulate`; v7 clamps the telegraph before it (C4),
  so the order does not matter. A wave 2 engine failure (`maxThrottle 0`) leaves the anchor working; "steaming to the
  anchor" then has no thrust.
- Insurance: drag groundings go through `grounding(p)` and are recorded as wave 2 damage like any other.

### 3.9 Edge cases

| Case | Behaviour |
|---|---|
| Out of fuel, drifting onto a lee shore | let go (no engine needed) — the classic save; warp 5× allowed at anchor without fuel. |
| Anchored in a strong tidal stream | she lies to the stream, swings at the turn; the load includes the stream. |
| Tide rises 4 m | scope drops (depthNow), holding with it; the card shows the new scope. |
| Dragging into the harbour patch towards a quay | the client's collision resolver stops the hull at the quay (contact damage as usual); the anchor keeps dragging until it bites or she grounds. |
| Two skippers anchored 200 m apart | swing circles may overlap: ship–ship collisions as usual; the drop warns "another anchor within 300 m". |
| Coast guard hail at anchor | heave-to is satisfied (under 2 kn). |
| Express passage, set voyage, fishing, tugs, docking while anchored | refused with "Weigh anchor first (Q)". |
| Tow (call a tow) while anchored | `setDocked` clears the anchor (the tug slips it for you). |
| Sinking at anchor | the anchor is cleared with the ship. |
| Buying a ship at a berth | not possible at anchor (docked only). |
| Disconnect while weighing | the crew finishes heaving up offline (state machine runs on the server); she then drifts (offline skippers without a voyage are not moved, as today). |
| Server restart at anchor | `p.anchor` is saved; the ship comes back at anchor at the saved position. |
| AI traffic | does not avoid anchored players (no COLREGS yet, v7 batch 3); contacts as today. |
| Anchoring inside a built basin | refused: harborgeom paints every dock basin as FAIRWAY, so the fairway check says to anchor outside. |
| Pilot boat or yacht wanting to anchor | 60 m of chain: up to 15 m of water — close inshore or in a built patch outside the fairway; not in the 20 m charted anchorages (realistic: small craft use the shallows). |
| Synthetic sea bed 155 m deep 6 km off the Maas | anchor in the charted anchorage (20 m charted) or within ~2 km of the coast; the refusal text points to the chart. |

### 3.10 Tests — `test/anchor.test.mjs`, `test/seamarks.test.mjs`

`test/anchor.test.mjs`:
1. *Numbers:* the class table of §3.2 (`chainMaxM` incl. 60 m for the pilot boat and the sloop, `maxDepthM` 15 m for
   both, `anchorMassT` to 3 decimals, swing radius at 20 m); holding and load table rows for coaster, feeder, boxship,
   pilot boat, sloop to 0.1 kN (current coefficient 0.06 on L × draught); the calm 2 m/s stream on a coaster = 67.7 kN;
   the F8/F9 veer-and-engine arithmetic of §3.2; `fs` at scope 3/5/7;
   `dragSpeedMS(132.1, 89.5)` = 0.6 × 0.476; `defaultGround` deterministic and the frequencies of 20,000 cells within
   ±2 % of each table.
2. *Constraint:* a ship drifting at 0.5 m/s east for 600 s of 0.05 s substeps with an anchor 50 m west ends within R of
   it, heading west ± 2°, never further than R + 0.5 m after any substep; when the drift turns west she crosses and ends
   heading east.
3. *Drop refusals:* too fast (2 kn), too deep (crafted depth via a stub `g.world.depthAt` → 84 m), too shallow, towing,
   nets, sails set on a sloop, fairway mask (fake geom `maskAt` → 5), swing room (fake `landPenetration` > 0 on the
   circle) — each with its text. *Charted depth:* world depth stubbed 155 m but a stub `g.seamarks.anchorageAt` returning
   `{ depthM: 20 }` → the drop succeeds with `depth` 20 + tide and ground `anchorage`.
4. *Drop and lie:* coaster at OPEN_A, depth stubbed 24 m: `p.anchor` with chain target 120, `'paying'`, after 40 s of
   ticks `'holding'`; `you.anchor` view fields; `publicState(p).anchored === true`; the autopilot voyage cleared.
5. *Not under way* (no game.js hook — today's `underway` rule): anchored, `p.ship.throttle = 0`, `p.ship.spd = 0.1`,
   600 ticks at 1× and 5×: fuel, cond and money unchanged; with throttle 0.3 fuel burns, wages and wear accrue.
6. *Drag:* stub `g.weatherAt` (wind 24 m/s, waves 4 m) and `g.currentAtPos`: the anchor moves along the load direction
   at `dragSpeedMS × warp` within 5 %, the alarm event once at 20 m, `p.warp` dropped from 5 to 1, `track` points 10 m
   apart; calm again → `'holding'` after 10 s.
7. *Veer and weigh:* veer adds 27.5 m up to `chainMax`; weigh shrinks the chain at 1 m/s and ends with `p.anchor ===
   null` and the aweigh event.
8. *Warp* (all through the advice of §3.4, with `installV7` and both PILOT and ANCHOR installed): anchored with fuel 0 → `set_warp 5` accepted; 20× refused `/at anchor time warp is limited to 5×/`; anchored
   at 20× (crafted) → `checkWarp` caps to 5; `warpLimit` deepEquals `{ max: 5, reason: 'At anchor — 5× at most.',
   routeAbove: 20, anchor: true }`; another skipper anchored 1 km away does not block, one under way 1 km away does.
9. *onState:* a state 300 m outside the circle → correction and equilibrium position; inside → accepted.
10. *Guards:* dock, tug_assist, express, set_voyage, fish refused at anchor; tow clears the anchor; sink clears it.
11. *Offline crew:* anchored offline near a crafted shoal with storm loads → veer once, then re-anchor at the drop point
    with fuel spent and the log line; without fuel → one grounding per drag episode, then she lies still.
12. *Persistence:* `v7state.json` round trip keeps `p.v7.anchor`; it is not in `state.json`; a malformed `anchor` (no lat)
    loads as null; an anchor on a docked player is dropped.
13. *Isolation:* a Game without `installV7` behaves exactly as today (`anchor` actions warn "Unknown action anchor");
    with `installV7` and a throwing `Anchorage.tick` stub, `g.tick(0.1)` still advances everything else.

`test/seamarks.test.mjs`:
1. `buildSeamarkQuery` contains the type regex and `around:25000`.
2. `parseSeamarks(fixture)`: the fixture holds an anchorage way, an anchorage relation with two outer ways, an
   `anchor_berth` node, two `pilot_boarding` nodes, a `seabed_area` with `surface=sand;mud` → the parsed shapes, surface
   `sand`.
3. Synthetic for Rotterdam with the real world raster and `fakeGeom` (fairway pointing west): boarding point 8–12 km out,
   depth ≥ 15 m; the anchorage disc exists, its centre and rim have world depth ≥ 15 m, it is ≥ 2 km off the approach
   line and has `depthM: 20`; deterministic (two calls deepEqual). Across all 86 harbours with the real world raster,
   at least 80 get a synthetic anchorage (the critic's sample found only Shanghai without deep enough open water).
4. `anchorageAt` inside the ring / disc and outside; `seabedAt`; `approachNear`.
5. Cache: a cache file in a temp dir wins over synthetic; `forHarbor` never calls `fetchImpl` unless `enableFetch()` was
   called; after `enableFetch()` a stale file triggers one fetch (spy), a failing fetch backs off.

### 3.11 Browser checks

1. Desktop: sail the coaster into the Rotterdam outer anchorage (magenta on the chart), slow to 1 kn, press Q → the
   chain rattles, the card shows "Mud and sand (charted anchorage) · 100 m in 20 m · scope 5.0" (plus the tide), she falls back and lies to the chain, the swing and watch rings show; the chart
   shows the anchorage outline and your circles.
2. Press `.` → 5×; again → "At anchor time warp is limited to 5×."; the warp label reads Anchor; fuel and hull do not
   change while she lies there.
3. `SALTLINE_DEBUG=1`, `debug_anchor { loadMul: 4 }` → load bar red, DRAGGING, alarm, drag track in 3D and on the chart,
   warp back to 1×; Veer chain and slow ahead bring the load under the holding; she bites again.
4. Weigh → heaving up, she is drawn up to the anchor, "Anchor aweigh".
5. Refusals: Q at 3 kn, 6 km west of the Maas outside the anchorage (155 m: "Too deep … charted anchorages have 20 m"),
   in the Rotterdam fairway, in a dock basin, next to the quay — each with its message.
6. A second browser sees the first ship's anchor ball (day) / anchor light (night) and her swing.
7. Phone (390×844): stopped in the anchorage the pill "⚓ Anchor here" appears and drops the anchor; the Anchor button
   also in More; the pill "⚓ Holding · 35 %" at the top, the full card while dragging with
   Veer / Weigh ≥ 44 px; the chart's anchorages legible; no horizontal scroll.

---

## 4. PILOT — pilot jobs on live AIS ships

### 4.1 Goal, in the player's words

"In the pilot boat I wait near the pilot station. The port calls me when a real ship — one that is really sailing into
Rotterdam right now — is coming in. I race out, meet her before she passes the station, come up on her lee side and hold
exactly her speed and course right next to her ladder until the pilot is aboard. Then I get paid, more for a bigger ship.
She never waits for me: she's real. If the AIS feed is down, there's simply no work."

### 4.2 Rules

**Eligible vessel** (from `game.ais.near(bp.lat, bp.lon, 60 km, { limit: 200 })`):

| Condition | Field |
|---|---|
| class A | `nav !== 'class B'` |
| length known and ≥ 80 m | `length ≥ PILOT_JOBS.MIN_LENGTH_M` |
| under way, at a speed a pilot boat can hold | `navStatus` ∈ {0, 3, 4, 15, null} and `MIN_SOG_KN ≤ sog ≤ min(MAX_SOG_KN, MATCH_FRAC × boatTopKn)` (4 … 18 kn, and at most 80 % of what the boat makes in today's sea — the first draft allowed 25 kn, which a 26 kn boat cannot hold alongside for 30 s in any sea) |
| bound for this harbour | `dest === harbor.id`; or, when `dest` is null and `INFER_DEST` is on, CPA to the boarding point ≤ 1 km and course within 30° of the bearing boarding point → harbour anchor (`destInferred: true`) |
| approaching the boarding point | straight-line CPA of her course (cog, sog) to the boarding point ≤ `CPA_MAX_M` (3 km) and time to CPA between `ETA_MIN_S` (8 min) and `ETA_MAX_S` (60 min) |
| fresh | `nowMs − t ≤ 180 s` |
| free | no job on this MMSI and none finished or failed in the last 6 h (`VESSEL_COOLDOWN_S`) |

The vessel's **hull centre** = the dead-reckoned antenna position + `off[0]` m along her heading + `off[1]` m to
starboard (`off` null → the antenna). Her course for every prediction is `cog ?? hdg`.

**Boarding point** per harbour: `game.seamarks.boardingPoint(h.id)` (OSM `pilot_boarding`, else synthetic 8–12 km out
on the approach). **Pilot station zone**: a 5 km circle around it (`ZONE_M`).

**Offers.** Every `SCAN_MS` (5 s): for each online skipper in a pilot boat (`p.ship.cls === 'pilot'`), not in the raft,
not hailed, without a job — docked or at sea — the harbours whose boarding point is within `OFFER_RANGE_M` (25 km) are
scanned. For each eligible vessel: `reachS = distance(skipper, boarding point) / (REACH_FRAC × boatTopKn)`; offered when
`reachS + REACH_MARGIN_S (120 s) ≤ etaS`. **`boatTopKn`** = `C.maxKn × boatSpeedFactor(…)` from `shared/pilotmath.js`:
`max(0.3, 1 − 0.35 × (1 − cond/100) − 0.35 × sea² − waveSpeedLoss(brg skipper → boarding point, waveH, waveDir))` with
the weather at the boarding point (`game.weatherAt`) — the speed penalty `stepShip` applies (flooding and load ignored).
The first draft used a fixed 0.85 × 26 = 22.1 kn: in the 2.5 m sea that triggers the heavy-weather fee a boat at 80 %
condition makes about 19 kn, so offers would have been unreachable exactly when they pay most. At most 3 offers per skipper, soonest first; an offer lapses after
`OFFER_TTL_S` (5 min) or as soon as it fails these checks.

**Fairness.** The same vessel is offered to every eligible skipper; the first `pilot_accept` wins (server lock by MMSI);
the others' offer turns into "Taken by Ann" for 10 s. One active job per skipper. A vessel is never offered twice within
6 h.

**Accept** (`pilot_accept { offerId }`): re-validated (vessel still eligible, still reachable, skipper still in a pilot
boat; with wave 2, `limitsFor(p).vhf !== false` — "Your VHF is down: the pilot station cannot reach you."). Then the job
starts in state `'intercept'`; event "Pilot job: MSC ANNA (366 m, Panama) for Rotterdam. Meet her at the Maas pilot
station — she is there in 14 min. Pilotage 2,446 cr." Warp drops to 1× (§3.4 line: `warpReason` returns "you are on a
pilot job with a real ship — real time only." while a job runs).

**Alongside** (checked every `CHECK_MS` 500 ms against the server's dead-reckoned hull centre at `Date.now()`; `p.ship` is
the skipper's latest accepted state):

| Check | Rule |
|---|---|
| inside the pilot station zone | the boat within 5 km of the boarding point |
| beside the ladder | `abs(along) ≤ max(LADDER_ALONG_MIN_M (25 m), 0.25 × length)` from her hull centre (an 80 m ship would otherwise give ±20 m, less than the AIS position error) |
| close to her side | hull-to-hull gap `abs(across) − beam/2 − 5.5/2 ≤ LADDER_GAP_M` (25 m — AIS positions are ±20 m) and > −10 m |
| matching speed | `abs(boatSog − sog) ≤ MATCH_KN` (1.5 kn), **both over the ground**: `boatSog`/`boatCog` from the boat's own accepted positions over the last ≥ 2 s (the desk keeps 8 s of `{ t, lat, lon }` per job skipper, sampled every `CHECK_MS`). `p.ship.spd` is speed through the water; in a 1 m/s tidal stream it differs from AIS `sog` by up to 2 kn, so the first draft's `abs(p.ship.spd − sog)` failed skippers who were in fact alongside. Fallback while < 2 s of positions: `p.ship.spd`/`hdg` plus `game.currentAtPos` as a vector |
| matching course | `abs(angleDiff(boatCog, cog)) ≤ MATCH_DEG` (15°) |
| on her lee side | when the wind is ≥ `LEE_MIN_WIND_MS` (6 m/s), the side away from the wind (relative to her heading) |

All true → state `'boarding'`, the hold clock runs (real seconds); a check failing for more than `GRACE_S` (4 s) resets
it to 0 and back to `'intercept'`. Hold `HOLD_S` (30 s) → **pilot aboard**: fee paid with
`creditPlayer(game, p, fee, 'pilotage', 'Pilotage MSC ANNA')`, event "Pilot aboard MSC ANNA — +2,446 cr pilotage.",
`stats.pilotJobs++`, `stats.pilotEarned += fee`, `PILOT_HOOKS` called, job `'done'` (kept 30 s for the card), MMSI on
cooldown.

**Fee** = round((`FEE_BASE` 250 + `FEE_PER_M` 6 × length) × (1.25 when the wind at the boarding point is ≥ 12 m/s or
the significant wave height ≥ 2.5 m: "heavy-weather boarding")), integer credits, fixed when the job is accepted (the
weather at acceptance decides the surcharge). 100 m → 850, 200 m → 1,450, 300 m → 2,050, 366 m → 2,446 cr; heavy weather
200 m → 1,813 cr.

**Fail and cancel:**

| Event | Result | Text |
|---|---|---|
| she is more than `ZONE_M` from the boarding point and past it (the boarding point is behind her along her course) without the pilot | failed, `stats.pilotMissed++` | "MSC ANNA passed the pilot station without you — the station sent another boat." |
| a ship contact ≥ `REFUSE_KN` (3 kn) reported by `collision` while within 300 m of her | failed | "The master refused the pilot after you hit his ship." |
| AIS report older than 3 min | job paused ("AIS signal from MSC ANNA lost — hold on"), cancelled after 5 min | "Pilot job cancelled — AIS contact with MSC ANNA lost. Nothing owed." |
| she drops anchor or moors (navStatus 1, 5) before the pilot is aboard | cancelled | "MSC ANNA anchored to wait — pilot job cancelled." |
| skipper offline > 120 s, in the raft, hailed, or no longer in a pilot boat | cancelled | "Pilot job cancelled." |
| `pilot_cancel` | cancelled, the vessel back on offer for others | "You handed the job back to the station." |

A failed or cancelled job costs nothing (§8 asks the player). **AIS offline** (`!game.ais`, `game.ais.offline`, or an
empty store): no offers, `you.pilotage.status = 'offline'`, running jobs follow the AIS-lost rule.

**Debug vessel** (`debug_pilot_vessel`, `SALTLINE_DEBUG=1` only): puts a synthetic class-A vessel "SALTLINE TEST"
(MMSI 999000001–999000099, length 180 m, beam 28 m, nav 0, 12 kn) into `game.ais.store` 15 km out on the approach of the
nearest harbour, heading for its boarding point, `dest` that harbour's port name; the desk advances its reports every 5 s
along its course until 10 km past the boarding point. Without a `store` (tests) it is added to a fake list the test passes.

### 4.3 Constants — `server/pilotage.js`

```js
export const PILOT_JOBS = {
  CLASS: 'pilot', MIN_LENGTH_M: 80, MIN_SOG_KN: 4, MAX_SOG_KN: 18, NAV_OK: [0, 3, 4, 15, null], INFER_DEST: true,
  SCAN_RANGE_M: 60000, OFFER_RANGE_M: 25000, CPA_MAX_M: 3000, ETA_MIN_S: 480, ETA_MAX_S: 3600,
  REACH_FRAC: 0.85, REACH_MARGIN_S: 120, OFFER_TTL_S: 300, MAX_OFFERS: 3, TAKEN_SHOW_S: 10,
  SCAN_MS: 5000, CHECK_MS: 500, FRESH_S: 180, AIS_LOST_CANCEL_S: 300, OFFLINE_CANCEL_S: 120, MATCH_FRAC: 0.8, SOG_WINDOW_S: 8, SOG_MIN_SPAN_S: 2,
  ZONE_M: 5000, LADDER_ALONG_FRAC: 0.25, LADDER_ALONG_MIN_M: 25, LADDER_GAP_M: 25, MATCH_KN: 1.5, MATCH_DEG: 15, LEE_MIN_WIND_MS: 6,
  HOLD_S: 30, GRACE_S: 4, REFUSE_KN: 3, SOFT_KN: 1.5,
  FEE_BASE: 250, FEE_PER_M: 6, HEAVY_WIND_MS: 12, HEAVY_WAVE_M: 2.5, HEAVY_MUL: 1.25, VESSEL_COOLDOWN_S: 21600,
};
```

**Balance.** A pilot boat burns 0.12 t/h at full (78 cr/h of fuel) and costs 15 cr/h in wages today. At Rotterdam's
traffic (about 3 arrivals of > 80 m an hour) a skipper can realistically board 1.5 ships an hour: about 2,200 cr per ship
hour for 200 m ships, 2.3 × a full coaster freight run (956 cr/h, V5-WAVE2 §3.10) — inside wave 2's 3.5× gate. After both
merge, the integrator adds a "pilot boat: pilotage (1.5 × 200 m per ship hour)" row to `test/balance.test.mjs` (§6.4).

### 4.4 Server — `server/pilotage.js`

```js
export const PILOT_HOOKS = [];
export class PilotDesk {
  constructor(game)               // reads game.ais lazily (null in tests unless set); this.now = () => Date.now() (tests replace it)
  tick(nowMs)                     // G16: offers every SCAN_MS, jobs every CHECK_MS, debug vessel reports
  accept(p, offerId); cancel(p, why)
  contact(p, kind, kn)            // G13
  warpReason(p)                   // string while a job runs, else null (used by warpConditions, §3.4)
  view(p)                         // PilotView | null
  debugVessel(p, m)
  addJobVessel(p, ships)          // server.js AIS push: append the job's vessel (AisPublic) to `ships` if it is not among them
  stats()                         // { offersOpen, jobs, done, failed, cancelled, aisVessels, lastScanMs }
}
export function installPilot(game, hooks)    // G2, G6 (pilot_accept, pilot_cancel, debug_pilot_vessel), G13, G16, G20 (first), G23
```

`shared/pilotmath.js` (pure, used by the server and the client):

```js
export function hullCentre(a)                         // AisPublic → { lat, lon } (antenna + off)
export function relToHull(boat, a, beamBoat)          // → { along (m, + forward of her centre), across (m, + to her starboard), gap (m), side: 'port'|'starboard' }
export function cpaToPoint(a, pt)                     // → { cpaM, tcpaS } of her straight course to a point
export function passedPoint(a, pt)                    // her along-course position is beyond pt
export function interceptPoint(own, ownKn, a)         // → { lat, lon, tS, brg } where a boat at ownKn meets her straight course, or null
export function leeSide(a, windFromDeg)               // 'port' | 'starboard'
export function pilotFee(lengthM, heavy)              // the §4.2 formula
export function boatSpeedFactor({ cond, sea, waveH, waveDir, hdg }) // §4.2; imports waveSpeedLoss from shared/physics.js
export function groundTrack(samples)                  // [{ t, lat, lon }] → { sogKn, cogDeg } over the span, or null under SOG_MIN_SPAN_S
export function softImpactKn(closingMS, softKn = 1.5) // §4.5 (used by public/js/collision.js)
```

### 4.5 Soft contact with the job's ship — `public/js/collision.js`

Pilot boats lie against the ship's side; with today's impact rule (`max(closing, |own speed| × 0.5)`) a touch at 12 kn
alongside counts as a 6 kn collision and throws the boat off. The rule for the job's ship is a pure helper in
`shared/pilotmath.js` (Node cannot load `collision.js`, whose imports use the browser's `/shared/…` paths):

```js
/** Impact speed (kn) of a contact with a 'soft' hull (the pilot job's ship): 0 = lying alongside, no hit. */
export function softImpactKn(closingMS, softKn = 1.5) { const kn = Math.max(0, closingMS) / 0.514444; return kn < softKn ? 0 : Math.round(kn * 10) / 10; }
```

In the other-ships loop of `resolveShip` (collision.js imports it from `/shared/pilotmath.js`): for an entry with
`o.soft === true`, compute that entry's closing speed (the existing `-(vx * sep.nx + vz * sep.nz)`); push out as usual;
if `softImpactKn(closing, o.softKn) === 0` do **not** set `shipHitThisFrame` and do not add it to `touchedShips` (no hit,
no speed loss); otherwise it counts, and when every touched entry this frame was soft the impact is
`softImpactKn(closing)` alone (not `max(closing, |own speed| × 0.5)`). Entries without `soft` behave exactly as today.
`PilotJobsUI.soften(v)` returns `{ ...v, soft: true, softKn: PILOT_JOBS.SOFT_KN, spd: v.spd − c }` for the job's vessel
and `v` otherwise, where `c` is the local current + tidal stream (`currentAt` + `app.tide.stream`) projected on her
heading, in knots. `resolveShip` compares our speed **through the water** with hers; AIS `sog` is over the ground, so
without the correction a boat lying perfectly alongside in a 1 m/s stream would "close" at 2 kn and bounce off.

### 4.6 Messages

```ts
PilotView = {
  status: 'offline' | 'quiet' | 'offers' | 'job',
  station: { harbor, harborName, name, lat, lon, source, distM } | null,      // the nearest boarding point within 25 km
  offers: [PilotOffer],                                                       // ≤ 3
  job: PilotJob | null,
}
PilotOffer = { id, mmsi, name, flag, lengthM, beamM, cls, sog, cog, harbor, harborName, bp: { lat, lon, name },
               etaS, reachS, fee, heavy: boolean, destInferred: boolean, expires /* ms */, takenBy: string | null }
PilotJob = { id, mmsi, name, flag, lengthM, beamM, harbor, harborName, bp: { lat, lon, name, source }, fee, heavy,
             state: 'intercept' | 'boarding' | 'done' | 'failed' | 'cancelled', why: string | null, startedAt,
             vessel: { lat, lon, hdg, cog, sog, t } /* hull centre, dead-reckoned to now */, etaS, zoneM: 5000,
             rel: { along, across, gap, side, lee, dKn, dDeg, ok: { zone, along, gap, speed, course, lee } },
             holdS: number, holdNeed: 30 }
```

`you.pilotage` is null for other classes without a job.

### 4.7 Client — `public/js/pilotjobs.js`, `public/css/pilotjobs.css`

```js
export class PilotJobsUI {
  constructor(app)                // ensureCss('pjCss', 'css/pilotjobs.css'); #pilotCard in #ctxStack (hidden)
  onYou(you, prev)                // card; sound.ui('open') on a new offer; events
  update(dt, now)                 // 3D marks, intercept line, ladder zone
  soften(v)                       // collisionOthers hook (§4.5)
  radarContacts()                 // boarding point + the job's vessel highlighted ('#ff5ad6')
  drawChart(chart, ctx)           // boarding points (zoom ≥ 7), the job: her predicted track (30 min), the intercept point
}
export function installPilotJobs(app, hooks)  // C2, C7, C8, C14 → returns the PilotJobsUI
```

- **Offers card** ("Maas pilot station · 2 inbound"): rows — flag, name, "366 m · 13.2 kn", "at the station in 14 min ·
  you need 9 min", fee; **Accept** (≥ 44 px on phones). Status lines: `quiet` "No ships inbound for Rotterdam right now —
  wait near the station (8.1 km, 247°)."; `offline` "Live AIS is offline — the pilot station has no traffic to give out."
- **Job card**: name, fee, state line. Intercept: "Steer 247° at 22 kn — you meet her in 9 min, 1.2 km before the
  station" (from `interceptPoint` with 85 % of the boat's top speed). Alongside: a small top-down diagram (her hull to
  scale, the ladder zone on the lee side highlighted, your boat dot), and "Port side · 12 m off · 20 m aft of the ladder ·
  you are 0.8 kn faster · 3° off her course", each failing check amber; a hold bar 0–30 s "Pilot on the ladder…".
- **3D:** her model gets a magenta ring on the water and a label "PILOT JOB · MSC ANNA"; the ladder zone a glowing strip
  along her lee side (length 0.5 L, at the water line); the boarding point a light column with a board "Pilot station";
  a dashed intercept line from your bow to the meeting point while intercepting.
- **Chart:** all boarding points within view at zoom ≥ 7 (magenta circle, "Pilots"); the job's vessel track 30 min ahead
  and the intercept point.
- **Phones:** while a job runs the job card is the expanded card at the top (the contract card collapses to its pill);
  offers show as a pill "Pilot: 2 inbound" that expands on tap.

### 4.8 Edge cases

| Case | Behaviour |
|---|---|
| Two pilot boats at the station | both see the offer; the first Accept wins; the other's row shows "Taken by Ann" for 10 s. |
| She slows from 14 to 8 kn for the pilot (real ships do) | the speed match follows her live `sog`. |
| AIS position jumps 60 m on a new report | the store's jump filter applies; the 4 s grace and the 25 m gap absorb the rest. |
| The boat waits near the station | she drifts or circles: with 60 m of chain a pilot boat anchors only in ≤ 15 m (§3.2), which most stations do not have. Accept works at anchor where she can anchor; weigh to go. |
| More than 200 vessels nearer to the boat than the job's ship (the port of Rotterdam from the Maas entrance) | `addJobVessel` puts her into the boat's 2 s AIS push anyway, so the client always draws, collides with and softens her. |
| Heavy weather (≥ 2.5 m sea) | `boatTopKn` falls (≈ 19 kn at 80 % condition); offers and the 80 % speed rule follow it, so a job the desk offers can be done. |
| Wave 2 charter on the pilot boat at the same time | allowed; the passengers ride along. |
| Night | boarding allowed; her lights and the ladder strip are visible. |
| A ship bound elsewhere passes the station | not eligible (destination); with no destination only the strict CPA ≤ 1 km rule infers it. |
| Server restart during a job | the job is lost silently (no payment, no penalty); the vessel can be offered again. |
| Skipper buys another ship mid-job | cancelled on the next check (not a pilot boat). |
| The boat touches her at matched speed | soft contact: no damage, no bounce; at ≥ 1.5 kn closing it is a collision, at ≥ 3 kn the job fails. |
| A harbour outside the North Sea detail region | AISStream subscribes there only round online skippers (`setInterest` in server.js, every 2 s); the pilot boat itself brings the coverage, so offers appear a minute or two after she arrives. |
| Two harbours share a boarding point (Hull and Immingham at the Humber) | offers are per harbour; the vessel's destination decides which one offers her. |

### 4.9 Tests — `test/pilotage.test.mjs`

A fake AIS (`{ offline: false, store: { size }, near(lat, lon, r, { limit }), get(mmsi) }`) moving each vessel along its
course from a start time with the test's clock (`desk.now = () => T`). Rotterdam's boarding point comes from
`g.seamarks.boardingPoint('rotterdam')` (synthetic with `fakeGeom`, deterministic).
1. *pilotmath:* hull centre with `off [45, −1]`; `relToHull` sides and signs; `cpaToPoint`; `interceptPoint` for a boat
   at 22 kn and a ship at 12 kn crossing at right angles (closed form); `leeSide`; fees 850 / 1,450 / 2,050 / 2,446 and
   ×1.25.
2. *Eligibility:* class B, 70 m, unknown length, nav 1, sog 2, dest Hamburg, CPA 5 km, ETA 5 min and 70 min, stale
   report — each excluded; dest null with CPA 0.6 km and the right course → offered with `destInferred`.
3. *Offers:* a pilot boat 6 km from the station gets the offer; a coaster does not; a pilot boat 30 km away does not; one
   that cannot reach the station in time does not; max 3, soonest first; lapse after 5 min.
4. *Fairness:* two pilot boats; A accepts → B's offer shows `takenBy: 'A'` and B's accept is refused; after A cancels the
   vessel is offered again; after a done job it is not offered for 6 h.
5. *Boarding:* place the boat on her lee side 15 m off, moving with her (positions advanced each 0.5 s so the boat's
   ground track matches her `sog`/`cog`) for 31 s → paid exactly the fee
   (money and `stats.pilotEarned`), event text, `PILOT_HOOKS` called once. A 5 s excursion to 40 m off resets the hold;
   a 3 s one does not. Wrong side in 8 m/s wind → never boards; in 4 m/s either side works. *Stream:* with
   `g.currentAtPos = () => ({ u: 1, v: 0 })`, a boat moving with her over the ground while reporting `spd` 2 kn less
   than her `sog` still boards. *Along:* an 80 m ship accepts the boat 24 m aft of her centre (min 25 m).
5b. *Reach:* calm → `boatTopKn` 26 × 1 at 100 % condition; `waveH` 2.5 m head sea, sea 0.5, condition 80 → ≈ 19 kn; an
   offer that needs 22 kn to make the station in time is **not** made in that sea; a 20 kn ship is never eligible
   (> 18 kn), a 17 kn ship is not eligible when `boatTopKn` is 19 (> 80 %).
5c. *AIS push:* `addJobVessel(p, [])` adds exactly her AisPublic; with her already present it adds nothing.
6. *Failures:* she passes 5 km beyond the station → failed, `stats.pilotMissed`; a 3.5 kn ship collision within 300 m →
   failed; AIS `t` older than 3 min → paused, cancelled after 5 min; `g.ais = null` → status `offline`, no offers.
7. *Warp:* with a job `set_warp 5` is refused `/pilot job/`; a running warp drops to 1× on accept.
8. *Soft contact:* `softImpactKn(0.8 × 0.514444)` = 0; `softImpactKn(2 × 0.514444)` = 2.0; `softImpactKn(−1)` = 0. The
   `collision.js` wiring is covered by browser check 2 (touching her at matched speed neither bounces nor damages the
   boat; ramming her at 4 kn does).

### 4.10 Browser checks

1. Production (live AIS on): pilot boat at Rotterdam, sail to the Maas pilot station; within minutes the offers card lists
   real inbound ships; their info card (tap) matches the AIS card. Accept one; intercept; come up on the lee side; match
   speed with the telegraph; the hold bar fills; "Pilot aboard … +N cr".
2. Dev / quiet times: `SALTLINE_DEBUG=1`, `debug_pilot_vessel` → "SALTLINE TEST" appears 15 km out and the offer arrives;
   the full flow works; touching her at matched speed does not bounce or damage the boat.
3. Let her pass → "passed the pilot station without you".
4. Two browsers in two pilot boats: one Accept wins, the other sees "Taken by …".
5. Stop the AIS sources (server without key and Digitraffic blocked) → "Live AIS is offline …"; nothing else breaks.
6. Phone: the job card at the top with the diagram and hold bar legible at 360 px; Accept ≥ 44 px; the contract card
   collapses to its pill.

---

## 5. PASSPORT — harbour passport

### 5.1 Goal, in the player's words

"Every harbour I come into stamps my passport: the harbour's name and country, the date and the ship I came in. A page of
stamps I can flick through, how many of the 86 harbours and 41 countries I've seen, and a few badges to chase. It's mine,
whichever ship I sail."

### 5.2 Rules

- **Stamped on** every arrival through `finishDock` (`via: 'moored'` at a berth, `'docked'` at the legacy anchor rule or
  after a tow) and on a rescue landing (`'landed'`). Not on impound or forced reset (you did not choose to come).
  **Backfill**: on connect, a docked player without a stamp for that harbour gets one with `via: 'home'` (new players get
  their start harbour; migrated players the harbour they lie in).
- **A stamp**: `Stamp = { first: unixS, firstCls, firstShip: string | null /* wave 2 vessel name */, visits, last: unixS,
  via, ashore: boolean }`. A later arrival increments `visits` and sets `last`; `first`, `firstCls`, `firstShip` never
  change. `passport { op: 'ashore' }` from a skipper docked at that harbour sets `ashore: true` (the client sends it the
  first time the skipper goes ashore there).
- **Counts**: harbours stamped among the current `HARBORS` (86) and countries among their distinct `country` codes (41).
  Stamps of harbour ids no longer in `HARBORS` are kept and shown greyed as "retired harbour", not counted.
- **Badges** (`BADGES`, earned once, dated, kept even if the harbour list grows):

| id | Name | Rule |
|---|---|---|
| `harbours_5` | Five harbours | 5 harbours stamped |
| `harbours_25` | Twenty-five harbours | 25 harbours stamped |
| `harbours_all` | Every harbour | all current harbours stamped (86 today) |
| `countries_all` | Every flag | all current countries stamped (41 today) |

### 5.3 API

`shared/passport.js` (pure, browser-safe):

```js
export const COUNTRY_NAMES = { NL: 'Netherlands', BE: 'Belgium', FR: 'France', GB: 'United Kingdom', IE: 'Ireland', DE: 'Germany',
  DK: 'Denmark', SE: 'Sweden', NO: 'Norway', IS: 'Iceland', PT: 'Portugal', GI: 'Gibraltar', IT: 'Italy', GR: 'Greece', TR: 'Türkiye',
  EG: 'Egypt', AE: 'United Arab Emirates', IN: 'India', LK: 'Sri Lanka', SG: 'Singapore', ID: 'Indonesia', PH: 'Philippines',
  HK: 'Hong Kong', CN: 'China', KR: 'South Korea', JP: 'Japan', AU: 'Australia', NZ: 'New Zealand', ZA: 'South Africa', KE: 'Kenya',
  SN: 'Senegal', ES: 'Spain', BR: 'Brazil', AR: 'Argentina', CL: 'Chile', PA: 'Panama', US: 'United States', CA: 'Canada',
  RU: 'Russia', PL: 'Poland', FI: 'Finland' };
export function countryName(code)                        // table, else Intl.DisplayNames, else the code
export const BADGES = [ { id, name, desc, test(counts, totals) } × 4 ];
export function totalsFor(harbors)                       // { harbors: n, countries: n, countryList }
export function countsFor(stamps, harbors)               // { harbors, countries, perCountry: { [cc]: [have, total] } }
export function badgesEarned(stamps, harbors, already)  // → [badgeId] newly earned
export function stampStyle(harborId, size, country)      // { rot (deg −8…8), ink (one of 6), shape: 'double'|'circle'|'rect'|'oval' by size } — deterministic
```

`server/passport.js`:

```js
export class PassportDesk {
  constructor(game)
  arrived(p, harbor, via)       // G10/G26: stamp or count a visit; badges; send { t: 'stamp', … }
  backfill(p)                   // G3
  action(p, m)                  // {} → send { t: 'passport', passport: view }; { op: 'ashore' } → mark ashore (docked here only)
  stampOf(p, harborId)          // StampView | null (`harbor_v7.stamp`)
  view(p)                       // PassportView
}
export function installPassport(game, hooks) // G2, G3, G6 (passport), G10, G26; hooks.field('passport'); hooks.harbor → { stamp }
```

### 5.4 Messages

```ts
StampView = { harbor, name, country, countryName, size, first, firstCls, firstClsName, firstShip, visits, last, via, ashore, retired: boolean,
              style: { rot, ink, shape } }
BadgeView = { id, name, desc, got: number | null, progress: [have, need] }
PassportView = { stamps: [StampView] /* by first date */, counts: { harbors, harborsTotal, countries, countriesTotal },
                 badges: [BadgeView], unvisited: [{ harbor, name, country, size }] }
```

`{ t: 'stamp', stamp: StampView, isNew, newBadges: [BadgeView] }` after an arrival (also for repeat visits, `isNew:
false`, so the harbour sheet updates; the client animates only new stamps and new badges). The harbour sheet reads the
stamp from `harbor_v7.stamp` (`stampOf`).

### 5.5 Client — `public/js/passport.js`, `public/css/passport.css`

```js
export class PassportUI {
  constructor(app)              // ensureCss('ppCss', 'css/passport.css'); "Passport" menuBtn in #moreSheet; #passportWrap sheet (hidden)
  open(); close(); isOpen()     // open: net.action('passport') and render on the answer; ?fixture=passport loads docs/fixtures/passport.sample.json
  onPassport(view); onStamp(m)
  update(dt, now)               // detect app.ashore.active turning on while docked → passport {op:'ashore'} once per harbour per session; stamp animation
  overviewCard(h, you)          // harbour Overview card: the stamp of this harbour, visits, [Open passport]
}
export function installPassportUi(app, hooks) // C1 passport/stamp, C10, C11, C12 passport, C13, the More-sheet button → returns the PassportUI
```

- **Stamp animation** on a new stamp: the stamp (SVG, 160 px desktop / 120 px phone) drops onto the screen centre with a
  short scale-in and a 2° wobble, a soft thump (`sound.ui('open')`), holds 2.5 s, then shrinks into the More button. New
  badges follow as a toast "Badge: Five harbours". `prefers-reduced-motion`: a fade only. It waits until the docking card
  (if any) is closed or 3 s have passed, so the two never overlap.
- **Passport sheet** (`#passportWrap`, the `.sheetHead / .sheetMain / .sheetNav / .sheetBody` structure, so desktop gets
  the nav rail and phones the bottom tabs): tabs **Stamps** and **Badges**. Head: "23 of 86 harbours · 9 of 41
  countries". Stamps: a grid (desktop 5–6 columns, phone 2) of SVG stamps — harbour short name in capitals on the rim,
  country, date "08 OCT 2026", "Coastal freighter" (or "Sea Bee · coaster" with wave 2), a "×3" corner for repeat
  visits, a footprint mark when walked ashore; rotation, ink and shape from `stampStyle`. A toggle "Show unvisited"
  adds faint outlines grouped by country. Sort: by date / by country. Badges: four cards with progress bars "17 / 25".
- **Overview card**: "Passport: stamped 08 Oct 2026 · 3 visits · walked ashore" with **Open passport**
  (`data-act="passport"`), or "Your first arrival here stamps your passport."
- Phone: full-screen sheet, no horizontal scroll at 360 px, close ≥ 44 px, Escape closes (overlay lists, §1.6).

### 5.6 Edge cases

| Case | Behaviour |
|---|---|
| Arrival by tow | stamped (`via: 'docked'`). |
| Impound / forced reset | no stamp. |
| Rescue landing | stamped `'landed'` at the rescue harbour (before wave 2's landing moves the person). |
| Wave 2 home move on founding | no stamp until the next arrival (the ship is moved, not sailed). |
| Harbour list grows | the totals grow, earned badges keep their date; `harbours_all` can be earned again only if not yet earned. |
| Two arrivals in the same harbour within a minute (cast off, re-moor) | `visits` counts both. |
| A skipper switches ships (wave 2) | the passport stays with the person. |

### 5.7 Tests — `test/passport.test.mjs`

1. `COUNTRY_NAMES` covers every `HARBORS` country; `totalsFor(HARBORS)` = 86 / 41.
2. First arrival stamps with date, class and via; a second arrival increments `visits`, keeps `first`; the `stamp`
   message carries `isNew` true then false.
3. Badges: crafted stamps of 4 harbours + one arrival → `harbours_5` with its date; 24 + 1 → `harbours_25`; all
   harbours → `harbours_all`; one harbour of each country → `countries_all`; a badge is never awarded twice.
4. Backfill on connect for a docked player; none for one at sea; new players get Rotterdam `via: 'home'`.
5. Tow arrival stamps `'docked'`; impound and forced reset do not stamp; a rescue landing stamps `'landed'` at `r.from`
   (the `finishRescue` before-advice), also when the landing ends in a forced reset (no money for the excess).
6. `ashore` only when docked at that harbour; ignored otherwise.
7. A stamp for an unknown harbour id is kept, shown `retired`, not counted.
8. `v7state.json` round trip (temp dir); the passport is not in `state.json`; with wave 2's store merged the same test
   passes unchanged (the file is v7's own). Writes `docs/fixtures/passport.sample.json` (a 12-stamp view) for the client
   fixture.
9. `stampStyle` deterministic per harbour.

### 5.8 Browser checks

1. New skipper at Rotterdam: More → Passport → one stamp "ROTTERDAM · Netherlands · today · Coastal freighter", "1 of 86
   harbours · 1 of 41 countries".
2. Sail to IJmuiden and moor → the docking card, then the stamp animation; the passport shows two stamps.
3. Go ashore at IJmuiden → the stamp gets the footprint mark.
4. `?fixture=passport`: 12 stamps, badges with progress; "Show unvisited" draws the outlines by country.
5. Phone: two-column grid, bottom tabs Stamps / Badges, the animation sized 120 px, no overflow at 360 px.

---

## 6. Integration

### 6.1 Order

1. **Phase A (now):** the integrator writes `server/v7hooks.js` and `public/js/v7hooks.js` verbatim (§1.5, §1.6) with
   `test/v7hooks.test.mjs`; the four packages write their new files and unit tests in parallel (wave 2 does the same).
   DOCK or PILOT writes `server/v7money.js` verbatim (§1.7). ANCHOR writes `server/seamarks.js` first so PILOT can build
   on `boardingPoint` (PILOT uses a stub `{ boardingPoint: () => ({ lat, lon, name, source: 'test' }) }` until then).
2. **Gate:** all four v6 quick packages merged, `npm test` green. (v7 advises WARP-HARBOUR's and AUTOPILOT's methods and
   the chart's `draw`; their final names and arguments must exist.) Wave 2 is **not** a gate.
3. **Phase B, in order** (each step followed by `npm test`): PASSPORT → DOCK → ANCHOR → PILOT. A step = the package's
   import line and `PACKAGES` entry in `server/v7hooks.js` plus its direct edits of §1.6: PASSPORT also adds the two core
   lines of `server.js` (import, `installV7(…)`), the `/api/v7` route and the last line of `main.js`; DOCK the
   `berthguide.js` export; ANCHOR `.gitignore`, the seamarks lines and `/api/seamarks`; PILOT the AIS-push statement and
   `collision.js`. No step edits a function of `game.js`, `main.js`, `hud.js` or `chart.js`.
4. **Wave 2 phase B** runs whenever it is ready, also at the same time as step 3: the two trees share no function. The
   only coupling is the money fallback (§1.7): when W2-SERVER merges after DOCK or PILOT, the integrator deletes the
   `else p.money += amt` line in the same commit, before W2-SERVER's grep test is run.
5. **Phase C** (after both trees): the wave 2 wage line of §3.8 (integrator), `test/v7-integration.test.mjs`, the
   wave 2 cross-checks (§6.4), browser checks of all four packages on the integrated build (desktop 1440×900 and phone
   390×844, two players); the integrator adds a v7 addendum to `docs/ARCHITECTURE.md` (the advice layer and its rule,
   `v7state.json`, docking score, anchoring physics and seamarks, pilot desk, passport, the new messages and files) and
   updates `docs/STATUS.md`; one push, one deploy. On the production box run `node scripts/fetch-seamarks.mjs` once after
   the deploy (or start with `SALTLINE_PREFETCH=1`).

### 6.2 `server.js` lines added by v7 (final shape)

```js
import { installV7 } from './server/v7hooks.js';                                           // core (top of file)
// …
game.aiFilter = (a) => !liveAis.covers(a.lat, a.lon);
installV7(game, { ais: liveAis, log });                                                      // core: reads data/v7state.json, wraps the methods
// … existing prefetch line …
game.seamarks?.enableFetch();                                                                // ANCHOR
if (process.env.SALTLINE_PREFETCH === '1') game.seamarks?.prefetchAll({ delayMs: 3000 }).catch((e) => log('[seamarks] prefetch failed', e.message));
// … after /api/jobs …
app.get('/api/seamarks', (req, res) => {                                                     // ANCHOR
  const b = String(req.query.bbox || '').split(',').map(Number);
  if (b.length !== 4 || !b.every(Number.isFinite) || b[0] >= b[2] || b[2] - b[0] > 30 || Math.abs(b[3] - b[1]) > 60) return res.status(400).json({ error: 'bbox=latMin,lonMin,latMax,lonMax' });
  if (!game.seamarks) return res.json({ time: Date.now(), harbors: [] });
  try { res.setHeader('Cache-Control', 'public, max-age=600'); res.json({ time: Date.now(), harbors: game.seamarks.inBbox(b[0], b[1], b[2], b[3]) }); }
  catch (e) { log('[seamarks] failed', e.message); res.status(500).end(); }
});
app.get('/api/v7', (req, res) => res.json({ pilotage: game.pilotage?.stats?.() ?? null, seamarks: game.seamarks?.stats?.() ?? null,
  anchors: game.anchors?.stats?.() ?? null, dock: game.dockScore?.stats?.() ?? null, failed: [...(game.v7hooks?.failed ?? [])] }));   // core
// … in the live-AIS push interval (PILOT): the statement that sends `ais` becomes
const ships = liveAis.near(p.ship.lat, p.ship.lon, AIS_NEAR_M, { limit: AIS_NEAR_LIMIT });
game.pilotage?.addJobVessel?.(p, ships);
ws.send(JSON.stringify({ t: 'ais', time, ships }));
```

The middleware sets `Cache-Control: no-cache` on every response before the routes run; `/api/seamarks` overrides it
with its own header. `/api/health` and the shutdown block are not touched (wave 2, MARKET and AUTOPILOT own them).

### 6.3 Cross-package checks (`test/v7-integration.test.mjs` + browser)

Automated:
1. A coaster anchors outside Rotterdam (stubbed depth 22 m), waits 600 ticks at 5×, weighs, sails in and moors at a
   berth with a good approach: the `dock_score` card comes first, then the `stamp` message, then `harbor_v7` (handler
   order DOCK, PASSPORT, core), all after the "Port dues" event; money = start + bonus − dues − pilotage; no fuel, wear
   or wages while anchored with the engine stopped.
2. A pilot boat anchored near the station (stubbed depth 12 m — her 60 m of chain holds in 15 m) accepts an offer
   (allowed at anchor), weighs, boards → paid; warp refused while the job runs ("pilot job" wins over the anchor's rule),
   allowed (≤ 5×) again at anchor afterwards.
3. A docking sample ring is empty after the anchor was let go and weighed (anchored time is not an approach).
4. `privateState` with nothing active: `anchor: null`, `pilotage: null` for a coaster; `warpLimit` without `anchor`.
5. Every v7 action from a player who is offline, in the raft or docked where it makes no sense is refused or ignored
   without throwing; unknown `op` values warn.
6. Save/load round trip with all v7 fields at once (passport, dock fields, anchor) through `v7state.json`; `state.json`
   contains none of them.
7. All four packages installed: every advised method is the wrapper (`g.dock.name === 'v7advised'`); a package whose
   install throws is absent and the other three still work; `/api/v7` lists no failed advice after the scenario of 1–2.

Browser (integrated build, two players): anchor, warp 5×, drag (debug), weigh, moor with a grade, stamp animation after
the card; pilot boat flow with `debug_pilot_vessel`; on phones the top-slot priority: wave 2 failure card > pilot job >
anchor (dragging) > berth guidance > contract > anchor pill > pilot offers pill — one expanded card, at most two pills
under it, nothing overlapping the top bar or the action bar at 360 × 740.

### 6.4 Wave 2 cross-checks (after both have merged)

1. `server/v7money.js` has no `else` branch and calls `credit(…, 'contract', { sub, memo })`; wave 2's source-grep test is
   green; the HQ P&L shows the docking bonus and pilotage under contract income with their memo; no `adjust` line.
2. With wave 2's store: a schema-2 save and load keeps every v7 field (they live in `v7state.json`, keyed by player id,
   which `migrateV1toV2` keeps); `PlayerRecord` and `VESSEL_KEYS` are unchanged.
3. The advice wraps wave 2's versions of `dock`, `finishDock`, `tugAssist`, `collision`, `tick`, `privateState`,
   `sendHarbor`, `finishRescue`: the DOCK capture still happens before `moorAt` (and not when `moorNeedsTugs` refuses),
   the stamp at a rescue landing names `r.from` even when wave 2 lands the person at another harbour, `p.assist.cost`
   is still set when the tugs are charged through `charge(…)`.
4. Wages at anchor follow the moored state (full 24 h, then 30 %), settled on drop and aweigh; exact at 1× and 5× —
   after the integrator's phase C line (§3.8).
5. `test/balance.test.mjs` gains the pilot-boat pilotage row (1.5 boardings of 200 m ships per ship hour, fuel at
   service throttle, optimal crew) and stays within 3.5 × the coaster's full-hold freight.
6. `you.limits.vhf === false` → `pilot_accept` refused with the VHF text.
7. The drag alarm uses `sound.event('alarm')`.

---

## 7. Decisions for the product owner (built as written unless changed)

1. **Docking bonus is small** (coaster A+ 160 cr, at most once per harbour per 6 h); the grade, the personal best and the
   replay are the reward. Leaderboards ("best docking") belong to v7 item 8.
2. **Reputation is not in this batch.** Wave 2 has a bank rating, not a reputation; `DOCK_HOOKS` and `PILOT_HOOKS` are
   ready for v7 item 1 (career and reputation).
3. **Anchoring physics is a game model**, tuned so that a coaster holds in sand to force 7 and drags in force 8, small
   craft only anchor in shallow water, and veering chain plus the engine can save a ship in a gale. The synthetic sea bed
   (the depth model of `world.js`) is deeper than the real North Sea; with real bathymetry (wave 4) more water becomes
   anchorable.
4. **Warp at anchor is capped at 5×** so a drag alarm still means something; the ship's clock runs 5× (contract hours
   too), as everywhere.
5. **Pilot jobs are short:** paid when the pilot is aboard; the pilot boat does not take him off later. Fee 250 + 6 cr per
   metre of the ship (×1.25 in heavy weather).
6. **Bottom types are invented where OSM is silent**, but deterministic, so local knowledge (and the charted anchorages,
   which always hold well) pays off.
7. **No new 3D for anchorages** (chart only); AI traffic does not use the anchorages yet (a natural follow-up in v7
   batch 3, rules of the sea).
8. **Charted anchorages have a charted depth (20 m)** while the synthetic sea bed around them is 60–200 m deep; outside
   them a ship anchors only within about 2–4 km of a coast. Real bathymetry (wave 4) removes the special case.
9. **Small craft carry 60 m of chain** (anchor in up to 15 m): pilot boats and yachts anchor close inshore, not in the
   big-ship anchorages.
10. **v7 never edits another tree's function.** It hooks in by wrapping methods at start-up (§1.5) and keeps its saved
    data in `data/v7state.json`. Cost: one more file to back up, and a v7 bug shows up as "advice failed" in `/api/v7`
    instead of a stack trace inside `game.js`. Benefit: wave 2 and v7 build at the same time without touching each other.
11. **An unattended ship that drags onto the shallows** takes one grounding (−5 % hull) and then lies aground until the
    skipper comes back; the anchor watch first veers chain and re-anchors if it has fuel.

## 8. Open questions for the player

1. **Docking bonus:** should a good mooring pay a little money (built: up to about 160 cr for a coaster, once per harbour
   every 6 hours), or should the grade be pure pride — personal bests and, later, leaderboards — with no credits at all?
2. **Your ship at anchor while you are away:** should the crew's anchor watch save her when the anchor drags (built: they
   pay out more chain and re-anchor before she reaches shallow water, using a little fuel; without fuel she runs aground
   once, losing 5 % hull, and waits for you), or should a storm be able to do real damage to an unattended ship?
3. **Missing a pilot job:** when the real ship passes the pilot station before you get there, should that cost you
   something (a small fine or a wait before the next offer), or nothing at all (built: nothing, the next ship is offered
   as usual)?
4. **Where you can anchor:** the game's sea floor drops much faster than the real North Sea (155 m deep 6 km off
   Rotterdam). Built: big ships anchor in the charted anchorages, which count as 20 m deep, or close to a coast. Would you
   rather have a shallow shelf faked along every coast now (anchor almost anywhere near land), or wait for real depth
   data later?
