// Lane D against Lane A's real catalogue (shared/ships/index.js) when it is present: the §9 cargo-compat cases, the
// fields Lane D reads, and the fit guarantee for a spread of new models. Skipped while Lane A is not merged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actor, seeded, ctxBase, T0 } from './jobs2-helpers.mjs';
import { setShipSource, shipSource, modelOf } from '../shared/jobs/shipview.js';
import { harborById } from '../server/harbors.js';

let A = null;
try { A = await import('../shared/ships/index.js'); } catch { A = null; }
const skip = !A || typeof A.modelOf !== 'function';

test('Lane A catalogue: fields Lane D reads', { skip }, () => {
  setShipSource(null);
  assert.ok(shipSource(), 'catalogue loaded');
  for (const id of Object.keys(A.MODELS)) {
    const m = modelOf(id);
    assert.ok(m && typeof m.type === 'string', id);
    assert.ok(Array.isArray(m.handling), `${id} handling`);
    assert.ok(m.units && typeof m.units === 'object', `${id} units`);
    assert.ok(Array.isArray(m.eq), `${id} eq`);
    for (const h of m.handling) assert.ok(['box', 'bulk', 'breakbulk', 'heavy', 'liquid:clean', 'liquid:crude', 'liquid:chem', 'gas:lpg', 'gas:lng', 'roro', 'reefer', 'livestock', 'fish', 'deck', 'hopper', 'pax'].includes(h), `${id}: ${h}`);
  }
});

test('Lane A catalogue: §9 cargo-compat cases', { skip }, async () => {
  setShipSource(null);
  const { canLoad, toTonnes } = await import('../shared/cargo.js');
  assert.equal(canLoad('grain', 'boxship').why.code, 'handling');
  assert.equal(canLoad('containers', 'boxship').ok, true);
  assert.equal(canLoad('crude', 'mr50').ok, false);
  assert.equal(canLoad('crude', 'aframax115').ok, true);
  assert.equal(canLoad('lng', 'vlgc86k').ok, false);
  assert.equal(canLoad('vehicles', 'pctc7000').ok, true);
  for (const id of Object.keys(A.MODELS)) if (canLoad('livestock', id).ok) assert.equal(id, 'livestock135');
  assert.equal(canLoad('fuel', 'coaster').ok, false);
  assert.equal(toTonnes('lng', 174000), 78300);
  const { tcHirePerH } = await import('../shared/jobs/catalogue.js');
  assert.equal(tcHirePerH('ultramax64'), 17375);
});

test('Lane A catalogue: fit guarantee for new models', { skip }, async () => {
  setShipSource(null);
  const { generateBoard, ensureFit } = await import('../server/jobsgen.js');
  const { canDo } = await import('../shared/jobs/eligibility.js');
  const cases = [['pctc7000', 'rotterdam'], ['vlcc300', 'ras_tanura'], ['ultramax64', 'santos'], ['feeder1700', 'hamburg'], ['tug24', 'rotterdam'],
    ['ctv26', 'esbjerg'], ['bunker85', 'singapore'], ['ropax200', 'dover'], ['giga100', 'southampton'], ['sloop', 'palma'], ['seiner75', 'peterhead']];
  for (const [cls, hid] of cases) {
    if (!A.MODELS[cls]) continue;
    const h = harborById(hid), rnd = seeded(cls.length * 7 + hid.length);
    const board = generateBoard(h, T0, rnd), v = actor(cls, hid), ctx = ctxBase(T0);
    ensureFit(board, h, v, ctx, T0, rnd);
    const ok = board.filter((j) => canDo(j, v, ctx).ok).length;
    assert.ok(ok >= 3, `${cls} at ${hid}: ${ok}`);
  }
});
