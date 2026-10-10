// Interiors v2 — the card tables (docs/CRUISE-CONTRACT.md §7): blackjack, baccarat and Texas hold'em on a felt table with a dealer, guests in their
// seats, properly drawn cards (pips, court cards, a card back), dealing / flipping / sliding animations, chips that move to the pot or the
// player, and an action bar. Procedural canvas art only. Every card shown is a card the server dealt: the animation is a function of the
// server's view (hole cards stay face down until the server sends them). Loaded when the first card table is used.
import { GOLD, GOLD2, GOLD3, E, clamp, lerp, h, T, money, drawChip, drawStack, stage, chipBar, quickToggle, sfx, rr, glowText, banner, short, chipColour } from './iv2casinoui.js';
import { rankOf, suitOf, handValue } from '../../shared/casino.js';

const RANK = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'], SUIT = ['♠', '♥', '♦', '♣'];
const RED = (s) => s === 1 || s === 2;
// pip layouts of the number cards: [x, y] in 0..1 of the pip area, y > 0.5 pips are drawn upside down
const PIPS = { 1: [[0.5, 0.5]], 2: [[0.5, 0.12], [0.5, 0.88]], 3: [[0.5, 0.12], [0.5, 0.5], [0.5, 0.88]], 4: [[0.25, 0.12], [0.75, 0.12], [0.25, 0.88], [0.75, 0.88]], 5: [[0.25, 0.12], [0.75, 0.12], [0.5, 0.5], [0.25, 0.88], [0.75, 0.88]],
  6: [[0.25, 0.12], [0.75, 0.12], [0.25, 0.5], [0.75, 0.5], [0.25, 0.88], [0.75, 0.88]], 7: [[0.25, 0.12], [0.75, 0.12], [0.5, 0.31], [0.25, 0.5], [0.75, 0.5], [0.25, 0.88], [0.75, 0.88]],
  8: [[0.25, 0.12], [0.75, 0.12], [0.5, 0.31], [0.25, 0.5], [0.75, 0.5], [0.5, 0.69], [0.25, 0.88], [0.75, 0.88]], 9: [[0.25, 0.12], [0.75, 0.12], [0.25, 0.37], [0.75, 0.37], [0.5, 0.5], [0.25, 0.63], [0.75, 0.63], [0.25, 0.88], [0.75, 0.88]],
  10: [[0.25, 0.12], [0.75, 0.12], [0.5, 0.25], [0.25, 0.37], [0.75, 0.37], [0.25, 0.63], [0.75, 0.63], [0.5, 0.75], [0.25, 0.88], [0.75, 0.88]] };
