#!/usr/bin/env node
// scripts/fetch-osm.mjs — build the harbour geometry caches (docs/V3-CONTRACTS.md §1): one Overpass request per
// harbour → data/osm/<id>.json, then the rasterised patch + geometry JSON → data/geom/<id>.{json,bin}. Harbours
// whose OSM data is unreachable or unusable get the deterministic synthetic harbour instead (and are upgraded to
// the OSM build by a later run once the data is there). A thin CLI over server/harborgeom.js prefetchAll().
//
// Usage:
//   node scripts/fetch-osm.mjs [--only id1,id2] [--delay ms] [--force] [--synthetic-only] [--timeout ms]
//                              [--radius m] [--data dir] [--quiet]
//
//   --only id1,id2     only these harbour ids (comma separated)
//   --delay ms         pause between Overpass requests (default 1500; Overpass etiquette: one request at a time)
//   --force            re-fetch OSM even when the 30-day cache is fresh and rebuild every patch
//   --synthetic-only   no network at all: build the procedural harbours only (keeps existing builds unless --force)
//   --timeout ms       per-request timeout (default 45000)
//   --radius m         Overpass search radius around the harbour point (default 3200)
//   --data dir         where data/osm and data/geom go (default: data/ next to server.js, or $SALTLINE_DATA);
//                      the world sources (Natural Earth GeoJSON) are always read from the normal data directory
//
// Node 20+, ESM, no dependencies beyond Node built-ins (global fetch). Exit code 1 when nothing could be built.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULTS = { delay: 1500, timeout: 45_000, radius: 3200 };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseArgs(argv) {
  const a = { only: null, delay: DEFAULTS.delay, force: false, syntheticOnly: false, timeout: DEFAULTS.timeout, radius: DEFAULTS.radius, data: null, quiet: false, help: false };
  const num = (k, v) => { const n = Number(v); if (!Number.isFinite(n)) throw new Error(`--${k} needs a number`); return n; };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const key = arg.startsWith('--') ? (eq > 0 ? arg.slice(2, eq) : arg.slice(2)) : null;
    const next = () => (eq > 0 ? arg.slice(eq + 1) : argv[++i]);
    switch (key) {
      case 'only': a.only = new Set(String(next() || '').split(',').map((s) => s.trim()).filter(Boolean)); break;
      case 'delay': a.delay = num(key, next()); break;
      case 'timeout': a.timeout = num(key, next()); break;
      case 'radius': a.radius = num(key, next()); break;
      case 'data': a.data = next(); break;
      case 'force': a.force = true; break;
      case 'synthetic-only': a.syntheticOnly = true; break;
      case 'quiet': a.quiet = true; break;
      case 'help': case 'h': a.help = true; break;
      default: throw new Error(`unknown argument "${arg}" (try --help)`);
    }
  }
  return a;
}

const USAGE = `fetch-osm — build Saltline harbour geometry (OSM + synthetic) into data/osm and data/geom
  --only id1,id2     only these harbour ids
  --delay ms         pause between Overpass requests (default ${DEFAULTS.delay})
  --force            re-fetch OSM and rebuild even when cached
  --synthetic-only   no network: procedural harbours only
  --timeout ms       per-request timeout (default ${DEFAULTS.timeout})
  --radius m         Overpass search radius (default ${DEFAULTS.radius})
  --data dir         where data/osm and data/geom are written (default data/ or $SALTLINE_DATA)`;

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { console.log(USAGE); return 0; }
  const log = args.quiet ? () => {} : (...m) => console.log(...m);

  // The world is needed for the synthetic coast (and for the OSM fairway / no-coastline fallback); same loading as server.js.
  const { World } = await import(pathToFileURL(path.join(ROOT, 'server', 'world.js')).href);
  const { carvingsForWorld, HARBORS } = await import(pathToFileURL(path.join(ROOT, 'server', 'harbors.js')).href);
  const harborgeom = await import(pathToFileURL(path.join(ROOT, 'server', 'harborgeom.js')).href);

  const t0 = Date.now();
  const world = new World().load(carvingsForWorld(), log);
  log(`[fetch-osm] world ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  harborgeom.configure({ offline: args.syntheticOnly, timeoutMs: args.timeout, radiusM: args.radius, log, preload: false, ...(args.data ? { dataDir: path.resolve(args.data) } : {}) });
  harborgeom.init(world);

  let only = null;
  if (args.only) {
    const missing = [...args.only].filter((id) => !HARBORS.some((h) => h.id === id));
    if (missing.length) console.warn(`warning: unknown harbour id(s): ${missing.join(', ')}`);
    only = [...args.only].filter((id) => HARBORS.some((h) => h.id === id));
    if (!only.length) { console.error('nothing to do (no harbours selected)'); return 1; }
  }
  log(`[fetch-osm] ${only ? only.length : HARBORS.length} harbour(s), ${args.syntheticOnly ? 'synthetic only' : `Overpass radius ${args.radius} m, delay ${args.delay} ms`}${args.force ? ', force' : ''}`);
  const stats = await harborgeom.prefetchAll({ delayMs: args.delay, only, force: args.force, syntheticOnly: args.syntheticOnly, timeoutMs: args.timeout, log });
  log(`[fetch-osm] done in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${stats.built} built (${stats.osm} osm, ${stats.synthetic} synthetic), ${stats.skipped} skipped, ${stats.failed} failed`);
  return stats.built === 0 && stats.skipped === 0 && stats.failed > 0 ? 1 : 0;
}

// Only run main() when executed directly (`node scripts/fetch-osm.mjs`), not when imported by the tests.
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().then((code) => { process.exitCode = code; }, (err) => { console.error(`fetch-osm: ${err.message}`); process.exitCode = 1; });
}
