// Inland barges by CEMT class (docs/BRIDGES-LOCKS-VHF-CONTRACT.md §7.6, lane D "rows only"). Eight new models in the
// frozen `Model` shape of shared/ships/catalogue.js (docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §2.2), the game fields
// derived with the same §2.4 formulas (catalogue.js exports them), plus each model's air-draught row (§4.4: hydraulic
// wheelhouse up/down +5.5 m, folding masts) and its CEMT class.
//
// NOT wired into the catalogue yet: shared/ships/index.js exports MODELS from catalogue.js only. The integration pass
// merges BARGE_MODELS (docs/WATERWAYS-HARBOURS-PHASE2.md §5). Until then `withBarges(src)` gives tests and the job
// generator a ship source (shared/jobs/shipview.js setShipSource) that knows them.
//
// Reference figures are typical for the class ("Source ≈", verify: true): CEMT dimensions (UNECE AGN / ECMT 1992
// resolution 92/2), typical payloads of Dutch inland fleets. Deviation from the contract table, flagged for review:
// the kempenaar is 6.60 m wide (the defining CEMT II beam), not 7.2 m; at 7.2 m she would not fit the class she defines.
// Plain ESM, browser-safe; imports only catalogue.js / optrules.js (no constants.js, so no import cycle).
import { displacementOf, cargoPrice, roundPrice, crewCostOf, turnRateOf, fuelCapOf, DERIVE, TYPE_CAT } from './catalogue.js';
import { modelOptions } from './optrules.js';

// id, type, reference name, short, L, B, T, depth, cap t, dwt, gt, maxKn, svcKn, kW, engine label, sfoc, crew min, crew opt,
// ref. USD m, Cb, range nm, cemt, extra { teu, m3, holds, tiers, hand, eq, color, desc }
const SRC = [
  ['spits38', 'general', 'Spits 38.5 m (CEMT I)', 'Spits', 38.5, 5.05, 2.5, 2.8, 350, 390, 200, 8.5, 7, 250, '1x HS diesel', 220, 2, 2, 0.6, 0.88, 2000, 'I',
    { holds: 1, hand: ['bulk', 'breakbulk'], color: 0x2d3f5a, desc: 'The smallest freighter of the canals: 350 tonnes through every lock in the land.' }],
  ['kempenaar55', 'general', 'Kempenaar 55 m (CEMT II)', 'Kempenaar', 55, 6.6, 2.5, 2.9, 600, 670, 350, 9, 7, 400, '1x HS diesel', 215, 2, 3, 1.2, 0.88, 2500, 'II',
    { holds: 1, hand: ['bulk', 'breakbulk'], color: 0x2d4a3a, desc: 'Built for the Kempen canals: sand, grain and fertiliser to every village quay.' }],
  ['dortmunder67', 'general', 'Dortmund-Ems vessel 67 m (CEMT III)', 'Dortmunder', 67, 8.2, 2.5, 3.0, 1000, 1110, 600, 9.5, 7.5, 600, '1x MS diesel', 210, 2, 3, 2.0, 0.88, 3000, 'III',
    { holds: 1, hand: ['bulk', 'breakbulk'], color: 0x4a3a2d, desc: 'The classic 1,000-tonner of the German and Dutch canals.' }],
  ['rhk85', 'general', 'Rhine–Herne vessel 85 m (CEMT IV)', 'Rhine–Herne', 85, 9.5, 2.8, 3.2, 1350, 1500, 900, 10, 8, 800, '1x MS diesel', 210, 3, 3, 3.0, 0.88, 3000, 'IV',
    { holds: 2, hand: ['bulk', 'breakbulk'], color: 0x3a4a6b, desc: 'Sized for the Rhine–Herne canal locks: the backbone of the inland dry-cargo fleet.' }],
  ['grk110', 'general', 'Large Rhine vessel 110 m (CEMT Va)', 'Large Rhine', 110, 11.45, 3.5, 4.0, 3000, 3330, 1900, 11, 8.5, 1500, '1x MS diesel', 205, 3, 4, 5.5, 0.88, 3000, 'Va',
    { holds: 3, hand: ['bulk', 'breakbulk'], color: 0x1e3a5f, desc: 'The big Rhine freighter: 3,000 tonnes from Rotterdam to Basel.' }],
  ['cbarge135', 'container', 'Container barge 135 m (Vb-size motor vessel)', 'Container barge', 135, 11.45, 3.7, 4.2, 2500, 2780, 2700, 11.5, 9, 2000, '2x MS diesel', 210, 4, 5, 9.0, 0.88, 3000, 'Vb',
    { teu: 208, tiers: 4, holds: 1, hand: ['box'], color: 0x24507a, desc: 'Four tiers of boxes from the sea terminals to the inland hubs, wheelhouse down for the low bridges.' }],
  ['tbarge110', 'tanker', 'Tanker barge 110 m, double hull (CEMT Va)', 'Tanker barge', 110, 11.45, 3.5, 4.2, 2380, 2650, 2100, 11, 8.5, 1500, '1x MS diesel', 205, 4, 5, 8.0, 0.88, 3000, 'Va',
    { m3: 2800, hand: ['liquid:clean'], eq: ['cargoPumps'], color: 0x5a1f1f, desc: 'Double-hulled 2,800 m³ product tanker for diesel, gasoline and biofuel on the rivers.' }],
  ['push4', 'bulk', 'Four-barge push convoy 193 m (CEMT VIb)', 'Push convoy', 193, 22.8, 3.9, 4.6, 11000, 12200, 6000, 9, 7, 4000, '3x MS diesel', 205, 6, 8, 20.0, 0.9, 3000, 'VIb',
    { holds: 4, hand: ['bulk'], color: 0x2a2a2a, desc: 'A pusher and four Europa IIa barges: 11,000 tonnes of ore or coal up the Rhine in one go.' }],
];

