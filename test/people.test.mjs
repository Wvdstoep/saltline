// People (public/js/people.js): the procedural human, its skeleton, clips and VAT bake, the clothing atlas layout and
// looks, the instanced crowd, baked figures, the skinned captain and boarders, phone-safe shader patches and the GPU
// budget (atlas ≤ 6 MB desktop / 1.5 MB phone).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import * as P from '../public/js/people.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');

test('body: LOD0 1.2–2k triangles, LOD1 ≤ 560, LOD2 ≤ 250; every vertex skinned with weights summing to 1', () => {
  const t = [0, 1, 2].map((l) => P.bodyGeometry(l, {}).userData.tris);
  assert.ok(t[0] >= 1200 && t[0] <= 2000, `LOD0 ${t[0]}`); assert.ok(t[1] <= 560 && t[1] >= 300, `LOD1 ${t[1]}`); assert.ok(t[2] <= 250, `LOD2 ${t[2]}`);
  for (const l of [0, 1, 2]) {
    const g = P.bodyGeometry(l, { prop: true }), sw = g.attributes.skinWeight.array, si = g.attributes.skinIndex.array;
    for (let i = 0; i < sw.length; i += 4) { assert.ok(Math.abs(sw[i] + sw[i + 1] + sw[i + 2] + sw[i + 3] - 1) < 1e-4); for (let k = 0; k < 4; k++) assert.ok(si[i + k] < P.BONES.length); }
    assert.ok(g.attributes.position.count < 2048, 'VAT width stays inside every WebGL2 texture limit');
  }
  const b = P.bodyGeometry(0, {}); b.computeBoundingBox();
  assert.ok(Math.abs(b.boundingBox.max.y - P.HEIGHT) < 0.03 && Math.abs(b.boundingBox.min.y) < 0.01, `${b.boundingBox.min.y} … ${b.boundingBox.max.y}`);
  const parts = new Set(b.attributes.aPart.array); for (const k of ['FACE', 'HAIR', 'TORSO', 'UARM', 'LARM', 'SKIN', 'THIGH', 'SHIN', 'SHOE']) assert.ok(parts.has(P.PART[k]), k);
  assert.ok(P.bodyGeometry(0, { cap: true }).userData.tris > b.userData.tris, 'the captain has a cap');
});

test('skeleton: 19 bones + the crowd prop bone, parents before children, rest joints in proportion', () => {
  assert.equal(P.SKELETON_BONES, 19); assert.equal(P.BONES.length, 20);
  P.PARENT.forEach((p, i) => assert.ok(p < i));
  assert.ok(P.REST[P.BONE.head][1] > P.REST[P.BONE.neck][1] && P.REST[P.BONE.shinL][1] < P.REST[P.BONE.thighL][1]);
  assert.ok(P.REST[P.BONE.upperArmL][0] > 0 && P.REST[P.BONE.upperArmR][0] < 0, 'left is +x (facing +z)');
});

test('poses: every clip finite, standing clips on the floor, seated on a seat, lying on a lounger, swimmers in the water', () => {
  const g = P.bodyGeometry(1, { prop: true });
  const span = (clip, ph) => { const s = P.skinGeometry(g, P.poseOf(clip, ph)).position; let lo = Infinity, hi = -Infinity; for (let i = 1; i < s.length; i += 3) { assert.ok(Number.isFinite(s[i])); lo = Math.min(lo, s[i]); hi = Math.max(hi, s[i]); } return [lo, hi]; };
  for (const c of P.CLIP_NAMES) for (const ph of [0, 0.3, 0.7]) span(c, ph);
  for (const c of ['idle', 'walk', 'run', 'tray', 'wave', 'hold', 'dance']) for (const ph of [0, 0.25, 0.5, 0.75]) { const [lo] = span(c, ph); assert.ok(lo > -0.04 && lo < 0.03, `${c} ${ph}: feet at ${lo}`); }
  const [slo, shi] = span('sit', 0); assert.ok(slo > -0.04 && shi < 1.45 && shi > 1.2, `sit ${slo} … ${shi}`);
  const [llo, lhi] = span('lie', 0); assert.ok(llo > 0.3 && lhi < 0.8, `lie ${llo} … ${lhi}`);
  const [wlo, whi] = span('swim', 0.5); assert.ok(wlo > -0.5 && whi < 0.7, `swim ${wlo} … ${whi}`);
  // the tray only exists in the tray clip (prop bone scaled away elsewhere)
  const prop = [...g.attributes.aPart.array].map((p, i) => (p === P.PART.PROP ? i : -1)).filter((i) => i >= 0);
  assert.ok(prop.length > 0);
  const at = (clip) => { const s = P.skinGeometry(g, P.poseOf(clip, 0.1)).position; const ys = prop.map((i) => s[i * 3 + 1]); return Math.max(...ys) - Math.min(...ys); };
  assert.ok(at('walk') < 1e-3 && at('tray') < 0.05, 'collapsed off-tray, flat on the tray');
});

