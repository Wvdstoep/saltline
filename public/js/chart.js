// Interactive Web-Mercator chart (docs/V3-CONTRACTS.md §7): pan / zoom / pinch, our equirectangular chart PNGs warped per row
// as the base, OSM raster + OpenSeaMap seamark tiles from zoom 7, every overlay (harbours + job boards, jobs, fishing grounds,
// platforms, storms, AI, players, convoy, cutters, wrecks, rescues, own ship + track, route, lanes), cursor lat/lon/depth/tide,
// scale bar, route planning (route mode) and selection popups (select mode). Everything is drawn in CSS pixels on a
// devicePixelRatio-scaled canvas that follows its container.
import { haversine, bearing, fmtDMS, fmtDistance, wrapLon } from '/shared/geo.js';
import { LAYERS, SHIP_CLASSES, SIM, GEO } from '/shared/constants.js';

const D2R = Math.PI / 180, R2D = 180 / Math.PI, TILE = 256, NM = 1852, EARTH_CIRC = 40075016.686;
export const ZOOM_MIN = 2, ZOOM_MAX = 16, TILE_ZOOM = 7, MAX_TILES = 256;
const OSM_URL = (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
const SEA_URL = (z, x, y) => `https://tiles.openseamap.org/seamark/${z}/${x}/${y}.png`;
const TILE_RETRY_MS = 300000;

const clampLat = (v) => Math.max(-85.05, Math.min(85.05, v));
const mx = (lon) => (lon + 180) / 360;                                                        // 0..1 across the world
const my = (lat) => { const s = Math.sin(clampLat(lat) * D2R); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); };
const invX = (x) => wrapLon(x * 360 - 180);
const invY = (y) => R2D * Math.atan(Math.sinh(Math.PI * (1 - 2 * y)));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmtN = (n) => Math.round(n).toLocaleString('en-US');

// ---------------------------------------------------------------------------------------------- shared data helpers
// /api/jobs cache shared by the chart (job markers, harbour popups) and the HUD's "Job boards" tab.
const jobsCache = { time: 0, data: null, pending: null };
export function fetchJobs(maxAgeMs = 60000) {
  const now = Date.now();
  if (jobsCache.data && now - jobsCache.time < maxAgeMs) return Promise.resolve(jobsCache.data);
  if (jobsCache.pending) return jobsCache.pending;
  jobsCache.pending = fetch('/api/jobs').then((r) => (r.ok ? r.json() : null)).then((j) => {
    if (j && Array.isArray(j.harbors)) { jobsCache.data = j; jobsCache.time = Date.now(); }
    jobsCache.pending = null; return jobsCache.data;
  }).catch(() => { jobsCache.pending = null; return jobsCache.data; });
  return jobsCache.pending;
}
export function cachedJobs() { return jobsCache.data; }

