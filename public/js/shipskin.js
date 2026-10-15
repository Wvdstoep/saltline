// Ship exterior skin: physically based materials for every ship (ship.js legacy builders and the shipgen.js models,
// own ship, other players, AI traffic and AIS vessels alike). One shader patch on MeshStandardMaterial /
// MeshPhysicalMaterial, specialised per surface class at compile time (SKIN_KIND):
//   1 hull   painted steel plates in metres (strakes 1.4–3 m, butts 4.5–12 m) with weld beads as a derivative bump,
//            hungry-horse ripple between frames, paint mottling and fading, scupper / hawse-pipe rust streaks smeared
//            downwards, waterline slime band, antifouling below the design waterline, raised name letters at the bow,
//            name + port of registry on the transom, draft marks (0.1 m numerals every 0.2 m, "nM" each metre) and the
//            Plimsoll disc amidships; a faired gelcoat finish without seams for yachts (uMode 1)
//   2 deck   non-slip coating with grain, faint plate seams, walkway lanes with yellow edge lines, edge rust; laid teak
//            with caulking and staggered butts for yachts (uMode 1)
//   3 house  the facade atlas' alpha marks glass (mirror-smooth, reflects the sky) and which windows are lit at night;
//            rain / soot streaks on the walls
//   4 funnel soot towards the top, plates
//   5 paint  painted fittings (vertex colours): grime and rust spots with wear
// Everything is in the ship frame (attribute shipPos = position for shipgen geometry, baked for the legacy builders),
// so details keep their real size on a 20 m tug and a 400 m container ship. Fine detail fades out by metres-per-pixel,
// which is also the per-pixel LOD: far away the shader is base colour + a couple of noise taps.
// Textures: one shared glyph strip (draft numerals, R8 512×64) and one lettering texture per distinct name (R8,
// cached with reference counts, 512×128 on phones, 1024×256 others, 2048×512 own ship). Reflections come from
// scene.environment (the sky builder's PMREM) — this module never builds its own environment; diffuse IBL is scaled
// down (uEnvDiffuse) because the hemisphere light already supplies the ambient term.
import * as THREE from 'three';
import { skinKindOf, PRESETS, letteringKey } from './shipskinfmt.js';

const HAS_DOM = typeof document !== 'undefined' && typeof document.createElement === 'function';

// ------------------------------------------------------------------------------------------------ GLSL
const VERT_PARS = /* glsl */`attribute vec3 shipPos; varying vec3 vShipPos;`;
const VERT = /* glsl */`vShipPos = shipPos;`;

const FRAG_PARS = /* glsl */`
uniform float uWear; uniform float uFlood; uniform float uAge; uniform float uNight; uniform float uEnvDiffuse; uniform float uMode; uniform float uDeckMode;
uniform vec4 uDims;    // L, B, T, deckY
uniform vec4 uPlate;   // strake, butt, seam strength, scupper spacing
uniform vec4 uHawse;   // |x|, y, z, pipe radius (0 = none)
uniform vec4 uLanes;   // z0, z1, inset, width
uniform vec3 uWalk;
uniform vec2 uFunnel;  // top y, height
varying vec3 vShipPos;
float wh(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
float h1(float n) { return fract(sin(n * 91.3458 + 3.17) * 47453.5453); }
float wnoise(vec3 p) { vec3 i = floor(p); vec3 f = fract(p); f = f*f*(3.0-2.0*f);
  float a = mix(mix(wh(i), wh(i+vec3(1,0,0)), f.x), mix(wh(i+vec3(0,1,0)), wh(i+vec3(1,1,0)), f.x), f.y);
  float b = mix(mix(wh(i+vec3(0,0,1)), wh(i+vec3(1,0,1)), f.x), mix(wh(i+vec3(0,1,1)), wh(i+vec3(1,1,1)), f.x), f.y);
  return mix(a, b, f.z); }
vec3 skinPerturb(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDir) {
  vec3 vSigmaX = normalize(dFdx(surf_pos)); vec3 vSigmaY = normalize(dFdy(surf_pos)); vec3 vN = surf_norm;
  vec3 R1 = cross(vSigmaY, vN); vec3 R2 = cross(vN, vSigmaX);
  float fDet = dot(vSigmaX, R1) * faceDir;
  vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
  return normalize(abs(fDet) * surf_norm - vGrad);
}
float seamDist(float x, float pitch) { return (0.5 - abs(fract(x / pitch) - 0.5)) * pitch; }
#if SKIN_KIND == 1
uniform sampler2D uLetter; uniform sampler2D uGlyph;
uniform vec4 uNameBow;    // zc, yc, w, h  (w = 0: none)
uniform vec4 uNameStern;  // zTransom, yc, w, h
uniform vec4 uDraft;      // zFwd, zMid, zAft, top (m above keel)
uniform vec3 uMarkCol; uniform vec3 uNameCol;
#endif
`;

