// Radar map underlay + traffic / label controls (player request: "show the actual map under the radar, and let me turn
// the traffic off — Rotterdam is a pile of unreadable labels").
//
// Map: the radar samples what the client already holds for the 3D world — harbour patch masks (10 m, quays,
// breakwaters, fairways, shoals), D14 world-tile masks (~2.4 m, docks, rivers, locks, buildings) and the L1 / L0 height
// rasters as the fallback (land / water + depth) — into a small north-up grid (96–176 cells) around the ship, with a
// coastline pass on top. Building runs a few rows per radar frame inside a time budget (phones: smaller grid and budget),
// so it never stalls a frame. The last finished grid is kept with its own centre and extent and simply translated /
// rotated / scaled under the radar each frame (north-up and head-up, any range); a new one is started only when the ship
// has moved 18 % of the range from its centre, the range changed or new map data arrived — at most twice a second.
// No network: OSM tiles are not used (offline-safe, nothing to wait for).
//
// Controls (a small button row under the radar; on touch a single layers button opening the same three as a popover):
//   Map on/off · Ships: all / players / AIS / off · Names: few (nearest, collision-free) / all (collision-free) / off.
// Choices persist in localStorage `saltline.radar` (try/catch: private windows work, with the defaults).
//
// Integration (hud.js drawRadar): `rm.drawUnderlay(...)` before the rings, `rm.filterContacts(all)` for the contact loop
// and `rm.beginLabels(...)` / `.at(c, d)` / `.flush()` around it: while the loop runs, ctx.fillText is captured so the
// labels the loop would draw are collected and then placed (priority, nearest first, no overlaps, inside the circle).
// The pure helpers below are exported for tests (test/radarmap.test.mjs).

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const M_LAT = 110574, M_LON = 111320, EARTH_R = 6371000; // = shared/constants.js GEO (kept import-free for node tests)
const STORE_KEY = 'saltline.radar';

export const MASK = { WATER: 0, LAND: 1, QUAY: 2, BREAKWATER: 3, PONTOON: 4, FAIRWAY: 5, SHALLOW: 6, DOCK: 7, RIVER: 8, LOCK: 9, BUILDING: 10, UNKNOWN: 255 };
export const TRAFFIC_MODES = ['all', 'players', 'ais', 'off'];
export const LABEL_MODES = ['auto', 'all', 'off'];
export const DEFAULTS = Object.freeze({ map: true, traffic: 'all', labels: 'auto' });
export const TUNE = {
  MARGIN: 1.25,        // the grid covers ±1.25 × range: the ship may drift 18 % before a rebuild, any rotation stays covered
  MOVE_FRAC: 0.18,
  MIN_BUILD_MS: 500,   // ≤ 2 rebuilds per second
  DATA_BUILD_MS: 2500, // new map data streaming in: rebuild at most this often for it
  BUDGET_MS: 5, BUDGET_MS_PHONE: 3,
  AUTO_TRAFFIC: 4, AUTO_TRAFFIC_SMALL: 2, AUTO_PLACES: 3,
};

// ------------------------------------------------------------------------------------------------ prefs
export function loadPrefs(storage) {
  const p = { ...DEFAULTS };
  try {
    const raw = storage?.getItem(STORE_KEY);
    const j = raw ? JSON.parse(raw) : null;
    if (j && typeof j === 'object') {
      if (typeof j.map === 'boolean') p.map = j.map;
      if (TRAFFIC_MODES.includes(j.traffic)) p.traffic = j.traffic;
      if (LABEL_MODES.includes(j.labels)) p.labels = j.labels;
    }
  } catch { /* storage blocked / bad JSON: defaults */ }
  return p;
}
export function savePrefs(storage, p) {
  try { storage?.setItem(STORE_KEY, JSON.stringify({ map: !!p.map, traffic: p.traffic, labels: p.labels })); return true; } catch { return false; }
}
export const nextMode = (list, cur) => list[(list.indexOf(cur) + 1) % list.length];

