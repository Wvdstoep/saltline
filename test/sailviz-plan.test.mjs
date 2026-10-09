// Sailing yachts — deck plans (docs/SAILING-CONTRACT.md §4.5, §6.4 B-2): the walker can circle every mast on both sides,
// the helm is reachable, the schooner's walk-in doghouse sits at z +4.4…+9.6 with the companion stairs inside it, no
// mast solid stands inside a room, the plan's deck follows the model's freeboard. These check public/js/shipplan.js
// AFTER the phase-2 edits (docs/SAILING-LANEB-PHASE2.md, SP1–SP11); until then they skip by themselves.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildPlan } from '../public/js/shipplan.js';
import { WalkMap } from '../public/js/walker.js';
import { SHIP_CLASSES } from '../shared/constants.js';
import { RIGS } from '../shared/sail/rigs.js';
import { yachtDims } from '../public/js/yachtlooks.js';

const wired = fs.readFileSync(new URL('../public/js/shipplan.js', import.meta.url), 'utf8').includes('./yachtlooks.js');
const opt = wired ? {} : { skip: 'needs wiring (phase 2: docs/SAILING-LANEB-PHASE2.md SP1–SP11)' };
const CLASSES = Object.keys(RIGS);

test('yacht deck plans follow the model: deck height = the §4.2 freeboard, cabins below the waterline', opt, () => {
  for (const cls of CLASSES) {
    const p = buildPlan(cls, SHIP_CLASSES[cls]);
    assert.ok(Math.abs(p.deckY - (yachtDims(cls).freeboard + 0.05)) < 0.01, `${cls} deck ${p.deckY}`);
    const below = p.rooms.filter((r) => !r.open && r.y < p.deckY - 1);
    assert.ok(below.length && below.every((r) => r.y < 0.1 && r.h >= 1.9), `${cls}: cabins below the waterline with 1.9 m headroom`);
  }
});

test('the walker can circle every mast (both sides), masts are solids at the rig\'s z, never inside a room', opt, () => {
  for (const cls of CLASSES) {
    const p = buildPlan(cls, SHIP_CLASSES[cls]), m = new WalkMap(p);
    for (const mast of RIGS[cls].spars.masts) {
      const s = p.solids.find((q) => q.tag === 'mast' && Math.abs((q.z0 + q.z1) / 2 - mast.z) < 0.05);
      assert.ok(s, `${cls} ${mast.id}: no mast solid at z ${mast.z}`);
      assert.ok(s.x1 - s.x0 >= mast.d0 + 0.29, `${cls} ${mast.id}: solid radius ≥ mast + 0.15`);
      for (const r of p.rooms) if (!r.open && r.y >= p.deckY - 0.1) assert.ok(!(mast.z > r.z0 && mast.z < r.z1 && r.x0 < 0 && r.x1 > 0), `${cls} ${mast.id} inside ${r.id}`);
      if (mast.onRoof) continue;                              // the sloop's mast stands on the coachroof: walk round the coachroof
      // standable points on both sides abeam of the mast and fore and aft of it
      const y = p.deckY, ok = (x, z) => m.standAt(x, z, y, 0.4) != null;
      const side = (sd) => { for (let x = 0.5; x < 3.5; x += 0.1) if (ok(sd * x, mast.z)) return true; return false; };
      assert.ok(side(1) && side(-1), `${cls} ${mast.id}: no walkway beside the mast`);
      const fa = (dz, x0, x1) => { for (let x = x0; x <= x1; x += 0.1) if (ok(x, mast.z + dz)) return true; return false; };
      assert.ok(fa(-0.9, -1, 1), `${cls} ${mast.id}: not walkable forward of the mast`);
      // aft: behind the mast, or (a coachroof right behind it) along both side decks — either way the walker gets round
      assert.ok(fa(0.9, -1, 1) || (fa(0.9, 0.6, 3.5) && fa(0.9, -3.5, -0.6)), `${cls} ${mast.id}: no way aft past the mast`);
    }
    assert.ok(p.helm && m.standAt(p.helm.x, p.helm.z, p.helm.y, 0.5) != null, `${cls}: helm not standable`);
  }
});

test('the schooner\'s walk-in doghouse is at z +4.4…+9.6 with the companion stairs inside; the mainmast is outside it', opt, () => {
  const p = buildPlan('schooner', SHIP_CLASSES.schooner);
  const d = p.rooms.find((r) => r.id === 'doghouse');
  assert.ok(d && Math.abs(d.z0 - 4.4) < 0.15 && Math.abs(d.z1 - 9.6) < 0.15, `doghouse ${d && d.z0}…${d && d.z1}`);
  const st = p.stairs.find((s) => s.id === 'companionway');
  assert.ok(st.z0 >= d.z0 && st.z1 <= d.z1 && st.head === 'doghouse');
  for (const mast of RIGS.schooner.spars.masts) assert.ok(mast.z < d.z0 - 1 || mast.z > d.z1 + 1, `${mast.id} clear of the doghouse`);
  // the forward deckhouse is a solid the walker goes round
  assert.ok(p.solids.some((s) => s.tag === 'house' && s.z0 <= -4.5 && s.z1 >= -0.9));
});
