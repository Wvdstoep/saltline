# Saltline HD asset plan — inventory of every low-poly / untextured item and how to make it photo-real

Repo surveyed: `saltline-sync2` (main, 4924dc8), three.js 0.160.0. Research only; no game code was changed.
Triangle counts are estimates from segment counts. Licences of named texture packs are **candidates, to verify** (ambientCG and Poly Haven publish under CC0, but check each asset page before shipping).

## Summary in plain words

Today almost nothing in Saltline uses a photo texture. Ships, harbours, towns, trees, people and rooms are built from boxes and cylinders, coloured by code, with clever shaders that paint rust, windows and wood on the fly. That is why it reads as "low poly": hard edges, no bumps, no real surface detail. The only real textures are the casino set, and that one crashed the browser because it loaded 73 full-size pictures (about 389 MB of graphics memory) plus a 176,000-triangle potted plant copied into every lounge.

The fix is not "more pictures" but "the right pictures, shared, compressed, and loaded in the right order":

1. One shared library of about 22 tileable materials (steel, concrete, brick, wood, foliage ...) used by everything, instead of a texture per object.
2. Compressed GPU textures (KTX2). three.js already ships the decoder in this repo; only the converter tool is missing. Compressed, the whole library costs about 90 MB on a desktop and 22 MB on a phone instead of 350 MB.
3. Better shapes where the eye lands: the player's ship hull, quays, buildings, trees, people. Shapes elsewhere stay cheap but get the textures.

Top 10 priorities (biggest visible gain first): (1) own ship hull and superstructure with real paint/plate normal maps, (2) casino repair, (3) quays, bollards and harbour buildings with concrete/brick/steel, (4) trees as photo billboards instead of faceted blobs, (5) city building facades with a window atlas, (6) interiors v2 atlas replaced by real material tiles, (7) people (crowd and captain) with a clothing/face atlas, (8) containers and cranes, (9) AI traffic ships (shared skin, same as item 1), (10) terrain ground detail (sand, rock, grass) near the shore.

Budget: about 200 MB desktop / 75 MB phone of GPU texture memory in total, inside the 256 / 96 MB limits, with room left for drapes and screens.

Honest limit: a phone browser cannot do film-quality rendering. It can do "looks like a real place from 20 m away". See §6.

---

## 1. Inventory per item

Columns: **State** = geometry; material; est. triangles. **Low-poly cause**. **HD plan** = geometry change + texture set (from the shared library §2 unless named). **Res** = desktop / phone texture resolution. **GPU** = extra memory beyond the shared library. **Pri** = 1 (player sees it constantly) to 4 (rare).

### 1.1 Ship exteriors (own ship, other players, yard) — `shipgen.js`, `shipgeom.js`, `shipskin.js`

