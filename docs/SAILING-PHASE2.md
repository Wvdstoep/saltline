# Saltline — real sailing, Lane A phase 2: wiring into existing files

Companion to `docs/SAILING-CONTRACT.md` (Lane A). Phase 1 (2026-10-09) added **new files only**; this document is the
exact, ordered list of edits phase 2 makes to existing files. Every edit is given as a **search anchor** (unique text in
the file today, never a line number) plus code ready to paste. The whole set was validated by applying it mechanically
to a scratch copy of the tree on 2026-10-09 and running the suites listed in §6 (all green, including the phase-2 tests
that are skipped today).

## 1. What phase 1 delivered

| file | what |
|---|---|
| `shared/sail/rigs.js` | frozen data: `SAIL_TYPES`, `RIGS` (Appendix A hull + sails + plans, §2.4 spars, `loa`, `vmaxKn`, `crew`, `tauV`), `rigOf`, `sailIds`, `sailArea`, `sailDef`, `planState`, `plansAt`, helpers `D2R KN clamp sstep lerpT` |
| `shared/sail/state.js` | `RIG_SCHEMA`, `AUTO`, `defaultRig`, `normalizeRig`, `ensureRig`, `anyHoisted`, `applyRigCommand`, `applyPlan`, `settleRig` (new), `packRigView`, `unpackRigView`, `rigViewOf`, `RV_LIMITS` |
| `shared/sail/aero.js` | `coeffs`, `aero` (Appendix A + game extras: telltales, slatting, crew-work drive ×0.4), `apparent`, `trimDelta`, `twistFor`, `autoTrimSail`, `chordOf` / `sheetFor` / `trimFor` (sheet + traveller ↔ chord angle), `windageCalm` |
| `shared/sail/hydro.js` | `RR`, `RM`, `RMmax`, `hull`, `rcalm`, `froude` |
| `shared/sail/vpp.js` | the steady-state solver `evalV`, `solve`, `trimmed`, `polarPoint` (kept out of `polar.js` so the generator never imports the table it overwrites) |
| `shared/sail/polar.js` | `polarSpeed`, `bestVmg` (1° scan, cached), `noGoDeg`, `maxSpeedKn` |
| `shared/sail/polars.gen.js` | generated: TWS 0–40 kn step 2 **plus a 25 kn row** × TWA 0–180° step 5, four classes (38 kB) |
| `shared/sail/trim.js` | `trimInfo`, `autoTrimView`, `autoTrimStep` (helper *full*: depower, plan levels, trim), `trimSheets`, `adviceFor`, `ADVICE_TEXT` |
| `shared/sail/sailphys.js` | `stepSail` (full path + fast path, crew work, jibe guard, flips, crash jibe, irons, catamaran hull load, NaN guard, yaw, position), `windOverWater`, `gustFactor`, `crashJibeDamage`, `jobSeconds`, `sheetRate`, `furlRate`, `SUBSTEP_S`, `FAST_DT`, `FAST_WARP` |
| `shared/sail/tactics.js` | `sailCourse`, `beginManeuver`, `maneuverStep`, `helmFF`, `authOf`, `crossTrackM`, `sailHelm` (offline/captain helm), `harbourRigCmd`, `departurePlan`, `HARBOUR_FURL_M` |
| `scripts/gen-polars.mjs` | generator (`--only cls --part f.json` / `--merge …` to run classes in parallel) |
| `test/sail-helpers.mjs` | test helper: `stepSailShip` = a faithful copy of stepShip's preamble + `stepSail` until physics.js is wired, **then the real `stepShip`** (auto-detected) |
| `test/sail-{state,aero,hydro,polar,dynamics,tactics,server}.test.mjs` | §6.4 A tests; the Game-level ones skip with `needs wiring (phase 2)` and switch on by themselves once the edits below are in |

### 1.1 `stepShip` env fields the sail branch reads (client: Lane B)

`wind {u, v, spd?, gust?}`, `current`, `tideStream`, `waveH`, `sailsUp` (legacy master switch: `false` = no sail drive),
`grounded`, `simTime` (gust phase), `gusts: true` (game client only; server/tests leave it off), `warp` (client warp
factor: > 20 → fast path, crew instant), `fast: true` (server offline voyages and captains), `crewAuto: 'full'` (the
autopilot, captains and offline voyages run the crew on *Auto* without touching the saved `rig.auto`).

