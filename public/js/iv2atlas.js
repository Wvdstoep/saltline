// Interiors v2 — the material atlas (docs/INTERIORS-V2-CONTRACT.md §5.2, Lane R). One canvas, 8 × 8 tiles (128 px on
// desktop, 64 px on phones) with gutters, drawn procedurally once per session (no image assets). Every interior surface
// samples it through the v2 materials (iv2draw.js): world-scaled UVs wrapped inside the tile in the shader.
//   TILES            [{ id, kind: 'opaque'|'metal'|'emissive'|'cutout', scale }]  (index = atlas slot)
//   tileOf(id)       slot index (aliases resolved); tileRect(id, size) → [u, v, du, dv] of the inner tile
//   atlasCanvas(size) the drawn canvas (cached per size); null without a DOM
const T = (id, kind, scale, draw) => ({ id, kind, scale, draw });
const rng = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const hex = (c) => "#" + c.toString(16).padStart(6, "0");
function shade(c, k) { const r = Math.min(255, Math.max(0, Math.round(((c >> 16) & 255) * k))), g = Math.min(255, Math.max(0, Math.round(((c >> 8) & 255) * k))), b = Math.min(255, Math.max(0, Math.round((c & 255) * k))); return "rgb(" + r + "," + g + "," + b + ")"; }

// drawing helpers: (x = canvas 2d, S = tile px, r = rng)
const fill = (c) => (x, S) => { x.fillStyle = hex(c); x.fillRect(0, 0, S, S); };
const speckle = (c, n, amp, size = 1) => (x, S, r) => { fill(c)(x, S); for (let i = 0; i < n * (S / 64) ** 2; i++) { x.fillStyle = shade(c, 1 + (r() - 0.5) * amp); const s = size * (S / 64); x.fillRect(r() * S, r() * S, s, s); } };
const mottle = (c, amp) => (x, S, r) => { fill(c)(x, S); for (let i = 0; i < 40; i++) { x.fillStyle = shade(c, 1 + (r() - 0.5) * amp); x.globalAlpha = 0.18; const s = (0.1 + r() * 0.4) * S; for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) { x.beginPath(); x.arc(r() * S + ox, r() * S + oy, s, 0, 7); x.fill(); } } x.globalAlpha = 1; };
const lino = (c) => (x, S, r) => { mottle(c, 0.12)(x, S, r); speckle(c, 0, 0)(x, S, r); x.globalAlpha = 0.5; for (let i = 0; i < 260 * (S / 64) ** 2; i++) { x.fillStyle = shade(c, r() < 0.5 ? 0.82 : 1.18); x.fillRect(r() * S, r() * S, S / 64, S / 64); } x.globalAlpha = 1; };
const carpet = (c, pat = null) => (x, S, r) => { fill(c)(x, S); for (let i = 0; i < 1400 * (S / 64) ** 2; i++) { x.fillStyle = shade(c, 1 + (r() - 0.5) * 0.35); x.fillRect(r() * S, r() * S, S / 64, S / 64); } if (pat) pat(x, S, r); };

// High-detail casino carpet (Crimson and gold damask rosettes)
const luxuryCasinoCarpet = (c = 0x5a1218) => (x, S, r) => {
  fill(c)(x, S);
  for (let i = 0; i < 1600 * (S / 64) ** 2; i++) { x.fillStyle = shade(c, 1 + (r() - 0.5) * 0.4); x.fillRect(r() * S, r() * S, S / 64, S / 64); }
  x.strokeStyle = "#d4af37"; x.fillStyle = "#c59b27"; x.lineWidth = Math.max(1.5, S / 48);
  const centers = [[S * 0.25, S * 0.25], [S * 0.75, S * 0.25], [S * 0.25, S * 0.75], [S * 0.75, S * 0.75], [S * 0.5, S * 0.5]];
  for (const [cx, cy] of centers) {
    x.beginPath(); x.arc(cx, cy, S * 0.12, 0, 7); x.stroke();
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      x.beginPath(); x.arc(cx + Math.cos(a) * S * 0.08, cy + Math.sin(a) * S * 0.08, S * 0.035, 0, 7); x.stroke();
    }
    x.beginPath(); x.arc(cx, cy, S * 0.03, 0, 7); x.fill();
  }
};

