// Bridges & locks HUD (docs/BRIDGES-LOCKS-VHF-CONTRACT.md §5.5, lane C): the AIR field with the next-three strip, the
// air-draught card (key ';' — live clearance gauge of the next bridge, to-scale side view, ballast, folding, overlay
// toggle), and the bridge / lock cards (click or tap the object, or a strip chip). Pure strings come from wwfmt.js; the
// 3D layer (WwMesh) answers the geometry questions. Builds its own DOM; styles in css/ww.css.
//
//   const hud = new WwHud({ ww, net, phone, vhf: () => app.vhf });  hud.update(you, { lat, lon, hdg, h, Hs }) ~4 Hz;
//   hud.handleKey(e) → true when ';' / Esc was taken;  hud.openObject(id) from a 3D pick.
import { fmtAir, fmtStrip, f1, f2, esc, sideViewSvg, lockPlanSvg, kindText, srcText, datumNote, hoursToday, blocksText, lockStateText, chamberLevel, chamberPhase, gaugeReading, MOV_TEXT, fmtDist, verdictClass, durS, absMs } from './wwfmt.js';
import { drawnSpans, deckThickness, datumOffset } from './wwgeom.js';

const VERDICT_TEXT = { under: 'passes under', tight: 'passes — under 1 m margin', opening: 'needs an opening', never: 'cannot pass', closed: 'closed now' };
const PART_TEXT = { wheelhouse: 'wheelhouse', mast: 'masts', arch: 'radar arch' };
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

export class WwHud {
  /** opts: { ww (WwMesh), net (net.action), phone, vhf: () => Vhf, root, profileOf(cls) (lane A airdraft.js), shipKind(cls) → 'sail'|'motor'|'cargo', clock() → ms } */
  constructor(opts = {}) {
    this.o = opts; this.ww = opts.ww; this.phone = !!opts.phone;
    this.mode = null; this.objId = null; this.you = null; this.ctx = null; this.overlayPref = null; this.ahead = [];
    const root = opts.root || document.body;
    this.air = el('button', 'ww-air glass' + (this.phone ? ' phone' : ''), '');
    this.air.type = 'button'; this.air.title = 'Air draught (;)'; this.air.setAttribute('aria-label', 'Air draught card');
    this.air.innerHTML = '<span class="ww-air-main"><b class="ww-air-v">AIR —</b></span><span class="ww-strip" aria-label="Next bridges"></span>';
    this.air.addEventListener('click', (e) => { const c = e.target.closest('[data-ww]'); if (c) { e.stopPropagation(); this.openObject(c.dataset.ww); } else this.toggleAir(); });
    this.card = el('section', 'ww-card hidden' + (this.phone ? ' phone' : ''));
    this.card.setAttribute('role', 'dialog'); this.card.tabIndex = -1;
    this.card.addEventListener('click', (e) => this.onClick(e));
    root.append(this.air, this.card);
    this.show(false);
  }
  get isOpen() { return !this.card.classList.contains('hidden'); }
  /** Show / hide the AIR chip (e.g. ashore or in the interior). */
  show(on) { this.air.classList.toggle('hidden', !on); if (!on) this.close(); }
  handleKey(e) {
    if (e.key === ';' && !e.ctrlKey && !e.metaKey && !e.altKey) { this.toggleAir(); e.preventDefault?.(); return true; }
    if (e.key === 'Escape' && this.isOpen) { this.close(); return true; }
    return false;
  }
  toggleAir(open) { const want = open ?? this.mode !== 'air'; if (want) { this.mode = 'air'; this.objId = null; this.card.classList.remove('hidden'); this.render(); } else this.close(); }
  openObject(id) { if (!id || !this.ww?.get(id)) return; this.mode = 'obj'; this.objId = id; this.card.classList.remove('hidden'); this.render(); }
  close() { this.mode = null; this.objId = null; this.card.classList.add('hidden'); }
  /** Overlay plane wanted now: the toggle, else on within 1 km of a bridge ahead with verdict ≠ under (§5.2). */
  overlayWanted() {
    if (this.overlayPref != null) return this.overlayPref;
    const a = this.ahead[0]; return !!a && a.dist <= 1000 && a.verdict !== 'under';
  }

