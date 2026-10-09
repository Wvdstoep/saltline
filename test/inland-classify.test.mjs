// Inland harbours lane D (docs/BRIDGES-LOCKS-VHF-CONTRACT.md §7, §10.8): classification, marina boxes, fit, fees,
// services, VHF, FIS ↔ OSM merge, the small inland market. Pure (shared/mharbour.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MH, classifyTags, classifyFis, fisPlaces, serviceFlags, parseVhf, boxWidth, boxesAlong, boxLenFor, marinaSize, berthsOf, boxFits, sideFits,
  depthNeed, lengthNeed, depthOf, fitSummary, nightFee, quayFeeFromDisp, servicesOf, layerServices, vhfOf, nameFor, subOf, harboursFromOverlay,
  inNL, sqOf, inlandMarket, reachOf, harbourCard, chartRow, markerSpec,
} from '../shared/mharbour.js';
import { neededDepth, neededLength, quayFeePerDay, clsOf } from '../shared/quayrules.js';
import { HARBORS } from '../server/harbors.js';

test('classification table on tag fixtures (§7.3, §10.8.1)', () => {
  const T = (t, ctx) => classifyTags(t, ctx)?.tier ?? null;
  assert.equal(T({ leisure: 'marina' }), 'marina');
  assert.equal(T({ 'seamark:type': 'harbour', 'seamark:harbour:category': 'marina_no_facilities' }), 'marina');
  assert.equal(T({ leisure: 'marina', capacity: '12', mooring: 'visitor' }), 'passant');
  assert.equal(T({ 'seamark:small_craft_facility:category': 'visitor_berth' }), 'passant');
  assert.equal(T({ mooring: 'visitor' }), 'passant');
  assert.equal(T({ mooring: 'yes' }), 'passant');
  assert.equal(T({ mooring: 'yes' }, { townKm: 0.6 }), 'city');
  assert.equal(T({ harbour: 'yes' }, { townKm: 0.4 }), 'city');
  assert.equal(T({ mooring: 'private' }), null);
  assert.equal(T({ mooring: 'waiting' }), null);                       // lock waiting berths are not harbours
  assert.equal(T({ landuse: 'port' }), 'inland_port');
  assert.equal(T({ industrial: 'port' }), 'inland_port');
  assert.equal(T({ 'seamark:harbour:category': 'container;bulk' }), 'inland_port');
  assert.equal(T({ mooring: 'commercial' }), 'inland_port');
  assert.equal(T({ 'seamark:harbour:category': 'fishing' }), 'fishing');
  assert.equal(T({ 'seamark:harbour:category': 'ferry_terminal' }), 'ferry');
  assert.equal(T({ 'seamark:type': 'harbour' }), 'passant');
  assert.equal(T({ man_made: 'pier' }), null);
  assert.equal(T({ 'seamark:small_craft_facility:category': 'water_tap' }), null);  // a service, not a harbour
  // FIS tourist harbours: > 20 places marina, else passantenhaven; lane A's {long, short} shape
  assert.equal(fisPlaces({ long: 60, short: 25 }), 85);
  assert.equal(classifyFis({ long: 60, short: 25 }).tier, 'marina');
  assert.equal(classifyFis({ long: 0, short: 14 }).tier, 'passant');
  assert.equal(classifyFis({ places: 20 }).tier, 'passant');
  assert.equal(classifyFis({ places: 21 }).tier, 'marina');
});