// High-detail casino felt (Woven baize with golden printed betting arcs & card boxes)
const casinoFelt = (c = 0x084620) => (x, S, r) => {
  fill(c)(x, S);
  x.globalAlpha = 0.25;
  for (let i = 0; i < 900 * (S / 64) ** 2; i++) {
    x.fillStyle = shade(c, 0.75 + r() * 0.5);
    x.fillRect(r() * S, r() * S, Math.max(1, S / 128), Math.max(1, S / 64));
  }
  x.globalAlpha = 1.0;
  x.strokeStyle = "#d4af37";
  x.lineWidth = Math.max(2, S / 36);
  x.beginPath(); x.arc(S / 2, S * 1.1, S * 0.75, Math.PI * 1.15, Math.PI * 1.85); x.stroke();
  x.lineWidth = Math.max(1, S / 64);
  x.beginPath(); x.arc(S / 2, S * 1.1, S * 0.65, Math.PI * 1.18, Math.PI * 1.82); x.stroke();
  for (let k = 0; k < 5; k++) {
    const a = Math.PI * (1.28 + k * 0.11);
    const bx = S / 2 + Math.cos(a) * S * 0.7, by = S * 1.1 + Math.sin(a) * S * 0.7;
    x.strokeRect(bx - S * 0.05, by - S * 0.04, S * 0.1, S * 0.08);
  }
};

// Fine-dining restaurant linen (Ivory damask with jacquard weave border)
const restaurantLinen = (x, S, r) => {
  fill(0xfdfcf7)(x, S);
  x.globalAlpha = 0.35;
  for (let i = 0; i < 700 * (S / 64) ** 2; i++) {
    x.fillStyle = shade(0xf0ece0, 0.9 + r() * 0.2);
    x.fillRect(r() * S, r() * S, 1, 1);
  }
  x.globalAlpha = 1.0;
  x.strokeStyle = "#e2d9c0";
  x.lineWidth = Math.max(1.5, S / 48);
  x.strokeRect(S * 0.08, S * 0.08, S * 0.84, S * 0.84);
  x.strokeRect(S * 0.13, S * 0.13, S * 0.74, S * 0.74);
  x.fillStyle = "#e8dfca";
  for (let i = 0; i < 4; i++) {
    const cx = i % 2 ? S * 0.8 : S * 0.2, cy = i < 2 ? S * 0.2 : S * 0.8;
    x.beginPath(); x.arc(cx, cy, S * 0.04, 0, 7); x.fill();
  }
};

// High-detail slot machine display (Progressive jackpot header, reels, button deck)
const slotScreen = (x, S) => {
  fill(0x0c0f14)(x, S);
  const g = x.createLinearGradient(0, 0, 0, S * 0.28);
  g.addColorStop(0, "#ffd700"); g.addColorStop(0.5, "#ff4500"); g.addColorStop(1, "#8b0000");
  x.fillStyle = g;
  x.fillRect(S * 0.05, S * 0.04, S * 0.9, S * 0.24);
  x.strokeStyle = "#fff"; x.lineWidth = Math.max(1, S / 64);
  x.strokeRect(S * 0.05, S * 0.04, S * 0.9, S * 0.24);
  x.fillStyle = "#ffffff";
  x.font = "bold " + Math.max(8, Math.round(S * 0.09)) + "px Arial, sans-serif";
  x.textAlign = "center"; x.textBaseline = "middle";
  x.fillText("★ 777 JACKPOT ★", S / 2, S * 0.11);
  x.fillStyle = "#ffff66";
  x.font = "bold " + Math.max(9, Math.round(S * 0.10)) + "px monospace";
  x.fillText("$1,250,000", S / 2, S * 0.21);

  const rw = S * 0.26, rh = S * 0.44, ry = S * 0.32;
  for (let k = 0; k < 3; k++) {
    const rx = S * 0.07 + k * (rw + S * 0.04);
    x.fillStyle = "#fefdfa"; x.fillRect(rx, ry, rw, rh);
    x.strokeStyle = "#d4af37"; x.lineWidth = Math.max(1, S / 64); x.strokeRect(rx, ry, rw, rh);
    x.fillStyle = "#d01818";
    x.font = "bold " + Math.max(14, Math.round(S * 0.18)) + "px Georgia, serif";
    x.fillText("7", rx + rw / 2, ry + rh * 0.48);
    x.fillStyle = "#111";
    x.font = "bold " + Math.max(7, Math.round(S * 0.08)) + "px sans-serif";
    x.fillText("BAR", rx + rw / 2, ry + rh * 0.18);
    x.fillStyle = "#ff9900";
    x.fillText("★", rx + rw / 2, ry + rh * 0.82);
  }
  x.strokeStyle = "rgba(255, 30, 30, 0.7)"; x.lineWidth = Math.max(1.5, S / 48);
  x.beginPath(); x.moveTo(S * 0.04, ry + rh * 0.5); x.lineTo(S * 0.96, ry + rh * 0.5); x.stroke();

  x.fillStyle = "#1c2228";
  x.fillRect(S * 0.05, S * 0.8, S * 0.9, S * 0.16);
  for (let b = 0; b < 4; b++) {
    const bx = S * 0.1 + b * S * 0.21;
    x.fillStyle = ["#38b000", "#0077b6", "#ffb703", "#d90429"][b];
    x.beginPath(); x.arc(bx + S * 0.08, S * 0.88, S * 0.05, 0, 7); x.fill();
    x.strokeStyle = "#fff"; x.lineWidth = 1; x.stroke();
  }
};

