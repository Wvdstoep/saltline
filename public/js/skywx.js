// public/js/skywx.js - pure helpers (no three.js, node-testable) that turn the real weather into sky parameters:
// cloud type/coverage/heights, precipitation kind, eye adaptation (exposure) and the naked-eye limiting magnitude.
// Used by sky.js and weather.js; tested by test/sky-weather.test.mjs.

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const num = (v, d) => (Number.isFinite(v) ? v : d);

/** Debug / screenshot presets (?wx=... or window.saltlineSky('storm')). Values follow game.weatherPublic(). */
export const WX_PRESETS = {
  clear: { cloud: 0.04, cloudLow: 0.02, cloudHigh: 0.08, rain: 0, storm: 0, visibility: 40000, windSpd: 4 },
  fair: { cloud: 0.35, cloudLow: 0.32, cloudHigh: 0.2, rain: 0, storm: 0, visibility: 30000, windSpd: 6 },
  cumulus: { cloud: 0.35, cloudLow: 0.32, cloudHigh: 0.2, rain: 0, storm: 0, visibility: 30000, windSpd: 6 },
  broken: { cloud: 0.7, cloudLow: 0.65, cloudHigh: 0.3, rain: 0, storm: 0, visibility: 25000, windSpd: 8 },
  overcast: { cloud: 1, cloudLow: 1, cloudHigh: 0.4, rain: 0, storm: 0, visibility: 16000, windSpd: 7 },
  rain: { cloud: 1, cloudLow: 1, cloudHigh: 0.5, rain: 0.5, storm: 0.1, visibility: 6000, windSpd: 11 },
  storm: { cloud: 1, cloudLow: 0.9, cloudHigh: 0.6, rain: 0.9, storm: 0.95, visibility: 2500, windSpd: 23 },
  thunder: { cloud: 0.75, cloudLow: 0.6, cloudHigh: 0.5, rain: 0.6, storm: 0.85, visibility: 6000, windSpd: 14 },
  fog: { cloud: 0.5, cloudLow: 0.5, cloudHigh: 0.1, rain: 0, storm: 0, visibility: 350, windSpd: 2 },
  mist: { cloud: 0.6, cloudLow: 0.6, cloudHigh: 0.2, rain: 0.05, storm: 0, visibility: 2500, windSpd: 3 },
  snow: { cloud: 1, cloudLow: 1, cloudHigh: 0.4, rain: 0.4, storm: 0, visibility: 2000, windSpd: 9, temp: -3 },
  cirrus: { cloud: 0.4, cloudLow: 0, cloudHigh: 0.7, rain: 0, storm: 0, visibility: 40000, windSpd: 5 },
};

/**
 * Cloud and precipitation parameters from a weather sample (game.weatherPublic / weatherAt shape, all optional):
 * cloud (total 0..1), cloudLow, cloudHigh (0..1, Open-Meteo layers), rain 0..1 (precip mm/h / 4), storm 0..1,
 * visibility (m), temp (deg C), windSpd (m/s).
 * Returns { cover, high, base, thick, cbTop, cb, stratus, dens, rain, snow, vis }:
 *  cover   low/mid cloud fraction (0..1) - also the fraction of sky the renderer covers
 *  cb      convective (cumulonimbus) weight 0..1; stratus 0 = cumulus .. 1 = stratus sheet
 *  base / thick / cbTop  heights (m); dens extinction per unit density (1/m)
 *  snow    0..1 how much of the precipitation falls as snow (temperature below ~1 C)
 */
export function cloudParams(w = {}) {
  const cloud = clamp(num(w.cloud, 0.3), 0, 1);
  const rain = clamp(num(w.rain, 0), 0, 1), storm = clamp(num(w.storm, 0), 0, 1);
  const vis = clamp(num(w.visibility, 20000), 50, 100000);
  const wet = rain > 0.03 || storm > 0.3;
  const low = clamp(Number.isFinite(w.cloudLow) ? Math.max(w.cloudLow, wet ? cloud * 0.85 : 0) : cloud * (wet ? 1 : 0.85), 0, 1);
  const high = clamp(Number.isFinite(w.cloudHigh) ? w.cloudHigh : Math.max(0, cloud - low * 0.6) * 0.8 + 0.05 * cloud, 0, 1);
  const cb = sstep(0.3, 0.85, storm) * (rain > 0.02 || storm > 0.6 ? 1 : 0.6);
  const stratus = clamp(sstep(0.7, 0.97, low) + (rain > 0.05 ? 0.35 : 0) - 0.8 * cb, 0, 1);
  const cover = clamp(Math.max(low, cb * 0.55, rain > 0.05 ? 0.8 : 0), 0, 1);
  let base = 1300 + (1 - cover) * 300 - 650 * stratus;
  if (rain > 0.02) base = Math.min(base, 750 - 350 * rain);
  if (cb > 0) base = Math.min(base, 1100 - 500 * cb);
  if (vis < 3000) base = Math.min(base, Math.max(60, vis * 0.3));
  const thick = 1700 - 800 * stratus + 1800 * rain * (1 - cb);
  const cbTop = 7500 + 4000 * storm;
  const dens = 0.028 + 0.025 * rain + 0.03 * cb;
  const t = num(w.temp, 12);
  const snow = rain > 0 ? clamp((2.0 - t) / 2.0, 0, 1) : 0;    // all snow below 0 C, sleet 0..2 C
  return { cover, high, base, thick, cbTop, cb, stratus, dens, rain, snow, vis };
}

