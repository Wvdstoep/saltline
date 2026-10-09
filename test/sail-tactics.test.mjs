// Lane A — tactics for automatic helms (docs/SAILING-CONTRACT.md §3.5, §6.4 A-6). Pure loops with the fast path
// (the offline/captain path); the Game-level runs need phase 2 wiring and are skipped until then.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepSailShip, windFrom, newShipState, WIRED } from './sail-helpers.mjs';
import { sailCourse, sailHelm, crossTrackM, beginManeuver, maneuverStep, helmFF, authOf, harbourRigCmd, departurePlan } from '../shared/sail/tactics.js';
import { bestVmg, polarSpeed } from '../shared/sail/polar.js';
import { ensureRig, applyRigCommand, defaultRig } from '../shared/sail/state.js';
import { haversine, bearing, destination, angleDiff, normDeg } from '../shared/geo.js';

const NM = 1852;

/** Sail from (lat0, lon0) to dest with the fast path at dt (s); wind FROM windDeg at twsKn. */
function voyage(cls, { twsKn = 12, windDeg = 0, distNm = 5, brg0 = 0, dt = 1, maxS = 6 * 3600, throttle = 0 } = {}) {
  const a = { lat: 50, lon: -20 }, b = destination(a.lat, a.lon, brg0, distNm * NM);
  const s = newShipState(cls, a.lat, a.lon, normDeg(brg0 + 40));
  const env = { wind: windFrom(windDeg, twsKn), gusts: false, fast: true, sailsUp: true };
  ensureRig(s, true);
  const mem = {}, log = [];
  let t = 0, maxXt = 0, tacks = [], lastTack = null;
  for (; t < maxS; t += dt) {
    const dist = haversine(s.lat, s.lon, b.lat, b.lon);
    if (dist < 400) break;
    const xt = crossTrackM(s.lat, s.lon, a.lat, a.lon, b.lat, b.lon);
    maxXt = Math.max(maxXt, Math.abs(xt) / Math.max(500, 0.3 * dist));
    const h = sailHelm(cls, s, { brg: bearing(s.lat, s.lon, b.lat, b.lon), distM: dist, xtM: xt, env, nowS: t, mem });
    stepSailShip(s, { throttleCmd: throttle, rudderCmd: h.rudderCmd }, env, dt);
    if (lastTack !== null && s.rig.tack !== lastTack) tacks.push(t);
    lastTack = s.rig.tack;
    if (t % 30 === 0) log.push({ t, twa: s.rig.twa, spd: s.spd, mode: h.mode });
  }
  return { t, arrived: haversine(s.lat, s.lon, b.lat, b.lon) < 400, maxXt, tacks, log, s };
}

test('sailCourse beats at ±bestVmg angles and keeps the tack until a layline or the cross-track limit', () => {
  const up = bestVmg('sloop', 12).up.twa;
  const mem = {};
  const r = sailCourse('sloop', { hdg: 320, brg: 0, distM: 20 * NM, twd: 0, twsKn: 12, stwKn: 6, helm: 0, auth: 1, tack: 1, nowS: 0, xtM: 0 }, mem);
  assert.equal(r.mode, 'beat'); assert.equal(mem.tack, 1); assert.ok(Math.abs(angleDiff(r.hdg, 360 - up)) < 1e-9, `${r.hdg}`);
  // the cross-track limit on the side this tack carries her (starboard tack heads left of the leg) after ≥ 60 s
  const far = { hdg: 320, brg: 0, distM: 20 * NM, twd: 0, twsKn: 12, stwKn: 6, helm: 0, auth: 1, tack: 1, xtM: -0.31 * 20 * NM };
  sailCourse('sloop', { ...far, nowS: 30 }, mem); assert.equal(mem.tack, 1, 'no tack before the leg lasted 60 s');
  const t2 = sailCourse('sloop', { ...far, nowS: 61 }, mem); assert.equal(mem.tack, -1); assert.equal(t2.maneuver, 'tack');
  assert.ok(Math.abs(angleDiff(t2.hdg, up)) < 1e-9);
  // layline: the mark bears near the other tack's heading
  const m2 = {};
  sailCourse('sloop', { hdg: 320, brg: up - 3, distM: 2 * NM, twd: 0, twsKn: 12, stwKn: 6, helm: 0, auth: 1, tack: 1, nowS: 0, xtM: 0 }, m2);
  const lay = sailCourse('sloop', { hdg: 320, brg: up - 3, distM: 2 * NM, twd: 0, twsKn: 12, stwKn: 6, helm: 0, auth: 1, tack: 1, nowS: 20, xtM: 0 }, m2);
  assert.equal(m2.tack, -1); assert.equal(lay.maneuver, 'tack');
  // reach: straight at the mark
  const reach = sailCourse('sloop', { hdg: 90, brg: 95, distM: 5 * NM, twd: 0, twsKn: 12, stwKn: 7, helm: 0, auth: 1, tack: -1, nowS: 0 }, {});
  assert.equal(reach.mode, 'reach'); assert.equal(reach.hdg, 95); assert.equal(reach.maneuver, null);
  // run: gybing downwind at the best downwind VMG angle
  const dn = bestVmg('sloop', 12).down.twa;
  const run = sailCourse('sloop', { hdg: 170, brg: 180, distM: 5 * NM, twd: 0, twsKn: 12, stwKn: 5, helm: 0, auth: 1, tack: 1, nowS: 0 }, {});
  assert.equal(run.mode, 'run'); assert.ok(Math.abs(Math.abs(angleDiff(run.hdg, 0)) - dn) < 1e-9);
});

