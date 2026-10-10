// World economy product catalogue (docs/WORLD-ECONOMY-CONTRACT.md §4): 80 market goods in 11 categories. Data only
// (rule E1); plain ESM, browser-safe, no imports. The 7 legacy goods keep their ids and bases (E6).
//
// Row: [id, name, cat, handling ('a|b', '+plugs' = one reefer plug per 14 t in a box), unit, tPer, refUsdT, legacyBase,
//       S, fmul, polGroup, hs, perishH]

/** Categories in display order (§4.3), with the icon key the client maps in public/js/icons.js CAT_ICON. */
export const CATS = [
  { id: 'grains', name: 'Grains and feed', icon: 'wheat' },
  { id: 'fert', name: 'Fertilisers', icon: 'sack' },
  { id: 'ores', name: 'Ores, minerals, coal', icon: 'rock' },
  { id: 'energy', name: 'Oil, fuels and liquids', icon: 'drop' },
  { id: 'gas', name: 'Gases', icon: 'flame' },
  { id: 'reefer', name: 'Chilled and frozen', icon: 'snowflake' },
  { id: 'box', name: 'Container goods', icon: 'container' },
  { id: 'breakbulk', name: 'Breakbulk and project', icon: 'girder' },
  { id: 'vehicles', name: 'Vehicles', icon: 'car' },
  { id: 'animals', name: 'Live animals', icon: 'cow' },
  { id: 'offshore', name: 'Offshore', icon: 'rig' },
];

