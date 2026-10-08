// World tile format (shared/wtformat.js, docs/WORLD-DETAIL-STREAMING.md §3.2): byte layout, round trips incl. uniform
// tiles, height codec, tile maths, contentHash stability.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WT, WT_NAVIGABLE, WT_OBSTACLE, encodeWTHeight, decodeWTHeight, tileKey, tileSizeM, tileF, tileFToLatLon, cellOf, cellLatLon,
  tilesInRadius, fnv1a, encodeTile, decodeTile, tileHeightAt, tileMaskAt,
} from '../shared/wtformat.js';
import { PATCH } from '../shared/constants.js';

function sampleTile(over = {}) {
  const n = 8, mask = new Uint8Array(n * n), height = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) { mask[i] = i % 11; height[i] = encodeWTHeight(WT_NAVIGABLE[mask[i]] ? -(i % 20) - 1 : (i % 7) + 0.5); }
  return { z: 14, x: 8381, y: 5418, n, flags: 0, rev: 1, srcHash: 0xdeadbeef, builtAt: 1791480000, mask, height, vectors: { v: 1, src: 'ofm:test', quays: [{ p: [0, 0, 100, 0], side: 1, k: 'derived', top: 3 }] }, ...over };
}

test('mask codes 0..6 match PATCH.MASK; navigable / obstacle tables are complementary', () => {
  for (const [k, v] of Object.entries(PATCH.MASK)) assert.equal(WT.MASK[k], v);
  assert.deepEqual([...WT_NAVIGABLE], [1, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0]);
  for (let m = 0; m <= 10; m++) assert.notEqual(WT_NAVIGABLE[m], WT_OBSTACLE[m]);
});

test('header: magic SLWT little endian, 40 bytes, fields at the documented offsets', () => {
  const t = sampleTile(), buf = encodeTile(t), dv = new DataView(buf.buffer);
  assert.equal(String.fromCharCode(buf[0], buf[1], buf[2], buf[3]), 'SLWT');
  assert.equal(dv.getUint32(0, true), WT.MAGIC);
  assert.equal(dv.getUint16(4, true), WT.FORMAT);
  assert.equal(buf[6], 14); assert.equal(buf[7], 0);
  assert.equal(dv.getUint32(8, true), 8381); assert.equal(dv.getUint32(12, true), 5418);
  assert.equal(dv.getUint16(16, true), 8); assert.equal(dv.getUint16(18, true), 1);
  assert.equal(dv.getUint32(20, true), 0xdeadbeef); assert.equal(dv.getUint32(24, true), 1791480000);
  const vec = new TextEncoder().encode(JSON.stringify(t.vectors));
  assert.equal(dv.getUint32(28, true), vec.length);
  assert.equal(buf.length, 40 + 2 * 64 + vec.length);
  assert.equal(dv.getUint32(32, true), fnv1a(buf.subarray(40)));
});

test('encode / decode round trip (mask, height, vectors, all header fields)', () => {
  const t = sampleTile(), d = decodeTile(encodeTile(t));
  for (const k of ['z', 'x', 'y', 'n', 'flags', 'rev', 'srcHash', 'builtAt']) assert.equal(d[k], t[k], k);
  assert.deepEqual([...d.mask], [...t.mask]);
  assert.deepEqual([...d.height], [...t.height]);
  assert.deepEqual(d.vectors, t.vectors);
  // decoding a copy at a byte offset works too (subarray of a bigger buffer)
  const big = new Uint8Array(encodeTile(t).length + 7); big.set(encodeTile(t), 7);
  assert.deepEqual(decodeTile(big.subarray(7)).vectors, t.vectors);
});

test('uniform tiles are 40 bytes and answer every query with their uniform height / mask', () => {
  const sea = encodeTile({ z: 14, x: 1, y: 2, flags: WT.FLAG.UNIFORM, srcHash: 1, builtAt: 2, uniformH: -24.3 });
  assert.equal(sea.length, 40);
  const d = decodeTile(sea);
  assert.equal(d.mask, null); assert.equal(d.height, null); assert.equal(d.vectors, null);
  assert.equal(d.uniformH, -24.3);
  assert.equal(tileHeightAt(d, 10, 10), -24.3);
  assert.equal(tileMaskAt(d, 5, 5), WT.MASK.WATER);
  const land = decodeTile(encodeTile({ z: 11, x: 3, y: 4, flags: WT.FLAG.UNIFORM | WT.FLAG.UNIFORM_LAND, uniformH: 20 }));
  assert.equal(tileMaskAt(land, 0, 0), WT.MASK.LAND);
  assert.equal(land.uniformH, 20);
});

test('decodeTile rejects foreign bytes and other formats', () => {
  assert.throws(() => decodeTile(new Uint8Array(10)), /not an SLWT/);
  const b = encodeTile(sampleTile()); new DataView(b.buffer).setUint16(4, 99, true);
  assert.throws(() => decodeTile(b), /format 99/);
});