### 1.2 RigState extensions (beyond the §1.4 JSDoc; all repaired by `normalizeRig`)

`clk` (rig clock, s), `lvT` / `hiT` (plan-level timers), `rel` (catamaran sheet release, s left), `over` (hull load ≥ 1
timer), `man` / `manT` (Z manoeuvre in progress), `bk` (tack being backed out of irons), `yr` (last yaw rate °/s),
`load` (catamaran HM/RMmax), `nan` (guard counter, tests assert 0), `fast` (1 when the last step used the fast path),
`ev` (pending events for the client: `{kind: 'crash_jibe', aws}` / `{kind: 'strain'}` — the client drains it and sends
`rig_event`); per sail `be` (heeled mid-band AWA) and `al` (mid-band AoA) — diagnostics for the auto-trim and the HUD.

## 2. Order of work

1. `shared/physics.js` (P1–P3). After it, `test/sail-dynamics.test.mjs` runs through the real `stepShip` (its last test
   un-skips) and `test/telegraph.test.mjs` / `test/warp.test.mjs` stay green.
2. `server/game.js` (G1–G12) — the file other agents edit; anchors are content, not lines.
3. `server/fleet.js` (F1–F5) — save migration and the fleet view.
4. `server/captain.js` (C1–C4).
5. Run `node --test test/sail-*.test.mjs test/telegraph.test.mjs test/warp.test.mjs test/fleet-*.test.mjs
   test/timemodel.test.mjs test/game.test.mjs` — the 11 phase-2 tests un-skip by themselves (they look for
   `rigCommand(` / `sailHelmOffline(` in `server/game.js` and for `ship.rig` after a `stepShip`).

## 3. The edits

### 1. `shared/physics.js`

