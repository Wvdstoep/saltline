// Lane C walk suite (docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §6): every catalogue ship's general-arrangement plan
// (planFromGA) is walked with the game's own WalkMap — rooms inside the hull, doors that open onto standable floor
// on both sides, every stair walked up and down without a hit, every room / hotspot reachable from the spawn
// (ladders included), Go-to targets standable, and a game-movement walk bridge → engine room → open deck → helm on
// representative ships. The sail classes are owned by the sailing code and are not planned here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planFromGA } from '../public/js/gaplan.js';
import { generalArrangement, hullHalf } from '../shared/ships/ga.js';
import { WalkMap, rampY, stairEnds } from '../public/js/walker.js';
import { MODELS } from '../shared/ships/catalogue.js';

const IDS = Object.keys(MODELS).filter((k) => MODELS[k].gen !== 'sail');

function flood(map, plan, start, cell) {
  const yk = (y) => Math.round(y * 40);
  const seen = new Map(); const q = [];
  const push = (i, j, y, from, lad = false) => { const k = `${i},${j},${yk(y)}`; if (seen.has(k)) return; seen.set(k, from); q.push([i, j, y, from, lad]); };
  const y0 = map.standAt(start.x, start.z, start.y, 0.5);
  if (y0 == null) return null;
  let i0 = Math.round(start.x / cell), j0 = Math.round(start.z / cell);
  if (map.standAt(i0 * cell, j0 * cell, y0, 0.3) == null) { outer: for (let d = 1; d < 5; d++) for (let a = -d; a <= d; a++) for (let b = -d; b <= d; b++) if (map.standAt((i0 + a) * cell, (j0 + b) * cell, y0, 0.3) != null) { i0 += a; j0 += b; break outer; } }
  push(i0, j0, y0, null);
  const ladders = (plan.hotspots || []).filter((h) => h.kind === 'ladder' && h.to);
  for (let h = 0; h < q.length; h++) {
    const [i, j, y] = q[h];
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const ny = map.standAt((i + di) * cell, (j + dj) * cell, y, 0.3); if (ny != null) push(i + di, j + dj, ny, h); }
    for (const l of ladders) if (Math.abs(l.y - y) < 0.3 && Math.hypot(l.x - i * cell, l.z - j * cell) < l.r - 0.2) {
      const t = l.to, ty = map.standAt(t.x, t.z, t.y, 0.5); if (ty == null) continue;
      let ti = Math.round(t.x / cell), tj = Math.round(t.z / cell);
      if (map.standAt(ti * cell, tj * cell, ty, 0.3) == null) { let ok = false; for (let d = 1; d < 5 && !ok; d++) for (let a = -d; a <= d && !ok; a++) for (let b = -d; b <= d && !ok; b++) if (map.standAt((ti + a) * cell, (tj + b) * cell, ty, 0.3) != null) { ti += a; tj += b; ok = true; } }
      push(ti, tj, ty, h, true);
    }
  }
  return { q, cell };
}

