// World detail tiles, client mesh builders (public/js/wtmesh.js — docs/WORLD-DETAIL-STREAMING.md §3.7, Lane B).
// Pure functions: the same code runs in the browser's module worker (wtworker.js). Synthetic tiles + the recorded
// fixtures (test/fixtures/wt) converted with the server's converter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as WM from '../public/js/wtmesh.js';
import { WT, WT_NAVIGABLE, WT_OBSTACLE, encodeWTHeight, tileFToLatLon, tileMaskAt, cellOf } from '../shared/wtformat.js';
import { toLocal } from '../shared/geo.js';
import { loadPortFixture, loadPoints, FIXTURE_DIR } from './fixtures/wt/lib.mjs';

const { ports } = loadPoints();
const FX = {};
const fixture = (id) => (FX[id] ||= loadPortFixture(FIXTURE_DIR, ports.find((p) => p.id === id)));
const finite = (a) => { for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false; return true; };
const M = WT.MASK;

/** A synthetic decoded D14 tile: land (+2 m), a rectangular dock (−14 m) in cells [a, b)², quays along its 4 edges. */
function dockTile(a = 96, b = 160, { x = 8376, y = 5414, withQuays = true } = {}) {
  const n = 256, mask = new Uint8Array(n * n).fill(M.LAND), height = new Uint8Array(n * n).fill(encodeWTHeight(2));
  for (let j = a; j < b; j++) for (let i = a; i < b; i++) { mask[j * n + i] = M.DOCK; height[j * n + i] = encodeWTHeight(-14); }
  const f = WM.tileFrame(14, x, y), dm = (cells) => Math.round((cells / n) * f.sizeM * 10);
  // quay polylines on the dock edges, water on the right (side 1): run clockwise around the dock seen on the map
  // (x east, z south): north edge W→E has the dock to its south = right of travel.
  const A = dm(a), B = dm(b);
  const quays = withQuays ? [
    { p: [A, A, B, A], side: 1, k: 'derived', top: 4 },
    { p: [B, A, B, B], side: 1, k: 'derived', top: 4 },
    { p: [B, B, A, B], side: 1, k: 'derived', top: 4 },
    { p: [A, B, A, A], side: 1, k: 'derived', top: 4 },
  ] : [];
  const buildings = [{ r: [dm(20), dm(20), dm(40), dm(20), dm(40), dm(30), dm(20), dm(30)], h: 12, mh: 0, k: 'industrial', e: 1 }];
  return { z: 14, x, y, n, flags: 0, rev: 0, uniformH: 0, mask, height, vectors: { v: 1, quays, piers: [], breakwaters: [], pontoons: [], buildings, tanks: [], cranes: [{ x: dm(90), z: dm(90), k: 'sts', hdg: 0, h: 60 }], bridges: [], locks: [], lights: [], areas: [{ r: [0, 0, dm(80), 0, dm(80), dm(80), 0, dm(80)], k: 'port' }] } };
}

test('tile frame + placement reproduce shared/geo.js toLocal (≤ 2 cm over a tile, origin 25 km away)', () => {
  const f = WM.tileFrame(14, 8376, 5414);
  const origin = { lat: f.latN + 0.12, lon: f.lonW - 0.3 };          // ≈ 13 km N, 20 km W of the tile
  const p = WM.placement(f, origin);
  let worst = 0;
  for (const [fx, fy] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5], [0.13, 0.91], [0.97, 0.21]]) {
    const ll = tileFToLatLon(14, 8376 + fx, 5414 + fy), t = toLocal(ll.lat, ll.lon, origin);
    const [x, z] = WM.frameXZ(f, fx, fy);
    worst = Math.max(worst, Math.abs(p.tx + x + p.s * z - t.x), Math.abs(p.tz + z - t.z));
  }
  assert.ok(worst < 0.02, `placement error ${worst} m`);
  assert.ok(Math.abs(f.wN - f.sizeM) / f.sizeM < 0.002 && f.h > 0, 'tile ≈ square in metres');
});