| Item | Where (file:function) | State | Low-poly cause | HD plan | Res | GPU | Pri |
|---|---|---|---|---|---|---|---|
| Hull | `shipgen.js:buildHull` / `shipgeom.js:loftHull`; shader `shipskin.js` kind 1 | Lofted BufferGeometry, 45/19/9 stations, 9 rows below WL, 5 above; **no uv**; MeshPhysical (desktop) with fully procedural plates/rust/marks; ≈2.6k tris LOD0 | Rows too coarse (visible facets at bow/stern), flat transom, no bump map, procedural rust looks synthetic | Geometry: 90 stations LOD0 own ship, 13 rows below WL, flare/knuckle rows; keep LOD1/2. Textures via **triplanar in ship frame** (vShipPos already exists): `painted steel` normal + roughness, `rusted steel` albedo/normal blended by the existing procedural rust mask, `barnacle/slime` 512 band. Keep lettering/draft marks as is | 1K / 512 | shared | 1 |
| Deck plating | `shipgen.js:425`; kind 2 | Two-vertex strips; uv zeros | No camber, no plate seams | Add camber (3 verts across), use `non-slip deck` + `teak` library tiles in ship-frame UV (shipPos.xz) | 1K / 512 | shared | 1 |
| Superstructure tiers | `shipgen.js:tierSolid` + `facadeTexture` (1024² canvas) | ExtrudeGeometry, no bevel; canvas facade atlas; kind 3 | Sharp edges, windows are painted flat | Bevel 0.1 m (ExtrudeGeometry bevel 2 seg); replace canvas with **ship-facade atlas 2K×1K** (photo windows, 4 bands, alpha mask kept: 1 wall / 0.75 glass / 0.5 lit) + normal map for frames; `painted steel` roughness | 2K×1K / 1K×512 | 4 MB / 1 MB | 1 |
| Wheelhouse, glass, mullions | `shipgen.js:buildBridge` | boxes; glass boxes | Glass stuck on box | Keep; glass gets `glass` library roughness + env; mullions from the atlas normal | – | – | 2 |
| Funnel | `shipgen.js:buildFunnel` + `markTexture` 256² | Extrude 4 seg, boxes | No lip/cowl, box band | Lathe profile with lip; `painted steel` + soot (keep procedural); mark decal 512 | 512 / 256 | 1 MB | 2 |
| Hatch covers | `shipgen.js:buildCargo 'holds'` | boxes + rib boxes | Pure boxes | Keep boxes, add `painted steel` normal with rib pattern (triplanar) | – | shared | 2 |
| Container stacks | `shipgen.js:stackBox` + `containerTexture` 512² | one box per stack, canvas atlas | No gaps, doors, corner castings | **Container atlas 2K** (photo sides + doors + roof, 16 colours) albedo+normal+ORM; one box per *column*, UV per box; shared with harbour and city containers | 2K / 1K | 8 MB / 2 MB | 2 |
| Tanker/LNG deck, pipes | `shipgen.js:915-955` | rods 6 seg, capsules | Faceted pipes | Pipes 10 seg LOD0; `painted steel` + `galvanised` tiles; flanges as instanced rings | – | shared | 3 |
| Deck cranes, winches, bollards, masts, A-frame | `shipgen.js:buildDeckGear` | boxes/cylinders | Box jibs | Lattice jib (instanced struts), 12-seg pedestal; `painted steel` yellow tinted + `rusted steel` at joints | – | shared | 3 |
| Lifeboats, davits | `shipgen.js:boat` | capsules + box | Capsule hull | Lathe hull profile 16×8; `gelcoat orange` tile; davit beams keep | – | shared | 3 |
| Handrails | `shipgen.js:buildRails` (LOD0 desktop only) | square beams | Square section, no stanchion detail | Instanced 6-seg tube + stanchion; `galvanised` | – | shared | 3 |
| Propeller, rudder, bulb | `shipgen.js:431-445` | disc, box, ellipsoid | Disc propeller | Real 4-blade (lathe + twist, 400 tris), only visible in dry dock/yard; `bronze` tile | – | shared | 4 |
| Cruise lido, loungers | `shipgen.js:buildLido` | ≤300 lounger boxes, 14-seg pools | Box loungers | Instanced lounger mesh (120 tris); pool water uses ocean-style normal; `teak`/`non-slip` | – | shared | 2 |
| Anchors | `shipgen.js:anchors` | boxes + disc | Box flukes | One 600-tri stockless anchor mesh (hand-modelled or lathe+extrude); `rusted steel` | – | shared | 3 |
| Hull lettering / draft marks | `shipskin.js:acquireLettering` R8 1024×256 | fine | – | Keep (already HD; own ship 2048×512) | – | 0.5 MB | – |
| Sailing yachts | `rigmesh.js` hull 3.2k tris, canvases 512² stripes/sails, 256² deck | OK geometry | Flat sail cloth, canvas deck | `teak` tile for deck, `sailcloth` 1K (seams, translucency alpha), `gelcoat` hull | 1K / 512 | 2 MB | 2 |

### 1.2 AI traffic, AIS, tugs, hostiles, rescue, wrecks, platforms — legacy `ship.js` builders

| Item | Where | State | Low-poly cause | HD plan | Res | GPU | Pri |
|---|---|---|---|---|---|---|---|
| AIS/traffic hull (≤64 full models, 250 rendered) | `ship.js:merchantHull`, `extrudeHull`; `ais.js` LOD <4 km | ExtrudeGeometry outline 12 seg, vertical sides, ≈300 tris; skin shader | Flat bottom, no sheer/flare, hard edges | Route AIS classes to **shipgen** loft at LOD1 quality (0.6k tris) with the same triplanar hull materials; keep extrusion only for far box LOD | shared | 0 | 2 |
| AIS far box (4–15 km) | `ais.js:244-255` | InstancedMesh prism + box, flat colour | Fine at that range | Keep | – | 0 | – |
| Legacy superstructure | `ship.js:superstructureBlock` | box + 0.14 m window boxes, no facade map | Box with strip windows | Apply the ship-facade atlas (same as 1.1) | shared | 0 | 2 |
| Legacy deck containers | `ship.js:containerBays` | box per container, 8 flat colours | No texture | Container atlas (1.1) | shared | 0 | 2 |
| Crew figures on deck | `ship.js:435` | capsules + sphere, ≈200 tris | Mannequins | Use the people atlas (1.4) on a 900-tri low body; LOD to billboard >100 m | shared | 0 | 3 |
| Warships (patrol, corvette, frigate) | `ship.js:warship` | merchant hull + boxes, flat grey | Boxes | Shipgen loft; `painted steel grey` + `non-slip`; turret lathe + barrel 12 seg; radar lattice | shared | 0 | 3 |
| Pirate skiff, cutter, SAR lifeboat | `ship.js:885-927` | extruded hull, boxes, drums | Boxes | Lathe hulls (400 tris), `gelcoat`, `rubber` RIB tube, drum tile 256 | 256 | 0.2 MB | 3 |
| Helicopter | `ship.js:945` | capsule body, rod boom, 4 box rotor | Capsule | 1.5k-tri lathed fuselage + window mask, `painted metal` + decal 512 | 512 | 0.5 MB | 4 |
| Derelict / wreck | `ship.js:978`, `buildWreck` | tilted extrusion, flat `P.rust` | Flat rust colour | Shipgen hull with `rusted steel` at 100 % + `barnacle` band | shared | 0 | 4 |
| Offshore platform | `ship.js:buildPlatform` | rods 10/6/4 seg, boxes, torus helideck | Rod lattice, flat colours | Keep lattice (instanced tubes 8 seg); `rusted steel`, `painted steel yellow`, `grating` tile for decks, helideck decal 1K | 1K | 1.5 MB | 3 |
| Tug (own and others) | `tugs.js` via `buildShip('tug')` | legacy builder | As above | Shipgen tug model; tyre fenders as torus 12×8 with `rubber` | shared | 0 | 2 |
| Smoke/fire, muzzle flash, splash | `shipsmoke.js`, `hostile.js:111` | Points 128² puff, spheres/cones | Spheres as flashes | Keep Points; 512 **FX atlas** (smoke puffs, fire, splash, flash, 4×4 frames) with alpha | 512 / 256 | 1 MB | 3 |
| Nav lights, labels | `ship.js:navLight`, `makeLabel` | sprites, canvases | Fine | Keep | – | – | – |

