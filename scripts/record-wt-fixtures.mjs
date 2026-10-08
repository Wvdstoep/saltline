#!/usr/bin/env node
// Record the real-data world-tile fixtures of docs/WORLD-DETAIL-STREAMING.md §5.2 (run where the sources are
// reachable — production; the dev container cannot reach OpenFreeMap).
//
//   node scripts/record-wt-fixtures.mjs [--out test/fixtures/wt] [--port id[,id…]] [--no-base] [--overlay] [--bathy]
//                                       [--extra 2] [--ring 1] [--tiles x-y,…] [--check] [--slim <dir> [--buildings id,…]]
//
// Writes, per port, <out>/<port>/14-<x>-<y>.mvt.gz (the OpenFreeMap z14 tile under each sample point, gzip'd raw MVT),
// with --overlay <out>/<port>/ov-12-<x>-<y>.json.gz (compact Overpass overlay), with --bathy <out>/<port>/bathy-9-<x>-
// <y>.bin.gz (Terrarium z9, Int16 decimetres), plus <out>/points.json (the sample points) and <out>/pin.json (the
// pinned OpenFreeMap version). Requests are sequential (one in flight), so a full run is ≈ 40 tiles + 13 overlays.
// --check converts every recorded tile (server/wtconvert.js) and prints each point's mask / depth for a human to
// confirm against the OSM map before committing; a failing point is moved, never silently dropped.
// --slim <dir> re-encodes every recorded tile with only what server/wtconvert.js reads (water, river / canal waterways,
// land use, sand, piers and bridges; buildings only for the --buildings ports) into <dir> — still a valid MVT, about a
// quarter of the size, so the committed fixtures stay far under the 4 MB budget.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tileF, WT_NAVIGABLE, WT_OBSTACLE } from '../shared/wtformat.js';
import { createSources } from '../server/wtsource.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Sample points (§5.2). water: [lat, lon, min depth at MLW]; land: [lat, lon] terminal yards (obstacle cells).
 * The design's coordinates were approximate; the first recording (OpenFreeMap 20261004_113936_pt, 2026-10-08) moved
 * every failing point with test/fixtures/wt/lib.mjs correctPoint (water: nearest navigable cell with the depth, ≥ 2
 * cells off any obstacle; land: nearest port / industrial cell ≥ 150 m from water), all ≤ 1.3 km. `orig` keeps the
 * design's coordinates; test/wt-ports.test.mjs checks that no point drifts more than 1.5 km from them.
 */
export const WT_PORTS = [
  { id: 'rotterdam', cont: 'EU', water: [[51.90745,4.17485,14],[51.96868,4.03657,14]], land: [[51.95667,4.04653]],
    orig: {"water":[[51.905,4.17],[51.968,4.035]],"land":[[51.958,4.045]]} },
  { id: 'antwerp', cont: 'EU', water: [[51.28653,4.2575,13],[51.31,4.27,12]], land: [[51.28353,4.24626]],
    orig: {"water":[[51.285,4.26],[51.31,4.27]],"land":[[51.283,4.247]]} },
  { id: 'hamburg', cont: 'EU', water: [[53.54355,9.90791,12]], land: [[53.531,9.925]],
    orig: {"water":[[53.545,9.91]],"land":[[53.531,9.925]]} },
  { id: 'singapore', cont: 'AS', water: [[1.2,103.85,15]], land: [[1.27624,103.77381]],
    orig: {"water":[[1.2,103.85]],"land":[[1.275,103.775]]} },
  { id: 'yangshan', cont: 'AS', water: [[30.61727,122.0669,12]], land: [[30.63603,122.04476]],
    orig: {"water":[[30.62,122.07]],"land":[[30.632,122.04]]} },
  { id: 'santos', cont: 'SA', water: [[-23.97492,-46.29325,11]], land: [[-23.92017,-46.31299]],
    orig: {"water":[[-23.98,-46.3]],"land":[[-23.925,-46.305]]} },
  { id: 'new_york', cont: 'NA', water: [[40.5,-73.97,13],[40.64577,-74.09939,12]], land: [[40.682,-74.155]],
    orig: {"water":[[40.5,-73.97],[40.645,-74.1]],"land":[[40.682,-74.155]]} },
  { id: 'houston', cont: 'NA', water: [[29.68205,-94.98775,11]], land: [[29.67944,-95.00097]],
    orig: {"water":[[29.68,-94.99]],"land":[[29.683,-95.005]]} },
  { id: 'durban', cont: 'AF', water: [[-29.86815,31.05213,12]], land: [[-29.87983,31.02149]],
    orig: {"water":[[-29.87,31.05]],"land":[[-29.875,31.02]]} },
  { id: 'port_said', cont: 'AF', water: [[30.59156,32.33118,12]], land: [],
    orig: {"water":[[30.58,32.33]],"land":[]} },
  { id: 'sydney', cont: 'OC', water: [[-33.99998,151.20016,12]], land: [[-33.96639,151.21612]],
    orig: {"water":[[-34,151.2]],"land":[[-33.968,151.218]]} },
  { id: 'callao', cont: 'SA', water: [[-12.045,-77.155,10]], land: [[-12.05204,-77.14295]],
    orig: {"water":[[-12.045,-77.155]],"land":[[-12.052,-77.143]]} },
  { id: 'gothenburg', cont: 'EU', water: [[57.69,11.84,10]], land: [[57.69633,11.80992]],
    orig: {"water":[[57.69,11.84]],"land":[[57.688,11.8]]} },
];

