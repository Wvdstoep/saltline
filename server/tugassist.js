// Tug assist runtime (V5-PLAN item 4): plans the water-only path (server/tugpath.js), runs the harbour tugs and walks the
// assisted ship along the path at realistic speeds, then moors her exactly as a normal docking does.
//
// Phases of one assist (an "op", kept per game in a WeakMap — never saved; a restart completes the assist at its berth):
//   inbound  the tugs leave the tug station near the harbour anchor and sail (water-only routes) to the ship, which
//            carries on dead slow along the path;
//   fast     lines are passed and made fast (bow tug ahead on a line, stern tug astern; one tug for hulls under 60 m);
//   tow      ~4 kn in the open basins, slowing to ~1 kn over the last 150 m, turning her at a realistic rate; the tugs
//            lead the bow round in the turns and shift to the outboard side as she comes up to the berth;
//   swing    stopped off the berth, parallel to the quay; the tugs move round to push on the outboard side;
//   push     pushed sideways onto the berth, slowing to a gentle touch → moorAt + finishDock (as before);
//   return   the tugs cast off and sail back to their station, then disappear.
// The whole assist runs on its own clock, compressed so it never takes more than ~4 minutes of real time (`rate`).
// Tug positions are computed here every tick and go out in privateState.assist.tugs and publicState.tugs.
import { SHIP_CLASSES, GEO } from '../shared/constants.js';
import { tideAt } from '../shared/tide.js';
import { normDeg, angleDiff } from '../shared/geo.js';
import * as TP from './tugpath.js';
import { harborById } from './harbors.js';

const KN = GEO.KN_TO_MS;
export const TUGS = {
  SMALL_SHIP_M: 60,        // one tug below this length, two (bow + stern) from it
  CRUISE_KN: 4,            // in the open basins
  FINAL_KN: 1,             // over the last FINAL_M before the berth
  FINAL_M: 150,
  CREEP_KN: 1.2,           // the ship's own dead-slow while the tugs come out
  ACCEL: 0.05,             // m/s² along the path (tugs + ship)
  STOP_DECEL: 0.02,        // m/s² braking into the approach point
  PUSH_MS: 0.45,           // sideways speed onto the berth (max)
  PUSH_DECEL: 0.008,       // m/s² — she touches the fenders at a few cm/s
  TUG_KN: 11,              // tug transit speed (out to the ship, free running)
  TUG_HOME_KN: 9,          // and back to the station
  TUG_L: 32, TUG_B: 11, TUG_DRAFT: 5,
  LINE_M: 30,              // towline length
  FAST_S: 8,               // passing and making fast the lines
  SWING_MIN_S: 6,
  CAP_S: 240,              // real-time cap of the whole assist (the op clock runs faster when needed)
  MAX_RATE: 5,
  STEP_S: 0.2,             // integration step (op time)
  REPLAN_S: 4,             // a tug that cannot see its ship re-plans its route at most this often
  STATION_GROUP_M: 700,    // berths this close share a tug station
  WATCHDOG_S: 900,         // real seconds: an assist still running after this is finished at the berth
};

const OPS = new WeakMap();   // game → Map(playerId → op)
function opsOf(game) { let m = OPS.get(game); if (!m) { m = new Map(); OPS.set(game, m); } return m; }
let opSeq = 0;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const r1 = (v) => Math.round(v * 10) / 10, r2 = (v) => Math.round(v * 100) / 100, r6 = (v) => Math.round(v * 1e6) / 1e6;
const D2R = Math.PI / 180;
const fwdOf = (hdg) => [Math.sin(hdg * D2R), -Math.cos(hdg * D2R)];
const stbdOf = (hdg) => [Math.cos(hdg * D2R), Math.sin(hdg * D2R)];
const baseCache = new WeakMap(); // grid → tug stations [[x, z], …]

function tideHere(game, lat, lon) { try { const t = tideAt(lat, lon, game.simTime); return Number.isFinite(t?.height) ? t.height : 0; } catch { return 0; } }
const tugRuleFor = (tide) => TP.hullRule({ beam: TUGS.TUG_B, draft: TUGS.TUG_DRAFT, tide, margin: 4 });
/** Can a tug's centre be here? (looser than the planning rule: tugs work right up against quays and hulls) */
function tugWater(grid, x, z, tide) { return TP.inGrid(grid, x, z, 1) && TP.clearanceAt(grid, x, z) >= 4 && TP.bedAt(grid, x, z) <= tide - TUGS.TUG_DRAFT + 0.5; }