/**
 * §4.4 air-draught rows (keel heights in m; kTop = highest fixed point in the LOWERED state; up = added when raised).
 * Containers: holdTeu below the coaming, deckSlots TEU per deck tier, hatchTop = keel → coaming top. Game rule, verify.
 */
export const BARGE_AD = Object.freeze({
  spits38: { tLight: 0.6, tDesign: 2.5, kTop: 4.6, up: { wheelhouse: 5.5, mast: 1.5 }, ballastMax: 40, pumpTph: 150 },
  kempenaar55: { tLight: 0.7, tDesign: 2.5, kTop: 4.9, up: { wheelhouse: 5.5, mast: 1.5 }, ballastMax: 70, pumpTph: 150 },
  dortmunder67: { tLight: 0.8, tDesign: 2.5, kTop: 5.2, up: { wheelhouse: 5.5, mast: 1.5 }, ballastMax: 120, pumpTph: 150 },
  rhk85: { tLight: 0.9, tDesign: 2.8, kTop: 5.6, up: { wheelhouse: 5.5, mast: 1.5 }, ballastMax: 160, pumpTph: 150 },
  grk110: { tLight: 1.0, tDesign: 3.5, kTop: 6.4, up: { wheelhouse: 5.5, mast: 1.5 }, ballastMax: 350, pumpTph: 150 },
  cbarge135: { tLight: 1.2, tDesign: 3.7, kTop: 6.2, up: { wheelhouse: 5.5, mast: 1.5 }, hatchTop: 4.9, holdTeu: 104, deckSlots: 52, ballastMax: 400, pumpTph: 200 },
  tbarge110: { tLight: 1.0, tDesign: 3.5, kTop: 6.0, up: { wheelhouse: 5.5, mast: 1.5 }, ballastMax: 300, pumpTph: 150 },
  push4: { tLight: 0.9, tDesign: 3.9, kTop: 7.6, up: { wheelhouse: 5.5, mast: 1.5 }, ballastMax: 0, pumpTph: 0 },
});

