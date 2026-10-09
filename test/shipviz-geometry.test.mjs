// Ship generators — pure geometry (public/js/shipgeom.js, public/js/gastub.js): docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md
// §6.2 GA shape, §6.3 rules (bridge eye height, twin island, tiers), §6.6 LOD distances and budgets. No three.js here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, MODEL_IDS } from '../shared/ships/index.js';
import { generalArrangement, blindDistance, blindLimit, gaAirDraft } from '../public/js/gastub.js';
import { hullForm, loftHull, loftBounds, blockCoeff, waterplaneCoeff, bayStacks, triBudget, lodDistances } from '../public/js/shipgeom.js';

const MOTOR = MODEL_IDS.filter((id) => MODELS[id].gen !== 'sail');
const GA_KEYS = ['id', 'gen', 'L', 'B', 'T', 'D', 'F', 'deckY', 'Cb', 'hull', 'house', 'bridge', 'casing', 'funnel', 'er', 'cargo', 'deck', 'goto', 'levels', 'livery', 'stage'];

test('GA stub: every motor model has the frozen §6.2 shape; sail classes are delegated (null)', () => {
  for (const id of MOTOR) {
    const ga = generalArrangement(id);
    assert.ok(ga, id);
    for (const k of GA_KEYS) assert.ok(k in ga, `${id} GA.${k}`);
    for (const k of ['bow', 'stern', 'bowFrac', 'sternW', 'sheerFwd', 'sheerAft', 'flare', 'bilgeR', 'mid', 'fcsle', 'poop', 'bulwark', 'twin']) assert.ok(k in ga.hull, `${id} hull.${k}`);
    for (const k of ['pos', 'z0', 'z1', 'w', 'tiers', 'eyeY']) assert.ok(k in ga.house, `${id} house.${k}`);
    for (const k of ['mooring', 'cranes', 'boats', 'masts', 'rotors', 'hoseCranes', 'manifold']) assert.ok(k in ga.deck, `${id} deck.${k}`);
    assert.ok(Math.abs(ga.deckY - (ga.D - ga.hull.draftHull)) < 0.011 && ga.hull.draftHull <= ga.T, `${id} deckY = D − T (hull body)`);
    assert.ok(ga.deckY > 0.3, `${id} the deck is above the waterline (${ga.deckY})`);
    assert.ok(ga.house.z0 < ga.house.z1 && ga.house.z0 >= -ga.L / 2 && ga.house.z1 <= ga.L / 2, `${id} house inside the hull`);
    assert.ok(ga.house.eyeY > ga.deckY, `${id} eye above the deck`);
    if (ga.funnel.kind !== 'none') assert.ok(Math.abs(ga.funnel.z) < ga.L / 2, `${id} funnel inside`);
    for (const t of ga.house.tiers) assert.ok(t.h > 1 && t.y >= ga.deckY - 0.01, `${id} tier ${t.id}`);
  }
  for (const id of ['sloop', 'ketch', 'catamaran', 'schooner']) assert.equal(generalArrangement(id), null, id);
  assert.equal(generalArrangement('nope'), null);
});

test('GA stub: SOLAS V/22 — container ships see the sea within min(2 L, 500 m) over their deck stacks', () => {
  for (const id of MOTOR.filter((x) => MODELS[x].gen === 'container')) {
    const ga = generalArrangement(id), h = ga.house;
    const fwd = ga.cargo.zones.filter((z) => z.z1 <= h.z0);
    assert.ok(fwd.length > 0, id);
    for (const z of fwd) {
      const top = ga.cargo.hatchY + z.tiersDeck * 2.59;
      const blind = blindDistance(-ga.L / 2, h.z0 + 2, h.eyeY, z.z0, top);
      assert.ok(blind <= blindLimit(ga.L), `${id} bay ${z.id}: blind ${blind.toFixed(0)} m > ${blindLimit(ga.L)} m`);
    }
    // rows across the beam, 40 ft bays at 13 m pitch
    assert.equal(ga.cargo.rows, Math.floor((ga.B - 1.2) / 2.55), `${id} rows`);
  }
  // ≥ 14,000 TEU: twin island, house about 0.6–0.65 L from the stern, funnel aft
  for (const id of ['neopmax14k', 'ulcv24k']) {
    const ga = generalArrangement(id);
    assert.equal(ga.house.pos, 'mid', id);
    const fromStern = (ga.L / 2 - ga.house.z0) / ga.L;
    assert.ok(fromStern > 0.6 && fromStern < 0.68, `${id} house at ${fromStern.toFixed(2)} L from the stern`);
    assert.ok(ga.funnel.z > ga.house.z1 + 40, `${id} funnel aft of the house`);
  }
  // feeders keep the house aft
  assert.equal(generalArrangement('feeder1700').house.pos, 'aft');
  // the blind-distance helper itself: eye 30 m, 10 m obstruction 50 m ahead, bow 60 m ahead → 75 − 60 = 15 m
  assert.equal(blindDistance(-60, 0, 30, -50, 10), 15);
  assert.equal(blindLimit(400), 500); assert.equal(blindLimit(134), 268);
});