test('services and VHF from tags', () => {
  assert.deepEqual(serviceFlags({ 'seamark:small_craft_facility:category': 'fuel_station;water_tap;slipway' }), { fuel: true, water: true, slipway: true });
  assert.deepEqual(serviceFlags({ waterway: 'fuel' }), { fuel: true });
  assert.equal(parseVhf({ vhf: '31' }), 31);
  assert.equal(parseVhf({ 'seamark:radio_station:channel': '16;9' }), 9);
  assert.equal(parseVhf({ vhf: '16' }), 16);
  assert.equal(parseVhf({ vhf: '99' }), null);
  assert.equal(parseVhf({}), null);
  // simulated channel: NL marinas 31, marinas abroad 9; other tiers without data none (Q12)
  assert.deepEqual(vhfOf({ tier: 'marina', cc: 'NL' }), { ch: 31, sim: true });
  assert.deepEqual(vhfOf({ tier: 'marina', cc: null }), { ch: 9, sim: true });
  assert.deepEqual(vhfOf({ tier: 'passant', cc: 'NL' }), { ch: null, sim: false });
  assert.deepEqual(vhfOf({ tier: 'passant', vhf: 12 }), { ch: 12, sim: false });
  assert.equal(inNL(51.9, 4.48), true);
  assert.equal(inNL(53.54, 9.93), false);
  assert.equal(inNL(51.21, 4.40), false);          // Antwerp
  assert.equal(sqOf(51.91536, 4.16967), '2095/1354');
});

test('marina boxes (§7.3, §10.8.2): 100 m pontoon, 12 m boxes (4.0 m wide), both sides → 50', () => {
  assert.equal(boxWidth(12), 4.0);
  assert.deepEqual(MH.BOXES.map(([l]) => boxWidth(l)), [3.0, 3.5, 4.0, 4.5, 5.5]);
  assert.equal(boxWidth(11), 4.0);
  assert.equal(boxesAlong(100, 12), 50);
  assert.equal(boxesAlong(100, 12, 1), 25);
  assert.equal(boxesAlong(100, 20), 2 * 18);
  assert.equal(marinaSize(40), 'small'); assert.equal(marinaSize(120), 'medium'); assert.equal(marinaSize(400), 'large');
  assert.deepEqual([0, 1, 2].map((k) => boxLenFor(k, 3, 'medium')), [15, 12, 10]);
  // a one-pontoon marina generated from a synthetic record: 100 m pontoon W→E at 52.0 N
  const h = { id: 'mh:test:1', tier: 'marina', places: 120, pont: [[52.0, 5.0, 52.0, 5.0 + 100 / (111320 * Math.cos(52 * Math.PI / 180)), 100]] };
  const b = berthsOf(h);
  assert.equal(b.kind, 'box');
  assert.equal(b.total, 2 * Math.floor(100 / 4.5));    // medium marina, the only pontoon gets 15 m boxes (4.5 m wide) → 44
  assert.equal(b.total, 44);
  assert.equal(b.list.length, 44);
  assert.deepEqual(b.sizes, [{ len: 15, w: 4.5, n: 44 }]);
  assert.equal(new Set(b.list.map((x) => x.id)).size, 44);
  assert.deepEqual(b.list.slice(0, 2).map((x) => x.hdg), [180, 180]);    // right of a W→E pontoon is south
});

