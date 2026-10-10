// Inland harbours streaming (docs/BRIDGES-LOCKS-VHF-CONTRACT.md §7.2, §10.8.3): per z12 square, LRU ≤ 3,000 harbours,
// memguard warm / shed / critical, chart bbox, radio stations, reachability (stand-in planner on a synthetic graph).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createMinorHarbours, squaresUnder } from '../server/minorharbours.js';
import { tileFToLatLon } from '../shared/wtformat.js';
import { sqOf } from '../shared/mharbour.js';
import { HARBORS } from '../server/harbors.js';

/** A synthetic overlay with n tagged marinas on a grid inside square (x, y). */
function overlayWith(x, y, n = 100) {
  const k = Math.ceil(Math.sqrt(n)), f = [];
  for (let i = 0; i < n; i++) {
    const p = tileFToLatLon(12, x + ((i % k) + 0.5) / k, y + (Math.floor(i / k) + 0.5) / k);
    f.push({ id: `n${x}${y}${String(i).padStart(3, '0')}`, k: null, t: { leisure: 'marina', name: `M ${x}/${y}/${i}` }, g: [Math.round(p.lat * 1e6) / 1e6, Math.round(p.lon * 1e6) / 1e6], c: 0 });
  }
  return { v: 1, x, y, f };
}
const guardAt = (lv) => { const fns = []; return { lv, level() { return this.lv; }, onShed(fn) { fns.push(fn); return this; }, fire() { for (const fn of fns) fn({}); } }; };

test('LRU: 50 squares × 100 harbours stay ≤ 3,000 in memory; shed keeps only the squares under online ships', () => {
  const g = guardAt(0), keep = new Set(['2100/1350', '2149/1350']);
  const mh = createMinorHarbours({ named: [], guard: g, keepSquares: () => keep });
  for (let i = 0; i < 50; i++) {
    assert.equal(mh.ingest(2100 + i, 1350, overlayWith(2100 + i, 1350)), 100);
    assert.ok(mh.size() <= 3000);
  }
  assert.equal(mh.size(), 3000);
  assert.equal(mh.squareCount(), 30);
  assert.equal(mh.hasSquare(2100, 1350), false);         // the oldest went first
  assert.equal(mh.hasSquare(2149, 1350), true);
  assert.equal(mh.stats().evicted, 20);
  // touching a square keeps it: read 2120 then add 2 more → 2120 survives, 2121/2122 go
  mh.harboursIn(2120, 1350);
  mh.ingest(2200, 1350, overlayWith(2200, 1350)); mh.ingest(2201, 1350, overlayWith(2201, 1350));
  assert.equal(mh.hasSquare(2120, 1350), true);
  assert.equal(mh.hasSquare(2121, 1350), false);
  mh.ingest(2100, 1350, overlayWith(2100, 1350));
  g.fire();                                               // memguard shed
  assert.equal(mh.squareCount(), 2);
  assert.equal(mh.size(), 200);
});

test('ensureNear: overlay squares within 25 km, background refused at memguard warm, nothing at critical', async () => {
  const reads = [];
  const g = guardAt(0);
  const mh = createMinorHarbours({ named: [], guard: g, readOverlay: async (x, y) => { reads.push(`${x}/${y}`); return overlayWith(x, y, 4); } });
  const lat = 52.2, lon = 5.0;
  const keys = mh.squaresNear(lat, lon, 25);
  assert.equal(keys.length, 72);
  g.lv = 1;
  assert.deepEqual(await mh.ensureNear(lat, lon, 25, { background: true }), { ready: 0, total: 72, denied: 72 });
  assert.equal(reads.length, 0);
  assert.deepEqual(await mh.ensureNear(lat, lon, 25), { ready: 72, total: 72, denied: 0 });   // a player's ship: allowed at warm
  assert.equal(reads.length, 72);
  assert.equal(mh.size(), 288);
  await mh.ensureNear(lat, lon, 25);                      // cached: no second read
  assert.equal(reads.length, 72);
  g.lv = 4;
  assert.deepEqual(await mh.ensureNear(48.0, 2.0, 5), { ready: 0, total: mh.squaresNear(48.0, 2.0, 5).length, denied: mh.squaresNear(48.0, 2.0, 5).length });
  // near / bbox (zoom ≥ 11 only)
  const near = mh.near(lat, lon, 3);
  assert.ok(near.length > 0 && near.every((h, i) => i === 0 || h.lat !== undefined));
  assert.deepEqual(mh.inBbox([52.1, 4.9, 52.3, 5.1], 10), []);
  assert.ok(mh.inBbox([52.1, 4.9, 52.3, 5.1], 11).length > 0);
  assert.deepEqual(Object.keys(mh.inBbox([52.1, 4.9, 52.3, 5.1], 11)[0]), ['id', 'name', 'tier', 'lat', 'lon', 'vhf', 'berths', 'sym', 'est', 'sub']);
  assert.deepEqual([...squaresUnder([{ lat, lon }])], [sqOf(lat, lon)]);
});

