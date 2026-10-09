# World politics — phase 2 server hooks (game.js, fleet.js, captain.js, server.js)

Status: **ready to paste** (2026-10-09). Phase 1 (lane A) shipped new files only:
`shared/politics.js`, `shared/politics/*.json` (+ `pending.json`, not loaded), `server/politics.js`,
`server/politicsjobs.js`, `scripts/politics/{validate,refresh,build-trade,build-discs}.mjs`,
`test/politics-*.test.mjs`, `test/fixtures/politics/`. Contract: `docs/WORLD-POLITICS-CONTRACT.md` (§6.2 hook table).

Each hook below gives the **file**, a **search anchor** (an existing line, copied verbatim on 2026-10-09; the
other agents may have moved it, so search, do not use line numbers) and the **code to paste**. Order of work
(contract §8.2): H16 → H1, H13, H14, H24 → H6–H12 → H2–H5 → H18–H22. Every hook is guarded with `this.politics?.`
so a game built without it (old tests) behaves as before.

Run after each group: `node --test test/politics-*.test.mjs` plus the existing suites the hook touches
(`game.test.mjs`, `jobs.test.mjs`, `market.test.mjs`, `fleet-*.test.mjs`, `quaygame.test.mjs`).

---

## 0. Engine facts the hooks rely on

* `new Politics(game, { dir?, dataset?, harbors?, vesselOf?, log? })`. Default `dir` is `shared/politics/`. Tests
  pass `{ dataset: loadDataset({...fixtureParts}), harbors }` (see `test/politics-helpers.mjs`).
* It reads `game.simTime`, `game.rnd()`, `game.event(p, kind, text)`, `game.send(p, msg)`, `game.sink(p, reason, text)`,
  `game.impound(p, by, fine)`, `game.harbors[hid].market[good]`, and books money through
  `game.fleet.book(p, vid, cat, amt)` (falls back to `p.money`).
* **Vessel fields** it owns (created by `healVesselPol`): `v.flag {cc, registry, since}`, `v.flagWas[]`, `v.built`,
  `v.builtIn`, `v.psc {last, detentions}`, `v.held`, `v.scrubber`, `v.reflag`. **Office field**: `office.pol`.
  **Cargo field**: `origin` (null = unknown origin). **Job field**: `job.pol`.
* `vesselOf(p)`: the person's aboard vessel `p.fleet.find(v => v.id === p.aboard)`, an actor's `p.vessel`, else `p`.
  If the v6 actor object names its vessel differently, pass `vesselOf` in the constructor options.
* New event kind **`risk`** (amber). `law` is reused for blocks, refusals, seizures and PSC.

---

## H1 — construct (game.js constructor)

Anchor: `    this.fleet = new Fleet(this);                   // v6 fleet: vessels, office, captains (before loadState)`

```js
import { Politics } from './politics.js';                     // top of file, next to `import { Fleet } from './fleet.js';`
import { diplomaticJobs } from './politicsjobs.js';
```
```js
    // World politics (docs/WORLD-POLITICS-CONTRACT.md): rules per harbour, sanctions, war risk, flags. Tests pass a fixture.
    this.politics = opts.politics === false ? null : new Politics(this, { dir: opts.politicsDir, dataset: opts.politicsDataset, harbors: opts.politicsHarbors, log: this.log });
```
(paste directly **after** the anchor line, before `loadState` runs, so H16 can migrate.)

## H16 — migration and save (game.js `migratePlayer`, `saveState`)

Anchor (end of `migratePlayer`): `      if (h) { if (b) this.moorAt(p, h, b); else this.setDocked(p, h.id, null); }` then `    }` then `  }`.
Paste as the last statement of `migratePlayer(p)`:
```js
    this.politics?.migrate(p);                         // office.pol, vessel flag/built/psc/held, cargo origin (never throws)
    this.politics?.reconcile(p);                       // §4.17 wind-down / frustration when the dataset changed
```
Anchor in `saveState`: `savedAt: new Date().toISOString(), fleetSchema: 1,` → add `polSchema: 1, polVersion: this.politics?.version ?? null,` right after `fleetSchema: 1,`.

