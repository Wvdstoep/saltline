// Sea state and wind force scales shared by server and client.
// Douglas / WMO sea-state code 0..9 from the significant wave height Hs (m) and the Beaufort force 0..12 from the
// 10 m mean wind (m/s). The HUD's SEA field, the chart's storm labels and the debug sea forcing all read these.

/** WMO code 3700 / Douglas sea scale: upper Hs bound (m) of each code (code 9 is open-ended). */
export const DOUGLAS = [
  { code: 0, max: 0.05, word: 'calm-glassy' },  // 0 m
  { code: 1, max: 0.1, word: 'calm-rippled' },  // 0–0.1 m
  { code: 2, max: 0.5, word: 'smooth' },        // 0.1–0.5 m
  { code: 3, max: 1.25, word: 'slight' },
  { code: 4, max: 2.5, word: 'moderate' },
  { code: 5, max: 4, word: 'rough' },
  { code: 6, max: 6, word: 'very rough' },
  { code: 7, max: 9, word: 'high' },
  { code: 8, max: 14, word: 'very high' },
  { code: 9, max: Infinity, word: 'phenomenal' },
];
/** Douglas sea state { code, word } for a significant wave height (m). Non-finite or negative heights read as glassy calm. */
export function douglas(hs) {
  const h = Number.isFinite(hs) ? Math.max(0, hs) : 0;
  for (const d of DOUGLAS) if (h < d.max) return d;
  return DOUGLAS[9];
}
export function seaStateWord(hs) { return douglas(hs).word; }

/** Beaufort lower bounds (m/s) of forces 1..12. */
export const BFT_MS = [0.3, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];
export const BFT_WORD = ['calm', 'light air', 'light breeze', 'gentle breeze', 'moderate breeze', 'fresh breeze', 'strong breeze', 'near gale', 'gale', 'strong gale', 'storm', 'violent storm', 'hurricane force'];
/** Beaufort force 0..12 of a mean wind speed (m/s). */
export function beaufort(ms) { let b = 0; const v = Number.isFinite(ms) ? ms : 0; while (b < BFT_MS.length && v >= BFT_MS[b]) b++; return b; }
export function beaufortWord(ms) { return BFT_WORD[beaufort(ms)]; }

/**
 * A representative open-sea state for a Beaufort force (debug forcing / screenshots): the mid-band mean wind, the
 * WMO "probable" wave height of the Beaufort table for a fully developed sea, its peak period, gusts, rain, cloud,
 * visibility and the 0..1 storm index the rest of the game reads.
 */
export function seaForBeaufort(force) {
  const f = Math.max(0, Math.min(12, Math.round(Number(force) || 0)));
  const lo = f === 0 ? 0 : BFT_MS[f - 1], hi = f >= 12 ? 38 : BFT_MS[f];
  const spd = f === 0 ? 0.2 : (lo + hi) / 2;
  const HS = [0, 0.1, 0.2, 0.6, 1, 2, 3, 4, 5.5, 7, 9, 11.5, 14];       // WMO Beaufort table, probable height (m)
  const waveH = HS[f];
  const wavePeriod = f === 0 ? 2 : Math.max(2.5, Math.min(17, 3.2 * Math.sqrt(waveH) + 1.6));
  const storm = Math.max(0, Math.min(1, (spd - 14) / 14));
  const rain = f >= 10 ? 0.9 : f >= 8 ? 0.6 : f >= 7 ? 0.3 : 0;
  return {
    windSpd: +spd.toFixed(1), gust: +(spd * (1.25 + 0.02 * f)).toFixed(1), sea: Math.min(1, waveH / 6), storm, rain,
    waveH, wavePeriod: +wavePeriod.toFixed(1), swellH: +(Math.min(5, 0.25 + waveH * 0.3)).toFixed(2), swellPeriod: +(Math.min(18, wavePeriod + 3)).toFixed(1),
    visibility: f >= 11 ? 700 : f >= 10 ? 1500 : f >= 8 ? 4000 : f >= 6 ? 12000 : 22000,
    cloud: Math.min(1, 0.15 + f * 0.075), pressure: Math.round(1018 - Math.max(0, f - 4) * 6.5), bft: f,
  };
}
