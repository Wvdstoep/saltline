# Saltline — world detail streaming (accurate coasts, docks, quays and buildings everywhere)

Status: **design / build contract** (2026-10-08). Nothing here is built yet. Owner of this file: the design lane.
Builds on: `server/world.js` (raster), `server/harborgeom.js` (4.48 km harbour patches), `server/bigports.js` (9 big
European ports carved from OSM), `server/harbors-world.js` (~336 harbours worldwide), `server/maptiles.js` (OSM raster
drape proxy), `public/js/terrain.js` / `harbor.js` / `harborgeom.js` / `collision.js`.

---

> **Phase 0 result (2026-10-08 18:20 UTC, probed from production):** OpenFreeMap reachable — TileJSON 200 in 0.11 s
> (`https://tiles.openfreemap.org/planet/20261004_113936_pt/{z}/{x}/{y}.pbf`), Antwerp z14 tile 200, 12.9 kB, 0.15 s,
> layers water/waterway/building/landuse/transportation/park. AWS Terrarium tile 200 (1.0 s). Overpass reachable (used
> today). **Decision: OpenFreeMap primary** as designed. The dev container cannot reach it: record fixtures on production.

## 1. What the player gets (plain words)

**The question:** "What happens with the big ports, what is the difference, will it be precise? It should be accurate
everywhere in the world — prefetch and show what is close to the ship and the camera."

**Answer, short:**

* **Now (after the big-ports fix):** 9 big ports in Europe (Antwerp, Rotterdam, Hamburg, Amsterdam, Bremerhaven,
  Le Havre, Zeebrugge, Gothenburg, Felixstowe) get their real rivers and docks, and several harbour maps each. The other
  ~330 harbours get **one** 4.5 km harbour map. Between harbours, outside the North Sea, the coast is made of 5 km
  blocks. Sail 5 km away from a harbour in Singapore or Santos and the coast is a rough guess.
* **After this plan:** the **whole world** is cut into small squares of about 1.5–2.5 km. The server downloads the real
  map data (OpenStreetMap) for the squares **around your ship and around where your camera looks**, a bit ahead of
  where you are going, and around every harbour. One download is shared by all players and kept on the server's disk.
  * The coast, rivers, canals and docks follow the real shape to about **5–10 m**, in every port and between ports.
  * Quays are hard concrete walls, beaches are slopes, breakwaters are rock piles, piers stand where they really are.
  * Buildings appear with their real shape and (where the map knows it) their real height. Cranes, tanks, bridges,
    locks, lighthouses and buoys appear where they really stand.
  * Real AIS ships that are moored lie **against the quay**, not in the middle of the water.
  * Your ship runs aground on the real coast, and the autopilot and the express passage use the same real coast.
  * When you arrive somewhere new, you first see the rough coast (never a hole), and it sharpens within a few seconds.
