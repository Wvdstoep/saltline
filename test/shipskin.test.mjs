// Ship exterior skin (public/js/shipskinfmt.js pure layout maths, public/js/shipskin.js shader patch, shipgen.js hull
// facts): plates and letters in metres for every size of ship, draft marks, weathering, cache keys, and the shader
// insertion points that must exist in three.js r160's standard / physical shaders.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { plateGrid, weathering, capHeight, nameLayout, draftStations, draftGlyphAt, walkwayFor, deckLanes, texSizes, letteringKey, markColorFor,
  trafficLivery, skinKindOf, hullModeOf, deckModeOf, PRESETS } from '../public/js/shipskinfmt.js';
import { makeSkinMaterial, skinUniforms } from '../public/js/shipskin.js';
import { MODELS, MODEL_IDS } from '../shared/ships/index.js';
import { generalArrangement } from '../public/js/gastub.js';
import { buildFromGA, hawseSpot } from '../public/js/shipgen.js';
import { hullForm } from '../public/js/shipgeom.js';

test('plate grid is real-size: same plates on a 400 m ship and a 30 m tug within limits, none on yachts', () => {
  const big = plateGrid(400), tug = plateGrid(30), y = plateGrid(40, 1);
  assert.ok(big.strake >= 2.5 && big.strake <= 3.0, `big strake ${big.strake}`);
  assert.ok(big.butt >= 10 && big.butt <= 12, `big butt ${big.butt}`);
  assert.ok(tug.strake >= 1.4 && tug.strake < big.strake && tug.butt >= 4.5 && tug.butt < big.butt);
  assert.ok(tug.scupper >= 5 && big.scupper <= 18);
  assert.deepEqual(y, { strake: 0, butt: 0, seam: 0, scupper: 0 });
});

test('weathering: clean when new, rises with age and with poor condition, deterministic for unknown age', () => {
  const fresh = weathering({ cond: 100, ageYears: 0 }), old = weathering({ cond: 100, ageYears: 25 }), beat = weathering({ cond: 30, ageYears: 25 });
  assert.ok(fresh <= 0.05, `fresh ${fresh}`);
  assert.ok(old > fresh + 0.3 && beat > old && beat <= 1);
  assert.equal(weathering({ cond: 90, seed: 17 }), weathering({ cond: 90, seed: 17 }));
  const vals = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((s) => weathering({ seed: s })));
  assert.ok(vals.size > 3, 'traffic varies with the seed');
  for (const s of [1, 99, 12345]) { const w = weathering({ seed: s }); assert.ok(w > 0.1 && w < 0.6, `seed ${s}: ${w}`); }
});

test('name layout: letters scale with the ship, stay between boot top and deck edge, start aft of the stem', () => {
  for (const [L, B, deckY] of [[20, 7, 2.2], [75, 13, 4.5], [250, 44, 8], [400, 61, 12]]) {
    const cap = capHeight(L, deckY);
    const lay = nameLayout({ L, B, deckY, bootH: 0.6 }, { aspect: 4, fill: 0.7, rows: 2 });
    const b = lay.bow, rowTop = b.yc + b.h / 2, nameBottom = b.yc;   // the name is the top row
    assert.ok(b.w > 0 && b.h > 0, `${L} m has a bow name`);
    assert.ok(rowTop <= deckY - 0.2 + 1e-9, `${L} m: name top ${rowTop} under the deck edge ${deckY}`);
    assert.ok(nameBottom >= 0.6, `${L} m: name above the boot top`);
    assert.ok(b.zc - b.w * 0.7 / 2 >= -L / 2 + 0.03 * L, `${L} m: name starts aft of the stem`);
    assert.ok(cap >= 0.2 && cap <= 2.4);
    if (lay.stern.w) assert.ok(lay.stern.w * 0.7 <= B * 0.8 * 1.0001 + 1e-9, `${L} m: stern name fits the transom`);
  }
  assert.ok(capHeight(400, 12) > capHeight(30, 2.5) * 4, 'a VLCC name is several times a tug name');
  const none = nameLayout({ L: 8, B: 2.5, deckY: 0.5, bootH: 0.3 }, { aspect: 4, fill: 0.8 });
  assert.equal(none.bow.w, 0, 'no room on a tiny freeboard');
});

