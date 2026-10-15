// FFT ocean (desktop tier): spectrum normalisation, Stockham FFT indexing, cascade bands, budgets, fallback, governor,
// and the physics surface (heightAt) staying byte-identical to the Gerstner sea the ships have always ridden.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Ocean, OCEAN_SHADERS, SEA_RUNGS, FFT_RUNGS, seaBudget, seaShader } from '../public/js/ocean2.js';
import { budgetFits } from '../public/js/glslbudget.js';
import { fftStockhamCPU, fftBands, fftNormalise, fftMemoryBytes, jonswapS, specParts, travelVec, FFT_L, FFT_SHADERS, fftComponents, T_REP } from '../public/js/oceanfft.js';

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
  assert.ok(/textureLod\(uFftD, vec3/.test(s.vert) && /texture\(uFftT1, vec3\(fu2, 2\.0\)\)/.test(s.frag), 'cascades are layers of array textures');
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

// three.js gives every sampler of a PROGRAM (vertex + fragment, the shadow chunk included) its own texture unit, and
// many desktop GPUs (ANGLE / D3D11) have exactly 16: the FFT rung with the sun-shadow chunk once needed 17 and three
// silently skipped the last one (~540 "Trying to use 16 texture units" warnings per load). Keep 2 units to spare.
test('texture units per sea program (vertex + fragment + sun-shadow chunk) stay ≤ 14', async () => {
  const { SHADOW_GLSL } = await import('../public/js/lighting.js');
  const SAMPLER = /uniform\s+(?:(?:lowp|mediump|highp)\s+)?(?:sampler2D|sampler2DArray|samplerCube|sampler3D|sampler2DShadow)\s+(\w+)/g;
  const units = (s) => new Set([...`${s.vert}\n${s.frag}`.matchAll(SAMPLER)].map((m) => m[1])).size;
  const shadow = { glsl: SHADOW_GLSL, fn: 'saltlineShadow' };
  const counts = {};
  for (let lvl = 0; lvl < 3; lvl++) for (const r of SEA_RUNGS[lvl]) for (const phone of [false, true]) {
    const n = units(seaShader(lvl, r, { phone })); counts[r.name] = n;
    assert.ok(n <= 14, `${r.name}${phone ? ' (phone)' : ''}: ${n} texture units`);
  }
  for (const r of FFT_RUNGS) {
    const n = units(seaShader(2, r, { shadow })); counts[`${r.name}+shadow`] = n;
    assert.ok(n <= 14, `${r.name} with the sun-shadow chunk: ${n} texture units`);
    assert.ok(seaShader(2, r, { shadow }).frag.includes('saltlineShadow(vWorld)'));
  }
  for (const k of ['foamFft', 'sprayFft']) assert.ok(units(OCEAN_SHADERS[k]) <= 6, `${k}: ${units(OCEAN_SHADERS[k])}`);
  assert.equal(counts['fft+shadow'], 13, 'fft + shadow: 7 sea + 3 cascade arrays + 3 shadow maps');
});

// ---------------------------------------------------------------------------------------------- ships ride the FFT
// An Ocean whose drawn sea is the FFT (as after init on a desktop GPU), without a GPU: the physics spectrum is set from
// fftNormalise exactly as the evolve pass's uniforms would be.
function fftOcean(sea) {
  const o = new Ocean(fakeScene()); o.setSea(sea); o.snapSea(); o.update(0, 0, 0, 1 / 60);
  o.fftReady = true; o.rung[2] = -1; o.setRung(2, 0); o.fft = { n: 256, nc: 3, dispose() {} };
  const p = o.fftSeaParams(), N = fftNormalise(p, 256, 3);
  const U = { lo: N.bands.map((b) => b[0]), hi: N.bands.map((b) => b[1]), boost: [1, 1, N.boost], wind: [N.aW, N.wpW, ...N.dirW], swell: [N.aS, N.wpS || 1, ...N.dirS] };
  o.physFromSpectrum(U, N.chop, 256, 3);
  return { o, hs: Math.hypot(p.hsW, p.hsS), U };
}
// the drawn surface by direct summation of every wave the mesh shows (no grid, no interpolation), same inversion
function drawnHeight(o, x, z, t) {
  const g = o.fftPhys, U = o.physU, ch = o.physChop, tm = ((t % T_REP) + T_REP) % T_REP;
  const fld = (X, Z) => {
    let y = 0, dx = 0, dz = 0;
    for (const p of g.cells) {
      const sa = Math.sqrt(Math.max(0, p.pwA * U.wind[0] + p.psA * U.swell[0])) * p.sc, sb = Math.sqrt(Math.max(0, p.pwB * U.wind[0] + p.psB * U.swell[0])) * p.sc;
      const ar = p.ga[0] * sa, ai = p.ga[1] * sa, br = p.gb[0] * sb, bi = p.gb[1] * sb, ph = p.wq * tm, c = Math.cos(ph), s = Math.sin(ph);
      const hr = (ar * c - ai * s + br * c - bi * s) * p.resp, hi = (ar * s + ai * c - br * s - bi * c) * p.resp;
      const th = p.kx * X + p.kz * Z, re = hr * Math.cos(th) - hi * Math.sin(th), im = hr * Math.sin(th) + hi * Math.cos(th);
      y += 2 * re; dx -= 2 * im * ch[p.c] * p.kx / p.k; dz -= 2 * im * ch[p.c] * p.kz / p.k;
    }
    return [y, dx, dz];
  };
  const X = x + o.frameF.x, Z = z + o.frameF.z;
  let px = X, pz = Z;
  for (let i = 0; i < 8; i++) { const f = fld(px, pz); px = X - f[1]; pz = Z - f[2]; }
  return fld(px, pz)[0];
}

test('ships ride the drawn FFT sea: heightAt agrees with the drawn surface within a few cm (2 m sea)', () => {
  const { o, hs } = fftOcean({ windSpd: 8, windDir: 240, waveH: 1.0, wavePeriod: 5.5, swellH: 0.5, swellPeriod: 11 });
  assert.ok(hs > 1.6 && hs < 2.8, `test sea Hs ${hs.toFixed(2)}`);
  assert.ok(o.physFft); assert.match(o.diag().physics, /^fft \(/);
  let s2 = 0, mx = 0, v = 0, n = 0;
  for (const t of [3.5, 17.25, 40]) for (let i = 0; i < 10; i++) {
    const x = i * 41.3 - 200, z = -i * 29.9 + 80, a = o.heightAt(x, z, t) - o.level, b = drawnHeight(o, x, z, t);
    s2 += (a - b) ** 2; mx = Math.max(mx, Math.abs(a - b)); v += b * b; n++;
  }
  const rms = Math.sqrt(s2 / n), std = Math.sqrt(v / n);
  assert.ok(std > 0.25, `the drawn sea is not flat (σ ${std.toFixed(2)} m)`);
  assert.ok(rms < 0.03 && mx < 0.08, `heightAt vs drawn: rms ${(rms * 100).toFixed(1)} cm, max ${(mx * 100).toFixed(1)} cm`);
  // pitch / roll: the normal is the drawn surface's (finite differences of the drawn height, 1 m apart)
  const t = 9, x = 12, z = -30, N = o.normalAt(x, z, t), d = 0.5;
  const gx = (drawnHeight(o, x + d, z, t) - drawnHeight(o, x - d, z, t)) / (2 * d), gz = (drawnHeight(o, x, z + d, t) - drawnHeight(o, x, z - d, t)) / (2 * d);
  assert.ok(Math.abs(-N.x / N.y - gx) < 0.02 && Math.abs(-N.z / N.y - gz) < 0.02, `slope ${(-N.x / N.y).toFixed(3)},${(-N.z / N.y).toFixed(3)} vs drawn ${gx.toFixed(3)},${gz.toFixed(3)}`);
  // a floating-origin shift keeps the ship on the same water
  const h0 = o.heightAt(500, 200, 5); o.shiftOrigin(300, -100);
  assert.ok(Math.abs(o.heightAt(200, 300, 5) - h0) < 1e-6, 'same water after shiftOrigin');
});

test('physics falls back to the Gerstner sea (bit for bit) whenever the FFT is not drawn', () => {
  const { o } = fftOcean({ windSpd: 22, windDir: 300, waveH: 6, wavePeriod: 10, swellH: 2, swellDir: 280, swellPeriod: 13, storm: 1 });
  const g = new Ocean(fakeScene()); g.setSea({ windSpd: 22, windDir: 300, waveH: 6, wavePeriod: 10, swellH: 2, swellDir: 280, swellPeriod: 13, storm: 1 }); g.snapSea(); g.update(0, 0, 0, 1 / 60);
  assert.notEqual(o.heightAt(12.5, -7.25, 1.5), g.heightAt(12.5, -7.25, 1.5));
  o.dropFft('test');                                          // FFT gone (e.g. its rung failed) → Gerstner again
  assert.equal(o.diag().physics, 'gerstner');
  assert.equal(o.heightAt(12.5, -7.25, 1.5), g.heightAt(12.5, -7.25, 1.5));
});

test('the CPU spectrum mirror carries the normalised sea (same Hs as the GPU spectrum)', () => {
  const { U, o } = fftOcean({ windSpd: 8, windDir: 240, waveH: 1.0, wavePeriod: 5.5, swellH: 0.5, swellPeriod: 11 });
  const all = fftComponents(U, 256, [0, 1]);
  const hs = 4 * Math.sqrt(2 * all.total), want = Math.hypot(...fftNormalise(o.fftSeaParams(), 256, 3).hs.slice(0, 2));
  assert.ok(Math.abs(hs / want - 1) < 0.25, `realised Hs ${hs.toFixed(2)} vs spectrum ${want.toFixed(2)}`);
});

test('small / sailing hulls leave a faint narrow wash; a ship keeps its white wake; far glitter is capped', () => {
  const o = new Ocean(fakeScene()); o.setSea({ windSpd: 11, windDir: 240 }); o.update(1, 0, 0, 1 / 60);
  const sloop = {}, ship = {};
  o.feedShip(sloop, { x: 0, z: 0, hdg: 0, spd: 4.7, length: 11, beam: 3.5, draft: 1.8, throttle: 0, own: true, sail: true });
  o.feedShip(ship, { x: 900, z: 0, hdg: 0, spd: 16, length: 200, beam: 32, draft: 11, throttle: 0.8 });
  o.update(1.02, 0, 0, 1 / 60);
  o.feedShip(sloop, { x: 0, z: -0.05, hdg: 0, spd: 4.7, length: 11, beam: 3.5, draft: 1.8, throttle: 0, own: true, sail: true });
  o.feedShip(ship, { x: 900, z: -0.16, hdg: 0, spd: 16, length: 200, beam: 32, draft: 11, throttle: 0.8 });
  o.update(1.04, 0, 0, 1 / 60);
  const ks = o.kel.find((k) => k.len === 11), kb = o.kel.find((k) => k.len === 200);
  assert.ok(ks && kb);
  assert.ok(ks.foam < 0.12, `sloop wash ${ks.foam.toFixed(3)}`);
  assert.ok(kb.foam > 0.7, `ship wash ${kb.foam.toFixed(3)}`);
  const f = OCEAN_SHADERS.full.frag;
  assert.ok(/float spr = min\(1\.0, KC\.x \/ 12\.0\)/.test(f), 'Kelvin wash width scales with the beam');
  assert.ok(/min\(glint\(uSunDir, N, V, sig, vh, ndv\), gCap\)/.test(f) && /float gCap = 8\.0 \/ \(1\.0 \+ 40\.0 \* rough\)/.test(f), 'glitter cap falls with roughness / at the horizon');
});