// ------------------------------------------------------------------------------------------------ traffic
/** 'player' for other skippers, 'ais' for AI / live AIS / fleet vessels, null for everything else (harbours, jobs …). */
export function trafficSource(c) { return c?.kind === 'ship' ? 'player' : c?.kind === 'ai' || c?.kind === 'ais' ? 'ais' : null; }
export function filterContacts(list, mode) {
  if (mode === 'all' || !TRAFFIC_MODES.includes(mode)) return list;
  return list.filter((c) => { const s = trafficSource(c); return !s || (mode === 'players' ? s === 'player' : mode === 'ais' ? s === 'ais' : false); });
}

// ------------------------------------------------------------------------------------------------ colours
const WATER_SHOAL = [30, 88, 112], WATER_DEEP = [12, 46, 72]; // deep water stays distinguishable from the radar background
const FIXED = {
  [MASK.LAND]: [46, 56, 44], [MASK.BUILDING]: [64, 70, 62], [MASK.QUAY]: [112, 116, 108], [MASK.BREAKWATER]: [104, 106, 100],
  [MASK.PONTOON]: [92, 104, 116], [MASK.LOCK]: [150, 116, 58], [MASK.SHALLOW]: [40, 104, 118], [MASK.FAIRWAY]: [22, 74, 116],
};
const COAST = [120, 205, 180];
export const isWaterCode = (m) => m === MASK.WATER || m === MASK.FAIRWAY || m === MASK.SHALLOW || m === MASK.DOCK || m === MASK.RIVER || m === MASK.LOCK;
/** RGB(A) of one grid cell from its mask code and height (m, water negative); alpha 0 where nothing is known. */
export function cellColor(mask, h) {
  if (mask === MASK.UNKNOWN || mask == null) return [0, 0, 0, 0];
  const f = FIXED[mask];
  if (f) return [f[0], f[1], f[2], 235];
  // open water, docks, rivers: shade by depth (0 → shoal colour, 30 m and deeper → deep colour)
  const t = Number.isFinite(h) ? Math.max(0, Math.min(1, -h / 30)) : 0.6;
  return [Math.round(WATER_SHOAL[0] + (WATER_DEEP[0] - WATER_SHOAL[0]) * t), Math.round(WATER_SHOAL[1] + (WATER_DEEP[1] - WATER_SHOAL[1]) * t), Math.round(WATER_SHOAL[2] + (WATER_DEEP[2] - WATER_SHOAL[2]) * t), 235];
}

// ------------------------------------------------------------------------------------------------ grid
/** Local metres (east, north) of a point relative to a centre (equirectangular about the centre's latitude). */
export function toEN(lat0, lon0, lat, lon) {
  let dl = lon - lon0; if (dl > 180) dl -= 360; else if (dl < -180) dl += 360;
  return { e: dl * M_LON * Math.cos(lat0 * D2R), n: (lat - lat0) * M_LAT };
}
/**
 * One map grid: G×G cells north-up around (lat, lon), half-extent `half` metres. `sample(lat, lon)` → { m, h }.
 * step(budgetMs) fills rows until the budget is used; when the last row is done it draws the coastline and is `done`.
 */