Fleet records (server/fleet.js `healVessel(v, office)`), anchor: `    if (v.status === 'laidup') { v.orders = null; v.cap = null; }` — paste **before** it:
```js
    this.game.politics?.healVesselPol(v, harborById(office?.home)?.country);
```
`healOffice(o, rec)`, anchor: `    out.homeSetAt = Number.isFinite(out.homeSetAt) ? out.homeSetAt : 0;` — paste after it:
```js
    out.pol = this.game.politics ? this.game.politics.healOfficePol(out.pol) : out.pol;
```
New ships (`fleet.js makeVessel` callers `createFirstVessel` and `buyShip`): after the vessel object is built and
before `this.index(v)`, add
```js
    this.game.politics?.newVesselFlag(p, v, { builtIn: harborById(v.docked)?.country || null });   // shipyard country = builtIn (§4.10)
```
(For `createFirstVessel` the yard is the start harbour; a used listing uses the listing harbour, contract §4.10.)

## H13 / H14 — views (game.js `sendHarbor`, `privateState`)

`sendHarbor` anchor: `      t: 'harbor', harbor: { id: h.id, name: h.name, country: h.country, size: h.size, lat: h.lat, lon: h.lon, fuelPrice: this.fuelPrice(h), repairCost: this.repairCost(p),`
— add a field inside the `harbor: { … }` object (e.g. right after `repairCost: this.repairCost(p),`):
```js
        rules: this.politics ? this.politics.harbourPayload(p, h) : null,
```
`privateState` anchor: `      ...this.fleet.youFields(p),                     // v6: aboard, vesselName, home, homeName, fleet {n, atSea, laidUp, owed, unread}`
— add the line after it:
```js
      pol: this.politics ? this.politics.youView(p) : null,
```
Fleet view (`fleet.js fleetView(p)`): add `compliance: this.game.politics?.officeView(p) ?? null,` to the returned object.

## H15 — actions (game.js `onAction`)

Anchor: `    try {` followed by `      switch (a) {` in `onAction(p, m)`. Paste **before** `switch (a) {` (inside the `try`):
```js
      if (typeof a === 'string' && a.startsWith('pol_') && this.politics) {
        if (a === 'pol_home_plan' || a === 'pol_home_start') {   // the existing office rules (cost, cooldown, laid-up ships) come first
          const hm = this.fleet.homeMove(p, harborById(m.harbor));
          if (a === 'pol_home_start' && hm.allowed !== true) return this.event(p, 'warn', hm.allowed);
          m = { ...m, baseCost: hm.cost };
        }
        const r = this.politics.onAction(p, m);
        if (r !== null) { this.sendYou(p); if (p.docked) this.sendHarbor(p); this.fleet.dirty?.(p); return; }
      }
```
Rate limit: the actions go through the same path as fleet actions; if the fleet's bucket is only applied inside
`fleet.onAction`, wrap the call with `if (!this.fleet.take?.(p)) return;` (whatever the bucket method is named).

## H8 — refuse entry before mooring (game.js `dock`, server/quaygame.js)

game.js anchor: `    if (p.hail) return this.event(p, 'law', 'The harbour master refuses: the coast guard has ordered you to heave to first.');`
— paste after it (before `if (berth) this.moorAt(…)`):
```js
    if (this.politics) { const e = this.politics.entryCheck(p, harbor); if (e.refuse) return this.event(p, 'law', e.text); }
```
quaygame.js `quayMoor` and `quayMoorSaved` — anchor: `  game.setDocked(p, h ? h.id : null, berth);` (twice). In `quayMoor` only (a restart
re-mooring must never refuse), paste before it:
```js
  if (h && game.politics) { const e = game.politics.entryCheck(p, h); if (e.refuse) return game.event(p, 'law', e.text); }
```
Tug assists end in `finishDock`; request tugs only after the same check (in `tugAssist`, before `planTugAssist`).

## H9 — docked (game.js `finishDock`)

Anchor: `    const seized = this.rnd() < chance ? this.inspect(p, \`${harbor.name} port authority\`) : false;`
— paste after it:
```js
    const pol = this.politics ? this.politics.onDock(p, harbor) : null;   // call record, seizure, designation, PSC, port incident
    if (pol?.incident?.outcome === 'loss') return;                        // the ship was abandoned (sink already ran)
```
Premium refunds happen in H12 (payJob), so `deliverJobs` stays unchanged.

## H10 — detention / hold (game.js `undock`)