test('fit rules mirror dock-anywhere (§7.4)', () => {
  // quay length / depth formulas equal shared/quayrules.js for the same hull
  for (const cls of ['coaster', 'feeder', 'tug', 'sloop']) {
    assert.equal(lengthNeed(clsOf(cls).length), neededLength(cls));
    assert.equal(depthNeed(clsOf(cls).draft), neededDepth(cls));
  }
  // small-craft basins: ukc 5 %, ≥ 0.1 m (a 1.9 m sloop lies in a 2.0 m marina)
  assert.equal(depthNeed(1.9, 'marina'), 2.0);
  assert.equal(depthNeed(1.9, 'city'), 2.2);
  assert.deepEqual(boxFits({ len: 12, w: 4.0 }, { L: 11, B: 3.6 }), { ok: true, why: null });
  assert.equal(boxFits({ len: 12, w: 4.0 }, { L: 13.5, B: 3.6 }).ok, true);   // L ≤ box + 1.5
  assert.equal(boxFits({ len: 12, w: 4.0 }, { L: 13.6, B: 3.6 }).ok, false);
  assert.equal(boxFits({ len: 12, w: 4.0 }, { L: 11, B: 3.7 }).ok, false);    // B ≤ 4.0 − 0.4
  assert.equal(sideFits({ lenM: 30, raft: true }, { L: 14, yacht: true }).ok, true);
  assert.equal(sideFits({ lenM: 30, raft: true }, { L: 24, yacht: true }).ok, false);   // 34 m of quay needed
  // depth: data > default; chart only when deeper than the default
  assert.deepEqual(depthOf({ tier: 'marina' }), { m: 2.0, src: 'est.' });
  assert.deepEqual(depthOf({ tier: 'marina' }, { sampled: 0.9 }), { m: 2.0, src: 'est.' });
  assert.deepEqual(depthOf({ tier: 'marina' }, { sampled: 3.46 }), { m: 3.5, src: 'chart' });
  assert.deepEqual(depthOf({ tier: 'marina', depth: 2.6, depthSrc: 'FIS' }), { m: 2.6, src: 'FIS' });
  assert.deepEqual(depthOf({ tier: 'inland_port' }, { cemtT: 4.0 }), { m: 4.0, src: 'waterway class' });
  assert.deepEqual(depthOf({ tier: 'passant' }), { m: 1.8, src: 'est.' });
  const h = { id: 'mh:test:2', tier: 'marina', places: 120, pont: [[52.0, 5.0, 52.0, 5.0 + 100 / (111320 * Math.cos(52 * Math.PI / 180)), 100]] };
  assert.equal(fitSummary(h, { L: 11, B: 3.6, T: 1.9 }).fits, 44);
  assert.equal(fitSummary(h, { L: 24, B: 6, T: 1.8 }).fits, 0);
  assert.equal(fitSummary(h, { L: 24, B: 6, T: 1.8 }).why, '15 m boxes; you are 24 m long');
  assert.equal(fitSummary({ ...h, maxL: 10 }, { L: 11, B: 3.6, T: 1.9 }).why, 'Harbour takes up to 10 m; you are 11 m');
  assert.equal(fitSummary(h, { L: 11, B: 3.6, T: 2.3 }).why, '2 m (est.) in the harbour; you need 2.4 m');
});

test('fees per night (§7.5, §10.8.5): sloop 11 m in a marina → 17.6 + 3 = 20.6 → 21 cr', () => {
  const sloop = { L: 11, disp: 6, yacht: true };
  assert.equal(nightFee({ tier: 'marina' }, sloop).perNight, 21);
  assert.equal(nightFee({ tier: 'marina' }, sloop, { power: false }).perNight, 18);   // 17.6
  assert.equal(nightFee({ tier: 'passant', svc: {} }, sloop).perNight, 13);           // 13.2
  assert.equal(nightFee({ tier: 'passant', svc: { power: true } }, sloop).perNight, 16);
  assert.equal(nightFee({ tier: 'city' }, sloop).perNight, 11);
  assert.equal(nightFee({ tier: 'fishing' }, sloop).perNight, 9);                      // 8.8
  // ships at city quays / inland ports pay the dock-anywhere quay fee (identical to quayFeePerDay)
  const c = clsOf('coaster'), feeder = clsOf('feeder');
  assert.equal(quayFeeFromDisp(c.displacement, 'city'), quayFeePerDay('coaster', 'city'));
  assert.equal(nightFee({ tier: 'city' }, { L: 90, disp: c.displacement, yacht: false }).perNight, quayFeePerDay('coaster', 'city'));
  assert.equal(nightFee({ tier: 'inland_port' }, { L: 150, disp: feeder.displacement }).perNight, quayFeePerDay('feeder', 'industrial'));
  assert.equal(nightFee({ tier: 'inland_port' }, { L: 150, disp: feeder.displacement }).perNight, 224);   // 14000 × 0.02 × 1.0 × 0.8
  assert.equal(quayFeeFromDisp(feeder.displacement, 'industrial', { size: 'mega', tier: 'port' }), quayFeePerDay('feeder', 'industrial', { size: 'mega', tier: 'port' }));
});

