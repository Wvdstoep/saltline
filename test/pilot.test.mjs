// Autopilot decisions (public/js/pilotcore.js, docs/V6-QUICK-CONTRACTS.md §4.6): harbour speed bands, the throttle cap,
// the look-ahead, shallows ahead, off-route distance, the re-plan rate limit, the berth hand-over, storms on the route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PILOT, speedCapKn, throttleCap, lookAheadM, firstShoal, offRouteM, shouldReplan, handoverStep, stormOnRoute } from '../public/js/pilotcore.js';
import { destination, haversine } from '../shared/geo.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test('pilot: harbour speed bands and the throttle cap', () => {
  assert.equal(speedCapKn(999), 4); assert.equal(speedCapKn(1001), 6); assert.equal(speedCapKn(2400), 6);
  assert.equal(speedCapKn(4000), 10); assert.equal(speedCapKn(5001), Infinity); assert.equal(speedCapKn(Infinity), Infinity);
  assert.ok(near(throttleCap(4, 14), 4 / 14)); assert.ok(near(throttleCap(4, 14), 0.2857142857142857));
  assert.equal(throttleCap(1, 26), PILOT.MIN_THR); assert.equal(throttleCap(1, 26), 0.12);
  assert.equal(throttleCap(Infinity, 14), 1); assert.equal(throttleCap(30, 14), 1);
  // steady state never above the cap: target speed = throttle × maxKn (× penalties ≤ 1)
  for (const [cap, max] of [[4, 14], [6, 22], [10, 12]]) assert.ok(throttleCap(cap, max) * max <= cap + 1e-9 || throttleCap(cap, max) === PILOT.MIN_THR);
});

test('pilot: look-ahead distance', () => {
  assert.equal(lookAheadM(10, 1), 1500);
  assert.equal(lookAheadM(14, 400), 12000);
  assert.ok(near(lookAheadM(14, 5), 14 * 0.514444 * 5 * 90, 1e-6));
  assert.equal(lookAheadM(-8, 20), Math.min(12000, 8 * 0.514444 * 20 * 90));
  assert.equal(lookAheadM(0, 1), 1500);
});

test('pilot: firstShoal walks a two-leg route, skips unknown depths, null when all deep', () => {
  const ship = { lat: 54, lon: 3 };
  const p1 = destination(54, 3, 90, 1000), p2 = destination(p1.lat, p1.lon, 0, 2000);
  const route = [p1, p2];
  // shallow 1.5 km along: 500 m north of p1 on the second leg
  const shoalAt = destination(p1.lat, p1.lon, 0, 500);
  const depthFn = (lat, lon) => (haversine(lat, lon, shoalAt.lat, shoalAt.lon) < 120 ? 3 : 20);
  const s = firstShoal(ship, route, 5000, depthFn, 6.5);
  assert.ok(s, 'found');
  assert.ok(s.distM >= 1350 && s.distM <= 1550, `at ${s.distM} m`);
  assert.equal(s.depthM, 3);
  assert.ok(haversine(s.lat, s.lon, shoalAt.lat, shoalAt.lon) < 120);
  assert.equal(firstShoal(ship, route, 1200, depthFn, 6.5), null, 'beyond the look-ahead');
  assert.equal(firstShoal(ship, route, 5000, () => 20, 6.5), null, 'all deep');
  assert.equal(firstShoal(ship, route, 5000, () => null, 6.5), null, 'unknown depths are skipped');
  const mixed = (lat, lon) => (haversine(lat, lon, ship.lat, ship.lon) < 600 ? null : depthFn(lat, lon));
  assert.ok(firstShoal(ship, route, 5000, mixed, 6.5));
  assert.equal(firstShoal(ship, [], 5000, depthFn, 6.5), null);
  // never more than LOOK_MAX_SAMPLES samples
  let calls = 0; firstShoal(ship, [destination(54, 3, 90, 50000)], 12000, () => { calls++; return 50; }, 5);
  assert.ok(calls <= PILOT.LOOK_MAX_SAMPLES, `${calls} samples`);
});

test('pilot: off-route distance from the current leg', () => {
  const a = { lat: 54, lon: 3 }, b = destination(54, 3, 90, 10000);
  const onLeg = destination(54, 3, 90, 4000);
  assert.ok(offRouteM(onLeg, [a, b]) < 10); // great circle vs the local plane: a few metres
  const off = destination(onLeg.lat, onLeg.lon, 0, 800);
  assert.ok(Math.abs(offRouteM(off, [a, b]) - 800) < 5);
  const behind = destination(54, 3, 270, 300);
  assert.ok(Math.abs(offRouteM(behind, [a, b]) - 300) < 5, 'before the leg start: distance to it');
  assert.equal(offRouteM(off, [b]), 0); assert.equal(offRouteM(off, []), 0);
});

