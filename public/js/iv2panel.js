// Interiors v2 — the engine panel (docs/INTERIORS-V2-CONTRACT.md §7, Q20; Lane I). Opened from the ECR console or a
// local control stand: rpm, load, fuel, consumption, cooling and lube-oil temperatures (derived), generators online,
// bilge level, alarms; read-only until the wave-2 engine controls exist (the same panel will host them); a drill toggle
// for the emergency lighting. E / Esc / the close button closes it.
import { rpmFraction, orderLabel } from '/shared/telegraph.js';

let el = null, timer = null, cur = null;
const RPM2S = 110, RPM4S = 750;
function css() {
  if (document.getElementById('iv2css')) return;
  const l = document.createElement('link'); l.id = 'iv2css'; l.rel = 'stylesheet'; l.href = '/css/iv2.css';
  document.head.appendChild(l);
}
export const panelOpen = () => !!(el && el.style.display !== 'none');
/** The numbers the panel shows (pure — the node test checks them). */
export function engineReadout(app, plan) {
  const you = app?.you || {}, s = app?.ship || you.ship || {};
  const thr = Number(s.throttle) || 0, run = !you.fuelEmpty;
  const rf = rpmFraction(thr) * (run ? 1 : 0);
  const two = plan?.iv2?.me?.kind === '2s';
  const rpmMax = two ? RPM2S : RPM4S;
  const load = Math.round(Math.min(110, Math.abs(rf) ** 3 * 100 + (run ? 6 : 0)));
  const cond = you.cond ?? 100;
  const ht = Math.round(70 + 18 * Math.abs(rf) + (100 - cond) * 0.15), lo = Math.round(42 + 10 * Math.abs(rf) + (100 - cond) * 0.1);
  const gens = plan?.props?.filter((p) => p.t === 'generator').length || 2;
  const online = Math.min(gens, 1 + (Math.abs(thr) > 0.4 ? 1 : 0) + (you.flooding > 0.05 ? 1 : 0));
  const alarms = [];
  if (!run) alarms.push('NO FUEL — main engine stopped');
  else if ((you.fuel ?? 99) < 5) alarms.push('Fuel service tank low');
  if (cond < 30) alarms.push('Hull damage — check bilges');
  if ((you.flooding || 0) > 0.01) alarms.push(`Bilge high level — pumps running (${Math.round(you.flooding * 100)} %)`);
  if (ht > 92) alarms.push('HT cooling water temperature high');
  return { rpm: Math.round(rf * rpmMax), astern: thr < -0.005, order: orderLabel(thr), load, fuel: you.fuel ?? null, burn: Number(s.burn ?? you.burn ?? 0) || null, ht, lo, gens, online, bilge: Math.round((you.flooding || 0) * 100), alarms };
}
export function openEnginePanel(I, h) {
  if (typeof document === 'undefined') { cur = { I, h }; return; }
  css();
  if (!el) {
    el = document.createElement('div'); el.id = 'iv2Panel'; el.className = 'iv2-panel';
    el.innerHTML = '<div class="iv2-head"><b>Engine control</b><span class="iv2-sub"></span><button type="button" class="iv2-x" aria-label="Close">×</button></div><div class="iv2-grid"></div><div class="iv2-alarms"></div><label class="iv2-drill"><input type="checkbox"> Emergency lighting drill</label>';
    el.querySelector('.iv2-x').addEventListener('click', (e) => { e.stopPropagation(); closeEnginePanel(); });
    el.querySelector('input').addEventListener('change', (e) => { if (cur?.I?.v2) cur.I.v2.drill = e.target.checked; });
    addEventListener('keydown', (e) => { if (panelOpen() && (e.key === 'Escape' || e.key.toLowerCase() === 'e')) { e.stopPropagation(); closeEnginePanel(); } }, true);
    document.body.appendChild(el);
  }
  cur = { I, h };
  el.querySelector('.iv2-sub').textContent = h.label || '';
  el.style.display = 'block';
  I.unlock?.();
  render();
  clearInterval(timer); timer = setInterval(render, 250);
}
export function closeEnginePanel() { if (el) el.style.display = 'none'; clearInterval(timer); timer = null; }
function render() {
  if (!el || !cur) return;
  const r = engineReadout(cur.I.app, cur.I.plan);
  const cell = (k, v, warn = false) => `<div class="iv2-cell${warn ? ' warn' : ''}"><span>${k}</span><b>${v}</b></div>`;
  el.querySelector('.iv2-grid').innerHTML = [
    cell('Main engine', `${r.rpm} rpm${r.astern ? ' astern' : ''}`), cell('Order', r.order), cell('Load', `${r.load} %`, r.load > 100),
    cell('Fuel', r.fuel == null ? '—' : `${r.fuel.toFixed(1)} t`, (r.fuel ?? 99) < 5), cell('Consumption', r.burn ? `${r.burn.toFixed(2)} t/h` : '—'),
    cell('HT water', `${r.ht} °C`, r.ht > 92), cell('Lube oil', `${r.lo} °C`), cell('Generators', `${r.online} / ${r.gens} online`), cell('Bilge', `${r.bilge} %`, r.bilge > 5),
  ].join('');
  el.querySelector('.iv2-alarms').innerHTML = r.alarms.length ? r.alarms.map((a) => `<div class="iv2-alarm">⚠ ${a}</div>`).join('') : '<div class="iv2-ok">No alarms</div>';
}
