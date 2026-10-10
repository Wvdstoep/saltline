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
import { activeEcon } from './econstate.js';                     // world economy (server/worldecon.js)
import { canLoad, CARGO, unitsOf } from '../shared/cargo.js';
import { catalogueOf } from '../shared/econ/catalogue.js';
import { ECON2, buyable as econBuyable, histEncode, histDecode } from '../shared/econ/model.js';

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
    time: Date.now(), simTime: Math.round(game.simTime || Date.now() / 1000), v: 2,
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
  const e = activeEcon(), i = e?.stOf.get(st);
  if (e && i != null) return e.expectedStock(e.harbors[i].id, good, hours, st);   // world economy §9.4: §6.4 closed form with seasons
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
  if (gq !== undefined && gq !== '' && gq !== 'all') { if (typeof gq !== 'string' || !(MARKET_GOODS.includes(gq) || (activeEcon() && catalogueOf(gq)))) return { ok: false, error: 'unknown good' }; good = gq; }
  let mode = 'trades';
  const mq = one(query.mode);
  if (mq !== undefined && mq !== '') { if (mq !== 'trades' && mq !== 'requests') return { ok: false, error: 'mode=trades|requests' }; mode = mq; }
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
  return { ok: true, q: { from, cls, hold, cash, good, limit, sort, lat, lon, mode } };
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
  const econ = activeEcon();
  // world economy §9.4: only goods this origin can sell (buyable ≥ 1) and this hull can load
  const goods = econ ? (q.good ? [q.good] : [...econ.rowMap[econ.hIdx.get(A.id)]?.keys() || []]).filter((g) => { const k = econ.row(A.id, g); return k >= 0 && canLoad(g, q.cls).ok && econBuyable(econ.roleAt(A.id, g), Number(stA.stock[g]) || 0, econ.n(k)) >= 1; }) : q.good ? [q.good] : MARKET_GOODS;
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
    const stock = econ ? econBuyable(econ.roleAt(A.id, g), Number(stA.stock[g]) || 0, econ.n(econ.row(A.id, g))) : stA.stock[g] ?? 0;
    if (!(stock >= 1)) continue;
    const holdT = econ ? holdTonnes(q.cls, q.hold, g) : q.hold;
    if (polCtx && tradeCheck(game.politics.ds, polCtx, { harbor: A, good: g, side: 'buy' }).ok === false) continue;   // world politics H23: not for this company
    const cap0 = Math.min(holdT, stock);
    const qty = affordableQty(A, stA, g, cap0, q.cash);
    if (qty < 1) continue;
    // the term that set qty; ties → hold, stock, cash
    const limitedBy = qty === Math.floor(cap0) ? (Math.floor(holdT) <= Math.floor(stock) ? 'hold' : 'stock') : 'cash';
    const buy = tradeQuote(A, stA, g, qty, 'buy');
    const load = qty / cap;
    const kn = serviceKn(q.cls, load), burn = serviceBurnTph(q.cls, load);
    for (const { B, stB, dist } of dests) {
      if (econ && econ.row(B.id, g) < 0) continue;             // world economy: destinations that list the good
      if (econ && A.country !== B.country && econ.banned(g, A.country, B.country)) continue;   // §9.3: a territorial import ban seizes it there
      // the expected price lies between today's price and the price at the target stock (stock drifts toward target)
      const sEqB = econ ? econ.sEqOf(econ.row(B.id, g), stB) ?? stB.target?.[g] ?? 1 : stB.target?.[g] ?? 1;
      if (Math.max(stB.market?.[g] ?? Infinity, priceOf(B, g, sEqB, stB.target?.[g] ?? 1)) <= buy.unit) continue;
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
      if (econ) econ.stOf.set(stB2, econ.hIdx.get(B.id));
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
        ...(econ ? { role: `${econ.roleAt(A.id, g)}→${econ.roleAt(B.id, g)}`, why: econ.why(econ.hIdx.get(B.id), econ.row(B.id, g), stB) } : {}),
      });
    }
  }
  return rows;
}

