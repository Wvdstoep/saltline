// Sailing visuals — pure geometry (public/js/rigcore.js, public/js/yachtlooks.js): docs/SAILING-CONTRACT.md §4.2–§4.4,
// §6.4 B-1. Sails on the leeward side for both tacks, camber to leeward, feet on their booms, headsail luffs on their
// stays, masts clear of deck houses, booms clear of houses and of people on deck, reef areas, springs, LOD grids.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as RC from '../public/js/rigcore.js';
import * as Y from '../public/js/yachtlooks.js';
import { RIGS, rigOf } from '../shared/sail/rigs.js';
import { autoTrimView } from '../shared/sail/trim.js';
import { defaultRig, packRigView, unpackRigView, rigViewOf, applyRigCommand, settleRig } from '../shared/sail/state.js';

const CLASSES = Object.keys(RIGS);
const D2R = Math.PI / 180;
const finite3 = (p) => p.length === 3 && p.every(Number.isFinite);

test('yachtlooks: hull lines are finite, the four classes differ, waterline length matches the rig LWL', () => {
  for (const cls of CLASSES) {
    const st = Y.hullStations(cls, 30, 12);
    assert.ok(st.length === 32, cls);
    for (const s of st) for (const p of s.pts) assert.ok(finite3(p) && p[0] >= -1e-9, `${cls} station point`);
    const ext = Y.hullExtent(cls);
    assert.ok(Math.abs(ext.lwl - RIGS[cls].LWL) < 0.25, `${cls} LWL ${ext.lwl.toFixed(2)} vs ${RIGS[cls].LWL}`);
    const d = Y.deckOf(cls);
    // the mid-ship freeboard is the contract's deck height (§4.2)
    assert.ok(Math.abs(Y.sheerY(cls, cls === 'catamaran' ? -5 : 0) - (cls === 'catamaran' ? 1.36 : d.deckY)) < 0.08, `${cls} freeboard`);
  }
  const looks = CLASSES.map((c) => Y.looksOf(c).hull);
  assert.equal(new Set(looks).size, 4, 'four hull colours');
  // the catamaran's bridge deck sits 0.55 m above its hull decks forward, 0.9 m clearance under it
  assert.equal(Y.deckHeightAt('catamaran', 0, 0), 1.9);
  assert.ok(Math.abs(Y.deckHeightAt('catamaran', 3.0, -5.5) - 1.39) < 0.06);
});

test('mast feet stand on the deck (or on the coachroof) and clear every deck house by ≥ 0.4 m', () => {
  for (const cls of CLASSES) {
    for (const m of RIGS[cls].spars.masts) {
      const deck = Y.deckHeightAt(cls, 0, m.z);
      if (m.onRoof) { const s = Y.structureAt(cls, 0, m.z); assert.ok(s && Math.abs(s.top - m.foot) < 0.05, `${cls} ${m.id} on its roof`); }
      else assert.ok(deck !== null && Math.abs(deck - m.foot) < 0.12, `${cls} ${m.id} foot ${m.foot} vs deck ${deck}`);
    }
    for (const c of RC.mastClearances(cls)) {
      if (c.onRoof) continue;
      assert.ok(c.gap >= 0.4, `${cls} ${c.mast} vs ${c.structure}: ${c.gap.toFixed(2)} m`);
    }
  }
  // the schooner fix (§1.2 item 2): neither mast inside the doghouse or the forward house
  for (const c of RC.mastClearances('schooner')) assert.ok(c.gap > 1.0, `${c.mast} ${c.structure}`);
});

test('booms at every swing angle clear the deck houses (≥ 1.0 m; catamaran saloon roof ≥ 0.5 m) and the walkable deck (≥ 1.9 m)', () => {
  for (const cls of CLASSES) for (const b of RC.boomSweep(cls, 5)) {
    const need = cls === 'catamaran' ? 0.5 : 1.0;
    if (b.structId) assert.ok(b.structGap >= need - 1e-6, `${cls} ${b.sail} over ${b.structId}: ${b.structGap.toFixed(2)}`);
    assert.ok(b.deckGap >= 1.895, `${cls} ${b.sail} over the deck: ${b.deckGap.toFixed(3)}`);
  }
});

