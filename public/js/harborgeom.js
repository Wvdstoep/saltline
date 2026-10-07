// Client-side harbour geometry (docs/V3-CONTRACTS.md §5): fetches the geometry JSON and the binary patch of a
// harbour, decodes them, and builds a signed distance field (metres, negative inside obstacles) with a two-pass
// 3-4 chamfer transform over the mask. All lat/lon ↔ cell conversions use the shared §1 formulas.
import { PATCH, decodePatchHeight, patchCellToLatLon, latLonToPatchCell } from '/shared/constants.js';

const OBST = new Uint8Array(256);
for (const c of [PATCH.MASK.LAND, PATCH.MASK.QUAY, PATCH.MASK.BREAKWATER, PATCH.MASK.PONTOON]) OBST[c] = 1;
const HEADER = 28;                           // 'SLHP' u8 u8 u16 f32 f64 f64
const RETRY_MS = [1500, 3000, 6000, 10000];  // waits between the 5 tries
const MAX_TRIES = 5;

/** True for mask codes a ship cannot enter (land, quay, breakwater, pontoon). */
export function isObstacle(code) { return OBST[code & 255] === 1; }

/** Decode the binary patch (§1). Throws on a malformed buffer. */
export function decodePatch(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength < HEADER) throw new Error('patch too short');
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'SLHP') throw new Error('bad patch magic ' + magic);
  const version = dv.getUint8(4), flags = dv.getUint8(5);
  const n = dv.getUint16(6, true), res = dv.getFloat32(8, true);
  const originLat = dv.getFloat64(12, true), originLon = dv.getFloat64(20, true);
  if (!(n > 1 && n <= 4096) || !(res > 0)) throw new Error('bad patch header');
  if (buf.byteLength < HEADER + 2 * n * n) throw new Error('patch truncated');
  const heights = new Uint8Array(buf, HEADER, n * n);
  const mask = new Uint8Array(buf, HEADER + n * n, n * n);
  return { version, flags, synthetic: !!(flags & 1), n, res, origin: { lat: originLat, lon: originLon }, heights, mask };
}

/** 3-4 chamfer distance (×3, in cells) from every cell to the nearest cell whose obstacle-ness equals `toObstacle`. */
function chamfer(mask, n, toObstacle) {
  const INF = 1 << 29;
  const d = new Int32Array(n * n);
  const want = toObstacle ? 1 : 0;
  for (let k = 0; k < n * n; k++) d[k] = OBST[mask[k]] === want ? 0 : INF;
  for (let j = 0; j < n; j++) {
    const row = j * n;
    for (let i = 0; i < n; i++) {
      const k = row + i; let v = d[k]; if (v === 0) continue;
      if (i > 0) { const a = d[k - 1] + 3; if (a < v) v = a; }
      if (j > 0) {
        const b = d[k - n] + 3; if (b < v) v = b;
        if (i > 0) { const c = d[k - n - 1] + 4; if (c < v) v = c; }
        if (i < n - 1) { const e = d[k - n + 1] + 4; if (e < v) v = e; }
      }
      d[k] = v;
    }
  }
  for (let j = n - 1; j >= 0; j--) {
    const row = j * n;
    for (let i = n - 1; i >= 0; i--) {
      const k = row + i; let v = d[k]; if (v === 0) continue;
      if (i < n - 1) { const a = d[k + 1] + 3; if (a < v) v = a; }
      if (j < n - 1) {
        const b = d[k + n] + 3; if (b < v) v = b;
        if (i < n - 1) { const c = d[k + n + 1] + 4; if (c < v) v = c; }
        if (i > 0) { const e = d[k + n - 1] + 4; if (e < v) v = e; }
      }
      d[k] = v;
    }
  }
  return d;
}

/** Signed distance in metres at every cell centre: the zero crossing lies on the edge between a water and an obstacle cell. */
export function computeSDF(mask, n, res) {
  const dObs = chamfer(mask, n, true), dWat = chamfer(mask, n, false);
  const sdf = new Float32Array(n * n);
  const cap = n * res;
  for (let k = 0; k < n * n; k++) {
    if (OBST[mask[k]]) { const dw = dWat[k] / 3 - 0.5; sdf[k] = -Math.min(cap, dw * res); }
    else { const dob = dObs[k] / 3 - 0.5; sdf[k] = Math.min(cap, dob * res); }
  }
  return sdf;
}

