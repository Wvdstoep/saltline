// The sky's pure helpers: atmosphere (atmos.js), cloud parameters / exposure / limiting magnitude (skywx.js) and the
// cloud noise (skynoise.js). No three.js, no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { skyRadiance, skyAmbient, transmittance, mieForVisibility, luminance } from '../public/js/atmos.js';
import { cloudParams, exposureFor, limitingMagnitude, moonPhaseLaw, twilightLuminance, WX_PRESETS } from '../public/js/skywx.js';
import { weatherMap, sampleMap } from '../public/js/skynoise.js';

const el = (deg) => { const e = deg * Math.PI / 180; return [0, Math.sin(e), -Math.cos(e)]; };

test('atmosphere: blue zenith, white-ish horizon, red low sun, dark after dusk', () => {
  const mie = mieForVisibility(30000), sun = el(40), amb = skyAmbient(10, sun, mie);
  const zen = skyRadiance(10, [0, 1, 0], sun, mie, amb);
  assert.ok(zen[2] > zen[1] && zen[1] > zen[0], `zenith is blue ${zen}`);
  const hor = skyRadiance(10, [0, 0.03, 0.9995], sun, mie, amb);
  assert.ok(hor[2] / hor[0] < zen[2] / zen[0], 'the horizon is paler (less saturated) than the zenith');
  const tHigh = transmittance(10, Math.sin(60 * Math.PI / 180), mie), tLow = transmittance(10, Math.sin(2 * Math.PI / 180), mie);
  assert.ok(tHigh[0] > 0.8 && tHigh[2] > 0.6, `high Sun barely dimmed ${tHigh}`);
  assert.ok(tLow[0] > tLow[1] && tLow[1] > tLow[2] * 3, `low Sun is red ${tLow}`);
  assert.deepEqual(transmittance(10, -0.2, mie), [0, 0, 0], 'Sun below the horizon: no direct light');
  // twilight: the zenith is still lit at -4 deg (Earth shadow), much darker at -10
  const z4 = luminance(skyRadiance(10, [0, 1, 0], el(-4), mie)), z10 = luminance(skyRadiance(10, [0, 1, 0], el(-10), mie));
  const z40 = luminance(zen);
  assert.ok(z4 > 0 && z4 < z40 / 20 && z10 < z4 / 50, `twilight fades ${z40} ${z4} ${z10}`);
  // haze: lower visibility = a grey-white horizon (no longer blue); towards the Sun the haze glows
  const m5 = mieForVisibility(5000), amb5 = skyAmbient(10, sun, m5);
  const hazy = skyRadiance(10, [0, 0.03, 0.9995], sun, m5, amb5), hazySun = skyRadiance(10, [0, 0.03, -0.9995], sun, m5, amb5);
  assert.ok(hazy[2] / hazy[0] < 1.1 && hazy[2] / hazy[0] < hor[2] / hor[0], `hazy horizon is grey ${hazy}`);
  assert.ok(luminance(hazySun) > 2 * luminance(hazy), 'forward-scattering glow around the Sun');
});

test('cloud parameters follow the weather data', () => {
  const clear = cloudParams(WX_PRESETS.clear), fair = cloudParams(WX_PRESETS.fair), oc = cloudParams(WX_PRESETS.overcast);
  const rain = cloudParams(WX_PRESETS.rain), storm = cloudParams(WX_PRESETS.storm), fog = cloudParams(WX_PRESETS.fog), snow = cloudParams(WX_PRESETS.snow);
  assert.ok(clear.cover < 0.1 && fair.cover > 0.25 && fair.cover < 0.45 && oc.cover > 0.95, 'cover = the real cloud fraction');
  assert.ok(fair.stratus < 0.2 && oc.stratus > 0.9, 'fair weather cumulus, overcast stratus');
  assert.ok(storm.cb > 0.9 && storm.cbTop > 10000, 'storms grow cumulonimbus towers');
  assert.ok(rain.base < fair.base && storm.base < fair.base, 'rain lowers the cloud base');
  assert.ok(fog.base < 200, `fog: the deck sits on the sea (${fog.base})`);
  assert.equal(snow.snow, 1, 'below 0 C it snows');
  assert.equal(cloudParams({ cloud: 1, rain: 0.5, temp: 1 }).snow, 0.5, 'sleet around 1 C');
  assert.equal(cloudParams({ cloud: 1, rain: 0.5, temp: 8 }).snow, 0);
  // Open-Meteo layers: high-only cloud is cirrus, not a low deck
  const ci = cloudParams({ cloud: 0.5, cloudLow: 0, cloudHigh: 0.7 });
  assert.ok(ci.cover < 0.05 && ci.high > 0.6);
  // missing data never produces NaN
  for (const v of Object.values(cloudParams({}))) assert.ok(Number.isFinite(v));
});

