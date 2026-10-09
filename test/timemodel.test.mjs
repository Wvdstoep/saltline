// V6 item 5 — the time model (docs/V6-QUICK-CONTRACTS.md §5): one clock for the world, one for your ship. The ship's
// clock runs at the warp factor; contract time is a budget of ship hours counted on it; generated contracts are feasible
// by construction for the reference ship they are rated for; every per-tick quantity accumulates exactly at the real
// 10 Hz tick whatever the warp.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { World } from '../server/world.js';
import { carvingsForWorld, harborById, HARBORS } from '../server/harbors.js';
import { Game } from '../server/game.js';
import { generateJob, generateSmugglingJob, publicJob, serviceWearMul, cargoMass } from '../server/economy.js';
import { encodePatch } from '../server/harborgeom.js';
import * as TP from '../server/tugpath.js';
import { tugOp } from '../server/tugassist.js';
import { WARP, SHIP_CLASSES, GEO, encodePatchHeight } from '../shared/constants.js';
import { fuelBurnPerSimHour, wearPerSimHour, headwindFactor } from '../shared/physics.js';
import { RATES, serviceKn, catchRate, serviceBurnTph, kmHours } from '../shared/rates.js';
import { JOBTIME, needFor, budgetFor, estimateJob, hardReason, fmtShipH, fmtRealHM, jobLabel, refClassFor } from '../shared/jobtime.js';
import { haversine, bearing } from '../shared/geo.js';
import { POL } from '../shared/politics.js';

process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
const world = new World().load(carvingsForWorld(), () => {});
const ROT = harborById('rotterdam');

