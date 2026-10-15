// The cruise casino interior (iv2pbr.js + casinotex.js): light enough never to hang or crash a browser. The rules that
// broke it before: GLTF props (a 176k-triangle plant on every deck), an HDR environment pushed into scene.environment,
// 28 copies of the PBR maps, per-table spot lights, a second WebGL renderer for poker. Built in node on the real plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url).href;
register('data:text/javascript,' + encodeURIComponent(`const ROOT=${JSON.stringify(ROOT)};export async function resolve(s,c,n){if(s.startsWith('/shared/'))return n(ROOT+s.slice(1),c);if(s.startsWith('/js/'))return n(ROOT+'public'+s,c);return n(s,c);}`));
const ctx2d = new Proxy({}, { get: (t, k) => (k in t ? t[k] : k === 'measureText' ? () => ({ width: 10 }) : k === 'createLinearGradient' || k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : k === 'getImageData' ? (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
if (!('document' in globalThis)) globalThis.document = { getElementById: () => null, createElement: () => ({ width: 0, height: 0, style: {}, getContext: () => ctx2d }) };

const THREE = await import('three');
const { Interior } = await import('../public/js/interior.js');
const { planFromGA } = await import('../public/js/gaplan.js');
const { buildInteriorV2 } = await import('../public/js/iv2draw.js');
const P = await import('../public/js/iv2pbr.js');
const CT = await import('../public/js/casinotex.js');
const src = (f) => readFileSync(new URL('../public/js/' + f, import.meta.url), 'utf8');

function casinoDeck(phone) {
  const pl = planFromGA('cruise370', { deck: 'd5' });
  const I = Object.create(Interior.prototype); I.textures = []; I.app = { scene: new THREE.Scene() }; I.mats = I.makeMaterials(pl.style);
  const groups = buildInteriorV2(I, pl, new THREE.Group(), { phone });
  const zid = pl.rooms.find((r) => r.space === 'casino').zone;
  return { pl, I, groups, zid, zone: groups.get(zid) };
}

test('casino: no GLTF, no HDR, no second renderer, nothing written to scene.environment', () => {
  const pbr = src('iv2pbr.js');
  assert.doesNotMatch(pbr, /GLTFLoader|RGBELoader|\.gltf|\.hdr|scene\.environment\s*=/);
  assert.ok(!existsSync(new URL('../public/assets/casino/models', import.meta.url)), 'the GLTF props are gone');
  assert.ok(!existsSync(new URL('../public/js/iv2poker3d.js', import.meta.url)));
  assert.match(src('iv2games.js'), /poker: \['\.\/iv2cards\.js', 'poker'\]/, 'poker opens the 2D table panel');
  assert.doesNotMatch(src('interior.js'), /TextureLoader\(\)\.load\('\/assets\/casino/);
});

test('casino: the desktop room is instanced parts, no lights, shared materials, ≤ 64 MB of textures', () => {
  P._casinoReset();
  const { zone, I, zid } = casinoDeck(false);
  assert.ok(I.v2.casinoZones.has(zid));
  let lights = 0, inst = 0, statics = 0, other = 0; const mats = new Set();
  zone.traverse((o) => {
    if (o.isLight) lights++;
    if (!o.isMesh || !o.name.startsWith('casino')) return;
    mats.add(o.material); if (o.isInstancedMesh) inst++; else if (o.userData.casinoStatic) statics++; else other++;
    assert.equal(o.castShadow, false);
  });
  assert.equal(lights, 0, 'lights change every program and blow the phone uniform budget');
  assert.ok(inst >= 30 && inst <= 80, `${inst} instanced parts`); assert.ok(statics <= 8, `${statics} merged statics`); assert.equal(other, 0);
  assert.ok(mats.size <= 24 && P.CASINO_MATERIALS.length <= 24, `${mats.size} materials`);
  for (const k of ['slot.cab', 'chair.lea', 'ch.crystal', 'chip', 'dl.glow']) { const m = zone.getObjectByName('casino:' + k); assert.ok(m?.isInstancedMesh && m.count > 1, k); }
  // the textures: one entry per file (felt and red felt share Fabric028, leather and dark leather share Leather034C)
  P.prepareCasino({ phone: false });
  const files = [...CT._casinotex.entries.values()].filter((e) => e.groups.has('casino'));
  assert.equal(new Set(files.map((e) => e.url)).size, files.length);
  assert.ok(files.length <= 9, `${files.length} files`); assert.ok(files.every((e) => e.size <= 1024));
  assert.ok(!files.some((e) => /Metalness|AmbientOcclusion|AO\.jpg|Rough\.jpg/.test(e.url)), 'no maps that add little');
  const mb = CT.texPlan('casino').mb + P.CASINO_ENV_BYTES / 1048576;
  assert.ok(mb <= 64, `${mb.toFixed(1)} MB`);
  // placeholders until the maps land: a textured material already has its map slots (no recompile when they arrive)
  const felt = P.casinoMat('felt'); assert.ok(felt.map?.userData.placeholder && felt.normalMap?.userData.placeholder);
  assert.ok(P.releaseCasino()); assert.equal(CT.texBudget('casino').files, 0);
});

test('casino: phone quality is lighter and stays ≤ 24 MB of textures', () => {
  P._casinoReset();
  const { zone } = casinoDeck(true);
  let tris = 0; zone.traverse((o) => { if (o.isMesh && o.name.startsWith('casino')) tris += (o.isInstancedMesh ? o.count : 1) * (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; });
  assert.ok(tris < 110000, `${Math.round(tris)} casino triangles on a phone`);
  P.prepareCasino({ phone: true });
  const files = [...CT._casinotex.entries.values()].filter((e) => e.groups.has('casino'));
  assert.ok(files.every((e) => e.size <= 512));
  const mb = CT.texPlan('casino').mb + P.CASINO_ENV_BYTES / 1048576;
  assert.ok(mb <= 24, `${mb.toFixed(1)} MB`);
  P.releaseCasino();
});

test('casino: props are procedural and modest (triangles per prop, desktop / phone)', () => {
  P._casinoReset();
  const lim = { chair: [1200, 400], palm: [1500, 900], chandelier: [2400, 1800], stool: [700, 300], sconce: [400, 400], lamp: [400, 400], poker: [4200, 2500], blackjack: [4200, 2500], roulette: [5000, 3400] };
  for (const [k, [d, p]] of Object.entries(lim)) { assert.ok(P.propTris(k, false, false) <= d, `${k} ${P.propTris(k, false, false)}`); assert.ok(P.propTris(k, false, true) <= p, `${k} phone ${P.propTris(k, false, true)}`); }
  assert.ok(P.propTris('slots', false, false) / 6 <= 1800, 'a slot machine with its stool');
});

test('casino: out of sight for a while → released; in sight → prepared again', () => {
  P._casinoReset();
  P.casinoTick(true, 0.1, {}, false); assert.equal(P.casinoState().state, 'ready');
  P.casinoTick(false, 5, {}, false); assert.equal(P.casinoState().state, 'ready');
  P.casinoTick(false, 30, {}, false); assert.equal(P.casinoState().state, 'cold');
  assert.ok(P.casinoMat('walnut').map.userData.placeholder, 'released materials sample the placeholders');
  P.casinoTick(true, 0.1, {}, false); assert.equal(P.casinoState().state, 'ready');
  P.releaseCasino();
});