export class MapGrid {
  constructor(lat, lon, half, G, sample, stamp = '') {
    Object.assign(this, { lat, lon, half, G, sample, stamp });
    this.rgba = new Uint8ClampedArray(G * G * 4);
    this.water = new Uint8Array(G * G);      // 0 unknown, 1 water, 2 land / structure
    this.row = 0; this.done = false; this.known = 0;
  }
  step(budgetMs = 5, now = () => performance.now()) {
    const t0 = now(), G = this.G, cell = (2 * this.half) / G, kLon = 1 / (M_LON * Math.cos(this.lat * D2R));
    while (this.row < G) {
      const j = this.row++, nM = this.half - (j + 0.5) * cell, la = this.lat + nM / M_LAT;
      for (let i = 0; i < G; i++) {
        const eM = -this.half + (i + 0.5) * cell;
        const s = this.sample(la, this.lon + eM * kLon) || {};
        const m = s.m ?? MASK.UNKNOWN, c = cellColor(m, s.h), o = (j * G + i) * 4;
        this.rgba[o] = c[0]; this.rgba[o + 1] = c[1]; this.rgba[o + 2] = c[2]; this.rgba[o + 3] = c[3];
        this.water[j * G + i] = m === MASK.UNKNOWN ? 0 : isWaterCode(m) ? 1 : 2;
        if (m !== MASK.UNKNOWN) this.known++;
      }
      if (now() - t0 > budgetMs) break;
    }
    if (this.row >= G && !this.done) { this.coast(); this.done = true; }
    return this.done;
  }
  /** Land cells touching water get the coastline colour (one cell wide, so it stays crisp when scaled). */
  coast() {
    const G = this.G, w = this.water, px = this.rgba;
    for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
      const k = j * G + i; if (w[k] !== 2) continue;
      if ((i > 0 && w[k - 1] === 1) || (i < G - 1 && w[k + 1] === 1) || (j > 0 && w[k - G] === 1) || (j < G - 1 && w[k + G] === 1)) {
        px[k * 4] = COAST[0]; px[k * 4 + 1] = COAST[1]; px[k * 4 + 2] = COAST[2]; px[k * 4 + 3] = 255;
      }
    }
  }
}
/** Does a finished grid still serve this view? */
export function gridFits(g, lat, lon, rangeM) {
  if (!g) return false;
  const d = toEN(g.lat, g.lon, lat, lon);
  return Math.abs(g.half - rangeM * TUNE.MARGIN) < 1 && Math.hypot(d.e, d.n) <= rangeM * TUNE.MOVE_FRAC;
}

// ------------------------------------------------------------------------------------------------ labels
const RANK = { wp: 0, berth: 0, job: 1, rescue: 1, ship: 2, cutter: 2, harbor: 3, platform: 4, ai: 5, ais: 5 };
const ESSENTIAL = new Set(['wp', 'berth', 'job']);
/**
 * Choose and place labels. items: { text, x, y, w, h, ax, ay, kind, d } (x/y = where the caller wanted the label
 * centre, ax/ay = the marker, d = distance). Returns the placed ones with their final x/y. Essential labels (waypoints,
 * the berth, contracts) are always kept; mode 'off' keeps only those, 'auto' also caps traffic and place names to the
 * nearest few. Every other label tries above / below / right / left / the four diagonals of its marker and is dropped if all overlap or leave
 * the circle (radius rr around 0,0).
 */
