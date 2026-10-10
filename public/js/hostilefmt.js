// Hostile AI ships, client formatters (docs/HOSTILE-AI-CONTRACT.md R14, R15): pure strings in, strings out, DOM-free so
// Node tests import them (test/hostile-client.test.mjs). Crews are always safe; no injuries are ever described.
import { HOSTILE_TEXT, KINDS, HOSTILE } from '../../shared/hostile.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtN = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—');
const km = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);

/** What the player sees on the chart / radar / in the 3D label for a snapshot unit (unidentified craft stay anonymous). */
export function unitLabel(u) {
  if (!u) return '';
  if (u.ident && u.name) return u.name;
  const K = KINDS[u.k] || KINDS.skiff;
  return u.f === 'friend' ? 'Naval vessel' : K.unk;
}
/** Radar / chart colour: red for pirates and hostile navy until identified as friendly; friends are blue-green. */
export function unitColor(u) { return u?.f === 'friend' ? '#4fd1c5' : u?.f === 'navy' ? '#ff7a45' : '#ff2a2a'; }

/**
 * The warning banner for `you.hostile` (server youView): { title, sub, buttons: [{ act, label, primary?, danger? }] }, or null.
 * `money` is the skipper's credits (the release payment button greys out when she cannot pay).
 */
export function bannerModel(h, money = Infinity) {
  if (!h) return null;
  const dist = km(h.dist || 0), where = `${dist} at ${String(h.brg ?? 0).padStart(3, '0')}°`;
  if (h.f === 'pirate') {
    const btns = [];
    let title, sub;
    if (h.st === 'approach') { title = h.ident ? 'PIRATES CLOSING' : 'UNKNOWN FAST CRAFT CLOSING'; sub = `${h.n} craft · ${where} · speed up, call the navy, or prepare to be boarded`; }
    else if (h.citadel) { title = 'CITADEL: CREW LOCKED IN'; sub = 'Boarding is frozen. Hold out until the navy arrives.'; }
    else if (h.comply) { title = 'YOU HAVE SURRENDERED'; sub = 'The pirates are coming alongside. Crew safe.'; }
    else if (h.board > 0) { title = 'PIRATES BOARDING'; sub = `boarding ${Math.round(h.board * 100)} % · fire hose or speed above ${HOSTILE.BOARD_MAX_KN} kn stops it`; }
    else { title = 'PIRATE ATTACK'; sub = `${h.n} skiff${h.n > 1 ? 's' : ''} · ${where} · small-arms fire on the hull`; }
    btns.push({ act: 'hostile_navy', label: h.navyCalled ? 'Navy called' : 'Call the navy', disabled: !!h.navyCalled });
    btns.push({ act: 'hostile_hose', label: `Fire hose (${h.hose ?? 0})`, disabled: !(h.hose > 0) });
    if (!h.citadel) btns.push({ act: 'hostile_citadel', label: 'Citadel' });
    btns.push({ act: 'hostile_pay', label: `Pay release ${fmtN(h.ransom)} cr`, disabled: money < h.ransom });
    btns.push({ act: 'hostile_cargo', label: 'Hand over cargo' });
    if (!h.comply) btns.push({ act: 'hostile_surrender', label: 'Surrender', danger: true });
    btns.push({ act: 'client_bino', label: 'Binoculars' });
    return { tone: 'pirate', title, sub, buttons: btns };
  }
  // navy
  const who = h.ident && h.name ? h.name : h.label;
  let title, sub;
  if (h.st === 'approach') { title = 'WARSHIP CLOSING'; sub = `${who} · ${where}`; }
  else if (h.st === 'hail') { title = h.demand ? 'HEAVE TO FOR INSPECTION' : 'NAVAL PATROL HAILING'; sub = `${who} · ${h.demand ? `your ship ${h.demand}` : 'state cargo and destination'}${h.left != null ? ` · ${h.left} s` : ''}`; }
  else if (h.st === 'fire') { title = 'UNDER NAVAL FIRE'; sub = `${who} · ${where} · heave to (under ${HOSTILE.HEAVE_TO_KN} kn) or surrender`; }
  else if (h.st === 'inspect') { title = 'BOARDING PARTY ABOARD'; sub = `${who} is searching the holds. Crew safe.`; }
  else { title = 'NAVAL PATROL'; sub = who; }
  const btns = h.st === 'hail' || h.st === 'fire' ? [{ act: 'hostile_surrender', label: 'Heave to / surrender', danger: h.st === 'fire' }] : [];
  btns.push({ act: 'client_bino', label: 'Binoculars' });
  return { tone: 'navy', title, sub, buttons: btns };
}
export function bannerHTML(model) {
  if (!model) return '';
  return `<div class="hxTitle">${esc(model.title)}</div><div class="hxSub">${esc(model.sub)}</div>`
    + (model.buttons.length ? `<div class="hxBtns">${model.buttons.map((b) => `<button data-hx="${esc(b.act)}" class="${b.danger ? 'danger' : ''}"${b.disabled ? ' disabled' : ''}>${esc(b.label)}</button>`).join('')}</div>` : '');
}

/** The chip in the top bar: 'Risk OFF' / 'Risk ON' plus the day's count. */
export function chipModel(risk) {
  if (!risk) return { on: false, text: 'Risk OFF', title: 'Accept the risk: pirates and naval patrols can attack you in danger areas' };
  return { on: !!risk.on, text: risk.on ? `Risk ON · ${risk.today ?? 0}/${risk.max ?? HOSTILE.MAX_ATTACKS_PER_DAY}` : 'Risk OFF', title: risk.on ? `${HOSTILE_TEXT.warn}${risk.cooldown > 0 ? ` (no new hostile for ${Math.ceil(risk.cooldown / 60)} min)` : ''}` : 'Accept the risk: pirates and naval patrols can attack you in danger areas' };
}

/**
 * The block added to the voyage risk check and the express passage confirmation. `lines` are the route's risk lines
 * (shared riskCheck: kind 'piracy' | 'war_risk'). Returns '' when the route crosses no danger area.
 */
export function riskBlockHTML(on, lines = []) {
  const pir = lines.filter((l) => l.kind === 'piracy'), war = lines.filter((l) => l.kind === 'war_risk');
  if (!pir.length && !war.length) return '';
  const names = [...pir, ...war].map((l) => esc(l.name)).join(', ');
  const body = on
    ? `<b>Risk mode is ON.</b> ${esc(HOSTILE_TEXT.warn)} Danger areas on this route: ${names}.`
    : `<b>Risk mode is OFF.</b> This route crosses ${names}. With the risk accepted, ${pir.length ? 'pirates may chase and board you' : ''}${pir.length && war.length ? ' and ' : ''}${war.length ? 'naval patrols may search you and, if you carry banned cargo and ignore warnings, fire on you' : ''}. A hand-sailed ship at 0 % hull sinks with its cargo; the crew is rescued and landed at the nearest harbour.`;
  return `<div class="hxRisk ${on ? 'on' : ''}" role="note"><span class="hxRiskT">${body}</span><button type="button" data-pol="riskMode" class="small ${on ? '' : 'primary'}">${on ? 'Turn risk mode off' : 'Accept the risk'}</button></div>`;
}
/** Express passage confirmation suffix. */
export function expressWarning(on, lines = []) {
  const hit = lines.filter((l) => l.kind === 'piracy' || l.kind === 'war_risk');
  if (!hit.length) return '';
  return on ? ` WARNING: risk mode is on and this passage crosses ${hit.map((l) => l.name).join(', ')}: pirates may rob or hold your ship, naval patrols may search you (the hull stays above 1 %).` : '';
}
