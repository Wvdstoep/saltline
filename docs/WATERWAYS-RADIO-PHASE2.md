# Saltline — VHF radio (lane B) phase 2: the hook edits

Status: **phase 1 done** (2026-10-09), new files only. This file lists the exact edits the integration pass (§9.6 of
`docs/BRIDGES-LOCKS-VHF-CONTRACT.md`) makes to existing files to switch the radio on. Every edit is additive. With
`SALTLINE_WW_OFF=1` the radio is not constructed and the game is unchanged.

## 1. What phase 1 shipped (new files)

| File | What |
|---|---|
| `shared/vhf.js` | channel plan (`CHANNELS`, 1–28, 60–88, NL 31; 16 distress, 70 DSC-only, 13 bridge-to-bridge, 10 inland), RAINWAT 1 W rule (`effectivePower`), range `horizonKm` / `rangeKm` / `reach` (§6.2), `garble` (q < 0.15 → 30 % of letters → `·`, seeded), dual watch `hears`, `applySet` (vhf_set sanitiser), `replyDelayS` (3–8 s), `inHours` / `hhmm` (Europe/Amsterdam via Intl), `inPoly`, `bars`, `absMs` |
| `shared/vhfphrases.js` | phrase ids + EN (SMCP) / NL templates for players, bridges, locks, VTS, coast guard, harbours, AI ships, DSC; `render`, `textOf`, `phrasesFor` (context sort), `autoArgs`, `langFor` (Q16), `typeKeyOf`, `PLAYER_PHRASES` |
| `server/vhf.js` | `createRadio(game, ww, opts)`: server-authoritative routing (receivers by channel / DW / range), responders (bridges and locks through `ww.request` / `ww.registerLock`, VTS sectors with redirect, coast guard 16 → 67, AI + fleet ships; **AIS never**), wrong channel / out of range / out of hours = silence + tip after 2 misses, `dsc` (coast-guard reply on 16, Mayday relay chat line, `sar_alert` event), `ww.onEvent` announcements, `vhf_st` station pushes, `onAction` router. `loadVts`, `loadVtsFile`, `coastStationsFrom` |
| `server/vhfdata/vts-nl.json` | Rotterdam VTS seed: Maas Approach 1, Oude Maas 62, Maasbruggen 81, Traffic Centre Rotterdam 11, HCC 14 (+19); unverified sectors (Maasmond, Europoort, Rozenburg, Botlek, Waalhaven, Eemhaven) fall back to the nearest verified sector; ch 10 outside sectors |
| `public/js/vhf.js` | client UI `Vhf` (desktop handset panel + status chip; phone handset button + bottom sheet), keys, PTT, call-by-name, covered DISTRESS (hold 3 s) |
| `public/js/vhffmt.js` | pure formatting (log rows, chips, quick call, previews, knob) |
| `public/js/radiosound.js` | `RadioSound`: own WebAudio graph — squelch click, band-passed noise bed at (1 − q), 120 ms tail, 1 kHz pip, DSC alarm; optional `speechSynthesis` voices |
| `public/css/vhf.css` | the radio's styles (style.css tokens) |
| `test/vhf-range.test.mjs`, `vhf-phrases.test.mjs`, `vhf-server.test.mjs`, `vhf-fmt.test.mjs`, `vhf-helpers.mjs` | 49 tests (§10.6 numbers; stub `ww` with the frozen §9.5 interface) |

Harness: `scratchpad/pw/vhf/` (`node serve.mjs` on 3330–3339, `node shots.mjs` → `shots/d*.png`, `shots/p*.png`) runs the
real `server/vhf.js` in the page with a lift-bridge stub and plays the full "request Rozenburgsesluis lift bridge opening"
conversation (wrong channel → tip, Shift+Z, PTT, reply "number 1 … 14:24", second skipper "number 2", ack, red → red+green
→ "bridge is opening, proceed on green" → green).

### 1.1 Assumptions about lane A (check when wiring)

* `ww.stationsOn(ch, lat, lon)` returns `[{id, callName, ch | vhf, pos: [lat, lon] | {lat, lon}, h?, hours?, kind?: 'bridge'|'lock', open?: boolean, bridges?: [ids], axis?}]`.
  The radio also calls it with **`ch = null` meaning "every channel"** (for call-by-name and the "Call X (ch N)" chips). If lane A does not
  support `null`, the radio falls back to one call per voice channel (57 calls per open set every 3 s; fine, but supporting `null` is cheaper).