test('every sail is on the leeward side for both tacks, cambered to leeward, sitting on its boom', () => {
  for (const cls of CLASSES) {
    for (const awa of [35, 60, 90, 120, 150, -35, -60, -90, -120, -150]) {
      const view = autoTrimView(cls, awa, 7);
      const side = awa > 0 ? -1 : 1;                          // wind from starboard → sails to port
      const fr = RC.rigFrame(cls, view, { t: 0.3, aws: 7 });
      for (const p of fr.list) {
        if (!p.visible) continue;
        assert.equal(p.side, side, `${cls} ${p.s.id} awa ${awa}`);
        if (Math.abs(p.angle) > 0.5) {
          const leech = RC.sailPoint(p, 1, 0.3, [0, 0, 0]);
          assert.ok(leech[0] * side > 0, `${cls} ${p.s.id} awa ${awa}: leech x ${leech[0].toFixed(2)}`);
        }
        // camber: the cambered surface lies to leeward of the flat chord surface (rotated frame)
        const Q = RC.sailPoint(p, 0.45, 0.5, [0, 0, 0]), F = RC.sailPoint(p, 0.45, 0.5, [0, 0, 0], true);
        const d = RC.rowAngle(p, 0.5) * D2R, n = side * ((Q[0] - F[0]) * Math.cos(d) - (Q[2] - F[2]) * Math.sin(d));
        assert.ok(n > 0.01, `${cls} ${p.s.id} camber to leeward (${n.toFixed(3)})`);
      }
      // boomed sails: the foot runs along the boom, the clew at its end
      for (const bo of fr.booms) {
        const p = fr.params[bo.sail]; if (!p.visible || bo.club) continue;
        const clew = RC.sailPoint(p, 1, 0, [0, 0, 0], true);
        const dist = RC.distToSegment(clew, bo.a, bo.b);
        assert.ok(dist < 0.35, `${cls} ${bo.sail} clew on the boom (${dist.toFixed(2)} m)`);
        for (let u = 0; u <= 1; u += 0.25) { const f = RC.sailPoint(p, u, 0, [0, 0, 0], true); assert.ok(f[1] >= bo.a[1] - 0.05, `${cls} ${bo.sail} foot above the gooseneck`); }
      }
    }
  }
});

test('headsail luffs lie on their stays (≤ 2 cm), at any trim, furled or not', () => {
  for (const cls of CLASSES) {
    const R = rigOf(cls);
    for (const s of R.sails.filter((x) => x.head)) {
      const stay = RC.stayOf(cls, s.id); assert.ok(stay, `${cls} ${s.id} has a stay`);
      for (const [angle, hoist] of [[-15, 1], [40, 1], [-60, 0.5]]) {
        const p = RC.sailParams(cls, { id: s.id, hoist, reef: 0, angle, state: 0, tt: 0 }, { t: 1 });
        for (let v = 0; v <= 1.0001; v += 0.1) {
          const L = RC.sailPoint(p, 0, v, [0, 0, 0]);
          assert.ok(RC.distToSegment(L, stay[0], stay[1]) <= 0.02, `${cls} ${s.id} luff off its stay at v ${v.toFixed(1)}`);
        }
      }
    }
  }
});

test('reefed sail area matches the reef factor (± 5 %); the reefed foot comes down to the boom', () => {
  for (const cls of CLASSES) for (const s of RIGS[cls].sails) {
    if (!s.reefs.length) continue;
    const a0 = RC.sailAreaVis(cls, s.id, 0);
    s.reefs.forEach((f, k) => {
      const a = RC.sailAreaVis(cls, s.id, k + 1);
      assert.ok(Math.abs(a / a0 / f - 1) <= 0.05, `${cls} ${s.id} reef ${k + 1}: ${(a / a0).toFixed(3)} vs ${f}`);
      const p = RC.sailParams(cls, { id: s.id, hoist: 1, reef: k + 1, angle: -20, state: 0, tt: 0 }, {});
      const tack = RC.sailPoint(p, 0, 0, [0, 0, 0], true), head = RC.sailPoint(p, 0, 1, [0, 0, 0], true);
      const full = RC.sailPoint(RC.sailParams(cls, { id: s.id, hoist: 1, reef: 0, angle: -20, state: 0, tt: 0 }, {}), 0, 1, [0, 0, 0], true);
      const boom = RIGS[cls].spars.booms.find((b) => b.sail === s.id);
      assert.ok(Math.abs(tack[1] - boom.y) < 0.15, `${cls} ${s.id} reef tack at the gooseneck`);
      assert.ok(head[1] < full[1] - 0.5, `${cls} ${s.id} reefed head comes down`);
    });
    assert.ok(RC.reefPoints(RC.sailParams(cls, { id: s.id, hoist: 1, reef: 0, angle: -20, state: 0, tt: 0 }, {})).length >= 3 * s.reefs.length, `${cls} ${s.id} reef points`);
  }
});

