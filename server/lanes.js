// Sea-lane graph for AI traffic and the chart (docs/V3-CONTRACTS.md §2).
//
// LANE_NODES: hand-placed waypoints — traffic separation schemes, approaches and offshore junctions in the North
// Sea / Channel / Skagerrak / Irish Sea detail region, a coarser set of ocean nodes for the global layer, and the
// navigable river channels from server/harbors.js (CHANNELS) as node chains so river harbours (Hamburg, Antwerp,
// Tilbury, Hull, Oslo…) are reached along the carved water and not across the bank. Every coordinate was checked
// against the world raster (Natural Earth 10 m in the region, 50 m globally).
// LANE_EDGES: straight edges between node ids. `{canal: true}` marks a man-made canal (Suez, Panama) or a strait the
// raster cannot resolve (Dardanelles): those edges skip the water check and route points on them carry a third
// element `1` so a consumer can treat the leg as "no water check" (traffic.js does).
//
// buildGraph(world) links every harbour and every river-chain end to its nearest reachable lane nodes, verifies
// every edge against world.isWater at 2 km steps (dropping and counting edges that cross land; harbour links may
// touch land in their first/last 3 km because harbour points sit in estuaries) and returns Dijkstra routing between
// harbour ids.
import { HARBORS, CHANNELS } from './harbors.js';
import { WORLD_NODES, WORLD_EDGES, keepEdge, applyDeepMoves } from './lanes-world.js';
import { haversine, wrapLon } from '../shared/geo.js';

const N = (id, name, lat, lon, kind = 'waypoint') => ({ id, name, lat, lon, kind });

// ---- Detail region (North Sea, Channel, Skagerrak/Kattegat, Irish Sea, Scottish waters) ----
const REGION_NODES = [
  // Western approaches and the Channel
  N('ushant', 'Ushant TSS', 48.45, -5.75, 'tss'),
  N('brest_appr', 'Brest approach (Iroise)', 48.33, -4.85),
  N('lizard', 'Off the Lizard', 49.72, -5.15),
  N('landsend', 'Off Land\'s End', 49.95, -5.95),
  N('channel_w', 'Western Channel', 49.45, -4.00),
  N('plymouth_appr', 'Plymouth Sound approach', 50.27, -4.15),
  N('start_pt', 'Off Start Point', 50.10, -3.60),
  N('casquets', 'Casquets TSS', 49.90, -2.60, 'tss'),
  N('cherbourg_appr', 'Cherbourg approach', 49.78, -1.62),
  N('barfleur', 'Off Barfleur', 49.78, -1.15),
  N('portland', 'Off Portland Bill', 50.45, -2.45),
  N('channel_mid', 'Mid-Channel', 50.15, -1.20),
  N('solent_appr', 'Nab Tower / Solent approach', 50.62, -0.95),
  N('le_havre_appr', 'Baie de Seine', 49.50, -0.10),
  N('antifer', 'Off Cap d\'Antifer', 49.78, -0.15),
  N('beachy', 'Off Beachy Head', 50.60, 0.30),
  N('dieppe', 'Off Dieppe', 50.05, 1.00),
  N('channel_e', 'Eastern Channel', 50.75, 0.95),
  N('dover_tss_ne', 'Dover Strait TSS (NE-bound lane)', 50.93, 1.58, 'tss'),
  N('dover_tss_sw', 'Dover Strait TSS (SW-bound lane)', 51.07, 1.42, 'tss'),
  N('dover_ne_out', 'Dover Strait north-east exit', 51.25, 1.95, 'tss'),
  // Southern North Sea
  N('sandettie', 'Sandettié', 51.35, 2.10),
  N('westhinder', 'Westhinder', 51.38, 2.44),
  N('scheldt_appr', 'Westerschelde approach', 51.45, 3.35),
  N('noord_hinder', 'Noord Hinder junction', 52.00, 3.00, 'tss'),
  N('maas_appr', 'Maas Center', 52.02, 3.85, 'tss'),
  N('ijmuiden_appr', 'IJmuiden approach', 52.47, 4.35),
  N('texel', 'Texel TSS', 53.05, 4.30, 'tss'),
  N('terschelling', 'Terschelling TSS', 53.55, 4.90, 'tss'),
  N('ems_mouth', 'Ems approach (Westerems)', 53.52, 6.90),
  N('ems_mid', 'Ems estuary', 53.34, 6.98),
  N('german_bight_w', 'German Bight western approach', 54.05, 6.35, 'tss'),
  N('german_bight', 'German Bight TSS', 54.10, 7.60, 'tss'),
  N('helgoland', 'North of Helgoland', 54.28, 7.80),
  N('elbe_appr', 'Elbe approach', 54.00, 8.25, 'tss'),
  N('jade_appr', 'Jade / Weser approach', 53.80, 8.08),
  N('thames_appr', 'Thames estuary', 51.52, 1.25),
  N('sunk', 'Sunk / Harwich approach', 51.90, 1.60),
  N('smiths_knoll', 'Smith\'s Knoll', 52.65, 2.15),
  N('cromer', 'Off Cromer', 53.10, 1.30),
  N('humber_appr', 'Humber approach', 53.55, 0.40),
  N('dogger_s', 'Dogger Bank south', 54.30, 2.80),
  // English and Scottish east coast
  N('flamborough', 'Off Flamborough Head', 54.10, -0.05),
  N('tees', 'Off the Tees', 54.72, -0.75),
  N('tyne_appr', 'Tyne approach', 55.02, -1.20),
  N('farne', 'Off the Farne Islands', 55.65, -1.40),
  N('forth_mid', 'Firth of Forth (Inchkeith)', 56.04, -2.95),
  N('forth_mid2', 'Firth of Forth (Bass Rock)', 56.13, -2.60),
  N('forth_appr', 'Firth of Forth approach', 56.15, -2.35),
  N('aberdeen_appr', 'Aberdeen approach', 57.12, -1.85),
  N('rattray', 'Off Rattray Head', 57.62, -1.55),
  N('kinnaird', 'Off Kinnaird Head', 57.80, -2.00),
  N('moray_appr', 'Moray Firth', 57.75, -3.70),
  N('pentland_e', 'Pentland Firth east', 58.72, -2.75),
  N('pentland_w', 'Pentland Firth west', 58.72, -3.45),
  N('orkney_e', 'East of Orkney', 58.90, -2.45),
  N('kirkwall_appr', 'Kirkwall approach (Shapinsay Sound)', 59.03, -2.60),
  N('fair_isle', 'Fair Isle channel', 59.60, -1.60),
  N('lerwick_appr', 'Lerwick approach (Bressay Sound)', 60.05, -1.05),
  N('bressay_e', 'East of Bressay', 60.10, -0.75),
  N('shetland_n', 'North of Shetland', 61.00, -0.50),
  N('north_scotland', 'Off Cape Wrath', 58.75, -5.10),
  N('butt_lewis', 'Butt of Lewis', 58.65, -6.45),
  N('hebrides_w', 'West of the Hebrides', 57.60, -8.00),
  N('barra_head', 'Off Barra Head', 56.65, -7.95),
  N('malin', 'Off Malin Head', 55.55, -7.55),
  N('rathlin_n', 'North of Rathlin', 55.45, -6.35),
  // Offshore North Sea
  N('ekofisk_lane', 'Central North Sea', 56.50, 3.50),
  N('forties_lane', 'Forties', 57.80, 1.00),
  N('viking_lane', 'Northern North Sea', 60.60, 2.00),
  N('sylt_w', 'Off Sylt', 55.30, 7.70),
  N('horns_rev', 'Horns Rev', 55.55, 7.80),
  N('esbjerg_appr', 'Grådyb / Esbjerg approach', 55.46, 8.22),
  N('hanstholm', 'Off Hanstholm', 57.25, 8.20),
  // Skagerrak, Kattegat, Baltic approaches, Norwegian coast
  N('lindesnes', 'Off Lindesnes', 57.85, 7.00),
  N('kristiansand_appr', 'Kristiansand approach', 57.95, 8.00),
  N('skagerrak_mid', 'Skagerrak', 58.10, 9.20),
  N('skagen', 'Skagen', 57.85, 10.80),
  N('kattegat_n', 'Kattegat north', 57.30, 11.45),
  N('kattegat_s', 'Kattegat south (Anholt)', 56.60, 11.90),
  N('oresund_n', 'Øresund north', 56.15, 12.50),
  N('oresund_s', 'Øresund south (Drogden)', 55.50, 12.75),
  N('falsterbo_s', 'South of Falsterbo', 55.30, 12.75),
  N('samso_e', 'East of Samsø', 55.95, 10.80),
  N('great_belt', 'Great Belt', 55.45, 10.95),
  N('langeland_s', 'Langeland Belt south', 54.65, 10.95),
  N('fehmarn', 'Fehmarn Belt', 54.60, 11.10),
  N('kiel_bight', 'Kiel Bight', 54.55, 10.30),
  N('kiel_appr', 'Kiel Fjord', 54.405, 10.205),
  N('gedser', 'Off Gedser', 54.48, 12.00),
  N('faerder', 'Færder / Oslofjord approach', 58.95, 10.50),
  N('egersund', 'Off Egersund', 58.25, 5.45),
  N('stavanger_appr', 'Stavanger approach', 59.05, 5.55),
  N('utsira', 'Off Utsira', 59.30, 4.60),
  N('bergen_appr', 'Marstein / Bergen approach', 60.28, 4.85),
  N('fedje_w', 'West of Fedje', 60.80, 4.50),
  N('stad', 'Off Stad', 62.20, 4.80),
  // Irish Sea and the Celtic Sea
  N('stgeorges', 'St George\'s Channel', 51.95, -6.20),
  N('irish_sea_mid', 'Irish Sea', 53.30, -5.20),
  N('dublin_appr', 'Dublin Bay approach', 53.37, -5.95),
  N('holyhead', 'Off Anglesey', 53.45, -4.80),
  N('liverpool_bay', 'Liverpool Bay', 53.55, -3.60),
  N('iom_e', 'East of the Isle of Man', 54.00, -4.00),
  N('iom_n', 'North of the Isle of Man', 54.55, -4.40),
  N('galloway_s', 'South of the Mull of Galloway', 54.45, -5.10),
  N('north_channel', 'North Channel', 54.85, -5.55),
  N('fastnet', 'Fastnet', 51.20, -9.90),
];

