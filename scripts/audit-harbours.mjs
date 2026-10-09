#!/usr/bin/env node
// Harbour position audit (2026-10-09): every harbour's anchor, approach, roads and port area from real data.
//
// Player report: the game harbour of Gdynia lay ~4.6 km offshore in open water while the real port (rendered by the
// world detail tiles, AIS ships at the real quays) is to the west. The world-coverage builder had placed ~250 harbours
// from memory and moved them onto open water of the 5 km raster, so many anchors sat at the roads up to ~12 km off.
//
// Data: the world detail tiles (D14 = OpenFreeMap z14 vector tiles, converted by server/wtconvert.js exactly like the
// server does: water classes incl. dock basins, quay edges (OSM man_made=quay + straight edges next to docks / port
// land / piers), port sheds, cranes and lights from the Overpass overlay, the depth model) and the AIS port gazetteer
// (server/ais/ports.js). Nothing is guessed: a harbour without port evidence keeps its position.
//
// Method per harbour (analyse):
//   1. region = the D14 tiles within 6 km of the old position and 3.5 km of the gazetteer port (if < 30 km away);
//      tiles come from the server's tile cache (read only) or ./t/ (fetched by `fetch`); missing ones are unknown water
//   2. port evidence on a 100 m grid: quay length (OSM × 1.5, derived × 1), dock-class water (0.01 / m²), port sheds
//      (0.01 / m²), cranes (150 each), pontoons (−30, marinas); Gaussian density (σ 500 m) weighted by the distance to
//      the old position (σ≈9 km) or to the gazetteer port (σ≈4 km); the mode is the main commercial port
//   3. anchor = navigable water (not shallow, not a lock) connected to the sea, ≥ the size's depth (mega 14 m, major 12,
//      regional 8, minor 5) with ≥ 70 / 55 / 40 / 25 m clearance, within 2 km of the mode, maximising the quay length
//      within ~300 m (constraints relaxed step by step when nothing fits)
//   4. way out: Dijkstra over the water (cost ∝ 1 + 60 m / clearance) to open sea (≥ 600 m clearance, ≥ 15 m) →
//      entrance = the last point narrower than max(150 m, 2.5 × clearance), approach = 400 m outside it, heading inbound
//   5. port area = the evidence cells ≥ 20 % of the mode density connected to it (convex hull, bbox)
//   6. confidence: high = ≥ 500 m quays within 1 km (or ≥ 2 cranes, or ≥ 10 ha of docks), a quay ≤ 400 m from the
//      anchor, every tile near the anchor / way out loaded, no relaxation; medium = ≥ 150 m quays (or 3 ha docks) and a
//      quay ≤ 800 m; else low
// apply (in the repo): roads = first point ≥ 1.5 km beyond the entrance along the way out with ≥ 12 m on the raw world
//   raster (no harbour carvings) and water 600 m round, else the old position; writes server/harbor-positions.js and
//   the new lat/lon into server/harbors.js / harbors-world.js (ids unchanged). Big ports (server/bigports.js: OSM-carved
//   with a sub-patch grid round the harbour) and harbours without evidence or with low confidence keep their position.
//
// Usage (the fetching part runs where OpenFreeMap is reachable, next to an app checkout, in a scratch folder):
//   node audit-harbours.mjs seeds   --app ../saltline-app                 → seeds.json (harbours + gazetteer ports)
//   node audit-harbours.mjs analyse --app ../saltline-app [from to] [ids] → out.ndjson, need.txt (missing tiles)
//   node audit-harbours.mjs fetch   --app ../saltline-app need.txt [max]  → ./t/<x>/<y>.slwt.gz (sequential, polite)
//   (repeat analyse for the harbours in need.txt after a fetch)
//   node audit-harbours.mjs compact out.ndjson                             → compact.json
//   node scripts/audit-harbours.mjs apply compact.json [--dry]             (in the repo)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (k, d = null) => { const i = argv.indexOf(k); if (i < 0) return d; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.resolve(opt('--app', REPO));
const WORK = process.cwd() + '/';
const SRV = path.join(APP, 'data/world/tiles/f1/14') + '/';
const imp = (p) => import(pathToFileURL(path.join(APP, p)).href);
const { WT, tileF, tileFToLatLon, tileSizeM, tilesInRadius, decodeTile, decodeWTHeight } = await imp('shared/wtformat.js');
const { haversine, bearing, destination } = await imp('shared/geo.js');
const NEED_DEPTH = { mega: 14, major: 12, regional: 8, minor: 5 };
const CLEAR = { mega: 70, major: 55, regional: 40, minor: 25 };
const M = WT.MASK;
const KEEP_OUTER = new Set(['shanghai', 'bordeaux', 'melbourne', 'quebec', 'tampa', 'corpus_christi', 'haldia', 'yangon', 'new_orleans', 'posorja', 'haiphong', 'arkhangelsk']);
const r6 = (v) => Math.round(v * 1e6) / 1e6;
const r5 = (v) => Math.round(v * 1e5) / 1e5;

