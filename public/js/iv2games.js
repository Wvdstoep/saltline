// Interiors v2 — the tables and venues a captain can use aboard a cruise ship (docs/CRUISE-CONTRACT.md §7). Loaded on first use by
// iv2interact.js (hotspot kind `v:<kind>`, opened with E / tap): a small touch-friendly panel per venue, never more than one at a time.
//   casino   roulette, blackjack, baccarat, slot machine, Texas hold'em: the table is only a screen; every bet, card and payout comes from
//            the server (server/casino.js), credits only. Limits and cooling-off are the casino's and are shown.
//   venues   bar, restaurant, theatre, spa, shop, gym, pool, slide ride, loungers, art auction, library, arcade, rink, climbing wall … priced and
//            booked by the server (server/venues.js); the timing and reaction mini games only decide a score shown to the player.
//   guest services: the guest rating (stars, what lifts it) and what it does to the cruise pay.
// Panels are DOM overlays (≤ 520 px wide, full width on a phone, 44 px touch targets). Nothing is built until a venue is opened.
import { menuFor, MENUS, guestScore } from '../../shared/ships/cruisesat.js';
import { tableLimits, cardName, rankOf, suitOf, SYMBOLS, LINES, RED, coverOf, colourOf } from '../../shared/casino.js';

let el = null, cur = null, styled = false;
const isRed = (c) => suitOf(c) === 1 || suitOf(c) === 2;
const money = (n) => Math.floor(n).toLocaleString('en-US');
const CSS = `
#iv2Game{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:19;width:min(520px,calc(100vw - 16px));max-height:calc(100vh - 16px);overflow:auto;box-sizing:border-box;padding:10px 12px 12px;border-radius:12px;background:rgba(8,16,24,.96);border:1px solid rgba(140,190,230,.45);color:#dbe9f4;font:14px/1.35 "Segoe UI",system-ui,sans-serif;-webkit-overflow-scrolling:touch}
#iv2Game .gh{display:flex;align-items:center;gap:8px;margin-bottom:8px}#iv2Game .gh b{font-size:16px;flex:1}#iv2Game .gh span{color:#9ef0b0;font-family:ui-monospace,Menlo,Consolas,monospace}
#iv2Game button{min-height:44px;min-width:44px;border:0;border-radius:8px;background:rgba(40,70,100,.9);color:#e8f2fa;font:600 14px system-ui;cursor:pointer;padding:4px 10px}#iv2Game button:active{background:rgba(70,120,170,.95)}
#iv2Game button.on{background:#2d7a52}#iv2Game button.gold{background:#8a6a1c}#iv2Game button.red{background:#9a2f2f}#iv2Game button[disabled]{opacity:.4}
#iv2Game .row{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}#iv2Game .note{color:#9fb8cc;font-size:12px;min-height:18px}#iv2Game .msg{min-height:22px;margin:6px 0;font-weight:600}
#iv2Game .cd{display:inline-block;min-width:34px;padding:6px 4px;margin:2px;border-radius:5px;background:#f2f2ea;color:#111;text-align:center;font:700 15px ui-monospace,monospace}#iv2Game .cd.r{color:#c0272d}#iv2Game .cd.back{background:#35507a;color:#35507a}
#iv2Game .num{min-width:0;padding:0;font-size:12px;min-height:34px}#iv2Game .num.r{background:#a82a2a}#iv2Game .num.b{background:#1b1e22}#iv2Game .num.g{background:#1f7a3f}
#iv2Game .grid12{display:grid;grid-template-columns:34px repeat(12,1fr);gap:2px}#iv2Game .reel{display:grid;grid-template-rows:repeat(3,1fr);gap:2px;flex:1}#iv2Game .sym{height:44px;line-height:44px;text-align:center;background:#101a26;border-radius:5px;font-size:22px}
#iv2Game .sym.hit{background:#6a5a12;box-shadow:0 0 6px #f0d040}#iv2Game .bar{height:18px;background:#16222e;border-radius:9px;position:relative;overflow:hidden;margin:8px 0}#iv2Game .bar i{position:absolute;top:0;bottom:0}#iv2Game .stars{font-size:26px;color:#f4c542;letter-spacing:2px}
@media (max-width:420px){#iv2Game{padding:8px}#iv2Game .grid12{grid-template-columns:28px repeat(12,1fr)}}`;
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v); }
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
const card = (c, back) => h('span', { class: `cd${back ? ' back' : isRed(c) ? ' r' : ''}` }, back ? '??' : cardName(c));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const isOpen = () => !!(el && el.style.display !== 'none' && cur);
export function close() {
  if (!el) return;
  el.style.display = 'none'; el.textContent = ''; const I = cur?.I; cur?.stop?.(); cur = null;
  if (I) { I.modal = false; I.keys?.clear?.(); }
}
function mount(I, title, sub, casino = false, themeCss = '') {
  if (!styled) { document.head.append(h('style', { id: 'iv2gamescss' }, CSS)); styled = true; }
  if (casino && !document.getElementById('iv2casinocss')) document.head.append(h('style', { id: 'iv2casinocss' }, themeCss));
  if (!el) {
    el = h('div', { id: 'iv2Game', role: 'dialog', 'aria-modal': 'true' }); document.body.append(el);
    addEventListener('keydown', (e) => { if (isOpen() && (e.key === 'Escape' || (e.key.toLowerCase() === 'e' && !/INPUT|TEXTAREA/.test(e.target.tagName)))) { e.stopPropagation(); e.preventDefault(); close(); } }, true);
  }
  el.className = casino ? 'casino' : ''; el.textContent = ''; el.style.display = 'block'; I.unlock?.(); I.keys?.clear?.(); I.modal = true;
  const bal = h('span', {}, '');
  el.append(h('div', { class: 'gh' }, h('b', {}, title), bal, h('button', { 'aria-label': 'Close', onclick: close }, '×')));
  if (sub) el.append(h('div', { class: casino ? 'cnote' : 'note', style: casino ? 'padding:4px 14px 0' : '' }, sub));
  const body = h('div', { class: casino ? 'cbody' : '' }); el.append(body);
  const setMoney = (v) => { bal.textContent = `${money(v)} cr`; };
  setMoney(I.app?.you?.money ?? 0);
  return { body, setMoney };
}
const send = (I, game, op, extra = {}) => I.app.net?.action('casino', { game, op, ...extra });
const ev = (I, text, kind = 'info') => I.app?.hud?.event?.({ kind, text });

