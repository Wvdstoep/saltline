// World politics, client lane: pure formatters (docs/WORLD-POLITICS-CONTRACT.md §5, §6.1). Import-free and DOM-free so
// Node tests import it directly (test/politicsui-fmt.test.mjs). Every string here follows the neutral wording rules of
// §2.1: fixed templates, no adjectives about sides, crews always safe. Words on the banned list never appear.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const AMBER_STALE = 'may be out of date';
export const GAME_RULE = 'Game rule';

// ---------------------------------------------------------------------------------------------- numbers and dates
export const fmtN = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—');
export const fmtCr = (n) => `${fmtN(n)} cr`;
/** ISO date → '01 Oct 2026' ('' for none). */
export function fmtDate(iso) {
  if (!iso || typeof iso !== 'string') return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return '';
  return `${String(d).padStart(2, '0')} ${MONTHS[m - 1]} ${y}`;
}
export const isoOf = (unixS) => new Date(unixS * 1000).toISOString().slice(0, 10);
/** Unix seconds → '14:20 UTC' today, '09 Oct 14:20 UTC' another day. */
export function fmtWhen(unixS, nowS) {
  if (!Number.isFinite(unixS)) return '—';
  const d = new Date(unixS * 1000), hm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  if (Number.isFinite(nowS) && isoOf(nowS) === isoOf(unixS)) return `${hm} UTC`;
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${hm} UTC`;
}
/**
 * A fraction as a percentage for people: 0.012 → '1.2 %', 0.0005 → '0.05 %', 0.3 → '30 %', 0.00004 → '< 0.01 %'.
 * `{ pct: true }` when the number already is a percentage (apPct 1.0 → '1 %').
 */
export function fmtPct(x, { pct = false } = {}) {
  if (!Number.isFinite(x)) return '—';
  const p = pct ? x : x * 100;
  if (p === 0) return '0 %';
  if (Math.abs(p) < 0.01) return '< 0.01 %';
  const dp = Math.abs(p) < 0.1 ? 2 : Math.abs(p) < 10 ? 1 : 0;
  return `${parseFloat(p.toFixed(dp))} %`;
}
/** Hours for people: 0.4 → '24 min', 13.2 → '13 h', 50 → '2 d 2 h'. */
export function fmtHours(h) {
  if (!Number.isFinite(h)) return '—';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${Math.round(h)} h`;
  const d = Math.floor(h / 24), r = Math.round(h % 24);
  return r ? `${d} d ${r} h` : `${d} d`;
}
export const fmtKm = (km) => (!Number.isFinite(km) ? '—' : km >= 100 ? `${fmtN(km)} km` : `${parseFloat(km.toFixed(1))} km`);
export const fmtList = (xs) => (Array.isArray(xs) && xs.length ? xs.join(', ') : '—');

// ---------------------------------------------------------------------------------------------- sources and staleness (P1, P8)
/** Source short label: '{short or publisher} · {published date}' → 'JWC · 01 Oct 2026'. */
export function fmtSrc(s, asOf = null) {
  if (!s) return 'source';
  const name = s.short || s.publisher || s.id || 'source';
  const d = fmtDate(asOf || s.published);
  return d ? `${name} · ${d}` : name;
}
/** P8: past `reviewBy` (ISO) at world time `nowS` → stale. Records without reviewBy are never stale. */
export function isStaleRec(rec, nowS) { return !!(rec && rec.reviewBy && Number.isFinite(nowS) && rec.reviewBy < isoOf(nowS)); }
export function staleText(rec, nowS) { return isStaleRec(rec, nowS) || rec?.stale === true ? AMBER_STALE : ''; }

// ---------------------------------------------------------------------------------------------- port status (§2.1 templates)
const STATUS_TPL = { open: 'Open', restricted: 'Restricted — {reason}', closed: 'Closed to merchant shipping — {reason}' };
/** { value, reasons } → { value, tone, cls, mark, short, text }. The mark and the word carry the meaning (never colour alone). */
export function statusChip(st) {
  const value = ['open', 'restricted', 'closed'].includes(st?.value) ? st.value : 'open';
  const reason = (st?.reasons || []).join(', ');
  const text = value === 'open' ? 'Open' : STATUS_TPL[value].replace('{reason}', reason || 'see the notice');
  const tone = value === 'open' ? 'good' : value === 'restricted' ? 'warn' : 'bad';
  return { value, tone, cls: `polSt-${value}`, mark: value === 'open' ? '●' : value === 'restricted' ? '▲' : '✖', short: value === 'open' ? 'Open' : value === 'restricted' ? 'Restricted' : 'Closed', text };
}

