// Ship catalogue (docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §2, Appendix A): 16 types, 76 models. Pure data + the §2.4
// derivation of the game fields. Plain ESM; imports only optrules.js, so shared/constants.js may import it (H1) without a cycle.
//
// Every model carries two blocks:
//  * real-world reference (shown on the spec sheet): LOA, beam, draught, depth, air draft, DWT, GT, engine, crew, ref. USD.
//    Typical figures for the class ("Source ≈", §13) — `verify: true` until the data lane clears the row.
//  * the game row in the SHIP_CLASSES shape, so every consumer of SHIP_CLASSES[cls] keeps working.
import { modelOptions } from './optrules.js';

// Legacy rows (ⓛ, the 17 ids of today) keep every game field EXACTLY as in shared/constants.js (test/ships-catalogue
// deep-equals them); new rows derive theirs from the reference with the §2.4 formulas (Game rule).

/** Market category per type (the `cat` field keeps its meaning). */
export const TYPE_CAT = {
  workboat: 'working', tug: 'working', pilot: 'working', fishing: 'working', offshore: 'working', special: 'working',
  general: 'cargo', container: 'cargo', bulk: 'cargo', tanker: 'cargo', gas: 'cargo', roro: 'cargo',
  ferry: 'passenger', cruise: 'passenger', motor_yacht: 'motor yacht', sail_yacht: 'sailing yacht',
};
export const TYPES = Object.keys(TYPE_CAT);

// §2.4 tuning (Game rule).
export const DERIVE = {
  CARGO_TYPE_MUL: { general: 1, container: 1.8, bulk: 1, tanker: 1.1, gas: 1.8, roro: 1.9 },
  CARGO_MODEL_MUL: { mpp160: 1.4, reefer150: 1.6, livestock135: 1.6, chem13k: 1.35, lng174k: 2.6 / 1.8, lngbv7500: 2.6 / 1.8 },
  TURN_MUL: { tug: 2.0, workboat: 1.6, offshore: 1.3 },
  FUEL_K: 0.616,              // 0.56 (burn at 80 % throttle) × 1.1 reserve
  CB_HULL: 0.97, RHO: 1.025,
};

