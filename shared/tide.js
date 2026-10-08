// Harmonic tide model (docs/V3-CONTRACTS.md §2). Browser-safe, pure, deterministic.
// Five constituents (M2, S2, N2, K1, O1) with a regional amplitude table, a phase lag that progresses along the
// coast (high water travels as a Kelvin wave), a spring-neap cycle from the M2/S2 beat, and a tidal stream along
// the local coast orientation whose sign follows the rate of rise (flood / ebb).

const H = 3600;
const C = [
  { id: 'M2', T: 12.4206012 * H, k: 1 },
  { id: 'S2', T: 12.0 * H, k: 0.33 },
  { id: 'N2', T: 12.65834751 * H, k: 0.19 },
  { id: 'K1', T: 23.93447213 * H, k: 0.08 },
  { id: 'O1', T: 25.81933871 * H, k: 0.06 },
];
for (const c of C) c.w = (2 * Math.PI) / c.T;
const D2R = Math.PI / 180;

// Regions: first match wins. m2 = M2 amplitude (m), lag0 = phase at the reference point (h), lagPerKm (h per km
// along `axis` degrees from the reference), stream = peak surface stream (m/s), coast = direction the flood stream
// sets toward (deg), diurnal = K1 multiplier override (Pacific/Gulf of Mexico have strong diurnal tides).
const REGIONS = [
  { name: 'Baltic', box: [53.5, 66, 12.5, 30.5], m2: 0.05, lag0: 0, ref: [55, 13], axis: 0, lagPerKm: 0, stream: 0.05, coast: 90 },
  { name: 'Kattegat', box: [55.3, 58.2, 9.8, 12.9], m2: 0.15, lag0: 4.5, ref: [57.7, 11], axis: 180, lagPerKm: 0.004, stream: 0.15, coast: 180 },
  { name: 'Skagerrak', box: [57.3, 59.5, 7, 11.5], m2: 0.2, lag0: 4, ref: [58, 8], axis: 90, lagPerKm: 0.003, stream: 0.15, coast: 90 },
  { name: 'Oslofjord', box: [58.9, 60.0, 9.8, 11.3], m2: 0.15, lag0: 5, ref: [59.5, 10.6], axis: 0, lagPerKm: 0.002, stream: 0.1, coast: 0 },
  { name: 'Norwegian coast', box: [58, 71.5, 4, 31], m2: 0.6, lag0: 0.5, ref: [59, 5], axis: 0, lagPerKm: 0.002, stream: 0.3, coast: 20 },
  { name: 'Bristol Channel', box: [50.9, 51.8, -6, -2.5], m2: 3.5, lag0: 5.5, ref: [51.3, -4], axis: 90, lagPerKm: 0.004, stream: 1.6, coast: 80 },
  { name: 'Channel Islands', box: [48.5, 49.9, -3.3, -1.2], m2: 3.4, lag0: 6.2, ref: [49.4, -2.4], axis: 0, lagPerKm: 0.003, stream: 1.8, coast: 45 },
  { name: 'Dover Strait', box: [50.6, 51.4, 0.8, 2.3], m2: 2.3, lag0: 11.1, ref: [51.0, 1.4], axis: 45, lagPerKm: 0.006, stream: 1.2, coast: 45 },
  { name: 'English Channel', box: [48.3, 51.0, -6, 1.6], m2: 2.2, lag0: 7.5, ref: [50.1, -3], axis: 75, lagPerKm: 0.005, stream: 0.9, coast: 75 },
  { name: 'Thames', box: [51.2, 51.9, 0.3, 1.8], m2: 2.0, lag0: 0.8, ref: [51.5, 1.2], axis: 270, lagPerKm: 0.008, stream: 0.9, coast: 270 },
  { name: 'Humber / Wash', box: [52.6, 53.9, -0.8, 0.9], m2: 2.3, lag0: 5.3, ref: [53.5, 0.3], axis: 180, lagPerKm: 0.006, stream: 1.0, coast: 300 },
  { name: 'Southern North Sea', box: [51.2, 53.5, 2.0, 5.3], m2: 0.8, lag0: 1.5, ref: [51.4, 3.2], axis: 30, lagPerKm: 0.011, stream: 0.6, coast: 30 },
  { name: 'German Bight', box: [53.2, 55.6, 5.3, 9.5], m2: 1.4, lag0: 5.8, ref: [53.6, 6.5], axis: 70, lagPerKm: 0.006, stream: 0.7, coast: 70 },
  { name: 'Scottish east coast', box: [55.6, 58.8, -4.5, -1.3], m2: 1.5, lag0: 2.6, ref: [57.5, -1.8], axis: 180, lagPerKm: 0.004, stream: 0.5, coast: 180 },
  { name: 'Pentland / Orkney', box: [58.5, 59.5, -4, -2.2], m2: 1.3, lag0: 10.5, ref: [58.7, -3], axis: 90, lagPerKm: 0.003, stream: 2.5, coast: 90 },
  { name: 'NE England', box: [53.9, 55.7, -2, 0.5], m2: 1.6, lag0: 3.8, ref: [55, -1.4], axis: 180, lagPerKm: 0.004, stream: 0.5, coast: 170 },
  { name: 'Central North Sea', box: [53.5, 58, -1.3, 8], m2: 0.6, lag0: 6, ref: [56, 3], axis: 120, lagPerKm: 0.004, stream: 0.25, coast: 160 },
  { name: 'Northern North Sea', box: [58, 61.5, -2, 5], m2: 0.5, lag0: 0.3, ref: [60, 1], axis: 180, lagPerKm: 0.003, stream: 0.25, coast: 180 },
  { name: 'Irish Sea', box: [51.8, 55.5, -7, -2.6], m2: 2.5, lag0: 11, ref: [53.5, -4.5], axis: 0, lagPerKm: 0.002, stream: 0.9, coast: 0 },
  { name: 'Biscay / Atlantic Europe', box: [36, 51, -12, -1], m2: 1.5, lag0: 3.5, ref: [46, -4], axis: 0, lagPerKm: 0.0015, stream: 0.3, coast: 0 },
  { name: 'Mediterranean', box: [30, 46, -5.5, 36.5], m2: 0.1, lag0: 0, ref: [38, 15], axis: 90, lagPerKm: 0.0005, stream: 0.05, coast: 90 },
  { name: 'Gulf of Mexico', box: [18, 31, -98, -81], m2: 0.15, lag0: 0, ref: [28, -90], axis: 90, lagPerKm: 0.0005, stream: 0.1, coast: 90, diurnal: 0.25 },
  { name: 'Pacific', box: [-60, 60, 120, 180], m2: 0.6, lag0: 2, ref: [0, 160], axis: 0, lagPerKm: 0.0003, stream: 0.15, coast: 0, diurnal: 0.4 },
  { name: 'Pacific East', box: [-60, 60, -180, -78], m2: 0.7, lag0: 3, ref: [0, -120], axis: 0, lagPerKm: 0.0003, stream: 0.15, coast: 0, diurnal: 0.35 },
];
const DEFAULT = { name: 'Open ocean', m2: 0.8, lag0: 0, ref: [0, 0], axis: 0, lagPerKm: 0.0003, stream: 0.2, coast: 0 };