  /** you: the `you` snapshot (you.air, you.nextObjects, you.ship, you.lockStay); ctx: {lat, lon, hdg, h, Hs, beam}. */
  update(you, ctx) {
    this.you = you; this.ctx = ctx;
    const air = you?.air || null;
    if (Array.isArray(you?.nextObjects) && you.nextObjects.length) this.ahead = you.nextObjects.map((x) => ({ ...x, name: x.name || this.ww?.get(x.id)?.o.callName || x.id }));
    else if (this.ww && air && ctx) this.ahead = this.ww.objectsAhead(ctx.lat, ctx.lon, ctx.hdg, air, { h: ctx.h, Hs: ctx.Hs || 0 });
    else this.ahead = [];
    this.air.querySelector('.ww-air-v').textContent = this.phone && air ? `AIR ${f2(air.ad)}` : fmtAir(air);
    const strip = fmtStrip(this.ahead);
    const sh = this.air.querySelector('.ww-strip');
    const html = strip.map((c) => `<span class="ww-chip ${c.cls}" data-ww="${esc(c.id)}" title="${esc(c.title)}"><i></i><b>${esc(c.name)}</b><em>${esc(c.text)}</em><small>${esc(c.sub)}</small></span>`).join('');
    if (sh.dataset.k !== html) { sh.innerHTML = html; sh.dataset.k = html; }
    this.air.classList.toggle('alarm', strip.some((c) => c.cls === 'red') && this.ahead[0]?.dist < 1500);
    if (this.ww) this.ww.setShip(air && ctx ? { lat: ctx.lat, lon: ctx.lon, hdg: ctx.hdg, need: air.need ?? air.ad + 0.3, beam: ctx.beam || 8, show: this.overlayWanted() } : null);
    if (this.isOpen) this.render();
  }

