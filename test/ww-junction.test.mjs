// T-junction: a lock on the side branch and a movable bridge straight on (the reported bug). Each structure must get its
// own geometry on its own waterway (fender / guide walls never reach into the other's fairway), a closed gate / closed
// bridge must be a hard wall for the hull (client SDF) and for the server, and an open one must never block.
// Synthetic fixture + real NL places from the FIS registry (Westerhavensluis / Eelderbrug Groningen, Demmerikse sluis / brug).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBridge, buildLock, anchorOf, llToLocal, fairwayZones, ringDist, obstacleSdf, activeBarriers, LOD3D, chamberFrame, gateSegments } from '../public/js/wwgeom.js';
import { gateFrac, boomFrac, roadStop } from '../public/js/wwfmt.js';
import { createWaterworks, chamberFrameXY, toXY } from '../server/waterworks.js';
import { gateOpenFrac, headOpenFrac } from '../shared/waterworks.js';
import { loadFis } from '../server/fis.js';

const D2R = Math.PI / 180, LAT0 = 52.0, LON0 = 5.0;
const ll = (x, y) => [LAT0 + y / 110574, LON0 + x / (111320 * Math.cos(LAT0 * D2R))];     // x east, y north (m)

// ---------------------------------------------------------------------------------------------- synthetic T-junction
// Main canal runs north–south through (0, 0); the bridge crosses it 30 m north of the junction (deck east–west, a 10 m
// bascule opening over x −5 … 5). The side branch runs east: the lock's west (head 0) gate is 40 m east of the junction.
export const BRIDGE = { id: 'syn:tj-bridge', name: 'Kruisbrug', callName: 'Kruisbrug', kind: 'road', src: 'fis', e: 0, line: [ll(-30, 30), ll(30, 30)], lineSrc: 'synthetic', deckW: 12, structure: 'girder', datum: 'NAP',
  spans: [{ id: 0, a: 25, b: 35, mov: 'bascule', clr: 1.5, clrO: Infinity, w: 10, hinge: null, pivot: null, rec: 1 }], vhf: 18, call: 'vhf', hours: null, blocks: [], slots: null, lockId: null, head: null, pairedWith: null, fee: 0, notes: [], operator: 'Municipality', p: ll(0, 30) };
export const LOCK = { id: 'syn:tj-lock', name: 'Kruissluis', callName: 'Kruissluis', src: 'fis', e: 0, p: ll(90, 0),
  chambers: [{ id: 'A', kind: 'both', len: 100, wid: 16, sillUp: 3, sillDn: 3, axis: [ll(40, 0), ll(140, 0)], gates: [{ head: 0, type: 'mitre', at: 0 }, { head: 1, type: 'mitre', at: 100 }], bollards: { step: 15, floating: false, levels: 3 }, waiting: [] }],
  sides: [{ name: 'west', level: { kind: 'kp', h: 0 } }, { name: 'east', level: { kind: 'kp', h: 1.0 } }], doubleActing: false, vhf: 20, call: 'vhf', hours: null, blocks: [], fee: null, bridges: [], notices: [], operator: 'Water board' };

const zonesFor = (objs, me, anchor) => objs.filter((o) => o.id !== me.id).flatMap((o) => fairwayZones(o, anchor));
const build = (o, keepOut) => (o.chambers ? buildLock(o, { lod: LOD3D.FULL, anchor: anchorOf(o), keepOut }) : buildBridge(o, { lod: LOD3D.FULL, anchor: anchorOf(o), keepOut }));
const WALLS = new Set(['remmingwerk', 'guide', 'jetty']);
/** Wall obstacles of r that reach into another object's zones: [{ type, zone }]. A lock's guide walls may run under a
 *  bridge DECK (a pile row under a deck is normal); every wall must stay out of every other object's navigable water. */