test('cloth states: luffing backs the luff, flogging ripples, both move with time; drawing sails are steady', () => {
  const at = (state, t, u = 0.15) => RC.sailPoint(RC.sailParams('sloop', { id: 'genoa', hoist: 1, reef: 0, angle: -20, state, tt: 0 }, { t, aws: 8 }), u, 0.5, [0, 0, 0]);
  const flat = RC.sailPoint(RC.sailParams('sloop', { id: 'genoa', hoist: 1, reef: 0, angle: -20, state: 0, tt: 0 }, { t: 0 }), 0.15, 0.5, [0, 0, 0], true);
  // drawing: bulges to leeward (port, −x for side −1), time-independent
  assert.ok(at(0, 0)[0] < flat[0]); assert.deepEqual(at(0, 0), at(0, 1.3));
  // luffing: the front of the sail goes to windward of the flat chord at least part of the time
  let back = 0; for (let t = 0; t < 1; t += 0.05) if (at(1, t)[0] > flat[0]) back++;
  assert.ok(back > 5, 'luff backs');
  // flogging: large motion near the leech
  const xs = []; for (let t = 0; t < 1; t += 0.05) xs.push(at(2, t, 0.9)[0]);
  assert.ok(Math.max(...xs) - Math.min(...xs) > 0.25, 'leech flogs');
  assert.equal(RC.fillOf(0), 1); assert.equal(RC.fillOf(1), 0.4); assert.equal(RC.fillOf(2), 0);
});

test('telltales: three pairs on headsails, three on the leech of mains; ribbons follow the telltale code', () => {
  const p = RC.sailParams('sloop', { id: 'genoa', hoist: 1, reef: 0, angle: -20, state: 1, tt: 0b100101 }, { t: 0 });
  const tt = RC.telltales(p);
  assert.equal(tt.length, 6);
  assert.deepEqual(tt.map((x) => x.code), [1, 1, 1, 1, 2, 2]);
  // windward ribbon of a lifting band points up; leeward ribbon of a stalled band droops
  const windward = tt.find((x) => x.code === 1 && x.face !== p.side), lee = tt.find((x) => x.code === 2 && x.face === p.side);
  assert.ok(windward.d[1] > 0.5 && lee.d[1] < -0.4);
  // port ribbons red, starboard green: the face is ±1 (x side of the sail)
  assert.deepEqual([...new Set(tt.map((x) => x.face))].sort(), [-1, 1]);
  const m = RC.telltales(RC.sailParams('sloop', { id: 'main', hoist: 1, reef: 0, angle: -10, state: 0, tt: 0 }, {}));
  assert.equal(m.length, 3);
  assert.equal(RC.ttBand(0b100100, 0), 0); assert.equal(RC.ttBand(0b100100, 1), 1); assert.equal(RC.ttBand(0b100100, 2), 2);
});

test('furled, lowered and reefed cloth is stowed: roll on the stay, bundle on the boom, topsails along the topmast', () => {
  const half = RC.sailParams('sloop', { id: 'genoa', hoist: 0.5, reef: 0, angle: -20, state: 0, tt: 0 }, {});
  const st = RC.stowedOf(half, null);
  assert.equal(st.kind, 'roll'); assert.ok(st.r > 0.05 && st.r < 0.2);
  assert.ok(Math.abs(RC.sailPoint(half, 1, 0, [0, 0, 0], true)[2] - (-5.35 + 0.5 * 5.35)) < 0.6, 'rolled-in clew moves forward');
  const down = RC.sailParams('sloop', { id: 'main', hoist: 0, reef: 0, angle: -5, state: 5, tt: 0 }, {});
  const boom = RC.boomPose('sloop', 'main', -5);
  assert.equal(RC.stowedOf(down, boom).kind, 'bundle');
  const ts = RC.sailParams('schooner', { id: 'maintop', hoist: 0, reef: 0, angle: -5, state: 5, tt: 0 }, {});
  assert.equal(RC.stowedOf(ts, null).kind, 'roll');
});

test('rig frame from a received rv: booms, gaffs, sheets, runners and halyards are finite; topsails ride on their gaffs', () => {
  for (const cls of CLASSES) {
    const rig = defaultRig(cls, { hoisted: true });
    applyRigCommand(cls, rig, { sails: Object.fromEntries(RIGS[cls].sails.map((s) => [s.id, { hoist: 1 }])) }); settleRig(rig);
    for (const k in rig.sails) { rig.sails[k].side = 1; rig.sails[k].angle = 30; rig.sails[k].state = 0; }
    rig.heel = 12;
    const view = unpackRigView(cls, packRigView(cls, rig));
    assert.ok(view, cls);
    const fr = RC.rigFrame(cls, view, { t: 2, aws: 8 });
    for (const b of [...fr.booms, ...fr.gaffs]) assert.ok(finite3(b.a) && finite3(b.b), `${cls} spar`);
    for (const l of [...fr.sheets, ...fr.runners, ...fr.halyards]) for (const p of l.pts) assert.ok(finite3(p), `${cls} line`);
    assert.ok(fr.sheets.length >= RIGS[cls].sails.length - (cls === 'schooner' ? 2 : 0), `${cls} sheets`);
    assert.equal(fr.side, 1);
    if (cls === 'schooner') {
      const peak = fr.gaffs.find((g) => g.sail === 'fore').b, clew = RC.sailPoint(fr.params.foretop, 1, 0, [0, 0, 0], true);
      assert.ok(Math.hypot(peak[0] - clew[0], peak[1] - clew[1], peak[2] - clew[2]) < 0.8, 'fore topsail clew at the gaff peak');
      // gaff throats on the mast, peaks above the throats
      for (const g of fr.gaffs) assert.ok(g.b[1] > g.a[1] + 3);
    }
    // own-ship view (no network)
    assert.ok(RC.rigFrame(cls, rigViewOf(cls, rig), { t: 0 }));
  }
});

