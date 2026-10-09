# Dock anywhere — phase 2: wiring (exact edits, ready to paste)

Contract: `docs/DOCK-ANYWHERE-CONTRACT.md`. Phase 1 (built, tested) added only new files:
`shared/quayrules.js`, `server/quays.js`, `server/quaygame.js`, `public/js/quayfmt.js`, `public/js/quayui.js`,
`public/css/quay.css`, `test/quays.test.mjs`, `test/quaygame.test.mjs`, `test/quayui.test.mjs`.

Phase 2 touches `server.js`, `server/game.js`, `public/js/main.js`, `public/js/hud.js`, `public/index.html`. Every edit
below is anchored on a line of text (line numbers move — other lanes edit these files), is small, and calls into the
phase-1 modules. `berthguide.js` / `tugassist.js` / `tugs.js` need **no** change: quay tug assists use the legacy
straight walk in `game.stepAssist` (no `opId`), the HUD's assist line already shows `assist.berthName`, and the berth
guidance only ever targets harbour-patch berths (quays near them are cut, contract §2).

Order: 1 → 2 → 3 (server, tests green) → 4 → 5 → 6 (client) → 7 (tests) → run `node --test test/quay*.test.mjs
test/game.test.mjs` → push.

---

## 1. `server.js` — the finder on the live tiles

**1a. Imports.** After the line `import { createMemGuard, LEVEL } from './server/memguard.js';` add:

```js
import { createQuayFinder } from './server/quays.js';                                   // DOCK ANYWHERE (docs/DOCK-ANYWHERE-CONTRACT.md)
import { attachFinder } from './server/quaygame.js';
```

**1b. Attach.** After the line `game.liveAis = liveAis;                     // V7 step 0: …` add:

```js
// DOCK ANYWHERE: berths on every real quay, read from the D14 tiles already in memory near ships (never fetches by
// itself; a query with missing tiles asks for them at P1 and re-answers). Tiny caches, dropped on memguard shed.
if (WT_ON) {
  const wtGet = (z, x, y) => wt.get(z, x, y);
  attachFinder(game, createQuayFinder({ getTile: wtGet, harbors: HARBORS, guard: memGuard }), wtGet);
  game.quayEnsure = (lat, lon) => wt.ensureAround(lat, lon, 1700, worldtiles.PRIO.P1, { timeoutMs: 2500 });
}
```

**1c. Health (optional).** In the `/api/health` JSON, next to `route: routePlanner.stats(),` add
`quays: game.quayFinder ? game.quayFinder.stats() : null,`.

Without world tiles (`SALTLINE_WT=0`) `game.quayFinder` stays null: `quay_query` answers "Quays are not charted on this
server yet." and nothing else changes.

## 2. `server/game.js` — seven small edits

**2a. Import.** After the line `import { Fleet } from './fleet.js';` add:

```js
import { quayQuery, quayDock, quayDockNearest, quayTugs, quayAssistDone, quayUndock, quayGate, quayMigrate, quayPublic, quayHarbourInfo } from './quaygame.js'; // DOCK ANYWHERE
import { ACTION_SERVICE } from '../shared/quayrules.js';
```

**2b. Actions + service gate.** Replace

```js
  onAction(p, m) {
    const a = m.action;
    try {
      switch (a) {
        case 'dock': return this.dock(p);
```

with

```js
  onAction(p, m) {
    const a = m.action;
    // DOCK ANYWHERE: moored at a quay, harbour services are refused or trucked by tier (shared/quayrules.js)
    if (p.berth?.quay && !m.quayGated && ACTION_SERVICE[a]) {
      try { return quayGate(this, p, a, m, () => this.onAction(p, { ...m, quayGated: true })); } catch (e) { this.log(`[game] quay gate ${a} failed: ${e.stack || e}`); return; }
    }
    try {
      switch (a) {
        case 'quay_query': return quayQuery(this, p);
        case 'quay_dock': return quayDock(this, p, m);
        case 'quay_tugs': return quayTugs(this, p, m);
        case 'dock': return this.dock(p);
```

**2c. `dock()` — T next to a quay.** In `dock(p)`, three refusals first try the nearest fitting quay. Replace

```js
    if (!harbor || units > DOCK_SEARCH_RANGE_U) return this.event(p, 'warn', 'No harbour within docking range.');
```

with

```js
    if (!harbor || units > DOCK_SEARCH_RANGE_U) { if (quayDockNearest(this, p)) return; return this.event(p, 'warn', 'No harbour within docking range. Quays near you: Q.'); }
```