function intrusions(r, zones0) {
  const zones = r.type === 'lock' ? zones0.filter((z) => z.kind === 'channel') : zones0;
  const out = [];
  for (const ob of r.obstacles || []) {
    if (!WALLS.has(ob.type)) continue;
    for (let k = 0; k <= 20; k++) {
      const x = ob.x0 + (ob.x1 - ob.x0) * (k / 20), z = ob.z0 + (ob.z1 - ob.z0) * (k / 20);
      const zn = zones.find((q) => ringDist(q.ring, x, z) < ob.r);
      if (zn) { out.push({ type: ob.type, zone: `${zn.id}:${zn.kind}` }); break; }
    }
  }
  return out;
}
/** The whole junction as the client's collision sees it: every object's static obstacles + its own closed barriers. */
function sdfWorld(objs, built, states) {
  return (lat, lon) => {
    let best = null;
    for (const o of objs) {
      const r = built.get(o.id), a = anchorOf(o), [x, z] = llToLocal(a, lat, lon);
      const obs = [...r.obstacles, ...activeBarriers(r, states(o))];
      const h = obstacleSdf(obs, x, z, 50); if (h && (!best || h.d < best.d)) best = { ...h, id: o.id };
    }
    return best;
  };
}
/** Does a hull of half beam hb sailing the straight path p0 → p1 (x, y metres) touch anything? → first hit | null */
function sail(sdf, p0, p1, hb = 2.5) {
  const n = Math.ceil(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) / 1);
  for (let i = 0; i <= n; i++) {
    const x = p0[0] + (p1[0] - p0[0]) * (i / n), y = p0[1] + (p1[1] - p0[1]) * (i / n);
    const [la, lo] = ll(x, y), h = sdf(la, lo);
    if (h && h.d < hb) return { at: [Math.round(x), Math.round(y)], id: h.id, type: h.ob.type };
  }
  return null;
}
const OPEN = { gateFrac: () => 1, spanBlocks: () => false };
const closed = (ad) => ({ gateFrac: () => 0, spanBlocks: (i) => ad > 1.5 });

test('T-junction (synthetic) BEFORE: without deconfliction the bridge fenders cross the lock approach and the lock guide walls cross the bridge fairway', () => {
  const objs = [BRIDGE, LOCK];
  const old = new Map(objs.map((o) => [o.id, build(o, [])]));
  const bi = intrusions(old.get(BRIDGE.id), zonesFor(objs, BRIDGE, anchorOf(BRIDGE)));
  const li = intrusions(old.get(LOCK.id), zonesFor(objs, LOCK, anchorOf(LOCK)));
  assert.ok(bi.some((x) => x.type === 'remmingwerk' && x.zone === 'syn:tj-lock:channel'), `bridge fender in the lock approach: ${JSON.stringify(bi)}`);
  assert.ok(li.some((x) => x.type === 'guide' && x.zone === 'syn:tj-bridge:channel'), `lock guide wall in the bridge fairway: ${JSON.stringify(li)}`);
  // … so with everything OPEN a ship turning into the lock hits the bridge's fender wall (the two "lock each other")
  const sdf = sdfWorld(objs, old, () => OPEN);
  assert.ok(sail(sdf, [-40, 0], [30, 0]), 'old geometry: the open lock approach is walled off by the bridge fender');
});

test('T-junction (synthetic) AFTER: each object keeps to its own waterway, nothing overlaps, open ways are free', () => {
  const objs = [BRIDGE, LOCK];
  const built = new Map(objs.map((o) => [o.id, build(o, zonesFor(objs, o, anchorOf(o)))]));
  assert.deepEqual(intrusions(built.get(BRIDGE.id), zonesFor(objs, BRIDGE, anchorOf(BRIDGE))), []);
  assert.deepEqual(intrusions(built.get(LOCK.id), zonesFor(objs, LOCK, anchorOf(LOCK))), []);
  // the walls were shortened, not deleted: the bridge keeps its north fenders whole and short south ones, the lock its
  // guide walls on the far (east) head whole
  const rem = built.get(BRIDGE.id).obstacles.filter((o) => o.type === 'remmingwerk');
  assert.equal(rem.length, 4, 'four fender walls');
  assert.ok(built.get(LOCK.id).obstacles.filter((o) => o.type === 'guide').length >= 3);
  const sdf = sdfWorld(objs, built, () => OPEN);
  assert.equal(sail(sdf, [0, -60], [0, 90], 2.0), null, 'straight on under the open bridge: free');
  assert.equal(sail(sdf, [-40, 0], [150, 0], 2.5), null, 'left/right into and through the open lock: free');
});