/** Bilinear sample of a per-cell array at continuous cell coordinates (cell centre of (i, j) is i + 0.5, j + 0.5). */
function bilinear(arr, n, i, j, decode) {
  const u = Math.min(n - 1.0001, Math.max(0, i - 0.5)), v = Math.min(n - 1.0001, Math.max(0, j - 0.5));
  const i0 = Math.floor(u), j0 = Math.floor(v), fx = u - i0, fy = v - j0;
  const i1 = Math.min(n - 1, i0 + 1), j1 = Math.min(n - 1, j0 + 1);
  const a = decode(arr[j0 * n + i0]), b = decode(arr[j0 * n + i1]), c = decode(arr[j1 * n + i0]), d = decode(arr[j1 * n + i1]);
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}
const ident = (v) => v;

/** Real-metre height of a patch entry at lat/lon (bilinear over the decoded heights). null outside the patch. */
export function patchHeightAt(entry, lat, lon) {
  const c = latLonToPatchCell(lat, lon, entry.n, entry.res, entry.origin.lat, entry.origin.lon);
  if (c.i < 0 || c.j < 0 || c.i >= entry.n || c.j >= entry.n) return null;
  return bilinear(entry.heights, entry.n, c.i, c.j, decodePatchHeight);
}
/** Mask code of the cell under lat/lon, null outside. */
export function patchMaskAt(entry, lat, lon) {
  const c = latLonToPatchCell(lat, lon, entry.n, entry.res, entry.origin.lat, entry.origin.lon);
  const i = Math.floor(c.i), j = Math.floor(c.j);
  if (i < 0 || j < 0 || i >= entry.n || j >= entry.n) return null;
  return entry.mask[j * entry.n + i];
}
/** Signed distance (m) of a patch entry at lat/lon with the outward unit gradient (x east, z south). null outside. */
export function patchSdfAt(entry, lat, lon) {
  const c = latLonToPatchCell(lat, lon, entry.n, entry.res, entry.origin.lat, entry.origin.lon);
  if (c.i < 0 || c.j < 0 || c.i >= entry.n || c.j >= entry.n) return null;
  const n = entry.n, s = entry.sdf;
  const d = bilinear(s, n, c.i, c.j, ident);
  // central differences one cell apart: smoother than the piecewise-constant bilinear partials, still local
  const dxp = bilinear(s, n, c.i + 1, c.j, ident), dxm = bilinear(s, n, c.i - 1, c.j, ident);
  const dzp = bilinear(s, n, c.i, c.j + 1, ident), dzm = bilinear(s, n, c.i, c.j - 1, ident);
  let gx = (dxp - dxm) / (2 * entry.res), gz = (dzp - dzm) / (2 * entry.res);
  const l = Math.hypot(gx, gz);
  if (l > 1e-6) { gx /= l; gz /= l; }
  else { // flat (deep inside a big obstacle or far out at sea): point towards the patch centre's water as a last resort
    const i = Math.floor(c.i), j = Math.floor(c.j);
    gx = n / 2 - i; gz = n / 2 - j; const l2 = Math.hypot(gx, gz) || 1; gx /= l2; gz /= l2;
  }
  return { d, gx, gz, entry, mask: entry.mask[Math.min(n - 1, Math.floor(c.j)) * n + Math.min(n - 1, Math.floor(c.i))] };
}

function buildEntry(id, geom, patch) {
  const { n, res, origin, heights, mask } = patch;
  const sdf = computeSDF(mask, n, res);
  const nw = patchCellToLatLon(-0.5, -0.5, n, res, origin.lat, origin.lon), se = patchCellToLatLon(n - 0.5, n - 0.5, n, res, origin.lat, origin.lon);
  const bbox = { latMin: Math.min(nw.lat, se.lat), latMax: Math.max(nw.lat, se.lat), lonMin: Math.min(nw.lon, se.lon), lonMax: Math.max(nw.lon, se.lon) };
  return { id, geom, n, res, origin, heights, mask, sdf, bbox, radiusM: (n * res) / 2, synthetic: patch.synthetic, version: patch.version };
}