// ---- Global ocean nodes (coarse layer) ----
const GLOBAL_NODES = [
  N('biscay', 'Bay of Biscay', 46.00, -6.00, 'ocean'),
  N('finisterre', 'Cape Finisterre TSS', 43.20, -9.80, 'ocean'),
  N('lisbon_appr', 'Lisbon approach', 38.60, -9.60, 'ocean'),
  N('st_vincent', 'Cape St Vincent', 36.80, -9.40, 'ocean'),
  N('gibraltar_strait', 'Strait of Gibraltar', 35.95, -5.60, 'ocean'),
  N('canaries', 'Canary Islands', 28.50, -14.50, 'ocean'),
  N('cap_blanc', 'Off Cap Blanc', 20.50, -18.00, 'ocean'),
  N('cape_verde', 'South of Cape Verde', 14.50, -23.00, 'ocean'),
  N('dakar_appr', 'Dakar approach', 14.70, -17.70, 'ocean'),
  N('liberia_w', 'Off Liberia', 4.00, -12.00, 'ocean'),
  N('gulf_guinea', 'Gulf of Guinea', 1.00, -2.00, 'ocean'),
  N('atlantic_s', 'South Atlantic', -15.00, -10.00, 'ocean'),
  N('cape_agulhas', 'Cape Agulhas', -35.50, 19.50, 'ocean'),
  N('cape_point', 'Off Cape Point', -34.50, 18.20, 'ocean'),
  N('cape_town_appr', 'Table Bay approach', -33.85, 18.20, 'ocean'),
  N('port_elizabeth_s', 'South of Port Elizabeth', -34.50, 26.00, 'ocean'),
  N('durban_e', 'Off Durban', -30.50, 32.50, 'ocean'),
  N('madagascar_s', 'South of Madagascar', -27.50, 46.50, 'ocean'),
  N('moz_channel', 'Mozambique Channel', -22.00, 40.50, 'ocean'),
  N('comoros_e', 'East of the Comoros', -12.00, 45.00, 'ocean'),
  N('mombasa_appr', 'Mombasa approach', -4.20, 40.10, 'ocean'),
  N('arabian_sea', 'Arabian Sea', 14.00, 62.00, 'ocean'),
  N('gulf_aden', 'Gulf of Aden', 12.80, 47.50, 'ocean'),
  N('aden_w', 'West of Aden', 12.30, 44.50, 'ocean'),
  N('bab_el_mandeb', 'Bab-el-Mandeb', 12.45, 43.35, 'ocean'),
  N('red_sea_s', 'Southern Red Sea', 15.80, 41.20, 'ocean'),
  N('red_sea_n', 'Northern Red Sea', 25.50, 35.50, 'ocean'),
  N('suez_gulf', 'Gulf of Suez', 28.60, 33.00, 'ocean'),
  N('suez_s', 'Suez (south end of the canal)', 29.85, 32.50, 'ocean'),
  N('port_said', 'Port Said (Suez approach)', 31.45, 32.30, 'ocean'),
  N('delta_n', 'North of the Nile delta', 31.90, 31.00, 'ocean'),
  N('med_e', 'Eastern Mediterranean', 33.50, 28.50, 'ocean'),
  N('alexandria_appr', 'Alexandria approach', 31.35, 29.80, 'ocean'),
  N('crete_w', 'West of Crete', 35.00, 23.00, 'ocean'),
  N('ionian', 'Ionian Sea', 36.50, 20.50, 'ocean'),
  N('matapan', 'Off Cape Matapan', 36.10, 22.60, 'ocean'),
  N('malea_s', 'South of Cape Malea', 36.20, 23.40, 'ocean'),
  N('saronic_s', 'Saronic Gulf south', 37.40, 23.80, 'ocean'),
  N('piraeus_appr', 'Saronic Gulf', 37.75, 23.65, 'ocean'),
  N('sounion_e', 'East of Cape Sounion', 37.55, 24.20, 'ocean'),
  N('kafireas_e', 'East of Cape Kafireas', 38.10, 24.90, 'ocean'),
  N('aegean_n', 'Northern Aegean', 39.50, 24.90, 'ocean'),
  N('lemnos_s', 'South of Lemnos', 39.60, 25.80, 'ocean'),
  N('dardanelles', 'Dardanelles entrance', 40.05, 26.20, 'ocean'),
  N('marmara', 'Sea of Marmara', 40.75, 28.30, 'ocean'),
  N('malta', 'Malta channel', 36.00, 15.00, 'ocean'),
  N('sicily_w', 'West of Sicily', 37.60, 11.80, 'ocean'),
  N('tyrrhenian', 'Tyrrhenian Sea', 40.50, 11.50, 'ocean'),
  N('ligurian', 'Ligurian Sea', 43.60, 8.90, 'ocean'),
  N('toulon_s', 'South of Toulon', 42.80, 6.30, 'ocean'),
  N('lion', 'Gulf of Lion', 42.70, 4.90, 'ocean'),
  N('sardinia_s', 'South of Sardinia', 38.40, 9.20, 'ocean'),
  N('med_w', 'Western Mediterranean', 38.50, 1.50, 'ocean'),
  N('alboran', 'Alborán Sea', 36.20, -3.00, 'ocean'),
  N('ras_al_hadd', 'Off Ras al Hadd', 22.30, 60.30, 'ocean'),
  N('oman_gulf', 'Gulf of Oman', 25.00, 57.60, 'ocean'),
  N('hormuz', 'Strait of Hormuz', 26.50, 56.70, 'ocean'),
  N('hormuz_w', 'West of Hormuz', 26.60, 56.00, 'ocean'),
  N('gulf_s', 'Southern Persian Gulf', 25.60, 55.00, 'ocean'),
  N('mumbai_appr', 'Mumbai approach', 18.80, 72.30, 'ocean'),
  N('goa_w', 'Off Goa', 15.00, 72.50, 'ocean'),
  N('cape_comorin', 'Off Cape Comorin', 7.50, 77.00, 'ocean'),
  N('colombo_appr', 'Colombo approach', 6.90, 79.40, 'ocean'),
  N('dondra', 'Off Dondra Head', 5.60, 80.60, 'ocean'),
  N('malacca_n', 'Malacca Strait north', 6.30, 97.30, 'ocean'),
  N('malacca_s', 'Malacca Strait south', 2.60, 101.00, 'ocean'),
  N('singapore_strait', 'Singapore Strait', 1.20, 103.60, 'ocean'),
  N('singapore_e', 'Singapore Strait east', 1.22, 104.25, 'ocean'),
  N('horsburgh', 'Off Horsburgh', 1.30, 104.65, 'ocean'),
  N('bintan_e', 'East of Bintan', 0.80, 105.00, 'ocean'),
  N('bangka_e', 'East of Bangka', -2.00, 107.00, 'ocean'),
  N('java_sea', 'Java Sea', -5.60, 107.30, 'ocean'),
  N('sunda_n', 'Sunda Strait north', -5.70, 106.00, 'ocean'),
  N('sunda_s', 'Sunda Strait south', -6.40, 105.20, 'ocean'),
  N('sunda_sw', 'South-west of Sunda', -7.00, 104.80, 'ocean'),
  N('scs_s', 'South China Sea south', 5.00, 107.00, 'ocean'),
  N('scs_mid', 'South China Sea', 12.00, 112.50, 'ocean'),
  N('hk_appr', 'Hong Kong approach', 21.90, 114.20, 'ocean'),
  N('manila_appr', 'Manila Bay approach', 14.45, 120.50, 'ocean'),
  N('luzon_strait', 'Luzon Strait', 20.80, 121.00, 'ocean'),
  N('east_china_sea', 'East China Sea', 27.50, 125.00, 'ocean'),
  N('shanghai_appr', 'Yangtze approach', 30.40, 122.90, 'ocean'),
  N('busan_appr', 'Busan approach', 34.90, 129.30, 'ocean'),
  N('goto', 'West of the Gotō islands', 32.50, 128.30, 'ocean'),
  N('kyushu_sw', 'South-west of Kyushu', 31.20, 129.60, 'ocean'),
  N('osumi', 'Ōsumi Strait south', 29.80, 131.70, 'ocean'),
  N('kii', 'Off the Kii peninsula', 33.20, 135.80, 'ocean'),
  N('izu_s', 'South of Izu Ōshima', 34.40, 139.40, 'ocean'),
  N('tokyo_appr', 'Tokyo Bay approach (Uraga)', 35.00, 139.70, 'ocean'),
  N('pacific_nw', 'North-west Pacific', 32.00, 145.00, 'ocean'),
  N('pacific_mid', 'Mid-Pacific', 30.00, 175.00, 'ocean'),
  N('hawaii_nw', 'North-west of Hawaii', 24.00, -161.50, 'ocean'),
  N('kaena_w', 'West of Kaena Point', 21.40, -158.60, 'ocean'),
  N('honolulu_appr', 'Honolulu approach', 21.15, -157.90, 'ocean'),
  N('hawaii_s', 'South of Hawaii', 18.50, -157.50, 'ocean'),
  N('polynesia', 'Polynesia', -10.00, -170.00, 'ocean'),
  N('pacific_e', 'North-east Pacific', 33.00, -125.00, 'ocean'),
  N('la_appr', 'San Pedro Bay', 33.60, -118.40, 'ocean'),
  N('juan_de_fuca', 'Juan de Fuca approach', 48.45, -125.00, 'ocean'),
  N('jdf_e', 'Juan de Fuca Strait east', 48.30, -124.00, 'ocean'),
  N('haro_s', 'Haro Strait south', 48.42, -123.25, 'ocean'),
  N('haro_n', 'Haro Strait north', 48.62, -123.20, 'ocean'),
  N('georgia_s', 'Strait of Georgia south', 48.85, -123.20, 'ocean'),
  N('georgia_mid', 'Strait of Georgia', 49.15, -123.40, 'ocean'),
  N('baja_s', 'South of Baja California', 22.00, -111.00, 'ocean'),
  N('tehuantepec', 'Gulf of Tehuantepec', 13.00, -97.00, 'ocean'),
  N('cocos', 'Off Cocos Island', 6.30, -86.00, 'ocean'),
  N('panama_pac', 'Gulf of Panama', 7.00, -80.00, 'ocean'),
  N('galapagos_e', 'East of the Galápagos', -3.00, -86.00, 'ocean'),
  N('pacific_se', 'South-east Pacific', -20.00, -80.00, 'ocean'),
  N('valparaiso_appr', 'Valparaíso approach', -33.00, -72.20, 'ocean'),
  N('chile_s', 'Off southern Chile', -45.00, -78.00, 'ocean'),
  N('horn_w', 'West of Cape Horn', -56.80, -74.00, 'ocean'),
  N('cape_horn', 'Cape Horn', -57.00, -67.00, 'ocean'),
  N('staten_e', 'East of Staten Island', -55.50, -62.50, 'ocean'),
  N('falklands_e', 'East of the Falklands', -52.00, -56.00, 'ocean'),
  N('rio_plata', 'Río de la Plata approach', -36.20, -55.00, 'ocean'),
  N('rio_grande_s', 'Off Rio Grande', -33.50, -50.00, 'ocean'),
  N('santa_catarina_e', 'East of Santa Catarina', -27.50, -46.50, 'ocean'),
  N('santos_appr', 'Santos approach', -24.30, -46.00, 'ocean'),
  N('rio_appr', 'Rio de Janeiro approach', -23.20, -43.10, 'ocean'),
  N('abrolhos_e', 'East of the Abrolhos', -18.50, -37.50, 'ocean'),
  N('recife_e', 'East of Recife', -8.00, -33.00, 'ocean'),
  N('colon_appr', 'Colón approach', 9.60, -79.85, 'ocean'),
  N('caribbean_w', 'Western Caribbean', 13.00, -78.00, 'ocean'),
  N('yucatan', 'Yucatán Channel', 21.80, -85.50, 'ocean'),
  N('gulf_mexico', 'Gulf of Mexico', 27.00, -90.00, 'ocean'),
  N('galveston_appr', 'Galveston approach', 29.00, -94.50, 'ocean'),
  N('tortugas_s', 'South of the Dry Tortugas', 24.20, -83.00, 'ocean'),
  N('florida_strait', 'Straits of Florida', 24.00, -80.80, 'ocean'),
  N('florida_e', 'Off Palm Beach', 26.50, -79.60, 'ocean'),
  N('hatteras', 'Off Cape Hatteras', 34.50, -74.50, 'ocean'),
  N('nyc_appr', 'Ambrose / New York approach', 40.40, -73.70, 'ocean'),
  N('nantucket_s', 'South of Nantucket', 40.60, -69.80, 'ocean'),
  N('sable_s', 'South of Sable Island', 43.30, -60.50, 'ocean'),
  N('halifax_appr', 'Halifax approach', 44.40, -63.30, 'ocean'),
  N('grand_banks_s', 'Grand Banks', 43.00, -52.00, 'ocean'),
  N('atlantic_n', 'North Atlantic', 48.00, -25.00, 'ocean'),
  N('atlantic_mid', 'Mid-Atlantic', 10.00, -35.00, 'ocean'),
  N('irish_w', 'West of Ireland', 53.50, -11.00, 'ocean'),
  N('blasket', 'West of the Blaskets', 52.00, -11.10, 'ocean'),
  N('iceland_s', 'South of Iceland', 63.40, -22.80, 'ocean'),
  N('faroe', 'Faroe Bank', 61.30, -6.80, 'ocean'),
  N('norway_n', 'Norwegian Sea', 65.00, 7.00, 'ocean'),
  N('lofoten_w', 'West of Lofoten', 68.50, 12.00, 'ocean'),
  N('tromso_w', 'Off Tromsø', 70.50, 17.50, 'ocean'),
  N('north_cape', 'North Cape', 71.60, 25.00, 'ocean'),
  N('varanger_n', 'North of Varanger', 70.80, 31.50, 'ocean'),
  N('murmansk_appr', 'Kola Inlet approach', 69.75, 33.60, 'ocean'),
  N('bornholm', 'North of Bornholm', 55.40, 15.00, 'ocean'),
  N('rozewie_n', 'North of Rozewie', 55.00, 18.50, 'ocean'),
  N('gdansk_appr', 'Gulf of Gdańsk (east of Hel)', 54.65, 19.10, 'ocean'),
  N('baltic_c', 'Central Baltic', 57.50, 19.50, 'ocean'),
  N('stockholm_appr', 'Stockholm archipelago approach', 59.30, 19.20, 'ocean'),
  N('hiiumaa_n', 'North of Hiiumaa', 59.30, 21.50, 'ocean'),
  N('gulf_finland', 'Gulf of Finland', 59.80, 24.00, 'ocean'),
  N('helsinki_appr', 'Helsinki approach', 60.05, 25.00, 'ocean'),
  N('gogland_s', 'South of Gogland', 59.85, 27.20, 'ocean'),
  N('petersburg_appr', 'Eastern Gulf of Finland', 60.00, 28.90, 'ocean'),
  N('indian_ocean_e', 'Eastern Indian Ocean', -15.00, 105.00, 'ocean'),
  N('leeuwin', 'Cape Leeuwin', -35.50, 114.50, 'ocean'),
  N('great_bight', 'Great Australian Bight', -37.00, 135.00, 'ocean'),
  N('bass_strait', 'Bass Strait', -39.80, 146.50, 'ocean'),
  N('gabo', 'Off Gabo Island', -38.20, 150.30, 'ocean'),
  N('tasman', 'Tasman Sea', -34.50, 152.50, 'ocean'),
  N('coral_sea', 'Coral Sea', -25.00, 155.00, 'ocean'),
  N('solomon_e', 'East of the Solomons', -12.00, 165.00, 'ocean'),
  N('tasman_mid', 'Mid-Tasman', -37.00, 165.00, 'ocean'),
  N('cape_reinga', 'Off Cape Reinga', -34.20, 172.50, 'ocean'),
  N('northland_e', 'East of Northland', -35.00, 174.80, 'ocean'),
  N('hauraki', 'Hauraki Gulf', -36.30, 175.20, 'ocean'),
];

