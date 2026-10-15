// Sea rendering: mobile-safe shader tiers, ripple / glitter energy, analytic Kelvin wakes and the local wake simulation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Ocean, OCEAN_SHADERS } from '../public/js/ocean2.js';
import { buildWaveKernel, kernelResponse, maxStableDt, stepCPU, hullShape, hullHead, convolutionGLSL } from '../public/js/wakesim.js';

const fakeScene = () => ({ add() {}, remove() {}, fog: null });

// ---------------------------------------------------------------------------------------------- shader hygiene
/** Uniform rows a GLSL ES implementation may need, unpacked (each declaration / array element = its own rows). */
function uniformRows(src) {
  const rows = { float: 1, int: 1, bool: 1, vec2: 1, vec3: 1, vec4: 1, mat2: 2, mat3: 3, mat4: 4 };
  const defs = Object.fromEntries([...src.matchAll(/#define\s+(\w+)\s+(\d+)/g)].map((m) => [m[1], +m[2]]));
  let n = 0;
  for (const m of src.matchAll(/uniform\s+(\w+)\s+([^;]+);/g)) {
    if (!(m[1] in rows)) continue; // samplers live in texture units
    for (const part of m[2].split(',')) {
      const a = part.match(/\[(\w+)\]/);
      n += rows[m[1]] * (a ? (/^\d+$/.test(a[1]) ? +a[1] : defs[a[1]]) : 1);
    }
  }
  return n;
}
const THREE_FRAG_BUILTINS = 7 + 4; // viewMatrix, cameraPosition, isOrthographic, toneMappingExposure + fog uniforms

test('sea shaders fit the uniform budgets their tier is chosen for', () => {
  const full = uniformRows(OCEAN_SHADERS.full.frag + OCEAN_SHADERS.full.cut) + THREE_FRAG_BUILTINS;
  const lite = uniformRows(OCEAN_SHADERS.lite.frag + OCEAN_SHADERS.lite.cut) + THREE_FRAG_BUILTINS;
  const liteV = uniformRows(OCEAN_SHADERS.lite.vert) + 20;
  assert.ok(full <= 200, `full fragment shader needs ${full} uniform vectors (init() requires 200, WebGL2 guarantees 224)`);
  assert.ok(lite <= 64, `lite fragment shader needs ${lite} uniform vectors (init() requires 64)`);
  assert.ok(liteV <= 96, `lite vertex shader needs ${liteV} uniform vectors (init() requires 96)`);
});

test('sea shaders: constant loop bounds, no continue, no reversed smoothstep edges', () => {
  for (const [tier, s] of Object.entries(OCEAN_SHADERS)) {
    for (const [stage, src] of Object.entries(s)) {
      assert.ok(!/\bcontinue\s*;/.test(src), `${tier}.${stage}: continue in a loop`);
      for (const m of src.matchAll(/for\s*\(\s*int\s+\w+\s*=\s*\w+\s*;\s*\w+\s*<\s*(\w+)/g)) assert.ok(/^(\d+|N\w*|MAX\w*)$/.test(m[1]), `${tier}.${stage}: loop bound ${m[1]} is not a constant`);
      for (const m of src.matchAll(/smoothstep\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,/g)) assert.ok(+m[1] < +m[2], `${tier}.${stage}: smoothstep(${m[1]}, ${m[2]}) has edge0 >= edge1 (undefined on some GPUs)`);
    }
  }
});

test('wake simulation step shader is generated from the kernel', () => {
  const K = buildWaveKernel();
  const g = convolutionGLSL(K);
  assert.equal((g.match(/HP\(/g) || []).length, K.taps.reduce((s, t) => s + (t.i || t.j ? (t.i === t.j || !t.j ? 4 : 8) : 1), 0));
  assert.ok(!/NaN|Infinity/.test(g));
});

// ---------------------------------------------------------------------------------------------- kernel / sim
test('wave kernel: no response to a uniform raise, deep-water dispersion on its working band, isotropic', () => {
  const K = buildWaveKernel();
  assert.ok(Math.abs(kernelResponse(K, 0, 0)) < 1e-9);
  for (let k = 0.6; k <= 1.6; k += 0.2) {
    const r = (K.cal * kernelResponse(K, k, 0)) / k;
    assert.ok(r > 0.8 && r < 1.2, `k=${k.toFixed(1)}: cal·R/k = ${r.toFixed(3)}`);
    const d = kernelResponse(K, k * Math.SQRT1_2, k * Math.SQRT1_2) / kernelResponse(K, k, 0);
    assert.ok(Math.abs(d - 1) < 0.08, `anisotropy ${d.toFixed(3)} at k=${k.toFixed(1)}`);
  }
  assert.ok(maxStableDt(K, 0.5) > 1 / 60, 'a 60 Hz step is stable down to 0.5 m texels');
});

test('hull footprint: full at the centre, zero outside, fine bow', () => {
  assert.equal(hullShape(0, 0), 1);
  assert.equal(hullShape(1.01, 0), 0);
  assert.equal(hullShape(0, 1.01), 0);
  assert.ok(hullShape(0.8, 0.5) < hullShape(-0.8, 0.5), 'the bow is finer than the stern');
  assert.ok(hullHead(12, 50) <= 5 && hullHead(2, 8) > 0.5);
});

function runSim(steps, U, settle = 0) {
  const K = buildWaveKernel(), n = 96, dx = 1.2;
  const st = { n, dx, h: new Float64Array(n * n), hp: new Float64Array(n * n), P: new Float64Array(n * n) };
  const len = 30, beam = 6, head = hullHead(2, beam), dt = 1 / 30;
  let x = n * dx * 0.8; const z = (n * dx) / 2;
  for (let s = 0; s < steps + settle; s++) {
    if (s < steps) x -= U * dt;
    stepCPU(st, K, [{ x, z, fx: -1, fz: 0, hl: len / 2, hb: beam / 2, head: head * Math.min(1, (s * dt) / 3) }], dt);
  }
  let ahead = 0, behind = 0, mx = 0;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const v = st.h[j * n + i] + st.P[j * n + i], px = (i + 0.5) * dx;
    mx = Math.max(mx, Math.abs(v));
    if (px < x - len) ahead += v * v; else if (px > x + len) behind += v * v;
  }
  return { mx, ahead, behind, head };
}

test('wake simulation: a moving hull leaves waves behind it, bounded', () => {
  const r = runSim(240, 5);
  assert.ok(Number.isFinite(r.mx) && r.mx < r.head, `max dynamic height ${r.mx.toFixed(3)} m`);
  assert.ok(r.mx > 0.05, 'a hull at 10 kn makes a visible wave');
  assert.ok(r.behind > 3 * r.ahead, `wake energy behind ${r.behind.toFixed(2)} vs ahead ${r.ahead.toFixed(2)}`);
});

test('wake simulation: a hull that stops leaves ripples that settle', () => {
  const moving = runSim(150, 4, 0), settled = runSim(150, 4, 300);
  assert.ok(settled.mx < moving.mx * 0.6, `after 10 s stopped: ${settled.mx.toFixed(3)} m vs ${moving.mx.toFixed(3)} m under way`);
});

// ---------------------------------------------------------------------------------------------- ocean wiring
test('ships fed to the ocean get analytic Kelvin wakes; the ship motion field is untouched', () => {
  const o = new Ocean(fakeScene());
  o.setSea({ windSpd: 3, windDir: 240, waveH: 0, wavePeriod: 4.8 });
  o.update(1, 0, 0, 1 / 60);
  const h0 = o.heightAt(12, -7, 1.5);
  const key = {}, slow = {};
  o.feedShip(key, { x: 0, z: 0, hdg: Math.PI / 2, spd: 14, length: 80, beam: 14, draft: 5, throttle: 0.8, own: true });
  o.feedShip(slow, { x: 50, z: 50, hdg: 0, spd: 0.5, length: 20, beam: 5, draft: 2 });
  o.update(1.02, 0, 0, 1 / 60);
  assert.equal(o.kel.length, 1, 'a ship that barely moves makes no Kelvin wake');
  const k = o.kel[0], U = 14 * 0.514444;
  assert.ok(Math.abs(k.k0 - 9.81 / (U * U)) < 1e-9);
  assert.ok(Math.abs(k.fx - 1) < 1e-9 && Math.abs(k.fz) < 1e-9, 'heading 90° travels east (+x)');
  assert.ok(k.amp > 0.05 && k.amp <= 0.8);
  assert.equal(o.heightAt(12, -7, 1.5), h0, 'wakes are visual only: heightAt (ship motion) is unchanged');
  o.update(3, 0, 0, 1 / 60);
  assert.equal(o.ships.size, 0, 'ships not reported for a second are forgotten');
});

test('calm-sea glitter energy: ripples + residual carry what the spectrum does not (Cox–Munk)', () => {
  const o = new Ocean(fakeScene());
  for (const U of [1, 3, 8, 20]) {
    o.setSea({ windSpd: U, windDir: 240 }); o.snapSea(); o.refreshTable(0);
    const s = o.uniforms.uSig0.value, rip = (12 * o.detKa * o.detKa) / 2;
    const cm = 0.003 + 0.00512 * U;
    assert.ok(s.x > 0 && s.y > 0 && s.x * s.y > s.z * s.z, `U=${U}: residual covariance is positive definite`);
    assert.ok(rip + s.x + s.y <= cm * 1.0001, `U=${U}: ripples + residual never exceed Cox–Munk`);
  }
  o.setSea({ windSpd: 2, windDir: 240 }); o.refreshTable(0);
  assert.ok(o.uniforms.uPawC.value > 0.9, "light air: patchy cat's-paws");
  o.setSea({ windSpd: 12, windDir: 240 }); o.refreshTable(0);
  assert.equal(o.uniforms.uPawC.value, 0, 'a wind sea is rippled everywhere');
});

test('quality tiers: the lowest quality uses the lite shader, GPU limits cap the tier', () => {
  const o = new Ocean(fakeScene());
  assert.equal(o.matLevel, 2);
  o.setQuality(0.2);
  assert.equal(o.matLevel, 1);
  assert.equal(o.mesh.material, o.mats[1]);
  o.setQuality(1);
  assert.equal(o.matLevel, 2);
  // a WebGL1 / mediump phone: lite only (no renderer calls needed for the decision)
  o.init({ capabilities: { isWebGL2: false, precision: 'mediump', maxFragmentUniforms: 224, maxVertexUniforms: 256, maxVaryings: 15, maxTextures: 16, maxVertexTextures: 16 } });
  assert.equal(o.matLevel, 1);
  assert.equal(o.far.material, o.mats[1]);
});
