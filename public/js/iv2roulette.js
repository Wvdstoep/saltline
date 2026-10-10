// Interiors v2 — the roulette table (docs/CRUISE-CONTRACT.md §7): a wooden bowl and brass wheel with 37 pockets and a ball that circles the track,
// slows, drops and bounces into the pocket the SERVER rolled; a green felt layout with chips stacked on every bet; the rake sweeps the losing
// chips, winners are paid with a stack that flies to the purse. Canvas 2D with real shading (a WebGL context per table would cost a phone more
// than it gives). The ball's path is solved backwards from the server's number, so it always lands there. Loaded when the table is used.
import { GOLD, GOLD2, GOLD3, E, clamp, lerp, h, T, money, drawChip, drawStack, chipColour, stage, chipBar, quickToggle, sfx, rr, glowText, banner, short } from './iv2casinoui.js';
import { coverOf, RED, colourOf } from '../../shared/casino.js';

export const ORDER = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
export const TAU = Math.PI * 2, POCKET = TAU / 37;
/** The rotor's angle t seconds after the answer (it turns slowly and eases). */
export const rotorPath = (t, T0, rotor0) => rotor0 + 0.5 * t - 0.12 * t * t / Math.max(1, T0);
/**
 * The ball t seconds into a spin of T0 seconds that must end in pocket index k of the rotor (ORDER[k] = the server's number): the ball's angle is the rotor's
 * plus the pocket's plus a relative angle that dies away as (1 − u)^2.3, so at u = 1 it sits exactly in the pocket, whatever the rotor did.
 */
export function ballPath(t, T0, k, rotor0, R) {
  const u = clamp(t / T0, 0, 1), rim = R * 0.86, rp = R * 0.5, lockU = 0.965;
  const D = -TAU * 7.2 * (1 - u) ** 2.3, ang = rotorPath(t, T0, rotor0) + k * POCKET + D;
  let r = rim;
  if (u > 0.52) { const q = clamp((u - 0.52) / 0.3, 0, 1); r = lerp(rim, R * 0.62, E.io(q)); }
  if (u > 0.82) { const q = (u - 0.82) / 0.18; r = lerp(R * 0.62, rp, E.out(clamp(q * 1.2, 0, 1))) + Math.abs(Math.sin(q * 11)) * (1 - q) ** 2 * R * 0.09; }   // bounces off the frets
  if (u >= lockU) r = rp;
  return { ang, r, u, lifted: u > 0.82 && u < lockU ? Math.abs(Math.sin((u - 0.82) / 0.18 * 11)) * (1 - (u - 0.82) / 0.18) ** 2 : 0 };
}

