// World politics phase 2 wiring (docs/WORLD-POLITICS-PHASE2.md): the engine hooked into a real Game with the real dataset.
// Structure-only assertions where the data may be refreshed; exact ones for the known fixes (corridor exposure, clearance,
// banned-word false positives on real harbour names).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { carvingsForWorld, harborById, HARBORS } from '../server/harbors.js';
import { Game } from '../server/game.js';
import { captainRefusalFor } from '../server/fleet.js';
import { routeExposure } from '../shared/politics.js';
import { bannedHits } from '../scripts/politics/validate.mjs';

process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
const world = new World().load(carvingsForWorld(), () => {});
function fakeSocket() { return { readyState: 1, sent: [], send(m) { this.sent.push(JSON.parse(m)); }, close() {} }; }
function mkGame(opts = {}) { const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-test-state.json', ...opts }); g.saveState = () => {}; return g; }
function join(g, name) { const ws = fakeSocket(); const p = g.connect(ws, null, name); return { p, ws }; }
const last = (ws, t) => [...ws.sent].reverse().find((m) => m.t === t);

test('a Game builds the politics engine; opts.politics === false leaves it out', () => {
  const g = mkGame();
  assert.ok(g.politics && /^\d{4}\.\d{2}\.\d+$/.test(g.politics.version));
  const c = g.politics.clientPayload();
  assert.equal(c.etag, `"pol-${g.politics.version}"`);
  assert.ok(!('trade' in JSON.parse(c.json)));
  assert.equal(mkGame({ politics: false }).politics, null);
});

test('harbour sheet carries rules, you carries pol, fleet view carries compliance; ships get a flag', () => {
  const g = mkGame(); const { p, ws } = join(g, 'Ann');
  const h = last(ws, 'harbor').harbor;
  assert.equal(h.rules.harbor, 'rotterdam');
  assert.equal(h.rules.status.value, 'open');
  assert.ok(Array.isArray(h.rules.sources));
  const you = last(ws, 'you')?.you || last(ws, 'welcome').you;
  assert.ok(you.pol && you.pol.ctx.home === 'NL');
  assert.equal(p.vessel.flag.cc, 'NL');
  assert.equal(p.vessel.builtIn, 'NL');
  const fv = g.fleet.fleetView(p);
  assert.equal(fv.compliance.riskPolicy, 'avoid');
  assert.equal(fv.homeMove.plan, null);   // moored at home: nothing to plan
});

test('buying stamps the origin; selling keeps stacks per origin', () => {
  const g = mkGame(); const { p } = join(g, 'Ann');
  g.tradeGoods(p, 'grain', 10, true);
  const st = p.cargo.find((c) => c.good === 'grain');
  assert.equal(st.origin, 'NL');
  const before = p.money;
  g.tradeGoods(p, 'grain', 10, false);
  assert.ok(p.money > before);
  assert.ok(!p.cargo.some((c) => c.good === 'grain'));
});

test('Odesa: corridor is on the route exposure and in the job risk tags', () => {
  const g = mkGame(), ds = g.politics.ds, ist = harborById('istanbul'), od = harborById('odesa');
  const ex = routeExposure(ds, ist, [[od.lat, od.lon]], 12, g.simTime);
  assert.ok(ex.areas.some((a) => a.kind === 'corridor' && a.id === 'ua-corridor'), JSON.stringify(ex.areas));
  const r = g.politics.riskOf('istanbul', 'odesa');
  assert.ok(r.areas.includes('ua-corridor'));
  assert.equal(r.tier, 4);
});

test('Odesa: clearance needed (refused), requested once (pending, not pushed out by a second click), then entry with the corridor', () => {
  const g = mkGame(); const { p, ws } = join(g, 'Ann');
  const e0 = g.politics.entryCheck(p, 'odesa');
  assert.equal(e0.refuse, true); assert.equal(e0.needs, 'clearance');
  g.onAction(p, { action: 'pol_clearance', harbor: 'odesa' });
  const pend = g.politics.youView(p).clearancePending.odesa;
  assert.ok(pend > g.simTime);
  g.simTime += 600;
  g.onAction(p, { action: 'pol_clearance', harbor: 'odesa' });
  assert.equal(g.politics.youView(p).clearancePending.odesa, pend);   // unchanged
  assert.ok(ws.sent.some((m) => m.t === 'event' && /already requested/.test(m.text)));
  g.simTime = pend + 1;
  const e1 = g.politics.entryCheck(p, 'odesa');
  assert.equal(e1.refuse, false); assert.equal(e1.needs, 'corridor');
  assert.ok(g.politics.youView(p).clearance.odesa > g.simTime);
});

test("captains under the 'avoid' policy refuse a run into a listed area; pol_policy changes it", () => {
  const g = mkGame(); const { p } = join(g, 'Ann');
  const job = g.politics.tagJob({ id: 'jx1', type: 'freight', from: 'istanbul', to: 'odesa', good: 'grain', qty: 100, pay: 1000 });
  assert.match(captainRefusalFor(g, p, p.vessel, job) || '', /risk policy is 'avoid'/);
  g.onAction(p, { action: 'pol_policy', riskPolicy: 'accept' });
  assert.equal(p.office.pol.riskPolicy, 'accept');
  assert.equal(captainRefusalFor(g, p, p.vessel, job), null);
});

test('an undock is refused while the ship is held; the hold lifts on the tick', () => {
  const g = mkGame(); const { p, ws } = join(g, 'Ann');
  p.vessel.held = { until: g.simTime + 3600, why: 'detention' };
  g.undock(p);
  assert.equal(p.docked, 'rotterdam');
  assert.ok(ws.sent.some((m) => m.t === 'event' && m.kind === 'law' && /Held/.test(m.text)));
  g.simTime += 3601; g.politics.tick(p);
  assert.equal(p.vessel.held, null);
});

test('state save/load keeps office.pol and the vessel flag', () => {
  const g = mkGame(); const { p } = join(g, 'Ann');
  g.onAction(p, { action: 'pol_policy', riskPolicy: 'cautious' });
  const rec = JSON.parse(JSON.stringify(p));
  g.politics.migrate(rec);
  assert.equal(rec.office.pol.riskPolicy, 'cautious');
  assert.equal(rec.fleet[0].flag.cc, 'NL');
});

test('banned-word check: whole words only, real harbour names never hit', () => {
  for (const h of HARBORS) assert.deepEqual(bannedHits(`Bound for ${h.name}.`), [], h.name);
  assert.deepEqual(bannedHits('Libreville (Owendo)'), []);
  assert.deepEqual(bannedHits('deadweight 5,000 t; deadline Friday; skilled crew'), []);
  assert.deepEqual(bannedHits('an evil plan'), ['evil']);
  assert.deepEqual(bannedHits('casualties reported'), ['casualt']);
  assert.deepEqual(bannedHits('enemies'), ['enemy']);
});
