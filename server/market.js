// World market (docs/V6-QUICK-CONTRACTS.md §3, V6-PLAN item 7): a snapshot of every harbour's prices and stock, an hourly
// price history kept 7 days (data/market-history.json), and the trade-route finder (best margin for YOUR ship: hold,
// fuel at service speed, wages, wear, port dues, pilotage, a berth day, the real sea distance from the route table).
// Pure functions over the Game's harbour state; nothing here mutates the economy.
import fs from 'node:fs';
import path from 'node:path';
import { GOODS, SHIP_CLASSES } from '../shared/constants.js';
import { haversine } from '../shared/geo.js';
import { RATES, serviceKn, serviceBurnTph, serviceWearPerH, kmHours } from '../shared/rates.js';
import { HARBORS, harborById } from './harbors.js';
import {
  MARKET_GOODS, ECON, TRADE, priceOf, marketTrend, tradeQuote, portDues, pilotageFee, berthFeePerDay, repairCostFor,
} from './economy.js';
import { tradeCheck, makeCtx } from '../shared/politics.js';   // world politics H23

export const MARKET = {
  SAMPLE_S: 3600,        // price history: one sample per harbour × good every hour (on the hour)
  KEEP: 168,             // … kept 7 days (ring); ~0.5 MB JSON for 602 series
  SNAPSHOT_MS: 5000,     // /api/market is cached this long
  ROUTES_LIMIT: 20, ROUTES_LIMIT_MAX: 50,
  BERTH_DAYS: 1,         // berth fee days counted at the destination
  ALL_NEAREST: 80,       // from=all: each origin is compared with its 80 nearest harbours (v7: ~340 harbours worldwide)
};

const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

// ------------------------------------------------------------------------------------------------ snapshot
/** Every harbour's buy/sell price, stock, normal stock and trend per market good. Pure read of game.harbors. */
export function marketSnapshot(game) {
  const harbors = [];
  for (const h of HARBORS) {
    const st = game.harbors?.[h.id]; if (!st || !st.market) continue;
    const trend = marketTrend(st), goods = {};
    for (const g of MARKET_GOODS) {
      const stock = st.stock?.[g], target = st.target?.[g];
      goods[g] = {
        buy: tradeQuote(h, st, g, 1, 'buy').unit, sell: tradeQuote(h, st, g, 1, 'sell').unit,
        stock: Number.isFinite(stock) ? Math.round(stock) : null, target: Number.isFinite(target) ? Math.round(target) : null, trend: trend[g] ?? 0,
      };
    }
    let anchor = null; try { const a = game.harborAnchor ? game.harborAnchor(h) : h; anchor = { lat: r6(a.lat), lon: r6(a.lon) }; } catch { anchor = { lat: h.lat, lon: h.lon }; }
    let fuel = null; try { fuel = game.fuelPrice ? game.fuelPrice(h) : null; } catch { fuel = null; }
    harbors.push({ id: h.id, name: h.name, country: h.country, size: h.size, lat: h.lat, lon: h.lon, anchor, fuel, goods });
  }
  return {
    time: Date.now(), simTime: Math.round(game.simTime || Date.now() / 1000),
    goods: MARKET_GOODS.map((g) => ({ id: g, name: GOODS[g].name, base: GOODS[g].base })),
    spread: TRADE.SPREAD, impact: TRADE.IMPACT,
    harbors,
  };
}
const r6 = (v) => Math.round(v * 1e6) / 1e6;
/** The snapshot, cached SNAPSHOT_MS per game (the HTTP handler's view). */
const snapCache = new WeakMap();
export function cachedSnapshot(game, nowMs = Date.now()) {
  const c = snapCache.get(game);
  if (c && nowMs - c.at < MARKET.SNAPSHOT_MS) return c.snap;
  const snap = marketSnapshot(game);
  snapCache.set(game, { at: nowMs, snap });
  return snap;
}

// ------------------------------------------------------------------------------------------------ expected prices
/** Deterministic part of driftEconomy: stock after `hours` drifting toward target (noise ignored). */
export function expectedStockAfter(st, good, hours) {
  const t = st.target?.[good] || 1, s = st.stock?.[good] ?? t;
  const h = Math.max(0, Number(hours) || 0);
  return Math.max(0, t + (s - t) * Math.pow(1 - ECON.DRIFT_PER_H, h));
}
export function expectedPriceAfter(harbor, st, good, hours) {
  return priceOf(harbor, good, expectedStockAfter(st, good, hours), st.target?.[good] ?? 1);
}

