#!/usr/bin/env node
// Fetch the real navigable water of the big multi-basin ports from OpenStreetMap (Overpass) and write one compact
// JSON per port to server/bigports/<id>.json (shipped with the code; read by server/bigports.js).
//
//   node scripts/fetch-port-water.mjs [outDir] [portId ...]
//
// Per port bbox: natural=coastline ways, natural=water / waterway=riverbank|dock areas (ways AND multipolygon
// relations, with their inner rings), waterway=river|canal|fairway centrelines (+ width), man_made=quay|pier|jetty
// lines. Rings are clipped to the bbox, simplified (Douglas–Peucker, metres) and rounded to 1e-5° (~1 m).
// Run where Overpass is reachable (the production sandbox); the dev container has no internet.
import fs from 'node:fs';
import path from 'node:path';

export const PORTS = [
  { id: 'antwerp', harbor: 'antwerp', name: 'Antwerp + Westerschelde', bbox: [51.20, 3.50, 51.47, 4.45] },
  { id: 'rotterdam', harbor: 'rotterdam', name: 'Rotterdam', bbox: [51.84, 3.95, 52.01, 4.55] },
  { id: 'hamburg', harbor: 'hamburg', name: 'Hamburg + Elbe', bbox: [53.45, 8.55, 53.92, 10.08] },
  { id: 'amsterdam', harbor: 'ijmuiden', name: 'IJmuiden / Noordzeekanaal / Amsterdam', bbox: [52.36, 4.50, 52.50, 4.97] },
  { id: 'bremerhaven', harbor: 'bremerhaven', name: 'Bremerhaven + Weser', bbox: [53.48, 8.40, 53.66, 8.62] },
  { id: 'le_havre', harbor: 'le_havre', name: 'Le Havre', bbox: [49.40, -0.02, 49.53, 0.35] },
  { id: 'zeebrugge', harbor: 'zeebrugge', name: 'Zeebrugge', bbox: [51.30, 3.12, 51.38, 3.26] },
  { id: 'gothenburg', harbor: 'gothenburg', name: 'Gothenburg', bbox: [57.62, 11.65, 57.74, 11.98] },
  { id: 'felixstowe', harbor: 'felixstowe', name: 'Felixstowe / Harwich', bbox: [51.90, 1.20, 52.00, 1.36] },
];
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const WATER_KEEP = new Set(['river', 'dock', 'harbour', 'basin', 'canal', 'lock', 'lagoon', 'fairway', 'oxbow', 'tidal']);
const DROP = new Set(['reservoir', 'wastewater', 'pond', 'moat', 'reflecting_pool', 'fountain', 'swimming_pool', 'stream', 'ditch', 'drain', 'fishpond']);
const M_LAT = 111320, D2R = Math.PI / 180;

function query([s, w, n, e]) {
  const b = `${s},${w},${n},${e}`;
  return `[out:json][timeout:170][maxsize:536870912];
(
  way["natural"="coastline"](${b});
  way["natural"="water"](${b});
  relation["natural"="water"](${b});
  way["waterway"~"^(riverbank|dock)$"](${b});
  relation["waterway"~"^(riverbank|dock)$"](${b});
  way["waterway"~"^(river|canal|fairway)$"](${b});
  way["man_made"~"^(quay|pier|jetty)$"](${b});
);
out geom;`;
}

