// V6 item 6 — time warp up to 5× inside harbours (docs/V6-QUICK-CONTRACTS.md §2): moored, under tugs, approaching and on
// a built harbour patch the cap is WARP.HARBOR_MAX; entering a harbour zone above 5× steps down instead of stopping;
// tug assists run 5× faster; teleports still drop to 1×; contacts hurt the same at 5× as at 1×.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { carvingsForWorld, harborById } from '../server/harbors.js';
import { Game } from '../server/game.js';
import { encodePatch } from '../server/harborgeom.js';
import * as TP from '../server/tugpath.js';
import { tugOp } from '../server/tugassist.js';
import { WARP, encodePatchHeight } from '../shared/constants.js';
import { haversine, bearing, destination } from '../shared/geo.js';

process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
const world = new World().load(carvingsForWorld(), () => {});
const ROT = harborById('rotterdam');

function fakeSocket() { return { readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); }, close() {} }; }
function mkGame(opts = {}) { const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-warp-harbour-state.json', ...opts }); g.saveState = () => {}; g.rnd = () => 0.5; return g; }
function join(g, name, tok = null) { const ws = fakeSocket(); const p = g.connect(ws, tok, name); return { p, ws }; }
const last = (ws, t) => [...ws.sent].reverse().find((m) => m.t === t);
const evs = (ws) => ws.sent.filter((m) => m.t === 'event');
const lastEv = (ws) => evs(ws).at(-1);
const ROUTE = [{ lat: 56.2, lon: 3.6 }, { lat: 57, lon: 4 }];
const OPEN_A = { lat: 55.0, lon: 3.5 };
function atSea(g, name, pos = OPEN_A, ship = {}) {
  const j = join(g, name);
  g.onAction(j.p, { action: 'undock' });
  Object.assign(j.p.ship, { lat: pos.lat, lon: pos.lon, hdg: 0, spd: 4, throttle: 0.3, rudder: 0 }, ship);
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
}
function accepted(g, j, factor, route) {
  warp(g, j.p, factor, route);
  const ev = lastEv(j.ws);
  assert.equal(j.p.warp, factor, `${factor}× must be accepted (${ev && ev.text})`);
  assert.equal(last(j.ws, 'you').you.warp, factor);
}
// A built harbour whose anchor lies 10 km west of the raw harbour point (as in test/warp.test.mjs); `land(lat, lon)`
// stands in for the patch coverage (null = no patch here, 0 = patch water), `berths` for the legacy berth list.
const ANCHOR = destination(ROT.lat, ROT.lon, 270, 10000);
function anchorGeom({ land = () => null, berths = [] } = {}) {
  const geom = { id: 'rotterdam', name: ROT.name, berths, anchor: ANCHOR, origin: { lat: ROT.lat, lon: ROT.lon }, n: 448, res: 10, fairway: [], features: {} };
  return {
    getHarborGeom: (id) => (id === 'rotterdam' ? geom : null),
    getHarborPatch: () => null,
    nearestBerth(id, lat, lon) { if (id !== 'rotterdam' || !berths.length) return null; let best = null; for (const b of berths) { const d = haversine(lat, lon, b.lat, b.lon); if (!best || d < best.distM) best = { berth: b, distM: d, brg: bearing(lat, lon, b.lat, b.lon) }; } return best; },
    landPenetration: (lat, lon) => land(lat, lon), sdfAt: () => null,
    harborAnchor: (id) => (id === 'rotterdam' ? ANCHOR : harborById(id) ? { lat: harborById(id).lat, lon: harborById(id).lon } : null),
  };
}
const west = (m) => destination(ANCHOR.lat, ANCHOR.lon, 270, m);

// ------------------------------------------------------------------------------------------------ synthetic patch (test/tugs.test.mjs)
const N = 160, RES = 10;
function synthPatch() {
  const mask = new Uint8Array(N * N), heights = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i, x = (i + 0.5 - N / 2) * RES, z = (j + 0.5 - N / 2) * RES;
    let m = 0, h = -12;
    if (x > 300) { m = 1; h = 3; } else if (x > 290) { m = 2; h = 2.5; }
    else if (Math.abs(z) < 20 && x > -200) { m = 2; h = 2.5; }
    else if (x > -420 && x < -205 && Math.abs(z) < 120) h = -2;
    mask[k] = m; heights[k] = encodePatchHeight(h);
  }
  return encodePatch({ n: N, res: RES, originLat: ROT.lat, originLon: ROT.lon, synthetic: true, heights, mask });
}
const BERTH_XZ = [288, 150];
function synthBerth(grid) { const ll = TP.toLL(grid, ...BERTH_XZ); return { id: 'rotterdam-b1', name: 'Berth 1', lat: ll.lat, lon: ll.lon, hdg: 0, length: 300, depth: 12, kind: 'quay', maxLength: 300 }; }
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
/** Replace Date.now with a clock that only moves when `advance` is called (the legacy assist walks on the wall clock). */
function fakeClock() {
  const real = Date.now; let t = real();
  Date.now = () => t;
  return { advance(ms) { t += ms; }, restore() { Date.now = real; } };
}

