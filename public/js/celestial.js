// public/js/celestial.js - the celestial sphere: stars (catalogue + procedural fill to mag 6.5), the Milky Way, the four
// bright planets where they really are, and the ONE Moon - at its true size (~0.52 deg), its real phase and
// orientation (lit from the Sun's actual direction in 3D, so the bright limb always faces the Sun), its near-side
// maria, and earthshine on the dark part.
// Everything here is drawn BEFORE the sky dome (renderOrder -20 ... -18) onto the cleared background; the sky dome
// (sky.js) then multiplies what is behind it by the atmosphere's and the clouds' transmittance and adds the sky light
// on top. So stars fade into the daylight, sink into the horizon extinction and hide behind clouds per pixel, and
// the daytime Moon is pale - with no extra bookkeeping here. Visibility of faint stars follows the naked-eye
// limiting magnitude that sky.js computes from the sky brightness (twilight, moonlight).
// Frame: J2000 equatorial (x -> RA 0h, y -> RA 6h, z -> north pole) rotated by precession, sidereal time and
// latitude into Saltline world coordinates (x East, y Up, -z North).
import * as THREE from 'three';
import { BRIGHT_STARS, getMajorPlanets, localSiderealTime, precessionMatrix } from '/shared/astro.js';

const D2R = Math.PI / 180;
const R_SKY = 38500;               // inside the sky dome (39 km) and the camera far plane (40 km)