const FRAG_MAIN = /* glsl */`
float skinH = 0.0, skinRough = 0.0, skinGlass = 0.0, skinLit = 0.0;
{
  vec3 P = vShipPos;
  vec3 dpx = dFdx(P), dpy = dFdy(P);
  vec3 nS = normalize(cross(dpx, dpy));
  float mpp = max(length(dpx), length(dpy));
  float near = 1.0 - smoothstep(0.025, 0.1, mpp);      // welds, letters, marks
  float mid = 1.0 - smoothstep(0.2, 0.8, mpp);         // plates, streaks
  float w = clamp(uWear, 0.0, 1.0);
  float grime = clamp(uAge + 0.6 * w, 0.0, 1.0);
  vec3 col = diffuseColor.rgb;
  float n1 = wnoise(P * 0.9) * 0.55 + wnoise(P * 3.1) * 0.45;
  vec3 rustCol = mix(vec3(0.42, 0.17, 0.06), vec3(0.2, 0.08, 0.04), n1);
  float rust = 0.0;
#if SKIN_KIND == 3 && defined( USE_MAP )
  float fa = diffuseColor.a; diffuseColor.a = 1.0;
  skinGlass = 1.0 - smoothstep(0.86, 0.94, fa);
  skinLit = 1.0 - smoothstep(0.55, 0.65, fa);
#endif
  // paint: low-frequency tonal variation (touch-ups, fading) and chalky dulling with age
  float mott = wnoise(P * 0.33 + 17.0);
  col *= 0.95 + 0.1 * mott * (1.0 - skinGlass);
  col = mix(col, vec3(dot(col, vec3(0.3333))), 0.22 * grime * mott * (1.0 - skinGlass));
  // rust patches grow with wear (hull condition)
  float streakN = wnoise(vec3(P.x * 4.0, P.y * 0.35, P.z * 4.0));
  rust = smoothstep(1.0 - w * 1.15, 1.0 - w * 1.15 + 0.22, n1) * (0.6 + 0.4 * streakN);
  rust += smoothstep(1.0 - w * 0.9, 1.0 - w * 0.9 + 0.1, streakN) * 0.5 * w;
#if SKIN_KIND == 1
  float side = step(0.35, abs(nS.x));
  float transom = step(0.6, abs(nS.z)) * step(0.0, P.z);
  float steel = 1.0 - step(0.5, uMode);
  // antifouling below the design waterline (keeps a little of the livery's tint)
  float under = (1.0 - smoothstep(-0.06, 0.0, P.y)) * (1.0 - step(1.5, uMode));   // uMode 2: the sail yachts' own painted stripes
  col = mix(col, mix(col, vec3(0.33, 0.07, 0.05), 0.65), under);
  // plates and weld beads (steel), hungry-horse ripple between frames
  if (uPlate.x > 0.0) {
    vec2 q = transom > 0.5 ? vec2(P.x, P.y) : vec2(P.z, P.y);
    float row = floor(q.y / uPlate.x);
    float dB = seamDist(q.x + h1(row + 3.0) * uPlate.y, uPlate.y);
    float dS = seamDist(q.y, uPlate.x);
    float d = min(dB, dS);
    float bead = (1.0 - smoothstep(0.0, 0.016 + 0.6 * mpp, d)) * uPlate.z;
    skinH += 0.006 * bead * near;
    col *= 1.0 - 0.09 * bead * mid;
    col *= 1.0 + 0.035 * (1.0 - smoothstep(0.0, 0.06 + mpp, abs(d - 0.03))) * mid * uPlate.z;   // light catching the bead's edge
    skinH += 0.006 * (0.5 + 0.5 * cos(6.2832 * q.x / 0.8)) * (0.25 + grime) * side * mid * (0.6 + 0.4 * h1(row));
  }
  // waterline: slime / weed band and brown staining fading upwards
  float wlBand = (1.0 - smoothstep(0.0, 0.5 + 0.9 * grime, P.y)) * smoothstep(-0.5, -0.05, P.y);
  col = mix(col, vec3(0.13, 0.14, 0.07), wlBand * (0.2 + 0.55 * grime) * (0.55 + 0.45 * wnoise(vec3(P.z * 1.3, P.y * 7.0, 0.5))));
  float barn = smoothstep(0.35, 0.75, wnoise(P * 2.3)) * (1.0 - smoothstep(0.2, 1.6, abs(P.y + 0.5))) * w;
  col = mix(col, vec3(0.18, 0.22, 0.13), barn);
  // scupper streaks below the deck edge
  float sStreak = 0.0;
  if (uPlate.w > 0.0) {
    float cell = floor(P.z / uPlate.w);
    float cz = (cell + 0.5 + (h1(cell) - 0.5) * 0.5) * uPlate.w;
    float y0 = uDims.w - 0.45 - 0.25 * h1(cell + 5.0);
    float dn = y0 - P.y;
    float len = (0.3 + 0.7 * h1(cell + 11.0)) * (0.6 + 4.0 * grime) * clamp(uDims.w * 0.22, 0.4, 2.6);
    float wd = 0.05 + 0.06 * max(dn, 0.0);
    float dzs = abs(P.z - cz) + 0.04 * (wnoise(vec3(P.y * 7.0, cell, 1.0)) - 0.5);
    sStreak = (1.0 - smoothstep(wd * 0.35, wd, dzs)) * step(0.0, dn) * (1.0 - smoothstep(len * 0.25, len, dn));
    sStreak *= (0.45 + 0.55 * wnoise(vec3(P.z * 14.0, P.y * 0.9, cell))) * (0.25 + grime) * side * steel;
    float hole = (1.0 - smoothstep(0.06, 0.1, length(vec2(P.z - cz, (P.y - y0) * 1.7)))) * side * steel * mid;
    col = mix(col, vec3(0.02), hole * 0.85);
  }
  // hawse pipes: rust streaks to the waterline and chafe around the opening
  float hStreak = 0.0;
  if (uHawse.w > 0.0) {
    float dz = abs(P.z - uHawse.z), dn = uHawse.y - P.y;
    float wd = uHawse.w * 0.9 + 0.12 * max(dn, 0.0);
    hStreak = (1.0 - smoothstep(wd * 0.3, wd, dz + 0.1 * (wnoise(vec3(P.y * 3.0, 2.0, 7.0)) - 0.5))) * step(0.0, dn) * (1.0 - smoothstep(uHawse.y * 0.5, uHawse.y + 0.4, dn));
    hStreak *= (0.35 + 0.65 * wnoise(vec3(P.z * 9.0, P.y * 0.6, 4.0))) * (0.35 + grime);
    float ring = 1.0 - smoothstep(uHawse.w * 1.1, uHawse.w * 2.4, length(vec2(dz, P.y - uHawse.y)));
    hStreak = max(hStreak, ring * smoothstep(0.35, 0.6, wnoise(P * 3.3)) * (0.4 + grime));
    hStreak *= side * steel;
  }
  rust = max(rust, max(sStreak * 0.85, hStreak));
  // gelcoat yachts: no rust, a little yellowing at the waterline only
  rust *= steel;
  // lettering: raised name at both bows (top row of the lettering texture), name + port on the transom
  vec2 luv = vec2(-1.0);
  if (uNameBow.z > 0.0) {
    float u = (P.x >= 0.0 ? (uNameBow.x - P.z) : (P.z - uNameBow.x)) / uNameBow.z + 0.5;
    float v = (P.y - uNameBow.y) / uNameBow.w + 0.5;
    if (side > 0.5 && u > 0.0 && u < 1.0 && v > 0.5 && v < 1.0) luv = vec2(u, v);
  }
  if (uNameStern.z > 0.0 && transom > 0.5 && P.z > uNameStern.x - 1.5) {
    float u = P.x / uNameStern.z + 0.5, v = (P.y - uNameStern.y) / uNameStern.w + 0.5;
    if (u > 0.0 && u < 1.0 && v > 0.0 && v < 1.0) luv = vec2(u, v);
  }
  float la = texture2D(uLetter, clamp(luv, 0.0, 1.0)).r * step(0.0, luv.x) * (1.0 - smoothstep(0.3, 1.2, mpp));
  // draft marks: 0.1 m numerals every 0.2 m at three stations, "<n>M" on each whole metre (reader's right of the line)
  float yk = P.y + uDims.z;
  float dF = P.z - uDraft.x, dM = P.z - uDraft.y, dA = P.z - uDraft.z;
  float dz = dF; if (abs(dM) < abs(dz)) dz = dM; if (abs(dA) < abs(dz)) dz = dA;
  float u = P.x >= 0.0 ? -dz : dz;
  float slot = floor(yk * 5.0 + 1e-4), fy = yk * 5.0 - slot;
  float metre = floor(slot / 5.0 + 1e-4), dec = slot - metre * 5.0;
  float k = floor(u / 0.075), gx = (u - k * 0.075) / 0.062;
  float idx = 11.0;
  if (dec < 0.5) { float tens = floor(metre / 10.0 + 1e-4), ones = metre - tens * 10.0;
    if (metre >= 9.5) idx = k < 0.5 ? tens : (k < 1.5 ? ones : (k < 2.5 ? 10.0 : 11.0));
    else idx = k < 0.5 ? ones : (k < 1.5 ? 10.0 : 11.0); }
  else idx = k < 0.5 ? dec * 2.0 : 11.0;
  float inMark = side * step(0.0, u) * step(k, 2.5) * step(fy, 0.5) * step(0.15, yk) * step(yk, uDraft.w) * step(gx, 1.0);
  float ga = texture2D(uGlyph, vec2((idx + clamp(gx, 0.0, 1.0)) / 12.0, clamp(fy * 2.0, 0.0, 1.0))).r * inMark;
  // Plimsoll disc + load-line ladder amidships, deck line above (steel ships over 24 m)
  float pm = 0.0;
  if (uDims.x > 24.0 && side > 0.5 && steel > 0.5) {
    vec2 pl = vec2(P.x >= 0.0 ? -(P.z - 1.4) : (P.z - 1.4), P.y);
    float lw = 0.0125 + 0.4 * mpp;
    pm = 1.0 - smoothstep(lw * 0.6, lw, abs(length(pl) - 0.15));
    pm = max(pm, (1.0 - smoothstep(lw * 0.6, lw, abs(pl.y))) * step(abs(pl.x), 0.225));
    float lx = pl.x - 0.54;
    pm = max(pm, (1.0 - smoothstep(lw * 0.6, lw, abs(lx))) * step(abs(pl.y), uDims.z / 48.0 + 0.05));
    for (int i = -1; i <= 2; i++) { float ty = float(i) * uDims.z / 48.0; pm = max(pm, (1.0 - smoothstep(lw * 0.6, lw, abs(pl.y - ty))) * step(0.0, lx) * step(lx, 0.23)); }
    pm = max(pm, (1.0 - smoothstep(lw * 0.6, lw, abs(pl.y - (uDims.w - 0.3)))) * step(abs(pl.x), 0.15));
  }
  float marks = max(ga, pm) * near;
  col = mix(col, rustCol, clamp(rust, 0.0, 1.0) * 0.92);
  col = mix(col, uNameCol, la);
  col = mix(col, uMarkCol, marks);
  skinH += 0.012 * la * near + 0.002 * marks;
  skinRough += 0.35 * rust - 0.1 * la;
#elif SKIN_KIND == 2
  float ax = abs(P.x), hb = uDims.y * 0.5;
  if (uDeckMode < 0.5) {
    // non-slip grain, faint plate seams, walkways, edge rust
    float grain = wh(floor(P * 37.0));
    col *= 0.95 + 0.1 * grain * near;
    skinRough += 0.06 * (grain - 0.5) * near;
    float d = min(seamDist(P.x, 2.4), seamDist(P.z + h1(floor(P.x / 2.4)) * 9.0, 9.0));
    float bead = 1.0 - smoothstep(0.0, 0.018 + 0.6 * mpp, d);
    skinH += 0.004 * bead * near; col *= 1.0 - 0.07 * bead * mid;
    float inZ = step(uLanes.x, P.z) * step(P.z, uLanes.y) * step(0.01, uLanes.w);
    float lo = hb - uLanes.z - uLanes.w, hi = hb - uLanes.z;
    float lane = inZ * smoothstep(lo - 0.02, lo + 0.02, ax) * (1.0 - smoothstep(hi - 0.02, hi + 0.02, ax));
    col = mix(col, uWalk * (0.95 + 0.1 * grain), lane);
    float edge = inZ * max(1.0 - smoothstep(0.035, 0.05 + mpp, abs(ax - lo)), 1.0 - smoothstep(0.035, 0.05 + mpp, abs(ax - hi)));
    col = mix(col, vec3(0.78, 0.55, 0.04), edge * mid);
    rust = max(rust, smoothstep(hb - 1.4, hb - 0.1, ax) * smoothstep(0.45, 0.8, wnoise(P * 1.7)) * (0.15 + grime) * 0.8);
    col = mix(col, rustCol, clamp(rust, 0.0, 1.0) * 0.85);
    skinRough += 0.1 * rust;
  } else {
    // laid teak: 0.11 m planks with black caulking, staggered butts, grain; silvers with age
    float pw = 0.11, bl = 4.2;
    float pi = floor(P.x / pw), fx = fract(P.x / pw);
    float off = h1(pi) * bl, bi = floor((P.z + off) / bl), fz = fract((P.z + off) / bl);
    float caulk = max(1.0 - smoothstep(0.0, 0.006 + 0.5 * mpp, min(fx, 1.0 - fx) * pw), 1.0 - smoothstep(0.0, 0.006 + 0.5 * mpp, min(fz, 1.0 - fz) * bl));
    col *= 0.86 + 0.24 * h1(pi * 7.13 + bi * 1.7);
    col *= 0.9 + 0.1 * wnoise(vec3(P.x * 70.0, P.z * 1.2, pi));
    col = mix(col, vec3(0.43, 0.41, 0.38), 0.45 * grime);
    col = mix(col, vec3(0.02), caulk * mid);
    skinH -= 0.002 * caulk * near;
  }
#elif SKIN_KIND == 3
  float rain = smoothstep(0.55, 0.9, wnoise(vec3((P.x + P.z) * 5.0, P.y * 0.45, 3.0))) * (0.15 + grime);
  col *= 1.0 - 0.16 * rain * (1.0 - skinGlass);
  col = mix(col, rustCol, clamp(rust, 0.0, 1.0) * 0.6 * (1.0 - skinGlass));
  skinRough += 0.25 * rust * (1.0 - skinGlass);
#elif SKIN_KIND == 4
  if (uFunnel.y > 0.0) {
    float soot = smoothstep(uFunnel.x - 0.4 * uFunnel.y, uFunnel.x, P.y) * (0.3 + 0.5 * grime) * (0.65 + 0.35 * wnoise(P * 2.1));
    col = mix(col, vec3(0.025), soot);
    skinRough += 0.2 * soot;
  }
  float d = seamDist(P.y, 1.6);
  float bead = 1.0 - smoothstep(0.0, 0.016 + 0.6 * mpp, d);
  skinH += 0.004 * bead * near;
  col = mix(col, rustCol, clamp(rust, 0.0, 1.0) * 0.7);
#else
  float dirt = smoothstep(0.5, 0.95, wnoise(P * 2.7)) * (0.1 + 0.5 * grime);
  col *= 1.0 - 0.25 * dirt;
  col = mix(col, rustCol, clamp(rust * 0.8, 0.0, 1.0) * 0.8);
  skinRough += 0.2 * rust;
#endif
  skinRough += 0.3 * w + 0.12 * grime;
  diffuseColor.rgb = col;
}
`;