function check(id, opts = {}) {
  const fails = [];
  const t0 = performance.now();
  let plan;
  try { plan = planFromGA(id, opts); } catch (e) { return { id, fails: [`BUILD: ${e.stack.split('\n').slice(0, 4).join(' | ')}`] }; }
  const ms = performance.now() - t0;
  const ga = generalArrangement(id);
  const verbose = false;
  let map;
  try { map = new WalkMap(plan); } catch (e) { return { id, fails: [`MAP: ${e.message}`] }; }
  const byId = new Map(plan.rooms.map((r) => [r.id, r]));
  // rooms inside the hull
  for (const r of plan.rooms) {
    if (r.open || r.y > plan.deckY - 0.05) continue;
    const top = Math.min(r.y + r.h, plan.deckY);
    for (const z of [r.z0 + 0.01, r.z1 - 0.01, (r.z0 + r.z1) / 2]) for (const y of [r.y, (r.y + top) / 2, top]) {
      const hb = hullHalf(ga, z, y);
      if (Math.max(Math.abs(r.x0), Math.abs(r.x1)) > hb + 0.01) { fails.push(`hull: ${r.id} |x| ${Math.max(Math.abs(r.x0), Math.abs(r.x1)).toFixed(2)} > ${hb.toFixed(2)} at z ${z.toFixed(1)} y ${y.toFixed(1)}`); break; }
    }
  }
  // doors
  for (const d of plan.doors) {
    const a = byId.get(d.a), b = d.b ? byId.get(d.b) : null;
    if (!a) { fails.push(`door from missing ${d.a}`); continue; }
    if (d.b && !b) fails.push(`door to missing ${d.b}`);
    if (d.w < 0.72) fails.push(`door ${d.a}/${d.side} narrow ${d.w}`);
    const along = d.side === 'n' || d.side === 's' ? [a.x0, a.x1] : [a.z0, a.z1];
    if (!(d.at - d.w / 2 >= along[0] - 0.01 && d.at + d.w / 2 <= along[1] + 0.01)) fails.push(`door ${d.a}/${d.side} at ${d.at} w ${d.w} past wall [${along}]`);
    if (b) {
      if (Math.abs(a.y - b.y) > 0.06) fails.push(`door ${d.a}->${d.b} floors ${a.y}/${b.y}`);
      if (!b.open && !(b.cuts || []).length) {
        const c = { n: a.z0, s: a.z1, w: a.x0, e: a.x1 }[d.side], cb = { n: b.z1, s: b.z0, w: b.x1, e: b.x0 }[d.side];
        if (Math.abs(c - cb) > 0.06) fails.push(`door ${d.a}->${d.b}: no shared wall (${c} vs ${cb})`);
        const alongB = d.side === 'n' || d.side === 's' ? [b.x0, b.x1] : [b.z0, b.z1];
        if (!(d.at - d.w / 2 >= alongB[0] - 0.01 && d.at + d.w / 2 <= alongB[1] + 0.01)) fails.push(`door ${d.a}->${d.b} past ${d.b}'s wall`);
      }
    }
    const n = d.side === 'n' || d.side === 's', c = { n: a.z0, s: a.z1, w: a.x0, e: a.x1 }[d.side];
    for (const off of [-0.4, 0.4]) { const x = n ? d.at : c + off, z = n ? c + off : d.at; if (map.standAt(x, z, d.y) == null) fails.push(`door ${d.a}/${d.side}→${d.b} blocked ${off < 0 ? 'outside' : 'inside'} at ${x.toFixed(2)},${z.toFixed(2)} y${d.y}`); }
  }
  // stairs
  for (const s of plan.stairs) {
    const foot = byId.get(s.foot), head = byId.get(s.head);
    if (!foot || !head) { fails.push(`stair ${s.id} foot/head missing (${s.foot}/${s.head})`); continue; }
    if (Math.abs(foot.y - s.yLow) > 0.02 || Math.abs(head.y - s.yHigh) > 0.02) fails.push(`stair ${s.id} levels ${s.yLow}/${s.yHigh} vs ${foot.y}/${head.y}`);
    const ang = Math.atan2(s.yHigh - s.yLow, s.z1 - s.z0) * 180 / Math.PI;
    if (!(ang > (s.kind === 'ramp' ? 3 : 20) && ang < 62)) fails.push(`stair ${s.id} ${ang.toFixed(0)}°`);
    const { footZ, headZ, upDir, cx } = stairEnds(s);
    for (let t = 0.05; t <= 0.95; t += 0.1) {
      const z = footZ + (headZ - footZ) * t, y = rampY(s, z);
      for (const r of plan.rooms) {
        if (r.open || r.id === s.head || cx < r.x0 || cx > r.x1 || z < r.z0 || z > r.z1) continue;
        const holes = r.floorHoles.some((h) => cx >= h.x0 && cx <= h.x1 && z >= h.z0 && z <= h.z1);
        if (r.y > y + 0.1 && r.y < y + 1.95 && !holes) { fails.push(`stair ${s.id} headroom under ${r.id}`); break; }
      }
    }
    if (map.standAt(cx, footZ - upDir * 0.45, s.yLow) == null) fails.push(`stair ${s.id} foot landing blocked`);
    if (map.standAt(cx, headZ + upDir * 0.45, s.yHigh) == null) fails.push(`stair ${s.id} head landing blocked`);
    // walk up and down
    for (const dir of ['up', 'down']) {
      const fromZ = dir === 'up' ? footZ - upDir * 0.5 : headZ + upDir * 0.5, toZ = dir === 'up' ? headZ + upDir * 0.55 : footZ - upDir * 0.55;
      const y0 = dir === 'up' ? s.yLow : s.yHigh, y1 = dir === 'up' ? s.yHigh : s.yLow;
      const st = { x: cx, z: fromZ, y: y0 };
      if (map.standAt(st.x, st.z, y0) == null) continue;
      let hits = 0;
      for (let t = 0; t < 30 && (toZ - st.z) * Math.sign(toZ - fromZ) > 0; t += 1 / 30) { const r = map.move(st, 0, Math.sign(toZ - fromZ) * 1.7 * map.speedFactor(st.x, st.z, st.y) / 30); if (r.hit) hits++; if (r.moved < 1e-4 && hits > 3) break; }
      if (hits || Math.abs(st.y - y1) > 0.02) fails.push(`stair ${s.id} walk ${dir}: hits ${hits} y ${st.y.toFixed(2)} want ${y1}`);
    }
  }
  // reachability incl. ladders
  const cell = plan.L > 150 ? 0.2 : plan.L > 60 ? 0.15 : 0.1;
  const fl = flood(map, plan, plan.spawn, cell);
  if (!fl) fails.push('spawn not standable');
  else {
    const pts = fl.q;
    for (const r of plan.rooms) {
      if (r.walk === false) continue;
      let ok = false;
      for (const [i, j, y] of pts) { const x = i * cell, z = j * cell; if (x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1 && Math.abs(y - r.y) < 0.06) { ok = true; break; } }
      if (!ok) fails.push(`unreachable room ${r.id} (${r.name}) y ${r.y}`);
    }
    for (const h of plan.hotspots) {
      let ok = false;
      for (const [i, j, y] of pts) if (Math.hypot(i * cell - h.x, j * cell - h.z) < h.r - 0.25 && Math.abs(y - h.y) < 0.5) { ok = true; break; }
      if (!ok) fails.push(`unreachable hotspot ${h.kind} "${h.label}" ${h.x},${h.y},${h.z}`);
    }
    for (const g of plan.goto) if (!g.deck && map.standAt(g.x, g.z, g.y, 0.05) == null) fails.push(`goto ${g.id} not standable`);
    if (verbose) console.log(id, 'flood nodes', pts.length);
  }
  return { id, fails, ms, rooms: plan.rooms.length, plan };
}

