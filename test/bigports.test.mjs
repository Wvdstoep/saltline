// V7 step 0 "big ports": real OSM waterways and docks carved into the world raster, several harbour patches per port.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { World } from '../server/world.js';
import { carvingsForWorld, CHANNELS, HARBORS, harborById } from '../server/harbors.js';
import * as bp from '../server/bigports.js';
import { depthLW } from '../server/searoute.js';
import { PATCH, GEO } from '../shared/constants.js';
import { haversine } from '../shared/geo.js';

const world = new World().load(carvingsForWorld(), () => {});
const BIG = ['antwerp', 'rotterdam', 'hamburg', 'amsterdam', 'bremerhaven', 'le_havre', 'zeebrugge', 'gothenburg', 'felixstowe'];
const port = (id) => bp.bigPortById(id);
const QUAYS = JSON.parse(fs.readFileSync(new URL('./fixtures/bigports-quays.json', import.meta.url), 'utf8')).points;

test('big-port data: every port ships compact OSM water (< 2 MB a file) and decodes', () => {
  for (const id of BIG) {
    const p = port(id);
    assert.ok(p, id);
    assert.ok(fs.statSync(new URL(`../server/bigports/${id}.json`, import.meta.url)).size < 2e6, `${id} file size`);
    assert.ok(p.water.length > 0 && p.coast.length > 0, `${id} has water and coast`);
    for (const w of p.water) for (const r of w.rings) for (const q of r) assert.ok(q[0] >= p.bbox.latMin - 0.03 && q[0] <= p.bbox.latMax + 0.03 && q[1] >= p.bbox.lonMin - 0.05 && q[1] <= p.bbox.lonMax + 0.05, `${id}: decoded point in the box`);
  }
  assert.deepEqual(bp.decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@'), [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
});

test('the raster cache key follows the port data: a changed port file gives a new carving hash', () => {
  const c = carvingsForWorld().filter((k) => k.type === 'port');
  assert.deepEqual(c.map((k) => k.id).sort(), BIG.filter((id) => port(id).raster).sort());
  for (const k of c) assert.equal(k.hash, port(k.id).hash);
});

test('fairways and docks are water deep enough at low water: the lane chains through the ports, the Scheldt, Deurganckdok', () => {
  // every 100 m along the navigable chains inside the big ports (Westerschelde → Antwerp, Elbe → Hamburg): ≥ 7.5 m at LW
  for (const id of ['westerschelde', 'elbe']) {
    const ch = CHANNELS.find((c) => c.id === id);
    for (let i = 0; i + 1 < ch.pts.length; i++) {
      const a = ch.pts[i], b = ch.pts[i + 1], n = Math.ceil(haversine(a[0], a[1], b[0], b[1]) / 100);
      for (let k = 0; k <= n; k++) {
        const la = a[0] + ((b[0] - a[0]) * k) / n, lo = a[1] + ((b[1] - a[1]) * k) / n;
        assert.ok(depthLW(world, la, lo) >= 7.5, `${id} leg ${i}: ${depthLW(world, la, lo).toFixed(1)} m at ${la.toFixed(4)}, ${lo.toFixed(4)}`);
      }
    }
  }
  const wet = [['antwerp', 51.3045, 4.2756, 'Scheldt at Liefkenshoek'], ['antwerp', 51.292, 4.261, 'Deurganckdok'], ['hamburg', 53.54, 9.93, 'Hamburg harbour'],
    ['bremerhaven', 53.56, 8.55, 'Weser off Bremerhaven'], ['felixstowe', 51.945, 1.30, 'Orwell / Stour']];
  for (const [id, la, lo, name] of wet) {
    assert.ok(bp.portWaterKind(port(id), la, lo) > 0, `${name}: OSM water`);
    assert.ok(depthLW(world, la, lo) >= 8, `${name}: ${depthLW(world, la, lo).toFixed(1)} m at LW`);
  }
});

test('port land is land: terminals and polders the old raster and basin circles got wrong', () => {
  const dry = [['antwerp', 51.27, 4.20, 'Waaslandhaven terminals'], ['antwerp', 51.28, 4.30, 'Kallo'], ['antwerp', 51.31, 4.33, 'right bank docklands'],
    ['hamburg', 53.53, 9.93, 'Waltershof'], ['amsterdam', 52.44, 4.65, 'Velsen-Noord'], ['hamburg', 53.70, 9.45, 'Elbe marsh at Glückstadt']];
  for (const [id, la, lo, name] of dry) {
    assert.equal(bp.portWaterKind(port(id), la, lo), bp.KIND.LAND, `${name}: OSM land`);
    assert.ok(!world.isWater(la, lo), `${name}: raster land (${world.heightAt(la, lo).toFixed(1)} m)`);
  }
  // the old 2.6 km basin circle round the Antwerp point is gone: its rim is land again
  assert.ok(!world.isWater(51.29 - 0.018, 4.27), 'south rim of the old Antwerp basin circle');
});

test('ships moored at real quays (OSM quays, a live AIS report) lie on the water\'s edge of the port model', () => {
  for (const q of QUAYS) {
    const d = bp.distanceToEdgeM(port(q.port), q.lat, q.lon, 400);
    assert.ok(d <= (q.kind === 'ais' ? 100 : 60), `${q.name}: ${Math.round(d)} m from the water's edge`);
  }
});

test('every harbour inside a big port is open water on the raster and on OSM water within 2 km', () => {
  for (const h of HARBORS) {
    const p = bp.bigPortAt(h.lat, h.lon); if (!p) continue;
    assert.ok(world.depthAt(h.lat, h.lon) >= 9, `${h.id}: raster ${world.depthAt(h.lat, h.lon).toFixed(1)} m`);
    assert.ok(bp.distanceToEdgeM(p, h.lat, h.lon, 2000) < 2000, `${h.id}: OSM water nearby`);
  }
  // Antwerp's point lies in Deurganckdok (it was on the Doel polder)
  assert.ok(bp.portWaterKind(port('antwerp'), harborById('antwerp').lat, harborById('antwerp').lon) > 0);
});

test('extra harbour patches tile the big ports edge to edge around the harbour patch', () => {
  const P = PATCH.N * PATCH.RES;
  const ant = harborById('antwerp'), subs = bp.subPatchesFor(ant);
  assert.ok(subs.length >= 8 && subs.length <= port('antwerp').maxPatches, `antwerp: ${subs.length} patches`);
  for (const s of subs) {
    assert.match(s.id, /^antwerp_t\d{4}$/); assert.ok(s.sub && s.parent === 'antwerp');
    const dz = (ant.lat - s.lat) * GEO.M_PER_DEG_LAT / P;
    assert.ok(Math.abs(dz - Math.round(dz)) < 0.01, `${s.id} on the row grid`);
    assert.ok(haversine(ant.lat, ant.lon, s.lat, s.lon) >= P * 0.99, `${s.id} does not overlap the harbour patch`);
  }
  // the terminals around Deurganckdok / Liefkenshoek and the city docks are covered by some patch
  const all = [ant, ...subs];
  const covered = (la, lo) => all.some((s) => Math.abs(la - s.lat) * GEO.M_PER_DEG_LAT <= P / 2 && Math.abs(lo - s.lon) * GEO.M_PER_DEG_LON_EQ * Math.cos(s.lat * Math.PI / 180) <= P / 2);
  for (const [la, lo] of [[51.292, 4.261], [51.3045, 4.2756], [51.265, 4.22], [51.35, 4.29], [51.24347, 4.4155]]) assert.ok(covered(la, lo), `${la}, ${lo} covered`);
  for (const id of BIG) assert.ok(bp.subPatchesFor(harborById(port(id).harbor)).length >= 1, `${id} has extra patches`);
  const wire = bp.allSubPatches(HARBORS);
  assert.ok(wire.every((s) => /^[a-z0-9_]{1,40}$/.test(s.id)), 'ids pass the server route check');
  assert.equal(bp.subPatchById(subs[0].id, HARBORS), subs[0]);
});

test('harbour patches in a big port: built from the port water offline, real water and quay walls, no invented harbour', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'saltline-bigports-'));
  const hg = await import('../server/harborgeom.js');
  hg.configure({ dataDir: tmp, offline: true, preload: false, log: () => {} });
  hg.init(world);
  try {
    const g = await hg.ensureHarbor('antwerp');
    assert.equal(g.source, 'osm'); assert.equal(g.bigport, bp.geomStamp(port('antwerp')));
    assert.equal(hg.maskAt('antwerp', 51.292, 4.261) === 1, false, 'Deurganckdok is water in the patch');
    assert.ok(g.berths.length >= 2, `${g.berths.length} berths on the dock walls`);
    const sub = bp.subPatchesFor(harborById('antwerp'))[0];
    const sg = await hg.ensureHarbor(sub.id);
    assert.ok(sg && sg.sub && sg.parent === 'antwerp', 'an extra patch builds');
    assert.equal(sg.features.pois.length, 0, 'no town on an extra patch');
    assert.ok(hg.getHarborPatch(sub.id), 'served as a patch');
    // an extra patch with no data around is never invented
    assert.equal(await hg.ensureHarbor('antwerp_t9999'), null);
    // a cache built without the current port data is rebuilt
    const meta = JSON.parse(fs.readFileSync(path.join(tmp, 'geom', 'antwerp.json'), 'utf8'));
    meta.geom.bigport = 'antwerp:old:0'; fs.writeFileSync(path.join(tmp, 'geom', 'antwerp.json'), JSON.stringify(meta));
    hg.resetCache();
    hg.configure({ offline: false, fetchImpl: async () => { throw new Error('no network in the test'); } });   // a rebuild is possible
    const again = await hg.ensureHarbor('antwerp');
    assert.equal(again.bigport, bp.geomStamp(port('antwerp')));
  } finally { hg.configure({ offline: true, fetchImpl: null }); hg.resetCache(); fs.rmSync(tmp, { recursive: true, force: true }); }
});

