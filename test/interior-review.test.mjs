// Review of the walkable ship (V5 items 6 + 7): the player who said "walking on the stairs walks straight into the wall"
// rarely lines up with a stair exactly. These tests walk at every stair of every class the way a player does — aiming
// at the top (or bottom) step from off to the side, at an angle — and check that passers-by are not pulled onto stairs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan } from '../public/js/shipplan.js';
import { WalkMap, stairEnds } from '../public/js/walker.js';
import { SHIP_CLASSES } from '../shared/constants.js';

const CLASSES = Object.keys(SHIP_CLASSES);
const built = new Map();
const get = (cls) => { if (!built.has(cls)) { const p = buildPlan(cls, SHIP_CLASSES[cls]); built.set(cls, { p, m: new WalkMap(p) }); } return built.get(cls); };

/** Hold "forward" toward (tx, tz) at walking pace, re-aiming every frame (mouse look); true once within 0.2 m. */
function aimWalk(m, st, tx, tz, { secs = 20, dt = 1 / 30, yWant = null } = {}) {
  let stuck = 0;
  for (let t = 0; t < secs; t += dt) {
    const dx = tx - st.x, dz = tz - st.z, d = Math.hypot(dx, dz);
    if (d < 0.2 && (yWant == null || Math.abs(st.y - yWant) < 0.3)) return true;
    const step = 1.7 * m.speedFactor(st.x, st.z, st.y) * dt;
    const r = m.move(st, (dx / d) * step, (dz / d) * step);
    stuck = r.moved < 1e-4 ? stuck + 1 : 0;
    if (stuck > 20) return false;
  }
  return false;
}

test('interior review: every stair can be taken from an angle — aim at the top / bottom step from off to the side', () => {
  const fails = [];
  let tried = 0;
  for (const cls of CLASSES) {
    const { p, m } = get(cls);
    for (const s of p.stairs) {
      const { footZ, headZ, upDir, cx } = stairEnds(s);
      for (const [back, lat] of [[0.7, 0.7], [0.7, -0.7], [1, 1], [1, -1], [1, 1.5], [1, -1.5], [1.5, 1.5], [1.5, -1.5], [1.2, 0.8], [2, -0.8]]) {
        // up: from the foot room, aim at the first steps, then on up to the head landing
        let x = cx + lat, z = footZ - upDir * back, y = m.standAt(x, z, s.yLow, 0.05);
        if (y != null && m.roomAt(x, z, y)?.id === s.foot) {
          tried++;
          const st = { x, z, y };
          const ok = aimWalk(m, st, cx, footZ + upDir * 0.5) && aimWalk(m, st, cx, headZ + upDir * 0.6, { yWant: s.yHigh });
          if (!ok) fails.push(`${cls} ${s.id} up from (${lat}, ${back}) stuck at ${st.x.toFixed(2)},${st.z.toFixed(2)} y${st.y.toFixed(2)}`);
        }
        // down: from the head room, aim at the top steps, then down to the foot landing
        x = cx + lat; z = headZ + upDir * back; y = m.standAt(x, z, s.yHigh, 0.05);
        if (y != null && m.roomAt(x, z, y)?.id === s.head) {
          tried++;
          const st = { x, z, y };
          const ok = aimWalk(m, st, cx, headZ - upDir * 0.5) && aimWalk(m, st, cx, footZ - upDir * 0.6, { yWant: s.yLow });
          if (!ok) fails.push(`${cls} ${s.id} down from (${lat}, ${back}) stuck at ${st.x.toFixed(2)},${st.z.toFixed(2)} y${st.y.toFixed(2)}`);
        }
      }
    }
  }
  assert.ok(tried > 150, `only ${tried} angled approaches could be set up`);
  assert.deepEqual(fails, []);
});

