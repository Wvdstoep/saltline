// Contracts end to end at the real server tick rate (10 Hz): fishing catches add up, tow casualties lie on open water,
// the tow line is passed alongside and harbour tugs take the tow over off the destination port, supply runs, abandoning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { carvingsForWorld, harborById, HARBORS } from '../server/harbors.js';
import { Game } from '../server/game.js';
import { generateJob } from '../server/economy.js';
import { buildGraph } from '../server/lanes.js';
import { planRoute, landOnLeg } from '../server/searoute.js';
import { SHIP_CLASSES, INTERACT } from '../shared/constants.js';
import { haversine, destination } from '../shared/geo.js';

process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
const world = new World().load(carvingsForWorld(), () => {});

function fakeSocket() { return { readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); }, close() {} }; }
// rnd = 0.5: no storms, no hails, no inspections
function mkGame() { const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-jobs-test-state.json' }); g.saveState = () => {}; g.rnd = () => 0.5; return g; }
function join(g, name) { const ws = fakeSocket(); const p = g.connect(ws, null, name); return { p, ws }; }
const events = (ws) => ws.sent.filter((m) => m.t === 'event').map((m) => m.text);
function atSea(g, name, pos, ship = {}) {
  const j = join(g, name);
  g.onAction(j.p, { action: 'undock' });
  Object.assign(j.p.ship, { lat: pos.lat, lon: pos.lon, hdg: 0, spd: 1, throttle: 0.05, rudder: 0 }, ship);
  j.p.lastValid = { lat: pos.lat, lon: pos.lon };
  return j;
}
const ticks = (g, n, dt = 0.1) => { for (let i = 0; i < n; i++) g.tick(dt); };
function seeded(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

test('fishing at the real 10 Hz tick adds up (it used to round every few-gram step back to zero)', () => {
  const g = mkGame(); const f = atSea(g, 'Fin', { lat: 54.7, lon: 2.8 }, { cls: 'coaster' });
  g.onAction(f.p, { action: 'fish', on: true }); assert.equal(f.p.fishing, true);
  ticks(g, 3000); // 5 minutes, coaster on the Dogger Bank: 0.6 × 1.0 × 10 = 6 t/h → 0.5 t
  const fish = f.p.cargo.filter((c) => c.good === 'fish' && c.caught).reduce((s, c) => s + c.qty, 0);
  assert.ok(Math.abs(fish - 0.5) < 0.01, `caught ${fish} t`);
  assert.ok(Math.abs(f.p.fishInfo.caught - 0.5) < 0.051, `HUD counter ${f.p.fishInfo.caught}`);
  g.sendYou(f.p); const y = [...f.ws.sent].reverse().find((m) => m.t === 'you').you;
  assert.equal(y.cargo.find((c) => c.caught).qty, 0.5, 'the wire carries the catch rounded to 0.1 t');
  // trawling speed: nets fish under FISH_MAX_KN, not above
  f.p.ship.spd = INTERACT.FISH_MAX_KN + 0.5; ticks(g, 10);
  assert.equal(f.p.fishInfo.tooFast, true);
  f.p.ship.spd = INTERACT.FISH_MAX_KN - 0.5; ticks(g, 10);
  assert.equal(f.p.fishInfo.tooFast, false);
});

test('a fishing contract completes with the catch landed at its harbour', () => {
  const g = mkGame(); const { p, ws } = join(g, 'Kai');
  const st = g.harbors.rotterdam;
  st.jobs.push({ id: 'jfish', type: 'fishing', from: 'rotterdam', to: 'rotterdam', ground: 'dogger', groundName: 'Dogger Bank', good: 'fish', qty: 2, pay: 1900, deadline: g.simTime + 86400, contraband: false, title: 'Catch 2 t' });
  g.onAction(p, { action: 'accept_job', jobId: 'jfish' }); assert.equal(p.jobs.length, 1);
  g.onAction(p, { action: 'undock' });
  Object.assign(p.ship, { lat: 54.7, lon: 2.8, spd: 1, cls: 'trawler' }); p.lastValid = { lat: 54.7, lon: 2.8 };
  g.onAction(p, { action: 'fish', on: true });
  ticks(g, 2500); // 250 s × 30 t/h ≈ 2.08 t
  g.onAction(p, { action: 'fish', on: false });
  const rot = harborById('rotterdam');
  Object.assign(p.ship, { lat: rot.lat, lon: rot.lon, spd: 0 }); const m = p.money;
  g.onAction(p, { action: 'dock' });
  assert.equal(p.jobs.length, 0, events(ws).slice(-4).join(' | '));
  assert.ok(p.money > m, 'paid');
});

test('generated tow casualties lie on open water deep enough for the disabled hull, away from land and harbours', () => {
  const g = mkGame(); const env = g.jobEnv();
  let n = 0;
  for (const h of HARBORS.filter((x) => x.lat > 50 && x.lat < 62 && x.lon > -6 && x.lon < 12)) {
    const rnd = seeded(n + 7);
    for (let k = 0; k < 4; k++) {
      const j = generateJob(h, g.simTime, rnd, 'tow', env);
      if (j.type !== 'tow') continue;
      n++;
      const draft = SHIP_CLASSES[j.victimCls].draft;
      assert.ok(world.depthAt(j.at.lat, j.at.lon) >= draft + 6, `${h.id}: casualty at ${j.at.lat},${j.at.lon} in ${world.depthAt(j.at.lat, j.at.lon)} m`);
      assert.ok(g.towSpotOk(j.at.lat, j.at.lon, draft));
    }
  }
  assert.ok(n > 20, `${n} tows checked`);
  // an old board job on land is moved to water once
  const j = { id: 'jold', type: 'tow', from: 'rotterdam', to: 'ijmuiden', at: { lat: 52.0, lon: 5.0 }, victimCls: 'coaster', pay: 1, deadline: g.simTime + 1e5, title: 'x' };
  assert.equal(world.isWater(52.0, 5.0), false);
  assert.equal(g.ensureTowSpot(j), true);
  assert.ok(g.towSpotOk(j.at.lat, j.at.lon, SHIP_CLASSES.coaster.draft), 'relocated onto open water');
  assert.match(j.title, /to IJmuiden/);
});

test('tow: pass the line alongside under 3 kn, tow her in, harbour tugs take over off the destination and it pays', () => {
  const g = mkGame(); const { p, ws } = join(g, 'Tess');
  const at = { lat: 52.6, lon: 3.9 };
  assert.ok(g.towSpotOk(at.lat, at.lon, 4.2), 'test casualty position is open water');
  g.harbors.rotterdam.jobs.push({ id: 'jtw', type: 'tow', from: 'rotterdam', to: 'ijmuiden', at, victimCls: 'trawler', pay: 12000, deadline: g.simTime + 86400, contraband: false, title: 'Tow' });
  g.onAction(p, { action: 'accept_job', jobId: 'jtw' }); assert.equal(p.jobs.length, 1);
  g.onAction(p, { action: 'undock' });
  // 280 m off at 5 kn: too fast
  const near = destination(at.lat, at.lon, 90, 280);
  Object.assign(p.ship, { lat: near.lat, lon: near.lon, spd: 5 }); p.lastValid = { ...near };
  g.onAction(p, { action: 'tow_pickup', jobId: 'jtw' }); assert.ok(!p.towing);
  p.ship.spd = 2; g.onAction(p, { action: 'tow_pickup', jobId: 'jtw' });
  assert.equal(p.towing, 'jtw', events(ws).at(-1));
  // other skippers see the casualty astern
  const other = join(g, 'Ola');
  const pub = g.publicState(p); assert.equal(pub.towing, true); assert.equal(pub.towCls, 'trawler');
  // 5 km off IJmuiden: still towing; 3 km off: tugs take over and the contract pays
  const ij = g.geom?.harborAnchor?.('ijmuiden') || harborById('ijmuiden');
  const far = destination(ij.lat, ij.lon, 270, 5000); Object.assign(p.ship, { lat: far.lat, lon: far.lon }); ticks(g, 2);
  assert.equal(p.towing, 'jtw');
  const m = p.money;
  const close = destination(ij.lat, ij.lon, 270, 3000); Object.assign(p.ship, { lat: close.lat, lon: close.lon }); ticks(g, 2);
  assert.equal(p.towing, null); assert.equal(p.jobs.length, 0);
  assert.ok(Math.abs(p.money - m - 12000) < 5, `paid ${p.money - m} (12,000 less a few seconds of crew wages) ${events(ws).slice(-3).join(' | ')}`);
  assert.ok(events(ws).some((t) => /harbour tugs take/.test(t)));
  other.ws.close();
});

test('abandoning a tow slips the tow line', () => {
  const g = mkGame(); const { p } = join(g, 'Abe');
  const at = { lat: 52.6, lon: 3.9 };
  g.harbors.rotterdam.jobs.push({ id: 'jab', type: 'tow', from: 'rotterdam', to: 'ijmuiden', at, victimCls: 'sloop', pay: 5000, deadline: g.simTime + 86400, contraband: false, title: 'Tow' });
  g.onAction(p, { action: 'accept_job', jobId: 'jab' }); g.onAction(p, { action: 'undock' });
  Object.assign(p.ship, { lat: at.lat, lon: at.lon, spd: 0 }); p.lastValid = { ...at };
  g.onAction(p, { action: 'tow_pickup', jobId: 'jab' }); assert.equal(p.towing, 'jab');
  g.onAction(p, { action: 'abandon_job', jobId: 'jab' });
  assert.equal(p.towing, null); assert.equal(p.jobs.length, 0);
});

test('supply run: the platform takes the cargo within 500 m under 3 kn', () => {
  const g = mkGame(); const { p } = join(g, 'Sam');
  const at = { lat: 56.55, lon: 3.21 };
  g.harbors.rotterdam.jobs.push({ id: 'jsp', type: 'supply', from: 'rotterdam', to: 'rotterdam', platform: 'ekofisk', platformName: 'Ekofisk complex', at, good: 'supplies', qty: 100, pay: 9000, deadline: g.simTime + 86400, contraband: false, title: 'Supply' });
  g.onAction(p, { action: 'accept_job', jobId: 'jsp' }); g.onAction(p, { action: 'undock' });
  const off = destination(at.lat, at.lon, 180, 450);
  Object.assign(p.ship, { lat: off.lat, lon: off.lon, spd: 1 }); p.lastValid = { ...off };
  const m = p.money;
  g.onAction(p, { action: 'deliver_offshore', jobId: 'jsp' });
  assert.equal(p.money, m + 9000); assert.equal(p.jobs.length, 0); assert.equal(p.cargo.length, 0);
});

test('sea routes: straight over open water, along the lanes round the land, every leg on water away from the ends', () => {
  const graph = buildGraph(world);
  const direct = planRoute(world, graph, harborById('rotterdam'), { lat: 52.6, lon: 3.9 });
  assert.equal(direct.via, 'direct'); assert.equal(direct.points.length, 1);
  for (const [a, b, h] of [['rotterdam', 'hamburg', 'hamburg'], ['oslo', 'rotterdam', 'rotterdam'], ['hamburg', null, null]]) {
    const from = harborById(a), to = b ? harborById(b) : { lat: 56.55, lon: 3.21 };
    const r = planRoute(world, graph, from, to, { toHarbor: h });
    assert.ok(r && r.points.length >= 2, `${a}→${b || 'Ekofisk'} needs waypoints`);
    assert.equal(r.via, 'lanes');
    const pts = [from, ...r.points.map(([lat, lon]) => ({ lat, lon }))];
    for (let i = 1; i < pts.length; i++) assert.equal(landOnLeg(world, pts[i - 1], pts[i], i === 1 ? 3000 : 0, i === pts.length - 1 ? 3000 : 0), 0, `${a}: leg ${i} crosses land`);
    assert.ok(r.distM > haversine(from.lat, from.lon, to.lat, to.lon), 'a detour is longer than the crow flies');
  }
});

test('an emergency tow into the contract port delivers like any arrival; the Deliver button says what is missing', () => {
  const g = mkGame(); const { p, ws } = join(g, 'Wim');
  g.harbors.rotterdam.jobs.push({ id: 'jfw', type: 'fishing', from: 'rotterdam', to: 'rotterdam', ground: 'southern_bight', groundName: 'Southern Bight', good: 'fish', qty: 100, pay: 95000, deadline: g.simTime + 86400, contraband: false, title: 'Catch 100 t' });
  g.onAction(p, { action: 'accept_job', jobId: 'jfw' });
  // nothing caught yet: Deliver explains instead of silently doing nothing
  g.onAction(p, { action: 'deliver_jobs' });
  assert.equal(p.jobs.length, 1);
  assert.match(events(ws).at(-1), /caught yourself aboard \(you have 0 t/);
  g.onAction(p, { action: 'undock' });
  Object.assign(p.ship, { lat: 52.3, lon: 3.1, spd: 0 }); p.lastValid = { lat: 52.3, lon: 3.1 };
  p.cargo.push({ good: 'fish', qty: 107, contraband: false, jobId: null, caught: true });
  p.money = 50000; const m = p.money;
  g.onAction(p, { action: 'tow' });              // "Call tow" back to Rotterdam
  assert.equal(p.docked, 'rotterdam');
  assert.equal(p.jobs.length, 0, events(ws).slice(-4).join(' | '));
  assert.ok(p.money > m, 'the contract paid on arrival');
});
