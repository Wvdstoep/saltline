// docs/BRIDGES-LOCKS-VHF-CONTRACT.md §10.1 — air draught from loading, containers, folding, rigs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { profileOf, draughtNow, deckTiers, airDraftNow, canFold, ballastStep, ballastTime, airPublic, AD_MARGIN } from '../shared/airdraft.js';
import { passVerdict } from '../shared/waterworks.js';
import { MODELS } from '../shared/ships/catalogue.js';

const near = (a, b, eps = 0.001) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const DOWN = { wheelhouse: 1 };
const fixed9 = { id: 't:9', datum: 'KP', kp: 0, p: [52, 5], spans: [{ id: 0, a: 0, b: 30, mov: 'fixed', clr: 9.0, clrO: null, w: 30, rec: 1 }] };
const bascule9 = { ...fixed9, id: 't:9b', spans: [{ ...fixed9.spans[0], mov: 'bascule', clrO: Infinity }] };

test('coaster profile: DWmax 1306 (1200 + 80 + 26 stores)', () => {
  const p = profileOf('coaster');
  assert.equal(p.stores, 26); assert.equal(p.DWmax, 1306); assert.equal(p.kTop, 11.6); assert.equal(p.up.wheelhouse, 7.4);
});

test('1. coaster empty, no ballast, wheelhouse down: T 2.652, ad 8.948 → never under a fixed 9.0 m, opening at a bascule', () => {
  near(draughtNow('coaster', {}), 2.652, 0.0005);
  const a = airDraftNow('coaster', { fold: DOWN });
  near(a.ad, 8.948); near(a.need(0), 9.248);
  assert.equal(passVerdict(a, fixed9, 0, { h: 0 }).verdict, 'never');
  assert.equal(passVerdict(a, bascule9, 0, { h: 0 }).verdict, 'opening');
});

test('2. coaster in ballast 600 t: T 4.076, ad 7.524 → under a 9.0 m bridge, margin 1.18 m (green)', () => {
  const a = airDraftNow('coaster', { ballastT: 600, fold: DOWN });
  near(a.T, 4.076); near(a.ad, 7.524);
  const v = passVerdict(a, fixed9, 0, { h: 0 });
  assert.equal(v.verdict, 'under'); near(v.clrNow - v.need, 1.176, 0.002);
});

test('3. coaster 720 t containers (60 TEU: 36 hold + 24 deck = 2 tiers): stack 14.08, ad 9.719 → not under', () => {
  assert.equal(deckTiers('coaster', 720), 2);
  const a = airDraftNow('coaster', { cargo: [{ good: 'containers', qty: 720 }], fold: DOWN });
  near(a.T, 4.361); near(a.stackTop, 14.08); near(a.ad, 9.719);
  near(a.need(0), 10.019);
  assert.equal(passVerdict(a, fixed9, 0, { h: 0 }).verdict, 'never');
});

test('4. coaster 576 t containers (48 TEU, 1 deck tier): stack 11.49 < 11.6, ad 7.581 → under', () => {
  assert.equal(deckTiers('coaster', 576), 1);
  const a = airDraftNow('coaster', { cargo: { containers: 576 }, fold: DOWN });
  near(a.stackTop, 11.49); near(a.ad, 7.581);
  assert.equal(passVerdict(a, fixed9, 0, { h: 0 }).verdict, 'under');
});

test('5. coaster wheelhouse up, ballast 600: ad 14.924', () => {
  near(airDraftNow('coaster', { ballastT: 600 }).ad, 14.924);
  near(airDraftNow('coaster', { ballastT: 600, fold: {} }).kTop, 19.0);
});

test('6. sailing yachts: masthead + 0.8 at any load (sloop 17.0, ketch 19.65, catamaran 23.0, schooner 34.0)', () => {
  for (const [id, ad] of [['sloop', 17.0], ['ketch', 19.65], ['catamaran', 23.0], ['schooner', 34.0]]) {
    near(airDraftNow(id, {}).ad, ad);
    near(airDraftNow(id, { cargo: 0.5, fuelT: 0 }).ad, ad);
  }
  near(airDraftNow('schooner', {}).need(0), 34.3);
});