/** Candidate berths in the order the tugs try them: the chosen one, then the other fitting berths by distance. */
export function tugBerthCandidates(first, pool, lat, lon) {
  const d = (b) => (b.lat - lat) ** 2 + ((b.lon - lon) * Math.cos(lat * D2R)) ** 2;
  return [first, ...pool.filter((b) => b !== first).sort((a, b) => d(a) - d(b))].filter(Boolean).slice(0, 3);
}

/**
 * Plan an assist. Returns null when the harbour has no built patch (the caller keeps the legacy straight walk),
 * {ok: false, msg} when no water-only path exists (refuse, nothing charged), or {ok: true, grid, berth, path, …}.
 */
export function planTugAssist(game, p, harbor, berths) {
  let buf = null;
  try { buf = game.geom?.getHarborPatch?.(harbor.id) || null; } catch { buf = null; }
  const grid = buf ? TP.gridFromPatch(buf) : null;
  if (!grid || !berths || !berths.length) return null;
  const C = SHIP_CLASSES[p.ship.cls] || SHIP_CLASSES.coaster;
  const tide = tideHere(game, p.ship.lat, p.ship.lon);
  let start = TP.toXZ(grid, p.ship.lat, p.ship.lon);
  let lead = [];
  if (!TP.inGrid(grid, start[0], start[1], 3)) {
    // outside the 4.5 km patch: a straight run over the coarse world's water towards the anchor until we are on it
    const a = game.harborAnchor ? game.harborAnchor(harbor) : { lat: harbor.lat, lon: harbor.lon };
    const ax = TP.toXZ(grid, a.lat, a.lon);
    const dx = ax[0] - start[0], dz = ax[1] - start[1], D = Math.hypot(dx, dz);
    let ok = false;
    for (let s = 0; s <= D; s += 10) {
      const x = start[0] + (dx * s) / D, z = start[1] + (dz * s) / D;
      if (TP.inGrid(grid, x, z, 3)) { ok = TP.clearanceAt(grid, x, z) > 0; lead = [start, [x, z]]; break; }
      const ll = TP.toLL(grid, x, z);
      let depth = 99; try { depth = game.world?.depthAt ? game.world.depthAt(ll.lat, ll.lon) : 99; } catch { depth = 99; }
      if (!(depth + tide >= C.draft)) break;
    }
    if (!ok) return { ok: false, msg: 'The tug master cannot see a clear run to you from the harbour. Come closer to the entrance, in open water, and call again — nothing was charged.' };
    start = lead[1];
  }
  const reasons = [];
  for (const b of berths) {
    const bx = TP.toXZ(grid, b.lat, b.lon);
    let r;
    try { r = TP.planAssistPath(grid, start, { x: bx[0], z: bx[1], hdg: Number(b.hdg) || 0 }, { beam: C.beam, length: C.length, draft: C.draft, tide, hdg: lead.length ? undefined : Number(p.ship.hdg) }); } catch (e) { r = { ok: false, reason: 'error' }; game.log?.(`[tugs] plan failed: ${e.stack || e}`); }
    if (r.ok) {
      if (lead.length) { r.pts = [lead[0], ...r.pts]; r.cum = TP.cumLengths(r.pts); r.length = r.cum[r.cum.length - 1]; }
      return { ok: true, grid, berth: b, path: r, tide, meet: start };
    }
    reasons.push(r.reason);
  }
  const width = Math.round(C.beam + 2 * TP.TUGPATH.MARGIN_M), depth = (C.draft + TP.TUGPATH.DEPTH_MARGIN_M).toFixed(1);
  const why = reasons.includes('nopath') || reasons.includes('boxed')
    ? `there is no channel at least ${width} m wide with ${depth} m of water from here to ${berths[0].name}`
    : `there is no room off ${berths[0].name} to swing a ${Math.round(C.length)} m hull alongside`;
  return { ok: false, msg: `The tugs will not take this job: ${why}. Move into open water near the harbour entrance and call again — nothing was charged.` };
}