async function overpass(q) {
  let last;
  for (const ep of ENDPOINTS) {
    try {
      const r = await fetch(ep, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Saltline/0.7 (port water carving)' }, body: 'data=' + encodeURIComponent(q), signal: AbortSignal.timeout(180000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (!Array.isArray(j.elements)) throw new Error('no elements');
      if (j.remark && /error|timed out|memory/i.test(j.remark)) throw new Error(j.remark);
      return j;
    } catch (e) { last = e; console.error(`  ${ep}: ${e.message}`); }
  }
  throw last;
}

const pts = (g) => (Array.isArray(g) ? g.filter((p) => p && Number.isFinite(p.lat)).map((p) => [p.lat, p.lon]) : []);
const same = (a, b) => a[0] === b[0] && a[1] === b[1];
function joinWays(ways) {
  const open = ways.filter((w) => w.length >= 2).map((w) => w.slice());
  const out = [];
  while (open.length) {
    let cur = open.pop();
    let grew = true;
    while (grew && !same(cur[0], cur[cur.length - 1])) {
      grew = false;
      for (let i = 0; i < open.length; i++) {
        const w = open[i];
        if (same(cur[cur.length - 1], w[0])) cur = cur.concat(w.slice(1));
        else if (same(cur[cur.length - 1], w[w.length - 1])) cur = cur.concat(w.slice(0, -1).reverse());
        else if (same(cur[0], w[w.length - 1])) cur = w.slice(0, -1).concat(cur);
        else if (same(cur[0], w[0])) cur = w.slice(1).reverse().concat(cur);
        else continue;
        open.splice(i, 1); grew = true; break;
      }
    }
    cur.closed = cur.length >= 4 && same(cur[0], cur[cur.length - 1]);
    out.push(cur);
  }
  return out;
}
function rdp(p, tolM, k) {
  if (p.length < 3) return p;
  const keep = new Uint8Array(p.length); keep[0] = keep[p.length - 1] = 1;
  const st = [[0, p.length - 1]];
  while (st.length) {
    const [a, b] = st.pop();
    const ax = p[a][1] * k, ay = p[a][0] * M_LAT, bx = p[b][1] * k, by = p[b][0] * M_LAT;
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-9;
    let md = -1, mi = -1;
    for (let i = a + 1; i < b; i++) { const d = Math.abs((p[i][1] * k - ax) * dy - (p[i][0] * M_LAT - ay) * dx) / L; if (d > md) { md = d; mi = i; } }
    if (md > tolM) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
  }
  return p.filter((_, i) => keep[i]);
}
// Douglas–Peucker for a closed ring (split at the vertex farthest from the first one, so the ends never coincide).
function ringRdp(r, tolM, k) {
  if (r.length < 4) return r.slice();
  let m = 1, md = -1;
  for (let i = 1; i < r.length; i++) { const d = ((r[i][1] - r[0][1]) * k) ** 2 + ((r[i][0] - r[0][0]) * M_LAT) ** 2; if (d > md) { md = d; m = i; } }
  const a = rdp(r.slice(0, m + 1), tolM, k), b = rdp(r.slice(m).concat([r[0]]), tolM, k);
  return a.slice(0, -1).concat(b.slice(0, -1));
}
// Sutherland–Hodgman clip of a closed ring against the box.
function clipRing(ring, [s, w, n, e]) {
  let out = ring;
  const edges = [
    [(p) => p[0] >= s, (a, b) => { const t = (s - a[0]) / (b[0] - a[0]); return [s, a[1] + t * (b[1] - a[1])]; }],
    [(p) => p[0] <= n, (a, b) => { const t = (n - a[0]) / (b[0] - a[0]); return [n, a[1] + t * (b[1] - a[1])]; }],
    [(p) => p[1] >= w, (a, b) => { const t = (w - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), w]; }],
    [(p) => p[1] <= e, (a, b) => { const t = (e - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), e]; }],
  ];
  for (const [inside, cut] of edges) {
    const src = out; out = [];
    if (!src.length) break;
    for (let i = 0; i < src.length; i++) {
      const a = src[i], b = src[(i + 1) % src.length];
      const ia = inside(a), ib = inside(b);
      if (ia) out.push(a);
      if (ia !== ib) out.push(cut(a, b));
    }
  }
  return out;
}
// Keep the runs of a polyline that lie inside the box (vertices only; a box margin makes this good enough).
function clipLine(line, [s, w, n, e]) {
  const runs = []; let cur = [];
  const inB = (p) => p[0] >= s && p[0] <= n && p[1] >= w && p[1] <= e;
  for (let i = 0; i < line.length; i++) {
    const p = line[i];
    if (inB(p)) { if (!cur.length && i > 0) cur.push(line[i - 1]); cur.push(p); }
    else if (cur.length) { cur.push(p); runs.push(cur); cur = []; }
  }
  if (cur.length) runs.push(cur);
  return runs.filter((r) => r.length >= 2);
}
function lenM(p, k) { let s = 0; for (let i = 1; i < p.length; i++) s += Math.hypot((p[i][1] - p[i - 1][1]) * k, (p[i][0] - p[i - 1][0]) * M_LAT); return s; }
function areaM2(r, k) { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[1] * k * q[0] * M_LAT - q[1] * k * p[0] * M_LAT; } return Math.abs(a / 2); }
const rnd = (p) => [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5];
function parseWidth(v) { const m = String(v || '').match(/[\d.]+/); const x = m ? Number(m[0]) : NaN; return Number.isFinite(x) && x > 0 && x < 5000 ? Math.round(x) : null; }