test('explicit motor rows: cruiser 2.9/3.6, flybridge 4.4/5.6, myacht 6.0/7.5, pilot 6.0, tug 15.0–15.4', () => {
  near(airDraftNow('cruiser', { fold: { arch: 1 } }).ad, 2.9); near(airDraftNow('cruiser', {}).ad, 3.6);
  near(airDraftNow('flybridge18', { fold: { arch: 1 } }).ad, 4.4); near(airDraftNow('flybridge18', {}).ad, 5.6);
  near(airDraftNow('myacht', { fold: { mast: 1 } }).ad, 6.0); near(airDraftNow('myacht', {}).ad, 7.5);
  near(airDraftNow('pilot', {}).ad, 6.0);
  const tug = airDraftNow('tug', {}).ad; assert.ok(tug >= 15.0 && tug <= 15.4, String(tug));
});

test('7. fold refused with 2 deck tiers (stack 14.08 > eye 10.1 + 1.0); refused with 1 tier too (11.49 > 11.1), allowed empty; masts of sailing yachts never fold', () => {
  const r = canFold('coaster', 'wheelhouse', true, { cargo: { containers: 720 } });
  assert.equal(r.ok, false); assert.match(r.why, /Raise the wheelhouse/);
  assert.equal(canFold('coaster', 'wheelhouse', true, { cargo: { containers: 576 } }).ok, false);
  assert.equal(canFold('coaster', 'wheelhouse', true, { cargo: { grain: 900 } }).ok, true);
  assert.equal(canFold('coaster', 'wheelhouse', false, { cargo: { containers: 720 } }).ok, true);
  assert.equal(canFold('coaster', 'wheelhouse', true, { sogKn: 9 }).ok, false);
  assert.equal(canFold('sloop', 'mast', true).ok, false);
  assert.equal(canFold('coaster', 'wheelhouse', true).time, 120);
});

test('8. derived profiles keep the catalogue airDraft stat at design draught (bulker, feeder1000, …)', () => {
  for (const id of ['bulker', 'feeder1000', 'panamax4500', 'gc120', 'tanker', 'trawler']) {
    const p = profileOf(id), m = MODELS[id];
    const a = airDraftNow(id, { cargo: p.capacity, fuelT: p.fuelCap });
    near(a.T, m.draft, 0.01); near(a.ad, m.airDraft, 0.01);
  }
  assert.equal(profileOf('bulker').ballastMax, Math.round(35000 * 0.45));
});

test('9. ballast pumping: coaster 0 → 600 t at 150 t/h takes 4.0 h of ship time; ×20 warp = 12 real minutes', () => {
  assert.equal(ballastTime('coaster', 0, 600), 4 * 3600);
  let b = 0, realS = 0;
  while (b < 600 - 1e-9 && realS < 3600) { b = ballastStep('coaster', b, 600, 1 * 20); realS += 1; }
  near(b, 600, 1e-6); assert.equal(realS, 12 * 60);
  // never above the deadweight left by cargo + fuel + stores
  near(ballastStep('coaster', 0, 600, 1e9, { cargoT: 1000 }), 1306 - 26 - 80 - 1000);
  assert.equal(ballastStep('sloop', 0, 10, 3600), 0);
});

test('margin and heave: need = ad + 0.30 + 0.5 Hs; airPublic wire block', () => {
  const a = airDraftNow('coaster', { ballastT: 600, fold: DOWN });
  near(a.need(1.0), a.ad + AD_MARGIN + 0.5);
  const w = airPublic('coaster', { ballastT: 600, fold: DOWN });
  assert.deepEqual(w.foldable, ['wheelhouse']); near(w.need, 7.824); assert.equal(w.ballastMax, 600);
});