test('standing rigging: finite, no zero-length wires, shrouds both sides, stays where the contract puts them', () => {
  for (const cls of CLASSES) {
    const segs = RC.standingRigging(cls);
    assert.ok(segs.length > 10, cls);
    for (const s of segs) { assert.ok(finite3(s.a) && finite3(s.b)); assert.ok(Math.hypot(s.a[0] - s.b[0], s.a[1] - s.b[1], s.a[2] - s.b[2]) > 0.05, `${cls} ${s.kind}`); }
    const sh = segs.filter((s) => s.kind === 'shroud');
    assert.ok(sh.some((s) => s.a[0] > 0.5) && sh.some((s) => s.a[0] < -0.5), `${cls} shrouds both sides`);
    // every stay end lies on the hull, a spar or the deck: no wire ends in the water ahead of the stem
    for (const s of segs) for (const p of [s.a, s.b]) assert.ok(p[1] > -0.05, `${cls} ${s.kind} end above the water`);
  }
  assert.ok(RC.standingRigging('schooner').filter((s) => s.kind === 'ratline').length > 100, 'ratlines');
  // the split backstay of the sloop lands on the transom, not behind it
  const ext = Y.hullExtent('sloop');
  for (const s of RC.standingRigging('sloop').filter((x) => x.kind === 'backstay')) assert.ok(s.b[2] <= ext.zDeckEnd);
});

test('critically damped spring: no overshoot, converges; crash jibe crosses at 180°/s then hands back', () => {
  const st = { x: -30, v: 0 };
  let max = -Infinity;
  for (let i = 0; i < 200; i++) { RC.springStep(st, 30, 3, 0.02); max = Math.max(max, st.x); }
  assert.ok(max <= 30 + 1e-6 && Math.abs(st.x - 30) < 0.5);
  const big = { x: -30, v: 0 }; RC.springStep(big, 30, 3, 5); assert.ok(Math.abs(big.x - 30) < 1, 'stable for a long dt');
  assert.equal(RC.springOmega('sloop'), 3); assert.equal(RC.springOmega('schooner'), 1.5);
  const cj = { x: -70, v: 0, crash: 1 };
  let n = 0; while (RC.crashStep(cj, 70, 0.05)) n++;
  assert.ok(n >= 14 && n <= 16, `crossed in ${n} steps of 50 ms (≈ 0.78 s at 180°/s)`);
  assert.equal(cj.crash, 0);
});

test('LOD grids (§4.6): own 10 × 14 (gaff 12 × 14), phone 8 × 10, others 6 × 8, far 1 × 1; index buffers match', () => {
  assert.deepEqual(RC.gridFor('own', false, false), [10, 14]);
  assert.deepEqual(RC.gridFor('own', true, false), [12, 14]);
  assert.deepEqual(RC.gridFor('own', false, true), [8, 10]);
  assert.deepEqual(RC.gridFor('near', true, false), [6, 8]);
  assert.deepEqual(RC.gridFor('far', false, false), [1, 1]);
  for (const [nu, nv] of [[10, 14], [1, 1]]) {
    const idx = RC.gridIndex(nu, nv); assert.equal(idx.length, nu * nv * 6);
    assert.ok(Math.max(...idx) === (nu + 1) * (nv + 1) - 1);
  }
  // budget: the schooner's seven sails at the own-ship grid stay well under 14 k triangles
  const tri = RIGS.schooner.sails.reduce((a, s) => { const [nu, nv] = RC.gridFor('own', s.pts.length === 4, false); return a + 2 * nu * nv; }, 0);
  assert.ok(tri < 2500, `sail triangles ${tri}`);
  const p = RC.sailParams('ketch', { id: 'main', hoist: 1, reef: 0, angle: -20, state: 0, tt: 0 }, {});
  const pos = RC.sailGrid(p, 6, 8, new Float32Array(7 * 9 * 3));
  assert.ok(pos.every(Number.isFinite));
});
