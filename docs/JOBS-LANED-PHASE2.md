# Lane D (cargo + jobs): phase 2 hook edits

This document goes with `docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md` §5 and §7.4 (H5b, H6, H6b–H6e, H7).

In phase 1, lane D added **only new files**. Phase 2 is the short list of hook edits below. Apply them to the existing
files after their current owners have merged. Every anchor below is the exact text in the file on 2026-10-09 (each
was checked with `grep -cF` and occurs once). Change the anchor only as shown. Do not edit nearby code.

## 0. What phase 1 delivered (all new files)

| File | What it is |
|---|---|
| `shared/cargo.js` | §5.1 taxonomy (`CARGO`, `HANDLING`, `UNITS`, `SUGGEST`), `handlingOf`, `unitsOf`, `eqOf` (option-aware: `geared`/`gearless`; `hoseCranes:1` also counts as `hoseCranes`), `craneSwlOf`, `canLoad`, `loadOption`, `freeUnits`, `toTonnes`/`fromTonnes`, `makeStack`, `marketGoodOf` |
| `shared/jobs/shipview.js` | Lane D's read-only view of Lane A (`shared/ships/index.js`). It loads Lane A with a guarded top-level `import()`. Without Lane A it falls back to the 17 legacy rows plus the §5.2 legacy handling. `setShipSource(stub)` is for tests. |
| `shared/jobs/types.js` | `JOB_GEN = 8`, `STEP_KINDS`, `LEGACY_TYPES`, `GROUPS`, `step()`, `validJob()`, `payOf`/`payInfoOf`, **`wireJob`**, `isRunnerJob`, `isLegacyGen`, `boardCurrent`, `migrateAcceptedJob`, `healCargoStack`, `migrateActor` |
| `shared/jobs/catalogue.js` | `FAMILIES` holds **36 families**: the 7 legacy families plus 29 runner families. Each family has `label`, `group`, `unit`, `captains`, `phase`, `fit(cls)`, `needs`, `steps`, `pay`, `hours`. Also: every §5.5 pay formula as a named function, `eos`, `PAY`, the extended fishing helpers (`SPECIES`, `speciesFor`, `weeklyQuota`, `fishValueFrac`, `payFish`), `familiesFor`, `payFor`/`payCrFor` (hire is computed for the accepting ship, with a 120,000 floor on the hire basis), `stepHours`, `CAPTAIN_TYPES`, `RUNNER_TYPES` |
| `shared/jobs/eligibility.js` | `canDo(job, vessel, ctx)` returns `{ ok, why, all }` and runs the checks in the §5.8 order. Also: `reasonText`, `facilityGap`, `portsOf`, and **`jobtimeHooks(ctxFn)`** for H6c. The politics `jobCheck` is called through a guarded import of `shared/politics.js` when `ctx.politics.ds` is set. The Jones Act check runs behind `ctx.jonesActive` (R1/R4). |
| `shared/jobs/ports.js` | §5.6 tags: size defaults, seed table, per-port overrides (`tags` replaces the defaults for single-purpose ports; `maxLoa`, `maxDraft`, `vloc`, `lng`). Also `tagsOf`, `limitsOf`, `isSeed`, `shortName`. |
| `shared/jobs/sites.js` | 19 wind farms, 8 eco-tour sites with seasons, 3 seasonal ice zones (`iceNeedAt`), and `windfarmsNear` |
| `shared/jobs/board.js` | DOM-free board logic: `groupBoard` (mine / fleet / other), `profitPerH`, `familyChips`, `unitLine`, `stepsPreview` |
| `server/jobsgen.js` | `weightsFor` (§5.7 weights; seed-listed specialist ports ×4; `EXPORTERS` limits crude/LNG/LPG voyages to loading terminals). One builder per runner family (`BUILDERS`). Also: `generateBoard` (24/16/10/6), `generateFamilyJob` (legacy families go through `economy.generateJob`, then are stamped gen 8), `ensureFit` (≥ 3 doable jobs), `generateSalvage`, `extendFishing`, `BANDS` |
| `server/jobsx.js` | `JobsX` is the single step runner. It has `accept`, `onTick`, `onDock`, `onAction('job_step')`, `onIncident`, `settle`, `settleAmount`, `abandon`, `abandonPenalty`, `nextTarget` (for captains), and pass-throughs `generate` / `ensureFit` / `salvage`. Also exports `migrateSave`, `tcfOf`, `sailStats`. |
| `public/js/jobboard.js` | `JobBoard`: `static create(app)` loads `/shared/jobs/board.js`; `html(h, you)`; `click(el, net)` handles `jbFilter` and `jbAssign` (sends `fleet_accept`) |
| `test/jobs2-*.test.mjs` | 7 suites, 50 tests: `cargo`, `eligibility`, `gen`, `runner`, `migration`, `board`, `compat`. `compat` runs against Lane A's real catalogue when it is present. |