test('neighbouring tiles share their edge vertices exactly (no seam), also across LODs', () => {
  const origin = { lat: 51.95, lon: 4.0 };
  const world = (t, lod, I, J) => {
    const f = WM.tileFrame(14, t.x, t.y), p = WM.placement(f, origin), r = WM.buildTerrain(t, { lod }), V = r.lod + 1, k = (J * V + I) * 3;
    return [p.tx + r.pos[k] + p.s * r.pos[k + 2], p.tz + r.pos[k + 2]];
  };
  const A = dockTile(96, 160, { x: 8376, y: 5414 }), B = dockTile(96, 160, { x: 8377, y: 5414 }), C = dockTile(96, 160, { x: 8376, y: 5415 });
  for (const s of [0, 0.25, 0.5, 1]) {
    // east edge of A (I = lod) vs west edge of B (I = 0), at the same fractional row; A at LOD 256, B at LOD 64
    const a = world(A, 256, 256, Math.round(s * 256)), b = world(B, 64, 0, Math.round(s * 64));
    assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.02, `E/W seam ${a} vs ${b}`);
    const c = world(A, 128, Math.round(s * 128), 128), d = world(C, 256, Math.round(s * 256), 0);
    assert.ok(Math.hypot(c[0] - d[0], c[1] - d[1]) < 0.02, `N/S seam ${c} vs ${d}`);
  }
});

test('terrain LOD sizes, shared index, skirt, uniform tiles', () => {
  const t = dockTile();
  for (const lod of [256, 128, 64]) {
    const r = WM.buildTerrain(t, { lod });
    assert.equal(r.lod, lod);
    assert.equal(r.verts, (lod + 1) ** 2 + 4 * lod);
    assert.equal(r.pos.length, r.verts * 3); assert.equal(r.morph.length, r.verts); assert.equal(r.col.length, r.verts * 3);
    assert.ok(finite(r.pos) && finite(r.morph), 'no NaN');
    const idx = WM.terrainIndex(lod);
    assert.equal(idx.length, (lod * lod + 4 * lod) * 6);
    assert.ok(lod === 256 ? idx instanceof Uint32Array : idx instanceof Uint16Array, 'index type by vertex count');
    let mx = 0; for (const v of idx) if (v > mx) mx = v;
    assert.equal(mx, r.verts - 1, 'index covers grid + skirt exactly');
    // the skirt hangs SKIRT_M under every rim vertex
    const grid = (lod + 1) ** 2, rim = WM.skirtRing(lod);
    assert.equal(rim.length, 4 * lod);
    for (let s2 = 0; s2 < rim.length; s2 += 37) assert.ok(r.pos[(grid + s2) * 3 + 1] <= r.pos[rim[s2] * 3 + 1] - WM.SKIRT_M + 1e-3);
  }
  const sea = { z: 14, x: 8376, y: 5400, n: 256, flags: WT.FLAG.UNIFORM, uniformH: -21, mask: null, height: null, vectors: null };
  const u = WM.buildTerrain(sea, { lod: 256 });
  assert.equal(u.lod, WM.LOD.UNIFORM, 'uniform tiles use a 16-quad grid');
  assert.ok(Math.abs(u.pos[1] - (-21 - WM.WATER_OFFSET)) < 1e-4);
  assert.equal(WM.buildTile(sea).structures, null, 'no structures on a uniform tile');
});

test('terrain heights: land at its height, water under its depth, quay corners drop to the berth depth', () => {
  const t = dockTile(), r = WM.buildTerrain(t, { lod: 256 }), V = 257;
  const y = (I, J) => r.pos[(J * V + I) * 3 + 1];
  assert.ok(Math.abs(y(40, 40) - 2) < 0.01, 'land vertex');
  assert.ok(Math.abs(y(128, 128) - (-14 - WM.WATER_OFFSET)) < 0.01, 'dock vertex');
  assert.ok(y(96, 128) < -14, 'a corner on the quay line sits at the berth depth (the wall mesh stands there)');
  // without quay vectors the same edge is a natural shore at the waterline
  const nat = WM.buildTerrain(dockTile(96, 160, { withQuays: false }), { lod: 256 });
  const yn = nat.pos[(128 * V + 96) * 3 + 1];
  assert.ok(yn > -1.6 && yn < 1, `natural shore corner at the waterline (${yn})`);
  // morph source: the coarse grid, bilinear
  const coarse = { n: 2, h: Float32Array.from([10, 10, 10, 10, 10, 10, 10, 10, 10]) };
  const m = WM.buildTerrain(t, { lod: 64, coarse });
  assert.ok(Math.abs(m.morph[0] - 10) < 1e-4 && Math.abs(m.morph[65 * 32 + 32] - 10) < 1e-4);
  assert.ok(m.morph[(65 * 65) + 5] <= 10 - WM.SKIRT_M + 1e-4, 'skirt morphs under the coarse surface too');
});

