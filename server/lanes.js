// Sea-lane graph for AI traffic and the chart (docs/V3-CONTRACTS.md §2).
//
// LANE_NODES: hand-placed waypoints — traffic separation schemes, approaches and offshore junctions in the North
// Sea / Channel / Skagerrak / Irish Sea detail region, a coarser set of ocean nodes for the global layer, and the
// navigable river channels from server/harbors.js (CHANNELS) as node chains so river harbours (Hamburg, Antwerp,
// Tilbury, Hull, Oslo…) are reached along the carved water and not across the bank.
// LANE_EDGES: straight edges between node ids. `canal: true` marks a man-made canal (Suez, Panama) whose straight
// line obviously crosses the raster's land; those edges skip the water check and route points on them carry a
// third element `1` so a consumer can treat the leg as "no water check" (traffic.js does).
//
// buildGraph(world) links every harbour to its nearest 1–3 reachable lane nodes, verifies every edge against
// world.isWater at 2 km steps (dropping and counting edges that cross land; harbour links may touch land in their
// first/last 3 km because harbour points sit in estuaries) and returns Dijkstra routing between harbour ids.
import { HARBORS, CHANNELS } from './harbors.js';
import { haversine } from '../shared/geo.js';

const N = (id, name, lat, lon, kind = 'waypoint') => ({ id, name, lat, lon, kind });

// ---- Detail region (North Sea, Channel, Skagerrak/Kattegat, Irish Sea, Scottish waters) ----
const REGION_NODES = [
  // Western approaches and the Channel
  N('ushant', 'Ushant TSS', 48.75, -5.55, 'tss'),
  N('brest_appr', 'Brest approach (Iroise)', 48.33, -4.85),
  N('lizard', 'Off the Lizard', 49.72, -5.15),
  N('landsend', 'Off Land\'s End', 49.95, -5.95),
  N('channel_w', 'Western Channel', 49.45, -4.00),
  N('plymouth_appr', 'Plymouth Sound approach', 50.27, -4.15),
  N('start_pt', 'Off Start Point', 50.10, -3.60),
  N('casquets', 'Casquets TSS', 49.90, -2.60, 'tss'),
  N('cherbourg_appr', 'Cherbourg approach', 49.74, -1.62),
  N('portland', 'Off Portland Bill', 50.45, -2.45),
  N('channel_mid', 'Mid-Channel', 50.15, -1.20),
  N('solent_appr', 'Nab Tower / Solent approach', 50.62, -0.95),
  N('le_havre_appr', 'Baie de Seine', 49.50, -0.10),
  N('beachy', 'Off Beachy Head', 50.60, 0.30),
  N('dieppe', 'Off Dieppe', 50.00, 1.00),
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
  N('german_bight_w', 'German Bight western approach', 54.05, 6.35, 'tss'),
  N('german_bight', 'German Bight TSS', 54.10, 7.60, 'tss'),
  N('helgoland', 'Off Helgoland', 54.20, 7.95),
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
  N('tees', 'Off the Tees', 54.70, -0.90),
  N('tyne_appr', 'Tyne approach', 55.02, -1.20),
  N('farne', 'Off the Farne Islands', 55.65, -1.40),
  N('forth_appr', 'Firth of Forth approach', 56.10, -2.40),
  N('aberdeen_appr', 'Aberdeen approach', 57.12, -1.85),
  N('rattray', 'Off Rattray Head', 57.62, -1.55),
  N('moray_appr', 'Moray Firth', 57.70, -3.60),
  N('pentland_e', 'Pentland Firth east', 58.72, -2.75),
  N('pentland_w', 'Pentland Firth west', 58.72, -3.45),
  N('kirkwall_appr', 'Kirkwall approach', 59.10, -2.80),
  N('fair_isle', 'Fair Isle channel', 59.60, -1.60),
  N('lerwick_appr', 'Lerwick approach', 60.10, -0.90),
  N('north_scotland', 'Off Cape Wrath', 58.75, -5.10),
  // Offshore North Sea
  N('ekofisk_lane', 'Central North Sea', 56.50, 3.50),
  N('forties_lane', 'Forties', 57.80, 1.00),
  N('viking_lane', 'Northern North Sea', 60.60, 2.00),
  N('sylt_w', 'Off Sylt', 55.30, 7.70),
  N('horns_rev', 'Horns Rev / Esbjerg approach', 55.55, 7.80),
  N('hanstholm', 'Off Hanstholm', 57.25, 8.20),
  // Skagerrak, Kattegat, Norwegian coast
  N('lindesnes', 'Off Lindesnes', 57.85, 7.00),
  N('kristiansand_appr', 'Kristiansand approach', 57.95, 8.00),
  N('skagerrak_mid', 'Skagerrak', 58.10, 9.20),
  N('skagen', 'Skagen', 57.85, 10.80),
  N('kattegat_n', 'Kattegat north', 57.30, 11.20),
  N('kattegat_s', 'Kattegat south (Anholt)', 56.60, 11.90),
  N('oresund_n', 'Øresund north', 56.12, 12.45),
  N('great_belt', 'Great Belt', 55.60, 10.85),
  N('fehmarn', 'Fehmarn Belt', 54.60, 11.10),
  N('kiel_appr', 'Kiel Bight', 54.55, 10.30),
  N('faerder', 'Færder / Oslofjord approach', 58.95, 10.50),
  N('stavanger_appr', 'Stavanger approach', 58.90, 5.45),
  N('utsira', 'Off Utsira', 59.30, 4.60),
  N('bergen_appr', 'Marstein / Bergen approach', 60.28, 4.85),
  // Irish Sea and the Celtic Sea
  N('stgeorges', 'St George\'s Channel', 51.95, -6.20),
  N('irish_sea_mid', 'Irish Sea', 53.30, -5.20),
  N('dublin_appr', 'Dublin Bay approach', 53.37, -5.95),
  N('holyhead', 'Off Anglesey', 53.45, -4.80),
  N('liverpool_bay', 'Liverpool Bay', 53.55, -3.60),
  N('north_channel', 'North Channel', 54.80, -5.40),
  N('fastnet', 'Fastnet', 51.30, -9.80),
];