/** Entry point of iv2interact: the hotspot kind is `v:<kind>`. */
export function openVenue(I, hs) {
  const kind = String(hs.kind).slice(2), app = I.app, cls = app.you?.ship?.cls || I.builtCls;
  app.games = { onMessage, close, isOpen };
  close();
  if (['roulette', 'blackjack', 'poker', 'slots', 'baccarat'].includes(kind)) return openCasino(I, kind, cls);
  if (kind === 'guest') return openGuest(I, cls);
  const menu = menuFor(cls, kind);
  if (!menu) { ev(I, 'This place is closed.', 'warn'); return; }
  return openMenu(I, kind, menu);
}
export function onMessage(m) { if (cur?.onMsg) cur.onMsg(m); }

// ------------------------------------------------------------------------------------------------ venues with a menu
function openMenu(I, kind, menu) {
  const U = mount(I, menu.title, menu.lines[0] || ''), out = h('div', { class: 'msg' }), list = h('div', { class: 'row' });
  const stars = h('div', { class: 'note' });
  U.body.append(list, out, stars);
  const guestLine = (g) => { if (g) stars.textContent = `Guest rating ${g.stars.toFixed(1)} / 5 · fares ×${g.payMul}`; };
  guestLine(I.app.you?.guest);
  const run = (opt, score) => I.app.net?.action('venue', { kind, option: opt.id, ...(score != null ? { score } : {}) });
  for (const o of menu.options) {
    list.append(h('button', { onclick: async () => {
      if (o.cost > (I.app.you?.money ?? 0)) { out.textContent = `That costs ${o.cost} cr.`; return; }
      let score = null;
      if (o.game === 'timing') score = await timingGame(U.body); else if (o.game === 'reaction') score = await reactionGame(U.body);
      if (score === 'x') return;
      run(o, score);
    } }, o.cost ? `${o.label} · ${o.cost} cr` : o.label));
  }
  cur = { I, kind, onMsg(m) {
    if (m.t !== 'venue' || m.kind !== kind) return;
    U.setMoney(m.money); out.textContent = m.text || ''; out.style.color = m.ok ? '#bfe8c8' : '#ffb0a0'; guestLine(m.guest);
    if (m.ok && m.score != null) out.textContent += ` Score ${m.score}.`;
    if (m.ok) { const o = menu.options.find((q) => q.id === m.option); if (o?.ride) ride(I, kind); }
  } };
}
/** Slide / zip line: a short camera ride (the climb animation of iv2interact, twice) and back to where the captain stood. */
function ride(I, kind) {
  const from = { x: I.st.x, y: I.y, z: I.st.z }, up = { x: from.x, y: from.y + (kind === 'zip' ? 5 : 8), z: from.z };
  close(); I.modal = true;
  const leg = (a, b, dur) => new Promise((res) => { I.climb = { from: { ...a }, to: { ...b }, t: 0, dur, label: '' }; const w = () => { if (I.climb) requestAnimationFrame(w); else res(); }; w(); });
  leg(from, up, 2.2).then(() => leg(up, from, kind === 'zip' ? 3.4 : 3.8)).then(() => { I.modal = false; ev(I, kind === 'zip' ? 'Whoooosh! You hang up your harness.' : 'Splash! You come out laughing at the bottom.'); });
}
/** Timing mini game: a marker sweeps a bar three times; stop it in the green. → average score 0..100 ('x' when closed). */
function timingGame(body) {
  return new Promise((resolve) => {
    const box = h('div', {}), bar = h('div', { class: 'bar' }, h('i', { style: 'left:40%;width:20%;background:#2d7a52' }), h('i', { class: 'mk', style: 'left:0;width:4px;background:#fff' })), mk = bar.querySelector('.mk');
    const btn = h('button', { class: 'gold' }, 'Now!'), info = h('div', { class: 'note' }, 'Stop the marker in the green. Three tries.');
    box.append(info, bar, btn); body.append(box);
    let t = 0, tries = [], raf = 0, last = performance.now(), dir = 1, pos = 0;
    const step = (now) => { const dt = (now - last) / 1000; last = now; pos += dir * dt * (0.9 + 0.35 * tries.length); if (pos > 1) { pos = 1; dir = -1; } if (pos < 0) { pos = 0; dir = 1; } mk.style.left = `${pos * 96}%`; raf = requestAnimationFrame(step); t += dt; };
    raf = requestAnimationFrame(step);
    const done = (v) => { cancelAnimationFrame(raf); box.remove(); resolve(v); };
    btn.addEventListener('click', () => { tries.push(Math.max(0, 100 - Math.abs(pos - 0.5) * 400)); info.textContent = `Try ${tries.length}: ${Math.round(tries.at(-1))}`; if (tries.length >= 3) done(Math.round(tries.reduce((a, b) => a + b, 0) / 3)); });
    if (cur) cur.stop = () => done('x');
  });
}
/** Reaction mini game: eight targets light up one after another on a 4 × 3 board; tap them fast. → score 0..100. */
function reactionGame(body) {
  return new Promise((resolve) => {
    const box = h('div', {}), grid = h('div', { style: 'display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:8px 0' }), info = h('div', { class: 'note' }, 'Tap the lit target.');
    const cells = Array.from({ length: 12 }, () => h('button', { style: 'min-height:52px' }, ''));
    cells.forEach((c) => grid.append(c)); box.append(info, grid); body.append(box);
    let n = 0, lit = -1, t0 = 0, total = 0, timer = 0;
    const done = (v) => { clearTimeout(timer); box.remove(); resolve(v); };
    const next = () => { if (n >= 8) { done(Math.round(total / 8)); return; } cells.forEach((c) => c.classList.remove('on')); lit = Math.floor(Math.random() * 12); cells[lit].classList.add('on'); t0 = performance.now(); n++; timer = setTimeout(() => { total += 0; next(); }, 1600); };
    cells.forEach((c, i) => c.addEventListener('click', () => { if (i !== lit) return; clearTimeout(timer); total += Math.max(0, 100 - (performance.now() - t0) / 14); info.textContent = `${n} / 8`; next(); }));
    cur = { ...(cur || {}), stop: () => done('x') }; next();
  });
}