const ROUGH = /* glsl */`roughnessFactor = clamp(mix(roughnessFactor + skinRough, 0.05, skinGlass), 0.04, 1.0);`;
const METAL = /* glsl */`metalnessFactor = mix(metalnessFactor, 0.0, skinGlass);`;
const BUMP = /* glsl */`
#ifndef SKIN_LITE
{
  vec3 bpx = dFdx(vShipPos), bpy = dFdy(vShipPos);
  vec2 dH = vec2(dFdx(skinH), dFdy(skinH)) / vec2(max(length(bpx), 1e-4), max(length(bpy), 1e-4));
  normal = skinPerturb(-vViewPosition, normal, clamp(dH, -1.5, 1.5), faceDirection);
}
#endif
`;
/** sky in the glass while the scene has no environment map: the hemisphere light's sky / ground colours, Fresnel-weighted */
const hemiGlass = (mask) => /* glsl */`
#if NUM_HEMI_LIGHTS > 0 && !defined( USE_ENVMAP )
{
  vec3 gvd = normalize(vViewPosition);
  vec3 grd = reflect(-gvd, normal);
  float gup = dot(grd, hemisphereLights[0].direction);
  vec3 gsky = mix(hemisphereLights[0].groundColor * 0.45, hemisphereLights[0].skyColor * 1.25, smoothstep(-0.15, 0.3, gup));
  float gfr = 0.06 + 0.94 * pow(1.0 - clamp(dot(normal, gvd), 0.0, 1.0), 5.0);
  totalEmissiveRadiance += (${mask}) * gsky * (0.2 + 0.8 * gfr) * 0.55;
}
#endif
`;
const EMIT = /* glsl */`totalEmissiveRadiance += skinLit * uNight * vec3(1.0, 0.74, 0.42) * 1.5;` + hemiGlass('skinGlass');
const IBL_FROM = 'iblIrradiance += getIBLIrradiance( geometryNormal );';
const IBL_TO = 'iblIrradiance += getIBLIrradiance( geometryNormal ) * uEnvDiffuse;';

