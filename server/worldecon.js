// World economy — server simulation (docs/WORLD-ECONOMY-CONTRACT.md §6–§9, §12; Lane B). The Game owns the mutable
// per-harbour state (`st.stock`, `st.target` = normal stock n, `st.market`, `st.req`, `st.ev`); everything derived
// (roles, flows, landed fractions, seasons, chain links) lives here in typed arrays and is never saved (rule E5).
import { GOODS, SHIP_CLASSES } from '../shared/constants.js';
import { haversine } from '../shared/geo.js';
import { canLoad, loadOption, freeUnits, unitsOf, fromTonnes, CARGO } from '../shared/cargo.js';
import { serviceKn } from '../shared/rates.js';
import { isActive, inTerritory, goodsMatch } from '../shared/politics.js';
import {
  ECON2, ECON2X, rolesOf, flowsOf, normalOf, seasonMul, seasonWhy, iceOn, doyOf, stepStock, unitPrice, landFrac, buyable,
  dumpPrice, requestTerms, chainK, chainFill, trendOf, migrateStock, seededRnd, localOf, gcKm, lotOf, catalogueOf, profileOf,
} from '../shared/econ/model.js';
import { SEASON_WORDS, ICE } from '../shared/econ/seasons.js';
import { econDataset } from './econdata.js';
import { HARBORS, harborById } from './harbors.js';
import { setActiveEcon } from './econstate.js';
import { tradeQuote, cargoMass } from './economy.js';
import { affordableQty } from './market.js';

