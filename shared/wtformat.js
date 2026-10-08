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