// ------------------------------------------------------------------------------------------------ op lifecycle
/** Start the tugs for a planned assist. Returns {id, until (ms), rate, tugs}. */
export function beginTugAssist(game, p, harbor, plan) {
  const { grid, path, berth, tide } = plan;
  const meet = plan.meet || path.pts[0]; // where the tugs sail out to (on the patch)
  const C = SHIP_CLASSES[p.ship.cls] || SHIP_CLASSES.coaster;
  const tugRule = tugRuleFor(tide);
  // tug stations: one inside the harbour near the anchor, and one by each group of berths (docks, terminals); the
  // nearest station sends the tugs, and they go back there afterwards
  let bases = baseCache.get(grid);
  if (!bases) {
    const a = game.harborAnchor ? game.harborAnchor(harbor) : { lat: harbor.lat, lon: harbor.lon };
    const geom = game.harborGeom ? game.harborGeom(harbor.id) : null;
    const bxz = (geom?.berths || []).map((b) => TP.toXZ(grid, b.lat, b.lon));
    const rule0 = tugRuleFor(0);
    bases = [TP.tugBase(grid, TP.toXZ(grid, a.lat, a.lon), bxz, rule0)];
    const groups = [];
    for (const p of bxz) { const g = groups.find((q) => Math.hypot(q.x / q.n - p[0], q.z / q.n - p[1]) < TUGS.STATION_GROUP_M); if (g) { g.x += p[0]; g.z += p[1]; g.n++; } else groups.push({ x: p[0], z: p[1], n: 1 }); }
    for (const g of groups) { const st = TP.tugBase(grid, [g.x / g.n, g.z / g.n], [], rule0); if (!bases.some((q) => Math.hypot(q[0] - st[0], q[1] - st[1]) < 150)) bases.push(st); }
    baseCache.set(grid, bases);
  }
  const base = bases.reduce((best, q) => (Math.hypot(q[0] - meet[0], q[1] - meet[1]) < Math.hypot(best[0] - meet[0], best[1] - meet[1]) ? q : best), bases[0]);
  const id = `tg${(++opSeq).toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const start = path.pts[0];
  const v0 = Math.max(0, Math.abs(Number(p.ship.spd) || 0) * KN);
  const op = {
    id, pid: p.id, harbor: harbor.id, berthId: berth.id, grid, tide, base, tugRule,
    L: C.length, B: C.beam, cls: p.ship.cls,
    path, s: 0, v: v0, x: start[0], z: start[1], hdg: Number(p.ship.hdg) || 0, yawRate: 0,
    approach: path.approach, berthXZ: path.berth, finalHdg: path.hdg, q: path.quaySide,
    pushD: 0, pushV: 0, pushLen: Math.hypot(path.berth[0] - path.approach[0], path.berth[1] - path.approach[1]),
    outBrg: normDeg(path.hdg - 90 * path.quaySide), // away from the quay
    phase: 'inbound', timer: 0, t: 0, rate: 1, tugs: [], finished: false,
  };
  // the tugs: route from the station out to where the ship is now
  const n = C.length < TUGS.SMALL_SHIP_M ? 1 : 2;
  let out = null;
  try { out = TP.route(grid, tugRule, base, meet, { radius: 30, goalEscapeM: 300 }); } catch { out = null; }
  for (let i = 0; i < n; i++) {
    const role = i === 0 ? 'bow' : 'stern';
    const t = { id: `${id}-${i + 1}`, role, x: base[0], z: base[1], hdg: 0, v: 0, mode: 'transit', thrust: 0.6, attached: false, route: out, rs: 0, delay: i * 10, line: null, end: 0, replanAt: 0, gone: false };
    if (!out) { // no water route from the station (odd geometry): she comes out from the nearest tug water to the ship
      const far = (k) => { const c = TP.cellXZ(grid, k); return tugWater(grid, c[0], c[1], tide) && Math.hypot(c[0] - meet[0], c[1] - meet[1]) > 120; };
      const near = TP.escapeTo(grid, meet[0], meet[1], far, 400, true);
      const c = near ? TP.cellXZ(grid, near[near.length - 1]) : [meet[0] + 150, meet[1]];
      t.x = c[0] + i * 20; t.z = c[1]; t.route = null;
    }
    if (t.route && t.route.pts.length > 1) { const a = TP.sampleAt(t.route.pts, t.route.cum, 0.5); t.hdg = TP.bearingXZ(a.tx, a.tz); }
    op.tugs.push(t);
  }
  // timing: realistic estimate, then the compression that keeps it under CAP_S of real time
  const est = estimateSeconds(op);
  // watchdog: tugs still not alongside after twice their sailing time (+2 min) make fast where they should be, so an
  // unreachable spot never leaves the skipper waiting for ever
  { let d = 0; for (const t of op.tugs) d = Math.max(d, t.route ? t.route.length : Math.hypot(t.x - op.x, t.z - op.z)); op.inboundLimit = 2 * (d / (TUGS.TUG_KN * KN) + 10 * n) + 120; }
  op.rate = clamp(est / TUGS.CAP_S, 1, TUGS.MAX_RATE);
  op.startedAt = Date.now();
  op.until = Date.now() + (est / op.rate) * 1000;
  // tugs of an earlier assist still sailing home keep going (they used to vanish when a new assist replaced them)
  const ops = opsOf(game), prev = ops.get(p.id);
  if (prev && prev !== op) { if (prev.phase !== 'return') startReturn(prev); ops.delete(p.id); ops.set(`${p.id}#${prev.id}`, prev); }
  ops.set(p.id, op);
  return { id, until: op.until, rate: op.rate, tugs: n, est };
}

