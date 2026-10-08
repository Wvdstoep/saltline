// Recorded real-data fixtures (docs/WORLD-DETAIL-STREAMING.md §5.2): OpenFreeMap z14 tiles (pinned 20261004_113936_pt,
// slimmed to the layers the converter reads), Terrarium z9 depth and Overpass z12 overlays recorded on production by
// scripts/record-wt-fixtures.mjs, converted here by server/wtconvert.js with the real hints (server/worldtiles.js
// hintsFor). Sample points on 6 continents, the big-port oracle, the overlay on real data, and moored AIS at quays when
// test/fixtures/wt/moored.json has been recorded (scripts/record-moored-fixture.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadPoints, loadPortFixture, samplePoint, FIXTURE_DIR } from './fixtures/wt/lib.mjs';
import { bigPortById, portWaterKind } from '../server/bigports.js';
import { WT, WT_NAVIGABLE, WT_OBSTACLE, tileFToLatLon, tileSizeM, cellOf } from '../shared/wtformat.js';
import { haversine } from '../shared/geo.js';

const { ports, pin } = loadPoints();
const cache = new Map();
const fixtureOf = (p, opts = {}) => { const k = `${p.id}:${opts.guard !== false}`; if (!cache.has(k)) cache.set(k, loadPortFixture(FIXTURE_DIR, p, opts)); return cache.get(k); };
let seed = 20261008;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

test('the fixtures are pinned, recorded for 13 ports on 6 continents, and small', () => {
  assert.equal(pin, '20261004_113936_pt');
  assert.equal(ports.length, 13);
  assert.ok(new Set(ports.map((p) => p.cont)).size >= 6);
  let bytes = 0;
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else bytes += fs.statSync(f).size; } };
  walk(FIXTURE_DIR);
  assert.ok(bytes < 4 * 1024 * 1024, `fixtures ${bytes} B ≤ 4 MB`);
});

test('sample points: every water point navigable and deep enough at MLW, every terminal yard an obstacle (≥ 12 ports, ≥ 5 continents)', () => {
  const passed = new Set(), conts = new Set(), lines = [];
  for (const p of ports) {
    const fx = fixtureOf(p);
    let ok = true;
    for (const [lat, lon, need] of p.water) {
      const s = samplePoint(fx, lat, lon);
      assert.ok(s, `${p.id} ${lat},${lon}: tile recorded`);
      const good = WT_NAVIGABLE[s.mask] === 1 && -s.h >= need;
      lines.push(`${p.id} water ${lat},${lon} mask ${s.mask} depth ${(-s.h).toFixed(1)} ≥ ${need} ${good ? 'ok' : 'FAIL'}`);
      ok &&= good;
    }
    for (const [lat, lon] of p.land) {
      const s = samplePoint(fx, lat, lon);
      const good = !!s && WT_OBSTACLE[s.mask] === 1;
      lines.push(`${p.id} land ${lat},${lon} mask ${s?.mask} ${good ? 'ok' : 'FAIL'}`);
      ok &&= good;
    }
    // corrected points (§5.2) stay close to the design's coordinates
    for (const [k, list] of [['water', p.water], ['land', p.land]]) list.forEach(([lat, lon], i) => {
      const o = p.orig?.[k]?.[i]; if (o) assert.ok(haversine(lat, lon, o[0], o[1]) <= 1500, `${p.id} ${k} point moved ${Math.round(haversine(lat, lon, o[0], o[1]))} m`);
    });
    if (ok) { passed.add(p.id); conts.add(p.cont); }
  }
  assert.equal(passed.size, ports.length, lines.filter((l) => l.endsWith('FAIL')).join('\n'));
  assert.ok(passed.size >= 12 && conts.size >= 5);
});

