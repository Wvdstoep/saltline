// Review fixes for the v6 autopilot (public/js/autopilot.js, docs/V6-QUICK-CONTRACTS.md §4.6) and the world market client (public/js/market.js, §3.5). They import the
// browser paths /shared/…; the test loads a copy with those rewritten to file URLs and drives it with a fake app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { destination } from '../shared/geo.js';
import { SHIP_CLASSES } from '../shared/constants.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
async function loadClient(name) {
  let src = fs.readFileSync(path.join(ROOT, 'public/js', name), 'utf8');
  src = src.replace(/from '\/shared\/([\w.]+)'/g, (_, f) => `from '${pathToFileURL(path.join(ROOT, 'shared', f)).href}'`)
    .replace(/from '\.\/([\w.]+)'/g, (_, f) => `from '${pathToFileURL(path.join(ROOT, 'public/js', f)).href}'`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saltline-ap-'));
  const file = path.join(dir, name.replace(/\.js$/, '.mjs'));
  fs.writeFileSync(file, src);
  return import(pathToFileURL(file).href);
}
const loadAutopilot = () => loadClient('autopilot.js');

function fakeApp(ship) {
  const events = [];
  const app = {
    ship, you: { ship: { cls: 'coaster' }, docked: null, cargo: [] }, route: [], routeMeta: null, autopilot: false, warp: 1,
    input: { throttleCmd: 0, rudderCmd: 0 }, world: { harbors: [] }, storms: [], tideLevel: 0,
    terrain: { heightAt: () => -40 }, harborAnchor: (h) => h,
    hud: { event: (e) => events.push(e.text), chart: null, clearAlert() {}, alert() {} },
    setRoute(pts) { app.route = pts.map((p) => ({ ...p })); },
    clearRoute() { app.route = []; app.autopilot = false; app.routeMeta = null; },
    routeLength() { return 0; }, setWarp() {},
  };
  return { app, events };
}

test('autopilot review: a re-plan while steering keeps the skipper\'s order (not the harbour-band cap)', async () => {
  const { Autopilot } = await loadAutopilot();
  const ship = { lat: 52.0, lon: 3.5, hdg: 0, spd: 5, cls: 'coaster' };
  const { app } = fakeApp(ship);
  const C = SHIP_CLASSES.coaster;
  const pilot = new Autopilot(app); app.pilot = pilot;
  const far = destination(ship.lat, ship.lon, 0, 50000);
  app.route = [{ lat: far.lat, lon: far.lon }];
  app.input.throttleCmd = 0.8;
  pilot.engage(true);
  pilot.anchorDistM = 900; // inside the 4 kn band
  pilot.step(ship, C);
  assert.ok(Math.abs(app.input.throttleCmd - 4 / C.maxKn) < 1e-6, 'capped to 4 kn');
  // the planner answers a re-plan
  const pts = [[far.lat, far.lon]];
  globalThis.performance ??= { now: () => Date.now() };
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ points: pts, distM: 50000, draft: 5.5, ukcM: 2, marks: [], legs: [], warnings: [] }) });
  const r = await pilot.planTo({ lat: far.lat, lon: far.lon, reason: 'off' });
  assert.equal(r.ok, true);
  assert.equal(pilot.order, 0.8, 'the order survives the re-plan');
  pilot.anchorDistM = 20000; // out of the bands
  pilot.step(ship, C);
  assert.equal(app.input.throttleCmd, 0.8, 'back to the skipper\'s order outside the bands');
});

test('market review: the plan event rounds a small net to the 10, a big one to the 1,000', async () => {
  const { roundNet } = await loadClient('market.js');
  assert.equal(roundNet(1434), 1430);   // was "≈ 1,000 cr"
  assert.equal(roundNet(386), 390);     // was "≈ 0 cr"
  assert.equal(roundNet(175187), 175000);
});
