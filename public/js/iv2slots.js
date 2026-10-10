// Interiors v2 — the slot machine (docs/CRUISE-CONTRACT.md §7): a lit cabinet with a chasing marquee, five reels that accelerate, blur and stop one
// after the other with a bounce on the symbols the SERVER rolled, glossy procedural symbol art, line highlights, a coin shower and light sweep on a big
// win, and the free-spin bonus intro. Canvas 2D; the reel strips are the shared ones (shared/casino.js REELS), so a stop position is the server's.
import { GOLD, GOLD2, GOLD3, E, clamp, lerp, h, T, money, stage, sfx, rr, glowText, quickToggle, short } from './iv2casinoui.js';
import { REELS, LINES, FREE_MULT } from '../../shared/casino.js';

const LINE_COL = ['#ff5a5a', '#5ad1ff', '#ffd45a', '#7dff7a', '#e07aff', '#ff9a3a', '#5affd0', '#ff7ab8', '#a0b0ff', '#d0ff5a'];
const symCache = new Map();
function drawSym(g, k, w, hh) {   // symbol art in a w × hh cell, centred at the origin
  const r = Math.min(w, hh) * 0.36; g.save();
  const glow = (c, b) => { g.shadowColor = c; g.shadowBlur = b; };
  if (k === 0) { for (const dx of [-1, 1]) { const x = dx * r * 0.5, y = r * 0.35; const gr = g.createRadialGradient(x - r * 0.18, y - r * 0.2, 2, x, y, r * 0.55); gr.addColorStop(0, '#ff9a9a'); gr.addColorStop(0.4, '#d31a2a'); gr.addColorStop(1, '#6a0510'); g.fillStyle = gr; g.beginPath(); g.arc(x, y, r * 0.52, 0, 7); g.fill(); g.fillStyle = '#fff8'; g.beginPath(); g.ellipse(x - r * 0.18, y - r * 0.22, r * 0.12, r * 0.07, -0.6, 0, 7); g.fill(); }
    g.strokeStyle = '#3a8a2a'; g.lineWidth = r * 0.09; g.beginPath(); g.moveTo(-r * 0.5, -r * 0.1); g.quadraticCurveTo(-r * 0.2, -r * 0.9, r * 0.1, -r * 0.95); g.moveTo(r * 0.5, -r * 0.1); g.quadraticCurveTo(r * 0.4, -r * 0.8, r * 0.1, -r * 0.95); g.stroke(); g.fillStyle = '#4caf3a'; g.beginPath(); g.ellipse(r * 0.3, -r * 0.9, r * 0.28, r * 0.11, -0.4, 0, 7); g.fill(); }
  else if (k === 1) { const gr = g.createRadialGradient(-r * 0.25, -r * 0.2, 2, 0, 0, r); gr.addColorStop(0, '#fffbb0'); gr.addColorStop(0.5, '#f2d21a'); gr.addColorStop(1, '#a88a00'); g.fillStyle = gr; g.beginPath(); g.moveTo(-r * 1.0, 0); g.quadraticCurveTo(-r * 0.4, -r * 0.85, r * 0.5, -r * 0.6); g.quadraticCurveTo(r * 1.05, -r * 0.1, r * 1.0, r * 0.05); g.quadraticCurveTo(r * 0.5, r * 0.85, -r * 0.4, r * 0.75); g.quadraticCurveTo(-r * 0.9, r * 0.5, -r * 1.0, 0); g.fill(); g.fillStyle = '#fff8'; g.beginPath(); g.ellipse(-r * 0.15, -r * 0.35, r * 0.4, r * 0.1, -0.3, 0, 7); g.fill(); }
  else if (k === 2) { const pts = [[0, -0.7], [-0.4, -0.35], [0.4, -0.35], [-0.7, 0.05], [0, 0.05], [0.7, 0.05], [-0.4, 0.45], [0.4, 0.45], [0, 0.85]]; for (const [px, py] of pts) { const x = px * r, y = py * r * 0.95, gr = g.createRadialGradient(x - r * 0.1, y - r * 0.12, 1, x, y, r * 0.33); gr.addColorStop(0, '#d9a0ff'); gr.addColorStop(0.5, '#7a2ac0'); gr.addColorStop(1, '#2a0a5a'); g.fillStyle = gr; g.beginPath(); g.arc(x, y, r * 0.3, 0, 7); g.fill(); g.fillStyle = '#fff7'; g.beginPath(); g.arc(x - r * 0.1, y - r * 0.12, r * 0.06, 0, 7); g.fill(); } g.fillStyle = '#4caf3a'; g.fillRect(-r * 0.04, -r * 1.0, r * 0.08, r * 0.28); }
  else if (k === 3) { const gr = g.createLinearGradient(-r, -r, r, r); gr.addColorStop(0, '#fff4a8'); gr.addColorStop(0.5, '#e0a812'); gr.addColorStop(1, '#8a5a00'); g.fillStyle = gr; g.beginPath(); g.moveTo(0, -r * 0.95); g.bezierCurveTo(r * 0.8, -r * 0.9, r * 0.75, r * 0.1, r * 1.0, r * 0.55); g.lineTo(-r * 1.0, r * 0.55); g.bezierCurveTo(-r * 0.75, r * 0.1, -r * 0.8, -r * 0.9, 0, -r * 0.95); g.fill(); g.fillStyle = gr; g.beginPath(); g.arc(0, r * 0.7, r * 0.2, 0, 7); g.fill(); g.fillStyle = '#fff9'; g.beginPath(); g.ellipse(-r * 0.3, -r * 0.2, r * 0.1, r * 0.4, 0.2, 0, 7); g.fill(); g.strokeStyle = '#7a5200'; g.lineWidth = 2; g.beginPath(); g.moveTo(-r * 1.0, r * 0.55); g.lineTo(r * 1.0, r * 0.55); g.stroke(); }
  else if (k === 4) { rr(g, -r * 1.05, -r * 0.5, r * 2.1, r * 1.0, r * 0.14); const gr = g.createLinearGradient(0, -r * 0.5, 0, r * 0.5); gr.addColorStop(0, '#3a3a3a'); gr.addColorStop(1, '#050505'); g.fillStyle = gr; g.fill(); g.lineWidth = r * 0.08; g.strokeStyle = '#e6c15a'; g.stroke(); g.fillStyle = '#f6e3a1'; g.font = `900 ${r * 0.8}px Georgia,serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('BAR', 0, r * 0.04); g.fillStyle = '#fff3'; g.fillRect(-r * 0.95, -r * 0.45, r * 1.9, r * 0.22); }
  else if (k === 5) { glow('#ff2a2a', r * 0.5); g.fillStyle = '#e01a1a'; g.strokeStyle = '#ffd45a'; g.lineWidth = r * 0.1; g.font = `900 ${r * 2.0}px Georgia,serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.strokeText('7', 0, r * 0.1); const gr = g.createLinearGradient(0, -r, 0, r); gr.addColorStop(0, '#ff8a7a'); gr.addColorStop(0.5, '#e01a1a'); gr.addColorStop(1, '#7a0808'); g.fillStyle = gr; g.fillText('7', 0, r * 0.1); }
  else if (k === 6) { const gr = g.createLinearGradient(-r, -r, r, r); gr.addColorStop(0, '#5affc0'); gr.addColorStop(0.5, '#0fa070'); gr.addColorStop(1, '#055a40'); g.fillStyle = gr; glow('#3affb0', r * 0.4); g.beginPath(); for (let i = 0; i < 16; i++) { const a = i * Math.PI / 8, rad = i % 2 ? r * 0.75 : r * 1.0; g.lineTo(Math.cos(a) * rad, Math.sin(a) * rad); } g.closePath(); g.fill(); g.shadowBlur = 0; g.lineWidth = 3; g.strokeStyle = '#f6e3a1'; g.stroke(); g.fillStyle = '#fff'; g.font = `900 ${r * 0.62}px Georgia,serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('WILD', 0, 0); }
  else { glow('#ffd45a', r * 0.6); const gr = g.createRadialGradient(0, 0, 2, 0, 0, r); gr.addColorStop(0, '#fffbe0'); gr.addColorStop(0.5, '#ffc928'); gr.addColorStop(1, '#b86a00'); g.fillStyle = gr; g.beginPath(); for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rad = i % 2 ? r * 0.45 : r * 1.05; g.lineTo(Math.cos(a) * rad, Math.sin(a) * rad); } g.closePath(); g.fill(); g.shadowBlur = 0; g.lineWidth = 2; g.strokeStyle = '#8a5200'; g.stroke(); }
  g.restore(); void hh;
}
function symbol(k, w, hh) {
  const key = `${k}|${w}|${hh}`; let cv = symCache.get(key); if (cv) return cv;
  cv = document.createElement('canvas'); cv.width = w; cv.height = hh; const g = cv.getContext('2d');
  const bg = g.createLinearGradient(0, 0, 0, hh); bg.addColorStop(0, '#fffdf4'); bg.addColorStop(0.5, '#f4ecd6'); bg.addColorStop(1, '#e2d6b4'); g.fillStyle = bg; g.fillRect(0, 0, w, hh);
  g.translate(w / 2, hh / 2); drawSym(g, k, w, hh); symCache.set(key, cv); return cv;
}

export function create(S) {
  const { U } = S, stg = stage(U.body, { aspect: 0.86, portraitAspect: 1.32, label: 'slot machine' });
  const reels = REELS.map((R, i) => ({ i, n: R.length, p: Math.floor(Math.random() * R.length), v: 0, anim: null }));
  const st = { win: 0, hits: [], big: 0, sweep: -1, intro: -1, free: 0, stopped: true, line: 1, shown: null, counter: 0, disp: 0, lamp: 0 };
  let G = null;
  const geo = () => { const w = stg.w, hh = stg.h, port = stg.portrait, rw = w * (port ? 0.76 : 0.62), cw = rw / 5, ch = Math.min(cw * 0.98, hh * (port ? 0.2 : 0.2)); G = { w, hh, cw, ch, rx: (w - cw * 5) / 2, ry: hh * (port ? 0.3 : 0.31), rh: ch * 3 }; };
  stg.onResize = geo; geo();
  const sym = (R, k) => R[((k % R.length) + R.length) % R.length];
  // ---- spin animation: a reel's position runs from where it is to `stop` (+ whole laps), stopping one after the other
  function spinTo(i, stop, delay, dur, cont = false) {
    const r = reels[i], n = r.n, p0 = r.p, mod = ((((p0 - stop) % n) + n) % n), want = (cont ? 38 : 60) * dur / 2.6;
    const D = mod + n * Math.max(cont ? 1 : 2, Math.round((want - mod) / n));
    r.anim = { p0, D, t: -delay, dur, stop, bounce: 0, n, cont }; stg.wake();
  }
  const f = (u, cont) => (cont ? 1 - (1 - u) ** 2.6 : u < 0.12 ? 41.3 * u * u - 180.6 * u ** 3 : 1 - (1 - u) ** 2.6);
  function stepReels(dt) {
    let moving = false;
    for (const r of reels) {
      const a = r.anim; if (!a) { r.v = 0; continue; }
      a.t += dt; moving = true; if (a.t < 0) continue;
      if (a.waiting) { a.sp = Math.min(38, (a.sp || 0) + 70 * dt); r.p -= a.sp * dt; r.v = -a.sp; continue; }
      const u = clamp(a.t / a.dur, 0, 1), prev = r.p; r.p = a.p0 - a.D * f(u, a.cont);
      if (u >= 1) { const tau = a.t - a.dur; a.bounce = Math.exp(-7 * tau) * Math.sin(tau * 24) * 0.22; r.p = a.stop + a.bounce; if (!a.stopped) { a.stopped = true; sfx(S, 'reelstop', 0.9); } if (tau > 0.45) { r.p = a.stop; r.anim = null; r.v = 0; r.landed = true; continue; } }
      r.v = (r.p - prev) / Math.max(dt, 0.001); if (Math.floor(r.p * 1) !== Math.floor(prev * 1) && u < 0.9) sfx(S, 'tick', 0.18);
    }
    return moving;
  }
  // ---- drawing
  function cabinet(g, w, hh) {
    let gr = g.createLinearGradient(0, 0, 0, hh); gr.addColorStop(0, '#1b0b2c'); gr.addColorStop(1, '#07030f'); g.fillStyle = gr; g.fillRect(0, 0, w, hh);
    // chrome and gold frame with a pulsing glow
    const pulse = 0.5 + 0.5 * Math.sin(stg.t * 3);
    rr(g, 6, 6, w - 12, hh - 12, 22); g.lineWidth = 8; gr = g.createLinearGradient(0, 0, w, hh); gr.addColorStop(0, '#fff2b0'); gr.addColorStop(0.3, '#c58b12'); gr.addColorStop(0.6, '#fff6c8'); gr.addColorStop(1, '#8a5a08'); g.strokeStyle = gr; g.shadowColor = '#ffcf4a'; g.shadowBlur = 10 + 12 * pulse; g.stroke(); g.shadowBlur = 0;
    rr(g, 18, 18, w - 36, hh - 36, 16); g.lineWidth = 2; g.strokeStyle = '#f6e3a166'; g.stroke();
    // marquee: chasing bulbs round the top panel
    const mh = hh * 0.2, n = Math.round(w / 26);
    rr(g, 28, 28, w - 56, mh, 14); gr = g.createLinearGradient(0, 28, 0, 28 + mh); gr.addColorStop(0, '#4a1a6a'); gr.addColorStop(1, '#1a0830'); g.fillStyle = gr; g.fill();
    for (let i = 0; i < n; i++) { const x = 40 + (w - 80) * i / (n - 1), on = ((i + Math.floor(stg.t * 6)) % 3) === 0; for (const y of [34, 22 + mh]) { g.fillStyle = on ? '#fff3a0' : '#7a5a1a'; g.shadowColor = '#ffd45a'; g.shadowBlur = on ? 10 : 0; g.beginPath(); g.arc(x, y, 3.6, 0, 7); g.fill(); } } g.shadowBlur = 0;
    glowText(g, 'SALTLINE  SEVENS', w / 2, 28 + mh * 0.36, Math.max(16, w * (stg.portrait ? 0.075 : 0.05)), GOLD2);
    g.fillStyle = '#e8d9ff'; g.font = `700 ${Math.max(10, w * 0.022)}px system-ui`; g.textAlign = 'center'; g.fillText(`TOP PRIZE  ${money(250 * st.line)} CR  ·  5 × 7`, w / 2, 28 + mh * 0.78);
  }
  function reelsWindow(g) {
    const { cw, ch, rx, ry, rh } = G;
    rr(g, rx - 10, ry - 10, cw * 5 + 20, rh + 20, 12); const gr = g.createLinearGradient(0, ry, 0, ry + rh); gr.addColorStop(0, '#000'); gr.addColorStop(1, '#1a1a1a'); g.fillStyle = gr; g.fill(); g.lineWidth = 4; g.strokeStyle = '#c58b12'; g.stroke();
    g.save(); g.beginPath(); g.rect(rx, ry, cw * 5, rh); g.clip();
    for (const r of reels) {
      const x = rx + r.i * cw, p = r.p, blur = clamp(Math.abs(r.v) / 12, 0, 1), R = REELS[r.i];
      for (let row = -2; row <= 4; row++) {
        const idx = Math.floor(p) + row, y = ry + ch * 1.5 + (idx - p) * ch - ch / 2, k = sym(R, idx);
        if (y + ch < ry - 2 || y > ry + rh + 2) continue;
        const im = symbol(k, Math.round(cw - 4), Math.round(ch)); g.drawImage(im, x + 2, y, cw - 4, ch);
        if (blur > 0.15) { g.globalAlpha = blur * 0.5; const off = Math.sign(r.v) * -ch * 0.35 * blur; g.drawImage(im, x + 2, y + off, cw - 4, ch); g.drawImage(im, x + 2, y - off, cw - 4, ch); g.globalAlpha = 1; }
      }
      if (blur > 0.2) { g.fillStyle = `rgba(255,255,255,${blur * 0.28})`; g.fillRect(x + 2, ry, cw - 4, rh); }
      // glass shading: dark at the top and bottom edges of the window
      const sh = g.createLinearGradient(0, ry, 0, ry + rh); sh.addColorStop(0, '#0009'); sh.addColorStop(0.22, '#0000'); sh.addColorStop(0.78, '#0000'); sh.addColorStop(1, '#000a'); g.fillStyle = sh; g.fillRect(x, ry, cw, rh);
      g.fillStyle = '#000'; g.fillRect(x - 1, ry, 3, rh);
    }
    // line highlights
    if (st.shown && st.hits.length) {
      const cur = st.hits[Math.floor(stg.t * 1.4) % st.hits.length], pulse = 0.6 + 0.4 * Math.sin(stg.t * 9);
      for (const hh of st.hits) { for (let r = 0; r < hh.count; r++) { const row = LINES[hh.line][r], cx = rx + r * cw, cy = ry + row * ch; g.strokeStyle = LINE_COL[hh.line]; g.lineWidth = 3; g.globalAlpha = hh === cur ? pulse : 0.35; g.strokeRect(cx + 4, cy + 4, cw - 8, ch - 8); } }
      g.globalAlpha = 1; g.strokeStyle = LINE_COL[cur.line]; g.lineWidth = 5; g.shadowColor = LINE_COL[cur.line]; g.shadowBlur = 14; g.lineJoin = 'round'; g.beginPath();
      for (let r = 0; r < 5; r++) { const x = rx + r * cw + cw / 2, y = ry + LINES[cur.line][r] * ch + ch / 2; r ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke(); g.shadowBlur = 0;
    }
    g.restore();
    // the number of the line being shown, beside its first cell
    if (st.shown && st.hits.length) { const cur = st.hits[Math.floor(stg.t * 1.4) % st.hits.length]; g.fillStyle = LINE_COL[cur.line]; g.font = '800 14px system-ui'; g.textAlign = 'right'; g.fillText(`L${cur.line + 1}`, rx - 14, ry + LINES[cur.line][0] * ch + ch / 2 + 5); }
  }
  function panel(g, w, hh) {
    const y = G.ry + G.rh + 26, ph = hh - y - 26;
    rr(g, 34, y, w - 68, Math.max(40, ph), 14); const gr = g.createLinearGradient(0, y, 0, y + ph); gr.addColorStop(0, '#2a2a34'); gr.addColorStop(1, '#0d0d12'); g.fillStyle = gr; g.fill(); g.strokeStyle = '#c58b12'; g.lineWidth = 2; g.stroke();
    const cell = (label, val, x, ww) => { rr(g, x, y + 10, ww, Math.max(24, ph - 20), 8); g.fillStyle = '#050a08'; g.fill(); g.strokeStyle = '#3a5a4a'; g.lineWidth = 1; g.stroke(); g.fillStyle = '#7ab8a0'; g.font = '600 10px system-ui'; g.textAlign = 'center'; g.fillText(label, x + ww / 2, y + 22); g.fillStyle = '#6dffa8'; g.shadowColor = '#34ff8a'; g.shadowBlur = 8; g.font = `800 ${Math.min(22, Math.max(14, ph * 0.3))}px ui-monospace,Menlo,monospace`; g.fillText(val, x + ww / 2, y + 10 + Math.max(24, ph - 20) * 0.68); g.shadowBlur = 0; };
    const ww = (w - 68 - 40) / 3; cell('BET', money(st.line * 10), 44, ww); cell('WIN', money(Math.round(st.disp)), 54 + ww, ww); cell('CREDIT', money(S.balance ?? 0), 64 + ww * 2, ww);
  }
  stg.draw = (g, w, hh, dt) => {
    const moving = stepReels(dt); st.lamp += dt; if (st.disp < st.win) st.disp = Math.min(st.win, st.disp + Math.max(1, st.win) * dt * 0.8);
    void moving;
    cabinet(g, w, hh); reelsWindow(g); panel(g, w, hh);
    if (st.sweep >= 0) { st.sweep += dt; const u = st.sweep / 1.4, x = lerp(-w * 0.3, w * 1.3, u); const gr = g.createLinearGradient(x - 90, 0, x + 90, hh * 0.3); gr.addColorStop(0, '#fff0'); gr.addColorStop(0.5, '#fff6'); gr.addColorStop(1, '#fff0'); g.fillStyle = gr; g.fillRect(0, 0, w, hh); if (u > 1) st.sweep = -1; }
    if (st.intro >= 0) { st.intro += dt; const u = st.intro / 2.0; g.save(); g.fillStyle = `rgba(0,0,0,${0.72 * Math.min(1, u * 4) * (u > 0.85 ? (1 - u) / 0.15 : 1)})`; g.fillRect(0, 0, w, hh); g.translate(w / 2, hh / 2); g.rotate(st.intro * 0.8); const ra = Math.min(1, u * 4) * (u > 0.85 ? (1 - u) / 0.15 : 1); g.globalAlpha = ra * 0.5; for (let i = 0; i < 18; i++) { g.rotate(Math.PI / 9); g.fillStyle = i % 2 ? '#ffd45a' : '#fff4b0'; g.beginPath(); g.moveTo(0, 0); g.lineTo(w, -26); g.lineTo(w, 26); g.fill(); } g.restore(); g.save(); g.globalAlpha = ra; g.translate(w / 2, hh / 2); const s = E.back(clamp(u * 3, 0, 1)); g.scale(s, s); glowText(g, 'FREE SPINS', 0, -16, Math.min(w * 0.12, 64), GOLD2); glowText(g, `${st.free} × spins · wins ×${FREE_MULT}`, 0, 30, Math.min(w * 0.05, 26), '#fff'); g.restore(); if (u >= 1) st.intro = -1; }
    if (st.big > 0) { st.big += dt; const u = st.big; if (u < 3.4) { g.save(); g.translate(w / 2, hh * 0.5); const s = 1 + 0.06 * Math.sin(u * 8) * Math.min(1, u * 2); g.scale(E.back(clamp(u * 2.2, 0, 1)) * s, E.back(clamp(u * 2.2, 0, 1)) * s); glowText(g, st.bigText, 0, 0, Math.min(w * 0.13, 70), '#fff3a0', '#ff9a00'); g.restore(); } else st.big = 0; }
  };
  stg.idle = () => st.stopped && !reels.some((r) => r.anim) && st.sweep < 0 && st.intro < 0 && !st.big && !st.hits.length;   // lamps keep chasing only while something is lit
  // marquee animation needs a loop even when idle: slow ticker
  const ticker = setInterval(() => stg.wake(), 450);
  // ---- results
  let pendingRes = null;
  function landed() {
    const m = pendingRes; if (!m) return; pendingRes = null; const v = m.view;
    st.shown = v; st.hits = v.hits || []; st.win = v.returned ?? 0;
    const stake = v.stake ?? st.line * 10, mult = stake ? (v.returned / stake) : 0;
    if (v.returned > 0) { sfx(S, mult >= 15 ? 'big' : 'win'); S.say(`${money(v.returned)} cr`, true); if (mult >= 5) { stg.particles.burst(stg.w / 2, stg.h * 0.4, 50, { speed: 320 }); st.sweep = 0; } if (mult >= 15) { stg.particles.coins(stg.w, 90); stg.particles.confetti(stg.w, 60); st.big = 0.01; st.bigText = mult >= 40 ? 'MEGA WIN!' : 'BIG WIN!'; } }
    else { S.say('No win this time.', null); sfx(S, 'tick', 0.3); }
    S.balance = m.money; S.U.setMoney(m.money); S.pending.busy = false; spinBtn.disabled = false; stg.wake();
  }
  async function playFree(m) {
    const v = m.view; st.free = v.freeSpins; sfx(S, 'big'); st.intro = 0; stg.wake(); await new Promise((r) => setTimeout(r, T(2.0) * 1000)); let sum = 0;
    for (const fr of v.free) { await runSpin(fr.stops, T(0.62)); st.hits = fr.hits || []; st.shown = { hits: st.hits }; sum += fr.pays; st.win = (v.pays || 0) + sum; if (fr.pays) { sfx(S, 'win', 0.8); stg.particles.burst(stg.w / 2, stg.h * 0.42, 22, { speed: 220 }); } await new Promise((r) => setTimeout(r, fr.pays ? T(0.9) * 1000 : T(0.3) * 1000)); st.hits = []; }
    // back to the base game's window for the summary
    st.shown = v; st.hits = v.hits || [];
  }
  function runSpin(stops, base, cont = false) {
    return new Promise((resolve) => { st.stopped = false; st.hits = []; st.shown = null; stops.forEach((s, i) => spinTo(i, s, i * T(0.12), base + i * T(0.3) + T(0.2), cont)); const w = () => { if (reels.some((r) => r.anim)) requestAnimationFrame(w); else resolve(); }; w(); });
  }
  const setLine = (d) => { const steps = [1, 2, 3, 5, 10, 20, 50, 100, 200, 500, 1000].filter((q) => q * 10 >= S.lim.min && q * 10 <= S.lim.max); const i = clamp(steps.indexOf(st.line) + d, 0, steps.length - 1); st.line = steps[i] ?? st.line; label.textContent = `${st.line} per line · ${money(st.line * 10)} total`; stg.wake(); };
  const label = h('div', { class: 'cnote', style: 'text-align:center' });
  const spinBtn = h('button', { class: 'gold', style: 'min-width:150px;font-size:18px', onclick: () => { if (S.pending.busy) return; S.pending.busy = true; spinBtn.disabled = true; st.win = 0; st.disp = 0; st.hits = []; st.shown = null; sfx(S, 'whoosh', 0.5); S.say(''); S.send('spin', { lineBet: st.line }); // the reels spin up while the server answers
    reels.forEach((r, i) => { r.anim = { p0: r.p, t: -i * 0.05, waiting: true }; }); st.stopped = false; stg.wake(); } }, 'SPIN');
  S.U.body.append(label, h('div', { class: 'abar' }, h('button', { onclick: () => setLine(-1) }, '−'), h('button', { onclick: () => setLine(1) }, '+'), h('button', { onclick: () => setLine(99) }, 'Max'), spinBtn), h('div', { class: 'cnote', style: 'text-align:center' }, '3+ ★ anywhere starts free spins (wins ×2). W is wild. Lines pay left to right.'), quickToggle());
  setLine(0);
  return {
    async onResult(m) {
      const v = m.view; pendingRes = m; S.balance = m.money - (v.returned - v.stake);   // the purse shown moves when the reels stop
      // a free-running reel (waiting for the server) now runs to the server's symbols
      const was = reels.some((r) => r.anim?.waiting); reels.forEach((r) => { r.anim = null; }); await runSpin(v.stops, T(0.8), was);
      if (v.free.length) await playFree(m);
      st.stopped = true; landed();
    },
    refused() { reels.forEach((r) => { r.anim = null; }); st.stopped = true; spinBtn.disabled = false; stg.wake(); },
    stop() { clearInterval(ticker); stg.stop(); },
  };
}
void GOLD3; void short;