// ------------------------------------------------------------------------------------------------ trade finder
const SORTS = ['tkm', 'hour', 'net'];
const one = (v) => (Array.isArray(v) ? v[0] : v);
/** /api/market/routes query → { ok: true, q } | { ok: false, error }. */
export function parseRoutesQuery(query = {}) {
  const from = one(query.from), cls = one(query.cls);
  if (typeof from !== 'string' || !from) return { ok: false, error: 'from=<harbour id>|all is required' };
  if (from !== 'all' && !harborById(from)) return { ok: false, error: 'unknown harbour' };
  if (typeof cls !== 'string' || !Object.prototype.hasOwnProperty.call(SHIP_CLASSES, cls)) return { ok: false, error: 'unknown ship class' };
  const C = SHIP_CLASSES[cls];
  let hold = C.capacity;
  const hq = one(query.hold);
  if (hq !== undefined && hq !== '') { hold = Number(hq); if (!Number.isFinite(hold) || hold <= 0) return { ok: false, error: 'hold must be more than 0 t' }; hold = Math.min(hold, C.capacity); }
  let cash = Infinity;
  const cq = one(query.cash);
  if (cq !== undefined && cq !== '') { cash = Number(cq); if (!Number.isFinite(cash) || cash < 0) return { ok: false, error: 'cash must be 0 or more' }; }
  let good = null;
  const gq = one(query.good);
  if (gq !== undefined && gq !== '' && gq !== 'all') { if (typeof gq !== 'string' || !MARKET_GOODS.includes(gq)) return { ok: false, error: 'unknown good' }; good = gq; }
  let limit = MARKET.ROUTES_LIMIT;
  const lq = one(query.limit);
  if (lq !== undefined && lq !== '') { limit = Math.floor(Number(lq)); if (!Number.isFinite(limit) || limit < 1) return { ok: false, error: 'limit must be 1–50' }; limit = Math.min(MARKET.ROUTES_LIMIT_MAX, limit); }
  let sort = 'tkm';
  const sq = one(query.sort);
  if (sq !== undefined && sq !== '') { if (!SORTS.includes(sq)) return { ok: false, error: 'sort=tkm|hour|net' }; sort = sq; }
  let lat = null, lon = null;
  const la = one(query.lat), lo = one(query.lon);
  if (la !== undefined && lo !== undefined && la !== '' && lo !== '') {
    lat = Number(la); lon = Number(lo);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return { ok: false, error: 'lat/lon' };
  }
  return { ok: true, q: { from, cls, hold, cash, good, limit, sort, lat, lon } };
}

/** Largest integer qty ≤ cap whose buy total fits in cash (binary search, ≤ 14 steps for the 5000 t cap… any cap). */
export function affordableQty(harbor, st, good, cap, cash) {
  cap = Math.floor(Math.max(0, cap));
  if (cap < 1) return 0;
  if (!(cash < Infinity)) return cap;
  if (tradeQuote(harbor, st, good, cap, 'buy').total <= cash) return cap;
  let lo = 0, hi = cap; // total(lo) ≤ cash < total(hi)
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (tradeQuote(harbor, st, good, mid, 'buy').total <= cash) lo = mid; else hi = mid; }
  return lo;
}

const sortKey = { tkm: (r) => r.perTkm, hour: (r) => r.perHour, net: (r) => r.net };
const cmpRows = (sort) => (x, y) => (sortKey[sort](y) - sortKey[sort](x)) || (y.net - x.net);

