// V5 items 6 + 7 — walking the ship: every class has a bridge, a passage, a mess, an engine room and open deck, all
// connected; every stair can be walked up and down without hitting a wall at its foot or head; a walker driven with
// the game's own movement code gets from the bridge to the engine room and out onto the deck.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, outlineHalf, halfBeamAt, shipDims, R } from '../public/js/shipplan.js';
import { WalkMap, rampY, stairEnds } from '../public/js/walker.js';
import { SHIP_CLASSES } from '../shared/constants.js';

const CLASSES = Object.keys(SHIP_CLASSES);
const plans = new Map(), maps = new Map();
for (const cls of CLASSES) { const p = buildPlan(cls, SHIP_CLASSES[cls]); plans.set(cls, p); maps.set(cls, new WalkMap(p)); }
const NEED = ['bridge', 'passage', 'mess', 'engine', 'deck'];

// ------------------------------------------------------------------ lattice flood fill over standable points
function flood(map, start, { cell = 0.1, goal = null, maxNodes = 3e6 } = {}) {
  const key = (i, j, y) => ((i + 20000) * 40000 + (j + 20000)) * 4096 + Math.round(y * 40) + 2048;
  const y0 = map.standAt(start.x, start.z, start.y, 0.5);
  if (y0 == null) throw new Error(`start not standable at ${start.x.toFixed(2)},${start.z.toFixed(2)} y${start.y}`);
  let i0 = Math.round(start.x / cell), j0 = Math.round(start.z / cell);
  if (map.standAt(i0 * cell, j0 * cell, y0, 0.3) == null) { // snap to the nearest standable lattice point
    let best = null;
    for (let di = -3; di <= 3; di++) for (let dj = -3; dj <= 3; dj++) {
      const x = (i0 + di) * cell, z = (j0 + dj) * cell, d = Math.hypot(x - start.x, z - start.z);
      if (map.standAt(x, z, y0, 0.3) != null && (!best || d < best.d)) best = { i: i0 + di, j: j0 + dj, d };
    }
    if (best) { i0 = best.i; j0 = best.j; }
  }
  const seen = new Map(), qi = [i0], qj = [j0], qy = [y0];
  seen.set(key(i0, j0, y0), -1);
  const keys = [key(i0, j0, y0)];
  for (let h = 0; h < qi.length && qi.length < maxNodes; h++) {
    const i = qi[h], j = qj[h], y = qy[h];
    if (goal && goal(i * cell, j * cell, y)) {
      const path = []; let k = keys[h], idx = h;
      while (idx >= 0) { path.push({ x: qi[idx] * cell, z: qj[idx] * cell, y: qy[idx] }); idx = seen.get(keys[idx]); }
      void k; return { path: path.reverse(), count: qi.length };
    }
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di, nj = j + dj, ny = map.standAt(ni * cell, nj * cell, y, 0.3);
      if (ny == null) continue;
      const k = key(ni, nj, ny);
      if (seen.has(k)) continue;
      seen.set(k, h); keys.push(k); qi.push(ni); qj.push(nj); qy.push(ny);
    }
  }
  if (goal) return { path: null, count: qi.length };
  return { qi, qj, qy, cell, count: qi.length };
}
const cellFor = (p) => (p.L > 120 ? 0.15 : 0.1);
const reachCache = new Map();
function reach(cls) {
  if (!reachCache.has(cls)) { const p = plans.get(cls); reachCache.set(cls, flood(maps.get(cls), p.spawn, { cell: cellFor(p) })); }
  return reachCache.get(cls);
}