// ---------------------------------------------------------------------------------------------- chart styles (§5.2)
export const TIER_ALPHA = { 1: 0.08, 2: 0.12, 3: 0.16, 4: 0.20 };
/** War-risk tier → fill/stroke colours (red-orange, alpha by tier). Unknown tiers use tier 1. */
export function tierColour(tier) {
  const t = TIER_ALPHA[tier] ? tier : 1, a = TIER_ALPHA[t];
  return { tier: t, alpha: a, fill: `rgba(255,96,64,${a.toFixed(2)})`, stroke: `rgba(255,120,80,${Math.min(1, 0.55 + a * 1.5).toFixed(2)})`, text: '#ffb199' };
}
export const AREA_STYLE = Object.freeze({
  war_risk: { layer: 'warrisk', stroke: '#ff7850', dash: [], label: 'Listed area', legend: 'War-risk listed area' },
  warlike: { layer: 'warrisk', stroke: '#ff9f43', dash: [6, 4], label: 'IBF warlike', legend: 'IBF warlike area' },
  eca: { layer: 'eca', stroke: '#4fd18b', dash: [8, 5], label: 'ECA', legend: 'Emission control area' },
  piracy: { layer: 'piracy', stroke: '#b892ff', dash: [2, 4], label: 'Piracy HRA', legend: 'Piracy high-risk area' },
  corridor: { layer: 'corridors', stroke: '#5ad6ff', dash: [], label: 'Corridor', legend: 'Corridor route' },
  warning: { layer: 'warnings', stroke: '#9fb3c4', dash: [3, 3], label: 'GNSS warning', legend: 'Navigational warning' },
});
export const CHART_LAYERS = Object.freeze([
  { id: 'warrisk', label: 'War risk', on: true, kinds: ['war_risk', 'warlike'] },
  { id: 'corridors', label: 'Corridors', on: true, kinds: ['corridor'] },
  { id: 'eca', label: 'ECA', on: false, kinds: ['eca'] },
  { id: 'piracy', label: 'Piracy', on: false, kinds: ['piracy'] },
  { id: 'warnings', label: 'Warnings', on: false, kinds: ['warning'] },
]);
export function layerOfKind(kind) { return AREA_STYLE[kind]?.layer || null; }
/** The short label drawn at an area's centroid. */
export function areaLabel(a) {
  if (!a) return '';
  if (a.kind === 'war_risk') return `Listed area · T${a.tier || 1}`;
  return AREA_STYLE[a.kind]?.label || a.kind;
}

// ---------------------------------------------------------------------------------------------- PSC, cabotage, policy, standing
export const PSC_PROFILE = { LRS: 'low risk', SRS: 'standard risk', HRS: 'high risk' };
export function pscProfileText(p) { return p ? `${p} (${PSC_PROFILE[p] || p})` : '—'; }
export function cabotageText(rule, extra = {}) {
  switch (rule) {
    case 'national': return `Domestic contracts here: ${extra.cc || 'national'}-flag ships only${extra.builtIn ? `, ${extra.builtIn}-built` : ''}${extra.ownerHome ? `, company based in ${extra.ownerHome}` : ''}`;
    case 'bloc': return `Domestic contracts here: ${extra.bloc || 'bloc'} member-state flags only`;
    case 'licence': return 'Domestic contracts here: own flag, or a coastal trading licence';
    case 'open': return 'Domestic contracts here: open to every flag';
    default: return 'Coastal trade rules not modelled (treated as open)';
  }
}
export const POLICIES = Object.freeze([
  { id: 'avoid', label: 'Avoid', blurb: 'Captains take no contract into a listed war-risk or piracy area, and no corridor or evacuation run.' },
  { id: 'cautious', label: 'Cautious', blurb: 'Tier 1–2 listed areas only; piracy areas with guards. Always buy war cover.' },
  { id: 'accept', label: 'Accept', blurb: 'Anything not blocked by measures or port rules. Captains request clearance and follow corridors.' },
]);
export function policyLabel(id) { return POLICIES.find((p) => p.id === id)?.label || 'Avoid'; }
export const REP_LEVELS = { charterMin: 20, trusted: 40, watched: -30, banned: -60 };
/** Standing → the effects reached (words, never colour alone). */
export function repEffects(n) {
  const out = [];
  if (n >= REP_LEVELS.trusted) out.push('trusted operator · customs fee waived');
  else if (n >= REP_LEVELS.charterMin) out.push('state charters');
  if (n <= REP_LEVELS.banned) out.push('refused entry');
  else if (n <= REP_LEVELS.watched) out.push('watched · more inspections');
  return out;
}
export function repTone(n) { return n <= REP_LEVELS.banned ? 'bad' : n <= REP_LEVELS.watched ? 'warn' : n >= REP_LEVELS.charterMin ? 'good' : 'neutral'; }
/** A −100…100 bar drawn from the centre: { left, width } in % of the track. */
export function repBar(n) {
  const v = Math.max(-100, Math.min(100, Number.isFinite(n) ? n : 0));
  return v >= 0 ? { left: 50, width: v / 2 } : { left: 50 + v / 2, width: -v / 2 };
}
/** Top and bottom `k` countries by standing (non-zero only), best first, then the lowest. */
export function repTopBottom(rep, k = 8) {
  const rows = Object.entries(rep || {}).filter(([, n]) => Number.isFinite(n) && n !== 0).sort((a, b) => b[1] - a[1]);
  const top = rows.filter(([, n]) => n > 0).slice(0, k), bottom = rows.filter(([, n]) => n < 0).slice(-k);
  return { top, bottom };
}