test('GA stub: house heights, free-fall lifeboats, davits, twin hulls and options', () => {
  const tiers = (id) => generalArrangement(id).house.tiers.length;
  assert.ok(tiers('capesize180') > tiers('handy38') && tiers('handy38') > tiers('coaster'), 'bigger bulkers have taller houses');
  assert.ok(tiers('cruise362') >= 14 && tiers('expedition105') <= 7, 'cruise deck stacks');
  for (const id of ['ultramax64', 'vlcc300', 'feeder1700', 'lng174k']) assert.ok(generalArrangement(id).deck.boats.some((b) => b.kind === 'freefall'), `${id} free-fall boat (SOLAS III/31)`);
  for (const id of ['ropax200', 'cruise330']) assert.ok(generalArrangement(id).deck.boats.filter((b) => b.kind === 'davit').length >= 4, `${id} davit boats`);
  assert.ok(generalArrangement('hsc112').hull.twin && generalArrangement('ctv26').hull.twin, 'catamarans');
  assert.equal(generalArrangement('ferry50').hull.doubleEnded, true, 'double-ended island ferry');
  assert.equal(generalArrangement('icebreaker120').hull.bow, 'ice');
  // rotor sails appear with the option and add about 30 m of air draft
  const plain = generalArrangement('ultramax64'), rot = generalArrangement('ultramax64~rot');
  assert.equal(plain.deck.rotors.length, 0); assert.ok(rot.deck.rotors.length >= 2);
  assert.ok(gaAirDraft(rot) >= plain.deckY + 30);
  // geared Ultramax: 4 cranes between 5 hatches; gearless Kamsarmax: none
  assert.equal(generalArrangement('ultramax64').deck.cranes.length, 4);
  assert.equal(generalArrangement('ultramax64').cargo.zones.length, 5);
  assert.equal(generalArrangement('kamsarmax82').deck.cranes.length, 0);
  assert.equal(generalArrangement('ultramax64~gearless').deck.cranes.length, 0);
  // stage is clamped and passed through; livery defaults to the model's
  assert.equal(generalArrangement('tug24', { stage: 3 }).stage, 1);
  assert.equal(generalArrangement('tug24').livery.hull, MODELS.tug24.hullColor);
});

test('hull form: scale-correct loft (LOA, beam, waterline, keel) for every motor model', () => {
  for (const id of MOTOR) {
    const ga = generalArrangement(id);
    const loft = loftHull(ga);
    const b = loftBounds(loft);
    const plat = ga.deck.swimPlatform ? Math.max(1.2, ga.L * 0.045) : 0;   // yachts: the swim platform (built separately) is part of the LOA
    assert.ok(Math.abs((b.z1 - b.z0) - (ga.L - plat)) / ga.L < 0.01, `${id} LOA ${(b.z1 - b.z0).toFixed(2)} vs ${ga.L}`);
    assert.ok(Math.abs((b.x1 - b.x0) - ga.B) / ga.B < 0.02, `${id} beam ${(b.x1 - b.x0).toFixed(2)} vs ${ga.B}`);
    assert.ok(Math.abs(b.y0 + ga.hull.draftHull) < 0.1, `${id} keel ${b.y0} vs −${ga.hull.draftHull}`);
    assert.ok(b.y1 >= ga.deckY - 0.01, `${id} deck edge`);
    for (const v of loft.side.pos) assert.ok(Number.isFinite(v), `${id} finite`);
    assert.ok(loft.side.groups.some((g) => g.mat === 'boot') && loft.side.groups.some((g) => g.mat === 'hull'), `${id} boot-top split`);
    // indices in range
    const n = loft.side.pos.length / 3;
    assert.ok(loft.side.idx.every((i) => i >= 0 && i < n), `${id} indices`);
  }
});

