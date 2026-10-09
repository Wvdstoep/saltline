// Bridges & locks 3D — pure geometry (docs/BRIDGES-LOCKS-VHF-CONTRACT.md §10.7, lane C): public/js/wwgeom.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildBridge, buildLock, partPose, partBounds, posePoint, meshBounds, undersideAt, drawnSpans, planLod, anchorOf, llToLocal, polySampler, BUDGET3D, LOD3D, datumOffset, bridgeFromVector, inRing } from '../public/js/wwgeom.js';
import { chamberLevel, gateFrac } from '../public/js/wwfmt.js';

const D2R = Math.PI / 180;
// a straight 120 m deck line across a canal (≈ east–west at 51.9 N), one span 40 … 80 m
const line = [[51.9, 4.2], [51.9, 4.2 + 120 / (111320 * Math.cos(51.9 * D2R))]];
const bridge = (span, extra = {}) => ({ id: 'osm:w1', name: 'Test', kind: 'road', src: 'osm', e: 1, line, deckW: 12, structure: 'girder', datum: 'NAP', spans: [{ id: 0, a: 40, b: 80, rec: 1, w: 40, ...span }], ...extra });
const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;
const frame = (o) => { const an = anchorOf(o); return polySampler(o.line.map(([a, b]) => llToLocal(an, a, b))); };
/** Object-frame point at metres s along the line, lateral d. */
const at = (o, s, d = 0) => { const S = frame(o), p = S.P(s), t = S.T(s); return [p[0] - t[1] * d, p[1] + t[0] * d]; };

test('fixed bridge: deck underside = clr + datum offset, piers at both span edges, tris in budget (§10.7.1)', () => {
  const o = bridge({ mov: 'fixed', clr: 7.0 });
  const r = buildBridge(o, { lod: LOD3D.FULL });
  const [x, z] = at(o, 60);
  assert.ok(near(undersideAt(r.query, x, z), 7.0));
  const k = buildBridge({ ...o, datum: 'KP', kp: -0.4 }, { lod: LOD3D.FULL });
  assert.ok(near(undersideAt(k.query, x, z), 6.6), 'KP datum −0.40 → underside 6.60');
  assert.ok(r.piers.some((s) => near(s, 40 - 1.25)) && r.piers.some((s) => near(s, 80 + 1.25)), `piers at the span edges: ${r.piers}`);
  // the static mesh really has the deck underside at that height somewhere over the span
  const P = r.static.pos; let found = false;
  for (let i = 0; i < P.length; i += 3) if (near(P[i + 1], 7.0, 1e-4)) { found = true; break; }
  assert.ok(found);
  assert.ok(r.tris < 8000, `tris ${r.tris}`);
  assert.equal(r.boards.find((b) => b.kind === 'clr').text, '7.0');
});

test('bascule: leaf tip ≥ w·sin 82° above the hinge at frac 1, level with the deck at frac 0 (§10.7.2)', () => {
  const o = bridge({ mov: 'bascule', clr: 3.6, clrO: null, hinge: 'a' });
  const r = buildBridge(o, { lod: LOD3D.MID });
  const leaf = r.moving.find((p) => p.kind === 'leaf');
  assert.ok(leaf, 'leaf part');
  const w = 40, up = partBounds(leaf, 1).max[1] - leaf.pivot[1];
  assert.ok(up >= w * Math.sin(82 * D2R) - 0.5, `tip ${up.toFixed(2)} ≥ ${(w * Math.sin(82 * D2R)).toFixed(2)}`);
  const th = r.spans[0].th, b0 = partBounds(leaf, 0);
  assert.ok(near(b0.max[1], 3.6 + th), `closed top ${b0.max[1]} = deck top ${3.6 + th}`);
  // the leaf deck underside over the opening is at the clearance when closed
  const [x, z] = at(o, 60); assert.ok(near(undersideAt(r.query, x, z, { 0: 0 }), 3.6));
  assert.equal(undersideAt(r.query, x, z, { 0: 1 }), null, 'fully open: no deck over the opening');
  assert.ok(near(undersideAt(r.query, x, z, { 0: 0.5 }), 3.6), 'part open counts as closed (§4.3)');
});

