// Saltline sailing — one import point for the client modules that need shared/sail (main.js, net.js, autopilot.js,
// ship.js). The relative paths resolve to /shared/sail/… in the browser and to ../../shared/sail/… from public/js in
// Node, so tests that load a client file by rewriting its `./x` imports (test/autopilot-review.test.mjs) keep working
// (their rewrite only knows `/shared/<file>` and `./<file>`, not `/shared/sail/<file>`).
export { rigOf, sailIds, KN as SAIL_KN } from '../../shared/sail/rigs.js';
export { ensureRig, normalizeRig, anyHoisted, applyRigCommand, rigViewOf, packRigView, unpackRigView } from '../../shared/sail/state.js';
export { trimInfo, autoTrimView } from '../../shared/sail/trim.js';
export { polarSpeed, bestVmg, noGoDeg } from '../../shared/sail/polar.js';
export { sailCourse, beginManeuver, maneuverStep, helmFF, authOf, crossTrackM, HARBOUR_FURL_M, departurePlan } from '../../shared/sail/tactics.js';
export { windOverWater } from '../../shared/sail/sailphys.js';