// ---- Global ocean nodes (coarse layer) ----
const GLOBAL_NODES = [
  N('biscay', 'Bay of Biscay', 46.00, -6.00, 'ocean'),
  N('finisterre', 'Cape Finisterre TSS', 43.20, -9.80, 'ocean'),
  N('lisbon_appr', 'Lisbon approach', 38.60, -9.60, 'ocean'),
  N('st_vincent', 'Cape St Vincent', 36.80, -9.40, 'ocean'),
  N('gibraltar_strait', 'Strait of Gibraltar', 35.95, -5.60, 'ocean'),
  N('canaries', 'Canary Islands', 28.50, -14.50, 'ocean'),
  N('cape_verde', 'Cape Verde', 16.00, -23.50, 'ocean'),
  N('dakar_appr', 'Dakar approach', 14.70, -17.70, 'ocean'),
  N('gulf_guinea', 'Gulf of Guinea', 1.00, -2.00, 'ocean'),
  N('atlantic_s', 'South Atlantic', -15.00, -10.00, 'ocean'),
  N('cape_agulhas', 'Cape Agulhas', -35.50, 19.50, 'ocean'),
  N('cape_town_appr', 'Table Bay approach', -33.85, 18.20, 'ocean'),
  N('moz_channel', 'Mozambique Channel', -22.00, 40.50, 'ocean'),
  N('mombasa_appr', 'Mombasa approach', -4.20, 40.10, 'ocean'),
  N('arabian_sea', 'Arabian Sea', 14.00, 62.00, 'ocean'),
  N('gulf_aden', 'Gulf of Aden', 12.80, 47.50, 'ocean'),
  N('bab_el_mandeb', 'Bab-el-Mandeb', 12.60, 43.40, 'ocean'),
  N('red_sea_s', 'Southern Red Sea', 15.80, 41.20, 'ocean'),
  N('red_sea_n', 'Northern Red Sea', 25.50, 35.50, 'ocean'),
  N('suez_gulf', 'Gulf of Suez', 28.40, 33.20, 'ocean'),
  N('suez_s', 'Suez (south end of the canal)', 29.90, 32.55, 'ocean'),
  N('port_said', 'Port Said (Suez approach)', 31.45, 32.30, 'ocean'),
  N('med_e', 'Eastern Mediterranean', 33.50, 28.50, 'ocean'),
  N('alexandria_appr', 'Alexandria approach', 31.35, 29.80, 'ocean'),
  N('ionian', 'Ionian Sea', 36.50, 20.50, 'ocean'),
  N('piraeus_appr', 'Saronic Gulf', 37.75, 23.55, 'ocean'),
  N('aegean_n', 'Northern Aegean', 39.80, 25.30, 'ocean'),
  N('dardanelles', 'Dardanelles', 40.10, 26.30, 'ocean'),
  N('marmara', 'Sea of Marmara', 40.75, 28.30, 'ocean'),
  N('malta', 'Malta channel', 36.00, 15.00, 'ocean'),
  N('tyrrhenian', 'Tyrrhenian Sea', 40.50, 11.50, 'ocean'),
  N('ligurian', 'Ligurian Sea', 43.80, 8.80, 'ocean'),
  N('lion', 'Gulf of Lion', 42.80, 4.90, 'ocean'),
  N('med_w', 'Western Mediterranean', 38.50, 1.50, 'ocean'),
  N('alboran', 'Alborán Sea', 36.20, -3.00, 'ocean'),
  N('hormuz', 'Strait of Hormuz', 26.30, 56.60, 'ocean'),
  N('gulf_s', 'Southern Persian Gulf', 25.60, 55.00, 'ocean'),
  N('mumbai_appr', 'Mumbai approach', 18.80, 72.30, 'ocean'),
  N('colombo_appr', 'Colombo approach', 6.90, 79.40, 'ocean'),
  N('malacca_n', 'Malacca Strait north', 6.00, 96.50, 'ocean'),
  N('malacca_s', 'Malacca Strait south', 2.60, 101.00, 'ocean'),
  N('singapore_strait', 'Singapore Strait', 1.15, 103.70, 'ocean'),
  N('sunda', 'Sunda Strait approach', -6.00, 105.70, 'ocean'),
  N('java_sea', 'Java Sea', -5.60, 107.30, 'ocean'),
  N('scs_s', 'South China Sea south', 5.00, 107.00, 'ocean'),
  N('scs_mid', 'South China Sea', 12.00, 112.50, 'ocean'),
  N('hk_appr', 'Hong Kong approach', 21.90, 114.20, 'ocean'),
  N('manila_appr', 'Manila Bay approach', 14.45, 120.50, 'ocean'),
  N('luzon_strait', 'Luzon Strait', 20.80, 121.00, 'ocean'),
  N('east_china_sea', 'East China Sea', 27.50, 125.00, 'ocean'),
  N('shanghai_appr', 'Yangtze approach', 30.40, 122.90, 'ocean'),
  N('busan_appr', 'Busan approach', 34.90, 129.30, 'ocean'),
  N('kii', 'Off the Kii peninsula', 33.20, 135.80, 'ocean'),
  N('tokyo_appr', 'Tokyo Bay approach', 34.90, 139.80, 'ocean'),
  N('pacific_nw', 'North-west Pacific', 32.00, 145.00, 'ocean'),
  N('pacific_mid', 'Mid-Pacific', 30.00, 175.00, 'ocean'),
  N('honolulu_appr', 'Honolulu approach', 21.20, -158.00, 'ocean'),
  N('pacific_e', 'North-east Pacific', 33.00, -125.00, 'ocean'),
  N('la_appr', 'San Pedro Bay', 33.60, -118.40, 'ocean'),
  N('juan_de_fuca', 'Juan de Fuca approach', 48.45, -125.00, 'ocean'),
  N('georgia_strait', 'Strait of Georgia', 48.85, -123.25, 'ocean'),
  N('pacific_se', 'South-east Pacific', -20.00, -80.00, 'ocean'),
  N('valparaiso_appr', 'Valparaíso approach', -33.00, -71.95, 'ocean'),
  N('cape_horn', 'Cape Horn', -56.50, -67.00, 'ocean'),
  N('panama_pac', 'Gulf of Panama', 8.40, -79.40, 'ocean'),
  N('colon_appr', 'Colón approach', 9.60, -79.85, 'ocean'),
  N('caribbean_w', 'Western Caribbean', 13.00, -78.00, 'ocean'),
  N('yucatan', 'Yucatán Channel', 21.80, -85.50, 'ocean'),
  N('gulf_mexico', 'Gulf of Mexico', 27.00, -90.00, 'ocean'),
  N('galveston_appr', 'Galveston approach', 29.00, -94.50, 'ocean'),
  N('florida_strait', 'Straits of Florida', 24.30, -80.70, 'ocean'),
  N('hatteras', 'Off Cape Hatteras', 34.50, -74.50, 'ocean'),
  N('nyc_appr', 'Ambrose / New York approach', 40.40, -73.70, 'ocean'),
  N('halifax_appr', 'Halifax approach', 44.40, -63.30, 'ocean'),
  N('grand_banks_s', 'Grand Banks', 43.00, -52.00, 'ocean'),
  N('atlantic_n', 'North Atlantic', 48.00, -25.00, 'ocean'),
  N('atlantic_mid', 'Mid-Atlantic', 10.00, -35.00, 'ocean'),
  N('rio_appr', 'Rio de Janeiro approach', -23.20, -43.10, 'ocean'),
  N('santos_appr', 'Santos approach', -24.30, -46.20, 'ocean'),
  N('rio_plata', 'Río de la Plata', -35.60, -55.50, 'ocean'),
  N('iceland_s', 'South of Iceland', 63.40, -22.80, 'ocean'),
  N('faroe', 'Faroe Bank', 61.30, -6.80, 'ocean'),
  N('norway_n', 'Norwegian Sea', 65.00, 7.00, 'ocean'),
  N('north_cape', 'North Cape', 71.60, 26.00, 'ocean'),
  N('murmansk_appr', 'Kola Inlet approach', 69.50, 33.40, 'ocean'),
  N('bornholm', 'Off Bornholm', 55.20, 15.00, 'ocean'),
  N('gdansk_appr', 'Gulf of Gdańsk', 54.70, 18.90, 'ocean'),
  N('baltic_c', 'Central Baltic', 57.50, 19.50, 'ocean'),
  N('stockholm_appr', 'Stockholm archipelago approach', 59.30, 19.20, 'ocean'),
  N('gulf_finland', 'Gulf of Finland', 59.80, 24.00, 'ocean'),
  N('helsinki_appr', 'Helsinki approach', 60.05, 25.00, 'ocean'),
  N('petersburg_appr', 'Eastern Gulf of Finland', 60.00, 28.60, 'ocean'),
  N('indian_ocean_e', 'Eastern Indian Ocean', -15.00, 105.00, 'ocean'),
  N('leeuwin', 'Cape Leeuwin', -35.50, 114.50, 'ocean'),
  N('great_bight', 'Great Australian Bight', -37.00, 135.00, 'ocean'),
  N('bass_strait', 'Bass Strait', -39.80, 146.50, 'ocean'),
  N('tasman', 'Tasman Sea', -34.50, 152.50, 'ocean'),
  N('tasman_mid', 'Mid-Tasman', -37.00, 165.00, 'ocean'),
  N('hauraki', 'Hauraki Gulf', -36.30, 175.20, 'ocean'),
];