### 1.3 Interiors v2 (`iv2draw.js`, `iv2atlas.js`, `iv2items.js`, kits) and bridge

| Item | Where | State | Low-poly cause | HD plan | Res | GPU | Pri |
|---|---|---|---|---|---|---|---|
| Material atlas (every surface) | `iv2atlas.js:atlasCanvas` 8×8 tiles of 128 px (64 phone); `iv2draw.js:v2Materials` | 1024² canvas, procedural speckle; albedo only; baked vertex light | 128 px per material = blurry at 1 m; no normal/roughness | Replace by a **2D texture array** (`DataArrayTexture`, or compressed array if KTX2 array upload works in r160; fall back to a 4K atlas of 512 px tiles) of 48 real tiles: albedo, normal, ORM layers; keep the `aTile` shader path (layer index instead of rect). Tiles from the shared library (§2) plus interior-only: lino, carpet, ceiling panel, laminate, stainless, console, bedding, grating | 512 per tile / 256 | 48×3×0.35 MB ≈ 50 MB desktop (compressed) / 12 MB phone | 1 |
| Walls, floors, ceilings | `wallFace :1007`, floors `:1226` | zero-thickness quads | No skirting depth, no panel joints | Keep quads; normal map carries panel joints; add 0.08 m skirting box in all rooms (already in lined rooms) | shared | 0 | 1 |
| Doors (frames + instanced leaves) | `doorFrame :1422`, `buildDoorLeaves :1493` | 4 boxes + 1×1×1 box leaf | Plain slab | Leaf keeps box; `ship door` tile 512 (porthole, dogs, handle) albedo+normal; frame bevel | 512 | 1 MB | 2 |
| Windows / portholes | `windowFrame :1432`, `glassMesh :1482` | boxes + 2-tri glass 0.18 opacity | Rectangular only, no porthole | Round porthole shape (ring 16 seg) for cabins; glass gets env reflection + `glass` roughness | – | 0 | 2 |
| Stairs, rails | `drawStair :1447`, `drawRailV2 :1474` | box treads, 4–5-seg rods | Faceted rods | Rods 8 seg LOD0; `chequer plate` tile on treads; `stainless` on rails | shared | 0 | 2 |
| Bunks, beds, sofas, chairs, tables | `FAC.*` 208–260 | 3–6 boxes each, 40–90 tris | Sharp boxes, no cushions | Bevelled boxes (BoxGeometry → `RoundedBox` helper, 3 seg) for cushions/mattress; `fabric`, `leather`, `bedding`, `veneer` tiles | shared | 0 | 2 |
| Galley appliances | 262–268 | stainless boxes, line decals | Doors drawn as lines | `stainless` normal with brushed grain; appliance front atlas 1K (oven door, fridge handle, hob) | 1K / 512 | 1.5 MB | 3 |
| Bathroom | `FAC.wc`, `basin`, `shower` | white boxes | WC/basin as boxes | Two lathe/extrude meshes (WC 300 tris, basin 200) in a small glTF; `ceramic` tile; mirror = env reflection | – | 0.3 MB | 3 |
| Bridge consoles, screens | `FAC.console`, `screenTile :951`; legacy `bridgeCockpit.js` 512×320 canvases | box bodies, static screen tiles | Static radar/ECDIS pictures | Live canvases already exist in bridgeCockpit (keep); console `console` tile 1K with buttons normal | 1K / 512 | 1.5 MB | 2 |
| Engine room | `drawME2s :886`, `drawGenset :934`, pipes `drawRun` | boxes, 6–14-seg cylinders, 4–8-seg rods | Boxy blocks | Keep blocks; `engine green painted` + `galvanised` + `grating`; pipes 8 seg; flange rings instanced | shared | 0 | 3 |
| Cruise venues (pool, theatre seats, bar, chandelier, dance floor) | 347–853 | boxes; pool = flat blue tile | Pool water flat; seats boxes | Pool: small ocean-style water plane with `water normal` 512 animated; seats instanced 150-tri mesh with `velvet`; chandelier keep crystals + emissive; `marble`, `brass`, `carpet` tiles | 512 | 0.5 MB | 2 |
| Plants / palm (non-casino) | `FAC.plant :329`, `FAC.palm :782` | cylinders + 16 frond quads | Flat boxes | Frond quads get `palm frond` alpha card 512 + normal; plant cards from the **foliage atlas** (§2) | shared | 0 | 3 |
| Casino room (summary only — already handed to the casino builder) | `iv2pbr.js`, `iv2poker3d.js`, `iv2draw.js:1161-1375` | Real 1K JPG sets ×73 loaded uncompressed and duplicated (≈389 MB), 2nd WebGL renderer for poker, `potted_plant_01` 176k tris per palm, no phone path, no dispose | Too heavy, not low-poly | Share one material cache; fold its 7 materials into the library (carpet, felt, leather, walnut, marble, brass, wood panel); KTX2; 1 renderer; replace plant with 3k-tri card plant; dispose on leaving the zone | 1K / 512 | ≈12 MB / 3 MB | 1 |