function profileSpeed(R) {
  const cruise = TUGS.CRUISE_KN * KN, fin = TUGS.FINAL_KN * KN;
  let v = R > TUGS.FINAL_M ? cruise : fin + (cruise - fin) * (R / TUGS.FINAL_M);
  return Math.min(v, Math.sqrt(2 * TUGS.STOP_DECEL * Math.max(0, R)) + 0.02);
}
function estimateSeconds(op) {
  let T = 0;
  const phase = op.phase;
  if (phase === 'inbound') {
    let d = 0; for (const t of op.tugs) d = Math.max(d, (t.route ? t.route.length - t.rs : Math.hypot(t.x - op.x, t.z - op.z)) + t.delay * TUGS.TUG_KN * KN);
    T += d / (TUGS.TUG_KN * KN) + 15;
  }
  if (phase === 'inbound' || phase === 'fast') T += TUGS.FAST_S - (phase === 'fast' ? op.timer : 0);
  if (phase === 'inbound' || phase === 'fast' || phase === 'tow') {
    const L = op.path.length;
    for (let s = op.s; s < L; s += 5) T += Math.min(5, L - s) / Math.max(0.15, profileSpeed(L - s));
    T += 15;
  }
  if (phase !== 'push' && phase !== 'return') T += 25;
  if (phase !== 'return') { const D = Math.max(0, op.pushLen - op.pushD); T += D / 0.3 + 10; }
  return T;
}

