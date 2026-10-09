// Work sites (docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §5.6): offshore wind farms, eco-tour / whale-watching areas and
// seasonal ice zones. Positions ≤ 0.01° from public registers (Source [S18], [S12]); every row `verify: true`.
// Plain ESM, browser-safe, pure.

/** Offshore wind farms (approximate array centres, ≤ 0.01°; turbines = count for CTV transfers). */
export const WINDFARMS = [
  { id: 'hornsea1', name: 'Hornsea One', lat: 53.885, lon: 1.791, turbines: 174 },
  { id: 'hornsea2', name: 'Hornsea Two', lat: 53.94, lon: 1.69, turbines: 165 },
  { id: 'dogger_a', name: 'Dogger Bank A', lat: 54.77, lon: 1.92, turbines: 95 },
  { id: 'race_bank', name: 'Race Bank', lat: 53.27, lon: 0.84, turbines: 91 },
  { id: 'triton_knoll', name: 'Triton Knoll', lat: 53.47, lon: 0.86, turbines: 90 },
  { id: 'east_anglia1', name: 'East Anglia One', lat: 52.23, lon: 2.49, turbines: 102 },
  { id: 'greater_gabbard', name: 'Greater Gabbard', lat: 51.88, lon: 1.94, turbines: 140 },
  { id: 'london_array', name: 'London Array', lat: 51.63, lon: 1.5, turbines: 175 },
  { id: 'thanet', name: 'Thanet', lat: 51.43, lon: 1.63, turbines: 100 },
  { id: 'borssele', name: 'Borssele', lat: 51.7, lon: 3.05, turbines: 171 },
  { id: 'belwind', name: 'Belwind', lat: 51.67, lon: 2.8, turbines: 56 },
  { id: 'northwind', name: 'Northwind', lat: 51.62, lon: 2.9, turbines: 72 },
  { id: 'gemini', name: 'Gemini', lat: 54.04, lon: 5.96, turbines: 150 },
  { id: 'riffgat', name: 'Riffgat', lat: 53.69, lon: 6.48, turbines: 30 },
  { id: 'gode_wind', name: 'Gode Wind', lat: 54.04, lon: 7.0, turbines: 97 },
  { id: 'bard1', name: 'BARD Offshore 1', lat: 54.36, lon: 5.98, turbines: 80 },
  { id: 'horns_rev1', name: 'Horns Rev 1', lat: 55.48, lon: 7.84, turbines: 80 },
  { id: 'horns_rev3', name: 'Horns Rev 3', lat: 55.7, lon: 7.68, turbines: 49 },
  { id: 'westermost_rough', name: 'Westermost Rough', lat: 53.8, lon: 0.15, turbines: 35 },
].map((w) => ({ ...w, kind: 'windfarm', rM: 6000, src: 'national offshore-wind register (verify)', verify: true }));

/** Eco-tour / whale-watching areas: harbour, centre, radius, months with sightings (1–12) and sighting chance. */
export const ECO_SITES = [
  { id: 'faxafloi', name: 'Faxaflói (Reykjavík bay)', harbor: 'reykjavik', lat: 64.2, lon: -22.15, months: [4, 5, 6, 7, 8, 9, 10], p: 0.85 },
  { id: 'tromso_fjords', name: 'Tromsø fjords (orcas)', harbor: 'tromso', lat: 69.75, lon: 19.1, months: [11, 12, 1], p: 0.7 },
  { id: 'azores', name: 'Azores (São Miguel)', harbor: 'ponta_delgada', lat: 37.68, lon: -25.62, months: [4, 5, 6, 7, 8, 9, 10], p: 0.9 },
  { id: 'tenerife_sw', name: 'Tenerife south-west coast', harbor: 'santa_cruz_tenerife', lat: 28.1, lon: -16.8, months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], p: 0.9 },
  { id: 'false_bay', name: 'False Bay', harbor: 'cape_town', lat: -34.2, lon: 18.6, months: [6, 7, 8, 9, 10, 11], p: 0.75 },
  { id: 'salish_sea', name: 'Salish Sea', harbor: ['vancouver', 'seattle'], lat: 48.5, lon: -123.2, months: [5, 6, 7, 8, 9, 10], p: 0.7 },
  { id: 'hervey_bay', name: 'Hervey Bay', harbor: 'brisbane', lat: -25.0, lon: 152.9, months: [7, 8, 9, 10, 11], p: 0.9 },
  { id: 'monterey_bay', name: 'Monterey Bay', harbor: 'oakland', lat: 36.8, lon: -122.0, months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], p: 0.75 },
].map((s) => ({ ...s, kind: 'eco', rM: 8000, src: 'NOAA / IWC whale-watching guidance [S16] (verify)', verify: true }));

/**
 * Seasonal ice zones (polygons [lon, lat], ≤ 40 vertices): ports inside need the ice class `need` in the months listed
 * (Game rule, inspired by the Finnish/Swedish winter traffic restrictions [S12]).
 */
export const ICE_ZONES = [
  { id: 'bothnia', name: 'Gulf of Bothnia', need: 'i1a', months: [12, 1, 2, 3, 4],
    ring: [[17.0, 60.3], [21.5, 60.3], [22.0, 62.5], [25.8, 64.6], [25.8, 65.9], [21.5, 65.9], [17.0, 62.5], [17.0, 60.3]] },
  { id: 'finland', name: 'Gulf of Finland', need: 'i1c', months: [1, 2, 3],
    ring: [[21.0, 59.2], [30.6, 59.2], [30.6, 60.8], [21.0, 60.8], [21.0, 59.2]] },
  { id: 'st_lawrence', name: 'Gulf of St Lawrence', need: 'i1c', months: [1, 2, 3],
    ring: [[-71.5, 46.5], [-58.0, 46.5], [-58.0, 50.6], [-71.5, 50.6], [-71.5, 46.5]] },
].map((z) => ({ ...z, src: 'Traficom / Swedish Maritime Administration winter navigation (verify)', verify: true }));

export function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** Month 1–12 (UTC) of a unix time. */
export function monthOf(simTime) { return new Date(simTime * 1000).getUTCMonth() + 1; }
/** The ice zone a position lies in (any season), or null. */
export function iceZoneAt(lat, lon) { return ICE_ZONES.find((z) => pointInRing(lon, lat, z.ring)) || null; }
/** Ice class token a harbour needs at `simTime` (null out of season / outside the zones). */
export function iceNeedAt(h, simTime) {
  if (!h) return null;
  const z = iceZoneAt(h.lat, h.lon);
  return z && z.months.includes(monthOf(simTime)) ? z.need : null;
}
/** Eco sites served from harbour `id`. */
export function ecoSitesFor(id) { return ECO_SITES.filter((s) => (Array.isArray(s.harbor) ? s.harbor.includes(id) : s.harbor === id)); }
/** Wind farms within `maxKm` of a harbour, nearest first ({ site, km }). */
export function windfarmsNear(h, maxKm = 200) {
  const R = 6371;
  const km = (a, b) => { const dLat = ((b.lat - a.lat) * Math.PI) / 180, dLon = ((b.lon - a.lon) * Math.PI) / 180; const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); };
  return WINDFARMS.map((site) => ({ site, km: km(h, site) })).filter((x) => x.km <= maxKm).sort((a, b) => a.km - b.km);
}
