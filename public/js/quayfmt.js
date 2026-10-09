// Dock anywhere — the "Moor here" card's content (docs/DOCK-ANYWHERE-CONTRACT.md §5). Pure: no DOM, no three.js, so
// Node tests import it (test/quayui.test.mjs). The relative import resolves to /shared/… in the browser and to
// <repo>/shared/… under Node. public/js/quayui.js renders these models and draws the berth outline.
import { QUAY, SERVICE_TIERS, approachWhy, clsOf, quayFeePerDay, stayFee, balanceDue, daysAlongside } from '../../shared/quayrules.js';
import { mhServiceRows } from '../../shared/mhgeo.js';   // inland harbour berths: the harbour's own services

const D2R = Math.PI / 180, M_LAT = 111320;
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmtCr = (n) => `${Math.round(Number(n) || 0).toLocaleString('en-US')} cr`;
export const fmtDist = (m) => (!Number.isFinite(m) ? '—' : m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

/** Along / off (m) of a point relative to a candidate's quay face (a → b, water on the right, bearing wb). */
export function faceFrame(face, lat, lon) {
  const k = M_LAT * Math.cos(face.a.lat * D2R), E = (lon - face.a.lon) * k, N = (lat - face.a.lat) * M_LAT;
  const h = face.hdg * D2R, w = face.wb * D2R;
  return { along: E * Math.sin(h) + N * Math.cos(h), off: E * Math.sin(w) + N * Math.cos(w) };
}
/** lat/lon of (along, off) in a face frame. */
export function facePoint(face, along, off) {
  const k = M_LAT * Math.cos(face.a.lat * D2R), h = face.hdg * D2R, w = face.wb * D2R;
  return { lat: face.a.lat + (along * Math.cos(h) + off * Math.cos(w)) / M_LAT, lon: face.a.lon + (along * Math.sin(h) + off * Math.sin(w)) / k };
}
/** Footprint of the slot (the ship's outline alongside): 4 corners lat/lon, clockwise from the face end a. */
export function slotOutline(c) {
  if (!c?.slot || !c.face) return null;
  const f = faceFrame(c.face, c.slot.a.lat, c.slot.a.lon), g = faceFrame(c.face, c.slot.b.lat, c.slot.b.lon);
  const off0 = QUAY.FENDER_M, off1 = QUAY.FENDER_M + (c.slot.beam || 10);
  return [facePoint(c.face, f.along, off0), facePoint(c.face, g.along, off0), facePoint(c.face, g.along, off1), facePoint(c.face, f.along, off1)];
}

/** Keep the skipper's pick while it is listed; else the first fitting one; else the nearest. */
export function pickCandidate(list, prevId) {
  if (!Array.isArray(list) || !list.length) return null;
  return (prevId && list.find((c) => c.id === prevId)) || list.find((c) => c.fits) || list[0];
}

const SERVICE_ROWS = [
  ['market', 'Market', (m) => (m === 1 ? 'as in the harbour' : `by truck, buy +${Math.round((m - 1) * 100)} %, sell −${Math.round((m - 1) * 100)} %`)],
  ['fuel', 'Fuel', (m, t) => (m === 1 ? 'bunker barge' : `by truck, +${Math.round((m - 1) * 100)} %${t.maxFuelT ? `, ≤ ${t.maxFuelT} t` : ''}`)],
  ['repair', 'Repairs', (m) => (m === 1 ? 'harbour yard' : `mobile crew, +${Math.round((m - 1) * 100)} %`)],
  ['shipyard', 'Shipyard', () => 'buy and sell ships'],
  ['office', 'Fleet office', (m, t) => (t.id === 'port' ? 'in the harbour' : 'by phone')],
  ['jobs', 'Contracts', (m, t) => (t.deliver ? 'take and deliver' : 'take only — deliver at the harbour')],
];
/** Rows of the services list for a tier: [{ id, label, ok, note }]. */
export function serviceRows(tier) {
  const t = SERVICE_TIERS[tier] || SERVICE_TIERS.none;
  return SERVICE_ROWS.map(([id, label, note]) => {
    const v = t[id], ok = v === true || Number.isFinite(v);
    return { id, label, ok, note: ok ? note(v, t) : 'not here' };
  });
}

/**
 * The card model for a candidate and the ship now. ctx: { ship: { lat, lon, hdg, spd, cls }, money, docked, assist, hail }.
 * → { title, sub, chips, rows, price, fits, why, moor: { ok, hint }, tugs: { show, ok, hint, cost }, services, tabs, harbour }
 */
export function cardModel(c, ctx = {}) {
  if (!c) return null;
  const s = ctx.ship || {}, C = clsOf(s.cls);
  const rows = [
    { k: 'Quay', v: `${c.lenM} m${c.usableM !== c.lenM ? ` · ${c.usableM} m free` : ''}`, need: `${c.needM} m`, ok: c.usableM >= c.needM },
    { k: 'Depth at low water', v: c.depthLW != null ? `${c.depthLW.toFixed(1)} m` : '—', need: `${c.needDepth.toFixed(1)} m`, ok: c.depthLW != null && c.depthLW >= c.needDepth },
    { k: 'Your ship', v: `${C.length} m × ${C.beam} m, ${C.draft} m draught`, need: '', ok: null },
  ];
  const h = c.harbor;
  const sub = `${c.clsName}${h ? ` · ${h.distKm} km from ${h.name}` : ''} · ${fmtDist(c.distM)} away`;
  const chips = [{ t: SERVICE_TIERS[c.tier]?.label || c.tier, k: c.tier === 'port' ? 'ok' : c.tier === 'none' ? 'bad' : 'warn' }];
  if (c.occupiedBy) chips.push({ t: `Occupied: ${c.occupiedBy.name}`, k: 'bad' });
  // can she make fast now? (the server decides; this only greys the button)
  let moorOk = false, moorHint = c.why || '';
  if (c.fits && c.slot && c.face && Number.isFinite(s.lat)) {
    const f = faceFrame(c.face, s.lat, s.lon), sf = faceFrame(c.face, c.slot.lat, c.slot.lon);
    const w = approachWhy({ lateralM: f.off - sf.off, alongM: sf.along - f.along, hdgDiffDeg: (s.hdg ?? 0) - c.face.hdg, spdKn: s.spd ?? 0, cls: s.cls });
    moorOk = !w; moorHint = w || 'Make fast here';
  }
  if (moorOk && Number.isFinite(ctx.money) && ctx.money < c.perDay) { moorOk = false; moorHint = `The first day (${fmtCr(c.perDay)}) is paid when the lines go ashore. You have ${fmtCr(ctx.money)}.`; }
  if (ctx.hail) { moorOk = false; moorHint = 'The coast guard has ordered you to heave to.'; }
  const tugShow = !!(c.fits && c.tugs);
  let tugOk = false, tugHint = c.tugs ? '' : 'No tugs at this quay';
  if (tugShow) {
    const d = Number.isFinite(s.lat) && c.slot ? approxDist(s.lat, s.lon, c.slot.lat, c.slot.lon) : Infinity;
    tugOk = d <= QUAY.TUG_RANGE_M && Math.abs(s.spd ?? 0) <= QUAY.TUG_MAX_KN && !ctx.hail && !(Number.isFinite(ctx.money) && ctx.money < c.tugCost + c.perDay);
    tugHint = d > QUAY.TUG_RANGE_M ? `Within ${QUAY.TUG_RANGE_M / 1000} km of the quay` : Math.abs(s.spd ?? 0) > QUAY.TUG_MAX_KN ? `Slow below ${QUAY.TUG_MAX_KN} kn` : `Tugs take you alongside for ${fmtCr(c.tugCost)}`;
  }
  return {
    id: c.id, title: c.name, sub, chips, rows, fits: !!c.fits, why: c.fits ? null : c.why,
    price: `${fmtCr(c.perDay)} / day`, perDay: c.perDay,
    priceNote: c.tier === 'port' ? 'Port dues and pilotage as in the harbour. First day paid on mooring, the rest when you cast off.' : 'No port dues out here. First day paid on mooring, the rest when you cast off.',
    moor: { ok: moorOk, hint: moorHint }, tugs: { show: tugShow, ok: tugOk, hint: tugHint, cost: c.tugCost },
    services: serviceRows(c.tier), tabs: c.tabs || [], harbour: h,
  };
}
function approxDist(a, b, c, d) { const k = M_LAT * Math.cos(a * D2R); return Math.hypot((d - b) * k, (c - a) * M_LAT); }

/** Model of the "moored at a quay" panel: berth = you.berth (quay: true), simTime now. */
export function mooredModel(berth, simTime, homeHarbourId = null) {
  if (!berth || !berth.quay) return null;
  const secs = Math.max(0, (Number(simTime) || 0) - (Number(berth.since) || 0));
  const days = daysAlongside(secs), total = stayFee(berth.perDay, secs), due = balanceDue(berth.perDay, secs, berth.paid);
  if (berth.mh) {   // a box / visitor berth in an inland harbour or marina (server/mhmoor.js): fee per night, its own services
    const MHL = { marina: 'Marina', passant: 'Visitor harbour', city: 'City quay', inland_port: 'Inland port', fishing: 'Fishing harbour' };
    return {
      title: berth.name, perDay: berth.perDay, days, total, due, unit: 'night',
      line: `${fmtCr(berth.perDay)} / night · night ${days} · ${due > 0 ? `${fmtCr(due)} due when you cast off` : 'paid up'}${berth.feeBasis ? ` · ${berth.feeBasis}` : ''}`,
      tier: berth.tier, tierLabel: `${MHL[berth.mhTier] || 'Harbour'}${SERVICE_TIERS[berth.tier] ? ` · ${SERVICE_TIERS[berth.tier].label}` : ''}`, services: mhServiceRows(berth),
      harbourId: berth.harbor, home: !!homeHarbourId && homeHarbourId === berth.harbor, mh: berth.mh,
    };
  }
  return {
    title: berth.name, perDay: berth.perDay, days, total, due, unit: 'day',
    line: `${fmtCr(berth.perDay)} / day · day ${days} · ${due > 0 ? `${fmtCr(due)} due when you cast off` : 'paid up'}`,
    tier: berth.tier, tierLabel: SERVICE_TIERS[berth.tier]?.label || '', services: serviceRows(berth.tier),
    harbourId: berth.harbor, home: !!homeHarbourId && homeHarbourId === berth.harbor,
  };
}

const TAB_LABEL = { overview: 'Overview', jobs: 'Contracts', boards: 'Boards', market: 'Market', shipyard: 'Shipyard', services: 'Fuel & repairs', shady: 'Back room', office: 'Office', players: 'Skippers' };
/** Card HTML (escaped). data-q attributes are the buttons quayui.js binds: moor, tugs, prev, next, close, tab:<id>, castoff. */
export function cardHTML(m, { index = 0, count = 1, docked = false } = {}) {
  if (!m) return '';
  const chip = (c) => `<span class="qChip ${esc(c.k)}">${esc(c.t)}</span>`;
  const row = (r) => `<div class="qRow${r.ok === false ? ' bad' : r.ok ? ' ok' : ''}"><span class="qK">${esc(r.k)}</span><span class="qV">${esc(r.v)}</span>${r.need ? `<span class="qN">need ${esc(r.need)}</span>` : ''}</div>`;
  const svc = (s) => `<li class="${s.ok ? 'ok' : 'no'}"><b>${esc(s.label)}</b> <span>${esc(s.note)}</span></li>`;
  const tabs = m.tabs.filter((t) => t !== 'overview').map((t) => `<button data-q="tab:${esc(t)}" ${docked ? '' : 'disabled title="Moor first"'}>${esc(TAB_LABEL[t] || t)}</button>`).join('');
  return `<div class="qHead"><button class="qNav" data-q="prev" ${count > 1 ? '' : 'disabled'} aria-label="Previous quay">‹</button>`
    + `<div class="qTitle"><div class="qName">${esc(m.title)}</div><div class="qSub">${esc(m.sub)}</div></div>`
    + `<button class="qNav" data-q="next" ${count > 1 ? '' : 'disabled'} aria-label="Next quay">›</button><button class="qClose" data-q="close" aria-label="Close">×</button></div>`
    + `<div class="qChips">${m.chips.map(chip).join('')}${count > 1 ? `<span class="qCount">${index + 1} / ${count}</span>` : ''}</div>`
    + `<div class="qPrice"><span class="qPay">${esc(m.price)}</span><span class="qPayNote">${esc(m.priceNote)}</span></div>`
    + `<div class="qRows">${m.rows.map(row).join('')}</div>`
    + (m.fits ? '' : `<div class="qWhy">${esc(m.why)}</div>`)
    + `<div class="qSvcH">Harbour services${m.harbour ? ` · ${esc(m.harbour.name)}` : ''}</div><ul class="qSvc">${m.services.map(svc).join('')}</ul>`
    + `<div class="qBtns"><button class="primary" data-q="moor" ${m.moor.ok ? '' : 'disabled'} title="${esc(m.moor.hint)}">Moor here · ${esc(m.price)}</button>`
    + (m.tugs.show ? `<button data-q="tugs" ${m.tugs.ok ? '' : 'disabled'} title="${esc(m.tugs.hint)}">Tugs · ${esc(fmtCr(m.tugs.cost))}</button>` : '')
    + `</div><div class="qHint">${esc(m.moor.hint)}</div>`
    + (tabs ? `<div class="qTabs">${tabs}</div>` : '');
}
/** Panel HTML while moored at a quay: fee so far, services, the harbour-sheet tabs this quay reaches, cast off. */
export function mooredHTML(m, tabs = []) {
  if (!m) return '';
  const svc = (s) => `<li class="${s.ok ? 'ok' : 'no'}"><b>${esc(s.label)}</b> <span>${esc(s.note)}</span></li>`;
  return `<div class="qHead"><div class="qTitle"><div class="qName">${esc(m.title)}</div><div class="qSub">${esc(m.tierLabel)}${m.home ? ' · home port' : ''}</div></div><button class="qClose" data-q="close" aria-label="Close">×</button></div>`
    + `<div class="qPrice"><span class="qPay">${esc(fmtCr(m.perDay))} / ${esc(m.unit || 'day')}</span><span class="qPayNote">${esc(m.line)}</span></div>`
    + `<ul class="qSvc">${m.services.map(svc).join('')}</ul>`
    + `<div class="qTabs">${tabs.map((t) => `<button data-q="tab:${esc(t)}">${esc(TAB_LABEL[t] || t)}</button>`).join('')}</div>`
    + (m.mh ? `<div class="qBtns"><button data-q="mhcard">Harbour card</button></div>` : '')
    + `<div class="qBtns"><button data-q="castoff">Cast off${m.due > 0 ? ` · pay ${esc(fmtCr(m.due))}` : ''}</button></div>`;
}
export { quayFeePerDay };
