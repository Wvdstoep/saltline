# World politics — phase 2 client hooks (hud.js, chart.js, hq.js, main.js, net.js, index.html)

Status: **ready to paste** (2026-10-09). Phase 1 (lane B, client) shipped new files only:

| File | What |
|---|---|
| `public/js/politics.js` | `PoliticsUi` (`app.politics`): dataset load (`/api/politics` + ETag, fallback `/shared/politics/*.json`), message state (`you.pol`, `harbor.rules`, `fleet.compliance`, `pol_home_plan`), Rules nav/section injection, chart overlay + legend + popovers, risk-check sheet, Compliance panel, move-home and re-flag sheets, `pol_*` actions |
| `public/js/politicsview.js` | DOM-free HTML builders (Rules tab, risk check, Compliance, move home, re-flag, contract cards, badges) + client mirrors (`reflagOptions`, `policyVerdict`, `sellBlocks`, `applicableMeasures`, `portBansFor`) |
| `public/js/politicschart.js` | canvas overlay (`drawAreas`), hit-testing (`areasUnder`), `popoverHTML`, `legendHTML` |
| `public/js/politicsfmt.js` | pure formatters (`fmtPct`, `fmtSrc`, `statusChip`, `tierColour`, `quickTile`, `jobBadges`, `riskRows`, `moveRows`, …) |
| `public/css/politics.css` | styles (style.css tokens; phone rules under 700 px) — loaded by `PoliticsUi` itself (`/css/politics.css`) |
| `test/politicsui-fmt.test.mjs`, `test/politicsui-render.test.mjs` | 21 tests, real dataset + real engine payloads |

Server hooks (H13 `harbor.rules`, H14 `you.pol`, fleet `compliance`, H15 `pol_*` actions, H24 `/api/politics`) are in
`docs/WORLD-POLITICS-PHASE2.md` and must land first or together; without them the client falls back to previews
computed in the browser (Rules tab says "Preview computed in your browser") and the static dataset files.

Every hook is guarded with `this.app.politics?.` / `a.politics?.` so nothing changes when the module failed to load.
Anchors were copied verbatim on 2026-10-09; another agent is editing these files, so **search** for them.

Run after pasting: `node --test test/politicsui-*.test.mjs` plus the suites the files already have (`quayui`,
`fleet-client`, …), then the browser check (contract §8.3). Harness: `pw/politics/` (`node shots.mjs`).

---

## C1 — main.js: construct and load (H28)

Anchor: `    import('./hq.js').then((m) => { this.hq = new m.Hq(this); }).catch((e) => console.warn('[hq] unavailable', e));`
Paste after it:
```js
    this.politics = null;   // world politics (docs/WORLD-POLITICS-CONTRACT.md §5): Rules tab, chart overlays, risk check, Compliance
    import('./politics.js').then((m) => { this.politics = new m.PoliticsUi(this); if (this.net.connected) this.politics.load(); }).catch((e) => console.warn('[politics] unavailable', e));
```

## C2 — main.js: messages

Anchor: `      case 'fleet': this.fleetUi?.onFleet(m.fleet); this.hq?.onFleet(m.fleet); break;` — replace with:
```js
      case 'fleet': this.politics?.onFleet(m.fleet); this.fleetUi?.onFleet(m.fleet); this.hq?.onFleet(m.fleet); break;
      case 'pol_home_plan': this.politics?.onMessage(m); break;
```
Anchor: `      case 'harbor': this.hud.showHarbor(m.harbor); break;` — replace with (politics first, so the sheet renders with the rules):
```js
      case 'harbor': this.politics?.onHarbor(m.harbor); this.hud.showHarbor(m.harbor); break;
```
Anchor (inside `onYou`): `    this.you = you;` — paste after it:
```js
    this.politics?.onYou(you);
```
Anchor: `  onWelcome(m) {` — paste as the first statement of `onWelcome`:
```js
    this.politics?.load();   // /api/politics with If-None-Match; 304 keeps the cached dataset
```

## C3 — main.js: risk check before engaging a contract route (§5.3)

Anchor (end of `routeToJob`):
`    return this.pilot.planTo({ lat: to.lat, lon: to.lon, harbor, label: t.name || 'contract', engage: !this.you?.docked });`
Replace with:
```js
    const engage = !this.you?.docked;
    if (!this.politics || t.kind !== 'harbor') return this.pilot.planTo({ lat: to.lat, lon: to.lon, harbor, label: t.name || 'contract', engage });
    const r = await this.pilot.planTo({ lat: to.lat, lon: to.lon, harbor, label: t.name || 'contract', engage: false });
    if (r?.ok || this.route?.length) this.politics.checkPlannedRoute({ job: t.job, harbor, contract: true, engage });   // [Go] engages; [Plan around listed areas] re-plans with avoid discs
    return r;
```
(`checkPlannedRoute` reads `app.route`, shows the sheet, and on "Plan around" calls `pilot.planTo({ …, avoid })` with the
area discs converted to `radiusKm` — no autopilot change needed.) Fleet orders and express passage can call
`app.politics.showRiskCheck({ from, points, toHarbor, job, contract, title, onGo, onPlanAround })` the same way.