test('big-port oracle: D14 without the guard agrees with portWaterKind on ≥ 93 % of 5 000 random points; fairways stay navigable', () => {
  for (const id of ['rotterdam', 'antwerp', 'hamburg', 'gothenburg']) {
    const p = ports.find((q) => q.id === id), bp = bigPortById(id);
    const raw = fixtureOf(p, { guard: false }), served = fixtureOf(p);
    const keys = [...raw.tiles.keys()];
    let n = 0, agree = 0;
    for (let k = 0; k < 40000 && n < 5000; k++) {
      const [x, y] = keys[Math.floor(rnd() * keys.length)].split('/').map(Number);
      const ll = tileFToLatLon(14, x + rnd(), y + rnd()), c = bp.core;
      if (ll.lat < c.latMin || ll.lat > c.latMax || ll.lon < c.lonMin || ll.lon > c.lonMax) continue;
      const kind = portWaterKind(bp, ll.lat, ll.lon); if (kind < 0) continue;
      n++;
      if ((WT_NAVIGABLE[samplePoint(raw, ll.lat, ll.lon).mask] === 1) === kind > 0) agree++;
    }
    assert.ok(n >= 1000, `${id}: ${n} points inside the core box and the recorded tiles`);
    assert.ok(agree / n >= 0.93, `${id}: ${(100 * agree / n).toFixed(1)} % agreement`);
    // every fairway / river centreline point (every 50 m) inside the recorded tiles is navigable in the served tiles
    for (const l of bp.lines) {
      if (l.k !== 'fairway') continue;
      for (let i = 0; i + 1 < l.pts.length; i++) {
        const [a, b] = [l.pts[i], l.pts[i + 1]], L = haversine(a[0], a[1], b[0], b[1]);
        for (let t = 0; t <= L; t += 50) {
          const lat = a[0] + ((b[0] - a[0]) * t) / Math.max(1, L), lon = a[1] + ((b[1] - a[1]) * t) / Math.max(1, L);
          const s = samplePoint(served, lat, lon); if (!s) continue;
          assert.equal(WT_NAVIGABLE[s.mask], 1, `${id} fairway ${lat.toFixed(5)},${lon.toFixed(5)}`);
        }
      }
    }
  }
});

test('real data: quays, piers, bridges, buildings and the z12 overlay (cranes, lights, OSM quays) come through', () => {
  const sum = (id) => {
    const v = { osm: 0, derived: 0, cranes: 0, lights: 0, buildings: 0, bridges: 0, piers: 0, overlay: 0, est: 0 };
    for (const t of fixtureOf(ports.find((p) => p.id === id)).tiles.values()) {
      if (t.flags & WT.FLAG.OVERLAY) { v.overlay++; assert.equal(t.rev, 1); }
      const q = t.vectors; if (!q) continue;
      for (const x of q.quays) v[x.k]++;
      v.cranes += q.cranes.length; v.lights += q.lights.length; v.buildings += q.buildings.length; v.bridges += q.bridges.length; v.piers += q.piers.length;
      v.est += q.buildings.filter((b) => b.e === 1).length;
      assert.equal(q.src, `ofm:${pin}`);
    }
    return v;
  };
  const r = sum('rotterdam'), h = sum('hamburg'), ny = sum('new_york');
  assert.ok(r.overlay > 0 && r.osm > 0 && r.cranes > 0 && r.lights > 0, JSON.stringify(r));
  assert.ok(r.derived > 50 && r.piers > 0 && r.bridges > 0 && r.buildings > 100 && r.est > 0, JSON.stringify(r));
  assert.ok(h.overlay > 0 && h.cranes > 0 && h.osm > 0, JSON.stringify(h));
  assert.ok(ny.overlay > 0 && ny.lights > 0 && ny.derived > 0, JSON.stringify(ny));
  // STS cranes stand on land near the water
  const rot = fixtureOf(ports.find((p) => p.id === 'rotterdam'));
  let sts = 0;
  for (const t of rot.tiles.values()) for (const c of t.vectors?.cranes || []) if (c.k === 'sts') sts++;
  assert.ok(sts > 0, 'container gantries in Rotterdam');
});

test('conversion cost of the recorded tiles (informational; the ≤ 150 ms target is checked on the production box)', () => {
  const all = [];
  for (const p of ports) all.push(...fixtureOf(p).ms);
  all.sort((a, b) => a - b);
  const med = all[all.length >> 1], max = all.at(-1);
  console.log(`# converted ${all.length} real tiles: median ${med.toFixed(0)} ms, max ${max.toFixed(0)} ms (shared CPU)`);
  assert.ok(med < 1000);
});

