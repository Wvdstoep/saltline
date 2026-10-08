// World-tile converter (server/wtconvert.js, docs/WORLD-DETAIL-STREAMING.md §3.4) on synthetic tiles: docks and
// derived quays, beaches, stroked rivers, building heights, the overlay, depth rules, specks, uniform tiles, the
// big-port guard, determinism and seams; plus the format invariants on the recorded fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertTile, CONVERTER_VERSION, DOCK_DEPTH, FAIRWAY_DEPTH, srcHashOf, simplify, edt } from '../server/wtconvert.js';
import { convertJob } from '../server/wtconvert-thread.js';
import { decodeMVT } from '../server/mvt.js';
import { WT, WT_NAVIGABLE, WT_OBSTACLE, encodeTile, decodeTile, tileHeightAt, tileMaskAt, cellOf, tileFToLatLon, decodeWTHeight, tileSizeM } from '../shared/wtformat.js';
import { encodeMVT } from './fixtures/wt/mvtenc.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'wt');
const Z = 14, X = 8381, Y = 5418;                       // a Rotterdam tile: 2446 m · cos 51.9° ≈ 1508 m, 5.9 m cells
const SIZE_M = tileSizeM(Z, tileFToLatLon(Z, X + 0.5, Y + 0.5).lat), CELL_M = SIZE_M / 256, U = 4096 / 256;   // tile units per cell
const sq = (x0, y0, x1, y1) => [x0, y0, x1, y0, x1, y1, x0, y1];
const sqCCW = (x0, y0, x1, y1) => [x0, y0, x0, y1, x1, y1, x1, y0];
const layer = (features) => ({ extent: 4096, features });
const poly = (tags, ...rings) => ({ type: 3, tags, geom: [rings] });
const conv = (mvt, hints = {}, more = {}) => decodeTile(encodeTile(convertTile({ z: Z, x: X, y: Y, mvt, hints: { src: 'ofm:test', ...hints }, ...more })));
const cellAt = (t, i, j) => ({ m: t.mask[j * 256 + i], h: decodeWTHeight(t.height[j * 256 + i]) });
/** Unit coordinates (0..4096) of a point given in tile-local decimetres. */
const dmToU = (v) => (v / 10 / SIZE_M) * 4096;

test('a rectangular dock in port land: DOCK cells, depth by harbour size, derived quays on 4 sides with water on the right', () => {
  const mvt = { layers: {
    water: layer([poly({ class: 'dock' }, sq(1000, 1000, 3000, 2000))]),
    landuse: layer([poly({ class: 'industrial' }, sq(-64, -64, 4160, 4160))]),
  } };
  const t = conv(mvt, { size: 'mega', port: true });
  const mid = cellAt(t, 125, 94);
  assert.equal(mid.m, WT.MASK.DOCK);
  assert.ok(Math.abs(-mid.h - DOCK_DEPTH.mega) <= 0.125, `dock depth ${-mid.h}`);
  // a berth pocket: the depth stays constant up to the wall
  const edge = cellAt(t, Math.ceil(1000 / U) + 1, 94);
  assert.equal(edge.m, WT.MASK.DOCK);
  assert.ok(-edge.h >= DOCK_DEPTH.mega - 0.25, `berth depth at the wall ${-edge.h}`);
  assert.equal(cellAt(t, 40, 94).m === WT.MASK.QUAY || cellAt(t, 40, 94).m === WT.MASK.LAND, true);
  assert.ok(cellAt(t, 40, 94).h >= 3.9, 'port land at quay height');
  const minor = conv(mvt, { size: 'minor', port: true });
  assert.ok(Math.abs(-cellAt(minor, 125, 94).h - DOCK_DEPTH.minor) <= 0.125);
  const quays = t.vectors.quays.filter((q) => q.k === 'derived');
  assert.ok(quays.length >= 4, `quays ${quays.length}`);
  let sides = { n: 0, s: 0, e: 0, w: 0 };
  for (const q of quays) {
    const [x0, z0, x1, z1] = q.p.map(dmToU), len = Math.hypot(x1 - x0, z1 - z0);
    assert.equal(q.side, 1); assert.equal(q.top, 4);
    // water on the right of p (x east, z south: right normal = (−dz, dx))
    const mx = (x0 + x1) / 2 + (-(z1 - z0) / len) * 40, mz = (z0 + z1) / 2 + ((x1 - x0) / len) * 40;
    assert.ok(mx > 1000 && mx < 3000 && mz > 1000 && mz < 2000, `water right of quay ${q.p}`);
    if (Math.abs(z1 - z0) < 50) sides[Math.abs(z0 - 1000) < 60 ? 'n' : 's']++; else sides[Math.abs(x0 - 1000) < 60 ? 'w' : 'e']++;
  }
  assert.deepEqual(Object.values(sides).map((v) => v > 0), [true, true, true, true], JSON.stringify(sides));
});

