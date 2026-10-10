// Job generation for JOB_GEN 8 (docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §5.5–§5.7): family weights per harbour,
// one builder per runner family (the six legacy families still come from server/economy.js generateJob), board size
// 24/16/10/6 and the "≥ 3 doable jobs per docked ship" fit guarantee. Deterministic for a given rnd.
import { haversine, destination } from '../shared/geo.js';
import { HARBORS, FISHING_GROUNDS, PLATFORMS, harborById } from './harbors.js';
import { generateJob as legacyGenerateJob, nextJobId, DEST_BANDS } from './economy.js';
import { RATES } from '../shared/rates.js';
import { econDataset } from './econdata.js';                     // world economy §9.2: voyage jobs follow the market roles
import { roleOf } from '../shared/econ/model.js';
import { CATALOGUE, catalogueOf } from '../shared/econ/catalogue.js';
import { CARGO, toTonnes, unitsOf, freeUnits, fromTonnes, eqOf, loadOption } from '../shared/cargo.js';
import { JOB_GEN, step, payOf } from '../shared/jobs/types.js';
import {
  FAMILIES, PAY, familiesFor, stepHours, payBox, payVoyage, payProject, payVehicles, payRopaxCrossing, payCruise, payAnchor,
  payStandby, payCrewchange, payTowage, payOceanTow, paySalvage, payPilot, payBunkering, payLaunch, payDredge, paySurvey,
  payResearch, payEscort, payLesson, payEcotour, payDelivery, regattaPurse, lessonWindKn, speciesFor, payFish, SALVAGE_PCT,
} from '../shared/jobs/catalogue.js';
import { canDo } from '../shared/jobs/eligibility.js';
import { tagsOf, isSeed, limitsOf, shortName, SEED_WEIGHT_MUL } from '../shared/jobs/ports.js';
import { itinerariesFrom, callsOf, cruiseIncome, CRUISE_RULES } from '../shared/jobs/cruises.js';
import { cruiseProfile, onboardIndex } from '../shared/ships/cruiseprofile.js';
import { iceNeedAt, ecoSitesFor, windfarmsNear, monthOf } from '../shared/jobs/sites.js';
import { loaOf, draftOf, isKnown, rowOf, nameOf } from '../shared/jobs/shipview.js';

export const BOARD_SIZE = { mega: 24, major: 16, regional: 10, minor: 6 };
export const FIT_MIN = 3;
export const GEN = { MARGIN_MIN: 1.4, MARGIN_MAX: 1.8, FIXED_H: 3, MIN_HOURS: 4, BOARD_TTL_H: 24, LAYCAN_H: 12 };

const r1 = (v) => Math.round(v * 10) / 10;
const kmBetween = (a, b) => haversine(a.lat, a.lon, b.lat, b.lon) / 1000;
const U = (rnd, a, b) => a + rnd() * (b - a);
const I = (rnd, a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];
const fmtN = (n) => Math.round(n).toLocaleString('en-US');
const NM = 1.852;
const BIG = (h) => h.size === 'mega' || h.size === 'major';

function seaKm(env, from, to) {
  const gc = kmBetween(from, to);
  let km = null;
  try { km = env?.seaKm ? env.seaKm(from.id, to.id) : null; } catch { km = null; }
  return Number.isFinite(km) && km > 0 ? r1(km) : r1(gc * RATES.DETOUR);
}

/** A destination drawn with economy's distance bands among harbours that pass `ok(h, km)`; null when none does. */
export function pickDest(from, rnd, ok = () => true, { minKm = 0, maxKm = 1e9 } = {}) {
  const bands = DEST_BANDS.map((b) => ({ ...b, cands: [], total: 0 }));
  for (const h of HARBORS) {
    if (h.id === from.id) continue;
    const d = kmBetween(from, h);
    if (d < minKm || d > maxKm || !ok(h, d)) continue;
    const w = h.size === 'mega' ? 1.5 : h.size === 'minor' ? 0.7 : 1;
    const b = bands.find((x) => d < x.maxKm);
    b.cands.push({ h, w, d }); b.total += w;
  }
  const live = bands.filter((b) => b.cands.length);
  if (!live.length) return null;
  const pTotal = live.reduce((s, b) => s + b.p, 0);
  let r = rnd() * pTotal, band = live[live.length - 1];
  for (const b of live) { r -= b.p; if (r <= 0) { band = b; break; } }
  r = rnd() * band.total;
  for (const c of band.cands) { r -= c.w; if (r <= 0) return c; }
  return band.cands[band.cands.length - 1];
}
/** Can a ship of length L / draught T use harbour h (port limits only; the berth check stays the final word)? */
function fits(h, L, T, vloc = false) { const lim = limitsOf(h); return L <= lim.maxLoa && (!Number.isFinite(lim.maxDraft) || lim.maxDraft >= T) && (!vloc || lim.vloc); }

// ------------------------------------------------------------------------------------------------ weights (§5.7)
const TAG_W = {
  container: [['box', 4], ['liner', 2], ['tc', 1]],
  bulk_ore: [['voyage', 4, 'ore'], ['coa', 1, 'ore'], ['tc', 1]],
  bulk_coal: [['voyage', 4, 'coal'], ['coa', 1, 'coal'], ['tc', 1]],
  bulk_grain: [['voyage', 4, 'grain'], ['coa', 1, 'grain'], ['tc', 1]],
  oil: [['voyage', 4, 'crude'], ['coa', 1, 'crude'], ['tc', 1]],
  products: [['voyage', 4, 'fuel'], ['coa', 1, 'fuel'], ['tc', 1]],
  chem: [['voyage', 4, 'chemicals'], ['coa', 1, 'chemicals'], ['tc', 1]],
  lng: [['voyage', 2, 'lng']], lpg: [['voyage', 2, 'lpg']],
  cars: [['vehicles', 3]], roro: [['vehicles', 1]],
  ferry: [['ropax_route', 2], ['passengers', 1]],
  cruise: [['cruise', 2]],
  offshore: [['supply', 3], ['anchor', 1], ['standby', 2], ['crewchange', 1], ['survey', 1]],
  windfarm: [['crewchange', 3], ['survey', 1]],
  fishing: [['fishing', 4]],
  marina: [['lesson', 3], ['daycharter', 2], ['bareboat', 1], ['regatta', 1], ['delivery', 1]],
  heavy: [['project', 2]], dredge: [['dredge', 1]], livestock: [['voyage', 2, 'livestock']], research: [['research', 1]],
};
/**
 * Weighted family entries for harbour `h`: [{ type, w, good? }]. Size base + Σ tag weights (seed-listed specialist
 * ports × SEED_WEIGHT_MUL); entries above `phase` are dropped.
 */
export function weightsFor(h, simTime = 0, { phase = 4 } = {}) {
  const tags = tagsOf(h), out = [];
  const add = (type, w, good) => { if (w > 0 && (FAMILIES[type].legacy || FAMILIES[type].phase <= phase)) out.push({ type, w, good: good || null }); };
  add('freight', 3); add('passengers', 2); add('charter', 1); add('launch', 1); add('tow', 1);
  if (BIG(h)) { add('box', 2); add('towage', 2); add('ocean_tow', 1); add('pilot_transfer', 1); }
  for (const tag of tags) {
    const mul = isSeed(h, tag) ? SEED_WEIGHT_MUL : 1;
    for (const [type, w, good] of TAG_W[tag] || []) if (!good || !EXPORTERS[good] || EXPORTERS[good].includes(h.id)) add(type, w * mul, good);
  }
  if (tags.has('oil') || tags.has('products') || tags.has('chem')) add('bunkering', tags.has('bunkers') ? 3 : 1);
  if (tags.has('marina') && ecoSitesFor(h.id).length) add('ecotour', 1 * (isSeed(h, 'marina') ? SEED_WEIGHT_MUL : 1));
  if (tags.has('marina') && BIG(h)) add('guests', 1);
  if (tags.has('ice') && iceNeedAt(h, simTime)) add('escort', 1);
  return out;
}

// ------------------------------------------------------------------------------------------------ record assembly
function finish(job, from, simTime, rnd, refCls) {
  const margin = GEN.MARGIN_MIN + rnd() * (GEN.MARGIN_MAX - GEN.MARGIN_MIN);
  const need = stepHours(job, refCls);
  job.hours = Math.max(GEN.MIN_HOURS, Math.ceil((Number.isFinite(need) ? need : 0) * margin + GEN.FIXED_H));
  job.ref = { cls: refCls, margin: Math.round(margin * 100) / 100 };
  job.postedAt = simTime; job.expiresAt = simTime + GEN.BOARD_TTL_H * 3600;
  job.window = { readyAt: simTime, laycanTo: job.window?.laycanTo ?? null, dueAt: simTime + job.hours * 3600 };
  return job;
}
function base(type, from, extra) {
  return { id: nextJobId(), gen: JOB_GEN, type, family: type, title: '', from: from.id, to: null, legs: null, cargo: null, pax: 0,
    needs: {}, steps: [], window: { readyAt: 0, laycanTo: null, dueAt: 0 }, pay: { cr: 0, model: 'lump' }, hours: 0, ref: null,
    postedAt: 0, expiresAt: 0, contraband: false, ...extra };
}
const at = (p, rM) => ({ lat: Math.round(p.lat * 1e5) / 1e5, lon: Math.round(p.lon * 1e5) / 1e5, rM });
/** A point `km` off the harbour (towards open water when env.towSpot says so; up to 24 tries). */
function offshore(env, h, rnd, kmMin, kmMax, draft = 6) {
  for (let i = 0; i < 24; i++) {
    const p = destination(h.lat, h.lon, rnd() * 360, U(rnd, kmMin, kmMax) * 1000);
    if (!env?.towSpot || env.towSpot(p.lat, p.lon, draft)) return p;
  }
  return null;
}