  // ------------------------------------------------------------------------------------------ cards
  render() {
    const html = this.mode === 'air' ? this.airCard() : this.mode === 'obj' ? this.objCard(this.objId) : '';
    if (html !== this.lastHtml) { this.card.innerHTML = html; this.lastHtml = html; }
  }
  head(title, sub, icon = '') { return `<header class="ww-h"><div><h3>${icon}${esc(title)}</h3>${sub ? `<small>${esc(sub)}</small>` : ''}</div><button class="iconBtn ww-x" data-act="close" aria-label="Close">✕</button></header>`; }
  airCard() {
    const air = this.you?.air, cls = this.you?.ship?.cls;
    const prof = (cls && this.o.profileOf) ? safe(() => this.o.profileOf(cls)) : null;
    if (!air) return this.head('Air draught', 'no data yet') + '<p class="ww-muted">Waiting for the ship\'s air draught from the server.</p>';
    const need = air.need ?? air.ad + 0.3;
    const a = this.ahead[0], ob = a ? this.ww?.get(a.id) : null;
    let gauge = '<p class="ww-muted">No bridge ahead within 5 km.</p>';
    if (a && ob) {
      const sp = drawnSpans(ob.o).find((s) => s.i === a.span) || ob.o.spans[a.span] || ob.o.spans[0];
      const cn = Number.isFinite(a.clrNow) ? a.clrNow : null, cm = a.open && Number.isFinite(a.clrOpenNow) ? a.clrOpenNow : cn, margin = cm != null ? cm - need : null;
      gauge = `<div class="ww-gauge ${a.open ? 'ok' : verdictClass(a.verdict)}"><div class="ww-g-l"><small>Next: ${esc(a.name)} · ${fmtDist(a.dist)}</small><b>${cn == null ? '—' : f1(gaugeReading(cn))}<u>m</u></b><small>clearance now (gauge)</small></div>
        <div class="ww-g-r"><b>${margin == null ? '—' : (margin >= 0 ? '+' : '') + f1(margin)}<u>m</u></b><small>${esc(a.open ? 'open — proceed on green' : VERDICT_TEXT[a.verdict] || a.verdict)}</small></div></div>`
        + sideViewSvg({ clrNow: cn, clrOpenNow: a.clrOpenNow, th: deckThickness(ob.o.kind, sp.b - sp.a), deckW: ob.o.deckW, mov: sp.mov, ship: { ad: air.ad, need, L: this.o.lengthOf?.(cls) ?? 20, kind: this.o.shipKind?.(cls) || 'motor', tiers: air.deckTiers || 0 } });
    }
    const bMax = prof?.ballastMax ?? this.you?.air?.ballastMax ?? 0, bT = Number(air.ballastT) || 0;
    const ballast = bMax > 0 ? `<div class="ww-sec"><h4>Ballast</h4><div class="ww-bar"><i style="width:${Math.min(100, (bT / bMax) * 100).toFixed(1)}%"></i>${air.ballastTarget != null ? `<s style="left:${Math.min(100, (air.ballastTarget / bMax) * 100).toFixed(1)}%"></s>` : ''}</div>
      <div class="ww-row"><span>${Math.round(bT)} / ${Math.round(bMax)} t${air.ballastTarget != null && Math.abs(air.ballastTarget - bT) > 1 ? ` → ${Math.round(air.ballastTarget)} t${prof?.pumpTph ? ` (${Math.ceil((Math.abs(air.ballastTarget - bT) / prof.pumpTph) * 60)} min)` : ''}` : ''}</span>
      <span class="ww-btns"><button data-act="ballast" data-op="fill">Fill</button><button data-act="ballast" data-op="empty">Empty</button><button data-act="ballast" data-op="stop">Stop</button></span></div></div>` : '';
    const parts = Object.keys(prof?.up || air.fold || {}).filter((k) => PART_TEXT[k] && (prof?.up ? prof.up[k] > 0 : true));
    const fold = parts.length ? `<div class="ww-sec"><h4>Fold</h4><div class="ww-btns">${parts.map((k) => { const down = !!(air.fold && air.fold[k]); return `<button data-act="fold" data-part="${k}" data-down="${down ? 0 : 1}">${down ? 'Raise' : 'Lower'} ${PART_TEXT[k]}${prof?.up?.[k] ? ` (${down ? '+' : '−'}${f1(prof.up[k])} m)` : ''}</button>`; }).join('')}</div></div>` : '';
    const ov = this.overlayWanted();
    return this.head('Air draught', 'highest point above the water') +
      `<div class="ww-big"><div><small>AIR DRAUGHT</small><b>${f2(air.ad)}<u>m</u></b></div><div><small>DRAUGHT</small><b>${air.T != null ? f2(air.T) : '—'}<u>m</u></b></div><div><small>NEED (+0.30)</small><b>${f2(need)}<u>m</u></b></div>${air.deckTiers ? `<div><small>DECK TIERS</small><b>${air.deckTiers}</b></div>` : ''}</div>`
      + gauge + ballast + fold
      + `<label class="ww-tog"><input type="checkbox" data-act="overlay" ${ov ? 'checked' : ''}> Show the air-draught plane ahead${this.overlayPref == null ? ' <small>(auto)</small>' : ''}</label>`;
  }
  objCard(id) {
    const e = this.ww?.get(id); if (!e) return this.head('Bridge', 'not in range');
    return e.type === 'lock' ? this.lockCard(e) : this.bridgeCard(e);
  }
  callBtn(o, kind) {
    if (o.call === 'vhf' && o.vhf) return `<button class="primary" data-act="call" data-ch="${o.vhf}" data-kind="${kind}">Call on ch ${o.vhf}</button>`;
    if (o.call === 'button') return '<button data-act="button">Request opening (push button)</button>';
    if (o.call === 'phone') return '<span class="ww-muted">by phone only</span>';
    return '';
  }
  bridgeCard(e) {
    const o = e.o, h = this.ww.waterOf(e), now = this.clock(), st = e.state || {};
    const spans = drawnSpans(o);
    const main = spans.find((s) => s.mov !== 'fixed') || spans.find((s) => s.rec) || spans[0];
    const air = this.you?.air;
    const rows = spans.map((s) => {
      const cn = this.ww.clrNow(o.id, s.i, h), ss = (st.spans || []).find((x) => x.i === s.i);
      const off = datumOffset(o, { datumOffset: this.ww.opts.datumOffset });
      const open = s.mov === 'fixed' ? '' : s.clrO == null ? ' · open: unlimited' : ` · open ${f1(Number(s.clrO) + off - h)} m`;
      const stTxt = s.mov === 'fixed' ? '' : ` <span class="ww-st ${ss?.st || 'closed'}">${esc(spanStText(ss, now))}</span>`;
      return `<li><b>${esc(MOV_TEXT[s.mov] || s.mov)}${s.rec ? ' ★' : ''}</b> ${f1(cn)} m now${open} · ↔ ${f1(s.w)} m${stTxt}<br><small>${esc(datumNote(o, s, h - off, cn))}</small></li>`;
    }).join('');
    let side = '';
    if (main) {
      const cn = this.ww.clrNow(o.id, main.i, h), off = datumOffset(o, { datumOffset: this.ww.opts.datumOffset });
      side = sideViewSvg({ clrNow: cn, clrOpenNow: main.clrO == null ? null : Number(main.clrO) + off - h, th: deckThickness(o.kind, main.b - main.a), deckW: o.deckW, mov: main.mov,
        ship: air ? { ad: air.ad, need: air.need ?? air.ad + 0.3, L: this.o.lengthOf?.(this.you?.ship?.cls) ?? 20, kind: this.o.shipKind?.(this.you?.ship?.cls) || 'motor', tiers: air.deckTiers || 0 } : { ad: 0 } });
    }
    const ahead = this.ahead.find((a) => a.id === o.id);
    const verdict = ahead ? `<div class="ww-verdict ${ahead.open ? 'ok' : verdictClass(ahead.verdict)}">${esc(ahead.open ? 'bridge open — proceed on green' : VERDICT_TEXT[ahead.verdict] || ahead.verdict)}${(() => { const c = ahead.open ? ahead.clrOpenNow : ahead.clrNow; return Number.isFinite(c) && Number.isFinite(ahead.need) ? ` · margin ${(c - ahead.need >= 0 ? '+' : '') + f1(c - ahead.need)} m` : ''; })()}</div>` : '';
    const blocks = blocksText(o.blocks || []);
    const next = st.next ? `<div class="ww-row"><span>Next opening</span><b>${esc(hhmm(st.next))}</b></div>` : '';
    const queue = Array.isArray(st.queue) && st.queue.length ? `<div class="ww-row"><span>Queue</span><b>${st.queue.map((q) => esc(q.name || q)).join(', ')}</b></div>` : '';
    return this.head(o.callName || o.name, `${kindText(o)} · ${srcText(o)}${o.e === 2 ? ' — unverified clearance: slow down and read the gauge' : ''}`)
      + verdict + `<ul class="ww-spans">${rows}</ul>` + side
      + `<div class="ww-grid"><div class="ww-row"><span>Channel</span><b>${o.call === 'vhf' && o.vhf ? `VHF ${o.vhf}` : o.call === 'button' ? 'push button' : o.call === 'phone' ? 'phone' : '—'}</b></div>
        <div class="ww-row"><span>Hours today</span><b>${esc(o.call === 'none' && !o.hours ? '—' : hoursToday(o.hours, now))}</b></div>
        ${blocks.length ? `<div class="ww-row"><span>No openings</span><b>${blocks.map(esc).join('<br>')}</b></div>` : ''}
        ${o.slots ? `<div class="ww-row"><span>Openings</span><b>every ${o.slots.every} min (:${String(o.slots.at || 0).padStart(2, '0')})</b></div>` : ''}${next}${queue}
        ${o.lockId ? `<div class="ww-row"><span>Operated by</span><b>the lock${o.pairedWith ? ' (one of the pair always stays closed)' : ''}</b></div>` : ''}
        ${st.out ? `<div class="ww-row bad"><span>Out of service</span><b>${esc(st.out.why || '')}${st.out.until ? ` until ${esc(hhmm(st.out.until))}` : ''}</b></div>` : ''}</div>`
      + `<div class="ww-foot">${o.lockId ? '' : this.callBtn(o, 'bridge')}</div>`;
  }
  lockCard(e) {
    const o = e.o, now = this.clock(), st = e.state || {}, sideNames = (o.sides || []).map((s) => s.name);
    const chs = (o.chambers || []).map((c) => {
      const cs = (st.chambers || []).find((x) => String(x.id) === String(c.id));
      const lvl = cs ? chamberLevel(cs, now, { A: c.len * c.wid }) : null, ph = chamberPhase(cs);
      const lift = cs && Number.isFinite(cs.level0) && Number.isFinite(cs.level1) ? Math.abs(cs.level1 - cs.level0) : null;
      const q = (cs?.queue || []).map((x, i) => `${i + 1}. ${esc(x.name || x)}${x.kind ? ` <small>${esc(x.kind)}</small>` : ''}`).join(' · ');
      const you = this.you?.ship?.name || this.you?.name;
      const myN = (cs?.queue || []).findIndex((x) => (x.name || x) === you);
      return `<div class="ww-ch"><div class="ww-row"><b>Chamber ${esc(c.id)}</b><span>${f1(c.len)} × ${f1(c.wid)} m · sill ${f1(Math.min(c.sillUp ?? 9, c.sillDn ?? 9))} m${c.kind === 'small' ? ' · small craft' : ''}</span></div>
        ${cs ? `<div class="ww-row"><span>${esc(lockStateText(cs, now, sideNames))}</span><b>${lvl != null ? `${lvl >= 0 ? '+' : ''}${f2(lvl)} m` : ''}</b></div>` : '<div class="ww-row"><span class="ww-muted">no cycle data</span></div>'}
        ${cs ? `<div class="ww-row"><span>Levels</span><b>${esc(sideNames[ph.side] || 'side ' + ph.side)} ${fmtLvl(cs.level0)} → ${fmtLvl(cs.level1)}${lift != null ? ` · lift ${f2(lift)} m` : ''}</b></div>` : ''}
        ${q ? `<div class="ww-row"><span>Queue</span><b>${q}</b></div>` : ''}${myN >= 0 ? `<div class="ww-row"><span>You</span><b>number ${myN + 1}</b></div>` : ''}
        ${lockPlanSvg(c, cs?.plan || [], this.you?.id ?? null, this.phone ? 300 : 340)}</div>`;
    }).join('');
    const fee = o.fee == null ? (o.operator === 'RWS' || o.operator === 'Port of Rotterdam' ? 'free' : '—') : typeof o.fee === 'object' ? `commercial ${o.fee.commercial ?? 0} cr · small ${o.fee.small ?? 0} cr` : `${o.fee} cr`;
    return this.head(o.callName || o.name, `lock · ${srcText(o)}${o.doubleActing ? ' · double-acting' : ''}`)
      + `<div class="ww-grid"><div class="ww-row"><span>Sides</span><b>${sideNames.map(esc).join(' ↔ ')}</b></div><div class="ww-row"><span>Channel</span><b>${o.vhf ? `VHF ${o.vhf}` : o.call === 'button' ? 'push button' : '—'}</b></div>
        <div class="ww-row"><span>Hours today</span><b>${esc(hoursToday(o.hours, now))}</b></div><div class="ww-row"><span>Fee</span><b>${esc(fee)}</b></div></div>`
      + chs + `<div class="ww-foot">${this.callBtn(o, 'lock')}</div>`;
  }
  clock() { return this.o.clock ? this.o.clock() : this.ww?.now ? this.ww.now() : Date.now(); }
  onClick(e) {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act, net = this.o.net;
    if (act === 'close') return this.close();
    if (act === 'ballast') return net?.action?.('ballast', { op: b.dataset.op });
    if (act === 'fold') return net?.action?.('fold', { part: b.dataset.part, down: b.dataset.down === '1' });
    if (act === 'overlay') { this.overlayPref = !!b.checked; return; }
    if (act === 'button' && this.objId) return net?.action?.('ww_button', { id: this.objId });
    if (act === 'call' && this.objId) {
      const o = this.ww.get(this.objId)?.o, vhf = this.o.vhf?.();
      if (o && vhf) { vhf.useChip?.({ ch: Number(b.dataset.ch), to: { id: o.id, name: o.callName || o.name, kind: b.dataset.kind }, phrase: b.dataset.kind === 'lock' ? 'req_lock' : 'req_open' }); vhf.open?.(true); }
      this.o.onCall?.(o, Number(b.dataset.ch));
    }
  }
  dispose() { this.air.remove(); this.card.remove(); }
}
function safe(f) { try { return f(); } catch { return null; } }
const fmtLvl = (v) => (Number.isFinite(Number(v)) ? `${v >= 0 ? '+' : '−'}${f2(Math.abs(v))}` : '—');
function hhmm(t) { const ms = absMs(t); if (ms == null) return String(t); try { return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit' }).format(new Date(ms)); } catch { return new Date(ms).toISOString().slice(11, 16); } }
function spanStText(ss, now) {
  if (!ss) return 'closed';
  const left = ss.t0 != null && durS(ss.dur) > 0 ? Math.max(0, Math.round(durS(ss.dur) - (now - absMs(ss.t0)) / 1000)) : null;
  const w = { closed: 'closed', warn: 'get ready (red + green)', opening: 'opening', open: 'open — proceed on green', closing: 'closing', out: 'out of service', noservice: 'no service' }[ss.st] || ss.st;
  return left != null && (ss.st === 'opening' || ss.st === 'closing' || ss.st === 'warn') ? `${w} · ${left} s` : w;
}
