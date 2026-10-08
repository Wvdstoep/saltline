// Mapbox Vector Tile decoder (docs/WORLD-DETAIL-STREAMING.md §3.3): protobuf varints / zigzag, MoveTo / LineTo /
// ClosePath, polygon rings grouped by winding, Value types string / float / double / int / uint / sint / bool. Plain ESM,
// no deps; a gzip'd buffer (magic 1f 8b) is inflated first. Never throws: a malformed or truncated tile decodes to
// `{ layers: {}, error }`.
//
// Output: { layers: { <name>: { extent, version, features: [{ id, type, tags, geom }] } } }
//   type 1 (point):   geom = [[x0, y0, x1, y1, …]]            (one flat list of points)
//   type 2 (line):    geom = [[x0, y0, x1, y1, …], …]         (one flat list per line)
//   type 3 (polygon): geom = [[ring, ring, …], …]              (one entry per polygon: exterior ring first, then its
//                                                               holes; rings are flat lists, closed implicitly)
// Coordinates are tile units (0..extent, x east, y south; buffered features reach below 0 and above extent).
// Exterior rings are clockwise in tile coordinates (positive surveyor area with y down); zero-area rings are dropped.
import zlib from 'node:zlib';

export const GEOM_TYPE = { UNKNOWN: 0, POINT: 1, LINESTRING: 2, POLYGON: 3 };

class Reader {
  constructor(u8, start = 0, end = u8.length) { this.u8 = u8; this.pos = start; this.end = end; }
  varint() {
    const u8 = this.u8;
    let r = 0, s = 0, b;
    do {
      if (this.pos >= this.end) throw new Error('truncated varint');
      b = u8[this.pos++];
      if (s < 28) r |= (b & 0x7f) << s; else r += (b & 0x7f) * 2 ** s;
      s += 7;
      if (s > 70) throw new Error('varint too long');
    } while (b & 0x80);
    return s <= 28 ? r >>> 0 : r;
  }
  /** 64-bit varint as a Number (exact up to 2^53), two's complement for negative int64. */
  varint64() {
    const u8 = this.u8;
    let lo = 0, hi = 0, s = 0, b;
    do {
      if (this.pos >= this.end) throw new Error('truncated varint');
      b = u8[this.pos++];
      if (s < 28) lo |= (b & 0x7f) << s;
      else if (s === 28) { lo |= (b & 0x0f) << 28; hi |= (b & 0x7f) >> 4; }
      else hi |= (b & 0x7f) << (s - 32);
      s += 7;
      if (s > 70) throw new Error('varint too long');
    } while (b & 0x80);
    if (hi & 0x80000000) { lo = ~lo >>> 0; hi = ~hi >>> 0; return -((hi * 4294967296 + lo) + 1); }
    return (hi >>> 0) * 4294967296 + (lo >>> 0);
  }
  bytes() { const n = this.varint(); if (this.pos + n > this.end) throw new Error('truncated bytes'); const s = this.pos; this.pos += n; return [s, this.pos]; }
  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) { const n = this.varint(); this.pos += n; }
    else if (wire === 5) this.pos += 4;
    else throw new Error('bad wire type ' + wire);
    if (this.pos > this.end) throw new Error('truncated field');
  }
}
const utf8 = new TextDecoder();
const zz = (n) => (n >>> 1) ^ -(n & 1);

function readValue(u8, s, e) {
  const r = new Reader(u8, s, e);
  let v = null;
  while (r.pos < r.end) {
    const tag = r.varint(), f = tag >>> 3, w = tag & 7;
    if (f === 1 && w === 2) { const [a, b] = r.bytes(); v = utf8.decode(u8.subarray(a, b)); }
    else if (f === 2 && w === 5) { if (r.pos + 4 > r.end) throw new Error('truncated float'); v = new DataView(u8.buffer, u8.byteOffset + r.pos, 4).getFloat32(0, true); r.pos += 4; }
    else if (f === 3 && w === 1) { if (r.pos + 8 > r.end) throw new Error('truncated double'); v = new DataView(u8.buffer, u8.byteOffset + r.pos, 8).getFloat64(0, true); r.pos += 8; }
    else if (f === 4 && w === 0) v = r.varint64();
    else if (f === 5 && w === 0) v = r.varint64();
    else if (f === 6 && w === 0) { const n = r.varint64(); v = n % 2 === 0 ? n / 2 : -(n + 1) / 2; }
    else if (f === 7 && w === 0) v = r.varint() !== 0;
    else r.skip(w);
  }
  return v;
}
function packed(r, out) { const [s, e] = r.bytes(); const p = new Reader(r.u8, s, e); while (p.pos < p.end) out.push(p.varint()); return out; }

/** Surveyor area with y down (positive = clockwise on screen = exterior in MVT 2.x). */
export function ringArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i += 2) { const j = (i + 2) % n; a += ring[i] * ring[j + 1] - ring[j] * ring[i + 1]; }
  return a / 2;
}

