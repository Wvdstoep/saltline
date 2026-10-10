// Interiors v2 — the look of the casino tables (docs/CRUISE-CONTRACT.md §7): one dark-gold / emerald theme, procedural canvas art (no
// images), particles, easing, chips, a responsive animated stage and the sound cues. Shared by iv2roulette.js, iv2cards.js and iv2slots.js,
// which are loaded one at a time when their table is used. Everything here is cosmetic: the result of a game is the server's, the
// animations only ever end on it. `quick()` (a toggle on every table, remembered) shortens the animations to a fraction.
export const GOLD = '#d9b45a', GOLD2 = '#f6e3a1', GOLD3 = '#8a6a1c', EMERALD = '#0f5a43', EMERALD2 = '#06382a', INK = '#07100d';
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const E = {
  out: (t) => 1 - (1 - t) ** 3, in: (t) => t * t * t, io: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  back: (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2; },
  bounce: (t) => { const n = 7.5625, d = 2.75; if (t < 1 / d) return n * t * t; if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75; if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375; return n * (t -= 2.625 / d) * t + 0.984375; },
};
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LS = 'saltline.casino.quick';
export const quick = () => { try { return localStorage.getItem(LS) === '1'; } catch { return false; } };
export const setQuick = (v) => { try { localStorage.setItem(LS, v ? '1' : '0'); } catch { /* private mode */ } };
/** Seconds scaled by the quick toggle. */
export const T = (s) => (quick() ? s * 0.22 : s);
export function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v); }
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
export const money = (n) => Math.floor(n).toLocaleString('en-US');

// ------------------------------------------------------------------------------------------------ theme (CSS)
export const THEME_CSS = `
#iv2Game.casino{width:min(900px,calc(100vw - 12px));padding:0;border:1px solid ${GOLD3};border-radius:16px;overflow:hidden;color:#f4ecd2;font-family:"Segoe UI",Inter,system-ui,sans-serif;
 background:radial-gradient(ellipse at 50% 0%,#12382c 0%,#07140f 60%,#030907 100%);box-shadow:0 0 0 2px #1a1408,0 0 0 3px ${GOLD3},0 18px 60px #000c}
#iv2Game.casino .gh{margin:0;padding:10px 14px;background:linear-gradient(#1a1608,#0b0905);border-bottom:1px solid ${GOLD3}}
#iv2Game.casino .gh b{font:700 18px Georgia,"Times New Roman",serif;letter-spacing:.12em;text-transform:uppercase;color:${GOLD2};text-shadow:0 0 10px #d9b45a55}
#iv2Game.casino .gh span{color:${GOLD2};font:700 15px ui-monospace,Menlo,Consolas,monospace}
#iv2Game.casino .cbody{padding:8px 10px 12px}
#iv2Game.casino .note{color:#a9c5b8}#iv2Game.casino .cnote{font-size:11px;color:#8aa89a;margin:4px 2px}
#iv2Game.casino canvas{display:block;width:100%;border-radius:12px;background:#02110b;touch-action:manipulation}
#iv2Game.casino button{border-radius:999px;font:700 13px Georgia,serif;letter-spacing:.06em;text-transform:uppercase;color:#f4ecd2;background:linear-gradient(#27493d,#10281f);border:1px solid #3d6a58;box-shadow:inset 0 1px 0 #ffffff22,0 2px 6px #0008;min-height:44px;padding:4px 16px}
#iv2Game.casino button:hover{filter:brightness(1.15)}#iv2Game.casino button:active{transform:translateY(1px)}
#iv2Game.casino button.gold{color:#2b1c00;background:linear-gradient(#f6e3a1,#d9b45a 55%,#a97e22);border:1px solid #f6e3a1;text-shadow:0 1px 0 #fff6}
#iv2Game.casino button.red{background:linear-gradient(#a33030,#5b1414);border-color:#c45}#iv2Game.casino button.on{outline:2px solid ${GOLD2};box-shadow:0 0 12px #d9b45a88}
#iv2Game.casino button[disabled]{opacity:.35;filter:grayscale(.6)}
#iv2Game.casino .abar{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin:8px 0}
#iv2Game.casino .msg{min-height:26px;text-align:center;font:700 16px Georgia,serif;letter-spacing:.04em}
#iv2Game.casino .chips{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin:6px 0}
#iv2Game.casino .chipb{width:52px;height:52px;min-width:52px;border-radius:50%;padding:0;font:800 12px system-ui;letter-spacing:0;text-transform:none;color:#fff;border:3px dashed #fffc;box-shadow:inset 0 0 0 3px var(--c),0 3px 6px #000a;background:radial-gradient(circle at 35% 30%,#fff5,transparent 45%),var(--c)}
#iv2Game.casino .chipb.on{transform:translateY(-4px) scale(1.08);outline:2px solid ${GOLD2}}
#iv2Game.casino .qk{display:flex;gap:6px;align-items:center;font-size:12px;color:#a9c5b8;justify-content:flex-end;margin-top:2px}#iv2Game.casino .qk input{width:20px;height:20px}
@media (max-width:560px){#iv2Game.casino .gh b{font-size:14px}#iv2Game.casino .chipb{width:46px;height:46px;min-width:46px}#iv2Game.casino button{padding:4px 12px;font-size:12px}}`;
export const CHIP_COLOURS = ['#2e6fd0', '#b8312f', '#1c7a4b', '#6a2e9a', '#222', '#c98a1a'];
export const chipColour = (i) => CHIP_COLOURS[i % CHIP_COLOURS.length];