## C4 — hud.js: Rules tab (H25)

`TABS` anchor: `const TABS = ['overview', 'jobs', 'boards', 'market', 'shipyard', 'services', 'shady', 'office', 'players'];` → replace with
```js
const TABS = ['overview', 'jobs', 'boards', 'market', 'rules', 'shipyard', 'services', 'shady', 'office', 'players'];
```
`TAB_ALIAS` anchor: `  office: 'office', fleet: 'office', storage: 'office' }; // v6 fleet` → replace with
```js
  office: 'office', fleet: 'office', storage: 'office', rules: 'rules', law: 'rules', customs: 'rules', sanctions: 'rules' }; // v6 fleet; world politics
```
(The nav button and `#tab-rules` section are injected by `PoliticsUi.inject()` after Market, like fleet.js does for
Office — no index.html change. Quay tiers: add `'rules'` to every tier of `shared/quayrules.js TIER_TABS` if quays should
show it; `quayfmt.js TAB_LABEL` gets `rules: 'Rules'`.)

`renderTab` anchor: `        case 'office': html = this.app.fleetUi ? this.app.fleetUi.tabOffice(h, you) : ''; break; // v6 fleet (fleet.js)` — paste after it:
```js
        case 'rules': html = this.app.politics ? this.app.politics.rulesTabHTML(h, you) : ''; break; // world politics (politics.js)
```

## C5 — hud.js: overview quick tile and banner chip (§5.1)

Anchor: `      ['boards', 'board', 'Job boards', 'every harbour'],` — paste after it:
```js
      ...(this.app.politics ? [this.app.politics.quickTile(h)] : []),   // ['rules', 'flag', 'Rules', 'Restricted · Black Sea MoU · War risk 1 %', 'warn']
```
Anchor: `      <div class="quick">${quick.map(([tab, i, t, s]) => `<button data-act="tab" data-tab="${tab}">${ic(i)}<b>${t}</b><small>${esc(s)}</small></button>`).join('')}${ashoreBtn}</div>` — replace with
```js
      <div class="quick">${quick.map(([tab, i, t, s, tone]) => `<button data-act="tab" data-tab="${tab}"${tone ? ` class="pol-${tone}"` : ''}>${ic(i)}<b>${t}</b><small>${esc(s)}</small></button>`).join('')}${ashoreBtn}</div>
```
and add to `public/css/politics.css` (or style.css): `.quick button.pol-warn { border-color: rgba(255,191,90,.55); } .quick button.pol-bad { border-color: rgba(255,107,107,.65); }`.
Banner — in the same template, anchor `<span class="chip">${ic('flag')}${esc(h.country)}</span>` → replace with
```js
<span class="chip">${ic('flag')}${esc(h.country)}</span>${this.app.politics?.bannerChips(h) || ''}
```

## C6 — hud.js: contract badges and the blocked Accept button (H29, §5.1)

`jobCard` anchor: `    const why = this.whyNot(j, you, C, mass);` → replace with
```js
    const why = this.whyNot(j, you, C, mass) || this.app.politics?.blockedWhy(j) || null;   // "Not for your company — …" disables Accept
```
In the same template, anchor `      <div class="elig ${why ? 'bad' : slow ? 'slow' : 'ok'}">` — paste **before** it:
```js
      ${this.app.politics?.badgesFor(j) || ''}
```
`JOB_LABEL` anchor: `const JOB_LABEL = { freight: 'Freight', passengers: 'Passengers', charter: 'Charter', fishing: 'Fishing', supply: 'Offshore supply', tow: 'Tow', smuggling: 'Smuggling' };` → append
`aid: 'Humanitarian aid', corridor: 'Grain corridor', state: 'State charter', avoid: 'Avoid-route freight', evac: 'Assisted departure'`.
`icons.js JOB_ICON`: add `aid: 'lifebuoy', corridor: 'grain', state: 'flag', avoid: 'compass', evac: 'users'` (and optionally the
`scale` icon body from `politicsview.js SCALE_SVG` as `P.scale`). The full card for the five new types is
`app.politics.contractCardHTML(j)` if the board wants it instead of `jobCard` (`if (F.DIPLO_TYPES[j.type]) …`).

