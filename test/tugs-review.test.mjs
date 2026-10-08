// Tugs review (wave 1): bugs found after the tug assist was built, each with the test that would have caught it.
//  - a second assist started while the first assist's tugs were still sailing home made those tugs vanish on the spot;
//  - an express passage bought while the tugs had the ship was charged, then undone by the tug assist on the next tick;
//  - a skipper whose connection dropped mid-assist vanished from everyone's snapshots together with the tugs, although
//    the server keeps towing her in;
//  - the tugs put a ship on top of another skipper lying at (or being brought to) the same berth, with a free one next door;
//  - an assist whose tugs could never get alongside would have waited for ever (inbound watchdog + overall watchdog);
//  - tugs sailed home fast-forwarded (up to 5×) after the ship was moored and drew long bright wake stripes: they now go
//    home in real time, and during a fast-forwarded assist the wire carries `ff` so the client draws the real wake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { carvingsForWorld, harborById } from '../server/harbors.js';
import { Game } from '../server/game.js';
import { encodePatch } from '../server/harborgeom.js';
import * as TP from '../server/tugpath.js';
import { tugOp, TUGS } from '../server/tugassist.js';
import { encodePatchHeight } from '../shared/constants.js';
import { haversine, bearing } from '../shared/geo.js';

process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
const ROT = harborById('rotterdam');
const world = new World().load(carvingsForWorld(), () => {});

// Synthetic 1.6 km harbour (same shape as test/tugs.test.mjs): land east of x = 300 with a quay face, a pier west at z ≈ 0.
const N = 160, RES = 10;
function synthPatch() {
  const mask = new Uint8Array(N * N), heights = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i, x = (i + 0.5 - N / 2) * RES, z = (j + 0.5 - N / 2) * RES;
    let m = 0, h = -12;
    if (x > 300) { m = 1; h = 3; } else if (x > 290) { m = 2; h = 2.5; } else if (Math.abs(z) < 20 && x > -200) { m = 2; h = 2.5; }
    mask[k] = m; heights[k] = encodePatchHeight(h);
  }
  return encodePatch({ n: N, res: RES, originLat: ROT.lat, originLon: ROT.lon, synthetic: true, heights, mask });
}
function setup({ second = false } = {}) {
  const buf = synthPatch(), grid = TP.gridFromPatch(buf);
  const mk = (id, name, x, z) => { const ll = TP.toLL(grid, x, z); return { id, name, lat: ll.lat, lon: ll.lon, hdg: 0, length: 250, depth: 12, kind: 'quay', maxLength: 250 }; };
  const berth = mk('rotterdam-b1', 'Berth 1', 288, 150);
  const berths = second ? [berth, mk('rotterdam-b2', 'Berth 2', 288, 500)] : [berth];
  const anchor = TP.toLL(grid, -500, -300);
  const geomObj = { id: 'rotterdam', name: ROT.name, source: 'synthetic', origin: { lat: ROT.lat, lon: ROT.lon }, anchor, n: N, res: RES, berths, fairway: [], features: {} };
  const geom = {
    getHarborGeom: (id) => (id === 'rotterdam' ? geomObj : null),
    getHarborPatch: (id) => (id === 'rotterdam' ? buf : null),
    harborAnchor: (id) => (id === 'rotterdam' ? anchor : harborById(id) ? { lat: harborById(id).lat, lon: harborById(id).lon } : null),
    nearestBerth(id, lat, lon) { if (id !== 'rotterdam') return null; const b = berths.map((x) => ({ x, d: haversine(lat, lon, x.lat, x.lon) })).sort((a, c) => a.d - c.d)[0].x; return { berth: b, distM: haversine(lat, lon, b.lat, b.lon), brg: bearing(lat, lon, b.lat, b.lon) }; },
    landPenetration: (lat, lon) => { const [x, z] = TP.toXZ(grid, lat, lon); if (!TP.inGrid(grid, x, z, 0)) return null; const c = TP.clearanceAt(grid, x, z); return c < 0 ? -c : 0; },
    sdfAt: (id, lat, lon) => { const [x, z] = TP.toXZ(grid, lat, lon); return TP.inGrid(grid, x, z, 0) ? TP.clearanceAt(grid, x, z) : null; },
  };
  const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-tugs-review.json', harborgeom: geom });
  g.saveState = () => {};
  return { g, grid, berth, berths };
}
const fakeSocket = () => ({ readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); }, close() {} });
const events = (ws) => ws.sent.filter((m) => m.t === 'event').map((m) => m.text);
function place(p, grid, x, z, hdg = 200) { const ll = TP.toLL(grid, x, z); p.ship.lat = ll.lat; p.ship.lon = ll.lon; p.ship.spd = 0; p.ship.hdg = hdg; }
function runAssist(g, p, maxS = 1200) { let t = 0; while (p.assist && t < maxS) { g.tick(0.5); t += 0.5; } return t; }
const snapTugs = (g, p) => g.snapshot().players.find((x) => x.id === p.id)?.tugs || [];

