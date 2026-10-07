// STUB — replaced by agent S2 (docs/V3-CONTRACTS.md §2). Browser-safe, pure.
const M2 = 12.4206 * 3600;
export function tideAt(lat, lon, tSec) {
  const ph = ((tSec / M2) % 1 + 1) % 1;
  const height = Math.sin(ph * Math.PI * 2) * 1.0;
  const rate = Math.cos(ph * Math.PI * 2) * (Math.PI * 2 / (M2 / 3600));
  return { height, rate, stream: { u: 0.2 * Math.cos(ph * Math.PI * 2), v: 0 }, range: 2, phase: ph, state: rate >= 0 ? 'flood' : 'ebb', nextHigh: tSec + ((0.25 - ph + 1) % 1) * M2, nextLow: tSec + ((0.75 - ph + 1) % 1) * M2 };
}
