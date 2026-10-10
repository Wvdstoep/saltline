// Job families (docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §5.5): what each family needs from a ship, how it is paid
// (Game rules; the formulas are the contract's) and how many ship-hours it takes. The generator (server/jobsgen.js) and
// the step runner (server/jobsx.js) build on these; the job board and `canDo` read them. Pure; plain ESM, browser-safe.
import { CARGO, unitsOf, handlingOf, eqOf, toTonnes } from '../cargo.js';
import { typeOf, loaOf, isSail, isYacht, bpOf, basePriceOf, serviceKnOf, iceRank, ICE_RANK, rowOf } from './shipview.js';
import { payOf, payInfoOf } from './types.js';
import { CATALOGUE } from '../econ/catalogue.js';
import { cruiseIncome, fareOf } from './cruises.js';

export const PAY = {
  PER_T_KM: 0.08,
  SIZE_MULT: { mega: 1.0, major: 1.0, regional: 1.05, minor: 1.15 },
  GOOD_MUL: { grain: 0.75, coal: 0.6, ore: 0.5, steel: 1.0, crude: 0.55, fuel: 0.75, chemicals: 1.2, lpg: 1.4, lng: 1.8, fruit: 1.6, livestock: 1.8 },
  BOX_MUL: 1.3, REEFER_MUL: 1.4, DG_MUL: 1.3, LINER_MUL: 1.1, LINER_ONTIME: 0.1, COA_MUL: 1.05,
  TC_HIRE: 0.0025, PROJECT_MUL: 2.5, PROJECT_PIECE: 5000, VEHICLE_MUL: 1.6,
  ROPAX_ONTIME: 0.15, ROPAX_WINDOW_S: 900,
  CRUISE_CR: 20, EXPEDITION_MUL: 2, ANCHOR_KM: 400, ANCHOR_WORK_H: 2500, STANDBY_H: 900,
  CREW_BASE: 60, CREW_KM: 0.8, SOV_H: 1200, TOWAGE_BASE: 600, TOWAGE_DISP: 0.006, OCEAN_TOW_KM: 200, OCEAN_TOW_BP: 2,
  PILOT_BASE: 500, PILOT_DISP: 0.002,            // Game rule placeholder until V7 #2 sets pilotage pay (verify)
  BUNKER_T: 25, BUNKER_BASE: 1500, LAUNCH_BASE: 400, LAUNCH_KM: 25, DREDGE_M3: 2.5, SURVEY_KM: 300,
  RESEARCH_H: 1500, RESEARCH_STATION: 3000, ESCORT_KM: 180,
  LESSON: { 1: 400, 2: 700, 3: 1000, 4: 1500 }, LESSON_ALL_TASKS: 0.2, LESSON_WIND_KN: { 1: 14, 2: 18, 3: 24, 4: 30 },
  DAYCHARTER_TIP_MAX: 0.25, BAREBOAT_HIRE: 0.0006, BAREBOAT_COND_DAY: 0.5, BAREBOAT_CLAIM_P: 0.05, BAREBOAT_DEDUCT: 0.02,
  REGATTA_ENTRY: 500, REGATTA_PURSE: 5000, REGATTA_SPLIT: [0.5, 0.3, 0.2],
  ECO_GUEST: 120, ECO_SIGHTING: 0.5, GUESTS_HIRE: 0.002, GUESTS_TIP_MAX: 0.15,
  DELIVERY_CREW: 250, DELIVERY_NM: 4,             // Game rule (verify): mile-building delivery passage
  FISH_CR_T: 950,
};
// World economy §9.2: one multiplier table for trading and contracts — every catalogue good's fmul (legacy rows unchanged).
for (const r of CATALOGUE) if (!(r.id in PAY.GOOD_MUL)) PAY.GOOD_MUL[r.id] = r.fmul;
export const PORT_H = 0.5;                         // per harbour call step (load / discharge / board / land)
export const SALVAGE_PCT = [0.08, 0.15];           // LOF / Salvage Convention 1989 Art. 13 award band [S15]

/** Economy of scale (§5.5): max(0.5, (t / 2,000)^−0.12). */
export function eos(t) { return t > 0 ? Math.max(0.5, Math.pow(t / 2000, -0.12)) : 1; }
const sizeMul = (size) => PAY.SIZE_MULT[size] ?? 1;
const R = Math.round;