/** One set of uniforms per ship, shared by all its skin materials (setWear / setLights touch one object). */
export function skinUniforms() {
  return {
    uWear: { value: 0 }, uFlood: { value: 0 }, uWaterY: { value: 0 }, uAge: { value: 0.2 }, uNight: { value: 0 }, uEnvDiffuse: { value: 0.4 },
    uMode: { value: 0 }, uDeckMode: { value: 0 }, uDims: { value: new THREE.Vector4(60, 10, 4, 4) }, uPlate: { value: new THREE.Vector4(2.4, 9, 1, 10) },
    uHawse: { value: new THREE.Vector4(0, 0, 0, 0) }, uLanes: { value: new THREE.Vector4(0, 0, 0, 0) }, uWalk: { value: new THREE.Color(0x4f7a5a) },
    uFunnel: { value: new THREE.Vector2(0, 0) },
    uLetter: { value: null }, uGlyph: { value: null }, uNameBow: { value: new THREE.Vector4(0, 0, 0, 0) }, uNameStern: { value: new THREE.Vector4(0, 0, 0, 0) },
    uDraft: { value: new THREE.Vector4(-20, 0, 20, 0) }, uMarkCol: { value: new THREE.Color(0xf4f4f0) }, uNameCol: { value: new THREE.Color(0xffffff) },
  };
}
const HULL_ONLY = ['uLetter', 'uGlyph', 'uNameBow', 'uNameStern', 'uDraft', 'uMarkCol', 'uNameCol'];