test('clips + VAT: frames loop, the texture holds positions, normals and the head pivot for every frame', () => {
  assert.equal(P.CLIP_START._total, P.CLIP_NAMES.reduce((s, n) => s + P.CLIPS[n][0], 0));
  const [a, b, t] = P.frameOf('walk', 0.99); assert.equal(a, P.CLIP_START.walk + 7); assert.equal(b, P.CLIP_START.walk); assert.ok(t > 0.9);
  assert.deepEqual(P.frameOf('walk', 1.0), P.frameOf('walk', 0)); assert.deepEqual(P.frameOf('nope', 0.5), P.frameOf('idle', 0.5));
  for (const l of [0, 1]) {
    const v = P.vatFor(l), g = P.bodyGeometry(l, { prop: true });
    assert.equal(v.width, g.attributes.position.count + 1); assert.equal(v.height, P.CLIP_START._total * 2);
    assert.equal(v.texture.type, THREE.HalfFloatType); assert.equal(v.texture.minFilter, THREE.NearestFilter);
    const d = v.texture.image.data, fromH = THREE.DataUtils.fromHalfFloat, row = (P.CLIP_START.idle * 2) * v.width * 4;
    const hy = fromH(d[row + (v.width - 1) * 4 + 1]); assert.ok(Math.abs(hy - P.REST[P.BONE.head][1]) < 0.05, `head pivot ${hy}`);
    const nrow = (P.CLIP_START.idle * 2 + 1) * v.width * 4; const n = [fromH(d[nrow]), fromH(d[nrow + 1]), fromH(d[nrow + 2])]; assert.ok(Math.abs(Math.hypot(...n) - 1) < 0.01);
  }
});

test('atlas: 64 tiles in an 8 × 8 grid, unique names, the layout file the VPS script draws matches', () => {
  assert.equal(P.TILES.length, P.ATLAS_GRID * P.ATLAS_GRID);
  assert.equal(new Set(P.TILES.map((t) => t[0])).size, P.TILES.length);
  for (const [, kind, mean] of P.TILES) { assert.ok(kind === 'true' || kind === 'tint'); assert.ok(mean >= 0 && mean <= 0xffffff); }
  const [u0, v0] = P.atlasUV(0, 0, 1), [u1, v1] = P.atlasUV(63, 1, 0);
  assert.ok(u0 > 0 && v0 > 0 && u0 < 1 / 8 && u1 < 1 && v1 < 1 && u1 > 7 / 8 && v1 > 7 / 8, 'row 0 = the top of the image, v = 1 = the top of a tile');
  assert.ok(Math.abs(P.headU(0) - 0.5) < 1e-9 && Math.abs(P.headU(Math.PI / 2) - 0.875) < 1e-9 && Math.abs(P.headU(Math.PI) - 1) < 1e-9 && Math.abs(P.headU(-Math.PI / 2) - 0.125) < 1e-9);
  const layout = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/people-atlas-layout.json'), 'utf8'));
  assert.deepEqual(layout.tiles.map((t) => [t.name, t.kind]), P.TILES.map((t) => [t[0], t[1]]));
  assert.deepEqual(layout.skins, [...P.SKIN_TONES]); assert.equal(layout.pad, P.TILE_PAD);
  const tex = P.meanAtlas(); assert.equal(tex.image.width, 8); assert.equal(tex.colorSpace, THREE.SRGBColorSpace);
});

