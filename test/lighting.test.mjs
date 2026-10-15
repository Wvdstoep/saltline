// The lighting pipeline's pure parts (public/js/lighting.js): the CSM chunk patch, the display->scene inverse, the
// cascade geometry and the quality ladder. three.js runs in node (no WebGL needed for these).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { patchLightsChunk, injectDisplayInverse, displayToScene, sliceSphere, lightBasis, snapCenter, qualityLadder, PRESETS, SHADOW_GLSL } from '../public/js/lighting.js';
import { acesTone, linearToSrgb } from '../public/js/skywx.js';

test('the r160 lights chunk is patched at import: cascade selection, constant indices only', () => {
  const src = THREE.ShaderChunk.lights_fragment_begin;
  assert.ok(src.includes('float slCsmTaken = 0.0;'), 'selection flag declared');
  assert.ok(src.includes('UNROLLED_LOOP_INDEX == NUM_DIR_LIGHT_SHADOWS - 1'), 'last cascade is the fallback');
  assert.equal(patchLightsChunk(src), src, 'patching twice is a no-op');
  assert.equal(patchLightsChunk('unrelated chunk'), null, 'unknown text is refused (shadows then stay off)');
  for (const bad of [/\binout\b/, /\bdiscard\b/]) assert.ok(!bad.test(src.split('slCsmTaken')[1] || ''), `no ${bad} in the patch`);
});

test('ocean shadow GLSL: no loops, no inout, no discard, no runtime-indexed arrays', () => {
  assert.ok(!/\bfor\s*\(|\bwhile\b|\binout\b|\bdiscard\b|\[\s*[a-z]/i.test(SHADOW_GLSL));
  assert.ok(SHADOW_GLSL.includes('float saltlineShadow( vec3 worldPos )'));
});

test('display-value shaders: the inverse is injected at the end of main(), only where it applies', () => {
  const f = 'uniform vec3 c;\nvoid main() {\n  gl_FragColor = vec4( c, 1.0 );\n}\n';
  const out = injectDisplayInverse(f);
  assert.ok(out && out.includes('slDisplayToScene( gl_FragColor.rgb )') && out.trim().endsWith('}'));
  assert.ok(out.indexOf('uniform float slPostInv') < out.indexOf('void main'));
  assert.equal(injectDisplayInverse(f.replace('}', '#include <colorspace_fragment>\n}')), null, 'colour-managed shaders untouched');
  assert.equal(injectDisplayInverse(out), null, 'never twice');
});

test('display->scene inverse round-trips through ACES + sRGB (what OutputPass does)', () => {
  for (const d of [[0.1, 0.1, 0.1], [0.5, 0.4, 0.3], [0.8, 0.85, 0.9], [0.2, 0.6, 0.9]]) {
    for (const exp of [1, 0.6]) {
      const x = displayToScene(d, exp);
      const back = acesTone(x, exp).map(linearToSrgb);
      for (let i = 0; i < 3; i++) assert.ok(Math.abs(back[i] - d[i]) < 0.02, `d=${d} exp=${exp} -> ${back}`);
    }
  }
});

test('cascade spheres: fixed radius per slice, the far slices clamp to the far plane', () => {
  const a = sliceSphere(0, 400, 60, 16 / 9), b = sliceSphere(0, 2500, 60, 16 / 9);
  assert.ok(a.r > 400 && a.r < 600, `r400 ${a.r}`);
  assert.ok(b.r > 2500 && b.r < 3500, `r2500 ${b.r}`);
  const c = sliceSphere(100, 110, 20, 1);   // thin, narrow slice: centre inside it
  assert.ok(c.z >= 100 && c.z <= 110);
  // every corner of the slice is inside the sphere
  for (const [n, f] of [[0, 400], [60, 400], [400, 2500]]) {
    const s = sliceSphere(n, f, 60, 16 / 9), t = Math.tan(Math.PI / 6);
    for (const d of [n, f]) { const h = d * t, w = h * 16 / 9; assert.ok(Math.hypot(d - s.z, h, w) <= s.r + 1e-6); }
  }
});

test('texel snapping: the snapped centre sits on the light-space grid and moves in whole texels', () => {
  const B = lightBasis(new THREE.Vector3(0.4, 0.6, -0.3));
  assert.ok(Math.abs(B.x.dot(B.z)) < 1e-9 && Math.abs(B.y.dot(B.z)) < 1e-9);
  const texel = 0.07;
  const s1 = snapCenter(new THREE.Vector3(12.345, 3.2, -40.01), B, texel), s2 = snapCenter(new THREE.Vector3(12.36, 3.2, -40.0), B, texel);
  for (const s of [s1, s2]) for (const ax of [B.x, B.y]) { const k = s.dot(ax) / texel; assert.ok(Math.abs(k - Math.round(k)) < 1e-6); }
  assert.ok(s1.distanceTo(s2) < 2 * texel);
});

test('quality ladder: bloom resolution first, then AO, then cascades, bloom last', () => {
  const H = PRESETS.high;
  assert.deepEqual(qualityLadder(1, H), { cascades: 3, bloom: 1, ao: true });
  assert.deepEqual(qualityLadder(0.8, H), { cascades: 3, bloom: 0.5, ao: true });
  assert.deepEqual(qualityLadder(0.6, H), { cascades: 3, bloom: 0.5, ao: false });
  assert.deepEqual(qualityLadder(0.45, H), { cascades: 2, bloom: 0.5, ao: false });
  assert.deepEqual(qualityLadder(0.3, H), { cascades: 1, bloom: 0.35, ao: false });
  assert.deepEqual(qualityLadder(0.1, H), { cascades: 1, bloom: 0, ao: false });
  const P = PRESETS.phone;
  assert.equal(qualityLadder(1, P).cascades, 1); assert.equal(qualityLadder(1, P).ao, false);
});