/** The trade finder (§3.3). Pure given its inputs. */
export function findTrades(game, routeTable, q) {
  if (q.mode === 'requests') return findRequests(game, routeTable, q);
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

// ------------------------------------------------------------------------------------------------ world economy (§9.4, §13, §15)
/** Tonnes of `good` a class can lift with `hold` t free: its unit capacity (TEU × 12, CEU × 1.5 …) and reefer plugs. */
export function holdTonnes(cls, hold, good) {
  const c = CARGO[good]; if (!c) return hold;
  const u = unitsOf(cls), opt = c.opts.find((o) => canLoad(good, cls).ok && (o.h === 'box' ? u.teu > 0 : true));
  let t = hold;
  if (c.unit !== 't' && u[c.unit] > 0) t = Math.min(t, u[c.unit] * c.tPer);
  if (opt?.plugs) t = Math.min(t, (u.plugs || 0) * 14);
  return Math.max(0, Math.floor(t));
}
const KMH = 1.852;
/** Trade finder, requests mode: one row per open request this hull can carry, sourced from the cheapest maker (or
 *  trader) it can reach within the deadline at service speed; net = locked price × qty − goods − voyage costs. */
export function findRequests(game, routeTable, q) {
  const econ = activeEcon(), C = SHIP_CLASSES[q.cls];
  const out = { time: Date.now(), from: q.from, cls: q.cls, hold: q.hold, cash: Number.isFinite(q.cash) ? q.cash : null, mode: 'requests', assumptions: { throttle: RATES.SERVICE_THROTTLE, spread: TRADE.SPREAD, impact: TRADE.IMPACT, pricing: 'request price is locked at posting; goods bought at the source with impact and spread' }, trades: [] };
  if (!econ) return out;
  const km = (a, b) => { let d = null; try { d = routeTable ? routeTable.estimateKm(a.id, b.id) : null; } catch { d = null; } return d && d.km > 0 ? d : { km: haversine(a.lat, a.lon, b.lat, b.lon) / 1000 * RATES.DETOUR, est: true }; };
  const pointCr = repairCostFor(q.cls, 99), wearH = serviceWearPerH(q.cls);
  const origin = q.from !== 'all' ? harborById(q.from) : null;
  for (const r of econ.requests({ good: q.good || null })) {
    if (!canLoad(r.good, q.cls).ok || !(r.open > 0)) continue;
    const R = harborById(r.harbor), stR = game.harbors?.[R.id]; if (!R || !stR) continue;
    const want = Math.min(holdTonnes(q.cls, q.hold, r.good), r.open);
    if (!(want >= 1)) continue;
    let best = null;
    const srcs = econ.makersOf(r.good).concat(econ.harbors.filter((h) => econ.roleAt(h.id, r.good) === 'L'));
    for (const M of srcs) {
      if (M.id === R.id || (origin && M.id !== origin.id)) continue;
      if (M.country !== R.country && econ.banned(r.good, M.country, R.country)) continue;   // §9.3: seized there
      const stM = game.harbors?.[M.id], k = econ.row(M.id, r.good); if (!stM || k < 0) continue;
      const can = econBuyable(econ.roleAt(M.id, r.good), Number(stM.stock[r.good]) || 0, econ.n(k));
      const qty = affordableQty(M, stM, r.good, Math.min(want, can), q.cash);
      if (!(qty >= 1)) continue;
      const d = km(M, R), load = qty / C.capacity, kn = serviceKn(q.cls, load), hours = kmHours(d.km, kn);
      if (!(hours <= r.leftH)) continue;
      const buy = tradeQuote(M, stM, r.good, qty, 'buy');
      const fuelCr = serviceBurnTph(q.cls, load) * hours * (game.fuelPrice ? game.fuelPrice(M) : GOODS.fuel.base);
      const costs = { goods: buy.total, fuel: Math.round(fuelCr), wages: Math.round((C.crewCost || 0) * hours), wear: Math.round(wearH * hours * pointCr), dues: portDues(q.cls, R), pilotage: pilotageFee(q.cls, R), berth: berthFeePerDay(q.cls) * MARKET.BERTH_DAYS };
      const revenue = Math.round(r.unit * qty), net = revenue - Object.values(costs).reduce((a, b) => a + b, 0);
      if (!(net > 0)) continue;
      const row = {
        mode: 'request', reqId: r.id, good: r.good, from: M.id, fromName: M.name, to: R.id, toName: R.name, qty, fills: `${Math.round(qty)} of ${Math.round(r.open)} t`, open: r.open,
        buy: buy.unit, unit: r.unit, premium: r.premium, distKm: r1(d.km), distEst: !!d.est, hours: r2(hours), marginH: r2(r.leftH - hours),
        costs, revenue, net, netPerT: r1(net / qty), perTkm: r3(net / (qty * d.km)), perHour: Math.round(net / (hours + 1)), role: `${econ.roleAt(M.id, r.good)}→I`,
        why: { code: 'request', text: `Request +${Math.round(r.premium * 100)} %` }, toLat: R.lat, toLon: R.lon, fromLat: M.lat, fromLon: M.lon,
      };
      if (!best || sortKey[q.sort || 'tkm'](row) > sortKey[q.sort || 'tkm'](best)) best = row;
    }
    if (best) out.trades.push(best);
  }
  out.trades.sort(cmpRows(q.sort || 'tkm'));
  out.trades = out.trades.slice(0, q.limit || MARKET.ROUTES_LIMIT);
  return out;
}

/**
 * Price history v2 (§13): per listed row an hourly ring (168) and a 6-hourly ring (120) of 16-bit price indexes
 * (round(price / base × 10,000)), ≈ 4.4 MB for ~7,700 rows. File: one JSON header line + the raw rings, written
 * atomically on the hour. At memguard `shed` the 6-hourly ring goes to disk and is dropped (reloaded at `ok`); at
 * `critical` sampling pauses. A v1 JSON file converts once (legacy 7 goods kept) and is renamed .v1.bak.
 */
export class EconHistory {
  constructor({ file, econ, log = () => {}, v1File = null } = {}) {
    this.file = file; this.v1File = v1File; this.econ = econ; this.log = log;
    this.H1 = ECON2.HIST_HOURLY; this.H6 = ECON2.HIST_6H; this.sampleS = MARKET.SAMPLE_S;
    this.paused = false;
    this.clear();
  }
  get K() { return this.econ.K; }
  clear() {
    this.h1 = new Uint16Array(this.K * this.H1); this.h6 = new Uint16Array(this.K * this.H6);
    this.t1 = new Float64Array(this.H1); this.t6 = new Float64Array(this.H6);
    this.n1 = 0; this.i1 = 0; this.n6 = 0; this.i6 = 0; this.shed6 = false;
  }
  get samples() { return this.n1; }
  bytes() { return this.h1.byteLength + (this.h6 ? this.h6.byteLength : 0) + this.t1.byteLength + this.t6.byteLength; }
  keys() { const e = this.econ, out = new Array(e.K); for (let k = 0; k < e.K; k++) out[k] = `${e.harbors[e.hOfRow(k)].id}:${e.gOf(k)}`; return out; }
  lastT() { return this.n1 ? this.t1[(this.i1 + this.H1 - 1) % this.H1] : -Infinity; }
  maybeSample(game, nowS = Date.now() / 1000) {
    if (this.paused) return false;
    const slot = Math.floor(nowS / this.sampleS) * this.sampleS;
    if (!(slot > this.lastT())) return false;
    this.sample(game, nowS);
    return true;
  }
  sample(game, nowS = Date.now() / 1000) {
    const t = Math.floor(nowS / this.sampleS) * this.sampleS;
    if (t <= this.lastT()) return false;
    const prices = this.econ.pricesNow(new Float64Array(this.K)), H1 = this.H1, H6 = this.H6;
    for (let k = 0; k < this.K; k++) this.h1[k * H1 + this.i1] = histEncode(prices[k], this.econ.baseOfRow(k));
    this.t1[this.i1] = t; this.i1 = (this.i1 + 1) % H1; this.n1 = Math.min(H1, this.n1 + 1);
    if (Math.floor(t / 3600) % 6 === 0 && this.h6) {
      for (let k = 0; k < this.K; k++) this.h6[k * H6 + this.i6] = histEncode(prices[k], this.econ.baseOfRow(k));
      this.t6[this.i6] = t; this.i6 = (this.i6 + 1) % H6; this.n6 = Math.min(H6, this.n6 + 1);
    }
    this.save();
    return true;
  }
  /** Decoded prices of row k, oldest first: the last `days` of the hourly ring (≤ 7) every `stepH` hours, or 6-hourly for days > 7. */
  series(k, days = 7, stepH = 1) {
    if (!(k >= 0) || k >= this.K) return [];
    const six = days > 7 && this.h6, ring = six ? this.h6 : this.h1, H = six ? this.H6 : this.H1, n = six ? this.n6 : this.n1, i0 = six ? this.i6 : this.i1;
    const want = Math.min(n, six ? Math.ceil(days * 4) : Math.round(days * 24)), base = this.econ.baseOfRow(k), out = [];
    const step = six ? 1 : Math.max(1, Math.round(stepH));
    for (let j = want - 1; j >= 0; j -= step) out.push(histDecode(ring[k * H + ((i0 - 1 - j) % H + H) % H], base));
    return out;
  }
  times(days = 7) {
    const six = days > 7 && this.h6, t = six ? this.t6 : this.t1, H = six ? this.H6 : this.H1, n = six ? this.n6 : this.n1, i0 = six ? this.i6 : this.i1;
    const want = Math.min(n, six ? Math.ceil(days * 4) : Math.round(days * 24)), out = [];
    for (let j = want - 1; j >= 0; j--) out.push(t[((i0 - 1 - j) % H + H) % H]);
    return out;
  }
  /** 24 h change in % (1 decimal) or null. */
  d24(k) {
    if (this.n1 < 25 || !(k >= 0) || k >= this.K) return null;
    const H = this.H1, a = this.h1[k * H + ((this.i1 - 25) % H + H) % H], b = this.h1[k * H + ((this.i1 - 1) % H + H) % H];
    if (!a || !b) return null;
    return Math.round(((b - a) / a) * 1000) / 10;
  }
  forGood(good, days = 7) {
    const e = this.econ, series = {};
    for (let i = 0; i < e.harbors.length; i++) { const k = e.rowMap[i].get(good); if (k != null) series[e.harbors[i].id] = this.series(k, days); }
    return { good, sampleS: days > 7 ? 6 * 3600 : this.sampleS, times: this.times(days), series };
  }
  forHarbor(id, days = 7) {
    const e = this.econ, i = e.hIdx.get(id), series = {};
    if (i != null) for (const [g, k] of e.rowMap[i]) series[g] = this.series(k, days);
    return { harbor: id, sampleS: days > 7 ? 6 * 3600 : this.sampleS, times: this.times(days), series };
  }
  // ---- memory guard
  shed() {
    if (!this.h6 || this.shed6) return false;
    try { if (this.file) { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file + '.6h', Buffer.from(this.h6.buffer, this.h6.byteOffset, this.h6.byteLength)); } } catch (e) { this.log('[market] 6-hourly ring spill failed', e.message); }
    this.h6 = null; this.shed6 = true;
    return true;
  }
  restore() {
    if (!this.shed6) return false;
    const h6 = new Uint16Array(this.K * this.H6);
    try { const b = fs.readFileSync(this.file + '.6h'); if (b.length === h6.byteLength) Buffer.from(h6.buffer).set(b); } catch { /* starts empty */ }
    this.h6 = h6; this.shed6 = false;
    return true;
  }
  onLevel(level, LEVEL) { if (level >= LEVEL.shed) this.shed(); else if (level <= LEVEL.ok) this.restore(); this.paused = level >= LEVEL.critical; }
  // ---- file
  save() {
    if (!this.file) return false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const head = JSON.stringify({ v: 2, ver: this.econ.eds.v, K: this.K, H1: this.H1, H6: this.H6, n1: this.n1, i1: this.i1, n6: this.n6, i6: this.i6, has6: !!this.h6, t1: [...this.t1], t6: [...this.t6], rows: this.keys() }) + '\n';
      const parts = [Buffer.from(head), Buffer.from(this.h1.buffer, this.h1.byteOffset, this.h1.byteLength)];
      if (this.h6) parts.push(Buffer.from(this.h6.buffer, this.h6.byteOffset, this.h6.byteLength));
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, Buffer.concat(parts));
      fs.renameSync(tmp, this.file);
      return true;
    } catch (e) { this.log('[market] price history save failed', e.message); return false; }
  }
  /** Missing → empty (a v1 JSON converts); corrupt → empty + one log line; never throws. */
  load() {
    this.clear();
    try {
      if (this.file && fs.existsSync(this.file)) { this.loadBin(fs.readFileSync(this.file)); return this; }
      if (this.v1File && fs.existsSync(this.v1File)) { this.loadV1(JSON.parse(fs.readFileSync(this.v1File, 'utf8'))); this.save(); try { fs.renameSync(this.v1File, this.v1File.replace(/\.json$/, '') + '.v1.bak'); } catch { /* keep */ } }
    } catch (e) { this.clear(); this.log('[market] price history unreadable, starting empty:', e.message); }
    return this;
  }
  loadBin(buf) {
    const nl = buf.indexOf(10); if (nl < 0) throw new Error('no header');
    const h = JSON.parse(buf.subarray(0, nl).toString('utf8'));
    if (h.v !== 2 || h.H1 !== this.H1 || h.H6 !== this.H6 || !Array.isArray(h.rows) || h.rows.length !== h.K) throw new Error('wrong shape');
    const need = nl + 1 + h.K * h.H1 * 2 + (h.has6 ? h.K * h.H6 * 2 : 0);
    if (buf.length !== need) throw new Error(`size ${buf.length} ≠ ${need}`);
    const src1 = new Uint16Array(h.K * h.H1), src6 = new Uint16Array(h.K * h.H6);
    Buffer.from(src1.buffer).set(buf.subarray(nl + 1, nl + 1 + src1.byteLength));
    if (h.has6) Buffer.from(src6.buffer).set(buf.subarray(nl + 1 + src1.byteLength, need));
    const here = new Map(this.keys().map((key, k) => [key, k]));   // rows map by `${harbour}:${good}` across dataset versions
    h.rows.forEach((key, j) => { const k = here.get(key); if (k == null) return; this.h1.set(src1.subarray(j * h.H1, (j + 1) * h.H1), k * this.H1); this.h6.set(src6.subarray(j * h.H6, (j + 1) * h.H6), k * this.H6); });
    this.t1.set(h.t1.slice(0, this.H1)); this.t6.set(h.t6.slice(0, this.H6));
    Object.assign(this, { n1: h.n1 | 0, i1: h.i1 | 0, n6: h.n6 | 0, i6: h.i6 | 0 });
  }
  /** v1: { times: [hourly], series: { hId: { good: [price|null] } } } → the hourly ring (legacy goods only). */
  loadV1(j) {
    if (!j || !Array.isArray(j.times) || !j.series || typeof j.series !== 'object') throw new Error('v1 wrong shape');
    const times = j.times.slice(-this.H1), cut = j.times.length - times.length, e = this.econ;
    for (const [id, goods] of Object.entries(j.series)) {
      const i = e.hIdx.get(id); if (i == null || !goods) continue;
      for (const g of MARKET_GOODS) {
        const k = e.rowMap[i].get(g), arr = goods[g]; if (k == null || !Array.isArray(arr)) continue;
        const a = arr.slice(cut), off = times.length - a.length;
        a.forEach((v, x) => { if (Number.isFinite(v)) this.h1[k * this.H1 + off + x] = histEncode(v, e.baseOfRow(k)); });
      }
    }
    times.forEach((t, x) => { this.t1[x] = t; });
    this.n1 = times.length; this.i1 = times.length % this.H1;
  }
}