// ------------------------------------------------------------------------------------------------ chips on canvas
/** A casino chip seen from slightly above: edge stripes, inner ring, value. */
export function drawChip(g, x, y, r, col, label, lift = 0) {
  g.save(); g.translate(x, y - lift);
  g.fillStyle = '#0006'; g.beginPath(); g.ellipse(2, r * 0.35 + lift * 0.4, r, r * 0.42, 0, 0, 7); g.fill();
  g.fillStyle = shade(col, -0.35); g.beginPath(); g.ellipse(0, r * 0.2, r, r * 0.55, 0, 0, 7); g.fill();   // the rim (thickness)
  const gr = g.createRadialGradient(-r * 0.3, -r * 0.2, r * 0.1, 0, 0, r); gr.addColorStop(0, shade(col, 0.35)); gr.addColorStop(1, col);
  g.fillStyle = gr; g.beginPath(); g.ellipse(0, 0, r, r * 0.55, 0, 0, 7); g.fill();
  g.strokeStyle = '#fffd'; g.lineWidth = Math.max(1, r * 0.1); g.setLineDash([r * 0.32, r * 0.26]); g.beginPath(); g.ellipse(0, 0, r * 0.88, r * 0.48, 0, 0, 7); g.stroke(); g.setLineDash([]);
  g.strokeStyle = '#fff9'; g.lineWidth = 1; g.beginPath(); g.ellipse(0, 0, r * 0.6, r * 0.33, 0, 0, 7); g.stroke();
  if (label) { g.fillStyle = '#fff'; g.font = `800 ${Math.max(8, r * 0.5)}px system-ui`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(label, 0, 0); }
  g.restore();
}
export function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16), c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(clamp(k >= 0 ? v + (255 - v) * k : v * (1 + k), 0, 255)));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
/** A stack of chips for `amount` using the table's denominations (largest first, at most 6 drawn). */
export function drawStack(g, x, y, r, amount, chips) {
  let left = amount; const parts = [];
  for (let i = chips.length - 1; i >= 0 && parts.length < 6; i--) { const n = Math.floor(left / chips[i]); for (let k = 0; k < Math.min(n, 6 - parts.length); k++) parts.push(i); left -= n * chips[i]; }
  parts.reverse().forEach((ci, k) => drawChip(g, x, y, r, chipColour(ci), k === parts.length - 1 ? short(chips[ci]) : '', k * r * 0.22));
}
export const short = (v) => (v >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : v >= 1000 ? `${+(v / 1000).toFixed(1)}k` : String(v));

