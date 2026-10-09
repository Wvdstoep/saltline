// Mooring in inland harbours and marinas (server/mhmoor.js + shared/mhgeo.js rules): berth guidance to a box, making fast
// in it (fit, depth, occupancy, speed, money), the first night paid, services by tier, casting off with the balance —
// on the Rotterdam fixture (synthetic FIS marina 9002 laid on the recorded tiles, the OSM passantenhaven 9001).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { createMinorHarbours } from '../server/minorharbours.js';
import { mhNearBerth, mhDock, dimsOf, berthsNear } from '../server/mhmoor.js';
import { quayUndock } from '../server/quaygame.js';
import { HARBORS } from '../server/harbors.js';
import { makeSampler } from '../server/quays.js';
import { MHG, boxWhy, sideWhy, moorPoint, sideSlot, mhServices, mhDenies, mhSurcharge, mhServiceRows, feeFor, linkOf } from '../shared/mhgeo.js';
import { mooredModel, mooredHTML } from '../public/js/quayfmt.js';
import { loadPoints, loadPortFixture, FIXTURE_DIR } from './fixtures/wt/lib.mjs';

const ov = (x, y) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(FIXTURE_DIR, 'rotterdam', `ov-12-${x}-${y}.json.gz`))).toString('utf8'));
const fis = JSON.parse(fs.readFileSync(new URL('./fixtures/mh/fis-harbours.json', import.meta.url)));
const { ports } = loadPoints();
const fx = loadPortFixture(FIXTURE_DIR, ports.find((p) => p.id === 'rotterdam'));
const sample = makeSampler((z, x, y) => fx.tiles.get(`${x}/${y}`) || null);
const M = (lat) => 111320 * Math.cos(lat * Math.PI / 180);
const dist = (a, b, c, d) => Math.hypot((d - b) * M(a), (c - a) * 111320);

function makeGame() {
  const mh = createMinorHarbours({ named: HARBORS, fis });
  mh.ingest(2095, 1354, ov(2095, 1354));
  mh.setSampler(sample);
  const events = [], sent = [];
  const game = {
    mh, byId: new Map(), simTime: 1_000_000, politics: null, jobsx: null,
    event: (p, kind, text) => events.push({ p: p.id, kind, text }),
    sendYou: () => {}, send: (p, m) => sent.push(m), dropWarp: () => {},
    setDocked(p, id, berth) { p.docked = id; p.dockedAt = this.simTime; p.berth = berth || null; p.ship.spd = 0; },
    events, sent,
  };
  return game;
}
function player(game, id, cls, lat, lon, extra = {}) {
  const p = { id, ship: { cls, lat, lon, hdg: 0, spd: 0 }, money: 5000, cond: 100, flooding: 0, fuel: 0.2, jobs: [], docked: null, berth: null, ...extra };
  game.byId.set(id, p); return p;
}
const MARINA = 'mh:fis:9002';

test('guidance: a sloop 400 m off the marina is led to a box that takes her; far away there is no inland target', () => {
  const g = makeGame(), e = g.mh.geoOf(MARINA);
  assert.equal(e.geo.synth, true);
  const far = player(g, 'far', 'sloop', 51.95, 4.19);
  assert.equal(mhNearBerth(g, far), null);
  const p = player(g, 'a', 'sloop', e.geo.lat - 0.0036, e.geo.lon);     // ≈ 400 m south
  const nb = mhNearBerth(g, p);
  assert.ok(nb && nb.mh && nb.fits, JSON.stringify(nb));
  assert.equal(nb.harbor, MARINA);
  assert.equal(nb.kind, 'box');
  assert.match(nb.name, /^Box \d+ · /);
  assert.ok(nb.box.len >= 12 && nb.box.w >= 4, 'an 11 m × 3.6 m sloop needs a 12 m (4.0 m wide) box or bigger');
  assert.equal(nb.fee, 21);                                               // 1.6 cr/m × 11 m + 3 cr power
  assert.equal(nb.feeText, '21 cr per night (1.6 cr per metre + 3 cr power)');
  assert.ok(nb.distM > 200 && nb.distM < 1500);
  // sticky: the same box next time
  assert.equal(mhNearBerth(g, p).id, nb.id);
});