test('double bascule and draw bridge: two moving parts, both rise', () => {
  for (const mov of ['bascule2', 'draw']) {
    const r = buildBridge(bridge({ mov, clr: 2.5, clrO: null, b: 60, w: 20 }), { lod: LOD3D.FULL });
    assert.equal(r.moving.length, 2, mov);
    for (const p of r.moving) assert.ok(partBounds(p, 1).max[1] > partBounds(p, 0).max[1] + 5, `${mov} ${p.kind} rises`);
  }
});

test('lift: span underside at frac 1 = clrO, towers ≥ clrO + deck + 6 (§10.7.3)', () => {
  const o = bridge({ mov: 'lift', clr: 3.6, clrO: 24.0 });
  const r = buildBridge(o, { lod: LOD3D.FULL });
  const lift = r.moving.find((p) => p.kind === 'lift');
  assert.ok(near(partBounds(lift, 1).min[1], 24.0), `open underside ${partBounds(lift, 1).min[1]}`);
  assert.ok(near(partBounds(lift, 0).min[1], 3.6));
  const th = r.spans[0].th;
  assert.ok(meshBounds(r.static).max[1] >= 24.0 + th + 6 - 0.01, 'tower top');
  const [x, z] = at(o, 60);
  assert.ok(near(undersideAt(r.query, x, z, { 0: 0.5 }), 3.6 + 20.4 * 0.5), 'lift clearance moves continuously');
  assert.equal(r.boards.find((b) => b.kind === 'clr').text, '3.6 / 24.0');
  assert.equal(r.boards.find((b) => b.kind === 'width').text, '↔ 40.0');
  // cables stretch from the span top to the machinery
  const cab = r.moving.find((p) => p.kind === 'stretch');
  assert.ok(cab && partPose(cab, 1).sy < partPose(cab, 0).sy);
});

test('swing: the span turns 90° and the opening is free (§10.7.4)', () => {
  const o = bridge({ mov: 'swing', clr: 2.4, clrO: null });
  const r = buildBridge(o, { lod: LOD3D.FULL });
  const sw = r.moving.find((p) => p.kind === 'swing');
  const pose = partPose(sw, 1);
  assert.ok(near(Math.abs(pose.angle), Math.PI / 2, 1e-9));
  const S = frame(o), t = S.T(60), p0 = S.P(0), P = sw.mesh.pos;
  let maxS = -Infinity;
  for (let i = 0; i < P.length; i += 3) {
    const q = posePoint(pose, [P[i], P[i + 1], P[i + 2]]);
    const s = (q[0] - p0[0]) * t[0] + (q[2] - p0[1]) * t[1];
    if (s > maxS) maxS = s;
  }
  assert.ok(maxS < 40, `opened span stays out of the opening (max s ${maxS.toFixed(2)} < a = 40)`);
  // closed: the moving deck covers the whole opening
  const pc = partPose(sw, 0); let reach = -Infinity;
  for (let i = 0; i < P.length; i += 3) { const q = posePoint(pc, [P[i], P[i + 1], P[i + 2]]); reach = Math.max(reach, (q[0] - p0[0]) * t[0] + (q[2] - p0[1]) * t[1]); }
  assert.ok(reach >= 80 - 0.01);
});

test('pontoon / retractable: the section moves clear of the line', () => {
  for (const mov of ['pontoon', 'retract']) {
    const r = buildBridge(bridge({ mov, clr: 0.3, clrO: null, b: 52, w: 12 }), { lod: LOD3D.MID });
    const p = r.moving[0];
    assert.ok(Math.hypot(...p.move) > 12, mov);
  }
});