export function create(S) {
  const { I, U } = S;
  const bets = [], history = [], mode0 = { v: 'straight', first: null };
  const st = { phase: 'idle', t0: 0, T: 5, k: 0, res: null, rotor: 0, ball: null, hi: null, rake: -1, flying: [], banner: -1, lastBets: null, sweep: [] };
  const stg = stage(U.body, { aspect: 0.58, portraitAspect: 1.75, label: 'roulette table' });
  let L = null;   // geometry
  // ---------------------------------------------------------------------------------------------- layout
  function layout(w, hh, portrait) {
    const cells = [], num = (n) => ({ type: 'straight', n });
    const wheel = portrait ? { cx: w / 2, cy: hh * 0.185, R: Math.min(w * 0.4, hh * 0.17) } : { cx: w * 0.21, cy: hh * 0.5, R: Math.min(w * 0.18, hh * 0.44) };
    const box = portrait ? { x: 8, y: hh * 0.38, w: w - 16, h: hh * 0.6 } : { x: w * 0.44, y: hh * 0.12, w: w * 0.54, h: hh * 0.76 };
    if (!portrait) {
      const zw = box.w * 0.07, cw = (box.w - zw) / 13.1, ch = box.h * 0.2, y0 = box.y + box.h * 0.04;
      cells.push({ ...num(0), x: box.x, y: y0, w: zw, h: ch * 3, label: '0', col: 'green' });
      for (let c = 0; c < 12; c++) for (let r = 0; r < 3; r++) { const n = c * 3 + (3 - r); cells.push({ ...num(n), x: box.x + zw + c * cw, y: y0 + r * ch, w: cw, h: ch, label: String(n), col: colourOf(n) }); }
      const y1 = y0 + ch * 3, oh = box.h * 0.13;
      [1, 2, 3].forEach((d, i) => cells.push({ type: 'dozen', n: d, x: box.x + zw + i * 4 * cw, y: y1, w: 4 * cw, h: oh, label: ['1st 12', '2nd 12', '3rd 12'][i], col: 'felt' }));
      [['low', '1–18'], ['even', 'EVEN'], ['red', ''], ['black', ''], ['odd', 'ODD'], ['high', '19–36']].forEach(([t, l], i) => cells.push({ type: t, x: box.x + zw + i * 2 * cw, y: y1 + oh, w: 2 * cw, h: oh, label: l, col: t === 'red' ? 'red' : t === 'black' ? 'black' : 'felt', diamond: t === 'red' || t === 'black' }));
      [1, 2, 3].forEach((c, i) => cells.push({ type: 'column', n: c, x: box.x + zw + 12 * cw, y: y0 + (c === 3 ? 0 : c === 2 ? 1 : 2) * ch, w: cw * 0.0, h: 0, label: '', col: 'felt', hidden: true, i }));
      // the three column bets sit right of the numbers
      cells.filter((q) => q.type === 'column').forEach((q) => { q.hidden = false; q.x = box.x + zw + 12 * cw; q.w = Math.min(cw * 1.1, box.x + box.w - q.x); q.y = y0 + (3 - q.n) * ch; q.h = ch; q.label = '2:1'; });
    } else {
      const ow = box.w * 0.15, nw = (box.w - ow * 2 - 0) / 3, rows = 12, zh = box.h * 0.06, ch = (box.h - zh - box.h * 0.06) / rows, y0 = box.y + zh;
      cells.push({ ...num(0), x: box.x + ow, y: box.y, w: nw * 3, h: zh, label: '0', col: 'green' });
      for (let r = 0; r < rows; r++) for (let c = 0; c < 3; c++) { const n = r * 3 + c + 1; cells.push({ ...num(n), x: box.x + ow + c * nw, y: y0 + r * ch, w: nw, h: ch, label: String(n), col: colourOf(n) }); }
      [1, 2, 3].forEach((d, i) => cells.push({ type: 'dozen', n: d, x: box.x, y: y0 + i * 4 * ch, w: ow, h: 4 * ch, label: ['1st', '2nd', '3rd'][i], col: 'felt', vert: true }));
      [['low', '1-18'], ['even', 'EVEN'], ['red', ''], ['black', ''], ['odd', 'ODD'], ['high', '19-36']].forEach(([t, l], i) => cells.push({ type: t, x: box.x + ow + 3 * nw, y: y0 + i * 2 * ch, w: ow, h: 2 * ch, label: l, col: t === 'red' ? 'red' : t === 'black' ? 'black' : 'felt', diamond: t === 'red' || t === 'black', vert: true }));
      [1, 2, 3].forEach((c, i) => cells.push({ type: 'column', n: c, x: box.x + ow + i * nw, y: y0 + rows * ch, w: nw, h: box.h * 0.06, label: '2:1', col: 'felt' }));
    }
    return { wheel, box, cells, portrait };
  }
  stg.onResize = () => { L = layout(stg.w, stg.h, stg.portrait); };
  L = layout(stg.w, stg.h, stg.portrait);
  const cellOf = (b) => {
    const nCell = (n) => L.cells.find((q) => q.type === 'straight' && q.n === n);
    if (b.type === 'straight') { const c = nCell(b.n); return c && { x: c.x + c.w / 2, y: c.y + c.h / 2 }; }
    if (b.type === 'split') { const [a, c] = [nCell(b.n[0]), nCell(b.n[1])]; return a && c && { x: (a.x + a.w / 2 + c.x + c.w / 2) / 2, y: (a.y + a.h / 2 + c.y + c.h / 2) / 2 }; }
    if (b.type === 'street') { const a = nCell(b.n * 3 - 2), c = nCell(b.n * 3); return a && c && { x: (a.x + a.w / 2 + c.x + c.w / 2) / 2, y: (a.y + a.h / 2 + c.y + c.h / 2) / 2 }; }
    if (b.type === 'line') { const a = nCell(b.n * 3 - 2), c = nCell(b.n * 3 + 3); return a && c && { x: (a.x + a.w / 2 + c.x + c.w / 2) / 2, y: (a.y + a.h / 2 + c.y + c.h / 2) / 2 }; }
    if (b.type === 'corner') { const cs = coverOf(b).map(nCell); return { x: cs.reduce((s, q) => s + q.x + q.w / 2, 0) / 4, y: cs.reduce((s, q) => s + q.y + q.h / 2, 0) / 4 }; }
    const c = L.cells.find((q) => q.type === b.type && (b.n === undefined || q.n === b.n)); return c && { x: c.x + c.w / 2, y: c.y + c.h / 2 };
  };
  // ---------------------------------------------------------------------------------------------- the ball's path (solved from the server's pocket)
  const rotorAt = (t) => rotorPath(t, st.T, st.rotor0);
  const ballAt = (t) => ballPath(t, st.T, st.k, st.rotor0, L.wheel.R);
  // ---------------------------------------------------------------------------------------------- drawing
  function drawWheel(g) {
    const { cx, cy, R } = L.wheel;
    // table shadow and wooden bowl
    g.save(); g.translate(cx, cy);
    g.fillStyle = '#0008'; g.beginPath(); g.ellipse(6, 10, R * 1.07, R * 1.07, 0, 0, TAU); g.fill();
    let gr = g.createRadialGradient(-R * 0.3, -R * 0.4, R * 0.2, 0, 0, R * 1.1); gr.addColorStop(0, '#9a5a2a'); gr.addColorStop(0.6, '#5a2c12'); gr.addColorStop(1, '#2a1208');
    g.fillStyle = gr; g.beginPath(); g.arc(0, 0, R * 1.06, 0, TAU); g.fill();
    g.strokeStyle = '#ffffff10'; g.lineWidth = 1; for (let i = 0; i < 48; i++) { const a = i * TAU / 48; g.beginPath(); g.moveTo(Math.cos(a) * R * 0.9, Math.sin(a) * R * 0.9); g.lineTo(Math.cos(a + 0.05) * R * 1.05, Math.sin(a + 0.05) * R * 1.05); g.stroke(); }
    // brass rim
    gr = g.createLinearGradient(-R, -R, R, R); gr.addColorStop(0, '#fff2b0'); gr.addColorStop(0.35, '#c58b12'); gr.addColorStop(0.7, '#f6e3a1'); gr.addColorStop(1, '#7a5208');
    g.lineWidth = R * 0.05; g.strokeStyle = gr; g.beginPath(); g.arc(0, 0, R * 0.99, 0, TAU); g.stroke();
    // ball track (dark polished with a sheen)
    gr = g.createRadialGradient(0, 0, R * 0.74, 0, 0, R * 0.96); gr.addColorStop(0, '#0a0a0a'); gr.addColorStop(0.6, '#2a1e12'); gr.addColorStop(1, '#4a3a22');
    g.fillStyle = gr; g.beginPath(); g.arc(0, 0, R * 0.95, 0, TAU); g.fill();
    g.strokeStyle = '#ffffff22'; g.lineWidth = 2; g.beginPath(); g.arc(0, 0, R * 0.9, -2.6, -1.2); g.stroke();
    // deflectors (frets): eight brass diamonds
    for (let i = 0; i < 8; i++) { g.save(); g.rotate(i * TAU / 8 + 0.4); g.translate(R * 0.7, 0); g.rotate(Math.PI / 4); g.fillStyle = '#f0d27a'; g.fillRect(-R * 0.018, -R * 0.018, R * 0.036, R * 0.036); g.restore(); }
    // rotor: pockets
    g.save(); g.rotate(st.rotor);
    const r0 = R * 0.42, r1 = R * 0.66;
    for (let k = 0; k < 37; k++) {
      const n = ORDER[k], a0 = k * POCKET - POCKET / 2 - Math.PI / 2, a1 = a0 + POCKET, col = n === 0 ? '#14803f' : RED.has(n) ? '#b3262a' : '#14110f';
      g.beginPath(); g.arc(0, 0, r1, a0, a1); g.arc(0, 0, r0, a1, a0, true); g.closePath();
      const pg = g.createRadialGradient(0, 0, r0, 0, 0, r1); pg.addColorStop(0, shadeCol(col, -0.25)); pg.addColorStop(0.5, col); pg.addColorStop(1, shadeCol(col, 0.12)); g.fillStyle = pg; g.fill();
      g.strokeStyle = '#e8c868'; g.lineWidth = 1.2; g.stroke();
      g.save(); g.rotate(k * POCKET); g.fillStyle = '#fff'; g.font = `700 ${Math.max(7, R * 0.075)}px system-ui`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(n, 0, -R * 0.585); g.restore();
    }
    // number ring and cone
    g.lineWidth = R * 0.04; g.strokeStyle = '#d9b45a'; g.beginPath(); g.arc(0, 0, r1 + R * 0.01, 0, TAU); g.stroke();
    gr = g.createRadialGradient(-R * 0.1, -R * 0.12, R * 0.02, 0, 0, r0); gr.addColorStop(0, '#fff'); gr.addColorStop(0.25, '#bfc6cc'); gr.addColorStop(0.7, '#5c656e'); gr.addColorStop(1, '#2a2f34');
    g.fillStyle = gr; g.beginPath(); g.arc(0, 0, r0, 0, TAU); g.fill();
    g.strokeStyle = '#ffffff55'; g.lineWidth = 1; for (let i = 1; i < 4; i++) { g.beginPath(); g.arc(0, 0, r0 * i / 4, 0, TAU); g.stroke(); }
    // turret
    g.fillStyle = '#c9a032'; for (let i = 0; i < 4; i++) { g.save(); g.rotate(i * Math.PI / 2 + 0.3); g.fillRect(-R * 0.012, -R * 0.2, R * 0.024, R * 0.2); g.beginPath(); g.arc(0, -R * 0.2, R * 0.03, 0, TAU); g.fill(); g.restore(); }
    gr = g.createRadialGradient(-R * 0.02, -R * 0.02, 1, 0, 0, R * 0.07); gr.addColorStop(0, '#fff7c8'); gr.addColorStop(1, '#a87810'); g.fillStyle = gr; g.beginPath(); g.arc(0, 0, R * 0.07, 0, TAU); g.fill();
    g.restore();
    // the ball
    if (st.ball) { const b = st.ball, bx = Math.cos(b.ang - Math.PI / 2) * b.r, by = Math.sin(b.ang - Math.PI / 2) * b.r, br = Math.max(3, R * 0.034), lift = (b.lifted || 0) * R * 0.05;
      g.fillStyle = '#0006'; g.beginPath(); g.ellipse(bx + br * 0.5 + lift, by + br * 0.6 + lift, br, br * 0.8, 0, 0, TAU); g.fill();
      const bg = g.createRadialGradient(bx - br * 0.35, by - br * 0.4 - lift, br * 0.1, bx, by - lift, br); bg.addColorStop(0, '#fff'); bg.addColorStop(0.5, '#e8e8e0'); bg.addColorStop(1, '#8a8a84'); g.fillStyle = bg; g.beginPath(); g.arc(bx, by - lift, br, 0, TAU); g.fill(); }
    // glass sheen
    g.globalCompositeOperation = 'lighter'; gr = g.createLinearGradient(-R, -R, R * 0.2, R * 0.2); gr.addColorStop(0, '#ffffff22'); gr.addColorStop(1, '#ffffff00'); g.fillStyle = gr; g.beginPath(); g.arc(0, 0, R * 0.95, 0, TAU); g.fill(); g.globalCompositeOperation = 'source-over';
    g.restore();
  }
  const shadeCol = (c, k) => { const m = /#(..)(..)(..)/.exec(c); const v = [1, 2, 3].map((i) => clamp(Math.round(parseInt(m[i], 16) * (1 + k) + (k > 0 ? 40 * k : 0)), 0, 255)); return `rgb(${v})`; };
  function drawFelt(g, w, hh) {
    // the table: dark wood rail, felt with a soft light and weave
    let gr = g.createLinearGradient(0, 0, 0, hh); gr.addColorStop(0, '#22140c'); gr.addColorStop(1, '#120a06'); g.fillStyle = gr; g.fillRect(0, 0, w, hh);
    const b = L.box, px = 10;
    rr(g, b.x - px, b.y - px, b.w + px * 2, b.h + px * 2, 14); gr = g.createRadialGradient(b.x + b.w / 2, b.y + b.h * 0.4, 10, b.x + b.w / 2, b.y + b.h / 2, Math.max(b.w, b.h)); gr.addColorStop(0, '#12805a'); gr.addColorStop(0.7, '#0a4a35'); gr.addColorStop(1, '#052b20'); g.fillStyle = gr; g.fill();
    g.lineWidth = 3; g.strokeStyle = GOLD3; g.stroke();
    g.fillStyle = '#ffffff06'; for (let y = b.y - px; y < b.y + b.h + px; y += 4) g.fillRect(b.x - px, y, b.w + px * 2, 1);
  }
  function drawCells(g) {
    const fs = Math.max(9, Math.min(L.cells[1].w * 0.4, L.cells[1].h * 0.5, 20));
    for (const c of L.cells) {
      if (c.hidden) continue;
      const col = c.col === 'red' ? '#a82227' : c.col === 'black' ? '#15110f' : c.col === 'green' ? '#13753a' : 'transparent';
      g.fillStyle = col; if (col !== 'transparent') g.fillRect(c.x + 1, c.y + 1, c.w - 2, c.h - 2);
      const hit = st.hi && st.hi.includes(c); if (hit) { g.save(); g.shadowColor = GOLD2; g.shadowBlur = 18 + 8 * Math.sin(stg.t * 8); g.fillStyle = '#f6e3a144'; g.fillRect(c.x, c.y, c.w, c.h); g.restore(); }
      g.strokeStyle = '#e8d9a0cc'; g.lineWidth = 1.4; g.strokeRect(c.x + 0.5, c.y + 0.5, c.w - 1, c.h - 1);
      g.save(); g.translate(c.x + c.w / 2, c.y + c.h / 2); g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
      if (c.diamond) { g.fillStyle = c.col === 'red' ? '#e03a40' : '#222'; g.beginPath(); const s = Math.min(c.w, c.h) * 0.3; g.moveTo(0, -s); g.lineTo(s * 0.7, 0); g.lineTo(0, s); g.lineTo(-s * 0.7, 0); g.closePath(); g.fill(); g.strokeStyle = '#f0d27a'; g.stroke(); }
      else { if (c.vert) g.rotate(-Math.PI / 2); g.font = `700 ${c.type === 'straight' ? fs : fs * 0.85}px Georgia,serif`; g.fillText(c.label, 0, 0); }
      g.restore();
    }
  }
  function drawBets(g) {
    const r = Math.max(8, Math.min(L.cells[1].w, L.cells[1].h) * 0.36), grouped = new Map();
    for (const b of bets) { const p = cellOf(b); if (!p) continue; const key = `${Math.round(p.x)},${Math.round(p.y)}`; const e = grouped.get(key) || { p, amt: 0 }; e.amt += b.amt; grouped.set(key, e); }
    for (const e of grouped.values()) { drawStack(g, e.p.x, e.p.y, r, e.amt, S.chips); g.fillStyle = '#fff'; g.font = `700 ${Math.max(8, r * 0.7)}px system-ui`; g.textAlign = 'center'; g.fillText(short(e.amt), e.p.x, e.p.y - r * 1.3 - 4 - Math.min(5, Math.ceil(e.amt / S.chips[0])) * 0); }
  }
  function drawRake(g, w, hh) {
    if (st.rake < 0) return; const p = clamp(st.rake / T(1.0), 0, 1), b = L.box, x = L.portrait ? lerp(b.x - 20, b.x + b.w + 20, E.io(p)) : lerp(b.x + b.w + 20, b.x - 20, E.io(p));
    g.save(); g.fillStyle = '#6a3d18'; g.strokeStyle = '#2a1608'; g.lineWidth = 1.5;
    if (L.portrait) { rr(g, x - 3, b.y, 6, b.h, 3); g.fill(); g.stroke(); g.fillRect(x - 3, b.y + b.h * 0.5 - 3, 120, 6); }
    else { rr(g, x - 3, b.y, 6, b.h, 3); g.fill(); g.stroke(); g.fillRect(x - 3 + 4, b.y + b.h * 0.5 - 3, 150, 6); }
    g.restore(); void w; void hh;
  }
  stg.draw = (g, w, hh, dt, t) => {
    drawFelt(g, w, hh);
    // phases
    if (st.phase === 'spin') {
      const el = (performance.now() - st.t0) / 1000;
      st.rotor = rotorAt(Math.min(el, st.T)); st.ball = ballAt(Math.min(el, st.T));
      if (Math.floor(el * 14) !== st.lastTick && el < st.T * 0.9 && st.ball.u > 0.3) { st.lastTick = Math.floor(el * 14); sfx(S, 'tick', 0.4); }
      if (st.ball.u > 0.82 && !st.bounced) { st.bounced = 0; }
      if (st.ball.lifted > 0.8 && !st.pinged) { st.pinged = true; sfx(S, 'ball'); } if (st.ball.lifted < 0.2) st.pinged = false;
      if (el >= st.T) { st.phase = 'settle'; st.t0 = performance.now(); st.rotor = rotorAt(st.T); settle(); }
    } else {
      if (st.phase === 'settle') { st.rotor += dt * 0.12; if (st.ball) st.ball.ang = st.rotor + st.k * POCKET; }   // the ball rides in its pocket
      else st.rotor += dt * (st.phase === 'wait' ? 1.6 : 0.35);
    }
    drawWheel(g); drawCells(g); drawBets(g);
    // settle: rake sweeps the losers, the winners' payout stacks fly to the purse
    if (st.phase === 'settle') { const el = (performance.now() - st.t0) / 1000; if (el > T(0.5) && st.rake < 0) { st.rake = 0; sfx(S, 'chip'); } if (st.rake >= 0) st.rake += dt; }
    drawRake(g, w, hh);
    for (const f of st.flying) { f.t += dt; const u = clamp(f.t / T(0.9), 0, 1); if (u > 0) { const x = lerp(f.x0, f.x1, E.io(u)), y = lerp(f.y0, f.y1, E.io(u)) - Math.sin(u * Math.PI) * 40; drawStack(g, x, y, f.r, f.amt, S.chips); } if (u >= 1 && !f.done) { f.done = true; sfx(S, 'coin'); } }
    st.flying = st.flying.filter((f) => f.t < T(0.9) + 0.05);
    if (st.banner >= 0) { st.banner += dt; if (st.banner > 1.7) st.banner = -1; else { const W = L.wheel; g.save(); g.globalAlpha = st.banner > 1.3 ? (1.7 - st.banner) / 0.4 : 1; banner(g, W.cx * 2, W.cy * 2, st.bannerText, st.bannerSub, Math.min(st.banner, 0.6), st.bannerGood); g.restore(); } }   // over the wheel, never over the betting grid
    if (st.phase === 'settle' && performance.now() - st.t0 > T(2.6) * 1000) { st.phase = 'rest'; st.hi = null; st.banner = -1; U.setMoney?.(S.balance ?? 0); }
    void t;
  };
  const h2 = (hh) => hh * 0.3;
  stg.idle = () => false;   // the wheel always turns while the table is open (cheap: one wheel)
  // ---------------------------------------------------------------------------------------------- results
  function settle() {
    const r = st.res, num = r.view.number; const winCells = [];
    const wc = L.cells.find((q) => q.type === 'straight' && q.n === num); if (wc) winCells.push(wc);
    st.hi = winCells; sfx(S, num === 0 ? 'tick' : 'chip');
    history.unshift(num); S.hist.textContent = history.slice(0, 16).map((n) => n).join('  ·  ');
    const net = r.net, good = net > 0;
    st.bannerText = `${num} ${colourOf(num)}`; st.bannerSub = net > 0 ? `You win ${money(net)} cr` : net < 0 ? `You lose ${money(-net)} cr` : 'Your stake comes back'; st.bannerGood = net >= 0; st.banner = 0;
    sfx(S, good ? (net >= S.lim.min * 30 ? 'big' : 'win') : 'lose', 1);
    if (good) { stg.particles.burst(wc.x + wc.w / 2, wc.y + wc.h / 2, 40, { speed: 200, life: 1 }); if (net >= S.lim.min * 30) { stg.particles.confetti(stg.w); stg.particles.coins(stg.w, 50); } }
    // winning bets are paid with a stack beside them, which then flies to the purse; losing chips are raked away
    const rr0 = Math.max(8, Math.min(L.cells[1].w, L.cells[1].h) * 0.36);
    for (const b of S.last) { const p = cellOf(b); if (!p) continue; if (coverOf(b).includes(num)) st.flying.push({ x0: p.x, y0: p.y, x1: stg.w * 0.1, y1: stg.h * 0.95, r: rr0, amt: b.amt * (36 / coverOf(b).length), t: -T(0.7) }); }
    stg.wake();
    setTimeout(() => { bets.length = 0; st.rake = -1; }, T(2.2) * 1000);
  }
  function placeBet(type, n) {
    if (st.phase === 'spin' || st.phase === 'settle') return;
    const b = { type, amt: S.chip }; if (n !== undefined) b.n = n;
    if (!coverOf(b)) { S.say('That is not a bet on the layout.', false); return; }
    const same = bets.find((q) => q.type === type && JSON.stringify(q.n) === JSON.stringify(n));
    if (same) same.amt = Math.min(S.lim.max, same.amt + S.chip); else bets.push(b);
    sfx(S, 'chip'); total(); stg.wake();
  }
  const totalEl = h('div', { class: 'cnote', style: 'text-align:center' });
  const total = () => { const t = bets.reduce((a, b) => a + b.amt, 0); totalEl.textContent = t ? `On the table: ${money(t)} cr (${bets.length} bet${bets.length > 1 ? 's' : ''})` : 'Choose a chip and tap the layout.'; };
  stg.cv.addEventListener('pointerdown', (e) => {
    const rect = stg.cv.getBoundingClientRect(), x = (e.clientX - rect.left) * (stg.w / rect.width), y = (e.clientY - rect.top) * (stg.h / rect.height);
    const c = L.cells.find((q) => !q.hidden && x >= q.x && x < q.x + q.w && y >= q.y && y < q.y + q.h); if (!c) return;
    if (c.type !== 'straight') return placeBet(c.type, c.n);
    const m = mode0.v, n = c.n;
    if (m === 'straight') placeBet('straight', n);
    else if (m === 'split') { if (mode0.first === null) { mode0.first = n; S.say(`Split: now tap a neighbour of ${n}.`); } else { placeBet('split', [mode0.first, n]); mode0.first = null; S.say(''); } }
    else if (m === 'street') placeBet('street', Math.max(1, Math.ceil(n / 3)));
    else if (m === 'line') placeBet('line', Math.min(11, Math.max(1, Math.ceil(n / 3))));
    else placeBet('corner', n);
  });
  // ---------------------------------------------------------------------------------------------- controls
  const modes = h('div', { class: 'abar' }, ['straight', 'split', 'street', 'corner', 'line'].map((m) => { const b = h('button', { class: m === mode0.v ? 'on' : '', onclick: () => { mode0.v = m; mode0.first = null; [...b.parentNode.children].forEach((x) => x.classList.remove('on')); b.classList.add('on'); S.say(m === 'corner' ? 'Corner: tap the lowest number of the square.' : ''); } }, m); return b; }));
  const spin = h('button', { class: 'gold', onclick: () => { if (!bets.length || S.pending.busy || st.phase === 'spin') return; S.pending.busy = true; st.phase = 'wait'; S.last = bets.map((b) => ({ ...b })); sfx(S, 'whoosh'); S.send('spin', { bets: bets.map((b) => ({ ...b })) }); } }, 'Spin');
  const clear = h('button', { class: 'red', onclick: () => { if (st.phase === 'spin') return; bets.length = 0; total(); stg.wake(); } }, 'Clear');
  const undo = h('button', { onclick: () => { if (st.phase === 'spin') return; bets.pop(); total(); stg.wake(); } }, 'Undo');
  const rebet = h('button', { onclick: () => { if (st.phase === 'spin' || !S.last) return; bets.length = 0; bets.push(...S.last.map((b) => ({ ...b }))); total(); stg.wake(); } }, 'Rebet');
  S.hist = h('div', { class: 'cnote', style: 'text-align:center' }, '');
  U.body.append(totalEl, chipBar(S), modes, h('div', { class: 'abar' }, spin, undo, clear, rebet), S.hist, quickToggle());
  total(); stg.wake();
  return {
    onResult(m) {
      const v = m.view; S.balance = m.money; st.res = m;
      st.k = ORDER.indexOf(v.number); st.T = T(5.6); st.rotor0 = st.rotor; st.t0 = performance.now(); st.phase = 'spin'; st.ball = ballAt(0); st.lastTick = -1; st.hi = null; st.rake = -1;
      stg.wake();
    },
    refused() { st.phase = 'rest'; },
    stop() { stg.stop(); },
    redraw() { stg.wake(); },
  };
}
void GOLD; void glowText; void drawChip; void chipColour;