// ------------------------------------------------------------------------------------------------ geometry of the tugs
/** Where tug `t` wants to be for the current phase: {x, z, hdg, line: [fwd, stbd] | null, end, mode}. */
function tugTarget(op, t) {
  const { L, B } = op;
  const f = fwdOf(op.hdg), r = stbdOf(op.hdg), q = op.q;
  const tl = TUGS.TUG_L / 2;
  const nTugs = op.tugs.length;
  const pushing = op.phase === 'swing' || op.phase === 'push';
  // swing to the outboard side only on the final run along the quay (lined up with the berth heading)
  const R = op.path.length - op.s, run = Math.max(40, (op.path.run || 60) * 0.7);
  const aligned = clamp(1 - Math.abs(angleDiff(op.hdg, op.finalHdg)) / 30, 0, 1);
  const blend = op.phase === 'tow' || op.phase === 'fast' || op.phase === 'inbound' ? clamp(1 - (R - 15) / run, 0, 1) * aligned : 1;
  const steer = clamp(op.yawRate * 20, -35, 35);
  const cands = [];
  if (pushing) {
    const off = nTugs === 1 ? 0 : t.role === 'bow' ? 0.28 * L : -0.28 * L;
    const out = B / 2 + tl + 0.5;  // tug nose on the fenders, outboard side (−q × starboard)
    const x = op.x + f[0] * off - q * r[0] * out, z = op.z + f[1] * off - q * r[1] * out;
    cands.push({ x, z, hdg: normDeg(op.hdg + 90 * q), line: null, end: tl, mode: 'push' });
  }
  // on a line: bow tug ahead pulling, stern tug astern (facing her), both swinging to the outboard side near the berth
  // (the outboard side is a fixed direction in the world — away from the quay — whatever her heading in the last turn)
  const lineLen = TUGS.LINE_M - 12 * blend;
  const bow = t.role === 'bow';
  const along = bow ? op.hdg : op.hdg + 180;
  const base = along + steer * (1 - blend) * (bow ? 1 : -1);
  const swung = along + angleDiff(along, op.outBrg) * 0.7;          // ~65° off the fore-and-aft line, outboard
  const brg0 = base + angleDiff(base, swung) * blend;
  // preferred side to swing to when the water ahead / astern is short: outboard near the berth, else into the turn
  const pref = blend > 0.3 ? (Math.sign(angleDiff(brg0, op.outBrg)) || 1) : (Math.sign(op.yawRate) || 1) * (bow ? 1 : -1);
  const px = op.x + f[0] * (bow ? L / 2 : -L / 2), pz = op.z + f[1] * (bow ? L / 2 : -L / 2); // fairlead
  for (const e of [0, 20, -20, 40, -40, 60, -60, 80, -80, 100, -100]) for (const len of [lineLen, 12]) {
    const brg = brg0 + pref * e, d = fwdOf(brg);
    cands.push({ x: px + d[0] * (len + tl), z: pz + d[1] * (len + tl), hdg: normDeg(bow ? brg : brg + 180), line: [bow ? L / 2 : -L / 2, 0], end: bow ? -0.22 * TUGS.TUG_L : tl, mode: 'tow' }); // bow tug: towing winch aft; stern tug: line from her bow
  }
  // first choice with comfortable room (a tug's half beam + 6 m), else the first she can be in at all, else the least bad
  let ok = null, best = null, bc = -Infinity;
  for (const c of cands) {
    const cl = TP.inGrid(op.grid, c.x, c.z, 1) ? TP.clearanceAt(op.grid, c.x, c.z) : -1e9;
    const wet = tugWater(op.grid, c.x, c.z, op.tide);
    if (wet && cl >= TUGS.TUG_B / 2 + 6) return c;
    if (wet && !ok) ok = c;
    if (cl > bc) { bc = cl; best = c; }
  }
  return ok || best;
}
/** Move a free (or loosely attached) tug toward a target pose. Returns the distance left. */
function seek(t, tg, h, vmax, turn) {
  const dx = tg.x - t.x, dz = tg.z - t.z, d = Math.hypot(dx, dz);
  const step = Math.min(d, vmax * h);
  if (d > 1e-6) { t.x += (dx / d) * step; t.z += (dz / d) * step; }
  t.v = step / h;
  const want = d > 25 ? TP.bearingXZ(dx, dz) : tg.hdg;
  t.hdg = normDeg(t.hdg + clamp(angleDiff(t.hdg, want), -turn * h, turn * h));
  return d - step;
}
function followRoute(t, h, v) {
  const R = t.route;
  t.rs = Math.min(R.length, t.rs + v * h);
  const a = TP.sampleAt(R.pts, R.cum, t.rs);
  t.x = a.x; t.z = a.z; t.v = v;
  t.hdg = normDeg(t.hdg + clamp(angleDiff(t.hdg, TP.bearingXZ(a.tx, a.tz)), -30 * h, 30 * h));
  return R.length - t.rs;
}

