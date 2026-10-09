// Dock anywhere — the game glue (server/quaygame.js) on the recorded Rotterdam tiles with a minimal Game stand-in:
// query → moor (day 1 + dues + pilotage) → stay → cast off (balance), tugs, occupancy by another skipper, service gates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPoints, loadPortFixture, FIXTURE_DIR } from './fixtures/wt/lib.mjs';
import { createQuayFinder, fitRun, runFrame, runPoint } from '../server/quays.js';
import { attachFinder, quayQuery, quayDock, quayDockNearest, quayTugs, quayAssistDone, quayUndock, quayGate, quayMigrate, quayPublic, quayAllowsAshore } from '../server/quaygame.js';
import { HARBORS } from '../server/harbors.js';
import { portDues, pilotageFee } from '../server/economy.js';
import { quayTugCost } from '../shared/quayrules.js';

const { ports } = loadPoints();
const fx = loadPortFixture(FIXTURE_DIR, ports.find((p) => p.id === 'rotterdam'));
const getTile = (z, x, y) => (z === 14 ? fx.tiles.get(`${x}/${y}`) || null : null);
const ROT = HARBORS.find((h) => h.id === 'rotterdam');
const P_TERMINAL = { lat: 51.948952, lon: 4.062297 };
const P_NARROW = { lat: 51.923143, lon: 4.194551 };

class FakeGame {
  constructor() {
    this.simTime = 1_000_000; this.byId = new Map(); this.events = []; this.sent = []; this.rnd = () => 0.99;
    this.fleet = { homeOf: () => null, vesselsNear: () => [], handles: (a) => a === 'fleet_hire' };
    attachFinder(this, createQuayFinder({ getTile, harbors: HARBORS }), getTile);
  }
  event(p, kind, text) { this.events.push({ kind, text }); }
  send(p, m) { this.sent.push(m); }
  sendYou() {} sendHarbor() {} dropWarp() {}
  setDocked(p, h, b) { p.docked = h; p.dockedAt = this.simTime; p.berth = b || null; p.assist = null; p.ship.spd = 0; }
  inspect() { return false; } deliverJobs() { return 0; } harborGeom() { return null; }
  player(id, cls, at, extra = {}) {
    const p = { id, name: id, online: true, money: 1e6, fuel: 100, cond: 100, flooding: 0, wanted: 0, cargo: [], jobs: [], docked: null, berth: null, assist: null, hail: null, ship: { cls, lat: at.lat, lon: at.lon, hdg: at.hdg ?? 0, spd: at.spd ?? 0 }, ...extra };
    this.byId.set(id, p); return p;
  }
  last(kind) { return [...this.events].reverse().find((e) => !kind || e.kind === kind)?.text || ''; }
}
function terminalRun(game) {
  const { runs } = game.quayFinder.runsNear(P_TERMINAL.lat, P_TERMINAL.lon, 300, 99);
  return runs.map((r) => ({ r, f: runFrame(r, P_TERMINAL.lat, P_TERMINAL.lon) })).filter(({ r, f }) => f.off > 0 && f.off < 120 && f.along > 0 && f.along < r.len).sort((a, b) => a.f.off - b.f.off)[0].r;
}