/**
 * A skin material. kind: shipgen / ship.js material key (hull, boot, band, deck, house, funnel, paint, metal, …);
 * color: base paint; p: { roughness, metalness, map, vertexColors, emissive…, preset, physical, lite, uniforms }.
 * Kinds without a skin (glass, cargo, decal) get a plain MeshStandardMaterial. The house / deck uniforms of one ship are
 * shared through p.uniforms (skinUniforms()).
 */
export function makeSkinMaterial(kind, color, p = {}) {
  const sk = skinKindOf(kind);
  const pre = PRESETS[p.preset] || {};
  const base = { color, roughness: p.roughness ?? pre.roughness ?? 0.6, metalness: p.metalness ?? pre.metalness ?? 0.0, vertexColors: !!p.vertexColors, map: p.map || null,
    emissive: p.emissive ?? 0x000000, emissiveIntensity: p.emissiveIntensity ?? 0, envMapIntensity: p.envMapIntensity ?? pre.envMapIntensity ?? 1 };
  if (p.transparent) Object.assign(base, { transparent: true });
  const physical = !!p.physical && (pre.clearcoat > 0 || p.clearcoat > 0);
  const m = physical ? new THREE.MeshPhysicalMaterial({ ...base, clearcoat: p.clearcoat ?? pre.clearcoat, clearcoatRoughness: p.clearcoatRoughness ?? pre.clearcoatRoughness ?? 0.3 })
    : new THREE.MeshStandardMaterial(base);
  m.name = kind;
  if (physical) m.userData.cc0 = m.clearcoat;
  if (kind === 'glass') {   // window glass: sky reflection from the hemisphere light until the scene has an environment
    m.onBeforeCompile = (shader) => { shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + hemiGlass('1.0')); };
    m.customProgramCacheKey = () => 'shipglass';
    return m;
  }
  if (!sk) return m;
  const u = p.uniforms || skinUniforms();
  m.userData.uniforms = u;
  if (SKIN_OFF) return m;
  m.userData.skinKind = sk;
  m.defines = { ...(m.defines || {}), SKIN_KIND: sk, ...(p.lite ? { SKIN_LITE: '' } : {}) };
  m.onBeforeCompile = (shader) => {
    for (const k in u) if (sk === 1 || !HULL_ONLY.includes(k)) shader.uniforms[k] = u[k];
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n' + VERT);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + FRAG_PARS)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAG_MAIN)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + ROUGH)
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n' + METAL)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + BUMP)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + EMIT)
      .replace('#include <lights_fragment_maps>', THREE.ShaderChunk.lights_fragment_maps.replace(IBL_FROM, IBL_TO));
  };
  m.customProgramCacheKey = () => `shipskin${sk}${p.lite ? 'L' : ''}`;
  return m;
}