### 1.4 People

| Item | Where | State | Low-poly cause | HD plan | Res | GPU | Pri |
|---|---|---|---|---|---|---|---|
| Cruise crowd (≤110 desktop / 32 phone) | `iv2crowd.js:poseGeometry`, 11 instanced poses | sphere head 12×10, cylinder limbs; MeshBasic flat colours; **no uv**; ≈610 tris | Flat faces/clothes, rigid poses | Keep instancing and pose set. Replace primitives with one **900-tri low body per pose** (exported once from a free CC0 base mesh, e.g. Quaternius / Kenney characters — candidate, licence to verify) with UVs onto a **people atlas 2K** (8 skin tones, 16 outfits, 8 faces; albedo + normal); per-instance atlas offset replaces per-instance colour | 2K / 1K | 6 MB / 1.5 MB | 2 |
| Captain avatar | `avatar.js:makeAvatar` ≈35 meshes, 1.8k tris, 7 materials | Cylinder torso, sphere head | No face, no hands, 35 draw calls | Single 4–6k-tri skinned glTF (CC0 base mesh + uniform painted in the people atlas) with 3 clips (idle, walk, run) via AnimationMixer; keep gait bob API | shared | 1 MB | 2 |
| Ashore pedestrians (10–30) | `avatar.js:Crowd` 6 InstancedMeshes capsules | Capsules | Mannequins | Same body + atlas as the cruise crowd | shared | 0 | 3 |
| Crew on deck, boarders, skiff men | `ship.js:435`, `hostile.js:183` | capsules | Mannequins | Same body + atlas | shared | 0 | 3 |

### 1.5 Harbours and marinas — `harbor.js`, `mhgeom.js`, `ashore.js`

| Item | Where | State | Low-poly cause | HD plan | Res | GPU | Pri |
|---|---|---|---|---|---|---|---|
| Quays, piers | `harbor.js:addHardRing` (extrudeRing, world UVs exist) | flat slab −3..2.65 m, flat colour | Untextured concrete, no coping | `concrete quay` (albedo/normal/ORM) on sides with waterline `slime/algae` band (shader by y), `asphalt` or `paving` top, coping box with bevel | shared | 0 | 1 |
| Bollards (≤1500), rings, fenders (≤2500) | `:241-243` | 8-seg cylinders, torus, box | 8 sides, box fenders | InstancedMesh: bollard 300-tri lathe (`cast iron painted`), ring torus 8×12, cylindrical fender 12 seg (`rubber`) | shared | 0 | 1 |
| Breakwater + rocks | `addBreakwater`, dodecahedra | faceted d12 | Faceted rocks | Instanced 3 rock meshes (icosahedron detail 2 displaced, ≈320 tris) with `rock` tile triplanar; jittered prism keeps `rubble` | shared | 0 | 2 |
| Pontoons, piles, cleats | `addPontoon` | boxes, 7-seg piles | – | `weathered wood planks` top, `galvanised` piles 10 seg | shared | 0 | 2 |
| Harbour buildings (≤320) | `addBuilding` + `facade()` 512² canvases (office, shed) | walls with UVs, canvas facade | Painted windows, stretched V on tall sheds | **Facade atlas 2K** (4 styles × 2 variants: office glass, brick, plaster, shed cladding; photo-based, with normal + emissive-lit) ; fix V to floors (tile per 3.2 m); roof `bitumen`/`metal roof` tiles; parapet box | 2K / 1K | 8 MB / 2 MB | 1 |
| Tanks | `addTank` | 20-seg cylinders | Smooth shell | 32 seg + weld rings; `painted steel white` + rust streaks (reuse ship rust shader kind 5); ladder as instanced rods | shared | 0 | 2 |
| Gantry cranes (≤14) | `addGantryCrane` | ~30 boxes, 4 calls | Solid boxes | Keep boxes for legs; add lattice boom (instanced struts); `painted steel` + `rusted steel`; crane decal 512 | 512 | 0.3 MB | 2 |
| Light towers, IALA buoys (≤80) | `addLight`, `addBuoy` (own materials each) | cylinders/cones; several draw calls per buoy | Many materials | One shared buoy material with the `painted steel` tile + vertex colour bands; instance by type | shared | 0 | 3 |
| Container stacks (≤70 stacks) | `addContainerStacks` | boxes, flat colour | No corrugation | Container atlas (1.1) | shared | 0 | 2 |
| Street lamps, benches, posts | `harbor.js:244`, `ashore.js:buildProps` | 6-seg poles, boxes | Box heads | Instanced 200-tri lamp mesh; `galvanised`, `painted steel` | shared | 0 | 3 |
| Roads, sidewalks, parking, land use | `ashore.js:buildRoads/Areas` (UVs in metres) + 256² canvases | 256² canvas speckle | Blurry at 1 m | `asphalt`, `paving`, `gravel`, `grass` library tiles (1K); markings stay as decals | shared | 0 | 2 |
| Parked cars (≤320) | `ashore.js:buildProps` 3 instanced meshes, ≈196 tris | 2 boxes + glass box | Boxes | 3 car body meshes ≈1.2k tris (CC0 low-poly car packs — candidate) with a 1K car atlas; instanceColor kept | 1K / 512 | 1.5 MB | 3 |
| Bridge cars | `wwmesh.js:makeCars` single box | box | Box | Same car meshes | shared | 0 | 3 |
| Ashore trees (≤1100) | `ashore.js:1048` icosahedron(1.9,1) | faceted crown | Faceted | Same tree billboards as city (1.6) | shared | 0 | 2 |
| Marinas (pontoons, hut, flag, fuel) | `mhgeom.js`, no UV, vertex colour, face-baked shade | boxes | No textures | Add UVs in the Geo builder (planar per face, metres); `weathered planks`, `galvanised`, `plaster` for the hut; flag as cloth quad 8×6 with wind | shared | 0 | 2 |
| Locks and bridges | `wwgeom.js` (no UV), `wwmesh.js` | boxes, 8/16-seg piers, vertex colours; boards 480×160 canvases | Flat concrete | Add planar UVs per face; `concrete` (walls, wet band via y), `painted steel` (gates, leaves), `asphalt` (deck), `timber` (fender piles); keep boards/gauges as canvases | shared | 0 | 2 |