test('T-junction (synthetic): a closed gate and a closed bridge are walls, each from its own state only', () => {
  const objs = [BRIDGE, LOCK];
  const built = new Map(objs.map((o) => [o.id, build(o, zonesFor(objs, o, anchorOf(o)))]));
  // both closed (a sloop with a 17 m mast)
  let sdf = sdfWorld(objs, built, () => closed(17));
  const hb = sail(sdf, [0, -60], [0, 90], 2.0), hl = sail(sdf, [-40, 0], [150, 0], 2.5);
  assert.ok(hb && hb.id === BRIDGE.id && hb.type === 'span' && hb.at[1] < 30, `stopped by the closed bridge: ${JSON.stringify(hb)}`);
  assert.ok(hl && hl.id === LOCK.id && hl.type === 'gate' && hl.at[0] < 45, `stopped by the closed lock gate: ${JSON.stringify(hl)}`);
  // lock closed, bridge open: the bridge way is free, the lock still blocks — and the other way round
  sdf = sdfWorld(objs, built, (o) => (o.chambers ? closed(17) : OPEN));
  assert.equal(sail(sdf, [0, -60], [0, 90], 2.0), null);
  assert.ok(sail(sdf, [-40, 0], [150, 0], 2.5)?.type === 'gate');
  sdf = sdfWorld(objs, built, (o) => (o.chambers ? OPEN : closed(17)));
  assert.equal(sail(sdf, [-40, 0], [150, 0], 2.5), null);
  assert.ok(sail(sdf, [0, -60], [0, 90], 2.0)?.type === 'span');
  // a low motor boat (air draught 1.2 m) passes under the closed 1.5 m bascule
  sdf = sdfWorld(objs, built, (o) => (o.chambers ? OPEN : closed(1.2)));
  assert.equal(sail(sdf, [0, -60], [0, 90], 2.0), null);
});

test('client gate fraction: standsopen (as the server sends it) opens both heads; road barriers follow the span', () => {
  assert.equal(gateFrac({ st: 'standsopen', side: 0 }, 0, 0), 1);
  assert.equal(gateFrac({ st: 'standsopen', side: 0 }, 1, 0), 1);
  const T = 1_700_000_000_000;
  assert.equal(boomFrac({ st: 'closed', t0: 0 }, T), 0);
  assert.equal(boomFrac({ st: 'warn', t0: (T - 1000) / 1000, dur: 60 }, T), 0, 'lights first');
  assert.equal(boomFrac({ st: 'warn', t0: (T - 20000) / 1000, dur: 60 }, T), 1, 'then down');
  assert.equal(boomFrac({ st: 'open', t0: T / 1000, dur: 360 }, T), 1);
  assert.ok(boomFrac({ st: 'closed', t0: (T - 4000) / 1000 }, T) > 0, 'rising after the span locked');
  assert.equal(roadStop({ st: 'warn', t0: T / 1000, dur: 60 }, T), true);
  assert.equal(roadStop({ st: 'closed', t0: 0 }, T), false);
  const r = buildBridge(BRIDGE, { lod: LOD3D.FULL });
  assert.equal(r.booms.length, 4, 'two half barriers at each end');
  assert.ok(r.road && r.road.stops[0] < 25 && r.road.stops[1] > 35, 'stop lines outside the opening');
  assert.equal(r.signals.filter((s) => s.kind === 'road').length, 2);
});

test('server and client agree on the closed gate geometry', () => {
  const ch = LOCK.chambers[0], a = anchorOf(LOCK), F = chamberFrame(ch, a), S = chamberFrameXY(ch);
  for (const h of [0, 1]) {
    const cs = gateSegments(F, h), ss = S.gates[h];
    assert.equal(cs.length, ss.length);
    // client (x east, z south, about the anchor) → lat/lon → server frame (x east, y north, about the axis middle);
    // the leaves are the same set (the two frames are mirror images, so the order of the leaves may swap)
    const toS = (x, z) => { const lat = a.lat - z / 110574, lon = a.lon + x / (111320 * Math.cos(lat * D2R)); return toXY([lat, lon], S.o); };
    for (const c of cs) {
      const p0 = toS(c[0], c[1]), p1 = toS(c[2], c[3]);
      const m = ss.find((q) => Math.hypot(q[0][0] - p0[0], q[0][1] - p0[1]) < 0.3 && Math.hypot(q[1][0] - p1[0], q[1][1] - p1[1]) < 0.3);
      assert.ok(m, `head ${h}: client leaf ${p0.map((v) => v.toFixed(2))} → ${p1.map((v) => v.toFixed(2))} has a server twin`);
    }
  }
  // the server's gate table = the client's
  for (const st of ['idle', 'admit', 'closing', 'levelling', 'opening', 'release', 'standsopen']) for (const side of [0, 1]) for (const h of [0, 1]) {
    assert.equal(gateOpenFrac(st, side, h, 0.5), gateFrac({ st, side, t0: 0, dur: 1 }, h, 500), `${st} ${side} ${h}`);
  }
  assert.equal(headOpenFrac({ st: 'release', side: 0, t0: 0, dur: 360 }, 1, 10), 1, 'release opens the far head');
});

