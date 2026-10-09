// Harbour job board for JOB_GEN 8 (docs/SHIPYARD-SHIPS-INTERIORS-CONTRACT.md §5.9). Rendered into the hud's jobs tab by
// hook H5b (`if (this.app.jobBoard) return this.app.jobBoard.html(h, you);`). Groups: "Your ship can do" (sorted by
// estimated profit per hour), "Your fleet can do" (assign to a captain), "Other work here" (collapsed, each card with
// its "why not" chip; the card's details list every reason). Family chips filter; phones get the same groups as
// accordions and horizontally scrolling chips. DOM-free string rendering: the logic lives in shared/jobs/board.js,
// passed in as `lib` (the browser loads it with JobBoard.create(app); node tests pass it directly).
import { ic, JOB_ICON } from './icons.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—');
const STEP_ICON = { load: 'crane', discharge: 'crane', board: 'users', land: 'pier', sail: 'route', work: 'clock', meet: 'target', tow: 'tow', race: 'flag', drill: 'check' };
const FAMILY_ICON = {
  box: 'containers', liner: 'containers', voyage: 'ship', coa: 'ship', tc: 'contract', project: 'crane', vehicles: 'ship', ropax_route: 'users', cruise: 'users',
  anchor: 'anchor', standby: 'platform', crewchange: 'users', towage: 'tow', ocean_tow: 'tow', salvage: 'lifebuoy', pilot_transfer: 'ship', bunkering: 'fuel',
  launch: 'ship', dredge: 'wave', survey: 'radar', research: 'globe', escort: 'compass', lesson: 'sail', daycharter: 'yacht', bareboat: 'key', regatta: 'flag',
  ecotour: 'eye', guests: 'yacht', delivery: 'sail',
};

export class JobBoard {
  /** Browser: load the shared board logic and build the board (main.js H13: `app.jobBoard = await JobBoard.create(app)`). */
  static async create(app) { const lib = await import('/shared/jobs/board.js'); const fam = await import('/shared/jobs/catalogue.js'); return new JobBoard(app, { ...lib, FAMILIES: fam.FAMILIES, groupOf: fam.groupOf }); }
  constructor(app, lib) { this.app = app; this.lib = lib; this.filter = null; this.open = { mine: true, fleet: true, other: false }; }

  harborById(id) { const hs = this.app?.world?.harbors || []; return hs.find((h) => h.id === id) || null; }
  /** Your other ships (client VesselView: { id, name, cls, harbor, status, aboard }); the one you are aboard is `you`. */
  fleetVessels() { const vs = this.app?.fleetUi?.last?.vessels || this.app?.fleetView?.vessels || []; return vs.filter((v) => !v.aboard); }
  ctx() { return { harborById: (id) => this.harborById(id), simTime: this.app?.simTime ?? Date.now() / 1000, weatherAt: this.app?.weatherAt || undefined }; }

  /** The whole tab for harbour view `h` ({ id, name, jobs }) and player view `you`. */
  html(h, you) {
    const L = this.lib, jobs = h?.jobs || [];
    const ctx = this.ctx();
    const g = L.groupBoard(jobs, you, this.fleetVessels(), ctx, { harbor: h?.id, filter: this.filter });
    const chips = L.familyChips(jobs);
    const chipRow = `<div class="jbChips" role="toolbar" aria-label="Filter by kind of work">
      <button class="chip${this.filter ? '' : ' on'}" data-act="jbFilter" data-group="">All <b>${jobs.length}</b></button>
      ${chips.map((c) => `<button class="chip${this.filter === c.group ? ' on' : ''}" data-act="jbFilter" data-group="${esc(c.group)}">${esc(c.label)} <b>${c.n}</b></button>`).join('')}</div>`;
    const sec = (key, title, sub, body, n) => `<details class="jbGroup" data-group="${key}"${this.open[key] ? ' open' : ''}><summary><h3>${esc(title)} <span class="cnt">${n}</span></h3><small>${esc(sub)}</small></summary>${n ? `<div class="cards">${body}</div>` : `<div class="empty small">${esc(key === 'mine' ? 'Nothing here fits your ship right now — new work is posted every hour.' : 'None.')}</div>`}</details>`;
    return `<div class="secHead"><div><h2>${ic('contract')}Contracts</h2><p>${esc(h?.name || '')} · ${jobs.length} on the board</p></div></div>
      ${chipRow}
      ${sec('mine', 'Your ship can do', 'best estimated profit per hour first', g.mine.map((x) => this.card(x.job, h, you, { est: x.est })).join(''), g.mine.length)}
      ${g.fleet.length ? sec('fleet', 'Your fleet can do', 'a hired captain sails her', g.fleet.map((x) => this.card(x.job, h, you, { vessels: x.vessels, why: x.why })).join(''), g.fleet.length) : ''}
      ${sec('other', 'Other work here', 'what it would take', g.other.map((x) => this.card(x.job, h, you, { why: x.why, all: x.all })).join(''), g.other.length)}`;
  }