export function placeLabels(items, { mode = 'auto', rr = 100, small = false } = {}) {
  const order = items.map((it, i) => ({ ...it, i, rank: RANK[it.kind] ?? 4 })).sort((a, b) => a.rank - b.rank || a.d - b.d || a.i - b.i);
  const boxes = [{ x0: -7, y0: -7, x1: 7, y1: 7 }];      // the own-ship marker
  const out = [];
  let traffic = 0, places = 0, triedT = 0;
  const capT = small ? TUNE.AUTO_TRAFFIC_SMALL : TUNE.AUTO_TRAFFIC;
  for (const it of order) {
    const essential = ESSENTIAL.has(it.kind), isTraffic = it.kind === 'ai' || it.kind === 'ais' || it.kind === 'ship';
    if (!essential) {
      if (mode === 'off') continue;
      if (mode === 'auto' && isTraffic && (traffic >= capT || triedT++ >= 2 * capT)) continue; // only the nearest few are candidates
      if (mode === 'auto' && !isTraffic && places >= TUNE.AUTO_PLACES) continue;
    }
    const dy = it.y - it.ay, gap = Math.max(6, Math.abs(dy) - it.h / 2);
    const below = dy < 0 ? it.ay - dy : it.ay + gap + it.h / 2;
    const sx = gap + it.w / 2, sy = gap + it.h / 2;
    const cands = [[it.x, it.y], [it.ax, below], [it.ax + sx, it.ay], [it.ax - sx, it.ay], [it.ax + sx, it.ay - sy], [it.ax - sx, it.ay - sy], [it.ax + sx, it.ay + sy], [it.ax - sx, it.ay + sy]];
    let best = null;
    for (const [x, y] of cands) {
      const b = { x0: x - it.w / 2 - 1, y0: y - it.h / 2, x1: x + it.w / 2 + 1, y1: y + it.h / 2 };
      const far = Math.max(Math.hypot(b.x0, b.y0), Math.hypot(b.x1, b.y0), Math.hypot(b.x0, b.y1), Math.hypot(b.x1, b.y1));
      if (far > rr + 2) continue;
      if (boxes.some((o) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0)) continue;
      best = { x, y, b }; break;
    }
    if (!best && essential) best = { x: it.x, y: it.y, b: { x0: it.x - it.w / 2, y0: it.y - it.h / 2, x1: it.x + it.w / 2, y1: it.y + it.h / 2 } };
    if (!best) continue;
    boxes.push(best.b);
    if (isTraffic) traffic++; else if (!essential) places++;
    out.push({ ...it, x: best.x, y: best.y });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ vector structures
export const SEG_STYLE = { quay: { color: 'rgb(176,180,170)', min: 1.4 }, deck: { color: 'rgb(214,226,236)', min: 1.2 }, gang: { color: 'rgb(170,160,140)', min: 0.8 }, finger: { color: 'rgb(190,204,214)', min: 0.6 } };
/**
 * Draw structure outlines ({ a: [lat, lon], b, w, k }) north-up around `me` at k px per metre (the caller has rotated the
 * context). Width = the real width at this scale, at least SEG_STYLE.min px; segments wholly outside the radius rr are
 * skipped; finger piers only when they are at least 0.35 px wide (close ranges). Returns how many were drawn.
 */
export function drawSegments(ctx, me, segs, k, rr = Infinity) {
  let n = 0;
  ctx.lineCap = 'butt';
  for (const s of segs) {
    const st = SEG_STYLE[s.k] || SEG_STYLE.deck;
    if (s.k === 'finger' && s.w * k < 0.35) continue;
    const a = toEN(me.lat, me.lon, s.a[0], s.a[1]), b = toEN(me.lat, me.lon, s.b[0], s.b[1]);
    const ax = a.e * k, ay = -a.n * k, bx = b.e * k, by = -b.n * k;
    if (Math.min(Math.hypot(ax, ay), Math.hypot(bx, by)) > rr + 4 && Math.hypot((ax + bx) / 2, (ay + by) / 2) > rr + 4) continue;
    ctx.strokeStyle = st.color; ctx.lineWidth = Math.max(st.min, (s.w || 1) * k);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); n++;
  }
  return n;
}

function polarOf(me, c) {
  if (c.polar) return { brg: c.polar.brg, d: c.polar.d };
  const p1 = me.lat * D2R, p2 = c.lat * D2R, dl = (c.lon - me.lon) * D2R;
  const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const d = 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
  const brg = (Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) * R2D + 360) % 360;
  return { brg, d };
}

// ------------------------------------------------------------------------------------------------ the radar layer
export class RadarMap {
  constructor(app, opts = {}) {
    this.app = app;
    this.storage = opts.storage !== undefined ? opts.storage : (() => { try { return window.localStorage; } catch { return null; } })();
    this.prefs = loadPrefs(this.storage);
    this.grid = null; this.building = null; this.lastStart = -1e9; this.lastDataStamp = ''; this.lastDataBuild = -1e9;
    this.canvas = null;
    if (typeof document !== 'undefined' && opts.ui !== false) this.mountUi();
  }
  get phone() { return !!this.app?.hud?.touch || (typeof document !== 'undefined' && document.body?.classList.contains('touch')); }
  setPref(k, v) { this.prefs[k] = v; savePrefs(this.storage, this.prefs); this.syncUi(); }

