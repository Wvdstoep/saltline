// Real-world harbours (lat/lon at the harbour entrance / roadstead), navigable channel carvings and
// fishing grounds. Coordinates are WGS84. Sizes drive job volume, prices and port-authority presence.
import { WORLD_HARBORS, WORLD_FISHING_GROUNDS, WORLD_PLATFORMS } from './harbors-world.js';
import { portCarvings } from './bigports.js';

export const HARBORS = [
  // ---- Detail region: North Sea, Channel, Skagerrak/Kattegat ----
  { id: 'rotterdam', name: 'Rotterdam (Maasvlakte)', country: 'NL', lat: 51.98, lon: 4.03, size: 'mega', fuelMul: 0.92 },
  { id: 'ijmuiden', name: 'IJmuiden / Amsterdam', country: 'NL', lat: 52.465, lon: 4.555, size: 'major', fuelMul: 0.95 },
  { id: 'vlissingen', name: 'Vlissingen', country: 'NL', lat: 51.44, lon: 3.58, size: 'regional', fuelMul: 0.97 },
  { id: 'antwerp', name: 'Antwerp (Deurganckdok)', country: 'BE', lat: 51.296, lon: 4.265, size: 'mega', fuelMul: 0.93, note: 'via Westerschelde channel' },
  { id: 'zeebrugge', name: 'Zeebrugge', country: 'BE', lat: 51.37, lon: 3.18, size: 'major', fuelMul: 0.96 },
  { id: 'ostend', name: 'Ostend', country: 'BE', lat: 51.24, lon: 2.92, size: 'minor', fuelMul: 1.0 },
  { id: 'dunkirk', name: 'Dunkirk', country: 'FR', lat: 51.05, lon: 2.18, size: 'major', fuelMul: 0.98 },
  { id: 'calais', name: 'Calais', country: 'FR', lat: 50.97, lon: 1.85, size: 'regional', fuelMul: 1.02 },
  { id: 'dover', name: 'Dover', country: 'GB', lat: 51.12, lon: 1.33, size: 'regional', fuelMul: 1.05 },
  { id: 'felixstowe', name: 'Felixstowe / Harwich', country: 'GB', lat: 51.94, lon: 1.33, size: 'mega', fuelMul: 1.0 },
  { id: 'tilbury', name: 'London (Tilbury)', country: 'GB', lat: 51.45, lon: 0.36, size: 'major', fuelMul: 1.06, note: 'via Thames channel' },
  { id: 'hull', name: 'Hull', country: 'GB', lat: 53.73, lon: -0.28, size: 'major', fuelMul: 1.0, note: 'via Humber channel' },
  { id: 'immingham', name: 'Immingham / Grimsby', country: 'GB', lat: 53.63, lon: -0.17, size: 'major', fuelMul: 0.98 },
  { id: 'newcastle', name: 'Newcastle (Tyne)', country: 'GB', lat: 55.01, lon: -1.40, size: 'regional', fuelMul: 1.0 },
  { id: 'leith', name: 'Edinburgh (Leith)', country: 'GB', lat: 55.99, lon: -3.17, size: 'regional', fuelMul: 1.03 },
  { id: 'aberdeen', name: 'Aberdeen', country: 'GB', lat: 57.14, lon: -2.05, size: 'regional', fuelMul: 1.0 },
  { id: 'peterhead', name: 'Peterhead', country: 'GB', lat: 57.49, lon: -1.78, size: 'minor', fuelMul: 1.02 },
  { id: 'inverness', name: 'Inverness', country: 'GB', lat: 57.49, lon: -4.23, size: 'minor', fuelMul: 1.08, note: 'via Moray Firth channel' },
  { id: 'kirkwall', name: 'Kirkwall (Orkney)', country: 'GB', lat: 59, lon: -2.96, size: 'minor', fuelMul: 1.1 },
  { id: 'lerwick', name: 'Lerwick (Shetland)', country: 'GB', lat: 60.15, lon: -1.13, size: 'minor', fuelMul: 1.12 },
  { id: 'lowestoft', name: 'Lowestoft', country: 'GB', lat: 52.47, lon: 1.77, size: 'minor', fuelMul: 1.03 },
  { id: 'southampton', name: 'Southampton', country: 'GB', lat: 50.88, lon: -1.39, size: 'major', fuelMul: 1.02, note: 'via Solent channel' },
  { id: 'portsmouth', name: 'Portsmouth', country: 'GB', lat: 50.79, lon: -1.11, size: 'regional', fuelMul: 1.04 },
  { id: 'plymouth', name: 'Plymouth', country: 'GB', lat: 50.34, lon: -4.14, size: 'regional', fuelMul: 1.03 },
  { id: 'brest', name: 'Brest', country: 'FR', lat: 48.37, lon: -4.47, size: 'regional', fuelMul: 1.0 },
  { id: 'cherbourg', name: 'Cherbourg', country: 'FR', lat: 49.66, lon: -1.62, size: 'regional', fuelMul: 1.01 },
  { id: 'le_havre', name: 'Le Havre', country: 'FR', lat: 49.47, lon: 0.08, size: 'mega', fuelMul: 0.96 },
  { id: 'dublin', name: 'Dublin', country: 'IE', lat: 53.34, lon: -6.17, size: 'major', fuelMul: 1.04 },
  { id: 'den_helder', name: 'Den Helder', country: 'NL', lat: 52.96, lon: 4.77, size: 'minor', fuelMul: 1.0 },
  { id: 'harlingen', name: 'Harlingen', country: 'NL', lat: 53.18, lon: 5.40, size: 'minor', fuelMul: 1.0 },
  { id: 'eemshaven', name: 'Eemshaven', country: 'NL', lat: 53.46, lon: 6.84, size: 'regional', fuelMul: 0.97 },
  { id: 'emden', name: 'Emden', country: 'DE', lat: 53.33, lon: 7.18, size: 'regional', fuelMul: 0.98 },
  { id: 'wilhelmshaven', name: 'Wilhelmshaven', country: 'DE', lat: 53.59, lon: 8.15, size: 'major', fuelMul: 0.95 },
  { id: 'bremerhaven', name: 'Bremerhaven', country: 'DE', lat: 53.58, lon: 8.52, size: 'mega', fuelMul: 0.95 },
  { id: 'cuxhaven', name: 'Cuxhaven', country: 'DE', lat: 53.88, lon: 8.71, size: 'minor', fuelMul: 1.0 },
  { id: 'hamburg', name: 'Hamburg', country: 'DE', lat: 53.54, lon: 9.93, size: 'mega', fuelMul: 0.94, note: 'via Elbe channel' },
  { id: 'kiel', name: 'Kiel', country: 'DE', lat: 54.36, lon: 10.16, size: 'regional', fuelMul: 1.0 },
  { id: 'esbjerg', name: 'Esbjerg', country: 'DK', lat: 55.47, lon: 8.42, size: 'regional', fuelMul: 1.02 },
  { id: 'hirtshals', name: 'Hirtshals', country: 'DK', lat: 57.60, lon: 9.96, size: 'minor', fuelMul: 1.04 },
  { id: 'frederikshavn', name: 'Frederikshavn', country: 'DK', lat: 57.44, lon: 10.55, size: 'minor', fuelMul: 1.04 },
  { id: 'copenhagen', name: 'Copenhagen', country: 'DK', lat: 55.70, lon: 12.64, size: 'major', fuelMul: 1.03 },
  { id: 'gothenburg', name: 'Gothenburg', country: 'SE', lat: 57.68, lon: 11.82, size: 'major', fuelMul: 1.02 },
  { id: 'oslo', name: 'Oslo', country: 'NO', lat: 59.89, lon: 10.73, size: 'major', fuelMul: 1.08, note: 'via Oslofjord' },
  { id: 'kristiansand', name: 'Kristiansand', country: 'NO', lat: 58.13, lon: 8.00, size: 'minor', fuelMul: 1.07 },
  { id: 'stavanger', name: 'Stavanger', country: 'NO', lat: 58.98, lon: 5.73, size: 'regional', fuelMul: 1.06 },
  { id: 'bergen', name: 'Bergen', country: 'NO', lat: 60.4, lon: 5.3, size: 'regional', fuelMul: 1.08, note: 'via Byfjorden' },
  // ---- Global ports (coarse layer) ----
  { id: 'reykjavik', name: 'Reykjavík', country: 'IS', lat: 64.16, lon: -21.94, size: 'regional', fuelMul: 1.15 },
  { id: 'lisbon', name: 'Lisbon', country: 'PT', lat: 38.69, lon: -9.19, size: 'major', fuelMul: 1.0 },
  { id: 'gibraltar', name: 'Gibraltar', country: 'GI', lat: 36.14, lon: -5.37, size: 'regional', fuelMul: 0.9 },
  { id: 'marseille', name: 'Marseille (Fos)', country: 'FR', lat: 43.33, lon: 5.0, size: 'major', fuelMul: 1.0 },
  { id: 'genoa', name: 'Genoa', country: 'IT', lat: 44.4, lon: 8.91, size: 'major', fuelMul: 1.02 },
  { id: 'piraeus', name: 'Piraeus', country: 'GR', lat: 37.93, lon: 23.62, size: 'major', fuelMul: 1.0 },
  { id: 'istanbul', name: 'Istanbul (Ambarlı)', country: 'TR', lat: 40.96, lon: 28.68, size: 'major', fuelMul: 0.98 },
  { id: 'alexandria', name: 'Alexandria', country: 'EG', lat: 31.18, lon: 29.86, size: 'major', fuelMul: 0.95 },
  { id: 'dubai_jebel_ali', name: 'Jebel Ali (Dubai)', country: 'AE', lat: 25.03, lon: 55.04, size: 'mega', fuelMul: 0.8 },
  { id: 'mumbai', name: 'Mumbai (JNPT)', country: 'IN', lat: 18.93, lon: 72.87, size: 'mega', fuelMul: 0.92 },
  { id: 'colombo', name: 'Colombo', country: 'LK', lat: 6.95, lon: 79.84, size: 'major', fuelMul: 0.95 },
  { id: 'singapore', name: 'Singapore', country: 'SG', lat: 1.24, lon: 103.78, size: 'mega', fuelMul: 0.85 },
  { id: 'jakarta', name: 'Jakarta (Tanjung Priok)', country: 'ID', lat: -6.09, lon: 106.89, size: 'major', fuelMul: 0.93 },
  { id: 'manila', name: 'Manila', country: 'PH', lat: 14.59, lon: 120.95, size: 'major', fuelMul: 0.98 },
  { id: 'hong_kong', name: 'Hong Kong', country: 'HK', lat: 22.29, lon: 114.17, size: 'mega', fuelMul: 0.9 },
  { id: 'shanghai', name: 'Shanghai (Yangshan)', country: 'CN', lat: 30.61, lon: 122.06, size: 'mega', fuelMul: 0.9 },
  { id: 'busan', name: 'Busan', country: 'KR', lat: 35.08, lon: 129.05, size: 'mega', fuelMul: 0.93 },
  { id: 'tokyo', name: 'Tokyo (Yokohama)', country: 'JP', lat: 35.6, lon: 139.8, size: 'mega', fuelMul: 1.0 },
  { id: 'sydney', name: 'Sydney (Botany)', country: 'AU', lat: -33.83, lon: 151.28, size: 'major', fuelMul: 1.05 },
  { id: 'auckland', name: 'Auckland', country: 'NZ', lat: -36.83, lon: 174.78, size: 'regional', fuelMul: 1.08 },
  { id: 'cape_town', name: 'Cape Town', country: 'ZA', lat: -33.89, lon: 18.43, size: 'major', fuelMul: 1.0 },
  { id: 'mombasa', name: 'Mombasa', country: 'KE', lat: -4.07, lon: 39.65, size: 'regional', fuelMul: 1.02 },
  { id: 'dakar', name: 'Dakar', country: 'SN', lat: 14.68, lon: -17.42, size: 'regional', fuelMul: 1.0 },
  { id: 'las_palmas', name: 'Las Palmas', country: 'ES', lat: 28.14, lon: -15.40, size: 'regional', fuelMul: 0.96 },
  { id: 'rio_de_janeiro', name: 'Rio de Janeiro', country: 'BR', lat: -22.9, lon: -43.15, size: 'major', fuelMul: 1.0 },
  { id: 'santos', name: 'Santos', country: 'BR', lat: -23.98, lon: -46.3, size: 'mega', fuelMul: 0.98 },
  { id: 'buenos_aires', name: 'Buenos Aires', country: 'AR', lat: -34.57, lon: -58.35, size: 'major', fuelMul: 1.0 },
  { id: 'valparaiso', name: 'Valparaíso', country: 'CL', lat: -33.03, lon: -71.62, size: 'regional', fuelMul: 1.03 },
  { id: 'panama_colon', name: 'Colón (Panama)', country: 'PA', lat: 9.37, lon: -79.92, size: 'major', fuelMul: 0.95 },
  { id: 'galveston', name: 'Galveston / Houston', country: 'US', lat: 29.33, lon: -94.78, size: 'major', fuelMul: 0.88 },
  { id: 'new_york', name: 'New York / New Jersey', country: 'US', lat: 40.61, lon: -74.04, size: 'mega', fuelMul: 1.0 },
  { id: 'halifax', name: 'Halifax', country: 'CA', lat: 44.63, lon: -63.55, size: 'regional', fuelMul: 1.0 },
  { id: 'los_angeles', name: 'Los Angeles / Long Beach', country: 'US', lat: 33.72, lon: -118.24, size: 'mega', fuelMul: 1.0 },
  { id: 'vancouver', name: 'Vancouver', country: 'CA', lat: 49.3, lon: -123.1, size: 'major', fuelMul: 1.02 },
  { id: 'honolulu', name: 'Honolulu', country: 'US', lat: 21.3, lon: -157.87, size: 'regional', fuelMul: 1.12 },
  { id: 'st_petersburg', name: 'St. Petersburg', country: 'RU', lat: 59.92, lon: 30.2, size: 'major', fuelMul: 0.95 },
  { id: 'gdansk', name: 'Gdańsk', country: 'PL', lat: 54.4, lon: 18.68, size: 'major', fuelMul: 0.97 },
  { id: 'stockholm', name: 'Stockholm', country: 'SE', lat: 59.33, lon: 18.12, size: 'regional', fuelMul: 1.05 },
  { id: 'helsinki', name: 'Helsinki', country: 'FI', lat: 60.15, lon: 24.96, size: 'regional', fuelMul: 1.05 },
  { id: 'murmansk', name: 'Murmansk', country: 'RU', lat: 68.98, lon: 33.07, size: 'regional', fuelMul: 1.1 },
  // ---- World coverage (v7 step 0): ~250 more ports on every continent, server/harbors-world.js ----
  ...WORLD_HARBORS,
];