replace

```js
      if (!nb || !nb.berth || nb.distM > INTERACT.BERTH_RANGE_U || Math.abs(p.ship.spd) > 2) return this.event(p, 'warn', `Come alongside a berth (within ${INTERACT.BERTH_RANGE_U} m, under 2 kn) or request tugs.`);
```

with

```js
      if (!nb || !nb.berth || nb.distM > INTERACT.BERTH_RANGE_U || Math.abs(p.ship.spd) > 2) { if (quayDockNearest(this, p)) return; return this.event(p, 'warn', `Come alongside a berth (within ${INTERACT.BERTH_RANGE_U} m, under 2 kn) or request tugs — or moor at any quay that fits (Q).`); }
```

and replace

```js
      if (units > INTERACT.DOCK_RADIUS_U) return this.event(p, 'warn', 'No harbour within docking range.');
```

with

```js
      if (units > INTERACT.DOCK_RADIUS_U) { if (quayDockNearest(this, p)) return; return this.event(p, 'warn', 'No harbour within docking range. Quays near you: Q.'); }
```

**2d. `undock()`.** Replace

```js
  undock(p) {
    if (!p.docked) return;
```

with

```js
  undock(p) {
    if (!p.docked) return;
    if (quayUndock(this, p)) return;                    // DOCK ANYWHERE: the stay's balance, 20 m out on the water side
```

**2e. `stepAssist()` — quay tugs end.** Replace (the end of the walk)

```js
    if (f < 1) return;
    const harbor = harborById(a.harbor);
```

with

```js
    if (f < 1) return;
    if (a.quay) { quayAssistDone(this, p, a); return; }   // DOCK ANYWHERE: re-fit the quay, moor, day 1 + dues
    const harbor = harborById(a.harbor);
```

**2f. Restart during a quay tug assist.** In `migratePlayer(p)`, replace

```js
    // A tug assist interrupted by a restart completes now: the berth is the only position guaranteed to be water.
    if (p.assist) {
```

with

```js
    // A tug assist interrupted by a restart completes now: the berth is the only position guaranteed to be water.
    if (p.assist?.quay) quayMigrate(this, p);            // DOCK ANYWHERE: tiles are not loaded yet → the berth saved at tug start
    if (p.assist) {
```

**2g. What others see + the harbour sheet's quay field.** In `publicState(p)`, replace

```js
      vid: p.vessel?.id ?? null, vname: p.vessel?.name ?? null,   // v6: which of her ships the skipper sails
```

with

```js
      vid: p.vessel?.id ?? null, vname: p.vessel?.name ?? null,   // v6: which of her ships the skipper sails
      quay: quayPublic(p),                                         // DOCK ANYWHERE: { name, cls } while moored at a quay
```

and in `sendHarbor(p)` replace

```js
        ...this.fleet.harborFields(p, h) },          // v6: office, fleetHere, fleetFull, fleetN
```

with

```js
        quay: quayHarbourInfo(p),                    // DOCK ANYWHERE: { name, tier, hdKm, perDay, since, paid } at a quay, else null
        ...this.fleet.harborFields(p, h) },          // v6: office, fleetHere, fleetFull, fleetN
```

Nothing else in game.js changes: a quay mooring is `p.docked = <linked harbour>` with `p.berth.quay`, so warp limits,
the ship clock, saving, fleet berth counts (`berthsTaken` uses `berth.id`), the express passage and tows behave as at a
harbour berth. `setDocked` from tows / impounds / rescues clears `p.berth` as before.

## 3. Server tests (add `test/quaywire.test.mjs`)