**P1** — Imports. No cycle: shared/sail/* never imports physics.js.

Anchor (insert **after** the anchor line):

```js
import { THROTTLE_MIN, ASTERN_SPEED_FRAC } from './telegraph.js';
```

Code:

```js
import { stepSail } from './sail/sailphys.js';              // SAIL contract §2.10: the sail branch of stepShip
import { rigOf, KN as SAIL_KN } from './sail/rigs.js';
import { polarSpeed } from './sail/polar.js';
```

**P2** — stepShip: right after the `speedPenalty` line (actuators already applied). Engine classes never reach it. The old `if (C.sail) { const sailPower = … }` block below becomes dead code for the four rigs; leave it or reduce it to `ut = targetFrac(s.throttle) * speedPenalty;`.

Anchor (insert **after** the anchor line):

```js
  const speedPenalty = Math.max(0.1, 1 - 0.35 * (1 - cond) - 0.5 * flooding - 0.15 * loadFrac - 0.35 * sea * sea - waveLoss) * (env.towing ? (C.towPower ? 0.95 : 0.65) : 1);
```

Code:

```js
  if (C.sail && rigOf(s.cls)) {
    // Sailing yacht (docs/SAILING-CONTRACT.md §2): shared/sail/sailphys.js integrates surge, heel, leeway, yaw and
    // position and writes s.rig. Going astern it calls back into the legacy longitudinal model below (legacySurge).
    const legacySurge = (ut) => {
      const u0 = s.spd / C.maxKn;
      let u1;
      if (ut >= 0 && u0 >= 0 && u0 < ut) u1 = u0 + (ut - u0) * Math.min(1, dt / TAU_ACCEL);
      else u1 = u0 + (((hullDrag(ut) / bollard(ut)) * bollard(u0) - hullDrag(u0)) / inertiaTau(C)) * dt;
      s.spd = ((ut - u0) * (ut - u1) < 0 ? ut : u1) * C.maxKn;
    };
    const yawExtra = s.throttle < 0 && !TWIN_SCREW.has(C.id) ? PROP_WALK * C.turnRate * Math.min(1, s.throttle / THROTTLE_MIN) * (1 - 0.5 * Math.min(1, Math.abs(s.spd / C.maxKn) / 0.3)) : 0;
    return stepSail(s, env, dt, { C, speedPenalty, steerPenalty, legacySurge, yawExtra });
  }
```

**P3** — `sailPolar` kept as a wrapper (§6.1 A2): with a sail class it answers from the tables; without one the legacy curve stays.

Anchor (**replace** the anchor text with):

```js
export function sailPolar(hdgDeg, wind) {
  if (!wind) return 0;
```

Replacement:

```js
export function sailPolar(hdgDeg, wind, cls) {
  if (!wind) return 0;
  if (cls && rigOf(cls)) {           // SAIL: the generated polar (kn) as a fraction of C.maxKn, for old callers
    const u = num(wind.u, 0), v = num(wind.v, 0), tws = Math.hypot(u, v);
    const from = (Math.atan2(-u, -v) * 180) / Math.PI;
    return polarSpeed(cls, tws / SAIL_KN, (((hdgDeg - from) % 360) + 540) % 360 - 180).kn / (SHIP_CLASSES[cls]?.maxKn || 1);
  }
```


### 2. `server/game.js`

**G1** — Imports (after the last import line).

Anchor (insert **after** the anchor line):

```js
import { beaufort, douglas, seaForBeaufort } from '../shared/seastate.js';
```

Code:

```js
import { rigOf, KN } from '../shared/sail/rigs.js';                                    // sailing (docs/SAILING-CONTRACT.md)
import { ensureRig, anyHoisted, applyRigCommand, settleRig, packRigView, unpackRigView } from '../shared/sail/state.js';
import { maxSpeedKn } from '../shared/sail/polar.js';
import { sailHelm, crossTrackM, harbourRigCmd, departurePlan, HARBOUR_FURL_M } from '../shared/sail/tactics.js';
import { crashJibeDamage, windOverWater } from '../shared/sail/sailphys.js';
```

**G2** — Constructor: two WeakMaps keyed by the person object, so nothing lands in the state file (saveState spreads `...p`).

Anchor (insert **before** the anchor line):

```js
    this.fleet = new Fleet(this);
```

Code:

```js
    this.rigLimits = new WeakMap();                  // sailing: per-person rig command rate limit + rig_event times (never saved)
    this.rigViews = new WeakMap();                   // sailing: the rv each online skipper last sent (never saved)
```

**G3** — onAction: the legacy `sails` action maps onto the rig; new `rig` and `rig_event` actions.

Anchor (**replace** the anchor text with):

```js
        case 'sails': p.sailsUp = !!m.up; this.sendYou(p); return;
```

Replacement:

```js
        case 'sails': return this.rigCommand(p, { all: m.up ? 'set' : 'furl' }, true);   // legacy button → the rig (§3.4)
        case 'rig': return this.rigCommand(p, m.cmd);
        case 'rig_event': return this.rigEvent(p, m);
```

**G4** — New methods, inserted before `tugAssist` (anchor: its comment line).

Anchor (insert **before** the anchor line):

```js
  // Tugs: within 1500 m of the anchor
```

Code:

```js
  // ------------------------------------------------------------------ sailing (docs/SAILING-CONTRACT.md §3.4–§3.7)
  /** The rig of a sail-class ship (created/repaired lazily: §3.6); null for engine classes. */
  rigFor(p) { const s = p.ship; return s && rigOf(s.cls) ? ensureRig(s, p.docked ? false : p.sailsUp) : null; }
  /** { action: 'rig', cmd } and the legacy 'sails' button. ≤ 20 per second per person (extra dropped silently); no
   *  sendYou per command (the client is optimistic), a refused one gets `event warn`. */
  rigCommand(p, cmd, legacy = false) {
    const rig = this.rigFor(p);
    if (!rig) { if (legacy) { p.sailsUp = !!(cmd && cmd.all === 'set'); this.sendYou(p); } return; }
    let st = this.rigLimits.get(p); if (!st) { st = { times: [], jibeAt: 0, strainAt: 0 }; this.rigLimits.set(p, st); }
    const now = Date.now();
    while (st.times.length && now - st.times[0] >= 1000) st.times.shift();
    if (st.times.length >= 20) return;
    st.times.push(now);
    const r = applyRigCommand(p.ship.cls, rig, cmd);
    if (!r.ok) return this.event(p, 'warn', r.why);
    settleRig(rig);                                  // the server copy = what the crew is doing; her client runs the timing
    p.sailsUp = anyHoisted(rig);                     // the legacy master switch follows the rig (§3.6)
    if (legacy) this.sendYou(p);
  }
  /** { action: 'rig_event', kind: 'crash_jibe', aws } → §2.8 damage only with the helper off, ≤ once per 10 s;
   *  kind 'strain' (catamaran hull load ≥ 1 for 2 s, §2.6) → cond −1, ≤ once per 10 s, any helper level. */
  rigEvent(p, m) {
    const rig = this.rigFor(p); if (!rig || p.docked) return;
    let st = this.rigLimits.get(p); if (!st) { st = { times: [], jibeAt: 0, strainAt: 0 }; this.rigLimits.set(p, st); }
    const now = Date.now();
    if (m.kind === 'crash_jibe') {
      if (rig.auto !== 'off' || now - st.jibeAt < 10000) return;
      st.jibeAt = now;
      const dmg = crashJibeDamage(p.ship.cls, clamp(Number(m.aws) || 0, 0, 40));
      if (dmg > 0) { p.cond = Math.max(0, p.cond - dmg); this.event(p, 'warn', `Crash jibe! The boom slammed across — ${dmg.toFixed(1)} % condition lost.`); this.sendYou(p); }
    } else if (m.kind === 'strain') {
      if (!rigOf(p.ship.cls).cat || now - st.strainAt < 10000) return;
      st.strainAt = now; p.cond = Math.max(0, p.cond - 1);
      this.event(p, 'warn', 'The rig groans — the windward hull flew too long. Ease the sheets or reef.'); this.sendYou(p);
    }
  }
  /** rv for publicState (§3.7): online skippers' own (≤ 10 s old), else built from the ship's rig. */
  rvOf(p) {
    const s = p.ship; if (!s || !rigOf(s.cls)) return undefined;
    const got = this.rigViews.get(p);
    if (p.online && got && got.cls === s.cls && Date.now() - got.at < 10000) return got.rv;
    return packRigView(s.cls, this.rigFor(p)) || undefined;
  }
  /** Offline voyages and captains (§3.5): furl in the harbour band, hoist again clear of it, tack/gybe with sailCourse.
   *  → rudderCmd, or null when she is not sailing (engine class, every sail down). Memory: voyage.sail (saved, tiny). */
  sailHelmOffline(p, v, i, wp, brg, dist, nearM, env, dt) {
    const s = p.ship; if (!rigOf(s.cls)) return null;
    const rig = ensureRig(s, p.sailsUp);
    const mem = v.sail && typeof v.sail === 'object' ? v.sail : (v.sail = {});
    mem.t = (Number(mem.t) || 0) + dt;               // the voyage's own clock (captains substep inside one tick)
    const furl = harbourRigCmd(rig, nearM);
    if (furl) { applyRigCommand(s.cls, rig, furl); settleRig(rig); mem.furled = 1; }
    else if (mem.furled && !anyHoisted(rig) && nearM > HARBOUR_FURL_M) {
      const ww = windOverWater(env);
      applyRigCommand(s.cls, rig, departurePlan(s.cls, ww.tws / KN, angleDiff(brg, ww.twd))); settleRig(rig); mem.furled = 0;
    }
    p.sailsUp = anyHoisted(rig); env.sailsUp = p.sailsUp;
    if (!p.sailsUp) return null;
    const a = i > 0 ? v.route[i - 1] : (Array.isArray(mem.o) ? mem.o : (mem.o = [s.lat, s.lon]));
    const h = sailHelm(s.cls, s, { brg, distM: dist, xtM: crossTrackM(s.lat, s.lon, a[0], a[1], wp[0], wp[1]), env, nowS: mem.t, mem });
    return h ? h.rudderCmd : null;
  }