test('interior review: the pilot boat companionway in the wheelhouse can be taken from the helm side at 45°', () => {
  // the case that failed: the walker slid along the stairwell guard past the opening and stopped at the console
  const { p, m } = get('pilot');
  const s = p.stairs.find((q) => q.id === 'companionway');
  const { footZ, headZ, upDir, cx } = stairEnds(s);
  const st = { x: cx + 1.5, z: headZ + upDir * 1, y: s.yHigh };
  st.y = m.standAt(st.x, st.z, s.yHigh, 0.05);
  assert.ok(st.y != null);
  assert.ok(aimWalk(m, st, cx, headZ - upDir * 0.5), `stuck at ${st.x.toFixed(2)},${st.z.toFixed(2)}`);
  assert.ok(aimWalk(m, st, cx, footZ - upDir * 0.6, { yWant: s.yLow }), `did not get down: ${st.x.toFixed(2)},${st.z.toFixed(2)} y${st.y}`);
});

test('interior review: walking past a stair foot beside the stairwell is not pulled onto the stair', () => {
  // every stair: stand on its foot level just beyond the foot and 0.75–0.9 m to the side, walk straight past it
  // (parallel to the stair); where that line is walkable the walker must keep its level and make headway
  const fails = [];
  let tried = 0;
  for (const cls of CLASSES) {
    const { p, m } = get(cls);
    for (const s of p.stairs) {
      const { footZ, upDir, cx } = stairEnds(s), w = s.x1 - s.x0;
      for (const sg of [1, -1]) {
        const x = cx + sg * (w / 2 + 0.33), z0 = footZ - upDir * 0.3;
        const y = m.standAt(x, z0, s.yLow, 0.02);
        if (y == null || m.standAt(x, footZ + upDir * 1.2, s.yLow, 0.02) == null) continue;
        tried++;
        const st = { x, z: z0, y };
        for (let i = 0; i < 40; i++) m.move(st, 0, upDir * 0.05);
        if (Math.abs(st.y - s.yLow) > 0.05 || (st.z - z0) * upDir < 1.2) fails.push(`${cls} ${s.id} side ${sg}: ended at ${st.x.toFixed(2)},${st.z.toFixed(2)} y${st.y.toFixed(2)}`);
      }
    }
  }
  assert.ok(tried > 5, `only ${tried} pass-by walks could be set up`);
  assert.deepEqual(fails, []);
});

test('interior review: the superyacht stairwell corner — heading forward along the stairwell keeps you on your deck', () => {
  // regression for an over-eager stair funnel: from the aft corner of the stairwell on the 6.4 m deck, walking forward
  // must follow the passage beside the stairwell, not get dragged sideways onto the flight going up
  const { m } = get('superyacht');
  const st = { x: -2.056, z: 19.65, y: 6.4 };
  st.y = m.standAt(st.x, st.z, 6.4, 0.05);
  assert.ok(st.y != null);
  for (let i = 0; i < 60; i++) m.move(st, 0, -0.05);
  assert.ok(Math.abs(st.y - 6.4) < 0.05, `left the deck: y ${st.y}`);
  assert.ok(st.z < 17.5, `no headway: z ${st.z.toFixed(2)}`);
});

test('interior review: random wandering never leaves the floor or jumps a level', () => {
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const cls of CLASSES) {
    const { p, m } = get(cls);
    const st = { ...p.spawn }; st.y = m.standAt(st.x, st.z, st.y, 0.5);
    assert.ok(st.y != null, `${cls}: spawn not standable`);
    let a = 0;
    for (let i = 0; i < 8000; i++) {
      if (i % 60 === 0) a = rnd() * Math.PI * 2;
      const y0 = st.y;
      m.move(st, Math.cos(a) * 0.057, Math.sin(a) * 0.057);
      assert.ok(Math.abs(st.y - y0) < 0.33, `${cls}: height jump ${y0} → ${st.y}`);
      assert.ok(m.floorAt(st.x, st.z, st.y, 0.01) != null, `${cls}: off the floor at ${st.x.toFixed(2)},${st.z.toFixed(2)} y${st.y}`);
    }
  }
});
