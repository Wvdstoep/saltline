// AI merchant traffic (docs/V3-CONTRACTS.md §2): ~150 ships (v7: about two thirds of them worldwide) sailing the sea-lane graph between real harbours,
// mooring and anchoring in real time. Deterministic given `rnd`; cheap enough to tick at 10 Hz.
import { GEO, SHIP_CLASSES } from '../shared/constants.js';
import { haversine, bearing, destination, normDeg, angleDiff } from '../shared/geo.js';
import { buildGraph, inDetailRegion } from './lanes.js';

const NAMES = ['Nordic Star', 'Maas Trader', 'Elbe Express', 'Baltic Wind', 'Atlantic Dawn', 'Sea Falcon', 'Ocean Pride', 'Celtic Voyager', 'Northern Light', 'Stena Carrier', 'Hanse Spirit', 'Frisian Sky', 'Thames Runner', 'Viking Bay', 'Skagen Queen', 'Humber Pioneer', 'Waddenzee', 'Zeeland Breeze', 'Scheldt Merchant', 'Rhine Arrow', 'Kattegat', 'Bergen Fjord', 'Aberdeen Venture', 'Dover Belle', 'Solent Star', 'Channel Hawk', 'Orkney Isle', 'Shetland Swan', 'Texel Tide', 'Dogger Pearl', 'Helgoland', 'Wilhelmshaven', 'Antwerp Glory', 'Calais Spirit', 'Le Havre Trader', 'Iberian Sun', 'Gibraltar Rock', 'Canary Wave', 'Cape Mariner', 'Indian Pearl', 'Singapore Link', 'Pacific Harmony', 'Orient Bridge', 'Panama Gate', 'Gulf Stream', 'Caribbean Jewel', 'Hudson Bay', 'Boston Clipper', 'Arctic Fox', 'Polar Bear', 'Fair Wind', 'Morning Glory', 'Silver Dolphin', 'Golden Gate', 'Red Kestrel', 'Blue Marlin', 'Green Island', 'White Cliff', 'Black Swan', 'Grey Heron', 'Amber Coast', 'Coral Reef', 'Emerald Sea', 'Sapphire Bay', 'Ruby Princess', 'Jade Horizon', 'Onyx Spirit', 'Ivory Coast', 'Granite Point', 'Iron Duke', 'Steel Navigator', 'Copper Moon', 'Bronze Age', 'Tin Lizzie', 'Lady Anne', 'Queen Mary', 'Princess Ida', 'Duke of York', 'Earl Grey', 'Baron Hill', 'Margarethe', 'Johanna', 'Annika', 'Ingrid', 'Sofie', 'Elisabeth', 'Wilhelmina', 'Juliana', 'Beatrix', 'Amalia'];
const FLAGS = ['NL', 'DE', 'GB', 'NO', 'DK', 'BE', 'FR', 'MT', 'LR', 'PA', 'CY', 'BS', 'MH', 'SE', 'FI', 'PT', 'ES', 'SG', 'HK', 'GR'];
// class weights: cargo dominates, then working boats, ferries, yachts
const MIX = [['coaster', 14], ['feeder', 10], ['bulker', 7], ['tanker', 7], ['boxship', 5], ['trawler', 6], ['tug', 3], ['psv', 4], ['ferry', 5], ['myacht', 2], ['superyacht', 1], ['sloop', 2], ['ketch', 1], ['catamaran', 1]];
const MIX_TOTAL = MIX.reduce((s, m) => s + m[1], 0);