```

**G5** — onState: the per-second move budget uses the rig's speed cap for sail classes.

Anchor (**replace** the anchor text with):

```js
    const perSec = (C.maxKn * 1.35
```

Replacement:

```js
    const vmaxKn = C.sail ? Math.max(C.maxKn, maxSpeedKn(s.cls)) : C.maxKn;   // sailing: the rig's absolute cap (§3.8)
    const perSec = (vmaxKn * 1.35
```

**G6** — onState: the reported speed clamp.

Anchor (**replace** the anchor text with):

```js
    s.spd = clamp(Number.isFinite(spd) ? spd : 0, -C.maxKn * 0.6, C.maxKn * 1.1);
```

Replacement:

```js
    s.spd = clamp(Number.isFinite(spd) ? spd : 0, -C.maxKn * 0.6, vmaxKn * 1.1);
```

**G7** — onState: accept `rv` (validated by unpackRigView: length 1 + 5·n, integers, ranges).

Anchor (insert **after** the anchor line):

```js
    p.rejects = 0; p.moveBudget -= moved;
```

Code:

```js
    if (m.rv !== undefined && rigOf(s.cls)) {        // sailing: the skipper's rig view for the others (§3.7), ≤ 2 Hz
      const prev = this.rigViews.get(p);
      if ((!prev || now - prev.at >= 450) && unpackRigView(s.cls, m.rv)) this.rigViews.set(p, { rv: m.rv.slice(), at: now, cls: s.cls });
    }
```

**G8** — publicState: `rv` (JSON drops the key for engine classes).

Anchor (insert **after** the anchor line):

```js
      vid: p.vessel?.id ?? null, vname: p.vessel?.name ?? null,   // v6: which of her ships the skipper sails
```

Code:

```js
      rv: this.rvOf(p),                                          // sailing: rig view (§3.7); undefined for engine classes
```

**G9** — simulateOffline env (the only `towing: !!p.towing, sailsUp:` in the file).

Anchor (**replace** the anchor text with):

```js
towing: !!p.towing, sailsUp: p.sailsUp !== false,
```

Replacement:

```js
towing: !!p.towing, sailsUp: p.sailsUp !== false,
      fast: true, simTime: this.simTime, gusts: false, crewAuto: 'full',   // sailing: offline/captains use the polar fast path, crew on auto (§2.10)
```

**G10** — simulateOffline steering: sail classes with a sail set go through `sailCourse` (tack/gybe, helm feed-forward).

Anchor (**replace** the anchor text with):

```js
    stepShip(s, { throttleCmd: throttle, rudderCmd: clamp(angleDiff(s.hdg, brg) / 25, -1, 1) }, env, dt);
```

Replacement:

```js
    const rudderCmd = this.sailHelmOffline(p, v, i, wp, brg, dist, nearM, env, dt) ?? clamp(angleDiff(s.hdg, brg) / 25, -1, 1);
    stepShip(s, { throttleCmd: throttle, rudderCmd }, env, dt);
```

**G11** — tugAssist: furl once when the assist begins (§3.4). Anchor is inside tugAssist, right after `p.money -= cost; p.fishing = false; p.voyage = null;`.

Anchor (insert **after** the anchor line):

```js
    p.ship.throttle = 0; p.ship.rudder = 0;
```

Code:

```js
    { const rig = this.rigFor(p); if (rig && anyHoisted(rig)) { applyRigCommand(p.ship.cls, rig, { all: 'furl' }); settleRig(rig); p.sailsUp = false; this.event(p, 'info', 'The crew furls the sails for the tow.'); } }
```

**G12** — warpConditions: an empty tank only warps with a sail actually set (§3.5).

Anchor (**replace** the anchor text with):

```js
    if (!(p.fuel > 0) && !(C.sail && p.sailsUp !== false)) return 'out of fuel.';
```

Replacement:

```js
    if (!(p.fuel > 0) && !(C.sail && p.sailsUp !== false && (!rigOf(s.cls) || anyHoisted(this.rigFor(p))))) return 'out of fuel.';
```


### 3. `server/fleet.js` (save migration, fleet view)

**F1** — Imports.

Anchor (insert **after** the anchor line):

```js
import { tugsPublic } from './tugassist.js';
```

Code:

```js
import { rigOf } from '../shared/sail/rigs.js';                              // sailing (docs/SAILING-CONTRACT.md §3.6–§3.7)
import { ensureRig, normalizeRig, anyHoisted, packRigView } from '../shared/sail/state.js';
```

**F2** — makeVessel: the rig is created with the vessel (at sea: sails set as `f.sailsUp` says; moored: down).

Anchor (**replace** the anchor text with):

```js
fishInfo: null, sailsUp: true,
```

Replacement:

```js
fishInfo: null, sailsUp: this.sailRig(f.ship, !f.docked, f.sailsUp),
```

**F3** — healVessel (every saved vessel): old saves without a rig migrate — at sea with sailsUp → working sails set; moored / laid up → all down; helper hint.

Anchor (insert **after** the anchor line):

```js
    if (v.status === 'laidup') { v.orders = null; v.cap = null; }
```

Code:

```js
    if (v.ship && typeof v.ship === 'object' && (rigOf(v.ship.cls) || v.ship.rig !== undefined)) v.sailsUp = this.sailRig(v.ship, !v.docked && v.status !== 'laidup', v.sailsUp);   // sailing: save migration (§3.6); engine-class records stay byte-identical
```

**F4** — New method next to healVessel.

Anchor (insert **before** the anchor line):

```js
  /** Defaults for a saved vessel (v6 record) — never throws. */
```

Code:

```js
  /** Sailing (§3.6): create/repair ship.rig (a newer schema or a class change → a default rig). At sea the sails stay
   *  as the legacy `sailsUp` says; moored or laid up they are down. → the new sailsUp (engine classes: unchanged). */
  sailRig(ship, atSea, sailsUp = true) {
    if (!ship || !rigOf(ship.cls)) { if (ship && ship.rig !== undefined) delete ship.rig; return sailsUp !== false; }
    ship.rig = normalizeRig(ship.cls, ship.rig, atSea ? sailsUp : false);
    return anyHoisted(ship.rig);
  }
```

**F5** — publicOf (feeds viewFor): fleet ships carry `rv` (the fast path keeps the rig's angles current).

Anchor (**replace** the anchor text with):

```js
if (t) o.tugs = t; }
    return o;
```

Replacement:

```js
if (t) o.tugs = t; }
    if (rigOf(s.cls)) o.rv = packRigView(s.cls, ensureRig(s, v.docked ? false : v.sailsUp));   // sailing: rig view (§3.7)
    return o;