// ------------------------------------------------------------------------------------------------ particles
export class Particles {
  constructor() { this.p = []; }
  burst(x, y, n, o = {}) { for (let i = 0; i < n; i++) { const a = (o.dir ?? Math.random() * 6.283) + (Math.random() - 0.5) * (o.spread ?? 6.283), s = (o.speed ?? 240) * (0.4 + Math.random() * 0.8); this.p.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - (o.up ?? 0), life: (o.life ?? 1.2) * (0.6 + Math.random() * 0.7), t: 0, g: o.g ?? 500, c: (o.colours || ['#f6e3a1', '#d9b45a', '#fff']) [i % (o.colours || [0, 0, 0]).length], kind: o.kind || 'spark', r: o.r ?? 3, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 12 }); } }
  confetti(w, n = 90) { this.burst(w / 2, 20, n, { dir: Math.PI / 2, spread: 2.6, speed: 380, g: 360, life: 2.4, kind: 'conf', r: 5, colours: ['#f6e3a1', '#d9b45a', '#2fbf7f', '#e0463c', '#4aa3ff', '#fff'] }); }
  coins(w, n = 60) { for (let i = 0; i < n; i++) this.p.push({ x: Math.random() * w, y: -20 - Math.random() * 200, vx: (Math.random() - 0.5) * 60, vy: 120 + Math.random() * 180, life: 3, t: 0, g: 420, c: '#f2c64a', kind: 'coin', r: 7 + Math.random() * 4, rot: Math.random() * 6, vr: 6 + Math.random() * 8, bounce: 0 }); }
  update(dt, floor) {
    for (const q of this.p) { q.t += dt; q.vy += q.g * dt; q.x += q.vx * dt; q.y += q.vy * dt; q.rot += q.vr * dt; if (q.kind === 'coin' && floor && q.y > floor && q.bounce < 2) { q.y = floor; q.vy *= -0.45; q.bounce++; } }
    this.p = this.p.filter((q) => q.t < q.life);
  }
  draw(g) {
    for (const q of this.p) {
      const a = clamp(1 - q.t / q.life, 0, 1); g.globalAlpha = Math.min(1, a * 1.6);
      if (q.kind === 'spark') { g.fillStyle = q.c; g.beginPath(); g.arc(q.x, q.y, q.r * (0.4 + a), 0, 7); g.fill(); }
      else if (q.kind === 'conf') { g.save(); g.translate(q.x, q.y); g.rotate(q.rot); g.scale(1, Math.abs(Math.cos(q.rot * 1.7)) + 0.15); g.fillStyle = q.c; g.fillRect(-q.r, -q.r * 0.6, q.r * 2, q.r * 1.2); g.restore(); }
      else if (q.kind === 'coin') { g.save(); g.translate(q.x, q.y); g.scale(Math.abs(Math.cos(q.rot)) + 0.12, 1); const gr = g.createRadialGradient(-q.r * 0.3, -q.r * 0.3, 1, 0, 0, q.r); gr.addColorStop(0, '#fff3b0'); gr.addColorStop(1, '#c58b12'); g.fillStyle = gr; g.beginPath(); g.arc(0, 0, q.r, 0, 7); g.fill(); g.strokeStyle = '#8a5a00'; g.lineWidth = 1.2; g.stroke(); g.restore(); }
    }
    g.globalAlpha = 1;
  }
  get busy() { return this.p.length > 0; }
}

// ------------------------------------------------------------------------------------------------ stage
/**
 * A responsive canvas in `body`: landscape (≈ 16:10) on wide panels, portrait (3:4 … 4:5) on a phone. draw(g, w, h, dt, t) is called every
 * frame while there is something to show (the loop sleeps when `idle()` returns true, to save battery); resize keeps the DPR ≤ 2 (1.5 on a phone).
 */