function loadTile(x, y) {
  for (const f of [`${WORK}t/${x}/${y}.slwt.gz`, `${SRV}${x}/${y}.slwt.gz`]) {
    try { if (fs.existsSync(f)) return decodeTile(zlib.gunzipSync(fs.readFileSync(f))); } catch { /* broken */ }
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ seeds
async function seeds() {
  const { HARBORS } = await imp('server/harbors.js');
  const { createPortIndex } = await imp('server/ais/ports.js');
  const idx = createPortIndex(HARBORS);
  const out = HARBORS.map((h) => {
    const o = h.prev || h;   // the audit always starts from the pre-audit position
    const ps = idx.ports.filter((p) => p.harbor === h.id && p.locode).sort((a, b) => haversine(o.lat, o.lon, a.lat, a.lon) - haversine(o.lat, o.lon, b.lat, b.lon));
    const g = ps[0] || null;
    return { id: h.id, name: h.name, size: h.size, lat: o.lat, lon: o.lon, gz: g ? { loc: g.locode, lat: g.lat, lon: g.lon, r: g.r } : null };
  });
  fs.writeFileSync(WORK + 'seeds.json', JSON.stringify(out));
  console.log(`seeds.json: ${out.length} harbours, ${out.filter((s) => s.gz).length} with a gazetteer port`);
}

// ------------------------------------------------------------------------------------------------ analyse
function analyse(s) {
  // the gazetteer port (server/ais/ports.js, "positions are the harbour") steers the search when it is ≤ 30 km away,
  // except for harbours deliberately named after an outer terminal / roadstead (Yangshan, Le Verdon, Port Phillip Heads…)
  const gzD = s.gz ? haversine(s.lat, s.lon, s.gz.lat, s.gz.lon) : Infinity;
  const gzOk = gzD < 30000 && !KEEP_OUTER.has(s.id);
  const tl = new Map();
  for (const t of tilesInRadius(14, s.lat, s.lon, 6000)) tl.set(`${t.x}/${t.y}`, t);
  if (gzOk) for (const t of tilesInRadius(14, s.gz.lat, s.gz.lon, 3500)) tl.set(`${t.x}/${t.y}`, t);
  if (gzOk && gzD > 6000) for (let d = 0; d <= gzD; d += 500) { const p = destination(s.lat, s.lon, bearing(s.lat, s.lon, s.gz.lat, s.gz.lon), d); for (const t of tilesInRadius(14, p.lat, p.lon, 1200)) tl.set(`${t.x}/${t.y}`, t); }
  let tx0 = Infinity, ty0 = Infinity, tx1 = -Infinity, ty1 = -Infinity;
  for (const t of tl.values()) { tx0 = Math.min(tx0, t.x); ty0 = Math.min(ty0, t.y); tx1 = Math.max(tx1, t.x); ty1 = Math.max(ty1, t.y); }
  const NT = 128;                              // half resolution: 128 cells per tile
  const W = (tx1 - tx0 + 1) * NT, H = (ty1 - ty0 + 1) * NT;
  const latC = s.lat, cellM = tileSizeM(14, latC) / NT;
  // 0 unknown, 1 nav, 2 obstacle, 3 shallow nav, 4 lock
  const mk = new Uint8Array(W * H), dep = new Float32Array(W * H), dock = new Uint8Array(W * H);
  const quays = [], cranes = [], sheds = [], pontoons = [], missing = [];
  let loaded = 0;
  for (const t of tl.values()) {
    const tile = loadTile(t.x, t.y);
    const ox = (t.x - tx0) * NT, oy = (t.y - ty0) * NT;
    if (!tile) { missing.push(`${t.x}/${t.y}`); continue; }
    loaded++;
    if (!tile.mask) {   // uniform
      const land = (tile.flags & WT.FLAG.UNIFORM_LAND) !== 0;
      for (let j = 0; j < NT; j++) for (let i = 0; i < NT; i++) { const k = (oy + j) * W + ox + i; mk[k] = land ? 2 : 1; dep[k] = land ? -5 : -tile.uniformH; }
      continue;
    }
    for (let j = 0; j < NT; j++) for (let i = 0; i < NT; i++) {
      let nav = 0, sh = 0, lock = 0, dk = 0, dmin = Infinity;
      for (let b = 0; b < 2; b++) for (let a = 0; a < 2; a++) {
        const q = (2 * j + b) * 256 + 2 * i + a, m = tile.mask[q];
        const h = decodeWTHeight(tile.height[q]);
        if (m === M.WATER || m === M.FAIRWAY || m === M.DOCK || m === M.RIVER) { nav++; dmin = Math.min(dmin, -h); if (m === M.DOCK) dk++; }
        else if (m === M.SHALLOW) { sh++; dmin = Math.min(dmin, -h); }
        else if (m === M.LOCK) { lock++; dmin = Math.min(dmin, -h); }
      }
      const k = (oy + j) * W + ox + i;
      mk[k] = nav + sh + lock >= 3 ? (lock >= 2 ? 4 : sh >= 2 ? 3 : 1) : 2;
      dep[k] = mk[k] === 2 ? -3 : dmin;
      dock[k] = dk >= 2 ? 1 : 0;
    }
    const v = tile.vectors; if (!v) continue;
    const sizeM = tileSizeM(14, tileFToLatLon(14, t.x + 0.5, t.y + 0.5).lat);
    const P = (dmx, dmz) => [ox + (dmx / 10 / sizeM) * NT, oy + (dmz / 10 / sizeM) * NT];   // region cell coords
    for (const q of v.quays || []) { const pts = []; for (let i = 0; i + 1 < q.p.length; i += 2) pts.push(P(q.p[i], q.p[i + 1])); quays.push({ pts, k: q.k || 'osm' }); }
    for (const c of v.cranes || []) cranes.push({ p: P(c.x, c.z), k: c.k });
    for (const b of v.buildings || []) if (b.k === 'shed') { let a = 0; const r = b.r; for (let i = 0; i + 3 < r.length; i += 2) a += r[i] * r[i + 3] - r[i + 2] * r[i + 1]; const n = r.length; a += r[n - 2] * r[1] - r[0] * r[n - 1]; sheds.push({ p: P(r[0], r[1]), a: Math.abs(a) / 200 }); }
    for (const p of v.pontoons || []) pontoons.push({ p: P(p.r[0], p.r[1]) });
  }
  const toLL = (cx, cy) => { const p = tileFToLatLon(14, tx0 + cx / NT, ty0 + cy / NT); return { lat: r6(p.lat), lon: r6(p.lon) }; };
  const toC = (lat, lon) => { const f = tileF(14, lat, lon); return [(f.fx - tx0) * NT, (f.fy - ty0) * NT]; };

  // ---- evidence on a ~100 m grid
  const G = Math.max(1, Math.round(100 / cellM)), GW = Math.ceil(W / G), GH = Math.ceil(H / G), gm = G * cellM;
  const ev = new Float32Array(GW * GH), evQ = new Float32Array(GW * GH);
  const gAdd = (cx, cy, w, arr = ev) => { const i = Math.floor(cx / G), j = Math.floor(cy / G); if (i >= 0 && j >= 0 && i < GW && j < GH) arr[j * GW + i] += w; };
  let quayLenTot = 0;
  for (const q of quays) for (let i = 0; i + 1 < q.pts.length; i++) {
    const [ax, ay] = q.pts[i], [bx, by] = q.pts[i + 1], L = Math.hypot(bx - ax, by - ay) * cellM, n = Math.max(1, Math.ceil(L / 20));
    quayLenTot += L;
    for (let k = 0; k < n; k++) { const t = (k + 0.5) / n; gAdd(ax + (bx - ax) * t, ay + (by - ay) * t, (L / n) * (q.k === 'derived' ? 1 : 1.5)); gAdd(ax + (bx - ax) * t, ay + (by - ay) * t, L / n, evQ); }
  }
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) if (dock[j * W + i]) gAdd(i, j, cellM * cellM * 0.01);
  for (const c of cranes) gAdd(c.p[0], c.p[1], 150);
  for (const b of sheds) gAdd(b.p[0], b.p[1], b.a * 0.01);
  for (const p of pontoons) gAdd(p.p[0], p.p[1], -30);
  const blur = (src, sigmaCells) => {
    const r = Math.ceil(sigmaCells * 3), ker = []; let ks = 0;
    for (let d = -r; d <= r; d++) { const w = Math.exp(-(d * d) / (2 * sigmaCells * sigmaCells)); ker.push(w); ks += w; }
    const tmp = new Float32Array(GW * GH), out = new Float32Array(GW * GH);
    for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) { let a = 0; for (let d = -r; d <= r; d++) { const ii = i + d; if (ii >= 0 && ii < GW) a += src[j * GW + ii] * ker[d + r]; } tmp[j * GW + i] = a / ks; }
    for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) { let a = 0; for (let d = -r; d <= r; d++) { const jj = j + d; if (jj >= 0 && jj < GH) a += tmp[jj * GW + i] * ker[d + r]; } out[j * GW + i] = a / ks; }
    return out;
  };
  const dens = blur(ev, 500 / gm), densQ = blur(evQ, 300 / gm);
  const A0 = toC(s.lat, s.lon), G0 = gzOk ? toC(s.gz.lat, s.gz.lon) : null;
  const wOf = (gi, gj) => {
    const cx = (gi + 0.5) * G, cy = (gj + 0.5) * G;
    const dA = Math.hypot(cx - A0[0], cy - A0[1]) * cellM, dG = G0 ? Math.hypot(cx - G0[0], cy - G0[1]) * cellM : Infinity;
    return G0 ? Math.max(0.35 * Math.exp(-((dA / 8000) ** 2)), Math.exp(-((dG / 3000) ** 2))) : Math.exp(-((dA / 9000) ** 2));
  };
  const modes = [];
  { const sc = new Float32Array(GW * GH); for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) sc[j * GW + i] = dens[j * GW + i] * wOf(i, j);
    for (let n = 0; n < 3; n++) {
      let b = -1, bs = 0;
      for (let k = 0; k < sc.length; k++) { if (sc[k] <= bs) continue; const i = k % GW, j = (k - i) / GW; if (modes.some((m) => Math.hypot(m.gi - i, m.gj - j) * gm < 2500)) continue; bs = sc[k]; b = k; }
      if (b < 0) break;
      const gi = b % GW, gj = (b - gi) / GW; modes.push({ gi, gj, score: bs, dens: dens[b] });
    }
  }
  const res = { id: s.id, name: s.name, size: s.size, old: { lat: s.lat, lon: s.lon }, gz: s.gz, tiles: tl.size, loaded, missing: missing.length, quayLenTot: Math.round(quayLenTot), cranes: cranes.length };
  if (!modes.length) { res.fail = 'no port evidence'; return { res, need: missing }; }
  const mode = modes[0], MC = [(mode.gi + 0.5) * G, (mode.gj + 0.5) * G];
  res.mode = { ...toLL(MC[0], MC[1]), dens: Math.round(mode.dens * 10) / 10 };
  res.altModes = modes.slice(1).map((m) => ({ ...toLL((m.gi + 0.5) * G, (m.gj + 0.5) * G), ratio: Math.round((m.score / mode.score) * 100) / 100 }));

  // ---- clearance (EDT to obstacles; unknown counts as water) and sea connectivity
  const INF = 1e20, f = new Float64Array(Math.max(W, H)), d1 = new Float64Array(Math.max(W, H)), v = new Int32Array(Math.max(W, H)), z = new Float64Array(Math.max(W, H) + 1);
  const edt1 = (n) => { let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF; for (let q = 1; q < n; q++) { let s2; for (;;) { const p = v[k]; s2 = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p); if (s2 <= z[k]) { k--; if (k < 0) { k = 0; break; } } else break; } k++; v[k] = q; z[k] = s2; z[k + 1] = INF; } k = 0; for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; const p = v[k]; d1[q] = (q - p) * (q - p) + f[p]; } };
  const clr = new Float32Array(W * H);
  for (let j = 0; j < H; j++) { for (let i = 0; i < W; i++) f[i] = mk[j * W + i] === 2 ? 0 : INF; edt1(W); for (let i = 0; i < W; i++) clr[j * W + i] = d1[i]; }
  for (let i = 0; i < W; i++) { for (let j = 0; j < H; j++) f[j] = clr[j * W + i]; edt1(H); for (let j = 0; j < H; j++) clr[j * W + i] = Math.sqrt(d1[j]) * cellM; }
  const navAny = (k) => mk[k] === 1 || mk[k] === 3 || mk[k] === 4 || mk[k] === 0;
  const sea = new Uint8Array(W * H), qu = new Int32Array(W * H); let qh = 0, qt = 0;
  for (let k = 0; k < W * H; k++) {
    const i = k % W, j = (k - i) / W;
    const border = i === 0 || j === 0 || i === W - 1 || j === H - 1;
    if ((mk[k] === 1 && clr[k] >= 800 && dep[k] >= 15) || (border && navAny(k))) { sea[k] = 1; qu[qt++] = k; }
  }
  while (qh < qt) { const k = qu[qh++], i = k % W, j = (k - i) / W; for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue; const q = jj * W + ii; if (!sea[q] && navAny(q)) { sea[q] = 1; qu[qt++] = q; } } }

  // ---- anchor: berth-able water in the main basin next to the quays
  const need = NEED_DEPTH[s.size] || 8, cmin = CLEAR[s.size] || 40;
  const dQAt = (i, j) => { const gi = Math.min(GW - 1, Math.floor(i / G)), gj = Math.min(GH - 1, Math.floor(j / G)); return densQ[gj * GW + gi]; };
  let anchor = null, relax = 0;
  for (const [rM, dF, cF] of [[2000, 1, 1], [2000, 0.75, 0.6], [3500, 0.6, 0.45], [3500, 0.4, 0.3]]) {
    const R = rM / cellM; let best = -1, bs = -Infinity;
    const i0 = Math.max(0, Math.floor(MC[0] - R)), i1 = Math.min(W - 1, Math.ceil(MC[0] + R)), j0 = Math.max(0, Math.floor(MC[1] - R)), j1 = Math.min(H - 1, Math.ceil(MC[1] + R));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * W + i;
      if (mk[k] !== 1 || !sea[k] || dep[k] < need * dF || clr[k] < cmin * cF) continue;
      const dm = Math.hypot(i - MC[0], j - MC[1]) * cellM; if (dm > rM) continue;
      const sc = dQAt(i, j) * (1 - 0.3 * dm / rM) + Math.min(clr[k], 2 * cmin) / (2 * cmin) * 0.15 * mode.dens - (clr[k] > 6 * cmin ? 0.2 * mode.dens * Math.min(1, (clr[k] - 6 * cmin) / (6 * cmin)) : 0);
      if (sc > bs) { bs = sc; best = k; }
    }
    if (best >= 0) { const i = best % W, j = (best - i) / W; anchor = { i, j, k: best }; break; }
    relax++;
  }
  if (!anchor) { res.fail = 'no water near the port evidence'; return { res, need: missing }; }
  const A = toLL(anchor.i + 0.5, anchor.j + 0.5);
  let nq = Infinity;
  for (const q of quays) for (let i = 0; i + 1 < q.pts.length; i++) {
    const [ax, ay] = q.pts[i], [bx, by] = q.pts[i + 1], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((anchor.i + 0.5 - ax) * dx + (anchor.j + 0.5 - ay) * dy) / L2)) : 0;
    nq = Math.min(nq, Math.hypot(ax + dx * t - anchor.i - 0.5, ay + dy * t - anchor.j - 0.5) * cellM);
  }
  let q1 = 0; for (const q of quays) for (let i = 0; i + 1 < q.pts.length; i++) { const mx = (q.pts[i][0] + q.pts[i + 1][0]) / 2, my = (q.pts[i][1] + q.pts[i + 1][1]) / 2; if (Math.hypot(mx - anchor.i, my - anchor.j) * cellM <= 1000) q1 += Math.hypot(q.pts[i + 1][0] - q.pts[i][0], q.pts[i + 1][1] - q.pts[i][1]) * cellM; }
  let dk1 = 0; { const R = 1000 / cellM; for (let j = Math.max(0, Math.floor(anchor.j - R)); j < Math.min(H, anchor.j + R); j++) for (let i = Math.max(0, Math.floor(anchor.i - R)); i < Math.min(W, anchor.i + R); i++) if (dock[j * W + i] && Math.hypot(i - anchor.i, j - anchor.j) <= R) dk1++; }
  const cr2 = cranes.filter((c) => Math.hypot(c.p[0] - anchor.i, c.p[1] - anchor.j) * cellM <= 2000).length;
  Object.assign(res, { anchor: A, anchorDepth: Math.round(dep[anchor.k] * 10) / 10, anchorClear: Math.round(clr[anchor.k]), anchorDock: !!dock[anchor.k], nearestQuayM: Math.round(nq), quay1km: Math.round(q1), dockHa1km: Math.round(dk1 * cellM * cellM / 1e4 * 10) / 10, cranes2km: cr2, relax, movedM: Math.round(haversine(s.lat, s.lon, A.lat, A.lon)) });

  // ---- way out: Dijkstra to open sea (clearance ≥ 600 m and ≥ 15 m deep, or a region border water cell)
  const dist = new Float64Array(W * H).fill(Infinity), prev = new Int32Array(W * H).fill(-1);
  const heap = []; const push = (c, k) => { heap.push([c, k]); let n = heap.length - 1; while (n > 0) { const p = (n - 1) >> 1; if (heap[p][0] <= heap[n][0]) break; [heap[p], heap[n]] = [heap[n], heap[p]]; n = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let n = 0; for (;;) { const l = 2 * n + 1, r = l + 1; let m = n; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === n) break; [heap[m], heap[n]] = [heap[n], heap[m]]; n = m; } } return top; };
  dist[anchor.k] = 0; push(0, anchor.k); let goal = -1;
  const isGoal = (k) => { const i = k % W, j = (k - i) / W; return (mk[k] === 1 && clr[k] >= 600 && dep[k] >= 15) || ((i === 0 || j === 0 || i === W - 1 || j === H - 1) && navAny(k)); };
  while (heap.length) {
    const [c, k] = pop(); if (c > dist[k]) continue;
    if (isGoal(k)) { goal = k; break; }
    const i = k % W, j = (k - i) / W;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue; const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue;
      const q = jj * W + ii; if (!navAny(q)) continue;
      const step = (di && dj ? Math.SQRT2 : 1) * cellM * (1 + 60 / Math.max(5, clr[q])) * (mk[q] === 3 ? 3 : mk[q] === 4 ? 2 : mk[q] === 0 ? 3 : 1) * (dep[q] < need * 0.8 && mk[q] !== 0 ? 2 : 1);
      const nc = c + step; if (nc < dist[q]) { dist[q] = nc; prev[q] = k; push(nc, q); }
    }
  }
  if (goal < 0) { res.warn = 'no way to open sea in the loaded tiles'; }
  else {
    const path = []; for (let k = goal; k >= 0; k = prev[k]) path.push(k); path.reverse();
    const pl = path.map((k) => { const i = k % W, j = (k - i) / W; return { i: i + 0.5, j: j + 0.5, c: clr[k], d: dep[k], u: mk[k] === 0 }; });
    let along = 0; pl[0].s = 0; for (let n = 1; n < pl.length; n++) { along += Math.hypot(pl[n].i - pl[n - 1].i, pl[n].j - pl[n - 1].j) * cellM; pl[n].s = along; }
    // entrance: the last point (anchor → sea) whose clearance is below max(150 m, 2.5 × the basin minimum); approach ~400 m outside it
    const T = Math.max(150, 2.5 * cmin);
    let ent = 0; for (let n = 0; n < pl.length; n++) if (pl[n].c < T && !pl[n].u) ent = n;
    const at = (sM) => { let n = 0; while (n + 1 < pl.length && pl[n + 1].s < sM) n++; return pl[Math.min(pl.length - 1, n)]; };
    const E = pl[ent], Ap = at(E.s + 400), X = pl[pl.length - 1], Xb = at(Math.max(0, X.s - 1000));
    const ELL = toLL(E.i, E.j), ALL = toLL(Ap.i, Ap.j), XLL = toLL(X.i, X.j), XbLL = toLL(Xb.i, Xb.j);
    // simplified path (every ~150 m) for the record
    const simp = []; let lastS = -1e9; for (const p of pl) if (p.s - lastS >= 150) { simp.push([toLL(p.i, p.j).lat, toLL(p.i, p.j).lon]); lastS = p.s; } simp.push([XLL.lat, XLL.lon]);
    Object.assign(res, { entrance: { ...ELL, clearM: Math.round(E.c), alongM: Math.round(E.s) }, approach: { ...ALL, hdg: Math.round(bearing(ALL.lat, ALL.lon, ELL.lat, ELL.lon)) }, exit: { ...XLL, out: Math.round(bearing(XbLL.lat, XbLL.lon, XLL.lat, XLL.lon)), alongM: Math.round(X.s), unknown: X.u }, path: simp, minPathDepth: Math.round(Math.min(...pl.filter((p) => !p.u).map((p) => p.d)) * 10) / 10, minPathClear: Math.round(Math.min(...pl.slice(1).map((p) => p.c))) });
    // missing tiles near the anchor / along the way out → fetch list
    const nearT = new Set();
    for (const t of tilesInRadius(14, A.lat, A.lon, 1500)) nearT.add(`${t.x}/${t.y}`);
    for (const p of simp) for (const t of tilesInRadius(14, p[0], p[1], 300)) nearT.add(`${t.x}/${t.y}`);
    res.needNear = [...nearT].filter((k) => !fs.existsSync(`${WORK}t/${k}.slwt.gz`) && !fs.existsSync(`${SRV}${k}.slwt.gz`));
  }
  if (!res.needNear) { const nearT = new Set(); for (const t of tilesInRadius(14, A.lat, A.lon, 1500)) nearT.add(`${t.x}/${t.y}`); res.needNear = [...nearT].filter((k) => !fs.existsSync(`${WORK}t/${k}.slwt.gz`) && !fs.existsSync(`${SRV}${k}.slwt.gz`)); }

  // ---- port area: evidence cells ≥ 20 % of the mode density connected to the mode → convex hull
  { const thr = 0.2 * mode.dens, seen = new Uint8Array(GW * GH), st = [mode.gj * GW + mode.gi], pts = []; seen[st[0]] = 1;
    while (st.length) { const k = st.pop(), i = k % GW, j = (k - i) / GW; pts.push([i, j]); for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= GW || jj >= GH) continue; const q = jj * GW + ii; if (!seen[q] && dens[q] >= thr && Math.hypot(ii - mode.gi, jj - mode.gj) * gm <= 6000) { seen[q] = 1; st.push(q); } } }
    const P = []; for (const [i, j] of pts) for (const [a, b] of [[0, 0], [1, 0], [0, 1], [1, 1]]) P.push([(i + a) * G, (j + b) * G]);
    P.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = []; for (const p of P) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (let n = P.length - 1; n >= 0; n--) { const p = P[n]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    const hull = lo.slice(0, -1).concat(up.slice(0, -1)).map(([x, y]) => toLL(x, y));
    const lats = hull.map((p) => p.lat), lons = hull.map((p) => p.lon);
    res.area = { cells: pts.length, bbox: [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)].map(r6), hull: hull.map((p) => [p.lat, p.lon]) };
  }
  const strong = res.quay1km >= 500 || res.cranes2km >= 2 || res.dockHa1km >= 10;
  res.conf = strong && res.nearestQuayM <= 400 && !res.needNear.length && relax === 0 ? 'high' : (res.quay1km >= 150 || res.dockHa1km >= 3) && res.nearestQuayM <= 800 ? 'medium' : 'low';
  return { res, need: missing };
}