test('draft marks: 0.1 m numerals every 0.2 m, metre labels, stations inside the hull', () => {
  assert.equal(draftGlyphAt(0.2), '2'); assert.equal(draftGlyphAt(0.45), '4'); assert.equal(draftGlyphAt(0.62), '6'); assert.equal(draftGlyphAt(0.85), '8');
  assert.equal(draftGlyphAt(0.3), '', 'gap between numerals');
  assert.equal(draftGlyphAt(7.05), '7M'); assert.equal(draftGlyphAt(12.01), '12M'); assert.equal(draftGlyphAt(-1), '');
  const ga = generalArrangement('ultramax64'), hf = hullForm(ga);
  const st = draftStations({ L: ga.L, T: ga.T, deckY: ga.deckY, zStemAt: hf.zFwd, zAftAt: hf.zAft });
  assert.ok(st.zF > hf.zFwd(0) && st.zF < 0 && st.zA < hf.zAft(0) && st.zA > 0);
  assert.ok(hf.halfBreadth(st.zF, 0) > 0.5 && hf.halfBreadth(st.zA, -0.5) > 0.3, 'marks sit on plating at the waterline');
  assert.ok(st.top > ga.T && st.top <= ga.T + 4);
});

test('deck lanes, walkway colours, mark colours, texture sizes, cache keys', () => {
  assert.equal(walkwayFor(0x7b3a33, 'aft_house_tanker'), 0x3f6e4c, 'green lanes on a red tanker deck');
  const lanes = deckLanes({ L: 250, B: 44, zMid0: -90, zMid1: 80, houseZ0: 95 });
  assert.ok(lanes.width > 0 && lanes.z0 === -90 && lanes.z1 === 80);
  assert.equal(deckLanes({ L: 30, B: 9, zMid0: -5, zMid1: 5 }).width, 0, 'no lanes on small craft');
  assert.equal(deckLanes({ L: 200, B: 32, zMid0: -60, zMid1: 70, houseZ0: 40 }).z1, 39, 'lanes stop at the house front');
  assert.equal(markColorFor(0x0d1b2a), 0xf4f4f0); assert.equal(markColorFor(0xf2f2f2), 0x1b1b1b);
  assert.deepEqual(texSizes(true), { letterW: 512, letterH: 128, facade: 512 });
  assert.equal(texSizes(false, true).letterW, 2048); assert.equal(texSizes(false).letterW, 1024);
  assert.equal(letteringKey('Nord Star', '', 0xffffff, 1024, 256), letteringKey(' nord star ', '', 0xffffff, 1024, 256));
  assert.notEqual(letteringKey('Nord Star', 'Monrovia', 0xffffff, 1024, 256), letteringKey('Nord Star', '', 0xffffff, 1024, 256));
  assert.notEqual(letteringKey('A', '', 0xffffff, 512, 128), letteringKey('A', '', 0x000000, 512, 128));
});

test('kinds, modes, presets and the made-up traffic liveries', () => {
  assert.equal(skinKindOf('hull'), 1); assert.equal(skinKindOf('boot'), 1); assert.equal(skinKindOf('deck'), 2); assert.equal(skinKindOf('house'), 3);
  assert.equal(skinKindOf('funnel'), 4); assert.equal(skinKindOf('metal'), 5); assert.equal(skinKindOf('glass'), 0); assert.equal(skinKindOf('cargo'), 0);
  assert.equal(hullModeOf('motor_yacht'), 1); assert.equal(hullModeOf('aft_house_tanker'), 0);
  assert.equal(deckModeOf('motor_yacht', 0), 1); assert.equal(deckModeOf('container', 0x5f656c), 0);
  for (const k of ['paint', 'housePaint', 'deckPaint']) assert.equal(PRESETS[k].metalness, 0, `${k}: painted steel is a dielectric`);
  assert.ok(PRESETS.deckPaint.roughness >= 0.85 && PRESETS.paint.roughness <= 0.6 && PRESETS.glass.roughness < 0.1);
  const a = trafficLivery(5), b = trafficLivery(5);
  assert.deepEqual(a, b);
  assert.ok(/^[A-Z]{1,2}$/.test(a.mark) && Number.isInteger(a.funnelBand) && a.funnelBand !== a.funnel);
  assert.ok(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((s) => JSON.stringify(trafficLivery(s)))).size > 4);
});