// Reference ships per size band (game capacity of the band's catalogue model, §5.5 "a size band's capacity").
export const BANDS = {
  bulk: [['Handysize', 'handy38', 34200], ['Ultramax', 'ultramax64', 57600], ['Kamsarmax', 'kamsarmax82', 73800], ['Capesize', 'capesize180', 162000], ['Newcastlemax', 'newcastlemax208', 187200], ['VLOC', 'vloc400', 360000]],
  crude: [['Aframax', 'aframax115', 103500], ['Suezmax', 'suezmax158', 142200], ['VLCC', 'vlcc300', 270000]],
  fuel: [['MR', 'mr50', 45000], ['LR1', 'lr1_75', 67500]],
  chemicals: [['Chemical tanker', 'chem13k', 11700], ['MR', 'mr50', 45000]],
  lpg: [['LPG carrier', 'lpg5k', 5000], ['VLGC', 'vlgc86k', 86000]],
  lng: [['LNG carrier', 'lng174k', 174000]],
  livestock: [['Livestock carrier', 'livestock135', 4000]],
  fruit: [['Reefer ship', 'reefer150', 11700]],
};
const BAND_OF_GOOD = { grain: [0, 1, 2, 3], ore: [2, 3, 4, 5], coal: [1, 2, 3, 4], steel: [0, 1] };
const REF_DIMS = { // L, T of band references (Appendix A) for destination limits before Lane A's catalogue is merged
  handy38: [180, 10.5], ultramax64: [199.9, 13.3], kamsarmax82: [229, 14.45], capesize180: [292, 18.2], newcastlemax208: [299.9, 18.4], vloc400: [362, 23],
  aframax115: [250, 15], suezmax158: [274, 17], vlcc300: [333, 22.5], mr50: [183, 13.3], lr1_75: [228, 14.5], chem13k: [128, 8.7],
  lpg5k: [99.9, 6.6], vlgc86k: [230, 11.4], lng174k: [295, 11.5], livestock135: [134, 6.5], reefer150: [150, 9.2],
  feeder1000: [134, 7.6], feeder1700: [172, 9.8], subpmax2800: [200, 11.5], panamax4500: [294, 12.5], neopmax14k: [366, 15.2],
  mpp160: [160, 9.8], pctc7000: [200, 10], roro3500: [195, 7], ropax200: [200, 6.8], cruise230: [230, 7], expedition105: [104.4, 5.3], rivercruise110: [110, 1.7], boutique125: [125, 4.8], cruise285: [285, 8.1], cruise330: [330, 8.8], cruise362: [362, 9.3], cruise370: [370, 9.5],
};
const dimsOf = (cls) => (isKnown(cls) && loaOf(cls) > 0 ? [loaOf(cls), draftOf(cls)] : REF_DIMS[cls] || [150, 9]);
const EXPORT_TAG = { grain: 'bulk_grain', ore: 'bulk_ore', coal: 'bulk_coal', crude: 'oil', fuel: 'products', chemicals: 'chem', lpg: 'lpg', lng: 'lng', livestock: 'livestock' };
const IMPORT_OK = {
  grain: (h) => h.size !== 'minor', ore: (h) => BIG(h), coal: (h) => BIG(h), steel: (h) => h.size !== 'minor',
  crude: (h) => tagsOf(h).has('oil') || h.size === 'mega', fuel: (h) => tagsOf(h).has('products') || tagsOf(h).has('oil'),
  chemicals: (h) => tagsOf(h).has('chem') || tagsOf(h).has('products'), lpg: (h) => tagsOf(h).has('lpg') || h.size === 'mega',
  lng: (h) => tagsOf(h).has('lng'), livestock: (h) => h.size !== 'minor', fruit: (h) => h.size !== 'minor',
};
const sizeOk = (good, h, cls) => {
  const [L, T] = dimsOf(cls), t = tagsOf(h);
  if (!fits(h, L, T, cls === 'vloc400')) return false;
  if (['capesize180', 'newcastlemax208', 'vloc400'].includes(cls) && !['bulk_ore', 'bulk_coal', 'bulk_grain'].some((x) => t.has(x))) return false;
  return true;
};

// ------------------------------------------------------------------------------------------------ builders
// Each builder: (from, o) → job | null, o = { rnd, simTime, env, good?, fit?: { cls, vessel } (size it for that ship) }.
function bandFor(good, o) {
  const h0 = CARGO[good]?.opts?.[0]?.h, byH = BAND_BY_HANDLING[h0];   // world economy: new goods take their handling's bands
  const bands = BAND_OF_GOOD[good] ? BAND_OF_GOOD[good].map((i) => BANDS.bulk[i]) : BANDS[good] || (byH === 'bulk' ? BANDS.bulk.slice(0, 4) : byH ? BANDS[byH] : null) || null;
  if (!bands) return null;
  if (o.fit) return [nameOf(o.fit.cls), o.fit.cls, null];
  return pick(o.rnd, bands);
}
function voyageLift(from, o, good, dest) {
  const g = CARGO[good], band = bandFor(good, o); if (!band) return null;
  const [bandName, refCls, cap] = band;
  let units;
  if (o.fit) { const free = freeUnits(o.fit.vessel, g.unit === 't' ? 't' : g.unit); units = Math.floor(U(o.rnd, 0.85, 1.0) * free); }
  else units = Math.round(U(o.rnd, 0.9, 1.0) * cap);
  if (!(units > 0)) return null;
  return { bandName, refCls, units, t: toTonnes(good, units) };
}
function voyageDest(from, o, good, refCls) {
  return pickDest(from, o.rnd, (h) => importsGood(h, good) && sizeOk(good, h, refCls), { minKm: 150 });
}