function fakeSocket() { return { readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); }, close() {} }; }
// rnd = 0.5: the fallback wind stays put, no storms spawn, no coast-guard hails, no port inspections.
function mkGame(opts = {}) { const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-timemodel-state.json', ...opts }); g.saveState = () => {}; g.rnd = () => 0.5; return g; }
function join(g, name, tok = null) { const ws = fakeSocket(); const p = g.connect(ws, tok, name); return { p, ws }; }
const evs = (ws) => ws.sent.filter((m) => m.t === 'event').map((m) => m.text);
const lastYou = (ws) => [...ws.sent].reverse().find((m) => m.t === 'you')?.you;
const ROUTE = [{ lat: 56.2, lon: 3.6 }, { lat: 57, lon: 4 }];
const OPEN_A = { lat: 55.0, lon: 3.5 };   // open North Sea, > 100 km from any harbour
const OPEN_B = { lat: 55.0, lon: 2.0 };
const DOGGER = { lat: 54.7, lon: 2.8 };
function atSea(g, name, pos = OPEN_A, ship = {}) {
  const j = join(g, name);
  g.onAction(j.p, { action: 'undock' });
  Object.assign(j.p.ship, { lat: pos.lat, lon: pos.lon, hdg: 0, spd: 10, throttle: 1, rudder: 0 }, ship);
  j.p.lastValid = { lat: pos.lat, lon: pos.lon };
  return j;
}
const warp = (g, p, factor, route = ROUTE) => g.onAction(p, { action: 'set_warp', factor, route: factor > WARP.MAX_NO_ROUTE ? route : undefined });
function ticks(g, n, dt = 0.1) { for (let i = 0; i < n; i++) g.tick(dt); }
function seeded(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rel = (a, b) => Math.abs(a - b) / Math.max(1e-12, Math.abs(b));

// ------------------------------------------------------------------------------------------------ 1. numbers
test('rates.js reference numbers and jobtime.js labels (§1.5, §5.4)', () => {
  assert.ok(Math.abs(serviceKn('coaster') - 11.2) < 1e-9 && Math.abs(serviceKn('coaster', 1) - 9.52) < 1e-9 && Math.abs(serviceKn('trawler') - 9.6) < 1e-9);
  assert.ok(Math.abs(catchRate('coaster', 0.7) - 4.2) < 1e-9 && Math.abs(catchRate('trawler', 1) - 30) < 1e-9);
  assert.ok(Math.abs(serviceBurnTph('coaster') - 0.9 * (0.1 + 0.9 * 0.8 ** 3)) < 1e-9 && Math.abs(serviceBurnTph('coaster') - 0.50472) < 1e-6);
  assert.equal(catchRate('nope', 1), 0); assert.equal(kmHours(18.52, 10), 1);
  const ship = { cls: 'coaster', holdFreeT: 1200, paxFree: 12 };
  assert.equal(estimateJob({ type: 'fishing', qty: 100, richness: 0.7, groundKm: 0, hours: 40 }, ship).label, 'with your ship: ~24 h fishing (≈ 1 h 12 m at 20×)');
  const n2 = needFor({ type: 'fishing', qty: 100, richness: 0.7, groundKm: 20.61 }, 'coaster');
  assert.ok(Math.abs(n2.sailH - 2) < 0.005, `sail ${n2.sailH}`);
  assert.equal(estimateJob({ type: 'fishing', qty: 100, richness: 0.7, groundKm: 20.61, hours: 40 }, ship).label, 'with your ship: ~24 h fishing + 2 h sailing (≈ 1 h 18 m at 20×)');
  assert.equal(fmtShipH(0.5), '30 min'); assert.equal(fmtShipH(3.5), '3.5 h'); assert.equal(fmtShipH(4.0), '4 h'); assert.equal(fmtShipH(23.8), '24 h');
  assert.equal(fmtRealHM(1.2), '1 h 12 m'); assert.equal(fmtRealHM(0.55), '33 m');
  assert.match(jobLabel(needFor({ type: 'tow', towKm: { toCasualty: 40, toDest: 60 } }, 'tug'), 20), /^with your ship: ~\S+ h towing \(≈ \d+ m at 20×\)$/);
  assert.match(jobLabel(needFor({ type: 'freight', qty: 400, seaKm: 300 }, 'coaster'), 5), /^with your ship: ~\d+ h sailing \(≈ \d+ h \d+ m at 5×\)$/);
  // the hard reasons are the harbour sheet's texts
  assert.equal(hardReason({ type: 'charter', pax: 4, needsCat: ['motor yacht', 'sailing yacht', 'passenger'] }, ship), 'needs a yacht or ferry');
  assert.equal(hardReason({ type: 'passengers', pax: 20 }, ship), 'needs 20 berths (12 free)');
  assert.equal(hardReason({ type: 'fishing', qty: 20 }, { cls: 'tanker' }), 'this hull cannot fish');
  assert.equal(hardReason({ type: 'fishing', qty: 400 }, { cls: 'trawler' }), 'hold too small for 400 t');
  assert.equal(hardReason({ type: 'freight', qty: 2500 }, ship), 'needs 2,500 t of hold (1,200 t free)');
  assert.equal(hardReason({ type: 'tow' }, ship), null);
});

// ------------------------------------------------------------------------------------------------ 2. generation
test('generated contracts are feasible by construction for their reference ship (3,000 jobs, 10 harbours)', () => {
  const hs = ['rotterdam', 'hamburg', 'antwerp', 'ijmuiden', 'felixstowe', 'aberdeen', 'bergen', 'esbjerg', 'le_havre', 'gothenburg'].map(harborById).filter(Boolean);
  for (const h of HARBORS) { if (hs.length >= 10) break; if (!hs.includes(h) && h.lat > 50 && h.lat < 62 && h.lon > -6 && h.lon < 12) hs.push(h); }
  assert.equal(hs.length, 10);
  let pair = null, stubbed = 0;
  const env = { seaKm: (a, b) => { if (!pair) pair = `${a}>${b}`; return `${a}>${b}` === pair ? 500 : null; } };
  const rnd = seeded(42), now = 1.8e9;
  const seen = new Set();
  let n = 0;
  for (const h of hs) for (let k = 0; k < 300; k++) {
    const j = k % 25 === 24 ? generateSmugglingJob(h, now, rnd, env) : generateJob(h, now, rnd, undefined, env);
    if (!j) continue;
    n++; seen.add(j.type);
    assert.ok(Number.isInteger(j.hours) && j.hours >= JOBTIME.MIN_HOURS, `${j.type} hours ${j.hours}`);
    assert.equal(j.postedAt, now); assert.equal(j.expiresAt - j.postedAt, 86400);
    assert.ok(!('deadline' in j), 'no world-clock deadline');
    assert.ok(j.ref && SHIP_CLASSES[j.ref.cls] && j.ref.margin >= 1.4 && j.ref.margin <= 1.8, JSON.stringify(j.ref));
    const est = estimateJob(j, { cls: j.ref.cls, holdFreeT: Infinity, paxFree: Infinity });
    assert.ok(est.ok, `${j.type} ${j.title}: ${est.why}`);
    assert.ok(j.hours >= needFor(j, j.ref.cls).needH * 1.4 - 1e-9, `${j.type}: ${j.hours} h for a need of ${needFor(j, j.ref.cls).needH}`);
    if (j.type === 'fishing') { assert.ok(j.qty >= 20 && j.qty <= 140 && j.qty % 5 === 0); assert.ok(j.groundKm >= 0 && j.richness > 0); }
    if (['freight', 'passengers', 'charter', 'smuggling'].includes(j.type)) {
      if (`${j.from}>${j.to}` === pair) { assert.equal(j.seaKm, 500); stubbed++; } else assert.ok(Math.abs(j.seaKm - j.distKm * RATES.DETOUR) <= 0.7, `${j.seaKm} vs ${j.distKm}`);
    }
    if (j.type === 'supply') assert.ok(j.platformKm > 0);
    if (j.type === 'tow') assert.ok(j.towKm.toCasualty > 0 && j.towKm.toDest > 0);
  }
  assert.ok(n >= 2900, `${n} jobs`);
  assert.ok(stubbed >= 1, 'the route table distance is used');
  for (const t of ['fishing', 'freight', 'passengers', 'charter', 'supply', 'tow', 'smuggling']) assert.ok(seen.has(t), `generated ${t}`);
  // the reference ship: the right class per type
  assert.equal(refClassFor({ type: 'freight', qty: 1200 }), 'coaster'); assert.equal(refClassFor({ type: 'freight', qty: 4000 }), 'feeder'); assert.equal(refClassFor({ type: 'freight', qty: 8000 }), 'bulker');
  assert.equal(refClassFor({ type: 'passengers', pax: 12 }), 'coaster'); assert.equal(refClassFor({ type: 'passengers', pax: 13 }), 'ferry');
  assert.equal(refClassFor({ type: 'charter' }), 'sloop'); assert.equal(refClassFor({ type: 'supply' }), 'psv'); assert.equal(refClassFor({ type: 'tow' }), 'tug');
  assert.equal(refClassFor({ type: 'fishing' }, () => 0.5), 'trawler'); assert.equal(refClassFor({ type: 'fishing' }, () => 0.6), 'coaster');
});

// ------------------------------------------------------------------------------------------------ 3. the player's case
test("the player's case: 100 t on the Southern Bight with a coaster", () => {
  const job = { type: 'fishing', qty: 100, richness: 0.7, groundKm: 34.7, hours: 15 };
  const tight = estimateJob(job, { cls: 'coaster', holdFreeT: 1200, paxFree: 12 });
  assert.equal(tight.ok, false); assert.equal(tight.hard, null);
  assert.match(tight.why, /too slow for your ship: needs ~27 h, the contract allows 15 h/);
  assert.ok(estimateJob({ ...job, hours: 45 }, { cls: 'coaster' }).ok);
  assert.ok(estimateJob(job, { cls: 'trawler' }).ok, 'a trawler makes it in 15 h');
  // the worked example's budgets: trawler-rated 15–18 h, coaster-rated 41–51 h
  assert.equal(budgetFor(job, 'trawler', 1.4), 15); assert.equal(budgetFor(job, 'trawler', 1.8), 18);
  assert.equal(budgetFor(job, 'coaster', 1.4), 41); assert.equal(budgetFor(job, 'coaster', 1.8), 51);
  assert.equal(estimateJob({ ...job, hours: 45 }, { cls: 'coaster' }).label, 'with your ship: ~24 h fishing + 3.4 h sailing (≈ 1 h 22 m at 20×)');
});

// ------------------------------------------------------------------------------------------------ 4. ship clock at 10 Hz
test('the ship clock runs at the warp factor at the real 10 Hz tick (1×, 5×, 20×, 100×, 400×)', () => {
  const g = mkGame();
  const a = atSea(g, 'Clock');
  for (const L of [1, 5, 20, 100, 400]) {
    warp(g, a.p, L);
    assert.equal(a.p.warp, L, `${L}× accepted (${evs(a.ws).at(-1)})`);
    const t0 = a.p.shipTime, n = 3600 / L;
    ticks(g, n);
    assert.equal(a.p.warp, L, 'still warped');
    assert.ok(Math.abs(a.p.shipTime - t0 - 360) < 1e-3, `${L}×: +${a.p.shipTime - t0} s of ship time`);
    g.sendYou(a.p); const y = lastYou(a.ws);
    assert.equal(y.shipRate, L); assert.ok(Math.abs(y.shipTime - a.p.shipTime) <= 0.05);
    if (L > 1) assert.ok(y.warpRun && Math.abs(y.warpRun.shipStart - t0) <= 0.05 && y.warpRun.worldStart > 1e9, 'warpRun marks where warp began');
    else assert.equal(y.warpRun, null);
    warp(g, a.p, 1); ticks(g, 1);
    assert.equal(a.p.warpRun, null, 'cleared at 1×');
  }
  // docked: 1×; docked at 5× (harbour warp): 5×
  const d = join(g, 'Moored');
  assert.ok(d.p.docked); let t0 = d.p.shipTime; ticks(g, 100); assert.ok(Math.abs(d.p.shipTime - t0 - 10) < 1e-3, 'docked 1×');
  if (WARP.HARBOR_MAX) {
    warp(g, d.p, 5); assert.equal(d.p.warp, 5, evs(d.ws).at(-1));
    t0 = d.p.shipTime; ticks(g, 100); assert.ok(Math.abs(d.p.shipTime - t0 - 50) < 1e-3, `docked 5×: ${d.p.shipTime - t0}`);
    warp(g, d.p, 1);
  }
  // offline idle: 1×; offline voyage: 1×; life raft: 1×
  g.disconnect(d.p); t0 = d.p.shipTime; ticks(g, 100); assert.ok(Math.abs(d.p.shipTime - t0 - 10) < 1e-3, 'offline idle');
  const v = atSea(g, 'Voyager', OPEN_B);
  g.onAction(v.p, { action: 'set_voyage', route: [[56.5, 2.0]], throttle: 0.7 });
  g.disconnect(v.p); assert.ok(v.p.voyage);
  t0 = v.p.shipTime; ticks(g, 100); assert.ok(Math.abs(v.p.shipTime - t0 - 10) < 1e-3, 'offline voyage');
  const r = atSea(g, 'Raft', { lat: 56, lon: 4 });
  warp(g, r.p, 20); r.p.rescue = { id: 'rx', kind: 'lifeboat', eta: Date.now() + 1e7, harbor: 'rotterdam', lat: 56, lon: 4 };
  t0 = r.p.shipTime; ticks(g, 100); assert.ok(Math.abs(r.p.shipTime - t0 - 10) < 1e-3, 'life raft 1×');
});

// tug assist on a synthetic harbour patch (helpers copied from test/tugs.test.mjs)
const N = 160, RES = 10;
function synthPatch() {
  const mask = new Uint8Array(N * N), heights = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i, x = (i + 0.5 - N / 2) * RES, z = (j + 0.5 - N / 2) * RES;
    let m = 0, h = -12;
    if (x > 300) { m = 1; h = 3; } else if (x > 290) { m = 2; h = 2.5; }
    else if (Math.abs(z) < 20 && x > -200) { m = 2; h = 2.5; }
    mask[k] = m; heights[k] = encodePatchHeight(h);
  }
  return encodePatch({ n: N, res: RES, originLat: ROT.lat, originLon: ROT.lon, synthetic: true, heights, mask });
}
function patchGeom(buf, berths, anchorXZ = [-500, -300]) {
  const grid = TP.gridFromPatch(buf);
  const anchor = TP.toLL(grid, ...anchorXZ);
  const geom = { id: 'rotterdam', name: ROT.name, source: 'synthetic', origin: { lat: ROT.lat, lon: ROT.lon }, anchor, n: N, res: RES, berths, fairway: [], features: {} };
  return {
    getHarborGeom: (id) => (id === 'rotterdam' ? geom : null),
    getHarborPatch: (id) => (id === 'rotterdam' ? buf : null),
    harborAnchor: (id) => (id === 'rotterdam' ? anchor : harborById(id) ? { lat: harborById(id).lat, lon: harborById(id).lon } : null),
    nearestBerth(id, lat, lon) { if (id !== 'rotterdam' || !berths.length) return null; let best = null; for (const b of berths) { const d = haversine(lat, lon, b.lat, b.lon); if (!best || d < best.distM) best = { berth: b, distM: d, brg: bearing(lat, lon, b.lat, b.lon) }; } return best; },
    landPenetration: (lat, lon) => { const [x, z] = TP.toXZ(grid, lat, lon); if (!TP.inGrid(grid, x, z, 0)) return null; const c = TP.clearanceAt(grid, x, z); return c < 0 ? -c : 0; },
    sdfAt: (id, lat, lon) => { const [x, z] = TP.toXZ(grid, lat, lon); return TP.inGrid(grid, x, z, 0) ? TP.clearanceAt(grid, x, z) : null; },
  };
}
test('under tugs the ship clock runs at the tug op time compression (rate 3 → 3×)', () => {
  const buf = synthPatch(), grid = TP.gridFromPatch(buf), ll = TP.toLL(grid, 288, 150);
  const berth = { id: 'rotterdam-b1', name: 'Berth 1', lat: ll.lat, lon: ll.lon, hdg: 0, length: 300, depth: 12, kind: 'quay', maxLength: 300 };
  const g = mkGame({ harborgeom: patchGeom(buf, [berth]) });
  const { p, ws } = join(g, 'Towed'); p.money = 50000;
  g.onAction(p, { action: 'undock' });
  const st = TP.toLL(grid, 100, -250); p.ship.lat = st.lat; p.ship.lon = st.lon; p.ship.spd = 0;
  g.onAction(p, { action: 'tug_assist' });
  assert.ok(p.assist?.opId, evs(ws).at(-1));
  const op = tugOp(g, p.id); op.rate = 3;
  const t0 = p.shipTime; ticks(g, 20);
  assert.ok(p.assist, 'still under tugs');
  assert.ok(Math.abs(p.shipTime - t0 - 6) < 1e-3, `+${p.shipTime - t0} s for 2 s of real time`);
  assert.equal(g.shipRate(p), 3);
});

// ------------------------------------------------------------------------------------------------ 5. exact accounting
test('fuel, wear, wages, flooding and the catch add up exactly per ship hour at every warp level (10 Hz)', (t) => {
  // The North Sea is an ECA: the politics fuel surcharge also comes off p.money. Off here so the money delta is wages only.
  const ecaWas = POL.ECA_ON; POL.ECA_ON = false; t.after(() => { POL.ECA_ON = ecaWas; });
  const perHour = {};
  for (const L of [1, 5, 20, 100, 400]) {
    const g = mkGame();
    const a = atSea(g, 'Acct');
    const p = a.p, C = SHIP_CLASSES.coaster;
    p.flooding = 0.2; // the most warp allows; the pumps clear 0.3 per ship hour on a sound hull
    if (L > 1) { warp(g, p, L); assert.equal(p.warp, L, evs(a.ws).at(-1)); }
    ticks(g, 1); // the fallback wind settles on its first update
    const wx = g.weatherAt(p.ship.lat, p.ship.lon);
    const n = L === 1 ? 3600 : 36000 / L, scale = L === 1 ? 10 : 1; // 1×: 6 ship minutes, compared per hour
    const fuel0 = p.fuel, cond0 = p.cond, money0 = p.money, flood0 = p.flooding;
    ticks(g, n / 2);
    const floodHalf = p.flooding; // the pumps clear 0.2 within the hour: compare the first half hour
    ticks(g, n / 2);
    assert.equal(p.warp, L);
    const hrs = 0.1 * L / 3600, wearH = wearPerSimHour(1, wx.wind.spd, C.wearMul) * serviceWearMul(p.serviceDue, g.simTime);
    // burn depends linearly on the condition, which falls by the same step every tick: the mean over the ticks
    const burnH = fuelBurnPerSimHour('coaster', 1, 0, headwindFactor(0, wx.wind), cond0 - wearH * hrs * (n - 1) / 2);
    const got = { fuel: (fuel0 - p.fuel) * scale, wear: (cond0 - p.cond) * scale, wages: (money0 - p.money) * scale, pumped: (flood0 - floodHalf) * 2 * scale };
    assert.ok(rel(got.fuel, burnH) < 1e-7, `${L}× fuel ${got.fuel} vs ${burnH}`);
    assert.ok(rel(got.wear, wearH) < 1e-7, `${L}× wear ${got.wear} vs ${wearH}`);
    assert.ok(rel(got.wages, C.crewCost) < 1e-7, `${L}× wages ${got.wages} vs ${C.crewCost}`);
    assert.ok(rel(got.pumped, 0.3) < 1e-7, `${L}× pump-out ${got.pumped}`);
    perHour[L] = got;
    // a trawler fishing on the Dogger Bank: catchRate('trawler', 1) per ship hour
    const f = atSea(g, 'Nets', DOGGER, { spd: 2, throttle: 0.2 });
    f.p.ship.cls = 'trawler'; f.p.fuel = SHIP_CLASSES.trawler.fuelCap; f.p.cargo = [];
    if (L > 1) { warp(g, a.p, 1); warp(g, f.p, L); assert.equal(f.p.warp, L, evs(f.ws).at(-1)); }
    f.p.fishing = true; f.p.fishInfo = null; f.p.cargo = [];
    ticks(g, n);
    const caught = (f.p.cargo.find((c) => c.good === 'fish' && c.caught)?.qty || 0) * scale;
    assert.ok(rel(caught, catchRate('trawler', 1)) < 1e-9, `${L}× caught ${caught} t per ship hour`);
    assert.ok(rel(f.p.fishInfo.caughtRaw * scale, catchRate('trawler', 1)) < 1e-9);
    assert.equal(cargoMass(f.p.cargo) * scale, caught);
  }
  for (const k of ['wages', 'pumped']) for (const L of [5, 20, 100, 400]) assert.ok(rel(perHour[L][k], perHour[1][k]) < 1e-7, `${k} identical at ${L}×`);
});

// ------------------------------------------------------------------------------------------------ 6. deadlines on the ship clock
function freightRun(nTicks) {
  const g = mkGame();
  const { p, ws } = join(g, 'Due');
  g.harbors.rotterdam.jobs.push({ id: 'jdue', type: 'freight', from: 'rotterdam', to: 'ijmuiden', good: 'grain', qty: 100, pay: 10000, distKm: 60, seaKm: 75, hours: 10, contraband: false, title: 'Freight 100 t of grain to IJmuiden' });
  g.onAction(p, { action: 'accept_job', jobId: 'jdue' });
  const j = p.jobs.find((x) => x.id === 'jdue'); assert.ok(j, evs(ws).at(-1));
  assert.equal(j.hours, 10); assert.equal(j.dueShip - j.acceptedShip, 36000); assert.ok(!('deadline' in j));
  g.onAction(p, { action: 'undock' });
  Object.assign(p.ship, { lat: OPEN_A.lat, lon: OPEN_A.lon, hdg: 0, spd: 10, throttle: 1 }); p.lastValid = { ...OPEN_A };
  const t0 = p.shipTime;
  if (nTicks.L > 1) { warp(g, p, nTicks.L); assert.equal(p.warp, nTicks.L, evs(ws).at(-1)); }
  ticks(g, nTicks.n, nTicks.dt || 0.1);
  warp(g, p, 1);
  const used = p.shipTime - t0;
  const ij = harborById('ijmuiden'), a = g.harborAnchor(ij);
  p.ship.lat = a.lat; p.ship.lon = a.lon; p.ship.spd = 0; p.ship.throttle = 0;
  const money = p.money;
  g.setDocked(p, ij.id, null); g.finishDock(p, ij);
  return { got: p.money - money, used, texts: evs(ws), p, paid: evs(ws).find((t) => /^(Delivered|Late delivery \(half pay\)): Freight 100 t/.test(t)) || '' };
}
test('contract hours count on the ship clock: warp saves real time, it does not cheat the deadline', () => {
  const onTime = freightRun({ L: 100, n: 3590 });
  assert.ok(Math.abs(onTime.used - 35900) < 0.01, `${onTime.used} s`);
  assert.match(onTime.paid, /^Delivered: Freight 100 t of grain to IJmuiden — \+1\d,\d{3} cr/, onTime.texts.slice(-3).join(' | '));
  assert.ok(onTime.texts.some((t) => /^2 h of ship time left: Freight 100 t/.test(t)));
  const late = freightRun({ L: 100, n: 3610 });
  assert.ok(Math.abs(late.used - 36100) < 0.01);
  assert.match(late.paid, /^Late delivery \(half pay\): Freight 100 t of grain to IJmuiden — \+[56],\d{3} cr/, late.texts.slice(-3).join(' | '));
  assert.equal(late.texts.filter((t) => /^Deadline passed: Freight 100 t/.test(t)).length, 1);
  // at 1×, 9 ship hours later the same delivery is on time
  const slow = freightRun({ L: 1, n: 9 * 3600, dt: 1 });
  assert.ok(Math.abs(slow.used - 9 * 3600) < 0.01);
  assert.match(slow.paid, /^Delivered: /, slow.texts.slice(-3).join(' | '));
});

// ------------------------------------------------------------------------------------------------ 7. legacy jobs
test('legacy contracts: accepting a deadline job and loading an old state file move them onto the ship clock', () => {
  const g = mkGame();
  const { p } = join(g, 'Legacy');
  g.harbors.rotterdam.jobs.push({ id: 'jleg', type: 'freight', from: 'rotterdam', to: 'ijmuiden', good: 'grain', qty: 100, pay: 9000, distKm: 60, deadline: g.simTime + 36000, contraband: false, title: 'Freight 100 t of grain to IJmuiden' });
  g.onAction(p, { action: 'accept_job', jobId: 'jleg' });
  const j = p.jobs.find((x) => x.id === 'jleg');
  assert.equal(j.hours, 10); assert.ok(Math.abs(j.dueShip - p.shipTime - 36000) <= 1); assert.ok(!('deadline' in j));
  // a board keeps a legacy job until its deadline (tests push them)
  g.regenHarbor(ROT, g.harbors.rotterdam, false);
  // an old state file: no ship clock, an accepted job with a world-clock deadline, board jobs without hours
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saltline-time-')); const file = path.join(dir, 'state.json');
  const now = Date.now() / 1000;
  const old = {
    savedAt: new Date().toISOString(), wrecks: [], storms: [],
    harbors: { rotterdam: { jobs: [{ id: 'jb1', type: 'freight', from: 'rotterdam', to: 'ijmuiden', good: 'grain', qty: 100, pay: 1, distKm: 60, deadline: now + 1e5, title: 'old' }], market: { grain: 250 }, contact: { name: 'x', jobs: [{ id: 'jb2', type: 'smuggling', from: 'rotterdam', to: 'ijmuiden', good: 'weapons', qty: 40, pay: 1, distKm: 60, deadline: now + 1e5, contraband: true, title: 'old run' }] }, lastRegen: -1e9 } },
    players: [{ id: 'p1', token: 't1', name: 'Old', ship: { cls: 'coaster', lat: 51.98, lon: 4.03, hdg: 0, spd: 0, throttle: 0, rudder: 0 }, cond: 90, flooding: 0, fuel: 50, cargo: [], money: 1000, wanted: 0, wantedAt: 0, kits: 0,
      jobs: [{ id: 'jacc', type: 'passengers', from: 'rotterdam', to: 'ijmuiden', pax: 4, pay: 1000, distKm: 60, deadline: now + 5 * 3600, acceptedAt: now - 3 * 3600, title: 'old pax' }, { id: 'jnone', type: 'passengers', from: 'rotterdam', to: 'ijmuiden', pax: 2, pay: 1, title: 'no time at all' }],
      convoyId: null, docked: 'rotterdam', stats: {} }],
  };
  fs.writeFileSync(file, JSON.stringify(old));
  const g2 = new Game(world, () => {}, { stateFile: file }); g2.saveState = () => {};
  const q = g2.players.get('t1');
  assert.ok(Math.abs(q.shipTime - g2.simTime) <= 1, 'the ship clock starts at the world clock');
  assert.equal(q.warpRun, null);
  const acc = q.jobs.find((x) => x.id === 'jacc');
  assert.ok(Math.abs(acc.dueShip - q.shipTime - 5 * 3600) <= 2, `due ${acc.dueShip - q.shipTime} s ahead`);
  assert.equal(acc.hours, 8); assert.ok(!('deadline' in acc));
  const none = q.jobs.find((x) => x.id === 'jnone'); assert.equal(none.hours, 24); assert.ok(Math.abs(none.dueShip - q.shipTime - 86400) <= 1);
  for (const b of g2.harbors.rotterdam.jobs) assert.ok(Number.isInteger(b.hours) && !('deadline' in b), `board job ${b.id} has hours`);
  assert.ok(!g2.harbors.rotterdam.jobs.some((b) => b.id === 'jb1'), 'the legacy offer was withdrawn');
  for (const b of g2.harbors.rotterdam.contact?.jobs || []) assert.ok(Number.isInteger(b.hours));
  // a save/load round trip keeps the clock (it does not run while the server is down)
  q.shipTime += 1234.5; g2.saveState = Game.prototype.saveState; g2.saveState();
  const g3 = new Game(world, () => {}, { stateFile: file });
  assert.ok(Math.abs(g3.players.get('t1').shipTime - q.shipTime) < 1e-6);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------------------------------------ 8. express and tow
test('an express passage and a tow advance the ship clock by the hours they charge', () => {
  const g = mkGame();
  const a = atSea(g, 'Express', OPEN_A, { spd: 0, throttle: 0 });
  const t0 = a.p.shipTime, distM = haversine(OPEN_A.lat, OPEN_A.lon, OPEN_B.lat, OPEN_B.lon);
  g.onAction(a.p, { action: 'express', lat: OPEN_B.lat, lon: OPEN_B.lon });
  const hours = distM / (Math.max(6, SHIP_CLASSES.coaster.maxKn * 0.8) * GEO.KN_TO_MS) / 3600;
  assert.ok(Math.abs(a.p.shipTime - t0 - hours * 3600) < 1e-3, `+${(a.p.shipTime - t0) / 3600} h vs ${hours} h`);
  assert.match(evs(a.ws).at(-1), new RegExp(`; ship's clock \\+${hours.toFixed(1)} h\\)\\.$`));
  const b = atSea(g, 'Towed', { lat: 54.2, lon: 4.2 }, { spd: 0, throttle: 0 });
  const { units } = g.nearestHarbor(b.p.ship.lat, b.p.ship.lon);
  const t1 = b.p.shipTime; g.onAction(b.p, { action: 'tow' });
  const towH = Math.min(48, units / (8 * GEO.KN_TO_MS) / 3600);
  assert.ok(b.p.docked); assert.ok(Math.abs(b.p.shipTime - t1 - towH * 3600) < 1e-3);
  assert.ok(evs(b.ws).some((t) => t.includes(`(${towH.toFixed(1)} h under tow)`)));
});

// ------------------------------------------------------------------------------------------------ 9. publicJob shape
test('publicJob carries the ship-hour budget and the distances it was rated on; no deadline', () => {
  const rnd = seeded(7);
  const want = { freight: ['seaKm'], passengers: ['seaKm'], charter: ['seaKm'], fishing: ['groundKm', 'richness'], supply: ['platformKm'], tow: ['towKm'] };
  for (const [type, keys] of Object.entries(want)) {
    const j = publicJob(generateJob(ROT, 1.8e9, rnd, type, {}));
    assert.equal(j.type, type);
    for (const k of ['hours', 'expiresAt', 'postedAt', 'ref', ...keys]) assert.ok(j[k] != null, `${type} has ${k}`);
    assert.ok(!('deadline' in j));
  }
  const s = publicJob(generateSmugglingJob(ROT, 1.8e9, rnd));
  assert.ok(s.seaKm > 0 && s.hours >= 4 && !('deadline' in s));
  const g = mkGame();
  for (const e of g.publicJobs().harbors) for (const j of e.jobs) assert.ok(Number.isInteger(j.hours) && j.expiresAt > g.simTime && !('deadline' in j));
});

// ------------------------------------------------------------------------------------------------ 10. events
test('due-date events fire once each, also for a docked player; a tight contract warns on signing', () => {
  const g = mkGame();
  const { p, ws } = join(g, 'Docked');
  assert.ok(p.docked);
  g.harbors.rotterdam.jobs.push({ id: 'jev', type: 'passengers', from: 'rotterdam', to: 'ijmuiden', pax: 4, pay: 1000, distKm: 60, seaKm: 75, hours: 3, contraband: false, title: 'Ferry 4 passengers to IJmuiden' });
  g.onAction(p, { action: 'accept_job', jobId: 'jev' });
  const j = p.jobs.find((x) => x.id === 'jev');
  j.dueShip = p.shipTime + 7200.5;
  ticks(g, 3, 1);
  ticks(g, 3, 1);
  assert.equal(evs(ws).filter((t) => t === '2 h of ship time left: Ferry 4 passengers to IJmuiden.').length, 1);
  j.dueShip = p.shipTime + 0.5;
  ticks(g, 5, 1);
  assert.equal(evs(ws).filter((t) => t === 'Deadline passed: Ferry 4 passengers to IJmuiden (half pay on delivery).').length, 1);
  // a fishing contract rated for a trawler signed with a coaster: signed, with a warning
  g.harbors.rotterdam.jobs.push({ id: 'jtight', type: 'fishing', from: 'rotterdam', to: 'rotterdam', ground: 'southern_bight', groundName: 'Southern Bight', good: 'fish', qty: 100, pay: 95000, richness: 0.7, groundKm: 34.7, hours: 15, ref: { cls: 'trawler', margin: 1.4 }, contraband: false, title: 'Catch 100 t' });
  g.onAction(p, { action: 'accept_job', jobId: 'jtight' });
  assert.ok(p.jobs.some((x) => x.id === 'jtight'));
  assert.equal(evs(ws).at(-2), 'Tight: too slow for your ship: needs ~27 h, the contract allows 15 h. Late delivery pays half.');
});