// ------------------------------------------------------------------------------------------------ textures
let GLYPH = null;
/** Draft-mark numerals 0–9, 'M', blank: one R8 strip (12 cells, narrow bold numerals). */
export function glyphTexture() {
  if (GLYPH || !HAS_DOM) return GLYPH;
  const W = 512, H = 64, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'), cw = W / 12;
  g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.font = '700 60px "Arial Narrow", "Roboto Condensed", Arial, sans-serif';
  '0123456789M'.split('').forEach((ch, i) => {
    g.save(); g.translate(cw * (i + 0.5), H - 3); g.scale(ch === 'M' ? 0.62 : 0.78, 1.12); g.fillText(ch, 0, 0); g.restore();
  });
  GLYPH = alphaTexture(g, W, H);
  GLYPH.userData.shared = true;
  return GLYPH;
}
/** the canvas' alpha as an R8 mip-mapped texture (a quarter of the memory of the RGBA canvas) */
function alphaTexture(g, W, H) {
  const src = g.getImageData(0, 0, W, H).data, a = new Uint8Array(W * H);
  // canvas rows run top → bottom; GL textures bottom → top
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) a[(H - 1 - y) * W + x] = src[(y * W + x) * 4 + 3];
  const t = new THREE.DataTexture(a, W, H, THREE.RedFormat, THREE.UnsignedByteType);
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.anisotropy = 4; t.unpackAlignment = 1; t.needsUpdate = true;
  return t;
}