// ---------------------------------------------------------------------------------------------- reasons and badges (§5.1 board badges)
/** The short reason for a badge: the measure text without the template's lead-in. */
export function reasonShort(r) {
  if (!r) return '';
  if (r.measureText) return r.measureText;
  return String(r.text || '').replace(/^Not allowed for your company:\s*/, '').replace(/^.*? port control refuses entry:\s*/, '').replace(/\s*\([^)]*\)\.?$/, '');
}
export function reasonLine(r) { return r ? r.text || reasonShort(r) : ''; }
export const RISK_PAY = { 1: 0.10, 2: 0.40, 3: 1.20, 4: 2.00 };
export const DIPLO_TYPES = Object.freeze({
  aid: { label: 'Humanitarian aid', icon: 'lifebuoy', blurb: 'Cargo for a port where a dated appeal lists humanitarian needs.' },
  corridor: { label: 'Grain corridor', icon: 'grain', blurb: 'Grain from a corridor port. Needs clearance and the corridor route.' },
  state: { label: 'State charter', icon: 'flag', blurb: 'Cargo for a country whose port authorities know you well.' },
  avoid: { label: 'Avoid-route freight', icon: 'compass', blurb: 'Freight paid for the long way round a listed area.' },
  evac: { label: 'Assisted departure', icon: 'users', blurb: 'Civilian passengers out of a port where a dated source marks one.' },
});
/**
 * Contract badges (pure): job (with job.pol tags), the client-side jobCheck result (or null), and an area-name lookup.
 * → [{ cls, text, title }] in display order.
 */
export function jobBadges(job, check = null, areaName = (id) => id) {
  const out = [], pol = job?.pol || {};
  if (check && check.ok === false && check.block) out.push({ cls: 'bad', text: `Not for your company — ${reasonShort(check.block)}`, title: reasonLine(check.block) });
  if (pol.tier > 0) out.push({ cls: pol.tier >= 3 ? 'bad' : 'warn', text: `War risk T${pol.tier} · +${Math.round((RISK_PAY[pol.tier] || 0) * 100)} %`, title: 'Destination or route in a listed war-risk area; pay includes the risk premium.' });
  if (job?.type === 'corridor' || (check?.warn || []).some((w) => w.code === 'corridor')) out.push({ cls: 'info', text: 'Corridor', title: 'Corridor route and entry clearance required' });
  if (pol.refundPremium || (pol.tier > 0 && ['corridor', 'aid'].includes(job?.type))) out.push({ cls: 'good', text: 'Premium refunded', title: 'War premium refunded on delivery' });
  const cab = check?.tags?.cab || pol.cab;
  if (cab) out.push({ cls: 'ghost', text: `Cabotage: ${cab} only`, title: 'Domestic leg: coastal trade rules apply' });
  for (const id of pol.mustAvoid || []) out.push({ cls: 'warn', text: `Avoid ${areaName(id)}`, title: 'Entering this area halves the pay' });
  if (pol.needs?.rep && !(check && check.ok === false && check.block?.code === 'needs')) out.push({ cls: 'ghost', text: `Standing ≥ ${pol.needs.rep.min} with ${pol.needs.rep.cc}`, title: 'State charters need standing with the port authorities' });
  return out;
}

