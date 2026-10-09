# Saltline — bridges, locks, VHF radio, inland harbours (design contract)

Status: **design only** (2026-10-09). Nothing here is built yet. This file is the contract for three/four parallel lanes
(§9) plus one integration pass (§9.6).
Builds on: `docs/WORLD-DETAIL-STREAMING.md` (D14 tiles, vectors `bridges` / `locks`, phase 3 "inland waterways"),
`docs/DOCK-ANYWHERE-CONTRACT.md` (`server/quays.js`, `shared/quayrules.js`), `docs/V5-PLAN.md` items 8 (VHF with
channel selector on the bridge) and 16 (bridges with clearance, locks that cycle, CEMT limits), `docs/SAILING-CONTRACT.md`
(`shared/sail/rigs.js`, y = 0 at the waterline), the ship catalogue (`shared/ships/*`).

Player requests covered (screenshots at Rozenburg / Calandbrug / Rozenburgsesluis, Rotterdam):
1. Inland bridges shown accurately, with their height. Whether you fit under depends on your air draught, and your air draught depends on how deep you are loaded.
2. The Netherlands is fully navigable for boats that fit.
3. Bridges are missing in 3D: only the pillars show.
4. Bascule, lift and swing bridges really open.
5. A working VHF radio with channels: call bridges, locks, port control/VTS, other ships and the coast guard.
6. Ship heights and bridge heights look right relative to each other.
7. Locks (*sluizen*) are fully realistic: real dimensions, levels, cycle, queue, signals and bridges, with the OpenSeaMap clearance boards ("3.6 / 24.0") used and drawn.
8. Inland harbours and marinas everywhere: about 1,000 in the Netherlands alone, against the 336 big harbours now.
9. Inland water is nearly flat. The HUD showed "moderate 2.1 m" inside a lock canal.

---

## 1. What the player gets (plain words)

**Bridges you can trust**
* Every bridge over water appears in 3D at the place and height it has in reality. You see the deck, girders or truss,
  piers and approach ramps, not just pillars. Each bridge that opens has its moving part: a bascule leaf that tips up,
  a lift span that rises between its towers, a swing span that turns on its pivot pier, or a pontoon section that slides aside.
* Above the opening hangs the same **clearance board** you know from OpenSeaMap. A fixed bridge shows its clearance
  ("14.0"). A movable bridge shows *closed / open* ("3.6 / 24.0"). The pier carries a **clearance gauge** (*peilschaal*) that shows
  the clearance right now, at the current water level, as Dutch bridges do.
* Click a bridge (or tap it on the phone) to open its card. The card shows the name and type, the clearance now (closed
  and open) and the opening width. It also shows the **VHF channel**, the opening hours, any rush-hour blocks, the next
  opening and the queue. A **side view drawn to scale** shows your ship's silhouette at its current air draught next to the
  opening at the current water level.
* The HUD shows **AIR DRAUGHT** live, for example "AIR 8.62 m · draught 4.08 m". Under it is a strip with the next three bridges
  ahead: green means you pass under with margin, amber means you pass with less than 1 m, and red means you need an
  opening or cannot pass.

**Your air draught changes with loading**
* Loading cargo, bunkering or **taking ballast** pushes the hull down and lowers your air draught. Discharging and
  pumping ballast out raises it. Containers on deck add their stack height: each tier is 2.59 m.
* Ships built for rivers (our coaster, and the new inland barges) can **lower the wheelhouse and fold the masts**.
  Motor yachts can fold their radar arch. A sailing yacht's mast stays up, so she takes the *staande-mastroute*
  (the standing-mast route) through the movable bridges.
* Example: your coaster in ballast with the wheelhouse down has an air draught of 7.5 m and slips under a 9 m bridge.
  Loaded with two tiers of containers on deck she stands 9.7 m above the water and must go round or wait for an opening.

**Opening bridges and locks for real**
* Tune the radio to the bridge's channel and call it by name. The operator answers with your place in the queue and
  the expected wait. The red-green signal means "get ready". The road barriers come down, the span opens, the light
  turns green and you go. Everyone in the game sees the same bridge open at the same moment.
* Calling on the wrong channel gets no answer. Outside the operating hours you are told when service resumes. In
  rush hour some city bridges stay shut. Ships that fit underneath are told to pass under.
* Hit a bridge and it hurts. A sailing yacht is **dismasted**. A wheelhouse or radar mast is damaged, and you may lose
  the radio antenna and with it radio range. The top tier of containers goes into the water. The bridge goes out of
  service for everyone for a while, and you pay for the damage.
* **Locks** work as they do in reality:
  1. Call the lock on VHF and register.
  2. Wait at the waiting berth.
  3. Watch the signals: red, then red-green, then green.
  4. Enter and make fast on the bollards (floating bollards where the lock has them).
  5. The gates close, and you watch the water **rise or fall in real time** with your ship on it, with the inflow foaming.
  6. The other gates open and you leave.

  Locks have real chamber sizes and real sill depths. The sea side follows the tide. Small-craft chambers sit next to
  the commercial chambers. The bridges over the lock heads open together with the lock, as at the Rozenburgsesluis.
  Other players, your fleet and real AIS ships share the chamber with you.

**Route planning inland**
* The route planner knows every Dutch canal and river with its class (CEMT) and limits, plus every bridge and lock. It plans
  only through water your ship fits: draught, beam, length, and air draught including tide.
* It adds the waits for bridge openings and lock cycles, and avoids bridges you cannot pass. A 17 m sailing yacht is routed
  through movable bridges. A schooner with a 34 m topmast is told the Rozenburgsesluis bridges open to only 24 m and
  is sent round via the Calandbrug, which opens to 49.7 m.

**Radio**
* There is a real VHF set on the bridge (the interior wheelhouse), and on the phone a radio sheet. It has:
  * a channel knob;
  * **dual watch on 16**;
  * **PTT**;
  * a station list ("in range on this channel");
  * canned standard phrases, filled in with your ship's name, position, air draught and direction;
  * free text to other players.
* You hear squelch, static and the operator's voice (optional browser speech). Reception gets noisy towards the edge of range.
* Channel 16 is for calling and distress. Channel 13 is bridge-to-bridge at sea and channel 10 is ship-to-ship inland.
  Rotterdam's real VTS sector channels come from data: Maas Approach 1, Oude Maas 62, Maasbruggen 81, Traffic Centre 11,
  Harbour Coordination Centre 14.
* Bridges and locks answer on their own channels. Fictional AI ships answer passing calls. Real AIS ships are shown but never
  made to talk.
* **DISTRESS** (a red covered button, hold for 3 s) sends a DSC distress. The coast guard answers on 16. This is the hook for search and rescue later.

**Inland harbours everywhere**
* Marinas, *passantenhavens* (visitor harbours), city harbours, barge terminals and small fishing harbours appear wherever they really are. That is about 1,000 in the Netherlands, generated around you as you sail, like the world tiles.
* Each has a harbour card made on demand: berths and their sizes, depth, whether you can reach it (bridges and locks on the
  way), fee per night, water and power, fuel, the harbour master's VHF channel, and a small market at inland commercial ports.
* There are inland contracts: barge cargoes by CEMT class, container barges, tanker barges, plus day charters and sailing lessons
  between marinas.
* The 336 named harbours keep their full markets and shipyards.

**Flat water inland**
* In canals, rivers, docks and lock chambers the waves come only from the wind over the short stretch of water upwind
  (the fetch). Fresh wind in a lock canal gives ripples of about 9 cm ("calm-rippled"), not 2.1 m.

### 1.1 Controls

| Action | Desktop | Phone |
|---|---|---|
| Open or close the radio | **E** (free key today) | handset button, bottom-right of the touch HUD. Opens a bottom sheet |
| Channel down / up | **[** / **]**, or type digits with the radio open, then Enter | swipe the channel wheel, or tap a preset chip |
| Dual watch 16 on/off | **Shift+E** | toggle on the sheet |
| Pick a station to call | **Tab** while the radio is open (cycles stations in range on the channel) | station list, tap |
| Pick a phrase | ↑/↓ in the phrase list (the radio panel takes the arrows while open; helm keys work again when it is closed) | phrase chips, sorted by context: "Request opening" first near a movable bridge |
| Transmit (PTT) | hold **Z** (release sends; Enter also sends) | big PTT button: hold, release to send |
| Quick "call the bridge or lock ahead" | **Shift+Z**: tunes to its channel and pre-selects "Request opening / lock passage" | chip "Call Botlekbrug (ch 18)" appears within 3 km |
| Air draught card (ballast, folding) | **;**, or click the AIR field in the HUD | tap the AIR chip |
| Ballast fill / empty / stop | buttons on the air draught card | same |
| Lower or raise wheelhouse / masts / arch | button on the air draught card | same |
| Bridge or lock card | click the object in 3D or on the chart | tap |
| Make fast in a lock chamber | **T** (the existing Moor/Dock key) inside a chamber slot | Moor button |
| Distress (DSC) | radio panel red button, hold 3 s | same, hold 3 s |

Keys checked against `public/js/main.js` (keys in use: a b c d f g h i j k l m n o p q r s t u v w x y, arrows, Tab,
Enter, Esc). **E**, **Z**, **[**, **]**, **;** are free. Note that main.js lowercases the key, so Shift variants must test
`e.shiftKey` before the plain-letter branch.

---

## 2. Findings: what is wrong today (the root causes behind the screenshots)

1. **Clearances are always estimates.** `server/wtconvert.js` (bridges block, about line 440) builds bridges only from OpenFreeMap
   `transportation brunnel=bridge` lines. It sets `clr` from a heuristic: 35 / 15 / 6 m by road class and water width,
   with `e: 1` on every bridge. The overlay's `seamark:type=bridge` features are classified (`overlayKind → 'bridge'`)
   but **never used**.
2. **The overlay throws the clearance tags away.** `server/wtsource.js` `KEEP_TAGS` keeps
   `seamark:.*(…|clearance_height|height|range)$`. That loses `seamark:bridge:clearance_height_closed`,
   `…_open`, `…:clearance_width` and `seamark:bridge:category`. The `"3.6 / 24.0"` board values never reach the
   game.
3. **`maxheight` is the wrong key.** WORLD-DETAIL §3.4.5 lists `maxheight` as a clearance source. On a highway it is the
   road vehicle limit, not the water clearance under the deck. It must not be used for water clearance, except when it is
   tagged on the *waterway* way.
4. **Decks missing ("only pillars").** Several causes combine:
   * D14 structures are discarded inside harbour-patch footprints (`public/js/wtiles.js`: "patches keep precedence"). Patches
     draw bridges only as **road ribbons** (`public/js/harbor.js addRibbon(…, bridge)`), so rail bridges such as the
     Calandbrug (rail) get no deck at all.
   * The towers of lift bridges are OSM *buildings* with a real height, so they render. That is the "pillars".
   * The D14 deck is a thin slab at `clr + 1.5` m with no piers, and a feature is skipped when its centroid lies in the
     neighbour tile.

   Fix (§5): bridges and locks are drawn by a **dedicated module from a registry of objects**, independent of tile ownership
   and patch precedence. The D14 slab stays only as a fallback for objects the registry does not know.
5. **Air draught is a constant, and wrong for some classes.** `shared/ships/catalogue.js statsOf`:
   `airDraft = L < 30 ? 0.3L + 2 : min(75, 12 + 0.17L)`. That gives the sloop **5 m**, although its mast top in
   `shared/sail/rigs.js` is 16.2 m above the waterline, and the coaster 27 m. Draught is a fixed class number. Cargo
   changes only speed (`loadFrac`). There is no ballast and no folding.
6. **Tide is applied everywhere.** `shared/tide.js tideAt` is used for the water level even inside canals that are
   held at a constant level behind locks.
7. **Sea state ignores shelter.** `game.weatherPublic` returns the open-sea `waves.height` at any point, which explains the
   "moderate 2.1 m" in the lock canal.
8. **Harbours are only the 336 named ones.** `server/harbors.js HARBORS` lists them. Dock-anywhere links quays to them for
   services. There are no marinas or inland ports.

---

## 3. Data sources

### 3.1 Evaluation

Availability was checked on 2026-10-09 by web search. Direct HTTP from this build sandbox is blocked (proxy 403), so
**production must run the probe** in §3.4 before lane A's fetcher is switched on.