function regionOf(lat, lon) {
  for (const r of REGIONS) { const [a, b, c, d] = r.box; if (lat >= a && lat < b && lon >= c && lon < d) return r; }
  return DEFAULT;
}

/** Phase lag (hours) of local high water relative to the region reference, progressing along the region's axis. */
function lagHours(r, lat, lon) {
  const dn = (lat - r.ref[0]) * 111.2, de = (lon - r.ref[1]) * 111.2 * Math.cos(lat * D2R);
  const along = dn * Math.cos(r.axis * D2R) + de * Math.sin(r.axis * D2R);
  return r.lag0 + along * r.lagPerKm;
}

function heightAt(r, lagS, t) {
  let h = 0;
  for (const c of C) {
    const amp = r.m2 * (c.id === 'K1' && r.diurnal ? r.diurnal / 0.08 * c.k : c.k);
    const lag = c.id === 'K1' || c.id === 'O1' ? lagS * 0.5 : lagS; // diurnal waves travel at a different phase speed
    h += amp * Math.cos(c.w * (t - lag));
  }
  return h;
}

export function tideAt(lat, lon, tSec) {
  lat = Number(lat) || 0; lon = Number(lon) || 0; tSec = Number(tSec) || 0;
  const r = regionOf(lat, lon);
  const lagS = lagHours(r, lat, lon) * H;
  const h = heightAt(r, lagS, tSec);
  const dt = 300;
  const rate = ((heightAt(r, lagS, tSec + dt) - heightAt(r, lagS, tSec - dt)) / (2 * dt)) * H; // m/h
  // spring-neap: M2 and S2 in phase → springs
  const beat = Math.cos((C[0].w - C[1].w) * (tSec - lagS));
  const range = 2 * r.m2 * (1 + 0.33 * beat);
  const phase = ((((tSec - lagS) / C[0].T) % 1) + 1) % 1;
  // stream: peaks mid-flood / mid-ebb, proportional to the normalised rate of rise
  const maxRate = (2 * Math.PI / C[0].T) * H * r.m2 * 1.33 || 1;
  const sNorm = Math.max(-1, Math.min(1, rate / maxRate));
  const sp = r.stream * sNorm * (0.75 + 0.25 * beat);
  const stream = { u: sp * Math.sin(r.coast * D2R), v: sp * Math.cos(r.coast * D2R) };
  // next high / low water: step forward in 10-minute increments looking for the rate sign change, then refine
  const findTurn = (wantHigh) => {
    let prev = rate, t = tSec;
    for (let i = 1; i <= 160; i++) {
      t = tSec + i * 600;
      const rr = heightAt(r, lagS, t + 60) - heightAt(r, lagS, t - 60);
      if (wantHigh ? prev > 0 && rr <= 0 : prev < 0 && rr >= 0) {
        let a = t - 600, b = t; // bisection on the derivative sign
        for (let k = 0; k < 12; k++) { const m = (a + b) / 2; const dm = heightAt(r, lagS, m + 30) - heightAt(r, lagS, m - 30); if ((dm > 0) === wantHigh) a = m; else b = m; }
        return Math.round((a + b) / 2);
      }
      prev = rr;
    }
    return Math.round(tSec + (wantHigh ? 0.5 : 1) * C[0].T);
  };
  return {
    height: Math.round(h * 100) / 100, rate: Math.round(rate * 100) / 100, stream: { u: Math.round(stream.u * 100) / 100, v: Math.round(stream.v * 100) / 100 },
    range: Math.round(range * 100) / 100, phase: Math.round(phase * 1000) / 1000, state: rate >= 0 ? 'flood' : 'ebb',
    nextHigh: findTurn(true), nextLow: findTurn(false), region: r.name,
  };
}

/** Mean low water springs below mean sea level (m, ≤ 0) of the tide model's region: −1.33 × M2 amplitude (M2 + S2).
 *  The route planner (server/searoute.js v2) plans keel clearance against this. docs/V6-QUICK-CONTRACTS.md §4.3. */
export function lowWaterAt(lat, lon) { return -1.33 * regionOf(Number(lat) || 0, Number(lon) || 0).m2; }