const LETTERS = new Map();   // key → { tex, refs, fill, aspect }
/**
 * Lettering texture (name on the top row, port of registry under it), cached by letteringKey with reference counts.
 * Returns { key, tex, fill, aspect } or null (no DOM / no name). Call releaseLettering(key) when the ship goes.
 */
export function acquireLettering(name, port, colorHex, W, H) {
  const n = String(name || '').trim();
  if (!HAS_DOM || !n) return null;
  const key = letteringKey(n, port, colorHex, W, H);
  let e = LETTERS.get(key);
  if (!e) {
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d'), rowH = H / 2;
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const fit = (text, size) => { let fs = size; g.font = `700 ${fs}px "Arial Narrow", "Roboto Condensed", Arial, sans-serif`; while (g.measureText(text).width > W * 0.96 && fs > 8) { fs -= Math.max(1, fs * 0.06); g.font = `700 ${fs}px "Arial Narrow", "Roboto Condensed", Arial, sans-serif`; } return g.measureText(text).width; };
    const name1 = n.toUpperCase();
    const tw = fit(name1, rowH * 0.98);
    g.fillText(name1, W / 2, rowH * 0.54);
    const p = String(port || '').trim().toUpperCase();
    if (p) { fit(p, rowH * 0.62); g.fillText(p, W / 2, rowH * 1.5); }
    e = { tex: alphaTexture(g, W, H), refs: 0, fill: Math.min(1, tw / W), aspect: W / H, key };
    LETTERS.set(key, e);
  }
  e.refs++;
  return e;
}
export function releaseLettering(key) {
  const e = key && LETTERS.get(key);
  if (!e) return;
  if (--e.refs <= 0) { e.tex.dispose(); LETTERS.delete(key); }
}
/** live lettering textures (for perf numbers / tests) */
export function letteringStats() { let bytes = 0; for (const e of LETTERS.values()) bytes += e.tex.image.width * e.tex.image.height * 1.33; return { count: LETTERS.size, bytes: Math.round(bytes) }; }

