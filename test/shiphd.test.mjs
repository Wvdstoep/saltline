// HD plan phase 1 — the player's own ship (public/js/shipgen.js opts.hd, shipgeom.js HD rows): denser loft, bevelled
// superstructure tiers, lathe funnel with a lip. Same scale, same draw calls (±2), inside the §6.6 triangle budgets on
// desktop and phone; other ships and LOD1/2 unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, MODEL_IDS } from '../shared/ships/index.js';
import { generalArrangement } from '../public/js/gastub.js';
import { buildFromGA, shipBounds, geometryHash } from '../public/js/shipgen.js';
import { loftHull, triBudget, DRAW_CALLS, ROWS_BELOW_HD, ROWS_ABOVE_HD, HD_STATIONS } from '../public/js/shipgeom.js';

const SAMPLE = ['ultramax64', 'cruise330', 'tug24', 'feeder1700', 'psv90'];
const mesh = (r, name) => r.group.children.find((m) => m.name === name);
const count = (m) => m ? m.geometry.attributes.position.count : 0;

test('HD loft: 13 rows below the waterline, 10 above, 90 / 45 stations; only at LOD0', () => {
  assert.equal(ROWS_BELOW_HD.length, 13); assert.equal(ROWS_ABOVE_HD.length, 10);
  assert.deepEqual(HD_STATIONS, { desktop: 90, phone: 45 });
  const ga = generalArrangement('ultramax64');
  const plain = loftHull(ga, { lod: 0 }), hd = loftHull(ga, { lod: 0, hd: true, stations: 90 });
  assert.ok(hd.rows >= plain.rows + 8, `rows ${plain.rows} → ${hd.rows}`);
  assert.equal(hd.stations, 91);
  assert.equal(loftHull(ga, { lod: 1, hd: true }).rows, loftHull(ga, { lod: 1 }).rows, 'LOD1 ignores hd');
});

test('HD own ship: to scale, more detail, budgets kept, draw calls unchanged (±2), desktop and phone', () => {
  for (const id of MODEL_IDS.filter((x) => MODELS[x].gen !== 'sail')) {
    const ga = generalArrangement(id);
    for (const phone of [false, true]) {
      const a = buildFromGA(ga, { lod: 0, phone }), h = buildFromGA(ga, { lod: 0, phone, hd: true });
      const b = shipBounds(h.group), L = b.max.z - b.min.z, B = b.max.x - b.min.x;
      assert.ok(Math.abs(L - ga.L) / ga.L <= 0.01 && Math.abs(B - ga.B) / ga.B <= 0.02, `${id}: to scale (${L.toFixed(1)} × ${B.toFixed(1)})`);
      assert.ok(Math.abs(b.min.y + ga.T) <= 0.1, `${id}: keel`);
      assert.ok(h.info.tris[0] > a.info.tris[0], `${id}${phone ? ' phone' : ''}: more triangles`);
      assert.ok(h.info.tris[0] <= triBudget(ga.gen, ga.L, phone), `${id}${phone ? ' phone' : ''}: ${h.info.tris[0]} within §6.6`);
      assert.ok(Math.abs(h.info.drawCalls[0] - a.info.drawCalls[0]) <= 2 && h.info.drawCalls[0] <= (phone ? DRAW_CALLS.phone : DRAW_CALLS.desktop), `${id}: draw calls ${a.info.drawCalls[0]} → ${h.info.drawCalls[0]}`);
    }
  }
});

test('HD parts: denser hull, bevelled house keeps its footprint, lathe funnel with lip and hollow top', () => {
  for (const id of SAMPLE) {
    const ga = generalArrangement(id);
    const a = buildFromGA(ga, { lod: 0 }), h = buildFromGA(ga, { lod: 0, hd: true });
    assert.ok(count(mesh(h, 'hull')) > count(mesh(a, 'hull')) * 2, `${id}: hull vertices ${count(mesh(a, 'hull'))} → ${count(mesh(h, 'hull'))}`);
    const ha = mesh(a, 'house'), hh = mesh(h, 'house');
    if (ha && hh) {
      ha.geometry.computeBoundingBox(); hh.geometry.computeBoundingBox();
      const A = ha.geometry.boundingBox, H = hh.geometry.boundingBox;
      for (const k of ['x', 'y', 'z']) assert.ok(Math.abs(A.min[k] - H.min[k]) < 0.02 && Math.abs(A.max[k] - H.max[k]) < 0.02, `${id}: house extent ${k} unchanged by the bevel`);
      assert.ok(count(hh) > count(ha), `${id}: bevel adds edge geometry`);
    }
    const f = ga.funnel;
    if (f && !['none', 'side', 'mast'].includes(f.kind) && f.h > 0) {
      const top = f.y + f.h, fh = mesh(h, 'funnel');
      fh.geometry.computeBoundingBox();
      assert.ok(fh.geometry.boundingBox.max.y < top - 0.05, `${id}: the casing ends under the black top`);
      const p = mesh(h, 'paint').geometry.attributes.position;
      let rim = 0, floor = 0;
      for (let i = 0; i < p.count; i++) {
        const y = p.getY(i);
        if (Math.abs(y - top) < 0.01) rim++;
        if (y < top - 0.05 && y > top - 1.7 && Math.abs(p.getZ(i) - f.z) < f.h * 0.2 + 2 && [0, -f.r * 1.15, f.r * 1.15].some((x) => Math.abs(p.getX(i) - x) < 1e-4)) floor++;
      }
      assert.ok(rim > 0, `${id}: funnel rim (lip) at the top`);
      assert.ok(floor > 0, `${id}: the casing top has a floor at the axis`);
    }
  }
});

test('HD is LOD0-only and deterministic; ships without hd are byte-identical to before', () => {
  const ga = generalArrangement('ultramax64');
  const a = buildFromGA(ga, { seed: 3 }), b = buildFromGA(generalArrangement('ultramax64'), { seed: 3, hd: true });
  assert.equal(geometryHash(a.lods[1]), geometryHash(b.lods[1]), 'LOD1 unchanged');
  assert.equal(geometryHash(a.lods[2]), geometryHash(b.lods[2]), 'LOD2 unchanged');
  assert.notEqual(geometryHash(a.lods[0]), geometryHash(b.lods[0]));
  const c = buildFromGA(generalArrangement('ultramax64'), { seed: 3, hd: true });
  assert.equal(geometryHash(b.lods[0]), geometryHash(c.lods[0]), 'same inputs → same HD geometry');
});
