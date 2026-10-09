// Shipyard screen — pure formatting and selection logic (docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §4.7, §9 test 8).
// No DOM, no three.js: test/shipviz-yardfmt.test.mjs runs it in node. yardui.js renders what these functions return.
import {
  MODELS, MODEL_IDS, YARDS, YARD_COUNTRIES, YARD, SCHEDULES, MILESTONE_AT, OPTIONS, parseVariant, variantId, defaultOpts,
  yardsFor, yardById, countryOf, instalments, milestoneTimes, financing, classRow, basePrice, optionAllowed, scheduleKey,
  isSpecialist, inspectFee, compactOrder, orderProgress, defaultLivery,
} from '../../shared/ships/index.js';

// ------------------------------------------------------------------------------------------------ numbers
const nf = (n) => Math.round(n).toLocaleString('en-US');
/** "6.07 M cr" (≥ 1 M, three significant digits), "497,000 cr" below. */
export function fmtCr(n) {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n), sign = n < 0 ? '−' : '';
  if (a >= 1e6) { const m = a / 1e6; return `${sign}${m >= 100 ? m.toFixed(0) : m >= 10 ? m.toFixed(1) : m.toFixed(2)} M cr`; }
  return `${sign}${nf(a)} cr`;
}
/** "95 h (4 d)"; under a day "18 h"; under an hour "40 min". */
export function fmtHours(h) {
  if (!Number.isFinite(h)) return '—';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  const r = Math.round(h);
  return r >= 24 ? `${r} h (${Math.round(r / 24)} d)` : `${r} h`;
}
/** time until a unix-seconds instant: "in 12 h", "in 3 d 4 h", "overdue 5 h" */
export function fmtDue(at, now) {
  const s = at - now, a = Math.abs(s), h = Math.floor(a / 3600), d = Math.floor(h / 24);
  const t = d >= 1 ? `${d} d ${h % 24} h` : h >= 1 ? `${h} h` : `${Math.max(1, Math.round(a / 60))} min`;
  return s >= 0 ? `in ${t}` : `overdue ${t}`;
}
export const fmtUsd = (m) => (Number.isFinite(m) ? `US$ ${m >= 100 ? Math.round(m) : m} M` : '—');
export const fmtM = (v, d = 1) => (Number.isFinite(v) ? `${v.toFixed(d)} m` : '—');
export const fmtT = (t) => (Number.isFinite(t) ? `${nf(t)} t` : '—');
/** regional-indicator flag emoji for an ISO country code ('XX' / unknown → white flag) */
export function flagOf(cc) {
  if (typeof cc !== 'string' || !/^[A-Z]{2}$/.test(cc) || cc === 'XX') return '🏳️';
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}
export function countryName(cc) { return YARD_COUNTRIES[cc]?.name || cc || 'unknown'; }
/** yard name without the group in brackets, shortened for cards */
export function yardShort(y) { const n = (typeof y === 'string' ? yardById(y)?.name : y?.name) || String(y); return n.replace(/\s*\([^)]*\)/g, '').replace(/, [^,]+$/, (m) => (n.length > 34 ? '' : m)); }

