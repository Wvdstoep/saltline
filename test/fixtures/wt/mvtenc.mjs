// Tiny Mapbox Vector Tile encoder for the tests and the fixture slimmer (docs/WORLD-DETAIL-STREAMING.md §5.1). Takes the
// same shape server/mvt.js decodes to: { layers: { <name>: { extent, features: [{ id?, type, tags, geom }] } } }
// (type 1: geom = [[x, y, …]]; type 2: [[x, y, …], …]; type 3: [[ring, ring, …], …] with exterior rings clockwise in
// tile coordinates). Values: strings, booleans, integers (sint when negative, uint otherwise), other numbers as double.

class Writer {
  constructor() { this.buf = []; }
  byte(b) { this.buf.push(b & 255); }
  varint(n) {
    n = Number(n);
    if (n < 0) throw new Error('negative varint');
    while (n >= 0x80) { this.byte((n % 128) | 0x80); n = Math.floor(n / 128); }
    this.byte(n);
  }
  tag(f, w) { this.varint(f * 8 + w); }
  bytes(f, u8) { this.tag(f, 2); this.varint(u8.length); for (const b of u8) this.byte(b); }
  string(f, s) { this.bytes(f, new TextEncoder().encode(s)); }
  packed(f, arr) { const w = new Writer(); for (const v of arr) w.varint(v); this.bytes(f, w.out()); }
  double(f, v) { this.tag(f, 1); const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); for (const x of b) this.byte(x); }
  float(f, v) { this.tag(f, 5); const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); for (const x of b) this.byte(x); }
  out() { return Uint8Array.from(this.buf); }
}
const zz = (n) => (n << 1) ^ (n >> 31);
const cmd = (id, count) => (count << 3) | id;

function geometry(type, geom) {
  const out = [];
  let x = 0, y = 0;
  const move = (px, py) => { out.push(zz(px - x), zz(py - y)); x = px; y = py; };
  const line = (pts, close) => {
    out.push(cmd(1, 1)); move(pts[0], pts[1]);
    const n = pts.length / 2 - 1;
    if (n > 0) { out.push(cmd(2, n)); for (let i = 2; i < pts.length; i += 2) move(pts[i], pts[i + 1]); }
    if (close) out.push(cmd(7, 1));
  };
  if (type === 1) { const pts = geom.flat(); out.push(cmd(1, pts.length / 2)); for (let i = 0; i < pts.length; i += 2) move(pts[i], pts[i + 1]); }
  else if (type === 2) for (const l of geom) line(l, false);
  else if (type === 3) for (const poly of geom) for (const ring of poly) line(ring, true);
  return out;
}

/** Encode a tile; `opts.raw` lets a test inject extra raw fields. Returns a Uint8Array (not gzip'd). */
export function encodeMVT(tile, opts = {}) {
  const w = new Writer();
  for (const [name, layer] of Object.entries(tile.layers || {})) {
    const L = new Writer(), keys = [], kIdx = new Map(), values = [], vIdx = new Map();
    L.varint(15 * 8); L.varint(layer.version || 2);
    L.string(1, name);
    for (const f of layer.features || []) {
      const F = new Writer(), tags = [];
      for (const [k, v] of Object.entries(f.tags || {})) {
        if (v === null || v === undefined) continue;
        if (!kIdx.has(k)) { kIdx.set(k, keys.length); keys.push(k); }
        const vk = typeof v + ':' + String(v);
        if (!vIdx.has(vk)) { vIdx.set(vk, values.length); values.push(v); }
        tags.push(kIdx.get(k), vIdx.get(vk));
      }
      if (f.id != null) { F.tag(1, 0); F.varint(f.id); }
      if (tags.length) F.packed(2, tags);
      F.tag(3, 0); F.varint(f.type);
      F.packed(4, geometry(f.type, f.geom));
      if (opts.raw?.feature) for (const b of opts.raw.feature) F.byte(b);
      L.bytes(2, F.out());
    }
    for (const k of keys) L.string(3, k);
    for (const v of values) {
      const V = new Writer();
      if (typeof v === 'string') V.string(1, v);
      else if (typeof v === 'boolean') { V.tag(7, 0); V.varint(v ? 1 : 0); }
      else if (typeof v === 'object' && v && v.float != null) V.float(2, v.float);
      else if (Number.isInteger(v) && v >= 0) { V.tag(5, 0); V.varint(v); }
      else if (Number.isInteger(v)) { V.tag(6, 0); V.varint(-2 * v - 1); }
      else V.double(3, v);
      L.bytes(4, V.out());
    }
    L.tag(5, 0); L.varint(layer.extent || 4096);
    if (opts.raw?.layer) for (const b of opts.raw.layer) L.byte(b);
    w.bytes(3, L.out());
  }
  if (opts.raw?.tile) for (const b of opts.raw.tile) w.byte(b);
  return w.out();
}
