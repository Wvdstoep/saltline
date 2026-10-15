// Sea rendering: mobile-safe shader tiers, ripple / glitter energy, analytic Kelvin wakes and the local wake simulation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Ocean, OCEAN_SHADERS, SEA_RUNGS, seaShader, seaBudget } from '../public/js/ocean2.js';
import { glslBudget, budgetFits } from '../public/js/glslbudget.js';
import { buildWaveKernel, kernelResponse, maxStableDt, stepCPU, hullShape, hullHead, convolutionGLSL } from '../public/js/wakesim.js';

const fakeScene = () => ({ add() {}, remove() {}, fog: null });

// ---------------------------------------------------------------------------------------------- shader hygiene
// A phone GPU (Adreno 660 through ANGLE: 256 uniform vectors per stage, 31 varyings) must link every rung it may be
// given. Budget per stage: 224 vec4 (32 below 256), 28 varyings; counted the conservative way (glslbudget.js: every
// scalar / vec takes a whole row, arrays count every element, three.js's own uniforms and fog / tone mapping included).
const PHONE = { isWebGL2: true, precision: 'highp', maxFragmentUniforms: 256, maxVertexUniforms: 256, maxVaryings: 31, maxTextures: 16, maxVertexTextures: 16 };
const DESKTOP = { ...PHONE, maxFragmentUniforms: 1024, maxVertexUniforms: 4096, maxVaryings: 30 };

test('glslBudget: counts three.js built-ins, arrays, only used uniforms, and varyings', () => {
  const vert = '#define N 4\nuniform vec4 uA[N]; uniform float uUnused; uniform mat3 uM;\nvarying vec3 vP; varying float vQ;\n#include <fog_pars_vertex>\nvoid main() { vec4 mvPosition = viewMatrix * vec4(uM * uA[1].xyz, 1.0); vP = mvPosition.xyz; vQ = 1.0; gl_Position = projectionMatrix * mvPosition;\n#include <fog_vertex>\n}';
  const frag = 'uniform vec3 uC;\nvarying vec3 vP; varying float vQ;\n#include <fog_pars_fragment>\nvoid main() { gl_FragColor = vec4(uC * vP * vQ, 1.0);\n#include <tonemapping_fragment>\n#include <fog_fragment>\n}';
  const b = glslBudget(vert, frag);
  assert.equal(b.vertex.uniforms, 4 + 3 + 4 + 4, 'uA[4] + mat3 + viewMatrix + projectionMatrix; uUnused is not counted');
  assert.equal(b.fragment.uniforms, 1 + 3 + 1, 'uC + fogColor/fogNear/fogFar + toneMappingExposure');
  assert.equal(b.varyings, 3, 'vP, vQ, vFogDepth');
  assert.ok(budgetFits(b, PHONE) && !budgetFits({ ...b, fragment: { ...b.fragment, uniforms: 240 } }, PHONE));
});

test('every sea shader rung fits a 256-vector phone GPU with 32 vectors to spare', () => {
  for (let lvl = 0; lvl < 3; lvl++) {
    for (const r of SEA_RUNGS[lvl]) {
      const b = seaBudget(lvl, r);
      assert.ok(b.vertex.uniforms <= 224, `${r.name}: vertex needs ${b.vertex.uniforms} uniform vectors`);
      assert.ok(b.fragment.uniforms <= 224, `${r.name}: fragment needs ${b.fragment.uniforms} uniform vectors`);
      assert.ok(b.varyings <= 28, `${r.name}: ${b.varyings} varyings`);
      assert.ok(b.fragment.samplers <= 8 && b.vertex.samplers <= 2, `${r.name}: samplers ${b.vertex.samplers}+${b.fragment.samplers}`);
    }
  }
  // the lite tier is the phone's safety net: a wide margin, not a scrape
  for (const r of SEA_RUNGS[1]) {
    const b = seaBudget(1, r);
    assert.ok(Math.max(b.vertex.uniforms, b.fragment.uniforms) <= 128, `${r.name}: lite must fit in half the phone's 256 (${b.vertex.uniforms}/${b.fragment.uniforms})`);
  }
});