export class HarborGeomSet {
  constructor() {
    this.entries = new Map();   // id -> entry
    this.loading = new Map();   // id -> { promise, job }
  }
  /** Fetch + decode a harbour's geometry. Resolves to the entry, or null after 5 failed tries (404 while building, network). */
  async load(harborId) {
    const id = String(harborId);
    if (this.entries.has(id)) return this.entries.get(id);
    if (this.loading.has(id)) return this.loading.get(id).promise;
    const job = { cancelled: false };
    const promise = (async () => {
      try {
        const [geom, bin] = await Promise.all([
          this.fetchRetry(`/api/harbor/${encodeURIComponent(id)}/geom`, 'json', job),
          this.fetchRetry(`/api/harbor/${encodeURIComponent(id)}/patch`, 'bin', job),
        ]);
        if (job.cancelled || !geom || !bin) return null;
        const patch = decodePatch(bin);
        const entry = buildEntry(id, geom, patch);
        if (job.cancelled) return null;
        this.entries.set(id, entry);
        return entry;
      } catch (e) {
        console.warn('[harborgeom] load failed', id, e?.message || e);
        return null;
      } finally { if (this.loading.get(id)?.job === job) this.loading.delete(id); }
    })();
    this.loading.set(id, { promise, job });
    return promise;
  }
  /** GET with retries: 404 (harbour still building), 5xx and network errors all back off; gives up after 5 tries. */
  async fetchRetry(url, kind, job) {
    for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
      if (job?.cancelled) return null;
      try {
        const r = await fetch(url, { headers: kind === 'json' ? { Accept: 'application/json' } : {} });
        if (r.ok) return kind === 'json' ? await r.json() : await r.arrayBuffer();
        if (r.status === 400) return null; // never going to work
      } catch (e) { /* network: retry */ }
      if (attempt < MAX_TRIES - 1) await new Promise((res) => setTimeout(res, RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]));
    }
    return null;
  }
  unload(id) {
    id = String(id);
    const l = this.loading.get(id); if (l) { l.job.cancelled = true; this.loading.delete(id); }
    this.entries.delete(id);
  }
  get(id) { return this.entries.get(String(id)) || null; }
  has(id) { return this.entries.has(String(id)); }
  isLoading(id) { return this.loading.has(String(id)); }
  get size() { return this.entries.size; }
  /** Entry whose origin is nearest to lat/lon (not necessarily covering it). */
  nearest(lat, lon) {
    let best = null, bd = Infinity;
    for (const e of this.entries.values()) {
      const c = latLonToPatchCell(lat, lon, e.n, e.res, e.origin.lat, e.origin.lon);
      const d = Math.hypot((c.i - e.n / 2) * e.res, (c.j - e.n / 2) * e.res);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }
  /** Entry covering lat/lon (the nearest origin wins where patches overlap), or null. */
  coverAt(lat, lon) {
    let best = null, bd = Infinity;
    for (const e of this.entries.values()) {
      const b = e.bbox;
      if (lat < b.latMin || lat > b.latMax || lon < b.lonMin || lon > b.lonMax) continue;
      const c = latLonToPatchCell(lat, lon, e.n, e.res, e.origin.lat, e.origin.lon);
      if (c.i < 0 || c.j < 0 || c.i >= e.n || c.j >= e.n) continue;
      const d = Math.hypot(c.i - e.n / 2, c.j - e.n / 2);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }
  /** Any entry whose footprint comes within `marginM` metres of lat/lon (cheap pre-check for collision). */
  entryNear(lat, lon, marginM = 0) {
    for (const e of this.entries.values()) {
      const c = latLonToPatchCell(lat, lon, e.n, e.res, e.origin.lat, e.origin.lon);
      const m = marginM / e.res;
      if (c.i >= -m && c.j >= -m && c.i < e.n + m && c.j < e.n + m) return e;
    }
    return null;
  }
  sdfAt(lat, lon) { const e = this.coverAt(lat, lon); return e ? patchSdfAt(e, lat, lon) : null; }
  heightAt(lat, lon) { const e = this.coverAt(lat, lon); return e ? patchHeightAt(e, lat, lon) : null; }
  maskAt(lat, lon) { const e = this.coverAt(lat, lon); return e ? patchMaskAt(e, lat, lon) : null; }
}