// ------------------------------------------------------------------------------------------------ guest services
function openGuest(I, cls) {
  const U = mount(I, 'Guest services', 'What the guests think of the ship, and what it does to the pay of your cruises.');
  const draw = (g) => {
    U.body.textContent = '';
    if (!g) { U.body.append(h('div', { class: 'msg' }, 'This ship carries no guests.')); return; }
    const full = Math.floor(g.stars), half = g.stars - full >= 0.5;
    U.body.append(h('div', { class: 'stars' }, '★'.repeat(full) + (half ? '½' : '') + '☆'.repeat(5 - full - (half ? 1 : 0)), h('span', { class: 'note' }, `  ${g.stars.toFixed(1)} / 5`)));
    U.body.append(h('div', { class: 'note' }, `Cruise fares ×${g.payMul} · onboard spending ×${g.spendMul}`));
    const P = [['Attractions', g.parts.variety], ['Crew service', g.parts.staff], ['Hull', g.parts.hull], ['The captain seen about', g.parts.attention]];
    for (const [n, v] of P) U.body.append(h('div', { class: 'note' }, `${n} ${Math.round(v * 100)} %`), h('div', { class: 'bar' }, h('i', { style: `left:0;width:${Math.round(v * 100)}%;background:#2d7a52` })));
    const w = g.groups.filter((q) => q.cover < 1); if (w.length) U.body.append(h('div', { class: 'note' }, `Short of: ${w.map((q) => `${q.group} ${q.have}/${q.want}`).join(', ')}`));
    for (const t of g.tips) U.body.append(h('div', { class: 'note' }, `• ${t}`));
  };
  draw(I.app.you?.guest || guestScore({ cls, cond: I.app.you?.cond ?? 100 }));
  I.app.net?.action('venue', { kind: 'guest', option: 'rating' });
  cur = { I, onMsg(m) { if (m.t === 'venue' && m.kind === 'guest') { U.setMoney(m.money); draw(m.guest); } } };
}