// Real-world source rows. Columns:
// id, type, gen, reference name, short, size class, LOA, B, T, DWT, GT, capacity text, maxKn, svcKn, kW, engine label,
// sfoc g/kWh, crew min, crew opt, ref. newbuild USD m (≈ 2024–25), hull {Cb | disp | legacy}, range nm (Game rule), extra
// extra: cap (game payload t, non-cargo types), pax, bp (bollard pull t), fish (fishRate), lanes (lane m), bm (build months,
// Game rule [S6]), b (yard capability tag, §3.3), depth, ice, teu, plugs, ceu, m3, head, seg, holds, eq, hand, color, desc.
const SRC = [
  // ---------------------------------------------------------------- workboat
  ['ctv26', 'workboat', 'small_fast', 'Crew transfer catamaran 26 m', 'CTV', 'CTV', 26, 10.4, 1.7, 60, 150, '24 pax (industrial 12)', 27, 24, 2200, '2x HS diesel, waterjets', 215, 2, 3, 4.5, { disp: 110 }, 600,
    { pax: 12, cap: 15, bm: 6, b: 'workboat', depth: 3.6, eq: ['fender_bow'], hand: ['deck', 'pax'], color: 0xf2c500, desc: 'Wave-piercing catamaran that pushes her bow fender against a turbine so technicians can step across.' }],
  ['multicat27', 'workboat', 'tug', 'Multicat workboat 27 m', 'Multicat', 'BP 30 t', 27, 12.5, 2.6, 300, 350, 'BP 30 t, 150 t deck', 10.5, 9, 1600, '2x MS diesel, FP props', 210, 3, 5, 6.0, { Cb: 0.62 }, 2500,
    { bp: 30, cap: 150, pax: 4, bm: 6, b: 'workboat', depth: 3.6, eq: ['cranes:1x25', 'towWinch', 'anchorWinch'], hand: ['deck'], color: 0x2a5d9f, desc: 'Flat-decked jack of all trades: anchors, buoys, small tows and a crane on deck.' }],
  // ---------------------------------------------------------------- tug
  ['tug16', 'tug', 'tug', 'Line-handling pusher tug 16 m', 'Pusher tug', 'BP 14 t', 16, 6.4, 2.2, 20, 60, 'BP 14 t', 10, 9, 900, '2x HS diesel', 215, 2, 2, 1.8, { Cb: 0.5 }, 800,
    { bp: 14, cap: 10, pax: 2, bm: 5, b: 'tug', depth: 2.8, eq: ['towHook'], hand: [], color: 0x1b1b1b, desc: 'Small harbour pusher: line handling, barges and the odd small tow.' }],
  ['tug24', 'tug', 'tug', 'ASD harbour tug 24 m', 'ASD tug', 'BP 70 t', 24.5, 11.3, 5.0, 140, 250, 'BP 70 t', 12.5, 11, 4480, '2x MS diesel, azimuth', 205, 3, 4, 8.0, { Cb: 0.5 }, 2000,
    { bp: 70, cap: 30, pax: 4, bm: 7, b: 'tug', depth: 4.6, draftHull: 3.5, eq: ['towWinch', 'fifi'], hand: [], color: 0x1b1b1b, desc: 'Compact azimuth-stern-drive tug, the standard harbour assist tug of the world.' }],
  ['tug', 'tug', 'tug', 'ASD tug 32 m (legacy "Harbour tug")', 'Harbour tug', 'BP 80 t', 32, 11, 5, 200, 480, 'BP 80 t', 13, 11.5, 5300, '2x MS diesel, azimuth', 205, 4, 6, 10, { legacy: 1 }, 2500,
    { bp: 80, bm: 7, b: 'tug', depth: 5.2, draftHull: 4.1, eq: ['towWinch', 'fifi'], hand: [] }],
  ['oceantug60', 'tug', 'tug', 'Ocean towing & salvage tug 60 m', 'Ocean tug', 'BP 150 t', 60, 16.5, 6.2, 1500, 2100, 'BP 150 t', 16, 13, 10000, '2x MS diesel, CP props', 195, 10, 14, 35, { Cb: 0.6 }, 12000,
    { bp: 150, cap: 600, pax: 6, bm: 14, b: 'tug', depth: 7.8, eq: ['towWinch', 'sternRoller', 'fifi', 'salvage'], hand: ['deck'], color: 0xb01e1e, desc: 'Deep-sea towing and salvage: rigs, dead ships and casualties across oceans.' }],
  // ---------------------------------------------------------------- pilot
  ['pilot14', 'pilot', 'small_fast', 'Pilot boat 14 m', 'Pilot boat', 'Pilot', 14.5, 4.6, 1.3, 2, 30, '6 pax', 25, 22, 900, '2x HS diesel', 220, 2, 2, 1.2, { disp: 22 }, 250,
    { pax: 6, cap: 1, bm: 4, b: 'pilot', depth: 2.2, eq: ['pilotDeck'], hand: ['pax'], color: 0xe8a317, desc: 'Self-righting pilot launch that runs pilots out to ships in any weather.' }],
  ['pilot', 'pilot', 'small_fast', 'Pilot boat 18 m (legacy)', 'Pilot boat', 'Pilot', 18, 5.5, 1.8, 4, 50, '8 pax', 26, 22, 1300, '2x HS diesel', 220, 2, 3, 1.8, { legacy: 1 }, 300,
    { bm: 5, b: 'pilot', depth: 2.6, eq: ['pilotDeck'], hand: ['pax'] }],
  // ---------------------------------------------------------------- fishing
  ['inshore15', 'fishing', 'fishing', 'Inshore trawler / crabber 15 m', 'Inshore boat', 'Inshore', 15, 5.6, 2.3, 25, 45, 'hold 15 t', 9, 8, 300, '1x HS diesel', 215, 2, 3, 1.2, { Cb: 0.55 }, 1500,
    { fish: 1.0, cap: 15, pax: 2, bm: 5, b: 'fishing', depth: 2.9, eq: ['potHauler'], hand: ['fish'], color: 0x2f5d50, desc: 'Day boat for pots and a small trawl; home every evening.' }],
  ['beam40', 'fishing', 'fishing', 'Beam trawler 40 m', 'Beam trawler', 'Beam trawler', 42, 9, 4.0, 350, 450, 'hold 120 t', 12.5, 11, 1470, '1x MS diesel, CP prop', 205, 5, 7, 7.5, { Cb: 0.58 }, 5000,
    { fish: 2.5, cap: 120, pax: 2, bm: 10, b: 'fishing', depth: 4.9, eq: ['derricks:2'], hand: ['fish'], color: 0x6b3a2d, desc: 'Two beams swung out on derricks: the flatfish boat of the North Sea.' }],
  ['trawler', 'fishing', 'fishing', 'Stern trawler 45 m (legacy)', 'Stern trawler', 'Trawler', 45, 10, 4.2, 600, 1000, 'hold 300 t', 12, 11, 2200, '1x MS diesel', 205, 6, 10, 10, { legacy: 1 }, 6000,
    { bm: 12, b: 'fishing', depth: 5.3, eq: ['gantry', 'netDrum'], hand: ['fish'] }],
  ['longliner50', 'fishing', 'fishing', 'Autoline longliner 50 m', 'Longliner', 'Longliner', 50, 11.5, 5.5, 800, 1500, 'frozen 500 t', 13, 11, 2200, '1x MS diesel, DE aux', 200, 12, 20, 20, { Cb: 0.6 }, 9000,
    { fish: 1.6, cap: 500, pax: 2, bm: 14, b: 'fishing', depth: 6.9, eq: ['freezer', 'haulingPort'], hand: ['fish'], color: 0x3a4f7a, desc: 'Baits and sets miles of line automatically and freezes the catch at sea.' }],
  ['seiner75', 'fishing', 'fishing', 'Pelagic purse seiner / trawler 75 m', 'Purse seiner', 'Pelagic', 75, 15.6, 7.6, 3000, 3000, 'RSW 2,500 m³', 17, 15, 7000, '1x MS diesel, CP prop', 190, 9, 12, 45, { Cb: 0.62 }, 8000,
    { fish: 6.0, cap: 2200, pax: 2, bm: 16, b: 'fishing', depth: 9.5, eq: ['rsw', 'powerBlock', 'sonar'], hand: ['fish'], color: 0x1d4e89, desc: 'Herring and mackerel by the thousand tonnes, kept cold in refrigerated sea-water tanks.' }],
  ['factory80', 'fishing', 'fishing', 'Factory freezer trawler 81 m', 'Factory trawler', 'Factory', 81, 17, 7.0, 3000, 4500, 'frozen 1,800 t', 15.5, 14, 7400, '1x MS diesel, CP prop', 190, 40, 60, 75, { Cb: 0.6 }, 12000,
    { fish: 5.0, cap: 1800, pax: 2, bm: 16, b: 'fishing', depth: 9.0, eq: ['factory', 'freezer', 'gantry'], hand: ['fish'], color: 0x7a1f1f, desc: 'A fish factory at sea: catches, fillets and freezes for weeks on end.' }],
  // ---------------------------------------------------------------- offshore
  ['ahts70', 'offshore', 'offshore', 'Anchor-handling tug supply 70 m (80 t BP)', 'AHTS', 'AHTS 80 t', 70, 16.5, 6.0, 2500, 2500, 'BP 80 t, deck 400 m²', 14, 12, 6000, '4x MS diesel, CP props', 200, 12, 15, 25, { Cb: 0.68 }, 6000,
    { bp: 80, cap: 1500, pax: 12, bm: 14, b: 'offshore', depth: 7.3, eq: ['towWinch', 'sternRoller', 'sharkJaws', 'dp2', 'fifi'], hand: ['deck', 'liquid:clean'], color: 0xd9531e, desc: 'Moves rigs and their anchors, then supplies them: the offshore all-rounder.' }],
  ['psv', 'offshore', 'offshore', 'Platform supply vessel 85 m (legacy)', 'PSV', 'PSV', 85, 20, 6.5, 4500, 3600, 'deck 900 m²', 14, 12, 7000, 'DE 4x gensets', 195, 12, 15, 35, { legacy: 1 }, 5000,
    { bm: 14, b: 'offshore', depth: 7.9, eq: ['dp2'], hand: ['deck', 'liquid:clean'] }],
  ['psv90', 'offshore', 'offshore', 'Hybrid PSV 90 m (battery, DP2)', 'Hybrid PSV', 'PSV', 90, 19.5, 7.4, 5300, 4700, 'deck 1,000 m²', 14, 12, 7400, 'DE 4x DF gensets + battery', 185, 12, 16, 42, { Cb: 0.72 }, 5000,
    { cap: 4500, pax: 12, bm: 15, b: 'offshore', depth: 9.0, eq: ['dp2', 'survey'], hand: ['deck', 'liquid:clean'], color: 0xd9531e, desc: 'Modern supply ship with a battery bank: quiet and frugal on station.' }],
  ['ahts85', 'offshore', 'offshore', 'Large AHTS 85 m (200 t BP)', 'Large AHTS', 'AHTS 200 t', 85, 22, 7.5, 4000, 5200, 'BP 200 t', 16.5, 13, 17000, '4x MS diesel, CP props', 195, 18, 25, 55, { Cb: 0.68 }, 9000,
    { bp: 200, cap: 2400, pax: 12, bm: 16, b: 'offshore', depth: 9.1, eq: ['towWinch', 'sternRoller', 'sharkJaws', 'dp2', 'fifi'], hand: ['deck', 'liquid:clean'], color: 0xc4421a, desc: 'Deep-water anchor handler with 200 tonnes of pull for the biggest rigs.' }],
  ['sov90', 'offshore', 'offshore', 'Service operation vessel 90 m (walk-to-work)', 'SOV', 'SOV', 90, 19.5, 6.5, 2500, 7000, '60 technicians, gangway', 13, 12, 8000, 'DE 4x gensets, DP2', 190, 20, 25, 60, { Cb: 0.68 }, 5000,
    { pax: 60, cap: 1000, bm: 16, b: 'offshore', depth: 7.9, eq: ['dp2', 'gangway', 'survey'], hand: ['deck', 'pax'], color: 0x2a6f97, desc: 'Floating hotel for wind-farm technicians, who walk to the turbines over a motion-compensated gangway.' }],
  // ---------------------------------------------------------------- general cargo
  ['coaster', 'general', 'aft_house_dry', 'Coastal freighter 90 m (legacy, classic)', 'Coaster', 'Coaster', 90, 14, 5.5, 3700, 2500, '1,200 t game payload', 14, 12, 1800, '1x MS diesel', 195, 7, 9, 9, { legacy: 1 }, 3000,
    { bm: 10, b: 'general', depth: 7.3, teu: 60, hand: ['bulk', 'breakbulk', 'box'], basis: 120000 }],
  ['shortsea88', 'general', 'aft_house_dry', 'Short-sea box-hold coaster 90 m (eco)', 'Short-sea coaster', 'Coaster', 89.9, 12.5, 5.6, 3800, 2600, '4,900 m³ box hold', 12, 11, 1500, '1x MS diesel + shaft gen', 190, 6, 8, 10, { Cb: 0.8 }, 4000,
    { bm: 10, b: 'general', depth: 7.5, teu: 200, holds: 1, hand: ['bulk', 'breakbulk', 'box'], color: 0x2d4a6b, desc: 'Modern open-box-hold coaster that slips up rivers and into small ports.' }],
  ['gc120', 'general', 'aft_house_dry', 'General cargo / multipurpose 120 m', 'Multipurpose', 'MPP', 120, 16.8, 7.5, 8000, 5600, '2x 40 t cranes, 250 TEU', 13.5, 12.5, 3200, '1x MS diesel, CP prop', 190, 10, 13, 18, { Cb: 0.8 }, 6000,
    { bm: 11, b: 'general', depth: 10.0, teu: 250, holds: 2, eq: ['cranes:2x40'], hand: ['bulk', 'breakbulk', 'box'], color: 0x3e5c3a, desc: 'Two holds and her own cranes: steel, timber, boxes and project parts.' }],
  ['mpp160', 'general', 'aft_house_dry', 'Multipurpose heavy-lift 160 m', 'Heavy-lift', 'Heavy-lift', 160, 26, 9.8, 17000, 13000, '2x 350 t cranes, 1,000 TEU', 16, 15, 9000, '1x LS 2-stroke', 175, 14, 18, 40, { Cb: 0.76 }, 12000,
    { bm: 12, b: 'general', depth: 14.0, teu: 1000, holds: 3, eq: ['cranes:2x350'], hand: ['bulk', 'breakbulk', 'box', 'heavy'], color: 0x8a3b12, desc: 'Two 350-tonne cranes in tandem lift whole factory modules aboard.' }],
  ['reefer150', 'general', 'aft_house_dry', 'Reefer ship 150 m (pallets + 300 FEU plugs)', 'Reefer', 'Reefer', 150, 24, 9.2, 13000, 11000, '560,000 cu ft', 21, 19.5, 12500, '1x LS 2-stroke', 175, 16, 20, 40, { Cb: 0.62 }, 10000,
    { bm: 12, b: 'general', depth: 13.0, teu: 600, plugs: 300, holds: 4, eq: ['cranes:4x40'], hand: ['reefer', 'box', 'breakbulk'], color: 0xf2f2f2, desc: 'Fast refrigerated ship for bananas, fruit and fish on pallets.' }],
  ['livestock135', 'general', 'aft_house_dry', 'Livestock carrier 134 m (pens 8,000 m²)', 'Livestock carrier', 'Livestock', 134, 21, 6.5, 7000, 9000, '14,000 sheep or 4,000 cattle', 16, 14, 6000, '1x MS diesel', 185, 25, 35, 45, { Cb: 0.70 }, 8000,
    { bm: 12, b: 'general', depth: 9.3, head: 4000, eq: ['pens', 'fodder'], hand: ['livestock'], color: 0xe0e0d8, desc: 'Ventilated pen decks for cattle and sheep, with fodder and fresh water for the voyage.' }],
  // ---------------------------------------------------------------- container
  ['feeder1000', 'container', 'container', 'Feeder 1,000 TEU 135 m', 'Feeder 1,000', 'Feeder', 134, 22.5, 7.6, 13000, 9900, '1,000 TEU', 18.5, 17, 8000, '1x LS 2-stroke', 175, 12, 16, 24, { Cb: 0.68 }, 6000,
    { bm: 10, b: 'container_s', depth: 12.3, teu: 1000, plugs: 200, eq: ['dg'], hand: ['box'], color: 0x2d6b4a, desc: 'Small feeder that shuttles boxes between the hubs and the smaller ports.' }],
  ['feeder', 'container', 'container', 'Container feeder 150 m (legacy)', 'Feeder', 'Feeder', 150, 24, 8.5, 13000, 10500, '1,100 TEU', 20, 17, 17000, '1x LS 2-stroke', 180, 13, 17, 26, { legacy: 1 }, 6000,
    { bm: 10, b: 'container_s', depth: 13.7, teu: 1100, plugs: 150, eq: ['dg'], hand: ['box'] }],
  ['feeder1700', 'container', 'container', 'Feeder 1,700 TEU 172 m', 'Feeder 1,700', 'Feeder', 172, 27.2, 9.8, 21500, 18000, '1,700 TEU, 300 reefer', 19.5, 18, 12600, '1x LS 2-stroke', 172, 14, 18, 30, { Cb: 0.68 }, 8000,
    { bm: 11, b: 'container_s', depth: 15.8, teu: 1700, plugs: 300, eq: ['dg'], hand: ['box'], color: 0x2d6b4a, desc: 'The big feeder: 1,700 boxes and 300 reefer plugs on regional loops.' }],
  ['subpmax2800', 'container', 'container', 'Sub-Panamax 2,800 TEU 200 m', 'Sub-Panamax', 'Sub-Panamax', 200, 32.2, 11.5, 38000, 28000, '2,800 TEU', 21, 19, 20000, '1x LS 2-stroke', 168, 16, 20, 42, { Cb: 0.66 }, 14000,
    { bm: 12, b: 'container_s', depth: 18.5, teu: 2800, plugs: 500, eq: ['dg'], hand: ['box'], color: 0x16324f, desc: 'Intra-regional workhorse, just narrow enough for the old Panama locks.' }],
  ['panamax4500', 'container', 'container', 'Panamax 4,500 TEU 294 m (classic)', 'Panamax', 'Panamax', 294, 32.2, 12.5, 52000, 50000, '4,500 TEU', 24, 21, 36000, '1x LS 2-stroke', 170, 20, 24, 60, { Cb: 0.62 }, 18000,
    { bm: 14, b: 'container_l', depth: 21.4, teu: 4500, plugs: 600, eq: ['dg'], hand: ['box'], color: 0x16324f, desc: 'Long and slim, built to the old Panama lock beam of 32.3 m.' }],
  ['boxship', 'container', 'container', 'Post-Panamax 6,500 TEU 300 m (legacy)', 'Container ship', 'Post-Panamax', 300, 43, 14, 80000, 75000, '6,500 TEU', 22, 20, 54000, '1x LS 2-stroke', 165, 20, 24, 85, { legacy: 1 }, 18000,
    { bm: 15, b: 'container_l', depth: 24.6, teu: 6500, plugs: 700, eq: ['dg'], hand: ['box'] }],
  ['neopmax14k', 'container', 'container', 'Neo-Panamax 14,000 TEU 366 m', 'Neo-Panamax', 'Neo-Panamax', 366, 51, 15.2, 150000, 145000, '14,000 TEU, 1,000 reefer', 22.5, 19, 50000, '1x LS 2-stroke (LNG-ready)', 160, 22, 26, 165, { Cb: 0.66 }, 20000,
    { bm: 16, b: 'container_l', depth: 29.9, teu: 14000, plugs: 1000, eq: ['dg'], hand: ['box'], color: 0x16324f, desc: 'The largest ship the new Panama locks take: 366 m by 51 m.' }],
  ['ulcv24k', 'container', 'container', 'ULCV 24,000 TEU 400 m', 'ULCV', 'ULCV', 399.9, 61.5, 16.5, 240000, 236000, '24,000 TEU', 22.5, 17, 59000, '1x LS 2-stroke (LNG DF)', 158, 23, 28, 270, { Cb: 0.67 }, 22000,
    { bm: 18, b: 'container_l', depth: 33.2, teu: 24000, plugs: 1500, eq: ['dg'], hand: ['box'], color: 0x0f2a44, desc: 'One of the largest ships afloat: 24,000 boxes, 24 rows across, Asia to Europe.' }],
  // ---------------------------------------------------------------- bulk
  ['bulker', 'bulk', 'aft_house_dry', 'Handysize bulk carrier 190 m (legacy, classic)', 'Handysize', 'Handysize', 190, 30, 10.5, 35000, 22000, '5 holds, 4x30 t cranes', 14, 13, 16500, '1x LS 2-stroke', 170, 18, 21, 30, { legacy: 1 }, 16000,
    { bm: 11, b: 'bulk', depth: 14.6, holds: 5, eq: ['cranes:4x30'], hand: ['bulk', 'breakbulk'], gear: 'geared' }],
  ['handy38', 'bulk', 'aft_house_dry', 'Handysize 38k eco, geared', 'Handysize 38k', 'Handysize', 180, 32, 10.5, 38000, 22500, '5 holds, 4x30 t cranes', 14.5, 13.5, 6500, '1x LS 2-stroke', 165, 18, 21, 33, { Cb: 0.83 }, 16000,
    { bm: 10, b: 'bulk', depth: 15.0, holds: 5, eq: ['cranes:4x30', 'grabs'], hand: ['bulk', 'breakbulk'], gear: 'geared', color: 0x7a2e2e, desc: 'Eco Handysize with her own cranes: logs, grain, steel and fertiliser to any port.' }],
  ['ultramax64', 'bulk', 'aft_house_dry', 'Ultramax 64k, geared', 'Ultramax', 'Ultramax', 199.9, 32.24, 13.3, 64000, 36000, '5 holds, 4x36 t cranes, grabs', 14.5, 13.5, 8600, '1x LS 2-stroke', 165, 19, 22, 36, { Cb: 0.85 }, 18000,
    { bm: 11, b: 'bulk', depth: 18.6, holds: 5, eq: ['cranes:4x36', 'grabs'], hand: ['bulk', 'breakbulk'], gear: 'geared', color: 0x7a2e2e, desc: 'The workhorse of the dry bulk trade: five holds and her own cranes, so she can work at small ports.' }],
  ['kamsarmax82', 'bulk', 'aft_house_dry', 'Kamsarmax 82k, gearless', 'Kamsarmax', 'Kamsarmax', 229, 32.26, 14.45, 82000, 44000, '7 holds', 14.5, 13.5, 9800, '1x LS 2-stroke', 165, 19, 22, 37, { Cb: 0.86 }, 18000,
    { bm: 12, b: 'bulk', depth: 20.2, holds: 7, hand: ['bulk', 'breakbulk'], gear: 'gearless', color: 0x6a2a2a, desc: 'Panamax beam, 229 m long for the Kamsar bauxite berth: grain and coal by the 80,000 t.' }],
  ['capesize180', 'bulk', 'aft_house_dry', 'Capesize 180k', 'Capesize', 'Capesize', 292, 45, 18.2, 180000, 93000, '9 holds', 14.5, 13, 16000, '1x LS 2-stroke', 163, 21, 24, 75, { Cb: 0.86 }, 20000,
    { bm: 13, b: 'bulk_l', depth: 24.8, holds: 9, hand: ['bulk'], color: 0x5a2424, desc: 'Too big for Panama or Suez when laden: ore and coal round the Capes.' }],
  ['newcastlemax208', 'bulk', 'aft_house_dry', 'Newcastlemax 208k', 'Newcastlemax', 'Newcastlemax', 299.9, 50, 18.4, 208000, 107000, '9 holds', 14.5, 12.5, 16500, '1x LS 2-stroke (LNG DF option)', 163, 21, 24, 80, { Cb: 0.86 }, 20000,
    { bm: 14, b: 'bulk_l', depth: 24.7, holds: 9, hand: ['bulk'], color: 0x5a2424, desc: 'The largest bulk carrier Newcastle, New South Wales, can load.' }],
  ['vloc400', 'bulk', 'aft_house_dry', 'VLOC 400k ore carrier', 'VLOC', 'VLOC', 362, 65, 23, 400000, 200000, '7 ore holds', 15.5, 14, 29000, '1x LS 2-stroke', 163, 24, 28, 130, { Cb: 0.87 }, 22000,
    { bm: 14, b: 'bulk_l', depth: 30.4, holds: 7, hand: ['bulk'], color: 0x4a1f1f, desc: 'Very large ore carrier of the Valemax class: 400,000 t of iron ore from Brazil to Asia.' }],
  // ---------------------------------------------------------------- tanker
  ['bunker85', 'tanker', 'aft_house_tanker', 'Bunker tanker 85 m', 'Bunker tanker', 'Bunker', 85, 15, 5.6, 4500, 3000, '5,200 m³, 2 hose cranes', 12, 11, 1800, '2x MS diesel', 200, 8, 10, 12, { Cb: 0.8 }, 2500,
    { bm: 11, b: 'tanker_s', depth: 7.0, seg: 4, eq: ['hoseCranes:2'], hand: ['liquid:clean'], color: 0x1f2f3f, desc: 'Harbour tanker that comes alongside ships at anchor and pumps their fuel.' }],
  ['chem13k', 'tanker', 'aft_house_tanker', 'Stainless chemical tanker 13k (IMO II)', 'Chemical tanker', 'Chemical', 128, 20.4, 8.7, 13000, 8500, '14 segregations', 14, 13.5, 5000, '1x MS diesel, CP prop', 185, 14, 17, 30, { Cb: 0.8 }, 10000,
    { bm: 13, b: 'chem', depth: 11.5, seg: 14, eq: ['hoseCranes:1'], hand: ['liquid:chem', 'liquid:clean'], color: 0x8a1c1c, desc: 'Stainless-steel tanks, each with its own pump: up to 14 chemicals at once.' }],
  ['tanker', 'tanker', 'aft_house_tanker', 'Handy product tanker 180 m (legacy, classic)', 'Product tanker', 'Handy tanker', 180, 32, 11, 37000, 24000, 'coated, 12 tanks', 15, 14, 15300, '1x LS 2-stroke', 170, 18, 22, 45, { legacy: 1 }, 16000,
    { bm: 12, b: 'tanker_s', depth: 15.7, seg: 6, eq: ['hoseCranes:1'], hand: ['liquid:clean', 'liquid:crude'] }],
  ['mr50', 'tanker', 'aft_house_tanker', 'MR product/chemical tanker 50k', 'MR tanker', 'MR', 183, 32.2, 13.3, 50000, 29800, 'IMO II/III, 12 tanks', 15, 14, 8800, '1x LS 2-stroke', 165, 20, 23, 48, { Cb: 0.82 }, 18000,
    { bm: 12, b: 'tanker_s', depth: 19.1, seg: 6, eq: ['hoseCranes:1'], hand: ['liquid:clean', 'liquid:chem'], color: 0x1f2f3f, desc: 'Medium-range product tanker: petrol, diesel, jet fuel and easy chemicals.' }],
  ['lr1_75', 'tanker', 'aft_house_tanker', 'LR1 product tanker 75k', 'LR1', 'LR1', 228, 32.24, 14.5, 75000, 42000, '12 tanks', 15, 14, 11000, '1x LS 2-stroke', 165, 21, 24, 58, { Cb: 0.83 }, 18000,
    { bm: 13, b: 'tanker_s', depth: 20.7, seg: 4, eq: ['hoseCranes:1'], hand: ['liquid:clean'], color: 0x1f2f3f, desc: 'Long-range product tanker at Panamax beam.' }],
  ['aframax115', 'tanker', 'aft_house_tanker', 'Aframax / LR2 115k', 'Aframax', 'Aframax', 250, 44, 15, 115000, 62000, '12 tanks', 15, 14, 14000, '1x LS 2-stroke', 163, 22, 25, 72, { Cb: 0.83 }, 20000,
    { bm: 14, b: 'tanker_l', depth: 21.4, seg: 3, eq: ['hoseCranes:1'], hand: ['liquid:crude', 'liquid:clean'], color: 0x2a2a2a, desc: 'The crude tanker of the North Sea, Baltic and Mediterranean trades.' }],
  ['suezmax158', 'tanker', 'aft_house_tanker', 'Suezmax 158k', 'Suezmax', 'Suezmax', 274, 48, 17, 158000, 81000, '12 tanks', 15.5, 14.5, 17000, '1x LS 2-stroke', 163, 23, 26, 86, { Cb: 0.83 }, 20000,
    { bm: 14, b: 'tanker_l', depth: 24.3, seg: 3, eq: ['hoseCranes:1'], hand: ['liquid:crude'], color: 0x2a2a2a, desc: 'The largest tanker that passes the Suez Canal fully laden.' }],
  ['vlcc300', 'tanker', 'aft_house_tanker', 'VLCC 300k', 'VLCC', 'VLCC', 333, 60, 22.5, 300000, 160000, '17 tanks', 15.5, 14, 25000, '1x LS 2-stroke', 162, 25, 28, 128, { Cb: 0.82 }, 22000,
    { bm: 15, b: 'tanker_l', depth: 32.1, seg: 3, eq: ['hoseCranes:2'], hand: ['liquid:crude'], color: 0x2a2a2a, desc: 'Two million barrels of crude from the Gulf to Asia in one voyage.' }],
  // ---------------------------------------------------------------- gas
  ['lpg5k', 'gas', 'aft_house_tanker', 'Pressurised LPG carrier 5,000 m³', 'Small LPG', 'Small LPG', 99.9, 18, 6.6, 5500, 4500, '2 bilobe tanks', 14, 13, 3500, '1x MS diesel', 185, 12, 15, 25, { Cb: 0.72 }, 6000,
    { bm: 14, b: 'gas_s', depth: 8.8, m3: 5000, eq: ['cargoCompressor'], hand: ['gas:lpg'], color: 0xb8c8d8, desc: 'Coastal gas carrier with two pressurised bilobe tanks for propane and butane.' }],
  ['lngbv7500', 'gas', 'aft_house_tanker', 'LNG bunkering vessel 7,500 m³', 'LNG bunker vessel', 'LNG bunker', 100, 19.6, 5.5, 4500, 7500, '2 IMO type C tanks', 13, 12, 4500, 'DE DF gensets', 185, 13, 16, 65, { Cb: 0.7 }, 4000,
    { bm: 16, b: 'gas_s', depth: 9.5, m3: 7500, eq: ['hoseCranes:2', 'cargoCompressor'], hand: ['gas:lng'], color: 0x2a6f97, desc: 'Delivers LNG fuel to LNG-powered ships in port and at anchor.' }],
  ['vlgc86k', 'gas', 'aft_house_tanker', 'VLGC 86,000 m³ (LPG)', 'VLGC', 'VLGC', 230, 36.6, 11.4, 55000, 48000, '4 type A tanks', 17, 16, 14000, '1x LS 2-stroke (LPG DF)', 165, 22, 25, 115, { Cb: 0.78 }, 18000,
    { bm: 16, b: 'vlgc', depth: 21.7, m3: 86000, eq: ['cargoCompressor'], hand: ['gas:lpg'], color: 0x8aa0b8, desc: 'Very large gas carrier: refrigerated LPG from the Gulf and the US to Asia.' }],
  ['lng174k', 'gas', 'lng', 'LNG carrier 174,000 m³ (membrane)', 'LNG carrier', 'LNG carrier', 295, 46.4, 11.5, 82000, 115000, '4 membrane tanks', 19.5, 18, 26000, '2x LS 2-stroke DF (ME-GA/X-DF)', 165, 26, 30, 255, { Cb: 0.76 }, 20000,
    { bm: 22, b: 'lng', depth: 26.0, m3: 174000, eq: ['cargoCompressor'], hand: ['gas:lng'], color: 0x3a3a3a, desc: 'Membrane LNG carrier at −162 °C, burning her own boil-off gas.' }],
  // ---------------------------------------------------------------- roro
  ['roro3500', 'roro', 'roro_pctc', 'Ro-ro freight ferry 195 m (3,500 lane m)', 'Ro-ro', 'Ro-ro', 195, 26.5, 7.0, 13000, 33000, '3,500 lane m, 12 drivers', 21, 19, 16000, '2x MS diesel, CP props', 185, 18, 22, 80, { Cb: 0.6 }, 4000,
    { pax: 12, bm: 15, b: 'roro', depth: 16.0, lm: 3500, eq: ['sternRamp'], hand: ['roro'], color: 0x1d4e89, desc: 'Trailers and trucks on three decks, rolled on and off over the stern ramp.' }],
  ['pctc7000', 'roro', 'roro_pctc', 'Car carrier PCTC 7,000 CEU (LNG DF)', 'Car carrier', 'PCTC', 200, 38, 10, 18000, 70000, '7,000 cars, 12 decks', 20, 18.5, 14000, '1x LS 2-stroke DF', 165, 20, 24, 95, { Cb: 0.6 }, 16000,
    { bm: 15, b: 'roro', depth: 34.0, ceu: 7000, eq: ['sternRamp', 'sideRamp'], hand: ['roro'], color: 0xe8e8e8, desc: 'A floating car park of 12 decks: new cars from the factories to the world.' }],
  // ---------------------------------------------------------------- ferry
  ['ferry50', 'ferry', 'ferry', 'Double-ended island ferry 50 m', 'Island ferry', 'Island ferry', 50, 13.5, 3.0, 250, 800, '250 pax, 40 cars', 11.5, 10, 1200, '2x diesel-electric + battery', 205, 5, 7, 14, { Cb: 0.55 }, 500,
    { pax: 250, cap: 150, ceu: 40, bm: 15, b: 'ferry', depth: 4.5, eq: ['bowDoor', 'sternDoor'], hand: ['pax', 'roro'], color: 0xe8e8e8, desc: 'Double-ended: she never turns round, just drives off the other way.' }],
  ['ferry', 'ferry', 'ferry', 'RoPax ferry 120 m (legacy)', 'RoPax ferry', 'RoPax', 120, 22, 6, 3000, 10000, '400 pax, 900 lane m', 22, 19, 13000, '2x MS diesel', 190, 25, 35, 60, { legacy: 1 }, 1500,
    { bm: 18, b: 'ferry', depth: 13.3, lm: 900, eq: ['bowDoor', 'sternDoor'], hand: ['pax', 'roro'] }],
  ['hsc112', 'ferry', 'ferry', 'High-speed catamaran 112 m', 'Fast cat', 'HSC', 112, 30.5, 3.9, 900, 10800, '1,000 pax, 200 cars', 37, 35, 36400, '4x HS diesel, waterjets', 205, 22, 30, 110, { disp: 2800 }, 600,
    { pax: 1000, cap: 500, ceu: 200, bm: 14, b: 'hsc', depth: 9.0, eq: ['sternDoor'], hand: ['pax', 'roro'], color: 0xf4f4f4, desc: 'Wave-piercing catamaran at 37 knots: crossings in half the time, at four times the fuel.' }],
  ['ropax200', 'ferry', 'ferry', 'Cruise ferry / ro-pax 200 m', 'Cruise ferry', 'Cruise ferry', 200, 31, 6.8, 7000, 50000, '1,800 pax, 2,800 lane m', 24, 22, 32000, '4x MS diesel (LNG DF)', 185, 80, 120, 210, { Cb: 0.6 }, 3000,
    { pax: 1800, lanes: 2800, lm: 2800, bm: 22, b: 'ferry', depth: 15.1, eq: ['bowDoor', 'sternDoor'], hand: ['pax', 'roro'], color: 0xe8e8e8, desc: 'Overnight cruise ferry with cabins, restaurants and 2,800 metres of lanes.' }],
  // ---------------------------------------------------------------- cruise
  ['expedition105', 'cruise', 'cruise', 'Polar expedition cruise ship 105 m (PC6)', 'Expedition ship', 'Expedition', 104.4, 18, 5.3, 1000, 12500, '200 guests', 15, 13, 8000, 'DE gensets + battery, azipods', 195, 100, 120, 140, { Cb: 0.62 }, 8000,
    { pax: 200, bm: 24, b: 'expedition', depth: 11.8, ice: 'pc6', eq: ['tender', 'helideck'], hand: ['pax'], color: 0x1d3557, desc: 'Ice-strengthened small cruise ship with Zodiacs for Antarctica and the Arctic.' }],
  ['cruise230', 'cruise', 'cruise', 'Mid-size cruise ship 230 m', 'Cruise ship', 'Mid-size cruise', 230, 28, 7, 6000, 55000, '1,250 guests', 21, 19, 25000, 'DE gensets, pods', 195, 520, 600, 450, { Cb: 0.66 }, 8000,
    { pax: 1250, bm: 30, b: 'cruise', depth: 15.6, eq: ['tender'], hand: ['pax'], color: 0xf4f4f4, desc: 'Premium mid-size cruise ship that fits the smaller cruise ports.' }],
  ['cruise330', 'cruise', 'cruise', 'Large cruise ship 330 m (LNG)', 'Large cruise ship', 'Large cruise', 330, 42, 8.8, 11000, 180000, '4,000 guests', 22, 19, 62000, 'DE LNG DF gensets, pods', 185, 1300, 1500, 1200, { Cb: 0.66 }, 8000,
    { pax: 4000, bm: 33, b: 'cruise', depth: 19.6, eq: ['tender'], hand: ['pax'], color: 0xf4f4f4, desc: 'LNG-powered resort ship for 4,000 guests.' }],
  ['cruise362', 'cruise', 'cruise', 'Mega cruise ship 362 m', 'Mega cruise ship', 'Mega cruise', 362, 47, 9.3, 15000, 236000, '6,700 guests', 22, 20, 97000, 'DE gensets, 3 pods', 195, 2100, 2300, 1500, { Cb: 0.66 }, 8000,
    { pax: 6700, bm: 36, b: 'cruise', depth: 22.5, eq: ['tender'], hand: ['pax'], color: 0xf4f4f4, desc: 'A floating city of the Oasis class: parks, theatres and 6,700 guests.' }],
  // ---------------------------------------------------------------- special
  ['research75', 'special', 'special', 'Oceanographic research vessel 75 m', 'Research ship', 'Research', 75, 18, 5.6, 2000, 5000, '30 scientists, labs, A-frame', 14, 12, 6000, 'DE gensets, DP2, ice 1A', 190, 18, 22, 90, { Cb: 0.6 }, 12000,
    { pax: 30, cap: 500, bm: 24, b: 'research', depth: 8.0, ice: 'i1a', eq: ['aframe', 'survey', 'dp2', 'moonpool'], hand: ['pax', 'deck'], color: 0xf4f4f4, desc: 'Floating laboratory with an A-frame, CTD hangar and multibeam echo sounder.' }],
  ['icebreaker120', 'special', 'special', 'Polar research icebreaker 128 m (PC3)', 'Icebreaker', 'Icebreaker', 128, 24, 8, 4000, 15000, 'helideck, moon pool', 16, 13, 20000, 'DE gensets, 2 azipods', 195, 35, 45, 340, { Cb: 0.6 }, 20000,
    { pax: 60, cap: 1500, bm: 36, b: 'icebreaker', depth: 13.0, ice: 'pc3', eq: ['helideck', 'moonpool', 'aframe', 'survey'], hand: ['pax', 'deck'], color: 0xc1121f, desc: 'Breaks multi-year ice: research, resupply and escorts in the polar seas.' }],
  ['tshd100', 'special', 'special', 'Trailing suction hopper dredger 100 m', 'Hopper dredger', 'Dredger', 100, 21, 7, 8000, 5500, 'hopper 5,000 m³', 13, 12, 8000, 'DE gensets (propulsion + dredge pumps)', 195, 14, 18, 60, { Cb: 0.80 }, 6010,
    { pax: 4, cap: 7200, m3: 5000, bm: 18, b: 'dredger', depth: 9.0, eq: ['dragArm', 'hopper'], hand: ['hopper'], color: 0xb5651d, desc: 'Sucks sand and silt from the fairway through a drag head and dumps it at sea.' }],
  // ---------------------------------------------------------------- motor yacht
  ['rib8', 'motor_yacht', 'motor_yacht', 'RIB tender / day boat 8.5 m', 'RIB', 'RIB', 8.5, 2.9, 0.6, 0.5, 3, '8 seats', 45, 35, 336, '2x outboard', 300, 1, 1, 0.15, { disp: 2.5 }, 180,
    { pax: 8, cap: 0.3, bm: 1, b: 'yacht_s', depth: 1.2, hand: ['pax'], color: 0x222222, desc: 'Rigid inflatable: fast, wet and great fun for an hour.' }],
  ['cruiser', 'motor_yacht', 'motor_yacht', 'Sports cruiser 12 m (legacy)', 'Sports cruiser', 'Cruiser', 12, 3.8, 1.1, 1, 15, '6 guests', 30, 24, 600, '2x sterndrive', 240, 1, 1, 0.6, { legacy: 1 }, 250,
    { bm: 4, b: 'yacht_s', depth: 1.9, hand: ['pax'] }],
  ['flybridge18', 'motor_yacht', 'motor_yacht', 'Flybridge yacht 18 m', 'Flybridge', 'Flybridge', 18, 5.2, 1.5, 3, 50, '8 guests', 32, 26, 1800, '2x HS diesel, shafts', 225, 1, 2, 2.5, { disp: 30 }, 350,
    { pax: 8, cap: 1, bm: 6, b: 'yacht_s', depth: 2.6, hand: ['pax'], color: 0xf4f4f4, desc: 'Flybridge yacht with three cabins: the classic Mediterranean charter boat.' }],
  ['myacht', 'motor_yacht', 'motor_yacht', 'Motor yacht 24 m (legacy)', 'Motor yacht', 'Motor yacht', 24, 6, 1.8, 8, 100, '10 guests', 26, 21, 2600, '2x HS diesel', 225, 3, 4, 6, { legacy: 1 }, 800,
    { bm: 8, b: 'yacht_s', depth: 3.1, hand: ['pax'] }],
  ['explorer45', 'motor_yacht', 'motor_yacht', 'Explorer yacht 45 m (steel, ice-class)', 'Explorer yacht', 'Explorer', 45, 9.4, 3.0, 150, 500, '12 guests, tender crane', 15, 12, 1500, '2x MS diesel', 200, 9, 11, 35, { disp: 550 }, 5000,
    { pax: 12, cap: 10, bm: 24, b: 'yacht_l', depth: 4.6, ice: 'i1a', eq: ['tender', 'cranes:1x5'], hand: ['pax'], color: 0x2b2d42, desc: 'Steel go-anywhere yacht with a tender crane and the range to cross oceans.' }],
  ['superyacht', 'motor_yacht', 'motor_yacht', 'Superyacht 70 m (legacy)', 'Superyacht', 'Superyacht', 70, 12, 3.6, 300, 1800, '24 guests', 18, 15, 4600, '2x MS diesel', 200, 18, 22, 120, { legacy: 1 }, 5000,
    { bm: 30, b: 'yacht_l', depth: 6.4, eq: ['tender'], hand: ['pax'] }],
  ['giga100', 'motor_yacht', 'motor_yacht', 'Superyacht 100 m', 'Superyacht 100 m', 'Gigayacht', 100, 16, 4.6, 600, 4000, '36 guests, helideck', 20, 15, 9000, '2x MS diesel + DE', 195, 35, 45, 300, { disp: 3500 }, 6000,
    { pax: 36, cap: 30, bm: 42, b: 'yacht_l', depth: 8.4, eq: ['tender', 'helideck', 'beachClub'], hand: ['pax'], color: 0xf4f4f4, desc: 'A hundred metres of private ship: helideck, beach club and a crew of 45.' }],
  // ---------------------------------------------------------------- sail yachts (SAILING owns rigs, hulls and game rows)
  ['sloop', 'sail_yacht', 'sail', 'Sloop 11 m', 'Sloop', 'Sloop', 11, 3.6, 1.9, 0.5, 9, '4 guests', 7.2, 6, 21, '1x aux diesel', 250, 1, 2, 0.35, { legacy: 1 }, 300,
    { bm: 4, b: 'sail', depth: 1.6, hand: ['pax'] }],
  ['ketch', 'sail_yacht', 'sail', 'Ketch 16 m', 'Ketch', 'Ketch', 16, 4.6, 2.3, 1.5, 25, '6 guests', 8.6, 7, 75, '1x aux diesel', 240, 2, 3, 1.1, { legacy: 1 }, 1000,
    { bm: 6, b: 'sail', depth: 2.2, hand: ['pax'] }],
  ['catamaran', 'sail_yacht', 'sail', 'Catamaran 14 m', 'Catamaran', 'Catamaran', 14, 7.5, 1.3, 1.2, 20, '8 guests', 10.5, 8, 60, '2x aux diesel', 240, 1, 2, 0.9, { legacy: 1 }, 800,
    { bm: 5, b: 'sail', depth: 2.0, hand: ['pax'] }],
  ['schooner', 'sail_yacht', 'sail', 'Classic schooner 35 m', 'Schooner', 'Schooner', 35, 7.5, 3.5, 8, 150, '12 guests', 10, 8.5, 400, '1x aux diesel', 220, 6, 8, 6, { legacy: 1 }, 3000,
    { bm: 18, b: 'sail', depth: 4.0, hand: ['pax'] }],
];