const MOORED = path.join(FIXTURE_DIR, 'moored.json');
test('moored AIS at quays: ≥ 85 % within 25 m of a quay edge, ≤ 3 % with the hull centre on an obstacle (per port and overall)', { skip: !fs.existsSync(MOORED) && 'test/fixtures/wt/moored.json not recorded (scripts/record-moored-fixture.mjs needs the live AIS store)' }, () => {
  const { vessels } = JSON.parse(fs.readFileSync(MOORED, 'utf8'));
  const per = new Map();
  for (const v of vessels) {
    const p = ports.find((q) => q.id === v.port); if (!p) continue;
    const fx = fixtureOf(p), c = cellOf(14, v.lat, v.lon), t = fx.tiles.get(`${c.x}/${c.y}`); if (!t) continue;
    const st = per.get(v.port) || { n: 0, near: 0, onObstacle: 0 }; per.set(v.port, st);
    st.n++;
    const s = samplePoint(fx, v.lat, v.lon);
    if (WT_OBSTACLE[s.mask]) st.onObstacle++;
    if (distanceToQuay(fx, v) <= 25) st.near++;
  }
  const tot = { n: 0, near: 0, onObstacle: 0 };
  for (const [port, st] of per) {
    for (const k of Object.keys(tot)) tot[k] += st[k];
    console.log(`# ${port}: ${st.n} moored, ${(100 * st.near / st.n).toFixed(0)} % within 25 m of a quay, ${(100 * st.onObstacle / st.n).toFixed(0)} % on an obstacle`);
    if (st.n >= 5) { assert.ok(st.near / st.n >= 0.85, port); assert.ok(st.onObstacle / st.n <= 0.03, port); }
  }
  assert.ok(tot.n > 0 && tot.near / tot.n >= 0.85 && tot.onObstacle / tot.n <= 0.03, JSON.stringify(tot));
});

/** Distance (m) from the nearest long side of a moored hull (A/B/C/D) to the nearest quay edge of its tile. */
function distanceToQuay(fx, v) {
  const c = cellOf(14, v.lat, v.lon), t = fx.tiles.get(`${c.x}/${c.y}`), sizeM = tileSizeM(14, v.lat);
  const px = (c.u / 256) * sizeM, pz = (c.v / 256) * sizeM, h = ((v.hdg ?? 0) * Math.PI) / 180;
  const fwd = [Math.sin(h), -Math.cos(h)], stb = [Math.cos(h), Math.sin(h)];
  const L = (v.A ?? 50) + (v.B ?? 50), off = ((v.A ?? 50) - (v.B ?? 50)) / 2;
  const sides = [-(v.C ?? 8), v.D ?? 8].map((o) => { const cx = px + fwd[0] * off + stb[0] * o, cz = pz + fwd[1] * off + stb[1] * o; return [cx - fwd[0] * L / 2, cz - fwd[1] * L / 2, cx + fwd[0] * L / 2, cz + fwd[1] * L / 2]; });
  let best = Infinity;
  for (const q of t.vectors?.quays || []) for (let i = 0; i + 3 < q.p.length; i += 2) {
    const a = [q.p[i] / 10, q.p[i + 1] / 10], b = [q.p[i + 2] / 10, q.p[i + 3] / 10];
    for (const s of sides) best = Math.min(best, segDist(s, a, b));
  }
  return best;
}
function segDist(s, a, b) {
  const pts = [[s[0], s[1]], [s[2], s[3]]], d = (p, u, w) => { const dx = w[0] - u[0], dz = w[1] - u[1], L2 = dx * dx + dz * dz || 1, t = Math.max(0, Math.min(1, ((p[0] - u[0]) * dx + (p[1] - u[1]) * dz) / L2)); return Math.hypot(u[0] + t * dx - p[0], u[1] + t * dz - p[1]); };
  return Math.min(d(pts[0], a, b), d(pts[1], a, b), d(a, pts[0], pts[1]), d(b, pts[0], pts[1]));
}