const rnd = (v, d = 0) => { const k = 10 ** d; return Math.round(v * k) / k; };
function build(row) {
  const [id, type, refName, short, L, B, T, depth, cap, dwt, gt, maxKn, svcKn, kW, engLabel, sfoc, crewMin, crewOpt, usdM, Cb, range, cemt, x] = row;
  const burn = rnd(kW * sfoc / 1e6, 3);
  const price = roundPrice(cargoPrice(cap, DERIVE.CARGO_TYPE_MUL[type] || 1));
  const units = { t: cap, pax: 2 };
  if (x.teu) units.teu = x.teu;
  if (x.m3) units.m3 = x.m3;
  if (x.holds) units.holds = x.holds;
  if (type === 'tanker') units.segregations = 2;
  const n = /^(\d)x/.exec(engLabel) ? Number(/^(\d)x/.exec(engLabel)[1]) : 1;
  const engine = { kind: /HS diesel/.test(engLabel) ? 'hs' : '4s', fuel: 'mgo', n, label: engLabel };
  const ad = BARGE_AD[id];
  const m = {
    id, cat: TYPE_CAT[type], name: refName, length: L, beam: B, draft: T, maxKn,
    turnRate: turnRateOf(type, L), displacement: displacementOf(L, B, T, Cb), capacity: cap, pax: 2,
    fuelCap: fuelCapOf(range, svcKn, burn), burn, price, hullColor: x.color, fishRate: 0, wearMul: 1.0,
    crewCost: crewCostOf(type, crewOpt, gt), desc: x.desc,
    type, gen: 'inland_barge', base: 'coaster', refName, short, size: `CEMT ${cemt}`, era: 'eco',
    depth, airDraft: null, dwt, gt, capText: x.teu ? `${x.teu} TEU, ${x.tiers} tiers` : x.m3 ? `${x.m3.toLocaleString('en-US')} m³` : `${cap.toLocaleString('en-US')} t`,
    kW, sfoc, svcKn, crew: { min: crewMin, opt: crewOpt }, engine, usdM, buildMonths: 8, rangeNm: range, Cb,
    units, eq: ['wheelhouseHyd', 'foldMasts', ...(x.eq || [])], handling: x.hand, bp: 0, ice: null,
    stats: null, options: null, defaults: { engine: 'vlsfo' }, builders: ['inland'], minPort: 'minor', tags: ['inland', `cemt:${cemt}`], hidden: false, verify: true,
    basis: null, cemt, inland: true,
  };
  // air draught at summer draught, wheelhouse up (the catalogue's displayed number: kTopUp − tDesign)
  const upMax = Math.max(0, ...Object.values(ad.up || {}));
  m.stats = { airDraft: rnd(ad.kTop + upMax - ad.tDesign, 2), thrusters: 'bow', maxHs: 1.2, hull: 0.75, ice: null, reliability: 1.0, comfort: 1, eco: 'B', locker: Math.round(crewOpt * 0.5 + 1) };
  m.airDraft = m.stats.airDraft;
  m.options = modelOptions(m);
  return m;
}

const models = {};
for (const row of SRC) models[row[0]] = build(row);
for (const m of Object.values(models)) { for (const v of Object.values(m)) if (v && typeof v === 'object') Object.freeze(v); Object.freeze(m); }
/** The eight barge models keyed by id (Model shape). */
export const BARGE_MODELS = Object.freeze(models);
export const BARGE_IDS = Object.freeze(Object.keys(models));
export const BARGE_SOURCE_ROWS = SRC;
/** CEMT class of a barge model id (null for every other ship). */
export function bargeCemt(id) { return BARGE_MODELS[String(id ?? '').split('~')[0]]?.cemt ?? null; }
/** The barges whose CEMT class is ≤ `cls` (rank order I … VII). */
export const CEMT_RANKS = Object.freeze(['I', 'II', 'III', 'IV', 'Va', 'Vb', 'VIa', 'VIb', 'VIc', 'VII']);
export function bargesFor(cls) { const r = CEMT_RANKS.indexOf(cls); return BARGE_IDS.filter((id) => CEMT_RANKS.indexOf(BARGE_MODELS[id].cemt) <= r); }

/**
 * A ship source for shared/jobs/shipview.js setShipSource(): `src` (the catalogue lib, shared/ships/index.js) plus the
 * barges. classRow returns the model itself for barges (its game fields are the SHIP_CLASSES shape).
 */
export function withBarges(src = null) {
  const base = src || {};
  return {
    ...base,
    MODELS: { ...(base.MODELS || {}), ...BARGE_MODELS },
    modelOf(cls) { const id = String(cls ?? '').split('~')[0]; if (BARGE_MODELS[id]) return BARGE_MODELS[id]; try { return base.modelOf ? base.modelOf(cls) : base.MODELS?.[id] ?? null; } catch { return null; } },
    classRow(cls) { const id = String(cls ?? '').split('~')[0]; if (BARGE_MODELS[id]) return BARGE_MODELS[id]; try { return base.classRow ? base.classRow(cls) : null; } catch { return null; } },
    basePrice(cls) { const id = String(cls ?? '').split('~')[0]; if (BARGE_MODELS[id]) return BARGE_MODELS[id].price; return base.basePrice ? base.basePrice(cls) : undefined; },
  };
}