// ------------------------------------------------------------------------------------------------ stepping
function shipTurnRate(op, towed) {
  if (towed) return clamp(150 / op.L, 0.5, 3);              // deg/s with the tugs working her
  const C = SHIP_CLASSES[op.cls] || SHIP_CLASSES.coaster;
  return clamp(Math.min(C.turnRate, 3) * clamp(op.v / 1.5, 0.15, 1), 0.2, 3);
}
function stepShipAlongPath(op, h, towed, vCap) {
  const P = op.path, Ltot = P.length;
  const R = Ltot - op.s;
  const look = TP.sampleAt(P.pts, P.cum, op.s + Math.max(10, 0.25 * op.L));
  let want = op.hdg;
  const dl = Math.hypot(look.x - op.x, look.z - op.z);
  if (P.crab) want = op.finalHdg;                          // walked sideways / along the quay: she keeps her heading
  else if (dl > 2) want = TP.bearingXZ(look.x - op.x, look.z - op.z); else if (R < 2) want = op.finalHdg;
  const err = angleDiff(op.hdg, want);
  let vt = Math.min(profileSpeed(R), vCap);
  vt *= clamp(1 - (Math.abs(err) - 15) / 60, 0, 1); // far off the track direction: the tugs turn her on the spot first
  op.v += clamp(vt - op.v, -TUGS.ACCEL * h, TUGS.ACCEL * h);
  if (op.v < 0) op.v = 0;
  op.s = Math.min(Ltot, op.s + op.v * h);
  const p = TP.sampleAt(P.pts, P.cum, op.s);
  op.x = p.x; op.z = p.z;
  const rate = shipTurnRate(op, towed);
  const dh = clamp(err * 0.4, -rate, rate) * h;
  op.hdg = normDeg(op.hdg + dh); op.yawRate = dh / h;
}
function substep(op, h) {
  op.t += h;
  const grid = op.grid;
  if (op.phase === 'inbound' || op.phase === 'fast' || op.phase === 'tow') {
    const towed = op.phase === 'tow';
    stepShipAlongPath(op, h, towed, towed ? Infinity : TUGS.CREEP_KN * KN);
  }
  if (op.phase === 'swing') {
    const err = angleDiff(op.hdg, op.finalHdg), rate = shipTurnRate(op, true);
    const dh = clamp(err * 0.5, -rate, rate) * h; op.hdg = normDeg(op.hdg + dh); op.yawRate = dh / h; op.v = 0;
  }
  if (op.phase === 'push') {
    const D = op.pushLen, left = D - op.pushD;
    const vt = Math.min(TUGS.PUSH_MS, Math.max(0.04, Math.sqrt(2 * TUGS.PUSH_DECEL * Math.max(0, left))));
    op.pushV += clamp(vt - op.pushV, -0.02 * h, 0.02 * h);
    op.pushD = Math.min(D, op.pushD + Math.max(0.03, op.pushV) * h);
    const f = D > 0 ? op.pushD / D : 1;
    op.x = op.approach[0] + (op.berthXZ[0] - op.approach[0]) * f; op.z = op.approach[1] + (op.berthXZ[1] - op.approach[1]) * f;
    op.yawRate = 0; op.v = 0;
    if (op.pushD >= D - 0.02) op.finished = true;
  }
  // tugs
  let allFast = true;
  for (const t of op.tugs) {
    if (t.gone) continue;
    if (t.delay > 0) { t.delay -= h; t.v = 0; allFast = false; continue; }
    if (op.phase === 'return') {
      if (t.route) { t.mode = 'transit'; t.thrust = 0.5; t.line = null; if (followRoute(t, h, TUGS.TUG_HOME_KN * KN) <= 0.5) t.gone = true; }
      else t.gone = true;
      continue;
    }
    const tg = tugTarget(op, t);
    if (!t.attached) {
      allFast = false;
      if (op.phase === 'inbound' && op.t > (op.inboundLimit || Infinity)) { t.x = tg.x; t.z = tg.z; t.hdg = tg.hdg; t.v = 0; t.attached = true; t.route = null; continue; }
      const near = Math.hypot(tg.x - t.x, tg.z - t.z);
      const direct = near < 160 && TP.segmentWet(grid, t.x, t.z, tg.x, tg.z, 3);
      if (t.route && !direct && t.rs < t.route.length - 0.5) { followRoute(t, h, TUGS.TUG_KN * KN); t.mode = 'transit'; t.thrust = 0.6; continue; }
      if (!direct && near > 30 && op.t >= t.replanAt) { // lost sight of her: plan again from here
        t.replanAt = op.t + TUGS.REPLAN_S;
        let r = null; try { r = TP.route(grid, op.tugRule, [t.x, t.z], [op.x, op.z], { radius: 30, goalEscapeM: 300, escapeM: 200, throughObstacles: true }); } catch { r = null; }
        if (r) { t.route = r; t.rs = 0; continue; }
      }
      const left = seek(t, tg, Math.min(TUGS.TUG_KN * KN, 1.2 + op.v + 0.25 * near), 30);
      t.mode = 'transit'; t.thrust = 0.5; t.line = null;
      if (left < 3 && Math.abs(angleDiff(t.hdg, tg.hdg)) < 25) { t.attached = true; t.route = null; }
    } else {
      // made fast: stay with her (stiff), re-poses (swinging round to push) are sailed, not jumped
      seek(t, tg, op.v + 0.4 + (op.phase === 'swing' ? 1.5 : 0.8), op.phase === 'swing' ? 25 : 40);
      t.mode = tg.mode; t.line = tg.line; t.end = tg.end;
      t.thrust = tg.mode === 'push' ? (op.phase === 'push' ? 0.85 : 0.4) : clamp(0.35 + Math.abs(op.yawRate) * 0.4 + (op.v < 1 ? 0.2 : 0), 0, 1);
      if (Math.hypot(tg.x - t.x, tg.z - t.z) > 6 || Math.abs(angleDiff(t.hdg, tg.hdg)) > 12) allFast = false;
      if (op.phase === 'fast') t.thrust = 0.2;
    }
  }
  // phase changes
  if (op.phase === 'inbound' && allFast) { op.phase = 'fast'; op.timer = 0; }
  else if (op.phase === 'fast') { op.timer += h; if (op.timer >= TUGS.FAST_S) { op.phase = 'tow'; op.timer = 0; } }
  else if (op.phase === 'tow' && op.path.length - op.s < 0.3) { op.s = op.path.length; op.v = 0; op.x = op.approach[0]; op.z = op.approach[1]; op.phase = 'swing'; op.timer = 0; }
  else if (op.phase === 'swing') { op.timer += h; if (op.timer >= TUGS.SWING_MIN_S && allFast && Math.abs(angleDiff(op.hdg, op.finalHdg)) < 1) { op.hdg = op.finalHdg; op.phase = 'push'; op.timer = 0; } else if (op.timer > 90) { op.hdg = op.finalHdg; op.phase = 'push'; } }
}
function startReturn(op) {
  op.phase = 'return';
  for (const t of op.tugs) {
    if (t.gone) continue;
    t.attached = false; t.line = null; t.mode = 'transit';
    let r = null; try { r = TP.route(op.grid, op.tugRule, [t.x, t.z], op.base, { radius: 30, escapeM: 300, throughObstacles: true }); } catch { r = null; }
    t.route = r; t.rs = 0; t.delay = t.role === 'stern' ? 4 : 0;
  }
}