// ------------------------------------------------------------------ simulated walking with the game's move()
/** Walk straight along z from st toward zTarget at walking pace; returns the trace. */
function walkZ(map, st, zTarget, { seconds = 30, speed = 1.7, dt = 1 / 30 } = {}) {
  const dir = Math.sign(zTarget - st.z), hits = [];
  let t = 0;
  while (t < seconds && (zTarget - st.z) * dir > 0) {
    const f = map.speedFactor(st.x, st.z, st.y);
    const r = map.move(st, 0, dir * speed * f * dt);
    if (r.hit) hits.push({ x: st.x, z: st.z, y: st.y, moved: r.moved });
    if (r.moved < 1e-4 && hits.length > 3) break;
    t += dt;
  }
  return { st, hits, t };
}
/** Follow waypoints the way a player steers: head for the next point, walk. */
function followPath(map, start, pts, { speed = 1.7, dt = 1 / 30, maxSeconds = 600 } = {}) {
  const st = { x: start.x, z: start.z, y: start.y };
  let k = 0, t = 0, stuck = 0;
  while (k < pts.length && t < maxSeconds) {
    const p = pts[k], dx = p.x - st.x, dz = p.z - st.z, d = Math.hypot(dx, dz);
    if (d < 0.12 && Math.abs(p.y - st.y) < 0.4) { k++; continue; }
    const f = map.speedFactor(st.x, st.z, st.y), step = Math.min(d, speed * f * dt);
    const r = map.move(st, (dx / d) * step, (dz / d) * step);
    stuck = r.moved < 1e-4 ? stuck + 1 : 0;
    if (stuck > 30) return { ok: false, st, k, t, at: p };
    t += dt;
  }
  return { ok: k >= pts.length, st, k, t };
}
function thin(path, every = 4) { const out = []; for (let i = 0; i < path.length; i += every) out.push(path[i]); out.push(path[path.length - 1]); return out; }
const inRoom = (r, x, z, y) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1 && Math.abs(y - r.y) < 0.06;

// ================================================================== structure
test('interior: every class has a bridge, passage, mess, engine room and open deck; rooms sit inside the hull', () => {
  assert.equal(CLASSES.length, 17);
  for (const cls of CLASSES) {
    const p = plans.get(cls);
    for (const k of NEED) assert.ok(p.rooms.some((r) => r.kind === k && r.walk !== false), `${cls}: no ${k} room`);
    assert.ok(p.rooms.some((r) => r.kind === 'deck' && r.open), `${cls}: no open deck`);
    assert.ok(p.hotspots.some((h) => h.kind === 'helm'), `${cls}: no helm`);
    assert.ok(p.hotspots.some((h) => h.kind === 'engine'), `${cls}: no engine console`);
    assert.ok(p.props.some((q) => q.t === 'engine'), `${cls}: no engine block`);
    assert.ok(p.props.some((q) => q.t === 'console'), `${cls}: no engine control console`);
    if ((SHIP_CLASSES[cls].pax || 0) >= 4) assert.ok(p.rooms.some((r) => r.kind === 'cabin'), `${cls}: no cabin`);
    assert.ok(p.spawn && map(cls).standAt(p.spawn.x, p.spawn.z, p.spawn.y) != null, `${cls}: spawn not standable`);
    // enclosed rooms below or on the main deck stay inside the plating (catamaran: inside its hulls / bridge deck)
    if (cls === 'catamaran') continue;
    const d = shipDims(SHIP_CLASSES[cls]), half = outlineHalf(cls, d.L, d.B);
    for (const r of p.rooms) {
      if (r.open || r.y > d.deckY + 0.1) continue;
      for (const z of [r.z0, r.z1, (r.z0 + r.z1) / 2]) {
        const hb = halfBeamAt(half, z);
        assert.ok(Math.max(Math.abs(r.x0), Math.abs(r.x1)) <= hb + 0.01, `${cls}: ${r.id} pokes out of the hull at z ${z.toFixed(1)} (|x| ${Math.max(Math.abs(r.x0), Math.abs(r.x1)).toFixed(2)} > ${hb.toFixed(2)})`);
      }
    }
  }
});
function map(cls) { return maps.get(cls); }