### 1.6 World land — `terrain.js`, `wtiles.js`, `wtmesh.js`, `cityscape.js`, `citymesh.js`

| Item | Where | State | Low-poly cause | HD plan | Res | GPU | Pri |
|---|---|---|---|---|---|---|---|
| Coarse terrain L0/L1 (64² cells) | `terrain.js:480-548` | vertex colour bands + z11/13 map drape | Far only | Keep; satellite drape is the right answer at this range | – | drape ≤ 2×16 MB | – |
| Harbour patch ground (448² @ 10 m) + D14 tiles | `terrain.js:addPatch`, `wtiles.js:makeTerrainMaterial` | Lambert vertex colour, z18 satellite box, procedural "rock" hash; **no uv**, `vWorldPos` available | Satellite is 0.6 m/px: blurry at walking distance; land classes are flat colours | **Detail layer**: triplanar `sand`, `grass`, `rock`, `soil` 1K tiles blended by land class + slope (uses `vWorldPos`), fading out beyond 300 m into the drape. Phone: 512 and only `grass`+`rock` | 1K / 512 | shared | 2 |
| City buildings (≤6000/tile) | `citymesh.js:125-198`, shader `cityscape.js:makeBuildingMaterial` (`fac` = metres along/up) | one quad per edge, procedural window grid, 8 styles | Flat walls, no depth, no cornice, synthetic grid | Keep one draw call/tile. Replace the procedural grid with the **facade atlas 2K** (1.5): albedo+normal+emissive, sampled by `fac.xy` per style row; add parallax-less "window inset" via the normal map; roofs `bitumen`/`tile roof`/`metal roof` by style; keep night-lit mask. Pitched roofs keep | 2K / 1K | shared with 1.5 | 1 |
| City trees (≤6000 + 7000 sat trees) | `cityscape.js:cityAssets` icosahedron/cone/box fronds, Lambert vertex colour, ≈40–92 tris | Faceted crowns | **Billboard trees**: 2 crossed cards + 1 horizontal (6 tris) with a **tree atlas 2K** (8 species × 2 views, alpha + normal + translucency; CC0 candidates: Poly Haven does not supply tree cards — sources to check: "ambientCG Foliage*" packs, opengameart CC0 tree sprites, or render our own from CC0 tree models) ; LOD0 <80 m optional 3D canopy: 6 card clusters (≈60 tris) with `foliage` alpha tile. Phone: cards only | 2K / 1K | 6 MB / 1.5 MB | 1 |
| Containers (≤3500) | `cityscape.js:containerMesh` (uv kept) | box + rib shader | No doors | Container atlas (1.1) | shared | 0 | 2 |
| STS/portal cranes, tanks, lighthouses, beacons (instanced) | `wtiles.js:179-215` (no uv) | boxes, 24-seg tanks, Lambert | Flat colours | Planar UVs on the box builder; `painted steel`, `rusted steel`, `painted steel white` for tanks; lighthouse `plaster white` + `painted bands`; stays instanced | shared | 0 | 3 |
| Quays/piers/breakwaters/bridges in world tiles | `wtmesh.js:465-581` | vertex greys, no uv | Flat | Triplanar `concrete` by `vWorldPos` (same shader path as terrain detail); bridges get `asphalt` top | shared | 0 | 2 |