Run: `node --test test/jobs2-*.test.mjs`. All 50 pass. No external services or data files are needed. The 1,000-board
mix test takes about 4 s.

### Deviations from the contract (the reviewer should note these)

1. **`pay` on the wire is a number.** The frozen `Job.pay` is `{ cr, … }` on the server (state, runner). Clients receive
   `wireJob(j)`: `pay` stays the credits number, so every existing reader (hud cards, chart boards, sorts) keeps
   working. The full record travels as `payInfo`. Legacy-family jobs keep a numeric `pay` everywhere, because
   `economy.generateJob` still makes them.
2. **H6b dispatch is in `game.regenHarbor`, not inside `economy.generateJob`.** `server/jobsgen.js` already calls
   `economy.generateJob` for the legacy families. Dispatching from inside it would create an import cycle.
3. **`needs` has optional extra keys:** `types`, `eqAny`, `maxLoa`, `grades`, `cats`, `licence`. Every key the
   contract lists keeps its meaning.
4. **Pilot-transfer pay (`PAY.PILOT_*`) and delivery-passage pay (`PAY.DELIVERY_*`) are placeholders.** The contract
   defers the pilot transfer to V7 #2 and leaves the yacht "delivery" pay unspecified. Both are flagged "verify".
5. **Regatta time-correction factor is `maxKn / 8`.** This is a Game rule until SAILING exposes polar target speeds
   (request S1+). The lesson task counters read `v.sail.stats` / `ship.rig.stats` (S1). Until those exist they read 0,
   so tasks stay open and the lesson pays without the bonus.

---

## 1. `server/economy.js` (H6b)

**1a.** Anchor `export const JOB_GEN = 7;` → replace with:

```js
export const JOB_GEN = 8;   // YARD §8: gen-7 offers leave the boards at start; accepted gen-7 jobs finish on the legacy path
```

**1b.** Anchor `const SIZE_JOBS = { mega: 8, major: 6, regional: 5, minor: 3 };` → replace with:

```js
const SIZE_JOBS = { mega: 24, major: 16, regional: 10, minor: 6 };   // YARD §5.7 board sizes (= server/jobsgen.js BOARD_SIZE)
```

**1c.** Add this import directly below `import { JOBTIME, refClassFor, budgetFor } from '../shared/jobtime.js';`:

```js
import { payOf, payInfoOf } from '../shared/jobs/types.js';   // YARD lane D: runner jobs carry pay as { cr, … }
```

**1d.** In `publicJob`, anchor
`id: j.id, type: j.type, title: j.title, from: j.from, to: j.to, toName: to ? to.name : j.to, pay: j.pay,` → replace
that line and the next one (`payPerT: …`) with:

```js
    id: j.id, type: j.type, title: j.title, from: j.from, to: j.to, toName: to ? to.name : j.to, pay: payOf(j), payInfo: payInfoOf(j),
    payPerT: perUnit ? Math.round(payOf(j) / perUnit) : null, distKm: j.distKm ?? null, needsCat: j.needsCat || null,
    gen: j.gen ?? null, family: j.family || j.type, cargo: j.cargo || null, needs: j.needs || null, steps: j.steps || null, legs: j.legs || null,
    timetable: j.timetable || null, level: j.level ?? null, crossings: j.crossings ?? null, entries: j.entries ?? null, band: j.band || null,
```

---

## 2. `shared/jobtime.js` (H6c)

**2a.** Directly below `import { RATES, serviceKn, catchRate, kmHours, shipClass } from './rates.js';`, add:

```js
// YARD lane D (H6c): JOB_GEN 8 checks and hours come from shared/jobs/eligibility.js jobtimeHooks(), registered at start-up
// by the server (server/game.js) and the client (main.js), so this module keeps no import cycle with the jobs modules.
let gen8 = null;
export function setGen8(hooks) { gen8 = hooks || null; }
```

**2b.** The first line inside `export function needFor(job, cls) {` (before `const C = shipClass(cls), type = job && job.type;`):

```js
  if (gen8) { const n = gen8.needFor(job, cls); if (n) return n; }
```