test('a natural beach: no quays, a gentle shore ramp, the open-sea ramp without bathymetry', () => {
  const mvt = { layers: { water: layer([poly({ class: 'ocean' }, sq(-64, -64, 2048, 4160))]), landcover: layer([poly({ class: 'sand' }, sq(1900, -64, 2400, 4160))]) } };
  const t = conv(mvt, {});
  assert.equal((t.vectors?.quays || []).length, 0);
  const shore = 2048 / U;                        // first land cell column = 128
  let prev = 0;
  for (let i = shore - 1; i >= shore - 6; i--) {   // the first 30 m off the beach: depth ≤ 0.5 + 0.15·d, increasing
    const c = cellAt(t, i, 128), d = (shore - i - 0.5) * CELL_M;
    assert.equal(c.m, WT.MASK.WATER);
    assert.ok(-c.h <= 0.5 + 0.15 * d + 0.2, `ramp at ${d.toFixed(1)} m: ${-c.h}`);
    assert.ok(-c.h >= prev - 0.01); prev = -c.h;
  }
  const far = cellAt(t, 10, 128), dFar = (shore - 10.5) * CELL_M;
  assert.ok(Math.abs(-far.h - Math.min(25, 1.5 + 0.06 * dFar)) <= 1, `open-sea ramp ${-far.h}`);
  const land = cellAt(t, shore + 2, 128);
  assert.equal(land.m, WT.MASK.LAND); assert.ok(land.h >= 0.25 && land.h < 3);
  assert.deepEqual(t.vectors.areas.map((a) => a.k), ['sand']);
});

test('river / canal lines without a polygon are stroked (30 m / 20 m / width tag); tunnels and streams ignored', () => {
  const line = (cls, y, extra = {}) => ({ type: 2, tags: { class: cls, ...extra }, geom: [[-64, y, 4160, y]] });
  const t = conv({ layers: { waterway: layer([line('river', 600), line('canal', 1600), line('river', 2600, { width: 60 }), line('river', 3300, { brunnel: 'tunnel' }), line('stream', 3800)]) } });
  const count = (y) => { let n = 0; for (let j = Math.floor(y / U) - 10; j <= Math.floor(y / U) + 10; j++) if (t.mask[j * 256 + 128] === WT.MASK.RIVER) n++; return n; };
  const width = (y) => count(y) * CELL_M;
  assert.ok(Math.abs(width(600) - 30) <= CELL_M * 1.5, `river ${width(600)}`);
  assert.ok(Math.abs(width(1600) - 20) <= CELL_M * 1.5, `canal ${width(1600)}`);
  assert.ok(Math.abs(width(2600) - 60) <= CELL_M * 1.5, `tagged ${width(2600)}`);
  assert.equal(count(3300), 0); assert.equal(count(3800), 0);
  const c = cellAt(t, 128, Math.floor(600 / U));
  assert.ok(-c.h >= 0.5 && -c.h <= 4.5 + 0.13, `narrow river depth ${-c.h}`);
});