/** three.js r160 ACESFilmic tone mapping (per channel, exposure folded in) - for colours that must match the output. */
export function acesTone(c, exposure = 1) {
  const v = c.map((x) => (x * exposure) / 0.6);
  const m1 = [[0.59719, 0.07600, 0.02840], [0.35458, 0.90834, 0.13383], [0.04823, 0.01566, 0.83777]];
  const m2 = [[1.60475, -0.10208, -0.00327], [-0.53108, 1.10813, -0.07276], [-0.07367, -0.00605, 1.07602]];
  const mul = (m, x) => [0, 1, 2].map((i) => m[0][i] * x[0] + m[1][i] * x[1] + m[2][i] * x[2]);
  const a = mul(m1, v).map((x) => (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.4329510) + 0.238081));
  return mul(m2, a).map((x) => Math.max(0, Math.min(1, x)));
}
export const linearToSrgb = (l) => (l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055);
/** Tone-mapper input (grey) that displays as sRGB value `srgb` (bisection on the ACES curve). */
export function acesInputFor(srgb) {
  let lo = 0, hi = 20;
  for (let i = 0; i < 48; i++) { const mid = (lo + hi) / 2; if (linearToSrgb(acesTone([mid, mid, mid])[1]) < srgb) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

/**
 * Exposure: a FIXED curve of the Sun's elevation (no adaptation that drifts with the weather).
 *  kDay      the daytime exposure (calibrateDayExposure: a sunlit 18 % grey displays as mid grey)
 *  lzen(e)   the clear-sky zenith luminance the model gives at elevation e (model units, Sun = 1)
 *  ltw(e)    the twilight term (twilightLuminance)
 * Above the reference elevation the exposure is kDay; as the Sun sets the scene gets darker and the exposure rises
 * with exponent 0.65 of the darkening (partial compensation: dusk stays dusk), capped at kDay * NIGHT_RATIO.
 */
export const NIGHT_RATIO = 1200;
export function exposureCurve(kDay, lzenRef, lzenAt, ltwAt) {
  return (elevDeg) => {
    const L = Math.max(1e-12, lzenAt(elevDeg) + ltwAt(elevDeg));
    return kDay * Math.min(NIGHT_RATIO, Math.max(1, Math.pow(lzenRef / L, 0.65)));
  };
}
/**
 * Daytime exposure so that an 18 % grey facing the Sun displays as sRGB `target` (0.45 by default): the Sun's
 * irradiance eSun (model units, TOA = 1), the sky irradiance eSky on an upward face (same units).
 */
export function calibrateDayExposure(eSun, eSky, target = 0.45) {
  const grey = (0.18 / Math.PI) * (eSun + eSky);
  return acesInputFor(target) / Math.max(1e-9, grey);
}
/** Kept for the HUD / old callers: the exposure the old adaptive rule gave (not used for rendering any more). */
export function exposureFor(lzenSun) {
  const L = Math.max(1e-12, lzenSun);
  return 14 * clamp(Math.pow(0.02 / L, 0.75), 1, 4000);
}

/**
 * Zenith luminance of the twilight sky from multiple scattering (same units), which single scattering misses once
 * the Sun is more than ~5 deg down: measured twilight falls ~0.43 dex per degree (about 3 cd/m2 at -6 deg,
 * 0.01 at -12, night level by -18).
 */
export function twilightLuminance(sunElevDeg) {
  const e = sunElevDeg;
  if (e > -2) return 0;
  return 4.5e-6 * Math.pow(10, 0.43 * Math.min(0, e + 6)) * sstep(-2, -5, e);
}

/**
 * Naked-eye limiting magnitude from the physical sky background luminance (same units, Sun AND Moon light, no
 * boosts): ~6.5 under a dark sky, ~5 under a full moon, ~1.5 at the end of civil twilight, below -3.5 in daylight
 * (Venus can just be seen at noon).
 */
export function limitingMagnitude(lsky) {
  const ratio = Math.max(1, lsky / 3e-9);
  return 6.5 - 1.5 * Math.log10(ratio);
}

/** Relative illuminance of the Moon vs full (Allen: m = -12.73 + 0.026|i| + 4e-9 i^4), i = phase angle in degrees. */
export function moonPhaseLaw(iDeg) {
  const i = Math.abs(iDeg);
  return Math.pow(10, -0.4 * (0.026 * i + 4e-9 * i ** 4));
}
/** Full-moon illuminance relative to the Sun's (magnitudes -12.73 vs -26.74). */
export const FULL_MOON_E = Math.pow(10, -0.4 * (26.74 - 12.73));