const atlasFile = (tier) => path.join(PUB, P.ATLAS_URL(tier));
test('atlas files: KTX2 ETC1S with full mips, 1024 desktop / 512 phone, inside the GPU budget', { skip: !fs.existsSync(atlasFile('desktop')) && 'atlas not generated yet' }, () => {
  for (const [tier, w] of [['desktop', 1024], ['phone', 512]]) {
    const b = fs.readFileSync(atlasFile(tier));
    assert.equal(b.subarray(0, 12).toString('latin1'), '«KTX 20»\r\n\u001a\n');
    assert.equal(b.readUInt32LE(20), w); assert.equal(b.readUInt32LE(24), w); assert.equal(b.readUInt32LE(40), Math.log2(w) + 1); assert.equal(b.readUInt32LE(44), 1, 'BasisLZ');
    assert.ok(b.length < (tier === 'phone' ? 400 : 1200) * 1024, `${tier} ${b.length} bytes on disk`);
  }
  assert.ok(P.peopleBytes('desktop').atlas <= 6 * 1048576 && P.peopleBytes('phone').atlas <= 1.5 * 1048576);
  assert.ok(fs.readFileSync(path.join(PUB, 'assets/lib/SOURCES.md'), 'utf8').includes('people/albedo'), 'recorded in SOURCES.md');
});

test('looks: every kind gives valid tiles; uniforms for crew; the captain wears his; a planned look keeps its colours', () => {
  const kinds = ['guest', 'street', 'deckcrew', 'officer', 'captain', 'pirate', 'waiter', 'barman', 'cook', 'cleaner', 'engineer', 'host', 'steward', 'dealer', 'performer', 'nurse', 'crew', 'swim', 'kid'];
  for (const k of kinds) for (let s = 1; s < 30; s++) {
    const L = P.lookFor(k, s);
    for (const t of [L.face, L.hair, L.top, L.bottom, L.shoe]) assert.ok(Number.isInteger(t) && t >= 0 && t < 64, `${k} ${t}`);
    assert.ok(L.face < 16 && L.hair >= 16 && L.hair < 26 && L.top >= 26 && L.top < 51 && L.bottom >= 51 && L.bottom < 58 && L.shoe >= 58 && L.shoe < 62, k);
    assert.ok(L.h > 0.5 && L.w > 0.6);
  }
  assert.equal(P.lookFor('captain').top, P.TILE.uni_captain); assert.ok(P.lookFor('captain').cap);
  assert.ok([P.TILE.uni_hivis_orange, P.TILE.uni_hivis_yellow].includes(P.lookFor('deckcrew', 3).top));
  assert.equal(P.lookFor('waiter', 2).top, P.TILE.uni_waiter);
  assert.deepEqual(P.lookFor('guest', 9), P.lookFor('guest', 9), 'deterministic');
  const L = P.lookFromPlan({ skin: 0x9a6640, hair: 0x2a1d14, top: 0x2f6a9a, bottom: 0x1f2a3a, shorts: true, sleeves: true, h: 1.02, w: 1.1 }, 'guest', 5);
  assert.equal(P.SKIN_TONES[L.face % 8], 0x9a6640); assert.equal(L.topCol, 0x2f6a9a); assert.ok(L.shorts && L.bareArms); assert.equal(L.h, 1.02);
  const sw = P.lookFromPlan({ skin: 0xf1c8a5, hair: 0x151210, top: 0xf1c8a5, bottom: 0xe53935, shorts: true, sleeves: true, h: 1, w: 1 }, 'swim', 2);
  assert.equal(sw.top, P.TILE.top_bare); assert.equal(sw.topCol, sw.skin);
});

test('crowd: one instanced draw per LOD, per-instance frames / tiles / packed colours, capped', () => {
  const c = new P.PeopleCrowd(5, { lod: 1 });
  const L = P.lookFor('guest', 4);
  for (let k = 0; k < 7; k++) c.set(k, k, 0, 0, 0.5, 1, L, 'walk', k * 0.1, 0.2, 1);
  c.commit(9);
  assert.equal(c.mesh.count, 5); assert.ok(c.mesh.isInstancedMesh);
  assert.equal(c.iT.array[0], L.face); assert.equal(c.iC.array[2], L.topCol); assert.equal(c.iU.array[1], (L.shorts ? 1 : 0) + (L.bareArms ? 2 : 0));
  const f = P.frameOf('walk', 0.1); assert.equal(c.iA.array[4], f[0]); assert.ok(Math.abs(c.iA.array[7] - 0.2) < 1e-6);
  assert.ok(c.mesh.material.userData.shared, 'shared material');
  c.dispose(); assert.equal(c.mesh.parent, null);
});