// Stacked casino chip rack
const chipsTray = (x, S) => {
  fill(0x202428)(x, S);
  const cols = ["#d02028", "#2060d0", "#20a040", "#18181c", "#f0e8d0"];
  const n = cols.length, cw = S / n;
  for (let i = 0; i < n; i++) {
    const col = cols[i];
    for (let j = 0; j < 8; j++) {
      const cy = S * 0.12 + j * S * 0.1;
      x.fillStyle = col; x.fillRect(i * cw + S * 0.02, cy, cw - S * 0.04, S * 0.07);
      x.fillStyle = "#f4f4ea";
      x.fillRect(i * cw + cw * 0.25, cy, cw * 0.12, S * 0.07);
      x.fillRect(i * cw + cw * 0.65, cy, cw * 0.12, S * 0.07);
    }
    x.strokeStyle = "#606870"; x.lineWidth = 1;
    x.strokeRect(i * cw + S * 0.01, S * 0.05, cw - S * 0.02, S * 0.9);
  }
};

// Back-bar illuminated liquor bottles
const bottlesBar = (x, S) => {
  fill(0x181412)(x, S);
  for (let tier = 0; tier < 3; tier++) {
    const ty = S * 0.1 + tier * S * 0.3;
    x.fillStyle = "#f8e59e"; x.fillRect(0, ty + S * 0.24, S, S * 0.03);
    const bcols = ["#b3541e", "#2e7d32", "#c62828", "#1565c0", "#e6a100", "#dcdcdc"];
    for (let k = 0; k < 6; k++) {
      const bx = S * 0.04 + k * S * 0.16;
      const bcol = bcols[(tier * 2 + k) % bcols.length];
      x.fillStyle = bcol; x.fillRect(bx, ty + S * 0.08, S * 0.11, S * 0.16);
      x.fillRect(bx + S * 0.035, ty + S * 0.02, S * 0.04, S * 0.07);
      x.fillStyle = "#d4af37"; x.fillRect(bx + S * 0.03, ty, S * 0.05, S * 0.03);
      x.fillStyle = "#f5eedb"; x.fillRect(bx + S * 0.015, ty + S * 0.12, S * 0.08, S * 0.07);
    }
  }
};

// Polished brass / gold
const brassGold = (x, S, r) => {
  const g = x.createLinearGradient(0, 0, S, S);
  g.addColorStop(0, "#f9e79f"); g.addColorStop(0.3, "#d4af37"); g.addColorStop(0.6, "#b8860b"); g.addColorStop(0.85, "#f5d76e"); g.addColorStop(1, "#996515");
  x.fillStyle = g; x.fillRect(0, 0, S, S);
  mottle(0xd4af37, 0.05)(x, S, r);
};

// Luxury Carrara marble
const luxuryMarble = (x, S, r) => {
  fill(0xf2f0eb)(x, S);
  mottle(0xdcd7cd, 0.14)(x, S, r);
  x.strokeStyle = "#a69e94"; x.lineWidth = Math.max(1, S / 70); x.globalAlpha = 0.45;
  for (let i = 0; i < 6; i++) {
    x.beginPath(); x.moveTo(r() * S, 0); x.bezierCurveTo(r() * S, S * 0.35, r() * S, S * 0.65, r() * S, S); x.stroke();
  }
  x.strokeStyle = "#c8a860"; x.lineWidth = 1; x.globalAlpha = 0.35;
  for (let i = 0; i < 3; i++) {
    x.beginPath(); x.moveTo(0, r() * S); x.bezierCurveTo(S * 0.4, r() * S, S * 0.7, r() * S, S, r() * S); x.stroke();
  }
  x.globalAlpha = 1.0;
};