export class Traffic {
  constructor(world, harbors, { count = 150, rnd, log, weatherAt } = {}) {
    this.world = world; this.harbors = harbors || []; this.log = log || (() => {});
    this.weatherAt = typeof weatherAt === 'function' ? weatherAt : null;
    let seed = 1234567; this.rnd = rnd || (() => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; });
    this.t = Date.now() / 1000; this.ships = []; this.lastWx = 0;
    this.byId = new Map(this.harbors.map((h) => [h.id, h]));
    try { this.graph = world ? buildGraph(world) : null; } catch (e) { this.graph = null; this.log('[traffic] lane graph failed', e.message); }
    if (!this.graph) return;
    this.region = this.harbors.filter((h) => inDetailRegion(h.lat, h.lon));
    this.global = this.harbors.filter((h) => !inDetailRegion(h.lat, h.lon));
    this.routeCache = new Map();
    for (let i = 0; i < count; i++) this.spawn(i);
    this.log(`[traffic] ${this.ships.length} AI ships on ${this.graph.nodes.size ?? '?'} lane nodes (${this.graph.dropped ?? 0} edges dropped over land)`);
  }
  pick(arr) { return arr[Math.floor(this.rnd() * arr.length)]; }
  pickCls(regional) {
    let r = this.rnd() * MIX_TOTAL;
    for (const [c, w] of MIX) { r -= w; if (r <= 0) return !regional && SHIP_CLASSES[c].length < 40 ? 'feeder' : c; }
    return 'coaster';
  }
  route(a, b) {
    const k = a + '>' + b;
    if (!this.routeCache.has(k)) { let r = null; try { r = this.graph.route(a, b); } catch { r = null; } this.routeCache.set(k, r && r.length >= 2 ? r.map((p) => [p[0], p[1]]) : null); }
    return this.routeCache.get(k);
  }
  /** Choose a destination from harbour `from` with a usable route; regional ships stay mostly regional. */
  nextLeg(s, fromId) {
    const from = this.byId.get(fromId);
    for (let tries = 0; tries < 12; tries++) {
      const pool = s.regional ? (this.rnd() < 0.92 ? this.region : this.harbors) : (this.rnd() < 0.8 ? this.global : this.harbors);
      const to = this.pick(pool);
      if (!to || to.id === fromId) continue;
      const d = haversine(from.lat, from.lon, to.lat, to.lon);
      if (s.regional && d > 900e3 && this.rnd() < 0.8) continue;
      if (!s.regional && d > 3500e3 && this.rnd() < 0.75) continue; // world traffic: mostly regional trades, some ocean crossings
      if (SHIP_CLASSES[s.cls].length < 30 && d > 400e3) continue; // yachts and tugs make short hops
      const r = this.route(fromId, to.id);
      if (r) return { to, path: r };
    }
    return null;
  }
  spawn(i) {
    const busy = this.region.filter((h) => h.size === 'mega' || h.size === 'major');
    const seedPort = i < 2 * busy.length && i < 24; // a couple of ships lie in every big regional port from the start
    const regional = seedPort || this.rnd() < 0.35; // v7: the rest spread over the ~290 harbours outside the North Sea
    const homePool = regional && this.region.length ? this.region : this.global.length ? this.global : this.harbors;
    const home = seedPort ? busy[i % busy.length] : this.pick(homePool);
    const cls = this.pickCls(regional);
    const C = SHIP_CLASSES[cls];
    const s = { id: 'ai' + (i + 1), name: NAMES[i % NAMES.length] + (i >= NAMES.length ? ' ' + (Math.floor(i / NAMES.length) + 1) : ''), flag: this.pick(FLAGS), cls, regional,
      lat: home.lat, lon: home.lon, hdg: this.rnd() * 360, spd: 0, kn: C.maxKn * (0.7 + 0.25 * this.rnd()), state: 'moored', at: home.id, dest: home.id, path: null, wp: 0, until: 0, eta: 0 };
    this.ships.push(s);
    const leg = this.nextLeg(s, home.id);
    if (leg && !seedPort && this.rnd() < 0.7) { // start somewhere along a voyage
      this.startLeg(s, home.id, leg);
      const n = s.path.length; const k = 1 + Math.floor(this.rnd() * (n - 1));
      const a = s.path[k - 1], b = s.path[k], f = this.rnd();
      s.lat = a[0] + (b[0] - a[0]) * f; s.lon = a[1] + (b[1] - a[1]) * f; s.wp = k; s.hdg = bearing(s.lat, s.lon, b[0], b[1]); s.spd = s.kn;
    } else this.moor(s, home, this.rnd() * 4 * 3600);
  }
  startLeg(s, fromId, leg) {
    s.state = 'underway'; s.at = null; s.dest = leg.to.id; s.path = leg.path; s.wp = 1; s.anchored = false;
    s.anchorStop = (leg.to.size === 'mega' || leg.to.size === 'major') && this.rnd() < 0.3;
  }
  moor(s, h, seconds) {
    s.state = 'moored'; s.at = h.id; s.dest = h.id; s.spd = 0; s.path = null;
    // lie a little off the harbour point (stay on water) so moored ships do not stack on one spot
    const p = destination(h.lat, h.lon, this.rnd() * 360, 80 + this.rnd() * 250);
    if (!this.world || this.world.isWater(p.lat, p.lon)) { s.lat = p.lat; s.lon = p.lon; } else { s.lat = h.lat; s.lon = h.lon; }
    s.until = this.t + (seconds ?? (1 + this.rnd() * 5) * 3600);
  }
  tick(dt) {
    if (!this.graph) return;
    dt = Math.max(0, Math.min(5, Number(dt) || 0));
    this.t += dt;
    const wxCheck = this.weatherAt && this.t - this.lastWx > 30; if (wxCheck) this.lastWx = this.t;
    for (const s of this.ships) {
      if (s.state === 'moored' || s.state === 'anchored') {
        if (this.t < s.until) continue;
        if (s.state === 'anchored') { s.state = 'underway'; continue; } // continue the last leg into port
        const leg = this.nextLeg(s, s.at); if (leg) this.startLeg(s, s.at, leg); else s.until = this.t + 3600;
        continue;
      }
      if (wxCheck) { try { const w = this.weatherAt(s.lat, s.lon); s.wxMul = w ? 1 - 0.35 * Math.max(0, Math.min(1, w.storm || 0)) - 0.15 * Math.max(0, Math.min(1, w.sea || 0)) : 1; } catch { s.wxMul = 1; } }
      const C = SHIP_CLASSES[s.cls];
      const tgt = s.path[s.wp];
      if (!tgt) { this.moor(s, this.byId.get(s.dest)); continue; }
      const dist = haversine(s.lat, s.lon, tgt[0], tgt[1]);
      const last = s.wp === s.path.length - 1;
      // anchor in the roads before a busy port for a while
      if (last && s.anchorStop && !s.anchored && dist < 6000) { s.anchored = true; s.state = 'anchored'; s.spd = 0; s.until = this.t + (0.5 + this.rnd() * 1.5) * 3600; continue; }
      const want = s.kn * (s.wxMul ?? 1) * (last && dist < 3000 ? Math.max(0.25, dist / 3000) : 1);
      s.spd += (want - s.spd) * Math.min(1, dt / 40);
      const brg = bearing(s.lat, s.lon, tgt[0], tgt[1]);
      const turn = Math.max(-C.turnRate * dt, Math.min(C.turnRate * dt, angleDiff(s.hdg, brg)));
      s.hdg = normDeg(s.hdg + turn);
      const step = s.spd * GEO.KN_TO_MS * dt;
      if (dist <= Math.max(step * 1.5, last ? 150 : 400)) {
        if (last) { this.moor(s, this.byId.get(s.dest)); continue; }
        s.wp++; continue;
      }
      // the position follows the land-checked lane line exactly; the heading only turns smoothly for display
      const n = destination(s.lat, s.lon, brg, step);
      s.lat = n.lat; s.lon = n.lon;
    }
  }
  remainingM(s) {
    if (s.state !== 'underway' && s.state !== 'anchored' || !s.path) return 0;
    let d = 0, a = [s.lat, s.lon];
    for (let k = s.wp; k < s.path.length; k++) { d += haversine(a[0], a[1], s.path[k][0], s.path[k][1]); a = s.path[k]; }
    return d;
  }
  pub(s) {
    const dest = this.byId.get(s.dest);
    const rem = this.remainingM(s), v = Math.max(1, s.kn * GEO.KN_TO_MS);
    return { id: s.id, name: s.name, cls: s.cls, flag: s.flag, lat: Math.round(s.lat * 1e6) / 1e6, lon: Math.round(s.lon * 1e6) / 1e6, hdg: Math.round(s.hdg * 10) / 10,
      spd: Math.round(s.spd * 10) / 10, dest: s.dest, destName: dest ? dest.name : s.dest, state: s.state, eta: Math.round(s.state === 'moored' ? s.until : Date.now() / 1000 + rem / v) };
  }
  near(lat, lon, rangeM) {
    const out = [];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return out;
    const dLat = rangeM / GEO.M_PER_DEG_LAT, dLon = rangeM / (GEO.M_PER_DEG_LON_EQ * Math.max(0.05, Math.cos(lat * Math.PI / 180)));
    for (const s of this.ships) {
      if (Math.abs(s.lat - lat) > dLat) continue;
      let dl = Math.abs(s.lon - lon); if (dl > 180) dl = 360 - dl; if (dl > dLon) continue;
      if (haversine(lat, lon, s.lat, s.lon) <= rangeM) out.push(this.pub(s));
    }
    return out;
  }
  all() { return this.ships.map((s) => this.pub(s)); }
}