// ------------------------------------------------------------------------------------------------ catalogue views
export const TYPE_LABEL = {
  workboat: 'Workboats', tug: 'Tugs', pilot: 'Pilot boats', fishing: 'Fishing', offshore: 'Offshore', general: 'General cargo',
  container: 'Container ships', bulk: 'Bulk carriers', tanker: 'Tankers', gas: 'Gas carriers', roro: 'Ro-ro & car carriers',
  ferry: 'Ferries', cruise: 'Cruise ships', special: 'Special ships', motor_yacht: 'Motor yachts', sail_yacht: 'Sailing yachts',
};
export const TYPE_ORDER = Object.keys(TYPE_LABEL);
/** size buckets for the size filter (by LOA) */
export const SIZE_BUCKETS = [['xs', '< 30 m', 0, 30], ['s', '30–100 m', 30, 100], ['m', '100–200 m', 100, 200], ['l', '200–300 m', 200, 300], ['xl', '≥ 300 m', 300, 1e9]];
export function sizeBucket(m) { return SIZE_BUCKETS.find(([, , a, b]) => m.length >= a && m.length < b)?.[0] || 'xs'; }
/** capacity line for a card: "64,000 DWT · 5 holds", "14,000 TEU", "4,000 guests", "BP 70 t" */
export function sizeLine(m) {
  const u = m.units || {};
  if (u.teu) return `${nf(u.teu)} TEU${u.plugs ? ` · ${nf(u.plugs)} reefer` : ''}`;
  if (m.type === 'gas' && u.m3) return `${nf(u.m3)} m³`;
  if (u.ceu) return `${nf(u.ceu)} cars`;
  if (m.type === 'cruise' || (m.type === 'ferry' && m.pax >= 100)) return `${nf(m.pax)} ${m.type === 'cruise' ? 'guests' : 'passengers'}${u.lm ? ` · ${nf(u.lm)} lane m` : ''}`;
  if (m.bp) return `bollard pull ${m.bp} t`;
  if (['motor_yacht', 'sail_yacht'].includes(m.type)) return `${m.pax} guests · ${m.length} m`;
  if (m.dwt >= 1000) return `${nf(m.dwt)} DWT${u.holds ? ` · ${u.holds} holds` : ''}`;
  return m.capText || `${m.length} m`;
}
/** badges shown on a design card */
export function badgesOf(m, opts = {}) {
  const out = [];
  if (m.era === 'classic') out.push({ id: 'classic', text: 'Classic', tone: 'muted' });
  if (Object.values(YARDS).some((y) => y.cc === 'US' && y.builds.includes(m.builders[0]))) out.push({ id: 'jones', text: 'Jones Act possible', tone: 'blue', title: 'Built at a US yard, under the US flag and owned by a US company, she may trade between US ports (46 U.S.C. §55102).' });
  if (m.ice || opts.ice) out.push({ id: 'ice', text: `Ice ${String(m.ice || opts.ice).toUpperCase()}`, tone: 'cyan' });
  if (m.tags?.includes('geared')) out.push({ id: 'geared', text: 'Geared', tone: 'muted' });
  if (m.eq?.includes('dp2')) out.push({ id: 'dp2', text: 'DP2', tone: 'muted' });
  if (m.engine?.fuel === 'lng') out.push({ id: 'lng', text: 'LNG', tone: 'green' });
  return out;
}
const ECO_RANK = { A: 5, B: 4, C: 3, D: 2, E: 1 };
/**
 * One design card: the cheapest allowed yard and the fastest delivery among the allowed yards.
 * ctx: { harbor, yardCheck, money, jones (US yards only), cc (country filter) }
 */
export function designCard(id, ctx = {}) {
  const m = MODELS[id];
  if (!m) return null;
  let rows = yardsFor(id, { harbor: ctx.harbor, yardCheck: ctx.yardCheck, openOrders: ctx.openOrders || 0 });
  if (ctx.jones) rows = rows.filter((r) => r.cc === 'US');
  if (ctx.cc) rows = rows.filter((r) => r.cc === ctx.cc);
  const ok = rows.filter((r) => !r.blockedBy);
  const cheapest = ok[0] || null;
  const fastest = ok.reduce((b, r) => (!b || r.hours < b.hours ? r : b), null);
  const row = classRow(id);
  return {
    id, name: m.refName.split(' (')[0], short: m.short, type: m.type, size: sizeLine(m), sizeClass: m.size, era: m.era, L: m.length,
    from: cheapest ? cheapest.price : null, fromYard: cheapest?.yardId || null, fastestH: fastest ? fastest.hours : null, yards: ok.length, blocked: rows.length - ok.length,
    eco: row?.eco ?? m.stats.eco, badges: badgesOf(m), usdM: m.usdM, afford: cheapest ? (ctx.money ?? Infinity) >= Math.round(cheapest.price * firstFrac(cheapest.yardId, m)) : false,
  };
}
/** share of the price due at signing at a yard (schedule first instalment) */
export function firstFrac(yardId, m) { return (SCHEDULES[scheduleKey(yardId, m)] || SCHEDULES.std5)[0][1]; }
/**
 * Filter and sort the catalogue for the Newbuild list. f: { type, size, cc, maxPrice, afford, jones, maxH, eco, sort, q }
 * ctx as designCard. Returns cards.
 */