const tiles = (c, grout, n) => (x, S, r) => { fill(grout)(x, S); const t = S / n, g = Math.max(1, S / 64); for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { x.fillStyle = shade(c, 1 + (r() - 0.5) * 0.08); x.fillRect(i * t + g / 2, j * t + g / 2, t - g, t - g); } };
const planks = (c, seam, n) => (x, S, r) => { fill(c)(x, S); const t = S / n; for (let i = 0; i < n; i++) { x.fillStyle = shade(c, 1 + (r() - 0.5) * 0.18); x.fillRect(i * t, 0, t, S); for (let k = 0; k < 10; k++) { x.strokeStyle = shade(c, 0.85); x.globalAlpha = 0.35; x.beginPath(); const xx = i * t + r() * t; x.moveTo(xx, 0); x.bezierCurveTo(xx + 3, S * 0.3, xx - 3, S * 0.6, xx + 1, S); x.stroke(); } x.globalAlpha = 1; x.fillStyle = hex(seam); x.fillRect(i * t, 0, Math.max(1, S / 80), S); const cut = r() * S; x.fillRect(i * t, cut, t, Math.max(1, S / 100)); } };
const panel = (c, joint, grain = 0) => (x, S, r) => { fill(c)(x, S); if (grain) for (let k = 0; k < 40; k++) { x.strokeStyle = shade(c, 1 - grain * r()); x.globalAlpha = 0.25; x.beginPath(); const xx = r() * S; x.moveTo(xx, 0); x.bezierCurveTo(xx + 4, S * 0.3, xx - 4, S * 0.7, xx, S); x.stroke(); } x.globalAlpha = 1; x.fillStyle = hex(joint); x.fillRect(0, 0, Math.max(1, S / 64), S); x.fillStyle = shade(c, 1.08); x.fillRect(Math.max(1, S / 64), 0, Math.max(1, S / 128), S); };
const brushed = (c) => (x, S, r) => { mottle(c, 0.05)(x, S, r); x.globalAlpha = 0.5; for (let i = 0; i < 90 * (S / 64); i++) { x.fillStyle = shade(c, 1 + (r() - 0.5) * 0.07); const w = S * (0.2 + r() * 0.6); x.fillRect(r() * S, r() * S, w, Math.max(1, S / 128)); } x.globalAlpha = 1; };
const paint = (c) => (x, S, r) => { mottle(c, 0.06)(x, S, r); };
const chequer = (c) => (x, S, r) => { brushed(c)(x, S, r); const n = 6, t = S / n; for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const cx = (i + 0.5) * t, cy = (j + 0.5) * t, a = (i + j) % 2 ? 0.6 : -0.6; x.save(); x.translate(cx, cy); x.rotate(a); x.fillStyle = shade(c, 1.25); x.fillRect(-t * 0.32, -t * 0.07, t * 0.64, t * 0.14); x.fillStyle = shade(c, 0.7); x.fillRect(-t * 0.32, t * 0.04, t * 0.64, t * 0.04); x.restore(); } };
const grating = (c) => (x, S) => { x.fillStyle = "#16191b"; x.fillRect(0, 0, S, S); const n = 6, t = S / n; for (let i = 0; i < n; i++) { x.fillStyle = hex(c); x.fillRect(i * t, 0, Math.max(2, t * 0.34), S); x.fillStyle = shade(c, 1.35); x.fillRect(i * t, 0, Math.max(1, t * 0.08), S); } for (let j = 0; j < 2; j++) { x.fillStyle = shade(c, 0.9); x.fillRect(0, j * S / 2, S, Math.max(2, t * 0.26)); } };
const ceilPanel = (c) => (x, S, r) => { fill(c)(x, S); x.fillStyle = shade(c, 0.86); x.fillRect(0, 0, S, Math.max(1, S / 64)); x.fillRect(0, 0, Math.max(1, S / 64), S); for (let i = 0; i < 160; i++) { x.fillStyle = shade(c, 0.92); x.fillRect(r() * S, r() * S, S / 128 + 0.5, S / 128 + 0.5); } };
const screen = (bg, fg, kind) => (x, S, r) => { fill(bg)(x, S); x.strokeStyle = hex(fg); x.fillStyle = hex(fg); x.lineWidth = Math.max(1, S / 96);
  if (kind === "radar") { x.beginPath(); x.arc(S / 2, S / 2, S * 0.44, 0, 7); x.stroke(); x.beginPath(); x.arc(S / 2, S / 2, S * 0.22, 0, 7); x.stroke(); x.beginPath(); x.moveTo(S / 2, S / 2); x.lineTo(S * 0.85, S * 0.2); x.stroke(); for (let i = 0; i < 30; i++) x.fillRect(S / 2 + (r() - 0.5) * S * 0.7, S / 2 + (r() - 0.5) * S * 0.7, S / 40, S / 40); }
  else if (kind === "ecdis") { x.fillStyle = "#d9e8f2"; x.fillRect(0, 0, S, S); x.fillStyle = "#e8d9a8"; x.beginPath(); x.moveTo(0, S * 0.6); x.bezierCurveTo(S * 0.3, S * 0.5, S * 0.5, S * 0.9, S, S * 0.7); x.lineTo(S, S); x.lineTo(0, S); x.fill(); x.strokeStyle = "#b03030"; x.beginPath(); x.moveTo(S * 0.1, S * 0.2); x.lineTo(S * 0.5, S * 0.4); x.lineTo(S * 0.9, S * 0.3); x.stroke(); x.fillStyle = "#20406a"; x.fillRect(0, 0, S, S * 0.08); }
  else if (kind === "conning") { for (let i = 0; i < 3; i++) { x.beginPath(); x.arc(S * (0.2 + i * 0.3), S * 0.35, S * 0.12, Math.PI, 0); x.stroke(); } x.fillRect(S * 0.1, S * 0.65, S * 0.8, S * 0.04); x.fillRect(S * 0.1, S * 0.78, S * 0.5, S * 0.04); }
  else if (kind === "ams") { for (let i = 0; i < 6; i++) { x.strokeRect(S * (0.08 + (i % 3) * 0.3), S * (0.15 + Math.floor(i / 3) * 0.4), S * 0.22, S * 0.25); } x.beginPath(); x.moveTo(S * 0.3, S * 0.27); x.lineTo(S * 0.38, S * 0.27); x.moveTo(S * 0.6, S * 0.27); x.lineTo(S * 0.68, S * 0.27); x.stroke(); x.fillStyle = "#e05a3a"; x.fillRect(S * 0.82, S * 0.82, S * 0.08, S * 0.08); } };