// bestOnly (the from=all search keeps one row per harbour): only rows that beat the best so far are built.
function rowsFrom(game, routeTable, A, q, bestOnly = false) {
  let bestK = -Infinity, bestNet = -Infinity;
  const stA = game.harbors?.[A.id]; if (!stA || !stA.stock) return [];
  const C = SHIP_CLASSES[q.cls], cap = C.capacity;
  const goods = q.good ? [q.good] : MARKET_GOODS;
  const polCtx = q.home && q.flag && game.politics ? makeCtx(game.politics.ds, { home: q.home, flag: q.flag, simTime: game.simTime }) : null;
  const fuelPrice = game.fuelPrice ? game.fuelPrice(A) : (stA.market?.fuel || GOODS.fuel.base) * (A.fuelMul || 1);
  const pointCr = repairCostFor(q.cls, 99);
  const wearH = serviceWearPerH(q.cls);
  const rows = [];
  // destinations and their sea distance once per origin (not per good)
  const dests = [];
  for (const B of HARBORS) {
    if (B.id === A.id) continue;
    const stB = game.harbors?.[B.id]; if (!stB || !stB.stock) continue;
    let dist = null; try { dist = routeTable ? routeTable.estimateKm(A.id, B.id) : null; } catch { dist = null; }
    if (!routeTable) dist = { km: haversine(A.lat, A.lon, B.lat, B.lon) / 1000 * RATES.DETOUR, est: true };
    if (!dist || !(dist.km > 0)) continue;
    dests.push({ B, stB, dist });
  }
  // the all-harbour scan (one best row per origin) compares each origin with its ALL_NEAREST nearest harbours by sea:
  // with ~340 harbours worldwide a full cross product stalls the game loop for ~0.5 s (v7 world coverage)
  if (bestOnly && dests.length > MARKET.ALL_NEAREST) { dests.sort((x, y) => x.dist.km - y.dist.km); dests.length = MARKET.ALL_NEAREST; }
  for (const g of goods) {
    const stock = stA.stock[g] ?? 0;
    if (!(stock >= 1)) continue;
    if (polCtx && tradeCheck(game.politics.ds, polCtx, { harbor: A, good: g, side: 'buy' }).ok === false) continue;   // world politics H23: not for this company
    const cap0 = Math.min(q.hold, stock);
    const qty = affordableQty(A, stA, g, cap0, q.cash);
    if (qty < 1) continue;
    // the term that set qty; ties → hold, stock, cash
    const limitedBy = qty === Math.floor(cap0) ? (Math.floor(q.hold) <= Math.floor(stock) ? 'hold' : 'stock') : 'cash';
    const buy = tradeQuote(A, stA, g, qty, 'buy');
    const load = qty / cap;
    const kn = serviceKn(q.cls, load), burn = serviceBurnTph(q.cls, load);
    for (const { B, stB, dist } of dests) {
      // the expected price lies between today's price and the price at the target stock (stock drifts toward target)
      if (Math.max(stB.market?.[g] ?? Infinity, priceOf(B, g, stB.target?.[g] ?? 1, stB.target?.[g] ?? 1)) <= buy.unit) continue;
      const hours = kmHours(dist.km, kn);
      // a sale can never beat the buy price when the expected mid price at B is not above it (spread and impact only
      // lower a sale) — skipping those keeps the all-harbour search fast with ~340 harbours (v7 world coverage)
      const stockB = expectedStockAfter(stB, g, hours);
      if (priceOf(B, g, stockB, stB.target?.[g] ?? 1) <= buy.unit) continue;
      const fuelT = burn * hours, fuelCr = fuelT * fuelPrice;
      const wagesCr = (C.crewCost || 0) * hours;
      const wearCr = wearH * hours * pointCr;
      const duesCr = portDues(q.cls, B), pilotCr = pilotageFee(q.cls, B), berthCr = berthFeePerDay(q.cls) * MARKET.BERTH_DAYS;
      const stB2 = { stock: { [g]: stockB }, target: stB.target }; // tradeQuote reads stock[g] and target[g] only
      const sellQ = tradeQuote(B, stB2, g, qty, 'sell');
      const revenue = sellQ.total;
      const cost = buy.total + fuelCr + wagesCr + wearCr + duesCr + pilotCr + berthCr;
      const net = revenue - cost;
      if (!(net > 0)) continue;
      if (bestOnly) {
        const k = q.sort === 'hour' ? Math.round(net / (hours + 1)) : q.sort === 'net' ? net : r3(net / (qty * dist.km));
        if (k < bestK || (k === bestK && net <= bestNet)) continue;
        bestK = k; bestNet = net;
      }
      const costs = { goods: buy.total, fuel: Math.round(fuelCr), wages: Math.round(wagesCr), wear: Math.round(wearCr), dues: duesCr, pilotage: pilotCr, berth: berthCr };
      const fuelCap = C.fuelCap || 0;
      const bunker = fuelCap > 0 && fuelT > 0.9 * fuelCap ? Math.ceil(fuelT / (0.9 * fuelCap)) - 1 : 0;
      rows.push({
        good: g, from: A.id, fromName: A.name, to: B.id, toName: B.name,
        qty, limitedBy, buy: buy.unit, buyFirst: tradeQuote(A, stA, g, 1, 'buy').unit, sellNow: tradeQuote(B, stB, g, 1, 'sell').unit, sellArrive: sellQ.unit,
        distKm: r1(dist.km), distEst: !!dist.est, hours: r2(hours), fuelT: r1(fuelT),
        costs, revenue, net: Math.round(net), netPerT: r1(net / qty), perTkm: r3(net / (qty * dist.km)), perHour: Math.round(net / (hours + 1)),
        stockFrom: Math.round(stock), stockTo: Math.round(stB.stock[g] ?? 0), targetTo: Math.round(stB.target?.[g] ?? 0), bunker,
        toLat: B.lat, toLon: B.lon, fromLat: A.lat, fromLon: A.lon,
      });
    }
  }
  return rows;
}