| Source | Licence | Access | Coverage / content | Update | Verdict |
|---|---|---|---|---|---|
| **Rijkswaterstaat Vaarweginformatie / FIS dataservice** (`https://www.vaarweginformatie.nl/wfswms/dataservice/1.4/…`, the "FIS_VNDS" datasets; schema pages `…/1.4/schema/lock`, `…/schema/berth`; interface doc "RWS.DID.FIS.VNDS-Dataservice.IRS v1.27" on the Vaarweginformatie downloads page) | **CC0 1.0** (data.overheid.nl lists FIS_VNDS lock, berth and touristharbour datasets as CC0). Attribution "© Rijkswaterstaat / Vaarweginformatie.nl" given anyway | No key. JSON over HTTPS. Entity collections paged with offset/count under a "geogeneration" (a data version id) | **All Dutch fairways:** bridges and their openings (closed/open clearance, width, reference level), locks and chambers (length, width, sill depths), operating times, radio call-in points (VHF), fairway sections with CEMT class and limits, berths (*ligplaatsen*), tourist harbours, terminals | Geogeneration changes when RWS publishes (weekly or more often). Operating-time exceptions are daily | **PRIMARY for NL** |
| Rijkswaterstaat operating-times files ("Bedieningstijden bruggen en sluizen", PDF on the Vaarweginformatie downloads page) | RWS publication | download | regular hours per object | twice a year | reference to check the parsed hours |
| **Inland ENC** (RWS, S-57: BRIDGE with VERCLR/VERCCL/VERCOP/HORCLR/CATBRG, LOKBSN, gates, RDOCAL) | free download from RWS | zip of S-57 cells | all NL fairways, chart-grade geometry | monthly | **phase 3 validation only.** It needs an ISO 8211 reader, about 400 lines, no npm deps. Not needed while FIS works |
| **EuRIS** (eurisportal.eu, RIS Index of the EU member states; API intro at `eurisportal.eu/api/intro`) | data.overheid.nl lists the EuRIS-derived operating-time sets as "licence unknown, restricted". The 2026 release says almost everything is public without an account | Web service ("Open APIs"). Registration terms unclear | NL, BE, DE, FR, AT, HU, RO, BG, SK, HR, CZ…: bridges with static and actual clearance, locks, operating times, notices | live | **phase 3 for the rest of Europe, only after the operator registers and confirms the terms.** Until then use OSM |
| **OpenStreetMap / OpenSeaMap** via the existing Overpass overlay (`server/wtsource.js`) | ODbL | Overpass, capped (1 in flight, ≥ 3 s apart, ≤ 1,500/day) | worldwide geometry. Tags: `bridge=*`, `bridge:movable=bascule|lift|swing|drawbridge|transporter|retractable|submersible`, `bridge:structure`, `seamark:type=bridge` + `seamark:bridge:category` (fixed/opening/lifting/bascule/swing/pontoon/drawbridge…), `seamark:bridge:clearance_height`, `…_closed`, `…_open`, `…:clearance_width`; `waterway=lock_gate`, `lock=yes`, `lock_name`, `maxlength/maxwidth/maxdraught`, `CEMT=*`, `vhf=*` / `seamark:radio_station:*`; `leisure=marina`, `seamark:type=harbour` + `seamark:harbour:category`, `mooring=*`, `seamark:small_craft_facility:category` | live; our overlay refetches by rev | **PRIMARY outside NL.** In NL it supplies geometry and fallback numbers (a published analysis found clearances on only about 25 % of Dutch bridges in OSM, and no hours or VHF) |
| OpenFreeMap z14 (already the base layer) | ODbL | existing | bridge **lines** (`brunnel=bridge`, class road/rail/path) | weekly | deck geometry when OSM overlay or FIS have no line |
| PDOK **NWB Vaarwegen** (`api.pdok.nl/rws/nationaal-wegenbestand-vaarwegen/ogc/v1`) | CC0 | OGC API Features, JSON | the national waterway network (centrelines and km markers) | quarterly | graph geometry fallback if the FIS fairway sections lack geometry |
| Port of Rotterdam "Procedure VHF communication VTS & HCC" (PDF, v1.4 July 2023, annex 1 = channel table) | published procedure | PDF, transcribed by hand into a data file | Rotterdam VTS sectors and channels | yearly | **seed for `server/waterworks/vts-nl.json`** (§6.3) |
| Port of Antwerp-Bruges "Bridges & Locks" open data API | free, registration by e-mail | REST | live bridge and lock state, Antwerp | live | phase 3 option (live status) |
| RWS WaterWebservices (water levels) | CC0 | REST JSON | measured and forecast water levels at NL gauges | 10 min | **optional** live water levels. The default is the model in §4.1 |
| CBS 84133NED (marina capacity, passant berths) | CC-BY 4.0 | OData | aggregates per region, not per harbour | yearly | **calibration only** (§7) |
| Waterkaarten (formerly ANWB Waterkaarten), ANWB Wateralmanak, waterkaart.net | proprietary / subscription, no reuse terms found | — | marinas, bridges, hours | — | **not used** |

### 3.2 Choice

* **NL: FIS is authoritative for numbers** (clearances, widths, reference levels, chamber sizes, sills, hours, VHF,
  CEMT). **OSM / OFM is authoritative for 3D geometry** (where the deck line, piers and lock walls are). They are joined by
  proximity (§3.5).
* **Rest of the world: OSM overlay** (OpenSeaMap tags) plus the conservative fallbacks of §3.6. EuRIS joins in phase 3
  once its terms are confirmed.
* VTS sectors and channels come from a small hand-maintained JSON transcribed from the port authorities' published
  procedures. Rotterdam is the first.

### 3.3 Fetch, cache, keep current

* `scripts/fetch-fis.mjs` (lane A) is run by the operator, like `scripts/fetch-port-water.mjs`:
  1. Read the current geogeneration.
  2. Page through the entities `bridge`, `opening`, `lock`, `chamber`, `operatingtimes`, `radiocallinpoint`, `fairway`,
     `fairwaysection`, `berth`, `touristharbour`, `terminal` (100 per request, ≥ 1 s apart, single connection).
  3. Normalise to the compact schema of §4.2 / §4.8.1.
  4. Write `server/waterworks/nl-fis.json.gz` with `{v, geogeneration, fetchedAt, attribution, bridges, locks, sections,
     callIn, berths, harbours}`.
  * The file is **shipped in the repo**, like `server/bigports/`. Expected size is about 1.5–3 MB gzip (NL has about 6,000 FIS bridges and about 250 locks with
    chambers). It is gitignored if over 5 MB, and then fetched by the deploy step instead (open question Q3).
* At runtime `server/fis.js` loads that file at start (lazy, about 20 MB parsed). It **may** refresh it in the background once a
  day, but only if `SALTLINE_FIS_LIVE=1`. That refresh is a single conditional GET of the geogeneration; on a new geogeneration it
  refetches into `data/waterworks/nl-fis.json.gz` (the runtime cache dir, written by the server, never by agents) and
  hot-swaps the registry. Object ids are stable across geogenerations (FIS ids).
* Short-term notices (outages, changed hours) come from the FIS operating-times exceptions when live. Otherwise there are none.
* OSM numbers arrive with the tile overlay (§3.5) and follow its rev mechanism. **`OV_SCHEMA` is bumped to 2** because the
  query and kept tags change, so old overlays are refetched lazily and used until then.
* Attribution in the HUD credits: "Bridges & locks NL: © Rijkswaterstaat / Vaarweginformatie.nl (CC0)", plus the existing OSM line.

### 3.4 Production probe (before switching on)

`node scripts/fetch-fis.mjs --probe` must print, for 3 objects: Botlekbrug (expect closed 14.0 / open 45.0, two lift
spans of about 87 m), Calandbrug (expect closed about 11.7, open about 49.7: design values, FIS wins) and Rozenburgsesluis
(305 × 24 m, CEMT VIc). It prints each object's fields and the reference level it uses. If the dataservice
path or field names differ from §4.2, the probe output is pasted into this doc and the normaliser adapts. **The
game schema does not change.**

### 3.5 Joining sources into one registry

`server/waterworks.js registry` keys:
* `fis:<id>` for objects from FIS;
* `osm:<type><id>` for OSM-only objects;
* `ofm:<z14 tile>:<i>` for OFM-only bridge lines without OSM tags (estimates).

Join rules (deterministic, nearest first, ties by id):
* An OSM seamark bridge **node** (OpenSeaMap tags the node on the waterway under the bridge) joins the OFM or OSM bridge **line**
  that crosses the same waterway within 30 m. If no line exists, a synthetic deck line is built across the water,
  perpendicular to the waterway, as wide as the water (from the D14 mask) plus 20 m each side.
* A FIS bridge joins the OSM/OFM line nearest its point within 60 m that crosses water. FIS numbers replace OSM numbers.
  OSM/OFM supplies the line, `bridge:structure` and the road/rail kind.
* A FIS lock joins the OSM `waterway=lock` / `lock=yes` area within 100 m. Chambers are matched by orientation and
  size. FIS sizes win. The OSM ring gives the wall geometry, and `lock_gate` nodes/lines give the gate positions.
* Bridges over a lock head (the lock area ring is within 15 m of the bridge line) get `lockId` and are operated by the lock
  (§4.8.7).

### 3.6 Fallback rules when a number is unknown (conservative)

The rule is: *never let the game claim a ship fits when reality may say no; never invent a height higher than likely*.
Every estimated number is flagged `e: 2` and shown as "est." with a warning: "unverified clearance — slow down and read
the gauge".

| Unknown | Rule |
|---|---|
| Fixed bridge clearance | `min(heuristic, CEMT minimum of the waterway if known)`. Heuristic: motorway/rail over water > 300 m wide → 25 m; > 100 m → 7.0 m; anything else → **2.5 m** (typical small Dutch canal bridge). Replaces 35/15/6 |
| Movable bridge, closed clearance | 1.5 m |
| Movable bridge, open clearance | bascule / swing / pontoon / retractable → unlimited inside the opening width; lift → closed + 25 m; drawbridge → unlimited |
| Opening width | water width at the bridge line (D14 mask) × 0.8, at most 40 m for movable bridges |
| Reference level | NL: `KP` (canal level, constant) where the D14 mask is non-tidal (§4.1); tidal water: `NAP` in NL, `MHWS` elsewhere (the chart convention). `MHWS` is the most conservative |
| Operating hours | 06:00–22:00 local, every day, on request |
| VHF channel | none: a **push button** on the approach (*bedienpaal*). The HUD button "Request opening (push button)" works within 300 m |
| Lock chamber size | OSM ring's inner rectangle, length minus 10 m, width minus 1 m |
| Lock sill depth | the waterway's CEMT draught, else 2.5 m |
| Lock lift | 0 m (levelling still takes the gate times) |
| Harbour depth | marina 2.0 m, passantenhaven 1.8 m, city harbour 2.5 m, barge quay = waterway CEMT draught |

---

## 4. Model

All rules are pure functions in `shared/` so the server, the client prediction and the tests share them.

### 4.1 Water levels and reference datums (`shared/waterlevel.js`, lane A)

* `waterLevelAt(lat, lon, t, ctx) → { h, ref: 'tidal'|'canal', datum }` gives the water height in the game frame
  (0 = model mean sea level ≈ NAP in NL; NAP is about 0.1 m below MSL at Hoek van Holland, which is ignored).
  * Tidal water: `tideAt(lat, lon, t).height`.
  * **Non-tidal water** (canals and lakes behind locks: the IJsselmeer, the Amsterdam–Rhine canal, most NL canals) is constant at its
    *streefpeil* / KP relative to NAP. Examples: Amsterdam canal level NAP −0.40, IJsselmeer about −0.20 (winter) / −0.10 (summer).
    The value comes from the FIS fairway section or the lock's level fields, and the default is 0.
  * How a point is classified: lane A ships `server/waterworks/levels-nl.json`, polygons of non-tidal pounds (from FIS sections
    joined between locks). Outside NL every point is tidal unless the D14 mask is RIVER and more than 50 km from the coast.
    In that case the level is constant at 0 for clearance purposes and the river stage is ignored (Q7).
* The client's water plane follows `h`. Today `ocean.setLevel(you.tide.height)` is used. The server sends `you.water = {h, ref}`
  instead, and the tide panel shows "Canal level (no tide)" in pounds.
* Datums: `NAP` (offset 0), `KP` (= that pound's level, so clearance is constant), `MHWS` (= +1.33 × the M2 amplitude of the
  `tide.js` region, mirroring `lowWaterAt`), `LAT` (= `lowWaterAt`), `MSL` (0).

### 4.2 Bridge object (registry, `shared/waterworks.js` types)

```text
Bridge {
  id: "fis:19218" | "osm:w123" | "ofm:14/8392/5391:3",
  name, kind: "road"|"rail"|"foot"|"mixed", src: "fis"|"osm"|"ofm", e: 0|1|2,   // 0 official, 1 OSM tagged, 2 estimated
  line: [[lat, lon], …],               // deck centre line, full length incl. approaches
  deckW: 12,                           // m, deck width
  structure: "girder"|"truss"|"arch"|"cable"|"concrete", 
  spans: [{                            // one per passage over water; movable spans carry their mechanism
    id: 0, a: 118.0, b: 205.0,         // metres along `line` (opening edges = pier faces)
    mov: "fixed"|"bascule"|"bascule2"|"lift"|"swing"|"pontoon"|"draw"|"retract",
    clr: 14.0, clrO: 45.0 | null,      // closed / open clearance above `datum` (m); clrO null = fixed; Infinity allowed
    w: 87.0,                           // horizontal clearance (m) of this passage
    hinge: "a"|"b"|null, pivot: 0.5|null,   // bascule hinge side / swing pivot (fraction of the span)
    rec: 1|0,                          // recommended passage (yellow lights), from FIS or the widest span
  }],
  datum: "NAP"|"KP"|"MHWS"|"LAT"|"MSL", kp: -0.40 | null,
  vhf: 18 | null, call: "vhf"|"button"|"phone"|"none", callName: "Botlekbrug",
  hours: OpHours, blocks: [Block], slots: { every: 30, at: 0 } | null,   // rail bridges: fixed opening slots (min)
  lockId: "fis:…" | null, pairedWith: "fis:…" | null,                     // lock-head bridges (§4.8.7)
  fee: 0, notes: ["Night: open on request, 1 h notice (ch 71)"],
  operator: "RWS"|"Port of Rotterdam"|"Province"|"Municipality"|null,
}
OpHours = { tz: "Europe/Amsterdam", week: [[["06:00","22:00"]], …7 days], holidays: "sunday", onRequestNight: { from:"22:00", to:"06:00", noticeMin: 60 } | null }
Block   = { days: [1,2,3,4,5], from: "07:00", to: "09:00", why: "rush hour" }
```

The tile vectors keep a light copy so the client can draw before the registry answers. Converter v2, additive
(`CONVERTER_VERSION = 2`, `vectors.v = 2`; `wtformat.FORMAT` unchanged):
`bridges: [{ p, w, deck, clr, mov, k, e, id, clrO, wO, datum, sp: [aDm, bDm] }]`. `mov` stays numeric for old clients:
0 fixed, 1 bascule, 2 lift, 3 swing, 4 pontoon, 5 other movable.

### 4.3 Clearance now