  /** One card. opts: { est } (doable), { vessels } (fleet), { why, all } (other). */
  card(j, h, you, opts = {}) {
    const L = this.lib, fam = L.FAMILIES?.[j.type];
    const label = fam?.label || j.type, icon = FAMILY_ICON[j.type] || JOB_ICON?.[j.type] || 'contract';
    const info = j.payInfo || (j.pay && typeof j.pay === 'object' ? j.pay : null);
    const pay = typeof j.pay === 'number' ? j.pay : info?.cr ?? 0;
    const to = this.harborById(j.to), from = this.harborById(j.from) || h;
    const unit = L.unitLine(j, (id) => this.harborById(id));
    const steps = L.stepsPreview(j).map((k) => `<span class="st" title="${esc(k)}">${ic(STEP_ICON[k] || 'info')}</span>`).join('<span class="sep">›</span>');
    const tt = Array.isArray(j.timetable) && j.timetable.length ? `<div class="muted small tt">${ic('calendar')}${j.timetable.slice(0, 6).map((t) => new Date(t * 1000).toISOString().slice(11, 16)).join(' · ')} UTC</div>` : '';
    const why = opts.why ? `<div class="elig bad" title="${esc((opts.all || [opts.why]).map((r) => r.text).join('\n'))}">${ic('x')}${esc(opts.why.text)}</div>` : '';
    const more = opts.all && opts.all.length > 1 ? `<details class="whyAll"><summary class="small">${opts.all.length} reasons</summary><ul>${opts.all.map((r) => `<li>${esc(r.text)}</li>`).join('')}</ul></details>` : '';
    const est = opts.est ? `<div class="estLine ok">${ic('coins')}<span>≈ ${fmt(opts.est.pph)} cr/h net over ~${fmt(opts.est.hours)} h</span></div>` : '';
    const hire = info?.model === 'hire' && info.perH ? ` <small>(${fmt(info.perH)} cr/h)</small>` : '';
    const bonus = info?.bonus?.cr ? `<span class="perT">+${fmt(info.bonus.cr)} ${esc(info.bonus.kind === 'ontime' ? 'on time' : info.bonus.kind === 'tip' ? 'tips' : info.bonus.kind)}</span>` : '';
    let actions;
    if (opts.vessels) actions = opts.vessels.map((v) => `<button data-act="jbAssign" data-vessel="${esc(v.id)}" data-job="${esc(j.id)}">Assign to ${esc(v.name)} (captain)</button>`).join('');
    else actions = `<button class="${opts.why ? '' : 'primary'}" data-act="accept" data-job="${esc(j.id)}"${opts.why ? ` disabled title="${esc(opts.why.text)}"` : ''}>Accept</button>`;
    return `<article class="card jobCard jb t-${esc(j.type)}${opts.why && !opts.vessels ? ' dim' : ''}">
      <div class="jobTop"><span class="jobType">${ic(icon)}${esc(label)}</span><span class="chip ghost">${ic('clock')}${fmt(j.hours)} h</span></div>
      <h4>${esc(j.title)}</h4>
      <div class="route">${ic('pin')}<b>${esc(from?.name || j.from)}</b>${to && to.id !== from?.id ? `${ic('arrowRight')}<b>${esc(to.name)}</b>` : ''}</div>
      ${unit ? `<div class="unitLine">${esc(unit)}</div>` : ''}
      <div class="steps">${steps}</div>${tt}${est}
      <div class="payRow"><span class="pay">${fmt(pay)}<small>cr</small>${hire}</span>${bonus}</div>
      ${why}${more}
      <div class="actions">${actions}</div>
    </article>`;
  }

  /** Click delegation for the hud (H5b): returns true when handled. `net` = the client's action sender. */
  click(el, net) {
    const act = el?.dataset?.act;
    if (act === 'jbFilter') { this.filter = el.dataset.group || null; return true; }
    if (act === 'jbAssign') { net.action('fleet_accept', { vesselId: el.dataset.vessel, jobId: el.dataset.job }); return true; }
    return false;
  }
}
