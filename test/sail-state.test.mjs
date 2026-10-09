// Lane A — the frozen rig interface: rigs.js data, state.js (rig state, commands, rv) — docs/SAILING-CONTRACT.md §6.4 A-1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RIGS, SAIL_TYPES, rigOf, sailIds, sailArea } from '../shared/sail/rigs.js';
import { RIG_SCHEMA, AUTO, defaultRig, ensureRig, normalizeRig, anyHoisted, applyRigCommand, applyPlan, packRigView, unpackRigView, rigViewOf } from '../shared/sail/state.js';
import { SHIP_CLASSES } from '../shared/constants.js';

const IDS = {
  sloop: ['genoa', 'main'],
  ketch: ['yankee', 'stay', 'main', 'mizzen'],
  catamaran: ['code0', 'jib', 'main'],
  schooner: ['flyjib', 'jib', 'stay', 'fore', 'foretop', 'main', 'maintop'],
};
const AREAS = { sloop: { genoa: 35.1, main: 32.3 }, ketch: { yankee: 34.3, stay: 23.7, main: 42.9, mizzen: 18.2 }, catamaran: { code0: 71.8, jib: 33.0, main: 72.0 },
  schooner: { flyjib: 45.8, jib: 70.6, stay: 43.9, fore: 118.8, foretop: 27.8, main: 219.4, maintop: 51.6 } };

test('RIGS covers exactly the sail classes of constants.js, in §2.4 order, with the §2.4 areas', () => {
  const sailCls = Object.keys(SHIP_CLASSES).filter((c) => SHIP_CLASSES[c].sail).sort();
  assert.deepEqual(Object.keys(RIGS).sort(), sailCls);
  for (const [cls, ids] of Object.entries(IDS)) {
    assert.deepEqual(sailIds(cls), ids, cls);
    for (const id of ids) assert.ok(Math.abs(sailArea(cls, id) - AREAS[cls][id]) < 0.06, `${cls} ${id} ${sailArea(cls, id)}`);
    assert.equal(RIGS[cls].turn, SHIP_CLASSES[cls].turnRate, `${cls} turn = C.turnRate`);
    assert.equal(RIGS[cls].loa, SHIP_CLASSES[cls].length);
  }
  assert.equal(rigOf('coaster'), null); assert.equal(rigOf('__proto__'), null); assert.deepEqual(sailIds('tug'), []);
  assert.deepEqual(Object.keys(SAIL_TYPES).sort(), ['code0', 'gaff', 'genoa', 'jib', 'main', 'mizzen', 'stay', 'topsail']);
  assert.ok(Math.abs(sailArea('sloop', 'main', 1, 2) - 32.3 * 0.58) < 0.05);
  assert.ok(Math.abs(sailArea('sloop', 'genoa', 0.5) - 35.1 / 2) < 0.05);
  // spars: one mast per masted rig (§2.4) and the catamaran mast where the deck plan has it
  assert.equal(RIGS.schooner.spars.masts.length, 2); assert.equal(RIGS.ketch.spars.masts.length, 2);
  assert.equal(RIGS.catamaran.spars.masts[0].z, -2.7);
});

test('defaultRig has the §2.4 sail ids in order, schema 1, helper hint; engine classes get none', () => {
  for (const [cls, ids] of Object.entries(IDS)) {
    const r = defaultRig(cls);
    assert.equal(r.v, RIG_SCHEMA); assert.equal(r.cls, cls); assert.equal(r.auto, 'hint');
    assert.deepEqual(Object.keys(r.sails), ids);
    assert.equal(anyHoisted(r), false);
    const up = defaultRig(cls, { hoisted: true });
    assert.equal(anyHoisted(up), true);
    for (const s of RIGS[cls].sails) assert.equal(up.sails[s.id].hoist, s.light ? 0 : 1, `${cls} ${s.id}`);
    assert.equal(JSON.parse(JSON.stringify(up)).sails[ids[0]].side, up.sails[ids[0]].side);
  }
  assert.equal(defaultRig('coaster'), null);
  assert.deepEqual(AUTO, ['off', 'hint', 'full']);
});

