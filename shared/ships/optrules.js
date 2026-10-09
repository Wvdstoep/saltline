// Option tokens and their model-level rules (docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §2.5). No imports, so both the
// catalogue (each model's `options` list) and options.js (variant ids) can use it without an import cycle.

/** Canonical group order of a variant id: `<model>~engine.ice.gear.esd.rot.air.spec`. */
export const GROUPS = ['engine', 'ice', 'gear', 'esd', 'rot', 'air', 'spec'];

// price/burn multiply; fuelCost = cost per tonne of fuel; yard = the yard `opts` entry needed (null = any yard).
// Source/Game-rule tags as in §2.5.
export const OPTIONS = {
  scr: { group: 'engine', label: 'Exhaust-gas scrubber', price: 1.03, burn: 1.02, fuelCost: 0.80, eco: 0, ecaExempt: true, yard: 'scr', basis: 'Source [S10] MARPOL VI reg. 4/14' },
  lng: { group: 'engine', label: 'LNG dual-fuel', price: 1.15, burn: 0.86, fuelCost: 0.95, eco: 1, ecaExempt: true, lngBunkers: true, yard: 'lng', basis: 'LHV LNG ≈ 49 vs VLSFO ≈ 41 MJ/kg [S11]' },
  meoh: { group: 'engine', label: 'Methanol dual-fuel', price: 1.12, burn: 2.10, fuelCost: 0.65, eco: 2, ecaExempt: true, fuelCapMul: 2.1, yard: 'meoh', basis: 'LHV methanol ≈ 20 MJ/kg [S11]' },
  hyb: { group: 'engine', label: 'Battery hybrid', price: 1.08, burn: 1, fuelCost: 1, eco: 1, partLoad: { below: 0.5, mul: 0.88, above: 1 }, silentKn: 3, yard: 'hyb', basis: 'Game rule' },
  de: { group: 'engine', label: 'Diesel-electric', price: 1.06, burn: 1.03, fuelCost: 1, eco: 0, partLoad: { below: 0.6, mul: 0.92 / 1.03, above: 1 }, genFailPower: 0.25, yard: 'de', basis: 'Game rule' },
  i1c: { group: 'ice', label: 'Ice class 1C', price: 1.02, burn: 1.01, iceWear: 0.7, ice: 'i1c', yard: null, basis: 'Source [S12] FSICR' },
  i1b: { group: 'ice', label: 'Ice class 1B', price: 1.04, burn: 1.02, iceWear: 0.55, ice: 'i1b', yard: null, basis: 'Source [S12] FSICR' },
  i1a: { group: 'ice', label: 'Ice class 1A', price: 1.07, burn: 1.03, iceWear: 0.4, ice: 'i1a', yard: null, basis: 'Source [S12] FSICR' },
  i1as: { group: 'ice', label: 'Ice class 1A Super', price: 1.12, burn: 1.05, iceWear: 0.3, ice: 'i1as', yard: null, basis: 'Source [S12] FSICR' },
  pc6: { group: 'ice', label: 'Polar Class 6', price: 1.10, burn: 1.04, iceWear: 0.25, ice: 'pc6', yard: 'pc', basis: 'Source [S13] IACS UR I2' },
  pc4: { group: 'ice', label: 'Polar Class 4', price: 1.20, burn: 1.07, iceWear: 0.15, ice: 'pc4', yard: 'pc', basis: 'Source [S13] IACS UR I2' },
  geared: { group: 'gear', label: 'Own cranes', price: 1.06, burn: 1, capMul: 0.98, yard: null, basis: 'Game rule' },
  gearless: { group: 'gear', label: 'No cranes', price: 1 / 1.06, burn: 1, capMul: 1 / 0.98, yard: null, basis: 'Game rule' },
  esd: { group: 'esd', label: 'Energy-saving pack', price: 1.015, burn: 0.95, ecoDevice: true, yard: null, basis: 'Game rule (vendor claims 3–8 %)' },
  rot: { group: 'rot', label: 'Rotor sails', price: 1.03, burn: 0.93, ecoDevice: true, airDraftAdd: 35, rotor: { base: 0.85, wind: 0.15 }, yard: 'rot', basis: 'Game rule (published trials 5–25 %)' },
  air: { group: 'air', label: 'Air lubrication', price: 1.02, burn: 0.95, ecoDevice: true, yard: 'air', basis: 'Game rule' },
  eco: { group: 'spec', label: 'Economy finish', price: 0.92, burn: 1, reliability: 0.95, wearMul: 1.08, comfort: -1, resale: 0.95, yard: null, basis: 'Game rule' },
  prem: { group: 'spec', label: 'Premium finish', price: 1.12, burn: 1, reliability: 1.07, wearMul: 0.93, comfort: 1, resale: 1.05, yard: null, basis: 'Game rule' },
};
export const TOKENS = Object.keys(OPTIONS);
export const GROUP_TOKENS = Object.fromEntries(GROUPS.map((g) => [g, TOKENS.filter((t) => OPTIONS[t].group === g)]));
const ICE_RANK = { i1c: 1, i1b: 2, i1a: 3, i1as: 4, pc6: 5, pc4: 6, pc3: 7 };

