// v6 fleet, Lane B: the client's formatting helpers (public/js/fleetfmt.js) and the shared rules the UI relies on
// (docs/V6-FLEET-CONTRACTS.md §12.1, §14.1 fleet-client), plus the fixture the client is built against.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fmtPos, fmtEta, fitBounds, decimate, fmtTask, stateLabel, chipClass, fmtSigned, fmtDur, fmtCost, etaEstimate, shortName } from '../public/js/fleetfmt.js';
import { destination } from '../shared/geo.js';
import { transferFee, stateOf, STATES } from '../shared/fleet.js';

const HARBORS = [{ id: 'ijmuiden', name: 'IJmuiden / Amsterdam', lat: 52.465, lon: 4.555 }, { id: 'rotterdam', name: 'Rotterdam (Maasvlakte)', lat: 51.98, lon: 4.03 }];

test('fmtPos: moored, laid up, and at sea relative to the nearest harbour', () => {
  assert.equal(fmtPos({ state: 'docked', harbor: 'rotterdam', harborName: 'Rotterdam (Maasvlakte)', berthName: 'Waalhaven 3' }, HARBORS), 'Moored at Rotterdam, Waalhaven 3');
  assert.equal(fmtPos({ state: 'laid_up', status: 'laidup', harbor: 'rotterdam', harborName: 'Rotterdam (Maasvlakte)' }, HARBORS), 'Laid up at Rotterdam');
  const at = destination(52.465, 4.555, 45, 112000);
  assert.equal(fmtPos({ state: 'at_sea', lat: at.lat, lon: at.lon }, HARBORS), '112 km NE of IJmuiden');
  const near = destination(52.465, 4.555, 270, 3100);
  assert.equal(fmtPos({ state: 'anchored', lat: near.lat, lon: near.lon }, HARBORS), '3.1 km W of IJmuiden');
  assert.equal(shortName('IJmuiden / Amsterdam'), 'IJmuiden');
});

test('fmtEta: today → 14:20 UTC, another day → Thu 14:20 UTC, none → —', () => {
  const now = Date.UTC(2026, 9, 8, 9, 0) / 1000;          // Thu 8 Oct 2026
  assert.equal(fmtEta(Date.UTC(2026, 9, 8, 14, 20) / 1000, now), '14:20 UTC');
  assert.equal(fmtEta(Date.UTC(2026, 9, 15, 14, 20) / 1000, now), 'Thu 14:20 UTC');
  assert.equal(fmtEta(null, now), '—');
  assert.equal(fmtTask({ task: { text: 'Freight 400 t of Grain to Hamburg', etaS: Date.UTC(2026, 9, 9, 14, 20) / 1000, phase: 'sailing', leftKm: 412 } }, now), 'Freight 400 t of Grain to Hamburg · ETA Fri 14:20 UTC · 412 km to go');
});

test('fitBounds: one ship → at least 2° each way; padding; decimate keeps both ends', () => {
  const b = fitBounds([[54.2, 3.05]]);
  assert.ok(b.latMax - b.latMin >= 2 - 1e-9 && b.lonMax - b.lonMin >= 2 - 1e-9);
  assert.ok(b.latMin < 54.2 && b.latMax > 54.2);
  const w = fitBounds([{ lat: 50, lon: 0 }, { lat: 60, lon: 10 }]);
  assert.ok(Math.abs(w.latMax - w.latMin - 13) < 1e-9, 'padding 15 % each side');
  const r = Array.from({ length: 101 }, (_, i) => [i, i]);
  const d = decimate(r, 40);
  assert.equal(d.length, 40); assert.deepEqual(d[0], [0, 0]); assert.deepEqual(d.at(-1), [100, 100]);
  assert.deepEqual(decimate([[1, 1]], 40), [[1, 1]]);
});

test('labels, money and durations', () => {
  assert.deepEqual(STATES.map(stateLabel), ['Laid up', 'Moored', 'At sea', 'At anchor']);
  assert.ok(STATES.every((s) => chipClass(s).startsWith('st-')));
  assert.equal(fmtSigned(31400), '+31,400 cr'); assert.equal(fmtSigned(-930), '−930 cr'); assert.equal(fmtSigned(0), '0 cr');
  assert.equal(fmtDur(6 * 3600 + 600), '6 h 10 m'); assert.equal(fmtDur(1500), '25 min'); assert.equal(fmtDur(3 * 86400 + 7200), '3 d 2 h');
  assert.equal(fmtCost({ kind: 'wages', crPerH: 55 }), 'now 55 cr/h'); assert.equal(fmtCost({ kind: 'storage', crPerDay: 32 }), 'storage 32 cr/day');
  const e = etaEstimate(51.98, 4.03, 53.54, 9.93, 11.2); assert.ok(e.km > 500 && e.h > 20);
  assert.equal(transferFee(150000), 550); assert.equal(stateOf({ status: 'active', docked: null, cap: { phase: 'holding' } }), 'anchored');
});

test('the fixture the client is built against has every field the HQ reads', () => {
  const f = JSON.parse(fs.readFileSync(new URL('../docs/fixtures/fleet.sample.json', import.meta.url), 'utf8'));
  assert.ok(f.you && f.fleet && f.harbor && Array.isArray(f.snapFleet) && f.board && Array.isArray(f.harbors));
  for (const v of f.fleet.vessels) { assert.ok(typeof fmtPos(v, f.harbors) === 'string' && fmtPos(v, f.harbors).length > 3); assert.ok(typeof fmtTask(v, f.simTime) === 'string'); }
  assert.equal(f.fleet.money.days.length, 7);
});