// ------------------------------------------------------------------------------------------------ pay formulas
export function payBox({ teu, reeferTeu = 0, dg = false, km, size = 'mega' }) {
  const t = teu * 12, ref = teu > 0 ? 1 + (PAY.REEFER_MUL - 1) * Math.min(1, reeferTeu / teu) : 1;
  return R(t * km * PAY.PER_T_KM * PAY.BOX_MUL * eos(t) * ref * (dg ? PAY.DG_MUL : 1) * sizeMul(size));
}
export function payVoyage({ good, t, km, size = 'mega' }) { return R(t * km * PAY.PER_T_KM * (PAY.GOOD_MUL[good] ?? 1) * eos(t) * sizeMul(size)); }
export function payProject({ t, pieces, km, size = 'mega' }) { return R(t * km * PAY.PER_T_KM * PAY.PROJECT_MUL * eos(t) * sizeMul(size) + PAY.PROJECT_PIECE * pieces); }
export function payVehicles({ good = 'vehicles', units, km, size = 'mega' }) { const t = toTonnes(good, units); return R(t * km * PAY.PER_T_KM * PAY.VEHICLE_MUL * eos(t) * sizeMul(size)); }
export function payRopaxCrossing({ pax, lm, km }) { return R(pax * (25 + 0.35 * km) + lm * 2.2 * km * PAY.PER_T_KM * PAY.VEHICLE_MUL); }
/** Cruise charter: with a cruise ship class (`cls`) the net ticket fare of her class plus the onboard spending of her venues
 * (shared/jobs/cruises.js, docs/CRUISE-CONTRACT.md §3); without one the old flat rate (kept for old jobs and tests). */
export function payCruise({ guests, hours, comfort = 1, expedition = false, cls = null }) {
  if (cls && fareOf(cls) != null) { const c = cruiseIncome({ guests, hours, cls }); return R(c.ticket + c.onboard); }
  return R(guests * PAY.CRUISE_CR * hours * (0.85 + 0.075 * comfort) * (expedition ? PAY.EXPEDITION_MUL : 1));
}
export function payAnchor({ km, workH, size = 'mega' }) { return R((km * PAY.ANCHOR_KM + workH * PAY.ANCHOR_WORK_H) * sizeMul(size)); }
export function payStandby(h) { return R(PAY.STANDBY_H * h); }
export function payCrewchange({ techs, km, sovH = 0 }) { return R(techs * (PAY.CREW_BASE + PAY.CREW_KM * km) + PAY.SOV_H * sovH); }
export function payTowage(disp) { return R(PAY.TOWAGE_BASE + PAY.TOWAGE_DISP * disp); }
export function payOceanTow({ km, bpNeed }) { return R(km * (PAY.OCEAN_TOW_KM + PAY.OCEAN_TOW_BP * bpNeed)); }
export function paySalvage(value, pct) { return R(value * pct); }
export function payPilot(disp) { return R(PAY.PILOT_BASE + PAY.PILOT_DISP * disp); }
export function payBunkering(t) { return R(t * PAY.BUNKER_T + PAY.BUNKER_BASE); }
export function payLaunch(km) { return R(PAY.LAUNCH_BASE + PAY.LAUNCH_KM * km); }
export function payDredge(m3) { return R(PAY.DREDGE_M3 * m3); }
export function paySurvey(lineKm) { return R(PAY.SURVEY_KM * lineKm); }
export function payResearch({ hours, stations }) { return R(PAY.RESEARCH_H * hours + PAY.RESEARCH_STATION * stations); }
export function payEscort(km) { return R(PAY.ESCORT_KM * km); }
export function payLesson({ level, students, allTasks = false }) { return R((PAY.LESSON[level] || 0) * students * (allTasks ? 1 + PAY.LESSON_ALL_TASKS : 1)); }
export function payDaycharter({ guests, rate, tipFrac = 0 }) { return R(guests * rate * (1 + Math.max(0, Math.min(PAY.DAYCHARTER_TIP_MAX, tipFrac)))); }
export function payEcotour({ guests, sighting = false }) { return R(guests * PAY.ECO_GUEST * (sighting ? 1 + PAY.ECO_SIGHTING : 1)); }
export function payDelivery({ crew, nm }) { return R(PAY.DELIVERY_CREW * crew + PAY.DELIVERY_NM * nm); }
/** Hire rates (cr/h) that depend on the ship that takes the job. */
/** Hire basis: the base price, at least 120,000 (the hull basis floor of economy/fleet, so the free starter coaster earns hire). */
export function hireBasis(cls) { return Math.max(120000, basePriceOf(cls) || 0); }
export function tcHirePerH(cls) { return R(hireBasis(cls) * PAY.TC_HIRE); }
export function bareboatPerH(cls) { return R(hireBasis(cls) * PAY.BAREBOAT_HIRE); }
export function guestsPerH(cls) { return R(hireBasis(cls) * PAY.GUESTS_HIRE); }
/** Regatta: purse = entry fees + 5,000; prizes 50/30/20 % for places 1–3. */
export function regattaPurse(entries) { return entries * PAY.REGATTA_ENTRY + PAY.REGATTA_PURSE; }
export function regattaPrize(entries, place) { const s = PAY.REGATTA_SPLIT[place - 1]; return s ? R(regattaPurse(entries) * s) : 0; }
/** Lesson wind limit (true wind, kn) for a level. */
export function lessonWindKn(level) { return PAY.LESSON_WIND_KN[level] ?? 14; }

