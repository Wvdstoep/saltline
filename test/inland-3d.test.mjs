// Inland harbours in 3D / on the radar and chart (player report "inland harbours show no docks"): the geometry rules of
// shared/mhgeo.js and the mesh builder public/js/mhgeom.js, on the recorded Rotterdam fixtures (overlays + z14 tiles)
// and the synthetic FIS harbour fixture. Exact where the fixtures make it deterministic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { harboursFromOverlay, berthsOf, harbourCard } from '../shared/mharbour.js';
import { MHG, waterGrid, gridAt, synthPontoons, synthNeeds, sideMask, hutSpot, geoRecord, layoutOf, segmentsOf, structureAt, rectWater } from '../shared/mhgeo.js';
import { buildMinorHarbour, planMhLod, estTris, MHLOD } from '../public/js/mhgeom.js';
import { drawSegments } from '../public/js/radarmap.js';
import { createMinorHarbours } from '../server/minorharbours.js';
import { HARBORS } from '../server/harbors.js';
import { makeSampler } from '../server/quays.js';
import { loadPoints, loadPortFixture, FIXTURE_DIR } from './fixtures/wt/lib.mjs';

const ov = (port, x, y) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(FIXTURE_DIR, port, `ov-12-${x}-${y}.json.gz`))).toString('utf8'));
const fis = JSON.parse(fs.readFileSync(new URL('./fixtures/mh/fis-harbours.json', import.meta.url)));
let SAMPLE = null;
const sample = () => {
  if (SAMPLE) return SAMPLE;
  const { ports } = loadPoints();
  const fx = loadPortFixture(FIXTURE_DIR, ports.find((p) => p.id === 'rotterdam'));
  return (SAMPLE = makeSampler((z, x, y) => fx.tiles.get(`${x}/${y}`) || null));
};
const NAVS = new Set([0, 5, 6, 7, 8, 9]);
const onWater = (S, la, lo) => { const s = S(la, lo); return !!s && NAVS.has(s.mask); };
const square = () => harboursFromOverlay(ov('rotterdam', 2095, 1354), { x12: 2095, y12: 1354, named: HARBORS, fis: fis.harbours });