// Navigable channels carved as water in the land mask (lat, lon polylines). widthM in real metres.
export const CHANNELS = [
  // V7 big ports: the Westerschelde / Scheldt is carved from OSM (server/bigports/antwerp.json); this chain only feeds the
  // lane graph (server/lanes.js) and follows the real river (a water path on the carved raster, Vlissingen → Deurganckdok).
  { id: 'westerschelde', widthM: 1800, pts: [[51.4275, 3.5025], [51.3725, 3.8975], [51.4225, 4.0075], [51.3725, 4.2225], [51.3225, 4.2725], [51.3025, 4.2725], [51.2975, 4.2675]] },
  // V7 big ports: the Elbe is carved from OSM (server/bigports/hamburg.json); the chain follows the real river (lane graph)
  { id: 'elbe', widthM: 1800, pts: [[53.8975, 8.6025], [53.8675, 9.2825], [53.6525, 9.5325], [53.6225, 9.5525], [53.6075, 9.5675], [53.5575, 9.7125], [53.5575, 9.7675], [53.5425, 9.8925], [53.5425, 9.9175], [53.5375, 9.9325]] },
  { id: 'thames', widthM: 1800, pts: [[51.49, 0.95], [51.47, 0.75], [51.45, 0.55], [51.45, 0.37]] },
  { id: 'humber', widthM: 2000, pts: [[53.57, 0.18], [53.62, 0.0], [53.66, -0.12], [53.72, -0.26], [53.74, -0.33]] },
  // Port of Rotterdam waterways (OpenStreetMap waterway centrelines, 2026-10-07): the Natural Earth coast predates
  // Maasvlakte 2 and is too coarse for the canals, so the real channels are carved into the world raster.
  { id: 'calandkanaal_41923863', widthM: 1200, pts: [[51.897, 4.2277], [51.9115, 4.2239], [51.9226, 4.2122], [51.9342, 4.1903], [51.945, 4.1681], [51.9564, 4.1445], [51.9648, 4.124], [51.968, 4.1163]] },
  { id: 'beerkanaal_41947487', widthM: 1200, pts: [[51.9426, 4.0795], [51.9544, 4.0837], [51.9653, 4.0872], [51.9756, 4.0906]] },
  { id: 'hartelkanaal_41947488', widthM: 700, pts: [[51.8658, 4.2951], [51.8655, 4.2744], [51.8699, 4.2505], [51.877, 4.2359], [51.8846, 4.2313]] },
  { id: 'hartelkanaal_41947494', widthM: 700, pts: [[51.8846, 4.2313], [51.8951, 4.2226], [51.903, 4.2095], [51.9121, 4.1896], [51.921, 4.1735], [51.9296, 4.1611], [51.9333, 4.1379], [51.9366, 4.1122], [51.9392, 4.0896], [51.9395, 4.0837]] },
  { id: 'nieuwe_maas_41948489', widthM: 1200, pts: [[51.9036, 4.518], [51.9146, 4.5128], [51.9157, 4.493], [51.9058, 4.4812], [51.9001, 4.466], [51.9, 4.4482], [51.902, 4.4352]] },
  { id: 'oude_maas_41950358', widthM: 600, pts: [[51.8008, 4.6209], [51.8057, 4.6006], [51.8077, 4.5812], [51.8133, 4.5658], [51.8255, 4.558], [51.8319, 4.5392], [51.8311, 4.5184], [51.8355, 4.4992], [51.8339, 4.478], [51.8324, 4.4501], [51.8371, 4.4326], [51.8428, 4.4133], [51.842, 4.3875], [51.8438, 4.3702], [51.8512, 4.3493], [51.8549, 4.3445]] },
  { id: 'scheur_196124015', widthM: 1200, pts: [[51.8942, 4.3196], [51.8979, 4.2916], [51.9028, 4.2746], [51.9107, 4.2541], [51.9171, 4.2371], [51.9279, 4.2242], [51.9355, 4.2087], [51.943, 4.1885], [51.9494, 4.1743], [51.9532, 4.1663]] },
  { id: 'calandkanaal_206380607', widthM: 1200, pts: [[51.968, 4.1163], [51.9756, 4.0906], [51.9793, 4.0748]] },
  { id: 'nieuwe_waterweg_206380608', widthM: 1200, pts: [[51.9532, 4.1663], [51.9616, 4.15], [51.9702, 4.1321], [51.9765, 4.1154], [51.9819, 4.0928], [51.9831, 4.0881]] },
  { id: 'dintelhaven_253833882', widthM: 700, pts: [[51.9321, 4.1499], [51.9384, 4.1325], [51.9466, 4.1184], [51.9575, 4.1167], [51.9604, 4.1065]] },
  { id: 'botlek_328993640', widthM: 700, pts: [[51.8819, 4.2656], [51.883, 4.2768], [51.8883, 4.305], [51.8951, 4.3099]] },
  { id: 'prinses_amaliahaven_782488497', widthM: 900, pts: [[51.9406, 3.9826], [51.9567, 4.0007], [51.9595, 4.0015]] },
  { id: 'europahaven_782488499', widthM: 1200, pts: [[51.9622, 4.0311], [51.9625, 4.0728]] },
  { id: 'amazonehaven_782488500', widthM: 800, pts: [[51.9452, 4.0394], [51.9493, 4.0711], [51.9508, 4.0824]] },
  { id: 'hartelhaven_782488502', widthM: 800, pts: [[51.9463, 4.0306], [51.9324, 4.0393]] },
  { id: 'mississippihaven_782488503', widthM: 800, pts: [[51.9324, 4.0393], [51.9407, 4.0742], [51.9426, 4.0795]] },
  { id: 'hartelkanaal_782488511', widthM: 700, pts: [[51.8666, 4.3339], [51.8654, 4.3152], [51.8658, 4.2951]] },
  { id: 'maasmond_799771237', widthM: 1200, pts: [[51.9793, 4.0748], [51.9874, 4.0642]] },
  { id: 'oude_maas_802441630', widthM: 600, pts: [[51.8549, 4.3445], [51.8622, 4.3373], [51.8734, 4.33], [51.8863, 4.324], [51.8942, 4.3196]] },
  { id: 'maasmond_962620025', widthM: 1200, pts: [[51.9831, 4.0881], [51.9874, 4.0642], [51.9905, 4.0447], [51.995, 4.01], [52.0, 3.98]] },
  { id: 'nieuwe_maas_1460533133', widthM: 1200, pts: [[51.902, 4.4352], [51.901, 4.4158], [51.897, 4.397], [51.8984, 4.3761], [51.8987, 4.3549], [51.8943, 4.3346], [51.8942, 4.3196]] },
  { id: 'yangtzekanaal', widthM: 1200, pts: [[51.9595, 4.0015], [51.9622, 4.0311], [51.975, 4.033], [51.9905, 4.0447]] },
  { id: 'gota_alv', widthM: 1500, pts: [[57.62, 11.70], [57.66, 11.80], [57.69, 11.88]] },
  { id: 'oslofjord', widthM: 2200, pts: [[59.05, 10.55], [59.30, 10.52], [59.50, 10.55], [59.65, 10.60], [59.78, 10.58], [59.86, 10.66], [59.88, 10.72]] },
  { id: 'tyne', widthM: 1200, pts: [[55.01, -1.35], [55.00, -1.45], [54.98, -1.52]] },
  { id: 'solent', widthM: 1800, pts: [[50.70, -1.00], [50.76, -1.15], [50.80, -1.28], [50.86, -1.36], [50.89, -1.39]] },
  { id: 'byfjorden', widthM: 1600, pts: [[60.30, 4.95], [60.35, 5.10], [60.38, 5.22], [60.395, 5.29]] },
  { id: 'moray', widthM: 1800, pts: [[57.60, -3.95], [57.53, -4.12], [57.50, -4.22]] },
  { id: 'kattegat_oresund', widthM: 2500, pts: [[56.05, 12.65], [55.90, 12.70], [55.80, 12.68], [55.70, 12.64]] },
];