// Review: Rotterdam's patch cap (nearest tiles first from the Maasvlakte point) left Waalhaven / Eemhaven / Maashaven
// without 3D quays. Every dock / basin of a port's core must lie on some harbour patch.
test('the harbour patches of every big port cover the docks of its core (Waalhaven, Eemhaven, city docks …)', () => {
  const P = PATCH.N * PATCH.RES;
  for (const id of BIG) {
    const p = port(id), h = harborById(p.harbor), g = bp.portGrid(p), c = p.core;
    const all = [h, ...bp.subPatchesFor(h), ...HARBORS.filter((x) => x !== h && bp.bigPortAt(x.lat, x.lon) === p)];
    const on = (la, lo) => all.some((s) => Math.abs(la - s.lat) * GEO.M_PER_DEG_LAT <= P / 2 && Math.abs(lo - s.lon) * GEO.M_PER_DEG_LON_EQ * Math.cos(s.lat * Math.PI / 180) <= P / 2);
    let dock = 0, cov = 0;
    for (let r = 0; r < g.h; r += 3) for (let k = 0; k < g.w; k += 3) {
      if (g.kind[r * g.w + k] !== bp.KIND.DOCK) continue;
      const la = g.latMax - (r + 0.5) * g.dLat, lo = g.lonMin + (k + 0.5) * g.dLon;
      if (la < c.latMin || la > c.latMax || lo < c.lonMin || lo > c.lonMax) continue;
      dock++; if (on(la, lo)) cov++;
    }
    assert.ok(!dock || cov >= 0.97 * dock, `${id}: ${cov}/${dock} dock samples on a harbour patch`);
  }
  for (const [la, lo, name] of [[51.885, 4.43, 'Waalhaven'], [51.89, 4.40, 'Eemhaven'], [51.90, 4.49, 'Maashaven'], [51.875, 4.31, 'Botlek']]) {
    const r = harborById('rotterdam'), subs = bp.subPatchesFor(r);
    assert.ok([r, ...subs].some((s) => Math.abs(la - s.lat) * GEO.M_PER_DEG_LAT <= P / 2 && Math.abs(lo - s.lon) * GEO.M_PER_DEG_LON_EQ * Math.cos(s.lat * Math.PI / 180) <= P / 2), `${name} on a Rotterdam patch`);
  }
});
