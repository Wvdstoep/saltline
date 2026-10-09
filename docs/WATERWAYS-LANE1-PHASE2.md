# Waterways lane A (data / rules / server) — phase 2 hook edits

Status: phase 1 done (2026-10-09). New files only; no existing file was edited. This document lists the exact edits the
integration pass (contract §9.6) applies to existing files, with anchors and code. Everything is behind new code paths:
with `SALTLINE_WW_OFF=1` (or the data files absent) the game behaves exactly as today.

Contract: `docs/BRIDGES-LOCKS-VHF-CONTRACT.md`. Tests: `node --test test/ww-*.test.mjs` (55 tests, ~2 s, offline).

## 0. What phase 1 built

| File | What |
|---|---|
| `shared/airdraft.js` | `AD_MARGIN`, `profileOf`, `draughtNow`, `deckTiers`, `airDraftNow`, `canFold`, `ballastStep`, `ballastTime`, `airPublic`, `registerProfiles` (barges, §7.6) |
| `shared/waterlevel.js` | `waterLevelAt`, `datumOffset`, `sideLevel`, `poundAt`, `m2At` |
| `shared/waterworks.js` | `CEMT`, `SIGNALS`, `clrNow`, `gauge`, `boardText`, `passVerdict`, `bestSpan`, hours (`inHours`, `nextService`, `blockAt`, `nextSlot`, `scheduleOpen`), `bridgeStep`, `openFrac`, `spanSignal`, `levelTime`, `levelAt`, `fitChamber`, `packChamber`, `queueOrder`, `lockStep`, `chamberLevel`, `lockSignals`, `lockFee`, `pairedPlan`, `strikeOutcome`, converter v2 helpers `WW_KEEP_TAGS`, `seamarkBridge`, `fallbackBridge`, `bridgeVector` |
| `shared/shelter.js`, `server/shelter.js` | fetch-limited sea state; `createShelter({ navigable, cellKind })` with a 200 m / 10° / 10 min cache |
| `server/fis.js` | pack / unpack / `loadFis()` of `server/waterworks/nl-fis.json.gz`, `subsetFis` |
| `server/waterworks.js` | `createWaterworks(game, fis, { now, levels, aisIn, water })`: registry + spatial index, `joinLines` (§3.5), `request`, `passed`, `registerLock`, `makeFast`, `leave`, `lockStay`, `tick`, `strikeCheck`, `setOut`, `statics`, `state`, `stationsOn`, `verdicts`, `onEvent`, `toSave` / `load` |
| `server/inland.js` | `buildGraph`, `planInland`, `whyNot`, `joinSeaGates`, `planWithSea` |
| `scripts/fetch-fis.mjs` | operator fetch + normaliser (`--probe`, `--raw DIR`, `--from-raw DIR`, `--out FILE`) |
| `server/waterworks/` | `nl-fis.json.gz` (445 KB: 3,642 bridges with openings, 380 locks, 5,107 fairway sections, 994 tourist harbours; geogeneration 4951, published 2026-10-07, fetched 2026-10-09, CC0), `levels-nl.json`, `seagates-nl.json`, `vts-nl.json` |
| `test/fixtures/ww/` | `fis-probe.json` (raw probe records), `fis-rotterdam.json` (packed subset bbox 51.84–51.98 N, 3.98–4.50 E), `rozenburg-synthetic.json` (the contract's seed) |

### 0.1 Production probe result (contract §3.4, Q1) — paste into the contract

* Dataservice: `https://www.vaarweginformatie.nl/wfswms/dataservice/1.4/geogeneration` → `{GeoGeneration: 4951, PublicationDate}`;
  entities at `…/1.4/<gen>/<entity>?offset=&count=100` → `{TotalCount, Result[]}`. No key.
* Entity names: `bridge`, `opening`, `lock`, `chamber`, `radiocallinpoint`, `operatingtimes`, **`section`** (not
  `fairwaysection`), `maximumdimensions`, `fairwayclassification`, `fairway`, `berth`, `touristharbour`, `terminal`,
  `administration`. **There is no CEMT field** in v1.4: the class is derived from `maximumdimensions` (General L/B/T).
* Field names (as used by the normaliser) are listed in the header of `scripts/fetch-fis.mjs`. Key ones:
  `opening.HeightClosed / HeightOpened` (above the bridge's `Referencelevel`: NAP | KP | MP | SP | PP | BP | UNSPECIFIED),
  `opening.ClearanceHeightClosed/Opened` (at MHW for `MhwReferenceLevel: RIVER`, = Height − `MhwOffset`), `opening.Type`
  (VST fixed, HEF lift, BC/KLP/RBC bascule, DBC double bascule, OPH/DOP draw, DR/DDR swing, PDR/PON pontoon, ROL retractable,
  OKW weir/barrier opening), `chamber.SchutLengteVloed/Eb`, `Width`, `SillDepthBeBu/BoBi` (sill **elevation**, negative),
  `radiocallinpoint.VhfChannels[]` by `ParentId`, `operatingtimes.NormalSchedules[].Mon…Sun.OperatingTimes[{FromTime, ToTime,
  Recommendation: BERP (commercial only) | VERZ (on request)}]`.
* Botlekbrug (fis:17838816): NAP, two lift spans 14.04 / 45.0 (87.3 m) and 14.06 / 45.0 (75 m), VHF 18, remote-controlled,
  RWS; openings at :15 and :45, weekdays 06–22 (small craft blocked 06:30–09:30, 15:30–18:30), nights on request.
* Calandbrug Rozenburg (fis:61127240): NAP, lift 11.7 / 49.7 (46 m) + fixed 11.7 (80 m), VHF 22, 24/7.
* Rozenburgsesluis (fis:4199): chamber 305 (306.4 ebb) × 24 m, **sill NAP −6.5** (not 9.0), VHF 22, Port of Rotterdam, 24/7.
* **Correction to the contract:** the two head bridges are **bascules** 3.6 m closed, open **unlimited**, **24 m wide** — the
  OpenSeaMap "3.6 / 24.0" board is closed clearance / width, not closed / open. And a **fixed rail bridge "Havenspoorlijn
  over Rozenburgsesluis", NAP +14.0**, crosses the lock. The schooner case still holds (it is routed via the Calandbrug),
  but because of the 14 m rail bridge. Tests keep the contract's numbers on `rozenburg-synthetic.json` and add the real ones.

### 0.2 Behaviour notes for the integrator

* Fold rule as written in §4.4 (stack > lowered eye + 1.0) also refuses lowering the coaster's wheelhouse with ONE deck tier
  (11.49 > 11.1). §10.1.4's 7.581 m is reachable only by loading after folding. Change `canFold` if that is not intended.
* `fold[part]` truthy = lowered. The save default (`{}`) = everything raised.
* `packChamber` caps a rectangle's width at the usable width (a 22.5 m feeder is 23.0 wide in a 24 m chamber), which makes
  §10.3.3 and §10.3.7 consistent; small craft never lie abreast of a commercial ship.
* FIS gives openings as points; spans are laid out side by side along a synthetic deck line (`lineSrc: 'synthetic'`) until
  `ww.joinLines()` attaches the OSM/OFM line (step 1 below).

---

## 1. `server/wtsource.js` (overlay query, kept tags, schema 2)

**1a. KEEP_TAGS** — anchor: `const KEEP_TAGS = /^(man_made|floating|waterway|lock|name|height|`… (line ~84). Replace the line with:

```js
import { WW_KEEP_TAGS } from '../shared/waterworks.js';   // (add at the imports)
const KEEP_TAGS = process.env.SALTLINE_WW_OFF === '1'
  ? /^(man_made|floating|waterway|lock|name|height|width|diameter|crane:type|seamark:type|seamark:.*(colour|character|period|category|minimum_depth|clearance_height|height|range)|depth|maxdraught|maxheight|bridge:movable|ele)$/
  : WW_KEEP_TAGS;
```

`WW_KEEP_TAGS` keeps today's set plus `seamark:bridge:.*`, `bridge`, `bridge:structure`, `layer`, `CEMT`, `maxlength`,
`maxwidth`, `vhf`, `lock_name`, `lock_ref`, `operator`, `opening_hours`, and the §7.1 harbour keys.

**1b. overlayQuery** — anchor: the line `` `nwr["seamark:type"~"^(${SEAMARK_TYPES})$"](${b});` + `` inside `overlayQuery`. Insert after it:

```js
    `way["bridge:movable"](${b});way["man_made"="bridge"](${b});way["waterway"~"^(river|canal)$"]["CEMT"](${b});` +
    `nwr["leisure"="marina"](${b});nwr["mooring"](${b});nwr["seamark:type"="small_craft_facility"](${b});nwr["harbour"="yes"](${b});nwr["waterway"="fuel"](${b});` +
```

and in `overlayKind` (anchor: `if (st === 'bridge') return 'bridge';`) add before it:

```js
  if (t['bridge:movable'] || mm === 'bridge') return 'bridge';
  if (t.CEMT && (t.waterway === 'river' || t.waterway === 'canal')) return 'fairway_cemt';
  if (t.leisure === 'marina' || t.mooring || st === 'small_craft_facility' || t.harbour === 'yes' || t.waterway === 'fuel') return 'harbour_osm';   // lane D reads these
```

**1c. Schema 2** — anchor: `return { v: 1, date, x, y, f };` at the end of `compactOverlay` → `return { v: 2, date, x, y, f };`
(and the JSDoc `{ v: 1,` above it → `{ v: 2,`).

**1d. Lazy refetch of v1 overlays** — `server/worldtiles.js`, anchor in `overlayFor`:
`try { const b = await fs.promises.readFile(overlayFile(x12, y12)); touch(…); return JSON.parse(zlib.gunzipSync(b).toString('utf8')); } catch { return null; }`
→ parse into `ov`, and when `ov.v < 2` schedule the existing overlay refresh for that z12 square (the function documented as
"Fetch (if needed) the Overpass overlay of a z12 square and rebuild its loaded / cached D14 children", line ~473) at background
priority, then `return ov` (old overlays are used until replaced).

## 2. `server/wtconvert.js` (converter v2)

**2a.** Anchor `export const CONVERTER_VERSION = 1;` → `export const CONVERTER_VERSION = process.env.SALTLINE_WW_OFF === '1' ? 1 : 2;`
and `import { bridgeVector } from '../shared/waterworks.js';` at the imports. In the `vectors = {` literal, `v: 1,` →
`v: CONVERTER_VERSION,`.

**2b. Bridges block** — anchor: the comment `// bridges over water (OpenFreeMap brunnel=bridge), clearance estimated from the water width`.
Before the `for (const f of layers.transportation?.features || [])` loop add:

```js
    const smBridges = CONVERTER_VERSION >= 2 ? ovFeats.filter((f) => f.k === 'bridge').map((f) => ({ f, pts: ovLocal(f) })) : [];
    const nearSeamark = (lm) => {             // OpenSeaMap tags the node on the waterway under the deck: join within 30 m
      let best = null;
      for (const s of smBridges) {
        const [px, py] = [s.pts[0], s.pts[1]];
        for (let i = 0; i + 3 < lm.length; i += 2) {
          const ax = lm[i], ay = lm[i + 1], bx = lm[i + 2], by = lm[i + 3], L2 = (bx - ax) ** 2 + (by - ay) ** 2 || 1;
          const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / L2));
          const d = Math.hypot(px - ax - t * (bx - ax), py - ay - t * (by - ay));
          if (d <= 30 && (!best || d < best.d)) best = { d, s };
        }
      }
      return best ? best.s.f : null;
    };
```

and replace the two lines

```js
        const clr = big && wmax > 300 ? 35 : big && wmax > 100 ? 15 : 6;
        …
        bridges.push({ p: simplify(l.map((u) => u * mPerUnit), 1).map((v) => Math.round(v * 10)), w, deck: clr + 1.5, clr, mov: 0, k, e: 1 });
```

by

```js
        const lm = l.map((u) => u * mPerUnit);
        if (CONVERTER_VERSION >= 2) {
          const sm = nearSeamark(lm);
          const id = sm ? `osm:${sm.id}` : `ofm:${z}/${x}/${y}:${bridges.length}`;
          const v = bridgeVector({ p: simplify(lm, 1).map((q) => Math.round(q * 10)), w, k, cls, movable: f.tags['bridge:movable'] || null, id },
            sm ? sm.t : null, { waterW: wmax, cemt: hints.cemt || null, datum: hints.nonTidal ? 'KP' : hints.nl ? 'NAP' : 'MHWS' });
          bridges.push({ ...v, sp: null });   // sp (span along the line, dm) is filled by the registry join; maxheight is never read
        } else {
          const clr = big && wmax > 300 ? 35 : big && wmax > 100 ? 15 : 6;
          bridges.push({ p: simplify(lm, 1).map((v) => Math.round(v * 10)), w, deck: clr + 1.5, clr, mov: 0, k, e: 1 });
        }
```

(`z, x, y` are the tile coordinates already in scope of `convert`; if named differently, use those.) `bridgeVector` emits
`{ p, w, deck, clr, mov, k, e, id, clrO (−1 = unlimited), wO, datum }` — additive, old clients read `p, w, deck, clr, mov, k, e`.

## 3. `server/game.js`

**3a. Imports** (after `import { crashJibeDamage, windOverWater } from '../shared/sail/sailphys.js';`):

```js
import { loadFis } from './fis.js';                                         // BRIDGES & LOCKS (docs/BRIDGES-LOCKS-VHF-CONTRACT.md)
import { createWaterworks } from './waterworks.js';
import { createShelter } from './shelter.js';
import { airPublic, ballastStep, canFold, profileOf, FOLD_TIME } from '../shared/airdraft.js';
import { waterLevelAt } from '../shared/waterlevel.js';
import { WT, WT_NAVIGABLE } from '../shared/wtformat.js';
import LEVELS_NL from './waterworks/levels-nl.json' with { type: 'json' };
```

**3b. Constructor** — anchor: `this.routePlanner = opts.routePlanner || null;` Add after it:

```js
    this.wwOn = process.env.SALTLINE_WW_OFF !== '1';
    this.levels = this.wwOn ? LEVELS_NL : null;
    this.ww = this.wwOn ? createWaterworks(this, opts.fis !== undefined ? opts.fis : loadFis(), { now: () => this.simTime, levels: this.levels,
      aisIn: opts.aisIn || null }) : null;
    this.shelter = this.wwOn && opts.maskAt ? createShelter({
      navigable: (la, lo) => { const m = opts.maskAt(la, lo); return m == null ? this.world.isWater(la, lo) : WT_NAVIGABLE[m] === 1; },
      cellKind: (la, lo) => { const m = opts.maskAt(la, lo); return m === WT.MASK.LOCK ? 'lock' : m === WT.MASK.DOCK ? 'dock' : 'water'; },
      now: () => this.simTime }) : null;
    if (this.ww) this.ww.onEvent((e) => this.onWaterworksEvent?.(e));   // lane B's radio subscribes here (radio.tick announcements)
```

`server.js` passes `maskAt: (la, lo) => wt.maskAt(la, lo)` (worldtiles facade) in the `new Game(stack, log, {…})` options
(anchor: `game = new Game(stack, log, { weather, traffic, harborgeom: geom, routeTable, routePlanner });`).
(`WT_NAVIGABLE` is a `Uint8Array` indexed by the mask class.)

**3c. Save / load** — anchor in the save object: `savedAt: new Date().toISOString(), fleetSchema: 1, simTime: this.simTime,` →
add `ww: this.ww ? this.ww.toSave() : undefined,`. After `const s = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));`
(the load path) add `if (this.ww && s.ww) this.ww.load(s.ww);`. In the per-player migration (the block that sets
`p.warp = 1; p.warpRouted = false;`) add:

```js
    if (!Number.isFinite(p.ship.ballastT)) p.ship.ballastT = 0;
    if (!p.ship.fold || typeof p.ship.fold !== 'object') p.ship.fold = {};
    if (!p.radio) p.radio = { on: true, ch: 16, dual: true, power: 'hi', lang: 'auto', vol: 0.8 };
    if (p.lockStay) { p.lockStay = null; }      // released on the planned side: the chamber restarts idle (§8.3)
```

**3d. Actions** — anchor `case 'set_warp': return this.setWarp(p, m);` add after it:

```js
        case 'ballast': return this.ballastCmd(p, m);
        case 'fold': return this.foldCmd(p, m);
        case 'ww_query': return this.ww && this.send(p, { t: 'ww_static', objects: this.ww.statics(+m.lat, +m.lon, Math.min(15000, +m.r || 8000)) });
        case 'ww_button': return this.wwButton(p, m);
        case 'lock_register': return this.lockRegister(p, m);          // also reached from radio (lane B) via ww.registerLock
```

and the methods (next to `setWarp`):

```js
  ballastCmd(p, m) {
    const prof = profileOf(p.ship.cls);
    if (!(prof.ballastMax > 0)) return this.event(p, 'warn', 'This ship has no ballast tanks.');
    if (m.op === 'stop') p.ship.ballastTarget = p.ship.ballastT;
    else p.ship.ballastTarget = m.op === 'fill' ? (Number.isFinite(+m.target) ? +m.target : prof.ballastMax) : (Number.isFinite(+m.target) ? +m.target : 0);
    this.sendYou(p);
  }
  foldCmd(p, m) {
    const r = canFold(p.ship.cls, m.part, !!m.down, { cargo: p.cargo, sogKn: Math.abs(p.ship.spd || 0) });
    if (!r.ok) return this.event(p, 'warn', r.why);
    p.ship.foldOp = { part: m.part, down: !!m.down, until: this.simTime + (FOLD_TIME[m.part] || 60) };
    this.sendYou(p);
  }
  wwButton(p, m) {
    const r = this.ww?.request(m.id, p, 60, { button: true });
    if (!r) return;
    if (!r.ok) return this.event(p, 'warn', r.reason === 'range' ? 'Too far from the push button (300 m).' : r.reason === 'hours' ? `No service until ${r.next}.` : r.reason === 'never' ? 'You will not fit through, even open.' : 'The bridge does not answer.');
    this.event(p, 'info', r.verdict === 'opening' ? `Opening requested — you are number ${r.n}.` : 'You fit under — no opening needed.');
  }
  lockRegister(p, m) {
    const r = this.ww?.registerLock(m.id, p, m.side === 1 ? 1 : 0);
    if (r && r.ok) this.event(p, 'info', `Registered for chamber ${r.chamber}: number ${r.n}${r.fee ? `, lock fee ${r.fee} credits` : ''}.`);
    else if (r) this.event(p, 'warn', r.reason === 'fit' ? `Your ship does not fit this lock (${r.why}).` : 'The lock does not answer.');
  }
```

Lane A's `ww.makeFast(lockId, p.id)` is called from the existing Moor key path: in the `T`/`quay_dock` handler (anchor
`case 'quay_dock': return quayDock(this, p, m);`) put first: `if (this.ww && p.lockStay && this.ww.makeFast(p.lockStay.lockId, p.id)) return this.sendYou(p);`.

**3e. Tick** — anchor in `tick(dt)`: the line `this.fleet.tick(dt);` Add before it:

```js
    if (this.ww) {
      this.ww.tick();
      for (const p of this.byId.values()) {
        if (!p.online || p.docked || p.rescue) continue;
        this.stepBallastFold(p, dt);
        const stay = this.ww.lockStay(p.id);
        p.lockStay = stay;
        if (stay) { p.ship.spd = Math.min(p.ship.spd, 1); continue; }   // held at the slot like docked; y = stay.y on the client
        const s = this.ww.strikeCheck({ ...p, Hs: this.weatherFor(p).waveH || 0 });
        if (s) this.onStrike(p, s);
      }
    }
```

with

```js
  stepBallastFold(p, dt) {
    const s = p.ship, warp = this.shipRate ? this.shipRate(p) : 1;
    if (Number.isFinite(s.ballastTarget) && s.ballastTarget !== s.ballastT)
      s.ballastT = ballastStep(s.cls, s.ballastT || 0, s.ballastTarget, dt * warp, { cargoT: p.cargo.reduce((a, c) => a + (c.qty || 0), 0), fuelT: p.fuel });
    if (s.foldOp && this.simTime >= s.foldOp.until) { s.fold = { ...(s.fold || {}), [s.foldOp.part]: s.foldOp.down ? 1 : 0 }; s.foldOp = null; this.sendYou(p); }
  }
  onStrike(p, s) {
    if (s.part === 'pier') return this.collision(p, { kind: 'bridge_pier', id: s.id });
    const d = s.damage;
    if (d.dismast) { this.rigEvent?.(p, 'dismast'); }
    if (d.antennaMul < 1) p.radioDamage = d.antennaMul;
    if (d.condLoss) p.cond = Math.max(0, p.cond - 100 * d.condLoss);
    if (d.teuLost) { p.cargo = d.after.cargo; p.money -= d.pollutionFine; }
    if (d.stop) { p.ship.spd = 0; p.ship.throttle = 0; }
    p.money -= s.fee;
    this.send(p, { t: 'strike', id: s.id, part: s.part, overlap: s.overlap, damage: d, fee: s.fee });
    this.event(p, 'warn', `Bridge strike (${s.part}, ${s.overlap.toFixed(2)} m): damage bill ${s.fee} credits.`, { lawHook: 'bridge_strike' });
    this.sendYou(p);
  }
```

`p.cargo` lines use `qty` tonnes (as today). `rigEvent('dismast')` is the sailing lane's hook (sails unusable, aux engine only).

**3f. Weather / sea state** — anchor in `weatherFor(p)`: `const w = this.weatherPublic(p.ship.lat, p.ship.lon);` →

```js
    const w0 = this.weatherPublic(p.ship.lat, p.ship.lon);
    const w = this.shelter ? this.shelter.apply(w0, p.ship.lat, p.ship.lon) : w0;   // §4.11: sheltered water, open sea unchanged
```

The physics env reads the same values: wherever `stepAtSea` builds `env.sea` / `env.waveH` from `weatherPublic`/`weatherAt`,
pass them through `this.shelter.apply(...)` the same way. The chart's storm labels keep using `weatherAt` (unchanged).

**3g. `privateState(p)`** — anchor `weather: this.weatherFor(p), tide: this.tideFor(p.ship.lat, p.ship.lon),` add:

```js
      air: this.ww ? airPublic(p.ship.cls, { cargo: p.cargo, fuelT: p.fuel, ballastT: p.ship.ballastT || 0, ballastTarget: p.ship.ballastTarget ?? null, fold: p.ship.fold || {} }, this.weatherFor(p).waveH || 0) : undefined,
      water: this.ww ? (({ h, ref }) => ({ h: Math.round(h * 100) / 100, ref }))(waterLevelAt(p.ship.lat, p.ship.lon, this.simTime, { levels: this.levels })) : undefined,
      lockStay: p.lockStay || null,
      nextObjects: this.ww ? this.ww.verdicts(p, p.ship.lat, p.ship.lon, 3000).slice(0, 3) : undefined,
```

The client (`public/js/main.js` anchor `this.ocean.setLevel?.(this.tideLevel);`) uses `you.water.h` when present.

**3h. Warp** — anchor in `warpLimit(p)`: after `if (harbour) return { max: WARP.HARBOR_MAX, … };` add:

```js
    if (this.ww && !p.docked) {
      if (p.lockStay) return { max: 1, reason: 'Inside a lock chamber.', routeAbove: WARP.MAX_NO_ROUTE };
      const near = this.ww.verdicts(p, p.ship.lat, p.ship.lon, 2000);
      if (near.some((v) => v.verdict === 'opening' || v.verdict === 'tight' || v.verdict === 'never' || v.verdict === 'closed')) return { max: Math.min(5, top), reason: 'Bridge or lock within 2 km — 5× at most.', routeAbove: WARP.MAX_NO_ROUTE };
    }
```

and in `warpConditions(p)` (after the `if (p.docked || p.assist) return null;` line): `if (p.lockStay) return 'you are in a lock chamber.';`.

## 4. `server.js` routes

Anchor: `app.get('/api/world', …)`. Add after it:

```js
app.get('/api/ww', (req, res) => { const lat = +req.query.lat, lon = +req.query.lon, r = Math.min(15000, +req.query.r || 8000); if (!game.ww || !Number.isFinite(lat) || !Number.isFinite(lon)) return res.json({ objects: [] }); res.json({ objects: game.ww.statics(lat, lon, r), attribution: game.ww.attribution }); });
app.get('/api/ww/:id', (req, res) => { const o = game.ww?.get(req.params.id); if (!o) return res.status(404).end(); res.json({ object: game.ww.statics(...(o.p || [0, 0]), 1).find((x) => x.id === o.id) || o, state: game.ww.state(o.id) }); });
```

and add the attribution string `"Bridges & locks NL: © Rijkswaterstaat / Vaarweginformatie.nl (CC0)"` next to the existing
OSM attribution (wherever `/api/world` or the HUD credits are assembled).

`ww` deltas: in the game tick broadcast (wherever per-player pushes go), send `{ t: 'ww', ...game.ww.state(id) }` for objects
within 15 km of the player whose `rev` changed since the last push (keep `p.wwRev = Map(id → rev)`).

## 5. Route planner (`server/searoute.js`, `server/routeworker.js`, `server/routeworker-thread.js`)

The inland graph is plain data (`buildGraph` result: nodes, edges with polylines, objects) and is built once:

* `server/routeworker-thread.js` — anchor `const graph = buildGraph(world);` add after it:

```js
const { loadFis } = await import('./fis.js');
const inl = await import('./inland.js');
const fs = await import('node:fs');
const fis = process.env.SALTLINE_WW_OFF === '1' ? null : loadFis();
const levels = JSON.parse(fs.readFileSync(new URL('./waterworks/levels-nl.json', import.meta.url), 'utf8'));
const gates = JSON.parse(fs.readFileSync(new URL('./waterworks/seagates-nl.json', import.meta.url), 'utf8')).gates;
const inland = fis ? inl.joinSeaGates(inl.buildGraph(fis, { levels }), gates) : null;
```

  and in the message handler, anchor `const result = planRoute(world, graph, m.from, m.to, { ...(m.opts || {}), geom: geomFrom(m.ends) });` →

```js
    const sea = (a, b) => planRoute(world, graph, a, b, { ...(m.opts || {}), geom: geomFrom(m.ends) });
    const o = m.opts || {};
    const result = inland && o.inland && (o.inland.from || o.inland.to)
      ? inl.planWithSea(sea, inland, m.from, m.to, o.inland.ship, o.simTime, { fromInland: !!o.inland.from, toInland: !!o.inland.to })
      : sea(m.from, m.to);
```

* `server/routeworker.js` inline path (anchor `try { r = planRoute(this.world, this.graph, from, to, { ...opts, geom: opts.geom || this.geom }); }`)
  gets the same branch with an `inland` graph passed in the constructor options (`new RoutePlanner({ …, inland })`).
* `server.js` `/api/route` (anchor the `r = await routePlanner.plan(q.from, q.to, { toHarbor: …` line): add
  `inland: game.ww ? inlandEnds(q.from, q.to, C) : null` where

```js
const inlandEnds = (from, to, C) => {
  const inl = (pt) => { const m = wt.maskAt(pt.lat, pt.lon); return m === WT.MASK.RIVER || m === WT.MASK.LOCK || m === WT.MASK.DOCK || waterLevelAt(pt.lat, pt.lon, 0, { levels: LEVELS_NL }).ref === 'canal'; };
  const f = inl(from), t = inl(to); if (!f && !t) return null;
  return { from: f, to: t, ship: { L: C?.length || 0, B: C?.beam || 0, T: C?.draft || 0, need: (C ? profileOf(C.id).kTop - profileOf(C.id).tDesign : 0) + 0.3, sail: !!C?.sail, kn: C?.maxKn ? 0.8 * C.maxKn : 8 } };
};
```

  (for a live ship use `airDraftNow` with its loading instead of the class numbers). The answer is RouteV2-compatible:
  `points`, `distM`, `marks` (+ `{kind:'bridge'|'lock'|'sea_gate', id, name, action, vhf, clr, need, waitMin, windowFrom/To}`),
  `warnings` (`standing_mast`, `tide_window`), `eta`, `label`.

## 6. Physics / client hooks that only read lane A data

* `public/js/main.js` anchor `if (you.tide) { this.tide = you.tide; this.tideLevel = Number(you.tide.height) || 0; this.ocean.setLevel?.(this.tideLevel); }`
  → `const lvl = you.water ? you.water.h : Number(you.tide?.height) || 0;` and `setLevel(lvl)`; tide panel shows
  "Canal level (no tide)" when `you.water.ref === 'canal'`.
* Grounding keeps the class draft (phase 2 flag `SALTLINE_LIVE_DRAUGHT=1`: use `you.air.T`).
* Lane B (radio): `ww.stationsOn(ch, lat, lon)`, `ww.request(id, p, etaS)`, `ww.registerLock(id, p, side)`, `ww.onEvent(fn)`
  (`warn`, `opening`, `open`, `closing`, `closed`, `missed`, `admit`, `levelling`, `release`, `lost_turn`, `turnaround`,
  `standsopen`, `strike`, `out`). VTS sectors: `server/waterworks/vts-nl.json`.
* Lane C (3D): `ww_static` objects carry `line`, `spans[{a,b,mov,clr,clrO (−1 = unlimited),w,rec}]`, `datum`, `deckW`,
  `chambers[{axis,len,wid,gates}]`; `ww` deltas carry `spans[{st,t0,dur,frac}]`, `sig`, `chambers[{st,level,plan,sig}]`.
* Lane D: `loadFis().harbours` (994 FIS tourist harbours with long/short-stay places and fuel), `ww.objs` for reachability via
  `planInland` / `whyNot`.

## 7. Operator

* Refresh the data monthly: `node scripts/fetch-fis.mjs` (≈ 230 requests, ≈ 4 min, 1 req/s), commit
  `server/waterworks/nl-fis.json.gz` (≈ 450 KB). `--probe` prints the three reference objects.
* `levels-nl.json` pounds and `vts-nl.json` polygons are coarse (`approx: true`); refine as data arrives.