// Offshore installations served by supply contracts (real field positions).
export const PLATFORMS = [
  { id: 'ekofisk', name: 'Ekofisk complex', lat: 56.55, lon: 3.21 },
  { id: 'troll', name: 'Troll A', lat: 60.64, lon: 3.72 },
  { id: 'brent', name: 'Brent field', lat: 61.07, lon: 1.70 },
  { id: 'gullfaks', name: 'Gullfaks C', lat: 61.20, lon: 2.27 },
  { id: 'sleipner', name: 'Sleipner', lat: 58.37, lon: 1.91 },
  { id: 'forties', name: 'Forties Alpha', lat: 57.72, lon: 0.97 },
  { id: 'tyra', name: 'Tyra East', lat: 55.72, lon: 4.80 },
  { id: 'f3', name: 'F3-FA platform', lat: 54.85, lon: 4.72 },
  { id: 'leman', name: 'Leman field', lat: 53.10, lon: 2.10 },
  { id: 'l9', name: 'L9 (Dutch sector)', lat: 53.60, lon: 4.90 },
  { id: 'gom', name: 'Mars TLP (Gulf of Mexico)', lat: 28.17, lon: -89.22 },
  { id: 'campos', name: 'Campos Basin FPSO', lat: -22.5, lon: -40.0 },
  { id: 'gulf', name: 'South Pars platform', lat: 26.5, lon: 52.5 },
  { id: 'bass', name: 'Bass Strait platform', lat: -38.5, lon: 148.0 },
  ...WORLD_PLATFORMS,
];

