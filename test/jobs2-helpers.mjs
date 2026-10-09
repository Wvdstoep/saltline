// Lane D test helpers: a stub of Lane A's ship catalogue (shared/ships/index.js, frozen interface §7.2) with the rows of
// Appendix A and the handling/units/eq of §5.2 for the models the jobs tests use, plus small fakes. Never imported by
// another suite (each jobs2-* test imports this file only).
import { setShipSource } from '../shared/jobs/shipview.js';
import { harborById } from '../server/harbors.js';

// id, type, cat, LOA, B, T, DWT, maxKn, game price, game cap t, pax, handling, units, eq, extra
const M = (id, type, cat, length, beam, draft, dwt, maxKn, price, capacity, pax, handling, units, eq, extra = {}) => ({
  id, type, cat, base: id, era: 'eco', name: extra.name || id, short: extra.short || id, length, beam, draft, dwt, maxKn, price, capacity, pax,
  handling, units: { t: capacity, pax, ...units }, eq, tags: extra.tags || [], crew: extra.crew || { min: 10, opt: 14 },
  displacement: extra.displacement || Math.round(dwt * 1.3), burn: 1, fuelCap: 500, crewCost: 100, turnRate: 3, wearMul: 1, fishRate: extra.fishRate || 0,
  towPower: extra.bp ? extra.bp / 70 : 0, bp: extra.bp || 0, stats: { comfort: extra.comfort ?? 1, ice: extra.ice ?? null }, hidden: false,
});
export const STUB_MODELS = Object.fromEntries([
  M('handy38', 'bulk', 'cargo', 180, 32, 10.5, 38000, 14.5, 4460000, 34200, 0, ['bulk', 'breakbulk'], { holds: 5 }, ['cranes:4x30', 'grabs'], { short: 'Handysize', tags: ['geared'] }),
  M('ultramax64', 'bulk', 'cargo', 199.9, 32.24, 13.3, 64000, 14.5, 6950000, 57600, 0, ['bulk', 'breakbulk'], { holds: 5 }, ['cranes:4x36', 'grabs'], { short: 'Ultramax', tags: ['geared'] }),
  M('kamsarmax82', 'bulk', 'cargo', 229, 32.26, 14.45, 82000, 14.5, 8580000, 73800, 0, ['bulk', 'breakbulk'], { holds: 7 }, [], { short: 'Kamsarmax' }),
  M('capesize180', 'bulk', 'cargo', 292, 45, 18.2, 180000, 14.5, 16700000, 162000, 0, ['bulk'], { holds: 9 }, [], { short: 'Capesize' }),
  M('vloc400', 'bulk', 'cargo', 362, 65, 23, 400000, 15.5, 33000000, 360000, 0, ['bulk'], { holds: 7 }, [], { short: 'VLOC' }),
  M('chem13k', 'tanker', 'cargo', 128, 20.4, 8.7, 13000, 14, 2660000, 11700, 0, ['liquid:clean', 'liquid:chem'], { segregations: 14 }, [], { short: 'Chemical tanker' }),
  M('bunker85', 'tanker', 'cargo', 85, 15, 5.6, 4500, 12, 800000, 4050, 0, ['liquid:clean'], { m3: 5200, segregations: 2 }, ['hoseCranes'], { short: 'Bunker tanker' }),
  M('mr50', 'tanker', 'cargo', 183, 32.2, 13.3, 50000, 15, 6200000, 45000, 0, ['liquid:clean', 'liquid:chem'], { segregations: 6 }, [], { short: 'MR' }),
  M('aframax115', 'tanker', 'cargo', 250, 44, 15, 115000, 15, 12600000, 103500, 0, ['liquid:crude', 'liquid:clean'], { segregations: 3 }, [], { short: 'Aframax' }),
  M('vlcc300', 'tanker', 'cargo', 333, 60, 22.5, 300000, 15.5, 28400000, 270000, 0, ['liquid:crude'], { segregations: 3 }, [], { short: 'VLCC' }),
  M('lpg5k', 'gas', 'cargo', 99.9, 18, 6.6, 5500, 14, 1550000, 4950, 0, ['gas:lpg'], { m3: 5000 }, [], { short: 'LPG carrier' }),
  M('lngbv7500', 'gas', 'cargo', 100, 19.6, 5.5, 4500, 13, 1890000, 4050, 0, ['gas:lng'], { m3: 7500 }, ['hoseCranes'], { short: 'LNG bunker vessel' }),
  M('vlgc86k', 'gas', 'cargo', 230, 36.6, 11.4, 55000, 17, 11000000, 49500, 0, ['gas:lpg'], { m3: 86000 }, [], { short: 'VLGC' }),
  M('lng174k', 'gas', 'cargo', 295, 46.4, 11.5, 82000, 19.5, 22300000, 73800, 0, ['gas:lng'], { m3: 174000 }, [], { short: 'LNG carrier' }),
  M('feeder1000', 'container', 'cargo', 134, 22.5, 7.6, 13000, 18.5, 3230000, 11700, 0, ['box'], { teu: 1000, plugs: 150 }, ['dg'], { short: 'Feeder 1,000' }),
  M('feeder1700', 'container', 'cargo', 172, 27.2, 9.8, 21500, 19.5, 4950000, 19350, 0, ['box'], { teu: 1700, plugs: 300 }, ['dg'], { short: 'Feeder 1,700' }),
  M('panamax4500', 'container', 'cargo', 294, 32.2, 12.5, 52000, 24, 10500000, 46800, 0, ['box'], { teu: 4500, plugs: 600 }, ['dg'], { short: 'Panamax' }),
  M('pctc7000', 'roro', 'cargo', 200, 38, 10, 18000, 20, 4490000, 16200, 0, ['roro'], { ceu: 7000 }, [], { short: 'PCTC' }),
  M('roro3500', 'roro', 'cargo', 195, 26.5, 7, 13000, 21, 3410000, 11700, 12, ['roro'], { lm: 3500 }, [], { short: 'Ro-ro' }),
  M('ropax200', 'ferry', 'passenger', 200, 31, 6.8, 7000, 24, 3810000, 7000, 1800, ['pax', 'roro'], { lm: 2800 }, [], { short: 'Cruise ferry', comfort: 2 }),
  M('ferry50', 'ferry', 'passenger', 50, 13.5, 3, 250, 11.5, 459000, 150, 250, ['pax', 'roro'], { ceu: 40 }, [], { short: 'Island ferry' }),
  M('cruise230', 'cruise', 'passenger', 230, 28, 7, 6000, 21, 7810000, 3000, 1250, ['pax'], {}, ['tender'], { short: 'Cruise ship', comfort: 2 }),
  M('expedition105', 'cruise', 'passenger', 104.4, 18, 5.3, 1000, 15, 3000000, 500, 200, ['pax'], {}, ['tender'], { short: 'Expedition', ice: 'PC6', comfort: 2 }),
  M('livestock135', 'general', 'cargo', 134, 21, 6.5, 7000, 16, 1690000, 6300, 0, ['livestock'], { head: 4000 }, [], { short: 'Livestock carrier' }),
  M('reefer150', 'general', 'cargo', 150, 24, 9.2, 13000, 21, 2870000, 11700, 0, ['reefer', 'box'], { teu: 300, plugs: 300 }, ['cranes:4x40'], { short: 'Reefer' }),
  M('mpp160', 'general', 'cargo', 160, 26, 9.8, 17000, 16, 3150000, 15300, 0, ['breakbulk', 'bulk', 'box', 'heavy'], { teu: 1000, plugs: 0 }, ['cranes:2x350'], { short: 'MPP heavy-lift' }),
  M('tug24', 'tug', 'working', 24.5, 11.3, 5, 140, 12.5, 256000, 30, 0, [], {}, ['towWinch', 'fifi'], { bp: 70, short: 'ASD tug' }),
  M('oceantug60', 'tug', 'working', 60, 16.5, 6.2, 1500, 16, 967000, 600, 0, ['deck'], {}, ['towWinch', 'fifi'], { bp: 150, short: 'Ocean tug' }),
  M('ahts85', 'offshore', 'working', 85, 22, 7.5, 4000, 16.5, 1450000, 2400, 0, ['deck', 'liquid:clean'], {}, ['towWinch', 'sternRoller', 'dp2'], { bp: 200, short: 'AHTS' }),
  M('psv90', 'offshore', 'working', 90, 19.5, 7.4, 5300, 14, 1140000, 4500, 0, ['deck', 'liquid:clean'], {}, ['dp2', 'survey'], { short: 'PSV' }),
  M('sov90', 'offshore', 'working', 90, 19.5, 6.5, 2500, 13, 1570000, 1000, 60, ['deck', 'pax'], {}, ['gangway', 'dp2', 'survey'], { short: 'SOV' }),
  M('ctv26', 'workboat', 'working', 26, 10.4, 1.7, 60, 27, 153000, 15, 12, ['pax', 'deck'], {}, [], { short: 'CTV' }),
  M('research75', 'special', 'working', 75, 18, 5.6, 2000, 14, 2260000, 500, 30, ['pax'], {}, ['aframe', 'survey', 'dp2'], { short: 'Research vessel', ice: '1A' }),
  M('icebreaker120', 'special', 'working', 128, 24, 8, 4000, 16, 7490000, 1500, 60, ['pax'], {}, ['helideck', 'moonpool'], { short: 'Icebreaker', ice: 'PC3', bp: 200 }),
  M('tshd100', 'special', 'working', 100, 21, 7, 8000, 13, 1570000, 7200, 0, ['hopper'], { m3: 5000 }, [], { short: 'Hopper dredger' }),
  M('giga100', 'motor_yacht', 'motor yacht', 100, 16, 4.6, 600, 20, 23300000, 30, 36, ['pax'], {}, ['tender', 'helideck', 'pyc'], { short: 'Superyacht 100 m', comfort: 3 }),
  M('explorer45', 'motor_yacht', 'motor yacht', 45, 9.4, 3, 150, 15, 3910000, 10, 12, ['pax'], {}, ['tender'], { short: 'Explorer yacht', ice: '1A' }),
  M('rib8', 'motor_yacht', 'motor yacht', 8.5, 2.9, 0.6, 0.5, 45, 42000, 0.3, 8, ['pax'], {}, [], { short: 'RIB' }),
  M('seiner75', 'fishing', 'working', 75, 15.6, 7.6, 3000, 17, 728000, 2200, 0, ['fish'], {}, ['rsw'], { fishRate: 6, short: 'Purse seiner' }),
].map((m) => [m.id, m]));