  // ---------------------------------------------------------------- sampling
  dataStamp() {
    const t = this.app?.terrain, g = this.app?.geoms;
    return `${t?.version ?? 0}/${g?.size ?? g?.entries?.size ?? 0}`;
  }
  sample(lat, lon) {
    const g = this.app?.geoms, t = this.app?.terrain;
    let m = null, h = null;
    try {
      const e = g?.coverAt?.(lat, lon);
      if (e) { m = g.maskAt(lat, lon); h = g.heightAt(lat, lon); }
      if (m == null) m = t?.wtiles?.maskAt?.(lat, lon) ?? null;
      if (h == null) h = t?.heightAt?.(lat, lon) ?? null;
    } catch { /* a layer being swapped out: treat as unknown */ }
    if (m == null) m = h == null ? MASK.UNKNOWN : h >= 0 ? MASK.LAND : MASK.WATER;
    return { m, h };
  }
  gridSize(cssW) {
    const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    return Math.max(96, Math.min(this.phone ? 144 : 176, Math.round(cssW * dpr * 0.6)));
  }
  /** Keep the grid current: start / advance a build within the frame budget. */
  update(me, rangeM, cssW, now) {
    const stamp = this.dataStamp();
    const fits = gridFits(this.grid, me.lat, me.lon, rangeM);
    const dataNew = stamp !== this.lastDataStamp && now - this.lastDataBuild > TUNE.DATA_BUILD_MS;
    const want = !this.building && (!fits || dataNew) && now - this.lastStart >= TUNE.MIN_BUILD_MS;
    const stale = this.building && !gridFits(this.building, me.lat, me.lon, rangeM) && now - this.lastStart >= TUNE.MIN_BUILD_MS;
    if (want || stale) {
      this.building = new MapGrid(me.lat, me.lon, rangeM * TUNE.MARGIN, this.gridSize(cssW), (la, lo) => this.sample(la, lo), stamp);
      this.lastStart = now; this.starts = (this.starts || 0) + 1;
      if (dataNew || !this.grid) { this.lastDataStamp = stamp; this.lastDataBuild = now; }
    }
    if (this.building && this.building.step(this.phone ? TUNE.BUDGET_MS_PHONE : TUNE.BUDGET_MS)) {
      this.grid = this.building; this.building = null; this.lastDataStamp = this.grid.stamp;
      this.paintCanvas();
    }
  }
  paintCanvas() {
    const g = this.grid; if (!g || typeof document === 'undefined') return;
    if (!this.canvas) this.canvas = document.createElement('canvas');
    if (this.canvas.width !== g.G) { this.canvas.width = g.G; this.canvas.height = g.G; }
    const c2 = this.canvas.getContext('2d');
    c2.putImageData(new ImageData(g.rgba, g.G, g.G), 0, 0);
  }
  /** Draw the map under the radar. ctx is translated to the radar centre; rr = radius px; rot = radar rotation (deg). */
  drawUnderlay(ctx, me, rangeM, rr, rot, now, cssW) {
    if (!this.prefs.map || !me || !Number.isFinite(me.lat)) return;
    try { this.update(me, rangeM, cssW, now); } catch { return; }
    const g = this.grid; if (!g || !this.canvas || !g.known) return;
    const k = rr / rangeM, off = toEN(g.lat, g.lon, me.lat, me.lon), size = 2 * g.half * k;
    ctx.save();
    ctx.beginPath(); ctx.arc(0, 0, rr, 0, Math.PI * 2); ctx.clip();
    ctx.rotate(rot * D2R);
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 0.9;
    ctx.drawImage(this.canvas, -off.e * k - size / 2, off.n * k - size / 2, size, size);
    ctx.globalAlpha = 1;
    // inland harbours (public/js/mharbour.js): pontoons, finger piers, quays and gangways as crisp vectors — a 2.4 m pontoon
    // is far below one grid cell at any radar range
    try { drawSegments(ctx, me, this.app?.mharbour?.segmentsNear?.(me.lat, me.lon, rangeM * 1.5) || [], k, rr); } catch { /* cosmetic */ }
    ctx.restore();
  }