export const FISHING_GROUNDS = [
  { id: 'dogger', name: 'Dogger Bank', lat: 54.7, lon: 2.8, radiusKm: 70, richness: 1.0 },
  { id: 'fladen', name: 'Fladen Ground', lat: 58.8, lon: 0.5, radiusKm: 60, richness: 0.9 },
  { id: 'norw_trench', name: 'Norwegian Trench edge', lat: 57.8, lon: 5.3, radiusKm: 50, richness: 1.2 },
  { id: 'southern_bight', name: 'Southern Bight', lat: 52.3, lon: 3.1, radiusKm: 45, richness: 0.7 },
  { id: 'shetland', name: 'Shetland grounds', lat: 60.3, lon: -0.6, radiusKm: 60, richness: 1.1 },
  { id: 'skagerrak', name: 'Skagerrak deep', lat: 57.9, lon: 9.0, radiusKm: 45, richness: 0.8 },
  { id: 'channel_west', name: 'Western Channel', lat: 49.9, lon: -2.6, radiusKm: 50, richness: 0.8 },
  { id: 'irish_sea', name: 'Irish Sea', lat: 53.5, lon: -5.0, radiusKm: 55, richness: 0.75 },
  { id: 'grand_banks', name: 'Grand Banks', lat: 45.0, lon: -51.0, radiusKm: 200, richness: 1.5 },
  { id: 'benguela', name: 'Benguela upwelling', lat: -27.0, lon: 14.5, radiusKm: 200, richness: 1.3 },
  ...WORLD_FISHING_GROUNDS,
];