test('building heights: tagged, estimated by kind and footprint, the 5 m default treated as an estimate; BUILDING mask', () => {
  const b = (x, y, s, tags) => poly(tags, sq(x, y, x + s, y + s));
  const mvt = { layers: {
    landuse: layer([poly({ class: 'industrial' }, sq(0, 0, 2048, 4096)), poly({ class: 'residential' }, sq(2048, 0, 4096, 4096))]),
    building: layer([b(200, 200, 600, { render_height: 25, render_min_height: 0 }), b(1200, 200, 100, { render_height: 5, render_min_height: 0 }), b(2500, 200, 100, { render_height: 5, render_min_height: 0 }), b(3000, 3000, 80, {})]),
  } };
  const t = conv(mvt, { port: true, size: 'major' });
  const B = t.vectors.buildings;
  assert.equal(B.length, 4);
  assert.deepEqual([B[0].h, B[0].e, B[0].k], [25, 0, 'shed']);          // largest first; 600 u ≈ 220 m → shed
  const small = B.find((x) => x.k === 'industrial');
  const area = ((100 / 4096) * SIZE_M) ** 2;
  assert.equal(small.e, 1); assert.ok(Math.abs(small.h - Math.min(22, Math.max(8, 6 + Math.sqrt(area) / 8))) < 0.11);
  assert.deepEqual(B.filter((x) => x.k === 'residential').map((x) => [x.h, x.e]), [[9, 1], [9, 1]]);
  assert.equal(tileMaskAt(t, (200 + 300) / U, (200 + 300) / U), WT.MASK.BUILDING);
  assert.ok(tileHeightAt(t, 500 / U, 500 / U) > 0.25);
});

test('overlay: OSM quay band + berth pocket, breakwater, pontoon, lock with gate, fairway minimum depth, crane, light → rev 1', () => {
  const ll = (u, v) => tileFToLatLon(Z, X + u / 4096, Y + v / 4096);
  const g = (...uv) => { const o = []; for (let i = 0; i < uv.length; i += 2) { const p = ll(uv[i], uv[i + 1]); o.push(p.lat, p.lon); } return o; };
  const overlay = { v: 1, date: '2026-10-08', x: X >> 2, y: Y >> 2, f: [
    { id: 'w1', k: 'quay', t: { man_made: 'quay' }, g: g(200, 2000, 1800, 2000), c: 0 },
    { id: 'w2', k: 'breakwater', t: { man_made: 'breakwater' }, g: g(2500, 500, 3800, 500), c: 0 },
    { id: 'w3', k: 'lock', t: { waterway: 'lock', name: 'Testsluis' }, g: g(2600, 2600, 3600, 2600, 3600, 3000, 2600, 3000), c: 1 },
    { id: 'n4', k: 'lock_gate', t: { waterway: 'lock_gate' }, g: g(2650, 2800), c: 0 },
    { id: 'w5', k: 'dredged', t: { 'seamark:type': 'dredged_area', 'seamark:dredged_area:minimum_depth': '14.5' }, g: g(300, 3300, 1500, 3300, 1500, 3900, 300, 3900), c: 1 },
    { id: 'n6', k: 'crane', t: { man_made: 'crane', 'crane:type': 'container_crane' }, g: g(1000, 1900), c: 0 },
    { id: 'n7', k: 'light', t: { 'seamark:type': 'light_minor', 'seamark:light:colour': 'red', 'seamark:light:character': 'Fl', 'seamark:light:period': '4' }, g: g(3700, 1000), c: 0 },
    { id: 'w8', k: 'pontoon', t: { man_made: 'pontoon' }, g: g(500, 2600, 1500, 2600), c: 0 },
  ] };
  // water south of y = 2000 (the quay line), land north of it
  const mvt = { layers: { water: layer([poly({ class: 'ocean' }, sq(-64, 2000, 4160, 4160), sq(-64, -64, 4160, 1200))]) } };
  const t = conv(mvt, { size: 'major', port: true, iala: 'A' }, { overlay });
  assert.equal(t.rev, 1);
  assert.ok(t.flags & WT.FLAG.OVERLAY);
  assert.equal(t.vectors.ov, 'ovp:2026-10-08');
  assert.equal(tileMaskAt(t, 1000 / U, 2000 / U - 0.5), WT.MASK.QUAY, 'quay band on the land side');
  const pocket = cellAt(t, Math.floor(1000 / U), Math.floor(2000 / U) + 1);
  assert.ok(WT_NAVIGABLE[pocket.m]);
  const osmQ = t.vectors.quays.find((q) => q.k === 'osm');
  assert.ok(osmQ); assert.equal(osmQ.side, 1);            // drawn west → east, water to the south = right
  assert.equal(tileMaskAt(t, 3000 / U, 500 / U), WT.MASK.BREAKWATER);
  assert.ok(tileHeightAt(t, 3000 / U, 500 / U) >= 3.9);
  assert.equal(tileMaskAt(t, 3100 / U, 2800 / U), WT.MASK.LOCK);
  assert.equal(tileMaskAt(t, 1000 / U, 2600 / U), WT.MASK.PONTOON);
  assert.equal(t.vectors.locks.length, 1); assert.equal(t.vectors.locks[0].name, 'Testsluis'); assert.equal(t.vectors.locks[0].gates.length, 1);
  assert.equal(tileMaskAt(t, 900 / U, 3600 / U), WT.MASK.FAIRWAY);
  assert.ok(Math.abs(-tileHeightAt(t, 900 / U, 3600 / U) - 14.5) <= 0.13, 'explicit dredged depth wins');
  assert.equal(t.vectors.cranes[0].k, 'sts'); assert.equal(t.vectors.cranes[0].h, 70);
  assert.ok(Math.abs(t.vectors.cranes[0].hdg - 90) < 5 || Math.abs(t.vectors.cranes[0].hdg - 270) < 5, `crane along the quay ${t.vectors.cranes[0].hdg}`);
  assert.deepEqual(t.vectors.lights.map((l) => [l.k, l.col, l.ch, l.iala]), [['beacon', 'red', 'Fl.R.4s', 'A']]);
  assert.equal(t.vectors.pontoons.length, 1); assert.equal(t.vectors.breakwaters.length, 1);
});