function analyseAll() {
  const list0 = JSON.parse(fs.readFileSync(WORK + 'seeds.json', 'utf8'));
  const nums = argv.slice(1).filter((a) => /^\d+$/.test(a)).map(Number), ids = new Set(argv.slice(1).filter((a) => !/^\d+$/.test(a)));
  const [from, to] = [nums[0] ?? 0, nums[1] ?? list0.length];
  const OUT = WORK + (process.env.OUT || 'out.ndjson'), NEED = WORK + (process.env.NEEDF || 'need.txt');
  for (const s of list0.slice(from, to).filter((x) => !ids.size || ids.has(x.id))) {
    const t0 = Date.now();
    let r;
    try { r = analyse(s); } catch (e) { r = { res: { id: s.id, fail: 'error ' + String(e?.stack || e).slice(0, 300) }, need: [] }; }
    r.res.ms = Date.now() - t0;
    fs.appendFileSync(OUT, JSON.stringify(r.res) + '\n');
    if (r.res.needNear?.length) fs.appendFileSync(NEED, r.res.needNear.map((k) => `${s.id} ${k}`).join('\n') + '\n');
    console.log(s.id, r.res.conf || r.res.fail, r.res.movedM, r.res.ms + 'ms');
  }
}

// ------------------------------------------------------------------------------------------------ fetch
async function fetchTiles() {
  const { convertJob } = await imp('server/wtconvert-thread.js');
  const { hintsFor } = await imp('server/worldtiles.js');
  const { UA } = await imp('server/wtsource.js');
  const DATA = path.join(APP, 'data/world') + '/';
  const pin = JSON.parse(fs.readFileSync(DATA + 'pin.json', 'utf8')).ofm;
  const keys = [...new Set(fs.readFileSync(WORK + (argv[1] || 'need.txt'), 'utf8').split('\n').map((l) => l.trim().split(' ')[1]).filter(Boolean))];
  const max = Number(argv[2] || 1e9);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let got = 0, failed = 0, skipped = 0;
  for (const k of keys) {
    if (got + failed >= max) break;
    const [x, y] = k.split('/').map(Number), out = `${WORK}t/${x}/${y}.slwt.gz`;
    if (fs.existsSync(out) || fs.existsSync(`${SRV}${x}/${y}.slwt.gz`)) { skipped++; continue; }
    let buf = null;
    try {
      const r = await fetch(`https://tiles.openfreemap.org/planet/${pin}/14/${x}/${y}.pbf`, { headers: { 'User-Agent': UA + ' harbour audit', Accept: 'application/x-protobuf,*/*' }, signal: AbortSignal.timeout(20000) });
      if (r.status === 200 || r.status === 204) buf = new Uint8Array(await r.arrayBuffer());
      else { failed++; fs.appendFileSync(WORK + 'fetch.log', `${k} HTTP ${r.status}\n`); await sleep(1000); continue; }
    } catch (e) { failed++; fs.appendFileSync(WORK + 'fetch.log', `${k} ${e.message}\n`); await sleep(2000); continue; }
    let bathy = null;
    try { const x9 = x >> 5, y9 = y >> 5, b = fs.readFileSync(`${DATA}bathy/${x9}/${y9}.bin`); if (b.length === 131072) bathy = { x9, y9, dm: new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)) }; } catch { /* none */ }
    let overlay = null;
    try { overlay = JSON.parse(zlib.gunzipSync(fs.readFileSync(`${DATA}overlay/${x >> 2}/${y >> 2}.json.gz`)).toString('utf8')); } catch { /* none */ }
    try {
      const r = convertJob({ z: 14, x, y, mvt: buf, overlay, bathy, hints: hintsFor(14, x, y, { src: `ofm:${pin}`, builtAt: Math.floor(Date.now() / 1000) }) });
      fs.mkdirSync(`${WORK}t/${x}`, { recursive: true });
      fs.writeFileSync(out, r.gz);
      got++;
    } catch (e) { failed++; fs.appendFileSync(WORK + 'fetch.log', `${k} convert ${e.message}\n`); }
    await sleep(250);
  }
  console.log(`fetched ${got}, failed ${failed}, skipped ${skipped}, of ${keys.length}`);
}