test('moor in the box: snapped bow-in, first night paid, berth record, services, then cast off with the balance', () => {
  const g = makeGame(), e = g.mh.geoOf(MARINA);
  const p = player(g, 'a', 'sloop', e.geo.lat - 0.0036, e.geo.lon);
  const nb = mhNearBerth(g, p);
  // too far: not handled here (the caller tries harbour berths and quays)
  assert.equal(mhDock(g, p), false);
  // come alongside, too fast
  Object.assign(p.ship, { lat: nb.lat + 0.0002, lon: nb.lon, spd: 3 });
  assert.equal(mhDock(g, p), true);
  assert.match(g.events.at(-1).text, /Slow below 2 kn/);
  assert.equal(p.docked, null);
  // slow: moored
  p.ship.spd = 0.8;
  assert.equal(mhDock(g, p), true);
  assert.equal(p.docked, 'rotterdam');                                     // the linked named harbour
  const b = p.berth;
  assert.deepEqual([b.quay, b.mh, b.kind, b.id, b.perDay, b.paid, b.tier], [true, MARINA, 'box', nb.id, 21, 21, 'near']);
  assert.equal(p.money, 5000 - 21);
  assert.equal(dist(p.ship.lat, p.ship.lon, nb.lat, nb.lon) < 1, true);
  assert.ok(Math.abs(p.ship.hdg - nb.hdg) <= 0.5);
  assert.ok(g.events.some((x) => /Moored: Box \d+ .*21 cr per night — first night paid \(21 cr\)/.test(x.text)), g.events.map((x) => x.text).join(' | '));
  assert.ok(g.sent.some((m) => m.t === 'mh_moored' && m.id === MARINA));
  // services: water, power and the marina's own fuel berth; the market is trucked from Rotterdam (12 km: outside its port limits)
  assert.deepEqual([b.svc.water, b.svc.power, b.svc.fuel, b.svc.from.fuel, b.svc.market], [true, true, 1, 'minor', 'harbour']);
  assert.equal(mhDenies(b, 'fuel'), null);
  assert.equal(mhSurcharge(b, 'fuel', 1000), 0);
  // the moored panel: per night, the harbour's services
  const m = mooredModel(b, g.simTime);
  assert.equal(m.unit, 'night');
  assert.match(mooredHTML(m, []), /21 cr \/ night/);
  assert.ok(m.services.find((r) => r.id === 'fuel').ok);
  // another skipper is led to a different box
  const q = player(g, 'b', 'sloop', e.geo.lat - 0.0036, e.geo.lon);
  assert.notEqual(mhNearBerth(g, q).id, nb.id);
  // two and a half days later: cast off, two more nights paid, 20 m out on the water side
  g.simTime += 2.5 * 86400;
  assert.equal(quayUndock(g, p), true);
  assert.equal(p.money, 5000 - 3 * 21);
  assert.equal(p.docked, null); assert.equal(p.berth, null);
  assert.ok(g.events.some((x) => /Harbour dues .*3 nights at 21 cr, 42 cr still due — paid/.test(x.text)));
  assert.ok(Math.abs(dist(p.ship.lat, p.ship.lon, b.lat, b.lon) - 20) < 1);
});

test('refusals: a coaster does not fit, an empty purse, a taken box', () => {
  const g = makeGame(), e = g.mh.geoOf(MARINA);
  const p = player(g, 'a', 'sloop', e.geo.lat - 0.0036, e.geo.lon);
  const nb = mhNearBerth(g, p);
  const c = player(g, 'c', 'coaster', nb.lat, nb.lon);
  const nbc = mhNearBerth(g, c);
  assert.equal(nbc.fits, false);
  assert.ok(mhDock(g, c)); assert.equal(c.docked, null);
  assert.match(g.events.at(-1).text, /harbour; you draw 5\.5 m|Box \d+: /);
  Object.assign(p.ship, { lat: nb.lat, lon: nb.lon }); p.money = 5;
  assert.ok(mhDock(g, p)); assert.equal(p.docked, null);
  assert.match(g.events.at(-1).text, /wants the first night \(21 cr\)/);
  p.money = 100;
  assert.ok(mhDock(g, p)); assert.equal(p.berth.id, nb.id);
  const q = player(g, 'q', 'sloop', nb.lat, nb.lon);
  const rows = berthsNear(g, q, 0.6), mine = rows.find((r) => r.b.id === nb.id);
  assert.equal(mine.why, `Box ${mine.b.no} is taken.`);
  assert.ok(mhDock(g, q));
  assert.notEqual(q.berth.id, nb.id);                                    // the next free box within 60 m
});