test('overlapping FIS spans are merged (Calandbrug lift inside its fixed passage)', () => {
  const o = bridge({}, { spans: [{ id: 0, a: 54.86, b: 100.86, mov: 'lift', clr: 11.7, clrO: 49.7, w: 46, rec: 1 }, { id: 1, a: 43, b: 123, mov: 'fixed', clr: 11.7, clrO: null, w: 80, rec: 0 }] });
  const d = drawnSpans(o);
  assert.equal(d.length, 1); assert.equal(d[0].mov, 'lift'); assert.deepEqual(d[0].absorbed, [1]);
});

test('lock: water rides level(t), gates closed/open, floating bollards only when flagged (§10.7.6)', () => {
  const lock = JSON.parse(fs.readFileSync(new URL('./fixtures/ww3d/rotterdam.json', import.meta.url))).objects.find((x) => x.id === 'fis:4199');
  assert.ok(lock, 'Rozenburgsesluis in the fixture');
  const r = buildLock(lock, { lod: LOD3D.FULL, hi: 2.5, lo: -1.5 });
  const water = r.moving.find((p) => p.kind === 'water');
  const ch = { id: 'A', st: 'levelling', side: 0, t0: 0, dur: 258, level0: -0.5, level1: 0.5 };
  const lv = chamberLevel(ch, 129000);           // half time: remaining head (1 − ½)² · 1.0 = 0.25
  assert.ok(near(lv, 0.25), `level ${lv}`);
  assert.ok(near(partPose(water, lv).pos[1], 0.25), 'water part follows the level (move = [0, 1, 0])');
  // mitre gates: 4 leaves; closed leaves reach the axis, open leaves lie along the wall
  const gates = r.moving.filter((p) => p.kind === 'gate');
  assert.equal(gates.length, 4);
  const cut = r.cut[0];
  const vOf = (q) => (q[0] - cut.C[0]) * cut.v[0] + (q[2] - cut.C[1]) * cut.v[1];
  for (const g of gates) {
    const P = g.mesh.pos; let minClosed = Infinity, minOpen = Infinity;
    for (let i = 0; i < P.length; i += 3) {
      minClosed = Math.min(minClosed, Math.abs(vOf(posePoint(partPose(g, 0), [P[i], P[i + 1], P[i + 2]]))));
      minOpen = Math.min(minOpen, Math.abs(vOf(posePoint(partPose(g, 1), [P[i], P[i + 1], P[i + 2]]))));
    }
    assert.ok(minClosed < 1.0, `closed leaf reaches the axis (${minClosed.toFixed(2)})`);
    assert.ok(minOpen > cut.hw - 1.5, `open leaf against the wall (${minOpen.toFixed(2)})`);
  }
  assert.equal(gateFrac({ st: 'admit', side: 0 }, 0, 0), 1); assert.equal(gateFrac({ st: 'admit', side: 0 }, 1, 0), 0);
  const fl = buildLock({ ...lock, chambers: lock.chambers.map((c) => ({ ...c, bollards: { ...c.bollards, floating: true } })) }, { lod: LOD3D.FULL });
  assert.ok(fl.moving.find((p) => p.kind === 'water').mesh.tris > water.mesh.tris, 'floating bollards ride with the water');
  assert.ok(inRing(cut.ring, cut.C[0], cut.C[1]), 'chamber cut-out contains the chamber centre');
  assert.equal(r.signals.length, 4, 'two faces on each head');
});