test('helm feed-forward cancels the weather helm (sign: −tack·H/max(auth, 0.2)); build speed bears away to 60°', () => {
  assert.ok(helmFF(1, 0.5, 1) < 0, 'wind from starboard, weather helm turns her to starboard → port rudder');
  assert.ok(helmFF(-1, 0.5, 1) > 0);
  assert.equal(helmFF(1, 0.5, 0.1), -2.5);
  assert.ok(Math.abs(authOf(40) - Math.cos((40 * Math.PI) / 180) * (1 - 0.7 * 0.5)) < 1e-9);
  const mem = {};
  const slow = sailCourse('sloop', { hdg: 315, brg: 0, distM: 20 * NM, twd: 0, twsKn: 12, stwKn: 1, helm: 0, auth: 1, tack: 1, nowS: 0, xtM: 0 }, mem);
  assert.ok(Math.abs(angleDiff(slow.hdg, 300)) < 1e-9, `build speed at 60°: ${slow.hdg}`);
  const ok = sailCourse('sloop', { hdg: 300, brg: 0, distM: 20 * NM, twd: 0, twsKn: 12, stwKn: 6, helm: 0, auth: 1, tack: 1, nowS: 10, xtM: 0 }, mem);
  assert.equal(mem.build, false); assert.ok(Math.abs(angleDiff(ok.hdg, 360 - bestVmg('sloop', 12).up.twa)) < 1e-9);
});

test('waypoint 10 nm dead upwind: alternating tacks at ±bestVmg, cross-track within max(500 m, 0.3·dist), legs ≥ 60 s', () => {
  const r = voyage('sloop', { twsKn: 12, windDeg: 0, distNm: 10, brg0: 0 });
  assert.ok(r.arrived, `arrived after ${r.t} s`);
  assert.ok(r.tacks.length >= 2, `tacks ${r.tacks.length}`);
  for (let i = 1; i < r.tacks.length; i++) assert.ok(r.tacks[i] - r.tacks[i - 1] >= 60, `leg ${r.tacks[i] - r.tacks[i - 1]} s`);
  assert.ok(r.maxXt <= 1.1, `cross-track ${r.maxXt.toFixed(2)} × the limit`);
  const up = bestVmg('sloop', 12).up.twa;
  const legs = r.log.filter((x) => x.t > 300 && Math.abs(Math.abs(x.twa) - up) < 8);
  assert.ok(legs.length > r.log.length * 0.6, 'most of the time close-hauled at the VMG angle');
});

test('offline voyage: sloop 12 kn reaches a waypoint 5 nm dead upwind within 1.5 × (5 nm / VMG 4.6 kn) ≈ 1.63 h', () => {
  const r = voyage('sloop', { twsKn: 12, windDeg: 0, distNm: 5, brg0: 0, dt: 0.5 });
  assert.ok(r.arrived);
  assert.ok(r.t <= 1.5 * (5 / 4.6) * 3600, `${(r.t / 3600).toFixed(2)} h`);
});