### 1.7 Sky, weather, water (mostly already procedural and fine)

| Item | Where | State | Plan | Pri |
|---|---|---|---|---|
| Sky dome, clouds, stars, Milky Way, planets | `sky.js`, `clouds.js`, `celestial.js` | Physically based shaders, 3D noise; no images | Keep. Optional: 1K equirect **moon albedo** (NASA LRO, public domain — verify) to replace the procedural maria (0.7 MB) | 4 |
| Rain, snow, spray | `weather.js` | instanced quads / Points | Keep; spray uses the FX atlas (1.2) | 4 |
| Ocean foam | `ocean2.js:foamBody/foamFilm/foamStreaks`, shore field DataTexture 448² | Procedural | Keep; optional 512 `foam detail` grayscale for the near field (0.2 MB) | 4 |

---

## 2. Shared texture library

Rule: every item above samples one of these; only atlases (facade, container, tree, people, FX) are extra. All tileable, metre-scaled (one tile = 2 m unless noted), maps packed as **albedo (sRGB)**, **normal (GL, linear)**, **ORM (AO/roughness/metal in RGB)**. Sizes assume KTX2: albedo + ORM as ETC1S (≈0.5 byte/px), normal as UASTC (1 byte/px), ×1.33 mips → **≈3.5 MB per 1K set, ≈0.9 MB per 512 set**. Uncompressed JPG for comparison: 16 MB per 1K set (why the casino crashed).

