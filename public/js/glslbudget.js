// GLSL resource estimate for a three.js ShaderMaterial (pure, runs in node): the uniform vectors, samplers and varyings
// each stage needs AFTER three.js (r160, WebGL2) has added its own prefix and chunks. Conservative on purpose — this is
// what a phone GPU (Adreno through ANGLE: 256 vec4 per stage, no cross-uniform packing assumed) has to fit at link time:
//   - every float / int / bool / vec2 / vec3 / vec4 takes a whole vec4 row, a mat3 three rows, a mat4 four;
//   - an array takes its element count times that;
//   - a uniform counts when its name is used anywhere other than its declaration (dead helper functions included).
// Used by ocean2.js to pick a shader variant that fits the GPU's limits and by the tests to hold every tier to a budget.

const ROWS = { float: 1, int: 1, uint: 1, bool: 1, vec2: 1, vec3: 1, vec4: 1, ivec2: 1, ivec3: 1, ivec4: 1, bvec2: 1, bvec3: 1, bvec4: 1, mat2: 2, mat3: 3, mat4: 4 };
const SAMPLERS = /^(sampler2D|samplerCube|sampler3D|sampler2DArray|sampler2DShadow|isampler2D|usampler2D)$/;

// what three.js r160 prepends / expands for a ShaderMaterial (WebGL2, no lights, no skinning, no clipping)
const VERT_PREFIX = 'uniform mat4 modelMatrix;\nuniform mat4 modelViewMatrix;\nuniform mat4 projectionMatrix;\nuniform mat4 viewMatrix;\nuniform mat3 normalMatrix;\nuniform vec3 cameraPosition;\nuniform bool isOrthographic;\n';
const FRAG_PREFIX = 'uniform mat4 viewMatrix;\nuniform vec3 cameraPosition;\nuniform bool isOrthographic;\n';