* `ww.request(id, ship, eta)` → `{ok, verdict, n, tOpen, reason}`; the radio also reads optional `clrNow`, `clrO`/`clrOpenNow`, `next`,
  `until`, `why`, `where`, `alt`, `night`. `tOpen` may be epoch ms, epoch s or seconds from now (`absMs`). `reason: 'hours'` → silence;
  `'block'` → "No openings until …"; `'out'` → "out of service until …"; `'far'` → "call again within 3 km".
* `ww.registerLock(id, ship, side)` → `{ok, chamber, n, tCycle, fee, reason?, why?, side?, where?}`. `side` passed is 0/1 from the
  lock axis when the station carries one, else `null`.
* A request to a **lock** with phrase `req_open` goes to the lock-head bridge (from `station.bridges`) nearest the ship (§4.8.7).
* `ww.onEvent(fn)`: `fn(type, data)` or `fn({type, …})`. Used: `opening` (`{id, ships}`), `closed`, `missed`, `admit` (`{id, plan: [{ship, side, x, head}]}`),
  `closing`, `levelling` (`{id, dh, dur}`), `release`, `lost`. `id` is the station id (the lock id for lock-head bridges).
* The `ship` handed to ww: `{id, name, cls, lat, lon, hdg, spd, isPlayer, ad, need, T, L, B, type, where, dest}`.
* VTS file: if lane A ships `server/waterworks/vts-nl.json`, `loadVtsFile()` uses it; otherwise the lane B seed in
  `server/vhfdata/vts-nl.json` (same schema). Keep one of them.

## 2. `server/game.js`

**2.1 Import** — after the line `import { crashJibeDamage, windOverWater } from '../shared/sail/sailphys.js';`:

```js
import { createRadio } from './vhf.js';                                                   // VHF radio (docs/BRIDGES-LOCKS-VHF-CONTRACT.md §6)
```

**2.2 Construct** — after lane A's `this.ww = createWaterworks(this, fis, …)` line (if lane A is not wired yet: after `this.loadState();`
in the constructor):

```js
    // VHF radio (§6): stations from ww + VTS sectors + coast guard; AI and fleet ships answer, AIS ships never speak.
    this.radio = process.env.SALTLINE_WW_OFF === '1' ? null : createRadio(this, this.ww || null, {
      vts: opts.vts || null, harbors: HARBORS,
      aisNear: (lat, lon, r) => { try { return this.liveAis?.near(lat, lon, r) || []; } catch { return []; } },
      shipsNear: (lat, lon, r) => {
        const ai = (this.traffic?.near(lat, lon, r) || []).filter((a) => !this.aiFilter || this.aiFilter(a));
        const fleet = [...(this.fleet?.actors?.values?.() || [])].filter((a) => a.ship && haversine(lat, lon, a.ship.lat, a.ship.lon) <= r)
          .map((a) => ({ id: a.id, name: a.vesselName || a.name, lat: a.ship.lat, lon: a.ship.lon, hdg: a.ship.hdg }));
        return [...ai, ...fleet];
      },
      airOf: (p) => {                                   // lane A shared/airdraft.js; falls back to the class numbers
        const c = SHIP_CLASSES[p.ship.cls] || {};
        const a = p.air || (this.airDraftNow ? this.airDraftNow(p) : null);
        return { ad: a?.ad ?? null, T: a?.T ?? c.draft, need: a?.need ?? null, L: c.length, B: c.beam };
      },
      isInland: (lat, lon) => { try { return this.waterAt ? this.waterAt(lat, lon).ref === 'canal' : false; } catch { return false; } },
    });
    this.radio?.on('sar_alert', (a) => this.log(`[sar] ${a.name} ${a.nature} at ${a.lat.toFixed(3)}, ${a.lon.toFixed(3)} (${a.cg})`));   // hook for search and rescue
```

(`this.airDraftNow(p)` / `this.waterAt(lat, lon)` are the helpers lane A's wiring adds around `airDraftNow` and `waterLevelAt`; `haversine`
is already imported from `../shared/geo.js`.)

**2.3 Actions** — in `onAction`, before the line `case 'rename': p.name = cleanName(m.name) || p.name; …`:

```js
        case 'vhf_set': case 'vhf_tx': case 'dsc': return this.radio ? this.radio.onAction(p, m) : undefined;   // VHF (§8.2)
```

