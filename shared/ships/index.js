// Frozen interface of the ship catalogue, yards, prices, values and listings
// (docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §7.2). Pure and deterministic: the server, the client and the tests run the
// same code. Random draws use a seeded RNG keyed by (harbourId, slot, refresh index) or by the order id; never Math.random.
// No shared/constants.js import (constants imports ships/rows.js after H1).
import { MODELS, MODEL_IDS, LEGACY_ROWS, SAIL_IDS, TYPE_CAT } from './catalogue.js';
import { YARD, SCHEDULES, MILESTONE_AT, YARD_COUNTRIES, YARDS, YARD_IDS, LOCAL_DEFAULT, LOCAL_MODELS, localYard, BUILD_SHARE, CLASS_SOCIETIES, CLASS_BY_CC,
  HISTORY_FLAGS, JONES_TYPES, COMMERCIAL_LOAN } from './yards.js';
import { OPTIONS, variantId, parseVariant, defaultOpts, priceMul, specOf, modelAllows } from './options.js';
import { classRow, priceBasis } from './rows.js';

export { MODELS, MODEL_IDS, LEGACY_ROWS, SAIL_IDS, TYPE_CAT } from './catalogue.js';
export { YARDS, YARD_IDS, YARD_COUNTRIES, YARD, SCHEDULES, MILESTONE_AT, BUILD_SHARE, CLASS_SOCIETIES, CLASS_BY_CC, LOCAL_MODELS, localYard, COMMERCIAL_LOAN } from './yards.js';
export { OPTIONS, variantId, parseVariant, defaultOpts } from './options.js';
export { classRow, priceBasis } from './rows.js';

/** Set of gen keys whose generator passed its tests (Lanes B/C flip entries). Empty until phase 3. */
export const GA_READY = new Set();

const round1000 = (v) => Math.round(v / 1000) * 1000;
const r2 = (v) => Math.round(v * 100) / 100;
const clamp = (lo, hi, v) => Math.max(lo, Math.min(hi, v));
const yearOf = (unixS) => new Date(unixS * 1000).getUTCFullYear();
const nowS = () => Math.floor(Date.now() / 1000);

// ------------------------------------------------------------------------------------------------ harbours (injected)
// Local boatyards are named after their harbour and take its country; the server (server/harbors.js) or the client
// (welcome.world.harbors) registers the harbour list once. Without it local yards resolve to nothing.
let HARBOR_MAP = new Map();
export function registerHarbors(list) { HARBOR_MAP = new Map((list || []).filter((h) => h && h.id).map((h) => [h.id, h])); }
export function harborOf(id) { return typeof id === 'object' && id ? id : HARBOR_MAP.get(id) || null; }

// ------------------------------------------------------------------------------------------------ lookups
export function modelOf(cls) { const pv = parseVariant(cls); return pv ? MODELS[pv.model] : null; }
/** Legacy id for id-keyed fallback tables ('ulcv24k' → 'boxship'); unknown → 'coaster'. */
export function baseOf(cls) { return modelOf(cls)?.base || (LEGACY_ROWS[cls] ? cls : 'coaster'); }
export function typeOf(cls) { return modelOf(cls)?.type || null; }
export function genOf(cls) { return modelOf(cls)?.gen || null; }

/** A yard record (seed yard or 'local:<harbourId>'), or null. */
export function yardById(id) {
  if (typeof id !== 'string') return null;
  if (YARDS[id]) return YARDS[id];
  if (id.startsWith('local:')) return localYard(harborOf(id.slice(6)));
  return null;
}
export function countryOf(yard) { const y = typeof yard === 'string' ? yardById(yard) : yard; return y ? YARD_COUNTRIES[y.cc] || { ...LOCAL_DEFAULT, name: y.cc } : null; }

/** Can this yard build this model at all? → { ok, why? } */
export function yardBuilds(yard, m) {
  const y = typeof yard === 'string' ? yardById(yard) : yard;
  if (!y || !m) return { ok: false, why: 'Unknown yard or design.' };
  if (!(priceBasis(m) > 0)) return { ok: false, why: 'This design is not built new.' };
  if (y.kind === 'local') {
    if (m.length > YARD.LOCAL_MAX_LOA) return { ok: false, why: `Too long for this yard (${YARD.LOCAL_MAX_LOA} m).` };
    const yacht = m.builders[0] === 'yacht_s' && m.length <= YARD.LOCAL_YACHT_LOA;
    return LOCAL_MODELS.includes(m.id) || yacht ? { ok: true } : { ok: false, why: 'A local boatyard builds small workboats and yachts only.' };
  }
  if (!y.builds.includes(m.builders[0])) return { ok: false, why: 'This yard does not build this type.' };
  if (y.maxLoa && m.length > y.maxLoa) return { ok: false, why: `Too long for this yard (${y.maxLoa} m).` };
  return { ok: true };
}
export function isSpecialist(yard, m) { const y = typeof yard === 'string' ? yardById(yard) : yard; return !!(y && m && y.spec.includes(m.builders[0])); }