test('downwind 5 nm at 180° gybes at the best downwind VMG angle (165–175°); a reach goes straight', () => {
  const dn = bestVmg('sloop', 12).down.twa;
  const r = voyage('sloop', { twsKn: 12, windDeg: 0, distNm: 5, brg0: 180, dt: 0.5 });
  assert.ok(r.arrived, `downwind ${r.t}`);
  assert.ok(r.tacks.length >= 1, 'at least one gybe');
  const run = r.log.filter((x) => x.t > 120 && x.mode === 'run');
  assert.ok(run.length > 0 && run.every((x) => Math.abs(Math.abs(x.twa) - dn) < 12), JSON.stringify(run.slice(0, 5)));
  assert.ok(dn >= 160 && dn <= 178, `gybing angle ${dn}`);
  const reach = voyage('ketch', { twsKn: 14, windDeg: 0, distNm: 5, brg0: 90, dt: 0.5 });
  assert.ok(reach.arrived); assert.equal(reach.tacks.length, 0);
  assert.ok(reach.t < (5 / (0.8 * polarSpeed('ketch', 14, 90).kn)) * 3600);
});

test('Z button: tack and jibe mirror the true wind angle; steering ends within 5°', () => {
  const mem = {};
  const b = beginManeuver('sloop', { hdg: 315, twd: 0, tack: 1, nowS: 5 }, mem);
  assert.equal(b.maneuver, 'tack'); assert.ok(Math.abs(angleDiff(b.hdg, 45)) < 1e-9);
  const step = maneuverStep({ hdg: 315, tack: 1, helm: 0, auth: 1 }, mem);
  assert.ok(step.rudderCmd > 0 && !step.done);
  assert.equal(maneuverStep({ hdg: 43, tack: -1, helm: 0, auth: 1 }, mem).done, true); assert.equal(mem.man, null);
  const j = beginManeuver('sloop', { hdg: 210, twd: 0, tack: 1, nowS: 0 }, {});
  assert.equal(j.maneuver, 'jibe'); assert.ok(Math.abs(angleDiff(j.hdg, 150)) < 1e-9);
});

test('cross-track sign, harbour furl and departure plan helpers', () => {
  const a = { lat: 50, lon: 0 }, b = destination(50, 0, 0, 10000);
  const right = destination(50, 0, 90, 300), left = destination(50, 0, 270, 300);
  assert.ok(crossTrackM(right.lat, right.lon, a.lat, a.lon, b.lat, b.lon) > 290);
  assert.ok(crossTrackM(left.lat, left.lon, a.lat, a.lon, b.lat, b.lon) < -290);
  const rig = defaultRig('sloop', { hoisted: true });
  assert.deepEqual(harbourRigCmd(rig, 2400), { all: 'furl' }); assert.equal(harbourRigCmd(rig, 2600), null);
  applyRigCommand('sloop', rig, { all: 'furl' }); for (const k in rig.sails) rig.sails[k].hoist = 0;
  assert.equal(harbourRigCmd(rig, 1000), null, 'already furled');
  assert.deepEqual(departurePlan('sloop', 22, 90), { plan: polarSpeed('sloop', 22, 90).level });
  assert.equal(departurePlan('coaster', 10), null);
  assert.equal(sailHelm('sloop', { hdg: 0, spd: 0, rig }, { brg: 0, env: {} }), null, 'no sail set → the caller steers straight');
});

// ---- phase 2: the real Game (skipped until server/game.js is wired — docs/SAILING-PHASE2.md)
import fs from 'node:fs';
const SERVER_WIRED = fs.readFileSync(new URL('../server/game.js', import.meta.url), 'utf8').includes('sailHelmOffline(');
const PH2 = SERVER_WIRED ? {} : { skip: 'needs wiring (phase 2)' };
const steadyWx = (fromDeg, kn) => () => { const w = windFrom(fromDeg, kn); return { wind: { ...w, spd: kn * 0.514444, dir: fromDeg, gust: kn * 0.514444 }, sea: 0.1, storm: 0, rain: 0, waves: { height: 0.4, dir: fromDeg, period: 4 }, swell: { height: 0, dir: fromDeg, period: 8 }, visibility: 20000, pressure: 1015, temp: 15, cloud: 0.3, source: 'test' }; };
async function realGame(opts = {}) {
  process.env.SALTLINE_DATA = process.env.SALTLINE_DATA || new URL('../data/', import.meta.url).pathname;
  const { Game } = await import('../server/game.js');
  const { World } = await import('../server/world.js');
  const { carvingsForWorld } = await import('../server/harbors.js');
  const world = new World().load(carvingsForWorld(), () => {});
  const g = new Game(world, () => {}, { stateFile: '/nonexistent/saltline-sail-tactics.json', ...opts }); g.saveState = () => {}; g.rnd = () => 0.5;
  return g;
}

