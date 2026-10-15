// public/js/skynoise.js - tileable noise for the clouds, generated on the client (no image assets), pure JS (node-testable).
//  - shape volume (N^3, R8): Perlin-Worley - billowy cumulus shapes (Schneider, "Real-time volumetric cloudscapes", 2015)
//  - detail volume (N^3, R8): Worley fbm - erodes the edges into wisps
//  - weather map (N^2, RGBA8): R = cloud-cover field, histogram-equalised so a threshold at (1 - cover) covers exactly
//    `cover` of the sky (the real cloud % from the weather data becomes the real fraction of sky with cloud);
//    G = convective cells (where cumulonimbus towers grow); B = high-cloud (cirrus) field, also equalised.
// The 3D volumes are expensive (hundreds of ms), so they are produced by generators that the caller runs a few
// slices per frame.

function makePerm(seed) {
  const p = new Uint8Array(512), a = new Uint8Array(256);
  for (let i = 0; i < 256; i++) a[i] = i;
  let s = seed >>> 0 || 1;
  for (let i = 255; i > 0; i--) { s = (s * 1664525 + 1013904223) >>> 0; const j = s % (i + 1); const t = a[i]; a[i] = a[j]; a[j] = t; }
  for (let i = 0; i < 512; i++) p[i] = a[i & 255];
  return p;
}
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;
function grad3(h, x, y, z) {
  const k = h & 15, u = k < 8 ? x : y, v = k < 4 ? y : k === 12 || k === 14 ? x : z;
  return ((k & 1) ? -u : u) + ((k & 2) ? -v : v);
}
/** Periodic improved Perlin noise in [-1, 1] (period P lattice cells on every axis). */
export function perlin3(x, y, z, P, perm) {
  const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
  const fx = x - X, fy = y - Y, fz = z - Z;
  const u = fade(fx), v = fade(fy), w = fade(fz);
  const m = (i) => ((i % P) + P) % P;
  const x0 = m(X), x1 = m(X + 1), y0 = m(Y), y1 = m(Y + 1), z0 = m(Z), z1 = m(Z + 1);
  const h = (a, b, c) => perm[perm[perm[a] + b] + c];
  return lerp(
    lerp(lerp(grad3(h(x0, y0, z0), fx, fy, fz), grad3(h(x1, y0, z0), fx - 1, fy, fz), u),
      lerp(grad3(h(x0, y1, z0), fx, fy - 1, fz), grad3(h(x1, y1, z0), fx - 1, fy - 1, fz), u), v),
    lerp(lerp(grad3(h(x0, y0, z1), fx, fy, fz - 1), grad3(h(x1, y0, z1), fx - 1, fy, fz - 1), u),
      lerp(grad3(h(x0, y1, z1), fx, fy - 1, fz - 1), grad3(h(x1, y1, z1), fx - 1, fy - 1, fz - 1), u), v), w);
}
/** Periodic Worley F1 (inverted: 1 at feature points, 0 far away), C cells per axis, coords in [0,1). */
export function worley3(x, y, z, C, perm) {
  const px = x * C, py = y * C, pz = z * C;
  const cx = Math.floor(px), cy = Math.floor(py), cz = Math.floor(pz);
  let best = 9;
  for (let k = -1; k <= 1; k++) for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const ix = cx + i, iy = cy + j, iz = cz + k;
    const wx = ((ix % C) + C) % C, wy = ((iy % C) + C) % C, wz = ((iz % C) + C) % C;
    const hsh = perm[perm[perm[wx & 255] + (wy & 255)] + (wz & 255)];
    const fx = ix + (hsh / 255), fy = iy + (perm[(hsh + 71) & 255] / 255), fz = iz + (perm[(hsh + 151) & 255] / 255);
    const d = (fx - px) ** 2 + (fy - py) ** 2 + (fz - pz) ** 2;
    if (d < best) best = d;
  }
  return Math.max(0, 1 - Math.sqrt(best));
}
const remap = (v, a, b, c, d) => c + ((v - a) / (b - a)) * (d - c);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Generator: fills an N^3 Uint8Array with Perlin-Worley; yields after every z slice. Result in `.data`. */
export function* shapeVolume(N = 64, seed = 7) {
  const perm = makePerm(seed), permW = makePerm(seed * 31 + 5);
  const data = new Uint8Array(N * N * N);
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const u = x / N, v = y / N, w = z / N;
      let p = 0, amp = 1, norm = 0;
      for (const P of [4, 8, 16]) { p += perlin3(u * P, v * P, w * P, P, perm) * amp; norm += amp; amp *= 0.5; }
      p = clamp01(p / norm * 0.9 + 0.5);
      const wf = worley3(u, v, w, 3, permW) * 0.625 + worley3(u, v, w, 6, permW) * 0.25 + worley3(u, v, w, 12, permW) * 0.125;
      const pw = clamp01(remap(p, wf - 1, 1, 0, 1));          // Perlin-Worley: billows
      data[(z * N + y) * N + x] = Math.round(clamp01(pw * 0.6 + wf * 0.4) * 255);
    }
    yield z;
  }
  return stretch(data);
}
/** Generator: N^3 Worley fbm for edge erosion. */
export function* detailVolume(N = 32, seed = 11) {
  const perm = makePerm(seed);
  const data = new Uint8Array(N * N * N);
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const u = x / N, v = y / N, w = z / N;
      const f = worley3(u, v, w, 3, perm) * 0.625 + worley3(u, v, w, 6, perm) * 0.25 + worley3(u, v, w, 12, perm) * 0.125;
      data[(z * N + y) * N + x] = Math.round(clamp01(f) * 255);
    }
    yield z;
  }
  return stretch(data);
}
/** Rescale a Uint8Array in place to use the full 0..255 range. */
function stretch(data) {
  let mn = 255, mx = 0;
  for (let i = 0; i < data.length; i++) { const v = data[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
  const k = 255 / Math.max(1, mx - mn);
  for (let i = 0; i < data.length; i++) data[i] = Math.round((data[i] - mn) * k);
  return data;
}
/** Run a generator to completion (tests, or when time does not matter). */
export function runAll(gen) { let r = gen.next(); while (!r.done) r = gen.next(); return r.value; }

function equalise(vals) {
  const n = vals.length, idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((a, b) => vals[a] - vals[b]);
  const out = new Float32Array(n);
  for (let r = 0; r < n; r++) out[idx[r]] = (r + 0.5) / n;
  return out;
}
/**
 * Weather map, N x N RGBA8, periodic. R: equalised cloud-cover field (smooth, ~4 large features per tile plus
 * smaller ones); G: convective cells (inverted Worley, peaks = storm-cell centres); B: equalised cirrus field
 * (stretched along x - the shader rotates it with the high-level wind).
 */
export function weatherMap(N = 256, seed = 3) {
  const perm = makePerm(seed), perm2 = makePerm(seed + 17), perm3 = makePerm(seed + 29);
  const R = new Float32Array(N * N), G = new Float32Array(N * N), B = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N, i = y * N + x;
    let r = 0, amp = 1;
    for (const P of [3, 6, 12, 24, 48]) { r += perlin3(u * P, v * P, 0.37, P, perm) * amp; amp *= 0.55; }
    R[i] = r;
    G[i] = worley3(u, v, 0.5, 5, perm2);
    let b = 0; amp = 1;
    for (const P of [2, 4, 8, 16]) { b += perlin3(u * P, v * P * 4, 0.71, P, perm3) * amp; amp *= 0.5; }
    B[i] = b;
  }
  const Re = equalise(R), Be = equalise(B);
  const data = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    data[i * 4] = Math.round(Re[i] * 255); data[i * 4 + 1] = Math.round(clamp01(G[i]) * 255);
    data[i * 4 + 2] = Math.round(Be[i] * 255); data[i * 4 + 3] = 255;
  }
  return data;
}
/** Bilinear, periodic sample of one channel (0..1) of an RGBA8 N x N map at (u, v) (any real numbers). */
export function sampleMap(data, N, u, v, ch = 0) {
  const x = (u - Math.floor(u)) * N - 0.5, y = (v - Math.floor(v)) * N - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const at = (xx, yy) => data[((((yy % N) + N) % N) * N + (((xx % N) + N) % N)) * 4 + ch] / 255;
  return lerp(lerp(at(x0, y0), at(x0 + 1, y0), fx), lerp(at(x0, y0 + 1), at(x0 + 1, y0 + 1), fx), fy);
}
