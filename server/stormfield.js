// Storm cells overlaid on a base weather (real Open-Meteo or the synthetic fallback). Pure and deterministic: the same
// (base, storms, lat, lon, simTime) gives the same weather for every player.
//
// Per cell { lat, lon, radiusKm, intensity 0..1, driftDir, driftMs, born (sim s) [, devH] }:
//  - wind: a cyclonic vortex (anticlockwise in the north, 20° inflow) peaking at the radius of maximum wind
//    (0.35 R) with a lighter centre, plus the cell's own translation; Vmax = 36·intensity^0.6 m/s (1 → Bft 12,
//    0.69 → Bft 11, 0.3 → Bft 8). It fades smoothly to nothing at 1.35 R; the base wind is damped inside.
//  - gusts: 1.25–1.5 × the mean wind.
//  - waves: a wind sea grown from the local storm wind with fetch (2.2 R) and duration (age + devH, default 9 h of
//    pre-existing development) limits (JONSWAP fetch laws, capped at the Pierson-Moskowitz fully developed sea),
//    added by energy to the base sea; waves reach further than the wind (fade at 1.7 R).
//  - swell: long-period swell radiating out to 4 R, strongest ahead of the cell's track, coming FROM the centre,
//    the period lengthening with distance (dispersion: the long waves run ahead).
//  - rain in spiral bands, low cloud, a pressure drop (55 hPa × intensity at the centre), poor visibility.
import { haversine, bearing, normDeg } from '../shared/geo.js';

const G = 9.81, D2R = Math.PI / 180;
export const STORM_FIELD = { VMAX: 36, RMW: 0.35, WIND_EDGE: 1.35, WAVE_EDGE: 1.7, SWELL_EDGE: 4, FETCH_R: 2.2, DEV_H: 9, DP: 55, HS_CAP: 16 };

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const ss = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

/** Peak sustained wind (m/s) of a cell of this intensity. */
export function stormMaxWind(intensity) { return STORM_FIELD.VMAX * Math.pow(clamp(Number(intensity) || 0, 0, 1), 0.6); }
/** Radial wind profile 0..1 at x = distance / radius (lighter centre, max at RMW, zero from WIND_EDGE). C¹-smooth. */
export function windProfile(x) {
  const { RMW, WIND_EDGE } = STORM_FIELD;
  if (x < RMW) return 0.8 + 0.2 * ss(0, RMW, x);   // a mid-latitude low: lighter, not calm, at the centre
  return 1 - ss(RMW, WIND_EDGE, x);
}
/**
 * Significant wave height (m) and peak period (s) of a wind sea from wind U (m/s), fetch F (m) and duration t (s):
 * JONSWAP fetch-limited growth (gHs/U² = 1.6e-3 (gF/U²)^½, gTp/U = 0.286 (gF/U²)^⅓) with the duration limit
 * turned into an equivalent fetch, capped at the fully developed Pierson-Moskowitz sea (Hs = 0.0214 U², Tp = 0.81·2πU/g).
 */
export function windSea(U, F, t) {
  if (!(U > 0.5)) return { hs: 0, tp: 2 };
  const u2g = (U * U) / G;
  const Fdur = t > 0 ? u2g * Math.pow((G * t) / U / 68.8, 1.5) : F;
  const Fe = Math.max(1, Math.min(F, Fdur));
  const xd = Fe / u2g;
  const hsPM = Math.min(STORM_FIELD.HS_CAP, 0.0214 * U * U), tpPM = (0.81 * 2 * Math.PI * U) / G;
  return { hs: Math.min(hsPM, 1.6e-3 * Math.sqrt(xd) * u2g), tp: Math.max(2, Math.min(tpPM, (0.286 * Math.cbrt(xd) * U) / G)) };
}
/** The fully grown sea at a cell's centre (its swell source): Hs and Tp at Vmax. */
export function stormSea(st, simTime) {
  const U = stormMaxWind(st.intensity);
  const ageS = Math.max(0, (Number(simTime) || 0) - (Number(st.born) || 0)) + (Number.isFinite(st.devH) ? st.devH : STORM_FIELD.DEV_H) * 3600;
  return windSea(U, STORM_FIELD.FETCH_R * Math.max(20, st.radiusKm) * 1000, ageS);
}

function vecFrom(dirFrom, spd) { const r = (dirFrom + 180) * D2R; return [Math.sin(r) * spd, Math.cos(r) * spd]; }
function addSea(a, b) {   // energy sum of two sea components {height, dir (from), period}
  const ea = a.height * a.height, eb = b.height * b.height, e = ea + eb;
  if (!(e > 0)) return { height: 0, dir: a.dir, period: a.period };
  const ax = Math.sin(a.dir * D2R) * ea + Math.sin(b.dir * D2R) * eb, ay = Math.cos(a.dir * D2R) * ea + Math.cos(b.dir * D2R) * eb;
  return { height: Math.sqrt(e), dir: normDeg(Math.atan2(ax, ay) / D2R), period: (a.period * ea + b.period * eb) / e };
}

/**
 * Overlay storm cells on a base weather (game.weatherAt's shape). Returns the base itself when no cell reaches the
 * point, else a new object; `stormId` / `stormName` / `stormKind` name the dominant cell.
 */