function decodeGeometry(type, cmds) {
  const parts = [];
  let x = 0, y = 0, cur = null, i = 0;
  while (i < cmds.length) {
    const c = cmds[i++], id = c & 7, count = c >>> 3;
    if (id === 1 || id === 2) {
      for (let k = 0; k < count; k++) {
        if (i + 2 > cmds.length) throw new Error('truncated geometry');
        x += zz(cmds[i++]); y += zz(cmds[i++]);
        if (id === 1 && type !== GEOM_TYPE.POINT) { cur = [x, y]; parts.push(cur); }
        else if (type === GEOM_TYPE.POINT) { if (!cur) { cur = []; parts.push(cur); } cur.push(x, y); }
        else if (cur) cur.push(x, y);
      }
    } else if (id === 7) { /* ClosePath: rings are closed implicitly */ }
    else throw new Error('bad command ' + id);
  }
  if (type === GEOM_TYPE.POINT) return parts.length ? [parts.flat()] : [];
  if (type === GEOM_TYPE.LINESTRING) return parts.filter((p) => p.length >= 4);
  if (type !== GEOM_TYPE.POLYGON) return parts;
  // group rings into polygons: a clockwise (positive) ring starts a polygon, the anticlockwise rings after it are holes
  const polys = [];
  for (const ring of parts) {
    if (ring.length >= 6 && ring[0] === ring[ring.length - 2] && ring[1] === ring[ring.length - 1]) ring.length -= 2;
    if (ring.length < 6) continue;
    const a = ringArea(ring);
    if (a === 0) continue;
    if (a > 0 || !polys.length) polys.push([a > 0 ? ring : reverseRing(ring)]);   // a leading hole is malformed: use it as an exterior
    else polys[polys.length - 1].push(ring);
  }
  return polys;
}
function reverseRing(r) { const out = new Array(r.length); for (let i = 0, n = r.length; i < n; i += 2) { out[n - 2 - i] = r[i]; out[n - 1 - i] = r[i + 1]; } return out; }

function readFeature(u8, s, e, keys, values) {
  const r = new Reader(u8, s, e);
  let id = null, type = 0;
  const tagIdx = [], cmds = [];
  while (r.pos < r.end) {
    const tag = r.varint(), f = tag >>> 3, w = tag & 7;
    if (f === 1 && w === 0) id = r.varint64();
    else if (f === 2 && w === 2) packed(r, tagIdx);
    else if (f === 3 && w === 0) type = r.varint();
    else if (f === 4 && w === 2) packed(r, cmds);
    else r.skip(w);
  }
  const tags = {};
  for (let k = 0; k + 1 < tagIdx.length; k += 2) {
    const kk = keys[tagIdx[k]], vv = values[tagIdx[k + 1]];
    if (kk !== undefined && vv !== undefined) tags[kk] = vv;
  }
  return { id, type, tags, geom: decodeGeometry(type, cmds) };
}

function readLayer(u8, s, e) {
  const r = new Reader(u8, s, e);
  let name = '', extent = 4096, version = 1;
  const keys = [], values = [], feats = [];
  while (r.pos < r.end) {
    const tag = r.varint(), f = tag >>> 3, w = tag & 7;
    if (f === 1 && w === 2) { const [a, b] = r.bytes(); name = utf8.decode(u8.subarray(a, b)); }
    else if (f === 2 && w === 2) feats.push(r.bytes());
    else if (f === 3 && w === 2) { const [a, b] = r.bytes(); keys.push(utf8.decode(u8.subarray(a, b))); }
    else if (f === 4 && w === 2) { const [a, b] = r.bytes(); values.push(readValue(u8, a, b)); }
    else if (f === 5 && w === 0) extent = r.varint();
    else if (f === 15 && w === 0) version = r.varint();
    else r.skip(w);
  }
  return { name, layer: { extent, version, features: feats.map(([a, b]) => readFeature(u8, a, b, keys, values)) } };
}

/** Is this buffer gzip'd? */
export const isGzip = (u8) => u8 && u8.length >= 2 && u8[0] === 0x1f && u8[1] === 0x8b;

/** Decode an MVT (raw or gzip'd). Never throws. */
export function decodeMVT(buf) {
  try {
    let u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (isGzip(u8)) u8 = new Uint8Array(zlib.gunzipSync(u8));
    const r = new Reader(u8), layers = {};
    while (r.pos < r.end) {
      const tag = r.varint(), f = tag >>> 3, w = tag & 7;
      if (f === 3 && w === 2) { const [a, b] = r.bytes(); const { name, layer } = readLayer(u8, a, b); if (name) layers[name] = layer; }
      else r.skip(w);
    }
    return { layers };
  } catch (e) {
    return { layers: {}, error: String(e?.message || e) };
  }
}

/** Summary for probes and logs: { <layer>: { n, classes: { <class>: count } } }. */
export function summarizeMVT(mvt) {
  const out = {};
  for (const [name, l] of Object.entries(mvt.layers || {})) {
    const classes = {};
    for (const f of l.features) { const c = f.tags.class ?? f.tags.subclass ?? '-'; classes[c] = (classes[c] || 0) + 1; }
    out[name] = { n: l.features.length, extent: l.extent, classes };
  }
  return out;
}