// Today's game rows, verbatim from shared/constants.js SHIP_CLASSES (test/ships-catalogue deep-equals them). The 13
// non-sail rows are what H1 moves out of constants.js; the 4 sail rows stay literal in constants.js (SAILING) and are
// mirrored here only so new code (yard, value, listings) can read them without importing constants.
export const LEGACY_ROWS = {
  coaster: { id: 'coaster', cat: 'cargo', name: 'Coastal freighter', length: 90, beam: 14, draft: 5.5, maxKn: 14, turnRate: 5.5, displacement: 3200, capacity: 1200, pax: 12, fuelCap: 80, burn: 0.9, price: 0, hullColor: 0x2d4a6b, fishRate: 0.6, wearMul: 1, crewCost: 40, desc: 'Cheap, slow, sturdy. The starter ship.' },
  feeder: { id: 'feeder', cat: 'cargo', name: 'Container feeder', length: 150, beam: 24, draft: 8.5, maxKn: 20, turnRate: 4, displacement: 14000, capacity: 4000, pax: 8, fuelCap: 300, burn: 3.2, price: 950000, hullColor: 0x2d6b4a, fishRate: 0.2, wearMul: 1, crewCost: 120, desc: 'Fast, deep, hungry. Makes money on long container runs.' },
  bulker: { id: 'bulker', cat: 'cargo', name: 'Handysize bulk carrier', length: 190, beam: 30, draft: 10.5, maxKn: 14, turnRate: 3, displacement: 40000, capacity: 35000, pax: 10, fuelCap: 900, burn: 2.8, price: 4500000, hullColor: 0x7a2e2e, fishRate: 0.1, wearMul: 1.1, crewCost: 180, desc: 'Grain, ore, steel by the tens of thousands of tonnes.' },
  tanker: { id: 'tanker', cat: 'cargo', name: 'Product tanker', length: 180, beam: 32, draft: 11, maxKn: 15, turnRate: 3, displacement: 45000, capacity: 30000, pax: 10, fuelCap: 800, burn: 2.6, price: 4200000, hullColor: 0x1f2f3f, fishRate: 0, wearMul: 1.1, crewCost: 180, desc: 'Fuel and chemicals. Harbour authorities watch tankers closely.' },
  boxship: { id: 'boxship', cat: 'cargo', name: 'Container ship', length: 300, beam: 43, draft: 14, maxKn: 22, turnRate: 2.2, displacement: 110000, capacity: 90000, pax: 12, fuelCap: 4000, burn: 9, price: 25000000, hullColor: 0x16324f, fishRate: 0, wearMul: 1.2, crewCost: 400, desc: 'The big league. Only mega ports can handle her.' },
  trawler: { id: 'trawler', cat: 'working', name: 'Stern trawler', length: 45, beam: 10, draft: 4.2, maxKn: 12, turnRate: 8, displacement: 900, capacity: 300, pax: 4, fuelCap: 40, burn: 0.5, price: 180000, hullColor: 0x6b3a2d, fishRate: 3.0, wearMul: 1.2, crewCost: 35, desc: 'Small and nimble; pulls fish out of the banks five times faster than anything else.' },
  tug: { id: 'tug', cat: 'working', name: 'Harbour tug', length: 32, beam: 11, draft: 5, maxKn: 13, turnRate: 12, displacement: 700, capacity: 50, pax: 6, fuelCap: 60, burn: 0.45, price: 320000, hullColor: 0x1b1b1b, fishRate: 0.1, wearMul: 0.9, crewCost: 45, towPower: 1, desc: 'Built to tow. Towing contracts pay double and cost her no speed.' },
  psv: { id: 'psv', cat: 'working', name: 'Platform supply vessel', length: 85, beam: 20, draft: 6.5, maxKn: 14, turnRate: 6, displacement: 4500, capacity: 2500, pax: 20, fuelCap: 400, burn: 1.1, price: 1200000, hullColor: 0xd9531e, fishRate: 0.2, wearMul: 0.9, crewCost: 90, desc: 'Offshore supply runs to the platforms; the only hull that is at home in a storm.' },
  pilot: { id: 'pilot', cat: 'working', name: 'Pilot boat', length: 18, beam: 5.5, draft: 1.8, maxKn: 26, turnRate: 20, displacement: 40, capacity: 2, pax: 8, fuelCap: 6, burn: 0.12, price: 90000, hullColor: 0xe8a317, fishRate: 0.1, wearMul: 1.3, crewCost: 15, desc: 'Fast runabout for short charters and reaching things in a hurry.' },
  ferry: { id: 'ferry', cat: 'passenger', name: 'RoPax ferry', length: 120, beam: 22, draft: 6, maxKn: 22, turnRate: 5, displacement: 9000, capacity: 500, pax: 400, fuelCap: 200, burn: 2.6, price: 700000, hullColor: 0xe8e8e8, fishRate: 0.1, wearMul: 1, crewCost: 150, desc: 'Passenger ferry: 400 berths, 22 knots, thirsty.' },
  cruiser: { id: 'cruiser', cat: 'motor yacht', name: 'Sports cruiser 12 m', length: 12, beam: 3.8, draft: 1.1, maxKn: 30, turnRate: 25, displacement: 9, capacity: 1, pax: 6, fuelCap: 1.2, burn: 0.09, price: 150000, hullColor: 0xf4f4f4, fishRate: 0.05, wearMul: 1.4, crewCost: 0, desc: 'Weekend toy. Fast, fragile, no cargo.' },
  myacht: { id: 'myacht', cat: 'motor yacht', name: 'Motor yacht 24 m', length: 24, beam: 6, draft: 1.8, maxKn: 26, turnRate: 16, displacement: 70, capacity: 3, pax: 10, fuelCap: 8, burn: 0.25, price: 900000, hullColor: 0x1d1d1d, fishRate: 0.05, wearMul: 1.2, crewCost: 20, desc: 'Charter guests pay well for her. Keep her polished.' },
  superyacht: { id: 'superyacht', cat: 'motor yacht', name: 'Superyacht 70 m', length: 70, beam: 12, draft: 3.6, maxKn: 18, turnRate: 7, displacement: 1500, capacity: 20, pax: 24, fuelCap: 150, burn: 0.9, price: 12000000, hullColor: 0xeaeaea, fishRate: 0, wearMul: 1.1, crewCost: 220, desc: 'The most expensive way to carry 24 people. Charter rates to match.' },
  sloop: { id: 'sloop', cat: 'sailing yacht', name: 'Sloop 11 m', length: 11, beam: 3.6, draft: 1.9, maxKn: 7.2, auxKn: 5, sail: true, turnRate: 22, displacement: 6, capacity: 0.5, pax: 4, fuelCap: 0.2, burn: 0.012, price: 60000, hullColor: 0x1e3f73, fishRate: 0.05, wearMul: 1.3, crewCost: 0, desc: 'Wind is free. Beating to windward is not fast.' },
  ketch: { id: 'ketch', cat: 'sailing yacht', name: 'Ketch 16 m', length: 16, beam: 4.6, draft: 2.3, maxKn: 8.6, auxKn: 6, sail: true, turnRate: 16, displacement: 18, capacity: 1.5, pax: 6, fuelCap: 0.6, burn: 0.02, price: 220000, hullColor: 0x7a2e2e, fishRate: 0.05, wearMul: 1.2, crewCost: 0, desc: 'Blue-water cruiser; two masts, an ocean of patience.' },
  catamaran: { id: 'catamaran', cat: 'sailing yacht', name: 'Catamaran 14 m', length: 14, beam: 7.5, draft: 1.3, maxKn: 10.5, auxKn: 7, sail: true, turnRate: 18, displacement: 12, capacity: 1.2, pax: 8, fuelCap: 0.5, burn: 0.02, price: 300000, hullColor: 0xf0f0f0, fishRate: 0.05, wearMul: 1.2, crewCost: 0, desc: 'Fast off the wind and shallow enough for most anchorages.' },
  schooner: { id: 'schooner', cat: 'sailing yacht', name: 'Classic schooner 35 m', length: 35, beam: 7.5, draft: 3.5, maxKn: 10, auxKn: 7, sail: true, turnRate: 9, displacement: 180, capacity: 8, pax: 12, fuelCap: 3, burn: 0.06, price: 1400000, hullColor: 0x3b2a1a, fishRate: 0.1, wearMul: 1.4, crewCost: 60, desc: 'Wood and brass; charter guests love her, the maintenance bill does not.' },
};
export const SAIL_IDS = ['sloop', 'ketch', 'catamaran', 'schooner'];
export const LEGACY_IDS = Object.keys(LEGACY_ROWS);