/** Express handlers for the split market API (§15): `/api/econ/data`, `/api/market/good/:good`, `/api/market/harbor/:id`,
 *  `/api/market/requests`, `/api/market/movers`. Caches per key (10 s / 30 s); 400 on unknown ids. */
export function econHandlers({ game, payload, now = () => Date.now() }) {
  const cache = new Map();
  const cached = (key, ms, fn) => { const t = now(), c = cache.get(key); if (c && t - c.at < ms) return c.body; const body = fn(); cache.set(key, { at: t, body }); if (cache.size > 800) cache.clear(); return body; };
  const econ = () => game.econ || activeEcon();
  return {
    data: (req, res) => { const p = payload(); if (req.headers?.['if-none-match'] === p.etag) return res.status(304).end(); res.set?.('ETag', p.etag); res.set?.('Cache-Control', 'public, max-age=3600'); res.type?.('application/json'); return res.send(p.text); },
    good: (req, res) => { const g = String(req.params?.good || ''); if (!econ() || !catalogueOf(g)) return res.status(400).json({ error: 'unknown good' }); return res.json(cached(`g:${g}`, 10000, () => econ().goodView(g))); },
    harbor: (req, res) => { const id = String(req.params?.id || ''); if (!econ() || !harborById(id)) return res.status(400).json({ error: 'unknown harbour' }); return res.json(cached(`h:${id}`, 10000, () => econ().harborView(id))); },
    requests: (req, res) => {
      if (!econ()) return res.json({ requests: [] });
      const near = String(one(req.query?.near) || '').split(',').map(Number), good = one(req.query?.good) || null;
      if (good && !catalogueOf(good)) return res.status(400).json({ error: 'unknown good' });
      const lim = Math.max(1, Math.min(100, Math.floor(Number(one(req.query?.limit)) || 100)));
      const nearOk = near.length === 2 && near.every(Number.isFinite) ? near : null;
      return res.json(cached(`r:${req.originalUrl || JSON.stringify(req.query)}`, 30000, () => ({ simTime: Math.round(game.simTime), requests: econ().requests({ near: nearOk, good, limit: lim }) })));
    },
    movers: (req, res) => res.json(cached('movers', 30000, () => ({ movers: econ() ? econ().movers(5) : [] }))),
  };
}
/** GET /api/market/history for the v2 ring: good (any catalogue good) or harbor, days 1..30 (> 7 → 6-hourly). */
export function econHistoryAnswer(history, query = {}) {
  const days = Math.max(1, Math.min(30, Math.floor(Number(one(query.days)) || 7)));
  const good = one(query.good), harbor = one(query.harbor);
  if (good !== undefined) {
    if (typeof good !== 'string' || !catalogueOf(good)) return { status: 400, body: { error: 'unknown good' } };
    if (harbor !== undefined) {
      const k = history.econ.row(String(harbor), good); if (k < 0) return { status: 400, body: { error: 'not listed there' } };
      return { status: 200, body: { good, harbor, sampleS: days > 7 ? 21600 : history.sampleS, times: history.times(days), series: history.series(k, days) } };
    }
    return { status: 200, body: history.forGood(good, days) };
  }
  if (harbor !== undefined) {
    if (typeof harbor !== 'string' || !harborById(harbor)) return { status: 400, body: { error: 'unknown harbour' } };
    return { status: 200, body: history.forHarbor(harbor, days) };
  }
  return { status: 400, body: { error: 'good=<good> or harbor=<id>' } };
}