test('pilot: re-plans are rate-limited and never while one is in flight', () => {
  const shoal = { distM: 900, depthM: 3 };
  assert.equal(shouldReplan({ lastPlanMs: -Infinity, inFlight: false }, 1000, { shoal }), true);
  assert.equal(shouldReplan({ lastPlanMs: 0, inFlight: false }, PILOT.REPLAN_MIN_MS - 1, { shoal }), false);
  assert.equal(shouldReplan({ lastPlanMs: 0, inFlight: false }, PILOT.REPLAN_MIN_MS, { shoal }), true);
  assert.equal(shouldReplan({ lastPlanMs: -Infinity, inFlight: true }, 1e9, { shoal }), false);
  assert.equal(shouldReplan({ lastPlanMs: -Infinity, inFlight: false }, 1e9, { shoal: null, offM: 580, L: 120 }), false, '580 m < 5 L = 600');
  assert.equal(shouldReplan({ lastPlanMs: -Infinity, inFlight: false }, 1e9, { shoal: null, offM: 620, L: 120 }), true, '620 m > 5 L = 600');
  assert.equal(shouldReplan({ lastPlanMs: -Infinity, inFlight: false }, 1e9, { offM: 499, L: 20 }), false);
  assert.equal(shouldReplan({ lastPlanMs: -Infinity, inFlight: false }, 1e9, { offM: 501, L: 20 }), true);
  assert.equal(shouldReplan({ lastPlanMs: -Infinity, inFlight: false }, 1e9, { storm: true }), true);
  assert.equal(shouldReplan(null, 1e9, { shoal }), false);
});

test('pilot: berth hand-over matrix', () => {
  const L = 90; // 3 L = 270 < 400; 1.5 L = 135 > 120
  assert.equal(handoverStep({ remainingToApproachM: 3000, L, guideReady: true, guideRemainingM: 2500 }), 'route');
  assert.equal(handoverStep({ remainingToApproachM: 380, L, guideReady: true, guideRemainingM: 1800 }), 'berth');
  assert.equal(handoverStep({ remainingToApproachM: 380, L, guideReady: false }), 'stop');
  assert.equal(handoverStep({ remainingToApproachM: 850, L: 300, guideReady: true, guideRemainingM: 1500 }), 'berth', 'within 3 L of a big ship');
  assert.equal(handoverStep({ remainingToApproachM: 850, L: 300, guideReady: false }), 'stop');
  assert.equal(handoverStep({ remainingToApproachM: 950, L: 300, guideReady: true, guideRemainingM: 1500 }), 'route');
  assert.equal(handoverStep({ mode: 'berth', L, guideReady: true, guideRemainingM: 600 }), 'berth');
  assert.equal(handoverStep({ mode: 'berth', L, guideReady: true, guideRemainingM: 130 }), 'stop', '≤ 1.5 L');
  assert.equal(handoverStep({ mode: 'berth', L: 20, guideReady: true, guideRemainingM: 119 }), 'stop', '≤ STOP_M');
  assert.equal(handoverStep({ mode: 'berth', L: 20, guideReady: true, guideRemainingM: 125 }), 'berth');
  assert.equal(handoverStep({ mode: 'berth', L, guideReady: false, guideRemainingM: 600 }), 'stop', 'guide lost');
});

test('pilot: storms across the route ahead', () => {
  const ship = { lat: 55, lon: 2 };
  const p1 = destination(55, 2, 90, 40000), p2 = destination(p1.lat, p1.lon, 0, 80000);
  const route = [p1, p2];
  // a 10 km cell centred 30 km up the second leg: the leg enters it 40 + 20 = 60 km along the route
  const c = destination(p1.lat, p1.lon, 0, 30000);
  const storm = { id: 's1', name: 'Babet', lat: c.lat, lon: c.lon, radiusKm: 10, intensity: 0.8 };
  const hit = stormOnRoute(ship, route, [storm], { horizonM: 200000 });
  assert.ok(hit, 'found'); assert.equal(hit.storm.name, 'Babet');
  assert.ok(Math.abs(hit.distM - 60000) < 300, `enters at ${hit.distM}`);
  assert.equal(stormOnRoute(ship, route, [{ ...storm, intensity: 0.5 }], { horizonM: 200000 }), null, 'below STORM_MIN');
  assert.equal(stormOnRoute(ship, route, [storm], { horizonM: 50000 }), null, 'beyond the horizon');
  assert.equal(stormOnRoute(ship, route, [], { horizonM: 200000 }), null);
  const inside = stormOnRoute(c, [p2], [storm], { horizonM: 200000 });
  assert.equal(inside.distM, 0, 'already inside');
  // the nearer of two storms wins; a cell off the route is ignored
  const off = { id: 's2', name: 'Off', ...destination(55, 2, 180, 60000), radiusKm: 20, intensity: 1 };
  const first = { id: 's3', name: 'First', ...destination(55, 2, 90, 20000), radiusKm: 5, intensity: 0.7 };
  assert.equal(stormOnRoute(ship, route, [storm, off, first], { horizonM: 200000 }).storm.name, 'First');
});