// ------------------------------------------------------------------------------------------------ §2.4 derivation
const rnd = (v, d = 0) => { const k = 10 ** d; return Math.round(v * k) / k; };
/** Catalogue price rounding: < 1 M → 1,000; 1–10 M → 10,000; > 10 M → 100,000. */
export function roundPrice(p) { return p > 1e7 ? Math.round(p / 1e5) * 1e5 : p > 1e6 ? Math.round(p / 1e4) * 1e4 : Math.round(p / 1e3) * 1e3; }
/** §2.4 cargo price: 130 × cap × (cap / 35,000)^−0.15 × mul. */
export function cargoPrice(cap, mul) { return 130 * cap * Math.pow(cap / 35000, -0.15) * mul; }
/** §2.4 passenger price: 1,750 × pax × (pax / 400)^−0.1 × mul. */
export function paxPrice(pax, mul) { return 1750 * pax * Math.pow(pax / 400, -0.1) * mul; }
export function workPrice(usd, fishing = false) { return 0.157 * Math.pow(usd, 0.9) * (fishing ? 0.6 : 1); }
export function yachtPrice(usd) { return 2.14 * Math.pow(usd, 0.83); }
export function displacementOf(L, B, T, Cb) { return rnd(DERIVE.CB_HULL * L * B * T * Cb * DERIVE.RHO); }
export function crewCostOf(type, crewOpt, gt) {
  const f = Math.pow(1 + gt / 40000, 0.8);
  if (type === 'ferry' || type === 'cruise') return Math.round(6 * Math.min(crewOpt, 40) * f + 1.5 * Math.max(0, crewOpt - 40));
  if (type === 'motor_yacht') return Math.round(5 * Math.max(0, crewOpt - 1) * f);
  return Math.round(6 * crewOpt * f);
}
export function turnRateOf(type, L) { return rnd(Math.min(30, 5.5 * Math.pow(90 / L, 0.75) * (DERIVE.TURN_MUL[type] || 1)), 1); }
export function fuelCapOf(rangeNm, svcKn, burn) { return rnd(rangeNm / svcKn * burn * DERIVE.FUEL_K, burn < 0.5 ? 1 : 0); }
export function admiralty(disp, kn, kW) { return rnd(Math.pow(disp, 2 / 3) * kn ** 3 / kW); }