  // ---------------------------------------------------------------- contacts + labels
  filterContacts(list) { return filterContacts(list, this.prefs.traffic); }
  /** Capture the labels the contact loop draws (see header); call .at(c) per contact, .flush() after the loop. */
  beginLabels(ctx, me, k, rot, rr, small) {
    delete ctx.fillText; // a loop that threw last frame must not leave the capture in place
    const items = [], mode = this.prefs.labels;
    let cur = null;
    ctx.fillText = (text, x, y) => {
      if (!cur) return CanvasRenderingContext2D.prototype.fillText.call(ctx, text, x, y);
      const w = ctx.measureText(String(text)).width, fs = parseFloat(/(\d+(?:\.\d+)?)px/.exec(ctx.font)?.[1] || '10');
      items.push({ text: String(text), x, y, w, h: fs + 2, ax: cur.x, ay: cur.y, kind: cur.c.kind, d: cur.d, fill: ctx.fillStyle, font: ctx.font });
    };
    return {
      at(c) {
        const p = polarOf(me, c), b = (p.brg + rot) * D2R;
        cur = { c, d: p.d, x: Math.sin(b) * p.d * k, y: -Math.cos(b) * p.d * k };
      },
      flush() {
        delete ctx.fillText;
        const placed = placeLabels(items, { mode, rr, small });
        ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        for (const l of placed) {
          ctx.font = l.font;
          ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(3,14,22,0.85)'; ctx.strokeText(l.text, l.x, l.y); // halo: readable over the map
          ctx.fillStyle = l.fill; ctx.fillText(l.text, l.x, l.y);
        }
        ctx.restore();
        return placed;
      },
    };
  }

  // ---------------------------------------------------------------- UI
  mountUi() {
    const wrap = document.getElementById('radarWrap'); if (!wrap || document.getElementById('radarOpts')) return;
    if (!document.querySelector('link[data-radarmap]')) {
      const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/css/radarmap.css'; l.dataset.radarmap = '1'; document.head.append(l);
    }
    const box = document.createElement('div'); box.id = 'radarOpts';
    box.innerHTML = '<button type="button" class="ro-toggle" id="roToggle" aria-label="Radar layers" title="Radar layers">'
      + '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 3 2 8l10 5 10-5-10-5Zm-7.6 8.8L2 13l10 5 10-5-2.4-1.2L12 15.6l-7.6-3.8Zm0 5L2 18l10 5 10-5-2.4-1.2L12 20.6l-7.6-3.8Z" fill="currentColor"/></svg></button>'
      + '<div class="ro-row"><button type="button" id="roMap" title="Map under the radar (coast, harbours, fairways)">Map</button>'
      + '<button type="button" id="roTraffic" title="Which traffic the radar shows">Ships</button>'
      + '<button type="button" id="roLabels" title="Names on the radar">Names</button></div>';
    wrap.append(box);
    const on = (id, fn) => { const b = document.getElementById(id); if (b) b.onclick = (e) => { e.stopPropagation(); fn(); }; };
    on('roToggle', () => box.classList.toggle('open'));
    on('roMap', () => this.setPref('map', !this.prefs.map));
    on('roTraffic', () => this.setPref('traffic', nextMode(TRAFFIC_MODES, this.prefs.traffic)));
    on('roLabels', () => this.setPref('labels', nextMode(LABEL_MODES, this.prefs.labels)));
    this.syncUi();
  }
  syncUi() {
    if (typeof document === 'undefined') return;
    const set = (id, text, onState) => { const b = document.getElementById(id); if (!b) return; if (b.textContent !== text) b.textContent = text; b.classList.toggle('on', onState); };
    const p = this.prefs;
    set('roMap', p.map ? 'Map' : 'No map', p.map);
    set('roTraffic', { all: 'All ships', players: 'Players', ais: 'AIS', off: 'No ships' }[p.traffic], p.traffic !== 'off');
    set('roLabels', { auto: 'Few names', all: 'All names', off: 'No names' }[p.labels], p.labels !== 'off');
  }
}