function tileOf(z, lat, lon) { const { fx, fy } = tileF(z, lat, lon); return { x: Math.floor(fx), y: Math.floor(fy) }; }
/** Tiles to record for a port: the z14 tile under every sample point and its `ring` neighbours (+ `extra` east
 *  neighbours of the first water point, for the seam test). */
export function portTiles(p, extra = 0, ring = 0) {
  const keys = new Map();
  for (const [lat, lon] of [...p.water, ...p.land]) {
    const t = tileOf(14, lat, lon);
    for (let dy = -ring; dy <= ring; dy++) for (let dx = -ring; dx <= ring; dx++) keys.set(`${t.x + dx}-${t.y + dy}`, { x: t.x + dx, y: t.y + dy });
  }
  const f = p.water[0] ? tileOf(14, p.water[0][0], p.water[0][1]) : null;
  for (let k = 1; f && k <= extra; k++) keys.set(`${f.x + k}-${f.y}`, { x: f.x + k, y: f.y });
  return [...keys.values()];
}

const pick = (t, keys) => { const o = {}; for (const k of keys) if (t[k] !== undefined) o[k] = t[k]; return o; };
/** Keep only the layers / features / tags the converter reads (see --slim). */
export function slimMVT(mvt, buildings) {
  const L = mvt.layers || {}, out = { layers: {} };
  const put = (name, keep, keys) => {
    const l = L[name]; if (!l) return;
    const features = l.features.filter(keep).map((f) => ({ type: f.type, tags: pick(f.tags, keys), geom: f.geom }));
    if (features.length) out.layers[name] = { extent: l.extent, features };
  };
  put('water', () => true, ['class', 'intermittent', 'brunnel']);
  put('waterway', (f) => f.tags.class === 'river' || f.tags.class === 'canal', ['class', 'brunnel', 'intermittent']);
  put('landuse', (f) => ['industrial', 'commercial', 'retail', 'residential', 'railway', 'military'].includes(f.tags.class), ['class']);
  put('landcover', (f) => f.tags.class === 'sand', ['class', 'subclass']);
  put('transportation', (f) => f.tags.class === 'pier' || f.tags.brunnel === 'bridge', ['class', 'brunnel', 'subclass']);
  if (buildings) put('building', () => true, ['render_height', 'render_min_height']);
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name, d) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
  const has = (name) => argv.includes(name);
  const out = path.resolve(opt('--out', path.join(__dirname, '..', 'test', 'fixtures', 'wt')));
  const only = opt('--port', null) ? new Set(opt('--port').split(',')) : null;
  const extra = Number(opt('--extra', 0)) || 0;
  const ports = WT_PORTS.filter((p) => !only || only.has(p.id));
  const src = createSources({ offline: false, dataDir: path.join(out, '.data'), log: (...a) => console.log('[src]', ...a) });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'points.json'), JSON.stringify({ ports: WT_PORTS }, null, 1));
  let bytes = 0;
  if (!has('--no-base')) {
    const ver = await src.ensurePin();
    console.log('OpenFreeMap pin', ver);
    if (!ver) { console.error('cannot read the OpenFreeMap TileJSON'); process.exitCode = 1; return; }
    fs.writeFileSync(path.join(out, 'pin.json'), JSON.stringify({ ofm: ver, recordedAt: new Date().toISOString() }));
    for (const p of ports) {
      fs.mkdirSync(path.join(out, p.id), { recursive: true });
      const list = portTiles(p, p.id === 'rotterdam' ? Math.max(1, extra) : extra, Number(opt('--ring', 0)) || 0);
      for (const k of String(opt('--tiles', '')).split(',').filter(Boolean)) { const [x, y] = k.split('-').map(Number); if (Number.isInteger(x) && Number.isInteger(y)) list.push({ x, y }); }   // e.g. under moored vessels
      for (const t of list) {
        const file = path.join(out, p.id, `14-${t.x}-${t.y}.mvt.gz`);
        if (fs.existsSync(file)) { bytes += fs.statSync(file).size; continue; }
        const t0 = Date.now(), r = await src.fetchBase(14, t.x, t.y);
        if (!r.ok) { console.log(p.id, `14/${t.x}/${t.y}`, 'FAILED', r.reason); continue; }
        const gz = zlib.gzipSync(r.buf[0] === 0x1f && r.buf[1] === 0x8b ? zlib.gunzipSync(r.buf) : r.buf, { level: 9 });
        fs.writeFileSync(file, gz); bytes += gz.length;
        console.log(p.id, `14/${t.x}/${t.y}`, r.buf.length, 'B', Date.now() - t0, 'ms');
      }
    }
  }
  if (has('--overlay')) {
    for (const p of ports) {
      const sq = new Map();
      for (const [lat, lon] of [...p.water, ...p.land]) { const t = tileOf(12, lat, lon); sq.set(`${t.x}-${t.y}`, t); }
      for (const t of sq.values()) {
        const file = path.join(out, p.id, `ov-12-${t.x}-${t.y}.json.gz`);
        if (fs.existsSync(file)) continue;
        const t0 = Date.now(), r = await src.fetchOverlay(t.x, t.y);
        if (!r.ok) { console.log(p.id, `ov 12/${t.x}/${t.y}`, 'FAILED', r.reason); continue; }
        fs.mkdirSync(path.join(out, p.id), { recursive: true });
        const gz = zlib.gzipSync(JSON.stringify(r.overlay), { level: 9 });
        fs.writeFileSync(file, gz); bytes += gz.length;
        console.log(p.id, `ov 12/${t.x}/${t.y}`, r.overlay.f.length, 'features', gz.length, 'B gz', Date.now() - t0, 'ms');
      }
    }
  }
  if (has('--bathy')) {
    for (const p of ports) {
      const sq = new Map();
      for (const [lat, lon] of [...p.water, ...p.land]) { const t = tileOf(9, lat, lon); sq.set(`${t.x}-${t.y}`, t); }
      for (const t of sq.values()) {
        const file = path.join(out, p.id, `bathy-9-${t.x}-${t.y}.bin.gz`);
        if (fs.existsSync(file)) continue;
        const r = await src.fetchBathy(t.x, t.y);
        if (!r.ok) { console.log(p.id, `bathy 9/${t.x}/${t.y}`, 'FAILED', r.reason); continue; }
        fs.mkdirSync(path.join(out, p.id), { recursive: true });
        // keep only the 8×8-pixel footprint (+ 2 px) of the port's recorded z14 tiles: the rest compresses away
        const keep = new Uint8Array(256 * 256);
        for (const f of fs.existsSync(path.join(out, p.id)) ? fs.readdirSync(path.join(out, p.id)) : []) {
          const m = /^14-(\d+)-(\d+)\.mvt\.gz$/.exec(f); if (!m) continue;
          const px = (Number(m[1]) - t.x * 32) * 8, py = (Number(m[2]) - t.y * 32) * 8;
          for (let j = py - 2; j < py + 10; j++) for (let i = px - 2; i < px + 10; i++) if (i >= 0 && j >= 0 && i < 256 && j < 256) keep[j * 256 + i] = 1;
        }
        for (let i = 0; i < keep.length; i++) if (!keep[i]) r.dm[i] = 0;
        const gz = zlib.gzipSync(Buffer.from(r.dm.buffer), { level: 9 });
        fs.writeFileSync(file, gz); bytes += gz.length;
        console.log(p.id, `bathy 9/${t.x}/${t.y}`, gz.length, 'B gz');
      }
    }
  }
  console.log('fixture bytes', bytes);
  if (opt('--slim', null)) {
    const { decodeMVT } = await import('../server/mvt.js');
    const { encodeMVT } = await import('../test/fixtures/wt/mvtenc.mjs');
    const dst = path.resolve(opt('--slim')), withBuildings = new Set(String(opt('--buildings', 'rotterdam')).split(','));
    let total = 0;
    for (const p of ports) {
      const dir = path.join(out, p.id); if (!fs.existsSync(dir)) continue;
      fs.mkdirSync(path.join(dst, p.id), { recursive: true });
      for (const f of fs.readdirSync(dir).sort()) {
        const src = path.join(dir, f), to = path.join(dst, p.id, f);
        if (!f.endsWith('.mvt.gz')) { fs.copyFileSync(src, to); total += fs.statSync(to).size; continue; }
        const gz = zlib.gzipSync(encodeMVT(slimMVT(decodeMVT(fs.readFileSync(src)), withBuildings.has(p.id))), { level: 9 });
        fs.writeFileSync(to, gz); total += gz.length;
        console.log('slim', p.id, f, fs.statSync(src).size, '→', gz.length);
      }
    }
    for (const f of ['points.json', 'pin.json']) if (fs.existsSync(path.join(out, f))) fs.copyFileSync(path.join(out, f), path.join(dst, f));
    console.log('slim bytes', total);
  }
  if (has('--check')) {
    const lib = await import('../test/fixtures/wt/lib.mjs').catch(() => null);
    if (!lib) { console.log('--check needs test/fixtures/wt/lib.mjs and server/wtconvert.js'); return; }
    for (const p of ports) {
      const fx = lib.loadPortFixture(out, p);
      for (const [lat, lon, min] of p.water) {
        const s = lib.samplePoint(fx, lat, lon), pass = s && WT_NAVIGABLE[s.mask] && -s.h >= min, fix = pass ? null : lib.correctPoint(fx, 'water', lat, lon, min);
        console.log(p.id, 'water', lat, lon, s ? `mask ${s.mask} depth ${(-s.h).toFixed(1)} (need ≥ ${min})` : 'no tile', pass ? 'OK' : `FAIL → ${fix ? `${fix.lat}, ${fix.lon} (${fix.movedM} m)` : 'nothing within 2 km'}`);
      }
      for (const [lat, lon] of p.land) {
        const s = lib.samplePoint(fx, lat, lon), pass = s && WT_OBSTACLE[s.mask], fix = pass ? null : lib.correctPoint(fx, 'land', lat, lon);
        console.log(p.id, 'land ', lat, lon, s ? `mask ${s.mask} h ${s.h.toFixed(1)}` : 'no tile', pass ? 'OK' : `FAIL → ${fix ? `${fix.lat}, ${fix.lon} (${fix.movedM} m)` : 'nothing within 2 km'}`);
      }
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch((e) => { console.error(e); process.exitCode = 1; });