test('quay walls stand on the quay lines, faces towards the water, top slab inland', () => {
  const t = dockTile(), f = WM.tileFrame(14, t.x, t.y);
  const s = WM.buildStructures(t, { lod: 256, debug: true });
  assert.equal(s.counts.quays, 4);
  assert.ok(s.walls.length >= 4);
  const cell = f.sizeM / 256, cx = (128 / 256) * f.wN, cz = (128 / 256) * f.h;
  for (const w of s.walls) {
    const mx = (w.ax + w.bx) / 2, mz = (w.az + w.bz) / 2;
    // the water normal points into the dock (towards its centre)
    assert.ok((cx - mx) * w.nx + (cz - mz) * w.nz > 0, 'front face looks at the water');
    // and the wall line lies on the dock edge (within one cell)
    const fx = mx / f.wN * 256, fz = mz / f.h * 256;
    const onEdge = Math.min(Math.abs(fx - 96), Math.abs(fx - 160), Math.abs(fz - 96), Math.abs(fz - 160)) < 1.01;
    assert.ok(onEdge, `wall at cells ${fx.toFixed(1)}, ${fz.toFixed(1)}`);
    assert.ok(w.bottom <= -14 && w.top >= 4, `wall spans the berth (${w.bottom} … ${w.top})`);
  }
  assert.ok(cell > 5 && cell < 7);
  assert.ok(finite(s.pos), 'no NaN');
  // vertical faces exist with horizontal normals, and the slab top is at quay height
  let vertical = 0, slab = 0;
  for (let v = 0; v < s.verts; v++) { const ny = s.nrm[v * 3 + 1]; if (Math.abs(ny) < 3) vertical++; if (ny > 120 && Math.abs(s.pos[v * 3 + 1] - 4) < 1e-4) slab++; }
  assert.ok(vertical > 16 && slab >= 16, `vertical ${vertical}, slab ${slab}`);
  // one building, one crane instance, owned by this tile
  assert.equal(s.counts.buildings, 1); assert.equal(s.counts.cranes, 1);
  assert.equal(s.inst.cranes.length, 6);
});

test('fixture tiles (Rotterdam / Singapore / New York): every LOD builds, no NaN, walls only where the mask has a coast', () => {
  const stats = [];
  for (const id of ['rotterdam', 'singapore', 'new_york']) {
    const fx = fixture(id);
    assert.ok(fx.tiles.size >= 9, `${id} fixture tiles`);
    let walls = 0, wallsOk = 0, ms = 0, worst = 0;
    for (const t of fx.tiles.values()) {
      for (const lod of [256, 128, 64]) {
        const r = WM.buildTile(t, { lod, debug: lod === 256 });
        assert.ok(finite(r.terrain.pos) && finite(r.terrain.morph), `${id} ${t.x}/${t.y} terrain NaN`);
        if (r.structures) {
          assert.ok(finite(r.structures.pos), `${id} ${t.x}/${t.y} structures NaN`);
          let mx = 0; for (const v of r.structures.idx) if (v > mx) mx = v;
          assert.ok(r.structures.idx.length === 0 || mx < r.structures.verts, 'indices in range');
          for (const a of Object.values(r.structures.inst)) assert.ok(finite(a));
        }
        if (lod === 256) {
          ms += r.ms; worst = Math.max(worst, r.ms);
          for (const w of r.structures?.walls || []) {
            walls++;
            const f = WM.tileFrame(t.z, t.x, t.y), mx = (w.ax + w.bx) / 2, mz = (w.az + w.bz) / 2, e = 2.5 * f.sizeM / 256;
            const m = (x, z) => tileMaskAt(t, Math.max(0, Math.min(255.99, x / f.wN * 256)), Math.max(0, Math.min(255.99, z / f.h * 256)));
            if (WT_NAVIGABLE[m(mx + w.nx * e, mz + w.nz * e)] || WT_OBSTACLE[m(mx - w.nx * e, mz - w.nz * e)]) wallsOk++;
          }
        }
      }
    }
    stats.push(`${id}: ${fx.tiles.size} tiles, ${(ms / fx.tiles.size).toFixed(0)} ms avg / ${worst.toFixed(0)} ms worst (LOD 256 + structures), ${walls} wall segments, ${(100 * wallsOk / Math.max(1, walls)).toFixed(0)} % on a coast`);
    assert.ok(walls > 20, `${id}: walls drawn`);
    assert.ok(wallsOk / walls > 0.9, `${id}: ${wallsOk}/${walls} wall segments on a mask coast`);
    assert.ok(worst < 2000, `${id} worst build ${worst} ms`);
  }
  console.log('    ' + stats.join('\n    '));
});

