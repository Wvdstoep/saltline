// World politics, client lane: HTML builders for the harbour "Rules" tab, the voyage risk check, the HQ "Compliance"
// panel, the move-home and re-flag cards and the new contract-type cards (docs/WORLD-POLITICS-CONTRACT.md §5).
// DOM-free (strings in, strings out) so Node tests render them from the real dataset (test/politicsui-render.test.mjs).
// The relative import of shared/ resolves to /shared/politics.js in the browser (public/ is the web root) and to
// ../../shared/politics.js under Node.
import { ic } from './icons.js';
import * as F from './politicsfmt.js';
import {
  POL, DISCLAIMER, TEMPLATES, fill, isActive, isStale, warPremium, apPctOf, pDayOf, ecaCost, guardsCost, matches, tradeCheck,
  registryOf, registryOwnerOk, reflagCost, hullBasis, vesselAge, srcShort,
} from '../../shared/politics.js';
import { SHIP_CLASSES, GOODS } from '../../shared/constants.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** A scale icon (the HQ tab and the Rules nav): icons.js has none; phase 2 may add it there as `scale`. */
export const SCALE_SVG = '<svg class="ic" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 3v18"/><path d="M7 21h10"/><path d="M5 7h14"/><path d="M5 7l-3 7a3 3 0 0 0 6 0z"/><path d="M19 7l-3 7a3 3 0 0 0 6 0z"/></svg>';
export const icon = (name) => (name === 'scale' ? SCALE_SVG : ic(name));
const goodName = (g) => GOODS[g]?.name || g;
const ccName = (ds, cc) => (cc && ds?.countries?.[cc]?.name) || cc || '—';
const viaName = (ds, id) => { const a = ds?.agreements?.find((x) => x.id === id); return a && a.name.length <= 24 ? a.name : String(id).toUpperCase(); };
const cuName = (ds, id) => (id ? ds?.agreements?.find((x) => x.id === id)?.name || ds?.countries?.[id]?.name || id : '—');
const KIND_WORD = { import_ban: 'Import ban', export_ban: 'Export ban', service_ban: 'Carriage ban', port_ban: 'Port entry ban', entry_lockout: 'Entry lockout', tariff_add: 'Extra duty', secondary: 'Exposure rule', arms_embargo: 'Arms embargo' };

// ---------------------------------------------------------------------------------------------- small parts
/** A source-tag function that remembers every id it linked, so the panel's source list holds each one (P1). */
function collector(ds, now) {
  const used = [];
  const S = (src, asOf, rec) => { for (const id of Array.isArray(src) ? src : src ? [src] : []) if (id && !used.includes(id)) used.push(id); return srcTag(ds, src, asOf, now, rec); };
  return { S, used };
}
/** Source list items: `listed` (payload rows) first, then every other id the panel linked, from the dataset. */
function sourcesList(ds, listed, used, now) {
  const rows = [...(listed || [])], have = new Set(rows.map((x) => x.id));
  for (const id of used) { const s = ds?.sources?.[id]; if (s && !have.has(id)) { have.add(id); rows.push({ id, title: s.title, publisher: s.publisher, published: s.published, url: s.url, stale: isStale(s, now) }); } }
  return `<ol class="polSources">${rows.map((s) => `<li id="polsrc-${esc(s.id)}"><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a><span class="muted"> — ${esc(s.publisher)}, ${esc(F.fmtDate(s.published))}</span>${s.stale ? ' <span class="polStale">▲ may be out of date</span>' : ''}</li>`).join('') || '<li class="muted">No sources used here.</li>'}</ol>`;
}
/** 'ⓘ JWC JWLA-034 · 29 Jul 2026' — links to the entry in the Sources card (P1). */
export function srcTag(ds, src, asOf = null, nowS = null, rec = null) {
  const ids = (Array.isArray(src) ? src : src ? [src] : []).filter(Boolean);
  if (!ids.length) return '';
  const s = ds?.sources?.[ids[0]];
  const label = s ? F.fmtSrc({ ...s, id: ids[0] }, asOf) : `${ids[0]}${asOf ? ` · ${F.fmtDate(asOf)}` : ''}`;
  const more = ids.length > 1 ? ` +${ids.length - 1}` : '';
  const title = s ? `${s.title} — ${s.publisher}, ${F.fmtDate(s.published)}` : ids[0];
  return `<a class="polSrc" href="#polsrc-${esc(ids[0])}" data-pol="src" data-src="${esc(ids[0])}" title="${esc(title)}">ⓘ ${esc(label)}${more}</a>${staleTag(rec, nowS)}`;
}
export function staleTag(rec, nowS) { const t = rec ? F.staleText(rec, nowS) : ''; return t ? `<span class="polStale" title="Past its review date: check the source">▲ ${esc(t)}</span>` : ''; }
export const gameTag = (why = 'A number tuned for play, not a sourced fact') => `<span class="polGame" title="${esc(why)}">${F.GAME_RULE}</span>`;
export function statusChipHTML(st) { const c = F.statusChip(st); return `<span class="chip polChip ${c.tone === 'good' ? 'good' : c.tone === 'warn' ? 'warn' : 'bad'} ${c.cls}"><b aria-hidden="true">${c.mark}</b>${esc(c.short)}</span>`; }
function line(mark, tone, html) { return `<li class="polLine ${tone}"><span class="polMark" aria-hidden="true">${mark}</span><span class="polTxt">${html}</span></li>`; }
function card(key, iconName, title, body, { open = true, tone = '', wide = false, sub = '' } = {}) {
  return `<details class="card polCard${tone ? ' ' + tone : ''}${wide ? ' polWide' : ''}" data-polcard="${key}"${open ? ' open' : ''}>
    <summary><h3>${icon(iconName)}${esc(title)}${sub ? `<small>${sub}</small>` : ''}</h3><span class="polChev" aria-hidden="true">${ic('chevronDown')}</span></summary>
    <div class="polBody">${body}</div></details>`;
}
function btn(act, label, { cls = '', dis = false, title = '', data = {} } = {}) {
  const d = Object.entries(data).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('');
  return `<button type="button" class="${cls}" data-pol="${act}"${d}${dis ? ' disabled' : ''}${title ? ` title="${esc(title)}"` : ''}>${label}</button>`;
}
const footer = (r) => `<p class="polFoot">${esc(DISCLAIMER)}${r?.version ? ` · dataset ${esc(r.version)} · valid as of ${esc(F.fmtDate(r.validAsOf))}` : ''}</p>`;

