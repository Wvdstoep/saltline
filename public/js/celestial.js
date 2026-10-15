// public/js/celestial.js - Real-time celestial sphere: Solar System, Moon phases, navigation stars & constellations
import * as THREE from 'three';
import { solarPosition, lunarPosition, localSiderealTime, BRIGHT_STARS, getMajorPlanets } from '/shared/astro.js';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

const STAR_VERT = /* glsl */`
attribute float aSize;
attribute vec3 aColor;
attribute float aTwinkle;
varying vec3 vColor;
varying float vTwinkle;
uniform float uTime;
uniform float uOpacity;

void main() {
  vColor = aColor;
  vTwinkle = aTwinkle;
  float tw = 1.0 + 0.22 * sin(uTime * 3.2 + aTwinkle * 37.0) * aTwinkle;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float dist = max(1.0, -mv.z);
  gl_PointSize = clamp(aSize * tw * (28000.0 / dist), 1.8, 38.0);
  gl_Position = projectionMatrix * mv;
}
`;

const STAR_FRAG = /* glsl */`
varying vec3 vColor;
varying float vTwinkle;
uniform float uOpacity;

void main() {
  vec2 uv = gl_PointCoord - vec2(0.5);
  float d = length(uv);
  if (d > 0.5) discard;
  // Intense bright stellar point core + soft surrounding optical airy halo
  float core = exp(-d * d * 38.0);
  float halo = exp(-d * 8.5) * 0.42;
  float a = (core + halo) * uOpacity;
  if (a < 0.005) discard;
  gl_FragColor = vec4(vColor, a);
}
`;

const MOON_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const MOON_FRAG = /* glsl */`
varying vec2 vUv;
uniform float uPhase;       // 0 = new, 0.25 = 1st qtr, 0.5 = full, 0.75 = last qtr
uniform float uLimbAngle;   // crescent tilt angle in radians
uniform float uIllum;       // 0..1 illuminated fraction
uniform float uOpacity;
uniform vec3 uColor;

// Procedural lunar surface noise for maria (dark basalt plains)
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.1 + 1.3; a *= 0.5; }
  return v;
}

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);

  // Outer lunar corona / glow
  if (r > 1.0) {
    float glow = exp(-(r - 1.0) * 9.0) * 0.32 * uIllum * uOpacity;
    if (glow < 0.005) discard;
    gl_FragColor = vec4(uColor * 1.1, glow);
    return;
  }

  // 3D spherical normal on lunar disc
  float z = sqrt(max(0.0, 1.0 - r * r));
  vec3 N = vec3(p.x, p.y, z);

  // Rotate coordinates by limb angle so crescent aligns with sun direction
  float cosA = cos(uLimbAngle), sinA = sin(uLimbAngle);
  vec2 rotP = vec2(cosA * p.x - sinA * p.y, sinA * p.x + cosA * p.y);
  vec3 rotN = vec3(rotP.x, rotP.y, z);

  // Sun light vector in rotated frame: phase 0 = from back (new), 0.5 = from front (full)
  float phaseAngle = uPhase * 6.2831853;
  vec3 L = vec3(-sin(phaseAngle), 0.0, cos(phaseAngle));

  float nDotL = dot(rotN, L);

  // Procedural maria (dark plains) texture
  float maria = fbm(p * 4.2 + vec2(1.5, 0.8));
  float surfaceAlbedo = mix(0.72, 1.0, smoothstep(0.35, 0.65, maria));

  // Direct sunlit illumination with soft terminator curve
  float sunlit = smoothstep(-0.06, 0.08, nDotL) * (0.85 + 0.15 * max(0.0, nDotL));

  // Earthshine (faint glow on unlit part of the moon)
  float earthshine = 0.045 * (1.0 - uIllum) * (1.0 - smoothstep(0.0, 0.12, nDotL));

  // Spherical limb darkening
  float limb = pow(z, 0.38);

  float light = (sunlit + earthshine) * surfaceAlbedo * limb;
  vec3 col = mix(vec3(0.5, 0.55, 0.65) * earthshine, uColor * light, step(0.001, sunlit));

  float alpha = smoothstep(1.0, 0.97, r) * uOpacity;
  if (alpha < 0.01) discard;

  gl_FragColor = vec4(col, alpha);
}
`;