// Navigable river channels (carved water in the raster) as node chains, seaward end first.
const RIVER_NODES = [];
const RIVER_EDGES = [];
const RIVER_ENDS = []; // node ids at both ends of each chain; linked to the sea lanes in buildGraph
for (const ch of CHANNELS) {
  let prev = null;
  ch.pts.forEach((p, i) => {
    const id = `${ch.id}_${i}`;
    RIVER_NODES.push(N(id, `${ch.id} channel ${i}`, p[0], p[1], 'river'));
    if (prev) RIVER_EDGES.push([prev, id]);
    prev = id;
  });
  RIVER_ENDS.push(`${ch.id}_0`, `${ch.id}_${ch.pts.length - 1}`);
}

export const LANE_NODES = applyDeepMoves([...REGION_NODES, ...GLOBAL_NODES, ...WORLD_NODES, ...RIVER_NODES]);

const E = (a, b, extra) => (extra ? [a, b, extra] : [a, b]);
const CANAL = { canal: true };
export const LANE_EDGES = [
  // Channel spine
  E('ushant', 'brest_appr'), E('ushant', 'channel_w'), E('ushant', 'lizard'), E('ushant', 'biscay'), E('ushant', 'fastnet'),
  E('lizard', 'landsend'), E('lizard', 'channel_w'), E('landsend', 'stgeorges'), E('landsend', 'fastnet'),
  E('channel_w', 'plymouth_appr'), E('channel_w', 'casquets'), E('channel_w', 'start_pt'), E('plymouth_appr', 'start_pt'),
  E('start_pt', 'portland'), E('start_pt', 'casquets'), E('casquets', 'cherbourg_appr'), E('casquets', 'channel_mid'), E('casquets', 'portland'),
  E('portland', 'channel_mid'), E('channel_mid', 'solent_appr'), E('channel_mid', 'le_havre_appr'), E('channel_mid', 'cherbourg_appr'), E('channel_mid', 'barfleur'),
  E('cherbourg_appr', 'barfleur'), E('barfleur', 'le_havre_appr'), E('le_havre_appr', 'antifer'), E('antifer', 'dieppe'), E('antifer', 'beachy'),
  E('solent_appr', 'beachy'), E('solent_appr', 'antifer'), E('beachy', 'channel_e'), E('dieppe', 'channel_e'), E('beachy', 'dieppe'),
  E('channel_e', 'dover_tss_ne'), E('channel_e', 'dover_tss_sw'), E('dover_tss_ne', 'dover_ne_out'), E('dover_tss_sw', 'dover_ne_out'),
  E('dover_tss_ne', 'dover_tss_sw'),
  // Southern North Sea
  E('dover_ne_out', 'sandettie'), E('dover_ne_out', 'thames_appr'), E('dover_ne_out', 'sunk'), E('sandettie', 'westhinder'), E('sandettie', 'noord_hinder'),
  E('westhinder', 'scheldt_appr'), E('westhinder', 'noord_hinder'), E('scheldt_appr', 'noord_hinder'), E('scheldt_appr', 'maas_appr'),
  E('noord_hinder', 'maas_appr'), E('noord_hinder', 'sunk'), E('noord_hinder', 'smiths_knoll'), E('noord_hinder', 'texel'), E('noord_hinder', 'dogger_s'),
  E('maas_appr', 'ijmuiden_appr'), E('maas_appr', 'texel'), E('ijmuiden_appr', 'texel'), E('texel', 'terschelling'), E('texel', 'dogger_s'),
  E('terschelling', 'ems_mouth'), E('terschelling', 'german_bight_w'), E('terschelling', 'dogger_s'), E('ems_mouth', 'ems_mid'), E('ems_mouth', 'german_bight_w'),
  E('german_bight_w', 'german_bight'), E('german_bight_w', 'dogger_s'), E('german_bight_w', 'sylt_w'),
  E('german_bight', 'helgoland'), E('german_bight', 'elbe_appr'), E('german_bight', 'jade_appr'), E('german_bight', 'sylt_w'), E('helgoland', 'elbe_appr'), E('helgoland', 'sylt_w'),
  E('elbe_appr', 'jade_appr'),
  E('thames_appr', 'sunk'), E('sunk', 'smiths_knoll'), E('smiths_knoll', 'cromer'), E('cromer', 'humber_appr'), E('cromer', 'dogger_s'),
  E('humber_appr', 'flamborough'), E('humber_appr', 'dogger_s'), E('dogger_s', 'ekofisk_lane'), E('dogger_s', 'flamborough'), E('dogger_s', 'tees'),
  // East coast of Britain
  E('flamborough', 'tees'), E('tees', 'tyne_appr'), E('tyne_appr', 'farne'), E('farne', 'forth_appr'), E('forth_appr', 'forth_mid2'), E('forth_mid2', 'forth_mid'),
  E('forth_appr', 'aberdeen_appr'), E('aberdeen_appr', 'rattray'), E('rattray', 'kinnaird'), E('kinnaird', 'moray_appr'), E('kinnaird', 'pentland_e'),
  E('rattray', 'forties_lane'), E('moray_appr', 'pentland_e'),
  E('pentland_e', 'pentland_w'), E('pentland_w', 'north_scotland'), E('pentland_e', 'orkney_e'), E('orkney_e', 'kirkwall_appr'), E('orkney_e', 'fair_isle'),
  E('pentland_e', 'fair_isle'), E('fair_isle', 'lerwick_appr'), E('fair_isle', 'viking_lane'), E('lerwick_appr', 'bressay_e'), E('bressay_e', 'shetland_n'),
  E('bressay_e', 'viking_lane'), E('shetland_n', 'faroe'), E('shetland_n', 'viking_lane'),
  E('north_scotland', 'faroe'), E('fair_isle', 'faroe'), E('north_scotland', 'butt_lewis'), E('butt_lewis', 'hebrides_w'), E('hebrides_w', 'barra_head'),
  E('barra_head', 'malin'), E('malin', 'rathlin_n'), E('rathlin_n', 'north_channel'), E('malin', 'irish_w'), E('irish_w', 'blasket'), E('blasket', 'fastnet'),
  E('butt_lewis', 'faroe'),
  // Offshore North Sea crossings
  E('ekofisk_lane', 'forties_lane'), E('ekofisk_lane', 'lindesnes'), E('ekofisk_lane', 'hanstholm'), E('ekofisk_lane', 'horns_rev'), E('ekofisk_lane', 'texel'),
  E('ekofisk_lane', 'terschelling'), E('forties_lane', 'viking_lane'), E('forties_lane', 'utsira'), E('forties_lane', 'egersund'),
  E('viking_lane', 'bergen_appr'), E('viking_lane', 'utsira'), E('viking_lane', 'fedje_w'), E('viking_lane', 'norway_n'), E('viking_lane', 'faroe'),
  E('sylt_w', 'horns_rev'), E('sylt_w', 'esbjerg_appr'), E('horns_rev', 'esbjerg_appr'), E('horns_rev', 'hanstholm'), E('hanstholm', 'lindesnes'),
  E('hanstholm', 'skagerrak_mid'), E('hanstholm', 'skagen'),
  // Skagerrak, Kattegat, Baltic approaches, Norwegian coast
  E('lindesnes', 'kristiansand_appr'), E('lindesnes', 'egersund'), E('egersund', 'stavanger_appr'), E('kristiansand_appr', 'skagerrak_mid'),
  E('skagerrak_mid', 'skagen'), E('skagerrak_mid', 'faerder'), E('skagen', 'faerder'), E('skagen', 'kattegat_n'), E('kattegat_n', 'kattegat_s'),
  E('kattegat_s', 'oresund_n'), E('kattegat_s', 'samso_e'), E('samso_e', 'great_belt'), E('great_belt', 'langeland_s'), E('langeland_s', 'fehmarn'),
  E('fehmarn', 'kiel_bight'), E('kiel_bight', 'kiel_appr'), E('fehmarn', 'gedser'), E('gedser', 'bornholm'), E('oresund_s', 'falsterbo_s'), E('falsterbo_s', 'bornholm'),
  E('falsterbo_s', 'gedser'),
  E('stavanger_appr', 'utsira'), E('utsira', 'bergen_appr'), E('bergen_appr', 'fedje_w'), E('fedje_w', 'stad'), E('stad', 'norway_n'),
  // Irish Sea
  E('stgeorges', 'irish_sea_mid'), E('stgeorges', 'fastnet'), E('irish_sea_mid', 'dublin_appr'), E('irish_sea_mid', 'holyhead'),
  E('holyhead', 'liverpool_bay'), E('irish_sea_mid', 'galloway_s'), E('liverpool_bay', 'iom_e'), E('iom_e', 'iom_n'), E('iom_n', 'galloway_s'),
  E('galloway_s', 'north_channel'), E('holyhead', 'iom_e'), E('fastnet', 'atlantic_n'), E('fastnet', 'biscay'),
  // Atlantic Europe and the Mediterranean
  E('biscay', 'finisterre'), E('biscay', 'atlantic_n'), E('finisterre', 'lisbon_appr'), E('finisterre', 'atlantic_n'), E('lisbon_appr', 'st_vincent'),
  E('st_vincent', 'gibraltar_strait'), E('st_vincent', 'canaries'), E('gibraltar_strait', 'alboran'), E('alboran', 'med_w'), E('med_w', 'lion'),
  E('med_w', 'sardinia_s'), E('lion', 'toulon_s'), E('toulon_s', 'ligurian'), E('ligurian', 'tyrrhenian'), E('sardinia_s', 'tyrrhenian'),
  E('tyrrhenian', 'sicily_w'), E('sicily_w', 'malta'), E('sardinia_s', 'malta'), E('sardinia_s', 'sicily_w'), E('malta', 'ionian'), E('malta', 'med_e'),
  E('ionian', 'matapan'), E('matapan', 'malea_s'), E('malea_s', 'saronic_s'), E('saronic_s', 'piraeus_appr'), E('saronic_s', 'sounion_e'),
  E('sounion_e', 'kafireas_e'), E('kafireas_e', 'aegean_n'), E('aegean_n', 'lemnos_s'), E('lemnos_s', 'dardanelles'), E('dardanelles', 'marmara', CANAL),
  E('ionian', 'crete_w'), E('matapan', 'crete_w'), E('crete_w', 'med_e'), E('med_e', 'alexandria_appr'), E('med_e', 'port_said'),
  E('alexandria_appr', 'delta_n'), E('delta_n', 'port_said'),
  E('port_said', 'suez_s', CANAL), E('suez_s', 'suez_gulf'), E('suez_gulf', 'red_sea_n'), E('red_sea_n', 'red_sea_s'), E('red_sea_s', 'bab_el_mandeb'),
  E('bab_el_mandeb', 'aden_w'), E('aden_w', 'gulf_aden'), E('gulf_aden', 'arabian_sea'), E('arabian_sea', 'ras_al_hadd'), E('ras_al_hadd', 'oman_gulf'),
  E('oman_gulf', 'hormuz'), E('hormuz', 'hormuz_w'), E('hormuz_w', 'gulf_s'), E('arabian_sea', 'mumbai_appr'), E('arabian_sea', 'goa_w'),
  E('mumbai_appr', 'goa_w'), E('goa_w', 'cape_comorin'), E('cape_comorin', 'colombo_appr'), E('colombo_appr', 'dondra'), E('cape_comorin', 'dondra'),
  E('dondra', 'malacca_n'), E('arabian_sea', 'mombasa_appr'), E('gulf_aden', 'mombasa_appr'),
  // Africa and the South Atlantic
  E('canaries', 'cape_verde'), E('canaries', 'cap_blanc'), E('cap_blanc', 'dakar_appr'), E('cape_verde', 'dakar_appr'), E('cape_verde', 'liberia_w'),
  E('liberia_w', 'gulf_guinea'), E('cape_verde', 'atlantic_mid'), E('dakar_appr', 'liberia_w'),
  E('gulf_guinea', 'atlantic_s'), E('atlantic_s', 'cape_agulhas'), E('atlantic_s', 'rio_appr'), E('atlantic_s', 'atlantic_mid'), E('cape_agulhas', 'cape_point'),
  E('cape_point', 'cape_town_appr'), E('cape_agulhas', 'port_elizabeth_s'), E('port_elizabeth_s', 'durban_e'), E('durban_e', 'moz_channel'),
  E('durban_e', 'madagascar_s'), E('madagascar_s', 'indian_ocean_e'), E('madagascar_s', 'leeuwin'), E('port_elizabeth_s', 'indian_ocean_e'),
  E('moz_channel', 'comoros_e'), E('comoros_e', 'mombasa_appr'), E('mombasa_appr', 'colombo_appr'), E('comoros_e', 'arabian_sea'),
  E('atlantic_s', 'cape_point'),
  // Asia and Australia
  E('malacca_n', 'malacca_s'), E('malacca_s', 'singapore_strait'), E('singapore_strait', 'singapore_e'), E('singapore_e', 'horsburgh'),
  E('horsburgh', 'scs_s'), E('horsburgh', 'bintan_e'), E('bintan_e', 'bangka_e'), E('bangka_e', 'java_sea'), E('bangka_e', 'scs_s'),
  E('java_sea', 'sunda_n'), E('sunda_n', 'sunda_s'), E('sunda_s', 'sunda_sw'), E('sunda_sw', 'indian_ocean_e'), E('indian_ocean_e', 'leeuwin'),
  E('leeuwin', 'great_bight'), E('great_bight', 'bass_strait'), E('bass_strait', 'gabo'), E('gabo', 'tasman'), E('tasman', 'tasman_mid'),
  E('tasman', 'coral_sea'), E('coral_sea', 'solomon_e'), E('solomon_e', 'pacific_nw'), E('tasman_mid', 'cape_reinga'), E('cape_reinga', 'northland_e'),
  E('northland_e', 'hauraki'), E('scs_s', 'scs_mid'), E('scs_mid', 'hk_appr'), E('scs_mid', 'manila_appr'),
  E('scs_mid', 'luzon_strait'), E('hk_appr', 'luzon_strait'), E('luzon_strait', 'east_china_sea'), E('luzon_strait', 'pacific_nw'),
  E('east_china_sea', 'shanghai_appr'), E('east_china_sea', 'busan_appr'), E('east_china_sea', 'goto'), E('busan_appr', 'goto'), E('goto', 'kyushu_sw'),
  E('kyushu_sw', 'osumi'), E('osumi', 'kii'), E('kii', 'izu_s'), E('izu_s', 'tokyo_appr'), E('kii', 'pacific_nw'), E('izu_s', 'pacific_nw'),
  E('pacific_nw', 'pacific_mid'), E('pacific_mid', 'hawaii_nw'), E('hawaii_nw', 'kaena_w'), E('kaena_w', 'honolulu_appr'), E('hawaii_nw', 'pacific_e'),
  E('pacific_mid', 'pacific_e'), E('honolulu_appr', 'hawaii_s'), E('hawaii_s', 'cocos'), E('hawaii_s', 'polynesia'), E('polynesia', 'tasman_mid'),
  E('polynesia', 'northland_e'), E('pacific_e', 'la_appr'), E('pacific_e', 'juan_de_fuca'), E('juan_de_fuca', 'jdf_e'), E('jdf_e', 'haro_s'),
  E('haro_s', 'haro_n'), E('haro_n', 'georgia_s'), E('georgia_s', 'georgia_mid'),
  E('pacific_e', 'baja_s'), E('baja_s', 'tehuantepec'), E('tehuantepec', 'cocos'), E('cocos', 'panama_pac'), E('panama_pac', 'galapagos_e'),
  E('galapagos_e', 'pacific_se'), E('pacific_se', 'valparaiso_appr'), E('valparaiso_appr', 'chile_s'), E('chile_s', 'horn_w'), E('horn_w', 'cape_horn'),
  E('panama_pac', 'colon_appr', CANAL), E('baja_s', 'hawaii_s'),
  // Americas
  E('cape_horn', 'staten_e'), E('staten_e', 'falklands_e'), E('falklands_e', 'rio_plata'), E('rio_plata', 'rio_grande_s'), E('rio_grande_s', 'santa_catarina_e'),
  E('santa_catarina_e', 'santos_appr'), E('santos_appr', 'rio_appr'), E('rio_appr', 'abrolhos_e'), E('abrolhos_e', 'recife_e'), E('recife_e', 'atlantic_mid'),
  E('recife_e', 'atlantic_s'), E('atlantic_mid', 'caribbean_w'), E('atlantic_mid', 'hatteras'), E('caribbean_w', 'colon_appr'), E('caribbean_w', 'yucatan'),
  E('yucatan', 'gulf_mexico'), E('gulf_mexico', 'galveston_appr'), E('gulf_mexico', 'tortugas_s'), E('tortugas_s', 'florida_strait'), E('yucatan', 'tortugas_s'),
  E('florida_strait', 'florida_e'), E('florida_e', 'hatteras'), E('hatteras', 'nyc_appr'), E('nyc_appr', 'nantucket_s'), E('nantucket_s', 'sable_s'),
  E('sable_s', 'halifax_appr'), E('sable_s', 'grand_banks_s'), E('nyc_appr', 'atlantic_n'), E('nantucket_s', 'atlantic_n'), E('grand_banks_s', 'atlantic_n'),
  E('atlantic_n', 'iceland_s'), E('iceland_s', 'faroe'), E('atlantic_mid', 'gulf_guinea'), E('atlantic_n', 'irish_w'), E('atlantic_n', 'blasket'),
  // Far north and the Baltic
  E('norway_n', 'lofoten_w'), E('lofoten_w', 'tromso_w'), E('tromso_w', 'north_cape'), E('north_cape', 'varanger_n'), E('varanger_n', 'murmansk_appr'),
  E('faroe', 'norway_n'), E('iceland_s', 'norway_n'),
  E('bornholm', 'rozewie_n'), E('rozewie_n', 'gdansk_appr'), E('bornholm', 'baltic_c'), E('rozewie_n', 'baltic_c'), E('baltic_c', 'stockholm_appr'),
  E('baltic_c', 'hiiumaa_n'), E('stockholm_appr', 'hiiumaa_n'), E('hiiumaa_n', 'gulf_finland'), E('gulf_finland', 'helsinki_appr'),
  E('gulf_finland', 'gogland_s'), E('gogland_s', 'petersburg_appr'), E('helsinki_appr', 'gogland_s'),
  // World coverage (server/lanes-world.js)
  ...WORLD_EDGES,
  // River channels
  ...RIVER_EDGES,
].filter(keepEdge);