// ------------------------------------------------------------------------------------------------ the suite
const PLANS = new Map();
for (const id of IDS) {
  test(`walk: ${id} — hull, doors, stairs walked, every room and hotspot reachable, go-to standable`, () => {
    const r = check(id);
    PLANS.set(id, r.plan);
    assert.deepEqual(r.fails, [], `${id}:\n  ${r.fails.slice(0, 20).join('\n  ')}`);
    assert.ok(r.rooms <= 400, `${id}: ${r.rooms} rooms (≤ 400)`);
    const p = r.plan;
    assert.ok(p.goto.length >= (p.L > 60 ? 4 : 1), `${id}: go-to list ${p.goto.length}`);
    if (p.deckGroup) return;   // one deck of a cruise ship / big ro-pax: the per-deck test below checks the whole ship
    const kinds = new Set(p.hotspots.map((h) => h.kind));
    assert.ok(kinds.has('helm'), `${id}: no helm hotspot`);
    assert.ok(kinds.has('engine') || kinds.has('ecr'), `${id}: no engine hotspot`);
    if (p.L > 60) for (const k of ['telegraph', 'radio']) assert.ok(kinds.has(k) || kinds.has(k === 'radio' ? 'gmdss' : k), `${id}: no ${k} hotspot`);
  });
}