test('boxes on one side only: the 6th pontoon field (berthsOf), counts and ids stay stable', () => {
  const h = { id: 'mh:t:1', tier: 'marina', places: null, pont: [[52, 4, 52, 4.0015, 103]] };
  const both = berthsOf(h), right = berthsOf({ ...h, pont: [[52, 4, 52, 4.0015, 103, 1]] }), left = berthsOf({ ...h, pont: [[52, 4, 52, 4.0015, 103, -1]] });
  assert.equal(both.total, right.total * 2);
  assert.equal(right.total, left.total);
  assert.ok(right.list.every((b) => /#0r\d+$/.test(b.id)) && left.list.every((b) => /#0l\d+$/.test(b.id)));
  assert.deepEqual(right.list.map((b) => b.id), both.list.filter((b) => b.id.includes('r')).map((b) => b.id));
});

test('FIS-only marina (no pontoons in OSM): pontoons laid on the water from the tiles, every box on water, out of the fairway', () => {
  const S = sample(), h = square().find((x) => x.id === 'mh:fis:9002');
  assert.deepEqual([h.tier, h.pont.length, h.places], ['marina', 0, 85]);
  const need = synthNeeds(h);
  assert.deepEqual([need.count, need.L, need.zone, need.twoSided], [2, 85, 16, true]);
  const G = waterGrid(S, h.lat, h.lon);
  assert.equal(G.known, 1);
  const sy = synthPontoons(h, G);
  assert.equal(sy.synth, true);
  assert.equal(sy.pont.length, 2);
  assert.ok(sy.gang.length >= 1, 'a gangway to the bank');
  // deterministic: the same tiles give the same layout
  assert.deepEqual(synthPontoons(h, waterGrid(S, h.lat, h.lon)), sy);
  const geo = geoRecord(h, { ...sy, hut: hutSpot(G, sy.pont.map((p) => [p[0], p[1]])) });
  const lay = layoutOf(geo);
  assert.equal(lay.berths.kind, 'box');
  assert.ok(lay.berths.total >= 70 && lay.berths.total <= 100, `boxes ${lay.berths.total}`);
  for (const b of lay.boxes) for (const c of b.c) assert.ok(onWater(S, c[0], c[1]), `box ${b.no} corner on water`);
  for (const p of sy.pont) for (let t = 0; t <= 1; t += 0.1) { const s = S(p[0] + (p[2] - p[0]) * t, p[1] + (p[3] - p[1]) * t); assert.ok(s && s.mask !== 5 && NAVS.has(s.mask), 'deck on water, not in a fairway'); }
  // the hut stands on land, the fuel berth (FIS fuel: yes) at a pontoon end away from the gangway
  assert.ok(geo.hut && !onWater(S, geo.hut.lat, geo.hut.lon));
  assert.ok(geo.fuel);
  const ends = sy.pont.flatMap((p) => [[p[0], p[1]], [p[2], p[3]]]);
  assert.ok(ends.some((e) => e[0] === geo.fuel.lat && e[1] === geo.fuel.lon));
  assert.ok(!sy.gang.some((g) => g[0] === geo.fuel.lat && g[1] === geo.fuel.lon));
  // finger piers between box pairs, piles at the box posts
  assert.ok(lay.fingers.length >= lay.boxes.length / 2 && lay.fingers.length <= lay.boxes.length / 2 + 8);
  assert.ok(lay.piles.length >= lay.boxes.length);
});

test('synthesis waits for the tiles and says when there is no room', () => {
  const h = square().find((x) => x.id === 'mh:fis:9002');
  assert.deepEqual(synthPontoons(h, waterGrid(() => null, h.lat, h.lon)), { pending: true });
  assert.deepEqual(synthPontoons(h, null), { pending: true });
  const dry = waterGrid(() => ({ mask: 1 }), h.lat, h.lon);
  assert.deepEqual(synthPontoons(h, dry), { none: true });
  assert.deepEqual(synthPontoons({ ...h, tier: 'ferry' }, dry), { none: true });
});

test('OSM pontoons keep their geometry; sides with no room for boxes are dropped (tiles known)', () => {
  const S = sample(), h = square().find((x) => x.id === 'mh:fis:9001');   // passant, 5 OSM pontoons
  const G = waterGrid(S, h.lat, h.lon);
  assert.deepEqual(sideMask(h, G), h.pont);                               // side masks are for marina boxes only
  const m = { ...h, tier: 'marina' }, sm = sideMask(m, G);
  assert.equal(sm.length, h.pont.length);
  sm.forEach((p, k) => assert.deepEqual(p.slice(0, 5), h.pont[k].slice(0, 5)));
  assert.ok(sm.every((p) => p.length === 5 || p[5] === 1 || p[5] === -1));
  assert.deepEqual(sideMask(m, waterGrid(() => null, h.lat, h.lon)), h.pont);   // tiles unknown: unchanged
  // the passant: side berths along the pontoons, hut on the bank
  const geo = geoRecord(h, { hut: hutSpot(G, h.pont.map((p) => [p[0], p[1]])) }), lay = layoutOf(geo);
  assert.equal(lay.berths.kind, 'side');
  assert.equal(lay.sides.length, 5);
  assert.equal(lay.decks.length, 5);
  assert.ok(lay.hut && !onWater(S, lay.hut.lat, lay.hut.lon));
  assert.equal(geo.sign, 'Passantenhaven');
});

test('layout of the recorded Hoek van Holland marina: boxes, fingers, segments, structure lookup', () => {
  const h = harboursFromOverlay(ov('rotterdam', 2094, 1353), { x12: 2094, y12: 1353, named: HARBORS }).find((x) => x.id === 'mh:osm:w1146063942');
  const geo = geoRecord(h), lay = layoutOf(geo);
  assert.equal(lay.boxes.length, 208);
  assert.equal(lay.decks.length, 11);
  const segs = segmentsOf(lay);
  assert.equal(segs.filter((s) => s.k === 'deck').length, 11);
  assert.equal(segs.filter((s) => s.k === 'finger').length, lay.fingers.length);
  // a point on the middle of the first pontoon is a pontoon; one 30 m off the harbour is not
  const d = lay.decks[0], mid = [(d.a[0] + d.b[0]) / 2, (d.a[1] + d.b[1]) / 2];
  assert.equal(structureAt(lay, mid[0], mid[1]), 'pontoon');
  // box outlines: 4 corners, the box centre inside, box size from the berth
  const b = lay.boxes[0];
  assert.equal(b.c.length, 4);
  const w = Math.hypot((b.c[1][1] - b.c[0][1]) * 111320 * Math.cos(b.lat * Math.PI / 180), (b.c[1][0] - b.c[0][0]) * 111320);
  const l = Math.hypot((b.c[2][1] - b.c[1][1]) * 111320 * Math.cos(b.lat * Math.PI / 180), (b.c[2][0] - b.c[1][0]) * 111320);
  assert.ok(Math.abs(w - b.w) < 0.05 && Math.abs(l - b.len) < 0.05, `${w} × ${l} vs ${b.w} × ${b.len}`);
  // the card keeps its numbers (the berth list grew a/b fields only for side berths)
  assert.equal(harbourCard(h, {}).berths.total, 208);
});

test('mesh builder: two meshes, LOD and budget, labels, all numbers finite', () => {
  const h = harboursFromOverlay(ov('rotterdam', 2094, 1353), { x12: 2094, y12: 1353, named: HARBORS }).find((x) => x.id === 'mh:osm:w120922130');
  const geo = geoRecord(h);
  const full = buildMinorHarbour(geo, { lod: MHLOD.FULL }), mid = buildMinorHarbour(geo, { lod: MHLOD.MID });
  assert.ok(full.tris > mid.tris * 3, `${full.tris} vs ${mid.tris}`);
  assert.ok(full.tris < 30000 && mid.tris < 4000);
  for (const m of [full.float, full.fixed, mid.float]) {
    assert.equal(m.pos.length % 3, 0); assert.equal(m.nor.length, m.pos.length); assert.equal(m.col.length, m.pos.length);
    assert.ok(m.pos.every(Number.isFinite) && m.nor.every(Number.isFinite));
    assert.ok(Math.max(...m.idx) < m.pos.length / 3);
  }
  // the floating group is at the water: pontoon decks between −0.35 and +0.5 m
  let y0 = Infinity, y1 = -Infinity; for (let i = 1; i < full.float.pos.length; i += 3) { y0 = Math.min(y0, full.float.pos[i]); y1 = Math.max(y1, full.float.pos[i]); }
  assert.ok(y0 >= -0.36 && y1 <= 2.5, `${y0}…${y1}`);
  assert.deepEqual(full.labels.map((l) => l.kind), ['hut', 'vhf']);
  assert.equal(full.labels[0].text, 'Marina near Rotterdam');
  assert.ok(estTris(geo, MHLOD.FULL) > estTris(geo, MHLOD.MID));
  // LOD plan: nearest first, FULL close, MID further, nothing past rMax or over the harbour count
  const B = MHG.BUDGET.phone;
  const items = [{ dist: 3000 }, { dist: 200 }, { dist: 1000 }, { dist: 99999 }, { dist: 500 }, { dist: 600 }, { dist: 700 }, { dist: 800 }].map((x) => ({ ...x, est: { 1: 1000, 2: 8000 } }));
  const lod = planMhLod(items, B);
  assert.deepEqual(lod, [0, 2, 0, 0, 2, 2, 2, 2]);                     // 5 harbours on a phone: the 1 km one waits
  assert.ok(planMhLod([{ dist: 10, est: { 1: 10, 2: 60000 } }], B)[0] === MHLOD.MID);   // over the triangle budget: MID
});

test('radar vectors: pontoons drawn at real width (≥ 1.2 px), fingers only when wide enough, off-scope skipped', () => {
  const calls = [];
  const ctx = { set strokeStyle(v) { calls.push(['s', v]); }, set lineWidth(v) { calls.push(['w', v]); }, set lineCap(v) {}, beginPath() {}, moveTo(x, y) { calls.push(['m', x, y]); }, lineTo() {}, stroke() { calls.push(['k']); } };
  const me = { lat: 52, lon: 4 };
  const segs = [
    { a: [52.0001, 4], b: [52.0005, 4], w: 2.4, k: 'deck' },
    { a: [52.0001, 4.0001], b: [52.0001, 4.0002], w: 0.7, k: 'finger' },
    { a: [53, 4], b: [53.001, 4], w: 2.4, k: 'deck' },
  ];
  assert.equal(drawSegments(ctx, me, segs, 0.05, 100), 1);                 // 2 km range: the finger is 0.035 px → skipped
  assert.equal(calls.find((c) => c[0] === 'w')[1], 1.2);
  assert.equal(drawSegments(ctx, me, segs, 1, 100), 2);                    // close in: the finger too
});

test('server: geometry on demand near ships — cached, refined once tiles arrive, cleared on shed, memguard critical builds nothing', () => {
  let lv = 0; const shedFns = [];
  const guard = { level: () => lv, onShed: (f) => shedFns.push(f) };
  const mh = createMinorHarbours({ named: HARBORS, fis, guard });
  mh.ingest(2095, 1354, ov('rotterdam', 2095, 1354));
  // no tiles: OSM harbours still get a record (unrefined), FIS-only ones are pending
  assert.equal(mh.geoOf('mh:fis:9002').pending, true);
  assert.equal(mh.geoOf('mh:fis:9001').geo.pont.length, 5);
  mh.setSampler(sample());
  const e = mh.geoOf('mh:fis:9002');
  assert.equal(e.geo.synth, true);
  assert.ok(e.berths.total > 60);
  assert.equal(mh.geoOf('mh:fis:9002'), e);                                 // cached
  const near = mh.geoNear(51.912, 4.19, 3);
  assert.deepEqual(near.map((g) => g.id).sort(), ['mh:fis:9001', 'mh:fis:9002']);
  assert.ok(mh.stats().geo >= 2 && mh.stats().synth === 1);
  shedFns.forEach((f) => f());
  assert.equal(mh.stats().geoCached, 0);
  mh.ingest(2095, 1354, ov('rotterdam', 2095, 1354));
  lv = 4;
  assert.equal(mh.geoOf('mh:fis:9002'), null);                              // critical: nothing new
  lv = 0;
  assert.ok(mh.geoOf('mh:fis:9002').geo);
});

test('grid helpers: rectWater counts lanes over fairways only when asked', () => {
  const G = waterGrid((la, lo) => ({ mask: lo > 4.0001 ? 5 : 0 }), 52, 4, { half: 40 });
  assert.equal(gridAt(G, -20, 0), 1); assert.equal(gridAt(G, 20, 0), 4);
  assert.equal(rectWater(G, [20, 0], [0, 1], 10, -2, 2), 0);
  assert.equal(rectWater(G, [20, 0], [0, 1], 10, -2, 2, { lane: true }), 1);
});
