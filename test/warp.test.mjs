// v0.4 time warp, server side (docs/V4-CONTRACTS.md §1): set_warp accept/refuse matrix, movement budget and
// consumption scaling, auto-drop (harbour, land ahead, other skippers, hail, weather, damage), never resuming warped.
// V6 item 6 (docs/V6-QUICK-CONTRACTS.md §2): harbours cap warp at 5× instead of forbidding it (test/warp-harbour.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { World } from '../server/world.js';
import { carvingsForWorld, harborById } from '../server/harbors.js';
import { Game } from '../server/game.js';
import { WARP, SHIP_CLASSES } from '../shared/constants.js';
import { haversine, destination } from '../shared/geo.js';
import { POL } from '../shared/politics.js';

process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
const world = new World().load(carvingsForWorld(), () => {});

function fakeSocket() { return { readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); }, close() {} }; }
// rnd = 0.5: the fallback wind stays put, no storms spawn, no coast-guard hails, no port inspections.
function mkGame(opts = {}) { const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-warp-test-state.json', ...opts }); g.saveState = () => {}; g.rnd = () => 0.5; return g; }
function join(g, name, tok = null) { const ws = fakeSocket(); const p = g.connect(ws, tok, name); return { p, ws }; }
const last = (ws, t) => [...ws.sent].reverse().find((m) => m.t === t);
const evs = (ws) => ws.sent.filter((m) => m.t === 'event');
const lastEv = (ws) => evs(ws).at(-1);
const ROUTE = [{ lat: 56.2, lon: 3.6 }, { lat: 57, lon: 4 }];
// Open North Sea, > 100 km from any harbour, deep synthetic bathymetry, 95 km apart.
const OPEN_A = { lat: 55.0, lon: 3.5 };
const OPEN_B = { lat: 55.0, lon: 2.0 };
// Danish west coast (Natural Earth raster): heading 090 the coast is ~2 km ahead; the second point has a thin spit
// (Holmsland Klit) 2 km ahead with water again at 3 km, which a single sample at MIN_LAND_M would miss.
const DK_COAST = { lat: 56.48981, lon: 8.09245 };
const DK_SPIT = { lat: 55.98964, lon: 8.09992 };

function atSea(g, name, pos = OPEN_A, ship = {}) {
  const j = join(g, name);
  g.onAction(j.p, { action: 'undock' });
  Object.assign(j.p.ship, { lat: pos.lat, lon: pos.lon, hdg: 0, spd: 10, throttle: 0.7, rudder: 0 }, ship);
  j.p.lastValid = { lat: pos.lat, lon: pos.lon };
  return j;
}
const warp = (g, p, factor, route) => g.onAction(p, { action: 'set_warp', factor, route });
function refused(g, j, factor, re, route) {
  const before = j.p.warp;
  warp(g, j.p, factor, route);
  const ev = lastEv(j.ws);
  assert.equal(j.p.warp, before, `${factor}× must be refused (${ev && ev.text})`);
  assert.equal(ev.kind, 'warn'); assert.match(ev.text, /refused/); assert.match(ev.text, re);
  assert.equal(last(j.ws, 'you').you.warp, before, 'the refusal re-sends you.warp so the client follows the server');
}
function accepted(g, j, factor, route) {
  warp(g, j.p, factor, route);
  const ev = lastEv(j.ws);
  assert.equal(j.p.warp, factor, `${factor}× must be accepted (${ev && ev.text})`);
  assert.equal(last(j.ws, 'you').you.warp, factor);
}

test('warp: constants, worldInfo, you and publicState carry the factor; levels and routes are validated', () => {
  assert.deepEqual(WARP.LEVELS, [1, 5, 20, 100, 400]);
  assert.equal(WARP.MIN_LAND_M, 3000); assert.equal(WARP.PLAYER_RADIUS_M, 20000); assert.equal(WARP.HARBOR_RADIUS_M, 4000);
  assert.equal(WARP.MAX_STORM, 0.6); assert.equal(WARP.MAX_NO_ROUTE, 20);
  const g = mkGame(); const a = atSea(g, 'Ann');
  assert.deepEqual(g.worldInfo().warp, WARP); assert.deepEqual(last(a.ws, 'welcome').world.warp.LEVELS, WARP.LEVELS);
  assert.equal(a.p.warp, 1); assert.equal(last(a.ws, 'welcome').you.warp, 1); assert.equal(g.publicState(a.p).warp, 1);
  // only the contract levels
  for (const bad of [3, 0, -5, 1e9, 'abc', null, undefined, {}]) { warp(g, a.p, bad); assert.equal(a.p.warp, 1, `level ${bad}`); }
  assert.match(lastEv(a.ws).text, /levels are 1×, 5×, 20×, 100×, 400×/);
  // up to MAX_NO_ROUTE without a route
  accepted(g, a, 5);
  const ok = lastEv(a.ws); assert.equal(ok.kind, 'info'); assert.match(ok.text, /Time warp 5×/);
  assert.equal(g.publicState(a.p).warp, 5);
  accepted(g, a, 20);
  // above it a route is required: non-empty, finite points
  refused(g, a, 100, /route/);
  refused(g, a, 100, /route/, []);
  refused(g, a, 100, /route/, [{ lat: null, lon: 3 }]);
  refused(g, a, 100, /route/, [{ lat: '55', lon: 3 }]);
  refused(g, a, 400, /route/, [{ lat: 55, lon: 3 }, { lat: 91, lon: 3 }]);
  refused(g, a, 400, /route/, 'north');
  accepted(g, a, 100, ROUTE);
  accepted(g, a, 400, [[56, 4]]); // [lat, lon] pairs are fine too
  // a snapshot shows other players the factor
  const b = join(g, 'Bob'); g.broadcastSnapshot();
  assert.equal(last(b.ws, 'snap').players.find((x) => x.id === a.p.id).warp, 400);
  // stepping down keeps the route; stepping up again needs one
  accepted(g, a, 100);
  refused(g, a, 400, /route/);
  // 1× is always accepted
  warp(g, a.p, 1); assert.equal(a.p.warp, 1); assert.equal(lastEv(a.ws).kind, 'info'); assert.match(lastEv(a.ws).text, /back to real time/);
  assert.equal(last(a.ws, 'you').you.warp, 1);
});

test('warp: harbour-capped when docked or under tugs; refused when hailed, in the life raft, out of fuel or flooding', () => {
  const g = mkGame(); const d = join(g, 'Dock');
  // V6 item 6: moored, warp goes up to 5× (docs/V6-QUICK-CONTRACTS.md §2)
  assert.equal(d.p.docked, 'rotterdam'); accepted(g, d, 5); refused(g, d, 20, /limited to 5×/);
  warp(g, d.p, 1); assert.equal(d.p.warp, 1, '1× is fine anywhere');
  const a = atSea(g, 'Ann');
  a.p.assist = { harbor: 'rotterdam', berthId: null, from: { lat: 55, lon: 3.5, hdg: 0 }, to: { lat: 55, lon: 3.5, hdg: 0 }, start: Date.now(), until: Date.now() + 45000 };
  accepted(g, a, 5); refused(g, a, 20, /limited to 5×/); warp(g, a.p, 1); a.p.assist = null;
  a.p.hail = { cutter: 'HMCG Test', cutterId: 'x', until: Date.now() + 30000, state: 'hailed' };
  refused(g, a, 5, /coast guard/); a.p.hail = null;
  a.p.rescue = { id: 'r1', kind: 'lifeboat', eta: Date.now() + 60000, harbor: 'rotterdam', lat: 55, lon: 3.5 };
  refused(g, a, 5, /life raft/); a.p.rescue = null;
  a.p.fuel = 0; refused(g, a, 5, /out of fuel/);
  // a sailing yacht with her sails set is driven by the wind, not the tank
  a.p.ship.cls = 'sloop'; a.p.sailsUp = true; accepted(g, a, 5); warp(g, a.p, 1);
  a.p.sailsUp = false; refused(g, a, 5, /out of fuel/);
  a.p.ship.cls = 'coaster'; a.p.sailsUp = true; a.p.fuel = 50;
  a.p.flooding = 0.3; refused(g, a, 5, /taking water \(30 %\)/);
  a.p.flooding = 0.15; accepted(g, a, 5);
});

test('warp: refused within 4 km of a harbour anchor, near another skipper at sea, in a storm and with land ahead above 5×', () => {
  // A built harbour whose anchor lies 10 km west of the raw harbour point: the anchor is what counts.
  const ROT = harborById('rotterdam'), anchor = destination(ROT.lat, ROT.lon, 270, 10000);
  const geom = {
    getHarborGeom: (id) => (id === 'rotterdam' ? { id, berths: [], anchor, origin: { lat: ROT.lat, lon: ROT.lon } } : null),
    getHarborPatch: () => null, nearestBerth: () => null, landPenetration: () => null, sdfAt: () => null,
    harborAnchor: (id) => (id === 'rotterdam' ? anchor : harborById(id) ? { lat: harborById(id).lat, lon: harborById(id).lon } : null),
  };
  const g = mkGame({ harborgeom: geom });
  const near = destination(anchor.lat, anchor.lon, 270, 3000), clear = destination(anchor.lat, anchor.lon, 270, 5000);
  const a = atSea(g, 'Ann', near, { hdg: 270 });
  accepted(g, a, 5); refused(g, a, 20, /Rotterdam \(Maasvlakte\) is 3\.0 km away — inside harbours time warp is limited to 5×/); warp(g, a.p, 1);
  Object.assign(a.p.ship, clear); assert.ok(haversine(clear.lat, clear.lon, ROT.lat, ROT.lon) > 14000);
  accepted(g, a, 5); warp(g, a.p, 1);

  // Other skippers: online and at sea within 20 km blocks; docked or offline ones do not.
  const g2 = mkGame(); const s = atSea(g2, 'Sam', OPEN_A); const t = atSea(g2, 'Tia', destination(OPEN_A.lat, OPEN_A.lon, 90, 15000));
  refused(g2, s, 5, /Tia is 15\.0 km away — warp needs 20\.0 km of sea to yourself/);
  t.p.docked = 'rotterdam'; accepted(g2, s, 5); warp(g2, s.p, 1); t.p.docked = null;
  g2.disconnect(t.p); accepted(g2, s, 5); warp(g2, s.p, 1);
  const t2 = join(g2, 'Tia', t.p.token); assert.equal(t2.p, t.p); refused(g2, s, 5, /Tia/);
  Object.assign(t.p.ship, destination(OPEN_A.lat, OPEN_A.lon, 90, 25000)); accepted(g2, s, 5); warp(g2, s.p, 1);

  // Storm index above MAX_STORM (synthetic cell centred on the ship), fine again once it weakens.
  g2.storms.push({ id: 's1', name: 'Test', lat: OPEN_A.lat, lon: OPEN_A.lon, radiusKm: 100, peak: 1, intensity: 1, driftDir: 90, driftMs: 0, born: g2.simTime, dies: g2.simTime + 3600 });
  assert.ok(g2.weatherAt(OPEN_A.lat, OPEN_A.lon).storm > WARP.MAX_STORM);
  refused(g2, s, 5, /heavy weather/);
  g2.storms[0].intensity = 0.4; accepted(g2, s, 5); warp(g2, s.p, 1);
  g2.storms.length = 0;

  // Land ahead: the coast ~2 km ahead blocks above 5× but not 5×; heading away is fine.
  const draft = SHIP_CLASSES.coaster.draft;
  assert.ok(world.depthAt(DK_COAST.lat, DK_COAST.lon) > 30, 'setup: deep water at the start');
  const at3k = destination(DK_COAST.lat, DK_COAST.lon, 90, WARP.MIN_LAND_M); assert.ok(world.depthAt(at3k.lat, at3k.lon) < draft + 2, 'setup: land 3 km ahead');
  const g3 = mkGame(); const c = atSea(g3, 'Cas', DK_COAST, { hdg: 90 });
  refused(g3, c, 20, /(land|shallows).* km ahead — above 5× you need 3\.0 km of deep water ahead/, ROUTE);
  refused(g3, c, 400, /km ahead/, ROUTE);
  accepted(g3, c, 5); warp(g3, c.p, 1);
  c.p.ship.hdg = 270; accepted(g3, c, 100, ROUTE); warp(g3, c.p, 1);
  // Going astern looks the other way.
  c.p.ship.hdg = 270; c.p.ship.spd = -2; refused(g3, c, 20, /km ahead/); c.p.ship.spd = 10;
  // A spit before MIN_LAND_M with water again behind it is still land ahead.
  const behind = destination(DK_SPIT.lat, DK_SPIT.lon, 90, WARP.MIN_LAND_M); assert.ok(world.depthAt(behind.lat, behind.lon) > draft + 2, 'setup: water 3 km ahead');
  const spit = destination(DK_SPIT.lat, DK_SPIT.lon, 90, 2000); assert.ok(world.depthAt(spit.lat, spit.lon) < draft + 2, 'setup: spit 2 km ahead');
  Object.assign(c.p.ship, DK_SPIT, { hdg: 90 }); refused(g3, c, 20, /km ahead/);
});

test('warp: the movement budget scales with the factor and keeps the old factor for a moment after a drop', () => {
  const g = mkGame(); const a = atSea(g, 'Ann', OPEN_A, { hdg: 0 });
  const tryJump = (m) => {
    const lat0 = a.p.ship.lat, to = destination(a.p.ship.lat, a.p.ship.lon, 0, m);
    a.p.moveBudget = 0; a.p.lastState = Date.now() - 2000; a.ws.sent.length = 0;
    g.onState(a.p, { lat: to.lat, lon: to.lon, hdg: 0, spd: 14, throttle: 1, rudder: 0 });
    const ok = a.p.ship.lat !== lat0;
    if (!ok) assert.ok(last(a.ws, 'you').correction, 'rejections answer with a correction');
    return ok;
  };
  // coaster: (14 kn × 1.35 + 1.5 m/s) ≈ 11.2 m/s → 22 m in 2 s at 1×, 2.2 km at 100×
  assert.equal(tryJump(2000), false, '2 km in 2 s is a teleport at 1×');
  assert.equal(tryJump(20), true);
  warp(g, a.p, 100, ROUTE); assert.equal(a.p.warp, 100);
  assert.equal(tryJump(2000), true, '2 km in 2 s is plausible at 100×');
  assert.equal(tryJump(3000), false, 'but 3 km is not');
  warp(g, a.p, 1); assert.equal(a.p.warp, 1);
  assert.equal(tryJump(2000), true, 'states sent before the client heard of the drop are still accepted');
  a.p.warpGraceUntil = Date.now() - 1;
  assert.equal(tryJump(2000), false, 'grace over: back to the real-time budget');
  // a server-side drop starts the grace as well
  warp(g, a.p, 20); a.p.flooding = 0.5; g.tick(0.1); assert.equal(a.p.warp, 1);
  a.p.flooding = 0; assert.equal(tryJump(400), true, '400 m in 2 s is within the 20× budget during the grace');
});

test('warp: fuel, hull wear, crew wages and the fishing catch scale with the factor', (t) => {
  // The North Sea is an ECA: the politics layer adds a fuel surcharge in whole credits to p.money. Switch it off here so
  // the money delta is the crew wages alone (the surcharge is accrued per whole credit and would skew the ratio).
  const ecaWas = POL.ECA_ON; POL.ECA_ON = false; t.after(() => { POL.ECA_ON = ecaWas; });
  const g = mkGame();
  const ship = { cls: 'coaster', hdg: 0, spd: 14, throttle: 1 };
  const a = atSea(g, 'Ann', OPEN_B, ship), b = atSea(g, 'Bob', OPEN_A, ship);
  for (const q of [a.p, b.p]) { q.fuel = 80; q.cond = 100; q.money = 1000; q.serviceDue = g.simTime + 1e6; }
  accepted(g, b, 100, ROUTE);
  g.tick(1);
  assert.equal(b.p.warp, 100, 'still warped after the tick'); assert.equal(a.p.warp, 1);
  const fuelA = 80 - a.p.fuel, fuelB = 80 - b.p.fuel, wearA = 100 - a.p.cond, wearB = 100 - b.p.cond, payA = 1000 - a.p.money, payB = 1000 - b.p.money;
  assert.ok(fuelA > 0 && wearA > 0 && payA > 0);
  assert.ok(Math.abs(fuelB / fuelA - 100) < 1e-4, `fuel ×${fuelB / fuelA}`);
  assert.ok(Math.abs(wearB / wearA - 100) < 1e-4, `wear ×${wearB / wearA}`);
  assert.ok(Math.abs(payB / payA - 100) < 1e-4, `wages ×${payB / payA}`);
  // Fishing on the Dogger Bank: 3 real minutes at 1× and at 100× (trawler: 3 × 1.0 × 10 = 30 t/h).
  const g2 = mkGame(); const f = atSea(g2, 'Fin', { lat: 54.7, lon: 2.8 }, { cls: 'trawler', spd: 1, throttle: 0.1 });
  f.p.fuel = 40; f.p.money = 1e6;
  g2.onAction(f.p, { action: 'fish', on: true }); assert.equal(f.p.fishing, true);
  const caught = () => f.p.cargo.filter((c) => c.good === 'fish' && c.caught).reduce((s, c) => s + c.qty, 0);
  g2.tick(180); const c1 = caught();
  assert.ok(Math.abs(c1 - 1.5) < 0.051, `1×: ${c1} t`);
  accepted(g2, f, 100, ROUTE);
  g2.tick(180); const c2 = caught() - c1;
  assert.ok(Math.abs(c2 - 150) < 0.051, `100×: ${c2} t`);
  assert.equal(f.p.warp, 100);
});

test('warp: auto-drop near a harbour, with land ahead, near another skipper, on a hail, in a storm and on damage', () => {
  const g = mkGame(); const a = atSea(g, 'Ann', OPEN_A);
  const dropped = (re, factor) => {
    assert.equal(a.p.warp, 1, 'dropped to 1×');
    const ev = evs(a.ws).reverse().find((e) => /Time warp off/.test(e.text));
    assert.ok(ev, 'a drop event'); assert.equal(ev.kind, 'warn'); assert.match(ev.text, new RegExp(`\\(${factor}× → 1×\\)`)); assert.match(ev.text, re);
    assert.equal(last(a.ws, 'you').you.warp, 1, 'the client hears about it at once');
    a.ws.sent.length = 0;
  };
  // V6 item 6: entering a harbour zone above 5× steps down to 5×, it does not stop dead
  const capped = (re, from) => {
    assert.equal(a.p.warp, 5, 'capped to 5×');
    const ev = evs(a.ws).reverse().find((e) => /Time warp \d+× → 5×/.test(e.text));
    assert.ok(ev, 'a cap event'); assert.equal(ev.kind, 'warn'); assert.match(ev.text, new RegExp(`${from}× → 5×`)); assert.match(ev.text, re);
    assert.equal(last(a.ws, 'you').you.warp, 5, 'the client hears about it at once');
    a.ws.sent.length = 0;
  };
  // harbour: steaming into the 4 km circle around Rotterdam (no geometry: the harbour's own point)
  accepted(g, a, 20); g.tick(0.1); assert.equal(a.p.warp, 20, 'open sea: stays warped');
  const ROT = harborById('rotterdam'); Object.assign(a.p.ship, destination(ROT.lat, ROT.lon, 270, 3500), { hdg: 270 });
  g.tick(0.1); capped(/Rotterdam \(Maasvlakte\) is 3\.5 km away — 5× at most inside harbours/, 20);
  warp(g, a.p, 1); Object.assign(a.p.ship, OPEN_A, { hdg: 0 }); a.ws.sent.length = 0;
  // land ahead: turning toward the Danish coast at 20× drops, 5× carries on
  Object.assign(a.p.ship, DK_COAST, { hdg: 270 });
  accepted(g, a, 100, ROUTE); g.tick(0.1); assert.equal(a.p.warp, 100);
  a.p.ship.hdg = 90; g.tick(0.1); dropped(/(Land|Shallows).* km ahead/, 100);
  accepted(g, a, 5); g.tick(0.1); assert.equal(a.p.warp, 5, '5× is allowed close to land'); warp(g, a.p, 1);
  // a fast hull at 400× looks further ahead than MIN_LAND_M: 1.5 km further off the coast (land ~3.5 km ahead)
  // 100× carries on, 400× (1.5 s × 14 kn × 400 ≈ 4.3 km look-ahead) drops
  Object.assign(a.p.ship, destination(DK_COAST.lat, DK_COAST.lon, 270, 1500), { hdg: 270, spd: 14 });
  accepted(g, a, 400, ROUTE); a.p.ship.hdg = 90; g.tick(0.1); dropped(/km ahead/, 400);
  accepted(g, a, 100, ROUTE); g.tick(0.1); assert.equal(a.p.warp, 100, '100× only needs MIN_LAND_M here'); warp(g, a.p, 1);
  a.ws.sent.length = 0;
  // another skipper closing in
  Object.assign(a.p.ship, OPEN_A, { hdg: 0, spd: 10 });
  const b = atSea(g, 'Bea', destination(OPEN_A.lat, OPEN_A.lon, 180, 50000));
  accepted(g, a, 20); g.tick(0.1); assert.equal(a.p.warp, 20);
  Object.assign(b.p.ship, destination(OPEN_A.lat, OPEN_A.lon, 180, 12000)); g.tick(0.1); dropped(/Bea is 12\.0 km away/, 20);
  Object.assign(b.p.ship, OPEN_B);
  // coast-guard hail drops it immediately (not only on the next tick)
  accepted(g, a, 20); g.hail(g.cutters[0], a.p); dropped(/is hailing you/, 20);
  g.clearHail(g.cutters[0], a.p); assert.equal(a.p.hail, null);
  // storm moving over the ship (half-way through its life = at its peak when updateStorms runs in the tick)
  accepted(g, a, 20);
  g.storms.push({ id: 's1', name: 'Test', lat: OPEN_A.lat, lon: OPEN_A.lon, radiusKm: 100, peak: 1, intensity: 1, driftDir: 90, driftMs: 0, born: g.simTime - 1800, dies: g.simTime + 1800 });
  g.tick(0.1); dropped(/heavy weather/i, 20); g.storms.length = 0;
  // flooding, empty tanks
  accepted(g, a, 20); a.p.flooding = 0.25; g.tick(0.1); dropped(/taking water/i, 20); a.p.flooding = 0;
  accepted(g, a, 20); a.p.fuel = 0; g.tick(0.1); dropped(/out of fuel/i, 20); a.p.fuel = 50;
  // collisions and groundings reported by the client
  accepted(g, a, 20); g.onAction(a.p, { action: 'collision', speedKn: 5, kind: 'ship' }); dropped(/Contact with another ship/, 20);
  accepted(g, a, 20); g.onAction(a.p, { action: 'grounding' }); dropped(/Aground/, 20);
  // a tow puts the ship in harbour
  accepted(g, a, 20); g.onAction(a.p, { action: 'tow' }); dropped(/In harbour/, 20); assert.ok(a.p.docked);
});

test('warp: never resumed — reconnect, disconnect and a restart all come back at 1×', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saltline-warp-')); const file = path.join(dir, 'state.json');
  const g = new Game(world, () => {}, { stateFile: file }); g.rnd = () => 0.5;
  const a = atSea(g, 'Ann', OPEN_A);
  accepted(g, a, 100, ROUTE);
  // the same skipper reconnecting (page reload) starts in real time
  const a2 = join(g, 'Ann', a.p.token); assert.equal(a2.p, a.p); assert.equal(a.p.warp, 1); assert.equal(last(a2.ws, 'welcome').you.warp, 1);
  accepted(g, a2, 100, ROUTE);
  g.disconnect(a.p); assert.equal(a.p.warp, 1, 'offline ships sail in real time');
  // state written while warped is saved and loaded at 1×
  const a3 = join(g, 'Ann', a.p.token); accepted(g, a3, 100, ROUTE);
  g.saveState();
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')).players.find((x) => x.token === a.p.token);
  assert.equal(saved.warp, 1); assert.equal(saved.warpRouted, false);
  // even a state file that says otherwise
  const s = JSON.parse(fs.readFileSync(file, 'utf8')); s.players[0].warp = 400; s.players[0].warpRouted = true; s.players[0].warpGraceUntil = Date.now() + 1e9; s.players[0].warpGraceFactor = 400;
  fs.writeFileSync(file, JSON.stringify(s));
  const g2 = new Game(world, () => {}, { stateFile: file });
  const q = g2.players.get(a.p.token);
  assert.equal(q.warp, 1); assert.equal(q.warpRouted, false); assert.equal(g2.warpBudgetFactor(q), 1); assert.equal(g2.publicState(q).warp, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('warp: you.warpLimit gives the HUD the highest level allowed right now and why not higher', () => {
  const g = mkGame(); const d = join(g, 'Dock');
  assert.deepEqual(g.privateState(d.p).warpLimit, { max: 5, reason: 'Moored in Rotterdam (Maasvlakte) — 5× at most inside harbours.', routeAbove: 20,
    harbour: { id: 'rotterdam', name: 'Rotterdam (Maasvlakte)', distM: 0, kind: 'moored' } });
  const a = atSea(g, 'Ann', OPEN_A);
  g.sendYou(a.p); assert.deepEqual(last(a.ws, 'you').you.warpLimit, { max: 400, reason: null, routeAbove: 20 });
  Object.assign(a.p.ship, DK_COAST, { hdg: 90 });
  const lim = g.privateState(a.p).warpLimit; assert.equal(lim.max, 5); assert.match(lim.reason, /km ahead/);
  // 3.5 km off the coast a fast hull can still do 100× but not 400× (its 1.5 s look-ahead at 400× is longer)
  Object.assign(a.p.ship, destination(DK_COAST.lat, DK_COAST.lon, 270, 1500), { spd: 14 });
  const lim2 = g.privateState(a.p).warpLimit; assert.equal(lim2.max, 100); assert.match(lim2.reason, /km ahead/);
});