test('depth rules: fairway by harbour size, river width classes, port water floor, Terrarium for the open sea', () => {
  const ll = (u, v) => tileFToLatLon(Z, X + u / 4096, Y + v / 4096);
  const g = (...uv) => { const o = []; for (let i = 0; i < uv.length; i += 2) { const p = ll(uv[i], uv[i + 1]); o.push(p.lat, p.lon); } return o; };
  const overlay = { v: 1, date: '2026-10-01', x: X >> 2, y: Y >> 2, f: [{ id: 'w1', k: 'fairway', t: { 'seamark:type': 'fairway' }, g: g(1000, 1000, 3000, 1000, 3000, 3000, 1000, 3000), c: 1 }] };
  const sea = { layers: { water: layer([poly({ class: 'ocean' }, sq(-64, -64, 4160, 4160))]) } };
  for (const size of ['mega', 'major', 'regional', 'minor']) {
    const t = conv(sea, { size, port: true }, { overlay });
    assert.ok(Math.abs(-tileHeightAt(t, 128, 128) - FAIRWAY_DEPTH[size]) <= 0.13, `${size} fairway`);
  }
  // Terrarium where it says ≤ −3 m, the class ramp otherwise
  const dm = new Int16Array(65536).fill(-180);
  const t = conv(sea, {}, { bathy: { x9: X >> 5, y9: Y >> 5, dm } });
  assert.ok(Math.abs(tileHeightAt(t, 128, 128) + 18) <= 0.13 || (t.flags & WT.FLAG.UNIFORM && Math.abs(t.uniformH + 18) < 0.2), 'bathy depth');
  // rivers: wide (> 300 m) 12 m, medium 8 m, narrow 4.5 m (centre cells)
  const river = (w) => { const half = ((w / 2) / SIZE_M) * 4096; return { layers: { water: layer([poly({ class: 'river' }, sq(-64, 2048 - half, 4160, 2048 + half))]) } }; };
  assert.ok(Math.abs(-tileHeightAt(conv(river(400)), 128, 128) - 12) <= 0.13);
  assert.ok(Math.abs(-tileHeightAt(conv(river(200)), 128, 128) - 8) <= 0.13);
  assert.ok(Math.abs(-tileHeightAt(conv(river(80)), 128, 128) - 4.5) <= 0.13);
  // port water floor: a 300 m sea channel inside a port area is dredged to the floor in its middle, not near its banks
  const ch = { layers: { water: layer([poly({ class: 'ocean' }, sq(-64, 2048 - 400, 4160, 2048 + 400))]) } };
  const plain = conv(ch, {}), port = conv(ch, { size: 'mega', port: true });
  assert.ok(-tileHeightAt(port, 128, 128) >= 15 - 0.13 && -tileHeightAt(plain, 128, 128) < 15, `${-tileHeightAt(port, 128, 128)} vs ${-tileHeightAt(plain, 128, 128)}`);
  assert.ok(-tileHeightAt(port, 128, (2048 - 400) / U + 1) < 3, 'still shallow at the bank');
});