// Navigable river channels (carved water in the raster) as node chains, seaward end first.
const RIVER_NODES = [];
const RIVER_EDGES = [];
for (const ch of CHANNELS) {
  let prev = null;
  ch.pts.forEach((p, i) => {
    const id = `${ch.id}_${i}`;
    RIVER_NODES.push(N(id, `${ch.id} channel ${i}`, p[0], p[1], 'river'));
    if (prev) RIVER_EDGES.push([prev, id]);
    prev = id;
  });
}

export const LANE_NODES = [...REGION_NODES, ...GLOBAL_NODES, ...RIVER_NODES];

const E = (a, b, extra) => (extra ? [a, b, extra] : [a, b]);
export const LANE_EDGES = [
  // Channel spine
  E('ushant', 'brest_appr'), E('ushant', 'channel_w'), E('ushant', 'lizard'), E('ushant', 'biscay'), E('ushant', 'fastnet'),
  E('lizard', 'landsend'), E('lizard', 'channel_w'), E('landsend', 'stgeorges'), E('landsend', 'fastnet'), E('landsend', 'atlantic_n'),
  E('channel_w', 'plymouth_appr'), E('channel_w', 'casquets'), E('channel_w', 'start_pt'), E('plymouth_appr', 'start_pt'),
  E('start_pt', 'portland'), E('start_pt', 'casquets'), E('casquets', 'cherbourg_appr'), E('casquets', 'channel_mid'), E('casquets', 'portland'),
  E('portland', 'channel_mid'), E('channel_mid', 'solent_appr'), E('channel_mid', 'le_havre_appr'), E('channel_mid', 'cherbourg_appr'),
  E('cherbourg_appr', 'le_havre_appr'), E('solent_appr', 'beachy'), E('le_havre_appr', 'dieppe'), E('le_havre_appr', 'beachy'),
  E('beachy', 'channel_e'), E('dieppe', 'channel_e'), E('beachy', 'dieppe'),
  E('channel_e', 'dover_tss_ne'), E('channel_e', 'dover_tss_sw'), E('dover_tss_ne', 'dover_ne_out'), E('dover_tss_sw', 'dover_ne_out'),
  E('dover_tss_ne', 'dover_tss_sw'),
  // Southern North Sea
  E('dover_ne_out', 'sandettie'), E('dover_ne_out', 'thames_appr'), E('dover_ne_out', 'sunk'), E('sandettie', 'westhinder'), E('sandettie', 'noord_hinder'),
  E('westhinder', 'scheldt_appr'), E('westhinder', 'noord_hinder'), E('scheldt_appr', 'noord_hinder'), E('scheldt_appr', 'maas_appr'),
  E('noord_hinder', 'maas_appr'), E('noord_hinder', 'sunk'), E('noord_hinder', 'smiths_knoll'), E('noord_hinder', 'texel'), E('noord_hinder', 'dogger_s'),
  E('maas_appr', 'ijmuiden_appr'), E('maas_appr', 'texel'), E('ijmuiden_appr', 'texel'), E('texel', 'terschelling'), E('texel', 'dogger_s'),
  E('terschelling', 'german_bight_w'), E('terschelling', 'dogger_s'), E('german_bight_w', 'german_bight'), E('german_bight_w', 'dogger_s'), E('german_bight_w', 'sylt_w'),
  E('german_bight', 'helgoland'), E('german_bight', 'elbe_appr'), E('german_bight', 'jade_appr'), E('german_bight', 'sylt_w'), E('helgoland', 'elbe_appr'), E('helgoland', 'sylt_w'),
  E('elbe_appr', 'jade_appr'),
  E('thames_appr', 'sunk'), E('sunk', 'smiths_knoll'), E('smiths_knoll', 'cromer'), E('cromer', 'humber_appr'), E('cromer', 'dogger_s'),
  E('humber_appr', 'flamborough'), E('humber_appr', 'dogger_s'), E('dogger_s', 'ekofisk_lane'), E('dogger_s', 'flamborough'), E('dogger_s', 'tees'),
  // East coast of Britain
  E('flamborough', 'tees'), E('tees', 'tyne_appr'), E('tyne_appr', 'farne'), E('farne', 'forth_appr'), E('forth_appr', 'aberdeen_appr'),
  E('aberdeen_appr', 'rattray'), E('rattray', 'moray_appr'), E('rattray', 'pentland_e'), E('rattray', 'forties_lane'), E('moray_appr', 'pentland_e'),
  E('pentland_e', 'pentland_w'), E('pentland_w', 'north_scotland'), E('pentland_e', 'kirkwall_appr'), E('pentland_e', 'fair_isle'),
  E('kirkwall_appr', 'fair_isle'), E('fair_isle', 'lerwick_appr'), E('fair_isle', 'viking_lane'), E('lerwick_appr', 'viking_lane'),
  E('north_scotland', 'faroe'), E('north_scotland', 'north_channel'), E('fair_isle', 'faroe'),
  // Offshore North Sea crossings
  E('ekofisk_lane', 'forties_lane'), E('ekofisk_lane', 'lindesnes'), E('ekofisk_lane', 'hanstholm'), E('ekofisk_lane', 'horns_rev'), E('ekofisk_lane', 'texel'),
  E('ekofisk_lane', 'terschelling'), E('forties_lane', 'viking_lane'), E('forties_lane', 'utsira'), E('forties_lane', 'stavanger_appr'),
  E('viking_lane', 'bergen_appr'), E('viking_lane', 'utsira'), E('viking_lane', 'norway_n'), E('viking_lane', 'faroe'),
  E('sylt_w', 'horns_rev'), E('horns_rev', 'hanstholm'), E('hanstholm', 'lindesnes'), E('hanstholm', 'skagerrak_mid'), E('hanstholm', 'skagen'),
  // Skagerrak, Kattegat, Baltic approaches, Norwegian coast
  E('lindesnes', 'kristiansand_appr'), E('lindesnes', 'stavanger_appr'), E('kristiansand_appr', 'skagerrak_mid'), E('skagerrak_mid', 'skagen'),
  E('skagerrak_mid', 'faerder'), E('skagen', 'faerder'), E('skagen', 'kattegat_n'), E('kattegat_n', 'kattegat_s'), E('kattegat_s', 'oresund_n'),
  E('kattegat_s', 'great_belt'), E('great_belt', 'fehmarn'), E('fehmarn', 'kiel_appr'), E('fehmarn', 'bornholm'), E('kiel_appr', 'bornholm'),
  E('stavanger_appr', 'utsira'), E('utsira', 'bergen_appr'), E('bergen_appr', 'norway_n'),
  // Irish Sea
  E('stgeorges', 'irish_sea_mid'), E('stgeorges', 'fastnet'), E('irish_sea_mid', 'dublin_appr'), E('irish_sea_mid', 'holyhead'),
  E('holyhead', 'liverpool_bay'), E('irish_sea_mid', 'north_channel'), E('dublin_appr', 'north_channel'), E('liverpool_bay', 'north_channel'),
  E('north_channel', 'faroe'), E('fastnet', 'atlantic_n'), E('fastnet', 'biscay'),
  // Atlantic Europe and the Mediterranean
  E('biscay', 'finisterre'), E('biscay', 'atlantic_n'), E('finisterre', 'lisbon_appr'), E('finisterre', 'atlantic_n'), E('lisbon_appr', 'st_vincent'),
  E('st_vincent', 'gibraltar_strait'), E('st_vincent', 'canaries'), E('gibraltar_strait', 'alboran'), E('alboran', 'med_w'), E('med_w', 'lion'),
  E('med_w', 'tyrrhenian'), E('lion', 'ligurian'), E('ligurian', 'tyrrhenian'), E('tyrrhenian', 'malta'), E('med_w', 'malta'), E('malta', 'ionian'),
  E('malta', 'med_e'), E('ionian', 'piraeus_appr'), E('ionian', 'aegean_n'), E('piraeus_appr', 'aegean_n'), E('aegean_n', 'dardanelles'),
  E('dardanelles', 'marmara'), E('ionian', 'med_e'), E('med_e', 'alexandria_appr'), E('med_e', 'port_said'), E('alexandria_appr', 'port_said'),
  E('port_said', 'suez_s', { canal: true }), E('suez_s', 'suez_gulf'), E('suez_gulf', 'red_sea_n'), E('red_sea_n', 'red_sea_s'), E('red_sea_s', 'bab_el_mandeb'),
  E('bab_el_mandeb', 'gulf_aden'), E('gulf_aden', 'arabian_sea'), E('arabian_sea', 'hormuz'), E('hormuz', 'gulf_s'), E('arabian_sea', 'mumbai_appr'),
  E('arabian_sea', 'colombo_appr'), E('mumbai_appr', 'colombo_appr'), E('arabian_sea', 'mombasa_appr'), E('colombo_appr', 'malacca_n'),
  // Africa and the South Atlantic
  E('canaries', 'cape_verde'), E('canaries', 'dakar_appr'), E('cape_verde', 'dakar_appr'), E('cape_verde', 'gulf_guinea'), E('cape_verde', 'atlantic_mid'),
  E('gulf_guinea', 'atlantic_s'), E('atlantic_s', 'cape_agulhas'), E('atlantic_s', 'rio_appr'), E('atlantic_s', 'atlantic_mid'), E('cape_agulhas', 'cape_town_appr'),
  E('cape_agulhas', 'moz_channel'), E('moz_channel', 'mombasa_appr'), E('mombasa_appr', 'colombo_appr'), E('cape_agulhas', 'leeuwin'),
  E('cape_agulhas', 'indian_ocean_e'), E('moz_channel', 'indian_ocean_e'),
  // Asia and Australia
  E('malacca_n', 'malacca_s'), E('malacca_s', 'singapore_strait'), E('singapore_strait', 'scs_s'), E('singapore_strait', 'java_sea'),
  E('java_sea', 'sunda'), E('sunda', 'indian_ocean_e'), E('indian_ocean_e', 'leeuwin'), E('leeuwin', 'great_bight'), E('great_bight', 'bass_strait'),
  E('bass_strait', 'tasman'), E('tasman', 'tasman_mid'), E('tasman_mid', 'hauraki'), E('scs_s', 'scs_mid'), E('scs_mid', 'hk_appr'), E('scs_mid', 'manila_appr'),
  E('scs_mid', 'luzon_strait'), E('hk_appr', 'luzon_strait'), E('luzon_strait', 'east_china_sea'), E('east_china_sea', 'shanghai_appr'),
  E('east_china_sea', 'busan_appr'), E('east_china_sea', 'kii'), E('busan_appr', 'kii'), E('kii', 'tokyo_appr'), E('kii', 'pacific_nw'),
  E('tokyo_appr', 'pacific_nw'), E('pacific_nw', 'pacific_mid'), E('pacific_mid', 'honolulu_appr'), E('pacific_mid', 'pacific_e'),
  E('honolulu_appr', 'pacific_e'), E('honolulu_appr', 'tasman_mid'), E('pacific_e', 'la_appr'), E('pacific_e', 'juan_de_fuca'), E('juan_de_fuca', 'georgia_strait'),
  E('pacific_e', 'panama_pac'), E('panama_pac', 'pacific_se'), E('pacific_se', 'valparaiso_appr'), E('valparaiso_appr', 'cape_horn'),
  E('panama_pac', 'colon_appr', { canal: true }), E('honolulu_appr', 'panama_pac'),
  // Americas
  E('cape_horn', 'rio_plata'), E('rio_plata', 'santos_appr'), E('santos_appr', 'rio_appr'), E('rio_appr', 'atlantic_mid'), E('atlantic_mid', 'caribbean_w'),
  E('atlantic_mid', 'hatteras'), E('caribbean_w', 'colon_appr'), E('caribbean_w', 'yucatan'), E('caribbean_w', 'florida_strait'), E('yucatan', 'gulf_mexico'),
  E('gulf_mexico', 'galveston_appr'), E('gulf_mexico', 'florida_strait'), E('florida_strait', 'hatteras'), E('hatteras', 'nyc_appr'), E('nyc_appr', 'halifax_appr'),
  E('nyc_appr', 'atlantic_n'), E('halifax_appr', 'grand_banks_s'), E('grand_banks_s', 'atlantic_n'), E('atlantic_n', 'iceland_s'), E('iceland_s', 'faroe'),
  E('atlantic_mid', 'gulf_guinea'),
  // Far north and the Baltic
  E('norway_n', 'north_cape'), E('north_cape', 'murmansk_appr'), E('faroe', 'norway_n'),
  E('bornholm', 'gdansk_appr'), E('bornholm', 'baltic_c'), E('gdansk_appr', 'baltic_c'), E('baltic_c', 'stockholm_appr'), E('baltic_c', 'gulf_finland'),
  E('stockholm_appr', 'gulf_finland'), E('gulf_finland', 'helsinki_appr'), E('gulf_finland', 'petersburg_appr'), E('helsinki_appr', 'petersburg_appr'),
  // River channels
  ...RIVER_EDGES,
];