const B = {};
const hireBasis = (cls) => Math.max(120000, rowOf(cls)?.price || 0);
B.box = (from, o) => {
  const rnd = o.rnd;
  let teu;
  if (o.fit) { teu = Math.floor(U(rnd, 0.5, 0.95) * Math.min(freeUnits(o.fit.vessel, 'teu'), 3000)); }
  else teu = Math.round(20 * Math.pow(150, rnd() * rnd()));
  if (!(teu >= 20)) return null;
  const refCls = o.fit?.cls || (teu <= 1000 ? 'feeder1000' : teu <= 1700 ? 'feeder1700' : teu <= 2800 ? 'subpmax2800' : 'panamax4500');
  const [L, T] = dimsOf(refCls);
  const geared = o.fit?.geared;
  const d = pickDest(from, rnd, (h) => (tagsOf(h).has('container') && h.size !== 'minor') || (geared && h.size !== 'minor') ? fits(h, L, T) : false, { minKm: 80 });
  if (!d) return null;
  const plugs = o.fit ? unitsOf(o.fit.cls).plugs : 300;
  const reefer = rnd() < 0.2 && plugs > 0 ? Math.min(plugs, Math.round(teu * U(rnd, 0.1, 0.4))) : 0;
  const dg = rnd() < 0.1;
  const km = seaKm(o.env, from, d.h);
  const good = dg ? 'dg_box' : 'containers';
  const t = teu * 12;
  const job = base('box', from, {
    to: d.h.id, title: `${fmtN(teu)} TEU${reefer ? ` (${fmtN(reefer)} reefer)` : ''}${dg ? ' incl. dangerous goods' : ''} to ${shortName(d.h)}`,
    cargo: { good, unit: 'teu', qty: teu, t, reefer, dg }, needs: { handling: ['box'], unit: 'teu', qty: teu, eq: dg ? ['dg'] : [] },
    steps: [step('load', from.id, { label: `Load at ${shortName(from)}` }), step('sail', d.h.id, { km, label: `Sail to ${shortName(d.h)}` }), step('discharge', d.h.id, { label: `Discharge at ${shortName(d.h)}` })],
    pay: { cr: payBox({ teu, reeferTeu: reefer, dg, km, size: from.size }), model: 'lump' }, seaKm: km, distKm: Math.round(d.d),
  });
  return finish(job, from, o.simTime, rnd, refCls);
};
B.liner = (from, o) => {
  const rnd = o.rnd, refCls = o.fit?.cls || pick(rnd, ['feeder1700', 'panamax4500', 'neopmax14k']);
  const [L, T] = dimsOf(refCls);
  const capTeu = o.fit ? freeUnits(o.fit.vessel, 'teu') : refCls === 'feeder1700' ? 1700 : refCls === 'panamax4500' ? 4500 : 14000;
  const n = I(rnd, 3, 6), calls = [from];
  for (let i = 1; i < n; i++) {
    const prev = calls[calls.length - 1];
    const d = pickDest(prev, rnd, (h) => !calls.includes(h) && tagsOf(h).has('container') && h.size !== 'minor' && fits(h, L, T) && kmBetween(h, from) < 1500, { maxKm: 1500 });
    if (!d) break;
    calls.push(d.h);
  }
  if (calls.length < 3) return null;
  const steps = [], lots = [];
  let tt = o.simTime + 2 * 3600, payCr = 0, kmTot = 0;
  for (let i = 0; i < calls.length; i++) {
    const a = calls[i], b = calls[(i + 1) % calls.length];
    const km = seaKm(o.env, a, b), teu = Math.max(50, Math.round(U(rnd, 0.3, 0.6) * capTeu));
    lots.push({ lot: i, from: a.id, to: b.id, teu });
    payCr += payBox({ teu, km, size: a.size }); kmTot += km;
    steps.push(step('load', a.id, { lot: i, label: `Load ${fmtN(teu)} TEU at ${shortName(a)}` }));
    tt += Math.round((km / (14 * NM) + 4) * 3600);
    steps.push(step('sail', b.id, { km, until: tt, label: `Sail to ${shortName(b)} (arrive by the timetable)` }));
    steps.push(step('discharge', b.id, { lot: i, label: `Discharge at ${shortName(b)}` }));
  }
  const tot = lots.reduce((s, l) => s + l.teu, 0);
  const job = base('liner', from, {
    to: from.id, legs: calls.map((h) => h.id), title: `Liner loop: ${calls.map(shortName).join(' – ')} – ${shortName(from)}`,
    cargo: { good: 'containers', unit: 'teu', qty: Math.max(...lots.map((l) => l.teu)), t: Math.max(...lots.map((l) => l.teu)) * 12, lots },
    needs: { handling: ['box'], unit: 'teu', qty: Math.max(...lots.map((l) => l.teu)) }, steps, timetable: steps.filter((s) => s.until).map((s) => s.until),
    pay: { cr: Math.round(payCr * PAY.LINER_MUL), bonus: { kind: 'ontime', cr: Math.round(payCr * PAY.LINER_MUL * PAY.LINER_ONTIME) }, model: 'lump' }, seaKm: r1(kmTot), totalTeu: tot,
  });
  return finish(job, from, o.simTime, rnd, refCls);
};
/** Terminals that LOAD these goods (Game rule, verify): the other seed ports of the tag only import them. */
export const EXPORTERS = {
  crude: ['ras_tanura', 'kharg', 'fujairah', 'novorossiysk', 'ust_luga', 'bonny', 'sohar', 'umm_qasr', 'corpus_christi', 'galveston'],
  lng: ['ras_laffan', 'bintulu', 'hammerfest', 'gladstone', 'bonny', 'dampier', 'galveston'],
  lpg: ['ras_tanura', 'ras_laffan', 'galveston'],
};
const legacyExports = (h, g) => (EXPORTERS[g] && !EXPORTERS[g].includes(h.id) ? false : EXPORT_TAG[g] ? tagsOf(h).has(EXPORT_TAG[g]) : g === 'steel' ? h.size !== 'minor' : g === 'fruit' ? h.size !== 'minor' && Math.abs(h.lat) < 40 : false);
// World economy §9.2: with the econ dataset loaded, a harbour exports what it makes (role P) and takes what it needs or
// trades (I / L); EXPORTERS / EXPORT_TAG / IMPORT_OK stay as the fallback for goods outside the catalogue (fruit).
const econRole = (h, g) => { if (!catalogueOf(g) || !h) return undefined; try { return roleOf(econDataset(), h, g).role; } catch { return undefined; } };
const exportsGood = (h, g) => { const r = econRole(h, g); return r === undefined ? legacyExports(h, g) : r === 'P'; };
// The terminal check (IMPORT_OK) always applies: a harbour that needs chemicals but has no chemical berth can't take them.
// The legacy goods (those with a terminal rule) go to any harbour with the terminal that doesn't make the good itself;
// the catalogue-only goods go where the market needs or trades them (I / L).
const importsGood = (h, g) => {
  if (IMPORT_OK[g]) return IMPORT_OK[g](h) && econRole(h, g) !== 'P';
  const r = econRole(h, g); return r === undefined || r === 'I' || r === 'L';
};
/** Voyage goods (§9.2): the legacy keys plus every bulk, liquid or gas catalogue good. */
export const VOYAGE_GOODS = [...new Set([...Object.keys(EXPORT_TAG), ...CATALOGUE.filter((r) => ['grains', 'fert', 'ores', 'energy', 'gas'].includes(r.cat)).map((r) => r.id)])];
const BAND_BY_HANDLING = { bulk: 'bulk', 'liquid:crude': 'crude', 'liquid:clean': 'fuel', 'liquid:chem': 'chemicals', 'gas:lpg': 'lpg', 'gas:lng': 'lng', livestock: 'livestock', reefer: 'fruit' };
B.voyage = (from, o) => {
  const rnd = o.rnd;
  let good = o.good;
  if (o.fit) {
    const cands = (o.fitGoods || []).filter((g) => exportsGood(from, g));
    if (!cands.length) return null;
    if (!good || !cands.includes(good)) good = pick(rnd, cands);
  } else if (!good) {
    const goods = VOYAGE_GOODS.filter((g) => exportsGood(from, g));
    if (!goods.length) return null;
    good = pick(rnd, goods);
  }
  if (good === 'grain' && !o.fit && rnd() < 0.2 && exportsGood(from, 'steel')) good = 'steel';
  const lift = voyageLift(from, o, good); if (!lift) return null;
  const d = voyageDest(from, o, good, lift.refCls); if (!d) return null;
  const km = seaKm(o.env, from, d.h), g = CARGO[good];
  const laycanTo = o.simTime + GEN.LAYCAN_H * 3600;
  const job = base('voyage', from, {
    to: d.h.id, title: `${lift.bandName}: ${fmtN(lift.units)} ${g.unit === 't' ? 't' : g.unit === 'm3' ? 'm³' : g.unit} of ${g.name.toLowerCase()} to ${shortName(d.h)}`,
    cargo: { good, unit: g.unit, qty: lift.units, t: lift.t }, needs: { unit: g.unit, qty: lift.units, grades: good === 'chemicals' ? I(rnd, 1, 4) : undefined },
    steps: [step('load', from.id, { until: laycanTo, label: `Load at ${shortName(from)} (laycan)` }), step('sail', d.h.id, { km, label: `Sail to ${shortName(d.h)}` }), step('discharge', d.h.id, { label: `Discharge at ${shortName(d.h)}` })],
    window: { laycanTo }, pay: { cr: payVoyage({ good, t: lift.t, km, size: from.size }), model: 'lump' }, seaKm: km, distKm: Math.round(d.d), band: lift.bandName,
  });
  if (job.needs.grades === undefined) delete job.needs.grades;
  return finish(job, from, o.simTime, rnd, lift.refCls);
};
B.coa = (from, o) => {
  const v = B.voyage(from, o); if (!v) return null;
  const n = I(o.rnd, 2, 4), steps = [];
  const back = seaKm(o.env, harborById(v.to), from);
  for (let i = 0; i < n; i++) {
    const laycan = o.simTime + (GEN.LAYCAN_H + i * (v.steps[1].km / (12 * NM) + back / (13 * NM) + 6)) * 3600;
    steps.push(step('load', from.id, { lot: i, until: Math.round(laycan), label: `Lifting ${i + 1}/${n}: load at ${shortName(from)}` }));
    steps.push(step('sail', v.to, { km: v.steps[1].km, label: `Sail to ${shortName(harborById(v.to))}` }));
    steps.push(step('discharge', v.to, { lot: i, label: `Discharge lifting ${i + 1}` }));
    if (i < n - 1) steps.push(step('sail', from.id, { km: back, label: `Ballast back to ${shortName(from)}` }));
  }
  const cr = Math.round(v.pay.cr * n * PAY.COA_MUL);
  return finish({ ...v, type: 'coa', family: 'coa', title: `COA, ${n} liftings: ${v.title}`, steps, liftings: n,
    pay: { cr, bonus: { kind: 'laycan', cr: cr - v.pay.cr * n }, model: 'lump' } }, from, o.simTime, o.rnd, v.ref.cls);
};
B.tc = (from, o) => {
  const rnd = o.rnd, refCls = o.fit?.cls || pick(rnd, ['ultramax64', 'mr50', 'feeder1700', 'kamsarmax82']);
  const hireH = I(rnd, 24, 96);
  const d = pickDest(from, rnd, (h) => BIG(h) && fits(h, ...dimsOf(refCls)), { minKm: 100, maxKm: 4000 }); if (!d) return null;
  const km = seaKm(o.env, from, d.h);
  const job = base('tc', from, {
    to: d.h.id, title: `Time charter: ${hireH} h on hire, redeliver at ${shortName(d.h)}`, needs: { types: ['general', 'container', 'bulk', 'tanker', 'gas', 'roro'] },
    steps: [step('sail', from.id, { label: `Deliver at ${shortName(from)}` }), step('work', null, { h: hireH, hire: true, label: 'On hire: charterer’s orders' }), step('sail', d.h.id, { km, label: `Redeliver at ${shortName(d.h)}` })],
    pay: { cr: 0, perH: 0, rate: PAY.TC_HIRE, hireH, fuelPaid: true, model: 'hire' }, seaKm: km,
  });
  job.pay.perH = Math.round(hireBasis(refCls) * PAY.TC_HIRE); job.pay.cr = job.pay.perH * hireH;
  return finish(job, from, o.simTime, rnd, refCls);
};
B.project = (from, o) => {
  const rnd = o.rnd, n = I(rnd, 1, 6), pieces = Array.from({ length: n }, () => Math.round(U(rnd, 80, 700) / 5) * 5);
  const t = pieces.reduce((s, x) => s + x, 0), refCls = o.fit?.cls || 'mpp160';
  const d = pickDest(from, rnd, (h) => (tagsOf(h).has('heavy') || BIG(h)) && fits(h, ...dimsOf(refCls)), { minKm: 150 }); if (!d) return null;
  const km = seaKm(o.env, from, d.h);
  const job = base('project', from, {
    to: d.h.id, title: `Heavy lift: ${n} piece${n > 1 ? 's' : ''} (${fmtN(Math.max(...pieces))} t max) to ${shortName(d.h)}`,
    cargo: { good: 'project', unit: 't', qty: t, t, pieces }, needs: { handling: ['heavy'], unit: 't', qty: t },
    steps: [step('load', from.id, { label: 'Lift the pieces aboard' }), step('sail', d.h.id, { km }), step('discharge', d.h.id, { label: 'Discharge the pieces' })],
    pay: { cr: payProject({ t, pieces: n, km, size: from.size }), model: 'lump' }, seaKm: km,
  });
  return finish(job, from, o.simTime, rnd, refCls);
};
B.vehicles = (from, o) => {
  const rnd = o.rnd;
  let good, units, refCls;
  if (o.fit) { const u = unitsOf(o.fit.cls); good = u.ceu > 0 ? 'vehicles' : 'trailers'; units = Math.floor(U(rnd, 0.5, 0.95) * freeUnits(o.fit.vessel, good === 'vehicles' ? 'ceu' : 'lm')); refCls = o.fit.cls; }
  else if (rnd() < 0.5) { good = 'vehicles'; units = Math.round(U(rnd, 200, 7000)); refCls = 'pctc7000'; }
  else { good = 'trailers'; units = Math.round(U(rnd, 300, 3500)); refCls = 'roro3500'; }
  if (!(units > 0)) return null;
  const d = pickDest(from, rnd, (h) => ['cars', 'roro', 'ferry'].some((t) => tagsOf(h).has(t)) && fits(h, ...dimsOf(refCls)), { minKm: 100 }); if (!d) return null;
  const km = seaKm(o.env, from, d.h), unit = CARGO[good].unit;
  const job = base('vehicles', from, {
    to: d.h.id, title: `${fmtN(units)} ${unit === 'ceu' ? 'cars' : 'lane m of trailers'} to ${shortName(d.h)}`,
    cargo: { good, unit, qty: units, t: toTonnes(good, units) }, needs: { handling: ['roro'], unit, qty: units },
    steps: [step('load', from.id, { label: 'Drive the cargo aboard' }), step('sail', d.h.id, { km }), step('discharge', d.h.id, { label: 'Drive the cargo ashore' })],
    pay: { cr: payVehicles({ good, units, km, size: from.size }), model: 'lump' }, seaKm: km,
  });
  return finish(job, from, o.simTime, rnd, refCls);
};
B.ropax_route = (from, o) => {
  const rnd = o.rnd, refCls = o.fit?.cls || pick(rnd, ['ferry', 'ropax200']);
  const d = pickDest(from, rnd, (h) => (tagsOf(h).has('ferry') || tagsOf(h).has('roro')) && fits(h, ...dimsOf(refCls)), { minKm: 20, maxKm: 600 }); if (!d) return null;
  const km = seaKm(o.env, from, d.h), n = I(rnd, 2, 6);
  const paxCap = o.fit ? unitsOf(o.fit.cls).pax : refCls === 'ferry' ? 400 : 1800, lmCap = o.fit ? unitsOf(o.fit.cls).lm : refCls === 'ferry' ? 900 : 2800;
  const pax = Math.round(U(rnd, 0.3, 0.9) * paxCap), lm = Math.round(U(rnd, 0.2, 0.8) * lmCap);
  const crossH = km / (18 * NM) + 1.5, steps = [], tt = [];
  let dep = o.simTime + 3600;
  for (let i = 0; i < n; i++) {
    const a = i % 2 ? d.h : from, b = i % 2 ? from : d.h;
    tt.push(Math.round(dep));
    steps.push(step('board', a.id, { until: Math.round(dep), depart: Math.round(dep), label: `Crossing ${i + 1}/${n}: depart ${shortName(a)}` }));
    steps.push(step('sail', b.id, { km, label: `Sail to ${shortName(b)}` }));
    steps.push(step('land', b.id, { label: `Land at ${shortName(b)}` }));
    dep += (crossH + 1) * 3600;
  }
  const per = payRopaxCrossing({ pax, lm, km });
  const job = base('ropax_route', from, {
    to: d.h.id, legs: [from.id, d.h.id], title: `${n} crossings ${shortName(from)} ↔ ${shortName(d.h)}`, pax,
    cargo: lm > 0 ? { good: 'trailers', unit: 'lm', qty: lm, t: toTonnes('trailers', lm) } : null,
    needs: { handling: ['pax', 'roro'], unit: 'pax', qty: pax, paxCert: pax > 12, lm }, steps, timetable: tt,
    pay: { cr: per * n, bonus: { kind: 'ontime', cr: Math.round(per * n * PAY.ROPAX_ONTIME) }, model: 'lump' }, seaKm: km, crossings: n,
  });
  return finish(job, from, o.simTime, rnd, refCls);
};
// Cruise ships: real-style itineraries (shared/jobs/cruises.js) with a stop at every call and sea days between. Which ship
// the cruise is sold for follows the size of the home harbour; every port must pass the ship's length / draught limits and,
// for ships over 250 m, be a cruise terminal (a ship that size cannot lie at a plain commercial quay).
const CRUISE_REF = { mega: ['cruise362', 'cruise370', 'cruise330', 'cruise285'], major: ['cruise230', 'cruise285', 'cruise330', 'cruise230'], regional: ['boutique125', 'cruise230', 'rivercruise110'], minor: ['rivercruise110', 'boutique125'] };
function cruisePortOk(h, refCls) {
  const [L, T] = dimsOf(refCls);
  if (!h || !fits(h, L, T)) return false;
  if (L > 250 && !tagsOf(h).has('cruise')) return false;
  return L <= 140 || h.size !== 'minor';
}
/** An expedition cruise: sail to each landing site, guests ashore by Zodiac, then home. */
function cruiseSites(from, o, it, refCls, prof, guests) {
  const rnd = o.rnd, kn = 13, steps = [step('board', from.id, { label: `Embark ${fmtN(guests)} guests` })];
  let t = o.simTime + 3600, prev = from, kmTot = 0;
  for (const s of it.sites) {
    const km = r1(kmBetween(prev, s) * RATES.DETOUR); kmTot += km; t += Math.round((km / (kn * NM)) * 3600);
    steps.push(step('sail', at(s, 4000), { km, until: t, comfort: true, label: `Sail to ${s.name}` }));
    const stay = I(rnd, 12, 20); steps.push(step('work', null, { h: stay, chartered: true, label: `Landings at ${s.name}` })); t += stay * 3600; prev = s;
  }
  const back = r1(kmBetween(prev, from) * RATES.DETOUR); kmTot += back; t += Math.round((back / (kn * NM)) * 3600);
  steps.push(step('sail', from.id, { km: back, until: t, comfort: true, label: `Return to ${shortName(from)}` }), step('land', from.id, { label: 'Disembark' }));
  const hours = Math.round((t - o.simTime) / 3600), inc = cruiseIncome({ guests, hours, cls: refCls });
  const job = base('cruise', from, {
    to: from.id, legs: [], title: `${it.name}: ${Math.max(3, Math.round(hours / 24))} nights, ${it.sites.map((x) => x.name).join(', ')}`, pax: guests,
    needs: { handling: ['pax'], unit: 'pax', qty: guests, paxCert: true, ice: 'pc6' }, steps, timetable: steps.filter((s) => s.until).map((s) => s.until),
    pay: { cr: inc.ticket + inc.onboard, ticket: inc.ticket, onboardRate: onboardIndex(refCls), model: 'lump', bonus: { kind: 'perfect', cr: Math.round((inc.ticket + inc.onboard) * CRUISE_RULES.PERFECT_BONUS) } },
    seaKm: r1(kmTot), cruiseH: hours, itinerary: { id: it.id, name: it.name, nights: Math.max(3, Math.round(hours / 24)), ports: [from.id], oneWay: false, sites: it.sites.map((x) => x.name) },
  });
  void prof;
  return finish(job, from, o.simTime, rnd, refCls);
}
B.cruise = (from, o) => {
  const rnd = o.rnd, polar = ['ushuaia', 'nuuk', 'tromso', 'hobart'].includes(from.id);
  const refCls = o.fit?.cls || (polar ? 'expedition105' : pick(rnd, CRUISE_REF[from.size] || CRUISE_REF.regional));
  const prof = cruiseProfile(refCls);
  const berths = o.fit ? unitsOf(o.fit.cls).pax : prof?.guests || (refCls === 'expedition105' ? 200 : 1250);
  const guests = Math.max(13, Math.round(U(rnd, CRUISE_RULES.OCCUPANCY[0], CRUISE_RULES.OCCUPANCY[1]) * berths));
  const kn = Math.min(CRUISE_RULES.SEA_KN, 17), stayH = () => I(rnd, CRUISE_RULES.PORT_STAY_H[0], CRUISE_RULES.PORT_STAY_H[1]);
  let calls = [], it = null;
  if (polar) { const pit = itinerariesFrom(from.id).find((x) => x.sites); if (pit) return cruiseSites(from, o, pit, refCls, prof, guests); }
  const its = polar ? [] : itinerariesFrom(from.id).filter((x) => !x.minGuests || berths >= x.minGuests);
  if (its.length && cruisePortOk(from, refCls)) {
    it = pick(rnd, its);
    const ids = callsOf(it, from.id, (id) => cruisePortOk(harborById(id), refCls));
    if (ids) calls = ids.map((id) => harborById(id)); else it = null;
  }
  if (!it) {   // no listed itinerary starts here (or none fits the ship): calls drawn within 900 km
    let prev = from;
    for (let i = 0, n = I(rnd, 3, 6); i < n; i++) {
      const d = pickDest(prev, rnd, (h) => !calls.includes(h) && h !== from && cruisePortOk(h, refCls) && kmBetween(h, from) < 900, { minKm: 40, maxKm: 600 });
      if (!d) break; calls.push(d.h); prev = d.h;
    }
  }
  if (calls.length < 2) return null;
  const oneWay = !!it?.oneWay, legs = oneWay ? calls : [...calls, from], nights = it?.nights ?? Math.max(3, Math.round((calls.length + 1) * 1.3));
  // timetable: sail → guests ashore, sea days padded in before the last leg so that the cruise sells its nights
  const seq = []; let a = from, kmTot = 0, totalH = 1;
  for (const c of legs) { const km = seaKm(o.env, a, c), stay = c === from ? 0 : stayH(); seq.push({ c, km, stay }); kmTot += km; totalH += km / (kn * NM) + stay; a = c; }
  const padH = Math.max(0, nights * 24 - totalH), padAt = seq.length - 1;
  const steps = [step('board', from.id, { label: `Embark ${fmtN(guests)} guests` })];
  let t = o.simTime + 3600;
  seq.forEach(({ c, km, stay }, i) => {
    if (i === padAt && padH >= 6) { steps.push(step('work', null, { h: Math.round(padH), chartered: true, comfort: true, label: 'Sea days: shows, pools and dinner' })); t += Math.round(padH) * 3600; }
    t += Math.round((km / (kn * NM)) * 3600);
    const last = i === seq.length - 1;
    steps.push(step('sail', c.id, { km, until: t, comfort: true, label: c === from ? `Return to ${shortName(from)}` : `${last && oneWay ? 'Arrive at' : 'Call at'} ${shortName(c)}` }));
    if (stay > 0 && !(last && oneWay)) { steps.push(step('work', null, { h: stay, chartered: true, label: `Guests ashore at ${shortName(c)}` })); t += stay * 3600; }
  });
  const endId = oneWay ? calls[calls.length - 1].id : from.id;
  steps.push(step('land', endId, { label: 'Disembark' }));
  const hours = Math.round((t - o.simTime) / 3600);
  const inc = cruiseIncome({ guests, hours, cls: refCls });
  const cr = polar && !prof ? payCruise({ guests, hours, comfort: 1, expedition: true }) : inc.ticket + inc.onboard;
  const name = it?.name || (polar ? 'Expedition cruise' : 'Cruise');
  const job = base('cruise', from, {
    to: endId, legs: calls.map((h) => h.id), title: `${name}: ${nights} nights, ${calls.map(shortName).join(', ')}`, pax: guests,
    needs: { handling: ['pax'], unit: 'pax', qty: guests, paxCert: true, ice: polar ? 'pc6' : undefined }, steps, timetable: steps.filter((s) => s.until).map((s) => s.until),
    pay: { cr, ticket: inc.ticket, onboardRate: onboardIndex(refCls), model: 'lump', bonus: { kind: 'perfect', cr: Math.round(cr * CRUISE_RULES.PERFECT_BONUS) } },
    seaKm: r1(kmTot), cruiseH: hours, itinerary: { id: it?.id || 'custom', name, nights, ports: [from.id, ...calls.map((h) => h.id)], oneWay },
  });
  if (!polar) delete job.needs.ice;
  return finish(job, from, o.simTime, rnd, refCls);
};
function platformNear(from, rnd) {
  const ps = PLATFORMS.map((p) => ({ p, d: kmBetween(from, p) })).filter((x) => x.d < 450).sort((a, b) => a.d - b.d);
  return ps.length ? ps[Math.floor(rnd() * Math.min(3, ps.length))] : null;
}
B.anchor = (from, o) => {
  const rnd = o.rnd, pl = platformNear(from, rnd); if (!pl) return null;
  const minBp = rnd() < 0.5 ? 80 : 150, workH = I(rnd, 2, 6), towKm = Math.round(U(rnd, 20, 150));
  const to = destination(pl.p.lat, pl.p.lon, rnd() * 360, towKm * 1000);
  const job = base('anchor', from, {
    title: `Rig move: ${pl.p.name}, ${towKm} km tow`, needs: { eq: ['towWinch', 'sternRoller'], minBp },
    steps: [step('meet', at(pl.p, 500), { km: r1(pl.d * RATES.DETOUR), maxKn: 3, label: `Meet the rig at ${pl.p.name}` }),
      step('work', at(pl.p, 500), { h: workH, maxKn: 3, label: 'Recover the anchors' }),
      step('tow', at(to, 1000), { km: towKm, maxKn: 5, label: `Tow the rig ${towKm} km` }),
      step('work', at(to, 1000), { h: 2, maxKn: 3, label: 'Run the anchors out' })],
    pay: { cr: payAnchor({ km: towKm, workH: workH + 2, size: from.size }), model: 'lump' }, site: pl.p.id,
  });
  return finish(job, from, o.simTime, rnd, o.fit?.cls || 'ahts85');
};
B.standby = (from, o) => {
  const rnd = o.rnd, pl = platformNear(from, rnd); if (!pl) return null;
  const h = I(rnd, 12, 48), km = r1(pl.d * RATES.DETOUR);
  const job = base('standby', from, {
    title: `Standby at ${pl.p.name} for ${h} h`, needs: { types: ['offshore', 'tug'] },
    steps: [step('sail', at(pl.p, 5000), { km, label: `Sail to ${pl.p.name}` }), step('work', at(pl.p, 5000), { h, label: `Stand by within 5 km for ${h} h` })],
    pay: { cr: payStandby(h), perH: PAY.STANDBY_H, model: 'lump' }, site: pl.p.id,
  });
  return finish(job, from, o.simTime, rnd, o.fit?.cls || 'psv');
};
B.crewchange = (from, o) => {
  const rnd = o.rnd, farms = windfarmsNear(from, 200);
  const site = farms.length ? farms[Math.floor(rnd() * Math.min(3, farms.length))] : (() => { const p = platformNear(from, rnd); return p ? { site: { ...p.p, rM: 1000 }, km: p.d } : null; })();
  if (!site) return null;
  const fitPax = o.fit ? unitsOf(o.fit.cls).pax : 0;
  const sov = o.fit ? (fitPax > 12) : rnd() < 0.35;
  const techs = sov ? I(rnd, 20, Math.max(20, Math.min(60, fitPax || 60))) : I(rnd, 6, Math.max(6, Math.min(12, fitPax || 12)));
  const km = r1(site.km * RATES.DETOUR), transfers = I(rnd, 2, 6), sovH = sov ? I(rnd, 12, 48) : 0;
  const work = sov ? step('work', at(site.site, site.site.rM), { h: sovH, maxKn: 2, label: `Walk-to-work for ${sovH} h` })
    : step('drill', at(site.site, site.site.rM), { count: transfers, maxKn: 2, action: 'transfer', estH: transfers * 0.25, label: `Transfer technicians at ${transfers} turbines (bow on, < 2 kn)` });
  const job = base('crewchange', from, {
    to: from.id, title: `Crew change: ${techs} technicians to ${site.site.name}`, pax: techs,
    needs: sov ? { eq: ['gangway'], unit: 'pax', qty: techs } : { unit: 'pax', qty: techs, maxLoa: 40 },
    steps: [step('board', from.id, { label: 'Technicians board' }), step('sail', at(site.site, site.site.rM), { km, label: `Sail to ${site.site.name}` }), work,
      step('sail', from.id, { km, label: `Back to ${shortName(from)}` }), step('land', from.id, { label: 'Technicians land' })],
    pay: { cr: payCrewchange({ techs, km, sovH }), model: 'lump' }, site: site.site.id,
  });
  return finish(job, from, o.simTime, rnd, o.fit?.cls || (sov ? 'sov90' : 'ctv26'));
};
B.towage = (from, o) => {
  const rnd = o.rnd, disp = Math.round(U(rnd, 20000, 200000) / 1000) * 1000, minBp = Math.ceil(disp / 2000);
  const st = offshore(o.env, from, rnd, 4, 8); if (!st) return null;
  const job = base('towage', from, {
    to: from.id, title: `Assist a ${fmtN(disp)} t ship from the pilot station to her berth`, needs: { minBp },
    steps: [step('meet', at(st, 300), { km: r1(kmBetween(from, st)), maxKn: 8, label: 'Meet her at the pilot station' }),
      step('work', at(from, 2500), { h: 0.5, maxKn: 6, label: 'Assist her alongside' })],
    pay: { cr: payTowage(disp), model: 'lump' }, disp,
  });
  return finish(job, from, o.simTime, rnd, o.fit?.cls || 'tug24');
};
B.ocean_tow = (from, o) => {
  const rnd = o.rnd, bpNeed = I(rnd, 6, 15) * 10;
  const d = pickDest(from, rnd, (h) => h.size !== 'minor', { minKm: 200, maxKm: 3000 }); if (!d) return null;
  const st = offshore(o.env, from, rnd, 3, 6); if (!st) return null;
  const km = seaKm(o.env, from, d.h);
  const job = base('ocean_tow', from, {
    to: d.h.id, title: `Ocean tow: a barge to ${shortName(d.h)} (${fmtN(km)} km, ${bpNeed} t BP)`, needs: { minBp: bpNeed },
    steps: [step('meet', at(st, 300), { km: r1(kmBetween(from, st)), maxKn: 3, label: 'Connect the tow' }),
      step('tow', at(d.h, 4000), { km, maxKn: 7, label: `Tow to ${shortName(d.h)} (≤ 7 kn)` })],
    pay: { cr: payOceanTow({ km, bpNeed }), model: 'lump' }, seaKm: km,
  });
  return finish(job, from, o.simTime, rnd, o.fit?.cls || 'oceantug60');
};
/** Salvage is posted by weather (storms near coasts), not by the board: casualty `{ id, lat, lon, value }`. */
export function generateSalvage(refuge, casualty, simTime, rnd) {
  const pct = Math.round(U(rnd, SALVAGE_PCT[0], SALVAGE_PCT[1]) * 100) / 100;
  const km = r1(kmBetween(refuge, casualty) * RATES.DETOUR);
  const job = base('salvage', refuge, {
    to: refuge.id, title: `Salvage (no cure, no pay): casualty ${km} km off ${shortName(refuge)}`, needs: { minBp: 60 },
    steps: [step('meet', at(casualty, 300), { km, maxKn: 2, label: 'Reach and connect (first to connect wins)', claim: casualty.id }),
      step('tow', at(refuge, 4000), { km, maxKn: 6, label: `Tow to ${shortName(refuge)}` })],
    pay: { cr: paySalvage(casualty.value, pct), pct, value: casualty.value, model: 'award' }, casualty: casualty.id,
  });
  return finish(job, refuge, simTime, rnd, 'oceantug60');
}
B.pilot_transfer = (from, o) => {
  const rnd = o.rnd, disp = Math.round(U(rnd, 10000, 200000) / 1000) * 1000, st = offshore(o.env, from, rnd, 5, 12); if (!st) return null;
  const km = r1(kmBetween(from, st));
  const job = base('pilot_transfer', from, {
    to: from.id, title: `Put a pilot aboard a ${fmtN(disp)} t ship at the pilot station`, needs: { types: ['pilot'] },
    steps: [step('meet', at(st, 60), { km, maxKn: 8, label: 'Come alongside at the pilot station' }), step('drill', at(st, 150), { count: 1, maxKn: 8, action: 'ladder', label: 'Pilot climbs the ladder' }),
      step('sail', from.id, { km, label: 'Back to the pilot station berth' })],
    pay: { cr: payPilot(disp), model: 'lump' }, disp,
  });
  return finish(job, from, o.simTime, rnd, o.fit?.cls || 'pilot');
};
B.bunkering = (from, o) => {
  const rnd = o.rnd, lng = tagsOf(from).has('lng') && rnd() < 0.15, good = lng ? 'lng' : 'fuel';
  const t = o.fit ? Math.floor(Math.min(3000, freeUnits(o.fit.vessel, 't')) * U(rnd, 0.6, 0.95)) : Math.round(U(rnd, 300, 3000) / 10) * 10;
  if (!(t >= 100)) return null;
  const ank = offshore(o.env, from, rnd, 3, 8); if (!ank) return null;
  const km = r1(kmBetween(from, ank)), units = lng ? Math.round(fromTonnes('lng', t)) : t;
  const job = base('bunkering', from, {
    to: from.id, title: `Bunker delivery: ${fmtN(t)} t of ${lng ? 'LNG' : 'fuel'} to a ship at anchor`,
    cargo: { good, unit: CARGO[good].unit, qty: units, t }, needs: { eq: ['hoseCranes'], unit: CARGO[good].unit, qty: units },
    steps: [step('load', from.id, { label: 'Load at the bunker terminal' }), step('meet', at(ank, 100), { km, maxKn: 1, label: 'Come alongside at the anchorage (≤ 1 kn)' }),
      step('work', at(ank, 150), { h: Math.max(0.25, r1(t / 1000)), maxKn: 1, unload: true, label: 'Pump the bunkers' }), step('sail', from.id, { km, label: 'Back to the terminal' })],
    pay: { cr: payBunkering(t), model: 'lump' },
  });
  return finish(job, from, o.simTime, rnd, o.fit?.cls || (lng ? 'lngbv7500' : 'bunker85'));
};
B.launch = (from, o) => {
  const rnd = o.rnd, ank = offshore(o.env, from, rnd, 2, 6); if (!ank) return null;
  const pax = I(rnd, 1, Math.max(1, Math.min(6, o.fit ? unitsOf(o.fit.cls).pax : 6))), t = r1(U(rnd, 0.2, 2)), km = r1(2 * kmBetween(from, ank));
  const job = base('launch', from, {
    to: from.id, title: `Launch: ${pax} crew and ${t} t of stores to a ship at anchor`, pax, cargo: { good: 'supplies', unit: 't', qty: t, t },
    needs: { unit: 'pax', qty: pax, maxLoa: 30 },
    steps: [step('board', from.id, { label: 'Load stores and crew' }), step('meet', at(ank, 50), { km: r1(km / 2), maxKn: 2, label: 'Alongside the ship at anchor', unload: true }),
      step('sail', from.id, { km: r1(km / 2), label: 'Back alongside' }), step('land', from.id, { label: 'Done' })],
    pay: { cr: payLaunch(km), model: 'lump' },
  });
  return finish(job, from, o.simTime, rnd, o.fit?.cls || 'pilot');
};
B.dredge = (from, o) => {
  const rnd = o.rnd, hopper = o.fit ? unitsOf(o.fit.cls).m3 || 5000 : 5000, cycles = I(rnd, 2, 6);
  const box = offshore(o.env, from, rnd, 1.5, 4); const dump = offshore(o.env, from, rnd, 10, 15); if (!box || !dump) return null;
  const km = r1(kmBetween(box, dump) * RATES.DETOUR), fillH = Math.max(0.1, r1((hopper / 2500) * 0.1 * 10) / 10 || 0.2), steps = [];
  steps.push(step('sail', at(box, 1500), { km: r1(kmBetween(from, box)), label: 'To the fairway' }));
  for (let i = 0; i < cycles; i++) {
    steps.push(step('work', at(box, 1500), { h: Math.max(0.2, fillH), maxKn: 3, label: `Cycle ${i + 1}/${cycles}: dredge (≤ 3 kn) until full` }));
    steps.push(step('sail', at(dump, 500), { km, label: 'To the dump circle' }));
    steps.push(step('work', at(dump, 500), { h: 0.05, maxKn: 3, label: 'Open the hopper doors' }));
    if (i < cycles - 1) steps.push(step('sail', at(box, 1500), { km, label: 'Back to the fairway' }));
  }
  const m3 = hopper * cycles;
  const job = base('dredge', from, {
    to: from.id, title: `Maintenance dredging: ${cycles} hopper loads (${fmtN(m3)} m³)`, needs: { handling: ['hopper'], jones: from.country === 'US' || undefined },
    steps, pay: { cr: payDredge(m3), model: 'lump' }, m3,
  });
  if (!job.needs.jones) delete job.needs.jones;
  return finish(job, from, o.simTime, rnd, o.fit?.cls || 'tshd100');
};
B.survey = (from, o) => {
  const rnd = o.rnd, n = I(rnd, 2, 8), len = Math.round(U(rnd, 5, 20)), area = offshore(o.env, from, rnd, 10, 60); if (!area) return null;
  const hdg = rnd() * 180, steps = [];
  let lineKm = 0, prev = from;
  for (let i = 0; i < n; i++) {
    const s0 = destination(area.lat, area.lon, hdg + 90, (i - n / 2) * 500), a = i % 2 ? destination(s0.lat, s0.lon, hdg, len * 1000) : s0, b = i % 2 ? s0 : destination(s0.lat, s0.lon, hdg, len * 1000);
    steps.push(step('meet', at(a, 200), { km: r1(kmBetween(prev, a)), maxKn: 6, label: `Line ${i + 1}/${n}: start` }));
    steps.push(step('sail', at(b, 200), { km: len, minKn: 4, maxKn: 6, resetTo: steps.length - 1, label: `Run line ${i + 1} at 4–6 kn` }));
    lineKm += len; prev = b;
  }
  steps.push(step('sail', from.id, { km: r1(kmBetween(prev, from) * RATES.DETOUR), label: `Back to ${shortName(from)}` }));
  const job = base('survey', from, { to: from.id, title: `Survey: ${n} lines of ${len} km`, needs: { eq: ['survey'] }, steps, pay: { cr: paySurvey(lineKm), model: 'lump' }, lineKm });
  return finish(job, from, o.simTime, rnd, o.fit?.cls || 'research75');
};
B.research = (from, o) => {
  const rnd = o.rnd, sci = I(rnd, 10, Math.max(10, Math.min(30, o.fit ? unitsOf(o.fit.cls).pax : 30))), n = I(rnd, 3, 6), steps = [step('board', from.id, { label: `${sci} scientists board` })];
  let prev = from;
  for (let i = 0; i < n; i++) {
    const p = offshore(o.env, prev, rnd, 20, 80); if (!p) return null;
    steps.push(step('sail', at(p, 300), { km: r1(kmBetween(prev, p) * RATES.DETOUR), label: `To station ${i + 1}` }));
    steps.push(step('work', at(p, 300), { h: 1, maxKn: 1, label: `CTD cast at station ${i + 1} (≤ 1 kn)` }));
    prev = p;
  }
  steps.push(step('sail', from.id, { km: r1(kmBetween(prev, from) * RATES.DETOUR), label: 'Back to port' }), step('land', from.id, { label: 'Scientists land' }));
  const job = base('research', from, { to: from.id, title: `Science cruise: ${sci} scientists, ${n} stations`, pax: sci, needs: { eqAny: ['aframe', 'moonpool'], unit: 'pax', qty: sci }, steps, stations: n });
  const refCls = o.fit?.cls || 'research75';
  job.pay = { cr: payResearch({ hours: Math.round(stepHours(job, refCls)), stations: n }), model: 'lump' };
  return finish(job, from, o.simTime, rnd, refCls);
};
B.escort = (from, o) => {
  const rnd = o.rnd; if (!iceNeedAt(from, o.simTime)) return null;
  const edge = offshore(o.env, from, rnd, 50, 400); if (!edge) return null;
  const km = r1(kmBetween(edge, from) * RATES.DETOUR);
  const job = base('escort', from, {
    to: from.id, title: `Icebreaker escort: lead a convoy ${fmtN(km)} km into ${shortName(from)}`, needs: { ice: 'pc6' },
    steps: [step('meet', at(edge, 2000), { km, maxKn: 10, label: 'Meet the convoy at the ice edge' }), step('tow', at(from, 3000), { km, maxKn: 10, label: 'Lead the convoy (≤ 10 kn, keep them within 2 km)' })],
    pay: { cr: payEscort(km), model: 'lump' },
  });
  return finish(job, from, o.simTime, rnd, o.fit?.cls || 'icebreaker120');
};
// --- sailing and yachts
export const LESSON_TASKS = {
  tack: { label: 'Tack', stat: 'tacks', n: [3, 8], min: 1 }, gybe: { label: 'Gybe', stat: 'gybes', n: [2, 6], min: 1 },
  reef: { label: 'Reef and shake out', stat: 'reefs', n: [1, 1], min: 1 }, heaveto: { label: 'Heave-to', action: 'heaveto', n: [1, 1], min: 2 },
  mob: { label: 'Man-overboard drill', action: 'mob', n: [1, 2], min: 1 }, mooring: { label: 'Pick up a mooring buoy', action: 'mooring', n: [1, 1], min: 1 },
  anchor: { label: 'Anchor', action: 'anchor', n: [1, 1], min: 2 }, passage20: { label: 'Passage ≥ 20 nm', nm: 20, n: [1, 1], min: 3 }, passage60: { label: '60 nm offshore', nm: 60, n: [1, 1], min: 4 },
};
B.lesson = (from, o) => {
  const rnd = o.rnd, r = rnd(), level = r < 0.4 ? 1 : r < 0.7 ? 2 : r < 0.9 ? 3 : 4;
  const motor = level <= 2 && rnd() < 0.2 && (!o.fit || !rowOf(o.fit.cls)?.sail);
  const maxStud = o.fit ? Math.max(1, Math.min(5, unitsOf(o.fit.cls).pax - 1)) : 5;
  const students = I(rnd, 1, maxStud);
  const pool = Object.entries(LESSON_TASKS).filter(([, t]) => t.min <= level && (!motor || !t.stat)), k = Math.min(pool.length, I(rnd, 2, 4)), tasks = [];
  const bag = [...pool];
  for (let i = 0; i < k; i++) tasks.push(bag.splice(Math.floor(rnd() * bag.length), 1)[0]);
  const steps = [step('board', from.id, { label: `${students} student${students > 1 ? 's' : ''} board` })];
  for (const [id, t] of tasks) {
    const n = I(rnd, t.n[0], t.n[1]);
    if (t.nm) steps.push(step('sail', null, { nm: t.nm, km: t.nm * NM, optional: true, task: id, label: t.label }));
    else steps.push(step('drill', null, { count: n, stat: t.stat, action: t.action, optional: true, task: id, estH: 0.15 * n, label: `${t.label}${n > 1 ? ` × ${n}` : ''}` }));
  }
  steps.push(step('land', from.id, { afterSea: true, label: 'Back alongside' }));
  const maxWindKn = lessonWindKn(level);
  const job = base('lesson', from, {
    to: from.id, title: `${motor ? 'Powerboat' : 'Sailing'} lesson, Level ${level}: ${students} student${students > 1 ? 's' : ''}`, pax: students, level,
    needs: { sail: !motor || undefined, motor: motor || undefined, level, maxWindKn, unit: 'pax', qty: students + 1 },
    steps, pay: { cr: payLesson({ level, students, allTasks: false }), bonus: { kind: 'tasks', cr: payLesson({ level, students, allTasks: true }) - payLesson({ level, students }) }, model: 'lump' },
  });
  for (const key of ['sail', 'motor']) if (job.needs[key] === undefined) delete job.needs[key];
  return finish(job, from, o.simTime, rnd, o.fit?.cls || (motor ? 'cruiser' : 'sloop'));
};
B.daycharter = (from, o) => {
  const rnd = o.rnd, cap = o.fit ? Math.min(12, unitsOf(o.fit.cls).pax) : 12; if (cap < 2) return null;
  const guests = I(rnd, 2, cap), h = I(rnd, 2, 6), rate = Math.round(U(rnd, 150, 400) / 10) * 10, sunset = rnd() < 0.25;
  const job = base('daycharter', from, {
    to: from.id, title: `${sunset ? 'Sunset' : 'Day'} charter: ${guests} guests, ${h} h`, pax: guests, needs: { unit: 'pax', qty: guests, paxCert: guests > 12 },
    steps: [step('board', from.id, { label: 'Guests board' }), step('work', null, { h, atSea: true, comfort: true, label: `${h} h out at sea` }), step('land', from.id, { afterSea: true, label: 'Back alongside' })],
    pay: { cr: guests * rate, rate, bonus: { kind: 'tip', cr: Math.round(guests * rate * PAY.DAYCHARTER_TIP_MAX) }, model: 'lump' },
  });
  return finish(job, from, o.simTime, rnd, o.fit?.cls || 'myacht');
};
B.bareboat = (from, o) => {
  const rnd = o.rnd, h = I(rnd, 24, 168);
  const job = base('bareboat', from, {
    to: from.id, title: `Bareboat charter: ${h} h (your docked yacht is chartered out)`, needs: {},
    steps: [step('work', null, { h, chartered: true, label: `Chartered out for ${h} h` })],
    pay: { cr: 0, perH: 0, rate: PAY.BAREBOAT_HIRE, hireH: h, model: 'hire' },
  });
  const refCls = o.fit?.cls || 'sloop';
  job.pay.perH = Math.round(hireBasis(refCls) * PAY.BAREBOAT_HIRE); job.pay.cr = job.pay.perH * h;
  return finish(job, from, o.simTime, rnd, refCls);
};
B.regatta = (from, o) => {
  const rnd = o.rnd, coastal = rnd() < 0.4, entries = I(rnd, 4, 12);
  const startAt = Math.ceil((o.simTime + 3600) / 21600) * 21600;
  const start = offshore(o.env, from, rnd, 2, 4); if (!start) return null;
  const windFrom = rnd() * 360, marks = [];
  let courseNm;
  if (coastal) {
    courseNm = I(rnd, 10, 30);
    const m1 = destination(start.lat, start.lon, windFrom + U(rnd, -60, 60), (courseNm / 2) * NM * 1000);
    marks.push(at(m1, 100), at(start, 150));
  } else {
    courseNm = 8; const w = destination(start.lat, start.lon, windFrom, 2 * NM * 1000);
    marks.push(at(w, 100), at(start, 100), at(w, 100), at(start, 150));
  }
  const field = Array.from({ length: entries - 1 }, () => Math.round((courseNm / 6) * U(rnd, 0.9, 1.25) * 3600));
  const job = base('regatta', from, {
    to: from.id, title: `Regatta: ${coastal ? `${courseNm} nm coastal race` : 'windward-leeward 2 × 2 nm'}, ${entries} entries`,
    needs: { sail: true }, entries, field, courseNm,
    steps: [step('meet', at(start, 500), { km: r1(kmBetween(from, start)), label: 'To the start area' }),
      step('race', null, { marks, startAt, km: courseNm * NM, label: `Race: start ${new Date(startAt * 1000).toISOString().slice(11, 16)} UTC` })],
    pay: { cr: Math.round(regattaPurse(entries) * PAY.REGATTA_SPLIT[0]), entry: PAY.REGATTA_ENTRY, purse: regattaPurse(entries), model: 'award' },
  });
  return finish(job, from, o.simTime, rnd, o.fit?.cls || 'sloop');
};
B.ecotour = (from, o) => {
  const rnd = o.rnd, sites = ecoSitesFor(from.id); if (!sites.length) return null;
  const s = pick(rnd, sites), cap = o.fit ? Math.min(12, unitsOf(o.fit.cls).pax) : 12; if (cap < 2) return null;
  const guests = I(rnd, 2, cap), h = I(rnd, 1, 3), km = r1(kmBetween(from, s) * RATES.DETOUR);
  const job = base('ecotour', from, {
    to: from.id, title: `Whale watching: ${guests} guests to ${s.name}`, pax: guests, needs: { unit: 'pax', qty: guests, paxCert: guests > 12 }, site: s.id,
    steps: [step('board', from.id, { label: 'Guests board' }), step('sail', at(s, s.rM), { km, label: `To ${s.name}` }),
      step('work', at(s, s.rM), { h, maxKn: 7, label: `${h} h in the area (≤ 7 kn, keep 100 m from the animals)` }), step('sail', from.id, { km }), step('land', from.id, { afterSea: true, label: 'Guests land' })],
    pay: { cr: payEcotour({ guests }), bonus: { kind: 'sighting', cr: payEcotour({ guests, sighting: true }) - payEcotour({ guests }) }, p: s.months.includes(monthOf(o.simTime)) ? s.p : s.p * 0.3, model: 'lump' },
  });
  return finish(job, from, o.simTime, rnd, o.fit?.cls || 'myacht');
};
B.guests = (from, o) => {
  const rnd = o.rnd, cap = o.fit ? unitsOf(o.fit.cls).pax : 24, guests = I(rnd, 6, Math.max(6, Math.min(36, cap))), n = I(rnd, 2, 4), steps = [step('board', from.id, { label: `${guests} guests board` })];
  let prev = from;
  for (let i = 0; i < n; i++) {
    const p = offshore(o.env, prev, rnd, 10, 40); if (!p) return null;
    steps.push(step('sail', at(p, 400), { km: r1(kmBetween(prev, p) * RATES.DETOUR), label: `To anchorage ${i + 1}` }));
    steps.push(step('work', at(p, 400), { h: I(rnd, 2, 6), maxKn: 1, comfort: true, label: 'At anchor: tender runs and water toys' }));
    prev = p;
  }
  steps.push(step('sail', from.id, { km: r1(kmBetween(prev, from) * RATES.DETOUR) }), step('land', from.id, { afterSea: true, label: 'Guests disembark' }));
  const job = base('guests', from, { to: from.id, title: `Superyacht programme: ${guests} guests, ${n} anchorages`, pax: guests, needs: { eq: ['tender'], unit: 'pax', qty: guests, paxCert: guests > 12 }, steps });
  const refCls = o.fit?.cls || 'superyacht', hireH = Math.max(24, Math.round(stepHours(job, refCls)));
  job.pay = { cr: Math.round(hireBasis(refCls) * PAY.GUESTS_HIRE) * hireH, perH: Math.round(hireBasis(refCls) * PAY.GUESTS_HIRE), rate: PAY.GUESTS_HIRE, hireH, model: 'hire' };
  return finish(job, from, o.simTime, rnd, refCls);
};
B.delivery = (from, o) => {
  const rnd = o.rnd, d = pickDest(from, rnd, (h) => tagsOf(h).has('marina'), { minKm: 185, maxKm: 1100 }); if (!d) return null;
  const km = seaKm(o.env, from, d.h), nm = Math.round(km / NM), crew = I(rnd, 1, Math.max(1, Math.min(3, (o.fit ? unitsOf(o.fit.cls).pax : 4) - 1)));
  const job = base('delivery', from, {
    to: d.h.id, title: `Delivery passage: ${nm} nm to ${shortName(d.h)} with ${crew} crew building sea miles`, pax: crew,
    needs: { unit: 'pax', qty: crew + 1, maxWindKn: 30 },
    steps: [step('board', from.id, { label: 'Crew boards' }), step('sail', d.h.id, { km }), step('land', d.h.id, { label: 'Crew signs off' })],
    pay: { cr: payDelivery({ crew, nm }), model: 'lump' }, seaKm: km,
  });
  return finish(job, from, o.simTime, rnd, o.fit?.cls || 'ketch');
};
export const BUILDERS = B;