test('eye adaptation and naked-eye limiting magnitude', () => {
  assert.equal(exposureFor(0.02), 14);
  assert.ok(exposureFor(1e-3) > 80 && exposureFor(1e-3) < 200);
  assert.equal(exposureFor(1e-12), 14 * 4000, 'capped at night');
  // twilight sky (multiple scattering): monotonic, ~0.43 dex per degree, gone by astronomical night
  assert.equal(twilightLuminance(5), 0);
  assert.ok(twilightLuminance(-6) > twilightLuminance(-9) && twilightLuminance(-9) > twilightLuminance(-12));
  assert.ok(Math.abs(Math.log10(twilightLuminance(-8) / twilightLuminance(-10)) - 0.86) < 0.01);
  assert.ok(limitingMagnitude(twilightLuminance(-18) + 3e-9) > 6.3, 'astronomical night: all the stars');
  const nautical = limitingMagnitude(twilightLuminance(-9));
  assert.ok(nautical > 2.5 && nautical < 4.5, `nautical twilight: navigation stars and the horizon both visible (${nautical})`);
  assert.ok(Math.abs(limitingMagnitude(3e-9) - 6.5) < 1e-9, 'dark sky: mag 6.5');
  assert.ok(limitingMagnitude(2e-2) < -3.5, 'daylight: only Venus');
  const lim = limitingMagnitude(6.5e-6);
  assert.ok(lim > 1 && lim < 2.5, `end of civil twilight: first-magnitude stars (${lim})`);
  assert.equal(moonPhaseLaw(0), 1);
  assert.ok(Math.abs(moonPhaseLaw(90) - 0.08) < 0.03, `quarter Moon ~8 % of full (${moonPhaseLaw(90)})`);
});

test('weather map: cover fraction is exact and the map tiles seamlessly', () => {
  const N = 64, m = weatherMap(N, 5);
  for (const cover of [0.1, 0.3, 0.7]) {
    let n = 0; for (let i = 0; i < N * N; i++) if (m[i * 4] / 255 > 1 - cover) n++;
    assert.ok(Math.abs(n / (N * N) - cover) < 0.02, `cover ${cover}: ${n / (N * N)}`);
  }
  assert.ok(Math.abs(sampleMap(m, N, 0.0001, 0.4) - sampleMap(m, N, 0.9999, 0.4)) < 0.05);
  assert.ok(Math.abs(sampleMap(m, N, 0.3, 1.25) - sampleMap(m, N, 0.3, 0.25)) < 1e-9);
});

test('exposure: a fixed curve of sun elevation, calibrated so sunlit 18 % grey displays as mid grey', async () => {
  const { acesTone, acesInputFor, linearToSrgb, calibrateDayExposure, exposureCurve, NIGHT_RATIO } = await import('../public/js/skywx.js');
  const x = acesInputFor(0.45);
  assert.ok(Math.abs(linearToSrgb(acesTone([x, x, x])[1]) - 0.45) < 1e-4);
  const kDay = calibrateDayExposure(0.85, 0.148, 0.45);
  const grey = (0.18 / Math.PI) * (0.85 + 0.148) * kDay;
  assert.ok(Math.abs(linearToSrgb(acesTone([grey, grey, grey])[1]) - 0.45) < 1e-3, 'grey lands on 0.45');
  const white = grey / 0.18 * 0.85;
  assert.ok(linearToSrgb(acesTone([white, white, white])[1]) < 0.9, 'a sunlit white hull does not clip');
  const lzen = (e) => Math.max(1e-9, 0.012 * Math.max(0, Math.sin(e * Math.PI / 180)));
  const K = exposureCurve(kDay, lzen(60), lzen, () => 0);
  assert.equal(K(60), kDay); assert.equal(K(80), kDay);
  assert.ok(K(10) > kDay && K(2) > K(10) && K(-20) === kDay * NIGHT_RATIO, 'rises as the Sun sets, capped at night');
});