/** Write the op's ship pose into the player's ship. */
function applyShip(op, p) {
  const s = p.ship, ll = TP.toLL(op.grid, op.x, op.z);
  s.lat = ll.lat; s.lon = ll.lon; s.hdg = op.hdg;
  s.spd = Math.round((op.phase === 'push' ? op.pushV : op.v) / KN * 10) / 10;
  s.throttle = 0; s.rudder = 0;
  p.lastValid = { lat: s.lat, lon: s.lon };
}

/**
 * Tick for an assisted player (game.stepAssist). Returns false when this player has no planned op (legacy assist),
 * true otherwise. On arrival the ship is moored with game.moorAt + game.finishDock, exactly as dock() does.
 */
export function stepTugAssist(game, p, dt) {
  const op = opsOf(game).get(p.id);
  if (!p.assist || !p.assist.opId) return false;
  if (!op || p.assist.opId !== op.id) {
    // the op is gone (should not happen): never fall back to a straight walk — finish at the berth, the one safe spot
    const harbor = harborById(p.assist.harbor), geom = harbor && game.harborGeom ? game.harborGeom(harbor.id) : null;
    const b = geom ? (geom.berths || []).find((x) => x.id === p.assist.berthId) : null;
    p.assist = null;
    if (harbor) { if (b) game.moorAt(p, harbor, b); else game.setDocked(p, harbor.id, null); game.finishDock(p, harbor); }
    game.sendYou(p, { correction: true });
    return true;
  }
  let left = Math.max(0, Math.min(5, Number(dt) || 0.1)) * op.rate;
  while (left > 1e-9 && !op.finished) { const h = Math.min(TUGS.STEP_S, left); left -= h; substep(op, h); }
  if (!op.finished && Date.now() - op.startedAt > TUGS.WATCHDOG_S * 1000) { // never seen; a stuck assist ends at the berth
    game.log?.(`[tugs] assist ${op.id} for ${p.id} overran (${op.phase}); mooring at the berth`);
    op.finished = true; op.x = op.berthXZ[0]; op.z = op.berthXZ[1];
  }
  applyShip(op, p);
  if (!op.finished) {
    op.until = Date.now() + (estimateSeconds(op) / op.rate) * 1000;
    p.assist.until = op.until;
    return true;
  }
  // alongside: moor exactly as dock() would (moorAt keeps the heading she lies in), then the tugs go home
  const harbor = harborById(op.harbor);
  const geom = game.harborGeom ? game.harborGeom(op.harbor) : null;
  const b = geom ? (geom.berths || []).find((x) => x.id === op.berthId) : null;
  p.assist = null;
  startReturn(op);
  if (!harbor) { game.sendYou(p, { correction: true }); return true; }
  p.ship.hdg = op.finalHdg;
  if (b) game.moorAt(p, harbor, b); else game.setDocked(p, harbor.id, null);
  game.event(p, 'info', 'Tugs cast off. All fast alongside.');
  game.finishDock(p, harbor);
  game.sendYou(p, { correction: true });
  return true;
}