test('quay_query → quay_dock → cast off: fees exact, berth saved, other skippers see it', () => {
  const g = new FakeGame(), t = terminalRun(g);
  const fit = fitRun(t, { ...P_TERMINAL, hdg: t.hdg, cls: 'boxship' });
  const p = g.player('anna', 'boxship', { lat: fit.slot.lat, lon: fit.slot.lon, hdg: t.hdg, spd: 1 });
  quayQuery(g, p, { now: 10_000 });
  const q = g.sent.at(-1);
  assert.equal(q.t, 'quays'); assert.ok(q.list.some((c) => c.id === t.id && c.fits));
  quayQuery(g, p, { now: 10_500 }); assert.equal(g.sent.length, 1, 'rate-limited to 1 / s');
  const m0 = p.money;
  quayDock(g, p, { id: t.id });
  assert.equal(p.docked, 'rotterdam'); assert.equal(p.berth.quay, true); assert.equal(p.berth.tier, 'port'); assert.equal(p.berth.perDay, 4125);
  assert.equal(m0 - p.money, 4125 + portDues('boxship', ROT) + pilotageFee('boxship', ROT));
  assert.ok(Math.abs(p.ship.lat - fit.slot.lat) < 1e-9 && Math.abs(p.ship.lon - fit.slot.lon) < 1e-9);
  assert.deepEqual(quayPublic(p), { name: p.berth.name, cls: 'terminal' });
  assert.equal(quayAllowsAshore(p), false);
  // 2.5 days later: 3 started days, day 1 already paid
  g.simTime += 2.5 * 86400;
  const m1 = p.money, berth = p.berth;
  assert.equal(quayUndock(g, p), true);
  assert.equal(m1 - p.money, 8250);
  assert.equal(p.docked, null); assert.equal(p.berth, null);
  const f = runFrame(t, p.ship.lat, p.ship.lon);
  assert.ok(Math.abs(f.off - (berth.off + 20)) < 0.5);
  assert.equal(quayUndock(g, p), false, 'not moored: the harbour undock handles it');
});

test('T next to a quay (no harbour berth): quayDockNearest moors at the quay that fits, or does nothing', () => {
  const g = new FakeGame(), t = terminalRun(g);
  const fit = fitRun(t, { ...P_TERMINAL, hdg: t.hdg, cls: 'boxship' });
  const p = g.player('gus', 'boxship', { lat: fit.slot.lat, lon: fit.slot.lon, hdg: t.hdg + 180, spd: 0.5 });
  assert.equal(quayDockNearest(g, p), true); assert.equal(p.berth.quay, true);
  const q = g.player('hal', 'boxship', { ...runPoint(t, fit.slot.s, 400), hdg: 0, spd: 0 });
  assert.equal(quayDockNearest(g, q), false); assert.equal(q.docked, null);
});

test('quay_dock refusals: too fast, broke, hailed, occupied by another skipper', () => {
  const g = new FakeGame(), t = terminalRun(g);
  const fit = fitRun(t, { ...P_TERMINAL, hdg: t.hdg, cls: 'boxship' });
  const p = g.player('ben', 'boxship', { lat: fit.slot.lat, lon: fit.slot.lon, hdg: t.hdg, spd: 5 });
  quayDock(g, p, { id: t.id }); assert.equal(p.docked, null); assert.match(g.last('warn'), /Slow below 2 kn/);
  p.ship.spd = 0.5; p.money = 1000;
  quayDock(g, p, { id: t.id }); assert.equal(p.docked, null); assert.match(g.last('warn'), /first day \(4,125 cr\)/);
  p.money = 1e6; p.hail = { cutter: 'c1' };
  quayDock(g, p, { id: t.id }); assert.equal(p.docked, null); assert.match(g.last('law'), /heave to/);
  p.hail = null;
  const back = { lat: p.ship.lat, lon: p.ship.lon };
  Object.assign(p.ship, runPoint(t, fit.slot.s, 400));                  // ben stands off while cleo comes in
  // another container ship moors first on the same stretch; ours finds no 330 m left there
  const other = g.player('cleo', 'boxship', { lat: fit.slot.lat, lon: fit.slot.lon, hdg: t.hdg, spd: 0.5 });
  quayDock(g, other, { id: t.id }); assert.equal(other.docked, 'rotterdam');
  const free = fitRun(t, { ...P_TERMINAL, hdg: t.hdg, cls: 'boxship' }, { occupants: [{ lat: other.ship.lat, lon: other.ship.lon, hdg: other.ship.hdg, len: 300, beam: 43 }] });
  Object.assign(p.ship, back);
  quayDock(g, p, { id: t.id });
  if (free.fits) { // the wall is long enough for two: she must be sent to the other end, not on top of Cleo
    assert.equal(p.docked, null); assert.match(g.last('warn'), /Move \d+ m|along the quay/);
  } else { assert.equal(p.docked, null); assert.match(g.last('warn'), /^Occupied: cleo lies here/); }
});