test('tugs review: a new assist does not make the last assist’s tugs vanish on their way home', () => {
  const { g, grid } = setup();
  const ws = fakeSocket(); const p = g.connect(ws, null, 'Twice'); p.money = 1e6;
  g.onAction(p, { action: 'undock' });
  place(p, grid, 100, -250);
  g.onAction(p, { action: 'tug_assist' });
  const first = tugOp(g, p.id).id;
  runAssist(g, p);
  assert.equal(p.docked, 'rotterdam');
  assert.equal(snapTugs(g, p).length, 2, 'the first two tugs are heading home');
  const oldIds = snapTugs(g, p).map((t) => t.id);
  // straight back out and call the tugs again while the first pair is still on its way home
  g.onAction(p, { action: 'undock' });
  place(p, grid, 100, -250);
  g.onAction(p, { action: 'tug_assist' });
  assert.ok(p.assist?.opId && p.assist.opId !== first, events(ws).slice(-1)[0]);
  g.tick(0.5);
  const ids = snapTugs(g, p).map((t) => t.id);
  for (const id of oldIds) assert.ok(ids.includes(id), `old tug ${id} still visible on its way home`);
  assert.equal(ids.length, 4, 'two going home + two coming out');
  // the second assist still runs to the berth, and every tug ends up back at the station
  runAssist(g, p);
  assert.equal(p.docked, 'rotterdam');
  let k = 0; while (snapTugs(g, p).length && k++ < 4000) g.tick(0.5);
  assert.equal(snapTugs(g, p).length, 0, 'all tugs home');
  assert.equal(tugOp(g, p.id), null);
});

test('tugs review: express passage is refused while the tugs have the ship (no charge, no jump)', () => {
  const { g, grid } = setup();
  const ws = fakeSocket(); const p = g.connect(ws, null, 'Hurry'); p.money = 1e6;
  g.onAction(p, { action: 'undock' });
  place(p, grid, 100, -250);
  g.onAction(p, { action: 'tug_assist' });
  assert.ok(p.assist?.opId);
  const money = p.money, at = { lat: p.ship.lat, lon: p.ship.lon };
  g.onAction(p, { action: 'express', lat: ROT.lat + 0.3, lon: ROT.lon - 0.6 });
  assert.equal(p.money, money, 'nothing charged');
  assert.ok(haversine(p.ship.lat, p.ship.lon, at.lat, at.lon) < 1, 'the ship did not jump');
  assert.match(events(ws).slice(-1)[0], /tugs have you/);
  runAssist(g, p);
  assert.equal(p.docked, 'rotterdam');
});

test('tugs review: a skipper who drops out mid-assist stays visible to the others with her tugs, and is moored', () => {
  const { g, grid, berth } = setup();
  const ws = fakeSocket(); const p = g.connect(ws, null, 'Dropped'); p.money = 1e6;
  const ws2 = fakeSocket(); const w = g.connect(ws2, null, 'Watcher');
  g.onAction(p, { action: 'undock' });
  place(p, grid, 100, -250);
  g.onAction(p, { action: 'tug_assist' });
  for (let i = 0; i < 10; i++) g.tick(0.5);
  g.disconnect(p);
  g.tick(0.5);
  const seen = g.snapshot().players.find((x) => x.id === p.id);
  assert.ok(seen, 'still in the snapshots while the tugs bring her in');
  assert.equal(seen.tugs?.length, 2, 'with her tugs');
  runAssist(g, p);
  assert.equal(p.docked, 'rotterdam'); assert.equal(p.berth.id, berth.id);
  assert.ok(w.online);
});