```js
// DOCK ANYWHERE phase 2: the real Game routes the quay actions and gates services (docs/DOCK-ANYWHERE-PHASE2.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { carvingsForWorld, HARBORS } from '../server/harbors.js';
import { Game } from '../server/game.js';
import { createQuayFinder, fitRun, runFrame } from '../server/quays.js';
import { attachFinder } from '../server/quaygame.js';
import { loadPoints, loadPortFixture, FIXTURE_DIR } from './fixtures/wt/lib.mjs';

process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
const world = new World().load(carvingsForWorld(), () => {});
const fx = loadPortFixture(FIXTURE_DIR, loadPoints().ports.find((p) => p.id === 'rotterdam'));
const getTile = (z, x, y) => (z === 14 ? fx.tiles.get(`${x}/${y}`) || null : null);
const P_TERMINAL = { lat: 51.948952, lon: 4.062297 };
function mkGame() { const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-test-state.json' }); g.saveState = () => {}; attachFinder(g, createQuayFinder({ getTile, harbors: HARBORS }), getTile); return g; }
function fakeSocket() { return { readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); }, close() {} }; }

test('quay_query / quay_dock / services / undock through Game.onAction', () => {
  const g = mkGame(), ws = fakeSocket(), p = g.connect(ws, null, 'Quay Tester');
  if (p.docked) g.onAction(p, { action: 'undock' });
  const { runs } = g.quayFinder.runsNear(P_TERMINAL.lat, P_TERMINAL.lon, 300, 99);
  const t = runs.map((r) => ({ r, f: runFrame(r, P_TERMINAL.lat, P_TERMINAL.lon) })).filter(({ r, f }) => f.off > 0 && f.off < 120 && f.along > 0 && f.along < r.len).sort((a, b) => a.f.off - b.f.off)[0].r;
  p.ship.cls = 'boxship'; p.money = 1e6;
  const fit = fitRun(t, { ...P_TERMINAL, hdg: t.hdg, cls: 'boxship' });
  Object.assign(p.ship, { lat: fit.slot.lat, lon: fit.slot.lon, hdg: t.hdg, spd: 0.5 });
  g.onAction(p, { action: 'quay_query' });
  assert.ok([...ws.sent].reverse().find((m) => m.t === 'quays').list.some((c) => c.fits));
  g.onAction(p, { action: 'quay_dock', id: t.id });
  assert.equal(p.docked, 'rotterdam'); assert.equal(p.berth.quay, true);
  assert.deepEqual(g.publicState(p).quay, { name: p.berth.name, cls: 'terminal' });
  assert.equal([...ws.sent].reverse().find((m) => m.t === 'harbor').harbor.quay.tier, 'port');
  const m0 = p.money; g.simTime += 86400 * 1.5; g.onAction(p, { action: 'undock' });
  assert.equal(p.docked, null); assert.equal(m0 - p.money, 4125);
});

test('a quay outside the port: no shipyard, the market trucked', () => {
  const g = mkGame(), ws = fakeSocket(), p = g.connect(ws, null, 'Far Quay');
  p.docked = 'rotterdam'; p.berth = { quay: true, tier: 'near', harbor: 'rotterdam', hdKm: 13, name: 'Industrial AO · Rotterdam', perDay: 51, paid: 51, since: g.simTime };
  g.onAction(p, { action: 'buy_ship', cls: 'feeder' });
  assert.match([...ws.sent].reverse().find((m) => m.t === 'event').text, /shipyard is not available/i);
});
```

## 4. `public/js/main.js` — five small edits

**4a. Create the UI.** After the line
`import('./berthguide.js').then((m) => { this.berthGuide = new m.BerthGuide(this); }).catch((e) => console.warn('[berthguide] unavailable', e));`
add

```js
    // Dock anywhere (quayui.js): the quays near the ship, the "Moor here" card, the slot outline, the moored-at-a-quay panel
    this.quayUi = null;
    import('./quayui.js').then((m) => { this.quayUi = new m.QuayUI(this); }).catch((e) => console.warn('[quayui] unavailable', e));
```

**4b. Messages.** In `onMessage(m)`, after `case 'harbor': this.hud.showHarbor(m.harbor); break;` add

```js
      case 'quays': this.quayUi?.onQuays(m); break;                       // DOCK ANYWHERE
```

**4c. Per frame.** In `loop()`, after the line
`try { this.berthGuide?.update(dt, now); } catch (e) { … }` add

```js
    try { this.quayUi?.update(dt, now); } catch (e) { if (!this.quayUiWarned) { this.quayUiWarned = true; console.warn('[quayui] update failed', e); } }
```

**4d. Key Q.** In the keydown handler, after `if (k === 'n') return this.requestTugs();` add

```js
      if (k === 'q') return this.quayUi?.toggle();                        // DOCK ANYWHERE: quays near the ship
```

**4e. No harbour walk from a quay.** In `toggleAshore()`, after
`if (!you?.docked) { this.hud.event({ kind: 'warn', text: 'Moor at a berth first, then go ashore.' }); return false; }` add

```js
    if (you.berth?.quay) { this.hud.event({ kind: 'warn', text: 'There is no harbour walk from this quay. Its services: Q.' }); return false; } // DOCK ANYWHERE
```

