# World detail streaming — client hooks (phase 1a, Lane B)

Companion to `docs/WORLD-DETAIL-STREAMING.md` §3.6.3 / §3.7. Lane B's client code is in and works **without** these
hooks; the hooks only add the camera focus, the `wt` push and the HUD credit. They touch files other lanes are editing
(`public/js/main.js`, `public/js/hud.js`), so they are written as search-anchored paste-ins (3 lines in `main.js`, one
method in `hud.js`). Apply them when the fleet lane has landed.

## What is already wired (no hook needed)

| File | What |
|---|---|
| `public/js/wtmesh.js` (new) | pure builders: `buildTerrain`, `buildStructures`, `buildTile`, `terrainIndex`, `tileSDF`, `quayRuns`, `placement`, budgets (`BUDGET`) — no `three`, no DOM; used by the worker and `test/wtmesh.test.mjs` |
| `public/js/wtworker.js` (new) | module worker: SLWT bytes → decoded tile + typed arrays (transferred) |
| `public/js/wtiles.js` (new) | `WorldTileSet` (rings, fetch ≤ 4 in flight with ETag revalidation, worker builds, LRU / geometry budgets, morph-in, clip rectangles, shore-foam field, `heightAt` / `heightAtC11` / `maskAt` / `sdfAt` / `entryNear`, `onPush`, `attribution()`, `loading()`, `stats()`) |
| `public/js/terrain.js` | `Terrain` creates `this.wtiles` (a `WorldTileSet` under its group) and drives it from `update()`; the coarse L0/L1 materials are clipped under attached D14/C11 meshes; `heightAt` follows the server stack: patch → D14 → L1 → C11 (outside L1) → L0; patches hide D14 inside their footprint; `setOrigin` re-places tiles. `update(lat, lon, camera)` takes an optional camera |
| `public/js/collision.js` | `setWorldTiles(ws)` (called by `WorldTileSet`); `resolveShip` / `pointBlocked` use `geoms.sdfAt(…) ?? worldTiles.sdfAt(…)` |

Without the hooks the detail focus is the ship (fine in chase view), the `wt` push is ignored (a changed tile is
picked up the next time it is fetched) and nothing is shown in the HUD.

Off switch for players / tests: `?wt=0` in the URL or `localStorage['saltline.wt'] = '0'`. Live numbers:
`app.terrain.wtiles.stats()` in the console.

## 1. `public/js/main.js`

### 1.1 Camera focus + HUD credit — in `loop()`

Find

```js
    if (now - this.lastTerrainUpdate > 500) { this.lastTerrainUpdate = now; this.terrain.update(this.ship.lat, this.ship.lon); this.updateScenery(); }
```

and replace it with

```js
    if (now - this.lastTerrainUpdate > 500) { this.lastTerrainUpdate = now; this.terrain.update(this.ship.lat, this.ship.lon, this.camera); this.updateScenery(); this.hud.setWorldDetail?.(this.terrain.wtiles?.attribution(), this.terrain.wtiles?.loading() || 0); }   // WORLD TILES: focus = where the camera looks; credit + loading dot
```

(`Terrain.update` turns the camera into the focus point — where its view ray meets the sea, ≤ 4 km ahead — and its
height: above 2 km only the ship's own D14 ring is kept.)

### 1.2 The `wt` push — in `onMessage(m)`'s `switch (m.t)`

After `case 'snap': this.onSnap(m); break;` add

```js
      case 'wt': this.terrain.wtiles?.onPush(m); break;                 // WORLD TILES: a tile near us changed revision → refetch (ETag)
```

### 1.3 (optional, later) chart cursor as the focus

§3.7 also names "the cursor in chart view when zoomed under 5 km". The chart lives in `chart.js` (fleet lane); when
it exposes its centre and scale, call `this.terrain.wtiles.update({ lat, lon }, this.ship, { camH: 0 })` from the same
500 ms tick while the chart is open and zoomed in. Not needed for phase 1a.

## 2. `public/js/hud.js`

Paste this method into `class Hud` (e.g. right before `tickLog(now) {`):

```js
  /** World detail tiles (docs/WORLD-STREAMING-CLIENT-HOOKS.md): map-data credit + an amber "coast detail loading" dot. */
  setWorldDetail(attribution, loading) {
    if (!this.wdEl) {
      this.wdEl = document.createElement('div');
      this.wdEl.id = 'wdCredit';
      this.wdEl.style.cssText = 'position:fixed;right:8px;bottom:calc(4px + env(safe-area-inset-bottom));z-index:4;font:10px/1.3 system-ui,sans-serif;color:rgba(255,255,255,.75);text-shadow:0 1px 2px rgba(0,0,0,.8);pointer-events:none;max-width:62vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      if (matchMedia('(max-width: 700px)').matches) this.wdEl.style.bottom = 'calc(64px + env(safe-area-inset-bottom))';   // phone: above the tab bar
      document.body.appendChild(this.wdEl);
    }
    const dot = loading > 0 ? '<span title="Loading coast detail" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#f5b942;box-shadow:0 0 4px #f5b942;margin-right:5px;vertical-align:-1px"></span>' : '';
    const text = attribution ? String(attribution).replace(/&/g, '&amp;').replace(/</g, '&lt;') : '';
    const html = dot + text;
    if (html !== this.wdHtml) { this.wdHtml = html; this.wdEl.innerHTML = html; }
  }
```

The credit appears once a detail tile has been drawn (`wtiles.attribution()` returns `/api/wt/meta`'s attribution:
"© OpenStreetMap contributors · OpenMapTiles · OpenFreeMap · Terrain: Mapzen/AWS (ETOPO1, GEBCO…)"); the dot shows
while tiles inside the near ring are still on their way. Bottom-right, under the radar, `pointer-events: none`; it was
checked at 1280×800 and 390×844. Move it into the HUD's own stylesheet whenever convenient.

## 3. Checks after applying

* `npm test` (includes `test/wtmesh.test.mjs`).
* Browser: open the game, sail or `fleet_debug place` (with `SALTLINE_DEBUG=1`) to a fixture port; `app.terrain.wtiles.stats()`
  shows `d14 > 0`, `loading 0`; the credit line is at the bottom right; `?wt=0` gives the previous look.
* Lane B's browser checks ran with exactly these edits applied to copies of the two files (served in place of the
  originals), so the anchors above match the tree as of 2026-10-08.