/** The trade finder (§3.3). Pure given its inputs. */
export function findTrades(game, routeTable, q) {
  const C = SHIP_CLASSES[q.cls];
  const cmp = cmpRows(q.sort || 'tkm');
  let trades = [];
  if (q.from === 'all') {
    for (const A of HARBORS) {
      const rows = rowsFrom(game, routeTable, A, q, true);
      if (!rows.length) continue;
      rows.sort(cmp);
      const best = rows[0];
      if (Number.isFinite(q.lat) && Number.isFinite(q.lon)) best.fromDistKm = r1(haversine(q.lat, q.lon, A.lat, A.lon) / 1000);
      trades.push(best);
    }
  } else {
    const A = harborById(q.from);
    trades = A ? rowsFrom(game, routeTable, A, q) : [];
    if (A && Number.isFinite(q.lat) && Number.isFinite(q.lon)) { const d = r1(haversine(q.lat, q.lon, A.lat, A.lon) / 1000); for (const t of trades) t.fromDistKm = d; }
  }
  trades.sort(cmp);
  trades = trades.slice(0, q.limit || MARKET.ROUTES_LIMIT);
  return {
    time: Date.now(), from: q.from, cls: q.cls, hold: q.hold, cash: Number.isFinite(q.cash) ? q.cash : null,
    assumptions: {
      throttle: RATES.SERVICE_THROTTLE, serviceKnEmpty: r2(serviceKn(q.cls, 0)), wageCrPerH: C.crewCost || 0, berthDays: MARKET.BERTH_DAYS,
      pricing: `tradeQuote (spread ${TRADE.SPREAD}, impact ${TRADE.IMPACT ? 'on' : 'off'}); destination stock drifts toward normal while you sail`,
      spread: TRADE.SPREAD, impact: TRADE.IMPACT,
    },
    trades,
  };
}