test('sea shader rungs: a uniform declared in both stages is declared identically (else the program does not link)', () => {
  const decls = (src) => {
    const out = new Map();
    const defs = Object.fromEntries([...src.matchAll(/#define\s+(\w+)\s+(\d+)/g)].map((m) => [m[1], m[2]]));
    for (const m of src.matchAll(/\buniform\s+(\w+)\s+([^;]+);/g)) {
      for (const part of m[2].split(',')) {
        const pm = part.trim().match(/^(\w+)\s*(?:\[\s*(\w+)\s*\])?/);
        if (pm) out.set(pm[1], `${m[1]}[${pm[2] ? defs[pm[2]] ?? pm[2] : 1}]`);
      }
    }
    return out;
  };
  for (let lvl = 0; lvl < 3; lvl++) {
    for (const r of SEA_RUNGS[lvl]) {
      const s = seaShader(lvl, r), v = decls(s.vert), f = decls(s.frag);
      for (const [name, t] of v) if (f.has(name)) assert.equal(f.get(name), t, `${r.name}: ${name} is ${t} in the vertex and ${f.get(name)} in the fragment shader`);
    }
  }
});

test('GPU limits pick the rung: desktop keeps the full look, a 256-vector phone starts on full-lean, mediump gets vertex lite', () => {
  const pick = (caps) => { const o = new Ocean(fakeScene()); o.init({ capabilities: caps }); return o; };
  const d = pick(DESKTOP);
  assert.equal(d.matLevel, 2); assert.equal(SEA_RUNGS[2][d.rung[2]].name, 'full');
  assert.match(d.diag().budget.full, /^full V\d+\/F\d+ vec4/);
  const p = pick(PHONE);
  assert.equal(p.matLevel, 2); assert.equal(SEA_RUNGS[2][p.rung[2]].name, 'full-lean');
  assert.equal(p.matOk[0], true, 'the basic tier is self-tested too (never "untested")');
  assert.ok(p.tierLog.some((l) => /full: skipped/.test(l)));
  const m = pick({ ...PHONE, isWebGL2: false, precision: 'mediump', maxFragmentUniforms: 224 });
  assert.equal(m.matLevel, 1); assert.equal(SEA_RUNGS[1][m.rung[1]].name, 'lite-vertex');
});

test('a rung that fails to link steps to the next rung of the same tier before dropping a tier', () => {
  const o = new Ocean(fakeScene());
  o.init({ capabilities: PHONE });
  o.failTier(2, 'program failed to link: (empty log)');
  assert.equal(o.matLevel, 2); assert.equal(SEA_RUNGS[2][o.rung[2]].name, 'full-min');
  assert.equal(o.mesh.material, o.mats[2]); assert.equal(o.mesh.material.name, 'ocean-full-min');
  o.failTier(2, 'again');
  assert.equal(o.matLevel, 1, 'no full rung left → lite');
  assert.equal(o.mesh.material.name, 'ocean-lite');
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

test('own ship track: a turning ship leaves a curved, evenly resampled track that feeds Kelvin slot 0', () => {
  const o = new Ocean(fakeScene());
  o.setSea({ windSpd: 6, windDir: 240, waveH: 0.5, wavePeriod: 5 });
  const key = {}, R = 150, U = 7;   // a full circle of 150 m radius at ~13.6 kn
  let t = 0;
  for (let i = 0; i < 60 * 70; i++) {
    t += 1 / 60;
    const a = (U * t) / R;
    o.feedShip(key, { x: R * Math.sin(a), z: -R * Math.cos(a) + R, hdg: Math.PI / 2 + a, spd: U / 0.514444, length: 60, beam: 10, own: true });
    if (i % 4 === 0) o.update(t, 0, 0, 4 / 60); 
  }
  const P = o.trackPts;
  assert.equal(P.length, 16);
  assert.equal(P[0].age, 0);
  for (let j = 1; j < P.length; j++) { assert.ok(P[j].s > P[j - 1].s && P[j].age >= P[j - 1].age, 'newest first, metres and age grow'); assert.ok(Math.abs(Math.hypot(P[j].x, P[j].z - R) - R) < 3, 'points lie on the circle'); }
  assert.equal(o.kel[0].trk, 1);
  o.prepare(null, { matrixWorld: { elements: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,30,0,1] } });
  assert.equal(o.uniforms.uTrkN.value, 16); assert.equal(o.uniforms.uKelC.value[0].w, 1);
});

test('moon glitter and searchlight pools are fed to the uniforms (and cleared)', () => {
  const o = new Ocean(fakeScene());
  o.setMoon({ x: 0, y: 2, z: 0 }, { r: 1, g: 1, b: 0.9 });
  assert.ok(Math.abs(o.uniforms.uMoonDir.value.y - 1) < 1e-9 && o.uniforms.uMoonCol.value.r > 0 && o.uniforms.uMoonCol.value.r < 1, 'a dim second light');
  o.setMoon(null, null); assert.equal(o.uniforms.uMoonCol.value.r, 0);
  const spot = { pos: { x: 1, y: 8, z: 2 }, dir: { x: 0, y: -1, z: 0 }, color: { r: 1, g: 1, b: 1 }, cone: 0.95, range: 120 };
  o.setSpotLights([spot, spot, spot]); assert.equal(o.uniforms.uSpotN.value, 2, 'at most two');
  assert.equal(o.uniforms.uSpot.value[0].w, 120);
  o.setSpotLights([]); assert.equal(o.uniforms.uSpotN.value, 0);
});