// Coast-guard patrol routes (chokepoints). Each cutter loops its waypoints.
export const PATROLS = [
  { id: 'cg_dover', name: 'HMCG Dover', pts: [[51.05, 1.55], [51.15, 1.75], [51.00, 1.95], [50.95, 1.60]] },
  { id: 'cg_maas', name: 'KWC Maas', pts: [[52.05, 3.80], [52.10, 4.10], [51.95, 4.20], [51.90, 3.85]] },
  { id: 'cg_elbe', name: 'BPol Elbe', pts: [[54.05, 8.40], [53.95, 8.80], [54.10, 7.90], [54.20, 8.20]] },
  { id: 'cg_skagen', name: 'KV Skagen', pts: [[57.80, 10.80], [58.10, 10.40], [57.90, 11.20], [57.70, 10.90]] },
  { id: 'cg_humber', name: 'HMCG Humber', pts: [[53.55, 0.40], [53.70, 0.70], [53.40, 0.80], [53.35, 0.45]] },
  { id: 'cg_scheldt', name: 'DAB Scheldt', pts: [[51.45, 3.35], [51.55, 3.10], [51.40, 2.95], [51.35, 3.30]] },
  { id: 'cg_forth', name: 'HMCG Forth', pts: [[56.05, -2.60], [56.15, -2.30], [55.95, -2.20], [55.90, -2.70]] },
  { id: 'cg_oslofjord', name: 'KV Oslofjord', pts: [[58.90, 10.60], [59.00, 10.40], [59.10, 10.75], [58.95, 10.90]] },
];

export function carvingsForWorld() {
  const c = [];
  for (const h of HARBORS) c.push({ type: 'basin', lat: h.lat, lon: h.lon, radiusM: h.size === 'mega' ? 2600 : h.size === 'major' ? 2200 : 1800 });
  for (const ch of CHANNELS) c.push({ type: 'channel', pts: ch.pts, widthM: ch.widthM });
  for (const pc of portCarvings()) c.push(pc);   // V7 step 0 big ports: OSM water of whole port areas (server/bigports.js)
  return c;
}

export function harborById(id) { return HARBORS.find((h) => h.id === id); }