test('interior: doorways are wide enough, in a real wall, and level on both sides', () => {
  for (const cls of CLASSES) {
    const p = plans.get(cls), byId = new Map(p.rooms.map((r) => [r.id, r]));
    for (const d of p.doors) {
      const a = byId.get(d.a), b = d.b ? byId.get(d.b) : null;
      assert.ok(a, `${cls}: door from missing room ${d.a}`);
      assert.ok(d.w >= 0.72, `${cls}: door ${d.a}/${d.side} only ${d.w} m wide`);
      assert.ok(d.w - 2 * R >= 0.2, `${cls}: door ${d.a}/${d.side} leaves no walk band`);
      const along = d.side === 'n' || d.side === 's' ? [a.x0, a.x1] : [a.z0, a.z1];
      assert.ok(d.at - d.w / 2 >= along[0] - 0.01 && d.at + d.w / 2 <= along[1] + 0.01, `${cls}: door ${d.a}/${d.side} at ${d.at} runs past its wall`);
      if (b) {
        assert.ok(Math.abs(a.y - b.y) < 0.06, `${cls}: door ${d.a}→${d.b} joins floors ${a.y} and ${b.y}`);
        if (!b.open && !(b.cuts || []).length) {
          const c = { n: a.z0, s: a.z1, w: a.x0, e: a.x1 }[d.side], cb = { n: b.z1, s: b.z0, w: b.x1, e: b.x0 }[d.side];
          assert.ok(Math.abs(c - cb) < 0.06, `${cls}: door ${d.a}→${d.b}: rooms do not share that wall`);
          const alongB = d.side === 'n' || d.side === 's' ? [b.x0, b.x1] : [b.z0, b.z1];
          assert.ok(d.at - d.w / 2 >= alongB[0] - 0.01 && d.at + d.w / 2 <= alongB[1] + 0.01, `${cls}: door ${d.a}→${d.b} runs past ${d.b}'s wall`);
        }
      }
      // both sides of the opening are standable, a step in front of it
      const m = map(cls), n = d.side === 'n' || d.side === 's';
      const c = { n: a.z0, s: a.z1, w: a.x0, e: a.x1 }[d.side];
      for (const off of [-0.4, 0.4]) {
        const x = n ? d.at : c + off, z = n ? c + off : d.at;
        assert.ok(m.standAt(x, z, d.y) != null, `${cls}: door ${d.a}/${d.side} blocked ${off < 0 ? 'outside' : 'inside'} at ${x.toFixed(2)},${z.toFixed(2)}`);
      }
    }
  }
});

test('interior: stairs land level with the decks they join; landings at both ends are clear', () => {
  for (const cls of CLASSES) {
    const p = plans.get(cls), m = map(cls), byId = new Map(p.rooms.map((r) => [r.id, r]));
    for (const s of p.stairs) {
      const foot = byId.get(s.foot), head = byId.get(s.head);
      assert.ok(foot && head, `${cls}: ${s.id} foot/head room missing`);
      assert.ok(Math.abs(foot.y - s.yLow) < 0.02, `${cls}: ${s.id} foot ${s.yLow} vs room ${foot.y}`);
      assert.ok(Math.abs(head.y - s.yHigh) < 0.02, `${cls}: ${s.id} head ${s.yHigh} vs room ${head.y}`);
      const ang = Math.atan2(s.yHigh - s.yLow, s.z1 - s.z0) * 180 / Math.PI;
      assert.ok(ang > 20 && ang < 62, `${cls}: ${s.id} is ${ang.toFixed(0)}° steep`);
      assert.ok(s.x1 - s.x0 >= 0.7, `${cls}: ${s.id} only ${(s.x1 - s.x0).toFixed(2)} m wide`);
      const { footZ, headZ, upDir, cx } = stairEnds(s);
      // headroom: no floor of another room above the ramp lower than 1.95 m over the treads
      for (let t = 0.05; t <= 0.95; t += 0.1) {
        const z = footZ + (headZ - footZ) * t, y = rampY(s, z);
        for (const r of p.rooms) {
          if (r.open || r.id === s.head || cx < r.x0 || cx > r.x1 || z < r.z0 || z > r.z1) continue;
          const holes = r.floorHoles.some((h) => cx >= h.x0 && cx <= h.x1 && z >= h.z0 && z <= h.z1);
          if (r.y > y + 0.1 && r.y < y + 1.95 && !holes) assert.fail(`${cls}: ${s.id} hits the floor of ${r.id} (${r.y}) at z ${z.toFixed(2)} y ${y.toFixed(2)}`);
        }
      }
      assert.ok(m.standAt(cx, footZ - upDir * 0.45, s.yLow) != null, `${cls}: ${s.id} foot landing blocked`);
      assert.ok(m.standAt(cx, headZ + upDir * 0.45, s.yHigh) != null, `${cls}: ${s.id} head landing blocked`);
    }
  }
});