// ------------------------------------------------------------------------------------------------ fishing (extended)
/** Decorate a legacy fishing job with species, season and the species price (§5.5); null when the season is closed. */
export function extendFishing(job, simTime, rnd) {
  const g = FISHING_GROUNDS.find((x) => x.id === job.ground); if (!g) return job;
  const sp = speciesFor(g, monthOf(simTime));
  if (!sp.length) return null;
  const species = pick(rnd, sp), size = harborById(job.from)?.size || 'mega';
  job.species = species; job.quotaGround = g.id;
  job.pay = payFish({ qty: job.qty, species, size });
  job.title = job.title.replace(/of fish/, `of ${species}`);
  return job;
}

// ------------------------------------------------------------------------------------------------ board
function legacyJob(from, simTime, rnd, type, env) {
  const j = env?.legacy ? env.legacy(from, simTime, rnd, type) : legacyGenerateJob(from, simTime, rnd, type, env);
  if (!j) return null;
  j.gen = JOB_GEN; j.family = j.type;
  if (j.type === 'fishing') return extendFishing(j, simTime, rnd) || j;
  return j;
}
/** One job of family `type` at `from` (legacy families via economy.generateJob), or null. */
export function generateFamilyJob(from, simTime, rnd, type, env = {}, opts = {}) {
  if (FAMILIES[type]?.legacy) return legacyJob(from, simTime, rnd, type, env);
  const b = B[type]; if (!b) return null;
  return b(from, { rnd, simTime, env, good: opts.good || null, fit: opts.fit || null, fitGoods: opts.fitGoods || null });
}
function drawEntry(entries, rnd) {
  const total = entries.reduce((s, e) => s + e.w, 0);
  let r = rnd() * total;
  for (const e of entries) { r -= e.w; if (r <= 0) return e; }
  return entries[entries.length - 1];
}
/** A full board for harbour `h`: BOARD_SIZE jobs drawn from weightsFor (families with no valid job are redrawn). */
export function generateBoard(h, simTime, rnd, env = {}, { n = BOARD_SIZE[h.size] || 6, phase = 4 } = {}) {
  const entries = weightsFor(h, simTime, { phase }), out = [];
  let guard = 0;
  while (out.length < n && guard++ < n * 6) {
    const e = drawEntry(entries, rnd);
    const j = generateFamilyJob(h, simTime, rnd, e.type, env, { good: e.good });
    if (j) out.push(j);
  }
  return out;
}