const faceCache = new Map(), backCache = new Map();
function suitPath(g, s, x, y, r) {   // ♠ ♥ ♦ ♣ as vector paths (a font could be missing on a phone)
  const heart = (flip) => { g.moveTo(x, y + flip * r * 0.95); g.bezierCurveTo(x - r * 1.45, y + flip * r * 0.05, x - r * 0.85, y - flip * r * 1.0, x, y - flip * r * 0.35); g.bezierCurveTo(x + r * 0.85, y - flip * r * 1.0, x + r * 1.45, y + flip * r * 0.05, x, y + flip * r * 0.95); g.closePath(); };
  g.beginPath();
  if (s === 1) heart(1);
  else if (s === 2) { g.moveTo(x, y - r * 1.05); g.lineTo(x + r * 0.78, y); g.lineTo(x, y + r * 1.05); g.lineTo(x - r * 0.78, y); g.closePath(); }
  else if (s === 0) { heart(-1); g.moveTo(x, y + r * 0.2); g.lineTo(x + r * 0.42, y + r * 1.05); g.lineTo(x - r * 0.42, y + r * 1.05); g.closePath(); }
  else { const q = r * 0.46; for (const [cx, cy] of [[0, -r * 0.5], [-r * 0.55, r * 0.22], [r * 0.55, r * 0.22]]) { g.moveTo(x + cx + q, y + cy); g.arc(x + cx, y + cy, q, 0, Math.PI * 2); } g.moveTo(x, y); g.lineTo(x + r * 0.3, y + r * 1.05); g.lineTo(x - r * 0.3, y + r * 1.05); g.closePath(); }
  g.fill();
}
function court(g, w, hh, rank, red) {   // J Q K: a gold-framed panel with a figure, mirrored top and bottom
  const px = w * 0.16, py = hh * 0.12, pw = w - px * 2, ph = hh - py * 2;
  g.save(); rr(g, px, py, pw, ph, 4); g.clip(); const bg = g.createLinearGradient(px, py, px + pw, py + ph); bg.addColorStop(0, red ? '#f6d9d0' : '#d9e2f0'); bg.addColorStop(0.5, '#fbf3d8'); bg.addColorStop(1, red ? '#f6d9d0' : '#d9e2f0'); g.fillStyle = bg; g.fillRect(px, py, pw, ph);
  const robe = red ? '#b3282d' : '#1f3a74', trim = '#d9b45a';
  for (const flip of [0, 1]) {
    g.save(); g.translate(px + pw / 2, py + ph / 2); if (flip) g.rotate(Math.PI); g.translate(0, -ph * 0.04);
    const u = pw * 0.5;   // figure unit
    g.fillStyle = robe; g.beginPath(); g.moveTo(-u, ph * 0.46); g.quadraticCurveTo(-u * 0.9, ph * 0.1, -u * 0.32, ph * 0.04); g.lineTo(u * 0.32, ph * 0.04); g.quadraticCurveTo(u * 0.9, ph * 0.1, u, ph * 0.46); g.closePath(); g.fill();
    g.fillStyle = trim; g.fillRect(-u * 0.06, ph * 0.05, u * 0.12, ph * 0.4); g.fillStyle = '#f4efe6'; g.beginPath(); g.ellipse(0, ph * 0.04, u * 0.45, ph * 0.045, 0, 0, 7); g.fill();   // collar
    g.fillStyle = '#f0c9a0'; g.beginPath(); g.ellipse(0, -ph * 0.07, u * 0.3, ph * 0.1, 0, 0, 7); g.fill();
    g.fillStyle = '#333'; g.fillRect(-u * 0.14, -ph * 0.085, u * 0.06, ph * 0.016); g.fillRect(u * 0.08, -ph * 0.085, u * 0.06, ph * 0.016);
    if (rank === 12) { g.fillStyle = '#7a4a1a'; g.beginPath(); g.ellipse(0, -ph * 0.015, u * 0.22, ph * 0.05, 0, 0, Math.PI); g.fill(); }
    if (rank === 11) { g.fillStyle = '#e8c868'; g.beginPath(); g.ellipse(0, -ph * 0.17, u * 0.34, ph * 0.045, 0, 0, 7); g.fill(); g.fillStyle = '#7a4a1a'; g.beginPath(); g.moveTo(-u * 0.3, -ph * 0.16); g.lineTo(0, -ph * 0.3); g.lineTo(u * 0.3, -ph * 0.16); g.fill(); }
    else { g.fillStyle = trim; g.beginPath(); g.moveTo(-u * 0.32, -ph * 0.15); g.lineTo(-u * 0.38, -ph * 0.3); g.lineTo(-u * 0.16, -ph * 0.22); g.lineTo(0, -ph * 0.34); g.lineTo(u * 0.16, -ph * 0.22); g.lineTo(u * 0.38, -ph * 0.3); g.lineTo(u * 0.32, -ph * 0.15); g.closePath(); g.fill(); g.fillStyle = '#c0272d'; g.beginPath(); g.arc(0, -ph * 0.2, u * 0.05, 0, 7); g.fill(); }
    g.restore();
  }
  g.restore(); g.strokeStyle = trim; g.lineWidth = 1.5; rr(g, px, py, pw, ph, 4); g.stroke();
}
function faceOf(c, w) {
  const key = `${c}|${w}`; if (faceCache.has(key)) return faceCache.get(key);
  const hh = Math.round(w * 1.4), cv = document.createElement('canvas'); cv.width = w; cv.height = hh; const g = cv.getContext('2d'), r = rankOf(c), s = suitOf(c), col = RED(s) ? '#c0272d' : '#15181d';
  rr(g, 0.5, 0.5, w - 1, hh - 1, w * 0.09); const gr = g.createLinearGradient(0, 0, w, hh); gr.addColorStop(0, '#ffffff'); gr.addColorStop(1, '#e9e5d8'); g.fillStyle = gr; g.fill(); g.strokeStyle = '#9a9588'; g.lineWidth = 1; g.stroke();
  g.fillStyle = col; g.font = `800 ${w * 0.26}px Georgia,serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const flip of [0, 1]) { g.save(); if (flip) { g.translate(w, hh); g.rotate(Math.PI); } g.fillText(RANK[r], w * 0.17, hh * 0.1); suitPath(g, s, w * 0.17, hh * 0.2, w * 0.075); g.restore(); }
  if (r >= 10) court(g, w, hh, r, RED(s));
  else if (r === 0) { suitPath(g, s, w / 2, hh / 2, w * 0.3); }
  else { const pip = PIPS[r + 1], ax = w * 0.27, ay = hh * 0.16, aw = w * 0.46, ah = hh * 0.68; for (const [px, py] of pip) { g.save(); const x = ax + px * aw, y = ay + py * ah; g.translate(x, y); if (py > 0.5) g.rotate(Math.PI); suitPath(g, s, 0, 0, w * 0.115); g.restore(); } }
  if (r >= 10) { suitPath(g, s, w * 0.17, hh * 0.3, w * 0.06); }
  faceCache.set(key, cv); return cv;
}
function backOf(w) {
  if (backCache.has(w)) return backCache.get(w);
  const hh = Math.round(w * 1.4), cv = document.createElement('canvas'); cv.width = w; cv.height = hh; const g = cv.getContext('2d');
  rr(g, 0.5, 0.5, w - 1, hh - 1, w * 0.09); g.fillStyle = '#f2ecd8'; g.fill(); g.strokeStyle = '#8a8470'; g.stroke();
  const m = w * 0.07; rr(g, m, m, w - 2 * m, hh - 2 * m, w * 0.06); g.clip(); const gr = g.createLinearGradient(0, 0, w, hh); gr.addColorStop(0, '#1b3f7a'); gr.addColorStop(1, '#0b1d40'); g.fillStyle = gr; g.fillRect(0, 0, w, hh);
  g.strokeStyle = '#d9b45a88'; g.lineWidth = 1; const st = w * 0.16; for (let i = -hh; i < w + hh; i += st) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + hh, hh); g.stroke(); g.beginPath(); g.moveTo(i + hh, 0); g.lineTo(i, hh); g.stroke(); }
  g.fillStyle = '#0b1d40'; g.beginPath(); g.ellipse(w / 2, hh / 2, w * 0.24, w * 0.3, 0, 0, 7); g.fill(); g.strokeStyle = '#f6e3a1'; g.lineWidth = 2; g.stroke();
  g.fillStyle = '#f6e3a1'; g.font = `700 ${w * 0.3}px Georgia,serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('⚓', w / 2, hh / 2 + w * 0.02);
  backCache.set(w, cv); return cv;
}
/** One card on the table: slides from `from` to `to` (after `delay`), turns over when turn() is called (or is born face up). */
class Card {
  constructor(c, from, to, delay, up) { this.c = c; this.x = from.x; this.y = from.y; this.x0 = from.x; this.y0 = from.y; this.tx = to.x; this.ty = to.y; this.t = -delay; this.dur = T(0.45); this.up = !!up; this.sx = 1; this.turnT = null; this.rot = (Math.random() - 0.5) * 0.4; this.rot0 = 1.2; this.r = this.rot0; this.played = false; this.k = 1; }
  moveTo(p, delay = 0) { this.x0 = this.x; this.y0 = this.y; this.tx = p.x; this.ty = p.y; this.t = -delay; this.rot0 = this.rot; this.played = false; }
  turn(c, delay = 0) { if (c !== undefined) this.c = c; this.turnT = -delay; }
  get active() { return this.t < this.dur || this.turnT !== null; }
  update(dt, S) {
    this.t += dt;
    if (this.t >= 0) { const u = clamp(this.t / this.dur, 0, 1), e = E.out(u); this.x = lerp(this.x0, this.tx, e); this.y = lerp(this.y0, this.ty, e) - Math.sin(u * Math.PI) * 14; this.r = lerp(this.rot0, this.rot, e); if (!this.played) { this.played = true; sfx(S, 'card', 0.8); } }
    if (this.turnT !== null) { this.turnT += dt; if (this.turnT >= 0) { const u = clamp(this.turnT / T(0.3), 0, 1); this.sx = Math.max(0.04, Math.abs(Math.cos(u * Math.PI))); this.faceNow = u > 0.5; if (this.turnT === dt || !this.flipSound) { this.flipSound = true; sfx(S, 'card', 0.6); } if (u >= 1) { this.up = true; this.turnT = null; this.sx = 1; this.faceNow = undefined; } } }
  }
  draw(g, w) {
    if (this.t < 0) return;
    const face = this.faceNow ?? this.up, cv = face ? faceOf(this.c, w) : backOf(w), hh = w * 1.4;
    g.save(); if (this.k !== 1) { g.translate(this.x, this.y); g.scale(this.k, this.k); g.translate(-this.x, -this.y); } g.translate(this.x, this.y); g.rotate(this.r || 0); g.scale(this.sx, 1);
    g.fillStyle = '#0006'; rr(g, -w / 2 + 3, -hh / 2 + 5, w, hh, w * 0.09); g.fill();
    g.drawImage(cv, -w / 2, -hh / 2, w, hh); g.restore();
  }
}
const need = (stg) => { stg.wake(); };

