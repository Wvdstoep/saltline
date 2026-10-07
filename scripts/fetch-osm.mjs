#!/usr/bin/env node
// scripts/fetch-osm.mjs — pull OpenStreetMap building / industrial / pier footprints around every Saltline
// harbour from the Overpass API and cache them to data/osm-harbors.json (docs/ARCHITECTURE.md §1). The client
// extrudes the cached footprints as boxes around the pier; procedural warehouses are the fallback.
//
// Usage:
//   node scripts/fetch-osm.mjs [--harbors path.json] [--only id1,id2] [--limit N] [--resume]
//                              [--out data/osm-harbors.json] [--radius 1500] [--cap 250] [--delay 1500]
//                              [--retries 3] [--timeout 60000]
//
// Harbours come from server/harbors.js (named export HARBORS: [{id,name,lat,lon}]) or, when that file does not
// exist yet, from the JSON list given with --harbors (a bare array or {harbors:[...]}). --harbors wins if both.
//
// Output: {generatedAt, harbors:{[id]: [{id, kind:'building'|'industrial'|'pier', height, area, pts:[[lat,lon]..]}]}}
//   height = tags.height (m, ft supported) || building:levels * 3.2 || 8      (metres)
//   area   = footprint area in m² (used for ranking; each harbour keeps the 250 largest)
//   pts    = closed ring WITHOUT the repeated closing point, 6-decimal lat/lon. Linear piers (unclosed ways) are
//            buffered into one rectangle per segment (tags.width || 6 m) so jetties still get an extrusion.
//
// Overpass etiquette: one request at a time, 1.5 s between harbours, 3 attempts per harbour rotating over the
// mirrors with exponential backoff, 60 s timeout, and a failure never aborts the run (that harbour keeps its
// previous cache entry or gets []). The file is rewritten after every harbour, so a partial run is still useful.
//
// Node 20+, ESM, no dependencies beyond Node built-ins (global fetch).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GEO } from '../shared/constants.js';

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
];