export function filterDesigns(f = {}, ctx = {}) {
  const out = [];
  for (const id of MODEL_IDS) {
    const m = MODELS[id];
    if (m.hidden) continue;
    if (f.type && f.type !== 'all' && m.type !== f.type) continue;
    if (f.size && f.size !== 'all' && sizeBucket(m) !== f.size) continue;
    if (f.q && !`${m.refName} ${m.short} ${m.size} ${id}`.toLowerCase().includes(String(f.q).toLowerCase())) continue;
    const c = designCard(id, { ...ctx, jones: !!f.jones, cc: f.cc && f.cc !== 'all' ? f.cc : null });
    if (!c || c.from == null) continue;
    if (Number.isFinite(f.maxPrice) && f.maxPrice > 0 && c.from > f.maxPrice) continue;
    if (f.afford && !c.afford) continue;
    if (Number.isFinite(f.maxH) && f.maxH > 0 && c.fastestH > f.maxH) continue;
    if (f.eco && f.eco !== 'all' && (ECO_RANK[c.eco] || 0) < (ECO_RANK[f.eco] || 0)) continue;
    out.push(c);
  }
  const by = { price: (a, b) => a.from - b.from, delivery: (a, b) => a.fastestH - b.fastestH, size: (a, b) => a.L - b.L, name: (a, b) => a.name.localeCompare(b.name),
    type: (a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || a.L - b.L };
  return out.sort(by[f.sort] || by.type);
}
/** the countries that build at least one design (for the country filter) */
export function builderCountries() {
  const set = new Set(Object.values(YARDS).map((y) => y.cc));
  return [...set].sort((a, b) => countryName(a).localeCompare(countryName(b)));
}

// ------------------------------------------------------------------------------------------------ the configurator
export const SCHEDULE_LABEL = { std5: '20 % at contract, steel cutting, keel laying, launch and delivery', tail: '10 % × 4, then 60 % at delivery', small: '30 % at contract, 70 % at delivery' };
export const SCHEDULE_SHORT = { std5: '5 × 20 %', tail: '4 × 10 % + 60 % at delivery', small: '30 % + 70 % at delivery' };
export const MILESTONE_LABEL = { contract: 'Contract', steel: 'Steel cutting', keel: 'Keel laying', launch: 'Launch', delivery: 'Delivery' };
/** the yard list of the configurator: rows with display strings and the reason a yard cannot take the order */
export function yardRows(variant, ctx = {}) {
  const pv = parseVariant(variant); if (!pv) return [];
  const m = MODELS[pv.model];
  let rows = yardsFor(variant, { harbor: ctx.harbor, yardCheck: ctx.yardCheck, openOrders: ctx.openOrders || 0 });
  if (ctx.jones) rows = rows.filter((r) => r.cc === 'US');
  const here = new Set(ctx.here || []);
  return rows.map((r) => {
    const y = yardById(r.yardId), c = countryOf(y);
    const fin = financing(r.yardId, r.price);
    return {
      ...r, flag: flagOf(r.cc), country: countryName(r.cc), short: yardShort(y), priceText: fmtCr(r.price), hoursText: fmtHours(r.hours), here: here.has(r.yardId),
      scheduleText: SCHEDULE_LABEL[r.schedule] || r.schedule, financeText: fin ? `${fin.name}: up to ${Math.round(fin.ltv * 100)} % over ${fin.years} y` : '',
      us: r.cc === 'US', star: r.specialist, kind: y?.kind, blockText: r.blockedBy ? (r.blockedBy.text || 'Not allowed for your company') : null, resale: c?.resale ?? 1,
    };
  }).sort((a, b) => (b.here - a.here) || a.price - b.price || a.hours - b.hours);
}
/** option groups for the configurator (Lane A opts shape: { engine, ice, gear, esd, rot, air, spec }) with the reason each
 *  token is greyed out at this yard. Groups the model cannot use at all are left out. */
export const OPTION_GROUPS = [
  ['engine', 'Engine and fuel', [['vlsfo', 'VLSFO / MGO'], ['scr', 'Scrubber'], ['lng', 'LNG dual-fuel'], ['meoh', 'Methanol dual-fuel'], ['hyb', 'Battery hybrid'], ['de', 'Diesel-electric']]],
  ['ice', 'Ice class', [[null, 'None'], ['i1c', '1C'], ['i1b', '1B'], ['i1a', '1A'], ['i1as', '1A Super'], ['pc6', 'PC 6'], ['pc4', 'PC 4']]],
  ['gear', 'Cargo gear', [['geared', 'Own cranes'], ['gearless', 'No cranes']]],
  ['esd', 'Energy-saving pack', [['esd', 'ESD pack (−5 % fuel)']]],
  ['rot', 'Rotor sails', [['rot', 'Flettner rotors (≈ −7 % fuel)']]],
  ['air', 'Air lubrication', [['air', 'Air lubrication (−5 % fuel)']]],
  ['spec', 'Finish', [['eco', 'Economy'], ['std', 'Standard'], ['prem', 'Premium']]],
];
export function optionGroups(modelId, opts, yardId) {
  const m = MODELS[modelId]; if (!m) return [];
  const d = defaultOpts(m), o = { ...d, ...(opts || {}) };
  const out = [];
  for (const [g, label, toks] of OPTION_GROUPS) {
    if (g === 'gear' && !d.gear) continue;
    const multi = ['esd', 'rot', 'air'].includes(g);
    const items = toks.map(([t, text]) => {
      const isDefault = t === d[g] || (g === 'spec' && t === 'std') || (g === 'ice' && t === null);
      const r = isDefault ? { ok: true } : OPTIONS[t] ? optionAllowed(m, t, yardId) : { ok: g === 'engine' && t === 'vlsfo' && d.engine === 'vlsfo', why: 'Not available on this design.' };
      if (g === 'engine' && t === 'vlsfo' && d.engine !== 'vlsfo' && !isDefault) { r.ok = false; r.why = 'This design has a different standard plant.'; }
      const on = multi ? !!o[g] : (o[g] ?? null) === t;
      return { token: t, text, ok: !!r.ok, why: r.ok ? null : r.why, on, price: OPTIONS[t]?.price ?? 1, burn: OPTIONS[t]?.burn ?? 1 };
    });
    // the model's own default engine first when it is not in the list (e.g. 'de' standard plants are listed anyway)
    const usable = items.filter((i) => i.ok);
    if (!multi && usable.length < 2 && g !== 'spec' && g !== 'engine') continue;
    if (multi && !usable.length) continue;
    out.push({ group: g, label, multi, items });
  }
  return out;
}
/** opts → variant id at a yard: options the yard (or the model) cannot build fall back to the default, each with its reason */
export function variantFor(modelId, opts, yardId = null) {
  const m = MODELS[modelId]; if (!m) return { variant: null, dropped: [], opts: null };
  const d = defaultOpts(m), clean = { ...d };
  const dropped = [];
  for (const g of ['engine', 'ice', 'gear', 'esd', 'rot', 'air', 'spec']) {
    const v = opts?.[g];
    if (v == null || v === false || v === d[g] || (g === 'spec' && v === 'std')) continue;
    const t = v === true ? g : v;
    const r = OPTIONS[t] ? optionAllowed(m, t, yardId) : { ok: false, why: 'Unknown option.' };
    if (r.ok) clean[g] = v; else dropped.push({ group: g, token: t, why: r.why });
  }
  const id = variantId(modelId, clean);
  return { variant: id && parseVariant(id) ? id : modelId, dropped, opts: clean };
}
/** the instalment table: [{ key, label, pct, cr, at, atText }] */
export function instalmentRows(price, yardId, modelId, createdAt = null, variant = modelId, openOrders = 0) {
  const m = MODELS[modelId]; if (!m || !(price > 0)) return [];
  const rows = instalments(price, yardId, m);
  const t = createdAt != null ? milestoneTimes(createdAt, variant, yardId, openOrders, 0, 'normal') : null;
  return rows.map((r) => ({ key: r.key, label: MILESTONE_LABEL[r.key] || r.key, pct: Math.round(r.frac * 100), cr: r.cr, crText: fmtCr(r.cr),
    at: r.key === 'contract' ? createdAt : t ? t[r.key] : null, atText: r.key === 'contract' ? 'at signing' : t ? fmtHours((t[r.key] - createdAt) / 3600) : '' }));
}
/** the order button summary: due now (after trade-in credit), total, delivery */
export function orderSummary(variant, yardId, { tradeIn = 0, openOrders = 0, slot = 'normal' } = {}) {
  const pv = parseVariant(variant); if (!pv) return null;
  const rows = yardsFor(variant, { openOrders });
  const r = rows.find((x) => x.yardId === yardId); if (!r) return null;
  const price = slot === 'resale' ? Math.round(r.price * YARD.RESALE_SLOT_PREMIUM / 1000) * 1000 : r.price;
  const first = instalments(price, yardId, MODELS[pv.model])[0].cr;
  const hours = slot === 'resale' ? r.hours - (yardById(yardId) ? (YARD_COUNTRIES[yardById(yardId).cc]?.backlogM ?? 0) * YARD.MONTH_H : 0) : r.hours;
  return { price, dueNow: Math.max(0, first - tradeIn), credit: Math.min(first, tradeIn), hours, priceText: fmtCr(price), dueText: fmtCr(Math.max(0, first - tradeIn)), hoursText: fmtHours(hours) };
}
/** colour presets for the livery picker (hull, boot, house, funnel, band) — generic, no real company colours */
export const LIVERY_PRESETS = [
  { id: 'classic', name: 'Classic', hull: 0x1d2b3a, boot: 0x8b1a1a, house: 0xf2f2f2, funnel: 0x222222, band: null },
  { id: 'red', name: 'Port red', hull: 0x8e1f1f, boot: 0x3a1010, house: 0xf2f2f2, funnel: 0x8e1f1f, band: 0xf2f2f2 },
  { id: 'blue', name: 'Ocean blue', hull: 0x1f4f8c, boot: 0x7a1b1b, house: 0xf4f4f0, funnel: 0x1f4f8c, band: 0xf2b134 },
  { id: 'green', name: 'Coast green', hull: 0x2f5d50, boot: 0x7a1b1b, house: 0xf0f0ea, funnel: 0x2f5d50, band: 0xf2f2f2 },
  { id: 'grey', name: 'Navy grey', hull: 0x5d6670, boot: 0x26292d, house: 0xdfe3e6, funnel: 0x26292d, band: null },
  { id: 'white', name: 'White', hull: 0xf2f2f0, boot: 0x1d2b3a, house: 0xf7f7f5, funnel: 0x1d2b3a, band: 0x2a6fb0 },
  { id: 'orange', name: 'Safety orange', hull: 0xe0601c, boot: 0x2a2a2a, house: 0xf2f2f2, funnel: 0xe0601c, band: null },
  { id: 'black', name: 'Black', hull: 0x16191d, boot: 0x8b1a1a, house: 0xf2f2f2, funnel: 0xc9a227, band: null },
];
export function liveryFrom(preset, mark = null, base = null) {
  const p = LIVERY_PRESETS.find((x) => x.id === preset) || null;
  const l = { ...(base || defaultLivery('coaster')), ...(p ? { hull: p.hull, boot: p.boot, house: p.house, funnel: p.funnel, band: p.band } : {}) };
  l.mark = mark && /^[A-Z]{1,2}$/.test(mark) ? mark : null;
  l.nameColor = l.hull > 0x999999 ? 0x1b1b1b : 0xffffff;
  return l;
}
export const hex6 = (v) => '#' + ((v ?? 0) >>> 0).toString(16).padStart(6, '0');
export const parseHex = (s) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(s || '')); return m ? parseInt(m[1], 16) : null; };

