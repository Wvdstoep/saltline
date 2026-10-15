// public/js/atmos.js - physically based atmosphere (Rayleigh + Mie + ozone absorption) over a spherical Earth, the same
// model twice: plain JS (lighting, fog colour, sun colour, ambient; testable in node, no three.js) and GLSL
// (ATMOS_GLSL, evaluated per vertex by the sky dome in sky.js, phase functions per pixel).
// Single scattering is integrated exactly along the view ray (with the Earth's shadow, so twilight works); higher
// orders are approximated by an isotropic in-scatter of the sky's own mean radiance (skyAmbient), which is what keeps
// the anti-solar horizon pink-blue at sunset instead of black. Coefficients: Bruneton 2017 / Hillaire 2020.
// Units: metres; the Sun's top-of-atmosphere irradiance is 1 per channel; the renderer applies an exposure.
// Haze (Mie) follows the weather's visibility (Koschmieder 3.912 / V, damped: the surface visibility mostly measures
// the shallow marine layer, which scene fog renders).

export const RE = 6360e3, RA = 6460e3;
export const BETA_R = [5.802e-6, 13.558e-6, 33.1e-6];
export const BETA_O = [0.650e-6, 1.881e-6, 0.085e-6];
export const H_R = 8000, H_M = 1200;
export const MIE_G = 0.76;
export const MIE_ALBEDO = 0.9;
export const MS_GAIN = 1.6;          // higher scattering orders relative to the 2nd (geometric series, ground albedo ~0.1)

/** Ground-level Mie extinction (1/m) for a horizontal visibility V (m). */
export function mieForVisibility(V) {
  const v = Math.max(4000, Math.min(120000, Number.isFinite(V) ? V : 30000));
  return Math.max(2.0e-6, Math.min(4.0e-4, 0.3 * 3.912 / v));
}

const ozone = (h) => Math.max(0, 1 - Math.abs(h - 25000) / 15000);

function rayTop(r, mu) { const b = r * mu, c = r * r - RA * RA; return -b + Math.sqrt(Math.max(0, b * b - c)); }
function groundHit(r, mu) {
  if (mu >= 0) return -1;
  const b = r * mu, c = r * r - RE * RE, d = b * b - c;
  return d >= 0 ? -b - Math.sqrt(d) : -1;
}

/** Optical depth [R, M, O] (density-weighted metres) from radius r, zenith cosine mu, to space; null if the Earth blocks. */
export function opticalDepthToSpace(r, mu, steps = 8) {
  if (groundHit(r, mu) > 0) return null;
  const len = rayTop(r, mu), sin = Math.sqrt(Math.max(0, 1 - mu * mu)), ds = len / steps;
  let dr = 0, dm = 0, dO = 0;
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * ds, x = sin * t, y = r + mu * t;
    const h = Math.sqrt(x * x + y * y) - RE;
    dr += Math.exp(-h / H_R) * ds; dm += Math.exp(-h / H_M) * ds; dO += ozone(h) * ds;
  }
  return [dr, dm, dO];
}

/** Transmittance (rgb) from altitude h (m) toward a direction with elevation sine mu, for Mie extinction mieExt. */
export function transmittance(h, mu, mieExt = mieForVisibility(30000)) {
  const od = opticalDepthToSpace(RE + Math.max(1, h), mu, 24);
  if (!od) return [0, 0, 0];
  return [0, 1, 2].map((c) => Math.exp(-(BETA_R[c] * od[0] + mieExt * od[1] + BETA_O[c] * od[2])));
}

export const phaseR = (mu) => (3 / (16 * Math.PI)) * (1 + mu * mu);
export function phaseM(mu, g = MIE_G) {
  const g2 = g * g;
  return (3 / (8 * Math.PI)) * ((1 - g2) * (1 + mu * mu)) / ((2 + g2) * Math.pow(1 + g2 - 2 * g * mu, 1.5));
}