const gauges = (c) => (x, S, r) => { fill(c)(x, S); for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) { const cx = S * (0.2 + i * 0.3), cy = S * (0.25 + j * 0.45); x.fillStyle = "#f2f2ea"; x.beginPath(); x.arc(cx, cy, S * 0.1, 0, 7); x.fill(); x.strokeStyle = "#222"; x.lineWidth = Math.max(1, S / 128); x.stroke(); x.beginPath(); x.moveTo(cx, cy); x.lineTo(cx + Math.cos(r() * 3 + 3.5) * S * 0.08, cy + Math.sin(r() * 3 + 3.5) * S * 0.08); x.strokeStyle = "#c03030"; x.stroke(); x.fillStyle = r() < 0.5 ? "#3ad050" : "#e0b030"; x.fillRect(cx - S * 0.03, cy + S * 0.14, S * 0.06, S * 0.04); } };
const consoleFace = (c) => (x, S, r) => { brushed(c)(x, S, r); for (let i = 0; i < 6; i++) for (let j = 0; j < 4; j++) { x.fillStyle = ["#2a2f33", "#3d4247", "#c8a030", "#3a8a40", "#a03030"][Math.floor(r() * 5)]; x.fillRect(S * (0.08 + i * 0.15), S * (0.1 + j * 0.22), S * 0.08, S * 0.08); } };
const sign = (bg, fg, draw) => (x, S, r) => { fill(bg)(x, S); x.fillStyle = hex(fg); x.strokeStyle = hex(fg); x.lineWidth = Math.max(1, S / 40); draw(x, S, r); };
const stripes = (a, b) => (x, S) => { fill(a)(x, S); x.fillStyle = hex(b); for (let i = -2; i < 6; i++) { x.beginPath(); x.moveTo(i * S / 4, 0); x.lineTo(i * S / 4 + S / 8, 0); x.lineTo(i * S / 4 + S / 8 + S, S); x.lineTo(i * S / 4 + S, S); x.fill(); } };
const books = (x, S, r) => { fill(0x4a3420)(x, S); const rows = 4, h = S / rows; for (let j = 0; j < rows; j++) { let xx = 0; while (xx < S) { const w = S * (0.03 + r() * 0.05); x.fillStyle = ["#7a2a2a", "#2a4a7a", "#2a6a3a", "#c8b070", "#5a3a6a", "#d0d0c0", "#1a1a1a"][Math.floor(r() * 7)]; x.fillRect(xx, j * h + h * (0.1 + r() * 0.15), w - 1, h * 0.8); xx += w; } x.fillStyle = "#3a2814"; x.fillRect(0, j * h + h * 0.9, S, h * 0.1); } };
const boxes = (x, S, r) => { fill(0x5a5a52)(x, S); for (let i = 0; i < 9; i++) { x.fillStyle = shade(0xb08850, 0.8 + r() * 0.4); const w = S * (0.2 + r() * 0.2), h = S * (0.15 + r() * 0.2); x.fillRect(r() * (S - w), r() * (S - h), w, h); x.fillStyle = "#d8d0b8"; x.fillRect(r() * S, r() * S, S * 0.08, S * 0.04); } };
const notice = (x, S, r) => { fill(0xa07848)(x, S); for (let i = 0; i < 7; i++) { x.fillStyle = ["#f4f0e0", "#fff8c0", "#e0f0ff", "#ffffff"][Math.floor(r() * 4)]; const w = S * (0.2 + r() * 0.15), h = S * (0.25 + r() * 0.2), px = r() * (S - w), py = r() * (S - h); x.fillRect(px, py, w, h); x.fillStyle = "#555"; for (let k = 0; k < 4; k++) x.fillRect(px + w * 0.1, py + h * (0.2 + k * 0.18), w * 0.7, Math.max(1, S / 128)); x.fillStyle = "#c03030"; x.fillRect(px + w / 2 - 1, py + 1, 3, 3); } };
const art = (x, S, r) => { fill(0x3a2a1a)(x, S); const g = x.createLinearGradient ? x.createLinearGradient(0, 0, 0, S) : null; if (g) { g.addColorStop(0, "#8ab0d0"); g.addColorStop(0.55, "#d8c8a0"); g.addColorStop(0.56, "#2a5a7a"); g.addColorStop(1, "#1a3a5a"); x.fillStyle = g; } else x.fillStyle = "#6a8aa0"; x.fillRect(S * 0.08, S * 0.08, S * 0.84, S * 0.84); x.fillStyle = "#f0f0f0"; x.beginPath(); x.moveTo(S * 0.45, S * 0.55); x.lineTo(S * 0.5, S * 0.3); x.lineTo(S * 0.58, S * 0.55); x.fill(); x.fillStyle = "#3a2a20"; x.fillRect(S * 0.35, S * 0.55, S * 0.3, S * 0.05); void r; };
const chart = (x, S, r) => { fill(0xeee8d0)(x, S); x.fillStyle = "#d8c890"; x.beginPath(); x.moveTo(0, S * 0.3); x.bezierCurveTo(S * 0.3, S * 0.2, S * 0.4, S * 0.6, S * 0.2, S); x.lineTo(0, S); x.fill(); x.strokeStyle = "#7090b0"; x.lineWidth = 1; for (let i = 0; i < 6; i++) { x.beginPath(); x.arc(S * 0.6, S * 0.5, S * (0.1 + i * 0.06), 0, 7); x.stroke(); } x.strokeStyle = "#c03030"; x.beginPath(); x.moveTo(S * 0.3, S * 0.8); x.lineTo(S * 0.9, S * 0.15); x.stroke(); void r; };
const toolboard = (x, S, r) => { fill(0x9a8a6a)(x, S); x.fillStyle = "#6a5a3a"; for (let i = 0; i < 16; i++) for (let j = 0; j < 16; j++) x.fillRect(i * S / 16 + 2, j * S / 16 + 2, 1, 1); for (let i = 0; i < 10; i++) { x.fillStyle = ["#c03030", "#303030", "#909090", "#e0b020"][Math.floor(r() * 4)]; x.fillRect(r() * S * 0.9, r() * S * 0.8, S * 0.04, S * (0.12 + r() * 0.15)); } };
const plantLeaf = (x, S, r) => { fill(0x2a5a28)(x, S); for (let i = 0; i < 60; i++) { x.fillStyle = shade(0x3a7a30, 0.7 + r() * 0.6); x.beginPath(); x.ellipse ? x.ellipse(r() * S, r() * S, S * 0.08, S * 0.03, r() * 3, 0, 7) : x.arc(r() * S, r() * S, S * 0.05, 0, 7); x.fill(); } };
const bedding = (x, S, r) => { fill(0xeef0f2)(x, S); x.fillStyle = "#2c4f7c"; x.fillRect(0, S * 0.35, S, S * 0.65); x.fillStyle = "#3a6090"; for (let i = 0; i < 8; i++) x.fillRect(0, S * (0.4 + i * 0.075), S, Math.max(1, S / 128)); void r; };
const rope = (x, S, r) => { fill(0xb89a5a)(x, S); x.strokeStyle = "#8a7040"; x.lineWidth = Math.max(1, S / 32); for (let i = -4; i < 8; i++) { x.beginPath(); x.moveTo(i * S / 4, 0); x.lineTo(i * S / 4 + S / 2, S); x.stroke(); } void r; };
const light = (x, S) => { fill(0xfff8ea)(x, S); x.fillStyle = "#f5ecd6"; for (let i = 0; i < 4; i++) x.fillRect(0, i * S / 4, S, Math.max(1, S / 64)); };