// passenger ships loaded one deck at a time: every deck's plan walks too, and its tower landings lead to the neighbours
test('walk: cruise ships and big ro-pax — every deck plan is walkable and ≤ 400 rooms', () => {
  let n = 0;
  for (const id of IDS) {
    const base = planFromGA(id);
    if (!base.deckGroup) continue;
    const ga = generalArrangement(id);
    const kinds = new Set();
    for (const d of ga.pax.decks) {
      const r = check(id, { deck: d.id });
      n++;
      for (const h of r.plan.hotspots) kinds.add(h.kind);
      assert.deepEqual(r.fails, [], `${id} deck ${d.id}:\n  ${r.fails.slice(0, 12).join('\n  ')}`);
      assert.equal(r.plan.deckGroup, d.id);
      assert.ok(r.rooms <= 400, `${id}/${d.id}: ${r.rooms} rooms`);
      const landings = r.plan.rooms.filter((q) => q.deck && q.deck !== d.id && q.kind === 'stairs');
      if (ga.pax.decks.length > 1) assert.ok(landings.length > 0, `${id}/${d.id}: no landing on a neighbour deck`);
      // Go-to points on other decks name that deck, and that deck's plan has them standing on its floor
      for (const g of r.plan.goto) if (g.deck) {
        assert.notEqual(g.deck, d.id, `${id}/${d.id}: go-to ${g.id} points at its own deck`);
        const there = planFromGA(id, { deck: g.deck }).goto.find((q) => q.id === g.id);
        assert.ok(there && !there.deck, `${id}/${d.id}: go-to ${g.id} → ${g.deck} does not resolve there`);
      }
    }
    for (const k of ['helm', 'engine', 'telegraph', 'goto']) assert.ok(kinds.has(k), `${id}: no ${k} hotspot on any deck`);
    assert.ok(kinds.has('radio') || kinds.has('gmdss'), `${id}: no radio`);
  }
  assert.ok(n >= 10, `only ${n} per-deck plans`);
});

// ------------------------------------------------------------------------------------------------ game movement
/** Walk the walker from where it stands to the first flood cell that satisfies `want`, frame by frame (1.7 m/s, 30 fps). */
function walkTo(map, plan, st, want, label) {
  const cell = plan.L > 150 ? 0.2 : plan.L > 60 ? 0.15 : 0.1;
  const fl = flood(map, plan, st, cell);
  assert.ok(fl, `${label}: start not standable`);
  const q = fl.q;
  const hit = q.findIndex(([i, j, y]) => want(i * cell, j * cell, y));
  assert.ok(hit >= 0, `${label}: target not reachable`);
  const path = []; for (let k = hit; k != null; k = q[k][3]) path.push(q[k]);
  path.reverse();
  let frames = 0, ladders = 0;
  for (let k = 1; k < path.length; k++) {
    const [i, j, y, , lad] = path[k], tx = i * cell, tz = j * cell;
    if (lad) { st.x = tx; st.z = tz; st.y = y; ladders++; continue; }
    for (let f = 0; f < 20; f++) {
      const dx = tx - st.x, dz = tz - st.z, d = Math.hypot(dx, dz);
      if (d < 0.02) break;
      const v = Math.min(d, (1.7 * map.speedFactor(st.x, st.z, st.y)) / 30);
      map.move(st, (dx / d) * v, (dz / d) * v); frames++;
    }
    assert.ok(Math.hypot(tx - st.x, tz - st.z) < 0.12 && Math.abs(st.y - y) < 0.35, `${label}: stuck near ${st.x.toFixed(2)},${st.y.toFixed(2)},${st.z.toFixed(2)} heading for ${tx.toFixed(2)},${y.toFixed(2)},${tz.toFixed(2)}`);
    assert.ok(!map.blocked(st.x, st.z, st.y), `${label}: inside furniture at ${st.x.toFixed(2)},${st.z.toFixed(2)}`);
  }
  return { frames, ladders, steps: path.length };
}