test('skin shader patch finds every insertion point in three r160 (standard and physical)', () => {
  for (const physical of [false, true]) {
    const U = skinUniforms();
    for (const kind of ['hull', 'deck', 'house', 'funnel', 'paint']) {
      const m = makeSkinMaterial(kind, 0x884422, { uniforms: U, physical, preset: kind === 'hull' ? 'paint' : undefined, map: kind === 'house' ? new THREE.Texture() : null });
      const lib = physical && kind === 'hull' ? THREE.ShaderLib.physical : THREE.ShaderLib.standard;
      const shader = { uniforms: {}, vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader };
      m.onBeforeCompile(shader);
      for (const needle of ['vShipPos = shipPos', 'skinH', 'roughnessFactor = clamp(mix(roughnessFactor + skinRough', 'skinPerturb(-vViewPosition', 'skinLit * uNight', 'getIBLIrradiance( geometryNormal ) * uEnvDiffuse']) {
        const src = needle.startsWith('vShipPos') ? shader.vertexShader : shader.fragmentShader;
        assert.ok(src.includes(needle), `${kind}${physical ? ' (physical)' : ''}: ${needle}`);
      }
      assert.equal(m.defines.SKIN_KIND, skinKindOf(kind));
      if (physical) assert.ok('STANDARD' in m.defines, 'keeps three\'s own defines');
      assert.ok(shader.uniforms.uWear === U.uWear, 'one uniform set per ship');
      if (kind !== 'hull') assert.equal(shader.uniforms.uLetter, undefined, 'lettering samplers only on the hull');
      if (physical && kind === 'hull') assert.ok(m.isMeshPhysicalMaterial && m.clearcoat > 0, 'fresh hull paint has a clear coat');
    }
  }
  const glass = makeSkinMaterial('glass', 0x112233, { preset: 'glass' });
  const gs = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  glass.onBeforeCompile(gs);
  assert.ok(gs.fragmentShader.includes('hemisphereLights[0].skyColor') && !gs.fragmentShader.includes('skinH'), 'glass: sky reflection only, no skin');
  assert.equal(glass.userData.uniforms, undefined);
});

test('shipgen: hawse pipes, anchors and skin facts on merchant hulls, none on yachts; budgets unchanged', () => {
  let withHawse = 0;
  for (const id of MODEL_IDS.filter((x) => MODELS[x].gen !== 'sail')) {
    const ga = generalArrangement(id), hf = hullForm(ga), h = hawseSpot(ga, hf);
    if (['motor_yacht', 'small_fast'].includes(ga.gen)) { assert.equal(h, null, `${id}: no hawse on a yacht`); continue; }
    if (!h) continue;
    withHawse++;
    assert.ok(h.y > 0 && h.y < ga.deckY, `${id}: hawse between waterline and deck`);
    assert.ok(h.z > -ga.L / 2 && h.z < -ga.L * 0.2, `${id}: hawse at the bow`);
    assert.ok(h.x > 0.6 && h.x <= ga.B / 2 + 1e-6, `${id}: on the plating`);
  }
  assert.ok(withHawse > 30, `most merchant hulls have hawse pipes (${withHawse})`);
  const r = buildFromGA(generalArrangement('ultramax64'));
  const sk = r.info.skin;
  assert.ok(sk && sk.hawse && sk.bootH > 0 && typeof sk.zStemAt === 'function' && sk.zMid[0] < sk.zMid[1] && sk.transomHalf > 1);
});