test('FIS harbours are always available (no overlay yet) and are replaced when the overlay arrives', async () => {
  const fis = { harbours: [{ id: 'fis:1', name: 'FIS Haven', p: [52.2, 5.0], long: 30, short: 10 }] };
  const ovs = new Map();
  const mh = createMinorHarbours({ named: [], fis, readOverlay: async (x, y) => ovs.get(`${x}/${y}`) || null });
  const [x, y] = sqOf(52.2, 5.0).split('/').map(Number);
  assert.deepEqual(mh.harboursIn(x, y).map((h) => [h.id, h.tier, h.src]), [['mh:fis:1', 'marina', 'fis']]);
  ovs.set(`${x}/${y}`, { f: [{ id: 'n5', k: null, t: { leisure: 'marina', name: 'OSM name' }, g: [52.2005, 5.0], c: 0 }] });
  await mh.ensureNear(52.2, 5.0, 1);
  assert.deepEqual(mh.harboursIn(x, y).map((h) => [h.id, h.name, h.src, h.osm]), [['mh:fis:1', 'FIS Haven', 'fis+osm', ['n5']]]);
});

test('radio stations: harbour masters on their channel within 30 km (data or simulated ch 31 in NL)', () => {
  const mh = createMinorHarbours({ named: [] });
  const [x, y] = sqOf(52.2, 5.0).split('/').map(Number);
  mh.ingest(x, y, { f: [
    { id: 'n1', k: null, t: { leisure: 'marina', name: 'Haven A' }, g: [52.2, 5.0], c: 0 },
    { id: 'n2', k: null, t: { leisure: 'marina', name: 'Haven B', vhf: '74' }, g: [52.205, 5.006], c: 0 },
    { id: 'n3', k: null, t: { 'seamark:small_craft_facility:category': 'visitor_berth' }, g: [52.19, 4.99], c: 0 },
  ] });
  assert.deepEqual(mh.harboursOn(31, 52.2, 5.0).map((s) => [s.id, s.name, s.ch, s.sim, s.kind]), [['mh:osm:n1', 'Haven A harbour master', 31, true, 'harbour']]);
  assert.deepEqual(mh.harboursOn(74, 52.2, 5.0).map((s) => s.id), ['mh:osm:n2']);
  assert.deepEqual(mh.harboursOn(16, 52.2, 5.0), []);
  assert.equal(mh.harboursOn(null, 52.2, 5.0).length, 2);   // passant without data has no channel
});

test('reachability on the synthetic graph (§7.4): yes / with openings / no, cached 10 min per (profile, harbour)', () => {
  const graph = JSON.parse(fs.readFileSync(new URL('./fixtures/mh/graph.json', import.meta.url)));
  let t = 1_000_000_000_000;
  const mh = createMinorHarbours({ named: HARBORS, graph, now: () => t });
  const [x, y] = sqOf(51.857, 4.663).split('/').map(Number);
  mh.ingest(x, y, { f: [{ id: 'n9', k: null, t: { leisure: 'marina', name: 'Jachthaven Alblasserdam (test)' }, g: [51.857, 4.663], c: 0 }] });
  const h = mh.get('mh:osm:n9');
  // a 17 m sloop cannot pass the fixed 7.0 m bridge → via the lift bridge (12 min)
  assert.deepEqual(mh.reach(h, { cls: 'sloop', lat: 51.9, lon: 4.48 }), { state: 'openings', text: 'With openings (1 bridge, est. +12 min)', bridges: 1, locks: 0, waitMin: 12 });
  // a motor cruiser (need 3.7 m arch up? folded: 2.9 + 0.3 = 3.2) passes under the fixed bridge: the short way, no openings
  assert.equal(mh.reach(h, { cls: 'cruiser', lat: 51.9, lon: 4.48 }).text, 'Yes');
  // the coaster (beam 14 m) has no CEMT Vb route at all
  assert.equal(mh.reach(h, { cls: 'coaster', lat: 51.9, lon: 4.48 }).text, 'No: Noord (short) (beam 14 m > 11.5 m (CEMT Vb))');
  const s0 = mh.stats();
  mh.reach(h, { cls: 'sloop', lat: 51.9, lon: 4.48 });
  assert.equal(mh.stats().reachHits, s0.reachHits + 1);
  t += 601_000;
  mh.reach(h, { cls: 'sloop', lat: 51.9, lon: 4.48 });
  assert.equal(mh.stats().reachHits, s0.reachHits + 1);  // expired → re-planned
  // no graph → unknown, card still builds
  const mh2 = createMinorHarbours({ named: HARBORS });
  mh2.ingest(x, y, { f: [{ id: 'n9', k: null, t: { leisure: 'marina' }, g: [51.857, 4.663], c: 0 }] });
  const card = mh2.sheet('mh:osm:n9', { cls: 'sloop', lat: 51.9, lon: 4.48 });
  assert.equal(card.reach.state, 'unknown');
  assert.equal(card.name, 'Marina near Rotterdam');
});