// ---------------------------------------------------------------------------------------------- server authority
function server(T) {
  const ww = createWaterworks(null, { bridges: [BRIDGE], locks: [LOCK] }, { now: () => T.t, water: () => 0 });
  return ww;
}
const ship = (x, y, hdg, cls = 'sloop') => { const [lat, lon] = ll(x, y); return { id: 'me', ship: { cls, lat, lon, hdg, spd: 4 }, cargo: [], fuel: 1 }; };

test('server: a ship may not sail through a closed bridge or a closed lock gate, and is never stopped by an open one', () => {
  const T = { t: 1_800_000_000 };
  const ww = server(T), { bstate, lstate } = ww._debug;
  // bridge closed (sloop, 17 m mast vs 1.5 m): crossing the deck line is rejected with a clear message
  let r = ww.barrierCheck(ship(0, 22, 0), ...ll(0, 38), 0);
  assert.ok(r && r.kind === 'bridge' && /Kruisbrug is closed/.test(r.msg) && /VHF 18/.test(r.msg), JSON.stringify(r));
  // approaching up to the deck edge (bow short of the line) is fine
  assert.equal(ww.barrierCheck(ship(0, 10, 0), ...ll(0, 12), 0), null);
  // fully open → free; opening at 99 % (a bascule counts as closed until fully open) but finishing within the grace → free
  bstate.get(BRIDGE.id).spans[0] = { st: 'open', t0: T.t - 10, dur: 360, tOpen: null };
  assert.equal(ww.barrierCheck(ship(0, 22, 0), ...ll(0, 38), 0), null, 'open bridge: no block');
  bstate.get(BRIDGE.id).spans[0] = { st: 'opening', t0: T.t - 69, dur: 70, tOpen: null };
  assert.equal(ww.barrierCheck(ship(0, 22, 0), ...ll(0, 38), 0), null, 'opens within the grace window: no false block');
  bstate.get(BRIDGE.id).spans[0] = { st: 'closing', t0: T.t - 20, dur: 70, tOpen: null };
  assert.ok(ww.barrierCheck(ship(0, 22, 0), ...ll(0, 38), 0), 'closing: blocked');
  // passing beside the opening (not crossing the deck) is not the bridge's business
  assert.equal(ww.barrierCheck(ship(-60, 22, 0), ...ll(-60, 38), 0), null);

  // lock: levelling → both heads closed: entering from the west is rejected, the bridge plays no part
  const cs = lstate.get(LOCK.id).chambers[0];
  Object.assign(cs, { st: 'levelling', side: 0, t0: T.t - 10, dur: 300 });
  r = ww.barrierCheck(ship(30, 0, 90), ...ll(46, 0), 90);
  assert.ok(r && r.kind === 'lock' && r.head === 0 && /west gates of chamber A are closed/.test(r.msg), JSON.stringify(r));
  // the bow may not be pushed across the gate line either (the centre stays outside)
  r = ww.barrierCheck(ship(30, 0, 90), ...ll(35.5, 0), 90);
  assert.ok(r && r.kind === 'lock', 'hull reaching across the closed gate');
  // admit on the west side: head 0 open → free; head 1 (east) still closed
  Object.assign(cs, { st: 'admit', side: 0, t0: T.t - 5, dur: 600 });
  assert.equal(ww.barrierCheck(ship(30, 0, 90), ...ll(46, 0), 90), null, 'admit: west gate open');
  assert.ok(ww.barrierCheck(ship(136, 0, 90), ...ll(146, 0), 90)?.head === 1, 'east gate closed');
  // release (server side 0 = came in from the west): the east head opens
  Object.assign(cs, { st: 'release', side: 0, t0: T.t - 5, dur: 360 });
  assert.equal(ww.barrierCheck(ship(136, 0, 90), ...ll(146, 0), 90), null);
  // stands open (zero lift): both heads free
  Object.assign(cs, { st: 'standsopen', side: 0, t0: T.t, dur: 0 });
  assert.equal(ww.barrierCheck(ship(30, 0, 90), ...ll(46, 0), 90), null);
  assert.equal(ww.barrierCheck(ship(136, 0, 90), ...ll(146, 0), 90), null);
  // the bridge's state never affects the lock and vice versa
  bstate.get(BRIDGE.id).spans[0] = { st: 'closed', t0: 0, dur: 0, tOpen: null };
  assert.equal(ww.barrierCheck(ship(30, 0, 90), ...ll(46, 0), 90), null, 'closed bridge does not close the lock');
});