/** Once per game tick: tugs sailing home (and tugs of an assist that ended some other way) keep moving. */
export function tickTugs(game, dt) {
  const ops = OPS.get(game); if (!ops || !ops.size) return;
  for (const [key, op] of ops) {
    const p = game.byId?.get(op.pid) || game.players?.get(op.pid) || game.fleet?.actorById?.(op.pid) || null; // v6: a captain's assist keeps its tugs
    if (op.phase !== 'return') {
      if (p && p.assist && p.assist.opId === op.id) continue; // stepped by stepTugAssist
      startReturn(op);                                        // the assist ended elsewhere (impound, reset…)
    }
    // homeward bound in real time: nobody waits on them any more, and fast-forwarded tugs drew long white wakes
    let left = Math.max(0, Math.min(5, Number(dt) || 0.1)) * (op.phase === 'return' ? 1 : Math.max(1, op.rate));
    while (left > 1e-9) { const h = Math.min(TUGS.STEP_S, left); left -= h; substep(op, h); }
    if (op.tugs.every((t) => t.gone)) ops.delete(key);
  }
}

function tugWire(op, t) {
  const ll = TP.toLL(op.grid, t.x, t.z);
  const w = { id: t.id, lat: r6(ll.lat), lon: r6(ll.lon), hdg: r1(t.hdg), spd: r1(t.v / KN), mode: t.mode, thrust: r2(t.thrust), line: t.line ? [r1(t.line[0]), r1(t.line[1])] : null, end: r1(t.end || 0) };
  if (op.phase !== 'return' && op.rate > 1.05) w.ff = r1(op.rate); // fast-forward factor: the client keeps the wake to the real speed
  return w;
}
/** Tugs working for (or returning from) player p, for publicState / privateState; null when none. */
export function tugsPublic(game, p) {
  const ops = OPS.get(game);
  if (!ops || !ops.size) return null;
  let list = null;
  for (const op of ops.values()) {
    if (op.pid !== p.id) continue;
    for (const t of op.tugs) if (!t.gone) (list || (list = [])).push(tugWire(op, t));
  }
  return list;
}
const PHASE_TEXT = { inbound: 'on their way out to you', fast: 'making fast', tow: 'towing you in', swing: 'moving round to push', push: 'pushing you alongside', return: 'heading home' };
/** Extra fields for privateState.assist: phase, rate, tugs, the path (for the chart / guidance). */
export function assistExtra(game, p) {
  const op = OPS.get(game)?.get(p.id);
  if (!op || !p.assist || p.assist.opId !== op.id) return null;
  return { phase: op.phase, phaseText: PHASE_TEXT[op.phase] || op.phase, rate: r1(op.rate), tugs: tugsPublic(game, p) };
}
/** Tests / diagnostics. */
export function tugOp(game, pid) { return OPS.get(game)?.get(pid) || null; }