const FAST = new Set(['ctv26', 'pilot14', 'hsc112']);
const WEAR = { rib8: 1.4, flybridge18: 1.3, explorer45: 1.2, giga100: 1.2 };
function wearOf(id, type, teu) {
  if (WEAR[id]) return WEAR[id];
  if (FAST.has(id)) return 1.3;
  if (type === 'bulk' || type === 'tanker') return 1.1;
  if (type === 'container' && teu >= 10000) return 1.2;
  if (type === 'fishing') return 1.2;
  return 1.0;
}
function engineOf(label, kW) {
  const n = /^(\d)x/.exec(label) ? Number(/^(\d)x/.exec(label)[1]) : 1;
  const kind = /2-stroke/.test(label) ? '2s' : /^DE|diesel-electric|\+ DE/.test(label) ? 'de' : /outboard/.test(label) ? 'ob' : /HS diesel|sterndrive/.test(label) ? 'hs' : /aux/.test(label) ? 'aux' : '4s';
  const fuel = /LNG DF|DF gensets|2-stroke DF|LNG\)/.test(label) && !/LNG-ready|option/.test(label) ? 'lng' : /LPG DF/.test(label) ? 'lpg' : kW < 2500 ? 'mgo' : 'vlsfo';
  return { kind, fuel, n, label };
}
/** Default engine option of a model (the 'engine' group of §2.5). */
function defaultEngine(eng) { return eng.kind === 'de' ? 'de' : eng.fuel === 'lng' ? 'lng' : 'vlsfo'; }
// Wave-2 stats (V5-WAVE2 §3.6 columns). Game rule heuristics from the reference data; shipstats keeps its own legacy table.
const HULL = { bulk: 0.78, tanker: 0.8, gas: 0.8, container: 0.75, general: 0.75, roro: 0.72, ferry: 0.7, cruise: 0.7, offshore: 0.9, tug: 0.9, workboat: 0.8, pilot: 0.85, fishing: 0.85, special: 0.9, motor_yacht: 0.6, sail_yacht: 0.7 };
const TOUGH = new Set(['offshore', 'tug', 'pilot', 'fishing', 'special']);
function statsOf(id, type, L, eng, crewOpt, legacy, ice) {
  const airDraft = L < 30 ? rnd(L * 0.3 + 2) : rnd(Math.min(75, 12 + L * 0.17));
  let maxHs = L < 12 ? 1.5 : L < 20 ? 3 : L < 40 ? 4.5 : L < 80 ? 6 : L < 150 ? 7 : 8;
  if (TOUGH.has(type)) maxHs = Math.min(10, maxHs + 1);
  const thrusters = ['offshore', 'special', 'cruise', 'ferry'].includes(type) ? 'bow+stern'
    : eng.label.includes('azimuth') || eng.label.includes('azipod') ? 'azimuth'
    : ['container', 'roro', 'gas', 'general'].includes(type) || (type === 'motor_yacht' && L >= 24) ? 'bow' : null;
  const hull = id === 'icebreaker120' ? 1.0 : id === 'explorer45' ? 0.85 : HULL[type];
  const eco = legacy ? 'C' : L < 30 ? 'C' : eng.fuel === 'lng' || /battery/.test(eng.label) ? 'A' : 'B';
  const comfort = type === 'cruise' || type === 'motor_yacht' ? 3 : type === 'ferry' || type === 'sail_yacht' ? 2 : 1;
  return { airDraft, thrusters, maxHs, hull, ice: ice || null, reliability: 1.0, comfort, eco, locker: Math.round(crewOpt * 0.5 + 1) };
}
const MIN_PORT = [['minor', 140], ['regional', 250], ['major', 366], ['mega', 400]];
function minPortOf(L) { for (const [s, m] of MIN_PORT) if (L <= m) return s; return 'mega'; }