// ------------------------------------------------------------------------------------------------ spec sheet and compare
/** the spec sheet of a variant at a yard: [{ title, rows: [[label, value]] }] */
export function specSheet(variant, yardId = null) {
  const pv = parseVariant(variant); if (!pv) return [];
  const m = MODELS[pv.model], row = classRow(variant) || m;
  const u = m.units || {};
  const real = [['Length × beam × draught', `${m.length} × ${m.beam} × ${m.draft} m`], ['Depth / air draft', `${m.depth ?? '—'} m / ${row.airDraft ?? m.airDraft ?? '—'} m`],
    ['Deadweight / gross tonnage', `${nf(m.dwt)} t / ${nf(m.gt)} GT`], ['Capacity', m.capText || sizeLine(m)], ['Main engine', `${nf(m.kW)} kW · ${m.engine.label}`],
    ['Speed (service / max)', `${m.svcKn} / ${m.maxKn} kn`], ['Crew', `${m.crew.min}–${m.crew.opt}`], ['Reference newbuild price', fmtUsd(m.usdM) + ' (≈ 2024–25)']];
  const range = row.fuelCap && row.burn ? Math.round(row.fuelCap / (row.burn * 0.56) * m.svcKn) : null;
  const game = [['Game payload', fmtT(row.capacity)], ['Passengers', String(row.pax ?? 0)], ['Fuel use at full power', `${row.burn} t/h`], ['Fuel tanks', `${nf(row.fuelCap)} t${range ? ` · ≈ ${nf(range)} nm` : ''}`],
    ['Crew cost', `${nf(row.crewCost)} cr/h`], ['Turning', `${row.turnRate} °/s`], ['Wear', `× ${row.wearMul}`], ['CII-style rating (game)', String(row.eco ?? m.stats.eco)]];
  const carry = [['Handling', (m.handling || []).join(', ') || 'none (towing)'], ['Units', Object.entries(u).filter(([k]) => k !== 't').map(([k, v]) => `${nf(v)} ${k}`).join(' · ') || '—'], ['Equipment', (m.eq || []).join(', ') || '—']];
  const fits = [['Smallest port', m.minPort], ['Draught at the berth', `${m.draft} m`]];
  const out = [{ title: 'Real-world reference', rows: real }, { title: 'In the game', rows: game }, { title: 'What she carries', rows: carry }, { title: 'Where she fits', rows: fits }];
  if (yardId) { const y = yardById(yardId); out.push({ title: 'Built at', rows: [['Yard', y?.name || yardId], ['Country', `${flagOf(y?.cc)} ${countryName(y?.cc)}`], ['Specialist', isSpecialist(y, m) ? 'yes — 3 % off, 10 % faster' : 'no']] }); }
  return out;
}
/**
 * Compare up to 4 items. items: [{ key, title, variant, price, hours?, resale?, cond? }].
 * Returns { cols, rows: [{ label, values: [text], best: index | -1 }] } — best per row by the row's rule.
 */