const YARD_OPT_TEXT = { lng: 'LNG dual-fuel engines', meoh: 'methanol engines', scr: 'scrubbers', hyb: 'battery-hybrid plants', de: 'diesel-electric plants', rot: 'rotor sails', air: 'air lubrication', pc: 'Polar Class hulls' };
/** { ok, why? } — the model rule (§2.5) and, with a yard, what the yard offers. */
export function optionAllowed(model, token, yardId = null) {
  const m = typeof model === 'string' ? modelOf(model) : model;
  const r = modelAllows(m, token);
  if (!r.ok || !yardId) return r;
  const y = yardById(yardId), need = OPTIONS[token].yard;
  if (!y) return { ok: false, why: 'Unknown yard.' };
  if (need && !y.opts.includes(need)) return { ok: false, why: `This yard does not build ${YARD_OPT_TEXT[need]}.` };
  return { ok: true };
}
/** Every check for ordering `variantId` at `yardId` (design, yard capability, every option). → { ok, why? } */
export function canOrderAt(variant, yardId) {
  const pv = parseVariant(variant); if (!pv) return { ok: false, why: 'Unknown design.' };
  const m = MODELS[pv.model], y = yardById(yardId);
  const b = yardBuilds(y, m); if (!b.ok) return b;
  for (const t of pv.tokens) { const r = optionAllowed(m, t, yardId); if (!r.ok) return r; }
  return { ok: true };
}

// ------------------------------------------------------------------------------------------------ price, time, payment (§4.2)
/** KR-reference price with option multipliers (never the yard's country index or discounts). */
export function basePrice(variant) {
  const pv = parseVariant(variant); if (!pv) return 0;
  const m = MODELS[pv.model], p = priceBasis(m);
  return pv.tokens.length ? round1000(p * priceMul(pv.tokens)) : p;
}
export function yardPrice(variant, yardId) {
  const pv = parseVariant(variant), y = yardById(yardId); if (!pv || !y) return null;
  const m = MODELS[pv.model];
  return round1000(priceBasis(m) * countryOf(y).costIdx * (isSpecialist(y, m) ? YARD.SPECIALIST_PRICE : 1) * priceMul(pv.tokens));
}
export function stockPrice(variant, yardId) { const p = yardPrice(variant, yardId); return p == null ? null : round1000(p * YARD.STOCK_PREMIUM); }
export function resaleSlotPrice(variant, yardId) { const p = yardPrice(variant, yardId); return p == null ? null : round1000(p * YARD.RESALE_SLOT_PREMIUM); }
export function productionMonths(model, yardId) {
  const m = typeof model === 'string' ? modelOf(model) : model, y = yardById(yardId);
  if (!m || !y) return null;
  return m.buildMonths * countryOf(y).speed * (isSpecialist(y, m) ? YARD.SPECIALIST_MONTHS : 1);
}
/** openOrders: a count of open orders at this yard, or a list of orders (open ones at this yard are counted). */
export function backlogMonths(yardId, openOrders = 0) {
  const y = yardById(yardId); if (!y) return null;
  const n = Array.isArray(openOrders) ? openOrders.filter((o) => o && o.yard === yardId && isOpen(o)).length : Math.max(0, Number(openOrders) || 0);
  return (y.backlogM ?? countryOf(y).backlogM) + YARD.ORDER_BACKLOG_M * n;
}
export function deliveryHours(variant, yardId, openOrders = 0, delayFrac = 0, slot = 'normal') {
  const pv = parseVariant(variant); if (!pv) return null;
  const prod = productionMonths(MODELS[pv.model], yardId); if (prod == null) return null;
  const backlog = slot === 'resale' ? 0 : backlogMonths(yardId, openOrders);
  return r2((backlog + prod * (1 + delayFrac)) * YARD.MONTH_H);
}
export function scheduleKey(yardId, model) {
  const y = yardById(yardId), m = typeof model === 'string' ? modelOf(model) : model;
  if (!y || !m) return 'small';
  return m.length < 30 || y.kind === 'local' ? 'small' : countryOf(y).pay;
}
/** [{ key, frac, cr }] summing exactly to price (the last instalment absorbs rounding). */
export function instalments(price, yardId, model) {
  const sched = SCHEDULES[scheduleKey(yardId, model)];
  const P = Math.round(Number(price) || 0);
  let sum = 0;
  return sched.map(([key, frac], i) => {
    const cr = i === sched.length - 1 ? P - sum : Math.round(P * frac);
    sum += cr;
    return { key, frac, cr };
  });
}
/** Milestone times (unix s): contract, then steel cut after the backlog, keel/launch/delivery through production. */
export function milestoneTimes(createdAt, variant, yardId, openOrders = 0, delayFrac = 0, slot = 'normal') {
  const pv = parseVariant(variant); if (!pv) return null;
  const prod = productionMonths(MODELS[pv.model], yardId);
  const backlog = slot === 'resale' ? 0 : backlogMonths(yardId, openOrders);
  const H = YARD.MONTH_H * 3600, steel = createdAt + Math.round(backlog * H);
  const at = (k) => steel + Math.round(MILESTONE_AT[k] * prod * (1 + delayFrac) * H);
  return { contract: createdAt, steel, keel: at('keel'), launch: at('launch'), delivery: at('delivery') };
}
/** Financing offer (§3.2, §4.3): ECA terms, Title XI for US yards, else commercial (Game rule). */
export function financing(yardId, price) {
  const c = countryOf(yardId); if (!c) return null;
  const f = c.eca || COMMERCIAL_LOAN;
  return { name: f.name, ltv: f.ltv, years: f.years, max: Math.floor((Number(price) || 0) * f.ltv), titleXI: !!f.usBuiltOnly };
}
/**
 * Every yard that can build the variant, sorted by price. ctx: { harbor (adds its local boatyard), openOrders,
 * yardCheck(cc, yard) → { ok, block?: { text } } (politics R3; absent → every yard allowed) }.
 * → [{ yardId, name, cc, price, hours, specialist, schedule, blockedBy? }]
 */