function chunks(src, stage, o) {
  const fogV = o.fog ? 'varying float vFogDepth;' : '';
  const fogF = o.fog ? `uniform vec3 fogColor; varying float vFogDepth; ${o.fogExp2 ? 'uniform float fogDensity;' : 'uniform float fogNear; uniform float fogFar;'}` : '';
  const fogUse = o.fog ? (o.fogExp2 ? 'fogDensity; fogColor; vFogDepth;' : 'fogNear; fogFar; fogColor; vFogDepth;') : '';
  return src
    .replace(/#include\s*<fog_pars_vertex>/g, fogV)
    .replace(/#include\s*<fog_vertex>/g, o.fog ? 'vFogDepth = - mvPosition.z;' : '')
    .replace(/#include\s*<fog_pars_fragment>/g, fogF)
    .replace(/#include\s*<fog_fragment>/g, fogUse)
    .replace(/#include\s*<tonemapping_fragment>/g, o.toneMapping ? 'toneMappingExposure;' : '')
    .replace(/#include\s*<[\w]+>/g, '')
    + (stage === 'fragment' && o.toneMapping ? '\nuniform float toneMappingExposure;\n' : '');
}

/** Tiny preprocessor: strips comments, applies #define NAME <int>, #ifdef / #ifndef / #if 0|1 / #else / #endif. */
function preprocess(src, defines) {
  const defs = { ...defines };
  src = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
  const out = [], stack = [];
  const live = () => stack.every((s) => s);
  for (const line of src.split('\n')) {
    const t = line.trim();
    let m;
    if ((m = t.match(/^#ifdef\s+(\w+)/))) { stack.push(m[1] in defs); continue; }
    if ((m = t.match(/^#ifndef\s+(\w+)/))) { stack.push(!(m[1] in defs)); continue; }
    if ((m = t.match(/^#if\s+(\w+)/))) { const v = m[1] in defs ? defs[m[1]] : m[1]; stack.push(Number(v) !== 0 && v !== undefined); continue; }
    if (/^#else/.test(t)) { stack[stack.length - 1] = !stack[stack.length - 1]; continue; }
    if (/^#endif/.test(t)) { stack.pop(); continue; }
    if (!live()) continue;
    if ((m = t.match(/^#define\s+(\w+)(?:\s+(.*))?$/))) { defs[m[1]] = m[2] === undefined ? 1 : m[2].trim(); continue; }
    if (t.startsWith('#')) continue;
    out.push(line);
  }
  return { code: out.join('\n'), defs };
}

function arraySize(s, defs) {
  if (s === undefined) return 1;
  let v = s.trim();
  for (let i = 0; i < 4 && v in defs; i++) v = String(defs[v]);
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : NaN;
}

function stageBudget(src, stage, o) {
  const pre = (stage === 'vertex' ? VERT_PREFIX : FRAG_PREFIX) + chunks(src, stage, o);
  const { code, defs } = preprocess(pre, o.defines || {});
  const decls = [];
  const declRe = /\buniform\s+(?:(?:highp|mediump|lowp)\s+)?(\w+)\s+([^;]+);/g;
  for (const m of code.matchAll(declRe)) {
    for (const part of m[2].split(',')) {
      const pm = part.trim().match(/^(\w+)\s*(?:\[\s*(\w+)\s*\])?/);
      if (pm) decls.push({ type: m[1], name: pm[1], size: arraySize(pm[2], defs) });
    }
  }
  const body = code.replace(declRe, ' ');
  const used = (name) => new RegExp(`\\b${name}\\b`).test(body);
  let uniforms = 0, samplers = 0;
  const list = [];
  const seen = new Set();
  for (const d of decls) {
    if (seen.has(d.name) || !used(d.name)) continue;
    seen.add(d.name);
    if (SAMPLERS.test(d.type)) { samplers += d.size; continue; }
    const r = (ROWS[d.type] || 4) * d.size;
    uniforms += r; list.push(`${d.name}:${r}`);
  }
  // varyings: what the vertex stage writes out (three's #define varying out / in)
  let varyings = 0;
  const vlist = [];
  const vseen = new Set();
  for (const m of code.matchAll(/\bvarying\s+(?:(?:highp|mediump|lowp|flat|smooth)\s+)*(float|vec2|vec3|vec4|mat2|mat3|mat4|int|ivec2|ivec3|ivec4)\s+([^;]+);/g)) {
    for (const part of m[2].split(',')) {
      const pm = part.trim().match(/^(\w+)\s*(?:\[\s*(\w+)\s*\])?/);
      if (!pm || vseen.has(pm[1])) continue;
      vseen.add(pm[1]);
      const r = (ROWS[m[1]] || 4) * arraySize(pm[2], defs);
      varyings += r; vlist.push(`${pm[1]}:${r}`);
    }
  }
  // loop trip counts (constant-bound for loops), a rough proxy for the unrolled instruction count
  let loopIters = 0;
  for (const m of code.matchAll(/for\s*\(\s*int\s+\w+\s*=\s*(\w+)\s*;\s*\w+\s*<\s*(\w+)/g)) {
    const a = arraySize(m[1], defs), b = arraySize(m[2], defs);
    const a0 = m[1] === '0' ? 0 : a;
    if (Number.isFinite(a0) && Number.isFinite(b)) loopIters += Math.max(0, b - a0);
  }
  return { uniforms, samplers, varyings, loopIters, list, varyingList: vlist };
}

/**
 * Estimate both stages of a ShaderMaterial. opts: { fog = true, fogExp2 = false, toneMapping = true, defines = {} }.
 * Returns { vertex: {uniforms, samplers, varyings, loopIters, list}, fragment: {...}, varyings }.
 */
export function glslBudget(vert, frag, opts = {}) {
  const o = { fog: true, fogExp2: false, toneMapping: true, ...opts };
  const vertex = stageBudget(vert, 'vertex', o);
  const fragment = stageBudget(frag, 'fragment', o);
  return { vertex, fragment, varyings: vertex.varyings };
}

/** True when a budget fits the GPU's limits with `margin` vectors to spare per stage (and a varying margin of 3). */
export function budgetFits(b, caps, margin = 32) {
  const fu = (caps.maxFragmentUniforms || 0) - margin, vu = (caps.maxVertexUniforms || 0) - margin;
  return b.fragment.uniforms <= fu && b.vertex.uniforms <= vu && b.varyings <= (caps.maxVaryings || 0) - 3
    && b.fragment.samplers <= (caps.maxTextures || 0) && b.vertex.samplers <= (caps.maxVertexTextures || 0);
}