// ================================================================== reachability (flood fill over the lattice)
test('interior: from the bridge every room and every hotspot can be reached on foot', () => {
  for (const cls of CLASSES) {
    const p = plans.get(cls), R0 = reach(cls);
    const { qi, qj, qy, cell } = R0;
    for (const r of p.rooms) {
      if (r.walk === false) continue;
      let ok = false;
      for (let n = 0; n < qi.length && !ok; n++) if (inRoom(r, qi[n] * cell, qj[n] * cell, qy[n])) ok = true;
      assert.ok(ok, `${cls}: room ${r.id} (${r.kind}) cannot be reached from the bridge`);
    }
    for (const h of p.hotspots) {
      let ok = false;
      for (let n = 0; n < qi.length && !ok; n++) if (Math.hypot(qi[n] * cell - h.x, qj[n] * cell - h.z) < h.r - 0.25 && Math.abs(qy[n] - h.y) < 0.5) ok = true;
      assert.ok(ok, `${cls}: hotspot ${h.kind} "${h.label}" at ${h.x.toFixed(1)},${h.z.toFixed(1)} cannot be reached`);
    }
    // every kind the player asked for is in the same connected walk
    for (const k of NEED) {
      let ok = false;
      for (const r of p.rooms.filter((q) => q.kind === k)) for (let n = 0; n < qi.length && !ok; n++) if (inRoom(r, qi[n] * cell, qj[n] * cell, qy[n])) ok = true;
      assert.ok(ok, `${cls}: no ${k} reachable`);
    }
  }
});

test('interior: the open deck reaches from the bow to the stern (foredeck walkable up to the pulpit / forecastle)', () => {
  // regression: the sloop's foredeck strip was dropped because it was measured at its narrow bow end, so "out on deck"
  // was only a strip round the companionway hatch; side decks beside the mast were pinched to a few centimetres
  for (const cls of CLASSES) {
    const p = plans.get(cls), m = map(cls), { qi, qj, qy, cell } = reach(cls);
    let zmin = Infinity, zmax = -Infinity;
    for (let n = 0; n < qi.length; n++) { const r = m.roomAt(qi[n] * cell, qj[n] * cell, qy[n]); if (r && r.open) { zmin = Math.min(zmin, qj[n] * cell); zmax = Math.max(zmax, qj[n] * cell); } }
    const fwdGap = zmin + p.L / 2, aftGap = p.L / 2 - zmax;
    const fwdMax = cls === 'ferry' ? 0.3 * p.L : Math.max(3.2, 0.1 * p.L); // a ro-pax bow is closed by the visor
    assert.ok(fwdGap <= fwdMax, `${cls}: the nearest walkable open deck is ${fwdGap.toFixed(1)} m from the bow (max ${fwdMax.toFixed(1)})`);
    assert.ok(aftGap <= Math.max(3.5, 0.05 * p.L), `${cls}: the nearest walkable open deck is ${aftGap.toFixed(1)} m from the stern`);
  }
});