test('lock gate types: sector, lift, rolling, drop open', () => {
  const base = JSON.parse(fs.readFileSync(new URL('./fixtures/ww3d/rotterdam.json', import.meta.url))).objects.find((x) => x.id === 'fis:4199');
  for (const type of ['sector', 'lift', 'rolling', 'drop']) {
    const l = { ...base, chambers: base.chambers.map((c) => ({ ...c, gates: [{ head: 0, type, at: 0 }, { head: 1, type, at: c.len }] })) };
    const r = buildLock(l, { lod: LOD3D.FULL });
    const g = r.moving.filter((p) => p.kind === 'gate');
    assert.ok(g.length >= 2, type);
    const centre = (p, f) => { const pose = partPose(p, f), P = p.mesh.pos, c = [0, 0, 0]; for (let i = 0; i < P.length; i += 3) { const q = posePoint(pose, [P[i], P[i + 1], P[i + 2]]); c[0] += q[0]; c[1] += q[1]; c[2] += q[2]; } return c.map((v) => v / (P.length / 3)); };
    for (const p of g) { const a = centre(p, 0), b = centre(p, 1); assert.ok(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) > 2, `${type} moves`); }
  }
});

test('phone LOD: the Rotterdam fixture stays ≤ 30 objects and ≤ 60k tris; desktop ≤ 200k (§10.7.7)', () => {
  const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/ww3d/rotterdam.json', import.meta.url)));
  assert.ok(fx.objects.length >= 30, `fixture has ${fx.objects.length} objects`);
  const focus = { lat: fx.focus[0], lon: fx.focus[1] };
  for (const [dev, B] of [['phone', BUDGET3D.phone], ['desktop', BUDGET3D.desktop]]) {
    const items = fx.objects.map((o) => { const a = anchorOf(o), [x, z] = llToLocal(focus, a.lat, a.lon); return { o, dist: Math.hypot(x, z), type: o.chambers ? 'lock' : 'bridge' }; });
    // pass 1 with estimates, then the real counts (as WwMesh does after the first builds)
    let want = planLod(items, B);
    for (const it of items) it.tris = { [LOD3D.MID]: build(it.o, LOD3D.MID).tris, [LOD3D.FULL]: build(it.o, LOD3D.FULL).tris };
    want = planLod(items, B);
    let tris = 0, n = 0;
    items.forEach((it, k) => { if (want[k]) { n++; tris += build(it.o, want[k]).tris; } });
    assert.ok(n <= B.objects, `${dev}: ${n} objects`);
    assert.ok(tris <= B.tris, `${dev}: ${tris} tris ≤ ${B.tris}`);
    assert.ok(n >= 5, `${dev}: draws the nearby objects (${n})`);
  }
  function build(o, lod) { return o.chambers ? buildLock(o, { lod }) : buildBridge(o, { lod }); }
});

test('build cost per object stays within the main-thread budget (warm)', () => {
  const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/ww3d/rotterdam.json', import.meta.url)));
  const big = fx.objects.find((o) => o.id === 'fis:17838816') || fx.objects[0];
  for (let i = 0; i < 5; i++) buildBridge(big, { lod: LOD3D.FULL });
  const t = performance.now(); for (let i = 0; i < 10; i++) buildBridge(big, { lod: LOD3D.FULL });
  const ms = (performance.now() - t) / 10;
  assert.ok(ms < 25, `Botlekbrug full build ${ms.toFixed(2)} ms (desktop budget 4 ms on the target machine; CI slack)`);
});

test('datum offsets and tile-vector fallback', () => {
  assert.equal(datumOffset({ datum: 'NAP' }), 0);
  assert.equal(datumOffset({ datum: 'KP', kp: -0.4 }), -0.4);
  assert.equal(datumOffset({ datum: 'MHWS' }, { datumOffset: () => 1.995 }), 1.995);
  const vb = { p: [1000, 5000, 3000, 5000], w: 10, clr: 3.6, clrO: 24, wO: 24, mov: 2, e: 1, id: 'osm:w9', sp: [80, 160] };
  const o = bridgeFromVector(vb, 14, 8392, 5391);
  assert.equal(o.spans[0].mov, 'lift'); assert.equal(o.spans[0].clr, 3.6); assert.equal(o.src, 'osm');
  assert.ok(buildBridge(o, { lod: LOD3D.MID }).tris > 0);
});