test('rules: box fit, depth, rafting, side slots, fees and services by tier', () => {
  const sloop = dimsOf('sloop'), cruiser = dimsOf('cruiser');
  const h = { id: 'h', name: 'Test', tier: 'marina', maxL: null };
  const box = (len, w) => ({ no: 7, len, w, lat: 52, lon: 4, hdg: 90 });
  assert.equal(boxWhy(h, box(12, 4), sloop, { depth: { m: 2, src: 'est.' } }), null);
  assert.equal(boxWhy(h, box(10, 3.5), sloop), 'Box 7: 10 m boxes; you are 11 m long.'.replace('10 m boxes; you are 11 m long', '3.5 m wide boxes; your beam is 3.6 m'));
  assert.equal(boxWhy(h, box(12, 4), sloop, { depth: { m: 1.8, src: 'est.' } }), '1.8 m (est.) in the harbour; you draw 1.9 m.');
  assert.equal(boxWhy({ ...h, maxL: 10 }, box(12, 4), sloop), 'Test takes boats up to 10 m; you are 11 m.');
  assert.equal(boxWhy(h, box(12, 4), sloop, { occupied: true }), 'Box 7 is taken.');
  // bow-in: the hull centre is fender + L/2 from the pontoon edge, heading toward the pontoon
  const mp = moorPoint({ lat: 52, lon: 4, hdg: 90, len: 12 }, sloop);
  assert.equal(mp.hdg, 270); assert.equal(mp.wb, 90);
  assert.ok(Math.abs((mp.lon - 4) * M(52) - (MHG.FENDER_M + 5.5 - 6)) < 0.5);
  // passant side berth: rafting 3 abreast for yachts ≤ 15 m
  const side = { raft: true, lenM: 40, a: [52, 4], b: [52, 4.001] };
  const ph = { id: 'p', name: 'P', tier: 'passant' };
  assert.equal(sideWhy(ph, side, cruiser, { rafted: 2 }), null);
  assert.equal(sideWhy(ph, side, cruiser, { rafted: 3 }), 'Already 3 abreast here.');
  const s0 = sideSlot(side, { lat: 52.0001, lon: 4.0005, hdg: 80 }, cruiser), s1 = sideSlot(side, { lat: 52.0001, lon: 4.0005, hdg: 80 }, cruiser, { rafted: [{ B: 3.8 }] });
  assert.equal(s0.side, -1);                                              // north of a west → east line = left
  assert.ok(s1.lat > s0.lat);                                             // rafted outside the first boat
  assert.equal(s0.hdg, 90);
  // fees by tier (§7.5) and services
  assert.equal(feeFor(h, sloop).perNight, 21);
  assert.equal(feeFor({ ...ph, svc: {} }, cruiser).perNight, 14);
  assert.equal(feeFor({ ...ph, tier: 'fishing' }, sloop).perNight, 9);
  const pass = { berth: null };
  const sv = mhServices({ tier: 'passant', svc: { water: true } }, 'remote');
  pass.berth = { quay: true, mh: 'p', mhName: 'P', tier: 'remote', svc: sv, yacht: true };
  assert.equal(mhDenies(pass.berth, 'market'), 'The market is not available at P.');
  assert.equal(mhDenies(pass.berth, 'fuel'), null);                       // remote tier: fuel by truck
  assert.equal(mhSurcharge(pass.berth, 'fuel', 1000), 250);
  assert.match(mhDenies(pass.berth, 'shipyard'), /shipyard is not available/);
  const rows = mhServiceRows(pass.berth);
  assert.deepEqual(rows.map((r) => [r.id, r.ok]), [['water', true], ['fuel', true], ['repair', false], ['market', false], ['office', true], ['jobs', false]]);
  const ip = mhServices({ tier: 'inland_port', svc: {} }, 'none');
  assert.deepEqual([ip.fuel, ip.repair, ip.market], [1.08, 1.25, 'small']);
  assert.equal(linkOf({ link: { id: 'rotterdam', dKm: 4 } }, HARBORS).tier, 'port');
});