test('height codec: monotonic, ≤ 0.125 m error within ±24 m, 4 m steps beyond, clamped', () => {
  let prev = -1;
  for (let h = -160; h <= 160; h += 0.05) { const v = encodeWTHeight(h); assert.ok(v >= prev, `monotonic at ${h}`); prev = v; }
  for (let h = -24; h <= 24; h += 0.01) assert.ok(Math.abs(decodeWTHeight(encodeWTHeight(h)) - h) <= 0.125 + 1e-9, `error at ${h}`);
  for (let h = -150; h <= -24; h += 1) assert.ok(Math.abs(decodeWTHeight(encodeWTHeight(h)) - h) <= 2 + 1e-9);
  for (let h = 24; h <= 146; h += 1) assert.ok(Math.abs(decodeWTHeight(encodeWTHeight(h)) - h) <= 2 + 1e-9);
  assert.equal(encodeWTHeight(-1000), 0); assert.equal(encodeWTHeight(1000), 255);
  assert.equal(encodeWTHeight(-0.5), 126); assert.equal(encodeWTHeight(0.25), 129);   // the converter's invariants
  assert.ok(decodeWTHeight(126) < 0 && decodeWTHeight(129) > 0);
});

test('tileF ↔ tileFToLatLon round trip < 1 cm; cellOf / cellLatLon agree; tile size', () => {
  for (const [lat, lon] of [[51.968, 4.035], [-33.97, 151.21], [1.2, 103.85], [84.9, -179.9], [-84.9, 179.9], [0, 0]]) {
    for (const z of [11, 14]) {
      const { fx, fy } = tileF(z, lat, lon), r = tileFToLatLon(z, fx, fy);
      assert.ok(Math.abs(r.lat - lat) * 111320 < 0.01 && Math.abs(r.lon - lon) * 111320 * Math.cos((lat * Math.PI) / 180) < 0.01, `${lat},${lon} z${z}`);
      const c = cellOf(z, lat, lon), back = cellLatLon(z, c.x, c.y, Math.floor(c.u), Math.floor(c.v));
      assert.ok(Math.abs(back.lat - lat) * 111320 < tileSizeM(z, lat) / 256 + 0.01);
    }
  }
  assert.equal(tileKey(14, 1, 2), '14/1/2');
  assert.ok(Math.abs(tileSizeM(14, 0) - 2445.98) < 0.1);
  assert.ok(Math.abs(tileSizeM(14, 52) / 256 - 5.88) < 0.02);
});

test('tilesInRadius: sorted nearest first, complete, wraps the antimeridian, drops rows off the map', () => {
  const lat = 51.968, lon = 4.035, r = 3000, z = 14;
  const list = tilesInRadius(z, lat, lon, r);
  for (let i = 1; i < list.length; i++) assert.ok(list[i].d >= list[i - 1].d);
  assert.equal(list[0].d, 0);
  // completeness: every tile whose square comes within r (brute force over a wide window)
  const { fx, fy } = tileF(z, lat, lon), s = tileSizeM(z, lat), keys = new Set(list.map((t) => `${t.x}/${t.y}`));
  for (let y = Math.floor(fy) - 5; y <= Math.floor(fy) + 5; y++) for (let x = Math.floor(fx) - 5; x <= Math.floor(fx) + 5; x++) {
    const ex = Math.max(0, Math.abs(fx - (x + 0.5)) - 0.5), ey = Math.max(0, Math.abs(fy - (y + 0.5)) - 0.5);
    assert.equal(keys.has(`${x}/${y}`), Math.hypot(ex, ey) * s <= r, `${x}/${y}`);
  }
  const wrap = tilesInRadius(14, 0, 179.999, 2000);
  assert.ok(wrap.some((t) => t.x === 0) && wrap.some((t) => t.x === 2 ** 14 - 1));
  assert.ok(tilesInRadius(14, 85.05, 0, 5000).every((t) => t.y >= 0));
});

test('contentHash is stable and covers the body; tile bilinear height and mask lookups', () => {
  const a = encodeTile(sampleTile()), b = encodeTile(sampleTile());
  assert.deepEqual(a, b);
  const c = encodeTile(sampleTile({ vectors: { v: 1, src: 'ofm:other' } }));
  assert.notEqual(decodeTile(a).contentHash, decodeTile(c).contentHash);
  assert.equal(fnv1a(new Uint8Array(0)), 2166136261);
  // bilinear between two cell centres
  const n = 2, t = decodeTile(encodeTile({ z: 14, x: 0, y: 0, n, flags: 0, mask: new Uint8Array([0, 1, 0, 1]), height: new Uint8Array([encodeWTHeight(-4), encodeWTHeight(4), encodeWTHeight(-4), encodeWTHeight(4)]) }));
  assert.equal(tileHeightAt(t, 0.5, 0.5), -4);
  assert.equal(tileHeightAt(t, 1.0, 1.0), 0);
  assert.equal(tileHeightAt(t, -3, 0.5), -4);       // edges clamp
  assert.equal(tileMaskAt(t, 1.7, 0.2), 1);
  assert.equal(tileMaskAt(t, 99, 99), 1);
});