export class CelestialSphere {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.radius = 27000;

    // Root celestial group: tracks camera position
    this.root = new THREE.Group();
    this.root.name = 'celestialSphere';
    this.scene.add(this.root);

    // Polar tilt group: tilts Earth's polar axis by (90 - lat) towards true North (-z)
    this.polarGroup = new THREE.Group();
    this.polarGroup.name = 'celestialPolar';
    this.root.add(this.polarGroup);

    // Sidereal rotation group: spins around polar axis Y by Local Sidereal Time
    this.siderealGroup = new THREE.Group();
    this.siderealGroup.name = 'celestialSidereal';
    this.polarGroup.add(this.siderealGroup);

    // Star field
    this.stars = this.createStarField();
    this.siderealGroup.add(this.stars);

    // Major planets (Venus, Mars, Jupiter, Saturn)
    this.planets = this.createPlanets();
    this.siderealGroup.add(this.planets);

    // Moon disc mesh & moonlight directional light
    this.moonMesh = this.createMoonMesh();
    this.root.add(this.moonMesh);

    this.moonLight = new THREE.DirectionalLight(0x9bc2e8, 0);
    this.moonLight.name = 'moonLight';
    this.scene.add(this.moonLight);
    this.scene.add(this.moonLight.target);

    this.currentLat = null;
    this.lastPlanetTime = 0;
  }

  createStarField() {
    const starCount = BRIGHT_STARS.length + 1800;
    const positions = new Float32Array(starCount * 3);
    const colors = new Float32Array(starCount * 3);
    const sizes = new Float32Array(starCount);
    const twinkles = new Float32Array(starCount);

    let idx = 0;

    // 1. Navigation and prominent catalog stars
    for (const s of BRIGHT_STARS) {
      const raRad = s.ra * D2R;
      const decRad = s.dec * D2R;
      const cosDec = Math.cos(decRad);

      // Equatorial coordinates on sphere:
      // Y is celestial north pole (+90 dec), X is RA 90, -Z is RA 0
      const x = Math.sin(raRad) * cosDec * this.radius;
      const y = Math.sin(decRad) * this.radius;
      const z = -Math.cos(raRad) * cosDec * this.radius;

      positions[idx * 3] = x;
      positions[idx * 3 + 1] = y;
      positions[idx * 3 + 2] = z;

      const col = new THREE.Color(s.col);
      colors[idx * 3] = col.r;
      colors[idx * 3 + 1] = col.g;
      colors[idx * 3 + 2] = col.b;

      // Magnitude to visual point size: brighter stars (lower mag) are larger
      const sz = Math.max(2.8, 5.8 - s.mag * 0.95);
      sizes[idx] = sz;
      twinkles[idx] = s.mag < 1.5 ? 1.0 : 0.6;
      idx++;
    }

    // 2. Realistic background stars with Milky Way galactic density bias
    // Milky Way galactic pole approx RA 192.85°, Dec +27.13°
    const galPoleRA = 192.85 * D2R, galPoleDec = 27.13 * D2R;
    const gx = Math.sin(galPoleRA) * Math.cos(galPoleDec);
    const gy = Math.sin(galPoleDec);
    const gz = -Math.cos(galPoleRA) * Math.cos(galPoleDec);

    let seed = 42;
    function rand() { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }

    while (idx < starCount) {
      // Uniform random point on unit sphere
      const u = rand() * 2 - 1;
      const phi = rand() * Math.PI * 2;
      const r = Math.sqrt(Math.max(0, 1 - u * u));
      let px = r * Math.cos(phi), py = u, pz = r * Math.sin(phi);

      // Galactic latitude distance
      const galDist = Math.abs(px * gx + py * gy + pz * gz);
      // Bias stars to concentrate along the Milky Way plane (low galDist)
      if (rand() > Math.exp(-galDist * 2.8) * 0.75 + 0.25) {
        continue;
      }

      positions[idx * 3] = px * this.radius;
      positions[idx * 3 + 1] = py * this.radius;
      positions[idx * 3 + 2] = pz * this.radius;

      // Subtle star color variance: hot blue-white, white, golden, amber
      const temp = rand();
      let col;
      if (temp < 0.20) col = new THREE.Color(0xd8e8ff);
      else if (temp < 0.65) col = new THREE.Color(0xf5f8ff);
      else if (temp < 0.90) col = new THREE.Color(0xfff1d6);
      else col = new THREE.Color(0xffd4aa);

      colors[idx * 3] = col.r;
      colors[idx * 3 + 1] = col.g;
      colors[idx * 3 + 2] = col.b;

      sizes[idx] = 1.6 + rand() * 2.2;
      twinkles[idx] = rand() < 0.35 ? 0.7 : 0.2;
      idx++;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute('aTwinkle', new THREE.BufferAttribute(twinkles, 1));

    this.starUniforms = {
      uTime: { value: 0 },
      uOpacity: { value: 0 },
    };

    const mat = new THREE.ShaderMaterial({
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      uniforms: this.starUniforms,
      transparent: true,
      depthWrite: false,
      fog: false,
      blending: THREE.AdditiveBlending,
    });

    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    return pts;
  }

  createPlanets() {
    const count = 4; // Venus, Mars, Jupiter, Saturn
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const twinkles = new Float32Array(count);

    // Initialize with standard colors
    const cols = [0xffffff, 0xff7744, 0xffeedd, 0xffe4aa];
    const s = [7.5, 5.0, 7.0, 5.5];
    for (let i = 0; i < count; i++) {
      const c = new THREE.Color(cols[i]);
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
      sizes[i] = s[i];
      twinkles[i] = 0.05; // Planets shine steadily with almost no twinkle
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute('aTwinkle', new THREE.BufferAttribute(twinkles, 1));

    const mat = new THREE.ShaderMaterial({
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      uniforms: this.starUniforms,
      transparent: true,
      depthWrite: false,
      fog: false,
      blending: THREE.AdditiveBlending,
    });

    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    return pts;
  }

  updatePlanets(unixSeconds) {
    const list = getMajorPlanets(unixSeconds);
    const pos = this.planets.geometry.attributes.position.array;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const ra = p.ra, dec = p.dec;
      const cosDec = Math.cos(dec);
      pos[i * 3] = Math.sin(ra) * cosDec * this.radius;
      pos[i * 3 + 1] = Math.sin(dec) * this.radius;
      pos[i * 3 + 2] = -Math.cos(ra) * cosDec * this.radius;
    }
    this.planets.geometry.attributes.position.needsUpdate = true;
  }

  createMoonMesh() {
    // 520m radius at 26,000m distance subtends ~1.15° angular diameter (prominent, beautiful scale)
    const geo = new THREE.PlaneGeometry(1040, 1040);
    this.moonUniforms = {
      uPhase: { value: 0.5 },
      uLimbAngle: { value: 0 },
      uIllum: { value: 1.0 },
      uOpacity: { value: 0 },
      uColor: { value: new THREE.Color(0xf2eedb) },
    };

    const mat = new THREE.ShaderMaterial({
      vertexShader: MOON_VERT,
      fragmentShader: MOON_FRAG,
      uniforms: this.moonUniforms,
      transparent: true,
      depthWrite: false,
      fog: false,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = -2; // Render behind clouds (-1)
    return mesh;
  }

  /**
   * Update celestial orientation, solar/lunar position, and visibility.
   * @param {number} lat Observer latitude in degrees
   * @param {number} lon Observer longitude in degrees
   * @param {number} unixSeconds Current time in unix seconds
   * @param {object} wx Current weather object ({ cloud, storm, rain, windSpd, ... })
   * @param {number} day Daylight factor 0..1
   * @param {number} gloom Overcast/storm darkening factor 0..1
   */
  update(lat, lon, unixSeconds, wx, day, gloom) {
    const cam = this.camera.position;
    this.root.position.copy(cam);

    // 1. Polar axis orientation: tilts polar group so +Y axis points at celestial north pole
    // At lat = 52°N, celestial north is 52° above North (-z) horizon
    if (this.currentLat !== lat) {
      this.currentLat = lat;
      this.polarGroup.rotation.x = (90 - lat) * D2R;
    }

    // 2. Earth rotation around polar axis driven by Local Sidereal Time
    const lst = localSiderealTime(lon, unixSeconds);
    this.siderealGroup.rotation.y = -lst;

    // 3. Update planetary positions every 60s
    if (Math.abs(unixSeconds - this.lastPlanetTime) > 60) {
      this.lastPlanetTime = unixSeconds;
      this.updatePlanets(unixSeconds);
    }

    // 4. Astronomical Solar & Lunar position calculation
    const sun = solarPosition(lat, lon, unixSeconds);
    const moon = lunarPosition(lat, lon, unixSeconds, sun.lambdaRad);

    // 5. Cloud and storm obscuration
    const cloud = wx?.cloud ?? 0.2;
    const storm = wx?.storm ?? 0;
    const rain = Number(wx?.rain) || 0;

    // When sky is clear (cloud < 0.2, storm = 0), clearSky is ~ 1.0.
    // As cloud cover increases, stars and moon fade seamlessly.
    const clearSky = THREE.MathUtils.clamp(1.0 - cloud * 0.92 - storm * 0.8 - rain * 0.5, 0, 1);

    // Night factor: astronomical twilight begins around day < 0.4, deep night is day < 0.1
    const night = 1 - day;
    const astroNight = THREE.MathUtils.smoothstep(night, 0.4, 0.95);
    const starOpacity = astroNight * clearSky * (1.0 - gloom * 0.85);

    this.starUniforms.uTime.value = unixSeconds % 3600;
    this.starUniforms.uOpacity.value = starOpacity;

    // 6. Moon positioning & phase
    const moonDir = new THREE.Vector3(moon.dir[0], moon.dir[1], moon.dir[2]);
    const moonPos = moonDir.clone().multiplyScalar(26000);
    this.moonMesh.position.copy(moonPos);
    this.moonMesh.lookAt(0, 0, 0); // Billboard facing camera at origin

    // Moon visibility: visible when above horizon (-0.05 rad) and not completely eclipsed by day/clouds
    const moonAbove = THREE.MathUtils.smoothstep(moon.elev, -0.04, 0.08);
    // Moon is also faintly visible in daytime blue sky if bright enough
    const dayFade = Math.max(0.18, 1.0 - day * 0.8);
    const moonOpacity = moonAbove * clearSky * dayFade * (1.0 - gloom * 0.85);

    this.moonUniforms.uPhase.value = moon.phase;
    this.moonUniforms.uLimbAngle.value = moon.limbAngle;
    this.moonUniforms.uIllum.value = moon.illumination;
    this.moonUniforms.uOpacity.value = moonOpacity;
    this.moonMesh.visible = moonOpacity > 0.01;

    // 7. Moonlight directional light
    if (moon.elev > 0 && day < 0.35 && moon.illumination > 0.05) {
      this.moonLight.position.copy(moonDir).multiplyScalar(3000).add(cam);
      this.moonLight.target.position.copy(cam);
      const moonElevFrac = Math.sin(Math.max(0, moon.elev));
      const lightInt = (1 - day) * moonElevFrac * moon.illumination * 0.38 * (1 - gloom);
      this.moonLight.intensity = lightInt;
    } else {
      this.moonLight.intensity = 0;
    }

    this.lastMoon = moon;
    this.lastStarOpacity = starOpacity;
    return {
      sun,
      moon,
      starOpacity,
      moonOpacity,
      clearSky,
    };
  }
}