const REPS = ['kamsarmax82', 'mr50', 'lng174k', 'ulcv24k', 'pctc7000', 'ropax200', 'cruise362', 'ahts85', 'tug24', 'trawler', 'pilot', 'giga100', 'icebreaker120'].filter((id) => MODELS[id]);
test('walk: game movement — bridge → engine room → open deck → helm on a representative of every generator', () => {
  assert.ok(REPS.length >= 10, `representatives: ${REPS}`);
  for (const id of REPS) {
    if (planFromGA(id).deckGroup) { paxWalk(id); continue; }
    const plan = PLANS.get(id) || planFromGA(id);
    const map = new WalkMap(plan);
    const st = { x: plan.spawn.x, y: map.standAt(plan.spawn.x, plan.spawn.z, plan.spawn.y, 0.5), z: plan.spawn.z };
    const inZone = (zone, extra = () => true) => (x, z, y) => { const r = map.roomAt(x, z, y); return r && r.zone === zone && extra(r); };
    const near = (h) => (x, z, y) => Math.hypot(x - h.x, z - h.z) < h.r - 0.3 && Math.abs(y - h.y) < 0.4;
    const bridgeHot = plan.hotspots.find((h) => h.kind === 'helm');
    const engHot = plan.hotspots.find((h) => h.kind === 'engine') || plan.hotspots.find((h) => h.kind === 'ecr');
    walkTo(map, plan, st, near(engHot), `${id} spawn→engine`);
    walkTo(map, plan, st, inZone('deck', (r) => r.open), `${id} engine→open deck`);
    const last = walkTo(map, plan, st, near(bridgeHot), `${id} deck→helm`);
    assert.ok(last.steps > 3, `${id}: suspiciously short walk`);
  }
});

/** Cruise ship / big ro-pax: on the deck over the engine room walk from the lift to the engines, on the bridge deck from the spawn out on deck and to the helm. */
function paxWalk(id) {
  const ga = generalArrangement(id);
  const near = (h) => (x, z, y) => Math.hypot(x - h.x, z - h.z) < h.r - 0.3 && Math.abs(y - h.y) < 0.4;
  let er = null;
  for (const d of ga.pax.decks) { const p = planFromGA(id, { deck: d.id }); if (p.hotspots.some((h) => h.kind === 'engine')) { er = p; break; } }
  assert.ok(er, `${id}: no deck plan with the engine room`);
  const lift = er.hotspots.find((h) => h.kind === 'goto' && h.decks && h.zone?.startsWith(`deck:${er.deckGroup}`)) || er.hotspots.find((h) => h.kind === 'goto');
  let map = new WalkMap(er);
  let st = { x: lift.x, y: map.standAt(lift.x, lift.z, lift.y, 0.5), z: lift.z };
  walkTo(map, er, st, near(er.hotspots.find((h) => h.kind === 'engine')), `${id} lift→engine`);
  // out on deck: the first deck (from the top) with open deck in its own section, walked from its spawn (a tower lobby)
  let walked = false;
  for (const d of [...ga.pax.decks].reverse()) {
    const p = planFromGA(id, { deck: d.id }); if (!p.rooms.some((r) => r.open && r.zone?.startsWith(`deck:${d.id}`))) continue;
    map = new WalkMap(p); st = { x: p.spawn.x, y: map.standAt(p.spawn.x, p.spawn.z, p.spawn.y, 0.5), z: p.spawn.z };
    walkTo(map, p, st, (x, z, y) => { const r = map.roomAt(x, z, y); return r && r.open && Math.abs(y - d.y) < 0.1; }, `${id} lobby→open deck ${d.id}`);
    walked = true; break;
  }
  assert.ok(walked, `${id}: no open deck`);
  const top = planFromGA(id);
  map = new WalkMap(top);
  st = { x: top.spawn.x, y: map.standAt(top.spawn.x, top.spawn.z, top.spawn.y, 0.5), z: top.spawn.z };
  const lift2 = top.hotspots.find((h) => h.kind === 'goto' && h.decks && h.zone?.startsWith(`deck:${top.deckGroup}`));
  if (lift2) walkTo(map, top, st, near(lift2), `${id} bridge→lift`);
  walkTo(map, top, st, near(top.hotspots.find((h) => h.kind === 'helm')), `${id} lift→helm`);
}