const REGION_BOX = { latMin: 48, latMax: 62.5, lonMin: -8, lonMax: 14 };
export function inDetailRegion(lat, lon) { return lat >= REGION_BOX.latMin && lat < REGION_BOX.latMax && lon >= REGION_BOX.lonMin && lon < REGION_BOX.lonMax; }

const STEP_M = 2000;
const HARBOR_SLACK_M = 3000;
const SUBDIVIDE_M = 250000; // long legs are split so a ship homing on waypoints follows the validated straight line

// Point at fraction t of the straight lat/lon line a→b, taking the short way round the antimeridian.
function lerpLL(a, b, t) {
  const dlon = wrapLon(b.lon - a.lon);
  return { lat: a.lat + (b.lat - a.lat) * t, lon: wrapLon(a.lon + dlon * t) };
}

// Samples the straight lat/lon line a→b every STEP_M; returns the number of land samples outside the slack
// distance from either end (slack applies to harbour and river-mouth links).
export function landSamples(world, a, b, slackM = 0) {
  const len = haversine(a.lat, a.lon, b.lat, b.lon);
  const n = Math.max(1, Math.ceil(len / STEP_M));
  let bad = 0;
  for (let k = 0; k <= n; k++) {
    const t = k / n, d = t * len;
    if (slackM > 0 && (d < slackM || len - d < slackM)) continue;
    const p = lerpLL(a, b, t);
    if (!world.isWater(p.lat, p.lon)) bad++;
  }
  return bad;
}

