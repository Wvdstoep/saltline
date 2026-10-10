// Processing chains (docs/WORLD-ECONOMY-CONTRACT.md §8.1): inputs per 1 t of the MAIN output, co-outputs per 1 t of the
// main output (game, rounded from industry averages). Data only (E1); plain ESM, browser-safe.
//
// Multi-output chains are written per tonne of their main output: the refinery's main output is gas oil (0.35 t per t
// of crude), so 1 t of gas oil needs 1 / 0.35 t of crude and comes with 0.30 / 0.35 t of petrol, and so on.
const r4 = (v) => Math.round(v * 1e4) / 1e4;
const REF = { gasoline: 0.30, fuel: 0.35, jet: 0.10, naphtha: 0.08, fueloil: 0.12 };

export const CHAINS = {
  steel: { name: 'Steelworks', main: 'steel', inputs: { ore: 1.6, cokingcoal: 0.75 }, co: {} },
  refinery: { name: 'Refinery', main: 'fuel', inputs: { crude: r4(1 / REF.fuel) }, co: { gasoline: r4(REF.gasoline / REF.fuel), jet: r4(REF.jet / REF.fuel), naphtha: r4(REF.naphtha / REF.fuel), fueloil: r4(REF.fueloil / REF.fuel) } },
  cocoa: { name: 'Chocolate factory', main: 'chocolate', inputs: { cocoa: 0.4, sugar: 0.35, milkpowder: 0.15 }, co: {} },
  soycrush: { name: 'Soy crusher', main: 'soymeal', inputs: { soybeans: r4(1 / 0.79) }, co: { vegoil: r4(0.19 / 0.79) } },
  alumina: { name: 'Alumina refinery', main: 'alumina', inputs: { bauxite: 2.5 }, co: {} },
  smelter: { name: 'Aluminium smelter', main: 'aluminium', inputs: { alumina: 1.93 }, co: {} },
  copper: { name: 'Copper smelter', main: 'copper', inputs: { copperconc: 3.5 }, co: {} },
  ammonia: { name: 'Ammonia plant', main: 'ammonia', inputs: { lng: 0.75 }, co: {} },
  urea: { name: 'Urea plant', main: 'urea', inputs: { ammonia: 0.57 }, co: {} },
  pulp: { name: 'Pulp mill', main: 'pulp', inputs: { logs: 3.5 }, co: {} },
  crackers: { name: 'Steam cracker', main: 'polymers', inputs: { naphtha: 1.25 }, co: {} },
  cars: { name: 'Car plant', main: 'vehicles', inputs: { steel: 0.8, autoparts: 0.35, polymers: 0.15 }, co: {} },
  garments: { name: 'Garment factories', main: 'garments', inputs: { cotton: 1.2 }, co: {} },
};
/** The goods a chain makes (main first). */
export function chainOutputs(c) { return [c.main, ...Object.keys(c.co || {})]; }