export function yardsFor(variant, ctx = {}) {
  const pv = parseVariant(variant); if (!pv) return [];
  const ids = [...YARD_IDS];
  const h = ctx.harbor ? harborOf(ctx.harbor) : null;
  if (h && localYard(h)) ids.push(`local:${h.id}`);
  const out = [];
  for (const id of ids) {
    if (!canOrderAt(variant, id).ok) continue;
    const y = yardById(id), m = MODELS[pv.model];
    const row = { yardId: id, name: y.name, cc: y.cc, harbor: y.harbor, price: yardPrice(variant, id), hours: deliveryHours(variant, id, ctx.openOrders || 0),
      specialist: isSpecialist(y, m), schedule: scheduleKey(id, m) };
    if (typeof ctx.yardCheck === 'function') {
      let r = null; try { r = ctx.yardCheck(y.cc, y); } catch { r = null; }
      if (r && r.ok === false) row.blockedBy = r.block || { text: 'Not allowed for your company' };
    }
    out.push(row);
  }
  return out.sort((a, b) => a.price - b.price || a.hours - b.hours || (a.yardId < b.yardId ? -1 : 1));
}

// ------------------------------------------------------------------------------------------------ orders (pure parts of §4.3)
export const OPEN_STATES = ['ordered', 'building', 'launched', 'ready'];
export function isOpen(o) { return !!o && OPEN_STATES.includes(o.state); }
/** Seeded string hash → mulberry32 RNG (same family as server/economy.js seededRnd). */
export function seededRnd(seed) {
  let h = 2166136261; const s = String(seed);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  let a = h >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Delay share of production months for an order id: 70 % on time, 20 % +10 %, 10 % +25 % (YARD.DELAY). */
export function delayRoll(orderId) {
  const r = seededRnd(`delay:${orderId}`)();
  let acc = 0;
  for (const [p, f] of YARD.DELAY) { acc += p; if (r < acc) return f; }
  return YARD.DELAY[YARD.DELAY.length - 1][1];
}
/** Liquidated damages for a delay (cr): 0.5 % of the price per month of delay. */
export function ldFor(price, prodMonths, delayFrac) { return Math.round(YARD.LD_PER_MONTH * price * prodMonths * delayFrac); }
/**
 * A new Order record (§4.6). o: { id, ownerId, variant, yard, createdAt, openOrders, slot, livery, name, registry, deliverTo,
 * hull, tradeIn, loanId, price? (default yardPrice / resaleSlotPrice) }.
 */
export function newOrder(o) {
  const pv = parseVariant(o.variant), m = MODELS[pv.model];
  const slot = o.slot === 'resale' ? 'resale' : 'normal';
  const price = o.price ?? (slot === 'resale' ? resaleSlotPrice(o.variant, o.yard) : yardPrice(o.variant, o.yard));
  const delayFrac = o.delayFrac ?? delayRoll(o.id);
  const planned = milestoneTimes(o.createdAt, o.variant, o.yard, o.openOrders || 0, 0, slot);
  const t = milestoneTimes(o.createdAt, o.variant, o.yard, o.openOrders || 0, delayFrac, slot);
  const prod = productionMonths(m, o.yard);
  const schedule = instalments(price, o.yard, m).map((x) => ({ ...x, dueAt: x.key === 'contract' ? o.createdAt : t[x.key], paidAt: null }));
  return {
    id: o.id, v: 1, ownerId: o.ownerId, model: m.id, variant: o.variant, yard: o.yard, opts: pv.opts, livery: o.livery || defaultLivery(o.variant),
    name: o.name || null, registry: o.registry || null, hull: o.hull || null, price, slot, schedule,
    createdAt: o.createdAt, steelAt: t.steel, keelAt: t.keel, launchAt: t.launch, deliverAt: t.delivery, plannedDeliverAt: planned.delivery,
    delayFrac, ldCr: ldFor(price, prod, delayFrac), delayShown: false, state: 'ordered', deliverTo: o.deliverTo === 'home' ? 'home' : 'yard',
    tradeIn: o.tradeIn || null, credit: o.tradeIn ? Math.round(o.tradeIn.cr) : 0, loanId: o.loanId || null, vesselId: null, warnedAt: 0, readyAt: 0, storagePaidTo: 0, endedAt: 0,
  };
}
/** Progress 0..1 of an order on the world clock (steel cut → delivery). */
export function orderProgress(o, now) {
  if (!o) return 0;
  if (o.state === 'ready' || o.state === 'delivered') return 1;
  const a = o.steelAt, b = o.delayShown ? o.deliverAt : o.plannedDeliverAt;
  return b > a ? clamp(0, 1, (now - a) / (b - a)) : 0;
}
/** The compact order view of `you.orders` (§7.3). */
export function compactOrder(o, now) {
  const next = (o.schedule || []).find((s) => !s.paidAt);
  return { id: o.id, model: o.model, variant: o.variant, yard: o.yard, hull: o.hull, name: o.name, state: o.state, progress: Math.round(orderProgress(o, now) * 1000) / 1000,
    next: next ? { key: next.key, cr: next.cr, dueAt: next.dueAt } : null, deliverAt: o.delayShown ? o.deliverAt : o.plannedDeliverAt, delayed: o.delayShown && o.delayFrac > 0 };
}

// ------------------------------------------------------------------------------------------------ value (§4.5)
export function ageMul(ageYears) { return Math.max(0.25, 1 - 0.03 * Math.max(0, ageYears)); }
export function resaleOf(builtIn) { return YARD_COUNTRIES[builtIn]?.resale ?? 1; }
/** Built in the US, never lost coastwise rights (46 U.S.C. §12132), never rebuilt abroad. */
export function jonesOk(vessel) {
  const builtIn = vessel?.hist?.builtIn ?? vessel?.builtIn;
  return builtIn === 'US' && !vessel?.hist?.jonesLost && !vessel?.hist?.rebuiltAbroad;
}
/** Flag hook: the moment the flag leaves the US, coastwise rights are lost for ever. Returns true when they were lost now. */
export function noteFlagChange(vessel, fromCc, toCc) {
  if (!vessel || fromCc !== 'US' || toCc === 'US') return false;
  if (!vessel.hist || typeof vessel.hist !== 'object') vessel.hist = healHist(vessel, null);
  if (vessel.hist.jonesLost) return false;
  vessel.hist.jonesLost = true;
  return true;
}
/** Age in whole years of a vessel's hull (hist.built), 0 when unknown. */
export function vesselAgeYears(vessel, now = nowS()) {
  const b = vessel?.hist?.built ?? vessel?.built;
  return Number.isFinite(b) ? Math.max(0, yearOf(now) - b) : 0;
}
/**
 * marketValue(vessel, harborCc) = round(basePrice × 0.55 × (0.3 + 0.7 × cond/100) × ageMul × resale(builtIn) × specResale × jonesMul).
 * Migrated ships (hist missing or estimated, builtIn 'XX') keep today's shipValue exactly. `now` (unix s) for the age.
 */
export function marketValue(vessel, harborCc = null, now = nowS()) {
  const cls = vessel?.ship?.cls ?? vessel?.cls;
  const pv = parseVariant(cls); if (!pv) return 0;
  const cond = Number.isFinite(vessel?.cond) ? vessel.cond : 100;
  const hist = vessel?.hist;
  const am = hist && !hist.estimated ? ageMul(vesselAgeYears(vessel, now)) : 1;
  const builtIn = hist?.builtIn ?? vessel?.builtIn ?? 'XX';
  const spec = specOf(pv.tokens)?.resale ?? 1;
  const jones = harborCc === 'US' && jonesOk(vessel) ? YARD.JONES_PREMIUM : 1;
  return Math.round(basePrice(cls) * 0.55 * (0.3 + 0.7 * (cond / 100)) * am * resaleOf(builtIn) * spec * jones);
}
/** Today's shipValue(cls, cond) through marketValue (H8b). The coaster stays 0 until wave 2 prices her (D12). */
export function shipValueCompat(cls, cond, liveRows = null) {
  const live = liveRows && Object.prototype.hasOwnProperty.call(liveRows, cls) ? liveRows[cls] : LEGACY_ROWS[cls];
  if (live && !(live.price > 0)) return 0;
  return marketValue({ ship: { cls }, cond }, null);
}
/** Second-hand asking price (§4.4): today's formula × age × build country. */
export function listingPrice(model, cond, age, builtIn, r) {
  const m = typeof model === 'string' ? modelOf(model) : model;
  const base = typeof model === 'string' ? basePrice(model) : priceBasis(m);
  return Math.round(base * (0.4 + 0.45 * (cond / 100)) * ageMul(age) * resaleOf(builtIn) * (0.9 + 0.2 * r));
}
export function inspectFee(price) { return Math.max(YARD.INSPECT_MIN, Math.round(YARD.INSPECT_FRAC * price)); }
export function repaintCost(cls) { return Math.max(YARD.REPAINT_MIN, Math.round(YARD.REPAINT_FRAC * basePrice(cls))); }
/** Storage at the yard while she waits (`ready`, fleet full): the shared/fleet.js rule on the model's displacement. */
export function yardStorageFeePerDay(cls) { const row = classRow(cls); return Math.max(25, Math.round(0.01 * (row?.displacement || 3200))); }

/** wave-2 stats row with options, finish and the building yard applied (§1.2). */
export function effStats(vessel) {
  const cls = vessel?.ship?.cls ?? vessel?.cls;
  const m = modelOf(cls), row = classRow(cls);
  if (!m || !row) return null;
  const rel = row.reliability + (vessel?.hist?.specialist ? YARD.SPECIALIST_REL : 0);
  return { ...m.stats, airDraft: row.airDraft, ice: row.ice, eco: row.eco, comfort: row.comfort, reliability: Math.round(rel * 1000) / 1000, wearMul: row.wearMul };
}

// ------------------------------------------------------------------------------------------------ liveries
const FUNNEL = { cruise: 0x1d3557, ferry: 0x1d4e89, tanker: 0x222222, gas: 0x222222, container: 0x16324f, bulk: 0x222222, offshore: 0xd9531e, tug: 0xb01e1e };
export function defaultLivery(cls) {
  const m = modelOf(cls), row = classRow(cls);
  const hull = row?.hullColor ?? 0x2d4a6b;
  const light = m && ['ferry', 'cruise', 'motor_yacht', 'sail_yacht'].includes(m.type);
  return { hull, boot: light ? hull : 0x8b1a1a, house: 0xf2f2f2, funnel: FUNNEL[m?.type] ?? 0x222222, band: null, mark: null, nameColor: hull > 0x999999 ? 0x1b1b1b : 0xffffff };
}
const COL = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffff;
/** Normalised livery or null. Mark: 1–2 capital letters or an icon id. */
export function validLivery(l) {
  if (!l || typeof l !== 'object') return null;
  for (const k of ['hull', 'boot', 'house', 'funnel', 'nameColor']) if (!COL(l[k])) return null;
  if (l.band != null && !COL(l.band)) return null;
  if (l.mark != null && !(typeof l.mark === 'string' && (/^[A-Z]{1,2}$/.test(l.mark) || /^icon:[a-z_]{2,16}$/.test(l.mark)))) return null;
  return { hull: l.hull, boot: l.boot, house: l.house, funnel: l.funnel, band: l.band ?? null, mark: l.mark ?? null, nameColor: l.nameColor };
}

// ------------------------------------------------------------------------------------------------ second-hand listings (§4.4, §3.7)
export const SIZE_LISTINGS = { mega: 8, major: 6, regional: 4, minor: 2 };
export const SIZE_MAX_LOA = { minor: 140, regional: 250, major: 366, mega: 400 };
const SIZE_PRICE_CAP = { minor: 1.5e6, regional: 8e6, major: 4e7, mega: Infinity };   // Game rule (today: minor < 1 M, non-mega < 5 M)
const PORT_RANK = { minor: 0, regional: 1, major: 2, mega: 3 };
/** Default harbour tags by size (§5.6) until Lane D's shared/jobs/ports.js provides tagsOf. */
export const DEFAULT_TAGS = {
  mega: ['container', 'products', 'roro', 'bulk_grain', 'heavy', 'cruise', 'marina', 'bunkers'],
  major: ['container', 'products', 'bulk_grain', 'roro', 'marina'],
  regional: ['products', 'bulk_grain', 'ferry', 'marina', 'fishing'],
  minor: ['fishing', 'marina', 'ferry'],
};
const TAG_TYPES = { container: { container: 2 }, products: { tanker: 2 }, oil: { tanker: 3 }, chem: { tanker: 1 }, bulk_grain: { bulk: 2 }, bulk_ore: { bulk: 3 }, bulk_coal: { bulk: 2 },
  roro: { roro: 1.5 }, cars: { roro: 2 }, heavy: { general: 1 }, cruise: { cruise: 1 }, marina: { motor_yacht: 2, sail_yacht: 2 }, bunkers: { tanker: 1 },
  ferry: { ferry: 2 }, fishing: { fishing: 3 }, offshore: { offshore: 3 }, windfarm: { workboat: 2, offshore: 1 }, lng: { gas: 2 }, lpg: { gas: 1.5 }, livestock: { general: 1 },
  dredge: { special: 1 }, ice: { special: 0.5 } };
const BASE_TYPE_W = { general: 2, tug: 1, pilot: 0.5, workboat: 0.5, bulk: 1, tanker: 1, container: 1, special: 0.2, gas: 0.3, roro: 0.3, ferry: 0.5, cruise: 0.1, offshore: 0.5, fishing: 0.5, motor_yacht: 0.7, sail_yacht: 0.7 };

function pickW(list, rnd) {
  const tot = list.reduce((s, x) => s + x.w, 0); if (!(tot > 0)) return list[0]?.v ?? null;
  let r = rnd() * tot;
  for (const x of list) { r -= x.w; if (r <= 0) return x.v; }
  return list[list.length - 1].v;
}
export function maxLoaFor(h) { return Number.isFinite(h?.maxLoa) ? h.maxLoa : SIZE_MAX_LOA[h?.size] ?? 140; }
/** Models a harbour's second-hand market lists, with weights from its tags. */
export function listingPool(h, tags = DEFAULT_TAGS[h?.size] || DEFAULT_TAGS.minor) {
  const tw = {};
  for (const t of tags) for (const [ty, w] of Object.entries(TAG_TYPES[t] || {})) tw[ty] = (tw[ty] || 0) + w;
  const out = [];
  for (const m of Object.values(MODELS)) {
    const p = priceBasis(m);
    if (!(p > 0) || m.hidden || m.length > maxLoaFor(h) || PORT_RANK[m.minPort] > PORT_RANK[h?.size ?? 'minor'] || p > (SIZE_PRICE_CAP[h?.size] ?? 1.5e6)) continue;
    out.push({ v: m.id, w: (BASE_TYPE_W[m.type] || 0.5) + (tw[m.type] || 0) });
  }
  return out;
}
function shareKey(m) { return m.id === 'lng174k' || m.id === 'lngbv7500' ? 'lng' : m.type; }
/** Build yard of a second-hand ship (§3.7), weighted by BUILD_SHARE among the seed yards that build the model. */
export function pickBuildYard(m, rnd, forceCc = null) {
  const yards = YARD_IDS.filter((id) => yardBuilds(YARDS[id], m).ok && (!forceCc || YARDS[id].cc === forceCc));
  if (!yards.length) return null;
  const share = BUILD_SHARE[shareKey(m)] || {};
  const named = new Set(Object.keys(share).filter((k) => k !== 'other'));
  const ccs = [...new Set(yards.map((id) => YARDS[id].cc))];
  const others = ccs.filter((c) => !named.has(c));
  const wcc = ccs.map((c) => ({ v: c, w: forceCc ? 1 : named.has(c) ? share[c] : (share.other || 0.02) / Math.max(1, others.length) }));
  const cc = pickW(wcc, rnd);
  const inCc = yards.filter((id) => YARDS[id].cc === cc);
  return pickW(inCc.map((id) => ({ v: id, w: YARDS[id].spec.includes(m.builders[0]) ? 2 : 1 })), rnd);
}
function jonesRelevant(m) {
  return JONES_TYPES.has(m.type) || (m.type === 'tanker' && m.dwt <= 55000) || (m.type === 'container' && (m.units.teu || 0) <= 3000);
}
const DEFECTS = ['Main-engine turbocharger', 'Steering gear pump', 'Ballast pump', 'Generator 2', 'Hatch cover seals', 'Bow thruster', 'Fuel purifier', 'Shaft seal'];
const INCIDENTS = ['grounding (minor)', 'berth contact', 'engine failure at sea', 'collision (minor)', 'heavy-weather damage', 'fire in the engine room (contained)'];

/**
 * One second-hand listing for `harbor` (a harbour record with id, size, country), deterministic in
 * (harbourId, slot, refreshIdx). opts: { simTime (unix s, for build years), tags (harbour tags), rnd (override) }.
 * Server-only fields: `cond`, `defect` (strip with publicListing).
 */
export function makeListing(harbor, slot, refreshIdx, rnd = null, opts = {}) {
  const h = harborOf(harbor);
  if (!h) return null;
  const R = rnd || seededRnd(`used:${h.id}:${slot}:${refreshIdx}`);
  const pool = listingPool(h, opts.tags);
  if (!pool.length) return null;
  const m = MODELS[pickW(pool, R)];
  const now = opts.simTime ?? nowS(), year = yearOf(now);
  const kind = R();                                   // 1 in 4 bargain, 1 in 8 nearly new
  let age = Math.floor(28 * Math.pow(R(), 1.4));
  if (kind >= 0.25 && kind < 0.375) age = Math.floor(R() * 4);
  let cond = Math.round(clamp(30, 100, 100 - 2.2 * age - 15 * R()));
  if (kind < 0.25) cond = Math.round(35 + 20 * R());
  // options on second-hand ships (Game rule): a scrubber on some big ships, a finish on some
  const tokens = [];
  if (age <= 8 && R() < 0.3 && modelAllows(m, 'scr').ok) tokens.push('scr');
  const fin = R(); if (fin < 0.1) tokens.push('eco'); else if (fin > 0.92) tokens.push('prem');
  const variant = tokens.length ? `${m.id}~${tokens.join('.')}` : m.id;
  // build country: US harbours list Jones-relevant types US-built with p 0.6 (§3.7)
  const usJones = h.country === 'US' && jonesRelevant(m) && R() < YARD.US_JONES_LISTING_P;
  const yardId = pickBuildYard(m, R, usJones ? 'US' : null) || pickBuildYard(m, R);
  const builtIn = yardId ? YARDS[yardId].cc : 'XX';
  const owners = 1 + Math.floor((age / 7) * R());
  const flags = [];
  const nFlags = Math.min(4, 1 + Math.floor(R() * Math.min(3, owners)));
  let from = year - age;
  for (let i = 0; i < nFlags; i++) {
    const cc = usJones ? 'US' : i === 0 && R() < 0.3 ? builtIn : pickW(HISTORY_FLAGS.map(([c, w]) => ({ v: c, w })), R);
    const until = i === nFlags - 1 ? null : Math.min(year, from + 1 + Math.floor(R() * Math.max(1, (year - from) / (nFlags - i))));
    if (!flags.length || flags[flags.length - 1].cc !== cc) flags.push({ cc, from, until });
    else flags[flags.length - 1].until = until;
    if (until == null) break;
    from = until;
  }
  flags[flags.length - 1].until = null;
  const insp = Math.min(9, Math.floor(R() * (2 + age / 3)));
  const det = Math.min(2, insp, Math.floor(R() * (age / 12 + (100 - cond) / 50)));
  const nInc = Math.min(2, Math.floor(R() * (age / 10 + 0.5)));
  const incidents = [];
  for (let i = 0; i < nInc; i++) incidents.push({ year: year - Math.floor(R() * Math.max(1, age)), kind: INCIDENTS[Math.floor(R() * INCIDENTS.length)] });
  const r = R();
  const price = listingPrice(variant, cond, age, builtIn, r);
  const a = Math.floor(R() * 21), condLo = Math.max(0, cond - a), condHi = Math.min(100, cond + (20 - a));
  const defect = R() < 1 / 6 ? { part: DEFECTS[Math.floor(R() * DEFECTS.length)], cond: Math.round(15 + 25 * R()) } : null;
  const cls = builtIn === 'RU' ? 'RS' : CLASS_BY_CC[builtIn] && R() < 0.5 ? CLASS_BY_CC[builtIn] : CLASS_SOCIETIES[Math.floor(R() * CLASS_SOCIETIES.length)];
  const hullNo = `HN ${1000 + Math.floor(R() * 9000)}`;
  const lastDockMo = Math.floor(R() * 31);
  return {
    id: `u${Math.floor(seededRnd(`id:${h.id}:${refreshIdx}:${slot}`)() * 2 ** 40).toString(36)}`, v: 2, harbor: h.id, slot, refreshIdx, model: m.id, cls: variant, name: m.name,
    age, built: year - age, cond, condLo, condHi, price, seller: null, defect,
    hist: {
      v: 1, built: year - age, builtAt: null, yard: yardId, builtIn, hull: hullNo, class: cls, owners, flags,
      lastDock: now - lastDockMo * 30 * 86400, nextSpecial: year + (5 - (age % 5)), psc: { inspections: insp, detentions: det }, incidents,
      runHours: Math.round(age * 6000 * R()), estimated: false, jonesLost: builtIn === 'US' && flags.some((f) => f.cc !== 'US'), rebuiltAbroad: false, warrantyTo: 0,
    },
  };
}
/** The listing as a player sees it: condition as a range until their inspection report is ready. */
export function publicListing(l, report = null) {
  const { cond, defect, inspections, ...pub } = l;
  return { ...pub, report: report || null, condExact: report ? report.cond : null };
}
/** Pre-purchase inspection report (§4.4). */
export function inspectionReport(l, now) {
  return { at: now, cond: l.cond, defect: l.defect ? { ...l.defect } : null, nextSpecial: l.hist.nextSpecial, lastDock: l.hist.lastDock, psc: { ...l.hist.psc } };
}

// ------------------------------------------------------------------------------------------------ migration (§8)
/** vessel.spec for a migrated ship: { v: 1, model, opts, livery }. */
export function healSpec(v) {
  const cls = v?.ship?.cls;
  if (v.spec && v.spec.v === 1 && MODELS[v.spec.model]) { if (!validLivery(v.spec.livery)) v.spec.livery = defaultLivery(cls); return v.spec; }
  const pv = parseVariant(cls);
  v.spec = { v: 1, model: pv ? pv.model : baseOf(cls), opts: pv ? pv.opts : {}, livery: defaultLivery(cls) };
  if (pv && !pv.tokens.length) v.spec.opts = {};
  return v.spec;
}
/** vessel.hist for a migrated ship: estimated → ageMul 1 and resale('XX') 1, so the value stays today's. */
export function healHist(v, simTime = null) {
  const h = v?.hist;
  if (h && typeof h === 'object' && h.v === 1) {
    if (!Array.isArray(h.incidents)) h.incidents = [];
    for (const k of ['jonesLost', 'rebuiltAbroad']) if (typeof h[k] !== 'boolean') h[k] = false;
    if (!Number.isFinite(h.warrantyTo)) h.warrantyTo = 0;
    return h;
  }
  const year = yearOf(simTime ?? nowS()), cond = Number.isFinite(v?.cond) ? v.cond : 100;
  return {
    v: 1, estimated: true, built: Number.isFinite(v?.built) ? v.built : year - Math.round((100 - cond) / 3.5), builtAt: null,
    builtIn: typeof v?.builtIn === 'string' ? v.builtIn : 'XX', yard: null, hull: null, class: null, owners: 1, lastDock: null, nextSpecial: null,
    incidents: [], runHours: 0, jonesLost: false, rebuiltAbroad: false, warrantyTo: 0,
  };
}
/** healVessel hook (H8): spec + hist; never changes ship.cls or any money field. */
export function healShipsVessel(v, simTime = null) {
  if (!v || typeof v !== 'object' || !v.ship) return v;
  healSpec(v);
  v.hist = healHist(v, simTime);
  return v;
}
/** healOffice hook (H8): office.orders = [] on old saves; drop malformed orders. */
export function healOrders(office) {
  if (!office || typeof office !== 'object') return office;
  office.orders = (Array.isArray(office.orders) ? office.orders : []).filter((o) => o && typeof o.id === 'string' && parseVariant(o.variant) && yardById(o.yard)
    && Array.isArray(o.schedule) && typeof o.state === 'string');
  return office;
}
/** Harbour state on load: legacy `used` lists are kept for old clients for one release; the new market regenerates at the first visit. */
export function healHarborYard(st) {
  if (!st || typeof st !== 'object') return st;
  if (!Array.isArray(st.yardUsed) || st.yardUsed.some((l) => !l || l.v !== 2)) { st.yardUsed = []; st.yardUsedIdx = -1; }
  st.usedAt = 0;
  return st;
}
export { TYPE_CAT as TYPE_CATEGORIES };