test('OSM quay lines that do not lie on the mask coast are not drawn (no floating walls)', () => {
  const t = dockTile();
  const f = WM.tileFrame(14, t.x, t.y), dm = (c) => Math.round((c / 256) * f.sizeM * 10);
  t.vectors.quays.push({ p: [dm(10), dm(200), dm(60), dm(200)], side: 1, k: 'osm', top: 3 });     // in the middle of land
  t.vectors.quays.push({ p: [dm(96), dm(96) + 5, dm(160), dm(96) + 5], side: 1, k: 'osm', top: 3 }); // duplicates a derived edge
  delete t._quayRuns;
  const runs = WM.quayRuns(t);
  assert.equal(runs.length, 4, 'only the four derived dock edges remain');
  assert.ok(runs.every((r) => r.k === 'derived'));
});

test('buildings: owned by one tile only (centroid rule), largest first, caps by count, height and vertex budget', () => {
  const fx = fixture('rotterdam');
  // ownership: the union over all tiles of drawn buildings has no duplicates
  let drawn = 0;
  const owned = new Set();
  for (const t of fx.tiles.values()) {
    const s = WM.buildStructures(t, { maxBuildings: Infinity, maxVerts: Infinity });
    drawn += s.counts.buildings;
    const f = WM.tileFrame(t.z, t.x, t.y), sz10 = f.sizeM * 10;
    for (const b of t.vectors?.buildings || []) {
      let x = 0, z = 0; const m = b.r.length / 2; for (let i = 0; i < b.r.length; i += 2) { x += b.r[i]; z += b.r[i + 1]; }
      const fxc = x / m / sz10, fyc = z / m / sz10;
      if (fxc < 0 || fxc >= 1 || fyc < 0 || fyc >= 1) continue;
      const ll = tileFToLatLon(14, t.x + fxc, t.y + fyc);
      owned.add(`${ll.lat.toFixed(6)},${ll.lon.toFixed(6)}`);
    }
  }
  assert.ok(drawn > 1000, `drawn ${drawn}`);
  assert.ok(Math.abs(drawn - owned.size) <= drawn * 0.002, `drawn ${drawn} vs distinct ${owned.size}`);
  // caps on the 4 000-building city tile
  const city = [...fx.tiles.values()].reduce((a, b) => ((b.vectors?.buildings?.length || 0) > (a.vectors?.buildings?.length || 0) ? b : a));
  assert.ok(city.vectors.buildings.length >= 1000);
  const phone = WM.buildStructures(city, { maxBuildings: WM.BUDGET.mobile.buildings, maxVerts: WM.BUDGET.mobile.structVerts });
  assert.ok(phone.counts.buildings <= WM.BUDGET.mobile.buildings);
  assert.ok(phone.verts <= WM.BUDGET.mobile.structVerts + 400, `phone verts ${phone.verts}`);
  const tall = WM.buildStructures(city, { minBuildingH: 9.5 });
  assert.ok(tall.counts.buildings < WM.buildStructures(city, {}).counts.buildings, 'low buildings dropped on the far ring');
  const tiny = WM.buildStructures(city, { maxBuildings: 10 });
  assert.equal(tiny.counts.buildings, 10);
});

test('geometry budgets: a full desktop ring ≤ 150 MB, a phone ring ≤ 50 MB (worst fixture tile everywhere)', () => {
  const fx = fixture('rotterdam');
  let worst = null, wb = 0;
  for (const t of fx.tiles.values()) { const b = WM.buildTile(t, { lod: 256 }).bytes; if (b > wb) { wb = b; worst = t; } }
  const D = WM.BUDGET.desktop, P = WM.BUDGET.mobile;
  const desk = (lod, minH = 0) => WM.buildTile(worst, { lod, maxBuildings: D.buildings, maxVerts: D.structVerts, minBuildingH: minH }).bytes;
  const phone = (lod, minH = 0) => WM.buildTile(worst, { lod, maxBuildings: P.buildings, maxVerts: P.structVerts, minBuildingH: minH }).bytes;
  // desktop: 25 meshes — ≈ 5 near (LOD 256), 8 mid (128), 12 far (64, ≥ 6 m)
  const deskMB = (5 * desk(256) + 8 * desk(128) + 12 * desk(64, 6)) / 1048576;
  // phone: 9 meshes — 2 near (LOD 128), 7 mid/far (64)
  const phoneMB = (2 * phone(128) + 7 * phone(64, 6)) / 1048576;
  console.log(`    worst tile ${worst.x}/${worst.y}: ${(wb / 1048576).toFixed(1)} MB at LOD 256 · desktop ring ${deskMB.toFixed(0)} MB · phone ring ${phoneMB.toFixed(0)} MB`);
  assert.ok(deskMB <= D.geomMB, `desktop ${deskMB} MB`);
  assert.ok(phoneMB <= P.geomMB, `phone ${phoneMB} MB`);
  // the LOD halves the terrain each step (≈ ¼ of the vertices)
  const t256 = WM.buildTerrain(worst, { lod: 256 }).verts, t64 = WM.buildTerrain(worst, { lod: 64 }).verts;
  assert.ok(t64 < t256 / 12);
});