// ---------------------------------------------------------------------------------------------- quick tile (§5.1)
/** The overview quick tile: ['rules', icon, 'Rules', '{status} · {pscName}{ · ECA}{ · War risk x %}'] + a tone. */
export function quickTile(rules) {
  if (!rules) return { tab: 'rules', title: 'Rules', sub: 'port rules', tone: '' };
  const st = statusChip(rules.status), parts = [st.short];
  if (rules.psc?.name) parts.push(rules.psc.name);
  if ((rules.eca || []).some((e) => e.inForce)) parts.push('ECA');
  const war = (rules.security || [])[0];
  if (war) parts.push(`War risk ${fmtPct(war.apPct, { pct: true })}`);
  const refused = rules.entry && rules.entry.ok === false && rules.entry.refuse && rules.entry.refuse.code !== 'clearance';
  if (refused) parts.unshift('Refuses your ship');
  const tone = st.value === 'closed' || refused ? 'bad' : st.value === 'restricted' || war ? 'warn' : '';
  return { tab: 'rules', title: 'Rules', sub: parts.join(' · '), tone };
}

// ---------------------------------------------------------------------------------------------- risk check rows (§5.3)
/**
 * RiskReport (shared riskCheck) → ordered rows for the card: blockers first, then destination, areas, crew, ECA,
 * piracy, corridors, warnings, PSC. Pure: `o` gives names and the bits the report does not carry.
 * o: { toName, srcOf(rec) → 'JWC JWLA-034 · 09 Oct 2026', ecaCostCr, warlikeCrewCr, refunded, clearance: 'valid'|'pending'|'none'|null, pscName, nowS }
 */