## C7 — chart.js: layers, drawing, popovers (H26, §5.2)

Anchor (constructor): the `this.layers = { base: true, …, market: false, fleet: true }; // fleet: v6 (fleet.js drawChartLayer)` line —
no new keys needed: the five politics layers (`warrisk`, `corridors` on; `eca`, `piracy`, `warnings` off) live in
`app.politics.layers` (persisted per viewer) and are toggled from the "Rules & risk" chip row that `drawChartLayers`
mounts at the top of the chart body (collapsed on phones).

Draw — anchor `    if (this.layers.storms) this.drawStorms();` — paste after it:
```js
    this.app.politics?.drawChartLayers(this, this.ctx);   // war risk, corridors, ECA, piracy, warnings + legend
```
Click — in `click(x, y)`, anchor `    const h = this.hitHarbor(x, y);` — paste **before** it:
```js
    if (this.app.politics?.chartClick(this, x, y)) return;   // a tap on an area label (any mode) or inside an area (select mode)
```
Point popup — anchor `      row.append(this.btn('Add waypoint', () => { this.addWaypoint(lat, lon); this.hidePopup(); }, 'primary'));` — paste **before** it:
```js
      this.app.politics?.pointPopupRows(lat, lon, body);
```
(`chartClick` uses `chart.openPopup`, `unproject`, `mode`; the phone bottom-sheet positioning of `positionPopup` applies.)

## C8 — hq.js: Rules / Compliance tab (H27, §5.4)

Anchor: `const TABS = [['map', 'chart', 'Map'], ['ships', 'ship', 'Ships'], ['money', 'coins', 'Money'], ['office', 'anchor', 'Office'], ['log', 'list', 'Log']];` → replace with
```js
const TABS = [['map', 'chart', 'Map'], ['ships', 'ship', 'Ships'], ['money', 'coins', 'Money'], ['office', 'anchor', 'Office'], ['rules', 'scale', 'Rules'], ['log', 'list', 'Log']];
```
(`ic('scale')` falls back to the info icon until `scale` is added to icons.js — see C6. Phones get 6 icons; hide
labels under 360 px: `@media (max-width: 359px) { .hqTabs button span { display: none; } }`.)
Anchor: `      case 'log': html = this.logHTML(v, now); break;` — paste before it:
```js
      case 'rules': html = this.app.politics ? this.app.politics.complianceTabHTML(v.compliance) : ''; break;
```
Buttons inside the panel carry `data-pol` (not `data-act`), so the HQ click handler (`if (!this.app.fleetUi?.sheetAction…`)
ignores them and `PoliticsUi`'s document listener handles them. No other hq.js change.

## C9 — net.js

**No change.** Every politics action uses the existing `net.action(name, fields)` (`pol_policy`, `pol_cover`,
`pol_cover_skip`, `pol_guards`, `pol_clearance`, `pol_licence`, `pol_reflag`, `pol_home_plan`, `pol_home_start`,
`pol_home_cancel`), and the dataset is fetched over HTTP (`/api/politics`).

## C10 — index.html

**No required change** (`PoliticsUi` injects `/css/politics.css`, the Rules nav button and `#tab-rules`). Optional, to
avoid a flash of unstyled cards on the first Rules tab: anchor `<link rel="stylesheet" href="css/sail.css">` → add after it
```html
<link rel="stylesheet" href="css/politics.css" id="polCss">
```
(the id makes `ensureCss` skip the second link).

## C11 — `risk` event kind (amber)

The server's new event kind `risk` needs a style where `law`/`warn` are styled (hud.js `event()`): reuse `warn`
styling, e.g. in hud.js `event(e)` map `e.kind === 'risk'` to the amber class.

---

## Checks after pasting (contract §8.3, client part)

- Rules tab after Market at every harbour; Odesa shows Restricted, [Request clearance] → `pol_clearance`, [Show on chart]
  centres the corridor; every line has `ⓘ source · date`; "Game rule" tags; footer disclaimer + dataset version.
- Contract board: corridor job shows `War risk T4 · +200 %`, `Corridor`, `Premium refunded`; a blocked job shows
  `Not for your company — …` and a disabled Accept.
- Chart: legend chips toggle the five layers; tapping a label opens the popover with the premium for your ship.
- Contract route → risk check sheet (phone: full-height, sticky buttons, blockers first); [Go] engages the autopilot.
- HQ → Rules: policy buttons send `pol_policy`; [Move home to …] → plan sheet with before/after; [Re-flag…] → picker.