(Optional, 4f) In `onYou`, after `if (prev && prev.docked && !you.docked) { this.hud.hideHarbor(); }` add
`this.quayUi?.render?.(true);` so the moored panel appears / goes the same frame.

## 5. `public/js/hud.js` — the harbour sheet at a quay

**5a. Import.** Next to the other `/shared/…` imports add

```js
import { TIER_TABS, SERVICE_TIERS, quayDenies } from '/shared/quayrules.js'; // DOCK ANYWHERE
```

**5b. Tabs and subtitle.** In `renderHarborTabs()`, replace

```js
    setText($('hSub'), `${h.country} · ${h.size} port${berth ? ` · ${berth.name || berth.id}` : ''} · ${C.name}`);
```

with

```js
    setText($('hSub'), h.quay
      ? `Moored at ${h.quay.name} · ${h.quay.hdKm} km from ${h.name} · ${SERVICE_TIERS[h.quay.tier]?.label || ''} · ${C.name}`
      : `${h.country} · ${h.size} port${berth ? ` · ${berth.name || berth.id}` : ''} · ${C.name}`);
    // DOCK ANYWHERE: a quay reaches only some of the harbour's services (shared/quayrules.js TIER_TABS)
    const qTabs = h.quay ? TIER_TABS[h.quay.tier] || ['overview'] : null;
    document.querySelectorAll('#harborNav button[data-tab]').forEach((b) => b.classList.toggle('hidden', !!qTabs && !qTabs.includes(b.dataset.tab)));
    if (qTabs && !qTabs.includes(this.harborTab)) this.harborTab = 'overview';
    $('btnAshoreH')?.classList.toggle('hidden', !!h.quay);
```

(the existing `$('btnAshoreH')?.classList.toggle('hidden', !you.docked);` line below it stays; move the new line after it
so the quay rule wins.)

**5c. A tab the quay does not reach.** In `openHarborTab(tab)`, after `const t = this.normTab(tab), a = this.app, you = a.you;` add

```js
    if (you?.berth?.quay && !(TIER_TABS[you.berth.tier] || []).includes(t)) { this.event({ kind: 'warn', text: quayDenies(you.berth, t === 'services' ? 'repair' : t === 'boards' ? 'jobs' : t, this.harborData?.name) || 'Not from this quay.' }); return false; }
```

**5d. Surcharges in the services tab (optional).** At the top of `tabServices(h, you, C)`'s returned HTML, prepend
`${h.quay && h.quay.tier !== 'port' ? `<div class="empty">${esc(SERVICE_TIERS[h.quay.tier].note)}</div>` : ''}` so the
skipper sees "fuel by truck +12 %" before buying (the server charges it as a separate line).

**5e. Help.** In the help text (`#helpWrap` in index.html), add `<li><b>Q</b> quays near you — moor at any real quay that
fits (pay per day)</li>` next to T / N.

## 6. `public/index.html` — a button (optional, touch)

After `<button id="btnDock" class="dockBtn" …>…</button>` add

```html
    <button id="btnQuays" class="dockBtn" title="Quays near you (Q)"><span class="si" data-icon="pier"></span><span class="lbl">Quays</span></button>
```

and in `hud.bind()` after `on('btnDock', () => a.toggleDock());` add `on('btnQuays', () => a.quayUi?.toggle());`.
(`quay.css` is loaded by `quayui.js` itself; no `<link>` edit needed.)

## 7. Checks before pushing

* `node --test test/quays.test.mjs test/quaygame.test.mjs test/quayui.test.mjs test/quaywire.test.mjs test/game.test.mjs`
* Browser, Rotterdam (start harbour): sail the coaster 1 km east along the Maasvlakte container terminal, press Q: green
  outline on the wall, card "Terminal … · Rotterdam", ≈ 120 cr/day; come alongside under 2 kn → Moor here → moored,
  harbour sheet opens with all tabs. Cast off after a day: "Quay fee … paid".
* Container ship near Rozenburg (outside the 12 km port limits): Q lists industrial quays "Too narrow … 49 m" / "Too
  shallow"; a feeder or coaster fits; moored there the sheet has no Shipyard tab, Market buys show "Trucking … cr".
* Two skippers: the second one's card for the same stretch says "Occupied: <name> lies here" or offers the free part.
* Memory: `/api/health` → `quays.featTiles ≤ 48`, `runTiles ≤ 64`; under `mem.level = shed` both drop to 0.