```


### 4. `server/captain.js`

**C1** — Imports.

Anchor (insert **after** the anchor line):

```js
import { throttleCap, stormOnRoute } from '../public/js/pilotcore.js';
```

Code:

```js
import { rigOf } from '../shared/sail/rigs.js';                              // sailing (docs/SAILING-CONTRACT.md §3.5)
import { anyHoisted, applyRigCommand, settleRig } from '../shared/sail/state.js';
```

**C2** — startLeg (castOff and every re-plan at sea): sails down → hoisted by `sailHelmOffline` once she is > 2,500 m from the anchor.

Anchor (insert **after** the anchor line):

```js
  v.ship.throttle = FLEET.SERVICE_THROTTLE;            // the telegraph goes ahead at once (wages run from this step)
```

Code:

```js
  if (rigOf(v.ship.cls)) v.voyage.sail = { furled: anyHoisted(v.ship.rig) ? 0 : 1 };   // sailing: the crew hoists the plan for the wind once clear of the harbour band (simulateOffline)
```

**C3** — sail(): inside a built harbour patch the crew furls (the pilot steps her at harbour speed).

Anchor (**replace** the anchor text with):

```js
    if (inPatch(g, s)) pilotStep(g, v, h); else g.simulateOffline(a, h);
```

Replacement:

```js
    if (inPatch(g, s)) { furlInPatch(v); pilotStep(g, v, h); } else g.simulateOffline(a, h);