test('Game.simulateOffline sails a sloop 5 nm dead upwind (fast path, sailCourse) within 1.63 h', PH2, async () => {
  const g = await realGame();
  const ws = { readyState: 1, sent: [], send() {}, close() {} };
  const p = g.connect(ws, null, 'Ann');
  g.onAction(p, { action: 'undock' });
  p.ship.cls = 'sloop'; p.sailsUp = true;
  const a = { lat: 55.0, lon: 3.5 }, b = destination(a.lat, a.lon, 0, 5 * NM);
  Object.assign(p.ship, { lat: a.lat, lon: a.lon, hdg: 40, spd: 4, throttle: 0, rudder: 0 }); p.lastValid = { ...a };
  g.weatherAt = steadyWx(0, 12);
  p.voyage = { route: [[b.lat, b.lon]], i: 0, throttle: 0, harbor: null, setAt: Date.now() };
  g.disconnect(p);
  let t = 0, tacks = 0, lastTack = null;
  for (; t < 3 * 3600 && p.voyage; t += 0.5) {
    g.simulateOffline(p, 0.5);
    if (lastTack !== null && p.ship.rig.tack !== lastTack) tacks++;
    lastTack = p.ship.rig.tack;
  }
  assert.equal(p.voyageEnd, 'arrived', `voyage end ${p.voyageEnd} after ${t} s`);
  assert.ok(t <= 1.5 * (5 / 4.6) * 3600, `${(t / 3600).toFixed(2)} h`);
  assert.ok(tacks >= 2, `tacks ${tacks}`);
  assert.equal(p.ship.rig.nan, 0);
});

test('captain sails a schooner to a harbour upwind and arrives (fleet-captain style)', PH2, async () => {
  const { straightPlanner } = await import('./fleet-helpers.mjs');
  const { setOrder } = await import('../server/captain.js');
  const { harborById } = await import('../server/harbors.js');
  const g = await realGame({ routePlanner: straightPlanner() });
  const ws = { readyState: 1, sent: [], send() {}, close() {} };
  const p = g.connect(ws, null, 'Ann'); p.money = 5e6; g.tick(0.1);
  g.onAction(p, { action: 'buy_ship', cls: 'schooner', tradeIn: false });
  const v = p.fleet[1]; assert.equal(v.ship.cls, 'schooner');
  const IJ = harborById('ijmuiden'), at = destination(IJ.lat, IJ.lon, 280, 15000);
  Object.assign(v.ship, { lat: at.lat, lon: at.lon, spd: 0, throttle: 0, rudder: 0 }); v.docked = null; v.dockedAt = null; v.berth = null; v.voyage = null; v.lastValid = { ...at };
  setOrder(g.fleet, v, { type: 'hold' });
  g.weatherAt = steadyWx(100, 14);                    // the harbour lies dead upwind
  g.fleet.onAction(p, { action: 'fleet_order', vesselId: v.id, order: { type: 'sail_to', harbor: 'ijmuiden' } });
  let sawTack = false, sawSet = false, lastTack = null;
  for (let s = 0; s < 8 * 3600 && !v.docked; s += 1) {
    await g.fleet.advance(v, 1);
    if (v.ship.rig && anyHoistedLocal(v.ship.rig)) sawSet = true;
    if (v.ship.rig) { if (lastTack !== null && v.ship.rig.tack !== lastTack) sawTack = true; lastTack = v.ship.rig.tack; }
  }
  assert.equal(v.docked, 'ijmuiden');
  assert.ok(sawSet, 'she sailed'); assert.ok(sawTack, 'she tacked');
});
function anyHoistedLocal(rig) { for (const k in rig.sails) if (rig.sails[k].hoist > 0.05) return true; return false; }