* **Honest limits:** water depth inside ports is an **estimate** (free maps do not include the real dredged depths,
  so docks get typical depths for the port's size; the open sea uses a real but coarse depth map). Building heights are
  estimated where the map has no height. Places that are badly mapped in OpenStreetMap look plainer. If the map
  server is down, places you have not visited before stay rough until it is back; everything already downloaded keeps
  working.

| | Today | After the 9-big-ports fix | After this plan, phase 1 | After phase 2–3 |
|---|---|---|---|---|
| Coast between harbours (outside North Sea) | 5.5 km blocks | 5.5 km blocks | real shape ~6–10 m near ships/camera | same |
| North Sea coast | 550 m blocks | 550 m, 9 ports carved | real shape ~6 m | same |
| Big 9 ports | 1 patch, coarse river | many patches, real docks | real everywhere in the port | same |
| Other ~330 harbours | 1 patch, OSM if Overpass answered, else invented | same | patch built from the real tile data, always real | + any quay outside the harbour list |
| Buildings | inside patches only (≤ 300) | same | inside patches (from tiles, no 300 cap) | everywhere near the camera, with heights |
| Cranes / bridges / locks / lights | patches only, partly | same | patches | everywhere near the camera |
| Moored AIS ships | float off the quay outside patches | better in 9 ports | against the quay in every listed harbour | against any quay in the world |
| Inland waterways | none | Elbe/Scheldt/NZK only | rivers/canals visible where mapped | navigable, locks, bridge clearance |

---

## 2. Data sources

### 2.1 What this machine could reach (probed 2026-10-08, one request per host, ≤ 10 s timeout)

This design sandbox sits behind an egress allow-list, so most hosts answered **403 at the proxy** — this says nothing
about whether production can reach them. Production *does* already reach `overpass-api.de` / `overpass.kumi.systems`
(`scripts/fetch-port-water.mjs` was run there) and `tile.openstreetmap.org` (`server/maptiles.js`). **Phase 0 step 1
re-runs the probe on production** (`scripts/probe-world-sources.mjs`, §9) before anything is built.

| Host | From here | Measured |
|---|---|---|
| `s3.amazonaws.com/elevation-tiles-prod/terrarium/…` (AWS Terrain Tiles) | **200** | z0 tile 106 KB in 0.78 s; z12 tiles 0.7–83 KB |
| `overturemaps-us-west-2.s3.amazonaws.com` (Overture releases) | **200** (listing) | release `2026-09-23.1` latest; sizes below |
| `overturemaps-tiles-us-west-2-beta.s3.amazonaws.com` (Overture PMTiles) | 403 (bucket not listable / path unknown) | — |
| `overpass-api.de`, `overpass.kumi.systems` | blocked here | used by production today |
| `tiles.openfreemap.org` | blocked here | must be probed on production |
| `build.protomaps.com`, `osmdata.openstreetmap.de` | blocked here | — |
| `rest.emodnet-bathymetry.eu`, `coastwatch.pfeg.noaa.gov` (ERDDAP), `www.gebco.net` | blocked here | — |
| `tile.openstreetmap.org`, `tiles.openseamap.org` | blocked here | used by production today |

Terrarium depth decoded at sample points (z12, `elev = R·256 + G + B/256 − 32768`):

| Point | Terrarium | Reality | Verdict |
|---|---|---|---|
| North Sea 20 km off Hook of Holland (52.05, 3.70) | −21.0 m | ~−20 m | good at sea |
| Rotterdam Amazonehaven (51.968, 4.035) | +1.9 m | dock, ~−20 m | **useless in ports** (land DEM) |
| Nieuwe Waterweg (51.905, 4.17) | +1.4 m | ~−16 m | useless in channels |
| Antwerp Deurganckdok (51.285, 4.26) | +2.2 m | ~−17 m | useless |
| Singapore anchorage (1.24, 103.85) | 0.0 m | ~−20 m | void |
| Santos channel (−23.98, −46.30) | +10.0 m | ~−15 m | wrong |
| Ambrose Channel NY (40.50, −73.97) | 0.0 m | ~−16 m | void |

Conclusion: bathymetry grids are good for the **open sea** only. Inside ports, rivers and channels the depth must come
from the OSM *class* of the water (dock / fairway / river / canal) plus port size (§3.4.3).

Overture release `2026-09-23.0` sizes (listed from the bucket): `buildings/building` 512 files **276.9 GB**,
`base/water` 64 files 28.2 GB, `base/land` 69 files 29.8 GB, `base/infrastructure` 32 files 13.0 GB,
`base/bathymetry` 1 file 0.05 GB — all **zstd GeoParquet**.

### 2.2 Evaluation

| Source | Licence | Key / limits | Coverage & detail | Size / latency | Usable on Node 20, no deps? | Verdict |
|---|---|---|---|---|---|---|
| **OpenFreeMap** public vector tiles (OpenMapTiles schema, `tiles.openfreemap.org/planet/<version>/{z}/{x}/{y}.pbf`) | ODbL data (© OpenStreetMap), OpenMapTiles attribution | no key, no stated request limit; donation-funded single operator → must be polite and have a fallback | whole planet, weekly rebuild, z0–14; layers `water` (ocean from osmdata water polygons, lakes, rivers, docks), `waterway` (lines), `landuse`, `landcover`, `building` (`render_height`, `render_min_height`), `transportation` (`brunnel=bridge`, `class=pier` polygons/lines), `poi` | z14 tile typically 10–150 KB (gzip), ~100–300 ms | yes: MVT = protobuf; ~200-line decoder (`server/mvt.js`); gzip via `zlib` | **PRIMARY for base geometry** (if the production probe passes) |
| Overpass API (overpass-api.de, kumi) | ODbL | no key; fair use ≈ < 10 000 queries/day and < 1 GB/day per user, 2 slots per IP, 429 when exceeded; heavy queries 5–60 s | everything in OSM incl. `man_made=quay|breakwater|crane|lighthouse`, `seamark:*`, `waterway=lock_gate`, `bridge:movable`, `maxheight`, `depth` | 10 KB – 5 MB per bbox; 2–60 s | yes (already used: `server/osm.js`) | **not** viable as the only source for many players. Used as the **maritime overlay** (quays, breakwaters, cranes, locks, seamarks, lights, clearances) at a capped rate, and as **fallback B** for base geometry |
| Protomaps PMTiles (daily planet build, HTTP range requests) | ODbL | `build.protomaps.com` builds are meant to be *downloaded*, not hot-linked; ~120 GB planet | z0–15, schema has `water` kinds, `landuse kind=pier`, buildings with `height`, roads `is_bridge` | 2–3 range requests per tile (directory + tile) | yes: PMTiles v3 header/directory = varints, ~150 lines | **optional fallback A**: only if the operator self-hosts an extract (`SALTLINE_PMTILES_URL`, e.g. an S3/R2 object). Off by default |
| osmdata.openstreetmap.de land/water polygons | ODbL | no key; download only | coastline-exact ocean polygons, planet | `water-polygons-split-4326.zip` ≈ 0.9 GB | shapefile + zip parse is possible but big | **rejected at runtime** (OpenFreeMap's `water` layer is built from it). Optional later for a better *global coarse* raster (phase 4) |
| AWS Terrain Tiles (Terrarium PNG, `s3.amazonaws.com/elevation-tiles-prod`) | public (AWS Open Data; ETOPO1/GEBCO-class bathymetry, SRTM/GMTED land; attribution "Mapzen, …") | no key, S3 scale | global, ~1.8 km bathymetry (finer in some coastal regions), PNG 256² | 1–110 KB, < 1 s; **reachable from here** | yes: PNG inflate with `zlib` (≈ 40 lines, `server/png.js` already writes PNG) | **PRIMARY for open-sea depth** (z9 tiles ≈ 300 m px at 50°) |
| GEBCO 2025 grid | public domain-like (attribution) | download only (no tile API, WMS is images) | 15″ global (~460 m) | 4–8 GB file | GeoTIFF/NetCDF parsing — heavy | rejected at runtime; Terrarium is close enough for the game |
| EMODnet Bathymetry (Europe) | CC-BY 4.0 | WCS/REST, no key | 1/16′ (~115 m) European seas, includes some port surveys | small per request | yes (WCS GeoTIFF or REST JSON) | **phase 3 optional** improvement for European seas |
| NOAA (ENC S-57 / CRM / ETOPO 2022 via ERDDAP) | US public domain | ERDDAP throttles; ENC = ISO 8211 binary | US waters with real dredged channel depths | — | ISO 8211 parser is a project of its own | phase 4 optional (US dredged areas) |
| Overture buildings / base | ODbL (+CDLA parts) | no key | best building coverage (ML footprints in Asia/Africa), heights | 277 GB zstd GeoParquet; Node 20 `zlib` has **no zstd** (added in Node 22.15) | **no** | rejected at runtime; optional offline enrichment later |
| Mapbox / MapTiler / Esri / Google 3D Tiles | proprietary | keys, paid tiers, ToS forbid caching/derived physics data | — | — | — | **rejected** |

### 2.3 Decision

* **Base geometry (land/water, docks, rivers, buildings, piers, bridges): OpenFreeMap z14 vector tiles**, fetched by the
  server, decoded by our own MVT decoder, cached on disk as compact game tiles. Why: free, no key, no request quota,
  planet-wide, weekly fresh, **one HTTP GET per 1.5–2.5 km square** (Overpass needs a 5–60 s query per area and has a
  daily quota), the version is in the URL (determinism, §7.3), and it is the same OSM data the game already uses.
* **Maritime overlay (quays, breakwaters, cranes, locks/gates, lights, seamarks, bridge clearances, dredged areas):
  Overpass**, one query per **z12** square (≈ 6–10 km) only where there is coast **and** a harbour or a ship nearby,
  ≤ 1 request in flight, ≥ 3 s apart, ≤ 1 500/day, cached 60 days. The tile is usable without it (§4.4.6).
* **Open-sea depth: AWS Terrarium z9**; in OSM-classified port water the class depth wins (§3.4.3).
* **Fallback A** (opt-in): self-hosted Protomaps PMTiles extract (`SALTLINE_PMTILES_URL`). **Fallback B**: Overpass
  "base query" per z14 tile through the same converter (≈ 1 tile / 4 s, harbours and own ship only). **Fallback C**
  (always): today's raster + harbour patches — the game never shows a hole and never blocks on the network.
* **Go / no-go:** if the production probe cannot reach OpenFreeMap, phase 1 still ships with Fallback B as the primary
  (slower first visits, same file formats) and the operator is asked to publish a PMTiles extract.

---

## 3. Architecture

### 3.1 The layers (coarse → fine)

| Level | What | Cell size | Source | Who uses it |
|---|---|---|---|---|
| L0 `global` (exists) | raster, whole earth | 0.05° (~5.5 km) | Natural Earth 50 m | route planning at sea, world chart, far terrain |
| L1 `region` (exists) | raster, North Sea window, big ports carved | 0.005° (~550 m) | NE 10 m + `bigports` | same, in the North Sea |
| **C11 coast tiles** (new) | Web-Mercator z11 tiles, 256² cells | 19.6 km·cos φ / 256 → 76 m (equator), 47 m (52°) | OpenFreeMap z11 `water` + Terrarium z9 | mid-distance terrain mesh 3–30 km; coarse fallback outside L1 |
| **D14 detail tiles** (new) | Web-Mercator z14 tiles, 256² cells + vectors | 2 446 m·cos φ / 256 → 9.6 m (equator), 5.9 m (52°), 4.8 m (60°) | OpenFreeMap z14 + Overpass overlay + Terrarium | physics near ships, terrain + buildings near the camera, harbour patch input |
| Harbour patches (exist) | 448² × 10 m about each harbour | 10 m | **rebuilt from D14** (phase 1b) | berths, fairway, tugs, berth guidance, street layer, ashore |

Web Mercator is conformal, so a tile is square in metres; the scale is taken at the tile centre (the error over 2.5 km
is < 0.05 %). Tiles exist only for |lat| ≤ 85.0511°; beyond, L0 is used.

### 3.2 Tile file format `SLWT` — `shared/wtformat.js` (verbatim contract)

One module shared by server, client and the client worker. Logic may be optimised; **names, signatures and bytes may
not change** without bumping `WT.FORMAT`.

```js
// shared/wtformat.js — Saltline world tiles (docs/WORLD-DETAIL-STREAMING.md §3.2). Plain ESM, no deps.
export const WT = {
  FORMAT: 1,
  MAGIC: 0x54574c53,            // bytes 'S','L','W','T' read as little-endian u32
  HEADER_BYTES: 40,
  Z_DETAIL: 14, Z_COAST: 11, Z_OVERLAY: 12, Z_BATHY: 9,
  N: 256,                       // cells per tile edge (both levels)
  LAT_MAX: 85.0511,
  EARTH_CIRC: 40075016.686,
  FLAG: { UNIFORM: 1, UNIFORM_LAND: 2, OVERLAY: 4, FALLBACK: 8, NO_VECTORS: 16 },
  // 0..6 are identical to PATCH.MASK (shared/constants.js) so patch code can read tile masks unchanged
  MASK: { WATER: 0, LAND: 1, QUAY: 2, BREAKWATER: 3, PONTOON: 4, FAIRWAY: 5, SHALLOW: 6, DOCK: 7, RIVER: 8, LOCK: 9, BUILDING: 10 },
};
export const WT_NAVIGABLE = Uint8Array.from([1, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0]);
export const WT_OBSTACLE = Uint8Array.from([0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 1]);
const D2R = Math.PI / 180, R2D = 180 / Math.PI;

/** Heights in metres → u8. 0.25 m steps within ±24 m (ships, quays, docks), 4 m steps beyond (−152 … +148 m). */
export function encodeWTHeight(h) {
  let v = h >= -24 && h <= 24 ? 128 + h * 4 : h < -24 ? 32 + (h + 24) / 4 : 224 + (h - 24) / 4;
  v = Math.round(v);
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
export function decodeWTHeight(v) { return v >= 32 && v <= 224 ? (v - 128) / 4 : v < 32 ? -24 + (v - 32) * 4 : 24 + (v - 224) * 4; }

export const tileKey = (z, x, y) => `${z}/${x}/${y}`;
/** Metres per tile edge at a latitude. */
export function tileSizeM(z, lat) { return (WT.EARTH_CIRC * Math.cos(lat * D2R)) / 2 ** z; }
/** Fractional tile coordinates (x east, y south) of a point. */
export function tileF(z, lat, lon) {
  const n = 2 ** z, la = Math.max(-WT.LAT_MAX, Math.min(WT.LAT_MAX, lat)) * D2R;
  return { fx: ((lon + 180) / 360) * n, fy: ((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2) * n };
}
export function tileFToLatLon(z, fx, fy) {
  const n = 2 ** z;
  return { lat: Math.atan(Math.sinh(Math.PI * (1 - (2 * fy) / n))) * R2D, lon: (fx / n) * 360 - 180 };
}
/** Tile and continuous cell coordinates (cell centre of (i, j) at u = i + 0.5, v = j + 0.5). */
export function cellOf(z, lat, lon, N = WT.N) {
  const { fx, fy } = tileF(z, lat, lon);
  const x = Math.floor(fx), y = Math.floor(fy);
  return { x, y, u: (fx - x) * N, v: (fy - y) * N };
}
export function cellLatLon(z, x, y, i, j, N = WT.N) { return tileFToLatLon(z, x + (i + 0.5) / N, y + (j + 0.5) / N); }
/** Tiles whose square comes within radiusM of a point, nearest first: [{z, x, y, d}] (d = metres to the square). */
export function tilesInRadius(z, lat, lon, radiusM) {
  const { fx, fy } = tileF(z, lat, lon), s = tileSizeM(z, lat), r = Math.ceil(radiusM / s), n = 2 ** z, out = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const x = ((Math.floor(fx) + dx) % n + n) % n, y = Math.floor(fy) + dy;
    if (y < 0 || y >= n) continue;
    const ex = Math.max(0, Math.abs(fx - (Math.floor(fx) + dx + 0.5)) - 0.5), ey = Math.max(0, Math.abs(fy - (y + 0.5)) - 0.5);
    const d = Math.hypot(ex, ey) * s;
    if (d <= radiusM) out.push({ z, x, y, d });
  }
  return out.sort((a, b) => a.d - b.d);
}
export function fnv1a(u8, h = 2166136261) { for (let i = 0; i < u8.length; i++) { h ^= u8[i]; h = Math.imul(h, 16777619); } return h >>> 0; }

/**
 * Header (little endian, 40 bytes): u32 magic · u16 format · u8 z · u8 flags · u32 x · u32 y · u16 n · u16 rev ·
 * u32 srcHash · u32 builtAt (unix s) · u32 vecBytes · u32 contentHash (fnv1a of everything after the header) ·
 * i16 uniformDm (height of a uniform tile, decimetres) · u16 reserved.
 * Body: mask u8[n²] and height u8[n²] (row 0 = north, absent when UNIFORM), then vectors = UTF-8 JSON (§3.2.1).
 */
export function encodeTile(t) {
  const n = t.n || WT.N, uni = (t.flags & WT.FLAG.UNIFORM) !== 0;
  const vec = t.vectors ? new TextEncoder().encode(JSON.stringify(t.vectors)) : new Uint8Array(0);
  const body = uni ? 0 : 2 * n * n;
  const out = new Uint8Array(WT.HEADER_BYTES + body + vec.length), dv = new DataView(out.buffer);
  dv.setUint32(0, WT.MAGIC, true); dv.setUint16(4, WT.FORMAT, true); dv.setUint8(6, t.z); dv.setUint8(7, t.flags | 0);
  dv.setUint32(8, t.x, true); dv.setUint32(12, t.y, true); dv.setUint16(16, n, true); dv.setUint16(18, t.rev | 0, true);
  dv.setUint32(20, t.srcHash >>> 0, true); dv.setUint32(24, t.builtAt >>> 0, true); dv.setUint32(28, vec.length, true);
  dv.setInt16(36, Math.round((t.uniformH || 0) * 10), true);
  if (!uni) { out.set(t.mask, WT.HEADER_BYTES); out.set(t.height, WT.HEADER_BYTES + n * n); }
  out.set(vec, WT.HEADER_BYTES + body);
  dv.setUint32(32, fnv1a(out.subarray(WT.HEADER_BYTES)), true);
  return out;
}
export function decodeTile(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.length < WT.HEADER_BYTES || dv.getUint32(0, true) !== WT.MAGIC) throw new Error('not an SLWT tile');
  if (dv.getUint16(4, true) !== WT.FORMAT) throw new Error('SLWT format ' + dv.getUint16(4, true));
  const flags = dv.getUint8(7), n = dv.getUint16(16, true), uni = (flags & WT.FLAG.UNIFORM) !== 0, body = uni ? 0 : 2 * n * n;
  const vecBytes = dv.getUint32(28, true), o = WT.HEADER_BYTES;
  return {
    z: dv.getUint8(6), x: dv.getUint32(8, true), y: dv.getUint32(12, true), flags, n, rev: dv.getUint16(18, true),
    srcHash: dv.getUint32(20, true), builtAt: dv.getUint32(24, true), contentHash: dv.getUint32(32, true),
    uniformH: dv.getInt16(36, true) / 10,
    mask: uni ? null : u8.subarray(o, o + n * n), height: uni ? null : u8.subarray(o + n * n, o + body),
    vectors: vecBytes ? JSON.parse(new TextDecoder().decode(u8.subarray(o + body, o + body + vecBytes))) : null,
  };
}
/** Bilinear height (m) inside one decoded tile at continuous cell coords; edges clamp. */
export function tileHeightAt(t, u, v) {
  if (!t.mask) return t.uniformH;
  const n = t.n, x = u - 0.5, y = v - 0.5, x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const g = (i, j) => decodeWTHeight(t.height[Math.max(0, Math.min(n - 1, j)) * n + Math.max(0, Math.min(n - 1, i))]);
  return (g(x0, y0) * (1 - fx) + g(x0 + 1, y0) * fx) * (1 - fy) + (g(x0, y0 + 1) * (1 - fx) + g(x0 + 1, y0 + 1) * fx) * fy;
}
export function tileMaskAt(t, u, v) {
  if (!t.mask) return t.flags & WT.FLAG.UNIFORM_LAND ? WT.MASK.LAND : WT.MASK.WATER;
  const n = t.n, i = Math.max(0, Math.min(n - 1, Math.floor(u))), j = Math.max(0, Math.min(n - 1, Math.floor(v)));
  return t.mask[j * n + i];
}
```

Invariants the converter guarantees: navigable cells have height ≤ −0.5 m (v ≤ 126), obstacle cells ≥ +0.25 m, so
`isWater = height < 0` agrees with the mask everywhere. Uniform tiles (all ocean / all land) are 40 bytes.

#### 3.2.1 Vectors (JSON inside the tile, D14 only)

Coordinates are **tile-local integers in decimetres**: x east from the tile's west edge, z south from the north edge
(same orientation as the game frame), flattened `[x0, z0, x1, z1, …]`. Rings are closed implicitly. Every field is
optional; arrays may be empty.

```text
{ v: 1,
  src: "ofm:20261001_001001_pt",          // source + version the base came from
  ov:  "ovp:2026-10-08" | null,            // overlay date, null = no overlay yet
  quays:       [{ p:[…], side: 1|-1, k: "osm"|"derived", top: 3.0 }],      // side 1 = water on the right of p
  piers:       [{ r:[…], k: "pier"|"jetty", top: 2.5 }],
  breakwaters: [{ r:[…], top: 4 }],
  pontoons:    [{ r:[…] }],
  buildings:   [{ r:[…], h: 12.5, mh: 0, k: "shed"|"industrial"|"residential"|"commercial"|"office"|"other", e: 0 }],  // e = estimated height (1) or tagged (0)
  tanks:       [{ x, z, r, h }],
  cranes:      [{ x, z, k: "sts"|"portal"|"mobile"|"other", hdg, h }],
  bridges:     [{ p:[…], w, deck, clr, mov: 0|1, k: "road"|"rail"|"foot" }],  // clr = clearance (m) above MHW, estimated when e=1
  locks:       [{ r:[…], gates: [[x0,z0,x1,z1], …], name }],
  lights:      [{ x, z, k: "lighthouse"|"beacon"|"buoy", col, ch, h, iala }], // ch = light character "Fl(2)R.10s"
  areas:       [{ r:[…], k: "port"|"industrial"|"residential"|"commercial"|"grass"|"wood"|"sand"|"parking" }],
  depthSrc:    "bathy"|"class"|"mixed" }
```

Caps per tile: buildings 4 000 (largest first), vertices simplified with Douglas–Peucker 0.5 m (buildings) / 1 m
(water, quays), areas 600, lights 400. A Rotterdam-sized city tile stays under ~250 KB gzip.

### 3.3 Server pipeline

```
request(z,x,y,prio) ─► memory LRU ─► disk  data/world/tiles/f1/<z>/<x>/<y>.slwt.gz ─► fetch queue (by priority)
                                                                                  │
            ┌───────────────────── OpenFreeMap MVT (z14 / z11) ◄──────────────────┤
            │                       Terrarium PNG z9 (bathy, shared by 32² D14)  ◄─┤
            │                       Overpass overlay z12 (optional, later rev)   ◄─┘
            ▼
  worker_thread  wtconvert-thread.js : decodeMVT → convertTile → encodeTile → gzip
            ▼
  disk write (tmp + rename) → memory LRU → waiting HTTP requests / physics / patch builder
```

New server modules (all pure ESM, no npm deps, nothing throws to callers):

| File | Exports | Notes |
|---|---|---|
| `server/mvt.js` | `decodeMVT(u8) → {layers: {name: {extent, features: [{type, tags, geom}]}}}` | protobuf varint / zigzag, MoveTo/LineTo/ClosePath, polygon ring winding (exterior = clockwise in tile coords), `Value` types string/float/double/int/uint/sint/bool. ~200 lines |
| `server/wtsource.js` | `fetchBase(z,x,y)`, `fetchOverlay(z12x, z12y)`, `fetchBathy(z9x, z9y)`, `sourceInfo()`, `configureSources(opts)` | `fetchImpl` injectable; UA `Saltline/0.8 (+https://saltline.mavicpro-fan.my-app.engineer; world tiles)`; circuit breaker + negative cache (pattern of `server/maptiles.js`); pins the OpenFreeMap version from its TileJSON (`https://tiles.openfreemap.org/planet`) into `data/world/pin.json` |
| `server/wtconvert.js` | `convertTile({z, x, y, mvt, overlay, bathy, hints}) → tile object` (for `encodeTile`) | pure, deterministic; §3.4 |
| `server/wtconvert-thread.js` | worker entry | one worker; messages `{id, z, x, y, mvt, overlay, bathy, hints}` → transferable `Uint8Array` |
| `server/worldtiles.js` | `init({dataDir, offline, log})`, `request(z,x,y,prio) → Promise<tile|null>`, `get(z,x,y) → tile|null` (sync, memory only), `buffer(z,x,y) → Buffer|null` (gzip bytes), `heightAt(lat,lon)`, `maskAt(lat,lon)`, `landPenetration(lat,lon)`, `sdfAt(lat,lon)`, `ensureAround(lat,lon,radiusM,prio,{timeoutMs})`, `onSwap(fn)`, `stats()` | memory LRU + disk LRU + priority queue + overlay merge; sync queries return `null` when the tile is not in memory (callers fall through to coarse) |
| `server/worldstack.js` | `createWorldStack(world, {geom, wt}) → stack`, `geomFacade(geom, wt)` | the physics merge (§3.6) |
| `server/wtprefetch.js` | `startPrefetch({game, wt, harbors, routePlanner})`, `prefetchTick()` | the rings and the background warm-up (§4) |

Converter cost target (one worker thread, 1 of the 4 CPUs): MVT decode 2–10 ms, rasterise 512² supersample 5–15 ms,
depth + distance fields 5–10 ms, vector clip/simplify 5–20 ms → **≤ 60 ms per D14 tile** (city tiles ≤ 150 ms),
C11 ≤ 30 ms.

### 3.4 Conversion rules (`convertTile`)

#### 3.4.1 Land / water mask (D14 and C11)

1. Rasterise at 2× supersampling (512²) including the MVT buffer (OpenMapTiles tiles carry 64/4096 buffer), then
   reduce: a cell is water when ≥ 50 % of its 4 sub-cells are water. Water = `water` layer features of class
   ocean / lake / river / dock / (any other class except `swimming_pool`, `pond` < 2 000 m²).
2. `waterway` lines with class `river` / `canal` (no polygon) are stroked with `width` tag or defaults river 30 m,
   canal 20 m (D14 only; streams, ditches, drains are ignored). `brunnel=tunnel` waterways are ignored.
3. Water classes become mask codes: ocean/lake → WATER, river/canal → RIVER, dock (or water inside
   `landuse` port/industrial within 3 km of a harbour) → DOCK, overlay `waterway=lock` / `lock=yes` area → LOCK,
   overlay fairway / `seamark:type=fairway|dredged_area` → FAIRWAY.
4. Piers: `transportation class=pier` polygons → QUAY (lines: 8 m wide unless `width`); overlay `man_made=breakwater|groyne`
   → BREAKWATER (lines 12 m), `man_made=quay` lines → QUAY band 6 m on the land side, floating pontoons
   (`floating=yes`, `man_made=pontoon`) → PONTOON.
5. Buildings (D14): BUILDING inside footprints that lie on land (a footprint over water is a pier building → QUAY).
6. Specks: water bodies < 6 cells not connected to the tile edge and not tagged dock/lock are filled (ditches); land
   specks < 3 cells in water are kept only when tagged (mooring dolphins, beacons).
7. Big-port guard (until phase 3): inside a `bigports` bbox the converter also rasterises the shipped
   `server/bigports/<id>.json` water and ORs it with the tile water, so the hand-checked Elbe/Scheldt fairways can
   never close.

#### 3.4.2 Quay edges (where vertical walls are drawn and ships moor)

* From the overlay: every `man_made=quay` line and the water-facing edges of piers.
* **Derived** (works without the overlay, all over the world): trace the WATER/DOCK ↔ land boundary with marching
  squares, simplify (DP 2 m) and keep straight runs ≥ 30 m where any of: the water is DOCK; the land side lies inside a
  `landuse` port / industrial / commercial area; a pier or building is within 25 m. Everything else is natural shore
  (slope, beach colour). `top` = 3.0 m above MHW (mega/major ports 4.0 m).

#### 3.4.3 Depth (water cells), first rule that applies

1. Overlay explicit depth: `seamark:dredged_area:minimum_depth`, `depth`, `maxdraught` + 1 m, `seamark:depth_area` →
   that value.
2. FAIRWAY → by the nearest harbour's size within 25 km: mega 17 m, major 15 m, regional 11 m, minor 8 m, none 12 m
   (today's `FAIRWAY_DEPTH_M` = 16 fits).
3. DOCK / LOCK → mega 16 m, major 14 m, regional 10 m, minor 6 m, none 8 m (today's `KIND_DEPTH` dock = 15).
4. RIVER / CANAL → width > 300 m: 12 m; > 120 m: 8 m; else 4.5 m (CEMT class Va ≈ 3.5–4.5 m draught).
5. Sea / lake → Terrarium z9 bilinear when it is ≤ −3 m; else a shore ramp `max(1.5, min(25, 1.5 + 0.06 × d))`
   with d = metres to the nearest natural shore.
6. Shore ramp everywhere: within 30 m of a **natural** shore, depth ≤ `0.5 + 0.15 × d`; along a quay edge the depth
   stays constant up to the wall (berth pocket).
7. Land heights: quays `top`, breakwaters `top`, buildings' ground = quay/land height, other land
   `min(20, 1 + 0.02 × d)` (gentle; inland relief is left to the coarse raster).

All depths are below **mean low water** (the server already adds `tideAt`).

Seams: distance-based ramps use the MVT buffer (≈ 37 m at z14 equator), so ramps longer than the buffer can differ by
≤ 1 m across a tile edge. Accepted; tests check edge-row continuity within 1.5 m (§7).

#### 3.4.4 Building heights

`render_height` / `height` / `building:levels × 3.2 + 1` when tagged (`e = 0`). Otherwise estimated (`e = 1`) by kind
and footprint: shed/warehouse/industrial `clamp(6 + √area / 8, 8, 22)`, residential 9 m, commercial/office 14 m,
other 8 m; cap 300 m. Tanks: `man_made=storage_tank` / `silo` circles from the overlay, height `height` else
`clamp(0.8 × diameter, 10, 30)`.

#### 3.4.5 Cranes, bridges, locks, lights

* Cranes only from the overlay (`man_made=crane`, `crane:type`; container gantries along quays with `crane:type=
  container_crane|gantry_crane` → `sts`). **No invented cranes** (open question Q4).
* Bridges: `transportation brunnel=bridge` segments over water. Clearance `clr`: overlay `seamark:bridge:clearance_height`
  / `maxheight`… else estimated: motorway/rail over water wider than 300 m → 35 m, wider than 100 m → 15 m, else 6 m;
  movable (`bridge:movable`) → 6 m closed.
* Locks: overlay `waterway=lock_gate` nodes/lines snapped across the LOCK chamber; chamber ring from the LOCK area.
* Lights: `man_made=lighthouse`, `seamark:type=light_*|beacon_*|buoy_*` with `seamark:light:character|colour|period`;
  IALA region via `osm.ialaRegion`. These also feed the V7 seamark index (`server/seamarks.js`, V7 batch 1 §3.5).

#### 3.4.6 Revisions

A D14 tile is first written as **rev 0** from the base (+bathy) alone, `FLAG.OVERLAY` clear, so a ship or camera never
waits for Overpass. When the z12 overlay arrives, its 16 D14 children are re-converted as **rev 1** (`FLAG.OVERLAY`
set) and swapped atomically (§3.6.4). A tile that is not near any harbour or ship may stay at rev 0 forever.

### 3.5 Cache, memory and serving

**Disk** (`data/world/`):

```
data/world/pin.json                       {"ofm":"20261001_001001_pt","pinnedAt":…}
data/world/tiles/f1/<z>/<x>/<y>.slwt.gz    gzip(SLWT); f1 = WT.FORMAT
data/world/overlay/<x12>/<y12>.json.gz     compact overlay per z12 square (input to rev 1)
data/world/bathy/<x9>/<y9>.bin             256² Int16 decimetres decoded from Terrarium (128 KB, ≈ 18 KB gz)
data/world/index.ndjson                    {k, bytes, last, pin} appended; compacted on start
```

* Cap `SALTLINE_WT_CACHE_MB` default **1 536 MB** for tiles + overlays + bathy together. Eviction LRU by `last` when
  above 95 % down to 85 %, **except pinned** entries (harbour rings, ≤ 25 % of the cap). Index flushed every 60 s;
  at start the index is rebuilt from a directory walk if missing (≈ 1 s per 20 k files).
* Converter changes bump `CONVERTER_VERSION` (stored in the tile's `srcHash` input): old tiles keep serving until the
  new one is built (lazy, priority-ordered), so a converter deploy never causes a hole.
* **Raw MVT is not cached** (re-fetching is cheaper than the disk); the test fixtures keep a few on purpose.
* Expected sizes: uniform tile 40 B; coastal D14 15–60 KB gz; city/port D14 60–250 KB; C11 5–40 KB. 10 000 coastal
  D14 tiles (every harbour warmed, §4.4) ≈ 400–500 MB.

**Memory (server):** decoded tiles in an LRU of **500 entries** (mask + height = 128 KB each → 64 MB) plus an SDF
(`Int16`, 128 KB) only for tiles within 3 km of a ship (≈ 9 per ship → 20 ships ≈ 23 MB). If `rss > 1.2 GB` the LRU
shrinks to 200. Vectors stay gzip'd on disk; the server parses them only for the patch builder and the berth finder.

**Raster cache leak (finding):** `world.js` names its raster cache by the carvings hash and never deletes old ones;
this tree has **47 files / 813 MB** in `data/cache` (`global-0.05-v6-*.bin` 25 MB each, `region-0.005-v6-*.bin`
12.8 MB each, old `sea-routes-v1-*.json`). On a "few GB" production disk this must be fixed before tiles add their
1.5 GB: phase 1b adds `pruneRasterCache()` (keep only the files `World.load` just used, and the newest sea-routes file).

**HTTP** (`server.js`):

| Route | Answer |
|---|---|
| `GET /api/wt/meta` | `{format: 1, n: 256, zDetail: 14, zCoast: 11, src: "ofm:<ver>", attribution: "© OpenStreetMap contributors · OpenMapTiles · OpenFreeMap · Terrain: Mapzen/AWS (ETOPO1, GEBCO…)", offline}` |
| `GET /api/wt/:z/:x/:y` (z ∈ {11, 14}) | the gzip bytes with `Content-Encoding: gzip`, `Content-Type: application/octet-stream`, `ETag: "<srcHash>-<rev>-<contentHash>"`, `Cache-Control: no-cache` (revalidate → 304). Not yet built: the request **joins the queue at P0 and waits up to 6 s**, else `503` + `Retry-After: 2`. Out-of-range → 400. Source down and nothing cached → `404` + `X-WT: fallback` (the client keeps the coarse world) |
| `GET /api/wt/at?lat&lon` | debug: `{key, rev, flags, mask, height, src, ov}` |

**WebSocket push:** `{t: 'wt', k: '14/x/y', rev}` to players whose ship is within 6 km of a tile that changed
revision, so their client refetches (the ETag differs).

### 3.6 Physics: how tiles merge with the raster and the patches

#### 3.6.1 Precedence (server and client use the same order)

```
heightAt / depthAt / isWater / landPenetration(lat, lon):
  1. built harbour patch covering the point   (harborgeom, unchanged; patches are rebuilt FROM tiles in phase 1b)
  2. D14 tile in memory                        (worldtiles.heightAt)
  3. L1 region raster when inside it
  4. C11 tile in memory                        (outside L1 only; its coast beats 5.5 km cells)
  5. L0 global raster
```

`server/worldstack.js`:

```js
export function createWorldStack(world, { geom, wt }) {
  // Same surface as World (game.js, searoute.js, lanes.js, traffic.js, tugassist.js use these), plus detailAt.
  return {
    layers: world.layers, charts: world.charts,
    layerFor: (lat, lon) => world.layerFor(lat, lon),
    tile: (l, tx, ty) => world.tile(l, tx, ty), chartPNG: (l, s) => world.chartPNG(l, s),
    heightAt(lat, lon) { const h = wt.heightAt(lat, lon, { z: 14 }); if (h != null) return h; if (world.layers[1].contains(lat, lon)) return world.heightAt(lat, lon); const c = wt.heightAt(lat, lon, { z: 11 }); return c != null ? c : world.heightAt(lat, lon); },
    depthAt(lat, lon) { return -this.heightAt(lat, lon); },
    isWater(lat, lon) { return this.heightAt(lat, lon) < 0; },
    nearestWater(lat, lon, maxCells = 20) { /* D14 ring search (≤ maxCells × 10 m) with depth < -6 when the tile is loaded, else world.nearestWater */ },
    detailAt(lat, lon) { /* 'patch' | 'd14' | 'region' | 'c11' | 'global' — for the HUD and the tests */ },
  };
}
export function geomFacade(geom, wt) {
  // game.js calls this.geom.landPenetration / sdfAt / patchHeightAt; tiles answer where no patch does.
  return { ...geom, landPenetration: (lat, lon) => geom.landPenetration(lat, lon) ?? wt.landPenetration(lat, lon) };
}
```

`server.js` passes `createWorldStack(world, …)` as the game's `world` and `geomFacade(harborgeom, wt)` as its `geom`.
**`game.js` needs no change in phase 1a.** Patches keep precedence 1 inside their footprint, which they already have
in `game.landPenetration` and on the client.

Why the stack does **not** hide patches behind tiles: berths, fairways, tug paths, the berth guide, the street layer and
`ashore.js` are built on patches and tested; replacing them is phase 4. Phase 1b makes patches *consistent* with
tiles by building them from tile data (§8.2), so both precedence orders give the same coast.

#### 3.6.2 Determinism and "tile not loaded yet"

Sync physics queries never wait for the network: missing tiles fall through to the coarse layers. To keep the
authority consistent:

* **Ships of online players:** the prefetch ring (§4.1) keeps every D14 tile within ≥ 1.5 km of a ship in memory
  before the ship can reach it (at 22 kn a ship needs 130 s for 1.5 km; a tile takes < 1 s from disk, < 2 s from
  OpenFreeMap).
* **Express passage:** `game.expressPassage` already waits (8 s cap) for the destination's harbour patches
  (`expressPatchesToBuild`). Phase 1a wraps `geom.ensureHarbor` in `geomFacade` so the same wait also covers
  `wt.ensureAround(dest, 3000, P0)`; the safe-spot search (`expressArrival`) then sees the real coast.
  Simpler alternative with a one-line `game.js` edit (phase 1b): call `this.geom.ensureWorld?.(lat, lon)` next to
  `expressPatchesToBuild`.
* **Route planning** (`searoute.js` / `routeworker-thread.js`): the planner must not give different answers depending
  on cache luck. Rule: `/api/route` first runs `wt.ensureAround` for the start and destination (radius 4 km, 3 s cap,
  the same pattern as the existing `ensureHarbor(q.toHarbor)` 3 s wait in `server.js`), then plans with the stack.
  The worker thread receives the gzip D14 buffers of the tiles within 6 km of both ends next to the patch buffers
  (phase 2). Open-sea legs stay on L0/L1 + lanes (already validated).
* **Tow spots, safe spots, AI traffic:** unchanged API, now with detail where loaded; their checks are conservative
  (depth ≥ draft + margin, 1.5 km clear) so coarse/detail disagreement only moves a spot, never makes it unsafe.

#### 3.6.3 Grounding and collision

* Server: `game.onState` already rejects positions with `landPenetration`/shallow depth; the facade makes D14 quays,
  piers, breakwaters and buildings-on-quays count (mask codes 1–4, 10 via `WT_OBSTACLE`). SDF per tile is built on
  load with the same EDT as `harborgeom.distanceTransform`, plus a 16-cell apron read from loaded neighbours
  (recomputed when a neighbour arrives, debounced 2 s).
* Client: `collision.js` asks `geoms.sdfAt`; phase 1a adds a `WorldTileSet` with the same `sdfAt / heightAt /
  maskAt / entryNear` surface and `collision.js` queries `geoms.sdfAt(…) ?? wtiles.sdfAt(…)`.

#### 3.6.4 Tile swaps under a ship (grace rule)

When a tile arrives or changes revision (`wt.onSwap`), `server.js` (no `game.js` edit) checks every ship of every player
inside it: if `stack.landPenetration > 0` or depth < draft at low water, the ship is moved to
`stack.nearestWater` (≤ 300 m, depth ≥ draft + 1 m), `p.lastValid` is reset to the new spot, speed zeroed,
`game.sendYou(p, {correction: true})` and `game.event(p, 'info', 'Chart corrected: your position was moved X m to open
water.')`. **No damage, no grounding** is ever charged within 30 s of a swap of the tile under the ship
(`wt.swappedAt(lat, lon) > now − 30 000` → `game.grounding` is skipped via the facade's `landPenetration` returning
`null` for that window). Docked ships are not moved (the berth is checked at undock, §8.3).

#### 3.6.5 Other systems

| System | Today | With tiles |
|---|---|---|
| Berth guidance / docking | patch berths (`nearestBerth`) | patch berths, patches from tiles (phase 1b); phase 3: `berthsFromQuays(tile)` gives berths on any quay in the world for the docking score and AIS-at-quay checks |
| Tugs (`tugassist.js`, `tugpath.js`) | patch SDF | unchanged (patch), patches built from tiles |
| Express safe spot | patch + raster depth | + D14 (ensured before the search) |
| AIS display | raw position | unchanged; with real quays the moored ships now touch the wall. Phase 2: if a moored AIS hull centre lies on a D14 obstacle, the client shifts it ≤ 25 m perpendicular to the nearest quay edge (display only) |
| Lanes graph (`lanes*.js`) | validated on L0/L1 | unchanged |
| Weather / tides | — | unchanged |

### 3.7 Rendering (client)

New modules (Lane B):

| File | Role |
|---|---|
| `public/js/wtiles.js` | `class WorldTileSet { update(focus, ship, opts); get(z,x,y); heightAt; maskAt; sdfAt; entryNear; onReady(fn) }` — chooses rings, fetches `/api/wt/…` (≤ 4 in flight, nearest first, AbortController on unload), decodes with `shared/wtformat.js`, handles the `wt` WS push, keeps a 400-tile decoded cache (mobile 150) |
| `public/js/wtworker.js` | module worker: `buildTerrain(tile, lod, neighbourEdges) → {pos: Float32Array, nrm, col, idx}` and `buildStructures(tile, lod) → {walls, roofs, quays, breakwaters, piers, bridges, instances: {cranes, tanks, bollards, lights, trees}}` as transferable typed arrays. **Import maps do not apply inside workers**, so the worker imports only `/shared/wtformat.js` and never `three` |
| `public/js/wtmesh.js` | wraps worker output into `BufferGeometry` / `InstancedMesh` with the shared materials of `harbor.js` (concrete, rubble, roofs, crane colours, facade textures), places meshes in the floating-origin frame, disposes |

Edits (Lane B): `public/js/terrain.js` (sink coarse tiles under a ready D14 tile like it does for patches; height lookup
order of §3.6.1; C11 tiles as a new mid ring), `public/js/main.js` (create `WorldTileSet`, call `update` from the 500 ms
terrain tick with ship + camera focus, attribution), `public/js/collision.js` (fallback to tile SDF), `public/js/hud.js`
(attribution line, "detail loading" dot).

**Rings around the camera focus** (the ship in chase view, the look-at point in free/orbit view, the cursor in chart
view when zoomed under 5 km):

| Ring | Desktop | Mobile / `halfRes` | Content |
|---|---|---|---|
| D14 near | ≤ 1.2 km | ≤ 0.8 km | terrain LOD 256, all buildings with facades, quay furniture (bollards/fenders instanced), cranes, lights, bridges |
| D14 mid | 1.2–3.5 km | 0.8–2.2 km | terrain LOD 128 (64 beyond 2.5 km), buildings as plain extrusions (no facade texture), buildings < 6 m dropped beyond 2.5 km, cranes/lights instanced, no furniture |
| C11 | 3.5–30 km | 2.2–18 km | terrain only (256² at 47–76 m), sunk under D14 tiles |
| L0/L1 | beyond, and under everything until finer data is ready | same | today |

Unload at 1.3× the ring radius (hysteresis). Camera height > 2 km above sea → no D14. Patches keep precedence:
D14 terrain cells inside a ready patch footprint are sunk (patches are sharper inside: 10 m with dredged berths).

**Budgets:** desktop ≤ 150 MB of geometry + 25 D14 meshes, ≤ 600 draw calls for world detail (merge per tile per
material, instancing for repeated parts); mobile ≤ 50 MB, 9 D14 meshes, building cap 1 500 per tile, no facade
emissive at night. Worker builds ≤ 1 tile at a time (mobile) / 2 (desktop); a tile's meshes are attached in one frame.

**While loading — never a hole:** coarse tiles stay visible until the D14 mesh is attached in the same frame that sinks
them; the new terrain morphs from the coarse heights to the fine heights over 0.6 s (vertex shader `uMorph`),
structures fade in by scaling Y from 0 over 0.4 s. If `/api/wt` answers 404/fallback the coarse world simply stays.

**Floating origin:** worker output is relative to the tile's NW corner (float32 is exact to < 1 mm over 2.5 km); the
mesh's `position` is `toLocal(tileNW)` and is recomputed on `setOrigin` like patches.

**Map drape:** phase 2 reuses `terrain.js`'s `Drape` for D14 land cells within 1.2 km when ashore or the camera is
low (z16 OSM raster through the existing `/api/maptile` proxy); phase 1 uses vertex colours from `areas` (port grey,
residential beige, grass, wood, sand) and the derived shore class.

---

## 4. Prefetch

### 4.1 Priorities

The scheduler (`server/wtprefetch.js`, every 2 s, reads `game.byId`, the fleet ships, routes and express requests —
read-only) feeds `wt.request` with these priorities (lower = sooner). Within a priority, nearest first.

| P | Trigger | Area |
|---|---|---|
| P0 | a client GET for a tile; express destination; route ends | as asked |
| P1 | every **online** player ship | D14 within `r = max(1.5 km, 180 s × speed)`; C11 within 30 km |
| P1 | heading cone of every online ship under way | D14 along the course over ground to `min(12 km, 600 s × speed)`, ±1.5 km wide (tiles whose centre is within the cone) |
| P2 | autopilot / chart route of online players and **hired-captain fleet ships** | D14 within 1 km of the route for the next 30 min of sailing; C11 for the next 3 h |
| P2 | harbours with an online player or a fleet ship within 50 km | D14 covering the harbour core (patch footprint + 1 km, ≈ 3×3 to 5×5 tiles; big ports: their whole `core` box) + the z12 overlay |
| P3 | offline players' ships (they may log in) | D14 within 1 km |
| P4 | background warm-up, only when P0–P3 are empty and the source is healthy | every harbour in `HARBORS` (336 today) by size (mega → minor): C11 3×3, then D14 children of **mixed** C11 tiles inside 4 km of the anchor; then overlays. One harbour at a time |

**Hierarchical skip:** a C11 tile that is uniform water or land marks its 64 D14 children uniform without fetching
them (the open sea and inland areas cost nothing).

### 4.2 Budgets (defaults, env-overridable)

| Budget | Default | Why |
|---|---|---|
| OpenFreeMap requests in flight | 4 (`SALTLINE_WT_CONC`) | polite; ≈ 10–20 tiles/s possible |
| OpenFreeMap rate | ≤ 8 req/s burst, ≤ 40 000/day (P4 stops at 30 000/day) | far below what a CDN serves; the daily figure is a self-imposed politeness cap |
| Overpass overlay | 1 in flight, ≥ 3 s apart, ≤ 1 500/day, timeout 60 s, `Retry-After` honoured | well inside fair use (< 10 000/day) and leaves room for the harbour patch queries |
| Terrarium | 2 in flight; z9 covers 32×32 D14 tiles, so ≈ 1 fetch per region | tiny |
| Converter CPU | 1 worker thread; queue ≤ 200; P4 paused when the event-loop lag > 50 ms or load average > 3 | never slows the 10 Hz game tick |
| Disk | 1 536 MB cap (§3.5) | fits next to the 9.6 MB geom cache and a pruned 40 MB raster cache |
| Network | P1–P2 for 20 players sailing at 15 kn: ≈ 20 × 55 tiles/h ≈ 1 100 tiles/h ≈ 50 MB/h; warm-up of all harbours ≈ 12 000 requests ≈ 400 MB once, ≈ 2 h at P4 pace | small |
| Server RAM | ≤ 100 MB for decoded tiles + SDFs (§3.5) | |
| Client | ≤ 4 tile GETs in flight; ≤ 6 MB/min while sailing | mobile data friendly |

### 4.3 When the source is down

* Circuit breaker per host (as `maptiles.js`): 5 failures / 429 / 5xx in a row → open 60 s, doubling to 15 min;
  per-tile negative cache 10 min. `SALTLINE_WT_OFFLINE=1` (and `NODE_TEST_CONTEXT`) disables all upstreams.
* Everything on disk keeps serving, at any version. Nothing is evicted because of a failure.
* OpenFreeMap down → Fallback A (if configured) → Fallback B (Overpass base query, P0/P1 only, 1 tile / 4 s) → nothing:
  `/api/wt` answers 404 `X-WT: fallback`; physics and rendering use L0/L1/C11 + patches, exactly today's behaviour.
* OpenFreeMap pinned version deleted upstream (404 for every new tile while TileJSON advertises a newer one) → re-pin
  to the newest version (`pin.json`), keep all cached tiles (each is self-consistent and stamped with its own `src`).
* Overpass down → tiles stay at rev 0 (derived quays, no cranes/lights); harbour patches keep their cached OSM.

---

## 5. Correctness

### 5.1 Unit tests (offline, `node --test`, no network)

| File | Covers |
|---|---|
| `test/mvt.test.mjs` | a tiny MVT encoder in the test builds tiles; decode varints, zigzag, MoveTo/LineTo/ClosePath, multipolygons + holes, all value types, unknown fields skipped, truncated buffer → empty result (no throw) |
| `test/wtformat.test.mjs` | encode/decode round trip incl. uniform tiles; `encodeWTHeight`/`decodeWTHeight` monotonic, ≤ 0.125 m error in ±24 m; `tileF` ↔ `tileFToLatLon` round trip < 1 cm; `tilesInRadius` sorted and complete; `contentHash` stable |
| `test/wtconvert.test.mjs` | synthetic MVT: a rectangular dock in a port → DOCK cells, derived quay edges on its 4 sides with `side` pointing to water, dock depth by harbour size; a beach → natural shore ramp, no quay; river line without polygon → stroked width; building heights tagged/estimated; overlay quay/breakwater/lock/crane; **determinism**: converting the same input twice gives byte-identical output; **seams**: two neighbouring synthetic tiles agree on edge rows (mask identical, height within 1.5 m) |
| `test/worldtiles.test.mjs` | fake `fetchImpl`: priority order (P1 before P4), hierarchical uniform skip, one upstream fetch shared by 10 concurrent requests, 6 s wait then 503, LRU eviction keeps pinned tiles, index rebuild, circuit breaker + negative cache, stale serving when the source fails, re-pin on version 404, rev 0 → rev 1 swap fires `onSwap` once |
| `test/worldstack.test.mjs` | precedence patch > D14 > L1 > C11 > L0; `isWater` agrees with the mask; `landPenetration` through the facade; swap grace (no grounding within 30 s, ship moved to water ≤ 300 m, docked ships untouched); with `wt` offline every existing `world`/`geom` answer is unchanged (snapshot of 2 000 random points) |
| `test/wt-ports.test.mjs` | recorded fixtures (§5.2): sample points, moored-AIS-at-quay, big-port oracle agreement |

Existing suites (`world.test.mjs`, `world-coverage.test.mjs`, `express-safe.test.mjs`, `route-planner.test.mjs`,
`tugs*.test.mjs`, `berthguide.test.mjs`, …) must stay green **unchanged**; they run offline, where the stack falls
through to today's raster and patches.

### 5.2 Recorded fixtures (real data, recorded once on production)

`scripts/record-wt-fixtures.mjs` (run on production, where the sources are reachable) writes
`test/fixtures/wt/<port>/<z>-<x>-<y>.mvt.gz`, the z12 overlay and the z9 bathy for the tiles under the sample points
below, plus `points.json`. Budget ≤ 4 MB total. The recorder **prints each point's mask/depth for a human to confirm
on the OSM map before committing**; a point that fails is corrected (coordinates moved), never silently dropped.

Sample points (approximate; the recorder verifies them):

| Port (continent) | Must be water, deep enough (≥ m at MLW) | Must be land (terminal yard) |
|---|---|---|
| Rotterdam (EU) | Nieuwe Waterweg 51.905, 4.17 (≥ 14); Amazonehaven 51.968, 4.035 (≥ 14) | Maasvlakte container yard next to Amazonehaven (recorder picks the nearest `landuse=industrial` cell ≥ 150 m from water) |
| Antwerp (EU) | Deurganckdok 51.285, 4.26 (≥ 13); Scheldt off Doel 51.31, 4.27 (≥ 12) | Deurganck terminal yard (recorder picks) |
| Hamburg (EU) | Elbe at Övelgönne 53.545, 9.91 (≥ 12) | Burchardkai yard (recorder picks) |
| Singapore (AS) | Singapore Strait 1.20, 103.85 (≥ 15) | Pasir Panjang terminal yard |
| Shanghai Yangshan (AS) | channel between the islands 30.62, 122.07 (≥ 12) | Yangshan phase 4 yard |
| Santos (SA) | Santos channel −23.98, −46.30 (≥ 11) | Santos Brasil terminal yard |
| New York / New Jersey (NA) | Ambrose Channel 40.50, −73.97 (≥ 13); Kill van Kull 40.645, −74.10 (≥ 12) | Port Elizabeth yard |
| Houston (NA) | Houston Ship Channel at Morgan's Point 29.68, −94.99 (≥ 11) | Barbours Cut yard |
| Durban (AF) | harbour entrance −29.87, 31.05 (≥ 12) | Durban container terminal yard |
| Port Said / Suez Canal (AF) | canal 30.58, 32.33 (≥ 12) | — |
| Sydney Port Botany (OC) | Botany Bay approach −34.0, 151.2 (≥ 12) | Port Botany yard |
| Valparaíso or Callao (SA) | harbour basin | terminal yard |
| Gothenburg (EU) | Göta älv mouth 57.69, 11.84 (≥ 10) | Skandia terminal yard |

Assertions: every water point is navigable in the D14 mask with depth ≥ the given value; every land point is an
obstacle; the bathy-free points use class depths (§3.4.3).

**Moored AIS at quay** (`scripts/record-moored-fixture.mjs`, production, from the live AIS store): for ≥ 12 of the ports
above, all vessels with `nav = 5`, `sog < 0.3`, length known, within 5 km of the port → `test/fixtures/wt/moored.json`
(`{port, mmsi(hashed), lat, lon, hdg, A, B, C, D}`, no names). Test: for each vessel, the hull rectangle from
A/B/C/D is placed and the distance from its nearest long side to the nearest quay edge (OSM or derived) is computed.
Pass: **≥ 85 % within 25 m** and **≤ 3 % with the hull centre on an obstacle cell**, per port and overall. Today's
baseline (raster + patches) is printed next to it for the record.

**Big-port oracle:** inside each `bigports` core box, the D14 mask (without the guard of §3.4.1-7) and
`portWaterKind` agree on ≥ 93 % of 5 000 random points; every bigports fairway centreline point is navigable in D14.

### 5.3 Browser scenarios (manual / Playwright, after deploy)

1. Rotterdam, sail from the Maas entrance to Waalhaven: coast, docks, quays are walls, buildings with heights, cranes at
   Maasvlakte; no gap at patch/tile borders; moored AIS ships touch quays.
2. Antwerp Deurganckdok and the Scheldt bends at Bath: no "boxy" river, no AIS ship in open water off a quay.
3. Express passage Rotterdam → Singapore: on arrival the coarse coast shows at once, detail within 5 s, no hole, ship
   on water with room around it.
4. Santos and New York: same checks on other continents.
5. Phone (touch, `halfRes`) in Hamburg: ≥ 30 fps, JS heap < 400 MB, GPU memory within budget, no stall > 100 ms when
   tiles attach.
6. Two browsers at the same place: identical coast (compare `/api/wt/at` answers and screenshots of the chart overlay);
   both show the same tile `ETag`.
7. Server started with `SALTLINE_WT_OFFLINE=1`: the game looks and plays exactly like before this feature.
8. Kill the upstream mid-session (`SALTLINE_WT_CONC=0` hot flag or firewall): cached places stay sharp, new places stay
   coarse, no errors in the console beyond one warning.
9. Floating-origin reshift (sail 25 km) while tiles stream: no seams, no jumps.
10. A tile changes revision under a ship (overlay arrives): the ship is not damaged; if moved, the message says so.

### 5.4 Determinism and invalidation

* All players and the server read the **same bytes** for a tile: the server builds each tile once, stores it, serves it
  with an ETag of `srcHash-rev-contentHash`. The client never converts source data itself.
* `srcHash = fnv1a(source version string + CONVERTER_VERSION + overlay date)`. A converter change or re-pin produces new
  tiles lazily (§3.5); the old tile is served until the new one replaces it **atomically** (rename on disk, swap in
  memory, `wt` push), so a player never sees half-converted data.
* Neighbouring tiles may come from different source versions for a while; seams are bounded by the seam test (§5.1).
* `pin.json` changes only by re-pin (upstream deleted the version) or an operator command
  (`node scripts/wt-repin.mjs`); at most monthly by default (Q2).

---

## 6. Migration (no broken saves, no broken routes)

### 6.1 Saved state

* Player positions in `data/state.json` are lat/lon and stay valid. On **login** (and on server start for ships at
  sea) the ship's tiles are requested at P0; when they arrive the swap rule (§3.6.4) moves a ship that now sits on land
  to water ≤ 300 m away, else to `game.spawnPointNear(nearest harbour)`, with a message. No money, cargo or condition
  changes.
* Docked ships keep `p.docked`; berths come from patches (phase 1b rebuilds patches from tiles, berth ids are derived
  from quay order and can change): if the saved berth id no longer exists, `startBerth` already picks a fitting berth
  of that harbour — this is tested in `worldstack.test.mjs` with a fake rebuilt patch.
* Accepted contracts with tow casualties go through `ensureTowSpot` (already moves casualties off land).

### 6.2 Routes and lanes

* Autopilot / chart routes saved on ships: on login and when a tile under a route leg swaps, legs within the next 20 km
  are re-validated with the stack (`isWater` every 50 m and depth ≥ draft + 1 at MLW); a failing leg triggers the
  existing route planner from the ship's position to the route's destination (one replan, the old route kept until
  the new one is ready). Fleet ships (hired captains) get the same check.
* The lane graph and `data/cache/sea-routes-*.json` remain built on L0/L1 (unchanged hashes); the route table is
  unaffected.

### 6.3 Raster, patches, big ports

* `world.js` rasters stay (L0/L1 routing, charts, coarse terrain). Their cache versions do not change in phase 1.
* `harborgeom.js` patches stay authoritative inside their footprints; phase 1b changes **how they are built**:
  `buildFromTiles(harbor, tiles)` replaces the Overpass-coastline + Natural Earth input (the mask/height raster is the
  D14 mask resampled to 10 m, features come from the tile vectors and the z12 overlay); the berth / fairway / dredge /
  street-layer steps after it are unchanged. `GEOM_VERSION` → 6; old patch files are rebuilt in the background at P4
  (one at a time); until rebuilt, the old patch is served. Offline, `buildFromOSM`/`buildSynthetic` stay as fallbacks.
* `bigports.js` keeps carving L1 (routing quality) and keeps the per-port guard in the converter (§3.4.1-7) until the
  oracle test has passed on production for two weeks; then the guard is removed (phase 3) and the JSON stays as a
  test oracle only.
* `maptiles.js` unchanged (drape and chart).

---

## 7. Phased plan

### Phase 0 — probe (½ day, one person, production)

1. `scripts/probe-world-sources.mjs`: GET OpenFreeMap TileJSON + 3 z14 tiles (Rotterdam, Singapore, Santos), 1
   Terrarium z9 tile, 1 Overpass overlay for a z12 square, EMODnet REST sample; prints status, bytes, ms, layer names
   and the `water` classes seen (confirms `dock` / `pier` naming in the OpenMapTiles schema version served).
2. Decide primary (OpenFreeMap or Fallback B) and record it at the top of this file.
3. `scripts/record-wt-fixtures.mjs` and `scripts/record-moored-fixture.mjs` produce the fixtures of §5.2.

### Phase 1 — every harbour accurate, real coast near every ship (the minimum)

**1a (can start now; files disjoint from the agents currently editing world/harborgeom/harbors/bigports/osm/game):**

| Lane A — server data (owner A) | Lane B — client rendering (owner B) |
|---|---|
| new `shared/wtformat.js` (§3.2 verbatim; **delivered first**, day 1) | new `public/js/wtiles.js` |
| new `server/mvt.js` | new `public/js/wtworker.js` |
| new `server/wtsource.js` | new `public/js/wtmesh.js` (terrain + quay walls + breakwaters + piers + buildings as plain extrusions) |
| new `server/wtconvert.js`, `server/wtconvert-thread.js` | edit `public/js/terrain.js` (sink coarse under D14, C11 ring, height order) |
| new `server/worldtiles.js`, `server/worldstack.js`, `server/wtprefetch.js` | edit `public/js/main.js` (create/update `WorldTileSet`, focus point, `wt` push) |
| edit `server.js` (routes §3.5, stack + facade wiring, prefetch start, swap handler §3.6.4, `/api/route` ensure) | edit `public/js/collision.js` (tile SDF fallback) |
| new `scripts/probe-world-sources.mjs`, `scripts/record-wt-fixtures.mjs`, `scripts/record-moored-fixture.mjs`, `scripts/wt-repin.mjs` | edit `public/js/hud.js` (attribution, loading dot) |
| new tests `test/mvt.test.mjs`, `test/wtformat.test.mjs`, `test/wtconvert.test.mjs`, `test/worldtiles.test.mjs`, `test/worldstack.test.mjs`, `test/wt-ports.test.mjs`, `test/fixtures/wt/**` | new test `test/wtmesh.test.mjs` (worker build functions are pure: vertex counts, LOD sizes, wall faces along quay edges, no NaN, budget caps) |

Lane B develops against `shared/wtformat.js` and a static fixture tile served from `test/fixtures/wt/` until Lane A's
`/api/wt` is up. The only shared file is `shared/wtformat.js` (Lane A owns it; Lane B requests changes).

**1b (after the current editors of `harborgeom.js`, `world.js`, `game.js` have landed; Lane A):**

* `server/harborgeom.js`: `buildFromTiles`, `GEOM_VERSION = 6`, background rebuild; `ensureHarbor` awaits the
  harbour's D14 tiles (8 s cap) before building.
* `server/world.js`: `pruneRasterCache()` (keep the files `load` used) — fixes the 813 MB leak.
* `server/game.js` (optional, one line): `this.geom.ensureWorld?.(lat, lon)` beside `expressPatchesToBuild`, if the
  facade wrapping of `ensureHarbor` (§3.6.2) proves awkward.

**Phase 1 done =** every listed harbour's patch is built from real tile data; D14 terrain with quay walls, piers,
breakwaters and plain buildings renders near every ship and camera anywhere on Earth; the server grounds ships on the
D14 coast; moored-AIS fixture passes in ≥ 12 ports on ≥ 5 continents.

### Phase 2 — buildings and harbour furniture everywhere (Lane A / Lane B)

* A: overlay at rev 1 for all harbour z12 squares and around ships (cranes, tanks, lights, bridges, locks);
  route-worker receives D14 buffers; AIS display offset rule data (`quays` index endpoint for the client is not needed
  — the client has the tiles).
* B: facades, roofs and night windows from `harbor.js` palettes on D14 buildings; instanced cranes (STS gantries,
  portal cranes), tanks, bollards/fenders along quay edges, bridges (deck + piers), lock gates, lighthouses with their
  light character (`ch`), buoys riding the sea (reuse `harbor.js` `addBuoy`); map drape on D14 land near the camera;
  moored-AIS shift-to-quay (display only); shore foam field per D14 tile (`ocean2.setShoreField`).

### Phase 3 — inland waterways and any-quay mooring

* A: river/canal navigation: a waterway graph from D14/C11 RIVER/CANAL cells and OSM `waterway` lines for the route
  planner (rivers ≥ 4 m deep, bridges with clearance, locks as nodes with a passage time); `berthsFromQuays(tile)` →
  docking anywhere on a long quay; EMODnet bathy for European seas; remove the bigports guard after two weeks green.
* B: lock operation visuals (gates open/close, levels), bridge clearance warnings, river banks with vegetation.

### Phase 4 — retire duplication (optional)

Patches become thin overlays (berths, fairway, tug paths, street layer) over D14; L1 region raster rebuilt from C11 for
the whole world (or osmdata water polygons); optional NOAA ENC dredged depths (US), Overture building enrichment
(offline batch where OSM lacks buildings).

---

## 8. Acceptance checklist

- [ ] Phase-0 probe run on production; primary source recorded here.
- [ ] `shared/wtformat.js` matches §3.2 byte for byte; round-trip tests green.
- [ ] `npm test` green offline, **no existing test changed**; new suites of §5.1 green.
- [ ] `SALTLINE_WT_OFFLINE=1`: game identical to before (snapshot test + browser scenario 7).
- [ ] D14 tile for Rotterdam / Singapore / Santos converts in ≤ 150 ms on the production box; converter is
      deterministic (same bytes twice).
- [ ] Sample-point fixture (§5.2) green for ≥ 12 ports on ≥ 5 continents.
- [ ] Moored-AIS fixture: ≥ 85 % within 25 m of a quay edge, ≤ 3 % on an obstacle — overall and per port.
- [ ] Big-port oracle ≥ 93 % agreement; all bigports fairway points navigable.
- [ ] Every one of the 336 harbours rebuilt from tiles (phase 1b) with ≥ 1 berth and an anchor in water ≥ 9 m.
- [ ] Express passage to 20 random harbours worldwide: arrival on water ≥ draft + 3 m with tiles loaded; no hole on screen.
- [ ] Tile swap under a ship never causes damage; relocation message shown; docked ships untouched.
- [ ] Disk: cache stays under `SALTLINE_WT_CACHE_MB`; raster cache pruned to the files in use.
- [ ] Server: RSS growth ≤ 120 MB with 20 simulated players; game tick lag unchanged (p99 < 20 ms).
- [ ] Client desktop ≥ 60 fps in Rotterdam (mid GPU), phone ≥ 30 fps in Hamburg; no frame > 100 ms when a tile attaches.
- [ ] Upstream politeness: request counters in `/api/health` (`wt: {fetched, failed, queue, disk MB, mem tiles, pin}`)
      stay under the §4.2 caps for 24 h.
- [ ] Attribution visible in the HUD credits ("© OpenStreetMap contributors · OpenMapTiles · OpenFreeMap · Mapzen/AWS").
- [ ] Browser scenarios 1–10 (§5.3) pass.

---

## 9. Open questions — defaults used

| # | Question | Default |
|---|---|---|
| Q1 | Self-host a PMTiles extract instead of using OpenFreeMap's public servers? | No for phase 1; recommended if the player count grows past ~200 concurrent or OpenFreeMap asks |
| Q2 | How often to re-pin the OpenFreeMap version? | Only when the pinned version disappears, or monthly by operator command |
| Q3 | D14 cell size: 256² (≈ 6 m at 50°) or 512²? | 256² — matches the 10 m patches, 4× less memory; quays still land within one cell |
| Q4 | Invent cranes/containers on unmapped container terminals? | No (accuracy first); phase 2 may add containers on `landuse=industrial` + `industrial=port` yards, cranes only from OSM |
| Q5 | Bridge collision with masts/air draft? | Render only in phases 1–2; air-draft rule in phase 3 |
| Q6 | Ship `onState` rejects positions inside D14 obstacles — also for small yachts at marinas with poorly mapped pontoons? | Yes, but PONTOON cells count as obstacle only when the overlay has them (no derived pontoons) |
| Q7 | Depth of unknown docks | class defaults of §3.4.3; shown as "est." in the HUD depth readout when `depthSrc ≠ bathy` and no explicit tag |
| Q8 | Disk cap on production | 1 536 MB; lower with `SALTLINE_WT_CACHE_MB` if the volume is smaller |
| Q9 | Serve tiles directly from OpenFreeMap to clients? | No — clients only talk to our server (one fetch shared by all, one version for all, no third-party requests from the browser) |
| Q10 | Areas beyond 85° latitude | L0 raster only (no ports there) |