// ------------------------------------------------------------------------------------------------ price history
export class PriceHistory {
  constructor({ file, log = () => {}, keep = MARKET.KEEP, sampleS = MARKET.SAMPLE_S } = {}) {
    this.file = file; this.log = log; this.keep = keep; this.sampleS = sampleS;
    this.times = []; this.series = {};
  }
  clear() { this.times = []; this.series = {}; }
  /** Missing → empty; corrupt / wrong shape → empty + one log line; never throws. */
  load() {
    this.clear();
    try {
      if (!this.file || !fs.existsSync(this.file)) return this;
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!j || typeof j !== 'object' || !Array.isArray(j.times) || !j.series || typeof j.series !== 'object') throw new Error('wrong shape');
      if (!j.times.every((t, i) => Number.isFinite(t) && (i === 0 || t > j.times[i - 1]))) throw new Error('times not increasing');
      if (j.sampleS && j.sampleS !== this.sampleS) throw new Error('other sample interval');
      let times = j.times.slice(-this.keep);
      const n = times.length, cut = j.times.length - n;
      const known = new Set(HARBORS.map((h) => h.id));
      for (const [id, goods] of Object.entries(j.series)) {
        if (!known.has(id) || !goods || typeof goods !== 'object') continue;
        const out = {};
        for (const g of MARKET_GOODS) {
          let arr = Array.isArray(goods[g]) ? goods[g].map((v) => (Number.isFinite(v) ? Math.round(v) : null)) : [];
          // pad (front) / trim to the full time axis, then drop what fell off the ring
          if (arr.length < j.times.length) arr = [...new Array(j.times.length - arr.length).fill(null), ...arr];
          else if (arr.length > j.times.length) arr = arr.slice(arr.length - j.times.length);
          out[g] = arr.slice(cut);
        }
        this.series[id] = out;
      }
      this.times = times;
    } catch (e) { this.clear(); this.log('[market] price history unreadable, starting empty:', e.message); }
    return this;
  }
  /** tmp + rename; never throws. */
  save() {
    if (!this.file) return false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, sampleS: this.sampleS, times: this.times, series: this.series }));
      fs.renameSync(tmp, this.file);
      return true;
    } catch (e) { this.log('[market] price history save failed', e.message); return false; }
  }
  get samples() { return this.times.length; }
  maybeSample(game, nowS = Date.now() / 1000) {
    const slot = Math.floor(nowS / this.sampleS);
    const last = this.times.length ? Math.floor(this.times[this.times.length - 1] / this.sampleS) : -Infinity;
    if (!(slot > last)) return false;
    this.sample(game, nowS);
    return true;
  }
  sample(game, nowS = Date.now() / 1000) {
    const t = Math.floor(nowS / this.sampleS) * this.sampleS;
    if (this.times.length && t <= this.times[this.times.length - 1]) return false;
    const n = this.times.length;
    this.times.push(t);
    for (const h of HARBORS) {
      const st = game.harbors?.[h.id];
      let s = this.series[h.id];
      if (!s) { s = this.series[h.id] = {}; }
      for (const g of MARKET_GOODS) {
        if (!Array.isArray(s[g])) s[g] = new Array(n).fill(null);
        const v = st?.market?.[g];
        s[g].push(Number.isFinite(v) ? Math.round(v) : null);
      }
    }
    // a harbour in the file but not in the game (should not happen: load drops unknown ones) keeps its axis
    for (const s of Object.values(this.series)) for (const g of MARKET_GOODS) if (s[g].length < this.times.length) s[g].push(null);
    if (this.times.length > this.keep) {
      const drop = this.times.length - this.keep;
      this.times.splice(0, drop);
      for (const s of Object.values(this.series)) for (const g of MARKET_GOODS) s[g].splice(0, drop);
    }
    this.save();
    return true;
  }
  window(days) {
    const d = Math.max(1, Math.min(7, Math.floor(Number(days) || 7)));
    if (!this.times.length) return { from: 0, d };
    const lastT = this.times[this.times.length - 1], cutoff = lastT - d * 86400;
    let i = 0; while (i < this.times.length && this.times[i] <= cutoff) i++;
    return { from: i, d };
  }
  forGood(good, days = 7) {
    const { from } = this.window(days), series = {};
    for (const [id, s] of Object.entries(this.series)) series[id] = (s[good] || []).slice(from);
    return { good, sampleS: this.sampleS, times: this.times.slice(from), series };
  }
  forHarbor(id, days = 7) {
    const { from } = this.window(days), series = {}, s = this.series[id] || {};
    for (const g of MARKET_GOODS) series[g] = (s[g] || new Array(this.times.length).fill(null)).slice(from);
    return { harbor: id, sampleS: this.sampleS, times: this.times.slice(from), series };
  }
}

// ------------------------------------------------------------------------------------------------ HTTP handlers
/** GET /api/market/routes: 429 above `perMin` requests a minute per IP; the answer is cached `cacheMs` per exact query
 *  string (from=all scores ~51,000 rows). `find` is injectable for tests. */
export function routesHandler({ game, routeTable, find = findTrades, perMin = 30, cacheMs = 30000, now = () => Date.now() }) {
  const hits = new Map(), cache = new Map();
  let windowAt = now();
  return (req, res) => {
    const t = now();
    if (t - windowAt >= 60000) { hits.clear(); windowAt = t; }
    for (const [k, v] of cache) if (t - v.at >= cacheMs) cache.delete(k);
    const ip = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '?';
    const n = (hits.get(ip) || 0) + 1; hits.set(ip, n);
    if (n > perMin) return res.status(429).json({ error: 'too many trade searches — try again in a minute' });
    const p = parseRoutesQuery(req.query || {});
    if (!p.ok) return res.status(400).json({ error: p.error });
    const key = String(req.originalUrl || req.url || JSON.stringify(req.query));
    const c = cache.get(key);
    if (c) return res.json(c.body);
    const body = find(game, routeTable, p.q);
    cache.set(key, { at: t, body });
    return res.json(body);
  };
}
/** GET /api/market/history?good=|harbor=&days= */
export function historyAnswer(history, query = {}) {
  const days = Math.max(1, Math.min(7, Math.floor(Number(one(query.days)) || 7)));
  const good = one(query.good), harbor = one(query.harbor);
  if (good !== undefined) {
    if (typeof good !== 'string' || !MARKET_GOODS.includes(good)) return { status: 400, body: { error: 'unknown good' } };
    return { status: 200, body: history.forGood(good, days) };
  }
  if (harbor !== undefined) {
    if (typeof harbor !== 'string' || !harborById(harbor)) return { status: 400, body: { error: 'unknown harbour' } };
    return { status: 200, body: history.forHarbor(harbor, days) };
  }
  return { status: 400, body: { error: 'good=<good> or harbor=<id>' } };
}