// ---------------------------------------------------------------------------------------------- client-side helpers
/** Personal export bans at this port (selling to this country), which harbor.rules does not list. */
export function sellBlocks(ds, ctx, harbor) {
  const out = [];
  for (const good of Object.keys(GOODS).filter((g) => !GOODS[g].contraband && g !== 'supplies')) {
    const r = tradeCheck(ds, ctx, { harbor, good, side: 'sell', origin: null });
    if (!r.ok) out.push({ side: 'sell', good, reason: r.block });
  }
  return out;
}
/** The measures that bind this company personally (home follows ∪ flag follows ∪ UN), grouped per instrument. */
export function applicableMeasures(ds, follows, nowS) {
  const f = new Set([...(follows || []), 'UN']), out = [];
  for (const r of ds.regimes || []) {
    if (!f.has(r.authority)) continue;
    const items = (r.measures || []).filter((m) => !['port_ban', 'entry_lockout', 'tariff_add'].includes(m.kind) && isActive({ from: m.from ?? r.from, until: m.until ?? r.until ?? undefined }, nowS) && (r.authority === 'UN' || (m.scope || 'personal').includes('personal') || m.kind === 'arms_embargo'));
    if (!items.length) continue;
    out.push({ id: r.id, authority: r.authority, title: r.title, target: r.target || null, src: r.src, asOf: r.asOf, reviewBy: r.reviewBy, items: items.map((m) => ({ kind: m.kind, text: `${KIND_WORD[m.kind] || m.kind}${m.goods ? `: ${m.goods.map(goodName).join(', ').toLowerCase()}` : ''}${m.origin ? ` of ${m.origin.join('/')} origin` : ''}${m.to ? ` to ${m.to.join('/')}` : ''}${m.art ? ` (${m.art})` : ''}` })) });
  }
  return out;
}
/** Port bans and lockouts in force that match this company or ship (applied by any authority: P3 symmetric view). */
export function portBansFor(ds, ctx, nowS) {
  const out = [];
  for (const m of ds.measures || []) {
    if (!(m.kind === 'port_ban' || m.kind === 'entry_lockout') || !isActive(m, nowS)) continue;
    if (m.when && matches(m.when, ctx)) out.push({ id: m.id, authority: m.authority, text: `${ds.authorities?.[m.authority]?.name || m.authority} ports refuse this ship${m.art ? ` (${m.regimeTitle}, ${m.art})` : ` (${m.regimeTitle})`}`, src: m.src, asOf: m.asOf });
  }
  return out;
}
/** Mirror of the server's reflagOptions (server/politics.js): registries open to a company based in `homeCc`. */
export function reflagOptions(ds, homeCc, vessel, nowS) {
  const ids = [...Object.keys(ds.registries || {}).filter((k) => k !== 'national'), `national:${homeCc}`];
  const age = vesselAge(vessel, nowS), cls = vessel?.cls || 'coaster', out = [];
  for (const id of ids) {
    const reg = registryOf(ds, id, homeCc); if (!reg) continue;
    const ownerOk = registryOwnerOk(ds, reg, homeCc), ageOk = !(reg.age?.maxYears != null && age > reg.age.maxYears);
    const survey = reg.age?.inspectOverYears != null && age > reg.age.inspectOverYears ? Math.round(hullBasis(cls) * 0.01) : 0;
    out.push({ id, name: reg.name, flag: reg.flag || homeCc, kind: reg.kind, ok: ownerOk && ageOk, ownerOk, ageOk, owner: reg.owner, cost: reflagCost(reg, cls) + survey, survey, hours: (reg.setupDays || 0) * POL.DAY_TO_H, crewCostMul: reg.crewCostMul ?? null, src: reg.src || [], asOf: reg.asOf || null });
  }
  return out.sort((a, b) => (b.ok - a.ok) || a.cost - b.cost || a.hours - b.hours || a.id.localeCompare(b.id));
}
const OWNER_WORD = { any: 'any owner', any_with_agent: 'any owner with a resident agent', home_in: 'company based in', home_in_bloc: 'company based in the bloc' };
function ownerText(ds, o) {
  if (!o) return OWNER_WORD.any;
  if (o.rule === 'home_in') return `${OWNER_WORD.home_in} ${(o.cc || []).join('/')}`;
  if (o.rule === 'home_in_bloc') return `company based in ${ds.agreements?.find((a) => a.id === o.bloc)?.name || o.bloc}`;
  return OWNER_WORD[o.rule] || o.rule;
}
/** Captain risk policy verdict for a set of areas on a route (mirror of riskPolicyRefusal, §4.16). */
export function policyVerdict(ds, policy, areaIds, jobType = null) {
  const list = (areaIds || []).map((id) => ds.areaById?.[id]).filter(Boolean);
  if (policy === 'avoid' || !policy) {
    if (['corridor', 'evac'].includes(jobType)) return "Your risk policy is 'avoid': no captain takes corridor or evacuation runs.";
    const a = list.find((x) => x.kind === 'war_risk' || x.kind === 'piracy');
    if (a) return `Your risk policy is 'avoid': no captain sails into ${a.name}.`;
  } else if (policy === 'cautious') {
    const a = list.find((x) => x.kind === 'war_risk' && x.tier >= 3);
    if (a) return `Your risk policy is 'cautious': no captain sails into ${a.name}.`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------- harbour "Rules" tab (§5.1)
/**
 * rules: HarbourRules (harbor.rules, §6.3). o: { ds, nowS, phone, harborName, company, ship: { cls, cond, name },
 * extraBlocked: [{ side, good, reason }], preview, clearancePending, money }
 */
export function rulesTabHTML(rules, o = {}) {
  const ds = o.ds, now = o.nowS, r = rules;
  if (!r) return `<div class="empty">${ic('hourglass')}<span>Port rules are loading…</span></div>`;
  const { S, used } = collector(ds, now);
  const po = ds?.ports?.[r.harbor] || {};
  const st = F.statusChip(r.status), open = !o.phone;
  const head = `<div class="secHead"><div><h2>${SCALE_SVG}Rules${o.harborName ? ` · ${esc(o.harborName)}` : ''}</h2><p>What applies at this port to your company and this ship, from public sources. Every line names its source and date.${o.preview ? ' <b>Preview computed in your browser.</b>' : ''}</p></div>
    <div class="tools">${statusChipHTML(r.status)}${(r.security || []).length ? `<span class="chip warn polChip"><b aria-hidden="true">▲</b>Listed area</span>` : ''}${(r.eca || []).some((e) => e.inForce) ? '<span class="chip good polChip">ECA</span>' : ''}</div></div>`;

  // 1 Port status
  let b1 = `<div class="polStatus ${st.cls}"><span class="polBig"><b aria-hidden="true">${st.mark}</b> ${esc(st.text)}</span>${S(r.status.src, r.status.asOf, po.status)}</div>`;
  if (po.status?.note) b1 += `<p class="polNote">${esc(po.status.note)}</p>`;
  const needsClear = !!po.entry?.clearance;
  if (needsClear) {
    const until = r.clearance, pend = o.clearancePending ?? r.clearancePending;
    b1 += `<ul class="polLines">${until ? line('✔', 'ok', `Entry clearance valid until ${esc(F.fmtWhen(until, now))}`) : pend ? line('…', 'info', `Clearance requested — issued at ${esc(F.fmtWhen(pend, now))}`) : line('▲', 'warn', `Entry clearance required (issued after ${POL.CLEARANCE_H} h, valid ${POL.CLEARANCE_VALID_H} h) ${gameTag('Clearance stands in for corridor registration; the hours are game-scaled')}`)}</ul>`;
    if (!until && !pend) b1 += `<div class="btnRow">${btn('clearance', `${ic('check')}Request clearance`, { cls: 'primary', data: { harbor: r.harbor } })}</div>`;
  }
  if (r.entry?.corridor) {
    const c = ds?.areaById?.[r.entry.corridor];
    b1 += `<ul class="polLines">${line('●', 'info', `Corridor route required: ${esc(c?.name || r.entry.corridor)} ${S(c?.src, c?.asOf, c)}`)}</ul><div class="btnRow">${btn('showCorridor', `${ic('chart')}Show on chart`, { data: { area: r.entry.corridor } })}</div>`;
  }
  if (r.conflict) {
    const names = (r.conflict.areaIds || []).map((id) => ds?.areaById?.[id]?.name || id).join('; ');
    b1 += `<p class="polNote"><b>Country context:</b> ${esc(fill(TEMPLATES.conflict, { areaName: names, srcShort: srcShort(ds || { sources: {} }, r.conflict.src), asOf: F.fmtDate(r.conflict.asOf) }))}${staleTag(r.conflict, now)}</p>`;
  }
  if (r.entry && !r.entry.ok && r.entry.refuse && r.entry.refuse.code !== 'clearance') b1 += `<ul class="polLines">${line('✖', 'bad', '<b>This port refuses your ship</b> — see For your company')}</ul>`;

  // 2 For your company
  const you = r.you || {};
  const blocked = [...(you.blocked || []), ...(o.extraBlocked || [])];
  let b2 = `<p class="polWho"><b>${esc(o.company || 'Your company')}</b> · home ${esc(ccName(ds, you.home))} · follows ${esc(F.fmtList(you.follows))} · ship flag ${esc(you.flag || '—')}</p>`;
  const refuseCode = r.entry?.refuse?.code;
  if (['designated', 'rep_ban', 'port_ban', 'lockout', 'denied'].includes(refuseCode)) b2 += `<div class="polBanner bad"><b>✖</b><span>${esc(r.entry.refuse.text)}</span></div>`;
  b2 += blocked.length
    ? `<ul class="polLines">${blocked.map((x) => line('✖', 'bad', `<b>${x.side === 'buy' ? 'Buy' : 'Sell'}: ${esc(goodName(x.good))}</b> — ${esc(F.reasonShort(x.reason))} ${S(x.reason?.src, x.reason?.asOf)}`)).join('')}</ul>`
    : `<ul class="polLines">${line('✔', 'ok', 'No goods measure here blocks your company.')}</ul>`;
  if ((you.seizable || []).length) b2 += `<p class="polSub bad">Cargo aboard that this port seizes on entry:</p><ul class="polLines">${you.seizable.map((x) => line('✖', 'bad', `<b>${esc(goodName(x.good))}</b> (origin ${esc(x.origin)}) — ${esc(F.reasonShort(x.reason))} ${S(x.reason?.src, x.reason?.asOf)}`)).join('')}</ul>`;

  // 3 Customs and duties
  const cu = r.customs || {}, cuName = ds?.agreements?.find((a) => a.id === cu.territory)?.name || cu.territory;
  let b3 = `<dl class="kv"><dt>Customs territory</dt><dd>${esc(cuName || '—')}</dd><dt>With your home</dt><dd>${cu.agreement ? 'same customs territory — no duty' : 'outside your customs territory'}</dd></dl>`;
  b3 += (cu.rows || []).length
    ? `<table class="polTable"><thead><tr><th>Good</th><th>Origin</th><th class="num">Rate</th><th class="num">Fee</th></tr></thead><tbody>${cu.rows.map((x) => `<tr><td>${esc(goodName(x.good))}</td><td>${esc(x.origin || 'unknown')}</td><td class="num">${x.via === 'none' && x.basis === 'none' ? '<span class="muted">not modelled</span>' : `${esc(F.fmtPct(x.rate))} ${esc(x.via === 'mfn' ? 'MFN' : x.via === 'none' ? '' : viaName(ds, x.via))}`}</td><td class="num">${esc(F.fmtCr(x.fee))}</td></tr>`).join('')}</tbody></table><p class="polNote">A rate shown as "not modelled" means the dataset has no duty for it yet, so none is charged.</p>`
    : '<p class="muted small">No free cargo aboard. Duties apply when you sell here.</p>';

  // 4 Port state control
  const p = r.psc;
  const b4 = p
    ? `<dl class="kv"><dt>Inspection MoU</dt><dd>${esc(p.name)} ${S(ds?.psc?.regimes?.[p.regime]?.src, ds?.psc?.regimes?.[p.regime]?.asOf)}</dd><dt>Your ship's profile</dt><dd>${esc(F.pscProfileText(p.profile))}</dd>
       <dt>Inspection chance now</dt><dd>${esc(F.fmtPct(p.pInspect))} ${gameTag()}</dd><dt>Detention if inspected</dt><dd>${esc(F.fmtPct(p.pDetain))} ${gameTag('Skewed by hull condition for play')}</dd>
       <dt>Last inspection</dt><dd>${p.last ? esc(F.fmtWhen(p.last, now)) : 'none recorded'}</dd></dl>
       ${(p.points || []).length ? `<details class="polMore"><summary>${p.points.reduce((s, x) => s + x.n, 0)} risk point${p.points.reduce((s, x) => s + x.n, 0) === 1 ? '' : 's'}</summary><ul class="polLines">${p.points.map((x) => line('+' + x.n, 'warn', esc(x.why))).join('')}</ul></details>` : '<p class="muted small">0 risk points.</p>'}`
    : '<p class="muted">No port state control MoU modelled for this port.</p>';

  // 5 Environment
  const b5 = (r.eca || []).length
    ? `<ul class="polLines">${r.eca.map((e) => line('●', e.inForce ? 'info' : 'muted', `<b>${esc(e.name)}</b> — ${e.inForce ? 'in force' : `from ${esc(F.fmtDate(e.from))}`}: sulphur ≤ ${esc(String(e.sulphurPct ?? 0.1))} %${e.nox ? ` · NOx Tier III applies to engines on ships built from ${esc(String(e.noxFrom || '2021'))}` : ''} ${S(ds?.areaById?.[e.id]?.src, ds?.areaById?.[e.id]?.asOf, ds?.areaById?.[e.id])}`)).join('')}</ul>
       <p class="polNote">Fuel switch inside: +${esc(F.fmtCr(e0(r.eca)))} per tonne burned (gas oil instead of residual fuel) ${gameTag()}</p>`
    : '<p class="muted">Not in an emission control area.</p>';

  // 6 Security
  let b6 = '';
  for (const a of r.security || []) {
    const area = ds?.areaById?.[a.id];
    b6 += `<div class="polArea"><div class="polAreaH"><span class="chip ${a.tier >= 3 ? 'bad' : 'warn'}">T${a.tier}</span><b>${esc(fill(TEMPLATES.areaChip, { areaName: a.name, srcShort: srcShort(ds || { sources: {} }, area?.src), asOf: F.fmtDate(area?.asOf) }))}</b>${staleTag(area, now)}</div>
      <dl class="kv"><dt>War-risk premium for this ship</dt><dd>${a.premium != null ? esc(F.fmtCr(a.premium)) : '—'} <span class="muted small">(${esc(F.fmtPct(a.apPct, { pct: true }))} of hull value per call)</span></dd>
      <dt>Incident chance at sea</dt><dd>≈ ${esc(F.fmtPct(a.pDay))} per day ${gameTag()}</dd>${a.pCall ? `<dt>Incident chance in port</dt><dd>${esc(F.fmtPct(a.pCall))} per call ${gameTag()}</dd>` : ''}
      <dt>Crew</dt><dd>${a.warlike ? 'IBF warlike area: crew pay ×2' : 'normal pay'}</dd></dl>
      <p class="polNote">Crews are always reported safe in this game. Shippers refund the premium on risk contracts.</p></div>`;
  }
  for (const a of r.piracy || []) {
    const area = ds?.areaById?.[a.id], cost = guardsCost(1);
    b6 += `<div class="polArea"><div class="polAreaH"><span class="chip violet">Piracy</span><b>${esc(a.name)}</b> ${S(area?.src, area?.asOf, area)}</div>
      <dl class="kv"><dt>Incident chance</dt><dd>≈ ${esc(F.fmtPct(a.p100))} per 100 km ${gameTag()}</dd><dt>Lower it</dt><dd>18 kn or faster ×0.3 · convoy ×0.5 · guards ×0.2</dd></dl>
      <div class="btnRow">${btn('guards', `${ic('lifebuoy')}Hire guards · ${esc(F.fmtCr(cost))}/day`, { data: { area: a.id }, dis: Number.isFinite(o.money) && o.money < cost })}</div></div>`;
  }
  if ((r.warnings || []).length) b6 += `<ul class="polLines">${r.warnings.map((w) => line('▲', 'warn', esc(w.text))).join('')}</ul>`;
  if (!b6) b6 = '<p class="muted">No listed war-risk, piracy or warning area at this port.</p>';

  // 7 Coastal trade
  const cb = ds?.countries?.[r.country]?.cabotage || r.cabotage || {};
  let b7 = `<p>${esc(F.cabotageText(r.cabotage?.rule, { cc: r.country, bloc: ds?.agreements?.find((a) => a.id === cb.bloc)?.name || cb.bloc, builtIn: cb.builtIn, ownerHome: (cb.ownerHome || []).join('/') }))} ${S(r.cabotage?.src, cb.asOf, cb)}</p>`;
  if (r.cabotage?.note || cb.note) b7 += `<p class="polNote">${esc(r.cabotage?.note || cb.note)}</p>`;
  if (r.cabotage?.rule === 'licence' && cb.licence) b7 += `<div class="btnRow">${btn('licence', `${ic('key')}Coastal trading licence · ${esc(F.fmtCr(cb.licence.feeCr))}`, { data: { cc: r.country } })}</div>`;

  // 8 Sources
  const b8 = `<dl class="kv"><dt>Dataset</dt><dd>${esc(r.version || '—')}</dd><dt>Valid as of</dt><dd>${esc(F.fmtDate(r.validAsOf))}${r.stale ? ' <span class="polStale">▲ may be out of date</span>' : ''}</dd></dl>
    ${sourcesList(ds, r.sources, used, now)}`;

  const tone = st.value === 'closed' ? 'polBad' : st.value === 'restricted' || (r.security || []).length ? 'polWarn' : '';
  return `${head}<div class="cards polCards">
    ${card('status', 'anchor', 'Port status', b1, { open: true, tone })}
    ${card('company', 'flag', 'For your company', b2, { open: true, tone: blocked.length || (you.seizable || []).length ? 'polWarn' : '' })}
    ${card('customs', 'coins', 'Customs and duties', b3, { open })}
    ${card('psc', 'eye', 'Port state control', b4, { open })}
    ${card('env', 'wind', 'Environment', b5, { open })}
    ${card('security', 'warning', 'Security', b6, { open, tone: (r.security || []).length ? 'polWarn' : '' })}
    ${card('cabotage', 'route', 'Coastal trade', b7, { open })}
    ${card('sources', 'list', 'Sources', b8, { open, wide: true })}
  </div>${footer(r)}`;
}
function e0(list) { return (list || []).find((x) => Number.isFinite(x.surchargePerT))?.surchargePerT ?? ecaCost(1); }

/** Banner chips next to the country chip (status + listed area). */
export function bannerChipsHTML(rules) {
  if (!rules) return '';
  return `${statusChipHTML(rules.status)}${(rules.security || []).length ? '<span class="chip warn polChip"><b aria-hidden="true">▲</b>Listed area</span>' : ''}`;
}

// ---------------------------------------------------------------------------------------------- risk check card (§5.3)
/**
 * report: RiskReport (shared riskCheck). o: { ds, nowS, title, toName, contract, refunded, clearance, policy,
 * policyText, ecaCostCr, coverAreas: [{ id, name, premium }], phone, canPlanAround }
 */
export function riskCheckHTML(report, o = {}) {
  const ds = o.ds;
  const srcOf = (rec) => (rec?.src?.length ? srcTag(ds, rec.src, rec.asOf, o.nowS, ds?.areaById?.[rec.id]) : '');
  const corrId = ds?.ports?.[report?.dest?.harbor]?.entry?.corridor || null;
  const rows = F.riskRows(report, { toName: o.toName, srcOf, corridorName: corrId ? ds.areaById?.[corrId]?.name || corrId : null, ecaCostCr: o.ecaCostCr, refunded: o.refunded, clearance: o.clearance, pscName: ds?.psc?.regimes?.[report?.dest?.psc?.regime]?.name });
  if (o.policy) {
    const pr = o.policyText ? { tone: 'warn', mark: '▲', label: 'Your captains', text: `${o.policyText}` } : { tone: 'ok', mark: '✔', label: 'Your captains', text: `risk policy '${F.policyLabel(o.policy).toLowerCase()}' allows this voyage` };
    const last = rows[rows.length - 1];
    if (last && last.label === 'Blockers') rows.splice(rows.length - 1, 0, pr); else rows.push(pr);
  }
  const blocked = (report?.blockers || []).length > 0;
  const hasAreas = (report?.lines || []).some((l) => l.kind === 'war_risk' || l.kind === 'piracy');
  const cover = (o.coverAreas || []).reduce((s, a) => s + (a.premium || 0), 0);
  const li = rows.map((r) => `<li class="polRow ${r.tone}"><span class="polMark" aria-hidden="true">${r.mark}</span><div><b>${esc(r.label)}:</b> <span>${esc(r.text)}</span>${r.game ? ` ${gameTag()}` : ''}${r.src ? ` ${r.src}` : ''}${r.action === 'clearance' ? ` ${btn('clearance', 'Request clearance', { cls: 'small', data: { harbor: report.dest?.harbor || '' } })}` : ''}${r.action === 'showCorridor' && corrId ? ` ${btn('showCorridor', 'Show on chart', { cls: 'small', data: { area: corrId } })}` : ''}</div></li>`).join('');
  return `<section class="polRisk${o.phone ? ' polPhone' : ''}" role="dialog" aria-label="Voyage risk check">
    <header class="polRiskH"><div><h3>${ic('radar')}Voyage risk check${o.title ? ` — ${esc(o.title)}` : ''}</h3><small class="muted">dataset ${esc(report?.version || '—')} · valid as of ${esc(F.fmtDate(report?.validAsOf))}</small></div>${btn('closeRisk', ic('close'), { cls: 'iconBtn ghost', title: 'Close' })}</header>
    <ul class="polRows">${li}</ul>
    <p class="polFoot">${esc(DISCLAIMER)}</p>
    <footer class="polRiskF">${btn('planAround', `${ic('route')}Plan around listed areas`, { dis: !hasAreas, title: hasAreas ? 'Re-plan with the listed areas as areas to avoid' : 'No listed area on this route' })}${cover > 0 ? btn('cover', `${ic('lifebuoy')}Buy war cover now · ${esc(F.fmtCr(cover))}`, { data: { areas: (o.coverAreas || []).map((a) => a.id).join(',') } }) : ''}${btn('go', `${ic('play')}Go`, { cls: 'primary', dis: !!(o.contract && blocked), title: o.contract && blocked ? 'A blocker stops this contract' : blocked ? 'The destination port will refuse entry' : '' })}</footer>
  </section>`;
}

// ---------------------------------------------------------------------------------------------- HQ "Compliance" panel (§5.4)
/**
 * view: fleet.compliance (officeView). o: { ds, nowS, ctx (makeCtx result), home: { id, name, cc }, docked: { id, name } | null,
 * ships: { [vid]: { cls, cond, name } }, phone, pendingName }
 */
export function complianceHTML(view, o = {}) {
  const ds = o.ds, now = o.nowS, ctx = o.ctx;
  if (!view || !ds) return `<div class="empty">${ic('hourglass')}<span>Loading the compliance view…</span></div>`;
  const home = o.home || {}, cc = home.cc || ctx?.home;
  const follows = ctx ? [...(ctx.homeFollows || ctx.follows || [])] : ds.countries[cc]?.follows || ['UN'];
  const country = ds.countries[cc] || {};
  const cuName = ds.agreements?.find((a) => a.id === country.customs)?.name || country.customs || cc;
  const cb = country.cabotage || {};
  const { S, used } = collector(ds, now);

  // 1 Jurisdiction
  let j = `<dl class="kv"><dt>Home harbour</dt><dd>${esc(home.name || '—')}</dd><dt>Country</dt><dd>${esc(ccName(ds, cc))}</dd>
    <dt>Measures followed</dt><dd>${esc(F.fmtList(follows))}</dd><dt>Customs territory</dt><dd>${esc(cuName)}</dd>
    <dt>Coastal trade at home</dt><dd>${esc(cb.rule || 'nodata')}</dd><dt>PSC at home</dt><dd>${esc(ds.psc?.regimes?.[country.psc]?.name || 'none modelled')}</dd></dl>`;
  if (country.conflict) j += `<p class="polNote">${esc(fill(TEMPLATES.conflict, { areaName: (country.conflict.areaIds || []).map((id) => ds.areaById?.[id]?.name || id).join('; '), srcShort: srcShort(ds, country.conflict.src), asOf: F.fmtDate(country.conflict.asOf) }))}</p>`;
  if (view.pending) {
    const ph = ds.harbors?.[view.pending.harbor];
    j += `<div class="polBanner info">${ic('hourglass')}<span>Company registration in ${esc(ccName(ds, ph?.country))} (${esc(o.pendingName || ph?.name || view.pending.harbor)}): ready ${esc(F.fmtWhen(view.pending.readyAt, now))}. The old jurisdiction applies until then.</span>${btn('homeCancel', 'Cancel move', { cls: 'small ghost', title: `Refunds 50 % of the formation fee (${F.fmtCr(POL.FORMATION_FEE / 2)})` })}</div>`;
  } else if (o.docked && o.docked.id !== home.id) j += `<div class="btnRow">${btn('homePlan', `${ic('anchor')}Move home to ${esc(o.docked.name)}…`, { cls: 'primary', data: { harbor: o.docked.id } })}</div>`;
  else j += '<p class="muted small">Moor in another port to plan a move of your home there.</p>';

  const regs = applicableMeasures(ds, ctx ? [...ctx.follows] : follows, now);
  const bans = ctx ? portBansFor(ds, ctx, now) : [];
  let m = regs.length ? `<ul class="polRegs">${regs.map((r) => `<li><div><b>${esc(r.authority)}</b> · ${esc(r.title)}${r.target ? ` <span class="muted">(${esc(r.target)})</span>` : ''} ${S(r.src, r.asOf, r)}</div><ul>${r.items.map((x) => `<li>${esc(x.text)}</li>`).join('')}</ul></li>`).join('')}</ul>` : '<p class="muted">No goods measures bind your company.</p>';
  if (bans.length) m += `<p class="polSub bad">Ports that refuse your current ship:</p><ul class="polLines">${bans.map((b) => line('✖', 'bad', `${esc(b.text)} ${S(b.src, b.asOf)}`)).join('')}</ul>`;

  // 2 Fleet flags
  const ships = view.flags || [];
  const f = ships.length ? `<div class="polFlags">${ships.map((v) => {
    const meta = o.ships?.[v.id] || {}, reg = v.flag ? registryOf(ds, v.flag.registry, cc) : null;
    const age = Number.isFinite(v.built) ? new Date(now * 1000).getUTCFullYear() - v.built : null;
    const re = v.reflag ? `<span class="chip warn">re-flag to ${esc(registryOf(ds, v.reflag.registry, cc)?.name || v.reflag.registry)} · ready ${esc(F.fmtWhen(v.reflag.readyAt, now))}</span>` : '';
    const held = v.held ? `<span class="chip bad">held · ${esc(v.held.why === 'psc' ? 'port state control' : 'detained')}</span>` : '';
    return `<div class="polFlag"><div class="polFlagCc" aria-hidden="true">${esc(v.flag?.cc || '—')}</div><div class="polFlagTxt"><b>${esc(v.name || meta.name || 'Ship')}</b>
      <small>${esc(ccName(ds, v.flag?.cc))} · ${esc(reg?.kind === 'national' ? 'national register' : reg?.name || v.flag?.registry || '—')} · built ${esc(String(v.built ?? '—'))}${age != null ? ` (${age} y)` : ''}${v.builtIn && v.builtIn !== 'XX' ? ` in ${esc(v.builtIn)}` : ''}</small>${re}${held}</div>
      ${btn('reflagOpen', 'Re-flag…', { cls: 'small', data: { vid: v.id || '' }, dis: !!v.reflag || !!v.held })}</div>`;
  }).join('')}</div>` : '<p class="muted">No ships.</p>';

  // 3 Risk policy
  const pol = `<div class="polSeg" role="radiogroup" aria-label="Captains' risk policy">${F.POLICIES.map((p) => btn('policy', `<b>${esc(p.label)}</b><small>${esc(p.blurb)}</small>`, { cls: `polSegBtn${view.riskPolicy === p.id ? ' on' : ''}`, data: { policy: p.id } })).join('')}</div>
    <p class="polSub">War cover at a listed-area boundary</p><div class="polSeg two">${btn('warCover', '<b>Auto</b><small>charged with an event line</small>', { cls: `polSegBtn${view.warCover !== 'ask' ? ' on' : ''}`, data: { mode: 'auto' } })}${btn('warCover', '<b>Ask</b><small>a card asks first (captains always buy)</small>', { cls: `polSegBtn${view.warCover === 'ask' ? ' on' : ''}`, data: { mode: 'ask' } })}</div>`;

  // 4 Standing
  const { top, bottom } = F.repTopBottom(view.rep, 8);
  const bar = ([k, n]) => { const b = F.repBar(n), fx = F.repEffects(n); return `<div class="polRep ${F.repTone(n)}"><span class="polRepC">${esc(ccName(ds, k))}</span><span class="polRepT" role="img" aria-label="${esc(`${n} of 100`)}"><i style="left:${b.left}%;width:${b.width}%"></i></span><b class="num">${n > 0 ? '+' : ''}${n}</b>${fx.length ? `<small>${esc(fx.join(' · '))}</small>` : ''}</div>`; };
  const rep = top.length || bottom.length ? `<p class="polNote">Standing with port authorities grows with clean deliveries and humanitarian work, and drops with detentions and seizures.</p>${top.map(bar).join('')}${bottom.length ? `<div class="polRepSep"></div>${bottom.map(bar).join('')}` : ''}` : '<p class="muted">Standing with every country\'s port authorities is neutral (0). Clean deliveries raise it.</p>';

  // 5 Records
  const recs = (view.records || []).slice(-20).reverse();
  const lock = (view.lockouts || []).filter((l) => l.until > now);
  const des = Object.entries(view.designated || {}).filter(([, u]) => u > now);
  const rec = `${des.map(([a, u]) => `<div class="polBanner bad"><b>✖</b><span>Designated by ${esc(a)} until ${esc(F.fmtWhen(u, now))}: refused entry at its ports.</span></div>`).join('')}${lock.map((l) => `<div class="polBanner warn"><b>▲</b><span>${esc(l.text || 'Entry lockout')} — until ${esc(F.fmtWhen(l.until, now))}</span></div>`).join('')}
    ${recs.length ? `<ul class="polRecs">${recs.map((x) => `<li class="${esc(x.kind)}"><time>${esc(F.fmtWhen(x.t, now))}</time><span>${esc(x.text)}</span></li>`).join('')}</ul>` : '<p class="muted">No detentions, refusals or seizures on record.</p>'}`;

  // 6 Dataset
  const dsv = `<dl class="kv"><dt>Dataset</dt><dd>${esc(view.version || ds.meta?.version || '—')}</dd><dt>Valid as of</dt><dd>${esc(F.fmtDate(view.validAsOf || ds.meta?.validAsOf))}</dd><dt>Review status</dt><dd>${view.stale || isStale(ds.meta, now) ? '<span class="polStale">▲ may be out of date</span>' : `current (next review ${esc(F.fmtDate(ds.meta?.reviewBy))})`}</dd><dt>Sources in the dataset</dt><dd>${Object.keys(ds.sources || {}).length}</dd></dl>
    <details class="polMore"><summary>Sources used on this panel (${used.length})</summary>${sourcesList(ds, [], used, now)}</details>`;

  const open = !o.phone;
  return `<div class="hqSec polHq"><div class="hqSecH"><h2>${SCALE_SVG} Compliance</h2><span class="muted small">your company's country, flags and standing</span></div>
    <div class="polHqGrid">
    ${card('jur', 'flag', 'Jurisdiction', j, { open: true })}
    ${card('measures', 'list', 'Measures that apply to you', m, { open })}
    ${card('flags', 'ship', 'Fleet flags', f, { open: true })}
    ${card('policy', 'compass', 'Risk policy', pol, { open })}
    ${card('rep', 'handshake', 'Standing with port authorities', rep, { open })}
    ${card('records', 'list', 'Records', rec, { open })}
    ${card('dataset', 'info', 'Dataset', dsv, { open })}
    </div>${footer({ version: view.version, validAsOf: view.validAsOf })}</div>`;
}

// ---------------------------------------------------------------------------------------------- move home card (§4.14)
/** plan: server homeMovePlan (+ homeBefore cc). o: { ds, nowS, toName, money } */
export function moveHomeHTML(plan, o = {}) {
  const ds = o.ds;
  if (!plan) return `<div class="empty">${ic('hourglass')}<span>Asking the registry office…</span></div>`;
  const names = (cc) => ccName(ds, cc);
  const rows = F.moveRows({ ...plan, customsBefore: cuName(ds, plan.customsBefore), customsAfter: cuName(ds, plan.customsAfter) }, names);
  const ok = plan.allowed === true;
  const costs = F.moveCostLines(plan);
  const total = plan.cost ?? costs.reduce((s, c) => s + c.cr, 0);
  const lack = Number.isFinite(o.money) && o.money < total;
  const company = ds?.countries?.[plan.country]?.company || {};
  return `<section class="polModalCard" role="dialog" aria-label="Move home">
    <header class="polRiskH"><div><h3>${ic('anchor')}Move home to ${esc(o.toName || plan.harbor)}</h3><small class="muted">${esc(names(plan.country))} · what changes for your company</small></div>${btn('closeModal', ic('close'), { cls: 'iconBtn ghost', title: 'Close' })}</header>
    <table class="polDiff"><thead><tr><th></th><th>Before</th><th></th><th>After</th></tr></thead><tbody>${rows.map((r) => `<tr class="${r.changed ? 'chg' : ''}"><th>${esc(r.label)}</th><td>${esc(r.before)}</td><td aria-hidden="true">${r.changed ? '→' : '='}</td><td>${esc(r.after)}${r.changed ? ' <span class="chip warn">changes</span>' : ''}</td></tr>`).join('')}</tbody></table>
    <p class="polNote">Standing with each country's port authorities stays as it is.</p>
    <h4>Ships that must re-flag</h4>${(plan.reflag || []).length ? `<ul class="polLines">${plan.reflag.map((r) => line(r.to ? '▲' : '✖', r.to ? 'warn' : 'bad', `<b>${esc(r.name || 'Ship')}</b>: ${esc(registryOf(ds, r.from, plan.homeBefore)?.name || r.from || '—')} → ${r.to ? `${esc(registryOf(ds, r.to, plan.country)?.name || r.to)} · ${esc(F.fmtCr(r.cost))} · ${esc(F.fmtHours(r.hours))}` : 'no registry open to a company based there'}`)).join('')}</ul>` : '<p class="muted small">None: every registry still accepts your company.</p>'}
    <h4>Contracts to finish first</h4>${(plan.blocking || []).length ? `<ul class="polLines">${plan.blocking.map((b) => line('✖', 'bad', `<b>${esc(b.title)}</b> — ${esc(b.reason)}`)).join('')}</ul>` : '<p class="muted small">None.</p>'}
    <h4>Waiting time</h4><p>${esc(F.fmtHours(plan.formationH))} of world clock for company registration${company.formationDays != null ? ` (${company.formationDays} real days, 1 day = ${POL.DAY_TO_H} h)` : ''} ${gameTag('Real waiting times scaled to one game hour per day')}. Ships keep working meanwhile.</p>
    <h4>Cost</h4><dl class="kv">${costs.map((c) => `<dt>${esc(c.label)}${c.game ? ` ${gameTag()}` : ''}</dt><dd>${esc(F.fmtCr(c.cr))}</dd>`).join('')}<dt><b>Total</b></dt><dd><b>${esc(F.fmtCr(total))}</b></dd></dl>
    ${ok ? '' : `<div class="polBanner bad"><b>✖</b><span>${esc(plan.allowed)}</span></div>`}
    ${footer(null)}
    <footer class="polRiskF">${btn('closeModal', 'Not now', { cls: 'ghost' })}${btn('homeStart', `${ic('check')}Start the move · ${esc(F.fmtCr(total))}`, { cls: 'primary', dis: !ok || lack, data: { harbor: plan.harbor }, title: !ok ? String(plan.allowed) : lack ? 'Not enough credits' : '' })}</footer></section>`;
}

// ---------------------------------------------------------------------------------------------- re-flag picker (§4.13)
/** options: reflagOptions(); vessel: { id, name, flag }. */
export function reflagHTML(vessel, options, o = {}) {
  const ds = o.ds;
  const cur = vessel?.flag?.registry;
  const rows = (options || []).map((x) => {
    const here = x.id === cur;
    return `<tr class="${x.ok ? '' : 'no'}${here ? ' cur' : ''}"><td><b>${esc(x.name)}</b><small>${esc(x.flag)} · ${esc(x.kind || '')} ${srcTag(ds, x.src, x.asOf, o.nowS)}</small></td>
      <td data-l="Owner rule">${x.ownerOk ? '✔' : '✖'} <small>${esc(ownerText(ds, registryOf(ds, x.id, o.homeCc)?.owner))}</small></td><td data-l="Age">${x.ageOk ? '✔' : '✖'}${x.survey ? ` <small>survey ${esc(F.fmtCr(x.survey))}</small>` : ''}</td>
      <td class="num" data-l="Cost">${esc(F.fmtCr(x.cost))}</td><td class="num" data-l="Time">${esc(F.fmtHours(x.hours))}</td>
      <td>${here ? '<span class="chip good">current</span>' : btn('reflag', 'Re-flag', { cls: 'small', dis: !x.ok, data: { vid: vessel?.id || '', reg: x.id }, title: x.ok ? '' : !x.ownerOk ? 'Your company does not meet the owner rule' : 'The ship is too old for this register' })}</td></tr>`;
  }).join('');
  return `<section class="polModalCard" role="dialog" aria-label="Re-flag">
    <header class="polRiskH"><div><h3>${ic('flag')}Re-flag ${esc(vessel?.name || 'ship')}</h3><small class="muted">now ${esc(ccName(ds, vessel?.flag?.cc))} · the ship keeps working; the new flag takes effect when the registry is done</small></div>${btn('closeModal', ic('close'), { cls: 'iconBtn ghost', title: 'Close' })}</header>
    <div class="polTableWrap"><table class="polTable polReg"><thead><tr><th>Registry</th><th>Owner rule</th><th>Age</th><th class="num">Cost</th><th class="num">Time</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="polNote">Fees are game numbers ${gameTag()}; setup times come from the registries (1 real day = ${POL.DAY_TO_H} h). The old flag stays in the ship's flag history.</p>${footer(null)}</section>`;
}

// ---------------------------------------------------------------------------------------------- contracts (§4.12, §5.1 badges)
export function badgesHTML(badges) {
  return badges.length ? `<div class="polBadges">${badges.map((b) => `<span class="chip ${b.cls === 'info' ? '' : esc(b.cls)}" title="${esc(b.title || '')}">${esc(b.text)}</span>`).join('')}</div>` : '';
}
/** The extra lines a hud contract card shows for a politics job (badges + a type note). */
export function jobExtrasHTML(job, check, o = {}) {
  const areaName = (id) => o.ds?.areaById?.[id]?.name || id;
  return badgesHTML(F.jobBadges(job, check, areaName));
}
/**
 * A complete card for the new contract types (aid, corridor, state, avoid, evac), same layout as the hud's jobCard.
 * o: { ds, check, fromName, toName, rep, policyText, nowS }
 */
export function contractCardHTML(job, o = {}) {
  const ds = o.ds, t = F.DIPLO_TYPES[job.type] || { label: job.type, icon: 'contract', blurb: '' };
  const areaName = (id) => ds?.areaById?.[id]?.name || id;
  const badges = F.jobBadges(job, o.check, areaName);
  const notes = [];
  if (job.type === 'corridor') notes.push(`Corridor route and entry clearance required at ${esc(o.fromName || job.from)}. Pay +${Math.round(F.RISK_PAY[4] * 100)} %; the war premium is refunded on delivery.`);
  if (job.type === 'aid') notes.push('Humanitarian cargo: standing +5 with the destination\'s port authorities on delivery.');
  if (job.type === 'state') { const n = job.pol?.needs?.rep; if (n) notes.push(`Needs standing ${n.min} with ${esc(ccName(ds, n.cc))} port authorities (you: ${Number.isFinite(o.rep?.[n.cc]) ? o.rep[n.cc] : 0}). Standing +3 on delivery.`); }
  if (job.type === 'avoid') notes.push(`Paid for the long way round. Entering ${esc((job.pol?.mustAvoid || []).map(areaName).join(', ') || 'the listed area')} halves the pay and costs standing −5.`);
  if (job.type === 'evac') notes.push(`Passenger ships only · ${job.windowH || 24} h of ship time · civilian passengers, as marked by a dated source.`);
  const blocked = o.check && o.check.ok === false;
  const qty = job.pax ? `${F.fmtN(job.pax)} passengers` : job.qty ? `${F.fmtN(job.qty)} t ${goodName(job.good).toLowerCase()}` : '';
  const per = job.qty ? `${F.fmtN(job.pay / job.qty)} cr/t` : job.pax ? `${F.fmtN(job.pay / job.pax)} cr/pax` : '';
  return `<article class="card jobCard polJob t-${esc(job.type)}">
    <div class="jobTop"><span class="jobType">${ic(t.icon)}${esc(t.label)}</span>${job.hours ? `<span class="chip ghost">${ic('clock')}${esc(String(job.hours))} h</span>` : ''}</div>
    <h4>${esc(job.title || `${t.label} to ${o.toName || job.to}`)}</h4>
    <div class="route">${ic('pin')}<b>${esc(o.fromName || job.from)}</b>${ic('arrowRight')}<b>${esc(o.toName || job.to)}</b>${job.distKm ? `<span class="muted">· ${F.fmtN(job.distKm)} km</span>` : ''}</div>
    <div class="muted small">${esc(qty)}</div>
    <div class="payRow"><span class="pay">${F.fmtN(job.pay)}<small>cr</small></span><span class="perT">${esc(per)}</span></div>
    ${badgesHTML(badges)}
    ${notes.map((n) => `<p class="polNote">${n}</p>`).join('')}
    ${o.policyText ? `<p class="polNote warn">▲ ${esc(o.policyText)}</p>` : ''}
    <div class="elig ${blocked ? 'bad' : 'ok'}">${ic(blocked ? 'x' : 'check')}${esc(blocked ? F.reasonLine(o.check.block) : 'Allowed for your company')}</div>
    <div class="actions">${btn('riskJob', `${ic('radar')}Risk check`, { cls: 'ghost', data: { job: job.id } })}<button class="${blocked ? '' : 'primary'}" data-act="accept" data-job="${esc(job.id)}"${blocked ? ` disabled title="${esc(F.reasonLine(o.check.block))}"` : ''}>Accept</button></div>
  </article>`;
}

/** War premium for each listed area on a report, for "Buy war cover now". */
export function coverAreas(ds, report, cls, cond) {
  return (report?.lines || []).filter((l) => l.kind === 'war_risk').map((l) => ({ id: l.id, name: l.name, premium: warPremium(ds.areaById[l.id], cls, cond), apPct: apPctOf(ds.areaById[l.id]), pDay: pDayOf(ds.areaById[l.id]) }));
}
/** ECA fuel-switch cost estimate for a report at `speedKn` (km inside / speed → hours × burn). */
export function ecaCostFor(report, cls, speedKn, cond = 100) {
  const km = (report?.lines || []).filter((l) => l.kind === 'eca' && l.inForce !== false).reduce((s, l) => s + (l.km || 0), 0);
  if (!(km > 0) || !(speedKn > 0)) return 0;
  const h = km / (speedKn * 1.852);
  return ecaCost(F.burnPerHour(SHIP_CLASSES[cls] || SHIP_CLASSES.coaster, speedKn, cond) * h);
}