test('normalizeRig repairs NaN, out-of-range values and unknown sails; newer schema → default; never throws', () => {
  const r = defaultRig('sloop', { hoisted: true });
  r.sails.main.sheet = NaN; r.sails.main.reef = 7; r.sails.genoa.hoist = 3; r.sails.main.trav = -9; r.heel = Infinity;
  r.sails.bogus = { hoist: 1 }; r.auto = 'turbo'; r.sails.main.job = 'dance'; r.sails.main.side = 0;
  const n = normalizeRig('sloop', r, true);
  assert.equal(n.sails.main.sheet, 0.3); assert.equal(n.sails.main.reef, 2); assert.equal(n.sails.genoa.hoist, 1);
  assert.equal(n.sails.main.trav, -1); assert.equal(n.heel, 0); assert.equal(n.auto, 'hint'); assert.equal(n.sails.main.job, null);
  assert.equal(n.sails.main.side, -1); assert.equal(n.sails.bogus, undefined);
  assert.deepEqual(Object.keys(n.sails), IDS.sloop);
  const missing = normalizeRig('ketch', { v: 1, cls: 'ketch', sails: { main: { hoist: 1, hoistCmd: 1 } } }, true);
  assert.equal(missing.sails.main.hoist, 1); assert.equal(missing.sails.yankee.hoist, 0);
  const newer = normalizeRig('sloop', { v: 2, cls: 'sloop', sails: {} }, false);
  assert.equal(newer.v, 1); assert.equal(anyHoisted(newer), false);
  for (const junk of [null, 5, 'x', [], { v: 1, cls: 'sloop', sails: 7 }, { v: 1, cls: 'sloop', sails: { main: null } }]) assert.doesNotThrow(() => normalizeRig('sloop', junk, true));
  assert.equal(normalizeRig('coaster', r, true), null);
});

test('ensureRig: old vessel at sea with sailsUp → working sails set; docked → all down; class change → new rig; engine class → deleted', () => {
  const atSea = { cls: 'ketch', lat: 50, lon: 0 };
  const r = ensureRig(atSea, true);
  assert.equal(r, atSea.rig); assert.equal(anyHoisted(r), true); assert.equal(r.sails.main.hoist, 1); assert.equal(r.auto, 'hint');
  const docked = { cls: 'schooner' };
  assert.equal(anyHoisted(ensureRig(docked, false)), false);
  const undef = { cls: 'sloop' }; assert.equal(anyHoisted(ensureRig(undef, undefined)), true, 'legacy: sailsUp undefined = sails up');
  const same = ensureRig(atSea, false); assert.equal(same, r, 'a healthy rig is kept');
  atSea.cls = 'sloop';
  const r2 = ensureRig(atSea, false);
  assert.equal(r2.cls, 'sloop'); assert.deepEqual(Object.keys(r2.sails), IDS.sloop);
  atSea.cls = 'coaster';
  assert.equal(ensureRig(atSea, true), null); assert.equal('rig' in atSea, false);
});

test('applyRigCommand validates and clamps; commands set *Cmd only', () => {
  const r = defaultRig('sloop', { hoisted: true });
  assert.deepEqual(applyRigCommand('sloop', r, { sails: { main: { sheet: 1.7, reef: 5 } } }), { ok: true });
  assert.equal(r.sails.main.sheetCmd, 1); assert.equal(r.sails.main.reefCmd, 2); assert.equal(r.sails.main.sheet, 0.3); assert.equal(r.sails.main.reef, 0);
  assert.deepEqual(applyRigCommand('sloop', r, { sails: { main: { hoist: 0.4 } } }), { ok: true });
  assert.equal(r.sails.main.hoistCmd, 0, 'non-furler hoist rounds to 0/1');
  applyRigCommand('sloop', r, { sails: { genoa: { hoist: 0.4, reef: 1, trav: 1 } } });
  assert.equal(r.sails.genoa.hoistCmd, 0.4, 'roller: any fraction'); assert.equal(r.sails.genoa.reefCmd, 0, 'no reefs: only 0'); assert.equal(r.sails.genoa.travCmd, 0);
  applyRigCommand('sloop', r, { sails: { main: { trav: -3 } } }); assert.equal(r.sails.main.travCmd, -1);
  assert.deepEqual(applyRigCommand('sloop', r, { sails: { mizzen: { sheet: 0.5 } } }), { ok: false, why: 'No such sail.' });
  assert.equal(applyRigCommand('sloop', r, { sails: { main: { sheet: NaN } } }).ok, false);
  assert.equal(applyRigCommand('sloop', r, { sails: { main: { sheet: '0.5' } } }).ok, false);
  assert.equal(applyRigCommand('sloop', r, { auto: 'turbo' }).ok, false);
  assert.equal(applyRigCommand('sloop', r, { plan: 4 }).ok, false);
  assert.equal(applyRigCommand('coaster', r, { all: 'set' }).ok, false);
  assert.equal(applyRigCommand('sloop', r, null).ok, false);
  assert.deepEqual(applyRigCommand('sloop', r, { auto: 'full', maneuver: 'jibe' }), { ok: true });
  assert.equal(r.auto, 'full'); assert.equal(r.man, 'jibe');
  applyRigCommand('sloop', r, { all: 'furl' }); assert.equal(anyHoisted({ sails: { a: { hoist: 0, hoistCmd: r.sails.main.hoistCmd } } }), false);
  for (const id of IDS.sloop) assert.equal(r.sails[id].hoistCmd, 0);
  applyRigCommand('sloop', r, { all: 'set' }); assert.equal(r.sails.main.hoistCmd, 1); assert.equal(r.sails.genoa.hoistCmd, 1); assert.equal(r.sails.main.reefCmd, 0);
  // light sails can be hoisted by hand at any wind
  const c = defaultRig('catamaran', { hoisted: true });
  assert.deepEqual(applyRigCommand('catamaran', c, { sails: { code0: { hoist: 1 } } }), { ok: true }); assert.equal(c.sails.code0.hoistCmd, 1);
});