// ---------------------------------------------------------------------------------------------- real NL junctions
const fis = loadFis();
const REAL = [
  { lock: 'fis:4176', bridge: 'fis:42713', where: 'Westerhavensluis / Eelderbrug, Groningen' },
  { lock: 'fis:37747', bridge: 'fis:31193', where: 'Demmerikse sluis / Demmerikse brug, Vinkeveen' },
  { lock: 'fis:19922', bridge: 'fis:21910978', where: 'Westerkanaalschutsluis / IJszeebrug, Amsterdam' },
];
for (const c of REAL) {
  test(`real junction ${c.where}: walls deconflicted, closed objects block, open ones free`, () => {
    const lock = fis.locks.find((o) => o.id === c.lock), bridge = fis.bridges.find((o) => o.id === c.bridge);
    assert.ok(lock && bridge, 'both in the registry');
    // all registry objects within 700 m are neighbours, as in the client
    const a = anchorOf(lock);
    const objs = [...fis.locks, ...fis.bridges].filter((o) => { const b = anchorOf(o), [x, z] = llToLocal(a, b.lat, b.lon); return Math.hypot(x, z) < 700; });
    const olds = [lock, bridge].map((o) => intrusions(build(o, []), zonesFor(objs, o, anchorOf(o))).length);
    const news = [lock, bridge].map((o) => intrusions(build(o, zonesFor(objs, o, anchorOf(o))), zonesFor(objs, o, anchorOf(o))));
    assert.deepEqual(news, [[], []], `after: ${JSON.stringify(news)} (before: ${olds})`);
    assert.ok(olds[0] + olds[1] > 0, `the real junction reproduces the overlap without deconfliction (${olds})`);
    if (process.env.WW_DEBUG) console.log(c.where, "walls into a neighbour before:", olds, "after:", news.map((x) => x.length));
    // server: a closed head blocks the way through the lock, an open one does not
    const T = { t: 1_800_000_000 }, ww = createWaterworks(null, { bridges: [bridge], locks: [lock] }, { now: () => T.t, water: () => 0 });
    const S = chamberFrameXY(lock.chambers[0]);
    // a point 8 m outside head 0 → 8 m inside, on the axis
    const mid = (k) => { const u = S.u, base = [(S.gates[0][0][0][0] + S.gates[0][S.gates[0].length - 1][0][0]) / 2, (S.gates[0][0][0][1] + S.gates[0][S.gates[0].length - 1][0][1]) / 2]; const x = base[0] + u[0] * k, y = base[1] + u[1] * k; return [S.o[0] + y / 110540, S.o[1] + x / (111320 * Math.cos(S.o[0] * D2R))]; };
    const hdg = (Math.atan2(S.u[0], S.u[1]) / D2R + 360) % 360;
    const p = { id: 'me', ship: { cls: 'sloop', lat: mid(-8)[0], lon: mid(-8)[1], hdg, spd: 3 }, cargo: [], fuel: 1 };
    Object.assign(ww._debug.lstate.get(lock.id).chambers[0], { st: 'levelling', side: 0, t0: T.t, dur: 300 });
    assert.equal(ww.barrierCheck(p, ...mid(8), hdg)?.kind, 'lock', 'closed head blocks');
    Object.assign(ww._debug.lstate.get(lock.id).chambers[0], { st: 'admit', side: 0, t0: T.t, dur: 600 });
    assert.equal(ww.barrierCheck(p, ...mid(8), hdg), null, 'open head is free');
  });
}

test('real multi-chamber lock (Sluis Weurt): one chamber\'s walls never close its sister chamber; open chambers sail through, closed ones stop', () => {
  const lock = fis.locks.find((o) => o.id === 'fis:49032');
  assert.ok(lock && lock.chambers.length >= 2);
  const a = anchorOf(lock), r = buildLock(lock, { lod: LOD3D.FULL, anchor: a });
  for (const [ci, ch] of lock.chambers.entries()) {
    const F = chamberFrame(ch, a);
    const pt = (uu) => F.P2(uu, 0);
    const run = (st) => {
      const obs = [...r.obstacles, ...activeBarriers(r, st)];
      for (let uu = F.uMin - 60; uu <= F.uMax + 60; uu += 2) { const [x, z] = pt(uu), h = obstacleSdf(obs, x, z, 50); if (h && h.d < Math.min(4, F.hw - 1)) return { uu: Math.round(uu), type: h.ob.type }; }
      return null;
    };
    assert.equal(run(OPEN), null, `chamber ${ch.id} open: free along its axis`);
    const hit = run({ gateFrac: (c) => (String(c) === String(ch.id) ? 0 : 1), spanBlocks: () => false });
    assert.ok(hit && hit.type === 'gate', `chamber ${ch.id} closed: ${JSON.stringify(hit)}`);
    void ci;
  }
});