test('hull form: fullness follows Cb, sections and ends behave', () => {
  const cb = (id) => blockCoeff(hullForm(generalArrangement(id)));
  for (const id of ['vlcc300', 'ultramax64', 'capesize180', 'mr50', 'lng174k']) {
    const ga = generalArrangement(id);
    assert.ok(Math.abs(cb(id) - ga.Cb) < 0.06, `${id} lofted Cb ${cb(id).toFixed(3)} vs ${ga.Cb}`);
  }
  assert.ok(cb('vlcc300') > cb('ulcv24k') && cb('ulcv24k') > cb('pilot14'), 'tankers fuller than box ships, fuller than pilot boats');
  assert.ok(waterplaneCoeff(hullForm(generalArrangement('vlcc300'))) > waterplaneCoeff(hullForm(generalArrangement('feeder1000'))));
  // half-breadth never exceeds B/2, is 0 at the stem, full in the parallel midbody
  for (const id of ['vlcc300', 'tug24', 'cruise330', 'pilot14']) {
    const hf = hullForm(generalArrangement(id));
    for (let i = 0; i <= 50; i++) for (const y of [-hf.T * 0.9, -hf.T * 0.3, 0, hf.F * 0.5, hf.F]) assert.ok(hf.halfBreadth(-hf.L / 2 + hf.L * i / 50, y) <= hf.Bd / 2 + 1e-9, id);
    assert.equal(hf.halfBreadth(hf.zFwd(0) - 0.01, 0), 0, `${id} ahead of the stem`);
  }
  const v = hullForm(generalArrangement('vlcc300'));
  assert.ok(Math.abs(v.halfBreadth(0, -5) - 30) < 0.05, 'VLCC midship is box-like');
  // bulbous bow: the stem foot lies aft of the deck end; ice bows rake more than bulbous bows
  const ice = hullForm(generalArrangement('icebreaker120'));
  assert.ok((ice.zFwd(-ice.T) - (-ice.L / 2)) / ice.L > (v.zFwd(-v.T) - (-v.L / 2)) / v.L);
  // double-ended ferry is symmetric fore and aft
  const de = hullForm(generalArrangement('ferry50'));
  for (const z of [5, 12, 20]) assert.ok(Math.abs(de.halfBreadth(z, -1) - de.halfBreadth(-z, -1)) < 0.05, 'symmetric');
  // catamarans: two demihulls outboard
  const cat = hullForm(generalArrangement('hsc112'));
  assert.equal(cat.demi.length, 2); assert.ok(cat.demi[1].cx > 8);
});

test('container stacks, LOD distances and §6.6 budgets', () => {
  let s = 1; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const st = bayStacks(23, 10, { fwd: true, rnd });
  assert.equal(st.length, 23);
  assert.ok(Math.abs(st[0].x + st[22].x) < 1e-6 && Math.abs(st[11].x) < 1e-6, 'centred rows');
  assert.ok(Math.abs(st[1].x - st[0].x - 2.55) < 1e-6, '2.55 m row pitch');
  assert.ok(st.every((x) => x.tiers <= 10 && x.tiers >= 0));
  assert.deepEqual(lodDistances(400), [600, 2400, 15000]);
  assert.deepEqual(lodDistances(50), [150, 2000, 15000]);
  assert.equal(triBudget('cruise', 300), 120000); assert.equal(triBudget('container', 300), 80000); assert.equal(triBudget('tug', 24), 40000);
  assert.equal(triBudget('small_fast', 14), 25000); assert.equal(triBudget('motor_yacht', 12, true), 12500);
});