const RF = 'reefer|box+plugs';
// prettier-ignore
const ROWS = [
  // ---- grains, feed, softs in bulk (11) ----
  ['grain', 'Wheat', 'grains', 'bulk', 't', 1, 230, 260, 0.35, 0.75, 'grain', '1001'],
  ['maize', 'Maize (corn)', 'grains', 'bulk', 't', 1, 200, 0, 0.35, 0.75, 'grain', '1005'],
  ['soybeans', 'Soybeans', 'grains', 'bulk', 't', 1, 400, 0, 0.30, 0.75, 'grain', '1201'],
  ['rice', 'Rice', 'grains', 'bulk|box', 't', 1, 480, 0, 0.30, 0.75, 'grain', '1006'],
  ['barley', 'Barley', 'grains', 'bulk', 't', 1, 220, 0, 0.35, 0.75, 'grain', '1003'],
  ['sugar', 'Raw sugar', 'grains', 'bulk', 't', 1, 440, 0, 0.35, 0.75, 'grain', '1701'],
  ['soymeal', 'Soybean meal', 'grains', 'bulk', 't', 1, 330, 0, 0.30, 0.75, 'grain', '2304'],
  ['urea', 'Urea fertiliser', 'fert', 'bulk', 't', 1, 350, 0, 0.35, 0.75, 'grain', '310210'],
  ['potash', 'Potash', 'fert', 'bulk', 't', 1, 300, 0, 0.25, 0.6, 'grain', '310420'],
  ['phosphate', 'Phosphate rock', 'fert', 'bulk', 't', 1, 150, 0, 0.25, 0.5, 'grain', '2510'],
  ['pellets', 'Wood pellets', 'grains', 'bulk', 't', 1, 200, 0, 0.25, 0.6, 'grain', '440131'],
  // ---- ores, minerals, coal (10) ----
  ['ore', 'Iron ore', 'ores', 'bulk', 't', 1, 100, 0, 0.35, 0.5, 'steel', '2601'],
  ['coal', 'Thermal coal', 'ores', 'bulk', 't', 1, 120, 0, 0.40, 0.6, 'fuel', '270119'],
  ['cokingcoal', 'Coking coal', 'ores', 'bulk', 't', 1, 220, 0, 0.40, 0.6, 'steel', '270112'],
  ['bauxite', 'Bauxite', 'ores', 'bulk', 't', 1, 70, 0, 0.25, 0.5, 'steel', '2606'],
  ['alumina', 'Alumina', 'ores', 'bulk', 't', 1, 450, 0, 0.35, 0.6, 'steel', '281820'],
  ['copperconc', 'Copper concentrate', 'ores', 'bulk', 't', 1, 2500, 0, 0.30, 0.6, 'steel', '2603'],
  ['nickelore', 'Nickel ore', 'ores', 'bulk', 't', 1, 50, 0, 0.30, 0.5, 'steel', '2604'],
  ['manganese', 'Manganese ore', 'ores', 'bulk', 't', 1, 200, 0, 0.30, 0.5, 'steel', '2602'],
  ['clinker', 'Cement clinker', 'ores', 'bulk', 't', 1, 50, 0, 0.20, 0.5, 'steel', '252310'],
  ['salt', 'Salt', 'ores', 'bulk', 't', 1, 50, 0, 0.15, 0.5, 'grain', '2501'],
  // ---- crude, refined fuels, liquid chemicals and oils (11) ----
  ['crude', 'Crude oil', 'energy', 'liquid:crude', 't', 1, 550, 0, 0.30, 0.55, 'fuel', '2709'],
  ['fuel', 'Gas oil / diesel (bunker grade)', 'energy', 'liquid:clean', 't', 1, 700, 650, 0.10, 0.75, 'fuel', '271019'],
  ['gasoline', 'Petrol', 'energy', 'liquid:clean', 't', 1, 750, 0, 0.25, 0.75, 'fuel', '271012'],
  ['jet', 'Jet fuel', 'energy', 'liquid:clean', 't', 1, 720, 0, 0.25, 0.75, 'fuel', '271019'],
  ['naphtha', 'Naphtha', 'energy', 'liquid:clean', 't', 1, 650, 0, 0.25, 0.75, 'fuel', '271012'],
  ['fueloil', 'Heavy fuel oil', 'energy', 'liquid:crude|liquid:clean', 't', 1, 450, 0, 0.25, 0.6, 'fuel', '271019'],
  ['chemicals', 'Bulk chemicals', 'energy', 'liquid:chem', 't', 1, 900, 0, 0.20, 1.2, 'fuel', '29'],
  ['methanol', 'Methanol', 'energy', 'liquid:chem', 't', 1, 350, 0, 0.25, 1.2, 'fuel', '290511'],
  ['palmoil', 'Palm oil', 'energy', 'liquid:chem|liquid:clean', 't', 1, 950, 0, 0.30, 1.0, 'grain', '1511'],
  ['vegoil', 'Vegetable oils (soy, sunflower, rapeseed)', 'energy', 'liquid:chem|liquid:clean', 't', 1, 1000, 0, 0.30, 1.0, 'grain', '1507,1512,1514'],
  ['ethanol', 'Ethanol', 'energy', 'liquid:chem', 't', 1, 600, 0, 0.25, 1.2, 'fuel', '2207'],
  // ---- gases (3) ----
  ['lng', 'LNG', 'gas', 'gas:lng', 'm3', 0.45, 570, 0, 0.40, 1.8, 'fuel', '271111'],
  ['lpg', 'LPG', 'gas', 'gas:lpg', 'm3', 0.55, 600, 0, 0.35, 1.4, 'fuel', '271112,271113'],
  ['ammonia', 'Ammonia', 'gas', 'gas:lpg', 'm3', 0.68, 400, 0, 0.35, 1.4, 'fuel', '2814'],
  // ---- chilled and frozen food, flowers (13) ----
  ['fish', 'Fish (pelagic and whitefish, landed)', 'reefer', 'fish|reefer|breakbulk', 't', 1, 1000, 700, 0.30, 1.6, 'fish', '0302,0303', 240],
  ['salmon', 'Salmon (fresh/frozen)', 'reefer', RF, 't', 1, 8000, 0, 0.35, 1.6, 'fish', '030214,030313', 240],
  ['shrimp', 'Shrimp (frozen)', 'reefer', RF, 't', 1, 8000, 0, 0.30, 1.6, 'fish', '030617', 720],
  ['tuna', 'Tuna (frozen)', 'reefer', RF, 't', 1, 1700, 0, 0.30, 1.6, 'fish', '030341,030342', 720],
  ['bananas', 'Bananas', 'reefer', RF, 't', 1, 1100, 0, 0.40, 1.6, 'grain', '0803', 480],
  ['citrus', 'Citrus fruit', 'reefer', RF, 't', 1, 900, 0, 0.45, 1.6, 'grain', '0805', 720],
  ['apples', 'Apples, pears and grapes', 'reefer', RF, 't', 1, 1100, 0, 0.40, 1.6, 'grain', '0806,0808', 720],
  ['avocados', 'Avocados', 'reefer', RF, 't', 1, 2500, 0, 0.45, 1.6, 'grain', '080440', 480],
  ['beef', 'Beef (frozen)', 'reefer', RF, 't', 1, 5000, 0, 0.30, 1.6, 'grain', '0202', 2160],
  ['pork', 'Pork (frozen)', 'reefer', RF, 't', 1, 2500, 0, 0.30, 1.6, 'grain', '0203', 2160],
  ['poultry', 'Poultry (frozen)', 'reefer', RF, 't', 1, 2000, 0, 0.30, 1.6, 'grain', '0207', 2160],
  ['cheese', 'Cheese and butter', 'reefer', RF, 't', 1, 4500, 0, 0.20, 1.6, 'grain', '0405,0406', 1440],
  ['flowers', 'Cut flowers', 'reefer', RF, 't', 1, 6000, 0, 0.50, 1.6, 'grain', '0603', 168],
  // ---- container goods (17) ----
  ['containers', 'Mixed consumer goods', 'box', 'box', 'teu', 12, 6000, 2100, 0.12, 1.3, 'containers', '9403,9503,6403'],
  ['electronics', 'Electronics', 'box', 'box', 'teu', 12, 40000, 0, 0.12, 1.3, 'machinery', '8471,8517'],
  ['garments', 'Clothing and footwear', 'box', 'box', 'teu', 12, 15000, 0, 0.15, 1.3, 'containers', '61,62,64'],
  ['furniture', 'Furniture', 'box', 'box', 'teu', 12, 3000, 0, 0.12, 1.3, 'containers', '9401,9403'],
  ['toys', 'Toys and games', 'box', 'box', 'teu', 12, 8000, 0, 0.15, 1.3, 'containers', '9503,9504'],
  ['coffee', 'Green coffee', 'box', 'box', 'teu', 12, 5500, 0, 0.15, 1.3, 'grain', '090111'],
  ['cocoa', 'Cocoa beans', 'box', 'box', 'teu', 12, 7000, 0, 0.20, 1.3, 'grain', '1801'],
  ['tea', 'Tea', 'box', 'box', 'teu', 12, 3000, 0, 0.15, 1.3, 'grain', '0902'],
  ['cotton', 'Raw cotton', 'box', 'box|breakbulk', 'teu', 12, 1600, 0, 0.20, 1.3, 'grain', '5201'],
  ['rubber', 'Natural rubber', 'box', 'box|breakbulk', 'teu', 12, 1800, 0, 0.25, 1.3, 'containers', '4001'],
  ['wine', 'Wine', 'box', 'box', 'teu', 12, 4000, 0, 0.15, 1.3, 'containers', '2204'],
  ['spirits', 'Whisky, cognac and rum', 'box', 'box', 'teu', 12, 12000, 0, 0.12, 1.3, 'containers', '2208'],
  ['chocolate', 'Chocolate', 'box', 'box', 'teu', 12, 9000, 0, 0.15, 1.3, 'containers', '1806'],
  ['pharma', 'Medicines', 'box', 'box', 'teu', 12, 60000, 0, 0.10, 1.3, 'machinery', '3004'],
  ['autoparts', 'Car parts', 'box', 'box', 'teu', 12, 8000, 0, 0.12, 1.3, 'machinery', '8708'],
  ['polymers', 'Plastics (polymer pellets)', 'box', 'box', 'teu', 12, 1100, 0, 0.20, 1.3, 'containers', '3901,3902'],
  ['milkpowder', 'Milk powder', 'box', 'box', 'teu', 12, 3500, 0, 0.20, 1.3, 'grain', '0402'],
  // ---- breakbulk and project cargo (9) ----
  ['steel', 'Steel coils', 'breakbulk', 'breakbulk|bulk', 't', 1, 650, 900, 0.25, 1.0, 'steel', '7208'],
  ['pipes', 'Steel pipe and sections', 'breakbulk', 'breakbulk', 't', 1, 1200, 0, 0.20, 1.0, 'steel', '7304,7305,7216'],
  ['copper', 'Copper cathode', 'breakbulk', 'breakbulk|box', 't', 1, 9500, 0, 0.20, 1.0, 'steel', '7403'],
  ['aluminium', 'Aluminium ingots', 'breakbulk', 'breakbulk|box', 't', 1, 2500, 0, 0.20, 1.0, 'steel', '7601'],
  ['lumber', 'Sawn timber', 'breakbulk', 'breakbulk', 't', 1, 450, 0, 0.25, 1.0, 'containers', '4407'],
  ['logs', 'Logs', 'breakbulk', 'breakbulk|bulk', 't', 1, 150, 0, 0.25, 0.75, 'containers', '4403'],
  ['pulp', 'Wood pulp', 'breakbulk', 'breakbulk', 't', 1, 700, 0, 0.25, 1.0, 'containers', '4703'],
  ['machinery', 'Machinery', 'breakbulk', 'breakbulk|box', 't', 1, 10000, 3200, 0.10, 1.0, 'machinery', '84'],
  ['project', 'Project cargo (transformers, turbine parts)', 'breakbulk', 'heavy', 't', 1, 16000, 0, 0.10, 2.5, 'machinery', '8502,8504'],
  // ---- vehicles (3) ----
  ['vehicles', 'New cars', 'vehicles', 'roro', 'ceu', 1.5, 20000, 0, 0.12, 1.6, 'machinery', '8703'],
  ['trailers', 'Trucks and trailers', 'vehicles', 'roro', 'lm', 2.2, 5000, 0, 0.12, 1.6, 'machinery', '8704,8716'],
  ['tractors', 'Farm and construction machines', 'vehicles', 'roro|heavy', 'ceu', 4.0, 8000, 0, 0.12, 1.6, 'machinery', '8701,8429'],
  // ---- live animals (2) ----
  ['livestock', 'Live cattle', 'animals', 'livestock', 'head', 0.5, 2700, 0, 0.25, 1.8, 'grain', '0102', 720],
  ['sheep', 'Live sheep', 'animals', 'livestock', 'head', 0.05, 3000, 0, 0.25, 1.8, 'grain', '0104', 720],
  // ---- offshore (1) ----
  ['supplies', 'Offshore supplies', 'offshore', 'deck|breakbulk', 't', 1, 1800, 1800, 0.10, 1.0, 'supplies', ''],
];

