// Inland harbours from the recorded world-tile fixtures (test/fixtures/wt: Rotterdam + Hamburg z12 overlays, Rotterdam
// z14 tiles for depth), plus the synthetic FIS harbour fixture (test/fixtures/mh/fis-harbours.json). Exact numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { harboursFromOverlay, berthsOf, harbourCard } from '../shared/mharbour.js';
import { createMinorHarbours, tileDepthSampler } from '../server/minorharbours.js';
import { HARBORS } from '../server/harbors.js';
import { makeSampler } from '../server/quays.js';
import { lowWaterAt } from '../shared/tide.js';
import { loadPoints, loadPortFixture, FIXTURE_DIR } from './fixtures/wt/lib.mjs';

const ov = (port, x, y) => { try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(FIXTURE_DIR, port, `ov-12-${x}-${y}.json.gz`))).toString('utf8')); } catch { return null; } };
const fis = JSON.parse(fs.readFileSync(new URL('./fixtures/mh/fis-harbours.json', import.meta.url)));
const gen = (port, x, y, extra = {}) => harboursFromOverlay(ov(port, x, y), { x12: x, y12: y, named: HARBORS, ...extra });

test('Rotterdam overlays → 3 harbours (2 inferred marinas, 1 tagged passantenhaven), all inside the port limits', () => {
  assert.equal(gen('rotterdam', 2093, 1353).length, 0);      // Maasvlakte: terminals, cranes, tanks, no small-craft berths
  const a = gen('rotterdam', 2094, 1353);
  assert.deepEqual(a.map((h) => [h.id, h.tier, h.e, h.cap, h.pont.length, h.sub?.id, h.sub?.dKm]), [
    ['mh:osm:w1146063942', 'marina', 2, 208, 11, 'rotterdam', 4.7],
    ['mh:osm:w120922130', 'marina', 2, 328, 23, 'rotterdam', 6.4],
  ]);
  assert.deepEqual(a.map((h) => [h.name, h.cc, h.sq]), [['Marina near Rotterdam', 'NL', '2094/1353'], ['Marina near Rotterdam', 'NL', '2094/1353']]);
  const b = gen('rotterdam', 2095, 1354);
  assert.equal(b.length, 1);
  const p = b[0];
  assert.deepEqual([p.id, p.tier, p.e, p.lat, p.lon, p.cap, p.pont.length, p.svc, p.sub.dKm], ['mh:osm:w487069420', 'passant', 1, 51.91536, 4.16967, 33, 5, { visitor: true, water: true }, 12]);
  assert.equal(p.why, 'small craft visitor berth');
  // berths: passant sides, rafting 3 abreast (12 m slots)
  const be = berthsOf(p);
  assert.equal(be.kind, 'side'); assert.equal(be.total, 33);
  assert.deepEqual(be.list.map((x) => x.places), [12, 12, 3, 3, 3]);
  // the marina's boxes: 'large' (≈ 509 m of pontoon) → 10/12/15/20 m boxes, the longest pontoons get the biggest
  const m = berthsOf(a[0]);
  assert.deepEqual(m.sizes, [{ len: 10, w: 3.5, n: 28 }, { len: 12, w: 4, n: 40 }, { len: 15, w: 4.5, n: 52 }, { len: 20, w: 5.5, n: 88 }]);
  assert.equal(m.total, 208);
});

test('Hamburg overlays → 8 marinas; the tagged one keeps its OSM name; abroad → simulated ch 9', () => {
  const a = gen('hamburg', 2160, 1323), b = gen('hamburg', 2160, 1324);
  assert.deepEqual([a.length, b.length], [3, 5]);
  const tagged = b.find((h) => h.id === 'mh:osm:w158942988');
  assert.deepEqual([tagged.name, tagged.tier, tagged.e, tagged.cap, tagged.cc, tagged.sub.id], ['Anleger Yachtschule Eichler', 'marina', 1, 194, null, 'hamburg']);
  assert.equal(b.filter((h) => h.e === 2).length, 4);
  const card = harbourCard(tagged, {});
  assert.equal(card.vhf.text, 'Harbour master ch 9 (simulated)');
  assert.equal(card.tierLabel, 'Marina');
  // museum hulks and ferry landings never make a marina
  for (const h of [...a, ...b]) assert.ok(!h.osm.some((id) => ['w166381764', 'w166381765', 'w231306946'].includes(id)));
});

test('FIS fixture merges into the Rotterdam passantenhaven (≤ 150 m) and adds a FIS-only marina', () => {
  const hs = gen('rotterdam', 2095, 1354, { fis: fis.harbours });
  assert.deepEqual(hs.map((h) => [h.id, h.tier, h.src, h.cap]), [
    ['mh:fis:9001', 'passant', 'fis+osm', 14],
    ['mh:fis:9002', 'marina', 'fis', 85],
  ]);
  const m = hs[0];
  assert.deepEqual([m.name, m.was, m.maxL, m.depth, m.depthSrc], ['Passantenhaven Rozenburg (synthetic)', 'mh:osm:w487069420', 15, 2.2, 'FIS']);
  assert.equal(hs[1].svc.fuel, true);
});

test('card on demand: Rotterdam tiles give 0.9 m at the passant (shallower than the default → 1.8 m est.)', () => {
  const { ports } = loadPoints();
  const fx = loadPortFixture(FIXTURE_DIR, ports.find((p) => p.id === 'rotterdam'));
  const sample = makeSampler((z, x, y) => fx.tiles.get(`${x}/${y}`) || null);
  const depthAt = tileDepthSampler(sample, lowWaterAt);
  assert.equal(depthAt(51.91536, 4.16967), 0.9);
  assert.equal(depthAt(51.97, 4.12), null);                     // tile not recorded
  const mh = createMinorHarbours({ named: HARBORS, readOverlay: async (x, y) => ov('rotterdam', x, y), sampleDepth: depthAt });
  mh.ingest(2095, 1354, ov('rotterdam', 2095, 1354));
  const c = mh.sheet('mh:osm:w487069420', { cls: 'sloop' });
  assert.deepEqual(c.depth, { m: 1.8, src: 'est.', text: '1.8 m (est.)' });
  // §3.6 default passantenhaven depth 1.8 m is conservative: the 1.9 m sloop (needs 2.0) is refused, a 1.1 m cruiser lies there
  assert.equal(c.fit.text, 'No berth for you: 1.8 m (est.) in the harbour; you need 2 m');
  assert.equal(mh.sheet('mh:osm:w487069420', { cls: 'cruiser' }).fit.text, '33 of 33 berths take you');
  assert.equal(mh.sheet('mh:osm:w487069420', { cls: 'cruiser' }).fee.text, '14 cr per night (1.2 cr per metre)');
});