/** Goods a ship can lift on a voyage charter. */
function voyageGoodsFor(cls) {
  return [...new Set(['grain', 'ore', 'coal', 'steel', 'crude', 'fuel', 'chemicals', 'lpg', 'lng', 'livestock', 'fruit', ...VOYAGE_GOODS])].filter((g) => !!loadOption(g, cls));
}

/**
 * Fit guarantee (§5.7): when fewer than FIT_MIN board jobs pass `canDo` for `vessel` docked at `h`, add jobs of her
 * families from this harbour, sized to her, until FIT_MIN pass (or nothing more can be made). Returns the added jobs
 * (also pushed onto `board`).
 */
export function ensureFit(board, h, vessel, ctx, simTime, rnd, env = {}, { phase = 4, min = FIT_MIN } = {}) {
  const cls = vessel?.ship?.cls ?? vessel?.cls;
  const okCount = () => board.filter((j) => canDo(j, vessel, ctx).ok).length;
  let have = okCount();
  const added = [];
  if (have >= min || !cls) return added;
  const weights = new Map(weightsFor(h, simTime, { phase: 4 }).map((e) => [e.type, e.w]));
  const fams = familiesFor(cls, { phase }).sort((a, b) => (weights.get(b) || 0) - (weights.get(a) || 0));
  const fit = { cls, vessel, geared: eqOf(cls).includes('geared') };
  const goods = voyageGoodsFor(cls);
  let guard = 0;
  for (let round = 0; have < min && round < 4; round++) {
    for (const type of fams) {
      if (have >= min || guard++ > 60) break;
      let j = null;
      for (let tries = 0; tries < 3 && !j; tries++) {
        const cand = generateFamilyJob(h, simTime, rnd, type, env, { fit, fitGoods: goods });
        if (cand && canDo(cand, vessel, ctx).ok) j = cand;
      }
      if (j) { j.fitFor = cls; board.push(j); added.push(j); have++; }
    }
  }
  return added;
}
export { payOf };