// ------------------------------------------------------------------------------------------------ 1. moored
test('warp-harbour: moored — 5× accepted, 20× refused, warpLimit names the harbour; fuel and storms do not matter', () => {
  assert.equal(WARP.HARBOR_MAX, 5); assert.equal(WARP.HARBOR_PLAYER_M, 1500); assert.equal(WARP.HARBOR_RADIUS_M, 4000);
  const g = mkGame(); const d = join(g, 'Moe');
  assert.equal(d.p.docked, 'rotterdam');
  assert.deepEqual(g.privateState(d.p).warpLimit, { max: 5, reason: 'Moored in Rotterdam (Maasvlakte) — 5× at most inside harbours.', routeAbove: 20, harbour: { id: 'rotterdam', name: 'Rotterdam (Maasvlakte)', distM: 0, kind: 'moored' } });
  assert.deepEqual(g.worldInfo().warp.HARBOR_MAX, 5, 'the client learns the cap from worldInfo');
  accepted(g, d, 5);
  assert.match(lastEv(d.ws).text, /^Time warp 5× in Rotterdam \(Maasvlakte\): your ship's clock runs 5 times faster — fuel, wear, wages and contract hours too\. The tide and everything ashore stay in real time\.$/);
  refused(g, d, 20, /refused: moored in Rotterdam \(Maasvlakte\) — inside harbours time warp is limited to 5×/);
  refused(g, d, 100, /limited to 5×/, ROUTE);
  assert.equal(d.p.warp, 5, 'a refused raise keeps 5×');
  assert.deepEqual(last(d.ws, 'you').you.warpLimit, g.warpLimit(d.p));
  warp(g, d.p, 1);
  d.p.fuel = 0; accepted(g, d, 5); warp(g, d.p, 1); d.p.fuel = 40;
  g.storms.push({ id: 's1', name: 'Test', lat: ROT.lat, lon: ROT.lon, radiusKm: 100, peak: 1, intensity: 1, driftDir: 90, driftMs: 0, born: g.simTime, dies: g.simTime + 3600 });
  assert.ok(g.weatherAt(ROT.lat, ROT.lon).storm > WARP.MAX_STORM, 'setup: storm over the harbour');
  accepted(g, d, 5); g.tick(0.1); assert.equal(d.p.warp, 5, 'the storm does not drop a moored ship');
  g.storms.length = 0;
  // the hail and the life raft still stop it (cannot happen moored in practice, but the order holds)
  d.p.rescue = { id: 'r', from: 'rotterdam' }; g.tick(0.1); assert.equal(d.p.warp, 1); assert.match(lastEv(d.ws).text, /life raft/); d.p.rescue = null;
});

// ------------------------------------------------------------------------------------------------ 2. cast off at 5×
test('warp-harbour: casting off at 5× keeps 5×; zone rules apply under way', () => {
  const g = mkGame(); const d = join(g, 'Cas');
  accepted(g, d, 5);
  g.onAction(d.p, { action: 'undock' });
  assert.equal(d.p.docked, null); assert.equal(d.p.warp, 5, 'undock does not touch warp');
  for (let i = 0; i < 10; i++) g.tick(0.1);
  assert.equal(d.p.warp, 5, 'still 5× under way in the zone');
  const z = g.harbourZone(d.p); assert.equal(z.kind, 'near'); assert.equal(z.harbor.id, 'rotterdam');
  assert.equal(g.warpLimit(d.p).harbour.kind, 'near');
  // moored at 5× with no fuel is fine; once she casts off empty the next tick drops it
  const e = join(g, 'Empty'); accepted(g, e, 5); e.p.fuel = 0;
  g.onAction(e.p, { action: 'undock' }); assert.equal(e.p.warp, 5);
  g.tick(0.1); assert.equal(e.p.warp, 1); assert.match(lastEv(e.ws).text, /Time warp off \(5× → 1×\): Out of fuel/);
});

// ------------------------------------------------------------------------------------------------ 3. approach cap
test('warp-harbour: approaching — 5× within 4 km of the anchor, 20× refused; entering the zone at 20× steps down to 5×', () => {
  const g = mkGame({ harborgeom: anchorGeom() });
  const a = atSea(g, 'Ann', west(3000), { hdg: 90 });
  assert.equal(g.harbourZone(a.p).kind, 'near');
  accepted(g, a, 5);
  refused(g, a, 20, /is 3\.0 km away — inside harbours time warp is limited to 5×/);
  warp(g, a.p, 1);
  // out at 5 km: 20× on a route is fine
  Object.assign(a.p.ship, west(5000)); a.p.lastValid = west(5000);
  assert.equal(g.harbourZone(a.p), null);
  accepted(g, a, 20, ROUTE); assert.equal(a.p.warpRouted, true);
  assert.equal(g.warpLimit(a.p).harbour, undefined, 'no harbour key outside a zone');
  // steaming in to 3.5 km: the tick caps to 5× (not 1×), keeps the route flag and the 20× movement budget for a moment
  Object.assign(a.p.ship, west(3500)); a.p.lastValid = west(3500); a.ws.sent.length = 0;
  g.tick(0.1);
  assert.equal(a.p.warp, 5, 'capped, not dropped');
  const ev = evs(a.ws).find((e) => /→ 5×/.test(e.text));
  assert.ok(ev); assert.equal(ev.kind, 'warn');
  assert.match(ev.text, /^Time warp 20× → 5×: .* 5× at most inside harbours/);
  assert.match(ev.text, /Rotterdam \(Maasvlakte\) is 3\.5 km away/);
  assert.ok(!evs(a.ws).some((e) => /→ 1×/.test(e.text)), 'never 1× in between');
  assert.equal(last(a.ws, 'you').you.warp, 5);
  assert.equal(a.p.warpRouted, true, 'route flag kept for the way out');
  assert.equal(g.warpBudgetFactor(a.p), 20, 'grace: the 20× budget for states already in flight');
  const to = destination(a.p.ship.lat, a.p.ship.lon, 90, 400), lat0 = a.p.ship.lat;
  a.p.moveBudget = 0; a.p.lastState = Date.now() - 2000;
  g.onState(a.p, { lat: to.lat, lon: to.lon, hdg: 90, spd: 10, throttle: 0.7, rudder: 0 });
  assert.notEqual(a.p.ship.lat, lat0, 'a 400 m / 2 s jump is accepted during the grace');
  // leaving again: back up (the client sends its route with every raise, as app.setWarp does)
  Object.assign(a.p.ship, west(6000), { hdg: 270 }); a.p.lastValid = west(6000);
  accepted(g, a, 100, ROUTE);
});

// ------------------------------------------------------------------------------------------------ 4. built patch
test('warp-harbour: a built 10 m harbour patch counts as harbour zone even 5 km from the anchor', () => {
  const P = west(5000);
  const g = mkGame({ harborgeom: anchorGeom({ land: (lat, lon) => (haversine(lat, lon, P.lat, P.lon) < 600 ? 0 : null) }) });
  const a = atSea(g, 'Pat', P, { hdg: 270 });
  const z = g.harbourZone(a.p);
  assert.equal(z.kind, 'patch'); assert.equal(z.harbor.id, 'rotterdam'); assert.ok(Math.abs(z.distM - 5000) < 5);
  accepted(g, a, 5);
  refused(g, a, 20, /Rotterdam \(Maasvlakte\) is 5\.0 km away — inside harbours time warp is limited to 5×/);
  assert.equal(g.warpLimit(a.p).harbour.kind, 'patch');
  Object.assign(a.p.ship, west(7000)); assert.equal(g.harbourZone(a.p), null, 'off the patch and outside 4 km: open water');
});

// ------------------------------------------------------------------------------------------------ 5. other skippers
test('warp-harbour: in a harbour zone only skippers under way within 1.5 km stop warp', () => {
  const g = mkGame({ harborgeom: anchorGeom() });
  const a = atSea(g, 'Ann', west(3000), { hdg: 90 });
  const b = atSea(g, 'Bea', destination(west(3000).lat, west(3000).lon, 0, 1200));
  refused(g, a, 5, /Bea is 1\.2 km away — in harbour, warp needs 1\.5 km between you and other skippers under way/);
  assert.equal(g.warpLimit(a.p).max, 1); assert.equal(g.warpLimit(a.p).harbour.kind, 'near');
  b.p.docked = 'rotterdam'; accepted(g, a, 5); warp(g, a.p, 1); b.p.docked = null;
  Object.assign(b.p.ship, destination(west(3000).lat, west(3000).lon, 0, 1800)); accepted(g, a, 5);
  // B comes closer while A is warped under way: A drops to 1× with the reason
  Object.assign(b.p.ship, destination(west(3000).lat, west(3000).lon, 0, 1000)); g.tick(0.1);
  assert.equal(a.p.warp, 1); assert.match(lastEv(a.ws).text, /Time warp off \(5× → 1×\): Bea is 1\.0 km away — in harbour/);
  // A moored while B manoeuvres 300 m away: allowed
  const g2 = mkGame(); const m = join(g2, 'Moe');
  const c = atSea(g2, 'Cy', destination(m.p.ship.lat, m.p.ship.lon, 90, 300));
  accepted(g2, m, 5); g2.tick(0.1); assert.equal(m.p.warp, 5, 'moored skippers are never blocked by others');
  assert.ok(c.p.ship.lat);
});

// ------------------------------------------------------------------------------------------------ 6. tugs at 5×
function tugRun(factor) {
  const buf = synthPatch(), grid = TP.gridFromPatch(buf), berth = synthBerth(grid);
  const g = mkGame({ harborgeom: patchGeom(buf, [berth]) });
  const j = join(g, `Tug${factor}`); j.p.money = 50000;
  g.onAction(j.p, { action: 'undock' });
  const st = TP.toLL(grid, -200, -450); Object.assign(j.p.ship, { lat: st.lat, lon: st.lon, spd: 0, hdg: 90 }); j.p.lastValid = { ...st };
  g.onAction(j.p, { action: 'tug_assist' });
  assert.ok(j.p.assist?.opId, `planned assist (${lastEv(j.ws)?.text})`);
  if (factor > 1) { accepted(g, j, factor); assert.equal(g.harbourZone(j.p).kind, 'tugs'); refused(g, j, 20, /under tow by the Rotterdam \(Maasvlakte\) tugs — inside harbours time warp is limited to 5×/); }
  let ticks = 0, leftSum = 0, leftN = 0;
  while (j.p.assist && ticks < 20000) {
    g.tick(0.1); ticks++;
    if (j.p.assist && ticks % 10 === 0) { g.sendYou(j.p); const you = last(j.ws, 'you').you; leftSum += you.assist.until - Date.now(); leftN++; }
  }
  return { g, p: j.p, ticks, left: leftSum / Math.max(1, leftN), op: tugOp(g, j.p.id) };
}
test('warp-harbour: tug assist at 5× runs five times faster and ends at the same berth', () => {
  const A = tugRun(1), B = tugRun(5);
  assert.equal(A.p.docked, 'rotterdam'); assert.equal(B.p.docked, 'rotterdam');
  assert.equal(A.p.berth.id, 'rotterdam-b1'); assert.equal(B.p.berth.id, A.p.berth.id, 'same berth');
  const ratio = (B.ticks * 5) / A.ticks;
  assert.ok(A.ticks > 200, `a real tow (${A.ticks} ticks)`);
  assert.ok(ratio > 0.85 && ratio < 1.15, `ticks 1× ${A.ticks}, 5× ${B.ticks} (×5 = ${(ratio * 100).toFixed(0)} %)`);
  assert.ok(B.left <= A.left / 4, `countdown shows real time left: 5× ${(B.left / 1000).toFixed(1)} s vs 1× ${(A.left / 1000).toFixed(1)} s`);
  assert.equal(B.p.warp, 5, 'moored at the end, still 5×');
});

// ------------------------------------------------------------------------------------------------ 7. legacy assist
test('warp-harbour: the legacy tug walk (no patch) also runs five times faster at 5×', () => {
  const clock = fakeClock();
  try {
    const run = (factor) => {
      const b = { id: 'rotterdam-b1', name: 'Quay 1', lat: ANCHOR.lat + 0.002, lon: ANCHOR.lon, hdg: 0, length: 300, depth: 12, kind: 'quay', maxLength: 300 };
      const g = mkGame({ harborgeom: anchorGeom({ berths: [b] }) });
      const a = atSea(g, `Leg${factor}`, west(1000), { spd: 0, hdg: 90 }); a.p.money = 50000;
      g.onAction(a.p, { action: 'tug_assist' });
      assert.ok(a.p.assist && !a.p.assist.opId, 'legacy walk');
      assert.equal(a.p.assist.until - a.p.assist.start, 45000);
      if (factor > 1) accepted(g, a, factor);
      let ticks = 0;
      while (a.p.assist && ticks < 5000) { clock.advance(100); g.tick(0.1); ticks++; }
      assert.equal(a.p.docked, 'rotterdam'); assert.equal(a.p.berth.id, 'rotterdam-b1');
      return ticks;
    };
    const t1 = run(1), t5 = run(5);
    assert.ok(Math.abs(t1 - 450) <= 2, `1×: ${t1} ticks of 0.1 s for 45 s`);
    assert.ok(Math.abs(t5 * 5 / t1 - 1) < 0.05, `5×: ${t5} ticks ≈ ${t1} / 5`);
  } finally { clock.restore(); }
});

// ------------------------------------------------------------------------------------------------ 8. teleports
test('warp-harbour: tow, impound, forced reset and rescue landing drop 5× to 1× ("In harbour")', () => {
  const g = mkGame();
  const check = (j, what) => {
    assert.equal(j.p.warp, 1, `${what}: back to real time`);
    assert.ok(evs(j.ws).some((e) => /Time warp off \(5× → 1×\): In harbour/.test(e.text)), `${what}: the drop event`);
    assert.ok(j.p.docked, `${what}: in harbour`);
  };
  const t = atSea(g, 'Tow'); accepted(g, t, 5); g.onAction(t.p, { action: 'tow' }); check(t, 'tow');
  const i = atSea(g, 'Imp'); accepted(g, i, 5);
  i.p.cargo.push({ good: 'weapons', qty: 10, contraband: true, jobId: null }); i.p.money = 0;
  assert.equal(g.inspect(i.p, 'HMCG Test'), true); check(i, 'impound'); assert.match(lastEv(i.ws).text, /impounded/);
  const f = atSea(g, 'Res'); accepted(g, f, 5); g.forcedReset(f.p, 'Test.'); check(f, 'forced reset');
  const r = atSea(g, 'Raft'); accepted(g, r, 5); r.p.money = 5000; g.finishRescue(r.p, { from: 'rotterdam' }); check(r, 'rescue landing');
});

// ------------------------------------------------------------------------------------------------ 9. contacts
test('warp-harbour: contacts — moored nothing happens; under way at 5× a bump drops to 1× and hurts exactly like at 1×', () => {
  const g0 = mkGame();
  const d = join(g0, 'Moe'); accepted(g0, d, 5);
  const c0 = d.p.cond; g0.onAction(d.p, { action: 'collision', speedKn: 3, kind: 'quay' });
  assert.equal(d.p.warp, 5); assert.equal(d.p.cond, c0);
  const run = (factor) => {
    const g = mkGame(); // one skipper per game: two ships under way at the same quay would block each other
    const j = join(g, `Bump${factor}`); g.onAction(j.p, { action: 'undock' }); j.p.cond = 90;
    assert.ok(g.harbourZone(j.p), 'in the zone');
    if (factor > 1) accepted(g, j, factor);
    g.onAction(j.p, { action: 'collision', speedKn: 0.3, kind: 'quay' });
    assert.equal(j.p.warp, factor, 'a 0.3 kn nudge is the fenders: no drop'); assert.equal(j.p.cond, 90);
    g.onAction(j.p, { action: 'collision', speedKn: 1, kind: 'quay' });
    assert.equal(j.p.warp, 1);
    if (factor > 1) assert.ok(evs(j.ws).some((e) => /Time warp off \(5× → 1×\): Contact with the quay\./.test(e.text)), 'the drop names the quay');
    return 90 - j.p.cond;
  };
  const dmg1 = run(1), dmg5 = run(5);
  assert.ok(dmg1 > 0); assert.equal(dmg5, dmg1, 'damage from knots, not × warp');
});

// ------------------------------------------------------------------------------------------------ 10. nothing consumed moored
test('warp-harbour: moored at 5× nothing aboard is consumed', () => {
  const g = mkGame(); const d = join(g, 'Idle');
  accepted(g, d, 5);
  const { fuel, cond, money } = d.p;
  for (let i = 0; i < 600; i++) g.tick(0.1);
  assert.equal(d.p.warp, 5);
  assert.equal(d.p.fuel, fuel); assert.equal(d.p.cond, cond); assert.equal(d.p.money, money);
});