const HYB_TYPES = new Set(['workboat', 'tug', 'pilot', 'ferry', 'offshore', 'motor_yacht']);
const DE_TYPES = new Set(['offshore', 'special', 'cruise']);
const ROT_TYPES = new Set(['tanker', 'bulk', 'roro', 'general']);
const POLAR_MODELS = new Set(['expedition105', 'research75', 'explorer45']);
const ok = { ok: true };
const no = (why) => ({ ok: false, why });
/** Planing / fast hulls are not "displacement hulls" for the ice rules. */
export function planing(m) { return m.gen === 'small_fast' || m.id === 'hsc112' || (m.type === 'motor_yacht' && m.length < 30); }

/** Model-level rule for one token (the yard check is in index.js optionAllowed). → { ok, why? } */
export function modelAllows(m, token) {
  const o = OPTIONS[token];
  if (!m || !o) return no('Unknown option.');
  if (m.type === 'sail_yacht' && o.group !== 'spec') return no('Sailing yachts take only a finish option here.');
  const eng = m.defaults?.engine || 'vlsfo', gt = m.gt || 0;
  switch (token) {
    case 'scr':
      if (eng !== 'vlsfo') return no('Her engines do not burn heavy fuel oil.');
      if (gt < 10000) return no('A scrubber needs a ship of 10,000 GT or more.');
      if ((m.type === 'cruise' || m.type === 'ferry') && gt < 20000) return no('A passenger ship needs 20,000 GT or more for a scrubber.');
      return ok;
    case 'lng': case 'meoh':
      if (eng !== 'vlsfo') return no(eng === 'lng' ? 'She already burns LNG.' : 'Dual-fuel needs a conventional engine plant.');
      return gt >= 5000 ? ok : no(`${o.label} needs a ship of 5,000 GT or more.`);
    case 'hyb':
      if (!(HYB_TYPES.has(m.type) || m.id === 'expedition105')) return no('Battery hybrid is for workboats, tugs, ferries, offshore ships and yachts.');
      return /battery/.test(m.engine?.label || '') ? no('She is already a battery hybrid.') : ok;
    case 'de':
      if (!DE_TYPES.has(m.type)) return no('Diesel-electric is for offshore, special and cruise ships.');
      return eng === 'de' ? no('She is already diesel-electric.') : ok;
    case 'i1c': case 'i1b': case 'i1a': case 'i1as':
      if (planing(m)) return no('Ice class needs a displacement hull.');
      if (m.length < 20) return no(`${o.label} needs a hull ≥ 20 m.`);
      if ((ICE_RANK[m.ice] || 0) >= ICE_RANK[token]) return no(`She is already ${m.ice.toUpperCase()}.`);
      return ok;
    case 'pc6': case 'pc4':
      if (!POLAR_MODELS.has(m.id)) return no('Polar Class is offered on expedition, research and explorer hulls.');
      if ((ICE_RANK[m.ice] || 0) >= ICE_RANK[token]) return no(`She is already ${m.ice.toUpperCase()}.`);
      return ok;
    case 'geared': case 'gearless':
      if (!m.defaults?.gear) return no('Cranes are an option on general cargo ships, bulk carriers up to Kamsarmax and feeders up to 1,700 TEU.');
      return m.defaults.gear === token ? no(token === 'geared' ? 'She has her own cranes already.' : 'She has no cranes already.') : ok;
    case 'esd': return m.length >= 50 ? ok : no('The energy-saving pack needs a hull ≥ 50 m.');
    case 'rot': return ROT_TYPES.has(m.type) && m.length >= 120 ? ok : no('Rotor sails fit tankers, bulk, ro-ro and general cargo ships ≥ 120 m.');
    case 'air': return (m.type === 'container' && (m.units?.teu || 0) >= 2800) || m.id === 'lng174k' || m.id === 'pctc7000' || m.type === 'cruise'
      ? ok : no('Air lubrication fits container ships ≥ 2,800 TEU, LNG carriers, car carriers and cruise ships.');
    case 'eco': case 'prem': return ok;
    default: return no('Unknown option.');
  }
}
/** Every token the model can take (yard-independent). */
export function modelOptions(m) { return TOKENS.filter((t) => modelAllows(m, t).ok); }
/** Eco grade with options (A best … E worst): lng +1, meoh +2, hyb +1, esd/rot/air +1 together at most; clamped to A. */
export function ecoGrade(start, tokens) {
  const grades = 'ABCDE';
  let i = Math.max(0, grades.indexOf(start || 'C'));
  let dev = false;
  for (const t of tokens) { const o = OPTIONS[t]; if (!o) continue; i -= o.eco || 0; if (o.ecoDevice) dev = true; }
  if (dev) i -= 1;
  return grades[Math.max(0, Math.min(4, i))];
}