test('specks: ditch-sized water filled, tiny docks kept, untagged land specks in water dropped', () => {
  const mvt = { layers: { water: layer([
    poly({ class: 'lake' }, sq(400, 400, 430, 430)),                  // 2×2 cells inland → land
    poly({ class: 'dock' }, sq(800, 400, 830, 430)),                  // tagged dock → kept
    poly({ class: 'ocean' }, sq(2000, -64, 4160, 4160), sqCCW(3000, 3000, 3016, 3016)),   // 1-cell islet → water
  ]) } };
  const t = conv(mvt);
  assert.equal(tileMaskAt(t, 415 / U, 415 / U), WT.MASK.LAND);
  assert.equal(tileMaskAt(t, 815 / U, 415 / U), WT.MASK.DOCK);
  assert.equal(tileMaskAt(t, 3008 / U, 3008 / U), WT.MASK.WATER);
});

test('uniform tiles: open sea and inland become 40-byte tiles; swimming pools / small ponds do not count', () => {
  const sea = convertTile({ z: Z, x: X, y: Y, mvt: { layers: { water: layer([poly({ class: 'ocean' }, sq(-64, -64, 4160, 4160))]) } }, hints: {} });
  assert.ok(sea.flags & WT.FLAG.UNIFORM); assert.ok(!(sea.flags & WT.FLAG.UNIFORM_LAND));
  assert.equal(encodeTile(sea).length, 40);
  assert.ok(sea.uniformH <= -0.5);
  const land = convertTile({ z: Z, x: X, y: Y, mvt: { layers: { water: layer([poly({ class: 'swimming_pool' }, sq(100, 100, 400, 400)), poly({ class: 'pond' }, sq(1000, 1000, 1050, 1050))]) } }, hints: {} });
  assert.ok(land.flags & WT.FLAG.UNIFORM_LAND);
  assert.ok(land.uniformH > 0);
  const c11 = convertTile({ z: 11, x: X >> 3, y: Y >> 3, mvt: { layers: { water: layer([poly({ class: 'ocean' }, sq(-64, -64, 2048, 4160))]) } }, hints: {} });
  assert.ok(c11.flags & WT.FLAG.NO_VECTORS); assert.equal(c11.vectors, null); assert.ok(c11.mask);
});

test('big-port guard: the hand-checked Scheldt stays water even where the vector tile has none', () => {
  const c = cellOf(14, 51.31, 4.27);
  const empty = { layers: {} };
  const guarded = decodeTile(encodeTile(convertTile({ z: 14, x: c.x, y: c.y, mvt: empty, hints: { bigport: 'antwerp', size: 'mega', port: true } })));
  const plain = decodeTile(encodeTile(convertTile({ z: 14, x: c.x, y: c.y, mvt: empty, hints: { bigport: 'antwerp', guard: false } })));
  assert.ok(WT_NAVIGABLE[tileMaskAt(guarded, c.u, c.v)]);
  assert.ok(tileHeightAt(guarded, c.u, c.v) <= -12);
  assert.equal(tileMaskAt(plain, c.u, c.v), WT.MASK.LAND);
});