```
clrNow(span, t) = (state(span) is fully open ? span.clrO : span.clr) + datumOffset(datum, lat, lon) − waterLevelAt(…, t).h
```
* For a partly open span, the clearance is interpolated by the open fraction. Bascule and swing count as **0** until
  fully open; only a lift span moves its clearance continuously.
* The gauge (*peilschaal*) on the pier shows `clrNow` of the closed span, rounded **down** to 0.1 m.
* Worked example (test §10.2): Botlekbrug, `datum NAP`, clr 14.0. Water +1.2 NAP → clrNow 12.8 m. Water −0.8 → 14.8 m.

### 4.4 Air draught (`shared/airdraft.js`, lane A)

Air draught = height of the ship's highest point above the water = `kTop(state) − T(load)`.

**Profile per model** (`AD_PROFILE[id]`, explicit for the classes in the table below, derived for the rest):

```text
{ tLight,          // draught with lightship + crew/stores, no cargo/ballast/fuel (m)
  tDesign,         // = catalogue draft (summer draught)
  kTop,            // keel → highest fixed point in the LOWERED state (masts folded, wheelhouse down) (m)
  up: { wheelhouse: +7.4, mast: 0, arch: 0 },   // added when raised (kTopUp = kTop + max(raised parts))
  hatchTop,        // keel → top of hatch coaming (deck cargo base) (m), null = no deck cargo
  deckSlots,       // TEU per deck tier (container-capable hulls), 0 = none
  holdTeu,         // TEU below deck
  ballastMax,      // t; 0 = class has no ballast system
  pumpTph,         // t/h ballast pump rate
  antenna: 0.8 }   // VHF whip / windex above the highest structure (m), already inside kTop
```

**Draught from loading.** Wall-sided and linear. Good to a few cm for these ranges.
```
DWmax = capacity + fuelCap + stores,   stores = round(0.02 × (capacity + fuelCap))
DW    = cargo t + ballast t + fuel t + stores
T     = tLight + (tDesign − tLight) × clamp(DW / DWmax, 0, 1)
```
Overloading beyond `DWmax` is already refused elsewhere. Ballast is capped so `DW ≤ DWmax`.

**Containers on deck.** The game rule is 12 t per loaded TEU (`containers` good). `teu = ceil(t / 12)`. The hold fills first.
`deckTiers = ceil(max(0, teu − holdTeu) / deckSlots)`. Stack top = `hatchTop + deckTiers × 2.59` (8'6" boxes) + 0.1 (lashing).
`kTopNow = max(kTop + raised parts, stackTop)`. Deck **cargo other than containers** (machinery, steel on deck) is
ignored in phase 1.

**Derived profile** (catalogue models without an explicit row). This keeps the catalogue's displayed number meaningful:
* `kTop = tDesign + model.airDraft` (the existing stat is read as the air draught *at summer draught*, masts up), `up = {}`.
* `tLight = tDesign × LIGHT[type]`, with LIGHT = bulk 0.35, tanker 0.38, gas 0.45, container 0.45, general 0.45, roro 0.7,
  ferry 0.8, cruise 0.85, offshore 0.6, tug 0.9, workboat 0.75, pilot 0.95, fishing 0.75, special 0.7, motor_yacht 0.95,
  sail_yacht 1.0.
* `ballastMax = capacity × BALLAST[type]`, with BALLAST = bulk 0.45, tanker 0.40, gas 0.40, container 0.35, general 0.50,
  roro 0.25, offshore 0.30, ferry 0.10, cruise 0.10, fishing 0.15 (L ≥ 40 m only), special 0.20, workboat 0.20, else 0.
* `pumpTph = max(150, 0.25 × ballastMax)`, so a full fill takes about 4 h at most.
* Sailing yachts: `kTop = tDesign + max(mast.topmast ?? mast.top) + antenna 0.8` from `rigs.js` (y from the waterline,
  so the air draught equals masthead + 0.8 for any loading).

**Explicit rows** (these override the catalogue heuristic. **The catalogue file is not edited**: `airdraft.js` reads the model and
applies the row):

| id | tLight | tDesign | kTop (lowered) | up | hatchTop | holdTeu / deckSlots | ballastMax t | pumpTph | Air draught examples |
|---|---|---|---|---|---|---|---|---|---|
| coaster | 2.4 | 5.5 | 11.6 | wheelhouse +7.4 | 8.8 | 36 / 12 | 600 | 150 | ballast 600 t, lowered → **7.52**; empty, lowered → 8.95; laden 60 TEU → 9.72 |
| shortsea88 | 2.5 | 5.6 | 11.8 | wheelhouse +7.0 | 9.0 | 120 / 40 | 0.5 × cap | derived | — |
| sloop | 1.9 | 1.9 | 18.9 (= 1.9 + 16.2 + 0.8) | — | — | — | 0 | — | **17.0** |
| ketch | 2.3 | 2.3 | 21.95 | — | — | — | 0 | — | 19.65 |
| catamaran | 1.3 | 1.3 | 24.3 | — | — | — | 0 | — | 23.0 |
| schooner | 3.5 | 3.5 | 37.5 (topmast 33.2 + 0.8) | — | — | — | 0 | — | **34.0** |
| cruiser | 1.1 | 1.1 | 4.0 | arch +0.7 | — | — | 0 | — | 2.9 / 3.6 |
| flybridge18 | 1.5 | 1.5 | 5.9 | arch +1.2 | — | — | 0 | — | 4.4 / 5.6 |
| myacht | 1.8 | 1.8 | 7.8 | mast +1.5 | — | — | 0 | — | 6.0 / 7.5 |
| tug | 4.6 | 5.0 | 20.0 | — | — | — | 0 | — | 15.0–15.4 |
| pilot | 1.8 | 1.8 | 7.8 | — | — | — | 0 | — | 6.0 |
| new inland barges (§7.6) | per row | | wheelhouse hydraulic, masts fold | | | | | | |

**Player actions.**
* **Ballast** (`ballast {op}`): fill/empty at `pumpTph`, with time warp scaling like other consumption. Allowed only on classes with
  `ballastMax > 0`. Fill to a target, or stop.
* **Fold** (`fold {part, down}`): about 120 s hydraulic wheelhouse, 60 s masts or arch.
  * Allowed under way at up to 8 kn.
  * Not allowed while the stack top is more than 1.0 m above the lowered eye height (`kTop − 1.5`). The server answers "Raise the wheelhouse to see over
    the containers", and the ship stays raised.
  * Lowered wheelhouse: the camera "bridge" view drops by the same amount.
  * Sailing masts never fold in phase 1 (unstepping a mast is a yard service, Q8).
* `airDraftNow(p)` is in `sendYou` as `you.air = { ad, T, kTop, ballastT, ballastTarget, fold, deckTiers, need: ad + margin }`.

**Margin.** `AD_MARGIN = 0.30 m`, the Dutch practice of *schrikhoogte* (FIS clearances are published without it). Add to it the heave
allowance `0.5 × local Hs` (zero inland after §4.11). `need = ad + 0.30 + 0.5 × Hs`. The verdict `pass` means `need ≤ clrNow`. `tight` means
pass with `clrNow − need < 1.0`.

**Grounding** keeps using the class draft in phase 1 (no existing test changes). The live draught becomes the grounding and
planner draught in phase 2, behind `SALTLINE_LIVE_DRAUGHT=1` (Q5).

### 4.5 Passage verdict

`passVerdict(ship, bridge, span, t, state) → { verdict: 'under'|'tight'|'opening'|'never'|'closed', need, clrNow, clrOpenNow, why }`
* `under`: `need ≤ clrNow` (closed). Calling for an opening gets "you can pass under".
* `opening`: the span is movable and `need ≤ clrOpen(now)`.
* `never`: `need > clrOpen` (or the span is fixed and too low). The planner avoids it.
* `closed`: out of service or outside hours right now (with `nextService`).
* Also width: `ship.beam + 2 × 0.5 ≤ span.w`, otherwise `never` ("too wide"). Tidal: the planner checks the window (§4.10).

### 4.6 Bridge operation (`shared/waterworks.js bridgeStep`, server state machine in `server/waterworks.js`)

States per movable span: `closed → warn → opening → open → closing → closed`, plus `out` (damaged / out of service)
and `noservice` (outside hours).
* **Request.** A VHF call (or the push button) from a ship within 3 km on the approach whose verdict is `opening`.
  The request carries the ETA (distance / speed, minimum 60 s).
* **Scheduling.**
  * `tOpen = max(now + reaction, next slot, end of block, start of hours)`. `reaction` is 120 s for a manned bridge and
    300 s when the bridge is remote-controlled from a central post (FIS `operator` / remote flag; default 120).
  * Requests with ETA within `tOpen + 6 min` are bundled into the same opening (convoy).
  * Rail bridges with `slots` open only on slot boundaries (default every 30 min; Calandbrug: FIS hours, else slots 30).
* **Durations** (game rules from typical NL movable bridges):

  | mov | warn (red-green, barriers) | opening / closing |
  |---|---|---|
  | bascule | 60 s | 70 s each |
  | bascule2 | 60 s | 80 s each |
  | swing | 60 s | 90 s each |
  | lift | 60 s | `lift height / 0.25 m/s` each (Botlekbrug: 31 m → 124 s) |
  | pontoon / retract | 30 s | 60 s |
  | draw | 45 s | 45 s |
* **Open hold.** Until every bundled ship has passed the bridge line, or `maxHold` = 6 min (20 min for lift spans in a
  port), or a new block starts. Ships that did not show are told "next opening".
* **Out of hours.** Requests get "No service until HH:MM". Night-on-request bridges (`onRequestNight`) accept requests
  made at least `noticeMin` ahead.
* **Determinism.** The state carries `{st, t0, dur}`. Clients animate `frac = clamp((now − t0)/dur)`. The server tick is 10 Hz,
  and transitions are broadcast as `ww` deltas (§8.2).
* **Fleet ships** (AI captains) and game AI traffic request automatically through the same function, with no VHF text unless a player is
  in range, in which case the text is generated. **AIS ships never trigger openings** (their air draught is unknown); their positions only
  occupy space.

### 4.7 Collisions with bridges (`server/waterworks.js strikeCheck`, each tick, ships under way within 400 m of a bridge)

* **Test.** The ship's hull rectangle (length × beam, heading) overlaps the bridge deck footprint (line buffered by `deckW/2`)
  **and** `adNow + 0.5 × Hs > clrNow(span at that point)`. Outside the spans (over the piers) any overlap is a pier
  collision through the existing `collision` path.
* `overlap = adNow − clrNow` (m) and `v` = speed (kn). Effects by what sticks up (from the profile):
  * Sailing rig: overlap > 0 → **dismasted** (`rig_event` 'dismast': sails unusable, aux engine only, repair at a yard).
    Overlap < 0.3 at < 2 kn gives only a bent windex and VHF antenna (radio range × 0.3 until repaired).
  * Mast or radar (motor ships, top 2 m of kTop): radar off, VHF antenna (range × 0.3), cond −2 % per metre.
  * Wheelhouse (overlap > 2 m on a lowered profile, or more than the mast part): cond −(5 % × overlap × v/4), hull
    flooding 0, crew injury event, **the ship is stopped** (treated as an obstacle: speed set to 0, pushed back 2 m).
  * Containers: top tier → `deckSlots` TEU overboard (cargo lost and a pollution fine of 2,000 cr per TEU), then the wheelhouse rule
    if still above.
* **The bridge.** If overlap > 0.5 m it goes `out` for `30 min × min(4, overlap)`. That is server state, so **every player** sees two red
  lights and gets "out of service" on the radio. The damage bill is `fee = round(20 000 × overlap × max(1, v))` cr for rail/motorway (× 0.3 for foot
  bridges), charged to the company, with a politics/law hook `bridge_strike`.
* Client prediction stops the ship visually on contact. The server is authoritative.

### 4.8 Locks (full model)

#### 4.8.1 Data

```text
Lock {
  id, name, callName: "Rozenburgsesluis", src, e,
  ring: [[lat,lon]…],                         // complex outline (OSM)
  chambers: [{
    id: "A", kind: "commercial"|"small"|"both",   // small = sports-boat chamber (jachtensluis)
    len: 305, wid: 24, sillUp: 9.0, sillDn: 9.0,  // usable length/width (m); sill depth below that side's level (m)
    axis: [[lat,lon],[lat,lon]],              // centre line, head 0 → head 1
    gates: [{ head: 0|1, type: "mitre"|"sector"|"lift"|"rolling"|"drop", at: along m }],
    culvert: 0.7 * len*wid/400 (μa, m²),      // effective filling area (default rule, §4.8.4)
    bollards: { step: 15, floating: true|false, levels: 3 },
    waiting: [{ side: 0|1, pts:[[lat,lon]…], len: 150, kind: "commercial"|"small" }],  // waiting berths / remmingwerk
  }],
  sides: [{ name: "Calandkanaal", level: Level }, { name: "Hartelkanaal", level: Level }],
  doubleActing: true,                          // dubbel kerend: either side may be high
  vhf: 68?, call: "vhf"|"button", hours, blocks, fee: { commercial: 0, small: 0 },
  bridges: ["fis:…","fis:…"],                  // lock-head bridges (§4.8.7)
  notices: [{ from, to, text }],               // e.g. renovation closures (from FIS/BAS when live)
}
Level = { kind: "tidal" } | { kind: "kp", h: -0.40 } | { kind: "damped", of: "tidal", k: 0.6, lagMin: 40 }
```

**Rozenburgsesluis seed** (verified: 305 m × 24 m, CEMT VIc, double-acting, two bridges, 24/7 operation by the Port of
Rotterdam, renovation with planned closures in 2026–27):
* The Calandkanaal side is tidal.
* The Hartelkanaal side is `damped` (k 0.6, lag 40 min): game rule until FIS gives the real behaviour.
* Sill 9.0 m and VHF channel: **from the FIS fixture**. The tests use the synthetic seed values marked `synthetic: true` until the fixture is
  recorded (§10).
* The two bridges over the heads: lift type, closed 3.6 / open 24.0 m, as on the player's OpenSeaMap screenshot (smrender
  label "lft_closed/open"). Confirm with FIS/OSM in the fixture.