export const COMPARE_RULES = [
  ['Price', (it) => it.price, 'low', (v) => fmtCr(v)],
  ['Delivery', (it) => it.hours, 'low', (v) => (v == null ? 'now' : fmtHours(v))],
  ['Length', (it) => MODELS[parseVariant(it.variant)?.model]?.length, null, (v) => `${v} m`],
  ['Draught', (it) => MODELS[parseVariant(it.variant)?.model]?.draft, 'low', (v) => `${v} m`],
  ['Payload', (it) => classRow(it.variant)?.capacity, 'high', (v) => fmtT(v)],
  ['Passengers', (it) => classRow(it.variant)?.pax, 'high', (v) => String(v ?? 0)],
  ['Max speed', (it) => classRow(it.variant)?.maxKn, 'high', (v) => `${v} kn`],
  ['Fuel use', (it) => classRow(it.variant)?.burn, 'low', (v) => `${v} t/h`],
  ['Crew cost', (it) => classRow(it.variant)?.crewCost, 'low', (v) => `${nf(v)} cr/h`],
  ['Eco rating', (it) => ECO_RANK[classRow(it.variant)?.eco] ?? null, 'high', (v) => ['', 'E', 'D', 'C', 'B', 'A'][v] || '—'],
  ['Condition', (it) => it.cond ?? 100, 'high', (v) => `${v} %`],
  ['Resale ×', (it) => it.resale ?? 1, 'high', (v) => `× ${v.toFixed(2)}`],
];
export function compareRows(items) {
  const list = (items || []).slice(0, 4);
  const rows = [];
  for (const [label, get, rule, fmt] of COMPARE_RULES) {
    const vals = list.map((it) => { const v = get(it); return Number.isFinite(v) ? v : null; });
    if (vals.every((v) => v == null)) continue;
    let best = -1;
    if (rule && list.length > 1) {
      const present = vals.filter((v) => v != null);
      const target = rule === 'low' ? Math.min(...present) : Math.max(...present);
      const winners = vals.map((v, i) => (v === target ? i : -1)).filter((i) => i >= 0);
      if (winners.length === 1) best = winners[0];
    }
    rows.push({ label, values: vals.map((v) => (v == null ? '—' : fmt(v))), raw: vals, best });
  }
  return { cols: list.map((it) => it.title), rows };
}