export function riskRows(report, o = {}) {
  const rows = [];
  if (!report) return rows;
  for (const b of report.blockers || []) rows.push({ tone: 'block', mark: '✖', label: 'Blocker', text: reasonLine(b), src: o.srcOf ? o.srcOf(b) : '' });
  const d = report.dest;
  if (d) {
    const st = statusChip(d.status);
    let text = st.text;
    const needsClear = d.entry?.needs === 'clearance' || d.entry?.refuse?.code === 'clearance';
    if (needsClear || o.clearance) text += `, clearance: ${o.clearance === 'valid' ? 'valid' : o.clearance === 'pending' ? 'requested' : 'not requested'}`;
    if (d.entry?.needs === 'corridor') text += ', corridor route';
    rows.push({ tone: st.value === 'open' ? 'ok' : st.value === 'closed' ? 'block' : 'warn', mark: st.mark, label: `Destination${o.toName ? ` · ${o.toName}` : ''}`, text, action: needsClear && o.clearance !== 'valid' && o.clearance !== 'pending' ? 'clearance' : null, src: o.srcOf ? o.srcOf(d.status) : '' });
  }
  const war = (report.lines || []).filter((l) => l.kind === 'war_risk');
  for (const l of war) {
    const sea = l.pSea > 0 ? `incident ≈ ${fmtPct(l.pSea)} at sea` : 'incident chance under 0.01 % at sea';
    const port = d && d.pCall && d.harbor && l === war[war.length - 1] ? ` + ${fmtPct(d.pCall)} in port` : '';
    rows.push({ tone: l.tier >= 3 ? 'block-soft' : 'warn', mark: '●', label: `Listed area T${l.tier}`, text: `${l.name} · ${fmtKm(l.km)} · ${fmtHours(l.h)} · premium ${fmtCr(l.premium)}${o.refunded ? ' (refunded by shipper)' : ''} · ${sea}${port}`, src: o.srcOf ? o.srcOf(l) : '', game: true });
  }
  if (!war.length) rows.push({ tone: 'ok', mark: '●', label: 'Listed areas', text: 'none on this route' });
  const wl = (report.lines || []).filter((l) => l.kind === 'warlike');
  rows.push(wl.length ? { tone: 'warn', mark: '●', label: 'Crew', text: `IBF warlike area — crew pay ×2 for ~${fmtHours(wl.reduce((s, l) => s + (l.h || 0), 0))} (+${fmtCr(wl.reduce((s, l) => s + (l.crewExtra || 0), 0))})` } : { tone: 'ok', mark: '●', label: 'Crew', text: 'normal pay (no IBF warlike area)' });
  const eca = (report.lines || []).filter((l) => l.kind === 'eca' && l.inForce !== false);
  rows.push(eca.length ? { tone: 'info', mark: '●', label: 'ECA', text: `${eca.map((l) => `${l.name} ${fmtKm(l.km)}`).join(' · ')}${Number.isFinite(o.ecaCostCr) ? ` · fuel switch ≈ ${fmtCr(o.ecaCostCr)}` : ''}`, game: true } : { tone: 'ok', mark: '●', label: 'ECA', text: 'none on this route' });
  const pir = (report.lines || []).filter((l) => l.kind === 'piracy');
  rows.push(pir.length ? { tone: 'warn', mark: '●', label: 'Piracy', text: pir.map((l) => `${l.name} · ${fmtKm(l.km)} · incident ≈ ${fmtPct(l.p)}`).join(' · '), game: true, action: 'guards' } : { tone: 'ok', mark: '●', label: 'Piracy', text: 'none' });
  for (const l of (report.lines || []).filter((x) => x.kind === 'corridor')) rows.push({ tone: 'info', mark: '●', label: 'Corridor', text: `${l.name} · ${fmtKm(l.km)} on the route${o.corridorName ? ` — required to enter ${o.toName || 'the destination'}` : ''}`, ...(o.corridorName ? { action: 'showCorridor' } : {}) });
  if (o.corridorName && !(report.lines || []).some((x) => x.kind === 'corridor')) rows.push({ tone: 'warn', mark: '▲', label: 'Corridor', text: `${o.corridorName} — required to enter ${o.toName || 'the destination'}`, action: 'showCorridor' });
  for (const l of (report.lines || []).filter((x) => x.kind === 'warning')) rows.push({ tone: 'info', mark: '●', label: 'Warning', text: `${l.name}: GNSS interference reported — cross-check position by radar` });
  if (d?.psc) rows.push({ tone: 'info', mark: '●', label: `Port state control${o.toName ? ` at ${o.toName}` : ''}`, text: `${o.pscName || d.psc.regime} · your profile ${d.psc.profile || '—'} · inspection ${fmtPct(d.psc.pInspect)} · detention if inspected ${fmtPct(d.psc.pDetain)}`, game: true });
  if (!(report.blockers || []).length) rows.push({ tone: 'ok', mark: '✔', label: 'Blockers', text: 'none' });
  return rows;
}

// ---------------------------------------------------------------------------------------------- moving home (§4.14, §5.4)
/** HomeMovePlan (server homeMovePlan) → before/after rows. `names(cc)` → country name. */
export function moveRows(plan, names = (x) => x) {
  if (!plan || plan.allowed === undefined) return [];
  const row = (label, before, after) => ({ label, before, after, changed: before !== after });
  return [
    row('Measures followed', fmtList(plan.followsBefore), fmtList(plan.followsAfter)),
    row('Customs territory', plan.customsBefore || '—', plan.customsAfter || '—'),
    row('Coastal trade at home', plan.cabotage?.before || 'nodata', plan.cabotage?.after || 'nodata'),
    row('Home country', names(plan.homeBefore) || '—', names(plan.country) || '—'),
  ].filter((r) => r.before !== '—' || r.after !== '—');
}
export function moveCostLines(plan) {
  const c = plan?.costParts || {};
  return [
    { label: 'Office move', cr: c.move || 0, game: false },
    { label: 'Company formation', cr: c.formation || 0, game: true },
    { label: 'Compulsory re-flags', cr: c.reflag || 0, game: true },
  ];
}

// ---------------------------------------------------------------------------------------------- fuel estimate (for the ECA line)
/** Tonnes burned per hour at `speedKn` (shared/physics fuelBurnPerSimHour with no load, no wind, at `cond`). */
export function burnPerHour(C, speedKn, cond = 100) {
  if (!C || !(C.burn > 0)) return 0;
  const t = Math.max(0, Math.min(1, speedKn / (C.maxKn || speedKn || 1)));
  return C.burn * (0.1 + 0.9 * t ** 3) * (1 + 0.25 * (1 - cond / 100));
}