// ------------------------------------------------------------------------------------------------ the table scene
function felt(g, w, hh, text, sub, portrait, ty = null, arc = true) {
  let gr = g.createLinearGradient(0, 0, 0, hh); gr.addColorStop(0, '#1a0f08'); gr.addColorStop(1, '#0a0604'); g.fillStyle = gr; g.fillRect(0, 0, w, hh);
  // padded leather rail and felt
  rr(g, 4, 4, w - 8, hh - 8, 26); gr = g.createLinearGradient(0, 0, 0, hh); gr.addColorStop(0, '#3a1f12'); gr.addColorStop(1, '#1c0e07'); g.fillStyle = gr; g.fill(); g.strokeStyle = GOLD3; g.lineWidth = 2; g.stroke();
  rr(g, 16, 16, w - 32, hh - 32, 20); gr = g.createRadialGradient(w / 2, hh * 0.45, 20, w / 2, hh * 0.5, Math.max(w, hh) * 0.75); gr.addColorStop(0, '#13845c'); gr.addColorStop(0.6, '#0a4f38'); gr.addColorStop(1, '#042d21'); g.fillStyle = gr; g.fill();
  g.save(); rr(g, 16, 16, w - 32, hh - 32, 20); g.clip(); g.fillStyle = '#ffffff07'; for (let y = 16; y < hh; y += 3) g.fillRect(16, y, w - 32, 1); g.restore();
  if (arc) { g.strokeStyle = '#d9b45acc'; g.lineWidth = 2; g.beginPath(); g.ellipse(w / 2, hh * 0.46, w * 0.36, hh * 0.3, 0, 0.1 * Math.PI, 0.9 * Math.PI); g.stroke(); }
  g.fillStyle = '#d9b45acc'; g.font = `700 ${Math.max(11, w * (portrait ? 0.045 : 0.026))}px Georgia,serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
  const y0 = ty ?? (portrait ? 0.43 : 0.455); g.fillText(text, w / 2, hh * y0); g.font = `600 ${Math.max(9, w * (portrait ? 0.03 : 0.017))}px Georgia,serif`; g.fillStyle = '#d9b45a99'; g.fillText(sub, w / 2, hh * (y0 + 0.04));
}
function avatar(g, x, y, s, skin, suit, name, sub, folded) {
  g.save(); g.translate(x, y); g.globalAlpha = folded ? 0.45 : 1;
  const gr = g.createLinearGradient(0, -s, 0, s); gr.addColorStop(0, suit); gr.addColorStop(1, '#10151a');
  g.fillStyle = gr; g.beginPath(); g.moveTo(-s * 1.1, s * 0.9); g.quadraticCurveTo(-s * 1.0, s * 0.1, -s * 0.35, -s * 0.05); g.lineTo(s * 0.35, -s * 0.05); g.quadraticCurveTo(s * 1.0, s * 0.1, s * 1.1, s * 0.9); g.closePath(); g.fill();
  g.fillStyle = '#f4efe6'; g.beginPath(); g.moveTo(-s * 0.3, -s * 0.05); g.lineTo(0, s * 0.45); g.lineTo(s * 0.3, -s * 0.05); g.fill();
  g.fillStyle = skin; g.beginPath(); g.ellipse(0, -s * 0.55, s * 0.36, s * 0.42, 0, 0, 7); g.fill(); g.fillStyle = '#00000044'; g.beginPath(); g.ellipse(0, -s * 0.78, s * 0.38, s * 0.24, 0, Math.PI, 0); g.fill();
  g.restore();
  g.fillStyle = '#f6e3a1'; g.font = `700 ${Math.max(10, s * 0.38)}px Georgia,serif`; g.textAlign = 'center'; g.fillText(name, x, y + s * 1.25); if (sub) { g.font = `600 ${Math.max(9, s * 0.3)}px system-ui`; g.fillStyle = '#cfe3d9'; g.fillText(sub, x, y + s * 1.6); }
}
const SKINS = ['#e8b98f', '#c68e63', '#f0c9a0', '#9a6640'];

// ------------------------------------------------------------------------------------------------ common machinery
function base(S, title, sub) {
  const { U } = S, stg = stage(U.body, { aspect: 0.62, portraitAspect: 1.3, label: title }), V = { cards: [], flying: [], banner: -1, shoe: { x: 0, y: 0 } };
  const cw = () => Math.round(clamp(stg.w * (stg.portrait ? (title === 'poker' ? 0.14 : 0.16) : 0.09), 42, 86));
  const upd = (dt) => { for (const c of V.cards) c.update(dt, S); for (const f of V.flying) f.t += dt; V.flying = V.flying.filter((f) => f.t < f.dur + 0.05); if (V.banner >= 0) V.banner += dt; };
  const busy = () => V.cards.some((c) => c.active) || V.flying.length > 0 || (V.banner >= 0 && V.banner < 3.2);
  stg.idle = () => !busy();
  const drawFly = (g) => { for (const f of V.flying) { const u = clamp((f.t) / f.dur, 0, 1); if (f.t < 0) continue; const e = E.io(u); drawStack(g, lerp(f.a.x, f.b.x, e), lerp(f.a.y, f.b.y, e) - Math.sin(u * Math.PI) * 26, f.r, f.amt, S.chips); if (u >= 1 && !f.done) { f.done = true; sfx(S, 'chip'); } } };
  const fly = (a, b, amt, delay = 0, r = 14) => { V.flying.push({ a, b, amt, t: -delay, dur: T(0.7), r }); stg.wake(); };
  const win = (net, text, sub) => { V.banner = 0; V.bt = text; V.bs = sub; V.bg = net >= 0; sfx(S, net > 0 ? (net >= S.lim.min * 25 ? 'big' : 'win') : net < 0 ? 'lose' : 'chip'); if (net > 0) { stg.particles.burst(stg.w / 2, stg.h * 0.5, 36, { speed: 260 }); if (net >= S.lim.min * 25) { stg.particles.confetti(stg.w); stg.particles.coins(stg.w, 40); } } stg.wake(); };
  return { stg, V, cw, upd, drawFly, fly, win, title, sub };
}
function actionBar(S) { return h('div', { class: 'abar' }); }

// ------------------------------------------------------------------------------------------------ blackjack
export function blackjack(S) {
  const B = base(S, 'blackjack', ''), { stg, V } = B; let bet = S.chips[0], hands = [], dealer = {}, over = null;
  const spots = () => { const c = B.cw(), p = stg.portrait; return { shoe: { x: stg.w * 0.86, y: stg.h * 0.14 }, dealer: (j) => ({ x: stg.w / 2 + (j - 0.5) * c * 0.55, y: stg.h * (p ? 0.17 : 0.19) }), hand: (i, n, j) => ({ x: stg.w * (n === 1 ? 0.5 : i === 0 ? 0.3 : 0.7) + (j - 1) * c * 0.5, y: stg.h * (p ? 0.7 : 0.69) - j * 5 }), bet: (i, n) => ({ x: stg.w * (n === 1 ? 0.5 : i === 0 ? 0.3 : 0.7), y: stg.h * (p ? 0.9 : 0.91) }), out: { x: stg.w / 2, y: -40 }, purse: { x: stg.w * 0.12, y: stg.h * 0.93 } }; };
  stg.draw = (g, w, hh, dt) => {
    B.upd(dt); felt(g, w, hh, 'BLACKJACK PAYS 3 TO 2', 'Dealer must stand on all 17s', stg.portrait);
    avatar(g, w * (stg.portrait ? 0.18 : 0.27), hh * 0.2, Math.min(w, hh) * 0.085, SKINS[2], '#3a1f4a', 'Dealer', '', false);
    const sp = spots(); g.fillStyle = '#0006'; rr(g, sp.shoe.x - 30, sp.shoe.y - 22, 60, 44, 6); g.fill(); g.strokeStyle = GOLD3; g.stroke();
    for (const c of V.cards) c.draw(g, B.cw());
    // bets
    hands.forEach((hd, i) => { const p = sp.bet(i, hands.length); if (hd.bet) { drawStack(g, p.x, p.y, 15, hd.bet, S.chips); g.fillStyle = '#fff'; g.font = '700 12px system-ui'; g.textAlign = 'center'; g.fillText(`${short(hd.bet)}`, p.x, p.y + 24); } if (hd.value) { g.fillStyle = '#000a'; rr(g, p.x - 22, sp.hand(i, hands.length, 0).y + B.cw() * 0.8, 44, 22, 11); g.fill(); g.fillStyle = hd.value > 21 ? '#ff9a8a' : '#f6e3a1'; g.font = '800 14px Georgia,serif'; g.textAlign = 'center'; g.fillText(hd.value, p.x, sp.hand(i, hands.length, 0).y + B.cw() * 0.8 + 11); } });
    if (dealer.value && over) { g.fillStyle = '#000a'; rr(g, w / 2 - 22, hh * 0.19 + B.cw() * 0.8, 44, 22, 11); g.fill(); g.fillStyle = '#f6e3a1'; g.font = '800 14px Georgia,serif'; g.textAlign = 'center'; g.fillText(dealer.value, w / 2, hh * 0.19 + B.cw() * 0.8 + 11); }
    B.drawFly(g); if (V.banner >= 0) banner(g, w, hh * 0.9, V.bt, V.bs, V.banner, V.bg);
  };
  // bar
  const bar = h('div', { class: 'abar' }), chips = chipBar(S, (v) => { bet = v; label(); });
  const label = () => { betLabel.textContent = `Bet ${money(bet)} cr`; };
  const betLabel = h('div', { class: 'cnote', style: 'text-align:center' }), deal = h('button', { class: 'gold', onclick: () => { if (S.pending.busy) return; S.pending.busy = true; reset(); S.send('deal', { bet }); } }, 'Deal');
  const reset = () => { V.cards = []; hands = []; dealer = {}; over = null; V.banner = -1; V.flying = []; };
  S.U.body.append(h('div', { class: 'cnote', style: 'text-align:center' }, 'Table limits and house edge are posted; the dealer never cheats: the server deals.'), chips, betLabel, bar, quickToggle()); label();
  const showBar = (opts, done) => { bar.textContent = ''; if (done || !opts.length) { bar.append(deal); return; } for (const o of opts) bar.append(h('button', { class: o === 'stand' ? '' : 'gold', onclick: () => { if (S.pending.busy) return; S.pending.busy = true; S.send(o); } }, o)); };
  bar.append(deal);
  return {
    onResult(m) {
      const v = m.view, done = v.phase === 'done', sp = spots(), first = !hands.length && !dealer.cards; let n = 0; const D = T(0.32);
      dealer.cards ||= [];
      // the dealer: the up card (and a face-down hole card) at the deal, the hole card turned and the draws at the end
      if (done && dealer.hole) { dealer.cards[1] = dealer.hole; dealer.hole.turn(v.dealer[1], 0); dealer.hole = null; }
      v.dealer.forEach((c, j) => { if (dealer.cards[j]) return; const cd = new Card(c, sp.shoe, sp.dealer(j), first ? D * (j ? 3 : 1) : (n++) * T(0.5) + T(0.6), true); dealer.cards[j] = cd; V.cards.push(cd); });
      if (!done && !dealer.hole && !dealer.cards[1]) { dealer.hole = new Card(0, sp.shoe, sp.dealer(1), first ? D * 3 : 0, false); V.cards.push(dealer.hole); }
      // the player's hands: cards the server dealt, in the order it dealt them (a split moves the second card to its own hand)
      const pool = hands.flatMap((hd) => hd.cards || []);
      if (v.hands.length !== hands.length) hands = v.hands.map(() => ({ cards: [], bet: 0, value: 0 }));
      v.hands.forEach((hd, i) => {
        const H = hands[i]; H.bet = hd.bet; H.value = hd.value;
        hd.cards.forEach((c, j) => {
          const to = sp.hand(i, v.hands.length, j), cur = H.cards[j];
          if (cur && cur.c === c) { cur.moveTo(to, 0); return; }
          const k = pool.findIndex((q) => q.c === c); let cd;
          if (k >= 0) { cd = pool.splice(k, 1)[0]; cd.moveTo(to, (n++) * T(0.2)); } else { cd = new Card(c, sp.shoe, to, first ? D * (j ? 2 : 0) : (n++) * T(0.4), true); V.cards.push(cd); }
          H.cards[j] = cd;
        });
        H.cards.length = hd.cards.length;
      });
      over = done ? v : null; dealer.value = done ? v.dealerValue : 0; stg.wake();
      showBar(done ? [] : v.options, done);
      if (done) {
        const net = m.net, delay = T(1.0 + 0.6 * Math.max(0, v.dealer.length - 1)); setTimeout(() => {
          v.hands.forEach((hd, i) => { const p = sp.bet(i, v.hands.length), r = v.results[i], paid = r === 'blackjack' ? hd.bet * 2.5 : r === 'win' ? hd.bet * 2 : r === 'push' ? hd.bet : 0;
            if (paid > hd.bet) B.fly({ x: p.x, y: p.y - 24 }, sp.purse, paid, 0); else if (paid === hd.bet) B.fly(p, sp.purse, paid, 0); else B.fly(p, sp.out, hd.bet, 0); });
          B.win(net, net > 0 ? (v.results.includes('blackjack') ? 'BLACKJACK!' : 'YOU WIN') : net < 0 ? 'DEALER WINS' : 'PUSH', net > 0 ? `+${money(net)} cr` : net < 0 ? `${money(net)} cr` : 'Your stake comes back'); S.U.setMoney(m.money);
        }, delay * 1000);
      } else { S.balance = m.money; S.U.setMoney(m.money); }
    },
    refused() { S.pending.busy = false; },
    stop() { stg.stop(); },
  };
}

// ------------------------------------------------------------------------------------------------ baccarat
export function baccarat(S) {
  const B = base(S, 'baccarat', ''), { stg, V } = B, stakes = { player: 0, banker: 0, tie: 0 }; let shown = null, deck = [];
  const zones = () => { const w = stg.w, hh = stg.h, p = stg.portrait; return { player: { x: w * (p ? 0.06 : 0.18), y: hh * (p ? 0.62 : 0.66), w: w * (p ? 0.28 : 0.2), h: hh * (p ? 0.14 : 0.2) }, tie: { x: w * (p ? 0.37 : 0.4), y: hh * (p ? 0.62 : 0.66), w: w * (p ? 0.26 : 0.2), h: hh * (p ? 0.14 : 0.2) }, banker: { x: w * (p ? 0.66 : 0.62), y: hh * (p ? 0.62 : 0.66), w: w * (p ? 0.28 : 0.2), h: hh * (p ? 0.14 : 0.2) } }; };
  const spot = (side, j) => { const c = B.cw(), p = stg.portrait; return { x: stg.w * (side === 'player' ? (p ? 0.3 : 0.36) : (p ? 0.7 : 0.64)) + (j - 1) * c * 0.62, y: stg.h * (p ? 0.27 : 0.3) }; };
  stg.draw = (g, w, hh, dt) => {
    B.upd(dt); felt(g, w, hh, 'BACCARAT', 'Banker pays 0.95 · Tie pays 8 to 1', stg.portrait, stg.portrait ? 0.5 : 0.5, false);
    avatar(g, w * 0.5, hh * 0.1, Math.min(w, hh) * 0.06, SKINS[0], '#4a2a1a', 'Croupier', '', false);
    g.fillStyle = '#f6e3a1'; g.font = `700 ${Math.max(11, w * 0.022)}px Georgia,serif`; g.textAlign = 'center'; g.fillText('PLAYER', w * (stg.portrait ? 0.3 : 0.36), hh * (stg.portrait ? 0.14 : 0.16)); g.fillText('BANKER', w * (stg.portrait ? 0.7 : 0.64), hh * (stg.portrait ? 0.14 : 0.16));
    const Z = zones(); for (const k of ['player', 'tie', 'banker']) { const z = Z[k]; rr(g, z.x, z.y, z.w, z.h, 12); g.fillStyle = shown && shown.outcome === k ? '#d9b45a33' : '#0003'; g.fill(); g.strokeStyle = shown && shown.outcome === k ? GOLD2 : '#d9b45acc'; g.lineWidth = shown && shown.outcome === k ? 3 : 1.5; g.stroke(); g.fillStyle = '#f6e3a1'; g.font = `700 ${Math.max(11, w * 0.02)}px Georgia,serif`; g.textAlign = 'center'; g.fillText(k.toUpperCase(), z.x + z.w / 2, z.y + z.h * 0.22); if (stakes[k]) { drawStack(g, z.x + z.w / 2, z.y + z.h * 0.62, 14, stakes[k], S.chips); g.fillStyle = '#fff'; g.font = '700 11px system-ui'; g.fillText(short(stakes[k]), z.x + z.w / 2, z.y + z.h * 0.95); } }
    for (const c of V.cards) c.draw(g, B.cw());
    if (shown) for (const side of ['player', 'banker']) { const p = spot(side, 1); g.fillStyle = '#000a'; rr(g, p.x - 22, p.y + B.cw() * 0.8, 44, 22, 11); g.fill(); g.fillStyle = '#f6e3a1'; g.font = '800 14px Georgia,serif'; g.fillText(side === 'player' ? shown.pv : shown.bv, p.x, p.y + B.cw() * 0.8 + 11); }
    B.drawFly(g); if (V.banner >= 0) banner(g, w, hh * 0.9, V.bt, V.bs, V.banner, V.bg);
  };
  stg.cv.addEventListener('pointerdown', (e) => { if (S.pending.busy) return; const r = stg.cv.getBoundingClientRect(), x = (e.clientX - r.left) * stg.w / r.width, y = (e.clientY - r.top) * stg.h / r.height, Z = zones(); for (const k of ['player', 'tie', 'banker']) { const z = Z[k]; if (x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h) { stakes[k] = Math.min(S.lim.max, stakes[k] + S.chip); sfx(S, 'chip'); stg.wake(); } } });
  const dealB = h('button', { class: 'gold', onclick: () => { const b = {}; for (const k of Object.keys(stakes)) if (stakes[k]) b[k] = stakes[k]; if (!Object.keys(b).length || S.pending.busy) return; S.pending.busy = true; V.cards = []; shown = null; V.banner = -1; S.send('deal', { bets: b }); } }, 'Deal'), clr = h('button', { class: 'red', onclick: () => { stakes.player = stakes.banker = stakes.tie = 0; stg.wake(); } }, 'Clear');
  S.U.body.append(h('div', { class: 'cnote', style: 'text-align:center' }, 'Tap Player, Tie or Banker to place the chip you chose.'), chipBar(S), h('div', { class: 'abar' }, dealB, clr), quickToggle()); void deck;
  return {
    onResult(m) {
      const v = m.view, shoe = { x: stg.w * 0.5, y: -20 }; let n = 0; V.cards = [];
      const seq = []; ['player', 'banker'].forEach((side) => v[side].slice(0, 2).forEach((c, j) => seq.push([side, j, c]))); const ordered = [seq[0], seq[2], seq[1], seq[3]];
      ordered.forEach(([side, j, c]) => { const cd = new Card(c, shoe, spot(side, j), (n++) * T(0.35), false); cd.turn(c, T(0.35) * 4 + 0.35 + j * 0.15); V.cards.push(cd); });
      ['player', 'banker'].forEach((side) => { if (v[side][2] !== undefined) { const cd = new Card(v[side][2], shoe, spot(side, 2), (n++) * T(0.35) + T(0.9), false); cd.turn(v[side][2], T(0.35) * 6 + T(0.9) + 0.4); V.cards.push(cd); } });
      stg.wake(); const end = (n + 2) * T(0.5) * 1000 + 600;
      setTimeout(() => { shown = v; const net = m.net; const Z = zones(); ['player', 'tie', 'banker'].forEach((k) => { if (!stakes[k]) return; const z = Z[k], p = { x: z.x + z.w / 2, y: z.y + z.h * 0.6 }; const won = (v.outcome === k) || (v.outcome === 'tie' && k !== 'tie'); if (v.outcome === k) B.fly(p, { x: stg.w * 0.12, y: stg.h * 0.94 }, stakes[k] * (k === 'tie' ? 9 : k === 'banker' ? 1.95 : 2)); else if (won) B.fly(p, { x: stg.w * 0.12, y: stg.h * 0.94 }, stakes[k]); else B.fly(p, { x: stg.w / 2, y: -30 }, stakes[k]); });
        B.win(net, `${v.outcome.toUpperCase()} WINS`, net > 0 ? `+${money(net)} cr` : net < 0 ? `${money(net)} cr` : 'Push'); S.U.setMoney(m.money); setTimeout(() => { stakes.player = stakes.banker = stakes.tie = 0; }, T(1.8) * 1000); }, end);
    },
    refused() { S.pending.busy = false; }, stop() { stg.stop(); },
  };
}

// ------------------------------------------------------------------------------------------------ Texas hold'em
export function poker(S) {
  const B = base(S, 'poker', ''), { stg, V } = B, NAMES = ['You', 'Anna', 'Ben', 'Carla'], SUITS = ['#2a4a7a', '#6a2a3a', '#2a5a3a']; let board = [], me = [], opp = [[], [], []], pot = 0, folded = [false, false, false, false], stageName = '', lastView = null;
  const SZ = () => Math.min(stg.w, stg.h) * (stg.portrait ? 0.075 : 0.065);
  const seatPos = (i) => { const w = stg.w, hh = stg.h, p = stg.portrait; return [{ x: w * 0.5, y: hh * (p ? 0.86 : 0.82) }, { x: w * (p ? 0.14 : 0.1), y: hh * (p ? 0.2 : 0.3) }, { x: w * (p ? 0.4 : 0.5), y: hh * (p ? 0.085 : 0.12) }, { x: w * (p ? 0.86 : 0.9), y: hh * (p ? 0.2 : 0.3) }][i]; };
  const boardPos = (j) => { const c = B.cw(); return { x: stg.w / 2 + (j - 2) * c * 1.06, y: stg.h * (stg.portrait ? 0.5 : 0.45) }; };
  const holePos = (i, j) => { const c = B.cw(), s = seatPos(i), z = SZ(); if (i === 0) return { x: s.x + (j - 0.5) * c * 0.62, y: s.y }; if (i === 2) return { x: s.x + z * 1.7 + c * 0.3 + j * c * 0.36, y: s.y + z * 0.1 }; return { x: s.x + (j - 0.5) * c * 0.36, y: s.y + z * 2.3 + c * 0.42 }; };
  stg.draw = (g, w, hh, dt) => {
    B.upd(dt); felt(g, w, hh, "TEXAS HOLD'EM", 'Limit betting · you against three guests', stg.portrait, stg.portrait ? 0.7 : 0.63);
    for (let i = 1; i < 4; i++) { const p = seatPos(i); avatar(g, p.x, p.y, SZ(), SKINS[i], SUITS[i - 1], NAMES[i], lastView ? `in ${short(lastView.in[i])}` : '', folded[i]); }
    // pot
    if (pot) { const pp = { x: w * (stg.portrait ? 0.4 : 0.74), y: hh * (stg.portrait ? 0.355 : 0.8) }; drawStack(g, pp.x, pp.y, 13, pot, S.chips); g.fillStyle = '#f6e3a1'; g.font = '800 14px Georgia,serif'; g.textAlign = 'left'; g.fillText(`POT ${money(pot)}`, pp.x + 22, pp.y + 4); }
    for (let j = 0; j < 5; j++) { const p = boardPos(j), c = B.cw(); g.strokeStyle = '#d9b45a55'; g.lineWidth = 1; rr(g, p.x - c / 2, p.y - c * 0.7, c, c * 1.4, 6); g.stroke(); }
    for (const c of V.cards) c.draw(g, B.cw());
    if (lastView && !lastView.phase !== 'x') { g.fillStyle = '#f6e3a1'; g.font = `700 ${Math.max(10, w * 0.02)}px Georgia,serif`; g.textAlign = 'center'; g.fillText(stageName.toUpperCase(), w / 2, hh * (stg.portrait ? 0.64 : 0.57)); }
    B.drawFly(g); if (V.banner >= 0) banner(g, w, hh * 0.9, V.bt, V.bs, V.banner, V.bg);
  };
  const bar = h('div', { class: 'abar' }), log = h('div', { class: 'cnote', style: 'text-align:center;min-height:16px' });
  const dealB = h('button', { class: 'gold', onclick: () => { if (S.pending.busy) return; S.pending.busy = true; V.cards = []; board = []; me = []; opp = [[], [], []]; folded = [false, false, false, false]; V.banner = -1; S.send('deal'); } }, `Deal (ante ${money(S.lim.min)})`);
  bar.append(dealB); S.U.body.append(log, bar, quickToggle());
  const NAME = ['You', 'Anna', 'Ben', 'Carla'];
  return {
    onResult(m) {
      const v = m.view, done = v.phase === 'done', shoe = { x: stg.w * 0.5, y: stg.h * 0.2 }; let n = 0; lastView = v; pot = v.pot; stageName = done ? 'showdown' : v.stage; folded = v.folded;
      if (!me.length) { v.you.forEach((c, j) => { const cd = new Card(c, shoe, holePos(0, j), (n++) * T(0.3), false); cd.turn(c, T(1.5) + j * 0.2); me.push(cd); V.cards.push(cd); }); for (let i = 1; i < 4; i++) for (let j = 0; j < 2; j++) { const cd = new Card(0, shoe, holePos(i, j), (n++) * T(0.2), false); cd.k = 0.6; opp[i - 1].push(cd); V.cards.push(cd); } }
      v.board.forEach((c, j) => { if (!board[j]) { const cd = new Card(c, shoe, boardPos(j), (n++) * T(0.28), false); cd.turn(c, (n + 1) * T(0.28) + 0.2); board[j] = cd; V.cards.push(cd); } });
      if (v.seats) v.seats.forEach((s, i) => { if (i && s) opp[i - 1].forEach((cd, j) => { if (!cd.up) cd.turn(s.cards[j], j * 0.15); }); });
      log.textContent = (v.log || []).map((l) => `${NAME[l.seat]} ${l.a}s`).join(' · ') + (v.seats ? '  —  ' + v.seats.map((s, i) => (s ? `${NAME[i]}: ${s.name}` : '')).filter(Boolean).join(' · ') : '');
      bar.textContent = ''; if (done) bar.append(dealB); else for (const o of v.options) bar.append(h('button', { class: o === 'fold' ? 'red' : o === 'check' ? '' : 'gold', onclick: () => { if (S.pending.busy) return; S.pending.busy = true; S.send(o); } }, v.costs[o] ? `${o} ${money(v.costs[o])}` : o));
      stg.wake();
      if (done) { const net = m.net; setTimeout(() => { const potP = { x: stg.w * (stg.portrait ? 0.4 : 0.74), y: stg.h * (stg.portrait ? 0.355 : 0.8) }; if (v.winners?.includes(0)) B.fly(potP, { x: stg.w * 0.12, y: stg.h * 0.94 }, v.returned || 1); else B.fly(potP, seatPos(v.winners?.[0] ?? 1), pot); B.win(net, v.winners?.includes(0) ? 'YOU WIN THE POT' : v.folded[0] ? 'YOU FOLDED' : `${NAME[v.winners?.[0] ?? 1].toUpperCase()} WINS`, net > 0 ? `+${money(net)} cr${v.rake ? ` (rake ${v.rake})` : ''}` : `${money(net)} cr`); S.U.setMoney(m.money); pot = 0; }, T(1.0) * 1000); }
      else S.U.setMoney(m.money);
    },
    refused() { S.pending.busy = false; }, stop() { stg.stop(); },
  };
}
void GOLD; void GOLD2; void glowText; void handValue; void chipColour; void actionBar; void need; void drawChip;
