// Shared texture library (public/js/texlib.js, docs/HD-ASSET-PLAN.md §2–§3): device tier and file choice, repeat maths,
// GPU budget sums, reference counting, the KTX2 files on disk (headers, mips, sizes, licence record), the triplanar and
// textured-skin shader patches (phone-safe: no discard / inout), and the textured skin's sets for the own ship.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { LIB, TINT_MEAN, tierFor, texPath, texSize, texDims, repeatFor, repeatForSize, tilesPerMetre, triScale, bytesPerPixel, mapBytes, setBytes, budgetMB,
  RefCache, getMaterialSet, setRefs, makeMaterial, meanLinear } from '../public/js/texlib.js';
import { makeSkinMaterial, skinUniforms, enableSkinTextures, skinTexSets } from '../public/js/shipskin.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');

test('device tier: phones (touch / coarse pointer / weak GPU) get the 512 files, desktops the 1K ones, ?tex= wins', () => {
  assert.equal(tierFor({}), 'desktop');
  assert.equal(tierFor({ touch: true }), 'phone');
  assert.equal(tierFor({ coarse: true }), 'phone');
  assert.equal(tierFor({ maxFragmentUniforms: 256 }), 'phone', 'fewer than 512 fragment uniform vectors');
  assert.equal(tierFor({ maxFragmentUniforms: 1024 }), 'desktop');
  assert.equal(tierFor({ touch: true, override: 'desktop' }), 'desktop');
  assert.equal(tierFor({ override: 'phone' }), 'phone');
  assert.equal(tierFor({ override: 'off' }), 'off');
  assert.equal(tierFor({ override: 'bogus' }), 'desktop', 'unknown overrides are ignored');
  assert.equal(texPath('painted_steel', 'normal', 'desktop'), '/assets/lib/painted_steel/normal.ktx2');
  assert.equal(texPath('painted_steel', 'normal', 'phone'), '/assets/lib/painted_steel/normal_512.ktx2');
  assert.equal(texSize('rock', 'desktop'), 1024); assert.equal(texSize('rock', 'phone'), 512);
  assert.equal(texSize('brass', 'desktop'), 512); assert.equal(texSize('brass', 'phone'), 256);
  assert.deepEqual(texDims('brick', 'desktop'), [1024, 512], 'brick is 2:1');
  assert.equal(texSize('nope', 'desktop'), 0);
});

test('repeat maths: metres over the tile size, 2:1 maps keep their shape', () => {
  assert.equal(repeatFor(10, 2), 5);
  assert.equal(repeatFor(-10, 2), 5, 'sign-free');
  assert.ok(repeatFor(0, 2) > 0, 'never a zero repeat');
  assert.equal(repeatFor(3, 0), 3, 'a bad tile size counts as 1 m');
  assert.deepEqual(repeatForSize('painted_steel', 8, 4), [4, 2]);
  assert.deepEqual(repeatForSize('brick', 8, 4), [4, 4], 'a brick tile is 2 m × 1 m');
  assert.deepEqual(repeatForSize('concrete', 5, 5, 1), [5, 5], 'explicit tile size');
  assert.equal(tilesPerMetre('rusted_steel'), 1 / LIB.rusted_steel.tile);
  assert.equal(tilesPerMetre('rusted_steel', 4), 0.25);
  assert.deepEqual(triScale('brick'), [0.5, 1]);
  assert.deepEqual(triScale('rock'), [1 / 3, 1 / 3]);
});

test('budget: exact mip-chain bytes, library ≤ 90 MB desktop / ≤ 24 MB phone, own ship ≤ +40 / +8 MB', () => {
  // the numbers the browser measured on the real files (texStats): 1024² BC7 chain = 1 398 128 B, 1024×512 = 699 088 B
  assert.equal(mapBytes(1024, 1024, 1), 1398128);
  assert.equal(mapBytes(1024, 512, 1), 699088);
  assert.equal(mapBytes(1024, 1024, 1, false), 1048576);
  assert.equal(mapBytes(2, 2, 1, false), 16, 'one 4×4 block at least');
  assert.equal(bytesPerPixel('normal', 'phone'), 1, 'UASTC → ASTC / BC7');
  assert.equal(bytesPerPixel('albedo', 'phone'), 0.5, 'ETC1S → ETC1');
  assert.equal(bytesPerPixel('albedo', 'phone', true), 1, 'ETC1S with alpha → ETC2 RGBA');
  assert.equal(bytesPerPixel('orm', 'desktop'), 1, 'ETC1S → BC7');
  const desk = budgetMB(), phone = budgetMB(undefined, 'phone');
  assert.ok(desk <= 90 && desk > 40, `library desktop ${desk} MB`);
  assert.ok(phone <= 24 && phone > 4, `library phone ${phone} MB`);
  assert.ok(budgetMB(undefined, 'phone', 'desktop') <= 24, 'a phone without ETC (BC7 / ASTC everywhere) still fits');
  for (const deck of [0, 1]) {
    const sets = skinTexSets(deck);
    assert.ok(budgetMB(sets, 'desktop') <= 40, `own ship desktop ${budgetMB(sets, 'desktop')} MB`);
    assert.ok(budgetMB(sets, 'phone', 'desktop') <= 8, `own ship phone ${budgetMB(sets, 'phone', 'desktop')} MB`);
  }
  assert.equal(setBytes('glass', 'desktop'), mapBytes(512, 512, 1), 'glass: one ORM map');
  assert.equal(budgetMB([]), 0);
});