test('tile SDF: > 0 in water, < 0 in obstacles, zero crossing on the coast', () => {
  const t = dockTile(), s = WM.tileSDF(t), f = WM.tileFrame(14, t.x, t.y), cell = f.sizeM / 256;
  assert.ok(s[128 * 256 + 128] > 25 * cell, 'dock centre far from the walls');
  assert.ok(s[40 * 256 + 40] < 0, 'land negative');
  const a = s[128 * 256 + 96], b = s[128 * 256 + 95];   // first dock cell / last land cell on row 128
  assert.ok(a > 0 && b < 0 && Math.abs(a - cell / 2) < 0.01 && Math.abs(b + cell / 2) < 0.01, `${a} ${b}`);
  assert.equal(WM.tileSDF({ ...t, mask: null }), null);
});

test('triangulate: convex, concave and degenerate rings', () => {
  const area = (r, tris) => { let a = 0; for (let i = 0; i < tris.length; i += 3) { const [p, q, s] = [tris[i], tris[i + 1], tris[i + 2]]; a += Math.abs((r[q * 2] - r[p * 2]) * (r[s * 2 + 1] - r[p * 2 + 1]) - (r[q * 2 + 1] - r[p * 2 + 1]) * (r[s * 2] - r[p * 2])) / 2; } return a; };
  const sq = [0, 0, 10, 0, 10, 10, 0, 10];
  assert.equal(WM.triangulate(sq).length, 6); assert.equal(area(sq, WM.triangulate(sq)), 100);
  const L = [0, 0, 20, 0, 20, 10, 10, 10, 10, 20, 0, 20];
  const tl = WM.triangulate(L); assert.equal(tl.length, 12); assert.equal(area(L, tl), 300);
  assert.equal(area(L.slice().reverse().flatMap((_, i, a) => (i % 2 ? [] : [a[i + 1], a[i]])), WM.triangulate(L.slice().reverse().flatMap((_, i, a) => (i % 2 ? [] : [a[i + 1], a[i]])))), 300, 'either winding');
  assert.deepEqual(WM.triangulate([0, 0, 1, 1]), []);
  assert.ok(WM.triangulate([0, 0, 1, 0, 2, 0, 3, 0]).length >= 0, 'collinear ring does not hang');
});

test('deterministic, and the worker / mesh modules never import three', () => {
  const t = [...fixture('singapore').tiles.values()].find((x) => x.mask && x.vectors?.quays?.length);
  const a = WM.buildTile(t, { lod: 128 }), b = WM.buildTile(t, { lod: 128 });
  assert.deepEqual(a.terrain.pos, b.terrain.pos); assert.deepEqual(a.structures.idx, b.structures.idx);
  for (const f of ['wtmesh.js', 'wtworker.js']) {
    const src = fs.readFileSync(new URL(`../public/js/${f}`, import.meta.url), 'utf8');
    assert.ok(!/from\s+['"]three['"]/.test(src) && !/from\s+['"]\/shared\//.test(src), `${f}: worker-safe imports only (no import map inside workers)`);
  }
});

test('area colours and cell lookups stay inside the tile', () => {
  const t = dockTile(), g = WM.areaClassGrid(t);
  assert.equal(g[10 * 256 + 10], WM.AREA_CLASS.port);
  assert.equal(g[200 * 256 + 200], 0);
  const c = cellOf(14, 51.97, 4.03);
  assert.ok(c.u >= 0 && c.u < 256 && c.v >= 0 && c.v < 256);
});