| # | Material | Used by | Candidate source (licence to verify) | Desktop | Phone | MB desk | MB phone |
|---|---|---|---|---|---|---|---|
| 1 | Painted steel (white, tintable) | hulls, houses, tanks, cranes, gates | ambientCG `Metal032` / `PaintedMetal007`; Poly Haven `painted_metal_shutter` | 1K | 512 | 3.5 | 0.9 |
| 2 | Rusted steel | wrecks, platform, blend layer | ambientCG `Rust004`, `Metal037` | 1K | 512 | 3.5 | 0.9 |
| 3 | Galvanised / brushed stainless | rails, piles, galley | ambientCG `Metal007`, `Metal046A` | 1K | 512 | 3.5 | 0.9 |
| 4 | Non-slip deck paint | ship decks | ambientCG `PaintedMetal013` + procedural grain kept | 1K | 512 | 3.5 | 0.9 |
| 5 | Teak planks | yacht/cruise decks, interior | Poly Haven `wood_planks` / ambientCG `WoodFloor051` | 1K | 512 | 3.5 | 0.9 |
| 6 | Weathered wood planks | pontoons, piers, fenders | ambientCG `Planks021`, `Wood026` | 1K | 512 | 3.5 | 0.9 |
| 7 | Concrete (quay, lock, wall) | quays, locks, piers, bridges | ambientCG `Concrete034`, Poly Haven `concrete_wall_008` | 1K | 512 | 3.5 | 0.9 |
| 8 | Asphalt | roads, quay tops, bridge decks | ambientCG `Asphalt012`, Poly Haven `asphalt_02` | 1K | 512 | 3.5 | 0.9 |
| 9 | Paving / cobbles | sidewalks, old quays | ambientCG `PavingStones070` | 1K | 512 | 3.5 | 0.9 |
| 10 | Brick | harbour/city facades (atlas base), warehouses | ambientCG `Bricks075`, Poly Haven `red_brick` | 1K | 512 | 3.5 | 0.9 |
| 11 | Plaster / render | houses, huts, lighthouse | ambientCG `Plaster001`, Poly Haven `plastered_wall` | 1K | 512 | 3.5 | 0.9 |
| 12 | Corrugated cladding / metal roof | sheds, roofs, containers base | ambientCG `CorrugatedSteel005` | 1K | 512 | 3.5 | 0.9 |
| 13 | Bitumen / tile roof (2-in-1, half each) | roofs | ambientCG `RoofingTiles012`, `Asphalt` | 1K | 512 | 3.5 | 0.9 |
| 14 | Glass (roughness/dirt only, 1 map) | all windows | procedural + `glass dirt` 512 | 512 | 256 | 0.4 | 0.1 |
| 15 | Carpet | cabins, casino, theatre | ambientCG `Carpet012` (already in repo), `Carpet008` | 1K | 512 | 3.5 | 0.9 |
| 16 | Fabric / velvet | sofas, seats, bedding | ambientCG `Fabric028` (in repo), `Fabric062` | 1K | 512 | 3.5 | 0.9 |
| 17 | Leather | chairs, rails | ambientCG `Leather034C` (in repo) | 1K | 512 | 3.5 | 0.9 |
| 18 | Felt (casino) | tables | ambientCG `Fabric028` tinted (reuse #16 with tint) | – | – | 0 | 0 |
| 19 | Brass / bronze | rails, props, propeller | ambientCG `Metal048A` (in repo) | 512 | 256 | 0.9 | 0.25 |
| 20 | Chrome / polished (env-driven; roughness map only) | fittings | procedural | 256 | 256 | 0.1 | 0.1 |
| 21 | Wood veneer / walnut | furniture, bar | Poly Haven `black_walnut_veneer_01` (in repo), ambientCG `Wood051` | 1K | 512 | 3.5 | 0.9 |
| 22 | Marble | casino, atrium | ambientCG `Marble014` (in repo) | 1K | 512 | 3.5 | 0.9 |
| 23 | Lino / vinyl floor, ceiling panel (2-in-1) | crew spaces | ambientCG `Tiles074`, `OfficeCeiling005` | 1K | 512 | 3.5 | 0.9 |
| 24 | Chequer plate / grating (2-in-1) | engine room, stairs, platform | ambientCG `MetalPlates006`, `MetalWalkway` | 1K | 512 | 3.5 | 0.9 |
| 25 | Rubber | fenders, RIB tubes, mats | ambientCG `Rubber004` | 512 | 256 | 0.9 | 0.25 |
| 26 | Foliage card (generic leaves, alpha) | plants, palm fronds, 3D canopy | ambientCG `Foliage*` / opengameart CC0 | 1K | 512 | 3.5 | 0.9 |
| 27 | Bark | 3D trunks near camera | ambientCG `Bark012`, Poly Haven `bark_willow` | 1K | 512 | 3.5 | 0.9 |
| 28 | Sand | shores, beaches | ambientCG `Ground054`, Poly Haven `sand_01` | 1K | 512 | 3.5 | 0.9 |
| 29 | Rock | cliffs, breakwaters | ambientCG `Rock030`, Poly Haven `rock_face` | 1K | 512 | 3.5 | 0.9 |
| 30 | Grass / soil (2-in-1) | land, parks | ambientCG `Grass004`, `Ground037` | 1K | 512 | 3.5 | 0.9 |
| | **Library subtotal** | | | | | **≈95 MB** | **≈24 MB** |

Atlases (extra): ship-facade 2K×1K 4 MB/1; building facade 2K 8/2; container 2K 8/2; tree 2K 6/1.5; people 2K 6/1.5; interior tile array 50/12 (overlaps library — if the array is built *from* the library tiles the overlap is zero and this drops to ≈15/4); FX 512 1/0.3; misc decals (funnel marks, helideck, car atlas, appliance fronts) ≈6/2. **Atlas subtotal ≈ 90 MB desktop (55 if the interior array reuses library tiles) / 22 MB phone.**

Already-there dynamic textures to keep budget for: satellite drapes (boat z18 ≈ 24 MB RGBA at 3k×2k desktop; 2048² = 16 MB phone), patch drape, region drape (≈ 2×16 MB), interior lettering/screens (≈ 4 MB), weather DataTextures (<1 MB), PMREM env (2 MB).

**Totals: desktop ≈ 95 + 55–90 + 65 drapes ≈ 215–250 MB (inside 256 MB); phone ≈ 24 + 22 + 32 ≈ 78 MB (inside 96 MB).** The casino today alone is 389 MB uncompressed if all its files are loaded once.

---

## 3. Loading strategy (what avoids the casino crash)

1. **One material registry** (`public/js/matlib.js`, new): `getMaterial(name, {tint, repeat})` returns a shared `MeshStandardMaterial`; textures are loaded once per name and ref-counted. Never call `TextureLoader.load` from a builder again (today: `iv2pbr.js:31`, `iv2poker3d.js:299`, `bridgeCockpit.js:15`, `interior.js:450` each load their own copies).
2. **KTX2/Basis.** The transcoder is already served: `node_modules/three/examples/jsm/libs/basis/basis_transcoder.{js,wasm}` → reachable at `/vendor/three/addons/libs/basis/` because `server.js:159` maps `/vendor/three/addons` to `examples/jsm`. Use `KTX2Loader.setTranscoderPath('/vendor/three/addons/libs/basis/').detectSupport(renderer)`; it picks ASTC on phones, BC7/BC1 on desktop, ETC2 on Android GPUs. **No converter is installed** (`toktx`, `basisu`, `gltf-transform` all absent; only express/three/ws in package.json). Needed, on a machine with disk space (the dev disk has ~390 MB free): KTX-Software `toktx` (`toktx --t2 --encode etc1s --genmipmap --assign_oetf srgb out.ktx2 in.png`; normals `--encode uastc --assign_oetf linear`), or `basisu -ktx2 -mipmap`, or `npm i -D @gltf-transform/cli` (which still shells out to toktx). Fallback without a converter: WebP at half resolution (desktop 1K→ still 5.3 MB each uncompressed; the budget then only holds with 512 desktop / 256 phone). Run the conversion on the VPS or in CI, commit only `.ktx2`.
3. **Background decode.** For any non-KTX2 image use `ImageBitmapLoader` (`createImageBitmap` with `imageOrientation:'flipY'`, `premultiplyAlpha:'none'`) — `terrain.js:106` already does this for map tiles; textures then upload off the main thread's decode path. Limit to 2 concurrent uploads per frame (a small queue) so a zone build never stalls a frame >8 ms.
4. **Phone tiers.** One flag already exists in pieces (`isTouch()`, `IS_PHONE`, `IS_COARSE`, `lowPower`). The registry reads one `quality` value (`desktop`, `phone`) and requests `_512.ktx2` instead of `_1k.ktx2`; anisotropy 4 phone / 8 desktop; no normal maps for library entries ≥ 50 m away categories (terrain detail off on phone beyond `grass`+`rock`).
5. **Dispose by zone.** Interiors: on zone unload release the zone's refs; the registry disposes a texture when refs hit 0 and it is not in the "always" set (library 1–12). Harbours: `userData.dispose()` already exists (`harbor.js`), extend to release atlas refs. AIS pool: textures are shared, nothing to free. Casino: one renderer only (`iv2poker3d.js` must draw into the main renderer or a render target, never a second `WebGLRenderer`); `scene.environment` restored on exit.
6. **Geometry cap per glTF**: refuse any prop over 20k triangles at load (log and use the fallback box); decimate `potted_plant_01` (176k) offline or drop it.
7. **Streaming order**: library 1–12 + ship-facade atlas at boot (≈45 MB desktop, 12 MB phone, ≈1.5 s on 4G compressed); harbour set (concrete, asphalt, facade atlas, container, tree) when a harbour patch loads; interior set when going below; casino set when entering the casino room; dispose interior/casino on leaving the ship.

---

## 4. Phased order of work (visual gain per MB)

| Phase | Work | MB desk/phone | Why first |
|---|---|---|---|
| 0 | Material registry + KTX2 loader + quality flag; casino repaired onto it (share, 1 renderer, plant swap, dispose) | 12 / 3 | Stops the crash; everything after depends on it |
| 1 | Own ship: triplanar hull/deck/house materials (#1–5), bevelled tiers, ship-facade atlas, denser loft rows for the own ship | 20 / 5 | The player stares at it all day |
| 2 | Harbour: concrete quays, bollard/fender instancing, building facade atlas, asphalt/paving ashore, container atlas | 25 / 6 | Every arrival and departure |
| 3 | Trees → billboards + tree atlas (city, sat trees, ashore) | 6 / 1.5 | Biggest change in the look of the whole world per MB |
| 4 | City buildings on the facade atlas + roof tiles; terrain detail layer (sand/grass/rock) | 12 / 3 | Fills the coast line |
| 5 | Interiors v2 atlas → texture array of real tiles; bevelled furniture; porthole shape; doors | 15–50 / 4–12 | Cruise and walk mode |
| 6 | People: atlas + low bodies for crowd, pedestrians, deck crew; captain glTF | 7 / 2 | Faces are what people photograph |
| 7 | AIS/traffic/tugs/warships onto shipgen + shared skin; wrecks, platform | 0 / 0 | No new textures, geometry only |
| 8 | Locks/bridges/marinas UVs + materials; cars; lamps | 2 / 0.5 | Inland players |
| 9 | FX atlas, moon albedo, foam detail | 2 / 0.5 | Polish |

Each phase ships behind the quality flag and is measured with `renderer.info.memory.textures` and `programs` in the existing `?diag=1` panel before merging.

---

## 5. Geometry rules that apply everywhere

- Round things: 8 seg phone / 16 seg desktop LOD0, never 4–6 near the camera; one instanced tube geometry for all pipes/rails.
- Boxes the player can touch (furniture, bollards, hatch edges): bevel 2–3 cm (3 segments) so the normal map and specular catch light.
- One draw call per material per zone/tile stays the law (current `Parts`/`PartBuilder`/`Geo` mergers keep it; just add a `uv` and a `tangent`-free normal-map path — three's derivative tangents work without a tangent attribute).
- Triplanar for geometry without UVs (hull, D14 structures, quays in world tiles) using the frame positions already in the shaders (`vShipPos`, `vWorldPos`).
- LOD: textures fade to their average colour beyond ~300 m (the city shader already does this for its grid); normal maps off at LOD1.

## 6. What cannot be photo-real in a browser (especially on a phone)

- **No real-time global illumination or soft shadows** on phones: the main scene has no shadow map at all today (`main.js`); adding one costs 2–4 ms desktop and is not worth it on phones. Interiors keep baked vertex light; rooms will look "clean 3D", not ray-traced.
- **Trees** are cards; close up (<5 m) they are visibly flat. Real 3D foliage for 13,000 trees is impossible on mobile.
- **People** at 900 tris with an atlas look like good game characters, not film. Faces do not animate.
- **Satellite ground** at 0.6 m/px is blurry when walking; the detail layer hides it only partly, and the drape itself already costs 16–24 MB.
- **Water** is already the strongest part; its realism is bound by the lite/basic tiers on weak GPUs, not by textures.
- **Memory**: iOS Safari kills a tab at roughly 1–1.5 GB total; 96 MB of textures plus geometry (50 MB tile budget) plus canvases is near the comfortable ceiling, so the phone tier must stay at 512 px.
- **No converter on this machine and no free disk**: the KTX2 step must run on the VPS or CI; until then only the 512 px desktop tier fits the budget.