test('reference counting: loaded once, disposed when the last holder lets go', () => {
  let made = 0, freed = 0;
  const c = new RefCache((k) => { made++; return { k }; }, () => { freed++; });
  const a = c.acquire('x'), b = c.acquire('x');
  assert.equal(a, b); assert.equal(made, 1); assert.equal(c.refs('x'), 2);
  assert.equal(c.release('x'), false); assert.equal(freed, 0);
  assert.equal(c.release('x'), true); assert.equal(freed, 1); assert.equal(c.size, 0);
  assert.equal(c.release('x'), false, 'releasing an unknown key is harmless');
  c.acquire('x'); assert.equal(made, 2, 'a later acquire loads again');
  // the real registry (node: nothing can load, the set reports failed and keeps the plain colour)
  const s1 = getMaterialSet('concrete'), s2 = getMaterialSet('concrete');
  assert.equal(s1, s2); assert.equal(setRefs('concrete'), 2);
  s1.release(); assert.equal(setRefs('concrete'), 1);
  s2.release(); assert.equal(setRefs('concrete'), 0);
  const bad = getMaterialSet('no_such_material');
  assert.equal(bad.failed, true); bad.release();
});

test('makeMaterial: plain mean colour until the maps arrive, tint survives, dispose releases the set', async () => {
  const m = makeMaterial('rock');
  assert.ok(m.isMeshStandardMaterial);
  assert.equal(m.color.getHex(), LIB.rock.mean);
  assert.equal(setRefs('rock'), 1);
  await m.userData.texReady;
  assert.equal(m.map, null, 'no texture in node');
  m.dispose(); assert.equal(setRefs('rock'), 0);
  const t = makeMaterial('painted_steel', { color: 0x2255aa, triplanar: true });
  assert.equal(t.color.getHex(), 0x2255aa); t.dispose();
  const f = makeMaterial('foliage'); assert.equal(f.alphaToCoverage, true, 'foliage cuts out by coverage, never alphaTest (discard)'); assert.equal(f.alphaTest, 0); f.dispose();
  assert.ok(Math.abs(meanLinear('nonslip')[0] - TINT_MEAN) < 0.03, 'the tint grey averages TINT_MEAN');
});

test('library files: every map on disk for both tiers, KTX2 headers, full mips, ≤ 60 MB, every asset in SOURCES.md', () => {
  const sources = fs.readFileSync(path.join(PUB, 'assets/lib/SOURCES.md'), 'utf8');
  assert.ok(/CC0 1\.0/.test(sources), 'licence line');
  let total = 0;
  for (const [name, e] of Object.entries(LIB)) {
    assert.ok(sources.includes(`| ${name} | ${e.id} |`) && sources.includes(`https://ambientcg.com/view?id=${e.id}`), `${name}: source recorded`);
    for (const tier of ['desktop', 'phone']) {
      const [w, h] = texDims(name, tier);
      for (const map of e.maps) {
        const f = path.join(PUB, texPath(name, map, tier));
        assert.ok(fs.existsSync(f), `${f} exists`);
        const b = fs.readFileSync(f);
        total += b.length;
        assert.equal(b.subarray(0, 12).toString('latin1'), '«KTX 20»\r\n\u001a\n', `${name}/${map} is KTX2`);
        assert.equal(b.readUInt32LE(20), w, `${name}/${map} ${tier} width`);
        assert.equal(b.readUInt32LE(24), h, `${name}/${map} ${tier} height`);
        assert.equal(b.readUInt32LE(40), Math.floor(Math.log2(Math.max(w, h))) + 1, `${name}/${map} full mip chain`);
        assert.equal(b.readUInt32LE(44), map === 'normal' ? 2 : 1, `${name}/${map}: ${map === 'normal' ? 'UASTC + zstd' : 'BasisLZ (ETC1S)'}`);
      }
    }
  }
  assert.ok(total < 60 * 1048576, `library on disk ${(total / 1048576).toFixed(1)} MB`);
});