test('services per tier and the better-of layer at a berth (§7.5)', () => {
  assert.equal(servicesOf({ tier: 'marina', svc: {} }).fuel, false);
  assert.equal(servicesOf({ tier: 'marina', svc: { fuel: true } }).fuelMul, 1);
  assert.deepEqual(servicesOf({ tier: 'marina', svc: { boatyard: true } }).repair, { mul: 1.3, yachtsOnly: true });
  assert.equal(servicesOf({ tier: 'passant', svc: { water: true } }).water, true);
  assert.equal(servicesOf({ tier: 'passant', svc: {} }).water, false);
  const ip = servicesOf({ tier: 'inland_port', svc: {} });
  assert.deepEqual([ip.fuelMul, ip.market, ip.repair.mul, ip.shipyard], [1.08, 'small', 1.25, false]);
  assert.equal(servicesOf({ tier: 'fishing', svc: {} }).market, 'fish');
  // inland port 40 km from its named harbour ('remote': fuel ×1.25 only) → its own trucked fuel ×1.08 and crew ×1.25 win
  const l = layerServices({ tier: 'inland_port', svc: {} }, 'remote');
  assert.deepEqual([l.fuel, l.repair, l.market, l.from.fuel, l.from.repair, l.shipyard], [1.08, 1.25, 'small', 'minor', 'minor', false]);
  // inside the port limits the named harbour is better on every service
  const p = layerServices({ tier: 'inland_port', svc: {} }, 'port');
  assert.deepEqual([p.fuel, p.repair, p.market, p.shipyard, p.from.fuel], [1, 1, 'harbour', true, 'named']);
  assert.deepEqual([layerServices(null, 'none').fuel, layerServices(null, 'none').market], [null, null]);
});

test('names, sub-harbours, chart rows, card and 3D marker spec', () => {
  assert.equal(nameFor({ tier: 'marina' }, { near: 'Rotterdam (Maasvlakte)' }), 'Marina near Rotterdam');
  assert.equal(nameFor({ tier: 'passant' }, { town: 'Maassluis' }), 'Maassluis visitor harbour');
  assert.equal(nameFor({ tier: 'marina', name: 'Jachthaven X' }), 'Jachthaven X');
  const s = subOf(51.915, 4.25, HARBORS);
  assert.equal(s.link.id, 'rotterdam');
  assert.equal(s.sub, null);                                     // 16.7 km > 12 km mega port radius
  assert.equal(s.link.dKm, 16.7);
  assert.equal(subOf(51.95, 4.10, HARBORS).sub.id, 'rotterdam');
  const h = { id: 'mh:test:3', name: 'Test', tier: 'marina', lat: 52, lon: 5, cc: 'NL', e: 2, cap: 44, places: 120, pont: [[52.0, 5.0, 52.0, 5.0014764, 100]], svc: {} };
  assert.deepEqual(chartRow(h), { id: 'mh:test:3', name: 'Test', tier: 'marina', lat: 52, lon: 5, vhf: 31, berths: 44, sym: 'marina', est: true, sub: null });
  const card = harbourCard(h, { ship: { L: 11, B: 3.6, T: 1.9, disp: 6, yacht: true } });
  assert.equal(card.tierLabel, 'Marina (Jachthaven)');
  assert.equal(card.fit.text, '44 of 44 berths take you');
  assert.equal(card.fee.text, '21 cr per night (1.6 cr per metre + 3 cr power)');
  assert.equal(card.vhf.text, 'Harbour master ch 31 (simulated)');
  assert.deepEqual(card.tabs, ['overview', 'berths', 'services', 'jobs', 'weather']);
  assert.equal(card.notes.length, 1);                            // est. note
  const m = markerSpec(h);
  assert.equal(m.posts.length, 44); assert.equal(m.hut.flag, true); assert.equal(m.sign.text, 'Test');
  // reach lines (§7.4)
  assert.equal(reachOf({ points: [[0, 0]], marks: [] }).text, 'Yes');
  assert.equal(reachOf({ points: [[0, 0]], marks: [{ kind: 'bridge', action: 'opening', waitMin: 12 }, { kind: 'bridge', action: 'under' }, { kind: 'lock', waitMin: 25 }] }).text, 'With openings (1 bridge, 1 lock, est. +37 min)');
  assert.equal(reachOf(null, { blocked: { name: 'Testbrug A', why: 'fixed 7 m, you need 7.8 m' } }).text, 'No: Testbrug A (fixed 7 m, you need 7.8 m)');
  assert.equal(reachOf(null, { available: false }).state, 'unknown');
});