function waterKind(t) {
  if (t.waterway === 'riverbank') return 'river';
  if (t.waterway === 'dock') return 'dock';
  if (t.natural !== 'water') return null;
  const w = t.water || '';
  if (DROP.has(w)) return null;
  if (WATER_KEEP.has(w)) return w === 'lock' ? 'lock' : w === 'tidal' || w === 'lagoon' || w === 'oxbow' ? 'river' : w === 'basin' ? 'harbour' : w;
  if (!w) return t.tidal === 'yes' ? 'river' : 'water';   // untagged tidal water: part of the estuary / port basins
  return w === 'lake' ? 'lake' : null;
}

export function compact(port, json) {
  const [s, w, n, e] = port.bbox;
  const k = Math.cos(((s + n) / 2) * D2R) * M_LAT;
  const mg = 0.02, box = [s - mg, w - mg * 1.6, n + mg, e + mg * 1.6];
  const coastWays = [], water = [], lines = [], quays = [];
  const addArea = (kind, outers, inners, name) => {
    for (const o of joinWays(outers)) {
      if (!o.closed) continue;
      let ring = clipRing(o.slice(0, -1), box);
      if (ring.length < 3) continue;
      const a = areaM2(ring, k);
      // navigable water only: lakes and small unnamed ponds are dropped, big rivers / estuary parts kept coarser
      if (kind === 'lake') continue;
      if (kind === 'water' && a < 500000 && !/(dok|dock|haven|hafen|kanaal|kanal|canal|port|bassin|darse|hamn|basin|harbour)/i.test(name || '')) continue;
      if (a < (kind === 'river' ? 50000 : kind === 'canal' ? 20000 : 3000)) continue;
      ring = ringRdp(ring, kind === 'water' || kind === 'river' ? 15 : 6, k).map(rnd);
      if (ring.length < 3) continue;
      const holes = [];
      for (const ii of joinWays(inners)) {
        if (!ii.closed) continue;
        let h = clipRing(ii.slice(0, -1), box);
        if (h.length < 3 || areaM2(h, k) < 3000) continue;
        h = ringRdp(h, 15, k).map(rnd);
        if (h.length >= 3) holes.push(h);
      }
      const rec = { k: kind, rings: [ring, ...holes] };
      if (name) rec.name = String(name).slice(0, 40);
      water.push(rec);
    }
  };
  for (const el of json.elements) {
    const t = el.tags || {};
    if (el.type === 'way') {
      const p = pts(el.geometry);
      if (p.length < 2) continue;
      if (t.natural === 'coastline') { coastWays.push(p); continue; }
      const wk = waterKind(t);
      if (wk) { if (same(p[0], p[p.length - 1])) addArea(wk, [p], [], t.name); continue; }
      if (/^(river|canal|fairway)$/.test(t.waterway || '')) {
        if (t.tunnel && t.tunnel !== 'no') continue;
        for (const run of clipLine(p, box)) { if (t.waterway !== 'fairway' && lenM(run, k) < 3000) continue; lines.push({ k: t.waterway, w: parseWidth(t.width), name: t.name ? String(t.name).slice(0, 40) : undefined, pts: rdp(run, 30, k).map(rnd) }); }
        continue;
      }
      if (/^(quay|pier|jetty)$/.test(t.man_made || '')) {
        for (const run of clipLine(p, box)) { if (lenM(run, k) < (t.man_made === 'quay' ? 60 : 100)) continue; if (process.env.QUAYS) quays.push({ k: t.man_made, pts: rdp(run, 4, k).map(rnd) }); }
      }
    } else if (el.type === 'relation') {
      const wk = waterKind(t);
      if (!wk || !Array.isArray(el.members)) continue;
      const outers = el.members.filter((m) => m.type === 'way' && m.role !== 'inner').map((m) => pts(m.geometry)).filter((x) => x.length >= 2);
      const inners = el.members.filter((m) => m.type === 'way' && m.role === 'inner').map((m) => pts(m.geometry)).filter((x) => x.length >= 2);
      addArea(wk, outers, inners, t.name);
    }
  }
  const coast = [];
  for (const c of joinWays(coastWays)) for (const run of clipLine(c, box)) coast.push(rdp(run, 15, k).map(rnd));
  return { id: port.id, harbor: port.harbor, name: port.name, bbox: port.bbox, source: 'OpenStreetMap contributors (ODbL), Overpass', fetchedAt: new Date().toISOString().slice(0, 10), coast, water, lines, quays };
}
/** Google encoded polyline, precision 1e-5 (server/bigports.js decodePolyline). */
function enc(pts) { let s = '', pl = 0, pn = 0; const e = (v) => { v = v < 0 ? ~(v << 1) : v << 1; let o = ''; while (v >= 0x20) { o += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return o + String.fromCharCode(v + 63); }; for (const p of pts) { const a = Math.round(p[0] * 1e5), b = Math.round(p[1] * 1e5); s += e(a - pl) + e(b - pn); pl = a; pn = b; } return s; }
/** The shipped format: polylines encoded, degenerate coast runs dropped. */
export function pack(j) {
  return { id: j.id, harbor: j.harbor, name: j.name, bbox: j.bbox, source: j.source, fetchedAt: j.fetchedAt, enc: 'polyline5',
    coast: j.coast.filter((c) => c.some((p) => p[0] !== c[0][0] || p[1] !== c[0][1])).map(enc),
    water: j.water.map((w) => ({ k: w.k, r: w.rings.map(enc) })),
    lines: j.lines.map((l) => (l.w ? { k: l.k, w: l.w, r: enc(l.pts) } : { k: l.k, r: enc(l.pts) })) };
}

async function main() {
  const outDir = process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'server', 'bigports');
  const only = process.argv.slice(3);
  const rawDir = process.env.RAW_DIR || '';   // reuse raw Overpass answers saved as <RAW_DIR>/<id>.json
  fs.mkdirSync(outDir, { recursive: true });
  for (const port of PORTS) {
    if (only.length && !only.includes(port.id)) continue;
    const t0 = Date.now();
    process.stdout.write(`${port.id}: `);
    try {
      const rawFile = rawDir && path.join(rawDir, `${port.id}.json`);
      const json = rawFile && fs.existsSync(rawFile) ? JSON.parse(fs.readFileSync(rawFile, 'utf8')) : await overpass(query(port.bbox));
      const c = compact(port, json);
      const s = JSON.stringify(pack(c));
      fs.writeFileSync(path.join(outDir, `${port.id}.json`), s);
      console.log(`${json.elements.length} el → ${c.coast.length} coast, ${c.water.length} water, ${c.lines.length} lines, ${c.quays.length} quays, ${(s.length / 1024).toFixed(0)} KB, ${Date.now() - t0} ms`);
    } catch (e) { console.log('FAILED', e.message); }
    await new Promise((r) => setTimeout(r, 3000));
  }
}
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) main();