// ================================================================== stairs, walked
test('interior: every stair walked up and down straight — reaches the other deck without touching a wall', () => {
  for (const cls of CLASSES) {
    const p = plans.get(cls), m = map(cls), byId = new Map(p.rooms.map((r) => [r.id, r]));
    for (const s of p.stairs) {
      const { footZ, headZ, upDir, cx } = stairEnds(s);
      for (const dir of ['up', 'down']) {
        const fromZ = dir === 'up' ? footZ - upDir * 0.5 : headZ + upDir * 0.5;
        const toZ = dir === 'up' ? headZ + upDir * 0.55 : footZ - upDir * 0.55;
        const y0 = dir === 'up' ? s.yLow : s.yHigh, y1 = dir === 'up' ? s.yHigh : s.yLow;
        const st = { x: cx, z: fromZ, y: y0 };
        assert.ok(m.standAt(st.x, st.z, y0) != null, `${cls}: ${s.id} ${dir}: start not standable`);
        const r = walkZ(m, st, toZ);
        assert.equal(r.hits.length, 0, `${cls}: ${s.id} ${dir}: hit something at ${JSON.stringify(r.hits[0])}`);
        assert.ok(Math.abs(st.y - y1) < 0.02, `${cls}: ${s.id} ${dir}: ended at y ${st.y.toFixed(2)}, wanted ${y1}`);
        const room = byId.get(dir === 'up' ? s.head : s.foot);
        assert.ok(inRoom({ ...room, x0: room.x0 - 0.5, x1: room.x1 + 0.5, z0: room.z0 - 0.5, z1: room.z1 + 0.5 }, st.x, st.z, st.y), `${cls}: ${s.id} ${dir}: did not arrive in ${room.id}`);
      }
    }
  }
});

test('interior: stairs forgive a sloppy approach — off-centre and diagonal walkers are funnelled onto the treads', () => {
  for (const cls of CLASSES) {
    const p = plans.get(cls), m = map(cls);
    for (const s of p.stairs) {
      const { footZ, headZ, upDir, cx } = stairEnds(s);
      const w = s.x1 - s.x0;
      for (const off of [-1, 1]) {
        // up: start a little before the foot, 0.4 of the stair width off the centre line
        const st = { x: cx + off * w * 0.42, z: footZ - upDir * 0.5, y: s.yLow };
        if (m.standAt(st.x, st.z, st.y) == null) continue; // that side is a wall / bulkhead
        const r = walkZ(m, st, headZ + upDir * 0.5, { seconds: 20 });
        assert.ok(Math.abs(st.y - s.yHigh) < 0.02, `${cls}: ${s.id} off-centre (${off}) up ended at y ${st.y.toFixed(2)} z ${st.z.toFixed(2)} (wanted ${s.yHigh})`);
        void r;
      }
      // diagonal: heading 14° off the stair axis from the head landing still gets down
      const st = { x: cx, z: headZ + upDir * 0.5, y: s.yHigh };
      let t = 0;
      while (t < 20 && Math.abs(st.y - s.yLow) > 0.01) {
        const f = m.speedFactor(st.x, st.z, st.y);
        m.move(st, Math.sin(0.25) * 1.7 * f / 30 * (cls.length % 2 ? 1 : -1), -upDir * Math.cos(0.25) * 1.7 * f / 30);
        t += 1 / 30;
      }
      assert.ok(Math.abs(st.y - s.yLow) < 0.02, `${cls}: ${s.id} diagonal descent stuck at y ${st.y.toFixed(2)} z ${st.z.toFixed(2)}`);
    }
  }
});

// ================================================================== the player's walk: bridge → engine room → deck
test('interior: walking from the bridge down to the engine room, out onto the open deck and back to the helm (game movement code)', () => {
  for (const cls of CLASSES) {
    const p = plans.get(cls), m = map(cls), cell = cellFor(p);
    const eng = p.hotspots.find((h) => h.kind === 'engine'), helm = p.helm;
    const r1 = flood(m, { x: helm.x, z: helm.z + 0.3, y: helm.y }, { cell, goal: (x, z, y) => Math.hypot(x - eng.x, z - eng.z) < 0.6 && Math.abs(y - eng.y) < 0.3 });
    assert.ok(r1.path, `${cls}: no path bridge → engine room`);
    const w1 = followPath(m, r1.path[0], thin(r1.path));
    assert.ok(w1.ok, `${cls}: walker stuck going to the engine room at ${JSON.stringify(w1.st)} (waypoint ${w1.k})`);
    const decks = p.rooms.filter((r) => r.kind === 'deck' && r.open);
    const outside = (x, z, y) => { const q = m.roomAt(x, z, y); return !!q && q.open && q.kind === 'deck'; };
    const r2 = flood(m, w1.st, { cell, goal: (x, z, y) => outside(x, z, y) && [[0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5]].every(([a, b]) => { const q = m.roomAt(x + a, z + b, y); return !q || q.open; }) && decks.some((r) => inRoom({ ...r, x0: r.x0 + 0.15, x1: r.x1 - 0.15, z0: r.z0 + 0.15, z1: r.z1 - 0.15 }, x, z, y)) });
    assert.ok(r2.path, `${cls}: no path engine room → open deck`);
    const w2 = followPath(m, w1.st, thin(r2.path));
    assert.ok(w2.ok, `${cls}: walker stuck going on deck at ${JSON.stringify(w2.st)}`);
    const room = m.roomAt(w2.st.x, w2.st.z, w2.st.y);
    assert.ok(room && room.open && room.kind === 'deck', `${cls}: ended in ${room?.id}`);
    // and back up to the helm
    const r3 = flood(m, w2.st, { cell, goal: (x, z, y) => Math.hypot(x - helm.x, z - helm.z) < 0.5 && Math.abs(y - helm.y) < 0.3 });
    assert.ok(r3.path, `${cls}: no path open deck → helm`);
    const w3 = followPath(m, w2.st, thin(r3.path));
    assert.ok(w3.ok, `${cls}: walker stuck going back to the helm at ${JSON.stringify(w3.st)} (waypoint ${w3.k})`);
  }
});

