#!/usr/bin/env node
// Record the moored-AIS fixture of docs/WORLD-DETAIL-STREAMING.md §5.2 from a running Saltline server's live AIS store:
// every vessel moored (nav status 5), stopped (SOG < 0.3 kn) and with known dimensions within 5 km of each fixture
// port → test/fixtures/wt/moored.json as { port, mmsi (hashed), lat, lon, hdg, A, B, C, D } — positions only, no names,
// no keys. Then prints the z14 tiles under those vessels so the tile fixtures can be extended to cover them:
//
//   node scripts/record-moored-fixture.mjs [--base http://localhost:3000] [--out test/fixtures/wt/moored.json] [--km 5]
//   node scripts/record-wt-fixtures.mjs --port <id> --tiles x-y,…   (see the printed hint)
//
// One GET /api/ais?bbox=… per port, sequential.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WT_PORTS } from './record-wt-fixtures.mjs';
import { fnv1a, tileF } from '../shared/wtformat.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, d) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const base = opt('--base', process.env.SALTLINE_URL || 'http://localhost:3000').replace(/\/$/, '');
const out = path.resolve(opt('--out', path.join(__dirname, '..', 'test', 'fixtures', 'wt', 'moored.json')));
const km = Number(opt('--km', 5)) || 5;
const hash = (mmsi) => fnv1a(new TextEncoder().encode(`saltline-moored:${mmsi}`)).toString(16).padStart(8, '0');

/** AisPublic → the fixture record, or null when it is not a moored vessel with dimensions. */
export function mooredRecord(port, v) {
  if (!v || v.navStatus !== 5 || !(v.sog < 0.3) || !(v.length > 0) || !Array.isArray(v.off) || !Number.isFinite(v.lat) || !Number.isFinite(v.lon)) return null;
  const L = v.length, Bm = v.beam > 0 ? v.beam : Math.max(4, L / 7), [o0, o1] = v.off;   // off = [(A − B) / 2, (D − C) / 2]
  const r1 = (x) => Math.round(x * 10) / 10;
  return { port, mmsi: hash(v.mmsi), lat: Math.round(v.lat * 1e6) / 1e6, lon: Math.round(v.lon * 1e6) / 1e6, hdg: Number.isFinite(v.hdg) ? r1(v.hdg) : null,
    A: r1(L / 2 + o0), B: r1(L / 2 - o0), C: r1(Bm / 2 - o1), D: r1(Bm / 2 + o1) };
}

async function main() {
  const vessels = [], tiles = new Map();
  for (const p of WT_PORTS) {
    const [lat, lon] = p.water[0];
    const dLat = km / 111.32, dLon = km / (111.32 * Math.cos((lat * Math.PI) / 180));
    const url = `${base}/api/ais?bbox=${(lat - dLat).toFixed(5)},${(lon - dLon).toFixed(5)},${(lat + dLat).toFixed(5)},${(lon + dLon).toFixed(5)}&limit=2000`;
    let ships = [];
    try { const r = await fetch(url, { signal: AbortSignal.timeout(15000) }); if (r.ok) ships = (await r.json()).ships || []; else console.log(p.id, 'HTTP', r.status); } catch (e) { console.log(p.id, 'unreachable:', e.message); continue; }
    const recs = ships.map((v) => mooredRecord(p.id, v)).filter(Boolean);
    vessels.push(...recs);
    const set = tiles.get(p.id) || new Set(); tiles.set(p.id, set);
    for (const r of recs) { const { fx, fy } = tileF(14, r.lat, r.lon); set.add(`${Math.floor(fx)}-${Math.floor(fy)}`); }
    console.log(p.id.padEnd(10), String(ships.length).padStart(5), 'vessels,', String(recs.length).padStart(4), 'moored with dimensions,', set.size, 'tiles');
  }
  if (!vessels.length) { console.log('nothing recorded (is the server reachable and its AIS store warm?)'); process.exitCode = 1; return; }
  vessels.sort((a, b) => (a.port < b.port ? -1 : a.port > b.port ? 1 : a.mmsi < b.mmsi ? -1 : 1));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ recordedAt: new Date().toISOString(), km, vessels }, null, 0) + '\n');
  console.log('wrote', vessels.length, 'vessels to', out);
  for (const [id, set] of tiles) if (set.size) console.log(`  node scripts/record-wt-fixtures.mjs --port ${id} --tiles ${[...set].sort().join(',')}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch((e) => { console.error(e); process.exitCode = 1; });
