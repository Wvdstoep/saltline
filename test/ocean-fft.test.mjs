// FFT ocean (desktop tier): spectrum normalisation, Stockham FFT indexing, cascade bands, budgets, fallback, governor,
// and the physics surface (heightAt) staying byte-identical to the Gerstner sea the ships have always ridden.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Ocean, OCEAN_SHADERS, SEA_RUNGS, FFT_RUNGS, seaBudget, seaShader } from '../public/js/ocean2.js';
import { budgetFits } from '../public/js/glslbudget.js';
import { fftStockhamCPU, fftBands, fftNormalise, fftMemoryBytes, jonswapS, specParts, travelVec, FFT_L, FFT_SHADERS } from '../public/js/oceanfft.js';

const fakeScene = () => ({ add() {}, remove() {}, fog: null });
const SEAS = [
  { U: 3, dirW: 60, tp: 4.8, hsW: 0.9, hsS: 0.6, swellT: 11, dirS: 60 },
  { U: 8, dirW: 20, tp: 6.1, hsW: 2.2, hsS: 0.8, swellT: 11, dirS: 20 },
  { U: 22, dirW: 120, tp: 10, hsW: 9, hsS: 3.4, swellT: 13, dirS: 100 },
];

test('Stockham pass sequence (as in the shader) is the unnormalised inverse DFT', () => {
  const N = 64, re = [], im = [];
  for (let i = 0; i < N; i++) { re.push(Math.sin(i * 1.3) + 0.01 * i * i); im.push(Math.cos(i * 0.7) - 0.2); }
  const out = fftStockhamCPU(re, im);
  for (let n = 0; n < N; n++) {
    let xr = 0, xi = 0;
    for (let m = 0; m < N; m++) { const t = (2 * Math.PI * m * n) / N; xr += re[m] * Math.cos(t) - im[m] * Math.sin(t); xi += re[m] * Math.sin(t) + im[m] * Math.cos(t); }
    assert.ok(Math.abs(xr - out.re[n]) < 1e-9 && Math.abs(xi - out.im[n]) < 1e-9, `bin ${n}`);
  }
});

test('cascade bands are contiguous, start at 0 and stay below each patch Nyquist', () => {
  for (const [n, nc] of [[256, 3], [128, 3], [128, 2]]) {
    const b = fftBands(n, nc);
    assert.equal(b[0][0], 0);
    for (let c = 1; c < nc; c++) assert.equal(b[c][0], b[c - 1][1]);
    for (let c = 0; c < nc; c++) {
      assert.ok(b[c][1] > b[c][0], `${n}/${nc}: cascade ${c} empty`);
      assert.ok(b[c][1] < (Math.PI * n) / FFT_L[c], `${n}/${nc}: cascade ${c} above Nyquist`);
    }
    if (nc < 3) assert.equal(b[2][1], b[2][0], 'a dropped cascade has an empty band');
  }
  assert.ok(FFT_L[0] / FFT_L[1] % 1 && FFT_L[1] / FFT_L[2] % 1, 'patches are incommensurate (no common tiling)');
});

test('spectrum: JONSWAP peaks at ωp; the wind sea travels downwind; Hs matches the Gerstner target exactly', () => {
  for (const wp of [0.6, 1.2, 2]) {
    let best = 0, arg = 0;
    for (let w = 0.2; w < 6; w += 0.001) { const s = jonswapS(w, wp); if (s > best) { best = s; arg = w; } }
    assert.ok(Math.abs(arg / wp - 1) < 0.02, `peak at ${arg} for ωp ${wp}`);
  }
  const [dx, dz] = travelVec(60), sp = { wpW: 2 * Math.PI / 6, dxW: dx, dzW: dz, wpS: 0, dxS: 0, dzS: 0 };
  let down = 0, all = 0;
  for (let j = -60; j <= 60; j++) for (let i = -60; i <= 60; i++) {
    const kx = i * 0.01, kz = j * 0.01, e = specParts(kx, kz, sp)[0];
    all += e; if (kx * dx + kz * dz > 0) down += e;
  }
  assert.ok(down / all > 0.9, `downwind share ${(down / all).toFixed(3)}`);
  for (const p of SEAS) for (const [n, nc] of [[256, 3], [128, 3], [128, 2]]) {
    const r = fftNormalise(p, n, nc);
    const tot = Math.hypot(...r.hs), want = Math.hypot(p.hsW, p.hsS);
    assert.ok(Math.abs(tot / want - 1) < 0.01, `U${p.U} ${n}/${nc}: Hs ${tot.toFixed(3)} vs ${want.toFixed(3)}`);
    assert.ok(r.hs[0] / want > 0.95, `U${p.U}: the long cascade carries the sea (${(r.hs[0] / want).toFixed(3)})`);
    assert.ok(r.boost >= 0.25 && r.boost <= 6);
    for (let c = 0; c < 2; c++) assert.ok(r.chop[c] * Math.sqrt(r.mss[c]) <= 0.3201, `chop cap c${c}`);
    assert.ok(r.sigJ > 0 && r.sigJ < 0.46, `σJ ${r.sigJ}`);
    // total mean-square slope ≈ Cox–Munk for the wind once the short cascade is on (glitter calibrated)
    if (nc === 3) { const cm = 0.003 + 0.00512 * p.U, mss = r.mss[0] + r.mss[1] + r.mss[2]; assert.ok(mss > 0.9 * cm && mss < 1.6 * cm, `mss ${mss.toFixed(4)} vs Cox–Munk ${cm.toFixed(4)}`); }
  }
});