* Notices: if FIS/BAS says the lock is closed for renovation, the game follows reality (Q10).

#### 4.8.2 The cycle (per chamber, server state machine)

```
idle(side s, level = side s)
  → admit(s): signal green on side s, gates on s open; ships in the plan enter and make fast        (≤ entryMax 10 min)
  → closing(s): signal red; gates on s close                                                         (gate time)
  → levelling: chamber level moves from side s to side 1−s (§4.8.4), ships ride it                   (computed)
  → opening(1−s): gates on 1−s open                                                                  (gate time)
  → release(1−s): signal green for leaving; ships cast off and exit                                  (≤ exitMax 6 min)
  → idle(1−s)  → (if the queue on side s is not empty) turnaround: levelling empty back → admit(s)
```
* Gate times: mitre 120 s, sector 150 s, lift 90 s, rolling 180 s, drop 60 s.
* Planning: when the chamber is `idle` on one side and ships wait on the other, the operator does an empty turnaround
  (levelling without ships) if it has waited ≥ 5 min or the queue fills ≥ 60 % of the chamber area.
* Ships must be **made fast** to start the closing. The existing Moor key **T** inside a slot snaps to the slot's bollards,
  using the dock-anywhere style "make fast" with no fee. A ship that is not fast after `entryMax` is dropped from this cycle
  ("You lost your turn").
* Leaving early, before the green, is a BPR offence: warning, then a fine of 500 cr, with a law hook.

#### 4.8.3 Signals (per BPR / CEVNI, game mapping; §4.9)

On each head: `red` (closed / no entry), `red+green` (get ready, gates about to open), `green` (enter / leave), and the
out-of-service pair of §4.9. During levelling both heads show red.

#### 4.8.4 Levelling physics (real-time water level)

Filling or emptying through culverts or gate sluices, with constant discharge coefficient (orifice flow):
```
A   = len × wid                                (chamber water area, m²)
μa  = 0.7 × A / 400                            (effective culvert area × discharge coefficient, m²; data overrides)
Δh0 = |level(side s) − level(side 1−s)|        (at the start; tidal sides are re-evaluated each tick and the target follows)
T   = 2 A √Δh0 / (μa √(2g))                    (levelling time, s)
Δh(t) = (√Δh0 − μa √(2g) t / (2A))²           (remaining head; chamber level = target ∓ Δh(t))
```
* Rozenburg: A = 7,320 m², μa = 12.81 m², so Δh0 = 1.0 m → **T = 258 s**, and Δh0 = 0.25 m → **129 s**.
* Ships in the chamber are server state `p.lockStay = {lockId, chamber, slot}`: position held at the slot, `y` = the chamber
  level (like docked). The client renders the chamber water mesh at `level(t)` and moves the ship with it.
* Inflow: foam and particles at the culvert mouths, plus a weak surge that drives the ship along the chamber (cosmetic, ±0.3 m sway).
* **Zero lift** (both sides at the same level, which happens at tidal locks near high water): the gates may both stay open
  ("lock stands open", *door-schutten*). Signals green both ways, and ships simply pass.

#### 4.8.5 Queue and packing (`packChamber`, pure)

* Queue order: arrival registration time (VHF call or push button). Priority: passenger ships and ferries, then commercial,
  then small craft, matching normal Dutch practice. Fleet ships and players are equal.
* **Packing** (deterministic shelf/skyline):
  * Each ship is a rectangle `(L + 3) × (B + 0.6)`.
  * Ships are placed in queue order at the lowest along-chamber position where they fit without overlap.
  * The wall on the entering ship's starboard side is tried first, then port.
  * Small craft may lie only along a wall or alongside another small craft, never alongside a commercial ship.
  * Usable length is `len − 5` (gate recesses), usable width `wid − 1.0`.
  * A ship that does not fit waits for the next cycle. Later small craft may still fill gaps (back-filling is allowed only for small craft).
* **Fit test.** `L + 5 ≤ len`, `B + 1.0 ≤ wid`, `T + max(0.3, 0.05 T) ≤ sill depth at the lower level` (the sill depth at the current
  low side), and air draught against the lock-head bridges (§4.8.7).
* **AIS and other traffic.**
  * AIS ships inside the chamber polygon take space using their AIS length and beam (rectangles at their reported positions).
  * AIS ships within 1.5 km on approach heading to the lock are shown in the queue as "other traffic", estimated, but get no
    reserved slot.
  * Game AI traffic does not sail inland (`server/traffic.js`). Fleet ships are queued like players.

#### 4.8.6 Fees

* RWS locks: free (they are in reality).
* Port of Rotterdam locks: covered by harbour dues (free).
* Provincial and municipal small-craft locks with `fee` data: charged on release. The default for small craft at non-RWS locks with
  no data is 6 cr per passage. Commercial non-RWS locks with no data: 0.5 cr per metre of length.
* The fee shows in the queue answer ("lock fee 6 credits").

#### 4.8.7 Lock-head bridges (combined passages)

* Bridges with `lockId` are operated by the lock, not on their own channel. Each opens during `admit` / `release` of its head
  only if a planned ship needs it (verdict `opening`). Opening time is added to the gate time (parallel when the bridge sits
  outside the gate).
* `pairedWith`: at locks with a bridge on each head (Rozenburgsesluis), **one of the pair is always closed** so road traffic can
  use the other. The lock never opens both bridges at once. If the plan would need that, the second ship waits.
* A ship that fits under a lock-head bridge when closed does not trigger it.

### 4.9 Signals (BPR / CEVNI game mapping, `shared/waterworks.js SIGNALS`)

Verify against BPR (Binnenvaartpolitiereglement) art. 6.26 / 6.28a and Bijlage 7 before release (Q11). The game uses:

| Lights shown | Meaning | Used when |
|---|---|---|
| 1 red (or 2 red side by side) | passage / entry prohibited | closed, levelling, closing |
| 2 red one above the other | out of service | `out`, `noservice` |
| red + green (side by side) | prohibited now, get ready: about to open | `warn`, lock `admit` preparing |
| green (1, or 2 side by side) | passage / entry permitted | `open`, lock `admit` / `release` |
| 1 yellow (fixed bridge or fixed span) | recommended passage, two-way | `rec: 1` spans |
| 2 yellow side by side | recommended passage, oncoming traffic prohibited | narrow recommended spans (`w < 2 × (11.4 + 3)`) |

* Signals are mounted on both faces of the bridge at the movable span (on the pier, about 4 m above the water) and on both lock heads.
* They are server state (derived from the state), so every client shows the same colour.

### 4.10 CEMT classes, the inland graph and the route planner (`server/inland.js`, lane A)

CEMT table (`shared/waterworks.js CEMT`): length × beam × draught (max), standard bridge clearance.

| Class | Length | Beam | Draught | Bridge clearance | Typical |
|---|---|---|---|---|---|
| I | 38.5 | 5.05 | 2.5 | 4.0 | spits |
| II | 55 | 6.6 | 2.5 | 4.0–5.0 | kempenaar |
| III | 80 | 8.2 | 2.5 | 4.0–5.0 | dortmunder |
| IV | 85 | 9.5 | 2.8 | 5.25 / 7.0 | Rhine–Herne |
| Va | 110 | 11.4 | 3.5 | 5.25 / 7.0 / 9.1 | large Rhine vessel |
| Vb | 185 | 11.4 | 4.0 | 5.25 / 7.0 / 9.1 | push convoy 2 long |
| VIa | 110 | 22.8 | 4.0 | 7.0 / 9.1 | 2 abreast |
| VIb | 195 | 22.8 | 4.0 | 7.0 / 9.1 | 4-barge push |
| VIc | 280 | 22.8 / 34.2 | 4.0 | 9.1 | 6-barge push |
| VII | 285 | 34.2 | 4.0 | 9.1 | 9-barge push |

* **Graph.** Nodes are junctions, objects and sea gates. Edges are fairway sections, from FIS `fairwaysection` geometry with CEMT and
  max L/B/T, joined at shared ends within 25 m. Outside NL (phase 3) edges come from OSM `waterway=river|canal` lines with
  `CEMT` / `maxdraught` / `maxwidth`, connected the same way.
* **Objects on edges.** Fixed bridges `{min clr over spans, datum}`, movable bridges `{clr, clrO, hours, slots, reaction}`, locks
  `{chambers, cycle estimate}`. Each edge has a speed limit (FIS or CEMT default 18 km/h, 10 km/h in small canals) and a current
  (rivers: 0.5–1.5 m/s along the flow, phase 2).
* **Sea gates.** Nodes where the graph meets the sea graph (`server/lanes.js`): Maasmond / Hoek van Holland, IJmuiden,
  Den Helder, Harlingen, Lauwersoog, Delfzijl, Vlissingen, Terneuzen, Stellendam, Roompot, Den Oever, Kornwerderzand
  (the last two are IJsselmeer locks). The list lives in `server/waterworks/seagates-nl.json`.
* **Planner** `planInland(graph, from, to, ship, t0) → RouteV2-compatible {points, marks, warnings, eta}`:
  * A* on travel time. Edges are refused when `T + ukc > maxT`, `B > maxB`, `L > maxL`, any fixed bridge has `need > clr` at
    **MHWS** (conservative), or `need > clrO` at a movable bridge, or any lock chamber fails the fit test.
  * If no route exists, a second pass allows fixed bridges where `need ≤ clr at the lowest predicted level in the next 24 h`.
    Those edges get a **tide window** mark ("Pass Spijkenisserbrug between 13:10 and 15:40 (low water)").
  * Costs: movable bridge = `expectedWait` (half the slot interval or `reaction`, plus warn + opening) + the waits to opening hours at
    the ETA (forward pass). Lock = mean cycle `(2 × gate + T(Δh typical) + entry/exit 6 min) × (1 + queue factor 0.5)`.
  * `marks` add `{kind: 'bridge'|'lock', id, name, action: 'under'|'opening'|'lock', vhf, clr, need, waitMin, windowFrom/To}`.
    The HUD uses these for "call Botlekbrug on ch X about 10 min before".
* **Joining with the sea planner.** `planRoute` gains `opts.inland`. When either end is inland (a D14 mask of RIVER/LOCK/DOCK, or in a
  non-tidal pound), the planner plans `from → best sea gate` and `sea gate → to` on the graph and the sea part with the
  existing algorithm. It tries the 3 nearest sea gates and keeps the fastest. Runs in `routeworker` (graph shipped to the worker once).
* **Staande-mastroute.** This needs no special code. The air-draught rules route a 17 m yacht only through movable bridges. The
  route card names it when the route uses ≥ 3 movable bridges and the ship is sail ("Staande-mastroute").
* **Warp.** No warp above ×5 within 2 km of a movable bridge, lock, or fixed bridge with verdict `tight`. No warp at all inside a
  chamber or waiting area (new `WARP` conditions, §8.1).

### 4.11 Sheltered water: fetch-limited sea state (`shared/shelter.js` + `server/shelter.js`, lane A)

* `fetchAt(sample, lat, lon, windFromDeg)` casts 7 rays upwind (−30° … +30°, 10° apart) over the navigable mask (D14 tiles
  where loaded; the coarse world raster otherwise) in 25 m steps up to 20 km. A ray stops at the first non-navigable cell.
  The **fetch** F is the mean ray length. The result is cached per 200 m cell and 10° of wind direction for 10 min.
* **Exposed** (median ray ≥ 20 km): the open-sea values are kept unchanged. Open water is never altered.
* Otherwise:
  ```
  Hs_fetch = 0.0016 · U · √(F / g)                (JONSWAP fetch-limited, U = 10 m wind m/s)
  Tp_fetch = 0.2857 · (U / g) · (g F / U²)^(1/3)
  Hs = min(Hs_open, Hs_fetch);   swell = swell_open × exposure,  exposure = share of the 7 rays toward the swell
                                                                 direction that reach ≥ 20 km (0 inland)
  ```
* In a LOCK cell or a lock chamber: `Hs ≤ 0.05`, swell 0. In DOCK cells: `Hs ≤ Hs_fetch` with F capped to the dock length.
* Applied in `game.weatherFor(p)` (seaState, seaWord, waveH, wavePeriod, swellH, sea index) and in the physics env
  (`env.sea`, `env.waveH`). The client's `ocean.setSea` then gets the sheltered values. The chart's storm labels keep the
  open-sea values.
* Example: lock canal, F 300 m, wind 10 m/s → **Hs 0.088 m, "calm-rippled"**, Tp 0.90 s.

---

## 5. 3D (lane C: `public/js/wwmesh.js`, `public/js/wwhud.js`, `public/js/wwfmt.js`)

### 5.1 Ownership and data

* `wwmesh` draws **every bridge and lock from the registry objects** sent by the server (§8.2 `ww_static`). They are
  received for objects within 8 km (desktop) or 5 km (phone), and drawn in their own scene group, **not discarded inside harbour
  patches**.
* While the registry has not answered, the D14 vector bridge (v2 fields) is drawn by the same builder from the tile.
* `wtmesh.buildStructures` stops drawing a bridge deck when `vectors.bridges[i].id` is known to the registry. The integrator adds
  a `skipIds` option. The old slab remains the fallback for unknown ids.
* `harbor.js` road ribbons with `bridge: true` that lie within 20 m of a registry bridge line are skipped (`skipNear`
  callback, integration).
* The world frame matches the tiles: y = 0 is model MSL, so the deck underside at `clr + datumOffset` is right against the
  tide-moving water plane. **Visual clearance = physics clearance, to the centimetre.**

### 5.2 Bridges