// ------------------------------------------------------------------------------------------------ orders, listings
/** the progress view of one order: bar fraction, milestone ticks, next instalment, labels */
export function orderView(o, now) {
  const c = o.progress != null && o.steelAt == null ? o : compactOrder(o, now);   // the wire sends the compact view (+ price, schedule)
  const pv = parseVariant(o.variant), m = pv ? MODELS[pv.model] : null;
  const span = o.steelAt == null ? 1 : (o.delayShown ? o.deliverAt : o.plannedDeliverAt) - o.steelAt;
  const ticks = ['steel', 'keel', 'launch', 'delivery'].map((k) => ({ key: k, label: MILESTONE_LABEL[k], at: MILESTONE_AT[k], paid: !!(o.schedule || []).find((s) => s.key === k)?.paidAt }));
  const next = c.next;
  const stateText = { ordered: 'Waiting for steel cutting', building: 'Under construction', launched: 'Launched — fitting out', ready: 'Ready for delivery', delivered: 'Delivered', cancelled: 'Cancelled', defaulted: 'Defaulted' }[o.state] || o.state;
  return {
    id: o.id, title: `${o.name || m?.short || o.model} · ${o.hull || ''}`.trim(), model: m?.refName.split(' (')[0] || o.model, yard: yardShort(o.yard), flag: flagOf(yardById(o.yard)?.cc),
    progress: c.progress, stage: o.state === 'ordered' ? 0.02 : Math.max(0.05, c.progress), ticks: span > 0 ? ticks : [], state: o.state, stateText,
    next: next ? { ...next, label: MILESTONE_LABEL[next.key], crText: fmtCr(next.cr), dueText: fmtDue(next.dueAt, now), overdue: next.dueAt < now } : null,
    deliverText: c.deliverAt ? fmtDue(c.deliverAt, now) : '', delayed: c.delayed, price: o.price, priceText: fmtCr(o.price),
    paid: (o.schedule || []).filter((s) => s.paidAt).reduce((a, s) => a + s.cr, 0), open: ['ordered', 'building', 'launched', 'ready'].includes(o.state),
  };
}
const INC_WORD = (k) => k.charAt(0).toUpperCase() + k.slice(1);
/** the history drawer of a second-hand listing: [{ year, kind, text }] oldest first */
export function listingHistory(l) {
  const h = l.hist || {}; const ev = [];
  const y = yardById(h.yard);
  ev.push({ year: h.built, kind: 'built', text: `Built by ${y ? y.name : 'an unknown yard'} ${flagOf(h.builtIn)} (${h.hull || 'hull no. unknown'}), class ${h.class || '—'}` });
  for (const f of h.flags || []) ev.push({ year: f.from, kind: 'flag', text: `${flagOf(f.cc)} ${countryName(f.cc)} flag${f.until ? ` until ${f.until}` : ' (current)'}` });
  for (const i of h.incidents || []) ev.push({ year: i.year, kind: 'incident', text: INC_WORD(i.kind) });
  if (h.lastDock) ev.push({ year: new Date(h.lastDock * 1000).getUTCFullYear(), kind: 'dock', text: 'Last dry-dock' });
  return ev.sort((a, b) => a.year - b.year || (a.kind === 'built' ? -1 : 1));
}
/** a second-hand card: condition range until inspected, PSC record, owners, fees */
export function listingCard(l, now = null) {
  const m = MODELS[l.model] || MODELS[parseVariant(l.cls)?.model];
  const exact = l.condExact ?? l.report?.cond ?? null;
  return {
    id: l.id, title: l.name || m?.refName, short: m?.short, variant: l.cls, age: l.age, built: l.built, builtIn: l.hist?.builtIn, flag: flagOf(l.hist?.builtIn),
    country: countryName(l.hist?.builtIn), cond: exact, condText: exact != null ? `${exact} %` : `${l.condLo}–${l.condHi} %`, inspected: exact != null,
    price: l.price, priceText: fmtCr(l.price), fee: inspectFee(l.price), feeText: fmtCr(inspectFee(l.price)), owners: l.hist?.owners ?? 1, cls: l.hist?.class,
    psc: l.hist?.psc ? `${l.hist.psc.inspections} inspections, ${l.hist.psc.detentions} detention${l.hist.psc.detentions === 1 ? '' : 's'}` : '—',
    flags: (l.hist?.flags || []).map((f) => f.cc), jones: l.hist?.builtIn === 'US' && !l.hist?.jonesLost, jonesLost: !!l.hist?.jonesLost,
    defect: l.report?.defect ? `${l.report.defect.part} ${l.report.defect.cond} %` : null, history: listingHistory(l), lastDockText: l.hist?.lastDock && now ? fmtDue(l.hist.lastDock, now).replace('overdue ', '') + ' ago' : null,
  };
}
/** politics / Jones badges of a yard row or listing for the UI */
export function politicsBadges({ cc, blockText = null, jones = false, jonesLost = false }) {
  const out = [];
  if (cc === 'US') out.push({ id: 'jones', tone: 'blue', text: 'US-built: Jones Act eligible under the US flag', short: 'Jones Act' });
  if (jonesLost) out.push({ id: 'jonesLost', tone: 'amber', text: 'Coastwise rights lost (foreign flag in her history)', short: 'Jones lost' });
  if (jones && cc !== 'US') out.push({ id: 'jones', tone: 'blue', text: 'Jones Act eligible', short: 'Jones Act' });
  if (blockText) out.push({ id: 'blocked', tone: 'red', text: blockText, short: 'Not allowed' });
  if (cc === 'CN') out.push({ id: 's301', tone: 'muted', text: 'US port fees on Chinese-built ships (Section 301) are suspended until Nov 2026', short: 'Sec. 301 (inactive)' });
  return out;
}
export function basePriceText(variant) { return fmtCr(basePrice(variant)); }
export const STOCK_PREMIUM = YARD.STOCK_PREMIUM;
export { orderProgress };