const STAR_VERT = /* glsl */`
attribute float aMag; attribute vec3 aColor; attribute float aSeed;
uniform float uTime; uniform float uLimit; uniform float uExtK; uniform float uPx; uniform float uGain; uniform float uTwinkle;
varying vec3 vColor; varying float vI;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec3 dir = normalize(wp.xyz - cameraPosition);
  float alt = max(dir.y, -0.05);
  // atmospheric extinction: airmass (Kasten-Young-ish), k mag per airmass
  float am = 1.0 / (max(alt, 0.0) + 0.025 * exp(-11.0 * max(alt, 0.0)));
  float m = aMag + uExtK * min(am, 40.0);
  // scintillation: stronger towards the horizon, none for planets (aSeed < 0)
  float tw = aSeed < 0.0 ? 0.0 : uTwinkle * (0.25 + 0.75 * (1.0 - alt)) * (sin(uTime * (7.0 + aSeed * 9.0) + aSeed * 61.0) * 0.6 + sin(uTime * (13.0 + aSeed * 5.0) + aSeed * 17.0) * 0.4);
  m += tw * 0.35;
  float vis = 1.0 - smoothstep(uLimit - 1.2, uLimit + 0.2, m);
  float I = pow(10.0, -0.4 * 0.62 * (m - 1.0));      // perceptual: compressed magnitude scale
  vI = clamp(I, 0.0, 3.0) * vis * uGain * step(-0.02, dir.y);
  vColor = aColor;
  gl_PointSize = uPx * clamp(1.35 + 0.75 * (2.6 - m), 1.2, 5.5);
  gl_Position = projectionMatrix * viewMatrix * wp;
  if (vI < 0.003) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;
const STAR_FRAG = /* glsl */`
varying vec3 vColor; varying float vI;
void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float d2 = dot(uv, uv) * 4.0;
  float core = exp(-d2 * 7.0);
  float a = core * vI;
  if (a < 0.002) discard;
  gl_FragColor = vec4(vColor * a, 1.0);
  #include <colorspace_fragment>
}`;

const MW_VERT = /* glsl */`
varying vec3 vEq;
void main() { vEq = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const MW_FRAG = /* glsl */`
varying vec3 vEq; uniform float uI; uniform vec3 uGP; uniform vec3 uGC;
float h3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float n3(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h3(i), h3(i + vec3(1, 0, 0)), f.x), mix(h3(i + vec3(0, 1, 0)), h3(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(h3(i + vec3(0, 0, 1)), h3(i + vec3(1, 0, 1)), f.x), mix(h3(i + vec3(0, 1, 1)), h3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
void main() {
  vec3 d = normalize(vEq);
  float b = asin(clamp(dot(d, uGP), -1.0, 1.0));             // galactic latitude
  vec3 gy = normalize(cross(uGP, uGC));
  float l = atan(dot(d, gy), dot(d, uGC));                    // galactic longitude, 0 at the centre (Sagittarius)
  float width = 0.11 + 0.10 * exp(-l * l / 0.6);              // the bulge is fatter
  float band = exp(-(b * b) / (2.0 * width * width));
  float core = 0.35 + 0.65 * exp(-l * l / 1.2);               // brighter towards Sagittarius / Scutum
  float n = n3(d * 9.0) * 0.5 + n3(d * 23.0) * 0.3 + n3(d * 61.0) * 0.2;
  float lumps = 0.55 + 0.9 * n;
  // dark rift (Cygnus to Sagittarius) just north of the plane, l = -10 .. 80 deg
  float rift = smoothstep(0.0, 0.05, b) * (1.0 - smoothstep(0.05, 0.11, b)) * smoothstep(-0.3, 0.1, l) * (1.0 - smoothstep(1.2, 1.5, l));
  float v = band * core * lumps * (1.0 - 0.65 * rift);
  vec3 col = mix(vec3(0.75, 0.8, 1.0), vec3(1.0, 0.92, 0.78), exp(-l * l / 1.0)) * v * uI;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

const MOON_VERT = /* glsl */`
varying vec2 vUv; varying vec3 vRight; varying vec3 vUp; varying vec3 vFwd;
void main() {
  vUv = uv;
  vRight = normalize((modelMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
  vUp = normalize((modelMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  vFwd = normalize((modelMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const MOON_FRAG = /* glsl */`
varying vec2 vUv; varying vec3 vRight; varying vec3 vUp; varying vec3 vFwd;
uniform vec3 uSun;          // unit vector from the Moon towards the Sun (world)
uniform float uBright;      // display radiance of the full-lit surface
uniform float uEarthshine;  // display radiance of the earthshine-lit surface
uniform vec3 uTint;         // atmospheric reddening near the horizon
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + 1.7; a *= 0.5; } return v; }
// soft spot in selenographic (lat, lon) degrees
float spot(vec2 ll, vec2 c, float r) { vec2 d = (ll - c) * vec2(1.0, cos(radians(c.x))); return 1.0 - smoothstep(r * 0.55, r, length(d)); }
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  float z = sqrt(1.0 - r2);
  vec3 N = normalize(p.x * vRight + p.y * vUp + z * vFwd);
  // selenographic coordinates of this point (near side faces Earth; east limb on the right with north up)
  float lat = degrees(asin(clamp(p.y, -1.0, 1.0)));
  float lon = degrees(atan(p.x, z));
  vec2 ll = vec2(lat, lon);
  float m = 0.0;
  m = max(m, spot(ll, vec2(33.0, -16.0), 19.0));   // Imbrium
  m = max(m, spot(ll, vec2(28.0, 17.5), 10.0));    // Serenitatis
  m = max(m, spot(ll, vec2(8.5, 31.0), 13.0));     // Tranquillitatis
  m = max(m, spot(ll, vec2(17.0, 59.0), 7.5));     // Crisium
  m = max(m, spot(ll, vec2(18.0, -57.0), 22.0));   // Oceanus Procellarum (north)
  m = max(m, spot(ll, vec2(-2.0, -45.0), 16.0));   // Procellarum (south)
  m = max(m, spot(ll, vec2(-21.0, -17.0), 11.0));  // Nubium
  m = max(m, spot(ll, vec2(-8.0, 51.0), 9.5));     // Fecunditatis
  m = max(m, spot(ll, vec2(-15.0, 35.0), 6.0));    // Nectaris
  m = max(m, spot(ll, vec2(-24.0, -39.0), 6.0));   // Humorum
  m = max(m, spot(ll, vec2(-15.0, -30.0), 7.0));   // Cognitum
  m = max(m, spot(ll, vec2(56.0, -10.0), 6.0) + spot(ll, vec2(57.0, 20.0), 6.0)); // Frigoris
  m = max(m, spot(ll, vec2(13.0, 4.0), 4.5));      // Vaporum
  m = max(m, spot(ll, vec2(7.0, -31.0), 7.0));     // Insularum
  float tex = fbm(vec2(lon, lat) * 0.09);
  m = clamp(m * (0.75 + 0.5 * tex) - 0.08, 0.0, 1.0);
  float albedo = mix(1.0, 0.56, m) * (0.9 + 0.2 * fbm(vec2(lon, lat) * 0.6));
  // bright young craters with rays: Tycho, Copernicus, Kepler, Aristarchus
  float tycho = spot(ll, vec2(-43.3, -11.2), 2.2);
  vec2 dt = (ll - vec2(-43.3, -11.2)) * vec2(1.0, 0.73);
  float rays = pow(abs(sin(atan(dt.y, dt.x) * 9.0 + fbm(dt * 0.1) * 6.0)), 18.0) * exp(-length(dt) / 30.0);
  albedo += 0.45 * tycho + 0.18 * rays + 0.35 * spot(ll, vec2(9.6, -20.1), 1.8) + 0.3 * spot(ll, vec2(8.1, -38.0), 1.4) + 0.6 * spot(ll, vec2(23.7, -47.4), 1.2);
  // Lommel-Seeliger: the full Moon is flat-lit (no limb darkening), the terminator is soft
  float mu0 = dot(N, uSun), mu = z;
  float lit = mu0 > 0.0 ? 2.0 * mu0 / (mu0 + mu + 1e-4) : 0.0;
  lit *= smoothstep(-0.02, 0.04, mu0);
  float es = uEarthshine * mu * (1.0 - smoothstep(-0.05, 0.1, mu0));
  vec3 col = (vec3(1.0, 0.985, 0.95) * uBright * lit * 0.5 + vec3(0.62, 0.72, 0.95) * es) * albedo * uTint;
  float edge = 1.0 - smoothstep(0.985, 1.0, r2);
  gl_FragColor = vec4(col * edge, 1.0);
  #include <colorspace_fragment>
}`;

function colorFromHex(h) { const c = new THREE.Color(h); return [c.r, c.g, c.b]; }

export class CelestialSphere {
  constructor(scene, camera, { phone = false } = {}) {
    this.scene = scene; this.camera = camera; this.phone = phone;
    this.root = new THREE.Group(); this.root.name = 'celestialSphere'; scene.add(this.root);
    // J2000 equatorial frame -> world (matrix rebuilt every frame from LST, latitude and precession)
    this.eq = new THREE.Group(); this.eq.name = 'celestialEquatorial'; this.eq.matrixAutoUpdate = false; this.root.add(this.eq);
    this.starU = {
      uTime: { value: 0 }, uLimit: { value: 6.5 }, uExtK: { value: 0.25 }, uPx: { value: 1 }, uGain: { value: 1 }, uTwinkle: { value: 1 },
    };
    this.stars = this.createStars();
    this.eq.add(this.stars);
    this.milkyWay = this.createMilkyWay(); this.eq.add(this.milkyWay);
    this.planets = this.createPlanets(); this.eq.add(this.planets);
    this.moonMesh = this.createMoon(); this.root.add(this.moonMesh);
    this.lastPlanetTime = -1e12; this.planetList = [];
    this.lastMoon = null; this.lastStarOpacity = 0;
    this._m = new THREE.Matrix4(); this._v = new THREE.Vector3(); this._ncp = new THREE.Vector3();
  }

  createStars() {
    const nFill = this.phone ? 2600 : 5200;
    const n = BRIGHT_STARS.length + nFill;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), mag = new Float32Array(n), seed = new Float32Array(n);
    let i = 0;
    const put = (ra, dec, m, c) => {
      const cd = Math.cos(dec);
      pos[i * 3] = Math.cos(ra) * cd * R_SKY; pos[i * 3 + 1] = Math.sin(ra) * cd * R_SKY; pos[i * 3 + 2] = Math.sin(dec) * R_SKY;
      col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
      mag[i] = m; seed[i] = ((i * 0.618034) % 1); i++;
    };
    for (const s of BRIGHT_STARS) put(s.ra * D2R, s.dec * D2R, s.mag, colorFromHex(s.col));
    // procedural fill: number counts N(<m) ~ 10^(0.5 m) between mag 3.4 and 6.5, concentrated towards the galactic plane
    const gp = this.eqVec(192.85948, 27.12825);
    let sd = 1234567;
    const rnd = () => { sd = (sd * 16807) % 2147483647; return (sd - 1) / 2147483646; };
    const lo = Math.pow(10, 0.5 * 3.4), hi = Math.pow(10, 0.5 * 6.5);
    const tints = [[0.78, 0.86, 1.0], [0.88, 0.92, 1.0], [1.0, 1.0, 1.0], [1.0, 0.95, 0.85], [1.0, 0.86, 0.68], [1.0, 0.76, 0.56]];
    const tw = [0.08, 0.22, 0.3, 0.22, 0.12, 0.06];
    while (i < n) {
      const u = rnd() * 2 - 1, ph = rnd() * Math.PI * 2, r = Math.sqrt(1 - u * u);
      const x = r * Math.cos(ph), y = r * Math.sin(ph), z = u;
      const sinb = Math.abs(x * gp[0] + y * gp[1] + z * gp[2]);
      if (rnd() > 0.35 + 0.65 * Math.exp(-sinb * sinb / 0.06)) continue;
      const m = Math.log10(lo + rnd() * (hi - lo)) / 0.5;
      let k = rnd(), t = 0; while (t < tw.length - 1 && k > tw[t]) { k -= tw[t]; t++; }
      put(Math.atan2(y, x), Math.asin(z), m, tints[t]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    const mat = new THREE.ShaderMaterial({ uniforms: this.starU, vertexShader: STAR_VERT, fragmentShader: STAR_FRAG, transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending });
    const pts = new THREE.Points(g, mat); pts.frustumCulled = false; pts.renderOrder = -19;
    return pts;
  }
  eqVec(raDeg, decDeg) { const a = raDeg * D2R, d = decDeg * D2R; return [Math.cos(a) * Math.cos(d), Math.sin(a) * Math.cos(d), Math.sin(d)]; }

  createMilkyWay() {
    this.mwU = { uI: { value: 0 }, uGP: { value: new THREE.Vector3(...this.eqVec(192.85948, 27.12825)) }, uGC: { value: new THREE.Vector3(...this.eqVec(266.405, -28.936)) } };
    const mat = new THREE.ShaderMaterial({ uniforms: this.mwU, vertexShader: MW_VERT, fragmentShader: MW_FRAG, transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending, side: THREE.BackSide });
    const m = new THREE.Mesh(new THREE.SphereGeometry(R_SKY * 1.005, 48, 24), mat); m.frustumCulled = false; m.renderOrder = -20;
    return m;
  }

  createPlanets() {
    const n = 4;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
    g.setAttribute('aMag', new THREE.BufferAttribute(new Float32Array(n).fill(9), 1));
    g.setAttribute('aSeed', new THREE.BufferAttribute(new Float32Array(n).fill(-1), 1));   // planets do not twinkle
    const mat = new THREE.ShaderMaterial({ uniforms: this.starU, vertexShader: STAR_VERT, fragmentShader: STAR_FRAG, transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending });
    const pts = new THREE.Points(g, mat); pts.frustumCulled = false; pts.renderOrder = -18;
    return pts;
  }
  updatePlanets(unix) {
    const list = getMajorPlanets(unix);
    const P = this.planets.geometry.attributes;
    list.forEach((p, i) => {
      const cd = Math.cos(p.dec);
      P.position.array[i * 3] = Math.cos(p.ra) * cd * R_SKY; P.position.array[i * 3 + 1] = Math.sin(p.ra) * cd * R_SKY; P.position.array[i * 3 + 2] = Math.sin(p.dec) * R_SKY;
      const c = colorFromHex(p.col); P.aColor.array.set(c, i * 3);
      P.aMag.array[i] = p.mag;
    });
    P.position.needsUpdate = true; P.aColor.needsUpdate = true; P.aMag.needsUpdate = true;
    this.planetList = list;
  }

  createMoon() {
    this.moonU = { uSun: { value: new THREE.Vector3(0, 0, 1) }, uBright: { value: 1.5 }, uEarthshine: { value: 0.02 }, uTint: { value: new THREE.Vector3(1, 1, 1) } };
    const mat = new THREE.ShaderMaterial({ uniforms: this.moonU, vertexShader: MOON_VERT, fragmentShader: MOON_FRAG, transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat); m.frustumCulled = false; m.renderOrder = -18; m.name = 'moon';
    return m;
  }

  /**
   * Per frame. o: { lat, lon, unix, sun, moon (astro results), limitMag, extK, starGain, moonBright, earthshine,
   * moonTint [r,g,b], milkyWay (display intensity), pixelRatio }. Returns nothing; keeps lastMoon/lastStarOpacity.
   */
  update(o) {
    const cam = this.camera.position;
    this.root.position.copy(cam);
    // equatorial J2000 -> world: H(lat, LST) * P(precession)
    const L = localSiderealTime(o.lon, o.unix), phi = o.lat * D2R;
    const sL = Math.sin(L), cL = Math.cos(L), sP = Math.sin(phi), cP = Math.cos(phi);
    const H = [-sL, cL, 0, cP * cL, cP * sL, sP, sP * cL, sP * sL, -cP];
    if (!this._prec || Math.abs(o.unix - this._precT) > 86400) { this._prec = precessionMatrix(o.unix); this._precT = o.unix; }
    const Pm = this._prec, M = new Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) M[r * 3 + c] = H[r * 3] * Pm[c] + H[r * 3 + 1] * Pm[3 + c] + H[r * 3 + 2] * Pm[6 + c];
    this.eq.matrix.set(M[0], M[1], M[2], 0, M[3], M[4], M[5], 0, M[6], M[7], M[8], 0, 0, 0, 0, 1);
    this.eq.matrixWorldNeedsUpdate = true;
    this._ncp.set(H[2], H[5], H[8]);                           // celestial north pole in world (of date)

    if (Math.abs(o.unix - this.lastPlanetTime) > 60) { this.lastPlanetTime = o.unix; this.updatePlanets(o.unix); }

    const su = this.starU;
    su.uTime.value = (performance.now() / 1000) % 1000;
    su.uLimit.value = o.limitMag; su.uExtK.value = o.extK; su.uGain.value = o.starGain ?? 1;
    su.uPx.value = o.pixelRatio || 1;
    this.mwU.uI.value = o.milkyWay || 0;
    this.milkyWay.visible = this.mwU.uI.value > 0.0005;
    this.stars.visible = o.limitMag > -1.6;
    this.planets.visible = o.limitMag > -4.8;

    // the Moon: one disc at its true angular size, sphere-lit from the Sun's direction
    const moon = o.moon, sun = o.sun;
    const md = this._v.set(moon.dir[0], moon.dir[1], moon.dir[2]);
    const dist = R_SKY * 0.99, size = 2 * dist * Math.tan((moon.angDiamDeg || 0.52) * D2R / 2);
    this.moonMesh.position.copy(md).multiplyScalar(dist);
    this.moonMesh.scale.set(size, size, 1);
    this.moonMesh.up.copy(this._ncp);
    this.moonMesh.lookAt(cam);                                  // +Z towards the observer, +Y towards celestial north
    // direction Moon -> Sun: Sun at 1 AU, Moon at its distance (the difference is the phase geometry)
    const AU = 149597870.7, dk = moon.distKm || 384400;
    const sx = sun.dir[0] * AU - md.x * dk, sy = sun.dir[1] * AU - md.y * dk, sz = sun.dir[2] * AU - md.z * dk;
    this.moonU.uSun.value.set(sx, sy, sz).normalize();
    this.moonU.uBright.value = o.moonBright; this.moonU.uEarthshine.value = o.earthshine;
    if (o.moonTint) this.moonU.uTint.value.set(o.moonTint[0], o.moonTint[1], o.moonTint[2]);
    this.moonMesh.visible = moon.elevDeg > -1.5 && o.moonBright > 0.002;

    this.lastMoon = moon;
    this.lastStarOpacity = THREE.MathUtils.clamp((o.limitMag - 1) / 4, 0, 1) * (o.clearSky ?? 1);
  }
}