**2.4 Tick** — in `tick(dt)`, after `this.fleet.tick(dt);`:

```js
    this.radio?.tick(dt);                             // VHF: operator replies due, `vhf_st` pushes to open sets
```

**2.5 `you`** — in `privateState(p)`, after `...this.fleet.youFields(p),`:

```js
      radio: this.radio ? this.radio.youFields(p) : null,   // VHF {on, ch, dual, power, powerEff, inland, lang, vol, dmg}
```

**2.6 Save / load** — in `migratePlayer(p)`, after `if (p.berth === undefined) p.berth = null;`:

```js
    if (!p.radio || typeof p.radio !== 'object') p.radio = { on: true, ch: 16, dual: true, power: 'hi', lang: 'auto', vol: 0.8 };
    p.radio.open = false; p.radioLastTx = 0; p.radioLastDsc = 0; p.radioMiss = null;
```

and in `saveState()` extend the player map `({ ...p, hail: null, online: false, warp: 1, … })` with
`radio: p.radio ? { ...p.radio, open: false } : undefined, radioLastTx: 0, radioLastDsc: 0, radioMiss: null`.

**2.7 Antenna damage (optional, after lane A's strikeCheck)** — where a strike result is applied: `if (strike.antenna) p.antennaDmg = true;`
and clear it in `repair(p)` (`p.antennaDmg = false;`). The radio reads `p.antennaDmg` (range × 0.3).

## 3. `server.js`

**3.1 Import** — after `import { Game } from './server/game.js';`:

```js
import { loadVtsFile } from './server/vhf.js';                           // VHF: VTS sectors (server/waterworks/vts-nl.json, else the lane B seed)
```

**3.2 Load and pass** — replace the `game = new Game(stack, log, { weather, traffic, harborgeom: geom, routeTable, routePlanner });` line by:

```js
const vts = await loadVtsFile();                                         // VHF (§6.3)
game = new Game(stack, log, { weather, traffic, harborgeom: geom, routeTable, routePlanner, vts });     // MARKET adds routeTable; TIME reads it; v6 fleet: captains plan with routePlanner   // WORLD TILES: stack + facade   // VHF: vts
```

No new route. The ws switch is unchanged (`vhf_set` / `vhf_tx` / `dsc` arrive as `action`). `maxPayload` 16 KiB is ample (free text ≤ 120).

## 4. `public/js/main.js`

**4.1 Import** — after `import { SailHud } from './sailhud.js';`:

```js
import { Vhf } from './vhf.js';                                       // VHF radio (docs/BRIDGES-LOCKS-VHF-CONTRACT.md §6.6)
import { typeKeyOf } from '/shared/vhfphrases.js';
```

**4.2 Construct** — after the sail HUD block, i.e. after `} catch (e) { console.warn('[sail] HUD unavailable', e); }`:

```js
    try {   // VHF radio: desktop panel (E) / phone handset button + sheet
      this.vhf = new Vhf({ net: this.net, phone: isTouch(), uiLang: navigator.language,
        shipInfo: (you) => { const c = SHIP_CLASSES[you?.ship?.cls] || {}; return { L: c.length, B: c.beam, type: typeKeyOf(you?.ship?.cls, { sail: !!rigOf(you?.ship?.cls) }), where: 'approach' }; } });
    } catch (e) { console.warn('[vhf] unavailable', e); }
```

**4.3 Messages** — in `onMessage(m)`, before `case 'chat': this.hud.chat(m); break;`:

```js
      case 'vhf': case 'vhf_st': this.vhf?.onMessage(m); break;          // VHF transmissions and station lists
```

**4.4 `you`** — in `onYou(...)`, after `this.net.vid = you.aboard ?? null;`:

```js
    this.vhf?.onYou(you);                                                // you.radio, the ship's numbers for the phrase preview
```

**4.5 Keys (keydown)** — main.js lowercases the key, so the radio tests `e.shiftKey` itself. Two hooks.

(a) Right after `const k = String(e.key || '').toLowerCase();` (before `if (k === 'enter')`), so Enter / Esc / Tab / arrows / [ ] / digits / Z go
to the open radio first:

```js
      if (this.vhf?.isOpen && !this.walking() && this.vhf.handleKey(e)) return;   // radio open: [ ] digits Enter Tab ↑↓ ←→ Z(PTT) Esc
```

(b) After `if (this.interior.active && this.interior.handleKey(e)) return;` and before the sailing-keys line:

```js
      if (!this.ashore?.active && this.vhf?.handleKey(e)) return;   // E radio · Shift+E dual watch · Shift+Z call the bridge/lock ahead
```

Note: the sail HUD uses `Z` (tack/jibe) and `[ ]` (sheets). With the radio **closed** those keys stay with the sail HUD (plain Z still
tacks); only **Shift+Z** is taken by the radio. With the radio **open**, Z is PTT and `[ ]` step the channel.

**4.6 Keys (keyup)** — the existing keyup listener becomes:

```js
    window.addEventListener('keyup', (e) => { if (this.vhf?.handleKeyUp(e)) return; const k = String(e.key || '').toLowerCase(); if (k === 'a' || k === 'arrowleft') this.input.left = false; if (k === 'd' || k === 'arrowright') this.input.right = false; });
```

**4.7 Interior VHF (optional)** — where the bridge interior's GMDSS / VHF item is used (`interior.js` / `ga.js` item handler):
`window.app?.vhf?.open(true);`.

## 5. `public/js/hud.js`

**5.1 Escape / back closes the radio** — in `transientOpen()` add `|| !!this.app?.vhf?.isOpen` to the returned expression, and in
`closeOverlays()` add as the first line:

```js
    this.app?.vhf?.open(false);                                          // VHF panel / phone sheet
```

(`Hud` already keeps `app` from its constructor; if the field has another name use that.)

**5.2 Bridge / lock card button (lane C)** — the "Call on ch X" button of `wwhud.js` calls
`window.app?.vhf?.useChip({ ch, to: { id, name, kind }, phrase: kind === 'lock' ? 'req_lock' : 'req_open' }); window.app?.vhf?.open(true);`.

## 6. `public/js/net.js`

No change is required: the radio uses `net.action('vhf_set' | 'vhf_tx' | 'dsc', …)`. Optional convenience, after
`chat(text) { this.send({ t: 'chat', text }); }`:

```js
  vhf(action, extra = {}) { this.action(action, extra); }              // VHF: vhf_set / vhf_tx / dsc (§8.2)
```

## 7. `public/index.html`

**7.1 Styles** — after `<link rel="stylesheet" href="css/sail.css">`:

```html
<link rel="stylesheet" href="css/vhf.css">
```

**7.2 Help** — in `#helpWrap`, after the "Navigation" card (`<article class="card"><h3><span class="si" data-icon="chart"></span>Navigation</h3>…</article>`):

```html
        <article class="card"><h3><span class="si" data-icon="chart"></span>VHF radio</h3><p>Press <kbd>E</kbd> (phone: the handset button) for the radio. Pick a channel with the knob, <kbd>[</kbd> <kbd>]</kbd> or digits + <kbd>Enter</kbd>; <kbd>Shift+E</kbd> keeps a dual watch on 16. Bridges, locks and VTS answer only on their own channel and within their hours — <kbd>Shift+Z</kbd> tunes to the bridge or lock ahead. Choose a station (<kbd>Tab</kbd>) and a phrase (<kbd>↑</kbd> <kbd>↓</kbd>), hold <kbd>Z</kbd> to talk and release to send. The red DISTRESS button (lift the cover, hold 3 s) sends a DSC alert to the coast guard.</p></article>
```

No markup is needed for the panel: `Vhf` builds its own DOM at the end of `<body>`.

## 8. Checks after wiring

* `npm test` green (the 49 `vhf-*` tests plus everything else, no existing test changed).
* In the browser at Rozenburg: E opens the panel on 16 with DW; the chip "Call Rozenburgsesluis (ch NN)" appears within 3 km;
  a call on 16 gets silence and, after the second try, the tip naming the right channel; Shift+Z → PTT → the operator answers in
  3–8 s with the queue number and the opening time; the `opening` event line arrives as the span starts lifting.
* Desktop: the status chip sits above the radar card (`bottom: gut + radar-w + 64px`); check it does not cover `#ctxStack` buttons.
  Phone: the handset button sits above the touch bar on the right (`bottom: bar + 150px`); check it clears the touch helm's lever.
* With `SALTLINE_WW_OFF=1`: no radio panel actions reach the server (`this.radio` is null) — the client panel still opens but nothing answers.
  If that is not wanted, gate the `Vhf` construction on `welcome.world.radio` (add `radio: !!this.radio` to `worldInfo()`).