// ================================================================== forgiving controls
test('interior: walls slide, doorways funnel, furniture blocks', () => {
  const p = plans.get('coaster'), m = map('coaster');
  const cp = p.rooms.find((r) => r.id === 'passage-1');
  // diagonal into the aft wall of the A-deck passage, beside the stairway opening: keeps moving sideways
  const st = { x: cp.x1 - 1.0, z: cp.z1 - 0.4, y: cp.y };
  const x0 = st.x;
  for (let i = 0; i < 10; i++) m.move(st, -0.04, 0.04);
  assert.ok(st.x < x0 - 0.2 && st.z <= cp.z1 - R + 1e-6, `slides along the wall (x ${x0.toFixed(2)} → ${st.x.toFixed(2)}, z ${st.z.toFixed(2)})`);
  // pushing straight at the wall half a metre beside a doorway slides into it and through
  const d = p.doors.find((q) => q.a === 'galley' && q.side === 's') || p.doors.find((q) => q.b === 'passage' && q.side === 's');
  const a = p.rooms.find((q) => q.id === d.a);
  const s2 = { x: d.at + d.w / 2 + 0.25, z: a.z1 + 0.4, y: a.y };
  assert.ok(m.standAt(s2.x, s2.z, s2.y) != null);
  for (let i = 0; i < 90; i++) m.move(s2, 0, -1.7 / 30);
  assert.ok(s2.z < a.z1 - 0.5, `funnelled through the doorway (z ${s2.z.toFixed(2)} vs wall ${a.z1})`);
  // the helm console is solid
  const c = p.solids.find((q) => q.tag === 'console');
  assert.equal(m.standAt((c.x0 + c.x1) / 2, (c.z0 + c.z1) / 2, c.y), null);
  // camera: a third-person camera behind the walker is pulled in front of the wall
  const br = p.rooms.find((q) => q.id === 'bridge');
  const head = { x: br.x1 - 1.0, y: br.y + 1.55, z: br.z1 - 0.6 };
  const cam = m.cameraClamp(head, { x: br.x1 - 1.0, y: br.y + 1.9, z: br.z1 + 2 }, br.y);
  assert.ok(cam.z < br.z1, `camera stays inside the bridge (${cam.z.toFixed(2)} vs ${br.z1})`);
  // a camera behind a walker standing at the foot of a stair is kept out of the treads
  for (const cls of CLASSES) {
    const pl = plans.get(cls), mm = map(cls);
    for (const s of pl.stairs) {
      const { footZ, headZ, upDir, cx } = stairEnds(s);
      const hd = { x: cx, y: s.yLow + 1.55, z: footZ - upDir * 0.4 };
      const want = { x: cx, y: s.yLow + 1.9, z: footZ + upDir * 2.2 }; // behind = over the stair
      const c2 = mm.cameraClamp(hd, want, s.yLow);
      const inTreads = c2.x >= s.x0 && c2.x <= s.x1 && c2.z > Math.min(s.z0, s.z1) && c2.z < Math.max(s.z0, s.z1) && c2.y < rampY(s, c2.z) + 0.3 && c2.y > s.yLow - 0.3;
      assert.ok(!inTreads, `${cls}: ${s.id}: camera inside the stair at ${JSON.stringify(c2)}`);
    }
  }
});