// ------------------------------------------------------------------------------------------------ fishing (extended)
/** Species price multipliers of 950 cr/t (§5.5) and their seasons (months 1–12, Game rule inspired by real seasons). */
export const SPECIES = {
  cod: { name: 'Cod', mul: 1.2, months: [1, 2, 3, 4, 9, 10, 11, 12] },
  herring: { name: 'Herring', mul: 0.6, months: [6, 7, 8, 9, 10] },
  mackerel: { name: 'Mackerel', mul: 0.8, months: [1, 2, 3, 9, 10, 11, 12] },
  sole: { name: 'Sole and plaice', mul: 1.8, months: [3, 4, 5, 6, 7, 8, 9, 10] },
  crab: { name: 'Crab', mul: 3.0, months: [1, 2, 10, 11, 12] },
  tuna: { name: 'Tuna', mul: 2.2, months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
};
/** Species a ground offers in `month` (by region; Game rule). */
export function speciesFor(ground, month) {
  const lat = ground.lat, lon = ground.lon;
  let pool;
  if (Math.abs(lat) < 30) pool = ['tuna'];
  else if (lat > 50 && lat < 56 && lon > -6 && lon < 10) pool = ['sole', 'cod', 'herring'];
  else if (lon < -140 || (lat > 50 && lon > 140)) pool = ['crab', 'cod'];
  else if (lat > 56) pool = ['cod', 'herring', 'mackerel'];
  else pool = ['cod', 'mackerel', 'herring'];
  const open = pool.filter((s) => SPECIES[s].months.includes(month));
  return open.length ? open : [];
}
/** Weekly quota per company per ground (Game rule §5.5 / Q16): 10 × the hold of the best licensed boat. */
export function weeklyQuota(bestHoldT) { return Math.round(10 * Math.max(0, bestHoldT || 0)); }
export function quotaWeek(simTime) { return Math.floor(simTime / (7 * 86400)); }
/** Value fraction of a catch `hours` after it was caught: without RSW/freezer −2 %/h after 12 h (floor 0.3). */
export function fishValueFrac(hours, cold) { return cold || hours <= 12 ? 1 : Math.max(0.3, 1 - 0.02 * (hours - 12)); }
export function payFish({ qty, species, size = 'mega' }) { return R(qty * PAY.FISH_CR_T * (SPECIES[species]?.mul ?? 1) * sizeMul(size)); }

// ------------------------------------------------------------------------------------------------ ship fit (static)
const CARGO_TYPES = ['general', 'container', 'bulk', 'tanker', 'gas', 'roro'];
const PAX_TYPES = ['ferry', 'cruise'];
/** Is `cls` a passenger ship (SOLAS I/2: may carry more than 12 passengers)? */
export function isPassengerShip(cls) {
  if (PAX_TYPES.includes(typeOf(cls)) || eqOf(cls).includes('pyc') || eqOf(cls).includes('paxcert')) return true;
  return isYacht(cls) && unitsOf(cls).pax > 12;   // Game rule: a yacht certified for > 12 guests runs under a passenger yacht code
}
const hasH = (cls, h) => handlingOf(cls).includes(h);
const hasEq = (cls, e) => eqOf(cls).includes(e);

/** A family's quick ship test (no job details): null when this hull can do the family at all, else a short reason. */
const FIT = {
  freight: (c) => (['bulk', 'breakbulk', 'box'].some((h) => hasH(c, h)) ? null : 'needs a dry-cargo hold'),
  passengers: (c) => (unitsOf(c).pax >= 4 ? null : 'needs passenger berths'),
  charter: (c) => (isYacht(c) || typeOf(c) === 'ferry' || typeOf(c) === 'cruise' ? null : 'needs a yacht or ferry'),
  fishing: (c) => ((rowOf(c)?.fishRate || 0) > 0 && hasH(c, 'fish') ? null : 'this hull cannot fish'),
  supply: (c) => (hasH(c, 'deck') ? null : 'needs an offshore cargo deck'),
  tow: () => null,
  smuggling: (c) => (hasH(c, 'box') || hasH(c, 'breakbulk') ? null : 'needs a hold for crates'),
  box: (c) => (hasH(c, 'box') ? null : 'needs a container ship'),
  liner: (c) => (hasH(c, 'box') && unitsOf(c).teu >= 300 ? null : 'needs a container ship'),
  voyage: (c) => (['bulk', 'liquid:clean', 'liquid:crude', 'liquid:chem', 'gas:lpg', 'gas:lng', 'livestock', 'reefer'].some((h) => hasH(c, h)) && CARGO_TYPES.includes(typeOf(c)) ? null : 'needs a bulk carrier, tanker or gas carrier'),
  coa: (c) => FIT.voyage(c),
  tc: (c) => (CARGO_TYPES.includes(typeOf(c)) ? null : 'needs a cargo ship'),
  project: (c) => (hasH(c, 'heavy') ? null : 'needs heavy-lift cranes'),
  vehicles: (c) => (hasH(c, 'roro') && (unitsOf(c).ceu > 0 || unitsOf(c).lm > 0) ? null : 'needs a ro-ro deck'),
  ropax_route: (c) => (hasH(c, 'pax') && hasH(c, 'roro') && isPassengerShip(c) ? null : 'needs a ro-pax ferry'),
  cruise: (c) => (typeOf(c) === 'cruise' ? null : 'needs a cruise ship'),
  anchor: (c) => (hasEq(c, 'towWinch') && hasEq(c, 'sternRoller') && bpOf(c) >= 80 ? null : 'needs an anchor handler (AHTS)'),
  standby: (c) => (typeOf(c) === 'offshore' || (typeOf(c) === 'tug' && loaOf(c) >= 30) ? null : 'needs an offshore vessel or a tug ≥ 30 m'),
  crewchange: (c) => ((typeOf(c) === 'workboat' && unitsOf(c).pax >= 6) || hasEq(c, 'gangway') ? null : 'needs a crew transfer vessel or SOV'),
  towage: (c) => (typeOf(c) === 'tug' && bpOf(c) >= 10 ? null : 'needs a tug'),
  ocean_tow: (c) => ((typeOf(c) === 'tug' || hasEq(c, 'towWinch')) && bpOf(c) >= 60 ? null : 'needs an ocean tug or AHTS'),
  salvage: (c) => ((typeOf(c) === 'tug' || hasEq(c, 'towWinch')) && bpOf(c) >= 60 ? null : 'needs a salvage tug or AHTS'),
  pilot_transfer: (c) => (typeOf(c) === 'pilot' ? null : 'needs a pilot boat'),
  bunkering: (c) => (hasEq(c, 'hoseCranes') && loaOf(c) <= 130 && (hasH(c, 'liquid:clean') || hasH(c, 'gas:lng')) ? null : 'needs a bunker tanker'),
  launch: (c) => (loaOf(c) <= 30 && unitsOf(c).pax >= 1 ? null : 'needs a launch ≤ 30 m'),
  dredge: (c) => (hasH(c, 'hopper') ? null : 'needs a hopper dredger'),
  survey: (c) => (hasEq(c, 'survey') ? null : 'needs survey equipment'),
  research: (c) => (hasEq(c, 'aframe') || hasEq(c, 'moonpool') ? null : 'needs a research ship'),
  escort: (c) => (iceRank(c) >= ICE_RANK.pc6 || (iceRank(c) >= ICE_RANK.i1as && bpOf(c) >= 60) ? null : 'needs a Polar Class hull (or 1A Super with bollard pull)'),
  lesson: (c) => (isSail(c) || typeOf(c) === 'motor_yacht' ? null : 'needs a sailing or motor yacht'),
  daycharter: (c) => (isYacht(c) ? null : 'needs a yacht'),
  bareboat: (c) => (isYacht(c) && loaOf(c) <= 30 ? null : 'needs a yacht ≤ 30 m'),
  regatta: (c) => (isSail(c) ? null : 'needs a sailing yacht'),
  ecotour: (c) => (isYacht(c) || typeOf(c) === 'ferry' || typeOf(c) === 'workboat' || typeOf(c) === 'pilot' ? null : 'needs a small passenger boat'),
  guests: (c) => (typeOf(c) === 'motor_yacht' && loaOf(c) >= 40 && hasEq(c, 'tender') ? null : 'needs a superyacht ≥ 40 m with a tender'),
  delivery: (c) => (isYacht(c) ? null : 'needs a yacht'),
};

/** Group of a job for the filter chips (voyage depends on the good). */
function voyageGroup(job) { const g = job?.cargo?.good; return ['crude', 'fuel', 'chemicals', 'lpg', 'lng'].includes(g) ? 'tankers' : 'cargo'; }

const F = (label, group, unit, captains, phase, extra = {}) => ({ label, group, unit, captains, phase, legacy: false, ...extra });
/**
 * FAMILIES[type] = { label, group (string | fn(job)), unit, captains, phase, legacy, fit(cls) → reason|null,
 *   pay(job, env) → { cr, perH?, bonus?, model }, hours(job, cls) → ship-hours needed }.
 * `needs(job)` / `steps(job)` return what the generator stored on the job (legacy jobs: derived needs, no steps).
 */
export const FAMILIES = {
  freight: F('Freight', 'cargo', 't', true, 0, { legacy: true }),
  passengers: F('Passengers', 'passengers', 'pax', true, 0, { legacy: true }),
  charter: F('Skippered charter', 'yachts', 'pax', true, 0, { legacy: true }),
  fishing: F('Fishing', 'fishing', 't', true, 0, { legacy: true }),
  supply: F('Offshore supply', 'offshore', 't', true, 0, { legacy: true }),
  tow: F('Casualty tow', 'harbour', null, false, 0, { legacy: true }),
  smuggling: F('Smuggling', 'cargo', 't', false, 0, { legacy: true }),
  box: F('Container shipment', 'containers', 'teu', true, 2),
  liner: F('Liner service loop', 'containers', 'teu', true, 4),
  voyage: F('Voyage charter', voyageGroup, null, true, 2),
  coa: F('Contract of affreightment', voyageGroup, null, true, 2),
  tc: F('Time charter', 'cargo', null, true, 2),
  project: F('Project cargo', 'cargo', 't', false, 4),
  vehicles: F('Vehicle shipment', 'cargo', 'ceu', true, 2),
  ropax_route: F('Ferry timetable', 'passengers', 'pax', true, 2),
  cruise: F('Cruise', 'passengers', 'pax', false, 4),
  anchor: F('Anchor handling', 'offshore', null, false, 4),
  standby: F('Standby (ERRV)', 'offshore', null, true, 2),
  crewchange: F('Crew change', 'offshore', 'pax', true, 2),
  towage: F('Harbour towage', 'harbour', null, false, 4),
  ocean_tow: F('Ocean tow', 'harbour', null, false, 4),
  salvage: F('Salvage', 'harbour', null, false, 4),
  pilot_transfer: F('Pilot transfer', 'harbour', null, false, 4),
  bunkering: F('Bunker delivery', 'tankers', 't', true, 2),
  launch: F('Launch service', 'harbour', 'pax', true, 2),
  dredge: F('Dredging', 'special', 'm3', true, 4),
  survey: F('Survey lines', 'special', null, true, 4),
  research: F('Science cruise', 'special', 'pax', false, 4),
  escort: F('Icebreaker escort', 'special', null, false, 4),
  lesson: F('Sailing lesson', 'yachts', 'pax', false, 2),
  daycharter: F('Day charter', 'yachts', 'pax', false, 2),
  bareboat: F('Bareboat charter', 'yachts', null, false, 4),
  regatta: F('Regatta', 'yachts', null, false, 4),
  ecotour: F('Eco-tour', 'yachts', 'pax', false, 4),
  guests: F('Superyacht guests', 'yachts', 'pax', false, 4),
  delivery: F('Delivery passage', 'yachts', 'pax', false, 4),
};
for (const [type, f] of Object.entries(FAMILIES)) {
  f.type = type;
  f.fit = FIT[type] || (() => null);
  f.needs = (job) => job?.needs || legacyNeeds(job);
  f.steps = (job) => job?.steps || null;
  f.hours = (job, cls) => stepHours(job, cls);
  f.pay = (job, env = {}) => payFor(job, env.cls ?? null);
}
export const RUNNER_TYPES = Object.keys(FAMILIES).filter((t) => !FAMILIES[t].legacy);
/** Families captains may run offline (H6d: shared/fleet.js CAPTAIN_JOB_TYPES after the hook). */
export const CAPTAIN_TYPES = Object.keys(FAMILIES).filter((t) => FAMILIES[t].captains);
export function groupOf(job) { const f = FAMILIES[job?.type]; if (!f) return 'cargo'; return typeof f.group === 'function' ? f.group(job) : f.group; }
/** Families this hull can do at all (fit guarantee, the spec sheet's "What work she does"). */
export function familiesFor(cls, { phase = 4, includeLegacy = true } = {}) {
  return Object.values(FAMILIES).filter((f) => (includeLegacy || !f.legacy) && (f.legacy || f.phase <= phase) && !f.fit(cls)).map((f) => f.type);
}

/** Needs of a legacy-family job (they carry no `needs`): the handling of their good, berths, category. */
export function legacyNeeds(job) {
  if (!job) return {};
  switch (job.type) {
    case 'passengers': return { handling: ['pax'], unit: 'pax', qty: job.pax || 0, paxCert: (job.pax || 0) > 12 };
    case 'charter': return { handling: ['pax'], unit: 'pax', qty: job.pax || 0, cats: job.needsCat || null, paxCert: (job.pax || 0) > 12 };
    case 'fishing': return { handling: ['fish'], unit: 't', qty: job.qty || 0, fish: true };
    case 'supply': return { handling: ['deck', 'breakbulk'], unit: 't', qty: job.qty || 0 };
    case 'tow': return {};
    default: {
      const g = CARGO[job.good];
      if (!g) return { unit: 't', qty: job.qty || 0 };
      // legacy freight is tonnes of a market good: the alternatives of its handling, checked in tonnes (plus TEU for boxes)
      const handling = [...new Set(g.opts.map((o) => o.h))];
      return { handling, unit: 't', qty: job.qty || 0, good: job.good };
    }
  }
}

// ------------------------------------------------------------------------------------------------ pay & hours
/** The pay of a runner job for ship `cls` (hire families depend on her base price; others are fixed at posting). */
export function payFor(job, cls = null) {
  if (!job) return { cr: 0, model: 'lump' };
  const info = payInfoOf(job);
  if (!info) return { cr: payOf(job), model: 'lump' };
  const p = { ...info };
  if (p.model === 'hire' && cls && p.rate) {
    p.perH = R(hireBasis(cls) * p.rate);
    p.cr = R(p.perH * (p.hireH || 0)) + (p.fixed || 0);
  }
  return p;
}
export function payCrFor(job, cls = null) { return payInfoOf(job) ? payFor(job, cls).cr : payOf(job); }

/** Ship-hours `cls` needs for a runner job: sailing legs at service speed (capped by the step's maxKn), work, drills, calls. */
export function stepHours(job, cls) {
  if (!job || !Array.isArray(job.steps)) return NaN;
  const load = job.cargo && unitsOf(cls).t > 0 ? Math.min(1, (job.cargo.t || 0) / unitsOf(cls).t) : 0;
  let h = 0;
  for (const s of job.steps) {
    switch (s.k) {
      case 'load': case 'discharge': case 'board': case 'land': h += PORT_H; break;
      case 'sail': case 'tow': case 'meet': case 'race': {
        const km = s.km ?? (s.nm ? s.nm * 1.852 : 0);
        let kn = serviceKnOf(cls, s.k === 'sail' ? load : 0);
        if (s.maxKn) kn = Math.min(kn, s.maxKn);
        if (s.minKn && kn < s.minKn) return Infinity;
        h += km > 0 ? km / (kn * 1.852) : 0;
        break;
      }
      case 'work': h += s.h || 0; break;
      case 'drill': h += s.estH ?? 0.1 * (s.count || 1); break;
      default: break;
    }
  }
  return h;
}