export function stage(body, o = {}) {
  const cv = h('canvas', { 'aria-label': o.label || 'table' }), g = cv.getContext('2d'); body.append(cv);
  const S = { cv, g, w: 600, h: 400, dpr: 1, t: 0, raf: 0, dead: false, draw: null, idle: () => false, onResize: null, particles: new Particles(), wake() { if (!S.raf && !S.dead) { last = performance.now(); S.raf = requestAnimationFrame(loop); } } };
  let last = performance.now();
  const size = () => {
    const cs = getComputedStyle(body), pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0), bw = Math.max(260, Math.min((body.clientWidth || 600) - pad, 880)), portrait = bw < 560 || innerHeight > innerWidth * 1.15;
    S.portrait = portrait; const ar = portrait ? (o.portraitAspect || 1.2) : (o.aspect || 0.6);
    const maxH = Math.max(260, innerHeight - (o.reserve ?? (portrait ? 285 : 330))); const hh = Math.min(bw * ar, maxH), ww = hh < bw * ar ? hh / ar : bw;
    S.dpr = Math.min(innerWidth < 700 ? 1.5 : 2, devicePixelRatio || 1); S.w = Math.round(ww); S.h = Math.round(hh);
    cv.width = Math.round(S.w * S.dpr); cv.height = Math.round(S.h * S.dpr); cv.style.width = `${S.w}px`; cv.style.height = `${S.h}px`; cv.style.margin = '0 auto';
    S.onResize?.(S); S.wake();
  };
  const loop = (now) => {
    S.raf = 0; if (S.dead) return; const dt = Math.min(0.05, (now - last) / 1000); last = now; S.t += dt; S.particles.update(dt, S.h * 0.92);
    g.setTransform(S.dpr, 0, 0, S.dpr, 0, 0); S.draw?.(g, S.w, S.h, dt, S.t);
    S.particles.draw(g);
    if (!S.idle() || S.particles.busy) S.raf = requestAnimationFrame(loop);
  };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => size()) : null; ro?.observe(body);
  addEventListener('resize', size);
  S.stop = () => { S.dead = true; cancelAnimationFrame(S.raf); ro?.disconnect(); removeEventListener('resize', size); cv.width = cv.height = 1; cv.remove(); S.particles.p.length = 0; };
  size(); return S;
}

// ------------------------------------------------------------------------------------------------ small widgets
/** The chip selector row (buttons coloured like the chips). */
export function chipBar(S, onPick) {
  const row = h('div', { class: 'chips' });
  S.chips.forEach((v, i) => { const b = h('button', { class: `chipb${v === S.chip ? ' on' : ''}`, style: `--c:${chipColour(i)}`, 'aria-label': `chip ${v}`, onclick: () => { S.chip = v; [...row.children].forEach((x) => x.classList.remove('on')); b.classList.add('on'); sfx(S, 'chip'); onPick?.(v); } }, short(v)); row.append(b); });
  return row;
}
export function quickToggle() {
  const cb = h('input', { type: 'checkbox', id: 'cqk' }); cb.checked = quick(); cb.addEventListener('change', () => setQuick(cb.checked));
  return h('label', { class: 'qk', for: 'cqk' }, cb, 'Quick (skip the show)');
}
/** Sound cue through the game's sound engine (sound.js casino()); silent when the engine is muted or absent. */
export function sfx(S, name, v = 1) { try { S.I?.app?.sound?.casino?.(name, v); } catch { /* no sound */ } }
/** Rounded-rect path. */
export function rr(g, x, y, w, h2, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h2, r); g.arcTo(x + w, y + h2, x, y + h2, r); g.arcTo(x, y + h2, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
/** Glowing text. */
export function glowText(g, text, x, y, size, col = GOLD2, glow = '#d9b45a') {
  g.save(); g.font = `800 ${size}px Georgia,serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.shadowColor = glow; g.shadowBlur = size * 0.5; g.fillStyle = col; g.fillText(text, x, y); g.shadowBlur = 0; g.lineWidth = 1; g.strokeStyle = '#7a5a0a'; g.strokeText(text, x, y); g.restore();
}
/** Win banner: a ribbon with the amount, easing in; drawn by the owner's draw() with t0 = seconds since it started. */
export function banner(g, w, h2, text, sub, t0, good = true) {
  const e = E.back(clamp(t0 / 0.5, 0, 1)), a = clamp(t0 / 0.3, 0, 1); if (t0 < 0) return;
  g.save(); g.globalAlpha = a; g.translate(w / 2, h2 * 0.5); g.scale(e, e);
  const bw = Math.min(w * 0.86, 520), bh = 74; rr(g, -bw / 2, -bh / 2, bw, bh, 14);
  const gr = g.createLinearGradient(0, -bh / 2, 0, bh / 2); gr.addColorStop(0, good ? '#103f2f' : '#2a1313'); gr.addColorStop(1, '#050b08'); g.fillStyle = gr; g.fill(); g.lineWidth = 3; g.strokeStyle = good ? GOLD : '#a05050'; g.stroke();
  glowText(g, text, 0, -10, 26, good ? GOLD2 : '#ffc9b0', good ? '#d9b45a' : '#c05040'); g.font = '600 14px system-ui'; g.fillStyle = '#cfe3d9'; g.textAlign = 'center'; g.fillText(sub || '', 0, 22);
  g.restore();
}