function build(row) {
  const [id, type, gen, refName, short, size, L, B, T, dwt, gt, capText, maxKn, svcKn, kW, engLabel, sfoc, crewMin, crewOpt, usdM, hull, range, x] = row;
  const leg = LEGACY_ROWS[id];
  const eng = engineOf(engLabel, kW);
  const cat = TYPE_CAT[type];
  const isCargo = DERIVE.CARGO_TYPE_MUL[type] !== undefined;
  const teu = x.teu || 0;
  let g;
  if (leg) {
    g = { ...leg };
  } else {
    const disp = hull.disp ?? displacementOf(L, B, T, hull.Cb);
    const burn = rnd(kW * sfoc / 1e6, 3);
    let price, cap;
    if (isCargo) {
      cap = rnd(0.9 * dwt);
      price = cargoPrice(cap, DERIVE.CARGO_TYPE_MUL[type] * (DERIVE.CARGO_MODEL_MUL[id] || 1));
    } else if (type === 'ferry' || type === 'cruise') {
      const tm = type === 'cruise' ? (id === 'expedition105' ? 8 : 4) : (id === 'hsc112' ? 1.6 : 1);
      price = paxPrice(x.pax, tm);
      cap = x.cap ?? rnd(x.lanes ? x.lanes * 2.5 : dwt * 0.5);
      if (x.lanes) price += 0.5 * cargoPrice(cap, DERIVE.CARGO_TYPE_MUL.roro);
    } else if (type === 'motor_yacht') { price = yachtPrice(usdM * 1e6); cap = x.cap; }
    else { price = workPrice(usdM * 1e6, type === 'fishing'); cap = x.cap; }
    g = {
      id, cat, name: refName, length: L, beam: B, draft: T, maxKn,
      turnRate: turnRateOf(type, L), displacement: disp, capacity: cap,
      pax: x.pax ?? (isCargo ? 12 : type === 'tug' ? 4 : 2),
      fuelCap: fuelCapOf(range, svcKn, burn), burn, price: roundPrice(price), hullColor: x.color ?? 0x2d4a6b,
      fishRate: x.fish || 0, wearMul: wearOf(id, type, teu), crewCost: crewCostOf(type, crewOpt, gt), desc: x.desc || refName,
    };
    if (x.bp) g.towPower = rnd(x.bp / 70, 3);
  }
  const ice = x.ice || null;
  const units = { t: g.capacity };
  for (const k of ['teu', 'plugs', 'ceu', 'm3', 'head', 'seg', 'holds']) if (x[k]) units[k === 'seg' ? 'segregations' : k] = x[k];
  if (x.lm) units.lm = x.lm;
  if (g.pax) units.pax = g.pax;
  const defaults = { engine: defaultEngine(eng) };
  if (x.gear) defaults.gear = x.gear;
  else if (type === 'general') defaults.gear = 'geared';
  else if (type === 'container' && teu <= 1700) defaults.gear = 'gearless';
  const m = {
    ...g,
    type, gen, base: leg ? id : null, refName, short, size, era: leg ? 'classic' : 'eco',
    depth: x.depth ?? null, draftHull: x.draftHull ?? null, airDraft: null,   // draftHull: hull-body draught when `draft` is navigational (ASD tugs: the Z-drives reach below the hull)
    dwt, gt, capText, kW, sfoc, svcKn, crew: { min: crewMin, opt: crewOpt },
    engine: eng, usdM, buildMonths: x.bm, rangeNm: range, Cb: hull.Cb ?? null,
    units, eq: x.eq || [], handling: x.hand || [], bp: x.bp || 0, ice,
    stats: null, options: null, defaults, builders: [x.b], minPort: minPortOf(L), tags: [], hidden: false, verify: true,
    basis: x.basis ?? null,
  };
  m.stats = statsOf(id, type, L, eng, crewOpt, !!leg, ice);
  m.airDraft = m.stats.airDraft;
  m.options = modelOptions(m);
  if (defaults.gear === 'geared') m.tags.push('geared');
  if (m.eq.includes('dp2')) m.tags.push('dp2');
  return m;
}