test('FIS ↔ OSM merge within 150 m gives one harbour with the FIS id (§10.8.4)', () => {
  const ov = { f: [
    { id: 'w10', k: 'pier', t: { man_made: 'pier', 'seamark:small_craft_facility:category': 'visitor_berth', name: 'OSM steiger' }, g: [52.0, 5.0, 52.0, 5.0006], c: 0 },
    { id: 'n11', k: null, t: { 'seamark:small_craft_facility:category': 'fuel_station' }, g: [52.0003, 5.0003], c: 0 },
  ] };
  const fis = [{ id: 'fis:77', name: 'Passantenhaven FIS', p: [52.0008, 5.0003], long: 0, short: 12, maxT: 2.4 }, { id: 'fis:78', name: 'Far', p: [52.02, 5.0], long: 40, short: 10 }];
  const hs = harboursFromOverlay(ov, { fis, named: [] });
  assert.equal(hs.length, 2);
  const m = hs.find((h) => h.id === 'mh:fis:77');
  assert.deepEqual([m.name, m.src, m.tier, m.places, m.depth, m.depthSrc, m.osm, m.svc.fuel, m.e], ['Passantenhaven FIS', 'fis+osm', 'passant', 12, 2.4, 'FIS', ['w10'], true, 0]);
  const far = hs.find((h) => h.id === 'mh:fis:78');
  assert.deepEqual([far.tier, far.src, far.cap, far.cc], ['marina', 'fis', 50, 'NL']);
  // ids are stable and the result is deterministic
  assert.deepEqual(harboursFromOverlay(ov, { fis, named: [] }), hs);
});

test('small inland market (§7.6): 3–5 goods, ±6 %, 10 % stock, fish only at fishing harbours', () => {
  const named = { id: 'rotterdam', goods: { grain: { buy: 270, sell: 250, target: 4000 }, steel: { buy: 950, sell: 880, target: 2000 }, machinery: { buy: 3300, sell: 3100, target: 500 }, containers: { buy: 2200, sell: 2000, target: 3000 }, fuel: { buy: 660, sell: 620, target: 5000 }, fish: { buy: 720, sell: 680, target: 800 }, cigarettes: { buy: 9000, sell: 8000, target: 10 } } };
  const m = inlandMarket({ id: 'mh:osm:w1', tier: 'inland_port' }, named, { contraband: new Set(['cigarettes']) });
  assert.ok(m.goods.length >= 3 && m.goods.length <= 5);
  for (const g of m.goods) {
    assert.notEqual(g.id, 'cigarettes');
    assert.ok(Math.abs(g.f - 1) <= 0.06 + 1e-9);
    assert.equal(g.buy, Math.round(named.goods[g.id].buy * g.f));
    assert.equal(g.stock, Math.round(0.1 * named.goods[g.id].target));
  }
  assert.deepEqual(inlandMarket({ id: 'mh:osm:w1', tier: 'inland_port' }, named, { contraband: new Set(['cigarettes']) }), m);   // deterministic
  assert.deepEqual(inlandMarket({ id: 'mh:osm:w2', tier: 'fishing' }, named).goods.map((g) => g.id), ['fish']);
  assert.equal(inlandMarket({ id: 'x', tier: 'inland_port' }, null), null);
});

test('FIS-only harbours without geometry: berths from the place count (est.)', () => {
  assert.deepEqual(berthsOf({ id: 'x', tier: 'marina', places: 85 }), { kind: 'box', total: 85, list: [], sizes: [{ len: 10, w: 3.5, n: 28 }, { len: 12, w: 4, n: 29 }, { len: 15, w: 4.5, n: 28 }], est: true });
  const p = berthsOf({ id: 'y', tier: 'passant', places: 14, lat: 52, lon: 5 });
  assert.deepEqual([p.total, p.list[0].lenM, p.list[0].raft], [14, 60, true]);
  assert.equal(fitSummary({ id: 'x', tier: 'marina', places: 85 }, { L: 11, B: 3.6, T: 1.9 }).fits, 57);   // 12 + 15 m boxes
  assert.equal(fitSummary({ id: 'z', tier: 'passant' }, { L: 11, B: 3.6, T: 1.2 }).why, 'No berth geometry known yet (est.)');
});