// ------------------------------------------------------------------------------------------------ safety net
let SKIN_OFF = false;
/** true once a skin program failed to link on this device (every later material is then built plain) */
export function skinDisabled() { return SKIN_OFF; }
function fallBack(m) {
  m.onBeforeCompile = () => {}; m.customProgramCacheKey = () => 'shipskin-off';
  if (m.defines) { delete m.defines.SKIN_KIND; delete m.defines.SKIN_LITE; }
  m.needsUpdate = true;
}
/**
 * Watch the first renders of a ship's skinned meshes: if the driver refused the skin program (three's diagnostics say
 * it is not runnable), switch those materials back to the plain PBR shader instead of drawing an invisible ship.
 */
export function guardSkin(group, mats) {
  const list = mats.filter((m) => m && m.userData && m.userData.skinKind);
  if (!list.length) return;
  let left = 3;
  group.traverse((o) => {
    if (!o.isMesh) return;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    if (!ms.some((m) => list.includes(m))) return;
    const prev = o.onAfterRender;
    o.onAfterRender = function (renderer, scene, camera, geometry, material) {
      try {
        const prog = renderer.properties.get(material)?.currentProgram;
        if (prog && prog.diagnostics && prog.diagnostics.runnable === false && material.userData.skinKind) {
          console.warn('[shipskin] skin shader not supported here, using plain materials');
          SKIN_OFF = true; for (const m of list) fallBack(m);
        }
      } catch { /* diagnostics only */ }
      if (--left <= 0) o.onAfterRender = prev;
    };
  });
}