const TRI_NEEDLES = ['vTriPos = (modelMatrix', 'triToView(nF, vTriPos, -vViewPosition)', 'roughnessFactor *= triOrm.g', 'uniform vec2 uTriScale'];
test('triplanar shader patch: insertion points in r160, 2:1 scale, phone-safe GLSL', async () => {
  // pretend the brick set loaded (node has no GPU / transcoder), then run the material's patch on three's standard shader
  const set = getMaterialSet('brick');
  set.albedo = new THREE.Texture(); set.normal = new THREE.Texture(); set.orm = new THREE.Texture(); set.loaded = true;
  const m = makeMaterial('brick', { triplanar: 'world' });
  await m.userData.texReady;
  assert.ok(m.defines && 'TRI_ALBEDO' in m.defines && 'TRI_NORMAL' in m.defines && 'TRI_ORM' in m.defines && 'TRI_WORLD' in m.defines, JSON.stringify(m.defines));
  const sh = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  m.onBeforeCompile(sh);
  const src = sh.vertexShader + sh.fragmentShader;
  for (const n of TRI_NEEDLES) assert.ok(src.includes(n), `triplanar: ${n}`);
  assert.ok(sh.uniforms.uTriA.value === set.albedo && sh.uniforms.uTriScale.value.y === 2 * sh.uniforms.uTriScale.value.x, 'brick v scale is twice u');
  const ours = sh.fragmentShader.slice(sh.fragmentShader.indexOf('varying vec3 vTriPos'), sh.fragmentShader.indexOf('void main'));
  assert.ok(!/discard|inout/.test(ours) && !/inout/.test(src), 'no discard / inout in the patch');
  m.dispose(); set.albedo = set.normal = set.orm = null; set.release();
  assert.equal(setRefs('brick'), 0);
});

test('textured ship skin: SKIN_TEX patch for every kind (standard, physical, lite), own-ship sets', () => {
  for (const lite of [false, true]) for (const physical of [false, true]) for (const kind of ['hull', 'deck', 'house', 'funnel', 'paint']) {
    if (physical && kind !== 'hull') continue;
    const U = skinUniforms();
    const m = makeSkinMaterial(kind, 0x884422, { uniforms: U, physical, preset: kind === 'hull' ? 'paint' : undefined, lite, map: kind === 'house' ? new THREE.Texture() : null });
    const plainKey = m.customProgramCacheKey();
    m.defines.SKIN_TEX = '';
    assert.notEqual(m.customProgramCacheKey(), plainKey, 'the textured variant is its own program');
    const lib = physical ? THREE.ShaderLib.physical : THREE.ShaderLib.standard;
    const sh = { uniforms: {}, vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader };
    m.onBeforeCompile(sh);
    assert.ok(sh.vertexShader.includes('vShipNrm = shipNrm'), `${kind}: ship-frame normal`);
    for (const n of ['txToView(skinTxN, vShipPos, -vViewPosition)', 'skinTxN = normalize(mix(txNA, txNB, txR))', 'rustCol = mix(rustCol, txTri(uTxRA']) assert.ok(sh.fragmentShader.includes(n), `${kind}: ${n}`);
    assert.ok(sh.uniforms.uTxPN === U.uTxPN && sh.uniforms.uTxS === U.uTxS, 'texture uniforms shared per ship');
    assert.ok(!/\bdiscard\b|\binout\b/.test(sh.fragmentShader.slice(sh.fragmentShader.indexOf('#ifdef SKIN_TEX'))), 'phone-safe');
  }
  assert.deepEqual(skinTexSets(0), ['painted_steel', 'rusted_steel', 'nonslip']);
  assert.deepEqual(skinTexSets(1), ['painted_steel', 'rusted_steel', 'teak']);
  // node: the sets cannot load, the handle releases its refs and the skin never switches
  const U = skinUniforms(), mats = ['hull', 'deck'].map((k) => makeSkinMaterial(k, 0x334455, { uniforms: U }));
  const h = enableSkinTextures(null, mats, U, { deckMode: 0 });
  assert.ok(h && setRefs('painted_steel') >= 1 && setRefs('nonslip') >= 1);
  return h.ready.then(() => {
    assert.equal(h.enabled, false);
    assert.ok(mats.every((m) => !('SKIN_TEX' in m.defines)), 'no textures, procedural skin');
    h.release(); h.release();
    assert.equal(setRefs('nonslip'), 0); assert.equal(setRefs('rusted_steel'), 0);
  });
});