test('interior: engine rooms are dark spaces below the main deck with the engine, generators and live console', () => {
  for (const cls of CLASSES) {
    const p = plans.get(cls);
    const eng = p.rooms.find((r) => r.kind === 'engine');
    assert.ok(eng.dark, `${cls}: engine room has windows`);
    assert.ok(eng.y < p.deckY - 1.5, `${cls}: engine room floor ${eng.y} is not below the deck ${p.deckY}`);
    // sailing yachts (docs/SAILING-CONTRACT.md §4.5): real freeboard → soles below the waterline; interior.js hides the sea there
    if (!['sloop', 'ketch', 'schooner', 'catamaran'].includes(cls)) assert.ok(eng.y >= 0.7, `${cls}: engine room floor ${eng.y} is under the waterline (the sea would show inside)`);
    else assert.ok(eng.y < 0.1 && eng.y > -1.0, `${cls}: yacht engine room floor ${eng.y} (below the waterline, above the keel)`);
    const con = p.props.find((q) => q.t === 'console');
    assert.ok(con && con.x >= eng.x0 - 0.01 && con.x <= eng.x1 + 0.01 && con.z >= eng.z0 - 0.01 && con.z <= eng.z1 + 0.01, `${cls}: console outside the engine room`);
  }
});

// ================================================================== third-person camera near machinery
test('interior: the third-person camera never hovers just behind a console panel or machinery (or it switches to the eyes view)', () => {
  // regression: on the trawler the camera behind a walker at the engine console sat 10 cm behind the gauge panel (the
  // console footprint was lower than the panel), so the screen showed nothing but the back of the panel
  const SQUEEZE = 0.95; // interior.js: closer than this to the head → the view switches to the crew member's eyes
  const boxDist = (p, s) => Math.hypot(Math.max(s.x0 - p.x, 0, p.x - s.x1), Math.max(s.y - p.y, 0, p.y - (s.y + s.h)), Math.max(s.z0 - p.z, 0, p.z - s.z1));
  for (const cls of CLASSES) {
    const p = plans.get(cls), m = map(cls);
    // a free-standing engine console's footprint reaches the top of the gauge panel interior.js draws on it (1.73 m)
    const con = p.props.find((q) => q.t === 'console');
    if (!con.wall) assert.ok(p.solids.some((s) => s.tag === 'console' && s.h >= 1.73 && con.x >= s.x0 && con.x <= s.x1 && con.z >= s.z0 && con.z <= s.z1), `${cls}: console footprint lower than its panel`);
    for (const h of p.hotspots) {
      const y = m.standAt(h.x, h.z, h.y, 0.5); if (y == null) continue;
      const room = m.roomAt(h.x, h.z, y);
      const small = room && !room.open && Math.min(room.x1 - room.x0, room.z1 - room.z0) < 3.2;
      const head = { x: h.x, y: y + 1.55, z: h.z };
      for (let k = 0; k < 8; k++) {
        const yaw = (k * Math.PI) / 4, pitch = -0.1, dist = small ? 1.7 : 2.6;
        const dir = { x: Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) };
        const want = { x: head.x - dir.x * dist, y: head.y - dir.y * dist + (small ? 0.2 : 0.35), z: head.z - dir.z * dist };
        const c = m.cameraClamp(head, want, y);
        if (Math.hypot(c.x - head.x, c.y - head.y, c.z - head.z) < SQUEEZE) continue;
        for (const s of p.solids) {
          if (s.h < 1.2) continue;
          assert.ok(boxDist(c, s) >= 0.2, `${cls}: camera behind the walker at ${h.kind} (yaw ${k * 45}°) is ${boxDist(c, s).toFixed(2)} m from the ${s.tag} at ${JSON.stringify(c)}`);
        }
      }
    }
  }
});