// ------------------------------------------------------------------------------------------------ casino
// Each table is its own module (canvas art, animations, sound cues), fetched when the table is used and dropped with the panel; the
// server's answer is the only thing that decides what the table shows (see iv2roulette.js, iv2cards.js, iv2slots.js).
const TABLE_MODULES = { roulette: ['./iv2roulette.js', 'create'], blackjack: ['./iv2cards.js', 'blackjack'], baccarat: ['./iv2cards.js', 'baccarat'], poker: ['./iv2cards.js', 'poker'], slots: ['./iv2slots.js', 'create'] };
async function openCasino(I, game, cls) {
  const lim = tableLimits(cls);
  if (!lim) { ev(I, 'This ship has no casino.', 'warn'); return; }
  const NAMES = { roulette: 'Roulette', blackjack: 'Blackjack', poker: "Texas Hold'em", slots: 'Saltline Sevens', baccarat: 'Baccarat' };
  const { THEME_CSS } = await import('./iv2casinoui.js');   // the theme and helpers of the tables: fetched with the first table
  const U = mount(I, NAMES[game], `Limits ${money(lim.min)}–${money(lim.max)} cr · credits only · the house keeps a small edge: play for fun, take a break when it stops being fun.`, true, THEME_CSS);
  const msg = h('div', { class: 'msg' }), pending = { busy: false }, queue = [];
  const chips = [lim.min, lim.min * 2, lim.min * 5, lim.min * 10, lim.min * 25, lim.min * 100].filter((v, i, a) => v <= lim.max && a.indexOf(v) === i);
  const S = { chip: chips[0], U, msg, lim, I, game, chips, pending, balance: I.app.you?.money ?? 0, last: null,
    say(text, good) { msg.textContent = text || ''; msg.style.color = good === true ? '#bfe8c8' : good === false ? '#ffb8a0' : '#f4ecd2'; },
    send: (op, extra) => send(I, game, op, extra) };
  let impl = null, alive = true;
  const dispatch = (m) => {
    pending.busy = false;
    if (m.ok === false) { S.say(m.text || 'Refused.', false); U.setMoney(m.money); impl?.refused?.(m); return; }
    if (m.cool > 0) S.say(`Cooling-off: ${Math.ceil(m.cool / 60)} min.`, false);
    if (!m.view) { U.setMoney(m.money); return; }   // limits / sync with no round open
    impl.onResult(m);
  };
  cur = { I, onMsg(m) { if (m.t !== 'casino' || m.game !== game) return; if (impl) dispatch(m); else queue.push(m); }, stop() { alive = false; impl?.stop?.(); } };
  try {
    const [file, fn] = TABLE_MODULES[game], mod = await import(file);
    if (!alive) return;
    const UI = await import('./iv2casinoui.js');
    if (!alive) return;
    impl = mod[fn](S); U.body.append(msg); void UI;
    for (const m of queue.splice(0)) dispatch(m);
  } catch (e) { console.warn('[casino]', e); close(); ev(I, 'The table is closed.', 'warn'); return; }
  send(I, game, 'limits');
}
void MENUS; void rankOf; void colourOf; void cardName; void SYMBOLS; void LINES; void RED; void coverOf;
