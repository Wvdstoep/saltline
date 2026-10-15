// City mesh builder (public/js/citymesh.js): buildings with facade coordinates and roofs, patch-footprint exclusion,
// trees by land class, container stacks behind STS cranes, LOD caps. A synthetic decoded D14 tile, no fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as CM from '../public/js/citymesh.js';
import * as WM from '../public/js/wtmesh.js';
import { STYLE } from '../public/js/cityrules.js';
import { WT, encodeWTHeight } from '../shared/wtformat.js';

const M = WT.MASK;
const X = 8376, Y = 5414;     // Rotterdam
/** Land at +3 m with open water in the north (rows < 40), a port area, a wood, a house, a warehouse and an STS crane. */
function cityTile() {
  const n = 256, mask = new Uint8Array(n * n).fill(M.LAND), height = new Uint8Array(n * n).fill(encodeWTHeight(3));
  for (let j = 0; j < 40; j++) for (let i = 0; i < n; i++) { mask[j * n + i] = M.DOCK; height[j * n + i] = encodeWTHeight(-15); }
  const f = WM.tileFrame(14, X, Y), dm = (cells) => Math.round((cells / n) * f.sizeM * 10);
  const rect = (x0, y0, x1, y1) => [dm(x0), dm(y0), dm(x1), dm(y0), dm(x1), dm(y1), dm(x0), dm(y1)];
  const cellM = f.sizeM / n;
  const hx = 200, hy = 60;                       // a 10 × 13 m house in a residential area
  const house = { r: rect(hx, hy, hx + 10 / cellM, hy + 13 / cellM), h: 9, mh: 0, k: 'residential', e: 1 };
  const shed = { r: rect(100, 150, 130, 170), h: 12, mh: 0, k: 'shed', e: 1 };
  const tower = { r: rect(220, 120, 226, 126), h: 80, mh: 0, k: 'commercial', e: 0 };
  return {
    z: 14, x: X, y: Y, n, flags: 0, rev: 0, uniformH: 0, mask, height,
    vectors: {
      v: 2, quays: [], piers: [], breakwaters: [], pontoons: [], bridges: [], locks: [], lights: [], tanks: [],
      buildings: [house, shed, tower],
      cranes: [{ x: dm(60), z: dm(42), k: 'sts', hdg: 0, h: 60 }, { x: dm(66), z: dm(42), k: 'sts', hdg: 0, h: 60 }],
      areas: [
        { r: rect(0, 40, 140, 140), k: 'port' },
        { r: rect(150, 150, 256, 256), k: 'wood' },
        { r: rect(180, 40, 256, 140), k: 'residential' },
      ],
    },
    _f: f, _house: house,
  };
}
const finite = (a) => { for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false; return true; };

test('buildings: walls with facade coordinates down into the ground, roofs by type, one merged mesh', () => {
  const t = cityTile(), r = CM.buildCity(t, { want: 'near' });
  assert.equal(r.counts.buildings, 3);
  assert.ok(r.verts > 0 && r.idx.length % 3 === 0 && r.idx.every((i) => i < r.verts));
  for (const a of [r.pos, r.fac]) assert.ok(finite(a));
  assert.equal(r.fac.length, r.verts * 3); assert.equal(r.sty.length, r.verts * 2);
  // walls reach below the ground (stand on a harbour patch whose ground differs a little) and up to the eave
  let minY = Infinity, maxY = -Infinity; for (let i = 1; i < r.pos.length; i += 3) { minY = Math.min(minY, r.pos[i]); maxY = Math.max(maxY, r.pos[i]); }
  assert.ok(minY < 0, 'walls run into the ground'); assert.ok(maxY >= 80, 'the 80 m tower keeps its tagged height');
  const styles = new Set(); for (let i = 0; i < r.sty.length; i += 2) styles.add(r.sty[i]);
  assert.ok(styles.has(STYLE.HOUSE) && styles.has(STYLE.WAREHOUSE) && styles.has(STYLE.OFFICE) && styles.has(0), [...styles].join());
  assert.equal(r.counts.pitched, 1, 'the house gets a pitched roof, the shed and the tower stay flat');
  // facade v (metres above the ground) is ≈ the wall top on top-of-wall vertices
  let maxV = 0; for (let i = 1; i < r.fac.length; i += 3) maxV = Math.max(maxV, r.fac[i]);
  assert.ok(maxV > 70 && maxV < 81);
});

test('exclusion: a harbour patch footprint is not drawn twice', () => {
  const t = cityTile(), sz10 = t._f.sizeM * 10, h = t._house.r;
  const ring = []; for (let i = 0; i < h.length; i += 2) ring.push(h[i] / sz10, h[i + 1] / sz10);
  const ex = CM.packExclude([ring]);
  assert.equal(CM.unpackExclude(ex).length, 1);
  const r = CM.buildCity(t, { want: 'near', exclude: ex });
  assert.equal(r.counts.buildings, 2); assert.equal(r.counts.excluded, 1); assert.equal(r.counts.pitched, 0);
  // a small patch building whose centroid lies inside the tile building also removes it
  const shed = t.vectors.buildings[1].r, cx = (shed[0] + shed[2]) / 2 / sz10, cy = (shed[1] + shed[5]) / 2 / sz10, e = 0.001;
  const r2 = CM.buildCity(t, { want: 'near', exclude: CM.packExclude([[cx - e, cy - e, cx + e, cy - e, cx + e, cy + e, cx - e, cy + e]]) });
  assert.equal(r2.counts.excluded, 1);
});