export const ECON_SCHEMA = 2;
const ROLE = ['', 'P', 'L', 'I'], CODE = { P: 1, L: 2, I: 3 };
const F = 8, FN = 0, FP = 1, FC = 2, FB = 3, FLAND = 4, FLOCAL = 5, FKM = 6, FS = 7;   // Float32 fields per listed row
const EV_RMUL = { strike: 0, closed: 0, storm: 0.3, restricted: 0.6 };
const MARKET_CLOSED = new Set(['strike', 'closed']);
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const r3 = (v) => Math.round(v * 1000) / 1000;
const hhmm = (t) => new Date(t * 1000).toISOString().slice(11, 16);
const shortName = (h) => String(h?.name || h?.id || '').split(/\s[(/]/)[0].trim();

export class WorldEcon {
  /** opts: { eds, harbors, rnd, seaKm(aId, bId) → km|null, log } */
  constructor(game, opts = {}) {
    this.game = game;
    this.eds = opts.eds || econDataset();
    this.harbors = opts.harbors || HARBORS;
    this._rnd = opts.rnd || null;               // else the game's current rnd (tests pin g.rnd after construction)
    this.log = opts.log || game?.log || (() => {});
    this.seaKmFn = opts.seaKm || null;
    this.hIdx = new Map(this.harbors.map((h, i) => [h.id, i]));
    this.stOf = new WeakMap();                 // harbour state object → harbour index
    this.dumpUse = new Map();                  // `${hId}:${good}` → { day, t } (shared by everyone, §6.9)
    this.inlandUse = new Map();                // `${pid}:${mhId}` → { day, t } (§9.6)
    this.lapses = new Map();                   // pid → [times] (X5)
    this.reqSeq = 1;
    this.history = null;                       // set by server.js (server/market.js EconHistory)
    this.build();
    setActiveEcon(this);
  }

  rnd() { return (this._rnd || this.game?.rnd || Math.random)(); }

  // ------------------------------------------------------------------------------------------ derived data
  build() {
    const eds = this.eds, H = this.harbors.length;
    this.gIdx = new Map(eds.goods.map((g, i) => [g, i]));
    this.off = new Int32Array(H + 1);
    const lists = this.harbors.map((h) => [...rolesOf(eds, h).keys()]);
    let K = 0; for (let i = 0; i < H; i++) { this.off[i] = K; K += lists[i].length; } this.off[H] = K;
    this.K = K;
    this.good = new Uint8Array(K); this.role = new Uint8Array(K); this.hub = new Uint8Array(K); this.sanc = new Uint8Array(K);
    this.maker = new Int16Array(K).fill(-1);
    this.D = new Float32Array(K * F); this.base = new Float32Array(K);
    this.raw = new Float32Array(K); this.ceil = new Float32Array(K).fill(Infinity);   // formula price and landed ceiling (§10)
    this.sellK = new Int32Array(K * ECON2X.CEIL_N).fill(-1); this.sellKm = new Uint16Array(K * ECON2X.CEIL_N);
    this.fP = new Float32Array(K).fill(1); this.fC = new Float32Array(K).fill(1); this.kMul = new Float32Array(K).fill(1);
    this.rowMap = this.harbors.map(() => new Map());
    this.sites = this.harbors.map(() => []);
    for (let i = 0; i < H; i++) {
      const h = this.harbors[i], roles = rolesOf(eds, h);
      lists[i].forEach((g, j) => {
        const k = this.off[i] + j, r = roles.get(g), f = flowsOf(eds, h, g), row = eds.byGood.get(g);
        this.good[k] = this.gIdx.get(g); this.role[k] = CODE[r.role]; this.hub[k] = r.hub ? 1 : 0; this.base[k] = row.base;
        const d = k * F;
        this.D[d + FN] = f.n; this.D[d + FP] = f.P; this.D[d + FC] = f.C; this.D[d + FB] = f.b;
        this.D[d + FLOCAL] = localOf(h.id, g); this.D[d + FS] = row.S; this.D[d + FLAND] = r.role === 'P' ? -ECON2.EXPORT_DISC : 0;
        this.rowMap[i].set(g, k);
      });
      for (const s of eds.siteByHarbor.get(h.id) || []) {
        const c = eds.chains[s.chain]; if (!c) continue;
        const outs = [c.main, ...Object.keys(c.co || {})].map((g) => this.rowMap[i].get(g)).filter((k) => k != null);
        const ins = Object.entries(c.inputs).map(([g, ratio]) => ({ k: this.rowMap[i].get(g), ratio })).filter((x) => x.k != null);
        this.sites[i].push({ id: s.id, chain: s.chain, name: c.name, main: this.rowMap[i].get(c.main), outs, ins });
      }
    }
    this.makers = eds.goods.map(() => []);
    for (let k = 0; k < K; k++) if (this.role[k] === 1) this.makers[this.good[k]].push(this.hOfRow(k));
    this.seasonDay = -1; this.iceNow = new Uint8Array(H);
    this.refreshSeasons(this.game?.simTime ?? Date.now() / 1000);
    this.computeLanded();
    this.memBytes = this.good.byteLength * 4 + this.maker.byteLength + this.D.byteLength + this.base.byteLength + this.fP.byteLength * 3 + this.raw.byteLength * 2 + this.sellK.byteLength + this.sellKm.byteLength;
  }
  hOfRow(k) { let lo = 0, hi = this.harbors.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.off[m] <= k) lo = m; else hi = m - 1; } return lo; }
  /** Row index of (harbour id, good) or -1 when not listed. */
  row(hId, g) { const i = this.hIdx.get(hId); if (i == null) return -1; const k = this.rowMap[i].get(g); return k == null ? -1 : k; }
  roleAt(hId, g) { const k = this.row(hId, g); return k < 0 ? null : ROLE[this.role[k]]; }
  n(k) { return this.D[k * F + FN]; }
  gOf(k) { return this.eds.goods[this.good[k]]; }
  seaKm(a, b) {
    if (this.seaKmFn) { try { const km = this.seaKmFn(a.id, b.id); if (Number.isFinite(km) && km > 0) return km; } catch { /* fall through */ } }
    return gcKm(a, b) * ECON2X.DETOUR;
  }
  /** Is maker country `o` banned for `g` by a territorial import ban in the importer's territory (§9.3)? */
  banned(g, o, cc) {
    const ms = this.banMeasures(); if (!ms.length) return false;
    const pds = this.game.politics.ds;
    for (const m of ms) if (m.origin.includes(o) && goodsMatch(m, g) && inTerritory(pds, m.authority, cc)) return true;
    return false;
  }
  /** Active territorial import bans (§9.3), re-read once per sim hour. */
  banMeasures() {
    const pds = this.game?.politics?.ds; if (!pds || !Array.isArray(pds.measures)) return [];
    const hr = Math.floor((this.game.simTime || 0) / 3600);
    if (this._banHr !== hr || !this._bans) { this._banHr = hr; this._bans = pds.measures.filter((m) => m.kind === 'import_ban' && m.scope?.includes('territorial') && Array.isArray(m.origin) && isActive(m, this.game.simTime)); }
    return this._bans;
  }
  dutyRate(cc, g) {
    const tr = this.game?.politics?.ds?.tariffs; if (!tr) return 0;
    const row = tr[cc]?.[g] ?? tr[cc]?.[catalogueOf(g)?.polGroup];
    return Number.isFinite(row?.rate) ? row.rate : 0;
  }
  /** Landed fractions from the nearest allowed maker (§6.6, §9.3); sanction flags (rMul × 0.5); the CEIL_N nearest
   *  allowed sellers (P or L) of every row for the landed ceiling. */
  computeLanded() {
    const N = ECON2X.CEIL_N, sellers = this.eds.goods.map(() => []);
    for (let k = 0; k < this.K; k++) if (this.role[k] === 1 || this.role[k] === 2) sellers[this.good[k]].push(k);
    for (let k = 0; k < this.K; k++) {
      const i = this.hOfRow(k), h = this.harbors[i], g = this.eds.goods[this.good[k]], cand = [];
      for (const j of sellers[this.good[k]]) {
        const hj = this.hOfRow(j); if (hj === i) continue;
        const m = this.harbors[hj];
        if (m.country !== h.country && this.banned(g, m.country, h.country)) continue;
        cand.push([j, this.seaKm(h, m)]);
      }
      cand.sort((a, b) => a[1] - b[1]);
      for (let x = 0; x < N; x++) { this.sellK[k * N + x] = x < cand.length ? cand[x][0] : -1; this.sellKm[k * N + x] = x < cand.length ? Math.min(65535, Math.round(cand[x][1])) : 0; }
    }
    for (let k = 0; k < this.K; k++) {
      if (this.role[k] !== 3) continue;
      const i = this.hOfRow(k), h = this.harbors[i], gi = this.good[k], g = this.eds.goods[gi], cat = this.eds.byGood.get(g);
      let best = Infinity, bestJ = -1, bestAny = Infinity, anyBanned = false;
      for (const j of this.makers[gi]) {
        const m = this.harbors[j]; if (j === i) continue;
        const km = this.seaKm(h, m);
        if (km < bestAny) bestAny = km;
        if (m.country !== h.country && this.banned(g, m.country, h.country)) { anyBanned = true; continue; }
        if (km < best) { best = km; bestJ = j; }
      }
      const d = k * F;
      this.D[d + FKM] = Number.isFinite(best) ? best : -1;
      this.maker[k] = bestJ;
      this.sanc[k] = anyBanned && !(best <= 5000) ? 1 : 0;
      this.D[d + FLAND] = landFrac({ role: 'I', base: cat.base, fmul: cat.fmul, seaKm: Number.isFinite(best) ? best : 1e7, dutyRate: this.dutyRate(h.country, g), landMax: cat.landMax ?? ECON2.LAND_MAX });
    }
  }
  /** Season multipliers per row, recomputed once a day. */
  refreshSeasons(now) {
    const day = doyOf(now);
    if (day === this.seasonDay) return;
    this.seasonDay = day;
    this.iceNow = this.harbors.map((h) => (this.eds.ice.has(h.id) && iceOn(this.eds, h, now) ? 1 : 0));
    for (let i = 0; i < this.harbors.length; i++) {
      const h = this.harbors[i];
      for (let k = this.off[i]; k < this.off[i + 1]; k++) { const g = this.gOf(k); this.fP[k] = seasonMul(this.eds, h, g, 'P', now); this.fC[k] = seasonMul(this.eds, h, g, 'C', now); }
    }
  }

  // ------------------------------------------------------------------------------------------ price
  /** price(h, g) at stock s (normal n defaults to the dataset's); unlisted → the general traders' price. */
  priceFor(h, g, s, n) {
    const k = this.row(h.id, g), cat = this.eds.byGood.get(g);
    if (!cat) return Math.max(1, Math.round(GOODS[g]?.base || 1));
    if (k < 0) return dumpPrice(cat.base);
    const d = k * F;
    const p = unitPrice({ base: cat.base, local: this.D[d + FLOCAL], role: ROLE[this.role[k]], S: this.D[d + FS], land: this.D[d + FLAND], n: n ?? this.D[d + FN], s });
    return this.ceil[k] < p ? Math.max(1, Math.round(this.ceil[k])) : p;
  }
  /** Landed ceilings (§10) from every seller's formula price: run after the stocks moved (step, load, a trade). */
  computeCeilings() {
    const N = ECON2X.CEIL_N, hs = this.game?.harbors || {}, goods = this.eds.goods, D = this.D, LO = ECON2.SIG_LO, HI = ECON2.SIG_HI;
    this.ceilAt = this.game?.simTime ?? 0;
    for (let i = 0; i < this.harbors.length; i++) {
      const stock = hs[this.harbors[i].id]?.stock;
      for (let k = this.off[i]; k < this.off[i + 1]; k++) {   // unitPrice (§6.6), inlined
        const d = k * F, s = stock ? Number(stock[goods[this.good[k]]]) : NaN, n = D[d + FN];
        if (!Number.isFinite(s)) { this.raw[k] = NaN; continue; }
        let x = Math.log((n > 1 ? n : 1) / (s > 1 ? s : 1)); x = x < LO ? LO : x > HI ? HI : x;
        const v = Math.round(this.base[k] * D[d + FLOCAL] * (1 + (this.role[k] === 2 ? 0 : D[d + FLAND]) + D[d + FS] * x));
        this.raw[k] = v > 1 ? v : 1;
      }
    }
    // relaxation: a seller's effective price is min(formula, its own ceiling), so chains of neighbours stay consistent
    this.ceil.fill(Infinity);
    for (let pass = 0; pass < ECON2X.CEIL_PASSES; pass++) {
      let changed = 0;
      for (let k = 0; k < this.K; k++) {
        const fm = this.eds.byGood.get(goods[this.good[k]]).fmul;
        let c = this.ceil[k];
        for (let x = 0; x < N; x++) {
          const j = this.sellK[k * N + x]; if (j < 0) break;
          const p = this.raw[j] < this.ceil[j] ? this.raw[j] : this.ceil[j]; if (!(p > 0)) continue;
          const v = p + ECON2X.CEIL_TKM * fm * this.sellKm[k * N + x]; if (v < c) { c = v; changed++; }
        }
        this.ceil[k] = c;
      }
      if (!changed) break;
    }
  }
  /** Ceilings, then every market price (after load / init). */
  settle() {
    this.computeCeilings();
    for (const h of this.harbors) { const st = this.game?.harbors?.[h.id]; if (st && st.stock) this.refresh(h, st); }
  }
  /** Equilibrium stock of a row under today's multipliers. */
  sEqOf(k, st) {
    const i = this.hOfRow(k), d = k * F, rMul = this.rMulOf(i, k, st);
    const Rp = ECON2.R * rMul, net = this.D[d + FP] * this.fP[k] * this.evP(st, k) * this.kOut(k) - this.D[d + FC] * this.fC[k] * this.kIn(k);
    return Rp > 0 ? Math.max(0, this.D[d + FN] + net / Rp) : null;
  }
  kOut(k) { return this.role[k] === 1 ? this.kMul[k] : 1; }
  kIn(k) { return this.role[k] === 3 ? this.kMul[k] : 1; }
  evP(st, k) { const ev = st?.ev; if (!ev || (ev.kind !== 'boom' && ev.kind !== 'bust') || ev.good !== this.gOf(k)) return 1; return ev.kind === 'boom' ? 1.5 : 0.4; }
  rMulOf(i, k, st) {
    const ev = st?.ev; let r = ev ? EV_RMUL[ev.kind] ?? 1 : 1;
    if (this.iceNow?.[i]) r *= ICE.rMul;
    if (this.sanc[k]) r *= 0.5;
    return r;
  }

  // ------------------------------------------------------------------------------------------ state
  /** Fresh stock/target for a harbour at its equilibrium × (0.85 … 1.15), seeded per harbour (§12). */
  initStock(h) {
    const i = this.hIdx.get(h.id), stock = {}, target = {};
    if (i == null) return { stock, target };
    const rnd = seededRnd(`${h.id}:econ-init`);
    for (let k = this.off[i]; k < this.off[i + 1]; k++) {
      const g = this.gOf(k), n = this.n(k), d = k * F;
      const sEq = Math.max(0, n + (this.D[d + FP] - this.D[d + FC]) / ECON2.R);
      stock[g] = Math.round(sEq * (0.85 + 0.3 * rnd())); target[g] = Math.round(n);
    }
    return { stock, target };
  }
  /** Listed goods present, unlisted dropped, prices recomputed (st.market[g] = price). */
  refresh(h, st) {
    const i = this.hIdx.get(h.id); if (i == null) return st.market || {};
    this.stOf.set(st, i);
    if (!st.stock || typeof st.stock !== 'object') st.stock = {};
    if (!st.target || typeof st.target !== 'object') st.target = {};
    const m = st.market && typeof st.market === 'object' ? st.market : (st.market = {});
    let init = null;
    const listed = this.rowMap[i];
    for (const o of [st.stock, st.target, m]) for (const g of Object.keys(o)) if (!listed.has(g)) delete o[g];
    for (const [g, k] of listed) {
      st.target[g] = Math.round(this.n(k));
      if (!(st.stock[g] >= 0)) { init = init || this.initStock(h); st.stock[g] = init.stock[g]; }
      m[g] = this.priceFor(h, g, st.stock[g], st.target[g]);
    }
    if (!Array.isArray(st.req)) st.req = [];
    if (st.ev === undefined) st.ev = null;
    return m;
  }
  /** Price direction per listed good (trend arrow, §6.10). */
  trendFor(st) {
    const i = this.stOf.get(st), out = {};
    if (i == null || !st.stock) return out;
    for (const [g, k] of this.rowMap[i]) out[g] = trendOf(st.stock[g] ?? 0, this.sEqOf(k, st) ?? this.n(k));
    return out;
  }

  // ------------------------------------------------------------------------------------------ stepping (§6.4)
  /** Every listed good of every harbour advances `hours`; events, requests and prices follow. */
  step(hours, now = this.game?.simTime ?? Date.now() / 1000) {
    const hrs = Math.max(0, Math.min(48, Number(hours) || 0));
    if (!(hrs > 0)) return;
    this.refreshSeasons(now);
    try { this.updateEvents(hrs, now); } catch (e) { this.log(`[econ] events failed: ${e.message}`); }   // never stops the markets
    const hs = this.game?.harbors || {};
    for (let i = 0; i < this.harbors.length; i++) {
      const st = hs[this.harbors[i].id];
      if (st && st.stock) this.stepHarbor(i, st, hrs, now);
    }
    const fresh = hrs >= 0.25 || !(Math.abs(now - (this.ceilAt ?? -Infinity)) < 900);   // ceilings move slowly: every 15 sim-minutes
    if (fresh) this.computeCeilings();
    for (let i = 0; i < this.harbors.length; i++) {     // market = min(formula, landed ceiling) — exactly priceFor; requests price off it
      const st = hs[this.harbors[i].id]; if (!st || !st.market) continue;
      if (fresh) for (let k = this.off[i]; k < this.off[i + 1]; k++) { const r = this.raw[k]; if (r > 0) st.market[this.gOf(k)] = this.ceil[k] < r ? Math.max(1, Math.round(this.ceil[k])) : r; }
      this.postRequests(i, st, now);
    }
  }
  stepHarbor(i, st, hrs, now) {
    const h = this.harbors[i], goods = this.eds.goods, D = this.D, noise = ECON2X.NOISE * Math.min(24, hrs);
    if (this.stOf.get(st) !== i || !st.market || !st.target) this.refresh(h, st);
    this.chainStep(i, st);
    const ev = st.ev, evR = ev ? EV_RMUL[ev.kind] ?? 1 : 1, rH = evR * (this.iceNow[i] ? ICE.rMul : 1);
    const evGood = ev && (ev.kind === 'boom' || ev.kind === 'bust') ? ev.good : null, evMul = ev?.kind === 'boom' ? 1.5 : 0.4;
    const stock = st.stock, market = st.market, R0 = ECON2.R, SIG_LO = ECON2.SIG_LO, SIG_HI = ECON2.SIG_HI, dec0 = Math.pow(1 - R0, hrs);
    for (let k = this.off[i], end = this.off[i + 1]; k < end; k++) {
      const g = goods[this.good[k]], d = k * F, n = D[d + FN], role = this.role[k];
      const P = D[d + FP] * this.fP[k] * (g === evGood ? evMul : 1) * (role === 1 ? this.kMul[k] : 1), C = D[d + FC] * this.fC[k] * (role === 3 ? this.kMul[k] : 1);
      let s = Number(stock[g]); if (!Number.isFinite(s)) s = n;
      // stepStock (§6.4 closed form) and unitPrice (§6.6), inlined: this loop runs over ~7,700 rows every minute
      const Rp = R0 * (this.sanc[k] ? rH * 0.5 : rH), net = P - C;
      if (Rp > 0) { const sEq = n + net / Rp; s = sEq + (s - sEq) * (Rp === R0 ? dec0 : Math.pow(1 - Rp, hrs)); } else s += hrs * net;
      s = Math.max(0, Math.round((s + noise * n * (this.rnd() - 0.5)) * 1000) / 1000);
      stock[g] = s;
      let x = Math.log((n > 1 ? n : 1) / (s > 1 ? s : 1)); x = x < SIG_LO ? SIG_LO : x > SIG_HI ? SIG_HI : x;
      const v = Math.round(this.base[k] * D[d + FLOCAL] * (1 + (role === 2 ? 0 : D[d + FLAND]) + D[d + FS] * x));
      market[g] = Math.min(v > 1 ? v : 1, this.ceil[k] < Infinity ? Math.max(1, Math.round(this.ceil[k])) : Infinity);
    }
    this.maintainRequests(i, st, now, hrs);
  }
  /** One harbour's state object (economy.driftEconomy compatibility). */
  stepState(st, hours, now = this.game?.simTime ?? Date.now() / 1000) {
    const i = this.stOf.get(st), hrs = Math.max(0, Math.min(48, Number(hours) || 0));
    if (i == null || !(hrs > 0)) return;
    this.refreshSeasons(now);
    this.stepHarbor(i, st, hrs, now);
    this.postRequests(i, st, now);
  }
  /** Chain run rate k per site (§8.3): outputs scale by k, inputs are consumed at ratio × output. */
  chainStep(i, st) {
    for (const s of this.sites[i]) {
      const fills = s.ins.map(({ k }) => chainFill(Number(st.stock[this.gOf(k)]) || 0, this.n(k)));
      s.k = chainK(fills);
    }
    for (const s of this.sites[i]) {
      for (const k of s.outs) this.kMul[k] = 1;
      for (const { k } of s.ins) if (this.role[k] === 3) this.kMul[k] = 1;
    }
    for (const s of this.sites[i]) {
      for (const k of s.outs) this.kMul[k] = Math.min(this.kMul[k], s.k);
      for (const { k } of s.ins) if (this.role[k] === 3) this.kMul[k] = Math.min(this.kMul[k], s.k * (s.main != null ? this.fP[s.main] : 1));
    }
  }
  /** Expected stock after `hours` (closed form at today's multipliers; the trade finder's arrival estimate). */
  expectedStock(hId, g, hours, st = this.game?.harbors?.[hId]) {
    const k = this.row(hId, g); if (k < 0 || !st) return 0;
    const i = this.hIdx.get(hId), d = k * F, n = this.D[d + FN];
    const P = this.D[d + FP] * this.fP[k] * this.evP(st, k) * this.kOut(k), C = this.D[d + FC] * this.fC[k] * this.kIn(k);
    return stepStock(Number(st.stock?.[g]) || 0, { n, P, C }, { rMul: this.rMulOf(i, k, st) }, Math.max(0, hours || 0));
  }
  nearestMakerKm(hId, g) { const k = this.row(hId, g); if (k >= 0 && this.role[k] === 3) { const km = this.D[k * F + FKM]; return km > 0 ? km : null; } return this.nearestMaker(hId, g)?.km ?? null; }
  /** Nearest allowed maker { id, name, km } of `g` seen from harbour `hId`. */
  nearestMaker(hId, g) {
    const k = this.row(hId, g), h = harborById(hId);
    if (k >= 0 && this.maker[k] >= 0) { const m = this.harbors[this.maker[k]]; return { id: m.id, name: shortName(m), km: Math.round(this.D[k * F + FKM]) }; }
    const gi = this.gIdx.get(g); if (gi == null || !h) return null;
    let best = null;
    for (const j of this.makers[gi]) { const m = this.harbors[j]; if (m.id === hId) continue; const km = this.seaKm(h, m); if (!best || km < best.km) best = { id: m.id, name: shortName(m), km: Math.round(km) }; }
    return best;
  }
  makersOf(g) { const gi = this.gIdx.get(g); return gi == null ? [] : this.makers[gi].map((j) => this.harbors[j]); }

  // ------------------------------------------------------------------------------------------ events (§6.7)
  updateEvents(hrs, now) {
    const hs = this.game?.harbors || {}, pds = this.game?.politics?.ds;
    let real = [];
    try { const rs = this.game?.realStorms; real = rs ? (typeof rs.cells === 'function' ? rs.cells() : Array.isArray(rs.list) ? rs.list : []) || [] : []; } catch { real = []; }
    const storms = (this.game?.storms || []).concat(real);
    for (const h of this.harbors) {
      const st = hs[h.id]; if (!st) continue;
      let ev = st.ev && typeof st.ev === 'object' ? st.ev : null;
      if (ev && ev.until != null && ev.until <= now) ev = null;
      const ps = pds?.ports?.[h.id]?.status?.value;
      if (ps === 'closed' || ps === 'restricted') {
        if (!ev || ev.kind !== ps) ev = { kind: ps, from: now, until: null, text: ps === 'closed' ? `Port closed — ${(pds.ports[h.id].status.reasons || []).join(', ') || 'politics'}` : 'Port restricted — fewer ships calling' };
      } else if (ev && (ev.kind === 'closed' || ev.kind === 'restricted')) ev = null;
      if (!ev) {
        const s = storms.find((x) => x && Number.isFinite(x.lat) && x.radiusKm > 0 && haversine(x.lat, x.lon, h.lat, h.lon) / 1000 <= x.radiusKm && !(x.dies <= now));
        if (s) ev = { kind: 'storm', from: now, until: Number.isFinite(s.dies) ? s.dies : now + 6 * 3600, text: `Storm${s.name ? ` ${s.name}` : ''} — few ships arriving` };
      }
      if (!ev) {
        const p = (ECON2.STRIKE_P[h.size] || 0) * hrs / 24;
        if (p > 0 && this.rnd() < p) { const until = now + (24 + this.rnd() * 48) * 3600; ev = { kind: 'strike', from: now, until, text: `Dock strike — market closed until ${hhmm(until)}` }; }
      }
      st.ev = ev;
    }
    // booms and busts per country (p 0.05 each per 30 days, 7 days, one random `make` good)
    const pc = 0.05 * hrs / 720;
    for (const cc of this.countries()) {
      for (const kind of ['boom', 'bust']) {
        if (!(this.rnd() < pc)) continue;
        const make = Object.keys(profileOf(this.eds, cc).make).filter((g) => this.eds.byGood.has(g));
        if (!make.length) continue;
        const good = make[Math.floor(this.rnd() * make.length)], until = now + 7 * 86400, name = this.eds.countries[cc]?.name || cc;
        const text = kind === 'boom' ? `Bumper ${catalogueOf(good).name.toLowerCase()} output in ${name}` : `${catalogueOf(good).name} output down in ${name}`;
        for (const h of this.harbors) if (h.country === cc && hs[h.id] && !hs[h.id].ev) hs[h.id].ev = { kind, good, from: now, until, text };
      }
    }
  }
  countries() { return this._cc || (this._cc = [...new Set(this.harbors.map((h) => h.country))]); }
  /** Force an event (debug and tests): kind strike|storm|closed|restricted|boom|bust. */
  forceEvent(hId, kind, hours = 48, good = null) {
    const st = this.game?.harbors?.[hId]; if (!st) return null;
    const now = this.game.simTime, until = now + hours * 3600;
    st.ev = { kind, from: now, until, ...(good ? { good } : {}), text: kind === 'strike' ? `Dock strike — market closed until ${hhmm(until)}` : kind === 'storm' ? 'Storm — few ships arriving' : kind };
    return st.ev;
  }
  onStorm(hIds, until) { for (const id of hIds) { const st = this.game?.harbors?.[id]; if (st && !st.ev) st.ev = { kind: 'storm', from: this.game.simTime, until, text: 'Storm — few ships arriving' }; } }
  /** Politics dataset changed: closures follow at the next step, landed prices now. */
  onPolitics() { this._bans = null; this.computeLanded(); }
  marketClosed(st) { return !!(st?.ev && MARKET_CLOSED.has(st.ev.kind)); }

  // ------------------------------------------------------------------------------------------ requests (§7)
  openReq(st) { return (st.req || []).filter((q) => !q.closed); }
  pledgedBy(q, now, exceptPid = null) { return (q.pledges || []).filter((x) => x.until > now && x.pid !== exceptPid).reduce((s, x) => s + x.qty, 0); }
  postRequests(i, st, now) {
    if (this.marketClosed(st)) return;
    const h = this.harbors[i], max = ECON2X.REQ_MAX[h.size] ?? 1;
    const open = this.openReq(st);
    if (open.length >= max) return;
    const have = new Set(open.map((q) => q.good)), cands = [];
    for (let k = this.off[i]; k < this.off[i + 1]; k++) {
      if (this.role[k] !== 3) continue;
      const g = this.gOf(k), n = this.n(k), s = Number(st.stock[g]) || 0, r = s / Math.max(1, n);
      if (r < ECON2.REQ_R && !have.has(g)) cands.push({ k, g, r, base: this.eds.byGood.get(g).base });
    }
    cands.sort((a, b) => (a.r - b.r) || (b.base - a.base));
    for (const c of cands) {
      if (open.length >= max) break;
      const n = this.n(c.k), s = Number(st.stock[c.g]) || 0, km = this.D[c.k * F + FKM];
      const t = requestTerms({ r: c.r, price: st.market[c.g], seaKm: km > 0 ? km : 0, size: h.size, n, s, good: c.g });
      if (!t) continue;
      const q = { id: `q${(this.reqSeq++).toString(36)}${Math.floor(this.rnd() * 1296).toString(36)}`, good: c.g, qty: t.qty, done: 0, unit: t.unit, premium: t.premium, postedAt: Math.round(now), dueAt: Math.round(now + t.deadlineH * 3600), r0: Math.round(c.r * 1000) / 1000, pledges: [], by: {} };
      st.req.push(q); open.push(q);
    }
  }
  maintainRequests(i, st, now, hrs) {
    if (!Array.isArray(st.req)) { st.req = []; return; }
    const frozen = st.ev?.kind === 'closed';
    for (const q of st.req) {
      if (frozen) { q.dueAt += hrs * 3600; for (const x of q.pledges || []) x.until += hrs * 3600; }
      const live = [];
      for (const x of q.pledges || []) { if (x.until > now) live.push(x); else this.noteLapse(x.pid, now); }
      q.pledges = live;
      const k = this.rowMap[i].get(q.good);
      if (k == null) { q.closed = 'unlisted'; continue; }
      const r = (Number(st.stock[q.good]) || 0) / Math.max(1, this.n(k));
      if (q.done >= q.qty - 1e-9) q.closed = 'done';
      else if (now >= q.dueAt) q.closed = 'expired';
      else if (r > ECON2X.REQ_CLOSE_R && !live.length) q.closed = 'recovered';
    }
    st.req = st.req.filter((q) => !q.closed);
  }
  noteLapse(pid, now) { const a = (this.lapses.get(pid) || []).filter((t) => now - t < 7 * 86400); a.push(now); this.lapses.set(pid, a); }
  pledgeBlockedUntil(pid, now) { const a = (this.lapses.get(pid) || []).filter((t) => now - t < 7 * 86400); return a.length >= 3 ? a[a.length - 1] + 86400 : 0; }
  findReq(reqId) {
    for (const h of this.harbors) { const st = this.game?.harbors?.[h.id]; const q = st?.req?.find((x) => x.id === reqId && !x.closed); if (q) return { h, st, q }; }
    return null;
  }
  /** Can this stack fill a request (§7.3)? */
  stackSrcOk(stack) { return !!stack && !stack.jobId && (stack.caught === true || stack.srcRole === 'P' || stack.srcRole === 'L'); }
  /** Requests open (filter: { near: [lat, lon], good, harbor, limit }), nearest first. */
  requests(filter = {}, viewer = null) {
    const now = this.game?.simTime ?? Date.now() / 1000, out = [];
    for (const h of this.harbors) {
      if (filter.harbor && h.id !== filter.harbor) continue;
      const st = this.game?.harbors?.[h.id]; if (!st?.req?.length) continue;
      for (const q of st.req) if (!q.closed && (!filter.good || q.good === filter.good)) out.push(this.publicReq(h, q, now, viewer, filter.near));
    }
    if (filter.near) out.sort((a, b) => a.distKm - b.distKm); else out.sort((a, b) => b.premium - a.premium);
    return out.slice(0, Math.min(100, filter.limit || 100));
  }
  publicReq(h, q, now = this.game.simTime, viewer = null, near = null) {
    const pledged = this.pledgedBy(q, now), mine = viewer ? (q.pledges || []).find((x) => x.pid === viewer.id && x.until > now) : null;
    const mk = this.nearestMaker(h.id, q.good);
    return {
      id: q.id, harbor: h.id, harborName: shortName(h), country: h.country, good: q.good, qty: q.qty, done: Math.round(q.done * 1000) / 1000, pledged: Math.round(pledged * 1000) / 1000,
      open: Math.max(0, Math.round((q.qty - q.done - pledged) * 1000) / 1000), unit: q.unit, premium: q.premium, postedAt: q.postedAt, dueAt: q.dueAt, leftH: Math.max(0, Math.round((q.dueAt - now) / 36) / 100),
      maker: mk, mine: mine ? { qty: mine.qty, until: mine.until } : null, byMe: viewer ? Math.round((q.by?.[viewer.id] || 0) * 1000) / 1000 : 0,
      lat: h.lat, lon: h.lon, ...(near ? { distKm: Math.round(haversine(near[0], near[1], h.lat, h.lon) / 1000) } : {}),
    };
  }
  /** Reserve part of a request until the ship can reach it (§7.3, X5). → { ok, text } */
  pledge(actor, reqId, qty) {
    const now = this.game.simTime, f = this.findReq(String(reqId || ''));
    if (!f) return { ok: false, text: 'That request is no longer open.' };
    const { h, q } = f, name = GOODS[q.good]?.name || catalogueOf(q.good).name;
    const blocked = this.pledgeBlockedUntil(actor.id, now);
    if (blocked > now) return { ok: false, text: `Three pledges lapsed this week — no new pledges until ${hhmm(blocked)}.` };
    const left = q.qty - q.done - this.pledgedBy(q, now, actor.id);
    const want = Math.min(Math.max(0, Number(qty) || 0), left);
    if (!(want >= Math.min(lotOf(q.good), left)) || !(want > 0)) return { ok: false, text: `Nothing left to pledge on this request (${fmt(Math.max(0, left))} t open).` };
    const s = actor.ship, kn = serviceKn(s?.cls || 'coaster', 0.5) || 10;
    const passageH = s ? haversine(s.lat, s.lon, h.lat, h.lon) / 1000 * ECON2X.DETOUR / (kn * 1.852) : 0;
    const until = Math.round(now + Math.min(q.dueAt - now, (passageH * 1.5 + 12) * 3600));
    q.pledges = (q.pledges || []).filter((x) => x.pid !== actor.id);
    q.pledges.push({ pid: actor.id, qty: Math.round(want * 1000) / 1000, until });
    return { ok: true, text: `Pledged ${fmt(want)} t of ${name} to ${shortName(h)} — held for you until ${hhmm(until)}.`, until };
  }
  unpledge(actor, reqId) {
    const f = this.findReq(String(reqId || '')); if (!f) return { ok: false, text: 'That request is no longer open.' };
    const before = (f.q.pledges || []).length; f.q.pledges = (f.q.pledges || []).filter((x) => x.pid !== actor.id);
    return before !== f.q.pledges.length ? { ok: true, text: 'Pledge released.' } : { ok: false, text: 'You had no pledge on that request.' };
  }
  /** Deliver eligible cargo into a request at the docked harbour (§7.3). → { ok, text, paid?, t? } */
  deliver(actor, reqId, qty) {
    const g0 = this.game, now = g0.simTime, f = this.findReq(String(reqId || ''));
    if (!f) return { ok: false, text: 'That request is no longer open.' };
    const { h, st, q } = f, name = GOODS[q.good]?.name || catalogueOf(q.good).name;
    if (actor.docked !== h.id) return { ok: false, text: `Dock at ${shortName(h)} to deliver.` };
    if (this.marketClosed(st)) return { ok: false, text: st.ev.text };
    const mine = (q.pledges || []).find((x) => x.pid === actor.id && x.until > now);
    const room = q.qty - q.done - this.pledgedBy(q, now, actor.id);
    const stacks = (actor.cargo || []).filter((c) => c.good === q.good);
    const ok = stacks.filter((c) => this.stackSrcOk(c));
    if (!ok.length) {
      const c = stacks.find((x) => !x.jobId) || stacks[0];
      if (!c) return { ok: false, text: `You carry no ${name.toLowerCase()}.` };
      if (c.jobId) return { ok: false, text: 'Contract cargo cannot fill a request.' };
      const src = harborById(c.src);
      return { ok: false, text: src ? `This ${name.toLowerCase()} was bought at ${shortName(src)}, which imports it — only goods bought where they are made or traded (or your own catch) can fill a request.` : `This ${name.toLowerCase()} has no known source — only goods bought where they are made or traded (or your own catch) can fill a request.` };
    }
    let want = Math.min(Math.max(0, Number(qty) || Infinity), room, ok.reduce((s, c) => s + c.qty, 0));
    if (!(want > 0)) return { ok: false, text: `Nothing left to deliver on this request — ${fmt(q.qty - q.done)} t remain, pledged by other skippers.` };
    want = Math.floor(want * 1000) / 1000;
    let left = want, duty = 0, fees = 0;
    const take = [];
    for (const c of ok) {
      const k = Math.min(c.qty, left); if (k <= 0) break;
      if (g0.politics) {
        const r = g0.politics.onTrade(actor, h, q.good, 'sell', { origin: c.origin ?? null, value: Math.round(q.unit * k) });
        if (r.block) return { ok: false, text: r.text || 'Blocked by sanctions.' };
        if (r.duty) { duty += r.duty.duty || 0; fees += r.duty.fee || 0; }
      }
      take.push([c, k]); left -= k;
    }
    for (const [c, k] of take) { c.qty = r3(c.qty - k); syncUnits(c); }
    actor.cargo = actor.cargo.filter((c) => c.qty > 1e-6);
    const gross = Math.round(q.unit * want), net = gross - duty - fees;
    actor.money += net; if (actor.stats) actor.stats.earned += net;
    q.done = r3(q.done + want); q.by = q.by || {}; q.by[actor.id] = r3((q.by[actor.id] || 0) + want);
    if (mine) { mine.qty = r3(Math.max(0, mine.qty - want)); if (!(mine.qty > 0)) q.pledges = q.pledges.filter((x) => x !== mine); }
    st.stock[q.good] = r3((Number(st.stock[q.good]) || 0) + want);
    this.refresh(h, st);
    if (want >= lotOf(q.good) && g0.politics?.bumpRep) { try { g0.politics.bumpRep(actor, h.country, 1, 'request delivered'); } catch { /* reputation is optional */ } }
    let text = `Delivered ${fmt(want)} t of ${name} to ${shortName(h)}'s request at ${fmt(q.unit)} cr/t — +${fmt(net)} cr${duty + fees ? ` (duty ${fmt(duty)} cr, fee ${fmt(fees)} cr)` : ''}.`;
    if (q.done >= q.qty - 1e-9) {
      q.closed = 'done';
      if (now <= q.dueAt) {
        const bonus = ECON2.REQ_BONUS * q.qty * q.unit;
        for (const [pid, t] of Object.entries(q.by)) {
          const amt = Math.round(bonus * t / q.qty), who = pid === actor.id ? actor : (g0.byId?.get(pid) || g0.fleet?.actorById?.(pid));
          if (!who || !(amt > 0)) continue;
          who.money += amt; if (who.stats) who.stats.earned += amt;
          if (who !== actor) g0.event?.(who, 'info', `${shortName(h)}'s ${name.toLowerCase()} request is complete — your share of the bonus: +${fmt(amt)} cr.`);
          else text += ` Request complete — bonus +${fmt(amt)} cr.`;
        }
      }
      st.req = st.req.filter((x) => x !== q);
    }
    return { ok: true, text, paid: net, t: want };
  }

  // ------------------------------------------------------------------------------------------ trading (§6.8, §6.9, §9.1)
  /** Free tonnes for `good` on this ship: hold mass, the good's unit, reefer plugs, liquid segregations. */
  fitTonnes(p, good) {
    const cls = p.ship?.cls, C = SHIP_CLASSES[cls] || SHIP_CLASSES.coaster, cat = CARGO[good];
    let t = C.capacity - cargoMass(p.cargo || []);
    const opt = loadOption(good, cls); if (!opt || !cat) return { t: 0, why: null };
    if (cat.unit !== 't') t = Math.min(t, freeUnits(p, cat.unit) * cat.tPer);
    if (opt.plugs) t = Math.min(t, freeUnits(p, 'plugs') * 14);
    if (opt.h.startsWith('liquid:') || opt.h.startsWith('gas:')) {
      const seg = unitsOf(cls).segregations || 1;
      const liquids = new Set((p.cargo || []).filter((c) => { const o = loadOption(c.good, cls); return o && (o.h.startsWith('liquid:') || o.h.startsWith('gas:')); }).map((c) => c.good));
      if (!liquids.has(good) && liquids.size >= seg) return { t: 0, why: `All ${seg} tank segregation${seg > 1 ? 's are' : ' is'} in use — one liquid per segregation.` };
    }
    return { t: Math.max(0, Math.floor(t * 1000) / 1000), why: null };
  }
  /** Buy or sell at the docked harbour (the Game's tradeGoods with the econ rules). */
  trade(p, good, qty, buying) {
    const g0 = this.game;
    if (!p.docked) return;
    const h = harborById(p.docked), st = g0.harbors[p.docked], cat = catalogueOf(good);
    if (!h || !st || !cat || !(qty > 0)) return;
    qty = Math.min(5000, Math.round(qty * 1000) / 1000);
    this.refresh(h, st);
    if (this.marketClosed(st)) return g0.event(p, 'warn', `${shortName(h)}: ${st.ev.text}.`);
    const k = this.row(h.id, good), role = k < 0 ? null : ROLE[this.role[k]], name = GOODS[good]?.name || cat.name;   // legacy goods keep their names
    if (buying) {
      const fit = canLoad(good, p.ship.cls);
      if (!fit.ok) return g0.event(p, 'warn', `${name}: ${fit.why.text}.`);
      if (!role) return g0.event(p, 'warn', `${shortName(h)} does not trade ${name.toLowerCase()}. ${this.madeInText(good)}`);
      const can = buyable(role, Number(st.stock[good]) || 0, this.n(k));
      if (!(can >= 1)) {
        if (role === 'I') return g0.event(p, 'warn', `${shortName(h)} does not sell ${name.toLowerCase()} — it imports it. ${this.madeInText(good)} (Market → map)`);
        return g0.event(p, 'warn', `${name}: sold out here for now.`);
      }
      const room = this.fitTonnes(p, good);
      if (room.why) return g0.event(p, 'warn', `${name}: ${room.why}`);
      qty = affordableQty(h, st, good, Math.min(qty, room.t, can), p.money);
      if (!(qty > 0)) return g0.event(p, 'warn', 'No space or no money.');
      const pc = g0.politics?.onTrade(p, h, good, 'buy');
      if (pc?.block) return;
      const q = tradeQuote(h, st, good, qty, 'buy');
      p.money -= q.total;
      const origin = g0.politics ? g0.politics.stackOrigin(p, h) : null;
      const stack = p.cargo.find((c) => c.good === good && !c.jobId && (c.origin ?? null) === origin && c.src === h.id && !c.caught);
      if (stack) { stack.qty = r3(stack.qty + qty); syncUnits(stack); }
      else { const c = { good, qty, contraband: false, jobId: null, origin, src: h.id, srcRole: role, ...(loadOption(good, p.ship.cls)?.plugs ? { plugs: 0 } : {}) }; syncUnits(c); p.cargo.push(c); }
      st.stock[good] = r3(Math.max(0, (Number(st.stock[good]) || 0) - qty));
      this.refresh(h, st);
      const d = st.market[good] - q.unit;
      g0.event(p, 'info', `Bought ${fmt(qty)} t of ${name} at ${fmt(q.unit)} cr/t average${d > 0 ? ` (price now ${fmt(st.market[good])})` : ''}.`);
    } else {
      const stacks = p.cargo.filter((c) => c.good === good && !c.jobId);
      const have = stacks.reduce((s, c) => s + c.qty, 0);
      qty = Math.min(qty, have);
      if (!(qty > 0)) return g0.event(p, 'warn', 'Nothing to sell (contract cargo cannot be sold).');
      let unitPx, total, dump = false;
      if (!role) {
        const key = `${h.id}:${good}`, day = Math.floor(g0.simTime / 86400), u = this.dumpUse.get(key);
        const used = u && u.day === day ? u.t : 0, capLeft = Math.max(0, ECON2.DUMP_CAP_T - used);
        if (!(capLeft > 0)) return g0.event(p, 'warn', `${shortName(h)}'s general traders have bought their ${ECON2.DUMP_CAP_T} t of ${name.toLowerCase()} for today.`);
        qty = Math.min(qty, capLeft); dump = true;
        unitPx = dumpPrice(cat.base); total = Math.round(unitPx * qty);
        this.dumpUse.set(key, { day, t: used + qty });
      } else { const q = tradeQuote(h, st, good, qty, 'sell'); unitPx = q.unit; total = q.total; }
      let left = qty, duty = 0, fees = 0;
      const take = [], lines = [];
      for (const c of stacks) {
        const k2 = Math.min(c.qty, left); if (k2 <= 0) break;
        if (g0.politics) {
          const r = g0.politics.onTrade(p, h, good, 'sell', { origin: c.origin ?? null, value: Math.round(total * k2 / qty) });
          if (r.block) { if (dump) { const u = this.dumpUse.get(`${h.id}:${good}`); u.t -= qty; } return; }
          if (r.duty) { duty += r.duty.duty || 0; fees += r.duty.fee || 0; if (r.duty.duty || r.duty.fee) lines.push(`${c.origin || 'origin unknown'} ${(r.duty.rate * 100).toFixed(1)} % ${r.duty.via === 'mfn' ? 'WTO MFN' : r.duty.via}`); }
        }
        take.push([c, k2]); left -= k2;
      }
      for (const [c, k2] of take) { c.qty = r3(c.qty - k2); syncUnits(c); }
      p.cargo = p.cargo.filter((c) => c.qty > 1e-6);
      const net = total - duty - fees;
      p.money += net; if (p.stats) p.stats.earned += net;
      const tail = duty + fees ? ` — duty ${fmt(duty)} cr, fee ${fmt(fees)} cr (${lines.join('; ')})` : '';
      if (dump) g0.event(p, 'info', `Sold ${fmt(qty)} t of ${name} to general traders at ${fmt(unitPx)} cr/t (not traded here — 45 % of the world base)${tail}.`);
      else {
        st.stock[good] = r3((Number(st.stock[good]) || 0) + qty);
        this.refresh(h, st);
        const d = unitPx - st.market[good];
        g0.event(p, 'info', `Sold ${fmt(qty)} t of ${name} at ${fmt(unitPx)} cr/t average${d > 0 ? ` (price now ${fmt(st.market[good])})` : ''}${tail}.`);
      }
    }
    g0.sendYou(p); g0.sendHarbor(p);
  }
  /** "Coffee is made in Brazil, Vietnam, Colombia…" */
  madeInText(good) {
    const names = [...new Set(this.makersOf(good).map((h) => this.eds.countries[h.country]?.name || h.country))];
    const name = GOODS[good]?.name || catalogueOf(good)?.name || good;
    return names.length ? `${name} is made in ${names.slice(0, 4).join(', ')}${names.length > 4 ? '…' : '.'}` : `Nobody makes ${name.toLowerCase()} for export right now.`;
  }
  /** Inland harbour trade against the parent's pool (+6 % spread, 200 t per player per inland harbour per 24 h, §9.6). */
  inlandTrade(p, mh, good, qty, buying, spread = 0.06) {
    const g0 = this.game, parent = harborById(mh?.parent), st = parent && g0.harbors[parent.id];
    if (!parent || !st) return { ok: false, text: 'This harbour has no market.' };
    const k = this.row(parent.id, good), cat = catalogueOf(good);
    const inPool = k >= 0 && (mh.tier === 'fishing' ? good === 'fish' : this.role[k] !== 1 && ['grains', 'reefer', 'box', 'energy'].includes(cat?.cat));
    if (!inPool) return { ok: false, text: `${cat?.name || good} is not traded here.` };
    if (this.marketClosed(st)) return { ok: false, text: st.ev.text };
    const key = `${p.id}:${mh.id}`, day = Math.floor(g0.simTime / 86400), u = this.inlandUse.get(key), used = u && u.day === day ? u.t : 0;
    const left = ECON2.INLAND_CAP_T - used;
    if (!(left > 0)) return { ok: false, text: `Small harbour: ${ECON2.INLAND_CAP_T} t a day per skipper — come back tomorrow.` };
    let q = Math.min(Math.max(0, Number(qty) || 0), left);
    if (buying) {
      const fit = canLoad(good, p.ship.cls); if (!fit.ok) return { ok: false, text: fit.why.text };
      q = Math.min(q, buyable(ROLE[this.role[k]], Number(st.stock[good]) || 0, this.n(k)), this.fitTonnes(p, good).t);
      const unit = Math.round(tradeQuote(parent, st, good, q, 'buy').unit * (1 + spread));
      q = Math.min(q, Math.floor(p.money / Math.max(1, unit)));
      if (!(q > 0)) return { ok: false, text: 'No space, no stock or no money.' };
      p.money -= Math.round(unit * q);
      const c = { good, qty: q, contraband: false, jobId: null, origin: parent.country, src: parent.id, srcRole: ROLE[this.role[k]] }; syncUnits(c); p.cargo.push(c);
      st.stock[good] = r3(Math.max(0, st.stock[good] - q));
      this.inlandUse.set(key, { day, t: used + q }); this.refresh(parent, st);
      return { ok: true, text: `Bought ${fmt(q)} t at ${fmt(unit)} cr/t.`, t: q, unit };
    }
    const have = (p.cargo || []).filter((c) => c.good === good && !c.jobId).reduce((s, c) => s + c.qty, 0);
    q = Math.min(q, have); if (!(q > 0)) return { ok: false, text: 'Nothing to sell.' };
    const unit = Math.max(1, Math.round(tradeQuote(parent, st, good, q, 'sell').unit * (1 - spread)));
    let rest = q; for (const c of p.cargo) { if (c.good !== good || c.jobId || rest <= 0) continue; const d = Math.min(c.qty, rest); c.qty = r3(c.qty - d); syncUnits(c); rest -= d; }
    p.cargo = p.cargo.filter((c) => c.qty > 1e-6);
    p.money += Math.round(unit * q); st.stock[good] = r3((Number(st.stock[good]) || 0) + q);
    this.inlandUse.set(key, { day, t: used + q }); this.refresh(parent, st);
    return { ok: true, text: `Sold ${fmt(q)} t at ${fmt(unit)} cr/t.`, t: q, unit };
  }

  // ------------------------------------------------------------------------------------------ views (§15)
  why(i, k, st, now = this.game?.simTime ?? Date.now() / 1000) {
    const g = this.gOf(k), ev = st?.ev;
    if (ev && (ev.kind !== 'boom' && ev.kind !== 'bust' || ev.good === g)) return { code: ev.kind, text: ev.kind === 'strike' ? 'Dock strike' : ev.kind === 'storm' ? 'Storm' : ev.kind === 'closed' ? 'Port closed' : ev.kind === 'restricted' ? 'Port restricted' : ev.kind === 'boom' ? 'Bumper output' : 'Output down' };
    if (this.sanc[k]) return { code: 'sanction', text: 'Imports restricted' };
    const sw = seasonWhy(this.eds, this.harbors[i], g, now);
    if (sw && Math.abs(sw.f - 1) >= 0.25) return { code: sw.why, text: SEASON_WORDS[sw.why] || sw.why };
    const r = (Number(st?.stock?.[g]) || 0) / Math.max(1, this.n(k));
    if (r < 0.6) return { code: 'short', text: 'Short' };
    if (r > 1.6) return { code: 'glut', text: 'Glut' };
    if ((st?.req || []).some((q) => q.good === g && !q.closed)) return { code: 'request', text: 'Request open' };
    return null;
  }
  /** GET /api/market/harbor/:id and the harbour sheet's `econ` block. */
  harborView(hId, viewer = null) {
    const i = this.hIdx.get(hId), h = this.harbors[i], st = this.game?.harbors?.[hId];
    if (i == null || !st) return null;
    this.refresh(h, st);
    const now = this.game.simTime, prof = profileOf(this.eds, h.country), goods = [], make = [], need = [];
    const closed = this.marketClosed(st);
    for (let k = this.off[i]; k < this.off[i + 1]; k++) {
      const g = this.gOf(k), role = ROLE[this.role[k]], s = Number(st.stock[g]) || 0, n = this.n(k), sEq = this.sEqOf(k, st);
      const hist = this.history?.series?.(k, 7, 4) || null;   // 7 days every 4 h: 42 points for the sparkline
      goods.push({
        id: g, role, tier: role === 'P' ? (prof.make[g] ?? rolesOf(this.eds, h).get(g)?.tier ?? null) : role === 'I' ? (prof.need[g] ?? null) : null,
        buy: tradeQuote(h, st, g, 1, 'buy').unit, sell: tradeQuote(h, st, g, 1, 'sell').unit, price: st.market[g],
        buyable: closed ? 0 : buyable(role, s, n), stock: Math.round(s), n: Math.round(n), sEq: sEq == null ? null : Math.round(sEq),
        trend: trendOf(s, sEq ?? n), d24: this.history?.d24?.(k) ?? null, why: this.why(i, k, st, now), hist7: hist,
        ...(this.role[k] === 3 ? { maker: this.nearestMaker(hId, g), land: Math.round(this.D[k * F + FLAND] * 1000) / 1000 } : {}),
        ...(this.sanc[k] ? { sanction: true } : {}),
      });
      if (role === 'P') make.push({ good: g, tier: rolesOf(this.eds, h).get(g)?.tier ?? 3 });
      if (role === 'I') need.push({ good: g, tier: prof.need[g] ?? 2, site: rolesOf(this.eds, h).get(g)?.site || null });
    }
    make.sort((a, b) => a.tier - b.tier); need.sort((a, b) => a.tier - b.tier);
    const reqs = (st.req || []).filter((q) => !q.closed).map((q) => this.publicReq(h, q, now, viewer)).sort((a, b) => b.premium - a.premium);
    const row = this.eds.countries[h.country] || {};
    return {
      id: h.id, name: h.name, country: h.country, countryName: row.name || h.country, size: h.size, simTime: Math.round(now), ev: st.ev || null, closed,
      make, need, requests: reqs, goods, sites: this.sites[i].map((s) => ({ id: s.id, chain: s.chain, name: s.name, k: Math.round((s.k ?? 1) * 100) / 100 })),
      dump: { frac: ECON2.DUMP_FRAC, capT: ECON2.DUMP_CAP_T },
      about: { src: row.src || [], basis: row.basis || 'game', verify: !!row.verify, asOf: row.asOf || null },
    };
  }
  /** A named harbour's row for the inland harbour card (§9.6): { id, goods: { g: { buy, sell, stock, target, role, cat } } }. */
  marketRow(hId) {
    const i = this.hIdx.get(hId), h = this.harbors[i], st = this.game?.harbors?.[hId];
    if (i == null || !st) return null;
    this.refresh(h, st);
    const goods = {};
    for (const [g, k] of this.rowMap[i]) goods[g] = { buy: tradeQuote(h, st, g, 1, 'buy').unit, sell: tradeQuote(h, st, g, 1, 'sell').unit, stock: Math.round(st.stock[g]), target: Math.round(this.n(k)), role: ROLE[this.role[k]], cat: this.eds.byGood.get(g).cat };
    return { id: hId, name: h.name, country: h.country, goods };
  }
  /** GET /api/market/good/:good — rows [[hId, role, buy, sell, stock, n, trend, d24, reqId?]]. */
  goodView(g) {
    const gi = this.gIdx.get(g); if (gi == null) return null;
    const rows = [];
    for (let i = 0; i < this.harbors.length; i++) {
      const k = this.rowMap[i].get(g); if (k == null) continue;
      const h = this.harbors[i], st = this.game?.harbors?.[h.id]; if (!st?.stock) continue;
      const s = Number(st.stock[g]) || 0, q = (st.req || []).find((x) => x.good === g && !x.closed);
      rows.push([h.id, ROLE[this.role[k]], tradeQuote(h, st, g, 1, 'buy').unit, tradeQuote(h, st, g, 1, 'sell').unit, Math.round(s), Math.round(this.n(k)), trendOf(s, this.sEqOf(k, st) ?? this.n(k)), this.history?.d24?.(k) ?? null, q ? q.id : null]);
    }
    return { good: g, simTime: Math.round(this.game?.simTime ?? 0), rows };
  }
  /** The 5 biggest 24 h movers worldwide ("What moved today"). */
  movers(limit = 5) {
    const out = [], hs = this.game?.harbors || {};
    if (!this.history?.d24) return out;
    for (let k = 0; k < this.K; k++) {
      const d = this.history.d24(k); if (d == null) continue;
      const i = this.hOfRow(k), st = hs[this.harbors[i].id];
      out.push({ harbor: this.harbors[i].id, name: shortName(this.harbors[i]), good: this.gOf(k), d24: d, price: st?.market?.[this.gOf(k)] ?? null, why: this.why(i, k, st) });
    }
    out.sort((a, b) => Math.abs(b.d24) - Math.abs(a.d24));
    return out.slice(0, limit);
  }
  /** Prices of every row (history sampling), NaN where the harbour has no state. */
  pricesNow(into) {
    const hs = this.game?.harbors || {};
    for (let i = 0; i < this.harbors.length; i++) {
      const st = hs[this.harbors[i].id];
      for (let k = this.off[i]; k < this.off[i + 1]; k++) into[k] = st?.market?.[this.gOf(k)] ?? NaN;
    }
    return into;
  }
  baseOfRow(k) { return this.eds.byGood.get(this.gOf(k)).base; }

  // ------------------------------------------------------------------------------------------ save / migration (§12)
  /** saveState: stocks as integers (the in-memory floats keep sub-tonne flows moving). */
  harborsForSave(harbors) {
    const out = {};
    for (const [id, st] of Object.entries(harbors || {})) {
      if (!st || !st.stock) { out[id] = st; continue; }
      const stock = {}; for (const [g, v] of Object.entries(st.stock)) stock[g] = Math.round(v);
      out[id] = { ...st, stock };
    }
    return out;
  }
  saveMeta() { return { econSchema: ECON_SCHEMA, econVersion: this.eds.v }; }
  /** After loadState: migrate old saves (keep scarcity ratios), then run the markets over the downtime (≤ 48 h). */
  afterLoad(s, hours) {
    const schema = s?.econSchema, ver = s?.econVersion;
    for (const h of this.harbors) {
      const st = this.game.harbors?.[h.id]; if (!st) continue;
      try { this.migrateHarbor(h, st, schema, ver); }
      catch (e) { Object.assign(st, this.initStock(h)); st.req = []; st.ev = null; st.market = {}; this.refresh(h, st); this.log(`[econ] ${h.id}: state unreadable, re-initialised at equilibrium (${e.message})`); }
    }
    if (hours > 0) this.step(hours); else this.settle();
  }
  migrateHarbor(h, st, schema, ver) {
    const i = this.hIdx.get(h.id), init = this.initStock(h);
    const oldS = st.stock && typeof st.stock === 'object' ? st.stock : {}, oldT = st.target && typeof st.target === 'object' ? st.target : {};
    const stock = {}, target = {};
    const v2 = schema === ECON_SCHEMA, same = v2 && ver === this.eds.v;
    for (const [g, k] of this.rowMap[i]) {
      const n = Math.round(this.n(k)), s0 = Number(oldS[g]), t0 = Number(oldT[g]);
      target[g] = n;
      if (same && Number.isFinite(s0) && s0 >= 0) stock[g] = s0;
      else if ((!v2 ? catalogueOf(g)?.legacy : true) && Number.isFinite(s0) && s0 >= 0 && t0 > 0) stock[g] = migrateStock(s0, t0, n);
      else stock[g] = init.stock[g];
    }
    st.stock = stock; st.target = target;
    if (!v2) { st.req = []; st.ev = null; }
    else {
      st.req = (Array.isArray(st.req) ? st.req : []).filter((q) => q && typeof q === 'object' && this.rowMap[i].has(q.good) && Number.isFinite(q.qty) && Number.isFinite(q.dueAt));
      for (const q of st.req) { if (!Array.isArray(q.pledges)) q.pledges = []; if (!q.by || typeof q.by !== 'object') q.by = {}; if (!Number.isFinite(q.done)) q.done = 0; }
      if (st.ev && (typeof st.ev !== 'object' || !st.ev.kind)) st.ev = null;
    }
    if (!st.market || typeof st.market !== 'object') st.market = {};
    this.refresh(h, st);
  }
}

/** Keep a stack's `unit`/`units` in step with its tonnes (freeUnits counts TEU, CEU … by `units`). */
export function syncUnits(c) {
  const g = CARGO[c.good]; if (!g) return c;
  if (c.plugs != null) c.plugs = Math.ceil(c.qty / 14 - 1e-9);   // reefer goods carried in boxes: one plug per 14 t
  if (g.unit === 't') return c;
  c.unit = g.unit; c.units = Math.round(fromTonnes(c.good, c.qty) * 1000) / 1000;
  return c;
}