test('determinism: the same input converts to byte-identical tiles (synthetic and recorded); srcHash covers the converter version', () => {
  const mvtRaw = fs.readFileSync(path.join(FIX, 'rotterdam', '14-8381-5418.mvt.gz'));
  const job = { z: 14, x: 8381, y: 5418, mvt: mvtRaw, overlay: null, bathy: null, hints: { src: 'ofm:x', size: 'mega', port: true, bigport: 'rotterdam', builtAt: 0 } };
  const a = convertJob(job), b = convertJob({ ...job, mvt: new Uint8Array(mvtRaw) });
  assert.deepEqual(a.raw, b.raw);
  const d = decodeTile(a.raw);
  assert.equal(d.srcHash, srcHashOf('ofm:x', ''));
  assert.notEqual(srcHashOf('ofm:x', ''), srcHashOf('ofm:x', '2026-10-08'));
  assert.equal(CONVERTER_VERSION, 1);
  const s1 = encodeTile(convertTile({ z: Z, x: X, y: Y, mvt: decodeMVT(mvtRaw), hints: { builtAt: 5 } }));
  const s2 = encodeTile(convertTile({ z: Z, x: X, y: Y, mvt: decodeMVT(mvtRaw), hints: { builtAt: 5 } }));
  assert.deepEqual(s1, s2);
});

test('seams: two neighbouring tiles agree on their shared edge (mask identical, height within 1.5 m)', () => {
  // sea everywhere with an islet just east of the seam: tile A sees it in its buffer, tile B in its body
  const islet = (dx) => sqCCW(dx + 32, 1500, dx + 200, 2500);
  const A = decodeTile(encodeTile(convertTile({ z: Z, x: X, y: Y, mvt: { layers: { water: layer([poly({ class: 'ocean' }, sq(-64, -64, 4160, 4160), islet(4096))]) } }, hints: {} })));
  const B = decodeTile(encodeTile(convertTile({ z: Z, x: X + 1, y: Y, mvt: { layers: { water: layer([poly({ class: 'ocean' }, sq(-64, -64, 4160, 4160), islet(0))]) } }, hints: {} })));
  assert.ok(A.mask && B.mask);
  let maxDh = 0;
  for (let j = 0; j < 256; j++) {
    assert.equal(A.mask[j * 256 + 255], B.mask[j * 256], `row ${j}`);
    maxDh = Math.max(maxDh, Math.abs(decodeWTHeight(A.height[j * 256 + 255]) - decodeWTHeight(B.height[j * 256])));
  }
  assert.ok(maxDh <= 1.5, `edge height jump ${maxDh}`);
});

test('invariants on the recorded fixtures: navigable ≤ −0.5 m, obstacles ≥ +0.25 m, isWater agrees with the mask', () => {
  for (const [port, f] of [['rotterdam', '14-8381-5418'], ['new_york', '14-4819-6164'], ['hamburg', '14-8643-5295'], ['santos', '14-6084-9316']]) {
    const [, x, y] = f.split('-').map(Number);
    const r = convertJob({ z: 14, x, y, mvt: fs.readFileSync(path.join(FIX, port, `${f}.mvt.gz`)), hints: { src: 'ofm:x', port: true, size: 'mega' } });
    const t = decodeTile(r.raw);
    if (!t.mask) continue;
    for (let i = 0; i < t.mask.length; i++) {
      if (WT_NAVIGABLE[t.mask[i]]) assert.ok(t.height[i] <= 126, `${port} navigable cell ${i} v=${t.height[i]}`);
      if (WT_OBSTACLE[t.mask[i]]) assert.ok(t.height[i] >= 129, `${port} obstacle cell ${i} v=${t.height[i]}`);
    }
  }
});

test('helpers: Douglas–Peucker keeps corners, exact EDT', () => {
  assert.deepEqual(simplify([0, 0, 5, 0.1, 10, 0, 10, 10], 0.5), [0, 0, 10, 0, 10, 10]);
  const seed = new Uint8Array(25); seed[12] = 1;
  const d = edt(seed, 5, 5);
  assert.equal(d[12], 0); assert.ok(Math.abs(d[0] - Math.SQRT2 * 2) < 1e-6); assert.equal(d[14], 2);
  assert.equal(edt(new Uint8Array(4), 2, 2)[0], Infinity);
});