* **Deck.** Swept cross-section along `line`. Thickness by kind and span: road girder `max(1.2, span/25)` m, rail girder
  `span/18`, foot 0.6 m. Parapets 1.1 m. Deck width `deckW`. Approach ramps: from the outermost pier on land, the deck
  descends at 4 % (road/foot) or 1.5 % (rail) to the ground height (D14 height grid). Underside colour is darker, with lane
  markings on top (road).
* **Structure.**
  * `truss` (rail span > 60 m, or tagged): Warren truss, height `span/8`, clamped 6–14 m, above the deck.
  * `arch`: a parabolic arch above.
  * `cable`: pylon + fan stays (Erasmusbrug-like) when tagged.
  * Default: plate girder.
* **Piers.** At both edges of every span over water (the opening edges `a`, `b`) and every 40 m on land and shallows. Rectangular
  2.5 × (deckW + 1) m with cutwaters, down to the bed (D14 height). Fender piles (*remmingwerk*) line movable openings.
* **Movable spans** (separate meshes with a pivot; animated by `frac` from the server state):
  * **bascule**: leaf = span (hinge side `hinge`, default the side nearer the operator house or the wider bank). Rotates
    0 → 82° about the hinge axis. A counterweight box behind the hinge drops. **bascule2**: two leaves meet in the middle.
  * **lift**: two lattice or concrete towers at `a` and `b`, height `clrO + deckThickness + 6` (machinery house), with cables.
    The span translates up by `clrO − clr`. The towers are drawn even when closed, which is what the player saw as "pillars".
  * **swing**: pivot pier at `pivot`. The span rotates 90° (the side is chosen to clear the recommended passage).
  * **pontoon / retract**: the section slides sideways by `w` (pontoon on the water, retract on rails).
  * **draw**: a small leaf hinged with chains (Dutch "ophaalbrug" with a balance beam: the beam and leaf rotate together).
* **Signals.** Per span face, two lamp housings (red / green, plus yellow for fixed recommended spans), emissive sprites with
  a glow at night, colour from §4.9 for the current state.