test('render-target memory stays within 24 MB (with the foam targets) at 256² × 3; 128² is a quarter', () => {
  const foam = 2 * 512 * 512 * 4;
  assert.ok(fftMemoryBytes(256, 3) + foam <= 24 * 1048576, `${((fftMemoryBytes(256, 3) + foam) / 1048576).toFixed(1)} MB`);
  assert.ok(fftMemoryBytes(128, 3) < 6 * 1048576 && fftMemoryBytes(128, 2) < fftMemoryBytes(128, 3));
});

test('FFT shaders: desktop-only rungs, no Gerstner arrays, budget fits a 512-vector desktop with room for shadows', () => {
  for (const r of FFT_RUNGS) assert.ok(!SEA_RUNGS.flat().includes(r), 'phones never get an FFT rung');
  const s = OCEAN_SHADERS.fft;
  assert.ok(!/uWaveA|uDet\[/.test(s.vert + s.frag), 'the FFT build reads no Gerstner / ripple uniform arrays');
  assert.ok(/textureLod\(uFftD0/.test(s.vert) && /texture2D\(uFftC1/.test(s.frag));
  const DESK = { isWebGL2: true, precision: 'highp', maxFragmentUniforms: 1024, maxVertexUniforms: 4096, maxVaryings: 30, maxTextures: 16, maxVertexTextures: 16 };
  for (const r of FFT_RUNGS) {
    const b = seaBudget(2, r);
    assert.ok(budgetFits(b, DESK, 32), `${r.name} fits a desktop`);
    assert.ok(b.fragment.samplers <= 12, `${r.name}: ${b.fragment.samplers} fragment samplers (≤ 12 leaves 4 of 16 for the sun shadow maps)`);
    assert.ok(b.vertex.samplers <= 4 && b.fragment.uniforms <= 480);
  }
  for (const k of ['evolve', 'fft', 'assemble', 'probe']) assert.ok(!/\bfor\s*\(/.test(FFT_SHADERS[k]), `${k}: no loops`);
});

test('fallback: phones and GPUs without float render targets never start the FFT; the Gerstner full rung is drawn', () => {
  const PHONE = { isWebGL2: true, precision: 'highp', maxFragmentUniforms: 256, maxVertexUniforms: 256, maxVaryings: 31, maxTextures: 16, maxVertexTextures: 16 };
  const o1 = new Ocean(fakeScene()); o1.init({ capabilities: PHONE });
  assert.equal(o1.fft, null); assert.match(String(o1.diag().fft), /phone/);
  const o2 = new Ocean(fakeScene()); o2.init({ capabilities: { ...PHONE, maxFragmentUniforms: 1024, maxVertexUniforms: 4096 }, extensions: { has: () => false } });
  assert.equal(o2.fft, null); assert.match(String(o2.diag().fft), /unsupported/);
  assert.ok(o2.diag().tierLog.some((l) => /fft: unsupported/.test(l)));
  assert.equal(o2.rungsOf(2), SEA_RUNGS[2], 'no FFT rungs offered');
});

test('governor sizes the FFT: q 1 → base N × 3, 0.75 → 128 × 3, 0.5 → 128 × 2', () => {
  const o = new Ocean(fakeScene());
  const calls = [];
  o.fft = { n: 0, nc: 0, memoryBytes: 0, setSize(n, nc) { const ch = n !== this.n || nc !== this.nc; this.n = n; this.nc = nc; calls.push([n, nc]); return ch; }, dispose() {} };
  o.fftBaseN = 256;
  o.setQuality(1); assert.deepEqual([o.fft.n, o.fft.nc], [256, 3]);
  o.setQuality(0.75); assert.deepEqual([o.fft.n, o.fft.nc], [128, 3]);
  o.setQuality(0.5); assert.deepEqual([o.fft.n, o.fft.nc], [128, 2]);
  o.fftBaseN = 128; o.setQuality(1); assert.deepEqual([o.fft.n, o.fft.nc], [128, 3]);
  assert.ok(o.diag().tierLog.some((l) => /fft: 128² × 2 cascades/.test(l)));
});

// Golden values recorded from the Gerstner code BEFORE the FFT ocean was added: ship motion must not move by one bit.
const GOLD = [
  [{ windSpd: 3, windDir: 240, waveH: 0, wavePeriod: 4.8 }, [-0.11139309945431432, -0.02398817935006558, -0.44574648719783305, -0.4477097428365068]],
  [{ windSpd: 8, windDir: 200 }, [-0.1958856387900881, -0.24002605436656685, 0.5266332181864767, 0.6539794908657178]],
  [{ windSpd: 22, windDir: 300, waveH: 6, wavePeriod: 10, swellH: 2, swellDir: 280, swellPeriod: 13, storm: 1 }, [-2.5398915761982934, -2.779448699033261, -3.590800121045295, -1.3862650197117414]],
];
test('heightAt (ship motion) is byte-identical to the pre-FFT Gerstner sea', () => {
  const P = [[0, 0, 1], [12.5, -7.25, 1.5], [-300, 410, 7.75], [1234.5, -987.25, 100.125]];
  for (const [sea, want] of GOLD) {
    const o = new Ocean(fakeScene()); o.setSea(sea); o.snapSea();
    for (let i = 0; i < 30; i++) o.update(i / 30, 10, 20, 1 / 30);
    P.forEach(([x, z, t], i) => assert.equal(o.heightAt(x, z, t), want[i], `${JSON.stringify(sea)} @ ${x},${z},${t}`));
  }
});

test('the FFT is tuned to the significant height of the surface the ships ride', () => {
  for (const sea of [{ windSpd: 8, windDir: 200 }, { windSpd: 18, windDir: 300, waveH: 4, wavePeriod: 9, swellH: 1.5, swellDir: 280, swellPeriod: 12 }]) {
    const o = new Ocean(fakeScene()); o.setSea(sea); o.snapSea(); o.update(0, 0, 0, 1 / 60);
    const p = o.fftSeaParams(), want = Math.hypot(p.hsW, p.hsS);
    // measured Hs of heightAt over a large grid and many instants (4·std of the elevation)
    let s = 0, s2 = 0, n = 0;
    for (let t = 0; t < 600; t += 37) for (let j = 0; j < 24; j++) for (let i = 0; i < 24; i++) { const h = o.heightAt(i * 97.3, j * 89.1, t) - o.level; s += h; s2 += h * h; n++; }
    const hsPhys = 4 * Math.sqrt(s2 / n - (s / n) ** 2);
    assert.ok(Math.abs(hsPhys / want - 1) < 0.15, `heightAt Hs ${hsPhys.toFixed(2)} vs FFT target ${want.toFixed(2)}`);
    const r = fftNormalise(p, 256, 3);
    assert.ok(Math.abs(Math.hypot(...r.hs) / want - 1) < 0.01);
  }
});

test('sun shadow hook (lighting.js contract): only the FFT build samples it; a failed / missing hook leaves the sea unshadowed', () => {
  const glsl = 'uniform float slShadowN;\nfloat saltlineShadow( vec3 worldPos ) { return slShadowN > 0.5 ? 0.5 : 1.0; }\n';
  const sh = { glsl, fn: 'saltlineShadow' };
  const f = seaShader(2, FFT_RUNGS[0], { shadow: sh }).frag;
  assert.ok(f.includes('float sunVis = clamp(saltlineShadow(vWorld), 0.0, 1.0);') && /sunUp \* sunVis/.test(f) && /crestPow \* sunVis/.test(f));
  assert.equal(seaShader(2, SEA_RUNGS[2][0], { shadow: sh }).frag, OCEAN_SHADERS.full.frag, 'the Gerstner build is untouched');
  assert.ok(!/sunVis/.test(OCEAN_SHADERS.fft.frag), 'no hook → no shadow code');
  const U = { slShadowN: { value: 1 } };
  const o = new Ocean(fakeScene());
  assert.equal(o.attachLighting(null), false);
  assert.equal(o.attachLighting({ oceanShadowOk: false, shadowUniforms: () => U, shadowGLSL: glsl }), false, 'its own self-test failed');
  assert.equal(o.attachLighting({ oceanShadowOk: true, shadowUniforms: () => U, shadowGLSL: glsl }), true);
  assert.equal(o.uniforms.slShadowN, U.slShadowN, 'the lighting\'s live uniform objects are shared, not copied');
  assert.match(o.fftDiag(), /off/, 'no FFT without a renderer');
});