/**
 * Sky radiance (rgb, unit solar irradiance) seen from altitude h along unit dir [x,y,z], light from unit lightDir.
 * ambient (rgb, optional): the mean sky radiance for the multiple-scattering term (see skyAmbient).
 */
export function skyRadiance(h, dir, lightDir, mieExt = mieForVisibility(30000), ambient = null, steps = 16) {
  const r0 = RE + Math.max(1, h);
  const [dx, dy, dz] = dir;
  const g = groundHit(r0, dy);
  const len = g > 0 ? g : rayTop(r0, dy);
  if (!(len > 0)) return [0, 0, 0];
  const mieS = mieExt * MIE_ALBEDO;
  let odR = 0, odM = 0, odO = 0;
  const sR = [0, 0, 0], sM = [0, 0, 0], ms = [0, 0, 0];
  let tPrev = 0;
  for (let i = 0; i < steps; i++) {
    const f = (i + 1) / steps, t = len * f * f, ds = t - tPrev, tm = (t + tPrev) / 2; tPrev = t;
    const px = dx * tm, py = r0 + dy * tm, pz = dz * tm;
    const r = Math.sqrt(px * px + py * py + pz * pz), hh = r - RE;
    const dR = Math.exp(-hh / H_R) * ds, dM = Math.exp(-hh / H_M) * ds;
    odR += dR; odM += dM; odO += ozone(hh) * ds;
    const mu = (px * lightDir[0] + py * lightDir[1] + pz * lightDir[2]) / r;
    const od = opticalDepthToSpace(r, mu, 6);
    for (let c = 0; c < 3; c++) {
      const Tv = Math.exp(-(BETA_R[c] * odR + mieExt * odM + BETA_O[c] * odO));
      ms[c] += Tv * (BETA_R[c] * dR + mieS * dM);
      if (!od) continue;
      const T = Math.exp(-(BETA_R[c] * (odR + od[0]) + mieExt * (odM + od[1]) + BETA_O[c] * (odO + od[2])));
      sR[c] += T * dR; sM[c] += T * dM;
    }
  }
  const mu = dx * lightDir[0] + dy * lightDir[1] + dz * lightDir[2];
  const pr = phaseR(mu), pm = phaseM(mu);
  return [0, 1, 2].map((c) => sR[c] * BETA_R[c] * pr + sM[c] * mieS * pm + (ambient ? ambient[c] * ms[c] * MS_GAIN : 0));
}

/** Mean single-scattered radiance of the whole sky (rgb) - the source of the multiple-scattering term. */
export function skyAmbient(h, lightDir, mieExt = mieForVisibility(30000)) {
  const acc = [0, 0, 0];
  let n = 0;
  for (const el of [0.03, 0.25, 0.6, 1.2]) {
    const ce = Math.cos(el), se = Math.sin(el), k = el > 1 ? 1 : 2;
    for (let a = 0; a < 6; a++) {
      const az = (a / 6) * Math.PI * 2;
      const L = skyRadiance(h, [Math.sin(az) * ce, se, Math.cos(az) * ce], lightDir, mieExt, null, 10);
      for (let c = 0; c < 3; c++) acc[c] += L[c] * k;
      n += k;
    }
  }
  // the lower hemisphere (sea, albedo ~0.06) contributes little; average over the full sphere
  return acc.map((v) => (v / n) * 0.55);
}

/** Rec.709 luminance. */
export const luminance = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