const REGION_BOX = { latMin: 48, latMax: 62.5, lonMin: -8, lonMax: 14 };
export function inDetailRegion(lat, lon) { return lat >= REGION_BOX.latMin && lat < REGION_BOX.latMax && lon >= REGION_BOX.lonMin && lon < REGION_BOX.lonMax; }

const STEP_M = 2000;
const HARBOR_SLACK_M = 3000;
const SUBDIVIDE_M = 250000; // long legs are split so a ship homing on waypoints follows the validated straight line

// Samples the straight lat/lon line a→b every STEP_M; returns the number of land samples outside the slack
// distance from either end (slack only applies to harbour links).
function landSamples(world, a, b, slackM) {
  const len = haversine(a.lat, a.lon, b.lat, b.lon);
  const n = Math.max(1, Math.ceil(len / STEP_M));
  let bad = 0;
  for (let k = 0; k <= n; k++) {
    const t = k / n, d = t * len;
    if (slackM > 0 && (d < slackM || len - d < slackM)) continue;
    const lat = a.lat + (b.lat - a.lat) * t, lon = a.lon + (b.lon - a.lon) * t;
    if (!world.isWater(lat, lon)) bad++;
  }
  return bad;
}

/**
 * Builds the routing graph against the world raster.
 * @returns {{nodes: Map, adj: Map, harborLinks: Map, dropped: number, route(fromHarborId, toHarborId): ([number,number]|[number,number,1])[]|null}}
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
  // Harbour links: nearest 1–3 reachable lane nodes (candidates by distance; the first/last 3 km may touch land).
  const harborLinks = new Map();
  let forced = 0;
  const laneNodes = [...nodes.values()];
  for (const h of harbors) {
    const hn = { id: h.id, name: h.name, lat: h.lat, lon: h.lon, kind: 'harbor' };
    nodes.set(h.id, hn);
    const cand = laneNodes.map((n) => ({ n, d: haversine(h.lat, h.lon, n.lat, n.lon) })).sort((p, q) => p.d - q.d);
    const links = [];
    const maxD = inDetailRegion(h.lat, h.lon) ? 250000 : 1500000;
    for (let i = 0; i < cand.length && links.length < 3; i++) {
      const { n, d } = cand[i];
      if (d > maxD && links.length > 0) break;
      if (d > maxD * 4) break;
      if (landSamples(world, h, n, HARBOR_SLACK_M) > 0) continue;
      links.push(n.id); link(h.id, n.id, d, false);
    }
    if (links.length === 0 && cand.length) {
      // Keep the harbour reachable: use the nearest node with the fewest land samples (estuary / fjord harbours
      // whose straight approach clips a bank in the raster). The traffic layer verifies legs itself.
      let best = null;
      for (let i = 0; i < Math.min(6, cand.length); i++) {
        const bad = landSamples(world, h, cand[i].n, HARBOR_SLACK_M);
        if (!best || bad < best.bad) best = { ...cand[i], bad };
      }
      links.push(best.n.id); link(h.id, best.n.id, best.d, false); forced++;
      log(`[lanes] harbour ${h.id}: no clean link, forced ${best.n.id} (${best.bad} land samples)`);
    }
    harborLinks.set(h.id, links);
  }
  log(`[lanes] graph: ${nodes.size} nodes, ${kept} edges kept, ${dropped} dropped for crossing land, ${harbors.length} harbours linked (${forced} forced)`);

  const cache = new Map();
  function dijkstra(from) {
    const dist = new Map([[from, 0]]), prev = new Map(), done = new Set();
    // Small graph (~250 nodes): a linear scan for the minimum is simpler than a heap and still µs-cheap.
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
  const trees = new Map();
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
    const isCanal = (a, b) => { const e = (adj.get(a) || []).find((x) => x.to === b); return !!(e && e.canal); };
    const pts = [];
    for (let i = 0; i < ids.length; i++) {
      const n = nodes.get(ids[i]);
      if (i > 0 && !isCanal(ids[i - 1], ids[i])) {
        const p = nodes.get(ids[i - 1]);
        const len = haversine(p.lat, p.lon, n.lat, n.lon);
        const parts = Math.ceil(len / SUBDIVIDE_M);
        for (let k = 1; k < parts; k++) { const t = k / parts; pts.push([p.lat + (n.lat - p.lat) * t, p.lon + (n.lon - p.lon) * t]); }
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