* **Clearance boards.** A white rectangular board centred over the span on both faces, with black text:
  * fixed: `"14.0"`;
  * lift: `"3.6 / 24.0"` (closed / open, as OpenSeaMap's `lft_%s/%s`);
  * bascule / swing: `"3.6 / –"`;
  * width board `"↔ 24.0"` when `w` is known;
  * estimate flag: grey board with `"≈ 2.5"`.

  Canvas texture, one per distinct string (cached). Readable from 300 m (board 3.0 × 1.0 m, text 0.6 m).
* **Clearance gauge** (*peilschaal*). A vertical white scale with black decimetre marks on the pier face at the opening. The number at
  the waterline is the current `clrNow`. It is drawn as a texture whose offset moves with the water level, so it is correct
  at any tide.
* **Air-draught overlay** (toggle in the air draught card, on by default within 1 km of a bridge with verdict ≠ `under`): a
  translucent horizontal plane at the ship's `need` height extending 200 m ahead under the bridge, green where it passes and red
  where it intersects the deck. It is exact because the same numbers drive both.
* **Ship model heights.** The ship meshes must agree with the profile. A test (§10.9) builds each class mesh
  (`public/js/shipgen.js` / `ship.js` builders headless) and checks the mesh top within ±0.5 m of `kTop − tDesign` (raised state). The
  wheelhouse and masts of foldable classes are separate nodes named `fold:wheelhouse`, `fold:mast`, `fold:arch`, animated
  by `you.air.fold`. This is a ships-lane request: wwmesh only reads the node names.

### 5.3 Budgets and LOD

| | Desktop | Phone |
|---|---|---|
| Objects drawn | ≤ 80 within 8 km | ≤ 30 within 5 km |
| Full detail (truss, parapets, piers, signals, boards, gauge) | ≤ 2.5 km | ≤ 1.2 km |
| Mid (deck box, towers, piers as boxes, signal sprites) | 2.5–8 km | 1.2–5 km |
| Triangles, all bridges + locks | ≤ 200 k | ≤ 60 k |
| Animated meshes | ≤ 2 per object (leaf/span + counterweight); gates 4 per chamber | same |
| Board textures | ≤ 64 (LRU) | ≤ 24 |
| Build cost per object | ≤ 4 ms on the main thread (or batch in `wtworker` later) | ≤ 8 ms, at most 1 object per frame |

Merged static geometry per object: one draw call for the static part, one per moving part. Materials are shared (concrete, steel
painted, steel lattice, asphalt).

### 5.4 Locks

* **Chamber walls.** Concrete walls along the chamber sides from the OSM ring (fallback: rectangle from the axis and width). The coping
  is 1.5 m above the highest operational level. The wall face goes down to the sill depth, with recesses for the gates.
* **Gates.**
  * mitre: two leaves meeting at 18° (closed) and swinging into recesses (open, 90°);
  * sector: curved leaves rotating into wall chambers;
  * lift: a vertical steel gate rising in a portal tower (its own clearance under the raised gate = `gate clr`, part of the fit test);
  * rolling: a box gate sliding into a gate dock;
  * drop: a lowering gate.

  Animated from the cycle state.
* **Water.** A chamber water mesh at `level(t)` (§4.8.4), replacing the global ocean inside the chamber footprint (the client
  `ocean2` gets a `masks` list of polygons to cut, the same mechanism as patch footprints). Foam texture and particles at the
  culverts while levelling, flowing in the right direction. A dark wet band on the walls above the low level.
* **Furniture.**
  * Bollards in wall recesses every 15 m at 3 levels; floating bollards in vertical slots when `floating: true`.
  * Ladders every 30 m. Signals and the lock-keeper's house on the head.
  * Waiting-berth dolphins and fender walls (*remmingwerk*) from `waiting`.
  * Lock-head bridges as in §5.2.
* Ships in the chamber ride the chamber level (client `ship.y = level` while `you.lockStay`; other ships from `ww` state).

### 5.5 HUD and cards (`public/js/wwhud.js`, pure formatting in `wwfmt.js`)

* **AIR field and next-3 strip**: `fmtAir(you.air)`, `fmtStrip(objectsAhead)`.
* **Bridge card**:
  * name, kind and source (official / OSM / est.), clearance now (closed/open) with the datum note ("14.0 m above NAP; water
    +1.2 → 12.8 m");
  * width, channel, hours today, blocks, next opening, queue;
  * the to-scale side view (SVG, ship silhouette from the profile: hull, superstructure, masts, stack);
  * a button "Call on ch X" that tunes the radio.
* **Lock card**: chambers with sizes and sill depth, the levels on both sides now, lift, cycle state, your place in the queue,
  a slot preview (a plan view of the chamber with planned rectangles), fee, channel.
* **Air draught card**: draught and air draught, ballast (bar, target, pump on/off, ETA), fold buttons, the overlay toggle.
* **Chart** (`hud.js` chart, integration): bridges as a line with a clearance label (red if `never` for you, amber `opening`),
  locks with the chamber symbol, VTS sector boundaries with their channel numbers, marinas (§7.5).

---

## 6. VHF simulation (lane B: `shared/vhf.js`, `shared/vhfphrases.js`, `server/vhf.js`, `public/js/vhf.js`, `public/js/vhffmt.js`, `public/js/radiosound.js`)

### 6.1 Channels (`shared/vhf.js CHANNELS`)

International marine VHF channels 1–28, 60–88 (simplex/duplex flags; duplex channels are coast-station channels: a ship
transmits on the ship side and hears the coast station's side; the game treats a channel number as one "net").

| Ch | Use in game |
|---|---|
| 16 | distress, urgency, safety, calling. Coast guard listens. Calling only: the coast guard asks you to switch after a call that is not distress |
| 70 | DSC only (no voice, the panel greys it out); the DISTRESS button |
| 13 | bridge-to-bridge navigation safety (sea, and port sectors without VTS) |
| 10 | ship-to-ship inland (NL), and "listen on 10 outside VTS sectors" in the Rotterdam port area |
| 6, 8, 72, 77 | inter-ship |
| 9 | secondary calling, marinas abroad |
| 31 | NL marinas (simulated; Q12) |
| data | bridges, locks, VTS sectors, harbour masters, coast stations (from the registry and `vts-*.json`) |

**Power.** "Hi" is 25 W, "Lo" is 1 W. Inland (in a non-tidal pound or on a CEMT fairway) the set switches to **1 W automatically on
ship-to-ship, nautical-information and port-operation channels**, as the RAINWAT arrangement requires. The UI shows "1 W (inland)".

### 6.2 Range and reception (`shared/vhf.js reach`)

```
horizon_km(h1, h2) = 4.12 (√h1 + √h2)                h = antenna height above water (m)
range_km = horizon_km × (power 25 W: 1.0 · 1 W: 0.35) × antennaDamage (1 or 0.3)
quality q = 1 − d / range  (d = distance); q < 0 → not heard; q < 0.15 → garbled (30 % of letters → '·')
```
* Antenna heights: ship = `adNow` (the whip is the top of the profile), capped at 40 m. Bridge or lock station: 15 m.
  VTS / coast station: 60 m.
* Terrain and buildings are ignored (Q13).

### 6.3 Stations

* **Waterworks operators.** Every bridge or lock with `call: 'vhf'` is a station `{id, callName, ch, pos, h: 15, hours}`. It answers
  only on its channel, only within range, only within hours (outside hours: no answer; push-button bridges show the button instead).
* **VTS sectors** (`server/waterworks/vts-nl.json`, polygons + channel + callName). Seed values from the Port of Rotterdam
  procedure (v1.4, 2023):
  * Maas Approach ch **1**; Oude Maas ch **62**; Maasbruggen ch **81**;
  * Traffic Control Rotterdam ch **11**;
  * Harbour Coordination Centre ch **14** (operational) and ch **19** (shipping messages);
  * ch **10** where no VTS sector applies.

  The remaining Rotterdam sector channels (e.g. Maasmond, Rozenburg, Botlek, Europoort, Waalhaven, Eemhaven) are filled from Annex 1 of
  the current procedure by the operator. Until then those polygons fall back to the nearest verified sector (`verified: false`
  entries are not loaded). IJmuiden, Den Helder, Vlissingen / Scheldt and Terneuzen follow later.
* **Coast guard.** "Netherlands Coastguard" (NL waters), and "<country> Coastguard" elsewhere as a generic station. Ch 16 plus DSC,
  coast stations along the coast every 60 km (synthetic positions on the coast, h 60 m).
* **Harbour masters / marinas** (§7): ch from data (`vhf`, `seamark:radio_station:channel`), else none (phone only).
* **Players.** Any player with the radio on; received on the tuned channel and on 16 if dual watch is on.
* **Fleet ships and game AI traffic** answer passing-arrangement calls with canned replies. **AIS ships are never made to speak**:
  they are real vessels.

### 6.4 Phrases and dialogue templates (`shared/vhfphrases.js`)

Phrases are ids with slots, rendered in **English (SMCP style)** or **Dutch** (inland, player setting `radio.lang`; default
English at sea, Dutch inland in NL when the UI language is Dutch, else English). The same template id goes over the wire,
and the receiver renders its own language.

Player phrases (context-sorted):
* `call` "{to}, {to}, this is {me}, {me}, over." (all others start with the station call)
* `req_open` "… {dirWord} at {where}, air draught {ad} metres, request bridge opening, over."
* `req_lock` "… {dirWord}, {shipType} {L} by {B} metres, draught {T}, request lock passage, over."
* `vts_report` "… {where}, {dirWord} to {dest}, draught {T}, over." (entering a VTS sector)
* `pass_port` / `pass_stbd` "… I will pass you port to port / starboard to starboard, over."
* `overtake` "… request to overtake you on your {side} side, over."
* `ack` "Received, {to}, out." and `say_again` "Say again, over."
* `mayday` / `panpan` / `securite` (structured: nature, position auto-filled, persons aboard).
* Free text (players only, ≤ 120 chars, rate-limited to 1 per 4 s, through the existing chat cleaner).

Operator replies (server, chosen by `shared/waterworks` verdicts):
* bridge, needs opening: "{ship}, {bridge}. Next opening {in} minutes at {hhmm}, you are number {n}. Wait {where}, over."
* bridge, fits: "{ship}, {bridge}. Clearance is {clr} metres now, you can pass under. {bridge} out."
* bridge, opening now: "{ship}, {bridge}, bridge is opening, proceed on green."
* bridge, block: "{ship}, {bridge}. No openings until {hhmm} ({why}). Wait south side, over."
* bridge, out of hours: no answer (realistic). After 2 unanswered calls the HUD tip says: "Out of service hours: {hours}".
  A night-on-request bridge says: "Opening at {hhmm}, with one hour notice."
* bridge, never (too high or too wide): "{ship}, {bridge}. Open clearance is {clrO} metres, you will not pass. Advise route via {alt}."
  (`alt` from the inland planner's best alternative).
* lock: "{ship}, {lock}. You are number {n} for chamber {A}, next {dirWord} cycle in {in} minutes. Make fast {side} side at
  the {where} waiting berth, over." Later: "{ship}, enter on green, make fast {side} side, {slot} metres from the {head} gate." "Gates
  closing." "Levelling, {Δh} metres, about {min} minutes." "Gates opening, leave on green, have a good trip." Fees: "Lock fee {fee} credits."
* VTS: "{ship}, {sector}. Roger, {dirWord} to {dest}. Traffic: {list of ≤3 ships within 3 km with names, from AIS/players}. {sector} out."
  Calling a VTS sector on the wrong sector's channel gets: "{ship}, you are in sector {x}, call on channel {y}."
  (VTS do redirect, realistically).
* Coast guard on 16 after a non-distress call: "{ship}, {cg}, switch to channel {67}, over."

**Wrong channel** (bridges and locks): no answer. **A call nobody can hear**: no answer, and the static tail plays.

**Timing.** The operator answers after 3–8 s (seeded by object id and minute), so it sounds like a person.

### 6.5 Server (`server/vhf.js`)

* `createRadio(game, ww)`.
* `tx(p, {ch, to, phrase, args, text})`:
  1. Validate the channel, the rate limit (1 per 2 s, 1 per 4 s for free text), and that the radio is on.
  2. Compute the receivers: players and stations with the channel tuned or dual-watched, and q > 0. Each receiver gets
     `vhf {ch, from, to, phrase, args, text, q, at}`. Garbling is done client-side from `q`.
  3. If `to` is a station, run its responder, which calls `ww.request(...)` / `ww.registerLock(...)` and schedules the reply.
* `tick(dt)` sends the scheduled operator replies and the lock-cycle announcements to ships in the plan (they receive only if tuned).
* `dsc(p, {kind, nature})`: distress → coast guard reply on 16 + the existing Mayday relay chat line (`game.js` about line 2141 pattern) +
  an event hook `sar_alert` for a later SAR feature. Urgency and safety get a coast guard acknowledgement.

### 6.6 Client (`public/js/vhf.js` UI, `public/js/vhffmt.js` pure, `public/js/radiosound.js`)

* **Desktop panel**: the radio front with channel display (big 7-segment style), Hi/Lo, DW 16, squelch, volume, the station list, the
  phrase list with filled-in preview, PTT, a log of received transmissions (channel, from, text, time; garbled where q is low).
* **Interior.** The VHF in the bridge interior (`ga.js` GMDSS station item) opens the same panel when clicked.
* **Phone**: handset button → bottom sheet; channel wheel; chips; big PTT; log.
* **Sound** (`radiosound.js`, its own WebAudio graph, no edit of `sound.js`):
  * squelch-open click; band-passed noise bed (300–3,000 Hz) at a level `(1 − q)` while a transmission plays;
  * squelch tail on release (120 ms noise burst);
  * a 1 kHz "roger" pip when the operator ends.
* **Voices**: optional browser `speechSynthesis` (setting "Radio voices", default on). Voice and rate per station seeded by
  id; Dutch voice for Dutch phrases. The speech cannot go through WebAudio, so the noise bed plays alongside.
* **Rules shown.** The station list shows only stations on the tuned channel (and "silent: out of hours"). The context chip for
  the next bridge or lock shows the right channel, so the player learns the rule without being stuck.

---

## 7. Inland harbours and marinas everywhere (lane D)

### 7.1 Sources

| Source | What | Licence |
|---|---|---|
| FIS `touristharbour` (lines/points), `berth` (*ligplaatsen*), `terminal` | NL tourist harbours, public berths with max L/B/T and duration, terminals | CC0 |
| OSM `leisure=marina`, `seamark:type=harbour` + `seamark:harbour:category` (marina, marina_no_facilities, fishing, ferry_terminal, container/bulk/tanker/passenger terminals…), `harbour=yes`, `landuse=port`/`industrial=port`, `mooring=*` (visitor/private/waiting/commercial), `seamark:small_craft_facility:category` (visitor_berth, fuel_station, water_tap, electricity, slipway, toilets, showers, boatyard, chandler, sailmaker…), `waterway=fuel`, `leisure=slipway`, `seamark:radio_station:*` / `vhf` | worldwide | ODbL |
| D14 tile vectors (`pontoons`, `quays`, `piers`) and `server/quays.js` runs | berth geometry | ODbL |
| CBS 84133NED | aggregate passant berths per region, used to check our counts (±30 %) | CC-BY 4.0 |
| Waterkaarten / ANWB Wateralmanak | — | **not used** (proprietary) |

The Overpass overlay query adds (lane A owns `wtsource.js` edits in integration, lane D supplies the clause):
`nwr["leisure"="marina"]`, `nwr["mooring"]`, `nwr["seamark:type"="small_craft_facility"]`, `nwr["harbour"="yes"]`,
`nwr["waterway"="fuel"]`. `seamark:type=harbour` is already there. `KEEP_TAGS` adds `leisure|mooring|harbour|seamark:harbour:.*|
seamark:small_craft_facility:.*|seamark:radio_station:.*|vhf|operator|website|capacity|fee|maxlength|maxwidth|maxdraught|CEMT`.

### 7.2 Streaming and memory

* **Generated per z12 square from that square's overlay** (and the NL FIS harbours that fall in it), exactly when the overlay
  arrives, and cached with it. Harbours are never all loaded at once.
* `server/minorharbours.js`:
  * `harboursIn(z12x, z12y)` and `near(lat, lon, rKm)` pull the squares within 25 km of each ship.
  * LRU with **≤ 3,000 harbours in memory** (about 1 KB each, so ≤ 3 MB).
  * `memguard` level `warm`: no new squares for background players. `shed`: drop to the squares under online players' ships.
* The NL FIS harbour list (about 1,200 entries, about 300 KB) is part of `nl-fis.json.gz` and indexed by z12 square at load. It is
  always available (small).
* Ids are stable: `mh:fis:<id>` / `mh:osm:<type><id>`. Duplicates are merged (FIS ↔ OSM within 150 m, same water body): FIS wins
  numbers, OSM wins name and geometry if FIS has none.

### 7.3 Tiers and classification (`shared/mharbour.js`, pure)

| Tier | Classified when | Berths |
|---|---|---|
| `marina` | `leisure=marina` / `seamark:harbour:category=marina*` / FIS touristharbour with > 20 places | boxes along OSM/D14 pontoons, generated deterministically along each pontoon edge, box length by marina size (8/10/12/15/20 m) with box width 3.0/3.5/4.0/4.5/5.5 m; plus a visitor quay if tagged |
| `passant` | FIS touristharbour "passantenhaven" / `mooring=visitor` / small_craft_facility visitor_berth, ≤ 20 places | quay or pontoon side, first come first served, rafting allowed (yachts ≤ 15 m, up to 3 abreast) |
| `city` | `mooring=*` quays in residential/commercial areas within 1 km of a town centre | quay runs from `server/quays.js` with class `city` |
| `inland_port` | `landuse=port` / `industrial=port` inland, FIS terminal / berth with commercial use, quays with cranes | quay runs (dock-anywhere), class terminal/industrial; berth length from the runs |
| `fishing` | `seamark:harbour:category=fishing` / `harbour:category=fishing` | quay runs |
| `ferry` | ferry terminals | no berth (landmark only) |

A harbour gets a name from OSM `name`, else the FIS name, else "{town} {tier word}" (reverse lookup from the nearest `place=*` in the
overlay; else "Harbour near {nearest named harbour}").

### 7.4 Fit and reachability

* The berth fit uses the existing `shared/quayrules.js` rules (`neededLength`, `neededDepth`, beam vs fairway width) plus box size
  (L ≤ box length + 1.5, B ≤ boxW − 0.4) for marinas.
* **Reachability**: `planInland(from ship, to harbour)` is run lazily for the selected harbour only (the card) and cached for 10 min
  per (ship profile, harbour). The answer is one of: `yes`, `with openings (n bridges, m locks, est. +{wait})`, `no: {first blocking object}`.

### 7.5 Services, fees, cards, markers

| Tier | Berth fee | Water/power | Fuel | Market | Repairs | Shipyard | VHF |
|---|---|---|---|---|---|---|---|
| marina | 1.6 cr per m length per night (+3 cr power) | yes | if tagged fuel_station | — | small (yachts only, `repair` × 1.3) if boatyard tagged | no (unless the yard is a named game yard) | data or ch 31 sim |
| passant | 1.2 cr/m/night | if tagged | — | — | — | no | data |
| city | 1.0 cr/m/night (yachts), quay fee rule for ships | — | — | — | — | no | none |
| inland_port | dock-anywhere quay fee | — | yes (by truck rule, ×1.08) | **small inland market** (§7.6) | mobile crew (×1.25) | no | port channel if data |
| fishing | 0.8 cr/m/night | yes | yes | fish only | small | no | data |

* Fees are paid like dock-anywhere (first night on making fast, the rest on leaving).
* Harbour sheet: `GET /api/mh/:id` builds it on demand (tabs: overview, berths, services, market (inland ports), jobs (if any), weather).
  The client reuses the harbour-sheet frame with `TIER_TABS`-like tab lists per tier.
* Chart: OpenSeaMap-style symbols (marina: yacht in a circle; passant: blue "P"; inland port: anchor; fishing: fish), shown at
  chart zoom ≥ 11 within the view, from `GET /api/mh?bbox`.
* 3D (lane C, `public/js/mharbour.js`):
  * a harbour-master hut with a flag at the entrance;
  * a blue "Passantenhaven" or marina sign board;
  * box markers (numbered posts) on finger pontoons generated from the berths;
  * the berth outline reuses dock-anywhere's green/amber outline.
* **The 336 named harbours** keep everything (full market, shipyard, jobs boards). A minor harbour within the port limits of a named
  harbour (`PORT_RADIUS_KM`) is a **sub-harbour**: its services are the named harbour's at the dock-anywhere tier for that
  distance, and its card links to the named harbour's sheet.
* `linkHarbour` (dock-anywhere) keeps linking quays to the named harbours. Minor harbours add a local services layer on top: the
  better of the two applies per service.

### 7.6 Inland contracts and barges

* **New ship models** (ships lane, file `shared/ships/barges.js`, wired into the catalogue in integration). Each has an air-draught
  row (hydraulic wheelhouse up/down +5.5 m, folding masts) and `cemt`:

  | Model | L × B × T | Capacity | CEMT |
  |---|---|---|---|
  | spits | 38.5 × 5.05 × 2.5 | 350 t | I |
  | kempenaar | 55 × 7.2 × 2.5 | 600 t | II |
  | dortmunder | 67 × 8.2 × 2.5 | 1,000 t | III |
  | Rhine–Herne vessel | 85 × 9.5 × 2.8 | 1,350 t | IV |
  | large Rhine vessel | 110 × 11.45 × 3.5 | 3,000 t | Va |
  | container barge | 135 × 11.45 × 3.7 | 208 TEU, 4 tiers | Vb-size motor vessel |
  | tanker barge | 110 × 11.45 × 3.5 | 2,800 m³ | Va |
  | 4-barge push convoy | 193 × 22.8 × 3.9 | 11,000 t | VIb |
* **Jobs** (`server/inlandjobs.js`, lane D):
  * Families `barge_bulk` (sand, gravel, grain, fertiliser, scrap → mapped onto existing goods where they exist: grain, steel,
    fuel, machinery, containers; new goods are Q14), `barge_container` (Rotterdam / Antwerp terminals ↔ inland container terminals, e.g. Nijmegen,
    Duisburg once DE is covered), `barge_tanker` (fuel).
  * Origin and destination are named harbours or minor `inland_port` harbours on the inland graph. Pay is computed from the planned
    inland route time (`planInland`) with the existing pay formula.
  * Eligibility adds CEMT class and air draught on the route (the route must exist for the ship).
* **Leisure**: `charter_day` (marina → marina ≤ 40 km, passengers, yachts only), `lesson` (reuse `LESSON_TASKS`: lock passage,
  bridge opening request, mooring in a box). These are posted on minor harbour boards (marina tier: ≤ 4 jobs).
* **Small inland market** at `inland_port`: 3–5 goods from the existing list, priced from the nearest named harbour × (1 ± 0.06)
  with a stock of 10 % of a regional harbour. No contraband, no shady tab.

---

## 8. Integration points, protocol, save format

### 8.1 Existing files touched (integration pass only, §9.6)

| File | Change |
|---|---|
| `server/wtsource.js` | `overlayQuery`: add `way["bridge:movable"]`, `nwr["seamark:type"="bridge"]` (already present), `way["man_made"="bridge"]`, the §7.1 harbour clauses, `nwr["CEMT"]` waterways. `KEEP_TAGS`: add `seamark:bridge:.*`, `bridge|bridge:movable|bridge:structure|layer|CEMT|maxlength|maxwidth|maxdraught|vhf|lock_name|lock_ref|operator|opening_hours` + the §7.1 keys. Bump `OV_SCHEMA` → 2 |
| `server/wtconvert.js` | `CONVERTER_VERSION = 2`. Bridges: use overlay `bridge` features and `bridge:movable`. Clearance from `seamark:bridge:clearance_height(_closed/_open)`, width from `clearance_width`. **Drop `maxheight`**. Fallback rules §3.6. Emit v2 fields (§4.2) and a stable `id` (`osm:` when joined, `ofm:` otherwise) |
| `public/js/wtmesh.js` | `buildStructures(tile, {skipIds})` skips bridge ids drawn by `wwmesh` |
| `public/js/harbor.js` | `addRibbon` skips bridge ribbons near registry lines (`skipNear` callback) |
| `public/js/ocean2.js` | `setCutouts(polys)` for lock chambers (or reuse the patch footprint path) |
| `server/game.js` | construct `ww = createWaterworks(this, fis)`, `radio = createRadio(this, ww)`, `mh = createMinorHarbours(...)`. Actions: `vhf_set`, `vhf_tx`, `dsc`, `ballast`, `fold`, `ww_query`, `mh_query`. Tick: `ww.tick(dt)`, `radio.tick(dt)`, `ww.strikeCheck(p)` per ship, ballast pumping. `weatherFor` → `shelter`. `sendYou`: `air`, `water`, `radio`, `lockStay`. `warpLimit`: new conditions (§4.10). `onState`: ships in a chamber are held like docked |
| `server.js` | routes `GET /api/ww?lat&lon&r`, `/api/ww/:id`, `/api/mh?bbox`, `/api/mh/:id`; attribution |
| `server/searoute.js`, `server/routeworker.js` | `opts.inland`, sea-gate join (§4.10). The worker receives the inland graph once |
| `public/js/main.js`, `hud.js`, `touch.js` | instantiate `Vhf`, `WwMesh`, `WwHud`, `MHarbour`. Keys §1.1. AIR field; chart layers. Phone handset button and AIR chip |
| `public/js/ship.js` | fold node animation (ships lane request: node names `fold:*`) |
| `shared/ships/index.js` | export `barges.js` rows (ships lane) |
| `server/quaygame.js` / `shared/quayrules.js` | minor-harbour services layer (§7.5), quay cut also inside lock chambers and waiting berths (already CUT.LOCK) |
| `server/jobsgen.js` | register the inland families from `inlandjobs.js` |

**No existing test is changed.** Every behaviour change sits behind new code paths that are off when the registry or data is
absent (`SALTLINE_WW_OFF=1` restores today's behaviour exactly).

### 8.2 Protocol

Client → server (action envelope `{t: 'action', action, …}` as in `net.action`):

| action | fields | reply / effect |
|---|---|---|
| `vhf_set` | `{on, ch, dual, power: 'hi'|'lo', lang}` | stored in `p.radio`; `you.radio` |
| `vhf_tx` | `{ch, to: stationId|playerId|null, phrase, args, text?}` | broadcast `vhf` to receivers; responder |
| `dsc` | `{kind: 'distress'|'urgency'|'safety', nature?}` | coast guard `vhf` + `event` |
| `ballast` | `{op: 'fill'|'empty'|'stop', target?}` | `you.air.ballastT` changes over time |
| `fold` | `{part: 'wheelhouse'|'mast'|'arch', down}` | `you.air.fold` after the fold time, or `event warn` |
| `ww_query` | `{lat, lon, r}` | `ww_static` |
| `ww_button` | `{id}` | push-button request (within 300 m) |
| `mh_query` | `{bbox}` | `mh_list` |

Server → client:

| t | fields |
|---|---|
| `vhf` | `{ch, from: {id, name, kind: 'player'|'bridge'|'lock'|'vts'|'cg'|'ship'|'harbour'}, to, phrase, args, text, q, at}` |
| `ww_static` | `{objects: [Bridge|Lock (as §4.2 / §4.8.1, compact)]}`: sent when objects enter 8 km, cached client-side by id + `rev` |
| `ww` | `{id, rev, st, t0, dur, sig: [{face, lights}], spans: [{i, st, t0, dur}], chambers: [{id, st, t0, dur, level0, level1, plan: [{ship, x, y, L, B}], queue: [{name, kind, n}]}], out?: {until, why}}`: on change for objects within 15 km |
| `strike` | `{id, part, overlap, damage, fee}` (also as `event`) |
| `mh_list` | `{harbours: [{id, name, tier, lat, lon, vhf, berths: n, sym}]}` |
| `you` (existing) | + `air`, `water`, `radio`, `lockStay`, `nextObjects` (≤ 3 ahead with verdicts) |

### 8.3 Save format (`data/state.json`, handled by the existing save code)

* Per player and fleet ship: `ship.ballastT` (t, default 0); `ship.fold = {wheelhouse: 0|1, mast: 0|1, arch: 0|1}` (default all up);
  `radio = {on: true, ch: 16, dual: true, power: 'hi', lang: 'auto', vol: 0.8}`; `lockStay = {lockId, chamber, slot, side}|null`.
* Global `ww = {v: 1, outages: {id: {until, why}}}` (strike outages survive a restart). Queues, cycles and bridge states are
  **not saved**: on restart all bridges are closed and all locks idle at their last side. A ship saved with `lockStay` is released on
  the side it was heading to with the chamber at that side's level (no free lift exploit: the side is the planned exit side,
  saved with it).
* Minor harbour berths reuse dock-anywhere's saved `berth` record with `berth.mh = id`.
* Migration: missing fields get the defaults above. The `state.json` version is bumped by one with a no-op migrator.

---

## 9. Lanes (disjoint files) and integration

### 9.1 Lane A: data, rules, server waterworks, inland routing, shelter

New files only: `scripts/fetch-fis.mjs`, `server/fis.js`, `server/waterworks/` (`nl-fis.json.gz`, `levels-nl.json`,
`seagates-nl.json`, `vts-nl.json`), `shared/waterlevel.js`, `shared/airdraft.js`, `shared/waterworks.js` (types, CEMT,
SIGNALS, `clrNow`, `passVerdict`, `bridgeStep`, `lockStep`, `levelTime`, `levelAt`, `packChamber`, `fitChamber`),
`server/waterworks.js` (`createWaterworks`: registry, join, request, registerLock, tick, strikeCheck, statics/deltas),
`server/inland.js` (`buildGraph`, `planInland`, `joinSeaGates`), `shared/shelter.js`, `server/shelter.js`.
Tests: `test/ww-airdraft.test.mjs`, `test/ww-rules.test.mjs`, `test/ww-locks.test.mjs`, `test/ww-registry.test.mjs`,
`test/ww-inland.test.mjs`, `test/shelter.test.mjs`, fixtures `test/fixtures/ww/*.json`.

### 9.2 Lane B: radio

`shared/vhf.js`, `shared/vhfphrases.js`, `server/vhf.js`, `public/js/vhf.js`, `public/js/vhffmt.js`, `public/js/radiosound.js`.
Tests: `test/vhf-range.test.mjs`, `test/vhf-phrases.test.mjs`, `test/vhf-server.test.mjs` (uses a stub `ww` with the lane A
interface below), `test/vhffmt.test.mjs`.

### 9.3 Lane C: 3D and HUD

`public/js/wwmesh.js` (pure geometry builders, `buildBridge(obj, lod) → {static, moving: [{node, pivot, axis}]}`,
`buildLock(obj, lod)`, `animate(obj, state, now)`), `public/js/wwhud.js`, `public/js/wwfmt.js`, `public/js/mharbour.js`.
Tests: `test/wwmesh-geometry.test.mjs`, `test/wwfmt.test.mjs`, `test/mharbour-view.test.mjs`.

### 9.4 Lane D: inland harbours and inland jobs

`shared/mharbour.js` (classify, berths from pontoons, fees, services), `server/minorharbours.js` (stream, LRU, merge,
sheet), `server/inlandjobs.js`, `shared/ships/barges.js` (rows only; coordinate with the ships lane owner).
Tests: `test/mh-classify.test.mjs`, `test/mh-stream.test.mjs`, `test/inlandjobs.test.mjs`.

### 9.5 Interfaces between lanes (frozen by this doc)

```js
// shared/airdraft.js
export const AD_MARGIN = 0.30;
export function profileOf(cls) → Profile
export function draughtNow(cls, { cargoT, fuelT, ballastT }) → T
export function deckTiers(cls, containersT) → n
export function airDraftNow(cls, { cargo, fuelT, ballastT, fold }) → { ad, T, kTop, deckTiers, need(Hs) }
// shared/waterworks.js
export function clrNow(obj, spanIdx, { h, frac }) → m
export function passVerdict(shipAir, obj, spanIdx, ctx) → { verdict, need, clrNow, clrOpenNow, why }
export function levelTime(A, mua, dh) → s;   export function levelAt(A, mua, dh0, t) → remaining head
export function packChamber(chamber, ships) → { placed: [{id, x, y}], waiting: [id] }
export const SIGNALS, CEMT
// server/waterworks.js  (createWaterworks(game, fis, { now }))
ww.statics(lat, lon, r) → [obj];  ww.state(id) → delta;  ww.stationsOn(ch, lat, lon) → [station]
ww.request(id, ship, eta) → { ok, verdict, n, tOpen, reason };  ww.registerLock(id, ship, side) → { ok, chamber, n, tCycle, fee }
ww.tick(dt);  ww.strikeCheck(p) → strike|null;  ww.onEvent(fn)   // 'opening','open','closed','levelling', for radio announcements
// server/inland.js
planInland(graph, from, to, ship, t0) → { points, marks, warnings, eta } | null
```

### 9.6 Integration pass (one agent, after A–D are green)

This pass applies §8.1 in order. The steps are:
1. wtsource/wtconvert, then a re-recorded Rotterdam fixture.
2. game/server wiring.
3. client wiring.
4. route planner join.
5. ships fold nodes and barges.
6. The browser checks of the acceptance list (§11).

---

## 10. Tests (node --test, expected numbers)

### 10.1 Air draught (`ww-airdraft.test.mjs`)

1. **Coaster, no cargo, no ballast, wheelhouse down**: DWmax = 1200 + 80 + 26 = 1306; DW = 80 + 26 = 106 → T = 2.4 + 3.1 ×
   106/1306 = **2.652**; ad = 11.6 − 2.652 = **8.948**; need = 9.248 → against a 9.0 m bridge: **`opening`/`never`** (fixed → never).
2. **Coaster in ballast (600 t)**: DW 706 → T = **4.076**; ad = **7.524**; need 7.824 ≤ 9.0 → **`under`** (margin 1.18 m, green).
3. **Coaster laden 720 t containers (60 TEU: hold 36, deck 24 = 2 tiers)**: DW 826 → T = **4.361**; stack top = 8.8 + 2 × 2.59 + 0.1 =
   14.08 > kTop 11.6 → ad = **9.719** → need 10.019 > 9.0 → **not under**.
4. Coaster 576 t containers (48 TEU, 1 deck tier): stack 11.49 < 11.6 → ad = 11.6 − 4.019 = **7.581** → under.
5. Coaster wheelhouse **up**, ballast 600: ad = 19.0 − 4.076 = **14.924**.
6. Sloop: ad = **17.0** at any load. Ketch **19.65**. Catamaran **23.0**. Schooner **34.0**.
7. Fold refused with 2 deck tiers (stack 14.08 > eye 10.1 + 1.0).
8. The catalogue's `airDraft` stat for non-overridden models is unchanged (no existing test changes): e.g. `bulker` profile ad at
   design draught equals `model.airDraft` ± 0.01.
9. Ballast pumping: coaster fill 0 → 600 t at 150 t/h takes **4.0 h** (sim), and ×20 warp takes 12 real minutes.

### 10.2 Bridges and water levels (`ww-rules.test.mjs`)

1. Botlekbrug (fixture: NAP, clr 14.0, clrO 45.0, 2 lift spans w ≈ 87): water +1.2 → clrNow **12.8**; −0.8 → **14.8**.
2. Coaster wheelhouse up in ballast (ad 14.924, need 15.224) at Botlekbrug, water +0.0 → **`opening`**. Same ship wheelhouse down (7.824) →
   **`under`** at any level between −1.5 and +3.0.
3. **Sloop 17 m at the Rozenburgsesluis lock-head bridge** (lift 3.6 / 24.0, water level 0 above its datum): need 17.3 > 3.6 → `opening`; 17.3 ≤ 24.0 → passes
   when open. It must wait for the opening: request at t=0, `reaction` 120 s → warn 60 s → lift 20.4 m / 0.25 = 82 s → open at
   **t = 262 s**, signal sequence red → red+green (t=120) → green (t=262).
4. **Schooner (34.3 need) at the same bridge**: `never` (24.0 < 34.3). At the Calandbrug (clrO ≈ 49.7 from the fixture): `opening`.
5. Calandbrug fixture: closed in **[10.5, 13.0]**, open **≥ 45** (FIS fixture; design values 11.7 / 49.7).
6. Datum MHWS conversion: a UK bridge, clr 10.0 MHWS, region M2 1.5 → offset +1.995; at h = 0 → clrNow **11.995**.
7. Out of hours: request at 23:00 to a 06:00–22:00 bridge → `{ok: false, reason: 'hours', next: '06:00'}`. Rush-hour block
   07:00–09:00 → `tOpen = 09:00`.
8. Bundling: two requests with ETAs 2 and 5 min → one opening. A third at 15 min → next opening.
9. Strike: sloop under a 12 m fixed bridge → `dismast`. Coaster with 2 deck tiers under a 9.0 m bridge at 3 kn → overlap 0.719 →
   the top tier (**12 TEU**) goes overboard; the stack is then 11.49 < kTop 11.6 and ad ≈ 7.6 < 9.0, so the wheelhouse rule does
   not apply. Bridge `out` for **21.6 min** (30 × 0.719); bill 20 000 × 0.719 × 3 = **43 140 cr** (road bridge).
10. Converter (v2) on a synthetic overlay node `seamark:type=bridge, category=lifting, clearance_height_closed=3.6,
    clearance_height_open=24.0, clearance_width=24.0` beside an OFM bridge line → vectors bridge `{clr: 3.6, clrO: 24.0, wO: 24, mov: 2,
    e: 1}`. The same without the node → `e: 2`, clr per §3.6 (small canal **2.5**). `KEEP_TAGS` keeps all four seamark keys and
    drops `maxheight` as a clearance source.

### 10.3 Locks (`ww-locks.test.mjs`): Rozenburgsesluis (dimensions real; sill 9.0 synthetic until the FIS fixture)

1. Levelling: A 7320, μa 12.81 → Δh 1.0 → **258 s** (±1); Δh 0.25 → **129 s**; levelAt(t = 129, Δh0 1.0) remaining head **0.25**.
2. Fit: feeder1000 134 × 22.5 × 7.6 → **fits** (22.5 + 1.0 ≤ 24; 139 ≤ 305; 7.6 + 0.38 ≤ 9.0). subpmax2800 (B 32.2) → **no (beam)**.
   panamax4500 → no. gc120 → fits.
3. Packing: queue [coaster, coaster, coaster, sloop, sloop] → **all 5 in one cycle** (3 × 93 = 279 ≤ 300; sloops at the far end, the second
   rafted to the first). Queue [feeder1000, coaster, coaster] → feeder + 1 coaster placed (137 + 93 = 230), **2nd coaster waits** (323 > 300).
4. Cycle: admit → closing (mitre 120 s) → levelling (258 s at Δh 1.0) → opening 120 s → release. Ships held at the slot with `y` =
   level. Not-fast ship dropped after 10 min.
5. Paired bridges: the plan needing both head bridges open at once → the second ship is deferred. Never both open.
6. Zero lift (|Δh| < 0.05) → `standsOpen`: both heads green.
7. AIS occupant (barge 110 × 11.4 lying at the head end) takes its rectangle: feeder1000 cannot lie beside it
   (12.0 + 23.1 > 23) and is placed behind it: 113 + 137 = **250 ≤ 300 → fits**.
8. Fees: RWS lock → 0. Municipal small-craft lock with no data → **6 cr** for a sloop.

### 10.4 Inland routing (`ww-inland.test.mjs`, small synthetic graph + a recorded NL subgraph fixture)

1. Synthetic: two paths A→B, one with a fixed 9.0 m bridge (short), one with a bascule (+12 min wait). Coaster ballast → short path.
   Coaster laden 2 tiers → bascule path with the mark `{action: 'opening', waitMin ≥ 12}`.
2. Sailing yacht 17 m: every fixed bridge on the chosen path has clr ≥ 17.3 (at MHWS) or is movable → "Staande-mastroute" label
   when ≥ 3 movable.
3. Schooner from Calandkanaal to Hartelkanaal (NL fixture) → avoids the Rozenburgsesluis bridges (24.0 open) → route via the Calandbrug
   or reports `null` with the blocking object named.
4. Tide window: a fixed bridge passable only below +0.5 → second pass gives a window mark.
5. Sea join: from the North Sea to a marina inside the IJsselmeer pound → enters via one of the sea gates (IJmuiden or Den Oever) and the
   route ends at the marina berth.

### 10.5 Shelter (`shelter.test.mjs`)

1. F 300 m, U 10 → Hs **0.0885** → Douglas **"calm-rippled"**; Tp **0.90 s**.
2. Basin F 2 km, U 15 → Hs **0.343** → "smooth".
3. Open sea (rays ≥ 20 km) → the open values are unchanged (equality).
4. LOCK cell → Hs ≤ 0.05, swell 0.

### 10.6 Radio (`vhf-*.test.mjs`)

1. Range: ship with ad 15 m ↔ bridge station (15 m): 4.12 × 2√15 = **31.91 km** at 25 W (1 W inland: **11.17 km**). Sloop (17.0) ↔ coast station (60) = 4.12 × (4.123 + 7.746) = **48.90 km**. Two coasters
   (ad 7.5 each) on ch 10 inland at 1 W: 4.12 × 2 × 2.739 × 0.35 = **7.90 km**.
2. Garbling: q 0.1 → 30 % of letters replaced (deterministic seed); q 0.5 → clean.
3. Wrong channel: a call to Botlekbrug on 16 → no station reply, `tip` after 2 tries. Correct channel → reply in 3–8 s with `n` and
   `in`.
4. VTS redirect: a report to Oude Maas (62) from inside the Maasbruggen polygon → "call on channel 81".
5. Dual watch: a receiver on ch 18 with DW gets ch 16 transmissions; without DW does not.
6. Phrase rendering EN/NL from the same id + args (snapshot strings).
7. AIS ships never appear as senders. Fleet ships do (passing replies).
8. DSC distress → coast guard reply + the `sar_alert` event.

### 10.7 3D geometry (`wwmesh-geometry.test.mjs`, headless builders)

1. Fixed bridge: deck underside y = clr + datumOffset (±0.01). Piers at both span edges. Tris within budget.
2. Bascule: at frac 1 the leaf tip is ≥ `w × sin(82°)` above the hinge. At frac 0 it is level with the deck.
3. Lift: span underside at frac 1 = clrO (±0.01). Tower top ≥ clrO + deck + 6.
4. Swing: the span axis rotates 90° at frac 1, and the opening polygon is free.
5. Board strings: lift "3.6 / 24.0", fixed "14.0", bascule "3.6 / –", estimate "≈ 2.5".
6. Lock: water mesh y = level(t). Gates closed/open angles. Floating bollards present only when flagged.
7. Phone LOD: the Rotterdam fixture with 30 objects ≤ 60k tris.

### 10.8 Harbours (`mh-*.test.mjs`, `inlandjobs.test.mjs`)

1. The classification table on tag fixtures (marina, passant, inland_port, fishing).
2. Marina boxes from a 100 m pontoon, both sides, box length 12 (box width 4.0) → **2 × floor(100 / 4.0) = 50 boxes**.
3. LRU: streaming 50 z12 squares with 100 harbours each keeps ≤ 3,000 in memory. `shed` drops to the online squares.
4. FIS ↔ OSM merge within 150 m gives one harbour with the FIS id.
5. Fees: sloop 11 m in a marina → **17.6 + 3 = 20.6 cr/night** (rounded **21**).
6. Inland job eligibility: a coaster cannot take a Vb container-barge route whose bridges need ≤ 7.0 m when its ad > 6.7. A kempenaar job
   to a CEMT II destination is refused for the large Rhine vessel.

### 10.9 Ship model heights (ships lane, run in integration)

For every class with a mesh: mesh top (raised) − waterline = `kTopUp − tDesign` ± 0.5 m. Lowered nodes give `kTop − tDesign` ± 0.5.

---

## 11. Acceptance checklist

- [ ] Production probe (§3.4) printed Botlekbrug 14.0 / 45.0, Calandbrug, Rozenburgsesluis. Field mapping recorded here.
- [ ] `npm test` green offline. **No existing test changed.** All §10 suites green.
- [ ] `SALTLINE_WW_OFF=1` → the game is identical to before (bridges as today, no radio stations, no shelter).
- [ ] Rozenburg / Calandkanaal in the browser:
  - the Calandbrug has a deck and towers;
  - the Rozenburgsesluis bridges show the "3.6 / 24.0" boards;
  - the gauge reads the clearance now;
  - no bridge exists without a deck (spot check of 30 bridges around Rotterdam).
- [ ] A sloop calls the lock-head bridge on the right channel, sees red → red+green → green, and the span lifts. A second player 2 km away sees the
      same motion at the same time (±1 s).
- [ ] Wrong channel: silence. Out of hours: the HUD tip.
- [ ] A coaster: empty, the strip shows red at a 9 m bridge; after ballasting, green. Loaded with 2 deck tiers: red, and the route planner goes
      round or via an opening.
- [ ] Lock passage end to end at the Rozenburgsesluis with 2 players and 1 AIS ship: queue, slots, the ship visibly rises/falls, the gates
      move, fees and radio lines are right.
- [ ] Strike: the dismasting scenario works. The bridge goes out of service for all players and two reds show.
- [ ] Lock canal sea state: "calm-rippled ≤ 0.1 m" in 10 m/s wind. The open North Sea is unchanged.
- [ ] Route: North Sea → Amsterdam marina → Rotterdam by inland waterways for a coaster with the wheelhouse down; for a 17 m sloop via
      movable bridges only.
- [ ] Marinas: ≥ 800 NL harbours discovered when sailing the main NL waterways (CBS passant capacity per province within ±30 %).
      Memory ≤ 3 MB for harbours; the server RSS increase ≤ 40 MB with the registry loaded.
- [ ] Desktop ≥ 60 fps at Rotterdam Botlek with 40 bridges in view. Phone ≥ 30 fps. No frame > 100 ms when an object is built.
- [ ] Attribution line present (RWS CC0 + OSM).
- [ ] BPR signal table checked against the official text (Q11).

---

## 12. Open questions with defaults

| # | Question | Default |
|---|---|---|
| Q1 | FIS dataservice path and field names (v1.4) differ from the assumptions? | The probe output decides. The game schema (§4.2/§4.8.1) is fixed and the normaliser adapts |
| Q2 | EuRIS for BE/DE/FR? | Phase 3, after the operator registers and confirms the terms. OSM until then |
| Q3 | Ship `nl-fis.json.gz` in the repo? | Yes if ≤ 5 MB. Otherwise the deploy fetches it into `data/waterworks/` |
| Q4 | Live FIS refresh in production? | Off (`SALTLINE_FIS_LIVE=0`). Monthly operator re-run of `fetch-fis.mjs` |
| Q5 | Use the live draught for grounding and the sea planner? | Phase 2 behind `SALTLINE_LIVE_DRAUGHT=1`, after the tests for existing grounding cases are re-baselined in a separate change |
| Q6 | Live water levels (RWS WaterWebservices)? | Off. `tide.js` + canal levels. Live gauges in phase 3 |
| Q7 | River stage (Rhine/Waal discharge) affecting clearances? | Ignored in phase 1 (constant 0 on non-tidal rivers). Clearances on the Waal are then optimistic; flagged `e` when FIS datum is a river gauge datum |
| Q8 | Sailing masts unstepped at a yard (*mast strijken*) to pass fixed bridges? | Phase 2 yard service: 2 h, 300 cr; the rig then reads ad = deck + 1.5 |
| Q9 | AIS ships trigger bridge openings? | No (air draught unknown). They only occupy chamber space and queue display |
| Q10 | Follow real closures (e.g. Rozenburgsesluis renovation 2026–27)? | Yes when FIS/BAS live data says so. With a static file: no notices. Operator flag `ww.ignoreNotices` for events |
| Q11 | BPR signal details (2 reds vertical vs side by side) | The §4.9 table, verified against the BPR text before release; one data table to change |
| Q12 | NL marina channel 31 | Simulated for marinas without data; the harbour card says "(simulated)" |
| Q13 | Terrain shadowing of VHF | Not modelled |
| Q14 | New inland goods (sand, gravel, fertiliser) | Not in phase 1. Map onto existing goods; the economy lane decides later |
| Q15 | Voice chat between players | No (text and canned phrases only; moderation cost) |
| Q16 | Language of operator lines | English at sea; Dutch inland in NL if the UI language is Dutch; player setting overrides |

---

## 13. Sources checked (2026-10-09)

* Rijkswaterstaat FIS datasets on data.overheid.nl (CC0): locks `49337-vaarweginformatie-sluizen`
  (https://data.overheid.nl/en/dataset/49337-vaarweginformatie-sluizen), berths `42655-fis-vnds---berth---punten`
  (https://data.overheid.nl/en/dataset/42655-fis-vnds---berth---punten), touristharbour `42657-fis-vnds---touristharbour---lijnen`
  (https://data.overheid.nl/dataset/42657-fis-vnds---touristharbour---lijnen); EuRIS operating-time sets (licence unknown)
  (https://data.overheid.nl/en/dataset/53978-vervoersnetwerken---reguliere-bedieningstijden-van-sluizen-en-bruggen---eurisportal).
* Vaarweginformatie downloads (operating times, FIS VNDS dataservice IRS v1.27): https://www.vaarweginformatie.nl/frp/page/downloads ;
  example bridge record (Dordrecht, VHF 71, night on request): https://www.vaarweginformatie.nl/frp/main/#/geo/detail/BRIDGE/19218
* Open-source use of the FIS API (bridges, openings, locks, operating times, VHF call-in points, berths; OSM has clearances on about 25 % of NL
  bridges): https://github.com/cedricziel/plotter/pull/15
* EuRIS portal and API intro: https://www.eurisportal.eu/api/intro ; Antwerp-Bruges bridges & locks API:
  https://portofantwerpbruges.com/en/our-port/open-data-platform/bridges-locks
* Botlekbrug 14 m closed / 45 m open, two lift spans of about 87 m: https://www.rijkswaterstaat.nl/wegen/wegenoverzicht/a15/nieuwe-botlekbrug ,
  https://open.rws.nl/publish/pages/33650/feiten_en_cijfers_botlekbrug.pdf
* Calandbrug 11.7 m closed / 49.7 m open (design): https://en.wikipedia.org/wiki/Calandbrug ,
  https://www.bruggenstichting.nl/images/bruggen2019/DeCalandbrug.pdf
* Clearance gauges (*peilschalen*) at bridges and "clearance without schrikhoogte" on Vaarweginformatie:
  https://www.rijkswaterstaat.nl/nieuws/archief/2024/07/peilschalen-bij-bruggen-belangrijke-informatie-voor-schippers ,
  https://www.rijkswaterstaat.nl/nieuws/archief/2025/05/storing-schinkelbrug-a10-hinder-voor-scheepvaart
* Rozenburgsesluis 305 × 24 m, CEMT VIc, double-acting, two bridges, 24/7: https://www.arcadis.com/nl-nl/nieuws/europe/netherlands/2023/1/renovatie-rozenburgsesluiscomplex ;
  renovation timing: https://breakbulk.news/port-of-rotterdam-completes-first-phase-of-rozenburgsesluis-renovation-launches-trial-of-new-mooring-system/ ,
  https://www.bairdmaritime.com/amp/story/marine-projects/marine-infrastructure/netherlands-rozenburg-lock-to-undergo-major-renovation
* Port of Rotterdam VHF procedure (VTS & HCC, 2023; ch 11 / 14 / 19; arrival sectors 1 / 62 / 81; ch 10 outside sectors):
  https://www.portofrotterdam.com/sites/default/files/2023-07/procedure-VHF-communication-VTS-HCC-2023-English.pdf ,
  https://www.portofrotterdam.com/en/contact-harbourmaster/vts-services-and-vhf-communication-procedure
* OpenSeaMap bridge tags and smrender labels (`lft_closed/open`, `opn_closed/-`): https://wiki.openstreetmap.org/wiki/Seamarks/Bridges ,
  https://wiki.openstreetmap.org/wiki/Key:seamark:bridge:clearance_height_closed , https://wiki.openstreetmap.org/wiki/User:Kannix/smrender
* PDOK NWB Vaarwegen (CC0): https://api.pdok.nl/rws/nationaal-wegenbestand-vaarwegen/ogc/v1/collections
* CBS marina capacity / passant berths (CC-BY 4.0) and Waterkaarten (subscription): https://data.overheid.nl/dataset/1233-particuliere-jachthavens--capaciteit-en-nevenactiviteiten ,
  https://theca.org.uk/system/files/Waterkaarten%20Nederlands%20Info%20Sheet_0.pdf