**2c.** The first line inside `export function hardReason(job, ship) {` (before `const C = shipClass(ship && ship.cls);`):

```js
  if (gen8) { const r = gen8.hardReason(job, ship); if (r !== undefined) return r; }
```

`budgetFor` and `refClassFor` need no change. Runner jobs carry their own `hours` and `ref`, and legacy families keep
today's rules.

---

## 3. `shared/fleet.js` (H6d)

Anchor `export const CAPTAIN_JOB_TYPES = ['freight', 'passengers', 'charter', 'fishing', 'supply'];` → replace with:

```js
export const CAPTAIN_JOB_TYPES = ['freight', 'passengers', 'charter', 'fishing', 'supply',
  'box', 'voyage', 'coa', 'tc', 'vehicles', 'ropax_route', 'standby', 'crewchange', 'bunkering', 'launch', 'dredge', 'survey']; // YARD H6d
```

(This is the contract list. It equals `CAPTAIN_TYPES` in `shared/jobs/catalogue.js` minus `liner`. Liner has
`captains: true` there but is a phase-4 family.)

---

## 4. `server/game.js` (H6, H7)

**4a. Imports.** Directly below `import { estimateJob, fmtShipH } from '../shared/jobtime.js';`, add:

```js
import { setGen8 } from '../shared/jobtime.js';                                               // YARD lane D H6c
import { JobsX } from './jobsx.js';                                                            // YARD lane D H6: the step runner
import { wireJob, isRunnerJob, payOf, migrateActor } from '../shared/jobs/types.js';
import { canDo, jobtimeHooks } from '../shared/jobs/eligibility.js';
import { canLoad } from '../shared/cargo.js';                                                  // YARD lane D H7
const JOBS_PHASE = 2;   // YARD §12: phase-2 families only; 4 = every family
```

**4b. Constructor.** Directly below `this.fleet = new Fleet(this);                   // v6 fleet: vessels, office, captains (before loadState)`, add:

```js
    this.jobsx = new JobsX({                                                   // YARD lane D: runner for JOB_GEN 8 families
      now: () => this.simTime, harborById,
      event: (a, kind, text) => this.event(a, kind, text),
      pay: (a, cr, j) => { a.money += cr; if (a.stats) { a.stats.delivered++; a.stats.earned += cr; } this.sendYou?.(a); },
      charge: (a, cr) => { if (!(a.money >= cr)) return false; a.money -= cr; return true; },
      ctx: (a) => this.jobsCtx(a),
      windKn: (a) => (this.weatherAt(a.ship.lat, a.ship.lon)?.wind?.spd ?? 0) / GEO.KN_TO_MS,
      seaHs: (a) => this.weatherAt(a.ship.lat, a.ship.lon)?.waves?.height ?? 0,
      heelDeg: (a) => this.rigFor?.(a)?.heel ?? 0,
      offHire: (a) => (a.cond ?? 100) < 30,
      damage: (a, pts) => { a.cond = Math.max(0, (a.cond ?? 100) - pts); },
    });
    setGen8(jobtimeHooks(() => ({ harborById, simTime: this.simTime })));
```

Add the following method directly above `  jobEnv() {`:

```js
  /** canDo context for actor `a` (YARD §5.8). Politics: pass { ds, ctx } here once the politics lane exposes them. */
  jobsCtx(a) {
    return {
      harborById, simTime: this.simTime,
      weatherAt: (id) => { const h = harborById(id); if (!h) return null; const w = this.weatherAt(h.lat, h.lon); return { windKn: (w?.wind?.spd ?? 0) / GEO.KN_TO_MS, hs: w?.waves?.height ?? 0 }; },
    };
  }
```

**4c. Load-time migration (§8).** Anchor `        this.migratePlayer(p);` → replace with:

```js
        this.migratePlayer(p);
        migrateActor(p);                              // YARD §8: accepted gen-7 jobs → legacy, cargo stacks get `unit`
```

Anchor `      this.fleet.afterLoad(savedAt);` (the line ends with a comment; keep it) → add directly after that line:

```js
      for (const v of this.fleet.vessels.values()) migrateActor(v);   // YARD §8 (fleet vessels)
```

**4d. Board generation (H6b dispatch).** Anchor (one line inside `regenHarbor`):
`      while (st.jobs.length < n && guard++ < 40) { const j = generateJob(h, this.simTime, this.rnd, undefined, this.jobEnv()); if (j) st.jobs.push(j); }`
→ replace with:

```js
      if (st.jobs.length < n) st.jobs.push(...this.jobsx.generate(h, this.simTime, this.rnd, this.jobEnv(), { n: n - st.jobs.length, phase: JOBS_PHASE })); // YARD §5.7
      void guard;
```

(`guard` is still declared on the line above. `void guard;` avoids an unused-variable lint warning.)

**4e. Fit guarantee + wire form (sendHarbor).** Anchor `    this.regenHarbor(h, st, false);` (inside `sendHarbor`) → replace with:

```js
    this.regenHarbor(h, st, false);
    this.jobsx.ensureFit(st.jobs, h, p, this.simTime, this.rnd, this.jobEnv(), { phase: JOBS_PHASE });   // YARD §5.7: ≥ 3 doable jobs
```

Anchor `jobs: st.jobs, market: st.market` → replace those 33 characters with:

```js
jobs: st.jobs.map(wireJob), market: st.market
```

**4f. `you.jobs` wire form.** Anchor `kits: p.kits, jobs: p.jobs, convoyId` → replace with:

```js
kits: p.kits, jobs: p.jobs.map(wireJob), convoyId
```

**4g. Accepting.** Anchor `    if (!job) return this.event(p, 'warn', 'That contract is gone.');` (inside `acceptJob`) → replace with:

```js
    if (!job) return this.event(p, 'warn', 'That contract is gone.');
    if (isRunnerJob(job)) {                                                   // YARD lane D: runner families
      const r = this.jobsx.accept(p, job);
      if (!r.ok) return this.event(p, 'warn', r.why || 'Not possible with this ship.');
      if (fromContact) st.contact.jobs = st.contact.jobs.filter((j) => j.id !== jobId); else st.jobs = st.jobs.filter((j) => j.id !== jobId);
      this.event(p, 'info', `Contract signed: ${job.title} — ${fmt(payOf(r.job))} cr, ${fmtShipH(r.job.hours)} of ship time. ${r.job.steps[r.job.prog.i]?.label || ''}`.trim());
      this.sendYou(p); this.sendHarbor(p); return;
    }
    if ((job.gen || 0) >= JOB_GEN) {                                           // YARD §5.8: gen-8 legacy families are checked too
      const c = canDo(job, p, this.jobsCtx(p));
      if (!c.ok && c.why.code !== 'time') return this.event(p, 'warn', c.why.text);
    }
```

**4h. Abandoning.** Anchor `    const penalty = Math.min(p.money, Math.round(j.pay * 0.1));` → replace with:

```js
    const penalty = Math.min(p.money, Math.round(payOf(j) * 0.1));
```

**4i. Dock hook.** Anchor `    p.ship.spd = 0; p.ship.throttle = 0; p.ship.rudder = 0; p.fishing = false;` (inside `setDocked`) → replace with:

```js
    p.ship.spd = 0; p.ship.throttle = 0; p.ship.rudder = 0; p.fishing = false;
    if (p.jobs?.length) this.jobsx?.onDock(p, harborId);                       // YARD H6: players and captains (captain.js docks via setDocked/moorAt)
```

**4j. Tick hook (players).** Anchor `      this.advanceShipClock(p, dt);` (the line ends with a comment; keep it) → add directly after that line:

```js
      if (p.jobs?.length) this.jobsx.onTick(p, dt * SIM.CLOCK_SCALE * this.shipRate(p));   // YARD H6: runner steps on the ship's clock
```

**4k. Action switch.** Anchor `        case 'accept_job': return this.acceptJob(p, m.jobId);` → add directly after that line:

```js
        case 'job_step': { if (!this.jobsx.onAction(p, 'job_step', String(m.jobId ?? ''))) this.event(p, 'warn', 'Not now — get on the spot and slow down.'); return this.sendYou(p); }
```

**4l. Incidents (lesson safety rule).** At the top of `  collision(p, m) {` and `  grounding(p) {`, add as the first line of each method body:

```js
    this.jobsx?.onIncident(p, 'collision');   // (in grounding: 'grounding')
```

**4m. Market compatibility (H7, §5.10).** Anchor `      const avail = Math.floor(st.stock[good] ?? 0);` (the `buying` branch of `tradeGoods`) → replace with:

```js
      const fit = canLoad(good, p.ship.cls);                                   // YARD H7: the hull must handle the good
      if (!fit.ok) return this.event(p, 'warn', `${GOODS[good].name}: ${fit.why.text}.`);
      const avail = Math.floor(st.stock[good] ?? 0);
```

