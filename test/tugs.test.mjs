// Tugs (V5-PLAN item 4): water-only path planning (server/tugpath.js) and the visible tug assist (server/tugassist.js).
// The path keeps clearance ≥ half beam + 10 m and enough water under the keel, never crosses land, ends with a run
// parallel to the quay; the assist moors the ship at the berth; no path → refused and nothing charged; the server
// sends the tug positions to the assisted skipper and to everyone else; the tugs sail home and disappear.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { World } from '../server/world.js';
import { carvingsForWorld, harborById } from '../server/harbors.js';
import { Game } from '../server/game.js';
import { encodePatch } from '../server/harborgeom.js';
import * as TP from '../server/tugpath.js';
import { tugOp, TUGS } from '../server/tugassist.js';
import { SHIP_CLASSES, encodePatchHeight } from '../shared/constants.js';
import { haversine, bearing, angleDiff } from '../shared/geo.js';

process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
const ROT = harborById('rotterdam');
const world = new World().load(carvingsForWorld(), () => {});

// ------------------------------------------------------------------------------------------------ synthetic harbour
// 1.6 km square at 10 m, centred on the Rotterdam harbour point. Land east of x = 300 with a quay face; a pier sticks
// out west at z ≈ 0 (x −200…300) so a straight line from the north basin to the berth south of it crosses the pier; a
// shallow bank (2 m) just west of the pier tip forces a hull with 5.5 m draught round it.
const N = 160, RES = 10;
function synthPatch({ closed = false, gap = 0, shoal = true } = {}) {
  const mask = new Uint8Array(N * N), heights = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i, x = (i + 0.5 - N / 2) * RES, z = (j + 0.5 - N / 2) * RES;
    let m = 0, h = -12;
    if (x > 300) { m = 1; h = 3; } else if (x > 290) { m = 2; h = 2.5; }
    else if (Math.abs(z) < 20 && x > (closed ? -800 : -200) && !(gap && x > -60 && x < -60 + gap)) { m = 2; h = 2.5; }
    else if (shoal && x > -420 && x < -205 && Math.abs(z) < 120) h = -2;
    mask[k] = m; heights[k] = encodePatchHeight(h);
  }
  return encodePatch({ n: N, res: RES, originLat: ROT.lat, originLon: ROT.lon, synthetic: true, heights, mask });
}
const gridOf = (buf) => TP.gridFromPatch(buf);
const llOf = (grid, x, z) => TP.toLL(grid, x, z);
const BERTH_XZ = [288, 150];
function synthBerth(grid) { const ll = llOf(grid, ...BERTH_XZ); return { id: 'rotterdam-b1', name: 'Berth 1', lat: ll.lat, lon: ll.lon, hdg: 0, length: 300, depth: 12, kind: 'quay', maxLength: 300 }; }
/** harborgeom contract (see test/game.test.mjs fakeGeom) backed by a real patch buffer. */
function patchGeom(buf, berths, anchorXZ = [-500, -300]) {
  const grid = gridOf(buf);
  const anchor = llOf(grid, ...anchorXZ);
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
function fakeSocket() { return { readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); }, close() {} }; }
function mkGame(geom) { const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-tugs-state.json', harborgeom: geom }); g.saveState = () => {}; return g; }
const events = (ws) => ws.sent.filter((m) => m.t === 'event').map((m) => m.text);
const lastYou = (ws) => [...ws.sent].reverse().find((m) => m.t === 'you')?.you;
/** Does the straight segment a→b touch an obstacle? (sanity: the old straight walk would have) */
function straightHitsLand(grid, a, b) { for (let f = 0; f <= 1; f += 0.002) if (TP.clearanceAt(grid, a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f) <= 0) return true; return false; }

// ------------------------------------------------------------------------------------------------ planner
test('tugpath: the path goes round the pier and the shoal, keeps half beam + 10 m and the draught, ends parallel to the quay', () => {
  const grid = gridOf(synthPatch());
  const C = SHIP_CLASSES.coaster;
  const start = [100, -250];
  assert.ok(straightHitsLand(grid, start, BERTH_XZ), 'sanity: the straight line crosses the pier');
  const r = TP.planAssistPath(grid, start, { x: BERTH_XZ[0], z: BERTH_XZ[1], hdg: 0 }, { beam: C.beam, length: C.length, draft: C.draft, tide: 0 });
  assert.ok(r.ok, `planned (${r.reason})`);
  assert.equal(r.rule.need, C.beam / 2 + 10);
  const st = TP.pathStats(grid, r.pts, 1);
  assert.ok(st.minClear >= r.rule.need - 0.01, `clearance ${st.minClear.toFixed(1)} m ≥ ${r.rule.need} m`);
  assert.ok(st.maxBed <= r.rule.hMax + 0.01, `water under the keel everywhere (bed ${st.maxBed.toFixed(2)} ≤ ${r.rule.hMax})`);
  // round the pier tip AND west of the shoal
  const westmost = Math.min(...r.pts.map((p) => p[0]));
  assert.ok(westmost < -420, `went round the shallow bank, not over it (x ${westmost.toFixed(0)})`);
  // ends at the approach point abeam the berth with a straight run parallel to the quay (bearing 0 or 180)
  const n = r.pts.length, a = r.pts[n - 2], b = r.pts[n - 1];
  assert.deepEqual(b, r.approach);
  const lastBrg = TP.bearingXZ(b[0] - a[0], b[1] - a[1]);
  assert.ok(Math.abs(angleDiff(lastBrg, r.hdg)) < 1 && [0, 180].includes(Math.round(r.hdg) % 360), `final run along the quay (${lastBrg.toFixed(1)}° / ${r.hdg})`);
  assert.ok(r.run >= 30, `a real parallel run (${r.run} m)`);
  assert.ok(r.sweep.ok, `bow and stern clear of the pier and the quay all the way (worst ${r.sweep.worst.toFixed(1)} m)`);
  assert.ok(Math.abs(b[1] - BERTH_XZ[1]) < 0.5 && b[0] < BERTH_XZ[0] && b[0] > BERTH_XZ[0] - 60, 'the approach point is abeam the berth, off the quay');
  assert.ok(TP.segmentWet(grid, b[0], b[1], BERTH_XZ[0], BERTH_XZ[1], 1), 'the push onto the berth is over water');
  assert.equal(r.quaySide, r.hdg < 90 || r.hdg > 270 ? 1 : -1, 'quay to starboard going north, to port going south');
  // a smooth line: no kink sharper than 50° between successive segments
  for (let i = 1; i < n - 1; i++) {
    const p0 = r.pts[i - 1], p1 = r.pts[i], p2 = r.pts[i + 1];
    const d = Math.abs(angleDiff(TP.bearingXZ(p1[0] - p0[0], p1[1] - p0[1]), TP.bearingXZ(p2[0] - p1[0], p2[1] - p1[1])));
    assert.ok(d < 50, `gentle curve at vertex ${i} (${d.toFixed(0)}°)`);
  }
});
test('tugpath: no path through a closed basin or a gap narrower than the beam rule; a wide gap is used', () => {
  const C = SHIP_CLASSES.coaster, opts = { beam: C.beam, length: C.length, draft: C.draft, tide: 0 };
  const berth = { x: BERTH_XZ[0], z: BERTH_XZ[1], hdg: 0 };
  const closed = TP.planAssistPath(gridOf(synthPatch({ closed: true })), [100, -250], berth, opts);
  assert.equal(closed.ok, false); assert.equal(closed.reason, 'nopath');
  const narrow = TP.planAssistPath(gridOf(synthPatch({ closed: true, gap: 30 })), [100, -250], berth, opts);
  assert.equal(narrow.ok, false, 'a 30 m gap is narrower than 2 × (7 + 10) m');
  const g3 = gridOf(synthPatch({ closed: true, gap: 80 }));
  const wide = TP.planAssistPath(g3, [100, -250], berth, opts);
  assert.ok(wide.ok, 'an 80 m gap takes a 14 m beam');
  assert.ok(TP.pathStats(g3, wide.pts, 1).minClear >= wide.rule.need - 0.01);
  // the bigger the beam, the more room: a 43 m container ship does not fit the 80 m gap
  const box = SHIP_CLASSES.boxship;
  assert.equal(TP.planAssistPath(g3, [100, -250], berth, { beam: box.beam, length: box.length, draft: box.draft }).ok, false);
});
test('tugpath: a ship already lying off the berth, parallel to the quay, is walked straight across (no loop)', () => {
  const grid = gridOf(synthPatch());
  const C = SHIP_CLASSES.coaster;
  const r = TP.planAssistPath(grid, [BERTH_XZ[0] - 40, BERTH_XZ[1] + 10], { x: BERTH_XZ[0], z: BERTH_XZ[1], hdg: 0 }, { beam: C.beam, length: C.length, draft: C.draft, hdg: 182 });
  assert.ok(r.ok && r.crab, 'direct');
  assert.ok(r.length < 40, `short (${r.length.toFixed(0)} m)`);
  assert.equal(Math.round(r.hdg), 180, 'keeps lying the way she points');
  const across = TP.planAssistPath(grid, [BERTH_XZ[0] - 40, BERTH_XZ[1] + 10], { x: BERTH_XZ[0], z: BERTH_XZ[1], hdg: 0 }, { beam: C.beam, length: C.length, draft: C.draft, hdg: 90 });
  assert.ok(across.ok && !across.crab, 'pointing at the quay: a proper approach instead');
});
test('tugpath: a ship aground on the bank is first led out through water, then the rule holds', () => {
  const grid = gridOf(synthPatch());
  const C = SHIP_CLASSES.coaster;
  const start = [-300, -60]; // on the 2 m bank
  assert.ok(TP.bedAt(grid, ...start) > -3, 'sanity: shallow here');
  const r = TP.planAssistPath(grid, start, { x: BERTH_XZ[0], z: BERTH_XZ[1], hdg: 0 }, { beam: C.beam, length: C.length, draft: C.draft });
  assert.ok(r.ok && r.escapeM > 0 && r.escapeM < 200, `escape leg ${r.escapeM?.toFixed?.(0)} m`);
  const st = TP.pathStats(grid, r.pts, 1);
  assert.ok(st.minClear > 0, 'never on land, even on the way out');
  const after = TP.pathStats(grid, r.pts, 1, r.escapeM + 0.5);
  assert.ok(after.minClear >= r.rule.need - 0.01 && after.maxBed <= r.rule.hMax + 0.01, 'clearance and depth from there on');
});

// ------------------------------------------------------------------------------------------------ real Rotterdam patch
const ROT_BIN = new URL('../data/geom/rotterdam.bin', import.meta.url).pathname, ROT_JSON = new URL('../data/geom/rotterdam.json', import.meta.url).pathname;
const haveRot = fs.existsSync(ROT_BIN) && fs.existsSync(ROT_JSON);
test('tugpath: on the real Rotterdam patch every planned path stays in water with the clearance rule', { skip: !haveRot && 'no cached Rotterdam geometry' }, () => {
  const grid = gridOf(fs.readFileSync(ROT_BIN));
  const meta = JSON.parse(fs.readFileSync(ROT_JSON, 'utf8'));
  const C = SHIP_CLASSES.coaster;
  const anchor = TP.toXZ(grid, meta.geom.anchor.lat, meta.geom.anchor.lon);
  const starts = [anchor, [anchor[0] - 600, anchor[1] + 300], [anchor[0] + 200, anchor[1] - 900], [anchor[0] - 1100, anchor[1] - 200]].filter((s) => TP.clearanceAt(grid, s[0], s[1]) > 30);
  assert.ok(starts.length >= 3);
  let planned = 0;
  for (const s of starts) for (const b of meta.geom.berths.filter((x) => x.kind === 'quay')) {
    const bx = TP.toXZ(grid, b.lat, b.lon);
    const r = TP.planAssistPath(grid, s, { x: bx[0], z: bx[1], hdg: b.hdg }, { beam: C.beam, length: C.length, draft: C.draft, tide: 0 });
    if (!r.ok) continue;
    planned++;
    const st = TP.pathStats(grid, r.pts, 1);
    assert.ok(st.minClear >= r.rule.need - 0.01, `${b.id}: clearance ${st.minClear.toFixed(1)} ≥ ${r.rule.need}`);
    assert.ok(st.maxBed <= r.rule.hMax + 0.01, `${b.id}: depth`);
    assert.ok(TP.segmentWet(grid, r.approach[0], r.approach[1], bx[0], bx[1], 0.5), `${b.id}: push leg over water`);
  }
  assert.ok(planned >= starts.length * 8, `most quays reachable (${planned})`);
});

// ------------------------------------------------------------------------------------------------ game: the assist
function runAssist(g, p, maxS = 1200, dt = 0.5, onTick = null) {
  let t = 0;
  while (p.assist && t < maxS) { g.tick(dt); t += dt; if (onTick) onTick(t); }
  return t;
}
test('game: tugs come out, tow along the planned path without touching land, moor at the berth, sail home and vanish', () => {
  const buf = synthPatch(), grid = gridOf(buf), berth = synthBerth(grid);
  const g = mkGame(patchGeom(buf, [berth]));
  const a = { ws: fakeSocket() }; a.p = g.connect(a.ws, null, 'Assisted'); a.p.money = 50000;
  const b = { ws: fakeSocket() }; b.p = g.connect(b.ws, null, 'Watcher');
  g.onAction(a.p, { action: 'undock' });
  const start = llOf(grid, 100, -250); a.p.ship.lat = start.lat; a.p.ship.lon = start.lon; a.p.ship.spd = 3; a.p.ship.hdg = 200;
  const money = a.p.money;
  g.onAction(a.p, { action: 'tug_assist' });
  assert.ok(a.p.assist?.opId, 'planned assist started');
  assert.equal(a.p.money, money - Math.max(400, Math.round(3200 * 0.35)), 'charged once');
  assert.ok(events(a.ws).some((t) => /Two harbour tugs are on the way/.test(t)));
  const op = tugOp(g, a.p.id);
  assert.equal(op.tugs.length, 2, 'two tugs for a 90 m coaster');
  assert.ok(op.rate >= 1 && op.rate <= TUGS.MAX_RATE);
  const until = a.p.assist.until; assert.ok(until > Date.now() && until - Date.now() <= TUGS.CAP_S * 1250, `a few minutes at most (${((until - Date.now()) / 1000).toFixed(0)} s, ×${op.rate.toFixed(1)})`);
  // the server owns the position; tug positions go to the skipper and to the others
  g.onState(a.p, { lat: start.lat + 0.01, lon: start.lon, hdg: 0, spd: 0 }); assert.equal(a.p.ship.lat, start.lat, 'client state ignored under tugs');
  g.tick(0.5); g.sendYou(a.p);
  const you = lastYou(a.ws);
  assert.ok(Array.isArray(you.assist.tugs) && you.assist.tugs.length === 2 && you.assist.phase === 'inbound', 'privateState.assist carries the tugs');
  for (const t of you.assist.tugs) for (const k of ['id', 'lat', 'lon', 'hdg', 'spd', 'mode', 'thrust']) assert.ok(k in t, `tug has ${k}`);
  const other = g.snapshot().players.find((x) => x.id === a.p.id);
  assert.equal(other.tugs.length, 2, 'publicState (snapshots for everyone) carries the tugs');
  assert.equal(g.snapshot().players.find((x) => x.id === b.p.id).tugs, null, 'no tugs for the watcher');
  // run it: the hull centre keeps the clearance rule on the whole tow, the tugs stay in water
  let minClear = Infinity, minTug = Infinity, phases = new Set(), maxSpd = 0, lineSeen = false, pushSeen = false;
  const t = runAssist(g, a.p, 1200, 0.5, () => {
    const o = tugOp(g, a.p.id); if (!a.p.assist) return;
    phases.add(o.phase);
    const [x, z] = TP.toXZ(grid, a.p.ship.lat, a.p.ship.lon);
    if (o.phase !== 'push') minClear = Math.min(minClear, TP.clearanceAt(grid, x, z));
    maxSpd = Math.max(maxSpd, a.p.ship.spd);
    for (const tg of o.tugs) { minTug = Math.min(minTug, TP.clearanceAt(grid, tg.x, tg.z)); if (tg.line && tg.attached) lineSeen = true; if (tg.mode === 'push') pushSeen = true; }
  });
  assert.ok(t < TUGS.CAP_S + 30, `done in ${t} s of real time`);
  assert.deepEqual([...phases].filter((x) => ['inbound', 'fast', 'tow', 'swing', 'push'].includes(x)), ['inbound', 'fast', 'tow', 'swing', 'push']);
  assert.ok(minClear >= SHIP_CLASSES.coaster.beam / 2 + 10 - 0.5, `ship clearance ${minClear.toFixed(1)} m`);
  assert.ok(minTug > 0, `tugs never on land (${minTug.toFixed(1)} m)`);
  assert.ok(maxSpd <= TUGS.CRUISE_KN + 0.6, `realistic tug-assist speed (max ${maxSpd} kn)`);
  assert.ok(lineSeen && pushSeen, 'towing on lines, then pushing');
  // moored exactly as dock() would
  assert.equal(a.p.assist, null); assert.equal(a.p.docked, 'rotterdam'); assert.equal(a.p.berth.id, 'rotterdam-b1');
  assert.equal(a.p.ship.lat, berth.lat); assert.equal(a.p.ship.lon, berth.lon);
  assert.ok([0, 180].includes(Math.round(a.p.ship.hdg) % 360), 'lying along the quay');
  assert.ok(events(a.ws).some((x) => /Tugs cast off/.test(x)) && events(a.ws).some((x) => /Moored at/.test(x)));
  // the tugs head home (still visible to everyone), then disappear
  assert.ok(g.snapshot().players.find((x) => x.id === a.p.id).tugs?.length >= 1, 'tugs still visible on their way home');
  let k = 0; while (tugOp(g, a.p.id) && k++ < 2000) g.tick(0.5);
  assert.equal(tugOp(g, a.p.id), null, 'back at the station');
  assert.equal(g.snapshot().players.find((x) => x.id === a.p.id).tugs, null);
});
test('game: one tug for a hull under 60 m; no water path → refused with a clear message and nothing charged', () => {
  const buf = synthPatch(), grid = gridOf(buf), berth = synthBerth(grid);
  const g = mkGame(patchGeom(buf, [berth]));
  const { ws } = { ws: fakeSocket() }; const p = g.connect(ws, null, 'Small'); p.money = 1e6;
  g.onAction(p, { action: 'undock' });
  p.ship.cls = 'trawler';
  const st = llOf(grid, 100, -250); p.ship.lat = st.lat; p.ship.lon = st.lon; p.ship.spd = 0;
  g.onAction(p, { action: 'tug_assist' });
  assert.equal(tugOp(g, p.id).tugs.length, 1, 'one tug for a 45 m trawler');
  assert.ok(events(ws).some((t) => /A harbour tug is on the way/.test(t)));
  runAssist(g, p);
  assert.equal(p.docked, 'rotterdam');
  // a closed basin: refused, no charge, no assist, the ship stays where she is
  const buf2 = synthPatch({ closed: true }), grid2 = gridOf(buf2);
  const g2 = mkGame(patchGeom(buf2, [synthBerth(grid2)]));
  const ws2 = fakeSocket(); const q = g2.connect(ws2, null, 'Boxed');
  g2.onAction(q, { action: 'undock' }); q.money = 50000;
  const s2 = llOf(grid2, 100, -250); q.ship.lat = s2.lat; q.ship.lon = s2.lon; q.ship.spd = 0;
  g2.onAction(q, { action: 'tug_assist' });
  assert.equal(q.assist, null); assert.equal(q.money, 50000); assert.equal(tugOp(g2, q.id), null);
  assert.equal(q.ship.lat, s2.lat);
  assert.ok(events(ws2).some((t) => /tugs will not take this job: there is no channel at least 34 m wide/.test(t) && /nothing was charged/.test(t)), events(ws2).slice(-1)[0]);
});
test('game: a ship just outside the harbour patch is first brought onto it in a straight line over open water', () => {
  const buf = synthPatch(), grid = gridOf(buf), berth = synthBerth(grid);
  const g = mkGame(patchGeom(buf, [berth]));
  const ws = fakeSocket(); const p = g.connect(ws, null, 'Outside'); p.money = 50000;
  g.onAction(p, { action: 'undock' });
  const st = llOf(grid, -1300, -300); p.ship.lat = st.lat; p.ship.lon = st.lon; p.ship.spd = 0; p.ship.hdg = 90;
  assert.ok(!TP.inGrid(grid, -1300, -300, 3), 'sanity: off the patch');
  g.onAction(p, { action: 'tug_assist' });
  assert.ok(p.assist?.opId, events(ws).slice(-1)[0]);
  const op = tugOp(g, p.id);
  assert.ok(Math.abs(op.path.pts[0][0] + 1300) < 1 && TP.inGrid(grid, ...op.path.pts[1], 2), 'lead-in from where she is to the patch edge');
  runAssist(g, p);
  assert.equal(p.docked, 'rotterdam'); assert.equal(p.berth.id, 'rotterdam-b1');
});
test('game: tugs that lose their ship (assist ended elsewhere) cast off and go home', () => {
  const buf = synthPatch(), grid = gridOf(buf);
  const g = mkGame(patchGeom(buf, [synthBerth(grid)]));
  const ws = fakeSocket(); const p = g.connect(ws, null, 'Impounded'); p.money = 50000;
  g.onAction(p, { action: 'undock' });
  const st = llOf(grid, 100, -250); p.ship.lat = st.lat; p.ship.lon = st.lon; p.ship.spd = 0;
  g.onAction(p, { action: 'tug_assist' });
  for (let i = 0; i < 20; i++) g.tick(0.5);
  g.setDocked(p, 'rotterdam', null); // e.g. impounded / reset
  g.tick(0.5);
  assert.equal(tugOp(g, p.id).phase, 'return');
  let k = 0; while (tugOp(g, p.id) && k++ < 3000) g.tick(0.5);
  assert.equal(tugOp(g, p.id), null);
});
test('game: on the real Rotterdam geometry the tugs take a coaster alongside without crossing land', { skip: !haveRot && 'no cached Rotterdam geometry' }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'saltline-tugs-'));
  fs.mkdirSync(path.join(tmp, 'geom'));
  for (const f of ['rotterdam.json', 'rotterdam.bin']) fs.copyFileSync(path.join(path.dirname(ROT_BIN), f), path.join(tmp, 'geom', f));
  const hg = await import('../server/harborgeom.js');
  hg.configure({ dataDir: tmp, offline: true, preload: false, log: () => {} });
  hg.init(world);
  try {
    assert.ok(await hg.ensureHarbor('rotterdam'));
    const grid = gridOf(hg.getHarborPatch('rotterdam'));
    const g = mkGame(hg);
    const ws = fakeSocket(); const p = g.connect(ws, null, 'Maasvlakte'); p.money = 1e6;
    g.onAction(p, { action: 'undock' });
    const a = hg.getHarborGeom('rotterdam').anchor;
    const [ax, az] = TP.toXZ(grid, a.lat, a.lon);
    const st = llOf(grid, ax - 560, az + 200); p.ship.lat = st.lat; p.ship.lon = st.lon; p.ship.spd = 3; p.ship.hdg = 90;
    g.onAction(p, { action: 'tug_assist' });
    assert.ok(p.assist?.opId, events(ws).slice(-1)[0]);
    const berthId = p.assist.berthId;
    let minClear = Infinity;
    runAssist(g, p, 1200, 0.5, () => { if (!p.assist) return; const o = tugOp(g, p.id); const [x, z] = TP.toXZ(grid, p.ship.lat, p.ship.lon); if (o.phase !== 'push') minClear = Math.min(minClear, TP.clearanceAt(grid, x, z)); });
    assert.ok(minClear >= SHIP_CLASSES.coaster.beam / 2 + 10 - 0.5, `clearance ${minClear.toFixed(1)}`);
    assert.equal(p.docked, 'rotterdam'); assert.equal(p.berth.id, berthId);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