export function overlayStorms(base, storms, lat, lon, simTime) {
  if (!base || !Array.isArray(storms) || !storms.length) return base;
  let out = null, best = 0;
  for (const st of storms) {
    if (!st || !Number.isFinite(st.lat) || !Number.isFinite(st.lon) || !(st.radiusKm > 0) || !(st.intensity > 0)) continue;
    const R = st.radiusKm, dKm = haversine(lat, lon, st.lat, st.lon) / 1000, x = dKm / R;
    if (x >= STORM_FIELD.SWELL_EDGE) continue;
    const w = out || (out = cloneWx(base));
    const I = clamp(st.intensity, 0, 1), vmax = stormMaxWind(I);
    const prof = windProfile(x), b = dKm > 0.01 ? bearing(st.lat, st.lon, lat, lon) : 0, nh = st.lat >= 0;
    // ---- wind: damp the base, add the vortex + translation
    if (prof > 0) {
      // the vortex takes over from the base wind toward the core; the speed is the energy sum of what is left of the base
      // and the vortex (opposed flows turn the wind, they do not leave a calm hole at the storm's edge)
      const damp = 1 - ss(STORM_FIELD.WIND_EDGE, 0.6, x);
      const toward = normDeg(nh ? b - 110 : b + 110);        // the direction the air moves (anticlockwise NH, inflow 20°)
      const tr = Math.min(12, Number(st.driftMs) || 0) * 0.5 * prof;
      const vs = vmax * prof;
      let u = w.wind.u * damp + Math.sin(toward * D2R) * vs, v = w.wind.v * damp + Math.cos(toward * D2R) * vs;
      if (tr > 0) { u += Math.sin((st.driftDir || 0) * D2R) * tr; v += Math.cos((st.driftDir || 0) * D2R) * tr; }
      const n = Math.hypot(u, v), target = Math.hypot((w.wind.spd || 0) * damp, vs) + tr * Math.max(0, Math.cos(((st.driftDir || 0) - toward) * D2R));
      if (n > 0.01) { u *= target / n; v *= target / n; }
      const spd = Math.hypot(u, v), dir = normDeg(Math.atan2(-u, -v) / D2R);
      // deterministic gust factor: rises toward the eyewall, flickers slowly with position and time
      const gf = 1.25 + 0.2 * prof + 0.05 * Math.sin(lat * 7.3 + lon * 5.1 + (Number(simTime) || 0) / 37);
      w.wind = { u, v, spd, dir, gust: Math.max(spd, (w.wind.gust || 0) * damp, spd * gf) };
    }
    // ---- waves: the local storm wind sea (broader than the wind field) added to the base sea
    const src = stormSea(st, simTime);
    const pw = 1 - ss(STORM_FIELD.RMW, STORM_FIELD.WAVE_EDGE, x);
    if (pw > 0) {
      const Uw = vmax * Math.max(prof, pw * (x < STORM_FIELD.RMW ? 1 : 0.9));
      const sea = windSea(Uw, STORM_FIELD.FETCH_R * R * 1000, Math.max(0, (Number(simTime) || 0) - (Number(st.born) || 0)) + (Number.isFinite(st.devH) ? st.devH : STORM_FIELD.DEV_H) * 3600);
      const hs = Math.min(src.hs, sea.hs) * Math.min(1, pw * 1.15);
      w.waves = addSea(w.waves, { height: hs, dir: w.wind.dir, period: sea.tp });
    }
    // ---- swell radiating out, strongest ahead of the track
    const sw = ss(0.6, 1.3, x) * (1 - ss(1.3, STORM_FIELD.SWELL_EDGE, x));
    if (sw > 0 && src.hs > 0.3) {
      const ahead = Math.cos((b - (st.driftDir || 0)) * D2R);
      const h = 0.42 * src.hs * sw * (0.35 + 0.65 * Math.max(0, ahead));
      const per = clamp(src.tp + 1.6 * Math.max(0, x - 1), 7, 19);
      if (h > 0.01) w.swell = addSea(w.swell, { height: h, dir: normDeg(b), period: per });   // FROM the centre's side
    }
    // ---- rain bands, cloud, pressure, visibility, temperature
    const core = ss(1.3, 0.3, x);
    const band = 0.5 + 0.5 * Math.sin(3 * b * D2R - dKm / 40 + (Number(simTime) || 0) / 900);
    const rain = core * (0.65 + 0.35 * band) * Math.min(1, I * 1.8);
    w.rain = Math.max(w.rain, rain);
    w.cloud = Math.max(w.cloud, ss(1.7, 0.4, x) * (0.7 + 0.3 * I));
    w.pressure = Math.round((w.pressure - STORM_FIELD.DP * I * Math.exp(-1.6 * x * x) * (1 - ss(3, 4, x))) * 10) / 10;
    // rain and, in a gale, blown spray and spindrift close the horizon in (≈ 1 km at Bft 10)
    let vis = w.visibility * (1 - 0.9 * rain) * (1 - 0.5 * prof * I);
    const spray = 20000 * Math.exp(-Math.max(0, w.wind.spd - 10) / 5);
    vis = Math.min(vis, vis + (spray - vis) * prof);
    w.visibility = Math.round(Math.max(250, vis));
    w.temp = Math.round((w.temp - 2.5 * core * I) * 10) / 10;
    const k = I * (1 - ss(0.5, STORM_FIELD.WIND_EDGE, x));   // storm index: the whole core is 'in the storm'
    if (k > best) { best = k; w.stormId = st.id; w.stormName = st.name; w.stormKind = st.kind || 'game'; }
  }
  if (!out) return base;
  // derived indices follow the new wind and sea
  out.storm = Math.max(out.storm || 0, clamp((out.wind.spd - 14) / 14, 0, 1), best);
  out.sea = Math.max(base.sea || 0, Math.min(1, out.waves.height / 6));
  return out;
}
function cloneWx(b) {
  return { ...b, wind: { ...b.wind }, waves: { ...b.waves }, swell: { ...b.swell } };
}