test('applyPlan sets the crew preset (Appendix A planState)', () => {
  const r = defaultRig('sloop', { hoisted: true });
  applyPlan('sloop', r, 2); assert.equal(r.lv, 2); assert.equal(r.sails.main.reefCmd, 2); assert.ok(Math.abs(r.sails.genoa.hoistCmd - 0.5) < 1e-9);
  const k = defaultRig('ketch', { hoisted: true }); applyPlan('ketch', k, 3);
  assert.equal(k.sails.main.hoistCmd, 0); assert.equal(k.sails.yankee.hoistCmd, 0); assert.equal(k.sails.stay.hoistCmd, 1); assert.equal(k.sails.mizzen.reefCmd, 1);
  const c = defaultRig('catamaran'); applyPlan('catamaran', c, 0);
  assert.equal(c.sails.code0.hoistCmd, 1); assert.equal(c.sails.jib.hoistCmd, 0); assert.equal(c.sails.main.hoistCmd, 1);
  const s = defaultRig('schooner', { hoisted: true }); applyPlan('schooner', s, 0);
  // Appendix A planState: light sails only when the plan sets them — the schooner's L0 `set: {}` leaves the flying jib
  // and topsails down (the §2.12 numbers were made that way; see docs/SAILING-PHASE2.md "contract notes")
  for (const id of IDS.schooner) assert.equal(s.sails[id].hoistCmd, RIGS.schooner.byId[id].light ? 0 : 1, `schooner L0 (${id})`);
});

test('packRigView / unpackRigView round-trip for all four classes (sloop 11 ints, schooner 36); bad rv → null', () => {
  for (const cls of Object.keys(IDS)) {
    const r = defaultRig(cls, { hoisted: true });
    r.heel = -18.26; const id0 = IDS[cls][IDS[cls].length - 1];
    r.sails[id0].angle = 33.4; r.sails[id0].tt = 2 | (1 << 2) | (2 << 4); r.sails[id0].state = 3; r.sails[id0].reef = Math.min(1, RIGS[cls].byId[id0].reefs.length);
    const rv = packRigView(cls, r);
    assert.equal(rv.length, 1 + 5 * IDS[cls].length);
    assert.ok(rv.every(Number.isInteger));
    const v = unpackRigView(cls, rv);
    assert.equal(v.heel, -18.3);
    assert.deepEqual(v.sails.map((x) => x.id), IDS[cls]);
    const own = rigViewOf(cls, r);
    for (let i = 0; i < own.sails.length; i++) {
      const a = own.sails[i], b = v.sails[i];
      assert.equal(b.hoist, Math.round(a.hoist * 100) / 100); assert.equal(b.reef, a.reef); assert.equal(b.angle, Math.round(a.angle)); assert.equal(b.state, a.state); assert.equal(b.tt, a.tt);
    }
  }
  assert.equal(packRigView('sloop', defaultRig('sloop')).length, 11);
  assert.equal(packRigView('schooner', defaultRig('schooner')).length, 36);
  const good = packRigView('sloop', defaultRig('sloop'));
  assert.equal(unpackRigView('sloop', good.slice(1)), null);
  assert.equal(unpackRigView('sloop', [...good.slice(0, 3), 1.5, ...good.slice(4)]), null);
  assert.equal(unpackRigView('sloop', [900, ...good.slice(1)]), null);
  const badAngle = good.slice(); badAngle[3] = 101; assert.equal(unpackRigView('sloop', badAngle), null);
  const badTt = good.slice(); badTt[5] = 64; assert.equal(unpackRigView('sloop', badTt), null);
  assert.equal(unpackRigView('ketch', good), null);
  assert.equal(unpackRigView('coaster', good), null);
  assert.equal(unpackRigView('sloop', 'x'), null);
});