const BASE_OF = { // legacy id used by id-keyed fallback tables (ship.js BUILDERS, shipplan HOUSE, ais FAMILY, …)
  workboat: 'tug', tug: 'tug', pilot: 'pilot', fishing: 'trawler', offshore: 'psv', general: 'coaster', bulk: 'bulker',
  tanker: 'tanker', gas: 'tanker', roro: 'ferry', ferry: 'ferry', cruise: 'ferry', special: 'psv',
};
function baseFor(m) {
  if (m.base) return m.base;
  if (m.type === 'container') return m.units.teu >= 2800 ? 'boxship' : 'feeder';
  if (m.type === 'motor_yacht') return m.length < 15 ? 'cruiser' : m.length < 40 ? 'myacht' : 'superyacht';
  if (m.type === 'pilot' || (m.type === 'workboat' && m.gen === 'small_fast')) return 'pilot';
  if (m.type === 'general' && m.length >= 150) return 'bulker';
  return BASE_OF[m.type] || 'coaster';
}

const models = {};
for (const row of SRC) { const m = build(row); m.base = baseFor(m); models[m.id] = m; }
/** The 76 models keyed by id (legacy ids keep their key). Frozen two levels deep. */
export const MODELS = models;
for (const m of Object.values(MODELS)) { for (const v of Object.values(m)) if (v && typeof v === 'object') Object.freeze(v); Object.freeze(m); }
Object.freeze(MODELS);
export const MODEL_IDS = Object.keys(MODELS);
/** The raw source rows (for scripts/ships/gen-catalogue.mjs and the tests). */
export const SOURCE_ROWS = SRC;
