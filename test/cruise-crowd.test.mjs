// Cruise ships — the living crowd in walk mode (docs/CRUISE-CONTRACT.md §6). Pure placement / density / budget logic first
// (iv2crowdplan.js: no three.js), then the renderer in node (iv2crowd.js) on real v2 plans: caps, determinism, draw calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

const ROOT = new URL('../', import.meta.url).href;
register('data:text/javascript,' + encodeURIComponent(`const ROOT=${JSON.stringify(ROOT)};export async function resolve(s,c,n){if(s.startsWith('/shared/'))return n(ROOT+s.slice(1),c);if(s.startsWith('/js/'))return n(ROOT+'public'+s,c);return n(s,c);}`));
const ctx2d = new Proxy({}, { get: (t, k) => (k in t ? t[k] : k === 'measureText' ? () => ({ width: 10 }) : k === 'createLinearGradient' || k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : k === 'getImageData' ? (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
if (!('document' in globalThis)) globalThis.document = { getElementById: () => null, createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => ctx2d }) };

const P = await import('../public/js/iv2crowdplan.js');
const { planFromGA } = await import('../public/js/gaplan.js');
const { cruiseProfile } = await import('../shared/ships/cruiseprofile.js');

const plan = planFromGA('cruise362', { deck: 'd4' });
const props = (room) => plan.props.filter((q) => q.t === 'k2' && q.room === room.id);
const roomOf = (space) => plan.rooms.filter((r) => r.space === space).sort((a, b) => (b.x1 - b.x0) * (b.z1 - b.z0) - (a.x1 - a.x0) * (a.z1 - a.z0))[0];
const people = (room, over = {}) => P.crowdForRoom(room, { seed: 7, hour: 13, guests: 3000, crew: 1200, props: props(room), ...over });

test('density: grows with the ship, from a boutique ship to a giga ship', () => {
  assert.ok(P.shipDensity(150) < P.shipDensity(1250) && P.shipDensity(1250) < P.shipDensity(3000) && P.shipDensity(3000) < P.shipDensity(7000));
  assert.equal(P.shipDensity(7000), 1); assert.equal(P.shipDensity(20000), 1);
  assert.ok(P.shipDensity(150) >= 0.08 && P.shipDensity(150) < 0.25, String(P.shipDensity(150)));
  assert.ok(P.crewDensity(100) < P.crewDensity(2300));
  const g = (id) => cruiseProfile(id).guests;
  assert.ok(P.shipDensity(g('boutique125')) < P.shipDensity(g('cruise362')));
});

test('occupancy: meals, shows, pools and clubs peak at their hours', () => {
  assert.ok(P.occupancy('dining', 19.2) > 0.6 && P.occupancy('dining', 4) < 0.15);
  assert.ok(P.occupancy('dining', 12.8) > P.occupancy('dining', 16));
  assert.ok(P.occupancy('theatre', 18.7) > 0.8 && P.occupancy('theatre', 11) < 0.05);
  assert.ok(P.occupancy('pool', 13) > 0.9 && P.occupancy('pool', 2) < 0.05);
  assert.ok(P.occupancy('club', 0.5) > 0.7 && P.occupancy('club', 9) < 0.1);
  assert.ok(P.occupancy('casino', 22) > P.occupancy('casino', 9));
  assert.equal(P.occupancy('bridge', 3), 1);
  assert.ok(P.showOn(18.7) && P.showOn(21.7) && !P.showOn(12));
  for (let h = 0; h < 24; h += 0.5) for (const k of ['dining', 'bar', 'pool', 'street', 'galley']) { const o = P.occupancy(k, h); assert.ok(o >= 0 && o <= 1); }
});

test('local hour: the ship clock and longitude', () => {
  assert.equal(P.localHour(0, 0), 0); assert.equal(P.localHour(3600 * 5, 0), 5);
  assert.equal(P.localHour(0, 15), 1); assert.ok(P.localHour(-3600, 0) === 23);
});

test('places: a theatre row seats, a dining set seats four, a bar island has barmen and stools', () => {
  const row = P.spotsOfProp({ item: 'theatre_row', x: 0, z: 0, y: 0, rotY: Math.PI, w: 6.6 });
  assert.equal(row.length, 12); assert.ok(row.every((s) => s.k === 'sit'));
  assert.ok(Math.abs(Math.cos(row[0].yaw) + 1) < 1e-3, 'rows turned to the stage face the stage');
  const set = P.spotsOfProp({ item: 'dining_set4', x: 5, z: 5, y: 2, rotY: 0 }); assert.equal(set.length, 4);
  const bar = P.spotsOfProp({ item: 'bar_island', x: 0, z: 0, y: 0, rotY: 0 }); assert.equal(bar.filter((s) => s.k === 'work').length, 2); assert.equal(bar.filter((s) => s.k === 'bar').length, 10);
  assert.deepEqual(P.spotsOfProp({ item: 'no_such_item' }), []);
});

test('theatre: full seats during the show, nearly empty before noon, scaling with guests', () => {
  const th = roomOf('theatre'); assert.ok(th, 'a theatre');
  const show = people(th, { hour: 18.7 }), morning = people(th, { hour: 10 });
  assert.ok(show.filter((a) => a.mode === 'sit').length > 60, `${show.length}`);
  assert.ok(morning.length < show.length * 0.25);
  const small = people(th, { hour: 18.7, guests: 200 }), big = people(th, { hour: 18.7, guests: 6500 });
  assert.ok(small.length < big.length * 0.6, `${small.length} vs ${big.length}`);
  assert.ok(show.every((a) => a.room === th.id && Number.isFinite(a.x) && Number.isFinite(a.z)));
  assert.ok(show.some((a) => a.role === 'performer') || people(th, { hour: 18.7 }).length > 0);
});

test('looks: varied, deterministic, uniforms for crew, small kids', () => {
  assert.deepEqual(P.lookOf(5, 'guest'), P.lookOf(5, 'guest'));
  const tops = new Set(); for (let i = 0; i < 60; i++) tops.add(P.lookOf(i, 'guest').top);
  assert.ok(tops.size >= 8, `${tops.size} tops`);
  assert.equal(P.lookOf(1, 'waiter').top, P.UNIFORMS.waiter.top); assert.ok(P.lookOf(1, 'kid').h < 0.85); assert.ok(P.lookOf(2, 'swim').shorts);
});

test('rooms: determinism from the seed and the hour, differences between seeds and hours', () => {
  const rooms = plan.rooms.filter((r) => P.kindOfRoom(r));
  const sig = (seed, hour) => JSON.stringify(rooms.map((r) => [...people(r, { seed, hour }), ...P.roamersFor(r, { seed, hour, guests: 3000, crew: 1200 })].map((a) => [a.id, a.mode, a.x, a.z, a.look.top])));
  assert.equal(sig(3, 19), sig(3, 19));
  assert.notEqual(sig(3, 19), sig(4, 19)); assert.notEqual(sig(3, 19), sig(3, 4));
  const n = (hour) => rooms.reduce((s, r) => s + people(r, { hour }).length, 0);
  assert.ok(n(13) > 0 && n(19) > n(4), `${n(13)} ${n(19)} ${n(4)}`);
});

test('roamers: strollers on the street scale with the guests, waiters in dining rooms, none where nobody walks', () => {
  const st = roomOf('promenade') || roomOf('atrium'), rs = roomOf('restaurant');
  const walk = (room, g, hour) => P.roamersFor(room, { seed: 1, hour, guests: g, crew: 1500 }).length;
  assert.ok(walk(st, 150, 17) <= walk(st, 6000, 17)); assert.ok(walk(st, 6000, 17) >= 2);
  assert.ok(P.roamersFor(rs, { seed: 1, hour: 19, guests: 3000, crew: 1500 }).some((a) => a.role === 'waiter' && a.mode === 'tray'));
  assert.equal(P.roamersFor({ id: 'x', space: 'cabin_cruise', x0: 0, x1: 4, z0: 0, z1: 4, y: 0 }, { seed: 1, hour: 12, guests: 3000, crew: 1000 }).length, 0);
});

test('budget: at most 110 people (32 on a phone) in at most 11 (6) pose meshes of ~100 triangles', () => {
  assert.deepEqual([P.budgetFor(false).max, P.budgetFor(true).max], [110, 32]);
  assert.ok(P.budgetFor(false).calls <= 11 && P.budgetFor(true).calls <= 6);
  assert.equal(P.posesFor(false).length, 11); assert.ok(P.posesFor(true).length <= P.budgetFor(true).calls, `${P.posesFor(true)}`);
  for (const pose of P.POSES) { assert.ok(P.PARTS[pose], pose); assert.ok(P.poseTris(pose) <= 120, `${pose} ${P.poseTris(pose)}`); }
  for (const a of ['clapA', 'clapB', 'danceB', 'tray', 'walkB']) assert.ok(P.posesFor(true).indexOf(a) < 0 && P.posesFor(true).includes(P.PHONE_ALIAS[a]));
  assert.ok(P.crowdTris(110) <= 12000);
  assert.equal(P.drawnPose({ mode: 'sit' }, 'clapA', false), 'clapA'); assert.equal(P.drawnPose({ mode: 'stand' }, 'clapA', false), 'danceA'); assert.equal(P.drawnPose({ mode: 'sit' }, 'clapB', true), 'sit');
});

test('selection: nearest first, capped, same deck band only', () => {
  const agents = [], poses = [];
  for (let i = 0; i < 300; i++) { agents.push({ i }); poses.push({ x: i * 0.1, z: 0, y: i % 7 === 0 ? 5 : 0 }); }
  poses.push(null); agents.push({});
  const sel = P.selectAgents(agents, poses, 0, 0, 0, P.budgetFor(false));
  assert.equal(sel.length, 110); assert.ok(sel.every((i) => poses[i].y === 0 && poses[i].x <= 24.01));
  assert.deepEqual(sel.slice(0, 3), [1, 2, 3]);
  assert.equal(P.selectAgents(agents, poses, 0, 0, 0, P.budgetFor(true)).length, 32);
});

test('paths: A* around walls, none through a sealed room, walkers stay on their path', () => {
  const wall = (x, z) => !(Math.abs(x - 5) < 0.6 && z < 6);   // a wall at x = 5 from z = -∞ to 6
  const path = P.findPath(wall, { x: 0, z: 0 }, { x: 10, z: 0 }, 0.5);
  assert.ok(path && path.length >= 3); assert.ok(path.every((q) => wall(q.x, q.z)), 'no waypoint in the wall');
  assert.ok(path.some((q) => q.z >= 5.5), 'goes round the end');
  assert.equal(P.findPath((x, z) => Math.hypot(x, z) > 2.2 || (x === 0 && z === 0), { x: 0, z: 0 }, { x: 8, z: 0 }, 0.5), null);
  const L = P.pathLen(path), a = { mode: 'walk', path, cum: L.cum, total: L.total, speed: 1.2, s0: 0, y: 0, phase: 0 };
  for (let t = 0; t < 200; t += 3.7) { const p = P.agentPose(a, t); assert.ok(Number.isFinite(p.x) && Number.isFinite(p.yaw)); assert.ok(p.x >= -0.6 && p.x <= 10.6); }
  assert.deepEqual([P.agentPose(a, 0).x, P.agentPose(a, 0).z].map((v) => Math.round(v)), [0, 0]);
});

test('behaviour: the theatre applauds, dancers alternate, guests turn to the player, walkers step aside', () => {
  const sit = { mode: 'sit', show: true, x: 0, y: 0, z: 0, yaw: 0, phase: 0 };
  const poses = new Set(); for (let t = 0; t < 140; t += 0.25) poses.add(P.agentPose(sit, t).pose);
  assert.ok(poses.has('sit') && poses.has('clapA') && poses.has('clapB'));
  const dance = { mode: 'dance', x: 0, y: 0, z: 0, yaw: 0, phase: 1 }, dp = new Set(); for (let t = 0; t < 4; t += 0.1) dp.add(P.agentPose(dance, t).pose);
  assert.ok(dp.has('danceA') && dp.has('danceB'));
  const stand = { mode: 'stand', x: 0, y: 0, z: 0, yaw: 0, phase: 0 }, p0 = P.agentPose(stand, 0), r = P.react(stand, p0, 2, 0);
  assert.ok(Math.abs(P.angleDiff(r.yaw, Math.PI / 2)) < Math.abs(P.angleDiff(p0.yaw, Math.PI / 2)), 'turns toward a player at +x');
  assert.equal(P.react(stand, p0, 30, 0).yaw, p0.yaw);
  const walker = { mode: 'walk' }, wp = { x: 0, y: 0, z: 0, yaw: 0 }, w = P.react(walker, wp, 0.0, 1.0);
  assert.ok(Math.hypot(w.dx, w.dz) > 0.1 && w.slow < 1, 'a walker facing the player slows and sidesteps');
  assert.equal(P.react({ mode: 'swim' }, wp, 0, 1).dx, 0);
});

test('sound: murmur and music follow the people around, a show room is loud, an empty room silent', () => {
  const show = P.soundMix('theatre', 18.8, { sit: 300 }), none = P.soundMix('theatre', 11, {}), pool = P.soundMix('pool', 13, { lie: 20, swim: 12, stand: 6 });
  assert.ok(show.murmur > 0.9 && show.music > 0.9); assert.ok(none.murmur === 0 && none.music < 0.1);
  assert.ok(pool.splash > 0.4 && pool.murmur > 0); assert.equal(P.soundMix('', 12, {}).splash, 0);
  for (const k of ['club', 'casino', 'bar', 'dining', 'street']) { const m = P.soundMix(k, 22, { stand: 10, dance: 10 }); for (const v of [m.murmur, m.music, m.splash]) assert.ok(v >= 0 && v <= 1); }
});

// ------------------------------------------------------------------------------------------------ the renderer
const THREE = await import('three');
const { Interior } = await import('../public/js/interior.js');
const { buildInteriorV2 } = await import('../public/js/iv2draw.js');
const { WalkMap } = await import('../public/js/walker.js');
const { CruiseCrowd, wantsCrowd, poseGeometry } = await import('../public/js/iv2crowd.js');

function world(deck, phone, hour, id = 'cruise362') {
  const pl = planFromGA(id, { deck }), map = new WalkMap(pl);
  const I = Object.create(Interior.prototype); I.textures = []; I.map = map; I.plan = pl; I.pos = new THREE.Vector3(); I.y = 0; I.isTouch = phone;
  I.app = { scene: new THREE.Scene(), you: { ship: { cls: id } }, shipTimeNow: () => hour * 3600 };
  I.mats = I.makeMaterials(pl.style);
  const root = new THREE.Group(); I.group = root; buildInteriorV2(I, pl, root, { phone });
  return { I, pl, root, map };
}
function stand(W, space, k = 0.5) {
  const r = W.pl.rooms.filter((q) => q.space === space).sort((a, b) => (b.x1 - b.x0) * (b.z1 - b.z0) - (a.x1 - a.x0) * (a.z1 - a.z0))[0];
  const x = r.x0 + (r.x1 - r.x0) * k, z = r.z0 + (r.z1 - r.z0) * k, y = W.map.standAt(x, z, r.y, 1) ?? r.y;
  W.I.pos.set(x, y, z); W.I.y = y; W.I.curRoom = r; return r;
}
function run(W, phone, frames = 30) {
  const crowd = new CruiseCrowd(W.I, W.pl, W.root, { phone }); W.I.crowd = crowd;
  for (let i = 0; i < frames; i++) crowd.frame(W.I, 0.25);
  return crowd;
}
const snap = (c) => JSON.stringify([...c.meshes.values()].map((m) => [m.userData.pose, m.count, Array.from(m.instanceMatrix.array.slice(0, m.count * 16)).map((v) => Math.round(v * 1000))]));

test('render: only cruise ships on v2 plans get a crowd', () => {
  assert.ok(wantsCrowd(plan)); assert.ok(!wantsCrowd({ v: 1, gen: 'cruise' })); assert.ok(!wantsCrowd(planFromGA('ultramax64'))); assert.ok(!wantsCrowd(null));
});

test('render: pose meshes are ~100 triangles of one geometry each, with a part per box', () => {
  for (const pose of P.POSES) { const g = poseGeometry(pose); assert.equal(g.index.count / 3, P.poseTris(pose)); assert.ok(g.attributes.aPart.count === g.attributes.position.count); g.dispose(); }
});

test('render: theatre during the show on a desktop — people, within 110, ≤ 11 draw calls, ≤ 12k triangles', () => {
  const W = world('d4', false, 18.9); stand(W, 'theatre', 0.55);
  const c = run(W, false);
  assert.ok(c.stats.drawn > 40 && c.stats.drawn <= 110, `${c.stats.drawn}`);
  assert.ok(c.stats.calls >= 2 && c.stats.calls <= 11, `${c.stats.calls}`); assert.ok(c.stats.tris <= 12000, `${c.stats.tris}`);
  for (const m of c.meshes.values()) assert.ok(m.count <= 110);
  const sitting = c.meshes.get('sit').count + c.meshes.get('clapA').count + c.meshes.get('clapB').count; assert.ok(sitting > 30, `${sitting} seated`);
  c.dispose(); assert.equal(c.group.parent, null);
});

test('render: the same ship, spot and hour draw the same people; another hour or seed does not', () => {
  const W = world('d4', false, 19); stand(W, 'restaurant', 0.5);
  const a = snap(run(W, false)), b = snap(run(W, false)); assert.equal(a, b);
  W.I.app.shipTimeNow = () => 4 * 3600; assert.notEqual(snap(run(W, false)), a);
});

test('render: a phone draws at most 32 people in at most 6 meshes', () => {
  const W = world('d4', true, 19.2); stand(W, 'restaurant', 0.5);
  const c = run(W, true);
  assert.ok(c.stats.drawn > 3 && c.stats.drawn <= 32, `${c.stats.drawn}`); assert.ok(c.stats.calls <= 6 && c.meshes.size <= 6, `${c.stats.calls}`);
  c.dispose();
});

test('render: the promenade has walkers with routes on the walk map, and they move', () => {
  const W = world('d5', false, 17); stand(W, 'promenade', 0.5);
  const c = run(W, false, 8);
  const walkers = c.agents.filter((a) => a.mode === 'walk' && a.path); assert.ok(walkers.length >= 2, `${walkers.length}`);
  for (const a of walkers) assert.ok(a.path.every((q) => W.map.standAt(q.x, q.z, a.y, 0.6) != null));
  const before = snap(c); for (let i = 0; i < 20; i++) c.frame(W.I, 0.25); assert.notEqual(snap(c), before);
  c.dispose();
});

test('render: a boutique ship is quiet, a giga ship busy (same venue, same hour)', () => {
  const count = (id, deck) => { const W = world(deck, false, 13, id); const sp = W.pl.rooms.find((r) => r.space === 'promenade' || r.space === 'atrium'); if (!sp) return null; stand(W, sp.space, 0.5); const c = run(W, false, 6); const n = c.stats.people; c.dispose(); return n; };
  const small = count('boutique125', 'd3') ?? 0, big = count('cruise362', 'd5');
  assert.ok(big > small, `${small} vs ${big}`);
});

test('render: no crowd, no cost — frame() with the group hidden does nothing', () => {
  const W = world('d4', false, 12); stand(W, 'theatre'); const c = new CruiseCrowd(W.I, W.pl, W.root, {});
  W.I.group.visible = false; c.frame(W.I, 0.2); assert.equal(c.agents.length, 0); c.dispose();
});