test('tugs to a quay: paid up front, walked in, moored at the end (also after a restart)', () => {
  const g = new FakeGame(), t = terminalRun(g);
  const fit = fitRun(t, { ...P_TERMINAL, hdg: t.hdg, cls: 'boxship' });
  const away = runPoint(t, fit.slot.s, 250);
  const p = g.player('dirk', 'boxship', { ...away, hdg: 0, spd: 3 });
  const m0 = p.money;
  quayTugs(g, p, { id: t.id }, { now: 0 });
  assert.ok(p.assist?.quay, g.last('warn')); assert.equal(m0 - p.money, quayTugCost('boxship', 'port'));
  assert.equal(p.assist.until, 45_000);
  const a = p.assist;
  assert.equal(quayAssistDone(g, p, a), true);
  assert.equal(p.docked, 'rotterdam'); assert.equal(p.berth.quay, true);
  // restart while the tugs had her
  const q = g.player('eva', 'coaster', { ...runPoint(t, 30, 200), hdg: 0, spd: 1 });
  quayTugs(g, q, { id: t.id }, { now: 0 });
  assert.ok(q.assist?.quay, g.last('warn'));
  assert.equal(quayMigrate(g, q), true); assert.equal(q.docked, 'rotterdam'); assert.equal(q.assist, null);
  // restart with no tiles in memory yet: she is moored at the berth checked when the tugs took her
  const g2 = new FakeGame();                                                  // (dirk and eva fill the wall in g)
  const r = g2.player('fred', 'coaster', { ...runPoint(t, 30, 200), hdg: 0, spd: 1 });
  quayTugs(g2, r, { id: t.id }, { now: 0 });
  assert.ok(r.assist?.quay, g2.last('warn'));
  const slot = r.assist.to, cold = new FakeGame();
  cold.quayFinder = createQuayFinder({ getTile: () => null, harbors: HARBORS });
  const mr = r.money;
  assert.equal(quayMigrate(cold, r), true);
  assert.equal(r.docked, 'rotterdam'); assert.equal(r.berth.quay, true); assert.equal(r.ship.lat, slot.lat);
  assert.equal(mr - r.money, r.berth.perDay + portDues('coaster', ROT));
});

test('services at a quay outside the port: refused, trucked (+ surcharge), fuel capped; harbour berths untouched', () => {
  const g = new FakeGame();
  const p = g.player('finn', 'coaster', P_NARROW);
  p.docked = 'rotterdam'; p.berth = { quay: true, tier: 'near', harbor: 'rotterdam', hdKm: 13, name: 'Industrial AO · Rotterdam' };
  let ran = 0;
  quayGate(g, p, 'buy_ship', {}, () => { ran++; });
  assert.equal(ran, 0); assert.match(g.last('warn'), /shipyard is not available.*Rotterdam \(Maasvlakte\), 13 km away/i);
  quayGate(g, p, 'deliver_jobs', {}, () => { ran++; }); assert.equal(ran, 0);
  const m0 = p.money;
  quayGate(g, p, 'buy_goods', {}, () => { ran++; p.money -= 10000; });
  assert.equal(ran, 1); assert.equal(m0 - p.money, 10600); assert.match(g.last('info'), /Trucking.*600 cr/);
  const msg = { tonnes: 900 };
  quayGate(g, p, 'buy_fuel', msg, () => { p.money -= 1000; });
  assert.equal(msg.tonnes, 400);
  quayGate(g, p, 'fleet_order', {}, () => { ran++; }); assert.equal(ran, 2, 'fleet orders work from anywhere');
  quayGate(g, p, 'fleet_home', {}, () => { ran++; }); assert.equal(ran, 2); assert.match(g.last('warn'), /That needs you in Rotterdam \(Maasvlakte\) itself, 13 km away/);
  quayGate(g, p, 'rename', {}, () => { ran++; }); assert.equal(ran, 3, 'not a harbour service');
  p.berth = { harbor: 'rotterdam', id: 'rotterdam-b3' };                 // a harbour berth: everything as before
  const m1 = p.money; quayGate(g, p, 'buy_goods', {}, () => { p.money -= 10000; }); assert.equal(m1 - p.money, 10000);
});