Selling is unchanged. Cargo already aboard stays sellable (Q5).

---

## 5. `server/captain.js` (H6e)

**5a. Imports.** Directly below `import { anyHoisted, applyRigCommand, settleRig } from '../shared/sail/state.js';`, add:

```js
import { isRunnerJob } from '../shared/jobs/types.js';                   // YARD lane D H6e
```

**5b. Runner steps tick for captained vessels.** Anchor `  g.advanceShipClock(a, dt);` (inside `stepVessel`) → replace with:

```js
  g.advanceShipClock(a, dt);
  if (v.jobs?.length) g.jobsx?.onTick(a, dt);                            // YARD H6: runner steps (work hours, meets, tows)
```

**5c. Targets.** Inside `function jobTarget(fleet, v, j) {`, anchor `  switch (j.type) {` (the first switch in that function) → replace with:

```js
  if (isRunnerJob(j)) {                                                  // YARD H6e: the runner says where the next step is
    const t = g.jobsx?.nextTarget(fleet.actorOf(v), j);
    if (!t) return { fail: `${j.title}: captains cannot do this step — sail her yourself.` };
    if (t.kind === 'harbor') {
      if (v.docked === t.harbor) return { here: true, harbor: t.harbor, jobId: j.id, runner: true };
      const h = harborById(t.harbor); if (!h) return { fail: `${j.title}: the port is not on the chart.` };
      const an = g.harborAnchor(h);
      return { kind: 'harbor', harbor: h.id, name: short(h.name), lat: an.lat, lon: an.lon, jobId: j.id };
    }
    if (t.kind === 'stay') return v.docked ? { here: true, harbor: v.docked, jobId: j.id, runner: true, stay: true }
      : { kind: 'jobspot', name: 'on hire', lat: s.lat, lon: s.lon, jobId: j.id };
    return { kind: 'jobspot', name: j.steps[j.prog.i]?.label || 'the work site', lat: t.lat, lon: t.lon, jobId: j.id };
  }
  switch (j.type) {
```

**5d. Arrived alongside for a runner step.** Anchor `  if (tgt.jobId) {` (inside `arrivedHere`) → replace with:

```js
  if (tgt.runner) {                                                      // YARD H6e: the dock hook already advanced the job
    g.jobsx?.onDock(a, v.docked); g.sendYou(a);
    if (tgt.stay) { v.cap.nextAt = g.simTime + 60; return; }
    const again = contractTarget(fleet, v);
    if (again && again.here && again.runner && again.jobId === tgt.jobId && !again.stay) {
      const j = v.jobs.find((x) => x.id === tgt.jobId);
      return fail(fleet, v, `${j ? j.title : 'Contract'}: this step cannot be completed here (space or cargo).`);
    }
    return;
  }
  if (tgt.jobId) {
```

**5e. Holding at a work site.** Anchor `    case 'spot': return settle(fleet, v);` (inside `arrivalTest`) → replace with:

```js
    case 'spot': return settle(fleet, v);
    case 'jobspot': {                                                    // YARD H6e: on station for a work / meet / tow step
      if (d <= 400) { s.lat = t.lat; s.lon = t.lon; v.lastValid = { lat: t.lat, lon: t.lon }; }
      holdStill(v); v.cap = newCap(g, 'jobwork', { target: t, jobId: cap.jobId });
      return;
    }
```

Anchor `    case 'transfer': holdStill(v); transferStep(fleet, v); break;` (inside `stepSea`) → replace with:

```js
    case 'transfer': holdStill(v); transferStep(fleet, v); break;
    case 'jobwork': {                                                    // YARD H6e: hold still until the runner moves on
      holdStill(v);
      const nt = contractTarget(fleet, v);
      if (nt.done) return finishOrder(fleet, v);
      if (nt.fail) return fail(fleet, v, nt.fail);
      if (!sameTarget(nt, cap.target)) { v.cap = newCap(g, 'idle'); }
      break;
    }
```

Captains therefore run every runner family whose steps are harbour calls, `work`, `meet` or `tow`. A `drill` step
returns no target, so the captain stops with "captains cannot do this step". This covers the CTV crew change, the
pilot transfer and the lessons. The SOV crew change (`work`) is fine.

**5f. `server/fleet.js` fleet board (fit guarantee for a fleet ship).** Anchor
`    try { g.regenHarbor?.(h, st, false); } catch { /* keep the board as it is */ }` (inside `boardAction`) → replace with:

```js
    try { g.regenHarbor?.(h, st, false); g.jobsx?.ensureFit(st.jobs, h, v, g.simTime, g.rnd, g.jobEnv(), { phase: 2 }); } catch { /* keep the board as it is */ }
```

`hardReason` (H6c) already gives the fleet board and `moveJobAction` the gen-8 reasons. `acceptAction` goes through
`game.acceptJob` (4g), so runner jobs are accepted for fleet ships too.

---

## 6. `public/js/hud.js` (H5b) and `public/js/main.js` (H13, lane B applies)

**6a.** Anchor `  tabJobs(h, you, C) {` → replace with:

```js
  tabJobs(h, you, C) {
    if (this.app.jobBoard) return this.app.jobBoard.html(h, you);            // YARD H5b: grouped JOB_GEN 8 board
```

**6b.** Anchor (two lines inside `sheetAction`):

```js
  sheetAction(act, el) {
    const a = this.app, net = a.net, you = a.you, root = $('harborWrap');
```

→ add directly after these two lines:

```js
    if (a.jobBoard && (act === 'jbFilter' || act === 'jbAssign')) { a.jobBoard.click(el, net); return this.renderHarborTabs(); }   // YARD H5b
```

**6c. `main.js` (H13; lane B owns this file, so this is the line to hand over).** Next to the fleet import
`import('./fleet.js').then((m) => { this.fleetUi = new m.FleetUi(this); })…`, add:

```js
    import('./jobboard.js').then((m) => m.JobBoard.create(this)).then((b) => { this.jobBoard = b; this.hud?.renderHarborTabs?.(); }).catch((e) => console.warn('[jobs] board unavailable', e));
    import('/shared/jobtime.js').then(async (jt) => { const el = await import('/shared/jobs/eligibility.js'); jt.setGen8(el.jobtimeHooks(() => ({ harborById: (id) => this.world?.harbors?.find((h) => h.id === id) || null, simTime: Date.now() / 1000 }))); }).catch(() => {});
```

`JobBoard` reads `app.world.harbors` and `app.fleetUi.last.vessels`. CSS hooks: `.jbChips`, `.jbGroup`, `.jb`,
`.unitLine`, `.steps .st`, `.whyAll`, `.dim`. The existing card styles (`.card.jobCard`, `.payRow`, `.elig`) apply
unchanged.

---

## 7. Optional, phase 4 (do not apply in phase 2)

- **Fishing quotas:** in `game.deliverJobs`, in the fishing branch, cap `have` at
  `weeklyQuota(bestHoldT) − landed[company][ground][quotaWeek(simTime)]` (from `shared/jobs/catalogue.js`), and keep
  `landed` on `p.office`. When the server keeps the catch time, apply species pay through `job.species` (already set
  by `extendFishing`) and `fishValueFrac(hoursSinceCatch, eqOf(cls).includes('rsw') || eqOf(cls).includes('freezer'))`.
- **Salvage:** when a storm disables an AI ship near a coast, post
  `this.jobsx.salvage(refugeHarbour, { id, lat, lon, value }, simTime, rnd)` to the refuge harbour's board. Give the
  runner `claim(id, a)` so the first ship to connect wins.
- **Bareboat:** at accept, set the vessel's status to `chartered` (fleet), hide her, and restore her at settle. The
  runner already pays the hire and applies the condition loss and the 5 % damage claim.
- **`JOBS_PHASE = 4`** turns on the remaining families (liner, project, cruise, anchor, towage, ocean_tow,
  pilot_transfer, dredge, survey, research, escort, regatta, ecotour, guests, bareboat, delivery).

## 8. Requests to other lanes

| # | To | Request |
|---|---|---|
| S1 | SAILING | `rig.stats = { tacks, gybes, reefs, maxHeel10s }` counters (no physics change). Lesson drills read `a.sail.stats`, `a.ship.sail.stats`, `a.ship.rig.stats` or `a.rig.stats`, whichever exists. |
| S1+ | SAILING | Polar target speed at 12 kn TWS per class, for the regatta time-correction factor (replaces `maxKn / 8` in `server/jobsx.js tcfOf`). |
| R4 | POLITICS | Set `ctx.jonesActive` (or pass `politics: { ds, ctx }` from `jobsCtx`). Dredge jobs at US ports already carry `needs.jones`. |
| A | Lane A | Mark yachts certified for more than 12 guests with `eq: 'pyc'`. Until then, Lane D treats a yacht with `units.pax > 12` as a passenger yacht (Game rule). |