/** Atlas slots (<= 64). scale = metres per repeat (world-scaled UVs). */
export const TILES = Object.freeze([
  // floors (15)
  T("lino_grey", "opaque", 1.2, lino(0x8a9095)),
  T("carpet_pax", "opaque", 1.2, luxuryCasinoCarpet(0x5a1218)),
  T("vinyl_dark", "opaque", 1.2, lino(0x41474c)),
  T("carpet", "opaque", 0.8, carpet(0x3f4f63)),
  T("carpet_corr", "opaque", 1.6, carpet(0x2e3f66, (x, S) => { x.strokeStyle = "#c8a860"; x.lineWidth = Math.max(1, S / 64); x.strokeRect(S * 0.1, S * 0.1, S * 0.8, S * 0.8); x.beginPath(); x.moveTo(S / 2, S * 0.2); x.lineTo(S * 0.8, S / 2); x.lineTo(S / 2, S * 0.8); x.lineTo(S * 0.2, S / 2); x.closePath(); x.stroke(); })),
  T("stone", "opaque", 1.6, luxuryMarble),
  T("quarry", "opaque", 0.6, tiles(0xa45a3a, 0x5a4a40, 2)),
  T("tile_wet", "opaque", 0.6, tiles(0xe8ecee, 0xa0a8ac, 4)),
  T("restaurant_linen", "opaque", 0.8, restaurantLinen),
  T("teak", "opaque", 1.0, planks(0xa77a4a, 0x1a1a1a, 6)),
  T("deck", "opaque", 2.0, mottle(0x5f6d63, 0.15)),
  T("chequer", "metal", 0.5, chequer(0x7d8387)),
  T("grating", "metal", 0.6, grating(0x5b6164)),
  T("rubber", "opaque", 1.0, speckle(0x2a2c2e, 300, 0.6)),
  T("console_body", "metal", 1.0, brushed(0x4a5056)),
  // casino surfaces (2)
  T("felt", "opaque", 0.8, casinoFelt(0x084620)),
  T("felt_red", "opaque", 0.8, casinoFelt(0x741620)),
  // walls (14)
  T("laminate", "opaque", 0.6, panel(0xd9dcda, 0xaeb2b2)),
  T("laminate_cream", "opaque", 0.6, panel(0xdcd2bc, 0xb2a892)),
  T("veneer", "opaque", 0.9, panel(0x9b7650, 0x5a4026, 0.25)),
  T("veneer_dark", "opaque", 0.9, panel(0x422415, 0x221108, 0.45)),
  T("stainless", "metal", 0.8, brushed(0x9ea4a8)),
  T("brass_gold", "metal", 0.6, brassGold),
  T("paint_er", "opaque", 1.5, paint(0xa4b49c)),
  T("paint_grey", "opaque", 1.5, paint(0x9aa2a8)),
  T("paint_white", "opaque", 1.5, paint(0xdcdeda)),
  T("paint_red", "opaque", 1.0, paint(0xb8352a)),
  T("paint_blue", "opaque", 1.0, paint(0x2c5c96)),
  T("paint_yellow", "opaque", 1.0, paint(0xe0b020)),
  T("paint_orange", "opaque", 1.0, paint(0xe0641c)),
  T("paint_green", "opaque", 1.0, paint(0x2f7a46)),
  // ceilings (2)
  T("ceil_panel", "opaque", 0.6, ceilPanel(0xdedfda)),
  T("ceil_coffered", "opaque", 2.4, (x, S, r) => { ceilPanel(0xe8e0d0)(x, S, r); x.strokeStyle = "#b8a888"; x.lineWidth = Math.max(2, S / 24); x.strokeRect(S * 0.08, S * 0.08, S * 0.84, S * 0.84); }),
  // equipment faces (6)
  T("console", "metal", 0.6, consoleFace(0x3a4046)),
  T("gauges", "opaque", 0.9, gauges(0x8a9298)),
  T("engine_green", "metal", 1.5, brushed(0x3a6e50)),
  T("engine_grey", "metal", 1.5, brushed(0x6e767b)),
  T("metal_brushed", "metal", 0.8, brushed(0x878d91)),
  T("rubber_black", "opaque", 0.6, speckle(0x202224, 120, 0.4)),
  // furniture & casino props (15)
  T("wood_furn", "opaque", 0.8, panel(0x8a6440, 0x5a3e24, 0.3)),
  T("fabric_blue", "opaque", 0.5, carpet(0x34507a)),
  T("fabric_red", "opaque", 0.5, carpet(0x8a3232)),
  T("fabric_grey", "opaque", 0.5, carpet(0x6a6e72)),
  T("leather", "opaque", 0.5, mottle(0x261d18, 0.25)),
  T("chips_tray", "opaque", 0.6, chipsTray),
  T("bedding", "opaque", 1.0, bedding),
  T("books", "opaque", 1.0, books),
  T("notice", "opaque", 0.9, notice),
  T("art", "opaque", 1.0, art),
  T("chart", "opaque", 1.2, chart),
  T("toolboard", "opaque", 1.0, toolboard),
  T("leaf", "opaque", 0.5, plantLeaf),
  T("rope", "opaque", 0.4, rope),
  T("hazard", "opaque", 0.6, stripes(0xe0b020, 0x1a1a1a)),
  // emissive (10)
  T("light", "emissive", 0.6, light),
  T("slot_reels", "emissive", 0.8, slotScreen),
  T("bottles_bar", "emissive", 0.8, bottlesBar),
  T("screen_radar", "emissive", 1, screen(0x05140a, 0x3ae060, "radar")),
  T("screen_ecdis", "emissive", 1, screen(0x0a1a2a, 0x80c0ff, "ecdis")),
  T("screen_conning", "emissive", 1, screen(0x081420, 0x60d0ff, "conning")),
  T("screen_ams", "emissive", 1, screen(0x0a1018, 0x60e080, "ams")),
  T("screen_off", "opaque", 1, fill(0x111417)),
  T("sign_exit", "emissive", 1, sign(0x1a9a40, 0xffffff, (x, S) => { x.fillRect(S * 0.15, S * 0.3, S * 0.25, S * 0.4); x.beginPath(); x.arc(S * 0.62, S * 0.25, S * 0.07, 0, 7); x.fill(); x.beginPath(); x.moveTo(S * 0.6, S * 0.35); x.lineTo(S * 0.5, S * 0.6); x.lineTo(S * 0.62, S * 0.75); x.moveTo(S * 0.55, S * 0.5); x.lineTo(S * 0.75, S * 0.6); x.moveTo(S * 0.5, S * 0.6); x.lineTo(S * 0.4, S * 0.8); x.stroke(); })),
  T("sign_deck", "opaque", 1, sign(0x1f3d6a, 0xffffff, (x, S) => { x.fillRect(S * 0.1, S * 0.45, S * 0.8, S * 0.08); x.fillRect(S * 0.1, S * 0.25, S * 0.3, S * 0.1); })),
]);