export const DEFAULTS = {
  radius: 1500,          // metres around the harbour point
  cap: 250,              // largest footprints kept per harbour
  delayMs: 1500,         // pause between harbours (and base for retry backoff)
  retries: 3,            // attempts per harbour, rotating over OVERPASS_ENDPOINTS
  timeoutMs: 60_000,     // per-request abort timeout; also sent as the Overpass [timeout:] setting
  defaultHeight: 8,      // metres when neither height nor building:levels is usable
  metresPerLevel: 3.2,
  pierWidth: 6,          // metres, for linear piers
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HARBORS_MODULE = path.join(ROOT, 'server', 'harbors.js');
const DEFAULT_OUT = path.join(ROOT, 'data', 'osm-harbors.json');
const D2R = Math.PI / 180;
const USER_AGENT = 'Saltline/0.1 fetch-osm (prototype harbour extrusions; one request at a time)';

// ---------------------------------------------------------------------------------------------------------------
// Overpass QL
// ---------------------------------------------------------------------------------------------------------------

export function buildQuery(lat, lon, radius = DEFAULTS.radius, timeoutS = DEFAULTS.timeoutMs / 1000) {
  const at = `around:${radius},${Number(lat).toFixed(6)},${Number(lon).toFixed(6)}`;
  return [
    `[out:json][timeout:${Math.round(timeoutS)}];`,
    '(',
    `  way["building"](${at});`,
    `  way["landuse"~"industrial|port|harbour"](${at});`,
    `  way["man_made"="pier"](${at});`,
    ');',
    'out geom;',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Overpass JSON → footprints
// ---------------------------------------------------------------------------------------------------------------

// Which of the three kinds a tagged way is, or null when it matches none (the union query can return a way that
// only matched because of a tag we do not extrude, e.g. landuse=industrial;retail is fine, highway=* is not).
export function classify(tags = {}) {
  if (tags.building && tags.building !== 'no') return 'building';
  if (tags.man_made === 'pier') return 'pier';
  if (/industrial|port|harbour/.test(tags.landuse || '')) return 'industrial';
  return null;
}

// "12", "12.5 m", "12,5", "40 ft", "30'", "30'6\"" → metres (1 decimal); null when absent / unusable.
export function parseLength(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase().replace(',', '.');
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(m|metres?|meters?|ft|feet|')?\s*(?:(\d+(?:\.\d+)?)\s*(?:in|inch|inches|"))?\s*$/);
  if (!m) return null;
  let v = parseFloat(m[1]);
  if (m[2] === 'ft' || m[2] === 'feet' || m[2] === "'") v = (v + (m[3] ? parseFloat(m[3]) / 12 : 0)) * 0.3048;
  else if (m[3]) return null; // inches without feet is nonsense
  return Number.isFinite(v) && v > 0 ? round1(v) : null;
}

export function parseHeight(tags = {}) {
  const h = parseLength(tags.height);
  if (h) return h;
  const levels = parseFloat(String(tags['building:levels'] ?? '').replace(',', '.'));
  if (Number.isFinite(levels) && levels > 0) return round1(levels * DEFAULTS.metresPerLevel);
  return DEFAULTS.defaultHeight;
}

// Shoelace area in m² of a [[lat,lon],...] ring, in a local equirectangular plane about the first point.
export function polygonAreaM2(pts) {
  if (!Array.isArray(pts) || pts.length < 3) return 0;
  const [lat0, lon0] = pts[0];
  const k = Math.cos(lat0 * D2R) * GEO.M_PER_DEG_LON_EQ;
  let sum = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const [la1, lo1] = pts[i], [la2, lo2] = pts[(i + 1) % n];
    const x1 = (lo1 - lon0) * k, y1 = (la1 - lat0) * GEO.M_PER_DEG_LAT;
    const x2 = (lo2 - lon0) * k, y2 = (la2 - lat0) * GEO.M_PER_DEG_LAT;
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

// `out geom` gives way.geometry = [{lat,lon},...]. Returns {ring:[[lat,lon],...], closed} with consecutive
// duplicates and the repeated closing point removed.
function ringFromGeometry(geometry) {
  const raw = geometry.filter(p => p && Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (raw.length < 2) return { ring: [], closed: false };
  const closed = raw.length >= 4 && raw[0].lat === raw[raw.length - 1].lat && raw[0].lon === raw[raw.length - 1].lon;
  const ring = [];
  for (const p of closed ? raw.slice(0, -1) : raw) {
    const pt = [round6(p.lat), round6(p.lon)];
    const last = ring[ring.length - 1];
    if (!last || last[0] !== pt[0] || last[1] !== pt[1]) ring.push(pt);
  }
  return { ring, closed };
}

// Buffer an open polyline into one rectangle per segment (used for linear piers / jetties).
function lineToRects(line, widthM) {
  const o = line[0];
  const kx = Math.cos(o[0] * D2R) * GEO.M_PER_DEG_LON_EQ;
  const toM = ([la, lo]) => [(lo - o[1]) * kx, (la - o[0]) * GEO.M_PER_DEG_LAT];
  const toLL = ([x, y]) => [round6(o[0] + y / GEO.M_PER_DEG_LAT), round6(o[1] + x / kx)];
  const rects = [];
  for (let i = 1; i < line.length; i++) {
    const a = toM(line[i - 1]), b = toM(line[i]);
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
    if (len < 1) continue;
    const nx = (-dy / len) * widthM / 2, ny = (dx / len) * widthM / 2;
    rects.push([toLL([a[0] + nx, a[1] + ny]), toLL([b[0] + nx, b[1] + ny]), toLL([b[0] - nx, b[1] - ny]), toLL([a[0] - nx, a[1] - ny])]);
  }
  return rects;
}

/**
 * One Overpass element → 0..n footprints. Closed building/industrial/pier ways give one polygon; an unclosed
 * pier way gives one rectangle per segment; anything else (nodes, relations, untagged, degenerate) gives [].
 */
export function elementToFootprints(el) {
  if (!el || el.type !== 'way' || !Array.isArray(el.geometry)) return [];
  const kind = classify(el.tags);
  if (!kind) return [];
  const { ring, closed } = ringFromGeometry(el.geometry);
  const height = parseHeight(el.tags);
  const rings = closed ? [ring]
    : kind === 'pier' && ring.length >= 2 ? lineToRects(ring, parseLength(el.tags?.width) || DEFAULTS.pierWidth)
    : [];
  const out = [];
  for (const pts of rings) {
    if (pts.length < 3) continue;
    const area = polygonAreaM2(pts);
    if (!(area >= 1)) continue; // degenerate sliver
    out.push({ id: el.id, kind, height, area: Math.round(area), pts });
  }
  return out;
}

/** Whole Overpass response → { footprints (largest first, capped), total (before the cap) }. */
export function convertOverpass(json, { cap = DEFAULTS.cap } = {}) {
  const elements = Array.isArray(json?.elements) ? json.elements : [];
  const all = elements.flatMap(elementToFootprints).sort((a, b) => b.area - a.area);
  return { footprints: cap > 0 ? all.slice(0, cap) : all, total: all.length };
}

export function countKinds(footprints) {
  const c = { building: 0, industrial: 0, pier: 0 };
  for (const f of footprints) c[f.kind] = (c[f.kind] || 0) + 1;
  return c;
}

// ---------------------------------------------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------------------------------------------

async function fetchOverpass(endpoint, query, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT, Accept: 'application/json' },
      body: 'data=' + encodeURIComponent(query),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 429 ? ' (rate limited)' : ''}`);
    const json = await res.json();
    // Overpass reports query timeouts / memory limits as HTTP 200 with a remark and a truncated element list.
    if (json?.remark && /error|timed out|out of memory/i.test(json.remark)) throw new Error(`Overpass remark: ${json.remark}`);
    return json;
  } catch (err) {
    throw err?.name === 'AbortError' ? new Error(`timeout after ${timeoutMs} ms`) : err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run one query with up to `retries` attempts, rotating over the endpoints (primary first) and backing off
 * delayMs · 2^(attempt−1) between attempts. Resolves {json, endpoint, attempts} or throws the last error.
 */
export async function queryOverpass(query, opts = {}) {
  const { endpoints = OVERPASS_ENDPOINTS, retries = DEFAULTS.retries, timeoutMs = DEFAULTS.timeoutMs,
    delayMs = DEFAULTS.delayMs, log = () => {} } = opts;
  let lastErr = new Error('no attempts made');
  for (let attempt = 0; attempt < retries; attempt++) {
    const endpoint = endpoints[attempt % endpoints.length];
    if (attempt > 0) await sleep(delayMs * 2 ** (attempt - 1));
    try {
      const json = await fetchOverpass(endpoint, query, timeoutMs);
      return { json, endpoint, attempts: attempt + 1 };
    } catch (err) {
      lastErr = err;
      log(`    attempt ${attempt + 1}/${retries} via ${hostOf(endpoint)} failed: ${err.message}`);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------------------------------------------
// Harbour list, cache file, CLI
// ---------------------------------------------------------------------------------------------------------------

export async function loadHarbors({ harborsPath, modulePath = HARBORS_MODULE } = {}) {
  if (harborsPath) {
    const raw = JSON.parse(await fsp.readFile(path.resolve(harborsPath), 'utf8'));
    return validateHarbors(Array.isArray(raw) ? raw : raw?.harbors, harborsPath);
  }
  if (fs.existsSync(modulePath)) {
    const mod = await import(pathToFileURL(modulePath).href);
    return validateHarbors(mod.HARBORS, modulePath);
  }
  throw new Error(`${path.relative(ROOT, modulePath)} does not exist yet — pass --harbors path.json`);
}

function validateHarbors(list, source) {
  if (!Array.isArray(list)) throw new Error(`${source}: expected an array of {id,name,lat,lon}`);
  const seen = new Set();
  return list.map((h, i) => {
    const lat = Number(h?.lat), lon = Number(h?.lon);
    if (!h?.id || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      throw new Error(`${source}: harbour #${i} (${JSON.stringify(h)}) needs id, lat (−90…90) and lon (−180…180)`);
    }
    if (seen.has(h.id)) throw new Error(`${source}: duplicate harbour id "${h.id}"`);
    seen.add(h.id);
    return { id: String(h.id), name: h.name || String(h.id), lat, lon };
  });
}

async function loadExisting(outPath) {
  try {
    const parsed = JSON.parse(await fsp.readFile(outPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.harbors && typeof parsed.harbors === 'object') {
      return { generatedAt: parsed.generatedAt || null, harbors: parsed.harbors };
    }
  } catch { /* missing or corrupt → start fresh */ }
  return { generatedAt: null, harbors: {} };
}

async function writeJsonAtomic(outPath, data) {
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  const tmp = `${outPath}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data) + '\n');
  await fsp.rename(tmp, outPath);
}

export function parseArgs(argv) {
  const a = { only: null, limit: 0, resume: false, help: false, harbors: null, out: null,
    radius: DEFAULTS.radius, cap: DEFAULTS.cap, delay: DEFAULTS.delayMs, retries: DEFAULTS.retries, timeout: DEFAULTS.timeoutMs };
  const num = (k, v) => { const n = Number(v); if (!Number.isFinite(n)) throw new Error(`--${k} needs a number`); return n; };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const key = arg.startsWith('--') ? (eq > 0 ? arg.slice(2, eq) : arg.slice(2)) : null;
    const next = () => (eq > 0 ? arg.slice(eq + 1) : argv[++i]);
    switch (key) {
      case 'only': a.only = new Set(String(next() || '').split(',').map(s => s.trim()).filter(Boolean)); break;
      case 'limit': a.limit = num(key, next()); break;
      case 'harbors': a.harbors = next(); break;
      case 'out': a.out = next(); break;
      case 'radius': a.radius = num(key, next()); break;
      case 'cap': a.cap = num(key, next()); break;
      case 'delay': a.delay = num(key, next()); break;
      case 'retries': a.retries = num(key, next()); break;
      case 'timeout': a.timeout = num(key, next()); break;
      case 'resume': a.resume = true; break;
      case 'help': case 'h': a.help = true; break;
      default: throw new Error(`unknown argument "${arg}" (try --help)`);
    }
  }
  return a;
}

const USAGE = `fetch-osm — cache OpenStreetMap footprints around Saltline harbours
  --harbors path.json   harbour list when server/harbors.js does not exist (array or {harbors:[...]})
  --only id1,id2        only these harbour ids
  --limit N             stop after N harbours
  --resume              skip harbours that already have footprints in the output file
  --out path            output file (default data/osm-harbors.json)
  --radius m            search radius (default ${DEFAULTS.radius})
  --cap N               largest footprints kept per harbour (default ${DEFAULTS.cap})
  --delay ms            pause between harbours / retry backoff base (default ${DEFAULTS.delayMs})
  --retries N           attempts per harbour, rotating over mirrors (default ${DEFAULTS.retries})
  --timeout ms          per-request timeout (default ${DEFAULTS.timeoutMs})`;

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { console.log(USAGE); return 0; }

  let harbors = await loadHarbors({ harborsPath: args.harbors });
  if (args.only) {
    const missing = [...args.only].filter(id => !harbors.some(h => h.id === id));
    if (missing.length) console.warn(`warning: unknown harbour id(s): ${missing.join(', ')}`);
    harbors = harbors.filter(h => args.only.has(h.id));
  }
  if (args.limit > 0) harbors = harbors.slice(0, args.limit);
  if (!harbors.length) { console.error('nothing to do (no harbours selected)'); return 1; }

  const outPath = path.resolve(args.out || DEFAULT_OUT);
  const out = await loadExisting(outPath);
  console.log(`fetch-osm: ${harbors.length} harbour(s), radius ${args.radius} m, cap ${args.cap}, → ${path.relative(process.cwd(), outPath)}`);

  const idW = Math.max(8, ...harbors.map(h => h.id.length));
  const nameW = Math.min(22, Math.max(8, ...harbors.map(h => h.name.length)));
  let ok = 0, failed = 0, skipped = 0, requested = 0;

  for (let i = 0; i < harbors.length; i++) {
    const h = harbors[i];
    const prefix = `[${String(i + 1).padStart(String(harbors.length).length)}/${harbors.length}] ${h.id.padEnd(idW)} ${h.name.slice(0, nameW).padEnd(nameW)}`;
    if (args.resume && out.harbors[h.id]?.length) { skipped++; console.log(`${prefix} skipped (resume, ${out.harbors[h.id].length} cached)`); continue; }
    if (requested++ > 0) await sleep(args.delay);

    const t0 = Date.now();
    try {
      const { json, endpoint, attempts } = await queryOverpass(buildQuery(h.lat, h.lon, args.radius, args.timeout / 1000),
        { retries: args.retries, timeoutMs: args.timeout, delayMs: args.delay, log: m => console.log(m) });
      const { footprints, total } = convertOverpass(json, { cap: args.cap });
      const c = countKinds(footprints);
      out.harbors[h.id] = footprints;
      ok++;
      console.log(`${prefix} kept ${String(footprints.length).padStart(3)}/${String(total).padEnd(4)} bld ${c.building} ind ${c.industrial} pier ${c.pier}` +
        `  ${((Date.now() - t0) / 1000).toFixed(1)}s via ${hostOf(endpoint)}${attempts > 1 ? ` (attempt ${attempts})` : ''}`);
    } catch (err) {
      failed++;
      const kept = out.harbors[h.id]?.length || 0;
      if (!kept) out.harbors[h.id] = [];
      console.log(`${prefix} FAILED after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${err.message}` + (kept ? ` (kept ${kept} cached)` : ' → []'));
    }
    out.generatedAt = new Date().toISOString();
    await writeJsonAtomic(outPath, out);
  }

  const totalFp = Object.values(out.harbors).reduce((n, l) => n + (l?.length || 0), 0);
  console.log(`\n${ok} fetched, ${failed} failed, ${skipped} skipped — ${Object.keys(out.harbors).length} harbour(s), ${totalFp} footprints in ${path.relative(process.cwd(), outPath)}`);
  return ok === 0 && failed > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------------------------

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function round1(v) { return Math.round(v * 10) / 10; }
function round6(v) { return Math.round(v * 1e6) / 1e6; }
function hostOf(url) { try { return new URL(url).host; } catch { return url; } }

// Only run main() when executed directly (`node scripts/fetch-osm.mjs`), not when imported by the tests.
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().then(code => { process.exitCode = code; }, err => { console.error(`fetch-osm: ${err.message}`); process.exitCode = 1; });
}