```

**C4** — New helper above startLeg.

Anchor (insert **before** the anchor line):

```js
/** Sail `points` towards target `tgt` (phase sailing). */
```

Code:

```js
/** Sailing (§3.5): the harbour pilot's waters — every sail furled (once). */
function furlInPatch(v) {
  const rig = rigOf(v.ship.cls) ? v.ship.rig : null;
  if (!rig || !anyHoisted(rig)) return;
  applyRigCommand(v.ship.cls, rig, { all: 'furl' }); settleRig(rig); v.sailsUp = false;
  if (v.voyage) v.voyage.sail = { ...(v.voyage.sail || {}), furled: 1 };
}
```


## 4. Protocol (for Lane B and the reviewer)

| direction | message | notes |
|---|---|---|
| C → S | `{ t: 'action', action: 'rig', cmd }` | `cmd` per §3.4; ≤ 20/s per person (extra dropped silently); refused → `event warn` with `why`; no `you` per command. The server applies it with `applyRigCommand` and then `settleRig` (its copy of an online skipper's rig = what the crew is doing; her client runs the timing), and sets `sailsUp = anyHoisted(rig)`. |
| C → S | `{ t: 'action', action: 'sails', up }` | legacy button → `{ all: up ? 'set' : 'furl' }`, then `you` as before. Engine classes: unchanged. |
| C → S | `{ t: 'action', action: 'rig_event', kind: 'crash_jibe', aws }` | damage `crashJibeDamage(cls, aws)` only when the stored `rig.auto === 'off'`, ≤ once per 10 s, `aws` clamped 0…40. `kind: 'strain'` (catamaran, `rig.ev`) → cond −1, ≤ once per 10 s. The client drains `ship.rig.ev` after each simulate step and sends one action per event. |
| C → S | `state` gains `rv: int[]` | ≤ every 500 ms; validated by `unpackRigView` (length `1 + 5·n`, integers, ranges); stored in a WeakMap (never saved); a second rv within 450 ms is ignored. |
| S → C | `you.ship.rig` | the RigState (from `privateState`'s `{ ...p.ship }`); the client takes it on hard sync only. |
| S → C | `players[].rv`, `join.player.rv` (publicState) | online skippers: their last rv (≤ 10 s old), else built from `ship.rig`; engine classes: no key. |
| S → C | fleet entries (`publicOf` / `viewFor`) gain `rv` | built from the vessel's rig (the fast path keeps angles/sides current). |

## 5. Save format and migration (§3.6)

`ship.rig` rides in `vessel.ship` (saved as is). `healVessel` (every saved vessel) and `makeVessel` (`adoptPlayer`,
buying) call `sailRig`: no rig / a broken one / a newer schema / another class → `normalizeRig` → at sea with the legacy
`sailsUp !== false`: every working sail set (light sails down), reefs 0, helper *hint*; moored or laid up: all down.
`sailsUp` stays in `VESSEL_KEYS` and now follows the rig (`anyHoisted`) for sail classes — so a moored sloop loads with
`sailsUp: false` (her sails are down) and the old *Sails* button hoists them. Engine-class records stay byte-identical
(the fleet-model "second load is identical" test checks it). Rigs on engine classes are deleted lazily by `ensureRig`.

## 6. Validation run (2026-10-09, scratch copy with every edit above applied)

- `test/sail-*.test.mjs`: **57 / 57 pass** (0 skipped — the 11 phase-2 tests included: server actions, rate limit,
  legacy button, tug furl, warp, move budget, rv, save/load + migration, crash-jibe damage, `Game.simulateOffline`
  5 nm dead upwind, a captain sailing a schooner to IJmuiden dead upwind and berthing).
- `telegraph`, `warp`, `timemodel`, `tugs`, `tugs-review`, `fleet-captain`, `fleet-model`, `fleet-office`, `fleet-buy`,
  `fleet-switch`, `fleet-shared`, `fleet-perf`, `game`, `jobs`, `pilot`, `autopilot-review`, `warp-harbour`,
  `wave1-review`, `berthguide`, `express-safe`, `market`, `weather-storms`, `interior`, `interior-review`, `ais`: green.
  (One fix found by this run is already in F3: touch `sailsUp` only for sail classes, or the engine-class save
  round trip in `fleet-model` changes.)

## 7. Contract notes (deviations found while porting; numbers and equations of Appendix A unchanged)

1. **Helm feed-forward sign.** §2.7 / §3.5 write `+tack·H/max(auth, 0.2)`. With the contract's own conventions (rudder +
   turns to starboard, the sail moment `+tack·turn·way·H` turns her towards the wind) the cancelling rudder is
   **`−tack·H/max(auth, 0.2)`** — Appendix A `sim()` agrees (`rud = … + H/auth` in its bear-away-positive frame).
   `tactics.js helmFF()` uses the corrected sign; Lane B's autopilot must call `helmFF` (or `sailCourse().helmFF`)
   rather than re-typing the formula.
2. **Schooner L0 has no light sails.** Appendix A `planState` hoists light sails only when the plan names them, and
   the schooner's L0 is `set: {}`; so the generated polars (and Appendix B) never use "all seven". Kept as is (the
   numbers come from it); the HUD/crew presets follow the same data. To really fly the topsails in L0, add
   `flyjib/foretop/maintop: { hoist: 1 }` to `plans[0].set` and regenerate (reviewer's call: tables change).
3. **Catamaran 6 kn / 45°.** The table says 0 kn (the solver's root scan stops at V = 0.5 m/s), but the time domain —
   Appendix A `sim()` itself — creeps along at **2.61 kn** with the code 0. The contract's "< 1 kn" cannot hold; the
   test asserts < 3 kn and the table value stays 0 (the HUD target / tactics treat it as no-go, which is right).
4. **Best downwind VMG angle is 175° in 12 kn and more**, not 165°: the generated grid has 170° and 175°, which
   Appendix B's printed columns skip (wing-on-wing past 160° keeps the speed flat to 175°). `bestVmg` returns 175°
   (6 kn: 135–140°); the downwind tactics test checks "gybes at bestVmg.down (160–178°)".
5. **Crash jibe at 15 kn true does no damage under §2.8's formula** (running at ~6 kn the apparent wind is 4.6 m/s,
   below the 6 m/s threshold). The jibe test runs at 20 kn true (AWS ≈ 7 m/s). The total is capped at 3 points
   (§6.7) — `(0.2 + 0.08·(aws − 6))·A_main/30` alone would give the schooner up to 22.
6. **§6.4 A-2 wording.** A genoa at dmin with AWA 15° has its middle band at α ≈ −1° (flogging, not luffing); at AWA 40°
   hard in, the middle band is past αs (leeward telltale) but the stall blend is < 0.25 (state 0, the bottom band is
   stalled). The test checks "not drawing + windward telltale" and the stall telltales. "A 1 m/s current from ahead
   adds 1 m/s": true for a stream running *against* the wind (into the wind's eye); a current running with the wind
   takes it away — the test is written that way.
7. **Topsails' twist** follows Appendix A `twistFor` (car fixed at travMax = 4°, boomed formula), not §2.3.4's headsail
   formula; the sheet maps δ = 4 + sheet·(80 − 4).
8. **`all: 'set'`** (legacy button, migration) = every non-light sail up, unreefed (catamaran: jib + main; L0 proper
   would swap the jib for the code 0). Crew jobs queue in RIGS order (front to back), not command order.
9. **Jibe guard**: while it is active (helper *hint/full*, |AWA| > 150°, turning through the stern / Z jibe / by the
   lee) the crew hauls boomed sheets at 3× the winch rate and the jibe counts as controlled.
10. **Polar grid** carries an extra TWS 25 kn row (non-uniform axis; `polarSpeed` interpolates any sorted axis) so the
    §2.12 25 kn checks are exact table points. `env.fast === false` forces the full path (tests: dt 0.5/1.0 stability).
11. The solver lives in `shared/sail/vpp.js` (new file) instead of `polar.js`; the dynamics tests use
    `test/sail-helpers.mjs` (new helper file) until physics.js is wired.

## 8. Measured (phase 1, real tree)

- Polar table vs Appendix B at TWS 6/12/20/25 × TWA 45/60/90/120/150, four classes: **all 80 points within 0.05 kn**
  (worst sloop 6/90: 5.95 vs 6.0). Six re-solved points: equal to the stored values. Best VMG upwind (°/kn):
  sloop 48/3.12, 42/4.59, 40/4.84, 45/4.74; ketch 47/3.20, 41/4.95, 40/5.59, 41/5.56; catamaran 53/2.33, 52/3.84,
  50/5.07, 55/5.20; schooner 50/3.05, 49/4.97, 45/5.93, 47/6.04. `noGoDeg` sloop 12 kn 37°, catamaran 12 kn 47°.
  Speed at TWA 25° in 12 kn: 0 for all four.
- Time domain (10 Hz, helper *full*, from 70 %, last 120 s): all 59 points within **−2.7 % … +3.5 %** of the table
  (worst catamaran 20/45 −2.7 %, schooner 12/150 +3.5 % — as the contract's reference run). Heel sloop 12/45 19.4°,
  schooner 12/45 8.5°, catamaran 12/45 0.8°. dt 0.5 / 1.0 (full and fast path) within 1 % of dt 0.1.
- Overpowered 25 kn / 60° (full sail, max-power trim vs reefed polar level): sloop 1.50 kn 33.1° rounds up to TWA 26°
  vs L2 7.59 kn 22.0°; ketch 6.41 kn 34.0° (TWA 39°) vs L1 8.67 kn 20.0°; schooner 5.98 kn 23.0° (TWA 34°) vs L2
  10.37 kn 18.0°. Catamaran plain sail 25 kn/60°: 11.7 kn, ~3° heel, hull load 0.62.
- Cost (Node 20, loaded shared box, including the test harness and helm): full step ≈ 10 µs sloop / 19 µs schooner;
  fast step ≈ 5 µs sloop / 10 µs schooner (the contract's < 3 µs is not met: the fast path re-trims every sail each
  step for the rig view — cache it per 1° of AWA if fleet-perf ever needs it; `test/fleet-perf` is green).
