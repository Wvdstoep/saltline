// Shared helpers for the recorded world-tile fixtures (test/wt-ports.test.mjs, scripts/record-wt-fixtures.mjs --check):
// load a port's recorded z14 tiles (+ overlay + bathy), convert them with server/wtconvert.js and sample points.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { decodeMVT } from '../../../server/mvt.js';
import { convertTile, edt } from '../../../server/wtconvert.js';
import { hintsFor } from '../../../server/worldtiles.js';
import { WT_NAVIGABLE, WT_OBSTACLE, encodeTile, decodeTile, cellOf, tileFToLatLon, tileHeightAt, tileMaskAt } from '../../../shared/wtformat.js';

const gunzipMaybe = (b) => (b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b);
export const FIXTURE_DIR = path.dirname(new URL(import.meta.url).pathname);

/** { ports } from points.json and the pinned version. */
export function loadPoints(dir = FIXTURE_DIR) {
  const pts = JSON.parse(fs.readFileSync(path.join(dir, 'points.json'), 'utf8'));
  let pin = null; try { pin = JSON.parse(fs.readFileSync(path.join(dir, 'pin.json'), 'utf8')).ofm; } catch { /* none */ }
  return { ports: pts.ports, pin };
}

/**
 * Convert every recorded tile of a port. opts: { guard (bigports guard, default true), overlay (default true) }.
 * Returns { tiles: Map('x/y' → decoded tile), ms: [convert ms…] }.
 */
export function loadPortFixture(dir, port, opts = {}) {
  const pdir = path.join(dir, port.id), tiles = new Map(), ms = [];
  if (!fs.existsSync(pdir)) return { tiles, ms };
  const files = fs.readdirSync(pdir).sort();
  let pin = null; try { pin = JSON.parse(fs.readFileSync(path.join(dir, 'pin.json'), 'utf8')).ofm; } catch { /* none */ }
  const overlays = new Map(), bathys = new Map();
  for (const f of files) {
    let m = /^ov-12-(\d+)-(\d+)\.json(\.gz)?$/.exec(f);
    if (m && opts.overlay !== false) overlays.set(`${m[1]}/${m[2]}`, JSON.parse(gunzipMaybe(fs.readFileSync(path.join(pdir, f))).toString('utf8')));
    m = /^bathy-9-(\d+)-(\d+)\.bin(\.gz)?$/.exec(f);
    if (m) { const b = gunzipMaybe(fs.readFileSync(path.join(pdir, f))); bathys.set(`${m[1]}/${m[2]}`, { x9: +m[1], y9: +m[2], dm: new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) }); }
  }
  for (const f of files) {
    const m = /^14-(\d+)-(\d+)\.mvt(\.gz)?$/.exec(f);
    if (!m || (m[3] === undefined && files.includes(f + '.gz'))) continue;
    const x = +m[1], y = +m[2];
    const mvt = decodeMVT(fs.readFileSync(path.join(pdir, f)));
    const hints = hintsFor(14, x, y, { src: pin ? `ofm:${pin}` : 'ofm:fixture', builtAt: 0, guard: opts.guard !== false });
    const t0 = process.hrtime.bigint();
    const t = convertTile({ z: 14, x, y, mvt, overlay: overlays.get(`${x >> 2}/${y >> 2}`) || null, bathy: bathys.get(`${x >> 5}/${y >> 5}`) || null, hints });
    ms.push(Number(process.hrtime.bigint() - t0) / 1e6);
    tiles.set(`${x}/${y}`, decodeTile(encodeTile(t)));
  }
  return { tiles, ms };
}

/** { mask, h, key } at a point from the converted fixture tiles, or null when the point's tile was not recorded. */
export function samplePoint(fx, lat, lon) {
  const c = cellOf(14, lat, lon), t = fx.tiles.get(`${c.x}/${c.y}`);
  if (!t) return null;
  return { mask: tileMaskAt(t, c.u, c.v), h: tileHeightAt(t, c.u, c.v), key: `14/${c.x}/${c.y}`, u: c.u, v: c.v };
}

/** Even-odd point in a flat [x, z, …] ring. */
function inRing(r, x, y) { let c = false; for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) { const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; }

/**
 * Correct a sample point (§5.2: "a point that fails is corrected, never silently dropped") on the 3×3 mosaic of
 * converted tiles around it. kind 'water': the nearest navigable cell with depth ≥ need + 0.5 m at least 2 cells from
 * any obstacle; kind 'land': the nearest obstacle cell ≥ 150 m from water inside a port / industrial area.
 * Returns { lat, lon, movedM } (movedM 0 when the point already passes) or null when nothing qualifies within maxM.
 */
export function correctPoint(fx, kind, lat, lon, need = 0, maxM = 2000) {
  const c0 = cellOf(14, lat, lon), N = 256, R = 1, W = (2 * R + 1) * N;
  const mask = new Uint8Array(W * W).fill(255), hgt = new Float32Array(W * W);
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    const t = fx.tiles.get(`${c0.x + dx}/${c0.y + dy}`); if (!t) continue;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = ((dy + R) * N + j) * W + (dx + R) * N + i;
      mask[k] = tileMaskAt(t, i + 0.5, j + 0.5); hgt[k] = tileHeightAt(t, i + 0.5, j + 0.5);
    }
  }
  const nav = (m) => m !== 255 && WT_NAVIGABLE[m], obs = (m) => m !== 255 && WT_OBSTACLE[m];
  // distance (cells) from every cell to the other kind (unknown cells count as the other kind: conservative)
  const seed = new Uint8Array(W * W);
  for (let k = 0; k < seed.length; k++) seed[k] = kind === 'water' ? (nav(mask[k]) ? 0 : 1) : (obs(mask[k]) ? 0 : 1);
  const dist = edt(seed, W, W);
  const ci = R * N + Math.floor(c0.u), cj = R * N + Math.floor(c0.v);
  const tileOfCell = (i, j) => fx.tiles.get(`${c0.x + Math.floor(i / N) - R}/${c0.y + Math.floor(j / N) - R}`);
  const cellM = (fx.cellM && fx.cellM(lat)) || (40075016.686 * Math.cos((lat * Math.PI) / 180)) / 2 ** 14 / N;
  const ok = (i, j) => {
    const k = j * W + i;
    if (kind === 'water') return nav(mask[k]) && -hgt[k] >= need + 0.5 && dist[k] >= 2;
    if (!obs(mask[k]) || dist[k] * cellM < 150) return false;
    const t = tileOfCell(i, j); if (!t?.vectors?.areas) return false;
    const x = ((i % N) + 0.5) * cellM * 10, z = ((j % N) + 0.5) * cellM * 10;
    return t.vectors.areas.some((a) => (a.k === 'port' || a.k === 'industrial') && inRing(a.r, x, z));
  };
  const maxR = Math.ceil(maxM / cellM);
  for (let r = 0; r <= maxR; r++) {
    let best = null, bd = Infinity;
    for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
      const i = ci + di, j = cj + dj;
      if (i < 0 || j < 0 || i >= W || j >= W || !ok(i, j)) continue;
      const d = Math.hypot(di, dj); if (d < bd) { bd = d; best = [i, j]; }
    }
    if (best) {
      if (r === 0) return { lat, lon, movedM: 0 };
      const ll = tileFToLatLon(14, c0.x - R + (best[0] + 0.5) / N, c0.y - R + (best[1] + 0.5) / N);
      return { lat: Math.round(ll.lat * 1e5) / 1e5, lon: Math.round(ll.lon * 1e5) / 1e5, movedM: Math.round(bd * cellM) };
    }
  }
  return null;
}