/** AI ships however main.js keeps them (Map of interpolated entries with `.cur`, array of AiPublic, or the last snapshot). */
export function collectAi(app) {
  const src = app.ai || app.aiShips || app.lastSnap?.ai || app.snap?.ai;
  if (!src) return [];
  const arr = src instanceof Map ? [...src.values()] : Array.isArray(src) ? src : Object.values(src);
  const out = [];
  for (const a of arr) {
    if (!a) continue;
    const c = a.cur || a;
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lon)) continue;
    out.push({ id: a.id, name: a.name || a.id, cls: a.cls, flag: a.flag, lat: c.lat, lon: c.lon, hdg: c.hdg ?? 0, spd: c.spd ?? 0, dest: a.dest, destName: a.destName, state: a.state, eta: a.eta });
  }
  return out;
}
export function collectStorms(app) { return app.storms || app.lastSnap?.storms || app.snap?.storms || []; }
export function collectRescues(app) {
  const src = app.rescues || app.lastSnap?.rescues || app.snap?.rescues;
  if (!src) return [];
  const arr = src instanceof Map ? [...src.values()] : Array.isArray(src) ? src : Object.values(src);
  return arr.map((r) => { const c = r.cur || r; return { id: r.id, kind: r.kind, lat: c.lat, lon: c.lon, hdg: c.hdg ?? 0, state: r.state, playerName: r.playerName }; }).filter((r) => Number.isFinite(r.lat));
}
export function fmtDur(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${String(m % 60).padStart(2, '0')}`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}
export function fmtClock(sec) { const d = new Date(sec * 1000); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; }

// ---------------------------------------------------------------------------------------------- the chart
export class Chart {
  constructor(app, canvasEl, infoEl) {
    this.app = app; this.canvas = canvasEl; this.info = infoEl;
    this.wrap = canvasEl.closest('#chartWrap') || canvasEl.parentElement;
    this.body = canvasEl.parentElement;
    this.ctx = canvasEl.getContext('2d');
    this.center = { lat: 54, lon: 3 }; this.zoom = 5;
    this.W = 0; this.H = 0; this.dpr = 1;
    this.route = []; this.track = []; this.mode = 'route';
    this.layers = { base: true, tiles: true, seamarks: true, lanes: true, ai: true, jobs: true, track: true, storms: true, fishing: true, platforms: true, harbors: true, ships: true, wrecks: true, rescues: true };
    this.base = { world: null, region: null };
    this.tiles = new Map(); this.tilesDrawn = 0; this.seaDrawn = 0;
    this.jobsTimer = null; this.drawTimer = null;
    this.cursor = null; this.cursorDepth = null; this.cursorTide = null; this.hover = null;
    this.pointers = new Map(); this.gesture = null; this.longTimer = null;
    this.everOpened = false; this._raf = 0; this._voyageKey = '';
    this.popup = null; this.popupAnchor = null;
    this.bindCanvas(); this.bindButtons(); this.bindResize();
    this.trackTimer = setInterval(() => this.recordTrack(), 10000);
  }

  // ------------------------------------------------------------------ public API
  open() {
    if (this.wrap) this.wrap.classList.remove('hidden');
    const ship = this.app.ship;
    if (!this.everOpened) { this.everOpened = true; if (ship) this.setCenter(ship.lat, ship.lon, this.app.inRegion?.() === false ? 4 : 9); }
    this.resize();
    this.refreshJobs();
    clearInterval(this.jobsTimer); this.jobsTimer = setInterval(() => { if (this.isOpen()) this.refreshJobs(); else clearInterval(this.jobsTimer); }, 60000);
    clearInterval(this.drawTimer); this.drawTimer = setInterval(() => { if (this.isOpen()) this.draw(); else clearInterval(this.drawTimer); }, 1000);
    this.draw();
  }
  close() {
    if (this.wrap) this.wrap.classList.add('hidden');
    clearInterval(this.jobsTimer); clearInterval(this.drawTimer); this.jobsTimer = this.drawTimer = null;
    this.hidePopup(); this.pointers.clear(); this.gesture = null; clearTimeout(this.longTimer);
  }
  isOpen() { return !!this.wrap && !this.wrap.classList.contains('hidden'); }
  setCenter(lat, lon, zoom) {
    if (Number.isFinite(lat)) this.center.lat = clampLat(lat);
    if (Number.isFinite(lon)) this.center.lon = wrapLon(lon);
    if (Number.isFinite(zoom)) this.zoom = clamp(zoom, ZOOM_MIN, ZOOM_MAX);
    this.requestDraw();
  }
  centerOnShip() { const s = this.app.ship; if (s) this.setCenter(s.lat, s.lon, Math.max(this.zoom, 8)); }
  getRoute() { return this.route.map((p) => ({ lat: p.lat, lon: p.lon })); }
  clearRoute() { this.route = []; this.app.clearRoute?.(); this.requestDraw(); }
  setLayer(name, on) {
    if (!(name in this.layers)) return;
    this.layers[name] = !!on;
    this.syncButtons(); this.requestDraw();
  }
  setMode(m) { this.mode = m === 'select' ? 'select' : 'route'; this.syncButtons(); this.requestDraw(); }
  /** Append a waypoint (also used by popups / HUD). Returns the waypoint. */
  addWaypoint(lat, lon) {
    const wp = { lat: clampLat(lat), lon: wrapLon(lon) };
    this.route.push(wp);
    this.checkWaypointWater(wp);
    this.requestDraw();
    return wp;
  }
  removeWaypoint(i) { if (i >= 0 && i < this.route.length) { this.route.splice(i, 1); this.requestDraw(); } }
  /** Hand the route to the ship: app.setRoute(points) when C3 provides it, else the legacy single waypoint. */
  sailRoute() {
    const a = this.app;
    if (!this.route.length) { a.hud?.event?.({ kind: 'warn', text: 'Tap the chart to add waypoints first (Route mode).' }); return; }
    const pts = this.getRoute();
    if (typeof a.setRoute === 'function') a.setRoute(pts);
    else { const last = pts[pts.length - 1]; a.setWaypoint?.(last.lat, last.lon); }
    a.autopilot = true;
    const { nm } = this.routeStats();
    a.hud?.event?.({ kind: 'info', text: `Autopilot following ${pts.length} waypoint${pts.length > 1 ? 's' : ''} · ${nm.toFixed(1)} nm.` });
    this.requestDraw();
  }
  dispose() { clearInterval(this.trackTimer); clearInterval(this.jobsTimer); clearInterval(this.drawTimer); this.ro?.disconnect(); }

  // ------------------------------------------------------------------ projection
  get scale() { return TILE * Math.pow(2, this.zoom); }               // world width in CSS px
  mPerPx(lat = this.center.lat) { return (EARTH_CIRC * Math.cos(lat * D2R)) / this.scale; }
  project(lat, lon) {
    const S = this.scale;
    let dx = mx(lon) - mx(this.center.lon); dx -= Math.round(dx);     // nearest wrapped copy
    return { x: dx * S + this.W / 2, y: (my(lat) - my(this.center.lat)) * S + this.H / 2 };
  }
  unproject(x, y) {
    const S = this.scale;
    return { lat: clampLat(invY(my(this.center.lat) + (y - this.H / 2) / S)), lon: invX(mx(this.center.lon) + (x - this.W / 2) / S) };
  }
  panPx(dx, dy) {
    const S = this.scale;
    this.center.lon = invX(mx(this.center.lon) - dx / S);
    this.center.lat = clampLat(invY(clamp(my(this.center.lat) - dy / S, 0, 1)));
  }
  zoomAt(x, y, dz) {
    const before = this.unproject(x, y);
    this.zoom = clamp(this.zoom + dz, ZOOM_MIN, ZOOM_MAX);
    const after = this.project(before.lat, before.lon);
    this.panPx(x - after.x, y - after.y);
    this.requestDraw();
  }

  // ------------------------------------------------------------------ sizing
  bindResize() {
    if (typeof ResizeObserver !== 'undefined' && this.body) { this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(this.body); }
    window.addEventListener('resize', () => this.resize());
  }
  resize() {
    const el = this.body || this.canvas;
    const w = Math.max(1, Math.floor(el.clientWidth || this.canvas.clientWidth || 0)), h = Math.max(1, Math.floor(el.clientHeight || this.canvas.clientHeight || 0));
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (w === this.W && h === this.H && dpr === this.dpr && this.canvas.width) return;
    this.W = w; this.H = h; this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
    this.requestDraw();
  }
  requestDraw() { if (this._raf || !this.isOpen()) return; this._raf = requestAnimationFrame(() => { this._raf = 0; this.draw(); }); }

  // ------------------------------------------------------------------ images: base PNGs and tiles
  baseImage(mode) {
    const cur = this.base[mode];
    if (cur || cur === false) return cur || null;
    this.base[mode] = false;
    const im = new Image();
    im.onload = () => { this.base[mode] = im; this.requestDraw(); };
    im.onerror = () => { this.base[mode] = null; };
    im.src = `/api/chart/${mode}.png`;
    return null;
  }
  tile(kind, z, x, y) {
    const key = `${kind}/${z}/${x}/${y}`;
    let t = this.tiles.get(key);
    if (t) {
      if (t.state === 'err' && performance.now() - t.at > TILE_RETRY_MS) t = null;
      else { this.tiles.delete(key); this.tiles.set(key, t); return t; }         // refresh LRU position
    }
    t = { img: new Image(), state: 'loading', at: performance.now() };
    t.img.decoding = 'async';
    t.img.onload = () => { t.state = 'ok'; this.requestDraw(); };
    t.img.onerror = () => { t.state = 'err'; t.at = performance.now(); };        // the base chart stays visible underneath
    t.img.src = (kind === 'sea' ? SEA_URL : OSM_URL)(z, x, y);
    this.tiles.set(key, t);
    while (this.tiles.size > MAX_TILES) { const k = this.tiles.keys().next().value; this.tiles.delete(k); }
    return t;
  }

  // ------------------------------------------------------------------ data
  refreshJobs() { fetchJobs(60000).then(() => this.requestDraw()); }
  jobsFor(harborId) { const d = cachedJobs(); if (!d) return null; return d.harbors.find((h) => h.id === harborId) || null; }
  recordTrack() {
    const s = this.app.ship; if (!s || this.app.you?.docked) return;
    const last = this.track[this.track.length - 1];
    if (last && haversine(last.lat, last.lon, s.lat, s.lon) < 30) return;
    this.track.push({ lat: s.lat, lon: s.lon });
    if (this.track.length > 720) this.track.shift();
  }
  routeStats() {
    const s = this.app.ship, pts = this.route;
    let m = 0, prev = s ? { lat: s.lat, lon: s.lon } : null;
    for (const p of pts) { if (prev) m += haversine(prev.lat, prev.lon, p.lat, p.lon); prev = p; }
    const nm = m / NM;
    const C = s ? SHIP_CLASSES[s.cls] : null;
    const sog = s ? Math.abs(s.spd) : 0;
    const planKn = sog > 0.5 ? sog : C ? C.maxKn * 0.8 : 10;
    const etaSec = nm > 0 ? (nm / planKn) * 3600 : 0;
    return { nm, etaSec, planKn, atSog: sog > 0.5, expressCost: Math.round(nm * SIM.EXPRESS_CR_PER_NM) };
  }
  checkWaypointWater(wp) {
    fetch(`/api/height?lat=${wp.lat.toFixed(5)}&lon=${wp.lon.toFixed(5)}`).then((r) => r.json()).then((j) => {
      if (j && Number.isFinite(j.h) && j.h >= 0) {
        const i = this.route.indexOf(wp);
        if (i >= 0) { this.route.splice(i, 1); this.app.hud?.event?.({ kind: 'warn', text: 'That waypoint is on land — pick open water.' }); this.requestDraw(); }
      }
    }).catch(() => {});
  }

  // ------------------------------------------------------------------ drawing
  draw() {
    if (!this.isOpen()) return;
    if (!this.W || !this.H) this.resize();
    const ctx = this.ctx, W = this.W, H = this.H;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#0a2238'; ctx.fillRect(0, 0, W, H);
    this.tilesDrawn = 0; this.seaDrawn = 0;
    if (this.layers.base) { this.drawBase('world'); this.drawBase('region'); }
    if (this.layers.tiles && this.zoom >= TILE_ZOOM) { this.drawTiles('osm'); if (this.layers.seamarks) this.drawTiles('sea'); }
    this.drawGraticule();
    if (this.layers.lanes) this.drawLanes();
    if (this.layers.fishing) this.drawFishing();
    if (this.layers.platforms) this.drawPlatforms();
    if (this.layers.storms) this.drawStorms();
    if (this.layers.wrecks) this.drawWrecks();
    if (this.layers.track) this.drawTrack();
    this.drawRoute();
    if (this.layers.ai) this.drawAi();
    if (this.layers.ships) this.drawShips();
    if (this.layers.rescues) this.drawRescues();
    this.drawMe();
    if (this.layers.harbors) this.drawHarbors();
    this.drawHover();
    this.drawScaleBar();
    this.drawAttribution();
    this.updateInfo();
    this.positionPopup();
    this.pushVoyage();
  }
  /** Equirectangular PNG warped into Mercator: rows of equal source latitude are drawn as horizontal strips. */
  drawBase(mode) {
    const img = this.baseImage(mode); if (!img) return;
    const b = mode === 'region' ? LAYERS[1] : LAYERS[0];
    if (mode === 'region' && this.zoom < 3) return;                                  // the world PNG is enough at that scale
    const ctx = this.ctx, S = this.scale, W = this.W, H = this.H;
    const yTop = this.project(Math.min(85, b.latMax), b.lonMin).y, yBot = this.project(Math.max(-85, b.latMin), b.lonMin).y;
    const y0 = Math.max(0, Math.floor(yTop)), y1 = Math.min(H, Math.ceil(yBot));
    if (y1 <= y0) return;
    const xl = this.project(0, b.lonMin).x, wpx = ((b.lonMax - b.lonMin) / 360) * S;
    const copies = [];
    for (let k = -1; k <= 1; k++) { const x0 = xl + k * S; if (x0 + wpx > 0 && x0 < W) copies.push(x0); }
    if (!copies.length) return;
    const iw = img.naturalWidth, ih = img.naturalHeight, latSpan = b.latMax - b.latMin;
    ctx.imageSmoothingEnabled = true;
    let y = y0;
    while (y < y1) {
      const lat = this.unproject(0, y + 0.5).lat;
      const sr = clamp(Math.floor(((b.latMax - lat) / latSpan) * ih), 0, ih - 1);
      // extend the strip while the next rows still fall in the same source row (cheap at high zoom)
      let yEnd = y + 1;
      while (yEnd < y1) { const l2 = this.unproject(0, yEnd + 0.5).lat; if (clamp(Math.floor(((b.latMax - l2) / latSpan) * ih), 0, ih - 1) !== sr) break; yEnd++; }
      for (const x0 of copies) ctx.drawImage(img, 0, sr, iw, 1, x0, y, wpx, yEnd - y + 0.5);
      y = yEnd;
    }
  }
  drawTiles(kind) {
    const ctx = this.ctx, W = this.W, H = this.H;
    const zi = clamp(Math.round(this.zoom), TILE_ZOOM, 18), n = Math.pow(2, zi);
    const sc = Math.pow(2, this.zoom - zi), size = TILE * sc;
    const cx = mx(this.center.lon) * n, cy = my(this.center.lat) * n;              // centre in tile units
    const tx0 = Math.floor(cx - W / 2 / size), tx1 = Math.floor(cx + W / 2 / size);
    const ty0 = Math.max(0, Math.floor(cy - H / 2 / size)), ty1 = Math.min(n - 1, Math.floor(cy + H / 2 / size));
    if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) > 80) return;
    ctx.imageSmoothingEnabled = true;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const wx = ((tx % n) + n) % n;
        const t = this.tile(kind, zi, wx, ty);
        if (t.state !== 'ok') continue;
        const sx = (tx - cx) * size + W / 2, sy = (ty - cy) * size + H / 2;
        try { ctx.drawImage(t.img, sx, sy, size + 0.5, size + 0.5); if (kind === 'osm') this.tilesDrawn++; else this.seaDrawn++; } catch { t.state = 'err'; }
      }
    }
  }
  drawGraticule() {
    const ctx = this.ctx, W = this.W, H = this.H, z = this.zoom;
    const step = z < 3 ? 30 : z < 5 ? 10 : z < 7 ? 5 : z < 9 ? 1 : z < 11 ? 0.5 : z < 13 ? 0.1 : 0.05;
    const tl = this.unproject(0, 0), br = this.unproject(W, H);
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 1; ctx.beginPath();
    const latA = Math.max(-85, Math.floor(br.lat / step) * step), latB = Math.min(85, tl.lat);
    for (let lat = latA; lat <= latB + 1e-9; lat += step) { const y = Math.round(this.project(lat, 0).y) + 0.5; ctx.moveTo(0, y); ctx.lineTo(W, y); }
    let lonA = Math.floor(tl.lon / step) * step, span = wrapLon(br.lon - tl.lon); if (span <= 0) span += 360; if (W >= this.scale) { lonA = -180; span = 360; }
    for (let lon = lonA; lon <= lonA + span + 1e-9; lon += step) { const x = Math.round(this.project(0, lon).x) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    ctx.stroke();
  }
  drawLanes() {
    const lanes = this.app.world?.lanes; if (!lanes || !lanes.length || this.zoom < 4) return;
    const ctx = this.ctx;
    const nodes = lanes.map((n) => (Array.isArray(n) ? { lat: n[0], lon: n[1] } : n)).filter((n) => n && Number.isFinite(n.lat));
    const byId = new Map(nodes.map((n, i) => [n.id ?? i, n]));
    ctx.strokeStyle = 'rgba(190,210,255,0.22)'; ctx.lineWidth = 1; ctx.setLineDash([2, 4]); ctx.beginPath();
    const edges = this.app.world.laneEdges || [];
    const link = (a, b) => { if (!a || !b) return; const p = this.project(a.lat, a.lon), q = this.project(b.lat, b.lon); if (Math.abs(p.x - q.x) > this.scale / 2) return; ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); };
    for (const e of edges) link(byId.get(Array.isArray(e) ? e[0] : e.a ?? e.from), byId.get(Array.isArray(e) ? e[1] : e.b ?? e.to));
    for (const n of nodes) for (const t of n.links || n.edges || n.adj || n.to || []) link(n, byId.get(typeof t === 'object' ? t.id ?? t.to : t));
    ctx.stroke(); ctx.setLineDash([]);
    if (this.zoom >= 6) { ctx.fillStyle = 'rgba(190,210,255,0.35)'; for (const n of nodes) { const p = this.project(n.lat, n.lon); if (this.onScreen(p)) { ctx.beginPath(); ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2); ctx.fill(); } } }
  }
  drawFishing() {
    const ctx = this.ctx;
    ctx.font = '11px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (const g of this.app.world?.fishing || []) {
      const p = this.project(g.lat, g.lon); const r = Math.max(4, (g.radiusKm * 1000) / this.mPerPx(g.lat));
      if (!this.onScreen(p, r)) continue;
      ctx.strokeStyle = 'rgba(120,200,255,0.75)'; ctx.lineWidth = 1; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      if (r > 14 || this.zoom >= 6) { ctx.fillStyle = 'rgba(160,220,255,0.9)'; ctx.fillText('~ ' + g.name, p.x + 6, p.y); }
    }
  }
  drawPlatforms() {
    const ctx = this.ctx; if (this.zoom < 5) return;
    ctx.font = '10px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (const pl of this.app.world?.platforms || []) {
      const p = this.project(pl.lat, pl.lon); if (!this.onScreen(p)) continue;
      ctx.strokeStyle = '#ffb35c'; ctx.fillStyle = '#ffb35c'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(p.x - 4, p.y + 4); ctx.lineTo(p.x, p.y - 6); ctx.lineTo(p.x + 4, p.y + 4); ctx.closePath(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(p.x - 5, p.y + 4); ctx.lineTo(p.x + 5, p.y + 4); ctx.stroke();
      if (this.zoom >= 7) { ctx.fillStyle = 'rgba(255,210,160,0.9)'; ctx.fillText(pl.name, p.x + 8, p.y); }
    }
  }
  drawStorms() {
    const ctx = this.ctx;
    ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const s of collectStorms(this.app)) {
      const p = this.project(s.lat, s.lon); const r = Math.max(6, (s.radiusKm * 1000) / this.mPerPx(s.lat));
      if (!this.onScreen(p, r)) continue;
      const k = clamp(s.intensity ?? 0.5, 0, 1);
      ctx.fillStyle = `rgba(255,80,80,${0.08 + 0.22 * k})`; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = `rgba(255,120,120,${0.4 + 0.5 * k})`; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#ffd0d0'; ctx.fillText(`${s.name || 'Storm'} · ${Math.round(k * 100)} %`, p.x, p.y - Math.min(r, 14) - 8);
    }
  }
  drawWrecks() {
    const ctx = this.ctx; ctx.strokeStyle = '#cfcfcf'; ctx.lineWidth = 2;
    for (const w of this.app.wrecks || []) {
      const p = this.project(w.lat, w.lon); if (!this.onScreen(p)) continue;
      ctx.beginPath(); ctx.moveTo(p.x - 4, p.y - 4); ctx.lineTo(p.x + 4, p.y + 4); ctx.moveTo(p.x + 4, p.y - 4); ctx.lineTo(p.x - 4, p.y + 4); ctx.stroke();
    }
  }
  drawTrack() {
    if (this.track.length < 2) return;
    const ctx = this.ctx; ctx.strokeStyle = 'rgba(242,177,52,0.45)'; ctx.lineWidth = 1.5; ctx.beginPath();
    let prev = null;
    for (const t of this.track) { const p = this.project(t.lat, t.lon); if (prev && Math.abs(p.x - prev.x) < this.scale / 2) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); prev = p; }
    const s = this.app.ship; if (s) { const p = this.project(s.lat, s.lon); ctx.lineTo(p.x, p.y); }
    ctx.stroke();
  }
  drawRoute() {
    const ctx = this.ctx, a = this.app, s = a.ship;
    // legacy single waypoint (set by main.js / autopilot target) when it is not part of the planned route
    if (a.waypoint && !this.route.some((w) => Math.abs(w.lat - a.waypoint.lat) < 1e-6 && Math.abs(w.lon - a.waypoint.lon) < 1e-6)) {
      const p = this.project(a.waypoint.lat, a.waypoint.lon);
      if (s) { const q = this.project(s.lat, s.lon); ctx.strokeStyle = 'rgba(242,177,52,0.5)'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(p.x, p.y); ctx.stroke(); ctx.setLineDash([]); }
      ctx.strokeStyle = '#f2b134'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(p.x, p.y - 8); ctx.lineTo(p.x + 8, p.y); ctx.lineTo(p.x, p.y + 8); ctx.lineTo(p.x - 8, p.y); ctx.closePath(); ctx.stroke();
    }
    // the ship's active route (C3) if it differs from the editing buffer
    const active = Array.isArray(a.route) && a.route.length && a.route !== this.route ? a.route : null;
    if (active && !this.route.length) { ctx.strokeStyle = 'rgba(88,214,141,0.7)'; ctx.lineWidth = 2; ctx.setLineDash([8, 4]); ctx.beginPath(); let prev = s ? this.project(s.lat, s.lon) : null; if (prev) ctx.moveTo(prev.x, prev.y); for (const w of active) { const p = this.project(w.lat, w.lon); if (prev) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); prev = p; } ctx.stroke(); ctx.setLineDash([]); }
    if (!this.route.length) return;
    ctx.strokeStyle = 'rgba(242,177,52,0.85)'; ctx.lineWidth = 2; ctx.setLineDash([8, 5]); ctx.beginPath();
    let prev = s ? this.project(s.lat, s.lon) : null; if (prev) ctx.moveTo(prev.x, prev.y);
    for (const w of this.route) { const p = this.project(w.lat, w.lon); if (prev && Math.abs(p.x - prev.x) < this.scale / 2) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); prev = p; }
    ctx.stroke(); ctx.setLineDash([]);
    // leg lengths
    ctx.font = '10px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    let from = s ? { lat: s.lat, lon: s.lon } : null;
    for (const w of this.route) {
      if (from && this.zoom >= 6) { const m = haversine(from.lat, from.lon, w.lat, w.lon); const p1 = this.project(from.lat, from.lon), p2 = this.project(w.lat, w.lon); const mxp = (p1.x + p2.x) / 2, myp = (p1.y + p2.y) / 2; if (Math.hypot(p2.x - p1.x, p2.y - p1.y) > 60) { ctx.fillStyle = 'rgba(4,12,20,0.7)'; const t = `${(m / NM).toFixed(1)} nm`; const tw = ctx.measureText(t).width + 6; ctx.fillRect(mxp - tw / 2, myp - 7, tw, 14); ctx.fillStyle = '#ffd98a'; ctx.fillText(t, mxp, myp); } }
      from = w;
    }
    // numbered waypoint markers
    ctx.font = 'bold 10px sans-serif';
    this.route.forEach((w, i) => {
      const p = this.project(w.lat, w.lon);
      ctx.fillStyle = i === this.route.length - 1 ? '#f2b134' : 'rgba(242,177,52,0.85)'; ctx.beginPath(); ctx.arc(p.x, p.y, 8, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#1a1200'; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = '#1a1200'; ctx.fillText(String(i + 1), p.x, p.y + 0.5);
    });
    const { nm, etaSec, atSog, planKn } = this.routeStats();
    const last = this.project(this.route[this.route.length - 1].lat, this.route[this.route.length - 1].lon);
    const txt = `${nm.toFixed(1)} nm · ETA ${fmtDur(etaSec)}${atSog ? '' : ` @ ${planKn.toFixed(0)} kn`}`;
    ctx.font = '11px monospace'; ctx.textAlign = 'left'; const tw = ctx.measureText(txt).width + 8;
    ctx.fillStyle = 'rgba(4,12,20,0.75)'; ctx.fillRect(last.x + 10, last.y - 8, tw, 16); ctx.fillStyle = '#ffd98a'; ctx.fillText(txt, last.x + 14, last.y);
  }
  drawTriangle(p, hdgDeg, size, fill, stroke) {
    const ctx = this.ctx, h = hdgDeg * D2R;
    ctx.beginPath();
    ctx.moveTo(p.x + Math.sin(h) * size, p.y - Math.cos(h) * size);
    ctx.lineTo(p.x + Math.sin(h + 2.5) * size * 0.8, p.y - Math.cos(h + 2.5) * size * 0.8);
    ctx.lineTo(p.x + Math.sin(h - 2.5) * size * 0.8, p.y - Math.cos(h - 2.5) * size * 0.8);
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
  }
  drawAi() {
    const ctx = this.ctx, list = collectAi(this.app); if (!list.length || this.zoom < 4) return;
    ctx.strokeStyle = 'rgba(200,200,200,0.8)'; ctx.lineWidth = 1;
    for (const a of list) {
      const p = this.project(a.lat, a.lon); if (!this.onScreen(p)) continue;
      const moored = a.state === 'moored' || a.state === 'anchored';
      this.drawTriangle(p, a.hdg, moored ? 4 : 5, moored ? 'rgba(150,150,150,0.8)' : '#b8bec4', 'rgba(20,30,40,0.8)');
      if (!moored && a.spd > 0.5) { const h = a.hdg * D2R; const len = clamp(a.spd * 1.2, 6, 20); ctx.strokeStyle = 'rgba(200,200,200,0.7)'; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + Math.sin(h) * len, p.y - Math.cos(h) * len); ctx.stroke(); }
      if (this.zoom >= 11) { ctx.font = '10px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = 'rgba(220,220,220,0.85)'; ctx.fillText(a.name, p.x + 8, p.y); }
    }
  }
  drawShips() {
    const ctx = this.ctx, a = this.app;
    ctx.font = '11px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (const c of a.cutters?.values?.() || []) {
      const cur = c.cur || c; const p = this.project(cur.lat, cur.lon); if (!this.onScreen(p)) continue;
      this.drawTriangle(p, cur.hdg ?? 0, 6, c.state && c.state !== 'patrol' ? '#ff2020' : '#ff6b6b');
      if (this.zoom >= 8) { ctx.fillStyle = '#ffb0b0'; ctx.fillText(c.name || 'Coast guard', p.x + 8, p.y); }
    }
    for (const o of a.others?.values?.() || []) {
      const cur = o.cur || o; const p = this.project(cur.lat, cur.lon); if (!this.onScreen(p)) continue;
      const convoy = o.convoyId && o.convoyId === a.you?.convoyId;
      ctx.fillStyle = convoy ? '#5ad6ff' : o.wanted ? '#ffb070' : '#ffffff'; ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill();
      if (cur.hdg != null) { const h = cur.hdg * D2R; ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + Math.sin(h) * 11, p.y - Math.cos(h) * 11); ctx.stroke(); }
      ctx.fillStyle = convoy ? '#bff0ff' : '#fff'; ctx.fillText(o.name, p.x + 7, p.y);
    }
  }
  drawRescues() {
    const ctx = this.ctx;
    ctx.font = '10px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (const r of collectRescues(this.app)) {
      const p = this.project(r.lat, r.lon); if (!this.onScreen(p)) continue;
      ctx.strokeStyle = '#ff9f43'; ctx.fillStyle = '#ff9f43'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2); ctx.stroke();
      if (r.kind === 'helicopter') { ctx.font = 'bold 9px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('H', p.x, p.y + 0.5); ctx.font = '10px sans-serif'; ctx.textAlign = 'left'; }
      else { ctx.beginPath(); ctx.moveTo(p.x - 3, p.y); ctx.lineTo(p.x + 3, p.y); ctx.moveTo(p.x, p.y - 3); ctx.lineTo(p.x, p.y + 3); ctx.stroke(); }
      ctx.fillStyle = '#ffd0a0'; ctx.fillText(`SAR ${r.kind} → ${r.playerName || ''}`, p.x + 9, p.y);
    }
  }
  drawMe() {
    const s = this.app.ship; if (!s) return;
    const ctx = this.ctx, p = this.project(s.lat, s.lon), h = s.hdg * D2R;
    const vec = (6 * NM) / this.mPerPx(s.lat);                                     // 6 nm heading vector
    ctx.strokeStyle = 'rgba(242,177,52,0.8)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + Math.sin(h) * vec, p.y - Math.cos(h) * vec); ctx.stroke();
    this.drawTriangle(p, s.hdg, 9, '#f2b134', '#1a1200');
    if (this.app.you?.docked) { ctx.strokeStyle = '#f2b134'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(p.x, p.y, 12, 0, Math.PI * 2); ctx.stroke(); }
  }
  harborRadius(h) { return h.size === 'mega' ? 6 : h.size === 'major' ? 5 : h.size === 'regional' ? 4 : 3; }
  harborVisible(h) { return this.zoom >= 7 || h.size === 'mega' || h.size === 'major' || (this.zoom >= 5 && h.size === 'regional') || this.zoom >= 6; }
  drawHarbors() {
    const ctx = this.ctx, z = this.zoom, jobs = cachedJobs();
    ctx.textBaseline = 'middle';
    for (const h of this.app.world?.harbors || []) {
      if (!this.harborVisible(h)) continue;
      const p = this.project(h.lat, h.lon); if (!this.onScreen(p, 60)) continue;
      const r = this.harborRadius(h);
      ctx.fillStyle = '#58d68d'; ctx.strokeStyle = '#1a3a28'; ctx.lineWidth = 1;
      if (h.size === 'mega' || h.size === 'major') { ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2); ctx.strokeRect(p.x - r + 0.5, p.y - r + 0.5, r * 2 - 1, r * 2 - 1); if (h.size === 'mega') { ctx.strokeStyle = '#58d68d'; ctx.strokeRect(p.x - r - 2.5, p.y - r - 2.5, r * 2 + 5, r * 2 + 5); } }
      else { ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
      const label = z >= 7 || h.size === 'mega' || (z >= 5 && h.size === 'major') || (z >= 6 && h.size === 'regional');
      if (label) { ctx.font = (h.size === 'mega' ? 'bold 11px' : '11px') + ' sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(4,12,20,0.6)'; const t = h.name.split(' (')[0]; const tw = ctx.measureText(t).width; ctx.fillRect(p.x + r + 3, p.y - 7, tw + 4, 14); ctx.fillStyle = '#eaffea'; ctx.fillText(t, p.x + r + 5, p.y); }
      if (this.layers.jobs && jobs && z >= 5) {
        const e = jobs.harbors.find((x) => x.id === h.id); const n = e ? e.jobs.length : 0;
        if (n) { ctx.fillStyle = '#f2b134'; ctx.beginPath(); ctx.arc(p.x + r + 2, p.y - r - 2, 6, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#1a1200'; ctx.font = 'bold 8px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(String(n), p.x + r + 2, p.y - r - 1.5); }
      }
    }
    // tow jobs have a position at sea: small amber markers
    if (this.layers.jobs && jobs && z >= 6) {
      ctx.strokeStyle = '#f2b134'; ctx.lineWidth = 1.5; ctx.font = '9px sans-serif'; ctx.textAlign = 'left'; ctx.fillStyle = '#ffd98a';
      for (const e of jobs.harbors) for (const j of e.jobs) if (j.at && Number.isFinite(j.at.lat)) { const p = this.project(j.at.lat, j.at.lon); if (!this.onScreen(p)) continue; ctx.beginPath(); ctx.moveTo(p.x, p.y - 5); ctx.lineTo(p.x + 5, p.y); ctx.lineTo(p.x, p.y + 5); ctx.lineTo(p.x - 5, p.y); ctx.closePath(); ctx.stroke(); if (z >= 8) ctx.fillText('tow', p.x + 7, p.y); }
    }
  }
  drawHover() {
    const hv = this.hover; if (!hv) return;
    const ctx = this.ctx, p = this.project(hv.lat, hv.lon);
    ctx.font = '11px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const t = hv.text; const tw = ctx.measureText(t).width + 10;
    const x = Math.min(p.x + 12, this.W - tw - 4), y = Math.max(12, p.y - 14);
    ctx.fillStyle = 'rgba(4,12,20,0.85)'; ctx.fillRect(x, y - 9, tw, 18); ctx.strokeStyle = 'rgba(140,190,230,0.5)'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y - 8.5, tw - 1, 17);
    ctx.fillStyle = '#dbe9f4'; ctx.fillText(t, x + 5, y);
  }
  drawScaleBar() {
    const ctx = this.ctx, mpp = this.mPerPx();
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
    let nm = steps[0]; for (const s of steps) if ((s * NM) / mpp <= Math.min(160, this.W * 0.3)) nm = s;
    const px = (nm * NM) / mpp, x = 12, y = this.H - 16;
    ctx.fillStyle = 'rgba(4,12,20,0.6)'; ctx.fillRect(x - 4, y - 16, px + 8, 24);
    ctx.strokeStyle = '#dbe9f4'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + px, y); ctx.moveTo(x, y - 5); ctx.lineTo(x, y + 3); ctx.moveTo(x + px, y - 5); ctx.lineTo(x + px, y + 3); ctx.stroke();
    ctx.font = '10px monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillStyle = '#dbe9f4'; ctx.fillText(`${nm} nm`, x, y - 4);
  }
  drawAttribution() {
    const ctx = this.ctx;
    let t = 'Chart: Natural Earth';
    if (this.tilesDrawn) t = '© OpenStreetMap contributors' + (this.seaDrawn ? ' · © OpenSeaMap' : '');
    ctx.font = '10px sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    const tw = ctx.measureText(t).width + 8;
    ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.fillRect(this.W - tw, this.H - 15, tw, 15);
    ctx.fillStyle = '#223'; ctx.fillText(t, this.W - 4, this.H - 2);
  }
  onScreen(p, pad = 20) { return p.x >= -pad && p.x <= this.W + pad && p.y >= -pad && p.y <= this.H + pad; }

  // ------------------------------------------------------------------ info line, voyage line
  updateInfo() {
    if (!this.info) return;
    const parts = [];
    const c = this.cursor;
    if (c) {
      parts.push(`${fmtDMS(c.lat, true)} ${fmtDMS(c.lon, false)}`);
      const d = this.cursorDepth;
      if (d && Math.abs(d.lat - c.lat) < 0.02 && Math.abs(d.lon - c.lon) < 0.02) parts.push(d.h == null ? 'depth —' : d.h >= 0 ? `land +${d.h.toFixed(0)} m` : `depth ${(-d.h).toFixed(d.h > -20 ? 1 : 0)} m`);
      const t = this.cursorTide;
      if (t && Math.abs(t.lat - c.lat) < 0.3 && Math.abs(t.lon - c.lon) < 0.3 && t.tide) {
        const td = t.tide; const now = this.app.simTime || Date.now() / 1000;
        const next = td.state === 'flood' ? `HW ${fmtClock(td.nextHigh)} (${fmtDur(td.nextHigh - now)})` : `LW ${fmtClock(td.nextLow)} (${fmtDur(td.nextLow - now)})`;
        const strKn = td.stream ? Math.hypot(td.stream.u, td.stream.v) / GEO.KN_TO_MS : 0;
        parts.push(`tide ${td.height >= 0 ? '+' : ''}${td.height.toFixed(1)} m ${td.state === 'flood' ? 'rising' : 'falling'} · ${next}${strKn > 0.05 ? ` · stream ${strKn.toFixed(1)} kn` : ''}`);
      }
      const s = this.app.ship;
      if (s) parts.push(`${fmtDistance(haversine(s.lat, s.lon, c.lat, c.lon))} ${String(Math.round(bearing(s.lat, s.lon, c.lat, c.lon))).padStart(3, '0')}° from ship`);
    } else parts.push(this.mode === 'route' ? 'Route mode: tap open water to add waypoints · long-press / right-click a waypoint to remove it' : 'Select mode: tap a harbour or ship for details');
    parts.push(`z ${this.zoom.toFixed(1)}`);
    if (this.route.length) { const { nm, etaSec } = this.routeStats(); parts.push(`route ${this.route.length} wp · ${nm.toFixed(1)} nm · ETA ${fmtDur(etaSec)}`); }
    this.info.textContent = parts.join(' · ');
  }
  pushVoyage() {
    const hud = this.app.hud; if (!hud?.showVoyage) return;
    const { nm, etaSec, expressCost } = this.routeStats();
    const key = `${this.route.length}|${nm.toFixed(2)}|${Math.round(etaSec / 60)}|${this.app.autopilot ? 1 : 0}`;
    if (key === this._voyageKey) return;
    this._voyageKey = key;
    hud.showVoyage(this.getRoute(), etaSec, expressCost);
  }
  fetchCursorData() {
    const c = this.cursor; if (!c) return;
    const lat = c.lat, lon = c.lon;
    fetch(`/api/height?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`).then((r) => r.json()).then((j) => { this.cursorDepth = { lat, lon, h: Number.isFinite(j?.h) ? j.h : null }; this.updateInfo(); }).catch(() => {});
    const t = this.cursorTide;
    if (!t || Math.abs(t.lat - lat) > 0.25 || Math.abs(t.lon - lon) > 0.25 || performance.now() - t.at > 60000) {
      fetch(`/api/tide?lat=${lat.toFixed(3)}&lon=${lon.toFixed(3)}`).then((r) => r.json()).then((j) => { this.cursorTide = { lat, lon, tide: j && Number.isFinite(j.height) ? j : null, at: performance.now() }; this.updateInfo(); }).catch(() => {});
    }
  }

  // ------------------------------------------------------------------ interaction
  bindCanvas() {
    const cv = this.canvas;
    cv.style.touchAction = 'none';
    const pos = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    cv.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { cv.setPointerCapture(e.pointerId); } catch {}
      const p = pos(e);
      this.pointers.set(e.pointerId, p);
      if (this.pointers.size === 1) {
        this.gesture = { x0: p.x, y0: p.y, x: p.x, y: p.y, t0: performance.now(), moved: false, button: e.button, long: false };
        clearTimeout(this.longTimer);
        this.longTimer = setTimeout(() => { if (this.gesture && !this.gesture.moved) { this.gesture.long = true; this.longPress(this.gesture.x, this.gesture.y); } }, 550);
      } else if (this.pointers.size === 2) {
        clearTimeout(this.longTimer);
        const [a, b] = [...this.pointers.values()];
        this.gesture = { pinch: true, dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, moved: true };
      }
    });
    cv.addEventListener('pointermove', (e) => {
      const p = pos(e);
      if (!this.pointers.has(e.pointerId)) { this.hoverAt(p); return; }
      this.pointers.set(e.pointerId, p);
      const g = this.gesture; if (!g) return;
      if (g.pinch && this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y), mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        if (g.dist > 0 && dist > 0) this.zoomAt(mid.x, mid.y, Math.log2(dist / g.dist));
        this.panPx(mid.x - g.mid.x, mid.y - g.mid.y);
        g.dist = dist; g.mid = mid; this.requestDraw();
        return;
      }
      if (g.pinch) return;
      const dx = p.x - g.x, dy = p.y - g.y;
      if (!g.moved && Math.hypot(p.x - g.x0, p.y - g.y0) > 5) { g.moved = true; clearTimeout(this.longTimer); this.hidePopup(); }
      if (g.moved) { this.panPx(dx, dy); g.x = p.x; g.y = p.y; this.requestDraw(); }
    });
    const end = (e) => {
      const p = pos(e);
      const had = this.pointers.delete(e.pointerId);
      const g = this.gesture;
      if (!had || !g) { if (!this.pointers.size) this.gesture = null; return; }
      if (g.pinch) { if (this.pointers.size < 2) this.gesture = this.pointers.size === 1 ? { x0: -999, y0: -999, x: [...this.pointers.values()][0].x, y: [...this.pointers.values()][0].y, moved: true, t0: 0 } : null; return; }
      clearTimeout(this.longTimer);
      if (!g.moved && !g.long && e.type === 'pointerup') { if (g.button === 2) this.removeAt(p.x, p.y); else this.click(p.x, p.y); }
      this.gesture = null;
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('lostpointercapture', (e) => { if (this.pointers.has(e.pointerId)) end(e); });
    cv.addEventListener('pointerleave', (e) => { if (!this.pointers.size) { this.cursor = null; this.hover = null; this.updateInfo(); this.requestDraw(); } });
    cv.addEventListener('wheel', (e) => { e.preventDefault(); const p = pos(e); const dz = -Math.sign(e.deltaY) * (e.ctrlKey ? 0.15 : 0.35); this.zoomAt(p.x, p.y, dz); }, { passive: false });
    cv.addEventListener('dblclick', (e) => { e.preventDefault(); const p = pos(e); this.zoomAt(p.x, p.y, 1); });
    cv.addEventListener('contextmenu', (e) => { e.preventDefault(); });
  }
  hoverAt(p) {
    const ll = this.unproject(p.x, p.y);
    this.cursor = { x: p.x, y: p.y, lat: ll.lat, lon: ll.lon };
    clearTimeout(this.cursorTimer); this.cursorTimer = setTimeout(() => this.fetchCursorData(), 300);
    const hit = this.hitShip(p.x, p.y, 10);
    const text = hit ? hit.text : null;
    if ((this.hover?.text || null) !== text) { this.hover = hit ? { lat: hit.lat, lon: hit.lon, text } : null; this.requestDraw(); }
    this.updateInfo();
  }
  hitWaypoint(x, y, r = 12) { for (let i = this.route.length - 1; i >= 0; i--) { const p = this.project(this.route[i].lat, this.route[i].lon); if (Math.hypot(p.x - x, p.y - y) <= r) return i; } return -1; }
  hitHarbor(x, y, r = 12) {
    let best = null, bd = r;
    for (const h of this.app.world?.harbors || []) { if (!this.harborVisible(h)) continue; const p = this.project(h.lat, h.lon); const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = h; } }
    return best;
  }
  hitShip(x, y, r = 10) {
    let best = null, bd = r;
    const consider = (lat, lon, obj) => { const p = this.project(lat, lon); const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = { ...obj, lat, lon }; } };
    const a = this.app;
    if (this.layers.ai && this.zoom >= 4) for (const s of collectAi(a)) consider(s.lat, s.lon, { kind: 'ai', text: `${s.name}${s.destName ? ' → ' + s.destName : ''}${s.eta ? ' · ETA ' + fmtClock(s.eta > 1e11 ? s.eta / 1000 : s.eta) : ''}`, data: s });
    for (const o of a.others?.values?.() || []) { const c = o.cur || o; consider(c.lat, c.lon, { kind: 'player', text: `${o.name} · ${SHIP_CLASSES[o.cls]?.name || o.cls || 'ship'}`, data: o }); }
    for (const c of a.cutters?.values?.() || []) { const cur = c.cur || c; consider(cur.lat, cur.lon, { kind: 'cutter', text: `${c.name || 'Coast guard'} · ${c.state || 'patrol'}`, data: c }); }
    for (const r of collectRescues(a)) consider(r.lat, r.lon, { kind: 'rescue', text: `SAR ${r.kind} → ${r.playerName || ''}`, data: r });
    return best;
  }
  click(x, y) {
    const wi = this.hitWaypoint(x, y);
    if (wi >= 0) { this.showWaypointPopup(wi); return; }
    const h = this.hitHarbor(x, y);
    if (h) { this.showHarborPopup(h); return; }
    const s = this.hitShip(x, y, 10);
    if (s) { this.showShipPopup(s); return; }
    const ll = this.unproject(x, y);
    if (this.mode === 'route') { this.hidePopup(); this.addWaypoint(ll.lat, ll.lon); }
    else this.showPointPopup(ll.lat, ll.lon);
  }
  longPress(x, y) {
    const wi = this.hitWaypoint(x, y, 16);
    if (wi >= 0) { this.removeWaypoint(wi); if (navigator.vibrate) navigator.vibrate(20); return; }
    const ll = this.unproject(x, y); this.showPointPopup(ll.lat, ll.lon);
  }
  removeAt(x, y) { const wi = this.hitWaypoint(x, y, 16); if (wi >= 0) this.removeWaypoint(wi); }

  // ------------------------------------------------------------------ popups (DOM, so they can scroll and hold buttons)
  ensurePopup() {
    if (this.popup) return this.popup;
    let el = this.wrap?.querySelector('#chartPopup');
    if (!el) { el = document.createElement('div'); el.id = 'chartPopup'; (this.body || this.wrap || document.body).appendChild(el); }
    el.classList.add('hidden');
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.addEventListener('wheel', (e) => e.stopPropagation());
    this.popup = el; return el;
  }
  hidePopup() { if (this.popup) { this.popup.classList.add('hidden'); this.popup.innerHTML = ''; } this.popupAnchor = null; }
  openPopup(lat, lon, build) {
    const el = this.ensurePopup(); el.innerHTML = '';
    const head = document.createElement('div'); head.className = 'popHead';
    const close = document.createElement('button'); close.className = 'close'; close.textContent = '×'; close.title = 'Close'; close.onclick = () => this.hidePopup();
    const body = document.createElement('div'); body.className = 'popBody';
    el.append(head, body);
    build(head, body); head.appendChild(close);
    el.classList.remove('hidden');
    this.popupAnchor = { lat, lon };
    this.positionPopup();
  }
  positionPopup() {
    const el = this.popup, an = this.popupAnchor; if (!el || !an || el.classList.contains('hidden')) return;
    const p = this.project(an.lat, an.lon);
    const w = el.offsetWidth || 280, h = el.offsetHeight || 160;
    let x = p.x + 14, y = p.y - 20;
    if (x + w > this.W - 8) x = Math.max(8, p.x - w - 14);
    if (y + h > this.H - 8) y = Math.max(8, this.H - h - 8);
    if (y < 8) y = 8;
    if (this.W < 520) { x = 8; y = Math.max(8, this.H - h - 8); }                   // phones: bottom sheet
    el.style.left = x + 'px'; el.style.top = y + 'px';
  }
  btn(label, fn, cls) { const b = document.createElement('button'); b.textContent = label; if (cls) b.className = cls; b.onclick = fn; return b; }
  jobRows(entry, table) {
    const you = this.app.you, C = you ? SHIP_CLASSES[you.ship.cls] : null, now = this.app.simTime || Date.now() / 1000;
    const hname = (id) => this.app.world?.harbors?.find((x) => x.id === id)?.name?.split(' (')[0] || id;
    const thead = document.createElement('tr'); thead.innerHTML = '<th>Contract</th><th class="num">Pay</th><th class="num">Pay/t</th><th class="num">Dist</th><th class="num">Deadline</th>'; table.appendChild(thead);
    for (const j of entry.jobs) {
      const tr = document.createElement('tr');
      const dl = j.deadline - now; const dlTxt = dl < 0 ? 'expired' : dl < 48 * 3600 ? `${Math.floor(dl / 3600)} h` : `${Math.floor(dl / 86400)} d`;
      const perT = j.qty ? fmtN(j.pay / j.qty) : j.pax ? fmtN(j.pay / j.pax) + '/pax' : '—';
      const needs = j.needsCat && C && !j.needsCat.includes(C.cat) ? ' <span class="pill bad">needs yacht or ferry</span>' : j.needsCat ? ' <span class="pill">yacht or ferry</span>' : '';
      const td1 = document.createElement('td'); td1.innerHTML = `<span class="pill ${j.type === 'fishing' ? 'good' : j.type === 'smuggling' ? 'bad' : ''}">${j.type}</span>`; td1.append(document.createTextNode(j.title || `${j.type} to ${hname(j.to)}`)); td1.insertAdjacentHTML('beforeend', needs);
      tr.appendChild(td1);
      for (const t of [`${fmtN(j.pay)} cr`, perT, j.distKm ? `${j.distKm} km` : '—', dlTxt]) { const td = document.createElement('td'); td.className = 'num'; td.textContent = t; tr.appendChild(td); }
      table.appendChild(tr);
    }
  }
  showHarborPopup(h) {
    const a = this.app, s = a.ship;
    this.openPopup(h.lat, h.lon, (head, body) => {
      const b = document.createElement('b'); b.textContent = h.name; head.appendChild(b);
      const sub = document.createElement('span'); sub.className = 'muted'; sub.textContent = ` ${h.country} · ${h.size} port${s ? ' · ' + fmtDistance(haversine(s.lat, s.lon, h.lat, h.lon)) + ' ' + String(Math.round(bearing(s.lat, s.lon, h.lat, h.lon))).padStart(3, '0') + '°' : ''}`; head.appendChild(sub);
      const entry = this.jobsFor(h.id);
      const row = document.createElement('div'); row.className = 'inline';
      row.append(this.btn('Centre', () => this.setCenter(h.lat, h.lon, Math.max(this.zoom, 11))), this.btn('Route here', () => { this.addWaypoint(h.lat, h.lon); this.hidePopup(); }));
      if (a.you?.docked === h.id) { const d = document.createElement('span'); d.className = 'pill good'; d.textContent = 'you are docked here'; row.appendChild(d); }
      body.appendChild(row);
      if (entry) {
        const p = document.createElement('p'); p.className = 'muted'; p.textContent = `Fuel ${fmtN(entry.fuel)} cr/t · ${entry.used} used hull${entry.used === 1 ? '' : 's'} for sale · ${entry.jobs.length} contract${entry.jobs.length === 1 ? '' : 's'} on the board`; body.appendChild(p);
        if (entry.jobs.length) { const table = document.createElement('table'); this.jobRows(entry, table); body.appendChild(table); }
      } else { const p = document.createElement('p'); p.className = 'muted'; p.textContent = cachedJobs() ? 'No job board data for this harbour yet.' : 'Loading job board…'; body.appendChild(p); if (!cachedJobs()) fetchJobs().then(() => { if (this.popupAnchor && this.popupAnchor.lat === h.lat) this.showHarborPopup(h); }); }
    });
  }
  showShipPopup(hit) {
    const a = this.app, s = a.ship, d = hit.data;
    this.openPopup(hit.lat, hit.lon, (head, body) => {
      const b = document.createElement('b'); b.textContent = hit.kind === 'ai' ? d.name : hit.kind === 'cutter' ? (d.name || 'Coast guard cutter') : hit.kind === 'rescue' ? `SAR ${d.kind}` : d.name; head.appendChild(b);
      const lines = [];
      const cur = d.cur || d;
      if (hit.kind === 'ai') lines.push(`${SHIP_CLASSES[d.cls]?.name || d.cls || 'vessel'}${d.flag ? ' · ' + d.flag : ''}`, `${d.state || 'underway'}${d.destName ? ' → ' + d.destName : ''}${d.eta ? ' · ETA ' + fmtClock(d.eta > 1e11 ? d.eta / 1000 : d.eta) + ' UTC' : ''}`);
      if (hit.kind === 'player') lines.push(`${SHIP_CLASSES[d.cls]?.name || d.cls || 'ship'}${d.convoyId && d.convoyId === a.you?.convoyId ? ' · convoy mate' : ''}${d.wanted ? ' · wanted' : ''}${d.docked ? ' · docked' : d.sinking ? ' · SINKING' : ''}`);
      if (hit.kind === 'cutter') lines.push(`Coast guard · ${d.state || 'patrol'}`);
      if (hit.kind === 'rescue') lines.push(`${d.state || ''} · for ${d.playerName || ''}`);
      lines.push(`${(cur.spd ?? 0).toFixed(1)} kn · heading ${String(Math.round(cur.hdg ?? 0)).padStart(3, '0')}°`);
      if (s) lines.push(`${fmtDistance(haversine(s.lat, s.lon, hit.lat, hit.lon))} at ${String(Math.round(bearing(s.lat, s.lon, hit.lat, hit.lon))).padStart(3, '0')}° from you`);
      for (const l of lines) { const p = document.createElement('div'); p.textContent = l; body.appendChild(p); }
      const row = document.createElement('div'); row.className = 'inline';
      row.appendChild(this.btn('Centre', () => this.setCenter(hit.lat, hit.lon, Math.max(this.zoom, 11))));
      if (hit.kind === 'player' && d.id) { row.appendChild(this.btn('Trade', () => a.hud?.tradeDialog?.(d.id))); row.appendChild(this.btn('Convoy', () => a.net.action('convoy_invite', { targetId: d.id }))); }
      body.appendChild(row);
    });
  }
  showWaypointPopup(i) {
    const w = this.route[i];
    this.openPopup(w.lat, w.lon, (head, body) => {
      const b = document.createElement('b'); b.textContent = `Waypoint ${i + 1}`; head.appendChild(b);
      const p = document.createElement('div'); p.textContent = `${fmtDMS(w.lat, true)} ${fmtDMS(w.lon, false)}`; body.appendChild(p);
      const row = document.createElement('div'); row.className = 'inline';
      row.append(this.btn('Remove', () => { this.removeWaypoint(i); this.hidePopup(); }, 'danger'), this.btn('Sail route', () => { this.sailRoute(); this.hidePopup(); }, 'primary'));
      body.appendChild(row);
    });
  }
  showPointPopup(lat, lon) {
    const a = this.app, s = a.ship;
    this.openPopup(lat, lon, (head, body) => {
      const b = document.createElement('b'); b.textContent = 'Position'; head.appendChild(b);
      const p = document.createElement('div'); p.textContent = `${fmtDMS(lat, true)} ${fmtDMS(lon, false)}${s ? ` · ${fmtDistance(haversine(s.lat, s.lon, lat, lon))} ${String(Math.round(bearing(s.lat, s.lon, lat, lon))).padStart(3, '0')}°` : ''}`; body.appendChild(p);
      const row = document.createElement('div'); row.className = 'inline';
      row.append(this.btn('Add waypoint', () => { this.addWaypoint(lat, lon); this.hidePopup(); }, 'primary'));
      const nm = s ? haversine(s.lat, s.lon, lat, lon) / NM : 0;
      row.append(this.btn(`Express passage (${fmtN(nm * SIM.EXPRESS_CR_PER_NM)} cr)`, () => { if (confirm(`Pay ${fmtN(nm * SIM.EXPRESS_CR_PER_NM)} cr plus fuel and wear to arrive there now?`)) { a.net.action('express', { lat, lon }); this.hidePopup(); } }));
      row.append(this.btn('Set voyage', () => { a.net.action('set_voyage', { lat, lon, throttle: 0.7 }); a.hud?.event?.({ kind: 'info', text: 'Voyage set: the crew keeps sailing there while you are away.' }); this.hidePopup(); }));
      body.appendChild(row);
    });
  }

  // ------------------------------------------------------------------ toolbar
  bindButtons() {
    const q = (id) => (this.wrap || document).querySelector('#' + id);
    const on = (id, fn) => { const b = q(id); if (b) b.onclick = (e) => { e.preventDefault(); fn(); }; return b; };
    on('chartZoomIn', () => this.zoomAt(this.W / 2, this.H / 2, 1));
    on('chartZoomOut', () => this.zoomAt(this.W / 2, this.H / 2, -1));
    on('chartCentre', () => this.centerOnShip());
    on('chartModeBtn', () => this.setMode(this.mode === 'route' ? 'select' : 'route'));
    on('chartClear', () => this.clearRoute());
    on('chartSail', () => this.sailRoute());
    on('chartSeamarks', () => this.setLayer('seamarks', !this.layers.seamarks));
    on('chartBase', () => this.setLayer('base', !this.layers.base));
    on('chartTilesBtn', () => this.setLayer('tiles', !this.layers.tiles));
    on('chartClose', () => this.app.hud?.toggleChart ? this.app.hud.toggleChart() : this.close());
    this.syncButtons();
  }
  syncButtons() {
    const q = (id) => (this.wrap || document).querySelector('#' + id);
    const m = q('chartModeBtn'); if (m) { m.textContent = this.mode === 'route' ? 'Route mode' : 'Select mode'; m.classList.toggle('on', this.mode === 'route'); }
    const s = q('chartSeamarks'); if (s) s.classList.toggle('on', this.layers.seamarks);
    const b = q('chartBase'); if (b) b.classList.toggle('on', this.layers.base);
    const t = q('chartTilesBtn'); if (t) t.classList.toggle('on', this.layers.tiles);
  }
}
