// Seasons (docs/WORLD-ECONOMY-CONTRACT.md §6.5): smooth yearly bumps on production (P) or consumption (C) with a yearly
// mean of exactly 1. Data only (E1); plain ESM, browser-safe.
//
// Row: { good, side: 'P'|'C', peak: 'MM-DD', W: days, A, hemi, cc?: [...], latMin?: |lat| floor, importers?: true, why }
//
// Balance pass (§10 T5, game): the §6.5 seed amplitudes on the PRODUCTION side (A 1.2–2.0) put every tier-1 maker's
// equilibrium above the glut clamp (s* > 2.23 n, σ at −0.8) for 20–27 % of the year, so harvest rows use A 0.55–0.6
// here (peak s* ≈ 2.2 n, the price still dips ≈ 7 % at harvest). The pure `bump` formula is unchanged and is tested
// with the contract's numbers in test/econ-model.test.mjs. Consumption rows keep the contract's amplitudes.
export const HARVEST_A = 0.5;
// T5 again: the year-end holiday row (A 1.0) drives tier-1 importers to the shortage clamp for ≈ 10–11 % of the year;
// A 0.85 keeps it near 7 % (the peak still lifts demand 1.73×).
export const HOLIDAY_A = 0.85;

export const SEASONS = [
  { good: 'grain', side: 'P', peak: '08-01', W: 60, A: HARVEST_A, hemi: true, why: 'harvest' },
  { good: 'maize', side: 'P', peak: '10-15', W: 60, A: HARVEST_A, hemi: true, why: 'harvest' },
  { good: 'maize', side: 'P', peak: '07-15', W: 60, A: HARVEST_A, hemi: false, cc: ['BR'], why: 'harvest' },   // safrinha
  { good: 'soybeans', side: 'P', peak: '10-15', W: 60, A: HARVEST_A, hemi: false, why: 'harvest' },
  { good: 'soybeans', side: 'P', peak: '04-01', W: 60, A: HARVEST_A, hemi: false, cc: ['BR', 'AR', 'UY'], why: 'harvest' },
  { good: 'coffee', side: 'P', peak: '07-15', W: 75, A: HARVEST_A, hemi: false, cc: ['BR'], why: 'harvest' },
  { good: 'coffee', side: 'P', peak: '12-15', W: 75, A: HARVEST_A, hemi: false, cc: ['VN'], why: 'harvest' },
  { good: 'cocoa', side: 'P', peak: '12-01', W: 75, A: HARVEST_A, hemi: false, cc: ['CI', 'GH', 'CM'], why: 'harvest' },
  { good: 'sugar', side: 'P', peak: '08-01', W: 90, A: 0.55, hemi: false, cc: ['BR'], why: 'harvest' },
  { good: 'sugar', side: 'P', peak: '02-01', W: 90, A: 0.55, hemi: false, cc: ['TH', 'IN'], why: 'harvest' },
  { good: 'citrus', side: 'P', peak: '01-15', W: 60, A: HARVEST_A, hemi: true, why: 'harvest' },
  { good: 'apples', side: 'P', peak: '10-01', W: 50, A: HARVEST_A, hemi: true, why: 'harvest' },
  ...['fuel', 'coal', 'lng', 'lpg', 'fueloil'].map((good) => ({ good, side: 'C', peak: '01-15', W: 75, A: 0.6, hemi: true, latMin: 30, why: 'winter' })),
  ...['toys', 'electronics', 'spirits', 'chocolate', 'wine', 'garments'].map((good) => ({ good, side: 'C', peak: '11-25', W: 40, A: HOLIDAY_A, hemi: false, importers: true, why: 'holiday' })),
  { good: 'flowers', side: 'C', peak: '02-07', W: 10, A: 1.5, hemi: false, why: 'valentine' },
  { good: 'flowers', side: 'C', peak: '05-05', W: 10, A: 0.8, hemi: false, why: 'mothers' },
  { good: 'ore', side: 'P', peak: '07-20', W: 60, A: -0.6, hemi: false, cc: ['IN'], why: 'monsoon' },
  { good: 'coal', side: 'P', peak: '07-20', W: 60, A: -0.6, hemi: false, cc: ['IN'], why: 'monsoon' },
];

/** Ice (§6.5, game): harbours tagged `ice` run at rMul × ICE.rMul and fP × 0.6 from 01-01 to 03-31. The contract's
 *  rMul 0.5 drains a tier-1 importer in an ice port to the shortage clamp for the whole quarter (25 % of the year, T5),
 *  so ice halves only ~25 % of the AI calls (rMul 0.75). */
export const ICE = { from: '01-01', to: '03-31', rMul: 0.75, fP: 0.6 };

/** Plain-words labels (E8). */
export const SEASON_WORDS = { harvest: 'Harvest in', winter: 'Winter demand', holiday: 'Holiday buying', valentine: "Valentine's Day", mothers: "Mother's Day", monsoon: 'Monsoon slowdown', ice: 'Ice season' };