/** Ids that map onto a slot (materials named by function in the plan / SCALE table). */
export const ALIAS = {
  wood: "veneer", lino_blue: "lino_grey", lino_beige: "lino_grey", lino_green: "lino_grey",
  vinyl_heavy: "vinyl_dark", carpet_th: "carpet_pax", casino_carpet: "carpet_pax",
  alu_chequer: "chequer", epoxy: "paint_er", veneer_light: "veneer", mahogany: "veneer_dark",
  laminate_grey: "laminate", insulated: "laminate", canvas: "wood_furn", cardboard: "wood_furn",
  glass_tile: "paint_white", vinyl: "lino_grey", steel: "paint_grey", painted: "paint_grey",
  fabric: "fabric_red", mattress: "bedding", screen: "screen_ecdis", light_diffuser: "light",
  marble: "stone", paint_brown: "paint_orange", paint_lightblue: "paint_blue",
  sign_fireplan: "sign_deck", sign_muster: "sign_deck", paint_green_sign: "sign_deck",
  tablecloth: "restaurant_linen", porcelain: "restaurant_linen", brass: "brass_gold"
};
export const TILE_INDEX = new Map(TILES.map((t, i) => [t.id, i]));
export function tileOf(id) { return TILE_INDEX.get(id) ?? TILE_INDEX.get(ALIAS[id]) ?? TILE_INDEX.get("paint_grey"); }
export const GRID = 8;
/** [u0, v0, du, dv] of the tile's inner area (gutters excluded); v up (canvas row 0 at the top). */
export function tileRect(id, size = 1024) {
  const i = typeof id === "number" ? id : tileOf(id), T0 = size / GRID, g = Math.max(2, T0 / 32);
  const col = i % GRID, row = Math.floor(i / GRID);
  return [(col * T0 + g) / size, 1 - ((row + 1) * T0 - g) / size, (T0 - 2 * g) / size, (T0 - 2 * g) / size];
}
const cache = new Map();
/** The atlas canvas (cached per size): every tile drawn into its inner area, wrapped copies in the gutters. */
export function atlasCanvas(size = 1024) {
  if (cache.has(size)) return cache.get(size);
  if (typeof document === "undefined") return null;
  const T0 = size / GRID, g = Math.max(2, T0 / 32), inner = T0 - 2 * g;
  const c = document.createElement("canvas"); c.width = size; c.height = size;
  const x = c.getContext("2d"); if (!x) return null;
  const tc = document.createElement("canvas"); tc.width = inner; tc.height = inner;
  const tx = tc.getContext("2d");
  TILES.forEach((t, i) => {
    const col = i % GRID, row = Math.floor(i / GRID);
    tx.clearRect?.(0, 0, inner, inner); tx.globalAlpha = 1;
    try { t.draw(tx, inner, rng(1000 + i * 77)); } catch (e) { tx.fillStyle = "#888"; tx.fillRect(0, 0, inner, inner); }
    const ox = col * T0 + g, oy = row * T0 + g;
    for (const dx of [-inner, 0, inner]) for (const dy of [-inner, 0, inner]) {
      x.save?.(); x.beginPath?.(); x.rect?.(col * T0, row * T0, T0, T0); x.clip?.();
      x.drawImage?.(tc, ox + dx, oy + dy);
      x.restore?.();
    }
  });
  cache.set(size, c);
  return c;
}