// ------------------------------------------------------------------------------------------------ compact
function rdp(pts, tol) {   // [[lat, lon]], tol metres
  if (pts.length < 3) return pts;
  const k = Math.cos((pts[0][0] * Math.PI) / 180) * 111320, m = 110540;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const st = [[0, pts.length - 1]];
  while (st.length) {
    const [a, b] = st.pop(); let bi = -1, bd = tol;
    const ax = pts[a][1] * k, ay = pts[a][0] * m, bx = pts[b][1] * k, by = pts[b][0] * m, dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) { const px = pts[i][1] * k, py = pts[i][0] * m; const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0; const d = Math.hypot(ax + dx * t - px, ay + dy * t - py); if (d > bd) { bd = d; bi = i; } }
    if (bi >= 0) { keep[bi] = 1; st.push([a, bi], [bi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
function compact() {
  const rows = new Map();
  for (const f of argv.slice(1)) for (const l of fs.readFileSync(f, 'utf8').trim().split('\n')) { const r = JSON.parse(l); rows.set(r.id, r); }   // later files win
  const out = {};
  for (const [id, r] of rows) {
    if (r.fail) { out[id] = { fail: r.fail, q: r.quayLenTot, ld: r.loaded, t: r.tiles }; continue; }
    let tol = 40, way = rdp(r.path || [], tol); while (way.length > 10) way = rdp(r.path, (tol *= 1.5));
    let hull = r.area.hull, ht = 60; while (hull.length > 12) hull = rdp(r.area.hull.concat([r.area.hull[0]]), (ht *= 1.5)).slice(0, -1);
    out[id] = {
      a: [r.anchor.lat, r.anchor.lon].map(r5), ap: r.approach ? [r5(r.approach.lat), r5(r.approach.lon), r.approach.hdg] : null,
      en: r.entrance ? [r5(r.entrance.lat), r5(r.entrance.lon), r.entrance.clearM] : null, ex: r.exit ? [r5(r.exit.lat), r5(r.exit.lon), r.exit.out, r.exit.alongM, r.exit.unknown ? 1 : 0] : null,
      w: way.map((p) => [r5(p[0]), r5(p[1])]), bb: r.area.bbox.map(r5), hl: hull.map((p) => [r5(p[0]), r5(p[1])]),
      c: r.conf, mv: r.movedM, e: [r.quay1km, r.dockHa1km, r.cranes2km, r.nearestQuayM, r.anchorDepth, r.anchorClear, r.anchorDock ? 1 : 0, r.minPathDepth ?? null, r.minPathClear ?? null, r.relax],
      md: [r5(r.mode.lat), r5(r.mode.lon)], alt: (r.altModes || []).map((m) => [r5(m.lat), r5(m.lon), m.ratio]), nn: (r.needNear || []).length,
    };
  }
  fs.writeFileSync(WORK + 'compact.json', JSON.stringify(out));
  console.log(`compact.json: ${Object.keys(out).length} harbours, ${fs.statSync(WORK + 'compact.json').size} bytes`);
}

// ------------------------------------------------------------------------------------------------ apply (repo)
/** Harbours reviewed by hand after the analysis: kept where they are (reason), whatever the evidence says. */
const KEEP = {
  arkhangelsk: 'the real port lies 40 km up the Northern Dvina — no port evidence near the White Sea roads',
  yangon: 'named after the Elephant Point roads at the river mouth; the city port lies 35 km up the Yangon River',
};
const KEEP_BIG = 'big port: OSM-carved port model (server/bigports.js) with a sub-patch grid round the harbour — anchor kept';
/** Breadth-first search over the raster cells (the finest layer at `from`) from the water cell nearest `from` to the
 *  first cell where accept(p) holds, ≤ maxM away: the cell centres [{lat, lon}] (simplified), or null. */
function rasterPath(w, from, accept, maxM) {
  const layer = w.layerFor(from.lat, from.lon), { res } = layer, W = layer.w, H = layer.h;
  const ll = (x, y) => ({ lat: layer.def.latMax - (y + 0.5) * res, lon: layer.def.lonMin + (x + 0.5) * res });
  const wet = (x, y) => x >= 0 && y >= 0 && x < W && y < H && w.depthAt(ll(x, y).lat, ll(x, y).lon) > 2;
  const c0 = layer.cellXY(from.lat, from.lon); let sx = -1, sy = -1;
  for (let r = 0; r <= 6 && sx < 0; r++) for (let dy = -r; dy <= r && sx < 0; dy++) for (let dx = -r; dx <= r; dx++) { const x = Math.floor(c0.cx) + dx, y = Math.floor(c0.cy) + dy; if (Math.max(Math.abs(dx), Math.abs(dy)) === r && wet(x, y)) { sx = x; sy = y; break; } }
  if (sx < 0) return null;
  const prev = new Map([[sy * W + sx, -1]]), q = [[sx, sy]];
  for (let h = 0; h < q.length; h++) {
    const [x, y] = q[h], p = ll(x, y);
    if (haversine(p.lat, p.lon, from.lat, from.lon) > maxM) continue;
    if (accept(p)) { const out = []; for (let k = y * W + x; k >= 0; k = prev.get(k)) out.push(ll(k % W, Math.floor(k / W))); out.reverse(); return rdpLL(out, res * 111000 * 0.5); }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) { const nx = x + dx, ny = y + dy, k = ny * W + nx; if (!prev.has(k) && wet(nx, ny)) { prev.set(k, y * W + x); q.push([nx, ny]); } }
  }
  return null;
}
const rdpLL = (pts, tol) => rdp(pts.map((p) => [p.lat, p.lon]), tol).map(([lat, lon]) => ({ lat, lon }));
async function apply() {
  const file = argv[1], dry = argv.includes('--dry');
  const C = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { HARBORS, CHANNELS } = await import(pathToFileURL(path.join(REPO, 'server/harbors.js')).href);
  const { BIG_PORTS, bigPortAt } = await import(pathToFileURL(path.join(REPO, 'server/bigports.js')).href);
  const { World } = await import(pathToFileURL(path.join(REPO, 'server/world.js')).href);
  const { LANE_NODES, landSamples, inDetailRegion } = await import(pathToFileURL(path.join(REPO, 'server/lanes.js')).href);
  const seaNodes = LANE_NODES.filter((n) => n.kind !== 'river');
  process.env.SALTLINE_DATA ||= path.join(REPO, 'data');
  // the raw world raster: Natural Earth + the navigable channels, no harbour carvings (what the roads must be open water on)
  const raw = new World().load(CHANNELS.map((ch) => ({ type: 'channel', pts: ch.pts, widthM: ch.widthM })), () => {});
  const depth = (p) => raw.depthAt(p.lat, p.lon);
  const big = new Set(BIG_PORTS.map((p) => p.harbor));
  const out = {}, report = [];
  for (const h of HARBORS) {
    const prev = h.prev || { lat: h.lat, lon: h.lon };
    const c = C[h.id];
    const keep = (why) => { out[h.id] = { kept: why, ...(c && !c.fail ? { found: c.a, conf: c.c } : {}) }; report.push({ id: h.id, name: h.name, movedM: 0, kept: why }); };
    if (KEEP[h.id]) { keep(KEEP[h.id]); continue; }
    if (big.has(h.id)) { keep(KEEP_BIG); continue; }
    if (!c || c.fail) { keep(`no port evidence in the detail tiles (${c?.fail || 'not analysed'})`); continue; }
    if (c.c === 'low') { keep(`low confidence (${c.e[0]} m quays within 1 km)`); continue; }
    const A = { lat: c.a[0], lon: c.a[1] };
    if (bigPortAt(A.lat, A.lon) !== bigPortAt(prev.lat, prev.lon)) { keep('the new anchor would fall inside another big port\'s data box'); continue; }
    // roads: open water (≥ 12 m on the raw raster, water 600 m all round) ≥ 1.5 km beyond the entrance, reached from the
    // exit of the way out over raw-raster water: first straight out along the way's heading, else the nearest such water
    // by a breadth-first search over the raster cells (whose path joins the way), else the old position
    const E = c.en ? { lat: c.en[0], lon: c.en[1] } : A, X = c.ex ? { lat: c.ex[0], lon: c.ex[1] } : E;
    const outB = c.ex ? c.ex[2] : bearing(A.lat, A.lon, X.lat, X.lon);
    const open = (p, need = 12) => depth(p) >= need && [0, 45, 90, 135, 180, 225, 270, 315].every((b) => depth(destination(p.lat, p.lon, b, 600)) > 2);
    const farEnough = (p) => haversine(p.lat, p.lon, E.lat, E.lon) >= 1500;
    // the roads must also reach the sea lanes in a straight line (lanes.js links harbours that way, 3 km slack)
    const lanesOk = (p) => {
      const maxD = inDetailRegion(p.lat, p.lon) ? 250000 : 1500000;
      const cand = seaNodes.map((n) => ({ n, d: haversine(p.lat, p.lon, n.lat, n.lon) })).sort((a, b) => a.d - b.d).slice(0, 6);
      return cand.some(({ n, d }) => d <= maxD && landSamples(raw, p, n, 3000) === 0);
    };
    const cands = [];
    for (let d = 0; d <= 8000; d += 250) {
      const p = destination(X.lat, X.lon, outB, d);
      if (d > 2000 && !(depth(p) > 0)) break;              // the straight run must stay on water past the coarse coast
      if (farEnough(p) && open(p)) { cands.push({ p, how: 'straight out', link: [] }); break; }
    }
    { const r = rasterPath(raw, X, (p) => farEnough(p) && open(p) && lanesOk(p), 40000); if (r) cands.push({ p: r.at(-1), how: 'raster path', link: r.slice(0, -1) }); }
    if (depth(prev) > 2) {   // the old point (open water by construction for the world harbours; river ports: in the river)
      const cell = raw.layerFor(prev.lat, prev.lon).res * 111000;
      const r = rasterPath(raw, X, (p) => haversine(p.lat, p.lon, prev.lat, prev.lon) <= cell, 40000);
      cands.push({ p: prev, how: 'old position', link: r ? r.slice(0, -1) : [] });
    }
    const pick = cands.find((x) => lanesOk(x.p)) || cands[cands.length - 1];
    if (!pick) { keep('no open water for the roads within 40 km of the way out'); continue; }
    const roads = pick.p, how = pick.how + (lanesOk(pick.p) ? '' : ' (no clean lane link)'), link = pick.link;
    const R = { lat: r5(roads.lat), lon: r5(roads.lon) };
    const way = (c.w || []).slice(1).map((p) => [p[0], p[1]]);
    for (const p of link) if (haversine(p.lat, p.lon, X.lat, X.lon) > 300) way.push([r5(p.lat), r5(p.lon)]);
    way.push([R.lat, R.lon]);
    const movedM = Math.round(haversine(prev.lat, prev.lon, A.lat, A.lon));
    out[h.id] = {
      prev: [prev.lat, prev.lon], approach: c.ap, entrance: c.en ? [c.en[0], c.en[1]] : null, roads: [R.lat, R.lon], way,
      area: [Math.min(c.bb[0], A.lat, E.lat), Math.min(c.bb[1], A.lon, E.lon), Math.max(c.bb[2], A.lat, E.lat), Math.max(c.bb[3], A.lon, E.lon)].map(r5), hull: c.hl, conf: c.c, movedM,
      ev: { quayM: c.e[0], dockHa: c.e[1], cranes: c.e[2], nearestQuayM: c.e[3], depthM: c.e[4], clearM: c.e[5], dock: !!c.e[6], wayMinDepthM: c.e[7], roads: how },
      anchor: [A.lat, A.lon],
    };
    report.push({ id: h.id, name: h.name, movedM, conf: c.c, from: prev, to: A, roads: how });
  }
  // the positions table (the anchor itself lives in HARBORS lat/lon)
  const anchorOf = new Map();
  for (const [id, a] of Object.entries(out)) if (a.anchor) { anchorOf.set(id, a.anchor); delete a.anchor; }
  const lines = Object.entries(out).map(([id, a]) => `  ${id}: ${JSON.stringify(a)},`);
  const head = `// Harbour positions from the harbour position audit — GENERATED by scripts/audit-harbours.mjs apply (${new Date().toISOString().slice(0, 10)}).
// Do not edit by hand; re-run the audit. Data: world detail tiles (OpenFreeMap z14 / OpenStreetMap contributors, converted by
// server/wtconvert.js) and the AIS port gazetteer (server/ais/ports.js). Merged into HARBORS by server/harbors.js.
//
// Per harbour id: anchor [lat, lon] (= HARBORS lat/lon: berth-able water in the main commercial basin next to real
// quays), prev (the position before the audit), approach [lat, lon, inbound heading] ~400 m outside the entrance,
// entrance [lat, lon], roads [lat, lon] (outer anchorage on open water), way [[lat, lon]] (the water path anchor → … →
// roads, simplified), area [latMin, lonMin, latMax, lonMax] + hull (port area), conf (high | medium), movedM, ev (the
// evidence: quay metres within 1 km, dock hectares within 1 km, cranes within 2 km, nearest quay, depth and clearance of
// the anchor in the detail-tile model, …). kept: why the harbour was left where it was (found: the anchor the analysis
// proposed, for review).
export const HARBOR_POSITIONS = {
${lines.join('\n')}
};
`;
  // HARBORS lat/lon (ids, names, everything else unchanged)
  const edits = [];
  for (const f of ['server/harbors.js', 'server/harbors-world.js']) {
    const p = path.join(REPO, f);
    let src = fs.readFileSync(p, 'utf8'), n = 0;
    src = src.replace(/(\{ id: '([a-z0-9_]+)'[^\n]*?size: '[a-z]+'[^\n]*)/g, (line, _l, id) => {
      const a = anchorOf.get(id); if (!a) return line;
      const m = /lat: (-?[\d.]+), lon: (-?[\d.]+)/.exec(line); if (!m) return line;
      n++; return line.replace(m[0], `lat: ${a[0]}, lon: ${a[1]}`);
    });
    edits.push([p, src, n]);
  }
  const posFile = path.join(REPO, 'server/harbor-positions.js');
  report.sort((a, b) => b.movedM - a.movedM);
  const moved = report.filter((r) => !r.kept), kept = report.filter((r) => r.kept);
  console.log(`${moved.length} harbours positioned (${moved.filter((r) => r.movedM > 1000).length} moved > 1 km), ${kept.length} kept`);
  for (const r of moved.slice(0, 40)) console.log(`  ${r.id.padEnd(20)} ${String(r.movedM).padStart(6)} m  ${r.conf.padEnd(6)} ${r.from.lat},${r.from.lon} → ${r.to.lat},${r.to.lon}  roads: ${r.roads}`);
  for (const r of kept) console.log(`  kept ${r.id}: ${r.kept}`);
  if (dry) return;
  fs.writeFileSync(posFile, head);
  for (const [p, src, n] of edits) { fs.writeFileSync(p, src); console.log(`${path.relative(REPO, p)}: ${n} positions`); }
  fs.writeFileSync(path.join(WORK, 'audit-report.json'), JSON.stringify(report, null, 1));
}

// ------------------------------------------------------------------------------------------------ main
if (cmd === 'seeds') await seeds();
else if (cmd === 'analyse') analyseAll();
else if (cmd === 'fetch') await fetchTiles();
else if (cmd === 'compact') compact();
else if (cmd === 'apply') await apply();
else console.log('usage: audit-harbours.mjs seeds|analyse|fetch|compact|apply … (see the header)');