// ------------------------------------------------------------------------------------------------ GLSL
// atmosScatter() returns, for two lights (Sun L1, Moon L2), the Rayleigh and Mie single in-scatter WITHOUT the phase
// functions (vertex shader), the multiple-scatter integral ms (multiply by the mean sky radiance) and the view
// transmittance Tv. The fragment shader applies the phases per pixel.
export const ATMOS_GLSL = /* glsl */`
#define A_RE ${RE.toFixed(1)}
#define A_RA ${RA.toFixed(1)}
#define A_HR ${H_R.toFixed(1)}
#define A_HM ${H_M.toFixed(1)}
#define A_MS_GAIN ${MS_GAIN.toFixed(3)}
const vec3 A_BR = vec3(${BETA_R.map((v) => v.toExponential(4)).join(', ')});
const vec3 A_BO = vec3(${BETA_O.map((v) => v.toExponential(4)).join(', ')});
float a_ozone(float h) { return max(0.0, 1.0 - abs(h - 25000.0) / 15000.0); }
vec3 a_odSpace(float r, float mu) {
  float b = r * mu, c = r * r - A_RE * A_RE;
  if (mu < 0.0 && b * b - c >= 0.0) return vec3(-1.0);
  float len = -b + sqrt(max(0.0, b * b - (r * r - A_RA * A_RA)));
  float ds = len / 6.0, sinz = sqrt(max(0.0, 1.0 - mu * mu));
  vec3 od = vec3(0.0);
  for (int i = 0; i < 6; i++) {
    float t = (float(i) + 0.5) * ds;
    float x = sinz * t, y = r + mu * t;
    float h = sqrt(x * x + y * y) - A_RE;
    od += vec3(exp(-h / A_HR), exp(-h / A_HM), a_ozone(h)) * ds;
  }
  return od;
}
void atmosScatter(float camH, vec3 d, vec3 L1, vec3 L2, float mieExt,
    out vec3 rS1, out vec3 mS1, out vec3 rS2, out vec3 mS2, out vec3 ms, out vec3 Tv) {
  float r0 = A_RE + max(1.0, camH);
  float b = r0 * d.y, cg = r0 * r0 - A_RE * A_RE, len;
  if (d.y < 0.0 && b * b - cg >= 0.0) len = -b - sqrt(b * b - cg);
  else len = -b + sqrt(max(0.0, b * b - (r0 * r0 - A_RA * A_RA)));
  float mieS = mieExt * 0.9;
  vec3 odv = vec3(0.0);
  rS1 = vec3(0.0); mS1 = vec3(0.0); rS2 = vec3(0.0); mS2 = vec3(0.0); ms = vec3(0.0);
  float tPrev = 0.0;
  for (int i = 0; i < 16; i++) {
    float f = float(i + 1) / 16.0, t = len * f * f, ds = t - tPrev, tm = 0.5 * (t + tPrev); tPrev = t;
    vec3 p = vec3(0.0, r0, 0.0) + d * tm;
    float r = length(p), h = r - A_RE;
    float dR = exp(-h / A_HR) * ds, dM = exp(-h / A_HM) * ds;
    odv += vec3(dR, dM, a_ozone(h) * ds);
    vec3 tv = exp(-(A_BR * odv.x + mieExt * odv.y + A_BO * odv.z));
    ms += tv * (A_BR * dR + mieS * dM);
    vec3 up = p / r;
    vec3 od1 = a_odSpace(r, dot(up, L1));
    if (od1.x >= 0.0) {
      vec3 tt = odv + od1;
      vec3 T = exp(-(A_BR * tt.x + mieExt * tt.y + A_BO * tt.z));
      rS1 += T * dR; mS1 += T * dM;
    }
    vec3 od2 = a_odSpace(r, dot(up, L2));
    if (od2.x >= 0.0) {
      vec3 tt = odv + od2;
      vec3 T = exp(-(A_BR * tt.x + mieExt * tt.y + A_BO * tt.z));
      rS2 += T * dR; mS2 += T * dM;
    }
  }
  rS1 *= A_BR; rS2 *= A_BR; mS1 *= mieS; mS2 *= mieS; ms *= A_MS_GAIN;
  Tv = exp(-(A_BR * odv.x + mieExt * odv.y + A_BO * odv.z));
}
float a_phaseR(float mu) { return 0.0596831 * (1.0 + mu * mu); }
float a_phaseM(float mu, float g) { float g2 = g * g; return 0.1193662 * ((1.0 - g2) * (1.0 + mu * mu)) / ((2.0 + g2) * pow(max(1e-4, 1.0 + g2 - 2.0 * g * mu), 1.5)); }
`;