const NEEDLES_V = ['texelFetch(uVAT, ivec2(gl_VertexID', 'vec3 transformed = pplPos();', 'vAtlasUV = '];
test('shader patches: insertion points in r160, phone-safe GLSL (no discard / inout / out params / uniform arrays)', () => {
  for (const lit of ['basic', 'standard']) {
    const m = P.crowdMaterial(1, lit), lib = lit === 'basic' ? THREE.ShaderLib.basic : THREE.ShaderLib.standard;
    const sh = { uniforms: {}, vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader };
    m.onBeforeCompile(sh);
    for (const n of NEEDLES_V) assert.ok(sh.vertexShader.includes(n), `${lit}: ${n}`);
    assert.ok(sh.fragmentShader.includes('texture2D(uAtlas, vAtlasUV)'), `${lit}: atlas sampled`);
    if (lit === 'standard') assert.ok(sh.vertexShader.includes('vec3 objectNormal = pplNrm();'));
    const src = sh.vertexShader + sh.fragmentShader;
    assert.ok(!/\bdiscard\b/.test(src) && !/\binout\b/.test(src) && !/\(\s*out\s/.test(src), lit);
    assert.ok(!/uniform\s+\w+\s+\w+\s*\[/.test(src.replace(/#include <[^>]+>/g, '')), 'no uniform arrays of our own');
    assert.ok(sh.uniforms.uVAT.value.isDataTexture && sh.uniforms.uAtlas.value);
    assert.equal(m.alphaTest, 0); assert.equal(m.transparent, false);
  }
  assert.equal(P.staticMaterial().alphaTest, 0);
});

test('figures: baked deck crew merged into one mesh, standing on their spots', () => {
  const m = P.makeFigures([{ x: 3, y: 5, z: -2, yaw: 1, look: P.lookFor('deckcrew', 1) }, { x: -4, y: 12, z: 8, yaw: 0, look: P.lookFor('officer', 2), clip: 'idle', phase: 0.3 }]);
  assert.ok(m.isMesh && !m.isInstancedMesh); assert.equal(m.userData.tris, 2 * P.bodyGeometry(1, {}).userData.tris);
  m.geometry.computeBoundingBox(); const bb = m.geometry.boundingBox;
  assert.ok(Math.abs(bb.min.y - 5) < 0.05 && bb.max.y > 12 + 1.5, `${bb.min.y} … ${bb.max.y}`);
  assert.ok(m.geometry.attributes.uv && m.geometry.attributes.color && m.material.vertexColors && m.material.userData.shared);
  m.geometry.dispose();
});

test('captain: a SkinnedMesh with 19 bones, gait + idle, head follows the look, faces −z, disposes', () => {
  const g = P.makeCaptain();
  const mesh = g.userData.mesh; assert.ok(mesh.isSkinnedMesh); assert.equal(mesh.skeleton.bones.length, 19);
  assert.ok(mesh.geometry.index.count / 3 >= 1200 && mesh.geometry.index.count / 3 <= 2200);
  let bob = 0; for (let i = 0; i < 40; i++) bob = g.userData.animate(1 / 30, true, i > 20); assert.equal(bob, 0);
  for (const b of mesh.skeleton.bones) for (const v of [b.rotation.x, b.rotation.y, b.rotation.z, b.position.y]) assert.ok(Number.isFinite(v));
  g.userData.look(0.8, 0.3); for (let i = 0; i < 30; i++) g.userData.animate(1 / 30, false, false);
  assert.ok(g.userData.bones[P.BONE.head].rotation.y < -0.2, 'turns the head toward the camera (+yaw = right = −y on the bone)');
  assert.equal(g.userData.body.rotation.y, Math.PI, 'built facing +z, turned to face −z');
  g.userData.dispose();
  const b = P.makeBoarder(2); assert.ok(b.children[0].isGroup, 'children[0] is the body (hostile.js sways it)'); b.userData.animate(0.1); b.userData.dispose();
});

test('budget: people GPU memory (atlas + both VATs) within 6 MB desktop / 3 MB phone', () => {
  const d = P.peopleBytes('desktop'), p = P.peopleBytes('phone');
  assert.ok(d.total <= 6 * 1048576, `${d.total}`); assert.ok(p.total <= 3 * 1048576, `${p.total}`); assert.ok(p.atlas <= 1.5 * 1048576);
});