/**
 * Builds the routing graph against the world raster.
 * @returns {{nodes: Map, adj: Map, harborLinks: Map, dropped: number,
 *            route(fromHarborId, toHarborId): ([number,number]|[number,number,1])[]|null}}
 */
export function buildGraph(world, opts = {}) {
  const log = opts.log || (() => {});
  const harbors = opts.harbors || HARBORS;
  const nodes = new Map();
  for (const n of LANE_NODES) nodes.set(n.id, { ...n });
  const adj = new Map();
  const link = (a, b, w, canal) => {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    if (adj.get(a).some((e) => e.to === b)) return;
    adj.get(a).push({ to: b, w, canal });
    adj.get(b).push({ to: a, w, canal });
  };
  let dropped = 0, kept = 0;
  const droppedList = [];
  for (const e of LANE_EDGES) {
    const a = nodes.get(e[0]), b = nodes.get(e[1]);
    if (!a || !b) { log(`[lanes] edge ${e[0]}-${e[1]} references an unknown node`); continue; }
    const canal = !!(e[2] && e[2].canal);
    if (!canal && landSamples(world, a, b, 0) > 0) { dropped++; droppedList.push(`${a.id}-${b.id}`); continue; }
    link(a.id, b.id, haversine(a.lat, a.lon, b.lat, b.lon), canal); kept++;
  }
  if (dropped) log(`[lanes] ${dropped} edge(s) cross land and were dropped: ${droppedList.join(', ')}`);

  const seaNodes = LANE_NODES.filter((n) => n.kind !== 'river');
  // Nearest reachable sea-lane nodes for a point (candidates by distance; the first/last 3 km may touch land).
  const nearestLinks = (p, maxLinks, maxFirstD, allowForced) => {
    const cand = seaNodes.map((n) => ({ n, d: haversine(p.lat, p.lon, n.lat, n.lon) })).sort((x, y) => x.d - y.d);
    const links = [];
    for (let i = 0; i < cand.length && links.length < maxLinks; i++) {
      const { n, d } = cand[i];
      if (links.length === 0 ? d > maxFirstD * 4 : d > Math.max(150000, 3 * links[0].d)) break;
      if (landSamples(world, p, n, HARBOR_SLACK_M) > 0) continue;
      links.push({ id: n.id, d });
    }
    if (links.length === 0 && allowForced && cand.length) {
      // Keep the point reachable: the nearest node with the fewest land samples (estuary / fjord harbours whose
      // straight approach clips a bank in the raster). The traffic layer verifies legs itself.
      let best = null;
      for (let i = 0; i < Math.min(6, cand.length); i++) {
        const bad = landSamples(world, p, cand[i].n, HARBOR_SLACK_M);
        if (!best || bad < best.bad) best = { id: cand[i].n.id, d: cand[i].d, bad };
      }
      links.push(best);
    }
    return links;
  };
  // River chains: link both ends to the sea lanes (the inland end usually finds nothing, which is fine).
  for (const id of RIVER_ENDS) {
    const n = nodes.get(id);
    for (const l of nearestLinks(n, 2, 80000, false)) link(id, l.id, l.d, false);
  }
  // Harbour links: nearest 1–3 reachable lane nodes (river nodes included via a second pass).
  const harborLinks = new Map();
  let forced = 0;
  const riverNodes = LANE_NODES.filter((n) => n.kind === 'river');
  for (const h of harbors) {
    const hn = { id: h.id, name: h.name, lat: h.lat, lon: h.lon, kind: 'harbor' };
    nodes.set(h.id, hn);
    const links = [];
    // River harbours link to the nearest river node(s) first.
    const rc = riverNodes.map((n) => ({ n, d: haversine(h.lat, h.lon, n.lat, n.lon) })).filter((x) => x.d < 25000).sort((x, y) => x.d - y.d);
    for (const { n, d } of rc.slice(0, 2)) if (landSamples(world, h, n, HARBOR_SLACK_M) === 0) links.push({ id: n.id, d });
    const maxFirstD = inDetailRegion(h.lat, h.lon) ? 250000 : 1500000;
    for (const l of nearestLinks(h, 3 - links.length, maxFirstD, links.length === 0)) {
      if (l.bad !== undefined) { forced++; log(`[lanes] harbour ${h.id}: no clean link, forced ${l.id} (${l.bad} land samples)`); }
      links.push(l);
    }
    for (const l of links) link(h.id, l.id, l.d, false);
    harborLinks.set(h.id, links.map((l) => l.id));
  }
  log(`[lanes] graph: ${nodes.size} nodes, ${kept} edges kept, ${dropped} dropped for crossing land, ${harbors.length} harbours linked (${forced} forced)`);

  const cache = new Map();
  const trees = new Map();
  function dijkstra(from) {
    const dist = new Map([[from, 0]]), prev = new Map(), done = new Set();
    // Small graph (~350 nodes): a linear scan for the minimum is simpler than a heap and still cheap.
    const open = new Map([[from, 0]]);
    while (open.size) {
      let u = null, best = Infinity;
      for (const [k, d] of open) if (d < best) { best = d; u = k; }
      open.delete(u); done.add(u);
      for (const e of adj.get(u) || []) {
        if (done.has(e.to)) continue;
        // Routing through another harbour is allowed but penalised so lanes are preferred to port-hopping.
        const penalty = nodes.get(e.to).kind === 'harbor' ? 60000 : 0;
        const nd = best + e.w + penalty;
        if (nd < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, nd); prev.set(e.to, u); open.set(e.to, nd); }
      }
    }
    return { dist, prev };
  }
  const isCanal = (a, b) => { const e = (adj.get(a) || []).find((x) => x.to === b); return !!(e && e.canal); };
  function route(fromId, toId) {
    if (!nodes.has(fromId) || !nodes.has(toId)) return null;
    if (fromId === toId) return [[nodes.get(fromId).lat, nodes.get(fromId).lon]];
    const key = fromId + '>' + toId;
    if (cache.has(key)) return cache.get(key);
    if (!trees.has(fromId)) trees.set(fromId, dijkstra(fromId));
    const { dist, prev } = trees.get(fromId);
    if (!dist.has(toId)) { cache.set(key, null); return null; }
    const ids = [];
    for (let u = toId; u !== undefined; u = prev.get(u)) ids.push(u);
    ids.reverse();
    const pts = [];
    for (let i = 0; i < ids.length; i++) {
      const n = nodes.get(ids[i]);
      if (i > 0 && !isCanal(ids[i - 1], ids[i])) {
        const p = nodes.get(ids[i - 1]);
        const parts = Math.ceil(haversine(p.lat, p.lon, n.lat, n.lon) / SUBDIVIDE_M);
        for (let k = 1; k < parts; k++) { const q = lerpLL(p, n, k / parts); pts.push([q.lat, q.lon]); }
      }
      // A third element 1 marks "the leg that STARTS here is a canal" (no water check for that leg).
      const canalNext = i + 1 < ids.length && isCanal(ids[i], ids[i + 1]);
      pts.push(canalNext ? [n.lat, n.lon, 1] : [n.lat, n.lon]);
    }
    cache.set(key, pts);
    return pts;
  }
  return { nodes, adj, harborLinks, dropped, route };
}