/** §4.1 base rule: refUsdT up to 1,000 as is, above that 1,000 × √(ref / 1,000), capped at 8,000. */
export function baseFor(refUsdT) { return refUsdT <= 1000 ? Math.round(refUsdT) : Math.min(8000, Math.round(1000 * Math.sqrt(refUsdT / 1000))); }

/** Game levers per good (balance pass, §10): the bunker grade's landed term is capped so running costs stay predictable. */
const LEVERS = { fuel: { landMax: 0.05 } };   // T4: even a strike-drained importer (σ at +1.5 S) stays within +25 %

export const LEGACY_GOODS = ['fish', 'grain', 'steel', 'machinery', 'containers', 'fuel', 'supplies'];

export const CATALOGUE = ROWS.map(([id, name, cat, hand, unit, tPer, refUsdT, legacyBase, S, fmul, polGroup, hs, perishH]) => Object.freeze({
  id, name, cat, unit, tPer, refUsdT, base: legacyBase > 0 ? legacyBase : baseFor(refUsdT), S, fmul,
  perishH: perishH ?? null, hs: hs ? hs.split(',') : [], polGroup, icon: CATS.find((c) => c.id === cat).icon,
  opts: hand.split('|').map((x) => (x.endsWith('+plugs') ? { h: x.slice(0, -6), plugs: true } : { h: x })),
  legacy: legacyBase > 0 || undefined, ...(LEVERS[id] || {}),
}));
export const ECON_GOODS = CATALOGUE.map((r) => r.id);
const BY_ID = new Map(CATALOGUE.map((r) => [r.id, r]));
/** Catalogue row or null. */
export function catalogueOf(id) { return BY_ID.get(id) || null; }
export const CAT_INDEX = Object.fromEntries(CATS.map((c, i) => [c.id, i]));