test('trees: dense in the wood, none on water or in the port, inside the tile', () => {
  const t = cityTile(), r = CM.buildCity(t, { want: 'near' }), f = t._f;
  const tr = r.inst.trees;
  assert.ok(r.counts.trees > 300, `wood trees: ${r.counts.trees}`);
  let inWood = 0;
  for (let i = 0; i < tr.length; i += 6) {
    const x = tr[i], z = tr[i + 2], fx = x / f.wN, fy = z / f.h;
    assert.ok(fx > 0 && fx < 1.01 && fy > 0 && fy < 1);
    assert.ok(fy > 40 / 256, 'never in the water');
    assert.ok(!(fx < 140 / 256 && fy < 140 / 256), 'never in the port area');
    if (fx > 150 / 256 && fy > 150 / 256) inWood++;
    assert.ok(tr[i + 3] > 3 && tr[i + 3] < 30 && tr[i + 4] >= 0 && tr[i + 4] <= 2);
  }
  assert.ok(inWood / (tr.length / 6) > 0.8, 'mostly in the wood');
  const capped = CM.buildCity(t, { lod: { facades: true, roofs: true, minH: 0, maxBuildings: 10, maxVerts: 1e6, trees: 50, containers: 0 } });
  assert.ok(capped.counts.trees <= 50 && capped.counts.containers === 0);
});

test('containers: stacked 40-footers on the port land behind the STS cranes, never in the water', () => {
  const t = cityTile(), r = CM.buildCity(t, { want: 'near' }), f = t._f, b = r.inst.boxes;
  assert.ok(r.counts.containers > 100, `${r.counts.containers}`);
  const craneZ = (42 / 256) * f.h;
  const tiers = new Set();
  for (let i = 0; i < b.length; i += 6) {
    const z = b[i + 2], fx = b[i] / f.wN, fy = z / f.h;
    assert.ok(z > craneZ + 40, 'landward of the crane line');
    assert.ok(fx >= 0 && fx < 140 / 256 + 0.01 && fy < 140 / 256 + 0.01, 'inside the port area');
    assert.ok(b[i + 1] >= 2.9 && b[i + 1] < 3 + 5 * CM.CONTAINER.H, 'stands on the yard, ≤ 5 high');
    tiers.add(Math.round((b[i + 1] - 3) / CM.CONTAINER.H));
    assert.ok(b[i + 4] >= 0 && b[i + 4] < 8);
  }
  assert.ok(tiers.size >= 3, 'stacks of different heights');
});

test('LOD: far ring drops small buildings, roofs, trees and containers; caps hold; deterministic', () => {
  const t = cityTile();
  const far = CM.buildCity(t, { want: 'far' });
  assert.equal(far.counts.trees, 0); assert.equal(far.counts.containers, 0); assert.equal(far.counts.pitched, 0);
  assert.equal(far.counts.buildings, 3, 'all three are ≥ 6 m');
  const one = CM.buildCity(t, { lod: { facades: false, roofs: false, minH: 0, maxBuildings: 1, maxVerts: 1e6, trees: 0, containers: 0 } });
  assert.equal(one.counts.buildings, 1);
  for (let i = 0; i < one.sty.length; i += 2) assert.equal(one.sty[i], 0, 'facades off: no styles');
  const a = CM.buildCity(t, { want: 'near', mobile: true }), b = CM.buildCity(t, { want: 'near', mobile: true });
  assert.deepEqual(a.pos, b.pos); assert.deepEqual(a.inst.trees, b.inst.trees); assert.deepEqual(a.inst.boxes, b.inst.boxes);
  assert.ok(a.counts.trees <= CM.buildCity(t, { want: 'near' }).counts.trees);
});

test('orientedBox: a rotated rectangle is found with fill ≈ 1', () => {
  const c = Math.cos(0.5), s = Math.sin(0.5), P = [];
  for (const [x, z] of [[-6, -4], [6, -4], [6, 4], [-6, 4]]) P.push(100 + x * c - z * s, 50 + x * s + z * c);
  const ob = CM.orientedBox(P);
  assert.ok(Math.abs(ob.hl - 6) < 1e-6 && Math.abs(ob.hw - 4) < 1e-6 && Math.abs(ob.fill - 1) < 1e-6);
  assert.ok(Math.abs(ob.cx - 100) < 1e-6 && Math.abs(ob.cz - 50) < 1e-6);
  assert.ok(Math.abs(Math.abs(ob.lx * c + ob.lz * s) - 1) < 1e-6, 'long axis along the 12 m side');
  const L = [0, 0, 10, 0, 10, 2, 2, 2, 2, 10, 0, 10];
  assert.ok(CM.orientedBox(L).fill < 0.5, 'an L-shape is not a box');
});

test('uniform / empty tiles build nothing and never throw', () => {
  const t = cityTile(); t.vectors = {};
  const r = CM.buildCity(t, { want: 'near' });
  assert.equal(r.counts.buildings, 0); assert.equal(r.counts.containers, 0);
  const sea = { z: 14, x: X, y: Y, n: 256, flags: 0, uniformH: -20, mask: null, height: null, vectors: null };
  const s = CM.buildCity(sea, { want: 'near' });
  assert.equal(s.verts, 0); assert.equal(s.counts.trees, 0);
});
