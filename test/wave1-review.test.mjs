// Wave-1 review of the telegraph + berth guidance packages: the fixes made after an adversarial pass.
//  - STOP only stops the engine: the HUD must say she carries her way and that ASTERN is the brake (calloutNote, motionHint).
//  - Playability of the astern brake: full astern stops a coaster from full ahead in a few ship lengths, in 1–2 minutes,
//    far sooner than STOP alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calloutNote, motionHint } from '../shared/telegraph.js';
import { stepShip, newShipState } from '../shared/physics.js';
import { SHIP_CLASSES } from '../shared/constants.js';
import { haversine } from '../shared/geo.js';

test('telegraph HUD: STOP at speed says the ship carries her way and ASTERN brakes', () => {
  const stop = calloutNote('stop', 9);
  assert.match(stop, /engine stopped/); assert.match(stop, /carries her way/); assert.match(stop, /ASTERN/); assert.match(stop, /brake/);
  assert.equal(calloutNote('stop', 0.2), 'engine stopped', 'at rest: no braking advice');
  assert.match(calloutNote('stop', -3), /sternway/);
  assert.match(calloutNote('astern', 6), /braking/, 'astern with headway: brakes first');
  assert.match(calloutNote('astern', 0), /going astern/);
  assert.match(calloutNote('astern', 0), /starboard/, 'propeller walk is mentioned');
  assert.equal(calloutNote('ahead', 5), '', 'a plain ahead order needs no note');
  assert.match(calloutNote('ahead', -2), /sternway/);
});

test('telegraph HUD: the panel hint shows only while order and way disagree', () => {
  assert.match(motionHint(0, 0, 8), /Coasting at 8\.0 kn/);
  assert.match(motionHint(0, 0, 8), /STOP only stops the engine/);
  assert.match(motionHint(0, 0, 8), /ASTERN to brake/);
  assert.match(motionHint(-0.6, 0, 6), /reversing/, 'engine still standing before it runs astern');
  assert.match(motionHint(-0.6, -0.4, 6), /Braking — still 6\.0 kn ahead/);
  assert.match(motionHint(0.45, 0.3, -2.5), /sternway — 2\.5 kn astern/);
  assert.equal(motionHint(1, 1, 12), null, 'full ahead and going ahead');
  assert.equal(motionHint(-0.6, -0.6, -4), null, 'astern and going astern');
  assert.equal(motionHint(0, 0, 0.5), null, 'stopped and (nearly) still');
});

test('astern brake is playable: coaster full ahead → full astern stops within ~4 lengths in 1–2 min, STOP alone drifts much further', () => {
  const C = SHIP_CLASSES.coaster, DT = 0.1;
  const stopRun = (cmd, until) => {
    const s = newShipState('coaster', 54, 3, 0); s.spd = C.maxKn; s.throttle = 1; s.throttleCmd = 1;
    let t = 0;
    while (t < 1200 && !until(s)) { stepShip(s, { throttleCmd: cmd, rudderCmd: 0 }, {}, DT); t += DT; }
    return { t, d: haversine(54, 3, s.lat, s.lon), s };
  };
  const crash = stopRun(-0.6, (s) => s.spd <= 0);
  assert.ok(crash.t >= 45 && crash.t <= 120, `crash stop takes ${crash.t.toFixed(0)} s`);
  assert.ok(crash.d / C.length >= 2 && crash.d / C.length <= 4.5, `crash stop in ${(crash.d / C.length).toFixed(1)} ship lengths`);
  const coast = stopRun(0, (s) => s.spd <= 1);
  assert.ok(coast.d > 1.8 * crash.d, `STOP alone drifts ${(coast.d / C.length).toFixed(1)} lengths vs ${(crash.d / C.length).toFixed(1)} with astern`);
  // after the crash stop the ship goes on to make sternway (the brake becomes reverse)
  const s = crash.s; for (let i = 0; i < 300; i++) stepShip(s, { throttleCmd: -0.6, rudderCmd: 0 }, {}, DT);
  assert.ok(s.spd < -0.5, `making sternway: ${s.spd.toFixed(2)} kn`);
});