Anchor: `    if (!p.docked) return;` (first line of `undock`). Paste after it:
```js
    const held = this.politics?.canUndock(p); if (held) return this.event(p, 'law', held);
```
At sea a hold stops the engine: in `stepAtSea`, after `const hrs = simHours * this.warpOf(p);` add
```js
    const hold = this.politics?.vesselOf(p)?.held;
    if (hold && hold.until > this.simTime) { s.throttle = 0; s.spd = 0; this.dropWarp?.(p, 'Held.', false); }
```

## H11 — at sea (game.js `stepAtSea`)

Anchor: `      const burn = fuelBurnPerSimHour(s.cls, s.throttle, load, headwindFactor(s.hdg, wx.wind), p.cond) * hrs * (p.towing ? 1.3 : 1);`
Change `const burn` scope: declare `let burnT = 0;` before the surrounding `if (p.fuel > 0 && …) {` and add after the
`const burn = …` line `burnT = burn;`. Then, after the fuel block's closing `}`, paste:
```js
    if (this.politics && !p.isActor) this.politics.stepSea(p, hrs, burnT, { underway });   // cover, IBF wages, incidents, ECA, piracy
```
Captained ships: in `server/captain.js stepVessel`, anchor
`    const cr = accrueWage(v.pay, wageRateMcrH(v.ship.cls, dutyOf(v), !!v.towing), dt * 1000);` — replace the
`wageRateMcrH(…)` argument with
```js
wageRateMcrH(v.ship.cls, dutyOf(v), !!v.towing) * (g.politics ? crewShare(v) * (g.politics.crewPayMulAt(v.ship.lat, v.ship.lon) - 1) + 1 : 1)
```
where `crewShare(v)` is the crew part of the wage (`C.crewCost / (wageRateMcrH(...) / 1000)` — add a 2-line helper in
captain.js; the captain's own rate is unchanged, contract §4.5). Captains' sea steps also call
`g.politics?.stepSea(fleet.actorOf(v), dtH, burnT)` where the captain code burns fuel (search `fuelBurnPerSimHour` in
captain.js); `stepSea` buys cover automatically for actors.

`sink(p)` gains a reason (anchor: `  sink(p) {`): change the signature to `sink(p, reason = null, text = null) {` and replace
the life-raft line `this.event(p, 'warn', \`Your ship sank…\`)` with `this.event(p, 'warn', text || \`Your ship sank…\`)`
when `reason === 'war_loss'` (the text already says "All crew evacuated safely").

## H6 — accept (game.js `acceptJob`)

Anchor: `    if (!job) return this.event(p, 'warn', 'That contract is gone.');` — paste after it:
```js
    if (this.politics) { const c = this.politics.onAccept(p, job); if (c.block) return this.event(p, 'law', c.text); }
```
Diplomatic types reuse delivery: `aid`, `corridor`, `state`, `avoid` carry `good`/`qty` (they take the
`else if (job.type !== 'fishing')` cargo branch unchanged); `evac` carries `pax` — extend the pax branch condition
`if (job.type === 'passengers' || job.type === 'charter')` to `|| job.type === 'evac'`.

## H7 — trade (game.js `tradeGoods`)

Buy — anchor: `      const q = tradeQuote(h, st, good, qty, 'buy');` — paste **before** it:
```js
      const pc = this.politics?.onTrade(p, h, good, 'buy');
      if (pc?.block) return;                                  // the engine already sent the `law` event
```
and replace the merge line `      const stack = p.cargo.find((c) => c.good === good && !c.jobId);` +
`      if (stack) stack.qty += qty; else p.cargo.push({ good, qty, contraband: false, jobId: null });` with
```js
      const origin = this.politics ? this.politics.stackOrigin(p, h) : null;
      const stack = p.cargo.find((c) => c.good === good && !c.jobId && (c.origin ?? null) === origin);
      if (stack) stack.qty += qty; else p.cargo.push({ good, qty, contraband: false, jobId: null, origin });
```
Sell — anchor: `      const q = tradeQuote(h, st, good, qty, 'sell');` — replace from that line through `p.money += q.total; p.stats.earned += q.total;` with:
```js
      const q = tradeQuote(h, st, good, qty, 'sell');
      let left = qty, duty = 0, fees = 0, lines = [];
      for (const c of stacks) {                                 // FIFO, duty per stack (contract §4.9)
        const k = Math.min(c.qty, left); if (k <= 0) break;
        const value = Math.round(q.total * k / qty);
        if (this.politics) {
          const r = this.politics.onTrade(p, h, good, 'sell', { origin: c.origin ?? null, value });
          if (r.block) return;                                  // nothing sold
          if (r.duty) { duty += r.duty.duty; fees += r.duty.fee; if (r.duty.duty || r.duty.fee) lines.push(`${c.origin || 'origin unknown'} ${(r.duty.rate * 100).toFixed(1)} % ${r.duty.via === 'mfn' ? 'WTO MFN' : r.duty.via}`); }
        }
        c.qty -= k; left -= k;
      }
      p.cargo = p.cargo.filter((c) => c.qty > 0);
      const net = q.total - duty - fees;
      p.money += net; p.stats.earned += net;
```
and append `${duty + fees ? \` — duty ${fmt(duty)} cr, fee ${fmt(fees)} cr (${lines.join('; ')})\` : ''}` to the "Sold …" event.
(The existing loop `for (const c of stacks) { const k = …; c.qty -= k; left -= k; }` is replaced, not duplicated.)
Caught fish takes the flag's origin — anchor:
`          if (stack) stack.qty += add; else p.cargo.push({ good: 'fish', qty: add, contraband: false, jobId: null, caught: true });`
→ add `, origin: this.politics ? this.politics.stackOrigin(p, null, { caught: true }) : null` inside the pushed object.
Fleet transfers (`fleet.js`, anchor `if (dst) dst.qty += k; else b.cargo.push({ good, qty: k, contraband: !!c.contraband, jobId: null, ...(c.caught ? { caught: true } : {}) });`):
match `dst` by `(x.origin ?? null) === (c.origin ?? null)` too and copy `origin: c.origin ?? null`.

## H12 — paid (game.js `payJob`)

Anchor: `    if (late) pay = Math.round(pay * 0.5);` — paste after it:
```js
    const pp = this.politics ? this.politics.onPaid(p, j, late, harbor) : null;   // standing, premium refund
    if (pp && pp.payMul !== 1) { pay = Math.round(pay * pp.payMul); this.event(p, 'warn', 'Entered an area the contract said to avoid: pay halved.'); }
```

## H17 — express passage (game.js `expressPassage`)

Anchor: `    if (distM < 2000) return this.event(p, 'warn', 'Too close to bother.');` — paste after it:
```js
    if (this.politics) { const x = this.politics.expressCheck(p, { points: [[lat, lon]] }); if (x.refuse) return this.event(p, 'warn', x.text); }
```
(When the express route comes from the planner (`opts.built`), pass its `points` instead of the single end point.)

## H2–H5 — economy (game.js `regenHarbor`/`jobEnv`, server/economy.js)

game.js `jobEnv()` — anchor: `      seaKm: (a, b) => { try { const km = this.routeTable?.seaKm?.(a, b); return Number.isFinite(km) && km > 0 ? km : null; } catch { return null; } },`
— add after it:
```js
      ...(this.politics ? this.politics.jobEnvHooks() : {}),   // destWeight, riskOf, contrabandOk, tradeProfile, payMul
```
`regenHarbor` — anchor: `      while (st.jobs.length < n && guard++ < 40) { const j = generateJob(h, this.simTime, this.rnd, undefined, this.jobEnv()); if (j) st.jobs.push(j); }`
— paste after it:
```js
      if (this.politics) {
        for (const j of diplomaticJobs(this.politics.ds, h, this.simTime, this.rnd, { harbors: HARBORS, nextJobId, rateJob, seaKm: this.jobEnv().seaKm, riskOf: (a, b) => this.politics.riskOf(a, b) })) if (st.jobs.length < n + 2) st.jobs.push(j);
        for (const j of st.jobs) if (!j.pol || j.pol.ver !== this.politics.version) { const keep = j.pol?.mustAvoid; this.politics.tagJob(j); if (keep) j.pol.mustAvoid = keep; }
      }
```
(`nextJobId` is already exported by economy.js; **export `rateJob`** there: change `function rateJob(job, simTime, rnd) {` to `export function rateJob(job, simTime, rnd) {` and add it to game.js's economy import.)

economy.js (pure, injected hooks — no politics import):
* **H3** `generateSmugglingJob`, anchor `  const good = CONTRABAND[Math.floor(rnd() * CONTRABAND.length)];` → paste after it:
  `  if (env.contrabandOk && !env.contrabandOk(from, dest.h, good)) return null;`
* **H4** `generateJob` freight branch, anchor `  const good = LEGAL_GOODS[Math.floor(rnd() * LEGAL_GOODS.length)];` (currently after
  `const dest = pickDestination(from, rnd);`). For `type === 'freight'` pick the good first and pass weights:
  `pickDestination(from, rnd, 1e9, env.destWeight ? (h) => env.destWeight(from.id, h.id, good) : null)`; in
  `pickDestination` multiply each candidate's `w` by `weightFn ? weightFn(h) : 1` and skip `w === 0`. The pay line
  multiplies by `(env.payMul ? env.payMul(from.id, dest.h.id) : 1)` (contract §4.11 risk premium). `jobs.test.mjs`
  seeded expectations change in the same commit (contract §7).
* **H5** `localProfile`, anchor `    let m = country[g] ?? 1;` → `    let m = tradeProfileFn?.(harbor.country, g) ?? country[g] ?? 1;`
  with `let tradeProfileFn = null; export function setTradeProfile(fn) { tradeProfileFn = fn; profileCache.clear(); }`
  at module level; game.js constructor calls `setTradeProfile((cc, g) => this.politics.tradeProfile(cc, g))` after H1
  (only once `shared/politics/trade.json` exists — today it does not, see `pending.json`).

## H18 — moving home (server/fleet.js)

`homeMove(p, h)` keeps its checks; the plan is fetched separately. Anchor in `homeAction`:
`    if (hm.cost > 0) this.book(p, '_', 'fees', -hm.cost);` — replace that line and the following three
(`const o = p.office;` / `o.home = h.id; …` / `this.tell(…)`) with:
```js
    if (this.game.politics) {
      const r = this.game.politics.homeStart(p, h, { baseCost: hm.cost });   // books move + formation + re-flags, starts the wait
      if (!r.ok) return this.warn(p, r.text);
      return this.refresh(p);
    }
    if (hm.cost > 0) this.book(p, '_', 'fees', -hm.cost);
    const o = p.office;
    o.home = h.id; o.homeSetAt = this.game.simTime; o.homeMoves++;
    this.tell(p, 'info', `Your office is now at ${short(h.name)}${hm.cost ? ` (${fmt(hm.cost)} cr)` : ''}. No berth fees here for your ships.`);
```
In the two views that return `homeMove: { allowed: hm.allowed, cost: hm.cost }` add
`plan: this.game.politics ? this.game.politics.homeMovePlan(p, h, { baseCost: hm.cost }) : null` (only when `h` is the
harbour the person is moored in — the plan is computed on demand, not every tick). `fleet-office.test.mjs` expects the
new `plan` field (contract §7).

## H19 — captains' policy (server/fleet.js `captainRefusal` callers)

Keep `export function captainRefusal(job)` as is (one-argument calls keep working) and add after it:
```js
export function captainRefusalFor(game, owner, v, job) {
  return captainRefusal(job) || (game.politics ? game.politics.captainCheck(owner, job, owner.office?.pol?.riskPolicy || 'avoid', v) : null);
}
```
Replace the three call sites (anchors: `if (p.aboard !== b.id) { const r = captainRefusal(job); if (r) return this.warn(p, r); }`,
`why: hardReason(j, ship) || captainRefusal(j) || null`, `const r = captainRefusal(job); if (r) return this.warn(p, r);`)
with `captainRefusalFor(this.game, p, v, job)` (`b` / the vessel in scope at each site).

## H20 / H21 — captains' routing and departure (server/captain.js)

`requestPlan` anchor:
`  const opts = { toHarbor: tgt.kind === 'harbor' ? tgt.harbor : undefined, draft: C.draft, beam: C.beam, length: C.length, avoid: tgt.avoid || stormsNear(g, from, to), simTime: now };`
— replace with:
```js
  const owner = fleet.ownerOf(v), policy = owner?.office?.pol?.riskPolicy || 'avoid';
  const storms = tgt.avoid || stormsNear(g, from, to);
  const polDiscs = g.politics ? g.politics.avoidDiscs(policy, from, to, Math.max(0, 8 - storms.length)) : [];   // storms first (§6.4)
  const wp = g.politics && tgt.kind === 'harbor' && policy === 'accept' ? g.politics.corridorWaypoints(tgt.harbor) : null;
  const opts = { toHarbor: tgt.kind === 'harbor' ? tgt.harbor : undefined, draft: C.draft, beam: C.beam, length: C.length, avoid: [...storms, ...polDiscs].slice(0, 8), ...(wp ? { wp: wp.slice(0, 50) } : {}), simTime: now };
```
`departureBlocked` anchor: `  if (v.cargo.some((c) => c.contraband)) { fail(fleet, v, 'No captain will carry that — unload the contraband first'); return true; }`
— paste after it:
```js
  const tgtH = plan?.target?.kind === 'harbor' ? plan.target.harbor : null;
  const dc = tgtH && g.politics ? g.politics.departureCheck(p, v, tgtH) : null;
  if (dc?.wait) { wait(fleet, v, dc.text, Math.max(60, dc.until - g.simTime)); return true; }
  if (dc?.fail) { fail(fleet, v, dc.text); return true; }
  const held = g.politics?.heldText(v); if (held) { wait(fleet, v, held, 600); return true; }
```

## H22 — daily and per-tick housekeeping (server/fleet.js)

Anchor: `    if (g.simTime - this.lastDaily >= 60) { this.lastDaily = g.simTime; this.daily(g.simTime); }` — paste before it:
```js
    if (g.politics) for (const p of g.byId.values()) if (p.office) g.politics.tick(p);   // holds, re-flags, pending home move
```
and in `daily(now)` (anchor `  daily(now) {` / `    void now;`) add at the top:
```js
    if (this.game.politics) for (const p of this.game.byId.values()) if (p.office) this.game.politics.dailyTick(p);   // self-limits to once per real day
```

## H23 — market rows (server/market.js, optional)

`rowsFrom(game, routeTable, A, q, bestOnly)`: when `q.home` and `q.flag` are given, drop rows for which
`tradeCheck(game.politics.ds, makeCtx(game.politics.ds, { home: q.home, flag: q.flag, simTime: game.simTime }), { harbor: A, good: row.good, side: 'buy' }).ok === false`.

## H24 — `/api/politics` (server.js)

Anchor: `app.get('/api/world', (req, res) => res.json({ ...game.worldInfo(), lanes: LANE_NODES, patch: PATCH }));` — paste after it:
```js
app.get('/api/politics', (req, res) => {
  if (!game.politics) return res.status(404).end();
  const c = game.politics.clientPayload();                     // everything except trade.json; ETag = dataset version
  if (req.headers['if-none-match'] === c.etag) return res.status(304).end();
  res.set({ ETag: c.etag, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }).send(c.json);
});
```
Log line at start-up comes from the engine (`[politics] dataset 2026.10.1 …`). `/shared/politics/*.json` is also
reachable through the existing `/shared` static route; the client should use `/api/politics` (ETag).

## War-cover credit at the yard (game.js `repair`)

Anchor: `    const cost = this.repairCost(p);` (in `repair(p)`) — paste after it:
```js
    const credit = this.politics ? this.politics.repairCredit(p) : 0;   // hull points from covered war incidents (30 days)
    const covered = credit > 0 ? Math.min(cost, Math.round(cost * Math.min(1, credit / Math.max(1, 100 - p.cond)))) : 0;
```
and charge `cost - covered` (mention "war cover pays {covered} cr" in the event).

---

## Tests to update in the same commit (contract §7)

* `jobs.test.mjs` — freight good picked before the destination (H4), seeded expectations change.
* `market.test.mjs` — `localProfile` with an injected trade fixture; without `setTradeProfile` it is unchanged.
* `fleet-office.test.mjs` — `homeMove` views gain `plan`; `homeAction` with politics starts a pending move.
* New integration tests (real Game): copy `test/politics-engine.test.mjs` cases onto a `Game` built with
  `{ politicsDataset: loadDataset(fixtureParts()), politicsHarbors: fixtureHarbors }` — the fixture harbour ids are
  not real harbours, so the integration tests should instead build a fixture from real harbour ids (e.g. clone the
  fixture with `ha1 → rotterdam`, `he1 → novorossiysk`) or use the real dataset with structure-only assertions.