test('services layer at a quay berth: the minor harbour within 1 km on top of the named tier', () => {
  const mh = createMinorHarbours({ named: HARBORS });
  const [x, y] = sqOf(51.857, 4.663).split('/').map(Number);
  mh.ingest(x, y, { f: [{ id: 'w1', k: null, t: { landuse: 'port', name: 'Testhaven' }, g: [51.857, 4.663, 51.858, 4.664, 51.857, 4.665, 51.856, 4.664], c: 1 }] });
  const s = mh.servicesAt(51.8572, 4.6635, 'remote');
  assert.deepEqual([s.harbour.tier, s.fuel, s.repair, s.market], ['inland_port', 1.08, 1.25, 'small']);
  assert.equal(mh.servicesAt(53.0, 6.0, 'remote').harbour, null);
});

test('with lane A merged: the shipped FIS registry and its inland graph drive harbours and reach (smoke)', async (t) => {
  const { loadFis } = await import('../server/fis.js').catch(() => ({}));
  const fis = loadFis ? loadFis() : null;
  const inl = await import('../server/inland.js').catch(() => null);
  if (!fis || !inl?.buildGraph) return t.skip('lane A registry not present');
  const { loadLaneA } = await import('../server/inlandlink.js');
  const lane = await loadLaneA();
  assert.equal(lane.src.plan, 'laneA');
  const mh = createMinorHarbours({ named: HARBORS, fis, graph: inl.buildGraph(fis), lane });
  await mh.ensureNear(52.37, 4.9, 10);
  const hs = mh.near(52.37, 4.9, 10);
  assert.ok(hs.length >= 10 && hs.every((h) => h.src === 'fis' && (h.tier === 'marina' || h.tier === 'passant')));
  const card = mh.sheet(hs[0].id, { cls: 'myacht', lat: 51.9, lon: 4.48 });
  assert.ok(['yes', 'openings', 'no'].includes(card.reach.state));
  assert.ok(card.fit.total > 0);
});

test('chart bbox loads the squares under it (not only where a ship has been): FIS at once, overlays in the background', async () => {
  const fis = { harbours: [{ id: 'fis1', name: 'Fis Haven', p: [51.83, 4.135] }] };
  const [ox, oy] = sqOf(51.80, 4.05).split('/').map(Number);
  const reads = [];
  const mh = createMinorHarbours({ named: [], fis, guard: guardAt(1), readOverlay: async (x, y) => { reads.push(`${x}/${y}`); return x === ox && y === oy ? overlayWith(x, y, 4) : null; } });
  assert.equal(mh.size(), 0);
  const bbox = [51.75, 3.95, 51.90, 4.25];
  const first = mh.inBbox(bbox, 12);
  assert.ok(first.some((r) => r.name === 'Fis Haven'), 'FIS harbour on the first answer');
  assert.ok(mh.pending() > 0 || reads.length > 0);
  await new Promise((r) => setTimeout(r, 20));
  const second = mh.inBbox(bbox, 12);
  assert.ok(second.length >= first.length + 4, 'overlay marinas after the background read');
  assert.ok(reads.includes(`${ox}/${oy}`));
  // too far out (> CHART_MAX_SQUARES) or under zoom 11: nothing is generated
  const mh2 = createMinorHarbours({ named: [], fis, readOverlay: async () => { throw new Error('no read'); } });
  assert.deepEqual(mh2.inBbox([40, -10, 60, 20], 11), []);
  assert.deepEqual(mh2.inBbox(bbox, 10), []);
  // critical memory: no new squares, no reads
  const mh3 = createMinorHarbours({ named: [], fis, guard: guardAt(4), readOverlay: async () => { throw new Error('no read'); } });
  assert.deepEqual(mh3.inBbox(bbox, 12), []);
});

test('chart bbox: a square without an overlay is not re-read on every request (5 min pause)', async () => {
  let reads = 0;
  const mh = createMinorHarbours({ named: [], fis: { harbours: [] }, readOverlay: async () => { reads++; return null; } });
  const bbox = [51.80, 4.10, 51.85, 4.15];
  mh.inBbox(bbox, 12); await new Promise((r) => setTimeout(r, 10));
  const n = reads; assert.ok(n > 0);
  mh.inBbox(bbox, 12); await new Promise((r) => setTimeout(r, 10));
  assert.equal(reads, n);
  assert.equal(mh.pending(), 0);
});