const baseId = (cls) => String(cls ?? '').split('~')[0];
export const STUB = {
  MODELS: STUB_MODELS,
  modelOf: (cls) => STUB_MODELS[baseId(cls)] || null,
  classRow: (cls) => STUB_MODELS[baseId(cls)] || null,
  basePrice: (cls) => STUB_MODELS[baseId(cls)]?.price,
  jonesOk: (v) => v?.builtIn === 'US' && !v?.hist?.jonesLost,
};
export function useStub() { setShipSource(STUB); }

/** A docked actor (player-shaped) with a ship class at a harbour. */
export function actor(cls, harborId, extra = {}) {
  const h = harborById(harborId);
  return { id: 'p1', ship: { cls, lat: h?.lat ?? 0, lon: h?.lon ?? 0, spd: 0 }, docked: harborId, cargo: [], jobs: [], shipTime: 1_800_000_000, money: 0, ...extra };
}
/** Seeded RNG (mulberry32). */
export function seeded(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export const T0 = Date.UTC(2026, 6, 15, 12) / 1000;   // 15 Jul 2026 12:00 UTC (no Baltic ice)
export const T_WINTER = Date.UTC(2027, 1, 10, 12) / 1000; // 10 Feb 2027 (ice season everywhere)
export const ctxBase = (simTime = T0, extra = {}) => ({ harborById, simTime, ...extra });