test('tugs review: tugs that cannot get alongside make fast after the inbound watchdog; a stuck assist ends at the berth', () => {
  const { g, grid, berth } = setup();
  const ws = fakeSocket(); const p = g.connect(ws, null, 'Waiting'); p.money = 1e6;
  g.onAction(p, { action: 'undock' });
  place(p, grid, 100, -250);
  g.onAction(p, { action: 'tug_assist' });
  const op = tugOp(g, p.id);
  assert.ok(op.inboundLimit > 120, 'a generous inbound allowance');
  // tugs stranded somewhere they can never leave (no route, boxed in): only the watchdog gets them alongside
  for (const t of op.tugs) { t.route = null; t.replanAt = Infinity; t.x = 600; t.z = 600; t.delay = 0; }
  op.inboundLimit = op.t + 5;
  assert.ok(op.tugs.every((t) => Math.hypot(t.x - op.x, t.z - op.z) > 400), 'sanity: far from the ship');
  let k = 0; while (op.t < op.inboundLimit + 1 && k++ < 100) g.tick(0.5);
  assert.ok(op.tugs.every((t) => t.attached), 'both tugs made fast by the watchdog');
  k = 0; while (op.phase === 'inbound' && k++ < 400) g.tick(0.5);
  assert.notEqual(op.phase, 'inbound', 'the assist moved on');
  runAssist(g, p);
  assert.equal(p.docked, 'rotterdam');
  // the hard watchdog: an assist that somehow overruns by far is finished at its berth
  const ws2 = fakeSocket(); const q = g.connect(ws2, null, 'Overrun'); q.money = 1e6;
  g.onAction(q, { action: 'undock' });
  place(q, grid, 100, -250);
  g.onAction(q, { action: 'tug_assist' });
  tugOp(g, q.id).startedAt = Date.now() - 3600e3;
  g.tick(0.5);
  assert.equal(q.assist, null); assert.equal(q.docked, 'rotterdam'); assert.equal(q.berth.id, berth.id);
  assert.equal(q.ship.lat, berth.lat); assert.equal(q.ship.lon, berth.lon);
});

test('tugs review: the tugs take her to a free berth, not onto a ship already lying there or being brought in', () => {
  const { g, grid, berths } = setup({ second: true });
  const wa = fakeSocket(); const a = g.connect(wa, null, 'Lying'); a.money = 1e6;
  const wb = fakeSocket(); const b = g.connect(wb, null, 'Arriving'); b.money = 1e6;
  const wc = fakeSocket(); const c = g.connect(wc, null, 'Third'); c.money = 1e6;
  for (const q of [a, b, c]) g.onAction(q, { action: 'undock' });
  // A lies at Berth 1 (the berth nearest to where B calls the tugs)
  g.moorAt(a, harborById('rotterdam'), berths[0]);
  place(b, grid, 100, 120, 0);
  b.guideBerth = { harbor: 'rotterdam', id: 'rotterdam-b1' }; // a sticky guidance target that has since been taken
  g.onAction(b, { action: 'tug_assist' });
  assert.equal(b.assist?.berthId, 'rotterdam-b2', events(wb).slice(-1)[0]);
  // with Berth 2 taken by B's assist and Berth 1 by A, C still gets a berth (both taken: the old choice, nothing better)
  place(c, grid, 100, -250);
  g.onAction(c, { action: 'tug_assist' });
  assert.ok(c.assist?.berthId, events(wc).slice(-1)[0]);
  runAssist(g, b);
  assert.equal(b.docked, 'rotterdam'); assert.equal(b.berth.id, 'rotterdam-b2');
});

test('tugs review: fast-forward is flagged on the wire during the assist; the tugs sail home in real time', () => {
  const { g, grid } = setup();
  const ws = fakeSocket(); const p = g.connect(ws, null, 'Home'); p.money = 1e6;
  g.onAction(p, { action: 'undock' });
  place(p, grid, -600, -600);
  g.onAction(p, { action: 'tug_assist' });
  const op = tugOp(g, p.id);
  assert.ok(op.rate > 1.5, `a long assist is fast-forwarded (×${op.rate.toFixed(1)})`);
  g.tick(0.5);
  for (const t of snapTugs(g, p)) assert.equal(t.ff, Math.round(op.rate * 10) / 10, 'ff on the wire while fast-forwarded');
  runAssist(g, p);
  assert.equal(p.docked, 'rotterdam');
  // a few seconds in, every homeward tug is under way at her real transit speed: ground covered per real second ≈ 9 kn
  for (let i = 0; i < 20; i++) g.tick(0.5);
  const before = op.tugs.filter((t) => !t.gone && t.route).map((t) => ({ t, x: t.x, z: t.z }));
  assert.ok(before.length, 'tugs on their way home');
  for (let i = 0; i < 10; i++) g.tick(0.5); // 5 real seconds
  for (const b of before) {
    if (b.t.gone) continue;
    const d = Math.hypot(b.t.x - b.x, b.t.z - b.z);
    assert.ok(d <= TUGS.TUG_HOME_KN * 0.5144 * 5 + 1, `real time home (${d.toFixed(1)} m in 5 s)`);
  }
  for (const t of snapTugs(g, p)) assert.equal(t.ff, undefined, 'no fast-forward flag on the way home');
});
